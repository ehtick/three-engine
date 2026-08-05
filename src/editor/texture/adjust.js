/**
 * Tonal and colour adjustments.
 *
 * Every one is registered in `ADJUSTMENTS` with its parameters declared, so the
 * panel builds the dialog — sliders, ranges, defaults, live preview — from the
 * registry rather than hand-writing a component per adjustment. Adding one is a
 * dozen lines here and nothing in the UI.
 *
 * Two rules the implementations share:
 *
 * **Alpha is never touched.** An adjustment describes colour; brightening a
 * sprite must not thicken its edges. The only operation here that writes alpha
 * is the one whose entire purpose is alpha, and it lives in `channels.js`.
 *
 * **The selection is a blend, not a clip.** The result is interpolated toward
 * the original by the selection's coverage, so a feathered selection produces a
 * feathered adjustment instead of a hard-edged one with soft sides.
 */

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

import { parseColor } from "./pixels.js";

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Applies a per-channel lookup table.
 *
 * Most adjustments are a pure function of one channel value, which means 256
 * evaluations instead of one per texel — a 2K document is four million texels,
 * so the difference between a LUT and a per-pixel `Math.pow` is the difference
 * between an instant preview and a visible stall on every slider tick.
 */
export function applyLut(buffer, lut, selection = null) {
  const { data } = buffer;
  const r = lut.r ?? lut;
  const g = lut.g ?? lut;
  const b = lut.b ?? lut;
  const count = data.length / 4;
  for (let i = 0; i < count; i++) {
    const s = selection ? selection[i] / 255 : 1;
    if (s <= 0) continue;
    const d = i * 4;
    if (s >= 1) {
      data[d] = r[data[d]];
      data[d + 1] = g[data[d + 1]];
      data[d + 2] = b[data[d + 2]];
    } else {
      data[d] += (r[data[d]] - data[d]) * s;
      data[d + 1] += (g[data[d + 1]] - data[d + 1]) * s;
      data[d + 2] += (b[data[d + 2]] - data[d + 2]) * s;
    }
  }
  return buffer;
}

/** Per-pixel adjustments that can't be expressed as an independent-channel LUT. */
function applyPixel(buffer, fn, selection = null) {
  const { data } = buffer;
  const out = [0, 0, 0];
  const count = data.length / 4;
  for (let i = 0; i < count; i++) {
    const s = selection ? selection[i] / 255 : 1;
    if (s <= 0) continue;
    const d = i * 4;
    fn(data[d], data[d + 1], data[d + 2], out);
    data[d] += (clamp255(out[0]) - data[d]) * s;
    data[d + 1] += (clamp255(out[1]) - data[d + 1]) * s;
    data[d + 2] += (clamp255(out[2]) - data[d + 2]) * s;
  }
  return buffer;
}

const identityLut = () => {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
};

const buildLut = (fn) => {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp255(fn(i));
  return lut;
};

// --- colour space helpers ---------------------------------------------------

/** Rec. 709 luma. Using it rather than a plain average is why "desaturate"
 *  keeps a red and a blue of equal *brightness* looking equally bright. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function rgbToHsl(r, g, b, out = [0, 0, 0]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  out[0] = h;
  out[1] = s;
  out[2] = l;
  return out;
}

function hueToRgb(p, q, t) {
  let v = t;
  if (v < 0) v += 1;
  if (v > 1) v -= 1;
  if (v < 1 / 6) return p + (q - p) * 6 * v;
  if (v < 1 / 2) return q;
  if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
  return p;
}

export function hslToRgb(h, s, l, out = [0, 0, 0]) {
  if (s === 0) {
    out[0] = out[1] = out[2] = l * 255;
    return out;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hueToRgb(p, q, h + 1 / 3) * 255;
  out[1] = hueToRgb(p, q, h) * 255;
  out[2] = hueToRgb(p, q, h - 1 / 3) * 255;
  return out;
}

// --- the adjustments --------------------------------------------------------

export function brightnessContrast(buffer, { brightness = 0, contrast = 0 } = {}, selection = null) {
  // Contrast pivots on mid-grey, and the curve is `tan`-shaped rather than
  // linear so the slider stays useful at both ends: a linear multiplier hits
  // full clipping halfway along and does nothing perceptible in the first third.
  const c = Math.tan(((Math.max(-0.99, Math.min(0.99, contrast)) + 1) * Math.PI) / 4);
  const b = brightness * 255;
  return applyLut(buffer, buildLut((v) => (v - 128) * c + 128 + b), selection);
}

/**
 * Levels: remap [black, white] to [outBlack, outWhite] with a gamma in between.
 *
 * The single most useful adjustment for texture work — an albedo scan that is
 * too flat, a height map that does not use its full range, a mask whose edges
 * are mush. Curves is deliberately not implemented: it is a photo-retouching
 * tool, and everything a texture needs from it, levels does with five numbers
 * that can be typed and reproduced.
 */
export function levels(
  buffer,
  { black = 0, white = 255, gamma = 1, outBlack = 0, outWhite = 255 } = {},
  selection = null,
) {
  const lo = Math.min(black, white - 1);
  const span = Math.max(1, white - lo);
  const g = 1 / Math.max(0.01, gamma);
  return applyLut(
    buffer,
    buildLut((v) => {
      const t = Math.min(1, Math.max(0, (v - lo) / span));
      return outBlack + Math.pow(t, g) * (outWhite - outBlack);
    }),
    selection,
  );
}

export function hueSaturation(
  buffer,
  { hue = 0, saturation = 0, lightness = 0 } = {},
  selection = null,
) {
  const hueShift = hue / 360;
  const satScale = 1 + saturation;
  const hsl = [0, 0, 0];
  return applyPixel(
    buffer,
    (r, g, b, out) => {
      rgbToHsl(r, g, b, hsl);
      let h = hsl[0] + hueShift;
      h -= Math.floor(h);
      const s = Math.min(1, Math.max(0, hsl[1] * satScale));
      // Lightness pushes toward black/white rather than scaling, so +1 is
      // white and −1 is black instead of "somewhat brighter".
      const l = lightness >= 0 ? hsl[2] + (1 - hsl[2]) * lightness : hsl[2] * (1 + lightness);
      hslToRgb(h, s, Math.min(1, Math.max(0, l)), out);
    },
    selection,
  );
}

export function invert(buffer, _params, selection = null) {
  return applyLut(buffer, buildLut((v) => 255 - v), selection);
}

export function grayscale(buffer, { mode = "luminance" } = {}, selection = null) {
  return applyPixel(
    buffer,
    (r, g, b, out) => {
      const v =
        mode === "average" ? (r + g + b) / 3 : mode === "max" ? Math.max(r, g, b) : luminance(r, g, b);
      out[0] = out[1] = out[2] = v;
    },
    selection,
  );
}

export function threshold(buffer, { level = 128 } = {}, selection = null) {
  return applyPixel(
    buffer,
    (r, g, b, out) => {
      const v = luminance(r, g, b) >= level ? 255 : 0;
      out[0] = out[1] = out[2] = v;
    },
    selection,
  );
}

export function posterize(buffer, { steps = 4 } = {}, selection = null) {
  const n = Math.max(2, Math.round(steps));
  return applyLut(buffer, buildLut((v) => Math.round((Math.round((v / 255) * (n - 1)) / (n - 1)) * 255)), selection);
}

/**
 * A colour parameter arrives as a hex STRING from the registry (that is what
 * the dialog's colour input produces) and as an array from code. Accepting
 * only one of the two is how `colorize` came to multiply `"#"` by a number,
 * produce NaN, and land as 0 in a `Uint8ClampedArray` — a silent black result
 * with nothing in the console. Any colour parameter added here must go through
 * this.
 */
const toRgb = (color) => (Array.isArray(color) ? color : parseColor(color, 255));

/** Tints while keeping the image's own luminance — the way to turn one
 *  authored texture into a set of team-coloured variants. */
export function colorize(buffer, { color = [255, 0, 0, 255], strength = 1 } = {}, selection = null) {
  const [tr, tg, tb] = toRgb(color);
  return applyPixel(
    buffer,
    (r, g, b, out) => {
      const l = luminance(r, g, b) / 255;
      out[0] = r + (tr * l - r) * strength;
      out[1] = g + (tg * l - g) * strength;
      out[2] = b + (tb * l - b) * strength;
    },
    selection,
  );
}

/**
 * Registry. `params` drives the generic adjustment dialog; `color: true` marks
 * a colour picker rather than a slider.
 */
export const ADJUSTMENTS = [
  {
    id: "brightnessContrast",
    label: "Brightness / Contrast",
    apply: brightnessContrast,
    params: [
      { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0 },
    ],
  },
  {
    id: "levels",
    label: "Levels",
    apply: levels,
    params: [
      { key: "black", label: "Input Black", min: 0, max: 254, step: 1, default: 0 },
      { key: "white", label: "Input White", min: 1, max: 255, step: 1, default: 255 },
      { key: "gamma", label: "Gamma", min: 0.1, max: 4, step: 0.01, default: 1 },
      { key: "outBlack", label: "Output Black", min: 0, max: 255, step: 1, default: 0 },
      { key: "outWhite", label: "Output White", min: 0, max: 255, step: 1, default: 255 },
    ],
  },
  {
    id: "hueSaturation",
    label: "Hue / Saturation",
    apply: hueSaturation,
    params: [
      { key: "hue", label: "Hue", min: -180, max: 180, step: 1, default: 0 },
      { key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "lightness", label: "Lightness", min: -1, max: 1, step: 0.01, default: 0 },
    ],
  },
  {
    id: "colorize",
    label: "Colorize",
    apply: colorize,
    params: [
      { key: "color", label: "Color", color: true, default: "#ff8040" },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, default: 1 },
    ],
  },
  {
    id: "threshold",
    label: "Threshold",
    apply: threshold,
    params: [{ key: "level", label: "Level", min: 0, max: 255, step: 1, default: 128 }],
  },
  {
    id: "posterize",
    label: "Posterize",
    apply: posterize,
    params: [{ key: "steps", label: "Levels", min: 2, max: 32, step: 1, default: 4 }],
  },
  {
    id: "grayscale",
    label: "Desaturate",
    apply: grayscale,
    params: [{ key: "mode", label: "Method", options: ["luminance", "average", "max"], default: "luminance" }],
  },
  { id: "invert", label: "Invert", apply: invert, params: [] },
];

export const adjustmentById = (id) => ADJUSTMENTS.find((a) => a.id === id) ?? null;

/** Default parameter object for an adjustment — what the dialog opens with. */
export function defaultParams(spec) {
  const out = {};
  for (const param of spec?.params ?? []) out[param.key] = param.default;
  return out;
}

export { identityLut };
