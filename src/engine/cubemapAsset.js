import { vmState } from "./vmState.js";
import * as THREE from "three/webgpu";
import { resolveAssetUrl } from "./assetResolver.js";

/**
 * `.cubemap` assets — a JSON sidecar naming the six images of a cube map
 * (PlayCanvas-style: you fill in +X/−X/+Y/−Y/+Z/−Z slots). The asset itself
 * holds no pixels, only paths, so the faces stay editable textures in the
 * project and are reused by anything else that references them.
 *
 * Consumers: scene settings (`settings.environment.cubemap`) uses it as the
 * scene's skybox + IBL source. The loaded `CubeTexture` is cached per path and
 * shared, because `scene.background`/`scene.environment` are re-applied on
 * every settings change and re-decoding six images each time would flash the
 * sky. `invalidateCubemapAsset` drops the cache after an edit.
 */

export const CUBEMAP_EXT = "cubemap";

/**
 * Face slots in the order three's `CubeTextureLoader` wants them
 * (+X, −X, +Y, −Y, +Z, −Z) — the same order every three cube-map example and
 * every downloadable six-file skybox pack is authored for, which is why the
 * `hint` names double as the filename convention `guessCubemapFaces` matches.
 *
 * Do not "fix" this order to match what you see on screen: three mirrors X when
 * it samples a cube map (its WebGL renderer's `tFlip`), so looking down +X
 * shows the −X image. Sky and reflections agree with each other under that
 * convention, and packs authored for it render correctly.
 * `scripts/run-cubemap-skybox.mjs` asserts exactly this.
 */
export const CUBEMAP_FACES = [
  { key: "px", label: "+X", hint: "Right" },
  { key: "nx", label: "−X", hint: "Left" },
  { key: "py", label: "+Y", hint: "Top" },
  { key: "ny", label: "−Y", hint: "Bottom" },
  { key: "pz", label: "+Z", hint: "Front" },
  { key: "nz", label: "−Z", hint: "Back" },
];

export const CUBEMAP_DEFAULTS = {
  version: 1,
  faces: { px: "", nx: "", py: "", ny: "", pz: "", nz: "" },
};

/** Fills in every face key and drops unknown ones, so callers can index freely. */
export function normalizeCubemapDef(raw) {
  const faces = {};
  for (const { key } of CUBEMAP_FACES) {
    const value = raw?.faces?.[key];
    faces[key] = typeof value === "string" ? value : "";
  }
  return { version: raw?.version ?? 1, faces };
}

/** The six face paths in three's cube order. Unassigned slots come back "". */
export function cubemapFacePaths(def) {
  const { faces } = normalizeCubemapDef(def);
  return CUBEMAP_FACES.map(({ key }) => faces[key]);
}

/** A cube map is only loadable once all six slots are filled. */
export function isCubemapComplete(def) {
  return cubemapFacePaths(def).every((path) => !!path);
}

// Filename conventions for cube faces, most specific alternative first. Matched
// against the file's stem with non-letter boundaries so "negx" doesn't also
// look like the "+X" spelling "x".
const FACE_PATTERNS = {
  px: /(^|[^a-z])(posx|pos_x|px|\+x|right|east)([^a-z]|$)/,
  nx: /(^|[^a-z])(negx|neg_x|nx|-x|left|west)([^a-z]|$)/,
  py: /(^|[^a-z])(posy|pos_y|py|\+y|top|up)([^a-z]|$)/,
  ny: /(^|[^a-z])(negy|neg_y|ny|-y|bottom|down)([^a-z]|$)/,
  pz: /(^|[^a-z])(posz|pos_z|pz|\+z|front|north)([^a-z]|$)/,
  nz: /(^|[^a-z])(negz|neg_z|nz|-z|back|south)([^a-z]|$)/,
};

/**
 * Best-effort face assignment from texture filenames — the usual `px/nx/…`,
 * `posx/negx/…` and `right/left/top/…` spellings. Slots with no confident match
 * stay empty; the user fills those in by hand.
 */
export function guessCubemapFaces(paths) {
  const faces = { ...CUBEMAP_DEFAULTS.faces };
  for (const path of paths ?? []) {
    const stem = String(path)
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    for (const [key, pattern] of Object.entries(FACE_PATTERNS)) {
      if (!faces[key] && pattern.test(stem)) {
        faces[key] = path;
        break;
      }
    }
  }
  return faces;
}

const cache = vmState("cubemapCache", () => new Map()); // normalized path -> { promise, texture, error }

const assetKey = (path) => String(path ?? "").replaceAll("\\", "/");

/** The already-decoded CubeTexture for a path, or null while it isn't ready. */
export function getLoadedCubemap(path) {
  return cache.get(assetKey(path))?.texture ?? null;
}

/** Drops (and disposes) the cached texture so the next load re-reads the file. */
export function invalidateCubemapAsset(path) {
  const key = assetKey(path);
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  // The texture may still be assigned as scene.background/environment; the
  // caller re-applies settings right after, which replaces it there.
  entry.texture?.dispose();
}

/**
 * Loads a `.cubemap` asset into a shared `CubeTexture`. Resolves to null when
 * the file is missing, malformed, or has an unassigned face — that's an
 * authoring state, not a crash, so the scene keeps its flat background.
 */
export async function loadCubemapAsset(path) {
  const key = assetKey(path);
  if (!key) return null;
  let entry = cache.get(key);
  if (!entry) {
    entry = { promise: null, texture: null, error: null };
    cache.set(key, entry);
    entry.promise = (async () => {
      const def = normalizeCubemapDef(await (await fetch(await resolveAssetUrl(path))).json());
      const faces = cubemapFacePaths(def);
      const missing = CUBEMAP_FACES.filter((_, i) => !faces[i]).map((face) => face.label);
      if (missing.length) throw new Error(`unassigned face(s): ${missing.join(", ")}`);
      const urls = await Promise.all(faces.map((face) => resolveAssetUrl(face)));
      // CubeTextureLoader builds the six-image CubeTexture (which, unlike a 2D
      // Texture, defaults to flipY = false — required for cube faces).
      const texture = await new THREE.CubeTextureLoader().loadAsync(urls);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.CubeReflectionMapping;
      texture.name = key;
      entry.texture = texture;
      return texture;
    })();
    entry.promise.catch((err) => {
      entry.error = err;
      console.error(`Failed to load cubemap "${path}": ${err.message ?? err}`);
    });
  }
  try {
    return await entry.promise;
  } catch {
    return null;
  }
}
