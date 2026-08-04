/**
 * Cutting an existing sheet into regions — the other direction from packing.
 *
 * Two modes, because sprite sheets come in exactly two kinds and neither
 * approach works on the other:
 *
 * **Grid** for anything exported from an animation tool: uniform cells, often
 * with an outer offset and inner spacing. Deterministic and exact, and the only
 * option when frames are meant to line up even though some are nearly empty.
 *
 * **By alpha** for a sheet of loose artwork: find what is actually drawn. This
 * is what makes an imported UI sheet or a hand-painted page of icons usable
 * without measuring anything.
 */

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * Uniform cells.
 *
 * Takes either a cell size or a column/row count — both are natural ways to
 * describe the same sheet ("64×64 frames" vs "8 across"), and converting
 * between them by hand is where the off-by-one lives.
 *
 * `skipEmpty` needs the image; without one, every cell is kept.
 */
export function sliceGrid({
  width,
  height,
  cellWidth = 0,
  cellHeight = 0,
  columns = 0,
  rows = 0,
  offsetX = 0,
  offsetY = 0,
  spacingX = 0,
  spacingY = 0,
  skipEmpty = false,
  buffer = null,
  alphaThreshold = 0,
} = {}) {
  const usableW = Math.max(0, width - offsetX);
  const usableH = Math.max(0, height - offsetY);

  let cw = Math.round(cellWidth);
  let ch = Math.round(cellHeight);
  if (!cw && columns > 0) cw = Math.floor((usableW - spacingX * (columns - 1)) / columns);
  if (!ch && rows > 0) ch = Math.floor((usableH - spacingY * (rows - 1)) / rows);
  cw = Math.max(1, cw);
  ch = Math.max(1, ch);

  const cols = columns > 0 ? columns : Math.max(0, Math.floor((usableW + spacingX) / (cw + spacingX)));
  const rowCount = rows > 0 ? rows : Math.max(0, Math.floor((usableH + spacingY) / (ch + spacingY)));

  const out = [];
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < cols; col++) {
      const x = offsetX + col * (cw + spacingX);
      const y = offsetY + row * (ch + spacingY);
      // A cell that runs off the edge is dropped rather than clipped: a clipped
      // last column looks like a working slice and produces frames of the wrong
      // size, which shows up as one animation frame subtly squashed.
      if (x + cw > width || y + ch > height) continue;
      if (skipEmpty && buffer && isEmpty(buffer, x, y, cw, ch, alphaThreshold)) continue;
      out.push({ x, y, width: cw, height: ch });
    }
  }
  return out;
}

function isEmpty(buffer, x, y, w, h, threshold) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (buffer.data[(row * buffer.width + col) * 4 + 3] > threshold) return false;
    }
  }
  return true;
}

/**
 * Connected regions of non-transparent pixels.
 *
 * 8-connected, so a diagonal antialiased join does not split a sprite in two.
 * Then **overlapping** bounding boxes are merged, repeatedly, which keeps a
 * sprite whose parts do not touch — a detail inside an L's concave corner, a
 * blade crossing a body — as one region rather than two halves.
 *
 * Merging by overlap, not by proximity. Proximity would fuse neighbouring
 * sprites on a tightly-packed sheet, which is the far more common sheet; the
 * cost is that a genuinely detached piece with a clear gap (the dot of an "i")
 * comes out as its own region, which is easy to fix by hand and easy to see.
 *
 * `minSize` drops specks: an atlas cleaned of stray antialiased pixels is the
 * difference between 40 useful regions and 400.
 */
export function sliceByAlpha(buffer, { threshold = 0, minSize = 2, padding = 0, merge = true } = {}) {
  const { width, height, data } = buffer;
  const labels = new Int32Array(width * height).fill(-1);
  const boxes = [];
  const stack = [];

  for (let start = 0; start < width * height; start++) {
    if (labels[start] !== -1 || data[start * 4 + 3] <= threshold) continue;
    const id = boxes.length;
    const box = { x: start % width, y: (start / width) | 0, width: 1, height: 1 };
    let minX = box.x;
    let maxX = box.x;
    let minY = box.y;
    let maxY = box.y;

    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop();
      const x = at % width;
      const y = (at / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (labels[n] !== -1 || data[n * 4 + 3] <= threshold) continue;
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }

  let rects = boxes;
  if (merge) rects = mergeOverlapping(rects);
  rects = rects.filter((r) => r.width >= minSize && r.height >= minSize);

  if (padding > 0) {
    rects = rects.map((r) => ({
      x: Math.max(0, r.x - padding),
      y: Math.max(0, r.y - padding),
      width: Math.min(width, r.x + r.width + padding) - Math.max(0, r.x - padding),
      height: Math.min(height, r.y + r.height + padding) - Math.max(0, r.y - padding),
    }));
  }

  // Reading order: top-to-bottom, then left-to-right, so generated names run in
  // the order a human scans the sheet and an animation built from "everything"
  // plays in the order it was drawn. Rows are bucketed by overlap rather than by
  // exact Y, since sprites in a row rarely share a top edge.
  return sortReadingOrder(rects);
}

function mergeOverlapping(rects) {
  const out = rects.map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!overlaps(out[i], out[j])) continue;
        out[i] = union(out[i], out[j]);
        out.splice(j, 1);
        merged = true;
        j--;
      }
    }
  }
  return out;
}

const overlaps = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function sortReadingOrder(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const rect of sorted) {
    const row = rows.find((r) => rect.y < r.bottom && rect.y + rect.height > r.top);
    if (row) {
      row.items.push(rect);
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, rect.y + rect.height);
    } else {
      rows.push({ top: rect.y, bottom: rect.y + rect.height, items: [rect] });
    }
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.x - b.x));
}

/**
 * Names for a set of rects: `base_0`, `base_1`, …
 *
 * Zero-padded to the count's width so `frame_09` sorts before `frame_10`
 * everywhere — in the region list, in a file listing, and in any tool the
 * exported PNGs are later opened with.
 */
export function nameRegions(rects, base = "sprite", startIndex = 0) {
  const pad = String(rects.length + startIndex - 1).length;
  return rects.map((rect, i) => ({
    ...rect,
    name: `${base}_${String(i + startIndex).padStart(pad, "0")}`,
  }));
}
