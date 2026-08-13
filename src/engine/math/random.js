// @ts-check
/**
 * Randomness with a seat belt.
 *
 * `Math.random()` cannot be seeded, which means anything built on it cannot be
 * reproduced: a procedural level that generated wrong is gone the moment you
 * reload, and a bug report saying "the loot roll was impossible" is
 * uninvestigable. Every generator here is an explicit, seeded stream — same
 * seed, same sequence, on every machine and every run.
 *
 * The module-level {@link random} is itself callable, so the common case reads
 * like `Math.random`'s replacement:
 *
 *     math.random()              // 0 <= x < 1
 *     math.random(2, 5)          // 2 <= x < 5
 *     math.random.int(1, 6)      // a d6 — both ends inclusive
 *     math.random.pick(sounds)
 *
 * It is seeded from the clock at startup, so it behaves like `Math.random`
 * until you call `math.random.setSeed(n)`. For anything that must be
 * reproducible in isolation — one level's layout, one enemy's loot — make your
 * own stream with `math.random.create(seed)` instead of reseeding the shared
 * one, so an unrelated system drawing a number cannot shift your sequence.
 */

import { clamp01, TAU } from "./scalar.js";
import { hashString } from "./bits.js";
import { orthonormalBasis } from "./vector.js";

/** Scratch basis for {@link Random#inCone}. Single-threaded, never nested. */
const CONE_T = { x: 0, y: 0, z: 0 };
const CONE_B = { x: 0, y: 0, z: 0 };

/**
 * Mulberry32. 32 bits of state, one multiply-xor-shift round: fast enough for
 * per-particle use, and its output passes the practical randomness tests that
 * the usual `sin(seed) * 43758.5453` hack fails badly.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hashes a string to a 32-bit seed, so a stream can be keyed by a name —
 * `"chest_04"` — instead of a magic number.
 *
 * The same function as {@link import("./bits.js").hashString}, under the name
 * that reads correctly at a seeding call site. One implementation, because two
 * string hashes in one package is two things to keep in sync for no gain.
 */
export const seedFromString = hashString;

/**
 * One reproducible stream of random numbers.
 *
 * Independent streams are the point: give the terrain generator, the loot
 * table and the VFX their own, and adding a single particle effect cannot
 * change the dungeon layout.
 */
export class Random {
  /**
   * @param {number | string} [seed] omit for a clock-derived seed (behaves
   *   like `Math.random`, and is NOT reproducible).
   */
  constructor(seed) {
    /** @type {number} */
    this.seed = 0;
    /** @type {() => number} */
    this._next = () => 0;
    /** @type {number | null} Cached second value from the Box–Muller pair. */
    this._spare = null;
    this.setSeed(seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  }

  /**
   * Restarts the stream. Passing the seed a stream reports in `.seed`
   * reproduces it exactly.
   *
   * @param {number | string} seed
   * @returns {this}
   */
  setSeed(seed) {
    this.seed = typeof seed === "string" ? seedFromString(seed) : seed >>> 0;
    this._next = mulberry32(this.seed);
    this._spare = null;
    return this;
  }

  /**
   * A new independent stream derived from this one's seed and a label. Same
   * parent seed plus same label always gives the same child, so a chunk at
   * `"chunk:3,7"` generates identically whichever order chunks load in.
   *
   * @param {number | string} label
   * @returns {Random}
   */
  derive(label) {
    const salt = typeof label === "string" ? seedFromString(label) : label >>> 0;
    return new Random((Math.imul(this.seed ^ salt, 0x01000193) ^ (salt >>> 3)) >>> 0);
  }

  /**
   * The next value in `[0, 1)`, or in `[min, max)` when a range is given.
   *
   * @param {number} [min]
   * @param {number} [max]
   * @returns {number}
   */
  value(min, max) {
    const r = this._next();
    return min === undefined ? r : r * ((max ?? 0) - min) + min;
  }

  /**
   * A whole number in `[min, max]` — **both ends inclusive**, so `int(1, 6)`
   * is a die and not a five-sided one. (Unity's `Range` excludes the top for
   * ints and includes it for floats; picking one convention and stating it
   * beats matching a library that contradicts itself.)
   *
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return Math.floor(this._next() * (Math.floor(max) - Math.ceil(min) + 1)) + Math.ceil(min);
  }

  /**
   * True with probability `chance`.
   *
   * @param {number} [chance=0.5]
   * @returns {boolean}
   */
  bool(chance = 0.5) {
    return this._next() < chance;
  }

  /**
   * -1 or 1, never 0 — a coin flip you can multiply by.
   *
   * @returns {number}
   */
  sign() {
    return this._next() < 0.5 ? -1 : 1;
  }

  /**
   * A uniformly chosen element, or undefined for an empty list.
   *
   * @template T
   * @param {readonly T[]} items
   * @returns {T | undefined}
   */
  pick(items) {
    return items.length === 0 ? undefined : items[Math.floor(this._next() * items.length)];
  }

  /**
   * A weighted choice. `weights[i]` is the relative likelihood of `items[i]`;
   * they need not sum to 1. Non-positive weights are skipped, so an item can
   * be disabled by zeroing it rather than removing it from both arrays.
   *
   * @template T
   * @param {readonly T[]} items
   * @param {readonly number[]} weights
   * @returns {T | undefined}
   */
  pickWeighted(items, weights) {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0);
    if (total <= 0) return undefined;
    let roll = this._next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i] ?? 0);
      if (roll < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /**
   * Fisher–Yates, **in place**. Returns the same array for chaining.
   *
   * @template T
   * @param {T[]} items
   * @returns {T[]}
   */
  shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      const swap = items[i];
      items[i] = items[j];
      items[j] = swap;
    }
    return items;
  }

  /**
   * {@link shuffle} on a copy, leaving the input untouched.
   *
   * @template T
   * @param {readonly T[]} items
   * @returns {T[]}
   */
  shuffled(items) {
    return this.shuffle([...items]);
  }

  /**
   * `count` distinct elements — a hand of cards, three of eight spawn points.
   * Returns fewer only when the list is shorter than `count`.
   *
   * @template T
   * @param {readonly T[]} items
   * @param {number} count
   * @returns {T[]}
   */
  sample(items, count) {
    return this.shuffled(items).slice(0, Math.max(0, count));
  }

  /**
   * A normally distributed value. Most "random" gameplay numbers want this
   * rather than a uniform one: damage variance, crowd walk speeds and spawn
   * timings all cluster around a typical value in reality, and a uniform roll
   * makes the extremes as common as the middle.
   *
   * Unbounded in principle — clamp if a three-sigma outlier would break
   * something.
   *
   * @param {number} [mean=0]
   * @param {number} [stdDev=1]
   * @returns {number}
   */
  gaussian(mean = 0, stdDev = 1) {
    // Box–Muller produces two independent normals per pair of uniforms; the
    // second is cached rather than thrown away, halving the cost on average.
    if (this._spare !== null) {
      const spare = this._spare;
      this._spare = null;
      return mean + stdDev * spare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this._next() * 2 - 1;
      v = this._next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * factor;
    return mean + stdDev * u * factor;
  }

  /**
   * A point on the unit circle.
   *
   * @param {{ x: number, y: number }} [out]
   * @returns {{ x: number, y: number }}
   */
  onCircle(out = { x: 0, y: 0 }) {
    const angle = this._next() * TAU;
    out.x = Math.cos(angle);
    out.y = Math.sin(angle);
    return out;
  }

  /**
   * A point inside the unit disc, uniformly by **area** — the `sqrt` is what
   * stops the naive version from bunching every point near the centre.
   *
   * @param {{ x: number, y: number }} [out]
   * @returns {{ x: number, y: number }}
   */
  inCircle(out = { x: 0, y: 0 }) {
    const angle = this._next() * TAU;
    const radius = Math.sqrt(this._next());
    out.x = Math.cos(angle) * radius;
    out.y = Math.sin(angle) * radius;
    return out;
  }

  /**
   * A uniformly distributed direction — a point on the unit sphere. Uniform
   * over the *surface*, unlike normalizing three random components, which
   * concentrates directions toward the cube's corners.
   *
   * @param {{ x: number, y: number, z: number }} [out]
   * @returns {{ x: number, y: number, z: number }}
   */
  onSphere(out = { x: 0, y: 0, z: 0 }) {
    const z = this._next() * 2 - 1;
    const angle = this._next() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = Math.cos(angle) * r;
    out.y = Math.sin(angle) * r;
    out.z = z;
    return out;
  }

  /**
   * A point inside the unit sphere, uniformly by volume.
   *
   * @param {{ x: number, y: number, z: number }} [out]
   * @returns {{ x: number, y: number, z: number }}
   */
  inSphere(out = { x: 0, y: 0, z: 0 }) {
    this.onSphere(out);
    const radius = Math.cbrt(this._next());
    out.x *= radius;
    out.y *= radius;
    out.z *= radius;
    return out;
  }

  /**
   * A direction within `halfAngle` of `axis` — a shotgun's spread, a spark
   * burst, a scatter ray. Uniform over the cone's solid angle, so widening the
   * cone does not leave a bright core behind.
   *
   * @param {{ x: number, y: number, z: number }} axis assumed normalized.
   * @param {number} halfAngle in radians.
   * @param {{ x: number, y: number, z: number }} [out]
   * @returns {{ x: number, y: number, z: number }}
   */
  inCone(axis, halfAngle, out = { x: 0, y: 0, z: 0 }) {
    const cosTheta = 1 - this._next() * (1 - Math.cos(halfAngle));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = this._next() * TAU;

    orthonormalBasis(axis, CONE_T, CONE_B);
    const cp = Math.cos(phi) * sinTheta;
    const sp = Math.sin(phi) * sinTheta;
    out.x = axis.x * cosTheta + CONE_T.x * cp + CONE_B.x * sp;
    out.y = axis.y * cosTheta + CONE_T.y * cp + CONE_B.y * sp;
    out.z = axis.z * cosTheta + CONE_T.z * cp + CONE_B.z * sp;
    return out;
  }

  /**
   * A point inside an axis-aligned box.
   *
   * @param {{ x: number, y: number, z: number }} min
   * @param {{ x: number, y: number, z: number }} max
   * @param {{ x: number, y: number, z: number }} [out]
   * @returns {{ x: number, y: number, z: number }}
   */
  inBox(min, max, out = { x: 0, y: 0, z: 0 }) {
    out.x = min.x + this._next() * (max.x - min.x);
    out.y = min.y + this._next() * (max.y - min.y);
    out.z = min.z + this._next() * (max.z - min.z);
    return out;
  }

  /**
   * A uniformly distributed point inside a triangle — scattering props over a
   * mesh, picking a spot on a navmesh polygon.
   *
   * @param {{ x: number, y: number, z: number }} a
   * @param {{ x: number, y: number, z: number }} b
   * @param {{ x: number, y: number, z: number }} c
   * @param {{ x: number, y: number, z: number }} [out]
   * @returns {{ x: number, y: number, z: number }}
   */
  inTriangle(a, b, c, out = { x: 0, y: 0, z: 0 }) {
    // Reflecting the (u, v) pair back inside when it lands outside is what
    // keeps this uniform; scaling it instead crowds one corner.
    let u = this._next();
    let v = this._next();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    out.x = a.x * w + b.x * u + c.x * v;
    out.y = a.y * w + b.y * u + c.y * v;
    out.z = a.z * w + b.z * u + c.z * v;
    return out;
  }

  /**
   * A random hue at the given saturation and lightness, as `[r, g, b]` in
   * 0..1 — distinct debug colours without a palette.
   *
   * @param {number} [saturation=0.7]
   * @param {number} [lightness=0.55]
   * @param {{ r: number, g: number, b: number }} [out]
   * @returns {{ r: number, g: number, b: number }}
   */
  color(saturation = 0.7, lightness = 0.55, out = { r: 0, g: 0, b: 0 }) {
    const h = this._next();
    const s = clamp01(saturation);
    const l = clamp01(lightness);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h * 6;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    /** @type {[number, number, number]} */
    let rgb = [0, 0, 0];
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    out.r = rgb[0] + m;
    out.g = rgb[1] + m;
    out.b = rgb[2] + m;
    return out;
  }
}

/** The process-wide stream backing the callable {@link random}. */
const shared = new Random();

/**
 * The default stream, callable like `Math.random` and carrying every
 * {@link Random} method. See this module's header for when to use it and when
 * to make your own.
 */
export const random = Object.assign(
  /**
   * @param {number} [min]
   * @param {number} [max]
   * @returns {number}
   */
  (min, max) => shared.value(min, max),
  {
    /** The stream itself, if you need to pass it somewhere. */
    shared,
    /** The `Random` class, for `new math.random.Random("terrain")`. */
    Random,
    seedFromString,
    /** A fresh independent stream. Prefer this to reseeding the shared one. */
    create: (/** @type {number | string} */ seed) => new Random(seed),
    /** Reseeds the shared stream — makes the whole game reproducible. */
    setSeed: (/** @type {number | string} */ seed) => shared.setSeed(seed),
    // Bound rather than re-wrapped, so each keeps the method's own signature
    // (optional `out` params included) instead of a hand-copied approximation
    // that drifts the first time one of them grows an argument.
    derive: shared.derive.bind(shared),
    value: shared.value.bind(shared),
    int: shared.int.bind(shared),
    bool: shared.bool.bind(shared),
    sign: shared.sign.bind(shared),
    pick: shared.pick.bind(shared),
    pickWeighted: shared.pickWeighted.bind(shared),
    shuffle: shared.shuffle.bind(shared),
    shuffled: shared.shuffled.bind(shared),
    sample: shared.sample.bind(shared),
    gaussian: shared.gaussian.bind(shared),
    onCircle: shared.onCircle.bind(shared),
    inCircle: shared.inCircle.bind(shared),
    onSphere: shared.onSphere.bind(shared),
    inSphere: shared.inSphere.bind(shared),
    inCone: shared.inCone.bind(shared),
    inBox: shared.inBox.bind(shared),
    inTriangle: shared.inTriangle.bind(shared),
    color: shared.color.bind(shared),
  },
);

// `seed` has to be defined here, not in the object literal above:
// `Object.assign` READS a getter from its source and copies the resulting
// value, so a `get seed()` in that literal would freeze at whatever the clock
// seeded on startup and keep reporting it after every `setSeed`.
Object.defineProperty(random, "seed", {
  get: () => shared.seed,
  enumerable: true,
});
