/**
 * Pure operations on an atlas definition — no filesystem, no editor stores, so
 * they can be exercised headlessly alongside the packer and the slicers.
 */

/**
 * Replaces an atlas's regions with a freshly sliced set.
 *
 * Existing names are preserved **positionally** where the count matches, so
 * re-slicing a sheet after editing its artwork does not break every animation
 * that references a frame by name. When the count changes, names are
 * regenerated and the caller is told — animations then lose the frames that no
 * longer exist, which `normalizeAtlas` does on load anyway.
 */
export function applySlice(def, rects, { baseName = "sprite", keepNames = true } = {}) {
  const previous = def.regions ?? [];
  const reuse = keepNames && previous.length === rects.length;
  const pad = String(Math.max(0, rects.length - 1)).length;
  return {
    ...def,
    regions: rects.map((rect, i) => ({
      name: reuse ? previous[i].name : `${baseName}_${String(i).padStart(pad, "0")}`,
      rect: [rect.x, rect.y, rect.width, rect.height],
      pivot: reuse ? previous[i].pivot : [0.5, 0.5],
      border: reuse ? previous[i].border : [0, 0, 0, 0],
    })),
    animations: reuse ? def.animations : [],
  };
}

/** A name that does not collide with any existing region or animation. */
export function uniqueRegionName(def, base) {
  const taken = new Set((def.regions ?? []).map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
