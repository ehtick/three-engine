// SPLIT RADIANCE CASCADES — THE WORLD BUNDLE AND THE OCCUPANCY-ONLY SHADOW ARMS.
//
// This file exists to unblock the §5 deletion sweep. `giField.js` owns two
// things that are NOT transport machinery and therefore cannot die with it:
//
//   · `createSoftShadowTrace` — the sphere-traced soft shadow, which is
//     `light.shadowTraceFn` (emitter shadows at pixels) and the records-absent
//     fallback arm of the GI-traced light shadows;
//   · `createWidthProbe` — the analytic mid-field penumbra width term, which is
//     on the DEFAULT path of BOTH surviving shadow arms (the record march
//     supplies admission, this supplies softness).
//
// Both took their base distance from `texture3D(distanceTexture, …)`, so as long
// as they lived there, deleting the composited distance field deleted the
// shipping soft shadows. Plan §12.5.
//
// ══ WHY THIS IS A SMALLER CHANGE THAN §4.2 AND §12.5 BOTH ASSUME ═══════════════
//
// §4.2 called `freeRadiusAtWorld` the width probe's "fallback"; §12.5 corrected
// that to "a refinement, not a fallback" and concluded that swapping the oracle
// in wholesale would trade a continuous distance for a staircase of voxel boxes.
// Both statements are about the SDF-baking build. In the shipping build they
// describe the wrong thing, and the reason is one line — `giField.js`'s
// composite, under `killSdf` (which is `!!occField`, i.e. always):
//
//     minD.assign(occField.freeRadiusAtWorld(p, undefined, true, world.capWorld))
//
// The composited distance field IS the oracle. Not a different, better-behaved
// distance source that the oracle sharpens — the same function, evaluated at
// coarse cell centres, quantized to fp16 and read back through hardware
// trilinear. So relative to what ships today, evaluating the oracle directly:
//
//   · cannot lose distance accuracy, because it is the accuracy the composite
//     RESAMPLES. It gains: no fp16 step, no 0.33m low-pass, and sub-cell detail
//     everywhere instead of only where `dRaw < 2·minCell` opened the gate;
//   · is strictly MORE conservative. Trilinear interpolation of a 1-Lipschitz
//     function overshoots between samples, so the composite reports free space
//     that is not there — up to about half a coarse cell of it. The oracle never
//     does (`srcVolumeRef.js` measures both);
//   · gives up exactly one thing: the low-pass was also SMOOTHING the ladder's
//     per-level jumps. That is the whole regression risk, it is bounded by
//     0.5·voxel·2^L at the level that jumps, and it is what the A/B measures.
//
// So the gate here is not "is the oracle good enough to replace a better
// distance" — it is "does removing a blur that was never asked for cost
// anything". `scripts/run-gi-src-volume-test.mjs` answers the numeric half on
// the CPU; `__giSrcVolumeShadows` (giField.js) is the seam that answers the
// visual half on the real chain, with everything but the distance source held
// byte-identical.
//
// ══ WHAT IS DELIBERATELY COPIED RATHER THAN SHARED ════════════════════════════
//
// The estimator bodies below are near-transcriptions of `createShadowTrace` and
// `createWidthProbeFn`. That is intentional and temporary in the other
// direction: the giField originals must stay BYTE-IDENTICAL while they are the
// A/B baseline, so factoring the shared parts out would change the control. When
// the deletion sweep lands, the originals go and these become the only copies.
// Every tuned constant is carried over with its derivation intact — the cuts,
// the closest-approach pairing, the cap saturation, the fail-closed clamp — for
// the reason §12.4 records: a rewrite that re-derives the constants is not an
// A/B of the distance source, it is an A/B of everything at once.
//
// docs/GI_SRC_REBUILD_PLAN.md §12.5 step 1.
import * as THREE from "three/webgpu";
import { Break, Loop, If, float, mix, select, smoothstep, uniform, vec3 } from "three/tsl";
import { sharedFn } from "./giFn.js";
import { OCC_LEVELS } from "./occupancyField.js";

/**
 * How many pyramid levels the shadow-path distance consults.
 *
 * ALL OF THEM, and the saturation argument is why rather than "more is better":
 * the consumers test `d < 0.85·capWorld` to mean "this sample is open space,
 * do not treat it as an occluder". `freeRadiusAtWorld` only reports the
 * saturation value when its COARSEST level is empty, so asking for fewer levels
 * than the pyramid has means the cap is never reported and that test silently
 * inverts — every open-space sample past a couple of metres counts as an
 * occluder and `min(k·d/t)` drives the whole scene dark. occupancyField.js's
 * saturation note records that failure and what it looks like (a scene needing
 * GI intensity ~10 to read at all). The composite already asks for every level
 * for the same reason.
 */
const SHADOW_MAX_LEVEL = OCC_LEVELS - 1;

/**
 * WORLD PARAMETERIZATION, unchanged in shape from `giField.js`'s bundle so that
 * a consumer cannot tell which one it was handed. Everything is a uniform: a
 * refit is a uniform write plus nothing, with zero shader recompiles (R11).
 *
 * `res` is the coarse cell count per axis. SRC has no dense lattice, so this is
 * NOT a transport parameter here — it survives only as the scale that
 * `minCell`/`cellMax`/`capWorld` are derived from, because every tuned constant
 * in the shadow estimators is expressed in those units and re-deriving them from
 * the occupancy voxel would change the shadows and the distance source in the
 * same commit. Pass `res: null` for the voxel-derived variant (see
 * `capWorld` below), which is the intended end state and its own A/B.
 */
export function createSrcWorld(bounds, res, occField = null) {
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  const cell = res
    ? new THREE.Vector3(size.x / res.x, size.y / res.y, size.z / res.z)
    : occField?.voxel?.value?.clone() ?? new THREE.Vector3(1, 1, 1);
  const minCell = Math.min(cell.x, cell.y, cell.z);
  // REACH, and with `res: null` it stops being a magic 16.
  //
  // The composited field's cap was `16 · minCell` because 16 coarse cells was
  // as far as a byte-quantized texture could usefully carry a distance. The
  // oracle's own ceiling is `voxel · 2^(OCC_LEVELS-1)` = 16 voxels, and that is
  // not a coincidence to be exploited so much as the number the consumers
  // SHOULD be testing against: matching them makes `capCut` recognise exactly
  // the samples the oracle actually saturated, which is the mismatch
  // occupancyField.js's saturation note is a workaround for.
  const capWorld = 16 * minCell;
  const world = {
    min: uniform(bounds.min.clone()),
    size: uniform(size.clone()),
    cell: uniform(cell.clone()),
    minCell: uniform(minCell),
    cellMax: uniform(Math.max(cell.x, cell.y, cell.z)),
    capWorld: uniform(capWorld),
    minCellValue: minCell,
    capWorldValue: capWorld,
    /** In-place refit: same cell COUNT, rescaled cell world size (R11). */
    refit(nextBounds) {
      const nextSize = new THREE.Vector3().subVectors(nextBounds.max, nextBounds.min);
      const nextCell = res
        ? new THREE.Vector3(nextSize.x / res.x, nextSize.y / res.y, nextSize.z / res.z)
        : occField?.voxel?.value?.clone() ?? cell.clone();
      const nextMin = Math.min(nextCell.x, nextCell.y, nextCell.z);
      world.min.value.copy(nextBounds.min);
      world.size.value.copy(nextSize);
      world.cell.value.copy(nextCell);
      world.minCell.value = nextMin;
      world.cellMax.value = Math.max(nextCell.x, nextCell.y, nextCell.z);
      world.capWorld.value = 16 * nextMin;
      world.minCellValue = nextMin;
      world.capWorldValue = 16 * nextMin;
    },
  };
  return world;
}

/**
 * THE ONE DISTANCE SOURCE. `(p) => free radius at p`, saturating at
 * `world.capWorld` exactly where the composite's texture did.
 *
 * `recordAware` defaults ON, and this is a fidelity GAIN over the texture
 * rather than a like-for-like port: the composite fed itself from the
 * record-BLIND oracle (four arguments at `giField.js:216`), so every sub-voxel
 * plane fit the records carry was averaged away before the shadow path could
 * see it. It is the same conservative sharpening the trace's own refinement
 * already applied on top — now applied at the base, where it also reaches the
 * mid field. Silently a no-op without records (`hasSurfaceRecords`).
 */
export function createSrcDistance(occField, world, {
  maxLevel = SHADOW_MAX_LEVEL,
  nearField = true,
  recordAware = true,
} = {}) {
  const rec = recordAware && occField.hasSurfaceRecords === true &&
    globalThis.__giRayHitShadowRecords !== false;
  return (p, cap) => occField.freeRadiusAtWorld(p, maxLevel, nearField, cap, rec);
}

/**
 * ANALYTIC MID-FIELD PENUMBRA WIDTH, oracle-direct.
 *
 * Contract, tap schedule and every gate are `giField.js`'s `createWidthProbeFn`
 * verbatim — `(origin, dir, tStart, maxT, k, cosRayNormal, lift) → [0,1]`,
 * WIDTH ONLY NEVER ADMISSION, log-spaced taps with no jitter of any kind,
 * `min` over `k·D/t`. Read that function's header for why each gate exists;
 * repeating the reasoning here would let the two drift.
 *
 * ONE substantive difference beyond the distance source, and it is a
 * consequence of it. The `0.6·planeHeight` proportional own-plane gate is sized
 * off the composited D's measured 25-30% relative undershoot over a hugging
 * ray, and it costs the probe every occluder within 40% of the ray's
 * receiver-plane height. Oracle-direct has no trilinear undershoot and no fp16
 * step — its only downward bias is the ~1 voxel of conservative-voxelization
 * bulge — so the noise band that forced 0.6 is roughly a third as wide.
 * `__giSrcWidthPlaneFactor` exposes the factor as a build-time A/B rather than
 * being retuned blind: the A/B has to convict the OLD number on the NEW
 * distance before this moves, or the gate stops being an A/B of the distance
 * source and becomes one of two changes at once.
 */
export function createSrcWidthProbe(occField, world, {
  name = "srcShadowWidthProbe",
  distance = null,
  recordAware = true,
} = {}) {
  const TAPS = Math.max(4, Math.min(24, Number(globalThis.__giShadowWidthTaps) || 12));
  const planeFactor = Number(globalThis.__giSrcWidthPlaneFactor) || 0.6;
  const freeRadius = distance ?? createSrcDistance(occField, world, { recordAware });
  return sharedFn({
    name,
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "tStart", type: "float" },
      { name: "maxT", type: "float" },
      { name: "k", type: "float" },
      { name: "cosRayNormal", type: "float" },
      { name: "lift", type: "float" },
    ],
    body: (origin, dir, tStart, maxT, k, cosRayNormal, lift) => {
      const minV = vec3(world.min).toVar();
      const bmaxV = minV.add(vec3(world.size)).toVar();
      const capWorldV = float(world.capWorld).toVar();
      // 0.5·capWorld (8 voxels), tightened from 0.85 on 2026-08-13. The 0.85
      // cut was sized to recognise a SATURATING distance as open space, but
      // `freeRadiusAtWorld` in open space returns lattice-inset bounds — for
      // each empty 2×2×2 level-L block, [0.5, 1.0]·2^L voxels — so levels
      // 1-3 emit 4-16-voxel "occluders" on a 0.75m-period world lattice that
      // slip under 13.6 voxels. In a small tight-fit volume (the Cornell
      // box) those taps put `cand = k·D/t` right in the darkening band and
      // painted world-locked 30-70% clouds on open ceilings. Real width-
      // relevant occluders live where `k·D/t < 1` actually bites — under
      // ~8 voxels at any k this probe serves — so the tighter cut discards
      // only lattice artifacts. `__giShadowWidthCapCut` overrides (a finite
      // number, fraction of capWorld; 0 is a valid ablation = reject all).
      const capCutFrac = Number.isFinite(Number(globalThis.__giShadowWidthCapCut))
        ? Number(globalThis.__giShadowWidthCapCut)
        : 0.5;
      const capCut = capWorldV.mul(capCutFrac).toVar();
      const minCellV = float(world.minCell).toVar();
      const occVox = occField?.voxel
        ? vec3(occField.voxel).x.max(vec3(occField.voxel).y).max(vec3(occField.voxel).z).toVar()
        : null;
      // 3.5 voxels, carried over UNCHANGED. It was sized against the
      // composite's undershoot, which is gone — but the whole point of this
      // arm is that the distance source is the only thing that moved, so it
      // stays until the A/B says the receiver residual it was fighting is
      // actually gone. (`__giSrcWidthPlaneFactor`'s note above, same rule.)
      const planeCut = (occVox ? minCellV.mul(1.0).max(occVox.mul(3.5)) : minCellV.mul(0.75)).toVar();
      const width = float(1).toVar();
      const dbgTap = globalThis.__giWidthProbeDebugTap === true;
      const bestIdx = dbgTap ? float(1).toVar() : null;
      const t0 = tStart.max(minCellV.mul(0.5)).toVar();
      const ratio = maxT.div(t0).max(1.0001).pow(1 / (TAPS - 1)).toVar();
      const t = t0.toVar();
      for (let i = 0; i < TAPS; i++) {
        const p = origin.add(dir.mul(t)).toVar();
        // BOUNDS IN WORLD SPACE, not in the texture's uvw. Same test, same
        // meaning — outside the volume the distance is undefined and the
        // sample saturates lit — but expressed against the slab directly
        // because there is no texture to normalize into any more. Worth
        // spelling out: `uvw ∈ [0,1]` and `p ∈ [min, min+size]` are the same
        // region only while the volume is the sampled one, and this arm's
        // whole direction of travel is that it no longer has to be.
        const inBounds = p.x.greaterThanEqual(minV.x).and(p.y.greaterThanEqual(minV.y))
          .and(p.z.greaterThanEqual(minV.z))
          .and(p.x.lessThanEqual(bmaxV.x)).and(p.y.lessThanEqual(bmaxV.y))
          .and(p.z.lessThanEqual(bmaxV.z));
        const d = freeRadius(p, capWorldV).toVar();
        const planeHeight = lift.add(t.mul(cosRayNormal));
        const counts = inBounds
          .and(d.lessThan(capCut))
          .and(d.lessThan(planeHeight.sub(planeCut)))
          .and(d.lessThan(planeHeight.mul(planeFactor)))
          .and(t.lessThan(maxT));
        const cand = k.mul(d).div(t.max(1e-4)).clamp(0, 1);
        const candEff = select(counts, cand, float(1)).toVar();
        if (dbgTap) bestIdx.assign(select(candEff.lessThan(width), float(i / (TAPS - 1)), bestIdx));
        width.assign(width.min(candEff));
        if (i < TAPS - 1) t.mulAssign(ratio);
      }
      if (dbgTap) return select(width.lessThan(0.95), bestIdx.mul(0.7).add(0.15), float(1));
      return width;
    },
  });
}

/**
 * SPHERE-TRACED SOFT SHADOW over the occupancy oracle: `(origin, dir, maxT, k,
 * cosRayNormal, excludeCenter?, excludeRadius?, excludeBox?) → penumbra [0,1]`.
 *
 * A transcription of `giField.js`'s `createShadowTrace` with the SDF-era
 * branches gone rather than disabled — no `sparse` brick sample, no
 * `atlas.refineDetail`, no coarse-`stagingBuffer` hard block, and no
 * refinement `min` (there is nothing left to refine: the oracle is the base
 * now, and min-ing it against itself is the identity). What survives is the
 * estimator and its gates, which is the part that was tuned.
 *
 * Note what the `killSdf` bookkeeping collapses to. In the shipping build that
 * flag is `!!occField` and every branch it guards already picked the oracle, so
 * the three SDF paths this drops were unreachable code, not features. The one
 * branch that genuinely disappears is the occupancy HARD BLOCK
 * (`occupiedAtWorld(p, 0) → penumbra 0`): giField compiles it only when
 * `!killSdf`, i.e. never, and its own comment says why — with the oracle as the
 * distance there is nothing for a binary override to catch that the estimator
 * does not already ramp down to, and keeping it costs voxel-stepped shadow
 * edges.
 *
 * `stable` and the fail-closed clamp are carried over exactly; both are leak
 * seals with an expensive history (see the original's notes on the under-floor
 * leak and the black-room-with-a-lit-ceiling build).
 */
export function createSrcSoftShadowTrace(occField, world, {
  lift = null,
  steps = 56,
  name = "srcShadowTrace",
  stable = false,
  recordAware = true,
  distance = null,
} = {}) {
  const liftWorld = lift == null ? float(world.minCell).mul(2) : float(lift);
  const freeRadius = distance ?? createSrcDistance(occField, world, { recordAware });

  const traceFn = sharedFn({
    name,
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "maxT", type: "float" },
      { name: "k", type: "float" },
      { name: "cosRayNormal", type: "float" },
      { name: "excludeCenter", type: "vec3" },
      { name: "excludeRadius", type: "float" },
      { name: "excludeHalf", type: "vec3" },
      { name: "excludeBx", type: "vec3" },
      { name: "excludeBy", type: "vec3" },
      { name: "excludeBz", type: "vec3" },
    ],
    body: (origin, dir, maxT, k, cosRayNormal, excludeCenter, excludeRadius, excludeHalf, excludeBx, excludeBy, excludeBz) => {
      // Uniform-derived scalars hoisted into locals before the loop — the D3D
      // compiler is drastically slower optimizing a long march whose operands
      // are uniform-buffer loads (the original measured 3 pipelines at
      // 6.5+2.2+1.8s vs ~1s with the copies).
      const minCellV = float(world.minCell).toVar();
      const capWorldV = float(world.capWorld).toVar();
      const minV = vec3(world.min).toVar();
      const occVox = occField?.voxel && !globalThis.__giNoOccSelfCut
        ? vec3(occField.voxel).x.max(vec3(occField.voxel).y).max(vec3(occField.voxel).z).toVar()
        : null;
      const liftV = float(liftWorld).toVar();
      const contactCut = minCellV.mul(0.25).toVar();
      // Self-exclusion tracks the medium that traced the ray (round 6's rule).
      // The medium is unambiguously the occupancy voxel here — the oracle reads
      // exactly 0 inside an occupied voxel and conservative voxelization puts
      // every receiver standing on a surface inside one — so the `occVox·2.5`
      // arm is no longer the "under killSdf" case, it is THE case.
      const planeCut = (occVox ? minCellV.mul(1.0).max(occVox.mul(2.5)) : minCellV.mul(0.75)).toVar();
      const capCut = capWorldV.mul(0.85).toVar();
      const stepMin = minCellV.mul(0.35).toVar();
      const stepMax = minCellV.mul(8).toVar();
      const penumbra = float(1).toVar();
      // Volume slab entry/exit, so a receiver OUTSIDE the fitted volume marches
      // INTO the medium instead of reporting "nothing blocked me" at the face
      // (the original's "light cutoff" report: sharp-edged lit pools).
      const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
      const bmax = minV.add(vec3(world.size)).toVar();
      const t1x = minV.x.sub(origin.x).div(invEps(dir.x));
      const t2x = bmax.x.sub(origin.x).div(invEps(dir.x));
      const t1y = minV.y.sub(origin.y).div(invEps(dir.y));
      const t2y = bmax.y.sub(origin.y).div(invEps(dir.y));
      const t1z = minV.z.sub(origin.z).div(invEps(dir.z));
      const t2z = bmax.z.sub(origin.z).div(invEps(dir.z));
      const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z)).toVar();
      const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z)).toVar();
      const t = minCellV.mul(2).max(tEnter.add(minCellV.mul(0.5))).toVar();
      const tEnd = tExit.sub(contactCut).toVar();
      const prevD = float(1e10).toVar();
      const prevW = float(0).toVar();
      const resolved = float(0).toVar();
      const lastD = float(1e10).toVar();

      Loop({ start: 0, end: steps, name: "srcShadow" }, () => {
        If(t.greaterThanEqual(maxT).or(t.greaterThan(tEnd)), () => {
          resolved.assign(1);
          Break();
        });
        const p = origin.add(dir.mul(t)).toVar();
        If(
          p.x.lessThan(minV.x).or(p.y.lessThan(minV.y)).or(p.z.lessThan(minV.z))
            .or(p.x.greaterThan(bmax.x)).or(p.y.greaterThan(bmax.y)).or(p.z.greaterThan(bmax.z)),
          () => {
            resolved.assign(1);
            Break();
          },
        );
        // THE DISTANCE, unfiltered. The gate the original wrapped its oracle
        // call in (`If(dRaw < 2·minCell)`) was a pure optimisation for a
        // REFINEMENT that could only lower an already-cheap texture read; with
        // the oracle as the base there is nothing to gate against, and gating
        // on nothing would just be a branch. Cost moves from 1 texture fetch to
        // the oracle's 27 near-field + 8-per-level fetches, which is the number
        // the A/B has to justify.
        const dRaw = freeRadius(p, capWorldV).toVar();
        // Light-source self-exclusion: a ray aimed AT the light must not be
        // occluded by the light's own shell. Sphere region test for sphere
        // lamps; for box lamps the COMPARATIVE test against the lamp's analytic
        // SDF, because a big panel's bounding sphere swallowed every wall
        // within ~1.5R and poured light through ceilings.
        const relEx = p.sub(excludeCenter).toVar();
        const localEx = vec3(relEx.dot(excludeBx), relEx.dot(excludeBy), relEx.dot(excludeBz));
        const lampDist = localEx.abs().sub(excludeHalf).max(vec3(0)).length().toVar();
        const slack = minCellV.mul(1.5).max(lampDist.mul(0.25));
        const outsideLight = select(
          excludeHalf.x.greaterThanEqual(0),
          dRaw.lessThan(lampDist.sub(slack)),
          relEx.length().greaterThan(excludeRadius),
        );
        const planeHeight = liftV.add(t.mul(cosRayNormal));
        const isRealOccluder = dRaw
          .lessThan(planeHeight.sub(planeCut))
          .and(dRaw.lessThan(capCut))
          .and(outsideLight)
          .toVar();
        If(isRealOccluder.and(dRaw.lessThan(contactCut)), () => {
          penumbra.assign(0);
          resolved.assign(1);
          Break();
        });
        if (stable) {
          // Same closest-approach estimator, admitted CONTINUOUSLY: the three
          // `isRealOccluder` tests become ramps so a sample fades toward 1 (a
          // no-op in the min) as it approaches exclusion instead of vanishing
          // from the min in one frame. `prevW` fades the pairing the same way.
          const planeW = smoothstep(planeHeight.sub(planeCut.mul(1.25)), planeHeight.sub(planeCut.mul(0.75)), dRaw)
            .oneMinus()
            .toVar();
          const capW = smoothstep(capCut.mul(0.9), capCut, dRaw).oneMinus();
          const w = planeW.mul(capW).mul(select(outsideLight, float(1), float(0))).toVar();
          const y = dRaw.mul(dRaw).div(prevD.mul(2)).min(dRaw).mul(prevW).toVar();
          const est = dRaw.mul(dRaw).sub(y.mul(y)).max(0).sqrt();
          const cand = est.mul(k).div(t.sub(y).max(1e-4)).clamp(0, 1);
          penumbra.assign(penumbra.min(mix(float(1), cand, w)));
          prevD.assign(dRaw);
          prevW.assign(w);
        } else {
          If(isRealOccluder, () => {
            const y = dRaw.mul(dRaw).div(prevD.mul(2)).min(dRaw).toVar();
            const est = dRaw.mul(dRaw).sub(y.mul(y)).max(0).sqrt();
            penumbra.assign(penumbra.min(est.mul(k).div(t.sub(y).max(1e-4))));
            prevD.assign(dRaw);
          }).Else(() => {
            // Excluded samples describe excluded geometry; pairing one with a
            // real sample fabricates a closest approach that never existed.
            prevD.assign(1e10);
          });
        }
        lastD.assign(dRaw);
        t.addAssign(dRaw.mul(0.85).clamp(stepMin, stepMax));
      });

      // FAIL CLOSED ON STEP EXHAUSTION, BUT ONLY WHERE THE RAY WAS HUGGING
      // GEOMETRY WHEN IT RAN OUT. Unconditional fails put the scene in shadow
      // with only the roof openings lit; not failing at all leaks a grazing
      // sun through every slab. The discriminator is the last sample's
      // distance, and it is scaled continuously rather than selected, because a
      // per-ray binary flip under a moving light is a flickering pixel.
      if (!globalThis.__giShadowFailOpen && !globalThis.__giNoFailClosed) {
        const exhausted = resolved.oneMinus();
        const inGeometry = smoothstep(planeCut.mul(4), planeCut, lastD);
        penumbra.mulAssign(exhausted.mul(inGeometry).oneMinus());
      }

      return penumbra.clamp(0, 1);
    },
  });

  return (origin, dir, maxT, k, cosRayNormal, excludeCenter = null, excludeRadius = null, excludeBox = null) =>
    traceFn(
      vec3(origin),
      vec3(dir),
      float(maxT),
      float(k),
      float(cosRayNormal),
      excludeCenter ? vec3(excludeCenter) : vec3(0, 0, 0),
      excludeRadius ? float(excludeRadius) : float(-1),
      excludeBox ? vec3(excludeBox.half) : vec3(-1, -1, -1),
      excludeBox ? vec3(excludeBox.bx) : vec3(1, 0, 0),
      excludeBox ? vec3(excludeBox.by) : vec3(0, 1, 0),
      excludeBox ? vec3(excludeBox.bz) : vec3(0, 0, 1),
    );
}

/**
 * The volume bundle SRC hands to the screen chain: the two shadow factories, the
 * world uniforms, and the spine every survivor stands on. `giField.js`'s
 * equivalent carries six radiance buffers, a distance texture, a slot atlas, a
 * sparse brick page table and a composite pass on top; every one of THOSE is
 * transport and dies in §5.
 *
 * Signature-compatible with the `volume` object at the surviving call sites —
 * `createSoftShadowTrace(lift, steps, name, stable)`, `createWidthProbe(name)`,
 * `world`, `occupancyField`, `rayHitMode`, `distance`, plus `res`/`bounds`/
 * `cell`/`minCell`/`capWorld`/`setBounds` (§12.8.2) — so the GISystem rewrite
 * can swap the producer without touching the consumers, which is what keeps that
 * edit reviewable. NOT compatible with, and never will be: `compositeCompute`,
 * `distanceTexture`, `grid`, `sparse`, `updateGrid`, `updateSparse`,
 * `coarseLevel`, `atlas`, `createSceneTrace`, `readbackStats` and the six
 * buffers. Those call sites are the deletion, not the swap.
 *
 * `world` may be supplied by the caller. The A/B seam passes giField's own
 * bundle so the two arms share one set of tuned constants and differ ONLY in
 * the distance source; production builds let this construct its own.
 */
export function createSrcVolume({
  occField,
  bounds = null,
  res = null,
  world = null,
  rayHitMode = undefined,
  recordAware = true,
} = {}) {
  if (!occField) throw new Error("createSrcVolume: an occupancy field is required — it is the only distance source");
  const w = world ?? createSrcWorld(bounds, res, occField);
  // ONE distance closure per volume, shared by both factories. `sharedFn`
  // already gives one WGSL function per shader per variant, so this only makes
  // the two arms provably agree about `maxLevel`/`recordAware` — a mismatch
  // there would light one pixel against a sharper medium than the pixel beside
  // it, which is the §6.6 lesson.
  const distance = createSrcDistance(occField, w, { recordAware });
  return {
    world: w,
    occupancyField: occField,
    rayHitMode,
    distance,

    // ══ THE SPINE, i.e. what giField.js ADDS ON TOP OF THE WORLD BUNDLE ══════
    //
    // §12.7's closing order said giField "dies as a unit". It does not — its
    // return object mixes the dense transport with the spine that 40-odd
    // GISystem call sites stand on (28 × `occupancyField`, 12 × `world`), and
    // these few members are the rest of it (§12.8.2). PLAIN VALUES, not
    // uniforms, deliberately: that is what the surviving call sites read
    // (`volume.minCell` at three of them, all CPU-side sizing), and giField
    // mutates them in place on a refit. Matching its shape is what keeps the
    // producer swap a one-line change at the call site instead of a sweep.
    res,
    bounds,
    // LIVE REFERENCES into the world bundle, not copies — `world.refit` writes
    // through `w.cell.value`, so a reader of `volume.cell` sees the refit
    // without anyone having to remember to re-mirror it. The numbers below
    // cannot work that way (they are primitives), which is why `setBounds`
    // reassigns them explicitly and why they are the ones worth testing.
    cell: w.cell.value,
    minCell: w.minCellValue,
    capWorld: w.capWorldValue,

    /**
     * In-place volume refit — the world/occupancy half of giField's `setBounds`.
     *
     * WHAT IS DELIBERATELY MISSING: giField's version also re-expanded the slot
     * atlas's AABBs (`atlas.aabbExpand = capWorld`) and invalidated the instance
     * grid and the sparse brick page table. All three are transport and die in
     * §5 — the SDF tile atlas is the half of `slotRegistry.js` that goes
     * (§12.8.3), and grid/sparse go whole. A refit that still had to poke them
     * would mean the split had not actually happened.
     *
     * `occField.refit()` is NOT optional and is the one easy thing to drop here:
     * the pyramid shares `world.min`/`world.size` as uniforms, so its shaders
     * need no touching, but its voxel SIZE is derived rather than uniform-shared
     * and every bit in it was rasterized against the old bounds.
     */
    setBounds(next) {
      // A world supplied by the A/B seam is giField's own bundle, which refits
      // by having giField.setBounds write its uniforms directly — it has no
      // `refit` of its own. Nothing calls this on that arm (giField owns the
      // refit there), so the honest response is to say so rather than no-op:
      // a silently skipped refit is a volume whose cells lie about their size.
      if (typeof w.refit !== "function") {
        throw new Error(
          "createSrcVolume.setBounds: this volume borrowed its world bundle (the giField A/B seam) — refit it through giField.setBounds instead",
        );
      }
      bounds?.min.copy(next.min);
      bounds?.max.copy(next.max);
      w.refit(next);
      this.minCell = w.minCellValue;
      this.capWorld = w.capWorldValue;
      occField?.refit();
    },
    createSoftShadowTrace: (lift, steps, name = undefined, stable = false) =>
      createSrcSoftShadowTrace(occField, w, {
        lift, steps, name: name ?? "srcShadowTrace", stable, distance,
      }),
    createWidthProbe: (name = undefined) =>
      createSrcWidthProbe(occField, w, { name: name ?? "srcShadowWidthProbe", distance }),
  };
}
