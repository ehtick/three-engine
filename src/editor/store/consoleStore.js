import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

// VM-wide alongside the store itself: a second copy of this module with its own
// counter would hand React duplicate keys for entries in one shared list.
const ids = vmSingleton("consoleStoreIds", () => ({ next: 1 }));
const MAX_ENTRIES = 500;

export const useConsoleStore = vmSingleton("consoleStore", () => create((set) => ({
  entries: [],
  // Number of error-level entries the user hasn't seen yet. Incremented when a
  // new error lands, reset to zero when the Console panel becomes active (i.e.
  // the user opens it) or when they hit Clear. The tab renderer reads this to
  // draw the red-dot indicator.
  unreadErrors: 0,

  push(level, message) {
    set((state) => {
      const entries = [...state.entries, { id: ids.next++, level, message, time: new Date() }];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      return {
        entries,
        unreadErrors: level === "error" ? state.unreadErrors + 1 : state.unreadErrors,
      };
    });
  },

  clear() {
    set({ entries: [], unreadErrors: 0 });
  },

  /** Called by the editor shell when the Console tab becomes the active tab. */
  markConsoleRead() {
    set({ unreadErrors: 0 });
  },
})));

function format(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      // String(a) and JSON.stringify(a) both throw on pathological inputs:
      // circular refs, objects with a throwing toString, BigInt values, etc.
      // Try in increasing-cost order and fall back to a literal that never
      // throws, so a single bad log call can't kill the console capture.
      try {
        return JSON.stringify(a);
      } catch {
        try {
          return String(a);
        } catch {
          return Object.prototype.toString.call(a);
        }
      }
    })
    .join(" ");
}

/** Tee console.log/warn/error and window errors into the Console panel. */
export function installConsoleCapture() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const message = format(args);
      try {
        original(message);
      } catch {
        console.error("Error formatting console message:", args);
      }
      useConsoleStore.getState().push(level === "info" ? "log" : level, message);
    };
  }
  window.addEventListener("error", (e) => {
    useConsoleStore.getState().push("error", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    useConsoleStore.getState().push("error", `Unhandled rejection: ${e.reason?.message ?? e.reason}`);
  });
}
