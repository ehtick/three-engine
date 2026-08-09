// SPLIT RADIANCE CASCADES — the probe gizmos.
//
// Plan §7 Phase 1: "debug gizmos (instanced spheres colored by cascade/LOD)",
// and the eye check that closes the phase. This is the instrument for the two
// questions no numeric gate can settle — "are the probes WHERE the geometry
// is" and "do the LOD rings look like rings" — on a real scene, at a real
// camera, in motion.
//
// ══ READ ON THE GPU, NEVER READ BACK ═══════════════════════════════════════
//
// The probe table lives in a storage buffer, and the obvious way to draw it is
// to read it back each frame and write instance matrices. That is 2.5 MB per
// frame at a realistic probe count and it makes the debug view lag the thing it
// is debugging by exactly one readback — which, for a view whose whole job is
// to show membership CHURN, would hide the artifact.
//
// So the vertex stage reads the table directly: one `InstancedMesh` per
// cascade, `positionNode` deriving each probe's world position from its own
// KEY, and a dead probe collapsing to radius zero. Nothing crosses the bus and
// the gizmos are exactly as current as the frame they annotate.
//
// ══ THE STANDING RULE, INHERITED FROM srcDebugViews.js ═════════════════════
//
// A debug view that renders a different field than the traces do lies about the
// thing it exists to show. These spheres are placed by `srcMathTsl`'s OWN
// `keyCell`/`latticeOrigin`/`cellPosition`/`probeSpacing` — the same functions
// `srcProbes.js` inserts with, gated bit-exact against the CPU mirror by
// `test:gi-src-math`. A gizmo that re-derived the lattice would be a second
// definition of where a probe is, and the first thing it would do is disagree
// silently.
//
// `three/webgpu`, not `three`: the node materials only exist on the WebGPU
// entry point, and `new THREE.MeshBasicNodeMaterial()` off the base build
// throws "is not a constructor" at RENDER time, not at import.

import * as THREE from "three/webgpu";
import { cameraPosition, float, instanceIndex, positionLocal, select, uint, vec3, vec4 } from "three/tsl";
import { MAX_LODS } from "./srcConfig.js";
import { FLAG_ALIVE, FLAG_FRESH, PROBE_FLAGS, PROBE_KEY, PROBE_WORDS } from "./srcProbes.js";
import { cellPosition, keyCell, keyLod, latticeOrigin, probeSpacing } from "./srcMathTsl.js";

/**
 * Sphere radius as a fraction of the probe's own spacing.
 *
 * Proportional, not fixed, and that IS the LOD instrument: a probe's spacing
 * doubles with every LOD, so the spheres visibly grow with distance and the
 * rings read as rings without needing a legend. A fixed radius would make the
 * far cascades an unreadable dust cloud and hide the exact structure this view
 * is for.
 */
const RADIUS_FRACTION = 0.14;

/**
 * Hard ceiling on a sphere's radius, as a fraction of its distance to the eye
 * — i.e. an angular size cap.
 *
 * The proportional radius above is unbounded, and at cascade 3, LOD 8 a probe's
 * spacing is s₀·2³·2⁸ ≈ 900 m, so its "gizmo" is a 125-metre ball. The first
 * run of this view filled 9216 of 9216 sampled pixels — a debug overlay that
 * paints the entire frame, which is worse than no overlay because it looks like
 * a working one. Capping the ANGULAR size keeps near probes proportional (the
 * LOD-ring reading this view exists for) while distant ones settle into
 * readable dots instead of swallowing the camera.
 */
const MAX_ANGULAR_RADIUS = 0.012;

/** HSV → RGB, the compact form. Hue only; s and v are supplied by the caller. */
function hsv(h, s, v) {
  const k = (n) => float(n).add(float(h).mul(6)).mod(6);
  const f = (n) => float(v).sub(
    float(v).mul(s).mul(k(n).min(float(4).sub(k(n))).min(1).max(0)),
  );
  return vec3(f(5), f(3), f(1));
}

/**
 * One `InstancedMesh` per cascade, grouped.
 *
 * Per cascade rather than one mesh for everything, for two reasons that both
 * matter: the cascade index becomes a COMPILE-TIME constant (no runtime search
 * for which probeBase an instance falls under, in a vertex shader that runs
 * once per probe per vertex), and a person can switch cascades off
 * independently — which is the difference between "a cloud of spheres" and
 * "oh, c2 is not following the wall".
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} options
 * @param {Node|number} options.spacing0
 * @param {Node} options.anchor  the same lattice anchor the population used.
 *   Passing a different one draws a correct-looking lattice in the wrong place,
 *   which is the most misleading failure this file could have.
 */
export function createSrcProbeGizmos(store, { spacing0, anchor, detail = 0 } = {}) {
  const group = new THREE.Group();
  group.name = "gi-src-probe-gizmos";
  group.frustumCulled = false;
  const meshes = [];

  for (const c of store.cascades) {
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = `gi-src-probes-c${c.cascade}`;
    // Depth-tested: these are 3D markers in the scene, and a probe that should
    // be behind a wall must LOOK behind the wall or the view cannot answer
    // "are the probes where the geometry is".
    material.depthTest = true;
    material.depthWrite = true;
    material.transparent = false;

    const probeAt = () => {
      const p = instanceIndex.add(uint(c.probeBase)).toVar();
      const w = p.mul(PROBE_WORDS).toVar();
      const key = store.probeTable.element(w.add(PROBE_KEY)).toVar();
      const flags = store.probeTable.element(w.add(PROBE_FLAGS)).toVar();
      const lod = float(keyLod(key)).toVar();
      const s = probeSpacing(c.cascade, lod, spacing0).toVar();
      return {
        key,
        lod,
        spacing: s,
        alive: flags.bitAnd(uint(FLAG_ALIVE)).notEqual(uint(0)),
        fresh: flags.bitAnd(uint(FLAG_FRESH)).notEqual(uint(0)),
        centre: cellPosition(keyCell(key), latticeOrigin(anchor, s), s).toVar(),
      };
    };

    material.positionNode = (() => {
      const probe = probeAt();
      // A dead slot collapses to a point. Degenerate triangles rasterize
      // nothing, so this costs one vertex each and no fragments — cheaper and
      // simpler than culling instances, which would need a compaction pass to
      // produce a contiguous draw range.
      const eyeDistance = probe.centre.sub(cameraPosition).length().toVar();
      const sized = probe.spacing.mul(RADIUS_FRACTION)
        .min(eyeDistance.mul(MAX_ANGULAR_RADIUS));
      const radius = select(probe.alive, sized, float(0));
      return positionLocal.mul(radius).add(probe.centre);
    })();

    material.colorNode = (() => {
      const probe = probeAt();
      // HUE IS LOD, and it has to be, because the LOD rings are the structure
      // worth looking at. The golden-ratio step keeps ADJACENT LODs far apart
      // in hue — a linear ramp puts lod 3 and lod 4 in neighbouring greens,
      // which is exactly where a boundary artifact would hide.
      const h = probe.lod.max(0).mul(0.618034).fract();
      // Value falls with cascade so the big coarse spheres sit behind the fine
      // ones instead of washing them out. They overlap by construction — every
      // c0 probe has a c1 parent covering it.
      const v = float(1).div(1 + c.cascade * 0.6);
      const base = hsv(h, 0.85, v);
      // A newborn probe reads white. Steady state is a still image; churn is
      // a shimmer, and that distinction is the whole point of watching this in
      // motion rather than in a screenshot.
      return vec4(select(probe.fresh, vec3(1, 1, 1), base), 1);
    })();

    const mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, detail),
      material,
      c.probeCapacity,
    );
    // `positionNode` places every instance, so the instance matrices must be
    // IDENTITY rather than left uninitialized — three applies them on top, and
    // an uninitialized InstancedMesh matrix array is zeros, which collapses
    // every sphere to the origin and looks exactly like "the probes are all at
    // 0,0,0" (i.e. like a bug in the population).
    const identity = new THREE.Matrix4();
    for (let i = 0; i < c.probeCapacity; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9998;
    // Excluded from the GI gbuffer prepass, the voxelizer and the light tree —
    // the same mark `srcDebugViews`' boxes carry. A gizmo that voxelized would
    // occlude the field it is drawing.
    mesh.userData.__giDebug = true;
    mesh.name = `gi-src-probes-c${c.cascade}`;
    group.add(mesh);
    meshes.push(mesh);
  }

  return {
    group,
    meshes,
    /** `visible` for the group and every cascade; `cascades` masks individually. */
    setVisible(visible, cascades = null) {
      group.visible = visible;
      for (const [i, mesh] of meshes.entries()) {
        mesh.visible = visible && (cascades == null || cascades.includes(i));
      }
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry?.dispose();
        mesh.material?.dispose();
        mesh.dispose?.();
      }
      group.removeFromParent();
    },
  };
}

/** LOD → the hue this view paints it, for a legend or a harness assertion. */
export function srcGizmoHue(lod) {
  return (Math.max(0, Math.min(MAX_LODS - 1, lod)) * 0.618034) % 1;
}
