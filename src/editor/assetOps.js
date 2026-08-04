import { useProjectStore } from "./store/projectStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { syncScriptClassNameAfterRename } from "./scriptClassSync.js";
import { confirm } from "@tauri-apps/plugin-dialog";

/**
 * Filesystem operations behind the Assets panel (create / rename / move /
 * delete). Kept out of the panel components so the grid and the folder tree
 * can share them without importing each other.
 */

export async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Normalised path for case-insensitive prefix/suffix comparisons. */
const norm = (p) => p.replaceAll("\\", "/").toLowerCase();

/** First "name", "name 1", "name 2"… not already taken in the folder. */
export function uniqueName(baseName, entries) {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(baseName)) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  for (let i = 1; ; i++) {
    const name = `${stem} ${i}${ext}`;
    if (!names.has(name)) return name;
  }
}

export async function createAssetFile(baseName, contents) {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName(baseName, entries);
  await invoke("save_scene", { path: `${currentPath}/${name}`, contents });
  await refresh();
  console.log(`Created ${name}`);
}

export async function createFolder() {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName("New Folder", entries);
  await invoke("create_dir", { path: `${currentPath}/${name}` });
  await refresh();
}

/**
 * Ctrl+G in the Assets panel: makes a new folder next to the selection and
 * moves everything selected into it, then opens it for renaming.
 *
 * Tidying a folder otherwise means "new folder, rename it, select the files
 * again, drag them in" — four steps for something the hierarchy has done with
 * one keystroke since day one.
 *
 * The folder is created as a sibling of the selection rather than inside the
 * browsed folder, so grouping a selection that came from a project-wide search
 * still lands somewhere sensible.
 */
export async function groupIntoFolder(entries, { name = "New Folder" } = {}) {
  const list = entries.filter(Boolean);
  if (!list.length) return null;
  const { currentPath, entries: siblings, refresh } = useProjectStore.getState();
  const parent = list[0].path.slice(0, list[0].path.length - list[0].name.length - 1) || currentPath;
  if (!parent) return null;
  // A folder can't be moved into itself; drop any selected folder that would
  // become its own ancestor (only possible when the name collides).
  const folderName = uniqueName(name, siblings);
  const dest = `${parent}/${folderName}`;
  try {
    await invoke("create_dir", { path: dest });
  } catch (err) {
    console.error(`Couldn't create "${folderName}": ${err}`);
    return null;
  }
  await movePathsIntoFolder(list.map((entry) => entry.path), dest);
  await refresh();
  useSelectionStore.getState().selectAsset(dest);
  console.log(`Grouped ${list.length} ${list.length === 1 ? "asset" : "assets"} into ${folderName}`);
  return dest;
}

/**
 * Deletes one or more entries after a single confirmation. Each asset's
 * `.meta` sidecar goes with it.
 */
export async function deleteEntries(entries) {
  const list = entries.filter(Boolean);
  if (!list.length) return;
  const message =
    list.length === 1
      ? `Delete "${list[0].name}"${list[0].is_dir ? " and everything inside it" : ""}? This can't be undone.`
      : `Delete ${list.length} items? Folders are deleted with everything inside them. This can't be undone.`;
  let ok = false;
  try {
    ok = await confirm(message, {
      title: list.length === 1 ? "Delete asset" : "Delete assets",
      kind: "warning",
    });
  } catch (err) {
    // Browser-based development has no native dialog host. Keep asset
    // deletion usable there and avoid turning a dialog bootstrap failure
    // into an unhandled rejection.
    console.warn(`Native delete confirmation unavailable: ${err}`);
    ok = window.confirm(message);
  }
  if (!ok) return;

  const deleted = [];
  for (const entry of list) {
    try {
      await invoke("delete_path", { path: entry.path });
      // `.meta` and `.basis` sidecars only exist alongside texture files —
      // skipping them for directories avoids a noisy "system cannot find the
      // path specified" warning from the Rust side on every folder delete,
      // since Tauri logs IPC errors to its own channel even when the JS side
      // .catch()es them.
      if (!entry.is_dir) {
        await invoke("delete_path", { path: `${entry.path}.meta` }).catch(() => {});
        await invoke("delete_path", { path: `${entry.path}.basis` }).catch(() => {});
        await invoke("delete_path", { path: `${entry.path}.tex` }).catch(() => {});
        // Legacy GI mesh-SDF sidecars (pre-Library). New bakes live under
        // `<project>/Library/gi-sdf/`; this just sweeps the old neighbour files.
        await invoke("delete_path", { path: `${entry.path}.sdf` }).catch(() => {});
      }
      deleted.push(entry.path);
    } catch (err) {
      console.error(`Delete failed for ${entry.name}: ${err}`);
    }
  }
  if (!deleted.length) return;

  // Drop anything that just went away from the selection.
  const { assetPaths, assetPath, selectAssets, clear } = useSelectionStore.getState();
  const gone = new Set(deleted);
  const kept = assetPaths.filter((p) => !gone.has(p));
  if (kept.length) selectAssets(kept);
  else if (assetPath == null || gone.has(assetPath)) clear();

  const project = useProjectStore.getState();
  // If the folder we're currently browsing is gone (or sits inside a deleted
  // folder) the grid would otherwise list a path that no longer exists and
  // surface a "system cannot find the path specified" error. Step up to the
  // nearest surviving ancestor so the user lands on a folder they can still
  // see the contents of.
  const deletedNorm = new Set(deleted.map(norm));
  const isDeletedOrInside = (path) => {
    if (!path) return false;
    const np = norm(path);
    if (deletedNorm.has(np)) return true;
    for (const d of deletedNorm) if (np.startsWith(`${d}/`)) return true;
    return false;
  };
  let nextPath = null;
  if (isDeletedOrInside(project.currentPath)) {
    let cursor = project.currentPath;
    const root = project.rootPath;
    while (cursor && isDeletedOrInside(cursor)) {
      const parent = cursor.replace(/[\\/][^\\/]+$/, "");
      // Reached the project root without escaping the deleted subtree —
      // there's nothing above to step up to.
      if (!parent || parent === cursor || norm(parent) === norm(root ?? "")) {
        cursor = root;
        break;
      }
      cursor = parent;
    }
    nextPath = cursor || root;
  }

  if (nextPath) {
    await project.navigate(nextPath);
  } else {
    await project.refresh();
  }
  console.log(deleted.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${deleted.length} assets`);
}

export async function renameEntry(entry, newName) {
  const name = newName.trim();
  if (!name || name === entry.name) return;
  const dir = entry.path.slice(0, entry.path.length - entry.name.length);
  const newPath = `${dir}${name}`;
  try {
    await invoke("rename_path", { from: entry.path, to: newPath });
    // Keep texture import settings attached across the rename.
    await invoke("rename_path", { from: `${entry.path}.meta`, to: `${newPath}.meta` }).catch(() => {});
    await invoke("rename_path", { from: `${entry.path}.basis`, to: `${newPath}.basis` }).catch(() => {});
    await invoke("rename_path", { from: `${entry.path}.tex`, to: `${newPath}.tex` }).catch(() => {});

    // Scripts: rewrite the default-exported class name to match the new
    // filename stem, and inject `extends Script` if the script predates the
    // engine base class.
    const newStem = name.replace(/\.(ts|js)$/i, "");
    await syncScriptClassNameAfterRename(newPath, newStem);

    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Rename failed: ${err}`);
  }
}

/** True when moving `sourcePath` into `destDir` would be a no-op or a cycle. */
function badMove(sourcePath, destDir) {
  if (!sourcePath || !destDir || sourcePath === destDir) return true;
  const name = sourcePath.split(/[\\/]/).pop();
  if (`${destDir}/${name}` === sourcePath) return true;
  // Refuse moving a folder into itself/a descendant.
  return norm(destDir).startsWith(`${norm(sourcePath)}/`);
}

/** Moves files/folders into a target directory (drag-drop onto a folder). */
export async function movePathsIntoFolder(sourcePaths, destDir) {
  const paths = [...new Set(sourcePaths)].filter((p) => !badMove(p, destDir));
  if (!paths.length) return;
  let moved = 0;
  for (const sourcePath of paths) {
    const name = sourcePath.split(/[\\/]/).pop();
    const dest = `${destDir}/${name}`;
    try {
      await invoke("rename_path", { from: sourcePath, to: dest });
      await invoke("rename_path", { from: `${sourcePath}.meta`, to: `${dest}.meta` }).catch(() => {});
      await invoke("rename_path", { from: `${sourcePath}.basis`, to: `${dest}.basis` }).catch(() => {});
      await invoke("rename_path", { from: `${sourcePath}.tex`, to: `${dest}.tex` }).catch(() => {});
      moved++;
    } catch (err) {
      console.error(`Move failed for ${name}: ${err}`);
    }
  }
  if (!moved) return;
  useSelectionStore.getState().clear();
  await useProjectStore.getState().refresh();
  console.log(moved === 1 ? `Moved ${paths[0].split(/[\\/]/).pop()}` : `Moved ${moved} assets`);
}

/**
 * Drop handler for asset drags: when the dragged tile is part of the current
 * multi-selection the whole selection travels with it, otherwise just the one.
 */
export function moveDraggedIntoFolder(draggedPath, destDir) {
  const { assetPaths } = useSelectionStore.getState();
  const paths = assetPaths.includes(draggedPath) ? assetPaths : [draggedPath];
  return movePathsIntoFolder(paths, destDir);
}

export function formatBytes(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(seconds) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
