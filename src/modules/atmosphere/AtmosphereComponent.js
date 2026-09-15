import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { airTemperature, celestialState } from "./sunCycle.js";
import {
  WEATHER_NAMES, applyThermalPhase, blendWeather, makeRandom, scaleWeather, stepAccumulation, stepAutoWeather,
  weatherPreset,
} from "./weather.js";
import { celestialLight, fillSkyEquirect, fogColor, measureSky, skyParameters } from "./skyModel.js";
import { createSkyUniforms, setSkyMap, skyColorNode } from "./skyNode.js";
import { createHeightFog, updateHeightFog } from "./heightFogNode.js";
import { createPrecipitation } from "./precipitation.js";
import { applySurfaceWeather, clearSurfaceWeather, createSurfaceUniforms, refreshSceneMaterials } from "./weatherSurface.js";
import { cloudOpacityAt } from "./cloudNoise.js";
import { createCloudShadowUniforms, installCloudShadow, removeCloudShadow } from "./cloudShadow.js";
import { createSkyOcclusion } from "./skyOcclusion.js";
import { prepareSkyEnvironment } from "./prepareSkyEnvironment.js";
import { skyPmremDue, skySnapshot } from "./skyEnvironmentRefresh.js";
import { shadowSnapBasis, snapShadowCentre, wholeTexelStep } from "../../engine/shadowSnap.js";

/**
 * ⭐⭐⭐ ONE COMPONENT FOR THE SKY AND THE WEATHER, BECAUSE THEY ARE ONE THING.
 *
 * A storm is not "rain particles plus a darker sky preset". It is one
 * atmospheric state that the sun's colour, the sky's brightness, the cloud
 * deck, the fog, the wind every curtain and every tree is already reading, and
 * the rain, all agree about. Splitting that across a Sky component and a
 * Weather component means two sources of truth for cloud cover, and the first
 * thing that goes wrong is a scene lit like noon under a sky full of thunder.
 *
 * So the ownership here is deliberately wide, and each piece is pushed to the
 * seam that already exists rather than to a new one:
 *
 *   sky picture   → `scene.backgroundNode`  (`skyNode.js`)
 *   sky lighting  → `scene.environment`, a half-float equirect that GI's sky
 *                   bins can read on the CPU (`skyModel.js`)
 *   sun / moon    → the scene's directional light, aimed and coloured
 *   fog           → `scene.fog`, coloured from the sky's own horizon
 *   valley mist   → `scene.fogNode` (`heightFogNode.js`), height fog that
 *                   replicates the FogExp2 far field and pools low
 *   wind          → `engine.windOverride`, which cloth and foliage already
 *                   read as "the scene's wind"
 *   rain / snow   → two instanced draws, no simulation (`precipitation.js`)
 *
 * ⚠ WHAT IT TAKES OVER, IT GIVES BACK. Every scene value it drives is saved at
 * attach and restored on detach or disable, because an Atmosphere is something
 * you switch on to look at a scene and off to go back to authoring it.
 */

const SKY_WIDTH = 128;
const SKY_HEIGHT = 64;
/** Rows filled per frame while a refresh is in flight — see `fillSkyEquirect`. */
const SKY_SLICE = 16;
/** Rows of the sky map filled per frame while the sun is moving quickly. See
 *  `_refreshSky` for why there is no wall-clock cooldown any more. */
const SKY_SLICE_FAST = 32;
/** …or for a sun that has moved less than this. 0.026 rad is 1.5°, HALF A
 *  TEXEL of the 128x64 map: below it the refresh cannot change a single pixel
 *  of the dome, so it is pure cost. (It was 0.34°, which at one real minute per
 *  day published a new sky seventeen times a second — every one of which GI
 *  re-integrated at ~1.2 ms and logged.) */
const SKY_SUN_EPSILON = 0.026;
/** …but a sky whose COLOUR is moving fast refreshes on the colour instead, so
 *  a sunset never steps: mean relative change of irradiance and horizon. */
const SKY_COLOUR_EPSILON = 0.012;
// Prefiltered-radiance (PMREM) rebuilds run EIGHT nested `renderer.render`
// calls inside the frame that asks for one, so they are gated on the sky
// having changed perceptibly since the last rebuild — not on a timer. See
// `skyEnvironmentRefresh.js` and `_maybeRebuildEnvironment`.
/** Nor for a weather change smaller than this, summed over every channel. */
const SKY_WEATHER_EPSILON = 0.004;
/** Game hours per real minute when the clock is frozen but weather is on auto. */
const FROZEN_WEATHER_RATE = 1;
/** Seconds for the world's surfaces to catch up with the accumulators. Long
 *  enough that snow arrives as weather rather than as a switch — and the
 *  coverage reaches flat ground early in the sweep, so the ease has to outlast
 *  the part of it anyone is watching. */
const SURFACE_EASE_SECONDS = 9;
/** Metres to the base of the cloud deck — `skyNode.js` draws it at the same. */
const CLOUD_BASE = 1400;
/** Radians the sun must turn before the LIGHT is re-aimed (0.25°). Below this
 *  nothing in the picture can show the difference and everything downstream —
 *  GI above all — is allowed to stay still. See `_applySun`. */
const SUN_STEP = 0.0044;
/** §smooth-sun (2026-09-10): the light TRANSFORM is now re-aimed almost every
 *  frame (this tiny step) so the CSM shadow GLIDES under a day/night sun
 *  instead of jumping in 0.25° steps. GI no longer needs the light held still
 *  for it — it snaps the direction it reads on its own side
 *  (GISystem `GI_SUN_DIR_STEP`), so it still rests between real 0.25° steps
 *  while the shadow the eye watches stays smooth. `__atmosphereSmoothSun =
 *  false` restores the old stepped light (and its jerky shadow). */
const SUN_SMOOTH_STEP = 0.0004;
/** ⭐⭐⭐ §sun-shadow-hz (2026-09-13): §smooth-sun's tiny `SUN_SMOOTH_STEP`
 *  re-aims the light on almost every frame — fine for a parked sun (nothing
 *  moves, so the hold never triggers), but under a RUNNING clock it forced a
 *  cascade redraw every frame again for the exact reason §sun-dir-step exists
 *  on the GI side. So while the clock is running (`dayLength > 0` and
 *  actually advancing — see `_advanceClock`'s `this._sunAngularRate`, deg/sec,
 *  0 when static) the light is held in a step sized off the sun's OWN angular
 *  rate rather than a fixed constant: `step = rate / SUN_SHADOW_HZ`, clamped
 *  so the shadow can never redraw faster than `SUN_SHADOW_HZ` times a second
 *  nor coarser than `SUN_HOLD_MAX_DEG`. A parked sun (`this._sunAngularRate
 *  === 0`) keeps exactly today's `SUN_SMOOTH_STEP` behaviour. Colour,
 *  intensity, fog, ambient and the sky are untouched — they are written every
 *  frame from the continuous model regardless of this hold.
 *  `this._sunAngularRate` is also published on `engine.sunAngularRate` so
 *  GISystem can size its own `GI_SUN_DIR_STEP` off the same rate without
 *  importing this component. `__atmosphereSmoothSun = false` still overrides
 *  everything above back to the old flat `SUN_STEP`. */
const SUN_SHADOW_HZ = 4;
const SUN_HOLD_MIN_DEG = 0.05;
const SUN_HOLD_MAX_DEG = 0.5;
const SUN_DEG2RAD = Math.PI / 180;
/** …and metres the camera may drift before an OWNED sun re-centres its shadow
 *  frustum. The frustum is 90 m across, so four is invisible. Rounded down to
 *  whole texels (`wholeTexelStep`) so a recentre never swims shadow edges. */
const SUN_ANCHOR_STEP = 4;
/** The owned sun's ortho half-extent (m), map size, and caster reach up-sun. */
const OWNED_SUN_HALF = 45;
const OWNED_SUN_MAP = 2048;
const OWNED_SUN_REACH = 120;
/** Metres per second the authored dial may reach. A hurricane is ~33 m/s and
 *  a blizzard preset is already 15, so this is the top of real weather. */
const WIND_CEILING = 35;
/** Shader extinction per metre per unit of authored mist density: at 1 a
 *  valley is opaque past ~400 m, before the weather's `mist` channel adds its
 *  own on top. */
const MIST_DENSITY_SCALE = 0.0035;
/** Noise tiles per metre for the drifting banks — a bank is ~40 m across. */
const MIST_NOISE_SCALE = 1 / 90;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const ease = (t) => t * t * (3 - 2 * t);
const mixValue = (a, b, t) => a + (b - a) * t;
const FORWARD = new THREE.Vector3(0, 0, -1);

const _direction = new THREE.Vector3();
const _cameraPosition = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _snapCentre = new THREE.Vector3();
const _snapTravel = new THREE.Vector3();
const _snapRight = new THREE.Vector3();
const _snapUp = new THREE.Vector3();

/**
 * Snaps `centre` (the camera position) onto the owned sun's whole-texel grid.
 * `toward` points at the sun; the map's basis follows the light's TRAVEL.
 * Exported for the unit test.
 * @param {THREE.Vector3} centre in/out
 * @param {THREE.Vector3} toward unit vector towards the sun
 */
export function ownedSunShadowCentre(centre, toward) {
  _snapTravel.copy(toward).negate();
  shadowSnapBasis(_snapTravel, _snapRight, _snapUp);
  const step = wholeTexelStep(SUN_ANCHOR_STEP, (OWNED_SUN_HALF * 2) / OWNED_SUN_MAP);
  return snapShadowCentre(centre, _snapTravel, _snapRight, _snapUp, step, step, step);
}

export class AtmosphereComponent extends Component {
  static type = "atmosphere";
  static label = "Atmosphere";
  static tags = ["world", "sky", "weather", "lighting", "3d"];
  /** Its own runtime clock and weather chain do not survive a Play/Stop. */
  static resetOnStop = false;

  static defaults = {
    // ── Time ──────────────────────────────────────────────────────────────
    timeOfDay: 10.5,
    dayOfYear: 172,
    /** Real minutes for one game day. 0 freezes the clock (the default: a sky
     *  that moves while you are authoring re-lights the scene under you). */
    dayLength: 0,
    latitude: 45,
    northOffset: 0,
    // ── Sky ───────────────────────────────────────────────────────────────
    sky: true,
    skyIntensity: 1,
    stars: true,
    nightLight: 1,
    clouds: true,
    // ── Sun ───────────────────────────────────────────────────────────────
    /** The directional light this aims. Empty = the scene's first one, or an
     *  owned light if the scene has none. */
    sun: "",
    sunIntensity: 1,
    // ── Weather ───────────────────────────────────────────────────────────
    // ⚠ NOT "clear". A cloudless sky is a flat blue gradient — correct, and
    // the least interesting thing this module can draw. A new Atmosphere
    // should show what it is FOR, and scattered fair-weather cumulus is what
    // a sky looks like on a good day.
    weather: "fair",
    weatherIntensity: 1,
    /** Seconds to cross from one weather to the next. */
    transition: 20,
    seed: 1,
    /** Degrees Celsius added to the modelled climate. Decides rain vs snow. */
    climate: 0,
    windDirection: 45,
    /** ⭐ THE AUTHOR'S HAND ON THE WIND. The Atmosphere OWNS `engine.windOverride`
     *  while it runs, so the scene's own wind setting is not reachable from
     *  here — every cloth, every tree and every drop of rain is reading the
     *  weather's number instead. These two scale it: the weather still decides
     *  that a storm blows harder than a drizzle, and this decides how hard a
     *  storm blows in THIS scene. 0 is a dead calm; the inspector's "Wind" row
     *  reads back the metres per second that come out. */
    windSpeed: 1,
    gustiness: 1,
    // ── Valley mist (height fog) ──────────────────────────────────────────
    /** Low mist pooled under a base level, drifting in banks with the wind.
     *  OFF BY DEFAULT: the node is installed at attach either way (see
     *  `_installFog`), so every existing preset stays pixel-identical until
     *  this is switched on. The weather's `mist` channel adds to it. */
    heightFog: false,
    heightFogDensity: 0.35,
    /** World Y the mist pools under. NaN or "auto" follows the scene's first
     *  live Water surface's level (else 0). */
    heightFogBase: 0,
    /** Metres over which the mist thins above the base level. */
    heightFogFalloff: 8,
    /** 0 = a level sheet; 1 = fully carved into drifting banks. */
    heightFogNoise: 0.5,
    // ── What it is allowed to drive ───────────────────────────────────────
    precipitation: true,
    /** Snow lying on the world and rain darkening it — see `weatherSurface.js`. */
    surfaces: true,
    /** Cloud shadows drifting across the world, in the sun's own shadow term. */
    cloudShadows: true,
    /** Drive the scene's ambient light from the sky, so a storm is not lit
     *  like a clear noon. */
    ambient: true,
    fog: true,
    wind: true,
    lightning: true,
    /** ⭐ ON, because rain falling through a roof is not a missing feature, it
     *  is a broken one — the user's report, in their words: "precipitation goes
     *  through walls and meshes". It costs one 128x128 top-down capture at 2 Hz
     *  and it is what tells a drop, and the snow on the ground, whether the sky
     *  is above them at all.
     *
     *  It was off for a day because the FIRST capture compiled a pipeline per
     *  geometry variant synchronously — thirty seconds of frozen editor on this
     *  project. That is fixed at the source: the pipelines are warmed through
     *  `compileAsync` and the map stays inert until they land, so the worst a
     *  scene now sees is a second of rain that has not learnt about roofs yet.
     *  See `skyOcclusion.js`. */
    sheltered: true,
  };

  static schema = [
    { key: "timeOfDay", label: "Time of Day", type: "number", min: 0, max: 24, step: 0.25, section: "Time" },
    { key: "dayOfYear", label: "Day of Year", type: "number", min: 1, max: 365, step: 1, section: "Time" },
    { key: "dayLength", label: "Day Length (min)", type: "number", min: 0, max: 240, step: 1, section: "Time" },
    { key: "runInEditor", label: "Run In Editor", type: "boolean", section: "Time" },
    { key: "latitude", label: "Latitude", type: "number", min: -90, max: 90, step: 1, section: "Time" },
    { key: "northOffset", label: "North Offset", type: "number", min: -180, max: 180, step: 5, section: "Time" },

    { key: "sky", label: "Draw Sky", type: "boolean", section: "Sky" },
    { key: "skyIntensity", label: "Sky Intensity", type: "number", min: 0, max: 4, step: 0.05, section: "Sky", showIf: (p) => p.sky },
    { key: "clouds", label: "Clouds", type: "boolean", section: "Sky", showIf: (p) => p.sky },
    { key: "stars", label: "Stars", type: "boolean", section: "Sky", showIf: (p) => p.sky },
    { key: "nightLight", label: "Night Brightness", type: "number", min: 0, max: 3, step: 0.05, section: "Sky" },

    { key: "sun", label: "Sun Light", type: "entity", section: "Sun" },
    { key: "sunIntensity", label: "Sun Intensity", type: "number", min: 0, max: 4, step: 0.05, section: "Sun" },

    { key: "weather", label: "Weather", type: "select", options: ["auto", ...WEATHER_NAMES], section: "Weather" },
    { key: "weatherIntensity", label: "Severity", type: "number", min: 0, max: 1, step: 0.05, section: "Weather" },
    { key: "transition", label: "Transition (s)", type: "number", min: 0, max: 600, step: 1, section: "Weather" },
    { key: "climate", label: "Climate (°C)", type: "number", min: -30, max: 30, step: 1, section: "Weather" },
    { key: "windDirection", label: "Wind From", type: "number", min: -180, max: 360, step: 5, section: "Weather" },
    { key: "windSpeed", label: "Wind Strength", type: "number", min: 0, max: 8, step: 0.1, section: "Weather" },
    { key: "gustiness", label: "Gustiness", type: "number", min: 0, max: 3, step: 0.05, section: "Weather" },
    { key: "seed", label: "Seed", type: "number", min: 0, step: 1, section: "Weather", showIf: (p) => p.weather === "auto" },

    { key: "heightFog", label: "Valley Mist", type: "boolean", section: "Height Fog" },
    { key: "heightFogDensity", label: "Density", type: "number", min: 0, max: 1, step: 0.05, section: "Height Fog", showIf: (p) => p.heightFog },
    { key: "heightFogBase", label: "Base Level (m, empty = water)", type: "number", min: -500, max: 4000, step: 0.5, section: "Height Fog", showIf: (p) => p.heightFog },
    { key: "heightFogFalloff", label: "Height Falloff (m)", type: "number", min: 0.5, max: 200, step: 0.5, section: "Height Fog", showIf: (p) => p.heightFog },
    { key: "heightFogNoise", label: "Drifting Banks", type: "number", min: 0, max: 1, step: 0.05, section: "Height Fog", showIf: (p) => p.heightFog },

    { key: "precipitation", label: "Rain and Snow", type: "boolean", section: "Drives" },
    { key: "surfaces", label: "Snow and Wet Ground", type: "boolean", section: "Drives" },
    { key: "cloudShadows", label: "Cloud Shadows", type: "boolean", section: "Drives" },
    { key: "ambient", label: "Ambient Light", type: "boolean", section: "Drives" },
    { key: "sheltered", label: "Respect Roofs (extra pass)", type: "boolean", section: "Drives" },
    { key: "fog", label: "Scene Fog", type: "boolean", section: "Drives" },
    { key: "wind", label: "Scene Wind", type: "boolean", section: "Drives" },
    { key: "lightning", label: "Lightning", type: "boolean", section: "Drives" },
  ];

  constructor(props) {
    super(props);
    this.root = null;
    this.uniforms = createSkyUniforms();
    // ⭐ ONE ANSWER TO "WHAT CAN SEE THE SKY", shared by the snow on the ground
    // and the rain in the air. Built before the two things that compile it
    // into their shaders — see `createSurfaceUniforms`.
    this.skyOcclusion = createSkyOcclusion();
    this.surfaceUniforms = createSurfaceUniforms(this.skyOcclusion.uniforms);
    this.cloudShadowUniforms = createCloudShadowUniforms();
    this.skyData = new Uint16Array(SKY_WIDTH * SKY_HEIGHT * 4);
    this.skyTexture = null;
    this.layers = null;
    this.celestial = null;
    /** ⛔ NOT `this.weather`. `weather` is an authored PROP, and the Component
     *  base installs an accessor for every prop name — so `this.weather = …`
     *  is `setProp("weather", …)`, which fires `onPropChanged`, which calls
     *  `update()`, which blends the weather again: "Maximum call stack size
     *  exceeded", every frame. It also overwrote the authored preset NAME with
     *  a blended object. The runtime blend lives under its own name. */
    this.conditions = weatherPreset("clear");
    this.accumulation = { wetness: 0, snowDepth: 0 };
    this._auto = { current: "fair", elapsed: 0, dwell: null, random: makeRandom(1) };
    this._blend = 1;
    this._from = weatherPreset("clear");
    this._targetName = "clear";
    this._flash = 0;
    this._nextStrike = Infinity;
    /** Eased cloud occlusion of the sun, 0…1. */
    this._sunShade = 0;
    /** What was last WRITTEN to the sun light, so the next frame can decide it
     *  has nothing to say. See `_applySun` for why this exists. */
    this._sunApplied = {
      direction: new THREE.Vector3(), intensity: -1, color: [-1, -1, -1],
      visible: true, anchor: new THREE.Vector3(NaN, NaN, NaN), light: null, frames: 0,
    };
    this._fillRow = SKY_HEIGHT;
    this._fillParams = null;
    this._lastFill = -Infinity;
    this._lastFillSun = new THREE.Vector3(0, -1, 0);
    this._lastFillWeather = null;
    this._cloudDrift = new THREE.Vector2();
    this._cirrusDrift = new THREE.Vector2();
    this._mistDrift = new THREE.Vector2();
    this._fogNode = null;
    this._windAngle = 45;
    this._sun = null;
    this._sunCheck = 0;
    this._shadowedLight = null;
    /** The light `installCloudShadow` was last OFFERED — a refusal is final
     *  for that light, and retrying it every frame is a whole-scene wave. */
    this._cloudShadowTried = null;
    /** The sky the environment map was last PUBLISHED at, so a refresh that
     *  changes nothing the eye or GI can see is not published at all. */
    this._lastPublished = null;
    this._lastPmrem = -Infinity;
    /** The sky snapshot the current PMREM was BUILT from (null = none yet). */
    this._pmremBaseline = null;
    /** Seconds since attach, until the roof capture has been warmed; then null. */
    this._warmClock = null;
    this._stats = { status: "Detached" };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  onAttach() {
    const engine = this.entity.engine;
    // ⚠ ONE ATMOSPHERE PER SCENE. Two would each install a background node and
    // an environment map every frame and the scene would flicker between two
    // skies — a bug that reads as "the sky is broken", not as "you have two".
    if (engine.__atmosphere && engine.__atmosphere !== this && engine.__atmosphere._alive) {
      this._alive = false;
      this._stats.status = "Inactive: this scene already has an Atmosphere";
      return;
    }
    engine.__atmosphere = this;
    this._alive = true;

    this.root = new THREE.Group();
    this.root.name = "Atmosphere";
    // The sky's meshes are world-space by construction (the precipitation
    // vertex node computes world positions, the owned sun is aimed in world
    // space), so the owning entity's transform must not reach them.
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldAutoUpdate = false;
    Object.assign(this.root.userData, { atmosphereOwned: true, entityId: this.entity.id, __giDebug: true });
    this.entity.object3D.add(this.root);

    this.skyTexture = new THREE.DataTexture(this.skyData, SKY_WIDTH, SKY_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
    this.skyTexture.name = "Atmosphere · sky";
    this.skyTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.skyTexture.wrapS = THREE.RepeatWrapping;
    this.skyTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.skyTexture.minFilter = THREE.LinearFilter;
    this.skyTexture.magFilter = THREE.LinearFilter;
    this.skyTexture.generateMipmaps = false;
    this.skyTexture.colorSpace = THREE.NoColorSpace;
    // Says "a component owns this" to Scene Settings, whose `isForeignTexture`
    // then leaves the scene's background alone instead of clearing it.
    this.skyTexture.userData.atmosphereOwned = true;
    this.skyTexture.needsUpdate = true;
    setSkyMap(this.uniforms, this.skyTexture);
    this._backgroundNode = skyColorNode(this.uniforms);

    this.layers = {
      rain: createPrecipitation("rain", this.skyOcclusion.uniforms),
      snow: createPrecipitation("snow", this.skyOcclusion.uniforms),
    };
    this.root.add(this.layers.rain.mesh, this.layers.snow.mesh);

    this._saveSceneState(engine);
    this._installFog(engine);
    this._surfaceSweep = 0;
    if (this.props.surfaces) applySurfaceWeather(engine.scene, this.surfaceUniforms);
    // The roof capture's pipelines are warmed a couple of seconds from now —
    // see `_warmClock` in `update`.
    this._warmClock = 0;

    this._unsub = [
      engine.onPreRender?.(() => {
        this.update();
        prepareSkyEnvironment(engine, this.skyTexture);
      }),
      // The sun light can arrive after this component does — a scene loads its
      // entities in order, and "the atmosphere has no sun" must not be a
      // permanent verdict reached on frame one.
      engine.on?.("hierarchy-changed", () => { this._sun = null; }),
      engine.on?.("component-added", () => { this._sun = null; }),
      engine.on?.("component-removed", () => { this._sun = null; }),
    ];

    this._warmPrecipitation();
    this._targetName = this.props.weather === "auto" ? this._auto.current : this.props.weather;
    this.conditions = scaleWeather(weatherPreset(this._targetName), this.props.weatherIntensity);
    this._from = { ...this.conditions };
    this._blend = 1;
    this._auto.random = makeRandom(this.props.seed);
    this._windAngle = Number(this.props.windDirection) || 0;
    this.update(true);
  }

  onDetach() {
    const engine = this.entity?.engine;
    this._alive = false;
    for (const unsub of this._unsub ?? []) unsub?.();
    this._unsub = [];
    if (engine?.__atmosphere === this) engine.__atmosphere = null;
    clearSurfaceWeather(engine?.scene);
    this._restoreSceneState(engine);
    this._fogNode = null;
    this.layers?.rain.dispose();
    this.layers?.snow.dispose();
    this.layers = null;
    if (this._shadowedLight) removeCloudShadow(this._shadowedLight);
    this._shadowedLight = null;
    this._cloudShadowTried = null;
    this.skyOcclusion?.dispose();
    this._restoreAmbient();
    this._ownedSun?.dispose?.();
    this._ownedSun = null;
    this._sun = null;
    this.root?.removeFromParent();
    this.root = null;
    this.skyTexture?.dispose();
    this.skyTexture = null;
    this._stats.status = "Detached";
  }

  onDisable() {
    if (this.root) this.root.visible = false;
    this._restoreAmbient();
    clearSurfaceWeather(this.entity?.engine?.scene);
    this._restoreSceneState(this.entity?.engine);
  }

  onEnable() {
    // The light was handed back on disable, so the next tick must WRITE it
    // rather than decide it already matches what it last wrote.
    this._sunApplied.frames = 0;
    if (this.root) this.root.visible = true;
    if (this.props.surfaces) applySurfaceWeather(this.entity?.engine?.scene, this.surfaceUniforms);
    this._skyDirty = true;
  }

  onPropChanged(key) {
    if (!this._alive) return;
    if (key === "seed") this._auto.random = makeRandom(this.props.seed);
    if (key === "sun") this._sun = null;
    if (key === "windDirection") this._windAngle = Number(this.props.windDirection) || 0;
    if (key === "surfaces") {
      // ⚠ Both directions recompile every patched material, so this is a
      // deliberate authoring action, never something the weather does on its own.
      if (this.props.surfaces) applySurfaceWeather(this.entity?.engine?.scene, this.surfaceUniforms);
      else clearSurfaceWeather(this.entity?.engine?.scene);
    }
    if (key === "precipitation" && !this.props.precipitation) {
      this.layers?.rain.setAmount(0);
      this.layers?.snow.setAmount(0);
    }
    if (key === "sky" || key === "fog" || key === "wind") {
      // Handing a value back has to be immediate: leaving the sky installed
      // for another frame after "Draw Sky" was unticked reads as a dead toggle.
      if (!this.props[key]) this._restoreSceneState(this.entity?.engine, key);
    }
    // ⚠ DIRTY, NOT FORCED. `onPropChanged` runs once per `pointermove` of a
    // slider drag; forcing the full 1.5 ms sky fill there would put the whole
    // refresh on the drag path. The flag starts a SLICED refresh on the next
    // frame instead, which the cooldown already paces at ~5 Hz.
    this._skyDirty = true;
    this.update();
  }

  // ── the scene values this borrows ─────────────────────────────────────────

  _saveSceneState(engine) {
    const scene = engine?.scene;
    if (!scene || this._saved) return;
    this._saved = {
      background: scene.background,
      backgroundNode: scene.backgroundNode,
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      fog: scene.fog,
      fogNode: scene.fogNode ?? null,
      windOverride: engine.windOverride ?? null,
      ambient: engine.ambientLight
        ? { color: engine.ambientLight.color.clone(), intensity: engine.ambientLight.intensity }
        : null,
    };
  }

  /** @param {string} [only] restore just the half a toggle turned off. */
  _restoreSceneState(engine, only) {
    const scene = engine?.scene;
    const saved = this._saved;
    if (!scene || !saved) return;
    if (!only || only === "sky") {
      if (scene.backgroundNode === this._backgroundNode) scene.backgroundNode = saved.backgroundNode;
      if (scene.environment === this.skyTexture) {
        scene.environment = saved.environment;
        scene.environmentIntensity = saved.environmentIntensity;
      }
    }
    if (!only || only === "fog") {
      if (scene.fog === this._fog) scene.fog = saved.fog;
      if (this._fogNode && scene.fogNode === this._fogNode.node) scene.fogNode = saved.fogNode ?? null;
    }
    if (!only || only === "wind") {
      if (engine.windOverride === this._wind) engine.windOverride = saved.windOverride;
    }
    if (!only) this._saved = null;
  }

  /**
   * ⛔ THE FOG IS INSTALLED ONCE AND NEVER REMOVED WHILE ATTACHED, even at
   * density zero. `scene.fog` is part of every material's shader key: adding
   * or removing it recompiles the whole scene, and weather crosses the "is
   * there fog" line constantly. One compile at attach, none afterwards.
   */
  _installFog(engine) {
    const scene = engine?.scene;
    if (!scene || !this.props.fog) return;
    this._fog = new THREE.FogExp2(0x8a93a0, 0);
    this._fog.name = "Atmosphere";
    scene.fog = this._fog;
    // ⛔ `scene.fogNode` IS ONE SLOT, and the water medium owns it when a Water
    // surface exists (`waterMedium.js` — it replicates `scene.fog` exactly the
    // way `heightFogNode.js` does). Install only when the slot is free, and
    // never take it back mid-session: replacing the node recompiles EVERY
    // material, the wave this whole comment block exists to pay once. When the
    // medium has the slot the mist simply stays dormant — the far field is
    // still served, by the medium's own replication of `scene.fog`.
    if (this._fogNode || scene.fogNode != null || engine.renderer?.backend?.isWebGPUBackend !== true) return;
    this._fogNode = createHeightFog();
    scene.fogNode = this._fogNode.node;
  }

  // ── the frame ─────────────────────────────────────────────────────────────

  update(force = false) {
    if (!this._alive || !this.root) return;
    const engine = this.entity.engine;
    this.reconcileEnabled();
    if (!this.enabled) return;
    this.root.visible = true;
    if (engine.simulationSuspended === true && !force) return;

    const dt = Math.min(0.25, Math.max(0, Number(engine.deltaTime) || 0));
    const gameHours = this._advanceClock(dt, engine);
    const props = this.props;

    const celestial = celestialState({
      hour: props.timeOfDay,
      dayOfYear: props.dayOfYear,
      latitude: props.latitude,
      northOffset: props.northOffset,
    });
    this.celestial = celestial;

    this._stepWeather(dt, gameHours, celestial);

    // The model — cheap enough to run every frame, which is what keeps the
    // light and the fog moving smoothly between texture refreshes.
    const parameters = skyParameters({
      sunDirection: celestial.sun.direction,
      moonDirection: celestial.moon.direction,
      moonIllumination: celestial.moon.illumination,
      weather: this.conditions,
      nightLight: props.nightLight,
      intensity: props.skyIntensity,
    });
    measureSky(parameters);
    this.parameters = parameters;
    const light = celestialLight(parameters);
    this.light = light;

    // ⛔⛔ THE ROOF CAPTURE IS WARMED HERE, AND NEITHER AT ATTACH NOR ON DEMAND.
    //
    // ON DEMAND is what the user felt: compiling every variant of the height
    // material on the first frame that needed an answer is "when switching
    // to/from rain/snow, editor freezes".
    //
    // AT ATTACH is worse in a different way. `compileAsync` records a work
    // item per draw synchronously and then awaits them one at a time — and
    // during a scene load the objects behind those items are still being
    // created and destroyed, so by the time it reaches one its binding buffer
    // is gone: "Failed to execute 'writeBuffer': parameter 1 is not of type
    // 'GPUBuffer'" at `Bindings.updateForRender`, thrown out of three's own
    // async loop where our `.catch` cannot see it.
    //
    // A couple of seconds of frames is long past both: the scene has settled,
    // and it is still minutes before anyone changes the weather.
    if (this._warmClock !== null) {
      this._warmClock += dt;
      if (this._warmClock > 2.5) {
        this._warmClock = null;
        if (this.props.sheltered !== false) this.skyOcclusion.warm(engine);
      }
    }
    this._stepLightning(dt, engine);
    this._refreshSky(parameters, force);
    this._applySky(engine, parameters, celestial, light);
    this._applySun(engine, light);
    this._applyFog(engine, parameters, dt);
    this._applyWind(engine, dt);
    this._applyPrecipitation(engine, dt, parameters);
    this._applySurfaces(engine, dt, parameters);
    this._applyOcclusion(engine, dt);
    this._applyAmbient(engine, parameters);
    this._writeStats(celestial, light);
  }

  /** Advances the clock, returning the GAME hours that passed this frame. */
  _advanceClock(dt, engine) {
    const dayLength = Math.max(0, Number(this.props.dayLength) || 0);
    if (dayLength <= 0 || dt <= 0) { this._sunAngularRate = 0; if (engine) engine.sunAngularRate = 0; return 0; }
    // §edit-freeze (2026-09-10): the day/night clock is a SIMULATION — it
    // advances in PLAY mode, and in the editor only when the `Run In Editor`
    // toggle is on (default off; see Component `shouldAnimate`). A running
    // clock moves the sun every frame, and a fast one (dayLength 1 min → the
    // sun sweeps ~6°/s) forces GI to re-transport the whole field and re-render
    // the 4-cascade CSM shadow EVERY frame (the "30 fps with GI on"), and
    // silently drifts the scene into night. Frozen, the authored `timeOfDay`
    // holds — scrub the Time slider or press Play to run the cycle.
    // `__atmosphereClockInEditor = true` forces it always-on for an A/B.
    if (!this.shouldAnimate && globalThis.__atmosphereClockInEditor !== true) {
      this._sunAngularRate = 0;
      if (engine) engine.sunAngularRate = 0;
      return 0;
    }
    // §sun-shadow-hz: the sun's angular rate (deg/sec) while the clock is
    // actually running — 360° per `dayLength` minutes, i.e. per `dayLength *
    // 60` seconds. `_applySun` uses it to size its light-hold step; it is
    // also republished on `engine.sunAngularRate` (0 whenever this function
    // returns 0 above) so GISystem can size `GI_SUN_DIR_STEP` the same way
    // without importing this component.
    this._sunAngularRate = 360 / (dayLength * 60);
    if (engine) engine.sunAngularRate = this._sunAngularRate;
    const hours = dt * (24 / (dayLength * 60));
    // ⚠ Written straight onto `props`, not through `setProp`. A clock that
    // emitted a property change every frame would put the whole editor —
    // twenty scene-walking listeners of `component-changed` — on the frame
    // path. The live value is published through `state` instead, which is
    // what the inspector and MCP read.
    let time = (Number(this.props.timeOfDay) || 0) + hours;
    let day = Number(this.props.dayOfYear) || 1;
    while (time >= 24) { time -= 24; day += 1; }
    while (day > 365) day -= 365;
    this.props.timeOfDay = time;
    this.props.dayOfYear = day;
    return hours;
  }

  _stepWeather(dt, gameHours, celestial) {
    const props = this.props;
    const auto = props.weather === "auto";
    let temperature = airTemperature({
      dayOfYear: props.dayOfYear, hour: props.timeOfDay, latitude: props.latitude,
      climate: props.climate, cloudCover: this.conditions.cloudCover,
      precipitation: this.conditions.rain + this.conditions.snow,
    });
    this.temperature = temperature;

    // ⭐ WEATHER TIME, WHICH IS NOT THE CLOCK. A frozen clock (`dayLength: 0`,
    // the default) must not freeze the weather too, or "auto" would sit on its
    // first roll forever and snow would never settle. One game hour per real
    // minute is the fallback, and it is what makes accumulation visible: six
    // centimetres of snow — a white world — arrives in about twenty seconds of
    // watching rather than in twenty minutes.
    const weatherHours = gameHours > 0 ? gameHours : (dt / 60) * FROZEN_WEATHER_RATE;
    if (auto) {
      const hours = weatherHours;
      this._auto.changed = false;
      stepAutoWeather(this._auto, hours, {
        seed: props.seed, temperature, seasonPhase: celestial.seasonPhase, hour: props.timeOfDay,
      });
    }
    const wanted = auto ? this._auto.current : props.weather;
    if (wanted !== this._targetName) {
      this._from = { ...this.conditions };
      this._targetName = wanted;
      this._blend = 0;
      this.emit("weather-changed", { weather: wanted, previous: this._auto.previous ?? null });
      this.entity?.engine?.emit?.("atmosphere-weather", { entityId: this.entity.id, weather: wanted });
    }

    const target = scaleWeather(weatherPreset(this._targetName), props.weatherIntensity);
    // ⚠ SCALED ON THE TARGET, BEFORE THE BLEND, so a wind change eases in over
    // the same transition as everything else instead of snapping — and so the
    // ONE number every consumer reads (`conditions.wind`) is already the
    // authored one. Scaling at the seam instead would leave the sky's cloud
    // drift, the rain's slant and the cloth's wind disagreeing about it.
    // ⚠ AND THE RANGE HAS TO REACH SOMETHING. At 0…3 the dial's ceiling on a
    // CLEAR day was 1.6 x 3 = 4.8 m/s — a light breeze, which is why the user
    // read maximum wind as "almost does not affect the scene". Clear weather is
    // genuinely calm and the preset is right; it is the multiplier that has to
    // span far enough to make a blue-sky gale reachable, so it runs to 8. The
    // product is capped at a real storm rather than at nothing: 8 x storm's
    // 12 m/s would be 96, which is not weather.
    const windScale = Math.max(0, Number.isFinite(+props.windSpeed) ? +props.windSpeed : 1);
    const gustScale = Math.max(0, Number.isFinite(+props.gustiness) ? +props.gustiness : 1);
    target.wind = Math.min(WIND_CEILING, target.wind * windScale);
    target.gust = Math.min(WIND_CEILING, target.gust * windScale * gustScale);
    const seconds = Math.max(0, Number(props.transition) || 0);
    this._blend = seconds <= 0 ? 1 : Math.min(1, this._blend + dt / seconds);
    this.conditions = blendWeather(this._from, target, ease(this._blend));

    // ⭐ WHO DECIDES RAIN VERSUS SNOW.
    //
    // On "auto" the thermometer does, which is what makes a season feel like
    // one. But when an author (or a script, or an MCP call) NAMES a weather,
    // that name is an intent and it wins: picking "snow" in a scene whose
    // default day is a June afternoon at 45° N used to hand back rain, which
    // is the single most confusing thing this module did.
    //
    // The temperature then follows the weather rather than the other way
    // round — if snow is falling the air is at or below freezing — so the
    // read-out, the accumulation and the melt all stay coherent.
    if (auto) {
      applyThermalPhase(this.conditions, temperature);
    } else if (this.conditions.snow + this.conditions.rain > 0.001) {
      temperature = this.conditions.snow >= this.conditions.rain
        ? Math.min(temperature, -1)
        : Math.max(temperature, 2);
      this.temperature = temperature;
    }

    stepAccumulation(this.accumulation, weatherHours, {
      rain: this.conditions.rain, snow: this.conditions.snow, temperature, sunLight: this.conditions.sunLight,
    });
  }

  // ── sky ───────────────────────────────────────────────────────────────────

  /**
   * Starts a texture refresh when the sky has actually changed, and keeps a
   * running one moving. Everything about this is a throttle: the cost is
   * ~1.5 ms of CPU per full refresh and the whole point is that it never
   * lands inside one frame.
   */
  _refreshSky(parameters, force) {
    const now = performance.now();
    if (this._fillRow < SKY_HEIGHT) {
      // A quickly moving sun earns a bigger slice: the refresh then completes in
      // two frames rather than four, and the sky keeps up with the clock.
      const rows = this._fillFast ? SKY_SLICE_FAST : SKY_SLICE;
      fillSkyEquirect(this.skyData, SKY_WIDTH, SKY_HEIGHT, this._fillParams, {
        rowStart: this._fillRow, rowCount: rows,
      });
      this._fillRow += rows;
      if (this._fillRow >= SKY_HEIGHT) {
        this._publishSky(this._fillParams, now);
        this._maybeRebuildEnvironment(now);
      }
      return;
    }
    // Every idle frame too: a small change is flushed only once it has STOPPED,
    // and stopping is exactly the frame on which nothing publishes.
    this._maybeRebuildEnvironment(now);
    _direction.fromArray(parameters.sunDirection);
    const moved = _direction.angleTo(this._lastFillSun);
    // How fast the sun is actually travelling, in radians per second — 0 when
    // the clock is frozen, ~0.26 rad/s at one day per real minute.
    const speed = moved / Math.max(1e-3, (now - this._lastFill) / 1000);
    let changed = 0;
    if (this._lastFillWeather) {
      for (const key of Object.keys(this.conditions)) {
        changed += Math.abs(this.conditions[key] - this._lastFillWeather[key]) / (key === "turbidity" || key === "wind" || key === "gust" ? 10 : 1);
      }
    } else changed = Infinity;
    // ⭐ AND THE SECOND GATE IS THE SKY'S OWN COLOUR, not the sun's angle.
    // Around noon a degree of sun buys almost no change in the dome, and at
    // dusk a tenth of one repaints it — so the angular epsilon alone is either
    // wasteful or a staircase depending on the hour. `measureSky` has already
    // computed the irradiance and the horizon colour THIS FRAME (~20 µs), so
    // the honest question is free to ask: has the picture moved?
    const published = this._lastPublished;
    let drift = Infinity;
    if (published) {
      drift = 0;
      for (let c = 0; c < 3; c++) {
        drift += Math.abs(parameters.irradiance[c] - published.irradiance[c]) / Math.max(0.02, published.irradiance[c]);
        drift += Math.abs(parameters.horizon[c] - published.horizon[c]) / Math.max(0.02, published.horizon[c]);
      }
      drift /= 6;
    }
    const stale = moved > SKY_SUN_EPSILON || drift > SKY_COLOUR_EPSILON
      || changed > SKY_WEATHER_EPSILON || this._skyDirty;
    // ⛔ NO WALL-CLOCK COOLDOWN. A fixed 180 ms floor between refreshes is
    // invisible on a frozen clock and a staircase on a fast one: at one day per
    // real minute the sun moves 15°/s, so the sky was being redrawn every 2.7°
    // of it — the user's "time of day update is not smooth, update is jumps".
    // The SLICING is the pacing mechanism already (a refresh occupies several
    // frames at a fixed cost each), so the only gate needed is whether the sky
    // has actually changed.
    if (!force && !stale) return;

    this._skyDirty = false;
    this._fillFast = speed > 0.02;                    // ~1°/s and up
    this._fillParams = parameters;
    this._lastFillSun.copy(_direction);
    this._lastFillWeather = { ...this.conditions };
    if (force) {
      // The first frame, and every explicit edit: a sliced fill would show a
      // banded sky for four frames.
      fillSkyEquirect(this.skyData, SKY_WIDTH, SKY_HEIGHT, parameters);
      this._fillRow = SKY_HEIGHT;
      this._publishSky(parameters, now);
      this._maybeRebuildEnvironment(now);
    } else {
      this._fillRow = 0;
    }
  }

  /**
   * Hands a finished sky to everything that reads one.
   *
   * ⛔⛔ `needsPMREMUpdate` IS NOT A FLAG, IT IS EIGHT NESTED RENDERS. Setting
   * it bumps `texture.pmremVersion`, and the next time any material's
   * `PMREMNode.updateBefore` runs — INSIDE the frame, inside an open render
   * pass — it calls `PMREMGenerator.fromEquirectangular`, which issues a
   * `setRenderTarget` + `renderer.render` per mip of the prefiltered chain.
   * Asking for that on every completed refresh, with a clock running, is a
   * re-entrant render several times a second: the sky and then the meshes drop
   * out of the frame while their pipelines are re-created, which is exactly
   * the "everything blinks bright and dark once post-processing is on" the
   * user reported three times. The picture does not need it — the background
   * samples the equirect directly — so only the IBL waits, and a second and a
   * bit of lag on image-based lighting is invisible.
   *
   * (With GI enabled this is inert anyway: GI installs a black
   * `scene.environmentNode` so no material carries a PMREM node at all. It
   * bites exactly the scenes that have no GI to hide it.)
   */
  _publishSky(parameters, now) {
    this.skyTexture.needsUpdate = true;
    this._lastFill = now;
    // `irradiance` / `horizon` are what `_refreshSky`'s colour gate reads.
    this._lastPublished = skySnapshot(parameters);
  }

  /**
   * ⭐ THE IBL FOLLOWS THE SKY, NOT A TIMER (2026-09-14). It was rebuilt every
   * 1.2 s whenever a dome refresh had landed — i.e. continuously under a
   * running clock, for changes the prefiltered lighting cannot show. Now it is
   * compared with the sky it was last BUILT from (`skyPmremDue`): a perceptual
   * change rebuilds (still ≥ 1.2 s apart), a small one is flushed once it has
   * stopped, and an unchanged sky — a paused clock — never rebuilds after the
   * first. Only WHEN changes; `needsPMREMUpdate` is still the one trigger.
   * Called only with no fill in flight, so the GPU texture is `_lastPublished`.
   */
  _maybeRebuildEnvironment(now) {
    const current = this._lastPublished;
    if (!current || !this.skyTexture) return;
    const due = skyPmremDue({
      baseline: this._pmremBaseline,
      current,
      secondsSincePmrem: (now - this._lastPmrem) / 1000,
      secondsSincePublish: (now - this._lastFill) / 1000,
      clockRunning: (this._sunAngularRate ?? 0) > 0,
    });
    if (!due) return;
    this._lastPmrem = now;
    this._pmremBaseline = current;
    this.skyTexture.needsPMREMUpdate = true;
  }

  _applySky(engine, parameters, celestial, light) {
    const scene = engine.scene;
    if (!scene) return;
    const u = this.uniforms;
    if (!this.props.sky) {
      this._restoreSceneState(engine, "sky");
      return;
    }
    if (scene.backgroundNode !== this._backgroundNode) scene.backgroundNode = this._backgroundNode;
    if (scene.environment !== this.skyTexture) scene.environment = this.skyTexture;
    // The map is already in light units; the flash rides on the intensity so a
    // strike lifts the image-based light without re-integrating the map.
    scene.environmentIntensity = 1 + this._flash * 1.5;
    scene.backgroundIntensity = 1;
    scene.backgroundBlurriness = 0;
    scene.environmentRotation?.set(0, 0, 0);
    scene.backgroundRotation?.set(0, 0, 0);

    u.sunDirection.value.fromArray(parameters.sunDirection);
    u.moonDirection.value.fromArray(parameters.moonDirection);
    // The disc is the sun's own colour, lifted well past 1 so it clips to
    // white through the tone mapper the way the real one does — and dimming
    // and reddening on its own at sunset because the transmittance already has.
    const beam = 2 + 12 * Math.max(0, light.sunIntensity);
    u.sunDisc.value.setRGB(light.color[0] * beam, light.color[1] * beam, light.color[2] * beam)
      .multiplyScalar(clamp01(parameters.sunY * 12 + 0.4));
    const moonGlow = (0.25 + 2.2 * parameters.moonTerm) * clamp01(1 - parameters.dayWeight * 1.4);
    u.moonDisc.value.setRGB(0.9 * moonGlow, 0.94 * moonGlow, 1.0 * moonGlow);

    // Stars turn about the celestial pole, which sits at the observer's own
    // latitude due north — that is why the sky spins about Polaris at 50° and
    // straight overhead at the pole.
    const poleAltitude = THREE.MathUtils.degToRad(celestial.latitude);
    const poleAzimuth = THREE.MathUtils.degToRad(celestial.northOffset);
    u.starAxis.value.set(
      Math.cos(poleAltitude) * Math.sin(poleAzimuth),
      Math.sin(poleAltitude),
      -Math.cos(poleAltitude) * Math.cos(poleAzimuth),
    ).normalize();
    u.starAngle.value = THREE.MathUtils.degToRad(celestial.siderealAngle);
    u.starIntensity.value = this.props.stars
      ? clamp01(1 - parameters.dayWeight * 1.6) * clamp01(1 - parameters.cloudOpacity * 0.9) * 0.8
      : 0;

    const clouds = this.props.clouds;
    u.cloudCoverage.value = clouds ? this.conditions.cloudCover : 0;
    u.cloudDensity.value = this.conditions.cloudDensity;
    u.cirrus.value = clouds ? this.conditions.cirrus : 0;
    // ⚠ THROUGH THE SAME GAIN THE TEXTURE WENT THROUGH. `cloudLight` is the
    // model's raw value; the dome the shader samples was written at `gain`.
    // Handing the shader the ungained colour makes the painted clouds and the
    // analytic overcast disagree by up to 4×, which reads as clouds that are
    // lit by a different sun from the sky behind them.
    const gain = parameters.gain ?? 1;
    const lit = parameters.cloudLight;
    u.cloudLight.value.setRGB(lit[0] * gain, lit[1] * gain, lit[2] * gain);
    // The underside, which is what a viewer on the ground mostly sees. Tied to
    // the deck's own lit colour so it darkens with the same weather.
    const shade = 0.34 - 0.2 * this.conditions.cloudDensity;
    u.cloudShadow.value.setRGB(
      lit[0] * gain * shade + parameters.horizon[0] * 0.25,
      lit[1] * gain * shade + parameters.horizon[1] * 0.25,
      lit[2] * gain * shade + parameters.horizon[2] * 0.3,
    );
    u.cloudOffset.value.copy(this._cloudDrift);
    u.cirrusOffset.value.copy(this._cirrusDrift);
    // The shadow on the ground reads the same field, at the same offset, with
    // the same threshold — see `cloudShadow.js`.
    const shadowU = this.cloudShadowUniforms;
    shadowU.coverage.value = clouds ? this.conditions.cloudCover : 0;
    shadowU.density.value = this.conditions.cloudDensity;
    shadowU.scale.value = u.cloudScale.value;
    shadowU.offset.value.copy(this._cloudDrift);
    shadowU.sunDirection.value.fromArray(parameters.sunDirection);
    // Softened at a low sun (the shadows are stretched to nothing anyway) and
    // faded out entirely at night, where there is no sun to occlude.
    shadowU.strength.value = this.props.cloudShadows && clouds
      ? 0.9 * clamp01(parameters.sunY * 6)
      : 0;
    u.flash.value = this._flash;
    u.exposure.value = 1;
  }

  // ── sun ───────────────────────────────────────────────────────────────────

  /**
   * The light this aims, in priority order: the authored one, then the scene's
   * first directional light, then one of its own. The fallback matters: an
   * Atmosphere dropped into an empty scene should light it, not report that it
   * cannot find anything to light it with.
   */
  _resolveSun(engine) {
    if (this._sun?.light && this._sun.alive?.()) return this._sun;
    const fromEntity = (entity) => {
      const component = entity?.getComponent?.("light");
      if (!component || component.props?.kind !== "directional" || !component.light) return null;
      return {
        entity, component, light: component.light, source: entity.name || entity.id,
        alive: () => component._alive !== false && component.light?.parent,
      };
    };
    if (this.props.sun) {
      const found = fromEntity(engine.getEntity?.(this.props.sun));
      if (found) return (this._sun = found);
    }
    for (const entity of engine.entities?.values?.() ?? []) {
      const found = fromEntity(entity);
      if (found) return (this._sun = found);
    }
    return (this._sun = this._makeOwnedSun());
  }

  /** A directional light of our own, for a scene that brought none. */
  _makeOwnedSun() {
    if (!this._ownedSun) {
      const light = new THREE.DirectionalLight(0xffffff, 0);
      light.name = "Atmosphere Sun";
      // So the postprocessing module's god rays can find it: that search walks
      // entities' LightComponents, and this light deliberately has neither.
      light.userData.atmosphereOwned = true;
      light.castShadow = true;
      light.shadow.mapSize.set(OWNED_SUN_MAP, OWNED_SUN_MAP);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 260;
      light.shadow.camera.left = light.shadow.camera.bottom = -OWNED_SUN_HALF;
      light.shadow.camera.right = light.shadow.camera.top = OWNED_SUN_HALF;
      // ⚠ `LightShadow.updateMatrices` never calls this — it only moves the
      // camera. Without it the frustum stays at three's default ±5 m and the
      // owned sun casts shadows inside a ten-metre box at the world origin.
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.bias = -0.0006;
      light.shadow.normalBias = 0.02;
      this.root.add(light, light.target);
      this._ownedSun = {
        light,
        dispose: () => { light.dispose?.(); light.removeFromParent(); light.target.removeFromParent(); },
      };
    }
    return {
      entity: null, component: null, light: this._ownedSun.light, source: "owned",
      alive: () => !!this._ownedSun,
    };
  }

  /**
   * ⭐ THE CLOUD THAT IS IN FRONT OF THE SUN, RIGHT NOW.
   *
   * `sunLight` in the weather vector is an AVERAGE — how much sun a sky of this
   * kind passes. What a sky actually does is pass all of it and then none of
   * it, as the deck drifts: the light drops, the shadows soften and vanish,
   * and a minute later everything comes back. That single dynamic is most of
   * what makes a real sky feel alive, and it costs one CPU evaluation of the
   * cloud field per frame — at the point where the sun's own ray leaves the
   * deck above the camera, so the dimming agrees with the cloud you can see.
   */
  _sunOcclusion(engine) {
    // ⛔ NEVER BOTH. When the spatial shadow is installed the cloud is already
    // attenuating this light per pixel; dimming the whole light as well would
    // darken the sunlit ground by the same factor twice.
    if (this._cloudShadowMode === "spatial") return 0;
    if (!this.props.clouds || this.conditions.cloudCover <= 0.02) return 0;
    // ⚠ `light.direction` points TOWARDS the body, not along the light's travel.
    const direction = this.light?.direction;
    const height = direction ? direction[1] : 0;
    if (!(height > 0.06)) return 0;                     // sun too low to matter
    const camera = engine.camera;
    if (camera) camera.getWorldPosition(_cameraPosition); else _cameraPosition.set(0, 0, 0);
    // Where the ray from the camera towards the sun crosses the cloud base —
    // the same world point, and the same uv, the background shader uses.
    const distance = Math.max(0, CLOUD_BASE - _cameraPosition.y) / height;
    const scale = this.uniforms.cloudScale.value;
    const u = (_cameraPosition.x + direction[0] * distance) * scale + this._cloudDrift.x;
    const v = (_cameraPosition.z + direction[2] * distance) * scale + this._cloudDrift.y;
    return cloudOpacityAt(u, v, this.conditions.cloudCover, this.conditions.cloudDensity);
  }

  _applySun(engine, light) {
    const sun = this._resolveSun(engine);
    if (!sun?.light) return;
    // Eased, because the field is sampled at a point and the sun's disc is not
    // one: a hard step as an edge crosses would read as a flicker.
    const occlusion = this._sunOcclusion(engine);
    this._sunShade += (occlusion - this._sunShade) * Math.min(1, (engine.deltaTime ?? 0.016) * 2.5);
    const intensity = light.intensity * Math.max(0, Number(this.props.sunIntensity) || 0)
      * (1 - 0.82 * clamp01(this._sunShade))
      + this._flash * 6;
    _direction.fromArray(light.direction);

    // ⭐⭐⭐ THE LIGHT IS WRITTEN IN STEPS, NOT EVERY FRAME — AND THIS IS THE
    // DIFFERENCE BETWEEN 45 fps AND 60 (2026-09-10).
    //
    // A running clock moves the sun continuously, so the naive code re-aimed
    // the directional light on EVERY frame. GI watches its lights for motion
    // and rebuilds the whole cascade chain when one moves: the user's live
    // `giHold.quietBreakers` read `lights: 101` over 100 frames — the field
    // never rested once, 17.6 ms of compute a frame, every frame, for a sun
    // that had turned two hundredths of a degree.
    //
    // So the sun is quantised. A quarter of a degree is far below what any
    // shadow or specular highlight can show — at one real minute per day it is
    // twenty-five updates a second, at twenty minutes a day it is one — and
    // between steps every downstream system is allowed to be still. The SKY
    // does not step with it: the disc, the sky colour, the fog and the cloud
    // light are uniforms written every frame from the same model, so what the
    // eye follows stays continuous while what the renderer rebuilds does not.
    const applied = this._sunApplied;
    const turned = applied.direction.lengthSq() === 0 ? Infinity : applied.direction.angleTo(_direction);
    const relit = Math.abs(intensity - applied.intensity) > Math.max(1e-4, applied.intensity * 0.01)
      || Math.abs(light.color[0] - applied.color[0]) > 0.004
      || Math.abs(light.color[1] - applied.color[1]) > 0.004
      || Math.abs(light.color[2] - applied.color[2]) > 0.004;
    // ⚠ VISIBILITY IS A LATCH WITH HYSTERESIS, not a comparison. `visible`
    // decides whether the light is in the render list at all, and the list is
    // hashed into three's node-builder cache key (`LightsNode.customCacheKey`
    // takes every light's id) — so one flip RE-MINTS EVERY MATERIAL IN THE
    // SCENE. A bare `intensity > 0.0005` chatters across dusk and across every
    // cloud edge, which is a whole-scene shader rebuild several times a second.
    const wantVisible = applied.visible ? intensity > 0.0002 : intensity > 0.002;
    // An OWNED light carries its own shadow frustum around the camera, so it
    // has one more reason to move that an entity light does not.
    // ⭐ TEXEL-SNAPPED, IN THE SHADOW CAMERA'S OWN BASIS (2026-09-14). The old
    // anchor re-centred on the RAW camera position after 4 m of drift, so every
    // recentre moved the 2048² map by a fraction of a texel (edges swam) and the
    // depth axis stayed continuous. Now the centre lives on a whole-texel grid
    // across the map and along the light — the same snap LightComponent uses —
    // and "drifted" means the snapped cell changed.
    let drifted = false;
    if (!sun.entity) {
      const camera = engine.camera;
      if (camera) camera.getWorldPosition(_snapCentre); else _snapCentre.set(0, 0, 0);
      ownedSunShadowCentre(_snapCentre, _direction);
      drifted = !(applied.anchor.distanceToSquared(_snapCentre) < 1e-10);
      if (drifted) applied.anchor.copy(_snapCentre);
    }
    // §smooth-sun / §sun-shadow-hz: `__atmosphereSmoothSun = false` is a flat
    // kill switch back to the old stepped light regardless of the clock.
    // Otherwise: a PARKED sun (`this._sunAngularRate === 0`, e.g. `dayLength:
    // 0` or `Run In Editor` off) keeps today's near-continuous
    // `SUN_SMOOTH_STEP` exactly. A RUNNING clock instead holds the light in a
    // step sized off its own angular rate so the shadow redraws at most
    // `SUN_SHADOW_HZ` times a second, clamped to a band too small to see as a
    // jump and too large to redraw needlessly.
    let dirHoldStep;
    if (globalThis.__atmosphereSmoothSun === false) {
      dirHoldStep = SUN_STEP;
    } else if (this._sunAngularRate > 0) {
      const stepDeg = Math.min(SUN_HOLD_MAX_DEG, Math.max(SUN_HOLD_MIN_DEG, this._sunAngularRate / SUN_SHADOW_HZ));
      dirHoldStep = stepDeg * SUN_DEG2RAD;
    } else {
      dirHoldStep = SUN_SMOOTH_STEP;
    }
    if (turned <= dirHoldStep && !relit && !drifted && wantVisible === applied.visible
      && applied.light === sun.light && applied.frames > 0) {
      this._sunSource = sun.source;
      this._sunIntensity = applied.intensity;
      return;
    }
    applied.direction.copy(_direction);
    applied.intensity = intensity;
    applied.color[0] = light.color[0];
    applied.color[1] = light.color[1];
    applied.color[2] = light.color[2];
    applied.visible = wantVisible;
    applied.light = sun.light;
    applied.frames++;

    sun.light.intensity = intensity;
    sun.light.color.setRGB(light.color[0], light.color[1], light.color[2]);

    if (sun.entity) {
      // A directional LightComponent derives its direction from the ENTITY's
      // rotation (-Z forward) and re-pins its own position every frame, so the
      // only correct way to aim it is to turn its entity.
      _quaternion.setFromUnitVectors(FORWARD, _direction.clone().negate().normalize());
      sun.entity.object3D.quaternion.copy(_quaternion);
    } else {
      // The owned light has no LightComponent to recentre its shadow, so it
      // follows the camera itself — otherwise its 90 m frustum stays at the
      // world origin and everything else is unshadowed. `applied.anchor` is
      // this frame's snapped centre (computed above for the drift test).
      sun.light.target.position.copy(applied.anchor);
      sun.light.position.copy(applied.anchor).addScaledVector(_direction, OWNED_SUN_REACH);
      sun.light.target.updateMatrixWorld(true);
      sun.light.updateMatrixWorld(true);
      sun.light.visible = wantVisible;
    }
    this._sunSource = sun.source;
    this._sunIntensity = intensity;

    // ⭐ SPATIAL CLOUD SHADOWS, folded into the sun's own shadow term. Installed
    // on the light the moment it is resolved — `AnalyticLightNode` caches the
    // composed shadow branch, so this cannot be deferred to when it starts to
    // cloud over.
    // ⛔ ONE ATTEMPT PER LIGHT, NOT ONE PER FRAME. `installCloudShadow` REFUSES
    // a light whose shadow node someone else owns — a GI-traced sun is the
    // common case, and the global CPU dimming covers it — and the refusal
    // leaves `_shadowedLight` null. Keying the retry on `_shadowedLight` meant
    // "still null, try again", every frame forever: the whole install path,
    // including its `light.dispatchEvent('dispose')`, ran sixty times a second
    // on a light that was never going to accept it. `_cloudShadowTried` is the
    // light the attempt was MADE on, so a refusal is remembered.
    if (this.props.cloudShadows && this._cloudShadowTried !== sun.light) {
      if (this._shadowedLight) removeCloudShadow(this._shadowedLight);
      this._cloudShadowTried = sun.light;
      this._shadowedLight = installCloudShadow(sun.light, this.cloudShadowUniforms) ? sun.light : null;
      // ⛔ AND THE MATERIALS HAVE TO BE REBUILT. The shadow term is compiled
      // into every material that receives this light, so a light installed
      // after they compiled changes a graph nothing reads — the shadows looked
      // completely inert until this line existed. One wave, at attach.
      if (this._shadowedLight) refreshSceneMaterials(engine.scene);
      // A GI-traced light keeps its own shadow node; the CPU-sampled global
      // dimming stands in for it (see `_sunOcclusion`).
      this._cloudShadowMode = this._shadowedLight ? "spatial" : "global";
    } else if (!this.props.cloudShadows && this._cloudShadowTried) {
      if (this._shadowedLight) {
        removeCloudShadow(this._shadowedLight);
        refreshSceneMaterials(engine.scene);
      }
      this._shadowedLight = null;
      this._cloudShadowTried = null;
      this._cloudShadowMode = "global";
    }
  }

  // ── fog, wind, precipitation, lightning ───────────────────────────────────

  _applyFog(engine, parameters, dt) {
    if (!this._fog || !this.props.fog) return;
    const colour = fogColor(parameters);
    this._fog.color.setRGB(colour[0], colour[1], colour[2]);
    // Tone-mapped: a fog colour brighter than the sky it stands in front of
    // would read as a white-out, so it is capped at the horizon it came from.
    this._fog.density = Math.max(0, this.conditions.fogDensity);
    this.uniforms.fogColor.value.copy(this._fog.color);
    // How much of the SKY the fog has eaten. `FogExp2`'s own factor over a
    // 250 m sight line: enough that the "fog" preset closes the horizon
    // completely while an overcast day only softens it.
    const optical = 1 - Math.exp(-((this._fog.density * 250) ** 2));

    // ── VALLEY MIST ───────────────────────────────────────────────────────
    // Uniform writes only — the node was installed at attach and never moves.
    let mistDensity = 0;
    const node = this._fogNode;
    if (node) {
      const props = this.props;
      if (props.heightFog) {
        // effective density = authored × (1 + the weather's mist channel) —
        // "fog" pools in the hollows, drizzle leaves a low haze after itself.
        mistDensity = clamp01(Number(props.heightFogDensity) || 0)
          * (1 + clamp01(this.conditions.mist ?? 0)) * MIST_DENSITY_SCALE;
        // Advected by the very wind the clouds ride, and INTEGRATED for the
        // same reason the rain's is (see `_applyPrecipitation`): a field fed
        // speed × clock jumps whenever the wind turns.
        const radians = THREE.MathUtils.degToRad(this._windAngle + props.northOffset);
        const speed = this.conditions.wind;
        // The wrap is a whole number of lattice tiles, so it is invisible.
        this._mistDrift.x = (this._mistDrift.x + Math.sin(radians) * speed * dt * MIST_NOISE_SCALE) % 10000;
        this._mistDrift.y = (this._mistDrift.y - Math.cos(radians) * speed * dt * MIST_NOISE_SCALE) % 10000;
        let base = Number(props.heightFogBase);
        if (!Number.isFinite(base)) base = this._waterBaseLevel(engine);
        updateHeightFog(node, {
          color: colour,
          exp2Density: this._fog.density,
          mistDensity,
          baseLevel: base,
          falloff: props.heightFogFalloff,
          noiseStrength: props.heightFogNoise,
          noiseScale: MIST_NOISE_SCALE,
          driftX: this._mistDrift.x,
          driftY: this._mistDrift.y,
        });
      } else {
        // Switched off: zero the mist, keep feeding the far field through.
        updateHeightFog(node, { color: colour, exp2Density: this._fog.density, mistDensity: 0 });
      }
    }
    // The horizon band swallows what the mist swallows too — a valley full of
    // mist under a crisp sky reads as the same cut-out fog once did.
    const mistOptical = 1 - Math.exp(-((mistDensity * 250) ** 2));
    this.uniforms.fogAmount.value = clamp01(1 - (1 - optical) * (1 - mistOptical));
  }

  /**
   * Where the mist pools when `heightFogBase` is "auto" (NaN): the first live
   * Water surface's level, else 0. A WorldComponent's water is a procedural
   * field, not a scalar — there is no level to read cheaply there.
   */
  _waterBaseLevel(engine) {
    for (const surface of engine.waterSurfaces ?? []) {
      if (surface?._alive === false || surface?.enabled === false) continue;
      const y = surface.entity?.object3D?.getWorldPosition?.(_cameraPosition)?.y;
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  _applyWind(engine, dt) {
    // The direction wanders under auto weather so a long session is not spent
    // in one fixed wind; an authored weather keeps the angle it was given.
    const authored = Number(this.props.windDirection) || 0;
    if (this.props.weather === "auto") {
      this._windAngle += Math.sin(performance.now() * 0.00003 + this.props.seed) * dt * 1.5;
      if (Math.abs(this._windAngle - authored) > 60) this._windAngle += (authored - this._windAngle) * dt * 0.05;
    } else {
      this._windAngle += (authored - this._windAngle) * Math.min(1, dt * 0.5);
    }
    // "Wind from" is a compass bearing, so the vector points the other way.
    const radians = THREE.MathUtils.degToRad(this._windAngle + this.props.northOffset);
    const speed = this.conditions.wind;
    const x = -Math.sin(radians) * speed;
    const z = Math.cos(radians) * speed;

    // Clouds and cirrus ride the same wind — at altitude, and faster.
    const scale = this.uniforms.cloudScale.value;
    this._cloudDrift.x -= x * dt * scale * 2.5;
    this._cloudDrift.y -= z * dt * scale * 2.5;
    this._cirrusDrift.x -= x * dt * scale * 3.4;
    this._cirrusDrift.y -= z * dt * scale * 3.4;

    if (!this.props.wind) return;
    // ⭐ ONE WIND IN THE SCENE (see `engine/vfx/clothWind.js`). Written as an
    // OVERRIDE rather than into `engine.settings.wind`, because the settings
    // object is what `serialize.js` saves: a weather system writing there
    // would bake a passing gust into the scene file.
    this._wind ??= { vector: [0, 0, 0], gust: 0, gustFrequency: 1 };
    this._wind.vector[0] = x;
    this._wind.vector[2] = z;
    this._wind.gust = this.conditions.gust;
    // Gustier weather gusts faster, between a long swell and a rattle.
    this._wind.gustFrequency = 0.25 + Math.min(1.2, this.conditions.gust * 0.12);
    engine.windOverride = this._wind;
  }

  _applyPrecipitation(engine, dt, parameters) {
    if (!this.layers) return;
    const on = this.props.precipitation;
    const rain = on ? clamp01(this.conditions.rain) : 0;
    const snow = on ? clamp01(this.conditions.snow) : 0;
    // ⚠ NO SHELTER RAY ANY MORE. The first cut fired one ray straight up from
    // the camera at 4 Hz and faded the WHOLE field when it hit something — so
    // standing in a doorway stopped the rain in the street outside. The
    // top-down height capture answers the same question PER DROP, and the
    // snow on the ground reads the very same texture (`skyOcclusion.js`).

    const windX = this._wind?.vector[0] ?? 0;
    const windZ = this._wind?.vector[2] ?? 0;
    for (const [kind, amount] of [["rain", rain], ["snow", snow]]) {
      const layer = this.layers[kind];
      layer.setAmount(amount);
      if (amount <= 0.001) continue;
      const u = layer.uniforms;
      // ⚠ THE WRAPS ARE FOR FLOAT32 PRECISION, and they are deliberately
      // small. A `fallen` of 10⁵ m resolves to 8 mm in a float uniform and the
      // rain starts to stutter; at 10⁴ it is 1 mm. Wrapping shifts the whole
      // field inside a box that already wraps, so nothing visible happens —
      // rain has no pattern to recognise.
      u.time.value = (u.time.value + dt) % 1000;
      // Integrated, never `speed × clock` — see the uniform's own note.
      u.fallen.value = (u.fallen.value + u.fallSpeed.value * dt) % 10000;
      u.drift.value.x = (u.drift.value.x + windX * dt) % 10000;
      u.drift.value.y = (u.drift.value.y + windZ * dt) % 10000;
      u.wind.value.set(windX, 0, windZ);
      // ⭐ THE SAME SUN AND THE SAME SKY THE REST OF THE SCENE IS USING.
      //
      // The first cut multiplied a fixed tint by a scalar built from the sky's
      // irradiance with a 0.35 FLOOR — so precipitation ignored the sun
      // entirely and never went below a third of full brightness. The user saw
      // both halves of that: "snow and rain do not react to lighting at all"
      // and "remain fully white even at night".
      u.sunDirection.value.fromArray(this.light.direction);
      // Published for anything that shades against the live sun without owning a
      // light reference (the grass sward's translucency term reads it).
      if (this.entity?.engine) this.entity.engine.sunDirection = this.light.direction;
      // What the sun is worth here, including the cloud in front of it and its
      // own colour — the same numbers the directional light was given.
      const beam = this._sunIntensity ?? this.light.intensity;
      u.sunLight.value.setRGB(
        this.light.color[0] * beam, this.light.color[1] * beam, this.light.color[2] * beam,
      );
      // The sky's irradiance is what falls on a horizontal surface; a drop is
      // lit from every direction at once, so it sees rather more of it.
      const ambient = parameters.irradiance;
      u.skyLight.value.setRGB(ambient[0] * 1.5, ambient[1] * 1.5, ambient[2] * 1.5);
      if (kind === "rain") {
        u.fallSpeed.value = 9 + 6 * amount;
        u.size.value.set(0.014 + 0.01 * amount, 0.45 + 0.9 * amount);
        u.opacity.value = 0.42;
        u.tint.value.setRGB(0.62, 0.68, 0.8);
        u.radius.value = 26;
        u.height.value = 32;
      } else {
        u.fallSpeed.value = 1.1 + 1.6 * amount;
        // ⚠ A 3 cm flake is sub-pixel at 15 m and reads as noise. Game
        // snowflakes are drawn far larger than life for the same reason the
        // sun's disc is — 8–16 cm is what actually looks like snow.
        const flake = 0.08 + 0.08 * amount;
        u.size.value.set(flake, flake);
        u.sway.value = 0.5 + 1.4 * Math.min(2, this.conditions.wind / 6);
        u.opacity.value = 0.8;
        u.tint.value.setRGB(0.92, 0.94, 1.0);
        u.radius.value = 22;
        u.height.value = 26;
      }
    }
  }

  /**
   * ⭐ THE SCENE'S AMBIENT LIGHT, FOLLOWING THE SKY.
   *
   * A scene's authored ambient is a constant, and a constant is the enemy of
   * mood: it lights a midnight blizzard exactly as brightly as a clear noon,
   * and every drop the storm makes in the sun and the sky is quietly filled
   * back in by it. So while the Atmosphere is driving, the ambient becomes what
   * the sky is actually doing — its colour AND its level, scaled against the
   * clear-noon reference so an authored intensity still means what it meant.
   *
   * The authored values are restored on detach: this is a loan, like the fog.
   */
  _applyAmbient(engine, parameters) {
    const ambient = engine.ambientLight;
    const saved = this._saved?.ambient;
    if (!ambient || !saved) return;
    if (!this.props.ambient) {
      this._restoreAmbient();
      return;
    }
    this._ambientDriven = true;
    const sky = parameters.irradiance;
    const level = 0.2126 * sky[0] + 0.7152 * sky[1] + 0.0722 * sky[2];
    // ~0.84 is a clear noon (see `SKY_CLEAR_FRACTION` in the model), so this
    // ratio is "how bright is this sky against the best day of the year".
    const relative = clamp01(level / 0.84);
    // The floor is what a player can still see by. Too low and a moonless night
    // is a black screen; the sky's own level carries the rest.
    ambient.intensity = saved.intensity * (0.12 + 0.88 * relative);
    const peak = Math.max(sky[0], sky[1], sky[2], 1e-4);
    ambient.color.setRGB(
      mixValue(saved.color.r, sky[0] / peak, 0.75),
      mixValue(saved.color.g, sky[1] / peak, 0.75),
      mixValue(saved.color.b, sky[2] / peak, 0.75),
    );
  }

  /**
   * ⭐ COMPILE THE RAIN BEFORE IT RAINS — by drawing one drop from the start.
   *
   * A precipitation layer draws nothing until the weather calls for it, so its
   * pipelines were created on the frame the first drop fell; the driver parses
   * WGSL on the calling thread, so that is a hitch exactly when the user is
   * watching for the change they just asked for (the ledger named
   * `renderPipeline_Atmosphere · snow ×4` inside that block).
   *
   * ⚠ AND NOT WITH `compileAsync`. The obvious fix was to warm the whole scene
   * asynchronously at attach; on the user's editor that produced
   * "[Buffer …] used in submit while destroyed" and failed async pipeline
   * creation, because an async walk of the scene races everything else that
   * touches it. ONE INSTANCE, drawn every frame at zero opacity, compiles the
   * same pipelines through the ordinary render path and costs a single
   * invisible quad.
   */
  _warmPrecipitation() {
    for (const layer of [this.layers?.rain, this.layers?.snow]) {
      if (layer) layer.warm();
    }
  }

  _restoreAmbient() {
    const ambient = this.entity?.engine?.ambientLight;
    const saved = this._saved?.ambient;
    if (!ambient || !saved || !this._ambientDriven) return;
    ambient.color.copy(saved.color);
    ambient.intensity = saved.intensity;
    this._ambientDriven = false;
  }

  /**
   * The world's own response to the weather: snow lying on it, rain darkening
   * it. Two uniform writes per frame — the materials were patched once at
   * attach (see `weatherSurface.js` for why that is not negotiable).
   */
  _applySurfaces(engine, dt, parameters) {
    const u = this.surfaceUniforms;
    if (!this.props.surfaces) {
      u.snow.value = 0;
      u.wetness.value = 0;
      return;
    }
    // 6 cm of settled snow is a fully white world; the accumulator (metres)
    // stays physical for anything that wants to ask how deep it actually is.
    //
    // ⭐ AND IT IS EASED, NOT ASSIGNED. The accumulator integrates GAME time, so
    // anything that makes a frame long — a compile wave, a scene load, dragging
    // the window — hands it a large step and the world turns white between two
    // frames ("they change drastically within one frame", user). A fixed time
    // constant here means the LOOK can only ever move at the speed it is
    // allowed to, however the simulation behind it jumps.
    const wantedSnow = clamp01(this.accumulation.snowDepth / 0.06);
    const wantedWet = clamp01(this.accumulation.wetness);
    const rate = Math.min(1, dt / SURFACE_EASE_SECONDS);
    u.snow.value += (wantedSnow - u.snow.value) * rate;
    u.wetness.value += (wantedWet - u.wetness.value) * rate;
    // Snow takes the colour of the sky that lights it — blue under a clear
    // noon, warm at sunset — which is what stops it reading as white paint.
    const horizon = parameters.horizon;
    const level = Math.max(1e-4, 0.2126 * horizon[0] + 0.7152 * horizon[1] + 0.0722 * horizon[2]);
    u.snowColor.value.setRGB(
      0.9 * mixValue(1, horizon[0] / level, 0.12),
      0.92 * mixValue(1, horizon[1] / level, 0.12),
      0.96 * mixValue(1, horizon[2] / level, 0.12),
    );
    // Materials arrive after the Atmosphere does — a model finishes loading, a
    // foliage layer builds its own, a merge produces a fresh one. Swept slowly
    // because a sweep that finds something new is a compile.
    // ⚠ SWEPT OFTEN ENOUGH THAT NOTHING POPS. Foliage, LOD and merging create
    // materials as the camera moves, and an unpatched one shows as bare ground
    // in the middle of a snowfield until the next sweep finds it — which reads
    // as the snow pattern changing in steps. A sweep that finds nothing is a
    // scene walk and a Set lookup.
    this._surfaceSweep -= dt;
    if (this._surfaceSweep <= 0) {
      this._surfaceSweep = 0.4;
      this._patchedMaterials = (this._patchedMaterials ?? 0) + applySurfaceWeather(engine.scene, u);
    }
  }

  /**
   * The top-down height capture that tells rain, snow and wet ground what is
   * over them. Rendered only when something actually needs the answer — in
   * fair weather with a still camera it never runs at all.
   */
  _applyOcclusion(engine, dt) {
    const falling = this.conditions.rain + this.conditions.snow;
    const lying = this.surfaceUniforms.snow.value + this.surfaceUniforms.wetness.value;
    const needed = this.props.sheltered !== false
      && ((this.props.precipitation && falling > 0.01) || (this.props.surfaces && lying > 0.01));
    this._occlusionRendered = this.skyOcclusion.update(engine, { dt, needed, hidden: this.root });
  }

  _stepLightning(dt, engine) {
    // The flash itself: a fast decay with a second, smaller return strike,
    // which is what makes it read as lightning rather than as a light switch.
    if (this._flash > 0) this._flash = Math.max(0, this._flash - dt * (2.2 + 6 * this._flash));
    const rate = this.props.lightning ? this.conditions.thunder : 0;
    if (rate <= 0) { this._nextStrike = Infinity; return; }
    if (!Number.isFinite(this._nextStrike)) this._nextStrike = this._strikeInterval(rate);
    this._nextStrike -= dt;
    if (this._nextStrike > 0) return;
    this._nextStrike = this._strikeInterval(rate);
    this.strike();
  }

  _strikeInterval(rate) {
    // Poisson: strikes do not arrive on a metronome.
    const random = this._auto.random ?? Math.random;
    return Math.max(0.35, (-Math.log(1 - random() * 0.999) * 60) / Math.max(0.01, rate));
  }

  // ── the public surface ────────────────────────────────────────────────────

  /** Fires a lightning strike now, wherever the weather is. */
  strike(strength = 1) {
    this._flash = Math.max(this._flash, clamp01(strength) * (0.7 + 0.3 * (this._auto.random?.() ?? 0.5)));
    // Distance decides the thunder's delay — 343 m/s — and a listener that
    // wants a boom needs it, because the flash is the only cue it will get.
    const distance = 300 + (this._auto.random?.() ?? 0.5) * 6000;
    const payload = {
      entityId: this.entity?.id ?? null,
      strength: this._flash,
      distance,
      thunderDelay: distance / 343,
    };
    this.emit("lightning", payload);
    this.entity?.engine?.emit?.("atmosphere-lightning", payload);
    return payload;
  }

  /** Crosses to a named weather (or "auto"), optionally over `transition` s. */
  setWeather(name, { transition } = {}) {
    if (name !== "auto" && !WEATHER_NAMES.includes(name)) {
      throw new Error(`Unknown weather "${name}". One of: auto, ${WEATHER_NAMES.join(", ")}.`);
    }
    if (transition != null) this.setProp("transition", Math.max(0, Number(transition) || 0));
    if (name === "auto") this._auto.elapsed = this._auto.dwell ?? 0;
    this.setProp("weather", name);
    return this.state;
  }

  /** Sets the clock. `hours` may be fractional; `day` is 1…365. */
  setTime(hours, day) {
    if (hours != null) this.setProp("timeOfDay", ((Number(hours) || 0) % 24 + 24) % 24);
    if (day != null) this.setProp("dayOfYear", clamp(Math.round(Number(day) || 1), 1, 365));
    return this.state;
  }

  _writeStats(celestial, light) {
    this._stats = {
      status: "Active",
      weather: this._targetName,
      blending: this._blend < 1,
      sunSource: this._sunSource ?? "none",
      skyRefreshing: this._fillRow < SKY_HEIGHT,
      heightFog: !this._fogNode
        ? (this.props.heightFog ? "dormant: scene.fogNode is in use" : "off")
        : (this.entity?.engine?.scene?.fogNode === this._fogNode.node ? (this.props.heightFog ? "on" : "ready") : "replaced"),
    };
  }

  /**
   * Everything a script, the inspector or an MCP tool wants to know — and the
   * only place the LIVE clock is readable, because the clock is written
   * straight onto props without a change event.
   */
  get state() {
    const celestial = this.celestial;
    const parameters = this.parameters;
    const light = this.light;
    return {
      status: this._stats.status,
      time: {
        timeOfDay: Number(this.props.timeOfDay) || 0,
        dayOfYear: Number(this.props.dayOfYear) || 1,
        season: celestial?.season ?? null,
        seasonPhase: celestial?.seasonPhase ?? 0,
        sunrise: celestial?.sunrise ?? null,
        sunset: celestial?.sunset ?? null,
        dayLength: celestial?.dayLength ?? 0,
        polar: celestial?.polar ?? null,
      },
      sun: celestial ? {
        altitude: celestial.sun.altitude,
        azimuth: celestial.sun.azimuth,
        direction: celestial.sun.direction,
      } : null,
      moon: celestial ? {
        altitude: celestial.moon.altitude,
        illumination: celestial.moon.illumination,
        phase: celestial.moon.phase,
      } : null,
      light: light ? {
        body: light.body,
        /** What the model asked for, before the cloud in front of it. */
        intensity: light.intensity,
        /** What the scene's light is actually set to. */
        applied: this._sunIntensity ?? light.intensity,
        cloudShade: this._sunShade,
        /** "spatial" = per-pixel shadows in the sun's own shadow term;
         *  "global" = the whole light dims (a GI-traced sun, or turned off). */
        cloudShadows: this._cloudShadowMode ?? "global",
        color: light.color,
        source: this._sunSource ?? "none",
      } : null,
      weather: {
        current: this._targetName,
        auto: this.props.weather === "auto",
        blend: this._blend,
        temperature: this.temperature ?? null,
        ...this.conditions,
      },
      accumulation: { ...this.accumulation },
      surfaces: {
        driving: !!this.props.surfaces,
        /** How many materials the weather has been folded into so far. A number
         *  that keeps climbing while nothing new is being created is churn. */
        materials: this._patchedMaterials ?? 0,
        snow: this.surfaceUniforms.snow.value,
        wetness: this.surfaceUniforms.wetness.value,
      },
      sky: parameters ? {
        irradiance: [...parameters.irradiance],
        horizon: [...parameters.horizon],
        cloudOpacity: parameters.cloudOpacity,
        refreshing: this._fillRow < SKY_HEIGHT,
      } : null,
      shelter: {
        /** Whether the top-down height capture is live this frame. */
        mapping: this.skyOcclusion.uniforms.strength.value > 0,
        captured: !!this._occlusionRendered,
      },
      lightning: { flash: this._flash, nextIn: Number.isFinite(this._nextStrike) ? this._nextStrike : null },
    };
  }

  get stats() { return { ...this._stats }; }
}
