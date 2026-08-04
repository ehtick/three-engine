/**
 * Convolution and generator filters.
 *
 * Same registry shape as `adjust.js`, so the panel builds these dialogs the
 * same way. The difference is that a filter reads neighbouring pixels, which
 * dictates two things throughout this file:
 *
 * **Every filter reads from a snapshot and writes to the buffer.** Reading and
 * writing the same array turns a 3×3 kernel into a feedback loop whose result
 * depends on scan order — a blur that smears toward the bottom-right.
 *
 * **Anything that averages colour does it in premultiplied alpha.** Averaging
 * straight-alpha colour drags the RGB of fully transparent texels into their
 * visible neighbours, which is exactly how blurring a sprite on a transparent
 * background gives it a dark halo.
 */

import { luminance } from "./adjust.js";
import { cloneBuffer } from "./pixels.js";

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Interpolates a filtered result back toward the original by selection
 *  coverage — the same "blend, don't clip" rule the adjustments follow. */
function blendSelection(target, original, selection) {
  if (!selection) return target;
  const { data } = target;
  const src = original.data;
  const count = data.length / 4;
  for (let i = 0; i < count; i++) {
    const s = selection[i] / 255;
    if (s >= 1) continue;
    const d = i * 4;
    for (let c = 0; c < 4; c++) data[d + c] = src[d + c] + (data[d + c] - src[d + c]) * s;
  }
  return target;
}

/**
 * Three box passes ≈ a gaussian, at a fraction of the cost and with no kernel
 * to size. Separable, so the work is O(radius) per axis rather than O(radius²).
 */
export function gaussianBlur(buffer, { radius = 4 } = {}, selection = null) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return buffer;
  const original = selection ? cloneBuffer(buffer) : null;
  const { width, height } = buffer;

  // Work premultiplied for the whole run, converting once at each end.
  const premul = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = buffer.data[i * 4 + 3] / 255;
    premul[i * 4] = buffer.data[i * 4] * a;
    premul[i * 4 + 1] = buffer.data[i * 4 + 1] * a;
    premul[i * 4 + 2] = buffer.data[i * 4 + 2] * a;
    premul[i * 4 + 3] = buffer.data[i * 4 + 3];
  }

  let src = premul;
  let dst = new Float32Array(premul.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let r0 = 0;
          let g0 = 0;
          let b0 = 0;
          let a0 = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const sx = horizontal ? x + k : x;
            const sy = horizontal ? y : y + k;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const s = (sy * width + sx) * 4;
            r0 += src[s];
            g0 += src[s + 1];
            b0 += src[s + 2];
            a0 += src[s + 3];
            n++;
          }
          const d = (y * width + x) * 4;
          dst[d] = r0 / n;
          dst[d + 1] = g0 / n;
          dst[d + 2] = b0 / n;
          dst[d + 3] = a0 / n;
        }
      }
      const swap = src === premul ? new Float32Array(premul.length) : src;
      src = dst;
      dst = swap;
    }
  }

  for (let i = 0; i < width * height; i++) {
    const a = src[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    buffer.data[i * 4] = src[i * 4] * inv;
    buffer.data[i * 4 + 1] = src[i * 4 + 1] * inv;
    buffer.data[i * 4 + 2] = src[i * 4 + 2] * inv;
    buffer.data[i * 4 + 3] = a;
  }
  return blendSelection(buffer, original, selection);
}

/** Unsharp mask: the image plus its own difference from a blurred copy. A
 *  fixed 3×3 sharpen kernel has no radius, so it can only ever sharpen detail
 *  at one scale — useless on a downscaled texture. */
export function sharpen(buffer, { amount = 0.6, radius = 2 } = {}, selection = null) {
  const original = cloneBuffer(buffer);
  const blurred = gaussianBlur(cloneBuffer(buffer), { radius });
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = clamp255(original.data[i + c] + (original.data[i + c] - blurred.data[i + c]) * amount);
    }
  }
  return blendSelection(buffer, original, selection);
}

/** Generic 3×3 convolution over RGB, alpha preserved. */
function convolve3(buffer, kernel, { bias = 0, divisor = 1, grayscale = false } = {}, selection = null) {
  const original = cloneBuffer(buffer);
  const { width, height, data } = buffer;
  const src = original.data;
  const div = divisor || 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.min(width - 1, Math.max(0, x + kx));
          const sy = Math.min(height - 1, Math.max(0, y + ky));
          const w = kernel[(ky + 1) * 3 + (kx + 1)];
          if (!w) continue;
          const s = (sy * width + sx) * 4;
          r += src[s] * w;
          g += src[s + 1] * w;
          b += src[s + 2] * w;
        }
      }
      const d = (y * width + x) * 4;
      r = r / div + bias;
      g = g / div + bias;
      b = b / div + bias;
      if (grayscale) r = g = b = luminance(r, g, b);
      data[d] = clamp255(r);
      data[d + 1] = clamp255(g);
      data[d + 2] = clamp255(b);
    }
  }
  return blendSelection(buffer, original, selection);
}

export function emboss(buffer, _params, selection = null) {
  return convolve3(buffer, [-2, -1, 0, -1, 1, 1, 0, 1, 2], { bias: 0, grayscale: true }, selection);
}

export function edgeDetect(buffer, { strength = 1 } = {}, selection = null) {
  const k = strength;
  return convolve3(buffer, [0, -k, 0, -k, 4 * k, -k, 0, -k, 0], { bias: 0 }, selection);
}

/**
 * Deterministic noise — seeded, never `Math.random()`. Re-opening the dialog
 * with the same seed must give the same grain, or "a bit less noise" means
 * re-rolling the whole texture and losing the version you liked.
 */
export function noise(buffer, { amount = 0.15, monochrome = true, seed = 1 } = {}, selection = null) {
  const original = selection ? cloneBuffer(buffer) : null;
  const { data } = buffer;
  let state = (Math.round(seed) || 1) >>> 0;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967295;
  };
  for (let i = 0; i < data.length; i += 4) {
    if (monochrome) {
      const n = (next() - 0.5) * 2 * amount * 255;
      data[i] = clamp255(data[i] + n);
      data[i + 1] = clamp255(data[i + 1] + n);
      data[i + 2] = clamp255(data[i + 2] + n);
    } else {
      for (let c = 0; c < 3; c++) data[i + c] = clamp255(data[i + c] + (next() - 0.5) * 2 * amount * 255);
    }
  }
  return blendSelection(buffer, original, selection);
}

/**
 * Wrap-around offset — the seam-fixing tool.
 *
 * Shift a tiling texture by half its size and the seam that was at the edge is
 * now in the middle where it can be painted out. Nothing else in the editor can
 * do this, and without it "make this tile" is guesswork.
 */
export function offset(buffer, { dx = 0, dy = 0 } = {}) {
  const { width, height, data } = buffer;
  const src = new Uint8ClampedArray(data);
  const ox = ((Math.round(dx) % width) + width) % width;
  const oy = ((Math.round(dy) % height) + height) % height;
  if (!ox && !oy) return buffer;
  for (let y = 0; y < height; y++) {
    const sy = (y - oy + height) % height;
    for (let x = 0; x < width; x++) {
      const sx = (x - ox + width) % width;
      const s = (sy * width + sx) * 4;
      const d = (y * width + x) * 4;
      data[d] = src[s];
      data[d + 1] = src[s + 1];
      data[d + 2] = src[s + 2];
      data[d + 3] = src[s + 3];
    }
  }
  return buffer;
}

/**
 * Height → tangent-space normal map, by Sobel gradient of the luminance.
 *
 * `wrap` is on by default because the texture this is run on is almost always
 * a tiling surface, and clamping at the border produces a visible seam in the
 * normal map of an otherwise seamless height map.
 *
 * Green is +Y (OpenGL convention, which is what three.js expects). `invertY`
 * flips it for DirectX-convention assets rather than making anyone re-bake.
 */
export function normalFromHeight(buffer, { strength = 2, invertY = false, wrap = true } = {}) {
  const { width, height, data } = buffer;
  const src = new Uint8ClampedArray(data);
  const at = (x, y) => {
    let sx = x;
    let sy = y;
    if (wrap) {
      sx = ((x % width) + width) % width;
      sy = ((y % height) + height) % height;
    } else {
      sx = Math.min(width - 1, Math.max(0, x));
      sy = Math.min(height - 1, Math.max(0, y));
    }
    const i = (sy * width + sx) * 4;
    return luminance(src[i], src[i + 1], src[i + 2]) / 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = gx * strength;
      let ny = (invertY ? -gy : gy) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const d = (y * width + x) * 4;
      data[d] = (nx * 0.5 + 0.5) * 255;
      data[d + 1] = (ny * 0.5 + 0.5) * 255;
      data[d + 2] = (nz / len) * 0.5 * 255 + 127.5;
      data[d + 3] = 255;
    }
  }
  return buffer;
}

/** 3×3 median — removes salt-and-pepper speckle from a scan or a photo without
 *  the softening a blur costs. Per channel, which is standard and cheap. */
export function median(buffer, _params, selection = null) {
  const original = cloneBuffer(buffer);
  const { width, height, data } = buffer;
  const src = original.data;
  const window = new Array(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const sx = Math.min(width - 1, Math.max(0, x + kx));
            const sy = Math.min(height - 1, Math.max(0, y + ky));
            window[n++] = src[(sy * width + sx) * 4 + c];
          }
        }
        window.length = n;
        window.sort((a, b) => a - b);
        data[d + c] = window[n >> 1];
        window.length = 9;
      }
    }
  }
  return blendSelection(buffer, original, selection);
}

export const FILTERS = [
  {
    id: "blur",
    label: "Blur",
    apply: gaussianBlur,
    params: [{ key: "radius", label: "Radius", min: 0, max: 64, step: 1, default: 4 }],
  },
  {
    id: "sharpen",
    label: "Sharpen",
    apply: sharpen,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 3, step: 0.05, default: 0.6 },
      { key: "radius", label: "Radius", min: 1, max: 16, step: 1, default: 2 },
    ],
  },
  {
    id: "noise",
    label: "Noise",
    apply: noise,
    params: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.15 },
      { key: "monochrome", label: "Monochrome", toggle: true, default: true },
      { key: "seed", label: "Seed", min: 1, max: 9999, step: 1, default: 1 },
    ],
  },
  {
    id: "offset",
    label: "Offset (seam check)",
    apply: offset,
    wholeLayer: true,
    params: [
      { key: "dx", label: "X", min: -2048, max: 2048, step: 1, default: 0, halfDefault: "width" },
      { key: "dy", label: "Y", min: -2048, max: 2048, step: 1, default: 0, halfDefault: "height" },
    ],
  },
  {
    id: "normalFromHeight",
    label: "Normal from Height",
    apply: normalFromHeight,
    wholeLayer: true,
    params: [
      { key: "strength", label: "Strength", min: 0.1, max: 10, step: 0.1, default: 2 },
      { key: "invertY", label: "Invert Y (DirectX)", toggle: true, default: false },
      { key: "wrap", label: "Tiling", toggle: true, default: true },
    ],
  },
  { id: "edgeDetect", label: "Edge Detect", apply: edgeDetect, params: [
    { key: "strength", label: "Strength", min: 0.1, max: 4, step: 0.1, default: 1 },
  ] },
  { id: "emboss", label: "Emboss", apply: emboss, params: [] },
  { id: "median", label: "Median (despeckle)", apply: median, params: [] },
];

export const filterById = (id) => FILTERS.find((f) => f.id === id) ?? null;
