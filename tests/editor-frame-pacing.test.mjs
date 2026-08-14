import test from "node:test";
import assert from "node:assert/strict";
import { editorFrameRateFor } from "../src/editor/editorFramePacing.js";

test("editor frame pacing leaves cheap and play-mode frames uncapped", () => {
  assert.equal(editorFrameRateFor(10), 0);
  assert.equal(editorFrameRateFor(60, { playing: true }), 0);
});

test("editor frame pacing yields progressively more time for expensive frames", () => {
  assert.equal(editorFrameRateFor(25), 30);
  assert.equal(editorFrameRateFor(50), 20);
  assert.equal(editorFrameRateFor(25, { interacting: true }), 15);
});

test("a direct viewport gesture is never capped, whatever the frame costs", () => {
  assert.equal(editorFrameRateFor(50, { gesture: true }), 0);
  assert.equal(editorFrameRateFor(25, { interacting: true, gesture: true }), 0);
});
