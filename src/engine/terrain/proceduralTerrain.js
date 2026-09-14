import { LANDSCAPE_CONTROLS, getLandscape } from './landscapeGenerator.js';
import { createLandscapeShape } from './landscapeShape.js';

/**
 * Procedural terrain, owned by the Terrain component; World only uses it
 * (owner rule 09-13). Since 09-14 the landform is the style-driven landscape
 * in `landscapeGenerator.js` — the 12 analytic landform controls and the 12
 * World "Landforms" ridge/cliff controls are gone (owner: "too many confusing
 * settings and the result is always awful"). See docs/TERRAIN_PLAN.md.
 *
 * `PROCEDURAL_TERRAIN_PARAMS` is the ONE control table: the Terrain schema's
 * Procedural rows are generated from it (bare prop keys) and World's Terrain
 * settings group derives from it (`worldPath` = `terrain.<key>`).
 */

export const PROCEDURAL_TERRAIN_PARAMS = Object.freeze(LANDSCAPE_CONTROLS.map(control =>
  Object.freeze({ ...control, worldPath: `terrain.${control.key}` })));
export const TERRAIN_STYLES = LANDSCAPE_CONTROLS.find(control => control.key === 'style').choices;

/** Landscape options from flat Terrain props (or a World `terrain` group). */
export function landscapeOptionsFromProps(props = {}, { seed, extent, reserve } = {}) {
  const out = {
    seed: seed ?? props.proceduralSeed ?? 1,
    extent: extent ?? (props.proceduralExtent > 0 ? props.proceduralExtent : props.size ?? 50),
    reserve: reserve ?? props.proceduralReserve ?? 0,
  };
  for (const control of LANDSCAPE_CONTROLS) out[control.key] = props[control.key] ?? control.default;
  return out;
}

/**
 * The landscape a World region is cut from. The region keeps its own authored
 * water (layout lakes and rivers), so the landscape's hydrology is reserved out
 * of it: EVERY World call site must build its landscape through this, or two
 * option keys give two different landscapes.
 */
export function worldLandscapeOptions(terrain = {}, { seed, extent }) {
  return landscapeOptionsFromProps(terrain, { seed, extent: terrain.landscapeExtent ?? extent, reserve: terrain.landscapeReserve ?? extent });
}

/** The shape contract `landscapeFields.js` composes banks/roads/pads onto. */
export function createTerrainShape({ seed = 894, extent = 128, terrain = {} } = {}) {
  // `landscapeExtent` (worldConfig planTerrain): a streamed World cuts its
  // central region from the larger landscape its surroundings stream from.
  return createLandscapeShape(getLandscape(worldLandscapeOptions(terrain, { seed, extent })));
}

export function createProceduralTerrainShape(props = {}, options = {}) {
  const landscape = getLandscape(landscapeOptionsFromProps(props, options));
  return { landscape, shape: createLandscapeShape(landscape) };
}

/** Never due: a synchronous caller drives the generator straight through. */
export const ALWAYS_FILL_NOW = { due: () => false };

/**
 * Fills a `(resolution + 1)^2` Float32Array, row-major like Terrain's own
 * `heightsArray` (row r -> local z = -half + r*step, column c -> local
 * x = -half + c*step), yielding whenever `clock.due()`.
 *
 * `landscape` is a landscape, or a generator factory `(clock) => steps` that
 * resolves one (so a cold macro build is sliced too, and skipped entirely on
 * the overlay fast path). `origin` is this grid's centre inside the landscape
 * — a chunk tile is just a terrain whose origin is not zero.
 *
 * `overlay` is an owner's `{ evaluate(x, z, baseHeight) -> height, samples }`
 * in LOCAL coordinates (see `TerrainComponent#setShapeOverlay`); `samples`
 * sized for this grid is used verbatim and nothing is sampled at all.
 */
export function* fillHeightfield(landscape, { size = 50, resolution = 128, overlay = null, clock = ALWAYS_FILL_NOW, target = null, origin = [0, 0] } = {}) {
  const cols = resolution + 1;
  const out = target ?? new Float32Array(cols * cols);
  const samples = overlay?.samples;
  if (samples && samples.length === out.length) {
    out.set(samples);
    return out;
  }
  const land = typeof landscape === 'function' ? yield* landscape(clock) : landscape;
  const half = size / 2, step = size / resolution, point = {};
  const ox = origin?.[0] ?? 0, oz = origin?.[1] ?? 0;
  for (let r = 0; r < cols; r++) {
    if (clock.due()) yield 'terrain';
    const z = -half + r * step;
    for (let c = 0; c < cols; c++) {
      const x = -half + c * step;
      const height = land.sample(ox + x, oz + z, point).height;
      out[r * cols + c] = overlay?.evaluate ? overlay.evaluate(x, z, height) : height;
    }
  }
  return out;
}
