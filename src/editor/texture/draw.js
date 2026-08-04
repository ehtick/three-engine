/**
 * Rasterizers: brush, shapes, flood fill, gradients.
 *
 * Everything paints through a **stroke coverage buffer** rather than writing
 * pixels directly, and that indirection is the difference between a brush that
 * feels right and one that doesn't. A brush is stamped many times per gesture —
 * a fast drag at 120Hz over a 3px spacing is hundreds of stamps — and
 * compositing each stamp onto the layer means a 30%-opacity brush reaches
 * 100% within one flick, with dark blotches wherever the pointer slowed down.
 * Accumulating coverage with `max()` and compositing the finished stroke
 * **once** gives the whole gesture exactly the requested opacity, whatever the
 * pointer did.
 *
 * It also makes an in-progress stroke free to preview (composite the coverage
 * onto a copy of the layer over the dirty rectangle only), free to cancel, and
 * exactly one undo entry.
 */

import { blendFunction } from "./blend.js";

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */
/** @typedef {{ width: number, height: number, coverage: Uint8Array,
 *              dirty: { x0: number, y0: number, x1: number, y1: number } }} Stroke */

/** @returns {Stroke} */
export function createStroke(width, height) {
  return {
    width,
    height,
    coverage: new Uint8Array(width * height),
    dirty: { x0: width, y0: height, x1: 0, y1: 0 },
  };
}

export function strokeIsEmpty(stroke) {
  return stroke.dirty.x1 <= stroke.dirty.x0 || stroke.dirty.y1 <= stroke.dirty.y0;
}

function markDirty(stroke, x0, y0, x1, y1) {
  const d = stroke.dirty;
  if (x0 < d.x0) d.x0 = Math.max(0, x0);
  if (y0 < d.y0) d.y0 = Math.max(0, y0);
  if (x1 > d.x1) d.x1 = Math.min(stroke.width, x1);
  if (y1 > d.y1) d.y1 = Math.min(stroke.height, y1);
}

/**
 * One brush dab.
 *
 * `hardness` 1 is a hard antialiased circle; 0 fades from the centre. The
 * falloff is smoothstep rather than linear because a linear edge on a soft
 * brush produces a visible ring at the point the gradient stops — the
 * discontinuity in the *derivative* is what the eye catches, not the value.
 */
export function stampBrush(stroke, cx, cy, radius, hardness = 1, flow = 1) {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const x1 = Math.min(stroke.width, Math.ceil(cx + r + 1));
  const y1 = Math.min(stroke.height, Math.ceil(cy + r + 1));
  if (x1 <= x0 || y1 <= y0) return stroke;

  // A hard brush still gets a one-pixel ramp: a binary circle at radius 2 is
  // visibly a plus sign, and at any radius it aliases along the edge.
  const inner = Math.max(0, r * Math.min(1, Math.max(0, hardness)) - (hardness >= 1 ? 1 : 0));
  const cov = stroke.coverage;
  const w = stroke.width;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r) continue;
      let a;
      if (d <= inner) a = 1;
      else {
        const t = 1 - (d - inner) / (r - inner);
        a = t * t * (3 - 2 * t);
      }
      a *= flow;
      const i = y * w + x;
      const v = a * 255;
      if (v > cov[i]) cov[i] = v;
    }
  }
  markDirty(stroke, x0, y0, x1, y1);
  return stroke;
}

/**
 * Stamps along a segment at `spacing` (in pixels).
 *
 * Pointer events arrive far apart when the cursor moves fast — interpolating
 * is the difference between a line and a row of dots. Returns the leftover
 * distance so the next segment continues the same rhythm instead of restarting
 * the spacing at every event, which is what makes a fast curve look beaded.
 */
export function strokeSegment(stroke, x0, y0, x1, y1, { radius, hardness = 1, flow = 1, spacing = 0.25, carry = 0 } = {}) {
  const step = Math.max(0.5, spacing * radius * 2);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    if (carry <= 0) {
      stampBrush(stroke, x0, y0, radius, hardness, flow);
      return step;
    }
    return carry;
  }
  const ux = dx / length;
  const uy = dy / length;
  let travelled = -carry;
  while (travelled + step <= length) {
    travelled += step;
    stampBrush(stroke, x0 + ux * travelled, y0 + uy * travelled, radius, hardness, flow);
  }
  return length - travelled;
}

/** Axis-aligned rectangle into a stroke buffer (crisp — a rect's whole point). */
export function strokeRect(stroke, rect, { fill = true, lineWidth = 1 } = {}) {
  const x0 = Math.round(Math.min(rect.x, rect.x + rect.width));
  const y0 = Math.round(Math.min(rect.y, rect.y + rect.height));
  const x1 = Math.round(Math.max(rect.x, rect.x + rect.width));
  const y1 = Math.round(Math.max(rect.y, rect.y + rect.height));
  const cov = stroke.coverage;
  const w = stroke.width;
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= stroke.width || y >= stroke.height) return;
    cov[y * w + x] = 255;
  };
  if (fill) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y);
  } else {
    const t = Math.max(1, Math.round(lineWidth));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x - x0 < t || x1 - 1 - x < t || y - y0 < t || y1 - 1 - y < t) set(x, y);
      }
    }
  }
  markDirty(stroke, x0, y0, x1, y1);
  return stroke;
}

export function strokeEllipse(stroke, rect, { fill = true, lineWidth = 1 } = {}) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = Math.abs(rect.width) / 2;
  const ry = Math.abs(rect.height) / 2;
  if (rx < 0.5 || ry < 0.5) return stroke;
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const x1 = Math.min(stroke.width, Math.ceil(cx + rx + 1));
  const y1 = Math.min(stroke.height, Math.ceil(cy + ry + 1));
  const cov = stroke.coverage;
  const w = stroke.width;
  const t = Math.max(1, lineWidth);
  const feather = 1 / Math.max(1, Math.min(rx, ry));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      if (fill) {
        a = d <= 1 - feather ? 1 : d >= 1 ? 0 : (1 - d) / feather;
      } else {
        const innerEdge = 1 - (t * feather);
        if (d <= 1 && d >= innerEdge) a = 1;
        else if (d > 1 && d < 1 + feather) a = (1 + feather - d) / feather;
      }
      if (a <= 0) continue;
      const i = y * w + x;
      const v = a * 255;
      if (v > cov[i]) cov[i] = v;
    }
  }
  markDirty(stroke, x0, y0, x1, y1);
  return stroke;
}

/**
 * Composites a finished (or in-progress) stroke onto a buffer.
 *
 * `erase` scales alpha down instead of blending colour in — the correct
 * operation for straight alpha, and the reason an eraser here leaves the RGB
 * of half-erased pixels intact rather than pulling them toward black.
 *
 * @param {PixelBuffer} target
 * @param {Stroke} stroke
 */
export function applyStroke(target, stroke, {
  color = [0, 0, 0, 255],
  opacity = 1,
  erase = false,
  blend = "normal",
  selection = null,
  clip = null,
} = {}) {
  // `clip` is how a live stroke stays cheap: the panel restores the segment's
  // rectangle from the pre-stroke copy and re-applies only there, instead of
  // re-compositing a growing dirty region on every pointer move.
  const x0 = Math.max(stroke.dirty.x0, clip?.x0 ?? 0);
  const y0 = Math.max(stroke.dirty.y0, clip?.y0 ?? 0);
  const x1 = Math.min(stroke.dirty.x1, clip?.x1 ?? target.width);
  const y1 = Math.min(stroke.dirty.y1, clip?.y1 ?? target.height);
  if (x1 <= x0 || y1 <= y0) return target;
  const w = target.width;
  const d = target.data;
  const cov = stroke.coverage;
  const fn = blendFunction(blend);
  const plain = blend === "normal";
  const [cr, cg, cb, ca] = color;
  const srcAlphaBase = (ca / 255) * opacity;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      let c = cov[i] / 255;
      if (c <= 0) continue;
      if (selection) {
        c *= selection[i] / 255;
        if (c <= 0) continue;
      }
      const di = i * 4;

      if (erase) {
        d[di + 3] = d[di + 3] * (1 - c * opacity);
        continue;
      }

      const as = srcAlphaBase * c;
      if (as <= 0) continue;
      const ad = d[di + 3] / 255;
      const ao = as + ad * (1 - as);
      if (ao <= 0) {
        d[di] = d[di + 1] = d[di + 2] = d[di + 3] = 0;
        continue;
      }
      if (plain) {
        const k = as / ao;
        d[di] = cr * k + d[di] * (1 - k);
        d[di + 1] = cg * k + d[di + 1] * (1 - k);
        d[di + 2] = cb * k + d[di + 2] * (1 - k);
        d[di + 3] = ao * 255;
        continue;
      }
      const kSrc = as * (1 - ad);
      const kBoth = as * ad;
      const kDst = (1 - as) * ad;
      const src = [cr / 255, cg / 255, cb / 255];
      for (let ch = 0; ch < 3; ch++) {
        const cd = d[di + ch] / 255;
        d[di + ch] = ((kSrc * src[ch] + kBoth * fn(cd, src[ch]) + kDst * cd) / ao) * 255;
      }
      d[di + 3] = ao * 255;
    }
  }
  return target;
}

/**
 * Paint bucket. Shares the wand's tolerance metric so "select this region" and
 * "fill this region" agree about where the region ends — an editor where the
 * bucket and the wand disagree at the same tolerance is maddening to use.
 *
 * `contiguous: false` replaces the colour everywhere it appears, which is the
 * fastest way to recolour flat sprite art.
 */
export function floodFill(target, x, y, {
  tolerance = 0.1,
  contiguous = true,
  selection = null,
  antialias = true,
} = {}) {
  const { width, height, data } = target;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const stroke = createStroke(width, height);
  const seed = (y * width + x) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];

  const distance = (i) => {
    const dr = data[i] - sr;
    const dg = data[i + 1] - sg;
    const db = data[i + 2] - sb;
    const da = data[i + 3] - sa;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 510;
  };
  // Partial coverage near the tolerance boundary softens the edge of a fill on
  // antialiased artwork; without it, filling inside a drawn outline leaves a
  // one-pixel halo of the old colour that is invisible on screen and obvious
  // once the texture is on a model.
  //
  // The selection *bounds* the flood here rather than only masking the result,
  // so filling a small selected region on a large flat background doesn't walk
  // the whole canvas to produce a few hundred pixels. It deliberately does not
  // scale the coverage — `applyStroke` still applies the selection, and doing
  // it in both places would square the softness at a feathered edge.
  const coverageOf = (i) => {
    if (selection && selection[i >> 2] <= 0) return 0;
    const d = distance(i);
    if (d > tolerance) return 0;
    if (!antialias || tolerance <= 0) return 1;
    const t = d / tolerance;
    return t < 0.5 ? 1 : 2 - 2 * t;
  };

  if (!contiguous) {
    for (let i = 0; i < width * height; i++) {
      const c = coverageOf(i * 4);
      if (c > 0) stroke.coverage[i] = c * 255;
    }
    markDirty(stroke, 0, 0, width, height);
    return stroke;
  }

  const visited = new Uint8Array(width * height);
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (py < 0 || py >= height) continue;
    let left = px;
    while (left >= 0 && !visited[py * width + left] && coverageOf((py * width + left) * 4) > 0) left--;
    left++;
    let right = px;
    while (right < width && !visited[py * width + right] && coverageOf((py * width + right) * 4) > 0) right++;
    if (right <= left) continue;
    for (let sx = left; sx < right; sx++) {
      const i = py * width + sx;
      visited[i] = 1;
      stroke.coverage[i] = coverageOf(i * 4) * 255;
    }
    markDirty(stroke, left, py, right, py + 1);
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= height) continue;
      let run = false;
      for (let nx = left; nx < right; nx++) {
        const inside = !visited[ny * width + nx] && coverageOf((ny * width + nx) * 4) > 0;
        if (inside && !run) {
          stack.push([nx, ny]);
          run = true;
        } else if (!inside) {
          run = false;
        }
      }
    }
  }
  return stroke;
}

/**
 * Linear or radial gradient, written straight into the target (a gradient
 * interpolates colour as well as coverage, so it can't ride the single-colour
 * stroke path).
 *
 * Interpolation is in straight alpha with the colour of transparent stops
 * carried along, so a fade to transparent keeps its hue instead of drifting
 * toward whatever the second stop's unused RGB happened to be.
 */
export function fillGradient(target, {
  type = "linear",
  x0 = 0,
  y0 = 0,
  x1 = 0,
  y1 = 0,
  from = [0, 0, 0, 255],
  to = [255, 255, 255, 255],
  opacity = 1,
  selection = null,
  dither = true,
} = {}) {
  const { width, height, data } = target;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const radius = Math.sqrt(lenSq);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sel = 1;
      if (selection) {
        sel = selection[i] / 255;
        if (sel <= 0) continue;
      }
      let t;
      if (type === "radial") {
        t = radius < 1e-6 ? 1 : Math.hypot(x + 0.5 - x0, y + 0.5 - y0) / radius;
      } else {
        t = lenSq < 1e-6 ? 0 : ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / lenSq;
      }
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      // An 8-bit gradient across a large canvas bands visibly. A quarter-LSB
      // ordered dither costs nothing and removes it.
      const noise = dither ? (((x & 1) + ((y & 1) << 1)) / 4 - 0.375) : 0;

      const as = ((from[3] + (to[3] - from[3]) * t) / 255) * opacity * sel;
      const di = i * 4;
      const ad = data[di + 3] / 255;
      const ao = as + ad * (1 - as);
      if (ao <= 0) {
        data[di] = data[di + 1] = data[di + 2] = data[di + 3] = 0;
        continue;
      }
      const k = as / ao;
      for (let c = 0; c < 3; c++) {
        const cs = from[c] + (to[c] - from[c]) * t + noise;
        data[di + c] = cs * k + data[di + c] * (1 - k);
      }
      data[di + 3] = ao * 255;
    }
  }
  return target;
}

/** Reads a colour for the eyedropper. `sampleAll` reads the composited image
 *  rather than the active layer — which is what the user sees, and therefore
 *  what they mean when they click. */
export function pickColor(buffer, x, y) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return null;
  const i = (y * buffer.width + x) * 4;
  return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
}
