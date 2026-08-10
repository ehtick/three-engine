// SPLIT RADIANCE CASCADES — the intersection backend.
//
// Extracted from `giField.js`'s `createOccupancySceneTrace`, with ONE structural
// change: this returns GEOMETRY ONLY. The old function fused tracing with hit
// shading, because the thing it shaded from was the radiance field it lived
// next to — sample the field at the hit point and you have the answer. SRC has
// no radiance field, so shading a hit means analytic NEE plus the secondary
// probe cache, which is `srcShade.js`'s job and not this file's.
//
// That split is the point. A trace that returns `{hit, t, position, normal,
// dynObj}` can be reused by the diffuse rays, the sun-visibility rays at hits,
// the emitter shadow rays and the secondary cache without any of them agreeing
// about what radiance means.
//
// ══ WHAT IS REUSED VERBATIM, AND WHY IT IS NOT REWRITTEN ═══════════════════
//
// The medium — occupancy bitset pyramid, hierarchical DDA, surface records,
// exact dynamic objects — stays exactly as it is. The paper traces with OptiX;
// we trace with this, and it is the single most measured piece of code in the
// module. Specifically preserved:
//
//   · HIERARCHICAL DDA WITH PYRAMID SKIP — it cannot tunnel. Every leak hunt in
//     38 sessions converged on that property; a "simpler" flat march
//     reintroduces the entire class.
//   · SURFACE RECORDS for sub-voxel hit positions and normals. Voxel-face
//     normals quantize every silhouette to a whole voxel, which is what made
//     rotated casters' shadows blocky.
//   · EXACT DYNAMIC OBJECTS via `composeFieldDynamics`, so a mover is HIT
//     GEOMETRY rather than something smeared into the medium. The paper leaves
//     movable objects to future work; this is the part of the old system that
//     survives as our own extension.
//   · R2/R3 tolerance discipline: every bias is derived from the OCCUPANCY
//     VOXEL size, never from probe spacing, and step exhaustion fails CLOSED
//     from detail and OPEN in open space. SRC's rays are LONGER than the dense
//     backend's interval rays, so R3 carries more load here, not less.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.3.

import { If, float, select, vec3 } from "three/tsl";
import { RayHitMode } from "./rayHit/RayHitConfig.js";
import { MAX_MACRO_STEPS } from "./rayHit/RayHitPacking.js";

/**
 * The shadow ray's two biases, in OCCUPANCY CELLS, exported because the gate
 * asserts their SUM rather than a literal — a threshold written down twice is a
 * threshold that drifts, and this pair already drifted once (see
 * `createSrcVisibility`).
 *
 * `LIFT` moves the origin off the surface along the normal; `SELF_BIAS` starts
 * the march along the ray, for the grazing case the lift alone does not clear.
 * Together they are the distance below which a contact shadow is lost.
 */
export const SHADOW_LIFT_CELLS = 0.75;
export const SHADOW_SELF_BIAS_CELLS = 0.25;

/**
 * The one place the ray-hit mode swaps trace implementations. Interval
 * semantics and the return contract are identical across modes.
 *
 * Hoisted so that EVERY consumer — diffuse rays, sun visibility at hits,
 * emitter shadows, the secondary cache — fires through the same marcher with
 * the same mode. A second choice here would light one surface against a
 * different medium than the surface beside it, which is the §6.6 lesson the
 * surface cache learned the hard way.
 *
 * SRC ships two modes, not five (plan §4.3): `hybrid-plane` as the default and
 * `hybrid-exact-complex` at high/ultra. The brick-box and plane-coverage rungs
 * of the old ladder are gone — box hits quantize silhouettes to whole voxels,
 * and coverage was superseded by the triangle pool.
 */
export function pickOccTrace(occField, rayHitMode = RayHitMode.HybridPlane) {
  const planeMode =
    rayHitMode >= RayHitMode.HybridPlane &&
    rayHitMode <= RayHitMode.HybridExactComplex &&
    occField.traceHybridPlane;
  if (!planeMode) return occField.traceOccupancy;
  const exact = rayHitMode === RayHitMode.HybridExactComplex;
  return (o, d, t0, t1, opts) =>
    occField.traceHybridPlane(o, d, t0, t1, { ...opts, coverage: false, exact });
}

/**
 * Geometry-only scene trace for SRC's full-length rays.
 *
 * Returns, as TSL nodes:
 *   `hit`      1 when something was intersected, else 0
 *   `t`        world distance to the hit (meaningless when hit == 0)
 *   `position` the hit point, lifted off the surface by the RECORD-AWARE bias
 *   `normal`   surface normal at the hit, pointing back along the ray
 *   `dynObj`   packed mover id when the hit was an exact dynamic object, else <0
 *   `voxel`    level-0 voxel coords at the hit — the STATIC ATTRIBUTION KEY
 *
 * `voxel` is passed through rather than recomputed by consumers because both
 * marcher rungs already produce it (`traceOccupancy` and `traceHybridPlane`
 * each return it) and a consumer that re-derives `floor((o + d·t − origin)/cell)`
 * from the LIFTED `position` lands one cell out along the normal exactly where
 * the lift was meant to put it — the shell cell, not the surface cell. Static
 * surface attribution keys on the surface cell, so the trace hands over the one
 * the intersection actually found.
 *
 * @param {object} occField      the occupancy field (already `composeFieldDynamics`-wrapped)
 * @param {object} world         `{ minCell }` and friends — UNIFORM nodes, so a
 *                               refit moves the medium without a recompile (R11)
 * @param {number} steps         per-ray step budget
 * @param {number} rayHitMode    see `pickOccTrace`
 * @param {boolean} skipMovers   movers invisible to this ray class
 */
export function createSrcSceneTrace(occField, world, {
  steps = 96,
  rayHitMode = RayHitMode.HybridPlane,
  skipMovers = false,
  wantDynObj = true,
} = {}) {
  const trace = pickOccTrace(occField, rayHitMode);
  const dyn = occField.dynamicObjects;
  const dynEnabled = !!(dyn?.enabled && dyn.surfaceAt);
  const reportObj = wantDynObj && dynEnabled && !skipMovers;

  return (origin, dir, tMaxWorld) => {
    const o = vec3(origin).toVar();
    const d = vec3(dir).toVar();
    // ── SELF-BIAS COMES FROM THE MEDIUM, NOT FROM PROBE SPACING (R2) ────────
    // A quarter of a coarse cell out, so a ray starting on a surface does not
    // instantly hit the voxel it was born in. Derived from `world.minCell`
    // because the occupancy voxel is what quantized the intersection; deriving
    // it from s0 would make the bias change when a user drags a probe-density
    // slider, which is how a spacing dial turns into a leak dial.
    const tMin = float(world.minCell).mul(0.25).toVar();
    const r = trace(o, d, tMin, float(tMaxWorld), {
      steps,
      macroSteps: MAX_MACRO_STEPS,
      profile: true,
      dynObj: reportObj,
      ...(skipMovers ? { dynamics: false } : {}),
    });
    // Lift along the normal by half a coarse cell. For a VOXEL-face hit this
    // moves the point out to the shell cell that carries its lighting; for an
    // exact record/triangle hit it is simply a shadow-ray epsilon. Both want
    // the same sign and the same scale, which is why there is one lift.
    const position = o
      .add(d.mul(r.t))
      .add(r.normal.mul(float(world.minCell).mul(0.5)))
      .toVar();
    // The EXACT hit point, unlifted — analytic NEE at the hit wants the real
    // surface position, and an exact triangle needs no shell correction.
    const exactPosition = o.add(d.mul(r.t)).toVar();
    const hitT = select(r.hit.greaterThan(0.5), r.t.max(1e-4), float(-1)).toVar();
    return {
      hit: r.hit,
      t: hitT,
      position,
      exactPosition,
      normal: vec3(r.normal).toVar(),
      dynObj: reportObj && r.dynObj != null ? r.dynObj : null,
      voxel: r.voxel != null ? vec3(r.voxel).toVar() : null,
    };
  };
}

/**
 * Binary visibility toward a source, through the SAME marcher the primary ray
 * used. One traversal per (hit, light); movers excluded so a surface cannot
 * shadow itself (its own n·l already carries that).
 *
 * This is what makes the sun correct at OFF-SCREEN hits, which three's shadow
 * map structurally cannot do — it is view-frustum bound, and half of SRC's ray
 * hits are behind the camera or outside the frustum.
 *
 * ══ THE LIFT MOVES THE ORIGIN, SO IT MOVES `maxT` ══════════════════════════
 *
 * Plan §12.26.3, measured in the CPU mirror and fixed here from it. `maxT` is
 * supplied by the caller and is naturally measured from the SURFACE point,
 * because that is where the light's distance is known. The trace starts 0.75
 * voxels away from there, so the same world point sits at a different `t` — and
 * the emitter is the very next thing along the ray past its own `maxT`. Compare
 * the shortened distance against the unshortened budget and the shadow ray hits
 * the light itself: every light, every hit.
 *
 * The mirror measured that as **100% of the analytic emitter term lost**, on
 * three receivers, while the geometric emission path read correct values right
 * beside it — no NaN, no warning, a shadow-ray count that looks perfectly
 * healthy, and a scene that is simply black. The endpoint is recoverable from
 * `(point, toLight, maxT)` alone, so the correction needs no new binding.
 *
 * ══ AN OCCLUDER INSIDE THE LIFT IS STEPPED OVER, AND THAT IS THE MEDIUM ════
 *
 * The lift's other consequence, swept in the mirror at voxel 0.2 m: an occluder
 * closer to the surface than 0.75 · voxel loses its contact shadow, with the
 * threshold landing exactly ON the lift. Not an epsilon to tune down — a
 * smaller one re-acnes at the same voxel scale — but the DDA medium's
 * quantization showing through. The value of having the number is that a lost
 * contact shadow becomes recognizable instead of investigable.
 *
 * ⚠ **THIS FUNCTION USED TO APPLY THAT BIAS TWICE**, and `test:gi-src-shade`'s
 * sweep is what found it: the origin moved 0.75 voxels along the normal AND the
 * trace was started at `t0 = lift` along the ray, so the real threshold was
 * **1.5 voxels**, double what the mirror measured and double what any comment
 * here claimed. The along-ray term is not redundant — a grazing shadow ray from
 * a lifted origin can still be inside the surface's own voxel, since 0.75 along
 * a body-diagonal normal is only 0.43 per axis — but it is not a second lift
 * either. It is now the SAME self-bias `createSrcSceneTrace` uses, a quarter of
 * a cell, derived from the same quantity (R2). Threshold: `0.75 + 0.25 = 1.0`
 * voxel, and the gate asserts exactly that sum rather than a literal.
 *
 * @param {Node} point    surface point, UNLIFTED
 * @param {Node} normal   surface normal (face-forwarded by the caller)
 * @param {Node} toLight  unit direction toward the source
 * @param {Node} [maxT]   distance to the source FROM `point`. Omitted means
 *   "as far as the medium goes" — the volume diagonal, not `Infinity`, because
 *   an unbounded literal is not a legal float in the emitted WGSL.
 */
export function createSrcVisibility(occField, world, {
  steps = 64,
  rayHitMode = RayHitMode.HybridPlane,
} = {}) {
  const trace = pickOccTrace(occField, rayHitMode);
  // The whole-medium bound a directional source wants. `world.size` is a
  // uniform, so a refit (R11) moves it without a recompile.
  const diagonal = () => vec3(world.size).length();
  return (point, normal, toLight, maxT = null) => {
    const lift = float(world.minCell).mul(SHADOW_LIFT_CELLS).toVar();
    // Along the ray, and NOT a second lift — see the header.
    const selfBias = float(world.minCell).mul(SHADOW_SELF_BIAS_CELLS).toVar();
    const p = vec3(point).toVar();
    const l = vec3(toLight).toVar();
    const origin = p.add(vec3(normal).mul(lift)).toVar();
    // Re-measure the budget from the LIFTED origin. Reconstructing the endpoint
    // and taking its distance is exact for any `maxT` and costs one length();
    // subtracting `dot(normal, toLight) · lift` would be the same thing only for
    // a straight-line geometry that a lift along the normal does not give.
    const budget = (maxT == null
      ? diagonal()
      : p.add(l.mul(float(maxT))).sub(origin).length()
    ).toVar();
    const v = float(1).toVar();
    const sh = trace(origin, l, selfBias, budget, {
      steps,
      macroSteps: MAX_MACRO_STEPS,
      dynamics: false,
    });
    v.assign(select(float(sh.hit).greaterThan(0.5), float(0), float(1)));
    return v;
  };
}

/**
 * Mover-hit surface lookup: mean albedo + emissive for the object a ray hit.
 *
 * `dynObj` is PACKED (`objectIndex * OBJ_SLOT_STRIDE + cardSlot` — see
 * dynamicObjects' `traceDynBody`), so it MUST be split before any header read.
 * Indexing object blocks with the raw value reads a different mover's surface,
 * which presents as one object wearing another's colour and is very hard to
 * attribute after the fact.
 */
export function moverSurfaceAt(occField, dynObj) {
  const dyn = occField.dynamicObjects;
  if (!dyn?.enabled || !dyn.surfaceAt || dynObj == null) return null;
  const who = dyn.splitObj(dynObj);
  return { surface: dyn.surfaceAt(who.index), who };
}

/**
 * Run `body` only when the traced hit was an exact dynamic object. Kept here so
 * every consumer spells the guard the same way — `dynObj >= 0` is the contract,
 * and a consumer that tests `!= null` instead silently treats every static hit
 * as a mover.
 */
export function ifMoverHit(dynObj, body) {
  if (dynObj == null) return;
  If(dynObj.greaterThanEqual(0), body);
}
