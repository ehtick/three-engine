// @ts-check
import { engine } from "./engineInstance.js";
import { oncePerVm } from "./singleton.js";

const SAMPLE_MS = 250;
const UI_PRIORITY_MS = 350;

/** Pure policy, exported so the thresholds stay testable without a browser. */
export function editorFrameRateFor(workMs, { interacting = false, playing = false } = {}) {
  if (playing || !(workMs > 0)) return 0;
  if (interacting && workMs >= 14) return 15;
  if (workMs >= 42) return 20;
  if (workMs >= 24) return 30;
  return 0;
}

function isViewportGesture(target) {
  return !!target?.closest?.("canvas.viewport-canvas, .geometry-editor-canvas");
}

/**
 * Gives editor chrome a main-thread timeslice when viewport work is heavy.
 * Installed once after the engine exists. It never limits Play mode and it
 * never slows direct canvas gestures such as orbiting or a transform drag.
 */
export function installEditorFramePacing() {
  if (!oncePerVm("editorFramePacing.install")) return;

  let interactiveUntil = 0;
  let applied = 0;

  const apply = () => {
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
  engine.on("play-changed", apply);
  setInterval(apply, SAMPLE_MS);
}
