// @ts-check
/**
 * Whether an unfocused viewport stops rendering.
 *
 * ON by default: a viewport nobody is looking at is pure cost, and a heavy
 * scene rendering behind a paint canvas or a node graph makes the WHOLE editor
 * lag while buying nothing. `editorFramePacing` wakes a stopped viewport
 * whenever something it draws actually changes, so the picture stays honest;
 * the one thing it cannot do is keep an unattended simulation ticking, which is
 * why the switch stays reachable in Project Settings → Editor.
 *
 * Per machine, not per project: it is about how heavy YOUR scene runs on YOUR
 * hardware, so it lives in localStorage next to the other `engine.*` editor
 * preferences rather than in project.json where it would follow the project
 * onto someone else's machine.
 *
 * Kept in its own module, free of engine and store imports, so the settings
 * panel can read it without dragging the render loop in behind it.
 */
import { vmSingleton } from "./singleton.js";

const KEY = "engine.viewport.freezeWhenUnfocused";

const state = vmSingleton("viewportFreeze", () => ({
  // Absent means "never set" — default on. Only an explicit "0" turns it off,
  // so a cleared localStorage comes back to the sane default rather than to
  // whatever `Boolean(null)` happens to be.
  enabled: readStored(),
  /** @type {Set<(enabled: boolean) => void>} */
  listeners: new Set(),
}));

function readStored() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    // Storage can be unavailable (a sandboxed harness, private mode). The
    // feature is a preference, not a requirement — fall back to the default.
    return true;
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
