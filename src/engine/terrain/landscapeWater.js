/**
 * One chunk's water surface from a landscape's hydrology (09-14, T6): lakes as
 * a flat grid at their level, rivers as ribbons along their reaches. Pure typed
 * arrays (a worker can build it), clock-sliced.
 *
 * Chunk contract, so neighbouring chunks never double-draw transparent water:
 *   - a lake quad belongs to the chunk its grid cell lies in, on a world-aligned
 *     lattice of `step` metres;
 *   - a river segment belongs to the chunk its START point lies in, and every
 *     ribbon vertex is computed from the global polyline, so pieces from two
 *     chunks meet exactly.
 *
 * Attributes: position, normal (up), waterFlow (vec2, m/s-ish along the river),
 * waterDepth (m of water over the bed, for tint), waterEdge (0..1 shore fade).
 */

export const WATER_LOD_STEP = Object.freeze([2, 4, 8]);
const smoothstep = (lo, hi, v) => { const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

export function* buildWaterChunkSteps(landscape, { x0, z0, size, lod = 0 }, clock = { due: () => false }) {
  const hydrology = landscape.hydrology;
  if (!hydrology) return null;
  const x1 = x0 + size, z1 = z0 + size;
  const positions = [], flow = [], depth = [], edge = [], indices = [];
  const point = {}, shore = {};
  const vertex = (x, y, z, fx, fz, d, e) => {
    positions.push(x, y, z); flow.push(fx, fz); depth.push(d); edge.push(e);
    return positions.length / 3 - 1;
  };
  // Facing +y whatever order the caller built the corners in.
  const triangle = (a, b, c) => {
    const ax = positions[a * 3], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1z = positions[b * 3 + 2] - az, e2x = positions[c * 3] - ax, e2z = positions[c * 3 + 2] - az;
    if (e1z * e2x - e1x * e2z >= 0) indices.push(a, b, c); else indices.push(a, c, b);
  };

  // ---- lakes ----
  if (hydrology.lakesIn(x0, z0, x1, z1).length) {
    const step = WATER_LOD_STEP[Math.min(lod, WATER_LOD_STEP.length - 1)];
    const i0 = Math.floor(x0 / step), i1 = Math.ceil(x1 / step), j0 = Math.floor(z0 / step), j1 = Math.ceil(z1 / step);
    const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
    const lake = new Int32Array(cols * rows).fill(-1), signed = new Float32Array(cols * rows), made = new Int32Array(cols * rows).fill(-1);
    for (let j = 0; j < rows; j++) {
      if (clock.due()) yield 'water';
      for (let i = 0; i < cols; i++) {
        hydrology.lakeAt((i0 + i) * step, (j0 + j) * step, shore);
        lake[j * cols + i] = shore.lake; signed[j * cols + i] = shore.signed;
      }
    }
    const corner = (i, j) => {
      const k = j * cols + i;
      if (made[k] >= 0) return made[k];
      const x = (i0 + i) * step, z = (j0 + j) * step, level = hydrology.lakes[lake[k]].level;
      const ground = landscape.sample(x, z, point).height;
      made[k] = vertex(x, level, z, 0, 0, Math.max(0, level - ground), smoothstep(-.5, 1.5, signed[k]));
      return made[k];
    };
    for (let j = 0; j < rows - 1; j++) {
      if (clock.due()) yield 'water';
      for (let i = 0; i < cols - 1; i++) {
        const cx = (i0 + i + .5) * step, cz = (j0 + j + .5) * step;
        if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
        const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1, id = lake[a];
        if (id < 0 || lake[b] !== id || lake[c] !== id || lake[d] !== id) continue;
        if (Math.max(signed[a], signed[b], signed[c], signed[d]) <= -1) continue;
        if (hydrology.reserveWeight(cx, cz) < .999) continue;
        const va = corner(i, j), vb = corner(i + 1, j), vc = corner(i, j + 1), vd = corner(i + 1, j + 1);
        triangle(va, vc, vb); triangle(vb, vc, vd);
      }
    }
  }

  // ---- rivers ----
  const segments = hydrology.riverSegmentsIn(x0, z0, x1, z1);
  const ribbon = (p, k) => {
    const n = p.length / 5, a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
    const tx = p[b * 5] - p[a * 5], tz = p[b * 5 + 1] - p[a * 5 + 1], tl = Math.hypot(tx, tz) || 1;
    const half = p[k * 5 + 3] / 2 + .9;
    return { x: p[k * 5], z: p[k * 5 + 1], y: p[k * 5 + 2], nx: -tz / tl * half, nz: tx / tl * half, fx: tx / tl, fz: tz / tl, depth: p[k * 5 + 4] };
  };
  for (let s = 0; s < segments.length; s++) {
    if ((s & 31) === 0 && clock.due()) yield 'water';
    const [r, k] = segments[s], p = hydrology.reaches[r].points;
    const A = ribbon(p, k), B = ribbon(p, k + 1);
    if (hydrology.reserveWeight(A.x, A.z) < .999 || hydrology.reserveWeight(B.x, B.z) < .999) continue;
    // Inside a lake the lake surface is the water; a ribbon there would double-draw.
    if (hydrology.lakeAt(A.x, A.z, shore).signed > 1 && hydrology.lakeAt(B.x, B.z, shore).signed > 1) continue;
    const length = Math.hypot(B.x - A.x, B.z - A.z) || 1, speed = Math.max(.3, Math.min(2.5, .35 + (A.y - B.y) / length * 40));
    const a0 = vertex(A.x + A.nx, A.y, A.z + A.nz, A.fx * speed, A.fz * speed, A.depth * .7, 1);
    const a1 = vertex(A.x - A.nx, A.y, A.z - A.nz, A.fx * speed, A.fz * speed, A.depth * .7, 1);
    const b0 = vertex(B.x + B.nx, B.y, B.z + B.nz, B.fx * speed, B.fz * speed, B.depth * .7, 1);
    const b1 = vertex(B.x - B.nx, B.y, B.z - B.nz, B.fx * speed, B.fz * speed, B.depth * .7, 1);
    triangle(a0, a1, b0); triangle(b0, a1, b1);
  }
  if (!indices.length) return null;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) { if (positions[i] < minY) minY = positions[i]; if (positions[i] > maxY) maxY = positions[i]; }
  const vertexCount = positions.length / 3;
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) normals[i * 3 + 1] = 1;
  return {
    positions: Float32Array.from(positions), normals, flow: Float32Array.from(flow), depth: Float32Array.from(depth), edge: Float32Array.from(edge),
    indices: vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices), vertexCount, minY, maxY, x0, z0, size,
  };
}

export function buildWaterChunk(landscape, options) {
  const steps = buildWaterChunkSteps(landscape, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
