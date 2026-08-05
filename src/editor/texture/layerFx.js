/**
 * Layer effects — the non-destructive decorations a layer carries with it.
 *
 * Every effect is derived from the layer's **alpha**, never from its colour:
 * an outline traces the shape, a shadow is the shape offset and blurred, a glow
 * is the shape spread. That is what makes them work on artwork the author has
 * not drawn yet — paint into the layer and the outline follows, which is the
 * whole reason to have effects rather than a second layer you keep in sync by
 * hand.
 *
 * The result is two buffers per layer, `under` and `over`, composited either
 * side of it. Keeping them separate (rather than baking one buffer) is what
 * lets a shadow sit behind the artwork while a colour overlay sits on top of
 * it, without either being applied to the other.
 *
 * Pure: no DOM, no three.js. Same alpha rules as everything else here.
 */

import { gaussianBlur } from "./filters.js";
import { createBuffer, parseColor } from "./pixels.js";

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */
/** @typedef {{ id: string, enabled?: boolean, [key: string]: any }} LayerEffect */

/** Alpha-only copy of a buffer, tinted flat — the raw material for every
 *  shape-derived effect. */
function silhouette(buffer, color, { offsetX = 0, offsetY = 0 } = {}) {
  const { width, height, data } = buffer;
  const out = createBuffer(width, height);
  const [r, g, b, a] = color;
  const dx = Math.round(offsetX);
  const dy = Math.round(offsetY);
  // The colour is written EVERYWHERE, alpha only where the shape is. Writing it
  // just where alpha lands looks equivalent and is not: `dilateAlpha` grows the
  // alpha into texels that were never coloured, so an outline comes out black
  // whatever colour was asked for — and a blurred shadow smears black into its
  // own soft edge. RGB under zero alpha costs nothing and means every later
  // pass finds the colour already there.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
  }
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      const alpha = data[(sy * width + sx) * 4 + 3];
      if (!alpha) continue;
      out.data[(y * width + x) * 4 + 3] = (alpha * a) / 255;
    }
  }
  return out;
}

/**
 * Grows the alpha outward by `radius` texels (chebyshev, separable).
 *
 * A blur-and-threshold would be shorter and is wrong: it rounds off corners and
 * makes the outline's thickness depend on the artwork's own softness, so a
 * hand-drawn sprite and a hard-edged one get visibly different outlines from
 * the same setting.
 */
function dilateAlpha(buffer, radius) {
  const r = Math.max(0, Math.round(radius));
  if (!r) return buffer;
  const { width, height, data } = buffer;
  let src = new Uint8ClampedArray(data.length / 4);
  for (let i = 0; i < src.length; i++) src[i] = data[i * 4 + 3];
  let dst = new Uint8ClampedArray(src.length);

  for (const horizontal of [true, false]) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = 0;
        for (let k = -r; k <= r; k++) {
          const sx = horizontal ? x + k : x;
          const sy = horizontal ? y : y + k;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          const v = src[sy * width + sx];
          if (v > best) best = v;
        }
        dst[y * width + x] = best;
      }
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  for (let i = 0; i < src.length; i++) data[i * 4 + 3] = src[i];
  return buffer;
}

/** Punches the layer's own shape out of a buffer — an outline must not show
 *  through semi-transparent artwork, and a glow must not wash it out. */
function knockOut(target, source) {
  const { data } = target;
  const src = source.data;
  for (let i = 3; i < data.length; i += 4) {
    const inside = src[i] / 255;
    if (inside <= 0) continue;
    data[i] *= 1 - inside;
  }
  return target;
}

// --- the effects ------------------------------------------------------------

function outline(buffer, { size = 2, color = "#000000", opacity = 1 } = {}) {
  const shape = silhouette(buffer, parseColor(color, Math.round(opacity * 255)));
  dilateAlpha(shape, size);
  knockOut(shape, buffer);
  return { under: shape };
}

function dropShadow(buffer, {
  distance = 4,
  angle = 135,
  blur = 4,
  color = "#000000",
  opacity = 0.6,
  spread = 0,
} = {}) {
  const radians = (angle * Math.PI) / 180;
  const shadow = silhouette(buffer, parseColor(color, Math.round(opacity * 255)), {
    offsetX: Math.cos(radians) * distance,
    offsetY: Math.sin(radians) * distance,
  });
  if (spread > 0) dilateAlpha(shadow, spread);
  if (blur > 0) gaussianBlur(shadow, { radius: blur });
  return { under: shadow };
}

function outerGlow(buffer, { size = 6, color = "#ffd60a", opacity = 0.8 } = {}) {
  const glow = silhouette(buffer, parseColor(color, Math.round(opacity * 255)));
  dilateAlpha(glow, Math.max(1, Math.round(size / 2)));
  gaussianBlur(glow, { radius: Math.max(1, Math.round(size / 2)) });
  knockOut(glow, buffer);
  return { under: glow };
}

function colorOverlay(buffer, { color = "#ff3b30", opacity = 1 } = {}) {
  // Clipped to the layer's own alpha, so it tints the artwork rather than
  // painting a rectangle over the document.
  return { over: silhouette(buffer, parseColor(color, Math.round(opacity * 255))) };
}

/**
 * Registry. `params` drives the effect editor the same way `ADJUSTMENTS` drives
 * its dialog — a new effect is a dozen lines here and nothing in the UI.
 */
export const LAYER_EFFECTS = [
  {
    id: "outline",
    label: "Outline",
    apply: outline,
    params: [
      { key: "size", label: "Size", min: 1, max: 32, step: 1, default: 2 },
      { key: "color", label: "Color", color: true, default: "#000000" },
      { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, default: 1 },
    ],
  },
  {
    id: "dropShadow",
    label: "Drop Shadow",
    apply: dropShadow,
    params: [
      { key: "distance", label: "Distance", min: 0, max: 64, step: 1, default: 4 },
      { key: "angle", label: "Angle", min: 0, max: 360, step: 1, default: 135 },
      { key: "blur", label: "Blur", min: 0, max: 40, step: 1, default: 4 },
      { key: "spread", label: "Spread", min: 0, max: 20, step: 1, default: 0 },
      { key: "color", label: "Color", color: true, default: "#000000" },
      { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    id: "outerGlow",
    label: "Outer Glow",
    apply: outerGlow,
    params: [
      { key: "size", label: "Size", min: 1, max: 48, step: 1, default: 6 },
      { key: "color", label: "Color", color: true, default: "#ffd60a" },
      { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, default: 0.8 },
    ],
  },
  {
    id: "colorOverlay",
    label: "Color Overlay",
    apply: colorOverlay,
    params: [
      { key: "color", label: "Color", color: true, default: "#ff3b30" },
      { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, default: 1 },
    ],
  },
];

export const effectById = (id) => LAYER_EFFECTS.find((e) => e.id === id) ?? null;

export function defaultEffect(id) {
  const spec = effectById(id);
  if (!spec) return null;
  const params = {};
  for (const param of spec.params) params[param.key] = param.default;
  return { id, enabled: true, ...params };
}

/**
 * Renders a layer's effects.
 *
 * Effects are evaluated in registry order, not authoring order, so a shadow is
 * always behind an outline regardless of the sequence they were added in —
 * a stacking order the author has to maintain by hand is a bug generator, and
 * nobody wants a shadow in front of the outline it is a shadow of.
 *
 * @param {PixelBuffer} buffer the layer's own pixels
 * @param {LayerEffect[]} effects
 * @returns {{ under: PixelBuffer[], over: PixelBuffer[] }}
 */
export function renderLayerEffects(buffer, effects) {
  const under = [];
  const over = [];
  if (!effects?.length) return { under, over };
  for (const spec of LAYER_EFFECTS) {
    for (const effect of effects) {
      if (effect.id !== spec.id || effect.enabled === false) continue;
      const result = spec.apply(buffer, effect);
      if (result.under) under.push(result.under);
      if (result.over) over.push(result.over);
    }
  }
  // `under` is built shadow-first; compositing wants the furthest thing drawn
  // first, which is the same order.
  return { under, over };
}

/** True when a layer has anything that needs rendering. */
export const hasEffects = (layer) => (layer?.effects ?? []).some((e) => e.enabled !== false);
