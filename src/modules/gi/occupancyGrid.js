// CONSERVATIVE TRIANGLE OCCUPANCY for the global field.
//
// WHY THIS EXISTS — the measurement, not a theory. The runtime field is
// composited by min()ing per-mesh SDFs (`sdfScene.compositeCompute`). Each of
// those is ONE 64³ grid stretched over its mesh's whole extent, so on the
// user's Sponza — where the arcade is a handful of meshes spanning 24–37m —
// the per-mesh bake cell is **0.41–0.62m** (measured, `test:gi-coverage`).
// Sponza's columns are ~0.5m across. They are therefore already melted IN THE
// SOURCE, one bake cell wide, before the composite ever runs.
//
// That is why raising the field's resolution did nothing and why the sparse
// brick level did nothing: both RESAMPLE that source. Upsampling a blurred
// function recovers no detail. The only way to get a column back is to go to
// the triangles.
//
// WHAT THIS DOES. Rasterizes the scene's triangles straight into the global
// grid as a binary occupancy bitset, then uses it to CLAMP the composited
// distance to zero wherever a triangle actually passes. Occupancy from
// triangles is conservative at voxel resolution — every voxel a triangle
// touches is marked, so a sub-voxel column or a 5cm curtain is PRESENT (one
// voxel wide, not sharp, but solid) instead of absent. Absent is what leaks.
//
// It deliberately does NOT try to make the field sharper. A 0.35m grid cannot
// represent a 0.5m column sharply and pretending otherwise is what produced
// the last two rounds of inflated blobs. It makes the field COMPLETE, which
// is a different property and the one that stops light passing through walls.
//
// REUSE, NOT REWRITE: `bakeCore.rasterizeRecords` already walks triangles on a
// half-voxel barycentric lattice ("no crossed cell is skipped") and writes an
// `occupied` byte per cell. That is the voxelization; this module gives it the
// global grid, a dilation pass for two-sided sheets, and a GPU texture.
import * as THREE from "three/webgpu";
import { rasterizeRecords } from "./bakeCore.js";
import { serializeMeshForBake } from "./voxelizeOnce.js";

/**
 * Builds the occupancy grid for `meshes` over the volume.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds
 * @param {{x: number, y: number, z: number}} res
 * @param {{dilate?: boolean}} [options] dilate = grow occupancy by one voxel,
 *   which is what makes an open, one-sided sheet (a curtain, a banner) block
 *   light from BOTH sides. An unsigned field has no inside for such geometry,
 *   so without this the back face reads as empty — the "planes look half
 *   transparent from behind" report.
 */
export function buildOccupancyGrid(meshes, bounds, res, options = {}) {
  const t0 = performance.now();
  const cellCount = res.x * res.y * res.z;
  const cell = {
    x: (bounds.max.x - bounds.min.x) / res.x,
    y: (bounds.max.y - bounds.min.y) / res.y,
    z: (bounds.max.z - bounds.min.z) / res.z,
  };

  // rasterizeRecords writes into a full bake-array set. Only `occupied` is
  // wanted here, so the colour/normal channels share ONE scratch buffer —
  // they are written per cell and never read back (same trick bakeMeshSdf
  // uses for its seed pass).
  const scratch3 = new Float32Array(cellCount * 3);
  const arrays = {
    albedo: scratch3,
    emissive: scratch3,
    normalAcc: new Float32Array(cellCount * 3),
    sampleCount: new Uint32Array(cellCount),
    occupied: new Uint8Array(cellCount),
    // Seeds are the EDT's input; this pass does not run one, and marking every
    // record `excludeFromDistanceField` skips the (expensive) exact-band work
    // entirely — occupancy is all that is wanted.
    seed: new Float32Array(cellCount),
  };

  const records = [];
  for (const mesh of meshes) {
    const record = serializeMeshForBake(mesh);
    if (!record) continue;
    record.excludeFromDistanceField = true;
    records.push(record);
  }

  const triangles = rasterizeRecords(records, { bounds, res, cell, arrays }, null);
  let occupied = arrays.occupied;
  let occupiedCells = 0;
  for (let i = 0; i < cellCount; i++) if (occupied[i]) occupiedCells++;

  if (options.dilate !== false) {
    occupied = dilateOnce(occupied, res);
  }
  let dilatedCells = 0;
  for (let i = 0; i < cellCount; i++) if (occupied[i]) dilatedCells++;

  // RedFormat + HalfFloat, NEAREST. fp16 rather than the r8unorm this wanted
  // to be: r16float is the exact Data3DTexture format `meshSdfAtlas` already
  // samples in this same compute pass, so it is known to bind and read here,
  // and an occupancy grid that silently samples as zero is indistinguishable
  // from one that is working (both leave the field exactly as it was — which
  // is how the first attempt presented). 0x3c00 is half 1.0.
  const texels = new Uint16Array(cellCount);
  for (let i = 0; i < cellCount; i++) texels[i] = occupied[i] ? 0x3c00 : 0;
  const texture = new THREE.Data3DTexture(texels, res.x, res.y, res.z);
  texture.format = THREE.RedFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return {
    texture,
    data: occupied,
    res,
    stats: {
      triangles,
      cellCount,
      occupiedCells,
      dilatedCells,
      ms: performance.now() - t0,
    },
    dispose() {
      texture.dispose();
    },
  };
}

/**
 * One-voxel 6-neighbour dilation. Two-sided sheets need it (see the `dilate`
 * note above); it also closes the pinholes a half-voxel sample lattice can
 * leave where a triangle clips a cell corner.
 *
 * A GI occluder does not have to match the render mesh — being one voxel fat
 * costs a little contact shadow and buys watertightness, which is the trade
 * every leak in this module has come down to.
 */
function dilateOnce(src, res) {
  const out = new Uint8Array(src.length);
  const { x: rx, y: ry, z: rz } = res;
  for (let z = 0; z < rz; z++) {
    for (let y = 0; y < ry; y++) {
      const rowBase = (z * ry + y) * rx;
      for (let x = 0; x < rx; x++) {
        const i = rowBase + x;
        if (src[i]) {
          out[i] = 1;
          continue;
        }
        if (
          (x > 0 && src[i - 1]) ||
          (x + 1 < rx && src[i + 1]) ||
          (y > 0 && src[i - rx]) ||
          (y + 1 < ry && src[i + rx]) ||
          (z > 0 && src[i - rx * ry]) ||
          (z + 1 < rz && src[i + rx * ry])
        ) {
          out[i] = 1;
        }
      }
    }
  }
  return out;
}

/** One-line summary for the build log. */
export function describeOccupancy(grid) {
  const s = grid.stats;
  return (
    `${s.triangles} tris → ${s.occupiedCells} occupied cells ` +
    `(+${s.dilatedCells - s.occupiedCells} dilated) of ${s.cellCount}, ${s.ms.toFixed(0)}ms`
  );
}
