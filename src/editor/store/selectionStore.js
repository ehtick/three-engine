import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

/**
 * `ids` as a Set, memoized on the array's identity.
 *
 * Every hierarchy row asks "am I selected?" on every selection change, and the
 * obvious `ids.includes(id)` is O(n) per row — fine for a handful of rows, and
 * 2.25 million comparisons per keystroke once someone searches 1500 meshes and
 * selects the lot. The store hands out a fresh array on every write, so array
 * identity is a sound cache key: one Set is built per selection change and every
 * row after the first reads it in O(1).
 */
let selectedCache = { ids: /** @type {any} */ (null), set: new Set() };
export function selectedIdSet(ids) {
  if (selectedCache.ids !== ids) selectedCache = { ids, set: new Set(ids) };
  return selectedCache.set;
}

// VM-wide: a duplicate copy of this module (HMR / Vite `?t=`) would give the
// selection ops a store the mounted panels are not subscribed to, so selecting
// from a script or over MCP would change nothing on screen. See singleton.js.
export const useSelectionStore = vmSingleton("selectionStore", () =>
  create((set, get) => ({
    ids: [],
    anchorId: null, // last plainly-clicked id; shift-click ranges extend from here

    // Assets panel selection. `assetPath` is the *primary* (last-clicked) asset —
    // it's what the inspector shows and what single-asset panels key off. When
    // several assets are selected, `assetPaths` holds all of them (including the
    // primary) and `assetAnchor` is the tile shift-click ranges extend from.
    assetPath: null,
    assetPaths: [],
    assetAnchor: null,

    select(ids, anchorId) {
      const list = Array.isArray(ids) ? ids : [ids];
      set({
        ids: list,
        anchorId: anchorId ?? list[0] ?? null,
        assetPath: null,
        assetPaths: [],
        assetAnchor: null,
      });
    },

    /** Ctrl/Cmd-click: add or remove one id without touching the rest. */
    toggle(id) {
      const ids = get().ids.includes(id)
        ? get().ids.filter((x) => x !== id)
        : [...get().ids, id];
      set({ ids, anchorId: id, assetPath: null, assetPaths: [], assetAnchor: null });
    },

    /**
     * Unions `ids` into the selection, preserving what was already there.
     *
     * Ctrl+Shift-click (extend a range without dropping the earlier ranges) and
     * "select all search results, keeping what I picked in another query" both
     * need this, and neither can be spelled with `select` (which replaces) or
     * repeated `toggle` (which would deselect anything already in the range).
     * A Set does the dedupe so the caller can pass overlapping ranges freely.
     */
    add(ids, anchorId) {
      const list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return;
      const merged = [...new Set([...get().ids, ...list])];
      set({
        ids: merged,
        anchorId: anchorId ?? get().anchorId ?? list[0] ?? null,
        assetPath: null,
        assetPaths: [],
        assetAnchor: null,
      });
    },

    /** Removes `ids` from the selection, leaving the rest alone. */
    remove(ids) {
      const drop = new Set(Array.isArray(ids) ? ids : [ids]);
      if (!drop.size) return;
      const kept = get().ids.filter((id) => !drop.has(id));
      if (kept.length === get().ids.length) return;
      set({ ids: kept, anchorId: kept.includes(get().anchorId) ? get().anchorId : (kept[kept.length - 1] ?? null) });
    },

    selectAsset(path) {
      set({ ids: [], anchorId: null, assetPath: path, assetPaths: [path], assetAnchor: path });
    },

    /**
     * Replaces the asset selection with `paths`. `primary` (defaulting to the
     * last path) becomes the inspected asset; `anchor` seeds future shift-click
     * ranges and defaults to the primary. Box-select passes its own anchor so
     * dragging a marquee doesn't move the range origin.
     */
    selectAssets(paths, { primary, anchor } = {}) {
      const list = [...new Set(paths)];
      const head = primary ?? list[list.length - 1] ?? null;
      set({
        ids: [],
        anchorId: null,
        assetPath: head,
        assetPaths: list,
        assetAnchor: anchor ?? head,
      });
    },

    /** Ctrl/Cmd-click on a tile: add or remove one asset without touching the rest. */
    toggleAsset(path) {
      const current = get().assetPaths;
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      set({
        ids: [],
        anchorId: null,
        assetPaths: next,
        // Keep an inspector target as long as anything is selected.
        assetPath: next.includes(path) ? path : (next[next.length - 1] ?? null),
        assetAnchor: path,
      });
    },

    clear() {
      set({ ids: [], anchorId: null, assetPath: null, assetPaths: [], assetAnchor: null });
    },

    /**
     * Drops only the asset half of the selection. Browsing to another folder has
     * to forget the tiles that are no longer on screen, but it must NOT forget
     * the selected entity — the inspector is showing that entity's components,
     * and the Assets panel navigating (which the inspector itself can trigger,
     * see assetReveal.js) would otherwise blank the panel you clicked from.
     */
    clearAssets() {
      set({ assetPath: null, assetPaths: [], assetAnchor: null });
    },

    /** Drop ids that no longer exist (after deletes / scene loads). */
    prune(existingIds) {
      const ids = get().ids.filter((id) => existingIds.has(id));
      if (ids.length !== get().ids.length) set({ ids });
    },
  })),
);
