import * as THREE from "three/webgpu";
import {
  Fn, If, diffuseColor, dot, float, materialMetalness, materialRoughness, max, mix, normalWorld, positionWorld,
  smoothstep, texture, uniform, vec3, vec4,
} from "three/tsl";
import { freeze } from "../../engine/freezeLedger.js";
import { getCloudNoiseTexture } from "./cloudNoise.js";
import { createSkyOcclusionUniforms, skyExposure } from "./skyOcclusion.js";

/**
 * ⭐⭐ WEATHER ON THE GROUND, NOT ONLY IN THE SKY.
 *
 * A snowstorm over a summer-green world is the single thing that most gives a
 * weather system away, and it is what the user asked for: when it snows, the
 * world goes white; when it rains, the world goes dark and glossy. Both are
 * SURFACE properties, so both have to reach every material in the scene.
 *
 * ## Where it hooks, and why there
 *
 * three's `NodeMaterial` builds its shading in a fixed order — `setupDiffuseColor`,
 * then `setupVariants` (roughness, metalness, and `diffuseContribution`, which
 * is derived from the two). So:
 *
 *   · ALBEDO is patched by wrapping `setupDiffuseColor`: the original runs (map,
 *     vertex colours, whatever the material actually does), and the weather
 *     mixes into the result. Wrapping rather than replacing is what lets this
 *     compose with ANY material, including shader-graph ones.
 *   · ROUGHNESS and METALNESS go through the material's own node SLOTS, wrapped
 *     around whatever was already there. ⚠ They cannot be assigned inside a
 *     `setupVariants` wrapper: `diffuseContribution` — which is not exported
 *     from `three/tsl` and so cannot be re-assigned from out here — is computed
 *     inside the original from the LOCAL metalness node, so a later assignment
 *     to the `metalness` property would light the snow with the old metalness.
 *
 * ## ⛔ IT PATCHES ONCE, AT ATTACH, AND THE UNIFORMS DO THE REST
 *
 * Changing a material's node graph recompiles its pipeline, and a compile wave
 * is the most expensive thing that happens in this engine (see the project's
 * zero-freeze work). Patching when it starts to snow would therefore put a
 * multi-second hitch exactly on the frame the storm arrives. So every eligible
 * material is patched once when the Atmosphere attaches, with `snow` and
 * `wetness` at zero — and the whole term is wrapped in a uniform-driven branch
 * that costs one comparison while the weather is dry.
 */

/** Materials the weather must not touch, by construction. */
const SKIP_TYPES = new Set(["SpriteNodeMaterial", "LineBasicNodeMaterial", "PointsNodeMaterial"]);

export function createSurfaceUniforms(sky = null) {
  return {
    /** 0…1 — how much of the world the snow has taken. */
    snow: uniform(0),
    /** 0…1 — how wet the surfaces are. Lags the rain; see `stepAccumulation`. */
    wetness: uniform(0),
    /** Snow is not white: it is bright and slightly blue, and it takes the
     *  colour of the sky that lights it. Written from the sky model. */
    snowColor: uniform(new THREE.Color(0.86, 0.89, 0.95)),
    /** Metres per tile of the breakup noise — how big the patches are. */
    patchScale: uniform(1 / 14),
    /** ⭐ WHAT CAN SEE THE SKY. Snow does not lie under a bridge and rain does
     *  not wet the floor of a covered market — the same question the
     *  precipitation asks, answered from the same capture. ⚠ Passed IN, because
     *  the patched materials capture it when they compile. */
    sky: sky ?? createSkyOcclusionUniforms(),
  };
}

/** The one noise both the sky and the ground share, in world XZ. */
const patchNoise = /*@__PURE__*/ Fn(([scale]) => {
  const uvNode = positionWorld.xz.mul(scale);
  const tap = texture(getCloudNoiseTexture()).sample(uvNode);
  // Weighted so the low frequencies dominate: snow lies in drifts, not in a
  // fine speckle.
  return dot(tap, vec4(0.55, 0.25, 0.14, 0.06));
});

/**
 * How much snow lies on this surface, 0…1.
 *
 * ⭐ IT IS A FALLING THRESHOLD ON THE SLOPE, not a constant one. As the snow
 * deepens the threshold drops, so it settles first on what is flattest and
 * then creeps down the slopes — which is what makes accumulation read as time
 * passing rather than as a slider being dragged. The normal is the SHADING
 * normal, so snow follows normal-mapped detail for free.
 */
const snowCoverage = /*@__PURE__*/ Fn(([u]) => {
  const up = normalWorld.y;
  const threshold = mix(float(0.98), float(-0.05), u.snow);
  const slope = smoothstep(threshold, threshold.add(0.28), up);
  const patches = mix(float(0.45), float(1), patchNoise(u.patchScale));
  // A 15 cm bias: the surface asking the question is itself in the height map.
  return slope.mul(patches).mul(smoothstep(0.0, 0.12, u.snow)).mul(skyExposure(u.sky, float(0.15))).clamp(0, 1);
});

/** How wet this surface is, 0…1. Vertical faces shed water; tops hold it. */
const wetCoverage = /*@__PURE__*/ Fn(([u]) => {
  const up = normalWorld.y;
  return u.wetness
    .mul(mix(float(0.4), float(1), smoothstep(-0.25, 0.55, up)))
    .mul(skyExposure(u.sky, float(0.15)))
    .clamp(0, 1);
});

/** Standing water: only where it is flat AND the ground dips. */
const puddleCoverage = /*@__PURE__*/ Fn(([u]) => {
  const up = normalWorld.y;
  return u.wetness.mul(smoothstep(0.82, 0.96, up)).mul(smoothstep(0.38, 0.6, patchNoise(u.patchScale.mul(0.6))).oneMinus()).clamp(0, 1);
});

/** Uniform control flow skips noise and roof reads when the surface is dry.
 * Keep the graph installed so even the first wet/snow frame needs no rebuild.
 * Test exactly zero: small positive amounts must retain the original easing,
 * and the legacy path remains available for same-camera GPU comparisons.
 */
function withSurfaceWeather(base, u, weathered) {
  if (globalThis.__atmosphereDrySurfaceBranch === false) return weathered();
  // Weather albedo is built before native lighting. Its first normalWorld
  // read can therefore initialize the shared normal/tangent frame; letting
  // that happen inside the branch leaves native lighting with zero normals
  // when dry. Explicitly retain the material's normal evaluation outside it.
  normalWorld.toStack();
  const result = base.toVar();
  // Both operands are uniforms, so implicit-derivative texture samples in the
  // body remain under uniform control flow on WebGPU.
  If(u.snow.notEqual(0).or(u.wetness.notEqual(0)), () => {
    result.assign(weathered());
  });
  return result;
}

/**
 * Albedo. Wet first — water darkens a porous surface because light that enters
 * the film is much more likely to come back out having been absorbed — then
 * snow over the top of it.
 */
export const weatherAlbedo = /*@__PURE__*/ Fn(([albedo, u]) => {
  return withSurfaceWeather(albedo, u, () => {
    const wet = wetCoverage(u);
    const puddle = puddleCoverage(u);
    const darkened = albedo.mul(mix(float(1), float(0.45), max(wet.mul(0.9), puddle)));
    return mix(darkened, u.snowColor, snowCoverage(u));
  });
});

/** Roughness. Water fills the microsurface; snow is rough but not matte. */
export const weatherRoughness = /*@__PURE__*/ Fn(([roughnessNode, u]) => {
  // Preserve the original final clamp even on a zero-roughness dry material.
  return withSurfaceWeather(roughnessNode.clamp(0.02, 1), u, () => {
    const wet = wetCoverage(u);
    const puddle = puddleCoverage(u);
    // ⚠ WET IS NOT A MIRROR. The first cut took roughness to 0.04 everywhere the
    // rain fell, and a flat plane under a bright sky then returned a near-perfect
    // reflection of it: the "wet" ground came out BRIGHTER than the dry one
    // (measured 106.3 vs 104.1), which is the opposite of the look. Real wet
    // ground is a darker albedo with a TIGHTER, not total, specular; only
    // standing water is a mirror, and that is what `puddle` is for.
    const wetRoughness = mix(roughnessNode, roughnessNode.mul(0.35).add(0.12), wet);
    const pooled = mix(wetRoughness, float(0.03), puddle);
    return mix(pooled, float(0.78), snowCoverage(u)).clamp(0.02, 1);
  });
});

/** Metalness. Snow is a dielectric, so it hides whatever was underneath. */
export const weatherMetalness = /*@__PURE__*/ Fn(([metalnessNode, u]) => {
  return withSurfaceWeather(metalnessNode, u,
    () => metalnessNode.mul(float(1).sub(snowCoverage(u).mul(0.95))));
});

/** Whether this material can carry weather at all. */
export function isWeatherable(material) {
  if (!material || !material.isNodeMaterial) return false;
  if (material.userData?.noWeather === true || material.userData?.atmosphereOwned === true) return false;
  if (SKIP_TYPES.has(material.type)) return false;
  // Transparent surfaces are glass, water and effects. Snow does not settle on
  // a window, and the water module owns its own wetness by definition.
  if (material.transparent === true) return false;
  // An unlit material has no roughness to wet and no lighting to lose; turning
  // one white would silently repaint UI quads and debug draws.
  if (material.isMeshBasicNodeMaterial === true) return false;
  return true;
}

const PATCH = Symbol("atmosphere.weatherPatch");

/** Patches one material in place. Idempotent; returns true if it patched. */
export function patchMaterial(material, uniforms) {
  if (!isWeatherable(material) || material[PATCH]) return false;
  const previousRoughness = material.roughnessNode;
  const previousMetalness = material.metalnessNode;
  const ownDiffuse = Object.prototype.hasOwnProperty.call(material, "setupDiffuseColor")
    ? material.setupDiffuseColor : null;
  const inherited = Object.getPrototypeOf(material).setupDiffuseColor;

  material.roughnessNode = weatherRoughness(previousRoughness ?? materialRoughness, uniforms);
  material.metalnessNode = weatherMetalness(previousMetalness ?? materialMetalness, uniforms);
  material.setupDiffuseColor = function setupWeatheredDiffuseColor(builder) {
    (ownDiffuse ?? inherited).call(this, builder);
    diffuseColor.rgb.assign(weatherAlbedo(diffuseColor.rgb, uniforms));
  };
  material[PATCH] = { previousRoughness, previousMetalness, ownDiffuse };
  material.needsUpdate = true;
  return true;
}

/** Puts a material back exactly as it was found. */
export function unpatchMaterial(material) {
  const patch = material?.[PATCH];
  if (!patch) return false;
  material.roughnessNode = patch.previousRoughness;
  material.metalnessNode = patch.previousMetalness;
  if (patch.ownDiffuse) material.setupDiffuseColor = patch.ownDiffuse;
  else delete material.setupDiffuseColor;
  delete material[PATCH];
  material.needsUpdate = true;
  return true;
}

/** Every material hanging off a scene, once each. */
export function collectSceneMaterials(scene, into = new Set()) {
  scene?.traverse((object) => {
    const material = object.material;
    if (!material) return;
    if (object.userData?.atmosphereOwned || object.userData?.__giDebug) return;
    // ⚠ EDITOR HELPERS ARE NOT THE WORLD. The gizmo, the grid and the outline
    // proxies live on the editor-only layer (the same 0x80000000 mask GI's
    // mesh collector tests), and snow settling on a translate gizmo is not a
    // feature.
    if (((object.layers?.mask ?? 0) >>> 0) & 0x80000000) return;
    if (Array.isArray(material)) for (const entry of material) into.add(entry);
    else into.add(material);
  });
  return into;
}

/**
 * Brings the whole scene under the weather. Called once at attach and then on
 * a slow cadence, because materials arrive later than the Atmosphere does —
 * a model finishes loading, a foliage layer builds its own, a merge produces
 * a fresh one.
 *
 * @returns {number} how many materials this call patched
 */
export function applySurfaceWeather(scene, uniforms) {
  const started = performance.now();
  let patched = 0;
  for (const material of collectSceneMaterials(scene)) {
    if (patchMaterial(material, uniforms)) patched++;
  }
  // Attributed, because it IS a compile wave and the boot table should say so
  // rather than leaving the milliseconds unnamed.
  if (patched > 0) {
    const cost = performance.now() - started;
    freeze.bootMark("atmosphere: surface weather", cost, `${patched} material(s)`);
  }
  return patched;
}

/**
 * Marks every lit material for a rebuild.
 *
 * ⛔ WHY THIS IS NEEDED AT ALL — and it is the whole reason cloud shadows
 * appeared to do nothing at first. A light's shadow term is compiled INTO each
 * material that receives it (`AnalyticLightNode.setupShadow` runs while the
 * MATERIAL is built), so folding a cloud into `light.shadow.shadowNode` after
 * those materials exist changes a graph nobody will read again. Disposing the
 * light clears its own cached branch but recompiles nothing. This does.
 *
 * One wave, at attach, like the surface patch — never when the weather changes.
 */
export function refreshSceneMaterials(scene) {
  let refreshed = 0;
  for (const material of collectSceneMaterials(scene)) {
    if (!material?.isNodeMaterial || material.isMeshBasicNodeMaterial) continue;
    material.needsUpdate = true;
    refreshed++;
  }
  return refreshed;
}

/** Undoes it for the whole scene. */
export function clearSurfaceWeather(scene) {
  let cleared = 0;
  for (const material of collectSceneMaterials(scene)) {
    if (unpatchMaterial(material)) cleared++;
  }
  return cleared;
}
