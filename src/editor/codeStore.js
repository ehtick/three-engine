import { create } from "zustand";
import { vmSingleton } from "./singleton.js";
import { disposeModel } from "./code/monaco.js";

/**
 * Which files the Code panel has open, and which of them have unsaved edits.
 *
 * Lives outside the panel so anything can open a file in it — the Inspector's
 * "Open in Code Editor", the Assets double-click, a script-not-found error in
 * the console — without reaching into a React tree that may not be mounted
 * yet. `vmSingleton` because a duplicated module instance would mean the
 * opener and the panel keep separate tab lists, and opens would silently do
 * nothing (see singleton.js).
 */
export const useCodeStore = vmSingleton("codeStore", () =>
  create((set, get) => ({
    files: [],
    activePath: null,
    /** @type {Record<string, boolean>} path -> has unsaved edits */
    dirty: {},

    open(path) {
      if (!path) return;
      const files = get().files.includes(path) ? get().files : [...get().files, path];
      set({ files, activePath: path });
    },

    activate(path) {
      if (get().files.includes(path)) set({ activePath: path });
    },

    close(path) {
      const files = get().files.filter((entry) => entry !== path);
      const dirty = { ...get().dirty };
      delete dirty[path];
      set({
        files,
        dirty,
        activePath: get().activePath === path ? (files[files.length - 1] ?? null) : get().activePath,
      });
      // The Monaco model is only dropped once nothing shows the file: the
      // Inspector's inline editor shares it, and disposing it out from under
      // that pane blanks it. Closing a *tab* is not closing the *document*.
      if (!files.includes(path)) disposeModel(path).catch(() => {});
    },

    setDirty(path, value) {
      if (!!get().dirty[path] === !!value) return;
      set({ dirty: { ...get().dirty, [path]: !!value } });
    },

    /** Paths with unsaved edits — for the "you have unsaved code" quit guard. */
    dirtyPaths() {
      return Object.entries(get().dirty)
        .filter(([, value]) => value)
        .map(([path]) => path);
    },
  })),
);

/** Opens `path` in the Code panel, opening the panel itself if it's closed. */
export function openCodeFile(path) {
  if (!path) return;
  useCodeStore.getState().open(path);
  import("./EditorShell.jsx").then((m) => m.openPanel("code"));
}
