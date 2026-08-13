/**
 * `engine.stats` — the performance readout behind the viewport's Stats overlay.
 *
 *   node scripts/run-stats-test.mjs
 *
 * No browser and no dev server: StatsSystem imports nothing and takes its
 * timestamps as arguments, which is what lets the frame-rate maths be checked
 * against hand-written frame timelines in plain Node.
 *
 * ## What is actually being gated
 *
 * One bug, and it was a bad one: the overlay reported ~70 fps for a viewport
 * that was visibly crawling. Two independent causes, both pinned here.
 *
 *   1. FPS was an EMA of `1000 / dt` — the mean of instantaneous RATES. By
 *      Jensen's inequality that is always >= the true rate, and the gap grows
 *      with variance, so the reading was most inflated during exactly the
 *      stutter it was supposed to expose. The checks below feed timelines
 *      whose true rate is known and assert the counter reports it.
 *
 *   2. The counter ticked in the UPDATE phase, before the render block, so
 *      every path that returned without drawing (a resize drain, GI's
 *      `renderSuspended` compile wave) still scored a frame. A frozen canvas
 *      reported the display's refresh rate.
 *
 * Plus a drift guard: every field the runtime puts in `readout` must be
 * declared in `PerfReadout` in `script-types/engine.d.ts`. Scripts read these
 * counters, and an undeclared field is silently `any` under `skipLibCheck` —
 * nothing else in the repo catches that.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StatsSystem } from "../src/engine/StatsSystem.js";

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

/** A StatsSystem with no engine behind it — none of this touches the renderer. */
const makeStats = () => new StatsSystem({ renderer: null });

/** Replays a list of frame durations as presents, returning the end time. */
const present = (stats, frameMs, start = 1000) => {
  let t = start;
  for (const ms of frameMs) {
    t += ms;
    stats.recordPresentedFrame(t);
  }
  return t;
};

/** What the old implementation would have said, for the contrast checks. */
const emaOfInstantRates = (frameMs, alpha = 1 / 30) => {
  let fps = 0;
  for (const ms of frameMs) {
    const instant = 1000 / Math.max(ms, 1);
    fps = fps === 0 ? instant : alpha * instant + (1 - alpha) * fps;
  }
  return fps;
};

// ---------------------------------------------------------------------------
console.log("\nstats — the frame rate is a count, not an average of rates");
// ---------------------------------------------------------------------------

check("a steady 60 fps second reads 60", () => {
  const stats = makeStats();
  const frames = Array.from({ length: 60 }, () => 1000 / 60);
  const end = present(stats, frames);
  assert.equal(stats.sample(end).fps, 60);
});

check("a steady 20 fps second reads 20, not the tick rate", () => {
  const stats = makeStats();
  const end = present(stats, Array.from({ length: 20 }, () => 50));
  assert.equal(stats.sample(end).fps, 20);
});

check("a stuttering second reports its true rate, not the inflated average", () => {
  // 45 fast frames with a 110 ms stall dropped in every tenth — 50 frames
  // spanning exactly 1000 ms, so the honest answer is 50 fps. This is what
  // "the viewport is hitching" actually looks like in a frame timeline.
  const frames = Array.from({ length: 50 }, (_, i) => (i % 10 === 4 ? 110 : 10));
  const total = frames.reduce((a, b) => a + b, 0);
  assert.equal(total, 1000, "timeline must span exactly the window");

  const stats = makeStats();
  const end = present(stats, frames);
  const counted = stats.sample(end).fps;
  assert.equal(counted, 50, `counted ${counted}`);

  // The regression this file exists for: the previous maths, on this same
  // timeline, was not merely noisy — it read ~93 for a 50 fps second, which is
  // the shape of the original report ("lagging hard, shows 70").
  const old = emaOfInstantRates(frames);
  assert.ok(old > counted * 1.8, `old estimate ${old.toFixed(1)} should overstate 50`);
});

check("one long hitch among fast frames does not read as fast", () => {
  // 4 frames in 75 ms is 53 fps. Averaging 200, 200, 200 and 16.7 says ~154.
  const frames = [5, 5, 5, 60];
  const stats = makeStats();
  const end = present(stats, frames);
  // All four land inside the window, so the count is 4 — and the point is that
  // it is 4 and not "154 fps worth of frames".
  assert.equal(stats.sample(end).fps, 4);
  assert.ok(emaOfInstantRates(frames) > 100, "old maths really did claim >100");
});

// ---------------------------------------------------------------------------
console.log("\nstats — a tick that does not draw is not a frame");
// ---------------------------------------------------------------------------

check("skipped frames stay out of the fps count", () => {
  // The GI compile wave: the loop runs at full speed, the canvas holds one
  // image. FPS must be 0 — this is the number that used to read ~70.
  const stats = makeStats();
  let t = 1000;
  for (let i = 0; i < 70; i++) {
    t += 1000 / 70;
    stats.recordSkippedFrame(t);
  }
  const r = stats.sample(t);
  assert.equal(r.fps, 0, `fps ${r.fps}`);
  assert.equal(r.skippedFps, 70, `skippedFps ${r.skippedFps}`);
});

check("a half-drawing loop reports both halves", () => {
  const stats = makeStats();
  let t = 1000;
  for (let i = 0; i < 60; i++) {
    t += 1000 / 60;
    if (i % 2 === 0) stats.recordPresentedFrame(t);
    else stats.recordSkippedFrame(t);
  }
  const r = stats.sample(t);
  assert.equal(r.fps, 30);
  assert.equal(r.skippedFps, 30);
});

check("the update tick alone never advances the frame count", () => {
  // _tick() is an onUpdate callback: it runs whether or not the frame draws.
  // If it could still count frames, the whole fix would be undone.
  const stats = makeStats();
  for (let i = 0; i < 30; i++) stats._tick();
  assert.equal(stats.readout.fps, 0);
  assert.ok(stats.readout.frameMs >= 0, "frameMs is still measured");
});

// ---------------------------------------------------------------------------
console.log("\nstats — the window ends at read time");
// ---------------------------------------------------------------------------

check("a stopped loop decays to zero instead of holding its last reading", () => {
  // The editor suspends an unfocused viewport outright. Nothing ticks, so a
  // counter refreshed only from inside the loop would show 60 fps forever.
  const stats = makeStats();
  const end = present(stats, Array.from({ length: 60 }, () => 1000 / 60));
  assert.equal(stats.sample(end).fps, 60);
  assert.equal(stats.sample(end + 500).fps, 30, "half the window has aged out");
  assert.equal(stats.sample(end + 1001).fps, 0, "a full window of silence is 0 fps");
});

check("the live getters sample rather than echo the last tick", () => {
  const stats = makeStats();
  // Anchored to the real clock, five seconds back: the getters take no
  // timestamp, so this is the only way to hand them an aged-out timeline.
  const start = performance.now() - 5000;
  const end = present(stats, Array.from({ length: 24 }, () => 1000 / 24), start);
  for (let i = 0; i < 24; i++) stats.recordSkippedFrame(start + i * 10);
  stats.sample(end);
  assert.equal(stats.readout.fps, 24, "the readout holds what the last sample counted");
  // The getters recount against NOW, where all of it has aged out. A field
  // that only refreshed on tick would still be claiming 24 fps here.
  assert.equal(stats.fps, 0);
  assert.equal(stats.skippedFps, 0);
});

check("stamps older than the window are dropped, not averaged in", () => {
  const stats = makeStats();
  // A busy second, then a slow one. Only the slow one is in view.
  let t = present(stats, Array.from({ length: 100 }, () => 10));
  t = present(stats, Array.from({ length: 10 }, () => 100), t);
  assert.equal(stats.sample(t).fps, 10);
});

check("the ring holds a full second of a high-refresh display", () => {
  // 240 Hz is a real monitor; the count must not wrap or truncate there.
  const stats = makeStats();
  const end = present(stats, Array.from({ length: 240 }, () => 1000 / 240));
  assert.equal(stats.sample(end).fps, 240);
});

// ---------------------------------------------------------------------------
console.log("\nstats — load percentages and the rest of the readout");
// ---------------------------------------------------------------------------

check("cpuLoadPct saturates at 100 rather than reporting 300%", () => {
  const stats = makeStats();
  // Wind the clock back so the next tick sees a 50 ms frame. `performance.now()`
  // is measured from process start, so this needs the process to be at least
  // 50 ms old — otherwise `_lastTickStart` goes negative, `_tick`'s
  // "have we ticked before" guard reads it as "no", and frameMs stays 0. That
  // is a flake in the test, not the system: it depended on how fast Node
  // reached this line.
  while (performance.now() < 60) { /* spin briefly on a very fast start */ }
  stats._tick();
  stats._lastTickStart -= 50; // pretend the previous tick was 50 ms ago
  stats._tick();
  assert.ok(stats.readout.frameMs >= 50, `frameMs ${stats.readout.frameMs}`);
  assert.equal(stats.readout.cpuLoadPct, 100);
});

check("real GPU time wins over submit time when the adapter provides it", () => {
  const stats = makeStats();
  stats.recordRenderMs(2);
  stats.recordGpuMs(33);
  stats._tick();
  assert.equal(stats.readout.renderMs, 2, "submit time is still reported");
  assert.ok(stats.readout.gpuMs > 0);
  // 33 ms of GPU work saturates a 16.7 ms budget; 2 ms of submit would not.
  assert.equal(stats.readout.gpuLoadPct, 100);
});

check("recordRenderInfo survives an engine with no renderer", () => {
  const stats = makeStats();
  stats.recordRenderInfo();
  assert.equal(stats.readout.drawCalls, 0);
});

check("recordRenderInfo copies three's per-frame counters", () => {
  const stats = new StatsSystem({
    renderer: {
      info: { render: { drawCalls: 412, triangles: 91_000 }, memory: { texturesSize: 1024 } },
    },
    renderScale: 0.75,
  });
  stats.recordRenderInfo();
  assert.equal(stats.readout.drawCalls, 412);
  assert.equal(stats.readout.triangles, 91_000);
  assert.equal(stats.readout.textureMem, 1024);
  assert.equal(stats.readout.renderScale, 0.75);
});

// ---------------------------------------------------------------------------
console.log("\nstats — script type surface");
// ---------------------------------------------------------------------------

const dts = readFileSync(
  fileURLToPath(new URL("../src/engine/script-types/engine.d.ts", import.meta.url)),
  "utf8",
);

check("every readout field is declared in PerfReadout", () => {
  const block = dts.match(/export interface PerfReadout \{([\s\S]*?)\n  \}/);
  assert.ok(block, "PerfReadout interface not found in engine.d.ts");
  const missing = Object.keys(makeStats().readout).filter(
    (key) => !new RegExp(`\\breadonly ${key}\\b`).test(block[1]),
  );
  assert.equal(missing.length, 0, `undeclared: ${missing.join(", ")}`);
});

check("PerfStats exposes the ergonomic surface scripts are told to use", () => {
  const block = dts.match(/export interface PerfStats \{([\s\S]*?)\n  \}/);
  assert.ok(block, "PerfStats interface not found in engine.d.ts");
  for (const member of ["fps", "skippedFps", "sample()", "readout"]) {
    assert.ok(block[1].includes(member), `PerfStats is missing ${member}`);
  }
  const stats = makeStats();
  assert.equal(typeof stats.fps, "number");
  assert.equal(typeof stats.skippedFps, "number");
  assert.equal(typeof stats.sample, "function");
});

check("engine.stats is typed as PerfStats, not a bag of numbers", () => {
  assert.ok(
    /readonly stats: PerfStats;/.test(dts),
    "Engine.stats should be PerfStats so scripts get real field names",
  );
});

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
