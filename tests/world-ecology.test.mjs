import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from 'three/webgpu';
import { createValleyFields } from '../src/engine/world/landscapeFields.js';
import { createValleyEcology } from '../src/engine/world/valleyEcology.js';
import { resolveFoliagePlacements } from '../src/modules/foliage/foliagePlacements.js';
import { MAX_FOLIAGE_INSTANCES } from '../src/modules/foliage/foliageScatter.js';

const fields = createValleyFields({ seed: 894, extent: 128 });
const defaults = { seed: 718, forestDensity: .65, groundDensity: .35 };
const fixtures = new Map();
const fixture = (options = {}) => {
  const settings = { ...defaults, ...options }, key = JSON.stringify(settings);
  if (!fixtures.has(key)) fixtures.set(key, createValleyEcology(fields, settings));
  return fixtures.get(key);
};
const entries = result => result.groups.flatMap(group => group.placements.map(plant => ({ group: group.id, props: group.props, plant })));
const byId = result => new Map(entries(result).map(entry => [entry.plant.id, entry]));
const kind = id => id.split('/')[0];
const placementsOfKind = (result, kinds) => entries(result).filter(entry => kinds.includes(kind(entry.plant.id)));

test('real valley ecology regenerates exact identities, placements and persisted JSON', () => {
  const first = fixture();
  const freshFields = createValleyFields({ seed: 894, extent: 128 });
  const second = createValleyEcology(freshFields, { ...defaults });
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'the persisted placement document loses no data');
  assert.ok(first.counts.trees > 10 && first.counts.shrubs > 50 && first.counts.ground > 1000, 'the actual valley has populated ecological layers');
  const plants = entries(first), ids = new Set(plants.map(entry => entry.plant.id));
  assert.equal(ids.size, plants.length, 'candidate IDs are unique across every species group');
  assert.equal(new Set(first.groups.map(group => group.id)).size, first.groups.length);
  for (const { plant, props } of plants) {
    assert.equal(props.distribution, 'placements');
    assert.ok(plant.id.length > 0);
    assert.ok(plant.position.length === 3 && plant.position.every(Number.isFinite));
    assert.ok(plant.rotation.length === 3 && plant.rotation.every(Number.isFinite));
    assert.ok(plant.scale > 0 && plant.scale <= 1.25);
    assert.ok(Math.abs(plant.position[0]) <= fields.extent / 2 - 1 && Math.abs(plant.position[2]) <= fields.extent / 2 - 1);
  }
});

test('raising density retains group, position, rotation and scale for common candidate IDs', () => {
  const sparse = fixture({ forestDensity: .25, groundDensity: .15 });
  const dense = fixture({ forestDensity: 1.5, groundDensity: 1.4 });
  const denseIds = byId(dense);
  let common = 0;
  for (const old of entries(sparse)) {
    const current = denseIds.get(old.plant.id);
    if (!current) continue;
    assert.equal(current.group, old.group, 'density never chooses a different species/shape channel');
    assert.deepEqual(current.props, old.props, 'prototype seeds and authored shape settings are density independent');
    assert.deepEqual(current.plant, old.plant, 'surviving plants keep all placement channels exactly');
    common++;
  }
  assert.ok(common > 1000, 'the comparison exercises a substantial shared population');
  for (const key of ['trees', 'shrubs', 'ground']) assert.ok(dense.counts[key] > sparse.counts[key]);
  // Do not require every sparse ID to survive a capped scan: a denser scan can
  // fill its bounded population before reaching a later sparse candidate.
});

test('forest and ground density changes cannot advance one another’s random channels', () => {
  const original = fixture();
  const changedForest = fixture({ forestDensity: 1.35 });
  assert.deepEqual(placementsOfKind(changedForest, ['ground']), placementsOfKind(original, ['ground']));
  const changedGround = fixture({ groundDensity: .85 });
  assert.deepEqual(placementsOfKind(changedGround, ['trees', 'shrubs']), placementsOfKind(original, ['trees', 'shrubs']));
  const changedSeed = fixture({ seed: defaults.seed + 1 });
  const changedIds = byId(changedSeed);
  let common = 0, moved = 0, rotated = 0, scaled = 0;
  for (const { plant } of entries(original)) {
    const changed = changedIds.get(plant.id)?.plant;
    if (!changed) continue;
    common++;
    if (plant.position[0] !== changed.position[0] || plant.position[2] !== changed.position[2]) moved++;
    if (plant.rotation[1] !== changed.rotation[1]) rotated++;
    if (plant.scale !== changed.scale) scaled++;
  }
  assert.ok(common > 1000);
  assert.ok(moved > common * .95 && rotated > common * .95 && scaled > common * .95, 'changing the seed really changes each placement channel');
});

test('actual populated valley leaves water, paths, cottage approach and steep exposed slopes clear', () => {
  const dense = fixture({ forestDensity: 1.5, groundDensity: 1.4 });
  const excluded = { water: 0, path: 0, cliff: 0, cottage: 0 };
  for (let z = -62; z <= 62; z += 2) for (let x = -62; x <= 62; x += 2) {
    const field = fields.sample(x, z);
    if (field.shore < .12) excluded.water++;
    if (field.path > .62) excluded.path++;
    if (field.slope > .95 || field.rock > .8) excluded.cliff++;
    if (Math.abs(x - 22) < 10.8 && Math.abs(z - 6) < 11.5) excluded.cottage++;
  }
  for (const [name, count] of Object.entries(excluded)) assert.ok(count > 10, `real fields exercise the ${name} exclusion`);
  for (const { plant } of entries(dense)) {
    const [x, y, z] = plant.position, field = fields.sample(x, z);
    assert.ok(field.shore >= .12, `${plant.id} is above the dry shore margin`);
    assert.equal(field.depth, 0, `${plant.id} is outside actual water`);
    assert.ok(field.path <= .62, `${plant.id} leaves the path open`);
    assert.ok(field.rock <= .8 && field.slope <= .95, `${plant.id} avoids exposed steep rock`);
    assert.ok(!(Math.abs(x - 22) < 10.8 && Math.abs(z - 6) < 11.5), `${plant.id} leaves all cottage forms and their approach clear`);
    assert.equal(y, field.height, 'default roots use the same generated elevation field');
  }
});

test('heightAt seats the same candidates on actual triangle-interpolated surface heights', () => {
  // A coarse but real triangle mesh exposes the analytic/rendered discrepancy:
  // rendering connects sampled vertices, not the continuous noise function.
  const segments = 32, step = fields.extent / segments, half = fields.extent / 2;
  const heights = Array.from({ length: segments + 1 }, (_, row) =>
    Array.from({ length: segments + 1 }, (_, col) => fields.sampleHeight(col * step - half, row * step - half)));
  const triangleHeight = (x, z) => {
    const gx = (x + half) / step, gz = (z + half) / step;
    const col = Math.min(segments - 1, Math.floor(gx)), row = Math.min(segments - 1, Math.floor(gz));
    const u = gx - col, v = gz - row, a = heights[row][col], b = heights[row][col + 1], c = heights[row + 1][col], d = heights[row + 1][col + 1];
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (b - d) * (1 - v) + (c - d) * (1 - u);
  };
  let calls = 0;
  const actual = createValleyEcology(fields, { ...defaults, heightAt(x, z) { calls++; return triangleHeight(x, z); } });
  const original = byId(fixture());
  let corrected = 0;
  for (const { group, plant } of entries(actual)) {
    const previous = original.get(plant.id);
    assert.equal(group, previous.group);
    assert.equal(plant.position[0], previous.plant.position[0]); assert.equal(plant.position[2], previous.plant.position[2]);
    assert.deepEqual(plant.rotation, previous.plant.rotation); assert.equal(plant.scale, previous.plant.scale);
    assert.equal(plant.position[1], triangleHeight(plant.position[0], plant.position[2]));
    if (Math.abs(plant.position[1] - previous.plant.position[1]) > .001) corrected++;
  }
  assert.equal(calls, original.size, 'sample accepted roots once, without changing membership');
  assert.ok(corrected > 1000, 'the test would fail if heightAt were ignored in favor of analytic heights');
});

test('large real-field populations stop at bounded category and native placement limits', () => {
  const largeFields = createValleyFields({ extent: 512, seed: 894, forestCover: 1, rockiness: 0, relief: 0 });
  const large = createValleyEcology(largeFields, { seed: 718, forestDensity: 2, groundDensity: 2 });
  // Budgets scale with area up to a ceiling; a bigger world may not exceed it.
  const ceilings = { trees: 3200, shrubs: 6000, ground: 160000 };
  const totals = { trees: 0, shrubs: 0, ground: 0 };
  const quadrants = new Set();
  for (const group of large.groups) {
    assert.ok(group.placements.length > 0 && group.placements.length <= MAX_FOLIAGE_INSTANCES);
    for (const plant of group.placements) {
      totals[kind(plant.id)]++;
      quadrants.add(`${Math.sign(plant.position[0]) || 1},${Math.sign(plant.position[2]) || 1}`);
    }
  }
  for (const [key, ceiling] of Object.entries(ceilings)) {
    assert.equal(large.counts[key], totals[key]);
    assert.ok(totals[key] > 0 && totals[key] <= ceiling, `${key} stays inside its ceiling: ${totals[key]} of ${ceiling}`);
  }
  assert.ok(totals.trees >= 1200 && totals.ground >= 40000, `a large world is populated, not a token sprinkle: ${JSON.stringify(totals)}`);
  // The former fixed caps filled the first rows and stopped, which left most of
  // a large world bare. Coverage must reach every corner of it.
  assert.equal(quadrants.size, 4, 'planting reaches all four quadrants of a large world');
  const far = large.groups.flatMap(group => group.placements).filter(plant => plant.position[2] > 180);
  assert.ok(far.length > 2000, `the far edge of a large world is planted too: ${far.length}`);
  const largest = large.groups.reduce((a, b) => a.placements.length > b.placements.length ? a : b);
  const native = resolveFoliagePlacements(largest.placements, new Matrix4());
  assert.equal(native.length, largest.placements.length, 'the largest generated group fits the real component path without truncation');
  for (let i = 0; i < native.length; i++) {
    assert.equal(native[i].id, largest.placements[i].id);
    assert.deepEqual(native[i].position, largest.placements[i].position);
    assert.ok(native[i].matrix.elements.every(Number.isFinite));
  }
});

test('study shrubs use supported broadleaf generators and explicit study identities', () => {
  const groups = fixture().groups;
  const hazel = groups.find(group => group.id === 'hazel-study');
  const young = groups.find(group => group.id === 'young-growth');
  assert.ok(hazel?.placements.length > 0 && young?.placements.length > 0);
  assert.equal(hazel.props.species, 'oak', 'hazel is a shaped broadleaf study, not a new botanical generator');
  assert.equal(young.props.species, 'birch');
  assert.ok(hazel.props.height < 3 && young.props.height < 3);
  for (const group of groups) {
    assert.ok(['oak', 'birch', 'pine', 'grass', 'wildflowers'].includes(group.props.species));
    assert.ok(group.props.lodNear < group.props.lodFar && group.props.lodFar < group.props.maxDistance);
  }
});

test('zero density produces no plants and invalid unbounded requests fail before scanning', () => {
  // Accent trees have their own control: they are not forest, so a zero-forest
  // world still grows them unless the golden accent knob is zeroed too.
  const empty = fixture({ forestDensity: 0, groundDensity: 0, vegetation: { accentTrees: 0 } });
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.counts.trees + empty.counts.shrubs + empty.counts.ground + empty.counts.accent, 0);
  for (const options of [{ forestDensity: -.01 }, { forestDensity: 2.1 }, { groundDensity: Infinity }, { groundDensity: -1 }, { seed: NaN }]) {
    assert.throws(() => createValleyEcology(fields, options), RangeError);
  }
  for (const invalid of [null, {}, { ...fields, extent: 0 }, { ...fields, extent: 513 }, { ...fields, extent: Infinity }]) {
    assert.throws(() => createValleyEcology(invalid), RangeError);
  }
});

test('tree scale and grass height alter only their intended shape channels', () => {
  const vegetation = Object.freeze({ treeScale: 1.3, grassHeight: 1.4, patchiness: .65 });
  const original = fixture(), changed = fixture({ vegetation });
  assert.deepEqual(changed.vegetation, vegetation);
  assert.deepEqual(changed.counts, original.counts, 'shape controls cannot change membership');
  const previous = byId(original);
  for (const current of entries(changed)) {
    const old = previous.get(current.plant.id), category = kind(current.plant.id);
    assert.equal(current.group, old.group, 'shape controls do not choose a new species');
    assert.deepEqual(current.plant, { ...old.plant, scale: old.plant.scale * (category === 'trees' ? 1.3 : 1) },
      'only tree placement scale changes; roots and rotations stay exact');
    assert.deepEqual(current.props, { ...old.props, height: old.props.height * (category === 'ground' ? 1.4 : 1) },
      'only ground prototype height changes');
  }
  const inherited = fixture({ vegetation: { grassHeight: .75 } });
  assert.deepEqual(inherited.vegetation, { treeScale: 1, grassHeight: .75, patchiness: .65 });
  assert.deepEqual(JSON.parse(JSON.stringify(changed)), changed);
});

// Constant habitat removes the broad forest/moisture gradients that could
// falsely certify an otherwise independent per-candidate hash scatter.
const homogeneous = { extent: 128, sample: () => ({ height: 0, shore: 8, path: 0, rock: 0, slope: 0, forest: .55, moisture: .55 }) };
function quadrats(result, select, cell = 4) {
  // All plots are left of the cottage and away from the perimeter. A capped
  // row scan is excluded separately, so it cannot manufacture a density patch.
  const width = 56 / cell, height = 112 / cell, values = new Float64Array(width * height);
  for (const group of result.groups) for (const plant of group.placements) {
    if (!select(group, plant)) continue;
    const [x, , z] = plant.position;
    if (x < -56 || x >= 0 || z < -56 || z >= 56) continue;
    values[Math.floor((z + 56) / cell) * width + Math.floor((x + 56) / cell)]++;
  }
  return { width, height, values };
}
function spatialStats({ width, height, values }) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let variance = 0, covariance = 0, pairs = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const delta = values[y * width + x] - mean; variance += delta * delta;
    for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) if (nx < width && ny < height) {
      covariance += delta * (values[ny * width + nx] - mean); pairs++;
    }
  }
  return { mean, fano: variance / values.length / Math.max(mean, 1e-9),
    moran: variance > 0 ? values.length / pairs * covariance / variance : 0 };
}
function shuffledPlots(plots) {
  const values = plots.values.slice(); let state = 319;
  for (let i = values.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (i + 1); [values[i], values[other]] = [values[other], values[i]];
  }
  return { ...plots, values };
}
const patchFixtures = new Map();
function patchFixture(seed, patchiness) {
  const key = `${seed}/${patchiness}`;
  if (!patchFixtures.has(key)) patchFixtures.set(key, createValleyEcology(homogeneous,
    { seed, forestDensity: .65, groundDensity: 1, vegetation: { patchiness } }));
  return patchFixtures.get(key);
}

test('actual ground and shrub roots form coherent stands, rejecting uniform and shuffled placement controls', () => {
  for (const seed of [894, 718]) for (const patchiness of [.65, 1]) {
    const planted = patchFixture(seed, patchiness), uniform = patchFixture(seed, 0);
    assert.ok(planted.counts.ground < 75000 && planted.counts.shrubs < 900, 'clumping is not a population-cap boundary');
    // Shrub plots contain about two roots each; the default partial patch
    // strength has weaker correlation than full stands, above both controls.
    for (const [category, cell, minimumMoran, minimumFano] of [['ground', 4, .25, 1.5], ['shrubs', 8, patchiness === 1 ? .15 : .08, 1.1]]) {
      const select = (_group, plant) => kind(plant.id) === category;
      const plots = quadrats(planted, select, cell), actual = spatialStats(plots);
      const old = spatialStats(quadrats(uniform, select, cell)), shuffled = spatialStats(shuffledPlots(plots));
      const passes = value => value.moran > minimumMoran && value.fano > minimumFano;
      const receipt = JSON.stringify({ seed, patchiness, category, actual, old, shuffled });
      assert.ok(actual.mean > (category === 'ground' ? 5 : .2), receipt);
      assert.ok(passes(actual), `generated stands have both local continuity and density contrast: ${receipt}`);
      assert.ok(!passes(old), `the retained independent-hash mode must fail the same stand gate: ${receipt}`);
      assert.ok(!passes(shuffled), `equal population and equal variance without spatial continuity must fail: ${receipt}`);
      assert.ok(Math.abs(shuffled.mean - actual.mean) < 1e-9 && Math.abs(shuffled.fano - actual.fano) < 1e-9);
    }
    // Density clustering alone is insufficient: short/long grass should form
    // neighboring cohorts rather than keeping an independent random mixture.
    const shares = result => {
      const all = quadrats(result, group => ['meadow-short', 'meadow-long'].includes(group.id));
      const long = quadrats(result, group => group.id === 'meadow-long');
      const fraction = long.values.reduce((sum, value) => sum + value, 0) / all.values.reduce((sum, value) => sum + value, 0);
      return { ...all, values: all.values.map((count, index) => count >= 5 ? long.values[index] / count : fraction) };
    };
    const actual = spatialStats(shares(planted)), old = spatialStats(shares(uniform));
    assert.ok(actual.moran > .15 && actual.moran > old.moran + .15,
      `actual short/long species shares form cohorts: ${JSON.stringify({ seed, patchiness, actual, old })}`);
  }
});

test('patchiness can change membership and species without moving common roots', () => {
  const sparse = patchFixture(894, 0), patched = patchFixture(894, 1), previous = byId(sparse);
  let common = 0, changedGroup = 0;
  for (const current of entries(patched)) {
    const old = previous.get(current.plant.id); if (!old) continue;
    assert.deepEqual(current.plant, old.plant, 'patch edits retain candidate position, rotation and scale');
    common++; if (current.group !== old.group) changedGroup++;
  }
  assert.ok(common > 1000 && changedGroup > 100, 'the comparison exercises retained roots with a real cohort change');
  assert.notDeepEqual([...byId(patched).keys()].sort(), [...previous.keys()].sort(), 'patchiness changes actual planting membership');
});

test('vegetation settings reject nonfinite and out-of-range values before scanning', () => {
  let calls = 0;
  const guarded = { ...homogeneous, sample: () => { calls++; return homogeneous.sample(); } };
  for (const vegetation of [{ treeScale: .64 }, { treeScale: 1.51 }, { treeScale: NaN },
    { grassHeight: .49 }, { grassHeight: 1.76 }, { grassHeight: Infinity },
    { patchiness: -.01 }, { patchiness: 1.01 }, { patchiness: NaN }]) {
    assert.throws(() => createValleyEcology(guarded, { vegetation }), RangeError);
  }
  assert.equal(calls, 0);
});
