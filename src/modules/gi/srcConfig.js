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
 * Conservative compensation for analytic directional light deposited above
 * cascade 0. The cascade merge is energy-exact for uniform radiance but the
 * measured directional lobe retains about 83% per hand-off; recovering the
 * full inverse would overshoot already-hot directions, so each hand-off gets
 * only 8% and the total is capped at 20%. Sky, emissive and recursive radiance
 * never take this path.
 */
export const SUN_BOUNCE_GAIN_PER_MERGE = 1.08;
export const SUN_BOUNCE_GAIN_MAX = 1.2;
export function sunBounceGainForCascade(cascade) {
  return Math.min(SUN_BOUNCE_GAIN_MAX, SUN_BOUNCE_GAIN_PER_MERGE ** Math.max(0, cascade));
}

/**
 * The same bounded angular-reconstruction correction for the chromatic
 * remainder of an analytic directional first bounce. Every source crosses the
 * c0 bin -> cosine-tile reconstruction once, then crosses `cascade` merge
 * hand-offs. Counting only the latter silently gave c0 chroma a gain of 1 even
 * though it pays the former. A mixed neutral+red lobe keeps the neutral furnace
 * exactly; counting that universal stage restores 1.061x mean R-G on the CPU
 * twin (range 0.995x..1.204x, 14.3% worst off-centre) under the existing 1.5
 * ceiling. Environment, emissive, punctual and recursive radiance never take
 * this path.
 */
export const SUN_BOUNCE_CHROMA_GAIN_PER_MERGE = 1.18;
export const SUN_BOUNCE_CHROMA_GAIN_MAX = 1.5;
export function sunBounceChromaGainForCascade(cascade) {
  return Math.min(
    SUN_BOUNCE_CHROMA_GAIN_MAX,
    SUN_BOUNCE_CHROMA_GAIN_PER_MERGE ** (Math.max(0, cascade) + 1),
  );
}

/**
 * c0 direction-bin grid width. Bins live on a 2w×w equal-area cylindrical
 * grid, so |D_i| = 2·w_i². w₀=4 → |D₀| = 32, the paper's reference config.
 */
export const W0 = 4;

/** r₀ / s₀. Paper §7 reference configuration: r₀ ≈ 1.6·s₀. */
export const R0_OVER_S0 = 1.6;

/**
 * §11.28 DIAGNOSTIC DIAL — `__giSrcR0OverS0` overrides r₀/s₀ at BUILD time
 * (every consumer reads it while the field is built: the interval ladder, the
 * TSL boundary, the GTAO band). It exists for ONE experiment: the enclosure
 * ladder's dose-response against interval length, which separates a coarse-
 * cascade PARALLAX leak (it shrinks as hits move into finer cells) from a
 * direction-sampling leak (it does not). Not a quality property.
 */
export function r0OverS0() {
  const f = Number(globalThis.__giSrcR0OverS0);
  return Number.isFinite(f) && f > 0 ? f : R0_OVER_S0;
}

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
 * attributed hit and [J] SHADES from (§12.53: the whole of `shadeHit` moved out
 * of the deposit into [J], so this record is now the entire interface between
 * "what the ray found" and "what it is worth"). Unpacked floats via
 * `floatBitsToUint` (`dynamicObjects.js` uses the same idiom for its BVH
 * triangle pool):
 *
 *    0-2   hit position P (the EXACT, unlifted intersection)
 *    3-5   face-forwarded normal n̂
 *    6-8   albedo ρ, AFTER `clampLoopAlbedo` — R4's in-loop ceiling
 *    9     destination bin's WORD base, already ×BIN_WORDS
 *   10-12  raw emissive Le (R5's zeroing is [J]'s, it needs the NEE set)
 *   13     the R5 emitter flag, as float bits (< 0 = not an NEE light)
 *   14     the ray's index in the global R2 sequence — NEE's stratified draw
 *          is a pure function of it, which is what keeps the pick identical to
 *          the one the un-split shader made
 *   15     the owning block's `BSTAT_SUM_L` WORD ADDRESS, or SLOT_EMPTY when
 *          the surprise bundle is off. [E] cannot sum a luma it no longer
 *          computes, so the per-block evidence word follows the radiance into
 *          [J] — and the ADDRESS is what travels, because `own`, the ancestor
 *          chain and the block claim are all [E]'s frame-local knowledge.
 *
 * 16 words = a 64-byte stride, which is also why the layout has no padding
 * word: the four §12.49 reserved/pad words were exactly the four this unit
 * needed.
 *
 * The list rides the tail of the bin store's `scratch` buffer (R7 — see
 * `createSrcBinStore`), so a wider entry costs memory but never a binding: at
 * the high tier's 131,072-entry capacity, 6.29 MB → 8.39 MB.
 */
// 20 since Stage 3b (water): words 16–18 carry the ray's world direction, so
// [J] can tell a hit seen THROUGH a water surface (Fresnel, absorption, the
// sky's mirror) from one seen in air. Word 19 is padding.
export const SECONDARY_HIT_WORDS = 20;

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
 * debt).
 *
 * 0.05 → 0.02 (2026-08-14, §12.60): the sweep shipped 0.05 rather than 0.02
 * because the still floor then governed how fast a light TOGGLE converged —
 * "intensity changes are invisible to the motion signal", ~1 s at 0.05 vs
 * ~2.5 s at 0.02, and the extra 2.9× was explicitly banked as "headroom for
 * when an intensity-delta joins the motion signal". §12.43 then built exactly
 * that: the tracking window ARMS on light events (its `lightLum` term — the
 * LIGHT_STEP harness drives a real intensity step through the prop path and
 * watches the window arm), so a toggle now converges at the WINDOW's rate
 * whatever the still floor is, and the banked headroom is spendable. The user
 * report it buys: "in darker areas it is very flickering" AT REST — the dark
 * pixels are where relative variance is largest, and the still floor is the
 * variance dial (÷2.9 more at 0.02, the table above). The LIGHT_STEP arm is
 * the regression gate for the trade this reverses.
 */
export const TEMPORAL_ALPHA_STILL = 0.02;

/**
 * The motion at which the α ramp saturates at TEMPORAL_ALPHA — derived from
 * the light-shadow chain's own saturation ((0.94 − 0.86)/30 in its hist-weight
 * formula), so "moving" means the same thing to both temporal memories. In the
 * signal's units: ~0.0027 rad of light swing, an emitter retain of 1, or a
 * ~5.3 cm/frame mover translation.
 */
export const ALPHA_MOTION_SAT = (0.94 - 0.86) / 30;

/**
 * ⭐⭐⭐ THE LIGHT-MOTION SIGNAL'S RELEASE, AND WHY IT IS A PEAK HOLD
 * (2026-09-04, §11.21).
 *
 * GISystem measures light motion as the change in a light's matrix between two
 * RENDERED frames, then normalises it by the frame time (see that loop's
 * banner). Normalising fixes the SCALE; it does not fix the GAPS. The matrix is
 * written by a script whose tick is not the GI tick, so on some frames the
 * delta is zero and on the next it is two frames' worth — and a zero frame is
 * indistinguishable, to every consumer, from a light that stopped.
 *
 * Measured live in the user's own play session, on a sun turning at a smooth
 * sinusoidal rate (`profile.flicker`'s `lightMotion` dial, in units of the
 * tracking window's own 0.5 threshold): **median 0.337, maximum 3.451** — an
 * 11× spread on a light whose angular velocity barely changes across the
 * window. That spread is what walks the signal back and forth across the arm
 * threshold, and §12.83's simulation of the same straddle assumed ±12 %.
 *
 * So the rate is peak-held with an exponential release: a genuine light STEP
 * passes in the frame it happens (an average would lag it by a whole time
 * constant — the thing §12.38.3 was built to stop), and the zeros between two
 * script writes are filled instead of read as stillness. 100 ms is ~6 frames at
 * 60 fps and ~12 at 120: long enough to bridge any plausible script cadence,
 * short enough that a light which really stops is reported still within a tenth
 * of a second. `__giLightMotionRate = false` restores the raw per-frame delta.
 */
export const LIGHT_MOTION_RELEASE_MS = 100;

/**
 * ⭐⭐ §11.21 THE NOVELTY GATE — §12.83'S DESIGN, SHIPPED.
 *
 * §12.83 wrote this mechanism out in full, then declined to build it: a
 * simulation put the tracking window's straddle at ~1 % of frames, and "inert
 * complexity in the arming path is how this window got two conflicting stories
 * in the first place". The live measurement says otherwise. In the user's play
 * session the window's own dial reads **median 0.517, open on more than half
 * of the frames where the camera was not moving**, and turning the window off
 * outright cut per-pixel reversals 5.1× and the p95 one-frame step 5.2×
 * (`profile.flicker`, two matched pairs, plan §11.21).
 *
 * The argument §12.83 made is still exactly right, so it is the argument that
 * ships: **a light EVENT is not "fast", it is FASTER THAN THIS LIGHT HAS
 * BEEN.** Each term keeps a slow EMA of itself and arms only when it clears
 * `max(ALPHA_TRACK_THRESHOLD, NOVELTY × its own baseline)`.
 *
 *   · a steadily rotating sun: term ≈ its own baseline ⇒ never novel ⇒ the
 *     window stays shut, and responsiveness falls back to the m-driven α ramp,
 *     which §12.46 said should own sustained motion all along;
 *   · a sun that STARTS moving, a teleport, a scrub: baseline low ⇒ arms;
 *   · a lamp toggling mid-day-cycle: the baselines are PER TERM, so the sun's
 *     raised shadow baseline cannot deafen the luminance term. That is why it
 *     is three baselines and not one.
 *
 * The EMA is fed the UNCLAMPED term — `mLight`'s clamp to 1 would saturate a
 * rotating sun and a teleport to the same number, and a teleport during a day
 * cycle would then not be novel either. `__giSrcTrackNovelty = false` restores
 * the absolute-threshold-only arm.
 */
export const TRACK_BASELINE_MS = 1000;
export const TRACK_NOVELTY = 2.5;

/**
 * ══ THE REST CADENCE — FEWER RAYS WHEN NOTHING NEEDS THEM (§12.61) ══════════
 *
 * The §12.57 attribution named the SRC chain's cost pole and the cost-probe
 * fit put a number on it: `deposit ms ≈ 3.7 floor + 42.2 ns × rays` — RAYS are
 * 71% of the deposit at ultra, and the ray budget is preset-independent in
 * exactly the way the user's "lower presets don't help" reads. The still floor
 * moving to α 0.02 (§12.60) is what makes a cut affordable: a parked scene now
 * accumulates ~50 frames of evidence, so HALF the rays per frame reach the
 * same steady state with a √2 variance cost that §12.60's ÷2.9 dwarfs.
 *
 * So at REST the transport ceiling scales by this fraction (stride widens, the
 * R2 phase still covers every pixel, the decay's stride ROOT follows the real
 * refresh rate automatically). "Rest" is the same signal family every other
 * responsiveness mechanism already rides — the α motion ramp, the §12.43
 * tracking window, and camera recency — so ANY of scene motion, an open light
 * window, or a recent camera move restores the full budget continuously, and
 * the machinery that made those signals honest (rising-edge arming, peak
 * holds) is inherited rather than re-derived.
 *
 * `__giSrcRestCadence = false` opts out; `__giSrcRestFraction` is the live
 * dial; a pinned `__giSrcTransportRays` is an instrument and is never scaled.
 */
export const REST_TRANSPORT_FRACTION = 0.5;
/** How long after the last camera move the full budget holds (ms). */
export const REST_CAM_HOLD_MS = 600;
/** Full budget for this long after a BUILD — the initial fill from black is
 *  the one convergence the seed cannot prior (no parents exist yet) and the
 *  camera term only buys ~1 s. Fades on the same REST_CAM_FADE_MS ramp. */
export const REST_BOOT_HOLD_MS = 3000;
/** And how long it then FADES back to the rest fraction (ms) — a step in ray
 *  budget on the frame a pan ends would be R1's cliff in miniature. */
export const REST_CAM_FADE_MS = 400;

/**
 * ══ THE CAMERA-SETTLE α FLOOR — RE-EQUILIBRATION, NOT STALENESS (§12.63) ═════
 *
 * ALPHA_STILL's doc says "a camera move stales nothing", and that stays true —
 * no accumulated evidence becomes WRONG when the view turns. But the Sponza
 * pan probes (2026-08-14, `run-gi-sponza-*`) measured the half the rig never
 * showed: the transport is SCREEN-DRIVEN (rays walk out of gbuffer pixels), so
 * the set of surface points feeding each probe is view-dependent, and a pan
 * shifts every probe's estimator equilibrium a little. At α 0.02 the whole
 * field then crawls to its new equilibrium over ~50 frames IN FULL VIEW:
 * post-pan holds measured 2.4 rev/px/s against a 0.155 parked floor (16×),
 * with the churn heatmap UNIFORM over lit content — not the pan's leading
 * edge — and every capacity/cold-start suspect acquitted by the stats dump
 * (hash load 1–2%, noBlock 0, ~30 fresh probes/frame, seed live). The §12.59.3
 * seed still earns its keep at the edges: seed-off measured 3.5 rev/px/s and
 * 4.5× the hot-pixel population on the same holds.
 *
 * So α rides the SAME camera-recency envelope the rest cadence already runs
 * (REST_CAM_HOLD_MS + REST_CAM_FADE_MS): floored at this value while the
 * camera moves and through the hold, fading back to ALPHA_STILL after. 0.05
 * is yesterday's shipped still value — during-pan behaviour returns to what
 * every earlier build showed, it simply stops OUTLIVING the pan by three
 * seconds. Parked scenes never see it (camTerm 0 ⇒ floor = ALPHA_STILL
 * exactly), and the settle window is also the window the rest cadence keeps
 * at full rays, so the faster forgetting is fed rather than starved.
 *
 * `__giSrcCamSettleAlpha = false` opts out (the A/B arm); a number pins the
 * settle floor itself. A pinned `__giSrcAlpha` outranks this like everything
 * else — a pin must mean what the arm that set it meant.
 */
export const CAM_SETTLE_ALPHA = 0.05;

/**
 * ══ THE LIGHT-SETTLE ENVELOPE — THE DEPARTED LIGHT'S GHOST (§12.67) ═════════
 *
 * User report (2026-08-14): "when lights was lighting some surface, and then
 * went away, this surface continue color bleeding and flickering for quite
 * some time after that." Mechanism: the §12.43 light-event window closes on
 * the EVENT cadence, not on re-convergence — the moment it does, tr drops to
 * 0, α returns to ALPHA_STILL and the rest cadence cuts rays, so the stale
 * bounce energy on the previously-lit surfaces decays at the still rate on a
 * REDUCED evidence rate. §12.52 surprise cannot rescue it: an evidence-starved
 * block gets no fresh deposits to disagree with, keeps its ghost until rays
 * revisit, then corrects in sparse blotches — the reported flicker. This is
 * the light-side twin of the §12.63 camera hole, and it takes the same shape:
 * a hold+fade envelope stamped from the LAST FRAME THE WINDOW WAS OPEN,
 * feeding both the α floor (with CAM_SETTLE_ALPHA — one floor, two reasons to
 * be there) and the rest cadence's drive term.
 *
 * LONGER than the camera envelope on purpose: a pan REDISTRIBUTES the
 * estimator (§12.63's doctrine note) while a departed light DELETES energy —
 * the whole multibounce residue has to drain, and it re-deposits through the
 * feedback loop while it does. Hatches: `__giSrcLightSettle = false` (off —
 * the A/B arm), `__giSrcLightSettleHoldMs` / `__giSrcLightSettleFadeMs`
 * (numeric pins).
 */
export const LIGHT_SETTLE_HOLD_MS = 1500;
export const LIGHT_SETTLE_FADE_MS = 800;

/**
 * ══ THE FRESH-PROBE SEED — HOW MUCH A BORROWED PRIOR WEIGHS (§12.59.2) ══════
 *
 * §12.59.1's pan bisect pinned camera-motion flicker on newborn probes
 * converging FROM ZERO in view: every at-rest suspect (cap, surprise, tracking
 * window) measured inside the noise floor, while a 25° pan drove per-pixel step
 * amplitude ~200×, cap-INVARIANT — faster intake cannot hide convergence,
 * only a prior can. `srcSeed.js` writes that prior: a fresh probe's bins start
 * at its parent cascade probe's last-frame MERGED answer, carried at this many
 * rays' worth of fixed-point weight.
 *
 * The number is an EFFECTIVE SAMPLE COUNT, so it has two anchors rather than
 * being taste: §12.13.4's measured 0.78 rays/bin/frame makes 6 rays ≈ 8 frames
 * of evidence, and the steady-state weight under decay is
 * `influx/(1−keep) ≈ 0.78/0.1 ≈ 7.8` rays — seeding just UNDER steady state
 * means a newborn bin is exactly as hard to move as a settled one, never
 * harder. Real local evidence therefore dominates within ~1/α frames, and the
 * decay retires the borrowed weight on the same clock as any other evidence.
 *
 * `__giSrcSeedRays` is the live dial (polled per frame, srcSystem's §12.23
 * rule); `0` zeroes every write and is the in-page A/B arm the flicker
 * instrument quotes. `__giSrcSeed = false` (read once, at build) removes the
 * passes entirely — the only form of "off" that can back a bit-exactness claim.
 */
// 6 → 1 (2026-09-03): the prior is a HINT, not evidence. At weight 6 a fresh
// probe carried its parent's answer (the sky composite — blue with the sky on,
// black with it off) until ~6 of its own deposits had landed, which at stride
// 12 is ~100 frames: the user's soft blobs on every surface the camera turned
// onto. At 1 the first own hit already weighs as much as the prior.
export const SEED_RAYS = 1;
/**
 * §11.16 — THE FAR-FIELD PRIOR (2026-09-03). A fresh bin with NO parent or
 * spatial prior (no parent cell, a cold column, a parent behind a wall, an
 * unknown parent bin, the top cascade) used to start from ZERO and converge
 * in view from its first own ray: the running mean of a handful of samples
 * in random order, which is what "patches flickering while they converge"
 * looks like on every surface a walk or a pan reveals (Sponza walk-in leg:
 * one tile stepped 0.33 luma in one frame 0.8 s after arrival, twice the
 * frame's mean; the error curve ROSE 6× after arrival before settling).
 * Such a bin now starts at the scene's far-field mean — the same constant the
 * resolve already shows for a pixel with no coverage, so the hand-over from
 * "uncovered" to "covered" is continuous — at THIS many rays' weight. With
 * ≈0.78 own rays per bin per frame the first own sample moves the estimate by
 * 1/7 of the gap and each next one by less: a monotone ramp of ≤ ~3 %/frame
 * over ~0.5 s, never a pop. The parent prior stays at SEED_RAYS (its content
 * can be wrong — the sky-composite blobs — so it is a hint, not evidence);
 * the far-field mean cannot be absurd, only flat. `__giSrcSeedFarRays` is the
 * live dial (0 = off arm, in-page).
 *
 * ⛔ MEASURED THE SAME EVENING AND LEFT OPT-IN (`__giSrcSeedFar = true` arms
 * it at build). Sponza walk-in leg, probe:gi-walk, pinned pools, two runs per
 * arm: LIVE scene (the Y Bot animating in the corridor) prior off / on —
 * maxStep 0.163, 0.232 / 0.164, 0.166, err0 0.0076, 0.0015 / 0.0074, 0.0068,
 * and the same non-monotone error curve (a ~1.7 s period — the walk cycle):
 * no effect, because the live-scene transient is the MOVER's, not the
 * newborn probes'. FROZEN scene (character pinned; note FREEZE also parks the
 * day cycle at the boot's phase, a low sun): prior off err0 0.00033, maxStep
 * 0.0019, monotone — the static arrival is already clean — and prior ON made
 * it a slow drift (err0 0.0108, settle > 4 s) with the SETTLED picture 3.5×
 * brighter (0.010 → 0.034 mean luma): a flat scene-mean constant seeded into
 * far bins that get a ray every few frames is not handed over for a minute,
 * and it stands in for unknown far intervals the tiles used to renormalise
 * away. The instrument that made this measurable: srcSystem's readStats now
 * submits every counter readback in ONE tick (the seed's tally used to be
 * read three awaits after the population counters, on a parked frame — "seed
 * 0 probes" while 50 fresh probes were being minted).
 */
export const SEED_RAYS_FAR = 6;

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

/**
 * ⛔ §12.83 — A NOVELTY GATE WAS BUILT HERE AND BACKED OUT THE SAME HOUR. THE
 * PREMISE WAS A MISREAD LOG LINE, AND THE MISREADING IS THE THING WORTH
 * KEEPING (2026-08-23).
 *
 * The live receipt from the user's editor reads
 *
 *     [gi] light-track window: 1 arms in 2.0s (0.5/s), open 60% of 121 frames
 *          — armed by shadow 1, peak 0.53 (threshold 0.5)
 *
 * and "open 60% of frames" was read — here, in `gi-walk-transient`, and in the
 * plan's §12.82 banner ("open 43-58% of frames") — as a STEADY STATE: the
 * window open most of the time, flushing the screen irradiance filter and
 * lifting the ray cap for most of every second of play. That reading is wrong.
 * **The line is a ~2 s TALLY and it is printed ONLY when the window armed or
 * was open during that tally**, so "open 60%" is one 1200 ms hold inside one
 * 2 s span, and the spans in between print NOTHING. On the user's Level those
 * two lines are THREE MINUTES apart with silence between: two arms in ~210 s
 * = a **~1% duty cycle**, not 60%.
 *
 * §12.46's rising-edge arm is therefore doing its job. A simulation of the
 * exact arming block against their own day cycle (0.1 rad/s → a shadow term
 * of 0.52 at 72 fps, straddling the 0.5 threshold) with ±12% frame-rate
 * jitter: 1 arm and 2% open in 60 s. The straddle cannot re-arm because the
 * dips are ONE FRAME long and the dwell wants 800 ms of them.
 *
 * So: do not spend a unit on this window. Its cost is ~1% of frames, and the
 * §12.82 banner's "⭐ (3) is the next unit" rests on the same misreading and
 * is withdrawn. ⚠ The general trap: a periodic tally that suppresses its own
 * empty prints reads as a duty cycle and is a RATE — check the timestamps
 * between lines before believing a percentage.
 *
 * ── the original design, kept because the hole is real if narrow ───────────
 *
 * §12.46 (above) established the intent in as many words: *sustained motion
 * needs no window*. Its instrument was a RISING EDGE against a fixed absolute
 * threshold, and that instrument only works when the sustained signal sits
 * clearly above the threshold — then the edge never re-fires.
 *
 * IT DOES NOT WORK WHEN THE SIGNAL STRADDLES THE THRESHOLD, and the user's own
 * Level does exactly that. A day cycle at 0.1 rad/s puts `shadowMotion /
 * ALPHA_MOTION_SAT` at ~0.62 at 60 fps and ~0.37 at 100 fps — so ordinary frame-
 * rate jitter walks the peak back and forth across 0.5, each dip clears the
 * 800 ms dwell, and the next rise arms a fresh 1200 ms window. The live receipt
 * from the user's editor, twice, minutes apart:
 *
 *     [gi] light-track window: 1 arms in 2.0s (0.5/s), open 60% of 121 frames
 *          — armed by shadow 1, peak 0.53 (threshold 0.5)
 *
 * i.e. the window is open **~60% of every second of play** for a sun that is
 * doing nothing eventful. What that costs, all three at once:
 *
 *   · `_giIrrHistWeightU = 0` (GISystem ~2262) — the §12.65 screen irradiance
 *     temporal filter is FLUSHED, so the raw gather goes to the screen and the
 *     c0 probe lattice's own per-probe variance is the picture. At s₀ = 0.45 m
 *     that is a ~0.45 m tent on every surface — the user's "blockiness in the
 *     darker, further regions", where the relative variance is largest because
 *     the mean is smallest (this scene has NO environment: every photon is a
 *     lamp and a bounce);
 *   · the §12.43 root relaxes — evidence is no longer preserved across the
 *     sparse refresh, so at stride 5 the effective sample count per probe falls
 *     from ~250 frames to ~20. √12 ≈ 3.5× more noise, on the same lattice;
 *   · the per-probe ray cap lifts to OFF — the 3.8× deposit swing §12.45
 *     priced, paid for 60% of frames.
 *
 * THE FIX IS TO ASK A DIFFERENT QUESTION. A light EVENT is not "fast" — it is
 * FASTER THAN THIS LIGHT HAS BEEN. So each term keeps a slow EMA of itself and
 * arms only when it clears `max(threshold, NOVELTY × its own baseline)`.
 *
 *   · a steadily rotating sun: term ≈ its own EMA ⇒ never novel ⇒ window shut,
 *     and responsiveness falls back to the m-driven α ramp, which is what
 *     §12.46 said should own this case all along;
 *   · a sun that STARTS moving, a teleport, a scrub: EMA is low ⇒ arms;
 *   · a lamp toggling mid-day-cycle: the EMA is PER TERM, so the sun's raised
 *     shadow baseline cannot mask a luminance event. This is why it is three
 *     baselines and not one — a single EMA over the max would have made the
 *     day cycle deaf to every other light in the scene.
 *
 * The EMA is fed the UNCLAMPED term (the clamp to 1 that `mLight` applies would
 * saturate a rotating sun and a teleport to the same number, and then a
 * teleport during a day cycle would not be novel either).
 *
 * NOT SHIPPED. It would close the straddle if a slower ease ever put the dips
 * past the 800 ms dwell (the ping-pong endpoints in §12.46's ledger are ~0.6 s
 * — closer than is comfortable), but on the measured configuration it is a
 * NO-OP, and inert complexity in the arming path is how this window got two
 * conflicting stories in the first place.
 */

/** Frames a probe survives unseen before the per-frame rebuild stops re-inserting it. */
export const PROBE_MAX_AGE = 60;

/**
 * Albedo ceiling inside the bounce loop. R4: the secondary cache is a temporal
 * fixed-point iteration, so its in-loop gain must be provably < 1. Artistic
 * gain belongs OUTSIDE the loop (the `intensity` prop), never here.
 */
export const MAX_LOOP_ALBEDO = 0.9;

/**
 * The ceiling the build actually uses: `__giSrcLoopAlbedo` (0 < x ≤ 1)
 * overrides `MAX_LOOP_ALBEDO` at kernel build — an A/B dial for the
 * near-white enclosure case (2026-09-05, the user's Level: every blockout
 * wall and the floor are albedo 1.0, so 0.9 caps the room's series at 10×
 * where the tracer's runs higher). Read at build, like the other hatches;
 * `srcRef.js` keeps the constant, so the fixtures never see the dial.
 */
export function loopAlbedoCeiling() {
  const v = Number(globalThis.__giSrcLoopAlbedo);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : MAX_LOOP_ALBEDO;
}

/**
 * Quality tiers. Unlike the dense backend's tiers these scale s₀, rays/pixel,
 * secondary bounce and ray ceilings — NOT a world volume, because SRC has no
 * volume to scale. Memory is screen-proportional by construction (plan §4.2).
 *
 * `spacing0` is metres at LOD 0. `raysPerPixel` counts full-length rays per
 * half-res gbuffer pixel. `w0` stays at the proven width 4 on every tier.
 *
 * ⚠ DO NOT WIDEN ULTRA TO w0=8 WITHOUT REDESIGNING THE BLOCK POOL. The fixed
 * budget is measured in raw bins, so doubling w0 makes a block 4× larger and
 * cuts Bistro's c0 capacity at the 2.8M ceiling from 21,875 to 5,468 — below
 * its measured 14,273 live probes. That guarantees permanent `noBlock` holes
 * plus extra work. Ultra instead buys finer spatial probes, more transport
 * rays, and a looser per-probe cap without starving the proven pool.
 */
/**
 * ⭐⭐ §11.30 (2026-09-04) — `probeRayCap` 8 ON EVERY TIER and STARVE_PACKETS 8:
 * the ray DISTRIBUTION is the lever, not the total. On the user's Bistro at
 * ultra (12.5 k visible c0 probes, 89 k rays/frame at rest) every c0 probe
 * was flagged starved and a texel knew 3 of its 20 lobe bins (`knownFrac`
 * 0.15) — the near probes took the cap of 32, the street took nothing, and
 * the picture was the extrapolation of three bins: "very blurry and flat".
 * Raising the starvation floor's packets 2 → 8 alone took `knownFrac` to
 * 0.80 at 190 k rays (+18 ms); lowering the cap 32 → 8 with it held 0.80 at
 * **30 k rays** — the SRC chain 48 → 19 ms, 25 → 35 fps at that pose, flicker
 * unchanged, sun-step t50 2.0 → 0.9 s. The corridor ladders read the cap as
 * energy-neutral (sun bounce 0.99–1.11×, the §12.40.4 verdict again). One
 * cap for all tiers: the surplus it denies is the same surplus everywhere.
 */
export const SRC_QUALITY = {
  low: { spacing0: 0.8, raysPerPixel: 1, w0: 4, secondary: false, transportRays: 32_768, probeRayCap: 8 },
  medium: { spacing0: 0.6, raysPerPixel: 1, w0: 4, secondary: true, transportRays: 65_536, probeRayCap: 8 },
  high: { spacing0: 0.45, raysPerPixel: 2, w0: 4, secondary: true, transportRays: 131_072, probeRayCap: 8 },
  // Keep the proven directional width. With the fixed raw-bin budget, w0=8
  // cuts Bistro's c0 block capacity from 21,875 to 5,468 (below its measured
  // 14,273 live probes), causing permanent noBlock checker/rectangle holes.
  ultra: { spacing0: 0.35, raysPerPixel: 2, w0: 4, secondary: true, transportRays: 393_216, probeRayCap: 8 },
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

/**
 * ══ SURPRISE — THE CAP'S ESCAPE HATCH, AND ITS ONE SWITCH ══════════════════
 *
 * The per-probe cap above is a STEADY-STATE budget: a probe whose bins settled
 * long ago does not need 1,794 rays a frame. What it cannot price is a block
 * whose truth just MOVED — a light toggled, a mover crossed the wall behind it
 * — because the cap denies exactly the evidence rate that would let the
 * accumulator follow. §12.45 lifts the cap globally inside the light-event
 * window; this is the per-BLOCK version, driven by the block's own deposits
 * rather than by a scene-wide signal, so an occlusion change no light event can
 * see still gets its evidence.
 *
 * `u` ∈ [0,1] in `SURPRISE_ONE` fixed point, one word per block, is that
 * signal. It reaches two consumers:
 *
 *   DECAY   `keep′ = 1 − (1−keep)·mix(liftedRatio, SURPRISE_F, u)` — a
 *           surprised block forgets FASTER, up to the fast-α rate.
 *   CAP     `u ≥ SURPRISE_CAP_MIN` exempts the block's probe from the cap by
 *           `SURPRISE_CAP_SHIFT` (a SHIFT, so the exempted cap is still a
 *           multiple of raysPerPixel — see [D1']).
 *
 * ⚠ THEY ARE ONE SWITCH, AND THE CODE ENFORCES IT BY CONSTRUCTION. The
 * governor's `surpriseGain` multiplies `u` ONCE, in the publish that writes the
 * word — so both consumers read the same gained number and `gain = 0` means
 * `keep′ == keepCompensated` bit for bit AND no surprise-driven boost. A gain
 * applied at either consumer instead would let "forget faster" and "trace more"
 * drift apart, which is a decay that outruns its own evidence: the exact
 * mechanism §12.45 measured as 36% of the light-update flicker.
 */
export const SURPRISE_ONE = 0x10000;
/**
 * Signed-EMA rate for the drift term. Fast enough to see a step inside the
 * T0→T1 ramp. Raised 0.25 → 0.45 with the ramp raise below: the higher trip
 * point needed the EMA to carry MORE of a step's Δ inside the 6-frame
 * detection window (drift peak scales ~linearly with rate there) while its
 * noise passband only grows as √(r/(2−r)) — detection moved 8σ → inside the
 * gate, noise fires stayed at zero on the fixture.
 */
export const SURPRISE_RATE = 0.45;
/**
 * Shot-noise coefficient: the per-frame standard error of a block's mean is
 * `M·sqrt(K/n)` for `n` deposits. K is empirical (§12.13.4's 0.78 rays/bin
 * against the bin-count spread), not a physical constant — it sets what counts
 * as "one σ" and therefore where the T0/T1 ramp begins.
 */
export const SURPRISE_SHOT_K = 0.143;
/**
 * Ramp ends, in σ. Below T0 nothing is surprising; at T1 the block is fully
 * surprised.
 *
 * RAISED 2/4 → 3.5/7 (2026-08-13). The shipped 2σ trip point was ~3σ of the
 * TRUE drift spread (the arm measured live noise at 1.78× the shot model —
 * SUM_SHIFT quantization — and the drift EMA's own σ is ~0.38 of the input's),
 * which the fixture priced at 0.11% false fires per block-frame and called
 * absorbed. Live it was not: across thousands of resident blocks that is
 * several noise-fires per frame, each decaying its block at up to the fast α,
 * and the flicker rig's SURPRISE_AB arm (interleaved, in-page) read a PARKED
 * Sponza at 2.784 reversals/px armed vs 1.410 at gain 0 — the detector was
 * manufacturing about half of the still-scene flicker it shipped to localize.
 * 3.5/7 puts the trip at ~5σ of the true drift spread. The ceiling is the
 * temporal fixture's own detection gate: drift peaks at 0.62·Δ while M chases
 * the step, so T0 3.5 opens the ramp at a ~6σ step (gate: ≤ 6 within 6 frames)
 * and T1 6.5 saturates at the fixture's measured 12σ (gate: ≤ 12) — raise either further and (c) fails.
 */
export const SURPRISE_T0 = 3.5;
export const SURPRISE_T1 = 6.5;
/**
 * Noise floor, in units of unit luma — 1/1024, one quantum of the SUM_SCALE the
 * deposits arrive in. Without it a block whose mean is zero has zero noise and
 * every quantum of drift reads as infinite σ.
 */
export const SURPRISE_FLOOR = 1 / 1024;
/**
 * Minimum accumulated evidence before `u` may be nonzero. A block with two
 * deposits of history has no mean to be surprised AGAINST, and letting it
 * surprise would make every sparsely-sampled bin permanently uncapped — the
 * cap's whole win, spent on the blocks that need it least.
 */
export const SURPRISE_MIN_EVIDENCE = 4;
/** `u ≥ 0.5` in word scale — the cap exemption's threshold. */
export const SURPRISE_CAP_MIN = SURPRISE_ONE >> 1;
/** ×2. The cap exemption is a SHIFT so the exempted cap stays a multiple of raysPerPixel. */
export const SURPRISE_CAP_SHIFT = 1;
/**
 * How long a freshly claimed block counts as COLD — exempt from the cap by
 * `COLD_CAP_SHIFT` (×4), and barred from surprising (it has no mean yet).
 *
 * A newborn block's accumulators are zero, so its first frames ARE its estimate
 * — and the cap's steady-state argument does not apply to a block that has no
 * steady state. Four frames at ×4 is one capped probe's worth of extra rays,
 * paid once per block rather than per frame.
 */
export const COLD_FILL_FRAMES = 4;
/**
 * ══ §11.17 THE STARVED PROBE — a ray floor that follows EVIDENCE, not age ══
 *
 * Rays are born per PIXEL ([D1]), so a probe's ray rate follows its screen
 * footprint. That is right for cost and wrong for convergence: a far, dark
 * corridor covers a few pixels, its probes see a ray every few frames, and
 * with 32 direction bins each such probe needs MINUTES — the user's "patches
 * of wrong lighting all over the dark corridors that take too long to
 * resolve, or don't resolve until the camera moves closer" (2026-09-03,
 * Sponza aisle capture). The cold-frontier priority above already reserves a
 * packet for a probe born within COLD_FILL_FRAMES; this extends the same
 * reservation to any VISIBLE c0 probe whose block carries less than
 * STARVE_DEPOSITS of decayed deposit weight — starvation measured by the
 * probe's own accumulator, so a young probe that happened to get rays drops
 * out at once and an old, retained probe that never had any stays in. A
 * starved probe takes STARVE_PACKETS packets (× raysPerPixel rays) a frame
 * from the same ceiling tickets, fired from its representative pixel in
 * successive ray slots (distinct directions); the cap boost still applies.
 * The evidence is the c0 block's decayed BIN_COUNT summed over its bins —
 * "rays this probe has seen", forgetting at the keep — so at the still keep
 * (0.9977) a probe fed r rays a frame settles near 435·r. STARVE_RAYS 2000
 * therefore means: a probe whose own pixels bring under ~4.6 rays a frame
 * is topped up (2 packets = 4 rays at 2/px) — permanently below ~0.6, on a
 * duty cycle between — and a probe the camera already feeds is never
 * touched. ⚠ The first cut tested the surprise bundle's BSTAT_SUM_W, which
 * is a PER-FRAME sum, and lifted every visible probe (strided A/B: zero-ray
 * share 22 → 0 %, but "lifted" = all 1292 visible). `__giSrcStarvePackets`
 * (0 = off arm) and `__giSrcStarveRays` are the live dials;
 * `__giSrcStarve = false` removes the branch at build.
 */
export const STARVE_PACKETS = 8;
/**
 * §11.31 — THE FLOOR'S SHARE OF THE CEILING. The starvation floor claims its
 * packets from its OWN dispenser bounded to this fraction of the frame's ray
 * ceiling, and the winners rotate per frame. Without the bound, 8 packets on
 * a COLD field (every visible probe starved — 15.7 k on the user's Bistro
 * after an editor restart) reserved 250 k rays against a 196 k ceiling, the
 * DENIED claims still bumped the shared ticket counter, every pixel claim
 * behind them was refused, and the transport ran at 0 rays/frame forever:
 * a probe that gets no rays stays starved. The old 2 packets could not reach
 * it (50 k); 8 can, so the floor is budgeted.
 */
export const STARVE_SHARE = 0.5;
export const STARVE_RAYS = 2000;
export const COLD_CAP_SHIFT = 2;
/**
 * Frames after a re-anchor (or a system build) during which NOTHING boosts.
 *
 * A re-anchor re-keys every probe, so every block is claimed on the same frame
 * and every one of them would be COLD at once — the cold fill would multiply
 * the whole frame's ray budget by four on precisely the frame that already
 * rebuilt the lattice. The guard is not a quality dial; it is the difference
 * between a cold fill and a periodic 4× cost spike whenever the camera walks.
 */
export const COLD_GUARD_FRAMES = 8;

/**
 * The per-block statistics record, in the bin store's `scratch` tail
 * (`createSrcBinStore`'s `blockStatBase`). Five words, and the split is by
 * WRITER, not by meaning:
 *
 *   SUM_L/SUM_W  u32 fixed point, `atomicAdd`ed by [E] from many threads.
 *   ACC_L/ACC_W/DRIFT  f32 bits (`floatBitsToUint`), read-modify-written by the
 *                      ONE thread that owns the block in the [D1''] publish.
 *
 * A single-writer f32 cannot be an atomicAdd target and a many-writer sum
 * cannot be an f32 — that is the whole reason for two kinds of word in one
 * record.
 */
export const BSTAT_SUM_L = 0;
export const BSTAT_SUM_W = 1;
export const BSTAT_ACC_L = 2;
export const BSTAT_ACC_W = 3;
export const BSTAT_DRIFT = 4;
export const BSTAT_WORDS = 5;
/**
 * [E]'s deposits are shifted right by `SUM_SHIFT` before they are summed, and
 * the shift is sized by an OVERFLOW, not by precision.
 *
 * A top-cascade block can take an entire frame's deposits — 126,381 of them on
 * the §12.32.1 measurement — and one deposit's luma is up to `DEPOSIT_SCALE`
 * (65,536). Unshifted that is 8.3e9, past u32's 4.29e9: the sum WRAPS, and a
 * wrapped mean reads as a giant drift, i.e. permanent surprise on exactly the
 * busiest block. Shifted by 10 the same frame sums to 8.1e6 — 500× of headroom.
 * The cost is that each deposit's luma quantizes to 1/1024 of full scale, which
 * is under the `SURPRISE_FLOOR` the σ estimate already carries.
 *
 * `SUM_SCALE` is derived from the shift rather than written twice: the mirror
 * divides where the kernel shifts, and two constants that must be powers of the
 * same two is a drift waiting to happen.
 */
export const SUM_SHIFT = 10;
export const SUM_SCALE = 1 << SUM_SHIFT;

/**
 * The governor's band on the scene-motion term: `surpriseGain =
 * 1 − smoothstep(GOV_LO, GOV_HI, mLight)`.
 *
 * Surprise and the global light-event window (§12.45) solve the SAME problem,
 * and both firing at once means a block pays for uncapped evidence twice while
 * the window's relaxed root is already decaying at the fast rate. So the
 * per-block mechanism fades out exactly as the scene-wide one fades in.
 */
export const GOV_LO = 0.3;
export const GOV_HI = 0.8;

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
 *
 * ══ RE-MEASURED 2026-08-17 ON BISTRO, AND IT WAS TOO SMALL ════════════════
 *
 * The counter did its job and the number above was the one that was wrong. A
 * CITY STREET is not a Sponza-class interior: the user's Bistro runs **14,273
 * live c0 probes** against the 10,937 blocks 1.4 M buys, so ~3,300 c0 probes
 * are permanently blockless — alive, keyed, ray-budgeted, with nowhere to
 * deposit — and the deposit-side counter read `noBlock 37255` PER FRAME.
 * c1/c2/c3 were starved by the same ~1.3× (live 3788/1006/279 against
 * 2734/683/170). This is the user's **moving black patches**: which probes
 * win a block is birth order, so every camera move reshuffles the losers and
 * the dark cells crawl over the surfaces.
 *
 * ⚠ THE GROW PATH MADE IT WORSE, AND THAT IS THE PART TO REMEMBER. Slot
 * pressure doubled `c0Probes` 16384→32768 while `binBudget` was already
 * pinned at this ceiling (the log line reads `binBudget 1400000→1400000`),
 * so the rebuild bought MORE probes to share the SAME 10,937 blocks. A
 * bigger slot pool with a capped bin pool is strictly more black.
 *
 * 2.8 M bins ≈ 100 MB, which still clears the 128 MiB binding limit that
 * killed the old capacity-addressed sizing, and buys 21,875 c0 blocks —
 * above the measured 14,273 with room for the slot pool's next double. Both
 * pools remain FLOORS-first (`SRC_POOL_FLOORS.binBudget` is still 700 k), so
 * a scene that does not ask pays nothing; this is only where growth stops.
 */
/**
 * §10.8 (2026-09-03) — IS THE SUN SPLIT ARMED? IT SIZES EVERY BIN.
 *
 * `__giSrcSunSplit` is OPT-IN and has been since §12.82 shipped it ("OFF
 * (default - arm with __giSrcSunSplit = true)" on every boot). Read here, not
 * in srcDeposit, because it decides `BIN_WORDS` and `BIN_WORDS` decides
 * `BIN_BUDGET`, and a budget computed from a layout it does not know about is
 * the leak this file's header warns about.
 *
 * A BUILD-TIME read, evaluated once at module load like every other `__gi`
 * layout hatch: flipping it needs a page reload, which is what `profile.giFlag`
 * persists flags for.
 */
export function sunSplitArmed() {
  // ⭐⭐⭐ DEFAULT ON since 2026-09-04 (§11.21). It was opt-in because its
  // bin-level delivery was short — srcSystem carried "removes 46-57 % of the
  // picture, returns 5-24 %". THAT VERDICT WAS STALE: the defect behind it was
  // the decay pass round-tripping the packed normal through a `select`, which
  // zeroed the word every frame (srcDeposit's BIN_SN note carries the full
  // story), and fixing that took the normal ratio 9 % -> 52-63 % without
  // anybody re-running the delivery measurement.
  //
  // Re-measured on Sponza, sun pinned, camera parked, character hidden, four
  // arms in one run (`probe:gi-walk PARK=1`): tail mean luma base 0.17939,
  // split 0.17308 (96.5 %), `sunsplitkeep` 0.20360 — so the transfer returns
  // 0.0242 of the 0.0305 it removes, 79 %, for a picture at 96.5 % of baseline
  // rather than the 46-57 % loss on record. `sunsplitflatcos` (cosine forced
  // to 1) read 0.17408, i.e. within 0.6 % of the honest close: the cached
  // NORMAL is not where the residual goes — the 27 % of lit bins that carry no
  // normal at all is.
  //
  // ⚠ THE PRICE, STATED: nine words per bin instead of five. `srcBinCeiling`
  // already divides by `BIN_WORDS`, so a device scales its bin pool down
  // instead of failing — but on a portable 128 MiB binding that is ~6.7 M bins
  // to ~3.7 M, and §10.7's starvation (`noBlock`, the black patches) is what
  // too few bins looks like. On a desktop reporting 1024 MB per binding the
  // ceiling stays pinned at BIN_CEILING_MAX and nothing shrinks.
  //
  // ⛔⛔ **BACK TO OPT-IN, 2026-09-04, ON THE USER'S REPORT.** §11.22 shipped
  // this default-on with a delivery receipt (96.5 % of baseline luma at a
  // PINNED sun) and a flicker receipt (churn 99.6 % → 13.8 %). Both were true
  // and both were beside the point: the user's next look was *"it got a lot
  // worse. Flickers a lot + when light moves, lighting does not update."*
  //
  // ⭐ THE MISSING GATE, NAMED SO IT IS NOT MISSED AGAIN: every measurement
  // this session scored STABILITY, and a field that has stopped tracking the
  // sun is perfectly stable. `profile.flicker` cannot tell "converged" from
  // "frozen", the pinned-sun delivery arm cannot see tracking at all, and the
  // two together will happily certify a picture that never updates. A light
  // change needs its own receipt — time for the picture to follow a moving sun
  // — and until that exists, nothing here may ship on a stability number.
  //
  // The mechanism is §12.82's own caveat, which this session under-weighted:
  // the cached transfer is `ρ/π · V`, and **V is VISIBILITY — it is not
  // sun-independent**. A rotating sun re-shadows the whole scene, and that half
  // only refreshes when new rays land in the bin. The split makes the COSINE
  // and the irradiance free; it does not make the shadow free.
  //
  // `__giSrcSunSplit = true` arms it for measurement.
  return globalThis.__giSrcSunSplit === true;
}

/** rgb + clear-weight + total-weight: the words EVERY build writes. */
export const BIN_WORDS_BASE = 5;
/** ...plus §12.82's sun transfer (3) and packed hit normal (1). */
export const BIN_WORDS_SPLIT = 9;

/**
 * ⭐⭐ §10.8 — THE BIN LAYOUT FOLLOWS THE BUILD, AND THAT IS 44 % OF THE
 * LARGEST ALLOCATION IN THE MODULE.
 *
 * `BIN_SR/SG/SB/SN` (words 5..8) exist for the sun split. Both their writes
 * (`srcSecondary`'s `if (sunTransfer)`) and their reads (`srcDeposit`'s
 * resolve, `if (sunClose)`) are JS build-time guards on the same opt-in flag —
 * so on the DEFAULT path every scene allocated four words per bin that nothing
 * ever touched. On the user's Bistro that is 44.8 MB of a 100.8 MB `scratch`
 * buffer, in the one allocation that is up against the 128 MiB storage-buffer
 * binding limit, while cascade 0 was refusing 10 774 probe inserts a frame for
 * want of bin blocks (plan §10.7 — the black patches).
 *
 * `createSrcBinStore` throws if a build asks for the sun words without them,
 * so the layout and its two guards cannot drift apart silently.
 */
export const BIN_WORDS = sunSplitArmed() ? BIN_WORDS_SPLIT : BIN_WORDS_BASE;

/**
 * ⭐ AND THE FREED BYTES ARE SPENT ON PROBES, not returned.
 *
 * The ceiling was never a bin count, it was ~101 MB of `scratch` (2.8 M x 9
 * words x 4 B) against the 128 MiB binding limit, with [J]'s hit list and the
 * per-block statistics riding the same buffer. At five words the same class of
 * footprint holds far more bins; 4.5 M is that, kept deliberately short of the
 * arithmetic maximum so the hit list (~25 MB at the shipping ray budget) keeps
 * its headroom and `createSrcBinStore`'s throw stays a backstop rather than a
 * tripwire.
 *
 * What it buys, which is the whole point: `blockCapacities` splits the budget
 * four ways, so cascade 0's blocks go 2.8M/4/32 = 21 875 -> 4.5M/4/32 = 35 156,
 * a 61 % larger backed lattice against a walk demand of ~43 500. With the
 * §10.7 coarse fallback catching what is still short, the starvation that
 * painted the patches is covered from both ends.
 *
 * ARMED, this is 2 800 000 exactly — the split arm is byte-for-byte the build
 * every §12.82 measurement was taken on.
 */
export const BIN_BUDGET = sunSplitArmed() ? 2_800_000 : 4_500_000;
/** Floor per cascade, so a one-cascade or tiny-w₀ configuration is not degenerate. */
export const MIN_BLOCKS = 64;

/**
 * Words per bin in the RESOLVED payload — three u32 of packed binary16 halves
 * (rgb + T, then confidence + a spare half), plan §11.4 A1 + §11.25. Owned here beside `BIN_WORDS` for the same reason
 * that one is: it sizes a budget (`srcBinCeiling`), and a budget computed from
 * a layout it does not know about is the leak this file's header warns about.
 * `srcDeposit.js` re-exports it and owns the accessors.
 */
export const PAYLOAD_WORDS = 3;

/**
 * ══ UNIT 1 — NO BIN IS EVER UNKNOWN (2026-09-04, plan §11.25) ═══════════════
 *
 * The resolved payload's third word carries CONFIDENCE: how much of a bin's
 * value is its own measurement, as opposed to the prior it is shrunk toward.
 *
 *     c = N / (N + CONFIDENCE_PRIOR_RAYS)      N = rays of accumulated weight
 *
 * i.e. the posterior mean with K pseudo-observations of the prior — one ray
 * is worth 1/(1+K) of the answer, K rays half of it, and there is no count at
 * which anything SWITCHES. That is the whole point. The estimator this
 * replaces had a binary threshold (`MIN_WEIGHT`, a sixty-fourth of a ray)
 * below which a bin was UNKNOWN and above which it voted with FULL weight in
 * the tile's lobe average — so a freshly-hit bin in a sparse lobe flipped its
 * texel to a one-ray radiance in a single frame, and in a dark corridor that
 * flip is 128 % of the image mean (§11.24: α 0.02 cannot produce a step that
 * size; only a membership switch can).
 *
 * Where confidence is spent: the MERGE shrinks a low-confidence bin toward
 * "empty near interval, look through me" (`L=0, T=1`) before compositing the
 * parent, so the coarser cascade stands in until the fine one has evidence;
 * the TILES weight each bin's vote by `cw·c` so a bin fades into the lobe as
 * its evidence accumulates; and a parent-filled bin carries the parent's
 * confidence discounted by `PARENT_FILL_CONFIDENCE`, so the fallback is
 * present but never dominant.
 *
 * `__giSrcConfidence = false` pins c ≡ 1 for every known bin — bit-identical
 * to the previous estimator, the A/B arm and the safety hatch.
 */
/**
 * K = 16, measured (2026-09-04, the user's own corridor view, plan §11.25):
 *
 *   arrival, first 5 s      churn     p95 step / mean   max step
 *   old estimator           12.9 %    0.41              7.3
 *   K = 4                   54.3 %    0.76              3.9   ← WORSE
 *   K = 16                   0.16 %   0.12              2.7
 *   at rest afterwards       0.0 %    0.017             0.045 (old: 0.9 % / 0.135 / 2.17)
 *
 * A 1–4-ray mean in a dark corridor is a coin toss, and K = 4 let it vote
 * 20–50 % of the lobe; at K = 16 one ray is 6 % and the parent carries the
 * first dozen frames. The trade, measured by `profile.lightResponse` at the
 * same view: a 25° sun step now settles in t50 2.4 s / t90 5.3 s (97 %
 * monotone) against the old estimator's 0.7 / 2.8 s — because a light change
 * makes the field FORGET (§12.74's root), the counts collapse, confidence
 * collapses with them and sparse bins lean on the coarse parent, which is the
 * smooth branch rather than the fast one. In the well-sampled nave the same
 * step got FASTER (t90 3.6 → 1.7 s). Unit 3 owns that interaction.
 */
export const CONFIDENCE_PRIOR_RAYS = 16;
export const PARENT_FILL_CONFIDENCE = 0.5;
export function confidenceArmed() {
  return globalThis.__giSrcConfidence !== false;
}
/**
 * K, read at KERNEL BUILD (GPU) and at call time (twins): `__giSrcConfidenceK`
 * overrides `CONFIDENCE_PRIOR_RAYS` so an A/B is a `profile.giFlag` rebuild
 * (~75 s) rather than an editor reload. The first live A/B at the user's
 * corridor view (§11.25) read K = 4 as WORSE on arrival — churn 12.9 % → 54.3 %,
 * reversals 4× — because a 1–4-ray mean in a dark corridor is not an estimate,
 * it is a coin toss, and 20–50 % of a coin toss in the lobe average is churn.
 * Converged bins carry N ≈ 400 rays (keep 0.9993), so K only shapes the
 * FADE-IN of fresh bins and cannot slow a converged bin's light response.
 */
/**
 * §11.26 (Unit 1b) — a bin with NO parent to look through (an orphan, or any
 * bin of the top cascade) is shrunk toward the far-field mean, the prior of
 * last resort, instead of keeping its own unshrunk value. The user's "first
 * time I see the corridor it flickers; a revisit is stable": a cold column's
 * parents are as new as the child, so Unit 1's parent shrink had nothing to
 * shrink toward and the orphan branch handed the tile a one-ray value.
 * `__giSrcFarPrior = false` restores the orphan-keeps-own behaviour.
 */
/**
 * §11.27 (Unit 1d) — directional inpainting of unsampled bins. A bin whose
 * confidence is below INPAINT_LOW (fewer than ~4 rays at K = 16) takes the
 * confidence-weighted mean of its angular neighbours on the 2w×w direction
 * grid that ARE confident, blended by `c / INPAINT_LOW`, and carries their
 * confidence × INPAINT_DISCOUNT. The tile bake then extrapolates along the
 * sphere's own structure instead of from the lobe mean — dark into a crevice,
 * bright beside a sun patch — which is the enclosure leak's named cause
 * (`srcTiles`: "renormalised over the KNOWN bins, which is unbiased only if
 * those bins are a random subset of the lobe; they are not").
 * ⛔⛔ REFUTED THE SAME HOUR, BY THE GATE IT WAS BUILT FOR. Enclosure ladder:
 * open 0.90x, enclosed **1.52x** (baseline 0.89x / 1.44x) — the leak got
 * slightly WORSE, and `test:gi-src-merge`/`tiles`/`gather` went red (the pass
 * writes bins the merge gate requires to stay unknown, and the GPU pass and
 * the twin do not agree texel-for-texel). The angular neighbours of a crevice
 * direction that no ray reached are the directions rays DID reach — the ones
 * that escaped — so "inherit the neighbours" is the lobe mean by another road.
 * An unsampled direction has no valid stand-in; it has to be SAMPLED (Unit 2:
 * rays per probe over a full deterministic direction set, so `knownFrac`
 * leaves 0.51). Kept OPT-IN as the record of the attempt:
 * `__giSrcInpaint = true` arms it.
 */
export const INPAINT_LOW = 0.2;
export const INPAINT_DISCOUNT = 0.5;
export function inpaintArmed() {
  return globalThis.__giSrcInpaint === true;
}

/**
 * ══ §11.28 THE 45° BIN LIES ABOUT WHERE THE SKY IS — the radiance centroid ══
 *
 * The tile bake integrates `Σ (L + T·sky)·cw` with ONE value per bin and the
 * bin's WHOLE cosine mass `cw`. Inside a 45° c0 bin the sky escapes only at
 * the top of an enclosure — where a wall's cosine is smallest — so the bin's
 * mean applied to the bin's mean cosine over-counts the sky exactly where the
 * enclosure is tightest. The corridor ladder measured it as 1.44× too much
 * light per unit truth in the corners (invariant to rays, to interval length
 * and to coverage — §11.28 refuted all three); a numerical twin of the bake
 * predicted its shape to the row (1.04× / 1.15× / 1.40× wall high/mid/low).
 *
 * The fix carries each bin's RADIANCE CENTROID — the luminance-weighted mean
 * direction of what the bin holds — in the payload's spare half. The resolve
 * writes "the bin's centre" (no sub-bin information); the merge's 4→1
 * pre-average computes the centroid from its four FINER children, so a c0 bin
 * inherits the top cascade's 5.6° knowledge of where the sky is; the bake then
 * spends the bin's cosine at the centroid instead of at the centre. Cosine is
 * LINEAR in direction, so for a bin inside the hemisphere this is exact for
 * any distribution of radiance inside the bin. `__giSrcCentroid = false`
 * reverts: the merge writes no centroid and the bake reads none.
 */
export function centroidArmed() {
  return globalThis.__giSrcCentroid !== false;
}

export function farPriorArmed() {
  return globalThis.__giSrcFarPrior !== false;
}

export function confidencePriorRays() {
  const k = Number(globalThis.__giSrcConfidenceK);
  return Number.isFinite(k) && k > 0 ? k : CONFIDENCE_PRIOR_RAYS;
}

/**
 * ══ §11.29 THE PRIOR MUST LET GO — the confidence's evidence collapse ═══════
 *
 * `c = N/(N+K)` keeps `K/(N+K)` of the prior FOREVER: a bin fed 150 rays is
 * still 10 % "look through me" in the merge (`T′ = 1 − c + c·T`), and in an
 * enclosure the parent it looks through to is the SKY in a direction the bin
 * MEASURED as blocked. That is an energy leak of `(1 − c)` × the blocked sky
 * at the level where the blocking happens — at V 0.11 a third of the truth
 * (the HDRI corridor ladder: wall low 1.55× with the prior, 1.19× with
 * confidence off). The prior exists for the COLD bin (the first ~20 rays,
 * §11.25's flicker win); nothing about it should survive real evidence.
 *
 * So the prior's weight collapses with evidence: `1 − c = K/(N+K) · e^{−N/F}`
 * with F = CONFIDENCE_FULL_RAYS. At N = 1 that is 0.93 (was 0.94); at N = K
 * 0.39 (was 0.5); at 64 rays 0.07 (was 0.2); at 200 rays 0.003 (was 0.07).
 * The cold-arrival receipts (§11.26, N < 20) are untouched to the first
 * decimal; a converged bin is its own measurement. `__giSrcConfidenceFull`
 * moves F; 0 restores the plain `N/(N+K)`.
 */
export const CONFIDENCE_FULL_RAYS = 64;

export function confidenceFullRays() {
  const f = Number(globalThis.__giSrcConfidenceFull);
  return Number.isFinite(f) && f >= 0 ? f : CONFIDENCE_FULL_RAYS;
}

/**
 * ══ §11.4 A2 — THE CEILING FOLLOWS THE DEVICE, AND BIN_BUDGET IS THE PORTABLE
 * CASE OF IT (2026-09-03) ═══════════════════════════════════════════════════
 *
 * `BIN_BUDGET` above fits ONE storage binding under WebGPU's portable default
 * of 128 MiB. That default is what a phone offers; the user's desktop adapter
 * advertises 2047 MB, `sceneSettings.resolveRendererLimits` already asks it
 * for 1 GiB, and `GISystem` already reads `device.limits` to degrade the field
 * buffer — but the SRC store never looked, so on Bistro cascade 0 rationed
 * 35 156 blocks against ~43 500 wanted on a street sweep while the device had
 * 1.8 GB unasked-for. The retention valve then retired the probes behind the
 * camera to make room, and turning back re-minted them cold: the "dead probes
 * appear black as we rotate" report, plan §11.2.
 *
 * So the ceiling is a FUNCTION of the device limit: the most bins whose
 * `scratch` (BIN_WORDS per bin, plus [J]'s hit list and the per-block
 * statistics, which ride the same buffer — `reserveBytes`) fits one binding,
 * and whose payload fits its own. The grow ladder climbs toward it ON DEMAND
 * only, so a small scene on a big GPU allocates exactly what it did before.
 * `BIN_CEILING_MAX` bounds a runaway: 16 M bins is ~320 MB of scratch and
 * ~128 MB of payload, a 200 k-probe cascade 0 — past that the answer is a
 * coarser lattice, not more memory.
 */
export const BIN_CEILING_MAX = 16_000_000;
/** Headroom left unspent inside a binding, so the constructor's throw stays a backstop. */
const BIN_CEILING_SLACK = 4 * 1024 * 1024;
export function srcBinCeiling({ deviceLimitBytes = 128 * 1024 * 1024, reserveBytes = 0 } = {}) {
  const limit = Number.isFinite(deviceLimitBytes) && deviceLimitBytes > 0
    ? deviceLimitBytes
    : 128 * 1024 * 1024;
  const scratchRoom = Math.max(0, limit - BIN_CEILING_SLACK - Math.max(0, reserveBytes));
  const byScratch = Math.floor(scratchRoom / (BIN_WORDS * 4));
  const byPayload = Math.floor(Math.max(0, limit - BIN_CEILING_SLACK) / (PAYLOAD_WORDS * 4));
  return Math.max(MIN_BLOCKS * CASCADE_COUNT, Math.min(BIN_CEILING_MAX, byScratch, byPayload));
}

/**
 * §11.4 A3 — the per-cascade block vector from measured PEAK demand.
 *
 * `peaks[c]` is the most `(live + noBlock)` probes cascade `c` has wanted at
 * once; `current[c]` is what it holds now (never shrunk — §12.52.2's record-
 * pool starvation is what an unguarded shrink looks like). Each cascade is
 * sized to its OWN peak times `headroom`, rounded up to a growth quantum so a
 * +3 % change never costs a rebuild, floored at the equal split of `floorBudget`
 * (the boot floor, so a cascade nothing has measured yet is not degenerate),
 * capped by its slot count, and the whole vector is scaled down proportionally
 * if the sum would cross `binCeiling`.
 *
 * ⛔ THIS IS NOT §10.8's DEAD END. That proposal re-split a FIXED total by a
 * parked SNAPSHOT of demand — which moves budget away from cascade 0, whose
 * bin demand at rest is the smallest of the four. This sizes every cascade from
 * its own running PEAK and lets the total be their SUM: on a walk cascade 0's
 * 43 500 probes no longer force `max × 4` = 5.6 M bins when c1..c3 want 2.4 M
 * between them. Under equal demand it IS the equal split.
 */
/**
 * Headroom over the measured peak, PER CASCADE — because the cascades cost
 * 32 / 128 / 512 / 2048 bins per probe. Cascade 0 is the visible lattice and
 * cheap per probe, so it doubles (a valve-capped `live` under-reads demand,
 * and a rebuild is the expensive event); cascade 3 is 40 KB per probe and
 * its demand is bounded by the cascade below, so it gets a quarter. The
 * user's walked Bistro under a uniform 2× read 65536/28672/6144/2048 blocks
 * — 13 M bins, 4.2 M of them in 2048 c3 blocks for 802 probes.
 */
export const BLOCK_HEADROOM = [2.0, 1.5, 1.25, 1.25];

/**
 * ── THE CAPACITY LADDER — why a pool size is a RUNG, not a number ──────────
 *
 * Every cascade's `blockCapacity` is baked into the SRC kernels as a WGSL
 * LITERAL: the cascade bin partition (`srcDeposit.js` `lo = info.binBase`,
 * `hi = lo + info.bins * info.blockCapacity`, and the same chain in
 * `srcMerge.js` / `srcSeed.js`), the slot bases, and — through
 * `tileAtlasLayout(info.blockCapacity, …)` — the tile atlas's height, which
 * appears sixteen times per kernel as `… + 0.5 ) / 1448.0`.
 *
 * Chromium keys Dawn's compiled-shader disk cache on the WGSL SOURCE TEXT. So
 * a capacity that is an arbitrary number makes the text arbitrary, and every
 * boot compiles the 200 kB kernels from scratch. Measured 2026-09-12 on the
 * user's Complex scene: two rebuilds inside ONE session produced two modules
 * of identical length (204 682 bytes) differing in 21 lines out of 6 639 —
 * every one of them one of these literals. Across boots it is worse than
 * arbitrary, it RATCHETS: the grow ladder persists what it reached, the next
 * boot starts there and grows from there, so a capacity vector is essentially
 * never seen twice. `DawnWebGPUCache` held 17 MB / 54 entries against a 1 GB
 * cap while one boot created 167 pipelines / 6.2 MB of WGSL — the cache was
 * not evicting, it was never FILLING.
 *
 * The existing per-cascade `quantum` (1024 >> cascade) was aimed at a
 * different target — "a +3 % change never costs a rebuild" — and it is far too
 * fine to make a capacity REPEAT: at cascade 0 it admits ~90 distinct values
 * between 80 k and 93 k blocks, and four separate exits in
 * `blockVectorFromPeaks` bypass it anyway (the `floorBudget` floor, the
 * carried-forward `current`, the slot cap, and the device-ceiling rescale).
 *
 * So capacities snap to a GEOMETRIC ladder: four rungs per octave, i.e. at
 * most a 25 % overshoot, and only a handful of reachable values per scene.
 * Two demands that differ by 4 % now land on the SAME rung and therefore
 * generate the SAME WGSL — 89 088 and 92 672 blocks both become 98 304. After
 * two or three boots a scene's whole ladder is in the disk cache and every
 * boot hits it.
 *
 * The 25 % is bought knowingly: it is bin memory, bounded per cascade, still
 * clamped by `slots[c]` and by the device ceiling below. A pool grow costs a
 * cold field plus a recompile of ~70 kernels, so a coarser ladder ALSO means
 * fewer grows — the memory buys back the thing it costs.
 *
 * ⚠ Pools at or below one fine quantum are returned untouched, so gates and
 * fixtures that run tiny pools (`MIN_BLOCKS` = 64) keep the sizes they assert.
 */
export const BLOCK_RUNGS_PER_OCTAVE = 4;

/**
 * Snap one cascade's block capacity to the nearest ladder rung.
 *
 * Idempotent — a value already on the ladder is returned unchanged, which is
 * what lets a restored pool and a freshly grown one produce the same text.
 *
 * @param {number} blocks
 * @param {number} [cascade]  selects the fine quantum (1024 >> cascade).
 * @param {{down?: boolean}} [options]  `down` floors to the rung instead of
 *   ceiling to it — for the device-ceiling rescale, which must never round UP
 *   past the limit it is enforcing.
 */
export function snapBlockCapacity(blocks, cascade = 0, { down = false } = {}) {
  const v = Math.floor(Number(blocks) || 0);
  const fine = Math.max(16, 1024 >> cascade);
  // ⚠ THE THRESHOLD IS FOUR QUANTA, NOT ONE. Below that the granule IS the
  // fine quantum and the quantum is a large fraction of the value, so the
  // "at most one rung" bound this ladder promises would not hold: at cascade
  // 0 a pool of 1 025 blocks would snap to 2 048, a 100 % overshoot. Small
  // pools are also where the gates and fixtures live (`MIN_BLOCKS` = 64), and
  // they must keep the sizes they assert. Above the threshold the granule is
  // always ≥ a quarter of the value's octave, which is what makes the bound
  // true.
  if (!(v > fine * BLOCK_RUNGS_PER_OCTAVE)) return Math.max(0, v);
  const octave = 2 ** Math.floor(Math.log2(v));
  const granule = Math.max(fine, octave / BLOCK_RUNGS_PER_OCTAVE);
  // `granule < v` always holds here (octave ≤ v and fine < v), so the floor
  // branch can never return zero.
  return (down ? Math.floor(v / granule) : Math.ceil(v / granule)) * granule;
}

export function blockVectorFromPeaks({
  peaks,
  current = null,
  slots,
  floorBudget = 0,
  binCeiling = BIN_BUDGET,
  // A scalar applies to every cascade (the gates' arm); the shipped policy is
  // `BLOCK_HEADROOM` per cascade.
  headroom = null,
  // Per cascade: is the retention valve holding this cascade's population
  // down right now (live ≥ 75 % of its blocks)? A valve-capped `live` UNDER-
  // reads demand — the shed keeps it pinned just under the pool — so a
  // pressed CASCADE 0 asks for at least double the current pool; the coarse
  // cascades take their headroom over the peak only (they are bounded by the
  // level below and cost 4–64× more per probe).
  pressed = null,
  w0 = W0,
}) {
  const n = slots.length;
  const floor = floorBudget > 0 ? blockCapacities(slots, w0, floorBudget) : slots.map(() => MIN_BLOCKS);
  const want = new Array(n);
  let above = Infinity;
  for (let c = 0; c < n; c++) {
    const quantum = Math.max(16, 1024 >> c);
    const h = Number.isFinite(headroom) && headroom > 0 ? headroom : (BLOCK_HEADROOM[c] ?? 1.25);
    // ⛔ THE LADDER IS MONOTONE: every cascade-k probe is some cascade-(k−1)
    // probe's parent, so a cascade can never want more probes than the one
    // below it. Bistro's first ladder read said c3 wanted 2147 against c2's
    // 507 (a `noBlock` transient on the 85-block floor) and allocated 2816
    // c3 blocks = 5.8 M of a 6.7 M-bin store for 113 live probes. Bounded
    // here, by the demand ONE level down, before headroom.
    const peak = Math.min(above, Math.max(0, Number(peaks?.[c]) || 0));
    above = peak;
    const cur = Number(current?.[c]) || 0;
    // A pressed cascade 0 (§11.7) used to ask for 2× its CURRENT pool on top
    // of the 2× headroom over its peak — 38 k live became 88 064 blocks on the
    // user's Bistro (10:14), a 2.3× overshoot on the cheap-but-numerous
    // cascade. The 75 % early warning reads `live` before the valve caps it,
    // so the peak IS the demand and the headroom alone is the ask; `pressed`
    // now only marks the cascade as one that must not fall below its peak.
    const floorAsk = pressed?.[c] && peak > 0 ? Math.ceil(peak / quantum) * quantum : 0;
    const grown = peak > 0 ? Math.max(Math.ceil((peak * h) / quantum) * quantum, floorAsk) : 0;
    // ⭐ SNAP LAST, after every other input has had its say. `quantum` above
    // only shapes `grown`; the floor, the carried-forward `current` and the
    // slot cap all bypass it, and an off-ladder value from ANY of them is a
    // fresh set of WGSL literals and a cold compile of ~70 kernels. See
    // `snapBlockCapacity`. `slots[c]` is a power of two, so clamping to it
    // lands on the ladder too.
    const asked = Math.max(MIN_BLOCKS, floor[c], cur, grown);
    want[c] = Math.min(slots[c], snapBlockCapacity(asked, c));
  }
  const bins = (v) => v.reduce((s, b, c) => s + b * binCount(c, w0), 0);
  const total = bins(want);
  if (total > binCeiling) {
    // ══ AT THE CEILING, HOLD — §10.8's DEAD END, REACHED FROM THE OTHER SIDE ══
    //
    // This function's header warns against "re-splitting a FIXED total by a
    // parked SNAPSHOT of demand — which moves budget away from cascade 0". The
    // unclamped path avoids it by sizing each cascade from its own peak and
    // letting the total be their sum. The rescale below is the same forbidden
    // operation: a fixed total, re-split by demand.
    //
    // It runs away, because a ceiling-clamped pool can never satisfy anybody:
    // `noBlock` stays high every frame, so `peaks` (a running max of
    // `live + noBlock`, persisted across sessions) climbs WITHOUT BOUND, and
    // every climb re-splits the same fixed ceiling by a different ratio.
    // Simulated from the user's own live numbers (2026-09-12), four sessions of
    // +50 % peak against a 16 M-bin ceiling:
    //
    //     65536/28672/10240/1792 → 49152/24576/10240/2048
    //                            → 40960/20480/10240/2560
    //                            → 32768/16384/ 8192/3584
    //
    // Cascade 0 — the lattice the screen actually reads — is HALVED, while
    // cascade 3 (2048 bins per block against c0's 32) doubles on demand nobody
    // can see. And every one of those steps is a different set of baked WGSL
    // literals: a cold compile of ~70 kernels and a field that re-converges
    // from black, for a pool that did not get bigger.
    //
    // So once we already hold a vector that FITS, keep it. At the ceiling there
    // is no growth to be had, and stability is worth more than a re-split that
    // the header already argues is the wrong shape. A genuinely smaller ceiling
    // (a different device, a smaller binding) fails the `bins(held)` test and
    // rescales normally; a shrunken `slots` vector fails the per-cascade test.
    const held = Array.isArray(current) && current.length === n
      ? current.map((b) => Math.floor(Number(b) || 0))
      : null;
    if (
      held
      && held.every((b, c) => Number.isFinite(b) && b >= MIN_BLOCKS && b <= slots[c])
      && bins(held) <= binCeiling
    ) {
      return { blocks: held, bins: bins(held), clamped: true };
    }
    // Over the device: scale every cascade by the same factor rather than
    // starving one of them — the equal-bins-per-cascade shape (§12.13.4) is
    // the one measurement about this hierarchy that holds at every pose.
    const k = binCeiling / total;
    for (let c = 0; c < n; c++) {
      // ⛔ DOWN, not up: this branch exists to get under a hard device limit,
      // so the rung has to be the one BELOW the rescaled value. Rounding up
      // here would re-cross the ceiling the rescale just enforced.
      const scaled = snapBlockCapacity(Math.floor(want[c] * k), c, { down: true });
      want[c] = Math.max(MIN_BLOCKS, Math.min(slots[c], scaled));
    }
  }
  return { blocks: want, bins: bins(want), clamped: total > binCeiling };
}

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
  const r0 = spacing0 * r0OverS0() * (1 << lod);
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
  const r0 = spacing0 * r0OverS0() * (1 << lod);
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
 * §12.90b — LOD 0's REACH IS IN METRES, and `LOD0_REACH` is in CELLS.
 *
 * The constant above is an ANGULAR criterion (s₀/α at α ≈ 1/64 rad), which is
 * why it is expressed in cells — and that is correct while s₀ is a per-tier
 * constant. It stops being correct the moment §12.90 derives s₀ from the scene:
 * refining s₀ 0.45 → 0.35 pulls LOD 0's reach 28.8 m → **22.4 m**, so on the
 * user's 28 m house the far end drops to LOD 1 at 0.70 m spacing — COARSER than
 * the 0.45 m it had before the "improvement". A fix aimed at through-wall leaks
 * would have made "further regions look worse", which is the user's original
 * complaint, arriving by a new route.
 *
 * The same trap as `REANCHOR_CHEBYSHEV` (srcSystem), and the same fix: pin the
 * REACH, let the cell count follow. Holding 28.8 m at s₀ = 0.35 means LOD 0's
 * angular spacing is 1/82 rad — FINER than the 1/64 target, i.e. strictly more
 * quality for the probes the finer lattice was already spending. It is not a
 * violation of the criterion; it is the criterion being over-satisfied.
 *
 * ONE reader, read by BOTH twins (`lodAtDistance` here and in srcMathTsl), or
 * `test:gi-src-math` diffs a scaled GPU against an unscaled CPU. Unset = 1 =
 * the shipped constant exactly.
 */
export function lod0Reach() {
  const k = Number(globalThis.__giLod0ReachScale);
  return LOD0_REACH * (Number.isFinite(k) && k > 0 ? k : 1);
}

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
  const ratio = cheb / Math.max(spacing0 * lod0Reach(), 1e-6);
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
  return spacing0 * lod0Reach() * Math.pow(2, lod);
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
    r0: spacing0 * r0OverS0(),
    reachLod0: cascadeReach(0, spacing0, cascadeCount),
    boundariesLod0: intervalBoundaries(0, spacing0, cascadeCount),
    cascades,
  };
}
