// GISystem — engine runtime for the Radiance Cascades GI module.
//
// VOXEL-FREE ARCHITECTURE: per-mesh SDFs are the sole authored scene
// representation. Every GI-relevant mesh gets a local 64³ distance field —
// baked ONCE in a worker (seconds for dense meshes, ms for props) and
// persisted under `<project>/Library/gi-sdf/` keyed by geometry content hash,
// so subsequent loads are instant and the Assets panel never sees bake
// caches next to authored `.geom` files. A GPU composite pass (giField.js)
// min()s all mesh SDFs into the global distance + surface field the cascades
// trace; moving a mesh only updates its slot uniforms and re-runs that one
// pass. There is no CPU voxelizer, no scene-bake worker, and no incremental
// rebake machinery — scene edits cost ~1-2ms of GPU, never a main-thread hitch.
//
// On top of that field, unchanged: per-frame cascade trace/merge (1-frame
// response), bounce feedback (infinite-bounce loop), per-frame analytic
// lights + promoted emissive emitters (uniform slots, zero rebakes), and
// the GICascadeLight material injection.
import * as THREE from "three/webgpu";
import { cameraPosition, cos, float, fract, instanceIndex, mix, normalWorld, positionLocal, positionWorld, screenCoordinate, screenUV, select, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from "three/tsl";
import { createRadianceCascades } from "./cascadeTrace.js";
import { createCascadeMerge } from "./cascadeMerge.js";
import { createBounceFeedback, createIrradianceGather, createProbeDepthMoments, createProbeIrradiance, createRadianceLookup, depthMomentsAlpha, gatherBias, gatherViewBias, probeSnapAlpha } from "./cascadeGather.js";
import { blitBvhAtlasTiles, createGiBvhReflect, createGiBvhTarget, createGiGBuffer, createGiResolve, createGiTargets, renderGiGBuffer } from "./giScreen.js";
import { resolveMaterialSurface, serializeMeshForBake } from "./voxelizeOnce.js";
import { createOccupancyDebugMaterial, createSdfDebugMaterial, createGiField } from "./giField.js";
import { createOccupancyField, describeOccupancyField, quantizeOccupancyRes } from "./occupancyField.js";
import { fitPrimitive } from "./primitiveFit.js";
import { describeGrid } from "./instanceGrid.js";
import { BRICK_AXIS_BY_QUALITY, describeSparseField } from "./sparseField.js";
import { UI_LAYER } from "../../engine/editorLayers.js";
import { GICascadeLight, MAX_EMITTERS, giRoughnessBucketOf, registerGILight } from "./giLight.js";
import { buildBvhScene } from "./bvh/bvhScene.js";
import { RayHitMode, rayHitModeName, resolveRayHitConfig } from "./rayHit/RayHitConfig.js";
import {
  DETAIL_SLOTS,
  MAX_ATLAS_LAYERS,
  MAX_INSTANCE_SLOTS,
  MAX_MESH_SDF_SLOTS,
  SlotRegistry,
  SLOTS_PER_LAYER,
  geometryContentHash,
  instanceCapacityFor,
  slotKeyOf,
} from "./slotRegistry.js";
const FINGERPRINT_INTERVAL_FRAMES = 5;
// Hard floor between scene-sync scans. Editor drags emit change events every
// frame, and each poke used to force a full scan (mesh traverse + material
// resolve + hash) per frame — the "CPU spikes while moving" report. Moving
// needs NO scan at all (transforms are the per-frame uniform path); scans
// only exist for add/remove/material/geometry changes.
const FINGERPRINT_MIN_INTERVAL_MS = 250;
// MeshComponents attach with placeholder boxes and swap authored assets in
// asynchronously. Wait for the final completion burst to stay quiet before
// compiling GI, otherwise auto-fit measures placeholders and immediately
// triggers a second full compile wave when the real geometry lands.
const ASSET_LOAD_STABLE_MS = 250;
const ASSET_LOAD_TIMEOUT_MS = 30_000;
// Frames a resize's outgoing resolve targets stay alive before being destroyed
// (see #retireTargets). Two would do — the third is slack for a frame that is
// dropped or re-encoded.
const RETIRED_TARGET_FRAMES = 3;
/**
 * Frames a mover's occupancy slot stays DYNAMIC after its last transform
 * change before demoting back to STATIC (see occupancyField's split note).
 * Each promotion/demotion costs one full re-voxelize (the snapshot must be
 * retaken), so this is hysteresis against stop-start animations — ~1.5s at
 * 60fps. While dynamic-but-still the slot costs nothing (no dirty marks →
 * passes() doesn't run).
 */
const OCC_DYNAMIC_QUIET_FRAMES = 90;
/**
 * CONVERGED-IDLE SLEEP (run-gi-perf.mjs, 2026-08-03: the full pipeline at
 * rest is ~2.3ms GPU at ultra — feedback ~1.4, transport ~0.8 — recomputing
 * a field that converged long ago). When every FIELD input has been
 * bit-identical for GI_IDLE_AFTER_FRAMES (no composite, no light/emitter/sky
 * change — see #fieldInputHash), the per-frame queue drops to the RESOLVE
 * alone (which is camera-dependent and stays live, ~0.07ms). Any input
 * change wakes the full queue the SAME tick — zero added latency — and a
 * 1-in-GI_IDLE_HEARTBEAT_FRAMES full run backstops changes the hash cannot
 * see (e.g. an animated emissive texture's content). 180 frames ≈ well past
 * probe-EMA convergence at the default smoothing, so nothing visible moves
 * at the moment sleep begins. `__giNoIdleSleep = true` disables (A/B).
 */
const GI_IDLE_AFTER_FRAMES = 180;
const GI_IDLE_HEARTBEAT_FRAMES = 30;
/**
 * Frames after a build during which the feedback/trace CHECKERBOARDS are
 * suspended (see #tick). A checker's skipped half keeps whatever its buffer
 * already holds, and a fresh buffer holds zeros — for a cascade ray that
 * decodes as "hit at distance 0, radiance black", so half the lattice would
 * read as solid dark until its parity came round.
 */
const CHECKER_WARMUP_FRAMES = 8;

// ── ASYNC COMPUTE PIPELINES — the computes' missing `isReady` ────────────────
// three creates every compute pipeline with the SYNC device call, and Chrome's
// GPU process serves creates and submits on ONE wire thread — so a single big
// kernel stalls every submit and every in-flight async material compile behind
// it. Harness-measured 2026-08-02: the 782kB composite kernel cost ~27s of DXC
// on the wire, and the whole "materials preparation" startup hang was
// everything else queueing behind it. The render path already has the answer
// (Pipelines.isReady → skip the draw until the async compile lands); this
// installs the same semantics for computes:
//   · creation is redirected to createComputePipelineAsync (driver threads);
//   · a dispatch whose pipeline hasn't resolved is SKIPPED, not crashed into;
//   · skipped GI dispatches are re-run in order by GISystem (`giCompute`
//     marks them — the composite chain is order-dependent, so GISystem
//     re-queues the WHOLE batch via its dirty flags);
//   · skipped non-GI dispatches (a particles INIT pass is a one-shot — losing
//     it breaks the sim) are replayed per node when their pipeline resolves.
let giDispatchDepth = 0;
const giSkippedComputes = new Set();
const giPendingComputePipelines = new Set();

/** Dispatch wrapper for GISystem's own renderer.compute calls — marks skips
 *  as GI-owned so they take the ordered-retry path, not the replay path. */
function giCompute(renderer, nodes) {
  giDispatchDepth++;
  try {
    renderer.compute(nodes);
  } finally {
    giDispatchDepth--;
  }
}

function installAsyncComputePipelines(renderer) {
  const backend = renderer?.backend;
  const device = backend?.device;
  if (!backend || typeof device?.createComputePipelineAsync !== "function") return;
  if (backend.__giAsyncComputePipelines) return;
  backend.__giAsyncComputePipelines = true;
  const rawCreate = backend.createComputePipeline;
  const rawCompute = backend.compute;
  backend.createComputePipeline = function (computePipeline, bindings) {
    // three's pipeline-utils body does all the descriptor/layout work and ends
    // in `device.createComputePipeline(desc)` — intercept just that call.
    const rawDeviceCreate = device.createComputePipeline;
    device.createComputePipeline = (descriptor) => {
      const promise = device.createComputePipelineAsync(descriptor).then(
        (pipelineGPU) => {
          const data = backend.get(computePipeline);
          data.pipeline = pipelineGPU;
          const replay = data.giReplayNodes;
          if (replay?.size) {
            data.giReplayNodes = null;
            for (const node of replay) renderer.compute(node);
          }
        },
        (error) =>
          console.warn(
            `[gi] compute pipeline "${descriptor?.label ?? ""}" failed to compile:`,
            error?.message ?? error,
          ),
      );
      const tracked = promise.finally(() => giPendingComputePipelines.delete(tracked));
      giPendingComputePipelines.add(tracked);
      return null; // not ready — the dispatch guard below skips it meanwhile
    };
    try {
      rawCreate.call(this, computePipeline, bindings);
    } finally {
      device.createComputePipeline = rawDeviceCreate;
    }
  };
  backend.compute = function (computeGroup, computeNode, bindings, pipeline, dispatchSize) {
    const data = this.get(pipeline);
    if (!data.pipeline) {
      if (giDispatchDepth > 0) giSkippedComputes.add(computeNode);
      else (data.giReplayNodes ??= new Set()).add(computeNode);
      return;
    }
    return rawCompute.call(this, computeGroup, computeNode, bindings, pipeline, dispatchSize);
  };
}

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
  // ROOM DETECTION applies to fitted primitives too — see the note below.
  const hollowOf = () => geometryNormalsInverted(geometry) !== (material?.side === THREE.BackSide);
  if (!params) {
    // IMPORTED geometry has no construction parameters, so everything from a
    // GLB used to fall back to a baked grid — including the flat walls and
    // banners that the grid cannot represent at all (see primitiveFit.js).
    // Recover the shape from the vertices instead; a hit here is exact at any
    // volume size, which is the whole point.
    const fitted = fitPrimitive(geometry);
    return fitted ? { ...fitted, hollow: hollowOf() } : null;
  }
  // ROOM DETECTION: a primitive whose rendered faces point INWARD (flipped
  // normals, or BackSide material) is a room/enclosure, not a solid prop.
  // Treating it as a SOLID SDF makes its entire interior read distance 0 —
  // every shadow/cascade ray inside is instantly "occluded" and light only
  // survives within the emitter's self-exclusion sphere (the user's "light
  // has a hard radius" bug). Inverted primitives get HOLLOW SHELL distance
  // (|signed|) instead: walls still seal, the interior is open space.
  const hollow = hollowOf();
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
/**
 * Effective (inherited) visibility — `object.visible` AND every ancestor's.
 *
 * three's renderer stops descending at the first invisible object, so a light
 * parented under a disabled entity is simply never collected into the render
 * lights. `Object3D.traverse` does NOT stop there: it walks the whole subtree,
 * and the light's own `.visible` is still `true` (the engine hides an entity by
 * clearing the flag on the ENTITY's object3D — see Engine.js's per-frame
 * enabledInEditor/enabledInGame resolve; LightComponent only touches
 * `light.visible` for its own component-level toggle).
 *
 * Reading the flag alone therefore let a light the user had switched off keep
 * injecting its full analytic direct term into the GI field every frame: three
 * drew nothing, but the cascades still bounced a sun nobody could see. That is
 * the "even with the directional light disabled the corners stay lit" report —
 * only the indirect term survived, which is exactly why it looked like a leak
 * (dim, and tinted by whatever the bounce came off).
 *
 * `#collectMeshes` already prunes correctly (it recurses by hand and returns
 * early on an invisible node, skipping the subtree); this is the light path
 * catching up.
 */
function isRenderVisible(object) {
  for (let node = object; node; node = node.parent) {
    if (node.visible === false) return false;
  }
  return true;
}

/**
 * World AABB of a mesh, INCLUDING every instance of an InstancedMesh.
 *
 * `geometry.boundingBox` describes one instance sitting at the origin of the
 * mesh's local space, so using it for an InstancedMesh measures the prototype
 * rather than the scatter — a forest would fit a volume around one tree.
 * three keeps the instance-aware box on the mesh itself (`mesh.boundingBox`,
 * still local space), which is what this reaches for first.
 *
 * Writes into `target` and returns it, or null when there is nothing to
 * measure.
 */
function meshWorldBox(mesh, target = new THREE.Box3()) {
  if (mesh.isInstancedMesh) {
    if (!mesh.boundingBox) mesh.computeBoundingBox();
    if (!mesh.boundingBox || mesh.boundingBox.isEmpty()) return null;
    return target.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
  }
  if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox();
  const box = mesh.geometry?.boundingBox;
  if (!box || box.isEmpty()) return null;
  return target.copy(box).applyMatrix4(mesh.matrixWorld);
}

/**
 * Instances of ONE InstancedMesh that may claim atlas slots.
 *
 * The cap is per mesh, not per scene, so one 20k-instance grass field cannot
 * eat the whole instance budget and starve the building it grows around. Over
 * the cap the first N instances seat and the rest are reported — dropped from
 * the FIELD only; they still render, and they still receive GI, because
 * receiving is a per-pixel lookup that needs no slot.
 */
const MAX_INSTANCES_PER_MESH = 256;

/**
 * Identity of a baked distance grid: the bake cache's key AND the atlas
 * tile's. Two placements that agree here share one tile and one bake, which
 * is the whole instancing win, so this must be derived in exactly one place —
 * the build's atlas SIZING and the per-entry seating both call it.
 *
 * `assetPath@version` when the geometry came from an asset (stable across
 * sessions, so the Library cache hits cold), a content hash otherwise. The
 * resolution tag keeps a cached 64³ grid from satisfying a 128³ want.
 */
function contentKeyOf(geometry, hiRes) {
  const assetPath = geometry?.userData?.assetPath ?? null;
  const version = geometry?.attributes?.position?.version ?? 0;
  const base = assetPath ? `${assetPath}@${version}` : `sdf#${geometryContentHash(geometry)}`;
  return base + (hiRes ? "@r128" : "");
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
const QUALITY_TIERS = new Set(["low", "medium", "high", "ultra"]);

// Per-probe temporal EMA toward each frame's freshly integrated irradiance
// (createProbeIrradiance). 1 = off. Geometry is static and only light moves, so
// this changes NOTHING about a settled image — it only stops the probe lattice
// from popping in blocks while a light sweeps, which is the "flickers like a
// bulb shorting out" report. Lag at 0.35 is ~5 frames.
const DEFAULT_PROBE_SMOOTHING = 0.35;
const clampProbeSmoothing = (value) =>
  Math.min(1, Math.max(0.02, Number.isFinite(value) ? value : DEFAULT_PROBE_SMOOTHING));

/**
 * The TIER a quality preset selects for — every lookup keyed by preset name
 * (budget tables, trace-step budgets, the mesh-SDF detail-slot budget, the
 * exact-reflections default gate) reads through this, never `props.quality`
 * directly. "custom" (set by the Inspector when an advanced GI field is
 * edited directly — see InspectorPanel's `flipsToCustom`) means "the preset
 * name no longer implies values", not "no tier": every one of those lookups
 * still needs SOME tier to key off of, and "high" is the least surprising
 * choice — it's also this component's own zero-setup default. An unset or
 * unrecognized value (old scene data, a future typo) falls back the same
 * way. Numeric props already read directly off `props` (voxelSize,
 * probeSpacing, cascadeCount, c0DirRes, …) are untouched by this — "custom"
 * only changes what the PRESET NAME implies, not values authored explicitly.
 */
function qualityTierOf(props) {
  const quality = props?.quality;
  return QUALITY_TIERS.has(quality) ? quality : "high";
}

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
    if (
      key === "intensity" ||
      key === "bounce" ||
      key === "bleedSaturation" ||
      key === "temporalBlend" ||
      key === "probeSmoothing" ||
      key === "skyColor" ||
      key === "skyIntensity" ||
      key === "enabled"
    ) {
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
      // The fine level allocates textures and changes every trace's compiled
      // graph, so it can only change on a REBUILD. Leaving it out is the
      // `exactReflections` bug: the Inspector toggle appears to do nothing
      // until some unrelated edit happens to force a rebuild.
      p.sparseField,
      // `exactReflections` decides whether `light.bvhReflectTexture` /
      // `bvhReflectColorTexture` are set, and giLight compiles a DIFFERENT
      // mirror path depending on that — so it is structural in exactly the
      // same way `sparseField` is. This was the actual `exactReflections`
      // bug the comment above names: the toggle flipped the prop, nothing
      // rebuilt, and the Inspector switch silently did nothing until some
      // unrelated edit happened to force a rebuild — which also made every
      // A/B evaluation of exact reflections untrustworthy.
      p.exactReflections,
      // The backend decides which trace graph every GI shader compiles, so it
      // cannot change without a rebuild. (`killSdf` used to sit beside it —
      // the prop is gone; SDF-free is the only mode.)
      p.backend,
      p.rayHitMode,
      p.rayHitProfiling === true,
      // The Phase-5 coarse-skip A/B compiles different trace variants, so
      // flipping it without a rebuild would silently do nothing (the
      // exactReflections lesson above).
      p.rayHitSkipDistance !== false,
      // AO compiles the resolve's obscurance block (and its pyramid binding)
      // in or out — structural for the same reason exactReflections is.
      p.ao !== false,
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
      // Instance-aware: an InstancedMesh's world box has to span the whole
      // scatter, not the prototype sitting at its local origin.
      const box = meshWorldBox(mesh, new THREE.Box3());
      if (box && !box.isEmpty()) boxes.push(box);
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
      // MANUAL RECURSION, not `traverse` — the visibility test has to PRUNE.
      // `Object3D.traverse` walks the whole subtree and a `return` in its
      // callback only skips that one node, so a hidden GROUP's meshes were
      // still measured: every disabled entity in the scene kept inflating the
      // auto-fit box. That is not cosmetic — the quality presets are fixed
      // voxel/probe BUDGETS, so a box stretched around geometry nobody can
      // see makes the cells coarser everywhere, and once cells exceed half a
      // wall's thickness the field stops being able to keep that wall's two
      // faces apart and indirect light passes straight through it. Same
      // traverse-doesn't-prune bug as `#collectLightObjects` had; the mesh
      // collector in `#collectMeshes` always recursed by hand and was right.
      const visit = (child) => {
        // A mesh folded into an automatic batch is hidden but still renders (as
        // an instance of a scene-root proxy GI deliberately skips), so its own
        // `visible` flag must not exclude it here — see engine/batching.js.
        // Same camera-independence rule as #collectMeshes: auto-fit bounds
        // must not breathe as LOD/occlusion hide things off-screen.
        if (child.visible === false && !child.userData.batchedInto && !child.userData.cameraHidden) return;
        const skip =
          !child.isMesh ||
          child.userData.__giDebug ||
          ((child.layers.mask >>> 0) & 0x80000000) !== 0 || // editor-only helpers
          child.layers.isEnabled(UI_LAYER) || // HUD quads are not world geometry
          !child.geometry?.attributes?.position;
        if (!skip && meshWorldBox(child, scratch)) union.union(scratch);
        for (const grandchild of child.children) visit(grandchild);
      };
      visit(root);
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
    const budget = QUALITY_BUDGETS[qualityTierOf(this.component?.props)];
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
    this.component = null;
  }

  /** Explicit diagnostic readback; never called from the frame path. */
  async readRayHitStats(renderer = this.engine.renderer) {
    const debug = this.state?.volume?.occupancyField?.rayHitDebug;
    return debug && renderer ? debug.readback(renderer) : null;
  }

  // -------------------------------------------------------------------------

  #tick() {
    const component = this.component;
    if (!component || !component.enabled) return;
    const renderer = this.engine.renderer;
    if (!renderer) return;
    registerGILight(renderer);
    // Must be live before the FIRST build's dispatches — the build happens
    // inside this tick, and its kernels are the big ones.
    installAsyncComputePipelines(renderer);
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

    // Re-read LIVE, not captured at build: the prop is not structural (nothing
    // in a shader depends on it), so toggling it in the inspector must take
    // effect without a rebuild.
    state.peakSplit = component.props.peakSplit !== false;
    // Analytic lights AND promoted emissive emitters are per-frame uniforms
    // — moving either re-lights the field this same frame, no bake involved.
    this.#updateLightUniforms();
    // Live hatch: console-set flag → uniform, effective the same frame.
    if (state.fieldShadowOff) {
      state.fieldShadowOff.value = globalThis.__giNoFieldShadows === true ? 1 : 0;
    }
    // Shadow-ray uniforms, live: `__giSunAngle` tunes the ANALYTIC penumbra
    // softness (radians, default 0.025); `__giSunJitter` (radians, default 0
    // = OFF) enables the stochastic dither cone — off because any stochastic
    // term flickers under a static light unless Light Smoothing integrates it.
    if (state.shadowJitter) {
      state.shadowJitter.frame.value = this._frame % 4096;
      state.shadowJitter.angle.value =
        globalThis.__giNoJitter === true ? 0 : globalThis.__giSunJitter ?? 0;
      state.shadowJitter.penAngle.value = globalThis.__giSunAngle ?? 0.025;
    }
    // Receiver-gather surface bias (fractions of a probe cell — normal and
    // toward-camera components, see cascadeGather.gatherBias). Defaults
    // 0.5/0.5: user-eye-tuned on their Sponza (2026-08-03) as the closest
    // match to the Blender reference for curved receivers. `__giGatherBias`
    // / `__giGatherViewBias` remain live console overrides; 0/0 restores the
    // unbiased cage.
    gatherBias.value = globalThis.__giGatherBias ?? 0.5;
    gatherViewBias.value = globalThis.__giGatherViewBias ?? 0.5;
    // Adaptive-hysteresis snap alpha (cascadeGather.probeSnapAlpha); 0 = the
    // old fixed-alpha EMA.
    probeSnapAlpha.value = globalThis.__giProbeSnap ?? 0.35;
    // Visibility-integrator blend (depth moments + openness EMA — Phase 2);
    // 1 = no temporal integration (this frame only), the churn A/B arm.
    depthMomentsAlpha.value = globalThis.__giDepthAlpha ?? 0.12;
    // Field-side radiance EMA retain weight (GI_FLICKER_PLAN.md Phase 1);
    // default 0.95, user-confirmed live; 0 = off (pre-Phase-1 behaviour).
    // Squared under the peak split — the feedback runs every other frame there,
    // so the per-RUN retain has to cover two frames to leave the time constant
    // (and therefore the light response) where it was. See #peakSplitActive.
    if (state.fieldSmoothing) {
      const baseSmoothing = globalThis.__giFieldSmoothing ?? 0.95;
      state.fieldSmoothing.value = this.#peakSplitActive(state) ? baseSmoothing * baseSmoothing : baseSmoothing;
    }
    // Checker parity: which half of the cells this frame's feedback updates,
    // or -1 for "every cell". Default follows the preset (on at low/medium);
    // `__giFeedbackChecker` true/false overrides it live — the A/B that
    // decides whether high/ultra should adopt it too.
    // WARM-UP: both checkers leave the untouched half holding whatever the
    // buffer already had, and a freshly built buffer holds ZEROS — which for
    // a cascade ray reads as "hit at t=0, black", not as "no data". So run
    // every row for the first few frames after a build, then start
    // alternating. (Cheap: it is a handful of frames, once per rebuild.)
    this._framesSinceBuild = (this._framesSinceBuild ?? 0) + 1;
    const checkersWarm = this._framesSinceBuild > CHECKER_WARMUP_FRAMES;
    if (state.feedbackParity) {
      const want = (globalThis.__giFeedbackChecker ?? this._feedbackCheckerDefault) && checkersWarm;
      state.feedbackParity.value = want ? this._frame % 2 : -1;
    }
    // Cascade-trace checkerboard — same mechanism, applied to the other half
    // of the awake cost. Opt-in (`__giTraceChecker`) until it has an eye-check.
    if (state.traceParity) {
      const want = globalThis.__giTraceChecker === true && checkersWarm;
      state.traceParity.value = want ? this._frame % 2 : -1;
    }
    this.#refreshEmitterSlots();
    // Slot transforms track live matrices — dragging a mesh updates its
    // uniforms here, which bumps the atlas revision and re-runs the
    // composite below. That IS the whole cost of moving scene geometry.
    state.atlas.refreshTransforms();
    // Same contract for the exact-reflection BVH scene (GI Phase 3 v1): a
    // moving mesh is a per-mesh uniform update, never a buffer rebuild.
    state.bvhScene?.refreshTransforms();
    // And for the occupancy pyramid: matrices only. Its triangle buffers and
    // work list are rotation/translation invariant by construction, so a drag
    // never touches them — see #buildOccupancyField.
    this.#refreshOccupancyTransforms(state.volume.occupancyField);
    // The deferred resolve reads THIS frame's gbuffer, so the prepass renders
    // before any compute is dispatched. It is a nested render (one override
    // material, editor layers excluded) that restores renderer state.
    if (state.screen) {
      this.#syncScreenResolveSize(state);
      if (state.screen.radiance?.cameraPosition) {
        this.engine.camera.getWorldPosition(state.screen.radiance.cameraPosition.value);
      }
      // The mirror-mask second pass is only worth its projection walk when
      // something will actually read the mask — i.e. when the sparse exact
      // prepass is about to run. Without exact reflections the gbuffer's
      // normal.w stays 0 everywhere, exactly as before this existed.
      const wantsMirrorMask = !!state.screen.bvhReflect && this.#bvhReflectionsEnabled() && this.#bvhMaskEnabled();
      renderGiGBuffer(renderer, this.engine.scene, this.engine.camera, state.screen.gbuffer, {
        mirrorMask: wantsMirrorMask,
      });
      // BVH exact-reflection prepass: dispatched right after the gbuffer,
      // EVERY frame it's enabled — independent of the atlas-revision
      // composite gating above/below (that gating is about the SDF field
      // re-converging; this pass just re-traces the current gbuffer against
      // the current BVH transforms, which are already live-updated). The
      // `__giNoBvhReflections` hatch is re-checked here too (not just at
      // build time) so flipping it live stops the GPU cost immediately,
      // even though the material-side compile-time switch only takes full
      // effect on the next rebuild/sync (see `#syncBvhScene`).
      if (state.screen.bvhReflect && this.#bvhReflectionsEnabled()) {
        this.engine.camera.getWorldPosition(this._bvhCameraPosition.value);
        giCompute(renderer, state.screen.bvhReflect.compute);
      }
      // GPU atlas blit for tiles the CPU canvas path in bvhScene.js could
      // never draw (KTX2/Basis-compressed material maps — see
      // buildAlbedoAtlas's own comment): deferred to here rather than run
      // inside #syncBvhScene itself, because that can fire off the render
      // loop (a mesh add/remove triggers it synchronously) and this needs a
      // live renderer mid-frame, exactly like renderGiGBuffer's own nested
      // render just above. Self-guarding (see blitBvhAtlasTiles's own
      // comment) — cheap to call every tick, only does real work once per
      // bvhScene build.
      if (state.bvhScene?.pendingGpuTiles?.length) {
        const blitted = blitBvhAtlasTiles(renderer, state.bvhScene);
        if (blitted > 0) {
          console.log(`[gi] bvh: atlas gpu-blit: ${blitted} compressed tiles`);
        }
      }
    }
    // FEEDBACK RATE — REGULAR, NOT MERELY "AT MOST EVERY FRAME".
    //
    // The bounce feedback is a fixed-point iteration: each run reads the last
    // merged field and folds one more bounce of energy into the radiance the
    // cascades trace. So the level you SEE depends on how many iterations ran
    // since the light last changed, and a jittering iteration rate is a
    // jittering brightness.
    //
    // It used to be `feedbackEveryFrame || frame % 2 === 0`, decided against a
    // free-running counter, while the composite branch below ran the FULL
    // queue (feedback included) unconditionally. At low/medium that produced
    // an IRREGULAR cadence the moment anything moved — a composite frame ran
    // feedback, and if the next frame was even it ran feedback again, then a
    // quiet frame ran none: 2 iterations, then 0, then 1. With `bounce`
    // defaulting to 1 each iteration adds a visible amount of indirect light,
    // so the scene pulsed in step with that pattern for as long as the light
    // kept moving — and only at low/medium, because high/ultra iterate exactly
    // once per frame by construction.
    //
    // The fix is to gate on frames since the LAST ACTUAL RUN, and to let the
    // composite branch honour the same decision, so the cadence is exactly
    // 1-in-1 or exactly 1-in-2 and never alternates between them.
    const legacyRate = globalThis.__giLegacyFeedbackRate === true;
    const everyFrame = state.feedbackEveryFrame || globalThis.__giFeedbackEveryFrame === true;
    const runFeedback = legacyRate
      ? state.feedbackEveryFrame || this._frame % 2 === 0
      : everyFrame || (this._framesSinceFeedback ?? 1) >= 1;
    this._framesSinceFeedback = runFeedback ? 0 : (this._framesSinceFeedback ?? 0) + 1;
    // PEAK SPLIT (see the queueFeedbackOnly note in #build): the awake cost is
    // two independent halves of a ping-pong, so alternate them by FRAME PARITY
    // — peak per frame becomes the larger half instead of the sum, and the
    // average halves with it. Off under the legacy-rate hatch, which owns the
    // cadence for diagnostic purposes.
    const peakSplit = this.#peakSplitActive(state);
    let rateQueue = runFeedback ? state.queue : state.queueNoFeedback;
    if (peakSplit) rateQueue = this._frame % 2 === 0 ? state.queueFeedbackOnly : state.queueNoFeedback;
    // STAGE FREEZE (`__giFreeze`) — bisects the GI pipeline when every
    // individual term has been ruled out and the flicker is still there.
    // The pipeline is: feedback (writes the radiance field) → cascade traces →
    // merges → probe irradiance → screen resolve. Freezing a prefix means
    // everything upstream of the cut stops updating, so the image goes STATIC
    // with respect to the light — that is expected and not the thing to judge.
    // The only question is whether the FLICKER survives the cut:
    //   "field"     — field frozen, transport + resolve live.
    //   "transport" — field, cascades and probes frozen; only the resolve runs.
    //   "all"       — nothing recomputes; the GI texture is whatever it was.
    // Flicker that survives "all" is not GI compute at all (look at the
    // gbuffer/resolve targets); flicker that dies at "field" is the direct
    // injection; flicker that dies at "transport" is the cascades or the merge.
    //   "traces"    — feedback + cascade traces only (merges/probes frozen).
    //   "merges"    — the above + the merges (probe integration frozen).
    // Those two split the transport bucket, which the 2026-08-03 perf run
    // showed is the LARGEST part of the awake cost — "transport" as one
    // number could not say whether to attack rays, merges or probes.
    const freeze = globalThis.__giFreeze;
    const resolveCompute = state.screen?.resolve?.compute ?? null;
    const upTo = (mark) =>
      resolveCompute ? [...state.queue.slice(0, mark), resolveCompute] : state.queue.slice(0, mark);
    if (freeze === "field") rateQueue = state.queueNoFeedback;
    else if (freeze === "transport") rateQueue = resolveCompute ? [resolveCompute] : [];
    else if (freeze === "traces" && state.queueMarks) rateQueue = upTo(state.queueMarks.tracesEnd);
    else if (freeze === "merges" && state.queueMarks) rateQueue = upTo(state.queueMarks.mergesEnd);
    else if (freeze === "all") rateQueue = [];
    // Probe-average computes exist for the gizmos alone — only pay for
    // them while a probe debug view is actually open.
    const debugMode = component.props.debugProbes;
    const debugExtra =
      debugMode === "raw" || debugMode === "merged" ? state.debugComputes : [];
    let frameQueue = debugExtra.length ? [...rateQueue, ...debugExtra] : rateQueue;
    // Converged-idle sleep (see GI_IDLE_AFTER_FRAMES): count frames of
    // bit-identical field input. The composite branch below resets the count
    // — any geometry/atlas change is by definition not quiet.
    const inputHash = this.#fieldInputHash();
    if (inputHash !== this._fieldInputSeen) {
      this._fieldInputSeen = inputHash;
      this._fieldQuietFrames = 0;
    } else {
      this._fieldQuietFrames = (this._fieldQuietFrames ?? 0) + 1;
    }
    // WHAT MAKES THE FIELD STALE — three signals, not one.
    //
    // The atlas revision alone was enough only while every scene change also
    // produced a mesh-SDF arrival. It does not cover:
    //   · the occupancy pyramid being re-voxelized (a changed MESH SET — see
    //     #refreshOccupancyContent; `geometryRevision` deliberately ignores
    //     per-frame transform updates, which the revision path already covers);
    //   · the very first frame after a build, when SDF-free means no bake will
    //     ever arrive to bump anything. That case is the reported "relaunch
    //     with SDF-free and there is no GI at all, just black": the composite
    //     never ran, so no cell was ever marked occupied, so nothing bounced.
    const occGeometryRevision = state.volume.occupancyField?.geometryRevision ?? 0;
    if (
      this._atlasRevisionSeen !== state.atlas.revision ||
      this._occGeometrySeen !== occGeometryRevision ||
      !this._compositedOnce
    ) {
      // FLICKER DIAGNOSTIC (`__giLogComposite`). A composite is supposed to be
      // RARE — it runs when geometry changed, and it has a one-frame window
      // where the pyramid is stale (see the OCCUPANCY FIRST note below), which
      // the module's own comment describes as reading like flicker. If this
      // reports a steady non-zero rate on a scene where only a LIGHT moves,
      // something is bumping a revision it shouldn't and that cadence IS the
      // flicker. Also records WHICH of the three triggers fired.
      if (globalThis.__giLogComposite) {
        this._compositeCount = (this._compositeCount ?? 0) + 1;
        this._compositeWhy = this._compositeWhy ?? { atlas: 0, occ: 0, first: 0 };
        if (this._atlasRevisionSeen !== state.atlas.revision) this._compositeWhy.atlas++;
        else if (this._occGeometrySeen !== occGeometryRevision) this._compositeWhy.occ++;
        else this._compositeWhy.first++;
      }
      // Whole-volume triggers, decided BEFORE the gates are consumed: a
      // re-voxelized pyramid (occ revision) invalidates EVERY cell, and so
      // does a first composite or a retry after skipped dispatches — see the
      // dirty-consumption note below.
      // A composite frame is never quiet — geometry or the atlas moved.
      this._fieldQuietFrames = 0;
      const wholeVolume =
        this._occGeometrySeen !== occGeometryRevision ||
        !this._compositedOnce ||
        this._forceWholeComposite === true;
      this._forceWholeComposite = false;
      this._atlasRevisionSeen = state.atlas.revision;
      this._occGeometrySeen = occGeometryRevision;
      this._compositedOnce = true;
      // Dirty-brick: recomposite only the union AABB of changed slots — the
      // SAME frame as the change. An every-3rd-frame throttle was tried here
      // and REVERTED: on heavy scenes it staggered moving shadows into a
      // visible judder and bunched the full-queue cost into spike frames
      // (user report), and the dirty brick already makes the per-frame
      // composite cheap. null dirty = whole volume (first build, refits, or
      // any bump without a mark — the fail-safe), mapped to the permissive
      // ±1e9 defaults. __giNoDirtyBrick forces whole-volume (A/B hatch);
      // still consume so stale bounds can't accumulate.
      // A DIRTY-BRICK COMPOSITE CAN PERMANENTLY MISS THE PYRAMID ARRIVING.
      // The boot sequence that shipped as "GI is dark until I move the
      // model": the first composite ran whole-volume against a pyramid whose
      // voxelize dispatches were still skipped (async pipeline compiles), so
      // every cell read empty — and every LATER composite was atlas-bumped
      // with a small dirty AABB, recompositing only that region. The rest of
      // the volume kept the empty boot result forever; moving the building
      // marked its whole AABB dirty, which is why a nudge "fixed" it
      // (probe-measured: 0.021 lum settled boot → 0.105 after a 1cm nudge).
      // So: consume the marks ALWAYS (stale bounds must not accumulate), but
      // ignore them in favour of whole-volume whenever the pyramid's content
      // changed, this is the first composite, or the previous batch had
      // skipped dispatches.
      const consumedDirty = state.atlas.consumeDirtyBounds();
      const dirty = wholeVolume ? null : consumedDirty;
      // TOP-LEVEL lists first: the composite reads them to decide which
      // slots a cell is allowed to skip, so they have to describe the same
      // slot state the composite is about to sample. Rebuilds only when a
      // slot actually moved (the same condition that got us into this
      // branch), and is a few thousand array writes when it does.
      state.volume.updateGrid();
      // FINE level re-paging. Order matters and is the same as the grid's:
      // the page table decides where bricks exist, the fill pass writes them,
      // and every trace reads both — so a stale page table is geometry in the
      // wrong place, not merely stale.
      state.volume.updateSparse();
      const world = state.volume.world;
      if (dirty && globalThis.__giNoDirtyBrick !== true) {
        world.dirtyMin.value.copy(dirty.min);
        world.dirtyMax.value.copy(dirty.max);
      } else {
        world.dirtyMin.value.set(-1e9, -1e9, -1e9);
        world.dirtyMax.value.set(1e9, 1e9, 1e9);
      }
      // The composite frame runs the SAME queue the rate decision above chose.
      // It used to force `state.queue` here on the grounds that a changed field
      // must re-converge without a frame of lag — but "one extra bounce
      // iteration, on the frames where something moved" is precisely the
      // irregular cadence that pulses the lighting (see the rate comment).
      // Trading one frame of bounce latency for a stable level is the right
      // way round: the DIRECT term is unaffected either way, and direct is what
      // the eye tracks when a light moves.
      // OCCUPANCY FIRST, and it has to be: the composite reads the pyramid to
      // force `occupied` where triangles pass, and every trace downstream reads
      // it as the hit test. A stale pyramid is not a stale distance — it is
      // geometry that is not there yet, which is a leak for exactly one frame
      // and reads as flicker.
      const occPasses = state.volume.occupancyField?.isDirty
        ? state.volume.occupancyField.passes()
        : null;
      const skippedBefore = giSkippedComputes.size;
      // THE SPAWN-BLINK GUARD (2026-08-04, run-gi-spawn-blink measured it):
      // a geometry change rebuilds the voxelizer's pair tables, so passes()
      // mints FRESH compute nodes whose pipelines compile async for a few
      // frames. Dispatching the ordered chain then executes the old,
      // already-compiled CLEAR and skips the new voxelize — and a composite
      // in the same batch reads that half-built pyramid as "empty
      // everywhere", which makes the feedback's empty-clear zero the
      // radiance field VOLUME-WIDE: the whole GI blinked black for ~6 frames
      // (field probe read literal 0.0). Two rules fix it: while ANY compute
      // pipeline is still compiling, do not dispatch the pyramid chain at
      // all (its half-execution is the damage); and if a dispatch DID skip
      // (the first tick is what triggers the new pipelines' compilation, so
      // it cannot know in advance), bail out BEFORE the composite consumes
      // the pyramid. Bail frames keep last-good staging/occupancy — the
      // feedback sees unchanged flags, so radiance persists instead of
      // clearing, and the EMA carries the couple of dim trace frames.
      const occWait = occPasses !== null && giPendingComputePipelines.size > 0;
      let occSkipped = false;
      if (occPasses && !occWait) {
        giCompute(renderer, occPasses);
        occSkipped = giSkippedComputes.size > skippedBefore;
      }
      if (occWait || occSkipped) {
        // Same re-arm the post-batch retry always used — but BEFORE anything
        // consumed the pyramid, which is the whole fix. Skipped dispatches
        // are near-free, so retrying until the pipelines land costs nothing.
        this._compositedOnce = false;
        state.volume.occupancyField?.invalidate();
        // The retry must NOT be narrowed by whatever small dirty AABB an
        // unrelated atlas touch queues meanwhile — see the dirty-consumption
        // note above.
        this._forceWholeComposite = true;
        giCompute(renderer, [
          ...(legacyRate && !freeze ? state.queue : rateQueue),
          ...debugExtra,
        ]);
      } else {
        giCompute(renderer, [
          // Inter-probe visibility (cascadeMerge's parent blind-annulus fix).
          // Pure geometry × lattice, so it belongs HERE and not in the
          // per-frame queue: it is recomputed exactly when the pyramid or the
          // volume can have changed, which is the same condition that got us
          // into this branch. Ordered after occPasses (prior submit, same
          // queue) because it reads the pyramid.
          // `__giNoVisUpdate` (live) stops DISPATCHING it while keeping the
          // buffer and every merge that reads it — the cost A/B that says how
          // much of a moving object's surcharge is this pass. Values go
          // stale, which is exactly what a throttle would do.
          ...(globalThis.__giNoVisUpdate === true ? [] : state.visComputes ?? []),
          state.volume.compositeCompute,
          // Fine level AFTER the coarse composite and BEFORE anything traces:
          // the bricks are the same min-over-candidates function at a sixth
          // of the cell size, so they depend on nothing the composite writes,
          // but every consumer downstream reads them.
          ...(state.volume.sparse?.computes ?? []),
          // `rateQueue` here, not `state.queue`, so a __giFreeze cut still
          // holds on a composite frame — otherwise the bisect silently leaks
          // the very stage it is meant to hold still.
          ...(legacyRate && !freeze ? state.queue : rateQueue),
          ...debugExtra,
        ]);
        if (giSkippedComputes.size > skippedBefore) {
          // vis/composite/sparse pipelines can still be compiling on the very
          // first builds — same re-arm, next tick retries the whole chain.
          this._compositedOnce = false;
          state.volume.occupancyField?.invalidate();
          this._forceWholeComposite = true;
        }
      }
      // Only after a tick whose chain actually ran to completion: on bail/
      // re-arm ticks (`_compositedOnce` false) the stats buffers may never
      // have been dispatched, and reading them back throws from deep inside
      // the frame loop (the user-reported "reading 'size'" uncaught promise).
      if (this._compositedOnce) this.#maybeLogStats(renderer);
    } else {
      // Cascades re-trace + re-merge EVERY frame — 1-frame response to any
      // field change, no temporal accumulation to converge.
      // IDLE SLEEP: with the field input quiet past the threshold, only the
      // camera-dependent resolve runs (plus any open debug view — its
      // computes read the frozen field, still correct). The heartbeat frame
      // runs the full queue. Not while a freeze bisect or the legacy-rate
      // hatch is active — those own the queue for diagnostic purposes.
      const idle =
        !freeze && !legacyRate &&
        globalThis.__giNoIdleSleep !== true &&
        // The opt-in stochastic dither needs per-frame integration — a
        // frozen field would hold one noise sample as a permanent pattern.
        !(state.shadowJitter?.angle?.value > 0) &&
        (this._fieldQuietFrames ?? 0) > GI_IDLE_AFTER_FRAMES &&
        this._frame % GI_IDLE_HEARTBEAT_FRAMES !== 0;
      if (idle) {
        frameQueue = state.screen?.resolve?.compute
          ? [state.screen.resolve.compute, ...debugExtra]
          : debugExtra;
      }
      // Guard the empty case: `__giFreeze = "all"` produces no computes, and
      // three's renderer.compute([]) throws "expects a ComputeNode".
      if (frameQueue.length) giCompute(renderer, frameQueue);
    }
    giSkippedComputes.clear();

    this._frame++;
    if (globalThis.__giLogComposite && this._frame % 120 === 0) {
      const why = this._compositeWhy ?? { atlas: 0, occ: 0, first: 0 };
      console.log(
        `[gi] per 120 frames — composites ${this._compositeCount ?? 0} ` +
          `(atlas ${why.atlas}, occupancy ${why.occ}, other ${why.first}), ` +
          `resolve resizes ${this._resolveResizes ?? 0} — both should be 0 when only a light moves`,
      );
      this._compositeCount = 0;
      this._resolveResizes = 0;
      this._compositeWhy = { atlas: 0, occ: 0, first: 0 };
    }
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
   * Holds a queued rebuild while model or mesh assets are still streaming in.
   * Building before authored geometry lands measures wrong auto-fit bounds, and the corrective
   * refit a few seconds later fires a SECOND full material-compile wave —
   * the user's ~40s startups were two back-to-back 20s waves. Waiting a few
   * frames for the loads costs nothing (there is no GI to lose yet) and
   * collapses startup to ONE wave. A timeout keeps a broken model file from
   * deferring GI forever.
   */
  #readyToRebuild() {
    let pendingModels = 0;
    let pendingMeshes = 0;
    for (const entity of this.engine.entities.values()) {
      const model = entity.getComponent?.("model");
      if (model?.props?.path && !model.root) {
        pendingModels++;
      }
      const mesh = entity.getComponent?.("mesh");
      if (mesh?.assetLoadsPending) pendingMeshes++;
    }
    const pending = pendingModels + pendingMeshes;
    const now = performance.now();
    if (!pending) {
      this._assetWaitStart = null;
      if (this._assetsReadySince == null) {
        this._assetsReadySince = now;
        return false;
      }
      if (now - this._assetsReadySince < ASSET_LOAD_STABLE_MS) return false;
      this._assetsReadySince = null;
      return true;
    }
    this._assetsReadySince = null;
    if (!this._assetWaitStart) {
      this._assetWaitStart = now;
      console.log(
        `[gi] build deferred — waiting for scene assets ` +
        `(${pendingMeshes} mesh, ${pendingModels} model; avoids a double compile wave)`,
      );
    }
    if (now - this._assetWaitStart < ASSET_LOAD_TIMEOUT_MS) return false;
    console.warn(
      `[gi] building despite unfinished scene assets after ${ASSET_LOAD_TIMEOUT_MS / 1000}s ` +
      `(${pendingMeshes} mesh, ${pendingModels} model) — a refit may follow`,
    );
    this._assetWaitStart = null;
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
    const pendingLight = state?.light?.parent !== engine.scene ? state?.light : null;
    const overrideOwnsCamera = [...(engine.renderOverrides ?? [])].some((override) => override.ownsCamera?.(engine));
    // The normal editor render path can stay fully live while the expensive
    // GI variants compile. Three's supported third compileAsync argument lets
    // the REAL scene provide render objects/cache identity while this tiny
    // target scene contributes the not-yet-live GI light and environment.
    // A postprocess-owned camera needs its real PassNode target/context and
    // therefore keeps the suspended fallback below.
    const backgroundCompile = !!pendingLight && !overrideOwnsCamera;
    const compileObjects = [];
    const compileTarget = backgroundCompile ? new THREE.Scene() : null;
    if (compileTarget) {
      compileTarget.background = engine.scene.background;
      compileTarget.environment = engine.scene.environment;
      compileTarget.environmentIntensity = engine.scene.environmentIntensity;
      compileTarget.environmentRotation.copy(engine.scene.environmentRotation);
      compileTarget.fog = engine.scene.fog;
      engine.scene.updateMatrixWorld(true);
      engine.scene.traverseVisible((object) => {
        if (object.isLight) {
          // A clone keeps the live light's bind groups owned by the live
          // render objects. Only the light TYPE/state matters to the shader
          // and pipeline cache warmed here.
          compileTarget.add(object.clone());
          return;
        }
        if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
        // compileAsync accepts an individual object plus a target scene. Keep
        // the imported object in its real hierarchy (some custom subclasses
        // cannot be shallow-cloned), while compileTarget gives its RenderObject
        // a separate scene/cache identity and therefore separate bind groups.
        compileObjects.push(object);
      });
    }
    if (pendingLight) {
      if (backgroundCompile) compileTarget.add(pendingLight);
      else engine.scene.add(pendingLight);
    }
    // Re-warm from scratch each wave — a wave exists because pipelines were
    // invalidated (new GI light state), so a previously warmed pass is stale.
    this._warmedScenePass = null;
    engine.renderSuspended = !backgroundCompile;
    // three's yieldToMain prefers scheduler.yield(), whose continuations
    // OUTRANK rendering in Chrome — the whole wave still starved rAF (a
    // single 12s frame gap, harness-measured). A macrotask yield lets the
    // browser interleave frames/input between compile chunks.
    const scheduler = globalThis.scheduler;
    const originalYield = scheduler?.yield;
    // TIME-BUDGETED YIELD — the whole wave cost lived here (harness-measured
    // 2026-08-02): three yields after every crumb of build work (per shader
    // stage per object), and every real macrotask yield waits out a full
    // frame of whatever else startup is doing (asset decodes, the chunked
    // field composite). 262 yields × ~230ms startup frames = 60s of a 62s
    // wave WAITING, on ~2s of actual JS build work. So: run the build in
    // ~40ms uninterrupted slices and only take a real macrotask yield
    // between slices — frames/input still interleave, but the wave stops
    // queueing behind itself a couple hundred times.
    const yieldStats = { count: 0, waited: 0, skipped: 0 };
    let lastRealYield = performance.now();
    if (originalYield)
      scheduler.yield = () => {
        if (performance.now() - lastRealYield < 40) {
          yieldStats.skipped++;
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          const tY = performance.now();
          setTimeout(() => {
            yieldStats.count++;
            yieldStats.waited += performance.now() - tY;
            lastRealYield = performance.now();
            resolve();
          }, 0);
        });
      };
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
    // BACKGROUND MODE TOO (2026-08-02, was suspended-only). Without the
    // interception, background mode awaited each object's pipeline promise
    // PER OBJECT — and those promises can only resolve when the GPU
    // process's completions get main-thread time, so the wave serialized
    // against its own busyness (harness-measured: a 42s wave whose driver
    // work overlapped into the last seconds). It is safe live because the
    // pipelines created here belong to the compile-target variants (GI
    // lights hash → different cache keys than anything the live scene
    // draws), and a live draw that DOES land on a still-compiling cache
    // entry is skipped by Pipelines.isReady — the same semantics as any
    // async compile. Only the compile path passes a promises array, so the
    // wrapper is inert for normal rendering.
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
    let compileSucceeded = false;
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
      const objTimings = [];
      if (!(await this.#warmOverridePass(renderer))) {
        if (backgroundCompile) {
          for (const object of compileObjects) {
            const tObj = performance.now();
            await renderer.compileAsync(object, engine.camera, compileTarget);
            objTimings.push({
              name: object.material?.name || object.material?.type || object.name || "?",
              ms: performance.now() - tObj,
            });
          }
        } else {
          await renderer.compileAsync(engine.scene, engine.camera);
        }
      }
      const tQueued = performance.now();
      // Every pipeline is now in flight on the driver's threads — this is the
      // only wait, and it costs the LONGEST compile, not their sum.
      const queued = inflight.length;
      if (queued > 0) await Promise.all(inflight);
      const t1 = performance.now();
      console.log(
        backgroundCompile
          ? `[gi] compile wave: materials warmed safely in ${(t1 - t0).toFixed(0)}ms while viewport remained live`
          : `[gi] compile wave: materials done in ${(t1 - t0).toFixed(0)}ms ` +
            `(node builds ${(tQueued - t0).toFixed(0)}ms, ${queued} pipelines compiled concurrently in ${(t1 - tQueued).toFixed(0)}ms)`,
      );
      // Prewarm every GI kernel. Creation is ASYNC (installAsyncComputePipelines
      // — driver threads, wire never stalls, frames keep flowing) and a
      // dispatch whose pipeline hasn't landed is skipped, so this loop's job
      // is to force creation early, wait out the compiles, then dispatch for
      // real so the first resumed frame finds everything warm AND the field
      // composited.
      if (state && this.state === state) {
        state.volume.updateGrid();
        state.volume.updateSparse();
        const computeNodes = [
          state.volume.compositeCompute,
          ...(state.volume.sparse?.computes ?? []),
          ...state.queue,
        ];
        const kernelSizes = [];
        for (const node of computeNodes) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (this.state !== state) break;
          giCompute(renderer, node);
          try {
            const wgsl = renderer._nodes?.getForCompute?.(node)?.computeShader;
            if (wgsl) kernelSizes.push(Math.round(wgsl.length / 1024));
          } catch {
            /* diagnostics only */
          }
        }
        // Ticks may have started compiles before this loop did — wait for the
        // whole in-flight set, including anything that joins meanwhile.
        if (giPendingComputePipelines.size) {
          const tPipe = performance.now();
          let waited = 0;
          while (giPendingComputePipelines.size) {
            waited += giPendingComputePipelines.size;
            await Promise.all([...giPendingComputePipelines]);
          }
          console.log(
            `[gi] ${waited} compute pipelines compiled concurrently in ` +
              `${(performance.now() - tPipe).toFixed(0)}ms (frames kept flowing)`,
          );
        }
        // The guarded dispatches above did no field work where a pipeline was
        // still compiling — dispatch each node for real now that every
        // pipeline resolved (all cache hits, no creates).
        if (this.state === state) {
          for (const node of computeNodes) giCompute(renderer, node);
        }
        if (kernelSizes.length) {
          console.log(
            `[gi] compute kernels: ${kernelSizes.length} totaling ${kernelSizes.reduce((s, n) => s + n, 0)}kB WGSL ` +
              `(sizes ${kernelSizes.join("/")}kB — [0] composite, then sparse, then the frame queue)`,
          );
        }
      }
      // The postprocess pipeline builds asynchronously (addon imports + graph
      // compile) and often becomes active DURING this wave. A PassNode always
      // compiles its bound real scene, so the temporary compile scene cannot
      // supply its GI light. Move the light to the real scene first and pause
      // only viewport rendering for this final async phase. The editor/event
      // loop remains live while Three yields between materials, and the first
      // resumed frame sees the exact pass+MRT variants that were warmed.
      const lateOverride = [...(engine.renderOverrides ?? [])].find((override) => override.ownsCamera?.(engine));
      if (backgroundCompile && pendingLight && lateOverride?.scenePass?.compileAsync) {
        engine.renderSuspended = true;
        engine.scene.add(pendingLight);
      }
      await this.#warmOverridePass(renderer);
      console.log(
        `[gi] compile wave: materials ${(t1 - t0).toFixed(0)}ms, computes ${(performance.now() - t1).toFixed(0)}ms ` +
          `(${backgroundCompile ? "viewport remained live" : "render suspended, app interactive"})`,
      );
      // A slow wave earns a breakdown in the log: how much was real JS work
      // vs waiting on the macrotask yields, and which objects paid the most.
      if (t1 - t0 > 3000) {
        console.log(
          `[gi] wave breakdown: ${yieldStats.count} real yields waited ${yieldStats.waited.toFixed(0)}ms ` +
            `(${yieldStats.skipped} skipped by the 40ms budget); ` +
            `slowest objects: ${objTimings
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 6)
              .map((o) => `${o.name} ${o.ms.toFixed(0)}ms`)
              .join(", ") || "(single scene compile)"}`,
        );
      }
      compileSucceeded = true;
    } catch (error) {
      console.warn("[gi] async compile wave failed; GI was not committed:", error?.stack ?? error?.message ?? error);
    } finally {
      if (originalYield) scheduler.yield = originalYield;
      if (originalGetForRender) pipelines.getForRender = originalGetForRender;
      if (this._compileToken === token) {
        // Moving the already-compiled light from the temporary scene to the
        // live scene is the commit point. The next render observes the new
        // lights hash and finds its material pipelines warm.
        if (compileSucceeded && pendingLight && pendingLight.parent !== engine.scene) engine.scene.add(pendingLight);
        engine.renderSuspended = false;
        // DIAGNOSTIC: if the first REAL frame after the wave still stalls,
        // the wave compiled for the wrong render path (a postprocess
        // override renders through PassNode targets whose cache context
        // differs) — the number tells us instantly.
        const tResume = performance.now();
        if (compileSucceeded) requestAnimationFrame(() =>
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
   * GI-TRACED DIRECT SHADOWS — the resolve-side bundle, or null when this
   * build cannot afford them. Everything about the feature that needs the
   * volume (the trace, its lift, its reach) is decided here, once.
   *
   * THE STEP BUDGET IS PER TIER, and this is not a tuning preference — it is
   * the bug the lost implementation's smoke caught. A shadow ray from a
   * receiver to the sun crosses the WHOLE volume, and the hierarchical march
   * takes its smallest steps exactly where it hugs geometry, so a ray threading
   * a building's interior burns its budget mid-wall. Running out is not
   * "slightly wrong": the trace's fail-closed clamp only fires where the last
   * sample was still near a surface, so an exhausted ray in a room reports
   * NOTHING BLOCKED ME and the interior renders blown white. 64 steps did that;
   * these budgets do not. (`__giDirectShadowSteps` overrides for an A/B.)
   *
   * TWO GATES, both about bindings rather than taste:
   *
   *  · STORAGE TEXTURES. The resolve already writes irradiance + emitterShadow
   *    + radiance, plus the BVH radiance target when exact reflections are on.
   *    This makes one more, which is the 4th or the 5th against a WebGPU
   *    BASELINE OF 4. The engine asks the adapter for 8 (see
   *    resolveRendererLimits), but the ask is adapter-clamped, so a
   *    baseline-only device really does land at 4 and must simply not get the
   *    feature — over the limit the pipeline is INVALID and every compute
   *    submitted with it is silently dropped, taking all of GI with it.
   *
   *  · STORAGE BUFFERS. The trace reads the occupancy pyramid, the composited
   *    distance texture and the atlas — the resolve is at the portable
   *    8-storage-buffer baseline and cannot take new ones. It is only provably
   *    free when the pass ALREADY carries a trace of the same family, i.e. when
   *    emitter shadows built `light.shadowTraceFn`: same resources, so the bind
   *    group is unchanged and only a second WGSL function appears. With
   *    `emissiveShadows` off there is no such trace and this one would add its
   *    own bindings to a pass whose real count we cannot measure without a GPU,
   *    so the honest answer is to decline. `__giLightShadowIgnoreBudget` forces
   *    it for a measurement run.
   */
  #buildLightShadow({ volume, lightSlots, quality, hasEmitterTrace, span }) {
    if (globalThis.__giNoLightShadows === true) return null;
    const occ = volume.occupancyField;
    // No pyramid, no feature: the lift is sized in occupancy voxels and the
    // trace's thin-wall block is the pyramid's. The SDF-only arm would leak
    // through anything thinner than a field cell, which for a sun shadow is
    // every floor in the scene.
    if (!occ?.voxel) return null;
    // The emitter-trace requirement is a SPHERE-ARM rule: that marcher reads
    // distanceTexture + atlas + staging + sparse and is only provably free
    // when the emitter trace already bound the same family. The DDA arm
    // reads ONLY the occupancy bits buffer — +1 storage buffer worst case,
    // +0 whenever AO or the emitter oracle already binds it — so it stands
    // alone. If a pathological config still over-commits the pass, the
    // failure is loud in the harness (the irradiance CONTROL collapses when
    // a batch drops) and `__giNoLightShadows` is the hatch.
    const sphereArm = globalThis.__giLightShadowSphere === true;
    if (!hasEmitterTrace && sphereArm && globalThis.__giLightShadowIgnoreBudget !== true) {
      if (!this._warnedLightShadowBudget) {
        this._warnedLightShadowBudget = true;
        console.warn(
          "[gi] gi-traced light shadows are off: the sphere arm needs the emitter trace's bindings " +
            "(Emissive Shadows is disabled). Re-enable it, drop __giLightShadowSphere, or set " +
            "__giLightShadowIgnoreBudget to measure anyway.",
        );
      }
      return null;
    }
    const limit = this.engine.renderer?.backend?.device?.limits?.maxStorageTexturesPerShaderStage ?? 0;
    const used = 3 + (this.#bvhReflectionsEnabled() ? 1 : 0);
    if (limit < used + 1) {
      if (!this._warnedLightShadowLimit) {
        this._warnedLightShadowLimit = true;
        console.warn(
          `[gi] gi-traced light shadows are off: this device allows ${limit} storage textures per stage and the ` +
            `resolve already writes ${used}. Lights with Shadow Source "gi" fall back to shadow maps.`,
        );
      }
      return null;
    }
    // PCSS wants ONE more storage texture (the blocker-distance channel). A
    // device that affords the shadow but not the distance keeps sharp shadows
    // — the dist texture exists but is never written, reads 0, radius 0.
    const pcss = limit >= used + 2;
    const steps =
      Number(globalThis.__giDirectShadowSteps) ||
      ({ low: 96, medium: 128, high: 160, ultra: 192 }[quality] ?? 160);
    // THE MARCHER DECISION, hoisted so the boot log can print it: "I set
    // Shadow Source to gi and the silhouettes are still voxel" is unreadable
    // without knowing which arm compiled. A mode change is structural, so
    // deciding here (build time) equals deciding inside the trace closure.
    const shadowMode = volume.rayHitMode ?? RayHitMode.OccupancyLegacy;
    const recordMarch =
      occ.traceHybridPlane &&
      occ.hasSurfaceRecords === true &&
      shadowMode >= RayHitMode.HybridPlane &&
      shadowMode <= RayHitMode.HybridExactComplex &&
      globalThis.__giLightShadowLegacyDda !== true;
    // 1.5 OCCUPANCY VOXELS of ray lift — a node, not a number, so an in-place
    // refit rescales it with the pyramid. See the resolve's own comment for
    // why the gather's normalOffset is the wrong scale here.
    const vox = vec3(occ.voxel);
    const voxMax = vox.x.max(vox.y).max(vox.z);
    const lift = voxMax.mul(1.5);
    return {
      marcher: globalThis.__giLightShadowSphere === true
        ? "sphere"
        : recordMarch
          ? `records (${rayHitModeName(shadowMode)})`
          : "voxel-dda",
      slots: lightSlots,
      lift,
      voxMax,
      span,
      pcss,
      steps,
      // BURIAL GATE INPUT (see the resolve's use). RECORD-AWARE is the load-
      // bearing word: the plain AABB oracle reads ~0 at every lifted origin
      // (the receiver's own surface voxels bulge up to a voxel above the true
      // surface), which would dim every floor in the scene — the record-aware
      // near field returns the TRUE distance to the fitted surface plane, so
      // an open-ground origin measures ≈ the full lift and stays untouched.
      // That is also why the gate only exists when records do: without them
      // (brick-box / legacy modes) it is null and the resolve compiles it out.
      freeRadius:
        occ.hasSurfaceRecords === true && occ.freeRadiusAtWorld
          ? (p) => occ.freeRadiusAtWorld(p, 1, true, null, true)
          : null,
      // THE MARCHER IS THE TRANSPORT DDA, NOT THE SPHERE TRACE. This is the
      // same retreat the FIELD's sun shadows already made (see the field
      // `lightShadow` closure): sphere-tracing the blurred field tunnels
      // through thin geometry and its occluder-admission thresholds flip
      // with voxel-lattice phase (rings, speckles, black states — three
      // rounds of threshold tuning moved the artifacts without removing
      // them), while the hierarchical DDA marches the SAME bits transport
      // rays march — it cannot tunnel, has no admission thresholds at all,
      // and its analytic cone accumulator (`pen`) fades a grazing ray
      // continuously before the binary hit flips. 64 steps with coarse-skip
      // crosses the volume; per-pixel cost beats 160 sphere steps.
      // `__giLightShadowSphere = true` restores the sphere arm (build-time).
      traceDda:
        globalThis.__giLightShadowSphere === true
          ? null
          : (origin, dir, maxT, k, receiverP = null) => {
              // tMin one voxel: the lifted origin can still clip its own
              // surface's SAT-bulged voxel on curved geometry, and a DDA
              // first-voxel hit is a hard black dot. One voxel along the ray
              // (on top of the 1.5-voxel normal lift) clears it; anything
              // thinner than that near the receiver is below the medium's
              // resolving power anyway.
              const vox = vec3(occ.voxel);
              const tMin = vox.x.max(vox.y).max(vox.z);
              // THE RECORD MARCH — the non-voxel shadow arm. When the active
              // ray-hit mode carries surface records, shadow rays resolve hits
              // through the SAME fitted planes (+ coverage clips, + exact
              // triangles on ultra) the gather uses: silhouettes follow the
              // recorded geometry at sub-voxel precision instead of the voxel
              // hull, and the cone estimate comes from perpendicular miss
              // distances to those planes rather than voxel free-radius.
              // `__giLightShadowLegacyDda = true` restores the binary-voxel
              // arm for an A/B (build-time, like every hatch here).
              // DynamicBrick cells resolve through the per-chain DYNAMIC
              // record tail (refit at the mover's pose every dispatch), so
              // movers keep fitted-plane silhouettes while moving. KNOWN
              // LIMITS (why a silhouette can still read voxel-true): static
              // cells sharing a mover's brick refit unfitted (box) until the
              // demote's full rebuild, tail overflow degrades that brick to
              // box, and COMPLEX-classified cells (curved stone, thin
              // double-face walls) only resolve to real triangles in
              // exact-complex mode.
              if (recordMarch) {
                // Tiered macro budget like the legacy arm — the cap only binds
                // on long grazing rays (the frames where shadow cost spikes),
                // and with the fail-closed clamp a capped ray goes DARK, never
                // a leak. `__giDirectShadowSteps` overrides here too.
                const macroSteps =
                  Number(globalThis.__giDirectShadowSteps) ||
                  ({ low: 96, medium: 128, high: 160, ultra: 192 }[quality] ?? 160);
                const r = occ.traceHybridPlane(origin, dir, tMin, maxT, {
                  coverage: shadowMode >= RayHitMode.HybridPlaneCoverage,
                  exact: shadowMode === RayHitMode.HybridExactComplex,
                  penumbraK: k,
                  macroSteps,
                  // ORIGIN-PLANE EXCLUSION: the receiving surface point. The
                  // march skips accepts/cone contributions whose plane
                  // contains it — the receiver's own SAT-bulged staircase
                  // cells re-fit exactly that plane, and each tooth used to
                  // stamp a teardrop self-shadow phantom on tilted receivers.
                  // `__giNoSelfPlaneExclusion = true` restores the old arm
                  // (build-time A/B like every hatch here).
                  excludePoint: globalThis.__giNoSelfPlaneExclusion === true ? null : receiverP,
                });
                if (globalThis.__giShadowKindDebug === true) {
                  // VERDICT-KIND MAP instead of a shadow: the channel paints
                  // WHICH acceptance class decided each pixel. miss=white,
                  // plane=0.75, exact-triangle=0.5, box=0.25, clamp=black.
                  return vec2(float(1).sub(r.kind.mul(0.25)), 0);
                }
                // y = PCSS blocker distance, normalized by the span (0 = no
                // blocker = no blur). The pen variant returns hitT for
                // exactly this; misses carry t = -1, hence the max(0).
                return vec2(
                  r.hit.oneMinus().mul(r.pen),
                  r.t.max(0).div(float(span)).clamp(0, 1),
                );
              }
              // Tiered like every other march in this module — the DDA's
              // hierarchical coarse-skip means these budgets cross the whole
              // volume at every tier; the tiers trade tail-end reach in
              // pathological threading rays for per-pixel cost.
              // (`__giDirectShadowSteps` overrides both arms for an A/B.)
              const ddaSteps =
                Number(globalThis.__giDirectShadowSteps) ||
                ({ low: 40, medium: 56, high: 64, ultra: 80 }[quality] ?? 64);
              const r = occ.traceOccupancy(origin, dir, tMin, maxT, { steps: ddaSteps, penumbraK: k });
              return vec2(
                r.hit.oneMinus().mul(r.pen),
                r.t.max(0).div(float(span)).clamp(0, 1),
              );
            },
      // STABLE estimator, deliberately (the sharp one was tried first): the
      // sharp arm's occluder admission is binary, and against a ~12cm-voxel
      // medium those verdicts flip with lattice phase — white-speckle
      // dithering along every silhouette and lit/black tearing that NO
      // penumbra width smooths (the user's "no matter what the sun angle"
      // report is the fingerprint: k-insensitive artifacts are admission
      // artifacts). Stable turns the admissions into ramps; its leak-seal
      // contact Break stays, reached smoothly.
      trace: volume.createSoftShadowTrace(lift, steps, "giLightShadowTrace", true),
    };
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
  #buildScreenResolve({ gather, light, emitterSlots, radianceLookup = null, lightSlots = null, ao = null, lightShadow = null }) {
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
        this._giRadianceNode = texture(this._giTargets.radiance);
      }
      const targets = this._giTargets;
      // PERSISTENT, created once per system and repointed on resize — exactly
      // like its siblings above, and here it is not merely an optimisation:
      // every gi light's `shadow.shadowNode` samples THIS node forever, and a
      // node swap would mean rebuilding (and recompiling) that shadow branch
      // in every material each time the viewport changes size.
      if (lightShadow && !this._giLightShadowNode) {
        this._giLightShadowNode = texture(targets.lightShadow);
      }
      // PCSS blocker-distance channel, same persistence contract as the
      // shadow node above (every gi light's shadow branch samples it).
      if (lightShadow && !this._giLightShadowDistNode) {
        this._giLightShadowDistNode = texture(targets.lightShadowDist);
      }
      // The shadowNode's tap offsets are half-res texels; runs on every
      // build (and #syncScreenResolveSize covers the resize path).
      (this._giLightShadowTexel ??= uniform(new THREE.Vector2())).value.set(1 / width, 1 / height);
      // The gbuffer POSITION feeds the shadowNode's tap validity (see
      // #acquireLightShadowNode). The gbuffer is per-build, so the persistent
      // node re-points here every time; a resize reuses the same render
      // target object (setSize), so no hook is needed there.
      // Unconditional: giLight's irradiance bilateral needs it even when the
      // light-shadow bundle declined (the smear it guards is a property of
      // EVERY screen-space GI term, not of the shadow feature).
      if (!this._giShadowPosNode) this._giShadowPosNode = texture(gbuffer.position);
      else this._giShadowPosNode.value = gbuffer.position;
      const emitter = emitterSlots
        ? {
            emitterSlots,
            shadowTraceFn: light.shadowTraceFn,
            shadowMargin: light.shadowMargin,
            shadowRange: light.shadowRange,
          }
        : null;
      const inputs = { gather, normalOffset: light.normalOffset, intensity: light.intensityUniform, emitter, ao };
      // The bundle arrives target-less (the targets are created just above, and
      // only the system knows when) — bind it here and keep the completed
      // bundle on `screen` so the resize path can re-point it.
      inputs.lightShadow = lightShadow
        ? {
            ...lightShadow,
            target: targets.lightShadow,
            distTarget: lightShadow.pcss ? targets.lightShadowDist : null,
          }
        : null;
      const radiance = radianceLookup
        ? {
            lookup: radianceLookup,
            cameraPosition: uniform(new THREE.Vector3()),
          }
        : null;
      inputs.radiance = radiance;
      // Exact-reflection hit shading rides along in this pass (see
      // createGiResolve's `bvhShade`). The BVH targets are created HERE, ahead
      // of `#syncBvhScene`, because the resolve has to bind them at build time
      // while the BVH scene itself only arrives once the mesh list is walked —
      // they are system-lifetime anyway (same reasoning as `_giTargets`), so
      // creating them early costs one half-res texture set and nothing else.
      inputs.bvhShade = this.#bvhReflectionsEnabled()
        ? {
            ...this.#ensureBvhTargets(width, height),
            lightSlots,
            cameraPosition: radiance?.cameraPosition ?? uniform(new THREE.Vector3()),
          }
        : null;
      const resolve = createGiResolve({ gbuffer, targets, width, height, ...inputs });
      light.giIrradianceNode = this._giIrradianceNode;
      light.giEmitterShadowNode = emitterSlots ? this._giEmitterShadowNode : null;
      light.giRadianceNode = radianceLookup ? this._giRadianceNode : null;
      // Silhouette-validity inputs for giLight's bilateral screen sampling
      // (same machinery as the shadowNode's — see #acquireLightShadowNode):
      // the half-res gbuffer POSITION says which surface each texel's GI was
      // resolved FOR, which is what stops a bright texel's irradiance from
      // smearing white dots across the dark silhouette in front of it.
      light.giPositionNode = this._giShadowPosNode;
      light.giScreenTexel = this._giLightShadowTexel;
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
    // A RESIZE IS SUPPOSED TO BE RARE. It recreates every GI target, retires
    // the old ones 3 frames later, and REBUILDS + sync-compiles the resolve
    // pipeline. If this fires repeatedly on a static viewport (a size that
    // oscillates by a pixel, a render scale that chases frame time), the GI
    // texture is being torn down and rebuilt while the scene renders — which
    // is GI-only, independent of every lighting term, and looks exactly like a
    // global flicker. Counted under `__giLogComposite`.
    if (globalThis.__giLogComposite) {
      this._resolveResizes = (this._resolveResizes ?? 0) + 1;
      console.log(`[gi] resolve target resized to ${width}x${height} (was ${screen.width}x${screen.height})`);
    }
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
    this._giRadianceNode.value = screen.targets.radiance;
    // The shadowNode's tap offsets are half-res texels — this path skips
    // #buildScreenResolve, so the uniform must follow the size here too.
    this._giLightShadowTexel?.value.set(1 / width, 1 / height);
    // Same swap for the gi light-shadow channel pack. The node is what every
    // gi light's compiled shadow branch holds, so re-pointing it (rather than
    // rebuilding it) is what keeps a viewport resize free of material
    // recompiles — and the bundle has to carry the NEW texture into the
    // resolve rebuild below, or the pass would write into the target that is
    // about to be retired.
    if (this._giLightShadowNode) this._giLightShadowNode.value = screen.targets.lightShadow;
    if (this._giLightShadowDistNode) this._giLightShadowDistNode.value = screen.targets.lightShadowDist;
    if (screen.lightShadow) {
      screen.lightShadow = {
        ...screen.lightShadow,
        target: screen.targets.lightShadow,
        distTarget: screen.lightShadow.pcss ? screen.targets.lightShadowDist : null,
      };
    }
    // THE BVH TARGETS ARE REPLACED BEFORE THE RESOLVE IS REBUILT, not after.
    // The resolve now BINDS them (it shades the reflection hits — see
    // createGiResolve's `bvhShade`), so rebuilding it against the old,
    // about-to-be-retired textures would hand it dead bindings and the pass
    // would start failing a few frames later, when the retire timer fires.
    let previousBvhTarget = null;
    if (screen.bvhShade) {
      previousBvhTarget = this._giBvhTarget;
      this._giBvhTarget = createGiBvhTarget(width, height);
      this._giBvhTargetSize = { width, height };
      this._giBvhReflectNode.value = this._giBvhTarget.bvhReflect;
      this._giBvhColorNode.value = this._giBvhTarget.bvhColor;
      this._giBvhRadianceNode.value = this._giBvhTarget.bvhRadiance;
      screen.bvhShade = {
        ...screen.bvhShade,
        hit: this._giBvhTarget.bvhReflect,
        albedo: this._giBvhTarget.bvhColor,
        target: this._giBvhTarget.bvhRadiance,
      };
    }
    const index = state.queue.indexOf(screen.resolve.compute);
    const indexNoFeedback = state.queueNoFeedback.indexOf(screen.resolve.compute);
    const indexFeedbackOnly = state.queueFeedbackOnly?.indexOf(screen.resolve.compute) ?? -1;
    screen.resolve = createGiResolve({
      gbuffer: screen.gbuffer,
      targets: screen.targets,
      width,
      height,
      gather: screen.gather,
      normalOffset: screen.normalOffset,
      intensity: screen.intensity,
      emitter: screen.emitter,
      radiance: screen.radiance,
      bvhShade: screen.bvhShade,
      ao: screen.ao,
      lightShadow: screen.lightShadow,
    });
    if (index >= 0) state.queue[index] = screen.resolve.compute;
    if (indexNoFeedback >= 0) state.queueNoFeedback[indexNoFeedback] = screen.resolve.compute;
    if (indexFeedbackOnly >= 0) state.queueFeedbackOnly[indexFeedbackOnly] = screen.resolve.compute;
    this.#retireTargets(previousTargets);
    // Same follow-up for the BVH reflect compute (GI Phase 3 v1) — it is NOT
    // part of state.queue/queueNoFeedback (see #tick's dispatch comment), so
    // there is no index-splice step for it.
    if (screen.bvhReflect) {
      if (!previousBvhTarget) {
        // Exact reflections without the shading bundle (an unshaded build):
        // the targets were not swapped above, so do it here.
        previousBvhTarget = this._giBvhTarget;
        this._giBvhTarget = createGiBvhTarget(width, height);
        this._giBvhTargetSize = { width, height };
        this._giBvhReflectNode.value = this._giBvhTarget.bvhReflect;
        this._giBvhColorNode.value = this._giBvhTarget.bvhColor;
        this._giBvhRadianceNode.value = this._giBvhTarget.bvhRadiance;
      }
      const { compute } = createGiBvhReflect({
        gbuffer: screen.gbuffer,
        target: this._giBvhTarget.bvhReflect,
        colorTarget: this._giBvhTarget.bvhColor,
        width,
        height,
        bvhScene: screen.bvhReflect.bvhScene,
        cameraPosition: this._bvhCameraPosition,
        normalOffset: state.light.normalOffset,
        maxDistance: state.light.mirrorRange ?? 24,
        mask: this.#bvhMaskEnabled(),
      });
      screen.bvhReflect = { compute, bvhScene: screen.bvhReflect.bvhScene };
    }
    this.#retireTargets(previousBvhTarget);
  }

  /**
   * Whether exact (BVH) reflections should be active right now: the whole
   * mirror system must be on, the component explicitly opts in, and the
   * dev/harness A-B hatch must not be set. Read
   * fresh at both build/sync time (compiles the material-side switch) and
   * dispatch time (`#tick`, stops the GPU cost immediately if the hatch is
   * flipped live) — see `bvhReflectTexture`'s doc comment in giLight.js.
   */
  #bvhReflectionsEnabled() {
    const props = this.component?.props;
    if (!props || props.reflections === false) return false;
    if (globalThis.__giNoBvhReflections === true) return false;
    // Exact BVH is a high/ultra feature. Presets are an actual performance
    // contract: a stale advanced flag stored by a previous high-quality edit
    // must not silently turn a Medium scene into a 100-200ms/frame workload.
    // `custom` intentionally follows the high tier via qualityTierOf().
    const quality = qualityTierOf(props);
    if (quality !== "high" && quality !== "ultra") return false;
    return props.exactReflections === true;
  }

  /**
   * The exact-reflection screen targets + the persistent texture nodes over
   * them, created on first use and kept for the SYSTEM's lifetime — never per
   * build. Materials and the resolve compile against these NODES and hold them
   * across rebuilds, so a node may only ever have its `.value` re-pointed (see
   * createGiTargets' comment; this is the same contract).
   *
   * Returns the plain textures the resolve binds: `hit`/`albedo` are what the
   * BVH prepass writes, `target` is where the shaded radiance goes.
   */
  #ensureBvhTargets(width, height) {
    if (!this._giBvhTarget) {
      this._giBvhTarget = createGiBvhTarget(width, height);
      this._giBvhTargetSize = { width, height };
      this._giBvhReflectNode = texture(this._giBvhTarget.bvhReflect);
      this._giBvhColorNode = texture(this._giBvhTarget.bvhColor);
      this._giBvhRadianceNode = texture(this._giBvhTarget.bvhRadiance);
    }
    return {
      hit: this._giBvhTarget.bvhReflect,
      albedo: this._giBvhTarget.bvhColor,
      target: this._giBvhTarget.bvhRadiance,
    };
  }

  /**
   * (Re)builds the exact-reflection BVH scene from the SAME mesh list the
   * mesh-SDF atlas entries cover (baked + analytic — walls are just box
   * tris, so including them gives the BVH the whole static scene, not only
   * "real" meshes) and wires its output into `state.light.bvhReflectTexture`.
   *
   * Called both from a full `#rebuild()` (state.screen freshly built) and
   * from the incremental fingerprint-sync path (`#checkFingerprint`, mesh
   * add/remove without a full rebuild) — same logic either way, since BVH
   * rebuilds are compute-only (no material recompile), unlike the mesh-SDF
   * atlas capacity change that DOES sometimes force one. Needs
   * `state.screen` (the deferred resolve's gbuffer) to exist; exact
   * reflections are simply unavailable without it (matches the legacy
   * per-material GI fallback in `#buildScreenResolve`).
   */
  #syncBvhScene(entries) {
    const state = this.state;
    if (!state?.screen) return;
    const light = state.light;
    if (!this.#bvhReflectionsEnabled()) {
      // Retired, not disposed on the spot (see #retireTargets' own comment):
      // the albedo atlas (GI Phase 3 v2) is a real CanvasTexture that this
      // frame's already-dispatched BVH-reflect compute may still be reading
      // on the GPU — the SAME "Destroyed texture used in a submit" class the
      // resize path guards against. Before the atlas existed, `.dispose()`
      // here was JS-only (an array truncation) and synchronous disposal was
      // harmless; it no longer is.
      this.#retireTargets(state.bvhScene);
      state.bvhScene = null;
      state.screen.bvhReflect = null;
      if (light) {
        light.bvhReflectTexture = null;
        light.bvhReflectColorTexture = null;
        light.bvhReflectShaded = false;
      }
      return;
    }
    // Same retire-not-dispose reasoning as the branch above: this path
    // (mesh add/remove/material change with reflections staying enabled)
    // replaces `state.bvhScene` wholesale on the fingerprint-sync cadence,
    // without going through the disabled branch.
    this.#retireTargets(state.bvhScene);
    // DEDUPED: entries are per-placement now, so an InstancedMesh appears
    // once per instance. The BVH builder wants distinct meshes — feeding it
    // the same one 200 times would build 200 identical BLASes.
    const meshes = [...new Set(entries.map((entry) => entry.mesh))];
    const bvhScene = buildBvhScene(meshes);
    state.bvhScene = bvhScene;
    const { width, height } = state.screen;
    // Usually already created by #buildScreenResolve (the resolve has to bind
    // these to shade hits); this covers the incremental-sync path reaching
    // here first. Lazy + SYSTEM-lifetime either way — see #ensureBvhTargets.
    this.#ensureBvhTargets(width, height);
    if (!this._bvhCameraPosition) this._bvhCameraPosition = uniform(new THREE.Vector3());
    const { compute } = createGiBvhReflect({
      gbuffer: state.screen.gbuffer,
      target: this._giBvhTarget.bvhReflect,
      colorTarget: this._giBvhTarget.bvhColor,
      width,
      height,
      bvhScene,
      cameraPosition: this._bvhCameraPosition,
      normalOffset: light.normalOffset,
      maxDistance: light.mirrorRange ?? 24,
      mask: this.#bvhMaskEnabled(),
    });
    state.screen.bvhReflect = { compute, bvhScene };
    // The resolve pass shades hits when it was built with a `bvhShade` bundle
    // (see #buildScreenResolve) — that is the single source of truth for which
    // texture carries the value materials should read.
    const shaded = !!state.screen.bvhShade;
    if (light) {
      light.bvhReflectTexture = this._giBvhReflectNode;
      // WHICH texture the material samples for reflection colour, and what it
      // means, move together. Shaded: the resolve's radiance target, consumed
      // as-is. Unshaded: the prepass's raw albedo, which the consumer then has
      // to light with the wrong thing (its own irradiance — see giLight's use
      // site). Both are compile-time, and both are safe to switch here because
      // the flag is derived from the screen resolve, which only ever changes
      // on a rebuild.
      light.bvhReflectColorTexture = shaded ? this._giBvhRadianceNode : this._giBvhColorNode;
      light.bvhReflectShaded = shaded;
    }
    // Affirmative ground truth for users/harnesses: absence of this line
    // means exact reflections are NOT running, whatever else seems true
    // (quality gate, stale dev server, hatch) — added after a debugging
    // round where "is it even on?" was unanswerable from the console.
    console.log(
      `[gi] bvh: exact reflections ON — ${bvhScene.meshCount} meshes, ${bvhScene.triCount} tris` +
        (bvhScene.meshes.length < (state.entries?.length ?? 0) ? " (some meshes SDF-only via coverage flag)" : "") +
        (bvhScene.texturedCount > 0 ? ", textured atlas" : "") +
        (this.#bvhMaskEnabled() ? ", sparse (mirror-masked)" : ", DENSE (full-screen)") +
        (shaded ? ", hit-shaded" : ", albedo-only"),
    );
  }

  /**
   * Whether the exact-reflection prepass restricts itself to mirror pixels.
   * On by default — the dense arm exists only as the A/B for the harness and
   * as an escape hatch if a scene's mirror tagging ever proves wrong (the
   * failure mode would be a reflective surface whose material bucket the
   * collect walk didn't classify: it loses its exact reflection and falls
   * back to the cascade lookup, rather than rendering wrong).
   */
  #bvhMaskEnabled() {
    return globalThis.__giBvhMask === true;
  }

  /**
   * SDF-FREE MODE: no baked mesh SDF is read anywhere in the lighting path.
   * The occupancy pyramid supplies the composited distance and the near-field
   * refinement both traces used the per-mesh atlas for (see giField's
   * `killSdf`), which is what retires the 40 MB atlas, the bake worker and the
   * `.sdf` Library cache.
   *
   * WHY IT ALSO MATTERS FOR SHIPPING, not just VRAM: those caches live in the
   * Tauri-only project `Library/`, so a hosted build either ships them or bakes
   * every mesh from scratch in the browser. Occupancy voxelizes from triangles
   * on the GPU at load, so an SDF-free build has nothing to ship and nothing to
   * bake.
   *
   * Structural (it changes which graph every GI shader compiles) — see
   * `#structuralSignature`.
   */
  #killSdfEnabled() {
    // ALWAYS. The bake pipeline is deleted (2026-08-02) — there is no SDF path
    // to fall back to, and the prop is gone from the component. Kept as a
    // method because a dozen call sites read it, and the giField fallback for
    // a device without an occupancy field still keys off it structurally.
    return true;
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
    // SURFACE-RECORD POOL AUDIT — starvation here is otherwise invisible: the
    // boot log says `marcher records` while a contiguous macro-order slab of
    // the scene silently degrades to occupied-box hits and full-voxel square
    // silhouettes (the Sponza-ultra bug: demand 1.24M vs the old 1M cap).
    const occField = state.volume.occupancyField;
    if (occField?.hasSurfaceRecords && occField.readbackSurfaceAlloc) {
      occField.readbackSurfaceAlloc(renderer).then((alloc) => {
        if (this.state !== state || !alloc) return;
        const line = `[gi] surface records: ${alloc.allocated}/${alloc.capacity} claimed` +
          `, triangles ${alloc.triangles}/${alloc.triangleCapacity}` +
          `, dynamic tail ${alloc.dynamicAllocated}/${alloc.dynamicCapacity}`;
        // TWO DIFFERENT degradations, two different remedies — do not conflate:
        // pool starvation (claims denied → whole bricks boxed; the capacity is
        // wrong) vs the per-cell exact-triangle cap (a dense cell exceeds
        // MAX_COMPLEX_TRIANGLES and is boxed by design; capacity is fine).
        if (alloc.overflowBricks > 0) {
          console.warn(
            `${line} — POOL STARVED: ${alloc.overflowBricks} bricks degraded to voxel-box ` +
              `hits (square silhouettes there). The record pool is undersized for this scene.`,
          );
        } else if (alloc.complexOverflowCells > 0) {
          console.log(
            `${line} — ${alloc.complexOverflowCells} dense cells exceed the per-cell ` +
              `exact-triangle limit and keep voxel-box hits (localized square silhouettes ` +
              `on dense trim/foliage).`,
          );
        } else {
          console.log(line);
        }
        // The dynamic tail describes the LAST chain only (its cursor resets
        // every dispatch), so at boot this is usually 0/0 — the warn matters
        // when a large mover was live during the audited frame.
        if (alloc.dynamicOverflowBricks > 0) {
          console.warn(
            `[gi] dynamic record tail STARVED: ${alloc.dynamicOverflowBricks} mover bricks ` +
              `degraded to voxel-box hits this chain (${alloc.dynamicAllocated}/` +
              `${alloc.dynamicCapacity} claimed). Raise dynamicSurfaceRecordCapacity.`,
          );
        }
      });
    }
  }

  #rebuild() {
    this.#dispose();
    // Re-arm the checker warm-up: the cascade/radiance buffers below are
    // brand new and zero-filled (see CHECKER_WARMUP_FRAMES).
    this._framesSinceBuild = 0;
    const component = this.component;
    const engine = this.engine;
    if (!component || !engine.scene) return;

    const props = component.props;
    const rayHitConfig = resolveRayHitConfig(props);
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
      const budget = QUALITY_BUDGETS[qualityTierOf(props)];
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
    const quality = qualityTierOf(props);
    const traceBudget =
      { low: { shadow: 24, mirror: 32, feedback: 18 },
        medium: { shadow: 32, mirror: 40, feedback: 24 },
        high: { shadow: 44, mirror: 56, feedback: 32 },
        ultra: { shadow: 56, mirror: 64, feedback: 40 } }[quality]
      ?? { shadow: 44, mirror: 56, feedback: 32 };
    // Low/medium's feedback cost halving, restructured: instead of the whole
    // pass running every OTHER frame (which stair-steps the entire field at
    // half the light's rate — flicker on exactly the presets meant to be
    // cheap), the pass runs EVERY frame on alternating halves of the cells
    // (index parity × this flipping uniform). Same average cost, and the
    // field as a whole now moves every frame.
    //
    // The uniform is now built at EVERY tier and the on/off decision is made
    // per tick (#tick writes -1 to disable), for two reasons: the feedback is
    // the single largest term in the awake pipeline at high/ultra, so this is
    // the cheapest peak-frame-cost lever there is; and a build-time switch
    // cannot be A/B'd inside one measurement run, which is the only kind of
    // A/B this module trusts. One `parity >= 0` compare per thread is the
    // whole cost of making it live.
    this._feedbackCheckerDefault = !(quality === "high" || quality === "ultra");
    const feedbackParity = uniform(-1);

    // The authored representation: one atlas TILE per unique baked geometry,
    // one INSTANCE SLOT per world placement. Sizing them apart is the point —
    // a scene of 200 crates needs 200 transforms and exactly one distance
    // grid, and it used to need 200 grids (and therefore did not fit).
    this._hiResMeshes = this.#selectHiResMeshes(meshes);
    // TILE capacity: unique baked geometries, not meshes. Analytic primitives
    // (boxes, spheres, fitted GLB walls) hold no tile at all, and repeats of
    // one geometry share one — so a scene that used to need eight atlas
    // layers commonly needs one.
    const tileKeys = new Set();
    let hiResTiles = 0;
    for (const mesh of meshes) {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (analyticShapeOf(mesh.geometry, material)) continue;
      const hiRes = this._hiResMeshes.has(mesh);
      // The SAME key #buildEntries derives — the estimate has to agree with
      // what acquireTile is actually going to ask for, or the atlas is sized
      // for a tile count the scene never requests (or, worse, one it exceeds
      // and then rebuilds out of).
      const key = contentKeyOf(mesh.geometry, hiRes);
      if (tileKeys.has(key)) continue;
      tileKeys.add(key);
      if (hiRes) hiResTiles++;
    }
    // BLOCK-AWARE capacity. Hi-res blocks pack 4 per LAYER PAIR and singles
    // fill layers from the tail (see #findTileSingle) — sizing by raw tile
    // count alone left no aligned region for the last block (11 meshes +
    // 14 block tiles = 2 layers, but 9 seated singles fragment every block
    // region), and the overflow → rebuild → overflow loop spun forever.
    const singleCount = tileKeys.size - hiResTiles;
    const singleLayers = Math.max(1, Math.ceil(singleCount / SLOTS_PER_LAYER));
    const maxBlocks = Math.max(0, Math.floor((MAX_ATLAS_LAYERS - singleLayers) / 2)) * 4;
    if (hiResTiles > maxBlocks) {
      // Drop the lowest-ranked hi-res grants (the set is built densest-first).
      const keep = new Set();
      for (const mesh of this._hiResMeshes) {
        if (keep.size >= maxBlocks) break;
        keep.add(mesh);
      }
      this._hiResMeshes = keep;
      hiResTiles = Math.min(hiResTiles, maxBlocks);
    }
    const blockLayers = Math.ceil(hiResTiles / 4) * 2;
    // INSTANCE capacity: every placement, including each InstancedMesh
    // instance. Uniform-array length only — no texture memory rides on it.
    let placements = 0;
    for (const mesh of meshes) placements += this.#placementsOf(mesh).length;
    const atlas = new SlotRegistry(
      Math.min(MAX_ATLAS_LAYERS, blockLayers + singleLayers) * SLOTS_PER_LAYER,
      instanceCapacityFor(placements),
    );
    // Per-quality refinement budget: every shadow/mirror trace STEP pays
    // for these slots — set BEFORE any trace graph is built.
    atlas.detailBudget = { low: 4, medium: 8, high: 10, ultra: 12 }[qualityTierOf(props)];
    // FINE (sparse brick) level. Opt-in until it is proven on a real scene:
    // the prop, or `globalThis.__giSparseField = true` for a live A/B without
    // touching the component. Brick size and pool budget scale with quality —
    // the pool is real VRAM, and at ultra it is the largest single allocation
    // the module makes.
    // MUTUALLY EXCLUSIVE WITH SDF-FREE MODE, and this is a correctness gate,
    // not a preference: the sparse bricks are a RESAMPLING of the per-mesh SDF
    // grids, and both traces trust a valid brick OVER the coarse distance. With
    // no grids to fill them the bricks would hold cap distances and would
    // silently overwrite the occupancy oracle's good answer with a blank one.
    const sparseField =
      !this.#killSdfEnabled() &&
      (props.sparseField === true || globalThis.__giSparseField === true);
    // (The CPU point-sampled occupancy PROTOTYPE that used to be buildable
    // here — `triangleOcclusion` opt-in, occupancyGrid.js — was deleted
    // 2026-08-02 with the bake pipeline it depended on. The SAT-conservative
    // pyramid below is its successor and the only occupancy.)
    const occupancy = null;
    // THE OCCUPANCY BACKEND (spec phases 1+4) — since 2026-08-02 the ONLY
    // transport backend; the `backend` prop and the legacy SDF sphere trace it
    // selected are gone. Built here for the same reason the prototype above is
    // (this is where the mesh list lives) and BEFORE the volume, because the
    // composite graph and every trace close over it. Null only means the
    // explicit diagnostic backend hatch disabled occupancy.
    const occField = this.#buildOccupancyField(
      props, meshes, bounds, { sizeX, sizeY, sizeZ }, quality, rayHitConfig,
    );
    const killSdf = this.#killSdfEnabled();
    if (killSdf && !occField) {
      console.warn("[gi] occupancy was disabled by the diagnostic backend hatch; GI has no geometry transport");
    }
    const volume = createGiField(bounds, res, atlas, {
      occupancy,
      occupancyField: occField,
      rayHitConfig,
      killSdf,
      sparseField,
      brickAxis: BRICK_AXIS_BY_QUALITY[quality] ?? 6,
      // Budgets sized from a MEASURED scene, not guessed: their Sponza wants
      // 207,925 bricks at 0.33m coarse cells (run-gi-sdf-coverage). A budget
      // under that is not a soft quality knob — the cells that miss out keep
      // the coarse field, so the building would seal in some places and leak
      // in others, which reads as random rather than as "lower quality".
      // Memory is axis³ × 2 B × budget: 4³ is cheap, 8³ is 2.4× the cost of
      // 6³ for 1.4× the resolution, which is why only ultra pays it.
      maxBricks: { low: 60_000, medium: 120_000, high: 220_000, ultra: 260_000 }[quality] ?? 220_000,
    });
    // Plane walls are zero-thickness; give them a solid interior sized to
    // THIS field. Too thin and the trilinear distance texture cannot see
    // them at all — sphere-traced mirror rays step through the walls and
    // reflections read black. A quarter cell is resolvable without visibly
    // displacing the surface.
    atlas.minAnalyticHalfWorld = Math.max(0.01, volume.minCell * 0.5);
    // Entries + slot assignment + emitter promotion + SDF load-or-bake.
    const entries = this.#buildEntries(meshes);

    // Cascade-trace checkerboard parity (see cascadeTrace's note). -1 = off;
    // #tick writes the frame parity when enabled. Built at every tier so the
    // switch is live — one compare per thread when it is off.
    const traceParity = uniform(-1);
    const { cascades, intervals } = createRadianceCascades({
      world: volume.world,
      cascadeCount: Math.min(6, Math.max(2, props.cascadeCount || 5)),
      c0Grid,
      c0DirRes: props.c0DirRes === 2 ? 2 : 4,
      t0: probeSpacing,
      farT: Math.max(sizeX, sizeY, sizeZ) * 2,
      sceneTrace: volume.createSceneTrace(),
      traceParity,
    });
    // Sky light: the radiance a cascade ray brings back when it escapes the
    // volume without hitting anything. A uniform, not a constant, so colour
    // and intensity are live controls — changing them re-lights the scene on
    // the next frame with no rebuild and no material recompile.
    const skyRadiance = uniform(new THREE.Color(0, 0, 0));
    const { mergeComputes, averageComputes, visComputes } = createCascadeMerge(cascades, {
      sky: skyRadiance,
      occupancyVoxel: volume.occupancyField?.voxel ?? null,
      // The whole field, for the buried-PARENT cut (see that use site): the
      // coarse cascades are where a probe inside a floor is metres from the
      // children it feeds.
      occupancy: volume.occupancyField ?? null,
    });
    // Per-probe ambient-cube irradiance, integrated once per frame — the
    // per-pixel/per-cell gather then reads 2 fetches per probe instead of
    // dirCount radiance reads (the dominant per-pixel GPU cost). It also owns
    // the per-probe openness (buried-probe cut) and the per-probe temporal EMA
    // that keeps a sweeping light from popping the lattice.
    const probeSmoothing = uniform(clampProbeSmoothing(props.probeSmoothing));
    const probeIrradiance = createProbeIrradiance(cascades, {
      occupancy: volume.occupancyField ?? null,
      smoothing: probeSmoothing,
    });
    // Per-probe depth moments (Phase 2 — chebyshev gather visibility, see
    // createProbeDepthMoments). Binding-neutral in the gather kernels: they
    // read this buffer INSTEAD of c0.rays.
    const probeDepth = createProbeDepthMoments(cascades);
    // This gather instance feeds ONLY the deferred resolve compute (materials
    // read its result from a texture now), so it can be a real WGSL function
    // — see createShadowTrace's note on why that is unsafe for shared ones.
    const gather = createIrradianceGather(
      cascades, probeIrradiance.buffer, volume.world.cellMax, "giResolveGather",
      // The FIELD, not a captured number: the gather needs both its voxel size
      // (a uniform, so an in-place refit rescales it) and its point test, for
      // the buried-probe cut.
      volume.occupancyField ?? null,
      probeDepth.buffer,
    );
    // Volume diagonal as a uniform: shadow/mirror reach rescales with an
    // in-place refit (all world-scale shader inputs must be uniforms — a
    // baked one would pin part of the old volume after a refit).
    const diagU = uniform(Math.hypot(sizeX, sizeY, sizeZ));
    // Multi-bounce: field radiance ← base + albedo·E/π every frame. Runs
    // FIRST (reads last frame's merged field) so this frame's trace sees
    // bounced energy — this is what makes emissive-only scenes bleed.
    const bounceGain = uniform(Math.min(1, Math.max(0, props.bounce ?? 1)));
    // Chroma of the bounced light (1 = physical, see createBounceFeedback's
    // bleedSaturation note) — live look control, Blender-parity calibration.
    const bleedSaturation = uniform(Math.min(1, Math.max(0, props.bleedSaturation ?? 1)));
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
      // ── GI-TRACED DIRECT SHADOWS (LightComponent's `shadowMode: "gi"`) ──
      // `soft` = the light's own angular RADIUS in radians (a sun's authored
      // "Angle", halved by LightComponent). `srcRadius` = a point/spot source's
      // world-space radius, whose angular size is radius/distance and therefore
      // has to be resolved per pixel rather than stored as an angle. Exactly
      // one of the two is meaningful per slot, chosen by `kind`.
      //
      // BOTH ARE 0 UNLESS THE LIGHT IS GI-FLAGGED, and that is deliberate: 0
      // means "unset", which every consumer falls back from to the global sun
      // angle. So a scene that never opts into gi shadows keeps byte-identical
      // field behaviour, and the feature can only change lights that asked for
      // it (see #updateLightUniforms and cascadeGather's per-slot k).
      soft: uniform(0),
      srcRadius: uniform(0),
      // 1 only while the screen resolve should trace this slot's shadow cone:
      // the light asked for gi shadows AND the device/binding gate passed AND
      // the slot is live. A uniform rather than a build-time switch because
      // flipping a light's Shadow Source must not need a GI rebuild.
      giShadow: uniform(0),
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
            // Slot SHAPE (see giLight emitterSlotFactor): kind 0 = sphere,
            // 1 = oriented box; half = world half-extents; bx/by/bz = world
            // axes; reff = mean-projected-area-equivalent radius (angular
            // size for penumbra k and glow energy). radius stays the
            // bounding sphere — trace self-exclusion and the active gate.
            kind: uniform(0),
            half: uniform(new THREE.Vector3(0.1, 0.1, 0.1)),
            bx: uniform(new THREE.Vector3(1, 0, 0)),
            by: uniform(new THREE.Vector3(0, 1, 0)),
            bz: uniform(new THREE.Vector3(0, 0, 1)),
            reff: uniform(0),
          }))
        : null;
    const normalLift = volume.world.minCell.mul(1.2);
    // Live A/B hatch for the field's shadow traces (see createBounceFeedback's
    // note on why this must be a UNIFORM, not a globalThis read).
    const fieldShadowOff = uniform(0);
    // Shadow-ray uniforms. `penAngle` = the sun's angular radius driving the
    // ANALYTIC penumbra (k = 1/penAngle in the DDA — the flicker fix; smooth,
    // deterministic). `angle` = the STOCHASTIC dither cone, DEFAULT 0: with
    // the analytic penumbra the signal is already continuous, and any
    // stochastic term flickers by construction whenever Light Smoothing is
    // off — user-confirmed ("it flickers even when the light is not
    // moving"). Kept as an opt-in (`__giSunJitter`) for A/B only.
    const shadowJitter = { frame: uniform(0), angle: uniform(0), penAngle: uniform(0.025) };
    // GI_FLICKER_PLAN.md Phase 1 — field-side radiance EMA (see
    // cascadeGather's fieldSmoothing note). Retain weight; DEFAULT 0.95
    // (user-confirmed live, 2026-08-03 — kills the object-motion flicker
    // without visibly hurting light response). `__giFieldSmoothing` stays as
    // a live override for further A/B (0 = pre-Phase-1 behaviour).
    const fieldSmoothing = uniform(globalThis.__giFieldSmoothing ?? 0.95);
    const feedbackCompute = createBounceFeedback(cascades, volume, bounceGain, temporalBlend, {
      lightSlots,
      emitterSlots,
      bleedSaturation,
      probeIrradiance: probeIrradiance.buffer,
      depthMoments: probeDepth.buffer,
      fieldSmoothing,
      // Private to the feedback compute (see createShadowTrace's layout note).
      // STABLE mode — the moving-light flicker fix (see createShadowTrace's
      // stable-mode note): this is the one trace re-evaluated for every field
      // cell every frame under a sweeping sun, so its binary verdicts were the
      // regional bright↔dark stepping. `__giStableFieldShadows = false`
      // restores the sharp estimator for an A/B (build-time — needs a rebuild).
      shadowTrace: volume.createSoftShadowTrace(
        normalLift, traceBudget.feedback, "giFeedbackShadowTrace",
        globalThis.__giStableFieldShadows !== false,
      ),
      gridDiagonal: diagU,
      fieldShadowOff,
      jitter: shadowJitter,
      checkerParity: feedbackParity,
      // Sun/point shadows in the FIELD go through the hierarchical occupancy
      // DDA — the same medium the transport rays march, which is why transport
      // never leaked while these sphere-traced rays tunnelled through the
      // floor at every preset whose cells are coarser than the slab (see
      // cascadeGather's `lightShadow` note). The verdict is hit × ANALYTIC
      // PENUMBRA (traceOccupancy's `penumbraK` — cone occlusion accumulated
      // during the march): a grazing ray fades continuously toward 0 before
      // the binary hit ever flips, which is what removes the last flicker —
      // with the sun on the far side of a building, the whole dark side's
      // bounce is amplified from a FEW sunlit cells near openings, and a
      // binary (or Bernoulli-jittered) verdict there swung the entire room
      // (user's 14-frame capture, 2026-08-03). k = 1/sunAngle: one knob is
      // both the jitter cone and the penumbra softness, live.
      // `__giFieldDdaShadows = false` (build-time) restores the sphere trace.
      lightShadow:
        volume.occupancyField && globalThis.__giFieldDdaShadows !== false
          ? // PER-LIGHT SOFTNESS: `k` is resolved by the caller, which is the
            // only place that knows WHICH slot it is tracing — cascadeGather
            // picks the slot's own angular radius when it has one (a gi-flagged
            // light's authored sun Angle) and falls back to this global
            // `penAngle` otherwise, so an un-flagged scene is unchanged. The
            // `??` keeps any other caller on the old behaviour.
            (origin, dir, maxT, k = null) => {
              const r = volume.occupancyField.traceOccupancy(
                origin, dir, volume.world.minCell.mul(0.25), maxT,
                { steps: 64, penumbraK: k ?? float(1).div(shadowJitter.penAngle.max(0.005)) },
              );
              return r.hit.oneMinus().mul(r.pen);
            }
          : null,
    });

    const queue = [feedbackCompute];
    for (const cascade of cascades) queue.push(cascade.traceCompute);
    // Stage boundaries, for the `__giFreeze` bisect's finer cuts ("traces",
    // "merges"). The awake pipeline's cost is dominated by this transport
    // half, and "transport" as one bucket was too coarse to optimize against.
    const queueMarks = { tracesEnd: queue.length };
    queue.push(...mergeComputes);
    queueMarks.mergesEnd = queue.length;
    // Integrate probe irradiance AFTER the merge so receivers read
    // this frame's field.
    queue.push(probeIrradiance.compute);
    // Depth moments read the RAW c0 rays (written by the trace above) — any
    // position after the traces works; beside the probe integral for clarity.
    queue.push(probeDepth.compute);
    // The feedback pass now runs EVERY frame at every preset — low/medium get
    // their cost halving from the checker (half the cells per frame, see
    // feedbackChecker above) instead of from skipping frames. queueNoFeedback
    // survives for the legacy-rate hatch and the __giFreeze bisect.
    const queueNoFeedback = queue.slice(1);
    // PEAK SPLIT — the awake pipeline as two alternating halves.
    //
    // Measured on the user's Sponza at ultra (2026-08-04, run-gi-perf.mjs):
    // waking the field costs 6.3ms of GPU compute per frame, of which the
    // feedback pass is 3.86 and the cascade traces+merges+probes are 2.44.
    // Both run EVERY frame while a light moves, and 6.3ms + the rest of the
    // frame crosses a 120Hz budget — at which point the compositor halves the
    // presented rate in one step. That cliff is the user's "FPS drops 2x".
    //
    // The two halves are a PING-PONG: feedback reads the merged cascades and
    // writes the radiance field; the traces read the radiance field and write
    // the cascades. Neither reads its own output within a frame, so running
    // one per frame converges to the same fixed point at half the rate —
    // it does not change WHAT the pipeline computes, only how often each half
    // re-runs. Peak per frame becomes max(3.86, 2.44) instead of their sum,
    // and the average halves too.
    //
    // The cadence is STRICTLY frame parity, deliberately: an irregular
    // feedback rate pulses the lighting (see the feedback-rate note in #tick,
    // which is a bug this module already shipped once). Even frames feed back,
    // odd frames transport, whatever else the frame is doing.
    //
    // The temporal cost is paid back on the field EMA: running the feedback
    // half as often would double its time constant, so `fieldSmoothing` is
    // squared when the split is on (retain r per run over 2 frames == r² per
    // run at half rate). Light response is then unchanged to first order.
    const queueFeedbackOnly = [feedbackCompute];
    const feedbackEveryFrame = true;
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
    // Reflections are deferred as well: materials only sample persistent
    // screen textures and never capture cascade/SDF/BVH buffers directly.
    // A fresh light is still required for the first-build lights-hash commit;
    // subsequent in-place refits retain the existing instance.
    const light = new GICascadeLight();
    light.gatherFn = gather;
    // World-scale light params are uniform-derived NODES (giLight composes
    // them into node math either way) so an in-place refit rescales them.
    light.normalOffset = volume.world.cellMax.mul(1.2).max(0.1);
    let deferredRadianceLookup = null;
    if (props.reflections !== false) {
      // Directional glossy GI is resolved once per screen pixel below and
      // sampled by every material. Keeping createRadianceLookup out of the
      // material graph avoids both the multi-second compile wave and the
      // previous non-exact "flat irradiance" fallback that looked like no
      // reflection at all.
      deferredRadianceLookup = createRadianceLookup(cascades, 2);
      light.approximateReflections = false;
      light.radianceFn = null;
      light.radianceSharpFn = null;
      light.radianceRoughFn = null;
      // Exact hits are now shaded from the shared BVH color texture in
      // GICascadeLightNode. Do not inject an SDF trace or hit reconstruction
      // into mirror materials: that was a 39s compile wave on the 262k-tri
      // Sponza scene and duplicated work already done by the screen pass.
      light.mirrorTraceFn = null;
      light.hitLighting = false;
      light.mirrorSampleFn = null;
      light.hitSurfaceFn = null;
      light.mirrorShadowFn = null;
      light.lightSlots = null;
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
      // Stable estimator here too (same reasoning as the gi-light trace in
      // #buildLightShadow): the emitter cones' binary admissions painted
      // lattice-phase moiré across floors the moment Emissive Shadows was
      // re-enabled on a real scene.
      light.shadowTraceFn = volume.createSoftShadowTrace(light.normalOffset, traceBudget.shadow, "giResolveShadowTrace", true);
      light.shadowMargin = volume.world.cellMax.mul(2.5).max(0.2);
      // Shadow reach must cover the whole volume: any receiver inside the
      // cap-but-unshadowed band takes emitter light THROUGH walls.
      light.shadowRange = diagU.clamp(12, 64);
      light.emitterSlots = emitterSlots;
    }
    // Indirect-light ambient occlusion (giScreen's obscurance ladder). The
    // uniforms are live (aoStrength/aoRadius edit without a rebuild); the
    // `ao` prop itself is structural — off compiles the block out entirely.
    const ao =
      props.ao !== false && volume.occupancyField
        ? {
            occupancy: volume.occupancyField,
            strength: uniform(Math.min(1, Math.max(0, props.aoStrength ?? 0.6))),
            radius: uniform(Math.min(3, Math.max(0.1, props.aoRadius ?? 0.6))),
          }
        : null;
    // DEFERRED RESOLVE: evaluate the gather + emitter shadows once per screen
    // pixel instead of inside every material (see giScreen.js). This is what
    // keeps material shaders small — the driver compile of a 200kB+ GI
    // fragment shader, once per material, was the whole startup cost.
    // GI-traced direct shadows for lights flagged `shadowMode: "gi"` (see
    // #buildLightShadow for the two binding gates). NOT structural: the bundle
    // compiles the per-slot cone unconditionally and each slot's `giShadow`
    // uniform decides per frame whether it marches, so flipping a light's
    // Shadow Source is a uniform write, never a GI rebuild.
    const lightShadow = this.#buildLightShadow({
      volume,
      lightSlots,
      quality,
      hasEmitterTrace: !!light.shadowTraceFn,
      span: diagU,
    });
    const screen = this.#buildScreenResolve({ gather, light, emitterSlots, radianceLookup: deferredRadianceLookup, ao, lightShadow });
    if (screen) {
      queue.push(screen.resolve.compute);
      queueNoFeedback.push(screen.resolve.compute);
      // The resolve is camera-dependent, so it runs on BOTH halves of the
      // split — it is 0.1ms and skipping it would stall GI against camera
      // motion, which is the one thing measurement says is currently free.
      queueFeedbackOnly.push(screen.resolve.compute);
    }
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
    gizmos.occView = this.#buildOccupancyView(volume, bounds, center);
    if (gizmos.occView) gizmos.all.push(gizmos.occView);
    for (const mesh of gizmos.all) engine.scene.add(mesh);

    this.state = {
      volume,
      atlas,
      cascades,
      intervals,
      diagU,
      queue,
      queueNoFeedback,
      queueFeedbackOnly,
      // Authored default ON: it is a straight 2x cut of the awake cost whose
      // only cost is halving each half's update rate, and the field EMA is
      // rate-compensated for exactly that. `peakSplit: false` (prop) or
      // `__giPeakSplit = false` (live) restores every-frame dispatch.
      peakSplit: props.peakSplit !== false,
      queueMarks,
      visComputes,
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
      // Exact-reflection BVH scene (GI Phase 3 v1) — populated just below by
      // `#syncBvhScene(entries)`, null until then / when disabled.
      bvhScene: null,
      buildSize: new THREE.Vector3(sizeX, sizeY, sizeZ),
      // The probe-spacing rung this build was laid out on — the lattice an
      // in-place slide snaps to. A stretch rescales it.
      probeSpacing,
      c0Grid,
      bounceGain,
      bleedSaturation,
      temporalBlend,
      probeSmoothing,
      fieldSmoothing,
      fieldShadowOff,
      shadowJitter,
      feedbackParity,
      traceParity,
      skyRadiance,
      autoFit,
      lightSlots,
      emitterSlots,
      statsLogged: false,
      rayHitConfig,
    };
    this._atlasRevisionSeen = -1; // force a first composite
    this._occGeometrySeen = -1;
    this._compositedOnce = false;
    this._pendingFit = null; // refit debounce restarts against fresh bounds
    this.#syncSlots(entries);
    this.#syncBvhScene(entries);
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
    const tilesUsed = atlas._tiles.size;
    if (autoFit && this._boundsSource) {
      console.log(
        `[gi] auto-fit bounds from ${this._boundsSource} (${analyticCount} analytic / ${resident - analyticCount} baked slots)`,
      );
    }
    console.log(
      `[gi] built (voxel-free): ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m` +
        `${autoFit ? ` (auto-fit ${props.quality ?? "high"}, voxel ${voxelSize.toFixed(2)}, probes ${probeSpacing.toFixed(2)})` : ""}, ` +
        `${res.x}x${res.y}x${res.z} cells, c0 ${c0Grid.x}x${c0Grid.y}x${c0Grid.z}, ` +
        // Branch factor is BUILD-TIME (cascadeTrace's BRANCH). Printed because
        // "I set the global and nothing changed" is indistinguishable from
        // "the setting does nothing" without it — and that ambiguity cost a
        // round trip.
        `${cascades.length} cascades (branch ${Number(globalThis.__giCascadeBranch ?? 2) || 2}), ` +
        `${meshes.length} meshes / ${entries.length} placements → ` +
        `${atlas.capacity} instance slots over ${atlas.tileCapacity} tiles ` +
        `(${resident} resident, ${entries.length - resident} pending, ` +
        `${tilesUsed} unique tile${tilesUsed === 1 ? "" : "s"}), ` +
        `${this._lightObjects.length} lights (GPU), ${this._emitterInfos?.length ?? 0} emitters, ` +
        `setup ${(performance.now() - t0).toFixed(0)}ms`,
    );
    if (volume.grid) {
      // Overflowed cells fall back to scanning every slot — correct, but it
      // is the one number that says the top level stopped paying for itself.
      volume.updateGrid();
      console.log(`[gi] instance grid: ${describeGrid(volume.grid)}`);
    }
    if (volume.occupancyField) {
      console.log(
        `[gi] occupancy backend: ${describeOccupancyField(volume.occupancyField)} ` +
          `(composite clamps from level ${volume.coarseLevel})`,
      );
    }
    // Affirmative ground truth for the gi-shadow feature, same discipline as
    // the ray-hit and SDF-free lines below: "I set Shadow Source to gi and
    // nothing changed" is unreadable without knowing whether the resolve even
    // built the trace, and at what step budget.
    console.log(
      screen?.lightShadow
        ? `[gi] light shadows: gi-traced ON, marcher ${screen.lightShadow.marcher} (${quality}), ` +
            `up to ${MAX_GI_LIGHTS} lights — flag a light with Shadow Source "gi"`
        : "[gi] light shadows: gi-traced OFF — every light renders its own shadow map",
    );
    console.log(
      `[gi] ray-hit: requested ${rayHitConfig.autoMode ? `auto→${rayHitModeName(rayHitConfig.requestedMode)}` : rayHitModeName(rayHitConfig.requestedMode)}, ` +
        `active ${rayHitModeName(rayHitConfig.activeMode)}, profiling ${rayHitConfig.enableProfiling ? "ON" : "off"}` +
        // Printed for the same reason the branch factor is: "I set the A/B
        // global and nothing changed" is unreadable without the ground truth.
        `, skip ${rayHitConfig.enableSkipDistance !== false ? "ON" : "off"}` +
        (rayHitConfig.fallbackToLegacy ? " (requested phase not implemented; legacy fallback)" : ""),
    );
    // Affirmative ground truth, same discipline as the BVH line: the ABSENCE
    // of "SDF-free" means baked mesh SDFs are still being read, whatever the
    // Inspector checkbox appears to say.
    if (this.#killSdfEnabled()) {
      console.log(
        volume.occupancyField
          ? "[gi] SDF-free: ON — distance from the occupancy pyramid, no mesh SDF bakes, no atlas"
          : "[gi] SDF-free: requested but INACTIVE — no occupancy field to take the distance from",
      );
    }
    if (volume.sparse) {
      volume.updateSparse();
      console.log(`[gi] sparse field: ${describeSparseField(volume.sparse)}`);
    } else {
      console.log(
        `[gi] sparse field: OFF — coarse cells are ${Math.max(volume.cell.x, volume.cell.y, volume.cell.z).toFixed(2)}m, ` +
          `so anything thinner than ${(Math.max(volume.cell.x, volume.cell.y, volume.cell.z) * 2).toFixed(2)}m cannot block light. ` +
          `Enable it with __giSparseField = true (or the component's Sparse Field prop).`,
      );
    }
    // WATERTIGHTNESS CHECK. The composited field gives thin geometry ONE
    // occupancy shell per side so a wall's lit face and its shadowed face
    // never mix (see cascadeGather's ONE-SIDED notes). That needs at least
    // ~2 cells across the wall. Thinner than that and the two faces collapse
    // into the SAME cell: the sunlit outside and the dark inside become one
    // value, and the interior lights up as if the wall were not there. It
    // reads exactly like "light leaks through walls" — dim, tinted by each
    // surface's own albedo, and completely unresponsive to probe density,
    // because it is a CELL SIZE problem, not a probe problem.
    //
    // Sponza at a 42.9x19.8x27.5m auto-fit gets 0.34m cells, and most of its
    // enclosure is thinner than 0.68m — the whole building is transparent to
    // GI and nothing in the logs said so. Say it, with the number to change.
    // The LARGEST cell axis: an axis clamped by MAX_AXIS_RES has coarser
    // cells than `voxelSize` asked for, and the coarsest axis is the one that
    // decides whether a wall survives.
    const cellSize = Math.max(sizeX / res.x, sizeY / res.y, sizeZ / res.z, 1e-6);
    const thinNames = [];
    let thinCount = 0;
    const thinBox = new THREE.Box3();
    const thinSize = new THREE.Vector3();
    for (const mesh of meshes) {
      if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox?.();
      if (!mesh.geometry?.boundingBox) continue;
      thinBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      thinBox.getSize(thinSize);
      // Thinnest axis of the world-space box — a wall/curtain/panel's depth.
      if (Math.min(thinSize.x, thinSize.y, thinSize.z) < cellSize * 2) {
        thinCount++;
        if (thinNames.length < 6) thinNames.push(mesh.name || "mesh");
      }
    }
    if (thinCount > 0) {
      console.warn(
        `[gi] ${thinCount} of ${meshes.length} meshes are thinner than 2 GI cells (${(cellSize * 2).toFixed(2)}m at voxel ${cellSize.toFixed(2)}m)` +
          `${thinNames.length ? ` — e.g. ${thinNames.join(", ")}` : ""}. ` +
          `The field cannot keep their two faces apart, so they do NOT block light: expect indirect to pass straight through them ` +
          `(a lit exterior wall will light the room behind it). Fix by shrinking the GI volume (currently ` +
          `${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m — smaller volume, same budget, finer cells), raising Quality, ` +
          `or turning Auto Fit off and setting a tighter size around the room that actually needs GI.`,
      );
    }
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
      console.info(
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
  /**
   * Order-sensitive numeric digest of every FIELD input that can change
   * without a composite: analytic light slots, emitter slots, sky radiance,
   * and the live field knobs. Bit-identical hash across frames ⇒ the
   * feedback/trace/merge/probe passes would recompute exactly what they
   * already hold ⇒ safe to idle (see GI_IDLE_AFTER_FRAMES). Runs AFTER
   * #updateLightUniforms/#refreshEmitterSlots each tick, so it digests what
   * the GPU is actually about to read. Cheap: ~100 muls on plain numbers.
   */
  /**
   * Is the awake pipeline running as two alternating halves this frame?
   * Read in two places that must agree — the queue choice and the field EMA's
   * rate compensation — so it lives here rather than being derived twice.
   * `__giPeakSplit` is the live A/B hatch; `state.peakSplit` is the authored
   * prop. Never while the legacy-rate hatch owns the cadence.
   */
  #peakSplitActive(state) {
    if (globalThis.__giLegacyFeedbackRate === true) return false;
    if (!state?.queueFeedbackOnly) return false;
    // `__giNoPeakSplit` (set-to-true) exists alongside `__giPeakSplit` because
    // the harnesses' `HATCH=` mechanism can only set flags TRUE, and the
    // control arm of every A/B needs to turn this OFF.
    if (globalThis.__giNoPeakSplit === true) return false;
    return (globalThis.__giPeakSplit ?? state.peakSplit) === true;
  }

  #fieldInputHash() {
    const state = this.state;
    if (!state) return 0;
    let h = 0;
    let k = 1;
    const mix = (v) => {
      // Golden-ratio spread keeps permuted values from cancelling.
      k = (k * 1.6180339887) % 1024;
      h += v * (k + 1);
    };
    for (const slot of state.lightSlots ?? []) {
      mix(slot.active.value);
      if (slot.active.value < 0.5) continue;
      mix(slot.kind.value);
      const v = slot.vector.value;
      mix(v.x); mix(v.y); mix(v.z);
      const c = slot.color.value;
      mix(c.r); mix(c.g); mix(c.b);
      mix(slot.range.value);
      // The field's own shadow k is derived from this (cascadeGather's
      // per-slot angle), so dragging a sun's Angle slider has to WAKE the
      // pipeline — otherwise the change lands only after something else
      // happens to disturb the scene. `srcRadius`/`giShadow` are deliberately
      // absent: they steer only the screen resolve, which runs every frame
      // regardless of whether the field is asleep.
      mix(slot.soft.value);
    }
    for (const slot of state.emitterSlots ?? []) {
      mix(slot.radius.value);
      if (slot.radius.value <= 0.001) continue;
      const p = slot.center.value;
      mix(p.x); mix(p.y); mix(p.z);
      const c = slot.color.value;
      mix(c.r); mix(c.g); mix(c.b);
      mix(slot.kind.value);
      const half = slot.half.value;
      mix(half.x); mix(half.y); mix(half.z);
    }
    const sky = state.skyRadiance?.value;
    if (sky) { mix(sky.r); mix(sky.g); mix(sky.b); }
    mix(state.bounceGain?.value ?? 0);
    mix(state.temporalBlend?.value ?? 0);
    mix(state.probeSmoothing?.value ?? 0);
    mix(state.fieldSmoothing?.value ?? 0);
    mix(state.fieldShadowOff?.value ?? 0);
    mix(state.shadowJitter?.penAngle?.value ?? 0);
    mix(state.shadowJitter?.angle?.value ?? 0);
    mix(gatherBias.value);
    mix(gatherViewBias.value);
    mix(probeSnapAlpha.value);
    mix(depthMomentsAlpha.value);
    return h;
  }

  #updateLightUniforms() {
    const state = this.state;
    if (!state?.lightSlots) return;
    // `__giFreezeLightInput` — the bisect that separates the only two things
    // left once every lighting TERM has been ruled out (bounce 0, shadows
    // forced open, probe smoothing off, zero composites, zero resizes):
    //   · GI's INPUT jitters — the light direction it reads differs frame to
    //     frame from the one three renders with, so a perfectly smooth GI
    //     oscillates because its argument does.
    //   · GI is NONDETERMINISTIC — same input, different output, i.e. a
    //     read/write hazard between the compute dispatches (the feedback pass
    //     writes `radianceBuffer` while the cascade traces read it, all inside
    //     one submit).
    // Freezing these uniforms holds GI's input EXACTLY constant while three's
    // own direct lighting keeps following the light. GI's contribution then
    // stops responding to the light — expected, ignore it. If it still
    // flickers, the input is innocent and it is a hazard.
    if (globalThis.__giFreezeLightInput && this._lightInputFrozen) return;
    this._lightInputFrozen = !!globalThis.__giFreezeLightInput;
    const lights = this._lightObjects ?? [];
    if (lights.length > MAX_GI_LIGHTS && !this._warnedLightBudget) {
      this._warnedLightBudget = true;
      console.warn(`[gi] ${lights.length} analytic lights; GPU direct covers the first ${MAX_GI_LIGHTS}`);
    }
    for (let i = 0; i < state.lightSlots.length; i++) {
      const slot = state.lightSlots[i];
      const light = lights[i];
      // Checked LIVE (not just at collect cadence) so switching a light off
      // darkens the field the same frame — and via isRenderVisible, so
      // disabling the light's ENTITY counts as off too (see its comment).
      if (!light || !isRenderVisible(light) || light.intensity <= 0) {
        slot.active.value = 0;
        // Cleared alongside, so an off/hidden light stops paying for a
        // whole-screen shadow march the moment it goes dark rather than on
        // the next light-list scan. Its channel then writes the inert 1.
        slot.giShadow.value = 0;
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
      // ── THE GI SHADOW CONTRACT (LightComponent's userData, nothing else) ──
      // Read fresh every frame: the contract is republished on every relevant
      // prop change and this module deliberately never imports LightComponent,
      // so the userData IS the handshake. Absent flags simply read as "map".
      const wantsGi = light.userData?.giShadowMode === "gi" && !!state.screen?.lightShadow;
      slot.giShadow.value = wantsGi ? 1 : 0;
      // ONLY GI-FLAGGED LIGHTS PUBLISH THEIR SIZE. `soft`/`srcRadius` at 0
      // mean "unset", and every consumer falls back to the global sun angle
      // there — which is how a scene that never opted in keeps byte-identical
      // field shadows (see cascadeGather's per-slot k). Angles arrive as a
      // half-angle in radians already (LightComponent halves the authored
      // diameter); 0.0046 rad ≈ the real sun's 0.53° disc, the default a
      // flagged light gets if the contract ever omits the field.
      // FLOORED AT THE REAL SUN (0.0046 rad ≈ 0.53°), not at 0: an authored
      // angle of 0 reaches the resolve as its 0.0005 clamp floor → k = 2000 —
      // a razor ray through a ~12cm-voxel medium, whose verdict flips per
      // voxel-lattice phase and paints white-speckle dithering along every
      // silhouette (harness caught the scene's sun publishing exactly 0).
      // No physical sun is sharper than the real one, so the floor is honest.
      slot.soft.value = wantsGi && light.isDirectionalLight
        ? Math.max(0.0046, light.userData.giSourceAngle ?? 0.0046)
        : 0;
      slot.srcRadius.value = wantsGi && !light.isDirectionalLight
        ? Math.max(0, light.userData.giSourceRadius ?? 0)
        : 0;
    }
    this.#syncLightShadowNodes(lights);
    this.#logLightInput();
  }

  /**
   * Hands every gi-flagged light a persistent `shadow.shadowNode` that samples
   * its channel of the resolve's `lightShadow` texture. three's
   * AnalyticLightNode multiplies the light by whatever sits in that slot AND
   * renders no shadow map for it — the same hook LightComponent's CSM uses, so
   * a gi light costs zero map passes.
   *
   * THREE INVARIANTS, each of them a bug that was paid for once:
   *
   *  · THE NODE IS BUILT ONCE PER LIGHT AND ASSIGNED ONLY WHEN IT CHANGES.
   *    Re-assigning churns the light's shadow branch, and a changed shadow
   *    branch means a material recompile wave — the exact cost this whole
   *    deferred architecture exists to avoid.
   *  · IT IS INERT AT 1, NEVER AT 0. GI absent, disabled, mid-rebuild, slot
   *    dark — all of them must leave the light fully lit. A shadow term that
   *    fails to black is a scene that goes black.
   *  · THE CHANNEL IS A UNIFORM MASK, NOT A BAKED SWIZZLE. Slot indices follow
   *    the collected light list, which reshuffles whenever a light is added,
   *    hidden or dimmed; baking `.x`/`.y` into the node would mean rebuilding
   *    (and recompiling) it on every reshuffle. A dot against a vec4 mask makes
   *    the same change a uniform write.
   */
  #syncLightShadowNodes(lights) {
    const state = this.state;
    const nodes = (this._lightShadowNodes ??= new Map());
    const live = !!state?.screen?.lightShadow && !!this._giLightShadowNode;
    // PCSS inputs, refreshed per frame: the shadow span (world → normalized
    // blocker distances), and the projection scale that turns a world-space
    // penumbra width into a screenUV radius (1 / (2·tan(fov/2))).
    if (live) {
      // `span` is the bundle's diagU — a per-build UNIFORM NODE, not a
      // number. The persistent sampler uniform must copy its NUMERIC value:
      // assigning the node itself makes getNodeUniform choke on type "node"
      // in every material's shadow branch compile.
      const span = state.screen.lightShadow.span;
      if (this._giShadowSpanU) {
        this._giShadowSpanU.value = typeof span === "number" ? span : span?.value ?? 1;
      }
      const cam = this.engine.camera;
      if (this._giShadowFovScaleU && cam?.isPerspectiveCamera) {
        this._giShadowFovScaleU.value = 1 / (2 * Math.tan((cam.fov * Math.PI) / 360));
      }
    }
    // Slot index === channel index === index into the collected light list, by
    // construction — the resolve writes channel i from lightSlots[i], and
    // lightSlots[i] is fed by lights[i] in the loop above.
    const claimed = new Set();
    // Hard-capped at the target's four channels. A slot past the 4th would get
    // an all-zero mask, and an all-zero mask dots to 0 — i.e. a fully BLACK
    // light rather than an unshadowed one. Bounding the loop is the guard.
    const channels = Math.min(4, state?.lightSlots?.length ?? 0);
    for (let i = 0; live && i < channels; i++) {
      const light = lights[i];
      if (!light?.shadow || light.userData?.giShadowMode !== "gi") continue;
      claimed.add(light);
      const entry = this.#acquireLightShadowNode(light);
      entry.mask.value.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0);
      // PCSS blur strength = tan of the source HALF-angle (giSourceAngle is
      // already the half-angle in radians). Directional-only for now — a
      // point light's penumbra scales by srcRadius/dist per pixel, a later
      // refinement. Capped at 60°-half so tan stays sane; NOT the cone
      // estimator's 0.35 clamp — softness beyond it comes from this blur.
      if (entry.blurTan) {
        entry.blurTan.value = light.isDirectionalLight
          ? Math.tan(Math.min(light.userData.giSourceAngle ?? 0.0046, Math.PI / 3))
          : 0;
      }
      // Inert unless the slot is genuinely being traced this frame: a hidden
      // or zero-intensity light keeps its (unwritten) channel, and reading it
      // would shadow with whatever the last live light left there.
      entry.active.value = state.lightSlots[i].giShadow.value > 0.5 ? 1 : 0;
    }
    // Everything else this system ever claimed: either it lost gi mode, or it
    // left the scene. Both hand the light back to three's own shadow maps.
    // A light that is merely HIDDEN or DIMMED is deliberately not in here —
    // it keeps its node at active 0, so toggling visibility costs a uniform
    // write instead of two shadow-branch rebuilds.
    for (const [light, entry] of nodes) {
      if (claimed.has(light)) continue;
      const gone = light.parent === null || light.userData?.giShadowMode !== "gi";
      if (!gone && live) {
        entry.active.value = 0;
        continue;
      }
      this.#releaseLightShadowNode(light, entry);
      nodes.delete(light);
    }
    // Counted over the WHOLE collected list, not the channels above: the point
    // of the warning is precisely the lights that fell off the end.
    const asked = live ? lights.filter((l) => l?.userData?.giShadowMode === "gi").length : 0;
    if (asked > channels && !this._warnedLightShadowCount) {
      this._warnedLightShadowCount = true;
      console.warn(
        `[gi] ${asked} lights ask for gi-traced shadows; only the first ${channels} light slots carry a shadow ` +
          "channel — the rest keep their shadow maps.",
      );
    }
  }

  #acquireLightShadowNode(light) {
    const existing = this._lightShadowNodes.get(light);
    if (existing) return existing;
    const active = uniform(0);
    const mask = uniform(new THREE.Vector4(1, 0, 0, 0));
    // POSITION-VALIDATED BILATERAL UPSAMPLE. The resolve runs at HALF RES,
    // and a silhouette texel's gbuffer P/N belong to whichever surface won
    // the half-res rasterization — its traced value is right for THAT
    // surface and garbage for the neighbor a plain bilinear upsample smears
    // it onto. For a SUN shadow that error is a bright dotted rim on every
    // dark silhouette (the user's "white artifacts"). v1 was a blind min
    // over the 4 taps — right direction (a multiplicative shadow term must
    // err DARK), but dots survived wherever ALL four taps traced a
    // different surface. v2 checks each tap against the gbuffer POSITION at
    // that texel: taps whose world position disagrees with the receiving
    // pixel's own `positionWorld` by more than ~2 half-res texels' world
    // footprint (2% of view distance, floored at 15cm) are REJECTED; the
    // valid taps blend distance-weighted (that is the bilateral), and a
    // pixel whose whole 2×2 neighborhood belongs to other surfaces — a
    // sub-texel-thin banner edge — falls back to the MIN of the taps, dark
    // by policy. The position texture is NearestFilter, so tap validity is
    // per-texel exact, never interpolated across the very edges it guards.
    const texel = (this._giLightShadowTexel ??= uniform(new THREE.Vector2(1 / 512, 1 / 512)));
    const viewDist = positionWorld.sub(cameraPosition).length().toVar();
    const threshold = viewDist.mul(0.02).max(0.15);
    // ── SHARP BASE: the position-validated bilateral upsample (unchanged) ──
    const innerTaps = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([dx, dy]) => {
      const uv = screenUV.add(vec2(texel).mul(vec2(dx, dy)));
      const s = this._giLightShadowNode.sample(uv).dot(vec4(mask));
      const g = this._giShadowPosNode.sample(uv);
      const d = g.xyz.sub(positionWorld).length();
      const w = select(g.w.greaterThan(0.5).and(d.lessThan(threshold)), float(1).div(d.add(0.02)), float(0));
      return { s, w };
    });
    const wSum = innerTaps.reduce((acc, t) => acc.add(t.w), float(0));
    const sBlend = innerTaps.reduce((acc, t) => acc.add(t.s.mul(t.w)), float(0)).div(wSum.max(1e-4));
    // NO-VALID-TAP FALLBACK IS ZERO, not min-of-taps. When every tap belongs
    // to some OTHER surface (thin features, object silhouettes — a spinning
    // prop in front of a shadowed arch), min-of-foreign is only dark if the
    // foreign surface happens to be dark: a SUNLIT foreground painted its
    // full-lit values as a white fringe onto every shadowed silhouette
    // behind it (user screenshot, the exact "still there" dots). A shadow
    // term with no information must fail DARK; the cost is a half-res-thin
    // darkened halo where lit meets lit, which reads as contact shading.
    const sharp = select(wSum.greaterThan(1e-4), sBlend, float(0)).toVar();
    // ── PCSS SOFT DISC (v2 — v1's artifacts were both kernel bugs) ──────
    // Blender sun semantics: penumbra width = tan(source half-angle) ×
    // blocker distance, which the resolve wrote per pixel (the march's own
    // occluder distance — no blocker search estimate needed). v1 ghosted
    // the occluder into 8 shifted copies (an UNROTATED sparse disc is a
    // multi-exposure, not a blur) and mottled on floors (its euclidean tap
    // validation rejects same-plane taps, whose lateral distance is ~the
    // radius by definition). v2: a per-pixel IGN-rotated 12-tap golden
    // spiral — rotation turns undersampling into noise, which reads as
    // softness — with validity measured as distance from the RECEIVER'S
    // PLANE (in-plane taps pass at any radius; cross-silhouette taps fail),
    // plus a small 4-tap max blocker search so the penumbra extends OUTSIDE
    // the geometric shadow instead of clipping at its edge.
    const spanU = (this._giShadowSpanU ??= uniform(1));
    const fovScaleU = (this._giShadowFovScaleU ??= uniform(1.2));
    const blurTan = uniform(0);
    let shadow = sharp;
    if (this._giLightShadowDistNode) {
      const distAt = (uv) => this._giLightShadowDistNode.sample(uv).dot(vec4(mask));
      const t3 = vec2(texel).mul(3).toVar();
      const blockerNorm = distAt(screenUV)
        .max(distAt(screenUV.add(vec2(t3.x, 0))))
        .max(distAt(screenUV.sub(vec2(t3.x, 0))))
        .max(distAt(screenUV.add(vec2(0, t3.y))))
        .max(distAt(screenUV.sub(vec2(0, t3.y))))
        .toVar();
      const penumbraW = blockerNorm.mul(spanU).mul(blurTan).toVar();
      // World width → screenUV fraction: w·fovScale/viewDist, capped at 24
      // half-res texels so a 90° sun cannot blur across the whole frame.
      const radiusUv = penumbraW.mul(fovScaleU).div(viewDist.max(0.05))
        .min(vec2(texel).y.mul(24)).toVar();
      // Interleaved gradient noise → per-pixel spiral rotation.
      const rotA = fract(
        fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715)))
          .mul(52.9829189),
      ).mul(Math.PI * 2).toVar();
      const softW = float(0).toVar();
      const softSum = float(0).toVar();
      const N = normalWorld.toVar();
      for (let k = 0; k < 12; k++) {
        const r = radiusUv.mul(Math.sqrt((k + 0.5) / 12));
        const a = rotA.add(k * 2.399963);
        const uv = screenUV.add(vec2(cos(a), sin(a)).mul(r));
        const s = this._giLightShadowNode.sample(uv).dot(vec4(mask));
        const g = this._giShadowPosNode.sample(uv);
        const rel = g.xyz.sub(positionWorld);
        // Plane-distance validity: |N·rel| small keeps same-surface taps at
        // any lateral distance; the lateral-scaled slack tolerates curvature.
        const planeD = N.dot(rel).abs();
        const lateral = rel.length();
        const ok = g.w.greaterThan(0.5).and(planeD.lessThan(lateral.mul(0.2).add(0.15)));
        softW.addAssign(select(ok, float(1), float(0)));
        softSum.addAssign(select(ok, s, float(0)));
      }
      const soft = select(softW.greaterThan(0.5), softSum.div(softW.max(1)), sharp);
      // Sub-texel radii keep the sharp bilateral bit-exact; the disc fades
      // in as the penumbra grows past a couple of half-res texels.
      const softness = smoothstep(
        vec2(texel).y.mul(0.75),
        vec2(texel).y.mul(3),
        radiusUv,
      );
      shadow = mix(sharp, soft, softness);
    }
    const entry = {
      active,
      mask,
      blurTan,
      node: mix(float(1), shadow, active),
    };
    this._lightShadowNodes.set(light, entry);
    light.shadow.shadowNode = entry.node;
    light.shadow.needsUpdate = true;
    // AnalyticLightNode CACHES the composed shadow branch (`shadowColorNode`)
    // on the light node and only rebuilds it when the light dispatches
    // 'dispose' — its hash is just the light's uuid, so neither a new
    // shadowNode nor a lights-hash purge would ever be noticed. This is the
    // same call LightComponent makes when it swaps a CSM node for the same
    // reason. Fires once per light per transition, not per frame.
    light.dispose?.();
    return entry;
  }

  /** Hands a light back to three's own shadow maps (see #syncLightShadowNodes). */
  #releaseLightShadowNode(light, entry) {
    entry.active.value = 0;
    // `undefined`, not null: three tests `shadow.shadowNode !== undefined` to
    // decide whether a custom node overrides the map lookup, so null would
    // leave the light with a shadow branch of literal null.
    //
    // EXCEPT for a light still FLAGGED gi (system disposed under it): its
    // component froze `shadow.autoUpdate` with a never-rendered map, and a
    // castShadow light with neither map nor custom node crashes three's
    // `updateShadow` (`shadow.map.depthTexture` on null). Hand it the same
    // inert 1 LightComponent boots gi lights with; leaving gi mode rebuilds
    // the light anyway, which restores real maps.
    if (light.shadow && light.shadow.shadowNode === entry.node) {
      light.shadow.shadowNode = light.userData?.giShadowMode === "gi" ? float(1) : undefined;
      light.shadow.needsUpdate = true;
      light.dispose?.();
    }
  }

  /**
   * `__giLogLight` — per-FRAME record of the light direction GI actually used,
   * with nothing frozen. This is the test that survives the mistake made twice
   * above: GI's only light-dependent input is this uniform, so any hatch that
   * holds it still also freezes GI's output, and "no flicker" becomes trivially
   * true. Measuring it instead of freezing it keeps the whole pipeline live.
   *
   * With `bounce` 0, shadows forced open, zero composites and zero target
   * resizes, GI's output is a SMOOTH function of this direction — so if the
   * per-frame angular steps are smooth and monotonic, GI cannot be producing a
   * flicker from them and the artifact is downstream of everything measured so
   * far. Steps that jitter in size, or REVERSE sign while the light turns one
   * way, mean GI is being fed a direction that disagrees with the one three
   * renders with, and the smooth function is simply reporting a jittery input.
   */
  #logLightInput() {
    if (!globalThis.__giLogLight) return;
    const slot = this.state?.lightSlots?.find((s) => s.active.value > 0.5);
    if (!slot) return;
    const v = slot.vector.value;
    const prev = this._lightLogPrev;
    this._lightLogPrev = { x: v.x, y: v.y, z: v.z };
    if (!prev) { this._lightLogSteps = []; return; }
    const dot = Math.min(1, Math.max(-1, prev.x * v.x + prev.y * v.y + prev.z * v.z));
    const step = (Math.acos(dot) * 180) / Math.PI;
    // Signed by the turn direction about the dominant rotation axis, so a
    // genuine reversal is distinguishable from ordinary magnitude noise.
    const cross = prev.y * v.z - prev.z * v.y;
    (this._lightLogSteps ??= []).push(cross >= 0 ? step : -step);
    if (this._lightLogSteps.length < 120) return;
    const s = this._lightLogSteps;
    this._lightLogSteps = [];
    const mag = s.map(Math.abs);
    const mean = mag.reduce((a, b) => a + b, 0) / mag.length;
    let reversals = 0;
    for (let i = 1; i < s.length; i++) if (s[i] * s[i - 1] < 0 && mag[i] > mean * 0.1) reversals++;
    const still = mag.filter((m) => m < mean * 0.05).length;
    console.log(
      `[gi] light step over 120 frames: mean ${mean.toFixed(4)}deg, ` +
        `min ${Math.min(...mag).toFixed(4)}, max ${Math.max(...mag).toFixed(4)}, ` +
        `reversals ${reversals}, near-zero steps ${still} — ` +
        `a smoothly turning light gives a steady mean, 0 reversals and 0 near-zero steps`,
    );
  }

  #dispose() {
    const state = this.state;
    if (!state) return;
    this.state = null;
    // GI-traced shadows die WITH the system, and this cannot wait for the next
    // light sync: that sync runs off `this.state`, which is now null, so a
    // light left holding our shadowNode would sample a texture nothing writes
    // any more — and would never be handed back to its own shadow map.
    for (const [light, entry] of this._lightShadowNodes ?? []) {
      this.#releaseLightShadowNode(light, entry);
    }
    this._lightShadowNodes?.clear();
    state.volume?.dispose?.();
    state.bvhScene?.dispose?.();
    // The gbuffer is per-build; the resolve TARGETS are not (see
    // createGiTargets) — disposing them here would strand every material that
    // is still bound to them. Same rule for the BVH reflect target
    // (`_giBvhTarget`, see `#syncBvhScene`) — it is not touched here either.
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
    if (state.bleedSaturation) {
      state.bleedSaturation.value = Math.min(1, Math.max(0, this.component?.props.bleedSaturation ?? 1));
    }
    state.temporalBlend.value = Math.min(1, Math.max(0.02, this.component?.props.temporalBlend ?? 0.25));
    state.probeSmoothing.value = clampProbeSmoothing(this.component?.props.probeSmoothing);
    // Sky radiance = colour x intensity, in the same linear units as an
    // emitter's. Default intensity 0 means "no sky", which is byte-identical
    // to the behaviour before this existed — every sealed-room baseline is
    // unaffected until someone dials it up.
    if (state.skyRadiance) {
      const props = this.component?.props;
      const intensity = Math.max(0, props?.skyIntensity ?? 0);
      state.skyRadiance.value.set(props?.skyColor ?? "#ffffff").multiplyScalar(intensity);
    }
    // Indirect-AO knobs (giScreen's obscurance ladder) — live uniforms; the
    // resolve runs every frame (even in idle sleep), so edits land next frame.
    if (state.screen?.ao) {
      const props = this.component?.props;
      state.screen.ao.strength.value = Math.min(1, Math.max(0, props?.aoStrength ?? 0.6));
      state.screen.ao.radius.value = Math.min(3, Math.max(0.1, props?.aoRadius ?? 0.6));
    }
  }

  #applyDebugVisibility() {
    const state = this.state;
    if (!state) return;
    const mode = this.component?.props.debugProbes ?? "off";
    state.gizmos.raw.visible = mode === "raw";
    state.gizmos.merged.visible = mode === "merged";
    if (state.gizmos.sdfView) state.gizmos.sdfView.visible = mode === "sdf";
    if (state.gizmos.occView) state.gizmos.occView.visible = mode === "occupancy";
  }

  // -------------------------------------------------------------------------
  // Entries: one per GI mesh, carrying the bake-resolved surface + content
  // identity. Promotion: the brightest emissive meshes become analytic
  // sphere area lights — their emissive leaves the composited field (the
  // geometry stays, as occluder/albedo) and per-frame uniform slots carry
  // their light instead, so a moving lamp stays smooth and bake-free.

  /**
   * The meshes granted a 128³ hi-res SDF this build. Candidates are BAKED
   * (non-analytic) meshes that are complex OR physically large — judged PER
   * SUB-MESH, because GLB characters arrive split into many primitives that
   * individually sit far below any whole-model triangle count. Ranked by
   * tris and capped at 12 grants (12 blocks = 96 of 128 tiles) so blocks
   * can never exhaust the atlas or flap between syncs.
   */
  #selectHiResMeshes(meshes) {
    const granted = new Set();
    if (globalThis.__giNoHiResSdf) return granted;
    const scratch = new THREE.Vector3();
    const candidates = [];
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const position = geometry?.attributes?.position;
      if (!position) continue;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (analyticShapeOf(geometry, material)) continue; // exact already
      const tris = (geometry.index?.count ?? position.count) / 3;
      if (tris < 1500) continue;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      mesh.getWorldScale(scratch);
      const span = bb
        ? Math.max(
            (bb.max.x - bb.min.x) * Math.abs(scratch.x),
            (bb.max.y - bb.min.y) * Math.abs(scratch.y),
            (bb.max.z - bb.min.z) * Math.abs(scratch.z),
          )
        : 0;
      if (tris >= 8000 || span >= 2.5) candidates.push({ mesh, tris });
    }
    candidates.sort((a, b) => b.tris - a.tris);
    for (const candidate of candidates.slice(0, 12)) granted.add(candidate.mesh);
    if (granted.size && globalThis.__giVerbose) {
      // Legacy wording from the bake era — the grant now only prioritises
      // detail slots, no 128³ texture exists. Verbose-only until the
      // detail-slot machinery is retired with the emissive-shadow rework.
      const names = [...granted].map((m) => m.name || "mesh").join(", ");
      console.log(`[gi] hi-res 128³ SDFs (${granted.size}): ${names}`);
    }
    return granted;
  }

  /**
   * Placements a mesh contributes: `[null]` for a plain mesh (itself), or one
   * instance index per live InstancedMesh instance. `mesh.count` is the
   * DRAWN count, which is what the field should match — instances parked
   * beyond it are not on screen and must not cast.
   */
  #placementsOf(mesh) {
    if (!mesh.isInstancedMesh) return [null];
    const count = Math.min(mesh.count ?? 0, MAX_INSTANCES_PER_MESH);
    if ((mesh.count ?? 0) > MAX_INSTANCES_PER_MESH && !this._warnedInstanceCap?.has(mesh)) {
      (this._warnedInstanceCap ??= new WeakSet()).add(mesh);
      console.warn(
        `[gi] "${mesh.name || "InstancedMesh"}" has ${mesh.count} instances; ` +
          `the first ${MAX_INSTANCES_PER_MESH} occupy SDF slots, the rest receive GI but do not cast`,
      );
    }
    return Array.from({ length: count }, (_, i) => i);
  }

  #buildEntries(meshes) {
    const entries = [];
    for (const mesh of meshes) {
      const placements = this.#placementsOf(mesh);
      if (!placements.length) continue;
      const surface = resolveMaterialSurface(mesh.material, mesh.name);
      const r = surface.emissive.r * surface.emissiveIntensity;
      const g = surface.emissive.g * surface.emissiveIntensity;
      const b = surface.emissive.b * surface.emissiveIntensity;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const tris = (geometry.index?.count ?? position.count) / 3;
      let analytic = analyticShapeOf(
        geometry,
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      );
      // SDF-FREE: EVERY MESH STILL NEEDS A SLOT, and a slot only becomes ACTIVE
      // (`aabbMin.w = 1`) when it receives a baked grid or an analytic shape.
      // With no bakes, a scene of ordinary meshes ends up with ZERO active
      // slots — which costs far more than a distance field, because an inactive
      // slot has no AABB for the composite to attribute a cell to and carries
      // no mean albedo. **Indirect light is albedo**, so the whole bounce term
      // goes to zero: direct light, and nothing else. That is exactly the
      // reported "almost pitch black, no indirect".
      //
      // A bounding BOX is the right stand-in. It costs no bake, gives the
      // composite a real AABB and the slot's colours, and its DISTANCE — the
      // one part that would be a crude lie — is never sampled in this mode:
      // the composite takes distance from the occupancy oracle and both traces
      // do too (see giField's `killSdf`), so nothing ever calls `sampleSlot`.
      if (!analytic && this.#killSdfEnabled()) {
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        if (bb) {
          analytic = {
            type: "box",
            center: [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2],
            half: [
              Math.max((bb.max.x - bb.min.x) / 2, 1e-4),
              Math.max((bb.max.y - bb.min.y) / 2, 1e-4),
              Math.max((bb.max.z - bb.min.z) / 2, 1e-4),
            ],
          };
        }
      }
      if (analytic) {
        for (const instanceId of placements) {
          entries.push({
            mesh, instanceId, key: slotKeyOf(mesh, instanceId),
            surface, tris, luminance, r, g, b, analytic,
            contentKey: null, sdfPath: null, promoted: false,
          });
        }
        continue;
      }
      // No bake pipeline any more — a mesh that reaches here (no fitted
      // primitive) gets nothing extra; #buildEntries' killSdf path above
      // synthesizes an analytic bounding box for it, so this branch exists
      // only for the no-occupancy-device fallback. contentKey remains the
      // instances-share-a-slot identity.
      const hiRes = this._hiResMeshes?.has(mesh) === true;
      const contentKey = contentKeyOf(geometry, hiRes);
      for (const instanceId of placements) {
        entries.push({
          mesh, instanceId, key: slotKeyOf(mesh, instanceId),
          surface, tris, luminance, r, g, b, hiRes,
          contentKey, promoted: false,
        });
      }
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
      // ONE emitter per MESH. An emitter slot is described by its mesh's own
      // world transform (`#refreshEmitterSlots` reads `mesh.matrixWorld`), so
      // an InstancedMesh's instances would all promote to the same box at the
      // prototype's position — MAX_EMITTERS duplicates of one lamp, and the
      // real lamps in the scene pushed out of the budget by them. Instanced
      // emissive geometry still emits through the FIELD (its emissive is
      // composited per instance); it just does not get an analytic slot.
      const seenEmitterMesh = new Set();
      const bright = entries
        .filter((entry) => entry.luminance >= 0.5 && !entry.mesh.isInstancedMesh)
        .sort((a, b) => powerOf(b) - powerOf(a));
      if (bright.length > MAX_EMITTERS && !this._warnedEmitterBudget) {
        this._warnedEmitterBudget = true;
        console.warn(`[gi] ${bright.length} bright emitters; analytic slots cover the brightest ${MAX_EMITTERS}`);
      }
      for (const entry of bright) {
        if (this._emitterInfos.length >= MAX_EMITTERS) break;
        if (seenEmitterMesh.has(entry.mesh)) continue;
        seenEmitterMesh.add(entry.mesh);
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
    // Keyed by PLACEMENT (mesh, or mesh+instance index), and a Map rather
    // than the old findIndex-per-entry: that scan was O(entries × capacity),
    // which was invisible at 128 slots and is not at 512 with instancing.
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const slotOfKey = new Map();
    for (let i = 0; i < atlas.assignments.length; i++) {
      const assignment = atlas.assignments[i];
      if (!assignment) continue;
      if (byKey.has(assignment.key)) slotOfKey.set(assignment.key, i);
      else atlas.clearSlot(i);
    }
    let overflow = 0;
    let tileOverflow = 0;
    for (const entry of entries) {
      const existing = slotOfKey.get(entry.key);
      if (existing !== undefined) {
        atlas.setSlotSurface(existing, this.#slotSurface(entry));
        continue;
      }
      // Analytic primitives seat immediately — no bake, no cache, no file,
      // and no tile at all, so instancing them is free.
      if (entry.analytic) {
        const free = atlas.allocateSlot();
        if (free < 0) {
          overflow++;
          continue;
        }
        atlas.setAnalyticSlot(free, entry.mesh, entry.analytic, this.#slotSurface(entry), entry.instanceId);
        slotOfKey.set(entry.key, free);
        continue;
      }
      // No bakes exist (the SDF pipeline is deleted): a non-analytic entry
      // never seats a grid. Under the occupancy backend #buildEntries gives
      // every such mesh an analytic box, so this is the no-occupancy-device
      // fallback only — the mesh stays out of the composite rather than
      // waiting for a bake that will never arrive. (The tile-seating path —
      // atlas.setSlot with a baked grid, hi-res 2×2×2 tile blocks, tile
      // overflow accounting — was deleted with the pipeline.)
      continue;
    }
    if (tileOverflow > 0) overflow += tileOverflow;
    if (overflow > 0) {
      // ONE rebuild attempt per (entry count, capacity) situation. An
      // unconditional request looped forever when the rebuilt atlas
      // reproduced the exact same packing failure — build, overflow,
      // build, overflow, at ~3s per compile wave.
      const overflowSig = `${entries.length}:${atlas.capacity}:${atlas.tileCapacity}`;
      // Retry only while a bigger tier could actually help: instance
      // overflow needs headroom under MAX_INSTANCE_SLOTS, tile overflow
      // under MAX_MESH_SDF_SLOTS. Asking for a rebuild that must fail the
      // same way is the loop this signature guards against.
      const canGrow = tileOverflow > 0
        ? atlas.tileCapacity < MAX_MESH_SDF_SLOTS
        : atlas.capacity < MAX_INSTANCE_SLOTS;
      if (canGrow && this._overflowRebuildSig !== overflowSig) {
        this._overflowRebuildSig = overflowSig;
        this.requestRebuild();
      } else if (!this._warnedSlotBudget) {
        this._warnedSlotBudget = true;
        console.warn(
          `[gi] ${overflow} of ${entries.length} placements could not seat ` +
            (tileOverflow > 0
              ? `(${tileOverflow} lacked a free atlas tile of ${atlas.tileCapacity}) `
              : `(instance slots ${atlas.capacity}) `) +
            `— they are invisible to GI`,
        );
      }
    } else {
      this._overflowRebuildSig = null;
      this._warnedSlotBudget = false;
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
      .map((entry) => ({ entry, slot: slotOfKey.get(entry.key) ?? -1 }))
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
    // RESERVE up to two slots for the densest baked meshes. Walls still come
    // first (dropping one reopens sub-cell leak paths), but a wall-heavy
    // room used to consume the WHOLE budget — the character's hi-res SDF
    // was resident yet never sampled, so its shadows stayed field-coarse.
    const denseReserve = Math.min(2, dense.length);
    const picked = [
      ...thinWalls.slice(0, Math.max(0, budget - denseReserve)),
      ...dense,
      ...thinWalls.slice(Math.max(0, budget - denseReserve)),
    ].slice(0, budget);
    atlas.setDetailSlots(picked.map((d) => d.slot));
    // SAME ranking, published per slot for the instance grid — which spends
    // this budget PER CELL rather than scene-wide. A cell keeps the highest
    // ranked slots it is offered, so the ordering that used to decide "which
    // 12 slots in the level" now decides "which few of the slots near this
    // point", and the losers are only ever things that are far away.
    const priority = new Float32Array(atlas.capacity);
    for (const d of thinWalls) priority[d.slot] = 3;
    for (const d of dense) priority[d.slot] = 2 - Math.min(1, 1 / Math.max(1, d.entry.tris / 1000));
    atlas.slotPriority = priority;
    atlas.grid?.invalidate();
    const pickedNames = picked
      .map((d) => `${d.entry.mesh.name || "mesh"}${d.entry.hiRes ? "*" : ""}`)
      .join(", ");
    if (pickedNames !== this._lastDetailLog && globalThis.__giVerbose) {
      this._lastDetailLog = pickedNames;
      // With the instance grid live the budget is spent PER CELL, so the
      // scene-wide "over budget" count is not a shortfall any more — the
      // named slots are only the fallback list. Saying "raise Quality" when
      // the ray is already refining against its own neighbourhood would send
      // people after a setting that no longer buys them anything.
      const over = thinWalls.length + dense.length - budget;
      console.log(
        `[gi] detail slots (${picked.length}/${budget}, * = 128³ hi-res): ${pickedNames || "none"}` +
          (atlas.grid
            ? ` — ${budget} refined per ray position from the instance grid`
            : over > 0
              ? ` — ${over} more candidates over budget (raise Quality)`
              : ""),
      );
    }
    this.#refreshOccupancySlotRemap();
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
    const col = new THREE.Vector3();
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
        slot.kind.value = 0;
        slot.reff.value = shape.radius;
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
      // SHAPE. Full spheres keep the exact sphere model; EVERYTHING ELSE is
      // an oriented box from the geometry's local AABB carried through
      // matrixWorld — strictly closer than a bounding sphere for any
      // non-spherical lamp, and exact for the box/plane primitives users
      // actually make lamps from ("my cube's reflection is a sphere").
      const params = geometry.parameters;
      const fullSphere =
        geometry.type === "SphereGeometry" &&
        (params?.phiLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3 &&
        (params?.thetaLength ?? Math.PI) > Math.PI - 1e-3;
      // A/B escape hatch (dev/harness only): force the legacy sphere model.
      if (fullSphere || globalThis.__giSphereEmitters) {
        slot.kind.value = 0;
        slot.reff.value = slot.radius.value;
        continue;
      }
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      slot.kind.value = 1;
      slot.center.value
        .set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
        .applyMatrix4(info.mesh.matrixWorld);
      // World OBB: matrixWorld columns are the local axes scaled — axis =
      // column/|column|, world half-extent = localHalf·|column|. Exact for
      // any TRS (nested shear is out of scope). Tiny floor so a plane's
      // zero axis stays numerically safe in the slab/SDF math.
      const e = info.mesh.matrixWorld.elements;
      const axes = [slot.bx.value, slot.by.value, slot.bz.value];
      const halfLocal = [
        (bb.max.x - bb.min.x) / 2,
        (bb.max.y - bb.min.y) / 2,
        (bb.max.z - bb.min.z) / 2,
      ];
      const halfWorld = [0.005, 0.005, 0.005];
      for (let a = 0; a < 3; a++) {
        col.set(e[a * 4], e[a * 4 + 1], e[a * 4 + 2]);
        const len = col.length();
        if (len > 1e-8) axes[a].copy(col).divideScalar(len);
        else axes[a].set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
        halfWorld[a] = Math.max(halfLocal[a] * len, 0.005);
      }
      slot.half.value.set(halfWorld[0], halfWorld[1], halfWorld[2]);
      // Mean projected area of a convex body is surface/4 (Cauchy) — the
      // disc-equivalent radius drives penumbra k and glow energy.
      const [hx, hy, hz] = halfWorld;
      slot.reff.value = Math.sqrt(((hx * hy + hy * hz + hz * hx) * 2) / Math.PI);
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
      // `cameraHidden` = hidden by LOD/occlusion only (see Engine's visibility
      // resolve): the mesh is still part of the world, so it must stay in the
      // field or the GI mesh set becomes a function of the camera.
      if (object.visible === false && !object.userData.batchedInto && !object.userData.cameraHidden) return;
      // InstancedMesh IS collected now — it contributes one atlas instance
      // slot per live instance, all sharing a single baked tile (see
      // #buildEntries). It used to be skipped outright, which meant every
      // instanced prop in a scene was simply absent from the GI field: no
      // shadow, no bounce, no reflection, and a hole in the occupancy the
      // cascades happily traced light through.
      if (object.isMesh && !object.userData.__giDebug) {
        const position = object.geometry?.attributes?.position;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const triCount = (object.geometry?.index?.count ?? position?.count ?? 0) / 3;
        // Editor-only helpers live on layer 31 (mask compared unsigned —
        // 1<<31 is negative in JS int32). UI quads are excluded for the same
        // reason: they are screen furniture, and a screen-space one sits at
        // the world origin at pixel scale, so voxelizing it would blow the
        // field's bounds out to hundreds of metres of empty air.
        const editorOnly =
          (((object.layers.mask >>> 0) & 0x80000000) !== 0 && (object.layers.mask >>> 0) === 0x80000000) ||
          object.layers.isEnabled(UI_LAYER);
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
          const bucket = m ? giRoughnessBucketOf(m) : 2;
          if (m && !seenMaterials.has(m)) {
            seenMaterials.add(m);
            tally[bucket]++;
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
      if ((object.isDirectionalLight || object.isPointLight) && isRenderVisible(object) && object.intensity > 0) {
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
    this.#syncBvhScene(entries);
    // And the occupancy pyramid, which is what transport rays actually
    // intersect — see #refreshOccupancyContent for why this was missing.
    this.#refreshOccupancyContent(meshes);
  }

  /**
   * Applies new auto-fit bounds WITHOUT a rebuild: every world-space shader
   * input is a uniform (see createGiField's world bundle), so a refit is a
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
    const occView = state.gizmos?.occView;
    if (occView) {
      occView.position.copy(state.center);
      occView.scale.set(size.x / state.buildSize.x, size.y / state.buildSize.y, size.z / state.buildSize.z);
    }
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
      // Instance count and matrix version: adding, removing or re-scattering
      // instances changes which slots exist, and nothing else here would
      // notice (the mesh id, geometry and material are all unchanged).
      // Per-instance MOVEMENT is picked up by refreshTransforms every frame;
      // this is only about the set of placements.
      if (mesh.isInstancedMesh) {
        mix(mesh.count ?? 0);
        mix(mesh.instanceMatrix?.version ?? 0);
      }
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

  /**
   * The conservative occupancy pyramid, or null when the legacy SDF backend is
   * selected. Independent of the atlas on purpose: it needs only geometry and
   * world matrices, never a baked SDF, so it is READY ON FRAME ONE while mesh
   * SDF bakes are still streaming in asynchronously.
   *
   * VOXEL SIZE is budgeted, not fixed at the spec's 0.125m: a bitset is cheap
   * (a 42m Sponza at 0.125m is 1.6 MB) but not free, and a 400m terrain at
   * 0.125m would be 1.4 GB. The quality tier picks a TARGET and the budget is a
   * ceiling, so a bigger world degrades to coarser voxels instead of failing to
   * allocate — the same contract the SDF field's own auto-fit densities use.
   */
  #buildOccupancyField(props, meshes, bounds, size, quality, rayHitConfig) {
    // A SAVED `backend` OTHER THAN "occupancy" IS COERCED, NOT HONOURED. The
    // sdf-legacy transport backend was deleted (session 15b) but scenes saved
    // before that still carry `backend: "sdf-legacy"` — and honouring it
    // means returning null here, which with the bake pipeline also deleted
    // leaves NO transport at all: GI builds, logs happily, and contributes
    // exactly zero light. That state shipped — the user's own Sponza scene
    // had the stale value saved, and every harness measurement against it
    // quietly measured an empty field ("intensity 100 changes nothing", the
    // failed-CONTROL signature). Same trap as the exactReflections
    // structural-signature fix: a stored value under a changed control is a
    // behaviour change. `__giBackend` stays only as a diagnostic kill switch
    // ("none" disables the field explicitly and owns the consequences).
    const backend = globalThis.__giBackend ?? props.backend ?? "occupancy";
    if (backend !== "occupancy") {
      if (globalThis.__giBackend !== undefined && backend !== "occupancy") {
        console.warn(`[gi] __giBackend="${backend}" — occupancy field disabled by hatch, GI transport will be EMPTY`);
        return null;
      }
      console.warn(
        `[gi] saved backend "${backend}" no longer exists (sdf-legacy was removed) — using occupancy. ` +
          "Re-save the scene to clear this.",
      );
    }

    // Portable WebGPU baseline only. The fully composed cascade graph is
    // runtime-smoked at maxStorageBuffersPerShaderStage=8; never disable this
    // path or request a larger device limit to hide a binding regression.

    // Spec §1.1: 0.10–0.15m, "not 0.35 — sub-voxel sheets were the root cause
    // of the blob/leak artifacts". Low/medium relax it for cost.
    const target = { low: 0.25, medium: 0.175, high: 0.125, ultra: 0.1 }[quality] ?? 0.125;
    const budget = { low: 16e6, medium: 32e6, high: 64e6, ultra: 128e6 }[quality] ?? 64e6;
    const volume = size.sizeX * size.sizeY * size.sizeZ;
    const voxelSize = Math.max(target, Math.cbrt(volume / budget));
    const res = quantizeOccupancyRes({
      x: Math.max(16, Math.round(size.sizeX / voxelSize)),
      y: Math.max(16, Math.round(size.sizeY / voxelSize)),
      z: Math.max(16, Math.round(size.sizeZ / voxelSize)),
    });

    const { geometries, placements } = this.#occupancyContentOf(meshes);

    // `bounds` is the SAME object createGiField will hold and mutate in
    // `setBounds`, which is what makes `field.refit()` able to re-derive the
    // pyramid's origin and voxel size from it after an in-place refit.
    //
    // HEADROOM ON THE SLOT CAPACITY, because the mesh set GROWS after this
    // runs: GLB models finish loading seconds later and arrive through the
    // fingerprint scan, and `#refreshOccupancyContent` re-uploads them into
    // this same field. Sizing the capacity exactly to the meshes present at
    // build time would leave every late arrival with nowhere to go.
    const field = createOccupancyField(bounds, res, {
      slotCapacity: Math.min(MAX_INSTANCE_SLOTS, Math.max(64, placements.length * 2)),
      traceSteps: { low: 48, medium: 64, high: 96, ultra: 128 }[quality] ?? 96,
      enableProfiling: rayHitConfig?.enableProfiling === true,
      countLegacyFallbacks: rayHitConfig?.fallbackToLegacy === true,
      enableHybridBrick: (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) >= RayHitMode.HybridBrickBox &&
        (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) <= RayHitMode.HybridExactComplex,
      // Phase 2/3: fitted simple-plane records (+ coverage masks) appended to
      // the occupancy allocation. All plane-family modes build the same
      // records; the coverage clip and the exact-triangle fallback are
      // trace-time variants.
      enableSurfaceRecords: (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) >= RayHitMode.HybridPlane &&
        (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) <= RayHitMode.HybridExactComplex,
      // Phase 4: complex cells store short exact triangle lists in the same
      // allocation instead of degrading to occupied-box hits.
      enableComplexTriangles: rayHitConfig?.activeMode === RayHitMode.HybridExactComplex,
      // Phase 5: the conservative pyramid ride is the DEFAULT, so `!== false`
      // (not `=== true`) — a caller with no rayHitConfig at all still gets the
      // skip; only an explicit opt-out compiles the no-skip A/B arm.
      rayHitCoarseSkip: rayHitConfig?.enableSkipDistance !== false,
    });
    for (const p of placements) field.setSlotMatrix(p.slot, p.matrix);
    field.setGeometry(geometries, placements);
    field.placements = placements;
    return field;
  }

  /**
   * Unique geometries (deduped by content identity, so 200 crates ship one
   * triangle range) + one placement per world instance.
   */
  #occupancyContentOf(meshes) {
    const geometries = [];
    const seen = new Set();
    const placements = [];
    const scratch = new THREE.Matrix4();
    for (const mesh of meshes) {
      const record = serializeMeshForBake(mesh);
      if (!record) continue;
      if (!seen.has(record.geometryKey)) {
        seen.add(record.geometryKey);
        geometries.push({ key: record.geometryKey, positions: record.positions, index: record.index });
      }
      for (const instanceId of this.#placementsOf(mesh)) {
        if (placements.length >= MAX_INSTANCE_SLOTS) break;
        const matrix = new THREE.Matrix4();
        if (instanceId == null || !mesh.isInstancedMesh) {
          matrix.copy(mesh.matrixWorld);
        } else {
          mesh.getMatrixAt(instanceId, scratch);
          matrix.copy(scratch).premultiply(mesh.matrixWorld);
        }
        placements.push({ slot: placements.length, geometryKey: record.geometryKey, matrix, mesh, instanceId });
      }
    }
    return { geometries, placements };
  }

  /**
   * Re-voxelizes the pyramid for a CHANGED MESH SET (not a changed transform —
   * that is `#refreshOccupancyTransforms`).
   *
   * WITHOUT THIS, LATE-LOADING MESHES NEVER ENTER THE TRANSPORT FIELD AT ALL.
   * Occupancy geometry was uploaded once, inside `#buildOccupancyField`, i.e.
   * only on a full rebuild — while the mesh-SDF path picks up new meshes every
   * fingerprint scan. So a GLB that finished loading after the build was in the
   * SDF atlas and absent from the pyramid, which is the thing every transport
   * ray actually intersects.
   *
   * It was survivable while the composited SDF still carried a distance. In
   * SDF-free mode the pyramid is the ONLY source of both distance and
   * occupancy, so the same gap presents as **no GI at all on a fresh launch** —
   * the field is empty, so nothing is occupied, so nothing bounces.
   */
  #refreshOccupancyContent(meshes) {
    const field = this.state?.volume?.occupancyField;
    if (!field) return;
    const { geometries, placements } = this.#occupancyContentOf(meshes);
    if (placements.length > field.slotCapacity) {
      // Capacity is a buffer size fixed at creation — growing past it is one of
      // the few things that genuinely needs the rebuild.
      console.log(`[gi] occupancy: ${placements.length} placements exceeds capacity ${field.slotCapacity} — rebuilding`);
      this.requestRebuild();
      return;
    }
    for (const p of placements) field.setSlotMatrix(p.slot, p.matrix);
    field.setGeometry(geometries, placements);
    field.placements = placements;
    this.#refreshOccupancySlotRemap();
  }

  /**
   * Uploads the occupancy-slot → atlas-slot bridge (occupancyField.slotAtlas).
   * The two numberings are assigned independently — placements by mesh-walk
   * order, atlas slots by #syncSlots capacity/priority — which is exactly the
   * crossed-numbering bug that once fed the composite a different mesh's
   * colour and got cellAttr disabled there. Runs after every #syncSlots and
   * after every occupancy content refresh: the two points where either
   * numbering can change.
   */
  #refreshOccupancySlotRemap() {
    const field = this.state?.volume?.occupancyField;
    const atlas = this.state?.atlas;
    if (!field?.placements || !atlas?.assignments || !field.setSlotAtlas) return;
    const slotOfKey = new Map();
    for (let i = 0; i < atlas.assignments.length; i++) {
      const a = atlas.assignments[i];
      if (a?.key != null) slotOfKey.set(a.key, i);
    }
    for (const p of field.placements) {
      field.setSlotAtlas(p.slot, slotOfKey.get(slotKeyOf(p.mesh, p.instanceId)) ?? -1);
    }
  }

  /**
   * Re-reads live world matrices into the pyramid's slot uniforms. This is the
   * drag path, and it is deliberately a uniform update + redispatch rather than
   * a geometry reupload: chunk counts were computed rotation-invariantly, so
   * nothing on the CPU has to be rebuilt when something moves.
   */
  #refreshOccupancyTransforms(field) {
    if (!field?.placements) return;
    const scratch = new THREE.Matrix4();
    for (const p of field.placements) {
      const { mesh, instanceId } = p;
      let changed = false;
      if (instanceId == null || !mesh.isInstancedMesh) {
        changed = !p.matrix.equals(mesh.matrixWorld);
        if (changed) p.matrix.copy(mesh.matrixWorld);
      } else {
        mesh.getMatrixAt(instanceId, scratch);
        scratch.premultiply(mesh.matrixWorld);
        changed = !p.matrix.equals(scratch);
        if (changed) p.matrix.copy(scratch);
      }
      if (changed) {
        // Static/dynamic split (occupancyField.staticBits): flag the mover
        // DYNAMIC *before* the matrix write — the flag flip re-snapshots the
        // static side once, and every further frame of this motion replays
        // that snapshot + re-voxelizes only this slot (the measured
        // +3.3/+5.2ms-per-frame full-scene pass gone). Demotion below has a
        // quiet-period hysteresis so a stop-start animation doesn't thrash
        // full re-voxelizes.
        field.setSlotDynamic?.(p.slot, true);
        field.setSlotMatrix(p.slot, p.matrix);
        p._lastMovedFrame = this._frame;
      } else if (
        p._lastMovedFrame != null &&
        this._frame - p._lastMovedFrame > OCC_DYNAMIC_QUIET_FRAMES
      ) {
        field.setSlotDynamic?.(p.slot, false);
        p._lastMovedFrame = null;
      }
    }
  }

  /** Debug "Occupancy" view: a volume box hierarchical-DDA-ing the pyramid. */
  #buildOccupancyView(volume, bounds, center) {
    if (!volume.occupancyField) return null;
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      createOccupancyDebugMaterial(volume),
    );
    mesh.position.copy(center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9999;
    mesh.userData.__giDebug = true;
    return mesh;
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
