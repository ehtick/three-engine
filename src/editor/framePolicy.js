// @ts-check
/**
 * The editor's viewport-rendering policy, on its own so it can be checked
 * headlessly.
 *
 * `editorFramePacing.js` imports the live engine at module scope, which drags
 * three.js and a WebGPU renderer behind it — fine in a browser, impossible in a
 * node test. The decisions themselves are arithmetic and deserve to be provable.
 */

/**
 * Whether the viewport should render at all.
 *
 * A viewport nobody is looking at is pure cost: a heavy scene rendering behind
 * a paint canvas or a node graph makes the WHOLE editor lag and is buying
 * nothing. Throttling it to a few frames a second was not enough — one 60ms
 * frame still lands in the middle of a brush stroke — so an unfocused viewport
 * stops completely, and `editorFramePacing` wakes it for a SINGLE frame when
 * something it draws actually changes. That keeps the picture honest without
 * holding a render loop open for a panel nobody is looking at.
 *
 * Play is the exception and always will be: the game is the thing being watched
 * even when the pointer is in the Inspector.
 */
export function shouldSuspendViewport({ playing = false, visible = true, focused = true } = {}) {
  if (playing) return false;
  return !visible || !focused;
}

/**
 * The frame-rate cap for a viewport that IS rendering, or 0 for uncapped.
 *
 * This is about sharing the main thread during heavy work, not about idleness:
 * an idle scene runs uncapped because capping it buys nothing and costs
 * smoothness while orbiting.
 *
 * @param {number} workMs how long the last frame's GPU/CPU work took
 * @param {{ interacting?: boolean, playing?: boolean }} [state]
 * @returns {number} an fps cap, or 0 for uncapped
 */
export function editorFrameRateFor(workMs, { interacting = false, playing = false } = {}) {
  if (playing || !(workMs > 0)) return 0;
  if (interacting && workMs >= 14) return 15;
  if (workMs >= 42) return 20;
  if (workMs >= 24) return 30;
  return 0;
}
