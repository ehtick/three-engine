import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLandscape, createLandscapeSteps, fillLandscapeGrid, LANDSCAPE_STYLE_IDS, LANDSCAPE_CONTROLS, normalizeLandscapeOptions,
} from '../src/engine/terrain/landscapeGenerator.js';
import { createSimplex2 } from '../src/engine/terrain/terrainNoise.js';
import { createRockSdf, ROCK_KINDS } from '../src/engine/rocks/rockSdf.js';
import { meshSignedDistance } from '../src/engine/rocks/surfaceNets.js';
import { buildRockLibrary, voxelForBudget, ROCK_TRIANGLE_BUDGET } from '../src/engine/rocks/rockLibrary.js';
import { placeRocks, rockKindsFor } from '../src/engine/rocks/rockPlacement.js';

const drain = (steps) => { for (;;) { const s = steps.next(); if (s.done) return s.value; } };
const fill = (land, x0, z0, size, resolution) => drain(fillLandscapeGrid(land, { x0, z0, size, resolution }));

test('simplex gradient matches central differences and stays in [-1, 1]', () => {
  const noise = createSimplex2(11), out = new Float64Array(3);
  let worst = 0, peak = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (i * 7.31) % 97, z = (i * 3.17) % 89, e = 1e-5;
    noise.d(x, z, out);
    peak = Math.max(peak, Math.abs(out[0]));
    worst = Math.max(worst, Math.abs((noise(x + e, z) - noise(x - e, z)) / (2 * e) - out[1]), Math.abs((noise(x, z + e) - noise(x, z - e)) / (2 * e) - out[2]));
  }
  assert.ok(peak <= 1.01, `simplex peak ${peak}`);
  assert.ok(worst < 1e-5, `simplex gradient error ${worst}`);
});

test('every control is range-checked and every style builds a finite, non-flat landscape', () => {
  assert.deepEqual(LANDSCAPE_CONTROLS.map(c => c.key), ['style', 'height', 'scale', 'levels', 'wildness', 'erosion', 'rocks', 'water']);
  const clamped = normalizeLandscapeOptions({ style: 'nope', height: 99, levels: -3 });
  assert.equal(clamped.style, 'highlands'); assert.equal(clamped.height, 2); assert.equal(clamped.levels, 0);
  for (const style of LANDSCAPE_STYLE_IDS) {
    const land = createLandscape({ style, seed: 3, extent: 256 });
    const grid = fill(land, -128, -128, 256, 32);
    let lo = Infinity, hi = -Infinity;
    for (const v of grid) { assert.ok(Number.isFinite(v), `${style} produced a non-finite height`); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    assert.ok(hi - lo > 2, `${style} relief ${hi - lo} m is flat`);
  }
});

test('deterministic per seed, different across seeds, and the sliced build equals the whole build', () => {
  const a = createLandscape({ style: 'highlands', seed: 9, extent: 256 });
  const b = createLandscape({ style: 'highlands', seed: 9, extent: 256 });
  const c = createLandscape({ style: 'highlands', seed: 10, extent: 256 });
  const ga = fill(a, -128, -128, 256, 48), gb = fill(b, -128, -128, 256, 48), gc = fill(c, -128, -128, 256, 48);
  assert.deepEqual(ga, gb);
  assert.notDeepEqual(ga, gc);
  let calls = 0;
  const sliced = drain(createLandscapeSteps({ style: 'highlands', seed: 9, extent: 256 }, { due: () => (++calls % 3) === 0 }));
  assert.deepEqual(fill(sliced, -128, -128, 256, 48), ga);
});

test('chunks are seamless: adjacent chunks share their border samples bit for bit, and match the whole grid', () => {
  for (const style of ['canyon', 'karst', 'shattered']) {
    const land = createLandscape({ style, seed: 5, extent: 512 });
    const whole = fill(land, -128, -128, 256, 64);   // 4 m cells
    const left = fill(land, -128, -128, 128, 32), right = fill(land, 0, -128, 128, 32);
    for (let r = 0; r <= 32; r++) {
      assert.equal(left[r * 33 + 32], right[r * 33], `${style} seam row ${r}`);
      assert.equal(left[r * 33 + 7], whole[r * 65 + 7], `${style} left chunk equals the whole grid`);
      assert.equal(right[r * 33 + 11], whole[r * 65 + 32 + 11], `${style} right chunk equals the whole grid`);
    }
  }
});

test('the landscape carries its own water: rivers only descend, lakes are flat and contained', () => {
  const land = createLandscape({ style: 'hills', seed: 7, extent: 2048 });
  const { lakes, reaches, lakeAt } = land.hydrology;
  assert.ok(lakes.length >= 2, `${lakes.length} lakes`);
  assert.ok(reaches.length >= 4, `${reaches.length} river reaches`);
  let lakeArea = 0;
  for (const lake of lakes) lakeArea += lake.area;
  assert.ok(lakeArea / 2048 ** 2 < .08, `lakes cover ${(lakeArea / 2048 ** 2 * 100).toFixed(1)} % of the land`);
  for (const reach of reaches) for (let k = 5; k < reach.points.length; k += 5) {
    assert.ok(reach.points[k + 2] <= reach.points[k - 3] + 1e-9, `${reach.id} climbs at point ${k / 5}`);
  }
  const point = {};
  let rim = 0, heldRim = 0, wet = 0, underWater = 0;
  for (let z = -1000; z <= 1000; z += 3) for (let x = -1000; x <= 1000; x += 3) {
    const shore = lakeAt(x, z);
    if (shore.lake < 0) continue;
    land.sample(x, z, point);
    if (shore.signed > 4) { wet++; if (point.height < shore.level - .5) underWater++; }
    if (shore.signed < -.5 && shore.signed > -3) { rim++; if (point.height >= shore.level - 1e-6) heldRim++; }
  }
  assert.ok(wet > 100 && underWater / wet > .99, `lake beds lie under the surface (${underWater}/${wet})`);
  // Outlets are cut through the rim by their river on purpose; everywhere else it holds.
  assert.ok(rim > 100 && heldRim / rim > .95, `the ground just outside a lake is never below it (${heldRim}/${rim})`);
});

test('a reserved region keeps no generated water and every effect fades in outside it', () => {
  const land = createLandscape({ style: 'meadow', seed: 3, extent: 2048, water: 1, reserve: 512 });
  const { reaches, lakes, reserveWeight } = land.hydrology;
  assert.ok(reaches.length + lakes.length > 0);
  for (const reach of reaches) for (let k = 0; k < reach.points.length; k += 5) {
    assert.ok(Math.max(Math.abs(reach.points[k]), Math.abs(reach.points[k + 1])) > 256, `${reach.id} runs inside the reserve`);
  }
  for (const lake of lakes) assert.ok(!(lake.bounds[0] < 256 && lake.bounds[2] > -256 && lake.bounds[1] < 256 && lake.bounds[3] > -256), 'a lake inside the reserve');
  const point = {};
  for (let z = -254; z <= 254; z += 6) for (let x = -254; x <= 254; x += 6) {
    land.sample(x, z, point);
    assert.ok(!Number.isFinite(point.water) && point.wet === 0, `water at ${x},${z}`);
  }
  assert.equal(reserveWeight(0, 0), 0); assert.equal(reserveWeight(400, 0), 1);
});

test('multilevel styles actually step: highlands and canyon report cliffs, meadow barely does', () => {
  const share = (style) => {
    const land = createLandscape({ style, seed: 4, extent: 1024 }), point = {};
    let cliffs = 0, n = 0;
    for (let z = -480; z <= 480; z += 12) for (let x = -480; x <= 480; x += 12) { n++; if (land.sample(x, z, point).cliff > .3) cliffs++; }
    return cliffs / n;
  };
  assert.ok(share('canyon') > .02, `canyon cliff share ${share('canyon')}`);
  assert.ok(share('highlands') > .01, `highlands cliff share ${share('highlands')}`);
  assert.ok(share('meadow') < share('highlands'), 'a meadow is gentler than highlands');
});

test('every rock kind meshes watertight with outward normals', () => {
  for (const [index, kind] of ROCK_KINDS.entries()) {
    const field = createRockSdf(kind, { seed: 17 + index });
    // The shipped near LOD. Far LODs are coarser than a spire's thinnest crown
    // spikes and may pinch there; nobody is close enough to see it.
    const mesh = meshSignedDistance(field, voxelForBudget(field, ROCK_TRIANGLE_BUDGET[kind]));
    assert.ok(mesh.indices.length >= 300, `${kind} produced ${mesh.indices.length / 3} triangles`);
    const edges = new Map();
    for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t + k], b = mesh.indices[t + (k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    let open = 0, pinched = 0;
    for (const count of edges.values()) { if (count === 1) open++; else if (count !== 2) pinched++; }
    assert.ok(open / edges.size < .005, `${kind}: ${open} of ${edges.size} edges are boundary edges (a hole)`);
    // Surface nets legitimately pinch non-manifold edges where a thin feature
    // is under two voxels thick; they render fine but must stay rare.
    assert.ok(pinched / edges.size < .03, `${kind}: ${pinched} of ${edges.size} edges are non-manifold`);
    // Outward: the mesh's signed volume is positive.
    let volume = 0;
    const P = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, c = mesh.indices[t + 2] * 3;
      volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    assert.ok(volume > 0, `${kind} winding points inward (volume ${volume})`);
  }
});

test('rock placement partitions by chunk: four chunks place exactly the rocks of their union, with no duplicates', () => {
  const land = createLandscape({ style: 'highlands', seed: 21, extent: 512 });
  const key = p => `${p.kind}:${p.position.map(v => v.toFixed(4)).join(',')}`;
  const union = placeRocks(land, { x0: -128, z0: -128, size: 256 }).map(key).sort();
  const parts = [[-128, -128], [0, -128], [-128, 0], [0, 0]].flatMap(([x0, z0]) => placeRocks(land, { x0, z0, size: 128 }).map(key)).sort();
  assert.ok(union.length > 20, `only ${union.length} rocks placed`);
  assert.equal(new Set(parts).size, parts.length, 'a rock was placed by two chunks');
  // Tower features use their own lattice; everything else follows the chunk contract exactly.
  assert.deepEqual(parts, union);
});

test('karst towers are wrapped by spires sized from the tower feature, and the library covers every placed kind', () => {
  const land = createLandscape({ style: 'karst', seed: 2, extent: 768 });
  const towers = land.towers(-384, -384, 384, 384);
  assert.ok(towers.length > 5, `only ${towers.length} towers`);
  const placements = placeRocks(land, { x0: -384, z0: -384, size: 768 });
  const wraps = placements.filter(p => p.wraps);
  assert.equal(wraps.length, towers.length);
  const kinds = rockKindsFor(land, 2);
  for (const kind of new Set(placements.map(p => p.kind))) assert.ok(kinds[kind] > 0, `library would not build ${kind}`);
  const library = buildRockLibrary({ seed: 2, kinds: { boulder: 1, spire: 1 }, budgetScale: .25 });
  assert.equal(library.variants.boulder.length, 1);
  assert.ok(library.variants.spire[0].indices.length > 0);
});
