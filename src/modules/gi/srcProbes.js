// SPLIT RADIANCE CASCADES — THE GPU PROBE HASHMAP.
//
// Plan §4.1 steps [B]/[C]/[K], §4.2 "Buffers". This file owns the structure
// every later phase indexes through: an open-addressed, lock-free hashmap per
// cascade, the indirection table the map points into, and the slot lifecycle
// that keeps a surviving probe's index STABLE across frames.
//
// `srcRef.js`'s `SrcProbeMap` is the mirror. It is a compare-and-set in a JS
// loop, which has the same observable semantics as what runs here — first
// writer wins, every later writer finds its own key and gets the existing slot
// — and `scripts/gi-src-probes.html` diffs the two on the same key set,
// including a deliberate collision storm.
//
// ══ WHY CAS IS A wgslFn ISLAND AND NOT TSL ═════════════════════════════════
//
// TSL has no `atomicCompareExchangeWeak`. three r185 exposes load/store/add/
// sub/max/min/and/or/xor and stops there (AtomicFunctionNode's method table),
// and the insert is not expressible with any of them: `atomicMax` on the key
// would make the LARGEST key win a contended slot rather than the first, which
// is not a hashmap, and a load-then-store loop has a window where two probes
// claim one slot. So the insert is raw WGSL, on the vehicle `bvhGpu.js` and
// `dynamicObjects.js` already prove out (a `ptr<storage, …, read_write>`
// parameter that three's FunctionCallNode passes as `&buffer`).
//
// The hash function is NOT in the island. It is computed in TSL by
// `srcMathTsl.hashKey` and passed IN, because a second WGSL copy of the mix
// would be a second definition of the thing the twin gate exists to keep
// single — and a hash that disagrees with the mirror by one bit makes every
// probe-count comparison meaningless while looking perfectly healthy.
//
// ══ WHAT "WEAK" MEANS AND WHY THE LOOP IS SHAPED LIKE THIS ═════════════════
//
// `atomicCompareExchangeWeak` may fail SPURIOUSLY: it can report
// `exchanged == false` with `old_value == expected`. Advancing the probe
// sequence on that would scatter one key across several slots under
// contention, and the map would then hold duplicate entries for one probe —
// two indirection slots, two payloads, half the rays each. The loop therefore
// distinguishes the three outcomes explicitly and RETRIES THE SAME SLOT when
// the old value came back EMPTY.
//
// ══ THE SLOT LIFECYCLE, AND WHY THERE IS A FREE STACK ══════════════════════
//
// A surviving probe must keep the SAME indirection index frame to frame or its
// temporal history is meaningless (R6: an EMA smooths values, not membership).
// Two designs get there. Compacting the table each frame and copying payload
// is the obvious one and it is wrong — the payload is the expensive part and
// it would move every frame. So indices never move: the table is a fixed
// array, dead entries are pushed onto a free stack by the age pass, and new
// probes pop from it. A surviving probe is not touched at all, which is also
// why [K] costs nothing for the steady-state majority.
//
// ══ AND THE SAME LIFECYCLE CARRIES A SECOND RESOURCE ═══════════════════════
//
// Direction bins are the expensive per-probe payload — 32 bins at c0 rising to
// 2,048 at c3, nine words each — and they used to be addressed by probe SLOT,
// i.e. allocated for a capacity nothing ever fills. §12.16's gate measured
// **0.24% of allocated bins ever sampled**, and at a half-res 1080p gbuffer the
// scheme wanted 604 MB against a 128 MiB binding limit.
//
// So a probe CLAIMS a bin block when it is created and RELEASES it when it
// retires — the same stack, the same two passes, one more pop and one more
// push. `PROBE_BLOCK` holds the claim. The store owns the pool rather than
// `srcDeposit.js` for one concrete reason: `createCompactPass` already binds
// six storage buffers against a portable limit of eight, and a separate pair
// of pool buffers would have left the pass that creates every probe with no
// headroom at all. Plan §4.2, §12.18.3.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1, §4.2, §7 Phase 1.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  uint,
  wgslFn,
} from "three/tsl";
import { BIN_BUDGET, CASCADE_COUNT, MAX_LODS, PROBE_MAX_AGE, W0, blockCapacities } from "./srcConfig.js";
import { KEY_EMPTY } from "./srcMath.js";
import {
  cellPosition,
  chebyshev,
  hashKey,
  keyCell,
  keyLod,
  keySecondary,
  latticeOrigin,
  lodAtDistance,
  nearestCell,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";

/**
 * "Nothing here" — no probe behind this hash slot, no hash slot for this key,
 * no parent for this probe. Not a valid index, and deliberately not 0.
 *
 * EVERY absence in this file is this u32 value and never `-1`. WGSL cannot
 * const-convert a negative literal to u32 (`u32(-1)` is a compile error, and it
 * takes the WHOLE shader module with it), so a signed sentinel forces a
 * `select` at every store and an `int`/`uint` pair at every buffer. One
 * unsigned sentinel end to end costs nothing and cannot be spelled wrong.
 */
export const SLOT_EMPTY = 0xffffffff;

/**
 * Linear-probe budget per insert.
 *
 * At the ≤0.5 load factor the capacities below enforce, the expected probe
 * length is under 2 and the 99.9th percentile is around 12 — but a map that
 * has been driven past its load factor degrades to a linear scan, and a scan
 * of a 128k-entry map per thread is a hung frame, not a slow one. Capping it
 * turns "the GPU stopped responding" into a counted `insertFailures`, which is
 * a number the telemetry can show and a human can act on.
 */
export const MAX_PROBE_STEPS = 64;

/** Per-probe indirection record. */
export const PROBE_WORDS = 8;
export const PROBE_KEY = 0;      // the packed key this entry answers to
export const PROBE_AGE = 1;      // frames since last seen; > PROBE_MAX_AGE retires it
export const PROBE_FLAGS = 2;    // bit0 alive, bit1 fresh (see below)
/**
 * The parent cascade's probe INDEX, or SLOT_EMPTY.
 *
 * Between the ladder's insert and its resolve this word transiently holds the
 * parent's HASH SLOT instead, because the index does not exist until compaction
 * has run and giving the handoff its own word would cost 4 bytes per probe
 * across every cascade to carry a value that lives for two dispatches. Nothing
 * reads it in that window; if anything ever needs to, it gets its own word
 * rather than a rule about when this one is trustworthy.
 */
export const PROBE_PARENT = 3;
export const PROBE_HASH = 4;     // the hash slot holding this key, for [K]
export const PROBE_RAYS = 5;     // Alg. 3 ray count   (Phase 2)
export const PROBE_RAYOFF = 6;   // Alg. 3 ray offset  (Phase 2)
/**
 * The BIN BLOCK this probe claimed, LOCAL to its cascade, or `SLOT_EMPTY`.
 *
 * Phase 1 reserved this word as "irradiance tile slot (Phase 3)"; this is that
 * word being spent. One claim per probe covers both — the bins now and [H]'s
 * octahedral tile later — because they have the same owner and the same
 * lifetime, so a second pool would be a second thing to leak.
 *
 * `SLOT_EMPTY`, never 0: a probe that fails to claim has NO bins, and index 0
 * is a block some other probe owns. Same rule as every other absence here.
 */
export const PROBE_BLOCK = 7;

export const FLAG_ALIVE = 1;
export const FLAG_FRESH = 2;

/** Per-cascade counter block. 8 words, four spare — a counter is one atomic. */
export const COUNTER_WORDS = 8;
export const COUNTER_LIVE = 0;      // probes currently in the indirection table
export const COUNTER_FAILED = 1;    // inserts that exhausted MAX_PROBE_STEPS
export const COUNTER_STEPS = 2;     // total linear-probe steps this frame
export const COUNTER_FRESH = 3;     // probes created this frame
/**
 * Insert ATTEMPTS this frame — the denominator of the load instrument, and the
 * reason it is a separate counter rather than reusing `COUNTER_LIVE`.
 *
 * Dividing steps by the live probe count is the obvious thing and it is wrong
 * by the ratio of pixels to probes: 4096 contended inserts onto 400 probes
 * reported 10.66 "mean probe steps" on a map whose real mean was 1.04, i.e. a
 * healthy hash looked ten times over budget. An instrument that cries wolf at
 * rest is worse than no instrument — somebody eventually tunes against it.
 */
export const COUNTER_ATTEMPTS = 4;
/**
 * Probes created this frame that could NOT claim a bin block.
 *
 * Its own counter rather than a fold into `COUNTER_FAILED`, because the two
 * failures have opposite fixes: a failed INSERT means the hash is too small or
 * too loaded, a failed CLAIM means `BIN_BUDGET` is too small for the scene. A
 * probe that fails to claim is alive, keyed, resolvable and RAY-BUDGETED — it
 * simply has nowhere to deposit, so it contributes an absence rather than dark
 * (R1). Nonzero here is the one signal that says so before anyone tries to read
 * it off the screen.
 */
export const COUNTER_NOBLOCK = 5;

// ═════════════════════════════════════════════════════════ THE WGSL ISLAND

/**
 * Find-or-create. Returns `vec2i(hashSlot, steps)`, with `hashSlot < 0` when
 * the probe budget was exhausted.
 *
 * `h0` is `srcMathTsl.hashKey(key)` computed by the caller — see the header for
 * why the mix does not live in here.
 */
const hashInsertWgsl = wgslFn(/* wgsl */ `

	fn srcHashInsert(
		key: u32, h0: u32, base: u32, capacity: u32, maxSteps: u32,
		keys: ptr<storage, array<atomic<u32>>, read_write>
	) -> vec2<i32> {

		if (key == 0u) { return vec2<i32>(-1, 0); }

		let mask = capacity - 1u;
		var slot: u32 = h0 & mask;
		var steps: u32 = 0u;

		loop {
			if (steps >= maxSteps) { break; }
			steps = steps + 1u;

			let res = atomicCompareExchangeWeak(&keys[base + slot], 0u, key);

			// We claimed an empty slot.
			if (res.exchanged) { return vec2<i32>(i32(slot), i32(steps)); }
			// Somebody already put OUR key here — that is a hit, not a collision.
			if (res.old_value == key) { return vec2<i32>(i32(slot), i32(steps)); }
			// SPURIOUS WEAK FAILURE: the slot is still empty and the exchange
			// simply did not happen. Advancing here would scatter one key over
			// several slots and give one probe two indirection entries.
			if (res.old_value == 0u) { continue; }

			slot = (slot + 1u) & mask;
		}

		return vec2<i32>(-1, i32(steps));
	}

`);

/**
 * Lookup only — no insert. Returns `vec2i(hashSlot, steps)`, `hashSlot < 0`
 * when absent.
 *
 * Stops at the first EMPTY slot, which is correct ONLY because this map has no
 * deletion path: entries are never tombstoned mid-frame, the whole table is
 * cleared and rebuilt instead. A future deletion would break this scan and
 * nothing would say so, which is why the clear-and-rebuild is a design rule
 * and not an implementation detail.
 */
const hashFindWgsl = wgslFn(/* wgsl */ `

	fn srcHashFind(
		key: u32, h0: u32, base: u32, capacity: u32, maxSteps: u32,
		keys: ptr<storage, array<atomic<u32>>, read_write>
	) -> vec2<i32> {

		if (key == 0u) { return vec2<i32>(-1, 0); }

		let mask = capacity - 1u;
		var slot: u32 = h0 & mask;
		var steps: u32 = 0u;

		loop {
			if (steps >= maxSteps) { break; }
			steps = steps + 1u;

			let cur = atomicLoad(&keys[base + slot]);
			if (cur == key) { return vec2<i32>(i32(slot), i32(steps)); }
			if (cur == 0u) { return vec2<i32>(-1, i32(steps)); }

			slot = (slot + 1u) & mask;
		}

		return vec2<i32>(-1, i32(steps));
	}

`);

// ══════════════════════════════════════════════════════════════ THE STORE

/**
 * Round up to a power of two — the hash capacity must be one so the slot mask
 * is a bitwise AND rather than a modulo (a `%` in the probe loop is a division
 * per step on hardware that does not have one).
 */
function pow2(n) {
  let v = 16;
  while (v < n) v *= 2;
  return v;
}

/**
 * Allocate the probe store.
 *
 * @param {object} options
 * @param {number} options.c0Probes  expected live probes at cascade 0. Higher
 *   cascades are sized from it: spacing doubles per cascade, so on a 2D surface
 *   manifold the probe count falls ~4× (plan §4.2). The floor keeps the small
 *   cascades from being pathologically tight on a tiny scene.
 * @param {number} options.cascadeCount
 * @param {number} options.loadFactor  probes ÷ hash capacity. 0.5 by default —
 *   open addressing with linear probing degrades sharply above ~0.7, and the
 *   memory this buys back is one u32 per slot.
 * @param {number} options.w0  c0 bin grid width — the block pool's sizing needs
 *   it, because a block IS `binCount(cascade, w0)` accumulators.
 * @param {number} options.binBudget  total bins the block pool may hold. See
 *   `srcConfig.BIN_BUDGET`; the bytes live in `createSrcBinStore`.
 */
export function createSrcProbeStore({
  c0Probes = 65536,
  cascadeCount = CASCADE_COUNT,
  loadFactor = 0.5,
  w0 = W0,
  binBudget = BIN_BUDGET,
} = {}) {
  const cascades = [];
  let hashTotal = 0;
  let probeTotal = 0;
  for (let c = 0; c < cascadeCount; c++) {
    const probes = Math.max(1024, pow2(Math.ceil(c0Probes / Math.pow(4, c))));
    const capacity = pow2(Math.ceil(probes / loadFactor));
    cascades.push({
      cascade: c,
      probeCapacity: probes,
      hashCapacity: capacity,
      hashBase: hashTotal,
      probeBase: probeTotal,
    });
    hashTotal += capacity;
    probeTotal += probes;
  }

  // ── THE SECOND RESOURCE WITH THE SAME LIFETIME ────────────────────────────
  // A bin block is claimed and released exactly where a probe index is, so it
  // rides the SAME free stack rather than getting its own pair of buffers. That
  // is not tidiness: `createCompactPass` already binds six storage buffers and
  // the portable limit is EIGHT per stage, so two more would have put the pass
  // that creates every probe exactly at the ceiling with nothing left for the
  // merge. One buffer, two regions.
  const blockCaps = blockCapacities(cascades.map((c) => c.probeCapacity), w0, binBudget);
  let blockTotal = 0;
  for (const c of cascades) {
    c.blockCapacity = blockCaps[c.cascade];
    c.blockBase = blockTotal;          // into the BLOCK index space, per cascade
    blockTotal += c.blockCapacity;
  }

  // ── ONE buffer per role, all cascades at fixed offsets (R7) ───────────────
  // The alternative — a buffer per cascade — is four times the bindings for
  // the same bytes, and the composed kernels in this module have died on the
  // portable 8-storage-buffer limit often enough that AGENTS.md leads with it.
  // ALWAYS atomic, including where a plain read would do. Aliasing one buffer
  // behind an atomic node and a non-atomic node would save an `atomicLoad` in
  // the compaction pass and cost a second definition of what the buffer IS;
  // `atomicLoad` on a u32 is free on every target we ship to.
  const hashKeys = instancedArray(new Uint32Array(hashTotal), "uint").toAtomic();
  const hashSlot = instancedArray(new Uint32Array(hashTotal).fill(SLOT_EMPTY), "uint");
  const tableInit = new Uint32Array(probeTotal * PROBE_WORDS);
  // A slot no probe has ever occupied must read "no block", not "block 0" —
  // zero-fill would make every unborn probe look like the owner of block 0.
  // Nothing reads a dead probe's word today (the chain and the pixel map are
  // both resolved this frame), so this is the rule holding rather than a bug
  // being fixed, and it costs one pass over a buffer built once.
  for (let p = 0; p < probeTotal; p++) tableInit[p * PROBE_WORDS + PROBE_BLOCK] = SLOT_EMPTY;
  const probeTable = instancedArray(tableInit, "uint");
  const counters = instancedArray(new Uint32Array(cascadeCount * COUNTER_WORDS), "uint").toAtomic();

  // ── the free stacks, seeded FULL and in reverse ───────────────────────────
  // Reverse so the first pops are indices 0, 1, 2… on a cold boot. That is
  // cosmetic for correctness and load-bearing for debugging: a fresh frame's
  // probe 0 is at table entry 0, so a readback is readable by eye instead of
  // being a permutation nobody can check.
  //
  // Two regions in one array: probe indices first (GLOBAL, because a probe
  // index is global everywhere it appears), then block indices (LOCAL to their
  // cascade, because a block index is only ever used to address that cascade's
  // bin region and a local one keeps the addressing a single multiply).
  const freeInit = new Uint32Array(probeTotal + blockTotal);
  for (const c of cascades) {
    for (let i = 0; i < c.probeCapacity; i++) {
      freeInit[c.probeBase + i] = c.probeBase + (c.probeCapacity - 1 - i);
    }
    for (let i = 0; i < c.blockCapacity; i++) {
      freeInit[probeTotal + c.blockBase + i] = c.blockCapacity - 1 - i;
    }
  }
  const freeStack = instancedArray(freeInit, "uint");
  // Top-of-stack per cascade, atomic: `atomicSub` pops, `atomicAdd` pushes.
  // Probe tops in `[0, cascadeCount)`, block tops in `[cascadeCount, 2N)`.
  const freeTopInit = new Uint32Array(cascadeCount * 2);
  for (const c of cascades) {
    freeTopInit[c.cascade] = c.probeCapacity;
    freeTopInit[cascadeCount + c.cascade] = c.blockCapacity;
  }
  const freeTop = instancedArray(freeTopInit, "uint").toAtomic();

  const store = {
    cascadeCount,
    cascades,
    hashTotal,
    probeTotal,
    blockTotal,
    /** Where the block region starts inside `freeStack`. */
    blockStackBase: probeTotal,
    hashKeys,
    hashSlot,
    probeTable,
    counters,
    freeStack,
    freeTop,
    /** Bytes on the GPU, for the memory high-water telemetry (plan §8). */
    bytes: (hashTotal * 2 + probeTotal * PROBE_WORDS + probeTotal + blockTotal
      + cascadeCount * (COUNTER_WORDS + 2)) * 4,
    dispose() {
      for (const b of [hashKeys, hashSlot, probeTable, counters, freeStack, freeTop]) {
        b?.value?.dispose?.();
      }
    },
  };
  return store;
}

// ═══════════════════════════════════════════════════════════ THE PASSES
//
// Each returns a compute node. They are separate dispatches rather than one
// fused kernel because every boundary between them is a REAL barrier — the
// clear must complete before any insert reads a slot, and every insert must
// complete before compaction decides which slots hold keys. WebGPU has no
// device-wide barrier inside a dispatch, so "fusing for speed" here does not
// produce a faster kernel, it produces a race.

/**
 * [K], first half — reset the hash table.
 *
 * The indirection table is deliberately NOT cleared: it is the thing that
 * survives, and its entries are re-inserted by `agePass` below.
 */
export function createHashClearPass(store) {
  const { hashKeys, hashSlot, counters, hashTotal, cascadeCount } = store;
  return Fn(() => {
    const i = instanceIndex.toVar();
    atomicStore(hashKeys.element(i), uint(KEY_EMPTY));
    hashSlot.element(i).assign(uint(SLOT_EMPTY));
    // Fold the per-frame counter reset into the same dispatch — the counters
    // are a few words and a separate dispatch for them is pure launch cost.
    // `COUNTER_LIVE` is NOT reset: it tracks the table, which persists.
    If(i.lessThan(uint(cascadeCount)), () => {
      const base = i.mul(COUNTER_WORDS);
      atomicStore(counters.element(base.add(COUNTER_FAILED)), uint(0));
      atomicStore(counters.element(base.add(COUNTER_STEPS)), uint(0));
      atomicStore(counters.element(base.add(COUNTER_FRESH)), uint(0));
      atomicStore(counters.element(base.add(COUNTER_ATTEMPTS)), uint(0));
      atomicStore(counters.element(base.add(COUNTER_NOBLOCK)), uint(0));
    });
  })().compute(hashTotal);
}

/**
 * [K], second half — age every live probe, retire the stale ones, and put the
 * survivors back in the freshly cleared hash with THE INDEX THEY ALREADY HAVE.
 *
 * Retirement is the cheap half of the whole scheme: a probe nobody looked at
 * for `PROBE_MAX_AGE` frames simply stops being re-inserted, its entry goes on
 * the free stack, and no deletion path is ever exercised. There is no code here
 * that removes a key from the map, which is exactly what makes `srcHashFind`'s
 * stop-at-EMPTY scan sound.
 *
 * The `fresh` flag is cleared here rather than at creation, so it means "born
 * within the last frame" at every reader — R6 wants the fast-α warmup to last a
 * bounded number of frames, and a flag that is set at birth and never cleared
 * would make every probe permanently fresh.
 */
export function createAgePass(store, cascade, { maxAge = PROBE_MAX_AGE } = {}) {
  const c = store.cascades[cascade];
  const { hashKeys, hashSlot, probeTable, counters, freeStack, freeTop, cascadeCount } = store;
  // Where this cascade's block region starts inside the shared stack, and which
  // top word owns it. Both are JS constants folded into the shader.
  const blockStack = store.blockStackBase + c.blockBase;
  const blockTopWord = cascadeCount + cascade;
  return Fn(() => {
    const p = instanceIndex.add(uint(c.probeBase)).toVar();
    const w = p.mul(PROBE_WORDS).toVar();
    const flags = probeTable.element(w.add(PROBE_FLAGS)).toVar();
    If(flags.bitAnd(uint(FLAG_ALIVE)).equal(uint(0)), () => {
      // Not live — nothing to age and nothing to free (it is already on the
      // stack). `Return()`, the TSL statement, NOT a JS `return`: a bare JS
      // return from an `If` body just ends the builder callback and emits an
      // EMPTY branch, so the code below would run for dead entries too. It
      // compiles, it validates, and it double-frees every dead slot.
      Return();
    });

    const age = probeTable.element(w.add(PROBE_AGE)).add(1).toVar();
    const key = probeTable.element(w.add(PROBE_KEY)).toVar();

    If(age.greaterThan(uint(maxAge)), () => {
      probeTable.element(w.add(PROBE_FLAGS)).assign(uint(0));
      probeTable.element(w.add(PROBE_AGE)).assign(uint(0));
      // ── RELEASE THE BIN BLOCK ──────────────────────────────────────────
      // Here rather than in a sweep of its own, for the same reason the index
      // is released here: this is the one thread that knows this probe just
      // died, and the compaction pass three dispatches later is what will hand
      // the block to whoever is born next. A block released in this frame is
      // claimable in this frame — the barrier between the two passes is what
      // makes that legal, and it is why a burst of retirement does not cost a
      // frame of darkness.
      const block = probeTable.element(w.add(PROBE_BLOCK)).toVar();
      If(block.notEqual(uint(SLOT_EMPTY)), () => {
        const btop = atomicAdd(freeTop.element(uint(blockTopWord)), uint(1)).toVar();
        freeStack.element(uint(blockStack).add(btop)).assign(block);
        probeTable.element(w.add(PROBE_BLOCK)).assign(uint(SLOT_EMPTY));
      });
      // Push. `atomicAdd` returns the OLD top, which is the index to write.
      const top = atomicAdd(freeTop.element(uint(cascade)), uint(1)).toVar();
      freeStack.element(uint(c.probeBase).add(top)).assign(p);
      atomicSub(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_LIVE)), uint(1));
    }).Else(() => {
      probeTable.element(w.add(PROBE_AGE)).assign(age);
      // No longer newborn. Set BEFORE the re-insert so a consumer that reads
      // the flag through the hash this frame sees the settled value.
      probeTable.element(w.add(PROBE_FLAGS)).assign(flags.bitAnd(uint(~FLAG_FRESH >>> 0)));
      const r = hashInsertWgsl(
        key, hashKey(key), uint(c.hashBase), uint(c.hashCapacity),
        uint(MAX_PROBE_STEPS), hashKeys,
      ).toVar();
      atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_STEPS)), uint(r.y));
      If(r.x.lessThan(0), () => {
        // The table cannot fail to hold what it already held — unless capacity
        // was lowered under it, which is a rebuild, not a frame. Counted rather
        // than ignored so that impossible stays visible.
        atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_FAILED)), uint(1));
      }).Else(() => {
        const h = uint(c.hashBase).add(uint(r.x)).toVar();
        hashSlot.element(h).assign(p);
        probeTable.element(w.add(PROBE_HASH)).assign(h);
      });
    });
  })().compute(c.probeCapacity);
}

/**
 * [B] — insert `count` keys produced by `keyOf(index)`.
 *
 * `keyOf` is a closure returning a packed-key node, so the same pass serves the
 * pixel scatter (key from the gbuffer) and the cascade ladder (key from the
 * child probe's own cell) without either knowing about the other. `onSlot(i,
 * hashSlotNode)` receives the absolute hash slot as a UINT — `SLOT_EMPTY` when
 * there was no key or the insert failed — so the caller can remember where its
 * key landed. The PROBE INDEX is not known yet and asking for it here is the
 * race this two-pass split exists to avoid: the thread that loses the CAS would
 * have to spin until the winner allocated.
 */
export function createInsertPass(store, cascade, count, keyOf, onSlot = null) {
  const c = store.cascades[cascade];
  const { hashKeys, counters } = store;
  return Fn(() => {
    const i = instanceIndex.toVar();
    const key = uint(keyOf(i)).toVar();
    If(key.equal(uint(KEY_EMPTY)), () => {
      // An unrepresentable cell, an invalid gbuffer pixel, or a dead child.
      // `packProbeKey` returns EMPTY for all three by design; inserting it
      // would claim the sentinel and make the whole map look full.
      if (onSlot) onSlot(i, uint(SLOT_EMPTY));
      Return();
    });
    const r = hashInsertWgsl(
      key, hashKey(key), uint(c.hashBase), uint(c.hashCapacity),
      uint(MAX_PROBE_STEPS), hashKeys,
    ).toVar();
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_STEPS)), uint(r.y));
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_ATTEMPTS)), uint(1));
    If(r.x.lessThan(0), () => {
      atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_FAILED)), uint(1));
      if (onSlot) onSlot(i, uint(SLOT_EMPTY));
    }).Else(() => {
      if (onSlot) onSlot(i, uint(c.hashBase).add(uint(r.x)));
    });
  })().compute(count);
}

/**
 * [C] — compaction: every hash slot holding a key with no probe behind it pops
 * a free index and initializes the record.
 *
 * One thread per HASH slot, not per key, because the set of keys is exactly
 * what this pass is discovering. At a 0.5 load factor half the threads exit on
 * the first read, which is cheaper than any scheme that would first have to
 * build the list of occupied slots.
 *
 * A probe that fails to allocate — the free stack is empty, i.e. the
 * indirection table is full — leaves `hashSlot` at SLOT_EMPTY. Downstream that
 * is "no probe here", which is the same state as a cell nobody inserted, and
 * every consumer already renormalizes around it (R1: a missing probe is an
 * absence of information, never a dark vote). The alternative, clamping to
 * index 0, would silently pour every overflowing probe's rays into one record.
 */
export function createCompactPass(store, cascade) {
  const c = store.cascades[cascade];
  const { hashKeys, hashSlot, probeTable, counters, freeStack, freeTop, cascadeCount } = store;
  const blockStack = store.blockStackBase + c.blockBase;
  const blockTopWord = cascadeCount + cascade;
  return Fn(() => {
    const h = instanceIndex.add(uint(c.hashBase)).toVar();
    const key = atomicLoad(hashKeys.element(h)).toVar();
    If(key.equal(uint(KEY_EMPTY)), () => {
      Return();
    });
    If(hashSlot.element(h).notEqual(uint(SLOT_EMPTY)), () => {
      // A survivor re-inserted by the age pass — it already owns its index.
      Return();
    });

    // POP. `atomicSub` returns the OLD top; a top of 0 means the stack was
    // empty and this thread must UNDO its decrement, or a long-running frame
    // walks the counter down through zero and wraps to 4 billion, at which
    // point every subsequent pop reads garbage out of the stack array.
    const top = atomicSub(freeTop.element(uint(cascade)), uint(1)).toVar();
    If(top.equal(uint(0)).or(top.greaterThan(uint(c.probeCapacity))), () => {
      atomicAdd(freeTop.element(uint(cascade)), uint(1));
      atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_FAILED)), uint(1));
      Return();
    });

    const p = freeStack.element(uint(c.probeBase).add(top).sub(1)).toVar();
    const w = p.mul(PROBE_WORDS).toVar();

    // ── CLAIM A BIN BLOCK, IN THE SAME THREAD AND THE SAME PASS ────────────
    //
    // A second pop off the same stack machinery, on the one thread that knows
    // a probe has just come into existence. No new dispatch, no reverse map,
    // and no window in which a probe is alive without having tried.
    //
    // A FAILED CLAIM IS `SLOT_EMPTY`, NEVER BLOCK 0. Clamping to zero would
    // pour every overflowing probe's rays into one block — the same mistake
    // the index pop above refuses to make, and worse here, because the bins it
    // corrupted would belong to a probe that is working correctly. Downstream
    // an empty block means "no bins": the deposit drops (and counts) its
    // scatter, and the gather returns UNKNOWN, which is R1's absence rather
    // than a dark vote.
    const btop = atomicSub(freeTop.element(uint(blockTopWord)), uint(1)).toVar();
    const block = uint(SLOT_EMPTY).toVar();
    If(btop.equal(uint(0)).or(btop.greaterThan(uint(c.blockCapacity))), () => {
      // Same undo as the index pop: a top walked down through zero wraps to
      // four billion and every later pop reads garbage out of the array.
      atomicAdd(freeTop.element(uint(blockTopWord)), uint(1));
      atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_NOBLOCK)), uint(1));
    }).Else(() => {
      block.assign(freeStack.element(uint(blockStack).add(btop).sub(1)));
    });

    probeTable.element(w.add(PROBE_KEY)).assign(key);
    probeTable.element(w.add(PROBE_AGE)).assign(uint(0));
    probeTable.element(w.add(PROBE_FLAGS)).assign(uint(FLAG_ALIVE | FLAG_FRESH));
    probeTable.element(w.add(PROBE_PARENT)).assign(uint(SLOT_EMPTY));
    probeTable.element(w.add(PROBE_HASH)).assign(h);
    probeTable.element(w.add(PROBE_RAYS)).assign(uint(0));
    probeTable.element(w.add(PROBE_RAYOFF)).assign(uint(0));
    probeTable.element(w.add(PROBE_BLOCK)).assign(block);
    hashSlot.element(h).assign(p);
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_LIVE)), uint(1));
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_FRESH)), uint(1));
  })().compute(c.hashCapacity);
}

/**
 * Resolve a remembered hash slot to a probe index. Runs after `[C]`, and it is
 * the reason `[B]` hands its caller a hash slot instead of an index.
 *
 * `slotOf(i)` returns the absolute hash slot as a UINT (`SLOT_EMPTY` for none),
 * `write(i, indexNode)` stores the result. `SLOT_EMPTY` out means the key never
 * got a probe — the caller must treat that as "no probe", not as index 0.
 *
 * ══ THIS PASS IS ALSO WHAT MAKES A PROBE "SEEN" ═══════════════════════════
 *
 * `age` means FRAMES SINCE LAST SEEN, and resolving is the only moment in the
 * pipeline that means "a consumer is using this probe right now". Inserting
 * does not: a key CAS'd into a slot the age pass already re-populated finds the
 * entry present and touches nothing, so a probe that is looked up every single
 * frame still ages.
 *
 * That was not a hypothesis. Without this write, `createAgePass` retired every
 * live probe on the frame its age crossed the threshold and the compaction pass
 * immediately re-created it from the key still sitting in the hash — same
 * probe, NEW index, every `maxAge` frames, forever. The gate's storm and
 * stability arms both passed; only "survivors still hold their original indices
 * after the sweep" caught it, and in Phase 4 the symptom would have been the
 * whole frame's temporal history resetting on a beat.
 *
 * Threads racing to write 0 into one word all write the same value, so no
 * atomic is needed. Pass `touch: false` for a lookup that must NOT keep a probe
 * alive — a debug readback, say, which should show the retirement it is there
 * to observe rather than preventing it.
 */
export function createResolvePass(store, count, slotOf, write, { touch = true } = {}) {
  const { hashSlot, probeTable } = store;
  return Fn(() => {
    const i = instanceIndex.toVar();
    const h = uint(slotOf(i)).toVar();
    If(h.equal(uint(SLOT_EMPTY)), () => {
      write(i, uint(SLOT_EMPTY));
    }).Else(() => {
      const p = hashSlot.element(h).toVar();
      write(i, p);
      if (touch) {
        If(p.notEqual(uint(SLOT_EMPTY)), () => {
          probeTable.element(p.mul(PROBE_WORDS).add(PROBE_AGE)).assign(uint(0));
        });
      }
    });
  })().compute(count);
}

/**
 * Find an existing key without inserting — the merge's parent lookup and the
 * screen gather's corner lookup, both of which must NOT create probes.
 *
 * Returns a probe index node, `SLOT_EMPTY` when absent. Exposed as a closure
 * rather than a pass because its callers are inside other kernels.
 */
export function createProbeLookup(store, cascade) {
  const c = store.cascades[cascade];
  const { hashKeys, hashSlot } = store;
  return (key) => {
    const k = uint(key).toVar();
    const r = hashFindWgsl(
      k, hashKey(k), uint(c.hashBase), uint(c.hashCapacity),
      uint(MAX_PROBE_STEPS), hashKeys,
    ).toVar();
    const out = uint(SLOT_EMPTY).toVar();
    If(r.x.greaterThanEqual(0), () => {
      out.assign(hashSlot.element(uint(c.hashBase).add(uint(r.x))));
    });
    return out;
  };
}

// ══════════════════════════════════════════════════════════ THE FRAME
//
// Steps [B] + [C] + [K] assembled: the hash resets, survivors re-enter it with
// the indices they already have, every gbuffer pixel inserts its nearest c0
// cell, and then the ladder walks up — each c(i−1) probe inserting its nearest
// c(i) probe and keeping the link.
//
// ══ ONE PROBE PER PIXEL, NOT EIGHT ═════════════════════════════════════════
//
// A pixel inserts the NEAREST cell only, deliberately not the eight trilinear
// corners it will later interpolate over. The authors measured corner insertion
// as 2× the probes for little quality gain, and the renormalized sparse gather
// is what makes the missing corners harmless (srcMath's `sparseGather`). If a
// later phase reports interpolation holes, the fix is the gather's
// renormalization, not inserting more probes here.
//
// ══ THE LINK IS THREE THINGS AT ONCE ═══════════════════════════════════════
//
// `PROBE_PARENT` is the merge's parent pointer, Alg. 3's count-propagation
// edge, and the ancestor chain a split deposit walks. That is why it is
// resolved once here, at population time, rather than re-derived per ray: the
// deposit path in Phase 2 is the hottest loop in the module and a hash lookup
// per ray per cascade would be four lookups per ray.

/**
 * Assemble one frame of probe population.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} options
 * @param {Node|number} options.spacing0  s₀, the one spatial dial
 * @param {Node} options.camera  world camera position — the LOD metric's centre
 * @param {Node} options.anchor  the lattice origin, camera-quantized and
 *   re-quantized only on large moves. NOT the camera: re-anchoring every frame
 *   re-keys every probe, which is a per-frame full retirement, i.e. exactly the
 *   binary flip R1 forbids.
 * @param {number} options.pixelCount
 * @param {(i: Node) => {position: Node, valid: Node}} options.readPixel
 *   the gbuffer, as a closure. Production samples the half-res worldPos target;
 *   the gate reads a storage buffer. Neither knows about the other.
 */
export function createSrcProbeFrame(store, {
  spacing0,
  camera,
  anchor,
  pixelCount,
  readPixel,
  maxLods = MAX_LODS,
  maxAge = PROBE_MAX_AGE,
} = {}) {
  const { probeTable } = store;
  const N = store.cascadeCount;

  // Where each pixel's key landed in the hash, remembered across the [B]→[C]
  // barrier. `SLOT_EMPTY`, not −1, for a pixel with no key.
  const pixelHash = instancedArray(new Uint32Array(pixelCount).fill(SLOT_EMPTY), "uint");
  /** Per-pixel c0 probe index, or SLOT_EMPTY. The output every later phase reads. */
  const pixelProbe = instancedArray(new Uint32Array(pixelCount).fill(SLOT_EMPTY), "uint");

  /** LOD, spacing and lattice origin for a world point — [B]'s whole geometry. */
  const latticeAt = (position, cascade) => {
    const cheb = chebyshev(position, camera).toVar();
    // FLOOR of the fractional LOD picks the shell; the fraction is the ×0.9
    // overlap blend and belongs to the gather, not here. A point within ~1e-6
    // of a boundary may floor either way — see srcMathTsl's trap 3, and the
    // population gate counts those rather than failing on them.
    const lod = floor(lodAtDistance(cheb, spacing0, maxLods)).toVar();
    const s = probeSpacing(cascade, lod, spacing0).toVar();
    return { lod, spacing: s, origin: latticeOrigin(anchor, s).toVar() };
  };

  const passes = [];
  passes.push(createHashClearPass(store));
  for (let c = 0; c < N; c++) passes.push(createAgePass(store, c, { maxAge }));

  // ── [B] cascade 0, from the gbuffer ───────────────────────────────────────
  passes.push(createInsertPass(
    store, 0, pixelCount,
    (i) => {
      const px = readPixel(i);
      const key = uint(KEY_EMPTY).toVar();
      If(px.valid, () => {
        const L = latticeAt(px.position, 0);
        const cell = nearestCell(px.position, L.origin, L.spacing).toVar();
        // `secondary` is 0: the multibounce cache inserts into the same maps
        // under the key's secondary bit, and it is Phase 5's caller, not this
        // one's parameter — a flag here would be a knob nothing sets.
        key.assign(packProbeKey(int(L.lod), uint(0), cell));
      });
      return key;
    },
    (i, slot) => { pixelHash.element(i).assign(uint(slot)); },
  ));
  passes.push(createCompactPass(store, 0));
  passes.push(createResolvePass(
    store, pixelCount,
    (i) => pixelHash.element(i),
    (i, probe) => { pixelProbe.element(i).assign(uint(probe)); },
  ));

  // ── the ladder ────────────────────────────────────────────────────────────
  for (let c = 1; c < N; c++) {
    const child = store.cascades[c - 1];
    // A child's world position comes from its OWN KEY, not from a stored
    // position: key → (lod, cell) → cell centre on the child lattice. Storing
    // the position instead would be three more words per probe and a second
    // source of truth that a re-anchor could desynchronize from the key.
    const childPosition = (i) => {
      const p = uint(child.probeBase).add(i).toVar();
      const w = p.mul(PROBE_WORDS).toVar();
      const key = probeTable.element(w.add(PROBE_KEY)).toVar();
      const alive = probeTable.element(w.add(PROBE_FLAGS)).bitAnd(uint(FLAG_ALIVE)).notEqual(uint(0));
      const lodI = keyLod(key).toVar();
      const lod = float(lodI).toVar();
      const s = probeSpacing(c - 1, lod, spacing0).toVar();
      const origin = latticeOrigin(anchor, s).toVar();
      return {
        probe: p,
        words: w,
        alive,
        lodI,
        lod,
        secondary: keySecondary(key),
        position: cellPosition(keyCell(key), origin, s).toVar(),
      };
    };

    passes.push(createInsertPass(
      store, c, child.probeCapacity,
      (i) => {
        const ch = childPosition(i);
        const key = uint(KEY_EMPTY).toVar();
        If(ch.alive, () => {
          // SAME LOD as the child. The cascade ladder climbs in cascade index,
          // never in LOD — those are orthogonal axes (spacing doubles with
          // both), and mixing them here would hand a probe a parent from a
          // different shell whose interval boundaries do not line up with its
          // own. §4.5: no cross-LOD interaction, anywhere.
          const s = probeSpacing(c, ch.lod, spacing0).toVar();
          const origin = latticeOrigin(anchor, s).toVar();
          key.assign(packProbeKey(ch.lodI, ch.secondary, nearestCell(ch.position, origin, s)));
        });
        return key;
      },
      (i, slot) => {
        probeTable.element(uint(child.probeBase).add(i).mul(PROBE_WORDS).add(PROBE_PARENT))
          .assign(uint(slot));
      },
    ));
    passes.push(createCompactPass(store, c));
    passes.push(createResolvePass(
      store, child.probeCapacity,
      (i) => probeTable.element(
        uint(child.probeBase).add(i).mul(PROBE_WORDS).add(PROBE_PARENT),
      ),
      (i, probe) => {
        probeTable.element(uint(child.probeBase).add(i).mul(PROBE_WORDS).add(PROBE_PARENT))
          .assign(uint(probe));
      },
    ));
  }

  return {
    pixelProbe,
    pixelHash,
    passes,
    /**
     * Dispatch the frame in order. The order IS the algorithm — every gap
     * between two passes is a barrier WebGPU can only express as a dispatch
     * boundary, so a caller that batches these into one `renderer.compute([…])`
     * call is relying on three preserving both the order and the implicit
     * barrier between them. It does; the array form exists for callers that
     * want to interleave GI's other queues, which GISystem does.
     */
    run(renderer, compute = (r, node) => r.compute(node)) {
      for (const pass of passes) compute(renderer, pass);
    },
    dispose() {
      pixelHash?.value?.dispose?.();
      pixelProbe?.value?.dispose?.();
    },
  };
}

// ═══════════════════════════════════════════════════════════ TELEMETRY
//
// Plan §8 ships this with Phase 1 and keeps it permanently: load factor, probe
// counts per cascade, insert failures and the mean probe-sequence length. It is
// four words per cascade read back off the GPU, and it is the difference
// between "GI looks dark over there" and "cascade 2 is at 0.94 load and
// dropping one insert in nine".

/** Read the counter block back. Async — call it off the hot path. */
export async function readSrcProbeStats(renderer, store) {
  const raw = new Uint32Array(await renderer.getArrayBufferAsync(store.counters.value));
  const out = [];
  for (const c of store.cascades) {
    const base = c.cascade * COUNTER_WORDS;
    const live = raw[base + COUNTER_LIVE] >>> 0;
    const steps = raw[base + COUNTER_STEPS] >>> 0;
    const fresh = raw[base + COUNTER_FRESH] >>> 0;
    const attempts = raw[base + COUNTER_ATTEMPTS] >>> 0;
    out.push({
      cascade: c.cascade,
      live,
      fresh,
      attempts,
      failed: raw[base + COUNTER_FAILED] >>> 0,
      noBlock: raw[base + COUNTER_NOBLOCK] >>> 0,
      probeCapacity: c.probeCapacity,
      hashCapacity: c.hashCapacity,
      blockCapacity: c.blockCapacity,
      loadFactor: live / c.hashCapacity,
      // Mean linear-probe length per INSERT ATTEMPT. 1.0 is a perfect hash;
      // past ~4 the map is saying its load factor is too high, and it says so
      // long before `failed` starts counting. Per attempt, not per probe — see
      // COUNTER_ATTEMPTS for the ten-fold lie the other denominator told.
      meanProbeSteps: attempts > 0 ? steps / attempts : 0,
    });
  }
  return out;
}

/** One line per cascade, for the debug panel and the harness log. */
export function formatSrcProbeStats(stats) {
  return stats
    .map((s) =>
      `c${s.cascade}: ${s.live}/${s.probeCapacity} probes (+${s.fresh} fresh) ` +
      `load ${s.loadFactor.toFixed(3)} steps ${s.meanProbeSteps.toFixed(2)}/${s.attempts}` +
      (s.failed ? ` FAILED ${s.failed}` : "") +
      // Printed only when it fires. A probe born without bins is invisible in
      // every other number here — it is live, keyed and ray-budgeted — so this
      // is the only place "the bin budget is too small for this scene" appears.
      (s.noBlock ? ` NOBLOCK ${s.noBlock}/${s.blockCapacity}` : ""))
    .join("  |  ");
}
