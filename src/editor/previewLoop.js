// Frame budget for the editor's SECONDARY renderers.
//
// Several panels (material preview, asset preview, geometry editor) each own a
// full extra WebGPURenderer and drove it at the display refresh rate, forever,
// while the panel was open — the material preview even spins its sphere, so it
// can never settle into an idle "nothing changed" state. On a 120Hz display
// that is a second (and third) queue submit + swapchain present competing with
// the viewport EVERY frame, which shows up as viewport frame drops and CPU
// spikes rather than as GPU load: the work is small, but it serializes against
// the main present.
//
// A rotating thumbnail does not need 120fps. These helpers cap a preview at a
// sane rate and skip entirely when it cannot be seen (background browser tab,
// collapsed dock tab, scrolled out of view). The viewport keeps the rest.

/** Preview refresh rate. Smooth enough for a spinning thumbnail, ~4× cheaper
 *  than vsync on a 120Hz display. */
export const PREVIEW_FPS = 30;

/**
 * True when `canvas` is worth rendering into: laid out, still in the document,
 * and in a visible tab. Cheap enough to call per frame.
 */
export function previewVisible(canvas) {
  if (!canvas || !canvas.isConnected) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return canvas.clientWidth >= 1 && canvas.clientHeight >= 1;
}

/**
 * Wraps a preview's per-frame callback so it runs at most `fps` times a second
 * and never while hidden. Returns a function to pass straight to
 * `renderer.setAnimationLoop` / `requestAnimationFrame`.
 *
 * The callback still receives the REAL elapsed time, so anything integrating
 * motion (Timer/mixer deltas) advances by wall-clock and animates at the same
 * speed it did before the cap.
 */
export function throttlePreviewFrame(canvas, onFrame, fps = PREVIEW_FPS) {
  const interval = 1000 / fps;
  let last = -Infinity;
  return (time) => {
    if (!previewVisible(canvas)) return;
    const now = time ?? performance.now();
    if (now - last < interval) return;
    last = now;
    onFrame();
  };
}
