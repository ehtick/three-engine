/**
 * Built-in per-engine performance sampler. Lives on the engine itself
 * (not as a registered module) — every engine instance has one, the editor
 * never has to "enable" anything, and built games can ignore the readout
 * without paying for a feature flag.
 *
 * What it measures, every frame:
 *
 *   fps         — frames the renderer actually PRESENTED in the last second,
 *                 counted. Not an average of `1000 / dt`. See the FPS block
 *                 below: that average, and the update-phase sampling that fed
 *                 it, both reported a healthy frame rate for a viewport that
 *                 was visibly crawling or frozen outright.
 *   frameMs     — wall time between successive onUpdate() calls (the engine
 *                 #tick minus the render() call that sits between updates)
 *   cpuLoadPct  — frameMs as a percentage of a 16.67 ms budget (60 Hz reference).
 *                 Clamped to 0–100 so a busy frame saturates the bar instead
 *                 of overflowing. The colour tone in the UI keys off the
 *                 underlying frameMs so a saturated-100% frame at 16.7 ms
 *                 doesn't turn red while one at 50 ms does.
 *   renderMs    — wall time of `renderer.render()` alone (the GPU-submit + draw
 *                 portion of the frame; the GPU work happens synchronously on
 *                 WebGL2 and asynchronously on WebGPU, so this is a useful
 *                 proxy but *not* a hardware GPU load reading)
 *   gpuLoadPct  — renderMs over the same 16.67 ms budget, clamped to 0–100
 *   jsHeapBytes — `performance.memory.usedJSHeapSize` (Chromium-based hosts
 *                 only; `null` elsewhere)
 *   drawCalls   — `renderer.info.render.drawCalls` (per-frame; the `calls`
 *                 field on three.js r185 WebGPURenderer is cumulative since
 *                 startup — different field, do NOT use it here)
 *   triangles   — `renderer.info.render.triangles` (last frame)
 *   textureMem  — `renderer.info.memory.texturesSize` (sum of every tracked
 *                 texture's byte size — close to a real "GPU texture memory"
 *                 reading, though three does not track every backend-level
 *                 allocation so this can undercount large render targets)
 *
 * The system keeps no on-screen presence of its own; hosts read
 * `engine.stats.readout` whenever they want to display data.
 *
 * Sampling timing is subtle. The WebGPU/WebGL animation loop
 * (`renderer.setAnimationLoop`) resets three's per-frame metrics to zero
 * at the START of each frame, BEFORE the user's animation callback runs.
 * Inside the callback the engine fires `onUpdate` first, then calls
 * `renderer.render(...)`. Reading `info.render.drawCalls` from inside
 * `onUpdate` therefore always sees 0 — the render that populates it
 * hasn't happened yet. To get correct readings, `Engine.#tick()` calls
 * `engine.stats.recordRenderInfo()` AFTER `renderer.render()` returns;
 * that's when three's per-frame metrics are populated with the just-
 * rendered frame's data. The StatsSystem stores them in the readout; the
 * overlay reads the readout on its next 10 Hz poll.
 *
 * The renderer.render() wall time is captured by `Engine.#tick()` calling
 * `engine.stats.recordRenderMs(...)` around the render call. This keeps the
 * measurement isolated to the GPU-submit portion of the frame, so the CPU
 * reading doesn't double-count the GPU work.
 */

// 60 Hz frame budget. One full frame of work per refresh = 100% load;
// partial frames leave headroom. (A 120 Hz budget would saturate the bar
// at any 60 Hz scene and confuse the user — "why is my idle scene at 200%?".)
const FRAME_BUDGET_MS = 1000 / 60;

// EMA smoothing factor for the millisecond readings. alpha=1/30 gives a time
// constant of ~30 frames ≈ 0.5 s at 60 Hz — long enough to be readable, short
// enough to feel responsive when the load actually changes.
const FPS_EMA_ALPHA = 1 / 30;

/**
 * FPS IS A COUNT, NOT AN AVERAGE OF RATES. This distinction is the whole
 * reason the readout used to lie, so it is worth the paragraph.
 *
 * The previous implementation EMA'd `1000 / dt` — the mean of instantaneous
 * rates. That is not the frame rate. By Jensen's inequality the mean of
 * reciprocals is always >= the reciprocal of the mean, and the gap grows with
 * variance: frames of 5, 5, 5 and 60 ms are 4 frames in 75 ms = 53 fps, but
 * averaging their instantaneous rates (200, 200, 200, 16.7) says 154. A
 * stutter is exactly high variance, so the old number was most wrong in the
 * one situation the overlay exists to diagnose — steady, plausible, and
 * roughly triple the truth.
 *
 * So: stamp every frame the renderer actually presented, and divide the count
 * in the last second by that second. The window ends at READ time, not at the
 * last frame, which is what makes a stalled or stopped loop decay to 0 instead
 * of holding its final reading forever.
 */
const FPS_WINDOW_MS = 1000;

// One second of presents at 512 Hz. Above that the count saturates and the
// readout under-reports — a limit no display reaches, and the failure
// direction is the safe one (a saturated 512 still reads as "very fast").
const PRESENT_RING = 512;

export class StatsSystem {
  constructor(engine) {
    this.engine = engine;
    // Public shape that the overlay reads. **Mutated in place** on every
    // tick; consumers MUST clone (or compare field-by-field) to detect
    // updates. The StatsOverlay component does a shallow spread at the
    // read boundary so React doesn't bail out on Object.is equality.
    this.readout = {
      // Frames presented in the last second. Refreshed on every tick AND on
      // every `sample()` call, so a host polling at 10 Hz sees it fall while
      // the engine loop is stopped rather than reading a frozen number.
      fps: 0,
      // Frames the engine ticked but did NOT present in the last second:
      // resize drains and `renderSuspended` waves (GI's compile wave is the
      // big one) run the whole update phase and then return before the draw.
      // Those frames used to be counted as frames — a suspended viewport
      // holding one still image reported the full refresh rate. Surfaced
      // rather than merely excluded, because "0 fps, 70 skipped" says the
      // engine is alive and stalled, which "0 fps" alone does not.
      skippedFps: 0,
      frameMs: 0,
      // Main-thread time actually spent executing one engine frame. Unlike
      // frameMs this excludes time deliberately yielded by a host-side frame
      // limiter, so editors can make pacing decisions without the limiter
      // feeding back into its own load signal.
      workMs: 0,
      cpuLoadPct: 0,
      renderMs: 0,
      gpuLoadPct: 0,
      // Real on-GPU frame time from WebGPU timestamp queries (0 when the
      // adapter lacks the feature). Recorded asynchronously by
      // Engine.#resolveGpuTimestamps, so it's a frame or two stale — fine
      // for tuning. When > 0 it drives gpuLoadPct instead of renderMs.
      gpuMs: 0,
      // Effective canvas resolution multiplier (manual render scale ×
      // dynamic-resolution auto scale). Surfaced so the overlay can show
      // when the frame is being rendered below native res.
      renderScale: 1,
      jsHeapBytes: null,
      drawCalls: 0,
      triangles: 0,
      textureMem: 0,
    };

    // Render-call wall time, captured by Engine.#tick() around the
    // renderer.render() call. Defaulted to 0 so an engine without the
    // wrapper installed (e.g. a unit test that bypasses #tick) reports
    // 0 ms GPU time rather than NaN.
    this._lastRenderMs = 0;

    // Ring of wall-clock stamps, one per presented frame. A ring rather than a
    // trimmed array because this is written on the hot path every frame and
    // read ten times a second: writing is one store and two increments, and
    // nothing allocates.
    this._presentTimes = new Float64Array(PRESENT_RING);
    this._presentHead = 0;
    this._presentFilled = 0;
    this._skippedTimes = new Float64Array(PRESENT_RING);
    this._skippedHead = 0;
    this._skippedFilled = 0;

    this._unsubUpdate = null;
    this._lastTickStart = 0;
    this._tick = this._tick.bind(this);
  }

  /**
   * Frames presented in the last second, recounted against the clock on every
   * read. A live getter rather than a plain field because the number a script
   * wants is "what is the frame rate right now", and `readout.fps` is only as
   * fresh as the last tick — which is stale by definition in the case that
   * matters most, a loop that has stopped ticking.
   *
   *     if (this.engine.stats.fps < 30) this.dropParticleBudget();
   */
  get fps() {
    return this.sample().fps;
  }

  /** Ticks per second that ran but drew nothing. See `readout.skippedFps`. */
  get skippedFps() {
    return this.sample().skippedFps;
  }

  start() {
    if (this._unsubUpdate) return;
    this._unsubUpdate = this.engine.onUpdate(this._tick);
  }

  dispose() {
    this._unsubUpdate?.();
    this._unsubUpdate = null;
  }

  /**
   * Mark the GPU-submit portion of the frame. Called by Engine.#tick()
   * around `renderer.render(scene, camera)`. WebGPU dispatches the actual
   * GPU work asynchronously, so this number is "CPU time spent submitting
   * draws" rather than a true hardware GPU read. Still the closest
   * portable signal we have without WebGPU timestamp-query support.
   */
  recordRenderMs(ms) {
    this._lastRenderMs = ms;
  }

  /**
   * One frame reached the canvas. Called by Engine.#tick() immediately after
   * the render call — either `renderer.render()` or a render override's own
   * draw — and by nothing else.
   *
   * The placement is the point. The FPS counter used to live in `_tick()`,
   * which runs as an `onUpdate` callback, i.e. in the update phase BEFORE the
   * render block. Every path that returns between the two — a resize drain,
   * `renderSuspended` (raised for the whole of GI's compile wave, during which
   * the editor deliberately pins the loop uncapped) — produced a full tick
   * with no draw, and the old counter scored it as a frame. That is a viewport
   * frozen on one image reporting the display's refresh rate, which is the
   * exact complaint this rewrite answers.
   */
  recordPresentedFrame(now = performance.now()) {
    this._presentTimes[this._presentHead] = now;
    this._presentHead = (this._presentHead + 1) % PRESENT_RING;
    if (this._presentFilled < PRESENT_RING) this._presentFilled++;
  }

  /** A tick that ran the update phase and then returned without drawing. */
  recordSkippedFrame(now = performance.now()) {
    this._skippedTimes[this._skippedHead] = now;
    this._skippedHead = (this._skippedHead + 1) % PRESENT_RING;
    if (this._skippedFilled < PRESENT_RING) this._skippedFilled++;
  }

  /**
   * Refresh the time-derived counters against `now` and return the readout.
   *
   * Hosts must call this before reading `fps`/`skippedFps` rather than trusting
   * the last tick's values: when the loop is stopped (the editor suspends an
   * unfocused viewport) or wedged, no tick runs, and a counter that only
   * updates from inside the loop can never report that the loop isn't running.
   * Recounting at read time makes "nothing is being drawn" decay honestly to
   * zero within one window.
   */
  sample(now = performance.now()) {
    this.readout.fps = countWithin(this._presentTimes, this._presentHead, this._presentFilled, now);
    this.readout.skippedFps = countWithin(
      this._skippedTimes, this._skippedHead, this._skippedFilled, now,
    );
    return this.readout;
  }

  recordFrameWorkMs(ms) {
    const previous = this.readout.workMs;
    this.readout.workMs = previous === 0 ? ms : 0.1 * ms + 0.9 * previous;
  }

  /**
   * Real GPU frame time from resolved WebGPU timestamp queries. Lightly
   * smoothed (same EMA constant as FPS) because per-pass timestamps are
   * noisy frame-to-frame even on a static scene.
   */
  recordGpuMs(ms) {
    const prev = this.readout.gpuMs;
    this.readout.gpuMs = prev === 0 ? ms : FPS_EMA_ALPHA * ms + (1 - FPS_EMA_ALPHA) * prev;
  }

  /**
   * Snapshot three's per-frame renderer metrics into the readout. Called
   * by Engine.#tick() AFTER `renderer.render()` returns, so the values
   * are populated with the just-rendered frame's data. Reading them
   * earlier (e.g. inside `onUpdate`) returns 0 — three's animation loop
   * resets per-frame metrics at the start of each frame, before user
   * code runs. See the class header for the full timing rationale.
   */
  recordRenderInfo() {
    const info = this.engine.renderer?.info;
    if (!info) return;
    const render = info.render;
    const mem = info.memory;
    this.readout.drawCalls = render?.drawCalls ?? 0;
    this.readout.triangles = render?.triangles ?? 0;
    // `texturesSize` is the sum of every tracked texture's byte size —
    // close to a real "GPU texture memory" reading. Three does not track
    // every backend-level allocation so this can undercount large render
    // targets and other implicit GPU resources, but it's the only number
    // the renderer exposes without a custom bridge.
    this.readout.textureMem = mem?.texturesSize ?? 0;
    this.readout.renderScale = this.engine.renderScale ?? 1;
  }

  _tick() {
    const now = performance.now();

    if (this._lastTickStart > 0) {
      // Frame CPU work: time between successive onUpdate() calls. Covers
      // the script + component updates + the synchronous parts of last
      // frame's GPU submission; the renderer.render() itself is excluded
      // because it sits between the update phase and the next onUpdate.
      //
      // NOT a frame-rate signal, whatever it looks like: this interval keeps
      // running at the display's cadence through every non-drawing tick. FPS
      // comes from recordPresentedFrame() alone.
      this.readout.frameMs = now - this._lastTickStart;
    }
    this._lastTickStart = now;
    this.sample(now);

    this.readout.renderMs = this._lastRenderMs;
    this._lastRenderMs = 0;

    // 60 Hz budget: a frame at exactly 16.67 ms = 100%. A frame at 33 ms
    // (which would cause a 30 Hz reading) saturates the bar. Anything
    // beyond is still "100%+" — the overlay shows the underlying ms
    // value next to the percent for diagnostics.
    this.readout.cpuLoadPct = clampPct((this.readout.frameMs / FRAME_BUDGET_MS) * 100);
    // Prefer the real GPU timestamp reading when available; the CPU-side
    // submit time (renderMs) badly understates async GPU work like SSGI's
    // offscreen passes or volume raymarching.
    const gpuSignalMs = this.readout.gpuMs > 0 ? this.readout.gpuMs : this.readout.renderMs;
    this.readout.gpuLoadPct = clampPct((gpuSignalMs / FRAME_BUDGET_MS) * 100);

    // Chromium-only. Other hosts (Firefox, Safari, Tauri-on-Windows-older-
    // WebView2, etc.) leave the field at null and the UI shows "—".
    const mem = typeof performance !== "undefined" ? performance.memory : null;
    this.readout.jsHeapBytes = mem?.usedJSHeapSize ?? null;
    // Note: per-frame renderer metrics (draw calls, triangles, texture
    // memory) are NOT sampled here — three's animation loop resets them
    // to zero at the start of each frame, BEFORE the user's callback
    // runs. Reading them now would always see 0. Instead, Engine.#tick()
    // calls engine.stats.recordRenderInfo() AFTER renderer.render()
    // returns, when the per-frame metrics are populated with this
    // frame's data.
  }
}

/**
 * How many stamps in the ring fall inside the window ending at `now`.
 *
 * Walks backwards from the newest entry and stops at the first one that has
 * aged out — the ring is written in time order, so the first miss ends the
 * count and a 60 fps engine touches 60 slots, not 512.
 */
function countWithin(times, head, filled, now) {
  const cutoff = now - FPS_WINDOW_MS;
  let n = 0;
  for (let i = 1; i <= filled; i++) {
    const index = (head - i + PRESENT_RING) % PRESENT_RING;
    if (times[index] <= cutoff) break;
    n++;
  }
  // The window is exactly one second, so the count IS the rate. Kept as an
  // explicit division so the window length can change without the units
  // silently changing with it.
  return (n * 1000) / FPS_WINDOW_MS;
}

function clampPct(p) {
  // Hard cap at 100. Beyond that the bar is full and the underlying ms
  // readout (shown alongside) carries the additional info. We previously
  // capped at 999% which produced "215%" readings on normal scenes and
  // stretched the overlay's value column — both felt broken. 100% is the
  // honest answer to "is this frame fitting in the budget?".
  return Math.max(0, Math.min(100, p));
}
