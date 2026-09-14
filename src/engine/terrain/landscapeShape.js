import { createSimplex2 } from './terrainNoise.js';

/**
 * Adapts a landscape (`landscapeGenerator.js`) to the terrain-shape contract
 * the World's field composition (`landscapeFields.js#createValleyFields`) and
 * siting were written against:
 *
 *   evaluate(x, z, out) -> out.height, heightX, heightZ, outcrop, outcropX,
 *                          outcropZ, upland, n0(x/z), n2(x/z)
 *                          (+ cliff, tower, channel, flow)
 *
 * Gradients are central differences of the landscape itself: it is a pure,
 * C1 function of (x, z) in float64, so a 1e-4 m step IS the derivative. The
 * World's bank maths differentiates through `outcrop` too, so it gets the same
 * treatment. `n0`/`n2` are the two mask noises the bank and moisture maths
 * expect (~40 m and ~7 m), drawn from their own simplex fields.
 *
 * ⛔ 09-14: the first version sampled the landscape NINE times per evaluate
 * (centre + 4 for the height gradient + 4 more for the outcrop gradient at the
 * same points). Road routing calls this thousands of times per route and froze
 * the World build for 1.8 s at a stretch. The outcrop now reuses the four
 * neighbour samples: five samples, bit-identical results.
 */

const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const F0X = .026, F0Z = .023, F2X = .143, F2Z = .151;

// ⛔ A 0.25 m difference smeared the landscape's metre-scale detail and missed
// independent finite differences by more than roads and tests tolerate.
export function createLandscapeShape(landscape, { step = 1e-4 } = {}) {
  const seed = landscape.options.seed >>> 0;
  const noise0 = createSimplex2((seed ^ 0x1b873593) >>> 0), noise2 = createSimplex2((seed ^ 0xcc9e2d51) >>> 0);
  const relief = landscape.relief ?? 20;
  const point = {}, work = new Float64Array(3);

  /** Rock exposure from a landscape sample at (x, z): cliffs and towers are rock
   * by construction; knolls on local highs break through where the broad noise
   * is high, as the old landform's outcrops did. Without the knolls gentle
   * styles had no rock at all and the golden accent trees (which seek rocky
   * shelves) vanished. "Local high" is relative elevation over the landscape's
   * own relief, so it means the same in a 128 m plot and a 2 km range. */
  const uplandOf = (relative) => smoothstep(-.01, .06, (relative ?? 0) / relief);
  const outcropOf = (x, z, cliff, tower, relative) =>
    clamp(cliff + tower * .6 + smoothstep(.08, .6, noise0(x * F0X, z * F0Z)) * uplandOf(relative) * .9);
  /** One landscape sample reduced to the two numbers the gradients need. */
  const probe = (x, z) => {
    const s = landscape.sample(x, z, point);
    return [s.height, outcropOf(x, z, s.cliff, s.tower, s.relative)];
  };

  function evaluate(x, z, out = {}) {
    const [hx1, ox1] = probe(x + step, z), [hx0, ox0] = probe(x - step, z);
    const [hz1, oz1] = probe(x, z + step), [hz0, oz0] = probe(x, z - step);
    const s = landscape.sample(x, z, point);
    out.height = s.height;
    out.heightX = (hx1 - hx0) / (2 * step); out.heightZ = (hz1 - hz0) / (2 * step);
    const upland = uplandOf(s.relative);
    out.upland = upland;
    noise0.d(x * F0X, z * F0Z, work); out.n0 = work[0]; out.n0x = work[1] * F0X; out.n0z = work[2] * F0Z;
    out.outcrop = clamp(s.cliff + s.tower * .6 + smoothstep(.08, .6, work[0]) * upland * .9);
    out.outcropX = (ox1 - ox0) / (2 * step); out.outcropZ = (oz1 - oz0) / (2 * step);
    out.cliff = s.cliff; out.tower = s.tower; out.channel = s.channel; out.flow = s.flow;
    noise2.d(x * F2X, z * F2Z, work); out.n2 = work[0]; out.n2x = work[1] * F2X; out.n2z = work[2] * F2Z;
    return out;
  }
  return { evaluate, sample: (x, z) => evaluate(x, z, {}), landscape, extent: landscape.extent, macroShape: landscape.options.style, baseHeight: 0 };
}
