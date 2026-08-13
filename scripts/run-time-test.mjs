/**
 * `engine.time` — the clocks and the scheduler behind them.
 *
 *   node scripts/run-time-test.mjs
 *
 * No browser and no engine: `TimeSystem` takes its deltas as arguments, which
 * is what lets a thousand frames be replayed in a millisecond and what lets the
 * awkward cases below be written down at all.
 *
 * ## What is actually being gated
 *
 * Not "does a timer fire". Every structure in that file exists because the
 * obvious implementation has a specific failure, and these pin the failures:
 *
 *   - a handle kept past its timer's death must not cancel the timer that
 *     inherited its slot (the recycled-slot bug every timer pool ships),
 *   - a repeater must not drift, and must not fire 10,000 times to catch up
 *     after a stall,
 *   - game timers must freeze under pause while real timers keep going,
 *   - a frame wait must survive the wheel wrapping (the 256-frame boundary is
 *     where a hand-rolled ring quietly loses timers),
 *   - a cancelled `await` must RESOLVE rather than hang or reject,
 *   - a callback that schedules or cancels from inside itself must not corrupt
 *     the queue it is standing in,
 *   - and the whole thing must allocate nothing per pending timer, which is
 *     checked as a cost ratio rather than a vibe.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TimeSystem } from "../src/engine/time.js";

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
};

const asyncChecks = [];
const checkAsync = (name, fn) => {
  asyncChecks.push([name, fn]);
};

const near = (a, b, tolerance = 1e-9, message = "") =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message} got ${a}, want ${b} (±${tolerance})`);

/** Runs `frames` frames at a fixed step. */
const run = (time, frames, dt = 1 / 60, unscaled = dt) => {
  for (let i = 0; i < frames; i++) time.update(dt, unscaled);
};

// ---------------------------------------------------------------------------
console.log("\ntime — the clocks");
// ---------------------------------------------------------------------------

check("delta and elapsed track what update was given, scaled and not", () => {
  const time = new TimeSystem();
  time.update(0.5, 1.0);
  near(time.delta, 0.5);
  near(time.unscaledDelta, 1.0);
  near(time.elapsed, 0.5);
  near(time.unscaledElapsed, 1.0);
  time.update(0.25, 0.5);
  near(time.elapsed, 0.75);
  near(time.unscaledElapsed, 1.5);
  assert.equal(time.frame, 2);
});

check("scale and paused read through to the engine, not a private copy", () => {
  // Two sources of truth for "is the game paused" is a bug generator; the
  // accessors must be a window onto the engine's own fields.
  const engine = { timeScale: 1, paused: false, setPaused(v) { this.paused = v; } };
  const time = new TimeSystem(engine);
  assert.equal(time.scale, 1);
  engine.timeScale = 0.25;
  assert.equal(time.scale, 0.25, "scale must read the engine");
  time.paused = true;
  assert.equal(engine.paused, true, "paused must write through the engine's setter");
});

// ---------------------------------------------------------------------------
console.log("\ntime — firing, ordering and overshoot");
// ---------------------------------------------------------------------------

check("a one-shot fires once, on the first frame at or past its due time", () => {
  const time = new TimeSystem();
  let fired = 0;
  time.after(0.1, () => fired++);
  run(time, 5); // 5/60 = 0.0833s
  assert.equal(fired, 0, "must not fire early");
  run(time, 2); // 0.1166s
  assert.equal(fired, 1);
  run(time, 100);
  assert.equal(fired, 1, "must not fire twice");
});

check("timers fire in due order regardless of insertion order", () => {
  const time = new TimeSystem();
  const order = [];
  time.after(0.3, () => order.push("c"));
  time.after(0.1, () => order.push("a"));
  time.after(0.2, () => order.push("b"));
  run(time, 60, 0.01);
  assert.deepEqual(order, ["a", "b", "c"]);
});

check("the callback receives its sub-frame overshoot", () => {
  // A timer due 0.1s in, on 0.06s frames, actually fires at 0.12s — 0.02s
  // late. Handing that number to the callback is what lets a spawned
  // projectile start 0.02s along instead of visibly behind.
  const time = new TimeSystem();
  let late = null;
  time.after(0.1, (overshoot) => { late = overshoot; });
  run(time, 2, 0.06);
  near(late, 0.02, 1e-9);
});

check("zero and negative delays fire on the next frame, not never", () => {
  const time = new TimeSystem();
  let fired = 0;
  time.after(0, () => fired++);
  time.after(-5, () => fired++);
  run(time, 1);
  assert.equal(fired, 2);
});

// ---------------------------------------------------------------------------
console.log("\ntime — pause and time scale");
// ---------------------------------------------------------------------------

check("a paused game freezes game timers and not real ones", () => {
  const time = new TimeSystem();
  let game = 0;
  let real = 0;
  time.after(0.1, () => game++);
  time.afterReal(0.1, () => real++);
  // Pause is dt === 0 with unscaled still running — exactly what Engine#tick
  // hands us while `paused` is set.
  run(time, 60, 0, 1 / 60);
  assert.equal(game, 0, "game timer fired while paused");
  assert.equal(real, 1, "real timer should not care about pause");
});

check("bullet time stretches game timers by exactly the scale", () => {
  const time = new TimeSystem();
  let fired = 0;
  time.after(1, () => fired++);
  // timeScale 0.25: the engine hands us a quarter of the wall delta.
  run(time, 120, 0.25 / 60, 1 / 60);
  assert.equal(fired, 0, "at 0.25x, 2 seconds of wall clock is 0.5s of game time");
  // One frame of slack, not sloppiness: `elapsed` is a running sum of floats,
  // so 240 additions of 0.25/60 land a few ulps under 1.0 and the timer is
  // honestly not due yet. A timer fires on the first frame at or past its due
  // time — the guarantee is "never early", not "on a float boundary".
  run(time, 121, 0.25 / 60, 1 / 60);
  assert.equal(fired, 1);
});

// ---------------------------------------------------------------------------
console.log("\ntime — frames");
// ---------------------------------------------------------------------------

check("afterFrames counts frames, not seconds", () => {
  const time = new TimeSystem();
  let fired = 0;
  time.afterFrames(3, () => fired++);
  run(time, 2, 10); // huge deltas; irrelevant to a frame wait
  assert.equal(fired, 0);
  run(time, 1, 10);
  assert.equal(fired, 1);
});

check("afterFrames(0) is clamped to the next frame, never the current one", () => {
  // Firing inside the update that created it is same-frame reentrancy, not a
  // delay — and it would let a script schedule an infinite loop by accident.
  const time = new TimeSystem();
  const seen = [];
  time.afterFrames(0, () => seen.push(time.frame));
  run(time, 2);
  assert.deepEqual(seen, [1]);
});

check("a frame wait longer than the wheel survives the wrap", () => {
  // 256 buckets: a 300-frame wait lives in overflow and has to be cascaded
  // back in on a revolution boundary. Getting this wrong loses the timer
  // silently, which is why it is worth a test that runs 400 frames.
  const time = new TimeSystem();
  let fired = 0;
  time.afterFrames(300, () => fired++);
  run(time, 299);
  assert.equal(fired, 0, "fired early");
  run(time, 1);
  assert.equal(fired, 1, "lost across the wheel wrap");
});

check("frame waits either side of the wrap boundary all land", () => {
  const time = new TimeSystem();
  const fired = [];
  for (const n of [1, 255, 256, 257, 512, 513]) {
    time.afterFrames(n, () => fired.push(n));
  }
  run(time, 600);
  assert.deepEqual(fired, [1, 255, 256, 257, 512, 513]);
});

// ---------------------------------------------------------------------------
console.log("\ntime — repeats");
// ---------------------------------------------------------------------------

check("a repeater fires on a fixed grid and does not drift", () => {
  // Measured from the DUE time, not from `now`. Measuring from now accumulates
  // the per-fire overshoot, and an hour in, a 1-second repeater is seconds off.
  const time = new TimeSystem();
  const at = [];
  time.every(0.1, () => at.push(time.elapsed));
  run(time, 1000, 0.007); // a step that never lands on a multiple of 0.1
  // 69 or 70: the 70th is due at exactly 7.0 and `elapsed` is a float sum that
  // may land a few ulps short. The count is not the invariant — the grid is.
  assert.ok(at.length >= 69 && at.length <= 70, `fired ${at.length} times in ~7 seconds`);
  // Each fire is within one frame of its ideal grid point, and the LAST one
  // is too — that is what "no drift" means. A repeater that measured its next
  // period from `now` instead of from its due time would be ~70 frame-errors
  // behind by the end and fail here, while still firing 69 times.
  for (let i = 0; i < at.length; i++) {
    const ideal = (i + 1) * 0.1;
    assert.ok(at[i] >= ideal && at[i] < ideal + 0.007 + 1e-9, `fire ${i} at ${at[i]}, ideal ${ideal}`);
  }
});

check("a long stall does not fire a repeater thousands of times", () => {
  // Backgrounded tab, scene load, compile stall. Firing every missed period is
  // a freeze — and for a spawner, a freeze that also spawns an army.
  const time = new TimeSystem();
  let fired = 0;
  time.every(0.02, () => fired++);
  time.update(600, 600); // ten minutes in one frame
  assert.ok(fired <= 8, `fired ${fired} times catching up on a 600s frame`);
  assert.ok(fired >= 1, "should still fire at least once");
  // And it is rebased, not permanently behind.
  fired = 0;
  run(time, 100, 0.02);
  assert.ok(fired >= 90 && fired <= 101, `after rebase, fired ${fired} in 100 periods`);
});

check("a repeater cancelled from inside its own callback stops", () => {
  const time = new TimeSystem();
  let fired = 0;
  let id = 0;
  id = time.every(0.05, () => {
    fired++;
    if (fired === 3) time.cancel(id);
  });
  run(time, 200, 0.01);
  assert.equal(fired, 3);
  assert.equal(time.pending, 0, "slot should be retired");
});

check("everyFrames repeats on the wheel", () => {
  const time = new TimeSystem();
  let fired = 0;
  time.everyFrames(5, () => fired++);
  run(time, 51);
  assert.equal(fired, 10);
});

// ---------------------------------------------------------------------------
console.log("\ntime — handles, cancellation and reentrancy");
// ---------------------------------------------------------------------------

check("cancel stops a timer and reports whether it did anything", () => {
  const time = new TimeSystem();
  let fired = 0;
  const id = time.after(0.1, () => fired++);
  assert.equal(time.isActive(id), true);
  assert.equal(time.cancel(id), true);
  assert.equal(time.isActive(id), false);
  assert.equal(time.cancel(id), false, "second cancel is a no-op, not an error");
  run(time, 60);
  assert.equal(fired, 0);
});

check("a stale handle cannot cancel the timer that inherited its slot", () => {
  // THE bug this design exists to prevent. Slot indices are recycled; without
  // a generation counter, a handle kept across a respawn cancels a stranger's
  // timer, and the symptom appears somewhere else entirely.
  const time = new TimeSystem();
  const dead = time.after(0.01, () => {});
  run(time, 10);            // fires; slot returns to the pool
  assert.equal(time.isActive(dead), false);

  let survived = 0;
  const fresh = time.after(0.1, () => survived++);
  assert.notEqual(fresh, dead, "a recycled slot must not reissue the same handle");
  assert.equal(time.cancel(dead), false, "stale handle cancelled a live timer");
  run(time, 60);
  assert.equal(survived, 1, "the live timer was killed by a stale handle");
});

check("bogus handles are ignored rather than throwing", () => {
  const time = new TimeSystem();
  for (const bad of [0, -1, NaN, undefined, null, 1e15, "nonsense"]) {
    assert.equal(time.cancel(bad), false, `cancel(${String(bad)})`);
    assert.equal(time.isActive(bad), false, `isActive(${String(bad)})`);
  }
});

check("a timer scheduled from inside a firing callback is not fired same-frame", () => {
  const time = new TimeSystem();
  const seen = [];
  time.after(0.05, () => {
    seen.push("outer");
    time.after(0, () => seen.push("inner"));
  });
  run(time, 4, 0.02);
  assert.deepEqual(seen, ["outer", "inner"]);
});

check("cancelling a sibling from inside a callback is safe", () => {
  // Both are due the same frame and both are in the same structure; killing
  // one while the other is being walked must not corrupt the queue.
  const time = new TimeSystem();
  let b = 0;
  let idB = 0;
  time.after(0.05, () => time.cancel(idB));
  idB = time.after(0.05, () => b++);
  run(time, 10, 0.02);
  assert.equal(b, 0, "the cancelled sibling still fired");
  assert.equal(time.pending, 0);
});

check("clear() cancels everything and resets the pool", () => {
  const time = new TimeSystem();
  let fired = 0;
  for (let i = 0; i < 50; i++) time.after(0.1, () => fired++);
  time.everyFrames(2, () => fired++);
  assert.equal(time.pending, 51);
  time.clear();
  assert.equal(time.pending, 0);
  run(time, 100);
  assert.equal(fired, 0);
});

// ---------------------------------------------------------------------------
console.log("\ntime — scopes");
// ---------------------------------------------------------------------------

check("a scope cancels only its own timers", () => {
  const time = new TimeSystem();
  const a = time.scope({ name: "a" });
  const b = time.scope({ name: "b" });
  let hitA = 0;
  let hitB = 0;
  let hitRoot = 0;
  a.after(0.1, () => hitA++);
  a.afterFrames(2, () => hitA++);
  b.after(0.1, () => hitB++);
  time.after(0.1, () => hitRoot++);

  assert.equal(a.cancelAll(), 2, "should report how many it killed");
  run(time, 60);
  assert.equal(hitA, 0, "scope a survived its own teardown");
  assert.equal(hitB, 1);
  assert.equal(hitRoot, 1);
});

check("a scope reads the same clocks as the system", () => {
  const time = new TimeSystem();
  const scope = time.scope({});
  time.update(0.5, 0.75);
  near(scope.elapsed, 0.5);
  near(scope.unscaledElapsed, 0.75);
  near(scope.delta, 0.5);
  assert.equal(scope.frame, 1);
});

// ---------------------------------------------------------------------------
console.log("\ntime — engine and script wiring");
// ---------------------------------------------------------------------------

// Source-level, because instantiating an Engine needs a WebGPU device. These
// four lines are the entire safety story for script timers, and each of them
// is one edit away from being silently dropped.
const engineSrc = readFileSync(
  fileURLToPath(new URL("../src/engine/Engine.js", import.meta.url)), "utf8",
);
const scriptSrc = readFileSync(
  fileURLToPath(new URL("../src/engine/components/ScriptComponent.js", import.meta.url)), "utf8",
);

check("the engine ticks time before any update callback", () => {
  // A timer due this frame must have had its effect before scripts look at the
  // world, or every timed event in the game is observed a frame late.
  const tickAt = engineSrc.indexOf("this.time.update(dt, unscaled)");
  const callbacksAt = engineSrc.indexOf("for (const fn of this.updateCallbacks)");
  assert.ok(tickAt > 0, "Engine never ticks engine.time");
  assert.ok(callbacksAt > 0, "update callbacks not found");
  assert.ok(tickAt < callbacksAt, "time.update must run before the update callbacks");
});

check("Stop and dispose both clear pending timers", () => {
  // A wave spawner scheduled on the last frame of Play would otherwise fire
  // into the editor's authoring scene seconds after Stop.
  const clears = engineSrc.match(/this\.time\.clear\(\)/g) ?? [];
  assert.ok(clears.length >= 2, `expected clear() on both Stop and dispose, found ${clears.length}`);
});

check("scripts are bound a SCOPED time, not the raw system", () => {
  assert.ok(
    /instance\.time = this\.entity\.engine\.time\.scope\(instance\)/.test(scriptSrc),
    "ScriptComponent must hand scripts a scope keyed to the instance",
  );
});

check("a script's timers are cancelled when it stops or is destroyed", () => {
  // Both paths matter: #reconcileSlotRunning covers disable/Stop, #stopSlot
  // covers removal and hot reload. Missing either leaves callbacks running
  // against a dead script — the leak this whole design exists to prevent.
  const cancels = scriptSrc.match(/time\?\.cancelAll\?\.\(\)/g) ?? [];
  assert.ok(cancels.length >= 2, `expected cancelAll on both stop paths, found ${cancels.length}`);
});

check("the typed surface declares both halves of engine.time", () => {
  const dts = readFileSync(
    fileURLToPath(new URL("../src/engine/script-types/engine.d.ts", import.meta.url)), "utf8",
  );
  const api = dts.match(/export interface TimerAPI \{([\s\S]*?)\n  \}/);
  assert.ok(api, "TimerAPI not declared");
  // Every public scheduling method must be typed, or a script calling it gets
  // `any` under skipLibCheck and no autocomplete.
  const system = new TimeSystem();
  const methods = ["after", "every", "afterReal", "everyReal", "afterFrames", "everyFrames",
    "delay", "realDelay", "frames", "nextFrame", "isActive", "cancel"];
  for (const name of methods) {
    assert.equal(typeof system[name], "function", `TimeSystem is missing ${name}`);
    assert.ok(new RegExp(`\\b${name}\\(`).test(api[1]), `TimerAPI does not declare ${name}`);
  }
  // And the clocks, on both the system and the script-facing scope.
  for (const block of ["TimeSystem", "TimerScope"]) {
    const found = dts.match(new RegExp(`export interface ${block} extends[\\s\\S]*?\\n  \\}`));
    assert.ok(found, `${block} not declared`);
    for (const field of ["delta", "unscaledDelta", "elapsed", "unscaledElapsed", "frame", "scale", "paused"]) {
      assert.ok(new RegExp(`\\b${field}:`).test(found[0]), `${block} does not declare ${field}`);
    }
  }
  assert.ok(/readonly time: TimeSystem;/.test(dts), "engine.time is not typed");
  assert.ok(/time: TimerScope;/.test(dts), "this.time is not typed on Script");
});

// ---------------------------------------------------------------------------
console.log("\ntime — allocation and scaling");
// ---------------------------------------------------------------------------

check("an idle frame costs the same with 20,000 pending timers as with none", () => {
  // The whole point of the heap and the wheel. A per-frame scan would show a
  // ratio in the hundreds here; the structures make it a rounding error.
  const empty = new TimeSystem();
  const loaded = new TimeSystem();
  for (let i = 0; i < 20_000; i++) loaded.after(1000 + i, () => {});

  const once = (time) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i++) time.update(1 / 60, 1 / 60);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // Warm BOTH before timing EITHER, and take the best of three. Measuring the
  // empty system first (as this originally did) charged it for the whole
  // JIT warm-up and reported it as slower than the loaded one — a benchmark
  // that says the opposite of the truth is worse than none.
  const measure = (time) => {
    once(time);
    return Math.min(once(time), once(time), once(time));
  };
  once(empty);
  once(loaded);
  const emptyMs = measure(empty);
  const loadedMs = measure(loaded);
  const ratio = loadedMs / Math.max(emptyMs, 0.01);
  assert.ok(ratio < 8, `20k pending timers made an idle frame ${ratio.toFixed(1)}x slower`);
  console.log(`       (idle frame: ${emptyMs.toFixed(2)}ms empty vs ${loadedMs.toFixed(2)}ms with 20k pending)`);
});

check("scheduling a callback timer allocates no per-timer object", () => {
  // Handles are integers precisely so the common case is allocation-free. If
  // this ever returns an object, the hot path has quietly regressed.
  const time = new TimeSystem();
  const id = time.after(1, () => {});
  assert.equal(typeof id, "number", "handles must stay primitive");
  assert.ok(Number.isSafeInteger(id), "handles must stay safe integers");
});

check("100k schedule/fire cycles keep the pool bounded", () => {
  // Slots must be recycled, not leaked: a shooter schedules and retires timers
  // for the whole session, and a pool that only grows is a slow memory leak.
  const time = new TimeSystem();
  for (let round = 0; round < 1000; round++) {
    for (let i = 0; i < 100; i++) time.after(0.001, () => {});
    time.update(0.01, 0.01);
  }
  assert.equal(time.pending, 0);
  // 100 live at a time, so the backing arrays should be near that, not 100k.
  assert.ok(time._capacity <= 1024, `pool grew to ${time._capacity} slots for 100 concurrent timers`);
});

// ---------------------------------------------------------------------------
console.log("\ntime — awaitable form");
// ---------------------------------------------------------------------------

checkAsync("await delay() resolves true once the time has passed", async () => {
  const time = new TimeSystem();
  let done = null;
  const promise = time.delay(0.1).then((value) => { done = value; });
  run(time, 5);
  await Promise.resolve();
  assert.equal(done, null, "resolved early");
  run(time, 2);
  await promise;
  assert.equal(done, true);
});

checkAsync("await frames() waits whole frames", async () => {
  const time = new TimeSystem();
  const at = [];
  const promise = time.frames(3).then(() => at.push(time.frame));
  run(time, 3);
  await promise;
  assert.deepEqual(at, [3]);
});

checkAsync("nextFrame resolves on the very next update", async () => {
  const time = new TimeSystem();
  let resolved = false;
  const promise = time.nextFrame().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  run(time, 1);
  await promise;
  assert.equal(resolved, true);
});

checkAsync("a cancelled await RESOLVES false rather than hanging or rejecting", async () => {
  // Rejecting would make every unguarded `await` an unhandled rejection;
  // never settling would silently skip the `finally` people clean up in.
  const time = new TimeSystem();
  const scope = time.scope({});
  let outcome = "pending";
  let ranFinally = false;
  const task = (async () => {
    try {
      outcome = (await scope.delay(10)) ? "elapsed" : "cancelled";
    } finally {
      ranFinally = true;
    }
  })();
  scope.cancelAll();
  await task;
  assert.equal(outcome, "cancelled");
  assert.ok(ranFinally, "finally must still run");
});

checkAsync("a cancelled await settles immediately, not at its due time", async () => {
  const time = new TimeSystem();
  const id = time.delay(1000);
  let settled = false;
  const promise = id.then(() => { settled = true; });
  time.clear();
  await promise;
  assert.equal(settled, true);
});

checkAsync("realDelay ignores pause while delay does not", async () => {
  const time = new TimeSystem();
  let game = "pending";
  let real = "pending";
  const a = time.delay(0.1).then((v) => { game = v; });
  const b = time.realDelay(0.1).then((v) => { real = v; });
  run(time, 60, 0, 1 / 60); // paused
  await b;
  assert.equal(real, true);
  assert.equal(game, "pending", "game clock advanced while paused");
  run(time, 10, 1 / 60, 1 / 60);
  await a;
  assert.equal(game, true);
});

// ---------------------------------------------------------------------------
const finish = async () => {
  for (const [name, fn] of asyncChecks) {
    checks++;
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${error.message.split("\n")[0]}`);
    }
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
};

await finish();
