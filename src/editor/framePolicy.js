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
 * A viewport nobody is looking at can be pure cost: a heavy scene rendering
 * behind a paint canvas or a node graph makes the WHOLE editor lag and is buying
 * nothing. Throttling it to a few frames a second was not enough — one 60ms
 * frame still lands in the middle of a brush stroke — so when the user opts in,
 * an unfocused viewport stops completely and `editorFramePacing` wakes it when
 * something it draws actually changes. That keeps the picture honest without
 * holding a render loop open for a panel nobody is looking at.
 *
 * Play is the exception and always will be: the game is the thing being watched
 * even when the pointer is in the Inspector.
 *
 * `freeze` is the user's preference (Project Settings → Editor, on by default —
 * see `viewportFreeze.js`). It is a plain parameter here rather than a read of
 * that module so this stays a pure function; the default below is "don't
 * suspend", the conservative answer for a caller that didn't say. A hidden
 * viewport still stops either way: an element with no box on screen cannot be
 * being watched, whatever the preference says.
 */
export function shouldSuspendViewport({
  playing = false,
  visible = true,
  focused = true,
  freeze = false,
} = {}) {
  if (playing) return false;
  if (!visible) return true;
  return freeze && !focused;
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
