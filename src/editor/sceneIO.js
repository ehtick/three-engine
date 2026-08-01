import * as THREE from "three/webgpu";
import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore } from "./store/projectStore.js";

let currentPath = null;

const SCENE_FILTERS = [{ name: "Scene", extensions: ["scene", "json"] }];
// Only consulted in the projectless ("Skip the project") path. With a real
// project open, the scene to restore is always resolved from that project's
// own project.json — never from a localStorage entry left over from a
// previous project. See restoreLastScene().
const LAST_SCENE_KEY = "engine.lastScene.v1";

export const hasScenePath = () => !!currentPath;
export const currentScenePath = () => currentPath;

/**
 * Flag consulted by EditorChrome on its mount effect. A single engine
 * instance lives across the editor's whole session (so it survives project
 * switches), so we have to remember whether the *current* project has been
 * booted yet. Project switching flips this back to `false` to force a fresh
 * boot of the new project.
 */
export let sceneBooted = false;
export function markSceneBooted() {
  sceneBooted = true;
}
export function resetSceneBooted() {
  sceneBooted = false;
}

/**
 * Wipes engine + scene-side bookkeeping. Called when switching projects so
 * a new project always starts clean — never inherits entities/components
 * left over from the previous one. The actual restore of project.json's
 * scene is left to EditorChrome's normal boot flow.
 */
export async function resetEditorScene() {
  await leavePrefabMode();
  const engine = await ensureEngine();
  engine.clear();
  currentPath = null;
  resetSceneBooted();
  afterSceneSwap(engine);
}

const projectRoot = () => useProjectStore.getState().rootPath;
const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|\/)/.test(p);

/** Path relative to the project root (forward slashes), or null if outside it. */
function toProjectRelative(root, path) {
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : null;
}

/**
 * Records where the current scene lives. With a project open this is written
 * to *that project's* project.json (the durable, per-project record); the
 * legacy localStorage entry is only set in the project-less ("Skip the
 * project") path. Mixing them would let a previous project's localStorage
 * entry bleed into the next project opened.
 */
function rememberScene(path) {
  currentPath = path;
  useSceneStore.getState().setScenePath(path);
  const root = projectRoot();
  if (root) {
    const rel = toProjectRelative(root, path);
    useProjectStore
      .getState()
      .updateMeta({ lastScene: rel ?? path })
      .catch((err) => console.warn(`Couldn't record lastScene in project.json: ${err}`));
  } else {
    localStorage.setItem(LAST_SCENE_KEY, path);
  }
}

/** Resolves the boot-time scene path from projectMeta: mainScene wins over
 *  lastScene (the user's chosen entry point always takes precedence over the
 *  last-edited scene). Returns absolute path or null. */
function resolveBootPath() {
  const root = projectRoot();
  if (!root) return null;
  const meta = useProjectStore.getState().projectMeta ?? {};
  const candidate = meta.mainScene || meta.lastScene;
  if (!candidate) return null;
  return isAbsolute(candidate) ? candidate : `${root}/${candidate}`;
}

/** Reloads the scene the editor should boot into. Validates the path exists
 *  before loading — a stale/missing mainScene silently failed before and then
 *  triggered an unwanted `newScene()` that polluted the project with auto-saved
 *  "Main 1"/"Main 2" files. Returns true on success, false (with a logged
 *  warning) when nothing could be restored. The caller decides what to do
 *  with that — see EditorChrome.
 *
 *  Scene resolution rules:
 *  - With a project open, the only valid source is *that project's* own
 *    project.json (mainScene / lastScene). A localStorage entry left over
 *    from a previous project is ignored — otherwise a freshly-created
 *    project would silently reopen the previous game's saved scene.
 *  - Without a project (the "Skip the project" path), legacy localStorage
 *    is the only available record.
 *  Callers are expected to clear the engine first (see resetEditorScene)
 *  when switching projects, so a project with no saved scene ends up
 *  truly empty rather than carrying the previous project's state. */
export async function restoreLastScene() {
  const engine = await ensureEngine();
  const root = projectRoot();
  let path = resolveBootPath();
  if (!path && !root) path = localStorage.getItem(LAST_SCENE_KEY);
  if (!path) return false;

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("stat_file", { path });
  } catch {
    const scope = root ? `project ${root}` : "saved scene";
    console.warn(`Saved scene not found on disk: ${path} — leaving editor empty (${scope}). Use File → New Scene or Open Scene…`);
    return false;
  }

  try {
    const { deserializeScene } = await import("../engine/index.js");
    const contents = await invoke("load_scene", { path });
    await deserializeScene(engine, JSON.parse(contents));
    engine.sceneName = sceneNameFromPath(path);
    currentPath = path;
    afterSceneSwap(engine);
    console.log(`Restored scene: ${path}`);
    return true;
  } catch (err) {
    console.warn(`Couldn't restore scene (${path}): ${err}`);
    return false;
  }
}

function afterSceneSwap(engine = null) {
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  useSceneStore.getState().refresh(currentPath);
  useSceneStore.getState().markDirty(false);
  // Keep the runtime scene manager's idea of "the scene you are in" aligned
  // with the editor's, so `engine.scenes.active` is meaningful while stopped
  // and Play starts from the right record.
  engine?.scenes?.reset({ path: currentPath, name: engine.sceneName });
}

/** Prefab Mode holds the scene suspended in memory. Any operation that swaps
 *  the scene out has to leave the stage first (saving the prefab), or the
 *  suspended scene would be silently dropped on the floor. */
async function leavePrefabMode() {
  const { isPrefabModeActive, exitPrefabMode } = await import("./prefab.js");
  if (isPrefabModeActive()) await exitPrefabMode({ save: true });
}

export async function newScene() {
  await leavePrefabMode();
  const engine = await ensureEngine();
  engine.clear();
  currentPath = null;
  useSceneStore.getState().setScenePath(null);
  engine.sceneName = projectRoot() ? "Main" : "Untitled";

  // Unity-style default content (not undoable — it's the baseline).
  const light = engine.createEntity({ name: "Directional Light" });
  light.addComponent("light", { kind: "directional", intensity: 2 });
  // Directional lights are pinned to the world origin; only their rotation
  // defines the emitted direction. Tilt the default sun downward at ~55°
  // pitch so the new scene has a clear key light from above-and-to-the-side.
  light.object3D.rotation.set(
    THREE.MathUtils.degToRad(-55),
    THREE.MathUtils.degToRad(35),
    0,
  );

  const camera = engine.createEntity({ name: "Main Camera" });
  camera.addComponent("camera");
  camera.object3D.position.set(0, 2, 6);

  const box = engine.createEntity({ name: "Box" });
  box.addComponent("mesh", { geometry: "box" });
  box.object3D.position.set(0, 0.5, 0);

  afterSceneSwap(engine);

  // With a project open the scene gets a real file immediately — edits are
  // never held only in memory / localStorage.
  if (projectRoot()) {
    saveScene().catch((err) => console.warn(`Couldn't save new scene: ${err}`));
  }
}

/** First free scenes/<name>.scene inside the project (never clobbers a stranger). */
async function uniqueScenePath(root, name) {
  const { invoke } = await import("@tauri-apps/api/core");
  for (let i = 0; ; i++) {
    const candidate = `${root}/scenes/${name}${i === 0 ? "" : ` ${i}`}.scene`;
    try {
      await invoke("stat_file", { path: candidate });
    } catch {
      return candidate; // stat failed → file doesn't exist → free
    }
  }
}

export async function saveScene({ saveAs = false } = {}) {
  const engine = await ensureEngine();

  // In Prefab Mode the viewport holds a prefab, not the scene — the scene is
  // suspended in memory. Saving must write the *prefab*; writing the scene file
  // here would overwrite the user's scene with the staged prefab's contents.
  // Routing it centrally covers Ctrl+S, the File menu and autosave at once.
  const { isPrefabModeActive, savePrefabStage } = await import("./prefab.js");
  if (isPrefabModeActive()) return savePrefabStage();

  let path = !saveAs && currentPath;
  if (!path) {
    const root = projectRoot();
    if (!saveAs && root) {
      // Inside a project, unsaved scenes get a path automatically — no dialog.
      path = await uniqueScenePath(root, engine.sceneName);
    } else {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultDir = root ? `${root}/scenes/` : "";
      path = await save({ filters: SCENE_FILTERS, defaultPath: `${defaultDir}${engine.sceneName}.scene` });
      if (!path) return false;
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { serializeScene } = await import("../engine/index.js");
  engine.sceneName = sceneNameFromPath(path);
  const contents = JSON.stringify(serializeScene(engine), null, 2);
  await invoke("save_scene", { path, contents });
  rememberScene(path);
  useSceneStore.getState().refresh();
  useSceneStore.getState().markDirty(false);
  console.log(`Scene saved: ${path}`);
  return true;
}

export async function openScene() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const root = projectRoot();
  const path = await open({
    multiple: false,
    filters: SCENE_FILTERS,
    defaultPath: root ?? undefined,
  });
  if (!path) return false;
  return openScenePath(path);
}

/** Loads a scene from a known path (double-click in Assets, project restore). */
export async function openScenePath(path) {
  await leavePrefabMode();
  const engine = await ensureEngine();
  const { invoke } = await import("@tauri-apps/api/core");
  const { deserializeScene } = await import("../engine/index.js");
  const contents = await invoke("load_scene", { path });
  await deserializeScene(engine, JSON.parse(contents));
  engine.sceneName = sceneNameFromPath(path);
  rememberScene(path);
  afterSceneSwap(engine);
  console.log(`Scene loaded: ${path}`);
  return true;
}

function sceneNameFromPath(path) {
  const base = path.split(/[\\/]/).pop() ?? "Untitled";
  return base.replace(/\.(scene|json)$/i, "");
}
