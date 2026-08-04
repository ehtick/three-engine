import { useProjectStore } from "./store/projectStore.js";
import { listProjectEntries } from "./assetLoader.js";
import { loadAssetFlags } from "./assetFlags.js";
import { assetCatalog } from "../engine/assets/catalog.js";

/**
 * Fills `engine.assets`' name/tag catalog for the whole open project, so
 * `findByName`/`byTag` work from the first script run in Play mode rather
 * than only after the Assets panel happens to have scanned a folder.
 *
 * `loadAssetFlags` already reads every asset's `.meta` (tags included) into
 * `useAssetFlagsStore`, and that store's `merge` action already forwards
 * into `assetCatalog` (see assetFlags.js) — a full scan here is just "walk
 * the project, then run the existing flags loader over what it found".
 * Mirrors `loadProjectPrefabs` in prefab.js, which the editor boot sequence
 * already awaits alongside this.
 */
export async function loadProjectAssetCatalog() {
  const root = useProjectStore.getState().rootPath;
  assetCatalog.clear();
  if (!root) return;
  const entries = await listProjectEntries(root);
  await loadAssetFlags(entries);
  console.log(`Cataloged ${assetCatalog.all().length} asset(s)`);
}
