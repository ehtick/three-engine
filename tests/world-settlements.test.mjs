import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createTerrainShape, TERRAIN_STYLES } from '../src/engine/world/terrainShape.js';
import { createValleyFields } from '../src/engine/world/landscapeFields.js';
import { createWorldLayout } from '../src/engine/world/worldLayout.js';
import { planSettlements, SETTLEMENT_PATTERNS, BUILDING_ROLES } from '../src/engine/world/settlements.js';
import { describeCottageStudy } from '../src/modules/world/worldCottage.js';
import { WORLD_PARAMETERS, WORLD_EXTENTS, worldDefaultSettings, validateWorldSettings, describeWorldParameters } from '../src/engine/world/worldConfig.js';
import { normalizeWorldDocument, patchWorldSettings, setWorldParameter, worldGrid, WORLD_SETTINGS } from '../src/engine/world/worldDocument.js';
import { FIELD_STRIDE } from '../src/modules/world/worldPlanData.js';
import { deriveGrassBaseColor } from '../src/modules/foliage/grassField.js';

// The sward-tone convergence below is the legacy ground pull (09-13), now
// behind `__swardTintsGround` (09-14: the terrain colour is the authority).
globalThis.__swardTintsGround = true;
const footprint = seed => describeCottageStudy({ seed }).footprint;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Mirrors `makeGroundPalette`/`paintGroundVertex`'s sward-tone maths exactly
 * (`worldPlanData.js`), so a test can assert the ground under a sward
 * actually converges on THIS, not an independently-reasoned expectation.
 * ⛔ 09-13: the ground converges on the sward's own MEAN VISIBLE colour
 * (≈0.4 root + 0.6 tip, × the shader's 0.6..1 depth-darkening mean of 0.8),
 * never the root alone — a viewer never sees a sward at its darkest, most
 * saturated single point. */
function expectedSwardTone(moisture, natural = true) {
  const root = new THREE.Color(...deriveGrassBaseColor(new THREE.Color(natural ? '#8ba254' : '#a8c162').toArray()));
  const tip = new THREE.Color(natural ? '#8ba254' : '#a8c162');
  const dry = new THREE.Color(natural ? '#b5a761' : '#cbba6a');
  const drynessWeight = Math.max(0, Math.min(1, 1 - moisture * 1.5));
  root.lerp(dry, drynessWeight * .5);
  tip.lerp(dry, drynessWeight * .5);
  return root.lerp(tip, .6).multiplyScalar(.8);
}
/** Luminance and hue (normalised RGB direction) within 15% of a reference. */
function hueClose(actual, expected, tolerance = .15) {
  const luma = c => c[0] * .3 + c[1] * .59 + c[2] * .11;
  const actualLuma = luma(actual), expectedLuma = luma(expected);
  if (Math.abs(actualLuma - expectedLuma) > Math.max(expectedLuma, .02) * tolerance + .02) return false;
  const norm = c => { const l = Math.max(1e-4, Math.hypot(...c)); return c.map(v => v / l); };
  const [a0, a1, a2] = norm(actual), [e0, e1, e2] = norm(expected);
  return Math.hypot(a0 - e0, a1 - e1, a2 - e2) < tolerance * 2;
}
const layouts = new Map();
const layoutFor = (key, options) => {
  if (!layouts.has(key)) layouts.set(key, createWorldLayout({ seed: 894, footprint, ...options }));
  return layouts.get(key);
};

test('every terrain style is a distinct finite surface whose slope is the real derivative', () => {
  const points = [];
  for (let z = -110; z <= 110; z += 17) for (let x = -110; x <= 110; x += 13) points.push([x, z]);
  const signatures = new Set();
  for (const style of TERRAIN_STYLES) {
    const shape = createTerrainShape({ seed: 894, extent: 256, terrain: { style } });
    const heights = points.map(([x, z]) => {
      const value = shape.sample(x, z);
      assert.ok(Number.isFinite(value.height) && Number.isFinite(value.heightX) && Number.isFinite(value.heightZ), `${style} stays finite`);
      // Slope drives road grading and rock masks; an approximate derivative
      // would let a wall pass a grade check it does not actually satisfy.
      const step = 1e-3;
      const dx = (shape.sample(x + step, z).height - shape.sample(x - step, z).height) / (2 * step);
      const dz = (shape.sample(x, z + step).height - shape.sample(x, z - step).height) / (2 * step);
      assert.ok(Math.abs(dx - value.heightX) < 5e-3 && Math.abs(dz - value.heightZ) < 5e-3, `${style} derivative at ${x},${z}`);
      return value.height;
    });
    signatures.add(JSON.stringify(heights.map(value => value.toFixed(2))));
  }
  assert.equal(signatures.size, TERRAIN_STYLES.length, 'each style is a different surface');
});

test('the Levels control steps highlands into benches with cliffs between them', () => {
  const smooth = createTerrainShape({ seed: 12, extent: 256, terrain: { style: 'highlands', levels: 0 } });
  const stepped = createTerrainShape({ seed: 12, extent: 256, terrain: { style: 'highlands', levels: 1 } });
  let cliffsSmooth = 0, cliffsStepped = 0;
  for (let z = -120; z <= 120; z += 3.1) for (let x = -120; x <= 120; x += 2.9) {
    if (smooth.sample(x, z).cliff > .3) cliffsSmooth++;
    if (stepped.sample(x, z).cliff > .3) cliffsStepped++;
  }
  assert.equal(cliffsSmooth, 0, 'Levels 0 cuts no risers');
  assert.ok(cliffsStepped > 40, `Levels 1 cuts real risers: ${cliffsStepped}`);
});

test('bank controls reshape the shore in the direction each one declares', () => {
  const sampleBank = water => {
    // Taller hills than the World default, so the shoulder has room to show its grade.
    const fields = createValleyFields({ seed: 894, water, terrain: { height: 1.6 } });
    const profile = [];
    for (let shore = .5; shore <= 14; shore += .5) {
      // Walk out from one fixed lake edge and record the rise at each distance.
      let found = null;
      for (let x = -12; x > -46; x -= .1) {
        const value = fields.sample(x, 8);
        if (value.shore >= shore) { found = value; break; }
      }
      if (found) profile.push(found.height - found.waterLevel);
    }
    return profile;
  };
  const base = sampleBank({});
  const gorge = sampleBank({ shoulderGrade: 1.2, shoulderStart: .5, beachWidth: .2 });
  const beach = sampleBank({ beachWidth: 9, beachGrade: .005, shoulderStart: 14 });
  assert.ok(base.length > 20 && gorge.length > 20 && beach.length > 20);
  // 1.5x held against the old valley walls; the 09-14 hills are lower near the
  // lake, so the shoulder meets them sooner and the margin is smaller.
  assert.ok(gorge.at(-1) > base.at(-1) * 1.25, `a gorge bank climbs faster: ${gorge.at(-1)} vs ${base.at(-1)}`);
  assert.ok(beach.at(-1) < base.at(-1) * .8, `a wide beach stays lower: ${beach.at(-1)} vs ${base.at(-1)}`);
  assert.ok(beach.slice(0, 10).every((value, index) => index === 0 || value >= beach[index - 1] - 1e-9), 'the beach still rises away from the water');
  const deep = createValleyFields({ seed: 894, water: { bedSlope: 1.2 } }), shallow = createValleyFields({ seed: 894, water: { bedSlope: .08 } });
  const at = factory => factory.sample(-12, 8).height;
  assert.ok(at(deep) < at(shallow), 'a steeper bed slope digs the basin deeper');
});

test('each town plan builds the structure it names, with plots that front their street', () => {
  const fields = createValleyFields({ seed: 894 });
  const random = (channel, index = 0) => {
    let value = Math.imul(channel + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0x27d4eb2f);
    value = Math.imul(value ^ value >>> 16, 0x7feb352d);
    return ((value ^ value >>> 16) >>> 0) / 4294967296;
  };
  const plans = new Map();
  for (const pattern of SETTLEMENT_PATTERNS) {
    const plan = planSettlements({ fields, extent: 128, random, budget: 12, footprint, settlement: { pattern, count: 1 } });
    plans.set(pattern, plan);
    assert.ok(plan.buildings.length >= 4, `${pattern} founds a real place: ${JSON.stringify(plan.report)}`);
    assert.equal(plan.settlements.length, 1);
    assert.deepEqual(plan.settlements[0].buildings, plan.buildings.map(building => building.id));
    for (const building of plan.buildings) {
      assert.ok(BUILDING_ROLES[building.role], `${building.id} has a real role`);
      // A role must actually reach its construction family, not just be labelled.
      assert.ok(BUILDING_ROLES[building.role].families.includes(building.variationSeed % 4), `${building.role} uses its own construction family`);
      assert.ok(building.halfWidth > 0 && building.halfDepth > 0 && building.feather > 0);
      if (!building.street) continue;
      const street = plan.roads.find(road => road.id === building.street);
      assert.ok(street, `${building.id} names a real street`);
      const nearest = Math.min(...street.points.map(point => distance(point, [building.position[0], building.position[2]])));
      assert.ok(nearest <= building.halfDepth + street.width / 2 + 8, `${building.id} stands on its own frontage`);
      // Its entrance faces the street rather than the back garden.
      const door = [building.position[0] + Math.sin(building.rotation[1]) * building.halfDepth,
        building.position[2] + Math.cos(building.rotation[1]) * building.halfDepth];
      const doorGap = Math.min(...street.points.map(point => distance(point, door)));
      assert.ok(doorGap < nearest, `${building.id} faces its street`);
    }
  }
  assert.equal(plans.get('scattered').roads.length, 0, 'a scattered hamlet has no streets');
  assert.ok(plans.get('street').roads.length === 1, 'a street village is one road');
  assert.ok(plans.get('grid').roads.length >= 2, 'a grid town adds cross streets');
  const positions = pattern => JSON.stringify(plans.get(pattern).buildings.map(building => building.position.map(value => value.toFixed(2))));
  assert.equal(new Set(SETTLEMENT_PATTERNS.map(positions)).size, SETTLEMENT_PATTERNS.length, 'the plan changes where buildings stand');
});

test('a bigger world holds more of a bigger town, and every extent stays in bounds', () => {
  const counts = [];
  for (const extent of WORLD_EXTENTS) {
    const layout = layoutFor(`extent-${extent}`, { extent, houseCount: 40, water: { riverCount: 2, tributaries: 2 },
      settlement: { count: 2, pattern: 'grid' } });
    const half = extent / 2;
    counts.push(layout.buildings.length);
    assert.equal(layout.extent, extent);
    for (const building of layout.buildings) {
      assert.ok(Math.abs(building.position[0]) < half && Math.abs(building.position[2]) < half, `building inside ${extent} m world`);
    }
    for (const road of layout.lanes) for (const [x, z] of road.points) {
      assert.ok(Math.abs(x) <= half && Math.abs(z) <= half, `road inside ${extent} m world`);
    }
    const grid = worldGrid({ extent });
    assert.ok(grid.step >= .5 && grid.step <= 1.35, `${extent} m keeps its terrain cells inside the supported range`);
    assert.ok(grid.vertices <= 385 ** 2, `${extent} m bounds the terrain grid it has to sample`);
    assert.equal(grid.vertices, (grid.resolution + 1) ** 2);
  }
  assert.ok(counts.at(-1) > counts[0], `a larger world fits more buildings: ${counts.join(', ')}`);
  assert.ok(layoutFor('extent-512').settlements.length === 2, 'two places fit once there is room for them');
});

test('the parameter table is the single source of defaults, validation and description', () => {
  const defaults = worldDefaultSettings();
  assert.deepEqual(WORLD_SETTINGS, { ...defaults, layout: { ...defaults.layout, mode: 'procedural' } });
  validateWorldSettings(defaults);
  for (const parameter of WORLD_PARAMETERS) {
    assert.ok(parameter.label && parameter.group && parameter.kind, `${parameter.path} is described`);
    assert.ok(['layout', 'field', 'scatter', 'look'].includes(parameter.stage), `${parameter.path} declares what it invalidates`);
    const sample = parameter.kind === 'enum' ? parameter.choices.at(-1) : parameter.kind === 'boolean' ? false
      : parameter.kind === 'color' ? '#123456' : parameter.min;
    const document = setWorldParameter(normalizeWorldDocument({}), parameter.path, sample);
    const stored = parameter.path.split('.').reduce((value, key) => value[key], document.settings);
    assert.equal(stored, sample);
    if (parameter.kind === 'color') assert.throws(() => setWorldParameter(document, parameter.path, 'green'), TypeError, parameter.path);
    if (parameter.kind === 'number' || parameter.kind === 'integer') {
      assert.throws(() => setWorldParameter(document, parameter.path, parameter.max + 1), RangeError, parameter.path);
      assert.throws(() => setWorldParameter(document, parameter.path, NaN), RangeError, parameter.path);
    }
    if (parameter.kind === 'enum') assert.throws(() => setWorldParameter(document, parameter.path, 'not-a-choice'), TypeError, parameter.path);
  }
  assert.throws(() => setWorldParameter(normalizeWorldDocument({}), 'terrain.nonsense', 1), TypeError);
  const described = describeWorldParameters('Banks');
  assert.ok(described.length >= 8 && described.every(parameter => parameter.group === 'Banks'));
  assert.ok(described.every(parameter => parameter.hint), 'every bank control explains itself');
});

test('a look change never moves the world, and a landform change always does', () => {
  const base = normalizeWorldDocument({});
  const relit = patchWorldSettings(base, { style: 'stylized', surfaceScale: 1.4, sky: 'off' });
  const options = settings => ({ seed: settings.seed, extent: settings.extent, footprint,
    geography: settings.geography, terrain: settings.terrain, water: settings.water,
    settlement: settings.settlement, ...settings.layout });
  assert.deepEqual(createWorldLayout(options(relit.settings)), createWorldLayout(options(base.settings)),
    'appearance controls cannot reroll the layout');
  const reshaped = patchWorldSettings(base, { terrain: { style: 'canyon' } });
  assert.notDeepEqual(createWorldLayout(options(reshaped.settings)).buildings.map(building => building.position),
    createWorldLayout(options(base.settings)).buildings.map(building => building.position));
  const denser = patchWorldSettings(base, { settlement: { plotFrontage: 12 } });
  const spread = patchWorldSettings(base, { settlement: { plotFrontage: 40 } });
  // Mean pairwise spacing: the single closest pair is set by whichever two plots
  // share a street corner and barely moves with frontage (16.4 vs 16.2 m on the
  // 09-14 hills), while the mean tracks it cleanly (37 -> 45 m for 12 -> 40).
  const spacing = document => {
    const buildings = createWorldLayout(options(document.settings)).buildings;
    const pairs = buildings.flatMap((a, i) => buildings.slice(i + 1).map(b =>
      distance([a.position[0], a.position[2]], [b.position[0], b.position[2]])));
    return pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
  };
  assert.ok(spacing(denser) < spacing(spread), 'plot frontage actually changes how close buildings stand');
});


test('the drawn grass field grows on the ground, never in the water, and takes its colour', async () => {
  const { prepareWorldPlan } = await import('../src/modules/world/worldPlan.js');
  const { grassRings, grassFieldCost, sampleGrassField } = await import('../src/modules/foliage/grassField.js');
  const plans = [];
  for (const extent of [128, 512]) {
    const plan = prepareWorldPlan(normalizeWorldDocument({ settings: { extent } }));
    plans.push(plan);
    // Grass is an ordinary Foliage population of the grass species; it draws a
    // sward instead of scattering, so it carries no placements of its own.
    const feature = plan.features.find(entry => entry.id === 'foliage/meadow');
    assert.ok(feature && feature.kind === 'foliage', `a ${extent} m world draws grass`);
    assert.equal(feature.props.species, 'grass');
    assert.equal(feature.props.drawnGrass, true);
    assert.deepEqual(feature.props.placements, [], 'a drawn sward stores no placements');
    const field = plan.grassField;
    assert.equal(field.data.length, field.size ** 2 * 4);
    assert.equal(field.extent, extent);
    assert.ok(field.ground?.length === field.data.length, 'the ground colour is packed alongside');

    // ⛔ NOT ONE BLADE IN THE WATER. The shader reads this field bilinearly, so
    // it is not enough for the wet texels to be empty: everything within a
    // texel of them has to be too, or a blade offshore picks up a dry
    // neighbour's density. Sampled the way the shader samples it.
    let wet = 0, dryLand = 0, tinted = 0;
    for (let i = 0; i < 20000; i++) {
      const half = extent / 2;
      const x = ((i * 2654435761 % 65536) / 65536 * 2 - 1) * (half - 1);
      const z = ((i * 40503 % 65536) / 65536 * 2 - 1) * (half - 1);
      const ground = plan.fields.sample(x, z);
      if (!ground) continue;
      const sampled = sampleGrassField(field, x, z);
      // ⛔ THE WATER IS WHERE IT IS DRAWN. `worldWaterSurface.js` masks the
      // surface to `shore < 0` (the lake/river outline), so ground below the
      // NEAREST body's level but outside its outline shows no water. This test
      // used to count that ground as wet, which is the rule that left 54 % of a
      // flat 09-14 meadow bare ("large green regions where grass does not grow").
      // Blades beside the water are still excluded by the packer's shore margin
      // and near-shore freeboard gate; the shader samples this field bilinearly,
      // so the check below reads it the same way.
      if (ground.shore < 0) {
        wet++;
        assert.equal(sampled.density, 0, `no grass under water at ${x.toFixed(1)},${z.toFixed(1)} (shore ${ground.shore.toFixed(2)} m)`);
      } else if (ground.shore > 8 && ground.rock < .1 && ground.slope < .3 && ground.forest < .2 && ground.path < .1) {
        dryLand++;
        if (sampled.density > .3) tinted++;
      }
      assert.ok(Math.abs(sampled.height - plan.heightAt(x, z)) < .8, 'grass sits on the ground it grows from');
    }
    assert.ok(wet > 200, 'the check actually reached open water');
    assert.ok(tinted > dryLand * .5, `open meadow is covered: ${tinted} of ${dryLand}`);
    // The packed ground colour is a real palette, not a flat grey.
    const tints = new Set();
    for (let i = 0; i < field.ground.length; i += 4 * 97) tints.add(field.ground[i].toFixed(2));
    assert.ok(tints.size > 8, `the blade base has a landscape to match: ${tints.size} distinct tints`);
    // ⛔ THE TERRAIN'S OWN VERTEX COLOUR (procedural mode, no surface maps)
    // must take the sward's own base tone under deep cover too — this is
    // what the viewer actually sees at eye height between blades, not just
    // what the grass field packs for its own root blend.
    {
      const dryMargin = plan.grid.step * 1.5 + 2.65;
      let covered = -1;
      for (let index = 0; index < plan.colors.length / 3; index++) {
        const f = index * FIELD_STRIDE;
        if (plan.fieldCache[f + 1] > dryMargin && plan.fieldCache[f + 2] < .05
          && plan.fieldCache[f + 4] < .05 && plan.fieldCache[f + 5] < .05) { covered = index; break; }
      }
      assert.ok(covered >= 0, 'the world has deeply covered ground for the procedural terrain colour check too');
      const vertexColor = [0, 1, 2].map(channel => plan.colors[covered * 3 + channel]);
      const moisture = plan.fieldCache[covered * FIELD_STRIDE + 3];
      const expected = expectedSwardTone(moisture, true, .65);
      assert.ok(hueClose(vertexColor, expected.toArray()),
        `the terrain's own vertex colour under deep cover is the sward's base tone: ${vertexColor.map(v => v.toFixed(3)).join(', ')} vs ${expected.toArray().map(v => v.toFixed(3)).join(', ')}`);
    }
    // ⛔ AND IT HAS TO BE WHAT THE GROUND ACTUALLY RENDERS — but "renders" now
    // means the SWARD'S OWN base colour where it covers the ground, not a
    // darkened copy of the terrain's own palette: a viewer sees a carpet, and
    // a carpet's edge has to be a colour match with what stands on it, not a
    // shadow over whatever was there before. `expectedSwardTone` mirrors
    // `makeGroundPalette`/`paintGroundVertex` exactly (`worldPlanData.js`).
    const average = { grass: [.4, .6, .2], soil: [.7, .3, .1], rock: [.2, .2, .8] };
    const maps = Object.fromEntries(Object.entries(average).map(([role, value]) =>
      [role, { average: value, size: [2, 2], albedo: null, height: null }]));
    const textured = prepareWorldPlan(normalizeWorldDocument({ settings: { extent } }),
      { detailMaps: maps, roleMaterials: { ground: new THREE.MeshBasicNodeMaterial() } });
    // Deep cover only — the margin the field itself dilates around the water
    // (`grid.step * 1.5 + 2.65`) plus clean of path/rock/forest — so the
    // sward's own coverage term saturates and the whole cell converges on
    // exactly the sward tone rather than a partial blend toward it.
    const dryMargin = textured.grid.step * 1.5 + 2.65;
    const meadow = (() => {
      for (let index = 0; index < textured.grassField.size ** 2; index++) {
        const f = index * FIELD_STRIDE;
        if (textured.fieldCache[f + 1] > dryMargin && textured.fieldCache[f + 2] < .05
          && textured.fieldCache[f + 4] < .05 && textured.fieldCache[f + 5] < .05) return index;
      }
      return -1;
    })();
    assert.ok(meadow >= 0, 'the world has deeply covered, unshaded, unstony, unpaved ground');
    const tint = [0, 1, 2].map(channel => textured.grassField.ground[meadow * 4 + channel]);
    // `grassField.ground`'s pixel grid is baked 1:1 onto the terrain's own
    // vertex grid (`worldPlanData.js` packs it at `resolution + 1`), so the
    // same index reads this cell's own moisture straight out of `fieldCache`.
    const moisture = textured.fieldCache[meadow * FIELD_STRIDE + 3];
    const expected = expectedSwardTone(moisture, true, .65);
    assert.ok(hueClose(tint, expected.toArray()), `unworn ground converges on the sward's own base colour, not the terrain's: ${tint.map(v => v.toFixed(3)).join(', ')} vs ${expected.toArray().map(v => v.toFixed(3)).join(', ')}`);
    textured.dispose();
  }
  // Cost is the blade budget, not the size of the world it covers.
  const costs = plans.map(plan => {
    const props = plan.features.find(entry => entry.id === 'foliage/meadow').props;
    return grassFieldCost(grassRings({ near: Math.max(8, props.grassDistance * .2), far: props.grassDistance, blades: props.blades }));
  });
  assert.deepEqual(costs[0], costs[1], 'a sixteen-times-larger world draws exactly the same grass');
  assert.equal(costs[0].draws, 3);
  // And the scatter stands down: the short and long sward are the field's job.
  const scattered = prepareWorldPlan(normalizeWorldDocument({ settings: { grass: { enabled: false } } }));
  const layers = plan => plan.ecology.groups.filter(group => group.props.species === 'grass').map(group => group.id);
  assert.deepEqual(layers(plans[0]), ['bank-rushes'], 'only the reeds are still worth an individual plant');
  assert.ok(layers(scattered).length > 3, 'and they all come back when the field is off');
  assert.ok(scattered.ecology.counts.ground > plans[0].ecology.counts.ground * 10,
    `the scatter really stands down: ${plans[0].ecology.counts.ground} vs ${scattered.ecology.counts.ground}`);
  for (const plan of [...plans, scattered]) plan.dispose();
});
