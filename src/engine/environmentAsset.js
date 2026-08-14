import * as THREE from "three/webgpu";
import { vmState } from "./vmState.js";
import { resolveAssetUrl } from "./assetResolver.js";
import { CUBEMAP_EXT, getLoadedCubemap, invalidateCubemapAsset, loadCubemapAsset } from "./cubemapAsset.js";

/**
 * THE SCENE'S SKY — one slot, two file shapes.
 *
 * `settings.environment.cubemap` is the scene's skybox + image-based lighting
 * source, and it accepts either:
 *   · a `.cubemap` descriptor (six face images — see cubemapAsset.js), or
 *   · an equirectangular `.hdr` / `.exr` panorama (what Poly Haven ships, and
 *     what every HDRI library on the web means by "an HDRI").
 *
 * The two used to be separate systems. Scene Settings owned the cube-map path;
 * an `environment` COMPONENT on an entity owned HDRIs, and imported an HDRI by
 * spawning an entity to hold it. The result was a scene whose sky was plainly
 * an HDRI while the panel named "Environment" said "Cube map: None" — the sky
 * was controllable, but not anywhere the user would look. This module is the
 * join: one path, one cache, one set of knobs (intensity / rotation / blur /
 * background / lighting) that mean the same thing for both shapes.
 *
 * The serialized key is still `cubemap` because every scene on disk writes it
 * and a rename buys nothing a doc comment can't. Read it as "the environment
 * asset"; `isCubemapPath` is what decides how it decodes.
 *
 * The EnvironmentComponent remains for the cases a scene setting cannot cover
 * (a script swapping skies at runtime, an HDRI that belongs to a prefab), and
 * still wins when both are present — it applies after settings do, and
 * `sceneSettings.js` deliberately never clobbers a texture it did not install.
 */

/** Equirectangular panorama formats — HDR-capable, hence "an HDRI". */
export const EQUIRECT_EXTS = ["hdr", "exr"];

/** Everything the scene's sky slot accepts. */
export const ENVIRONMENT_EXTS = [CUBEMAP_EXT, ...EQUIRECT_EXTS];

const extOf = (path) => {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export const isCubemapPath = (path) => extOf(path) === CUBEMAP_EXT;
export const isEquirectPath = (path) => EQUIRECT_EXTS.includes(extOf(path));

// Decoded panoramas, cached per path for the same reason cube maps are: scene
// settings are re-applied on EVERY settings change (dragging the exposure
// slider re-applies everything), and re-decoding a 2k HDR each time would flash
// the sky and churn GPU memory.
const cache = vmState("equirectCache", () => new Map()); // key -> { promise, texture, error }

const assetKey = (path) => String(path ?? "").replaceAll("\\", "/");

/**
 * Radiance (RGBE) for `.hdr`, OpenEXR for `.exr`. Loaded on demand — neither
 * belongs in the boot bundle of a scene with no HDRI in it.
 *
 * `HDRLoader` is `RGBELoader` renamed in three r185; the old name still works
 * but prints a deprecation line per load, so prefer the new one and keep the
 * fallback for the older addon bundle a build might be pinned to.
 */
async function equirectLoader(path) {
  if (/\.exr$/i.test(String(path))) {
    const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js");
    return new EXRLoader();
  }
  try {
    const { HDRLoader } = await import("three/addons/loaders/HDRLoader.js");
    return new HDRLoader();
  } catch {
    const { RGBELoader } = await import("three/addons/loaders/RGBELoader.js");
    return new RGBELoader();
  }
}

async function loadEquirectAsset(path) {
  const key = assetKey(path);
  if (!key) return null;
  let entry = cache.get(key);
  if (!entry) {
    entry = { promise: null, texture: null, error: null };
    cache.set(key, entry);
    entry.promise = (async () => {
      const url = await resolveAssetUrl(path);
      const texture = await (await equirectLoader(path)).loadAsync(url);
      // A panorama, not a flat 2D map. Without this three samples it in UV
      // space and the "sky" is a stretched rectangle pinned to the camera —
      // set it BEFORE the texture reaches scene.background/environment.
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.name = key;
      entry.texture = texture;
      return texture;
    })();
    entry.promise.catch((err) => {
      entry.error = err;
      console.error(`Failed to load HDRI "${path}": ${err.message ?? err}`);
    });
  }
  try {
    return await entry.promise;
  } catch {
    return null;
  }
}

/** The already-decoded sky texture for a path, or null while it isn't ready.
 *  Synchronous by design — see `applySceneEnvironment`. */
export function getLoadedEnvironment(path) {
  if (!path) return null;
  if (isCubemapPath(path)) return getLoadedCubemap(path);
  return cache.get(assetKey(path))?.texture ?? null;
}

/**
 * Loads the scene's environment asset, whichever shape it is. Resolves to null
 * on any failure (missing file, unassigned cube face, undecodable HDR) — that's
 * an authoring state, not a crash, and the scene keeps its flat background.
 */
export async function loadEnvironmentAsset(path) {
  if (!path) return null;
  if (isCubemapPath(path)) return loadCubemapAsset(path);
  if (isEquirectPath(path)) return loadEquirectAsset(path);
  console.warn(`Scene environment "${path}" is not a .cubemap, .hdr or .exr — ignoring.`);
  return null;
}

/** Drops (and disposes) the cached texture so the next load re-reads the file. */
export function invalidateEnvironmentAsset(path) {
  if (isCubemapPath(path)) return invalidateCubemapAsset(path);
  const key = assetKey(path);
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  // Still possibly assigned as scene.background/environment; every caller
  // re-applies settings right after, which replaces it there.
  entry.texture?.dispose();
}
