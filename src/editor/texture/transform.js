/**
 * Affine transforms of a layer's contents — scale, rotate, move.
 *
 * The document keeps its size; the pixels move inside it. That is the whole
 * difference between this and `Image ▸ Resize`: resizing a document changes
 * what the texture *is*, while transforming a layer rearranges what is drawn on
 * one of them, and conflating the two is how someone ends up with a 4096px
 * texture because they wanted a bigger logo.
 *
 * ## Inverse mapping, always
 *
 * For each DESTINATION texel, find where it came from in the source. The
 * forward direction — walk the source and write where each texel lands — leaves
 * holes the moment a transform magnifies anything, because two neighbouring
 * source texels can land three texels apart. Inverse mapping cannot produce a
 * hole: every destination texel is asked exactly once.
 *
 * ## Premultiplied sampling
 *
 * Same rule as `resizeBuffer` and the blur: interpolating straight-alpha colour
 * drags the RGB of fully transparent texels into their visible neighbours,
 * which is what puts a dark fringe around a rotated sprite.
 */

import { createBuffer } from "./pixels.js";

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

/**
 * @param {PixelBuffer} buffer
 * @param {{ scaleX?: number, scaleY?: number, angle?: number,
 *           offsetX?: number, offsetY?: number,
 *           pivot?: [number, number] | null, filter?: "bilinear" | "nearest",
 *           width?: number, height?: number }} spec
 *   `angle` is in DEGREES, clockwise on screen (Y grows downward here, so a
 *   positive angle turns the way the number reads). `pivot` defaults to the
 *   centre of the output.
 * @returns {PixelBuffer}
 */
export function transformBuffer(buffer, {
  scaleX = 1,
  scaleY = 1,
  angle = 0,
  offsetX = 0,
  offsetY = 0,
  pivot = null,
  filter = "bilinear",
  width = buffer.width,
  height = buffer.height,
} = {}) {
  const out = createBuffer(width, height);
  const sw = buffer.width;
  const sh = buffer.height;
  const src = buffer.data;
  const dst = out.data;

  const px = pivot ? pivot[0] : width / 2;
  const py = pivot ? pivot[1] : height / 2;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Guard against a zero scale: it is a legal thing to type and an illegal
  // thing to divide by, and the honest answer is "nothing is visible".
  const sx = Math.abs(scaleX) < 1e-6 ? 0 : 1 / scaleX;
  const sy = Math.abs(scaleY) < 1e-6 ? 0 : 1 / scaleY;
  if (sx === 0 || sy === 0) return out;

  const nearest = filter === "nearest";

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Undo the transform: translate, un-rotate, un-scale, back to the pivot.
      const dx = x + 0.5 - px - offsetX;
      const dy = y + 0.5 - py - offsetY;
      const rx = (dx * cos + dy * sin) * sx + px;
      const ry = (-dx * sin + dy * cos) * sy + py;

      const di = (y * width + x) * 4;
      if (nearest) {
        const ix = Math.floor(rx);
        const iy = Math.floor(ry);
        if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) continue;
        const si = (iy * sw + ix) * 4;
        dst[di] = src[si];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2];
        dst[di + 3] = src[si + 3];
        continue;
      }

      const fx = rx - 0.5;
      const fy = ry - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      // One texel of slack: a sample whose four taps are all outside the source
      // contributes nothing, but one straddling the edge must still blend with
      // the transparent side rather than being dropped.
      if (x0 < -1 || y0 < -1 || x0 > sw - 1 || y0 > sh - 1) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < 2; j++) {
        const yy = y0 + j;
        if (yy < 0 || yy >= sh) continue;
        const wy = j ? ty : 1 - ty;
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          if (xx < 0 || xx >= sw) continue;
          const w = (i ? tx : 1 - tx) * wy;
          if (w <= 0) continue;
          const si = (yy * sw + xx) * 4;
          const sa = (src[si + 3] / 255) * w;
          r += src[si] * sa;
          g += src[si + 1] * sa;
          b += src[si + 2] * sa;
          a += sa;
        }
      }
      if (a <= 0) continue;
      dst[di] = r / a;
      dst[di + 1] = g / a;
      dst[di + 2] = b / a;
      dst[di + 3] = a * 255;
    }
  }
  return out;
}

/**
 * The size a transformed layer would need to stay whole.
 *
 * Offered so a rotate can report "this will be clipped" rather than silently
 * cutting the corners off — a 45° rotation of a full-bleed layer always loses
 * something, and being told beforehand is the difference between a choice and
 * an accident.
 */
export function transformedBounds(width, height, { scaleX = 1, scaleY = 1, angle = 0 } = {}) {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const w = (width * Math.abs(scaleX)) / 2;
  const h = (height * Math.abs(scaleY)) / 2;
  const ex = Math.abs(w * cos) + Math.abs(h * sin);
  const ey = Math.abs(w * sin) + Math.abs(h * cos);
  return { width: Math.ceil(ex * 2), height: Math.ceil(ey * 2) };
}

/** True when the transform would push content outside the canvas. */
export function transformClips(width, height, spec) {
  const bounds = transformedBounds(width, height, spec);
  return bounds.width > width || bounds.height > height;
}
