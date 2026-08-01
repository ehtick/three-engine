import { vmSingleton } from "./singleton.js";

/**
 * Arbitrates who owns the ONE renderer canvas.
 *
 * The engine has a single `WebGPURenderer` bound to a single `<canvas>`. Both
 * the Viewport and the Game panel want to show it, and a second renderer is not
 * an option — the model-preview panel already pays that cost and it is listed
 * as a debt, not a pattern to copy. So instead of duplicating the renderer, the
 * canvas element itself moves between panel containers.
 *
 * Claims are ranked, not first-come: the Game panel outranks the Viewport
 * exactly while playing, and hands the canvas straight back on Stop. A ranked
 * registry (rather than each panel calling `appendChild` when it feels like it)
 * is what keeps mount order from deciding who wins — React remounts a dockview
 * panel whenever it is dragged to a new group, and a mount-order race would
 * show the game in the viewport tab at random.
 *
 * Callers never move the canvas themselves. They claim, and the arbiter
 * appends; releasing re-hands it to the next-highest claim, which is why
 * closing the Game panel mid-play puts the picture back in the viewport
 * instead of leaving a black rectangle.
 */
const state = vmSingleton("viewportCanvas", () => ({
  /** `{ id, container, priority }`, highest priority wins ties by recency. */
  claims: [],
  canvas: null,
  owner: null,
  listeners: new Set(),
  resize: null,
  observer: null,
}));

/** Registers the canvas once the viewport has created it. */
export function setSharedCanvas(canvas) {
  state.canvas = canvas;
  apply();
}

export function getSharedCanvas() {
  return state.canvas;
}

/** The id of the claim currently holding the canvas, or null. */
export function getCanvasOwner() {
  return state.owner;
}

/**
 * Claims the canvas for `container`. Re-claiming with the same id updates the
 * container/priority in place, so a panel can raise its own priority (the Game
 * panel does exactly that when play starts) without unmounting.
 */
export function claimCanvas(id, container, priority = 0) {
  const existing = state.claims.find((c) => c.id === id);
  if (existing) {
    existing.container = container;
    existing.priority = priority;
  } else {
    state.claims.push({ id, container, priority });
  }
  apply();
}

/**
 * Drops `id`'s claim.
 *
 * `container` makes the release IDENTITY-AWARE. Claims are keyed by a fixed id
 * ("viewport", "game"), so whenever a panel is remounted — dragged to another
 * group, or its layout restored — the outgoing instance's cleanup can run after
 * the incoming one has already claimed, and an unconditional release would
 * delete the live claim. Passing the container the caller claimed with turns
 * that late cleanup into a no-op.
 */
export function releaseCanvas(id, container = null) {
  const index = state.claims.findIndex((c) => c.id === id);
  if (index === -1) return;
  if (container && state.claims[index].container !== container) return;
  state.claims.splice(index, 1);
  apply();
}

/** Notified whenever ownership changes — panels use it to show a placeholder. */
export function onCanvasOwnerChanged(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

/**
 * Registers the function that resizes the renderer + active camera. The
 * viewport owns that logic (it knows about the orthographic half-height), but
 * the Game panel has to drive it too, and importing ViewportPanel from
 * GamePanel to reach it would pull a 3800-line module into the game view's
 * chunk for one function.
 */
export function setCanvasResizer(fn) {
  state.resize = fn;
}

/**
 * Sizes the renderer for `id` — ignored unless `id` currently owns the canvas.
 *
 * Both panels run a ResizeObserver on their own container, and both keep
 * firing while the other is showing: dockview resizes a hidden tab's element
 * as the layout changes. Without this guard the two observers hand
 * `engine.setSize` different numbers on alternating frames and the renderer
 * thrashes between them.
 */
export function resizeSharedCanvas(id, width, height) {
  if (state.owner !== id) return false;
  if (!(width > 0) || !(height > 0)) return false;
  state.resize?.(width, height);
  return true;
}

/**
 * Watches for a claimed container being (re)inserted into the document.
 *
 * THE TRAP, and it cost real time to find: dockview does not unmount the
 * inactive tab's React component — it **detaches that panel's DOM element**
 * and reattaches it when the tab becomes active again. The component stays
 * mounted the whole time, so its mount effect never re-runs and the claim is
 * never re-registered. Every event-driven scheme therefore misses the moment
 * the container comes back: the claim is already there, unchanged, and simply
 * flips from disconnected to connected with nothing to observe it.
 *
 * A frame-count retry was tried first and is wrong for the same reason — the
 * hidden tab can sit detached for minutes, so any bounded budget expires long
 * before the user clicks back, and an unbounded one spins forever.
 *
 * So watch the DOM, but only while it matters: the observer is installed
 * exactly when claims exist and none are connected, and torn down the instant
 * one is. That makes it free in the common case and instant in the one it
 * covers — no polling delay before the picture reappears.
 */
function watchForAttach() {
  if (state.observer) return;
  state.observer = new MutationObserver(() => apply());
  state.observer.observe(document.body, { childList: true, subtree: true });
}

function stopWatching() {
  state.observer?.disconnect();
  state.observer = null;
}

function apply() {
  // Dockview DETACHES the inactive tab's element (see watchForAttach), and
  // Viewport and Game share one group by default — so a claim's container is
  // routinely out of the document while the claim is still registered and its
  // component still mounted. Appending into a detached div silently makes the
  // canvas disappear from the whole editor, which is exactly what happened: on
  // Stop the picture went nowhere at all. Only connected containers can win.
  const live = state.claims.filter((c) => c.container?.isConnected);
  const winner = live.reduce(
    (best, claim) => (best === null || claim.priority >= best.priority ? claim : best),
    null,
  );
  if (!winner && state.claims.length) watchForAttach();
  else stopWatching();
  const owner = winner?.id ?? null;
  if (state.canvas && winner?.container) {
    if (state.canvas.parentElement !== winner.container) winner.container.appendChild(state.canvas);
  } else if (state.canvas) {
    // Nobody can show it — park it. Leaving it in the last container means the
    // Game panel's "press Play" placeholder renders on top of a live editor
    // view of the scene, which reads as a rendering bug rather than as an idle
    // panel. Detaching is safe: the renderer keeps drawing to the same canvas
    // and reattaching restores the picture (covered by the smoke's tick checks).
    state.canvas.remove();
  }
  if (owner === state.owner) return;
  state.owner = owner;
  for (const fn of state.listeners) fn(owner);
}
