/**
 * Project I/O for the texture editor: open an image as a layered document,
 * save it back, create a new one.
 *
 * The rule this file exists to enforce is that **the image is the asset**. A
 * save always writes the flattened image first and the `.tex` sidecar second,
 * so a crash between the two leaves a correct texture with a stale layer stack
 * (recoverable, and the stale-sidecar check catches it) rather than a layer
 * stack describing an image that was never written.
 */

import { extOf, invalidateBlobUrl, writeBinaryFile } from "./assetLoader.js";
import { browserCodec, decodeImage, encodeImage } from "./texture/codecPng.js";
import { createDocument, documentFromBuffer, flattenDocument } from "./texture/layers.js";
import { decodeTexDoc, encodeTexDoc, isTexDoc, texDocMatches } from "./texture/texdoc.js";
import { parseColor } from "./texture/pixels.js";

/** Sidecar suffix. Appended to the FULL file name (`wall.png.tex`) exactly like
 *  `.meta`, so one texture's document can never collide with another's when two
 *  files differ only by extension. */
export const TEX_SIDECAR = ".tex";

export const texSidecarPath = (imagePath) => `${imagePath}${TEX_SIDECAR}`;

const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

async function readBytes(path) {
  return new Uint8Array(await invoke("read_binary_file", { path }));
}

async function exists(path) {
  try {
    await invoke("stat_file", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a texture as an editable document.
 *
 * @returns {Promise<{ doc: import("./texture/layers.js").TextureDocument,
 *                     source: "sidecar"|"image", stale: boolean, warning: string|null }>}
 *
 * `stale` means a sidecar existed but no longer describes the image beside it —
 * someone replaced the PNG from outside the editor. We open the *image*, not
 * the sidecar, because the file on disk is the truth and silently restoring an
 * old layer stack over it would destroy their new artwork on the next save.
 */
export async function openTextureDocument(path) {
  const bytes = await readBytes(path);
  const image = await decodeImage(bytes, MIME_BY_EXT[extOf(path)] ?? "image/png");

  const sidecar = texSidecarPath(path);
  if (await exists(sidecar)) {
    try {
      const raw = await readBytes(sidecar);
      if (isTexDoc(raw)) {
        const doc = await decodeTexDoc(raw, browserCodec);
        if (texDocMatches(doc, image.width, image.height)) {
          return { doc, source: "sidecar", stale: false, warning: null };
        }
        return {
          doc: documentFromBuffer(image),
          source: "image",
          stale: true,
          warning:
            `The saved layers are ${doc.width}×${doc.height} but the image on disk is ` +
            `${image.width}×${image.height}. The image was opened flattened — saving will ` +
            `replace the old layer stack.`,
        };
      }
    } catch (error) {
      return {
        doc: documentFromBuffer(image),
        source: "image",
        stale: true,
        warning: `The .tex sidecar could not be read (${error?.message ?? error}); opened flattened.`,
      };
    }
  }
  return { doc: documentFromBuffer(image), source: "image", stale: false, warning: null };
}

/**
 * Flattens and writes the image, then the sidecar.
 *
 * `invalidateBlobUrl` is what makes an edit show up on the model in the
 * viewport without reopening the scene — the editor's asset cache and the
 * engine's decoded caches both key on path, and neither has any way to notice
 * the bytes changed underneath them.
 */
export async function saveTextureDocument(path, doc, { writeSidecar = true, renderEffects } = {}) {
  // The saved PNG must be what the canvas shows, layer effects included — a
  // file that differs from the preview is the worst kind of surprise.
  const flat = renderEffects ? flattenDocument(doc, renderEffects) : flattenDocument(doc);
  const ext = extOf(path);
  await writeBinaryFile(path, await encodeImage(flat, ext));

  if (writeSidecar) {
    // A single-layer document with nothing set on it is exactly the image, so
    // the sidecar would carry no information and would only clutter the folder
    // (and double the disk cost of every texture ever opened).
    if (isTriviallyFlat(doc)) {
      await deleteIfPresent(texSidecarPath(path));
    } else {
      await writeBinaryFile(texSidecarPath(path), await encodeTexDoc(doc, browserCodec));
    }
  }
  invalidateBlobUrl(path);
  return flat;
}

function isTriviallyFlat(doc) {
  if (doc.layers.length !== 1) return false;
  const [layer] = doc.layers;
  return (
    layer.visible !== false &&
    (layer.opacity ?? 1) === 1 &&
    (layer.blend ?? "normal") === "normal" &&
    !layer.mask &&
    (layer.offset?.[0] ?? 0) === 0 &&
    (layer.offset?.[1] ?? 0) === 0
  );
}

async function deleteIfPresent(path) {
  if (await exists(path)) await invoke("delete_path", { path }).catch(() => {});
}

/**
 * Creates a new texture asset on disk and returns its path.
 *
 * A new document is written out immediately rather than living only in the
 * panel: the Assets grid is the place users look for their work, and a texture
 * that exists only until the tab is closed is a data-loss trap.
 */
export async function createTextureAsset(dirPath, fileName, {
  width = 512,
  height = 512,
  background = null,
} = {}) {
  const path = `${dirPath.replace(/[\\/]$/, "")}/${fileName}`;
  const doc = createDocument({
    width,
    height,
    background: background ? parseColor(background, 255) : null,
  });
  await saveTextureDocument(path, doc, { writeSidecar: false });
  return { path, doc };
}

/**
 * Merges keys into a texture's `.meta` sidecar, creating it if absent.
 *
 * Used to mark a generated map as linear-space data. A packed
 * roughness/metal/AO texture read as sRGB is wrong everywhere it is sampled,
 * and the symptom — "my roughness looks washed out" — points at the material,
 * not at the import setting that caused it.
 */
export async function writeTextureMeta(path, patch) {
  let existing = {};
  try {
    existing = JSON.parse(await invoke("read_text_file", { path: `${path}.meta` })) ?? {};
  } catch {
    existing = {};
  }
  await invoke("save_scene", {
    path: `${path}.meta`,
    contents: JSON.stringify({ ...existing, ...patch }, null, 2),
  });
}

/** Reads an image into a PixelBuffer without any document machinery — used by
 *  the atlas builder and by "place image as a layer". */
export async function readImageBuffer(path) {
  return decodeImage(await readBytes(path), MIME_BY_EXT[extOf(path)] ?? "image/png");
}
