// SPLIT RADIANCE CASCADES — [G] THE MERGE. This is what gives GI its RANGE.
//
// Cascade N−1 → 0, Eq. 6/7. Each bin keeps its own interval and lets through
// whatever it did not block from the sparse-trilinear-interpolated, 4→1
// pre-averaged cascade above it:
//
//     L_merged = L_self + T_self · L_parent
//     T_merged = T_self · T_parent
//
// with the TOP cascade merging against the sky, because there is nothing above
// it to interpolate. `srcMath.js`'s `mergeBin` is that one line and
// `srcRef.js`'s `mergeCascades` is the whole ladder; this file is the GPU twin
// of the ladder, and `test:gi-src-merge` diffs the two.
//
// ══ WHY THIS UNIT COMES BEFORE THE SMOOTH GATHER, AND IT IS NOT ORDERING ═══
//
// §12.19.5 argued it and it is worth carrying here, next to the code, because
// the shortcut is genuinely tempting: a position-indexed sparse-trilinear
// gather over cascade 0 alone would remove the visible blockiness a unit
// earlier. It would also be SHORT-RANGE — cascade 0's interval is r₀ ≈ 1.6·s₀,
// about a metre — so the result reads as smooth ambient occlusion rather than
// as global illumination. The merge is what makes a c0 bin's answer stretch to
// the far end of cascade 3, which at `LOD0_REACH = 64` is tens of metres.
//
// ══ WHAT IT CHANGES ON SCREEN TODAY, WHICH IS MORE THAN IT LOOKS ═══════════
//
// Hit shading is still Phase 5, so every deposited `L` is zero and the only
// term that survives is transmittance. Run that through the ladder:
//
//     top:  L = 0 + T_top·sky,     T = 0
//     c2:   L = 0 + T_c2·(sky·T_top),  T = T_c2·0 = 0
//     …
//     c0:   L = sky · Π T_i,       T = 0
//
// The c0-only gather this sits behind computed `sky·T_c0` — sky visibility over
// ONE metre. After the merge it is the product of transmittance along the whole
// cascade chain, i.e. sky visibility over the whole reach. Same estimator, four
// levels of range, and that difference is the entire visible payoff of [G].
//
// ══ `srcGather.js` NEEDS NO CHANGE, AND THE REASON IS WORTH STATING ════════
//
// The gather composites `L + T·sky` per bin. After the merge that expression is
// correct in both of the cases it can now meet, which is why nothing there had
// to learn about this file:
//
//   • a fully merged bin has T = 0, so the sky term vanishes and `L` — which
//     already carries the sky down the chain — stands alone. NO DOUBLE COUNT.
//   • a bin whose parent chain broke (no corner probe existed) keeps its own
//     T, and `L_self + T_self·sky` is exactly the c0-only answer it had before.
//
// So a missing parent degrades to the previous behaviour rather than to black,
// which is R1 (an absence is an absence) falling out of the arithmetic instead
// of being coded for.
//
// ══ THE THREE STRUCTURAL DECISIONS ═════════════════════════════════════════
//
// 1. **IT MERGES IN PLACE.** Cascade c's dispatch reads cascade c+1's region of
//    `payload` — written by the PREVIOUS dispatch — and writes only its own.
//    No thread reads the region it writes, and the dispatch boundary between
//    levels is the barrier that makes the read legal. A second buffer would be
//    another 22 MB at the engine default to hold values that are dead the
//    moment the level below has consumed them.
//
// 2. **THE 8 CORNERS ARE RESOLVED ONCE PER PROBE, NOT ONCE PER BIN.** The
//    trilinear corner set is a property of the probe's POSITION, so hoisting it
//    out turns 8 hash lookups per bin into 8 per probe — a factor of `binCount`
//    (32 at c0, 2048 at c3). The corner records are indexed by BIN BLOCK rather
//    than by probe slot, which is both smaller (a cascade has fewer blocks than
//    slots) and exactly the index the merge kernel already has.
//
// 3. **THE CORNER RECORD STORES THE PARENT'S BLOCK, NOT ITS PROBE INDEX.** One
//    more dereference at resolve time, removed from the inner loop — and it
//    keeps `probeTable` out of the merge kernel entirely, which matters because
//    the portable limit is 8 storage buffers per stage and this kernel wants
//    payload + two corner buffers + stats already.
//
// ══ A STALE CORNER RECORD CANNOT BE READ, AND THAT IS AN ARGUMENT ══════════
//
// The corner pass writes records only for blocks a live probe currently holds.
// A block sitting in the free pool keeps whatever it was told last time it was
// claimed, which would be a dangling parent pointer if anything read it. Then
// nothing does: an unclaimed block took no deposits this frame, the deposit's
// clear zeroed its accumulators, and [F] therefore wrote UNKNOWN into every one
// of its bins — so the merge takes its `selfT < 0` early-out before it ever
// looks at the record. The safety comes from the frame order, not from a clear,
// and that is why the order is stated rather than assumed.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.2, §12.18.4-6, §12.18.7 unit 3, §12.19.5.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicStore,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  uint,
  vec3,
} from "three/tsl";
import { CASCADE_COUNT, W0 } from "./srcConfig.js";
import { worldKeysEnabled } from "./srcMath.js";
import {
  cellPosition,
  keyCell,
  keyWorldCell,
  keyLod,
  keySecondary,
  latticeOrigin,
  latticeOriginCell,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";
import { PAYLOAD_WORDS } from "./srcDeposit.js";
import {
  FLAG_ALIVE,
  PROBE_BLOCK,
  PROBE_FLAGS,
  PROBE_KEY,
  PROBE_WORDS,
  SLOT_EMPTY,
  createProbeLookup,
} from "./srcProbes.js";

/** The trilinear corner count. Named because it is also the record stride. */
export const MERGE_CORNERS = 8;

/**
 * Corner ordering, and it must MATCH `srcMath.js`'s `trilinearCorners`.
 *
 * That function pushes with dz outermost and dx innermost, so corner k is
 * `(dx, dy, dz) = (k&1, (k>>1)&1, k>>2)`. The merge itself is order-independent
 * — it is a weighted sum — but the gate compares corner k against corner k, and
 * a silently permuted record would make that comparison meaningless while every
 * energy check still passed.
 */
const CORNER_OFFSETS = Array.from({ length: MERGE_CORNERS }, (_, k) => [
  k & 1, (k >> 1) & 1, (k >> 2) & 1,
]);

/** Merge telemetry. One atomic buffer, eight words. */
export const MERGE_PROBES = 0;   // probes that resolved a corner set (i.e. held a block)
export const MERGE_FOUND = 1;    // parent corners found, out of 8 per probe
export const MERGE_BINS = 2;     // KNOWN self bins the merge visited
export const MERGE_MERGED = 3;   // ...of those, bins that found at least one parent
export const MERGE_ORPHAN = 4;   // ...of those, bins that found none — kept as-is
export const MERGE_OPAQUE = 5;   // merged bins whose T came out exactly 0
export const MERGE_SKY = 6;      // top-cascade bins the sky composited into
export const MERGE_WORDS = 8;

/**
 * Build the merge as a dispatch list.
 *
 * Runs AFTER `createSrcDepositFrame`'s passes — it consumes `[F]`'s resolved
 * payload and overwrites it with the merged one. Every consumer downstream (the
 * gather today, [H]'s bake next) therefore reads merged values with no flag to
 * check, which is the point of doing it in place.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {Node|number} options.spacing0  s₀
 * @param {Node} options.anchor  the lattice anchor — the SAME uniform the
 *   population used. A second anchor would place the parent lattice
 *   plausibly and wrongly, and no energy check could see it.
 * @param {Node} options.sky  vec3 uniform: the radiance the top cascade
 *   composites. Deposited nowhere else — a per-cascade sky deposit would
 *   multiply it by the cascade count (`splitDeposits`' header).
 * @param {Node} [options.camera]  world camera position. REQUIRED under
 *   world-absolute keying (S1) and unused without it: a key holds
 *   `worldCell mod 512` and the representative is resolved within ±256 cells of
 *   the viewer, so the merge cannot turn a key back into a position without it.
 */
export function createSrcMergeFrame(store, bins, {
  spacing0,
  anchor,
  camera = null,
  sky,
  w0 = W0,
} = {}) {
  if (worldKeysEnabled() && !camera) {
    // Loud, at build, rather than a merge that silently interpolates over the
    // wrong lattice — see the `anchor` note above for why that class of bug is
    // invisible to every energy check this module has.
    throw new Error("createSrcMergeFrame: world-absolute keying needs `camera`");
  }
  const { probeTable } = store;
  const { payload } = bins;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const top = N - 1;

  // ── the corner records, indexed by BIN BLOCK ──────────────────────────────
  // Only cascades 0..N−2 have a parent to interpolate over, so the top cascade
  // gets no record at all rather than an empty one.
  const cornerCascades = [];
  let cornerTotal = 0;
  for (let c = 0; c < top; c++) {
    cornerCascades.push({ cascade: c, base: cornerTotal });
    cornerTotal += store.cascades[c].blockCapacity * MERGE_CORNERS;
  }
  const cornerSize = Math.max(1, cornerTotal);
  // Seeded EMPTY rather than zero, for the same reason `PROBE_BLOCK` is: block 0
  // is a real block somebody owns, so a zero-filled record would make every
  // never-written probe look like it interpolates over block 0 eight times.
  const cornerBlock = instancedArray(new Uint32Array(cornerSize).fill(SLOT_EMPTY), "uint");
  const cornerWeight = instancedArray(new Float32Array(cornerSize), "float");
  const stats = instancedArray(new Uint32Array(MERGE_WORDS), "uint").toAtomic();

  const passes = [];

  // ── clear the telemetry ───────────────────────────────────────────────────
  // `atomicStore`, not `.assign` — WGSL will not implicitly convert `u32` to
  // `atomic<u32>` and the module fails to compile, which surfaces as a
  // validation error rather than as wrong numbers. The first version of this
  // pass got it wrong and the counters still LOOKED right, because a fresh
  // buffer is already zero and this gate reads them after a single frame; the
  // bug's real shape is telemetry that doubles on frame two. Same trap
  // `srcDeposit.js` records from the other side (`atomicLoad` on a read).
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    If(i.lessThan(uint(MERGE_WORDS)), () => {
      atomicStore(stats.element(i), uint(0));
    });
  })().compute(MERGE_WORDS));

  // ── [G.1] resolve each probe's 8 parent corners ───────────────────────────
  //
  // Reads nothing the merge writes, so all N−1 of these can run before any
  // merging starts — they depend only on this frame's probe population.
  for (let c = 0; c < top; c++) {
    const info = store.cascades[c];
    const recordBase = cornerCascades[c].base;
    // The PARENT cascade's map. Lookup only: the merge must never create a
    // probe, because a probe created here would have no bins this frame and
    // would have consumed a block that a real receiver needed.
    const lookup = createProbeLookup(store, c + 1);

    passes.push(Fn(() => {
      const i = instanceIndex.toVar();
      const p = uint(info.probeBase).add(i).toVar();
      const w = p.mul(uint(PROBE_WORDS)).toVar();
      If(probeTable.element(w.add(uint(PROBE_FLAGS))).bitAnd(uint(FLAG_ALIVE)).equal(uint(0)),
        () => { Return(); });
      const block = probeTable.element(w.add(uint(PROBE_BLOCK))).toVar();
      // No block means no bins, which means nothing to merge INTO. The record
      // is indexed by block, so there is not even an address to write to.
      If(block.equal(uint(SLOT_EMPTY)), () => { Return(); });
      atomicAdd(stats.element(uint(MERGE_PROBES)), uint(1));

      // WORLD POSITION FROM THE KEY, never from a stored position — same rule
      // the population ladder runs under (`childPosition` in srcProbes). A
      // cached position is a second source of truth that a re-anchor can
      // desynchronize from the key, and the merge is precisely where that
      // desynchronization would put light in the wrong place.
      const key = probeTable.element(w.add(uint(PROBE_KEY))).toVar();
      const lodI = keyLod(key).toVar();
      const lod = float(lodI).toVar();
      const secondary = keySecondary(key).toVar();
      const s = probeSpacing(c, lod, spacing0).toVar();
      // S1: under world-absolute keying the key holds a residue, so the world
      // cell is resolved against the CAMERA (srcMathTsl.keyWorldCell) rather
      // than added to a lattice origin. Same rule, one call.
      const position = (worldKeysEnabled()
        ? vec3(keyWorldCell(key, camera, s)).mul(s)
        : cellPosition(keyCell(key), latticeOrigin(anchor, s), s)).toVar();

      // THE PARENT LATTICE: same LOD, next cascade — so exactly 2× the spacing.
      // The ladder climbs in cascade index and NEVER in LOD (§4.5, no cross-LOD
      // interaction anywhere), which is why `lodI` is carried through unchanged
      // into the parent key below.
      const sp = probeSpacing(c + 1, lod, spacing0).toVar();
      const originP = latticeOrigin(anchor, sp).toVar();
      const f = position.sub(originP).div(sp).toVar();
      const cell0 = floor(f).toVar();
      const t = f.sub(cell0).toVar();
      // Same coordinate-system shift the screen gather documents: the
      // interpolation stays local to `originP`, the KEY goes world-absolute.
      const parentShift = worldKeysEnabled() ? latticeOriginCell(anchor, sp).toVar() : null;
      const baseCell = ivec3(int(cell0.x), int(cell0.y), int(cell0.z)).toVar();
      if (parentShift) baseCell.assign(baseCell.add(parentShift));
      const record = uint(recordBase).add(block.mul(uint(MERGE_CORNERS))).toVar();

      for (let k = 0; k < MERGE_CORNERS; k++) {
        const [dx, dy, dz] = CORNER_OFFSETS[k];
        const weight = (dx ? t.x : float(1).sub(t.x))
          .mul(dy ? t.y : float(1).sub(t.y))
          .mul(dz ? t.z : float(1).sub(t.z))
          .toVar();
        // `packProbeKey` returns KEY_EMPTY for a cell outside the ±256 key
        // window, and the WGSL find returns "absent" for key 0 by its first
        // line — so an out-of-window corner is a missing corner, with no extra
        // guard and no chance of matching some other probe's key.
        const parent = lookup(
          packProbeKey(lodI, secondary, baseCell.add(ivec3(dx, dy, dz))),
        ).toVar();
        const parentBlock = uint(SLOT_EMPTY).toVar();
        If(parent.notEqual(uint(SLOT_EMPTY)), () => {
          // A parent that EXISTS but holds no block is treated as absent, and
          // that is the right reading rather than a corner case: it has no bins,
          // so it has no radiance to contribute. It is also the one place this
          // kernel can diverge from `srcRef.js`, whose CPU probes always have
          // bins — `NOBLOCK` in the probe telemetry is the number that says
          // whether the divergence is live, and on a healthy pool it is zero.
          parentBlock.assign(
            probeTable.element(parent.mul(uint(PROBE_WORDS)).add(uint(PROBE_BLOCK))),
          );
        });
        If(parentBlock.notEqual(uint(SLOT_EMPTY)), () => {
          atomicAdd(stats.element(uint(MERGE_FOUND)), uint(1));
        });
        cornerBlock.element(record.add(uint(k))).assign(parentBlock);
        cornerWeight.element(record.add(uint(k))).assign(weight);
      }
    })().compute(info.probeCapacity));
  }

  // ── [G.2] the top cascade composites the sky ──────────────────────────────
  //
  // Dispatched over the top cascade's whole bin region, claimed blocks and
  // free ones alike: a free block's bins are all UNKNOWN (see the header's
  // staleness argument), so the early-out below covers them and the kernel
  // needs no block→probe map.
  //
  // TRANSMITTANCE IS CONSUMED HERE, not left standing. Nothing above the last
  // cascade can still occlude, so a non-zero T at the top would let every level
  // below composite the sky a second time — the mirror sets it to 0 for exactly
  // this reason and says so.
  {
    const info = bins.cascades[top];
    passes.push(Fn(() => {
      const i = instanceIndex.toVar();
      const o = uint(info.binBase).add(i).mul(uint(PAYLOAD_WORDS)).toVar();
      const T = payload.element(o.add(uint(3))).toVar();
      If(T.lessThan(0), () => { Return(); });
      const S = vec3(sky).toVar();
      payload.element(o).assign(payload.element(o).add(T.mul(S.x)));
      payload.element(o.add(uint(1))).assign(payload.element(o.add(uint(1))).add(T.mul(S.y)));
      payload.element(o.add(uint(2))).assign(payload.element(o.add(uint(2))).add(T.mul(S.z)));
      payload.element(o.add(uint(3))).assign(float(0));
      atomicAdd(stats.element(uint(MERGE_SKY)), uint(1));
    })().compute(info.bins * info.blockCapacity));
  }

  // ── [G.3] the ladder, cascade N−2 → 0 ─────────────────────────────────────
  for (let c = top - 1; c >= 0; c--) {
    const info = bins.cascades[c];
    const parentInfo = bins.cascades[c + 1];
    const nBins = info.bins;
    const recordBase = cornerCascades[c].base;

    passes.push(Fn(() => {
      // One thread per (block, bin). `nBins` is a power of two at every
      // cascade (2·w₀²·4^c), so both of these are shifts.
      const i = instanceIndex.toVar();
      const block = i.div(uint(nBins)).toVar();
      const m = i.mod(uint(nBins)).toVar();
      const o = uint(info.binBase).add(block.mul(uint(nBins))).add(m)
        .mul(uint(PAYLOAD_WORDS)).toVar();

      // AN UNKNOWN SELF BIN STAYS UNKNOWN. It is not "no light" — no ray
      // sampled this direction, so there is nothing for the parent to shine
      // through. Merging a parent into it would invent an interval estimate
      // this probe never made, and at 0.78 rays per bin (§12.13.4) that
      // invention would be most of the buffer.
      const selfT = payload.element(o.add(uint(3))).toVar();
      If(selfT.lessThan(0), () => { Return(); });
      atomicAdd(stats.element(uint(MERGE_BINS)), uint(1));

      const record = uint(recordBase).add(block.mul(uint(MERGE_CORNERS))).toVar();
      const acc = vec3(0).toVar();
      const accT = float(0).toVar();
      const wsum = float(0).toVar();

      for (let k = 0; k < MERGE_CORNERS; k++) {
        const parentBlock = cornerBlock.element(record.add(uint(k))).toVar();
        const weight = cornerWeight.element(record.add(uint(k))).toVar();
        If(parentBlock.notEqual(uint(SLOT_EMPTY)).and(weight.greaterThan(0)), () => {
          // ── THE 4→1 PRE-AVERAGE, AND ITS DIRECTION ────────────────────────
          //
          // Bins get FINER as the cascade index rises (|D_i| = 2·w₀²·4^i), so
          // the level ABOVE has four bins for every one of ours and what this
          // level consumes is their average. Morton order is what makes those
          // four CONTIGUOUS — they are exactly `4m … 4m+3`, proved in the
          // Phase-0 suite's Morton-contiguity arm — so this is one aligned run
          // of four rather than four strided fetches.
          //
          // Getting it backwards (halving our own index to address the level
          // above) reads a bin pointing somewhere else entirely. It costs no
          // energy and throws no error; it delivers the wrong DIRECTION's
          // radiance, which reads as a hue rotation that survives every energy
          // check. The gate's pre-average arm exists for exactly this.
          const pBase = uint(parentInfo.binBase)
            .add(parentBlock.mul(uint(parentInfo.bins)))
            .add(m.mul(uint(4)))
            .toVar();
          const pL = vec3(0).toVar();
          const pT = float(0).toVar();
          const known = float(0).toVar();
          for (let j = 0; j < 4; j++) {
            const op = pBase.add(uint(j)).mul(uint(PAYLOAD_WORDS)).toVar();
            const t = payload.element(op.add(uint(3))).toVar();
            // UNKNOWN CHILDREN ARE SKIPPED and the average renormalizes over
            // what was found — the same "rejection weights are epsilons, never
            // zeros" rule the sparse gather below runs under. All four unknown
            // makes the whole corner absent, not black.
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
            acc.addAssign(pL.mul(inv).mul(weight));
            accT.addAssign(pT.mul(inv).mul(weight));
            wsum.addAssign(weight);
          });
        });
      }

      // ── the renormalized sparse gather ──────────────────────────────────
      // Sum what exists times its weight, divide by the weight FOUND. A missing
      // corner must not be spent as a dark vote (R1); dividing by the full
      // weight instead would dim every probe near the edge of the parent
      // population, which is a cliff exactly where the population is thinnest.
      If(wsum.greaterThan(0), () => {
        const invW = float(1).div(wsum).toVar();
        const parentL = acc.mul(invW).toVar();
        const parentT = accT.mul(invW).toVar();
        const outL = vec3(
          payload.element(o),
          payload.element(o.add(uint(1))),
          payload.element(o.add(uint(2))),
        ).add(parentL.mul(selfT)).toVar();
        const outT = selfT.mul(parentT).toVar();
        payload.element(o).assign(outL.x);
        payload.element(o.add(uint(1))).assign(outL.y);
        payload.element(o.add(uint(2))).assign(outL.z);
        payload.element(o.add(uint(3))).assign(outT);
        atomicAdd(stats.element(uint(MERGE_MERGED)), uint(1));
        If(outT.equal(0), () => { atomicAdd(stats.element(uint(MERGE_OPAQUE)), uint(1)); });
      }).Else(() => {
        // NO PARENT PROBE EXISTED. The bin keeps its own interval and stays
        // transparent above it — NOT a black vote — so temporal accumulation
        // can fill it in on a later frame and `srcGather`'s `L + T·sky` still
        // gives it the c0-only answer meanwhile. A fixed-radius fallback here
        // is precisely the cliff R1 forbids.
        atomicAdd(stats.element(uint(MERGE_ORPHAN)), uint(1));
      });
    })().compute(info.blockCapacity * nBins));
  }

  return {
    passes,
    cornerBlock,
    cornerWeight,
    cornerCascades,
    stats,
    bytes: (cornerSize * 2 + MERGE_WORDS) * 4,
    w0,

    /**
     * One frame's merge telemetry.
     *
     * `orphanRate` is the one to watch: it is the fraction of known bins whose
     * parent lattice had no probe at all, i.e. how much of the frame is still
     * getting the c0-only answer. A rate that climbs when the camera moves is
     * the population thinning at the top of the ladder, which is a probe-budget
     * story and not a merge one.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, bins: 0, merged: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const probes = v[MERGE_PROBES] >>> 0;
      const visited = v[MERGE_BINS] >>> 0;
      const merged = v[MERGE_MERGED] >>> 0;
      return {
        dispatched: true,
        probes,
        // Mean parent corners found per probe, out of 8. Below ~4 means the
        // parent cascade is sparser than the trilinear stencil wants, and the
        // renormalization is carrying the result.
        meanCorners: probes > 0 ? (v[MERGE_FOUND] >>> 0) / probes : 0,
        bins: visited,
        merged,
        orphans: v[MERGE_ORPHAN] >>> 0,
        opaque: v[MERGE_OPAQUE] >>> 0,
        sky: v[MERGE_SKY] >>> 0,
        orphanRate: visited > 0 ? (v[MERGE_ORPHAN] >>> 0) / visited : 0,
        // Merged bins that reached T = 0, i.e. whose parent chain resolved all
        // the way to the sky. With hit shading absent this is also the fraction
        // of the frame that gets the FULL-RANGE answer rather than a partial
        // one, so it is the number that says the ladder is connected.
        resolvedRate: merged > 0 ? (v[MERGE_OPAQUE] >>> 0) / merged : 0,
      };
    },

    dispose() {
      for (const b of [cornerBlock, cornerWeight, stats]) b?.value?.dispose?.();
    },
  };
}

/** The per-frame merge line, for the telemetry log. */
export function formatSrcMerge(m) {
  if (!m?.dispatched) return "";
  return `merge ${m.merged}/${m.bins} bins (${(m.resolvedRate * 100).toFixed(0)}% to sky, ` +
    `${(m.orphanRate * 100).toFixed(1)}% orphan, ${m.meanCorners.toFixed(1)}/8 corners)`;
}
