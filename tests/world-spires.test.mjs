import test from 'node:test';
import assert from 'node:assert/strict';
import { createValleyFields } from '../src/engine/world/landscapeFields.js';
import { createWorldLayout } from '../src/engine/world/worldLayout.js';
import { createValleyEcology } from '../src/engine/world/valleyEcology.js';
import { createWorldDocument } from '../src/engine/world/worldDocument.js';
import { prepareWorldPlan } from '../src/modules/world/worldPlan.js';

const extent = 128, half = extent / 2;
const fieldsFor = (fieldOptions = {}) => {
  const layout = createWorldLayout({ seed: 894, extent, buildings: false });
  return createValleyFields({ seed: 894, extent, layout, ...fieldOptions });
};
// The rock-stack spire tests retired with the prism rocks on 09-14: stone is
// the SDF library now (tests/landscape-generator.test.mjs). Accents remain.

const ecologyFor = (fields, vegetation = {}) => createValleyEcology(fields,
  { seed: 894, forestDensity: 1, groundDensity: 1, vegetation });
const accentOf = ecology => ecology.groups.find(group => group.id === 'accent');

test('golden accent trees are deterministic, sparse and scaled by their own control', () => {
  const fields = fieldsFor();
  const first = ecologyFor(fields), again = ecologyFor(fieldsFor());
  assert.deepEqual(accentOf(again), accentOf(first), 'same seed replays the accent group exactly');
  assert.deepEqual(JSON.parse(JSON.stringify(accentOf(first))), accentOf(first), 'the accent group persists as plain JSON');
  const count = accentOf(first).placements.length;
  assert.ok(count > 0 && count <= 15, `a handful of accents per 128 m: ${count}`);
  assert.ok(count < first.counts.trees * .2, `accents stay sparse next to ${first.counts.trees} forest trees`);
  assert.equal(ecologyFor(fieldsFor(), { accentTrees: 0 }).counts.accent, 0);
  assert.ok(!accentOf(ecologyFor(fieldsFor(), { accentTrees: 0 })), 'zero accent density removes the group');
  const more = ecologyFor(fieldsFor(), { accentTrees: 2 }).counts.accent;
  assert.ok(more > count, `the control scales the group: ${count} -> ${more}`);
  for (const vegetation of [{ accentTrees: -.01 }, { accentTrees: 2.01 }, { accentTrees: NaN }]) {
    assert.throws(() => ecologyFor(fields, vegetation), RangeError);
  }
});

test('every accent placement meets the rocky-shelf accept rule', () => {
  const fields = fieldsFor(), accent = accentOf(ecologyFor(fields));
  assert.ok(accent);
  for (const plant of accent.placements) {
    const [x, y, z] = plant.position, field = fields.sample(x, z);
    const rocky = field.rock >= .25 && field.rock < .8;
    const shelf = field.rock >= .12 && field.rock < .8 && Number.isFinite(field.waterLevel) && field.height - field.waterLevel > 5.5;
    assert.ok(rocky || shelf, `${plant.id} sits on the rocky band or an upland shelf: rock ${field.rock}`);
    assert.ok(field.shore >= 2.2, `${plant.id} is dry: shore ${field.shore}`);
    assert.ok(field.slope <= .9, `${plant.id} avoids the cliff face itself: slope ${field.slope}`);
    assert.ok(field.path <= .4, `${plant.id} leaves paths open: ${field.path}`);
    assert.equal(y, field.height, `${plant.id} roots at the generated elevation`);
  }
});

test('the emitted accent feature carries its gold leaf colour in both styles', () => {
  for (const [style, leafColor] of [['natural', '#c99a3a'], ['stylized', '#ecc258']]) {
    const plan = prepareWorldPlan(createWorldDocument({ style }));
    const feature = plan.features.find(entry => entry.id === 'foliage/accent');
    assert.ok(feature, `a ${style} world emits the accent feature`);
    assert.equal(feature.kind, 'foliage');
    assert.equal(feature.props.leafColor, leafColor, `${style} gold`);
    assert.equal(feature.props.species, 'oak', 'the accent reuses a broadleaf species');
    assert.ok(feature.props.placements.length > 0);
    plan.dispose();
  }
  const bare = prepareWorldPlan(createWorldDocument({ vegetation: { accentTrees: 0 } }));
  assert.ok(!bare.features.some(entry => entry.id === 'foliage/accent'), 'the control reaches the emitted features');
  bare.dispose();
});
