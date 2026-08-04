import * as THREE from "three/webgpu";
import { EventEmitter } from "./EventEmitter.js";
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
import { StatsSystem } from "./StatsSystem.js";
import { SaveSystem, PreferenceStore } from "./saveSystem.js";
import { Tween, TweenSystem } from "./tween.js";
import { configureTextureAssetLoader } from "./textureAsset.js";
import { installOutputDither } from "./outputDither.js";
import { BatchSystem } from "./batching.js";
import { LodSystem } from "./lod/LodSystem.js";
import { ImpostorSystem } from "./lod/ImpostorSystem.js";
import { OcclusionSystem } from "./culling/OcclusionSystem.js";
import { SceneManager } from "./sceneManager.js";
import { PoolSystem } from "./pool.js";
import { PathSystem } from "./spline/PathSystem.js";
import { ImpulseSystem } from "./camera/impulse.js";
import { DebugDraw } from "./debugDraw.js";
import { DecalSystem } from "./vfx/DecalSystem.js";

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
    // Camera shake. Owned here so it survives whichever camera happens to be
    // active: an explosion's rumble must not stop because the shot cut.
    this.cameraImpulse = new ImpulseSystem();
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
    this.config = { scriptHotReload: true, scriptReloadIntervalMs: 750, saveVersion: 1, quality: null };

    // Save slots (a playthrough) and preferences (settings, cross-run flags).
    // Deliberately separate: deleting every save must not reset the volume.
    // See saveSystem.js — scripts opt in via `onSave`/`onLoad`.
    // Property tweening on game time (see tween.js). `engine.tween(...)` is
    // the shorthand scripts use.
    this.tweens = new TweenSystem();

    this.saves = new SaveSystem(this);
    this.prefs = new PreferenceStore(this);
    this.prefs.hydrate();

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
    this.occlusion.setEnabled(this.settings.performance?.occlusionCulling === true);

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
    this.occlusion.setEnabled(this.settings.performance?.occlusionCulling === true);
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
        // Adapter-clamped limit bump — see resolveRendererLimits. Awaited
        // BEFORE construction because `requiredLimits` is a constructor
        // parameter three forwards straight to requestDevice.
        const limits = await resolveRendererLimits();
        this.renderer = new THREE.WebGPURenderer({ canvas, ...opts, ...limits });
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
      ...(await resolveRendererLimits()),
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

  #tick() {
    const frameStarted = performance.now();
    if (this.frameRateLimit > 0) {
      const interval = 1000 / this.frameRateLimit;
      // A small tolerance avoids a nominal 30 fps cap becoming 20 fps because
      // two 16.6 ms RAF intervals land just below 33.333 due to timer jitter.
      if (frameStarted - this._lastFrameStart + 0.75 < interval) return;
      this._lastFrameStart = frameStarted;
    }
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
    // Ahead of the resolve below, and after the frustum refresh above, because
    // it decides which LOD level each group wants and the resolve is the single
    // place that writes `visible`. An LOD group setting `object3D.visible`
    // itself would simply be overwritten a few lines later, every frame.
    this.lod.update();
    // After the LOD pass, because an entity the LOD system already hid is not
    // worth an occlusion test, and before the resolve for the same reason the
    // LOD pass is: `_occluded` is a veto the resolve reads, not a write to
    // `visible`. The buffer it tests against was captured a frame or two ago
    // (see OcclusionSystem) — this is where that latency lands.
    this.occlusion.apply();
    const modeFlag = this.playing ? "enabledInGame" : "enabledInEditor";
    for (const entity of this.entities.values()) {
      // `_lodHidden` and `_occluded` are vetoes, not overrides: a level the
      // author disabled stays hidden even when the camera asks for it, and
      // nothing either system does can make a disabled entity draw.
      const authored = entity[modeFlag] !== false;
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
    for (const fn of this.updateCallbacks) fn(dt);
    // Snapshot: a late callback that unsubscribes itself (an IK component
    // detaching on the frame its target is destroyed) would otherwise mutate
    // the array being iterated.
    if (this.lateUpdateCallbacks.length) {
      for (const entry of [...this.lateUpdateCallbacks]) entry.fn(dt);
    }
    // Audio updates go after the script tick so per-frame transforms are
    // up to date (sound positions + listener pose). Deliberately UNSCALED:
    // this is bookkeeping (listener pose, fades), not simulation, and a
    // pause menu's music should not stop ramping because the game froze.
    this.audio.update?.(unscaled);
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
      // Impostor bakes are nested renders, so they belong here — after the
      // scene's transforms are final and before the main draw. At most one
      // atlas is baked per frame; the rest of this call just refreshes the
      // instance buffers.
      this.impostors.update();
      // The occluder depth pass reads the same finished transforms the main
      // draw is about to. It renders and starts an async readback; the result
      // is applied at the top of a later tick, which is what keeps this off the
      // critical path.
      this.occlusion.render();
      for (const fn of this.preRenderCallbacks) fn();
      // After the preRender callbacks, so the editor's own gizmo pass — which
      // runs there and may itself draw through `engine.debug` — is included in
      // this frame's upload rather than the next one's.
      this.debug.flush();
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
   * Register a callback that fires after every `onUpdate` callback, in
   * ascending `order`. This is the pose pipeline's stage list — the animator
   * runs in `onUpdate`, then IK solvers (order 0), then bone-attachment sync
   * (order 100). Returns an unsubscribe function.
   *
   * Ties keep insertion order, so equal-order callbacks behave like `onUpdate`.
   */
  onLateUpdate(fn, order = 0) {
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
    this.lod.dispose();
    this.impostors.dispose();
    this.occlusion.dispose();
    this.decals.dispose();
    this.pool.dispose();
    this.paths.dispose();
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
