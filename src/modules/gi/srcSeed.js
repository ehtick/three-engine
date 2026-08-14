// SPLIT RADIANCE CASCADES — THE FRESH-PROBE SEED (§12.59.2).
//
// A probe born this frame starts its accumulators at ZERO and converges in
// view. §12.59.1's pan bisect measured what that looks like: a 25° camera pan
// drives per-pixel step amplitude ~200× over the still floor, the churn is
// INVARIANT to the per-probe ray cap (so faster intake cannot hide it — §12.52's
// cold fill is a ray-budget lift, not a prior), and the elevated stills OUTLIVE
// the pan by seconds while the newly-anchored column finishes converging. Every
// at-rest suspect — cap, surprise detector, tracking window — measured inside
// the instrument's noise floor. The mechanism is newborn probes; the fix is a
// RADIANCE PRIOR, and this file is that prior.
//
// ══ WHAT IS WRITTEN, AND WHY IT IS THE PARENT'S MERGED PAYLOAD ══════════════
//
// For each bin of a fresh probe, seed = the 4→1 pre-average of the PARENT
// cascade probe's bins at the same world direction (srcMerge's [G.3] mapping:
// child bin m ↔ parent bins 4m…4m+3, Morton-contiguous), read from `payload` —
// which at this point in the frame still holds LAST frame's resolved+MERGED
// values. Merged, not raw, and that choice is load-bearing:
//
//   · The merged parent answer is FULL-RANGE (own interval + everything above
//     it + sky), i.e. it lives in the same domain the child's own bins reach
//     AFTER their merge. Seed L = that answer with T ≈ 0 (merged T is 0
//     wherever the parent chain resolved), and the child's first merged frame
//     reads ≈ the parent's converged answer instead of ≈ black.
//   · The transition is STATIONARY where the truth is stationary. Take a bin
//     whose truth is "clear through my interval": own rays deposit T=1, L=0 at
//     weight w against seed weight W, so the child resolves
//     L = W·Lp/(W+w), T = w/(W+w), and its merge adds T·Lp — total Lp exactly,
//     at every w. The prior does not fight the evidence on the way out; it
//     hands over.
//   · A raw-accumulator seed would describe the parent's own INTERVAL (2× the
//     child's, different content) and would then be double-counted by the
//     child's merge (seeded L already partly parental, plus T·L_parent again).
//
// UNKNOWN parent bins (payload T < 0) are skipped and the 4→1 average
// renormalizes over what was found — all four unknown seeds nothing and the
// child bin keeps today's from-zero behaviour (R1: an absence is an absence).
// The top cascade has no parent and is not seeded (its §12.59.2 spatial-
// neighbour fallback is deliberately deferred until the parent path's pan
// numbers say whether it is needed).
//
// ══ ORDER: AFTER THE DECAY, AND `atomicAdd`, NOT STORE ══════════════════════
//
// Two traps this placement exists to dodge, both silent:
//
//   1. The deposit's decay pass ZEROES every block claimed this frame (the
//      stamp check — a reclaimed block must not fade a dead probe's history
//      into its successor). A seed written in the populate group would be
//      wiped by it, frame after frame, and render EXACTLY like the seed not
//      existing. So these passes dispatch AFTER `deposit.decay` and before
//      the resolve reads the accumulators.
//   2. The writes are `atomicAdd` onto the just-zeroed words, never
//      `atomicStore` — adds commute with [E]'s scatter, so the seed is correct
//      anywhere in the decay→resolve window and cannot erase a ray that lands
//      first. (`scratch` is atomic; a plain `.assign` would not compile —
//      srcMerge's telemetry clear records the same trap from the store side.)
//
// A third trap, dodged by a flag test rather than by order: a parent that is
// ITSELF fresh claimed its block this frame, so `payload` at that block is a
// PREVIOUS OWNER's stale answer — geometrically unrelated light that no energy
// check would flag. Fresh parents (and blockless ones) are skipped and
// counted, not read.
//
// ══ THE WEIGHT, AND THE IN-PAGE OFF ARM ═════════════════════════════════════
//
// `seedRays` (srcConfig's SEED_RAYS doc carries the two anchors: ≈8 frames of
// measured evidence, just under the decay's steady state) arrives as a uniform
// and every written quantity is proportional to it — so `__giSrcSeedRays = 0`
// zeroes every add and IS the A/B arm, in-page, no rebuild, which is the only
// comparison `run-gi-flicker-frame.mjs`'s own header permits. The build-time
// hatch `__giSrcSeed = false` removes the passes entirely (srcSystem reads it
// once), keeping every kernel byte-identical for gates written before this.
//
// docs/GI_SRC_REBUILD_PLAN.md §12.59.1 (the verdict), §12.59.2 (this spec).

import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  uint,
  vec3,
} from "three/tsl";
import { CASCADE_COUNT } from "./srcConfig.js";
import {
  BIN_B, BIN_COUNT, BIN_G, BIN_R, BIN_T, BIN_WORDS, DEPOSIT_SCALE, PAYLOAD_WORDS,
} from "./srcDeposit.js";
import {
  FLAG_ALIVE,
  FLAG_FRESH,
  PROBE_BLOCK,
  PROBE_FLAGS,
  PROBE_PARENT,
  PROBE_WORDS,
  SLOT_EMPTY,
} from "./srcProbes.js";

/** Seed telemetry. One atomic buffer, four words. */
export const SEED_PROBES = 0;  // fresh probes seeded (parent had history)
export const SEED_ORPHAN = 1;  // fresh probes with no parent probe at all
export const SEED_COLD = 2;    // fresh probes whose parent was fresh/blockless — a cold column
export const SEED_BINS = 3;    // bins that received a prior
export const SEED_WORDS = 4;

/**
 * Bins per thread. Bin counts quadruple up the ladder (32 at c0, 512 at c2
 * with w0 = 4), and a pan frame's fresh probes are few — one thread per probe
 * would put a 512-iteration loop on a handful of threads, which is a
 * tail-latency shape, not a throughput one. Splitting a probe across
 * `bins/32` threads keeps every live thread the same length as a c0 thread;
 * dead threads (the steady-state majority) exit on the flags read either way.
 */
const SEED_GROUP_BINS = 32;

/**
 * Radiance ceiling on the seed, in units of Lmax. Merged payload can exceed
 * Lmax (it is a SUM down the ladder plus sky), and the fixed-point words the
 * seed writes are u32 — the clamp bounds the add at
 * `SEED_MAX_UNIT · seedRays · 2^16`, three orders under overflow, and a prior
 * brighter than 8× the deposit ceiling is not a prior worth propagating.
 */
const SEED_MAX_UNIT = 8;

/**
 * Build the seed as a dispatch list: one telemetry clear, then one pass per
 * cascade 0…N−2 (the top cascade has no parent).
 *
 * MUST dispatch after `createSrcDepositFrame`'s decay and before its resolve —
 * the header's trap 1. srcSystem's `passes` list is the enforcement.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {Node} options.lmax  the SAME uniform the deposit converts through —
 *   a second ceiling here would seed in a different fixed point than the rays
 *   land in, and the blend would silently weight the two inconsistently.
 * @param {Node} options.seedRays  uniform: the prior's effective sample count,
 *   in rays. 0 zeroes every write (the in-page off arm).
 */
export function createSrcSeedFrame(store, bins, { lmax, seedRays } = {}) {
  const { probeTable } = store;
  const { payload, scratch } = bins;
  const N = store.cascadeCount ?? CASCADE_COUNT;

  const stats = instancedArray(new Uint32Array(SEED_WORDS), "uint").toAtomic();
  const passes = [];

  // `atomicStore`, not `.assign` — srcMerge's telemetry clear carries the trap.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    If(i.lessThan(uint(SEED_WORDS)), () => {
      atomicStore(stats.element(i), uint(0));
    });
  })().compute(SEED_WORDS));

  for (let c = 0; c < N - 1; c++) {
    const info = bins.cascades[c];
    const parentInfo = bins.cascades[c + 1];
    const nBins = info.bins;
    const groupBins = Math.min(nBins, SEED_GROUP_BINS);
    const groups = Math.max(1, Math.floor(nBins / groupBins));

    passes.push(Fn(() => {
      // One thread per (probe, bin group). Both factors are powers of two, so
      // the split is shifts, same as the merge's (block, bin) split.
      const i = instanceIndex.toVar();
      const group = i.mod(uint(groups)).toVar();
      const p = uint(info.probeBase).add(i.div(uint(groups))).toVar();
      const w = p.mul(uint(PROBE_WORDS)).toVar();

      const flags = probeTable.element(w.add(uint(PROBE_FLAGS))).toVar();
      If(flags.bitAnd(uint(FLAG_ALIVE)).equal(uint(0)), () => { Return(); });
      // FRESH means "born this frame" here and nowhere looser: the age pass
      // clears the flag on every survivor BEFORE re-inserting it, so a probe
      // seen last frame cannot take this branch and be re-seeded over its own
      // history.
      If(flags.bitAnd(uint(FLAG_FRESH)).equal(uint(0)), () => { Return(); });
      const block = probeTable.element(w.add(uint(PROBE_BLOCK))).toVar();
      // No block, nowhere to seed — the same NOBLOCK absence the deposit
      // drops-and-counts. The probe-store counter already owns that number.
      If(block.equal(uint(SLOT_EMPTY)), () => { Return(); });

      // Per-probe counters tally once, on the probe's first group — the other
      // groups of the same probe take the same branches and stay silent.
      const first = group.equal(uint(0));

      // PROBE_PARENT holds the parent's probe INDEX here — the populate
      // ladder's resolve settled it earlier this frame (its hash-slot interim
      // is dead by compaction, srcProbes' PROBE_PARENT doc). SLOT_EMPTY is a
      // probe whose parent cell never got a probe: today's from-zero, counted.
      const parent = probeTable.element(w.add(uint(PROBE_PARENT))).toVar();
      If(parent.equal(uint(SLOT_EMPTY)), () => {
        If(first, () => { atomicAdd(stats.element(uint(SEED_ORPHAN)), uint(1)); });
        Return();
      });

      const pw = parent.mul(uint(PROBE_WORDS)).toVar();
      const pflags = probeTable.element(pw.add(uint(PROBE_FLAGS))).toVar();
      const pblock = probeTable.element(pw.add(uint(PROBE_BLOCK))).toVar();
      // The header's trap 3: a fresh parent's payload is a previous owner's
      // stale answer. Skip it, count it — a pan that outruns the ladder shows
      // up HERE, as SEED_COLD, rather than as unexplained residual flicker.
      If(pflags.bitAnd(uint(FLAG_ALIVE)).equal(uint(0))
        .or(pflags.bitAnd(uint(FLAG_FRESH)).notEqual(uint(0)))
        .or(pblock.equal(uint(SLOT_EMPTY))), () => {
        If(first, () => { atomicAdd(stats.element(uint(SEED_COLD)), uint(1)); });
        Return();
      });

      If(first, () => { atomicAdd(stats.element(uint(SEED_PROBES)), uint(1)); });

      // The prior's weight in fixed-point count units. Everything below is
      // proportional to it, which is what makes 0 the in-page off arm.
      const W = float(seedRays).mul(float(DEPOSIT_SCALE)).max(0).toVar();
      If(W.lessThan(1), () => { Return(); });
      const Wu = W.add(0.5).floor().toUint().toVar();

      const mBase = group.mul(uint(groupBins)).toVar();
      Loop({ start: uint(0), end: uint(groupBins), type: "uint", condition: "<" }, ({ i: j }) => {
        const m = mBase.add(j).toVar();
        // srcMerge [G.3]'s 4→1 pre-average, same direction convention: the
        // parent's four finer bins for child bin m are `4m…4m+3`, one aligned
        // Morton run. Getting it backwards reads another DIRECTION's radiance
        // — a hue rotation no energy check can see (the merge's own warning).
        const pBase = uint(parentInfo.binBase)
          .add(pblock.mul(uint(parentInfo.bins)))
          .add(m.mul(uint(4)))
          .toVar();
        const pL = vec3(0).toVar();
        const pT = float(0).toVar();
        const known = float(0).toVar();
        for (let k = 0; k < 4; k++) {
          const op = pBase.add(uint(k)).mul(uint(PAYLOAD_WORDS)).toVar();
          const t = payload.element(op.add(uint(3))).toVar();
          If(t.greaterThanEqual(0), () => {
            pL.addAssign(vec3(
              payload.element(op),
              payload.element(op.add(uint(1))),
              payload.element(op.add(uint(2))),
            ));
            pT.addAssign(t);
            known.addAssign(1);
          });
        }
        If(known.greaterThan(0), () => {
          const inv = float(1).div(known).toVar();
          // Into the deposit's fixed point: BIN_R carries `L/Lmax · 2^16` per
          // ray-weight, BIN_COUNT carries `2^16` per ray — seeding W of count
          // and `unit·W` of radiance makes the resolve's `ΣR/Σcount · Lmax`
          // read back exactly the parent's mean at weight `seedRays`.
          const unit = pL.mul(inv).div(float(lmax).max(1e-6))
            .clamp(0, SEED_MAX_UNIT).toVar();
          const slot = uint(info.binBase)
            .add(block.mul(uint(nBins)))
            .add(m)
            .mul(uint(BIN_WORDS))
            .toVar();
          atomicAdd(scratch.element(slot.add(uint(BIN_R))), unit.x.mul(W).add(0.5).floor().toUint());
          atomicAdd(scratch.element(slot.add(uint(BIN_G))), unit.y.mul(W).add(0.5).floor().toUint());
          atomicAdd(scratch.element(slot.add(uint(BIN_B))), unit.z.mul(W).add(0.5).floor().toUint());
          atomicAdd(
            scratch.element(slot.add(uint(BIN_T))),
            pT.mul(inv).clamp(0, 1).mul(W).add(0.5).floor().toUint(),
          );
          atomicAdd(scratch.element(slot.add(uint(BIN_COUNT))), Wu);
          atomicAdd(stats.element(uint(SEED_BINS)), uint(1));
        });
      });
    })().compute(info.probeCapacity * groups));
  }

  return {
    passes,
    stats,
    bytes: SEED_WORDS * 4,

    /**
     * One frame's seed telemetry. `cold` is the number to watch on a fast pan:
     * it is the fresh probes whose parent was ALSO born this frame — a column
     * the ladder could not seed, i.e. exactly where §12.59.2's deferred
     * spatial-neighbour fallback would act if the pan numbers demand it.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, probes: 0, bins: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      return {
        dispatched: true,
        probes: v[SEED_PROBES] >>> 0,
        orphans: v[SEED_ORPHAN] >>> 0,
        cold: v[SEED_COLD] >>> 0,
        bins: v[SEED_BINS] >>> 0,
      };
    },

    dispose() {
      stats?.value?.dispose?.();
    },
  };
}

/** The per-frame seed line, for the telemetry log. */
export function formatSrcSeed(s) {
  if (!s?.dispatched) return "";
  return `seed ${s.probes} probes / ${s.bins} bins` +
    (s.cold ? ` (${s.cold} cold)` : "") +
    (s.orphans ? ` (${s.orphans} orphan)` : "");
}
