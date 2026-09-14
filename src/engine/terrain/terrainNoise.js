/**
 * Seeded gradient noise for the landscape and rock generators.
 *
 * The older `world/landscapeNoise.js` is VALUE noise: its lattice corners are
 * plateaus, so every octave of it reads as soft squares (the same per-cell
 * constant that drew rectangles into the grass). Simplex has no axis-aligned
 * structure, a bounded analytic gradient, and costs about the same.
 *
 * Everything here is a pure function of (coordinates, seed): a chunk sampled
 * on its own gets exactly the numbers the whole world would, which is what
 * lets the World stream chunks without seams.
 */

const F2 = .5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3, G3 = 1 / 6;
// Scale that maps unit-gradient 2D simplex (t^4 kernel, radius^2 .5) to ~[-1, 1].
const SIMPLEX2_SCALE = 99.2;
const SIMPLEX3_SCALE = 32;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash in [0, 1). */
export function hash2(x, z, seed = 0) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function hash3(x, y, z, seed = 0) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 1103515245) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function permutation(seed) {
  const random = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(random() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/**
 * 2D simplex noise with its analytic gradient.
 * `noise(x, z)` returns the value; `noise.d(x, z, out)` fills out[0..2] with
 * value, d/dx, d/dz.
 */
export function createSimplex2(seed = 1) {
  const perm = permutation(seed >>> 0);
  const gx = new Float32Array(256), gz = new Float32Array(256);
  const random = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  for (let i = 0; i < 256; i++) { const a = random() * Math.PI * 2; gx[i] = Math.cos(a); gz[i] = Math.sin(a); }
  const scratch = new Float64Array(3);

  function d(x, z, out = scratch) {
    const s = (x + z) * F2, i = Math.floor(x + s), j = Math.floor(z + s);
    const t = (i + j) * G2, x0 = x - (i - t), z0 = z - (j - t);
    const i1 = x0 > z0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, z1 = z0 - j1 + G2, x2 = x0 - 1 + 2 * G2, z2 = z0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let value = 0, dx = 0, dz = 0;
    let t0 = .5 - x0 * x0 - z0 * z0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]], dot = gx[g] * x0 + gz[g] * z0, t2 = t0 * t0, t4 = t2 * t2;
      value += t4 * dot; dx += t4 * gx[g] - 8 * t2 * t0 * x0 * dot; dz += t4 * gz[g] - 8 * t2 * t0 * z0 * dot;
    }
    let t1 = .5 - x1 * x1 - z1 * z1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]], dot = gx[g] * x1 + gz[g] * z1, t2 = t1 * t1, t4 = t2 * t2;
      value += t4 * dot; dx += t4 * gx[g] - 8 * t2 * t1 * x1 * dot; dz += t4 * gz[g] - 8 * t2 * t1 * z1 * dot;
    }
    let t2v = .5 - x2 * x2 - z2 * z2;
    if (t2v > 0) {
      const g = perm[ii + 1 + perm[jj + 1]], dot = gx[g] * x2 + gz[g] * z2, t2 = t2v * t2v, t4 = t2 * t2;
      value += t4 * dot; dx += t4 * gx[g] - 8 * t2 * t2v * x2 * dot; dz += t4 * gz[g] - 8 * t2 * t2v * z2 * dot;
    }
    out[0] = value * SIMPLEX2_SCALE; out[1] = dx * SIMPLEX2_SCALE; out[2] = dz * SIMPLEX2_SCALE;
    return out;
  }
  const noise = (x, z) => d(x, z, scratch)[0];
  noise.d = d;
  return noise;
}

const GRAD3 = new Float32Array([1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1]);

/** 3D simplex noise, value only, ~[-1, 1]. Used by rock signed-distance fields. */
export function createSimplex3(seed = 1) {
  const perm = permutation((seed ^ 0x2545f491) >>> 0);
  const corner = (g, x, y, z, t) => {
    if (t <= 0) return 0;
    const k = (g % 12) * 3, t2 = t * t;
    return t2 * t2 * (GRAD3[k] * x + GRAD3[k + 1] * y + GRAD3[k + 2] * z);
  };
  return function noise3(x, y, z) {
    const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3, x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + .5, y3 = y0 - 1 + .5, z3 = z0 - 1 + .5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const n = corner(perm[ii + perm[jj + perm[kk]]], x0, y0, z0, .6 - x0 * x0 - y0 * y0 - z0 * z0)
      + corner(perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1, .6 - x1 * x1 - y1 * y1 - z1 * z1)
      + corner(perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2, .6 - x2 * x2 - y2 * y2 - z2 * z2)
      + corner(perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3, .6 - x3 * x3 - y3 * y3 - z3 * z3);
    return n * SIMPLEX3_SCALE;
  };
}

/**
 * Jittered-grid Worley (cellular) noise. `cells(x, z, out)` fills
 * out.f1, out.f2 (distances in cell units), out.id (hash in [0,1) of the
 * nearest feature point's cell) and out.cx/out.cz (that cell's integer coords).
 */
export function createWorley2(seed = 1, jitter = .85) {
  seed >>>= 0;
  return function cells(x, z, out = {}) {
    const ix = Math.floor(x), iz = Math.floor(z);
    let f1 = Infinity, f2 = Infinity, bx = 0, bz = 0, px = 0, pz = 0, sx = 0, sz = 0, qx = 0, qz = 0;
    for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cz = iz + oz;
      const fx = cx + .5 + (hash2(cx, cz, seed) - .5) * jitter, fz = cz + .5 + (hash2(cx, cz, seed + 7919) - .5) * jitter;
      const d = Math.hypot(x - fx, z - fz);
      if (d < f1) { f2 = f1; sx = bx; sz = bz; qx = px; qz = pz; f1 = d; bx = cx; bz = cz; px = fx; pz = fz; }
      else if (d < f2) { f2 = d; sx = cx; sz = cz; qx = fx; qz = fz; }
    }
    out.f1 = f1; out.f2 = f2; out.cx = bx; out.cz = bz; out.px = px; out.pz = pz; out.id = hash2(bx, bz, seed + 104729);
    // The runner-up cell, so a caller can blend across the shared border.
    out.cx2 = sx; out.cz2 = sz; out.px2 = qx; out.pz2 = qz; out.id2 = hash2(sx, sz, seed + 104729);
    return out;
  };
}
