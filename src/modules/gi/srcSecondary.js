// SPLIT RADIANCE CASCADES — [J] THE SECOND BOUNCE, AS A PASS OF ITS OWN.
//
// One dispatch over the hit list [E] appended this frame. Per entry: gather the
// tile atlas at the hit, multiply by the clamped ρ over π, and atomically add
// the result into the SAME bin [E] already deposited the direct term into.
//
//     L_secondary(H) = ρ_clamped(H)/π · E_atlas(H, n̂)
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 [J], §12.39, §12.26.9.
//
// ══ WHY THIS IS A PASS AND NOT A LINE IN `srcShade.js` ══════════════════════
//
// It was a line in `srcShade.js`, for one session, and the user's editor priced
// it the same hour: `gatherAt` is 16 hash-find loops and 16 filtered tile taps,
// and the hit shader is instantiated INSIDE the deposit's ray loop — the
// fattest kernel in the module. The deposit went 58 kB → 323 kB of WGSL (2 → 3
// loops, 642 ifs) and its pipeline compile went to **48 SECONDS**, the §13.14
// unroll pathology this module has now paid to learn three times.
//
// The plan's own [J] line said the architecture out loud — "steps B–H re-run
// over LAST FRAME'S HIT POINTS" — and that is a compact worklist with the
// gather compiled ONCE, in a small kernel, dispatched over hits instead of over
// (rays × call sites). Same estimator, same frame, same bins.
//
// ══ THREE STORAGE BINDINGS, AND EACH ONE IS LOAD-BEARING (R7) ═══════════════
//
//   1. `scratch` — the hit list AND the bins. ONE buffer, because [J]'s inputs
//      ride the tail of the accumulators it writes (`srcDeposit.js`'s SEC_*
//      layout). A separate list buffer would have cost [E] its last binding.
//   2. `hashKeys` — the whole corner lookup, keys and the hash→block words
//      together, via `createSrcHashBlockFrame`'s single-buffer `lookup`.
//   3. `stats` — the deposit's counters. [J] owns no buffer, exactly as
//      `createSrcShadeCounters` arranged for the hit shader.
//
// The tile atlas is a TEXTURE and textures are not part of the 8-storage-buffer
// budget, which is the whole reason the atlas exists in that form.
//
// ══ WHY BETWEEN [E] AND [F], AND NOT ANYWHERE ELSE ══════════════════════════
//
// · AFTER [E], necessarily: the list does not exist until [E] writes it.
// · BEFORE [F], necessarily: the resolve turns the accumulators into the
//   payload, and a deposit that lands after it is a frame late — and not merely
//   late, because the bin slot itself expires. [C] re-claims blocks every
//   frame, so an entry's `SEC_SLOT` is only meaningful inside the frame that
//   produced it.
// · `hashBlockFrame.pass` does NOT move for this. It already runs before the
//   first ray (§12.39: the hash LAYOUT is rebuilt every frame with
//   scheduler-dependent contention, so the tail must be republished after
//   compaction), and that placement is exactly what [J] needs as well.
//
// ══ THE ATLAS IS LAST FRAME'S, AND THAT IS THE ESTIMATOR ════════════════════
//
// [H] bakes AFTER the deposit each frame, so at the moment this pass samples a
// tile the atlas holds the PREVIOUS frame's irradiance. That lag is not a
// compromise, it is the fixed-point iteration R4 models: frame k's bounce reads
// frame k−1's field, the in-loop gain is `clampLoopAlbedo`'s ceiling (0.9,
// measured at 0.9000 in the CPU mirror), and the series converges to the full
// multibounce sum at one cache's cost. There is no separate, coarser secondary
// cache — §12.26.9 measured the same-spacing one as the LEAST leaky (coarsening
// BRIGHTENS: the trilinear near-geometry leak scales with probe spacing, and it
// is one-sided inside a feedback loop), so re-reading the primary lattice is
// the accurate choice rather than merely the free one.
//
// ══ THE SPLIT CLAMP, WHICH IS A REAL DIFFERENCE FROM THE INLINE FORM ════════
//
// Inline, `L_primary + L_secondary` was clamped against `Lmax` ONCE. Split, each
// term saturates on its own, so a bin can receive up to 2·Lmax where the inline
// version would have received Lmax. Accepted, and counted rather than hidden:
// `STAT_SEC_CLAMPED` says how often the secondary term alone hit the ceiling,
// which is the reading that says whether the difference is ever reachable. It
// is bounded by construction — the secondary term is ρ/π·E with ρ ≤ 0.9 — and
// the alternative (carrying the primary's headroom into a second dispatch)
// means a fourth binding or a second pass over the bins, for a case the counter
// is there to prove empty.
//
// ⛔ THE DISPATCH IS DIRECT AND STAYS DIRECT. An indirect dispatch over the
// count word is the obvious optimization and it has been refuted TWICE on this
// module's own kernels (`srcDeposit.js`'s dispatch note) — the second time it
// shipped an editor where [E] launched zero workgroups with no error at all.
// The trailing threads here return in whole warps off one atomic load, which is
// the same shape the ray worklist made cheap.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  float,
  instanceIndex,
  select,
  uint,
  uintBitsToFloat,
  uniform,
  vec3,
} from "three/tsl";
import { MAX_LODS, SECONDARY_LOD_OFFSET, W0 } from "./srcConfig.js";
import {
  BIN_B,
  BIN_G,
  BIN_R,
  DEPOSIT_SCALE,
  SEC_HIT_WORDS,
  SEC_N,
  SEC_P,
  SEC_RHO,
  SEC_SLOT,
  STAT_SECONDARY,
  STAT_SEC_CLAMPED,
  STAT_SEC_OVERFLOW,
} from "./srcDeposit.js";
import { createSrcScreenGather } from "./srcScreenGather.js";

/**
 * [J] as a single dispatch.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`, built with a
 *   `secondaryCapacity` — this pass reads the hit list out of its `scratch`
 *   tail and deposits into its bins.
 * @param {object} options
 * @param {object} options.tiles   `createSrcTileAtlas`'s bundle — the atlas is
 *   sampled as a texture, so it costs no storage binding.
 * @param {(key) => Node} options.lookup  `createSrcHashBlockFrame`'s
 *   single-buffer key → block closure.
 * @param {Node|number} options.spacing0
 * @param {Node} options.camera  the LOD metric's centre — the SAME uniform the
 *   population and the screen gather read, or [J] would gather over a lattice
 *   placed differently from the one [E] filled.
 * @param {Node} options.anchor
 * @param {Node} options.lmax  the fixed point's saturation radiance, the same
 *   uniform [E] converts with. A second value here would make the two terms in
 *   one bin carry different units.
 * @param {Node} [options.lodBias]  an EXPLICIT bias node, for a gate that wants
 *   to pin one. Omitted, this pass owns a polled uniform seeded from srcConfig's
 *   `SECONDARY_LOD_OFFSET` — see `poll` below.
 * @param {number} options.capacity  hit-list entries — the dispatch width.
 */
export function createSrcSecondaryFrame(store, bins, {
  tiles,
  lookup,
  spacing0,
  camera,
  anchor,
  lmax,
  lodBias = null,
  maxLods = MAX_LODS,
  w0 = W0,
  capacity = 0,
} = {}) {
  const { scratch, stats, hitListBase, hitCapacity } = bins;
  if (!(capacity > 0) || capacity > hitCapacity) {
    throw new Error(
      `createSrcSecondaryFrame: capacity ${capacity} is outside the bin store's hit ` +
      `list (${hitCapacity}) — the store must be built with \`secondaryCapacity\``,
    );
  }
  if (typeof lookup !== "function") {
    throw new Error("createSrcSecondaryFrame: `lookup` is required — [J] resolves probe corners per hit");
  }

  // ── THE LOD BIAS IS A POLLED UNIFORM, NOT A BUILD CONSTANT ────────────────
  //
  // §12.23's rule, which this module keeps re-learning: a build-time value can
  // only be A/B'd by RELOADING, and a reload changes the viewport, the compile
  // wave and the settle state along with the thing under test. So the bias is a
  // uniform read per frame from `__giSrcSecondaryLodBias`, and the shipped
  // default is srcConfig's `SECONDARY_LOD_OFFSET` — 0, because [B] only inserts
  // probe keys at the camera-derived LOD, so a positive bias buys eight hash
  // finds that are guaranteed to miss (that constant's doc carries the whole
  // argument).
  const readLodBias = () => {
    const forced = Number(globalThis.__giSrcSecondaryLodBias);
    return Number.isFinite(forced) ? forced : SECONDARY_LOD_OFFSET;
  };
  const lodBiasU = lodBias ?? uniform(readLodBias());

  // THE GATHER, CLOSURE ONLY. Same integral as [I] and as the exact-reflection
  // hit — one definition, three call sites — but with no screen pass attached:
  // this one is evaluated at a hit list, and building the screen half would
  // allocate a storage texture nothing samples. The bias node is the only thing
  // that differs from the screen instance, and the screen instance passes none,
  // which keeps its graph byte-identical to every pre-[J] measurement.
  const gather = createSrcScreenGather(store, tiles, {
    lookup, spacing0, camera, anchor, maxLods, w0, lodBias: lodBiasU,
  });

  const base = hitListBase;
  const pass = Fn(() => {
    const i = instanceIndex.toVar();
    // One atomic load, then whole warps of trailing threads return. See the
    // header on why this is not an indirect dispatch.
    If(i.greaterThanEqual(atomicLoad(scratch.element(uint(base)))), () => { Return(); });

    const e = uint(base + 1).add(i.mul(uint(SEC_HIT_WORDS))).toVar();
    // `atomicLoad`, not a plain read: `scratch` is declared atomic and WGSL
    // will not implicitly convert `atomic<u32>` to `u32` — it fails at
    // CreateShaderModule rather than producing a wrong picture.
    const word = (w) => uintBitsToFloat(atomicLoad(scratch.element(e.add(uint(w)))));
    const P = vec3(word(SEC_P + 0), word(SEC_P + 1), word(SEC_P + 2)).toVar();
    const n = vec3(word(SEC_N + 0), word(SEC_N + 1), word(SEC_N + 2)).toVar();
    const rho = vec3(word(SEC_RHO + 0), word(SEC_RHO + 1), word(SEC_RHO + 2)).toVar();
    const slot = atomicLoad(scratch.element(e.add(uint(SEC_SLOT)))).toVar();

    // ρ/π · E, finishing the expression `srcShade.js` started at this same hit
    // with this same ρ.
    const E = gather.gatherAt(P, n).irradiance;
    const L = rho.mul(E).mul(1 / Math.PI).toVar();

    // The fixed point conversion, IDENTICAL to [E]'s — same `lmax`, same
    // rounding, same clamp — because the two terms land in the same
    // accumulator and `ΣR/Σcount` cannot tell them apart afterwards.
    const unit = L.div(float(lmax).max(1e-6)).toVar();
    const clamped = unit.x.max(unit.y).max(unit.z).greaterThan(1).toVar();
    const fx = [
      unit.x.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
      unit.y.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
      unit.z.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
    ];

    // ⚠ **`BIN_COUNT` IS NOT TOUCHED, AND THAT IS THE WHOLE NORMALIZATION.**
    // [E] already counted this ray when it deposited the direct term into this
    // same slot, and the resolve computes `L = ΣR/Σcount`. Adding a second
    // count here would halve the bin instead of brightening it; adding radiance
    // alone makes the bounce arrive as extra radiance on an unchanged weight,
    // which is exactly what "the same ray carried more light" means.
    atomicAdd(scratch.element(slot.add(uint(BIN_R))), fx[0]);
    atomicAdd(scratch.element(slot.add(uint(BIN_G))), fx[1]);
    atomicAdd(scratch.element(slot.add(uint(BIN_B))), fx[2]);

    atomicAdd(stats.element(uint(STAT_SECONDARY)), uint(1));
    atomicAdd(stats.element(uint(STAT_SEC_CLAMPED)), select(clamped, uint(1), uint(0)));
  })().compute(capacity);

  return {
    pass,
    capacity,
    lodBias: lodBiasU,
    /** The tail and the counters both ride buffers this pass does not own. */
    bytes: 0,

    /**
     * Per-frame hatch poll, called from `syncCamera` beside the α, ceiling and
     * cap polls. A no-op when the caller pinned an explicit bias node.
     */
    poll() {
      if (lodBias) return;
      const v = readLodBias();
      if (v !== lodBiasU.value) lodBiasU.value = v;
    },

    /**
     * [J]'s own tallies, out of the deposit's stats buffer.
     *
     * `hits` is the instrument the gate asserts on: a pipeline that fails to
     * create dispatches nothing and renders a frame that looks single-bounce,
     * which no image statistic can separate from "the loop adds little in this
     * scene". `overflow` is [E]'s counter, read here because the two are only
     * meaningful together — hits at the capacity with overflow nonzero means
     * the list is short, not that the bounce is bright.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, hits: 0, clamped: 0, overflow: 0, capacity };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      return {
        dispatched: true,
        hits: v[STAT_SECONDARY] >>> 0,
        clamped: v[STAT_SEC_CLAMPED] >>> 0,
        overflow: v[STAT_SEC_OVERFLOW] >>> 0,
        capacity,
      };
    },

    dispose() {
      gather.dispose?.();
    },
  };
}

/** The per-frame secondary line, for the telemetry log. */
export function formatSrcSecondary(s) {
  if (!s?.dispatched) return "";
  return `bounce ${s.hits}/${s.capacity} hits` +
    (s.clamped ? ` (${s.clamped} CLAMPED)` : "") +
    (s.overflow ? `  SEC-OVERFLOW ${s.overflow}` : "");
}
