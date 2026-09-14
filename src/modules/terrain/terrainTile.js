import { paintLandscapeGround } from './terrainGround.js';

/**
 * One streamed terrain tile's CPU data (09-14 chunk streaming): positions in
 * landscape metres, normals, style ground colours and a skirt, built from a
 * landscape in clock-sliced steps. Pure typed arrays, so a worker can build it.
 *
 * Seams: heights are sampled on a grid padded by two samples, so normals
 * (central differences) and ground colours (2-cell stencils) on a tile's
 * border use exactly the samples its neighbour uses. Two tiles at the SAME
 * resolution therefore match bit for bit. Across an LOD change the border
 * vertices still sit on the landscape, but the coarser tile interpolates
 * between them; the skirt — a strip hanging below every edge — hides that crack.
 */

export const TILE_LOD_RESOLUTION = Object.freeze([64, 32, 16]);
const PAD = 2;
const indexCache = new Map();

/** Grid indices of the tile's border, walked once around. */
export function perimeterVertices(resolution) {
  const cols = resolution + 1, out = [];
  for (let c = 0; c < resolution; c++) out.push(c);
  for (let r = 0; r < resolution; r++) out.push(r * cols + resolution);
  for (let c = resolution; c > 0; c--) out.push(resolution * cols + c);
  for (let r = resolution; r > 0; r--) out.push(r * cols);
  return Int32Array.from(out);
}

/** Shared per resolution: every tile of an LOD has the same topology. */
export function tileIndices(resolution) {
  let cached = indexCache.get(resolution);
  if (cached) return cached;
  const cols = resolution + 1, perimeter = perimeterVertices(resolution), P = perimeter.length;
  const total = cols * cols + P;
  const indices = total > 65535 ? new Uint32Array(resolution * resolution * 6 + P * 12) : new Uint16Array(resolution * resolution * 6 + P * 12);
  let n = 0;
  for (let r = 0; r < resolution; r++) for (let c = 0; c < resolution; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    // (a, d, b): with +x across and +z down the rows, this faces +y.
    indices[n++] = a; indices[n++] = d; indices[n++] = b;
    indices[n++] = b; indices[n++] = d; indices[n++] = e;
  }
  for (let k = 0; k < P; k++) {
    const top0 = perimeter[k], top1 = perimeter[(k + 1) % P], low0 = cols * cols + k, low1 = cols * cols + (k + 1) % P;
    // Both windings: a skirt is seen from whichever side the crack exposes.
    indices[n++] = top0; indices[n++] = low0; indices[n++] = top1;
    indices[n++] = top1; indices[n++] = low0; indices[n++] = low1;
    indices[n++] = top0; indices[n++] = top1; indices[n++] = low0;
    indices[n++] = top1; indices[n++] = low1; indices[n++] = low0;
  }
  cached = indices;
  indexCache.set(resolution, cached);
  return cached;
}

/**
 * @param landscape  a landscapeGenerator landscape (`sample`, `palette`)
 * @param options    x0/z0/size (landscape metres), resolution (cells per side),
 *                   range {lo, hi} shared by every tile (snowline), skirt depth (m)
 */
export function* buildTerrainTileSteps(landscape, { x0, z0, size, resolution, range = null, skirt = null }, clock = { due: () => false }) {
  const cols = resolution + 1, padded = cols + 2 * PAD, step = size / resolution;
  const heights = new Float32Array(padded * padded), point = {};
  // A settled landscape (landscapeSettlements.js) marks lanes and plots: painted as packed earth.
  const marks = landscape.settlements ? new Float32Array(padded * padded) : null;
  for (let r = 0; r < padded; r++) {
    if (clock.due()) yield 'tile';
    const z = z0 + (r - PAD) * step;
    for (let c = 0; c < padded; c++) {
      heights[r * padded + c] = landscape.sample(x0 + (c - PAD) * step, z, point).height;
      if (marks) marks[r * padded + c] = Math.max(point.path ?? 0, (point.pad ?? 0) * .6);
    }
  }
  const perimeter = perimeterVertices(resolution), P = perimeter.length, grid = cols * cols, count = grid + P;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  let minY = Infinity, maxY = -Infinity;
  for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, p = (r + PAD) * padded + c + PAD, h = heights[p];
    positions[i * 3] = x0 + c * step; positions[i * 3 + 1] = h; positions[i * 3 + 2] = z0 + r * step;
    const nx = heights[p - 1] - heights[p + 1], nz = heights[p - padded] - heights[p + padded], ny = 2 * step;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / length; normals[i * 3 + 1] = ny / length; normals[i * 3 + 2] = nz / length;
    if (h < minY) minY = h; if (h > maxY) maxY = h;
  }
  if (clock.due()) yield 'tile';
  colors.set(paintLandscapeGround(heights, { resolution, size, palette: landscape.palette, pad: PAD, x0, z0, lo: range?.lo ?? null, hi: range?.hi ?? null }));
  if (marks) {
    const earth = hexToLinear(landscape.palette?.soil ?? '#8a7a5c');
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
      const m = marks[(r + PAD) * padded + c + PAD] * .85, i = (r * cols + c) * 3;
      if (m <= 0) continue;
      for (let k = 0; k < 3; k++) colors[i + k] += (earth[k] * .9 - colors[i + k]) * m;
    }
  }
  const depth = skirt ?? step * 3 + 1.5;
  for (let k = 0; k < P; k++) {
    const src = perimeter[k] * 3, dst = (grid + k) * 3;
    positions[dst] = positions[src]; positions[dst + 1] = positions[src + 1] - depth; positions[dst + 2] = positions[src + 2];
    for (let a = 0; a < 3; a++) { normals[dst + a] = normals[src + a]; colors[dst + a] = colors[src + a]; }
  }
  return { positions, normals, colors, indices: tileIndices(resolution), vertexCount: count, minY: minY - depth, maxY, x0, z0, size, resolution };
}

/** sRGB hex -> linear RGB, as THREE.Color stores it (no THREE import: a worker can build tiles). */
function hexToLinear(hex) {
  return [1, 3, 5].map(i => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
}

export function buildTerrainTile(landscape, options) {
  const steps = buildTerrainTileSteps(landscape, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
