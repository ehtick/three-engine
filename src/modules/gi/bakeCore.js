// Pure CPU bake core — NO three.js imports, plain typed arrays and math —
// so the exact same code runs on the main thread (initial build) and inside
// bakeWorker.js (re-bakes). One implementation, two execution contexts:
// duplicating the bake math across main/worker is how transports silently
// drift apart (the failure mode this module's plan explicitly forbids).
//
// Inputs are serialized mesh records (see voxelizeOnce serializeMeshForBake):
//   { id, geometryKey, positions: Float32Array, index: Uint16/Uint32Array|null,
//     matrix: number[16] (column-major world matrix),
//     color: {r,g,b}, emissive: {r,g,b}, emissiveIntensity: number }
// Lights are plain objects: { type: "point"|"directional",
//   position/direction: {x,y,z}, color: {r,g,b}, intensity }.
//
// Two bake entry points share every stage:
//   runBake            — full grid (initial build, structural changes)
//   runIncrementalBake — only the cells a set of changed meshes can affect:
//                        re-rasterize a dirty box, re-light dirty ∪ per-light
//                        shadow sweeps, re-EDT a cap-padded subgrid.

export const SDF_CAP = 16;
// "No seed" marker for the distance-field seeds, in minCell units. Squared it
// matches the EDT's internal INF (1e12) exactly.
const SEED_EMPTY = 1e6;
// Exact-band width in voxels: cells within this distance of a triangle get an
// EXACT point-to-triangle distance instead of the EDT's center-to-center
// approximation. The shadow penumbra estimator min(k·d/t) is driven by SMALL
// d values, so exactness near surfaces is what removes the dirty/terraced
// look; the far field can stay approximate.
const EXACT_BAND_VOXELS = 1.5;

export function allocateBakeArrays(cellCount) {
  return {
    albedo: new Float32Array(cellCount * 3),
    emissive: new Float32Array(cellCount * 3),
    normalAcc: new Float32Array(cellCount * 3),
    sampleCount: new Uint32Array(cellCount),
    occupied: new Uint8Array(cellCount),
    lit: new Uint8Array(cellCount),
    radiance: new Float32Array(cellCount * 4),
    surface: new Float32Array(cellCount * 4),
    normals: new Float32Array(cellCount * 4),
    distance: new Float32Array(cellCount),
    seed: new Float32Array(cellCount),
  };
}

/**
 * Squared distance from point P to triangle ABC (Ericson, Real-Time
 * Collision Detection §5.1.5). Scalar args to stay allocation-free in the
 * per-cell hot loop.
 */
export function pointTriangleDistSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    const qx = ax + abx * t - px;
    const qy = ay + aby * t - py;
    const qz = az + abz * t - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    const qx = ax + acx * t - px;
    const qy = ay + acy * t - py;
    const qz = az + acz * t - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bx + (cx - bx) * t - px;
    const qy = by + (cy - by) * t - py;
    const qz = bz + (cz - bz) * t - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

// ---------------------------------------------------------------- regions
// Inclusive cell-index boxes {x0,x1,y0,y1,z0,z1}. null = empty region.

export const fullRegion = (res) => ({ x0: 0, x1: res.x - 1, y0: 0, y1: res.y - 1, z0: 0, z1: res.z - 1 });

export function clampRegion(region, res) {
  if (!region) return null;
  const r = {
    x0: Math.max(0, region.x0),
    x1: Math.min(res.x - 1, region.x1),
    y0: Math.max(0, region.y0),
    y1: Math.min(res.y - 1, region.y1),
    z0: Math.max(0, region.z0),
    z1: Math.min(res.z - 1, region.z1),
  };
  return r.x0 > r.x1 || r.y0 > r.y1 || r.z0 > r.z1 ? null : r;
}

export function unionRegions(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    x1: Math.max(a.x1, b.x1),
    y0: Math.min(a.y0, b.y0),
    y1: Math.max(a.y1, b.y1),
    z0: Math.min(a.z0, b.z0),
    z1: Math.max(a.z1, b.z1),
  };
}

export const regionsIntersect = (a, b) =>
  !!a && !!b && a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 && a.z0 <= b.z1 && b.z0 <= a.z1;

export const regionCellCount = (r) => (r ? (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * (r.z1 - r.z0 + 1) : 0);

const expandRegionXYZ = (r, px, py, pz) =>
  r ? { x0: r.x0 - px, x1: r.x1 + px, y0: r.y0 - py, y1: r.y1 + py, z0: r.z0 - pz, z1: r.z1 + pz } : null;

/** World AABB {min:[x,y,z], max:[x,y,z]} → padded cell region (unclamped). */
export function aabbToRegion(aabb, bounds, cell, padWorld = 0) {
  return {
    x0: Math.floor((aabb.min[0] - padWorld - bounds.min.x) / cell.x),
    x1: Math.floor((aabb.max[0] + padWorld - bounds.min.x) / cell.x),
    y0: Math.floor((aabb.min[1] - padWorld - bounds.min.y) / cell.y),
    y1: Math.floor((aabb.max[1] + padWorld - bounds.min.y) / cell.y),
    z0: Math.floor((aabb.min[2] - padWorld - bounds.min.z) / cell.z),
    z1: Math.floor((aabb.max[2] + padWorld - bounds.min.z) / cell.z),
  };
}

/**
 * World-space AABB of a record: geometry-local AABB (computed once and
 * cached on `geometry.localAabb`) transformed by the record's matrix.
 */
export function recordWorldAabb(record, geometry) {
  if (!geometry?.positions?.length) return null;
  if (!geometry.localAabb) {
    const p = geometry.positions;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    geometry.localAabb = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }
  const { min, max } = geometry.localAabb;
  const m = record.matrix;
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let corner = 0; corner < 8; corner++) {
    const lx = corner & 1 ? max[0] : min[0];
    const ly = corner & 2 ? max[1] : min[1];
    const lz = corner & 4 ? max[2] : min[2];
    const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    if (wx < out.min[0]) out.min[0] = wx;
    if (wx > out.max[0]) out.max[0] = wx;
    if (wy < out.min[1]) out.min[1] = wy;
    if (wy > out.max[1]) out.max[1] = wy;
    if (wz < out.min[2]) out.min[2] = wz;
    if (wz > out.max[2]) out.max[2] = wz;
  }
  return out;
}

// ------------------------------------------------------------- rasterize

/**
 * Rasterizes records into the accumulator arrays (albedo/emissive/normalAcc/
 * sampleCount/occupied) + the exact-distance seed band. `clip` (cell region
 * or null) restricts all writes — used by incremental bakes so an unmoved
 * floor re-contributes only inside the dirty box.
 */
export function rasterizeRecords(records, ctx, clip = null) {
  const { bounds, res, cell, arrays } = ctx;
  const { albedo, emissive, normalAcc, sampleCount, occupied, seed } = arrays;
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const cellIndexOf = (ix, iy, iz) => (iz * res.y + iy) * res.x + ix;
  let triangles = 0;

  for (const record of records) {
    const { positions, index, matrix: m, color, emissive: emissiveColor, emissiveIntensity } = record;
    const vertexCount = index ? index.length : positions.length / 3;
    const triCount = vertexCount / 3;

    for (let tri = 0; tri < triCount; tri++) {
      const i0 = index ? index[tri * 3] : tri * 3;
      const i1 = index ? index[tri * 3 + 1] : tri * 3 + 1;
      const i2 = index ? index[tri * 3 + 2] : tri * 3 + 2;
      // world-transform the three vertices (column-major matrix)
      const transformed = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let corner = 0; corner < 3; corner++) {
        const vi = corner === 0 ? i0 : corner === 1 ? i1 : i2;
        const lx = positions[vi * 3];
        const ly = positions[vi * 3 + 1];
        const lz = positions[vi * 3 + 2];
        transformed[corner * 3] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        transformed[corner * 3 + 1] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        transformed[corner * 3 + 2] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      }
      const ax = transformed[0];
      const ay = transformed[1];
      const az = transformed[2];
      const e1x = transformed[3] - ax;
      const e1y = transformed[4] - ay;
      const e1z = transformed[5] - az;
      const e2x = transformed[6] - ax;
      const e2y = transformed[7] - ay;
      const e2z = transformed[8] - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const doubleArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (doubleArea < 1e-10) continue;
      nx /= doubleArea;
      ny /= doubleArea;
      nz /= doubleArea;

      // Cell footprint of this triangle padded by the exact band — used for
      // the band pass bounds AND to skip triangles entirely outside `clip`.
      const bandWorld = EXACT_BAND_VOXELS * minCell;
      const bvx = transformed[3];
      const bvy = transformed[4];
      const bvz = transformed[5];
      const cvx = transformed[6];
      const cvy = transformed[7];
      const cvz = transformed[8];
      let ix0 = Math.max(0, Math.floor((Math.min(ax, bvx, cvx) - bandWorld - bounds.min.x) / cell.x));
      let ix1 = Math.min(res.x - 1, Math.floor((Math.max(ax, bvx, cvx) + bandWorld - bounds.min.x) / cell.x));
      let iy0 = Math.max(0, Math.floor((Math.min(ay, bvy, cvy) - bandWorld - bounds.min.y) / cell.y));
      let iy1 = Math.min(res.y - 1, Math.floor((Math.max(ay, bvy, cvy) + bandWorld - bounds.min.y) / cell.y));
      let iz0 = Math.max(0, Math.floor((Math.min(az, bvz, cvz) - bandWorld - bounds.min.z) / cell.z));
      let iz1 = Math.min(res.z - 1, Math.floor((Math.max(az, bvz, cvz) + bandWorld - bounds.min.z) / cell.z));
      if (clip) {
        ix0 = Math.max(ix0, clip.x0);
        ix1 = Math.min(ix1, clip.x1);
        iy0 = Math.max(iy0, clip.y0);
        iy1 = Math.min(iy1, clip.y1);
        iz0 = Math.max(iz0, clip.z0);
        iz1 = Math.min(iz1, clip.z1);
      }
      if (ix0 > ix1 || iy0 > iy1 || iz0 > iz1) continue;
      triangles++;

      const len1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      const len2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
      const bcx = transformed[6] - transformed[3];
      const bcy = transformed[7] - transformed[4];
      const bcz = transformed[8] - transformed[5];
      const len3 = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
      const longestEdge = Math.max(len1, len2, len3);
      // Half-voxel barycentric lattice: no crossed cell is skipped.
      const samples = Math.max(1, Math.ceil((longestEdge / minCell) * 2));
      for (let a = 0; a <= samples; a++) {
        for (let b = 0; b <= samples - a; b++) {
          const u = a / samples;
          const v = b / samples;
          const px = ax + e1x * u + e2x * v;
          const py = ay + e1y * u + e2y * v;
          const pz = az + e1z * u + e2z * v;
          // Skip (don't clamp) out-of-grid samples — clamping merges a
          // boundary wall's outer face into the inner face's cells and
          // cancels the normals (kills the direct bake shell-wide).
          const fx = (px - bounds.min.x) / cell.x;
          const fy = (py - bounds.min.y) / cell.y;
          const fz = (pz - bounds.min.z) / cell.z;
          if (fx < 0 || fy < 0 || fz < 0 || fx >= res.x || fy >= res.y || fz >= res.z) continue;
          const sx = Math.floor(fx);
          const sy = Math.floor(fy);
          const sz = Math.floor(fz);
          if (clip && (sx < clip.x0 || sx > clip.x1 || sy < clip.y0 || sy > clip.y1 || sz < clip.z0 || sz > clip.z1))
            continue;
          const ci = cellIndexOf(sx, sy, sz);
          occupied[ci] = 1;
          albedo[ci * 3] = color.r;
          albedo[ci * 3 + 1] = color.g;
          albedo[ci * 3 + 2] = color.b;
          emissive[ci * 3] = emissiveColor.r * emissiveIntensity;
          emissive[ci * 3 + 1] = emissiveColor.g * emissiveIntensity;
          emissive[ci * 3 + 2] = emissiveColor.b * emissiveIntensity;
          normalAcc[ci * 3] += nx;
          normalAcc[ci * 3 + 1] += ny;
          normalAcc[ci * 3 + 2] += nz;
          sampleCount[ci]++;
        }
      }

      // ------------------------------------------- exact-distance narrow band
      // Meshes with a per-mesh SDF are EXCLUDED from the scene distance
      // field (their crisp local field replaces the coarse voxel one via
      // min() in the shadow trace — keeping their coarse seeds would drag
      // the min back down to voxel dirt). They still rasterize occupancy/
      // albedo above: the radiance DDA and bounce cache need them.
      if (record.excludeFromDistanceField) continue;
      // Sub-half-voxel triangles: distance-to-centroid (error ≤ edge/2, far
      // below the band's purpose) at a fraction of the exact test's cost —
      // this is what keeps 100k-tri characters affordable.
      const tinyTri = longestEdge < minCell * 0.4;
      const gcx = (ax + bvx + cvx) / 3;
      const gcy = (ay + bvy + cvy) / 3;
      const gcz = (az + bvz + cvz) / 3;
      for (let sz = iz0; sz <= iz1; sz++) {
        const ccz = bounds.min.z + (sz + 0.5) * cell.z;
        for (let sy = iy0; sy <= iy1; sy++) {
          const ccy = bounds.min.y + (sy + 0.5) * cell.y;
          let rowIdx = (sz * res.y + sy) * res.x + ix0;
          for (let sx = ix0; sx <= ix1; sx++, rowIdx++) {
            const ccx = bounds.min.x + (sx + 0.5) * cell.x;
            // Only improvements matter: cap by the cell's current seed.
            const limit = Math.min(bandWorld, seed[rowIdx] * minCell);
            let d;
            if (tinyTri) {
              const dx = ccx - gcx;
              const dy = ccy - gcy;
              const dz = ccz - gcz;
              d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            } else {
              // Plane distance is a lower bound on triangle distance — cheap cull.
              const pd = nx * (ccx - ax) + ny * (ccy - ay) + nz * (ccz - az);
              if (pd >= limit || pd <= -limit) continue;
              d = Math.sqrt(pointTriangleDistSq(ccx, ccy, ccz, ax, ay, az, bvx, bvy, bvz, cvx, cvy, cvz));
            }
            if (d < limit) seed[rowIdx] = d / minCell;
          }
        }
      }
    }
  }
  return triangles;
}

// ----------------------------------------------------------- direct light

/**
 * Recomputes radiance/surface/normals/lit for every cell in `region` from
 * the accumulator arrays. All semantics carried over verbatim from the
 * original implementation: |ndotl| for thin-plane facing, 0.35 normal
 * reliability gate (emissive exempt), Lambert /π, half-voxel shadow march
 * over the full occupancy grid.
 */
export function bakeDirectLight(ctx, lights, region) {
  const { bounds, res, cell, arrays } = ctx;
  const { albedo, emissive, normalAcc, sampleCount, occupied, lit, radiance, surface, normals } = arrays;
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const cellIndexOf = (ix, iy, iz) => (iz * res.y + iy) * res.x + ix;

  const marchBlocked = (fromX, fromY, fromZ, dirX, dirY, dirZ, maxT) => {
    const stepLen = minCell * 0.5;
    for (let t = minCell * 1.5; t < maxT - minCell; t += stepLen) {
      const ix = Math.floor((fromX + dirX * t - bounds.min.x) / cell.x);
      const iy = Math.floor((fromY + dirY * t - bounds.min.y) / cell.y);
      const iz = Math.floor((fromZ + dirZ * t - bounds.min.z) / cell.z);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= res.x || iy >= res.y || iz >= res.z) return false;
      if (occupied[cellIndexOf(ix, iy, iz)]) return true;
    }
    return false;
  };

  const sizeX = bounds.max.x - bounds.min.x;
  const sizeY = bounds.max.y - bounds.min.y;
  const sizeZ = bounds.max.z - bounds.min.z;
  const gridDiagonal = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ);

  for (let iz = region.z0; iz <= region.z1; iz++) {
    for (let iy = region.y0; iy <= region.y1; iy++) {
      for (let ix = region.x0; ix <= region.x1; ix++) {
        const ci = cellIndexOf(ix, iy, iz);
        // Region cells are recomputed from scratch — clear first.
        radiance[ci * 4] = 0;
        radiance[ci * 4 + 1] = 0;
        radiance[ci * 4 + 2] = 0;
        radiance[ci * 4 + 3] = 0;
        surface[ci * 4] = 0;
        surface[ci * 4 + 1] = 0;
        surface[ci * 4 + 2] = 0;
        surface[ci * 4 + 3] = 0;
        normals[ci * 4] = 0;
        normals[ci * 4 + 1] = 0;
        normals[ci * 4 + 2] = 0;
        normals[ci * 4 + 3] = 0;
        lit[ci] = 0;
        if (!occupied[ci]) continue;
        radiance[ci * 4 + 3] = 1;
        let r = emissive[ci * 3];
        let g = emissive[ci * 3 + 1];
        let b = emissive[ci * 3 + 2];

        const cx = bounds.min.x + (ix + 0.5) * cell.x;
        const cy = bounds.min.y + (iy + 0.5) * cell.y;
        const cz = bounds.min.z + (iz + 0.5) * cell.z;
        let nAx = normalAcc[ci * 3];
        let nAy = normalAcc[ci * 3 + 1];
        let nAz = normalAcc[ci * 3 + 2];
        const nLen = Math.sqrt(nAx * nAx + nAy * nAy + nAz * nAz);
        // Reliability |Σn|/count: junction cells (opposing faces sharing a
        // cell) → ~0 → no direct (garbled normal would light them like a
        // decal); emissive stays — it's isotropic.
        const reliability = nLen / Math.max(1, sampleCount[ci]);
        if (nLen > 1e-4) {
          nAx /= nLen;
          nAy /= nLen;
          nAz /= nLen;
        }
        surface[ci * 4] = albedo[ci * 3];
        surface[ci * 4 + 1] = albedo[ci * 3 + 1];
        surface[ci * 4 + 2] = albedo[ci * 3 + 2];
        surface[ci * 4 + 3] = reliability;
        normals[ci * 4] = nAx;
        normals[ci * 4 + 1] = nAy;
        normals[ci * 4 + 2] = nAz;

        let cellLit = false;
        if (reliability < 0.35) {
          radiance[ci * 4] = r;
          radiance[ci * 4 + 1] = g;
          radiance[ci * 4 + 2] = b;
          continue;
        }
        for (const entry of lights) {
          let lx;
          let ly;
          let lz;
          let dist;
          if (entry.type === "directional") {
            const dLen =
              Math.sqrt(
                entry.direction.x * entry.direction.x +
                  entry.direction.y * entry.direction.y +
                  entry.direction.z * entry.direction.z,
              ) || 1;
            lx = -entry.direction.x / dLen;
            ly = -entry.direction.y / dLen;
            lz = -entry.direction.z / dLen;
            dist = gridDiagonal;
          } else {
            lx = entry.position.x - cx;
            ly = entry.position.y - cy;
            lz = entry.position.z - cz;
            dist = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-6;
            lx /= dist;
            ly /= dist;
            lz /= dist;
          }
          // |ndotl|: thin planes have arbitrary facing — light both sides.
          const ndotl = Math.abs(nAx * lx + nAy * ly + nAz * lz);
          if (ndotl <= 1e-4) continue;
          if (marchBlocked(cx, cy, cz, lx, ly, lz, dist)) continue;
          // Lambertian outgoing = albedo · E / π (multi-bounce compounds
          // any excess; the /π keeps enclosed rooms convergent).
          const atten =
            (entry.type === "directional" ? entry.intensity : entry.intensity / Math.max(1, dist * dist)) /
            Math.PI;
          r += albedo[ci * 3] * entry.color.r * atten * ndotl;
          g += albedo[ci * 3 + 1] * entry.color.g * atten * ndotl;
          b += albedo[ci * 3 + 2] * entry.color.b * atten * ndotl;
          cellLit = true;
        }
        if (cellLit) lit[ci] = 1;
        radiance[ci * 4] = r;
        radiance[ci * 4 + 1] = g;
        radiance[ci * 4 + 2] = b;
      }
    }
  }
}

// -------------------------------------------------------------------- EDT

/**
 * EXACT Euclidean distance transform (separable Felzenszwalb over squared
 * distances) restricted to a cell region. Chamfer variants advance in
 * quantized 1/√2/√3 increments whose metric ridges showed straight through
 * the shadow penumbra as hard layer transitions. Output: linear distance in
 * minCell units, capped at SDF_CAP.
 *
 * Seeded: `seed` carries exact sub-voxel surface distances (minCell units)
 * for cells in the rasterizer's narrow band, SEED_EMPTY elsewhere. The
 * envelope pass computes min_p sqrt(|q−p|² + seed_p²) — continuous
 * everywhere, exact inside the band (a cell's own seed wins), and a
 * conservative smooth approximation beyond it.
 */
function edtRegion(seed, distance, res, cell, region) {
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const INF = 1e12;
  const nx = region.x1 - region.x0 + 1;
  const ny = region.y1 - region.y0 + 1;
  const nz = region.z1 - region.z0 + 1;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const dt1d = (count, pitch) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    const s2 = pitch * pitch;
    for (let q = 1; q < count; q++) {
      let sVal;
      while (true) {
        const p = v[k];
        sVal = (f[q] + s2 * q * q - (f[p] + s2 * p * p)) / (2 * s2 * (q - p));
        if (sVal <= z[k]) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = sVal;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = s2 * (q - p) * (q - p) + f[p];
    }
  };

  const idxOf = (ix, iy, iz) => (iz * res.y + iy) * res.x + ix;
  for (let iz = region.z0; iz <= region.z1; iz++) {
    for (let iy = region.y0; iy <= region.y1; iy++) {
      for (let ix = region.x0; ix <= region.x1; ix++) {
        const i = idxOf(ix, iy, iz);
        const s = seed[i];
        distance[i] = s >= SEED_EMPTY ? INF : s * s;
      }
    }
  }
  const sx = cell.x / minCell;
  const sy = cell.y / minCell;
  const sz = cell.z / minCell;
  for (let iz = region.z0; iz <= region.z1; iz++) {
    for (let iy = region.y0; iy <= region.y1; iy++) {
      for (let ix = region.x0; ix <= region.x1; ix++) f[ix - region.x0] = distance[idxOf(ix, iy, iz)];
      dt1d(nx, sx);
      for (let ix = region.x0; ix <= region.x1; ix++) distance[idxOf(ix, iy, iz)] = d[ix - region.x0];
    }
  }
  for (let iz = region.z0; iz <= region.z1; iz++) {
    for (let ix = region.x0; ix <= region.x1; ix++) {
      for (let iy = region.y0; iy <= region.y1; iy++) f[iy - region.y0] = distance[idxOf(ix, iy, iz)];
      dt1d(ny, sy);
      for (let iy = region.y0; iy <= region.y1; iy++) distance[idxOf(ix, iy, iz)] = d[iy - region.y0];
    }
  }
  for (let iy = region.y0; iy <= region.y1; iy++) {
    for (let ix = region.x0; ix <= region.x1; ix++) {
      for (let iz = region.z0; iz <= region.z1; iz++) f[iz - region.z0] = distance[idxOf(ix, iy, iz)];
      dt1d(nz, sz);
      for (let iz = region.z0; iz <= region.z1; iz++) distance[idxOf(ix, iy, iz)] = d[iz - region.z0];
    }
  }
  for (let iz = region.z0; iz <= region.z1; iz++) {
    for (let iy = region.y0; iy <= region.y1; iy++) {
      for (let ix = region.x0; ix <= region.x1; ix++) {
        const i = idxOf(ix, iy, iz);
        distance[i] = Math.min(SDF_CAP, Math.sqrt(distance[i]));
      }
    }
  }
}

export function computeDistanceField(seed, distance, res, cell) {
  edtRegion(seed, distance, res, cell, fullRegion(res));
}

/**
 * Region EDT for incremental bakes. Seed changes inside `writeRegion` can
 * alter distances up to SDF_CAP voxels away, and a write-region cell's true
 * nearest seed lies within SDF_CAP of it (or the value caps) — so computing
 * on a subgrid padded by the cap and KEEPING only the cap-padded write area
 * is exact; the outer margin ring (where outside seeds were invisible) is
 * restored from the previous field.
 */
export function computeDistanceFieldRegion(seed, distance, res, cell, writeRegion) {
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const capX = Math.ceil((SDF_CAP * minCell) / cell.x) + 1;
  const capY = Math.ceil((SDF_CAP * minCell) / cell.y) + 1;
  const capZ = Math.ceil((SDF_CAP * minCell) / cell.z) + 1;
  const keep = clampRegion(expandRegionXYZ(writeRegion, capX, capY, capZ), res);
  const subgrid = clampRegion(expandRegionXYZ(keep, capX, capY, capZ), res);
  if (!subgrid) return;

  // Stash the margin ring (subgrid ∖ keep) — its recomputed values would be
  // missing contributions from seeds outside the subgrid.
  const stash = new Float32Array(regionCellCount(subgrid));
  let s = 0;
  for (let iz = subgrid.z0; iz <= subgrid.z1; iz++) {
    for (let iy = subgrid.y0; iy <= subgrid.y1; iy++) {
      const base = (iz * res.y + iy) * res.x;
      for (let ix = subgrid.x0; ix <= subgrid.x1; ix++) stash[s++] = distance[base + ix];
    }
  }
  edtRegion(seed, distance, res, cell, subgrid);
  s = 0;
  for (let iz = subgrid.z0; iz <= subgrid.z1; iz++) {
    const inZ = iz >= keep.z0 && iz <= keep.z1;
    for (let iy = subgrid.y0; iy <= subgrid.y1; iy++) {
      const inY = inZ && iy >= keep.y0 && iy <= keep.y1;
      const base = (iz * res.y + iy) * res.x;
      for (let ix = subgrid.x0; ix <= subgrid.x1; ix++, s++) {
        if (!(inY && ix >= keep.x0 && ix <= keep.x1)) distance[base + ix] = stash[s];
      }
    }
  }
}

// ----------------------------------------------------------- per-mesh SDF

// Per-mesh SDF resolution: longest local axis gets this many cells, other
// axes scale by aspect (min 8). 64³ of a character ≈ 10× finer effective
// detail than the runtime scene grid can afford.
export const MESH_SDF_MAX_AXIS = 64;
// Distance cap in CELL units (same convention as the scene field).
export const MESH_SDF_CAP = 16;

// Shared view pair for the float32 → half-float bit conversion below —
// bakeCore stays dependency-free (no THREE import), so this can't reuse
// THREE.DataUtils.toHalfFloat().
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/**
 * Converts a float32 value to IEEE 754 half-float (fp16) bits, round-to-
 * nearest. Standard bit-twiddling conversion (sign/exponent/mantissa
 * re-bias + round); callers here only ever pass normalized [0, 1] values so
 * overflow/NaN handling is minimal.
 */
function float32ToHalfBits(value) {
  _f32[0] = value;
  const x = _u32[0];
  let bits = (x >> 16) & 0x8000; // sign
  let m = (x >> 12) & 0x07ff; // mantissa
  const e = (x >> 23) & 0xff; // exponent
  if (e < 103) return bits; // underflows to zero
  if (e > 142) {
    bits |= 0x7c00; // overflow → infinity (unreachable for [0,1] inputs)
    bits |= (e === 255 ? 0 : 1) && (x & 0x007fffff);
    return bits;
  }
  if (e < 113) {
    // Denormalized half.
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  // Normalized half, round-to-nearest-even.
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

/**
 * Bakes an UNSIGNED narrow-band-exact distance field for one geometry in
 * its LOCAL space — same math as the scene field (exact point-to-triangle
 * band + seeded Felzenszwalb EDT), just much denser. Quantized to u16
 * IEEE-754 half-float bits of (d/cap): the shadow tracer's min() only needs
 * ~0.06-cell precision.
 *
 * Returns { data: Uint16Array, dims: {x,y,z}, boundsMin: [x,y,z],
 * cellSize: [x,y,z] } — distances decode as value · MESH_SDF_CAP ·
 * min(cellSize) world(local) units.
 */
export function bakeMeshSdf(positions, index, maxAxisRes = MESH_SDF_MAX_AXIS) {
  // Local AABB + one band of padding so surface cells never clip.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }
  const spanX = Math.max(1e-4, maxX - minX);
  const spanY = Math.max(1e-4, maxY - minY);
  const spanZ = Math.max(1e-4, maxZ - minZ);
  const maxSpan = Math.max(spanX, spanY, spanZ);
  const cellLen = maxSpan / (maxAxisRes - 4);
  const pad = cellLen * 2;
  const bounds = {
    min: { x: minX - pad, y: minY - pad, z: minZ - pad },
    max: { x: maxX + pad, y: maxY + pad, z: maxZ + pad },
  };
  const res = {
    x: Math.max(8, Math.min(maxAxisRes, Math.round((spanX + pad * 2) / cellLen))),
    y: Math.max(8, Math.min(maxAxisRes, Math.round((spanY + pad * 2) / cellLen))),
    z: Math.max(8, Math.min(maxAxisRes, Math.round((spanZ + pad * 2) / cellLen))),
  };
  const cell = {
    x: (bounds.max.x - bounds.min.x) / res.x,
    y: (bounds.max.y - bounds.min.y) / res.y,
    z: (bounds.max.z - bounds.min.z) / res.z,
  };
  const cellCount = res.x * res.y * res.z;
  const minCell = Math.min(cell.x, cell.y, cell.z);

  // Seed pass: reuse the scene rasterizer's band machinery via a minimal
  // arrays shim (only occupancy/seed matter here; the color fields are a
  // single shared scratch — rasterizeRecords writes them per-cell, nothing
  // reads them back).
  const seed = new Float32Array(cellCount).fill(1e6);
  const scratch3 = new Float32Array(cellCount * 3);
  const arrays = {
    albedo: scratch3,
    emissive: scratch3,
    normalAcc: new Float32Array(cellCount * 3),
    sampleCount: new Uint32Array(cellCount),
    occupied: new Uint8Array(cellCount),
    seed,
  };
  const record = {
    positions,
    index,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    color: { r: 1, g: 1, b: 1 },
    emissive: { r: 0, g: 0, b: 0 },
    emissiveIntensity: 0,
  };
  rasterizeRecords([record], { bounds, res, cell, arrays }, null);

  const distance = new Float32Array(cellCount);
  computeDistanceField(seed, distance, res, cell);

  // Normalize to [0,1] (distance is in minCell units capped at SDF_CAP==16;
  // divide by MESH_SDF_CAP just in case the constants ever diverge) and
  // quantize to fp16 half-bits.
  const data = new Uint16Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    data[i] = float32ToHalfBits(Math.min(1, distance[i] / MESH_SDF_CAP));
  }
  return {
    data,
    dims: res,
    boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
    boundsSize: [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z],
    minCell,
  };
}

// -------------------------------------------------------------- orchestration

export function recountStats(arrays, cellCount) {
  const { occupied, lit, emissive } = arrays;
  let occupiedCells = 0;
  let litCells = 0;
  let emissiveCells = 0;
  for (let i = 0; i < cellCount; i++) {
    if (!occupied[i]) continue;
    occupiedCells++;
    if (lit[i]) litCells++;
    if (emissive[i * 3] + emissive[i * 3 + 1] + emissive[i * 3 + 2] > 1e-4) emissiveCells++;
  }
  return { occupiedCells, litCells, emissiveCells };
}

/**
 * Full bake pipeline: rasterize records → direct-light bake → exact EDT.
 * Fills `arrays` in place and returns stats.
 */
export function runBake({ records, bounds, res, cell, lights, arrays }) {
  const cellCount = res.x * res.y * res.z;
  arrays.albedo.fill(0);
  arrays.emissive.fill(0);
  arrays.normalAcc.fill(0);
  arrays.sampleCount.fill(0);
  arrays.occupied.fill(0);
  arrays.lit.fill(0);
  arrays.radiance.fill(0);
  arrays.surface.fill(0);
  arrays.normals.fill(0);
  arrays.seed.fill(SEED_EMPTY);

  const ctx = { bounds, res, cell, arrays };
  const triangles = rasterizeRecords(records, ctx, null);
  bakeDirectLight(ctx, lights, fullRegion(res));
  computeDistanceField(arrays.seed, arrays.distance, res, cell);
  return { triangles, cellCount, ...recountStats(arrays, cellCount) };
}

/**
 * Conservative cell region a light's shadowing can change when occupancy
 * inside `dirty` changed: extrude the dirty box's corners away from the
 * light until they exit the grid (slab method), union with the box itself.
 */
function lightSweepRegion(dirty, light, bounds, res, cell) {
  const corners = [];
  for (let c = 0; c < 8; c++) {
    corners.push([
      bounds.min.x + (c & 1 ? dirty.x1 + 1 : dirty.x0) * cell.x,
      bounds.min.y + (c & 2 ? dirty.y1 + 1 : dirty.y0) * cell.y,
      bounds.min.z + (c & 4 ? dirty.z1 + 1 : dirty.z0) * cell.z,
    ]);
  }
  const exitT = (o, d) => {
    let t = Infinity;
    const axes = [
      [o[0], d[0], bounds.min.x, bounds.max.x],
      [o[1], d[1], bounds.min.y, bounds.max.y],
      [o[2], d[2], bounds.min.z, bounds.max.z],
    ];
    for (const [oa, da, lo, hi] of axes) {
      if (Math.abs(da) < 1e-8) continue;
      const ta = ((da > 0 ? hi : lo) - oa) / da;
      if (ta >= 0 && ta < t) t = ta;
    }
    return Number.isFinite(t) ? t : 0;
  };

  const aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const extend = (p) => {
    for (let a = 0; a < 3; a++) {
      if (p[a] < aabb.min[a]) aabb.min[a] = p[a];
      if (p[a] > aabb.max[a]) aabb.max[a] = p[a];
    }
  };
  for (const c of corners) {
    extend(c);
    let d;
    if (light.type === "directional") {
      const len =
        Math.sqrt(
          light.direction.x * light.direction.x +
            light.direction.y * light.direction.y +
            light.direction.z * light.direction.z,
        ) || 1;
      d = [light.direction.x / len, light.direction.y / len, light.direction.z / len];
    } else {
      const dx = c[0] - light.position.x;
      const dy = c[1] - light.position.y;
      const dz = c[2] - light.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Light inside the dirty box — its shadows can reach anywhere.
      if (len < 1e-6) return fullRegion(res);
      d = [dx / len, dy / len, dz / len];
    }
    const t = exitT(c, d);
    extend([c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t]);
  }
  return aabbToRegion(aabb, bounds, cell, Math.min(cell.x, cell.y, cell.z));
}

/**
 * Incremental bake: given the FULL current record list (with `worldAabb`
 * attached) and the world AABBs invalidated by this change set (old + new
 * boxes of every changed/removed record), recompute only what those boxes
 * can affect. The caller must have `arrays` holding the complete previous
 * bake result (accumulators AND outputs).
 *
 * Returns null when the dirty area is a large fraction of the grid — caller
 * should run a full bake instead.
 */
export function runIncrementalBake({ records, dirtyAabbs, bounds, res, cell, lights, arrays, maxDirtyFraction = 0.35 }) {
  const cellCount = res.x * res.y * res.z;
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const bandWorld = EXACT_BAND_VOXELS * minCell;
  const maxCell = Math.max(cell.x, cell.y, cell.z);

  let dirty = null;
  for (const aabb of dirtyAabbs) {
    if (!aabb) continue;
    dirty = unionRegions(dirty, aabbToRegion(aabb, bounds, cell, bandWorld + maxCell));
  }
  dirty = clampRegion(dirty, res);
  if (!dirty) return { triangles: 0, cellCount, ...recountStats(arrays, cellCount) };
  if (regionCellCount(dirty) > cellCount * maxDirtyFraction) return null;

  // Clear accumulators + seeds in the dirty box, then re-rasterize every
  // record whose footprint reaches into it (clipped, so unmoved neighbors
  // re-contribute only inside the box).
  const { albedo, emissive, normalAcc, sampleCount, occupied, seed } = arrays;
  for (let iz = dirty.z0; iz <= dirty.z1; iz++) {
    for (let iy = dirty.y0; iy <= dirty.y1; iy++) {
      let ci = (iz * res.y + iy) * res.x + dirty.x0;
      for (let ix = dirty.x0; ix <= dirty.x1; ix++, ci++) {
        albedo[ci * 3] = 0;
        albedo[ci * 3 + 1] = 0;
        albedo[ci * 3 + 2] = 0;
        emissive[ci * 3] = 0;
        emissive[ci * 3 + 1] = 0;
        emissive[ci * 3 + 2] = 0;
        normalAcc[ci * 3] = 0;
        normalAcc[ci * 3 + 1] = 0;
        normalAcc[ci * 3 + 2] = 0;
        sampleCount[ci] = 0;
        occupied[ci] = 0;
        seed[ci] = SEED_EMPTY;
      }
    }
  }

  const ctx = { bounds, res, cell, arrays };
  let triangles = 0;
  for (const record of records) {
    const footprint = record.worldAabb ? aabbToRegion(record.worldAabb, bounds, cell, bandWorld) : null;
    if (!footprint || regionsIntersect(footprint, dirty)) {
      triangles += rasterizeRecords([record], ctx, dirty);
    }
  }

  // Direct light: dirty cells changed occupancy/material; cells in each
  // light's shadow sweep may have gained/lost occlusion.
  let litRegion = dirty;
  for (const light of lights) {
    litRegion = unionRegions(litRegion, lightSweepRegion(dirty, light, bounds, res, cell));
  }
  litRegion = clampRegion(litRegion, res);
  bakeDirectLight(ctx, lights, litRegion);

  computeDistanceFieldRegion(seed, arrays.distance, res, cell, dirty);

  // Everything this bake can have written: lit cells + the EDT's kept area
  // (dirty padded by the cap) — callers use it to bound their result diff.
  const capX = Math.ceil((SDF_CAP * minCell) / cell.x) + 1;
  const capY = Math.ceil((SDF_CAP * minCell) / cell.y) + 1;
  const capZ = Math.ceil((SDF_CAP * minCell) / cell.z) + 1;
  const touched = clampRegion(
    unionRegions(litRegion, expandRegionXYZ(dirty, capX, capY, capZ)),
    res,
  );
  return { triangles, cellCount, touched, ...recountStats(arrays, cellCount) };
}
