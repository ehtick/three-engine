import * as THREE from "three/webgpu";
import { getLoadedCubemap, loadCubemapAsset } from "./cubemapAsset.js";

/**
 * Per-scene environment/rendering settings, serialized inside the scene JSON
 * (PlayCanvas-style). Applied by `Engine.applySettings`; missing keys fall
 * back to these defaults, so old scenes load unchanged.
 */
export const SCENE_SETTINGS_DEFAULTS = {
  background: "#202329",
  ambientColor: "#ffffff",
  ambientIntensity: 0.3,
  // Scene-wide image-based environment. `cubemap` points at a `.cubemap`
  // asset (six face images); it drives the skybox and/or the IBL that lights
  // every material. Empty = flat `background` color, as before.
  environment: {
    cubemap: "",
    background: true, // draw it as the skybox
    lighting: true, // use it as scene.environment (image-based lighting)
    intensity: 1,
    rotation: 0, // degrees around Y
    blur: 0, // background-only blurriness (0…1)
  },
  fog: {
    type: "none", // "none" | "linear" | "exp2"
    color: "#202329",
    near: 10,
    far: 80,
    density: 0.02,
  },
  toneMapping: "neutral", // "none" | "linear" | "reinhard" | "cineon" | "aces" | "agx" | "neutral"
  exposure: 1,
  shadows: true,
  // Renderer-construction options. Changing any of these requires the
  // renderer to be torn down and re-created (WebGPURenderer freezes its
  // MSAA state at init time). Engine.applySettings handles that.
  renderer: {
    antialias: true,
    samples: 4, // MSAA samples (1, 2, 4, 8, ...). Ignored when antialias=false.
    transparent: false, // alpha channel on the canvas (see-through vs opaque)
  },
  // Shadow caster configuration. These are global defaults applied to the
  // renderer's shadow map — per-light overrides live on each LightComponent.
  shadow: {
    type: "PCFSoftShadowMap", // "BasicShadowMap" | "PCFShadowMap" | "PCFSoftShadowMap" | "VSMShadowMap"
    autoUpdate: true, // re-render shadow maps every frame
    needsUpdate: false, // one-shot re-render on the next frame
  },
  // Performance tuning. None of these require a renderer rebuild — they are
  // applied live (render scale via setPixelRatio, volume quality via the
  // shared runtimeQuality object the volumetric lighting model reads).
  performance: {
    // Per-scene ceiling applied after the project-wide DPR cap. Useful for
    // keeping especially expensive scenes at 1x on high-density displays.
    maxDevicePixelRatio: 2, // 0.5 … 4
    // Manual resolution multiplier on the whole frame (canvas backing store).
    // 0.5 = quarter the pixels = roughly 2–4× GPU headroom on fill-bound
    // scenes (SSGI/SSR/volumes are all fill-bound). CSS upscales the canvas.
    renderScale: 1, // 0.25 … 1
    // Auto-adjusts an internal multiplier (on top of renderScale) between
    // 0.5 and 1 to hold targetFps, driven by the measured GPU frame time.
    dynamicResolution: false,
    targetFps: 60, // 30 | 60 | 90 | 120
    // Multiplies every volumetric material's raymarch step count. 0.5 halves
    // the per-pixel loop iterations of all volumes (biggest volume cost).
    volumeStepScale: 1, // 0.1 … 1
    // Merges meshes that share a geometry AND a material into one instanced
    // draw call each (see engine/batching.js). The win scales with how
    // repetitive a scene is — an imported model dropped in a thousand times
    // goes from a thousand draw calls to one. Off only makes sense when
    // debugging a suspected batching artifact.
    autoBatching: true,
  },
};

/**
 * Live quality knobs read by hot shader-update callbacks (e.g. the
 * volumetric lighting model's per-frame step-count uniform). A mutable
 * module-level object — NOT serialized — so shader `onRenderUpdate`
 * closures can read the current value without threading the engine
 * through the TSL build. `applySettingsToScene` copies the scene's
 * `performance` values in here.
 */
export const runtimeQuality = {
  volumeStepScale: 1,
};

export const TONE_MAPPINGS = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

export const SHADOW_TYPES = {
  BasicShadowMap: THREE.BasicShadowMap,
  PCFShadowMap: THREE.PCFShadowMap,
  PCFSoftShadowMap: THREE.PCFSoftShadowMap,
  VSMShadowMap: THREE.VSMShadowMap,
};

// MSAA sample counts worth offering. 0 = "off" (handled by antialias=false).
export const MSAA_SAMPLES = [1, 2, 4, 8, 16];

/**
 * Renderer-construction options are those that WebGPU/WebGL fix at creation
 * time. Toggling any of them means we have to throw the renderer away and
 * re-init it. Engine.applySettings compares the new vs current values and
 * triggers a re-init when this set changes.
 */
export const RENDERER_REBUILD_KEYS = ["antialias", "samples", "transparent"];

/** True iff two renderer sub-objects differ on any rebuild key. */
export function rendererNeedsRebuild(a, b) {
  const aa = a ?? {};
  const bb = b ?? {};
  return RENDERER_REBUILD_KEYS.some((k) => (aa[k] ?? null) !== (bb[k] ?? null));
}

/** Deep-merges a settings patch over current values (nested objects merged per-key). */
export function mergeSettings(current, patch) {
  const next = {
    ...current,
    ...patch,
    environment: {
      ...SCENE_SETTINGS_DEFAULTS.environment,
      ...(current.environment ?? {}),
      ...(patch?.environment ?? {}),
    },
    fog: { ...current.fog, ...(patch?.fog ?? {}) },
    renderer: { ...current.renderer, ...(patch?.renderer ?? {}) },
    shadow: { ...current.shadow, ...(patch?.shadow ?? {}) },
    performance: {
      ...SCENE_SETTINGS_DEFAULTS.performance,
      ...(current.performance ?? {}),
      ...(patch?.performance ?? {}),
    },
  };
  return next;
}

/**
 * Settings whose effect requires recreating the WebGPU renderer (their values
 * are frozen at constructor time). Returned as a flat `{ antialias, samples,
 * transparent }` object ready for `new WebGPURenderer(opts)`.
 *
 * `asyncCompilation: true` is on by default — three r185+ ships an
 * AsyncCompilation driver that builds WGSL pipelines off the render thread.
 * Without it, the first frame blocks on every new material's shader compile,
 * which is the difference between "loads in ~200ms" and "tab unresponsive
 * for 10+ seconds" when a scene with many materials enters the view. The
 * trade-off is a brief pop-in for materials that haven't compiled yet
 * (they draw as black until ready) — acceptable for the boot speedup.
 */
export function rendererConstructorOptions(settings) {
  const r = settings.renderer ?? SCENE_SETTINGS_DEFAULTS.renderer;
  return {
    antialias: r.antialias !== false,
    samples: r.antialias === false ? 0 : (r.samples ?? 4),
    alpha: r.transparent !== false,
    asyncCompilation: r.asyncCompilation !== false,
    // Enables WebGPU timestamp queries so the engine can read real GPU
    // frame time (renderer.info.render.timestamp) instead of guessing from
    // CPU-side submit time. The backend degrades gracefully when the
    // adapter lacks the "timestamp-query" feature (WebGPUBackend.js:294),
    // so this is safe to request unconditionally. Overhead is negligible
    // (two GPU timestamps + one tiny resolve buffer per pass).
    trackTimestamp: true,
  };
}

/** True for a texture this module put on the scene (vs. one a component owns). */
const isSceneEnvTexture = (value) => value?.isTexture === true && value.userData?.sceneEnvironment === true;
/** A texture some *other* owner (e.g. the HDRI EnvironmentComponent) installed. */
const isForeignTexture = (value) => value?.isTexture === true && !isSceneEnvTexture(value);

// Bumped on every environment apply so a slow cube-map decode that lands after
// the user has already picked a different skybox (or cleared it) is discarded
// instead of overwriting the newer choice.
let environmentSeq = 0;

/** Flat background color + no scene-owned IBL. Leaves component-owned textures
 *  (the HDRI EnvironmentComponent) alone — those have their own lifecycle. */
function clearSceneEnvironment(settings, scene) {
  if (isSceneEnvTexture(scene.environment)) scene.environment = null;
  if (!isForeignTexture(scene.background)) {
    scene.background = new THREE.Color(settings.background);
    scene.backgroundBlurriness = 0;
  }
}

function pushSceneEnvironment(settings, scene, texture, env) {
  texture.userData.sceneEnvironment = true;
  const rad = THREE.MathUtils.degToRad(env.rotation ?? 0);
  const intensity = env.intensity ?? 1;
  if (env.lighting !== false) {
    scene.environment = texture;
    scene.environmentIntensity = intensity;
    scene.environmentRotation.set(0, rad, 0);
  } else if (isSceneEnvTexture(scene.environment)) {
    scene.environment = null;
  }
  if (env.background !== false) {
    scene.background = texture;
    scene.backgroundIntensity = intensity;
    scene.backgroundBlurriness = env.blur ?? 0;
    scene.backgroundRotation.set(0, rad, 0);
  } else if (!isForeignTexture(scene.background)) {
    scene.background = new THREE.Color(settings.background);
    scene.backgroundBlurriness = 0;
  }
}

/**
 * Background + image-based lighting. Decoding a cube map is async, but this
 * runs on *every* settings change (dragging a quality slider re-applies
 * everything), so a cached texture is installed synchronously — otherwise the
 * sky would flash back to the clear color on each unrelated edit.
 */
function applySceneEnvironment(settings, scene) {
  const env = { ...SCENE_SETTINGS_DEFAULTS.environment, ...(settings.environment ?? {}) };
  const seq = ++environmentSeq;
  const path = env.cubemap;
  const cached = path ? getLoadedCubemap(path) : null;
  if (cached) {
    pushSceneEnvironment(settings, scene, cached, env);
    return;
  }
  clearSceneEnvironment(settings, scene);
  if (!path) return;
  loadCubemapAsset(path).then((texture) => {
    // A newer apply already decided what the environment should be.
    if (seq !== environmentSeq || !texture) return;
    pushSceneEnvironment(settings, scene, texture, env);
  });
}

/** Pushes settings onto a scene + renderer. Renderer may be null (pre-init). */
export function applySettingsToScene(settings, scene, ambientLight, renderer) {
  applySceneEnvironment(settings, scene);

  // Live quality knobs — copied into the mutable runtimeQuality object that
  // shader onRenderUpdate closures read every frame (see volumetricLightingModel).
  const perf = settings.performance ?? SCENE_SETTINGS_DEFAULTS.performance;
  runtimeQuality.volumeStepScale = clamp01Range(perf.volumeStepScale ?? 1, 0.1, 1);

  ambientLight.color.set(settings.ambientColor);
  ambientLight.intensity = settings.ambientIntensity;

  const fog = settings.fog ?? SCENE_SETTINGS_DEFAULTS.fog;
  if (fog.type === "linear") {
    scene.fog = new THREE.Fog(new THREE.Color(fog.color), fog.near, fog.far);
  } else if (fog.type === "exp2") {
    scene.fog = new THREE.FogExp2(new THREE.Color(fog.color), fog.density);
  } else {
    scene.fog = null;
  }

  if (renderer) {
    renderer.toneMapping = TONE_MAPPINGS[settings.toneMapping] ?? THREE.NeutralToneMapping;
    renderer.toneMappingExposure = settings.exposure ?? 1;
    // Shadows: master switch + per-renderer type/autoUpdate. The map type is
    // expensive (it reallocates internal target textures when changed), but
    // `setMapType` handles that without re-creating the renderer.
    const shadowOn = settings.shadows !== false;
    renderer.shadowMap.enabled = shadowOn;
    const shadow = settings.shadow ?? SCENE_SETTINGS_DEFAULTS.shadow;
    renderer.shadowMap.type = SHADOW_TYPES[shadow.type] ?? THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = shadow.autoUpdate !== false;
    renderer.shadowMap.needsUpdate = shadow.needsUpdate === true;
  }
}

function clamp01Range(v, min, max) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : max;
}
