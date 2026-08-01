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
    await invoke("save_scene", { path: insideProject(path, { forWriting: true }), contents });
    await useProjectStore.getState().refresh();
    return { path };
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
