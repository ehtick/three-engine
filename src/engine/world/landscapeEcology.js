import { createSimplex2 } from '../terrain/terrainNoise.js';
import { ecologyPopulations, sampleValleyPlanting } from './valleyEcology.js';

/**
 * Plants for a streamed chunk (09-14, T6): the valley's populations
 * (`ecologyPopulations`) sited on the raw landscape and its hydrology instead of
 * the authored valley's fields.
 *
 * Chunk contract: candidates sit on WORLD lattices (one per kind), jittered
 * inside their own cell, and a chunk keeps exactly the candidates whose final
 * position lies in its half-open rectangle — so any set of chunks places the
 * plants of their union, once, whatever order they load in.
 */

const clamp = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
function random(seed, x, z, channel) {
  let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(channel, 1442695041);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
/** JS heap + instance buffer per streamed plant (FoliageComponent#memoryBytes' estimate). */
export const STREAMED_PLANT_BYTES = 208 + 64;

/** The population ids a streamed chunk can populate (the World keeps their entities alive). */
export function streamedPopulationIds({ drawnGrass = true } = {}) {
  const ids = ['oak-wide', 'oak-elder', 'birch-tall', 'pine-tall', 'hazel-study', 'young-growth', 'accent', 'bank-rushes', 'meadow-flowers'];
  return drawnGrass ? ids : [...ids, 'meadow-short', 'meadow-long', 'woodland-floor'];
}

/**
 * @param landscape  a landscapeGenerator landscape (with or without hydrology)
 * @param options    seed, forestDensity 0..2, groundDensity 0..2, vegetation
 *                   { treeScale, grassHeight, patchiness, accentTrees },
 *                   drawnGrass, groundRadius (m: ground cover only this close)
 */
export function createLandscapeEcology(landscape, { seed = 894, forestDensity = 1, groundDensity = 1, vegetation = {}, drawnGrass = true, groundRadius = 220 } = {}) {
  const { treeScale = 1, patchiness = .65, accentTrees = 1, grassHeight = 1 } = vegetation;
  const { trees, shrubs, accents, grasses } = ecologyPopulations({ grassHeight });
  const grove = createSimplex2((seed ^ 0x7f4a7c15) >>> 0), wetNoise = createSimplex2((seed ^ 0x1234567) >>> 0);
  const hydrology = landscape.hydrology;
  const point = {}, field = {};

  function fieldAt(x, z) {
    const s = landscape.sample(x, z, point);
    const slope = Math.hypot(s.gx, s.gz);
    const shore = Number.isFinite(s.shore) ? s.shore : 64;
    const wet = Number.isFinite(s.water) && s.waterDepth > .02;
    field.height = s.height;
    field.slope = slope;
    field.shore = wet ? Math.min(shore, -.5) : shore;
    field.rock = clamp(s.cliff * .9 + s.tower * .6 + smooth(.45, 1.1, slope) * .7);
    field.moisture = clamp(.22 + .65 * Math.exp(-Math.max(0, shore) / 7.5) + wetNoise(x * .026, z * .023) * .12);
    const groves = smooth(-.15, .45, grove(x / 170, z / 170)) * (.55 + .45 * smooth(-.4, .6, grove(x / 55 + 9.1, z / 55 - 3.3)));
    field.forest = groves * smooth(.8, 4.2, shore) * (1 - smooth(.58, 1.35, slope)) * (1 - field.rock * .8);
    field.waterLevel = Number.isFinite(s.water) ? s.water : -Infinity;
    // A settled landscape's lanes and plots (landscapeSettlements.js).
    field.path = s.path ?? 0; field.pad = s.pad ?? 0;
    // The settlements' own test, so a plant and a plot can never disagree about a metre.
    field.blocked = landscape.settlements ? landscape.settlements.blocked(x, z) : false;
    return field;
  }

  const KINDS = [
    { kind: 'trees', spacing: 5.2, channel: 10, pick(f, chance, variant) {
      const density = clamp(f.forest * forestDensity * .93) * clamp((f.shore - 1.8) / 3);
      if (chance > density) return null;
      return f.moisture > .65 && variant > .6 ? trees[2] : variant < .4 ? trees[0] : variant < .74 ? trees[1] : variant < .87 ? trees[2] : trees[3];
    } },
    { kind: 'shrubs', spacing: 2.35, channel: 20, pick(f, chance, variant, patch) {
      const habitat = clamp(f.forest * .48 + f.moisture * .52 - .1) * forestDensity;
      if (chance > habitat * .62 * patch.shrubs || f.shore < .4) return null;
      return shrubs[variant < .76 + (patch.stand - .5) * patchiness * .38 ? 0 : 1];
    } },
    { kind: 'accent', spacing: 5.2, channel: 40, pick(f, chance, variant, patch) {
      const rocky = f.rock >= .25 && f.rock < .8;
      const shelf = f.rock >= .12 && f.rock < .8 && f.height - f.waterLevel > 5.5;
      if (!(rocky || shelf) || f.shore < 2.2 || f.slope > .9) return null;
      if (chance > .14 * accentTrees * (patch.stand * 1.5 + .25)) return null;
      return accents[0];
    } },
    // Ground cover on a coarser lattice than the valley's (1 m, not .42-.7 m):
    // a streamed chunk walks 16k candidates, not 33-90k.
    { kind: 'ground', spacing: drawnGrass ? 1 : .7, channel: 30, ground: true, pick(f, chance, variant, patch) {
      const shade = 1 - f.forest * .54;
      const probability = clamp((.64 + f.moisture * .25) * shade * groundDensity * (1 - f.rock) * patch.ground);
      if (chance > probability) return null;
      if (f.shore < 1.8 && variant < .72 * (1 - patchiness) + (.06 + patch.rush * .90) * patchiness) return grasses[2];
      if (!drawnGrass && variant < smooth(.30, .88, f.forest) * .88) return grasses[4];
      if (variant > (drawnGrass ? .90 : .975) && f.forest < .45 && patch.stand > .55) return grasses[3];
      if (drawnGrass) return null;
      const tall = .34 * (1 - patchiness) + (.10 + patch.stand * .67) * patchiness;
      return grasses[variant > 1 - tall * (1 - f.forest * .65) ? 1 : 0];
    } },
  ];

  /**
   * Placements for one chunk `want` ({x0, z0, x1, z1, distance}), sliced on
   * `clock`. Returns { groups: Map(populationId -> placements), count, bytes }.
   */
  function* placeSteps(want, clock = { due: () => false }) {
    const groups = new Map();
    let count = 0, visited = 0;
    for (const kind of KINDS) {
      if (kind.ground && want.distance > groundRadius) continue;
      const { spacing, channel } = kind;
      const c0 = Math.floor(want.x0 / spacing), c1 = Math.floor((want.x1 - 1e-9) / spacing);
      const r0 = Math.floor(want.z0 / spacing), r1 = Math.floor((want.z1 - 1e-9) / spacing);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if ((++visited & 255) === 0 && clock.due()) yield 'plants';
          const x = (col + .2 + random(seed, col, row, channel) * .6) * spacing;
          const z = (row + .2 + random(seed, col, row, channel + 1) * .6) * spacing;
          if (x < want.x0 || x >= want.x1 || z < want.z0 || z >= want.z1) continue;
          const chance = random(seed, col, row, channel + 2), variant = random(seed, col, row, channel + 3);
          const patch = sampleValleyPlanting(seed, x, z, patchiness);
          // Cheap rejections before the landscape sample: most ground-cover
          // candidates are flowers that fail their stand test, or rushes far
          // from any water.
          if (kind.ground && drawnGrass && !(patch.stand > .55 && variant > .9) && !(hydrology?.mayBeWet(x, z))) continue;
          const f = fieldAt(x, z);
          if (f.blocked || f.shore < .12 || f.rock > .8 || f.slope > .95) continue;
          const choice = kind.pick(f, chance, variant, patch);
          if (!choice) continue;
          let list = groups.get(choice.id);
          if (!list) { list = []; groups.set(choice.id, list); }
          list.push({ position: [x, f.height, z], rotation: [0, random(seed, col, row, channel + 4) * Math.PI * 2, 0],
            scale: (.78 + random(seed, col, row, channel + 5) * .46) * (kind.kind === 'trees' ? treeScale : 1) });
          count++;
        }
      }
    }
    return { groups, count, bytes: count * STREAMED_PLANT_BYTES };
  }

  /** A fresh copy of the habitat terms at (x, z) (shared by the streamed grass window). */
  const fieldCopy = (x, z) => ({ ...fieldAt(x, z) });
  return { placeSteps, fieldAt: fieldCopy, populations: streamedPopulationIds({ drawnGrass }) };
}
