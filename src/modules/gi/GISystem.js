// GISystem — engine runtime for the Radiance Cascades GI module.
//
// VOXEL-FREE ARCHITECTURE: per-mesh SDFs are the sole authored scene
// representation. Every GI-relevant mesh gets a local 64³ distance field —
// baked ONCE in a worker (seconds for dense meshes, ms for props) and
// persisted to a `.sdf` sidecar next to its asset, so subsequent loads are
// instant. A GPU composite pass (sdfScene.js) min()s all mesh SDFs into the
// global distance + surface field the cascades trace; moving a mesh only
// updates its slot uniforms and re-runs that one pass. There is no CPU
// voxelizer, no scene-bake worker, and no incremental rebake machinery —
// scene edits cost ~1-2ms of GPU, never a main-thread hitch.
//
// On top of that field, unchanged: per-frame cascade trace/merge (1-frame
// response), bounce feedback (infinite-bounce loop), per-frame analytic
// lights + promoted emissive emitters (uniform slots, zero rebakes), and
// the GICascadeLight material injection.
import * as THREE from "three/webgpu";
import { float, instanceIndex, positionLocal, texture, uniform } from "three/tsl";
import { createRadianceCascades } from "./cascadeTrace.js";
import { createCascadeMerge } from "./cascadeMerge.js";
import { createBounceFeedback, createIrradianceGather, createProbeIrradiance, createRadianceLookup } from "./cascadeGather.js";
import { createGiGBuffer, createGiResolve, createGiTargets, renderGiGBuffer } from "./giScreen.js";
import { resolveMaterialSurface, serializeMeshForBake } from "./voxelizeOnce.js";
import { createSdfBaker, createSdfDebugMaterial, createSdfScene } from "./sdfScene.js";
import { GICascadeLight, MAX_EMITTERS, giRoughnessBucketOf, registerGILight } from "./giLight.js";
import {
  DETAIL_SLOTS,
  MAX_MESH_SDF_SLOTS,
  MeshSdfAtlas,
  atlasCapacityFor,
  decodeMeshSdf,
  encodeMeshSdf,
  geometryContentHash,
  geometryFingerprintOf,
} from "./meshSdfAtlas.js";
import { getDerivedDataPath, resolveAssetUrl, saveAssetBinary } from "../../engine/assetResolver.js";

const FINGERPRINT_INTERVAL_FRAMES = 5;
// Hard floor between scene-sync scans. Editor drags emit change events every
// frame, and each poke used to force a full scan (mesh traverse + material
// resolve + hash) per frame — the "CPU spikes while moving" report. Moving
// needs NO scan at all (transforms are the per-frame uniform path); scans
// only exist for add/remove/material/geometry changes.
const FINGERPRINT_MIN_INTERVAL_MS = 250;
// Frames a resize's outgoing resolve targets stay alive before being destroyed
// (see #retireTargets). Two would do — the third is slack for a frame that is
// dropped or re-encoded.
const RETIRED_TARGET_FRAMES = 3;

/**
 * Exact-SDF shapes for primitive geometries. Boxes/planes/spheres get
 * ANALYTIC slots: no bake, no file, instantly present at launch, exact at
 * any size (a 30m ground plane as a 64³ grid was ~0.5m/cell — its wobble
 * painted contour swirls into every shadow), and SOLID — walls seal at any
 * thinness. This mirrors the reference demo's analytic geometry path.
 */
function analyticShapeOf(geometry, material) {
  const type = geometry?.type;
  const params = geometry?.parameters;
  if (!params) return null;
  // ROOM DETECTION: a primitive whose rendered faces point INWARD (flipped
  // normals, or BackSide material) is a room/enclosure, not a solid prop.
  // Treating it as a SOLID SDF makes its entire interior read distance 0 —
  // every shadow/cascade ray inside is instantly "occluded" and light only
  // survives within the emitter's self-exclusion sphere (the user's "light
  // has a hard radius" bug). Inverted primitives get HOLLOW SHELL distance
  // (|signed|) instead: walls still seal, the interior is open space.
  const hollow = geometryNormalsInverted(geometry) !== (material?.side === THREE.BackSide);
  if (type === "SphereGeometry") {
    const full =
      (params.phiLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3 &&
      (params.thetaLength ?? Math.PI) > Math.PI - 1e-3;
    if (!full) return null;
    const r = params.radius ?? 1;
    return { type: "sphere", hollow, center: [0, 0, 0], half: [r, r, r] };
  }
  if (type !== "BoxGeometry" && type !== "PlaneGeometry") return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) return null;
  return {
    type: "box",
    hollow,
    center: [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2],
    // TRUE local half-extents (a plane's are zero on one axis). The minimum
    // thickness that makes a zero-thickness plane a solid the traces can
    // block against is applied per-frame in WORLD units by the atlas — it
    // used to be a fixed 0.015 baked in here, which the mesh's scale then
    // multiplied: a 1×1 plane scaled 20× became a 0.6m-thick slab whose SDF
    // surface stood 0.3m in front of the wall you can see.
    half: [
      (bb.max.x - bb.min.x) / 2,
      (bb.max.y - bb.min.y) / 2,
      (bb.max.z - bb.min.z) / 2,
    ],
  };
}

/** True when a primitive's vertex normals point toward its own center. */
function geometryNormalsInverted(geometry) {
  const normal = geometry?.attributes?.normal;
  const position = geometry?.attributes?.position;
  if (!normal || !position) return false;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) return false;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  let inward = 0;
  let outward = 0;
  const stride = Math.max(1, Math.floor(position.count / 48));
  for (let i = 0; i < position.count; i += stride) {
    const d =
      (position.getX(i) - cx) * normal.getX(i) +
      (position.getY(i) - cy) * normal.getY(i) +
      (position.getZ(i) - cz) * normal.getZ(i);
    if (d < -1e-6) inward++;
    else if (d > 1e-6) outward++;
  }
  return inward > outward;
}
// SDF bakes sample the surface, not every triangle cell — but a multi-
// million-tri mesh still costs seconds of worker time on first bake.
const MAX_TRIS_PER_MESH = 500_000;
const MAX_AXIS_RES = 128;
const MAX_PROBE_AXIS = 48;
// Analytic lights the per-frame GPU direct pass supports (uniform slots —
// a fixed count keeps light add/remove/move recompile- and rebake-free).
const MAX_GI_LIGHTS = 4;
// Auto-fit quality presets: total voxel budget, total PROBE budget, and a
// per-axis probe cap. The whole point is "enable + pick quality, done" — no
// voxel/probe hand-tuning.
//
// `probes` is a TOTAL, not a per-axis count: spacing = cbrt(volume/probes).
// A per-axis divisor spends the budget as if every volume were a cube, so a
// wide flat room (40×5×40) got the same coarse spacing on its short axis as
// on its long ones and wasted most of its probes on empty vertical space.
// `probeAxis` remains as a hard per-axis cap (dispatch sizes).
const QUALITY_BUDGETS = {
  low: { cells: 300_000, probes: 8_000, probeAxis: 20 },
  medium: { cells: 700_000, probes: 21_952, probeAxis: 28 },
  high: { cells: 1_400_000, probes: 64_000, probeAxis: 40 },
  ultra: { cells: 2_800_000, probes: 110_592, probeAxis: 48 },
};

// PROBE SPACING LADDER. Auto-fit spacing is quantized onto this ladder and
// the volume is then snapped to a multiple of it, so the probe lattice sits
// at FIXED world positions instead of being re-derived from whatever the
// content AABB happens to be this second. Without quantization every edit
// that nudged the fitted bounds — moving a prop, scaling a wall — changed
// the spacing slightly, which moved every probe, which visibly re-shuffled
// the whole indirect-light pattern ("GI changes a lot when I transform
// things"). With it, small edits produce bit-identical bounds and the field
// does not move at all.
// The rungs are deliberately FINE (5cm below a metre, 10cm above): the
// ladder exists to make the spacing stable across edits, not to coarsen it,
// and a sparse ladder throws away up to a third of the probe budget on the
// round-up. Values are exact in binary-ish decimal terms only to the extent
// that floats allow — everything downstream compares with an epsilon.
const PROBE_SPACING_LADDER = [
  0.02, 0.025, 0.03, 0.04,
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85,
  0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5,
];
const quantizeSpacing = (value) =>
  PROBE_SPACING_LADDER.find((step) => value <= step * 1.0001) ??
  PROBE_SPACING_LADDER[PROBE_SPACING_LADDER.length - 1];

export class GISystem {
  constructor(engine) {
    this.engine = engine;
    this.component = null;
    this.state = null; // { volume, cascades, queue, light, gizmos, bounds, ... }
    this._frame = 0;
    this._fingerprint = "";
    this._rebuildQueued = false;
    this._lightsRefreshTicks = 0;
    // Baked mesh SDFs by CONTENT key (asset path or geometry hash) — shared
    // across mesh instances and across rebuilds. Session-lifetime, as is the
    // bake worker (a rebuild must never kill an in-flight bake).
    this._meshSdfCache = new Map(); // contentKey → { pending, sdf }
    this._sdfBaker = createSdfBaker();
    // material → compile-time roughness bucket (see #refreshMirrorBucket).
    this._mirrorBuckets = new WeakMap();
    // Resolve targets replaced by a resize, awaiting a safe disposal frame.
    this._retiredTargets = [];
    this._unsubs = [
      engine.onPreRender(() => this.#tick()),
      engine.on?.("hierarchy-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("component-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("model-loaded", () => this.#queueRebakeCheck()) ?? (() => {}),
    ];
  }

  /** One active component at a time (Environment convention: last wins). */
  attach(component) {
    if (this.component === component) return;
    this.component = component;
    this.requestRebuild();
  }

  detach(component) {
    if (this.component !== component) return;
    this.component = null;
    this.#dispose();
  }

  onComponentProp(component, key) {
    if (this.component !== component) return;
    if (key === "intensity" || key === "bounce" || key === "temporalBlend" || key === "enabled") {
      this.#applyLiveProps();
    } else if (key === "debugProbes") {
      this.#applyDebugVisibility();
    } else if (key === "autoRebake") {
      // read on the fly, nothing to do
    } else {
      // Structural (size/resolution/cascade shape): grids and dispatch sizes
      // are baked into the compute graphs as constants — rebuild. But ONLY
      // on a real value change: editor autosave re-writes props with
      // unchanged values, and a no-op write must not trigger a rebuild.
      const signature = this.#structuralSignature(component);
      if (signature !== this._structuralSig) {
        this._structuralSig = signature;
        this.requestRebuild();
      }
    }
  }

  #structuralSignature(component) {
    const p = component.props;
    return JSON.stringify([
      p.sizeX,
      p.sizeY,
      p.sizeZ,
      p.voxelSize,
      p.probeSpacing,
      p.cascadeCount,
      p.c0DirRes,
      p.reflections,
      p.emissiveShadows,
      p.autoFit,
      p.quality,
      p.hitLighting,
    ]);
  }

  /**
   * World AABB of the GI-relevant meshes, or null when the scene is empty.
   * Dominant FLAT outliers (a 60m ground plane under a 5m room) are trimmed
   * when removing them collapses the fit substantially — otherwise they drag
   * the auto-fit budget into covering mostly-empty air and the whole volume
   * goes low-res. Room walls survive the test: removing one barely shrinks
   * the union, so they stay.
   */
  #sceneAabb(meshes) {
    if (!meshes.length) return null;
    const boxes = [];
    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      if (!box.isEmpty()) boxes.push(box);
    }
    if (!boxes.length) return null;
    const unionOf = (list) => {
      const out = new THREE.Box3();
      for (const box of list) out.union(box);
      return out;
    };
    const volumeOf = (box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      return Math.max(s.x, 1e-3) * Math.max(s.y, 1e-3) * Math.max(s.z, 1e-3);
    };
    let kept = boxes;
    let union = unionOf(kept);
    const fullSpan = new THREE.Vector3();
    union.getSize(fullSpan);
    const maxFullSpan = Math.max(fullSpan.x, fullSpan.y, fullSpan.z);
    // Candidates: near-flat meshes spanning most of the scene on some axis.
    const flatBig = kept.filter((box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      const spans = [s.x, s.y, s.z].sort((a, b) => a - b);
      return spans[0] < Math.max(0.5, spans[2] * 0.08) && spans[2] >= maxFullSpan * 0.5;
    });
    const spanOf = (box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      return Math.max(s.x, s.y, s.z);
    };
    const trimmed = [];
    for (const candidate of flatBig.sort((a, b) => volumeOf(b) - volumeOf(a))) {
      if (kept.length <= 1) break;
      const without = kept.filter((box) => box !== candidate);
      const shrunk = unionOf(without);
      // Trim ONLY a true outlier: the candidate must DWARF the rest of the
      // scene (≥ 2× its span), not merely be flat. Room walls and floors
      // are flat AND scene-sized — trimming them used to collapse the
      // volume down to the props, leaving whole room halves outside the
      // field: no probes there (black ambient) and, worse, receivers past
      // the volume face whose shadow rays bailed instantly → hard-edged
      // unshadowed light pools ("light cutoff").
      if (
        !shrunk.isEmpty() &&
        volumeOf(shrunk) < volumeOf(union) * 0.6 &&
        spanOf(candidate) >= spanOf(shrunk) * 2
      ) {
        kept = without;
        union = shrunk;
        trimmed.push(candidate);
      }
    }
    // A trimmed flat outlier (typically the GROUND PLANE) must not vanish
    // from the volume entirely: the part directly under/around the kept
    // scene still LIGHTS it (receives pools, bounces, occludes). Dropping
    // it left the floor with no probes and no field cells — "no probes
    // know about the floor". Re-add each trimmed box CLIPPED to the kept
    // union's footprint (with modest slack), so the floor slab under the
    // room stays in-volume without the 30m plane blowing the budget.
    if (!union.isEmpty()) {
      for (const candidate of trimmed) {
        const slack = new THREE.Vector3();
        union.getSize(slack).multiplyScalar(0.35);
        const clipRegion = union.clone();
        clipRegion.min.sub(slack);
        clipRegion.max.add(slack);
        const clipped = candidate.clone().intersect(clipRegion);
        if (!clipped.isEmpty()) union.union(clipped);
      }
    }
    return union.isEmpty() ? null : union;
  }

  requestRebuild() {
    this._rebuildQueued = true;
  }

  /**
   * USER-AUTHORED auto-fit bounds: the volume is defined by the component's
   * OWN entity — a mesh entity contributes its world AABB; an empty entity
   * (organizer node) contributes the union of its subtree's mesh AABBs; an
   * empty childless entity falls back to its PARENT's subtree. The result
   * is scaled ×1.05 in #fitBoundsFor so probes sit just behind the walls.
   *
   * Predictable and stable by construction: moving OTHER scene objects can
   * never change the volume. The old scene-wide AABB + flat-outlier-trim
   * heuristics guessed wrong on real scenes AND made every prop drag a
   * potential refit — each refit being a full rebuild with a material
   * recompile wave, i.e. the "editor hangs 20-30s every time I move
   * something" report.
   */
  #autoFitAabb() {
    const object = this.component?.entity?.object3D;
    if (!object) return null;
    // Fresh meshes may not have rendered yet — stale identity matrixWorlds
    // measure rotated walls un-rotated → garbage fit → corrective refit 3s
    // later → a SECOND full compile wave. Update the whole scene once here
    // (covers the entity path AND the whole-scene fallback).
    this.engine.scene?.updateMatrixWorld(true);
    const union = new THREE.Box3();
    const scratch = new THREE.Box3();
    const gather = (root) => {
      // Freshly added meshes may not have rendered yet — a stale identity
      // matrixWorld here produced a garbage first fit (rotated wall planes
      // measured un-rotated), followed 3s later by a corrective refit, i.e.
      // TWO full material-recompile waves at startup instead of one.
      root.updateWorldMatrix(true, true);
      root.traverse((child) => {
        if (!child.isMesh || child.isInstancedMesh || child.userData.__giDebug) return;
        // A mesh folded into an automatic batch is hidden but still renders (as
        // an instance of a scene-root proxy GI deliberately skips), so its own
        // `visible` flag must not exclude it here — see engine/batching.js.
        if (child.visible === false && !child.userData.batchedInto) return;
        if (((child.layers.mask >>> 0) & 0x80000000) !== 0) return; // editor-only helpers
        if (!child.geometry?.attributes?.position) return;
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox.isEmpty()) return;
        scratch.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
        union.union(scratch);
      });
    };
    gather(object);
    this._boundsSource = `entity "${this.component.entity.name ?? "?"}"`;
    if (union.isEmpty() && object.parent) {
      // Empty childless entity → parent subtree. When the parent IS the
      // scene root, a plain union swallows scene-sized ground planes and
      // the whole quality budget goes to empty air (0.5m cells → blocky
      // shadows, probe-lattice checkerboards, leaks through sub-cell
      // walls). Use the trim heuristic for that case — a component parked
      // on a bare root entity should behave like the old scene fit, not
      // worse.
      if (object.parent === this.engine.scene || !object.parent.parent) {
        this._boundsSource = "whole scene (component on a bare root entity — attach it to the room for exact bounds)";
        return this.#sceneAabb(this.#collectMeshes());
      }
      gather(object.parent);
      this._boundsSource = `parent of "${this.component.entity.name ?? "?"}"`;
    }
    return union.isEmpty() ? null : union;
  }

  /**
   * The auto-fit volume for a scene AABB — the SINGLE source of truth used
   * by both #rebuild and the refit check (comparing anything other than
   * "what a rebuild would actually produce" invites refit oscillation).
   *
   * The result is LATTICE-SNAPPED: the probe spacing is quantized onto
   * PROBE_SPACING_LADDER and both faces of the box land on multiples of it.
   * The volume therefore changes only in whole probe cells, and probes keep
   * fixed world positions while the scene is edited.
   *
   * The ×1.05 content pad plus ONE PROBE LAYER of margin per face is load
   * bearing: a bare 1.05 (2.5% per side) is thinner than a probe spacing on
   * any normal room, so surfaces facing OUT of the volume (wall backs, the
   * ceiling TOP) had no probes on their side of the geometry — the gather
   * then interpolated room-interior probes through the thin shell, and the
   * trilinear tent × backface-rejection weights painted a dark-diamond
   * checkerboard across the outside faces. A real (dark) probe layer out
   * there makes outside surfaces honestly, uniformly dark instead.
   */
  #fitBoundsFor(aabb) {
    const center = new THREE.Vector3();
    aabb.getCenter(center);
    const span = new THREE.Vector3();
    aabb.getSize(span);
    const budget = QUALITY_BUDGETS[this.component?.props.quality] ?? QUALITY_BUDGETS.high;
    // Spacing and margin depend on each other, so solve it: pick a spacing
    // from the content, snap the box onto that lattice, and step the spacing
    // up a rung if the snapped box would exceed the per-axis cap.
    const contentX = Math.max(4, span.x * 1.05);
    const contentY = Math.max(2, span.y * 1.05);
    const contentZ = Math.max(4, span.z * 1.05);
    let spacing = quantizeSpacing(
      Math.max(
        0.05,
        Math.cbrt((contentX * contentY * contentZ) / budget.probes),
        Math.max(contentX, contentY, contentZ) / budget.probeAxis,
      ),
    );
    // Grow the box by ONE probe spacing per face, then snap BOTH faces
    // outward to the global lattice (multiples of `spacing` in world space).
    // Snapping is what makes the fit stable: the box only ever changes in
    // whole probe cells, and probes keep the same world coordinates across
    // edits. It also contributes up to another full spacing of margin, so
    // the effective margin is 1-2 spacings — the outside-facing probe layer
    // the old fixed 1.5 was there to guarantee is still guaranteed, without
    // spending an extra 0.5 spacing of volume (and hence of density) on it.
    const laid = (step) => {
      const margin = step;
      const min = new THREE.Vector3(
        Math.floor((center.x - contentX / 2 - margin) / step) * step,
        Math.floor((center.y - contentY / 2 - margin) / step) * step,
        Math.floor((center.z - contentZ / 2 - margin) / step) * step,
      );
      const max = new THREE.Vector3(
        Math.ceil((center.x + contentX / 2 + margin) / step) * step,
        Math.ceil((center.y + contentY / 2 + margin) / step) * step,
        Math.ceil((center.z + contentZ / 2 + margin) / step) * step,
      );
      return { min, max, counts: max.clone().sub(min).divideScalar(step).round() };
    };
    let box = laid(spacing);
    for (let guard = 0; guard < PROBE_SPACING_LADDER.length; guard++) {
      const worst = Math.max(box.counts.x, box.counts.y, box.counts.z);
      if (worst <= budget.probeAxis && worst <= MAX_PROBE_AXIS) break;
      const next = PROBE_SPACING_LADDER.find((step) => step > spacing * 1.0001);
      if (!next) break;
      spacing = next;
      box = laid(spacing);
    }
    const fitCenter = box.min.clone().add(box.max).multiplyScalar(0.5);
    return {
      center: fitCenter,
      sizeX: box.max.x - box.min.x,
      sizeY: box.max.y - box.min.y,
      sizeZ: box.max.z - box.min.z,
      min: box.min,
      max: box.max,
      probeSpacing: spacing,
      probeCounts: box.counts,
    };
  }

  dispose() {
    for (const unsub of this._unsubs) unsub?.();
    this._unsubs = [];
    this.#dispose();
    this._sdfBaker?.dispose();
    this.component = null;
  }

  // -------------------------------------------------------------------------

  #tick() {
    const component = this.component;
    if (!component || !component.enabled) return;
    const renderer = this.engine.renderer;
    if (!renderer) return;
    registerGILight(renderer);
    // Runs before every early-out below: a retired target must be freed even
    // while a compile wave holds the rest of this tick.
    this.#drainRetiredTargets();

    // While a compile wave runs, do NOTHING here: dispatching computes
    // would sync-compile pipelines inside this frame, and processing a
    // queued rebuild would swap state under the running wave and stack a
    // second wave on top (the repeated viewport-freeze episodes report).
    // _rebuildQueued persists — the rebuild runs when the wave ends.
    if (this.engine.renderSuspended) return;
    if (this._rebuildQueued && this.#readyToRebuild()) {
      this._rebuildQueued = false;
      this.#rebuild();
    }
    const state = this.state;
    if (!state) return;

    // Belt-and-braces for the lights-hash memo bug (#purgeLightsHashMemo):
    // purge once more a few frames after every build, when async pipeline
    // compiles have settled. A purge is nearly free (one small map) and,
    // unlike the old light-instance swap, does NOT force a second full
    // material-recompile wave — that swap was half of the user's
    // multi-second freezes on rebuilds.
    if (this._lightsRefreshTicks > 0 && state.light) {
      this._lightsRefreshTicks--;
      if (this._lightsRefreshTicks === 0) this.#purgeLightsHashMemo();
    }

    // Analytic lights AND promoted emissive emitters are per-frame uniforms
    // — moving either re-lights the field this same frame, no bake involved.
    this.#updateLightUniforms();
    this.#refreshEmitterSlots();
    // Slot transforms track live matrices — dragging a mesh updates its
    // uniforms here, which bumps the atlas revision and re-runs the
    // composite below. That IS the whole cost of moving scene geometry.
    state.atlas.refreshTransforms();
    // The deferred resolve reads THIS frame's gbuffer, so the prepass renders
    // before any compute is dispatched. It is a nested render (one override
    // material, editor layers excluded) that restores renderer state.
    if (state.screen) {
      this.#syncScreenResolveSize(state);
      renderGiGBuffer(renderer, this.engine.scene, this.engine.camera, state.screen.gbuffer);
    }
    // Feedback runs every frame at high/ultra, every other frame below —
    // it's a converging quantity and the priciest per-frame compute.
    const runFeedback = state.feedbackEveryFrame || this._frame % 2 === 0;
    let frameQueue = runFeedback ? state.queue : state.queueNoFeedback;
    // Probe-average computes exist for the gizmos alone — only pay for
    // them while a probe debug view is actually open.
    const debugMode = component.props.debugProbes;
    if (debugMode === "raw" || debugMode === "merged") {
      frameQueue = [...frameQueue, ...state.debugComputes];
    }
    if (this._atlasRevisionSeen !== state.atlas.revision) {
      this._atlasRevisionSeen = state.atlas.revision;
      // A fresh composite always runs the FULL queue (feedback included) —
      // the field just changed and must re-converge without a frame of lag.
      renderer.compute([
        state.volume.compositeCompute,
        ...state.queue,
        ...(frameQueue === state.queue || frameQueue === state.queueNoFeedback ? [] : state.debugComputes),
      ]);
      this.#maybeLogStats(renderer);
    } else {
      // Cascades re-trace + re-merge EVERY frame — 1-frame response to any
      // field change, no temporal accumulation to converge.
      renderer.compute(frameQueue);
    }

    this._frame++;
    // NOT gated by autoRebake anymore: there are no bakes to re-run — this
    // scan is what brings LATE-LOADING meshes (GLB models finish after the
    // first build) into the field at all. Gating it made a freshly opened
    // scene render with almost no GI until a settings change forced a
    // rebuild.
    if (this._frame % FINGERPRINT_INTERVAL_FRAMES === 0) {
      this.#checkFingerprint();
    }
  }

  /**
   * Holds a queued rebuild while GLB models are still streaming in. Building
   * before a model lands measures wrong auto-fit bounds, and the corrective
   * refit a few seconds later fires a SECOND full material-compile wave —
   * the user's ~40s startups were two back-to-back 20s waves. Waiting a few
   * frames for the loads costs nothing (there is no GI to lose yet) and
   * collapses startup to ONE wave. A timeout keeps a broken model file from
   * deferring GI forever.
   */
  #readyToRebuild() {
    let pending = false;
    for (const entity of this.engine.entities.values()) {
      const model = entity.getComponent?.("model");
      if (model?.props?.path && !model.root) {
        pending = true;
        break;
      }
    }
    if (!pending) {
      this._modelWaitStart = null;
      return true;
    }
    const now = performance.now();
    if (!this._modelWaitStart) {
      this._modelWaitStart = now;
      console.log("[gi] build deferred — waiting for model loads (avoids a double compile wave)");
    }
    if (now - this._modelWaitStart < 15000) return false;
    console.warn("[gi] building despite unfinished model loads (15s timeout) — a refit may follow");
    this._modelWaitStart = null;
    return true;
  }

  /**
   * ROOT CAUSE of the "GI light silently inert" class of bugs (harness-
   * proven): three's `Nodes.getCacheKey(scene, lightsNode)` memoizes the
   * lights hash per [scene, lightsNode] and only recomputes when
   * `renderer.info.calls` DIFFERS from the memoized call id — but
   * `info.calls` resets every frame and lands on the SAME value at the same
   * point of a static frame, so the memo never invalidates. Materials that
   * compiled before the GI light existed then never see the lights-hash
   * change, `needsUpdate` stays false, and the light contributes nothing —
   * on some scenes forever (whether it worked depended on draw-call-count
   * coincidences). Dropping the memo forces a fresh hash next frame, which
   * flags every stale pipeline for a rebuild against the current lights.
   */
  #purgeLightsHashMemo() {
    const nodes = this.engine.renderer?._nodes;
    if (nodes?.callHashCache?.constructor) {
      nodes.callHashCache = new nodes.callHashCache.constructor();
    }
  }

  /**
   * Non-blocking material compile wave after a (re)build: the scene render
   * is suspended (viewport holds its last frame, app stays interactive)
   * while `renderer.compileAsync` builds node graphs with main-thread
   * yields and creates pipelines via `createRenderPipelineAsync` (driver
   * threads). Rendering resumes as soon as the cache is warm — the render
   * loop then finds every pipeline ready instead of blocking for the whole
   * wave inside one frame.
   */
  /**
   * If a render override (PostprocessComponent) owns the active camera, its
   * PassNode renders the scene — warm THAT pipeline context (PassNode's own
   * compileAsync binds its render target + MRT around a scene compile).
   * Returns true when an override pass was warmed. Idempotent per pass
   * instance so the wave's start-and-end calls don't compile twice.
   */
  async #warmOverridePass(renderer) {
    const engine = this.engine;
    let override = null;
    for (const o of engine.renderOverrides ?? []) {
      if (o.ownsCamera?.(engine)) {
        override = o;
        break;
      }
    }
    const pass = override?.scenePass;
    if (!pass?.compileAsync) return false;
    if (this._warmedScenePass === pass) return true;
    await pass.compileAsync(renderer);
    this._warmedScenePass = pass;
    return true;
  }

  async #compileWave() {
    const engine = this.engine;
    const renderer = engine.renderer;
    if (!renderer?.compileAsync || !engine.camera || !engine.scene) return;
    const token = (this._compileToken = {});
    const state = this.state;
    // Re-warm from scratch each wave — a wave exists because pipelines were
    // invalidated (new GI light state), so a previously warmed pass is stale.
    this._warmedScenePass = null;
    engine.renderSuspended = true;
    // three's yieldToMain prefers scheduler.yield(), whose continuations
    // OUTRANK rendering in Chrome — the whole wave still starved rAF (a
    // single 12s frame gap, harness-measured). A macrotask yield lets the
    // browser interleave frames/input between compile chunks.
    const scheduler = globalThis.scheduler;
    const originalYield = scheduler?.yield;
    if (originalYield) scheduler.yield = () => new Promise((resolve) => setTimeout(resolve, 0));
    // PIPELINE COMPILES RUN CONCURRENTLY, not one at a time. three's
    // compileAsync walks render objects sequentially and awaits each
    // `createRenderPipelineAsync` before starting the next ("process
    // compilation work items sequentially to avoid freezing") — but that
    // await is idle main-thread time while the DRIVER compiles on its own
    // threads, so N materials cost the SUM of their compile times. With GI
    // injected, each material's fragment shader is 180-250kB of WGSL and
    // takes the driver 3-18s: harness-measured 42.4s summed for a 14-material
    // scene whose worst single pipeline was 18.5s. Intercepting the promise
    // hand-off (three gets an empty array and never awaits; we collect and
    // await them together) overlaps every compile.
    const pipelines = renderer._pipelines;
    const originalGetForRender = pipelines?.getForRender;
    const inflight = [];
    if (originalGetForRender) {
      pipelines.getForRender = function (renderObject, promises) {
        if (promises == null) return originalGetForRender.call(this, renderObject, promises);
        const collected = [];
        const result = originalGetForRender.call(this, renderObject, collected);
        inflight.push(...collected);
        return result;
      };
    }
    const t0 = performance.now();
    try {
      console.log("[gi] compile wave started");
      // Compile against the render path that will actually draw at resume.
      // With a postprocess override active, the scene renders through the
      // override's PassNode target + MRT — a DIFFERENT pipeline-cache
      // context than the default framebuffer, and structurally different
      // shaders (MRT adds attachments to every material). Warming only the
      // default context then left every material to sync-recompile on the
      // first resumed frame — user-confirmed as ~HALF their startup freeze
      // (disabling the Post Processing module halved startup).
      if (!(await this.#warmOverridePass(renderer))) {
        await renderer.compileAsync(engine.scene, engine.camera);
      }
      const tQueued = performance.now();
      // Every pipeline is now in flight on the driver's threads — this is the
      // only wait, and it costs the LONGEST compile, not their sum.
      const queued = inflight.length;
      if (queued > 0) await Promise.all(inflight);
      const t1 = performance.now();
      console.log(
        `[gi] compile wave: materials done in ${(t1 - t0).toFixed(0)}ms ` +
          `(node builds ${(tQueued - t0).toFixed(0)}ms, ${queued} pipelines compiled concurrently in ${(t1 - tQueued).toFixed(0)}ms)`,
      );
      // Compute pipelines have NO async path in three (computeAsync ≡
      // compute) and would otherwise all compile synchronously inside the
      // first resumed frame — a multi-second freeze right after the wave
      // "finished". Prewarm them here, one dispatch per macrotask. The
      // dispatches do a normal frame's field work, so they're not wasted.
      if (state && this.state === state) {
        const computeNodes = [state.volume.compositeCompute, ...state.queue];
        for (const node of computeNodes) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (this.state !== state) break;
          renderer.compute(node);
        }
      }
      // The postprocess pipeline builds asynchronously (addon imports +
      // graph compile) — at scene load it often is NOT ready when this wave
      // starts, so the first check above compiled the default path. If the
      // override came up mid-wave, warm its pass context too before
      // resuming, or resume hits a full sync recompile anyway.
      await this.#warmOverridePass(renderer);
      console.log(
        `[gi] compile wave: materials ${(t1 - t0).toFixed(0)}ms, computes ${(performance.now() - t1).toFixed(0)}ms (render suspended, app interactive)`,
      );
    } catch (error) {
      console.warn("[gi] async compile wave failed (falling back to on-demand compiles):", error?.message ?? error);
    } finally {
      if (originalYield) scheduler.yield = originalYield;
      if (originalGetForRender) pipelines.getForRender = originalGetForRender;
      if (this._compileToken === token) {
        engine.renderSuspended = false;
        // DIAGNOSTIC: if the first REAL frame after the wave still stalls,
        // the wave compiled for the wrong render path (a postprocess
        // override renders through PassNode targets whose cache context
        // differs) — the number tells us instantly.
        const tResume = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const dt = performance.now() - tResume;
            if (dt > 400) {
              console.warn(
                `[gi] first frame after compile wave took ${dt.toFixed(0)}ms — pipelines recompiled at resume (likely the postprocess render path; report this)`,
              );
            }
          }),
        );
      }
    }
  }

  /**
   * Builds the deferred resolve for this GI state: a half-resolution gbuffer
   * plus the compute that turns it into the irradiance / emitter-shadow
   * textures materials sample.
   *
   * The TEXTURE NODES are created once per GISystem and reused across every
   * rebuild — that is the point of the whole design. A material's GI code is
   * "sample these two textures", so it is byte-identical before and after a
   * rebuild, its shader stays in the pipeline cache, and a quality change or
   * an auto-fit refit no longer triggers a material recompile wave.
   */
  #buildScreenResolve({ gather, light, emitterSlots }) {
    const renderer = this.engine.renderer;
    if (!renderer?.backend?.device) return null;
    const { width, height } = this.#screenResolveSize();
    try {
      const gbuffer = createGiGBuffer(width, height);
      if (!this._giTargets) {
        this._giTargets = createGiTargets(width, height);
        this._giTargetSize = { width, height };
        this._giIrradianceNode = texture(this._giTargets.irradiance);
        this._giEmitterShadowNode = texture(this._giTargets.emitterShadow);
      }
      const targets = this._giTargets;
      const emitter = emitterSlots
        ? {
            emitterSlots,
            shadowTraceFn: light.shadowTraceFn,
            shadowMargin: light.shadowMargin,
            shadowRange: light.shadowRange,
          }
        : null;
      const inputs = { gather, normalOffset: light.normalOffset, intensity: light.intensityUniform, emitter };
      const resolve = createGiResolve({ gbuffer, targets, width, height, ...inputs });
      light.giIrradianceNode = this._giIrradianceNode;
      light.giEmitterShadowNode = emitterSlots ? this._giEmitterShadowNode : null;
      return { gbuffer, resolve, targets, width, height, ...inputs };
    } catch (error) {
      // Falling back to the in-material path keeps GI working (slowly) rather
      // than rendering an unlit scene.
      console.warn("[gi] deferred resolve unavailable — falling back to per-material GI:", error?.message ?? error);
      return null;
    }
  }

  /**
   * Keeps the resolve buffers matched to the viewport. A resize swaps the
   * texture objects behind the PERSISTENT texture nodes (a uniform rebind),
   * and rebuilds only the resolve compute — whose WGSL is size-independent
   * (the dimensions are uniforms), so three's node cache and the driver's
   * pipeline cache both hit and no material is touched.
   */
  #syncScreenResolveSize(state) {
    const screen = state.screen;
    const { width, height } = this.#screenResolveSize();
    if (width === screen.width && height === screen.height) return;
    screen.width = width;
    screen.height = height;
    screen.gbuffer.setSize(width, height);
    // New targets at the new size; the persistent nodes are re-pointed at
    // them, which is a binding refresh rather than a shader rebuild (every
    // observed material has hasNode = true, so its bindings refresh per frame
    // — see #markObservedMaterial).
    const previousTargets = screen.targets;
    screen.targets = createGiTargets(width, height);
    this._giTargets = screen.targets;
    this._giTargetSize = { width, height };
    this._giIrradianceNode.value = screen.targets.irradiance;
    this._giEmitterShadowNode.value = screen.targets.emitterShadow;
    const index = state.queue.indexOf(screen.resolve.compute);
    const indexNoFeedback = state.queueNoFeedback.indexOf(screen.resolve.compute);
    screen.resolve = createGiResolve({
      gbuffer: screen.gbuffer,
      targets: screen.targets,
      width,
      height,
      gather: screen.gather,
      normalOffset: screen.normalOffset,
      intensity: screen.intensity,
      emitter: screen.emitter,
    });
    if (index >= 0) state.queue[index] = screen.resolve.compute;
    if (indexNoFeedback >= 0) state.queueNoFeedback[indexNoFeedback] = screen.resolve.compute;
    this.#retireTargets(previousTargets);
  }

  /**
   * Old targets are destroyed a few frames LATE, never on the spot. A material
   * re-points at the new textures when its bind group is next refreshed, which
   * happens while the following frame is encoded — destroy the old pair before
   * that and the submit fails validation ("Destroyed texture used in a submit")
   * and GI blanks out. A few MB held for three frames is the cheap side of that
   * trade.
   */
  #retireTargets(targets) {
    if (targets) this._retiredTargets.push({ targets, ttl: RETIRED_TARGET_FRAMES });
  }

  #drainRetiredTargets() {
    if (this._retiredTargets.length === 0) return;
    const keep = [];
    for (const entry of this._retiredTargets) {
      if (--entry.ttl > 0 || globalThis.__giKeepRetiredTargets) keep.push(entry);
      else entry.targets.dispose();
    }
    this._retiredTargets = keep;
  }

  /** Resolve resolution: half the drawing buffer, clamped to something sane. */
  #screenResolveSize() {
    const renderer = this.engine.renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const scale = this.component?.props.resolveScale ?? 0.5;
    return {
      width: Math.max(16, Math.min(4096, Math.round(size.x * scale))),
      height: Math.max(16, Math.min(4096, Math.round(size.y * scale))),
    };
  }

  /**
   * Tracks each material's COMPILE-TIME roughness bucket (mirror path /
   * directional path / diffuse-only — see giLight's gate constants). A
   * static-roughness edit that crosses a gate needs that one material
   * recompiled, or e.g. a wall dialed down to roughness 0.1 would never
   * show mirror reflections.
   */
  #refreshMirrorBucket(material) {
    if (!material) return;
    const bucket = giRoughnessBucketOf(material);
    const previous = this._mirrorBuckets.get(material);
    if (previous !== undefined && previous !== bucket) material.needsUpdate = true;
    this._mirrorBuckets.set(material, bucket);
  }

  /** One-shot occupancy readback after the field first composites (log + harness signal). */
  #maybeLogStats(renderer) {
    const state = this.state;
    if (!state || state.statsLogged || !state.entries.length) return;
    const resident = state.atlas.assignments.filter(Boolean).length;
    if (resident < Math.min(state.entries.length, state.atlas.capacity)) return;
    state.statsLogged = true;
    state.volume.readbackStats(renderer).then((stats) => {
      if (this.state === state) {
        console.log(`[gi] composited field: occ ${stats.occupiedCells}, emissive ${stats.emissiveCells}`);
      }
    });
  }

  #rebuild() {
    this.#dispose();
    const component = this.component;
    const engine = this.engine;
    if (!component || !engine.scene) return;

    const props = component.props;
    const meshes = this.#collectMeshes();

    // Volume placement: manual (entity-centered, size props) or AUTO-FIT —
    // bounds wrap the GI-relevant scene content with headroom, and voxel/
    // probe densities are derived from fixed budgets so any world size stays
    // performant (bigger world → coarser field, same cost).
    const center = new THREE.Vector3();
    let sizeX = props.sizeX;
    let sizeY = props.sizeY;
    let sizeZ = props.sizeZ;
    const autoFit = props.autoFit === true;
    // Entity-authored bounds first; whole-scene AABB only as a fallback for
    // a component sitting on a bare entity in an unstructured scene.
    const sceneAabb = autoFit ? (this.#autoFitAabb() ?? this.#sceneAabb(meshes)) : null;
    let fit = null;
    if (sceneAabb) {
      fit = this.#fitBoundsFor(sceneAabb);
      center.copy(fit.center);
      sizeX = fit.sizeX;
      sizeY = fit.sizeY;
      sizeZ = fit.sizeZ;
    } else {
      component.entity.object3D.getWorldPosition(center);
    }
    // Lattice-snapped fits carry their exact faces — recomputing them from
    // centre ± size/2 would reintroduce float drift into the snap.
    const half = new THREE.Vector3(sizeX / 2, sizeY / 2, sizeZ / 2);
    const bounds = fit
      ? { min: fit.min.clone(), max: fit.max.clone() }
      : { min: center.clone().sub(half), max: center.clone().add(half) };

    let voxelSize = Math.max(0.05, props.voxelSize || 0.3);
    let probeSpacing = Math.max(0.25, props.probeSpacing || 1.25);
    let c0Grid;
    let res;
    if (autoFit) {
      // ZERO-SETUP MODE: quality preset → budgets; voxel/probe density is
      // fully derived from the fitted volume (the manual size/voxel/probe
      // fields are ignored). Bigger world at the same preset = coarser
      // field, same cost.
      const budget = QUALITY_BUDGETS[props.quality] ?? QUALITY_BUDGETS.high;
      const maxAxis = Math.max(sizeX, sizeY, sizeZ);
      const volumeSize = sizeX * sizeY * sizeZ;
      // The fit already chose (and snapped the bounds to) the probe spacing.
      probeSpacing = fit.probeSpacing;
      c0Grid = {
        x: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.x)),
        y: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.y)),
        z: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.z)),
      };
      // The occupancy grid keeps its own budget-derived cell size. Making it
      // an integer subdivision of the probe spacing was tried and reverted:
      // it bought no stability (a refit recomposites the whole field from
      // the slot SDFs anyway) and the rounding threw away up to a fifth of
      // the voxel budget.
      voxelSize = Math.min(
        1.5,
        Math.max(0.05, maxAxis / MAX_AXIS_RES, Math.cbrt(volumeSize / budget.cells)),
      );
      res = {
        x: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeX / voxelSize))),
        y: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeY / voxelSize))),
        z: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeZ / voxelSize))),
      };
    } else {
      res = {
        x: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeX / voxelSize))),
        y: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeY / voxelSize))),
        z: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeZ / voxelSize))),
      };
      c0Grid = {
        x: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeX / probeSpacing))),
        y: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeY / probeSpacing))),
        z: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeZ / probeSpacing))),
      };
    }

    if (res.x * res.y * res.z > 1_500_000) {
      console.warn(
        `[gi] ${res.x}x${res.y}x${res.z} cells is heavy (ray-march steps scale with 1/voxelSize). ` +
          `For a ${sizeX.toFixed(0)}m volume, voxelSize ~${(sizeX / 100).toFixed(2)} is usually plenty.`,
      );
    }
    const t0 = performance.now();
    // Per-quality trace budgets — the fixed 56/64-step traces at every
    // preset were why "medium" still cost ~20ms GPU at editor resolutions.
    const quality = props.quality ?? "high";
    const traceBudget =
      { low: { shadow: 24, mirror: 32, feedback: 18 },
        medium: { shadow: 32, mirror: 40, feedback: 24 },
        high: { shadow: 44, mirror: 56, feedback: 32 },
        ultra: { shadow: 56, mirror: 64, feedback: 40 } }[quality]
      ?? { shadow: 44, mirror: 56, feedback: 32 };

    // The authored representation: one SDF slot per mesh (capacity in whole
    // 16-slot layers so small mesh-count changes don't rebuild).
    const atlas = new MeshSdfAtlas(atlasCapacityFor(meshes.length));
    // Per-quality refinement budget: every shadow/mirror trace STEP pays
    // for these slots — set BEFORE any trace graph is built.
    atlas.detailBudget = { low: 4, medium: 6, high: 8, ultra: 10 }[props.quality] ?? 8;
    const volume = createSdfScene(bounds, res, atlas);
    // Plane walls are zero-thickness; give them a solid interior sized to
    // THIS field. Too thin and the trilinear distance texture cannot see
    // them at all — sphere-traced mirror rays step through the walls and
    // reflections read black. A quarter cell is resolvable without visibly
    // displacing the surface.
    atlas.minAnalyticHalfWorld = Math.max(0.01, volume.minCell * 0.5);
    // Entries + slot assignment + emitter promotion + SDF load-or-bake.
    const entries = this.#buildEntries(meshes);

    const { cascades, intervals } = createRadianceCascades({
      world: volume.world,
      cascadeCount: Math.min(6, Math.max(2, props.cascadeCount || 5)),
      c0Grid,
      c0DirRes: props.c0DirRes === 2 ? 2 : 4,
      t0: probeSpacing,
      farT: Math.max(sizeX, sizeY, sizeZ) * 2,
      sceneTrace: volume.createSceneTrace(),
    });
    const { mergeComputes, averageComputes } = createCascadeMerge(cascades);
    // Per-probe ambient-cube irradiance, integrated once per frame — the
    // per-pixel/per-cell gather then reads 2 fetches per probe instead of
    // dirCount radiance reads (the dominant per-pixel GPU cost).
    const probeIrradiance = createProbeIrradiance(cascades);
    // This gather instance feeds ONLY the deferred resolve compute (materials
    // read its result from a texture now), so it can be a real WGSL function
    // — see createShadowTrace's note on why that is unsafe for shared ones.
    const gather = createIrradianceGather(cascades, probeIrradiance.buffer, volume.world.cellMax, "giResolveGather");
    // Volume diagonal as a uniform: shadow/mirror reach rescales with an
    // in-place refit (all world-scale shader inputs must be uniforms — a
    // baked one would pin part of the old volume after a refit).
    const diagU = uniform(Math.hypot(sizeX, sizeY, sizeZ));
    // Multi-bounce: field radiance ← base + albedo·E/π every frame. Runs
    // FIRST (reads last frame's merged field) so this frame's trace sees
    // bounced energy — this is what makes emissive-only scenes bleed.
    const bounceGain = uniform(Math.min(1, Math.max(0, props.bounce ?? 1)));
    // Per-frame lerp pulling the base field toward the latest composite —
    // spreads occupancy/lighting swaps over ~10 frames instead of popping.
    const temporalBlend = uniform(Math.min(1, Math.max(0.02, props.temporalBlend ?? 0.25)));
    // Per-frame analytic direct light: fixed uniform slots read by the
    // feedback compute. Light moves/edits update uniforms only.
    const lightSlots = Array.from({ length: MAX_GI_LIGHTS }, () => ({
      active: uniform(0),
      kind: uniform(0),
      vector: uniform(new THREE.Vector3()),
      color: uniform(new THREE.Color(0, 0, 0)),
      // three PointLight `distance` cutoff (0 = infinite) — GI must die
      // where the renderer's own direct light does, or the mismatch reads
      // as light being "cut" at a circle.
      range: uniform(0),
    }));
    // Emitter slots (promoted emissive meshes) are shared by the feedback
    // compute (voxel direct inject), the material light node (receiver
    // direct + shadows + mirror glow), and refreshed EVERY FRAME.
    const emitterSlots =
      props.emissiveShadows !== false
        ? Array.from({ length: MAX_EMITTERS }, () => ({
            center: uniform(new THREE.Vector3()),
            radius: uniform(0),
            color: uniform(new THREE.Color(0, 0, 0)),
          }))
        : null;
    const normalLift = volume.world.minCell.mul(1.2);
    const feedbackCompute = createBounceFeedback(cascades, volume, bounceGain, temporalBlend, {
      lightSlots,
      emitterSlots,
      probeIrradiance: probeIrradiance.buffer,
      // Private to the feedback compute (see createShadowTrace's layout note).
      shadowTrace: volume.createSoftShadowTrace(normalLift, traceBudget.feedback, "giFeedbackShadowTrace"),
      gridDiagonal: diagU,
    });

    const queue = [feedbackCompute];
    for (const cascade of cascades) queue.push(cascade.traceCompute);
    queue.push(...mergeComputes);
    // Integrate probe irradiance AFTER the merge so receivers read
    // this frame's field.
    queue.push(probeIrradiance.compute);
    // At low/medium the feedback (per-occupied-cell gather + shadow traces)
    // runs every OTHER frame — it's a converging quantity, and halving its
    // rate halves the largest per-frame compute at those presets.
    const queueNoFeedback = queue.slice(1);
    const feedbackEveryFrame = quality === "high" || quality === "ultra";
    // Per-probe averages feed ONLY the debug gizmos — appended to the frame
    // queue while a probe debug view is open, skipped otherwise.
    const debugComputes = [...cascades.map((cascade) => cascade.averageCompute), ...averageComputes];

    // LIGHT REUSE — this is what makes rebuilds cheap.
    //
    // Historically a FRESH light instance was created per rebuild on purpose:
    // materials evaluated the gather themselves, so they had to be recompiled
    // against the new cascade buffers, and the lights-hash change is what
    // forced that. With the deferred resolve, a material's GI code is "sample
    // these two persistent textures" — nothing in it depends on the rebuilt
    // buffers — so reusing the light keeps the lights hash stable and NO
    // material is invalidated. A quality change or an auto-fit refit then
    // costs one compute rebuild instead of a full material recompile wave.
    //
    // The exception is materials that DO bake volume-dependent code: the
    // mirror/reflection path traces the SDF field directly. Those are
    // recompiled individually below (#invalidateVolumeBoundMaterials) — a
    // handful of low-roughness materials rather than the whole scene.
    // MEASURED: reusing the light across rebuilds (so materials keep their
    // shaders) looked ideal on paper — the deferred resolve means a
    // material's GI code no longer depends on the rebuilt buffers. But the
    // reflection path still bakes the volume in, and hand-invalidating just
    // those materials made them compile SYNCHRONOUSLY outside the compile
    // wave: 10-13s frozen frames per quality change, versus ~1s when the
    // fresh-light lights-hash change routes every recompile through the
    // wave (which compiles asynchronously and concurrently). Keep the fresh
    // instance until reflections are deferred too — then nothing in a
    // material depends on a rebuild and this can revisit.
    const light = new GICascadeLight();
    light.gatherFn = gather;
    // World-scale light params are uniform-derived NODES (giLight composes
    // them into node math either way) so an in-place refit rescales them.
    light.normalOffset = volume.world.cellMax.mul(1.2).max(0.1);
    if (props.reflections !== false) {
      light.radianceFn = createRadianceLookup(cascades, 2);
      // Finest-angular cascade for low-roughness reflections (spatially
      // coarser, but a mirror's sharpness is set by angular resolution).
      const sharpLevel = Math.min(3, cascades.length - 1);
      light.radianceSharpFn = sharpLevel > 2 ? createRadianceLookup(cascades, sharpLevel) : null;
      // Low-roughness materials get a real per-pixel SDF sphere-traced ray
      // with LUMEN-STYLE HIT LIGHTING: crisp normal + albedo from the
      // nearest mesh SDF, analytic lights + emitters re-evaluated at the
      // hit (short shadow traces), indirect field for the diffuse rest.
      light.mirrorTraceFn = volume.createMirrorTrace(traceBudget.mirror);
      // Per-hit direct-light re-evaluation (with shadow traces) is OPT-IN
      // (component prop) — it is the largest single chunk of both the
      // compile wave (~2× wall time) and the per-mirror-pixel GPU cost,
      // for a subtle sharpening of light inside reflections. CRITICAL
      // PAIRING: with hit lighting ON, hits must sample the INDIRECT-only
      // buffer (direct is re-added per pixel — full field would
      // double-count); with it OFF, hits must sample the FULL radiance
      // field (the indirect buffer alone is bounce-only ≈ black walls →
      // "reflections absent").
      light.hitLighting = props.hitLighting === true;
      light.mirrorSampleFn = light.hitLighting
        ? volume.createIndirectSampler()
        : volume.createRadianceSampler();
      light.hitSurfaceFn = volume.createHitSurfaceFn();
      light.mirrorShadowFn = volume.createSoftShadowTrace(light.normalOffset, Math.min(24, traceBudget.shadow));
      light.lightSlots = lightSlots;
      // Ray reach scales with the volume (clamped: step cap bounds cost).
      light.mirrorRange = diagU.clamp(8, 48);
    }
    if (emitterSlots) {
      // Pass the exact ray-origin lift — the trace's self-plane exclusion
      // compares field distances against lift + t·cos and needs the real value.
      // Used only by the resolve compute (four call sites, one per emitter
      // slot) — a layout collapses those four inlined 56-step loops into one
      // function, which is what keeps this SYNCHRONOUSLY compiled compute
      // pipeline small enough not to freeze a frame on rebuild.
      light.shadowTraceFn = volume.createSoftShadowTrace(light.normalOffset, traceBudget.shadow, "giResolveShadowTrace");
      light.shadowMargin = volume.world.cellMax.mul(2.5).max(0.2);
      // Shadow reach must cover the whole volume: any receiver inside the
      // cap-but-unshadowed band takes emitter light THROUGH walls.
      light.shadowRange = diagU.clamp(12, 64);
      light.emitterSlots = emitterSlots;
    }
    // DEFERRED RESOLVE: evaluate the gather + emitter shadows once per screen
    // pixel instead of inside every material (see giScreen.js). This is what
    // keeps material shaders small — the driver compile of a 200kB+ GI
    // fragment shader, once per material, was the whole startup cost.
    const screen = this.#buildScreenResolve({ gather, light, emitterSlots });
    if (screen) {
      queue.push(screen.resolve.compute);
      queueNoFeedback.push(screen.resolve.compute);
    }
    engine.scene.add(light);
    // Purge three's lights-hash memo — without this the FIRST build of a
    // session renders with the GI light silently inert (see #purgeLightsHashMemo).
    this.#purgeLightsHashMemo();
    // NOTE: the old delayed second purge (10 ticks post-build) is GONE — it
    // re-keyed every material AFTER the compile wave finished and triggered
    // a second, SYNCHRONOUS compile wave (harness-measured +8s freeze). The
    // purge-at-add above plus the wave (which compiles against the fresh
    // hash) covers the lights-hash memo bug on their own.
    this._lightsRefreshTicks = 0;

    const gizmos = this.#buildGizmos(cascades, bounds);
    gizmos.sdfView = this.#buildSdfView(volume, bounds, center);
    gizmos.all.push(gizmos.sdfView);
    for (const mesh of gizmos.all) engine.scene.add(mesh);

    this.state = {
      volume,
      atlas,
      cascades,
      intervals,
      diagU,
      queue,
      queueNoFeedback,
      debugComputes,
      feedbackEveryFrame,
      light,
      gizmos,
      entries,
      bounds,
      center,
      // Size the grid resolution was derived from. An in-place refit KEEPS
      // this size (it only slides the volume), so it is also the live size —
      // a rebuild is what changes it.
      screen,
      buildSize: new THREE.Vector3(sizeX, sizeY, sizeZ),
      // The probe-spacing rung this build was laid out on — the lattice an
      // in-place slide snaps to. A stretch rescales it.
      probeSpacing,
      c0Grid,
      bounceGain,
      temporalBlend,
      autoFit,
      lightSlots,
      emitterSlots,
      statsLogged: false,
    };
    this._atlasRevisionSeen = -1; // force a first composite
    this._pendingFit = null; // refit debounce restarts against fresh bounds
    this.#syncSlots(entries);
    this._lightObjects = this.#collectLightObjects();
    this.#updateLightUniforms();
    this._structuralSig = this.#structuralSignature(component);
    this._fingerprint = this.#computeFingerprint(meshes);
    this.#applyLiveProps();
    this.#applyDebugVisibility();
    // Fill the pipeline cache ASYNCHRONOUSLY before the render loop touches
    // the new lights state: without this, the next render() sync-compiled
    // every material's pipeline in one frame — a 20-30s hard freeze on real
    // scenes (the init / config-change / refit hang reports). Must run
    // AFTER this.state is assigned (the wave prewarms the compute queue).
    this.#compileWave();
    const resident = atlas.assignments.filter(Boolean).length;
    const analyticCount = atlas.assignments.filter((a) => a?.analytic).length;
    if (autoFit && this._boundsSource) {
      console.log(
        `[gi] auto-fit bounds from ${this._boundsSource} (${analyticCount} analytic / ${resident - analyticCount} baked slots)`,
      );
    }
    console.log(
      `[gi] built (voxel-free): ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m` +
        `${autoFit ? ` (auto-fit ${props.quality ?? "high"}, voxel ${voxelSize.toFixed(2)}, probes ${probeSpacing.toFixed(2)})` : ""}, ` +
        `${res.x}x${res.y}x${res.z} cells, c0 ${c0Grid.x}x${c0Grid.y}x${c0Grid.z}, ` +
        `${cascades.length} cascades, ${meshes.length} meshes → ${atlas.capacity}-slot atlas ` +
        `(${resident} SDFs resident, ${entries.length - resident} pending), ` +
        `${this._lightObjects.length} lights (GPU), ${this._emitterInfos?.length ?? 0} emitters, ` +
        `setup ${(performance.now() - t0).toFixed(0)}ms`,
    );
    // COVERAGE CHECK. Everything outside the volume is invisible to GI:
    // receivers out there get no probes (dark floors), and mirror rays leave
    // the field within a step or two and MISS, so reflective materials fall
    // back to the blurry cascade average and read as flat washed-out white.
    // Both look like "GI is broken" rather than "the volume is too small",
    // so say it plainly with the numbers.
    const sceneBox = this.#sceneAabb(meshes);
    if (sceneBox) {
      const sceneSize = new THREE.Vector3().subVectors(sceneBox.max, sceneBox.min);
      const sceneVolume = Math.max(1e-6, sceneSize.x * sceneSize.y * sceneSize.z);
      const covered = sizeX * sizeY * sizeZ;
      if (covered < sceneVolume * 0.35) {
        console.warn(
          `[gi] volume covers only ${((covered / sceneVolume) * 100).toFixed(0)}% of the scene content ` +
            `(GI ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m vs content ` +
            `${sceneSize.x.toFixed(1)}x${sceneSize.y.toFixed(1)}x${sceneSize.z.toFixed(1)}m). ` +
            `Geometry outside it receives NO GI and reflections there miss (metals read flat white). ` +
            `Move the Global Illumination component onto the entity that contains the room, or turn Auto Fit off and set the size manually.`,
        );
      }
    }
    // PROBE DENSITY. The quality presets are total probe BUDGETS, so the
    // world-space spacing follows the volume's size: a room modelled at 10×
    // scale gets 10× coarser probes for the same preset. Indirect light is
    // interpolated between them, so a coarse lattice reads as concentric
    // rings around bright emissives.
    if (autoFit && probeSpacing > 0.5) {
      console.warn(
        `[gi] probe spacing is ${probeSpacing.toFixed(2)}m (volume ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m at "${props.quality ?? "high"}") — ` +
          `indirect light is interpolated between probes this far apart, which shows as concentric rings/bands around bright emissives. ` +
          `Raise Quality, or build the scene at a smaller world scale (a 20m room needs 4x the probes of a 5m one for the same look).`,
      );
    }
    // Compile-cost breakdown: buckets 3 + 0 are the expensive shader variants.
    const bt = this._bucketTally ?? [0, 0, 0, 0];
    console.log(
      `[gi] material GI buckets: ${bt[0]} mirror, ${bt[1]} specular, ${bt[2]} diffuse-only, ${bt[3]} dynamic-roughness` +
        ` (mirror + dynamic = the expensive shaders; ${bt[0] + bt[3]}/${bt[0] + bt[1] + bt[2] + bt[3]})`,
    );
  }

  /**
   * Copies the scene's analytic lights into the feedback pass's uniform
   * slots — runs EVERY frame, so moving/re-colored lights update the field
   * with zero rebakes (matching the reference's per-frame sun evaluation).
   * The light LIST is refreshed at fingerprint cadence; positions/colors
   * are read live off the cached objects here.
   */
  #updateLightUniforms() {
    const state = this.state;
    if (!state?.lightSlots) return;
    const lights = this._lightObjects ?? [];
    if (lights.length > MAX_GI_LIGHTS && !this._warnedLightBudget) {
      this._warnedLightBudget = true;
      console.warn(`[gi] ${lights.length} analytic lights; GPU direct covers the first ${MAX_GI_LIGHTS}`);
    }
    for (let i = 0; i < state.lightSlots.length; i++) {
      const slot = state.lightSlots[i];
      const light = lights[i];
      if (!light || !light.visible || light.intensity <= 0) {
        slot.active.value = 0;
        continue;
      }
      slot.active.value = 1;
      if (light.isDirectionalLight) {
        slot.kind.value = 1;
        light.updateWorldMatrix(true, false);
        light.target.updateWorldMatrix(true, false);
        const from = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
        const direction = to.sub(from);
        if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0);
        // Stored TOWARD the light (the shader marches shadow rays that way).
        slot.vector.value.copy(direction.normalize().negate());
      } else {
        slot.kind.value = 0;
        light.getWorldPosition(slot.vector.value);
      }
      slot.range.value = light.isPointLight ? Math.max(0, light.distance || 0) : 0;
      slot.color.value.copy(light.color).multiplyScalar(light.intensity);
    }
  }

  #dispose() {
    const state = this.state;
    if (!state) return;
    this.state = null;
    state.volume?.dispose?.();
    // The gbuffer is per-build; the resolve TARGETS are not (see
    // createGiTargets) — disposing them here would strand every material that
    // is still bound to them.
    state.screen?.gbuffer?.dispose?.();
    state.light?.removeFromParent();
    for (const mesh of state.gizmos?.all ?? []) {
      mesh.removeFromParent();
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    // Compute nodes / storage buffers are released with GC once nothing
    // references them; three's storage attributes hold no scene-graph refs.
  }

  #applyLiveProps() {
    const state = this.state;
    if (!state) return;
    state.light.intensityUniform.value = this.component?.props.intensity ?? 1;
    // Hard-clamped to [0,1]: bounce is "how much secondary energy survives
    // each pass", and any in-loop gain above 1 makes the feedback series
    // diverge (white-out) in enclosed scenes — old saved props may still
    // carry values up to 4 from the earlier schema. Artistic exaggeration
    // belongs to `intensity`, which sits OUTSIDE the loop.
    state.bounceGain.value = Math.min(1, Math.max(0, this.component?.props.bounce ?? 1));
    state.temporalBlend.value = Math.min(1, Math.max(0.02, this.component?.props.temporalBlend ?? 0.25));
  }

  #applyDebugVisibility() {
    const state = this.state;
    if (!state) return;
    const mode = this.component?.props.debugProbes ?? "off";
    state.gizmos.raw.visible = mode === "raw";
    state.gizmos.merged.visible = mode === "merged";
    if (state.gizmos.sdfView) state.gizmos.sdfView.visible = mode === "sdf";
  }

  // -------------------------------------------------------------------------
  // Entries: one per GI mesh, carrying the bake-resolved surface + content
  // identity. Promotion: the brightest emissive meshes become analytic
  // sphere area lights — their emissive leaves the composited field (the
  // geometry stays, as occluder/albedo) and per-frame uniform slots carry
  // their light instead, so a moving lamp stays smooth and bake-free.

  #buildEntries(meshes) {
    const entries = [];
    for (const mesh of meshes) {
      const surface = resolveMaterialSurface(mesh.material, mesh.name);
      const r = surface.emissive.r * surface.emissiveIntensity;
      const g = surface.emissive.g * surface.emissiveIntensity;
      const b = surface.emissive.b * surface.emissiveIntensity;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const tris = (geometry.index?.count ?? position.count) / 3;
      const analytic = analyticShapeOf(
        geometry,
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      );
      if (analytic) {
        entries.push({
          mesh, surface, tris, luminance, r, g, b, analytic,
          contentKey: null, sdfPath: null, promoted: false,
        });
        continue;
      }
      const assetPath = geometry.userData?.assetPath ?? null;
      const hash = geometryContentHash(geometry);
      // Persistence: `.geom` assets get an in-place sidecar; EVERYTHING else
      // (GLB-internal geometries, editor primitives) goes to the project's
      // content-addressed derived-data cache — bake once, reuse across
      // sessions, scenes, and mesh instances. Null (no project open /
      // exported player without the cache) → session cache only.
      const contentKey = assetPath ? `${assetPath}@${position.version ?? 0}` : `sdf#${hash}`;
      const sdfPath = assetPath ? `${assetPath}.sdf` : getDerivedDataPath(`gi-sdf/${hash}.sdf`);
      entries.push({ mesh, surface, tris, luminance, r, g, b, contentKey, sdfPath, promoted: false });
    }

    // Emitter promotion: qualify by luminance ≥ 0.5, rank by emitted POWER
    // (luminance · world radius²) — a large dim panel outshines a tiny
    // bright trinket, and the slots should go to the lamps that actually
    // light the scene.
    this._emitterInfos = [];
    if (this.component?.props.emissiveShadows !== false) {
      const scratch = new THREE.Vector3();
      const powerOf = (entry) => {
        const geometry = entry.mesh.geometry;
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        entry.mesh.getWorldScale(scratch);
        const radius =
          (geometry.boundingSphere?.radius ?? 0.1) *
          Math.max(Math.abs(scratch.x), Math.abs(scratch.y), Math.abs(scratch.z));
        return entry.luminance * Math.max(radius * radius, 1e-4);
      };
      const bright = entries.filter((entry) => entry.luminance >= 0.5).sort((a, b) => powerOf(b) - powerOf(a));
      if (bright.length > MAX_EMITTERS && !this._warnedEmitterBudget) {
        this._warnedEmitterBudget = true;
        console.warn(`[gi] ${bright.length} bright emitters; analytic slots cover the brightest ${MAX_EMITTERS}`);
      }
      for (const entry of bright.slice(0, MAX_EMITTERS)) {
        entry.promoted = true;
        this._emitterInfos.push({ mesh: entry.mesh, r: entry.r, g: entry.g, b: entry.b });
      }
      // DYNAMIC emitters (particle systems) claim whatever slots the emissive
      // meshes left. They have no mesh — `#refreshEmitterSlots` reads their
      // shape from a provider callback each frame instead. Meshes get priority
      // because they are the scene's fixed lamps; a particle effect that wants
      // a guaranteed slot has to out-rank them on power, which is a
      // deliberately conservative default.
      const free = MAX_EMITTERS - this._emitterInfos.length;
      if (free > 0) {
        for (const provider of this.engine.giEmitters ?? []) {
          if (this._emitterInfos.length >= MAX_EMITTERS) break;
          this._emitterInfos.push({ provider });
        }
        void free;
      }
    }
    return entries;
  }

  /** Slot surface for an entry: promoted emitters composite ZERO emissive. */
  #slotSurface(entry) {
    return {
      color: entry.surface.color,
      emissive: entry.promoted
        ? { r: 0, g: 0, b: 0 }
        : {
            r: entry.surface.emissive.r * entry.surface.emissiveIntensity,
            g: entry.surface.emissive.g * entry.surface.emissiveIntensity,
            b: entry.surface.emissive.b * entry.surface.emissiveIntensity,
          },
    };
  }

  /**
   * Reconciles atlas slots with the current entry list: clears slots whose
   * mesh left the scene, seats cached SDFs into free slots, refreshes slot
   * surfaces (live color/emissive edits), picks detail slots, and kicks
   * load-or-bake for entries without a cached SDF. Pure uniform/texture
   * state — no shader recompiles, no CPU field math.
   */
  #syncSlots(entries) {
    const state = this.state;
    if (!state) return;
    const atlas = state.atlas;
    const byMesh = new Map(entries.map((entry) => [entry.mesh, entry]));
    for (let i = 0; i < atlas.assignments.length; i++) {
      const assignment = atlas.assignments[i];
      if (assignment && !byMesh.has(assignment.mesh)) atlas.clearSlot(i);
    }
    let overflow = 0;
    for (const entry of entries) {
      const existing = atlas.assignments.findIndex((a) => a && a.mesh === entry.mesh);
      if (existing >= 0) {
        atlas.setSlotSurface(existing, this.#slotSurface(entry));
        continue;
      }
      // Analytic primitives seat immediately — no bake, no cache, no file.
      if (entry.analytic) {
        const free = atlas.assignments.findIndex((a) => !a);
        if (free < 0) {
          overflow++;
          continue;
        }
        atlas.setAnalyticSlot(free, entry.mesh, entry.analytic, this.#slotSurface(entry));
        continue;
      }
      const cached = this._meshSdfCache.get(entry.contentKey);
      if (!cached?.sdf) {
        this.#ensureMeshSdf(entry);
        continue;
      }
      const free = atlas.assignments.findIndex((a) => !a);
      if (free < 0) {
        overflow++;
        continue;
      }
      atlas.setSlot(free, entry.mesh, cached.sdf, this.#slotSurface(entry));
    }
    if (overflow > 0) {
      if (entries.length <= MAX_MESH_SDF_SLOTS) {
        // A bigger atlas tier can seat everyone — rebuild once.
        this.requestRebuild();
      } else if (!this._warnedSlotBudget) {
        this._warnedSlotBudget = true;
        console.warn(`[gi] ${entries.length} meshes exceed the ${MAX_MESH_SDF_SLOTS}-slot SDF atlas — extras are invisible to GI`);
      }
    }
    // Detail slots — per-step trace refinement. Priority order:
    // 1. THIN analytic slots (plane walls, partitions, hollow room shells):
    //    thinner than the field cell they are otherwise invisible to the
    //    sphere trace between cell centers — the "light goes through the
    //    partition" leak. Analytic distances are exact and fetch-free.
    // 2. Densest baked meshes (sub-cell silhouettes: wings, fine props).
    const minCell = state.volume?.minCell ?? 0.2;
    const scratchScale = new THREE.Vector3();
    const mapped = entries
      .map((entry) => ({
        entry,
        slot: atlas.assignments.findIndex((a) => a && a.mesh === entry.mesh),
      }))
      .filter((d) => d.slot >= 0);
    const thinWalls = [];
    const dense = [];
    const thinThreshold = Math.max(2 * minCell, 0.4);
    for (const d of mapped) {
      const analytic = d.entry.analytic;
      d.entry.mesh.getWorldScale(scratchScale);
      if (analytic) {
        const minDim =
          2 *
          Math.min(
            analytic.half[0] * Math.abs(scratchScale.x),
            analytic.half[1] * Math.abs(scratchScale.y),
            analytic.half[2] * Math.abs(scratchScale.z),
          );
        // Hollow shells ARE walls regardless of their outer dimensions.
        if (analytic.hollow || minDim < thinThreshold) thinWalls.push(d);
      } else {
        // BAKED thin slabs (geometry-editor / GLB walls — no primitive
        // type, so no analytic slot) leak exactly like primitive ones:
        // their local 64³ SDF is far finer than the global field, so
        // detail-refining them seals sub-cell walls of ANY origin.
        const geometry = d.entry.mesh.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const minDim = bb
          ? Math.min(
              (bb.max.x - bb.min.x) * Math.abs(scratchScale.x),
              (bb.max.y - bb.min.y) * Math.abs(scratchScale.y),
              (bb.max.z - bb.min.z) * Math.abs(scratchScale.z),
            )
          : Infinity;
        if (minDim < thinThreshold) thinWalls.push(d);
        else dense.push(d);
      }
    }
    dense.sort((a, b) => b.entry.tris - a.entry.tris);
    const budget = Math.min(DETAIL_SLOTS, atlas.detailBudget ?? DETAIL_SLOTS);
    atlas.setDetailSlots([...thinWalls, ...dense].slice(0, budget).map((d) => d.slot));
  }

  /**
   * Load-or-bake one entry's SDF (keyed by content, shared across
   * instances): try the persisted `.sdf` sidecar first (stale/corrupt files
   * rebake), else bake in the dedicated worker and persist the result.
   * Bake once, reuse forever — including across sessions.
   */
  #ensureMeshSdf(entry) {
    const cache = this._meshSdfCache;
    if (cache.get(entry.contentKey)?.pending || cache.get(entry.contentKey)?.sdf) return;
    const cacheEntry = { pending: true, sdf: null };
    cache.set(entry.contentKey, cacheEntry);
    const name = entry.mesh.name || entry.contentKey;
    const record = serializeMeshForBake(entry.mesh);
    if (!record) {
      cache.delete(entry.contentKey);
      return;
    }
    const fingerprint = geometryFingerprintOf(record);
    const finish = (sdf, how) => {
      cacheEntry.pending = false;
      cacheEntry.sdf = sdf;
      console.log(`[gi] mesh SDF ${how} (${name}): ${sdf.dims.x}x${sdf.dims.y}x${sdf.dims.z}`);
      // Seat it into WHATEVER build is current by then — SDFs are keyed by
      // content, so they remain valid across rebuilds/refits (an auto-fit
      // refit mid-bake must not orphan the result).
      if (this.state) this.#syncSlots(this.state.entries);
    };
    const bake = () => {
      const t0 = performance.now();
      this._sdfBaker
        .request(record)
        .then(async (sdf) => {
          finish(sdf, `baked in ${(performance.now() - t0).toFixed(0)}ms`);
          // Persist loudly: a silent save failure looks identical to working
          // persistence until the next editor start rebakes everything.
          if (!entry.sdfPath) {
            console.warn(`[gi] mesh SDF session-only (${name}) — no asset path and no project open, will rebake next start`);
          } else if (await saveAssetBinary(entry.sdfPath, encodeMeshSdf(sdf, fingerprint))) {
            console.log(`[gi] mesh SDF saved: ${entry.sdfPath}`);
          } else {
            console.warn(`[gi] mesh SDF NOT saved (${name}) — write failed or writer unavailable: ${entry.sdfPath}`);
          }
        })
        .catch((error) => {
          cache.delete(entry.contentKey);
          console.warn(`[gi] mesh SDF bake failed (${name}):`, error?.message ?? error);
        });
    };
    if (!entry.sdfPath) {
      bake();
      return;
    }
    (async () => {
      try {
        const response = await fetch(await resolveAssetUrl(entry.sdfPath));
        if (response.ok) {
          const sdf = decodeMeshSdf(await response.arrayBuffer(), fingerprint);
          if (sdf) {
            finish(sdf, "loaded from file");
            return;
          }
        }
      } catch {
        // no file yet — fall through to bake
      }
      bake();
    })();
  }

  /**
   * Refreshes emitter-slot uniforms from the promoted meshes' LIVE world
   * transforms — every frame, so a dragged lamp re-aims its light and
   * shadows continuously.
   */
  #refreshEmitterSlots() {
    const state = this.state;
    if (!state?.emitterSlots) return;
    const infos = this._emitterInfos ?? [];
    const scratchScale = new THREE.Vector3();
    const scratchPos = new THREE.Vector3();
    const scratchQuat = new THREE.Quaternion();
    for (let i = 0; i < state.emitterSlots.length; i++) {
      const slot = state.emitterSlots[i];
      const info = infos[i];
      if (!info) {
        slot.radius.value = 0;
        continue;
      }
      // Dynamic emitter (particle system): no mesh, no bounding sphere — the
      // provider reports this frame's centre/radius/colour directly. Returning
      // null parks the slot at radius 0, which is how a system with no live
      // particles (or a readback still in flight) contributes nothing.
      if (info.provider) {
        const shape = info.provider();
        if (!shape || !(shape.radius > 0)) {
          slot.radius.value = 0;
          continue;
        }
        slot.center.value.copy(shape.center);
        slot.radius.value = shape.radius;
        slot.color.value.setRGB(shape.r, shape.g, shape.b);
        continue;
      }
      if (!info.mesh.visible) {
        slot.radius.value = 0;
        continue;
      }
      const geometry = info.mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      slot.center.value.copy(geometry.boundingSphere.center).applyMatrix4(info.mesh.matrixWorld);
      info.mesh.matrixWorld.decompose(scratchPos, scratchQuat, scratchScale);
      slot.radius.value =
        geometry.boundingSphere.radius * Math.max(scratchScale.x, scratchScale.y, scratchScale.z);
      slot.color.value.setRGB(info.r, info.g, info.b);
    }
  }

  // -------------------------------------------------------------------------
  // Scene collection

  #collectMeshes() {
    const meshes = [];
    // Per-bucket material tally (see giRoughnessBucketOf): logged at build so
    // a slow scene reports WHY — bucket 3/0 materials compile and run the
    // mirror + hit-lighting path, buckets 1/2 are a fraction of that cost.
    const seenMaterials = new Set();
    const tally = [0, 0, 0, 0];
    const visit = (object) => {
      // Batched members are hidden yet still drawn (engine/batching.js).
      if (object.visible === false && !object.userData.batchedInto) return;
      if (object.isMesh && !object.isInstancedMesh && !object.userData.__giDebug) {
        const position = object.geometry?.attributes?.position;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const triCount = (object.geometry?.index?.count ?? position?.count ?? 0) / 3;
        // Editor-only helpers live on layer 31 (mask compared unsigned —
        // 1<<31 is negative in JS int32).
        const editorOnly = ((object.layers.mask >>> 0) & 0x80000000) !== 0 && (object.layers.mask >>> 0) === 0x80000000;
        // EVERY lit material must be visible to three's NodeMaterialObserver
        // as "node-driven" — see #markObservedMaterial. GI light receivers
        // include meshes the FIELD skips (transparent etc.), so mark all.
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of mats) {
          // Volume materials shade through a scattering model with no
          // irradiance slot (see GICascadeLightNode.setup) — marking them
          // would only add a per-frame uniform refresh for a material that
          // cannot receive GI anyway.
          if (m?.isVolumeNodeMaterial || m?.userData?.isVolumeMaterial) continue;
          this.#markObservedMaterial(m);
          this.#refreshMirrorBucket(m);
          if (m && !seenMaterials.has(m)) {
            seenMaterials.add(m);
            tally[giRoughnessBucketOf(m)]++;
          }
        }
        // A volume's bounding box is a participating medium, not a surface —
        // baking it into the SDF field would make a fog box shadow the room
        // like a solid crate.
        const isVolume = material?.isVolumeNodeMaterial || material?.userData?.isVolumeMaterial;
        if (position && material && !material.transparent && !isVolume && !editorOnly && triCount <= MAX_TRIS_PER_MESH) {
          meshes.push(object);
        } else if (triCount > MAX_TRIS_PER_MESH) {
          console.warn(`[gi] skipping "${object.name || "mesh"}" (${Math.round(triCount)} tris > cap)`);
        }
      }
      for (const child of object.children) visit(child);
    };
    if (this.engine.scene) visit(this.engine.scene);
    this._bucketTally = tally;
    return meshes;
  }

  /**
   * Marks a material so three's NodeMaterialObserver treats it as
   * node-driven (`hasNode` true → uniforms refreshed EVERY frame).
   * Without this, plain materials only refresh their uniform buffers when
   * something the observer monitors changes (own matrix, material props,
   * known light data) — our GI uniforms (emitter centers/colors, intensity,
   * light slots) are invisible to it, so on a STATIC receiver they freeze
   * at compile-time values: a moved lamp kept lighting its old position
   * (harness-proven: move ≈ no image change, rebuild at the same spot ≈
   * 95k-pixel change). The marker is an inert extra property — builders
   * ignore unknown props; `containsNode` only checks `.isNode`.
   */
  #markObservedMaterial(material) {
    if (!material || material.giMonitorNode?.isNode) return;
    material.giMonitorNode = float(0);
    // CACHE-KEY OVERRIDE: three's material cache key reduces numeric
    // properties to on/off, so same-structure materials with different
    // static roughness hash IDENTICALLY — and since the GI light node
    // generates different code per roughness bucket, they would steal each
    // other's shared node builds (harness-proven: a mirror material
    // rendering with the diffuse-only build → "reflections absent").
    // Appending the LIVE-derived bucket keys each variant separately while
    // still letting same-bucket materials share one build.
    const original = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => original() + "|gi" + giRoughnessBucketOf(material);
    // Recompile so the observer is rebuilt with hasNode = true.
    material.needsUpdate = true;
  }

  #collectLightObjects() {
    const lights = [];
    this.engine.scene?.traverse((object) => {
      if ((object.isDirectionalLight || object.isPointLight) && object.visible && object.intensity > 0) {
        lights.push(object);
      }
    });
    return lights;
  }

  // -------------------------------------------------------------------------
  // Change detection: transforms are handled PER FRAME by the atlas (uniform
  // epsilon-diff → recomposite). The fingerprint cadence only handles the
  // slower changes: mesh add/remove, geometry edits, material color edits,
  // light-list churn, and auto-fit drift.

  #queueRebakeCheck() {
    this._frame = -1; // forces the next tick's modulo to hit
  }

  #checkFingerprint() {
    const state = this.state;
    const component = this.component;
    if (!state || !component) return;
    // Time floor: editor drags poke the check every frame via change
    // events — collapse bursts to one scan per interval (transforms don't
    // need scans; they're handled per frame by the atlas uniforms).
    const nowMs = performance.now();
    if (nowMs - (this._lastScanAt ?? 0) < FINGERPRINT_MIN_INTERVAL_MS) return;
    this._lastScanAt = nowMs;

    if (state.autoFit) {
      // Refit ONLY when the live volume has stopped covering the content.
      // Bounds are authored by the component's entity (#autoFitAabb) —
      // moving other scene objects cannot change them, so this fires only
      // when the user edits the bounds source itself, and then usually
      // resolves to a lattice slide rather than a rebuild.
      const now = performance.now();
      // Entity-authored bounds only move when the user edits the bounds
      // source → refit checks are cheap and can be responsive (3s).
      // WHOLE-SCENE fallback bounds shift whenever anything big moves —
      // keep the old 10s cadence there or a dragged prop can trigger a
      // rebuild (and its compile wave) mid-drag.
      const sceneWide = (this._boundsSource ?? "").startsWith("whole scene");
      if (now - (this._lastRefitAt ?? 0) > (sceneWide ? 10000 : 3000)) {
        const aabb = this.#autoFitAabb() ?? this.#sceneAabb(this.#collectMeshes());
        if (aabb) {
          const fit = this.#fitBoundsFor(aabb);
          // THE VOLUME IS ONLY WRONG WHEN IT NO LONGER COVERS THE CONTENT.
          // The old test compared the freshly fitted BOX against the live
          // one and refitted whenever they differed by more than a
          // tolerance — but the live volume is deliberately not the tight
          // fit (an in-place refit keeps the build-time size and only
          // slides), so that test could never settle. Ask the question that
          // actually matters instead: is the content still inside, at the
          // same probe-spacing rung, without the volume having grown
          // absurdly larger than the content?
          const slack = 1e-4;
          const covered =
            fit.min.x >= state.bounds.min.x - slack &&
            fit.min.y >= state.bounds.min.y - slack &&
            fit.min.z >= state.bounds.min.z - slack &&
            fit.max.x <= state.bounds.max.x + slack &&
            fit.max.y <= state.bounds.max.y + slack &&
            fit.max.z <= state.bounds.max.z + slack;
          const base = state.buildSize;
          const oversized =
            fit.sizeX < base.x * 0.55 && fit.sizeY < base.y * 0.55 && fit.sizeZ < base.z * 0.55;
          if (!covered || oversized) {
            // Debounce: require the SAME new answer on two consecutive
            // scans before refitting — a one-scan flicker (mid-drag, a
            // trim threshold crossing) must not trigger a refit. Fits are
            // lattice-snapped, so "the same answer" is now exact equality
            // rather than a tolerance.
            const same = (a, b) =>
              a.min.distanceToSquared(b.min) < 1e-8 && a.max.distanceToSquared(b.max) < 1e-8;
            if (this._pendingFit && same(fit, this._pendingFit)) {
              this._pendingFit = null;
              this._lastRefitAt = now;
              // IN PLACE first: uniform update + one recomposite, ZERO
              // shader recompiles. Falls back to a full rebuild (compile
              // wave) only when the volume drifted so far from the
              // build-time size that the fixed grid would go badly
              // non-cubic or under-resolved.
              if (!this.#refitInPlace(fit)) {
                console.log("[gi] auto-fit: bounds drifted beyond the in-place window — full rebuild");
                this.requestRebuild();
              }
              return;
            }
            this._pendingFit = { min: fit.min.clone(), max: fit.max.clone() };
          } else {
            this._pendingFit = null;
          }
        }
      }
    } else {
      const center = new THREE.Vector3();
      component.entity.object3D.getWorldPosition(center);
      if (center.distanceTo(state.center) > Math.max(0.5, (component.props.probeSpacing || 1.25) * 0.5)) {
        this.requestRebuild();
        return;
      }
    }

    const meshes = this.#collectMeshes();
    // Refresh the light LIST here (cadence); uniforms read live per frame.
    this._lightObjects = this.#collectLightObjects();
    const fingerprint = this.#computeFingerprint(meshes);
    if (fingerprint === this._fingerprint) return;
    this._fingerprint = fingerprint;
    // Mesh set / material / geometry change: rebuild the entry list and
    // reconcile slots. Cheap (no geometry copies unless a bake is needed),
    // and any real change bumps the atlas revision → one composite pass.
    const entries = this.#buildEntries(meshes);
    state.entries = entries;
    this.#syncSlots(entries);
  }

  /**
   * Applies new auto-fit bounds WITHOUT a rebuild: every world-space shader
   * input is a uniform (see createSdfScene's world bundle), so a refit is a
   * uniform update + a full-slot AABB refresh + one recomposite — the
   * viewport never freezes. This is what makes MOVING OBJECTS safe in
   * scenes that live under the GI entity: before, any move that shifted the
   * fitted bounds beyond tolerance triggered a full rebuild whose material
   * compile wave held the viewport for 10-20s right after the drag.
   *
   * The grid RESOLUTION stays fixed (dispatch sizes / buffer lengths are
   * build constants), and so does the volume SIZE: a refit is a pure
   * TRANSLATION along the probe lattice. That is what keeps the light stable
   * while the scene is edited — cell and probe spacing never change, every
   * probe that stays inside the volume keeps its exact world position, and
   * the field slides by a whole number of cells instead of resampling. The
   * old refit rescaled the volume to hug the content, so any edit that moved
   * the bounds moved every probe and visibly re-shuffled the indirect light
   * ("GI changes a lot when I move/scale things").
   *
   * TWO TIERS, cheapest first:
   *   SLIDE   — the content still fits in the current box: translate on the
   *             lattice. Nothing resamples, no probe moves, no recompile.
   *   STRETCH — the content outgrew the box: rescale the fixed grid to the
   *             new bounds (cells and probes get coarser/finer, so the light
   *             does visibly shift). Still uniform-only — the alternative is
   *             a full rebuild whose compile wave freezes the viewport, which
   *             is exactly the "10s hang after I move something" report.
   *
   * Returns false — caller falls back to a full rebuild — only when even a
   * stretch would leave the fixed grid badly proportioned (per-axis ratio
   * vs the BUILD size outside [0.55, 1.9]; measured from the build size so
   * repeated stretches cannot walk the grid arbitrarily far).
   */
  #refitInPlace(fit) {
    const state = this.state;
    if (!state?.autoFit || !state.volume?.setBounds) return false;
    const live = new THREE.Vector3().subVectors(state.bounds.max, state.bounds.min);
    const spacing = state.probeSpacing;
    const have = [live.x, live.y, live.z];
    const need = [fit.sizeX, fit.sizeY, fit.sizeZ];
    const fits = spacing > 0 && need.every((n, i) => n <= have[i] + 1e-4);

    if (fits) {
      // Centre the current box on the content, snap onto the lattice, then
      // clamp so the content stays covered. Both fit faces are already
      // lattice-aligned, so the clamps are exact and cannot conflict (the
      // size check guarantees fit.min ≥ fit.max − have).
      const min = new THREE.Vector3();
      for (const [i, axis] of ["x", "y", "z"].entries()) {
        const centre = (fit.min[axis] + fit.max[axis]) / 2;
        let m = Math.round((centre - have[i] / 2) / spacing) * spacing;
        m = Math.min(m, Math.floor((fit.min[axis] + 1e-6) / spacing) * spacing);
        m = Math.max(m, Math.ceil((fit.max[axis] - have[i] - 1e-6) / spacing) * spacing);
        min[axis] = m;
      }
      const next = { min, max: min.clone().add(live) };
      if (
        next.min.distanceToSquared(state.bounds.min) < 1e-8 &&
        next.max.distanceToSquared(state.bounds.max) < 1e-8
      ) {
        return true; // already where it needs to be
      }
      this.#applyBounds(next, live);
      const centre = state.center;
      console.log(
        `[gi] auto-fit: refit in place (slide, nothing resampled) — volume centred at ` +
          `${centre.x.toFixed(1)},${centre.y.toFixed(1)},${centre.z.toFixed(1)}, ` +
          `${live.x.toFixed(1)}x${live.y.toFixed(1)}x${live.z.toFixed(1)}m, probes ${spacing.toFixed(2)}m`,
      );
      return true;
    }

    // The content grew past the box — stretch the fixed grid onto it.
    const base = state.buildSize;
    const ratios = [fit.sizeX / base.x, fit.sizeY / base.y, fit.sizeZ / base.z];
    if (ratios.some((r) => !(r > 0.55 && r < 1.9))) return false;
    const size = new THREE.Vector3(fit.sizeX, fit.sizeY, fit.sizeZ);
    this.#applyBounds({ min: fit.min, max: fit.max }, size);
    // Interval lengths + reach follow the same formulas the build uses.
    const maxAxis = Math.max(fit.sizeX, fit.sizeY, fit.sizeZ);
    state.intervals.t0.value = fit.probeSpacing ?? state.probeSpacing;
    state.intervals.farT.value = maxAxis * 2;
    state.diagU.value = Math.hypot(fit.sizeX, fit.sizeY, fit.sizeZ);
    // Probes rescaled with the box: record the live spacing so the next
    // slide snaps onto the lattice the field ACTUALLY has.
    const grid = state.c0Grid;
    if (grid) state.probeSpacing = Math.min(fit.sizeX / grid.x, fit.sizeY / grid.y, fit.sizeZ / grid.z);
    console.log(
      `[gi] auto-fit: refit in place (stretch, no recompile) — ` +
        `${fit.sizeX.toFixed(1)}x${fit.sizeY.toFixed(1)}x${fit.sizeZ.toFixed(1)}m, ` +
        `cell ${state.volume.minCell.toFixed(3)}`,
    );
    return true;
  }

  /** setBounds + everything that has to follow it (shared by both tiers). */
  #applyBounds(next, size) {
    const state = this.state;
    state.volume.setBounds(next); // mutates state.bounds + world uniforms + atlas.aabbExpand
    state.center.copy(next.min).add(next.max).multiplyScalar(0.5);
    // A stretch changes the cell size, and flat primitives' solid thickness
    // is derived from it (see the build).
    state.atlas.minAnalyticHalfWorld = Math.max(0.01, state.volume.minCell * 0.5);
    // Slot AABBs embed the old aabbExpand — refresh every slot and bump the
    // revision so the next tick recomposites the whole field + full queue.
    state.atlas.refreshAllSlots();
    // Thin-wall detail-slot selection depends on the cell size.
    this.#syncSlots(state.entries);
    // The SDF debug box is a build-size BoxGeometry — reposition/rescale it.
    const sdfView = state.gizmos?.sdfView;
    if (sdfView) {
      sdfView.position.copy(state.center);
      sdfView.scale.set(size.x / state.buildSize.x, size.y / state.buildSize.y, size.z / state.buildSize.z);
    }
  }

  #computeFingerprint(meshes) {
    let hash = 0x811c9dc5;
    const mix = (value) => {
      hash ^= value & 0xffffffff;
      hash = Math.imul(hash, 0x01000193);
    };
    const mixFloat = (f) => mix(Math.round(f * 1000));
    for (const mesh of meshes) {
      mix(mesh.id);
      // Resolve through colorNode/emissiveNode (same path the slot surfaces
      // use) so shader-graph/material-asset color edits fingerprint.
      const surface = resolveMaterialSurface(mesh.material);
      mixFloat(surface.color.r);
      mixFloat(surface.color.g);
      mixFloat(surface.color.b);
      mixFloat(surface.emissive.r * surface.emissiveIntensity);
      mixFloat(surface.emissive.g * surface.emissiveIntensity);
      mixFloat(surface.emissive.b * surface.emissiveIntensity);
      mix(mesh.geometry?.id ?? 0);
      mix(mesh.geometry?.attributes?.position?.version ?? 0);
    }
    return (hash >>> 0).toString(16);
  }

  // -------------------------------------------------------------------------

  #buildGizmos(cascades, bounds) {
    const c0 = cascades[0];
    const spacing = (bounds.max.x - bounds.min.x) / c0.grid.x;
    const make = (buffer) => {
      const geometry = new THREE.SphereGeometry(Math.min(spacing * 0.12, 0.15), 8, 6);
      const material = new THREE.MeshBasicNodeMaterial();
      material.positionNode = positionLocal.add(c0.probePositionOf(instanceIndex.toFloat()));
      const raw = buffer.element(instanceIndex).mul(8);
      material.colorNode = raw.div(raw.add(1));
      const mesh = new THREE.InstancedMesh(geometry, material, c0.probeCount);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.userData.__giDebug = true;
      const identity = new THREE.Matrix4();
      const array = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) array.set(identity.elements, i * 16);
      mesh.instanceMatrix.needsUpdate = true;
      return mesh;
    };
    const raw = make(c0.averages);
    const merged = make(c0.mergedAverages);
    return { raw, merged, all: [raw, merged] };
  }

  /** Debug "SDF" view: a volume box raymarching the composited field. */
  #buildSdfView(volume, bounds, center) {
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      createSdfDebugMaterial(volume),
    );
    mesh.position.copy(center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9999;
    mesh.userData.__giDebug = true;
    return mesh;
  }
}
