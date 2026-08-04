/**
 * Straight-alpha blend modes and layer compositing.
 *
 * The maths is the W3C compositing model, which is what Photoshop, GIMP and
 * every browser agree on:
 *
 *   αo = αs + αd·(1 − αs)
 *   Co = [ αs·(1 − αd)·Cs  +  αs·αd·B(Cd, Cs)  +  (1 − αs)·αd·Cd ] / αo
 *
 * The middle term is the whole point and the part naive implementations drop:
 * a blend function only applies where the two layers *both* have coverage.
 * Multiply a half-transparent shadow over an empty region and the result must
 * be the shadow itself, not black — dropping the `(1 − αd)` term is what makes
 * a multiply layer eat holes in everything below it.
 */

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Blend functions take normalised backdrop and source, return normalised. */
const FN = {
  normal: (_cd, cs) => cs,
  multiply: (cd, cs) => cd * cs,
  screen: (cd, cs) => cd + cs - cd * cs,
  darken: (cd, cs) => Math.min(cd, cs),
  lighten: (cd, cs) => Math.max(cd, cs),
  difference: (cd, cs) => Math.abs(cd - cs),
  exclusion: (cd, cs) => cd + cs - 2 * cd * cs,
  add: (cd, cs) => clamp01(cd + cs),
  subtract: (cd, cs) => clamp01(cd - cs),
  hardLight: (cd, cs) => (cs <= 0.5 ? cd * (2 * cs) : cd + (2 * cs - 1) - cd * (2 * cs - 1)),
  overlay: (cd, cs) => FN.hardLight(cs, cd),
  softLight: (cd, cs) => {
    if (cs <= 0.5) return cd - (1 - 2 * cs) * cd * (1 - cd);
    const d = cd <= 0.25 ? ((16 * cd - 12) * cd + 4) * cd : Math.sqrt(cd);
    return cd + (2 * cs - 1) * (d - cd);
  },
  colorDodge: (cd, cs) => (cd === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cd / (1 - cs))),
  colorBurn: (cd, cs) => (cd >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cd) / cs)),
};

/** Ordered for the layer blend-mode dropdown, grouped the way artists expect. */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "colorDodge",
  "colorBurn",
  "hardLight",
  "softLight",
  "difference",
  "exclusion",
  "add",
  "subtract",
];

export function blendFunction(mode) {
  return FN[mode] ?? FN.normal;
}

/**
 * Composites `src` onto `dst` in place.
 *
 * @param {PixelBuffer} dst
 * @param {PixelBuffer} src
 * @param {{ offsetX?: number, offsetY?: number, opacity?: number, blend?: string,
 *           mask?: Uint8Array|null, clip?: {x:number,y:number,width:number,height:number}|null }} [options]
 *   `mask` is per-source-pixel coverage 0..255 (a layer mask), `clip` limits
 *   writes to a destination rectangle (a selection's bounding box).
 */
export function blendInto(dst, src, options = {}) {
  const {
    offsetX = 0,
    offsetY = 0,
    opacity = 1,
    blend = "normal",
    mask = null,
    clip = null,
  } = options;
  if (opacity <= 0) return dst;

  const fn = blendFunction(blend);
  const plain = blend === "normal";
  const dw = dst.width;
  const dh = dst.height;
  const sw = src.width;
  const sh = src.height;
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);

  let x0 = Math.max(0, ox);
  let y0 = Math.max(0, oy);
  let x1 = Math.min(dw, ox + sw);
  let y1 = Math.min(dh, oy + sh);
  if (clip) {
    x0 = Math.max(x0, clip.x);
    y0 = Math.max(y0, clip.y);
    x1 = Math.min(x1, clip.x + clip.width);
    y1 = Math.min(y1, clip.y + clip.height);
  }

  const d = dst.data;
  const s = src.data;
  for (let y = y0; y < y1; y++) {
    const sy = y - oy;
    for (let x = x0; x < x1; x++) {
      const sx = x - ox;
      const si = (sy * sw + sx) * 4;
      let as = (s[si + 3] / 255) * opacity;
      if (mask) as *= mask[sy * sw + sx] / 255;
      if (as <= 0) continue;

      const di = (y * dw + x) * 4;
      const ad = d[di + 3] / 255;
      const ao = as + ad * (1 - as);
      if (ao <= 0) {
        d[di] = d[di + 1] = d[di + 2] = d[di + 3] = 0;
        continue;
      }

      // Fast path: `normal` over an empty or fully-opaque backdrop is by far
      // the most common case (every brush stroke on an empty layer), and it
      // reduces to a plain lerp with no blend-function call.
      if (plain) {
        const w = as / ao;
        d[di] = s[si] * w + d[di] * (1 - w);
        d[di + 1] = s[si + 1] * w + d[di + 1] * (1 - w);
        d[di + 2] = s[si + 2] * w + d[di + 2] * (1 - w);
        d[di + 3] = ao * 255;
        continue;
      }

      const kSrc = as * (1 - ad);
      const kBoth = as * ad;
      const kDst = (1 - as) * ad;
      for (let c = 0; c < 3; c++) {
        const cs = s[si + c] / 255;
        const cd = d[di + c] / 255;
        d[di + c] = ((kSrc * cs + kBoth * fn(cd, cs) + kDst * cd) / ao) * 255;
      }
      d[di + 3] = ao * 255;
    }
  }
  return dst;
}

/**
 * Flattens a layer stack bottom-to-top into one buffer.
 *
 * @param {Array<{ buffer: PixelBuffer, visible?: boolean, opacity?: number,
 *                 blend?: string, mask?: Uint8Array|null, offset?: [number, number] }>} layers
 */
export function compositeLayers(layers, width, height, out = null) {
  const target = out ?? {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  if (out) target.data.fill(0);
  for (const layer of layers) {
    if (!layer || layer.visible === false || !layer.buffer) continue;
    blendInto(target, layer.buffer, {
      offsetX: layer.offset?.[0] ?? 0,
      offsetY: layer.offset?.[1] ?? 0,
      opacity: layer.opacity ?? 1,
      blend: layer.blend ?? "normal",
      mask: layer.mask ?? null,
    });
  }
  return target;
}
