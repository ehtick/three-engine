/**
 * Shared per-frame CPU budget for background generation work — the World
 * plan driver, the Terrain's own procedural fill, and the foliage shader
 * warmup queue all used to slice their work with a FIXED 6 ms clock, sized
 * for an ordinary 60 fps frame.
 *
 * That fixed budget starves every one of them during boot: the freeze ledger
 * shows the main thread blocked only ~19 s while `profile.boot` shows the
 * scene still adding materials 60-160 s after load, because a boot frame is
 * 100-200 ms long (the GPU process compiling shaders), and a 6 ms slice is a
 * sliver of that — 2-4 s of real CPU work stretched over minutes waiting for
 * a `requestAnimationFrame` that is itself gated behind the compile. A
 * SLOWER frame means the GPU, not the CPU, owns it — a longer CPU slice
 * inside that same frame costs nothing visible. A budget sized off the
 * ACTUAL last frame interval buys that back automatically, and falls back to
 * the old fixed floor once frames are fast again (interactive editing).
 *
 * Lives here, not in `scheduling.js` or a `world`/`foliage` module, so both
 * can import it without creating a cycle between them.
 */

/** Never less than the old fixed slice, so a fast frame keeps its old cost. */
const MIN_SLICE_MS = 6;
/** Never so much that one slice alone could read as the freeze this exists
 *  to fix, however long the driving frame was. */
const MAX_SLICE_MS = 40;
/** How much of the last frame's own interval a slice may spend. */
const FRAME_FRACTION = 0.5;

/**
 * `clamp(0.5 x lastFrameIntervalMs, 6, 40)`.
 *
 * `engine.unscaledDeltaTime` is the real wall-clock gap between the last two
 * frames — before `timeScale`/pause — in seconds, which is exactly "how long
 * did the frame the caller is currently inside of take last time": the
 * signal that says whether the GPU is busy. A missing or non-finite engine
 * (no render loop yet, a bare Node test harness) resolves to the floor,
 * matching every caller's old fixed default exactly.
 */
export function frameSliceBudget(engine) {
  const intervalMs = Number.isFinite(engine?.unscaledDeltaTime) ? engine.unscaledDeltaTime * 1000 : 0;
  return Math.min(MAX_SLICE_MS, Math.max(MIN_SLICE_MS, intervalMs * FRAME_FRACTION));
}
