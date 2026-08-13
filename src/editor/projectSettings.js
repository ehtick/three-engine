import { vmSingleton } from "./singleton.js";
import { useProjectStore } from "./store/projectStore.js";
import { ensureEngine } from "./engineInstance.js";
// layers.js is dependency-free (no Rapier, no wasm) — safe to pull into the
// editor's settings module without dragging the physics module in with it.
import { DEFAULT_PHYSICS_LAYERS } from "../modules/physics-rapier/layers.js";
import { BUILD_DEFAULTS } from "./build/buildSettings.js";

/**
 * Project-wide settings, stored under `settings` in project.json. Scene-look
 * settings (background/fog/tonemapping…) are per-scene — see SceneSettings.
 * These cover the editor, scripts, performance, and export metadata.
 */
export const PROJECT_SETTINGS_DEFAULTS = {
  editor: {
    autosaveSeconds: 10, // 0 = disabled
    snapTranslate: 0.5,
    snapRotateDeg: 15,
    snapScale: 0.1,
    gridSize: 40,
    gridDivisions: 40,
    showGrid: true,
    // Viewport Layers dropdown toggles. Persisted per-project so a return
    // visit picks up the user's preferred view (e.g. "hide colliders +
    // grid for a clean scene review").
    layers: { gizmos: true, colliders: true, grid: true, stats: true, debugDraw: true, uiOverlay: false, virtualGeometry: false },
    // User-rebindable visibility hotkeys (H, Shift+H, E, Shift+E by
    // default). Each entry maps an action id → chord string; the
    // dispatcher in keybindings.js reads this on every keydown so
    // changes apply immediately after Save.
    keybindings: {},
    // Watch the project folder and re-read files written by anything other
    // than the editor (an agent's file tools, an IDE, a paint program, a
    // `git checkout`). Off = the editor as it behaved before the watcher
    // existed: external edits appear only after `asset.refresh` or a
    // restart. Worth turning off when the project lives on a network share
    // or a build step churns thousands of files under the project root.
    watchProject: true,
  },
  scripts: {
    hotReload: true,
    reloadIntervalMs: 750,
  },
  // NOTE: MCP settings deliberately do NOT live here. The server is registered
  // with the user's CLIs machine-wide, so enabling the bridge is a fact about
  // the person, not the project — and storing it per-project meant every new
  // project came up disabled. See `mcpPrefs.js`.
  rendering: {
    pixelRatioCap: 2, // upper bound on devicePixelRatio
  },
  game: {
    title: "", // exported page title; empty = project name
    // Namespaces save slots + preferences so two games served from the same
    // origin (itch.io, a shared dev server) can't read each other's saves.
    // Empty = derived from the title — which means RENAMING THE GAME ORPHANS
    // EXISTING SAVES. Pin an id here to keep them across a rename.
    saveId: "",
    // The game's own save-data version. Bump it when the shape of what your
    // scripts write in `onSave` changes, and register a migration
    // (`engine.saves.registerMigration`) — an older save with no path forward
    // is refused rather than fed to scripts that no longer understand it.
    saveVersion: 1,
  },
  // How the project turns into a shipped game: which scene boots, which
  // scenes ship, the quality ceiling, the delivery target, the icon and the
  // loading screen. Edited in the Build panel. See build/buildSettings.js —
  // the defaults live there so the export path can be tested without the
  // editor's stores.
  build: { ...BUILD_DEFAULTS },
  // Collision layers + the matrix saying which pairs interact. Project-wide
  // (every scene shares them) and shipped with the build. `matrix[i]` is a
  // bitmask of the layers layer `i` collides with; null = everything collides,
  // which is what projects had before layers existed.
  physics: {
    layers: [...DEFAULT_PHYSICS_LAYERS],
    matrix: null,
  },
};

function mergeSection(defaults, saved) {
  return { ...defaults, ...(saved ?? {}) };
}

/** Current settings: project.json's `settings` merged over the defaults. */
export function getProjectSettings() {
  const saved = useProjectStore.getState().projectMeta?.settings ?? {};
  return {
    editor: mergeSection(PROJECT_SETTINGS_DEFAULTS.editor, saved.editor),
    scripts: mergeSection(PROJECT_SETTINGS_DEFAULTS.scripts, saved.scripts),
    rendering: mergeSection(PROJECT_SETTINGS_DEFAULTS.rendering, saved.rendering),
    game: mergeSection(PROJECT_SETTINGS_DEFAULTS.game, saved.game),
    physics: mergeSection(PROJECT_SETTINGS_DEFAULTS.physics, saved.physics),
    build: {
      ...mergeSection(PROJECT_SETTINGS_DEFAULTS.build, saved.build),
      // `loading` is the one nested object in this section, and a flat spread
      // would drop the defaults for any key the saved settings predate.
      loading: { ...PROJECT_SETTINGS_DEFAULTS.build.loading, ...(saved.build?.loading ?? {}) },
    },
  };
}

/** Persists settings into project.json and applies them everywhere. */
export async function saveProjectSettings(settings) {
  await useProjectStore.getState().updateMeta({ settings });
  await applyProjectSettings(settings);
}

// Consumers that hold live objects (viewport grid…) subscribe to re-apply.
// VM-wide: consumers holding live objects (the viewport grid, the renderer)
// subscribe through whichever copy of this module they imported, so settings
// applied through a second copy would reach none of them.
const listeners = vmSingleton("projectSettingsListeners", () => new Set());
export function onProjectSettingsApplied(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pushes settings onto the running engine/editor (call at boot too). */
export async function applyProjectSettings(settings = getProjectSettings()) {
  const engine = await ensureEngine();
  engine.config.scriptHotReload = settings.scripts.hotReload !== false;
  engine.config.scriptReloadIntervalMs = settings.scripts.reloadIntervalMs ?? 750;

  // Filesystem watching. `startProjectWatcher` re-reads the flag itself (it is
  // also called on project open, before this ever runs), so all this has to do
  // is act on a change made while a project is already open. Dynamic import:
  // the watcher reads the project store, and pulling it in at module scope
  // would make that cycle exist for every consumer of this file.
  // Never fatal: applying settings is on the project-open path, and a project
  // whose watcher could not start (a browser harness, a folder the OS refuses
  // to watch) must still get its pixel ratio, saves and physics layers.
  try {
    const watcher = await import("./projectWatcher.js");
    if (settings.editor.watchProject === false) await watcher.stopProjectWatcher();
    else await watcher.startProjectWatcher();
  } catch (err) {
    console.warn(`Project watcher unavailable: ${err?.message ?? err}`);
  }

  // Saves. The namespace must match the one an exported build uses, or testing
  // a save in the editor would tell you nothing about the shipped game — so
  // both derive it the same way (`saveId`, else the title, else the project).
  const meta = useProjectStore.getState();
  engine.config.saveVersion = settings.game.saveVersion ?? 1;
  engine.saves?.setNamespace(
    settings.game.saveId ||
      settings.game.title ||
      meta.projectMeta?.name ||
      "default",
  );
  await engine.prefs?.hydrate();

  // Physics layers. The blob on `engine.config` is what the physics module
  // reads when it builds a world (and what the exporter ships), so it is set
  // whether or not the module is currently enabled. `setPhysicsLayerConfig`
  // additionally feeds the Inspector's Layer dropdown, and `setLayers` pushes
  // the matrix into a world that is already running.
  const layerConfig = { names: settings.physics.layers, matrix: settings.physics.matrix };
  engine.config.physicsLayers = layerConfig;
  const { setPhysicsLayerConfig } = await import("../modules/physics-rapier/layerConfig.js");
  setPhysicsLayerConfig(layerConfig);
  engine.physics?.setLayers?.(layerConfig);

  // rendererReady (not just renderer): init() assigns the renderer before
  // its backend resolves, and touching it in that window breaks the loop.
  if (engine.rendererReady) {
    const dpr = window.devicePixelRatio ?? 1;
    engine.setPixelRatio(Math.min(dpr, settings.rendering.pixelRatioCap ?? dpr));
    // Re-apply the current size so the new pixel ratio takes effect.
    const canvas = engine.renderer.domElement;
    if (canvas?.clientWidth) engine.setSize(canvas.clientWidth, canvas.clientHeight);
  }

  for (const fn of listeners) fn(settings);
}
