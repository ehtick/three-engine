import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

/**
 * Editor-wide toast notifications: the in-your-face channel for failures that
 * would otherwise die in the Console panel — a background live-preview
 * rebuild breaking, a Ctrl+B build failing while no Build panel is open.
 *
 * `key` dedupes: pushing with an existing key replaces that toast (and its
 * timer) instead of stacking — a rebuild loop that fails every 5 seconds
 * produces one toast, not a growing pile. `dismissToastKey` clears it the
 * moment the same operation succeeds again.
 */

const TIMEOUTS = { error: 12000, warn: 8000, info: 4500 };

// VM-wide, not module-level: a `?t=` HMR twin pushing into its own store
// would show nothing — the mounted <Toasts /> reads the first one.
const shared = vmSingleton("toastStore", () => {
  let nextId = 1;
  const timers = new Map();
  const store = create((set) => ({
    toasts: [],
    _push(toast) {
      set((state) => ({
        toasts: [...state.toasts.filter((t) => !toast.key || t.key !== toast.key), toast],
      }));
    },
    _dismiss(predicate) {
      set((state) => ({ toasts: state.toasts.filter((t) => !predicate(t)) }));
    },
  }));
  return { store, timers, nextIdRef: () => nextId++ };
});

export const useToastStore = shared.store;

/**
 * @param {{ level?: "info" | "warn" | "error", title?: string, detail?: string,
 *           key?: string | null, timeoutMs?: number }} [opts]
 */
export function pushToast({ level = "info", title, detail = "", key = null, timeoutMs } = {}) {
  const id = shared.nextIdRef();
  if (key && shared.timers.has(key)) clearTimeout(shared.timers.get(key));
  shared.store.getState()._push({ id, level, title, detail, key });
  const timeout = timeoutMs ?? TIMEOUTS[level] ?? TIMEOUTS.info;
  const timer = setTimeout(() => {
    shared.store.getState()._dismiss((t) => t.id === id);
    if (key) shared.timers.delete(key);
  }, timeout);
  if (key) shared.timers.set(key, timer);
  return id;
}

export function dismissToast(id) {
  shared.store.getState()._dismiss((t) => t.id === id);
}

/** Clears the toast for `key`, if any — call when the failing operation succeeds. */
export function dismissToastKey(key) {
  if (shared.timers.has(key)) {
    clearTimeout(shared.timers.get(key));
    shared.timers.delete(key);
  }
  shared.store.getState()._dismiss((t) => t.key === key);
}
