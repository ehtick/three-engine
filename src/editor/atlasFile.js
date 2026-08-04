/**
 * Project I/O for sprite atlases: build one from loose images, read and write
 * the `.atlas`, and export its regions back out as separate files.
 *
 * The round trip is the point. Artists receive a sheet and want the sprites;
 * they author sprites and want a sheet. An editor that can only do one
 * direction sends them back to the tool this module exists to replace.
 */

import { basename } from "./store/projectStore.js";
import { writeBinaryFile, invalidateBlobUrl } from "./assetLoader.js";
import { readImageBuffer } from "./textureFile.js";
import { encodePng } from "./texture/png.js";
import { createBuffer, cropBuffer } from "./texture/pixels.js";
import { blitWithExtrude, packAtlas } from "./texture/packer.js";
import { ATLAS_VERSION, invalidateAtlasAsset, normalizeAtlas } from "../engine/sprite/atlasAsset.js";
export { applySlice, uniqueRegionName } from "./texture/atlasOps.js";

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

const stem = (path) => basename(path).replace(/\.[^.]+$/, "");
const dirOf = (path) => String(path ?? "").replace(/[\\/][^\\/]*$/, "");

export async function readAtlas(path) {
  const text = await invoke("read_text_file", { path });
  return normalizeAtlas(JSON.parse(text));
}

export async function writeAtlas(path, def) {
  await invoke("save_scene", { path, contents: JSON.stringify(normalizeAtlas(def), null, 2) });
  invalidateAtlasAsset(path);
  invalidateBlobUrl(path);
}

/**
 * Packs a set of images into one sheet plus its `.atlas`.
 *
 * Region names come from the source file names, which is what makes the atlas
 * legible afterwards — `hero_idle_03` rather than `sprite_17`. A name collision
 * between two folders is disambiguated rather than silently dropped, since
 * `Hero/idle.png` and `Enemy/idle.png` in one atlas is completely ordinary.
 *
 * @returns {Promise<{atlasPath: string, imagePath: string, def: object, overflow: string[]}>}
 */
export async function buildAtlasFromImages(paths, {
  directory,
  name = "Atlas",
  padding = 2,
  extrude = 1,
  maxSize = 4096,
  powerOfTwo = true,
} = {}) {
  const dir = (directory ?? dirOf(paths[0] ?? "")).replace(/[\\/]$/, "");
  const loaded = [];
  const used = new Set();
  for (const path of paths) {
    const buffer = await readImageBuffer(path);
    let id = stem(path);
    if (used.has(id)) {
      let n = 1;
      while (used.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    used.add(id);
    loaded.push({ id, path, buffer });
  }

  const packed = packAtlas(
    loaded.map((entry) => ({ id: entry.id, width: entry.buffer.width, height: entry.buffer.height })),
    { padding, maxSize, powerOfTwo },
  );

  const sheet = createBuffer(packed.width, packed.height);
  const byId = new Map(loaded.map((entry) => [entry.id, entry]));
  const regions = [];
  for (const placement of packed.placements) {
    const entry = byId.get(placement.id);
    if (!entry) continue;
    blitWithExtrude(sheet, entry.buffer, placement.x, placement.y, extrude);
    regions.push({
      name: placement.id,
      rect: [placement.x, placement.y, placement.width, placement.height],
      pivot: [0.5, 0.5],
      border: [0, 0, 0, 0],
      source: entry.path,
    });
  }

  const imagePath = `${dir}/${name}.png`;
  const atlasPath = `${dir}/${name}.atlas`;
  await writeBinaryFile(imagePath, await encodePng(sheet));
  invalidateBlobUrl(imagePath);

  const def = normalizeAtlas({
    version: ATLAS_VERSION,
    image: imagePath,
    size: [packed.width, packed.height],
    regions,
    animations: [],
    packing: { padding, extrude, maxSize, powerOfTwo },
  });
  await writeAtlas(atlasPath, def);

  return { atlasPath, imagePath, def, overflow: packed.overflow };
}

/**
 * Rebuilds the sheet from the regions' recorded `source` files.
 *
 * Only possible for an atlas this editor packed (a sliced sheet has no sources),
 * which is why the button reports how many regions can be re-sourced instead of
 * failing halfway through. Regions whose source has since been deleted are cut
 * from the sheet rather than being left pointing at stale pixels — a silently
 * stale sprite is worse than a missing one.
 */
export function repackableRegions(def) {
  return (def?.regions ?? []).filter((region) => !!region.source);
}

/**
 * Writes every region out as its own PNG — the unpack direction.
 *
 * Pivots and nine-slice borders cannot survive as loose files, so they are left
 * behind deliberately; the `.atlas` remains the place that knows them.
 */
export async function exportRegions(atlasPath, def, imageBuffer, { directory = null } = {}) {
  const dir = (directory ?? `${dirOf(atlasPath)}/${stem(atlasPath)}_sprites`).replace(/[\\/]$/, "");
  await invoke("create_dir", { path: dir }).catch(() => {});
  const written = [];
  for (const region of def.regions) {
    const [x, y, w, h] = region.rect;
    const sprite = cropBuffer(imageBuffer, x, y, w, h);
    const target = `${dir}/${region.name}.png`;
    await writeBinaryFile(target, await encodePng(sprite));
    written.push(target);
  }
  return { directory: dir, written };
}

/**
 * Finds the atlas in an image's own folder that claims it, if any.
 *
 * Matched on the atlas's `image` field rather than on the filename, so a
 * hand-named `Characters.atlas` pointing at `sheet_v2.png` is still found, and
 * an atlas that merely happens to share a stem is not falsely claimed.
 */
export async function findAtlasForImage(imagePath) {
  const dir = dirOf(imagePath);
  if (!dir) return null;
  const key = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
  let entries = [];
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.is_dir || !/\.atlas$/i.test(entry.name)) continue;
    try {
      const def = await readAtlas(entry.path);
      const image = def.image?.includes("/") || def.image?.includes("\\") ? def.image : `${dir}/${def.image}`;
      if (key(image) === key(imagePath)) return entry.path;
    } catch {
      // A malformed atlas is not this function's problem to report.
    }
  }
  return null;
}

