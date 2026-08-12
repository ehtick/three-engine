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
  float,
  instanceIndex,
  instancedArray,
  select,
  uint,
} from "three/tsl";
import { CASCADE_COUNT } from "./srcConfig.js";
import { transportPixel } from "./srcMathTsl.js";
import {
  FLAG_ALIVE,
  INFLUX_ONE,
  PROBE_BLOCK,
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
  // ── THE WORKLIST (§12.44 — ray compaction) ────────────────────────────────
  // The pixels [D5] actually granted a slice this frame, DENSE. The deposit's
  // [E] used to map thread → pixel and early-return on the losers; under the
  // per-probe cap the winners are ~19% of threads SCATTERED across warps, so
  // nearly every warp still contained a tracer and the cap's 5× ray cut
  // bought almost no wall-clock (measured: 19 ms for 25k rays on the user's
  // editor — warp-density, not work). [E] reading this list traces at full
  // warp density; the trailing threads return in WHOLE warps, which is the
  // cheap kind of idle. Capacity is `pixelCount` — winners are a subset of
  // pixels in every path.
  //
  // ⚠ ONE BUFFER — word 0 is the count, entries follow — NOT a count buffer
  // plus a list buffer. [E] sits at 7 of 8 storage buffers in the smoke's
  // profiled ray-hit config (§12.39's measurement, and the smoke IS the
  // binding-budget gate): the two-buffer draft pushed it to 9, the pipeline
  // failed VALIDATION, and [E] silently never dispatched — the smoke read
  // zero deposits against a full worklist for exactly as long as anyone
  // waited. R7 said fold, don't multiply bindings; this is that rule with a
  // measurement attached.
  const rayWork = instancedArray(new Uint32Array(1 + pixelCount), "uint").toAtomic();
  return {
    rayCount,
    rayCursor,
    rayTotal,
    pixelRayBase,
    rayWork,
    pixelCount,
    bytes: (probeTotal * 2 + 2 + pixelCount * 2) * 4,
    dispose() {
      for (const b of [rayCount, rayCursor, rayTotal, pixelRayBase, rayWork]) {
        b?.value?.dispose?.();
      }
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
 * @param {Node} [options.cap]  per-probe ray cap, a UNIFORM floored to a
 *   multiple of `raysPerPixel` — see [D1'] and the [D5] denial. Omitted, the
 *   frame is bit-identical to the uncapped build, which is where every gate
 *   written before the cap runs.
 */
export function createSrcRayFrame(
  store, rays, { pixelProbe, raysPerPixel = 1, stride = null, phase = null, threads = 0, cap = null } = {},
) {
  const { probeTable, probeTotal, cascades } = store;
  const { rayCount, rayCursor, rayTotal, pixelRayBase, rayWork, pixelCount } = rays;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const top = cascades[N - 1];

  // ══ THE RAY CEILING — A SMALLER DISPATCH, NOT A SKIPPED ONE ════════════════
  //
  // `srcConfig.js`'s `transportRays` caps rays per frame. The first version of
  // this kept the dispatch at `pixelCount` and had non-participating threads
  // return; measured, those returning threads cost a 1.930 ms floor at 499,720
  // px and ~6 ms at the user's resolution (§12.32). So the DISPATCH shrinks:
  // `threads` threads, thread `t` owning pixel `t·stride + phase`, with `phase`
  // rotating per frame so the screen is covered over `stride` frames. Same move
  // `jitterX/Y` makes on the R2 sequence, applied to the pixel domain.
  //
  // ⚠ ONE MAPPING, THREE CALLERS, AND THIS IS NOT A STYLE PREFERENCE. [D1]
  // counts a probe's rays, [D5] hands each pixel a slice of exactly that count,
  // and the deposit's [E] fires them. If [D5] admitted a pixel [D1] had not
  // counted, its `atomicAdd` returns an offset PAST the probe's segment and
  // writes into the NEXT probe's rays — no assertion anywhere, no crash, and it
  // presents as a few wrongly-lit probes. So all three go through
  // `transportPixel` in srcMathTsl, the same discipline that put
  // `latticeOrigin` there so the twins could not drift.
  //
  // `threads` is baked into `.compute()` (three bakes dispatch counts), and it
  // is derived from the TIER's ceiling rather than from the resolution — so it
  // is resolution-INDEPENDENT, and a viewport resize no longer rebuilds these
  // passes. `stride` and `phase` stay uniforms, so moving the ceiling inside
  // that budget is still a uniform write and not a rebuild (R11).
  const strided = stride && phase && threads > 0;
  const pixelOf = strided
    ? (t) => transportPixel(t, stride, phase).toVar()
    : (t) => t;
  // With `threads > pixelCount` (a small viewport under a generous ceiling)
  // `t·stride + phase` runs past the end. Skip, never wrap — see
  // `transportPixel`'s header for why a wrap is a double deposit rather than a
  // wasted thread.
  const outOfRange = strided
    ? (p) => p.greaterThanEqual(uint(pixelCount))
    : null;
  const dispatchCount = strided ? threads : pixelCount;

  const passes = [];

  // ── [D0] clear ────────────────────────────────────────────────────────────
  // `rayCursor` is NOT cleared (uncapped): every live probe overwrites it with
  // its own offset before any child reads it, and a dead probe's stale cursor
  // is never read (nothing claims from a parent that is SLOT_EMPTY). Clearing
  // it anyway would be a second, weaker statement of the same invariant.
  // UNDER A CAP it IS cleared — not to restate that invariant but because the
  // cursor moonlights as the natural-count accumulator until [D3] (see [D1'']),
  // and an accumulator must start at zero.
  //
  // `PROBE_RAYOFF` goes to SLOT_EMPTY rather than 0. Zero is a VALID offset —
  // exactly one probe per frame legitimately owns it — so a dead probe left at
  // 0 is indistinguishable from the probe that owns the start of the sequence,
  // and a consumer walking a broken ancestor chain would deposit into ray 0.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    atomicStore(rayCount.element(i), uint(0));
    // Under a cap the cursor's dead window ([D0]..[D3]) is spent as the
    // NATURAL-count accumulator — see [D1'']. Parent slots must start at zero
    // for the natural propagate's adds; without a cap the cursor stays
    // uncleared for the reason the header below gives.
    if (cap) atomicStore(rayCursor.element(i), uint(0));
    const w = i.mul(PROBE_WORDS).toVar();
    probeTable.element(w.add(PROBE_RAYS)).assign(uint(0));
    probeTable.element(w.add(PROBE_RAYOFF)).assign(uint(SLOT_EMPTY));
    If(i.equal(uint(0)), () => {
      atomicStore(rayTotal.element(uint(0)), uint(0));
      atomicStore(rayWork.element(uint(0)), uint(0));
    });
  })().compute(probeTotal));

  // ── [D1] c0 counts, from the pixels ───────────────────────────────────────
  // The count is per PIXEL, not per probe: `raysPerPixel` rays are born at each
  // pixel and the probe's budget is their sum. A probe covering forty pixels
  // gets forty times the rays of one covering a single pixel, which is what
  // makes the budget follow screen coverage instead of probe count.
  passes.push(Fn(() => {
    const i = pixelOf(instanceIndex.toVar());
    if (outOfRange) If(outOfRange(i), () => { Return(); });
    const probe = pixelProbe.element(i).toVar();
    If(probe.equal(uint(SLOT_EMPTY)), () => { Return(); });
    atomicAdd(rayCount.element(probe), uint(raysPerPixel));
  })().compute(dispatchCount));

  // ── [D1'] the per-probe cap (srcConfig's `probeRayCap`) ───────────────────
  // Clamped AT THE SOURCE, before anything reads a count: [D2] then propagates
  // capped sums, [D3]/[D4] partition capped sums, and [D5] hands out slices of
  // a capped segment — one clamp, four consumers, no second definition. The
  // load-then-store is not a race: this pass is the only writer of `rayCount`
  // between the [D1] barrier and [D2], and each thread owns one slot.
  //
  // `cap` is a UNIFORM (srcSystem polls the hatch per frame), so capping is an
  // in-page A/B. The off value is srcConfig's PROBE_RAY_CAP_OFF, at which the
  // min never binds and this build is behaviourally the uncapped one.
  //
  // c0 only. Upper cascades hold SUMS of capped children — capping them again
  // would be a second, different budget with no owner.
  if (cap) {
    const c0 = cascades[0];
    passes.push(Fn(() => {
      const i = instanceIndex.add(uint(c0.probeBase)).toVar();
      const n = atomicLoad(rayCount.element(i)).toVar();
      // Save the NATURAL count before clamping — into `rayCursor`, which is
      // dead storage until [D3] seeds it. The α compensation needs
      // capped/natural per probe ([D1''] below), and after this store the
      // natural value exists nowhere else.
      atomicStore(rayCursor.element(i), n);
      If(n.greaterThan(uint(cap)), () => {
        atomicStore(rayCount.element(i), uint(cap));
      });
    })().compute(c0.probeCapacity));
  }

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

  // ── [D1''] the influx words (§12.40.4's α compensation) ───────────────────
  // Only under a cap, like [D1']. Two stages, both in `rayCursor`'s dead
  // window and both BEFORE [D3] repurposes it as the offset allocator:
  //
  //   1. propagate the NATURAL counts up, exactly [D2]'s shape on the cursor
  //      buffer — a parent's natural demand is the sum of its children's,
  //      the same statement [D2] makes about the capped counts;
  //   2. per probe, publish `round(65536 · capped/natural)` into the store's
  //      per-block influx region, where the decay reads it (srcDeposit.js)
  //      and slows to hold `influx/(1−keep′)` at its uncapped value.
  //
  // The publish covers ALL cascades: a parent's deposits are its children's
  // rays, so a capped child starves its whole ancestor chain and every block
  // on it needs the ratio, not just c0's. `natural == 0` publishes
  // INFLUX_ONE — no evidence was cut if none was demanded — which is also
  // what keeps a probe whose pixels sit outside this frame's residue class
  // from freezing its block's decay. Dead probes that still hold a block get
  // INFLUX_ONE the same way (their counts are zero), and a FREED block's
  // stale word is unreachable memory: the claim stamp zeroes it before any
  // new owner accumulates (§12.23.5).
  //
  // With the cap at PROBE_RAY_CAP_OFF the clamp never binds, capped == natural
  // everywhere, and every word is exactly INFLUX_ONE — the decay's
  // compensation branch never fires and the build is behaviourally the
  // uncapped one, same statement [D1'] makes.
  if (cap) {
    const { freeStack, blockInfluxBase } = store;
    for (let c = 1; c < N; c++) {
      const child = cascades[c - 1];
      passes.push(Fn(() => {
        const i = instanceIndex.add(uint(child.probeBase)).toVar();
        If(probeAlive(probeTable, i).not(), () => { Return(); });
        const parent = probeTable.element(i.mul(PROBE_WORDS).add(PROBE_PARENT)).toVar();
        If(parent.equal(uint(SLOT_EMPTY)), () => { Return(); });
        atomicAdd(rayCursor.element(parent), atomicLoad(rayCursor.element(i)));
      })().compute(child.probeCapacity));
    }
    for (let c = 0; c < N; c++) {
      const info = cascades[c];
      const base = blockInfluxBase + info.blockBase;
      passes.push(Fn(() => {
        const i = instanceIndex.add(uint(info.probeBase)).toVar();
        const block = probeTable.element(i.mul(PROBE_WORDS).add(PROBE_BLOCK)).toVar();
        If(block.equal(uint(SLOT_EMPTY)), () => { Return(); });
        const slot = freeStack.element(uint(base).add(block));
        const natural = atomicLoad(rayCursor.element(i)).toVar();
        If(natural.equal(uint(0)), () => {
          slot.assign(uint(INFLUX_ONE));
          Return();
        });
        const capped = atomicLoad(rayCount.element(i)).toVar();
        // f32 is exact here: counts are far under 2^24, the divide is the one
        // correctly-rounded op, and ·65536 (+0.5, then truncate) shifts the
        // exponent without touching the mantissa — `Math.fround` on the
        // divide is all the mirror needs to match bit for bit.
        slot.assign(uint(float(capped).div(float(natural)).mul(INFLUX_ONE).add(0.5)));
      })().compute(info.probeCapacity));
    }
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
    const i = pixelOf(instanceIndex.toVar());
    if (outOfRange) If(outOfRange(i), () => { Return(); });
    const probe = pixelProbe.element(i).toVar();
    If(probe.equal(uint(SLOT_EMPTY)), () => {
      pixelRayBase.element(i).assign(uint(SLOT_EMPTY));
      Return();
    });
    // Winners append themselves to the WORKLIST (`rayWork`) — the store doc
    // carries why. Written here rather than in a separate pass because [D5]
    // is the one place "this pixel fires this frame" is decided; a second
    // pass would be a second definition of the winner set, the exact
    // mismatch the transportPixel discipline exists to prevent.
    if (!cap) {
      pixelRayBase.element(i).assign(atomicAdd(rayCursor.element(probe), uint(raysPerPixel)));
      atomicStore(rayWork.element(atomicAdd(rayWork.element(uint(0)), uint(1)).add(uint(1))), i);
      return;
    }
    // Under the cap, more pixels want slices than the segment holds, so a
    // claim can come back PAST the probe's end — deny it, never shrink it.
    // The claim happens first (the cursor is the allocator; a denied pixel
    // advancing it past `end` is harmless overrun in a region nothing owns),
    // and the check is whole-slice: `cap` is floored to a multiple of
    // `raysPerPixel` (srcConfig.srcProbeRayCap), so `off < end` and
    // `off + rpp <= end` are the same statement and the winning claims tile
    // the capped segment EXACTLY — the coverage gate still holds under caps.
    //
    // `end` reads the table AFTER [D4] settled it, same barrier argument as
    // the cursor seeds. A probe with no offset (broken ancestor chain —
    // `test:gi-src-populate` asserts none exist) denies here too, where the
    // uncapped path would have written rays into whatever segment the stale
    // cursor pointed at.
    const w = probe.mul(PROBE_WORDS).toVar();
    const rayOff = probeTable.element(w.add(PROBE_RAYOFF)).toVar();
    const off = atomicAdd(rayCursor.element(probe), uint(raysPerPixel)).toVar();
    const denied = rayOff.equal(uint(SLOT_EMPTY)).or(
      off.add(uint(raysPerPixel)).greaterThan(rayOff.add(probeTable.element(w.add(PROBE_RAYS)))),
    ).toVar();
    pixelRayBase.element(i).assign(select(denied, uint(SLOT_EMPTY), off));
    If(denied.not(), () => {
      atomicStore(rayWork.element(atomicAdd(rayWork.element(uint(0)), uint(1)).add(uint(1))), i);
    });
  })().compute(dispatchCount));
  // ⚠ `pixelRayBase` IS NO LONGER FULLY REWRITTEN EACH FRAME. With a strided
  // dispatch only this frame's residue class is touched, so every other entry
  // holds a base from whichever frame last owned it. That is safe for exactly
  // one reason: the deposit's [E] walks the SAME mapping with the SAME uniforms
  // in the same frame, so it reads only entries this pass just wrote. It is not
  // safe for a consumer that scans the whole buffer, and there is no such
  // consumer today — `pixelRayBase` is read by [E] and nothing else. A future
  // full-buffer reader needs a clear pass, not a bug report.

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
