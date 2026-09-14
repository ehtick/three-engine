/** Deterministic field-driven populations. Candidate identity and position are
 * independent of density: increasing coverage admits more candidates rather
 * than moving existing plants. Returned local-space placements are plain JSON
 * and use Foliage's ordinary persisted placement mode. */
function random(seed, x, z, channel) {
  let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(channel, 1442695041);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
const clamp = value => Math.max(0, Math.min(1, value));
/** Roughly how many of a kind's candidates survive its habitat test. Only used
 * to spread a budget evenly across the world, never to decide a placement. */
const EXPECTED_YIELD = Object.freeze({ trees: .18, shrubs: .30, ground: .55, accent: .08 });
/** Candidate cells one kind may walk, whatever the world's size. Beyond this
 * the grid coarsens: a bigger world costs the same to populate, and is spread
 * evenly rather than filled from one edge until a cap stops it. */
const CANDIDATE_BUDGET = 170000;
/** Placements one kind may keep, scaled by area up to a bounded ceiling. This
 * is a frame-budget decision, not a look decision; density scales it. */
const POPULATION = Object.freeze({ trees: [420, 3200], shrubs: [900, 6000], ground: [75000, 160000], accent: [14, 90] });
const smooth = (a, b, value) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };

function patchNoise(seed, x, z, size, channel) {
  const gx = x / size, gz = z / size, ix = Math.floor(gx), iz = Math.floor(gz);
  const a = smooth(0, 1, gx - ix), b = smooth(0, 1, gz - iz);
  const north = random(seed, ix, iz, channel) * (1 - a) + random(seed, ix + 1, iz, channel) * a;
  const south = random(seed, ix, iz + 1, channel) * (1 - a) + random(seed, ix + 1, iz + 1, channel) * a;
  return north * (1 - b) + south * b;
}

/** Shared metre-scale planting signals. Candidate jitter is a separate stream:
 * changing patch strength never moves a surviving root or advances its seed. */
export function sampleValleyPlanting(seed, x, z, patchiness = .65) {
  const ground = smooth(.25, .75, patchNoise(seed, x, z, 7.5, 101));
  const thicket = smooth(.26, .74, patchNoise(seed, x, z, 11, 113));
  const stand = smooth(.25, .75, patchNoise(seed, x, z, 6.2, 127));
  const rush = smooth(.30, .70, patchNoise(seed, x, z, 4.4, 139));
  return { ground: 1 + patchiness * (ground * 1.9 - .9),
    shrubs: 1 + patchiness * (thicket * 1.94 - .94),
    stand, rush, bare: patchiness * (1 - ground) };
}

const ALWAYS_RUN = { due: () => false };

/**
 * The World's plant populations, without placements: one table for the
 * authored valley's scatter and the streamed chunks' (`landscapeEcology.js`),
 * so a streamed oak is the same population, prototype and LOD as a valley oak.
 */
export function ecologyPopulations({ grassHeight = 1 } = {}) {
  const common = { distribution: 'placements', castShadow: true, receiveShadow: true, wind: true, windStrength: .14, interaction: false };
  const population = (id, props) => ({ id, props });
  const trees = [
    population('oak-wide', { ...common, species: 'oak', seed: 21, height: 11, width: 8.8, leafDensity: 1.5, leafSize: 1.28, branchDensity: 1.25, crownBase: -.08, crownSpread: .96, leafColor: '#526632', barkColor: '#625440' }),
    population('oak-elder', { ...common, species: 'oak', seed: 76, height: 13, width: 10, leafDensity: 1.55, leafSize: 1.24, branchDensity: 1.25, crownBase: -.07, crownSpread: .96, leafColor: '#4b6030', barkColor: '#5b503c' }),
    population('birch-tall', { ...common, species: 'birch', seed: 53, height: 12, width: 6, leafDensity: 1.5, leafSize: 1.2, branchDensity: 1.2, crownBase: -.05, crownSpread: 1, leafColor: '#70874a', barkColor: '#c0bfb0' }),
    population('pine-tall', { ...common, species: 'pine', seed: 38, height: 14, width: 6.3, leafDensity: 1.35, leafSize: 1.15, branchDensity: 1.1, crownBase: -.05, crownSpread: 1, leafColor: '#3b5339', barkColor: '#6c5444' }),
  ];
  // ⚡ 09-14 PERF (owner-approved, Complex scene at 37 fps GPU-bound): 45/135
  // kept full and mid geometry so far out that foliage was ~14 M of the ~18 M
  // triangles in EACH of the colour and shadow passes. 25/90 hands a 12 m tree
  // to its mid mesh at 25 m and to the impostor at 90 m; `maxDistance` keeps
  // the canopy on the horizon. `shadowFar` 50 swaps the SHADOW caster to the
  // impostor at 50 m — the sun's map only covers ~100 m around the camera, so
  // mid geometry beyond that was pure vertex cost (0 = replay lodFar).
  for (const tree of trees) Object.assign(tree.props, { lodNear: 25, lodFar: 90, maxDistance: 420, shadowFar: 50 });
  const shrubs = [
    population('hazel-study', { ...common, species: 'oak', seed: 125, height: 1.8, width: 2.9, leafDensity: 1.6, leafSize: 1.35, branchDensity: 1.4, crownBase: -.15, crownSpread: 1.2, leafColor: '#4e6736', barkColor: '#6c6048' }),
    population('young-growth', { ...common, species: 'birch', seed: 142, height: 2.8, width: 2.6, leafDensity: 1.5, leafSize: 1.25, branchDensity: 1.2, crownBase: -.15, crownSpread: 1.15, leafColor: '#688446', barkColor: '#82755d' }),
  ];
  // Understory: 2-3 m plants, proportionally closer than the canopy's 25/90.
  // hazel + young growth alone were ~9.7 M triangles per pass at 30/90.
  for (const shrub of shrubs) Object.assign(shrub.props, { lodNear: 20, lodFar: 60, maxDistance: 220, shadowFar: 30 });
  // The golden accent is one shaped broadleaf on the ordinary generator; the
  // look lives in its leaf colour, the habitat rule does the siting.
  const accents = [
    population('accent', { ...common, species: 'oak', seed: 207, height: 12, width: 7.2, leafDensity: 1.45, leafSize: 1.24, branchDensity: 1.15, crownBase: -.06, crownSpread: .98, leafColor: '#c99a3a', barkColor: '#5e5142' }),
  ];
  for (const accent of accents) Object.assign(accent.props, { lodNear: 25, lodFar: 90, maxDistance: 420, shadowFar: 50 });
  // Ground-cover floor matches the shrubs' 30/90/220 — these are the same
  // scale of plant (the drawn sward stands down the short/long swards
  // entirely when it is on; only the reeds and flowers stay scattered).
  const grasses = [
    population('meadow-short', { ...common, species: 'grass', seed: 17, height: .23, width: .66, leafColor: '#74834c', lodNear: 30, lodFar: 90, maxDistance: 220, castShadow: false }),
    population('meadow-long', { ...common, species: 'grass', seed: 69, height: .58, width: .68, leafColor: '#788b51', lodNear: 30, lodFar: 90, maxDistance: 220, castShadow: false }),
    population('bank-rushes', { ...common, species: 'grass', seed: 106, height: 1.02, width: .38, leafColor: '#6b7b48', lodNear: 30, lodFar: 90, maxDistance: 220, castShadow: false }),
    population('meadow-flowers', { ...common, species: 'wildflowers', seed: 25, height: .45, width: .38, leafColor: '#607343', flowerColor: '#e6dfbb', lodNear: 30, lodFar: 90, maxDistance: 220, castShadow: false }),
    population('woodland-floor', { ...common, species: 'grass', seed: 113, height: .12, width: .72, leafColor: '#53643a', lodNear: 30, lodFar: 90, maxDistance: 220, castShadow: false }),
  ];
  for (const grass of grasses) grass.props.height *= grassHeight;
  return { trees, shrubs, accents, grasses };
}

/** Drive the whole scatter now. Tests, export and the player use this. */
export function createValleyEcology(fields, options = {}) {
  const steps = valleyEcologySteps(fields, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Resumable scatter: a 512 m world walks over a million candidates, which is a
 * second of unbroken work if it is not handed back frame by frame. */
export function* valleyEcologySteps(fields, { seed = 894, forestDensity = 1, groundDensity = 1, heightAt, vegetation = {}, clock = ALWAYS_RUN, drawnGrass = false, keepEmpty = null } = {}) {
  if (!fields || typeof fields.sample !== 'function' || !Number.isFinite(fields.extent) || fields.extent <= 0 || fields.extent > 512) throw new RangeError('Valley ecology needs bounded landscape fields (at most 512 m)');
  if (![seed, forestDensity, groundDensity].every(Number.isFinite) || forestDensity < 0 || forestDensity > 2 || groundDensity < 0 || groundDensity > 2) throw new RangeError('Ecology density must be between 0 and 2');
  const { treeScale = 1, grassHeight = 1, patchiness = .65, accentTrees = 1 } = vegetation;
  if (!Number.isFinite(treeScale) || treeScale < .65 || treeScale > 1.5 || !Number.isFinite(grassHeight) || grassHeight < .5 || grassHeight > 1.75 ||
      !Number.isFinite(patchiness) || patchiness < 0 || patchiness > 1 || !Number.isFinite(accentTrees) || accentTrees < 0 || accentTrees > 2) throw new RangeError('Vegetation needs bounded tree scale, grass height, patchiness and accent trees');
  const groups = [], half = fields.extent / 2;
  const buildingPads = fields.recipe?.buildingPads ?? fields.recipe?.buildings?.map(building => ({
    center: building.position, angle: building.rotation?.[1] ?? 0,
    halfWidth: building.halfWidth, halfDepth: building.halfDepth,
  }));
  const blockedByBuilding = buildingPads ? (x, z) => buildingPads.some(pad => {
    const c = Math.cos(pad.angle ?? 0), s = Math.sin(pad.angle ?? 0), dx = x - pad.center[0], dz = z - pad.center[2];
    return Math.abs(c * dx - s * dz) < pad.halfWidth + 1.2 && Math.abs(s * dx + c * dz) < pad.halfDepth + 1.2;
  }) : (x, z) => Math.abs(x - 22) < 10.8 && Math.abs(z - 6) < 11.5;
  const group = (id, props) => { const entry = { id, props, placements: [] }; groups.push(entry); return entry; };
  const populations = ecologyPopulations({ grassHeight });
  const trees = populations.trees.map(p => group(p.id, p.props));
  const shrubs = populations.shrubs.map(p => group(p.id, p.props));
  const accents = populations.accents.map(p => group(p.id, p.props));
  const grasses = populations.grasses.map(p => group(p.id, p.props));
  const counts = { candidates: 0, trees: 0, shrubs: 0, ground: 0, accent: 0 };
  function* scan(kind, base, pick) {
    const [reference, ceiling] = POPULATION[kind];
    // A drawn field already carries the short and long sward, so the scatter is
    // left with the rushes and the flowers: far fewer plants, and no reason to
    // walk a candidate every 42 cm looking for them.
    const share = kind === 'ground' && drawnGrass ? .32 : 1;
    if (kind === 'ground' && drawnGrass) base = Math.max(base, .7);
    const limit = Math.min(ceiling, Math.round(reference * share * (fields.extent * fields.extent) / (128 * 128)));
    const spacing = Math.max(base, fields.extent / Math.sqrt(CANDIDATE_BUDGET));
    const count = Math.ceil(fields.extent / spacing);
    // Thin the whole area uniformly to fit the budget. Stopping at the cap
    // filled the first rows and left the rest of a large world bare.
    const keep = Math.min(1, limit / Math.max(1, count * count * EXPECTED_YIELD[kind]));
    for (let row = 0; row < count; row++) {
      if (clock.due()) yield 'planting';
      for (let col = 0; col < count; col++) {
      if (counts[kind] >= limit) return;
      counts.candidates++;
      const channel = kind === 'trees' ? 10 : kind === 'shrubs' ? 20 : kind === 'accent' ? 40 : 30;
      const x = -half + (col + .2 + random(seed, col, row, channel) * .6) * spacing;
      const z = -half + (row + .2 + random(seed, col, row, channel + 1) * .6) * spacing;
      if (Math.abs(x) > half - 1 || Math.abs(z) > half - 1) continue;
      const field = fields.sample(x, z);
      // Procedural layouts provide every pad; the isolated legacy study keeps
      // its original fixed footprint without adding an invisible reservation.
      const cottage = blockedByBuilding(x, z);
      if (field.shore < .12 || field.path > .62 || field.rock > .8 || field.slope > .95 || cottage) continue;
      if (keep < 1 && random(seed, col, row, channel + 6) > keep) continue;
      const patch = kind === 'trees' ? null : sampleValleyPlanting(seed, x, z, patchiness);
      const choice = pick(field, random(seed, col, row, channel + 2), random(seed, col, row, channel + 3), patch);
      if (!choice) continue;
      const y = heightAt ? heightAt(x, z) : field.height;
      const id = `${kind}/${col}/${row}`;
      choice.placements.push({ id, position: [x, y, z], rotation: [0, random(seed, col, row, channel + 4) * Math.PI * 2, 0],
        scale: (.78 + random(seed, col, row, channel + 5) * .46) * (kind === 'trees' ? treeScale : 1) });
      counts[kind]++;
      }
    }
  }
  yield* scan('trees', 5.2, (field, chance, variant) => {
    const density = clamp(field.forest * forestDensity * .93) * clamp((field.shore - 1.8) / 3);
    if (chance > density) return null;
    return field.moisture > .65 && variant > .6 ? trees[2] : variant < .4 ? trees[0] : variant < .74 ? trees[1] : variant < .87 ? trees[2] : trees[3];
  });
  yield* scan('shrubs', 2.35, (field, chance, variant, patch) => {
    const habitat = clamp(field.forest * .48 + field.moisture * .52 - .1) * forestDensity;
    if (chance > habitat * .62 * patch.shrubs || field.shore < .4) return null;
    return shrubs[variant < .76 + (patch.stand - .5) * patchiness * .38 ? 0 : 1];
  });
  yield* scan('ground', .42, (field, chance, variant, patch) => {
    const shade = 1 - field.forest * .54;
    const probability = clamp((.64 + field.moisture * .25) * shade * groundDensity * (1 - field.path) * (1 - field.rock) * patch.ground);
    if (chance > probability) return null;
    if (field.shore < 1.8 && variant < .72 * (1 - patchiness) + (.06 + patch.rush * .90) * patchiness) return grasses[2];
    // Woodland gradually favors a low floor, while tall grass/flowers form
    // local stands in open meadows. Keep species decisions density independent.
    if (!drawnGrass && variant < smooth(.30, .88, field.forest) * .88) return grasses[4];
    // Flowers are picked from a far smaller candidate grid once the sward is
    // drawn, so their slice of the variant has to widen to keep the same stand.
    if (variant > (drawnGrass ? .90 : .975) && field.forest < .45 && patch.stand > .55) return grasses[3];
    // The short and long sward are the drawn field's job when it is on; only
    // the reeds and the flowers above are still worth an individual plant.
    if (drawnGrass) return null;
    const tall = .34 * (1 - patchiness) + (.10 + patch.stand * .67) * patchiness;
    return grasses[variant > 1 - tall * (1 - field.forest * .65) ? 1 : 0];
  });
  // Golden accents stand where the forest filter gives up: broken rocky ground
  // and high shelves above the water, never the deep stone the outcrops own.
  // Their own accept band leaves the main habitat filter untouched.
  yield* scan('accent', 5.2, (field, chance, variant, patch) => {
    const rocky = field.rock >= .25 && field.rock < .8;
    const shelf = field.rock >= .12 && field.rock < .8 && Number.isFinite(field.waterLevel) && field.height - field.waterLevel > 5.5;
    if (!(rocky || shelf) || field.shore < 2.2 || field.path > .4 || field.slope > .9) return null;
    if (chance > .14 * accentTrees * (patch.stand * 1.5 + .25)) return null;
    return accents[0];
  });
  // `keepEmpty`: population ids that must exist even with no valley plant (a
  // streamed World feeds them chunk by chunk).
  return { groups: groups.filter(entry => entry.placements.length > 0 || keepEmpty?.includes(entry.id)), counts, vegetation: { treeScale, grassHeight, patchiness } };
}
