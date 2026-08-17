import { create } from "zustand";
import { vmSingleton } from "./singleton.js";
import { useProjectStore } from "./store/projectStore.js";
import { isPanelVisible } from "./EditorShell.jsx";

/**
 * "Show me where that is" for asset references.
 *
 * Clicking a material / geometry / texture / script slot in the inspector
 * points the Assets panel at the referenced file: it browses to the containing
 * folder, scrolls the tile into view and rings it.
 *
 * This deliberately does NOT go through `selectionStore.selectAsset`. Entity
 * selection and asset selection are mutually exclusive there, so selecting the
 * asset would drop the entity — closing the very component panel the user just
 * clicked in. A separate highlight channel keeps the entity selected and still
 * answers "which file is this?".
 */
export const useAssetRevealStore = vmSingleton("assetRevealStore", () => create((set) => ({
  path: null,
  // Bumped on every reveal so asking for the SAME asset twice still re-scrolls
  // and re-flashes the ring.
  token: 0,
  /**
   * Whether this reveal should also take keyboard focus.
   *
   * Off by default, and that default is the inspector's: clicking a material
   * slot must not yank focus out of the field you clicked. Quick search asks
   * for it, because there the reveal IS the user's whole gesture and the next
   * thing they press (Enter, to open) has to land on the grid. Focus beats
   * hover in `keyScope`, and after a modal closes the pointer is wherever it
   * was left — so without this the follow-up keystroke goes nowhere.
   */
  focus: false,
  reveal: (path, { focus = false } = {}) =>
    set((state) => ({ path, focus, token: state.token + 1 })),
  clear: () => set({ path: null, focus: false }),
})));

const norm = (p) => String(p ?? "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();

/**
 * Paths reaching this module come from two sources that spell them
 * differently: component props hold whatever the picker committed (forward
 * slashes), while directory listings come back from the OS with native
 * separators. Comparing them raw silently never matches on Windows.
 */
export const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

/** Folder part of an absolute asset path. */
const dirOf = (path) => path.replace(/[\\/][^\\/]+$/, "");

/**
 * Reveals `path` in the Assets panel when that panel is on screen; a no-op
 * otherwise, so clicking a field never yanks a panel open or navigates a
 * folder the user can't see happening.
 */
export async function revealAssetInPanel(path) {
  if (!path || !isPanelVisible("assets")) return false;
  const project = useProjectStore.getState();
  if (!project.rootPath) return false;
  // Outside the project tree (an absolute path typed in by hand, a stale
  // reference to a moved file) — nothing to browse to.
  if (!norm(path).startsWith(`${norm(project.rootPath)}/`)) return false;

  const dir = dirOf(path);
  if (dir && norm(dir) !== norm(project.currentPath)) {
    await project.navigate(dir);
  }
  useAssetRevealStore.getState().reveal(path);
  return true;
}
