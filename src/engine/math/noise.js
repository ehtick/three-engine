// @ts-check
/**
 * Coherent noise — random that varies *smoothly*.
 *
 * `random()` per frame gives you jitter; noise gives you wind, a drifting
 * camera sway, terrain, a flickering torch, a cloud mask. The difference is
 * that noise is a function of position: sample it twice at nearby coordinates
 * and you get nearby values, and sample it at the same coordinate a year later
 * and you get the same value. That reproducibility is why terrain generated
 * from noise needs no storage.
 *
 * Everything here is seeded and deterministic. The module-level {@link noise}
 * uses a fixed default seed, so a scene built against it looks identical on
 * every machine; call `noise.create(seed)` for an independent field.
 */

import { lerp, mod, smootherstep } from "./scalar.js";
import { hashInt, hashString } from "./bits.js";

/**
 * The lattice-corner hash. `hashInt` replaces the 512-entry permutation table
 * classic Perlin ships: nothing to allocate per seed, and no period-256
 * repeat to show up as a tiling artifact on a large field.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} seed
 * @returns {number}
 */
function hash3(x, y, z, seed) {
  return hashInt(hashInt(hashInt(x + seed) + y) + z);
}


/** A field of coherent noise with its own seed. */
export class Noise {
  /**
   * @param {number | string} [seed=0]
   */
  constructor(seed = 0) {
    /** @type {number} */
    this.seed = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  }

  /**
   * A deterministic pseudo-random value in `[0, 1)` for an integer lattice
   * point. Unlike {@link import("./random.js").random}, this has no sequence:
   * the same coordinate always returns the same number, in any order, from any
   * thread. That is what makes chunked/streamed generation possible.
   *
   * @param {number} x
   * @param {number} [y=0]
   * @param {number} [z=0]
   * @returns {number}
   */
  hash(x, y = 0, z = 0) {
    return hash3(Math.floor(x), Math.floor(y), Math.floor(z), this.seed) / 4294967296;
  }

  /**
   * 2D Perlin noise in roughly `[-1, 1]`, zero at every integer lattice point.
   * The workhorse: terrain height, wind, wood grain, cloud cover.
   *
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  perlin2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    // Quintic fade, not the cubic one: cubic leaves a visible second-derivative
    // discontinuity at the lattice, which shows up as a faint grid on any
    // surface lit by a normal derived from the noise.
    const u = smootherstep(0, 1, xf);
    const v = smootherstep(0, 1, yf);

    const g00 = this.#grad2(xi, yi, xf, yf);
    const g10 = this.#grad2(xi + 1, yi, xf - 1, yf);
    const g01 = this.#grad2(xi, yi + 1, xf, yf - 1);
    const g11 = this.#grad2(xi + 1, yi + 1, xf - 1, yf - 1);

    // ×√2 normalizes the output: 2D gradient noise with unit gradients is
    // bounded by ±1/√2, so the raw value never reaches ±1 and a caller
    // remapping it to 0..1 would get a washed-out field that never touches
    // either end. This also puts perlin2 and perlin3 on the same scale.
    return lerp(lerp(g00, g10, u), lerp(g01, g11, u), v) * Math.SQRT2;
  }

  /**
   * 3D Perlin noise in roughly `[-1, 1]`. The third axis is usually time —
   * sampling `perlin3(x, y, t)` gives a 2D field that evolves, which is how
   * you get smoke, water, or a flag that keeps moving.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  perlin3(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = smootherstep(0, 1, xf);
    const v = smootherstep(0, 1, yf);
    const w = smootherstep(0, 1, zf);

    const g = (/** @type {number} */ dx, /** @type {number} */ dy, /** @type {number} */ dz) =>
      this.#grad3(xi + dx, yi + dy, zi + dz, xf - dx, yf - dy, zf - dz);

    const x00 = lerp(g(0, 0, 0), g(1, 0, 0), u);
    const x10 = lerp(g(0, 1, 0), g(1, 1, 0), u);
    const x01 = lerp(g(0, 0, 1), g(1, 0, 1), u);
    const x11 = lerp(g(0, 1, 1), g(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }

  /**
   * Fractal Brownian motion: several octaves of {@link Noise#perlin2} summed,
   * each at double the frequency and a fraction of the amplitude. One octave
   * is smooth hills; five is a landscape with ridges, boulders and grain.
   *
   * Normalized to roughly `[-1, 1]` regardless of octave count, so raising the
   * detail does not also raise the mountains.
   *
   * @param {number} x
   * @param {number} y
   * @param {{ octaves?: number, lacunarity?: number, gain?: number }} [options]
   * @returns {number}
   */
  fbm2(x, y, options = {}) {
    const { octaves = 4, lacunarity = 2, gain = 0.5 } = options;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let normalization = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.perlin2(x * frequency, y * frequency) * amplitude;
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return normalization === 0 ? 0 : total / normalization;
  }

  /**
   * {@link Noise#fbm2} in three dimensions.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{ octaves?: number, lacunarity?: number, gain?: number }} [options]
   * @returns {number}
   */
  fbm3(x, y, z, options = {}) {
    const { octaves = 4, lacunarity = 2, gain = 0.5 } = options;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let normalization = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.perlin3(x * frequency, y * frequency, z * frequency) * amplitude;
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return normalization === 0 ? 0 : total / normalization;
  }

  /**
   * Ridged multifractal — fbm folded about zero and inverted, which turns the
   * smooth valleys into sharp crests. The standard way to get mountain ridges
   * and canyon walls out of the same machinery. Output is `[0, 1]`.
   *
   * @param {number} x
   * @param {number} y
   * @param {{ octaves?: number, lacunarity?: number, gain?: number }} [options]
   * @returns {number}
   */
  ridged2(x, y, options = {}) {
    const { octaves = 4, lacunarity = 2, gain = 0.5 } = options;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let normalization = 0;
    for (let i = 0; i < octaves; i++) {
      total += (1 - Math.abs(this.perlin2(x * frequency, y * frequency))) * amplitude;
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return normalization === 0 ? 0 : total / normalization;
  }

  /**
   * Worley (cellular) noise: the distance to the nearest of a set of feature
   * points, one jittered per grid cell. Cracked earth, scales, stone tiling,
   * caustics — anything made of cells rather than waves.
   *
   * Returns the distance to the closest point, typically in `[0, ~1.4]` and
   * usually worth clamping or remapping.
   *
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  worley2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let best = Infinity;
    // The 3×3 neighbourhood is required, not an optimization: a feature point
    // jittered to the far corner of a diagonal neighbour can still be the
    // nearest one.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const h = hash3(cx, cy, 0, this.seed);
        const px = cx + (h & 0xffff) / 65536;
        const py = cy + ((h >>> 16) & 0xffff) / 65536;
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  /**
   * Noise that tiles seamlessly over `period` — the same value at `x` and
   * `x + period`. Needed for a looping texture or a wind field that repeats
   * over an infinite plane without a seam.
   *
   * Costs four Perlin samples rather than one, and the cross-fade lowers the
   * contrast a little (two correlated samples averaged), so a tiled field
   * looks slightly flatter than the same field untiled. Scale it back up if
   * that matters.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} [period=1]
   * @returns {number}
   */
  tileable2(x, y, period = 1) {
    const p = Math.max(1e-3, period);
    // Wrapping FIRST is what makes the seam vanish: the blend below is only
    // periodic if both endpoints of each tile evaluate the same expression,
    // and an unwrapped x makes the tile at 0 and the tile at p disagree.
    const xw = mod(x, p);
    const yw = mod(y, p);
    const u = xw / p;
    const v = yw / p;
    const a = this.perlin2(xw, yw);
    const b = this.perlin2(xw - p, yw);
    const c = this.perlin2(xw, yw - p);
    const d = this.perlin2(xw - p, yw - p);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /**
   * Gradient dot product for a 2D lattice corner. Eight evenly spaced
   * gradients — enough directions that the axis-aligned bias of the classic
   * four-gradient version disappears.
   *
   * @param {number} ix
   * @param {number} iy
   * @param {number} dx
   * @param {number} dy
   * @returns {number}
   */
  #grad2(ix, iy, dx, dy) {
    const h = hash3(ix, iy, 0, this.seed) & 7;
    const angle = (h * Math.PI) / 4;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  }

  /**
   * Gradient dot product for a 3D lattice corner, using Perlin's improved
   * 12-gradient set (the edge midpoints of a cube), selected by hash.
   *
   * @param {number} ix
   * @param {number} iy
   * @param {number} iz
   * @param {number} dx
   * @param {number} dy
   * @param {number} dz
   * @returns {number}
   */
  #grad3(ix, iy, iz, dx, dy, dz) {
    const h = hash3(ix, iy, iz, this.seed) & 15;
    const u = h < 8 ? dx : dy;
    const v = h < 4 ? dy : h === 12 || h === 14 ? dx : dz;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }
}

/** The shared field, fixed-seeded so a scene looks the same everywhere. */
const shared = new Noise(0);

/**
 * The default noise field. Callable as 1D/2D/3D Perlin (`noise(x)`,
 * `noise(x, y)`, `noise(x, y, z)`) with the named methods attached.
 *
 *     const sway = math.noise(this.engine.elapsedTime * 0.4) * 0.05;
 *     const height = math.noise.fbm2(x * 0.01, z * 0.01, { octaves: 5 });
 */
export const noise = Object.assign(
  /**
   * @param {number} x
   * @param {number} [y=0]
   * @param {number} [z]
   * @returns {number}
   */
  (x, y = 0, z) => (z === undefined ? shared.perlin2(x, y) : shared.perlin3(x, y, z)),
  {
    /** The field itself. */
    shared,
    /** The `Noise` class, for `new math.noise.Noise("terrain")`. */
    Noise,
    /** An independent field with its own seed. */
    create: (/** @type {number | string} */ seed) => new Noise(seed),
    hash: shared.hash.bind(shared),
    perlin2: shared.perlin2.bind(shared),
    perlin3: shared.perlin3.bind(shared),
    fbm2: shared.fbm2.bind(shared),
    fbm3: shared.fbm3.bind(shared),
    ridged2: shared.ridged2.bind(shared),
    worley2: shared.worley2.bind(shared),
    tileable2: shared.tileable2.bind(shared),
  },
);
