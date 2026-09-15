// @ts-check
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
import { deviceQualityCeiling, isPortableDevice } from "../engine/sceneSettings.js";
import { freeze } from "../engine/freezeLedger.js";

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
async function importScript(path) {
  const raw = await (await fetch(path, { cache: "no-cache" })).text();
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
    return mod.default ?? null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

setScriptLoader(async (path) => {
  let entry = scriptCache.get(path);
  if (!entry) {
    entry = { version: 1, default: await importScript(path) };
    scriptCache.set(path, entry);
  }
  return entry;
});

/** Live preview only: re-import a rewritten script and bump its version, so
 *  the ScriptComponent hot-reload poll swaps it exactly as in the editor
 *  (state carried over when the script defines `onHotReload`). */
async function refreshScript(path) {
  const next = await importScript(path);
  const prev = scriptCache.get(path);
  scriptCache.set(path, { version: (prev?.version ?? 0) + 1, default: next });
}

/**
 * The loading screen. Scenes now load at runtime (menu → level 1 → level 2),
 * so this is not just a boot splash: it reappears for every `loadScene` the
 * game performs and disappears when that scene is ready.
 */
function createLoadingScreen(engine) {
  const root = document.getElementById("loading");
  if (!root) return;
  const bar = /** @type {HTMLElement | null} */ (root.querySelector(".loading-bar-fill"));
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

/**
 * Shown once the engine has given up rebuilding the renderer after a device
 * loss (`renderer-rebuild-failed`, after its backoff retries). Styled from the
 * loading screen's theme variables so a build's colours carry over.
 */
function showDeviceLost(failure) {
  if (document.getElementById("device-lost")) return;
  const root = document.createElement("div");
  root.id = "device-lost";
  root.setAttribute("role", "alertdialog");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "14px",
    padding: "0 16px",
    textAlign: "center",
    background: "var(--loading-bg, #0d0e11)",
    color: "rgba(var(--loading-fg, 255, 255, 255), 0.72)",
    font: '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    letterSpacing: "0.02em",
    zIndex: "2147483001",
  });
  const title = document.createElement("div");
  title.textContent = "Graphics device lost";
  Object.assign(title.style, { fontSize: "15px", fontWeight: "500", color: "rgba(var(--loading-fg, 255, 255, 255), 0.92)" });
  const detail = document.createElement("div");
  detail.textContent = "The GPU stopped responding and could not be restarted. Reload to continue.";
  detail.title = String(failure ?? "");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  Object.assign(button.style, {
    font: "inherit",
    padding: "8px 20px",
    border: "0",
    borderRadius: "6px",
    background: "var(--loading-accent, #0a84ff)",
    color: "#fff",
    cursor: "pointer",
  });
  button.addEventListener("click", () => location.reload());
  root.append(title, detail, button);
  document.body.appendChild(root);
  button.focus();
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
  // A ring buffer of console errors and warnings from boot, for the HUD
  // (`?hud=1`): a GI kernel that fails to build on a phone says so exactly
  // once, in the console nobody can open there.
  try {
    const log = (globalThis.__playerLog ??= []);
    for (const level of ["error", "warn"]) {
      const raw = console[level].bind(console);
      console[level] = (...args) => {
        try {
          const line = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
          log.push(`${level === "error" ? "E" : "W"} ${line.slice(0, 220)}`);
          if (log.length > 40) log.shift();
        } catch {}
        raw(...args);
      };
    }
    globalThis.addEventListener("error", (e) => { log.push(`E ${String(e?.message ?? e).slice(0, 220)}`); if (log.length > 40) log.shift(); });
    globalThis.addEventListener("unhandledrejection", (e) => { log.push(`E ${String(e?.reason?.message ?? e?.reason ?? e).slice(0, 220)}`); if (log.length > 40) log.shift(); });
  } catch {}
  // `?flags={"__giReflectionsLevel":0}` — dev globals for an A/B on a device
  // the harness cannot reach (the same knob `run-player-fps.mjs --flags`
  // sets in headless Chrome). Applied before the modules load so build-time
  // hatches take effect on the first build. Malformed JSON is ignored aloud.
  try {
    const raw = new URLSearchParams(location.search).get("flags");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(globalThis, parsed);
        console.info("[player] dev flags from the URL:", parsed);
      }
    }
  } catch (error) {
    console.warn("[player] ?flags= is not JSON:", error?.message ?? error);
  }
  // Instrumentation is the editor's. A shipped game installs none of the
  // freeze ledger's per-call device/render wrappers and resolves no GPU
  // timestamps, unless asked: `?freezeLedger=1` (or `__freezeLedger: true` in
  // ?flags=) for the ledger, `?hud=1` / `?timestamps=1` for GPU timings.
  // Decided before the engine exists — both are read at renderer creation.
  const bootParams = new URLSearchParams(location.search);
  freeze.enabled = bootParams.get("freezeLedger") === "1" || globalThis.__freezeLedger === true;
  const engine = new Engine();
  engine.config.trackTimestamp = bootParams.has("hud") || bootParams.get("timestamps") === "1";
  // Every scene load compiles its pipelines behind the loading screen (bounded
  // by a timeout) instead of popping in over its first frames.
  engine.config.prewarmBlocking = true;
  // A device loss the engine could not recover from used to leave a blank
  // canvas and a console line nobody on a phone can read.
  engine.on("renderer-rebuild-failed", (failure) => showDeviceLost(failure));
  // The inline output transform (engine/outputTransform.js) — one full-res
  // pass fewer per frame; the phone's ledger read three's output quad at 6 ms.
  // `?flags={"__engineDirectOutput":false}` compares against three's path.
  engine.config.directOutput = globalThis.__engineDirectOutput !== false;
  // (allowRuntimeSdfBake used to be forced off here — the SDF bake pipeline
  // was deleted 2026-08-02; GI voxelizes occupancy on the GPU at load.)
  // Debugging convenience, and the handle test harnesses drive the build
  // through: `__engine.loadScene("scenes/Level2.scene")` from a console is
  // the fastest way to check a level transition in a real build.
  globalThis.__engine = engine;
  // Build-level config rides along in the start scene: modules, the input
  // snapshot and the exported page settings. The scene manager only cares
  // about entities, so read these here (the fetch is served from cache when
  // it loads the same file a moment later).
  //
  // READ BEFORE `init`, and that ordering is load-bearing: antialias / samples
  // / transparent are frozen when the WebGPURenderer is constructed, so a
  // renderer built from the defaults and only then told the scene's own block
  // has to be DESTROYED and rebuilt — `[gpu] DEVICE LOST (destroyed)` on every
  // launch, a second adapter + device request, and any pipeline already minted
  // against the dead device thrown away. The cost of moving the fetch up is
  // that the canvas paints its background one round trip later; the file is
  // local and needed within milliseconds anyway.
  const config = await (await fetch(START_SCENE)).json();
  if (config.settings?.renderer) await engine.applySettings({ renderer: config.settings.renderer });
  await engine.init(document.getElementById("game"));
  // Start the render loop early so the canvas paints the background colour
  // immediately, instead of staying black until the scene is deserialized.
  // The loop is harmless on an empty scene — it just renders nothing.
  engine.start();
  createLoadingScreen(engine);
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
  // The project's event catalog. Descriptive only — an undeclared event still
  // fires — but `engine.events.has`/`list` are script-facing, so a build that
  // shipped without it would answer differently than the editor did.
  if (config.events) engine.applyEvents(config.events);

  // Project settings embedded at export time.
  if (config.player?.title) document.title = config.player.title;
  // The build's quality preset. Set before the first scene loads so its
  // `performance` block is clamped on the way in rather than applied at full
  // cost for a frame and then lowered. `Engine.applySettings` re-applies the
  // ceiling on every later scene load.
  // On a phone or tablet the preset is lowered to the build's MOBILE preset
  // when one is authored (Build settings → Mobile preset; "same" = none). A
  // `?quality=<preset>` on the URL overrides both, for A/Bs on the device.
  const urlParams = new URLSearchParams(location.search);
  engine.config.quality = deviceQualityCeiling(
    config.player?.quality ?? null,
    globalThis.navigator,
    urlParams.get("quality"),
    config.player?.mobileQuality ?? null,
  );
  // The platform the per-component configs resolve against (see
  // engine/componentVariants.js): a phone or tablet applies each component's
  // `mobile` set plus the `portrait` / `landscape` one for how it is held —
  // the orientation follows the canvas size (`engine.setSize`), so it tracks
  // rotation. Set BEFORE the scene loads so every component is built from its
  // phone values rather than rebuilt into them. `?platform=mobile` (or
  // `desktop`) forces it, for checking a phone layout on this computer.
  const platformParam = urlParams.get("platform");
  engine.setPlatform({
    platform: platformParam === "mobile" || platformParam === "desktop"
      ? platformParam
      : isPortableDevice(globalThis.navigator) ? "mobile" : "desktop",
  });
  // Saves: namespace + version before anything can call `engine.saves`, and
  // hydrate preferences so a title screen can read the saved volume on frame 1.
  engine.config.saveVersion = config.player?.saveVersion ?? 1;
  engine.saves.setNamespace(config.player?.saveId || config.player?.title || "default");
  await engine.prefs.hydrate();
  // The device ratio; the CAP is the scene's `performance.maxDevicePixelRatio`,
  // applied in `Engine.#applyRendererSize` and clamped further by the build's
  // quality preset. The player used to ALSO apply a project-level
  // `pixelRatioCap` and take the min of the two — two controls for one number,
  // where the project one only ever acted when it happened to be stricter. See
  // the retired-setting note in `editor/projectSettings.js`.
  engine.setPixelRatio(window.devicePixelRatio ?? 1);
  // Live previews update in place instead of reloading: the injected client in
  // index.html (see editor/build/playerHtml.js) calls the hook this installs.
  // Published builds don't carry the flag, so they never grow the hook.
  if (config.player?.livePreview) {
    const { installLiveUpdate } = await import("./liveUpdate.js");
    installLiveUpdate(engine, { refreshScript });
  }

  // Everything past here goes through the same path a mid-game level change
  // does — the boot scene is not a special case, which is what keeps
  // `loadScene` honest.
  await engine.loadScene(START_SCENE, { setCamera: true });
  if (!engine.camera) engine.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  // `?hud=1`: the on-device readout (fps, cpu/gpu, GI cadence, per-pass GPU
  // ledger) for the phone the harness cannot reach. See player/hud.js.
  if (new URLSearchParams(location.search).has("hud")) {
    const { createPlayerHud } = await import("./hud.js");
    createPlayerHud(engine);
  }

  const resize = () => engine.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", resize);
  resize();

  engine.setPlaying(true);
}

boot().catch((err) => {
  document.body.textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
