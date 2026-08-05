// @ts-check
import { engine } from "./engineInstance.js";
import { oncePerVm } from "./singleton.js";
import { editorFrameRateFor, shouldSuspendViewport } from "./framePolicy.js";
import { onAssetInvalidated } from "./assetLoader.js";

// Re-exported so existing importers (and the smokes) keep working.
export { editorFrameRateFor, shouldSuspendViewport };

const SAMPLE_MS = 250;
const UI_PRIORITY_MS = 350;

function isViewportGesture(target) {
  return !!target?.closest?.("canvas.viewport-canvas, .geometry-editor-canvas");
}

/** The live viewport canvas, or null before one exists. */
function viewportCanvas() {
  return document.querySelector("canvas.viewport-canvas");
}

/**
 * On screen at all: not behind an inactive dock tab, not in a minimised window,
 * not covered by some other maximized group.
 *
 * Measured from the element rather than tracked through dockview's events,
 * because dockview DETACHES an inactive tab's element without unmounting its
 * React component (see EditorShell) — so a detached, zero-sized canvas IS the
 * signal, and reading it needs no bookkeeping to keep in sync.
 */
function viewportVisible() {
  if (typeof document === "undefined" || document.hidden) return false;
  const canvas = viewportCanvas();
  if (!canvas || !canvas.isConnected) return false;
  const rect = canvas.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * True when the viewport's dock group is the one the user is working in.
 *
 * Dockview marks the focused group `dv-active-group`, and clicking any panel
 * moves it. The geometry editor and the Game view draw through the same canvas,
 * so they count as the viewport being focused — they ARE the viewport.
 */
function viewportFocused() {
  const canvas = viewportCanvas();
  const group = canvas?.closest?.(".dv-groupview");
  // No dock (the exported player, a test harness) means nothing is competing
  // for the main thread — treat that as focused rather than freezing forever.
  if (!group) return true;
  return group.classList.contains("dv-active-group");
}

/**
 * Stops the viewport rendering whenever nobody is looking at it, and shares the
 * main thread when it is rendering something heavy.
 *
 * Installed once after the engine exists. It never limits Play mode and it
 * never slows direct canvas gestures such as orbiting or a transform drag.
 */
export function installEditorFramePacing() {
  if (!oncePerVm("editorFramePacing.install")) return;

  let interactiveUntil = 0;
  let applied = 0;
  // Whether WE stopped the loop. Never restart one somebody else stopped —
  // Play/Stop and scene loading own that flag too.
  let suspended = false;
  let wakeQueued = false;
  // Something changed since the last frame was drawn.
  let dirty = false;

  // `start`/`stop` drive the render loop itself. They are deliberately NOT on
  // the scripting `Engine` surface in engine.d.ts — a gameplay script that
  // stops the loop has ended the game — so the host reaches them through an
  // explicit cast rather than by widening what every script can call.
  const host = /** @type {{ start(): void, stop(): void, loopActive: boolean }} */ (
    /** @type {unknown} */ (engine)
  );

  const resume = () => {
    if (!suspended) return;
    suspended = false;
    host.start();
  };

  /**
   * Renders one frame while suspended, at most once per sample.
   *
   * Waking straight from the event that dirtied the scene looks simpler and is
   * a trap: some of these fire hundreds of times a second (a settings sync, a
   * hierarchy notification during a drag), and a wake-per-event is a render
   * loop with extra steps — measured at 8655 wakes in one smoke run, with the
   * viewport never actually stopping. Marking a flag and letting the sampler
   * act on it bounds the cost to one frame per interval however noisy the
   * source is, and it deletes the "is a wake already queued" state that got
   * wedged when the two raced.
   */
  const renderOneFrame = () => {
    if (!suspended || wakeQueued) return;
    wakeQueued = true;
    host.start();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wakeQueued = false;
        if (suspended) host.stop();
      });
    });
  };

  /** Something changed what the viewport would draw. */
  const wake = () => {
    dirty = true;
  };

  const apply = () => {
    if (
      // HARNESS HATCH: headless suites (GI probes, smokes) drive the engine
      // with nothing focused and no user input, which this pacing correctly
      // reads as "nobody is looking" — and then their engine never ticks and
      // every readback reports a dead field ("GI never built" with no error
      // anywhere, giDispatches flat, compute 0.00 — the sleeping-engine
      // signature). The flag is sampled every interval, so a harness can set
      // it at any point, not just before install.
      globalThis.__editorKeepRendering !== true &&
      shouldSuspendViewport({
        playing: engine.playing,
        visible: viewportVisible(),
        focused: viewportFocused(),
      })
    ) {
      suspended = true;
      // A pending wake owns the loop until its frame lands; otherwise stop now.
      // Unconditionally, not once-on-entry: a stop that was skipped because a
      // wake held the loop must be retried, or the viewport runs forever with
      // `suspended` claiming otherwise.
      if (!wakeQueued && host.loopActive) {
        if (dirty) {
          // One last frame so what is left on screen is current.
          dirty = false;
          renderOneFrame();
        } else {
          host.stop();
        }
      } else if (dirty && !wakeQueued) {
        dirty = false;
        renderOneFrame();
      }
      return;
    }
    dirty = false;
    resume();

    const workMs = engine.stats?.readout?.workMs ?? 0;
    const next = editorFrameRateFor(workMs, {
      interacting: performance.now() < interactiveUntil,
      playing: engine.playing,
    });
    if (next === applied) return;
    applied = next;
    engine.setFrameRateLimit(next);
  };

  const prioritizeUi = (event) => {
    if (engine.playing || isViewportGesture(event.target)) return;
    interactiveUntil = performance.now() + UI_PRIORITY_MS;
    apply();
  };

  window.addEventListener("pointerdown", prioritizeUi, true);
  window.addEventListener("pointermove", prioritizeUi, true);
  window.addEventListener("wheel", prioritizeUi, { capture: true, passive: true });
  window.addEventListener("keydown", prioritizeUi, true);
  // Clicking into or out of the viewport changes the answer immediately;
  // waiting up to a sample interval to resume makes it feel sticky.
  window.addEventListener("focusin", apply, true);
  window.addEventListener("pointerdown", apply, true);
  document.addEventListener("visibilitychange", apply);
  engine.on("play-changed", apply);

  // Everything that changes what the viewport would draw. Each of these wakes
  // it for one frame while it is stopped, so a suspended viewport is never
  // showing something that is no longer true.
  engine.on("hierarchy-changed", wake);
  engine.on("settings-changed", wake);
  engine.on("entity-spawned", wake);
  engine.on("renderer-rebuilt", wake);
  // A texture saved in the Texture Editor, a material recompiled, a geometry
  // rewritten — all land here.
  onAssetInvalidated(wake);

  setInterval(apply, SAMPLE_MS);
}
