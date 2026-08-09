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
// docs/GI_SRC_REBUILD_PLAN.md §4.1, §4.2, §7 Phase 1.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  instanceIndex,
  instancedArray,
  int,
  uint,
  wgslFn,
} from "three/tsl";
import { CASCADE_COUNT, PROBE_MAX_AGE } from "./srcConfig.js";
import { KEY_EMPTY } from "./srcMath.js";
import { hashKey } from "./srcMathTsl.js";

/** No probe assigned to this hash slot yet. Not a valid index, and not 0. */
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
export const PROBE_PARENT = 3;   // parent cascade's probe index, or SLOT_EMPTY
export const PROBE_HASH = 4;     // the hash slot holding this key, for [K]
export const PROBE_RAYS = 5;     // Alg. 3 ray count   (Phase 2)
export const PROBE_RAYOFF = 6;   // Alg. 3 ray offset  (Phase 2)
export const PROBE_SPARE = 7;    // pads to 8 words; irradiance tile slot (Phase 3)

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
 */
export function createSrcProbeStore({
  c0Probes = 65536,
  cascadeCount = CASCADE_COUNT,
  loadFactor = 0.5,
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
  const probeTable = instancedArray(new Uint32Array(probeTotal * PROBE_WORDS), "uint");
  const counters = instancedArray(new Uint32Array(cascadeCount * COUNTER_WORDS), "uint").toAtomic();

  // ── the free stack, seeded FULL and in reverse ────────────────────────────
  // Reverse so the first pops are indices 0, 1, 2… on a cold boot. That is
  // cosmetic for correctness and load-bearing for debugging: a fresh frame's
  // probe 0 is at table entry 0, so a readback is readable by eye instead of
  // being a permutation nobody can check.
  const freeInit = new Uint32Array(probeTotal);
  for (const c of cascades) {
    for (let i = 0; i < c.probeCapacity; i++) {
      freeInit[c.probeBase + i] = c.probeBase + (c.probeCapacity - 1 - i);
    }
  }
  const freeStack = instancedArray(freeInit, "uint");
  // Top-of-stack per cascade, atomic: `atomicSub` pops, `atomicAdd` pushes.
  const freeTopInit = new Uint32Array(cascadeCount);
  for (const c of cascades) freeTopInit[c.cascade] = c.probeCapacity;
  const freeTop = instancedArray(freeTopInit, "uint").toAtomic();

  const store = {
    cascadeCount,
    cascades,
    hashTotal,
    probeTotal,
    hashKeys,
    hashSlot,
    probeTable,
    counters,
    freeStack,
    freeTop,
    /** Bytes on the GPU, for the memory high-water telemetry (plan §8). */
    bytes: (hashTotal * 2 + probeTotal * PROBE_WORDS + probeTotal + cascadeCount * (COUNTER_WORDS + 1)) * 4,
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
  const { hashKeys, hashSlot, probeTable, counters, freeStack, freeTop } = store;
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
 * hashSlotNode)` receives the absolute hash slot so the caller can remember
 * where its key landed; the PROBE INDEX is not known yet and asking for it here
 * is the race this two-pass split exists to avoid — the thread that loses the
 * CAS would have to spin until the winner allocated.
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
      if (onSlot) onSlot(i, int(-1));
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
      if (onSlot) onSlot(i, int(-1));
    }).Else(() => {
      if (onSlot) onSlot(i, int(uint(c.hashBase).add(uint(r.x))));
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
  const { hashKeys, hashSlot, probeTable, counters, freeStack, freeTop } = store;
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
    probeTable.element(w.add(PROBE_KEY)).assign(key);
    probeTable.element(w.add(PROBE_AGE)).assign(uint(0));
    probeTable.element(w.add(PROBE_FLAGS)).assign(uint(FLAG_ALIVE | FLAG_FRESH));
    probeTable.element(w.add(PROBE_PARENT)).assign(uint(SLOT_EMPTY));
    probeTable.element(w.add(PROBE_HASH)).assign(h);
    probeTable.element(w.add(PROBE_RAYS)).assign(uint(0));
    probeTable.element(w.add(PROBE_RAYOFF)).assign(uint(0));
    probeTable.element(w.add(PROBE_SPARE)).assign(uint(0));
    hashSlot.element(h).assign(p);
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_LIVE)), uint(1));
    atomicAdd(counters.element(uint(cascade * COUNTER_WORDS + COUNTER_FRESH)), uint(1));
  })().compute(c.hashCapacity);
}

/**
 * Resolve a remembered hash slot to a probe index. Runs after `[C]`, and it is
 * the reason `[B]` hands its caller a hash slot instead of an index.
 *
 * `slotOf(i)` returns the absolute hash slot node (or < 0), `write(i, indexNode)`
 * stores the result. `SLOT_EMPTY` means the key never got a probe — the caller
 * must treat that as "no probe", not as index 0.
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
    const h = int(slotOf(i)).toVar();
    If(h.lessThan(0), () => {
      write(i, uint(SLOT_EMPTY));
    }).Else(() => {
      const p = hashSlot.element(uint(h)).toVar();
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
      probeCapacity: c.probeCapacity,
      hashCapacity: c.hashCapacity,
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
      (s.failed ? ` FAILED ${s.failed}` : ""))
    .join("  |  ");
}
