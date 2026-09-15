import * as THREE from "three/webgpu";
import { isPortableDevice } from "../../engine/sceneSettings.js";
import * as TSL from "three/tsl";
import { generateCloudNoise } from "./cloudNoise.js";

/**
 * VOLUMETRIC CLOUD FOG — a post-process port of three's
 * `webgpu_postprocessing_fog` example (raymarched height fog against the
 * scene's depth buffer, denoised back to full resolution with a Joint
 * Bilateral Upsample — Kopf et al. 2007).
 *
 * Shape of the effect, in the order the GPU runs it:
 *
 *   1. A LOW-RES RTT (0.4x by default) marches N steps through a height slab
 *      [groundLevel, groundLevel + height], sampling a tiled 3D noise texture
 *      for density and accumulating Beer-Lambert extinction. The march is
 *      clipped to the scene depth, so geometry occludes fog for free.
 *   2. A DENOISER upsamples that buffer to full res. JBU weights each low-res
 *      tap by how close its depth is to the full-res pixel's, which is what
 *      keeps fog from bleeding across silhouettes; a plain Gaussian is offered
 *      for when the depth guide misbehaves, and "off" shows the raw buffer.
 *   3. The result is PREMULTIPLIED scattered light + coverage, composited as
 *      `scene * (1 - a) + rgb`.
 *
 * ⚠ WHY A SEPARATE MODULE AND NOT A `postGraph` CASE: this owns a 3D texture,
 * a worker and an RTT pass. `postGraph.js` loads it through the same lazy
 * `_addonLoaders` path as three's own addons, so a project whose graph has no
 * fog node never downloads any of it and never pays the noise generation.
 *
 * WHERE THIS DEPARTS FROM THE EXAMPLE, AND WHY:
 *
 * • IT SCATTERS LIGHT INSTEAD OF LERPING TO A COLOUR. three's example
 *   accumulates one scalar and mixes the frame toward a constant white, so the
 *   fog is the same colour everywhere no matter what the scene's lighting does
 *   (user, 2026-09-09: "fog does not react to light at all"). Here each step
 *   integrates single scattering — ambient plus sun, weighted by a
 *   Henyey-Greenstein phase and by a SHADOW MAP lookup — so the fog glows
 *   toward the sun, darkens away from it, and carries the shafts that make
 *   volumetric fog worth marching in the first place.
 *
 * • THE SKY IS EXCLUDED FROM THE DISTANCE TERM (see `hasSurface` below).
 *
 * TWO MORE THINGS THAT ARE NOT OBVIOUS:
 *
 * • THE CAMERA MATRICES MUST BE EXPLICIT UNIFORMS. Post effects run on a
 *   fullscreen quad drawn with the pipeline's own orthographic camera, so
 *   TSL's ambient `cameraProjectionMatrixInverse` / `cameraWorldMatrix` would
 *   describe THAT quad camera, not the one that rendered the scene — the ray
 *   would leave from the wrong place and the fog would look like a screen
 *   overlay. We bind the render camera's live matrix objects instead (three
 *   mutates them in place, so no per-frame copy is needed).
 *
 * • THE NOISE TEXTURE ARRIVES LATE, ON PURPOSE. Generating it costs 0.18 s
 *   (48^3) to 2.1 s (96^3) of straight-line JS. It is generated in a worker
 *   and uploaded when ready; until then the texture is zeros, which reads as
 *   "no fog" rather than as a stall. Textures are memoised per size for the
 *   session, so a pipeline rebuild (which happens on every structural post
 *   edit) never pays for it twice.
 */

// ---------------------------------------------------------------------------
// The 3D noise texture
// ---------------------------------------------------------------------------

/** size -> Data3DTexture, shared across compiles AND across cameras. */
const _noiseTextures = new Map();
/** Sizes whose generation already started (worker in flight or finished). */
const _noiseRequested = new Set();

/**
 * The tiling density field. Returns immediately with a zero-filled texture and
 * fills it in from a worker.
 *
 * @param {number} size Edge length (48 / 64 / 96 in the node's UI).
 * @returns {THREE.Data3DTexture}
 */
export function cloudNoiseTexture(size = 64) {
  let texture = _noiseTextures.get(size);
  if (!texture) {
    const data = new Uint8Array(size * size * size);
    texture = new THREE.Data3DTexture(data, size, size, size);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // The march samples the field far outside [0,1]^3 (world position x scale),
    // so all three axes have to wrap or the fog ends at a hard edge.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.wrapR = THREE.RepeatWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    _noiseTextures.set(size, texture);
  }

  if (!_noiseRequested.has(size)) {
    _noiseRequested.add(size);
    _fillNoiseTexture(size, texture);
  }

  return texture;
}

function _fillNoiseTexture(size, texture) {
  const adopt = (data) => {
    texture.image.data.set(data);
    texture.needsUpdate = true;
  };

  // No Worker constructor means we are not in a browser (node --test, an SSR
  // pass). Do NOT generate synchronously there: the caller is a unit test that
  // wants a compiled graph, not a density field, and 2 s of blocking noise is
  // the wrong default for a headless import. Fog compiles flat.
  if (typeof Worker !== "function") {
    _noiseRequested.delete(size);
    return;
  }

  let worker;
  try {
    worker = new Worker(new URL("./cloudNoiseWorker.js", import.meta.url), { type: "module" });
  } catch (err) {
    // A build that cannot spawn module workers still deserves fog: eat the
    // one-time hitch rather than silently rendering nothing. This path is not
    // expected in Chromium/WebView2 — it exists so a packaging change degrades
    // to "slow once" instead of "the effect does nothing and says nothing".
    console.warn(
      `[volumetricFog] cloud-noise worker unavailable (${err?.message ?? err}) — generating ${size}^3 on the main thread.`,
    );
    adopt(generateCloudNoise(size));
    return;
  }

  worker.onmessage = (event) => {
    const { data, error } = event.data ?? {};
    if (error) console.warn(`[volumetricFog] cloud-noise generation failed: ${error}`);
    else if (data) adopt(data);
    worker.terminate();
  };
  worker.onerror = (event) => {
    console.warn(`[volumetricFog] cloud-noise worker error: ${event?.message ?? event}`);
    worker.terminate();
    _noiseRequested.delete(size);
  };
  worker.postMessage({ size });
}

/** Drops the cached fields. Used when the renderer is rebuilt. */
export function disposeCloudNoise() {
  for (const texture of _noiseTextures.values()) texture.dispose();
  _noiseTextures.clear();
  _noiseRequested.clear();
}

// ---------------------------------------------------------------------------
// The effect
// ---------------------------------------------------------------------------

const DENOISER_MODES = new Set(["jbu", "gaussian", "off"]);

/** Defaults live here so `setParams` and the first build cannot disagree. */
export const VOLUMETRIC_FOG_DEFAULTS = {
  steps: 16,
  density: 1.05,
  heightFalloff: 1.2,
  height: 3.5,
  groundLevel: 0,
  cloudScale: 0.019,
  cloudThreshold: 0.66,
  cloudSpeed: 0.04,
  maxRayDist: 70,
  rangeFogNear: 62.5,
  rangeFogFar: 100,
  spatialSigma: 1.2,
  depthSensitivity: 30,
  blurRadius: 0.5,
  intensity: 1,
  color: "#ffffff",
  ambient: 1,
  sunScatter: 1.6,
  anisotropy: 0.6,
};

/** Henyey-Greenstein, normalised so g = 0 is 1 (isotropic), not 1/4pi.
 *
 * This is the whole reason fog "reacts to light": g > 0 peaks the scattering
 * in the direction the light is already travelling, so looking INTO the sun
 * through fog glows and looking away from it stays flat. At g = 0.6 the peak
 * is ~10x the isotropic value and the back side ~0.16x. */
const henyeyGreenstein = (cosTheta, g) => {
  const g2 = g.mul(g);
  const denom = g2.add(1.0).sub(g.mul(2.0).mul(cosTheta)).max(1e-4).pow(1.5);
  return g2.oneMinus().div(denom);
};

/**
 * Builds the fog for one graph node.
 *
 * @param {Object}   options
 * @param {Node}     options.colorNode     Scene colour (vec4).
 * @param {Node}     options.depthNode     Scene depth TEXTURE node — the JBU
 *                                         guide samples it at shifted uvs, so
 *                                         it must be samplable, not a float.
 * @param {THREE.Camera} options.camera    The camera that rendered the scene.
 * @param {Object}   options.params        Resolved node props.
 * @param {?THREE.Light} options.light     The scene's sun, when one was found:
 *                                         drives colour, direction and (if it
 *                                         has a shadow map) volumetric shafts.
 * @param {?Function} options.gaussianBlur three's `gaussianBlur` addon, when
 *                                         the graph loaded it (denoiser
 *                                         "gaussian"; null falls back to raw).
 * @returns {{ color: Node, fog: Node, setParams: Function, tick: Function, time: Node, passes: Node[] }}
 */
/**
 * "This pixel has geometry" for a raw depth sample: short of the cleared far
 * value, which is 1 normally and 0 under a reversed buffer. Exported for the
 * per-flag gate.
 */
export function fogSurfaceTest(depth, reversed) {
  return reversed ? depth.greaterThan(0.0001) : depth.lessThan(0.9999);
}

export function volumetricFog({ colorNode, depthNode, camera, params = {}, light = null, gaussianBlur = null }) {
  const P = { ...VOLUMETRIC_FOG_DEFAULTS, ...params };

  // Structural — baked into the compiled graph, changing one rebuilds.
  const resolutionScale = Math.min(1, Math.max(0.1, parseFloat(P.resolutionScale) || 0.4));
  const noiseSize = Math.min(128, Math.max(16, parseInt(P.noiseSize, 10) || 64));
  // The panel's <select> renders its option strings verbatim, so the stored
  // values are the labels ("JBU" / "Gaussian" / "Off"). Compare case-folded —
  // matching the raw string would quietly send every mode down the JBU branch.
  const requested = String(P.denoiser ?? "jbu").toLowerCase();
  const denoiser = DENOISER_MODES.has(requested) ? requested : "jbu";

  // Volumetric shadows need a 2D shadow map (directional / spot). A point
  // light's cube map would need the other sampling path god rays carries; it
  // is not worth a second code path here, so those lights light the fog
  // uniformly instead of casting shafts through it.
  const shadowLight =
    P.sunShadows !== false && light && !light.isPointLight && light.shadow?.map?.depthTexture ? light : null;
  const positionalLight = !!light && !light.isDirectionalLight;

  // Hot — every one of these is a live uniform, so the panel's sliders retune
  // the fog without re-minting the pipeline (a post rebuild also re-mints
  // every material that shares a program with the pass; see the component).
  const U = {
    steps: TSL.uniform(P.steps),
    density: TSL.uniform(P.density),
    heightFalloff: TSL.uniform(P.heightFalloff),
    height: TSL.uniform(P.height),
    groundLevel: TSL.uniform(P.groundLevel),
    cloudScale: TSL.uniform(P.cloudScale),
    cloudThreshold: TSL.uniform(P.cloudThreshold),
    cloudSpeed: TSL.uniform(P.cloudSpeed),
    maxRayDist: TSL.uniform(P.maxRayDist),
    rangeFogNear: TSL.uniform(P.rangeFogNear),
    rangeFogFar: TSL.uniform(P.rangeFogFar),
    spatialSigma: TSL.uniform(P.spatialSigma),
    depthSensitivity: TSL.uniform(P.depthSensitivity),
    blurRadius: TSL.uniform(P.blurRadius),
    intensity: TSL.uniform(P.intensity),
    fogColor: TSL.uniform(new THREE.Color().setStyle(P.color)),
    ambient: TSL.uniform(P.ambient),
    sunScatter: TSL.uniform(P.sunScatter),
    anisotropy: TSL.uniform(P.anisotropy),
    // The sun, refreshed every frame by `tick` — a rotating sun must move the
    // fog's glow without rebuilding the pipeline.
    sunColor: TSL.uniform(new THREE.Color(0, 0, 0)),
    sunDir: TSL.uniform(new THREE.Vector3(0, 1, 0)),
    sunPos: TSL.uniform(new THREE.Vector3(0, 0, 0)),
    // Accumulated by `tick` rather than read off TSL's global `time`, so that
    // dragging "Cloud Speed" retimes the drift instead of teleporting the
    // clouds (time x speed jumps when speed changes), and so the fog freezes
    // with the rest of the game when the engine is paused.
    cloudTime: TSL.uniform(0),
  };

  // See the header: the quad camera is not the scene camera.
  const camWorld = TSL.uniform(camera.matrixWorld);
  const projInv = TSL.uniform(camera.projectionMatrixInverse);

  const noiseTexture = cloudNoiseTexture(noiseSize);

  // --- density field -------------------------------------------------------

  const sampleCloudDensity = TSL.Fn(([pos]) => {
    const t = U.cloudTime;
    const p = TSL.vec3(pos.mul(U.cloudScale)).toVar();

    // Primary octave, drifting downwind.
    const wind1 = TSL.vec3(t.mul(0.3), t.mul(0.05), t.mul(0.2));
    const n1 = TSL.texture3D(noiseTexture, p.add(wind1)).r;

    // Second octave warped BY the first and drifting against it — the counter
    // current is what stops the field from sliding as one rigid block.
    const wind2 = TSL.vec3(t.negate().mul(0.15), t.mul(0.1), t.mul(0.08));
    const p2 = p.mul(2.2).add(TSL.vec3(1.7, 0.9, 2.5)).add(wind2).add(n1.mul(0.5));
    const n2 = TSL.texture3D(noiseTexture, p2).r.mul(0.5);

    const noise3D = n1.add(n2);

    // Height falloff in metres above the fog floor, not in noise units.
    const relHeight = pos.y.sub(U.groundLevel).div(U.height.max(0.01));
    const heightFactor = TSL.float(1.0).sub(relHeight).clamp(0.0, 1.0).pow(U.heightFalloff);

    // Thresholding is what turns a continuous field into distinct clouds.
    return noise3D.sub(U.cloudThreshold).max(0.0).mul(heightFactor);
  });

  // --- is this point in the sun? -------------------------------------------

  /**
   * 1 where the sun reaches the sample, 0 in shadow. This is what makes light
   * SHAFTS: without it a lit fog is uniformly bright and the beams that give
   * volumetric fog its whole character never appear.
   *
   * Sampling convention copied from `GodraysNode` — the same problem (a shadow
   * lookup from a post pass, where none of three's material-side shadow
   * plumbing is in scope). One deliberate difference: OUTSIDE the shadow
   * camera's frustum god rays return "occluded" (so rays stop at the edge of
   * the map); fog returns "lit", because a shadow camera that covers 50 m
   * would otherwise plunge everything beyond it into a hard dark wall.
   */
  const sunVisibility = (worldPos) => {
    if (!shadowLight) return TSL.float(1.0);
    const shadowPosition = TSL.lightShadowMatrix(shadowLight).mul(TSL.vec4(worldPos, 1.0));
    const coord = shadowPosition.xyz.div(shadowPosition.w);
    const shadowCoord = TSL.vec3(coord.x, coord.y.oneMinus(), coord.z).toConst();

    const inside = shadowCoord.x
      .greaterThanEqual(0)
      .and(shadowCoord.x.lessThanEqual(1))
      .and(shadowCoord.y.greaterThanEqual(0))
      .and(shadowCoord.y.lessThanEqual(1))
      .and(shadowCoord.z.greaterThanEqual(0))
      .and(shadowCoord.z.lessThanEqual(1));

    const lit = TSL.float(1.0).toVar();
    TSL.If(inside.equal(true), () => {
      lit.assign(TSL.texture(shadowLight.shadow.map.depthTexture, shadowCoord.xy).compare(shadowCoord.z).r);
    });
    return lit;
  };

  // --- the march (runs at `resolutionScale`) --------------------------------

  // Zero-parameter Fn: three calls it with the builder (TSLCore `jsFunc(builder)`).
  const fogPass = TSL.Fn((builder) => {
    const depth = depthNode.sample(TSL.screenUV).r;
    const viewPos = TSL.getViewPosition(TSL.screenUV, depth, projInv);
    const targetWorldPos = camWorld.mul(TSL.vec4(viewPos, 1.0)).xyz;

    // ⚠ THE CAMERA'S WORLD POSITION, NOT `camera.position`. In play mode the
    // active camera is a CHILD of its entity (`entity.object3D.add(camera)` in
    // CameraComponent), so `camera.position` is a local offset — usually
    // (0,0,0) — while the editor's viewport camera is a root object where the
    // two happen to agree. Binding the local one marched every ray from the
    // wrong origin the moment you pressed Play: the reported symptom was "the
    // floor is not in fog in play mode". Reading the translation column of the
    // world matrix is right under any parenting.
    const camPos = camWorld.mul(TSL.vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    const rayVector = targetWorldPos.sub(camPos);
    const surfaceDist = rayVector.length();
    const rayDir = rayVector.normalize();

    // Ray-slab against the fog layer, so steps are spent INSIDE the fog
    // instead of spread over the whole depth range. This is the difference
    // between 16 usable samples and 16 mostly-empty ones.
    const fogBottomY = U.groundLevel;
    const fogTopY = U.groundLevel.add(U.height);

    const dirY = rayDir.y.greaterThanEqual(0.0).select(rayDir.y.max(0.00001), rayDir.y.min(-0.00001));
    const t0 = fogBottomY.sub(camPos.y).div(dirY);
    const t1 = fogTopY.sub(camPos.y).div(dirY);

    const tNearSlab = t0.min(t1);
    const tFarSlab = t0.max(t1);

    const tStart = tNearSlab.max(0.0);
    const tEnd = tFarSlab.min(surfaceDist).min(tStart.add(U.maxRayDist));
    const marchDist = tEnd.sub(tStart).max(0.0);

    const stepSize = marchDist.div(TSL.float(U.steps));
    const stepVector = rayDir.mul(stepSize);

    // Per-pixel jitter: with 16 steps the un-dithered march bands visibly.
    // The dither becomes noise, and the denoiser below is what removes it.
    const ditherOffset = TSL.interleavedGradientNoise(TSL.screenCoordinate.xy);
    const positionRay = camPos.add(rayDir.mul(tStart)).add(stepVector.mul(ditherOffset)).toVar();

    const ambientTerm = U.fogColor.mul(U.ambient);
    // For a directional light the scattering angle is constant along the whole
    // ray, so the phase is computed once; a spot/point light is re-evaluated
    // per step because its direction changes as the ray advances.
    const constantPhase = positionalLight
      ? null
      : henyeyGreenstein(rayDir.dot(U.sunDir), U.anisotropy).mul(U.sunScatter);

    // ── SINGLE-SCATTERING INTEGRATION ────────────────────────────────────
    // Track transmittance and accumulate the light scattered TOWARD the eye,
    // instead of three's example's single "how much fog is here" scalar. The
    // scalar is why the ported fog was one flat colour everywhere no matter
    // what the scene's lighting did.
    const transmittance = TSL.float(1.0).toVar();
    const scattered = TSL.vec3(0.0).toVar();

    TSL.Loop(U.steps, () => {
      const density = sampleCloudDensity(positionRay);
      const sigma = density.mul(U.density);
      // Beer-Lambert over this segment. Integrating the analytic
      // (1 - e^-sigma*ds) rather than sigma*ds keeps a dense step from
      // scattering more light than reached it.
      const stepTransmittance = sigma.mul(stepSize).negate().exp();

      const phase = positionalLight
        ? henyeyGreenstein(rayDir.dot(U.sunPos.sub(positionRay).normalize()), U.anisotropy).mul(U.sunScatter)
        : constantPhase;
      const inScatter = ambientTerm.add(U.sunColor.mul(phase).mul(sunVisibility(positionRay)));

      scattered.addAssign(transmittance.mul(stepTransmittance.oneMinus()).mul(inScatter));
      transmittance.mulAssign(stepTransmittance);

      positionRay.addAssign(stepVector);
    });

    // Distance fog takes over past the march limit so the volume does not end
    // in a visible wall at `maxRayDist`.
    //
    // ⚠ NOT ON THE SKY. A pixel with nothing in it carries the cleared depth
    // (1.0, or 0.0 under `renderer.reversedDepth` — resolved at build), which reads as
    // "a surface at the far plane" and drives the range term to 1, painting
    // the whole background flat fog-colour. three's example never notices
    // because ITS background is already white; measured here on a normal dark
    // sky it was the difference between ground fog and a whiteout. The cloud
    // march still runs on those pixels, so the fog bank is still visible
    // against the horizon — which is the point of it.
    const hasSurface = fogSurfaceTest(depth, builder?.renderer?.reversedDepthBuffer === true)
      .select(TSL.float(1.0), TSL.float(0.0));
    const rangeFog = surfaceDist
      .sub(U.rangeFogNear)
      .div(U.rangeFogFar.sub(U.rangeFogNear).max(0.001))
      .clamp(0.0, 1.0)
      .mul(hasSurface);

    // The distance haze sits BEHIND the marched volume (hence the × T) and is
    // unshadowed — it stands in for the fog the march did not reach.
    const hazeColor = ambientTerm.add(U.sunColor.mul(constantPhase ?? U.sunScatter));
    const totalScattered = scattered.add(hazeColor.mul(rangeFog).mul(transmittance));
    const alpha = TSL.float(1.0).sub(transmittance.mul(rangeFog.oneMinus()));

    // Premultiplied: rgb is light ALREADY weighted by its own coverage, so the
    // composite is `scene * (1 - a) + rgb` and never a mix() (see the module
    // note in postGraph on premultiplied outputs).
    return TSL.vec4(totalScattered, alpha);
  });

  // Half-float, not R8: scattered sunlight through the phase peak goes well
  // above 1 and an 8-bit buffer would clip the glow flat.
  const lowResFogPass = TSL.rtt(fogPass(), null, null, { type: THREE.HalfFloatType });
  lowResFogPass.setResolutionScale(resolutionScale);
  lowResFogPass.setName?.("volumetricFog");

  // --- denoise / upsample --------------------------------------------------

  /**
   * Joint Bilateral Upsampling (Kopf et al. 2007): read the low-res fog on a
   * 5x5 neighbourhood, weight each tap by its spatial distance AND by how
   * closely its scene depth matches the full-res pixel's. The depth term is
   * the whole point — it is what stops a foreground silhouette from dragging
   * background fog across its edge.
   */
  // ── THE UPSAMPLE'S RADIUS IS A DEVICE POLICY (2026-09-11) ──────────────
  // 5×5 is 25 fog taps + 25 depth taps + 25 view-position reconstructions per
  // FULL-RES pixel: on the user's iPhone this composite read 6 ms of a 45 ms
  // frame (`?hud=1`), the single largest render pass after the scene itself.
  // A portable device takes the 3×3 kernel (9 taps — the same sigma, the same
  // depth test, edges hold; the smoothing reach shrinks by one low-res texel).
  // `__postJbuRadius` pins either way (2 = full kernel on a phone, 1 = the
  // phone kernel on a desktop, for a look check).
  const jbuPin = Number(globalThis.__postJbuRadius);
  const jbuRadius = Number.isFinite(jbuPin) && jbuPin >= 0
    ? Math.min(3, Math.round(jbuPin))
    : (isPortableDevice() ? 1 : 2);
  const jointBilateralUpsampling = TSL.Fn(() => {
    const centerCoord = TSL.screenUV;

    const linearDepthAt = (uv) =>
      TSL.getViewPosition(uv, depthNode.sample(uv).r, projInv).z.negate().max(0.001);

    const centerDepth = linearDepthAt(centerCoord);

    // One low-res texel in full-res uv units.
    const lowResTexel = TSL.fwidth(centerCoord).div(resolutionScale);

    const spatialSigmaFactor = TSL.float(-0.5).div(U.spatialSigma.mul(U.spatialSigma).max(0.01));
    const depthSigmaFactor = U.depthSensitivity.mul(U.depthSensitivity).mul(-0.5);

    const sumColor = TSL.vec4(0.0).toVar();
    const sumWeight = TSL.float(0.0).toVar();

    for (let y = -jbuRadius; y <= jbuRadius; y++) {
      for (let x = -jbuRadius; x <= jbuRadius; x++) {
        const offset = TSL.vec2(TSL.float(x), TSL.float(y));
        const spatialDistSq = offset.x.mul(offset.x).add(offset.y.mul(offset.y));
        const spatialWeight = TSL.exp(spatialDistSq.mul(spatialSigmaFactor));

        const sampleUV = centerCoord.add(offset.mul(lowResTexel));
        const sampleFog = lowResFogPass.sample(sampleUV);
        const sampleDepth = linearDepthAt(sampleUV);

        // Relative depth difference, so the edge test behaves the same at 2 m
        // and at 200 m.
        const depthDiff = sampleDepth.sub(centerDepth).div(centerDepth.max(0.1));
        const rangeWeight = TSL.exp(depthDiff.mul(depthDiff).mul(depthSigmaFactor));

        const totalWeight = spatialWeight.mul(rangeWeight);

        sumColor.addAssign(sampleFog.mul(totalWeight));
        sumWeight.addAssign(totalWeight);
      }
    }

    return sumColor.div(sumWeight.max(0.0001));
  });

  let fog;
  if (denoiser === "jbu") {
    fog = jointBilateralUpsampling();
  } else if (denoiser === "gaussian" && typeof gaussianBlur === "function") {
    fog = gaussianBlur(lowResFogPass, U.blurRadius);
  } else {
    if (denoiser === "gaussian") {
      console.warn("[volumetricFog] gaussianBlur addon not loaded — showing the raw low-res fog.");
    }
    fog = lowResFogPass.sample(TSL.screenUV);
  }

  const fogAmount = fog.a.mul(U.intensity).clamp(0.0, 1.0);
  const scatteredLight = fog.rgb.mul(U.intensity);
  const color = TSL.vec4(colorNode.rgb.mul(fogAmount.oneMinus()).add(scatteredLight), colorNode.a);

  const setParams = (next = {}) => {
    const Q = { ...VOLUMETRIC_FOG_DEFAULTS, ...next };
    U.steps.value = Q.steps;
    U.density.value = Q.density;
    U.heightFalloff.value = Q.heightFalloff;
    U.height.value = Q.height;
    U.groundLevel.value = Q.groundLevel;
    U.cloudScale.value = Q.cloudScale;
    U.cloudThreshold.value = Q.cloudThreshold;
    U.cloudSpeed.value = Q.cloudSpeed;
    U.maxRayDist.value = Q.maxRayDist;
    U.rangeFogNear.value = Q.rangeFogNear;
    U.rangeFogFar.value = Q.rangeFogFar;
    U.spatialSigma.value = Q.spatialSigma;
    U.depthSensitivity.value = Q.depthSensitivity;
    U.blurRadius.value = Q.blurRadius;
    U.intensity.value = Q.intensity;
    U.ambient.value = Q.ambient;
    U.sunScatter.value = Q.sunScatter;
    U.anisotropy.value = Q.anisotropy;
    U.fogColor.value.setStyle(Q.color);
  };

  const _sunWorld = new THREE.Vector3();
  const _targetWorld = new THREE.Vector3();

  /** Re-reads the sun every frame: it rotates, dims and changes colour. */
  const syncSun = () => {
    if (!light) return;
    // World space throughout — a light is parented to its entity exactly like
    // the camera is, so `light.position` is a local offset (the same trap that
    // broke the fog in play mode).
    light.getWorldPosition(_sunWorld);
    U.sunPos.value.copy(_sunWorld);
    if (light.isDirectionalLight || light.isSpotLight) {
      light.target?.getWorldPosition(_targetWorld) ?? _targetWorld.set(0, 0, 0);
      // Unit vector pointing TOWARD the light: the phase peaks when the view
      // ray looks along it, which is when you are staring into the sun.
      U.sunDir.value.copy(_sunWorld).sub(_targetWorld).normalize();
    }
    U.sunColor.value.copy(light.color).multiplyScalar(light.intensity ?? 1);
  };
  syncSun();

  const tick = (dt) => {
    // Guard the clock: a tab that was backgrounded hands back a multi-second
    // delta, which would teleport the clouds on the first frame back.
    U.cloudTime.value += Math.min(Math.max(dt, 0), 0.1) * U.cloudSpeed.value;
    syncSun();
  };

  // `time` is returned for tests: the clock is the one piece of state that a
  // compiled graph cannot show from the outside.
  return {
    color,
    fog: fogAmount,
    setParams,
    tick,
    time: U.cloudTime,
    sun: { color: U.sunColor, direction: U.sunDir, shadowed: !!shadowLight },
    passes: [lowResFogPass],
  };
}
