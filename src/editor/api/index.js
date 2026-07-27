/**
 * The Editor API: what `import { Editor } from "editor"` gives a script, and
 * what a future MCP server exposes as tools.
 *
 * Both consumers run through `registry.js`. This module is the ergonomic half —
 * `Editor.entities.create({ name })` rather than `callOp("entity.create", …)` —
 * because the two audiences want opposite shapes from the same capability. A
 * model wants a flat, described, validated tool list. A person writing a tool
 * script wants namespaces, sensible defaults and the live objects. Building the
 * second on top of the first is what stops them drifting: there is no path into
 * the editor that skips the registry, so anything a script can do is
 * automatable and vice versa.
 *
 * ## Sync where it can be, async where it must be
 *
 * `callOp` always returns a promise. Most ops are synchronous underneath (they
 * push a command and read the result back), and making a script `await` a
 * position read would be miserable. So read-heavy accessors here call the op's
 * `run` directly and return the value; anything that touches the filesystem or
 * play mode stays a promise. The rule is visible at the call site: properties
 * and `get*` are sync, verbs that hit disk are async.
 */
import {
  callOp,
  callTool,
  listOps,
  getOp,
  toolManifest,
  validateArgs,
  resolveToolName,
} from "./registry.js";
import { engine } from "../engineInstance.js";
import { setEditorApi, registerMenuItem, listMenuItems, subscribeMenuItems } from "../../engine/editorBridge.js";
import { startGizmoPass } from "../gizmos.js";

// Registering the op modules is a side effect of importing them — each one
// calls `defineOp` at module scope. Imported here (rather than lazily) so the
// registry is complete the moment anything can ask for the manifest.
import "./ops/entities.js";
import "./ops/editorState.js";
import "./ops/assets.js";

/** Runs an op synchronously, asserting it isn't one of the async ones. Used by
 *  the sync accessors below, where returning a promise would be a footgun. */
function sync(name, args = {}) {
  const op = getOp(name);
  const result = op.run(validateArgs(op, args));
  if (result && typeof result.then === "function") {
    throw new Error(`Editor op "${name}" is async — use the promise-returning form`);
  }
  return result;
}

export const EditorApi = {
  /** Semantic version of the API surface, so a script or tool can feature-detect. */
  version: "1.0.0",

  // ---- raw registry access (the MCP-facing half) ----------------------------

  /** Every op descriptor: `{ name, description, params, readOnly, undoable }`.
   *  `run` and the registry's internal fingerprint are stripped — neither is
   *  meaningful to a caller, and `run` cannot cross a transport. */
  ops: () => listOps().map(({ run, _fingerprint, ...rest }) => rest),
  /** MCP tool descriptors — `{ name, description, inputSchema }`. */
  tools: (options) => toolManifest(options),
  /** Call an op by name; throws on error. The escape hatch for anything the
   *  namespaces below don't wrap. */
  call: callOp,
  /** Transport form of `call`: returns `{ ok, result }` / `{ ok, error }`. */
  callTool,
  resolveToolName,

  // ---- entities -------------------------------------------------------------

  entities: {
    /** Serializable descriptions of every entity, optionally filtered. */
    all: (filter = {}) => sync("entity.list", filter),
    /** One entity's description, or throws if the id is unknown. */
    get: (id) => sync("entity.get", { id }),
    /**
     * The LIVE `Entity` — the same object a gameplay script gets from
     * `this.entity`, with its Object3D, components and methods.
     *
     * Deliberately not an op: it cannot cross a transport, and pretending
     * otherwise would mean the MCP server silently returned a different thing
     * than a script does. Reach for it when you want to read a matrix or call
     * an engine method; use the op-backed accessors when you want to CHANGE
     * something, so the edit lands on the undo stack.
     */
    live: (id) => engine.getEntity(id) ?? null,
    create: (spec = {}) => sync("entity.create", spec),
    delete: (ids) => sync("entity.delete", { ids: Array.isArray(ids) ? ids : [ids] }),
    rename: (id, name) => sync("entity.rename", { id, name }),
    reparent: (id, parentId, index) => sync("entity.reparent", { id, parentId, index }),
    duplicate: (ids) => sync("entity.duplicate", { ids: Array.isArray(ids) ? ids : [ids] }),
    setTransform: (id, transform) => sync("entity.setTransform", { id, ...transform }),
    setTags: (id, tags) => sync("entity.setTags", { id, tags }),
  },

  // ---- components -----------------------------------------------------------

  components: {
    /** Every registered component type with its label, defaults and schema. */
    types: () => sync("component.types"),
    add: (id, type, props = {}) => sync("component.add", { id, type, props }),
    remove: (id, type) => sync("component.remove", { id, type }),
    setProp: (id, type, key, value) => sync("component.setProp", { id, type, key, value }),
  },

  // ---- selection ------------------------------------------------------------

  selection: {
    /** `{ entityIds, entities, assetPaths, assetPath }`. */
    get: () => sync("selection.get"),
    /** Just the ids — the common case, and cheap. */
    get ids() {
      return sync("selection.get").entityIds;
    },
    /** Live `Entity` objects for the current selection. */
    get entities() {
      return sync("selection.get").entityIds.map((id) => engine.getEntity(id)).filter(Boolean);
    },
    set: (ids) => sync("selection.set", { ids: Array.isArray(ids) ? ids : [ids] }),
    clear: () => sync("selection.set", { ids: [] }),
    selectAssets: (paths) => sync("selection.selectAssets", { paths: Array.isArray(paths) ? paths : [paths] }),
  },

  // ---- history --------------------------------------------------------------

  history: {
    get: () => sync("history.get"),
    undo: () => sync("history.undo"),
    redo: () => sync("history.redo"),
  },

  // ---- play mode ------------------------------------------------------------

  play: {
    get isPlaying() {
      return !!engine.playing;
    },
    start: () => callOp("play.set", { playing: true }),
    stop: () => callOp("play.set", { playing: false }),
  },

  // ---- scene / project ------------------------------------------------------

  scene: {
    get: () => sync("scene.get"),
    save: () => callOp("scene.save"),
    open: (path) => callOp("scene.open", { path }),
  },

  project: {
    get: () => sync("project.get"),
    get rootPath() {
      return sync("project.get").rootPath;
    },
  },

  // ---- assets ---------------------------------------------------------------

  assets: {
    list: (options = {}) => callOp("asset.list", options),
    read: (path) => callOp("asset.read", { path }).then((r) => r.contents),
    write: (path, contents) => callOp("asset.write", { path, contents }),
    createScript: (name, directory) => callOp("asset.createScript", { name, directory }),
    openInIDE: (path) => callOp("asset.openInIDE", { path }),
    reveal: (path) => callOp("asset.reveal", { path }),
  },

  // ---- editor chrome --------------------------------------------------------

  menu: {
    /** Adds a menu entry at `"TopMenu/Label"`. Returns an unregister function. */
    add: registerMenuItem,
    list: listMenuItems,
    subscribe: subscribeMenuItems,
  },

  /** Writes to the editor's console panel, tagged so it's clear where it came
   *  from. Scripts can just use `console.log`; this is here so remote callers
   *  have a way to say something to the user. */
  log: (...args) => console.log("[editor api]", ...args),
};

let uninstall = null;

/**
 * Publishes the API to the script runtime and starts the gizmo pass. Called
 * once from the editor's engine bootstrap; the player never calls it, which is
 * what makes `Editor.*` throw there instead of silently half-working.
 */
export function installEditorApi() {
  if (uninstall) return uninstall;
  const unsetApi = setEditorApi(EditorApi);
  const stopGizmos = startGizmoPass();
  // Bring the bridge up from the stored editor preference. Done here rather
  // than from project settings because MCP is machine-wide, and doing it at
  // boot is what makes "I turned it on last week" still true today.
  import("../mcpPrefs.js").then((m) => m.applyStoredMcpPrefs()).catch(() => {});
  // Handy from the devtools console and from the puppeteer harnesses, which
  // have no other way to reach a module-scope object.
  globalThis.__editorApi = EditorApi;
  uninstall = () => {
    unsetApi();
    stopGizmos();
    if (globalThis.__editorApi === EditorApi) delete globalThis.__editorApi;
    uninstall = null;
  };
  return uninstall;
}
