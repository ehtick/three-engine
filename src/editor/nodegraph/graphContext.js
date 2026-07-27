/** Tracks whether the pointer is over a node-graph canvas (shader graph,
 *  particle graph, animator). Global keyboard shortcuts (entity delete/copy/
 *  paste/undo) check this so a graph editor's own handling wins instead of the
 *  keypress hitting the scene — a plain DOM-ancestry check is fragile because
 *  clicking an SVG edge/node doesn't reliably move `document.activeElement`.
 */
let hovered = false;

/**
 * Last pointer position seen anywhere in the document.
 *
 * The boolean above is driven by mouseenter/mouseleave on the canvas, and that
 * ALONE is not trustworthy: every dropdown in these panels renders a
 * full-screen `.dropdown-overlay`, and the moment it mounts under a stationary
 * pointer the browser fires `mouseleave` on the canvas. Closing the overlay
 * does NOT re-fire `mouseenter` unless the pointer actually moves, so the flag
 * stays false while the pointer visibly sits on the graph.
 *
 * The consequence was severe rather than cosmetic: with the flag stale the
 * global handler claimed Ctrl+Z and ran `commandBus.undo()`, so pressing undo
 * after using the Presets menu undid the last SCENE command (removing the
 * Particles component) instead of the last graph edit.
 *
 * A geometric test against the live pointer position cannot go stale that way,
 * so it backs the flag up.
 */
let lastPointer = { x: -1, y: -1 };
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
}

export function setGraphHovered(v) {
  hovered = v;
}

/** True when `point` lies inside `el`'s box. */
function contains(el, point) {
  const r = el.getBoundingClientRect();
  // A hidden dock tab measures 0x0, so it can never claim the pointer.
  if (r.width < 1 || r.height < 1) return false;
  return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
}

/** True when the pointer is inside `el` — immune to overlay-induced mouseleave. */
export function isPointerInside(el) {
  return !!el && contains(el, lastPointer);
}

export function isGraphHovered() {
  if (hovered) return true;
  if (typeof document === "undefined") return false;
  for (const el of document.querySelectorAll(".shader-graph-canvas")) {
    if (contains(el, lastPointer)) return true;
  }
  return false;
}
