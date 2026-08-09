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
// TRANSMITTANCE IS NOT FIXED POINT. Every deposit's T is exactly 0 or 1, so
// `sumT` is an integer count of clear deposits and `T = sumT/count` is exact.
// Spending fixed-point bits on a value that only ever takes two integer values
// would be precision theatre.
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
// ══ WHAT SHADES A HIT — NOTHING, YET, AND THAT IS THE PLAN ══════════════════
//
// `shadeHit` defaults to black. Full hit shading (light-tree NEE, sun shadow
// rays at hits, mover surfaces, the secondary cache) is **Phase 5**, and §7
// describes Phase 2's look as "AO-like short-range bounce" for exactly this
// reason: with no hit radiance, what survives the resolve is TRANSMITTANCE, and
// a receiver lit by transmittance alone against the sky is ambient occlusion.
// That is not a placeholder standing in for the real thing — it is the real
// thing with one term still zero, which is why it is checkable now.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.2, §12.13.4, §12.13.5 unit 3.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicMax,
  atomicStore,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  select,
  uint,
  vec3,
} from "three/tsl";
import { CASCADE_COUNT, MAX_LODS, W0, binCount, binGridWidth } from "./srcConfig.js";
import {
  binMorton,
  chebyshev,
  dirToBin,
  intervalBoundary,
  lodAtDistance,
  rayDirection,
} from "./srcMathTsl.js";
import {
  PROBE_PARENT,
  PROBE_WORDS,
  SLOT_EMPTY,
} from "./srcProbes.js";

/** Per-bin accumulator layout. Five words, one atomic buffer. */
export const BIN_R = 0;
export const BIN_G = 1;
export const BIN_B = 2;
export const BIN_T = 3;     // integer COUNT of clear deposits, not fixed point
export const BIN_COUNT = 4;
export const BIN_WORDS = 5;

/** Fractional bits in the radiance accumulator. §12.13.4 measured this. */
export const DEPOSIT_F = 16;
const DEPOSIT_SCALE = 1 << DEPOSIT_F;

/** Resolved payload: rgb + transmittance, with T < 0 meaning UNKNOWN. */
export const PAYLOAD_WORDS = 4;
export const PAYLOAD_UNKNOWN = -1;

/** Diagnostic words — the `Lmax` decision's instrument, plus the ray tallies. */
export const STAT_RAYS = 0;
export const STAT_HITS = 1;
export const STAT_DEPOSITS = 2;
export const STAT_CLAMPED = 3;   // deposits whose radiance hit the Lmax ceiling
export const STAT_MAXL = 4;      // max observed radiance, in DEPOSIT_F fixed point
export const STAT_TSUM = 5;      // hit-distance sum, 1/1024 m
export const STAT_TMAX = 6;
export const STAT_WORDS = 8;
const T_FIXED = 1024;

/**
 * The bin accumulators and the resolved payload, sized from a probe store.
 *
 * ══ ADDRESSED BY PROBE INDEX, WHICH IS A KNOWN LIMIT ═══════════════════════
 *
 * A bin's slot is `binBase[cascade] + localProbeIndex · binCount(cascade) + morton`
 * — direct, no indirection, and sized by probe CAPACITY rather than by live
 * probes. §4.2's design says "only cascade-live slots", which needs a claimed
 * bin-block per probe (`PROBE_SPARE` is the reserved word for it). That
 * indirection is not built here, and the reason is worth stating rather than
 * discovering: it has to be claimed and released on the probe's lifetime, which
 * is Phase 3/4 machinery, and unit 3 is about whether the scatter is CORRECT.
 *
 * The cost of not having it is real and bounded, so it is asserted rather than
 * hoped for: at the default 16,384 c0 probes the accumulators are ~73 MB, and
 * `maxStorageBufferBindingSize` is 128 MiB on every device we ship to. Past
 * roughly 32k c0 probes a single buffer stops fitting, and the constructor says
 * so by name instead of failing inside three with a binding error.
 */
export function createSrcBinStore(store, { w0 = W0, maxBytes = 128 * 1024 * 1024 } = {}) {
  const cascades = [];
  let binTotal = 0;
  for (const c of store.cascades) {
    const bins = binCount(c.cascade, w0);
    cascades.push({
      cascade: c.cascade,
      bins,
      width: binGridWidth(c.cascade, w0),
      binBase: binTotal,
      probeBase: c.probeBase,
      probeCapacity: c.probeCapacity,
    });
    binTotal += bins * c.probeCapacity;
  }
  const scratchBytes = binTotal * BIN_WORDS * 4;
  const payloadBytes = binTotal * PAYLOAD_WORDS * 4;
  if (scratchBytes > maxBytes || payloadBytes > maxBytes) {
    throw new Error(
      `createSrcBinStore: ${(binTotal / 1e6).toFixed(2)}M bins needs ` +
      `${(scratchBytes / 1048576).toFixed(0)}MB of scratch and ` +
      `${(payloadBytes / 1048576).toFixed(0)}MB of payload, past the ` +
      `${(maxBytes / 1048576).toFixed(0)}MB storage-buffer binding limit — ` +
      "bins are addressed by probe CAPACITY here, so this needs the per-probe " +
      "bin-block claim §4.2 describes (plan §12.16), not a bigger buffer",
    );
  }

  const scratch = instancedArray(new Uint32Array(binTotal * BIN_WORDS), "uint").toAtomic();
  const payload = instancedArray(new Float32Array(binTotal * PAYLOAD_WORDS), "float");
  const stats = instancedArray(new Uint32Array(STAT_WORDS), "uint").toAtomic();

  return {
    cascades,
    binTotal,
    w0,
    scratch,
    payload,
    stats,
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
 * @param {(hit, dir) => object} [options.shadeHit]  vec3 radiance at a hit.
 *   Phase 5. Default black — see the header.
 * @param {object} options.lmax  uniform: the radiance the fixed point saturates at
 */
export function createSrcDepositFrame(store, bins, {
  pixelProbe,
  pixelRayBase,
  pixelCount,
  raysPerPixel = 1,
  trace,
  shadeHit = null,
  readPixel,
  readNormal,
  camera,
  spacing0,
  lmax,
  jitterX,
  jitterY,
  maxLods = MAX_LODS,
} = {}) {
  const { probeTable } = store;
  const { scratch, payload, stats, binTotal, w0 } = bins;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const passes = [];

  // ── clear ─────────────────────────────────────────────────────────────────
  // Every bin, every frame. §4.2's "cleared by slot on claim" is the version
  // that comes with the bin-block indirection; without it there is no claim to
  // hang the clear on, and a stale bin is worse than a wasted clear — it is last
  // frame's radiance in this frame's probe, which is a temporal artifact that
  // looks exactly like a history bug.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    const b = i.mul(BIN_WORDS).toVar();
    for (let w = 0; w < BIN_WORDS; w++) atomicStore(scratch.element(b.add(uint(w))), uint(0));
    If(i.lessThan(uint(STAT_WORDS)), () => { atomicStore(stats.element(i), uint(0)); });
  })().compute(binTotal));

  // ── [E] trace and scatter ─────────────────────────────────────────────────
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
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

    for (let k = 0; k < raysPerPixel; k++) {
      // `n` is the ray's place in the global R2 sequence. It is handed to the
      // trace and the shading as a fourth/third argument that neither real
      // implementation uses — a SYNTHETIC one does, and that is what makes the
      // gate's diff bit-exact (see `srcRef.js`'s `traceAndDeposit` header).
      const n = base.add(uint(k)).toVar();
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

      // Radiance at the hit, in fixed point. Phase 5 fills `shadeHit`; until
      // then the whole RGB path is exercised only by the gate, which injects a
      // synthetic shading both sides of the mirror agree on.
      const L = shadeHit ? vec3(shadeHit(r, dir, n)).toVar() : vec3(0).toVar();
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
        const probe = chain[c];
        const info = bins.cascades[c];
        If(probe.notEqual(uint(SLOT_EMPTY)).and(int(c).lessThanEqual(own)), () => {
          const b = dirToBin(dir, info.width).toVar();
          const m = binMorton(b.x, b.y).toVar();
          const slot = uint(info.binBase)
            .add(probe.sub(uint(info.probeBase)).mul(uint(info.bins)))
            .add(m)
            .mul(BIN_WORDS)
            .toVar();
          // `c < own` — the ray crossed this interval unblocked: T = 1, no
          // radiance. `c == own` — blocked here: the radiance, T = 0. Both
          // increment `count`, because a bin's count is how many rays SAMPLED
          // it, and a blocked sample is a sample.
          If(int(c).lessThan(own), () => {
            atomicAdd(scratch.element(slot.add(uint(BIN_T))), uint(1));
          }).Else(() => {
            atomicAdd(scratch.element(slot.add(uint(BIN_R))), fx[0]);
            atomicAdd(scratch.element(slot.add(uint(BIN_G))), fx[1]);
            atomicAdd(scratch.element(slot.add(uint(BIN_B))), fx[2]);
          });
          atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), uint(1));
          atomicAdd(stats.element(uint(STAT_DEPOSITS)), uint(1));
        });
      }
    }
  })().compute(pixelCount));

  // ── [F] resolve ───────────────────────────────────────────────────────────
  // ZERO-COUNT BINS ARE UNKNOWN, NOT ZERO — `srcMath.js`'s `resolveBin` returns
  // null and this writes T = -1, which is outside transmittance's [0,1] range
  // and so cannot be mistaken for data. Feeding an unsampled bin in as black is
  // a hard cliff at the edge of every sparsely-sampled region, and the sparsity
  // table in §12.13.4 (0.78 rays per bin on average) is why that edge is
  // everywhere rather than exotic.
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
    If(count.equal(uint(0)), () => {
      payload.element(o.add(uint(3))).assign(float(PAYLOAD_UNKNOWN));
      Return();
    });
    const inv = float(1).div(float(count)).toVar();
    const toL = float(lmax).div(DEPOSIT_SCALE).mul(inv).toVar();
    payload.element(o).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_R))))).mul(toL));
    payload.element(o.add(uint(1))).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_G))))).mul(toL));
    payload.element(o.add(uint(2))).assign(float(atomicLoad(scratch.element(b.add(uint(BIN_B))))).mul(toL));
    payload.element(o.add(uint(3)))
      .assign(float(atomicLoad(scratch.element(b.add(uint(BIN_T))))).mul(inv));
  })().compute(binTotal));

  return {
    passes,
    raysPerPixel,

    /** One frame's tallies. The `Lmax` decision's instrument — see the header. */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) {
        return { dispatched: false, rays: 0, hits: 0, deposits: 0, clamped: 0 };
      }
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const rays = v[STAT_RAYS] >>> 0;
      const hits = v[STAT_HITS] >>> 0;
      return {
        dispatched: true,
        rays,
        hits,
        deposits: v[STAT_DEPOSITS] >>> 0,
        clamped: v[STAT_CLAMPED] >>> 0,
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
