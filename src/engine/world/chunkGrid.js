/**
 * The chunk grid a streamed World draws its surroundings on (09-14, owner:
 * "split world in chunks so we could stream chunks into existence as we move
 * around … governed by world component"). Pure: no THREE, no engine.
 *
 * Chunk edges are aligned with the World's own central square
 * [-exclude, exclude]², so the authored region (settlements, water, roads,
 * sculpt) is exactly a whole number of chunks and no streamed tile overlaps
 * it. `alignedChunkSize` bends the requested size until that holds.
 */

export const chunkKey = (ix, iz) => `${ix},${iz}`;

/** The requested size, adjusted so `extent` is a whole number of chunks. */
export function alignedChunkSize(extent, requested) {
  if (!(extent > 0) || !(requested > 0)) return requested;
  return extent / Math.max(1, Math.round(extent / requested));
}

/** Chunk edges sit at offset + k * size, with the central square's edge among them. */
export function chunkOffset(exclude, size) {
  return exclude > 0 ? ((exclude % size) + size) % size : 0;
}

export function chunkRect(ix, iz, size, offset = 0) {
  const x0 = offset + ix * size, z0 = offset + iz * size;
  return { x0, z0, x1: x0 + size, z1: z0 + size };
}

/** Distance from a point to a rectangle (0 inside). */
export function rectDistance(x, z, rect) {
  return Math.hypot(Math.max(rect.x0 - x, 0, x - rect.x1), Math.max(rect.z0 - z, 0, z - rect.z1));
}

/**
 * Chunks within `radius` of (x, z), nearest first, each with its LOD ring
 * (0 near, 1 mid, 2 far). Chunks wholly inside the central square
 * [-exclude, exclude]² are left to the World; chunks entirely outside
 * [-bounds, bounds]² are not drawn.
 */
export function desiredChunks({ x, z, radius, size, bounds = Infinity, exclude = 0, lodDistances = null }) {
  const offset = chunkOffset(exclude, size);
  const lods = lodDistances ?? [radius * .3, radius * .6];
  const lo = v => Math.max(v, -bounds), hi = v => Math.min(v, bounds);
  const i0 = Math.floor((lo(x - radius) - offset) / size), i1 = Math.ceil((hi(x + radius) - offset) / size) - 1;
  const j0 = Math.floor((lo(z - radius) - offset) / size), j1 = Math.ceil((hi(z + radius) - offset) / size) - 1;
  const out = [], eps = 1e-6;
  for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) {
    const rect = chunkRect(ix, iz, size, offset);
    if (rect.x1 <= -bounds || rect.x0 >= bounds || rect.z1 <= -bounds || rect.z0 >= bounds) continue;
    if (exclude > 0 && rect.x0 >= -exclude - eps && rect.x1 <= exclude + eps && rect.z0 >= -exclude - eps && rect.z1 <= exclude + eps) continue;
    const distance = rectDistance(x, z, rect);
    if (distance > radius) continue;
    const lod = distance < lods[0] ? 0 : distance < lods[1] ? 1 : 2;
    out.push({ key: chunkKey(ix, iz), ix, iz, ...rect, size, distance, lod });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}
