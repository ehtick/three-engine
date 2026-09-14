const mix = (a, b, t) => a + (b - a) * t;

/** Signed seeded value noise, with an allocation-free optional derivative path. */
export function createLandscapeNoise(seed = 1) {
  seed = Number(seed) >>> 0;
  const hash = (x, z) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 2147483647.5 - 1;
  };
  const gradient = (x, z, out = new Float64Array(3)) => {
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
    const lower = mix(a, b, sx), upper = mix(c, d, sx);
    out[0] = mix(lower, upper, sz);
    out[1] = mix(b - a, d - c, sz) * 6 * fx * (1 - fx);
    out[2] = (upper - lower) * 6 * fz * (1 - fz);
    return out;
  };
  const scratch = new Float64Array(3);
  const noise = (x, z) => gradient(x, z, scratch)[0];
  noise.gradient = gradient;
  return noise;
}
