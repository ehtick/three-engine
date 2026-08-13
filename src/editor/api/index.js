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
import { vmSingleton } from "../singleton.js";

// Registering the op modules is a side effect of importing them — each one
// calls `defineOp` at module scope. Imported here (rather than lazily) so the
// registry is complete the moment anything can ask for the manifest.
import "./ops/entities.js";
import "./ops/editorState.js";
import "./ops/assets.js";
import "./ops/viewport.js";
import "./ops/authoring.js";
import "./ops/audio.js";
import "./ops/texture.js";
import "./ops/library.js";
import "./ops/geometry.js";
import "./ops/pipeline.js";
import "./ops/git.js";
import "./ops/fonts.js";
import "./ops/batch.js";
import "./ops/profile.js";
import "./ops/events.js";

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
  /**
   * Semantic version of the API surface, so a script or tool can feature-detect.
   * MINOR bumps when tools are added — an assistant holding a tool list from an
   * older editor can compare this against what it was told at connect time.
   */
  version: "1.4.0",

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
    /** World-space extents, children included — unknowable from transforms
     *  alone, since a "box" mesh's real size depends on geometry and scale. */
    getBounds: (id) => sync("entity.getBounds", { id }),
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
    /** Fog, environment, tone mapping, shadows — the scene's look. */
    getSettings: () => callOp("scene.getSettings"),
    setSettings: (patch, label) => callOp("scene.setSettings", label ? { patch, label } : { patch }),
  },

  project: {
    get: () => sync("project.get"),
    get rootPath() {
      return sync("project.get").rootPath;
    },
    /** Editor behaviour, hot reload, physics layers — project.json's `settings`. */
    getSettings: () => callOp("project.getSettings"),
    setSettings: (patch) => callOp("project.setSettings", { patch }),
  },

  // ---- assets ---------------------------------------------------------------

  assets: {
    list: (options = {}) => callOp("asset.list", options),
    read: (path) => callOp("asset.read", { path }).then((r) => r.contents),
    write: (path, contents) => callOp("asset.write", { path, contents }),
    createScript: (name, directory) => callOp("asset.createScript", { name, directory }),
    openInIDE: (path) => callOp("asset.openInIDE", { path }),
    reveal: (path) => callOp("asset.reveal", { path }),
    delete: (paths) => callOp("asset.delete", { paths: Array.isArray(paths) ? paths : [paths] }),
    rename: (path, name) => callOp("asset.rename", { path, name }),
    move: (paths, directory) => callOp("asset.move", { paths: Array.isArray(paths) ? paths : [paths], directory }),
    createFolder: (path) => callOp("asset.createFolder", { path }),
    /** Re-read files changed outside the editor. Omit `paths` to just re-list. */
    refresh: (paths) => callOp("asset.refresh", paths ? { paths: Array.isArray(paths) ? paths : [paths] } : {}),
    watchStatus: () => sync("asset.watchStatus"),
    /** What can be done with this asset — the Inspector's own action list. */
    actions: (path) => callOp("asset.actions", { path }),
    /** Run one of the ids `actions()` returned. */
    runAction: (path, action) => callOp("asset.runAction", { path, action }),
  },

  /** Typefaces: what the project has, what Google Fonts offers, and importing one. */
  fonts: {
    list: () => callOp("font.list"),
    inspect: (path) => callOp("font.inspect", { path }),
    search: (query, options = {}) => callOp("font.search", { query, ...options }),
    import: (family, weights) => callOp("font.import", weights ? { family, weights } : { family }),
  },

  /**
   * The editor's own code editor. `open` is how a tool shows the user the file
   * it is talking about; `openFiles` is worth checking before writing to one,
   * since unsaved edits in the panel would be clobbered.
   */
  code: {
    open: (path) => callOp("code.open", { path }),
    openFiles: () => callOp("code.openFiles"),
  },

  // ---- viewport -------------------------------------------------------------

  viewport: {
    /** Resolves to `{ __image, width, height }`; `__image.base64` is a PNG. */
    screenshot: (options = {}) => callOp("viewport.screenshot", options),
    getCamera: () => sync("viewport.getCamera"),
    setCamera: (position, target) => sync("viewport.setCamera", { position, target }),
    focus: (id, distance) => sync("viewport.focus", { id, distance }),
    /** Omit `enabled` to read the current setting rather than change it. */
    freezeWhenUnfocused: (enabled) => sync("viewport.setFreezeWhenUnfocused", { enabled }),
  },

  /** Recent editor console output — how a script's own errors are read back. */
  console: {
    read: (options = {}) => sync("console.read", options),
  },

  // ---- authoring ------------------------------------------------------------

  materials: {
    create: (name, fields = {}) => callOp("material.create", { name, ...fields }),
    get: (path) => callOp("material.get", { path }),
    set: (path, patch) => callOp("material.set", { path, patch }),
  },

  prefabs: {
    list: () => callOp("prefab.list"),
    instantiate: (path, options = {}) => callOp("prefab.instantiate", { path, ...options }),
    createFrom: (id, folder) => callOp("prefab.createFromEntity", { id, folder }),
  },

  modules: {
    list: () => callOp("module.list"),
    setEnabled: (id, enabled) => callOp("module.setEnabled", { id, enabled }),
  },

  /**
   * Sound: the free libraries (search, import, licence ledger) and the editor
   * (inspect and edit a file's track stack without opening the panel).
   */
  audio: {
    status: () => callOp("audio.library.status"),
    search: (query, options = {}) => callOp("audio.library.search", { query, ...options }),
    import: (id, provider = "freesound") => callOp("audio.library.import", { id, provider }),
    credits: () => callOp("audio.library.credits"),

    info: (path) => callOp("audio.info", { path }),
    tracks: (path) => callOp("audio.tracks", { path }),
    edit: (path, operation, options = {}) => callOp("audio.edit", { path, operation, ...options }),
    effects: () => callOp("audio.effects"),
    process: (path, effect, params = {}, options = {}) => callOp("audio.process", { path, effect, params, ...options }),
    generate: (path, generator, options = {}) => callOp("audio.generate", { path, generator, ...options }),
    addTrack: (path, sourcePath, options = {}) => callOp("audio.addTrack", { path, sourcePath, ...options }),
    setTrack: (path, track, patch = {}) => callOp("audio.setTrack", { path, track, ...patch }),
    removeTrack: (path, track) => callOp("audio.removeTrack", { path, track }),
    loop: (path, options = {}) => callOp("audio.loop", { path, ...options }),
    variations: (path, options = {}) => callOp("audio.variations", { path, ...options }),
    export: (path, options = {}) => callOp("audio.export", { path, ...options }),
  },

  /**
   * The asset libraries — Poly Haven, ambientCG, Sketchfab, itch.io — behind
   * one search/import pair, so finding a rock texture does not mean learning
   * four vocabularies.
   */
  library: {
    status: () => callOp("library.status"),
    search: (provider, query, options = {}) => callOp("library.search", { provider, query, ...options }),
    import: (provider, id, options = {}) => callOp("library.import", { provider, id, ...options }),
    setEnvironment: (path) => callOp("scene.setEnvironment", { path }),
  },

  /** Images: create, inspect, process, and pack into atlases. */
  textures: {
    info: (path) => callOp("texture.info", { path }),
    create: (directory, name, options = {}) => callOp("texture.create", { directory, name, ...options }),
    effects: () => callOp("texture.effects"),
    process: (path, effect, params = {}) => callOp("texture.process", { path, effect, params }),
    resize: (path, width, height, options = {}) => callOp("texture.resize", { path, width, height, ...options }),
    setMeta: (path, patch) => callOp("texture.setMeta", { path, ...patch }),
    addLayer: (path, options = {}) => callOp("texture.addLayer", { path, ...options }),
    setLayer: (path, layer, patch = {}) => callOp("texture.setLayer", { path, layer, ...patch }),
    removeLayer: (path, layer) => callOp("texture.removeLayer", { path, layer }),
    draw: (path, shape, options = {}) => callOp("texture.draw", { path, shape, ...options }),
    generate: (path, generator, options = {}) => callOp("texture.generate", { path, generator, ...options }),
    atlas: {
      pack: (paths, options = {}) => callOp("texture.atlas.pack", { paths, ...options }),
      get: (path) => callOp("texture.atlas.get", { path }),
      set: (path, patch) => callOp("texture.atlas.set", { path, ...patch }),
      export: (path, directory) => callOp("texture.atlas.export", { path, directory }),
    },
  },

  /** Edit Mode, driven from a script or a tool: begin, select, operate, commit. */
  geometry: {
    begin: (entityId) => callOp("geometry.beginEdit", { entityId }),
    status: () => callOp("geometry.status"),
    select: (action, options = {}) => callOp("geometry.select", { action, ...options }),
    operations: () => callOp("geometry.operations"),
    edit: (operation, params = {}) => callOp("geometry.edit", { operation, params }),
    transform: (options = {}) => callOp("geometry.transform", options),
    addPrimitive: (kind, options = {}) => callOp("geometry.addPrimitive", { kind, ...options }),
    remesh: (options = {}) => callOp("geometry.remesh", options),
    commit: (keepOpen = false) => callOp("geometry.commit", { keepOpen }),
    cancel: () => callOp("geometry.cancel"),
  },

  /** Compression, baking, building, publishing. */
  pipeline: {
    compress: (path, codec) => callOp("asset.compress", { path, codec }),
    compressAllTextures: () => callOp("asset.compressAllTextures"),
    bakeNavMesh: (options = {}) => callOp("nav.bake", options),
    createTerrain: (options = {}) => callOp("terrain.create", options),
  },

  /**
   * Version control. Every method maps to the button the Git panel offers, and
   * `status()` is the one to call first — it reports whether there is a
   * repository at all rather than throwing when there isn't.
   */
  git: {
    status: () => callOp("git.status"),
    init: (options = {}) => callOp("git.init", options),
    stage: (paths) => callOp("git.stage", paths ? { paths: Array.isArray(paths) ? paths : [paths] } : {}),
    unstage: (paths) => callOp("git.unstage", paths ? { paths: Array.isArray(paths) ? paths : [paths] } : {}),
    discard: (paths) => callOp("git.discard", { paths: Array.isArray(paths) ? paths : [paths] }),
    commit: (message, options = {}) => callOp("git.commit", { message, ...options }),
    diff: (options = {}) => callOp("git.diff", options),
    log: (options = {}) => callOp("git.log", options),
    show: (commit) => callOp("git.show", { commit }),
    branches: () => callOp("git.branches"),
    checkout: (ref, options = {}) => callOp("git.checkout", { ref, ...options }),
    deleteBranch: (name, force = false) => callOp("git.deleteBranch", { name, force }),
    merge: (ref) => callOp("git.merge", { ref }),
    abortMerge: () => callOp("git.abortMerge"),
    stash: (options = {}) => callOp("git.stash", options),
    stashPop: (index = 0) => callOp("git.stashPop", { index }),
    stashList: () => callOp("git.stashList"),
    remotes: () => callOp("git.remotes"),
    addRemote: (url, name = "origin") => callOp("git.addRemote", { url, name }),
    fetch: (options = {}) => callOp("git.fetch", options),
    pull: (options = {}) => callOp("git.pull", options),
    push: (options = {}) => callOp("git.push", options),
    setIdentity: (name, email, global = false) => callOp("git.setIdentity", { name, email, global }),
    lfs: (patterns) => callOp("git.lfs", patterns ? { patterns } : {}),
    github: {
      status: () => callOp("git.github.status"),
      login: (token) => callOp("git.github.login", { token }),
      createRepo: (name, options = {}) => callOp("git.github.createRepo", { name, ...options }),
    },
  },

  build: {
    get: () => callOp("build.getSettings"),
    set: (patch) => callOp("build.setSettings", { patch }),
    export: (target) => callOp("build.export", target ? { target } : {}),
    publish: () => callOp("build.publish"),
    preview: (lan = false) => callOp("build.preview", { lan }),
    /** The live, rebuild-on-every-edit server behind the viewport's Wi-Fi
     *  button. Sticky per project — a project left serving serves again on the
     *  next editor launch. Omit `enabled` to read the current state. */
    serve: (enabled) => callOp("build.serve", enabled === undefined ? {} : { enabled }),
  },

  /**
   * Runs several ops as one undo step. Takes `[{ op, args }]`; `"$0"` inside a
   * later step's args resolves to the id returned by step 0.
   */
  batch: (label, steps, options = {}) => callOp("batch", { label, steps, ...options }),

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

/**
 * VM-wide, not a module-level `let`.
 *
 * `installEditorApi` is idempotent within one copy of this module, which is not
 * the same as being idempotent. A second copy (Vite's `?t=` twin — and this
 * module is reached through a dynamic import, which is exactly what Vite
 * rewrites) would install a second editor API into the engine's slot and start
 * a SECOND gizmo pass: two `onPreRender` subscriptions, two `LineSegments` in
 * the scene, every gizmo drawn twice.
 */
const install = vmSingleton("editorApiInstall", () => ({ /** @type {(() => void) | null} */ uninstall: null }));

/**
 * Publishes the API to the script runtime and starts the gizmo pass. Called
 * once from the editor's engine bootstrap; the player never calls it, which is
 * what makes `Editor.*` throw there instead of silently half-working.
 */
export function installEditorApi() {
  if (install.uninstall) return install.uninstall;
  const unsetApi = setEditorApi(EditorApi);
  const stopGizmos = startGizmoPass();
  // Bring the bridge up from the stored editor preference. Done here rather
  // than from project settings because MCP is machine-wide, and doing it at
  // boot is what makes "I turned it on last week" still true today.
  import("../mcpPrefs.js").then((m) => m.applyStoredMcpPrefs()).catch(() => {});
  // Handy from the devtools console and from the puppeteer harnesses, which
  // have no other way to reach a module-scope object.
  globalThis.__editorApi = EditorApi;
  install.uninstall = () => {
    unsetApi();
    stopGizmos();
    if (globalThis.__editorApi === EditorApi) delete globalThis.__editorApi;
    install.uninstall = null;
  };
  return install.uninstall;
}
