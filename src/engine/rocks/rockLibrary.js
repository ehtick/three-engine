/**
 * Rock variant library: a few meshed variants per kind at a canonical size,
 * built once per (seed, kinds) and instanced by every placement in every
 * chunk. Meshing a signed distance field costs 0.1-1.5 s per piece, so a
 * streamed world can never mesh per placement; it scales and rotates these.
 *
 * Output is plain typed arrays (positions/normals/occlusion/indices) so the
 * library can be built in a worker and transferred.
 */

import { createRockSdf } from './rockSdf.js';
import { meshSignedDistanceSteps } from './surfaceNets.js';

/** Canonical dimensions every placement scales from (metres). */
export const ROCK_CANON = Object.freeze({
  boulder: { size: 2.4 },
  slab: { size: 5 },
  ledge: { size: 9, height: 4 },
  spire: { height: 28, radius: 5 },
  columns: { width: 12, depth: 7, height: 14 },
  arch: { span: 16, height: 10, thickness: 3.6 },
  wall: { length: 16, height: 12, thickness: 5 },
});

/** Target triangles per variant. The surface-nets mesh is ~2 triangles per
 * surface cell, so the voxel follows from the field's rough surface area. */
// ⛔ 09-14 live: the first budgets (walls 18k, columns 22k) put 7.1 M stone
// triangles on one 512 m highlands terrain (586 walls) and the editor dropped
// right after. A wall segment is a 10-16 m face seen from metres away at most
// in a few places; ~5k triangles carries its fracture planes. Distance LODs
// (T4) will take the far rings lower still.
export const ROCK_TRIANGLE_BUDGET = Object.freeze({
  boulder: 1200, slab: 1500, ledge: 3000, spire: 6000, columns: 7000, arch: 6000, wall: 5000,
});

export function voxelForBudget(field, triangles) {
  const [x0, y0, z0, x1, y1, z1] = field.bounds;
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  // Bounds overstate the stone's own surface; .8 is the measured share for
  // the kinds above (a bounding box of a fractured mass).
  const area = 2 * (w * h + w * d + h * d) * .8;
  return Math.max(field.voxel, Math.sqrt(area / (triangles * .5)));
}

export function rockVariantSeed(seed, kind, index) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return (Math.imul(h ^ index, 2246822519) >>> 0);
}

/**
 * @param {{ seed: number, kinds: Record<string, number>, columnar?: number }} options
 *   kinds: variants per kind (0 skips it); `columnar` variants of the wall use columns.
 * Yields `'rocks'` between variants; returns `{ variants: { [kind]: Variant[] } }`.
 */
export function* buildRockLibrarySteps({ seed = 1, kinds = {}, columnar = 0, budgetScale = 1, lodShares = [.22, .05] } = {}, clock = { due: () => false }) {
  const variants = {};
  for (const [kind, count] of Object.entries(kinds)) {
    if (!count || !ROCK_CANON[kind]) continue;
    variants[kind] = [];
    for (let index = 0; index < count; index++) {
      if (clock.due()) yield 'rocks';
      const variantSeed = rockVariantSeed(seed, kind, index);
      const columnarWall = kind === 'wall' && index < columnar;
      const field = createRockSdf(kind, { ...ROCK_CANON[kind], seed: variantSeed, ...(columnarWall ? { columnar: true } : {}) });
      const voxel = voxelForBudget(field, ROCK_TRIANGLE_BUDGET[kind] * budgetScale);
      const mesh = yield* meshSignedDistanceSteps(field, voxel, {}, clock);
      // Distance LODs from the same field: ~22 % and ~5 % of the triangles. A
      // streamed world draws thousands of these; only the near ring pays full.
      const lods = [];
      for (const share of lodShares) {
        if (clock.due()) yield 'rocks';
        lods.push(yield* meshSignedDistanceSteps(field, voxelForBudget(field, ROCK_TRIANGLE_BUDGET[kind] * budgetScale * share), { occlusion: share > .1 }, clock));
      }
      // Measured extents: SDF bounds are padded and a variant's real top varies
      // (round 7: walls scaled from a nominal 12 m stood at half the cliff).
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      const P = mesh.positions;
      for (let p = 0; p < P.length; p += 3) {
        if (P[p] < minX) minX = P[p]; if (P[p] > maxX) maxX = P[p]; if (P[p + 1] > maxY) maxY = P[p + 1];
        if (P[p + 2] < minZ) minZ = P[p + 2]; if (P[p + 2] > maxZ) maxZ = P[p + 2];
      }
      const extent = [maxX - minX, Math.max(.01, maxY), maxZ - minZ];
      variants[kind].push({ kind, index, columnar: columnarWall, canon: ROCK_CANON[kind], bounds: field.bounds, voxel, extent, ...mesh, lods });
    }
  }
  return { seed, variants };
}

/** Per-axis scale for one placement of one variant. `size` (target metres:
 * width along local x, height above the ground contact, depth along local z)
 * fits the variant's measured extent; otherwise `scale` is relative to the canon. */
export function instanceScale(placement, variant) {
  if (placement.size) return [placement.size[0] / variant.extent[0], placement.size[1] / variant.extent[1], placement.size[2] / variant.extent[2]];
  return placement.scale;
}

export function buildRockLibrary(options) {
  const steps = buildRockLibrarySteps(options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
