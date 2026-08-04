/**
 * The one pixel container every other file in `src/editor/texture/` speaks.
 *
 * RGBA, 8 bits per channel, **straight (non-premultiplied) alpha**, row-major
 * from the top-left. Straight alpha is not a stylistic choice: Canvas2D
 * composites premultiplied and un-premultiplies on `getImageData`, so a
 * 50%-alpha stroke read back and written again has already lost precision.
 * Do that a few dozen times over an editing session — which is exactly what an
 * undo/redo history does — and colours visibly drift in the transparent
 * regions, with no way to see where it happened. We composite ourselves and
 * only ever hand pixels to a canvas for display.
 *
 * Nothing in this file touches the DOM, so all of it runs under `node`.
 *
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} PixelBuffer
 */

/** @returns {PixelBuffer} */
export function createBuffer(width, height, fill = null) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);
  const buffer = { width: w, height: h, data };
  if (fill) fillBuffer(buffer, fill);
  return buffer;
}

/** @param {PixelBuffer} buffer @returns {PixelBuffer} */
export function cloneBuffer(buffer) {
  return {
    width: buffer.width,
    height: buffer.height,
    data: new Uint8ClampedArray(buffer.data),
  };
}

/** Byte cost of a buffer — the history stack budgets against this. */
export function bufferBytes(buffer) {
  return buffer ? buffer.width * buffer.height * 4 : 0;
}

/** @param {PixelBuffer} buffer @param {[number,number,number,number]} rgba */
export function fillBuffer(buffer, rgba) {
  const [r, g, b, a] = rgba;
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return buffer;
}

export function getPixel(buffer, x, y, out = [0, 0, 0, 0]) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return out;
  }
  const i = (y * buffer.width + x) * 4;
  const d = buffer.data;
  out[0] = d[i];
  out[1] = d[i + 1];
  out[2] = d[i + 2];
  out[3] = d[i + 3];
  return out;
}

export function setPixel(buffer, x, y, rgba) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  const i = (y * buffer.width + x) * 4;
  const d = buffer.data;
  d[i] = rgba[0];
  d[i + 1] = rgba[1];
  d[i + 2] = rgba[2];
  d[i + 3] = rgba[3];
}

/**
 * Copies a rectangle out of `buffer`. Areas outside the source read as fully
 * transparent rather than clamping — a crop that reaches past the edge should
 * produce empty pixels, not a smeared border.
 */
export function cropBuffer(buffer, x, y, width, height) {
  const out = createBuffer(width, height);
  const w = out.width;
  const h = out.height;
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= buffer.height) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= buffer.width) continue;
      const si = (sy * buffer.width + sx) * 4;
      const di = (row * w + col) * 4;
      out.data[di] = buffer.data[si];
      out.data[di + 1] = buffer.data[si + 1];
      out.data[di + 2] = buffer.data[si + 2];
      out.data[di + 3] = buffer.data[si + 3];
    }
  }
  return out;
}

/**
 * Resamples to a new size.
 *
 * `nearest` is the default for a reason that is specific to games: a texture
 * being resized in an engine is very often pixel art or a mask, and bilinear
 * on either produces something subtly wrong (soft edges on art meant to be
 * crisp; intermediate values in a mask that was only ever supposed to hold two).
 * Bilinear is right for photographic source and is one argument away.
 *
 * Bilinear filters in **premultiplied** space and converts back. Averaging
 * straight-alpha colours pulls the colour of fully transparent texels into
 * their visible neighbours — which is how downscaling a sprite on a
 * transparent background produces a black halo around it.
 */
export function resizeBuffer(buffer, width, height, { filter = "nearest" } = {}) {
  const out = createBuffer(width, height);
  const { width: sw, height: sh, data: src } = buffer;
  const dw = out.width;
  const dh = out.height;
  const dst = out.data;
  if (sw === dw && sh === dh) {
    dst.set(src);
    return out;
  }

  if (filter === "nearest") {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        const si = (sy * sw + sx) * 4;
        const di = (y * dw + x) * 4;
        dst[di] = src[si];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2];
        dst[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  // Box-filtered bilinear: when downscaling by more than 2x, sampling four
  // texels skips most of the source and aliases badly (a checkerboard becomes
  // a flat colour that depends on the exact ratio). Averaging over the source
  // rectangle each destination texel covers is the same cost per output pixel
  // and is correct at any ratio.
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * yRatio;
    const y1 = Math.min(sh, (y + 1) * yRatio);
    const ys = Math.floor(y0);
    const ye = Math.max(ys + 1, Math.ceil(y1));
    for (let x = 0; x < dw; x++) {
      const x0 = x * xRatio;
      const x1 = Math.min(sw, (x + 1) * xRatio);
      const xs = Math.floor(x0);
      const xe = Math.max(xs + 1, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = ys; sy < ye && sy < sh; sy++) {
        for (let sx = xs; sx < xe && sx < sw; sx++) {
          const si = (sy * sw + sx) * 4;
          const sa = src[si + 3] / 255;
          r += src[si] * sa;
          g += src[si + 1] * sa;
          b += src[si + 2] * sa;
          a += sa;
          n++;
        }
      }
      const di = (y * dw + x) * 4;
      if (n === 0 || a === 0) {
        dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0;
        continue;
      }
      dst[di] = r / a;
      dst[di + 1] = g / a;
      dst[di + 2] = b / a;
      dst[di + 3] = (a / n) * 255;
    }
  }
  return out;
}

/** @param {"horizontal"|"vertical"} axis */
export function flipBuffer(buffer, axis) {
  const { width: w, height: h, data: src } = buffer;
  const out = createBuffer(w, h);
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    const sy = axis === "vertical" ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const sx = axis === "horizontal" ? w - 1 - x : x;
      const si = (sy * w + sx) * 4;
      const di = (y * w + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return out;
}

/** Rotates by a multiple of 90°, clockwise. Dimensions swap for odd turns. */
export function rotateBuffer(buffer, turns) {
  const t = ((Math.round(turns) % 4) + 4) % 4;
  if (t === 0) return cloneBuffer(buffer);
  const { width: w, height: h, data: src } = buffer;
  const swap = t % 2 === 1;
  const out = createBuffer(swap ? h : w, swap ? w : h);
  const dw = out.width;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx;
      let dy;
      if (t === 1) {
        dx = h - 1 - y;
        dy = x;
      } else if (t === 2) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else {
        dx = y;
        dy = w - 1 - x;
      }
      const si = (y * w + x) * 4;
      const di = (dy * dw + dx) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return out;
}

/**
 * Resizes the *canvas* without resampling: existing pixels keep their size and
 * land at `(offsetX, offsetY)`. Growing adds transparency; shrinking clips.
 */
export function resizeCanvas(buffer, width, height, offsetX = 0, offsetY = 0) {
  return cropBuffer(buffer, -Math.round(offsetX), -Math.round(offsetY), width, height);
}

/**
 * Copies a rectangle from one same-sized buffer to another, in place.
 * The live-stroke path leans on this: restore the segment's rectangle from the
 * pre-stroke copy, then re-rasterize just that rectangle.
 */
export function copyRegion(dst, src, { x0, y0, x1, y1 }) {
  const w = dst.width;
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(w, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(dst.height, Math.ceil(y1));
  if (right <= left || bottom <= top) return dst;
  for (let y = top; y < bottom; y++) {
    const at = (y * w + left) * 4;
    dst.data.set(src.data.subarray(at, at + (right - left) * 4), at);
  }
  return dst;
}

/** Clears a rectangle to fully transparent. */
export function clearRegion(buffer, { x0, y0, x1, y1 }) {
  const w = buffer.width;
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(w, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(buffer.height, Math.ceil(y1));
  for (let y = top; y < bottom; y++) {
    buffer.data.fill(0, (y * w + left) * 4, (y * w + right) * 4);
  }
  return buffer;
}

/** Tight bounds of everything with alpha above `threshold`, or null if empty. */
export function opaqueBounds(buffer, threshold = 0) {
  const { width: w, height: h, data } = buffer;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** #rrggbb / #rrggbbaa / #rgb → [r,g,b,a]. Unparseable input reads as opaque black. */
export function parseColor(hex, alpha = 255) {
  const s = String(hex ?? "").trim().replace(/^#/, "");
  const to = (v) => parseInt(v, 16);
  if (s.length === 3) return [to(s[0] + s[0]), to(s[1] + s[1]), to(s[2] + s[2]), alpha];
  if (s.length === 6) return [to(s.slice(0, 2)), to(s.slice(2, 4)), to(s.slice(4, 6)), alpha];
  if (s.length === 8) {
    return [to(s.slice(0, 2)), to(s.slice(2, 4)), to(s.slice(4, 6)), to(s.slice(6, 8))];
  }
  return [0, 0, 0, alpha];
}

/** [r,g,b] → "#rrggbb" (alpha is carried separately in the UI). */
export function toHex(rgba) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(rgba[0])}${h(rgba[1])}${h(rgba[2])}`;
}
