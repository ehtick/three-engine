// SPLIT RADIANCE CASCADES — [E] the split scatter, [F] the resolve.
//
// One ray, traced once, deposited into EVERY cascade of its pixel's ancestor
// chain. That is the "split" in Split Radiance Cascades and it is why no cascade
// ever traces its own rays: the cascades below the hit each learn "this
// direction was clear through my interval", the cascade OWNING the hit learns
// what was there, and nothing above it learns anything at all.
//
// `srcMath.js`'s `splitDeposits` is the mirror and its header carries the rule
// this file must not get wrong:
//
//   d in cascade k  →  cascades 0..k-1 get (L = 0, T = 1)
//                      cascade  k       gets (L = hit radiance, T = 0)
//                      cascades k+1..   get NOTHING
//   a miss          →  every cascade gets (L = 0, T = 1)
//
// **Nothing is deposited above the owning cascade.** The companion guide has
// this wrong; the authors rejected upward extension for bias. And the sky is not
// deposited here either — it composites once at the top of the merge, because a
// per-cascade sky deposit multiplies it by the cascade count.
//
// ══ WHY THE ACCUMULATORS ARE FIXED POINT, AND WHAT F=16 BOUGHT ══════════════
//
// WGSL has no float atomics, so radiance accumulates as `round(L/Lmax · 2^F)`.
// §12.13.4 measured the headroom: bins average **0.78 rays/bin at every
// cascade** (the probes÷4 and bins×4 per level cancel), and F=16 overflows only
// at 65,536 saturated rays in ONE bin — about 84,000× the measured average.
//
// TRANSMITTANCE AND COUNT ARE FIXED POINT TOO — but only since the temporal
// blend, and for a reason that has nothing to do with precision. Every deposit's
// T is exactly 0 or 1, so before Phase 4 `sumT` was an integer count of clear
// deposits and `T = sumT/count` was exact with no scale at all. Then the decay
// arrived, and `floor(1 · 0.9) = 0`: a count of ONE — which at 0.78 rays/bin is
// the common case, not the corner — would drop to zero on the very next frame
// and the bin would go back to UNKNOWN having just been sampled. So both words
// carry `DEPOSIT_F` fractional bits, the same as radiance, and they are no
// longer counts but WEIGHTS. The scale then cancels out of `L = ΣR/Σcount`
// exactly (`toL` is `Lmax/count`, with no `2^F` in it at all), so the resolve
// got simpler rather than more complicated.
//
// ══ THE TEMPORAL BLEND LIVES HERE, NOT ON THE RESOLVED PAYLOAD ══════════════
//
// Plan §4.1 [F] put it on the payload — "temporal blend with resident probe
// history" — and §4.2 sized `binPayload` to match, as "the resolved payload plus
// the pre-averaged cone mirror written by the merge". [G] then merged IN PLACE
// (§12.20.1, worth 22 MB), which means the resolved payload does not survive its
// own frame: by the time the next frame could blend against it, the merge has
// overwritten it with `own + T · parent`.
//
// **Blending the merged payload in place is not merely inelegant, it multiplies
// the parent's light by 1/α.** With `H ← (1−α)H + αS` and then `H ← H + T·P`,
// the fixed point is `H = L + T·P/α` — at α = 0.1 the whole cascade above a
// probe arrives ten times over. The alternative that keeps the plan's placement
// is a second payload buffer, giving back exactly the 22 MB [G] saved.
//
// So the blend moves one stage EARLIER, onto the accumulators, where it is
// better on three counts and worse on none:
//
//   1. **It weights by EVIDENCE.** A payload EMA gives one frame's single ray
//      the same weight as another frame's twenty. Decaying the sums and the
//      count together makes `ΣR/Σcount` an exponentially-weighted mean over
//      RAYS. At §12.13.4's measured 0.78 rays/bin this is the difference
//      between an average and a lottery.
//   2. **It needs no warmup path.** See `TEMPORAL_ALPHA` in srcConfig — a fresh
//      block's sums are zero, so its first frame resolves to that frame's own
//      rays, at full weight, with nothing to crawl up from. R6 for free.
//   3. **α = 1 is the code, not a branch.** `keep = 0` zeroes every word, which
//      is precisely the clear pass this replaced. Single-frame mode — §4.6's
//      quality-gate configuration — is one uniform, and every single-frame gate
//      in the suite is unaffected whatever α is set to, because frame one has no
//      history either way.
//
// It costs a read where the clear only wrote, and one word per bin block (the
// claim stamp, in the probe store's pool buffer) so a reclaimed block starts
// empty instead of inheriting a dead probe's answer.
//
// ══ Lmax IS STILL AN OPEN DECISION, AND THIS FILE MEASURES IT ═══════════════
//
// `Lmax` implies a per-ray CLAMP, and a clamp loses energy at exactly the bright
// hits that matter most. §12.13.4 left the choice (hard clamp vs per-frame
// auto-exposure) deliberately open, to be decided from a measured hit-radiance
// distribution rather than in advance. So the clamp COUNTS itself: `stats`
// carries clamped-deposit and max-observed-radiance counters, which is the
// instrument that decision needs. A clamp that never fires is the evidence for
// keeping it.
//
// ══ WHAT SHADES A HIT — `srcShade.js`, AND STILL NOTHING BY DEFAULT ═════════
//
// `shadeHit` defaults to black, and with it black what survives the resolve is
// TRANSMITTANCE: a receiver lit by transmittance alone against the sky is
// ambient occlusion, which is §7's "AO-like short-range bounce" for Phase 2.
// That was never a placeholder standing in for the real thing — it is the real
// thing with one term zero, which is why it was checkable before this existed.
//
// Phase 5 fills it from `srcShade.js`'s `createSrcHitShader`, whose body is
// `srcRef.js`'s `makeHitShader` line for line. This file stays agnostic about
// what a hit is worth: it takes a `vec3` and a ray index, and everything about
// lights, surfaces, shadow rays and the bounce loop lives on the other side of
// that call. The one thing it does own is the SHADE TALLIES — see
// `createSrcShadeCounters`, which exists so the shader needs no binding of its
// own on the kernel closest to the eight-storage-buffer limit.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.2, §12.13.4, §12.13.5 unit 3.

import {
  Fn,
  Break,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicLoad,
  atomicMax,
  atomicStore,
  float,
  floatBitsToUint,
  floor,
  instanceIndex,
  instancedArray,
  int,
  packHalf2x16,
  select,
  uint,
  unpackHalf2x16,
  vec2,
  vec3,
} from "three/tsl";
import { halfRound, halfUlp, packHalf2, unpackHalf2 } from "./srcMath.js";
import { binPartitionUniforms, blockChainUniforms, capAt } from "./srcCapacityUniforms.js";
import {
  BSTAT_SUM_L,
  BSTAT_SUM_W,
  BSTAT_WORDS,
  CASCADE_COUNT,
  MAX_LODS,
  PAYLOAD_WORDS,
  SECONDARY_HIT_WORDS,
  BIN_WORDS,
  BIN_WORDS_SPLIT,
  SUM_SHIFT,
  SURPRISE_ONE,
  W0,
  sunSplitArmed,
  confidenceArmed, confidenceFullRays, confidencePriorRays,
  binCount,
  binGridWidth,
  sunBounceChromaGainForCascade,
  sunBounceGainForCascade,
} from "./srcConfig.js";
import {
  binMorton,
  chebyshev,
  dirToBin,
  intervalBoundary,
  lodAtDistance,
  normalPresent,
  rayDirection,
  transportPixel,
  unpackNormal,
} from "./srcMathTsl.js";
import {
  INFLUX_ONE,
  PRIORITY_REP_PIXEL_BITS,
  PRIORITY_REP_PIXEL_MASK,
  PROBE_BLOCK,
  PROBE_PARENT,
  PROBE_WORDS,
  SLOT_EMPTY,
} from "./srcProbes.js";

/** Per-bin accumulator layout. Nine words, one atomic buffer. */
export const BIN_R = 0;
export const BIN_G = 1;
export const BIN_B = 2;
export const BIN_T = 3;     // fixed-point WEIGHT of clear deposits
export const BIN_COUNT = 4;  // fixed-point WEIGHT of all deposits
/**
 * ══ §12.82 THE SUN SPLIT — WHY FOUR MORE WORDS ═════════════════════════════
 *
 * `BIN_R/G/B` store ACCUMULATED RADIANCE, and radiance is a function of the sun
 * angle. The user's Level runs a day cycle (`Rotator.ts`, an
 * `@executeInEditMode` script that assigns `rotation = f(engine.time.elapsed)`
 * — ~0.1 rad/s, a 62.8 s cycle), so every stored value is stale by an amount
 * proportional to how long ago its bin was last refreshed. Walk into a room and
 * neighbouring bins are stale by DIFFERENT amounts; **that disagreement is the
 * bright/dark patchwork the user reports**, measured at `checker` 0.0415 on
 * arrival against 0.0046 with the sun pinned — 9×, with no decay at all in the
 * pinned arm.
 *
 * ⛔ IT IS NOT A BLEND RATE. α ×5 leaves the picture **77% blockier at rest and
 * slower to settle** (0.0044 → 0.0078, 2084 → 2660 ms); the probe ray cap ×4
 * does nothing measurable. No rate fixes a stored quantity whose TARGET moves
 * every frame — and the §12.43 tracking window makes it worse by design, because
 * a continuously-moving sun keeps it armed and it keeps throwing history away.
 *
 * So the sun stops being STORED and starts being EVALUATED. What is cached is
 * the part of a hit that a rotating sun does not change:
 *
 *   `BIN_SR/SG/SB`  Σ w · (ρ/π) · V_sun   the sun's TRANSFER — albedo and
 *                   shadow, no cosine, no irradiance. Accumulated and decayed
 *                   exactly like radiance, so it inherits the evidence
 *                   weighting and the noise averaging that make `ΣR/Σcount` an
 *                   exponentially-weighted mean over RAYS.
 *   `BIN_SN`        the hit NORMAL, octahedral-packed into 15:15 + a flag, LAST WRITE
 *                   WINS. A normal is geometry, not a measurement: it needs a
 *                   representative value, not an average, and one word instead
 *                   of three is what keeps this affordable (see the budget
 *                   note below).
 *
 * and `[F]` closes it every frame against the CURRENT sun:
 *
 *     L = ΣR·Lmax/Σcount  +  (ΣS/Σcount) · E_sun(now) · max(0, n̂ · l(now))
 *
 * A rotating sun then invalidates NOTHING. Only genuine multi-bounce residue
 * accumulates slowly, which is the thing temporal accumulation is actually for.
 *
 * ⚠ **WHAT STAYS STALE, NAMED SO IT IS NOT MISREAD AS FIXED: V.** Visibility
 * toward the sun is not sun-independent and cannot be made analytic without
 * re-tracing a shadow ray per bin per frame, which is the cost this whole
 * module is built to avoid. So the fully-lit and fully-shadowed regions stop
 * drifting and the SHADOW BOUNDARIES still lag at the old refresh rate. That is
 * the honest maximum here, and it is the right trade: a late shadow edge reads
 * as a soft penumbra, a stale cosine reads as the blocky patchwork.
 *
 * ⚠ **AND WHY NOT SIX WORDS.** The obvious form accumulates `Σ w·V·n` as three
 * signed words instead of packing one. It does not fit: at the grown pool
 * (`BIN_BUDGET` 2.8 M, the Bistro sizing) eleven words is 123 MB of `scratch`
 * BEFORE [J]'s hit list and the per-block statistics, which ride the same
 * buffer, and the 128 MiB binding limit is what killed capacity-addressed bins
 * in the first place (§12.16). Nine words leaves ~17 MB of headroom there. The
 * constructor throws with the arithmetic if a future pool eats it.
 */
export const BIN_SR = 5;
export const BIN_SG = 6;
export const BIN_SB = 7;
/**
 * The hit normal, octahedral 16:16. NOT a sum and NOT decayed — see the decay
 * pass, which stores it through unchanged and zeroes it only when the block is
 * reclaimed. Zero is the "no normal yet" sentinel: it decodes to a degenerate
 * direction, and `[F]` tests the raw word rather than the decoded vector so the
 * sentinel cannot be confused with a legitimately-encoded axis.
 */
export const BIN_SN = 8;
/**
 * §10.8: 9 when the sun split is armed, 5 when it is not — srcConfig owns the
 * value because it also owns `BIN_BUDGET`, which is derived from it. Re-exported
 * here so every consumer keeps importing the layout from the file that defines
 * the words.
 */
export { BIN_WORDS };

/** Fractional bits in the radiance accumulator. §12.13.4 measured this. */
export const DEPOSIT_F = 16;
export const DEPOSIT_SCALE = 1 << DEPOSIT_F;

/**
 * Accumulated weight below which a bin is UNKNOWN rather than dim — one
 * sixty-fourth of a single ray. Only reachable under temporal decay; the
 * resolve's header says what goes wrong without it.
 */
export const MIN_WEIGHT = DEPOSIT_SCALE >> 6;
// §11.13: the near segment's tMin. −1 tells the trace closure "your own
// self-intersection epsilon" (both closures treat a null/negative tMin as
// theirs); the far segment passes the near bound instead.
const BVH_SELF_BIAS_M_FALLBACK = -1;

/**
 * Resolved payload: rgb + transmittance, with T < 0 meaning UNKNOWN.
 *
 * ══ TWO WORDS OF PACKED HALVES, NOT FOUR FLOATS (plan §11.4 A1, 2026-09-03) ═
 *
 * Word 0 is `pack2x16float(r, g)`, word 1 is `pack2x16float(b, T)`. The
 * payload was the second-largest allocation in the module — 4.5 M bins × 16 B
 * = 72 MB of a 220 MB store on Bistro — and every consumer on the image path
 * already reads it through an rgba16f tile atlas, so f32 storage bought
 * nothing the screen could see. Half precision carries ~3 decimal digits;
 * the merge's product of four transmittances and the bake's 32-bin average
 * round unbiased at ~0.05 % relative, two orders under the 3 %/pixel/frame
 * flicker gate. `PAYLOAD_UNKNOWN` (−1) and 0 are exact halves, so every
 * `T < 0` / `T == 0` test in the kernels reads as it always did.
 *
 * THE KERNELS NEVER TOUCH THE WORDS DIRECTLY. `readPayload` / `readPayloadT` /
 * `writePayload` / `writePayloadUnknown` below are the only four ways in, and
 * `decodePayload` / `encodePayload` are their CPU twins for the mirror gates
 * and the probes (`srcMath.js` owns the binary16 conversion). A fifth path
 * would be a second definition of the layout.
 *
 * `PAYLOAD_CHANNELS` is the DECODED stride — what `decodePayload` hands back
 * and what every CPU reader indexes by — kept distinct from `PAYLOAD_WORDS`
 * so a reader that still multiplies by the word count on a decoded array
 * fails loudly on the first bin rather than reading every other one.
 */
export { PAYLOAD_WORDS };
export const PAYLOAD_CHANNELS = 4;
export const PAYLOAD_UNKNOWN = -1;

/** Word offset of bin `bin` in `payload`. */
const payloadWord = (bin) => uint(bin).mul(uint(PAYLOAD_WORDS));

/**
 * `{ L: vec3, T: float, c: float, cen: uint }` of bin `bin` — three loads,
 * unpacked. `cen` is the §11.28 radiance-centroid code riding word 2's high
 * half (0 = the bin's own centre).
 */
// ── §11.59 THE COUNTERS ARE OPT-OUT (2026-09-11) ────────────────────────────
// Every ray (and every shaded hit, in srcSecondary.js) bumps eight to twelve
// GLOBAL atomics on the same few words — the receipts `profile.giPasses`
// prints (rays, hits, clamped, tsum/tmax, far, movers…). Same-address atomics
// serialise at the L2 whatever the GPU; on the phone they are paid by every
// frame's transport whether anyone reads them or not. `__giSrcStats = false`
// (build-time) compiles them out; the receipt fields then read 0.
const srcStatsOn = () => globalThis.__giSrcStats !== false;

export function readPayload(payload, bin) {
  const o = payloadWord(bin).toVar();
  const rg = unpackHalf2x16(payload.element(o)).toVar();
  const bt = unpackHalf2x16(payload.element(o.add(uint(1)))).toVar();
  const w2 = payload.element(o.add(uint(2))).toVar();
  const cs = unpackHalf2x16(w2).toVar();
  return {
    L: vec3(rg.x, rg.y, bt.x).toVar(), T: bt.y.toVar(), c: cs.x.toVar(),
    cen: w2.shiftRight(uint(16)).toVar(),
  };
}

/** Confidence alone — one load (§11.25). */
export function readPayloadC(payload, bin) {
  return unpackHalf2x16(payload.element(payloadWord(bin).add(uint(2)))).x.toVar();
}

/** Transmittance alone — one load, for the early-outs that never need L. */
export function readPayloadT(payload, bin) {
  return unpackHalf2x16(payload.element(payloadWord(bin).add(uint(1)))).y.toVar();
}

/**
 * Store `L` (vec3), `T` (float), confidence `c` (float, default 1) and the
 * §11.28 centroid code `cen` (uint, default 0 = the bin's centre) into bin
 * `bin`. The code rides word 2's high half: `packHalf2x16(vec2(c, 0))` leaves
 * that half zero, so the OR is exact and `readPayloadC` never sees it.
 */
export function writePayload(payload, bin, L, T, c = null, cen = null) {
  const o = payloadWord(bin).toVar();
  payload.element(o).assign(packHalf2x16(vec2(L.x, L.y)));
  payload.element(o.add(uint(1))).assign(packHalf2x16(vec2(L.z, T)));
  const w2 = packHalf2x16(vec2(c == null ? float(1) : c, float(0)));
  payload.element(o.add(uint(2))).assign(cen == null ? w2 : w2.bitOr(uint(cen).shiftLeft(uint(16))));
}

/** Mark bin `bin` UNKNOWN (T = −1, confidence 0; the blue channel is meaningless with it). */
export function writePayloadUnknown(payload, bin) {
  const o = payloadWord(bin).toVar();
  payload.element(o.add(uint(1)))
    .assign(packHalf2x16(vec2(float(0), float(PAYLOAD_UNKNOWN))));
  payload.element(o.add(uint(2))).assign(uint(0));
}

/**
 * CPU twin of the unpack: a `Uint32Array` of packed words (a readback of
 * `bins.payload`, or its CPU mirror) → `Float32Array` of `PAYLOAD_CHANNELS`
 * per bin, `[r, g, b, T]`, indexed exactly the way the f32 payload was.
 */
export function decodePayload(words) {
  const src = words instanceof Uint32Array ? words : new Uint32Array(words);
  const bins = Math.floor(src.length / PAYLOAD_WORDS);
  const out = new Float32Array(bins * PAYLOAD_CHANNELS);
  for (let i = 0; i < bins; i++) {
    const [r, g] = unpackHalf2(src[i * PAYLOAD_WORDS]);
    const [b, t] = unpackHalf2(src[i * PAYLOAD_WORDS + 1]);
    const o = i * PAYLOAD_CHANNELS;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = t;
  }
  return out;
}

/**
 * The confidence channel (§11.25), one float per bin, from a payload readback.
 * Kept OUT of `decodePayload`'s `[r, g, b, T]` so every consumer that indexes
 * that array by `PAYLOAD_CHANNELS` keeps working unchanged.
 */
export function decodePayloadConfidence(words) {
  const src = words instanceof Uint32Array ? words : new Uint32Array(words);
  const bins = Math.floor(src.length / PAYLOAD_WORDS);
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) out[i] = unpackHalf2(src[i * PAYLOAD_WORDS + 2])[0];
  return out;
}

/**
 * The §11.28 centroid codes, one per bin, from a payload readback (0 = the
 * bin's centre; decode with `srcMath.decodeCentroid`).
 */
export function decodePayloadCentroid(words) {
  const src = words instanceof Uint32Array ? words : new Uint32Array(words);
  const bins = Math.floor(src.length / PAYLOAD_WORDS);
  const out = new Uint16Array(bins);
  for (let i = 0; i < bins; i++) out[i] = src[i * PAYLOAD_WORDS + 2] >>> 16;
  return out;
}

/**
 * CPU twin of the pack: a `[r, g, b, T]`-per-bin field → packed words, into
 * `out` (a `Uint32Array` of `PAYLOAD_WORDS` per bin — `bins.payload.value.array`
 * for a gate that synthesizes its own field) or a fresh array. `confidence`
 * (one float per bin) is optional: a synthesized field without one encodes a
 * known bin at confidence 1 and an unknown bin at 0 — exactly the previous
 * estimator, so every existing fixture means what it meant.
 */
export function encodePayload(field, out = null, confidence = null) {
  const bins = Math.floor(field.length / PAYLOAD_CHANNELS);
  const dst = out ?? new Uint32Array(bins * PAYLOAD_WORDS);
  for (let i = 0; i < bins; i++) {
    const o = i * PAYLOAD_CHANNELS;
    dst[i * PAYLOAD_WORDS] = packHalf2(field[o], field[o + 1]);
    dst[i * PAYLOAD_WORDS + 1] = packHalf2(field[o + 2], field[o + 3]);
    const c = confidence ? confidence[i] : (field[o + 3] >= 0 ? 1 : 0);
    dst[i * PAYLOAD_WORDS + 2] = packHalf2(c, 0);
  }
  return dst;
}

/** What a value becomes after one trip through the packed payload. */
export const payloadQuantize = halfRound;
/** One binary16 ulp at `x` — the gate allowance for a value that crossed the payload. */
export const payloadUlp = halfUlp;

/**
 * ══ [J]'s HIT LIST — A REGION OF `scratch`, NOT A BUFFER OF ITS OWN ═════════
 *
 * The multibounce pass re-shades last frame's hits against the tile atlas, so
 * it needs to know WHERE each hit was and WHERE its radiance goes. That is a
 * per-frame list, and a list is a buffer — except that [E] is at 7 of the 8
 * storage bindings a portable stage gets, and [J] itself must read the bins to
 * deposit into them anyway. So the list rides the TAIL of `scratch`: word
 * `hitListBase` is the atomic count, entries follow it, and BOTH passes see one
 * buffer where a separate list would have cost [E] its last binding (R7 —
 * `hashKeys` carries the hash→block words for the same reason).
 *
 * Entries are UNPACKED floats through `floatBitsToUint`, not a quantized
 * encoding: `dynamicObjects.js`'s triangle pool sets the precedent, and the
 * one thing [J] must not do is re-derive a hit's position approximately —
 * a gather at the wrong point reads a plausible irradiance from the wrong side
 * of a wall, which no energy check downstream can see.
 *
 * ══ SINCE §12.53 THIS RECORD IS THE WHOLE [E] → [J] INTERFACE ══════════════
 *
 * It used to carry the three things the SECOND BOUNCE could not recompute.
 * Now it carries everything ANY shading needs, because `shadeHit` itself moved:
 * [E] traces and attributes, [J] shades, gathers and deposits. The four words
 * §12.49 left reserved/padding are exactly the four that bought it (emissive,
 * the R5 flag, the ray index, and the block's evidence-word address).
 */
export const SEC_P = 0;     // world position of the hit
export const SEC_N = 3;     // face-forwarded normal (srcShade's `faceForward`)
export const SEC_RHO = 6;   // physical 0..1 albedo; [J] applies R4 only to feedback
export const SEC_SLOT = 9;  // destination bin's WORD base, already ×BIN_WORDS
export const SEC_LE = 10;   // raw emissive — R5's zeroing is [J]'s (it owns the NEE set)
export const SEC_EMITTER = 13; // R5 flag as float bits; < 0 = not an NEE light
export const SEC_RAY = 14;  // the ray's index in the global R2 sequence (a u32, not float bits)
/**
 * The owning block's `BSTAT_SUM_L` word address, or `SLOT_EMPTY` when the
 * surprise bundle is off. §12.52's per-block evidence sums a deposit's LUMA,
 * and [E] no longer computes one — so the address travels and [J] does the add.
 * The WEIGHT half (`BSTAT_SUM_W`) stays in [E]: it is `DEPOSIT_SCALE` per
 * deposit and knows nothing about radiance.
 */
export const SEC_SUML = 15;
/** The ray's world direction (unit), for what the hit is seen THROUGH. */
export const SEC_DIR = 16;
export const SEC_HIT_WORDS = SECONDARY_HIT_WORDS;

/** Diagnostic words — the `Lmax` decision's instrument, plus the ray tallies. */
export const STAT_RAYS = 0;
export const STAT_HITS = 1;
export const STAT_DEPOSITS = 2;
export const STAT_CLAMPED = 3;   // deposits whose radiance hit the Lmax ceiling
export const STAT_MAXL = 4;      // max observed radiance, in DEPOSIT_F fixed point
export const STAT_TSUM = 5;      // hit-distance sum, 1/1024 m
export const STAT_TMAX = 6;
/**
 * Scatters dropped because the probe holds no bin block.
 *
 * The other half of `COUNTER_NOBLOCK`: that one counts PROBES born without
 * bins, this one counts the DEPOSITS they then failed to make, which is the
 * number that says how much light the shortfall actually cost. Both are zero
 * whenever the pool is big enough, and the gate asserts it.
 */
export const STAT_NOBLOCK = 7;

/**
 * Hit-shading tallies (Phase 5). Every one of these is an instrument §12.26
 * asked for by name, and none of them is decoration.
 *
 * ══ SINCE §12.53 THEY ARE WRITTEN BY TWO KERNELS, NOT ONE ══════════════════
 *
 * The shading split put the surface half in [E] and the light half in [J], and
 * these words follow their own half. One `stats` buffer, two writers, no new
 * binding on either side (both kernels already bind it):
 *
 *   [E]  SHADED · UNATTRIBUTED · ALBEDO_CLAMPED   — properties of a SURFACE,
 *        counted for every ray the deposit attributes, hit or miss, exactly as
 *        before, so `unattributedRate` keeps its historical denominator.
 *   [J]  SHADOWRAYS · EMISSIVE · EMIT_ZEROED · IMPORTANCE_FLOORED · CLAMPED ·
 *        MAXL — properties of the LIGHTING, counted for hits that reached a
 *        destination bin. ⚠ These three DENOMINATORS SHRANK at the split: the
 *        un-split kernel shaded every ray including the ~76% that miss (their
 *        radiance was computed and then discarded by `own == N`), so it counted
 *        shadow rays and emissive hits for garbage attributions of empty space.
 *        The estimator never used them; the counters did.
 *
 * The list itself:
 *
 * · `SHADED` / `UNATTRIBUTED` — R1. A hit whose surface could not be identified
 *   shades at the default albedo with no emission, which is a plausible-looking
 *   grey. The ratio is the only thing that says how much of the frame that is.
 * · `SHADOWRAYS` — the cost of the whole phase, in the only unit that matters.
 * · `EMISSIVE` — hits that delivered their own emission, the ray-hit half of R5's
 *   handoff.
 * · `EMIT_ZEROED` — **ZERO IS THE HEALTHY READING, and that is not the sense
 *   §12.26 wrote it in.** R5's zeroing already happens on the CPU, at bake time:
 *   `GISystem#slotSurface` and `dynamicObjects`' `writeSurface` both publish a
 *   promoted emitter's emissive as 0, and that guard is itself a paid-for fix —
 *   `writeSurface` once published the raw emissive unconditionally, and an
 *   emissive mesh that was both promoted AND traced delivered its light twice.
 *   The promotion set IS the NEE set, so the bake zeroes exactly what the
 *   sampler will deliver, and the hit has nothing left to withhold.
 *
 *   The shader keeps its zeroing branch anyway, and this counter is what makes
 *   that branch worth having: it counts hits that landed on a NEE-flagged
 *   emitter and STILL carried emission — i.e. surfaces the bake missed. A
 *   nonzero reading is a bug in the promotion bookkeeping, caught before it
 *   reaches the image as light delivered twice.
 *
 *   **Do not "fix" a zero here by shipping unzeroed emissive to the palette.**
 *   That moves R5 to a third implementation and makes the flag and the
 *   promotion set two sources of truth for one fact, which is the crossed-
 *   numbering shape §12.9 warns any successor about. The handoff's real gate is
 *   an ENERGY arm (§12.26.7: analytic-on vs analytic-off, mean over a region,
 *   2.60×), which measures the same property under either design.
 * · `ALBEDO_CLAMPED` — R4's ceiling, counting itself, exactly as `STAT_CLAMPED`
 *   does for Lmax. A ceiling that never binds is the evidence for keeping it.
 * · `IMPORTANCE_FLOORED` — the instrument that says a light ranking is broken.
 *   The floor keeps the energy and bounds the firefly; it does NOT make a bad
 *   ranking usable, and this counter is the difference between knowing that and
 *   shipping 37× the standard error.
 */
export const STAT_SHADED = 8;
export const STAT_UNATTRIBUTED = 9;
export const STAT_SHADOWRAYS = 10;
export const STAT_EMISSIVE = 11;
export const STAT_EMIT_ZEROED = 12;
export const STAT_ALBEDO_CLAMPED = 13;
export const STAT_IMPORTANCE_FLOORED = 14;

/**
 * [J]'s three words, and they are split across two passes on purpose:
 *
 * · `SEC_OVERFLOW` is written by [E] — the only pass that can know a hit did
 *   not fit. Nonzero means the hit list is smaller than the rays that can
 *   produce entries (`transportThreads × raysPerPixel`) and bounce light is
 *   being dropped where nothing on screen would say so.
 * · `SECONDARY` and `SEC_CLAMPED` are written by [J]. `SECONDARY` is the
 *   instrument that says THE PASS RAN: a pipeline that fails to create
 *   dispatches nothing, and the frame it produces looks exactly like a scene
 *   whose second bounce happens to be dim — and since §12.53 it also looks like
 *   a scene with no DIRECT light at the hits, because [J] shades. No image
 *   statistic separates those, so the gate asserts this counter.
 * · `SEC_CLAMPED` counted the SPLIT clamp's residual while the two terms
 *   saturated in different kernels. §12.53 put them in one kernel and one
 *   clamp — the inline form §12.49 recorded a difference from — so the word now
 *   counts the BOUNCE TERM ALONE reaching the ceiling, which is the same
 *   instrument's real subject: R4's loop gain running away is exactly the
 *   condition where `ρ/π · E_atlas` saturates on its own.
 *
 * They live here because `srcSecondary.js` owns no buffer: three storage
 * bindings, all of them load-bearing, exactly as `createSrcShadeCounters`
 * arranged for the hit shader.
 */
export const STAT_SECONDARY = 15;
export const STAT_SEC_CLAMPED = 16;
export const STAT_SEC_OVERFLOW = 17;
/**
 * ── §12.82's OWN INSTRUMENT, WRITTEN BY `[F]` ──────────────────────────────
 *
 * The split has exactly one failure mode that no image statistic can name: a
 * bin resolves with radiance but WITHOUT a cached normal, so its whole sun
 * contribution is silently dropped. That reads as "the picture is darker" — the
 * same symptom as a transfer that is too small, as a wrong cosine, and as a sun
 * that never got split at all. These two words separate them: if
 * `SUN_NORMAL / SUN_LIVE` is far below 1, the sun is being dropped for want of
 * a normal; if it is near 1 and the picture is still dark, the arithmetic is
 * wrong rather than the bookkeeping.
 *
 * `[F]` is the only pass that binds `stats` for writing besides `[E]` and `[J]`,
 * and it binds one more buffer to do it — three of the portable eight, which is
 * nowhere near the limit that makes [E] and [J] interesting (R7).
 */
export const STAT_SUN_LIVE = 18;    // resolved bins carrying RADIANCE
export const STAT_SUN_NORMAL = 19;  // ...of which had a cached normal to close
/**
 * [J]-side: hits that FACE the split source, and hits shaded at all. The bin
 * ratio above cannot distinguish "few bins ever saw a sun-facing hit" (correct
 * — most bins are lit by bounce) from "the facing test is broken" (the bug),
 * because it has the wrong denominator for that question. This has the right
 * one: `SUN_FACING / SUN_SHADED` is a property of HITS, and for a sun ~21°
 * above the horizon it should be roughly the fraction of surfaces whose normal
 * is in its hemisphere — near half, not near a tenth.
 */
export const STAT_SUN_FACING = 20;
export const STAT_SUN_SHADED = 21;
// §11.13: rays that traced their FAR intervals this frame (the far duty).
export const STAT_FAR = 22;
// §11.13: capped rays that hit nothing INSIDE their shortened reach. They are
// not misses of the scene — the ray never looked further — so the attribution
// tally excludes them (see readStats' `unattributedRate`).
export const STAT_CAPPED_MISS = 23;
// §11.13: rays the NEED FLOOR forced far that the duty's stratum had not drawn.
export const STAT_FAR_NEED = 24;
// §11.14's instrument: [J]'s energy ledger PER HIT LOD — for each of the
// MAX_LODS camera-distance LODs a hit can sit at, four words: Σ luma of the
// direct term, Σ luma of the bounce term, Σ luma of the gathered irradiance
// E_atlas, and the hit count. Luma in 1/1024 fixed point. The ratio
// bounce/direct per LOD is what separates "the loop over-gains everywhere"
// from "the coarse far lattice leaks the sunlit strip into the shadows".
export const STAT_SEC_LOD_BASE = 25;
export const STAT_SEC_LOD_WORDS = 5;  // +Σ luma of the hit albedo the loop multiplies
// Row STAT_SEC_LOD_LEVELS-1 is not a LOD: it is every hit on a MOVER (a
// skinned capsule / dynamic body), whatever its distance — the character
// brightness ledger (§11.15) needs the mover hits' Ld / Lb / E on their own.
export const STAT_SEC_LOD_LEVELS = 5;
export const STAT_SEC_LOD_MOVER_ROW = STAT_SEC_LOD_LEVELS - 1;
// §11.15: rays born INSIDE a mover (a skinned capsule around a lattice probe) —
// dropped without a deposit; see the deposit's `insideMover` note.
export const STAT_INSIDE_MOVER = STAT_SEC_LOD_BASE + STAT_SEC_LOD_WORDS * STAT_SEC_LOD_LEVELS;
// §11.15 instrument: hits the transport landed ON a mover, and how many of
// them reached the second-bounce list with the mover flag intact.
export const STAT_MOVER_HITS = STAT_INSIDE_MOVER + 1;
export const STAT_MOVER_RECORDS = STAT_INSIDE_MOVER + 2;
// §11.44: tree-sample visibilities answered by the per-probe cache (no march).
export const STAT_VIS_CACHED = STAT_INSIDE_MOVER + 3;
export const STAT_VIS_NOBLOCK = STAT_INSIDE_MOVER + 4;  // hit outside the populated c0 field
export const STAT_VIS_NOROW = STAT_INSIDE_MOVER + 5;    // the block has 8 lamps cached already
export const STAT_VIS_FILLING = STAT_INSIDE_MOVER + 6;  // row found, fewer than K samples
export const STAT_VIS_FULL = STAT_INSIDE_MOVER + 7;     // the cell hash refused the insert (table full)
export const STAT_WORDS = STAT_INSIDE_MOVER + 8;
const T_FIXED = 1024;

/**
 * The `count` object `srcShade.js`'s hit shader increments, bound to a bin
 * store's stats buffer.
 *
 * It exists so `srcShade.js` owns no buffer. The hit shader is CONSTRUCTED by
 * `srcSystem.js` (it needs the sun, the emitter slots and the visibility closure,
 * none of which this file knows about) but RUNS inside the deposit kernel, so a
 * shader that allocated its own atomics would be a ninth storage binding on the
 * kernel already closest to the portable limit of eight (R7). Instead the words
 * live in the deposit's existing stats buffer and the shader is handed writers.
 *
 * Every method takes a node or a plain number; a `select(cond, 1, 0)` is the
 * expected idiom for a conditional tally, so nothing here needs a branch.
 */
export function createSrcShadeCounters(bins) {
  const { stats } = bins;
  const bump = (word) => (amount) => {
    if (srcStatsOn()) atomicAdd(stats.element(uint(word)), uint(amount));
  };
  return {
    shaded: bump(STAT_SHADED),
    unattributed: bump(STAT_UNATTRIBUTED),
    shadowRays: bump(STAT_SHADOWRAYS),
    visCached: bump(STAT_VIS_CACHED),
    visNoBlock: bump(STAT_VIS_NOBLOCK),
    visNoRow: bump(STAT_VIS_NOROW),
    visFilling: bump(STAT_VIS_FILLING),
    visFull: bump(STAT_VIS_FULL),
    emissiveHits: bump(STAT_EMISSIVE),
    emissiveZeroed: bump(STAT_EMIT_ZEROED),
    albedoClamped: bump(STAT_ALBEDO_CLAMPED),
    importanceFloored: bump(STAT_IMPORTANCE_FLOORED),
  };
}

/**
 * The bin accumulators and the resolved payload, sized from a probe store's
 * BLOCK POOL.
 *
 * ══ ADDRESSED BY CLAIMED BLOCK, NOT BY PROBE SLOT ══════════════════════════
 *
 * A bin's slot is `binBase[cascade] + block · binCount(cascade) + morton`,
 * where `block` is what the probe claimed at creation (`PROBE_BLOCK`) and the
 * pool lives in `createSrcProbeStore` — see its header for why the pool shares
 * the probe free stack rather than owning buffers of its own.
 *
 * The previous scheme indexed by the probe's own slot, which sized the
 * accumulators off `expectedC0Probes` — a deliberate over-estimate. §12.16's
 * gate measured the consequence: **0.24% of allocated bins were ever sampled**,
 * 127 MB at the engine default, and 604 MB at a half-res 1080p gbuffer, which
 * is five times the 128 MiB binding limit. The claim is therefore not a
 * ceiling-raiser bought with complexity; it is a straight reduction that also
 * removes a resolution at which the constructor used to throw.
 *
 * The throw stays as a backstop. It is unreachable through `BIN_BUDGET` alone
 * now, which is the point — an assertion that has become impossible to trip by
 * accident is cheaper to keep than to re-derive later.
 */
export function createSrcBinStore(store, {
  w0 = W0,
  maxBytes = 128 * 1024 * 1024,
  secondaryCapacity = 0,
  /** §10.8 — does this build read/write BIN_SR..BIN_SN? Asserted, not assumed. */
  sunWords = sunSplitArmed(),
} = {}) {
  const cascades = [];
  let binTotal = 0;
  for (const c of store.cascades) {
    const bins = binCount(c.cascade, w0);
    cascades.push({
      cascade: c.cascade,
      bins,
      width: binGridWidth(c.cascade, w0),
      binBase: binTotal,
      blockCapacity: c.blockCapacity,
      // Where this cascade's blocks start in the pool's INDEX space, which is
      // not the same as `binBase` (bin space) and is what addresses the claim
      // stamps. Copied from the probe store rather than recomputed — the decay
      // pass read `undefined` here for one round of the temporal gate and
      // silently indexed `freeStack[NaN]`, which resolves to the probe free
      // stack and compares probe indices against a frame number.
      blockBase: c.blockBase,
      probeBase: c.probeBase,
      probeCapacity: c.probeCapacity,
    });
    binTotal += bins * c.blockCapacity;
  }
  // The bins, then [J]'s hit list, then the per-block statistics — one buffer,
  // in that order, so every bin index keeps the address it had before the tails
  // existed. `hitListBase` is the count word; entries start one word after it.
  //
  // ── AND WHY THE STATISTICS RIDE HERE RATHER THAN GETTING A BUFFER ────────
  //
  // [E] is the pass that fills them (one atomicAdd pair per deposit) and [E] is
  // at 8 of the portable 8 storage buffers in the profiled ray-hit config. A
  // ninth binding does not fail loudly: the pipeline fails VALIDATION and the
  // kernel silently never dispatches (§12.44.1 — the smoke read zero deposits
  // against a full worklist for exactly as long as anyone waited). So the
  // record rides `scratch`, which [E] already binds, exactly as [J]'s hit list
  // does and for the same measured reason.
  // §10.8: the sun words exist only in the armed layout. A build that asks to
  // CLOSE the sun against a 5-word bin would read words 5..8 of bin N, which
  // are words 0..3 of bin N+1 — a silent cross-bin read, so it is a throw.
  if (sunWords && BIN_WORDS < BIN_WORDS_SPLIT) {
    throw new Error(
      "createSrcBinStore: this build uses the sun-split bin words (BIN_SR..BIN_SN) " +
      `but the layout is ${BIN_WORDS} words — arm __giSrcSunSplit before the ` +
      "page loads (srcConfig's BIN_WORDS is read once at module load)",
    );
  }
  const binWords = binTotal * BIN_WORDS;
  const hitCapacity = Math.max(0, Math.floor(secondaryCapacity));
  const hitListBase = binWords;
  const hitWords = hitCapacity > 0 ? 1 + hitCapacity * SEC_HIT_WORDS : 0;
  const blockStatBase = hitListBase + hitWords;
  const statWords = store.blockTotal * BSTAT_WORDS;
  const scratchBytes = (binWords + hitWords + statWords) * 4;
  const payloadBytes = binTotal * PAYLOAD_WORDS * 4;
  if (scratchBytes > maxBytes || payloadBytes > maxBytes) {
    throw new Error(
      `createSrcBinStore: ${(binTotal / 1e6).toFixed(2)}M bins needs ` +
      `${(scratchBytes / 1048576).toFixed(0)}MB of scratch (including ` +
      `${(hitWords * 4 / 1048576).toFixed(0)}MB of [J] hit list and ` +
      `${(statWords * 4 / 1048576).toFixed(0)}MB of per-block statistics) and ` +
      `${(payloadBytes / 1048576).toFixed(0)}MB of payload, past the ` +
      `${(maxBytes / 1048576).toFixed(0)}MB storage-buffer binding limit — ` +
      "lower srcConfig's BIN_BUDGET, which is what sizes the block pool",
    );
  }

  const scratch = instancedArray(new Uint32Array(binWords + hitWords + statWords), "uint").toAtomic();
  // Packed halves (see PAYLOAD_WORDS) — a u32 buffer, read and written only
  // through the four accessors above it. Initialized UNKNOWN (T = −1), not
  // zero: a zero word unpacks to T = 0, i.e. a KNOWN black bin, and since the
  // resolve skips dead blocks (the live word) a never-claimed block would
  // otherwise read as known black to anything that reached it — the top
  // cascade's sky composite counted 5.6 M such bins on Bistro. The f32 layout
  // had the same hole; the packed one closes it for the price of one fill.
  const payloadInit = new Uint32Array(binTotal * PAYLOAD_WORDS);
  const unknownWord = packHalf2(0, PAYLOAD_UNKNOWN);
  for (let i = 1; i < payloadInit.length; i += PAYLOAD_WORDS) payloadInit[i] = unknownWord;
  const payload = instancedArray(payloadInit, "uint");
  const stats = instancedArray(new Uint32Array(STAT_WORDS), "uint").toAtomic();

  return {
    cascades,
    binTotal,
    w0,
    scratch,
    payload,
    stats,
    /**
     * GPU-only after the first bind; `detachCpuMirror` drops the JS twin three
     * already copied into the GPU buffer. Nothing here is ever written CPU-side
     * again (readbacks go through `getArrayBufferAsync`, which sizes itself
     * from `bufferGPU.size`).
     */
    cpuMirrors: [scratch, payload, stats].map((n) => n?.value).filter(Boolean),
    /** [J]'s region. `hitCapacity` 0 means the tail was not allocated. */
    hitListBase,
    hitCapacity,
    /**
     * Where the per-block statistics start in `scratch` — `BSTAT_WORDS` per
     * block, indexed by the GLOBAL block index (`blockBase[c] + block`), the
     * same addressing the claim stamps and influx words use in `freeStack`.
     */
    blockStatBase,
    bytes: scratchBytes + payloadBytes + STAT_WORDS * 4,
    /**
     * The payload's CPU decoder, on the object every probe already holds —
     * `decodePayload(await renderer.getArrayBufferAsync(bins.payload.value))`
     * gives `[r, g, b, T]` per bin at `payloadChannels` stride. Scripts that
     * reach the live store through the editor have no module import to call
     * the free function by.
     */
    payloadChannels: PAYLOAD_CHANNELS,
    decodePayload,
    dispose() {
      for (const b of [scratch, payload, stats]) b?.value?.dispose?.();
    },
  };
}

/**
 * [E] + [F] as a dispatch list.
 *
 * Replaces the unit-1 scaffold pass (`srcRayPass.js`, deleted in this commit) —
 * this kernel traces the same rays through the same closure, and additionally
 * does something with the answer. The scaffold's counters live on inside
 * `stats` because they were the only instrument on the traversal's step budgets
 * and losing them would un-gate `smoke:gi-gpu` again.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {object} options.pixelProbe    per-pixel c0 probe index
 * @param {object} options.pixelRayBase  Alg. 3's per-pixel ray base
 * @param {(o, d, tMax) => object} options.trace  from `createSrcSceneTrace`
 * @param {(hit, dir, rayIndex) => object} [options.shadeHit]  vec3 radiance
 *   at a hit, from `srcShade.js`'s `createSrcHitShader`. Default black — see the
 *   header. `rayIndex` is `n`, the ray's place in the global R2 sequence, and
 *   the shader needs it for the same reason the gate's synthetic trace does: a
 *   pure function of a u32 is bit-identical across a boundary where an RNG state
 *   is not.
 *
 *   THE ONE-KERNEL FORM. Mutually exclusive with `attribute` below, and the
 *   constructor refuses both: a kernel that shades inline AND appends would
 *   have [J] shade the same hit a second time and deposit it twice.
 * @param {(hit, dir) => {P, n, rho, emissive, emitter}} [options.attribute]
 *   THE SPLIT FORM (§12.53), from `srcShade.js`'s `createSrcHitAttribution`.
 *   With it, this kernel does NOT shade: it traces, attributes, and appends the
 *   record `srcSecondary.js` shades from. The radiance words of the owning bin
 *   are left for [J]; every other deposit (transmittance below the hit, the
 *   count on the whole chain, a miss's all-clear) is made here, unchanged.
 *   Requires `secondary` — there is nowhere to put an entry without it.
 * @param {{base: number, capacity: number}} [options.secondary]  [J]'s hit list
 *   in `scratch`'s tail (`createSrcBinStore`'s `hitListBase`/`hitCapacity`).
 *   Supplied, this kernel appends one entry per attributed hit that has
 *   somewhere to deposit; omitted, NOT ONE NODE OF THAT IS BUILT and the emitted
 *   WGSL is byte-identical to the pre-[J] kernel — which is what keeps every
 *   gate written before the multibounce (and `scripts/gi-src-deposit.html`,
 *   whose synthetic shader shades inline) comparable rather than merely
 *   passing.
 * @param {object} options.lmax  uniform: the radiance the fixed point saturates at
 * @param {Node} [options.keep]  the temporal blend's `1 − α`, applied to every
 *   accumulator before this frame's deposits land. Default 0, which is the
 *   single-frame behaviour every gate written before Phase 4 assumes.
 * @param {Node} [options.frameStamp]  the frame number `createSrcProbeFrame`
 *   stamps onto freshly claimed blocks. Must be the same node.
 * @param {object} [options.rayWork]  the ray store's winner worklist — word 0
 *   the count, entries after it, ONE buffer (its store doc carries the
 *   binding-budget measurement behind that). [E] traces densely from it
 *   instead of striding the pixel set (§12.44); omitted, [E] keeps the
 *   classic thread → pixel mapping every pre-compaction gate runs.
 * @param {Node} [options.influxLift]  uniform in [0,1] — how much of the per
 *   block α compensation is LIFTED (§12.40.4). At 0 the decay slows on capped
 *   blocks to hold `influx/(1−keep′)` at its uncapped value (variance-neutral
 *   still scene); at 1 the compensation is fully suspended and the decay is
 *   bit-identical to the uncompensated build. srcSystem drives it from the
 *   motion-adaptive α's own motion term, which is what retires stale bins:
 *   full compensation makes `keep′` close enough to 1 that the integer
 *   decay's rounding fixed point (0.5/(1−keep′)) can park a no-longer
 *   sampled bin ABOVE `MIN_WEIGHT` — a forever-readable stale bin, R1's dark
 *   vote — but a still scene is precisely the case where a stale value is
 *   still the true one, and any change the motion signal can see raises the
 *   lift, restores the fast decay, and retires the bin normally. The one gap
 *   is a change the signal misses (its floor is §12.38.3's blind-spot list),
 *   which is a property of the signal, not of this pass. Omitted, the branch
 *   is not built and the decay is byte-identical to the pre-compensation
 *   kernel — where every gate written before it runs.
 * @param {object} [options.surprise]  the per-block surprise bundle
 *   (`srcConfig.js`'s SURPRISE block). Two effects, both optional together:
 *   [E] sums each deposit's luma and weight into the block's `BSTAT` record,
 *   and the DECAY reads the block's surprise word `u` and mixes `keep′` toward
 *   `surpriseF`. Omitted, NOT ONE NODE OF EITHER IS BUILT and both kernels are
 *   byte-identical to the pre-surprise build — the discipline `secondary`
 *   above already runs under, and what keeps every gate written before this
 *   comparable rather than merely passing.
 *   `{ statBase, surpriseF }`, where `statBase` must be the store's
 *   `blockStatBase` and `surpriseF` is a uniform ≥ 1 (`1` = no acceleration,
 *   which srcSystem uses when α is pinned).
 */
export function createSrcDepositFrame(store, bins, {
  pixelProbe,
  pixelRayBase,
  pixelCount,
  raysPerPixel = 1,
  trace,
  shadeHit = null,
  attribute = null,
  secondary = null,
  readPixel,
  readNormal,
  camera,
  spacing0,
  lmax,
  jitterX,
  jitterY,
  keep = null,
  frameStamp = null,
  influxLift = null,
  surprise = null,
  rayWork = null,
  rayWorkPacked = false,
  sunBounceCompensation = false,
  maxLods = MAX_LODS,
  stride = null,
  phase = null,
  threads = 0,
  /**
   * §11.13 THE FAR DUTY (2026-09-03). A uniform in (0, 1]: the fraction of
   * each frame's rays that trace BEYOND cascade `farFrom − 1`'s far bound. The
   * rest stop there and deposit into cascades 0..farFrom−1 only — the far
   * bins they would have sampled receive neither a count nor a T, so the
   * §12.40.4 influx compensation lengthens those blocks' windows and their
   * effective sample counts hold (variance-neutral at rest by construction;
   * a surprised block still relaxes its own decay). Stratified per ray by an
   * integer hash of the ray's R2 index and the frame stamp, so the far
   * samples rotate through directions rather than pinning to a subset.
   *
   * Measured need (Bistro ultra, the street overview, pose-locked): rays
   * capped at cascade 1's far bound (2.8 m at LOD 0) took the deposit trace
   * 12.2 → 5.9 ms and [J] 12.85 → 4.9 ms — the far intervals are 14 of the
   * transport's 25 ms, and 60 % of the shaded hits.
   *
   * Null (the default, and every gate) leaves the kernel byte-identical.
   */
  farDuty = null,
  farFrom = 2,
  /**
   * §11.13 THE NEED FLOOR, in rays: a far bin holding fewer than this many
   * (decayed) samples in the ray's direction forces the ray's far intervals
   * regardless of the duty — a fresh far block fills at the full rate, and a
   * bin whose count sags refills before the resolve's MIN_WEIGHT floor can
   * turn it UNKNOWN. Two atomic loads per ray, hoisted nowhere: the bin is a
   * function of the direction.
   *
   * ONE ray, not four (11:45): the far cascades hold ~1.2 M bins against
   * ~70 k rays a frame on Bistro, so most far bins never accumulate four
   * decayed samples — at 4 the floor forced 60 % of the rays far, for good.
   * At 1 a bin is released the moment it is KNOWN, which is the floor's job.
   *
   * 1/32 RAY, not 1 (12:20, the bin-count histogram): even cascade 1, which
   * the duty never touches, holds 41 % empty bins and 25 % below one ray —
   * a far probe fed by a few distant pixels spreads them over 512–2048
   * directions and cannot lift every bin past one decayed ray, so a one-ray
   * floor forced 35 % of ALL rays for good. The resolve calls a bin known
   * down to MIN_WEIGHT = 1/64 ray; the floor's job is to fill UNKNOWN bins
   * and keep known ones above that line, and 1/32 (a 2× margin) is exactly
   * that. At the compensated far keep a single sample stays above it for
   * thousands of frames, so at rest the floor releases a bin at its FIRST
   * sample.
   */
  farNeed = 1 / 32,
  /**
   * §12.82. `srcShade.js`'s `sunTerm(lighting)` — a THUNK returning the split
   * source's `{direction, irradiance}` as of THIS frame. Null leaves `[F]`
   * emitting exactly the four assignments it always did, so a build without the
   * split is byte-identical and the bins' four extra words simply stay zero.
   */
  sunClose = null,
} = {}) {
  const { probeTable, freeStack } = store;
  const { scratch, payload, stats, binTotal, w0 } = bins;
  // The hit list is a REGION of a buffer this kernel also writes bins into, so
  // a base that disagrees with the store's would corrupt real bins at a bin
  // index nothing else in the frame would ever produce — silent, and not
  // reproducible from an image. Cheap to make impossible.
  // ── WHICH KERNEL SHADES, AND IT IS EXACTLY ONE OF THEM (§12.53) ───────────
  //
  // `shadeHit` shades inline and deposits the radiance here; `attribute`
  // appends a record and [J] does both. Both together would shade every hit
  // TWICE and deposit it twice — a 2× brightening with no counter that says so,
  // because every tally would read exactly as healthy as it does now.
  if (shadeHit && attribute) {
    throw new Error(
      "createSrcDepositFrame: `shadeHit` and `attribute` are the two halves of the same " +
      "expression in two different arrangements — supplying both deposits every hit twice",
    );
  }
  if (attribute && !secondary) {
    throw new Error(
      "createSrcDepositFrame: `attribute` defers shading to [J], which reads the hit list — " +
      "so it requires `secondary`, or every hit's radiance is computed by nobody",
    );
  }
  if (secondary) {
    if (secondary.base !== bins.hitListBase || !(secondary.capacity > 0)
      || secondary.capacity > bins.hitCapacity) {
      throw new Error(
        `createSrcDepositFrame: [J]'s hit list (base ${secondary.base}, capacity ` +
        `${secondary.capacity}) does not match the bin store's tail (base ` +
        `${bins.hitListBase}, capacity ${bins.hitCapacity}) — the store must be ` +
        "built with `secondaryCapacity` before the deposit can append to it",
      );
    }
  }
  // Same rule as [J]'s base: the statistics are a REGION of the buffer this
  // kernel writes bins into, so a base that disagrees with the store's would
  // corrupt real bins at an index nothing else in the frame produces.
  if (surprise) {
    if (surprise.statBase !== bins.blockStatBase) {
      throw new Error(
        `createSrcDepositFrame: the surprise bundle's statBase ${surprise.statBase} does ` +
        `not match the bin store's ${bins.blockStatBase}`,
      );
    }
    // A NaN base compiles, runs, and scatters atomics into the BIN region —
    // the `blockBase` precedent one function up, which spent a round of the
    // temporal gate indexing `freeStack[NaN]`. Cheap to make impossible.
    for (const info of bins.cascades) {
      if (!Number.isInteger(surprise.statBase + BSTAT_WORDS * info.blockBase)) {
        throw new Error(
          `createSrcDepositFrame: cascade ${info.cascade} has no block base for its statistics`,
        );
      }
    }
  }
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const stampBase = store.blockStampBase;
  // The pool's sizes flow into the kernels as UNIFORMS, not literals — a pool
  // change must not change the WGSL text, or the driver's compiled-shader
  // cache goes cold for every kernel (srcCapacityUniforms.js carries the whole
  // argument, and scripts/gi-src-wgsl-stability.html is its receipt). The JS
  // sums below keep running for the guards; the graph reads the uniform that
  // holds the same value. influx/surprise follow their own arms, so an
  // unarmed build binds nothing new.
  const cap = {
    ...binPartitionUniforms(bins),
    ...blockChainUniforms(store, bins, {
      live: Number.isInteger(store.blockLiveBase),
      stamp: Number.isInteger(store.blockStampBase),
      held: Number.isInteger(store.blockHeldBase),
      influx: influxLift != null,
      surprise: surprise != null,
    }),
  };
  const passes = [];

  // The transport's thread → pixel map, identical to srcRays' by construction:
  // same helper, same uniforms, and `threads` comes from the same caller. The
  // fallback is the old pixel-sized dispatch, which is what every gate runs.
  const strided = stride && phase && threads > 0;
  const pixelOf = strided ? (t) => transportPixel(t, stride, phase).toVar() : (t) => t;
  const outOfRange = strided ? (p) => p.greaterThanEqual(uint(pixelCount)) : null;
  const dispatchCount = strided ? threads : pixelCount;
  // ── HOW WIDE IS [E] DISPATCHED, SAID OUT LOUD ─────────────────────────────
  //
  // ⛔ AN INDIRECT DISPATCH LIVED HERE AND WAS REVERTED — twice-refuted, and the
  // second time it broke the editor outright. [E] launches the tier's baked
  // `threads` (65,536 at high) however few rays the worklist holds, so making
  // the dispatch as wide as the worklist looked like free money. It is not:
  //   · `probe:gi-src-cost SWEEP=cap`, indirect CONFIRMED live by this line —
  //     off 126,382 rays 3.353 ms · cap 32 1.931 · 16 1.920 · 8 1.977. Flat
  //     below 32, exactly as before. Dispatch width is NOT the floor.
  //   · Then the user's editor read `shadedHitsPerFrame: 0` against 51,397 rays
  //     with NO console error: probes populating, [E] dispatching ZERO
  //     workgroups. It worked in headless Chrome and produced nothing in
  //     WebView2 — the same harness-vs-editor divide that has the deposit at
  //     1.5 ms here and 16.5 ms there, and it is unexplained in both directions.
  // Anyone re-attempting it: prove the indirect buffer's contents on the EDITOR,
  // not in the harness, before trusting a single number from it.
  //
  // The line itself stays. A null result from a dispatch change is unreadable
  // without it — [E] early-returns past the worklist either way, so a build on
  // the wrong arm renders AND measures identically to one on the right arm.
  console.log(`[gi] src deposit dispatch: DIRECT ${dispatchCount} threads${strided ? " (strided)" : ""}`);

  // ── decay ─────────────────────────────────────────────────────────────────
  // Every allocated bin, every frame, exactly where the clear pass used to be —
  // it is the clear pass, with `0` generalized to `keep`. See the header for why
  // the temporal blend is here rather than on the resolved payload.
  //
  // **A CLAIMED BLOCK IS ZEROED, NOT DECAYED, AND THE STAMP IS HOW IT KNOWS.**
  // The accumulators are persistent now, so a block handed to a new probe still
  // holds the dead probe's history — geometrically unrelated, and it would fade
  // in over ~1/α frames rather than being discarded. `createCompactPass` stamps
  // the frame number onto every block it claims, and a stamp that equals THIS
  // frame's makes `keep` zero. No fresh-block list, no second dispatch, no
  // ordering subtlety: the claim runs three dispatches before this one and the
  // stamp goes stale by itself.
  //
  // ROUND, DO NOT TRUNCATE — `srcMath.js`'s `decayFixed` header carries the
  // measurement. A truncating decay settles one quantum per frame short of its
  // true steady state, which is an ABSOLUTE deficit and therefore a relative
  // darkening that grows as the light dims: −15% at a six-quantum influx. The
  // fixed point rounding brings with it (an accumulator parks at ≤ 5 and stops)
  // is covered 200× over by `MIN_WEIGHT`, which the resolve needs anyway.
  //
  // f32 is exact enough for the multiply. A u32 past 2^24 loses bits on the way
  // into a float, but the loss is relative-2e-7 against a rounding deficit three
  // orders larger.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    const b = i.mul(BIN_WORDS).toVar();
    const k = float(keep ?? 0).toVar();
    // 1 while a probe holds this bin's block, else 0 (srcProbes' live word).
    // A dead block is skipped below unless it was released THIS frame (its
    // stamp says so) — that frame it must still be zeroed, so the phantoms
    // §12.21 named never come back.
    const live = uint(1).toVar();
    if (keep && frameStamp) {
      // Which block owns this bin. The cascades partition `binTotal` at bases
      // the graph reads from UNIFORMS, not literals (srcCapacityUniforms.js —
      // a pool grow must not change this kernel's text, or the driver's
      // compiled-shader cache goes cold for it). The JS sums below stay for
      // the guards only; a chain of at most four comparisons either way.
      for (const info of bins.cascades) {
        const c = info.cascade;
        const lo = capAt(cap.binBase, c);
        const hi = capAt(cap.binHi, c);
        // A NaN here compiles, runs, and reads the probe free stack — see
        // `blockBase`'s note in `createSrcBinStore`. Cheap to make impossible.
        if (!Number.isInteger(stampBase + info.blockBase)) {
          throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no block base`);
        }
        const base = capAt(cap.stampBase, c);
        // §11.13: a far cascade's inflow is `farDuty` of what the ray count
        // says (the influx word is written on the RAY side and cannot see the
        // cut), so its base keep is compensated the same way §12.40.4
        // compensates the cap: `1 − (1−keep)·duty` holds the effective sample
        // count. Applied to the BASE so the surprise relax composes on it.
        const farCascade = !!farDuty && farFrom > 0 && farFrom < bins.cascades.length && info.cascade >= farFrom;
        const keepBase = farCascade
          ? float(1.0).sub(float(1.0).sub(float(keep)).mul(float(farDuty)))
          : float(keep);
        const influxB = store.blockInfluxBase + info.blockBase;
        if (influxLift && !Number.isInteger(influxB)) {
          throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no influx base`);
        }
        const surpriseB = store.blockSurpriseBase + info.blockBase;
        if (surprise && !Number.isInteger(surpriseB)) {
          throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no surprise base`);
        }
        If(i.greaterThanEqual(uint(lo)).and(i.lessThan(uint(hi))), () => {
          const block = i.sub(uint(lo)).div(uint(info.bins)).toVar();
          if (farCascade) k.assign(keepBase);
          if (cap.liveBase) live.assign(freeStack.element(uint(capAt(cap.liveBase, c)).add(block)));
          // The ratio the compensation multiplied `1−keep` by, 1 when the
          // branch below is skipped. Hoisted only when the surprise mix needs
          // something to interpolate FROM; without the bundle this var does
          // not exist and the emitted decay is byte-identical.
          const lifted = surprise ? float(1).toVar() : null;
          // ── the α compensation (§12.40.4) — BEFORE the stamp check, which
          // must win: a freshly claimed block is zeroed whatever its (stale)
          // influx word says; the reverse order would turn `k = 0` back into
          // `1 − lift` and fade a dead probe's history into its successor.
          //
          // `keep′ = 1 − (1−keep)·ratio` holds the accumulator's effective
          // sample count `influx/(1−keep′)` at its UNCAPPED value, so the
          // per-probe ray cap stops buying variance with its ray cut. The
          // lift interpolates the ratio toward 1 (`r·(1−lift) + lift`), and
          // both the `INFLUX_ONE` skip and the lift-at-1 path are EXACT:
          // `1−k` and `1−(1−k)` are exact f32 subtractions for k ∈ [0.5, 1]
          // (the result's mantissa always fits), so an uncapped word or a
          // fully lifted frame decays bit-identically to the plain branch.
          if (influxLift) {
            const infl = freeStack.element(uint(capAt(cap.influxBase, c)).add(block)).toVar();
            If(infl.lessThan(uint(INFLUX_ONE)).and(float(influxLift).lessThan(1.0)), () => {
              const lift = float(influxLift).toVar();
              const ratio = float(infl).div(INFLUX_ONE).toVar();
              const l = ratio.mul(float(1.0).sub(lift)).add(lift).toVar();
              if (lifted) lifted.assign(l);
              k.assign(float(1.0).sub(float(1.0).sub(k).mul(l)));
            });
          }
          // ── SURPRISE: A BLOCK WHOSE TRUTH MOVED FORGETS FASTER ──────────
          //
          // `keep′ = 1 − (1−keep)·mix(lifted, surpriseF, u)` — from THIS
          // block's own compensated rate at u = 0 to the fast-α rate at u = 1.
          // Written against `keep` and `lifted` rather than against the `k` the
          // branch above produced, so the two mechanisms compose instead of the
          // second one re-compensating the first one's answer.
          //
          // `u == 0` SKIPS THE WHOLE BRANCH, which is the compatibility claim
          // and not an arithmetic identity: the surprise words init to zero and
          // a build with nothing publishing them decays bit-for-bit as before
          // (the `INFLUX_ONE` skip above is the same move for the same reason).
          //
          // Before the stamp check, which must win — a freshly claimed block is
          // zeroed whatever its (stale) surprise word says.
          if (surprise) {
            const u = freeStack.element(uint(capAt(cap.surpriseBase, c)).add(block)).toVar();
            If(u.greaterThan(uint(0)), () => {
              const t = float(u).div(float(SURPRISE_ONE)).toVar();
              // WGSL `mix(a,b,t)` written out — the mirror (`keepCompensated`)
              // must reproduce this rounding, and `a + (b−a)·t` does not.
              const f = lifted.mul(float(1.0).sub(t))
                .add(float(surprise.surpriseF).mul(t)).toVar();
              k.assign(float(1.0).sub(float(1.0).sub(keepBase).mul(f)));
            });
          }
          // ── S1: FREEZE A HELD BLOCK (locality retention) ────────────────
          //
          // `blockHeldBase` carries the frame on which the age pass decided to
          // KEEP this block's probe while no pixel was looking at it. Stamped
          // this frame ⇒ the probe is off-screen, receiving no rays, and its
          // accumulated answer is the thing retention exists to preserve — so
          // `keep = 1` and the payload is held exactly rather than faded.
          //
          // Without this, retention is worse than useless: the block would come
          // back holding `keep^N` of what it knew, and the gather would read a
          // DARK VOTE where it previously read an absence — the one thing R1
          // forbids. `srcProbes.blockHeldBase` carries the whole argument,
          // including why the test is visibility and not "did it get rays".
          //
          // BEFORE the claim-stamp check below, which must still win: a block
          // handed to a NEW probe this frame is zeroed whatever any older
          // stamp says.
          const heldB = store.blockHeldBase + info.blockBase;
          if (!Number.isInteger(heldB)) {
            throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no held base`);
          }
          If(freeStack.element(uint(capAt(cap.heldBase, c)).add(block)).equal(frameStamp), () => {
            k.assign(float(1));
          });
          const stamp = freeStack.element(uint(base).add(block)).toVar();
          If(stamp.equal(frameStamp), () => { k.assign(float(0)); live.assign(uint(1)); });
        });
      }
    }
    // ══ ⭐⭐ AN EMPTY BIN'S DECAY IS A NO-OP, AND THE POOL IS MOSTLY EMPTY ════
    //
    // This dispatch is sized by the BIN POOL, not by the live set: `BIN_BUDGET`
    // is a tier constant, so a scene that fills 43% of its probe capacity still
    // pays 100% of the decay every frame. Measured on the user's Bistro
    // (2026-08-30): 26,431 live probes of 61,440 capacity — c0 19853/32768,
    // c1 5211/16384, c2 1447/8192, c3 404/4096 — so **56% of all bins belong to
    // blocks no probe has ever claimed**, and the pass was the single most
    // expensive GI dispatch in the frame at 13.3 ms isolated.
    //
    // ══ WHY SKIPPING IS BIT-EXACT AND NOT AN APPROXIMATION ══════════════════
    //
    // `count == 0` implies every DECAYED word is already 0:
    //   · R/G/B, T and SR/SG/SB are each incremented only alongside `count`,
    //     and by at most `DEPOSIT_SCALE` per deposit while `count` gets exactly
    //     `DEPOSIT_SCALE` — so each is <= `count` on arrival;
    //   · the decay `floor(x·k + 0.5)` is MONOTONIC in x, so `x <= count` is
    //     preserved through any number of frames of decay.
    // Therefore count 0 ⇒ all seven are 0, and `floor(0·k + 0.5) = 0` — the
    // stores this loop would emit write 0 over 0. Nothing downstream can see
    // the difference; the resolve retires the bin on `count < MIN_WEIGHT`
    // regardless of what the radiance words hold.
    //
    // ⚠ `k <= 0` MUST STILL RUN THE LOOP, AND THAT IS NOT A DETAIL. `BIN_SN`
    // is never decayed, so a long-dead block can hold a stale normal after its
    // count has faded to zero — and the ONE event that must clear it is the
    // reclaim, which arrives as `k = 0` from the claim-stamp check above. Skip
    // that frame and a new probe inherits a dead one's direction, which is
    // exactly the §12.82 defect whose comment below records it costing "a
    // quarter to a half of the picture's light". So the guard is "has content
    // OR is being zeroed", never "has content".
    // Dead block (no probe holds it, not released this frame): its words are
    // already what a decay would leave them — skip the count read too.
    const binCount = uint(0).toVar();
    If(live.notEqual(uint(0)), () => {
      binCount.assign(atomicLoad(scratch.element(b.add(uint(BIN_COUNT)))));
    });
    If(live.notEqual(uint(0)).and(binCount.greaterThan(uint(0)).or(k.lessThanEqual(0))), () => {
      for (let w = 0; w < BIN_WORDS; w++) {
        const e = scratch.element(b.add(uint(w)));
        if (w === BIN_SN && globalThis.__giSunSplitHoldNormal === true) {
          // ⚠ DIAGNOSTIC. Emits NO store for the normal at all, so the decay
          // cannot touch it — a reclaimed block then inherits a dead probe's
          // direction, which is wrong on purpose. It is what separated the two
          // ways the cached normal can go missing, and it is kept because it is
          // the control for the trap below.
        } else if (w === BIN_SN) {
          // §12.82: THE NORMAL IS NOT A SUM, SO IT MUST NOT BE DECAYED. It is a
          // packed pair of 15-bit fields plus a flag; `floor(x·keep)` on that is
          // not a dimmer normal, it is a DIFFERENT direction, and at keep 0.98 it
          // would walk across the octahedral map a few thousand texels per second
          // while every counter read healthy. Held exactly, and zeroed on the one
          // event that invalidates it — the block being handed to another probe,
          // which is the `keep == 0` the stamp check above produces.
          //
          // ══ ⛔⛔ AND IT IS AN `If`, NOT A `select`. THIS COST A SESSION. ══════
          //
          // The obvious form is `atomicStore(e, select(k > 0, atomicLoad(e), 0))`
          // — read it back and write it unchanged when the block survives. **That
          // zeroes the word EVERY FRAME.** `ConditionalNode` does not emit a
          // ternary here: it `isolate()`s each branch and emits a real `if`
          // statement assigning into a hoisted property, and an `atomicLoad` of
          // the very word being `atomicStore`d does not survive that round trip.
          //
          // Nothing said so. Every counter stayed healthy — merge orphan rate,
          // corners, `noBlock`, the shade tallies, all unchanged — and the SHADE
          // gate passed at 0.0000% because the defect is not in the expression,
          // it is in the store. What it cost on the user's Level, with the sun
          // PINNED (where a re-aiming split must be a no-op): only **9% of bins
          // carrying radiance still had a normal** against the 48-53% of hits that
          // face the sun, so **the picture lost a quarter to a half of its light**.
          // The tell was arithmetic, not visual: the normal count tracked THIS
          // FRAME's facing hits at a flat 0.73 while radiance plainly survived
          // across frames (47,540 lit bins against 13,045 hits).
          //
          // ⭐ THE RULE, which generalizes past this file: **never round-trip an
          // atomic through a conditional to "keep" it. Write only when you mean to
          // change it.** The `If` below touches the word on the one frame it is
          // reclaimed and leaves it alone otherwise — which is also one fewer
          // read-modify-write per bin per frame on the hottest buffer in the
          // module. `__giSunSplitHoldNormal` is the control that proved it: with
          // the store removed entirely the ratio went 9% → 52-63% and the luma
          // came back (leg0 0.00154 → 0.00283 against a 0.00259-0.00294 baseline).
          If(k.lessThanEqual(0), () => { atomicStore(e, uint(0)); });
        } else {
          atomicStore(e, uint(floor(float(atomicLoad(e)).mul(k).add(0.5))));
        }
      }
    });
    // ⚠ OUTSIDE the empty-bin guard: these are indexed by the DISPATCH index,
    // not by the bin, and clearing the stats and the per-block sums has nothing
    // to do with whether bin `i` happens to hold anything.
    If(i.lessThan(uint(STAT_WORDS)), () => { atomicStore(stats.element(i), uint(0)); });
    // ── the per-block SUM words, cleared beside the stats ───────────────────
    //
    // ONLY the two SUM words. `ACC_L`/`ACC_W`/`DRIFT` are the block's
    // persistent belief and clearing them here would reset the statistic every
    // frame — the mechanism would never accumulate enough evidence to say
    // anything, and it would look exactly like a scene that is never
    // surprising. The frame order is what makes this the right pass: the
    // publish ([D1''], srcRays) reads LAST frame's sums BEFORE this decay runs,
    // so a clear here is a clear of already-consumed evidence.
    if (surprise) {
      If(i.lessThan(uint(store.blockTotal)), () => {
        const s = uint(surprise.statBase).add(i.mul(uint(BSTAT_WORDS))).toVar();
        atomicStore(scratch.element(s.add(uint(BSTAT_SUM_L))), uint(0));
        atomicStore(scratch.element(s.add(uint(BSTAT_SUM_W))), uint(0));
      });
    }
    // [J]'s hit list is a WITHIN-FRAME structure — every entry carries a bin
    // slot that stops meaning anything the moment [C] re-claims blocks — so its
    // count is cleared here, in the pass that already runs first and already
    // clears the stats, rather than in a dispatch of its own. Same idiom
    // `srcRays.js` uses for the ray worklist's count word.
    if (secondary) {
      If(i.equal(uint(0)), () => {
        atomicStore(scratch.element(uint(secondary.base)), uint(0));
      });
    }
  })().compute(binTotal));

  // ── [E] trace and scatter ─────────────────────────────────────────────────
  //
  // Dispatched over TRANSPORT THREADS, not pixels — see `transportPixel` in
  // srcMathTsl. This pass is 22.3 ms of a 34 ms SRC chain on the user's editor
  // and roughly 6 ms of that was launching threads that immediately returned,
  // which is what a pixel-sized dispatch under a ray ceiling costs (§12.32).
  //
  // WITH A WORKLIST (`rayWork`, §12.44) the thread → pixel map is [D5]'s own
  // winner list, dense: thread i traces worklist pixel i and the trailing
  // threads return in WHOLE warps. This is what converts the per-probe cap's
  // ray cut into wall-clock — with the classic mapping the ~19% winners were
  // SCATTERED, so nearly every 32-wide warp still contained a tracer and the
  // pass ran at full width (19 ms for 25k rays, the user's editor). The
  // mapping-agreement hazard below also DISSOLVES on this path: the list is
  // written by [D5] in the same frame, so [E] cannot enumerate a pixel [D5]
  // did not own.
  //
  // ⚠ ON THE CLASSIC PATH (no worklist — gates built before it) THE MAPPING
  // MUST MATCH srcRays' [D1]/[D5] EXACTLY — same helper, same `stride`/
  // `phase` uniforms, same frame. [D5] writes `pixelRayBase` only for the
  // pixels it owns, so a mismatch here reads an entry from an OLDER frame: a
  // stale-but-plausible base pointing into a segment this frame allocated to
  // a different probe. No crash, no assertion — a handful of probes lit with
  // another probe's rays.
  const compacted = !!rayWork;
  passes.push(Fn(() => {
    let i;
    let packetOffset = null;
    if (compacted) {
      If(instanceIndex.greaterThanEqual(atomicLoad(rayWork.element(uint(0)))), () => { Return(); });
      const entry = atomicLoad(rayWork.element(instanceIndex.add(uint(1)))).toVar();
      i = rayWorkPacked ? entry.bitAnd(uint(PRIORITY_REP_PIXEL_MASK)).toVar() : entry;
      if (rayWorkPacked) packetOffset = entry.shiftRight(uint(PRIORITY_REP_PIXEL_BITS)).mul(uint(raysPerPixel)).toVar();
    } else {
      i = pixelOf(instanceIndex.toVar());
      if (outOfRange) If(outOfRange(i), () => { Return(); });
    }
    const base = pixelRayBase.element(i).toVar();
    If(base.equal(uint(SLOT_EMPTY)), () => { Return(); });
    if (packetOffset) base.addAssign(packetOffset);
    const probe0 = pixelProbe.element(i).toVar();
    If(probe0.equal(uint(SLOT_EMPTY)), () => { Return(); });

    const px = readPixel(i);
    const P = vec3(px.position).toVar();
    // The normal arrives ALREADY faced toward the camera (srcSystem's
    // `readPixel`) — one definition, shared with the gather, so the
    // hemisphere these rays fill is the hemisphere that reads them back.
    const Nrm = vec3(readNormal(i)).normalize().toVar();

    // The pixel's LOD sets the interval ladder. Recomputed rather than read out
    // of the probe key: the key read is free but this kernel already carries the
    // occupancy pyramid, the probe table, the bins and the per-pixel buffers,
    // and the portable 8-storage-buffer limit is the constraint AGENTS.md leads
    // with. It agrees by construction — same camera uniform, same
    // `lodAtDistance`, same `floor` — which is why it is a recompute and not a
    // second source of truth.
    const lod = floor(lodAtDistance(chebyshev(P, camera), spacing0, maxLods)).toVar();
    const bounds = [];
    for (let c = 0; c < N; c++) bounds.push(intervalBoundary(c, lod, spacing0).toVar());
    // §11.13 INSTRUMENT (build-time, dev only): `__giSrcReachCascade = k` caps every
    // ray at cascade k's far bound, so the trace cost of the intervals beyond it
    // can be read off the deposit's own timing at one pose. The capped intervals
    // read as misses (T = 1, sky) — a measurement, never a look.
    const reachCapC = Number(globalThis.__giSrcReachCascade);
    const reach = Number.isInteger(reachCapC) && reachCapC >= 0 && reachCapC < N - 1
      ? bounds[reachCapC]
      : bounds[N - 1];

    // THE ANCESTOR CHAIN, walked once per pixel rather than once per ray. Every
    // ray from this pixel deposits into the same chain — it is a property of the
    // PIXEL's c0 probe, not of the direction — so hoisting it out of the ray
    // loop saves N dependent loads per ray.
    const chain = [probe0];
    for (let c = 1; c < N; c++) {
      const prev = chain[c - 1];
      const up = uint(SLOT_EMPTY).toVar();
      If(prev.notEqual(uint(SLOT_EMPTY)), () => {
        up.assign(probeTable.element(prev.mul(PROBE_WORDS).add(PROBE_PARENT)));
      });
      chain.push(up);
    }

    // The chain's BIN BLOCKS, read here for the same reason the chain itself is
    // hoisted: a block is a property of the probe, not of the ray, so reading
    // it inside the ray loop would be N dependent loads per ray for a value
    // that cannot change. `SLOT_EMPTY` covers both "no probe" and "probe with
    // no block", so the scatter below tests one condition instead of two.
    const blocks = [];
    for (let c = 0; c < N; c++) {
      const blk = uint(SLOT_EMPTY).toVar();
      If(chain[c].notEqual(uint(SLOT_EMPTY)), () => {
        blk.assign(probeTable.element(chain[c].mul(PROBE_WORDS).add(PROBE_BLOCK)));
      });
      blocks.push(blk);
    }

    // ══ THE RAY LOOP IS A GPU LOOP, AND IT HALVES THE KERNEL (§13.17) ═══════
    //
    // It used to be `for (let k = 0; k < raysPerPixel; k++)` — a JS loop, so
    // it unrolled at graph-build time and emitted the WHOLE body once per ray:
    // the trace, the hit shading, the NEE set, the analytic emitter shapes and
    // the cascade scatter. At the shipping `raysPerPixel = 2` that is two
    // complete copies, and this kernel is 83.5% of a GI boot (§13.16: 49.1 s
    // of a 58.8 s TTFF, 13.6 s isolated). The dumped WGSL showed it plainly —
    // `giEmitterFactor` appeared 8× in `main`, in two byte-identical clusters
    // 1,700 lines apart differing only in which hit point they read.
    //
    // Rolling it changes NOTHING about the estimator: iterations are
    // independent, each ray still gets its own R2 index, its own trace and its
    // own scatter, in the same order. That is what makes this the cheapest
    // startup win available here — unlike the emitter-slot roll (§13.16 fix A),
    // which has to preserve an importance CDF, and unlike gating the slots on
    // scene content (§12.47.1), which re-introduces a mid-game rebuild.
    //
    // ⚠ `k` was used in exactly ONE place (`base.add(uint(k))`) — audited
    // before the change, because a JS-indexed array inside the body would not
    // survive becoming a GPU index. The cascade scatter below still unrolls on
    // its own JS `c`, deliberately: N=4 iterations of a few atomics, and those
    // read `chain[c]`/`blocks[c]`/`bounds[c]`, JS arrays of captured nodes.
    Loop({ start: uint(0), end: uint(raysPerPixel), type: "uint", condition: "<" }, ({ i: k }) => {
      // `n` is the ray's place in the global R2 sequence. It is handed to the
      // trace and the shading as a fourth/third argument that neither real
      // implementation uses — a SYNTHETIC one does, and that is what makes the
      // gate's diff bit-exact (see `srcRef.js`'s `traceAndDeposit` header).
      const n = base.add(k).toVar();
      const dir = rayDirection(n, Nrm, jitterX, jitterY).toVar();
      // ── §11.13 THE FAR DUTY — see the option's note ─────────────────────
      //
      // NEAR FIRST, THEN FAR (12:40). The first form drew the duty BEFORE the
      // trace and let the need floor force a ray whose far bin was unknown —
      // but a far bin in a direction the near geometry blocks can never
      // receive a sample (the ray hits at 1 m and deposits nothing far), so
      // it stayed unknown and forced its rays for good: 29 % of all rays at
      // rest, at any floor. Now the ray traces cascades 0..farFrom−1 first;
      // only a ray that CLEARED them consults the stratum and the floor, and
      // traces the far intervals as a second segment [nearBound, reach] of
      // the same ray. ONE call site of the descent, inside a two-iteration
      // GPU loop (§13.14.5's law), and a near trace bounded by its own tMax
      // for every ray. With `farDuty` null the plain single call is emitted
      // — the gates' byte-identity.
      const farOn = !!farDuty && farFrom > 0 && farFrom < N;
      let r = null;
      let reachC = null;
      if (!farOn) {
        r = trace(P, dir, reach, n);
      } else {
        const nearBound = bounds[farFrom - 1];
        // lowbias32 over (ray index ⊕ frame stamp · φ⁻¹): 24 bits → [0, 1).
        const salt = frameStamp ? uint(frameStamp) : uint(0);
        const x = n.bitXor(salt.mul(uint(0x9E3779B9))).toVar();
        x.assign(x.bitXor(x.shiftRight(uint(16))).mul(uint(0x7feb352d)));
        x.assign(x.bitXor(x.shiftRight(uint(15))).mul(uint(0x846ca68b)));
        x.assign(x.bitXor(x.shiftRight(uint(16))));
        const h = x.shiftRight(uint(8)).toFloat().mul(1 / 16777216);
        const stratum = h.lessThan(float(farDuty)).toVar();
        const goFar = float(0).toVar();     // 1 = the far segment was traced
        const needWeight = Math.max(0, Math.round(Number(farNeed) * DEPOSIT_SCALE));
        // The result vars are declared BEFORE the loop (a var declared inside
        // a Loop body is scoped to it in WGSL); a superset of both closures'
        // fields, the absent ones dropped after the build.
        const rOut = {
          hit: float(0).toVar(), t: float(-1).toVar(),
          position: vec3(0).toVar(), exactPosition: vec3(0).toVar(), normal: vec3(0, 1, 0).toVar(),
          slot: float(-1).toVar(), uvPacked: float(0).toVar(), dynObj: float(-1).toVar(), insideMover: float(0).toVar(), voxel: vec3(0).toVar(),
        };
        // The closure DECLARES its result fields (`trace.fields`): the loop body
        // below is built at shader-build time, after this JS has run, so the
        // shape cannot be read off a call. A closure without the declaration
        // (the gate's synthetic trace) gets the five every arm returns.
        const present = (trace.fields ?? ["hit", "t", "position", "exactPosition", "normal"])
          .filter((key) => rOut[key] != null);
        Loop({ start: int(0), end: int(2), type: "int", condition: "<" }, ({ i: seg }) => {
          const isFar = seg.equal(int(1));
          const segMax = select(isFar, reach, nearBound);
          const rs = trace(P, dir, segMax, n, select(isFar, nearBound, float(BVH_SELF_BIAS_M_FALLBACK)));
          for (const key of present) {
            if (rs[key] == null) throw new Error(`createSrcDepositFrame: the trace declared "${key}" but returned null`);
            rOut[key].assign(rs[key]);
          }
          // A hit ends the ray, near or far.
          If(rOut.hit.greaterThan(0.5), () => { Break(); });
          // The near segment cleared: draw the duty, then the floor — any far
          // bin in this direction below `farNeed` rays of evidence forces the
          // far segment (a blockless far probe cannot receive the sample and
          // does not vote). Both only for rays that can actually reach it.
          If(isFar.not(), () => {
            const need = float(0).toVar();
            if (needWeight > 0) {
              for (let c = farFrom; c < N; c++) {
                const infoC = bins.cascades[c];
                If(blocks[c].notEqual(uint(SLOT_EMPTY)), () => {
                  const bC = dirToBin(dir, infoC.width).toVar();
                  const slotC = uint(capAt(cap.binBase, c))
                    .add(blocks[c].mul(uint(infoC.bins)))
                    .add(binMorton(bC.x, bC.y))
                    .mul(BIN_WORDS)
                    .toVar();
                  const cnt = atomicLoad(scratch.element(slotC.add(uint(BIN_COUNT))));
                  If(cnt.lessThan(uint(needWeight)), () => { need.assign(1); });
                });
              }
            }
            const far = stratum.or(need.greaterThan(0.5));
            goFar.assign(select(far, float(1), float(0)));
            if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_FAR)), select(far, uint(1), uint(0)));
            if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_FAR_NEED)), select(far.and(stratum.not()), uint(1), uint(0)));
            if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_CAPPED_MISS)), select(far, uint(0), uint(1)));
            If(far.not(), () => { Break(); });
          });
        });
        r = Object.fromEntries(Object.keys(rOut).map((key) => [key, present.includes(key) ? rOut[key] : null]));
        reachC = select(goFar.greaterThan(0.5), int(N - 1), int(farFrom - 1)).toVar();
      }
      const hit = r.hit.greaterThan(0.5).toVar();
      const d = select(hit, r.t, float(-1)).toVar();
      // ── §11.15 A RAY BORN INSIDE A MOVER IS NOT A SAMPLE (2026-09-03) ────
      //
      // The lattice does not avoid the inside of things: at s0 = 0.35 m a
      // probe lands inside a character's torso, and a skinned rig's capsule
      // proxies then enclose it in a nearly closed cavity of the body's own
      // albedo (the Y Bot: #ffffff, R4-clamped to 0.9). Its rays hit the
      // capsule INTERIORS at once; those hits pass the sun's shadow test (an
      // interior point sits at the body surface's depth from the light) and
      // the any-hit ray ignores movers, so the cavity is lit from inside at
      // ρ = 0.9 — and the R4 loop amplifies that by 1/(1−0.9). Measured on
      // the user's Sponza: tile texels at 13.7 where the sunlit floor peaks
      // at 0.9, the bounce term 12× its physical share, the character
      // clipped white, every shadow 2× the path tracer (plan §11.14).
      //
      // The mover trace flips every hit normal to face the ray, so the side
      // is carried as a bit instead (`inside` — the raw normal pointed ALONG
      // the ray, i.e. the hit was reached from inside). Such a ray
      // deposits nothing — not T = 1 below the hit, not a count, not a hit-list
      // entry: the probe's bins stay UNKNOWN there, which the gather's
      // coverage renormalization treats as an absence (R1), never as dark.
      // Static geometry keeps its face-forward rule (§12.26.4: record normals
      // carry no reliable sign); only movers are judged here.
      const insideMover = r.insideMover != null
        ? hit.and(float(r.insideMover).greaterThan(0.5)).toVar()
        : null;
      if (insideMover) {
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_INSIDE_MOVER)), select(insideMover, uint(1), uint(0)));
      }

      // WHICH CASCADE OWNS THIS HIT. `splitCascade`'s running-sum form: no loop,
      // no break, no divergence. A miss lands on N, which is past every cascade
      // and therefore deposits (0, 1) everywhere — the correct reading of "the
      // ray was never blocked".
      const own = int(N).toVar();
      If(hit, () => {
        const k2 = int(0).toVar();
        for (const b of bounds) k2.addAssign(int(select(d.greaterThan(b), 1, 0)));
        own.assign(k2);
      });
      // §11.13: the cascades this ray may DEPOSIT into. A capped ray's miss
      // is a miss through cascades 0..farFrom−1 only — it never looked
      // further, so the far bins get neither a count nor an all-clear.
      const ownReach = (reachC ? own.min(reachC) : own).toVar();
      if (insideMover) If(insideMover, () => { ownReach.assign(int(-1)); });

      // ── [J]'s RECORD (§12.39 as a capture, §12.53 as the whole interface) ──
      //
      // ATTRIBUTE-AND-APPEND. The record is everything [J] needs to finish the
      // expression at this hit — the point, the flipped normal, R4's clamped ρ,
      // the raw emission and its R5 flag, and the ray index NEE's stratified
      // draw is a pure function of. The SLOT below is what decides whether an
      // entry is appended at all: a miss never reaches the radiance branch, so
      // its slot stays EMPTY and it falls out with no test of its own — which
      // is also why the deferred build does no shading work for the ~76% of
      // rays that miss, where the inline one shaded every single one and threw
      // the answer away.
      //
      // The attribution runs for EVERY ray, hit or miss, exactly as the inline
      // shader did, so `shaded` / `unattributed` / `albedoClamped` keep the
      // denominators every reading of `unattributedRate` has ever used.
      const sec = secondary && attribute
        ? {
            P: vec3(0).toVar(),
            N: vec3(0).toVar(),
            rho: vec3(0).toVar(),
            Le: vec3(0).toVar(),
            emitter: float(-1).toVar(),
            slot: uint(SLOT_EMPTY).toVar(),
            sumL: uint(SLOT_EMPTY).toVar(),
          }
        : null;
      if (attribute) {
        const a = attribute(r, dir);
        sec.P.assign(vec3(a.P));
        sec.N.assign(vec3(a.n));
        sec.rho.assign(vec3(a.rho));
        sec.Le.assign(vec3(a.emissive));
        if (a.emitter != null) sec.emitter.assign(float(a.emitter));
        // §11.15: a hit on a MOVER travels as emitter flag -2. The shade only
        // ever tests `0 <= emitter < emitters.length`, so any negative is
        // "not an NEE light"; [J]'s ledger reads -2 as "mover row".
        if (r.dynObj != null) {
          If(hit.and(float(r.dynObj).greaterThanEqual(0)), () => {
            sec.emitter.assign(float(-2));
            if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_MOVER_HITS)), uint(1));
          });
        }
      }

      // Radiance at the hit, in fixed point — the INLINE form ONLY. With
      // `attribute` not one node of this is built: [J] owns the radiance, the
      // `Lmax` conversion and both of that conversion's instruments
      // (`STAT_CLAMPED`, `STAT_MAXL`). Everything below is verbatim what it was
      // before the split, which is what keeps the un-split kernel — the one
      // `scripts/gi-src-deposit.html` gates bit-exactly against the CPU mirror —
      // byte-identical.
      const deferred = !!attribute;
      let fx = null;
      let lumaFx = null;
      if (!deferred) {
        const sunGain = sunBounceCompensation ? float(1).toVar() : null;
        const sunChromaGain = sunBounceCompensation
          ? float(sunBounceChromaGainForCascade(0)).toVar()
          : null;
        if (sunGain) {
          for (let c = 1; c < N; c++) {
            const ownsCascade = own.greaterThanEqual(int(c));
            sunGain.assign(select(
              ownsCascade,
              float(sunBounceGainForCascade(c)),
              sunGain,
            ));
            sunChromaGain.assign(select(
              ownsCascade,
              float(sunBounceChromaGainForCascade(c)),
              sunChromaGain,
            ));
          }
        }
        const L = shadeHit
          ? vec3(shadeHit(r, dir, n, sunGain, sunChromaGain)).toVar()
          : vec3(0).toVar();
        const unit = L.div(float(lmax).max(1e-6)).toVar();
        const clamped = unit.x.max(unit.y).max(unit.z).greaterThan(1).toVar();
        fx = [
          unit.x.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
          unit.y.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
          unit.z.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
        ];

        // The ray's luma in the SAME fixed point the RGB words carry, shifted
        // into the sum's scale ONCE per ray rather than per cascade — the shift
        // is what keeps a top-cascade block's whole-frame sum clear of u32 (the
        // `SUM_SHIFT` docstring carries the arithmetic). Deferred, [J] does this
        // add instead, against the address the record's word 15 carries.
        lumaFx = surprise
          ? float(fx[0]).mul(0.2126).add(float(fx[1]).mul(0.7152)).add(float(fx[2]).mul(0.0722))
            .toUint().shiftRight(uint(SUM_SHIFT)).toVar()
          : null;

        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_RAYS)), uint(1));
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_HITS)), select(hit, uint(1), uint(0)));
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_CLAMPED)), select(clamped, uint(1), uint(0)));
        if (srcStatsOn()) atomicMax(stats.element(uint(STAT_MAXL)), fx[0].max(fx[1]).max(fx[2]));
      } else {
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_RAYS)), uint(1));
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_HITS)), select(hit, uint(1), uint(0)));
      }
      const tfx = select(hit, d.max(0).mul(T_FIXED), float(0)).toUint().toVar();
      if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_TSUM)), tfx);
      if (srcStatsOn()) atomicMax(stats.element(uint(STAT_TMAX)), tfx);

      // The scatter itself. Unrolled over cascades because `binGridWidth` and
      // `binCount` are compile-time per level — the bin grid is a different
      // SHAPE at every cascade, so this could not be a dynamic loop even if the
      // divergence were free.
      for (let c = 0; c < N; c++) {
        const blk = blocks[c];
        const info = bins.cascades[c];
        // A probe that failed to claim a block has NOWHERE to put this, and
        // "nowhere" is dropped-and-counted rather than redirected: writing it
        // into block 0 would corrupt the bins of a probe that is working.
        If(blk.equal(uint(SLOT_EMPTY)).and(chain[c].notEqual(uint(SLOT_EMPTY)))
          .and(int(c).lessThanEqual(ownReach)), () => {
          if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_NOBLOCK)), uint(1));
        });
        If(blk.notEqual(uint(SLOT_EMPTY)).and(int(c).lessThanEqual(ownReach)), () => {
          const b = dirToBin(dir, info.width).toVar();
          const m = binMorton(b.x, b.y).toVar();
          const slot = uint(capAt(cap.binBase, c))
            .add(blk.mul(uint(info.bins)))
            .add(m)
            .mul(BIN_WORDS)
            .toVar();
          // `c < own` — the ray crossed this interval unblocked: T = 1, no
          // radiance. `c == own` — blocked here: the radiance, T = 0. Both
          // increment `count`, because a bin's count is how many rays SAMPLED
          // it, and a blocked sample is a sample.
          //
          // ONE RAY IS `DEPOSIT_SCALE`, not 1 — count and T are fixed-point
          // weights so that the decay can take a fraction of them. A fresh ray
          // therefore arrives at full weight, 2^F, and decays from there.
          // ── THE DEPOSIT SPLIT, AND ONLY THE RADIANCE MOVES (§12.53) ────
          //
          // `c < own` — the ray crossed this interval unblocked: T = 1, no
          // radiance. `c == own` — blocked here: the radiance, T = 0. Both
          // increment `count`, because a bin's count is how many rays SAMPLED
          // it, and a blocked sample is a sample.
          //
          // ONE RAY IS `DEPOSIT_SCALE`, not 1 — count and T are fixed-point
          // weights so that the decay can take a fraction of them. A fresh ray
          // therefore arrives at full weight, 2^F, and decays from there.
          //
          // DEFERRED, the `c == own` branch deposits NOTHING and merely
          // remembers where the radiance goes. Everything else on this line —
          // the below-hit T = 1 deposits, the count on the whole chain up to
          // and including the owner, a miss's all-clear at `own == N`, the
          // `DEPOSITS` tally — is unchanged and stays here, because none of it
          // is a function of what the hit is WORTH.
          If(int(c).lessThan(own), () => {
            atomicAdd(scratch.element(slot.add(uint(BIN_T))), uint(DEPOSIT_SCALE));
          }).Else(() => {
            if (!deferred) {
              atomicAdd(scratch.element(slot.add(uint(BIN_R))), fx[0]);
              atomicAdd(scratch.element(slot.add(uint(BIN_G))), fx[1]);
              atomicAdd(scratch.element(slot.add(uint(BIN_B))), fx[2]);
            }
            // THE SAME BIN THE RADIANCE MUST LAND IN. Exactly one cascade
            // takes this branch (`c == own`), so this assigns once per ray, and
            // it is captured HERE rather than recomputed in [J] because `own`,
            // the ancestor chain and the block claim are all this frame's and
            // none of them survives into a second dispatch.
            if (sec) sec.slot.assign(slot);
            // Same argument for the block's evidence word: [J] cannot re-derive
            // `blockBase[own] + blk` without the chain, so the ADDRESS travels.
            if (sec && surprise) {
              sec.sumL.assign(
                uint(surprise.statBase + BSTAT_WORDS * info.blockBase)
                  .add(blk.mul(uint(BSTAT_WORDS)))
                  .add(uint(BSTAT_SUM_L)),
              );
            }
          });
          atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), uint(DEPOSIT_SCALE));
          if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_DEPOSITS)), uint(1));
          // ── the block's evidence, beside its bins ──────────────────────
          //
          // CLEAR (transmittance-only) deposits carry ZERO luma but still add
          // their WEIGHT, and that asymmetry is the whole point: a mover
          // crossing in front of a wall turns radiance deposits into clear
          // ones, so the block's mean luma FALLS and the statistic sees an
          // occlusion change no radiance-only sum could. `own` is what
          // separates them, and it is the same test the branch above makes.
          //
          // Deferred, the WEIGHT half stays here (it is `DEPOSIT_SCALE` per
          // deposit and knows nothing about radiance) and the LUMA half is [J]'s
          // — which is exactly the same partition the bins themselves take. The
          // `c < own` luma add is dropped rather than moved because it adds
          // ZERO: `select(c < own, 0, lumaFx)` is a no-op atomic on every clear
          // deposit, so no evidence changes hands.
          if (surprise) {
            const sb = uint(surprise.statBase + BSTAT_WORDS * info.blockBase)
              .add(blk.mul(uint(BSTAT_WORDS))).toVar();
            if (!deferred) {
              atomicAdd(
                scratch.element(sb.add(uint(BSTAT_SUM_L))),
                select(int(c).lessThan(own), uint(0), lumaFx),
              );
            }
            atomicAdd(scratch.element(sb.add(uint(BSTAT_SUM_W))), uint(DEPOSIT_SCALE >> SUM_SHIFT));
          }
        });
      }

      // ── the hit list append ───────────────────────────────────────────────
      //
      // An attributed hit with a destination bin, and nothing else: a MISS never
      // reaches the radiance branch so its slot stays EMPTY, and a hit whose
      // owning probe never claimed a block has nowhere to put its radiance
      // either (it is already counted as a `NOBLOCK` deposit above). The SLOT is
      // the whole test — `want` was redundant with it from the day the append
      // was written, because the sink and the slot were set by the same rays.
      //
      // The count is claimed with an atomic and the entry written only if it
      // fits. An over-capacity list is not supposed to happen — the capacity is
      // `transportThreads × raysPerPixel`, an exact bound on the rays this
      // dispatch can fire — so the counter exists to say the bound was wrong
      // rather than to make dropping acceptable.
      if (sec) {
        If(sec.slot.notEqual(uint(SLOT_EMPTY)), () => {
          const idx = atomicAdd(scratch.element(uint(secondary.base)), uint(1)).toVar();
          If(idx.lessThan(uint(secondary.capacity)), () => {
            const e = uint(secondary.base + 1).add(idx.mul(uint(SEC_HIT_WORDS))).toVar();
            const put = (w, v) => { atomicStore(scratch.element(e.add(uint(w))), v); };
            put(SEC_P + 0, floatBitsToUint(sec.P.x));
            put(SEC_P + 1, floatBitsToUint(sec.P.y));
            put(SEC_P + 2, floatBitsToUint(sec.P.z));
            put(SEC_N + 0, floatBitsToUint(sec.N.x));
            put(SEC_N + 1, floatBitsToUint(sec.N.y));
            put(SEC_N + 2, floatBitsToUint(sec.N.z));
            put(SEC_RHO + 0, floatBitsToUint(sec.rho.x));
            put(SEC_RHO + 1, floatBitsToUint(sec.rho.y));
            put(SEC_RHO + 2, floatBitsToUint(sec.rho.z));
            put(SEC_SLOT, sec.slot);
            // ── THE §12.53 WORDS ──────────────────────────────────────────
            //
            // Written unconditionally, including as zeros on the inline build,
            // rather than left as whatever last frame's entry held: a reader
            // added later gets a defined value instead of a stale one that
            // happens to decode (the rule the reserved pair shipped under).
            put(SEC_LE + 0, floatBitsToUint(sec.Le.x));
            put(SEC_LE + 1, floatBitsToUint(sec.Le.y));
            put(SEC_LE + 2, floatBitsToUint(sec.Le.z));
            put(SEC_EMITTER, floatBitsToUint(sec.emitter));
            // The ray index is a u32 and is stored as one — [J] hands it
            // straight to `hashKey`, which is where NEE's stratified draw comes
            // from, so a float round-trip here would move the pick.
            put(SEC_RAY, n);
            put(SEC_SUML, sec.sumL);
            put(SEC_DIR + 0, floatBitsToUint(dir.x));
            put(SEC_DIR + 1, floatBitsToUint(dir.y));
            put(SEC_DIR + 2, floatBitsToUint(dir.z));
            If(sec.emitter.lessThan(-1.5), () => { atomicAdd(stats.element(uint(STAT_MOVER_RECORDS)), uint(1)); });
          }).Else(() => {
            if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SEC_OVERFLOW)), uint(1));
          });
        });
      }
    });
  })().compute(dispatchCount));

  // ── [F] resolve ───────────────────────────────────────────────────────────
  // ZERO-COUNT BINS ARE UNKNOWN, NOT ZERO — `srcMath.js`'s `resolveBin` returns
  // null and this writes T = -1, which is outside transmittance's [0,1] range
  // and so cannot be mistaken for data. Feeding an unsampled bin in as black is
  // a hard cliff at the edge of every sparsely-sampled region, and the sparsity
  // table in §12.13.4 (0.78 rays per bin on average) is why that edge is
  // everywhere rather than exotic.
  //
  // ══ AND UNDER DECAY THE TEST IS A WEIGHT FLOOR, NOT A ZERO TEST ════════════
  //
  // A bin that stops being sampled does not stop reporting: its weight fades
  // geometrically and `L = ΣR/Σcount` renormalizes by that same fading weight,
  // so the bin keeps FULL confidence in an ever-staler answer. That alone would
  // be defensible (it is the best information there is, and R1 prefers it to an
  // absence). What is not defensible is where it ends up.
  //
  // **THE RADIANCE HITS ZERO BEFORE THE COUNT DOES.** `R` is `L/Lmax` of
  // `count`, so for any bin dimmer than the ceiling `R` is the smaller number
  // and truncation retires it first. The last few frames of a bin's life
  // therefore read `R = 0, count = small` — full-confidence BLACK, which is
  // precisely the dark vote R1 forbids, arriving by arithmetic rather than by
  // anyone deciding it. `MIN_WEIGHT` retires the bin while `R` still has bits:
  // a sixty-fourth of one ray, which is ~40 frames of not being sampled at
  // α = 0.1, and quantizes `L` no coarser than `Lmax/1024`.
  //
  // At α = 1 every count is a whole number of rays, so the floor never binds and
  // this is the zero test it always was.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    const b = i.mul(BIN_WORDS).toVar();
    // `atomicLoad`, not a plain read: `scratch` is declared atomic and WGSL will
    // not implicitly convert `atomic<u32>` to `u32` — it fails at
    // CreateShaderModule, which surfaces as a validation error rather than a
    // wrong picture. Free on every target we ship to (srcProbes.js says the
    // same about its own counters).
    // Dead blocks (see the decay's live word) keep their last payload and are
    // unreachable — every reader goes through a live probe or checks the word
    // itself (tiles, merge). A block released this frame still resolves, to
    // UNKNOWN, exactly as before.
    if (frameStamp && Number.isInteger(store.blockLiveBase)) {
      const live = uint(1).toVar();
      for (const info of bins.cascades) {
        const c = info.cascade;
        // Uniforms, not literals — same partition the keep pass reads, same
        // reason (srcCapacityUniforms.js).
        const lo = capAt(cap.binBase, c);
        const hi = capAt(cap.binHi, c);
        If(i.greaterThanEqual(uint(lo)).and(i.lessThan(uint(hi))), () => {
          const block = i.sub(uint(lo)).div(uint(info.bins)).toVar();
          live.assign(freeStack.element(uint(capAt(cap.liveBase, c)).add(block)));
          If(freeStack.element(uint(capAt(cap.stampBase, c)).add(block)).equal(frameStamp), () => {
            live.assign(uint(1));
          });
        });
      }
      If(live.equal(uint(0)), () => { Return(); });
    }
    const count = atomicLoad(scratch.element(b.add(uint(BIN_COUNT)))).toVar();
    If(count.lessThan(uint(MIN_WEIGHT)), () => {
      writePayloadUnknown(payload, i);
      Return();
    });
    // §11.25 — CONFIDENCE, from the same count. `N` is rays of accumulated
    // weight (count carries DEPOSIT_SCALE per ray); `c = N/(N+K)` is the
    // posterior weight of the bin's own measurement against K pseudo-rays of
    // the prior. No threshold anywhere: one ray is worth 1/(1+K), K rays half.
    // `__giSrcConfidence = false` pins it to 1 — the previous estimator.
    const rays = float(count).div(float(DEPOSIT_SCALE)).toVar();
    // §11.29: the prior's share collapses with evidence — `srcMath.confidenceOf`
    // is the twin; F = 0 restores the plain `N/(N+K)`.
    const fullRays = confidenceFullRays();
    const base = rays.div(rays.add(float(confidencePriorRays()))).toVar();
    const conf = confidenceArmed()
      ? (fullRays > 0
        ? float(1).sub(float(1).sub(base).mul(rays.negate().div(float(fullRays)).exp())).toVar()
        : base)
      : float(1).toVar();
    const inv = float(1).div(float(count)).toVar();
    // `Lmax/count`, with NO `2^F` in it: radiance carries `2^F` per ray and
    // count now carries `2^F` per ray as well, so the two scales cancel exactly
    // and this stays a single multiply however the fixed point is retuned.
    const toL = float(lmax).mul(inv).toVar();
    const L = vec3(
      float(atomicLoad(scratch.element(b.add(uint(BIN_R))))).mul(toL),
      float(atomicLoad(scratch.element(b.add(uint(BIN_G))))).mul(toL),
      float(atomicLoad(scratch.element(b.add(uint(BIN_B))))).mul(toL),
    ).toVar();

    // ── §12.82: CLOSE THE SUN, HERE, AGAINST THE SUN THAT EXISTS NOW ────────
    //
    //     L += (ΣS/Σcount) · E_sun(now) · max(0, n̂ · l(now))
    //
    // `ΣS/Σcount` is the evidence-weighted mean transfer `ρ/π · V` — the same
    // exponentially-weighted-over-RAYS mean the radiance gets, for the same
    // reason (a frame's single ray must not outvote another frame's twenty).
    // `n̂` is the bin's cached hit normal. NEITHER depends on where the sun is,
    // so a day cycle no longer invalidates a single stored word, and the ray
    // budget goes back to buying convergence instead of chasing a moving target.
    //
    // ⚠ **THE PAYLOAD DOES NOT GROW, AND THAT IS THE WHOLE REASON THIS IS
    // AFFORDABLE.** Everything downstream — the merge, the tiles, the gather,
    // the screen resolve — reads the same four words it always did, because the
    // sun is closed BEFORE the payload is written rather than carried through
    // four more passes. The cost of the split is confined to `scratch` and to
    // this multiply.
    //
    // ⚠ `n̂` IS TESTED ON THE RAW WORD, not on the decoded vector: octahedral
    // (0,0) decodes to a perfectly good −Z, so an empty bin would otherwise
    // claim to be a surface facing away and take whatever sun that gets.
    if (sunClose) {
      const nw = atomicLoad(scratch.element(b.add(uint(BIN_SN)))).toVar();
      // ⚠ THE DENOMINATOR IS BINS THAT CARRY **RADIANCE**, NOT BINS THAT
      // RESOLVE. Most resolved bins are pure TRANSMITTANCE — a ray crossed them
      // and was blocked higher up — and those correctly have no surface and no
      // normal, so counting them buried the ratio that matters in a ~93%
      // constant. A bin with radiance and NO normal is the actual failure: its
      // sun is dropped and nothing else says so.
      const lit = float(atomicLoad(scratch.element(b.add(uint(BIN_R)))))
        .add(float(atomicLoad(scratch.element(b.add(uint(BIN_G))))))
        .add(float(atomicLoad(scratch.element(b.add(uint(BIN_B))))))
        .greaterThan(0).toVar();
      If(lit, () => {
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SUN_LIVE)), uint(1));
        if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SUN_NORMAL)), select(normalPresent(nw), uint(1), uint(0)));
      });
      If(normalPresent(nw), () => {
        const { direction, irradiance } = sunClose();
        const nrm = unpackNormal(nw).toVar();
        // ── THE BISECT HATCH. `__giSunSplitCos = false` closes the sun with a
        //    cosine of ONE, which is wrong on purpose: it separates "the cached
        //    TRANSFER is missing or too small" from "the cached NORMAL is
        //    wrong". Both produce the same symptom — a picture that is darker
        //    than the un-split arm WITH THE SUN PINNED — and no image statistic
        //    tells them apart. Never a shipping arm; it over-lights every
        //    surface the sun grazes.
        const cos = globalThis.__giSunSplitCos === false
          ? float(1).toVar()
          : nrm.dot(direction).max(0).toVar();
        // The transfer's own scale: `ρ/π · V` lives in [0, 1], deposited as
        // `x · DEPOSIT_SCALE` per ray exactly as `count` is, so the two scales
        // cancel in `ΣS/Σcount` and `inv` alone converts it — no `Lmax` here,
        // because a transfer is a reflectance and not a radiance.
        const tr = vec3(
          float(atomicLoad(scratch.element(b.add(uint(BIN_SR))))),
          float(atomicLoad(scratch.element(b.add(uint(BIN_SG))))),
          float(atomicLoad(scratch.element(b.add(uint(BIN_SB))))),
        ).mul(inv).toVar();
        L.addAssign(tr.mul(irradiance).mul(cos));
      });
      // ⚠ AND BACK UNDER THE CEILING. Every deposit was clamped to `Lmax` on
      // its way into the fixed point, so `ΣR/Σcount` has ALWAYS been bounded by
      // it and every consumer downstream — the merge, the tiles, the gather —
      // has only ever seen values in [0, Lmax]. The sun now arrives AFTER that
      // clamp, as a float, so without this a bright enough sun would hand them
      // a range they have never been tested against. `STAT_CLAMPED` is still
      // the instrument for "the ceiling is binding at all"; it counts the same
      // event one stage earlier, and a sun that saturates here saturated there.
      L.assign(L.min(vec3(float(lmax))));
    }

    writePayload(payload, i, L, float(atomicLoad(scratch.element(b.add(uint(BIN_T))))).mul(inv), conf);
  })().compute(binTotal));

  return {
    passes,
    /**
     * The decay pass on its own — `passes[0]`, named so a gate can age the
     * accumulators without tracing anything. Nothing in the engine dispatches
     * it separately, and the temporal gate's exact arm needs precisely that:
     * one frame of deposits, then pure decay, where the recurrence is
     * `floor(x·keep)` with no ray nondeterminism in it at all.
     */
    decay: passes[0],
    /**
     * [E] and [F] by name, because [J] DISPATCHES BETWEEN THEM (srcSystem's
     * `passes` list) and slicing the array by index at the call site would put
     * the frame order at the mercy of this list's length. `passes` stays the
     * whole chain for every caller that has no [J].
     */
    scatter: passes[1],
    resolve: passes[2],
    raysPerPixel,

    /** One frame's tallies. The `Lmax` decision's instrument — see the header. */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) {
        return {
          dispatched: false, rays: 0, hits: 0, deposits: 0, clamped: 0, noBlock: 0, shaded: 0,
          secondaryHits: 0, secondaryClamped: 0, secondaryOverflow: 0, sunLive: 0, sunNormal: 0, sunFacing: 0, sunShaded: 0,
        };
      }
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const rays = v[STAT_RAYS] >>> 0;
      const hits = v[STAT_HITS] >>> 0;
      const shaded = v[STAT_SHADED] >>> 0;
      const cappedMiss = v[STAT_CAPPED_MISS] >>> 0;
      return {
        dispatched: true,
        rays,
        hits,
        // ── THE SHADE TALLIES (Phase 5) ─────────────────────────────────────
        //
        // Read here because a black frame has SIX distinct causes and they are
        // indistinguishable on screen: nothing shaded (no `shadeHit`), nothing
        // hit (the trace), nothing attributed (no palette), nothing lit (no
        // light reached the hit), everything shadowed (the visibility ray), or
        // radiance produced and lost downstream. Each of these separates one.
        //
        // ⚠ `shaded` MUST be a number and not `undefined` — the formatter's
        // `r.shaded ? … : "NO HIT SHADING"` reads a missing field exactly like a
        // zero, so an earlier half-landed edit had the log confidently reporting
        // "NO HIT SHADING" on a frame whose shader was built and running. An
        // instrument that is only partly wired lies with the same confidence as
        // one that is not wired at all.
        shaded,
        unattributed: v[STAT_UNATTRIBUTED] >>> 0,
        shadowRays: v[STAT_SHADOWRAYS] >>> 0,
        // §11.44: tree-sample visibilities the per-probe cache answered.
        visCached: v[STAT_VIS_CACHED] >>> 0,
        visNoBlock: v[STAT_VIS_NOBLOCK] >>> 0,
        visNoRow: v[STAT_VIS_NOROW] >>> 0,
        visFilling: v[STAT_VIS_FILLING] >>> 0,
        visFull: v[STAT_VIS_FULL] >>> 0,
        // §11.13: rays that traced their far intervals, and the share of all
        // rays they were. `farRate` 1 = no far duty in effect.
        farRays: v[STAT_FAR] >>> 0,
        farRate: rays > 0 ? (v[STAT_FAR] >>> 0) / rays : 0,
        farNeedRays: v[STAT_FAR_NEED] >>> 0,
        // §11.15: rays born inside a mover, dropped without a deposit.
        insideMoverRays: v[STAT_INSIDE_MOVER] >>> 0,
        moverHits: v[STAT_MOVER_HITS] >>> 0,
        moverRecords: v[STAT_MOVER_RECORDS] >>> 0,
        farNeedRate: rays > 0 ? (v[STAT_FAR_NEED] >>> 0) / rays : 0,
        emissiveHits: v[STAT_EMISSIVE] >>> 0,
        emitZeroed: v[STAT_EMIT_ZEROED] >>> 0,
        albedoClamped: v[STAT_ALBEDO_CLAMPED] >>> 0,
        importanceFloored: v[STAT_IMPORTANCE_FLOORED] >>> 0,
        // ── [J]'s three ────────────────────────────────────────────────────
        //
        // `secondaryHits` is the one that says the multibounce pass RAN, and it
        // is read from the deposit's buffer because [J] writes into it (R7 —
        // the secondary kernel owns no buffer of its own). Zero with hit
        // shading on and `shading.secondary` true means the pass exists in
        // `passes` and produced nothing, which is a dispatch or pipeline
        // failure and NOT a dim second bounce.
        secondaryHits: v[STAT_SECONDARY] >>> 0,
        secondaryClamped: v[STAT_SEC_CLAMPED] >>> 0,
        secondaryOverflow: v[STAT_SEC_OVERFLOW] >>> 0,
        // §12.82: how many resolved bins could actually close the sun. A ratio
        // far below 1 means the sun is being dropped for want of a cached
        // normal, which looks exactly like every other way the split can be
        // dark. Both zero on a build without the split.
        sunLive: v[STAT_SUN_LIVE] >>> 0,
        sunNormal: v[STAT_SUN_NORMAL] >>> 0,
        // The HIT-side rate, which has the denominator the bin ratio lacks.
        sunFacing: v[STAT_SUN_FACING] >>> 0,
        sunShaded: v[STAT_SUN_SHADED] >>> 0,
        // §11.13: a capped ray that hit nothing inside its shortened reach is
        // counted by the attribution as a miss (it has no surface), but it is
        // not a miss of the SCENE. Both terms drop it so the rate keeps the
        // meaning every reading before the far duty had.
        unattributedRate: shaded - cappedMiss > 0
          ? Math.max(0, (v[STAT_UNATTRIBUTED] >>> 0) - cappedMiss) / (shaded - cappedMiss)
          : 0,
        cappedMisses: cappedMiss,
        deposits: v[STAT_DEPOSITS] >>> 0,
        clamped: v[STAT_CLAMPED] >>> 0,
        // Deposits the block pool refused. Zero unless BIN_BUDGET is short for
        // the scene — see STAT_NOBLOCK and its probe-side twin.
        noBlock: v[STAT_NOBLOCK] >>> 0,
        hitRate: rays > 0 ? hits / rays : 0,
        // Deposits per ray. Bounded by the cascade count and equal to it only
        // when every ray escapes; a value near 1 means almost everything is
        // blocked in cascade 0, which is a scene fact rather than a bug.
        perRay: rays > 0 ? v[STAT_DEPOSITS] / rays : 0,
        meanT: hits > 0 ? (v[STAT_TSUM] >>> 0) / hits / T_FIXED : 0,
        maxT: (v[STAT_TMAX] >>> 0) / T_FIXED,
        maxRadianceFraction: (v[STAT_MAXL] >>> 0) / DEPOSIT_SCALE,
      };
    },
  };
}
