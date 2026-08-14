/**
 * Reading a render target back as an image, correctly, on either backend.
 *
 * `readRenderTargetPixelsAsync` hands over the mapped buffer exactly as the
 * backend produced it, and the two backends disagree about BOTH of the things
 * that matter:
 *
 *   * **Padding.** WebGPU requires `bytesPerRow` to be a multiple of 256 and
 *     leaves that padding in. WebGL packs rows tightly. Indexing a padded
 *     buffer tightly "works" — you get a plausible image of the right size —
 *     but every row after the first is offset a little further, so the picture
 *     comes out progressively sheared and nothing about the data says so.
 *   * **Row order.** `gl.readPixels` counts rows from the BOTTOM, the WebGL
 *     convention everyone remembers. WebGPU's `copyTextureToBuffer` preserves
 *     texture order, and a colour attachment's row 0 is the TOP. Carrying the
 *     WebGL flip across to WebGPU is what put every editor screenshot and every
 *     `.geom` thumbnail on its head — upside down but otherwise perfect, which
 *     survives review far longer than a broken image would.
 *
 * So: one place that knows, and callers that ask for what they actually want.
 * `readRenderTargetImage` returns a tightly packed, TOP-DOWN RGBA buffer — the
 * layout `CanvasRenderingContext2D.createImageData` expects, and the one a
 * human means by "the image". A caller filling a texture rather than a canvas
 * wants the opposite row order and should flip this, not re-derive it.
 */

/**
 * @param {any} renderer  A WebGPURenderer (either backend).
 * @param {any} target    The RenderTarget to read.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Uint8Array>} `width * height * 4` bytes, row 0 at the top.
 */
export async function readRenderTargetImage(renderer, target, width, height) {
  const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const rowBytes = width * 4;
  // `isWebGLBackend` rather than `isWebGPUBackend`: an unrecognised backend is
  // far more likely to be a future WebGPU one than a second WebGL, and being
  // wrong about padding shears the image while being wrong about the fallback
  // only flips it.
  const webgl = !!renderer.backend?.isWebGLBackend;
  const sourceRow = webgl ? rowBytes : Math.ceil(rowBytes / 256) * 256;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const from = (webgl ? height - 1 - y : y) * sourceRow;
    // WebGPU's final row is short by design — three sizes the buffer as
    // (height-1)*paddedRow + rowBytes — so clamp rather than over-read.
    const available = Math.max(0, Math.min(rowBytes, raw.length - from));
    if (available > 0) out.set(raw.subarray(from, from + available), y * rowBytes);
  }
  return out;
}

/**
 * The same pixels as a PNG data URL, via a 2D canvas.
 *
 * Browser-only by necessity (it needs a canvas), which is why it is separate
 * from the read itself — the impostor baker wants the bytes, not a picture.
 */
export async function renderTargetToDataUrl(renderer, target, width, height) {
  const image = await readRenderTargetImage(renderer, target, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(image);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
