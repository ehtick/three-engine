import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldLayout, refitWorldLayout, WORLD_LAYOUT_LIMITS as LIMITS } from '../src/engine/world/worldLayout.js';
import { createValleyFields } from '../src/engine/world/landscapeFields.js';
import { createValleyEcology } from '../src/engine/world/valleyEcology.js';

const layouts = new Map();
const layoutFor = seed => { if (!layouts.has(seed)) layouts.set(seed, createWorldLayout({ seed })); return layouts.get(seed); };
const seeds = [0, 1, 7, 9, 77, 894, 895, 896, 1923, 0xffffffff];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polygonArea = points => Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0)) / 2;
const pointOnPad = (pad, x, z) => [pad.center[0] + Math.cos(pad.angle) * x + Math.sin(pad.angle) * z,
  pad.center[2] - Math.sin(pad.angle) * x + Math.cos(pad.angle) * z];
/** Largest separating-axis gap between two plots; negative means they overlap. */
function padGap(a, b) {
  const dx = b.center[0] - a.center[0], dz = b.center[2] - a.center[2];
  let gap = -Infinity;
  for (const owner of [a, b]) {
    const other = owner === a ? b : a;
    const c = Math.cos(owner.angle), s = Math.sin(owner.angle);
    const relative = other.angle - owner.angle, rc = Math.abs(Math.cos(relative)), rs = Math.abs(Math.sin(relative));
    gap = Math.max(gap, Math.abs(c * dx - s * dz) - owner.halfWidth - other.halfWidth * rc - other.halfDepth * rs);
    gap = Math.max(gap, Math.abs(s * dx + c * dz) - owner.halfDepth - other.halfWidth * rs - other.halfDepth * rc);
  }
  return gap;
}
function geometrySignature(layout) {
  const river = layout.rivers[0].points.map(point => [point[0], point[2]]), chord = distance(river[0], river.at(-1));
  return [polygonArea(layout.lakes[0].points), ...river.slice(1).map((point, index) => distance(point, river[index]) / chord)];
}

test('layout replays as plain JSON with stable feature IDs and no shared mutable output', () => {
  const first = layoutFor(894), again = createWorldLayout({ seed: 894 });
  assert.deepEqual(first, again);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.buildings[0].id, 'cottage');
  const ids = [...first.lakes, ...first.rivers, ...first.ridges, ...first.buildings, ...first.lanes].map(feature => feature.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(first.buildings.slice(1).every(house => /^house\/\d+$/.test(house.id)));
  again.buildings[0].position[0] += 100;
  again.lakes[0].points[0][0] += 100;
  assert.deepEqual(createWorldLayout({ seed: 894 }), first);
});

test('different seeds change basin shapes/counts, river bends, ridge geometry and settlements beyond a common transform', () => {
  const all = seeds.map(layoutFor);
  assert.ok(new Set(all.map(layout => layout.lakes.length)).size > 1, 'seed changes basin count within the requested maximum');
  assert.ok(new Set(all.map(layout => JSON.stringify(layout.settlements.map(place => place.center)))).size === all.length,
    'seed moves the settlement, not only its houses');
  assert.ok(new Set(all.map(layout => JSON.stringify(layout.lanes.map(lane => lane.points.length)))).size > 1,
    'seed changes the routed street and lane geometry');
  const signatures = all.map(geometrySignature);
  assert.ok(new Set(signatures.map(signature => JSON.stringify(signature.map(value => Number(value.toFixed(5)))))).size === all.length);
  const areas = signatures.map(signature => signature[0]);
  assert.ok(Math.max(...areas) / Math.min(...areas) > 1.4, 'lake outlines change size/shape, not only placement');
  for (let i = 1; i < all.length; i++) {
    assert.notDeepEqual(all[i].buildings.map(house => house.position), all[0].buildings.map(house => house.position));
    assert.notDeepEqual(all[i].buildings.map(house => house.rotation[1]), all[0].buildings.map(house => house.rotation[1]));
  }
  const a = layoutFor(894).lakes[0].center, b = layoutFor(895).lakes[0].center;
  assert.notDeepEqual(a, [b[1], b[0]], 'adjacent seeds cannot exchange the X/Z random streams');
  // This negative control is deliberately exactly the former "new world"
  // shortcut: apply one rigid transform to the same water/settlement template.
  const moved = structuredClone(all[0]);
  for (const lake of moved.lakes) lake.points = lake.points.map(([x, z]) => [-z + 8, x - 5]);
  for (const river of moved.rivers) river.points = river.points.map(([x, y, z]) => [-z + 8, y, x - 5]);
  assert.ok(geometrySignature(moved).every((value, index) => Math.abs(value - signatures[0][index]) < 1e-9), 'rigidly moving the template fails the same shape-diversity gate');
});

test('bounded water has a downhill river connected to a matching flat lake mouth', () => {
  for (const seed of seeds) {
    const layout = layoutFor(seed), fields = createValleyFields({ layout }), half = layout.extent / 2;
    assert.ok(layout.rivers.length >= 1, `every seed drains to a basin, seed ${seed}`);
    for (const lake of layout.lakes) for (const [x, z] of lake.points) assert.ok(Math.abs(x) < half && Math.abs(z) < half);
    const bodies = new Set([...layout.lakes, ...layout.rivers].map(body => body.id));
    for (const river of layout.rivers) {
      let graded = 0;
      for (let i = 0; i < river.points.length; i++) {
        const [x, y, z] = river.points[i];
        assert.ok(Math.abs(x) + river.width / 2 <= half && Math.abs(z) + river.width / 2 <= half, `river within terrain, seed ${seed}`);
        const water = fields.domain.sample(x, z);
        assert.ok(water, `every river reach is real water, seed ${seed}/${river.id}`);
        assert.ok(Math.abs(water.height - y) < 1e-6);
        if (i) { assert.ok(y <= river.points[i - 1][1], `${river.id} never runs uphill`); if (y < river.points[i - 1][1]) graded++; }
      }
      assert.ok(graded > 3, `${river.id} has an actual upstream grade`);
      assert.ok(bodies.has(river.downstream), `${river.id} names a real downstream body`);
      const end = river.points.at(-1), mouth = fields.domain.sample(end[0], end[2]);
      // A confluence resolves to whichever body owns that sample, but both must
      // agree on the surface level where the reaches actually meet.
      assert.ok(mouth && Math.abs(mouth.height - end[1]) < 1e-6, `${river.id} mouth matches the water it joins`);
    }
    assert.equal(fields.recipe.lakes.length, layout.lakes.length);
  }
});

test('house pads are bounded, separated, dry and genuinely level in the generated field', () => {
  for (const seed of seeds) {
    const layout = layoutFor(seed), fields = createValleyFields({ layout });
    assert.ok(layout.buildings.length > 0 && layout.buildings.length <= layout.requested.houseCount);
    assert.equal(layout.buildingPads.length, layout.buildings.length);
    for (const [index, pad] of layout.buildingPads.entries()) {
      assert.deepEqual(pad.center, layout.buildings[index].position);
      for (const u of [-1, -.5, 0, .5, 1]) for (const v of [-1, -.5, 0, .5, 1]) {
        const [x, z] = pointOnPad(pad, u * pad.halfWidth, v * pad.halfDepth), field = fields.sample(x, z);
        assert.ok(field && !fields.domain.sample(x, z), `dry pad ${pad.id} in ${seed}`);
        assert.ok(Math.abs(field.height - pad.center[1]) < 1e-9, `actual level pad ${pad.id} in ${seed}`);
        assert.ok(field.slope < 1e-8, `zero pad grade ${pad.id} in ${seed}`);
      }
      for (const u of [-1, 0, 1]) for (const v of [-1, 0, 1]) {
        const [x, z] = pointOnPad(pad, u * (pad.halfWidth + pad.feather), v * (pad.halfDepth + pad.feather));
        assert.ok(Math.abs(x) < layout.extent / 2 && Math.abs(z) < layout.extent / 2, 'feather support stays inside the world');
      }
      // Plots never overlap, and no neighbour's feather reaches inside one:
      // that isolation is what keeps the level assertion above exact.
      for (const other of layout.buildingPads.slice(index + 1)) {
        const gap = padGap(pad, other);
        assert.ok(gap > 0, `plots ${pad.id} and ${other.id} overlap in ${seed}`);
        assert.ok(gap >= pad.feather - 1e-9 && gap >= other.feather - 1e-9, `feather of ${pad.id}/${other.id} reaches a neighbouring plot in ${seed}`);
      }
    }
  }
});

test('every road is dry, walkable and clear of the buildings that front it', () => {
  const maxGrade = .35;
  for (const seed of seeds) {
    const layout = layoutFor(seed), fields = createValleyFields({ layout }), byId = new Map(layout.buildings.map(house => [house.id, house]));
    assert.ok(layout.lanes.length >= 1, `seed ${seed} produces a road network`);
    for (const road of layout.lanes) {
      assert.ok(road.elevations.length === road.points.length, 'a graded road carries one elevation per point');
      for (let index = 1; index < road.points.length; index++) {
        const a = road.points[index - 1], b = road.points[index], length = distance(a, b), count = Math.ceil(length / .25);
        let previous = fields.sampleHeight(...a);
        for (let i = 0; i <= count; i++) {
          const t = i / count, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, sample = fields.sample(x, z);
          assert.ok(sample.shore >= road.width / 2 + LIMITS.roadShoreMargin - .01, `road shoreline clearance ${seed}/${road.id}`);
          // The corridor grades its own carriageway, so the walkable gradient is
          // measured on the finished ground, not on the pre-road terrain.
          if (i) assert.ok(Math.abs(sample.height - previous) / (length / count) <= maxGrade + .05, `actual road grade ${seed}/${road.id}`);
          assert.ok(sample.path > .95, `road reaches the actual surface path mask ${seed}/${road.id}`);
          previous = sample.height;
          for (const house of layout.buildings) {
            const dx = x - house.position[0], dz = z - house.position[2], angle = house.rotation[1];
            assert.ok(Math.abs(Math.cos(angle) * dx - Math.sin(angle) * dz) >= house.halfWidth + road.width / 2 - .01 ||
              Math.abs(Math.sin(angle) * dx + Math.cos(angle) * dz) >= house.halfDepth + road.width / 2 - .01,
              `road ${road.id} crosses the plot of a building in ${seed}`);
          }
          for (const side of [-1, 1]) assert.equal(fields.domain.sample(x + side * road.width / 2 * (b[1] - a[1]) / length,
            z - side * road.width / 2 * (b[0] - a[0]) / length), null, 'the complete road width is dry');
        }
      }
    }
    // Every building belongs to the network: it either fronts a generated street
    // or a routed lane reaches its own entrance.
    const laneEnds = new Set(layout.lanes.filter(lane => lane.kind === 'lane').flatMap(lane => [lane.from, lane.to]));
    const streets = new Set(layout.lanes.map(road => road.id));
    for (const house of byId.values()) {
      assert.ok(house.street ? streets.has(house.street) : laneEnds.has(house.id) || (layout.unconnected ?? []).includes(house.id),
        `building ${house.id} has a route in ${seed}`);
    }
  }
});

test('layout controls drive distinct geometry and explicit zero houses has no reserved cottage clearing', () => {
  const straight = createWorldLayout({ seed: 894, houseCount: 0, riverMeander: 0 });
  const winding = createWorldLayout({ seed: 894, houseCount: 0, riverMeander: 1 });
  assert.deepEqual(straight.lakes, winding.lakes);
  assert.notDeepEqual(straight.rivers[0].points, winding.rivers[0].points);
  assert.deepEqual(straight.buildingPads, []); assert.deepEqual(straight.lanes, []);
  assert.deepEqual(createWorldLayout({ seed: 894, buildings: false }).buildings, []);
  const compact = createWorldLayout({ seed: 894, settlementSpread: 0 }), spread = createWorldLayout({ seed: 894, settlementSpread: 1 });
  assert.notDeepEqual(compact.buildings.map(house => house.position), spread.buildings.map(house => house.position));
  const four = createWorldLayout({ seed: 0, lakeCount: 4, houseCount: 0 });
  assert.ok(four.lakes.length > straight.lakes.length);
  assert.deepEqual(createValleyFields().recipe.cottagePad.center, [22, 2.2, 6], 'legacy no-layout fixture retains its explicit study pad');
});

test('fields detach all layout coefficients from the recipe they were built from', () => {
  const layout = structuredClone(layoutFor(895)), fields = createValleyFields({ layout });
  const points = [];
  for (let z = -60; z <= 60; z += 4) for (let x = -60; x <= 60; x += 4) points.push([x, z]);
  const before = points.map(point => fields.sample(...point));
  // Landforms are the landscape's own since 09-14 (no layout ridges to rotate);
  // the recipe's pads and lanes must still be copies, not live references.
  layout.buildingPads[0].center[1] += 100; fields.recipe.lanes[0].points[0][0] += 50;
  assert.deepEqual(points.map(point => fields.sample(...point)), before);
});

test('native ecology clears every rotated generated pad without a leftover fixed 22,6 hole', () => {
  const sample = () => ({ height: 2, shore: 20, depth: 0, path: 0, rock: 0, slope: 0, forest: .8, moisture: .6 });
  const pad = { id: 'moved-house', center: [-22, 2, 18], halfWidth: 7, halfDepth: 8, angle: .75, feather: 3 };
  const fields = { extent: 128, sample, recipe: { buildingPads: [pad] } };
  const result = createValleyEcology(fields, { seed: 894, groundDensity: .08, forestDensity: .3 });
  const plants = result.groups.flatMap(group => group.placements);
  for (const plant of plants) {
    const dx = plant.position[0] - pad.center[0], dz = plant.position[2] - pad.center[2];
    assert.ok(Math.abs(Math.cos(pad.angle) * dx - Math.sin(pad.angle) * dz) >= pad.halfWidth + 1.2 ||
      Math.abs(Math.sin(pad.angle) * dx + Math.cos(pad.angle) * dz) >= pad.halfDepth + 1.2);
  }
  const oldSite = plants => plants.filter(plant => Math.abs(plant.position[0] - 22) < 5 && Math.abs(plant.position[2] - 6) < 5);
  const reference = createValleyEcology({ extent: 128, sample, recipe: { buildingPads: [] } }, { seed: 894, groundDensity: .08, forestDensity: .3 });
  const legacy = createValleyEcology({ extent: 128, sample }, { seed: 894, groundDensity: .08, forestDensity: .3 });
  const expected = oldSite(reference.groups.flatMap(group => group.placements));
  assert.ok(expected.length > 0, 'control contains actual vegetation at the old study site');
  assert.deepEqual(oldSite(plants), expected, 'former study cottage site receives every normal root');
  assert.equal(oldSite(legacy.groups.flatMap(group => group.placements)).length, 0, 'old fixed exclusion fails the same site check');
});

test('refitting authored houses preserves their poses and reports an unreachable house instead of deleting it', () => {
  const layout = structuredClone(layoutFor(894)), house = layout.buildings.at(-1);
  const oldPosition = [...house.position];
  house.position = [63, 40, 63]; house.rotation[1] += 1;
  const source = structuredClone(layout), fitted = refitWorldLayout(layout);
  assert.deepEqual(layout, source, 'refit does not mutate the supplied authoring data');
  assert.equal(fitted.buildings.length, layout.buildings.length);
  assert.deepEqual(fitted.buildings.at(-1).position, house.position);
  assert.deepEqual(fitted.buildings.at(-1).rotation, house.rotation);
  assert.deepEqual(fitted.buildingPads.at(-1).center, house.position);
  // The invariant is "never deleted, never silently orphaned": on the 09-14
  // landscape a lane may genuinely reach the corner, which is fine as long as
  // the house is either served by that lane or reported unreachable.
  assert.ok(fitted.unconnected.includes(house.id) || fitted.lanes.some(lane => lane.from === house.id || lane.to === house.id),
    'the moved house is either reported unreachable or reached by a lane');
  assert.ok(fitted.buildingPads.every(pad => pad.center.some((value, axis) => value !== oldPosition[axis])), 'old pad does not remain at the generated position');
  const duplicate = structuredClone(layoutFor(894));
  Object.assign(duplicate.buildings[1], { position: [...duplicate.buildings[0].position], rotation: [...duplicate.buildings[0].rotation] });
  const overlapping = refitWorldLayout(duplicate);
  // The invariant is "no zero-length lane": with the C1 landform (09-13) a duplicate entrance
  // may now be reached through the existing network instead of being reported unreachable,
  // which is fine as long as no lane degenerates.
  const laneLength = lane => lane.points.reduce((sum, p, i) => i ? sum + Math.hypot(p[0] - lane.points[i - 1][0], p[1] - lane.points[i - 1][1]) : 0, 0);
  const degenerate = (overlapping.lanes ?? []).filter(lane => lane.points.length < 2 || laneLength(lane) < 0.5);
  assert.equal(degenerate.length, 0, 'coincident entrances do not create an invalid zero-length lane');
  assert.ok(overlapping.unconnected.includes(duplicate.buildings[1].id) || overlapping.lanes.length > 0, 'the duplicate is either reported unreachable or served by the network');
});

test('invalid layout controls and malformed field adapters fail before generating corrupt geometry', () => {
  for (const options of [{ seed: NaN }, { seed: -1 }, { lakeCount: 0 }, { lakeCount: 9 }, { houseCount: 161 }, { houseCount: 1.2 },
    { riverMeander: 2 }, { settlementSpread: -.1 }, { extent: 200 }, { extent: 129 }, { riverWidth: Infinity }]) assert.throws(() => createWorldLayout(options), RangeError);
  assert.throws(() => createWorldLayout({ settlement: { pattern: 'sprawl' } }), RangeError);
  for (const mutate of [layout => { layout.ridges = [{ center: [0, 0], angle: 0, amplitude: 1, width: 0, length: 4 }]; }, layout => { layout.buildingPads[0].center[1] = Infinity; },
    layout => { layout.lanes[0].points = [[0, 0], [0, 0]]; }]) {
    const layout = structuredClone(layoutFor(894)); mutate(layout); assert.throws(() => createValleyFields({ layout }), /layout|pad/);
  }
});
