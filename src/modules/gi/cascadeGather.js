// 3D Radiance Cascades — final gather (Phase 4).
//
// Turns the merged c0 field into per-surface irradiance:
//   E(P, N) ≈ Σ_probes w_probe · Σ_dirs L_merged(dir) · max(dot(dir, N), 0) · Δω
// over the 8 c0 probes surrounding P (trilinear), Δω = 4π / dirCount.
// Diffuse response is then albedo · E / π at the material.
//
// The probe weighting reuses the SAME distance-visibility proxy as the
// merge (cascadeMerge.js): a probe whose own c0 ray toward P records a hit
// closer than |P − probe| is behind a surface relative to P — rejected.
// This is what keeps buried/behind-wall probes (visible as dark gizmos in
// the Phase 3 screenshots) from bleeding darkness or wrong-side light onto
// receivers. c0's interval starts at t = 0, so the proxy has no near-field
// blind zone at gather range (unlike the inter-cascade case).
//
// IMPORTANT (plan constraint): this is THE sampling implementation — the
// debug gizmos and any screen-space/deferred variant must call this same
// function, so a live-editor discrepancy can only implicate glue, not a
// second transport implementation. Direct material shading here deliberately
// bypasses any G-buffer/deferred-resolve layer (where the prior attempt's
// never-root-caused stripe bug lived).
import { Fn, If, Loop, Return, cos, float, floor, fract, instanceIndex, instancedArray, max, mix, mod, select, sin, smoothstep, sqrt, step, texture3D, uniform, vec2, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex, octahedralUV } from "./cascadeTrace.js";
import { sharedFn } from "./giFn.js";
import { emitterAngularRadius, emitterSlotFactor, emitterSurfaceT } from "./giLight.js";
import { RayHitMode } from "./rayHit/RayHitConfig.js";



// RELATIVE weight a BURIED probe keeps (one inside geometry — see the gather's
// buried-probe note). Deliberately a small epsilon and NOT zero: every consumer
// of these weights divides by their sum, so when at least one open probe is in
// the neighbourhood a buried one is ~50x down and effectively gone, and when
// EVERY probe is buried the epsilon cancels in the normalization and the result
// is exactly what it was before this cut existed. That is the whole
// all-rejected safety net, for free — no second accumulator, no branch. A hard
// zero would have blacked out receivers deep inside thick geometry at the low
// preset, where probes are ~2 m apart.
export const BURIED_PROBE_WEIGHT = 0.02;

// ── THE VISIBILITY TOLERANCE IS TWO TERMS AND WAS ONLY EVER WRITTEN AS ONE ────
//
// Both halves of the visibility contract — the merge's PARENT-probe proxy
// (cascadeMerge.js) and this file's CAGE-probe proxy — fade a probe out over
// [visTol, 2·visTol] of blocker PENETRATION, where
//     penetration = dist − storedRay.w
// and `visTol = traceQuantization · 1.75`. `traceQuantization` is the level-0
// occupancy voxel, i.e. the hit-distance quantization of the TRACE MEDIUM, and
// both files state that as the justification in as many words. The
// justification is now FALSE on every shipping preset, because the error in
// `storedRay.w` is two independent things and one constant conflates them:
//
//   RADIAL — the hit-distance quantization. MODE-DEPENDENT. Under
//     `occupancy-legacy` the march returns `t` at the ENTRY FACE of the occupied
//     level-0 voxel (occupancyField.js:1789-1794), so the error is up to one
//     voxel chord and it is ALWAYS EARLY — the value the tolerance must forgive.
//     docs/radiance_cascades_ray_hit_phase_2.md:87 measures **0.750 cell units**
//     on a flat floor for that occupied-box hit. The same line measures the
//     hybrid record modes (plane / plane-coverage / exact-complex) at **2.6e-5
//     cell units**: four orders of magnitude smaller, because the hit is solved
//     against a fitted plane or a real triangle instead of a voxel face.
//     `rayHitMode`'s default flipped from `occupancy-legacy` to `auto` in
//     b5961d7, and RayHitConfig.js:60-75 resolves low/medium → HybridPlane and
//     high/ultra/anything-else → HybridExactComplex — so on every shipping
//     preset this tolerance has been ~4 orders of magnitude larger than its own
//     stated reason for existing, on the permissive side.
//
//   ANGULAR — MODE-INDEPENDENT, and the term nobody wrote down. Neither proxy
//     reads the stored ray toward the OTHER probe; both read
//     `octahedralTexelIndex(rel/dist, dirRes)` — the NEAREST OF dirCount COARSE
//     DIRECTIONS. On a grazing surface the distance along the sampled direction
//     diverges from the distance along the true one, and that divergence grows
//     with the probe↔probe separation: it scales with `dist`, not with the
//     voxel. THIS IS THE DOTTED-LATTICE MECHANISM — the long note at
//     cascadeMerge.js's use site describes exactly it (measured period 1.01 m at
//     ultra where c0 spacing is 0.50 m; bandRMS 0.678 → 0.223 once the hard cut
//     became this smoothstep), and it is why a fade exists at all.
//
// MEASURED CONSEQUENCE of the conflation (bleed rig, far-field falloff vs the
// analytic −2.72, white channel; block rig floor modulation):
//     rayHitMode auto (ships today)      falloff −2.18   modulation 9.39%
//     __giRayHitMode=occupancy-legacy    falloff −2.97   modulation 5.65%
// On the user's real Sponza the two are perf-neutral (queue 14.98 vs 14.90 ms)
// and legacy looks visibly better — but legacy OVERSHOOTS the analytic target
// (−2.97 vs −2.72) and it disables surface records wholesale (GISystem.js:6180
// gates them on activeMode >= HybridPlane), taking the record-aware shadow
// oracle down with them. Reverting the mode is not the fix. The tolerance is.
//
// ── THE TRAP ──────────────────────────────────────────────────────────────────
// DO NOT simply shrink the tolerance to the hybrid modes' true radial error.
// 2.6e-5 voxels is zero for practical purposes, and a zero tolerance collapses
// the smoothstep back into the hard binary cut that PRODUCED the dotted lattice
// this fade was written to remove. The radial term was accidentally paying the
// angular term's bill; take it away and something has to take the bill over.
// Hence the split:
//
//     visTol = radialQuantization(activeRayHitMode) · kRadial  +  dist · kAngular
//
// radial half mode-aware and in world units, angular half dimensionless.
//
// DEFAULTS REPRODUCE TODAY EXACTLY, on purpose: mode-awareness OFF,
// kRadial = 1.75, kAngular = 0 — so the folded coefficients are `1.75` and `0`
// and the emitted node graph is the pre-split one, node for node, in every mode.
// The new behaviour is opt-in so it can be A/B'd like everything else here; a
// change that silently moves the shipped look is not measurable.
//
// HATCHES (BUILD-TIME — the coefficients are folded into the node graph, so an
// A/B has to force a rebuild: the voxelSize nudge in
// scripts/run-gi-block-size.mjs's ABLATE path). All three are `Number.isFinite`
// reads, never `Number(x) || default`, because **0 is meaningful for all of
// them** — 0 radial is the pure-angular arm, 0 angular is today's behaviour, and
// `Number(x) || d` would hand back the default and report it as the ablation
// (the exact bug fixed in `__giMergeVisTol` on 2026-08-07):
//   `__giVisTolModeAware`  default false → the radial term stays one whole
//                          level-0 voxel regardless of mode, i.e. today.
//   `__giVisTolRadial`     default 1.75 (= today's constant).
//   `__giVisTolAngular`    default 0    (= today's absent term).
// They apply to BOTH halves of the contract. `__giMergeVisTol` and
// `__giGatherVisTol` survive unchanged as per-half OVERALL SCALES on top (see
// resolveVisTolTerms) — including `= 0`, which still yields a hard cut.
export const DEFAULT_VIS_TOL_RADIAL = 1.75;
export const DEFAULT_VIS_TOL_ANGULAR = 0;

// Radial hit-distance error, expressed in LEVEL-0 VOXELS so it can multiply the
// existing `traceQuantization` node (a uniform-derived world length — an in-place
// refit must rescale it, so this side stays a pure scalar).
//
// LEGACY IS 1, NOT the measured 0.750: 0.750 is one flat-floor sample of a
// quantity whose bound is a full voxel chord, and 1 is what ships today —
// changing it would move the default. HYBRID IS THE MEASURED 2.6e-5, verbatim
// from docs/radiance_cascades_ray_hit_phase_2.md:87 (`test:gi-rayhit-phase2`,
// deterministic, vs exact double-precision Möller-Trumbore).
export const LEGACY_RADIAL_QUANT_VOXELS = 1;
export const HYBRID_RADIAL_QUANT_VOXELS = 2.6e-5;

/**
 * Radial hit-distance error of the ACTIVE (resolved) ray-hit mode, in level-0
 * voxels. Takes `rayHitConfig.activeMode`, never the component's raw prop —
 * `"auto"` is not a mode, and the whole bug is that this term never knew which
 * mode was actually running.
 *
 * The mode window is deliberately the SAME predicate GISystem.js:6180 uses to
 * enable surface records (`>= HybridPlane && <= HybridExactComplex`), because
 * the records ARE the reason the hit is sub-voxel: HybridBrickBox keeps the
 * legacy occupied-box hit (docs/radiance_cascades_ray_hit_phase_2.md:27), so it
 * belongs on the voxel-sized side with legacy, not with the record modes.
 *
 * @param {number|null|undefined} activeRayHitMode
 */
export function radialQuantizationVoxels(activeRayHitMode) {
  const mode = Number(activeRayHitMode);
  if (!Number.isFinite(mode)) return LEGACY_RADIAL_QUANT_VOXELS;
  return mode >= RayHitMode.HybridPlane && mode <= RayHitMode.HybridExactComplex
    ? HYBRID_RADIAL_QUANT_VOXELS
    : LEGACY_RADIAL_QUANT_VOXELS;
}

/**
 * Folds the two-term tolerance into the two JS scalars the node graph needs:
 *
 *     visTol = traceQuantization · radialCoef  +  dist · angularCoef
 *
 * Folding here rather than in TSL is what keeps the default graph IDENTICAL: at
 * defaults `radialCoef === 1.75` and `angularCoef === 0`, and each use site skips
 * emitting the angular add entirely when the coefficient is 0, so the shipped
 * shader has the same nodes it had before the split.
 *
 * `overallTolerance` is this half's existing scale hatch (`__giMergeVisTol` /
 * `__giGatherVisTol`, both default 1.75). It is applied as a RATIO against
 * DEFAULT_VIS_TOL_RADIAL, so unset it is exactly 1 (x/x is exact in IEEE754) and
 * the folded numbers are bit-identical to the literals they replace, while
 * `__giMergeVisTol = 0` still zeroes BOTH terms — i.e. the hard-cut ablation arm
 * keeps meaning what it meant.
 *
 * @param {number|null|undefined} activeRayHitMode `rayHitConfig.activeMode`
 * @param {number} overallTolerance this half's `__gi*VisTol` value
 */
export function resolveVisTolTerms(activeRayHitMode = null, overallTolerance = DEFAULT_VIS_TOL_RADIAL) {
  const rawRadial = Number(globalThis.__giVisTolRadial);
  const kRadial = Number.isFinite(rawRadial) ? rawRadial : DEFAULT_VIS_TOL_RADIAL;
  const rawAngular = Number(globalThis.__giVisTolAngular);
  const kAngular = Number.isFinite(rawAngular) ? rawAngular : DEFAULT_VIS_TOL_ANGULAR;
  // Boolean-or-numeric: the harnesses coerce `k=true` to a boolean and `k=1` to
  // a Number (run-gi-block-size.mjs's GLOBALS/ABLATE parser), so accept both.
  const rawModeAware = Number(globalThis.__giVisTolModeAware);
  const modeAware = globalThis.__giVisTolModeAware === true ||
    (Number.isFinite(rawModeAware) && rawModeAware !== 0);
  const radialVoxels = modeAware
    ? radialQuantizationVoxels(activeRayHitMode)
    : LEGACY_RADIAL_QUANT_VOXELS;
  const overallScale = Number.isFinite(overallTolerance)
    ? overallTolerance / DEFAULT_VIS_TOL_RADIAL
    : 1;
  return {
    modeAware,
    radialVoxels,
    kRadial,
    kAngular,
    radialCoef: radialVoxels * kRadial * overallScale,
    angularCoef: kAngular * overallScale,
  };
}

/**
 * Per-probe AMBIENT-CUBE irradiance, precomputed once per frame from the
 * merged c0 field: for each probe, 6 axis irradiances
 * E_axis = π · Σ(L·cos)/Σcos over the c0 directions (the exact same
 * normalization the per-pixel gather used to evaluate inline). Receivers
 * then pay 8 probes × (1 irradiance fetch + 1 visibility fetch) instead of
 * 8 × dirCount radiance reads — ~5× fewer reads per pixel AND per feedback
 * cell, with an identical integral (it's the same sum, hoisted).
 *
 * `w` carries the probe's OPENNESS (see BURIED_PROBE_WEIGHT), computed here
 * rather than at the receiver on purpose: it is a property of the probe, so
 * paying for it once per probe instead of 8× per shaded pixel makes the cut
 * free at the point of use — the gather already fetches this vec4.
 *
 * `smoothing` (0..1, 1 = off) is a per-probe EMA toward this frame's integral.
 * GEOMETRY IS STATIC AND ONLY LIGHT MOVES, so the fixed point is unchanged: a
 * still scene converges to exactly the unsmoothed answer within a few frames
 * and looks identical. What it removes is the frame-to-frame POPPING while a
 * light sweeps, which is what the probe lattice quantizes into blocks. A zero
 * `w` means "never written" (the buffer is zero-initialised and openness is
 * never 0), so a fresh build snaps instead of fading up from black.
 */
export function createProbeIrradiance(cascades, options = {}) {
  const c0 = cascades[0];
  const { dirCount } = c0;
  const probeCount = c0.probeCount;
  const buffer = instancedArray(new Float32Array(probeCount * 6 * 4), "vec4");
  const occupancy = options.occupancy ?? null;
  const smoothing = options.smoothing ?? null;

  const compute = Fn(() => {
    const probe = instanceIndex.div(6).toVar();
    const axisIdx = instanceIndex.mod(6).toVar();
    const compF = axisIdx.div(2).toFloat().toVar(); // 0:x 1:y 2:z
    const sgn = axisIdx.mod(2).toFloat().mul(-2).add(1).toVar(); // even:+ odd:-
    const axis = vec3(
      step(compF, 0.5),
      step(0.5, compF).mul(step(compF, 1.5)),
      step(1.5, compF),
    ).mul(sgn).toVar();

    const sumL = vec3(0).toVar();
    const sumCos = float(0).toVar();
    const rowBase = probe.toFloat().mul(dirCount).toVar();
    Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
      const dir = c0.directionOf(d.toFloat());
      const cosTheta = max(dir.dot(axis), 0);
      sumL.addAssign(c0.merged.element(rowBase.add(d).toInt()).xyz.mul(cosTheta));
      sumCos.addAssign(cosTheta);
    });
    const irradiance = sumL.div(max(sumCos, 1e-3)).mul(Math.PI);

    // OPENNESS — "is this probe inside geometry". CONTINUOUS, not a bit:
    // the binary cut made a MOVING object pop as it swallowed each probe —
    // the whole trilinear neighbourhood lost that probe in one frame, and a
    // sweeping sphere read as banded patches snapping at every lattice
    // crossing. Fade over the probe's last level-0 voxel of clearance
    // instead (the near-field oracle is continuous by design): the ramp is
    // narrow enough that a legitimate probe half a cell off a floor keeps
    // ~full weight, while a probe about to be swallowed ramps out over
    // ~0.16m of object travel. Fully buried still lands on
    // BURIED_PROBE_WEIGHT exactly as before.
    const openness = float(1).toVar();
    if (occupancy?.occupiedAtWorld && !globalThis.__giNoBuriedProbeCut) {
      const probePos = c0.probePositionOf(probe.toFloat());
      if (occupancy.freeRadiusAtWorld && occupancy.voxel) {
        // `voxel` is the field's live UNIFORM (a TSL node, not a Vector3 —
        // Math.max on it emits NaN into the WGSL), so take the max GPU-side;
        // it also keeps the fade width correct across refits.
        const vox = vec3(occupancy.voxel);
        const fadeR = vox.x.max(vox.y).max(vox.z);
        openness.assign(
          mix(
            float(BURIED_PROBE_WEIGHT),
            float(1),
            smoothstep(float(0), fadeR, occupancy.freeRadiusAtWorld(probePos, 1)),
          ),
        );
      } else {
        openness.assign(
          mix(float(1), float(BURIED_PROBE_WEIGHT), occupancy.occupiedAtWorld(probePos, 0)),
        );
      }
    }

    const value = vec3(irradiance).toVar();
    const opennessOut = float(openness).toVar();
    if (smoothing) {
      const prev = buffer.element(instanceIndex).toVar();
      // OPENNESS EMA — always integrating, INDEPENDENT of probeSmoothing's
      // value (which the user's scene sets to 1 = off): openness is a
      // visibility WEIGHT recomputed fresh from the occupancy bits every
      // frame, so a mover's whole-voxel footprint snaps stepped it per frame
      // — part of the measured object-motion flicker (Phase 2). The shared
      // depthMomentsAlpha (~8 frames) integrates the churn; a real burial
      // change converges in ~150ms, invisible next to the burial ramp
      // itself. prev.w < 1e-3 = never written (openness is floored at
      // BURIED_PROBE_WEIGHT = 0.02, so a real value can't hit the sentinel)
      // → snap, the fresh-build rule.
      opennessOut.assign(
        select(
          prev.w.lessThan(1e-3),
          openness,
          mix(prev.w, openness, float(depthMomentsAlpha).clamp(0.01, 1)),
        ),
      );
      // ADAPTIVE HYSTERESIS (the DDGI recipe for "smoothing hides flicker but
      // lighting reacts too slowly"): the EMA's alpha is not one number. For
      // SMALL relative changes — voxel-quantization popping, ray-set churn as
      // things cross cell boundaries — keep the user's heavy smoothing. For
      // LARGE relative changes — a light or object actually moved — ramp the
      // alpha up toward `probeSnapAlpha` so the probe converges in a few
      // frames instead of ~1/alpha. The ramp runs over relative luminance
      // delta [15%, 60%]: below it is noise (checker cadence and per-cell
      // churn measure well under 15% per frame at probe scale), above it is
      // signal. `__giProbeSnap = 0` restores the fixed-alpha EMA live.
      const base = float(smoothing).clamp(0.02, 1);
      const delta = irradiance.sub(prev.xyz).abs();
      const mag = prev.x.max(prev.y).max(prev.z)
        .max(irradiance.x.max(irradiance.y).max(irradiance.z))
        .max(1e-4);
      const rel = delta.x.max(delta.y).max(delta.z).div(mag);
      const boost = smoothstep(0.15, 0.6, rel);
      // ALWAYS-ON NOISE-BAND INTEGRATION (2026-08-03, per-frame instrument
      // run-gi-flicker-frame.mjs): with the user's Light Smoothing OFF
      // (probeSmoothing 1 — their scene's saved value), the probe EMA was a
      // straight passthrough and every voxel-snap pop landed raw on screen —
      // measured 2.38 reversals/px vs 0.29 with the EMA active, i.e. THE
      // object-motion flicker. But Light Smoothing is the LIGHT-RESPONSE
      // knob; it must not double as "let churn through". Split the bands:
      // small relative deltas (below the 15% noise threshold — voxel
      // quantization, ray-set churn) integrate at ≤ probeNoiseAlpha (~4
      // frames) REGARDLESS of the knob; large deltas (a light or object
      // actually moved) keep the user's alpha — instant at 1. Nothing the
      // eye should follow is slowed; only sub-threshold oscillation is
      // refused. `__giProbeNoise = 0` restores the raw passthrough (A/B).
      //
      // ── THE HATCH THIS COMMENT PROMISED DID NOT EXIST UNTIL 2026-08-07 ─────
      // `probeNoiseAlpha` was a bare `uniform(0.25)` that NOTHING ever wrote:
      // GISystem's per-tick hatch block writes `probeSnapAlpha` and
      // `depthMomentsAlpha` from `__giProbeSnap`/`__giDepthAlpha` and skips this
      // one, so `__giProbeNoise` was named in two comments (here and at the
      // export below) and read nowhere. Every "I set __giProbeNoise=0 and saw no
      // difference" was that, not a null result. Read it HERE, at the point of
      // use, BUILD-TIME (like `__giNoChebyshev`/`__giNoPlaneCut` below): unset →
      // the live uniform, byte-for-byte today's graph; set → a literal.
      //
      // `Number.isFinite`, NOT `Number(x) || 0.25`: **0 is the whole point of
      // this hatch** (raw passthrough), and `||` would swallow it back to 0.25.
      // Same family as `__giBilateralWorldEps` in giLight.js.
      const rawProbeNoise = Number(globalThis.__giProbeNoise);
      // A factory, not one shared node: this reproduces the two independent
      // `float(probeNoiseAlpha)` expressions the unset path used to emit,
      // node-for-node, so "unset = today's graph" needs no argument about TSL
      // node reuse.
      const noiseAlpha = () =>
        (Number.isFinite(rawProbeNoise) ? float(rawProbeNoise) : float(probeNoiseAlpha));
      const noiseFloor = select(
        noiseAlpha().greaterThan(1e-3),
        base.min(noiseAlpha()),
        base,
      );
      // `probeSnapAlpha` IS live-hatched — GISystem writes
      // `probeSnapAlpha.value = __giProbeSnap ?? 0.35` every tick and this is
      // the expression that consumes it — but READ THE `max` BEFORE TRUSTING IT:
      //
      //   **`__giProbeSnap` IS INERT WHENEVER `probeSmoothing >= probeSnapAlpha`.**
      //
      // `max(probeSnapAlpha, base)` takes `base` in that case and the snap value
      // never appears. The user's own scene (and this module's block rig) run
      // probeSmoothing = 1, i.e. base = 1, so `__giProbeSnap` — including
      // `__giProbeSnap = 0`, documented below as "disables adaptivity" — changes
      // NOTHING there: the mix is already between `noiseFloor` and 1. That cost
      // a whole measurement run. At probeSmoothing 1 the only knob that moves
      // this expression is `__giProbeNoise` above.
      //
      // Two ways to flatten the mix to a constant, and they are NOT the same:
      //   · `__giProbeNoise = 0` at probeSmoothing 1 → noiseFloor = base = 1 and
      //     max(snap, 1) = 1, so adaptive ≡ 1: no probe EMA at all, no lag, no
      //     per-probe threshold. This is what "probeSmoothing 1 = no probe EMA"
      //     was always assumed to mean.
      //   · probeSmoothing = 0.25 with `__giProbeSnap = 0.25` → noiseFloor =
      //     min(0.25, 0.25) and max(0.25, 0.25) both equal 0.25, so adaptive ≡
      //     0.25 regardless of `boost`: the per-probe threshold is gone but the
      //     ~4-frame lag is kept. That is the arm for "is the artifact the
      //     THRESHOLD or the LAG".
      const adaptive = mix(noiseFloor, float(probeSnapAlpha).max(base), boost);
      // prev.w == 0 ⇒ this slot has never been written (fresh build/refit):
      // take the integral outright rather than lerping up from black.
      const alpha = select(prev.w.lessThan(1e-3), float(1), adaptive);
      value.assign(mix(prev.xyz, irradiance, alpha));
    }
    buffer.element(instanceIndex).assign(vec4(value, opennessOut));
  })().compute(probeCount * 6);

  return { buffer, compute };
}

/**
 * PER-FRAME BLEND of the probe depth moments toward this frame's trace
 * (createProbeDepthMoments): ~0.12 ≈ an 8-frame time constant. Deliberately
 * INDEPENDENT of probeSmoothing — the moments smooth visibility WEIGHTS
 * (which of 8 cage probes a receiver trusts, renormalized), not radiance, so
 * they must keep integrating even when the user turns Light Smoothing off —
 * which the user's own scene does (probeSmoothing 1), and which is exactly
 * the configuration whose object-motion flicker this exists to fix.
 * Live via `__giDepthAlpha` (1 = no temporal integration, this frame only).
 */
export const depthMomentsAlpha = uniform(0.12);

/**
 * DDGI-STYLE PER-PROBE DEPTH MOMENTS (GI_FLICKER_PLAN.md Phase 2 — the
 * gather-side residual of the object-motion flicker).
 *
 * THE PROBLEM WITH THE RAW PROXY IT REPLACES: the gather weighted each cage
 * probe by comparing |probe→P| against the probe's own c0 ray hit distance
 * — read RAW from this frame's trace. A moving object re-voxelizes per
 * frame and its footprint snaps in whole voxels, so that hit distance
 * STEPS; near the tolerance boundary the probe's weight flips per frame,
 * and a receiver's surviving-probe set churns — flicker that no radiance
 * smoothing can touch, because it lives in the WEIGHTS. Measured 2026-08-03
 * (run-gi-flicker.mjs, ultra, probeSmoothing off): 98% of tiles popping.
 *
 * THE FIX: per (probe, c0 direction), integrate the mean and second moment
 * of the hit distance over time (EMA, `depthMomentsAlpha`), and let the
 * gather weight probes by a Chebyshev visibility test against (μ, σ²)
 * instead of a smoothstep against one raw sample. Temporal churn ENTERS the
 * moments as variance — which SOFTENS the cut exactly where the geometry is
 * churning — instead of flipping a binary verdict. One thread per ray-texel;
 * two MACs more than the old proxy per gather corner.
 *
 * A miss (w < 0) integrates as the c0 interval end, NOT a huge constant:
 * the proxy only ever saw occluders within c0's interval, and a mostly-miss
 * direction must read as "no occluder in reach" (the gather gates on
 * μ < 0.95·interval), not blow up σ². First write (μ=μ²=0 sentinel — a real
 * depth² is always > 0) snaps to this frame outright, fresh-build rule.
 */
export function createProbeDepthMoments(cascades) {
  const c0 = cascades[0];
  const { dirCount } = c0;
  const buffer = instancedArray(new Float32Array(c0.probeCount * dirCount * 2), "vec2");
  const compute = Fn(() => {
    const ray = c0.rays.element(instanceIndex).toVar();
    const reach = float(c0.intervalLen).toVar();
    const depth = select(ray.w.greaterThanEqual(0), ray.w.min(reach), reach).toVar();
    const fresh = vec2(depth, depth.mul(depth)).toVar();
    const prev = buffer.element(instanceIndex).toVar();
    const alpha = select(
      prev.x.add(prev.y).lessThan(1e-8),
      float(1),
      float(depthMomentsAlpha).clamp(0.01, 1),
    );
    buffer.element(instanceIndex).assign(mix(prev, fresh, alpha));
  })().compute(c0.probeCount * dirCount);
  return { buffer, compute };
}

/**
 * LIVE RECEIVER-GATHER SURFACE BIAS, as a fraction of a probe cell along the
 * receiver's normal. Default 0.5 — user-eye-tuned against their Blender
 * reference (2026-08-03); `__giGatherBias = 0` in the console restores the
 * unbiased cage. GISystem copies the override into it every tick (the
 * hatch-must-be-a-uniform rule), so it is tunable live.
 *
 * WHY IT EXISTS: on a CURVED receiver (the test-sphere report: "weird colour
 * transitions that depend on the probe positions") the visibility cuts below
 * change which of the 8 cage probes survive as the surface normal rotates
 * through the lattice — flat surfaces are immune (coplanar probes keep full
 * weight), curved ones show the surviving-set switching as banded patches.
 * Biasing the TRILINEAR CAGE POSITION off the surface (the standard DDGI
 * surface bias) moves the cage toward open space so the surviving set changes
 * less abruptly. ONLY the cage/tent coordinates use the biased point — every
 * visibility cut still measures the TRUE receiver position and normal, so the
 * leak defences (plane cut, angle cut, proxy, buried-probe) are unchanged.
 */
export const gatherBias = uniform(0.5);

/**
 * ADAPTIVE-HYSTERESIS SNAP ALPHA (see createProbeIrradiance's EMA): the
 * per-frame blend a probe ramps TOWARD when its irradiance changes a lot in
 * one frame. 0.35 ≈ converged in ~4 frames. Live via `__giProbeSnap`
 * (0 disables adaptivity — the EMA becomes the old fixed-alpha one).
 *
 * CAVEAT, measured the hard way: the use site takes
 * `max(probeSnapAlpha, probeSmoothing)`, so this uniform is INERT whenever
 * `probeSmoothing >= probeSnapAlpha` — at probeSmoothing 1 (the block rig's and
 * the user's scene's value) `__giProbeSnap` does nothing at all, including
 * `__giProbeSnap = 0`. See the long note at the use site.
 */
export const probeSnapAlpha = uniform(0.35);

/**
 * NOISE-BAND alpha ceiling for the probe EMA (see the noiseFloor note in
 * createProbeIrradiance): sub-15%-relative irradiance wiggles integrate at
 * most this fast even when Light Smoothing is off. ~0.25 ≈ 4-frame ramp —
 * kills pop-and-return churn, invisible as lag.
 *
 * `__giProbeNoise` (default 0.25 = this uniform's value; 0 disables — raw
 * passthrough, the flicker A/B arm) is read BUILD-TIME at the use site, NOT
 * copied into this uniform per tick the way GISystem copies `__giProbeSnap` into
 * `probeSnapAlpha`. Nothing writes this uniform, so its value is always 0.25 and
 * the hatch bypasses it entirely — set the global and force a rebuild (the
 * ABLATE voxelSize nudge in scripts/run-gi-block-size.mjs) for it to land.
 */
export const probeNoiseAlpha = uniform(0.25);

/**
 * VIEW-DIRECTION component of the same bias (fraction of a probe cell toward
 * the CAMERA), live via `__giGatherViewBias`, default 0.5 (eye-tuned with
 * the normal component above). Normal bias alone
 * fails at SILHOUETTES: grazing pixels have a normal pointing sideways, the
 * cage still lands inside the object, and a curved receiver shows a dark
 * blob just inside its outline that no reasonable normal bias removes —
 * while cranking the normal bias instead trades accuracy (the cage samples
 * open air). Pulling the cage toward the viewer is the standard DDGI split.
 * Only the screen resolve passes a real view vector; field-cell and
 * reflection-hit gathers pass vec3(0) (a zero V = normal-bias only).
 */
export const gatherViewBias = uniform(0.5);

/**
 * @param {Array} cascades from createRadianceCascades (uses cascades[0])
 * @returns {(P, N) => vec3} TSL irradiance sampler
 */
export function createIrradianceGather(cascades, probeIrradiance = null, fieldCellMax = null, name = "giGather", occupancy = null, depthMoments = null, activeRayHitMode = null) {
  const occupancyVoxel = occupancy?.voxel ?? null;
  const c0 = cascades[0];
  const { world, grid, dirCount, dirRes } = c0;
  // All world-space quantities are UNIFORM-derived nodes (world bundle) —
  // an auto-fit refit rescales the gather with zero recompiles.
  const cellX = world.size.x.div(grid.x);
  const cellY = world.size.y.div(grid.y);
  const cellZ = world.size.z.div(grid.z);
  // Visibility tolerance must absorb the FIELD's voxel quantization: a
  // probe ray toward a receiver ON a surface legitimately records its hit
  // up to ~a voxel diagonal early; tighter rejects valid probes in
  // scallops. CRITICAL: this must scale with the FIELD cell (the trace
  // medium's quantization), NOT the probe lattice spacing — auto-fit made
  // probes ~3× coarser than voxels, and a probe-scaled tolerance was fat
  // enough that probes behind a THIN partition passed the occlusion test
  // (their ray's hit at the partition read as "within tolerance") → rooms
  // lit through thin walls at fine field resolutions.
  const quantization = fieldCellMax != null ? float(fieldCellMax) : cellX.max(cellY).max(cellZ);
  const minProbeCell = cellX.min(cellY).min(cellZ);
  // The tolerance has to absorb the TRACE MEDIUM's quantization, and with the
  // occupancy backend that medium is the pyramid, not the composited field: a
  // c0 ray's recorded hit comes from a level-0 VOXEL (0.125–0.25 m), not from a
  // 0.35 m field cell. Sizing it off the coarser number made the proxy unable
  // to reject a probe hidden behind anything thinner than 0.61 m — which is
  // most floors — so it never fired where it was needed most.
  const traceQuantization = occupancyVoxel
    ? vec3(occupancyVoxel).x.max(vec3(occupancyVoxel).y).max(vec3(occupancyVoxel).z).min(quantization)
    : quantization;
  // ── ONE CONTRACT, TWO HALVES — AND ONLY THE OTHER HALF HAD A HATCH ────────
  //
  // 1.75 trace-quantizations is the SAME number as `DEFAULT_MERGE_VIS_TOLERANCE`
  // in cascadeMerge.js, and that is not a coincidence: both fade a probe out
  // over [tol, 2·tol] of blocker penetration, both are sized off the same
  // `traceQuantization` (the occupancy voxel, `min`-ed with the field cell), and
  // both exist for the same reason — a hard cut on a twice-quantized hit
  // distance produced the dotted-lattice artifact. The merge cuts a PARENT probe
  // out of a child's trilinear blend; this one cuts a CAGE probe out of a
  // receiver's gather. The same physical blocker is judged by both, one level
  // apart.
  //
  // So a tolerance change applied to one side is HALF APPLIED. The merge side
  // got `__giMergeVisTol` (cascadeMerge.js — DEFAULT_MERGE_VIS_TOLERANCE) and
  // this side stayed a bare literal, which means every merge-tolerance sweep
  // ever run moved one half of the contract while the other stayed at 1.75, and
  // the two halves can disagree about the same wall. Sweep BOTH, or say in the
  // result that you swept one.
  //
  // `__giGatherVisTol`, default 1.75 = today's literal exactly. BUILD-TIME (the
  // node graph bakes it), so an A/B has to force a rebuild — the voxelSize nudge
  // in scripts/run-gi-block-size.mjs's ABLATE path.
  //
  // `Number.isFinite`, not `Number(x) || 1.75`: **0 is a meaningful setting** —
  // it collapses the smoothstep to a step at the exact hit distance, i.e. the
  // hard binary cut this soft fade replaced, which is the ablation arm. `||`
  // would silently hand back 1.75 and report the default as the ablation.
  const rawGatherVisTol = Number(globalThis.__giGatherVisTol);
  const GATHER_VIS_TOLERANCE = Number.isFinite(rawGatherVisTol) ? rawGatherVisTol : DEFAULT_VIS_TOL_RADIAL;
  // TWO-TERM TOLERANCE — see the long decomposition note above BURIED_PROBE_WEIGHT.
  // `radialCoef` multiplies the trace medium's quantization (mode-aware only
  // when `__giVisTolModeAware` is on); `angularCoef` multiplies the cage-probe →
  // receiver DISTANCE, which is the term that carries the grazing
  // octahedral-direction quantization once the radial term stops over-paying for
  // it. Both are 1.75 / 0 at defaults, so this line and the loop below emit
  // exactly the nodes they emitted before the split.
  const { radialCoef: GATHER_VIS_RADIAL, angularCoef: GATHER_VIS_ANGULAR } =
    resolveVisTolTerms(activeRayHitMode, GATHER_VIS_TOLERANCE);
  const visTolerance = traceQuantization.mul(GATHER_VIS_RADIAL);
  // GEOMETRY SCALE vs PROBE SCALE — the distinction the leak turned on.
  //
  // "How far behind my surface's plane can a probe sit and still be on MY side
  // of the geometry?" is a question about how THICK the geometry is. It is not
  // a question about how coarse the probe lattice is. The plane cut below used
  // `minProbeCell`, so on a 40 m volume at `low` (probeAxis 20 → 2 m probes) it
  // kept full-strength probes up to **1.2 m below a floor** — and a probe below
  // the floor is looking straight at a sun that is under the floor. That is the
  // reported "floor glows when the light comes from below", and it arrives in
  // probe-cell-sized blocks ("flickers in large squares") because the rejection
  // state flips per probe octet. It scales with the probe lattice, which is
  // exactly why it is dramatically worse at the low preset.
  //
  // The same lesson is already written above for `visTolerance` — that one was
  // moved onto the field cell and these two were not.
  //
  // THE OCCUPANCY VOXEL IS THE RIGHT SCALE when there is one, finer still than
  // the field cell: it is literally "the thinnest geometry the transport can
  // resolve", which is exactly the question this cut asks. On the user's scene
  // that is 0.125–0.25 m against a 0.35 m field cell and a 1.25 m probe
  // spacing, so a probe under a floor is rejected roughly ten times sooner than
  // the original probe-scaled cut managed. It matters because the OTHER defence
  // — the distance-visibility proxy below — cannot see a floor thinner than its
  // own tolerance, so for thin geometry this cut is the only one that fires.
  //
  // Never LOOSER than the old behaviour: `min` keeps this a tightening.
  const geometryScale = traceQuantization.min(minProbeCell);

  const gatherFn = sharedFn({
    name,
    type: "vec3",
    inputs: [
      { name: "P", type: "vec3" },
      { name: "N", type: "vec3" },
      { name: "V", type: "vec3" },
    ],
    body: (P, N, V) => {
      // Uniform-derived values hoisted into locals BEFORE the 8-corner loop —
      // uniform-buffer loads inside loops multiply driver pipeline-compile
      // time (see giField's shadow-trace note).
      const minVec = vec3(world.min).toVar();
      const probeCellVec = vec3(cellX, cellY, cellZ).toVar();
      const minProbeCellV = float(minProbeCell).toVar();
      const geomScaleV = float(geometryScale).toVar();
      const visTolV = float(visTolerance).toVar();
      // Cage position, optionally biased along the normal and toward the
      // viewer (see gatherBias/gatherViewBias above). The cuts below
      // intentionally keep using the TRUE P/N.
      const cageOffset = N.mul(float(gatherBias)).add(V.mul(float(gatherViewBias)));
      const Pb = P.add(cageOffset.mul(minProbeCellV)).toVar();
      const fcX = Pb.x.sub(minVec.x).div(probeCellVec.x).sub(0.5);
      const fcY = Pb.y.sub(minVec.y).div(probeCellVec.y).sub(0.5);
      const fcZ = Pb.z.sub(minVec.z).div(probeCellVec.z).sub(0.5);
      const baseX = floor(fcX).toVar();
      const baseY = floor(fcY).toVar();
      const baseZ = floor(fcZ).toVar();
      const fracX = fcX.sub(baseX);
      const fracY = fcY.sub(baseY);
      const fracZ = fcZ.sub(baseZ);

      const acc = vec3(0).toVar();
      const cosAcc = float(0).toVar();

      Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
        const cf = corner.toFloat();
        const bx = cf.mod(2);
        const by = floor(cf.div(2)).mod(2);
        const bz = floor(cf.div(4));
        const px = baseX.add(bx).clamp(0, grid.x - 1);
        const py = baseY.add(by).clamp(0, grid.y - 1);
        const pz = baseZ.add(bz).clamp(0, grid.z - 1);
        const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px).toVar();
        // Same lattice math as c0.probePositionOf, but from the HOISTED
        // locals (cellN = sizeN/gridN identically) — keeps the loop body free
        // of uniform loads.
        const probePos = minVec.add(vec3(px, py, pz).add(0.5).mul(probeCellVec)).toVar();

        const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
        const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
        const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
        const weight = wx.mul(wy).mul(wz).toVar();

        // BURIED PROBES CONTRIBUTE NOTHING. A probe that lands INSIDE geometry
        // — and with a 1.25 m lattice against a 0.2 m floor slab, plenty do —
        // sees that geometry's own radiance in every direction at once, so it
        // reads uniformly bright and it sits right in the trilinear
        // neighbourhood of every surface receiver near it.
        //
        // Neither existing cut catches this, because both ask the SAME
        // question and it is a different one: the distance proxy and the plane
        // cut both test whether the probe is BEHIND geometry *relative to the
        // receiver*. Neither asks whether the probe is inside geometry at all.
        //
        // It is worst with a light UNDER the floor, which is how it was found:
        // the floor slab's underside cells are then the brightest thing in the
        // scene, the probes buried in that slab inherit it, and the floor above
        // — plus everything bouncing off it — glows. A level-0 occupancy bit at
        // the probe's own position is an exact answer to "is this probe inside
        // something". `__giNoBuriedProbeCut` is the A/B arm.
        //
        // WHERE IT IS EVALUATED: on the fast path, once per probe in
        // createProbeIrradiance, carried in `w` of a vec4 this loop already
        // fetches — so the cut costs one multiply per corner here instead of a
        // pyramid walk per corner per shaded pixel. Only the legacy path (no
        // precomputed irradiance) still asks the field directly.
        if (!probeIrradiance && occupancy?.occupiedAtWorld && !globalThis.__giNoBuriedProbeCut) {
          // Continuous burial ramp, matching createProbeIrradiance's fast
          // path (see the openness comment there — a moving object popped
          // as it swallowed each probe under the binary bit).
          if (occupancy.freeRadiusAtWorld && occupancy.voxel) {
            // GPU-side max — `voxel` is a uniform node, see the fast path.
            const vox = vec3(occupancy.voxel);
            const fadeR = vox.x.max(vox.y).max(vox.z);
            weight.mulAssign(
              mix(
                float(BURIED_PROBE_WEIGHT),
                float(1),
                smoothstep(float(0), fadeR, occupancy.freeRadiusAtWorld(probePos, 1)),
              ),
            );
          } else {
            weight.mulAssign(
              mix(float(1), float(BURIED_PROBE_WEIGHT), occupancy.occupiedAtWorld(probePos, 0)),
            );
          }
        }
        // Distance-visibility: the probe's own c0 direction toward P — via
        // the temporally-integrated depth moments when available (Chebyshev,
        // see createProbeDepthMoments), else the raw ray (legacy/hatch).
        const useChebyshev = depthMoments && !globalThis.__giNoChebyshev;
        const rel = P.sub(probePos).toVar();
        const dist = rel.length().toVar();
        // ANGULAR half of the tolerance (see the decomposition note above
        // BURIED_PROBE_WEIGHT): the proxy below reads the probe's ray toward the
        // NEAREST OF dirCount coarse directions, not toward P, so the error in
        // that ray's `w` grows with |P − probe| independently of the trace mode.
        // Identity when `angularCoef === 0` (the default) — no extra node.
        const visTolD = GATHER_VIS_ANGULAR !== 0
          ? visTolV.add(dist.mul(GATHER_VIS_ANGULAR)).toVar()
          : visTolV;
        If(dist.greaterThan(1e-4), () => {
          const towardP = octahedralTexelIndex(rel.div(dist), dirRes);
          const probeRay = useChebyshev
            ? null
            : c0.rays.element(probeIdx.mul(dirCount).add(towardP).toInt());
          // Soft rejection: fade the probe out over [tol, 2·tol] of blocker
          // penetration instead of a binary cut — the hard zero produced
          // visible blotch/scallop boundaries where the rejection state
          // flipped between neighboring receivers.
          // SHORT-RANGE probes are exempt: at grazing incidence along a flat
          // surface (ceiling/wall/floor receivers), a nearby probe's own ray
          // toward the receiver clips the surface itself and the proxy
          // rejected valid probes in per-probe scallops — the dotted/quilted
          // lattice pattern all over flat surfaces. Within ~2 probe cells the
          // metric+angular plane cuts below already handle every
          // wrong-side/through-wall case; the proxy's real value is DISTANT
          // occluders (a probe across the room behind a column).
          // The short-range exemption is for COPLANAR probes only (the
          // scallop source). A short-range probe BEHIND the receiver's plane
          // (just below a thin ceiling, viewed from outside) must keep the
          // proxy: its ray toward the receiver hits the ceiling → rejected —
          // without this, tight ultra probe spacing leaked a bright bump
          // onto the ceiling top straight above the lamp.
          const behindPlane = rel.dot(N).greaterThan(0.02);
          // A/B escape hatches, dev/harness only (scripts/run-gi-rc-lattice.mjs).
          if (!globalThis.__giNoVisProxy) {
            if (useChebyshev) {
              // CHEBYSHEV VISIBILITY over the integrated (μ, μ²) — the
              // object-motion flicker fix at the weights (Phase 2). The
              // spatial envelope deliberately tracks the old proxy's: the
              // tolerance is a DEAD ZONE subtracted from the penetration
              // first (a probe ray on a surface legitimately records its hit
              // up to ~a voxel early — see visTolerance), and the variance
              // floor of (visTol/2)² makes a converged static scene fall off
              // over the old [tol, 2tol] band. Work the arithmetic at the
              // floor (σ² = 0.25·tol²): penetration tol → vis 1.0 (old 1.0),
              // 1.5·tol → 0.474 (old 0.5), 2·tol → 0.158 (old 0). That is the
              // old envelope, with a small tail the DDGI 0.05 trim above
              // already clips.
              //
              // NO CUBE HERE. `vis³` was tried (2026-08-03) to force the
              // 2·tol endpoint to ~0, and it DID — by crushing the whole
              // band with it: ×0.106 instead of ×0.5 at 1.5·tol, ~5× the
              // rejection everywhere the test is partially engaged. The
              // gather renormalizes by surviving weight, so in dense
              // geometry (columns, curtains) whole receivers lost every cage
              // probe and read 0 — the user's Sponza went from ambient-lit
              // to a black hall outside the sunbeam. Optimize the ENVELOPE,
              // not the endpoint.
              //
              // What changes vs the raw proxy is the TEMPORAL
              // behaviour: a churning mover raises σ² for exactly the
              // directions it churns, softening the cut there instead of
              // flipping it per frame. Gates: μ near the c0 interval end =
              // a mostly-miss direction = no occluder in reach (the smooth
              // version of the old `ray.w >= 0` hit gate); the short-range
              // coplanar exemption is unchanged.
              const m = depthMoments.element(probeIdx.mul(dirCount).add(towardP).toInt()).toVar();
              const mu = m.x;
              const nearGate = float(c0.intervalLen).mul(0.95);
              If(
                mu.lessThan(nearGate)
                  .and(dist.greaterThan(minProbeCellV.mul(2)).or(behindPlane)),
                () => {
                  const halfTol = visTolD.mul(0.5);
                  const sigma2 = m.y.sub(mu.mul(mu)).max(halfTol.mul(halfTol)).toVar();
                  const gap = dist.sub(mu).sub(visTolD).max(0).toVar();
                  const cheb = sigma2.div(sigma2.add(gap.mul(gap)));
                  // DDGI light-leak trim (cut the tail, sharpen with a cube).
                  const vis = cheb.sub(0.05).div(0.95).clamp(0, 1).toVar();
                  weight.mulAssign(vis);
                },
              );
            } else {
              If(
                probeRay.w
                  .greaterThanEqual(0)
                  .and(dist.greaterThan(minProbeCellV.mul(2)).or(behindPlane)),
                () => {
                  const penetration = dist.sub(probeRay.w);
                  weight.mulAssign(smoothstep(visTolD, visTolD.mul(2), penetration).oneMinus());
                },
              );
            }
          }
          // BACKFACE rejection, METRIC not angular: a probe on the far side
          // of a thin wall/slab/ceiling carries the other side's light, and
          // the distance proxy above can't tell (its tolerance must absorb a
          // cell of quantization — more than the wall is thick). The old
          // angular fade smoothstep(-0.5, 0, dot(dirToProbe, N)) still gave
          // a probe 0.2m BEHIND a 0.12m slab ~40% weight → rooms lit through
          // partitions, and outside faces (ceiling tops, wall backs) showed
          // the trilinear-tent × rejection lattice as a dark-diamond
          // checkerboard. Cut by DISTANCE BEHIND THE RECEIVER'S PLANE
          // instead, scaled to the probe cell: probes more than ~0.6 cells
          // behind the surface are through-geometry for any thin occluder,
          // while coplanar probes (flat floors/walls) sit at planeDist ≈ 0
          // and keep full weight.
          // Both cuts multiply: the metric one alone let OBLIQUE far probes
          // through at coarse probe spacing (bright bump on the ceiling top
          // straight above the lamp at "low"), the angular one alone leaked
          // near-plane probes through thin slabs. Together: straight-behind
          // probes die by angle, near-behind by plane distance, coplanar
          // valid probes keep full weight from both.
          const planeDist = rel.negate().dot(N);
          if (!globalThis.__giNoPlaneCut) {
            // Scaled by the GEOMETRY scale, not the probe lattice — see
            // `geometryScale`. `__giPlaneCutProbeScale` restores the old
            // probe-scaled cut (the A/B arm: if the floor stops glowing but
            // tight interiors gain dark patches, this is the knob).
            const cut = globalThis.__giPlaneCutProbeScale ? minProbeCellV : geomScaleV;
            weight.mulAssign(smoothstep(cut.mul(-0.6), cut.mul(-0.05), planeDist));
          }
          if (!globalThis.__giNoAngleCut) {
            weight.mulAssign(smoothstep(-0.45, 0.0, rel.negate().div(dist).dot(N)));
          }
        });

        if (probeIrradiance) {
          // FAST PATH: precomputed ambient-cube irradiance (see
          // createProbeIrradiance — the same π·Σ(L·cos)/Σcos integral,
          // hoisted per probe per frame). Basis blend by N² is the standard
          // HL2 ambient-cube evaluation.
          const base6 = probeIdx.mul(6).toVar();
          // Full vec4 for the x axis: .w is this probe's OPENNESS (the
          // buried-probe cut, precomputed per probe — see createProbeIrradiance).
          const ex = probeIrradiance
            .element(base6.add(select(N.x.greaterThanEqual(0), float(0), float(1))).toInt()).toVar();
          const ey = probeIrradiance
            .element(base6.add(2).add(select(N.y.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const ez = probeIrradiance
            .element(base6.add(4).add(select(N.z.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const nn = N.mul(N);
          const probeE = ex.xyz.mul(nn.x).add(ey.mul(nn.y)).add(ez.mul(nn.z));
          const probeW = weight.mul(ex.w).toVar();
          acc.addAssign(probeE.mul(probeW));
          cosAcc.addAssign(probeW);
        } else {
          // Cosine-weighted radiance sum + cosine total for this probe.
          const probeE = vec3(0).toVar();
          const probeCos = float(0).toVar();
          const rowBase = probeIdx.mul(dirCount).toVar();
          Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
            const dir = c0.directionOf(d.toFloat());
            const cosTheta = max(dir.dot(N), 0);
            probeE.addAssign(c0.merged.element(rowBase.add(d).toInt()).xyz.mul(cosTheta));
            probeCos.addAssign(cosTheta);
          });
          acc.addAssign(probeE.mul(weight));
          cosAcc.addAssign(probeCos.mul(weight));
        }
      });

      // OUTSIDE-VOLUME FADE. Probe coordinates clamp at the lattice edge, so
      // a receiver beyond the volume read the BOUNDARY probes' values smeared
      // to infinity — a large floor plane extending past the volume showed
      // the boundary cells as giant streaks/stripes across everything outside
      // it (the "GI goes in weird stripes" report). Fade the gather out over
      // ~1.25 probe cells past the box instead: an honest "the field ends
      // here". Analytic emitter/light terms are volume-independent and keep
      // lighting those receivers.
      const sizeVec = probeCellVec.mul(vec3(grid.x, grid.y, grid.z));
      const rel0 = P.sub(minVec);
      const outsideVec = rel0.negate().max(rel0.sub(sizeVec)).max(vec3(0));
      const fadeDist = probeCellVec.x.max(probeCellVec.y).max(probeCellVec.z).mul(1.25);
      const edgeFade = smoothstep(float(0), fadeDist, outsideVec.length()).oneMinus();

      // Fast path: acc already carries per-probe irradiance E — normalize by
      // the probe weights. Legacy path: E = π · (Σ L·cos / Σ cos), the
      // cosine-weighted AVERAGE radiance times π — exact for uniform L at any
      // direction count and bounded E ≤ π·max(L), so the feedback loop's gain
      // stays ≤ albedo < 1 (always convergent). All-probes-rejected → 0.
      if (probeIrradiance) {
        return acc.div(max(cosAcc, 1e-3)).mul(edgeFade);
      }
      return acc.div(max(cosAcc, 1e-3)).mul(Math.PI).mul(edgeFade);
    },
  });
  // V (unit toward-camera) is optional — omitted = vec3(0) = no view bias,
  // for callers with no meaningful viewer (field cells, reflection hits).
  return (P, N, V = null) => gatherFn(vec3(P), vec3(N), V ? vec3(V) : vec3(0, 0, 0));
}

/**
 * Directional radiance lookup for GLOSSY REFLECTIONS: samples the merged
 * field of one cascade along a single direction (the reflection vector),
 * trilinear over 8 probes. Cascade level trades angular sharpness against
 * spatial accuracy (higher level = finer direction bins, sparser probes) —
 * level 2 gives ~11° bins at c0DirRes 4, a soft glossy look. Mirror-sharp
 * reflections are SSR's job (engine module); this is the everything-else
 * fallback the reference demo hard-codes analytically.
 */
export function createRadianceLookup(cascades, level = 2) {
  const c = cascades[Math.min(level, cascades.length - 1)];
  const { world, grid, dirRes, dirCount } = c;
  const cellX = world.size.x.div(grid.x);
  const cellY = world.size.y.div(grid.y);
  const cellZ = world.size.z.div(grid.z);

  return Fn(([P, R]) => {
    const fcX = P.x.sub(world.min.x).div(cellX).sub(0.5);
    const fcY = P.y.sub(world.min.y).div(cellY).sub(0.5);
    const fcZ = P.z.sub(world.min.z).div(cellZ).sub(0.5);
    const baseX = floor(fcX).toVar();
    const baseY = floor(fcY).toVar();
    const baseZ = floor(fcZ).toVar();
    const fracX = fcX.sub(baseX);
    const fracY = fcY.sub(baseY);
    const fracZ = fcZ.sub(baseZ);

    // Bilinear across DIRECTION texels as well as probes: nearest-texel
    // sampling showed the octahedral bins as hard triangular facets on
    // glossy surfaces. (Fold seams are clamped, not wrapped — residual seam
    // error is far below the facets this removes.)
    const octa = octahedralUV(R, dirRes);
    const du = octa.u.sub(0.5);
    const dv = octa.v.sub(0.5);
    const du0 = floor(du).clamp(0, dirRes - 1).toVar();
    const dv0 = floor(dv).clamp(0, dirRes - 1).toVar();
    const du1 = du0.add(1).clamp(0, dirRes - 1).toVar();
    const dv1 = dv0.add(1).clamp(0, dirRes - 1).toVar();
    const fu = du.sub(floor(du)).clamp(0, 1);
    const fv = dv.sub(floor(dv)).clamp(0, 1);

    const acc = vec3(0).toVar();
    Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
      const cf = corner.toFloat();
      const bx = cf.mod(2);
      const by = floor(cf.div(2)).mod(2);
      const bz = floor(cf.div(4));
      const px = baseX.add(bx).clamp(0, grid.x - 1);
      const py = baseY.add(by).clamp(0, grid.y - 1);
      const pz = baseZ.add(bz).clamp(0, grid.z - 1);
      const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px);
      const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
      const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
      const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
      const weight = wx.mul(wy).mul(wz);
      const rowBase = probeIdx.mul(dirCount);
      const s00 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du0).toInt()).xyz;
      const s10 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du1).toInt()).xyz;
      const s01 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du0).toInt()).xyz;
      const s11 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du1).toInt()).xyz;
      const filtered = s00
        .mul(fu.oneMinus().mul(fv.oneMinus()))
        .add(s10.mul(fu.mul(fv.oneMinus())))
        .add(s01.mul(fu.oneMinus().mul(fv)))
        .add(s11.mul(fu.mul(fv)));
      acc.addAssign(filtered.mul(weight));
    });
    // Same outside-volume fade as the gather (see createIrradianceGather):
    // glossy surfaces beyond the volume otherwise streak the clamped
    // boundary probes' radiance across their whole extent.
    const cellVec = vec3(cellX, cellY, cellZ);
    const sizeVec = cellVec.mul(vec3(grid.x, grid.y, grid.z));
    const rel0 = P.sub(vec3(world.min));
    const outsideVec = rel0.negate().max(rel0.sub(sizeVec)).max(vec3(0));
    const fadeDist = cellVec.x.max(cellVec.y).max(cellVec.z).mul(1.25);
    const edgeFade = smoothstep(float(0), fadeDist, outsideVec.length()).oneMinus();
    return acc.mul(edgeFade);
  });
}

/**
 * Multi-bounce feedback (plan §3.4): per occupied voxel, gather the merged
 * c0 irradiance at the cell and write `base + albedo · E/π · gain` into the
 * LIVE radiance buffer the cascade trace reads. This is the pass that makes
 * an emissive-only Cornell box bleed: without it, surfaces lit purely by GI
 * have black voxels and reflect nothing (bounce 2+ never enters the field).
 *
 * It is a feedback loop across frames (reads last frame's merged field),
 * but it carries only the secondary energy — gain is fixed and < the
 * scene's albedo ceiling, so it converges geometrically in a few frames
 * with no hysteresis or lag heuristics. Junction cells (low normal
 * reliability, stored in surface.w) get no feedback — their normal is
 * garbage — mirroring the direct-bake gate.
 *
 * Dispatch this FIRST in the per-frame queue (before traces/merges).
 */
export function createBounceFeedback(cascades, volume, gainUniform, blendUniform, options = {}) {
  const world = volume.world;
  // Private to the feedback compute — safe to emit as a WGSL function.
  const gather = createIrradianceGather(
    cascades, options.probeIrradiance ?? null, world.cellMax, "giFeedbackGather",
    volume.occupancyField ?? null,
    options.depthMoments ?? null,
    // RESOLVED ray-hit mode (`rayHitConfig.activeMode`), for the radial half of
    // the visibility tolerance. The feedback gather must agree with the resolve
    // gather about visibility or the bounce it feeds back is not the light the
    // screen shows.
    options.rayHitMode ?? null,
  );
  const { res } = volume;
  const cellCount = res.x * res.y * res.z;
  const normalLift = world.minCell.mul(1.2);
  // Per-frame analytic direct light (the Shadertoy reference's behavior:
  // sunlight is evaluated at every hit every frame, never baked — a moving
  // light updates the whole field the same frame, smoothly). Slots are
  // uniforms: light moves/edits cost ZERO rebakes.
  const lightSlots = options.lightSlots ?? null;
  // Promoted emissive meshes (analytic sphere area lights) — stripped from
  // the baked field, injected here per frame instead.
  const emitterSlots = options.emitterSlots ?? null;
  const shadowTrace = options.shadowTrace ?? null;
  // COVERAGE-WEIGHTED INJECTION (GI_MOTION_PERF_PLAN §5.1): a closure
  // returning the fraction [~1/K, 1] of a field cell the level-0 occupancy
  // actually covers (1 when the oracle cannot see the occupancy source).
  // Applied ONCE to the cell's whole outgoing radiance below — emissive base,
  // analytic direct, emitter direct and bounce all scale together, because
  // the physical quantity being represented is per-cell SURFACE AREA and
  // area is the frame-to-frame invariant of a rigid mover. Binary injection
  // (coverageAt = null) is the historical behavior.
  const coverageAt = options.coverageAt ?? null;
  // RECORD-TRUE INJECTION NORMALS (plan §5.2): closure returning
  // vec4(worldNormal, flag) — the fitted-plane record normal of the occupied
  // voxel nearest the cell center, flag 0 when no simple record exists (the
  // gradient below stays the fallback). See GISystem's option note.
  const recordNormalAt = options.recordNormalAt ?? null;
  // True when the field's lightShadow closure band-limits its penumbra
  // (GISystem's penWidth) — see the analytic block's softAngle note.
  const bandLimited = options.fieldPenWidthOn === true;
  // ANALYTIC-LIGHT shadows may use a different tracer than emitter shadows.
  // GISystem passes the hierarchical occupancy DDA here: the sphere march over
  // the trilinear field TUNNELS through thin slabs at coarse presets — the
  // interpolated distance is not a true lower bound, so a step can leap a
  // 0.2 m floor and land in the open air beneath it, which was the
  // "sun below the floor leaks on every preset except ultra" report. The DDA
  // walks every voxel it crosses, so it cannot tunnel at any preset. Its
  // verdict is binary; the probe EMA (probeSmoothing) owns the smoothness.
  // Emitters stay on `shadowTrace` — they need the lamp-body exclusion and
  // their soft penumbrae, and they are not the leak path.
  const lightShadow = options.lightShadow ?? shadowTrace;
  // EMITTER shadows in the FIELD get their own, SHORTER march (GISystem's
  // traceBudget.feedbackEmitter). Measured 2026-08-07 with four moving
  // emissive spheres (scripts/run-gi-emissive-cost.mjs): this pass costs
  // 0.73ms PER EMITTER at a 128x32x128 volume, dead linear in emitter count
  // (0 / 0.84 / 1.67 / 2.92ms at 0/1/2/4), and it is the single biggest term
  // in "each emissive object is -15-20 fps" — the queue's other passes
  // together grew 0.15ms per emitter. The cost is structural: every occupied
  // cell marches a fresh soft shadow ray to every live emitter, every frame.
  //
  // The march can be shorter HERE and only here, because this term seeds
  // BOUNCE. What the field injects is gathered by the cascades, blurred
  // across a probe neighbourhood and EMA-blended — a sharper occlusion
  // estimate cannot survive that chain. The shadow the user actually sees on
  // a visible surface comes from the screen-side emitter pass, which keeps
  // its full record-march + analytic width (GISystem #buildEmitterRecordTrace)
  // and is a different, per-pixel budget entirely. Falls back to `shadowTrace`
  // so a caller that does not split the budgets behaves exactly as before.
  const emitterShadow = options.emitterShadowTrace ?? shadowTrace;
  // LIVE look control (uniform, 1 = physical): desaturates the FIELD-SIDE
  // albedo — the color bounced light carries — toward its own luminance.
  // Energy is preserved, only chroma drops, so dialling it down turns
  // oversaturated color bleed into neutral fill without dimming the room.
  // Receiver-side tint (the pixel's own texture in the screen resolve) is
  // deliberately untouched — surfaces keep their color; their REFLECTION is
  // what desaturates. Blender-parity calibration knob (2026-08-04).
  const bleedSaturation = options.bleedSaturation ?? null;
  const gridDiagonal = options.gridDiagonal ?? 1e4;
  // Low/medium cost halving, restructured (see GISystem's feedback-rate note):
  // when set (a 0/1 uniform flipping per frame), each dispatch updates only the
  // cells whose index parity matches — half the work per frame, every frame,
  // instead of all of it every other frame. Skipped cells keep last frame's
  // radiance (their buffers simply aren't rewritten), and adjacent cells are on
  // opposite parities, so the trilinear/probe averaging downstream always sees
  // a half-fresh neighbourhood — the field as a whole moves EVERY frame. The
  // old whole-pass skip stair-stepped the entire field at half the light's
  // rate, which read as flicker on exactly the presets meant to be cheap.
  const checkerParity = options.checkerParity ?? null;
  // RUNTIME uniform (0 or 1): 1 blends every field shadow to fully open.
  // A `globalThis` ternary was tried here first and it silently tested
  // NOTHING: this function body runs at shader BUILD time, so a flag set in
  // the console after load never reached the compiled pipeline. GISystem owns
  // the uniform and copies `__giNoFieldShadows` into it every tick.
  const fieldShadowOff = options.fieldShadowOff ?? null;
  // STOCHASTIC AREA-LIGHT VISIBILITY — the residual-flicker fix (2026-08-03).
  // The DDA/trace verdict per cell is deterministic per frame, so a sweeping
  // sun makes each cell's visibility a SQUARE WAVE (it flips at one exact
  // angle) and the probe EMA can only stretch that flip into a slow, very
  // visible fade — "smoothed but still there", the user's exact report.
  // Jittering ONLY the shadow-ray direction over the light's angular disc
  // (R2 sequence per cell per frame) makes the EMA integrate a true
  // fractional disc visibility: a real penumbra whose value moves
  // CONTINUOUSLY with the light, so there is no step left to smooth. The
  // energy/cos/gate terms stay on the UNJITTERED direction — irradiance from
  // a small disc is ~its center value, and stable `If` gates must not churn.
  // `jitter.angle` is a LIVE uniform (radians; 0 disables — the A/B hatch).
  const jitter = options.jitter ?? null;
  // FIELD-SIDE TEMPORAL EMA (GI_FLICKER_PLAN.md Phase 1) — the freeze
  // bisect's majority arm: the field had NO integrator of its own, so every
  // binary flip born in THIS pass (a shadow ray grazing a voxel edge, the
  // DDA's oracle re-picking samples as a mover re-voxelizes) stepped the
  // whole downstream pipeline in one frame; the probe EMA downstream is the
  // only accumulator and cannot absorb field-scale churn without lagging
  // light response badly (probeSmoothing low = flicker, high = slow — the
  // user's exact complaint). Blending AT THE SOURCE turns that flip into an
  // integrable signal. `fieldSmoothing` is the RETAIN weight (0 = off, this
  // frame's value outright — the pre-Phase-1 behaviour byte-for-byte; 1 =
  // frozen). GISystem defaults its uniform to 0.95 (user-confirmed live,
  // 2026-08-03) via `__giFieldSmoothing`.
  const fieldSmoothing = options.fieldSmoothing ?? null;
  // SWEPT-BOUNDS TEMPORAL INVALIDATION (docs/dynamic_gi_exact_dynamic_objects.md):
  // a closure returning a history factor [~0.35, 1] at a cell center — reduced
  // inside any exact-dynamic object's swept region (prev ∪ curr world bounds,
  // expanded) while it moves. Cells whose lighting the mover just changed drop
  // their EMA history so shadows/bounce track the object instead of ghosting;
  // everything outside keeps full history. Null = off (no dynamic objects, or
  // `__giNoSweptInvalidation`).
  const sweptInvalidationAt = options.sweptInvalidationAt ?? null;

  return Fn(() => {
    // Temporal ingest of streamed bakes: staging holds the latest CPU bake
    // (worker cadence, 10-15Hz); base lerps toward it every frame so bake
    // swaps spread over ~100ms instead of popping — this is the moving-
    // object flicker fix. Occupancy SNAPS (geometry presence is binary) and
    // radiance snaps with it on occupancy change, otherwise a mover's
    // leading edge would blend up from black and dim.
    const staging = volume.stagingBuffer.element(instanceIndex).toVar();
    const prev = volume.baseBuffer.element(instanceIndex).toVar();
    // Read BEFORE this frame's write (same thread, same cell — no race):
    // last frame's radiance/indirect, for the EMA below. `prev.w` (the
    // BASE buffer's occupancy flag, read a line above) doubles as "was this
    // cell occupied last frame" — the same signal the base-ingest hysteresis
    // above already keys on.
    const prevRadiance = fieldSmoothing ? volume.radianceBuffer.element(instanceIndex).toVar() : null;
    const prevIndirect =
      fieldSmoothing && volume.indirectBuffer ? volume.indirectBuffer.element(instanceIndex).toVar() : null;
    const wasEmpty = prev.w.lessThan(0.5);
    const alpha = float(1).toVar();
    If(staging.w.sub(prev.w).abs().lessThan(0.5), () => {
      alpha.assign(blendUniform);
    });
    const base = vec4(mix(prev.xyz, staging.xyz, alpha), staging.w).toVar();
    volume.baseBuffer.element(instanceIndex).assign(base);
    If(base.w.lessThan(0.5), () => {
      // Cells that just became empty must clear the live field too — the
      // CPU no longer writes radianceBuffer directly.
      volume.radianceBuffer.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      if (volume.indirectBuffer) {
        volume.indirectBuffer.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      }
      Return();
    });
    // Checker skip AFTER the ingest and the empty-clear (both stay full-rate:
    // ingest is cheap and geometry disappearance must clear the same frame),
    // BEFORE everything expensive. A skipped cell's radiance/indirect buffers
    // are left untouched — that is the whole mechanism.
    if (checkerParity) {
      // parity < 0 = checker OFF (every cell every frame) — GISystem writes
      // the sentinel per tick, which is what makes this A/B-able live.
      //
      // PARITY IS PER ROW, NOT PER CELL, and that is the whole difference
      // between a 25% saving and a 50% one. `instanceIndex % 2` alternates
      // individual LANES, and a GPU wave costs the max over its active lanes
      // — so a half-idle wave still takes a full wave's time and only the
      // memory traffic drops (measured: halving the cells bought 0.4ms of a
      // 1.7ms pass). Cell index is x-major, so `floor(idx / res.x)` is
      // constant along the whole x row: a wave's 32 consecutive threads share
      // one decision and an idle wave exits outright. Spatially this
      // alternates ROWS in (y, z) instead of cells in x — every cell still
      // has fresh neighbours on two axes, which is all the downstream
      // trilinear/probe averaging asks for.
      const rowParity = floor(instanceIndex.toFloat().div(res.x)).mod(2);
      If(
        float(checkerParity).greaterThanEqual(0).and(
          rowParity.sub(checkerParity).abs().greaterThan(0.5),
        ),
        () => {
          Return();
        },
      );
    }
    const surface = volume.surfaceBuffer.element(instanceIndex).toVar();
    // Hoisted local (see the uniform-loads-in-loops notes elsewhere).
    const normalLiftV = float(normalLift).toVar();
    const out = vec4(base.xyz, 1).toVar();
    // Indirect-only accumulator (emissive base + bounce, NO analytic/emitter
    // direct) — reflection hits sample this and re-evaluate direct light per
    // pixel at the exact hit, which is what keeps mirror images crisp
    // instead of cell-blurred. Kept in lockstep with `out` below.
    const indirect = vec3(base.xyz).toVar();
    // Reliability gate matches the CPU direct bake's 0.35 threshold.
    If(surface.w.greaterThan(0.35), () => {
      const idx = instanceIndex.toFloat();
      const ix = mod(idx, res.x);
      const iy = mod(floor(idx.div(res.x)), res.y);
      const iz = floor(idx.div(res.x * res.y));
      // The composite already mirrors this normal into distanceTexture.gba.
      // Sampling that existing texture removes normalBuffer from this fully
      // composed feedback graph, keeping it within the portable 8-storage-
      // buffer limit (and preserving the same normal, fp16-quantized).
      const gradNormal = texture3D(
        volume.distanceTexture,
        vec3(ix.add(0.5).div(res.x), iy.add(0.5).div(res.y), iz.add(0.5).div(res.z)),
      ).level(0).gba.mul(2).sub(1).normalize();
      // RECORD-TRUE NORMAL (plan §5.2) where a simple record exists,
      // SIGN-ALIGNED to the gradient: the gradient is per-shell-side (thin
      // geometry gets a shell layer per side — the one-sided-lighting fix),
      // so it stays the authority on WHICH side this cell is; the record
      // supplies the unquantized orientation within that hemisphere. A
      // record perpendicular to the gradient (degenerate alignment) keeps
      // the gradient outright.
      let normal = gradNormal;
      const cellCenterEarly = recordNormalAt
        ? vec3(
            ix.add(0.5).mul(world.cell.x).add(world.min.x),
            iy.add(0.5).mul(world.cell.y).add(world.min.y),
            iz.add(0.5).mul(world.cell.z).add(world.min.z),
          ).toVar()
        : null;
      if (recordNormalAt) {
        const rec = vec4(recordNormalAt(cellCenterEarly)).toVar();
        const side = rec.xyz.dot(gradNormal).toVar();
        const aligned = rec.xyz.mul(select(side.lessThan(0), float(-1), float(1)));
        normal = select(
          rec.w.greaterThan(0.5).and(side.abs().greaterThan(0.1)),
          aligned,
          gradNormal,
        ).toVar();
      }
      // One desaturated field albedo for ALL bounce-color sites below (the
      // two direct injections and the feedback term) — see bleedSaturation's
      // note above. Null uniform → plain surface albedo, byte-identical.
      const fieldAlbedo = bleedSaturation
        ? mix(
            vec3(surface.xyz.dot(vec3(0.2126, 0.7152, 0.0722))),
            surface.xyz,
            float(bleedSaturation),
          ).toVar()
        : surface.xyz;
      const cellCenter = vec3(
        ix.add(0.5).mul(world.cell.x).add(world.min.x),
        iy.add(0.5).mul(world.cell.y).add(world.min.y),
        iz.add(0.5).mul(world.cell.z).add(world.min.z),
      );
      // Per-cell R2 low-discrepancy channels, advanced per frame (see the
      // `jitter` note above): under the probe EMA (~50 frames) these
      // integrate to the disc average with far less residual variance than
      // white noise would leave.
      const jitterU1 = jitter
        ? fract(fract(sin(idx.mul(12.9898)).mul(43758.5453)).add(jitter.frame.mul(0.7548776662))).toVar()
        : null;
      const jitterU2 = jitter
        ? fract(fract(sin(idx.mul(78.233)).mul(24634.6345)).add(jitter.frame.mul(0.5698402909))).toVar()
        : null;
      // Perturbs `dir` inside a cone of half-angle `angle` (radians; small-
      // angle disc offset in the tangent plane). Exactly `dir` at angle 0,
      // which is what makes the angle uniform a live kill switch.
      const jitterDir = (dir, angle) => {
        const r = sqrt(jitterU1).mul(angle).toVar();
        const phi = jitterU2.mul(Math.PI * 2).toVar();
        const up = select(dir.y.abs().greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
        const t1 = dir.cross(up).normalize().toVar();
        const t2 = dir.cross(t1).toVar();
        return dir.add(t1.mul(r.mul(cos(phi)))).add(t2.mul(r.mul(sin(phi)))).normalize();
      };

      // Analytic direct light, evaluated fresh EVERY FRAME from uniform
      // slots (never baked): |ndotl| both-sides like the CPU bake, SDF-
      // traced occlusion (smooth as the light moves — no voxel popping),
      // Lambert /π. The CPU bake now carries emissive only.
      if (lightSlots?.length && shadowTrace) {
        const rawAlbedo = fieldAlbedo;
        for (const slot of lightSlots) {
          If(slot.active.greaterThan(0.5), () => {
            const isDir = float(slot.kind).toVar();
            const rel = vec3(slot.vector).sub(cellCenter).toVar();
            const pointDist = rel.length().max(1e-4).toVar();
            // vector holds: point → world position, directional → the
            // normalized direction TOWARD the light.
            const dir = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
            const dist = mix(pointDist, float(gridDiagonal), isDir).toVar();
            let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
            // Match three's own PointLight `distance` cutoff (0 = infinite):
            // without this, a range-limited light kept feeding the GI field
            // past where the renderer's direct light dies.
            if (slot.range) {
              const range = float(slot.range);
              const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
              const r2 = ratio.mul(ratio);
              const win = r2.mul(r2).oneMinus().clamp(0, 1);
              atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
            }
            // ONE-SIDED: the composite gives thin geometry a shell layer per
            // side, each with its own gradient normal — so a cell only takes
            // light from its own hemisphere. The old |ndotl| both-sides rule
            // (a triangle-normal-blindness workaround) lit the OUTSIDE shell
            // of walls from lights INSIDE the room = light through walls.
            const ndotl = dir.dot(normal).max(0).toVar();
            // Dim-cell cutoff, SMOOTH: cells below the trace-worthy band
            // neither march a shadow ray nor contribute (unshadowed dim
            // adds leak through walls and get amplified by the bounce
            // loop), but the contribution FADES over [0.002, 0.006] instead
            // of vanishing at a hard threshold — the old binary skip carved
            // a visible hard-edged ring into floors/walls at the exact
            // iso-luminance surface (the "light gets cut in a circle that
            // grows as the lamp nears the floor" report).
            const energy = vec3(slot.color).mul(atten.mul(ndotl)).toVar();
            const lum = energy.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
            If(ndotl.greaterThan(1e-4).and(lum.greaterThan(0.002)), () => {
              const origin = cellCenter.add(normal.mul(normalLiftV));
              const maxT = dist.sub(normalLiftV).max(0);
              // A/B HATCH FOR THE FLICKER (`__giNoFieldShadows`, live uniform).
              // This trace is the only light-direction-dependent term in the
              // field that can jump discontinuously once `bounce` is 0:
              // `min(k·d/t)` over an ADAPTIVE-step march of a VOXEL-QUANTIZED
              // distance oracle re-picks its sample set when the ray direction
              // moves, so a smooth light rotation gives a non-smooth penumbra.
              // Its step budget is 18 at `low` and 32 at `high`, which is why
              // the artifact would track the quality preset. Toggling on makes
              // the field unshadowed — leaks are expected; the only question is
              // whether the FLICKER stops.
              // Trace direction only — energy/gates stay on the exact dir.
              const traceDir = jitter ? jitterDir(dir, jitter.angle) : dir;
              // PER-LIGHT PENUMBRA (GI-traced direct shadows). `slot.soft` is
              // this light's own angular RADIUS in radians — nonzero only for a
              // light flagged `shadowMode: "gi"`, whose screen-space shadow
              // cone is shaped by the same number (see giScreen's lightShadow
              // block). Sharing it here is what keeps the field's bounce and
              // the direct shadow agreeing about how big the sun is; an
              // unflagged slot reads 0 and falls back to the global sun angle
              // exactly as before. k = 1/angle throughout this module (see
              // GISystem's penumbraK and giLight's emitter k), and both shadow
              // paths take it as their 4th argument — the DDA closure now
              // honours it, and the legacy sphere trace already did. (That
              // legacy arm — `__giFieldDdaShadows = false`, or a build with no
              // occupancy pyramid — used to receive a hardcoded k of 20, which
              // predates `penAngle` existing; it now reads the same uniform the
              // DDA path does, so the two A/B arms finally agree on the sun's
              // size instead of differing by 2x.)
              const fallbackAngle = jitter?.penAngle ? float(jitter.penAngle).max(0.005) : float(0.025);
              // UPPER CLAMP 0.35 rad, same ceiling the screen path puts on its
              // analytic k: this estimator reports min(k·clearance/t), and at
              // a Blender-style 90° authored angle (0.785 rad half-angle) an
              // unclamped k ≈ 1.27 reads EVERYTHING near geometry as shadowed
              // — the sun barely enters the field, the bounce collapses, and
              // the whole shadow side of the scene goes black (user
              // screenshot, 2026-08-05). The field's sun feed wants "roughly
              // right" energy, not the screen channel's exact penumbra shape.
              // (The 2026-08-06 razor-sun anti-popping fix lives in the
              // MARCHERS now — the field trace passes a `penWidth` band
              // r(t) = max(t/k, halfCell), see GISystem's lightShadow
              // closure. An angle floor here was tried first and REVERTED:
              // fattening the cone dims every long constricted path — a
              // vertical sun through Sponza's roof slit lost ~99% of its
              // injected energy, GI collapsed scene-wide.)
              // UNDER THE BAND (`bandLimited`), an authored razor sun stays
              // razor: slot.soft = 0 maps to ~5e-4 (k≈2000, cone thinner
              // than the band everywhere that matters) instead of the 1.4°
              // fallback — the fallback's cone at aperture distance was
              // exactly the over-dimming the band exists to prevent. The
              // legacy (band-off) arm keeps the historical substitution.
              const softAngle = slot.soft
                ? (bandLimited
                    ? float(slot.soft).clamp(5e-4, 0.35)
                    : select(float(slot.soft).greaterThan(1e-4), float(slot.soft).clamp(5e-4, 0.35), fallbackAngle))
                : fallbackAngle;
              let shadow = lightShadow(origin, traceDir, maxT, float(1).div(softAngle), ndotl);
              if (fieldShadowOff) shadow = mix(shadow, float(1), fieldShadowOff);
              const direct = rawAlbedo
                .mul(energy)
                .mul(shadow)
                .mul(smoothstep(0.002, 0.006, lum))
                .mul(1 / Math.PI);
              out.assign(vec4(out.xyz.add(direct), out.w));
            });
          });
        }
      }

      // Promoted emitters: analytic area direct — sphere slots use the
      // horizon-aware sphere factor, box slots the exact per-face form
      // factor — SDF-shadowed with k from the emitter's angular size (the
      // SAME emitterSlotFactor the receiver-side material term uses, so the
      // two stay in agreement).
      if (emitterSlots?.length && emitterShadow) {
        const rawAlbedo = fieldAlbedo;
        for (const slot of emitterSlots) {
          If(slot.radius.greaterThan(0.001), () => {
            const rel = vec3(slot.center).sub(cellCenter).toVar();
            const dist = rel.length().max(1e-4).toVar();
            const dir = rel.div(dist).toVar();
            // ONE-SIDED (see the analytic-slot note above) — the outside
            // shell of a wall must never take the inside lamp's light.
            // Raw cosθ feeds the HORIZON-aware sphere factor: a lamp
            // resting on a surface still lights the cells around it. Box
            // slots are one-sided by construction (receiver-facing faces
            // integrate against the cell's own normal, horizon-clamped).
            const cosTheta = dir.dot(normal).toVar();
            const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
            const factor = emitterSlotFactor(slot, cellCenter, normal, cosTheta, sinR).toVar();
            // Dim-cell cutoff with the same SMOOTH fade as the analytic
            // gate above (a binary skip rings at the iso-luminance edge).
            const emitterEnergy = vec3(slot.color).mul(factor);
            const emitterCellLum = emitterEnergy.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
            If(factor.greaterThan(1e-6).and(emitterCellLum.greaterThan(0.002)), () => {
              const origin = cellCenter.add(normal.mul(normalLiftV));
              const k = dist.div(float(emitterAngularRadius(slot)).max(0.05)).clamp(1.2, 48);
              const maxT = emitterSurfaceT(slot, origin, dir, dist).sub(normalLiftV).max(0);
              const shadow = float(1).toVar();
              If(maxT.greaterThan(normalLiftV), () => {
                // Exclusion = lamp body + ~2 cells, NOT a fixed 2m — a
                // fixed radius exempted nearby walls from occluding. Box
                // slots dilate their OBB instead of the bounding sphere
                // (a panel's sphere swallowed the ceiling above it → the
                // field itself carried light into the next room).
                const kindF = slot.kind ? float(slot.kind) : null;
                const exRadius = kindF
                  ? mix(float(slot.radius).mul(1.5).add(normalLiftV.mul(2)), normalLiftV.mul(2), kindF)
                  : float(slot.radius).mul(1.5).add(normalLiftV.mul(2));
                const exBox = kindF
                  ? { half: mix(vec3(-1), vec3(slot.half), kindF), bx: slot.bx, by: slot.by, bz: slot.bz }
                  : null;
                // The emitter's own disc is the jitter cone (sinR = its
                // angular radius from this cell) — the estimator still
                // shapes each ray's penumbra; the jitter is what removes
                // the sample-admission churn as the geometry/light moves.
                const eAngle = jitter
                  ? select(jitter.angle.greaterThan(1e-6), sinR.min(0.4), float(0))
                  : null;
                const traceDirE = jitter ? jitterDir(dir, eAngle) : dir;
                shadow.assign(
                  emitterShadow(
                    origin, traceDirE, maxT, k, cosTheta.max(0),
                    vec3(slot.center), exRadius, exBox,
                  ),
                );
              });
              // Same live hatch as the analytic block above.
              if (fieldShadowOff) shadow.assign(mix(shadow, float(1), fieldShadowOff));
              const direct = rawAlbedo
                .mul(vec3(slot.color))
                .mul(factor.mul(1 / Math.PI))
                .mul(shadow)
                .mul(smoothstep(0.002, 0.006, emitterCellLum));
              out.assign(vec4(out.xyz.add(direct), out.w));
            });
          });
        }
      }
      // FRONT hemisphere only. The old "gather both sides, keep brighter"
      // rule existed because accumulated triangle normals were unreliable on
      // thin geometry — SDF-gradient normals are per-side correct, and the
      // both-sides rule made every wall's OUTSIDE shell re-radiate the
      // room's energy (glowing wall backs, light pools outside). max/min:
      // WGSL min/max return the non-NaN operand → NaN scrub for the loop.
      const irradiance = gather(cellCenter.add(normal.mul(normalLiftV)), normal, vec3(0)).max(vec3(0)).min(vec3(1e4));
      // Albedo clamped to 0.9: a pure-white (albedo 1.0) enclosed room makes
      // the feedback series diverge even at gain 1 — real surfaces never
      // reflect 100%, and the clamp guarantees loop gain ≤ 0.9·gainUniform.
      // Accumulates onto `out` (which already carries base + analytic direct).
      const albedo = fieldAlbedo.min(vec3(0.9));
      const bounceTerm = albedo.mul(irradiance).div(Math.PI).mul(gainUniform);
      out.assign(vec4(out.xyz.add(bounceTerm), 1));
      indirect.addAssign(bounceTerm);
      if (coverageAt) {
        // Area weighting (see the option's note). AFTER all injection terms,
        // BEFORE the EMA: the smoothing then integrates coverage changes the
        // same way it integrates lighting changes, and a cell entering the
        // occupied set ramps in at its (small) initial coverage instead of
        // popping to full-cell brightness — the mover-flicker mechanism.
        const cov = float(coverageAt(cellCenter)).toVar();
        out.assign(vec4(out.xyz.mul(cov), out.w));
        indirect.mulAssign(cov);
      }
    });
    if (fieldSmoothing) {
      // Retain weight 0 for a cell that just went empty→occupied (the
      // `wasEmpty` test from the top) — takes `out`/`indirect` outright, no
      // fade-in from black through half-lit. Every other occupied cell
      // blends toward last frame's value at the source, which is what makes
      // a shadow-ray/DDA-oracle flip an integrable ramp instead of a step
      // the whole downstream (probe EMA, screen resolve) inherits.
      const fieldAlpha = float(fieldSmoothing).toVar();
      If(wasEmpty, () => { fieldAlpha.assign(0); });
      // Swept-region history cut (see the option's note): the retain weight
      // scales down inside a moving exact-dynamic object's swept bounds, so
      // its shadow/bounce sweep across static cells with low lag while the
      // rest of the field keeps full smoothing. Cell center recomputed here —
      // the occupied-branch `cellCenter` is out of scope, and this block runs
      // for every cell.
      if (sweptInvalidationAt) {
        const idxS = instanceIndex.toFloat();
        const cellCenterS = vec3(
          mod(idxS, res.x).add(0.5).mul(world.cell.x).add(world.min.x),
          mod(floor(idxS.div(res.x)), res.y).add(0.5).mul(world.cell.y).add(world.min.y),
          floor(idxS.div(res.x * res.y)).add(0.5).mul(world.cell.z).add(world.min.z),
        );
        fieldAlpha.assign(fieldAlpha.mul(float(sweptInvalidationAt(cellCenterS))));
      }
      out.assign(vec4(mix(out.xyz, prevRadiance.xyz, fieldAlpha), out.w));
      if (prevIndirect) indirect.assign(mix(indirect, prevIndirect.xyz, fieldAlpha));
    }
    volume.radianceBuffer.element(instanceIndex).assign(out);
    if (volume.indirectBuffer) {
      volume.indirectBuffer.element(instanceIndex).assign(vec4(indirect, base.w));
    }
  })().compute(cellCount);
}
