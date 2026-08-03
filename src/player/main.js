import * as THREE from "three/webgpu";
import {
  Engine,
  setAssetResolver,
  setScriptLoader,
  setAssetMetaLoader,
  setDerivedDataRootProvider,
  applyEngineModules,
  registerBuiltInComponents,
} from "../engine/index.js";
import { linkEngineImports } from "../engine/scriptRuntime.js";
import "../modules/index.js"; // registers the built-in module catalog

// Bundler tree-shaking would otherwise drop these side-effect registrations
// — call explicitly so every built-in component is present before any scene
// tries to deserialize (the editor does the same in `engineInstance.js`).
registerBuiltInComponents();

// Debugging convenience only: reach the engine's three instance from a
// console. User scripts no longer need it — the script-runtime proxies are
// real modules that import three themselves (see scriptRuntime.js), so there
// is no boot-order requirement here.
globalThis.__ENGINE_THREE__ = THREE;

// Exported scenes reference assets by relative URL ("assets/foo.glb").
setAssetResolver(async (path) => path);

// Sidecar .meta files ship next to their assets; missing ones are fine.
setAssetMetaLoader(async (path) => {
  const res = await fetch(path);
  return res.ok ? res.json() : null;
});

// Exported derived data is read-only and content-addressed. GI resolves the
// same `gi-sdf/<geometry-hash>.sdf` keys as the editor, beneath this folder.
setDerivedDataRootProvider(() => "Library");

// Scripts ship as plain files; import once via blob URL (version never
// changes, so ScriptComponent's hot-reload poll is a cheap cache hit).
const scriptCache = new Map();
/** Reject HTML/markup payloads early so the user sees a clear error
 *  ("this isn't a script") rather than the cryptic "Unexpected identifier
 *  'html'" thrown when the browser tries to parse `<html>` as JS. */
function looksLikeHtml(source) {
  if (typeof source !== "string") return false;
  const head = source.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}
setScriptLoader(async (path) => {
  let entry = scriptCache.get(path);
  if (!entry) {
    const raw = await (await fetch(path)).text();
    if (looksLikeHtml(raw)) {
      throw new Error(`Script "${path}" looks like HTML/markup, not JavaScript or TypeScript`);
    }
    let code;
    try {
      code = await linkEngineImports(raw);
    } catch (err) {
      throw new Error(`Failed to import script "${path}": ${err.message ?? err}`);
    }
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      entry = { version: 1, default: mod.default ?? null };
    } finally {
      URL.revokeObjectURL(url);
    }
    scriptCache.set(path, entry);
  }
  return entry;
});

/**
 * The loading screen. Scenes now load at runtime (menu → level 1 → level 2),
 * so this is not just a boot splash: it reappears for every `loadScene` the
 * game performs and disappears when that scene is ready.
 */
function createLoadingScreen(engine) {
  const root = document.getElementById("loading");
  if (!root) return;
  const bar = root.querySelector(".loading-bar-fill");
  const label = root.querySelector(".loading-label");
  const show = (visible) => root.classList.toggle("is-hidden", !visible);
  const PHASE_LABELS = {
    fetch: "Loading scene",
    modules: "Starting systems",
    preload: "Loading assets",
    unload: "Clearing",
    instantiate: "Building scene",
  };

  engine.on("scene-load-start", () => {
    if (bar) bar.style.width = "0%";
    show(true);
  });
  engine.on("scene-load-progress", ({ phase, progress, loaded, total }) => {
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (label) {
      const counted = phase === "preload" && total > 1 ? ` ${loaded}/${total}` : "";
      label.textContent = `${PHASE_LABELS[phase] ?? phase}${counted}`;
    }
  });
  // One frame of grace so the scene's first render lands before the overlay
  // lifts — otherwise the player sees a black flash between the two.
  engine.on("scene-loaded", () => requestAnimationFrame(() => requestAnimationFrame(() => show(false))));
  engine.on("scene-load-error", ({ path, error }) => {
    if (label) label.textContent = `Failed to load ${path}: ${error?.message ?? error}`;
  });
}

// The scene the build boots into. Also readable at its project-relative path
// (the exporter ships both), so a script can reload the starting level.
const START_SCENE = "scene.json";

async function boot() {
  if (!globalThis.isSecureContext) {
    const host = globalThis.location?.hostname || "this address";
    throw new Error(
      `WebGPU requires a secure HTTPS origin. http://${host} is a plain-HTTP LAN address; ` +
        "open the localhost preview on this computer, or serve the LAN preview with a certificate trusted by this device.",
    );
  }
  const engine = new Engine();
  // (allowRuntimeSdfBake used to be forced off here — the SDF bake pipeline
  // was deleted 2026-08-02; GI voxelizes occupancy on the GPU at load.)
  // Debugging convenience, and the handle test harnesses drive the build
  // through: `__engine.loadScene("scenes/Level2.scene")` from a console is
  // the fastest way to check a level transition in a real build.
  globalThis.__engine = engine;
  await engine.init(document.getElementById("game"));
  // Start the render loop early so the canvas paints the background colour
  // immediately, instead of staying black until the scene is deserialized.
  // The loop is harmless on an empty scene — it just renders nothing.
  engine.start();
  createLoadingScreen(engine);

  // Build-level config rides along in the start scene: modules, the input
  // snapshot and the exported page settings. The scene manager only cares
  // about entities, so read these here (the fetch is served from cache when
  // it loads the same file a moment later).
  const config = await (await fetch(START_SCENE)).json();
  // (Live-preview reload polling used to live here, keyed off
  // `config.player.previewRevision`. It moved into the exporter —
  // `injectLivePreviewClient` in src/editor/build/playerHtml.js — because a
  // poll inside the prebuilt player bundle disappears exactly when the
  // template is stale, which is the situation live preview exists to survive.
  // index.html is regenerated every build, so the injected client always
  // matches the build it ships with.)
  // Collision layers before modules: the physics module reads this blob when
  // it sets up, and every collider's layer resolves against it.
  if (config.physics) engine.config.physicsLayers = config.physics;
  // Modules first: their components must exist before entities instantiate.
  // Rapier's setup now returns a placeholder and finishes its WASM init in
  // the background, so this await no longer blocks on the heavy work.
  await applyEngineModules(engine, config.modules ?? []);
  // Input config next — the manager is attached during init(), so swapping
  // the snapshot detaches/re-attaches to keep listeners consistent.
  if (config.input) engine.applyInput(config.input);

  // Project settings embedded at export time.
  if (config.player?.title) document.title = config.player.title;
  // The build's quality preset. Set before the first scene loads so its
  // `performance` block is clamped on the way in rather than applied at full
  // cost for a frame and then lowered. `Engine.applySettings` re-applies the
  // ceiling on every later scene load.
  engine.config.quality = config.player?.quality ?? null;
  // Saves: namespace + version before anything can call `engine.saves`, and
  // hydrate preferences so a title screen can read the saved volume on frame 1.
  engine.config.saveVersion = config.player?.saveVersion ?? 1;
  engine.saves.setNamespace(config.player?.saveId || config.player?.title || "default");
  await engine.prefs.hydrate();
  if (config.player?.pixelRatioCap) {
    engine.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, config.player.pixelRatioCap));
  }

  // Everything past here goes through the same path a mid-game level change
  // does — the boot scene is not a special case, which is what keeps
  // `loadScene` honest.
  await engine.loadScene(START_SCENE, { setCamera: true });
  if (!engine.camera) engine.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

  const resize = () => engine.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", resize);
  resize();

  engine.setPlaying(true);
}

boot().catch((err) => {
  document.body.textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
