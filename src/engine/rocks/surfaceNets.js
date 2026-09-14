/**
 * Surface Nets isosurface extraction for signed distance fields, on typed
 * arrays (no BMesh — the editor's `voxelRemesh.js` builds editable topology;
 * this builds GPU buffers for thousands of rocks).
 *
 * One vertex per cell straddling the surface, at the mean of its edge
 * crossings; one quad per sign-changing grid edge. Output is indexed and
 * watertight, normals come from the SDF gradient (smooth where the field is
 * smooth, crisp where a fracture plane's smooth-max is tight), and a cavity
 * term sampled along the normal gives the ambient occlusion that makes carved
 * stone read as stone before any texture.
 *
 * Narrow band: the field is first evaluated at block centres; a block whose
 * distance exceeds its half-diagonal (divided by the field's Lipschitz bound)
 * cannot contain the surface and is filled with that sign without sampling.
 */

export const MAX_SURFACE_NET_SAMPLES = 8_000_000;

/**
 * @param {{ bounds: number[], distance: (x:number,y:number,z:number)=>number, lipschitz?: number }} field
 * @param {number} voxel  cell size in metres
 * @returns {{ positions: Float32Array, normals: Float32Array, occlusion: Float32Array, indices: Uint32Array, samples: number, evaluated: number }}
 */
export function* meshSignedDistanceSteps(field, voxel, { occlusion = true } = {}, clock = { due: () => false }) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = field.bounds;
  const L = Math.max(1, field.lipschitz ?? 1);
  // One extra layer of padding on every side keeps the surface closed at the bounds.
  const ox = minX - voxel, oy = minY - voxel, oz = minZ - voxel;
  const nx = Math.ceil((maxX - minX) / voxel) + 3, ny = Math.ceil((maxY - minY) / voxel) + 3, nz = Math.ceil((maxZ - minZ) / voxel) + 3;
  const count = nx * ny * nz;
  if (count > MAX_SURFACE_NET_SAMPLES) throw new RangeError(`meshSignedDistance: ${nx}x${ny}x${nz} exceeds the sample budget; raise the voxel size`);
  const values = new Float32Array(count);
  const known = new Uint8Array(count);
  const sdf = field.distance;
  let evaluated = 0;
  const B = 4;
  for (let bz = 0; bz < nz; bz += B) for (let by = 0; by < ny; by += B) for (let bx = 0; bx < nx; bx += B) {
    const ex = Math.min(nx, bx + B), ey = Math.min(ny, by + B), ez = Math.min(nz, bz + B);
    const cx = ox + (bx + ex - 1) / 2 * voxel, cy = oy + (by + ey - 1) / 2 * voxel, cz = oz + (bz + ez - 1) / 2 * voxel;
    const d = sdf(cx, cy, cz); evaluated++;
    const radius = Math.hypot(ex - bx, ey - by, ez - bz) * .5 * voxel;
    if (Math.abs(d) / L > radius + voxel) {
      for (let z = bz; z < ez; z++) for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const i = x + nx * (y + ny * z); values[i] = d; known[i] = 1;
      }
    }
  }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    // A wall or column variant evaluates ~10^6 samples (~0.5 s): yield per slice.
    if (x === 0 && y === 0 && clock.due()) yield 'rocks';
    const i = x + nx * (y + ny * z);
    if (known[i]) continue;
    // The padding layer is forced outside so every mesh closes.
    values[i] = (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1)
      ? Math.max(voxel, sdf(ox + x * voxel, oy + y * voxel, oz + z * voxel))
      : sdf(ox + x * voxel, oy + y * voxel, oz + z * voxel);
    evaluated++;
  }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
      const i = x + nx * (y + ny * z); if (values[i] < voxel * .5) values[i] = voxel * .5;
    }
  }

  // ---- vertices: one per straddling cell ----
  const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
  const cellVertex = new Int32Array(cellCount).fill(-1);
  const positions = [];
  const corner = new Float32Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const offset = (c) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  const OFFSETS = Array.from({ length: 8 }, (_, c) => offset(c));
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const [dx, dy, dz] = OFFSETS[c];
      const v = values[(x + dx) + nx * ((y + dy) + ny * (z + dz))];
      corner[c] = v; if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, crossings = 0;
    for (const [a, b] of EDGES) {
      const va = corner[a], vb = corner[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb), A = OFFSETS[a], Bo = OFFSETS[b];
      sx += A[0] + (Bo[0] - A[0]) * t; sy += A[1] + (Bo[1] - A[1]) * t; sz += A[2] + (Bo[2] - A[2]) * t;
      crossings++;
    }
    cellVertex[x + (nx - 1) * (y + (ny - 1) * z)] = positions.length / 3;
    positions.push(ox + (x + sx / crossings) * voxel, oy + (y + sy / crossings) * voxel, oz + (z + sz / crossings) * voxel);
  }

  // ---- quads: one per sign-changing grid edge ----
  const indices = [];
  const cell = (x, y, z) => cellVertex[x + (nx - 1) * (y + (ny - 1) * z)];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c); else indices.push(a, b, c, a, c, d);
  };
  // ⛔ One shared loop from 1 skipped every edge that STARTS on the low
  // padding layer (index 0 -> 1) along its own axis, so a solid clipped by the
  // bounds' low side (a buried rock foot) was left open: 78 boundary edges on a
  // spire. Each axis may start at 0 along itself; only the two axes it reads
  // cells across (index - 1) must start at 1.
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const i = x + nx * (y + ny * z), inside = values[i] < 0;
    if (inside !== (values[i + 1] < 0)) quad(cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y, z), cell(x, y - 1, z), !inside);
  }
  for (let z = 1; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = x + nx * (y + ny * z), inside = values[i] < 0;
    if (inside !== (values[i + nx] < 0)) quad(cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z), cell(x, y, z - 1), !inside);
  }
  for (let z = 0; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = x + nx * (y + ny * z), inside = values[i] < 0;
    if (inside !== (values[i + nx * ny] < 0)) quad(cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x, y, z), cell(x - 1, y, z), !inside);
  }

  // ---- normals from the field gradient, cavity occlusion along them ----
  const vertexCount = positions.length / 3;
  const P = new Float32Array(positions), N = new Float32Array(vertexCount * 3), O = new Float32Array(vertexCount);
  const e = voxel * .5;
  for (let v = 0; v < vertexCount; v++) {
    if ((v & 1023) === 0 && clock.due()) yield 'rocks';
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const len = Math.hypot(gx, gy, gz) || 1; gx /= len; gy /= len; gz /= len;
    N[v * 3] = gx; N[v * 3 + 1] = gy; N[v * 3 + 2] = gz;
    if (occlusion) {
      let occ = 0, weight = 1, total = 0;
      for (let k = 1; k <= 4; k++) {
        const step = voxel * 1.5 * k * k;
        const d = sdf(x + gx * step, y + gy * step, z + gz * step);
        occ += weight * Math.max(0, step - d) / step; total += weight; weight *= .6;
      }
      O[v] = 1 - Math.min(1, occ / total * 1.6);
    } else O[v] = 1;
  }
  evaluated += vertexCount * (occlusion ? 10 : 6);

  // Winding check: the quad rule above is fixed by construction, but confirm
  // against the field on the first triangles and flip everything if reversed.
  const I = new Uint32Array(indices);
  if (I.length >= 3) {
    let agree = 0;
    for (let t = 0; t < Math.min(I.length, 3000); t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      agree += Math.sign(fx * N[a] + fy * N[a + 1] + fz * N[a + 2]);
    }
    if (agree < 0) for (let t = 0; t < I.length; t += 3) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
  }
  return { positions: P, normals: N, occlusion: O, indices: I, samples: count, evaluated };
}

/** Synchronous twin of `meshSignedDistanceSteps` (tests, receipts, workers). */
export function meshSignedDistance(field, voxel, options = {}) {
  const steps = meshSignedDistanceSteps(field, voxel, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
