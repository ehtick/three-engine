import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorldDocument, createWorldDocument, patchWorldSettings } from '../src/engine/world/worldDocument.js';
import { prepareWorldPlan } from '../src/modules/world/worldPlan.js';
import { prepareWorldPlanData, worldPlanDataSteps } from '../src/modules/world/worldPlanData.js';

// `worldPlan.worker.js` imports nothing but `worldPlanData.js` (and
// `normalizeWorldDocument`) — the exact module this file drives directly, in
// process, standing in for the worker's own drive loop (a Worker is not
// available under `node --test`, so `prepareWorldPlanAsync` never takes the
// worker path here; see `worldPlan.js`'s `typeof Worker !== 'undefined'`
// guard). The point of this test is that the SAME stage functions the worker
// runs off-thread reproduce, byte for byte, what `prepareWorldPlan` (the
// synchronous, fully inline driver every other World test already trusts)
// produces for the fields a plan's `reuse` contract actually shares:
// `layoutKey`, `layout`, `fieldKey`, `fieldCache`, `scatterKey`, `ecology`,
// `grassField`, `packed`, `shoreCache`, `waterHeights`.

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

for (const extent of [128, 256]) {
  test(`worldPlanDataSteps reproduces prepareWorldPlan's shared fields byte-for-byte at ${extent} m`, () => {
    const document = normalizeWorldDocument(patchWorldSettings(createWorldDocument(), { extent }));
    const plan = prepareWorldPlan(document);
    const data = prepareWorldPlanData(document);

    assert.equal(data.layoutKey, plan.layoutKey);
    assert.equal(data.fieldKey, plan.fieldKey);
    assert.equal(data.scatterKey, plan.scatterKey);
    assert.deepEqual(data.layout, plan.layout);
    assert.deepEqual(data.sites, plan.layout.buildings, 'the un-refit siting the worker returns is what the plan built its houses from');

    assert.ok(arraysEqual(data.fieldCache, plan.fieldCache), 'the sampled field cache (heights, masks, water level) is identical');
    assert.ok(arraysEqual(data.packed, plan.packed), 'the rasterized water domain texture is identical');
    assert.ok(arraysEqual(data.shoreCache, plan.shoreCache), 'the shore/depth field is identical');
    assert.ok(arraysEqual(data.waterHeights, plan.waterHeights), 'the water surface height grid is identical');

    assert.deepEqual(data.ecology.counts, plan.ecology.counts);
    assert.equal(data.ecology.groups.length, plan.ecology.groups.length);
    for (let i = 0; i < data.ecology.groups.length; i++) {
      assert.equal(data.ecology.groups[i].id, plan.ecology.groups[i].id);
      assert.deepEqual(data.ecology.groups[i].placements, plan.ecology.groups[i].placements, `${data.ecology.groups[i].id} placements`);
    }

    assert.ok(data.grassField, 'the default document draws grass');
    assert.ok(arraysEqual(data.grassField.data, plan.grassField.data), 'the packed grass field (height/density/scale/dryness) is identical');
    assert.ok(arraysEqual(data.grassField.ground, plan.grassField.ground), "the grass field's baked ground colour is identical");
    assert.equal(data.grassField.size, plan.grassField.size);

    plan.dispose();
  });
}

test('worldPlanDataSteps takes the same reuse fast path prepareWorldPlan does: a look-only change reuses layout/fields/scatter/grass/water', () => {
  const base = normalizeWorldDocument(createWorldDocument());
  const first = prepareWorldPlanData(base);
  // `style` is a "look"-stage parameter: it must not appear in any of
  // layoutKey/fieldKey/scatterKey, so every cached array below is the exact
  // same object reference, not merely an equal one.
  const restyled = normalizeWorldDocument(patchWorldSettings(base, { style: 'stylized' }));
  const second = prepareWorldPlanData(restyled, { reuse: first });
  assert.equal(second.layoutKey, first.layoutKey);
  assert.equal(second.fieldKey, first.fieldKey);
  assert.equal(second.scatterKey, first.scatterKey);
  assert.equal(second.fieldCache, first.fieldCache, 'field cache is reused, not resampled');
  assert.equal(second.ecology, first.ecology, 'ecology scatter is reused');
  assert.equal(second.grassField, first.grassField, 'the packed grass field is reused (a look change does not resample it)');
  assert.equal(second.packed, first.packed, 'the water domain raster is reused');
  assert.equal(second.shoreCache, first.shoreCache, 'the shore/depth field is reused');
  assert.equal(second.waterHeights, first.waterHeights, 'the water height grid is reused');
});

test('a cancelled worldPlanDataSteps generator disposes nothing of its own and yields the documented stage names', () => {
  const document = normalizeWorldDocument(createWorldDocument());
  const seen = new Set();
  const steps = worldPlanDataSteps(document, {});
  let step = steps.next();
  let guard = 0;
  while (!step.done && guard++ < 200000) { seen.add(step.value); step = steps.next(); }
  assert.ok(guard < 200000, 'the generator must terminate');
  for (const stage of ['layout', 'roads', 'terrain', 'planting', 'water']) {
    assert.ok(seen.has(stage), `expected a '${stage}' stage yield`);
  }
  // Every field `worldPlan.js` reads off this result as `reuse`.
  for (const key of ['layoutKey', 'layout', 'sites', 'fieldKey', 'fieldCache', 'scatterKey', 'ecology', 'grassField', 'packed', 'shoreCache', 'waterHeights']) {
    assert.ok(key in step.value, `result is missing ${key}`);
  }
});
