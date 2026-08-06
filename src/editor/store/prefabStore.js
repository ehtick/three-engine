import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

/**
 * UI-facing prefab state.
 *
 * `version` bumps whenever the registry changes so components that read prefab
 * data through non-reactive engine calls (the inspector's override list, the
 * hierarchy's prefab badges) have something to subscribe to.
 *
 * `stage` is Prefab Mode: while it's set, the scene in the viewport is *not*
 * the user's scene — it's a prefab opened in isolation. `sceneIO.saveScene`
 * checks this so Ctrl+S (and autosave) write the prefab rather than clobbering
 * the real scene file with the staged contents.
 */
export const usePrefabStore = vmSingleton("prefabStore", () => create((set) => ({
  version: 0,
  prefabs: [], // [{ guid, name, path }] — for asset pickers and the variant menu
  stage: null, // { guid, path, name, rootId }
  stageDirty: false,

  setPrefabs(prefabs) {
    set((s) => ({ prefabs, version: s.version + 1 }));
  },

  bump() {
    set((s) => ({ version: s.version + 1 }));
  },

  enterStage(stage) {
    set({ stage, stageDirty: false });
  },

  markStageDirty(dirty = true) {
    set((s) => (s.stage ? { stageDirty: dirty } : {}));
  },

  exitStage() {
    set({ stage: null, stageDirty: false });
  },
})));

export const inPrefabMode = () => !!usePrefabStore.getState().stage;
