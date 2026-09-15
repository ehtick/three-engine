import * as THREE from "three/webgpu";
import { getLoadedEnvironment, loadEnvironmentAsset } from "./environmentAsset.js";
import { collectFreezableCasters } from "./shadowFreeze.js";
import { applyOutputTransform } from "./outputTransform.js";

/**
 * Per-scene environment/rendering settings, serialized inside the scene JSON
 * (PlayCanvas-style). Applied by `Engine.applySettings`; missing keys fall
 * back to these defaults, so old scenes load unchanged.
 */
export const SCENE_SETTINGS_DEFAULTS = {
  background: "#202329",
  ambientColor: "#ffffff",
  ambientIntensity: 0.3,
  // Scene-wide image-based environment — THE scene's sky. It drives the skybox
  // and/or the IBL that lights every material. Empty = flat `background` color,
  // and — while `lighting` stays on — that colour is also the sky GI lights
  // with (see giConfig's sceneSkyRadiance): "Use for lighting" governs both.
  //
  // `cubemap` accepts either a `.cubemap` asset (six face images) or an
  // equirectangular `.hdr`/`.exr` panorama — the shape Poly Haven and every
  // other HDRI library ships. The key kept its original name because every
  // scene on disk writes it; read it as "the environment asset", and see
  // engine/environmentAsset.js for why the two shapes share one slot.
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
  // ⭐ THE SCENE'S WIND, and there is one of it. Cloth reads this unless a
  // cloth opts out with `windSource: "custom"` — see vfx/clothWind.js for why
  // one shared field is what makes neighbouring curtains look like they are in
  // the same weather without moving in lockstep.
  wind: {
    vector: [0, 0, 2],   // m/s², the same units and default as the cloth solver
    gust: 0,             // gust strength on top of the steady wind
    gustFrequency: 1,    // Hz
  },
  toneMapping: "neutral", // "none" | "linear" | "reinhard" | "cineon" | "aces" | "agx" | "neutral"
  exposure: 1,
  shadows: true,
  // Renderer-construction options. Changing any of these requires the
  // renderer to be torn down and re-created (WebGPURenderer freezes its
  // MSAA state at init time). Engine.applySettings handles that.
  renderer: {
    antialias: true,
    samples: 4, // MSAA samples: 1 or 4 (WebGPU's only portable counts). Ignored when antialias=false.
    transparent: false, // alpha channel on the canvas (see-through vs opaque)
    // Reversed depth buffer: far-range precision for km-scale scenes (distant
    // z-fighting). Opt-in; see engine/reversedDepth.js for what the engine
    // patches on top of three's own support.
    reversedDepth: false,
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
    // ⭐ THE FRAME-RATE FLOOR (§18 W3). Scales the GI module's traced-pixel
    // budget — the one term that owns most of the GPU frame — so the measured
    // GPU time tracks `targetFps`. See frameGovernor.js for the loop.
    //
    // WHY THIS AND NOT `dynamicResolution`: DRS scales the CANVAS, and GI
    // deliberately divides DRS back out of its own sizing (see GISystem's
    // `#screenResolveSize` — letting DRS resize GI made the loop hunt itself,
    // because GI *is* the cost DRS was reacting to). On Bistro/ultra the raster
    // DRS can reach is ~5 ms of a 46 ms GPU frame, so DRS alone can never hold
    // 60 here. MEASURED, same camera, same frame: renderScale 1 → 45.7 ms GPU;
    // renderScale 0.5 (a quarter of the pixels) → 12.1 ms.
    //
    // ⛔⛔ OFF BY DEFAULT (2026-08-25, reversed the same day it shipped ON).
    // It shipped default-true on the argument "a floor nobody enables is not a
    // floor", and one day in the field refuted that argument twice at once. On
    // the user's GPU-bound Level scene (CPU 12.5 ms, GPU 16.6 ms) it walked to
    // the BOTTOM rung and sat there: the resolve at 0.19× read as mud across
    // every wall with a ghost trail on the character — while the frame STILL
    // ran 40 fps, because GI's fixed GPU floor (probe pools, prepass, raster)
    // does not scale with the traced-pixel budget this controls. All quality
    // spent, floor still missed: the project's own rule calls that two
    // regressions, not a trade. And every rung change re-mints the GI field —
    // a visible reset reported as "gi keeps reloading".
    //
    // It stays available for scenes where the ladder genuinely spans the gap.
    // ⚠ DO NOT DEFAULT IT ON AGAIN until (1) a rung change no longer re-mints
    // the field (resize the screen targets without touching the volume state),
    // and (2) the controller refuses to spend rungs that measurably cannot
    // reach the target (project the reachable floor from the fixed terms
    // before stepping).
    adaptiveQuality: false,
    // Multiplies every volumetric material's raymarch step count. 0.5 halves
    // the per-pixel loop iterations of all volumes (biggest volume cost).
    volumeStepScale: 1, // 0.1 … 1
    // Merges meshes that share a geometry AND a material into one instanced
    // draw call each (see engine/batching.js). The win scales with how
    // repetitive a scene is — an imported model dropped in a thousand times
    // goes from a thousand draw calls to one. Off only makes sense when
    // debugging a suspected batching artifact.
    autoBatching: true,
    // Merges meshes with DIFFERENT geometry and DIFFERENT materials into one
    // draw, by concatenating their vertex buffers and shading them through a
    // table-driven "uber" material (see engine/merging.js). This is the case
    // autoBatching cannot reach: an imported environment repeats nothing, so
    // instancing finds no groups, and every material is still its own draw in
    // every pass — colour, depth prepass and shadow map alike.
    //
    // OFF by default, for one specific reason worth knowing before turning it
    // on: the GI module reads `material.map` on the CPU to build its albedo
    // atlas, and an uber material's colour lives in a texture array the CPU
    // cannot index. A merged surface therefore contributes its group's average
    // tint to GI's BVH reflection albedo rather than its own texture. Direct
    // lighting, shadows and the voxel field are unaffected.
    staticMerging: false,
    // Collapses the SHADOW passes' casters into depth-only proxies
    // (shadowMerge.js). Independent of `staticMerging` because it answers a
    // different question: three swaps in one depth override for every material,
    // so a shadow merge keys on almost nothing and reaches a far lower draw
    // floor than the colour merge can. On Bistro the two CSM cascades were 842
    // of 1144 draws with a measured `floorIfMerged` of 8 and 6.
    //
    // OFF by default while it is being proven: it rewrites `castShadow` across
    // the scene, so a defect shows up as MISSING SHADOWS rather than a slow
    // frame, and that is the more expensive failure to diagnose.
    shadowMerging: false,
    // Records the static merge proxies into a WebGPU RENDER BUNDLE, so their
    // draws are replayed by the GPU instead of re-encoded from JavaScript every
    // frame (three's `BundleGroup`).
    //
    // This is the only lever here that attacks the COST PER DRAW rather than
    // the draw count. three submits every draw from JS, and on Bistro that is
    // ~35-45 µs each whatever the triangle count — the frame is CPU-bound on
    // submission, not on geometry. When a bundle is clean the renderer skips
    // the scene walk, the per-object frustum test and the render-list build for
    // everything inside it, then replays the whole recorded pass with one call.
    //
    // OFF by default while it is being proven, and the failure mode is why: a
    // bundle is a RECORDING, so anything that changes without bumping
    // `needsUpdate` keeps drawing the old thing. Proxies are a good first
    // subject precisely because they are already rebuilt-not-mutated.
    renderBundles: false,
    // Hides objects the depth buffer says are behind something else (see
    // culling/OcclusionSystem.js). OFF by default and deliberately so: it costs
    // a low-resolution depth pass over the scene's big geometry every frame,
    // which is a straight loss in an open landscape with nothing to hide behind
    // and a large win indoors.
    //
    // The setting now lives on the CAMERA (`CameraComponent`), because culling
    // is a property of a view — a minimap and a first-person camera looking at
    // the same room disagree about it. This remains as the scene-wide default a
    // camera set to `occlusionCulling: "inherit"` falls back to, which is what
    // every scene authored before the move says, so none of them changed
    // behaviour. A scene with no camera at all also lands here.
    occlusionCulling: false,
  },
};

/**
 * Build-wide quality presets, chosen in Build Settings and shipped in the
 * build's config. They are a **ceiling, not an override**: every knob is taken
 * as the cheaper of what the scene authored and what the preset allows.
 *
 * That asymmetry is the whole design. A scene deliberately dropped to
 * `renderScale: 0.5` because it is fill-bound must not be *raised* to 1 by
 * picking "High" in a dialog nobody associated with that scene — a preset that
 * can push a scene past what it was tuned for turns one global dropdown into a
 * silent regression across every level. So a preset can only ever make a build
 * cheaper than authored, and `ultra` applies no ceiling at all (ship what each
 * scene says).
 *
 * `null` on a key means "no ceiling for this knob".
 */
export const QUALITY_PRESETS = {
  low: {
    label: "Low",
    maxDevicePixelRatio: 1,
    renderScale: 0.65,
    volumeStepScale: 0.4,
    // Forced ON, not clamped: dynamic resolution can only lower resolution
    // further, so enabling it never exceeds the scene's own budget.
    dynamicResolution: true,
    // Forced OFF. The only preset that touches shadows — "low" on a laptop
    // integrated GPU is usually shadow-bound before it is anything else.
    shadows: false,
  },
  medium: {
    label: "Medium",
    maxDevicePixelRatio: 1.5,
    renderScale: 0.85,
    volumeStepScale: 0.7,
    dynamicResolution: true,
    shadows: null,
  },
  high: {
    label: "High",
    maxDevicePixelRatio: 2,
    renderScale: 1,
    volumeStepScale: 1,
    dynamicResolution: null,
    shadows: null,
  },
  ultra: {
    label: "Ultra (as authored)",
    maxDevicePixelRatio: null,
    renderScale: null,
    volumeStepScale: null,
    dynamicResolution: null,
    shadows: null,
  },
};

/** Cheaper of two numbers, tolerating a missing/`null` ceiling. */
const floorAt = (authored, ceiling, fallback) => {
  const a = Number.isFinite(authored) ? authored : fallback;
  return Number.isFinite(ceiling) ? Math.min(a, ceiling) : a;
};

/**
 * Returns `settings` with the named quality preset applied as a ceiling.
 * Pure — takes and returns plain objects, so both the player's boot path and
 * the headless build test can call it. An unknown or missing preset name is
 * a no-op rather than an error: a build made by a newer editor should still
 * run rather than refuse.
 */
export function applyQualityCeiling(settings, quality) {
  const preset = QUALITY_PRESETS[quality];
  if (!preset || quality === "ultra") return settings;
  const authored = { ...SCENE_SETTINGS_DEFAULTS.performance, ...(settings?.performance ?? {}) };
  const performance = {
    ...authored,
    maxDevicePixelRatio: floorAt(authored.maxDevicePixelRatio, preset.maxDevicePixelRatio, 2),
    renderScale: floorAt(authored.renderScale, preset.renderScale, 1),
    volumeStepScale: floorAt(authored.volumeStepScale, preset.volumeStepScale, 1),
    dynamicResolution: preset.dynamicResolution === true ? true : authored.dynamicResolution === true,
  };
  return {
    ...settings,
    performance,
    shadows: preset.shadows === false ? false : settings?.shadows !== false,
  };
}

/**
 * The quality preset a PORTABLE device (phone, tablet) is held to, whatever
 * the build asked for. A build's preset is one global choice — the user's
 * Sponza ships "high" (DPR 2, render scale 1) — and on a phone that is a
 * 1704×786 canvas of MSAA 4× raster, a 2048² VSM shadow map with two blur
 * passes and every screen-space pass at that size, on a GPU 6-8× slower than
 * the laptop it was measured on (20 fps, 2026-09-11). "medium" (DPR 1.5,
 * render scale 0.85, dynamic resolution on) is the same reduced tier the GI
 * module already applies to its own work on these devices.
 */
export const MOBILE_QUALITY_CEILING = "medium";

/**
 * The largest shadow map a PORTABLE device renders, per axis — OFF (0).
 * A 1024² cap was tried on 2026-09-11 (the user's iPhone read its 2048² sun
 * map at 2.4 ms of a 45 ms frame) and rejected the same evening: "1k shadows
 * look extremely awful" — PCF at a third of the texels reads as blocks on a
 * phone screen held close. The authored size ships everywhere; the mechanism
 * stays as an explicit A/B only: `__engineShadowMapCap = 1024` (0 = off).
 */
export const MOBILE_SHADOW_MAP_MAX = 0;

/** `size` capped for a portable device; unchanged elsewhere. */
export function capShadowMapSize(size, nav = globalThis.navigator, runtime = globalThis) {
  const pin = Number(runtime?.__engineShadowMapCap);
  const cap = Number.isFinite(pin) ? pin : (isPortableDevice(nav) ? MOBILE_SHADOW_MAP_MAX : 0);
  // MOBILE_SHADOW_MAP_MAX is 0 today (see above): without a pin this is a no-op.
  const n = Number(size) || 0;
  return cap > 0 ? Math.min(n, cap) : n;
}

/**
 * Whether this navigator is a phone or tablet — the same test the GI module
 * uses for its device tier (`giConfig.js`'s `giDeviceTierCeiling`, kept
 * import-free so its pure tests stay pure). `userAgentData.mobile` is the
 * only non-heuristic answer; the UA regex covers the engines without it, and
 * the touch-points clause catches iPadOS's desktop UA.
 */
export function isPortableDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent ?? "");
  return nav.userAgentData?.mobile === true
    || /Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua)
    || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

/**
 * The preset the PLAYER should run under on this device: the build's own
 * preset, lowered to `mobile` (Build settings → Mobile preset) on a portable
 * device when one is set. A preset only ever lowers, so a "low" build stays
 * low everywhere; an unknown or missing name is passed through untouched (an
 * older editor's build still runs). `override` (e.g. `?quality=high` in a
 * harness) wins outright.
 *
 * ⛔ NOT automatic (2026-09-11, same day it shipped automatic): applying
 * "medium" to every phone silently made the user's iPhone build "pixelated
 * as if pixel ratio was 1 or lower" — the preset forces dynamic resolution
 * ON, and against the scene's 120 fps target the controller drove the
 * canvas to its floor. A look change nobody asked for is a regression
 * whatever it saves; the phone cap is an authored choice, off by default.
 */
export function deviceQualityCeiling(quality, nav = globalThis.navigator, override = null, mobile = null) {
  if (typeof override === "string" && QUALITY_PRESETS[override]) return override;
  const cap = typeof mobile === "string" && QUALITY_PRESETS[mobile] ? mobile : null;
  if (!cap || !isPortableDevice(nav)) return quality ?? null;
  const order = Object.keys(QUALITY_PRESETS);
  const built = order.indexOf(quality);
  const capIndex = order.indexOf(cap);
  // An unknown preset (or none) on a phone gets the mobile preset.
  if (built < 0) return cap;
  return built <= capIndex ? quality : cap;
}

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

/**
 * The shadow filter, for the whole scene. THE ONLY PLACE IT IS SET.
 *
 * It used to be settable here AND per light (`LightComponent.shadowMapType`),
 * which is one control too many for a value that is not per-light: three reads
 * `renderer.shadowMap.type` and **never** `light.shadow.type` (r185 — see the
 * note in LightComponent.onPropChanged), so the per-light dropdown moved a
 * field nothing sampled. Lights now read this setting; the retired prop is
 * still honoured as a fallback so scenes authored against it keep their look.
 *
 * `PCSSShadowMap` is not one of three's renderer constants — it is a per-light
 * `filterNode` (`PCSSShadowFilter`, directional lights only) that LightComponent
 * installs when this names it. The renderer constant below it is what the rest
 * of the pipeline falls back to.
 */
export const SHADOW_TYPES = {
  BasicShadowMap: THREE.BasicShadowMap,
  PCFShadowMap: THREE.PCFShadowMap,
  PCFSoftShadowMap: THREE.PCFSoftShadowMap,
  PCSSShadowMap: THREE.PCFShadowMap,
  VSMShadowMap: THREE.VSMShadowMap,
};

// MSAA sample counts worth offering. 0 = "off" (handled by antialias=false).
// WebGPU only guarantees 1× and 4× — see `effectiveMsaaSamples`.
export const MSAA_SAMPLES = [1, 4];

/**
 * Renderer-construction options are those that WebGPU/WebGL fix at creation
 * time. Toggling any of them means we have to throw the renderer away and
 * re-init it. Engine.applySettings compares the new vs current values and
 * triggers a re-init when this set changes.
 */
export const RENDERER_REBUILD_KEYS = ["antialias", "samples", "transparent", "reversedDepth"];

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
export function rendererConstructorOptions(settings, host = null) {
  const r = settings.renderer ?? SCENE_SETTINGS_DEFAULTS.renderer;
  const samples = effectiveMsaaSamples(r);
  return {
    // three r185 folds these as `samples || antialias === true ? 4 : 0`
    // (Renderer.js:275 — the `||` binds first), so any truthy pair meant 4×.
    // Handing it the already-clamped count keeps `antialias` from overriding
    // a 1× choice.
    antialias: samples > 0,
    samples,
    alpha: r.transparent !== false,
    // Frozen at construction like MSAA (three picks canvas depth format, clear
    // value and every pipeline's depth compare from it).
    reversedDepthBuffer: r.reversedDepth === true,
    asyncCompilation: r.asyncCompilation !== false,
    // WebGPU timestamp queries: real GPU frame time for the stats overlay,
    // the profile.* tools, DRS and the frame governor. Not free — every pass
    // carries two timestamp writes and the engine resolves both pools each
    // frame — so the HOST decides (`host.trackTimestamp`; the player turns it
    // off unless `?hud=1` / `?timestamps=1`). `__engineTrackTimestamp`
    // (true/false) overrides either way for A/Bs.
    trackTimestamp: resolveTrackTimestamp(host?.trackTimestamp),
  };
}

/**
 * The MSAA count the renderer can actually use. WebGPU only guarantees 1 and
 * 4 (three's `WebGPUUtils.getSampleCount` rounds 2 down to 1 and 8/16 down to
 * 4), so anything else is clamped here, where the rebuild check compares it.
 * @param {{antialias?: boolean, samples?: number}} [renderer]
 */
export function effectiveMsaaSamples(renderer) {
  if (renderer?.antialias === false) return 0;
  const requested = renderer?.samples ?? 4;
  return requested >= 4 ? 4 : 0;
}

/** Host default, then the dev global. Off only when someone says so. */
export function resolveTrackTimestamp(hostValue) {
  if (globalThis.__engineTrackTimestamp === false) return false;
  if (globalThis.__engineTrackTimestamp === true) return true;
  return hostValue !== false;
}

/**
 * Sample count of a TSL `pass()` scene render as three resolves it:
 * `PassNode.setup` takes `options.samples ?? renderer.samples`, and the WebGPU
 * backend clamps to 1 or 4. TRAA must be gated on THIS, not on the scene's
 * renderer setting — the postprocess scene pass is single-sampled whatever
 * the canvas uses.
 */
export function passSampleCount(passOptions, rendererSamples) {
  const samples = passOptions?.samples ?? rendererSamples ?? 0;
  return samples >= 4 ? 4 : 1;
}

/**
 * Device limits worth asking for above the WebGPU baseline, resolved against
 * what the adapter actually offers.
 *
 * GI storage-buffer graphs deliberately stay within WebGPU's portable limit
 * of 8, so this function must never request a higher storage-buffer limit.
 * The uniform-buffer limit is separate: baseline **12**. GI's
 * uniform-slot design (analytic light slots, emitter slots, per-mesh transform
 * tables — all deliberately uniforms so that moving a light or a mesh costs a
 * uniform write and never a rebuild) means a compute stage that combines two of
 * those systems runs out: shading a BVH reflection hit with the cascade gather
 * plus emitters plus lights asks for 16. The failure mode is identical to the
 * storage-buffer one and just as opaque — "The number of uniform buffers (16)
 * in the Compute stage exceeds the maximum per-stage limit (12)", after which
 * the pipeline is invalid and EVERY compute submitted with it is dropped.
 *
 * REQUESTING BLIND WOULD BE WORSE THAN NOT ASKING. `requiredLimits` is a hard
 * requirement — `requestDevice` REJECTS if the adapter cannot meet it, which
 * would turn a renderer that works today into no renderer at all on weaker
 * hardware. So this queries the adapter first and only ever asks for what it
 * already advertises. An adapter that offers exactly the baseline gets an empty
 * object, i.e. today's behaviour unchanged.
 *
 * @returns {Promise<{requiredLimits?: Record<string, number>}>}
 */
export async function resolveRendererLimits() {
  try {
    const adapter = await navigator.gpu?.requestAdapter?.();
    // WHICH GPU — printed once per boot, because on a dual-GPU laptop the
    // answer decides every performance number that follows. Chromium's Dawn
    // asks for the LOW-POWER adapter by default and a page cannot override
    // it (the choice is per GPU process), so the editor spent months running
    // its whole GPU frame on the integrated chip — measured 10× slower on
    // the GI deposit — while every Chrome harness ran the discrete card.
    // `--force-high-performance-gpu` in additionalBrowserArgs is the fix;
    // this line is what keeps the fix HONEST across machines and updates.
    {
      const i = adapter?.info ?? {};
      const fallback = i.isFallbackAdapter ?? adapter?.isFallbackAdapter;
      console.log(
        `[gpu] adapter: ${i.vendor || "?"} / ${i.architecture || "?"}` +
          `${i.device ? ` (${i.device})` : ""}${i.description ? ` "${i.description}"` : ""}` +
          `${fallback ? " ⚠ FALLBACK (software)" : ""}` +
          ` — maxStorageBuffer ${((adapter?.limits?.maxStorageBufferBindingSize ?? 0) / 1048576) | 0}MB`,
      );
    }
    const requiredLimits = {};
    const uniforms = adapter?.limits?.maxUniformBuffersPerShaderStage ?? 0;
    if (uniforms > 12) requiredLimits.maxUniformBuffersPerShaderStage = Math.min(24, uniforms);
    // Baseline maxStorageTexturesPerShaderStage is **4**, and the GI resolve
    // already writes 4 (irradiance, emitter shadows, radiance, BVH hits) —
    // the GI-traced light-shadow target is the 5th. Same adapter-clamped ask
    // as above; a baseline-4 device simply doesn't get GI light shadows
    // (GISystem gates on the DEVICE limit before binding).
    const storageTex = adapter?.limits?.maxStorageTexturesPerShaderStage ?? 0;
    if (storageTex > 4) requiredLimits.maxStorageTexturesPerShaderStage = Math.min(8, storageTex);
    // SAMPLED TEXTURE COUNT: baseline is **16** per stage, and a GI-injected
    // fragment already spends most of that before the material's own maps —
    // the Foliage scene crossed it on 2026-09-12 and every affected pipeline
    // FAILED AT CREATION, forever:
    //   The number of sampled textures (17) in the Fragment stage exceeds the
    //   maximum per-stage limit (16). This adapter supports a higher
    //   maxSampledTexturesPerShaderStage of 48…
    // A pipeline that never becomes ready is worse than a slow one: three
    // caches nothing for it, so the material re-mints its node graph on every
    // frame that tries to draw it (measured: "Foliage · living surface" built
    // 52 times and climbing while the editor sat idle), the invalid layout
    // cascades into "[Invalid PipelineLayout]" on neighbouring materials, and
    // the mesh never appears. Same adapter-clamped ask as every limit above; a
    // baseline-16 device keeps today's behaviour, which means a >16-texture
    // material still fails there — the PORTABLE fix is to cut foliage's
    // sampler count, and this only stops the failure on hardware that already
    // advertises the headroom.
    const sampledTex = adapter?.limits?.maxSampledTexturesPerShaderStage ?? 0;
    if (sampledTex > 16) requiredLimits.maxSampledTexturesPerShaderStage = Math.min(32, sampledTex);
    // BINDING SIZE (not count — the count stays at the portable baseline):
    // the GI occupancy bits buffer scales with SCENE VOLUME, and a large
    // ultra scene sits near the 128MB default cliff — the static shadow BVH
    // region pushed a real project's buffer to 144MB, at which point EVERY
    // bind group using it failed and GI went dark (user-hit, 2026-08-06).
    // Same adapter-clamped ask as above (most desktop adapters advertise
    // ≥ 1GB); GISystem additionally shrinks its optional regions to fit the
    // DEVICE limit, so a baseline-128MB device degrades instead of breaking.
    const storageSize = adapter?.limits?.maxStorageBufferBindingSize ?? 0;
    if (storageSize > 134217728) {
      requiredLimits.maxStorageBufferBindingSize = Math.min(1073741824, storageSize);
    }
    // ⚠ BINDING SIZE AND BUFFER SIZE ARE SEPARATE LIMITS, and raising only the
    // first left a trap that Bistro sprang on 2026-08-16: with the binding
    // limit at 1GB, a 261MB GI buffer (occupancy bits + a grown static-shadow
    // BVH region) still failed at CREATION against the default maxBufferSize of
    // 256MB —
    //   Buffer size (274227200) exceeds the max buffer size limit (268435456)
    // — and a buffer that failed to create poisons every bind group that
    // references it, which cascades as the same endless "Invalid BindGroup
    // \"bindGroup_object\"" spam an overflowing uniform does. Ask for the same
    // ceiling as the binding ask (this adapter advertises 2GB), clamped the
    // same way.
    const bufferSize = adapter?.limits?.maxBufferSize ?? 0;
    if (bufferSize > 268435456) {
      requiredLimits.maxBufferSize = Math.min(1073741824, bufferSize);
    }
    // STORAGE-BUFFER COUNT: baseline is 8 per compute stage, and the GI
    // voxelizer reached 9 on 2026-08-16 when the per-slot local→world matrices
    // moved from the object-group UBO (where 768 slots of mat4s overflowed the
    // 64KB uniform binding — see occupancyField's localToWorld note) to a
    // storage buffer. Same adapter-clamped ask as above; this NVIDIA adapter
    // advertises 16. A baseline-8 device keeps today's behaviour, which also
    // means the slot raise does not reach it — GISystem's slot ceiling is
    // conservative either way, so the failure there is fewer seated
    // placements, not an invalid pipeline.
    const storageBufs = adapter?.limits?.maxStorageBuffersPerShaderStage ?? 0;
    if (storageBufs > 8) requiredLimits.maxStorageBuffersPerShaderStage = Math.min(16, storageBufs);
    // ── THE HARNESS CAP (`globalThis.__engineLimitsCap`) ────────────────────
    // A per-key CEILING on the ask, for harnesses that must prove the engine
    // still works inside the PORTABLE envelope on hardware that advertises
    // more. gi-gpu-smoke pins `{ maxStorageBuffersPerShaderStage: 8 }` with
    // it: without the pin, the 2026-08-16 raise to 16 (above) made the
    // smoke's "portable limit 8" assertion fail at device creation on every
    // desktop adapter — the smoke was red while the engine was fine. Asking
    // for exactly the baseline value is a legal ask, so capping is a
    // `Math.min`, never a delete.
    const cap = globalThis.__engineLimitsCap;
    if (cap && typeof cap === "object") {
      for (const [key, value] of Object.entries(cap)) {
        if (Number.isFinite(value) && requiredLimits[key] != null) {
          requiredLimits[key] = Math.min(requiredLimits[key], value);
        }
      }
    }
    // One line, always: when GI later refuses the occupancy backend ("device
    // gate"), THIS is the first thing to check. Storage buffers' BINDING COUNT
    // is raised only when the adapter advertises more (above); everything else
    // stays at the portable baseline.
    console.info(
      `[engine] webgpu adapter ${adapter ? "ok" : "NULL"} — limits ask: ${JSON.stringify(requiredLimits)}`,
    );
    if (Object.keys(requiredLimits).length > 0) return { requiredLimits };
  } catch (err) {
    // No WebGPU, or the adapter query failed — fall through to the baseline.
    // The renderer's own init() will report the real problem if there is one.
    console.info(`[engine] webgpu limits query threw: ${err?.message ?? err}`);
  }
  return {};
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
 *  (the HDRI EnvironmentComponent) alone — those have their own lifecycle.
 *
 *  `environmentIntensity` is written even though three itself ignores it while
 *  `scene.environment` is null (every IBL reader is gated on an env map): it is
 *  the intensity scalar GI's solid-color sky reads, so the panel's one
 *  Intensity knob scales the HDRI path and the background-colour path alike. */
function clearSceneEnvironment(settings, scene, env) {
  if (isSceneEnvTexture(scene.environment)) scene.environment = null;
  if (!isForeignTexture(scene.background)) {
    scene.background = new THREE.Color(settings.background);
    scene.backgroundBlurriness = 0;
  }
  scene.environmentIntensity = env.intensity ?? 1;
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
 * Background + image-based lighting. Decoding a cube map or an HDRI is async,
 * but this runs on *every* settings change (dragging a quality slider
 * re-applies everything), so a cached texture is installed synchronously —
 * otherwise the sky would flash back to the clear color on each unrelated edit.
 */
function applySceneEnvironment(settings, scene) {
  const env = { ...SCENE_SETTINGS_DEFAULTS.environment, ...(settings.environment ?? {}) };
  const seq = ++environmentSeq;
  const path = env.cubemap;
  const cached = path ? getLoadedEnvironment(path) : null;
  if (cached) {
    pushSceneEnvironment(settings, scene, cached, env);
    return;
  }
  clearSceneEnvironment(settings, scene, env);
  if (!path) return;
  loadEnvironmentAsset(path).then((texture) => {
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
    // Through outputTransform.js: on the inline path the renderer itself
    // stays at "none" and the materials carry the transform (see that file).
    applyOutputTransform(renderer, {
      toneMapping: TONE_MAPPINGS[settings.toneMapping] ?? THREE.NeutralToneMapping,
      exposure: settings.exposure ?? 1,
    });
    // Shadows: master switch + per-renderer type/autoUpdate. The map type is
    // expensive (it reallocates internal target textures when changed), but
    // `setMapType` handles that without re-creating the renderer.
    const shadowOn = settings.shadows !== false;
    renderer.shadowMap.enabled = shadowOn;
    const shadow = settings.shadow ?? SCENE_SETTINGS_DEFAULTS.shadow;
    renderer.shadowMap.type = SHADOW_TYPES[shadow.type] ?? THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = shadow.autoUpdate !== false;
    renderer.shadowMap.needsUpdate = shadow.needsUpdate === true;
    // The WebGPU path never reads `renderer.shadowMap.autoUpdate`:
    // ShadowNode.updateBefore gates on the PER-LIGHT `shadow.needsUpdate ||
    // shadow.autoUpdate` (three r185, ShadowNode.js ~855). Mirror the setting
    // onto every light so the checkbox governs what actually renders. GI-mode
    // lights stay out: their 16x16 map is deliberately frozen forever
    // (LightComponent#configureShadow) and flipping autoUpdate back on would
    // re-render a placeholder nothing samples.
    // ⚠ ONE PREDICATE, SHARED WITH ShadowFreezeSystem, and that is deliberate:
    // this walk used to filter on `obj.isLight`, which silently excluded every
    // CSM cascade (`class LwLight extends Object3D` — it owns a real map and
    // carries no `isLight`) while including the CSM parent, whose flag three
    // never reads. So the author's own escape hatch was inert on exactly the
    // scenes that needed it most. Two copies of this filter drifting apart is
    // how that survived; `collectFreezableCasters` is now the single answer to
    // "whose `autoUpdate` does a plain ShadowNode actually read".
    for (const obj of collectFreezableCasters(scene)) {
      const authoredAutoUpdate = shadow.autoUpdate !== false;
      obj.shadow.autoUpdate = authoredAutoUpdate;
      // ⚠ `!obj.shadow.map` WAS TESTING THE WRONG FIELD. `LightShadow.map` is the
      // WebGL render target and is ALWAYS null on the WebGPU path — the map lives
      // on the ShadowNode's own `shadowMap`, which nothing here can see. So the
      // condition read "always true" for any light with autoUpdate off, and this
      // branch force-wrote `needsUpdate` on every frozen light on every settings
      // apply. That write is precisely the state that crashes three's
      // `updateShadow` (`shadowMap.depthTexture` on null after a node dispose) —
      // see the long note at GISystem#syncLightShadowNodes.
      //
      // An explicit authored one-shot is still honoured, because that is a
      // deliberate user action on a light three has already had a frame to build.
      // The "frozen light never rendered its map" case it was guessing at is
      // handled where the freezing actually happens: ShadowFreezeSystem never
      // freezes a light until it has seen the same content key TWICE, so three is
      // guaranteed one real shadow render first.
      // ⚠ This is SAFE ONLY because `installShadowNodeGuard` (Engine
      // constructor) patches the missing null check in three's
      // `ShadowNode.updateBefore`. Setting `needsUpdate` on a light whose node
      // has no `shadowMap` yet used to crash with "Cannot read properties of
      // null (reading 'depthTexture')" — and so did leaving `autoUpdate` true,
      // since three gates on the OR of the two. Neither flag was ever the fix.
      //
      // ⚠ `shadow.needsUpdate` PERSISTS in the .scene, so once saved true it is
      // re-applied on every settings apply for the life of the project rather
      // than acting as the one-shot it reads as.
      // "Auto update off" means render this map once and retain it, not
      // "never allocate a map". WebGPU's ShadowNode only enters its render
      // path when one of these per-light flags is true, so a virgin/imported
      // light needs this one-shot pulse. Three clears `needsUpdate` after the
      // render; the installed ShadowNode guard makes the first build safe.
      if (!authoredAutoUpdate || shadow.needsUpdate === true) {
        obj.shadow.needsUpdate = true;
      }
    }
  }
}

function clamp01Range(v, min, max) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : max;
}
