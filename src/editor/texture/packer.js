/**
 * Rectangle packing — MaxRects, best-short-side-fit.
 *
 * MaxRects rather than the shelf/skyline packers that are easier to write,
 * because sprites are wildly non-uniform: a UI set is a dozen 16px icons and
 * three 400px panels, and a shelf packer wastes the whole height of a row on
 * the tall one. The difference is routinely 30–40% of the sheet, which is the
 * difference between fitting in 1024² and needing 2048².
 *
 * Pure and deterministic — same inputs, same sheet, every time. A packer that
 * reorders equal-scoring rectangles nondeterministically produces a different
 * atlas on every build, which turns every rebuild into a full re-upload for
 * anything caching the result.
 */

/** @typedef {{ id: string, width: number, height: number }} PackItem */
/** @typedef {{ id: string, x: number, y: number, width: number, height: number }} Placement */

const nextPowerOfTwo = (v) => {
  let p = 1;
  while (p < v) p *= 2;
  return p;
};

/**
 * Packs into a fixed bin.
 *
 * @returns {{ placements: Placement[], overflow: string[] }}
 */
export function packIntoBin(items, binWidth, binHeight, { padding = 0 } = {}) {
  const free = [{ x: 0, y: 0, width: binWidth, height: binHeight }];
  const placements = [];
  const overflow = [];

  // Tallest first. Sorting by area is the other common choice and is worse
  // here: height drives the wasted band above a placed rectangle, so placing
  // the tall ones while the sheet is still empty is what keeps it compact.
  // Ties break on width then id so the result never depends on input order.
  const queue = [...items].sort(
    (a, b) => b.height - a.height || b.width - a.width || String(a.id).localeCompare(String(b.id)),
  );

  for (const item of queue) {
    const w = item.width + padding * 2;
    const h = item.height + padding * 2;

    // Best short side fit: the smallest leftover on the *tighter* axis. It beats
    // best-area-fit on sprite sets because it prefers slots that are snug in one
    // direction, leaving long usable strips rather than many unusable squares.
    let best = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const rect of free) {
      if (rect.width < w || rect.height < h) continue;
      const leftoverH = rect.width - w;
      const leftoverV = rect.height - h;
      const short = Math.min(leftoverH, leftoverV);
      const long = Math.max(leftoverH, leftoverV);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = rect;
        bestShort = short;
        bestLong = long;
      }
    }
    if (!best) {
      overflow.push(item.id);
      continue;
    }

    const placed = { x: best.x, y: best.y, width: w, height: h };
    placements.push({
      id: item.id,
      x: placed.x + padding,
      y: placed.y + padding,
      width: item.width,
      height: item.height,
    });

    // Split every free rectangle the placement overlaps, then prune the ones
    // now contained in another. Pruning is not an optimisation: without it the
    // free list grows quadratically and the packer slows to a crawl on a few
    // hundred sprites.
    for (let i = free.length - 1; i >= 0; i--) {
      const rect = free[i];
      if (!intersects(rect, placed)) continue;
      free.splice(i, 1, ...splitFree(rect, placed));
    }
    pruneContained(free);
  }

  return { placements, overflow };
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function splitFree(rect, used) {
  const out = [];
  if (used.x > rect.x) out.push({ x: rect.x, y: rect.y, width: used.x - rect.x, height: rect.height });
  if (used.x + used.width < rect.x + rect.width) {
    const x = used.x + used.width;
    out.push({ x, y: rect.y, width: rect.x + rect.width - x, height: rect.height });
  }
  if (used.y > rect.y) out.push({ x: rect.x, y: rect.y, width: rect.width, height: used.y - rect.y });
  if (used.y + used.height < rect.y + rect.height) {
    const y = used.y + used.height;
    out.push({ x: rect.x, y, width: rect.width, height: rect.y + rect.height - y });
  }
  return out.filter((r) => r.width > 0 && r.height > 0);
}

function contains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function pruneContained(free) {
  for (let i = free.length - 1; i >= 0; i--) {
    for (let j = free.length - 1; j >= 0; j--) {
      if (i === j) continue;
      if (contains(free[j], free[i])) {
        free.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Packs into the smallest sheet that fits, growing from a starting guess.
 *
 * The sheet grows by doubling the shorter side, which keeps it near-square, and
 * near-square matters: a 4096×64 sheet fits the same sprites and is refused by
 * hardware limits the moment one more sprite arrives.
 *
 * @param {PackItem[]} items
 * @returns {{ width: number, height: number, placements: Placement[], overflow: string[] }}
 */
export function packAtlas(items, {
  padding = 2,
  maxSize = 4096,
  powerOfTwo = true,
  startSize = 0,
} = {}) {
  const usable = items.filter((item) => item.width > 0 && item.height > 0);
  if (!usable.length) return { width: 1, height: 1, placements: [], overflow: [] };

  // Start no smaller than the largest sprite (plus its padding) and no smaller
  // than the square root of the total area — a first guess that is usually the
  // answer, so the common case runs the packer once.
  let area = 0;
  let minW = 1;
  let minH = 1;
  for (const item of usable) {
    area += (item.width + padding * 2) * (item.height + padding * 2);
    minW = Math.max(minW, item.width + padding * 2);
    minH = Math.max(minH, item.height + padding * 2);
  }
  const guess = Math.max(minW, minH, Math.ceil(Math.sqrt(area)), startSize);

  // Clamped to `maxSize` from the very first guess, not only while growing. A
  // single sprite larger than the cap would otherwise size the sheet past it
  // and pack happily — producing an atlas that exceeds the limit it was given,
  // which fails at upload rather than here where it can be reported.
  let width = Math.min(maxSize, powerOfTwo ? nextPowerOfTwo(guess) : guess);
  let height = Math.min(
    maxSize,
    powerOfTwo ? nextPowerOfTwo(Math.max(minH, Math.ceil(area / width))) : Math.max(minH, Math.ceil(area / width)),
  );

  for (let attempt = 0; attempt < 24; attempt++) {
    const result = packIntoBin(usable, width, height, { padding });
    if (!result.overflow.length) {
      return { width, height, placements: result.placements, overflow: [] };
    }
    if (width >= maxSize && height >= maxSize) {
      // Report rather than loop forever. A caller that gets overflow has a real
      // decision to make (drop sprites, raise the cap, split the sheet) and
      // silently truncating would ship an atlas missing artwork.
      return { width, height, placements: result.placements, overflow: result.overflow };
    }
    if (height < width && height < maxSize) height = powerOfTwo ? height * 2 : Math.ceil(height * 1.25);
    else if (width < maxSize) width = powerOfTwo ? width * 2 : Math.ceil(width * 1.25);
    else height = powerOfTwo ? height * 2 : Math.ceil(height * 1.25);
    width = Math.min(width, maxSize);
    height = Math.min(height, maxSize);
  }
  return { width, height, placements: [], overflow: usable.map((i) => i.id) };
}

/**
 * Copies a sprite into the sheet and repeats its border outward by `extrude`.
 *
 * Extrusion is not padding. Padding puts empty space between sprites, which
 * stops a neighbour bleeding in; extrusion repeats the sprite's own edge texels
 * outward, which stops the *empty space* bleeding in when a mipmap or a
 * half-texel sampling offset reaches past the rect. Atlases need both, and
 * neither substitutes for the other.
 *
 * @param {import("./pixels.js").PixelBuffer} sheet
 * @param {import("./pixels.js").PixelBuffer} sprite
 */
export function blitWithExtrude(sheet, sprite, x, y, extrude = 0) {
  const copy = (sx, sy, dx, dy) => {
    if (dx < 0 || dy < 0 || dx >= sheet.width || dy >= sheet.height) return;
    const s = (Math.min(sprite.height - 1, Math.max(0, sy)) * sprite.width + Math.min(sprite.width - 1, Math.max(0, sx))) * 4;
    const d = (dy * sheet.width + dx) * 4;
    sheet.data[d] = sprite.data[s];
    sheet.data[d + 1] = sprite.data[s + 1];
    sheet.data[d + 2] = sprite.data[s + 2];
    sheet.data[d + 3] = sprite.data[s + 3];
  };

  const e = Math.max(0, Math.round(extrude));
  for (let row = -e; row < sprite.height + e; row++) {
    for (let col = -e; col < sprite.width + e; col++) {
      copy(col, row, x + col, y + row);
    }
  }
  return sheet;
}
