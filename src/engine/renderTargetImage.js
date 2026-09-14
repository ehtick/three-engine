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

/** Three can initialize a viewport texture before the copy knows its render
 * target. Its normal update early-out then keeps the canvas format in an HDR
 * or RGBA attachment. Repair only that mismatch, before binding/copying it. */
import { freeze } from "./freezeLedger.js";

export function installFramebufferCopyFormats(renderer) {
  if (!renderer.backend?.isWebGPUBackend || renderer.__framebufferFormatsInstalled) return;
  renderer.__framebufferFormatsInstalled = true;
  const copy = renderer.copyFramebufferToTexture;
  renderer.copyFramebufferToTexture = function(texture, ...args) {
    if (!texture.isDepthTexture) {
      const context = this._currentRenderContext;
      const target = context?.renderTarget ?? this.getRenderTarget?.();
      const color = context?.textures?.[0] ?? target?.texture;
      const format = (color && this.backend.get(color)?.texture?.format)
        ?? (target ? this.backend.utils.getCurrentColorFormat(target) : this.backend.utils.getPreferredCanvasFormat());
      const allocated = this.backend.get(texture)?.texture?.format;
      if (format && (texture.internalFormat !== format || (allocated && allocated !== format))) {
        texture.internalFormat = format;
        texture.needsUpdate = true;
      }
    }
    return copy.call(this, texture, ...args);
  };
}

/** Match a screenshot attachment to the live canvas's framebuffer-copy format.
 * Water/transmission nodes can reuse a FramebufferTexture allocated on-screen.
 * WebGL keeps its normal texture formats and bottom-up readback contract. */
export function matchCaptureTargetFormat(renderer, target) {
  if (renderer.backend?.isWebGPUBackend) {
    const format = renderer.backend.utils?.getPreferredCanvasFormat?.();
    if (format === "bgra8unorm" || format === "rgba8unorm") target.texture.internalFormat = format;
  }
  return target;
}

/**
 * @param {any} renderer  A WebGPURenderer (either backend).
 * @param {any} target    The RenderTarget to read.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Uint8Array>} `width * height * 4` bytes, row 0 at the top.
 */
export async function readRenderTargetImage(renderer, target, width, height) {
  // Attributed, not silent: this await parks on the GPU wire (the copy lands
  // after everything the queue already holds), so a deep compile/submit
  // backlog surfaces here as a seconds-long freeze. Without the span the
  // ledger blamed "(unattributed)" — the boot ledger's biggest rows.
  const readSpan = freeze.begin("gpu:readbackRenderTarget");
  let raw;
  try {
    raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  } finally {
    freeze.end(readSpan);
  }
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
  // Canvas-compatible WebGPU captures can be BGRA. Padding/orientation are
  // unchanged, but ImageData always expects RGBA (including its alpha byte).
  const format = target.texture?.internalFormat ?? (target.texture && renderer.backend?.get?.(target.texture)?.texture?.format);
  if (!webgl && format?.startsWith("bgra8")) {
    for (let i = 0; i < out.length; i += 4) {
      const red = out[i + 2]; out[i + 2] = out[i]; out[i] = red;
    }
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
  return imageDataToDataUrl(image, width, height);
}

export function imageDataToDataUrl(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(image);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Reads the canvas AS PRESENTED — the composited frame, every post-render
 * overlay included. A fresh `renderer.render` into an offscreen target (see
 * readRenderTargetImage) cannot see content that is blitted onto the canvas
 * AFTER the main draw: the GI path-tracer debug view is exactly that, so a
 * re-rendered screenshot of a scene showing it comes back without it. This
 * copies what the user actually has on screen instead.
 *
 * ⚠ Call while a frame is being assembled — from a post-render callback.
 * `getCurrentTexture()` outside the task that rendered the frame hands back a
 * fresh texture nobody has drawn into, and the copy reads black.
 *
 * The copy is raw WebGPU rather than `renderer.copyFramebufferToTexture` for
 * the same reason that function errors out here: the canvas is configured
 * with the adapter's preferred format (bgra8unorm on most desktops) and three
 * cannot CREATE a matching destination texture, so the pixels go to a staging
 * buffer and the BGRA→RGBA swap happens on the CPU. WebGPU buffer copies are
 * top-down — row 0 is the TOP, same contract as readRenderTargetImage.
 *
 * @param {any} renderer  A WebGPURenderer.
 * @returns {Promise<{ data: Uint8Array, width: number, height: number }>}
 *   Tightly packed RGBA, alpha forced opaque (the viewport fills the frame).
 */
export async function readLiveCanvasImage(renderer) {
  const backend = renderer?.backend;
  if (!backend?.isWebGPUBackend) {
    throw new Error("Live-canvas capture needs the WebGPU backend.");
  }
  const canvas = renderer.domElement;
  const width = canvas.width;
  const height = canvas.height;
  if (!(width > 0) || !(height > 0)) throw new Error("The canvas has no size to capture.");

  const bgra = backend.utils.getPreferredCanvasFormat() === "bgra8unorm";
  const rowBytes = width * 4;
  // WebGPU buffer copies pad rows to 256 bytes — the same padding rule
  // readRenderTargetImage handles for render-target readbacks.
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const device = backend.device;
  const mapRead = globalThis.GPUMapMode?.READ ?? 1;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: globalThis.GPUBufferUsage.COPY_DST | globalThis.GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: backend.context.getCurrentTexture() },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(mapRead);
    const raw = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const from = y * bytesPerRow;
      const to = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const s = from + x * 4;
        const d = to + x * 4;
        if (bgra) {
          out[d] = raw[s + 2];
          out[d + 1] = raw[s + 1];
          out[d + 2] = raw[s];
        } else {
          out[d] = raw[s];
          out[d + 1] = raw[s + 1];
          out[d + 2] = raw[s + 2];
        }
        out[d + 3] = 255;
      }
    }
    return { data: out, width, height };
  } finally {
    buffer.destroy();
  }
}
