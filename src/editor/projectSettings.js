import { useProjectStore } from "./store/projectStore.js";
import { ensureEngine } from "./engineInstance.js";

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
    layers: { gizmos: true, colliders: true, grid: true, stats: true, virtualGeometry: false },
    // User-rebindable visibility hotkeys (H, Shift+H, E, Shift+E by
    // default). Each entry maps an action id → chord string; the
    // dispatcher in keybindings.js reads this on every keydown so
    // changes apply immediately after Save.
    keybindings: {},
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
  };
}

/** Persists settings into project.json and applies them everywhere. */
export async function saveProjectSettings(settings) {
  await useProjectStore.getState().updateMeta({ settings });
  await applyProjectSettings(settings);
}

// Consumers that hold live objects (viewport grid…) subscribe to re-apply.
const listeners = new Set();
export function onProjectSettingsApplied(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pushes settings onto the running engine/editor (call at boot too). */
export async function applyProjectSettings(settings = getProjectSettings()) {
  const engine = await ensureEngine();
  engine.config.scriptHotReload = settings.scripts.hotReload !== false;
  engine.config.scriptReloadIntervalMs = settings.scripts.reloadIntervalMs ?? 750;

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
