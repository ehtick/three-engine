/**
 * Style-driven landscape generation (09-14 owner brief: "multilevel, nice
 * relief, hills, cliffs … fantasy and exaggerated like Elden Ring, yet also
 * simple meadows … multiple algorithms depending on style", and "split the
 * world in chunks so we can stream them").
 *
 * Two layers, and the split is what makes streaming possible:
 *
 *  1. MACRO — one coarse grid over the whole extent (≤ 257² samples): the
 *     style's large forms (fBm, ridged multifractal, gradient-damped fBm,
 *     tilted Voronoi plates) through a domain warp, then stream-power erosion
 *     (`terrainErosion.js`). Erosion also yields the DRAINAGE map, which is
 *     blurred into a channel field: canyons and river valleys follow real
 *     dendritic drainage instead of noise "worms". Built once per
 *     (style, seed, extent, controls); cheap enough for a worker.
 *
 *  2. DETAIL — a pure function of (x, z) on top of a bicubic read of the
 *     macro grids: channel carving, TIERS (the multilevel structure: benches
 *     with narrow cliff risers, confined to regional patches so it never reads
 *     as a contour map), towers, fine fBm, downhill gully stripes, and strata
 *     banding on steep faces. Any chunk evaluates it alone and gets exactly
 *     the numbers the whole world would — no seams, no neighbour dependency.
 *
 * The user-facing controls are deliberately few (`LANDSCAPE_CONTROLS`); every
 * style maps 0..1 onto its own designed range, with .5 being the look it was
 * tuned for. A recipe is data, so a new style is a table row, not new code.
 */

import { createSimplex2, createWorley2, hash2 } from './terrainNoise.js';
import { erodeHeightfieldSteps } from './terrainErosion.js';
import { buildHydrologySteps, priorityFlood } from './landscapeHydrology.js';

const TAU = Math.PI * 2;
const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const quintic = t => t * t * t * (t * (t * 6 - 15) + 10);
const quinticD = t => 30 * t * t * (t - 1) * (t - 1);
const softAbs = (v, eps) => Math.sqrt(v * v + eps * eps) - eps;

/**
 * Recipes. Lengths are metres at the style's `designExtent`; a smaller
 * terrain gets a proportionally miniature version (so a 128 m "alpine" plot
 * still has peaks), a larger one keeps real scale and simply has more of them.
 *
 * form layer types: fbm | ridged | billow | damped. `mask` confines a layer
 *   to a low-frequency region (mountains cluster, lowlands stay open).
 * plates: tilted Voronoi shards quantized to levels (shattered highlands).
 * channels: carve along the eroded drainage; `threshold` is the normalized
 *   log drainage area where a channel starts, `blur` its width in macro cells.
 * tiers: benches; `riser` is the cliff's horizontal run in metres, `tilt`
 *   keeps some slope on a bench, `coverage` the share of land that is stepped.
 * towers: clustered Worley pillars with sheer flanks and broken tops.
 * gullies: downhill stripe filter; `strata`: fine banding on steep faces.
 */
export const LANDSCAPE_STYLES = Object.freeze({
  meadow: {
    label: 'Meadow', hint: 'Open rolling grassland with soft banks and a few stones.', designExtent: 512,
    warp: .45, base: 2,
    form: [
      { type: 'fbm', wavelength: 360, amplitude: 20, octaves: 3 },
      { type: 'damped', wavelength: 150, amplitude: 4, octaves: 3 },
    ],
    channels: { threshold: .62, depth: 3.5, blur: 3 },
    tiers: { strength: .2, step: 3.5, riser: 7, tilt: .45, warp: .6, coverage: .35 },
    detail: { wavelength: 40, amplitude: .28, octaves: 3 },
    gullies: { strength: .12, wavelength: 70, octaves: 2 },
    macroErosion: .3,
    palette: { grass: '#6f8a3c', soil: '#8a7a5c', rock: '#8b877e', snow: null, snowline: Infinity },
    rocks: { boulders: 1, slabs: .25, cliffs: 0, columns: 0, spires: 0, arches: 0 },
  },
  hills: {
    label: 'Rolling hills', hint: 'Broad hills and valleys, low outcrops on the steeper flanks.', designExtent: 768,
    warp: .6, base: 4,
    form: [
      { type: 'damped', wavelength: 460, amplitude: 70, octaves: 5 },
    ],
    channels: { threshold: .58, depth: 7, blur: 3 },
    // Soft sheep-track terraces, not cliffs: 6 m risers on the flanks read as
    // trenches in the round-5 receipt (they looked like pits from any angle).
    tiers: { strength: .3, step: 7, riser: 14, tilt: .55, warp: .8, coverage: .35 },
    detail: { wavelength: 36, amplitude: .6, octaves: 3 },
    gullies: { strength: .25, wavelength: 90, octaves: 3 },
    macroErosion: .65,
    palette: { grass: '#66803a', soil: '#7d6d52', rock: '#7f7b73', snow: null, snowline: Infinity },
    rocks: { boulders: 1, slabs: .8, cliffs: .35, columns: 0, spires: 0, arches: .05 },
  },
  highlands: {
    label: 'Highlands', hint: 'Stepped uplands: grassy benches broken by rock cliffs, lakes in the low ground.', designExtent: 1024,
    warp: .7, base: 0,
    form: [
      { type: 'damped', wavelength: 620, amplitude: 95, octaves: 5 },
      { type: 'ridged', wavelength: 520, amplitude: 55, octaves: 4, mask: { wavelength: 1300, lo: 0, hi: .55 } },
    ],
    channels: { threshold: .5, depth: 14, blur: 2 },
    tiers: { strength: .85, step: 22, riser: 4, tilt: .18, warp: 1, coverage: .55 },
    detail: { wavelength: 40, amplitude: 1, octaves: 4 },
    gullies: { strength: .6, wavelength: 110, octaves: 3 },
    strata: { spacing: 2.6, strength: .35 },
    macroErosion: .7,
    palette: { grass: '#5f7a3a', soil: '#6f624c', rock: '#77736c', snow: '#e9edf0', snowline: 150 },
    rocks: { boulders: 1, slabs: .9, cliffs: 1, columns: 0, spires: .1, arches: .12 },
  },
  alpine: {
    label: 'Alpine', hint: 'Ridged, eroded mountain ranges with snowy crests over forested valleys.', designExtent: 2048,
    warp: .4, base: 0,
    form: [
      { type: 'ridged', wavelength: 1100, amplitude: 420, octaves: 7, mask: { wavelength: 3000, lo: -.45, hi: .3 } },
      { type: 'damped', wavelength: 800, amplitude: 60, octaves: 4 },
    ],
    channels: { threshold: .5, depth: 18, blur: 2 },
    tiers: { strength: .15, step: 30, riser: 8, tilt: .45, warp: 1, coverage: .3 },
    // Crest detail lives below the macro cell (8 m at 2 km), so it is added
    // per point: ridged, and growing with elevation so valleys stay smooth.
    detail: { wavelength: 120, amplitude: 2.2, octaves: 5, ridged: .85, elevationGain: 5, elevation: [40, 360] },
    erosionDiffusion: .05, lakeDepth: 18,
    gullies: { strength: .9, wavelength: 150, octaves: 4 },
    strata: { spacing: 4, strength: .2 },
    macroErosion: 1,
    palette: { grass: '#5c7439', soil: '#6a5d4a', rock: '#8a8680', snow: '#f1f4f7', snowline: 230 },
    rocks: { boulders: 1, slabs: .5, cliffs: .7, columns: 0, spires: .05, arches: 0 },
  },
  canyon: {
    label: 'Canyon mesas', hint: 'Flat-topped mesas and stepped canyon walls along a branching gorge network.', designExtent: 1024,
    warp: .5, base: 0,
    form: [
      { type: 'fbm', wavelength: 900, amplitude: 40, octaves: 3 },
      { type: 'damped', wavelength: 380, amplitude: 22, octaves: 3 },
    ],
    channels: { threshold: .36, depth: 70, blur: 3 },
    tiers: { strength: 1, step: 16, riser: 2.4, tilt: .05, warp: .7, coverage: 1 },
    detail: { wavelength: 32, amplitude: .7, octaves: 3 },
    gullies: { strength: .4, wavelength: 70, octaves: 3 },
    strata: { spacing: 1.7, strength: .55 },
    macroErosion: .5,
    palette: { grass: '#8b8a52', soil: '#b08556', rock: '#b3764e', snow: null, snowline: Infinity },
    rocks: { boulders: 1, slabs: .7, cliffs: 1, columns: 0, spires: .6, arches: .35 },
  },
  karst: {
    label: 'Karst towers', hint: 'Clustered sheer limestone towers rising out of a green valley floor.', designExtent: 768,
    warp: .5, base: 0,
    form: [
      { type: 'damped', wavelength: 420, amplitude: 18, octaves: 4 },
    ],
    channels: { threshold: .55, depth: 6, blur: 3 },
    towers: { cell: 44, density: .5, cluster: 260, radius: [9, 24], height: [30, 110], jitter: .7 },
    detail: { wavelength: 30, amplitude: .6, octaves: 3 },
    gullies: { strength: .35, wavelength: 60, octaves: 2 },
    strata: { spacing: 3.2, strength: .3 },
    macroErosion: .45,
    palette: { grass: '#4f7a34', soil: '#6b5b42', rock: '#9a958a', snow: null, snowline: Infinity },
    rocks: { boulders: 1, slabs: .4, cliffs: .6, columns: 0, spires: 1, arches: .2 },
  },
  shattered: {
    label: 'Shattered highlands', hint: 'Exaggerated fantasy relief: tilted rock plates on sheer cliffs, deep gorges and lone spires.', designExtent: 1536,
    warp: .45, base: 0,
    form: [
      { type: 'damped', wavelength: 700, amplitude: 45, octaves: 4 },
    ],
    plates: { cell: 260, levels: 5, step: 42, tilt: .1, border: 3.5 },
    channels: { threshold: .48, depth: 55, blur: 1 },
    towers: { cell: 170, density: .22, cluster: 700, radius: [6, 12], height: [50, 120], jitter: .6 },
    tiers: { strength: .4, step: 20, riser: 3, tilt: .15, warp: 1, coverage: .4 },
    detail: { wavelength: 40, amplitude: 1.2, octaves: 4 },
    gullies: { strength: .55, wavelength: 100, octaves: 3 },
    strata: { spacing: 3, strength: .3 },
    macroErosion: .35,
    palette: { grass: '#6b6f3e', soil: '#5e5446', rock: '#5f6064', snow: null, snowline: Infinity },
    rocks: { boulders: 1, slabs: 1, cliffs: 1, columns: 1, spires: .8, arches: .4 },
  },
});

export const LANDSCAPE_STYLE_IDS = Object.freeze(Object.keys(LANDSCAPE_STYLES));

/** The whole user-facing surface. .5 is each style's designed look. */
export const LANDSCAPE_CONTROLS = Object.freeze([
  { key: 'style', label: 'Style', kind: 'enum', choices: LANDSCAPE_STYLE_IDS, default: 'highlands',
    hint: 'The kind of land. Each style is its own mix of algorithms: rolling fBm, ridged ranges, stepped tiers, towers, plates, drainage canyons and erosion.' },
  { key: 'height', label: 'Height', kind: 'number', min: 0, max: 2, step: .05, default: 1,
    hint: 'Vertical scale of everything the style builds.' },
  { key: 'scale', label: 'Feature size', kind: 'number', min: .4, max: 2.5, step: .05, default: 1,
    hint: 'Horizontal size of hills, plateaus and towers.' },
  { key: 'levels', label: 'Levels', kind: 'number', min: 0, max: 1, step: .05, default: .5,
    hint: 'How strongly the land steps into benches and plateaus separated by cliffs.' },
  { key: 'wildness', label: 'Wildness', kind: 'number', min: 0, max: 1, step: .05, default: .5,
    hint: 'Exaggeration: sharper crests, sheerer and taller cliffs, more towers, deeper gorges.' },
  { key: 'erosion', label: 'Erosion', kind: 'number', min: 0, max: 1, step: .05, default: .5,
    hint: 'Water-carved valleys, canyons and gullies running down every slope.' },
  { key: 'rocks', label: 'Stone', kind: 'number', min: 0, max: 1, step: .05, default: .5,
    hint: 'How much of the land is built from exposed stone: cliffs, spires, arches, slabs and boulders.' },
  { key: 'water', label: 'Water', kind: 'number', min: 0, max: 1, step: .05, default: .5,
    hint: 'Rivers along the drainage and lakes in the basins, carved into the land.' },
]);

export function landscapeDefaults() {
  return Object.fromEntries(LANDSCAPE_CONTROLS.map(control => [control.key, control.default]));
}

export function normalizeLandscapeOptions(options = {}) {
  const out = { seed: (Number(options.seed ?? 1) >>> 0), extent: Math.max(16, Number(options.extent ?? 512)) };
  // A square (m) centred on the origin that keeps its own water (a World's
  // authored region): no lake or river is generated inside it.
  out.reserve = Math.max(0, Number(options.reserve) || 0);
  for (const control of LANDSCAPE_CONTROLS) {
    const value = options[control.key];
    if (control.kind === 'enum') out[control.key] = control.choices.includes(value) ? value : control.default;
    else out[control.key] = Number.isFinite(value) ? clamp(value, control.min, control.max) : control.default;
  }
  return out;
}

/* ----------------------------------------------------------------------- */
/* Grid reads                                                               */
/* ----------------------------------------------------------------------- */

const MACRO_MAX = 256;

/** Catmull-Rom read of a square grid with its gradient. out: [h, dh/dx, dh/dz]. */
function bicubic(grid, cols, cell, origin, x, z, out) {
  let gx = (x - origin) / cell, gz = (z - origin) / cell;
  const max = cols - 1;
  if (gx < 0) gx = 0; else if (gx > max) gx = max;
  if (gz < 0) gz = 0; else if (gz > max) gz = max;
  let ix = Math.floor(gx), iz = Math.floor(gz);
  if (ix > max - 1) ix = max - 1;
  if (iz > max - 1) iz = max - 1;
  const tx = gx - ix, tz = gz - iz;
  const WX0 = ((-tx + 2) * tx - 1) * tx / 2, WX1 = ((3 * tx - 5) * tx * tx + 2) / 2, WX2 = ((-3 * tx + 4) * tx + 1) * tx / 2, WX3 = (tx - 1) * tx * tx / 2;
  const DX0 = (-3 * tx * tx + 4 * tx - 1) / 2, DX1 = (9 * tx * tx - 10 * tx) / 2, DX2 = (-9 * tx * tx + 8 * tx + 1) / 2, DX3 = (3 * tx * tx - 2 * tx) / 2;
  const WZ0 = ((-tz + 2) * tz - 1) * tz / 2, WZ1 = ((3 * tz - 5) * tz * tz + 2) / 2, WZ2 = ((-3 * tz + 4) * tz + 1) * tz / 2, WZ3 = (tz - 1) * tz * tz / 2;
  const DZ0 = (-3 * tz * tz + 4 * tz - 1) / 2, DZ1 = (9 * tz * tz - 10 * tz) / 2, DZ2 = (-9 * tz * tz + 8 * tz + 1) / 2, DZ3 = (3 * tz * tz - 2 * tz) / 2;
  const c0 = Math.max(0, ix - 1), c1 = ix, c2 = ix + 1, c3 = Math.min(max, ix + 2);
  let h = 0, hx = 0, hz = 0;
  for (let j = 0; j < 4; j++) {
    const row = Math.min(max, Math.max(0, iz + j - 1)) * cols;
    const v0 = grid[row + c0], v1 = grid[row + c1], v2 = grid[row + c2], v3 = grid[row + c3];
    const rh = v0 * WX0 + v1 * WX1 + v2 * WX2 + v3 * WX3, rd = v0 * DX0 + v1 * DX1 + v2 * DX2 + v3 * DX3;
    const wz = j === 0 ? WZ0 : j === 1 ? WZ1 : j === 2 ? WZ2 : WZ3, dz = j === 0 ? DZ0 : j === 1 ? DZ1 : j === 2 ? DZ2 : DZ3;
    h += rh * wz; hx += rd * wz; hz += rh * dz;
  }
  out[0] = h; out[1] = hx / cell; out[2] = hz / cell;
  return out;
}

/** Separable box blur, in place, `passes` times (≈ gaussian). */
function blurGrid(grid, cols, radius, passes) {
  if (radius < 1) return grid;
  const tmp = new Float32Array(grid.length), span = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < cols; z++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += grid[z * cols + clamp(k, 0, cols - 1)];
      for (let x = 0; x < cols; x++) {
        tmp[z * cols + x] = sum / span;
        sum += grid[z * cols + Math.min(cols - 1, x + radius + 1)] - grid[z * cols + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, cols - 1) * cols + x];
      for (let z = 0; z < cols; z++) {
        grid[z * cols + x] = sum / span;
        sum += tmp[Math.min(cols - 1, z + radius + 1) * cols + x] - tmp[Math.max(0, z - radius) * cols + x];
      }
    }
  }
  return grid;
}

/**
 * Priority-flood depression fill (Barnes, Lehman & Mulla 2014) with an
 * epsilon grade, in place. A depression deeper than `keepDepth` is a basin the
 * style wants (a tarn, a lake bed): it is faded back toward its original floor
 * rather than filled, so its rim stays continuous.
 */
function fillDepressions(heights, cols, keepDepth, epsilon) {
  const count = cols * cols, filled = priorityFlood(heights, cols, epsilon);
  for (let i = 0; i < count; i++) {
    const depth = filled[i] - heights[i];
    heights[i] = lerp(filled[i], heights[i], keepDepth > 0 ? smoothstep(keepDepth * .5, keepDepth, depth) : 0);
  }
}

/**
 * Resumable construction. Yields on `clock.due()`; returns the landscape:
 * `{ options, style, extent, sample(x, z, out), macro }`.
 */
export function* createLandscapeSteps(input = {}, clock = { due: () => false }) {
  const options = normalizeLandscapeOptions(input);
  // Diagnostic switches (receipts only): skip whole stages to isolate a look.
  const off = new Set(input.disable ?? []);
  const style = LANDSCAPE_STYLES[options.style];
  const { seed, extent } = options;
  const half = extent / 2;
  const fit = clamp(extent / style.designExtent, .2, 1);
  const w = options.wildness, lv = options.levels, er = options.erosion;
  const H = options.height * fit * (.75 + .5 * w);      // amplitude multiplier
  const L = fit * options.scale;                         // wavelength multiplier

  const noiseA = createSimplex2(seed), noiseB = createSimplex2(seed + 1013), noiseC = createSimplex2(seed + 2029);
  const noiseD = createSimplex2(seed + 3041), noiseE = createSimplex2(seed + 4057), noiseF = createSimplex2(seed + 5077);
  const work = new Float64Array(3);

  // ---- warp (metres), shared by macro and detail so they stay registered ----
  const warpWave = 420 * L, warpAmp = off.has('warp') ? 0 : style.warp * 90 * L;
  const warp = (x, z, out) => {
    out.x = x + noiseD(x / warpWave, z / warpWave) * warpAmp;
    out.z = z + noiseD(x / warpWave + 31.7, z / warpWave - 17.3) * warpAmp;
    return out;
  };

  // ---- form layers ----
  const layers = style.form.map((layer, index) => ({
    ...layer, wavelength: layer.wavelength * L, amplitude: layer.amplitude * H,
    sharp: layer.type === 'ridged' ? lerp(.85, 1.3, w) : 1, offset: index * 57.31,
  }));
  function formAt(x, z) {
    let total = 0;
    for (const layer of layers) {
      const f0 = 1 / layer.wavelength, o = layer.offset;
      let value = 0;
      if (layer.type === 'fbm' || layer.type === 'billow') {
        let amp = 1, freq = f0, norm = 0;
        for (let i = 0; i < layer.octaves; i++) {
          let n = noiseA(x * freq + o + i * 13.1, z * freq - o - i * 7.7);
          if (layer.type === 'billow') n = softAbs(n, .04) * 2 - 1;
          value += n * amp; norm += amp; amp *= .5; freq *= 2.03;
        }
        value /= norm;
      } else if (layer.type === 'ridged') {
        // Musgrave ridged multifractal: each octave is weighted by the one
        // before it, so detail piles up on crests and valleys stay smooth.
        let amp = 1, freq = f0, weight = 1, norm = 0;
        for (let i = 0; i < layer.octaves; i++) {
          let s = 1 - softAbs(noiseB(x * freq + o + i * 19.3, z * freq + o - i * 5.1), .02);
          s = Math.pow(Math.max(0, s), 2 * layer.sharp) * weight;
          weight = clamp(s * 1.9);
          value += s * amp; norm += amp; amp *= .48; freq *= 2.01;
        }
        value = value / norm * 1.7;
      } else if (layer.type === 'damped') {
        // Gradient-damped fBm: octaves are suppressed where the sum is already
        // steep, which is what erosion does — detail on crests and flats,
        // smooth long flanks between them.
        // ⛔ IQ's form divides EVERY octave, the first included, by its own
        // accumulated gradient: octave 0 pinched into sharp scarps along its
        // zero crossings — the "trenches" in the hills receipts that survived
        // disabling every other stage. The base octave stays undamped and
        // the damping is softened; later octaves still fade on steep flanks.
        let amp = 1, freq = f0, sx = 0, sz = 0, norm = 0;
        for (let i = 0; i < layer.octaves; i++) {
          noiseC.d(x * freq + o + i * 11.9, z * freq - o + i * 3.3, work);
          value += amp * work[0] / (i === 0 ? 1 : 1 + .35 * (sx * sx + sz * sz));
          sx += work[1] * amp; sz += work[2] * amp;
          norm += amp; amp *= .5; freq *= 2.02;
        }
        value /= norm * .72;
      }
      if (layer.mask) {
        const m = noiseE(x / (layer.mask.wavelength * L) + o, z / (layer.mask.wavelength * L) - o);
        value *= smoothstep(layer.mask.lo, layer.mask.hi, m);
      }
      total += value * layer.amplitude;
    }
    return total;
  }

  // ---- plates: tilted Voronoi shards on quantized levels ----
  const plates = style.plates && !off.has('plates') ? {
    cells: createWorley2(seed + 7001, .8), cell: style.plates.cell * L, levels: style.plates.levels,
    step: style.plates.step * H, tilt: style.plates.tilt * (.6 + .8 * w), border: style.plates.border * Math.sqrt(L),
  } : null;
  const plateWork = {};
  function plateHeight(cx, cz, px, pz, x, z) {
    const level = Math.floor(hash2(cx, cz, seed + 17) * plates.levels) - (plates.levels - 1) / 2;
    const angle = hash2(cx, cz, seed + 23) * TAU, amount = plates.tilt * hash2(cx, cz, seed + 29);
    return level * plates.step + ((x - px * plates.cell) * Math.cos(angle) + (z - pz * plates.cell) * Math.sin(angle)) * amount;
  }
  function platesAt(x, z) {
    const c = plates.cells(x / plates.cell, z / plates.cell, plateWork);
    const h1 = plateHeight(c.cx, c.cz, c.px, c.pz, x, z), h2 = plateHeight(c.cx2, c.cz2, c.px2, c.pz2, x, z);
    // Distance to the shared bisector in metres: the plate edge is a straight
    // fracture line, like the shards in the reference, not a noise contour.
    const ax = c.px2 - c.px, az = c.pz2 - c.pz, len = Math.hypot(ax, az) || 1;
    const e = (((c.px + c.px2) / 2 - x / plates.cell) * ax + ((c.pz + c.pz2) / 2 - z / plates.cell) * az) / len * plates.cell;
    const t = quintic(clamp(e / plates.border));
    // A fracture is a cliff only where the two plates really differ in height.
    c.cliff = (1 - t) * smoothstep(2, 10, Math.abs(h1 - h2));
    return lerp((h1 + h2) / 2, h1, t);
  }

  // ---- build + erode the macro grid ----
  const macroRes = Math.min(MACRO_MAX, Math.max(32, Math.ceil(extent / 2)));
  const macroCols = macroRes + 1, macroCell = extent / macroRes;
  const macro = new Float32Array(macroCols * macroCols);
  // Plates are in the macro grid (so drainage routes around them) AND
  // re-sharpened per point: a 6 m macro cell blurred a 40 m fracture into a
  // ramp (round-5 receipt). `plateGrid` keeps what the macro grid smeared.
  const plateGrid = plates ? new Float32Array(macroCols * macroCols) : null;
  const warped = {};
  for (let r = 0; r < macroCols; r++) {
    if (clock.due()) yield 'landscape:macro';
    const z = -half + r * macroCell;
    for (let c = 0; c < macroCols; c++) {
      const x = -half + c * macroCell;
      warp(x, z, warped);
      let h = formAt(warped.x, warped.z) + style.base * H;
      if (plates) { const p = platesAt(warped.x, warped.z); plateGrid[r * macroCols + c] = p; h += p; }
      macro[r * macroCols + c] = h;
    }
  }
  // Erosion always runs at least lightly: its drainage map is what places
  // canyons and valleys, even when the user wants little visible erosion.
  const erosionStrength = off.has('erosion') ? .01 : clamp(Math.max(.08, style.macroErosion * er * 2), 0, 1);
  const maps = yield* erodeHeightfieldSteps(macro, macroRes, {
    seed: seed ^ 0x6a09e667, strength: erosionStrength, cellSize: macroCell, coarseResolution: macroRes, maps: true,
    ...(style.erosionDiffusion != null ? { diffusion: style.erosionDiffusion } : {}),
  }, clock);
  const flow = maps.flow;
  let flowMax = 1;
  for (let i = 0; i < flow.length; i++) if (flow[i] > flowMax) flowMax = flow[i];
  const flowLog = new Float32Array(flow.length), logScale = 1 / Math.log1p(flowMax);
  for (let i = 0; i < flow.length; i++) flowLog[i] = Math.log1p(flow[i]) * logScale;
  yield 'landscape:drainage';

  // Channel field: 0 off-channel -> 1 on the channel axis, widened by blur.
  let channelField = null;
  if (style.channels && !off.has('channels')) {
    channelField = new Float32Array(flow.length);
    const th = style.channels.threshold + (.5 - er) * .12;
    for (let i = 0; i < flow.length; i++) channelField[i] = smoothstep(th, th + .22, flowLog[i]);
    blurGrid(channelField, macroCols, Math.max(0, Math.round(style.channels.blur * Math.sqrt(fit) * Math.max(1, 4 / macroCell))), 2);
    let peak = 1e-6;
    for (let i = 0; i < channelField.length; i++) if (channelField[i] > peak) peak = channelField[i];
    // ⛔ Normalizing by .55 x peak and clamping saturated a wide core at 1: a
    // flat-floored trench with steep walls (the hills receipt's dark pits).
    // Unsaturated, then shaped to a rounded valley that eases into its banks.
    for (let i = 0; i < channelField.length; i++) { const c = Math.min(1, channelField[i] / peak); channelField[i] = 1 - (1 - c) * (1 - c); }
    // Carved into the macro grid itself (not per point), so the depression
    // fill below sees the channels and keeps every one of them draining.
    const depth = style.channels.depth * H * (.6 + .8 * w) * (.5 + er);
    for (let i = 0; i < macro.length; i++) macro[i] -= channelField[i] * depth;
    yield 'landscape:channels';
  }

  // ⛔ Closed pits read as craters: the first receipt showed dark holes
  // wherever drainage ended in a local minimum and the channel carve then
  // deepened it. Priority-flood fill (Barnes 2014) with a tiny epsilon grade
  // makes every cell drain to the edge; a basin deeper than the style's
  // `lakeDepth` is kept, faded in, so highlands still get their tarns.
  if (!off.has('fill')) fillDepressions(macro, macroCols, (style.lakeDepth ?? 2) * H, macroCell * 2e-3);
  yield 'landscape:fill';

  // Rivers and lakes (T6): dug/kept basins and the drainage network, applied per
  // point at the end of `sample`. A reserved World region keeps its own water.
  const hydrology = options.water > 0 && !off.has('water') ? yield* buildHydrologySteps(macro, {
    cols: macroCols, cell: macroCell, half, seed: seed ^ 0x3c6ef372, amount: options.water,
    lakes: style.water?.lakes ?? 1, rivers: style.water?.rivers ?? 1, height: H, reserve: Math.min(options.reserve, extent),
  }, clock) : null;

  // ⛔ Contour tiers in a closed low cut a flat floor ringed by a cliff: the
  // round-3 receipt showed those pits all over the hills and valley floors.
  // Tiers are gated by RELATIVE elevation instead — strong on local highs
  // (benches, mesas, caprock), fading out in lows, so valleys keep a natural
  // floor. The reference is the macro grid blurred over ~120 m.
  const macroBlur = Float32Array.from(macro);
  blurGrid(macroBlur, macroCols, Math.max(2, Math.round(60 * L / macroCell)), 3);
  const blurWork = new Float64Array(3);
  const relativeAt = (x, z, h) => h - bicubic(macroBlur, macroCols, macroCell, -half, x, z, blurWork)[0];
  yield 'landscape:relative';
  const tiers = style.tiers && !off.has('tiers') ? {
    strength: clamp(style.tiers.strength * lv * 2), step: style.tiers.step * H * (.8 + .4 * w) / (.75 + .5 * w),
    riser: style.tiers.riser * Math.sqrt(fit) * lerp(1.6, .5, w), tilt: style.tiers.tilt, warp: style.tiers.warp,
    coverage: clamp(style.tiers.coverage * (.5 + lv)), regionWave: 520 * L,
  } : null;
  const towers = style.towers && !off.has('towers') ? {
    cells: createWorley2(seed + 9001, style.towers.jitter), cell: style.towers.cell * L,
    density: clamp(style.towers.density * (.35 + 1.3 * w) * (.4 + 1.2 * options.rocks)), cluster: style.towers.cluster * L,
    radius: style.towers.radius.map(r => r * L), height: style.towers.height.map(h => h * H * (.6 + .8 * w)),
  } : null;
  const detail = { wavelength: style.detail.wavelength * Math.sqrt(L), amplitude: style.detail.amplitude * Math.sqrt(H) * (.7 + .6 * w), octaves: style.detail.octaves };
  const gullies = style.gullies && !off.has('gullies') ? {
    strength: style.gullies.strength * er * 2, wavelength: style.gullies.wavelength * Math.sqrt(L), octaves: style.gullies.octaves,
    amplitude: style.gullies.wavelength * Math.sqrt(L) * .03 * Math.sqrt(H),
  } : null;
  const strata = style.strata && !off.has('strata') ? { spacing: style.strata.spacing * Math.sqrt(H), strength: style.strata.strength * (.5 + w) } : null;

  const grad = new Float64Array(3), chan = new Float64Array(3), plateRead = new Float64Array(3), warpOut = {}, towerWork = {};

  /** Downhill gully stripes (after Rune Skovbo Johansen's erosion filter):
   * cosine stripes in a jittered 4x4 cell kernel, phased across the slope so
   * each stripe runs down it; every octave's own gradient steers the next,
   * which is what makes the gullies branch. Returns a height delta. */
  function gullyAt(x, z, gx, gz) {
    const fade = smoothstep(.06, .5, Math.hypot(gx, gz));
    if (fade <= 0) return 0;
    let total = 0, amp = gullies.amplitude, freq = 1 / gullies.wavelength;
    for (let o = 0; o < gullies.octaves; o++) {
      const len = Math.hypot(gx, gz) || 1;
      const dx = -gz / len, dz = gx / len;
      const px = x * freq, pz = z * freq, ix = Math.floor(px), iz = Math.floor(pz), fx = px - ix, fz = pz - iz;
      let value = 0, vx = 0, vz = 0, weights = 0;
      for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) {
        const cx = ix + i, cz = iz + j;
        const ox = i - fx + (hash2(cx, cz, seed + o * 31) - .5) * .9;
        const oz = j - fz + (hash2(cx, cz, seed + o * 31 + 17) - .5) * .9;
        // ⛔ A truncated Gaussian here stepped the height by ~4 mm whenever the
        // 4x4 window shifted a cell (derivative error ~4, a visible seam grid).
        // Compact support: every point outside the window is >= 1.55 cells
        // away, and this weight is exactly zero (with zero slope) past 1.5.
        const d2 = ox * ox + oz * oz, falloff = d2 < 2.25 ? 1 - d2 / 2.25 : 0;
        const wgt = falloff * falloff;
        if (wgt === 0) continue;
        const phase = (ox * dx + oz * dz) * TAU;
        value += Math.cos(phase) * wgt;
        const s = Math.sin(phase) * wgt * TAU;
        vx += s * dx; vz += s * dz;
        weights += wgt;
      }
      value /= weights; vx /= weights; vz /= weights;
      // ⛔ Each octave steers the next by its own gradient; where that steered
      // gradient passes near zero the stripe direction swings 180 degrees in
      // millimetres (alpine receipt: a local slope of 46). Fade every octave by
      // the slope it is actually steering along, not only the input slope.
      const steer = smoothstep(.04, .3, len);
      value = .3 + (value - .3) * steer; vx *= steer; vz *= steer;
      total += (value - .3) * amp;
      gx += vx * amp * freq; gz += vz * amp * freq;
      amp *= .45; freq *= 2.1;
    }
    return total * fade * gullies.strength;
  }

  /** One tower lattice cell: active, centre, radius and height. Sited in
   * WORLD space (not warped) so a rock spire can wrap it exactly. */
  const featureWork = {};
  function towerFeature(cx, cz, out = featureWork) {
    const cell = towers.cell;
    out.x = (cx + .5 + (hash2(cx, cz, seed + 9001) - .5) * .7) * cell;
    out.z = (cz + .5 + (hash2(cx, cz, seed + 16920) - .5) * .7) * cell;
    const cluster = smoothstep(-.25, .45, noiseF(out.x / towers.cluster, out.z / towers.cluster));
    out.active = hash2(cx, cz, seed + 104729) <= towers.density * cluster * 1.6;
    out.radius = lerp(towers.radius[0], towers.radius[1], hash2(cx, cz, seed + 331)) * (.7 + .5 * cluster);
    out.height = lerp(towers.height[0], towers.height[1], Math.pow(hash2(cx, cz, seed + 557), 1.3)) * (.6 + .5 * cluster);
    return out;
  }

  /** Towers: every active feature in the 3x3 neighbourhood contributes and
   * the tallest wins, so neighbouring towers fuse into massifs. */
  function towerAt(x, z, out) {
    const cell = towers.cell, ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    let lift = 0, flank = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cz = iz + j;
      const f = towerFeature(cx, cz);
      if (!f.active) continue;
      const r = f.radius, d = Math.hypot(x - f.x, z - f.z);
      if (d > r * 1.4) continue;
      // ⛔ The heightfield tower is the CORE a rock spire wraps, so it must
      // stay inside the spire (1.02 r, tapering by up to half toward the
      // crown): a frustum from .9 r at the foot to .45 r at .92 of the height.
      // A full-width crown poked out of the spire as smooth grey cauliflower
      // (round-7 receipt).
      const rough = noiseA(x / (r * .7) + cx * 3.1, z / (r * .7) + cz * 1.7) * r * .08;
      const t = clamp((r * .9 - d - rough) / (r * .45));
      if (t <= 0) continue;
      const value = f.height * .92 * quintic(t);
      if (value > lift) { lift = value; flank = t; }
    }
    out.lift = lift; out.flank = flank;
    return out;
  }

  /** Active tower features whose centre lies in [x0,x1) x [z0,z1). `peak` is
   * the finished surface height at the centre. */
  function towersIn(x0, z0, x1, z1) {
    if (!towers || towers.density <= 0) return [];
    const list = [], cell = towers.cell, probe = {};
    for (let cz = Math.floor(z0 / cell) - 1; cz <= Math.floor(z1 / cell) + 1; cz++) {
      for (let cx = Math.floor(x0 / cell) - 1; cx <= Math.floor(x1 / cell) + 1; cx++) {
        const f = towerFeature(cx, cz, {});
        if (!f.active || f.x < x0 || f.x >= x1 || f.z < z0 || f.z >= z1) continue;
        list.push({ x: f.x, z: f.z, radius: f.radius, height: f.height, peak: sample(f.x, f.z, probe).height });
      }
    }
    return list;
  }

  /**
   * The landscape at (x, z). `out` receives:
   *   height, gx, gz (approximate gradient from the analytic parts),
   *   cliff 0..1 (tier riser or tower flank), tower 0..1, channel 0..1,
   *   tier (integer level), flow 0..1 (log drainage area).
   */
  function sample(x, z, out = {}) {
    warp(x, z, warpOut);
    const qx = warpOut.x, qz = warpOut.z;
    bicubic(macro, macroCols, macroCell, -half, x, z, grad);
    let h = grad[0], gx = grad[1], gz = grad[2];
    let plateCliff = 0;
    if (plates) {
      const sharp = platesAt(qx, qz);
      plateCliff = plateWork.cliff;
      const smeared = bicubic(plateGrid, macroCols, macroCell, -half, x, z, plateRead);
      h += sharp - smeared[0];
    }

    // Channels are already carved into the macro grid; this is the mask only.
    let channel = 0;
    if (channelField) channel = clamp(bicubic(channelField, macroCols, macroCell, -half, x, z, chan)[0]);

    // Mid-scale relief the tiers see, so cliff lines wander organically.
    if (!off.has('detail')) {
      const f = 1 / (detail.wavelength * 3.5);
      noiseC.d(qx * f - 3.7, qz * f + 9.1, work);
      const a = detail.amplitude * 3;
      h += work[0] * a; gx += work[1] * f * a; gz += work[2] * f * a;
    }

    let cliff = 0, tier = 0;
    if (tiers && tiers.strength > 0) {
      const region = smoothstep(.5 - tiers.coverage, .5 - tiers.coverage + .35, noiseF(qx / tiers.regionWave + 7.3, qz / tiers.regionWave - 2.1) * .5 + .5);
      const slope = Math.hypot(gx, gz);
      // Benches belong on moderate ground and on local highs; a mountain face
      // keeps its own form and a low keeps a natural floor (see relativeAt).
      const lift = smoothstep(-tiers.step * .15, tiers.step * .6, relativeAt(x, z, h));
      const amount = tiers.strength * region * lift * (1 - smoothstep(1.2, 2.4, slope));
      if (amount > 0) {
        const S = tiers.step;
        const shift = noiseE(qx / (160 * L), qz / (160 * L)) * S * tiers.warp;
        const u = (h + shift) / S, k = Math.floor(u), f = u - k;
        // ⛔ A hard clamp here kinked the height's derivative wherever it engaged
        // (roads and siting read that slope); a smooth clamp keeps the land C1.
        const raw = tiers.riser * slope / S, low = (raw + .04 + Math.sqrt((raw - .04) ** 2 + 4e-4)) / 2;
        const width = (low + .92 - Math.sqrt((low - .92) ** 2 + 4e-4)) / 2;
        const c = .5 + (hash2(k, 11, seed) - .5) * (.92 - width) * .9;
        const t = clamp((f - (c - width / 2)) / width);
        const g = quintic(t), gd = quinticD(t) / width;
        const stepped = S * (k + tiers.tilt * f + (1 - tiers.tilt) * g) - shift;
        const dStep = tiers.tilt + (1 - tiers.tilt) * gd;
        h = lerp(h, stepped, amount);
        const scale = lerp(1, dStep, amount);
        gx *= scale; gz *= scale;
        cliff = amount * (1 - tiers.tilt) * (t > 0 && t < 1 ? quinticD(t) / 1.875 : 0) * smoothstep(.02, .15, slope);
        tier = k;
      }
    }

    cliff = Math.max(cliff, plateCliff);
    let tower = 0;
    if (towers && towers.density > 0) {
      towerAt(x, z, towerWork);
      if (towerWork.lift > 0) {
        h += towerWork.lift; tower = towerWork.flank;
        cliff = Math.max(cliff, 1 - Math.abs(towerWork.flank - .5) * 2);
      }
    }

    // Gullies follow the land's FORM, not its grain: ridged detail flips its
    // gradient across every fine crest within millimetres, and steering the
    // stripes by it swung them 180 degrees there (alpine: a slope of 46).
    const formGx = gx, formGz = gz;
    if (!off.has('detail')) {
      const sd = style.detail, ridged = sd.ridged ?? 0;
      const gain = sd.elevationGain ? 1 + sd.elevationGain * smoothstep(sd.elevation[0] * H, sd.elevation[1] * H, h) : 1;
      let amp = detail.amplitude * gain, f = 1 / detail.wavelength;
      for (let i = 0; i < detail.octaves; i++) {
        noiseA.d(qx * f + 5.5 * i, qz * f - 9.2 * i, work);
        let v = work[0], dv = 1;
        if (ridged > 0) {
          // 1 - 2|n|: sharp crest lines where the noise crosses zero.
          const a = Math.sqrt(v * v + .0009);
          v = lerp(v, 1 - 2 * a, ridged); dv = lerp(1, -2 * work[0] / a, ridged);
        }
        h += v * amp; gx += work[1] * dv * f * amp; gz += work[2] * dv * f * amp;
        amp *= .48; f *= 2.07;
      }
    }
    if (gullies && gullies.strength > 0) h += gullyAt(x, z, formGx, formGz) * (1 - tower);

    if (strata && strata.strength > 0) {
      const steep = smoothstep(.8, 1.8, Math.hypot(gx, gz));
      if (steep > 0) {
        const offset = noiseE(qx * .015, qz * .015) * .6;
        const u = h / strata.spacing + offset, k = Math.floor(u), f = u - k;
        h = lerp(h, (k + f - Math.sin(TAU * f) / TAU - offset) * strata.spacing, strata.strength * steep);
      }
    }

    if (hydrology) {
      const before = h;
      h = hydrology.apply(x, z, h, out);
      if (out.wet > 0) {
        // Carved water ground is its own gentle bed, not the cliff it cut through.
        const keep = 1 - out.wet;
        gx *= keep; gz *= keep; cliff *= keep; tower *= keep;
        if (h !== before) tier = 0;
      }
    } else {
      out.water = NaN; out.waterDepth = 0; out.shore = Infinity; out.flowX = 0; out.flowZ = 0; out.wet = 0;
    }
    out.height = h; out.gx = gx; out.gz = gz;
    out.cliff = clamp(cliff); out.tower = tower; out.channel = channel; out.tier = tier;
    out.flow = bilinearFlow(x, z);
    out.relative = relativeAt(x, z, h);
    return out;
  }
  function bilinearFlow(x, z) {
    let gx = (x + half) / macroCell, gz = (z + half) / macroCell;
    const max = macroCols - 1;
    gx = clamp(gx, 0, max); gz = clamp(gz, 0, max);
    const ix = Math.min(max - 1, Math.floor(gx)), iz = Math.min(max - 1, Math.floor(gz)), tx = gx - ix, tz = gz - iz;
    const g = flowLog;
    return lerp(lerp(g[iz * macroCols + ix], g[iz * macroCols + ix + 1], tx), lerp(g[(iz + 1) * macroCols + ix], g[(iz + 1) * macroCols + ix + 1], tx), tz);
  }

  return Object.freeze({
    options, style, extent, sample, towers: towersIn, hydrology,
    palette: style.palette, rockMix: style.rocks,
    // Macro relief range (m): lets consumers normalize relative elevation, so
    // "a local high" means the same thing in a 128 m plot and a 2 km range.
    relief: (() => { let lo = Infinity, hi = -Infinity; for (const v of macro) { if (v < lo) lo = v; if (v > hi) hi = v; } return Math.max(1, hi - lo); })(),
    macro: Object.freeze({ heights: macro, cols: macroCols, cell: macroCell, flow: flowLog, channels: channelField }),
  });
}

export function createLandscape(options = {}) {
  const steps = createLandscapeSteps(options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Landscapes by option key, most recent last. The World builds its fields
 * several times per generation (siting, grading, refit) and a Terrain tile
 * re-fills on every edit; the macro build must happen once. */
const LANDSCAPE_CACHE = new Map();
const LANDSCAPE_CACHE_SIZE = 4;

export function* getLandscapeSteps(options = {}, clock = { due: () => false }) {
  const key = JSON.stringify([normalizeLandscapeOptions(options), options.disable ?? []]);
  const hit = LANDSCAPE_CACHE.get(key);
  if (hit) { LANDSCAPE_CACHE.delete(key); LANDSCAPE_CACHE.set(key, hit); return hit; }
  const landscape = yield* createLandscapeSteps(options, clock);
  LANDSCAPE_CACHE.set(key, landscape);
  while (LANDSCAPE_CACHE.size > LANDSCAPE_CACHE_SIZE) LANDSCAPE_CACHE.delete(LANDSCAPE_CACHE.keys().next().value);
  return landscape;
}

export function getLandscape(options = {}) {
  const steps = getLandscapeSteps(options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Mask channels written by `fillLandscapeGrid` when `masks` is requested. */
export const LANDSCAPE_MASKS = Object.freeze(['cliff', 'tower', 'channel', 'flow']);

/**
 * Fills a `(resolution + 1)^2` row-major grid for the square
 * [x0, x0 + size] x [z0, z0 + size] (row r -> z0 + r*step). This is the chunk
 * entry point: two adjacent chunks share their border row bit-for-bit because
 * both evaluate the same pure `sample` at the same coordinates.
 */
export function* fillLandscapeGrid(landscape, { x0, z0, size, resolution, target = null, masks = null, clock = { due: () => false } }) {
  const cols = resolution + 1, step = size / resolution;
  const heights = target ?? new Float32Array(cols * cols);
  const point = {};
  for (let r = 0; r < cols; r++) {
    if (clock.due()) yield 'landscape:fill';
    const z = z0 + r * step;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * step;
      landscape.sample(x, z, point);
      const i = r * cols + c;
      heights[i] = point.height;
      if (masks) { const m = i * 4; masks[m] = point.cliff; masks[m + 1] = point.tower; masks[m + 2] = point.channel; masks[m + 3] = point.flow; }
    }
  }
  return heights;
}
