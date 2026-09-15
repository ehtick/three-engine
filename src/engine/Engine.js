import { installFramebufferCopyFormats } from "./renderTargetImage.js";
import * as THREE from "three/webgpu";
import { installAsyncRenderPipelines } from "./asyncRenderPipelines.js";
import { installGpuTimestampRetention } from "./gpuTimestampRetention.js";
import { drsBudgetMs } from "./dynamicResolution.js";
import { installDirectOutput, withRealOutput } from "./outputTransform.js";

// Three's URL-level loader cache (raw file bytes / decoded images, keyed
// `file:<url>`, `image:<url>`…). Kept on so components that fetch the same URL
// within one load share a request — but it is a plain object nothing evicts,
// so every fetched GLB and image used to stay in memory for the session. The
// scene manager now clears it on each single-mode unload (`clearFileCache`):
// parsed models and textures own their own reuse, and the previous level's
// raw bytes are dead weight. r185's Cache refuses blob: keys itself
// (`isBlobURL`), so editor asset edits never land here.
THREE.Cache.enabled = true;
import { EventEmitter } from "./EventEmitter.js";
import { disposeEngineModules } from "./modules.js";
import { Entity } from "./Entity.js";
import {
  SCENE_SETTINGS_DEFAULTS,
  mergeSettings,
  applySettingsToScene,
  rendererConstructorOptions,
  resolveRendererLimits,
  rendererNeedsRebuild,
  applyQualityCeiling,
} from "./sceneSettings.js";
import { InputManager } from "./input/index.js";
import { createDefaultMaps } from "./input/defaultMaps.js";
import { ViewFrustum } from "./viewFrustum.js";
import { AudioSystem } from "./audio/AudioSystem.js";
import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { StatsSystem, PHASE } from "./StatsSystem.js";
import { freeze, installFreezeObserver, installGpuCallLedger, installNodeBuildLedger, installRenderSpans } from "./freezeLedger.js";
import { SaveSystem, PreferenceStore } from "./saveSystem.js";
import { Tween, TweenSystem } from "./tween.js";
import { TimeSystem } from "./time.js";
import { configureTextureAssetLoader } from "./textureAsset.js";
import { installOutputDither } from "./outputDither.js";
import { installShadowNodeGuard } from "./shadowNodeGuard.js";
import { installReversedDepthGuards, installReversedSkyDepthTest } from "./reversedDepth.js";
import { BatchSystem } from "./batching.js";
import { MergeSystem } from "./merging.js";
import { ShadowMergeSystem } from "./shadowMerge.js";
import { ShadowFreezeSystem } from "./shadowFreeze.js";
import { FrameGovernorSystem } from "./frameGovernor.js";
import { LodSystem } from "./lod/LodSystem.js";
import { ImpostorSystem } from "./lod/ImpostorSystem.js";
import { OcclusionSystem } from "./culling/OcclusionSystem.js";
import { SceneManager } from "./sceneManager.js";
import { PoolSystem } from "./pool.js";
import { PathSystem } from "./spline/PathSystem.js";
import { ImpulseSystem } from "./camera/impulse.js";
import { DebugDraw } from "./debugDraw.js";
import { DecalSystem } from "./vfx/DecalSystem.js";
import { AssetRegistry } from "./assets/AssetRegistry.js";
import { EventRegistry } from "./events/EventRegistry.js";
import { math } from "./math/index.js";
import { platformLayers } from "./componentVariants.js";

/**
 * Runs a render override (the postprocess pipeline) with the canvas
 * single-sampled. The pipeline renders the scene into its own 1× PassNode
 * target and only draws a full-screen quad onto the canvas, so a 4× canvas
 * there bought a 4× colour + depth attachment and a resolve per frame for
 * zero geometric smoothing.
 *
 * three reads `_samples` per render (`currentSamples`) and DESTROYS and
 * re-creates the canvas colour/depth attachments whenever it differs from the
 * last canvas render (WebGPUTextureUtils getColorBuffer) — its own XRManager
 * swaps it the same way. So the window spans the override AND the postRender
 * callbacks: a camera-preview PIP drawn onto the canvas at 4× after a 1× post
 * frame would re-create both attachments twice a frame, and the fresh 4×
 * buffer's resolve would black out the post image around the PIP.
 * Returns the samples to restore, or null when there is nothing to swap.
 * `__enginePostCanvasMsaa = true` restores the 4× canvas.
 */
function enterSingleSampleCanvas(renderer) {
  const samples = renderer?._samples;
  if (!(samples > 0) || globalThis.__enginePostCanvasMsaa === true) return null;
  renderer._samples = 0;
  return samples;
}

/**
 * The tone-mapping frame buffer target freezes the sample count it was CREATED
 * with (a postRender render inside the 1× window can create it). On a direct
 * frame, drop one whose count no longer matches so MSAA comes back after post
 * is switched off — a no-op Map check on every other frame.
 */
function dropStaleFrameBufferTargets(renderer) {
  const targets = renderer?._frameBufferTargets;
  if (!targets?.size) return;
  for (const [owner, target] of targets) {
    if ((target.samples ?? 0) !== (renderer.samples ?? 0)) {
      target.dispose();
      targets.delete(owner);
    }
  }
}

/**
 * Runtime core: owns the renderer, the three.js scene (source of truth)
 * and the entity tree. No React, no editor state — a built game ships this.
 */
/**
 * ⛔ NEVER LET THREE FALL BACK TO WebGL ON A CANVAS THAT WAS WebGPU.
 *
 * three installs `getFallback` inside the WebGPURenderer constructor — it
 * overwrites whatever the caller passes — so ANY failure inside `init()`,
 * including `requestDevice` running out of GPU memory, is retried as
 * `new WebGLBackend(...)`. A canvas that has already handed out a WebGPU
 * context returns null for `getContext('webgl2')` by spec, so that second
 * attempt dies on `getSupportedExtensions` of null, and THAT is the error the
 * caller sees. The real cause is gone.
 *
 * Observed exactly this on a live device loss (2026-09-07): four rebuild
 * attempts all reported "Cannot read properties of null (reading
 * 'getSupportedExtensions')" while the actual message —
 * `ID3D12Device::CreateDescriptorHeap failed with E_OUTOFMEMORY` — reached
 * only the raw console. Clearing the hook makes `init()` reject with the
 * original error, which is both the truth and the only thing the retry can
 * make a decision from.
 *
 * A canvas that was never WebGPU (an explicit `forceWebGL` build) keeps its
 * fallback: there the WebGL backend is the point, not a trap.
 *
 * @param {object} renderer A freshly constructed WebGPURenderer.
 * @param {boolean} wasWebGPU Whether the canvas previously held a WebGPU context.
 */
export function refuseWebGLFallback(renderer, wasWebGPU) {
  if (renderer && wasWebGPU) renderer._getFallback = null;
  return renderer;
}

/** Stamps the registering component or module on a per-frame callback (once). */
function tagOwner(fn, owner) {
  if (owner && typeof fn === "function" && fn.__owner === undefined) fn.__owner = owner;
}

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.scene = new THREE.Scene();
    this.renderer = null;
    this.camera = null; // active camera (editor camera or a CameraComponent's)
    // Keep the CSS viewport size separate from the canvas backing-store size.
    // A WebGPURenderer constructor reads canvas.width/height as its initial
    // *logical* size. During a renderer rebuild the existing canvas attributes
    // already include DPR, so failing to restore the CSS size would apply DPR
    // twice (for example 3392 * 2 * 2 = 13568).
    this._width = 0;
    this._height = 0;
    this._pixelRatio = globalThis.window?.devicePixelRatio ?? 1;
    this.entities = new Map(); // id -> Entity
    this.rootEntities = [];
    this.timer = new THREE.Timer();
    this.updateCallbacks = new Set();
    // Who is registering per-frame callbacks right now: the component being
    // attached (Entity.#attachComponent) or the module being set up
    // (modules.js). `onUpdate` and its siblings stamp it on the callback as
    // `__owner`, which is how the profiler's breakdown names a callback's
    // time after the fact without every call site passing itself in.
    this._registrant = null;
    /**
     * Owners whose per-frame callbacks are skipped right now.
     *
     * ⭐ THE ONLY HONEST WAY TO PRICE GPU WORK PER OWNER. A component that
     * hands the GPU three hundred dispatches costs almost no main thread and
     * almost no measurable pass time, and the frame still triples — the cost
     * is in issuing the work, which lives outside every clock this page can
     * read. What CAN be read is the frame with the component and the frame
     * without it, which is exactly the comparison a person makes by hand
     * when they untick something and watch the counter. This makes that
     * comparison an instrument instead of a habit.
     *
     * Nothing about the scene changes: the callback is skipped, the
     * component keeps its state, and the set is cleared when the census
     * finishes or throws. One `size` check per frame when it is empty.
     */
    this._mutedOwners = new Set();
    // Ordered post-update stage, for work that must observe the *final* pose of
    // the frame. Unlike `updateCallbacks` (a Set, so ordered only by when each
    // subscriber happened to attach) these carry an explicit `order`, because
    // the pose pipeline has a required sequence: the animator writes bones,
    // then IK bends them, then bone-attachment entities copy the result. Getting
    // that wrong doesn't crash — it just puts the sword one frame behind the
    // hand, which is exactly the kind of bug nobody can name.
    this.lateUpdateCallbacks = [];
    // Callbacks fired after all update callbacks but BEFORE the main render,
    // once per frame. Use these for passes that must see the frame's final
    // transforms (post-physics, post-script) yet run ahead of the main draw —
    // e.g. the GI deferred prepass, whose screen-space output the main render
    // samples. Running such a pass inside a plain onUpdate risks executing
    // before physics writes a body's new transform, which desyncs the pass
    // from the main render (moving objects then shimmer).
    this.preRenderCallbacks = new Set();
    // Callbacks fired after the main render. Use these for layered
    // effects that need to draw on top of the main scene (e.g. the
    // editor's camera-preview PIP), without the main render's
    // auto-clear wiping the PIP pixels.
    this.postRenderCallbacks = new Set();
    // Virtual cameras register themselves here on attach. Held on the ENGINE,
    // not in module state, because module-level registries silently duplicate
    // under Vite's `?t=` reload twins — see the long history in the notes on
    // `vmSingleton`. One engine, one list.
    this.virtualCameras = new Set();
    // Real cameras (CameraComponent), same registry pattern and the same
    // reason. Culling reads this: the editor's viewport camera is not an
    // entity and has no component, so "what would the shipped game cull?" has
    // to be answered from the scene's own camera. See `applyCullingSettings()`.
    this.cameraComponents = new Set();
    // Resolved from the governing camera every tick; seeded here so a headless
    // caller that never ticks still gets the default (culling on).
    this._frustumCulling = true;
    // Camera shake. Owned here so it survives whichever camera happens to be
    // active: an explosion's rumble must not stop because the shot cut.
    this.cameraImpulse = new ImpulseSystem();
    // `engine.math.clamp(...)`, `engine.math.vec3.smoothDamp(...)`. Stateless
    // and shared — the same object user scripts get from `import { math } from
    // "engine"`, hung here so a component or a script with an engine reference
    // never needs the import at all.
    this.math = math;
    // `engine.debug.line(...)` etc. Owned by the engine rather than the editor
    // because its whole purpose is debugging GAMEPLAY — it has to work in Play
    // mode and in a build, not only while the editor is stopped.
    this.debug = new DebugDraw(this);
    // `engine.decals.spawn(...)` — bullet holes, blood, scorch marks. Owned by
    // the engine for the same reason as the impulse system: the decals a fight
    // leaves behind belong to the world, not to whichever entity fired.
    this.decals = new DecalSystem(this);
    // `engine.spawn(...)` / `engine.despawn(...)` — prefab pooling, plus the
    // budgeted queue behind `instantiateAsync` and `pool.prewarm`. See pool.js.
    this.pool = new PoolSystem(this);
    // Everything riding a spline (patrol routes, elevators, camera carts).
    // Ticked from #tick ahead of the update callbacks so a moving platform is
    // already in position when physics steps — see spline/PathSystem.js.
    this.paths = new PathSystem(this);
    this.sceneName = "Untitled";
    this.playing = false;
    this.rendererReady = false;
    // ---- Game time --------------------------------------------------------
    // Everything a pause menu, a slow-motion effect, hitstop, or a debugger's
    // frame-step needs. `timeScale` multiplies the delta handed to update
    // callbacks (scripts, physics, particles, animation); `paused` freezes it
    // entirely while rendering continues, so a paused game still draws and its
    // UI still responds. Both reset on Stop — a script that paused the game
    // must not leave the editor frozen (see setPlaying).
    this.timeScale = 1;
    this.paused = false;
    // Wall-clock seconds since the last frame, ignoring timeScale/paused. Use
    // it for anything that must keep moving while the game is paused: menu
    // animations, a pause-screen camera drift, network keepalives.
    this.unscaledDeltaTime = 0;
    // The delta update callbacks actually received this frame (== their `dt`).
    this.deltaTime = 0;
    this.elapsedTime = 0; // scaled — game time
    this.unscaledElapsedTime = 0; // wall clock since start()
    // A backgrounded tab, a long shader-compile wave, or a breakpoint hands
    // the next frame a delta measured in seconds. Physics would tunnel and
    // animation would jump; clamping trades a slow-motion blip for both.
    this.maxDeltaTime = 0.25;
    // Frames queued by `step()`, consumed one per tick while paused.
    this._stepFrames = 0;
    // Fixed delta used per stepped frame — a debugger's step should advance a
    // predictable slice, not however long the user waited before clicking.
    this.stepDeltaTime = 1 / 60;
    // True between start() and stop(); used by the renderer-rebuild path so
    // the animation loop re-attaches to a freshly-recreated renderer.
    this.loopActive = false;
    // Optional host-side pacing. Runtime games leave this at zero; the editor
    // uses it only while not playing to leave main-thread slices for React and
    // pointer/keyboard events when a viewport frame becomes expensive.
    this.frameRateLimit = 0;
    this._lastFrameStart = -Infinity;
    // Bumped every time a renderer rebuild is requested. Each in-flight
    // #rebuildRenderer captures the token at entry; if a newer rebuild
    // superseded it while `init()` was awaiting, the older one aborts
    // after init resolves instead of clobbering the new renderer with
    // settings meant for a stale one. Without this, two back-to-back
    // applySettings() calls (e.g. play→stop, which clears then re-applies
    // settings in one tick) race: rebuild B disposes the renderer A is
    // still awaiting init() on, then A wakes up and calls
    // configureTextureAssetLoader(this.renderer) — pointing at B, which
    // hasn't finished init() yet — and KTX2Loader's detectSupport throws
    // "called before the backend is initialized".
    this._rendererRebuildSeq = 0;
    this._rendererRebuildInFlight = null;
    // Dynamic-resolution state. `_drsScale` is the auto multiplier (0.5–1)
    // applied ON TOP of settings.performance.renderScale when
    // settings.performance.dynamicResolution is on. Driven each frame by
    // #updateDynamicResolution from the measured GPU frame time.
    this._drsScale = 1;
    this._drsEmaMs = 0;
    this._drsLastChange = 0;
    // §18 W3 — the frame-rate floor. Separate from `_drsScale` on purpose:
    // that one scales the CANVAS and is deliberately divided back out of GI's
    // own sizing, so on a GI-dominated frame it controls a few ms of raster and
    // nothing that matters. `giCostScale` is the multiplier the GI module
    // applies to its traced-pixel budget; see frameGovernor.js for the loop and
    // for the measurements that made the pixel budget the control variable.
    this.frameGovernor = new FrameGovernorSystem(this);
    // Canvas/WebGPU attachment resize synchronization. Custom render targets
    // (GI/SSGI/etc.) may still be referenced by submitted command buffers;
    // resizing only after the queue drains avoids destroying them in flight.
    this._resizeInFlight = null;
    // Tracks the active timestamp readback. Besides preventing stacked
    // readbacks, renderer rebuilds await it before disposing mapped buffers.
    this._gpuTimestampInFlight = null;
    this.modules = new Map(); // module id -> setup handle (see modules.js)
    // Optional per-camera render overrides (e.g. PostprocessComponent).
    // When the active camera's override is set, the engine defers its main
    // `renderer.render(scene, camera)` call to it — the override is
    // responsible for the scene render AND any post-pass to the canvas.
    // At most one override is consulted per frame (the one whose camera
    // matches engine.camera).
    this.renderOverrides = new Set();
    // Per-frame frustum state. Shared by every view-only component so the
    // view*projection matrix is multiplied exactly once per frame (and even
    // then only when the active camera actually moved). See viewFrustum.js.
    this.viewFrustum = new ViewFrustum();
    // Components that opted into frustum gating, maintained incrementally by
    // `Component._viewOnlyActive`. The main loop ticks this set directly
    // rather than scanning every entity's component map each frame.
    this.viewOnlyComponents = new Set();
    // ── Platform context (componentVariants.js) ────────────────────────────
    // Which of a component's per-platform configs apply: `platform` is set
    // once by whoever boots the engine (the player from the user agent, the
    // editor from its preview target), `orientation` follows the canvas
    // shape through `setSize` unless an override pins it. `platform` is the
    // RESOLVED context scripts read; `_platformOverride` (the editor's
    // preview) wins over both when set. `variantComponents` is every
    // component carrying at least one override set — the only ones a
    // context change has to visit, kept by `Component._syncVariantRegistry`.
    this.platform = { platform: "desktop", orientation: "landscape" };
    this._platformBase = { platform: "desktop", orientation: "landscape" };
    this._platformOverride = null;
    this.variantComponents = new Set();
    // Merges repeated (geometry, material) pairs into instanced draw calls.
    // Driven from #tick's pre-render phase, gated by settings.performance.
    this.batching = new BatchSystem(this);
    // Collapses DISTINCT (geometry, material) pairs into one merged draw with a
    // table-driven material — the imported-environment case instancing cannot
    // reach. Off unless the scene asks for it; see merging.js on why.
    this.merging = new MergeSystem(this);
    // The same idea aimed at the SHADOW passes, where three replaces every
    // material with one depth override and merging's colour-pass key is
    // therefore meaningless. Opt-in while it is being proven. See shadowMerge.js.
    this.shadowMerge = new ShadowMergeSystem(this);
    // Picks a detail level per LOD group each frame. Ordered after batching so
    // it can invalidate it (a hidden member still draws through its proxy).
    this.lod = new LodSystem(this);
    // Bakes and draws billboard impostors — the level past the last mesh level.
    // Owns its own instanced draw rather than going through `batching`, whose
    // grouping is per (geometry, material) on entity meshes. See ImpostorSystem.
    this.impostors = new ImpostorSystem(this);
    // Hides what the depth buffer says is behind something else. Off by
    // default: it costs a low-res depth pass, which only pays for itself in a
    // scene with real occluders (see culling/OcclusionSystem.js).
    this.occlusion = new OcclusionSystem(this);
    // Stops re-rendering a shadow map for a scene that has not moved. On a
    // large scene the shadow map is not reduced by view frustum culling and is
    // routinely the biggest draw consumer in the frame — 459 of 655 draws on
    // Bistro. See shadowFreeze.js.
    this.shadowFreeze = new ShadowFreezeSystem(this);
    // Patches the missing null check in three's own ShadowNode.updateBefore,
    // which dereferences `this.shadowMap.depthTexture` on any frame between a
    // `light.dispose()` and the next `setup()`. Prototype-level and idempotent;
    // installed here because it must be in place before the first render. See
    // shadowNodeGuard.js for the verbatim three source and why neither shadow
    // flag can avoid it.
    installShadowNodeGuard();
    // Rewrites three's addon sky tests (`rawDepth >= 1.0`) for a reversed
    // depth buffer at node build time; inert unless the renderer is reversed.
    // Prototype-level like the guard above. See reversedDepth.js.
    installReversedSkyDepthTest();
    // Built-in per-frame telemetry sampler. Lives on the engine — every
    // engine has one, no module registry involved. The editor's viewport
    // overlay reads `engine.stats.readout`; built games can ignore it.
    this.stats = new StatsSystem(this);
    this.stats.start();

    // Runtime scene loading (menu → level 1 → level 2, additive streaming,
    // persistent entities). See sceneManager.js; `loadScene` below is the
    // shorthand scripts actually use.
    this.scenes = new SceneManager(this);

    // Host-tunable runtime behavior (the editor writes project settings here).
    // `quality` is the build's preset name (see QUALITY_PRESETS); null in the
    // editor, where scenes are shown exactly as authored.
    // `trackTimestamp`: GPU timestamp queries (decided at renderer construction;
    // the player turns them off). `prewarmBlocking`: scene loads wait for
    // `prewarmShaders` before announcing the scene (the player's loading screen).
    this.config = { scriptHotReload: true, scriptReloadIntervalMs: 750, saveVersion: 1, quality: null, trackTimestamp: true, prewarmBlocking: false };

    // Save slots (a playthrough) and preferences (settings, cross-run flags).
    // Deliberately separate: deleting every save must not reset the volume.
    // See saveSystem.js — scripts opt in via `onSave`/`onLoad`.
    // Property tweening on game time (see tween.js). `engine.tween(...)` is
    // the shorthand scripts use.
    this.tweens = new TweenSystem();

    // Clocks + scheduler in one namespace (see time.js). `engine.deltaTime`
    // and the other fields above stay as they are — half the engine reads them
    // — and this is the surface gameplay code is pointed at, because "how long
    // was the frame" and "run this in three seconds" are the same subject.
    this.time = new TimeSystem(this);

    this.saves = new SaveSystem(this);
    this.prefs = new PreferenceStore(this);
    this.prefs.hydrate();

    // Audio runtime: shared AudioContext + listener + sound registry. Lazily
    // materialises the context once the first SoundComponent attaches or
    // engine.start() fires — browsers require a user gesture otherwise.
    this.audio = new AudioSystem(this);

    // `engine.assets` — script-facing texture/material/geometry/audio/cubemap
    // access, wrapping the same path-keyed caches components load through.
    this.assets = new AssetRegistry(this);

    // `engine.events` — the project's own declared events (the catalog the
    // Events panel authors), plus the diagnostic tap behind its monitor. Not a
    // bus: events are still listened to and fired on `engine`/`entity`/the
    // component itself. Empty until `applyEvents` runs at boot.
    this.events = new EventRegistry();

    // Input: built by default with the Player/UI maps enabled; an editor-
    // provided snapshot (applyInput) replaces it. Attached once the canvas
    // exists (see init()).
    // Vector2 factory passed to the InputManager so `readValue("Move")` returns a
    // real `THREE.Vector2` instance (with `.length()`, `.normalize()`, …) instead
    // of a plain `{ x, y }` object. The factory is also threaded through
    // `applyInput()` below so a deserialized snapshot behaves the same way.
    this.input = new InputManager({
      Vector2: THREE.Vector2,
      // Vec2 actions with `space: "camera"` are rotated by `engine.camera`
      // each tick. The provider is a closure so swapping `engine.camera`
      // (e.g. on scene change) takes effect immediately — no need to
      // re-register the manager.
      cameraProvider: () => this.camera,
    });
    for (const m of createDefaultMaps()) this.input.addActionMap(m);
    this.input.enableMap("Player");
    this.input.enableMap("UI");
    this._inputTickUnsub = null; // tracked so applyInput can swap it cleanly

    // Scene environment settings (serialized with the scene). The ambient
    // light is engine-owned — not an entity, so it never serializes twice.
    this.settings = structuredClone(SCENE_SETTINGS_DEFAULTS);
    this.ambientLight = new THREE.AmbientLight();
    this.ambientLight.userData.engineOwned = true;
    this.scene.add(this.ambientLight);
    applySettingsToScene(this.settings, this.scene, this.ambientLight, null);

    // Batching reads `settings`, so it can only be armed once those exist.
    // applySettings() re-applies this whenever the scene changes it.
    this.batching.setEnabled(this.settings.performance?.autoBatching !== false);
    this.merging.setEnabled(this.settings.performance?.staticMerging === true);
    this.shadowMerge.setEnabled(this.settings.performance?.shadowMerging === true);
    // Resolved through the camera, not read from settings directly — the scene
    // setting is only what a camera set to "inherit" falls back to. Re-applied
    // every tick anyway; this is just so the state is right before the first one.
    this.applyCullingSettings();

    // Set to true by `emit("hierarchy-changed")` while a coalescing microtask
    // is pending. See the `emit` override below.
    this._hierarchyDirty = false;

    /** True while a modal editor mode holds simulation down. See suspendSimulation. */
    this.simulationSuspended = false;
    this._simulationHolds = new Set();

    // THE FREEZE LEDGER (docs/ZERO_FREEZE_PLAN.md Stage 0). Armed for the
    // engine's whole life, not for a capture window: the freezes worth naming
    // are the ones nobody was watching for. Costs a browser-side observer that
    // only calls back when the main thread actually blocked. Not in a player
    // that switched the ledger off (player/main.js) — nothing reads it there.
    if (freeze.enabled) installFreezeObserver();
  }

  /**
   * Per-event listener timings, accumulated only while `profile.edit` is
   * armed. Answers "changing X cost Y ms, in which listener" — the question
   * the plan's §2.4 fan-out table exists for.
   */
  beginEventCapture() {
    this._eventCapture = new Map();
  }

  readEventCapture() {
    return [...(this._eventCapture ?? new Map()).values()]
      .map((row) => ({ ...row, ms: +row.ms.toFixed(2) }))
      .sort((a, b) => b.ms - a.ms);
  }

  endEventCapture() {
    const rows = this.readEventCapture();
    this._eventCapture = null;
    return rows;
  }

  /**
   * "hierarchy-changed" is a coarse "the entity tree moved, re-read it" signal.
   * Every listener responds by rebuilding something proportional to scene size
   * — the editor's React mirror walks all entities, GI queues a rebake check,
   * terrain rescans scatter parents. Emitting it once per entity (which
   * `createEntity` / `destroyEntity` / `addComponent` all do) therefore makes
   * bulk operations quadratic: loading a 5k-entity scene fired ~10k events,
   * each triggering a 5k-entity mirror rebuild.
   *
   * Coalescing to a microtask collapses any synchronous burst into a single
   * emit while keeping the event's meaning intact — scene load, `clear()`, and
   * prefab expansion are all synchronous loops, so they now notify once. Use
   * `flushHierarchyChanged()` when a caller genuinely needs listeners to have
   * run before it continues.
   */
  /**
   * Times one listener while `profile.edit` is armed. See EventEmitter._invoke.
   * The listener's own name is usually anonymous, so a listener registered
   * through `engine.on(event, fn, label)` carries `fn.__label`; everything else
   * falls back to `fn.name` and then to its position.
   */
  _invoke(fn, event, args) {
    const capture = this._eventCapture;
    if (!capture) {
      fn(...args);
      return;
    }
    // A listener registered as `engine.on(event, fn, label)` carries
    // `fn.__label`; otherwise its own name, and finally "anonymous" — most
    // editor listeners are arrow functions, which is why `__label` exists.
    const label = fn.__label ?? (fn.name || "anonymous");
    const key = `${event} :: ${label}`;
    const t0 = performance.now();
    try {
      fn(...args);
    } finally {
      let row = capture.get(key);
      if (row === undefined) {
        // Stored whole rather than re-split out of the joined key later: a
        // listener label may legitimately contain a space, and parsing it back
        // is how `event` silently became the entire key.
        row = { event, listener: label, ms: 0, calls: 0 };
        capture.set(key, row);
      }
      row.ms += performance.now() - t0;
      row.calls++;
    }
  }

  emit(event, ...args) {
    if (event !== "hierarchy-changed") {
      super.emit(event, ...args);
      return;
    }
    // A STORM DETECTOR (2026-09-07): "Maximum update depth exceeded" in the
    // editor's mirror means something re-emits this event from within the
    // reaction to it. The stack is only captured once the flush rate is
    // already suspicious, so a quiet scene pays nothing.
    if (!this._hierarchyDirty && (this._hierarchyFlushCount ?? 0) > 10) this._hierarchyStormStack = new Error().stack;
    this._hierarchyDirty = true;
    // An explicit batchHierarchy() owns the flush — it spans `await`s, which a
    // microtask would fire straight through.
    if (this._hierarchyBatchDepth > 0 || this._hierarchyScheduled) return;
    this._hierarchyScheduled = true;
    queueMicrotask(() => {
      this._hierarchyScheduled = false;
      this.flushHierarchyChanged();
    });
  }

  /** Delivers a pending coalesced "hierarchy-changed" immediately (no-op if none). */
  flushHierarchyChanged() {
    if (!this._hierarchyDirty || this._hierarchyBatchDepth > 0) return;
    this._hierarchyDirty = false;
    const now = (globalThis.performance?.now?.() ?? Date.now());
    if (now - (this._hierarchyFlushWindow ?? 0) > 1000) { this._hierarchyFlushWindow = now; this._hierarchyFlushCount = 0; }
    this._hierarchyFlushCount = (this._hierarchyFlushCount ?? 0) + 1;
    if (this._hierarchyFlushCount === 30 && this._hierarchyStormStack) {
      console.warn(`[engine] hierarchy-changed storm: 30 flushes within a second. The last emitter:\n${this._hierarchyStormStack}`);
    }
    // Its own span: the fan-out is ~20 O(scene) listeners and it is the single
    // most common owner of an edit-time block.
    const token = freeze.begin("event:hierarchy-changed");
    try {
      super.emit("hierarchy-changed");
    } finally {
      freeze.end(token);
    }
  }

  /**
   * Holds the coalesced "hierarchy-changed" until `fn` finishes, even across
   * `await`s — the microtask above would otherwise flush at the first one.
   * Restoring a play snapshot and loading a scene both await settings before
   * touching the tree, and neither should notify twice.
   *
   * Re-entrant, and works for both synchronous and async callbacks.
   * Deliberately NOT declared `async`: `clear()` calls it from synchronous
   * code that must stay synchronous, so the result is passed through unwrapped.
   */
  batchHierarchy(fn) {
    this._hierarchyBatchDepth = (this._hierarchyBatchDepth ?? 0) + 1;
    const finish = () => {
      this._hierarchyBatchDepth--;
      if (this._hierarchyBatchDepth === 0) this.flushHierarchyChanged();
    };
    let result;
    try {
      result = fn();
    } catch (err) {
      finish();
      throw err;
    }
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          finish();
          return value;
        },
        (err) => {
          finish();
          throw err;
        },
      );
    }
    finish();
    return result;
  }

  /** Merges + applies a scene-settings patch; emits "settings-changed". */
  /**
   * @param {object} patch
   * @param {{fromSceneLoad?: boolean}} [options] `fromSceneLoad` says this
   *   patch is a scene's authored settings arriving because the user OPENED
   *   that scene, not because they edited anything. See the renderer note
   *   below for why that distinction is worth a parameter.
   */
  async applySettings(patch, { fromSceneLoad = false } = {}) {
    const before = this.settings;
    // The build's quality preset is a ceiling over whatever each scene
    // authored, and it has to be re-applied on every settings change — not
    // once at boot — because loading level 2 brings that level's own
    // `performance` block with it. Clamping here is the one place every path
    // (boot, `loadScene`, a script tweaking exposure) funnels through.
    this.settings = applyQualityCeiling(mergeSettings(before, patch ?? {}), this.config?.quality);
    // Renderer-construction options (antialias / samples / transparent) are
    // frozen at WebGPURenderer creation time. If any of them just changed,
    // tear the renderer down and rebuild it on the same canvas. The new
    // renderer then gets the rest of the settings via applySettingsToScene.
    //
    // ⛔⛔ DECIDED AGAINST THE RENDERER'S BUILT OPTIONS, COALESCED TO END OF
    // TICK — NOT against the previous settings object, immediately.
    //
    // The immediate before/after comparison destroyed the GPU DEVICE TWICE on
    // every play-stop of any scene whose renderer block differs from the
    // defaults. Stop-play restores state as `applySettings(DEFAULTS)` then
    // `applySettings(snapshot)` in one tick (see the serialization note
    // below); with the Level scene at `antialias: false` against the default
    // `true`, each call saw a "changed" antialias and each ran a full
    // teardown — `renderer.dispose()` → `[gpu] DEVICE LOST (destroyed)` in the
    // user's console at 19:16:43, followed by async-pipeline-creation failures
    // and null-`layers` unhandled rejections as GI and the selection outline
    // recovered against a dying device. Reported as "gi keeps crushing, even
    // on other scene" — the Level is where Play is used, and every stop killed
    // the device twice for a round trip that ended exactly where it began.
    //
    // The scheduled check compares the EFFECTIVE constructor options
    // (`rendererConstructorOptions`, which is what the renderer actually
    // froze — e.g. samples collapse to 0 whenever antialias is off) against
    // what the live renderer was BUILT with. A DEFAULTS→snapshot round trip
    // coalesces to "unchanged" and no rebuild happens at all; a real
    // antialias/samples/transparent change still rebuilds, once, with the
    // final values.
    //
    // ── AND A SCENE SWITCH DOES NOT REBUILD AT ALL (2026-09-07, zero-freeze
    //    plan unit 3.4) ─────────────────────────────────────────────────────
    //
    // The renderer block is authored PER SCENE, so opening a scene whose
    // antialias differs from the running renderer's used to destroy the device
    // — and a destroyed device means GI rebuilds from nothing and every
    // material is compiled again. Measured elsewhere in this file at ~40 s.
    // That is the whole of "switching scenes freezes the editor", and nobody
    // asked for it: the user opened a scene, they did not change a setting.
    //
    // So a scene load APPLIES the value and defers the rebuild to the next
    // launch, saying so once. The difference the user sees is multisampling on
    // the scene they just opened; the difference they no longer sees is a
    // forty-second stall. A deliberate EDIT still rebuilds immediately —
    // that path does not pass `fromSceneLoad`, and a setting you just changed
    // has to take effect or the control is broken.
    // `__engineSceneSwitchRebuildsRenderer = true` restores the old behaviour.
    const optionCheckScheduled = this.renderer
      && rendererNeedsRebuild(before.renderer, this.settings.renderer);
    if (optionCheckScheduled && fromSceneLoad && globalThis.__engineSceneSwitchRebuildsRenderer !== true) {
      const built = this._rendererBuiltWith ?? {};
      const wanted = rendererConstructorOptions(this.settings, this.config);
      const diff = Object.keys(wanted)
        .filter((key) => wanted[key] !== built[key])
        .map((key) => `${key} ${String(built[key])}→${String(wanted[key])}`)
        .join(", ");
      if (diff) {
        console.log(
          `[gpu] this scene asks for ${diff}, which is fixed when the renderer is created. ` +
            `Keeping the current renderer: rebuilding it here would destroy the GPU device, ` +
            `and GI would rebuild and recompile every material (~40 s). Reload the editor ` +
            `(Ctrl+R) to open this scene with its own renderer options.`,
        );
      }
    } else if (optionCheckScheduled) {
      this.#scheduleRendererOptionCheck();
    }
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    // A manual render-scale change resizes the canvas backing store. Only
    // re-apply when the value actually moved — renderer.setSize reallocates
    // the swap chain, which we don't want on every unrelated settings drag.
    const prevScale = before.performance?.renderScale ?? 1;
    const nextScale = this.settings.performance?.renderScale ?? 1;
    const prevDpr = before.performance?.maxDevicePixelRatio ?? 2;
    const nextDpr = this.settings.performance?.maxDevicePixelRatio ?? 2;
    if (prevScale !== nextScale || prevDpr !== nextDpr) {
      this.#scheduleRendererResize();
    }
    this.batching.setEnabled(this.settings.performance?.autoBatching !== false);
    this.merging.setEnabled(this.settings.performance?.staticMerging === true);
    this.shadowMerge.setEnabled(this.settings.performance?.shadowMerging === true);
    // Resolved through the camera, not read from settings directly — the scene
    // setting is only what a camera set to "inherit" falls back to. Re-applied
    // every tick anyway; this is just so the state is right before the first one.
    this.applyCullingSettings();
    this.emit("settings-changed", this.settings);
    // "Might the renderer be rebuilt as a result of this call": the decision
    // itself now lands at end of tick, so this is an upper bound, kept for
    // callers that used the old boolean to expect a renderer swap.
    return optionCheckScheduled;
  }

  /**
   * The coalesced renderer-rebuild decision — see the banner in applySettings.
   *
   * Runs once per macrotask however many applySettings calls queued it, and
   * compares the EFFECTIVE constructor options of the FINAL settings against
   * what the live renderer was actually built with (`_rendererBuiltWith`,
   * recorded at both construction sites). A play-stop's DEFAULTS→snapshot
   * round trip lands here as "unchanged" and no device is destroyed.
   */
  #scheduleRendererOptionCheck() {
    if (this._rendererOptionCheckQueued) return;
    this._rendererOptionCheckQueued = true;
    // setTimeout, not queueMicrotask: the DEFAULTS and snapshot applies are
    // separate awaited async calls, so microtasks between them would still see
    // the intermediate state. A macrotask runs after the whole play-stop
    // sequence has settled.
    setTimeout(() => {
      this._rendererOptionCheckQueued = false;
      void this.#applyRendererOptionsIfChanged();
    }, 0);
  }

  async #applyRendererOptionsIfChanged() {
    if (!this.renderer) return;
    const built = this._rendererBuiltWith;
    const wanted = rendererConstructorOptions(this.settings, this.config);
    const changed = !built
      || Object.keys(wanted).some((key) => wanted[key] !== built[key]);
    if (!changed) return;
    // NAME THE DIFF (2026-09-02). A renderer rebuild DESTROYS THE DEVICE, and
    // every GPU resource with it — GI rebuilds from scratch and pays its whole
    // material wave again (~40 s on the user's machine). Their editor console
    // read three `[gpu] DEVICE LOST (destroyed)` in four minutes while playing
    // Sponza and nothing said why; a rebuild must always say which option
    // moved, or it is indistinguishable from a driver fault.
    if (built) {
      const diff = Object.keys(wanted)
        .filter((key) => wanted[key] !== built[key])
        .map((key) => `${key} ${String(built[key])}→${String(wanted[key])}`)
        .join(", ");
      console.warn(`[gpu] renderer REBUILD (device destroyed, GI rebuilds and recompiles every material): ${diff}`);
    }
    const canvas = this.renderer.domElement;
    // Wait for any in-flight rebuild before tearing down the renderer it
    // created — otherwise we'd dispose() a renderer that's mid-init() and
    // race its post-init wiring (configureTextureAssetLoader, etc.) against
    // this rebuild's post-init wiring.
    if (this._rendererRebuildInFlight) {
      try {
        await this._rendererRebuildInFlight;
      } catch {
        // The in-flight rebuild already logged its own failure; swallow so
        // this rebuild can still proceed.
      }
      // The settings may have moved again while we waited — re-check against
      // whatever that rebuild recorded, rather than tearing down a renderer
      // that already matches.
      return this.#applyRendererOptionsIfChanged();
    }
    this.renderer.setAnimationLoop(null);
    // Timestamp readback maps renderer-owned GPU buffers asynchronously.
    // Wait so dispose() does not unmap a pending GPUBuffer.mapAsync call.
    if (this._gpuTimestampInFlight) await this._gpuTimestampInFlight;
    this.renderer.dispose();
    this.renderer = null;
    this.rendererReady = false;
    // Fire-and-forget the async rebuild. applySettingsToScene runs again
    // after the new renderer resolves, so anything that already called
    // applySettings synchronously gets the new renderer on next tick.
    this.#rebuildRenderer(canvas);
  }

  /**
   * Effective resolution multiplier on the canvas backing store: the manual
   * Scene Settings → Performance → Render Scale times the dynamic-resolution
   * controller's current auto scale. 1 = native resolution.
   */
  get renderScale() {
    const manual = this.settings.performance?.renderScale ?? 1;
    const clamped = Number.isFinite(manual) ? Math.min(1, Math.max(0.25, manual)) : 1;
    return clamped * this._drsScale;
  }

  /**
   * The frame governor's current multiplier on GI's traced-pixel budget.
   * 1 = the quality tier's authored cost, untouched. See frameGovernor.js.
   *
   * A GETTER rather than a field so there is exactly one owner of the value:
   * a module reading a stale copy of a number the loop moves is the whole
   * class of bug this replaces.
   */
  get giCostScale() {
    return this.frameGovernor?.scale ?? 1;
  }

  /**
   * Subscribes to the live device's error stream.
   *
   * SURFACE SILENT GPU FAILURES (2026-08-22 night). An async compute pipeline
   * that fails validation dispatches nothing and — with no listener — logs
   * NOTHING: the §12.56 dead-field family stayed a coin-flip mystery for weeks
   * because nothing in the engine ever subscribed to the device's error stream.
   * Every uncaptured validation/OOM/internal error now prints with its real
   * message, which names the failing pipeline instead of leaving a black field
   * as the only symptom.
   *
   * ⚠ CALLED FROM BOTH RENDERER CONSTRUCTION SITES, and that is the whole
   * reason it is a method. It used to be an inline block in `init()` only, so
   * every renderer built by `#rebuildRenderer` — the play-stop path, any
   * antialias/samples change — ran with NO error listener at all: a device that
   * died after a rebuild produced total silence, which is the worst possible
   * state for the failure it exists to explain.
   *
   * RECOVERY: a loss whose reason is not `"destroyed"` was not our doing (a
   * driver reset, a GPU-process crash, an OOM on a phone). Everything the
   * renderer owns is gone, and without a rebuild the canvas keeps presenting
   * the last good frame — or nothing — forever, with only a console line to
   * say why. An intentional teardown (`reason === "destroyed"`) is skipped:
   * that device was replaced on purpose and something else already owns the
   * canvas.
   */
  #watchDevice() {
    const device = this.renderer?.backend?.device;
    if (!device || device.__engineErrorListener) return;
    device.__engineErrorListener = true;
    device.addEventListener("uncapturederror", (e) => {
      const msg = e?.error?.message ?? String(e?.error ?? e);
      console.error(`[gpu] UNCAPTURED DEVICE ERROR: ${msg.slice(0, 1200)}`);
    });
    device.lost?.then?.((info) => {
      const reason = info?.reason ?? "unknown";
      console.error(`[gpu] DEVICE LOST (${reason}): ${info?.message ?? ""}`);
      if (reason === "destroyed") return;
      // Only if this dead device is still the one the live renderer holds —
      // otherwise a rebuild has already moved on and this is a stale echo.
      if (this.renderer?.backend?.device !== device) return;
      const canvas = this.renderer.domElement;
      console.warn("[gpu] rebuilding the renderer after an unexpected device loss");
      this.renderer.setAnimationLoop(null);
      this.renderer = null;
      this.rendererReady = false;
      // Retried: a device loss is usually transient — the GPU process
      // restarts and the next attempt succeeds. A settings-driven rebuild
      // gets ONE attempt, because its failures are not transient and four
      // of them would only delay the error the caller needs to see.
      void this.#rebuildRenderer(canvas, { retry: true });
    }).catch(() => {});
  }

  /**
   * ── A REBUILD THAT FAILS MUST NOT LEAVE A DEAD EDITOR (2026-09-07) ────────
   *
   * OBSERVED: after `ID3D12Device::CreateDescriptorHeap failed with
   * E_OUTOFMEMORY`, the automatic rebuild threw
   * `Cannot read properties of null (reading 'getSupportedExtensions')` from
   * `WebGLBackend.init` — three had fallen back to WebGL because WebGPU was
   * still unavailable a few milliseconds after the loss, and a canvas that has
   * already handed out a WebGPU context CANNOT hand out a WebGL one, so the
   * fallback got `null` and died. The old code logged that and stopped: no
   * renderer, no loop, no message the user could act on. The editor looked
   * frozen and only a manual page reload brought it back.
   *
   * Two rules, both learned from that one line:
   *   · A device loss is usually TRANSIENT — the GPU process restarts. Retry
   *     with backoff before giving up on the session.
   *   · A WebGL fallback on a canvas that was WebGPU is not a degraded mode,
   *     it is a broken one. Refuse it and retry rather than "succeeding" into
   *     a renderer that cannot draw.
   */
  async #rebuildRenderer(canvas, { retry = false } = {}) {
    // Capture the token + publish the in-flight promise so a newer
    // applySettings() can await this one before tearing the renderer down.
    const token = ++this._rendererRebuildSeq;
    const wasWebGPU = this._rendererWasWebGPU !== false;
    const work = (async () => {
      // ── THE BACKOFF IS SECONDS, NOT MILLISECONDS (2026-09-07) ──────────
      //
      // It was [0, 250, 750, 2000] — about three seconds of trying — and it
      // was measured failing all four attempts on a real device loss whose
      // cause was `ID3D12Device::CreateDescriptorHeap failed with
      // E_OUTOFMEMORY`. That is the GPU being out of memory, not a transient
      // hiccup: the driver has to reclaim the lost device's heaps before a new
      // one can be created, and it does not do that inside three seconds while
      // other clients still hold memory. Twenty seconds of blank viewport
      // beats a dead editor that only Ctrl+R can fix.
      const attemptDelays = retry ? [0, 500, 2000, 5000, 12000] : [0];
      for (let attempt = 0; attempt < attemptDelays.length; attempt++) {
        if (attemptDelays[attempt] > 0) {
          await new Promise((resolve) => setTimeout(resolve, attemptDelays[attempt]));
          if (token !== this._rendererRebuildSeq) return;
        }
        const failure = await this.#rebuildRendererOnce(canvas, token, wasWebGPU, attempt);
        if (failure === null) return; // built, or superseded
        if (attempt === attemptDelays.length - 1) {
          this.renderer = null;
          this.rendererReady = false;
          const outOfMemory = /OUTOFMEMORY|out of memory|CreateDescriptorHeap/i.test(failure);
          console.error(
            `[gpu] the renderer could not be rebuilt` +
              `${attemptDelays.length > 1 ? ` after ${attemptDelays.length} attempts over ` +
                `${(attemptDelays.reduce((sum, ms) => sum + ms, 0) / 1000).toFixed(0)}s` : ""} ` +
              `(${failure}). The viewport will stay blank until the editor is reloaded — ` +
              (outOfMemory
                ? `press Ctrl+R. THE GPU IS OUT OF MEMORY: the driver could not allocate a descriptor ` +
                  `heap for a new device. Close other GPU clients (a second editor window, a browser ` +
                  `running the harness, a game) before reloading, or the reload hits the same wall.`
                : `press Ctrl+R. This is usually a GPU device loss the driver did not recover from.`),
          );
          this.emit("renderer-rebuild-failed", failure);
        }
      }
    })();
    this._rendererRebuildInFlight = work;
    try {
      await work;
    } finally {
      // Only clear the in-flight slot if we're still the most recent one.
      if (token === this._rendererRebuildSeq) this._rendererRebuildInFlight = null;
    }
  }

  /**
   * One rebuild attempt. Returns `null` when it built (or was superseded), or a
   * short reason string when it failed and is worth retrying.
   */
  async #rebuildRendererOnce(canvas, token, wasWebGPU, attempt) {
    try {
        const opts = rendererConstructorOptions(this.settings, this.config);
        // Adapter-clamped limit bump — see resolveRendererLimits. Awaited
        // BEFORE construction because `requiredLimits` is a constructor
        // parameter three forwards straight to requestDevice.
        const limits = await resolveRendererLimits();
        this.renderer = new THREE.WebGPURenderer({ canvas, ...opts, ...limits });
        // Polygon-offset sign + float framebuffer depth for reversed depth.
        // Before init(): the first pipeline and framebuffer target come after.
        installReversedDepthGuards(this.renderer);
        refuseWebGLFallback(this.renderer, wasWebGPU);
        // What this renderer actually froze — the baseline the coalesced
        // option check compares against (see #applyRendererOptionsIfChanged).
        this._rendererBuiltWith = opts;
        this.#applyRendererSize();
        await this.renderer.init();
        this.#installOutputTransform();
        // Another rebuild started while we were awaiting init(). It owns
        // `this.renderer` now and will run its own post-init wiring — skip
        // ours so we don't run configureTextureAssetLoader / start the
        // animation loop against a renderer that isn't ours yet.
        if (token !== this._rendererRebuildSeq) return null;
        // A WebGL backend on a canvas that was WebGPU cannot draw — see this
        // method's header. Treat it as a failure so the retry gets a chance at
        // a recovered device instead of us wiring up a renderer that is dead.
        if (wasWebGPU && this.renderer.backend?.isWebGPUBackend !== true) {
          this.renderer = null;
          this.rendererReady = false;
          return "WebGPU was unavailable and the WebGL fallback cannot bind a canvas that already had a WebGPU context";
        }
        // The replacement device needs its own error listener — see #watchDevice.
        this.#watchDevice();
        // …and its own freeze-ledger wrappers: the wrappers live on the
        // GPUDevice, so a swap silently loses them.
        // (The device ledger always installs — it keeps WGSL interning and
        // the async in-flight count — and skips its hot wrappers when off.)
        installGpuCallLedger(this.renderer?.backend?.device);
        if (freeze.enabled) {
          installNodeBuildLedger(this.renderer);
          installRenderSpans(this.renderer);
        }
        this.emit("renderer-ready", this.renderer);
        configureTextureAssetLoader(this.renderer);
    // Sub-LSB dither on the output transform — without it every smooth GI
    // gradient bands into hard-edged contour rings on the 8-bit canvas.
    installOutputDither(this.renderer);
    installFramebufferCopyFormats(this.renderer);
        applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
        // Lazy-loaded SSGI/SSR addon handles from the previous renderer are
        // renderer-agnostic factories in r185, but invalidating them on a
        // full renderer rebuild is a no-cost safety net against any addon
        // that may cache backend-specific state internally.
        try {
          const { resetLazyPostAddons } = await import("../modules/postprocessing/postGraph.js");
          resetLazyPostAddons();
        } catch {
          // Postprocessing module not registered — fine, nothing to reset.
        }
        this.rendererReady = true;
        // Notify renderer-owning consumers before the new animation loop can
        // render. Pipelines and timestamp query sets belong to the old device.
        this.emit("renderer-rebuilt");
        this._rendererWasWebGPU = this.renderer.backend?.isWebGPUBackend === true;
        if (this.loopActive) this.renderer.setAnimationLoop(() => this.#tick());
        if (attempt > 0) console.log(`[gpu] renderer rebuilt on attempt ${attempt + 1}`);
        return null;
      } catch (err) {
        const reason = String(err?.message ?? err);
        console.warn(`[gpu] renderer rebuild attempt ${attempt + 1} failed: ${reason}`);
        // Never leave a half-built renderer in the slot: `rendererReady` is
        // false, but every `engine.renderer?.…` in the codebase would still
        // find an object and reach into a backend that never initialised.
      this.renderer = null;
      this.rendererReady = false;
      return reason;
    }
  }

  /**
   * ── SUSPENDING SIMULATION (2026-09-07) ────────────────────────────────────
   *
   * A modal editor sub-mode — the geometry editor above all — puts the user
   * inside ONE mesh, and everything else the viewport is simulating becomes
   * pure interference: the water solver dispatches its whole FFT chain every
   * frame whether or not anyone can see the water, VFX advance, and the
   * rebuild systems (batching, merging, shadow merging, impostors, occlusion)
   * keep re-grouping a scene nobody is editing. The user's report was exactly
   * this: "when entering geometry editing mode, all the components currently
   * ticking in the editor viewport must be stopped, because they must be
   * causing freezes and lags in the geometry editor".
   *
   * REF-COUNTED BY REASON, not a boolean, because two things can want the same
   * suspension at once (the geometry editor and, later, a modal bake) and
   * whichever finishes first must not resume for the other. A reason resumed
   * twice is a no-op rather than an underflow.
   *
   * ⚠ WHAT THIS IS NOT: it does not pause game time (`paused`), it does not
   * stop rendering (`renderSuspended`), and it does not detach anything. The
   * frame still draws, the camera still moves, gizmos and the geometry
   * editor's own overlays still run. Only work that ADVANCES OR REBUILDS the
   * rest of the scene stands down, so leaving the mode resumes exactly where
   * it left off.
   */
  suspendSimulation(reason) {
    (this._simulationHolds ??= new Set()).add(reason);
    this.simulationSuspended = true;
    this.emit("simulation-suspended", [...this._simulationHolds]);
    return () => this.resumeSimulation(reason);
  }

  /** Releases one hold. Simulation resumes when the last one is gone. */
  resumeSimulation(reason) {
    if (!this._simulationHolds?.delete(reason)) return;
    if (this._simulationHolds.size) return;
    this.simulationSuspended = false;
    this.emit("simulation-resumed");
  }

  /** Why simulation is suspended right now, for a receipt or a panel. */
  get simulationHolds() {
    return [...(this._simulationHolds ?? [])];
  }

  /** Toggles game-logic execution (ScriptComponent onStart/onUpdate/onDestroy). */
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    // The mode decides which flag counts: an entity enabled in game but not in
    // editor attaches its components now, ahead of "play-changed" and the
    // first update, and the reverse detaches — see Entity.reconcileActivity.
    for (const entity of this.rootEntities) entity.reconcileActivity(true);
    // A component paused for editing (`editorEnabled` false) resumes on play
    // and pauses again on stop: its effective enabled state depends on the
    // mode, so every component re-reads it here.
    for (const entity of this.entities.values()) {
      for (const component of entity.components.values()) component.reconcileEnabled();
    }
    if (!playing) {
      this.input.reset();
      // Game time is game state. A script that paused the game or slowed it to
      // 0.1 for a death effect must not leave the editor viewport frozen or
      // crawling after Stop.
      this.setTimeScale(1);
      this.setPaused(false);
      this.elapsedTime = 0;
      // Same reasoning as the time scale: an explosion mid-Stop must not leave
      // the editor viewport rattling, and a two-second debug line drawn on the
      // last frame of Play must not outlive the run that drew it.
      this.cameraImpulse.clear();
      this.debug.clear();
      // Same reasoning again, and the sharpest case of it: a wave spawner
      // scheduled on the last frame of Play would otherwise fire into the
      // editor's authoring scene seconds after Stop, spawning enemies into the
      // level the user is editing. Every pending timer dies with the run.
      this.time.clear();
      // Every decal, including the authored ones — those come back by way of
      // DecalComponent's `resetOnStop`, which re-projects them against the
      // restored scene rather than leaving a bake of the played-through one.
      this.decals.clear();
      // A tween left running past Stop would keep writing to entities the
      // scene snapshot has already restored — the editor's copy of the scene
      // would drift for as long as the tween had left to run.
      this.tweens.clear();
    }
    this.emit("play-changed", playing);
  }

  /**
   * Animates numeric properties of `target` toward `to` over `duration`
   * seconds. Dotted paths work, so the usual targets are reachable directly:
   *
   *     this.engine.tween(this.entity.object3D, { "position.y": 3 },
   *                       { duration: 0.4, ease: "backOut" });
   *     await this.engine.tween(fade, { alpha: 0 }, { duration: 0.3 });
   *
   * Returns a Tween: `cancel()`, `complete()`, and awaitable. On game time by
   * default — pass `unscaled: true` for anything that must keep running while
   * the game is paused (a pause menu's own animation).
   */
  tween(target, to, options) {
    return this.tweens.add(new Tween(this.tweens, target, to, options));
  }

  /**
   * Multiplies the delta handed to update callbacks. 0.5 = half speed, 2 =
   * double, 0 = frozen (rendering continues either way). Reset to 1 on Stop.
   *
   *     this.engine.setTimeScale(0.15);            // bullet time
   *     setTimeout(() => this.engine.setTimeScale(1), 800);
   */
  setTimeScale(value) {
    const next = Math.max(0, Number(value) || 0);
    if (next === this.timeScale) return;
    this.timeScale = next;
    this.emit("time-scale-changed", next);
  }

  /**
   * Freezes game time while leaving the render loop running — what a pause
   * menu wants. UI built on `unscaledDeltaTime` keeps animating; anything
   * driven by the update delta stops.
   */
  setPaused(paused) {
    const next = !!paused;
    if (next === this.paused) return;
    this.paused = next;
    this._stepFrames = 0;
    this.emit("paused-changed", next);
  }

  /**
   * Advances `frames` frames of game time while paused, each worth a fixed
   * `stepDeltaTime`. The frame-step button of a debugger; a no-op when not
   * paused (time is already advancing).
   */
  step(frames = 1) {
    if (!this.paused) return;
    this._stepFrames += Math.max(1, Math.floor(frames));
  }

  /**
   * Replaces the engine's input maps with a JSON snapshot (the form
   * InputManager.toJSON() produces). If `json` is null, restores the
   * built-in Player/UI defaults. Existing map definitions are removed.
   */
  applyInput(json) {
    const old = this.input;
    old.detach();
    this._inputTickUnsub?.();
    this._inputTickUnsub = null;
    const next = json
      ? InputManager.fromJSON(json, { Vector2: THREE.Vector2, cameraProvider: () => this.camera })
      : new InputManager({
          virtualJoysticks: "auto",
          virtualJoystickTheme: "dark",
          Vector2: THREE.Vector2,
          cameraProvider: () => this.camera,
        });
    if (!json) {
      for (const m of createDefaultMaps()) next.addActionMap(m);
      next.enableMap("Player");
      next.enableMap("UI");
    } else {
      // Restore the stack too — fromJSON carries it.
      for (const name of next.stack) next.enableMap(name);
    }
    next.attach(this.renderer?.domElement ?? this.canvas);
    // Unscaled: input is wall clock, not game time. A pause menu has to stay
    // navigable while the game it paused is frozen.
    this._inputTickUnsub = this.onUpdate(() => next.tick(this.unscaledDeltaTime));
    this.input = next;
    this.emit("input-changed", next);
  }

  /**
   * Replaces the project's event catalog with the `events` block from
   * project.json (or a build's config). Deliberately shaped like `applyInput`
   * above: same lifecycle, same "the editor pushes a snapshot" contract, same
   * `*-changed` notification so panels can re-read.
   *
   * The catalog is descriptive, not load-bearing — an event fires whether or not
   * it is declared, because `emit` has never consulted a registry and making it
   * do so would turn a typo into a silent drop at runtime instead of the compile
   * error the generated declarations already give. What declaring an event buys
   * is the typing and the tooling around it.
   *
   * @returns the validation errors, so a caller that has somewhere to show them
   *          can (the Events panel does; boot just logs).
   */
  applyEvents(json) {
    const { errors } = this.events.load(json);
    this.emit("events-changed", this.events.list());
    return errors;
  }

  /**
   * Inline output transform (outputTransform.js): the scene draws straight
   * onto the canvas instead of through three's offscreen frame buffer +
   * full-screen quad. Opt-in per host (`config.directOutput`; the player
   * turns it on), `__engineDirectOutput = false` vetoes. Called after EVERY
   * renderer construction — `init()` and the rebuild path both make one.
   */
  #installOutputTransform() {
    if (!this.renderer) return;
    if (this.config?.directOutput !== true || globalThis.__engineDirectOutput === false) return;
    installDirectOutput(this.renderer, {
      toneMapping: this.renderer.toneMapping,
      outputColorSpace: this.renderer.outputColorSpace,
    });
  }

  async init(canvas) {
    // Re-init (viewport rebuild / dev HMR): retire the old renderer first so
    // its still-running animation loop can't render through the new,
    // not-yet-initialized one.
    if (this._rendererRebuildInFlight) {
      // Wait for any pending applySettings-driven rebuild to finish before
      // we tear the renderer down — same race as in applySettings().
      try {
        await this._rendererRebuildInFlight;
      } catch {
        // Already logged by the in-flight rebuild.
      }
    }
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      if (this._gpuTimestampInFlight) await this._gpuTimestampInFlight;
      this.renderer.dispose();
    }
    this.rendererReady = false;
    // Mark this as a new rebuild generation so any stale #rebuildRenderer
    // awaiting init() will notice and abort instead of clobbering us.
    ++this._rendererRebuildSeq;
    // See #applyRendererOptionsIfChanged for why the built options are kept.
    this._rendererBuiltWith = rendererConstructorOptions(this.settings, this.config);
    freeze.bootStage("renderer: construct");
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      ...this._rendererBuiltWith,
      ...(await resolveRendererLimits()),
    });
    // Polygon-offset sign + float framebuffer depth for reversed depth. See reversedDepth.js.
    installReversedDepthGuards(this.renderer);
    this.#applyRendererSize();
    await this.renderer.init();
    freeze.bootStage(null);
    this.#installOutputTransform();
    this.#watchDevice();
    // Every synchronous pipeline/shader-module creation from here on is a
    // named span in the freeze ledger. Installed on the DEVICE (not the
    // renderer) so it survives three's internal re-wrapping, and re-armed
    // after every device swap because a rebuild hands us a new one.
    // The device ledger always installs (WGSL interning and the async
    // in-flight count are functional) and skips its per-call wrappers when the
    // ledger is off; the per-object node-build and render spans are pure
    // instrumentation and only install with it on.
    installGpuCallLedger(this.renderer?.backend?.device);
    if (freeze.enabled) {
      installNodeBuildLedger(this.renderer);
      installRenderSpans(this.renderer);
    }
    // What this session actually got. A rebuild after a device loss insists on
    // the same backend rather than accepting a WebGL fallback the canvas
    // cannot serve — see #rebuildRenderer's header.
    this._rendererWasWebGPU = this.renderer.backend?.isWebGPUBackend === true;
    configureTextureAssetLoader(this.renderer);
    // Sub-LSB dither on the output transform — without it every smooth GI
    // gradient bands into hard-edged contour rings on the 8-bit canvas.
    installOutputDither(this.renderer);
    installFramebufferCopyFormats(this.renderer);
    // Renderer-side settings (tone mapping, shadows) couldn't apply earlier.
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    this.rendererReady = true;
    // ── "renderer-ready" (zero-freeze plan unit 2.1) ──────────────────────
    // Anything that must wrap the RENDERER OR ITS DEVICE has to do it before
    // the first thing that uses them, and until this event the only hook was
    // "whenever my own system first ticks". That is how the async COMPUTE
    // pipeline path — which GI installs — ended up not installed at all on a
    // scene where GI is waiting for assets: the water module then compiled 41
    // compute pipelines synchronously inside one 667 ms frame (freeze ledger,
    // 2026-09-07), and its surface appeared 40 s after the editor was ready.
    // Emitted after init and after every rebuild, so a device swap re-arms
    // every interception.
    this.emit("renderer-ready", this.renderer);
    // Wire input once the canvas exists (the manager listens on it directly).
    if (!this.input.attached) {
      this.input.attach(canvas);
      // Unscaled — see applyInput: input must survive a paused game.
      this._inputTickUnsub = this.onUpdate(() => this.input.tick(this.unscaledDeltaTime));
    }
    return this.getBackendName();
  }

  getBackendName() {
    const backend = this.renderer?.backend;
    if (!backend) return "none";
    return backend.isWebGPUBackend ? "WebGPU" : "WebGL2 (fallback)";
  }

  start() {
    this.loopActive = true;
    this.renderer.setAnimationLoop(() => this.#tick());
    // AudioContext creation stays behind AudioSystem's first-gesture handler.
    // Eager creation here violates browser autoplay policy on a freshly
    // opened preview and produces a warning even when the scene is silent.
  }

  setFrameRateLimit(fps = 0) {
    const next = Number.isFinite(fps) && fps > 0 ? Math.max(1, fps) : 0;
    if (next === this.frameRateLimit) return;
    this.frameRateLimit = next;
    // Let the next frame through immediately after a policy change.
    this._lastFrameStart = -Infinity;
  }

  stop() {
    this.loopActive = false;
    this.renderer.setAnimationLoop(null);
  }

  /**
   * The camera component whose culling settings apply this frame.
   *
   * Usually the active camera's own. The case that makes this a method is the
   * EDITOR VIEWPORT: its camera is a plain PerspectiveCamera owned by the
   * panel, not an entity, so it has no component to read. Falling back to the
   * scene's first enabled camera is what makes the viewport cull the way the
   * shipped game will — otherwise occlusion problems are invisible until you
   * press Play, which is the slowest possible way to find them.
   *
   * Null when the scene has no camera at all; callers fall back to defaults.
   */
  governingCullingCamera() {
    const entityId = this.camera?.userData?.entityId;
    if (entityId) {
      const own = this.getEntity(entityId)?.getComponent("camera");
      if (own) return own;
    }
    for (const component of this.cameraComponents) {
      if (component.enabled !== false) return component;
    }
    return null;
  }

  /**
   * Pushes the governing camera's culling props into the systems that read
   * them. Called at the top of every tick; public because "what is actually
   * culling right now" is a question worth being able to ask without rendering
   * a frame — the tests do exactly that.
   */
  applyCullingSettings() {
    const props = this.governingCullingCamera()?.props;
    this._frustumCulling = props ? props.frustumCulling !== false : true;
    // "inherit" is what every scene authored before these props existed says,
    // and it has to keep meaning the old scene-level setting.
    const mode = props?.occlusionCulling ?? "inherit";
    const inherited = this.settings.performance?.occlusionCulling === true;
    this.occlusion.setEnabled(mode === "inherit" ? inherited : mode === "on");
    if (props) {
      this.occlusion.configure({
        minOccluderSize: props.occluderMinSize,
        bias: props.occlusionBias,
        cullShadowCasters: props.cullShadowCasters,
      });
    }
  }

  #tick() {
    const frameStarted = performance.now();
    // Counted BEFORE the limiter can turn this callback away, so the profiler
    // can tell a frame rate the app chose from one the browser imposed.
    this.stats.recordFrameCallback(frameStarted);
    if (this.frameRateLimit > 0) {
      const interval = 1000 / this.frameRateLimit;
      // A small tolerance avoids a nominal 30 fps cap becoming 20 fps because
      // two 16.6 ms RAF intervals land just below 33.333 due to timer jitter.
      if (frameStarted - this._lastFrameStart + 0.75 < interval) return;
      this._lastFrameStart = frameStarted;
    }
    // Opens the first phase. Everything from here to the matching
    // `endPhaseFrame()` at the bottom is attributed to some phase; see
    // StatsSystem's PHASES table. Disarmed, each of these is a boolean test.
    this.stats.markPhase(PHASE.frustumCull);
    this.timer.update();
    // Wall-clock delta, clamped: a backgrounded tab or a compile stall would
    // otherwise hand physics a multi-second step to tunnel through.
    const unscaled = Math.min(this.timer.getDelta(), this.maxDeltaTime);
    let dt = unscaled * this.timeScale;
    if (this.paused) {
      // Paused: game time stops but the frame still renders, so the pause menu
      // draws and stays interactive. `step()` releases a fixed slice at a time.
      if (this._stepFrames > 0) {
        this._stepFrames--;
        dt = this.stepDeltaTime;
      } else {
        dt = 0;
      }
    }
    this.unscaledDeltaTime = unscaled;
    this.deltaTime = dt;
    this.elapsedTime += dt;
    this.unscaledElapsedTime += unscaled;
    // Refresh the shared frustum before update callbacks run so per-entity
    // culling decisions see the current frame. The frustum internally
    // no-ops when the camera hasn't moved, so this is one cheap
    // matrix-multiply hash check on a static-camera frame.
    // Culling is configured on the camera (see CameraComponent), so resolve
    // whose settings apply before anything reads them.
    this.applyCullingSettings();
    this.viewFrustum.refresh(this.camera);
    // Update `_inView` on every view-only component: one sphere/plane test
    // each. The registry is maintained incrementally as components opt in and
    // out (see Component._viewOnlyActive), so this costs nothing on a scene
    // that uses no frustum gating — where the previous nested walk over every
    // entity and every component still ran in full, every frame.
    if (this.viewFrustum.isReady() && this._frustumCulling) {
      for (const c of this.viewOnlyComponents) c.updateViewVisibility(this.viewFrustum);
    } else if (!this._frustumCulling) {
      // Turning it off has to UNDO it, not just stop updating it: a component
      // left with `_inView === false` from the last frame it was tested would
      // stay hidden forever, which is the exact complaint the switch exists to
      // diagnose. `null` is the frustum's own "no camera, show everything".
      for (const c of this.viewOnlyComponents) c.updateViewVisibility(null);
    }
    // Resolve per-mode visibility onto every entity's Object3D. We write
    // only when the desired value differs from the current one so a stable
    // scene doesn't churn the matrix tree each frame. (Setting `.visible`
    // back to the same value is technically a no-op in three.js — but
    // avoiding the property assignment entirely keeps the code path
    // side-effect free and easier to reason about.)
    // Ahead of the resolve below, and after the frustum refresh above, because
    // it decides which LOD level each group wants and the resolve is the single
    // place that writes `visible`. An LOD group setting `object3D.visible`
    // itself would simply be overwritten a few lines later, every frame.
    this.stats.markPhase(PHASE.lod);
    this.lod.update();
    // After the LOD pass, because an entity the LOD system already hid is not
    // worth an occlusion test, and before the resolve for the same reason the
    // LOD pass is: `_occluded` is a veto the resolve reads, not a write to
    // `visible`. The buffer it tests against was captured a frame or two ago
    // (see OcclusionSystem) — this is where that latency lands.
    this.stats.markPhase(PHASE.occlusionApply);
    this.occlusion.apply();
    this.stats.markPhase(PHASE.visibilityWalk);
    // Components first: a disabled entity's components are DETACHED, not just
    // hidden (Entity.reconcileActivity). The setters and setParent already did
    // this the moment they ran; the walk is the safety net for anything that
    // wrote the flags or the tree without going through them. One boolean
    // compare per entity on a frame where nothing changed.
    for (const entity of this.rootEntities) entity.reconcileActivity(true);
    for (const entity of this.entities.values()) {
      // `_lodHidden` and `_occluded` are vetoes, not overrides: a level the
      // author disabled stays hidden even when the camera asks for it, and
      // nothing either system does can make a disabled entity draw. While
      // editing, `visibleInEditor` (the viewing aid) hides too.
      const authored = entity.enabled !== false && (this.playing || entity.visibleInEditor !== false);
      const next = authored && entity._lodHidden !== true && entity._occluded !== true;
      // CAMERA-HIDDEN ≠ ABSENT. `_lodHidden`/`_occluded` are VIEW decisions,
      // so `visible === false` alone cannot tell a world-space consumer
      // whether the author disabled this entity or the camera merely cannot
      // see it right now. GI's mesh collect read it as absent, which made the
      // GI mesh set a function of the CAMERA: every camera move changed the
      // set, bumped the occupancy geometry revision, forced a composite and
      // reset the converged-idle counter — the reported "GI re-runs whenever
      // I move the camera" (120→60 fps). It is also wrong on its own terms:
      // a prop culled behind the viewer still bounces light onto what is in
      // front of them, and dropping it opens a hole the cascades trace
      // through. Marked here because this loop is the only writer of
      // `visible` and the only place both terms are known.
      entity.object3D.userData.cameraHidden = authored && !next;
      if (entity.object3D.visible !== next) entity.object3D.visible = next;
    }
    // First of the per-frame systems, and ahead of every update callback: a
    // timer that comes due this frame should have had its effect before any
    // script looks at the world, or every timed event in the game is read one
    // frame after it happened. Also the only writer of `engine.time`'s clocks.
    this.stats.markPhase(PHASE.coreSystems);
    this.time.update(dt, unscaled);
    // Ahead of the update callbacks so a shake fired by a script this frame is
    // sampled by the camera brain in the SAME frame — a one-frame delay is
    // exactly long enough for a hit to feel disconnected from its impact.
    this.cameraImpulse.update(dt);
    // Before the update callbacks, so a script reading a tweened value this
    // frame sees the value for this frame rather than the previous one.
    this.tweens.update(dt, unscaled);
    // Unscaled: a debug line's `duration` is a real-world "let me see it for
    // two seconds", so bullet time must not stretch it to thirteen and a
    // paused game must not freeze it on screen forever.
    this.debug.tick(unscaled);
    // Scaled, unlike debug draw: a decal is part of the world, so bullet time
    // slows its fade and a pause freezes it mid-fade.
    this.decals.update(dt);
    // Timed despawns run on game time (a corpse fading out is part of the
    // world); the queue drains on WALL CLOCK, because prewarming happens behind
    // a loading screen with the game paused — see pool.js. Ahead of the update
    // callbacks so an entity queued last frame is live for this one.
    this.pool.update(dt);
    this.pool.drain();
    // Ahead of the update callbacks — and therefore ahead of the physics
    // module, which registers one — so a kinematic platform riding a spline is
    // already at this frame's position when the step that carries its riders
    // runs. See spline/PathSystem.js.
    this.paths.update(dt);
    this.stats.markPhase(PHASE.scripts);
    // With a breakdown armed every callback is timed and charged to its owner
    // (see `_registrant`); otherwise the loop is the bare loop it always was.
    if (this.stats._attribArmed) {
      for (const fn of this.updateCallbacks) {
        if (this.#muted(fn)) continue;
        const t0 = performance.now();
        this.stats._dispatchOwner = this.stats.rowFor(fn, "update");
        fn(dt);
        this.stats.attribute(fn, "update", performance.now() - t0);
        this.stats._dispatchOwner = null;
      }
    } else {
      for (const fn of this.updateCallbacks) { if (!this.#muted(fn)) fn(dt); }
    }
    // Snapshot: a late callback that unsubscribes itself (an IK component
    // detaching on the frame its target is destroyed) would otherwise mutate
    // the array being iterated.
    if (this.lateUpdateCallbacks.length) {
      if (this.stats._attribArmed) {
        for (const entry of [...this.lateUpdateCallbacks]) {
          if (this.#muted(entry.fn)) continue;
          const t0 = performance.now();
          this.stats._dispatchOwner = this.stats.rowFor(entry.fn, "lateUpdate");
          entry.fn(dt);
          this.stats.attribute(entry.fn, "lateUpdate", performance.now() - t0);
          this.stats._dispatchOwner = null;
        }
      } else {
        for (const entry of [...this.lateUpdateCallbacks]) { if (!this.#muted(entry.fn)) entry.fn(dt); }
      }
    }
    // Audio updates go after the script tick so per-frame transforms are
    // up to date (sound positions + listener pose). Deliberately UNSCALED:
    // this is bookkeeping (listener pose, fades), not simulation, and a
    // pause menu's music should not stop ramping because the game froze.
    this.stats.markPhase(PHASE.audio);
    this.audio.update?.(unscaled);
    // rendererReady guards the re-init window (init() swaps the renderer
    // asynchronously; rendering before its backend resolves throws).
    //
    // EVERY path out of here that does not reach the render call tells the
    // stats system so, because a tick without a draw is not a frame. Counting
    // them as frames is what let a frozen viewport report a healthy frame
    // rate; see StatsSystem.recordPresentedFrame.
    if (this.camera && this.rendererReady) {
      // A renderer resize temporarily stops the animation loop and drains
      // submitted GPU work. If it was requested from inside an update
      // callback, do not encode another frame after the drain was scheduled.
      if (this._resizeInFlight) {
        this.stats.recordSkippedFrame();
        // §18 W3: a tick without a draw is not a measurement. See governor.hold().
        this.frameGovernor.hold();
        this.stats.endPhaseFrame();
        return;
      }
      // Systems may briefly suspend scene rendering while an async pipeline
      // compile wave fills the cache (GI rebuilds): the viewport holds its
      // last frame but the app stays interactive, instead of the render
      // call blocking the main thread for the whole wave.
      if (this.renderSuspended) {
        this.stats.recordSkippedFrame();
        // §18 W3: a tick without a draw is not a measurement. See governor.hold().
        this.frameGovernor.hold();
        this.stats.endPhaseFrame();
        return;
      }
      // Final-transform passes (e.g. GI deferred prepass) run here: after
      // physics/scripts have written this frame's transforms, before the
      // main draw that samples their output.
      // Refresh instanced batches before any pre-render pass reads the
      // scene, so a GI/postprocess prepass and the main draw agree on what
      // is on screen.
      // ── ONE MATRIX WALK PER FRAME (2026-09-04, plan §11.41) ──────────────
      // `scene.updateMatrixWorld()` recomposes every auto-update object it
      // visits whether or not anything moved — 2.1 ms on Bistro
      // (profile.cpuFrame `merging.matrixWorld`) — and the frame paid it
      // THREE times: merging's motion watch, the GI g-buffer prepass render
      // and the main render (three walks the scene inside every `render()`
      // while `scene.matrixWorldAutoUpdate` is true). Scripts, physics and
      // animation have written this frame's transforms by now, so one walk
      // here is the frame's truth; the renders inside this tick are told
      // not to repeat it (#walkSceneOnce), and the flag goes back before the
      // tick ends (#endWalkedFrame) so a render outside the tick — a
      // thumbnail, a probe capture — still walks for itself.
      this.stats.markPhase(PHASE.matrixWorld);
      this.#installRenderMarks();
      this.#walkSceneOnce();
      const rebuildsHeld = this.simulationSuspended === true;
      this.stats.markPhase(PHASE.batching);
      if (!rebuildsHeld) this.batching.sync();
      // After batching, and for the same reason batching runs before the
      // pre-render passes: a GI/postprocess prepass and the main draw must
      // agree on what is on screen. Merging skips anything batching already
      // claimed, so the order also settles which system owns a mesh both
      // could take.
      //
      // ⚠ ALL OF THESE STAND DOWN UNDER `simulationSuspended` (see the method).
      // They are REBUILD systems: while a modal mode has the user inside one
      // mesh, re-grouping the rest of the scene is pure interference, and each
      // of them is an O(scene) walk that can mint geometry and materials.
      this.stats.markPhase(PHASE.merging);
      if (!rebuildsHeld) this.merging.sync();
      // ⚠ AFTER `merging.sync()`, and that is structural rather than ordering
      // taste: the set the shadow merge replaces is whatever the depth pass
      // draws TODAY, which includes merging's own batch proxies. Running it
      // first would merge the originals merging is about to hide, and merging
      // would then hide meshes this system had already taken `castShadow` from.
      if (!rebuildsHeld) this.shadowMerge.sync();
      // Impostor bakes are nested renders, so they belong here — after the
      // scene's transforms are final and before the main draw. At most one
      // atlas is baked per frame; the rest of this call just refreshes the
      // instance buffers.
      this.stats.markPhase(PHASE.impostors);
      if (!rebuildsHeld) this.impostors.update();
      // The occluder depth pass reads the same finished transforms the main
      // draw is about to. It renders and starts an async readback; the result
      // is applied at the top of a later tick, which is what keeps this off the
      // critical path.
      this.stats.markPhase(PHASE.occlusionRender);
      if (!rebuildsHeld) this.occlusion.render();
      this.stats.markPhase(PHASE.preRender);
      // Spanned for the freeze ledger: GI's rebuild and its g-buffer prepass
      // both live here, and this phase has owned every boot freeze this
      // project has diagnosed. GI marks its own stages inside, so an
      // attributed block reads `gi:rebuild/staticBvh` rather than `preRender`.
      const preRenderSpan = freeze.begin("frame:preRender");
      try {
        if (this.stats._attribArmed) {
          for (const fn of this.preRenderCallbacks) {
            if (this.#muted(fn)) continue;
            const t0 = performance.now();
            this.stats._dispatchOwner = this.stats.rowFor(fn, "preRender");
            fn();
            this.stats.attribute(fn, "preRender", performance.now() - t0);
            this.stats._dispatchOwner = null;
          }
        } else {
          for (const fn of this.preRenderCallbacks) { if (!this.#muted(fn)) fn(); }
        }
      } finally {
        freeze.end(preRenderSpan);
      }
      // After the preRender callbacks, so the editor's own gizmo pass — which
      // runs there and may itself draw through `engine.debug` — is included in
      // this frame's upload rather than the next one's.
      this.stats.markPhase(PHASE.debugFlush);
      this.debug.flush();
      // Re-check: a preRender callback (GI rebuild) may have suspended
      // rendering THIS frame — rendering now would sync-compile the whole
      // material wave in this frame, the exact freeze suspension prevents.
      if (this.renderSuspended) {
        this.#endWalkedFrame();
        this.stats.recordSkippedFrame();
        // §18 W3: a tick without a draw is not a measurement. See governor.hold().
        this.frameGovernor.hold();
        this.stats.endPhaseFrame();
        return;
      }
      // ⚠ AFTER the preRender callbacks, and that is not a preference.
      // LightComponent recentres a directional light's shadow camera from an
      // `onPreRender` callback, so before this point the shadow camera is still
      // LAST frame's. Fingerprinting there froze the map against a stale camera
      // and then let the real one move underneath it — the map stopped being
      // redrawn while the matrix the lookups use kept changing, which renders as
      // hard stair-stepped shadow edges in the wrong place. It also has to stay
      // after batching/merging/impostors for the ordinary reason: the caster
      // transforms must be this frame's final ones.
      //
      // ⚠⚠ AND AFTER THE `renderSuspended` RE-CHECK ABOVE, WHICH IT WAS NOT.
      // `ShadowFreezeSystem` freezes a light the second time it sees the same
      // content key, and the whole safety of that rule rests on three having
      // rendered the map at least once in between — its own header says so.
      // That holds only if every `update()` is followed by a draw. Sitting
      // ABOVE this early return, it also counted ticks that never rendered: a
      // GI rebuild suspends here, the key is stored on a frame with no draw,
      // and the next tick to get this far matches it and switches `autoUpdate`
      // off on a map three never rendered. Both flags are then false, three's
      // gate is `needsUpdate || autoUpdate`, and the map stays EMPTY for the
      // rest of the session — "shadows are broken after each reload, I have to
      // change the bias to fix them" (user, 2026-08-25), bias being one of the
      // few edits that sets `needsUpdate` and forces the render three skipped.
      this.stats.markPhase(PHASE.shadowFreeze);
      this.shadowFreeze.update();
      // Wall-clock the GPU-submit portion of the frame so the stats
      // overlay's "GPU" reading reflects only the render call, not the
      // script tick. WebGPU dispatches the actual GPU work asynchronously,
      // so this is command-encoding time, not hardware GPU time — but it's
      // the closest portable signal without WebGPU timestamp-query support.
      this.stats.markPhase(PHASE.renderEncode);
      const t0 = performance.now();
      const override = this.#activeRenderOverride();
      // Native occlusion flags must span only the final scene render. Arming
      // them in the earlier occlusion phase lets GI/editor nested renders
      // produce results for a different render context and camera.
      this.occlusion.prepareMainRender();
      // The ONE render that presents the frame compiles its large material
      // pipelines asynchronously and skips the draw until they land — see
      // asyncRenderPipelines.js for the freeze it removes and why the scope
      // is exactly this call (nested one-shot renders must stay sync).
      const asyncPipelines = installAsyncRenderPipelines(this.renderer);
      if (asyncPipelines) asyncPipelines.active = true;
      const encodeSpan = freeze.begin("frame:renderEncode");
      try {
        if (override) {
          // The override (typically a PostprocessComponent) runs the scene
          // render to its own offscreen target and the post-graph blit to
        // the canvas — via three's RenderPipeline + PassNode, which
          // handles all render-target bookkeeping internally. Skipping
          // the default renderer.render() avoids a redundant scene draw
        // (and the WebGPU validation errors that follow from manual
        // setRenderTarget calls).
          // The override's pipeline reads the REAL tone mapping for its own
          // output pass (three swaps them around its quad itself).
          // 1× canvas from here through the postRender callbacks (see
          // enterSingleSampleCanvas); closed after them.
          this.#singleSampleRestore ??= enterSingleSampleCanvas(this.renderer);
          withRealOutput(this.renderer, () => override.render(this));
        } else {
          this.#exitSingleSampleCanvas();
          dropStaleFrameBufferTargets(this.renderer);
          this.renderer.render(this.scene, this.camera);
        }
      } finally {
        freeze.end(encodeSpan);
        if (asyncPipelines) asyncPipelines.active = false;
        // Query flags are render-context state. Do not let a post-render
        // screenshot/debug/GI render consume them with another camera.
        this.occlusion.finishMainRender();
        this.#endWalkedFrame();
      }
      const t1 = performance.now();
      this.stats.recordRenderMs(t1 - t0);
      // The one place a frame is counted. Stamped with the time the draw was
      // submitted rather than the time the tick began, so the FPS window
      // measures presents and not update-phase starts.
      this.stats.recordPresentedFrame(t1);
      // Snapshot three's per-frame renderer metrics (draw calls, triangles,
      // texture memory). Has to happen AFTER render() returns because
      // three's animation loop resets these counters at the start of each
      // frame, before user code runs. See StatsSystem header for the
      // timing rationale.
      this.stats.recordRenderInfo();
      this.#countDispatches();
      this.#resolveGpuTimestamps();
      this.#updateDynamicResolution();
      // §18 W3, and deliberately in the same slot as the DRS loop: both read
      // `stats.readout.gpuMs`, which only carries this frame's number once
      // `#resolveGpuTimestamps` has landed it. Running the governor earlier in
      // the tick would feed it a frame-old measurement of a rung it may have
      // already left. GI reads `giCostScale` from its own preRender callback,
      // so a level set here takes effect on the very next tick.
      this.frameGovernor.update();
    } else {
      // No camera, or the renderer is mid-swap. The loop is running and the
      // canvas is not changing — the same thing a suspended wave looks like.
      this.stats.recordSkippedFrame();
      this.frameGovernor.hold();
    }
    // Post-render passes draw on top of the main render's pixels. The
    // WebGPU backend's render pass starts with `loadOp: Clear`, so any
    // post-render `renderer.render(...)` would wipe the canvas — callers
    // must temporarily disable `autoClear` (and re-enable it) to preserve
    // the main scene underneath.
    this.stats.markPhase(PHASE.postRender);
    if (this.stats._attribArmed) {
      for (const fn of this.postRenderCallbacks) {
        if (this.#muted(fn)) continue;
        const t0 = performance.now();
        this.stats._dispatchOwner = this.stats.rowFor(fn, "postRender");
        fn();
        this.stats.attribute(fn, "postRender", performance.now() - t0);
        this.stats._dispatchOwner = null;
      }
    } else {
      for (const fn of this.postRenderCallbacks) { if (!this.#muted(fn)) fn(); }
    }
    this.#exitSingleSampleCanvas();
    this.stats.endPhaseFrame();
    this.stats.recordFrameWorkMs(performance.now() - frameStarted);
  }

  /**
   * Reads back the WebGPU timestamp queries written during this frame's
   * passes. `trackTimestamp: true` (set in rendererConstructorOptions) makes
   * the backend bracket render and compute passes with GPU timestamps. Both
   * pools are resolved because virtual geometry uses compute passes heavily.
   * That's the number that actually moves when SSGI/SSR/volumes get cheaper
   * — unlike the CPU-side submit time the stats previously showed.
   *
   * The resolve is async (a small GPU→CPU readback), so the reading shown is
   * one-to-a-few frames stale — fine for a tuning readout. On adapters
   * without the timestamp-query feature the backend no-ops and the value
   * stays 0; StatsSystem falls back to submit time in that case.
   */
  /**
   * Counts every compute dispatch and charges it to the callback that asked.
   *
   * ⚠ THIS IS THE HOLE THE CLOTH FELL THROUGH. A cloth component's own update
   * measures 0.008 ms — it builds a queue and hands it to `renderer.compute`
   * — so every CPU profiler in this editor called it free while the frame sat
   * at 30 ms. The work is real and it is enormous (two to six substeps of
   * about fifty kernels each, three hundred dispatches a frame), it just is
   * not on the main thread. Counting dispatches per owner shows it without
   * needing per-dispatch GPU timing, and for a dispatch-bound solver the
   * count IS the cost.
   *
   * Idempotent, and a no-op when the profiler is not armed: one property read
   * per compute call.
   */
  #countDispatches() {
    const renderer = this.renderer;
    if (!renderer || renderer.__dispatchCounted) return;
    renderer.__dispatchCounted = true;
    const stats = this.stats;
    for (const name of ["compute", "computeAsync"]) {
      const original = renderer[name];
      if (typeof original !== "function") continue;
      renderer[name] = function countedCompute(node, ...rest) {
        if (stats._attribArmed) {
          stats.attributeDispatches(Array.isArray(node) ? node.length : 1);
        }
        return original.call(this, node, ...rest);
      };
    }
  }

  /** True while this callback's owner is being measured by its absence. */
  #muted(fn) {
    return this._mutedOwners.size > 0 && !!fn?.__owner && this._mutedOwners.has(fn.__owner);
  }

  /** Skip these owners' per-frame callbacks until `unmuteOwners`. */
  muteOwners(owners) {
    for (const owner of owners) if (owner) this._mutedOwners.add(owner);
  }

  /** Restore every muted owner. Always call this, including on failure. */
  unmuteOwners() {
    this._mutedOwners.clear();
  }

  /** Every distinct owner that has a per-frame callback registered. */
  frameOwners() {
    const out = new Set();
    const add = (fn) => { if (fn?.__owner) out.add(fn.__owner); };
    for (const fn of this.updateCallbacks) add(fn);
    for (const entry of this.lateUpdateCallbacks) add(entry.fn);
    for (const fn of this.preRenderCallbacks) add(fn);
    for (const fn of this.postRenderCallbacks) add(fn);
    return [...out];
  }

  #resolveGpuTimestamps() {
    const renderer = this.renderer;
    if (!renderer?.backend?.trackTimestamp || this._gpuTimestampInFlight) return;
    installGpuTimestampRetention(renderer);
    const readback = Promise.all([
      renderer.resolveTimestampsAsync("render"),
      renderer.resolveTimestampsAsync("compute"),
    ])
      .then(([renderDuration, computeDuration]) => {
        // Include virtual-geometry compute work in the GPU readout and drain
        // its fixed-size query pool along with the render query pool.
        const duration =
          (typeof renderDuration === "number" ? renderDuration : 0) +
          (typeof computeDuration === "number" ? computeDuration : 0);
        if (duration > 0) {
          this.stats.recordGpuMs(
            duration,
            typeof renderDuration === "number" ? renderDuration : 0,
            typeof computeDuration === "number" ? computeDuration : 0,
          );
        }
      })
      .catch(() => {
        // Device loss can still reject a readback; keep it contained here.
      })
      .finally(() => {
        if (this._gpuTimestampInFlight === readback) this._gpuTimestampInFlight = null;
      });
    this._gpuTimestampInFlight = readback;
  }

  /**
   * Dynamic-resolution controller. When enabled, nudges `_drsScale` between
   * 0.5 and 1 so the GPU frame time tracks `settings.performance.targetFps`.
   *
   * Control loop: EMA the GPU frame time (real timestamps when available,
   * frame wall time otherwise), then at most twice a second either back off
   * (over ~95% of budget → drop 0.1) or recover (under ~65% → climb 0.05).
   * The asymmetric step + the 65–95% dead zone stops it oscillating around
   * the budget. Each change reallocates the canvas backing store, which is
   * why changes are rate-limited rather than continuous.
   */
  #updateDynamicResolution() {
    const perf = this.settings.performance;
    if (!perf?.dynamicResolution) {
      if (this._drsScale !== 1) {
        this._drsScale = 1;
        this._drsEmaMs = 0;
        this.#scheduleRendererResize();
      }
      return;
    }
    const r = this.stats.readout;
    // The display's rate is the PEAK callback rate the host has handed us;
    // see dynamicResolution.js for why a phone must not be asked for 120.
    if (r.callbackFps > (this._drsPeakCallbackFps ?? 0)) this._drsPeakCallbackFps = r.callbackFps;
    const budgetMs = drsBudgetMs(perf.targetFps, this._drsPeakCallbackFps ?? 0);
    // Prefer real GPU time; a CPU-bound frame shouldn't drive resolution
    // down (it wouldn't help). frameMs is the honest fallback when the
    // adapter has no timestamp queries.
    const signal = r.gpuMs > 0 ? r.gpuMs : r.frameMs;
    if (!(signal > 0)) return;
    this._drsEmaMs = this._drsEmaMs === 0 ? signal : 0.1 * signal + 0.9 * this._drsEmaMs;
    const now = performance.now();
    if (now - this._drsLastChange < 500) return;
    let next = this._drsScale;
    if (this._drsEmaMs > budgetMs * 0.95) next = Math.max(0.5, this._drsScale - 0.1);
    else if (this._drsEmaMs < budgetMs * 0.65) next = Math.min(1, this._drsScale + 0.05);
    if (Math.abs(next - this._drsScale) > 1e-3) {
      this._drsScale = next;
      this._drsLastChange = now;
      this.#scheduleRendererResize();
    }
  }

  /** Register a per-frame callback; returns an unsubscribe function. */
  onUpdate(fn) {
    tagOwner(fn, this._registrant);
    this.updateCallbacks.add(fn);
    return () => this.updateCallbacks.delete(fn);
  }

  /**
   * Register a callback that fires after every `onUpdate` callback, in
   * ascending `order`. This is the pose pipeline's stage list — the animator
   * runs in `onUpdate`, then IK solvers (order 0), then bone-attachment sync
   * (order 100). Returns an unsubscribe function.
   *
   * Ties keep insertion order, so equal-order callbacks behave like `onUpdate`.
   */
  onLateUpdate(fn, order = 0) {
    tagOwner(fn, this._registrant);
    const entry = { fn, order };
    // Stable insert: scan to the first entry that sorts after this one rather
    // than push-then-sort, which Array#sort would leave unstable for ties.
    let index = this.lateUpdateCallbacks.length;
    for (let i = 0; i < this.lateUpdateCallbacks.length; i++) {
      if (this.lateUpdateCallbacks[i].order > order) {
        index = i;
        break;
      }
    }
    this.lateUpdateCallbacks.splice(index, 0, entry);
    return () => {
      const at = this.lateUpdateCallbacks.indexOf(entry);
      if (at >= 0) this.lateUpdateCallbacks.splice(at, 1);
    };
  }

  /**
   * Register a callback that fires after all update callbacks but before the
   * main render each frame. Use for passes that must see the frame's final
   * transforms yet produce output the main render consumes (e.g. the GI
   * deferred prepass). Returns an unsubscribe function.
   */
  onPreRender(fn) {
    tagOwner(fn, this._registrant);
    this.preRenderCallbacks.add(fn);
    return () => this.preRenderCallbacks.delete(fn);
  }

  /**
   * Register a callback that fires after the main render each frame.
   * Use for layered effects (camera preview, gizmo overlays) that need
   * to draw on top of the main scene. The callback is responsible for
   * setting up its own render state (scissor, viewport, autoClear) so
   * the main render's pixels survive.
   */
  onPostRender(fn) {
    tagOwner(fn, this._registrant);
    this.postRenderCallbacks.add(fn);
    return () => this.postRenderCallbacks.delete(fn);
  }

  /**
   * Registers a per-camera render override. The override is a Component
   * with an `ownsCamera(engine) → boolean` predicate (true when its camera
   * is the active one AND it's enabled) and a `render(engine)` method
   * that performs both the scene render and any post-pass to the canvas.
   *
   * While an override is active, the engine skips its default
   * `renderer.render(scene, camera)` and lets the override drive the frame.
   * Overrides are typically `PostprocessComponent` instances — see
   * `src/modules/postprocessing/PostprocessComponent.js`.
   */
  registerRenderOverride(component) {
    if (!component || typeof component.render !== "function") {
      console.warn("registerRenderOverride: component must implement render(engine)");
      return;
    }
    this.renderOverrides.add(component);
  }

  unregisterRenderOverride(component) {
    this.renderOverrides.delete(component);
  }

  /** First override whose `ownsCamera()` returns true, or null. */
  /**
   * §11.42 — sub-marks INSIDE three's render, read by profile.cpuFrame /
   * profile.orbit: `render.project@<phase>` is everything `_renderScene` does
   * around the draw loop (the render-list build over every object, sorting,
   * lights, background) and `render.draw@<phase>` is `_renderObjects` (the
   * per-draw bindings/pipeline/encode loop). Keyed by tick phase so the GI
   * g-buffer prepass (preRender) and the main pass (renderEncode) read
   * apart. Installed once per renderer; costs two early-returning calls per
   * render when no capture is armed.
   */
  #installRenderMarks() {
    const renderer = this.renderer;
    const stats = this.stats;
    if (!renderer || renderer.__engineRenderMarks || !stats?.markSub) return;
    const origScene = renderer._renderScene;
    const origObjects = renderer._renderObjects;
    if (typeof origScene !== "function" || typeof origObjects !== "function") return;
    renderer.__engineRenderMarks = true;
    renderer._renderScene = function (...args) {
      const outer = stats.currentSubName();
      stats.markSub(`render.project@${stats.currentPhaseName()}`);
      try {
        return origScene.apply(this, args);
      } finally {
        stats.markSub(outer);
      }
    };
    renderer._renderObjects = function (...args) {
      const outer = stats.currentSubName();
      stats.markSub(`render.draw@${stats.currentPhaseName()}`);
      try {
        return origObjects.apply(this, args);
      } finally {
        stats.markSub(outer);
      }
    };
  }

  /**
   * §11.41 — the frame's single scene matrix walk. Walks now, then switches
   * the scene's `matrixWorldAutoUpdate` off so the renders inside this tick
   * (the GI g-buffer prepass, the main pass) do not walk again;
   * #endWalkedFrame puts the flag back. `__engineWalkPerRender = true`
   * restores the per-render walks (the pre-§11.41 behaviour) for an A/B.
   */
  #walkSceneOnce() {
    const scene = this.scene;
    if (!scene) return;
    scene.updateMatrixWorld();
    // ⛔ OPT-IN (§11.47). Switching the scene's auto-update off for the tick's
    // renders makes anything moved in the preRender phase a FRAME STALE, and
    // `LightComponent` re-aims the directional light and rebuilds its CSM
    // frustums in exactly that phase — so the sun's shadow was being rendered
    // from last frame's pose every frame. That reads as flat, cold lighting
    // and NO GI instrument can see it: the transport is fed a stale sun and
    // reports healthy timings, healthy stability and a healthy light
    // response. `__engineWalkOnce = true` re-arms the single walk (worth
    // 6.4 ms of CPU under motion) once the preRender movers are walked too.
    if (globalThis.__engineWalkOnce !== true) return;
    this._walkedScene = scene;
    this._walkedAutoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
  }

  #endWalkedFrame() {
    const scene = this._walkedScene;
    if (!scene) return;
    scene.matrixWorldAutoUpdate = this._walkedAutoUpdate ?? true;
    this._walkedScene = null;
  }

  #activeRenderOverride() {
    for (const o of this.renderOverrides) {
      if (o.ownsCamera?.(this)) return o;
    }
    return null;
  }

  /** Sets the desired DPR; the actual DPR may be lowered to fit GPU limits. */
  setPixelRatio(pixelRatio) {
    const next = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    this._pixelRatio = next;
    if (this.renderer) this.#scheduleRendererResize();
  }

  #scheduleRendererResize() {
    const renderer = this.renderer;
    if (!renderer) return;
    const queue = renderer.backend?.device?.queue;
    if (!this.rendererReady || !queue?.onSubmittedWorkDone) {
      this.#applyRendererSize();
      return;
    }
    // Coalesce ResizeObserver, DPR, render-scale, and DRS changes. The final
    // dimensions are read only after the queue is safe, so intermediate
    // requests cost nothing.
    if (this._resizeInFlight) return;
    renderer.setAnimationLoop(null);
    const work = queue
      .onSubmittedWorkDone()
      .catch(() => {})
      .then(() => {
        if (renderer === this.renderer) this.#applyRendererSize();
      })
      .finally(() => {
        if (this._resizeInFlight !== work) return;
        this._resizeInFlight = null;
        if (this.loopActive && renderer === this.renderer) {
          renderer.setAnimationLoop(() => this.#tick());
        }
      });
    this._resizeInFlight = work;
  }

  #applyRendererSize() {
    if (!this.renderer) return;

    const width = this._width;
    const height = this._height;
    // Render scale folds into the pixel ratio: the canvas keeps its CSS
    // size while the backing store shrinks, and the browser upscales
    // bilinearly. This scales EVERY pass (scene, SSGI/SSR offscreen
    // targets, post quad) in one place — the same lever console games
    // call "resolution scale".
    const configuredDpr = this.settings.performance?.maxDevicePixelRatio ?? 2;
    const maxDpr = Number.isFinite(configuredDpr)
      ? Math.min(4, Math.max(0.5, configuredDpr))
      : 2;
    let pixelRatio = Math.min(this._pixelRatio, maxDpr) * this.renderScale;

    // WebGPU exposes the effective device limit after init. Before init, use
    // WebGPU's guaranteed default limit so a rebuild can never create an
    // invalid canvas/MSAA attachment on the first frame.
    const deviceLimit = this.renderer.backend?.device?.limits?.maxTextureDimension2D;
    const maxDimension = Number.isFinite(deviceLimit) ? deviceLimit : 8192;
    if (width > 0 && height > 0) {
      pixelRatio = Math.min(pixelRatio, maxDimension / width, maxDimension / height);
    }

    // CanvasTarget.setPixelRatio() performs an implicit resize of the old
    // logical size. Calling setSize() immediately afterwards therefore
    // creates two attachment generations and can leave cached WebGPU render
    // contexts referencing the first, already-destroyed depth texture.
    // Apply logical size + DPR atomically so there is only one generation.
    if (width > 0 && height > 0) {
      this.renderer.setDrawingBufferSize(
        width,
        height,
        Math.max(pixelRatio, Number.EPSILON),
      );
    }
  }

  setSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    this._width = width;
    this._height = height;
    // A taller-than-wide canvas is a portrait device; the per-platform
    // configs follow (a no-op while the editor's preview override pins it).
    this._platformBase.orientation = height > width ? "portrait" : "landscape";
    this.#resolvePlatform();
    if (!this.renderer) return;
    this.#scheduleRendererResize();
    if (this.camera?.isPerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    // Resize hooks for components that own render targets (e.g. the
    // PostprocessComponent's beauty RT). The render loop walks the set
    // every time; cheap, no bookkeeping needed.
    for (const o of this.renderOverrides) o.handleResize?.(width, height);
  }

  // ── Platform context ─────────────────────────────────────────────────────

  /**
   * The override layers the current platform applies to every component's
   * props — `[]` on desktop, `["mobile", "portrait"]` on an upright phone.
   * See componentVariants.js.
   */
  get platformLayers() {
    return platformLayers(this.platform);
  }

  /**
   * Sets the device this engine runs on. `platform` is "desktop" or "mobile";
   * `orientation` may be given to pin it, otherwise it keeps following the
   * canvas shape. The player calls this once at boot from the user agent.
   */
  setPlatform({ platform, orientation } = {}) {
    if (platform === "desktop" || platform === "mobile") this._platformBase.platform = platform;
    if (orientation === "portrait" || orientation === "landscape") this._platformBase.orientation = orientation;
    this.#resolvePlatform();
  }

  /**
   * The editor's preview: a full context that wins over the device and the
   * canvas shape (`null` clears it). `orientation: null` means "the phone
   * with no orientation layer" — the shared `mobile` set on its own.
   */
  setPlatformOverride(context) {
    this._platformOverride = context
      ? {
          platform: context.platform === "mobile" ? "mobile" : "desktop",
          orientation:
            context.orientation === "portrait" || context.orientation === "landscape" ? context.orientation : null,
        }
      : null;
    this.#resolvePlatform();
  }

  /**
   * Recomputes `this.platform` and, when its layers changed, re-resolves every
   * component that carries override sets and announces "platform-changed".
   * Cheap when nothing moved — `setSize` calls it on every resize.
   */
  #resolvePlatform() {
    const next = this._platformOverride ?? this._platformBase;
    const before = platformLayers(this.platform).join("/");
    const after = platformLayers(next).join("/");
    const same = this.platform.platform === next.platform && this.platform.orientation === next.orientation;
    if (same) return;
    this.platform = { platform: next.platform, orientation: next.orientation };
    if (before !== after) {
      const layers = platformLayers(this.platform);
      for (const component of this.variantComponents) component.applyPlatformLayers(layers);
    }
    this.emit("platform-changed", { ...this.platform, layers: platformLayers(this.platform) });
  }

  createEntity({ id, name = "Entity", parent = null } = {}) {
    const entity = new Entity(this, { id, name });
    this.entities.set(entity.id, entity);
    entity.setParent(parent);
    this.emit("hierarchy-changed");
    return entity;
  }

  /**
   * Spawns a prefab. The workhorse of runtime content: bullets, enemies,
   * pickups. Synchronous — every prefab is in the registry before the scene
   * loads (the editor scans the project; a build embeds them in scene.json) —
   * so scripts can call it straight from `update()` without awaiting.
   *
   *   const bullet = this.entity.engine.instantiate(this.bulletPrefab, {
   *     position: muzzle.getWorldPosition(new THREE.Vector3()),
   *   });
   *
   * `ref` is whatever the inspector's prefab field gave you (an asset path),
   * a prefab guid, or a `{ guid, path }` link. Returns the instance root
   * entity, or null when the prefab can't be found.
   */
  instantiate(ref, { parent = null, position, rotation, scale, name } = {}) {
    const link = typeof ref === "string" ? (prefabRegistry.has(ref) ? { guid: ref } : { path: ref }) : ref;
    const guid = prefabRegistry.resolveLink(link);
    if (!guid) {
      console.warn(`instantiate: prefab not found (${typeof ref === "string" ? ref : JSON.stringify(ref)})`);
      return null;
    }
    const entity = this.batchHierarchy(() => {
      const created = instantiatePrefabNode(this, { prefab: { guid, path: prefabRegistry.pathOf(guid) } }, parent);
      if (position) created.position = position;
      if (rotation) created.rotation = rotation;
      if (scale) created.scale = scale;
      if (name) created.name = name;
      return created;
    });
    // Announced once the subtree is complete AND placed. Systems that build
    // from the entity tree (physics bodies) need both: half a subtree has no
    // ancestor body to attach a child collider to, and a body created before
    // the spawn position is applied puts the bullet back at the muzzle's
    // authored origin.
    this.emit("entity-spawned", entity);
    return entity;
  }

  /**
   * `instantiate` spread over frames. Identical result, but the work waits for
   * room in the spawn budget (`engine.pool.budgetMs`, wall clock) instead of
   * landing entirely in the frame that asked for it:
   *
   *   const boss = await this.engine.instantiateAsync(this.bossPrefab);
   *
   * For anything spawned repeatedly, prefer `engine.spawn` — a pool makes the
   * cost disappear rather than merely spreading it.
   */
  instantiateAsync(ref, options) {
    return this.pool.enqueue(() => this.instantiate(ref, options));
  }

  /**
   * Pooled spawn: reuses a parked instance of this prefab when there is one,
   * otherwise instantiates. Interchangeable with `instantiate` — a recycled
   * instance is restored to its prefab state and its scripts get a fresh
   * `onStart`, so gameplay code cannot tell the two apart. See pool.js.
   *
   *   const bullet = this.engine.spawn(this.bulletPrefab, { position: muzzle });
   */
  spawn(ref, options) {
    return this.pool.spawn(ref, options);
  }

  /**
   * Returns a pooled instance to its pool (or destroys an entity that never
   * came from one). `delay` is in seconds of game time.
   *
   *   this.engine.despawn(this.entity);        // now
   *   this.engine.despawn(this.entity, 3);     // in three seconds
   */
  despawn(entity, delay) {
    const target = typeof entity === "string" ? this.getEntity(entity) : entity;
    return target ? this.pool.despawn(target, delay) : false;
  }

  /**
   * Loads a scene by project-relative path. The workhorse of game flow:
   *
   *   await this.engine.loadScene("scenes/Level2.scene");
   *   await this.engine.loadScene("scenes/Hud.scene", { mode: "additive" });
   *
   * The same path works in the editor and in an exported build. See
   * sceneManager.js for load modes, progress reporting and persistence.
   */
  loadScene(ref, options) {
    return this.scenes.load(ref, options);
  }

  /**
   * Drops three's URL loader cache (see the Cache note at the top of this
   * file). Parsed models and textures are untouched; the next fetch of a URL
   * goes back to the network / HTTP cache.
   */
  clearFileCache() {
    THREE.Cache.clear();
  }

  /**
   * Compiles the current scene's render pipelines before the frames that need
   * them. Without it the presenting render skips every draw whose async
   * pipeline has not landed (asyncRenderPipelines.js), so a fresh level pops in
   * over its first frames, and anything outside the load-time frustum pays its
   * compile the first time the camera turns to it.
   *
   * Skipped when GI owns the warm-up (its compile wave builds every material
   * against the GI light it injects; warming first would build graphs that
   * wave throws away) and when a render override owns the camera (the scene
   * then renders through the postprocess PassNode's own target and MRT, so a
   * canvas-context compile builds programs that frame never uses).
   *
   * Time-bounded: resolves `"timeout"` after `timeoutMs` while the compile
   * carries on in the background, so a stuck driver cannot hold a loading
   * screen. Node builds inside three's `compileAsync` already yield between
   * objects. `__enginePrewarm = false` disables it.
   *
   * @param {{ timeoutMs?: number, reason?: string }} [options]
   * @returns {Promise<{ status: string, ms?: number }>}
   */
  async prewarmShaders({ timeoutMs = 20000, reason = "" } = {}) {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (globalThis.__enginePrewarm === false) return { status: "disabled" };
    if (!renderer?.compileAsync || !this.rendererReady || !scene || !camera) return { status: "no-renderer" };
    if (this.#giOwnsWarmup()) return { status: "gi" };
    if (this.#activeRenderOverride()) return { status: "override" };
    const t0 = performance.now();
    // three's compileAsync frustum-culls in its synchronous projection, so an
    // object outside this camera compiles nothing (GISystem's wave hit the
    // same wall). Lift the flag for exactly that synchronous part; the promise
    // covers node builds and driver compiles of render objects already listed.
    const lifted = [];
    scene.traverseVisible((object) => {
      if (object.frustumCulled === true && (object.isMesh || object.isPoints || object.isLine || object.isSprite)) {
        object.frustumCulled = false;
        lifted.push(object);
      }
    });
    const span = freeze.begin("prewarm:compileAsync");
    let compile;
    try {
      compile = renderer.compileAsync(scene, camera);
    } catch (error) {
      compile = Promise.reject(error);
    } finally {
      freeze.end(span);
      for (const object of lifted) object.frustumCulled = true;
    }
    let timer = null;
    const outcome = await Promise.race([
      compile.then(
        () => "done",
        (error) => {
          console.warn(`[engine] shader prewarm failed: ${error?.message ?? error}`);
          return "error";
        },
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const ms = performance.now() - t0;
    const label = reason ? ` (${reason})` : "";
    if (outcome === "timeout") {
      console.warn(`[engine] shader prewarm${label} still compiling after ${(ms / 1000).toFixed(1)} s — continuing without waiting`);
    } else if (outcome === "done" && ms >= 250) {
      console.log(`[engine] shader prewarm${label}: ${ms.toFixed(0)} ms`);
    }
    return { status: outcome, ms };
  }

  /** Canvas samples saved by enterSingleSampleCanvas for this frame, or null. */
  #singleSampleRestore = null;

  #exitSingleSampleCanvas() {
    if (this.#singleSampleRestore == null) return;
    if (this.renderer) this.renderer._samples = this.#singleSampleRestore;
    this.#singleSampleRestore = null;
  }

  /** An enabled GI component means GI's own compile wave warms materials. */
  #giOwnsWarmup() {
    if (!this.modules?.has?.("gi")) return false;
    for (const entity of this.entities.values()) {
      if (entity.getComponent?.("global-illumination")?.enabled) return true;
    }
    return false;
  }

  /** Removes an additively-loaded scene. */
  unloadScene(ref) {
    return this.scenes.unload(ref);
  }

  /**
   * Marks an entity as surviving `loadScene` (Unity's DontDestroyOnLoad) —
   * game managers, the audio listener, a player that carries between levels.
   */
  dontDestroyOnLoad(entity) {
    const target = typeof entity === "string" ? this.getEntity(entity) : entity;
    target?.setPersistent(true);
    return target ?? null;
  }

  destroyEntity(entity) {
    // A pooled instance can also be destroyed outright (a level unload, or
    // gameplay that just wants it gone); its bucket has to stop counting it.
    if (entity._poolGuid) this.pool.forget(entity);
    // Remove children first (bottom-up) so component teardown sees a live tree.
    for (const child of [...entity.children]) this.destroyEntity(child);
    entity.dispose();
    if (entity.parent) {
      const idx = entity.parent.children.indexOf(entity);
      if (idx !== -1) entity.parent.children.splice(idx, 1);
      entity.parent.object3D.remove(entity.object3D);
    } else {
      const idx = this.rootEntities.indexOf(entity);
      if (idx !== -1) this.rootEntities.splice(idx, 1);
      this.scene.remove(entity.object3D);
    }
    this.entities.delete(entity.id);
    this.emit("hierarchy-changed");
  }

  getEntity(id) {
    return this.entities.get(id);
  }

  /**
   * Every entity in the scene carrying the given tags. Arguments are OR'd and
   * arrays within an argument are AND'd, matching PlayCanvas:
   *
   *     engine.findByTag("enemy")                 // all enemies
   *     engine.findByTag("enemy", "hazard")       // enemy OR hazard
   *     engine.findByTag(["enemy", "flying"])     // enemy AND flying
   *
   * Iterates the flat entity map rather than walking the tree, so cost is
   * linear in scene size regardless of nesting depth.
   */
  findByTag(...query) {
    if (!query.length) return [];
    const out = [];
    for (const entity of this.entities.values()) {
      if (entity.hasTag(...query)) out.push(entity);
    }
    return out;
  }

  /** The first entity matching `findByTag`, or null. */
  findOneByTag(...query) {
    for (const entity of this.entities.values()) {
      if (entity.hasTag(...query)) return entity;
    }
    return null;
  }

  /** Every distinct tag currently in use, sorted — powers editor autocomplete. */
  allTags() {
    const tags = new Set();
    for (const entity of this.entities.values()) {
      for (const tag of entity.tags ?? []) tags.add(tag);
    }
    return [...tags].sort();
  }

  clear({ resetSettings = true } = {}) {
    this.batchHierarchy(() => {
      // Parked instances are not roots and not in `entities`, so the sweep
      // below cannot see them — without this they are the one thing `clear()`
      // leaves behind, holding their geometry and materials alive.
      this.pool.reset();
      for (const entity of [...this.rootEntities]) this.destroyEntity(entity);
    });
    // Decals are world geometry cut out of entities that no longer exist —
    // without this, level 2 opens wearing level 1's bullet holes.
    this.decals.clear();
    // `clear` destroys persistent entities too — it means "there is no scene",
    // not "load the next level" — so the manager must stop claiming one is
    // loaded, and cancel any load still in flight.
    this.scenes.reset();
    this.sceneName = "Untitled";
    // `fromSceneLoad`: clearing to defaults is a SCENE transition (project open,
    // New Scene, the reload-restore path), never a renderer edit. Without it,
    // the boot sequence seed(last scene's renderer) → build → clear(DEFAULTS)
    // → restore(scene) rebuilt the renderer on the clear — one destroyed GPU
    // device per editor reload (2026-09-15, Bistro: "antialias false→true,
    // samples 0→4" 90 ms after construction, then the scene's own options
    // refused as a deferred scene switch). The deferred path keeps the built
    // renderer; the scene that loads next matches it, so nothing rebuilds.
    if (resetSettings) this.applySettings(structuredClone(SCENE_SETTINGS_DEFAULTS), { fromSceneLoad: true });
    this.emit("hierarchy-changed");
  }

  dispose() {
    if (this._moduleDisposal) return this._moduleDisposal;
    this.stop();
    this.clear({ resetSettings: false });
    this.rendererReady = false;
    // Bump the rebuild token so any in-flight #rebuildRenderer awaiting
    // init() notices its renderer is gone and bails before it tries to
    // configure the (now-null) renderer.
    ++this._rendererRebuildSeq;
    this._rendererRebuildInFlight = null;
    this._moduleDisposal = disposeEngineModules(this, () => {
      this._inputTickUnsub?.();
      this._inputTickUnsub = null;
      this.input.detach();
      this.audio.dispose?.();
      this.stats.dispose();
      this.time.clear();
      this.batching.dispose();
      this.merging.dispose();
      this.shadowMerge.dispose();
      this.lod.dispose();
      this.impostors.dispose();
      this.occlusion.dispose();
      this.decals.dispose();
      this.pool.dispose();
      this.paths.dispose();
      this.renderOverrides.clear();
      this.renderer?.dispose();
      this.renderer = null;
    });
    this._moduleDisposal.catch(error => console.warn("Module disposal failed", error));
    return this._moduleDisposal;
  }
}
