// @ts-check
import { create } from "zustand";
import { ensureEngine } from "../engineInstance.js";

/**
 * Editor mirror of the engine's InputManager. The manager is the source of
 * truth; this store mirrors its serialized state for React rendering and
 * applies user edits back via `engine.applyInput(json)`.
 *
 * Why serialized? Mutations on the live manager aren't reactive — even if
 * we patched every binding, the React panel would need to know. We round-
 * trip through the manager's toJSON/fromJSON so the editor's "save" and
 * "live update" share a single code path, and panel edits are atomic.
 */
export const useInputStore = create((set) => ({
  snapshot: null, // JSON produced by InputManager.toJSON()
  selectedMap: null,
  selectedAction: null,
  dirty: false,

  /** Hydrates from the live engine; called after ensureEngine() resolves. */
  hydrate() {
    const engine = engineInstanceCache;
    if (!engine) return;
    set({ snapshot: engine.input.toJSON(), dirty: false, selectedMap: null, selectedAction: null });
  },

  /** Applies an in-memory patch and pushes it to the live engine so the user
   *  sees the effect immediately (e.g. toggling `space: "camera"` on the Move
   *  action should change WASD behavior right away, not after a Save click).
   *  The on-disk commit is still gated by the explicit Save button — that
   *  way edits during a session don't overwrite project.json unless the user
   *  confirms. */
  patch(updater) {
    const snap = engineInstanceCache?.input?.toJSON();
    if (!snap) return;
    const next = updater(structuredClone(snap));
    set({ snapshot: next, dirty: true });
    // Push to the engine right away so the live InputManager reflects the
    // edit. applyInput rebuilds the manager; cheap relative to the React
    // rerender that's about to happen.
    engineInstanceCache?.applyInput(next);
  },

  /** Commits the staged snapshot to the engine + project.json. */
  async commit() {
    const engine = engineInstanceCache;
    const snap = useInputStore.getState().snapshot;
    if (!engine || !snap) return;
    engine.applyInput(snap);
    const { useProjectStore } = await import("./projectStore.js");
    await useProjectStore.getState().updateMeta({ input: snap });
    set({ dirty: false });
  },

  selectMap(name) {
    set({ selectedMap: name, selectedAction: null });
  },

  selectAction(mapName, actionName) {
    set({ selectedMap: mapName, selectedAction: actionName });
  },
}));

let engineInstanceCache = null;
ensureEngine().then((engine) => {
  engineInstanceCache = engine;
  // Re-hydrate after an `applyInput` swap so the panel sees the new map list.
  engine.on("input-changed", () => useInputStore.getState().hydrate());
  // First-time hydration once the engine is built.
  useInputStore.getState().hydrate();
});