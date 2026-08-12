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
  select,
  uint,
  vec3,
} from "three/tsl";
import {
  CASCADE_COUNT,
  MAX_LODS,
  SECONDARY_HIT_WORDS,
  W0,
  binCount,
  binGridWidth,
} from "./srcConfig.js";
import {
  binMorton,
  chebyshev,
  dirToBin,
  intervalBoundary,
  lodAtDistance,
  rayDirection,
  transportPixel,
} from "./srcMathTsl.js";
import {
  INFLUX_ONE,
  PROBE_BLOCK,
  PROBE_PARENT,
  PROBE_WORDS,
  SLOT_EMPTY,
} from "./srcProbes.js";

/** Per-bin accumulator layout. Five words, one atomic buffer. */
export const BIN_R = 0;
export const BIN_G = 1;
export const BIN_B = 2;
export const BIN_T = 3;     // fixed-point WEIGHT of clear deposits
export const BIN_COUNT = 4;  // fixed-point WEIGHT of all deposits
export const BIN_WORDS = 5;

/** Fractional bits in the radiance accumulator. §12.13.4 measured this. */
export const DEPOSIT_F = 16;
export const DEPOSIT_SCALE = 1 << DEPOSIT_F;

/**
 * Accumulated weight below which a bin is UNKNOWN rather than dim — one
 * sixty-fourth of a single ray. Only reachable under temporal decay; the
 * resolve's header says what goes wrong without it.
 */
export const MIN_WEIGHT = DEPOSIT_SCALE >> 6;

/** Resolved payload: rgb + transmittance, with T < 0 meaning UNKNOWN. */
export const PAYLOAD_WORDS = 4;
export const PAYLOAD_UNKNOWN = -1;

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
 * Words 10-11 are reserved, which also pads the stride to 48 bytes.
 */
export const SEC_P = 0;     // world position of the hit
export const SEC_N = 3;     // face-forwarded normal (srcShade's `faceForward`)
export const SEC_RHO = 6;   // albedo AFTER `clampLoopAlbedo` — R4's in-loop ρ
export const SEC_SLOT = 9;  // destination bin's WORD base, already ×BIN_WORDS
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
 * asked for by name, and none of them is decoration:
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
 *   whose second bounce happens to be dim. No image statistic separates those
 *   two, so the gate asserts this counter rather than a brightness.
 * · `SEC_CLAMPED` counts the split clamp's own residual — see `srcSecondary.js`
 *   on why the secondary term saturates against `Lmax` separately from the
 *   primary one, and why that is accepted rather than fixed.
 *
 * They live here because `srcSecondary.js` owns no buffer: three storage
 * bindings, all of them load-bearing, exactly as `createSrcShadeCounters`
 * arranged for the hit shader.
 */
export const STAT_SECONDARY = 15;
export const STAT_SEC_CLAMPED = 16;
export const STAT_SEC_OVERFLOW = 17;
export const STAT_WORDS = 18;
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
    atomicAdd(stats.element(uint(word)), uint(amount));
  };
  return {
    shaded: bump(STAT_SHADED),
    unattributed: bump(STAT_UNATTRIBUTED),
    shadowRays: bump(STAT_SHADOWRAYS),
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
  // The bins, then [J]'s hit list — one buffer, in that order, so every bin
  // index keeps the address it had before the tail existed. `hitListBase` is
  // the count word; entries start one word after it.
  const binWords = binTotal * BIN_WORDS;
  const hitCapacity = Math.max(0, Math.floor(secondaryCapacity));
  const hitListBase = binWords;
  const hitWords = hitCapacity > 0 ? 1 + hitCapacity * SEC_HIT_WORDS : 0;
  const scratchBytes = (binWords + hitWords) * 4;
  const payloadBytes = binTotal * PAYLOAD_WORDS * 4;
  if (scratchBytes > maxBytes || payloadBytes > maxBytes) {
    throw new Error(
      `createSrcBinStore: ${(binTotal / 1e6).toFixed(2)}M bins needs ` +
      `${(scratchBytes / 1048576).toFixed(0)}MB of scratch (including ` +
      `${(hitWords * 4 / 1048576).toFixed(0)}MB of [J] hit list) and ` +
      `${(payloadBytes / 1048576).toFixed(0)}MB of payload, past the ` +
      `${(maxBytes / 1048576).toFixed(0)}MB storage-buffer binding limit — ` +
      "lower srcConfig's BIN_BUDGET, which is what sizes the block pool",
    );
  }

  const scratch = instancedArray(new Uint32Array(binWords + hitWords), "uint").toAtomic();
  const payload = instancedArray(new Float32Array(binTotal * PAYLOAD_WORDS), "float");
  const stats = instancedArray(new Uint32Array(STAT_WORDS), "uint").toAtomic();

  return {
    cascades,
    binTotal,
    w0,
    scratch,
    payload,
    stats,
    /** [J]'s region. `hitCapacity` 0 means the tail was not allocated. */
    hitListBase,
    hitCapacity,
    bytes: scratchBytes + payloadBytes + STAT_WORDS * 4,
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
 * @param {(hit, dir, rayIndex, sink) => object} [options.shadeHit]  vec3 radiance
 *   at a hit, from `srcShade.js`'s `createSrcHitShader`. Default black — see the
 *   header. `rayIndex` is `n`, the ray's place in the global R2 sequence, and
 *   the shader needs it for the same reason the gate's synthetic trace does: a
 *   pure function of a u32 is bit-identical across a boundary where an RNG state
 *   is not. `sink` is passed ONLY when `secondary` is — see below.
 * @param {{base: number, capacity: number}} [options.secondary]  [J]'s hit list
 *   in `scratch`'s tail (`createSrcBinStore`'s `hitListBase`/`hitCapacity`).
 *   Supplied, this kernel appends one entry per shaded hit that has somewhere to
 *   deposit; omitted, NOT ONE NODE OF THAT IS BUILT and the emitted WGSL is
 *   byte-identical to the pre-[J] kernel — which is what keeps every gate
 *   written before the multibounce (and `scripts/gi-src-deposit.html`, whose
 *   synthetic shader ignores extra arguments) comparable rather than merely
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
 */
export function createSrcDepositFrame(store, bins, {
  pixelProbe,
  pixelRayBase,
  pixelCount,
  raysPerPixel = 1,
  trace,
  shadeHit = null,
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
  rayWork = null,
  maxLods = MAX_LODS,
  stride = null,
  phase = null,
  threads = 0,
} = {}) {
  const { probeTable, freeStack } = store;
  const { scratch, payload, stats, binTotal, w0 } = bins;
  // The hit list is a REGION of a buffer this kernel also writes bins into, so
  // a base that disagrees with the store's would corrupt real bins at a bin
  // index nothing else in the frame would ever produce — silent, and not
  // reproducible from an image. Cheap to make impossible.
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
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const stampBase = store.blockStampBase;
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
    if (keep && frameStamp) {
      // Which block owns this bin. The cascades partition `binTotal` at bases
      // known when the graph is built, so this is a chain of at most four
      // comparisons against JS constants, not a search.
      for (const info of bins.cascades) {
        const lo = info.binBase;
        const hi = lo + info.bins * info.blockCapacity;
        const base = stampBase + info.blockBase;
        // A NaN here compiles, runs, and reads the probe free stack — see
        // `blockBase`'s note in `createSrcBinStore`. Cheap to make impossible.
        if (!Number.isInteger(base)) {
          throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no block base`);
        }
        const influxB = store.blockInfluxBase + info.blockBase;
        if (influxLift && !Number.isInteger(influxB)) {
          throw new Error(`createSrcDepositFrame: cascade ${info.cascade} has no influx base`);
        }
        If(i.greaterThanEqual(uint(lo)).and(i.lessThan(uint(hi))), () => {
          const block = i.sub(uint(lo)).div(uint(info.bins)).toVar();
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
            const infl = freeStack.element(uint(influxB).add(block)).toVar();
            If(infl.lessThan(uint(INFLUX_ONE)).and(float(influxLift).lessThan(1.0)), () => {
              const lift = float(influxLift).toVar();
              const ratio = float(infl).div(INFLUX_ONE).toVar();
              const lifted = ratio.mul(float(1.0).sub(lift)).add(lift).toVar();
              k.assign(float(1.0).sub(float(1.0).sub(k).mul(lifted)));
            });
          }
          const stamp = freeStack.element(uint(base).add(block)).toVar();
          If(stamp.equal(frameStamp), () => { k.assign(float(0)); });
        });
      }
    }
    for (let w = 0; w < BIN_WORDS; w++) {
      const e = scratch.element(b.add(uint(w)));
      atomicStore(e, uint(floor(float(atomicLoad(e)).mul(k).add(0.5))));
    }
    If(i.lessThan(uint(STAT_WORDS)), () => { atomicStore(stats.element(i), uint(0)); });
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
    if (compacted) {
      If(instanceIndex.greaterThanEqual(atomicLoad(rayWork.element(uint(0)))), () => { Return(); });
      i = atomicLoad(rayWork.element(instanceIndex.add(uint(1)))).toVar();
    } else {
      i = pixelOf(instanceIndex.toVar());
      if (outOfRange) If(outOfRange(i), () => { Return(); });
    }
    const base = pixelRayBase.element(i).toVar();
    If(base.equal(uint(SLOT_EMPTY)), () => { Return(); });
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
    const reach = bounds[N - 1];

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
      const r = trace(P, dir, reach, n);
      const hit = r.hit.greaterThan(0.5).toVar();
      const d = select(hit, r.t, float(-1)).toVar();

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

      // ── [J]'s CAPTURE (§12.39) ────────────────────────────────────────────
      //
      // The shader hands back the three things the secondary pass cannot
      // recompute — the hit point, the normal it faced-forward, and the albedo
      // AFTER R4's in-loop ceiling — through a sink rather than a return value,
      // because everything else about `shadeHit` is a `vec3` and widening that
      // contract would touch every caller including the gate's synthetic one.
      // `want` is set for every shaded ray; the SLOT below is what decides
      // whether an entry is appended, so a miss (which never reaches the
      // radiance branch) falls out with no test of its own.
      const sec = secondary && shadeHit
        ? {
            P: vec3(0).toVar(),
            N: vec3(0).toVar(),
            rho: vec3(0).toVar(),
            want: uint(0).toVar(),
            slot: uint(SLOT_EMPTY).toVar(),
          }
        : null;
      const sink = sec
        ? (hitP, hitN, rho) => {
            sec.P.assign(vec3(hitP));
            sec.N.assign(vec3(hitN));
            sec.rho.assign(vec3(rho));
            sec.want.assign(uint(1));
          }
        : null;

      // Radiance at the hit, in fixed point. Phase 5 fills `shadeHit`; until
      // then the whole RGB path is exercised only by the gate, which injects a
      // synthetic shading both sides of the mirror agree on.
      const L = shadeHit ? vec3(shadeHit(r, dir, n, sink)).toVar() : vec3(0).toVar();
      const unit = L.div(float(lmax).max(1e-6)).toVar();
      const clamped = unit.x.max(unit.y).max(unit.z).greaterThan(1).toVar();
      const fx = [
        unit.x.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
        unit.y.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
        unit.z.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
      ];

      atomicAdd(stats.element(uint(STAT_RAYS)), uint(1));
      atomicAdd(stats.element(uint(STAT_HITS)), select(hit, uint(1), uint(0)));
      atomicAdd(stats.element(uint(STAT_CLAMPED)), select(clamped, uint(1), uint(0)));
      atomicMax(stats.element(uint(STAT_MAXL)), fx[0].max(fx[1]).max(fx[2]));
      const tfx = select(hit, d.max(0).mul(T_FIXED), float(0)).toUint().toVar();
      atomicAdd(stats.element(uint(STAT_TSUM)), tfx);
      atomicMax(stats.element(uint(STAT_TMAX)), tfx);

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
          .and(int(c).lessThanEqual(own)), () => {
          atomicAdd(stats.element(uint(STAT_NOBLOCK)), uint(1));
        });
        If(blk.notEqual(uint(SLOT_EMPTY)).and(int(c).lessThanEqual(own)), () => {
          const b = dirToBin(dir, info.width).toVar();
          const m = binMorton(b.x, b.y).toVar();
          const slot = uint(info.binBase)
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
          If(int(c).lessThan(own), () => {
            atomicAdd(scratch.element(slot.add(uint(BIN_T))), uint(DEPOSIT_SCALE));
          }).Else(() => {
            atomicAdd(scratch.element(slot.add(uint(BIN_R))), fx[0]);
            atomicAdd(scratch.element(slot.add(uint(BIN_G))), fx[1]);
            atomicAdd(scratch.element(slot.add(uint(BIN_B))), fx[2]);
            // THE SAME BIN THE SECONDARY TERM MUST LAND IN. Exactly one cascade
            // takes this branch (`c == own`), so this assigns once per ray, and
            // it is captured HERE rather than recomputed in [J] because `own`,
            // the ancestor chain and the block claim are all this frame's and
            // none of them survives into a second dispatch.
            if (sec) sec.slot.assign(slot);
          });
          atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), uint(DEPOSIT_SCALE));
          atomicAdd(stats.element(uint(STAT_DEPOSITS)), uint(1));
        });
      }

      // ── the hit list append ───────────────────────────────────────────────
      //
      // A shaded hit with a destination bin, and nothing else: a MISS never
      // reaches the radiance branch so its slot stays EMPTY, and a hit whose
      // owning probe never claimed a block has nowhere to put a second bounce
      // either (it is already counted as a `NOBLOCK` deposit above).
      //
      // The count is claimed with an atomic and the entry written only if it
      // fits. An over-capacity list is not supposed to happen — the capacity is
      // `transportThreads × raysPerPixel`, an exact bound on the rays this
      // dispatch can fire — so the counter exists to say the bound was wrong
      // rather than to make dropping acceptable.
      if (sec) {
        If(sec.want.equal(uint(1)).and(sec.slot.notEqual(uint(SLOT_EMPTY))), () => {
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
            // The reserved pair, written rather than left as whatever the last
            // frame's entry held — a reader added later gets zeros instead of a
            // stale value that happens to decode.
            put(10, uint(0));
            put(11, uint(0));
          }).Else(() => {
            atomicAdd(stats.element(uint(STAT_SEC_OVERFLOW)), uint(1));
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
    const o = i.mul(PAYLOAD_WORDS).toVar();
    // `atomicLoad`, not a plain read: `scratch` is declared atomic and WGSL will
    // not implicitly convert `atomic<u32>` to `u32` — it fails at
    // CreateShaderModule, which surfaces as a validation error rather than a
    // wrong picture. Free on every target we ship to (srcProbes.js says the
    // same about its own counters).
    const count = atomicLoad(scratch.element(b.add(uint(BIN_COUNT)))).toVar();
    If(count.lessThan(uint(MIN_WEIGHT)), () => {
      payload.element(o.add(uint(3))).assign(float(PAYLOAD_UNKNOWN));
      Return();
    });
    const inv = float(1).div(float(count)).toVar();
    // `Lmax/count`, with NO `2^F` in it: radiance carries `2^F` per ray and
    // count now carries `2^F` per ray as well, so the two scales cancel exactly
    // and this stays a single multiply however the fixed point is retuned.
    const toL = float(lmax).mul(inv).toVar();
    payload.element(o).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_R))))).mul(toL));
    payload.element(o.add(uint(1))).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_G))))).mul(toL));
    payload.element(o.add(uint(2))).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_B))))).mul(toL));
    payload.element(o.add(uint(3)))
      .assign(float(atomicLoad(scratch.element(b.add(uint(BIN_T))))).mul(inv));
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
          secondaryHits: 0, secondaryClamped: 0, secondaryOverflow: 0,
        };
      }
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const rays = v[STAT_RAYS] >>> 0;
      const hits = v[STAT_HITS] >>> 0;
      const shaded = v[STAT_SHADED] >>> 0;
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
        unattributedRate: shaded > 0 ? (v[STAT_UNATTRIBUTED] >>> 0) / shaded : 0,
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
