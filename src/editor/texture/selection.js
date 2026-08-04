/**
 * Selections.
 *
 * A selection is a `Uint8Array` of per-pixel coverage (0..255), the same size
 * as the document — not a rectangle and not a path. Storing coverage rather
 * than a boolean is what makes feathering, antialiased ellipses and
 * partially-selected edges work at all, and it means every tool honours a
 * selection through one uniform mechanism: multiply what you were about to
 * write by the coverage.
 *
 * `null` means "no selection", which is different from an empty one and has to
 * stay different: no selection means every tool works everywhere, while an
 * empty selection means nothing can be drawn. Collapsing the two is how an
 * editor ends up ignoring a selection the user carefully made.
 */

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

export const SELECTION_MODES = ["replace", "add", "subtract", "intersect"];

export function createSelection(width, height, fill = 0) {
  const mask = new Uint8Array(width * height);
  if (fill) mask.fill(fill);
  return mask;
}

export function isSelectionEmpty(mask) {
  if (!mask) return false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) return false;
  return true;
}

/** Tight bounds of the selected area, or null when nothing is selected.
 *  Every tool uses this to avoid walking the whole canvas. */
export function selectionBounds(mask, width, height) {
  if (!mask) return { x: 0, y: 0, width, height };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
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

/**
 * Combines a freshly-drawn shape into an existing selection.
 * `base` of null is treated as empty for add/replace and as "everything" for
 * subtract/intersect — subtracting from "no selection" has to mean "everything
 * except this", which is what a user dragging a subtract-mode marquee on a
 * fresh canvas expects.
 */
export function combineSelection(base, shape, mode, width, height) {
  if (mode === "replace") return shape;
  const subtractive = mode === "subtract" || mode === "intersect";
  const effective = base ?? createSelection(width, height, subtractive ? 255 : 0);
  const out = new Uint8Array(effective.length);
  const b = effective;
  for (let i = 0; i < out.length; i++) {
    const prev = b[i];
    const next = shape[i];
    if (mode === "add") out[i] = Math.max(prev, next);
    else if (mode === "subtract") out[i] = Math.max(0, prev - next);
    else out[i] = Math.min(prev, next);
  }
  return out;
}

export function invertSelection(mask, width, height) {
  const out = new Uint8Array(width * height);
  if (!mask) return out; // inverting "everything" gives nothing
  for (let i = 0; i < out.length; i++) out[i] = 255 - mask[i];
  return out;
}

export function rectSelection(width, height, rect) {
  const mask = createSelection(width, height);
  const x0 = Math.max(0, Math.floor(Math.min(rect.x, rect.x + rect.width)));
  const y0 = Math.max(0, Math.floor(Math.min(rect.y, rect.y + rect.height)));
  const x1 = Math.min(width, Math.ceil(Math.max(rect.x, rect.x + rect.width)));
  const y1 = Math.min(height, Math.ceil(Math.max(rect.y, rect.y + rect.height)));
  for (let y = y0; y < y1; y++) mask.fill(255, y * width + x0, y * width + x1);
  return mask;
}

export function ellipseSelection(width, height, rect) {
  const mask = createSelection(width, height);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = Math.abs(rect.width) / 2;
  const ry = Math.abs(rect.height) / 2;
  if (rx < 0.5 || ry < 0.5) return mask;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const x1 = Math.min(width, Math.ceil(cx + rx));
  const y1 = Math.min(height, Math.ceil(cy + ry));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      // One-pixel-wide antialiased edge, measured in the smaller radius so the
      // softness stays a pixel regardless of how elongated the ellipse is.
      const feather = 1 / Math.min(rx, ry);
      const cover = d <= 1 - feather ? 1 : d >= 1 ? 0 : (1 - d) / feather;
      if (cover > 0) mask[y * width + x] = Math.round(cover * 255);
    }
  }
  return mask;
}

/** Even-odd scanline fill — a lasso is an arbitrary self-intersecting polygon
 *  and nonzero winding would fill its self-overlaps differently depending on
 *  which way the user happened to circle. */
export function polygonSelection(width, height, points) {
  const mask = createSelection(width, height);
  if (!points || points.length < 3) return mask;
  const xs = [];
  for (let y = 0; y < height; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > sy !== yj > sy) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(width, Math.ceil(xs[k + 1] - 0.5));
      if (x1 > x0) mask.fill(255, y * width + x0, y * width + x1);
    }
  }
  return mask;
}

/**
 * Colour distance used by both the magic wand and the paint bucket, in 0..1.
 *
 * Alpha is weighted like a colour channel rather than compared separately, so
 * a transparent region and an opaque region of the same RGB are far apart —
 * which is what makes clicking outside a sprite select the empty space instead
 * of flooding across its edge.
 */
function colorDistance(data, i, r, g, b, a) {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  const da = data[i + 3] - a;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 510;
}

/**
 * Magic wand. `contiguous` is the difference between "this shape" and "every
 * pixel of this colour anywhere", and both are wanted often enough that
 * neither can be the only behaviour.
 *
 * @param {PixelBuffer} buffer
 */
export function wandSelection(buffer, x, y, { tolerance = 0.1, contiguous = true } = {}) {
  const { width, height, data } = buffer;
  const mask = createSelection(width, height);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const seed = (y * width + x) * 4;
  const r = data[seed];
  const g = data[seed + 1];
  const b = data[seed + 2];
  const a = data[seed + 3];

  if (!contiguous) {
    for (let i = 0; i < width * height; i++) {
      if (colorDistance(data, i * 4, r, g, b, a) <= tolerance) mask[i] = 255;
    }
    return mask;
  }

  // Scanline flood: a per-pixel stack overflows on a large uniform region
  // (a 2048² fill is four million entries) and is several times slower.
  const stack = [[x, y]];
  while (stack.length) {
    const [sx, sy] = stack.pop();
    if (sy < 0 || sy >= height) continue;
    let left = sx;
    while (left >= 0 && !mask[sy * width + left] && colorDistance(data, (sy * width + left) * 4, r, g, b, a) <= tolerance) {
      left--;
    }
    left++;
    let right = sx;
    while (
      right < width &&
      !mask[sy * width + right] &&
      colorDistance(data, (sy * width + right) * 4, r, g, b, a) <= tolerance
    ) {
      right++;
    }
    if (right <= left) continue;
    mask.fill(255, sy * width + left, sy * width + right);
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let run = false;
      for (let nx = left; nx < right; nx++) {
        const inside =
          !mask[ny * width + nx] && colorDistance(data, (ny * width + nx) * 4, r, g, b, a) <= tolerance;
        if (inside && !run) {
          stack.push([nx, ny]);
          run = true;
        } else if (!inside) {
          run = false;
        }
      }
    }
  }
  return mask;
}

/** Selects by alpha — "select the sprite, not the background", one click. */
export function selectionFromAlpha(buffer, threshold = 0) {
  const { width, height, data } = buffer;
  const mask = createSelection(width, height);
  for (let i = 0; i < width * height; i++) mask[i] = data[i * 4 + 3] > threshold ? 255 : 0;
  return mask;
}

/** Positive `radius` grows the selection, negative shrinks it (chebyshev). */
export function growSelection(mask, width, height, radius) {
  const r = Math.round(Math.abs(radius));
  if (!r) return new Uint8Array(mask);
  const grow = radius > 0;
  let src = mask;
  let out = new Uint8Array(mask.length);
  // Separable min/max: two 1D passes instead of an r² neighbourhood.
  for (const horizontal of [true, false]) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = grow ? 0 : 255;
        for (let k = -r; k <= r; k++) {
          const sx = horizontal ? x + k : x;
          const sy = horizontal ? y : y + k;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
            // Outside the canvas counts as unselected, so shrinking pulls away
            // from the border rather than treating the edge as filled.
            if (!grow) value = 0;
            continue;
          }
          const v = src[sy * width + sx];
          value = grow ? Math.max(value, v) : Math.min(value, v);
        }
        out[y * width + x] = value;
      }
    }
    const swap = src === mask ? new Uint8Array(mask.length) : src;
    src = out;
    out = swap;
  }
  return src;
}

/** Box blur, three passes ≈ gaussian. Softens the selection edge. */
export function featherSelection(mask, width, height, radius) {
  const r = Math.round(radius);
  if (r <= 0) return new Uint8Array(mask);
  let src = new Uint8Array(mask);
  let dst = new Uint8Array(mask.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const sx = horizontal ? x + k : x;
            const sy = horizontal ? y : y + k;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            sum += src[sy * width + sx];
            n++;
          }
          dst[y * width + x] = n ? sum / n : 0;
        }
      }
      const swap = src;
      src = dst;
      dst = swap;
    }
  }
  return src;
}
