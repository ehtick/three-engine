// @ts-check
/**
 * Whether an unfocused viewport stops rendering.
 *
 * OFF by default: a viewport that keeps drawing is the behaviour that can never
 * surprise you. Watching a sim settle, an animation loop or a bake converge from
 * another panel all need it, and none of them announce themselves — so the
 * editor cannot infer when pausing is safe. It is a switch you reach for when a
 * heavy scene is making the rest of the editor lag, which you notice
 * immediately; the reverse mistake (a viewport that silently stopped) is the one
 * that wastes an hour.
 *
 * Per machine, not per project: it is about how heavy YOUR scene runs on YOUR
 * hardware, so it lives in localStorage next to the other `engine.*` editor
 * preferences rather than in project.json where it would follow the project
 * onto someone else's machine.
 *
 * Kept in its own module, free of engine and store imports, so the toolbar
 * button can read it without dragging the render loop in behind it.
 */
import { vmSingleton } from "./singleton.js";

const KEY = "engine.viewport.freezeWhenUnfocused";

const state = vmSingleton("viewportFreeze", () => ({
  // Absent means "never set" — default off. Only an explicit "1" turns it on,
  // so a cleared localStorage comes back to the sane default rather than to
  // whatever `Boolean(null)` happens to be.
  enabled: readStored(),
  /** @type {Set<(enabled: boolean) => void>} */
  listeners: new Set(),
}));

function readStored() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage can be unavailable (a sandboxed harness, private mode). The
    // feature is a preference, not a requirement — fall back to the default.
    return false;
  }
}

/** Whether the viewport should stop rendering when it is not the focused panel. */
export function isViewportFreezeEnabled() {
  return state.enabled;
}

/**
 * Sets the preference and notifies listeners. Persisting is best-effort: a
 * failed write costs the setting at the next reload and nothing else, which is
 * not worth failing a toolbar click over.
 */
export function setViewportFreezeEnabled(enabled) {
  const next = !!enabled;
  if (next === state.enabled) return;
  state.enabled = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* preference only */
  }
  for (const listener of state.listeners) listener(next);
}

/** Subscribes to changes. Returns an unsubscribe. */
export function onViewportFreezeChanged(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
