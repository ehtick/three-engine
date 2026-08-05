// @ts-check
import { engine } from "./engineInstance.js";
import { oncePerVm } from "./singleton.js";
import { editorFrameRateFor } from "./framePolicy.js";

// Re-exported so existing importers (and the smokes) keep working.
export { editorFrameRateFor };

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

/** True when the viewport's dock group is the one the user is working in. */
function viewportFocused() {
  const canvas = viewportCanvas();
  const group = canvas?.closest?.(".dv-groupview");
  // No dock (the exported player, a test harness) means nothing is competing
  // for the main thread — treat that as focused rather than throttling forever.
  if (!group) return true;
  return group.classList.contains("dv-active-group");
}

/**
 * Gives editor chrome a main-thread timeslice when viewport work is heavy, and
 * stops the viewport rendering altogether when nobody can see it.
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

  // `start`/`stop` drive the render loop itself. They are deliberately NOT on
  // the scripting `Engine` surface in engine.d.ts — a gameplay script that
  // stops the loop has ended the game — so the host reaches them through an
  // explicit cast rather than by widening what every script can call.
  const host = /** @type {{ start(): void, stop(): void, loopActive: boolean }} */ (
    /** @type {unknown} */ (engine)
  );

  const apply = () => {
    // Suspension first: a hidden viewport should cost nothing at all, and a
    // frame-rate cap still pays for one heavy frame per interval.
    if (!engine.playing && !viewportVisible()) {
      if (!suspended && host.loopActive) {
        suspended = true;
        host.stop();
      }
      return;
    }
    if (suspended) {
      suspended = false;
      host.start();
    }

    const workMs = engine.stats?.readout?.workMs ?? 0;
    const next = editorFrameRateFor(workMs, {
      interacting: performance.now() < interactiveUntil,
      playing: engine.playing,
      focused: viewportFocused(),
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
  setInterval(apply, SAMPLE_MS);
}
