/**
 * `engine.time` — one place for every question about when.
 *
 * Two things that are always used together, and were previously apart: the
 * frame's clocks (`delta`, `elapsed`, and their unscaled twins) and the
 * scheduler that runs on them. A cooldown written against `engine.deltaTime`
 * and a cooldown written as `engine.time.after(3, …)` are the same feature, and
 * splitting them across two namespaces means every gameplay script imports the
 * concept twice. `engine.deltaTime` and friends stay exactly where they are —
 * they are load-bearing across the whole engine — and `engine.time` is the
 * gameplay-facing surface that owns both halves.
 *
 * ## The scheduler
 *
 * A game does not run a handful of timers. It runs thousands: every cooldown,
 * every spawn wave, every fuse, every "flash the sprite for 80 ms", every AI
 * re-plan tick. So the thing that matters is not what one timer costs — it is
 * what ten thousand PENDING timers cost on a frame when none of them are due.
 * Here that is one float comparison per clock and one array index. Not a scan.
 *
 * ## Why not setTimeout
 *
 * `setTimeout` is wall-clock. It does not stop when the game pauses, does not
 * slow down under a bullet-time `timeScale`, keeps running across a scene load,
 * and fires between frames — so a callback can mutate the scene halfway through
 * a render. Every one of those is a bug in a game, and the workaround people
 * write (a `dt` accumulator per object, checked every frame) is the O(n) scan
 * this file exists to avoid.
 *
 * ## Why not "something cleverer than requestAnimationFrame"
 *
 * Worth stating plainly, because it is the obvious next thought: moving the
 * CLOCK off the main thread does not help. A timer callback here mutates the
 * scene, so it has to run on the main thread, in step with the frame. A worker
 * that wakes at exactly the right microsecond can only `postMessage`, which is
 * delivered as an ordinary main-thread task — no earlier than the frame would
 * have arrived, and not at all while the tab is frozen. The gain that IS real
 * lives in the data structures below, and in `overshoot` (see `fire`), which
 * hands the callback the sub-frame error so it can correct for it.
 *
 * (The genuine exception is audio-synced timing, where `AudioContext.currentTime`
 * beats the frame clock. That belongs to the audio system, not here.)
 *
 * ## The three schedules
 *
 * Timers are split by CLOCK, because the clocks tick at different rates and a
 * single ordering across them would be meaningless:
 *
 *   game   — scaled game seconds. Freezes on `setPaused(true)`, slows with
 *            `timeScale`. The default, and what gameplay wants.
 *   real   — unscaled seconds. Ignores pause and time scale. For UI that must
 *            keep animating while the game is frozen, and for anything the
 *            player would call "real time".
 *   frames — integer frame counts. For "settle for one frame", which is a
 *            different question from "wait 16 ms" and gets a different answer
 *            on a machine running at 144 Hz.
 *
 * The two time clocks each get a **4-ary min-heap** in flat typed arrays.
 * 4-ary rather than binary because it is a third shallower, and the four
 * children of a node are contiguous — a sift-down touches fewer cache lines.
 * Nothing in the heap is an object, so scheduling a timer allocates nothing.
 *
 * Frames get a **timing wheel** instead: a ring of 256 buckets, where a wait of
 * n frames is written straight into bucket `(frame + n) & 255`. No comparison,
 * no sift, genuinely O(1) — and firing a frame is "take one bucket and walk its
 * list". Waits longer than the ring go to an overflow list that is cascaded
 * back in once per full revolution, so they cost O(1) amortised too. This is
 * the structure kernels use for exactly this reason, and frame waits are the
 * case where it pays: they are overwhelmingly short (1-3 frames) and numerous.
 *
 * ## Handles are numbers
 *
 * `after()` returns an integer, not an object, so the common case allocates
 * nothing at all. The integer packs a slot index and a GENERATION counter; the
 * generation is bumped every time a slot is recycled, so a handle kept past its
 * timer's death cannot cancel whatever timer inherited the slot. That bug —
 * cancel-the-wrong-timer after a respawn — is the one every hand-rolled timer
 * pool eventually ships.
 *
 * Cancellation is a tombstone: the slot is marked dead immediately (so it never
 * fires) but is not recycled until the scheduler reaches it. That keeps cancel
 * at O(1) instead of paying an O(log n) arbitrary removal for the overwhelmingly
 * common case of a timer that is simply allowed to run.
 */

/** Slots per generation step. Caps the pool at ~1M live timers. */
const SLOT_STRIDE = 1 << 20;

/** Frame wheel size. A power of two so the modulo is a mask. */
const RING = 256;
const RING_MASK = RING - 1;

// Flag bits on `_flags`.
const ACTIVE = 1 << 0;   // should still fire
const QUEUED = 1 << 1;   // referenced by a heap or the wheel; do not recycle
const PROMISE = 1 << 2;  // `_cb` is a promise resolver, not a user callback
const REPEAT = 1 << 3;   // re-arm after firing

// Domains, stored in bits 4-5.
const DOMAIN_SHIFT = 4;
const DOMAIN_MASK = 0b11 << DOMAIN_SHIFT;
const GAME = 0 << DOMAIN_SHIFT;
const REAL = 1 << DOMAIN_SHIFT;
const FRAME = 2 << DOMAIN_SHIFT;

/**
 * Most repeats a single frame may fire before the schedule is rebased.
 *
 * A tab in the background, a scene load, or a long compile stall can leave a
 * 20 ms repeater a hundred thousand periods behind. Firing all of them is
 * never what anyone meant by "every 20 ms" — it is a freeze, and for a spawner
 * it is a freeze that also spawns 100,000 enemies. Past this many catch-up
 * iterations the timer is rebased to `now + period` and the lost ticks are
 * dropped, which is the same choice a fixed-timestep loop makes when it clamps
 * its accumulator.
 */
const MAX_CATCHUP = 8;

/**
 * A 4-ary min-heap of (key, slot) in flat typed arrays.
 *
 * Kept private to this file: it is not a general-purpose priority queue, it is
 * the exact shape the two time clocks need, and giving it an object-based API
 * would undo the reason it exists.
 */
class DueHeap {
  constructor(capacity = 64) {
    this.keys = new Float64Array(capacity);
    this.slots = new Int32Array(capacity);
    this.size = 0;
  }

  #grow() {
    const keys = new Float64Array(this.keys.length * 2);
    const slots = new Int32Array(this.slots.length * 2);
    keys.set(this.keys);
    slots.set(this.slots);
    this.keys = keys;
    this.slots = slots;
  }

  /** The earliest due time, or Infinity when empty — so callers need no branch. */
  peek() {
    return this.size === 0 ? Infinity : this.keys[0];
  }

  push(key, slot) {
    if (this.size === this.keys.length) this.#grow();
    let i = this.size++;
    const keys = this.keys;
    const slots = this.slots;
    // Sift up. The hole moves rather than swapping pairs, so each level costs
    // one write instead of three.
    while (i > 0) {
      const parent = (i - 1) >> 2;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      slots[i] = slots[parent];
      i = parent;
    }
    keys[i] = key;
    slots[i] = slot;
  }

  /** Removes and returns the minimum slot. Undefined behaviour when empty. */
  pop() {
    const keys = this.keys;
    const slots = this.slots;
    const top = slots[0];
    const size = --this.size;
    if (size === 0) return top;

    const key = keys[size];
    const slot = slots[size];
    let i = 0;
    for (;;) {
      const first = 4 * i + 1;
      if (first >= size) break;
      // Pick the smallest of up to four contiguous children. The bound check
      // is hoisted out of the comparison loop for the common full-node case.
      let best = first;
      const last = Math.min(first + 4, size);
      for (let c = first + 1; c < last; c++) {
        if (keys[c] < keys[best]) best = c;
      }
      if (keys[best] >= key) break;
      keys[i] = keys[best];
      slots[i] = slots[best];
      i = best;
    }
    keys[i] = key;
    slots[i] = slot;
    return top;
  }
}

export class TimeSystem {
  constructor(engine = null) {
    this.engine = engine;

    // --- slot storage: struct of arrays, one entry per live timer -----------
    this._capacity = 0;
    this._due = new Float64Array(0);     // due time (seconds) or due frame
    this._period = new Float64Array(0);  // repeat interval; 0 for one-shot
    this._gen = new Uint32Array(0);      // bumped on recycle; guards stale ids
    this._flags = new Uint8Array(0);
    this._next = new Int32Array(0);      // intrusive list link for the wheel
    this._cb = [];                       // callbacks / promise resolvers
    this._free = [];                     // recycled slot indices
    this._top = 0;                       // next never-used slot
    this._owner = [];                    // scope token, for cancelAll
    this.#reserve(256);

    this._gameHeap = new DueHeap();
    this._realHeap = new DueHeap();

    // Frame wheel: bucket heads, -1 for empty.
    this._wheel = new Int32Array(RING).fill(-1);
    // Waits longer than one revolution, re-bucketed on wrap.
    this._overflow = [];

    this._gameTime = 0;
    this._realTime = 0;
    this._delta = 0;
    this._unscaledDelta = 0;
    this._frame = 0;
    this._live = 0;
  }

  // -------------------------------------------------------------------------
  // The clocks. Accumulated by `update()` from the deltas the engine hands it,
  // rather than read back off the engine, so the numbers a timer was scheduled
  // against and the numbers a script reads are the same numbers — and so the
  // whole system runs headless in a test with no engine at all.
  // -------------------------------------------------------------------------

  /** Seconds the last frame took, scaled by `timeScale` and zero while paused. */
  get delta() {
    return this._delta;
  }

  /**
   * Seconds the last frame really took. Unaffected by pause or `timeScale` —
   * what a pause menu's own animation must use, or it freezes itself.
   */
  get unscaledDelta() {
    return this._unscaledDelta;
  }

  /** Game seconds since startup. The clock `after()` and `delay()` measure against. */
  get elapsed() {
    return this._gameTime;
  }

  /** Real seconds since startup — keeps advancing while the game is paused. */
  get unscaledElapsed() {
    return this._realTime;
  }

  /** Frames since startup. The clock `afterFrames()` measures against. */
  get frame() {
    return this._frame;
  }

  /**
   * Time multiplier: 0.25 for bullet time, 2 for a fast-forward. Reads and
   * writes `engine.timeScale`, so this and the engine cannot disagree.
   */
  get scale() {
    return this.engine?.timeScale ?? 1;
  }

  set scale(value) {
    if (this.engine?.setTimeScale) this.engine.setTimeScale(value);
    else if (this.engine) this.engine.timeScale = Math.max(0, value);
  }

  /** Whether game time is frozen. Real time and frame counts keep running. */
  get paused() {
    return this.engine?.paused ?? false;
  }

  set paused(value) {
    this.engine?.setPaused?.(!!value);
  }

  /** Timers scheduled and not yet fired or cancelled. */
  get pending() {
    return this._live;
  }

  #reserve(capacity) {
    if (capacity <= this._capacity) return;
    const due = new Float64Array(capacity);
    const period = new Float64Array(capacity);
    const gen = new Uint32Array(capacity);
    const flags = new Uint8Array(capacity);
    const next = new Int32Array(capacity);
    due.set(this._due);
    period.set(this._period);
    gen.set(this._gen);
    flags.set(this._flags);
    next.set(this._next);
    this._due = due;
    this._period = period;
    this._gen = gen;
    this._flags = flags;
    this._next = next;
    this._capacity = capacity;
  }

  #alloc() {
    if (this._free.length) return this._free.pop();
    if (this._top === this._capacity) this.#reserve(this._capacity * 2);
    return this._top++;
  }

  /**
   * Returns a slot to the pool and invalidates every handle that named it.
   *
   * The generation bump is the whole safety story: an id captured before this
   * point decodes to a generation that no longer matches, so `cancel()` on a
   * long-dead timer is a no-op rather than a cancel of whatever now owns the
   * slot.
   */
  #release(slot) {
    this._cb[slot] = null;
    this._owner[slot] = null;
    this._flags[slot] = 0;
    // Wraps at 2^32; a slot would have to be recycled four billion times
    // between a handle being taken and used for that to collide.
    this._gen[slot] = (this._gen[slot] + 1) >>> 0;
    this._free.push(slot);
  }

  /**
   * Encodes a slot + generation as one integer handle.
   *
   * The `+ 1` is load-bearing: without it the very first timer ever created
   * (slot 0, generation 0) gets handle 0, which is falsy and indistinguishable
   * from "no timer" — so it could never be cancelled, and every guard written
   * as `if (id)` would skip it. Handles start at 1 so that 0 can mean nothing,
   * which is what callers assume anyway.
   */
  #handle(slot) {
    return this._gen[slot] * SLOT_STRIDE + slot + 1;
  }

  /** Decodes a handle to its slot, or -1 if it is stale, cancelled or bogus. */
  #resolve(id) {
    if (!(typeof id === "number" && id >= 1 && Number.isSafeInteger(id))) return -1;
    const slot = (id - 1) % SLOT_STRIDE;
    if (slot >= this._capacity) return -1;
    if (this.#handle(slot) !== id) return -1;
    return (this._flags[slot] & ACTIVE) !== 0 ? slot : -1;
  }

  #schedule(slot, delay, domain) {
    if (domain === FRAME) {
      // Whole frames only, and never zero: `afterFrames(0)` meaning "later in
      // this same frame" would fire inside the update it was created in, which
      // is a same-frame reentrancy hazard, not a delay.
      const frames = Math.max(1, Math.round(delay));
      const due = this._frame + frames;
      this._due[slot] = due;
      if (frames < RING) {
        const bucket = due & RING_MASK;
        this._next[slot] = this._wheel[bucket];
        this._wheel[bucket] = slot;
      } else {
        this._overflow.push(slot);
      }
    } else if (domain === REAL) {
      const due = this._realTime + Math.max(0, delay);
      this._due[slot] = due;
      this._realHeap.push(due, slot);
    } else {
      const due = this._gameTime + Math.max(0, delay);
      this._due[slot] = due;
      this._gameHeap.push(due, slot);
    }
    this._flags[slot] |= QUEUED;
  }

  /**
   * The one door `TimerScope` uses. A method rather than six owner-taking
   * public overloads, and underscore-prefixed rather than `#private` because a
   * scope is a separate class and cannot reach a private field.
   */
  _scoped(delay, callback, domain, repeat, promise, owner) {
    return this.#create(delay, callback, { domain, repeat, promise, owner });
  }

  #create(delay, callback, { domain = GAME, repeat = false, promise = false, owner = null } = {}) {
    const slot = this.#alloc();
    this._cb[slot] = callback;
    this._owner[slot] = owner;
    this._period[slot] = repeat ? Math.max(1e-6, delay) : 0;
    this._flags[slot] = ACTIVE | domain | (repeat ? REPEAT : 0) | (promise ? PROMISE : 0);
    this._next[slot] = -1;
    this._live++;
    this.#schedule(slot, delay, domain);
    return this.#handle(slot);
  }

  // -------------------------------------------------------------------------
  // Callback form. Returns an integer handle; allocates nothing.
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` once after `seconds` of GAME time.
   *
   *     this.timers.after(1.5, () => this.entity.destroy());
   *
   * `fn` receives the **overshoot**: how far past the due moment the frame
   * actually landed, in seconds. A timer due 4 ms into a 16 ms frame fires at
   * the frame boundary with `overshoot === 0.012`, and a projectile spawned
   * from it can advance itself by that much instead of appearing 12 ms behind
   * where it should be. Ignore it and nothing breaks; use it and fast-moving
   * things stop looking spongy.
   */
  after(seconds, fn) {
    return this.#create(seconds, fn);
  }

  /** Runs `fn` every `seconds` of game time until cancelled. */
  every(seconds, fn) {
    return this.#create(seconds, fn, { repeat: true });
  }

  /** `after`, on the unscaled clock — unaffected by pause or `timeScale`. */
  afterReal(seconds, fn) {
    return this.#create(seconds, fn, { domain: REAL });
  }

  /** `every`, on the unscaled clock. */
  everyReal(seconds, fn) {
    return this.#create(seconds, fn, { domain: REAL, repeat: true });
  }

  /**
   * Runs `fn` after `frames` rendered frames — not after a duration.
   *
   * The right tool for "let this settle": one frame is one pass of the update
   * order, whatever the machine's refresh rate, and `after(1 / 60)` is not the
   * same promise on a 144 Hz display.
   */
  afterFrames(frames, fn) {
    return this.#create(frames, fn, { domain: FRAME });
  }

  /** Runs `fn` every `frames` frames until cancelled. */
  everyFrames(frames, fn) {
    return this.#create(frames, fn, { domain: FRAME, repeat: true });
  }

  // -------------------------------------------------------------------------
  // Awaitable form. One promise each; nothing else.
  // -------------------------------------------------------------------------

  /**
   * Waits `seconds` of game time.
   *
   *     await this.timers.delay(0.4);
   *
   * Resolves `true` when the time elapsed and `false` when the timer was
   * cancelled — including by the owning script being destroyed mid-wait.
   * Cancellation RESOLVES rather than rejecting or hanging: rejecting would
   * make every unguarded `await` an unhandled rejection, and never settling
   * would silently skip the `finally` blocks people use to clean up.
   *
   *     if (!(await this.timers.delay(0.4))) return;   // we were torn down
   */
  delay(seconds) {
    return new Promise((resolve) => this.#create(seconds, resolve, { promise: true }));
  }

  /** `delay` on the unscaled clock: keeps counting while the game is paused. */
  realDelay(seconds) {
    return new Promise((resolve) => this.#create(seconds, resolve, { domain: REAL, promise: true }));
  }

  /** Waits a whole number of frames. */
  frames(count = 1) {
    return new Promise((resolve) => this.#create(count, resolve, { domain: FRAME, promise: true }));
  }

  /** Waits until the next frame's update. */
  nextFrame() {
    return this.frames(1);
  }

  // -------------------------------------------------------------------------

  /** True while `id` names a timer that has not fired or been cancelled. */
  isActive(id) {
    return this.#resolve(id) >= 0;
  }

  /**
   * Cancels a timer. Returns false for an id that already fired, was already
   * cancelled, or belongs to a recycled slot — all of which are ordinary, so
   * none of them throw.
   */
  cancel(id) {
    const slot = this.#resolve(id);
    if (slot < 0) return false;
    this.#kill(slot);
    return true;
  }

  #kill(slot) {
    const flags = this._flags[slot];
    this._flags[slot] = flags & ~ACTIVE & ~REPEAT;
    this._live--;
    if (flags & PROMISE) {
      const resolve = this._cb[slot];
      this._cb[slot] = null;
      // Settle immediately rather than at the due time. An awaiting coroutine
      // belonging to a destroyed entity should unwind now, not keep its frame
      // alive until a timer nobody is waiting for would have expired.
      resolve?.(false);
    }
    // The slot stays claimed until the scheduler reaches it — see the class
    // header on tombstones. If it is not queued anywhere, recycle it now.
    if (!(this._flags[slot] & QUEUED)) this.#release(slot);
  }

  /**
   * Cancels every timer created through `scope(owner)`.
   *
   * O(capacity), which is why it is a teardown operation and not something to
   * call per frame — but it is the operation that makes timers safe: a script
   * that schedules a callback and is then destroyed must not have that callback
   * run against a dead entity.
   */
  cancelOwner(owner) {
    if (owner == null) return 0;
    let count = 0;
    for (let slot = 0; slot < this._top; slot++) {
      if ((this._flags[slot] & ACTIVE) && this._owner[slot] === owner) {
        this.#kill(slot);
        count++;
      }
    }
    return count;
  }

  /**
   * A view whose timers all belong to `owner`, so they can be cancelled as a
   * group. Same API as the system itself; `cancelAll()` is the addition.
   *
   * This is what a script gets as `this.timers`, and it is the difference
   * between a timer system and a crash: gameplay code schedules callbacks that
   * capture `this`, and entities die mid-flight all the time.
   */
  scope(owner) {
    return new TimerScope(this, owner);
  }

  /**
   * Fires one timer and either re-arms or retires it.
   *
   * `lateBy` is the overshoot handed to the callback — see `after`. Repeats
   * measure the next period from the timer's DUE time, not from now, so a
   * 1-second repeater that fires 4 ms late is still on the same 1-second grid
   * an hour later instead of drifting by 4 ms per tick.
   */
  #fire(slot, lateBy) {
    const flags = this._flags[slot];
    const callback = this._cb[slot];
    const repeating = (flags & REPEAT) !== 0;

    if (!repeating) {
      // Retire BEFORE the callback runs. A one-shot that reschedules itself
      // from inside its own callback is normal, and it must be allocated a
      // fresh slot rather than racing the teardown of this one.
      this._flags[slot] &= ~ACTIVE;
      this._live--;
      this._cb[slot] = null;
      this._owner[slot] = null;
    }

    if (flags & PROMISE) callback?.(true);
    else callback?.(lateBy);

    if (!repeating) {
      this.#release(slot);
      return;
    }
    // A callback may have cancelled its own repeater.
    if (!(this._flags[slot] & ACTIVE)) {
      this.#release(slot);
      return;
    }
    const domain = this._flags[slot] & DOMAIN_MASK;
    const period = this._period[slot];
    const clock = domain === FRAME ? this._frame : domain === REAL ? this._realTime : this._gameTime;
    let due = this._due[slot] + period;
    // Catch-up clamp: see MAX_CATCHUP.
    if (due <= clock) {
      const behind = Math.floor((clock - due) / period) + 1;
      due = behind > MAX_CATCHUP ? clock + period : due + behind * period;
    }
    this._due[slot] = due;
    if (domain === FRAME) {
      const ahead = due - this._frame;
      if (ahead < RING) {
        const bucket = due & RING_MASK;
        this._next[slot] = this._wheel[bucket];
        this._wheel[bucket] = slot;
      } else {
        this._overflow.push(slot);
      }
    } else if (domain === REAL) {
      this._realHeap.push(due, slot);
    } else {
      this._gameHeap.push(due, slot);
    }
    this._flags[slot] |= QUEUED;
  }

  /** Drains one time heap up to `now`. */
  #drain(heap, now) {
    while (heap.peek() <= now) {
      const slot = heap.pop();
      // Not necessarily still ours: a cancelled timer left a tombstone, and a
      // repeater may already have been re-pushed with a later key.
      const flags = this._flags[slot];
      if (this._due[slot] > now) {
        // Re-armed past this frame by an earlier iteration; it is queued under
        // its new key, so drop this stale reference without touching QUEUED.
        continue;
      }
      this._flags[slot] &= ~QUEUED;
      if (!(flags & ACTIVE)) {
        this.#release(slot);
        continue;
      }
      this.#fire(slot, now - this._due[slot]);
    }
  }

  /**
   * Advances every clock and fires what is due.
   *
   * Called once per frame from `Engine.#tick`, BEFORE the update callbacks —
   * so a timer that comes due this frame has already had its effect by the time
   * scripts run, rather than being a frame behind everything else.
   *
   * Idle cost is deliberately trivial: two `peek()` comparisons against
   * `Infinity` and one array index. Ten thousand pending timers cost the same
   * as none until one is actually due.
   */
  update(dt, unscaledDt) {
    this._delta = dt;
    this._unscaledDelta = unscaledDt;
    this._gameTime += dt;
    this._realTime += unscaledDt;

    // --- frames ------------------------------------------------------------
    this._frame++;
    // A full revolution has passed, so overflow entries may now be inside the
    // ring. Amortised O(1): a timer is re-examined once per RING frames.
    if ((this._frame & RING_MASK) === 0 && this._overflow.length) {
      const staying = [];
      for (const slot of this._overflow) {
        if (!(this._flags[slot] & ACTIVE)) {
          this._flags[slot] &= ~QUEUED;
          this.#release(slot);
          continue;
        }
        const ahead = this._due[slot] - this._frame;
        if (ahead < RING) {
          const bucket = this._due[slot] & RING_MASK;
          this._next[slot] = this._wheel[bucket];
          this._wheel[bucket] = slot;
        } else {
          staying.push(slot);
        }
      }
      this._overflow = staying;
    }

    const bucket = this._frame & RING_MASK;
    let slot = this._wheel[bucket];
    if (slot !== -1) {
      // Detach the whole bucket first: a callback that schedules another frame
      // timer for this same bucket index (256 frames out) must not have it
      // walked by the loop it is standing in.
      this._wheel[bucket] = -1;
      while (slot !== -1) {
        const next = this._next[slot];
        this._next[slot] = -1;
        this._flags[slot] &= ~QUEUED;
        if (!(this._flags[slot] & ACTIVE)) this.#release(slot);
        // Frame timers have no sub-frame error to report — a frame is the unit.
        else this.#fire(slot, 0);
        slot = next;
      }
    }

    // --- time --------------------------------------------------------------
    // Real before game: a paused game advances only the real clock, and doing
    // it in this order means a real timer that unpauses the game is honoured
    // by the game clock on the very next frame rather than two frames later.
    this.#drain(this._realHeap, this._realTime);
    this.#drain(this._gameHeap, this._gameTime);
  }

  /**
   * Cancels everything. Used on scene load and on engine teardown — a timer
   * scheduled by the previous scene firing into the new one is a class of bug
   * that is very hard to read from the symptom.
   */
  clear() {
    for (let slot = 0; slot < this._top; slot++) {
      if (this._flags[slot] & ACTIVE) this.#kill(slot);
    }
    this._gameHeap = new DueHeap();
    this._realHeap = new DueHeap();
    this._wheel.fill(-1);
    this._overflow.length = 0;
    this._free.length = 0;
    this._top = 0;
    this._cb.length = 0;
    this._owner.length = 0;
    this._flags.fill(0);
    this._live = 0;
  }
}

/**
 * `system.scope(owner)` — the same API, with every timer tagged so the group
 * can be torn down at once. See `TimerSystem.scope`.
 */
class TimerScope {
  constructor(system, owner) {
    this.system = system;
    this.owner = owner;
  }

  // The clocks read through unchanged: a scope narrows OWNERSHIP, not time.
  get delta() { return this.system.delta; }
  get unscaledDelta() { return this.system.unscaledDelta; }
  get elapsed() { return this.system.elapsed; }
  get unscaledElapsed() { return this.system.unscaledElapsed; }
  get frame() { return this.system.frame; }
  get scale() { return this.system.scale; }
  set scale(value) { this.system.scale = value; }
  get paused() { return this.system.paused; }
  set paused(value) { this.system.paused = value; }
  get pending() { return this.system.pending; }

  after(seconds, fn) { return this.system._scoped(seconds, fn, GAME, false, false, this.owner); }
  every(seconds, fn) { return this.system._scoped(seconds, fn, GAME, true, false, this.owner); }
  afterReal(seconds, fn) { return this.system._scoped(seconds, fn, REAL, false, false, this.owner); }
  everyReal(seconds, fn) { return this.system._scoped(seconds, fn, REAL, true, false, this.owner); }
  afterFrames(frames, fn) { return this.system._scoped(frames, fn, FRAME, false, false, this.owner); }
  everyFrames(frames, fn) { return this.system._scoped(frames, fn, FRAME, true, false, this.owner); }

  delay(seconds) {
    return new Promise((resolve) => this.system._scoped(seconds, resolve, GAME, false, true, this.owner));
  }

  realDelay(seconds) {
    return new Promise((resolve) => this.system._scoped(seconds, resolve, REAL, false, true, this.owner));
  }

  frames(count = 1) {
    return new Promise((resolve) => this.system._scoped(count, resolve, FRAME, false, true, this.owner));
  }

  nextFrame() { return this.frames(1); }

  isActive(id) { return this.system.isActive(id); }
  cancel(id) { return this.system.cancel(id); }

  /** Cancels every timer this scope created. Pending `await`s resolve `false`. */
  cancelAll() { return this.system.cancelOwner(this.owner); }
}

export { TimerScope };
