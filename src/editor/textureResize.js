/**
 * Resizing image assets in place, one or many.
 *
 * The Assets panel's "Resize Images…" and the `texture.resizeMany` op both come
 * here, so a person selecting eight textures and an agent passing eight paths
 * get byte-identical results. The sizing arithmetic itself is in
 * `texture/fit.js`, which is DOM-free and unit-tested.
 *
 * Two things this has to get right that a naive "decode, scale, write" would
 * not:
 *
 * - **Layers survive.** The file on disk is the flattened image, but a texture
 *   that has been through the Texture Editor also has a `.tex` sidecar holding
 *   its layer stack. Resampling the flattened result and dropping the sidecar
 *   would silently destroy that stack, so the whole document is resized.
 * - **The `.basis` derivative is re-encoded.** A KTX2 sidecar describes the
 *   pixels that were there before; leaving a 2048² derivative beside a 512²
 *   source means the engine keeps loading the old image, and the resize looks
 *   like it did nothing.
 *
 * This is a file write, not a scene edit: it is NOT on the undo stack. Callers
 * are expected to have said so.
 */

import { extOf, TEXTURE_EXTENSIONS } from "./assetLoader.js";
import { openTextureDocument, saveTextureDocument } from "./textureFile.js";
import { fitDocument, plannedSize } from "./texture/fit.js";
import { useProjectStore } from "./store/projectStore.js";

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

async function exists(path) {
  try {
    await invoke("stat_file", { path });
    return true;
  } catch {
    return false;
  }
}

/** True for the file types `textureFile.js` can actually decode and re-encode. */
export const isResizableImage = (path) => TEXTURE_EXTENSIONS.includes(extOf(path));

/**
 * Re-encodes the KTX2 derivative when there is one.
 *
 * Only when there is one: creating a `.basis` for a texture that never had one
 * would be this function inventing a build-pipeline decision out of a resize.
 */
async function refreshBasisDerivative(path) {
  if (!(await exists(`${path}.basis`))) return false;
  try {
    const { compressTextureBasis } = await import("./basisCompress.js");
    await compressTextureBasis(path);
    return true;
  } catch (err) {
    // A stale derivative is worse than none: it is the file the engine loads.
    console.warn(
      `Couldn't re-compress ${path}.basis after the resize — it still describes the old size (${err?.message ?? err})`,
    );
    return false;
  }
}

/**
 * Resizes one image on disk.
 *
 * @param {string} path absolute path to a .png/.jpg/.webp
 * @param {import("./texture/fit.js").FitSpec} spec see texture/fit.js
 * @returns {Promise<{path, from: {width, height}, width: number, height: number, changed: boolean}>}
 */
export async function resizeTextureFile(path, spec) {
  const { doc } = await openTextureDocument(path);
  const from = { width: doc.width, height: doc.height };
  const target = plannedSize(from, spec);
  // Nothing to do — but still report it, so a bulk run can say "3 of 8 were
  // already that size" instead of implying it rewrote them.
  if (target.width === from.width && target.height === from.height) {
    return { path, from, width: from.width, height: from.height, changed: false };
  }
  fitDocument(doc, spec);
  await saveTextureDocument(path, doc);
  await refreshBasisDerivative(path);
  return { path, from, width: doc.width, height: doc.height, changed: true };
}

/**
 * Resizes a set of images, carrying on past the ones that fail.
 *
 * One bad file in a selection of thirty must not abandon the other twenty-nine
 * halfway through — the user would be left guessing which ones ran.
 *
 * @returns {Promise<{resized: Array, unchanged: Array, failed: Array, skipped: string[]}>}
 */
export async function resizeTextures(paths, spec) {
  const unique = [...new Set((paths ?? []).filter(Boolean))];
  const targets = unique.filter(isResizableImage);
  const skipped = unique.filter((path) => !isResizableImage(path));

  const resized = [];
  const unchanged = [];
  const failed = [];
  for (const path of targets) {
    try {
      const result = await resizeTextureFile(path, spec);
      (result.changed ? resized : unchanged).push(result);
    } catch (err) {
      failed.push({ path, error: String(err?.message ?? err) });
      console.error(`Resize failed for ${path}: ${err?.message ?? err}`);
    }
  }

  // One refresh at the end: the grid re-reads sizes and modified times once,
  // rather than re-listing the folder after every single file.
  if (resized.length) await useProjectStore.getState().refresh();

  if (resized.length === 1) {
    const [only] = resized;
    console.log(
      `Resized ${only.path.split(/[\\/]/).pop()} ${only.from.width}×${only.from.height} → ${only.width}×${only.height}`,
    );
  } else if (resized.length > 1) {
    console.log(`Resized ${resized.length} images`);
  }
  if (unchanged.length) {
    console.log(
      `${unchanged.length} ${unchanged.length === 1 ? "image was" : "images were"} already that size — left untouched`,
    );
  }
  if (skipped.length) {
    console.warn(
      `Skipped ${skipped.length} non-image ${skipped.length === 1 ? "file" : "files"}: ${skipped
        .map((p) => p.split(/[\\/]/).pop())
        .join(", ")}`,
    );
  }
  return { resized, unchanged, failed, skipped };
}
