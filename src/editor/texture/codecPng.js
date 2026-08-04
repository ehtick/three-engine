/**
 * The browser end of the codec seam.
 *
 * Encoding always goes through our own PNG writer (`png.js`) so saves are
 * lossless — see that file for why the canvas route is not. Decoding prefers it
 * too, and falls back to `createImageBitmap` for everything it deliberately
 * does not implement: JPEG, WebP, palette PNGs, 16-bit, interlaced. The
 * fallback's premultiplication loss is harmless for exactly those formats —
 * JPEG and palette PNG have no partial alpha to lose in the first place.
 *
 * This is the only file under `src/editor/texture/` that touches the DOM.
 */

import { decodePng, encodePng, isDecodablePng } from "./png.js";

export { encodePng };

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

/**
 * @param {Uint8Array} bytes any image file's bytes
 * @param {string} [mime] hint for the ImageBitmap fallback
 * @returns {Promise<PixelBuffer>}
 */
export async function decodeImage(bytes, mime = "image/png") {
  if (isDecodablePng(bytes)) {
    try {
      return await decodePng(bytes);
    } catch {
      // A malformed chunk in an otherwise plausible PNG — let the browser's
      // decoder have a go rather than refusing to open the file.
    }
  }
  return decodeViaImageBitmap(bytes, mime);
}

async function decodeViaImageBitmap(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  // `premultiplyAlpha: "none"` asks the decoder to keep straight alpha, which
  // Chromium honours for still images. It is the difference between a sprite's
  // soft edge surviving a round trip and being quantised toward black.
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: image.width, height: image.height, data: image.data };
}

const LOSSY_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * Encodes for whatever extension the asset already has.
 *
 * Saving a `.jpg` as PNG bytes would leave a file whose contents contradict its
 * name — which loads fine in a browser and breaks every tool that trusts the
 * extension. JPEG cannot carry alpha, so a transparent document flattens onto
 * white first; letting the canvas decide would silently produce black, and
 * black fringing on a saved JPEG looks like a bug in the editor rather than a
 * property of the format.
 */
export async function encodeImage(buffer, ext, { quality = 0.92 } = {}) {
  const mime = LOSSY_MIME[String(ext ?? "").toLowerCase()];
  if (!mime) return encodePng(buffer);

  const canvas = new OffscreenCanvas(buffer.width, buffer.height);
  const ctx = canvas.getContext("2d");
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, buffer.width, buffer.height);
  }
  const source = new OffscreenCanvas(buffer.width, buffer.height);
  source.getContext("2d").putImageData(bufferToImageData(buffer), 0, 0);
  ctx.drawImage(source, 0, 0);
  const blob = await canvas.convertToBlob({ type: mime, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** The codec pair `texdoc.js` expects. */
export const browserCodec = { encodePng, decodePng: (bytes) => decodeImage(bytes, "image/png") };

/**
 * Paints a PixelBuffer into a canvas 2D context at 1:1.
 *
 * `putImageData` bypasses the context transform by design, so the caller draws
 * through an offscreen canvas when it needs scaling — which is also what keeps
 * the zoomed view crisp, since `drawImage` with `imageSmoothingEnabled: false`
 * is the only way to get nearest-neighbour magnification.
 */
export function bufferToImageData(buffer) {
  return new ImageData(
    buffer.data instanceof Uint8ClampedArray ? buffer.data : new Uint8ClampedArray(buffer.data),
    buffer.width,
    buffer.height,
  );
}

/** A reusable offscreen canvas per size class, so panning doesn't allocate. */
const scratch = new Map();
export function bufferToCanvas(buffer) {
  const key = `${buffer.width}x${buffer.height}`;
  let canvas = scratch.get(key);
  if (!canvas) {
    canvas = new OffscreenCanvas(buffer.width, buffer.height);
    scratch.set(key, canvas);
    // Bounded: a document only ever has a handful of distinct sizes open, but
    // a long session of resizes shouldn't accumulate them forever.
    if (scratch.size > 8) scratch.delete(scratch.keys().next().value);
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.putImageData(bufferToImageData(buffer), 0, 0);
  return canvas;
}
