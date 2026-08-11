// SPLIT RADIANCE CASCADES — Algorithm 3, the ray budget.
//
// Counts propagate UP (a parent's count is the sum of its children's), then
// offsets are handed DOWN, so that every probe sharing a parent occupies a
// CONTIGUOUS segment of the one global R2 sequence. `srcRef.js`'s `assignRays`
// is the mirror and its header carries the WHY at length; the short version is
// that a coarse probe's 512 direction bins are covered semi-uniformly only
// because the rays reaching it are a contiguous R2 run. Hand each child an
// arbitrary scatter instead and bin coverage becomes a lottery — some bins get
// eight rays, some none, and the empty ones are exactly what the merge then has
// to renormalize around.
//
// ══ WHY THERE IS NO PREFIX SCAN AND NO CHILD LIST ═══════════════════════════
//
// Read as written, Alg. 3 wants two things the GPU is bad at: a prefix sum over
// the top cascade, and "the children of probe P", which is not a contiguous
// range anywhere and looks like it needs a compaction pass. Neither is
// necessary, and the same trick removes both.
//
// **An atomic cursor IS an offset allocator.** Give a parent a cursor
// initialized to its own `rayOffset` and let each child claim its slice with one
// `atomicAdd(cursor, myCount)` — the returned value IS the child's offset, and
// the claims partition the parent's range exactly, with no gaps and no overlaps.
// One atomic per probe replaces the compaction. The top cascade is the same
// move against a single global cursor, which replaces the scan.
//
// **What it does NOT preserve is ORDER within a parent.** The assignment is
// scheduler-dependent, so a probe's ray INDICES differ between two runs of the
// same frame. Every gate here must therefore check the PARTITION — each index
// used exactly once, each parent's children covering its range contiguously —
// and never the specific indices, exactly as `test:gi-src-probes` compares key
// sets rather than indirection indices, and for the same underlying reason.
// Under temporal accumulation the non-determinism is a mild positive: a probe's
// directions vary frame to frame, which is coverage the R2 sequence would not
// otherwise give.
//
// ══ WHY THE COUNTS DO NOT LIVE IN `probeTable` ══════════════════════════════
//
// `PROBE_RAYS` is reserved for exactly this and it is still written — but as a
// PLAIN COPY by the owning thread, after the fact. The accumulating counter has
// to be atomic (every pixel adds into its c0 probe, every child into its
// parent), and `probeTable` cannot become an atomic buffer: `srcGizmos.js` reads
// it from a VERTEX stage, where WebGPU only binds storage buffers read-only and
// an atomic needs read_write. Making the table atomic would silently cost the
// debug view.
//
// Aliasing one buffer behind both an atomic and a non-atomic node is the other
// obvious way out, and `srcProbes.js` already considered and rejected it — one
// buffer, one definition of what it is. So the accumulators are their own
// buffers, and the table keeps the settled answer.
//
// docs/GI_SRC_REBUILD_PLAN.md §12.13.3, §12.13.5 unit 2.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  instanceIndex,
  instancedArray,
  uint,
} from "three/tsl";
import { CASCADE_COUNT } from "./srcConfig.js";
import {
  FLAG_ALIVE,
  PROBE_FLAGS,
  PROBE_PARENT,
  PROBE_RAYOFF,
  PROBE_RAYS,
  PROBE_WORDS,
  SLOT_EMPTY,
} from "./srcProbes.js";

/**
 * The per-probe ray budget, bound to one probe store.
 *
 * Three buffers, and each earns its own because of who writes it:
 *   `rayCount`   atomic — every pixel and every child adds into it
 *   `rayCursor`  atomic — the offset allocator, one per probe
 *   `pixelRayBase`  plain — one entry per pixel, written by its own thread
 *
 * `totalRays` is a single atomic word rather than a slot borrowed from the
 * probe counters: the counter block's layout belongs to the population, and a
 * ray total living inside it would make the two modules share a clear pass.
 */
export function createSrcRayStore(store, { pixelCount }) {
  const { probeTotal } = store;
  const rayCount = instancedArray(new Uint32Array(probeTotal), "uint").toAtomic();
  const rayCursor = instancedArray(new Uint32Array(probeTotal), "uint").toAtomic();
  const rayTotal = instancedArray(new Uint32Array(1), "uint").toAtomic();
  const pixelRayBase = instancedArray(new Uint32Array(pixelCount).fill(SLOT_EMPTY), "uint");
  return {
    rayCount,
    rayCursor,
    rayTotal,
    pixelRayBase,
    pixelCount,
    bytes: (probeTotal * 2 + 1 + pixelCount) * 4,
    dispose() {
      for (const b of [rayCount, rayCursor, rayTotal, pixelRayBase]) b?.value?.dispose?.();
    },
  };
}

/** Is this probe index alive? The one spelling, so no pass invents a second. */
function probeAlive(probeTable, probe) {
  return probeTable
    .element(probe.mul(PROBE_WORDS).add(PROBE_FLAGS))
    .bitAnd(uint(FLAG_ALIVE))
    .notEqual(uint(0));
}

/**
 * [D] — the whole of Alg. 3 as a dispatch list, in order.
 *
 * The order IS the algorithm and every gap is a real barrier: a cascade's
 * counts are not complete until every child below has added into them, and no
 * offset can be handed down before the total above is settled. WebGPU has no
 * device-wide barrier inside a dispatch, so these cannot be fused — fusing
 * would not produce a faster kernel, it would produce a race (the same reason
 * `srcProbes.js` keeps its own passes separate).
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} rays   from `createSrcRayStore`
 * @param {object} options
 * @param {object} options.pixelProbe  the population's per-pixel c0 probe index
 * @param {number} options.raysPerPixel
 * @param {Node} [options.stride]  ray-ceiling stride, a UNIFORM — see below.
 * @param {Node} [options.phase]   which residue class this frame fires.
 */
export function createSrcRayFrame(
  store, rays, { pixelProbe, raysPerPixel = 1, stride = null, phase = null } = {},
) {
  const { probeTable, probeTotal, cascades } = store;
  const { rayCount, rayCursor, rayTotal, pixelRayBase, pixelCount } = rays;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const top = cascades[N - 1];

  // ══ THE RAY CEILING'S STRIDE — ONE PREDICATE, TWO CALLERS ══════════════════
  //
  // `srcConfig.js`'s `transportRays` caps rays per frame; above the cap only
  // every `stride`-th pixel participates, and `phase` rotates each frame so the
  // whole screen is covered over `stride` frames into the Phase-4 accumulator.
  // That is the same move `jitterX/Y` already makes on the R2 sequence — shift
  // per frame, let accumulation do the covering — applied to the pixel domain.
  //
  // ⚠ IT MUST BE ONE EXPRESSION AND THIS IS NOT A STYLE PREFERENCE. [D1] counts
  // a probe's rays and [D5] hands each pixel a slice of exactly that count. If
  // [D5] admitted a pixel [D1] did not count, its `atomicAdd` would return an
  // offset PAST the probe's segment and it would write into the next probe's
  // rays — silent cross-probe corruption, no assertion anywhere, and it would
  // present as a few wrongly-lit probes rather than as a crash. The reverse
  // (counted but not claimed) merely wastes slots. So both call THIS closure;
  // neither open-codes it. Same discipline as `latticeOriginFor` living in
  // srcMath so the two twins cannot drift.
  //
  // Stride is a UNIFORM, so changing the ceiling is a uniform write, not a
  // rebuild (R11) — the dispatch counts stay `pixelCount` and every pipeline
  // survives a resize of the budget. `stride = 1` makes this identically false,
  // which is the configuration every gate runs and why they are unaffected.
  const strideSkips = stride && phase
    ? (i) => i.add(phase).mod(stride).notEqual(uint(0))
    : null;

  const passes = [];

  // ── [D0] clear ────────────────────────────────────────────────────────────
  // `rayCursor` is NOT cleared: every live probe overwrites it with its own
  // offset before any child reads it, and a dead probe's stale cursor is never
  // read (nothing claims from a parent that is SLOT_EMPTY). Clearing it anyway
  // would be a second, weaker statement of the same invariant.
  //
  // `PROBE_RAYOFF` goes to SLOT_EMPTY rather than 0. Zero is a VALID offset —
  // exactly one probe per frame legitimately owns it — so a dead probe left at
  // 0 is indistinguishable from the probe that owns the start of the sequence,
  // and a consumer walking a broken ancestor chain would deposit into ray 0.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    atomicStore(rayCount.element(i), uint(0));
    const w = i.mul(PROBE_WORDS).toVar();
    probeTable.element(w.add(PROBE_RAYS)).assign(uint(0));
    probeTable.element(w.add(PROBE_RAYOFF)).assign(uint(SLOT_EMPTY));
    If(i.equal(uint(0)), () => { atomicStore(rayTotal.element(uint(0)), uint(0)); });
  })().compute(probeTotal));

  // ── [D1] c0 counts, from the pixels ───────────────────────────────────────
  // The count is per PIXEL, not per probe: `raysPerPixel` rays are born at each
  // pixel and the probe's budget is their sum. A probe covering forty pixels
  // gets forty times the rays of one covering a single pixel, which is what
  // makes the budget follow screen coverage instead of probe count.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    if (strideSkips) If(strideSkips(i), () => { Return(); });
    const probe = pixelProbe.element(i).toVar();
    If(probe.equal(uint(SLOT_EMPTY)), () => { Return(); });
    atomicAdd(rayCount.element(probe), uint(raysPerPixel));
  })().compute(pixelCount));

  // ── [D2] propagate counts UP, one cascade per dispatch ────────────────────
  // Strictly one level at a time. Cascade 2's total is not correct until every
  // cascade-1 probe has finished adding into it, so a fused loop over levels
  // would read a partially-summed parent — the classic silent-undercount, and
  // it would present as far cascades that are merely DIM rather than wrong.
  for (let c = 1; c < N; c++) {
    const child = cascades[c - 1];
    passes.push(Fn(() => {
      const i = instanceIndex.add(uint(child.probeBase)).toVar();
      If(probeAlive(probeTable, i).not(), () => { Return(); });
      const parent = probeTable.element(i.mul(PROBE_WORDS).add(PROBE_PARENT)).toVar();
      If(parent.equal(uint(SLOT_EMPTY)), () => { Return(); });
      atomicAdd(rayCount.element(parent), atomicLoad(rayCount.element(i)));
    })().compute(child.probeCapacity));
  }

  // ── [D3] the top cascade partitions [0, totalRays) ────────────────────────
  // One global cursor instead of a prefix scan. The mirror walks its top
  // cascade in table order and accumulates; this claims in scheduler order. The
  // two produce DIFFERENT offsets for the same probe and the same partition of
  // the same interval, which is the property the gate checks.
  passes.push(Fn(() => {
    const i = instanceIndex.add(uint(top.probeBase)).toVar();
    If(probeAlive(probeTable, i).not(), () => { Return(); });
    const n = atomicLoad(rayCount.element(i)).toVar();
    const off = atomicAdd(rayTotal.element(uint(0)), n).toVar();
    const w = i.mul(PROBE_WORDS).toVar();
    probeTable.element(w.add(PROBE_RAYS)).assign(n);
    probeTable.element(w.add(PROBE_RAYOFF)).assign(off);
    // Seed my own cursor for my children, who read it in the NEXT dispatch —
    // so this is a write-then-read across a barrier, not a race.
    atomicStore(rayCursor.element(i), off);
  })().compute(top.probeCapacity));

  // ── [D4] hand offsets DOWN, one cascade per dispatch ──────────────────────
  // Each probe does three things in one pass: claim its slice from its parent's
  // cursor, record it, and seed its own cursor for the level below. That the
  // seed is safe is the same barrier argument as [D3] — my children run in the
  // next dispatch.
  //
  // A probe with no parent gets NOTHING, deliberately. It cannot be reached by
  // a split deposit (which walks the chain downward from the top), so giving it
  // a range would allocate rays no pixel can ever fire. `test:gi-src-populate`
  // asserts there are none in a healthy frame; this pass survives one rather
  // than corrupting the partition around it.
  for (let c = N - 1; c >= 1; c--) {
    const child = cascades[c - 1];
    passes.push(Fn(() => {
      const i = instanceIndex.add(uint(child.probeBase)).toVar();
      If(probeAlive(probeTable, i).not(), () => { Return(); });
      const w = i.mul(PROBE_WORDS).toVar();
      const parent = probeTable.element(w.add(PROBE_PARENT)).toVar();
      If(parent.equal(uint(SLOT_EMPTY)), () => { Return(); });
      const n = atomicLoad(rayCount.element(i)).toVar();
      const off = atomicAdd(rayCursor.element(parent), n).toVar();
      probeTable.element(w.add(PROBE_RAYS)).assign(n);
      probeTable.element(w.add(PROBE_RAYOFF)).assign(off);
      atomicStore(rayCursor.element(i), off);
    })().compute(child.probeCapacity));
  }

  // ── [D5] each pixel claims its own slice of its c0 probe's segment ────────
  // The last level of the same allocator, and the one a ray kernel actually
  // reads: ray r of pixel p is global index `pixelRayBase[p] + r`. A pixel
  // whose probe is SLOT_EMPTY keeps SLOT_EMPTY here, which is how the trace
  // knows not to fire.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    const probe = pixelProbe.element(i).toVar();
    // A strided-out pixel takes the SAME exit as a pixel with no probe:
    // `pixelRayBase = SLOT_EMPTY`. That is what makes the deposit need no edit
    // at all — its [E] already returns on that value, so "this pixel is not
    // sampled this frame" reuses the path for "this pixel has no probe".
    const skip = strideSkips ? probe.equal(uint(SLOT_EMPTY)).or(strideSkips(i)) : probe.equal(uint(SLOT_EMPTY));
    If(skip, () => {
      pixelRayBase.element(i).assign(uint(SLOT_EMPTY));
      Return();
    });
    pixelRayBase.element(i).assign(atomicAdd(rayCursor.element(probe), uint(raysPerPixel)));
  })().compute(pixelCount));

  return {
    passes,
    raysPerPixel,

    /** Total rays this frame — the top cascade's partition length. Async. */
    async readTotal(renderer) {
      const allocated = !!renderer?.backend?.get?.(rayTotal.value)?.buffer;
      if (!allocated) return 0;
      return new Uint32Array(await renderer.getArrayBufferAsync(rayTotal.value))[0] >>> 0;
    },
  };
}
