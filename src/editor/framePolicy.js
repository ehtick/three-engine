// @ts-check
/**
 * The editor's frame-rate policy, on its own so it can be checked headlessly.
 *
 * `editorFramePacing.js` imports the live engine at module scope, which drags
 * three.js and a WebGPU renderer behind it — fine in a browser, impossible in a
 * node test. The decision itself is arithmetic and deserves to be provable.
 */

/** What a viewport nobody is looking at is worth per second. Not zero: a
 *  visible-but-unfocused viewport that freezes reads as a crash, and a scene
 *  still settling (GI converging, a bake finishing) should be seen to settle.
 *  Low enough that a 60ms frame costs 6% of the budget instead of all of it. */
export const UNFOCUSED_FPS = 8;

/**
 * @param {number} workMs how long the last frame's GPU/CPU work took
 * @param {{ interacting?: boolean, playing?: boolean, focused?: boolean }} [state]
 *   `focused` is whether the viewport is the dock panel the user is working in.
 *   It dominates every other input except Play: a heavy scene rendering at full
 *   rate behind a paint canvas or a node graph is the single biggest source of
 *   "the whole editor is laggy", and it buys nothing while the pointer is
 *   somewhere else entirely.
 * @returns {number} an fps cap, or 0 for uncapped
 */
export function editorFrameRateFor(workMs, { interacting = false, playing = false, focused = true } = {}) {
  if (playing) return 0;
  if (!focused) return UNFOCUSED_FPS;
  if (!(workMs > 0)) return 0;
  if (interacting && workMs >= 14) return 15;
  if (workMs >= 42) return 20;
  if (workMs >= 24) return 30;
  return 0;
}
