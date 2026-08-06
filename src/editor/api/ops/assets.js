/**
 * Project-file operations: list, read, write, create scripts, open in an IDE.
 *
 * Writes are confined to the open project folder by {@link insideProject}. This
 * is not a security boundary — a script already runs with the editor's full
 * privileges and can import Tauri itself — it is a blast-radius one. The
 * expected caller is a language model driving the MCP server, and a model that
 * has mixed up a relative and an absolute path should get an error, not
 * overwrite something in the user's home directory. The check is cheap and the
 * failure it prevents is not recoverable.
 */
import { defineOp } from "../registry.js";
import { useProjectStore } from "../../store/projectStore.js";
import { invoke } from "../../assetOps.js";
import { listProjectEntries, withoutSidecars, extOf } from "../../assetLoader.js";
import { createScriptFile } from "../../scriptAsset.js";
import { openInIDE } from "../../openInIde.js";
import { revealAssetInPanel } from "../../assetReveal.js";
import { refreshAssetFromDisk, watchedProjectRoot } from "../../projectWatcher.js";

const norm = (p) => String(p ?? "").replaceAll("\\", "/").replace(/\/+$/, "");

/** Absolute path inside the open project, or a thrown explanation. */
function insideProject(path, { forWriting = false } = {}) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  const target = norm(path);
  if (!target) throw new Error("A path is required.");
  const prefix = `${norm(root)}/`;
  const isInside = target.toLowerCase().startsWith(prefix.toLowerCase()) || target === norm(root);
  if (!isInside) {
    throw new Error(
      `"${path}" is outside the open project (${root}). ${forWriting ? "Writes are" : "Reads are"} limited to the project folder.`,
    );
  }
  return path;
}

defineOp({
  name: "asset.list",
  readOnly: true,
  description:
    "List files in the project. Recurses from the project root by default; pass `directory` to scope it and `ext` to filter by extension.",
  params: {
    directory: { type: "string", description: "Absolute folder to list; defaults to the project root." },
    ext: { type: "string", description: "Extension filter without the dot, e.g. 'ts', 'scene', 'mat'." },
    depth: { type: "number", default: 8, description: "Recursion depth." },
  },
  async run({ directory, ext, depth = 8 }) {
    const root = useProjectStore.getState().rootPath;
    if (!root) throw new Error("No project is open.");
    const from = directory ? insideProject(directory) : root;
    let entries = withoutSidecars(await listProjectEntries(from, depth));
    if (ext) {
      const wanted = ext.replace(/^\./, "").toLowerCase();
      entries = entries.filter((entry) => !entry.is_dir && extOf(entry.name) === wanted);
    }
    // Forward slashes, always. Directory listings come back from the OS with
    // native separators while every path the API *accepts* and every path
    // stored in a component prop uses forward slashes — so a caller that
    // compared a listed path against one it got from `entity.get` would find
    // they never match on Windows, for a reason nothing in the output hints at.
    return entries.map((entry) => ({
      path: entry.path.replaceAll("\\", "/"),
      name: entry.name,
      isDir: !!entry.is_dir,
      size: entry.size ?? null,
    }));
  },
});

defineOp({
  name: "asset.read",
  readOnly: true,
  description: "Read a text file from the project (scripts, scenes, materials, JSON).",
  params: { path: { type: "string", required: true } },
  async run({ path }) {
    return { path, contents: await invoke("read_text_file", { path: insideProject(path) }) };
  },
});

defineOp({
  name: "asset.write",
  description:
    "Write a text file in the project, creating or overwriting it. There is no undo for this — it is a file write, not an editor command.",
  params: {
    path: { type: "string", required: true },
    contents: { type: "string", required: true },
  },
  async run({ path, contents }) {
    // `save_scene` is the generic "write this text to this path" Tauri command
    // despite the name (it predates everything else that writes text).
    const full = insideProject(path, { forWriting: true });
    await invoke("save_scene", { path: full, contents });
    // Writing the bytes is not the same as the editor SEEING them. Every cache
    // downstream keys on the path — the asset loader's blob URL, the engine's
    // decoded material/geometry/atlas caches — and none of them can notice a
    // file it already read has changed. Without this, an agent writing a `.mat`
    // through this tool gets a correct file on disk and a viewport that keeps
    // rendering the old one until the editor is restarted, which is
    // indistinguishable from the tool not working.
    await refreshAssetFromDisk(full);
    await useProjectStore.getState().refresh();
    return { path };
  },
});

/** Sidecars follow their asset through a rename, a move and a delete. */
const SIDECAR_SUFFIXES = [".meta", ".basis", ".tex", ".aud"];

defineOp({
  name: "asset.refresh",
  description:
    "Re-read files from disk that changed without the editor writing them — after you edit project files with your own tools rather than through asset.write. Drops the editor's cached copy, reloads materials/textures/atlases/audio in the open scene, and re-lists the Assets panel. Pass `paths` for specific files, or omit it to just re-list the project. Note the editor also watches the project folder, so this is a way to force the issue, not the only way changes are noticed.",
  params: {
    paths: {
      type: "array",
      description: "Absolute paths that changed. Omit to re-list the project without reloading any asset.",
      items: { type: "string" },
    },
  },
  async run({ paths = [] }) {
    const targets = paths.map((path) => insideProject(path));
    for (const path of targets) await refreshAssetFromDisk(path);
    await useProjectStore.getState().refresh();
    return { refreshed: targets.map((p) => p.replaceAll("\\", "/")) };
  },
});

defineOp({
  name: "asset.watchStatus",
  readOnly: true,
  description:
    "Whether the editor is watching the project folder for changes made outside it. When `watching` is false (a browser session, or the watcher failed to start) you must call asset.refresh yourself after writing project files with tools other than this API.",
  params: {},
  run() {
    const root = watchedProjectRoot();
    return { watching: !!root, root };
  },
});

defineOp({
  name: "asset.delete",
  description:
    "Delete files or folders from the project, with their .meta/.basis/.tex/.aud sidecars. Folders go with everything inside them. THIS IS NOT UNDOABLE — it is a filesystem delete, not an editor command, and nothing in the editor's undo stack can bring the file back.",
  params: {
    paths: { type: "array", required: true, description: "Absolute paths to delete.", items: { type: "string" } },
  },
  async run({ paths }) {
    const deleted = [];
    for (const raw of paths) {
      const path = insideProject(raw, { forWriting: true });
      await invoke("delete_path", { path });
      for (const suffix of SIDECAR_SUFFIXES) {
        await invoke("delete_path", { path: `${path}${suffix}` }).catch(() => {});
      }
      deleted.push(path.replaceAll("\\", "/"));
    }
    await useProjectStore.getState().refresh();
    return { deleted };
  },
});

defineOp({
  name: "asset.rename",
  description:
    "Rename a file or folder in place, carrying its sidecars along. Renaming a script also rewrites its exported class name to match, the same as renaming it in the Assets panel does.",
  params: {
    path: { type: "string", required: true, description: "Absolute path of the asset to rename." },
    name: { type: "string", required: true, description: "New filename including extension." },
  },
  async run({ path, name }) {
    const from = insideProject(path, { forWriting: true }).replaceAll("\\", "/");
    const entry = { path: from, name: from.split("/").pop(), is_dir: false };
    const { renameEntry } = await import("../../assetOps.js");
    await renameEntry(entry, name);
    const to = `${from.slice(0, from.length - entry.name.length)}${name.trim()}`;
    return { from, to };
  },
});

defineOp({
  name: "asset.move",
  description: "Move files or folders into another folder in the project, sidecars included.",
  params: {
    paths: { type: "array", required: true, description: "Absolute paths to move.", items: { type: "string" } },
    directory: { type: "string", required: true, description: "Absolute destination folder." },
  },
  async run({ paths, directory }) {
    const dest = insideProject(directory, { forWriting: true });
    const sources = paths.map((path) => insideProject(path, { forWriting: true }));
    const { movePathsIntoFolder } = await import("../../assetOps.js");
    await movePathsIntoFolder(sources, dest);
    return { moved: sources.map((p) => p.replaceAll("\\", "/")), directory: dest.replaceAll("\\", "/") };
  },
});

defineOp({
  name: "asset.createFolder",
  description:
    "Create a folder in the project. Parents are created too, so one call is enough for a nested path.",
  params: {
    path: { type: "string", required: true, description: "Absolute path of the folder to create." },
  },
  async run({ path }) {
    const full = insideProject(path, { forWriting: true });
    await invoke("create_dir", { path: full });
    await useProjectStore.getState().refresh();
    return { path: full.replaceAll("\\", "/") };
  },
});

defineOp({
  name: "asset.createScript",
  description:
    "Create a new script from the starter template and return its path. The class name is derived from the filename.",
  params: {
    name: { type: "string", default: "NewScript.ts", description: "Filename; '.ts' is appended if missing." },
    directory: { type: "string", description: "Target folder; defaults to <project>/scripts." },
  },
  async run({ name = "NewScript.ts", directory }) {
    const path = await createScriptFile({
      name,
      directory: directory ? insideProject(directory, { forWriting: true }) : undefined,
    });
    return { path };
  },
});

defineOp({
  name: "asset.openInIDE",
  description: "Open a project file in the OS-default application for its type (an IDE, for scripts).",
  params: { path: { type: "string", required: true } },
  async run({ path }) {
    return { opened: await openInIDE(insideProject(path)) };
  },
});

defineOp({
  name: "asset.reveal",
  description: "Browse the Assets panel to a file and flash it, so the user can see what you are referring to.",
  params: { path: { type: "string", required: true } },
  async run({ path }) {
    return { revealed: await revealAssetInPanel(insideProject(path)) };
  },
});
