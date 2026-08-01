/**
 * Game time control (Engine.timeScale / paused / step).
 *
 * Pause menus, slow motion, hitstop and frame-stepping all come down to one
 * question: what exactly does an update callback receive this frame? These
 * checks drive the real `#tick` through a stubbed renderer animation loop and
 * assert on the delta that comes out the other side.
 */
import assert from "node:assert/strict";

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");
registerBuiltInComponents();

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

/**
 * An engine whose clock we drive by hand. `THREE.Timer.getDelta` reads its own
 * internal clock, so the tick is pumped through a stubbed timer — the point is
 * to test the scaling logic, not three's stopwatch.
 */
function harness() {
  const engine = new Engine();
  let raw = 1 / 60;
  engine.timer = { update() {}, getDelta: () => raw };
  const seen = [];
  engine.onUpdate((dt) => seen.push(dt));
  // #tick is private; the animation loop is what calls it. `start()` hands the
  // callback to the renderer, so stub just enough renderer to capture it.
  let tick = null;
  engine.renderer = { setAnimationLoop: (fn) => (tick = fn), domElement: {}, compute() {} };
  engine.audio = { update() {}, ensureContext: async () => {}, resumeIfNeeded() {}, dispose() {} };
  engine.start();
  return {
    engine,
    seen,
    setRawDelta: (value) => (raw = value),
    frame: (n = 1) => {
      for (let i = 0; i < n; i++) tick();
    },
  };
}

console.log("game time");

check("delta passes through unscaled by default", () => {
  const h = harness();
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 60);
  assert.equal(h.engine.timeScale, 1);
  assert.equal(h.engine.deltaTime, 1 / 60);
  assert.equal(h.engine.unscaledDeltaTime, 1 / 60);
});

check("timeScale scales the update delta", () => {
  const h = harness();
  h.engine.setTimeScale(0.5);
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 120, "half speed");
  h.engine.setTimeScale(2);
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 30, "double speed");
});

check("timeScale 0 freezes game time but still ticks callbacks", () => {
  const h = harness();
  h.engine.setTimeScale(0);
  h.frame(3);
  assert.equal(h.seen.length, 3, "callbacks still run — Update at timeScale 0 is Unity's semantics");
  assert.ok(h.seen.every((dt) => dt === 0), `expected all zero, got ${h.seen}`);
});

check("unscaled delta and elapsed time keep running regardless", () => {
  const h = harness();
  h.engine.setTimeScale(0.25);
  h.frame(4);
  assert.equal(h.engine.unscaledDeltaTime, 1 / 60, "wall clock is unaffected");
  assert.ok(Math.abs(h.engine.unscaledElapsedTime - 4 / 60) < 1e-9, "wall-clock elapsed");
  assert.ok(Math.abs(h.engine.elapsedTime - 1 / 60) < 1e-9, "game elapsed ran at a quarter speed");
});

check("negative time scales are refused rather than running the game backwards", () => {
  const h = harness();
  h.engine.setTimeScale(-2);
  assert.equal(h.engine.timeScale, 0);
});

check("paused freezes the update delta", () => {
  const h = harness();
  h.engine.setPaused(true);
  h.frame(3);
  assert.ok(h.seen.every((dt) => dt === 0), `expected all zero, got ${h.seen}`);
  assert.equal(h.engine.unscaledDeltaTime, 1 / 60, "the frame still happened");
  h.engine.setPaused(false);
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 60, "resumes at full speed");
});

check("step advances exactly one fixed frame while paused", () => {
  const h = harness();
  h.engine.setPaused(true);
  h.frame(2);
  h.engine.step();
  h.frame();
  assert.equal(h.seen.at(-1), h.engine.stepDeltaTime, "the stepped frame got a fixed slice");
  h.frame();
  assert.equal(h.seen.at(-1), 0, "and only one frame was released");
});

check("step(n) releases n frames", () => {
  const h = harness();
  h.engine.setPaused(true);
  h.engine.step(3);
  h.frame(5);
  const advanced = h.seen.filter((dt) => dt > 0);
  assert.equal(advanced.length, 3, `expected 3 advancing frames, got ${h.seen}`);
});

check("step is a no-op when not paused", () => {
  const h = harness();
  h.engine.step(5);
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 60, "a running game just keeps running");
});

check("unpausing discards queued steps", () => {
  const h = harness();
  h.engine.setPaused(true);
  h.engine.step(4);
  h.engine.setPaused(false);
  h.engine.setPaused(true);
  h.frame(2);
  assert.ok(h.seen.every((dt) => dt === 0), "the old step queue did not leak through");
});

check("a long stall is clamped instead of tunnelling physics", () => {
  const h = harness();
  h.setRawDelta(3.2); // tab was backgrounded for three seconds
  h.frame();
  assert.equal(h.seen.at(-1), h.engine.maxDeltaTime, "clamped to maxDeltaTime");
  assert.equal(h.engine.unscaledDeltaTime, h.engine.maxDeltaTime);
});

check("Stop restores normal time — a paused game can't freeze the editor", () => {
  const h = harness();
  h.engine.setPlaying(true);
  h.engine.setTimeScale(0.1);
  h.engine.setPaused(true);
  h.engine.setPlaying(false);
  assert.equal(h.engine.timeScale, 1);
  assert.equal(h.engine.paused, false);
  h.frame();
  assert.equal(h.seen.at(-1), 1 / 60, "the editor viewport runs at full speed again");
});

check("time changes emit events the editor can listen to", () => {
  const h = harness();
  const events = [];
  h.engine.on("time-scale-changed", (v) => events.push(["scale", v]));
  h.engine.on("paused-changed", (v) => events.push(["paused", v]));
  h.engine.setTimeScale(0.5);
  h.engine.setTimeScale(0.5); // no-op, must not re-emit
  h.engine.setPaused(true);
  assert.deepEqual(events, [["scale", 0.5], ["paused", true]]);
});

// ---------------------------------------------------------------------------
// The GPU particle sim runs on game time too. It used to integrate against
// TSL's built-in `deltaTime` — the renderer's own frame time, which knows
// nothing about timeScale or paused — so particles kept erupting through a
// pause menu and ignored bullet time. ParticleComponent now writes
// `engine.deltaTime` into a uniform each frame; these check that it does.
// ---------------------------------------------------------------------------
const asyncCheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

async function particleHarness() {
  const h = harness();
  const entity = h.engine.createEntity({ name: "Particles" });
  entity.addComponent("particles", {});
  // The graph compiles asynchronously (TSL node construction, no GPU needed).
  const component = entity.getComponent("particles");
  for (let i = 0; i < 100 && !component.subsystems?.[0]?.simDelta; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { ...h, simDelta: () => component.subsystems?.[0]?.simDelta };
}

await asyncCheck("the particle sim delta follows game time", async () => {
  const h = await particleHarness();
  assert.ok(h.simDelta(), "the subsystem exposes a sim-delta uniform");
  h.frame();
  assert.ok(Math.abs(h.simDelta().value - 1 / 60) < 1e-9, `full speed, got ${h.simDelta().value}`);

  h.engine.setTimeScale(0.25);
  h.frame();
  assert.ok(Math.abs(h.simDelta().value - 1 / 240) < 1e-9, `quarter speed, got ${h.simDelta().value}`);
});

await asyncCheck("pausing freezes the particle sim", async () => {
  const h = await particleHarness();
  h.engine.setPaused(true);
  h.frame(2);
  assert.equal(h.simDelta().value, 0, "particles stop dead while the game is paused");
  h.engine.step();
  h.frame();
  assert.equal(h.simDelta().value, h.engine.stepDeltaTime, "and advance one slice on step");
});

await asyncCheck("a stalled frame does not teleport particles", async () => {
  const h = await particleHarness();
  h.setRawDelta(3.2);
  h.frame();
  assert.ok(h.simDelta().value <= 0.1, `clamped, got ${h.simDelta().value}`);
});

console.log(failures ? `\n${failures} failing` : "\nall game time checks passed");
process.exit(failures ? 1 : 0);
