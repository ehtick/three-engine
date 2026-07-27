import * as THREE from "three/webgpu";
import { EventEmitter } from "./EventEmitter.js";
import { Entity } from "./Entity.js";
import {
  SCENE_SETTINGS_DEFAULTS,
  mergeSettings,
  applySettingsToScene,
  rendererConstructorOptions,
  rendererNeedsRebuild,
} from "./sceneSettings.js";
import { InputManager } from "./input/index.js";
import { createDefaultMaps } from "./input/defaultMaps.js";
import { ViewFrustum } from "./viewFrustum.js";
import { AudioSystem } from "./audio/AudioSystem.js";
import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { StatsSystem } from "./StatsSystem.js";
import { configureTextureAssetLoader } from "./textureAsset.js";
import { installOutputDither } from "./outputDither.js";
import { BatchSystem } from "./batching.js";

/**
 * Runtime core: owns the renderer, the three.js scene (source of truth)
 * and the entity tree. No React, no editor state — a built game ships this.
 */
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
    this.sceneName = "Untitled";
    this.playing = false;
    this.rendererReady = false;
    // True between start() and stop(); used by the renderer-rebuild path so
    // the animation loop re-attaches to a freshly-recreated renderer.
    this.loopActive = false;
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
    // Merges repeated (geometry, material) pairs into instanced draw calls.
    // Driven from #tick's pre-render phase, gated by settings.performance.
    this.batching = new BatchSystem(this);
    // Built-in per-frame telemetry sampler. Lives on the engine — every
    // engine has one, no module registry involved. The editor's viewport
    // overlay reads `engine.stats.readout`; built games can ignore it.
    this.stats = new StatsSystem(this);
    this.stats.start();

    // Host-tunable runtime behavior (the editor writes project settings here).
    this.config = { scriptHotReload: true, scriptReloadIntervalMs: 750 };

    // Audio runtime: shared AudioContext + listener + sound registry. Lazily
    // materialises the context once the first SoundComponent attaches or
    // engine.start() fires — browsers require a user gesture otherwise.
    this.audio = new AudioSystem(this);

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

    // Set to true by `emit("hierarchy-changed")` while a coalescing microtask
    // is pending. See the `emit` override below.
    this._hierarchyDirty = false;
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
  emit(event, ...args) {
    if (event !== "hierarchy-changed") {
      super.emit(event, ...args);
      return;
    }
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
    super.emit("hierarchy-changed");
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
  async applySettings(patch) {
    const before = this.settings;
    this.settings = mergeSettings(before, patch ?? {});
    // Renderer-construction options (antialias / samples / transparent) are
    // frozen at WebGPURenderer creation time. If any of them just changed,
    // tear the renderer down and rebuild it on the same canvas. The new
    // renderer then gets the rest of the settings via applySettingsToScene.
    let recreatedRenderer = false;
    if (
      this.renderer &&
      rendererNeedsRebuild(before.renderer, this.settings.renderer)
    ) {
      const canvas = this.renderer.domElement;
      // Wait for any in-flight rebuild before tearing down the renderer it
      // created — otherwise we'd dispose() a renderer that's mid-init() and
      // race its post-init wiring (configureTextureAssetLoader, etc.)
      // against this rebuild's post-init wiring. Awaiting also serializes
      // back-to-back applySettings() calls (e.g. play→stop triggers
      // clear()→applySettings(DEFAULTS) then applySettings(snapshot) in one
      // tick) so they don't fight over `this.renderer`.
      if (this._rendererRebuildInFlight) {
        try {
          await this._rendererRebuildInFlight;
        } catch {
          // The in-flight rebuild already logged its own failure; swallow so
          // this rebuild can still proceed.
        }
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
      recreatedRenderer = true;
    }
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    // A manual render-scale change resizes the canvas backing store. Only
    // re-apply when the value actually moved — renderer.setSize reallocates
    // the swap chain, which we don't want on every unrelated settings drag.
    const prevScale = before.performance?.renderScale ?? 1;
    const nextScale = this.settings.performance?.renderScale ?? 1;
    const prevDpr = before.performance?.maxDevicePixelRatio ?? 2;
    const nextDpr = this.settings.performance?.maxDevicePixelRatio ?? 2;
    if (!recreatedRenderer && (prevScale !== nextScale || prevDpr !== nextDpr)) {
      this.#scheduleRendererResize();
    }
    this.batching.setEnabled(this.settings.performance?.autoBatching !== false);
    this.emit("settings-changed", this.settings);
    return recreatedRenderer;
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

  async #rebuildRenderer(canvas) {
    // Capture the token + publish the in-flight promise so a newer
    // applySettings() can await this one before tearing the renderer down.
    const token = ++this._rendererRebuildSeq;
    const work = (async () => {
      try {
        const opts = rendererConstructorOptions(this.settings);
        this.renderer = new THREE.WebGPURenderer({ canvas, ...opts });
        this.#applyRendererSize();
        await this.renderer.init();
        // Another rebuild started while we were awaiting init(). It owns
        // `this.renderer` now and will run its own post-init wiring — skip
        // ours so we don't run configureTextureAssetLoader / start the
        // animation loop against a renderer that isn't ours yet.
        if (token !== this._rendererRebuildSeq) return;
        configureTextureAssetLoader(this.renderer);
    // Sub-LSB dither on the output transform — without it every smooth GI
    // gradient bands into hard-edged contour rings on the 8-bit canvas.
    installOutputDither(this.renderer);
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
        if (this.loopActive) this.renderer.setAnimationLoop(() => this.#tick());
      } catch (err) {
        console.error("Renderer rebuild failed:", err);
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

  /** Toggles game-logic execution (ScriptComponent onStart/onUpdate/onDestroy). */
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) this.input.reset();
    this.emit("play-changed", playing);
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
    this._inputTickUnsub = this.onUpdate((dt) => next.tick(dt));
    this.input = next;
    this.emit("input-changed", next);
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
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      ...rendererConstructorOptions(this.settings),
    });
    this.#applyRendererSize();
    await this.renderer.init();
    configureTextureAssetLoader(this.renderer);
    // Sub-LSB dither on the output transform — without it every smooth GI
    // gradient bands into hard-edged contour rings on the 8-bit canvas.
    installOutputDither(this.renderer);
    // Renderer-side settings (tone mapping, shadows) couldn't apply earlier.
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    this.rendererReady = true;
    // Wire input once the canvas exists (the manager listens on it directly).
    if (!this.input.attached) {
      this.input.attach(canvas);
      this._inputTickUnsub = this.onUpdate((dt) => this.input.tick(dt));
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
    // Best-effort: kick the AudioContext on play start so audio is ready
    // by the first tick. If a user gesture is required and absent, the
    // context's `state === "suspended"` status will hold; the system
    // installs a one-shot pointer listener to resume it.
    this.audio.ensureContext?.().then(() => this.audio.resumeIfNeeded?.());
  }

  stop() {
    this.loopActive = false;
    this.renderer.setAnimationLoop(null);
  }

  #tick() {
    this.timer.update();
    const dt = this.timer.getDelta();
    // Refresh the shared frustum before update callbacks run so per-entity
    // culling decisions see the current frame. The frustum internally
    // no-ops when the camera hasn't moved, so this is one cheap
    // matrix-multiply hash check on a static-camera frame.
    this.viewFrustum.refresh(this.camera);
    // Update `_inView` on every view-only component: one sphere/plane test
    // each. The registry is maintained incrementally as components opt in and
    // out (see Component._viewOnlyActive), so this costs nothing on a scene
    // that uses no frustum gating — where the previous nested walk over every
    // entity and every component still ran in full, every frame.
    if (this.viewFrustum.isReady()) {
      for (const c of this.viewOnlyComponents) c.updateViewVisibility(this.viewFrustum);
    }
    // Resolve per-mode visibility onto every entity's Object3D. We write
    // only when the desired value differs from the current one so a stable
    // scene doesn't churn the matrix tree each frame. (Setting `.visible`
    // back to the same value is technically a no-op in three.js — but
    // avoiding the property assignment entirely keeps the code path
    // side-effect free and easier to reason about.)
    const modeFlag = this.playing ? "enabledInGame" : "enabledInEditor";
    for (const entity of this.entities.values()) {
      const next = entity[modeFlag] !== false;
      if (entity.object3D.visible !== next) entity.object3D.visible = next;
    }
    for (const fn of this.updateCallbacks) fn(dt);
    // Audio updates go after the script tick so per-frame transforms are
    // up to date (sound positions + listener pose).
    this.audio.update?.(dt);
    // rendererReady guards the re-init window (init() swaps the renderer
    // asynchronously; rendering before its backend resolves throws).
    if (this.camera && this.rendererReady) {
      // A renderer resize temporarily stops the animation loop and drains
      // submitted GPU work. If it was requested from inside an update
      // callback, do not encode another frame after the drain was scheduled.
      if (this._resizeInFlight) return;
      // Systems may briefly suspend scene rendering while an async pipeline
      // compile wave fills the cache (GI rebuilds): the viewport holds its
      // last frame but the app stays interactive, instead of the render
      // call blocking the main thread for the whole wave.
      if (this.renderSuspended) return;
      // Final-transform passes (e.g. GI deferred prepass) run here: after
      // physics/scripts have written this frame's transforms, before the
      // main draw that samples their output.
      // Refresh instanced batches before any pre-render pass reads the
      // scene, so a GI/postprocess prepass and the main draw agree on what
      // is on screen.
      this.batching.sync();
      for (const fn of this.preRenderCallbacks) fn();
      // Re-check: a preRender callback (GI rebuild) may have suspended
      // rendering THIS frame — rendering now would sync-compile the whole
      // material wave in this frame, the exact freeze suspension prevents.
      if (this.renderSuspended) return;
      // Wall-clock the GPU-submit portion of the frame so the stats
      // overlay's "GPU" reading reflects only the render call, not the
      // script tick. WebGPU dispatches the actual GPU work asynchronously,
      // so this is command-encoding time, not hardware GPU time — but it's
      // the closest portable signal without WebGPU timestamp-query support.
      const t0 = performance.now();
      const override = this.#activeRenderOverride();
      if (override) {
        // The override (typically a PostprocessComponent) runs the scene
        // render to its own offscreen target and the post-graph blit to
        // the canvas — via three's RenderPipeline + PassNode, which
        // handles all render-target bookkeeping internally. Skipping
        // the default renderer.render() avoids a redundant scene draw
        // (and the WebGPU validation errors that follow from manual
        // setRenderTarget calls).
        override.render(this);
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      this.stats.recordRenderMs(performance.now() - t0);
      // Snapshot three's per-frame renderer metrics (draw calls, triangles,
      // texture memory). Has to happen AFTER render() returns because
      // three's animation loop resets these counters at the start of each
      // frame, before user code runs. See StatsSystem header for the
      // timing rationale.
      this.stats.recordRenderInfo();
      this.#resolveGpuTimestamps();
      this.#updateDynamicResolution();
    }
    // Post-render passes draw on top of the main render's pixels. The
    // WebGPU backend's render pass starts with `loadOp: Clear`, so any
    // post-render `renderer.render(...)` would wipe the canvas — callers
    // must temporarily disable `autoClear` (and re-enable it) to preserve
    // the main scene underneath.
    for (const fn of this.postRenderCallbacks) fn();
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
  #resolveGpuTimestamps() {
    const renderer = this.renderer;
    if (!renderer?.backend?.trackTimestamp || this._gpuTimestampInFlight) return;
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
        if (duration > 0) this.stats.recordGpuMs(duration);
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
    const budgetMs = 1000 / (perf.targetFps > 0 ? perf.targetFps : 60);
    const r = this.stats.readout;
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
    this.updateCallbacks.add(fn);
    return () => this.updateCallbacks.delete(fn);
  }

  /**
   * Register a callback that fires after all update callbacks but before the
   * main render each frame. Use for passes that must see the frame's final
   * transforms yet produce output the main render consumes (e.g. the GI
   * deferred prepass). Returns an unsubscribe function.
   */
  onPreRender(fn) {
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
    const entity = instantiatePrefabNode(this, { prefab: { guid, path: prefabRegistry.pathOf(guid) } }, parent);
    if (position) entity.position = position;
    if (rotation) entity.rotation = rotation;
    if (scale) entity.scale = scale;
    if (name) entity.name = name;
    return entity;
  }

  destroyEntity(entity) {
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
      for (const entity of [...this.rootEntities]) this.destroyEntity(entity);
    });
    this.sceneName = "Untitled";
    if (resetSettings) this.applySettings(structuredClone(SCENE_SETTINGS_DEFAULTS));
    this.emit("hierarchy-changed");
  }

  dispose() {
    this.stop();
    this.clear({ resetSettings: false });
    this._inputTickUnsub?.();
    this._inputTickUnsub = null;
    this.input.detach();
    this.audio.dispose?.();
    this.stats.dispose();
    this.batching.dispose();
    this.renderOverrides.clear();
    this.rendererReady = false;
    // Bump the rebuild token so any in-flight #rebuildRenderer awaiting
    // init() notices its renderer is gone and bails before it tries to
    // configure the (now-null) renderer.
    ++this._rendererRebuildSeq;
    this._rendererRebuildInFlight = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
