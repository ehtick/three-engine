// The world's async generation used to slice itself on a FIXED 6 ms clock —
// sized for a 60 fps frame — while a boot frame runs 100-200 ms because the
// GPU process is compiling shaders. A fixed slice then starves the driver to
// a sliver of a much longer frame, stretching 2-4 s of real CPU work over
// minutes (docs/WORLD_PRODUCTION_PLAN.md; the owner's "world builds for like
// 2 minutes" report). `frameSliceBudget` sizes the slice off the ACTUAL last
// frame interval instead, so a slow (GPU-bound) frame buys a longer CPU
// slice for free, and a fast frame keeps the original floor.
import test from "node:test";
import assert from "node:assert/strict";
import { frameSliceBudget } from "../src/engine/frameSlice.js";
import { prepareWorldPlanAsync } from "../src/modules/world/worldPlan.js";
import { createWorldDocument } from "../src/engine/world/worldDocument.js";

test("frameSliceBudget clamps to [6, 40] at half the last frame interval", () => {
  assert.equal(frameSliceBudget(undefined), 6, "no engine at all: the old fixed floor");
  assert.equal(frameSliceBudget({}), 6, "no unscaledDeltaTime yet: the floor");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0 }), 6, "a zero interval: the floor");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: Number.NaN }), 6, "a non-finite interval falls back to the floor");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.008 }), 6, "an 8 ms frame halves to 4 ms, floored at 6");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.012 }), 6, "exactly at the floor (12 ms halves to 6 ms)");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.016 }), 8, "a 16 ms (60 fps) frame halves to 8 ms");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.05 }), 25, "a 50 ms frame halves to 25 ms, inside the band");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.08 }), 40, "an 80 ms frame halves to exactly the 40 ms cap");
  assert.equal(frameSliceBudget({ unscaledDeltaTime: 0.2 }), 40, "a 200 ms boot frame is capped at 40, never handed the whole half");
});

/** A real procedural World (the same fixture `world-runtime.test.mjs` uses)
 *  so the driver actually has ~2 s of CPU work to slice — see the "measured
 *  worst block" receipt in the World memory notes for a 128 m generation. */
function fixtureDocument() {
  return createWorldDocument({
    surfaceMode: "procedural", sky: "off", forestDensity: 0, groundDensity: 0,
    layout: { mode: "procedural" }, settlement: { editableBuildings: false }, seed: 894,
  });
}

test("prepareWorldPlanAsync takes fewer real-time yields at a long-frame budget than a short-frame one", async () => {
  const runWithFrameInterval = async (frameIntervalMs) => {
    let yields = 0;
    const plan = await prepareWorldPlanAsync(fixtureDocument(), {}, {
      // A fake clock standing in for `engine.unscaledDeltaTime`: every slice
      // asks `frameSliceBudget` fresh, exactly as `WorldComponent._generate`
      // does with the real engine.
      budget: () => frameSliceBudget({ unscaledDeltaTime: frameIntervalMs / 1000 }),
      // No real delay — only the yield COUNT is under test, not wall time.
      defer: () => { yields++; return Promise.resolve(); },
    });
    plan.dispose();
    return yields;
  };
  const fastFrameYields = await runWithFrameInterval(8); // an ordinary 60fps-ish frame: floors at 6ms
  const slowFrameYields = await runWithFrameInterval(120); // a GPU-compiling boot frame: caps at 40ms
  assert.ok(fastFrameYields > 0, "a real ~128m generation at a 6ms slice actually yields at least once");
  assert.ok(
    slowFrameYields < fastFrameYields,
    `a long boot frame (40ms slices) must yield fewer times than a short one (6ms slices): ${slowFrameYields} vs ${fastFrameYields}`,
  );
});
