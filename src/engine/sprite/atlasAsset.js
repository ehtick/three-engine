import { resolveAssetUrl } from "../assetResolver.js";

/**
 * `.atlas` — a sprite sheet's regions, pivots, nine-slice borders and
 * animations. JSON beside the image, holding no pixels, exactly like `.cubemap`
 * and `.mat`: the sheet stays an ordinary editable texture, and the same PNG can
 * be referenced directly by anything that wants the whole thing.
 *
 * ## One coordinate convention, and it is image space
 *
 * Every rectangle here is in **texture pixels with the origin at the top-left
 * and Y increasing downward** — the space the image is authored in, the space
 * canvas works in, and the space every sprite-sheet tool on earth reports.
 * Pivots are normalised into the same space, so `[0.5, 1]` is bottom-centre,
 * which is where a character standing on the ground wants its origin.
 *
 * The temptation is to store pivots Y-up because that is what a quad in a Y-up
 * world needs. Resisting it is deliberate: two conventions in one file is how
 * you get a sprite that is correct until it is flipped, and the conversion has
 * to happen exactly once, at the runtime boundary, where it can be read.
 *
 * Nine-slice borders are in texture pixels — a property of the artwork, not of
 * whatever it is stretched across — which is the same choice (and the same
 * numbers) as `UiImageComponent`'s slice insets.
 */

export const ATLAS_EXT = "atlas";
export const ATLAS_VERSION = 1;

/** @typedef {{ name: string, rect: [number, number, number, number],
 *              pivot: [number, number], border: [number, number, number, number],
 *              source?: string }} AtlasRegion */
/** @typedef {{ name: string, fps: number, loop: boolean, frames: string[] }} AtlasAnimation */
/** @typedef {{ version: number, image: string, size: [number, number],
 *              regions: AtlasRegion[], animations: AtlasAnimation[],
 *              packing?: object }} AtlasDef */

export const ATLAS_DEFAULTS = {
  version: ATLAS_VERSION,
  image: "",
  size: [0, 0],
  regions: [],
  animations: [],
};

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Coerces anything read off disk into a usable definition.
 *
 * Hand-edited and half-written atlases must degrade rather than throw: a region
 * with a missing pivot is a region with a centre pivot, and an animation naming
 * a frame that no longer exists simply loses that frame. An atlas that refuses
 * to load takes every sprite in the scene with it.
 */
export function normalizeAtlas(raw) {
  const regions = [];
  const seen = new Set();
  for (const region of Array.isArray(raw?.regions) ? raw.regions : []) {
    const name = String(region?.name ?? "").trim();
    if (!name || seen.has(name)) continue; // names address frames — they must be unique
    seen.add(name);
    const rect = Array.isArray(region.rect) ? region.rect : [0, 0, 0, 0];
    regions.push({
      name,
      rect: [
        Math.round(num(rect[0])),
        Math.round(num(rect[1])),
        Math.max(1, Math.round(num(rect[2], 1))),
        Math.max(1, Math.round(num(rect[3], 1))),
      ],
      pivot: [num(region.pivot?.[0], 0.5), num(region.pivot?.[1], 0.5)],
      border: [
        Math.max(0, Math.round(num(region.border?.[0]))),
        Math.max(0, Math.round(num(region.border?.[1]))),
        Math.max(0, Math.round(num(region.border?.[2]))),
        Math.max(0, Math.round(num(region.border?.[3]))),
      ],
      ...(region.source ? { source: String(region.source) } : {}),
    });
  }

  const names = new Set(regions.map((r) => r.name));
  const animations = [];
  for (const animation of Array.isArray(raw?.animations) ? raw.animations : []) {
    const name = String(animation?.name ?? "").trim();
    if (!name) continue;
    animations.push({
      name,
      fps: Math.max(0.1, num(animation.fps, 12)),
      loop: animation.loop !== false,
      frames: (Array.isArray(animation.frames) ? animation.frames : []).filter((f) => names.has(f)),
    });
  }

  return {
    version: num(raw?.version, ATLAS_VERSION),
    image: String(raw?.image ?? ""),
    size: [Math.max(0, Math.round(num(raw?.size?.[0]))), Math.max(0, Math.round(num(raw?.size?.[1])))],
    regions,
    animations,
    ...(raw?.packing ? { packing: raw.packing } : {}),
  };
}

export const findRegion = (def, name) => def.regions.find((r) => r.name === name) ?? null;
export const findAnimation = (def, name) => def.animations.find((a) => a.name === name) ?? null;

/**
 * A region's UV rectangle, in the [0,1] space three.js samples with.
 *
 * This is the one place the Y flip happens. Texture V runs bottom-up while the
 * atlas is stored top-down, so `v0` is measured from the image's bottom edge.
 * Everything upstream of this function is in image space, and everything
 * downstream is in UV space; there is no third convention in between.
 */
export function regionUv(def, region, { width = def.size[0], height = def.size[1] } = {}) {
  const [x, y, w, h] = region.rect;
  if (!width || !height) return { u0: 0, v0: 0, u1: 1, v1: 1 };
  return {
    u0: x / width,
    v0: 1 - (y + h) / height,
    u1: (x + w) / width,
    v1: 1 - y / height,
  };
}

/** Total duration of an animation, in seconds. */
export const animationDuration = (animation) => (animation.frames.length || 0) / Math.max(0.1, animation.fps);

/**
 * Which frame an animation shows at time `t`.
 *
 * A non-looping animation holds its LAST frame rather than disappearing or
 * wrapping — a death animation that vanishes on its final frame is the usual
 * bug, and holding is what every consumer actually wants.
 */
export function frameAt(animation, t) {
  const count = animation.frames.length;
  if (!count) return null;
  const index = Math.floor(Math.max(0, t) * animation.fps);
  if (animation.loop) return animation.frames[((index % count) + count) % count];
  return animation.frames[Math.min(count - 1, index)];
}

// --- loading ----------------------------------------------------------------

const cache = new Map(); // path -> Promise<AtlasDef>

/** Drops a cached atlas after the editor rewrites it. */
export function invalidateAtlasAsset(path) {
  if (path) cache.delete(path);
  else cache.clear();
}

export async function loadAtlasAsset(path) {
  if (!path) return null;
  if (!cache.has(path)) {
    cache.set(
      path,
      (async () => {
        const response = await fetch(await resolveAssetUrl(path));
        return normalizeAtlas(await response.json());
      })().catch((error) => {
        cache.delete(path);
        throw error;
      }),
    );
  }
  return cache.get(path);
}

/**
 * The atlas's image, resolved against the atlas's own location when the stored
 * path is relative.
 *
 * Storing the image path exactly as the editor's asset picker produced it is
 * the same deal `.cubemap` has, and it works because both go through
 * `resolveAssetUrl`. The relative fallback exists so an atlas written by hand
 * (or by a third-party packer) beside its PNG still loads.
 */
export function atlasImagePath(def, atlasPath) {
  const image = def?.image ?? "";
  if (!image) return "";
  if (/^[a-z]:[\\/]|^[\\/]|^https?:/i.test(image) || image.includes("/") || image.includes("\\")) return image;
  const dir = String(atlasPath ?? "").replace(/[\\/][^\\/]*$/, "");
  return dir ? `${dir}/${image}` : image;
}
