// SPLIT RADIANCE CASCADES — the shape of the cascade hierarchy.
//
// docs/GI_SRC_REBUILD_PLAN.md §2 / §4. Pure JS, no three, no TSL: every
// consumer (CPU reference, GPU kernels, telemetry, tests) derives its numbers
// from HERE so there is exactly one definition of the hierarchy. A second
// place that computes an interval boundary is a leak waiting to be measured.
//
// ══ THE TWO SCALING FACTORS ══════════════════════════════════════════════════
//
// β = 4  angular branching: |D_{i+1}| = 4·|D_i|, and the 4→1 parent mapping is
//        integer halving on the 2w×w bin grid (srcMath.binParent).
// γ = 4  interval scaling:  L_{i+1} = 4·L_i.
//
// BOTH, simultaneously — that is the paper's core theoretical claim (§3.2,
// Appendix A): the estimator minimizes `max(spatial error α, angular error ε)`
// only when ε scales WITH α. γ=2 lets angular error dominate the far cascades.
//
// This module previously ran BRANCH=2, and BRANCH=4 was rejected twice (see
// the plan's §11 decision log). Those rejections were measured on the DENSE
// LATTICE with the parallax merge kernel at c0DirRes 2–4 — a regime where
// angular resolution could not be raised to compensate. The merge here is
// count-weighted sparse with pre-averaging and no parallax re-aim, which is a
// different estimator; the falloff/chroma probes that produced the original
// rejections re-gate this one. If γ=4 fails them HERE that is a real finding
// to take upstream, not a config to quietly fudge.
//
// ══ SPACING vs INTERVAL — the one spatial dial ═══════════════════════════════
//
// `spacing0` (s₀) is THE live spatial dial (session-36 lesson: one dial, not
// a family of interacting ones). r₀ is DERIVED from it at a fixed ratio, so a
// user dragging spacing never desynchronizes the two.

/** Angular branching factor — bins ×4 per cascade. */
export const BETA = 4;
/** Interval scaling factor — interval length ×4 per cascade. */
export const GAMMA = 4;

/**
 * Cascade count. With γ=4 the reach is r₀·(4^N − 1)/3, so N=4 covers
 * ~85·r₀ — a scene — and everything past it is sky. Raising N does not
 * improve a scene's transport, it just moves the sky boundary further out,
 * which is why `cascadeCount` is retired as a user prop (plan §6).
 */
export const CASCADE_COUNT = 4;

/**
 * c0 direction-bin grid width. Bins live on a 2w×w equal-area cylindrical
 * grid, so |D_i| = 2·w_i². w₀=4 → |D₀| = 32, the paper's reference config.
 */
export const W0 = 4;

/** r₀ / s₀. Paper §7 reference configuration: r₀ ≈ 1.6·s₀. */
export const R0_OVER_S0 = 1.6;

/**
 * Maximum LOD count. The 32-bit probe key spends 4 bits on LOD and stores
 * LOD+1 (so a packed key can never be zero — zero is the hashmap's EMPTY
 * sentinel), which leaves 15 usable LODs. The plan clamps selection to
 * MAX_LODS; 10 is already 1024·s₀ of reach.
 */
export const MAX_LODS = 10;
/** Hard ceiling imposed by the key layout — MAX_LODS may not exceed it. */
export const KEY_MAX_LODS = 15;

/**
 * LOD interval-start shortening (paper §4.1). Each LOD's interval starts at
 * 0.9× where it otherwise would, so adjacent LODs OVERLAP and shading can
 * blend linearly across the overlap instead of switching. R1 (no binary
 * anything) is why this is not optional.
 */
export const LOD_OVERLAP = 0.9;

/** Per-probe octahedral irradiance tile: 6×6 interior + 1-texel border. */
export const IRRADIANCE_TILE_INTERIOR = 6;
export const IRRADIANCE_TILE_BORDER = 1;
export const IRRADIANCE_TILE_SIZE =
  IRRADIANCE_TILE_INTERIOR + 2 * IRRADIANCE_TILE_BORDER; // 8

/**
 * DEFAULT for [J]'s LOD-bias uniform, and it ships at ZERO rather than at the
 * paper's 2.
 *
 * The paper's §6 secondary cache sits two LODs coarser than the probes that
 * spawned it, and this constant carried that 2 for as long as [J] was a hook.
 * SRC has no separate secondary cache — [J] re-reads the PRIMARY tile atlas
 * (§12.26.9 measured the same-spacing cache as the least-leaky option, because
 * coarsening BRIGHTENS a feedback loop) — and on that lattice a positive bias
 * has nothing to read: [B] inserts keys only at the CAMERA-DERIVED LOD, so
 * there are no probes at LOD+2 and every biased corner lookup misses. The
 * gather renormalizes a missing shell away, so the bias would cost eight hash
 * finds per hit and change nothing.
 *
 * It stays a live uniform rather than a deleted idea because "nothing exists
 * up there" is a property of the POPULATION, not of the estimator, and a
 * future coarse-shell population would make the bias meaningful again.
 * `__giSrcSecondaryLodBias` is the A/B hatch (see `srcSecondary.js`).
 */
export const SECONDARY_LOD_OFFSET = 0;

/**
 * Words per entry in [J]'s hit list — the compact record [E] appends for every
 * shaded hit and [J] re-shades from. Unpacked floats via `floatBitsToUint`
 * (`dynamicObjects.js` uses the same idiom for its BVH triangle pool): 0-2 the
 * hit position, 3-5 the face-forwarded normal, 6-8 the CLAMPED albedo, 9 the
 * destination bin's word base, 10-11 reserved.
 *
 * The list rides the tail of the bin store's `scratch` buffer (R7 — see
 * `createSrcBinStore`), so a wider entry costs memory but never a binding.
 */
export const SECONDARY_HIT_WORDS = 12;

/**
 * Temporal blend rate (plan §4.6), applied to the DEPOSIT ACCUMULATORS rather
 * than to the resolved payload — see `srcDeposit.js`'s decay pass for why the
 * plan's placement stopped being available once [G] merged in place, and why
 * this placement is the better one anyway.
 *
 * **THERE IS NO FAST-α WARMUP, AND R6 IS SATISFIED WITHOUT ONE.** The plan
 * carried `ALPHA_FRESH = 0.3` / `FRESH_FRAMES = 8` because a payload EMA
 * (`H ← (1−α)·H + α·S`) starting from `H = 0` gives a newborn probe `0.1·S` on
 * its first frame and makes it crawl up from black over ~20 frames — exactly
 * the "smooths MEMBERSHIP, not values" failure R6 names. Decaying the
 * accumulators has no such state: a fresh block's sums are zero, so its first
 * frame resolves to `ΣL/Σcount` over that frame's own rays and nothing else.
 * The estimate is weighted by EVIDENCE rather than by frame count, which is
 * what makes the warmup unnecessary rather than merely cheap.
 *
 * `1` is single-frame mode — the quality-gate configuration of §4.6, and here
 * it is not a code path but the α = 1 case of the same multiply.
 */
export const TEMPORAL_ALPHA = 0.1;

/**
 * The α a STILL scene settles to (§12.38). The shipping α is a continuous ramp
 * `ALPHA_STILL + motion·(TEMPORAL_ALPHA − ALPHA_STILL)` driven by a scene-motion
 * signal (lights + emitters + movers, NOT the camera — probe evidence is
 * world-anchored, so a camera move stales nothing), the exact velocity-scaled-
 * memory shape the GI light-shadow chain already ships and for the same two
 * measured reasons: a flush-on-change guts the memory under a per-frame script
 * write, and a binary moved/still split guts it for slow motion.
 *
 * The value is from `run-gi-flicker-frame.mjs`'s ALPHA_SWEEP (still + moving
 * arms, interleaved ×2 with a full discarded settle arm per α switch — without
 * the settle arm the sweep measures the accumulator's own ~1/α-refresh
 * re-equilibration and calls it flicker):
 *
 *     α       still rev/px   still p95   moving rev/px   moving p95
 *     0.1     4.32           0.25        4.48            0.49
 *     0.05    1.15 (÷3.75)   0.61        1.64            0.67
 *     0.02    0.40 (÷10.9)   0.82        0.92            0.63
 *
 * The still-scene shimmer is VARIANCE (it falls monotonically with α); the
 * rising per-change p95 is the counted set shrinking to the sparse structural
 * events α cannot touch (§12.24's bin-membership floor — a separate, named
 * debt). 0.05 rather than 0.02 because the still floor still governs how fast
 * a light TOGGLE converges (intensity changes are invisible to the motion
 * signal): ~1 s at 0.05 and stride 3 against ~2.5 s at 0.02. The extra 2.9× is
 * headroom for when an intensity-delta joins the motion signal.
 */
export const TEMPORAL_ALPHA_STILL = 0.05;

/**
 * The motion at which the α ramp saturates at TEMPORAL_ALPHA — derived from
 * the light-shadow chain's own saturation ((0.94 − 0.86)/30 in its hist-weight
 * formula), so "moving" means the same thing to both temporal memories. In the
 * signal's units: ~0.0027 rad of light swing, an emitter retain of 1, or a
 * ~5.3 cm/frame mover translation.
 */
export const ALPHA_MOTION_SAT = (0.94 - 0.86) / 30;

/**
 * ══ THE TRACKING WINDOW — WHY A SEEN CHANGE HOLDS α UP (§12.43) ═════════════
 *
 * The motion signal is INSTANTANEOUS: a lamp toggle is one frame of luminance
 * delta, so α spiked for ~a frame and the field's actual convergence ran at
 * the still floor — with §12.42's compensation re-engaged on capped blocks.
 * Measured (`probe:gi-src-converge`, Cornell, intensity 2→6): t90 = 0.48 s
 * with cap+comp off, 1.65 s shipped at stride 1, and **7.42 s at stride 12**,
 * the ultra/fullscreen regime — the user's "temporal is way too slow", twice
 * reported, in one table.
 *
 * Two coupled mechanisms, one switch (`__giSrcMotionTrack = false` restores
 * both old behaviours), and both arm on LIGHT EVENTS ONLY — light matrix
 * motion, luminance deltas, emitter changes — NEVER on mover displacement:
 *
 *  1. PEAK-HOLD (GISystem's `sceneMotion` closure): a light-side peak ≥
 *     ALPHA_TRACK_THRESHOLD arms a window of ALPHA_TRACK_HOLD_MS during
 *     which the closure reports the held peak — α (and §12.42's lift) stay
 *     at the change's level while the field actually converges instead of
 *     for the one frame the delta itself lasts.
 *  2. THE STRIDE ROOT RELAXES INSIDE THE WINDOW (srcSystem.syncCamera,
 *     via the `trackMotion` getter): `keep = (1−α)^(1/(1+(S−1)·(1−tr)))`,
 *     `tr` = the held light peak while the window is open, 0 otherwise. At
 *     tr = 1 the root is gone — a LIGHT change invalidates the WHOLE field,
 *     so preserving its history is not stability, it is lag.
 *
 * ⚠ WHY LIGHT-SIDE ONLY IS LOAD-BEARING, NOT A PREFERENCE. The first draft
 * armed on ANY motion peak and tied the root to α's own ramp position, and
 * TRACK_AB refuted it the day it was written: moving arms 21.5 vs 1.0
 * rev/px, and the STILL controls 21.2 vs 0.92 — the mover term spikes
 * spuriously on a parked ultra scene (§12.42.4's lift snapshot read 0.944
 * on a still arm before any tracking code existed), and a hold turns every
 * spike from one frame of raised α into a 1.2 s burst of relaxed-root fast
 * decay. The user saw that build as "the floor is covered in water". An
 * object's motion also only invalidates the field LOCALLY (the sources are
 * unchanged); movers keep §12.38's shipped behaviour exactly.
 */
export const ALPHA_TRACK_HOLD_MS = 1200;
export const ALPHA_TRACK_THRESHOLD = 0.5;
/**
 * §12.46: the window arms on RISING EDGES of the light peak, and a crossing
 * only counts as an edge after the peak spent at least this long BELOW the
 * threshold. Two regimes forced this:
 *
 *  - A CONTINUOUS sun (the user's day-cycle script: 2–6× ALPHA_MOTION_SAT
 *    per frame, every frame) saturates the peak permanently. Level-triggered
 *    arming re-pushed the hold each frame, so the window NEVER closed during
 *    play — §12.45's cap lift became permanent (the §12.42 fps win cancelled
 *    for the whole session) and the window's fast decay became the steady
 *    state. LIGHT_ROT priced the regimes: level-armed 4.62 rev/px at
 *    capLift 100% vs window-off 5.07 at capLift 0 — SAME churn, tier-capped
 *    cost — while no-lift's 30.9 confirms the lift must exist wherever level
 *    arming does. Sustained motion needs no window: the m-driven α ramp with
 *    the tier cap IS its steady state.
 *  - The dwell exists for the ping-pong's ENDPOINTS: the eased swing sits
 *    sub-threshold ~0.6 s at each extreme, and without the dwell every swing
 *    restart would arm a fresh 1.2 s window — a periodic uncapped churn
 *    burst every half-cycle. 800 ms clears that dwell; a genuine isolated
 *    event (toggle, teleport) follows seconds of quiet and always arms.
 *
 * A step DURING sustained motion cannot edge (the peak is already high) and
 * rides the saturated α ramp instead — accepted: fast α is already the
 * ceiling of what the ramp buys. `__giSrcTrackLevelArm = true` restores
 * level arming — the rig's regression arm, never a shipping config.
 */
export const ALPHA_TRACK_REARM_MS = 800;

/** Frames a probe survives unseen before the per-frame rebuild stops re-inserting it. */
export const PROBE_MAX_AGE = 60;

/**
 * Albedo ceiling inside the bounce loop. R4: the secondary cache is a temporal
 * fixed-point iteration, so its in-loop gain must be provably < 1. Artistic
 * gain belongs OUTSIDE the loop (the `intensity` prop), never here.
 */
export const MAX_LOOP_ALBEDO = 0.9;

/**
 * Quality tiers. Unlike the dense backend's tiers these scale s₀, rays/pixel
 * and w₀ — NOT a world volume, because SRC has no volume to scale. Memory is
 * screen-proportional by construction (plan §4.2).
 *
 * `spacing0` is metres at LOD 0. `raysPerPixel` counts full-length rays per
 * half-res gbuffer pixel. `w0` raises c0 angular resolution on the top tiers.
 */
export const SRC_QUALITY = {
  low: { spacing0: 0.8, raysPerPixel: 1, w0: 4, secondary: false, transportRays: 32_768, probeRayCap: 16 },
  medium: { spacing0: 0.6, raysPerPixel: 1, w0: 4, secondary: true, transportRays: 65_536, probeRayCap: 16 },
  high: { spacing0: 0.45, raysPerPixel: 2, w0: 4, secondary: true, transportRays: 131_072, probeRayCap: 16 },
  ultra: { spacing0: 0.35, raysPerPixel: 2, w0: 8, secondary: true, transportRays: 262_144, probeRayCap: 16 },
};

/**
 * ══ THE RAY CEILING, AND WHY THE TRANSPORT CANNOT BE PRICED IN PIXELS ═══════
 *
 * `transportRays` is the most rays one frame may fire, full stop. Above it the
 * pixel set is STRIDED (`srcRays.js`'s [D1]/[D5]) with a per-frame rotating
 * phase, so the whole screen is still covered — over several frames, into an
 * accumulator that was built for exactly that (§12.23).
 *
 * It exists because everything else here is per-pixel and that turned out to be
 * a cost model, not just an addressing scheme. Population inserts a probe per
 * gbuffer pixel, [D1] gives each pixel `raysPerPixel` rays, and the deposit is
 * dispatched per pixel — so the transport's cost is the SCREEN's size, and
 * `giConfig.js` hands ultra `resolveScale: 1`. On the user's Sponza that is
 * 1,573,200 px × 2 = 3,146,400 rays per frame to service 5,692 live probes:
 * ~553 rays per probe, against the **0.78 rays/bin** §12.13 measured as this
 * design's own operating point. Measured cost, `profile.giPasses` on that
 * editor: the deposit is **249 ms of a 260 ms** SRC chain — 95.7% of it.
 *
 * `probe:gi-src-cost` swept transport pixels at ultra with the tier pinned:
 *
 *     rays      deposit ms   ns/ray   screen mean
 *     631,904      9.037      14.3      0.12733
 *     157,976      2.339      14.8      0.12380
 *
 *     least squares: deposit ms ≈ 0.547 + 13.4 ns × rays  ⇒ rays are 94% of it
 *
 * Four times fewer rays cost **2.8%** of screen mean. So this is a ceiling on
 * the thing that is 94% of the cost, bought at ~3% of the look.
 *
 * ⚠ THESE ARE CEILINGS, NOT TARGETS. `stride = max(1, ceil(rays / ceiling))`,
 * so a small viewport whose natural ray count is already under the ceiling gets
 * `stride = 1` and is bit-identical to the old behaviour. Every gate runs there.
 *
 * ⚠ AND THEY ARE NOT YET TUNED AGAINST THE USER'S MACHINE. The same kernel
 * measured **79 ns/ray** in their editor against **13.4** in the harness, both
 * at ultra — 5.5×, cause unestablished (thread-count cache pressure over the
 * 218 MB occupancy field and sustained-load clocks are the candidates; the
 * harness cannot see either). So the ms these ceilings buy THERE has to be
 * re-measured there. `globalThis.__giSrcTransportRays` is the A/B.
 */
export function srcTransportRays(tier) {
  const forced = Number(globalThis.__giSrcTransportRays);
  if (Number.isFinite(forced) && forced > 0) return Math.round(forced);
  return SRC_QUALITY[tier]?.transportRays ?? SRC_QUALITY.high.transportRays;
}

/**
 * ══ THE PER-PROBE RAY CAP — §12.32.1's OPTION (1), DEFAULT ON high/ultra ═══
 *
 * The ceiling above bounds the FRAME; this bounds the PROBE. `probe:gi-src-cost
 * SWEEP=histo` measured why it exists (Sponza, high, nave pose): 2,432 live c0
 * probes shared 126,381 rays/frame with the MEDIAN probe firing 8 and the
 * fattest 1,794 — membership pricing sends ~80% of the budget to the few
 * probes whose bins converged long ago. Capping each c0 probe at B rays/frame:
 *
 *     cap B    Σmin(count,B) vs today     probes AT the cap
 *       8          0.105×                 41%
 *      16          0.171×                 28%
 *      32          0.261×                 19%
 *
 * THE DEFAULT (16 on high and ultra) IS GATED ON THE α COMPENSATION being in
 * the decay (§12.42): a hard cap alone concentrates its evidence cut on the
 * near-field, screen-filling probes and still-scene reversals rise like
 * √(ray cut) — 2.57×/3.06×/1.78× at high16/ultra16/ultra32, the §12.40.4
 * measurement that kept the cap opt-in for exactly one unit. With the
 * compensation holding each block's evidence window at its uncapped value,
 * the same rig reads the capped arm BELOW the off arm at all three points
 * (−27%/−15%/−10%), because the longer memory also carries starved bins
 * through influx gaps — §12.24's membership churn drops with it. Ship a cap
 * change ONLY through that rig; step p95 (+23–31%, fewer-but-chunkier
 * membership events) is the recorded residual, §12.24's floor. low/medium
 * gained cap 16 on 2026-08-12: "25 fps with any emissive at low" was a
 * 10.1 ms UNCAPPED deposit (62k rays for 1,046 live c0 probes — the coarse
 * low lattice concentrates ~60 rays on a mean probe, so the cap cuts MORE
 * here than the high/ultra arms it was priced on), and the α compensation
 * that makes the cut variance-neutral is tier-independent.
 *
 * The cap is a UNIFORM polled per frame (`__giSrcProbeRayCap` — a positive
 * number caps live, 0 forces OFF over the tier default, unset = the tier),
 * so every experiment is in-page. It is floored to a multiple of
 * raysPerPixel because [D5] hands out whole per-pixel slices; a non-multiple
 * cap would leave the tail of every capped probe's segment
 * allocated-but-unclaimed, which the coverage gate reads as lost rays.
 */
export const PROBE_RAY_CAP_OFF = 0x3fffffff;

/**
 * Fixed-point ONE for the per-block INFLUX WORD — the cap's α compensation
 * (§12.40.4). The long doc lives on the influx region in `srcProbes.js`; the
 * constant lives HERE because `srcMath.js`'s mirror (`keepCompensated`,
 * `influxWordFor`) must read it too and that module's bare-Node rule forbids
 * importing anything that touches `three`. A power of two, deliberately:
 * `float(word)/65536` and `ratio·65536` are exact exponent shifts in f32,
 * which is what lets the mirror match the GPU bit for bit with `Math.fround`
 * on the one operation that rounds (the divide).
 */
export const INFLUX_ONE = 0x10000;
export function srcProbeRayCap(tier, raysPerPixel = 1) {
  const forced = Number(globalThis.__giSrcProbeRayCap);
  let cap = SRC_QUALITY[tier]?.probeRayCap ?? PROBE_RAY_CAP_OFF;
  if (Number.isFinite(forced)) cap = forced > 0 ? Math.round(forced) : PROBE_RAY_CAP_OFF;
  const rpp = Math.max(1, raysPerPixel);
  return Math.max(rpp, cap - (cap % rpp));
}
const QUALITY_TIERS = new Set(Object.keys(SRC_QUALITY));

/**
 * The tier a preset name selects for. "custom" means "the preset name no
 * longer implies values", not "no tier" — every table lookup still needs one,
 * and "high" is both the least surprising choice and the component's own
 * zero-setup default. Same contract as the dense backend's `qualityTierOf`,
 * deliberately, so the Inspector's flipsToCustom behaviour is unchanged.
 */
export function srcQualityTier(props) {
  const quality = props?.quality;
  return QUALITY_TIERS.has(quality) ? quality : "high";
}

/**
 * Direction-bin grid width at cascade `i`: w_i = w₀·2^i, so |D_i| = 2·w_i².
 * The grid is 2w wide (azimuth) by w tall (the equal-area z band).
 */
export function binGridWidth(cascade, w0 = W0) {
  return w0 * (1 << cascade);
}

/** Direction-bin count at cascade `i` — 2·w_i². */
export function binCount(cascade, w0 = W0) {
  const w = binGridWidth(cascade, w0);
  return 2 * w * w;
}

/**
 * Total direction bins the per-probe block pool may hold, across all cascades.
 *
 * ══ WHY THIS IS A BUDGET AND NOT A CAPACITY ════════════════════════════════
 *
 * Bins used to be addressed by probe CAPACITY — one block per probe SLOT,
 * whether or not a probe ever existed there. That sized the accumulators off a
 * generous over-estimate (`expectedC0Probes` is a quarter of the pixel count,
 * floored at 16,384) and it did not survive contact with a real viewport: at a
 * half-res 1080p gbuffer the c0 capacity is 131,072 slots, which is 16.8 M bins
 * and **604 MB** — past the 128 MiB binding limit by five times, i.e. the
 * constructor would have thrown before the first frame.
 *
 * §12.16's gate measured the waste directly: **0.24% of allocated bins were
 * ever sampled.** So blocks are claimed by LIVE probes out of a pool, and the
 * pool is sized by this budget rather than by the slot count.
 *
 * ══ THE SPLIT IS EQUAL BINS PER CASCADE, AND THAT IS MEASURED ══════════════
 *
 * Probe counts fall ~4× per cascade (spacing doubles on a 2D surface manifold)
 * while bins rise exactly 4× (β = 4). The two cancel, so every cascade wants
 * the same TOTAL bin count — §12.13.4 measured the consequence as 0.78 rays per
 * bin at every cascade, flat. An equal split is therefore the shape of the
 * data, not a convenience.
 *
 * 1.4 M bins is ~48 MB at 9 words per bin (5 scratch + 4 payload), which is the
 * §12.18.3 target, and it buys 10,937 c0 blocks — above the ~10,000 live c0
 * probes §12.18.2 estimates for a Sponza-class interior after `LOD0_REACH`.
 * That estimate is the thing to re-measure when the LOD law lands: the claim
 * failure is COUNTED (`COUNTER_NOBLOCK`), so a pool that turns out too small
 * says so instead of producing an unexplained dark patch.
 */
export const BIN_BUDGET = 1_400_000;
/** Floor per cascade, so a one-cascade or tiny-w₀ configuration is not degenerate. */
export const MIN_BLOCKS = 64;

/**
 * How many bin blocks each cascade's pool holds, given the probe slot counts.
 *
 * Capped by `probeCapacity` because a block no probe slot can ever claim is
 * pure waste, and floored by `MIN_BLOCKS` so the arithmetic cannot produce a
 * pool of one. Lives here rather than in `srcDeposit.js` because it is a
 * property of the HIERARCHY — cascade count and w₀ — and this file is the one
 * definition of that (a second place that computes bins per cascade is the leak
 * this module's header warns about).
 */
export function blockCapacities(probeCapacities, w0 = W0, budget = BIN_BUDGET) {
  const perCascade = Math.max(1, Math.floor(budget / Math.max(1, probeCapacities.length)));
  return probeCapacities.map((slots, cascade) => Math.min(
    slots,
    Math.max(MIN_BLOCKS, Math.floor(perCascade / binCount(cascade, w0))),
  ));
}

/**
 * Probe spacing at cascade `i`, LOD `lod`: s₀·2^i·2^lod.
 *
 * Spacing doubles per cascade (probes ÷4 on a 2D surface manifold, which is
 * what keeps per-cascade BIN totals near constant against bins ×4) and
 * doubles again per LOD, which is the whole open-world mechanism.
 */
export function probeSpacing(cascade, lod, spacing0) {
  return spacing0 * (1 << cascade) * (1 << lod);
}

/**
 * Interval LENGTH of cascade `i` at `lod`: r₀·γ^i, scaled by the LOD's own
 * doubling of r₀.
 */
export function intervalLength(cascade, lod, spacing0) {
  const r0 = spacing0 * R0_OVER_S0 * (1 << lod);
  return r0 * Math.pow(GAMMA, cascade);
}

/**
 * Cumulative interval boundaries at `lod`: the array `[r_0, r_1, ... r_{N-1}]`
 * where cascade i owns hit distances in (r_{i-1}, r_i], r_{-1} = 0.
 *
 * Contiguous by construction — r_i = r₀·(γ^{i+1} − 1)/(γ − 1) — because a GAP
 * between intervals is a distance band no cascade owns, i.e. light that is
 * silently dropped, and an OVERLAP double-counts it. The furnace test in the
 * Phase-0 suite exists to prove there is neither.
 */
export function intervalBoundaries(lod, spacing0, cascadeCount = CASCADE_COUNT) {
  const r0 = spacing0 * R0_OVER_S0 * (1 << lod);
  const out = new Array(cascadeCount);
  let acc = 0;
  for (let i = 0; i < cascadeCount; i++) {
    acc += r0 * Math.pow(GAMMA, i);
    out[i] = acc;
  }
  return out;
}

/** Total reach at `lod` — past this a ray composites sky. */
export function cascadeReach(lod, spacing0, cascadeCount = CASCADE_COUNT) {
  const bounds = intervalBoundaries(lod, spacing0, cascadeCount);
  return bounds[bounds.length - 1];
}

/**
 * How far LOD 0 reaches, in units of s₀ — the distance at which s₀ stops being
 * a fine enough probe spacing and the lattice is allowed to double.
 *
 * ══ THE CONSTANT THAT WAS MISSING, AND WHAT ITS ABSENCE DID ════════════════
 *
 * `lodAtDistance` used to be `log2(cheb / s₀)`, i.e. this constant fixed at 1.
 * Compose that with `probeSpacing(0, lod, s₀) = s₀·2^lod` and the result is
 * **spacing ≈ the camera distance**: LOD 0 applied within 0.45 m of the camera
 * at the shipping s₀ and everything beyond it was coarsened in proportion to
 * how far away it was. Angular probe spacing was therefore a constant ~1
 * radian — 57° — where it needs to be a fraction of a degree, and that is why
 * §12.17's Cornell render is made of rectangles. The capacity was never the
 * problem; the LAW was.
 *
 * The value is derivable rather than tuned: `LOD0_REACH = s₀/α` for a target
 * angular spacing α, and α ≈ 1/64 rad (0.9°) gives 64. It matches
 * `REANCHOR_CHEBYSHEV`'s 64·s₀ and that is not a coincidence — both answer
 * "how far out does the LOD-0 lattice have to stay usable".
 *
 * A POWER OF TWO ON PURPOSE. The twins must agree bit-for-bit
 * (`test:gi-src-math`), and `s₀·64` is exact in f32 and f64 alike, so the two
 * implementations cannot drift on the multiply this constant introduces.
 *
 * 128 was the other end of §12.18.2's range and is rejected by arithmetic:
 * halving the angular spacing quadruples the probe count, which puts a
 * Sponza-class interior at ~40,000 c0 probes — past both the 16,384 slot
 * capacity and the block pool. 64 lands it at ~10,000.
 */
export const LOD0_REACH = 64;

/**
 * LOD for a world point, from the CHEBYSHEV distance to the camera (paper
 * §4.1 — Chebyshev, not Euclidean: with grid-aligned probes the L∞ ball's
 * flat faces put LOD boundaries parallel to the probe planes, which produces
 * far fewer transition artifacts than a sphere cutting them diagonally).
 *
 * Returns a FRACTIONAL lod. The integer part selects the shell; the fraction
 * is what the ×0.9-overlap blend consumes at shading time, so no caller ever
 * sees a hard flip (R1).
 */
export function lodAtDistance(cheb, spacing0, maxLods = MAX_LODS) {
  const ratio = cheb / Math.max(spacing0 * LOD0_REACH, 1e-6);
  if (!(ratio > 1)) return 0;
  const lod = Math.log2(ratio);
  return Math.min(Math.max(lod, 0), maxLods - 1);
}

/**
 * INVERSE of `lodAtDistance` — the Chebyshev distance at which LOD `lod`
 * begins, so LOD k occupies `[lodRadius(k), lodRadius(k+1))` and LOD 0 extends
 * down to zero.
 *
 * Exported because the gates need it and the alternative is worse: every gate
 * that places test geometry per LOD, or asserts a probe sits in its own ring,
 * was writing `s₀·2^lod` inline — the old law's inverse, spelled out in four
 * files. Changing the law would have left them all compiling, passing, and
 * silently testing a single LOD. One definition, inverted once.
 */
export function lodRadius(lod, spacing0) {
  return spacing0 * LOD0_REACH * Math.pow(2, lod);
}

/** Chebyshev (L∞) distance — the LOD metric. */
export function chebyshev(ax, ay, az, bx, by, bz) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

/**
 * The blend weight between LOD `floor(lodF)` and `floor(lodF)+1` across the
 * ×0.9 overlap band. 0 = wholly the coarser-shell side is unused; 1 = wholly
 * the next LOD. Linear inside the band, saturated outside it, and CONTINUOUS
 * at both ends — the property that makes a fly-through not pop.
 */
export function lodBlend(lodF) {
  const frac = lodF - Math.floor(lodF);
  // The overlap occupies the top (1 − LOD_OVERLAP) of each LOD's span.
  const start = LOD_OVERLAP;
  if (frac <= start) return 0;
  return Math.min(1, (frac - start) / (1 - start));
}

/**
 * The SHELLS a world point samples, with weights summing to 1 — the form every
 * consumer should use, and the one whose continuity actually matters.
 *
 * `lodBlend` alone is deliberately DISCONTINUOUS at integer lodF (it ramps to 1
 * just below the boundary, then restarts at 0 just above), and reading that as
 * a popping risk is a mistake worth naming: just below lodF=1 the pair is
 * {LOD0: 0, LOD1: 1} and just above it is {LOD1: 1} — the same shell at the
 * same weight. The jump is in the *parameterization*, not in the result.
 *
 * So the invariant to hold — and the one the Phase-0 suite measures — is that
 * the weight this function assigns to any FIXED integer LOD is continuous in
 * lodF. That is what a fly-through actually samples, and testing `lodBlend`
 * instead measures an artifact of how the blend is written down.
 */
export function lodShells(lodF, maxLods = MAX_LODS) {
  const base = Math.min(Math.floor(lodF), maxLods - 1);
  const blend = lodBlend(lodF);
  if (!(blend > 0) || base + 1 >= maxLods) return [{ lod: base, weight: 1 }];
  return [
    { lod: base, weight: 1 - blend },
    { lod: base + 1, weight: blend },
  ];
}

/** Weight `lodShells` gives to one specific integer LOD. Continuity instrument. */
export function lodShellWeight(lodF, lod, maxLods = MAX_LODS) {
  for (const shell of lodShells(lodF, maxLods)) {
    if (shell.lod === lod) return shell.weight;
  }
  return 0;
}

/**
 * Resolved hierarchy description — what the GPU side uploads as uniforms and
 * what telemetry prints. `bounds` is per-LOD because r₀ doubles with LOD.
 */
export function describeSrcHierarchy(spacing0, w0 = W0, cascadeCount = CASCADE_COUNT) {
  const cascades = [];
  for (let i = 0; i < cascadeCount; i++) {
    cascades.push({
      cascade: i,
      binGrid: [2 * binGridWidth(i, w0), binGridWidth(i, w0)],
      bins: binCount(i, w0),
      spacingLod0: probeSpacing(i, 0, spacing0),
      intervalLod0: intervalLength(i, 0, spacing0),
    });
  }
  return {
    beta: BETA,
    gamma: GAMMA,
    cascadeCount,
    w0,
    spacing0,
    r0: spacing0 * R0_OVER_S0,
    reachLod0: cascadeReach(0, spacing0, cascadeCount),
    boundariesLod0: intervalBoundaries(0, spacing0, cascadeCount),
    cascades,
  };
}
