import test from 'node:test';
import assert from 'node:assert/strict';
import { createLandscapeNoise, createValleyFields } from '../src/engine/world/landscapeFields.js';
import { createTerrainShape } from '../src/engine/world/terrainShape.js';

// `naturalWeight` (P1-T-EROSION, 09-13): 1 on raw relief, fading to 0 on a
// commanded-flat bank/road/pad — added so `worldPlanData.js` can gate its
// erosion correction without disturbing ground World has already flattened.
const keys = ['height', 'shore', 'waterLevel', 'depth', 'moisture', 'forest', 'rock', 'path', 'slope', 'naturalWeight'];
const fields = createValleyFields();

function terrainGrid(factory, step = 0.5) {
  const n = Math.round(factory.extent / step), half = factory.extent / 2, heights = new Float32Array((n + 1) ** 2);
  for (let row = 0; row <= n; row++) for (let col = 0; col <= n; col++) heights[row * (n + 1) + col] = factory.sampleHeight(-half + col * step, -half + row * step);
  return (x, z) => {
    const gx = (x + half) / step, gz = (z + half) / step;
    const col = Math.min(n - 1, Math.floor(gx)), row = Math.min(n - 1, Math.floor(gz)), tx = gx - col, tz = gz - row;
    const a = heights[row * (n + 1) + col], b = heights[row * (n + 1) + col + 1];
    const c = heights[(row + 1) * (n + 1) + col], d = heights[(row + 1) * (n + 1) + col + 1];
    // Both possible cell diagonals are covered; neither can hide a raised bank.
    return [
      tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz),
      tx >= tz ? a + (b - a) * tx + (d - b) * tz : a + (d - c) * tx + (c - a) * tz,
    ];
  };
}

// Negative control for the visible smooth wall: the former narrow distance
// blend, evaluated on the same current water footprint and seeded landforms.
// Samples below stay west of the cottage pad, so no pad adapter is needed.
function formerBankHeight(factory) {
  const { seed, extent, relief, rockiness, shoreWidth, terrainStep, terrain } = factory.settings;
  // The hills term is the configured terrain shape, sampled independently of the
  // field implementation; only the discarded bank *blend* is reproduced here.
  const shape = createTerrainShape({ seed, extent, terrain, relief, ridges: null });
  const noise = createLandscapeNoise(seed), clamp = value => Math.max(0, Math.min(1, value));
  const smooth = (lo, hi, value) => { const t = clamp((value - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
  return (x, z) => {
    const field = factory.sample(x, z), macro = shape.sample(x, z);
    // Mirrors the field: the study outcrop lift only ever applied to the old analytic landform.
    const hills = macro.height + (shape.landscape ? 0 : macro.outcrop * rockiness * 2.5);
    const bank = field.waterLevel + field.shore * (.30 + noise(x * .083 + 51.3, z * .083 - 8.2) * .095) / shoreWidth - .045 - terrainStep * .14 / shoreWidth;
    const blend = smooth(2 * shoreWidth, Math.min(9.5, 10 * shoreWidth), field.shore);
    return bank + (hills - bank) * blend;
  };
}

test('shared seeded fields are deterministic, detached and explicit about coverage', () => {
  const again = createValleyFields(), changed = createValleyFields({ seed: 895 });
  assert.deepEqual(fields.recipe, again.recipe);
  assert.notDeepEqual(fields.recipe.lakes[0].points, changed.recipe.lakes[0].points);
  for (const [x, z] of [[-40, 12], [-12, 8], [45, 30], [22, 6], [0, -32], [38, -32]]) {
    assert.deepEqual(fields.sample(x, z), again.sample(x, z));
    assert.equal(fields.sampleHeight(x, z), fields.sample(x, z).height);
  }
  assert.notEqual(fields.sampleHeight(-41, 27), changed.sampleHeight(-41, 27));
  const before = again.sample(-12, 8), waterBefore = again.domain.sample(-12, 8);
  again.recipe.lakes[0].points[0][0] = 1000;
  again.recipe.lakes[0].level = 100;
  again.recipe.rivers[0].points[0][1] = 500;
  assert.deepEqual(again.sample(-12, 8), before);
  assert.deepEqual(again.domain.sample(-12, 8), waterBefore);
  assert.equal(fields.sample(64.1, 0), null);
  assert.equal(fields.sampleHeight(0, -65), null);
  assert(fields.sample(64, 64));
  const out = {};
  assert.equal(fields.sample(20, 20, out), out);
  assert.deepEqual(Object.keys(out), keys);
});

test('organic lake, retained pond ellipses and smooth river share one water recipe', () => {
  const lake = fields.recipe.lakes.find(body => body.id === 'lake');
  const radii = lake.points.map(([x, z]) => Math.hypot((x + 12) / 16, (z - 8) / 12));
  assert(Math.max(...radii) - Math.min(...radii) > 0.22, 'the main shoreline cannot remain a smooth ellipse');
  assert(lake.points.length >= 48, 'shore curvature has useful geometric resolution');
  const pond = fields.recipe.lakes.find(body => body.id === 'upland-pond');
  assert.equal(pond.level, 4);
  for (const [x, z] of pond.points) assert(Math.abs(Math.hypot((x - 38) / 4, (z + 32) / 3) - 1) < 1e-12);
  for (const extent of [96, 128, 256, 1024]) {
    const factory = createValleyFields({ extent }), points = factory.recipe.rivers[0].points;
    assert(points.length > 30 && points.length < 80);
    for (let i = 1; i < points.length; i++) {
      assert(points[i][2] > points[i - 1][2], 'river never folds back at a short downstream control interval');
      assert(points[i][1] <= points[i - 1][1], 'river surface stays downhill or flat');
      if (points[i][2] >= -18) assert.equal(points[i][1], 0, 'every mouth reach is flat at the lake level');
      if (points[i][2] < -18) {
        const query = factory.domain.sample(points[i][0], points[i][2]);
        assert.equal(query.id, 'river');
        assert(Math.abs(query.height - points[i][1]) < 1e-6);
        assert(Math.abs(Math.hypot(...query.flow) - 1) < 1e-9);
        assert(query.flow[1] > 0);
      }
    }
    assert.equal(factory.domain.sample(-10, 2).height, 0);
  }
});

test('signed shore, levels, depth and ecology agree with actual water membership', () => {
  const out = {};
  let wet = 0, dry = 0;
  for (let z = -63.875; z < 64; z += 0.75) for (let x = -63.875; x < 64; x += 0.75) {
    const sample = fields.sample(x, z, out), query = fields.domain.sample(x, z);
    for (const key of keys) assert(Number.isFinite(sample[key]), `${key} must be finite`);
    for (const key of ['moisture', 'forest', 'rock', 'path']) assert(sample[key] >= 0 && sample[key] <= 1);
    assert(sample.slope >= 0);
    if (query) {
      wet++;
      assert(sample.shore <= 1e-7);
      assert(Math.abs(sample.waterLevel - query.height) < 1e-9);
      assert(Math.abs(-sample.shore - query.shoreDistance) < 1e-6);
      assert(sample.height < query.height);
      assert(Math.abs(sample.depth - (query.height - sample.height)) < 1e-12);
      assert.equal(sample.moisture, 1);
      assert.equal(sample.forest, 0);
      assert.equal(sample.path, 0);
    } else {
      dry++;
      assert(sample.shore > 0);
      assert.equal(sample.depth, 0);
    }
  }
  assert(wet > 1500 && dry > 15000);
});

test('all wet texels stay above the real 0.5 m terrain triangles, including high ponds and organic edges', () => {
  for (const options of [{}, { seed: 12 }, { seed: 73, riverWidth: 8, shoreWidth: 0.65, relief: 2.5, rockiness: 2 }]) {
    const factory = createValleyFields(options), interpolate = terrainGrid(factory), out = {};
    let wetCount = 0, shorelineCount = 0, pondCount = 0, oldCircularFailure = 0;
    for (let row = 0; row < 512; row++) for (let col = 0; col < 512; col++) {
      const x = -64 + (col + 0.5) * 0.25, z = -64 + (row + 0.5) * 0.25;
      const query = factory.domain.sample(x, z);
      if (!query) continue;
      wetCount++;
      const value = factory.sample(x, z, out);
      for (const y of interpolate(x, z)) assert(y <= query.height, `${query.id} terrain breaks water at ${x},${z}: ${y}>${query.height}`);
      if (query.shoreDistance < 0.5) shorelineCount++;
      if (query.id === 'upland-pond') {
        pondCount++;
        const oldCircle = 4 + Math.max(-2, Math.min(2.5, (Math.hypot(x - 38, z + 32) - 3.5) * 0.34));
        if (oldCircle > query.height + 0.025) oldCircularFailure++;
      }
      assert(value.depth > 0);
    }
    assert(wetCount > 15000 && shorelineCount > 1000 && pondCount > 500);
    assert(oldCircularFailure > 20, 'the original round terrain carve must fail the retained elliptical water footprint');
  }
});

test('analytic noise and terrain slopes agree with independent finite differences', () => {
  const noise = createLandscapeNoise(894), out = new Float64Array(3), epsilon = 1e-4;
  for (const [x, z] of [[-0.27, 0.71], [3.29, -8.13], [28.27, 52.49]]) {
    noise.gradient(x, z, out);
    assert(Math.abs(out[1] - (noise(x + epsilon, z) - noise(x - epsilon, z)) / (2 * epsilon)) < 1e-6);
    assert(Math.abs(out[2] - (noise(x, z + epsilon) - noise(x, z - epsilon)) / (2 * epsilon)) < 1e-6);
  }
  for (const [x, z] of [[-41.31, 27.48], [48.29, 41.78], [-12.27, 8.61], [35.21, -30.31], [-28.21, 8.32], [32.34, 4.25], [4.82, -30.31]]) {
    const dx = (fields.sampleHeight(x + epsilon, z) - fields.sampleHeight(x - epsilon, z)) / (2 * epsilon);
    const dz = (fields.sampleHeight(x, z + epsilon) - fields.sampleHeight(x, z - epsilon)) / (2 * epsilon);
    assert(Math.abs(fields.sample(x, z).slope - Math.hypot(dx, dz)) < 1e-5, `height-gradient mismatch at ${x},${z}`);
  }
});

test('dry lake banks have a broad walkable transition instead of the former steep bulging ring', () => {
  const scan = (factory, heightAt) => {
    const slopes = [], bench = [];
    let maxHeight = -Infinity;
    for (let z = -10; z <= 27; z += .5) for (let x = -44; x <= 4; x += .5) {
      const value = factory.sample(x, z);
      if (value.waterLevel !== 0 || value.shore < 2 || value.shore > 12) continue;
      // Measure actual elevation over half a metre; a cosmetic slope-mask
      // change cannot make the old terrain wall satisfy this test.
      const dx = (heightAt(x + .25, z) - heightAt(x - .25, z)) * 2;
      const dz = (heightAt(x, z + .25) - heightAt(x, z - .25)) * 2;
      const slope = Math.hypot(dx, dz);
      slopes.push(slope);
      if (value.shore < 5) bench.push(slope);
      maxHeight = Math.max(maxHeight, heightAt(x, z));
    }
    slopes.sort((a, b) => a - b); bench.sort((a, b) => a - b);
    return { count: slopes.length, maximum: slopes.at(-1), p90: slopes[Math.floor(slopes.length * .9)], p99: slopes[Math.floor(slopes.length * .99)],
      bench90: bench[Math.floor(bench.length * .9)], maxHeight };
  };
  for (const seed of [894, 12, 73]) {
    const factory = createValleyFields({ seed }), actual = scan(factory, factory.sampleHeight);
    assert(actual.count > 2500, 'check the full dry shore band, not one favorable camera point');
    // p99, not the single maximum: the 09-14 landscape puts rocky knolls on
    // some shores (seed 73: one 0.96 sample on rock .68, p99 .69).
    assert(actual.p99 < .75 && actual.p90 < .6, `seed ${seed} retains a steep wall: ${JSON.stringify(actual)}`);
    assert(actual.bench90 < .25, 'the shoreline contains a substantial shallow floodplain before the shoulder');
    assert(actual.maxHeight < 4.5, 'a tall hidden bank cannot survive by flattening only its slope field');
    // The control must fail the exact thresholds asserted above, not a
    // separately tuned pair that a gentler terrain recipe can drift under.
    const old = scan(factory, formerBankHeight(factory));
    assert(old.p99 >= .75 || old.p90 >= .6, `restoring the old bank blend fails the same slope gate: ${JSON.stringify(old)}`);
    assert(old.maxHeight >= 4.5, 'the old blend also fails the bank height gate');
  }
});

test('bank width shapes the dry floodplain while shoulder gradients and distant ridges remain coherent', () => {
  const narrow = createValleyFields({ shoreWidth: .65 }), broad = createValleyFields({ shoreWidth: 1.8 });
  for (const z of [4, 8, 12]) for (let x = -34; x >= -41; x--) {
    assert(broad.sampleHeight(x, z) < narrow.sampleHeight(x, z), 'wider banks provide more horizontal room before rising');
  }
  const original = formerBankHeight(fields);
  for (const [x, z] of [[-58, 54], [-62, 62], [58, 54]]) {
    assert(fields.sample(x, z).shore > 30);
    assert(Math.abs(fields.sampleHeight(x, z) - original(x, z)) < 1e-10, 'outer ridges keep their original relief after the shoulder joins them');
  }
  const epsilon = 1e-4;
  for (const options of [{}, { seed: 12, shoreWidth: 1.8 }, { seed: 73, relief: 2.5, rockiness: 2, shoreWidth: .65 }]) {
    const factory = createValleyFields(options);
    let checked = 0;
    for (let z = -9.73; z < 35; z += 2.71) for (let x = -59.31; x < -20; x += 1.89) {
      const value = factory.sample(x, z);
      if (value.shore < 1 || value.shore > 30) continue;
      const dx = (factory.sampleHeight(x + epsilon, z) - factory.sampleHeight(x - epsilon, z)) / (2 * epsilon);
      const dz = (factory.sampleHeight(x, z + epsilon) - factory.sampleHeight(x, z - epsilon)) / (2 * epsilon);
      assert(Math.abs(value.slope - Math.hypot(dx, dz)) < 1e-5, `shoulder derivative mismatch at ${x},${z}`);
      checked++;
    }
    assert(checked > 200, 'exercise apron, shoulder and ridge-join derivatives under each recipe');
  }
});

test('cottage, paths, forest clearings and outcrops use coherent exclusion and terrain fields', () => {
  for (const [x, z] of [[22, 6], [16, 0], [29, 15]]) {
    const value = fields.sample(x, z);
    assert.equal(value.height, 2.2);
    assert.equal(value.slope, 0);
    assert.equal(value.forest, 0);
    assert.equal(value.rock, 0);
  }
  for (const [x, z] of fields.recipe.path.points) {
    const value = fields.sample(x, z);
    assert(value.path > 0.95 && value.shore > 0);
    assert(value.forest < 0.02);
  }
  let forest = 0, clearing = 0, outcrop = 0, gentle = 0, minHeight = Infinity, maxHeight = -Infinity;
  for (let z = -60; z <= 60; z += 2) for (let x = -60; x <= 60; x += 2) {
    const v = fields.sample(x, z);
    minHeight = Math.min(minHeight, v.height); maxHeight = Math.max(maxHeight, v.height);
    if (v.forest > 0.65) forest++;
    if (v.shore > 5 && v.forest < 0.15) clearing++;
    if (v.rock > 0.75 && v.slope > 0.6) outcrop++;
    if (v.rock < 0.1 && v.slope < 0.3 && v.shore > 4) gentle++;
  }
  // Steep rock is the exception on the World's gentle default hills (11 cells at
  // 2 m in 09-14 receipts, against 1635 gentle ones), not a 50-cell staple.
  assert(forest > 300 && clearing > 300 && outcrop > 5 && gentle > 200);
  // The World opens on gentle hills (height .7) since 09-14: ~10 m of relief at 128 m.
  assert(maxHeight - minHeight > 8, 'landscape includes substantial landforms, not just surface grain');
  const noForest = createValleyFields({ forestCover: 0 });
  assert.deepEqual(noForest.recipe, fields.recipe);
  for (const [x, z] of [[-40, 12], [45, 30], [0, -32]]) {
    assert.equal(noForest.sample(x, z).forest, 0);
    assert.equal(noForest.sampleHeight(x, z), fields.sampleHeight(x, z));
  }
  assert.equal(createValleyFields({ rockiness: 0 }).sample(-40, 12).rock, 0);
});

test('configuration rejects invalid/unbounded fields and keeps alternate extents finite', () => {
  for (const options of [{ seed: NaN }, { seed: -1 }, { extent: 0 }, { extent: 4096 }, { relief: Infinity }, { riverWidth: 0 }, { shoreWidth: 0 }, { forestCover: 2 }, { rockiness: -1 }, { terrainStep: 10 }]) {
    assert.throws(() => createValleyFields(options), RangeError);
  }
  assert.throws(() => fields.sample(Infinity, 0), RangeError);
  assert.throws(() => fields.sampleHeight(0, NaN), RangeError);
  for (const options of [{ extent: 96, relief: 0, seed: 1 }, { extent: 1024, relief: 2.5, seed: 7 }]) {
    const factory = createValleyFields(options);
    for (const [x, z] of [[0, 0], [factory.extent / 2, factory.extent / 2], [-factory.extent / 2, -factory.extent / 2]]) {
      for (const value of Object.values(factory.sample(x, z))) assert(Number.isFinite(value));
    }
  }
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ⛔ P1-T C1 AUDIT (2026-09-13): `waterAt` picked whichever water body was
// literally closest and used ITS level/slope outright. Two basins can be
// equally close to a dry point (their shared medial line) — a lake at level 0
// a metre from a pond at level 3-4 produced a real step in the ground exactly
// there, unrelated to shore distance (which stayed smooth). This is the exact
// point (found by a random-line curvature sweep) that used to jump about 2 m
// over a 2 cm step: `waterLevel` flips from the forest pond's 3 to the lake's
// 0 while `shore` barely moves. Now the level/slope payload is a softmin
// blend (`WATER_BODY_BLEND`) across every nearby body, not just the winner.
test('two water bodies at different levels no longer step the ground where their basins meet', () => {
  const x = -41.40732390764545, z0 = -14.195170624;
  // The old code jumped ~2m over a 2cm step right here (waterLevel flipping
  // 3 -> 0 while shore barely moved); walk finely across it and require every
  // step to be one a smooth few-metre-wide transition could actually produce.
  let maxStep = 0, maxCurvature = 0, previous = null, previousPrevious = null;
  const step = 0.02;
  for (let dz = -0.6; dz <= 0.6; dz += step) {
    const h = fields.sampleHeight(x, z0 + dz);
    if (previous !== null) maxStep = Math.max(maxStep, Math.abs(h - previous));
    if (previous !== null && previousPrevious !== null) {
      maxCurvature = Math.max(maxCurvature, Math.abs(h - 2 * previous + previousPrevious) / (step * step));
    }
    previousPrevious = previous; previous = h;
  }
  // WATER_BODY_BLEND is kept narrow (0.5m) rather than the wider width a pure
  // "smooth this crease" goal would want, because a wide blend also nudges
  // rock/slope siting far along a body pair's whole medial bisector — well
  // past where either body is actually close — which moved unrelated rock
  // outcrop siting (see world-spires.test.mjs) under its slope threshold.
  // Narrower blend keeps the fix local to the actual tie at the cost of a
  // steeper (but still finite, still C1) transition right at the tie itself.
  assert(maxStep < 0.1, `no single 2cm step moves the ground by more than a narrow-but-smooth transition could: ${maxStep}`);
  assert(maxCurvature < 6, `curvature across the basin tie is bounded, not a spike: ${maxCurvature}`);
});

test('the water-level/shore blend has an exact analytic gradient across a basin tie', () => {
  const epsilon = 1e-4;
  // A grid straddling the same lake/pond medial line the previous test found,
  // plus a few more lines elsewhere near the lake's own boundary, so both the
  // per-body blend and its interaction with the bank/shoulder formulas above
  // it are exercised, not just one coordinate.
  const probes = [];
  for (let z = -20; z <= -8; z += 0.7) for (let x = -48; x <= -34; x += 0.9) probes.push([x, z]);
  let checked = 0;
  for (const [x, z] of probes) {
    const value = fields.sample(x, z);
    if (!value) continue;
    const dx = (fields.sampleHeight(x + epsilon, z) - fields.sampleHeight(x - epsilon, z)) / (2 * epsilon);
    const dz = (fields.sampleHeight(x, z + epsilon) - fields.sampleHeight(x, z - epsilon)) / (2 * epsilon);
    assert(Math.abs(value.slope - Math.hypot(dx, dz)) < 1e-4, `analytic slope mismatch at ${x},${z}: ${value.slope} vs ${Math.hypot(dx, dz)}`);
    checked++;
  }
  assert(checked > 200, 'the basin-tie region and its surroundings are actually exercised');
});

// The full composed field (banks, road corridors, building pads, ridges,
// escarpments on top of the landform) walked along 200 random straight lines
// across the 128 m and 256 m worlds at a 0.25 m step. `0.6 m/m^2` is loose
// enough for the field's own legitimate texture (bank/shoulder rounding,
// ridge and escarpment crests already covered by their own tests) but tight
// enough to catch a real fold or hard clamp. Two known, separate residuals
// this does not chase down, both bounded rather than silently excluded:
// (1) a lake or river boundary is a piecewise polygon/segment chain, and
// "nearest point on a polygon" has its own small curvature spikes along the
// shape's internal medial skeleton — a distinct, pre-existing property of
// that distance-field representation, not a linear falloff/abs/min/max blend
// on a landform or feature weight (kept underwater, `shore < 0`, separately
// bounded); (2) the softmin blend where two water bodies of different level
// are equidistant is intentionally narrow (see the basin-tie test above) so
// it doesn't reach into unrelated dry siting far along a body pair's medial
// line, which makes the transition right at a true tie steeper, not wider.
test('the composed landscape has no first-derivative discontinuities outside underwater polygon quantization', () => {
  for (const extent of [128, 256]) {
    const composed = createValleyFields({ extent });
    const random = mulberry32(extent * 7919 + 17), half = extent / 2, step = 0.25;
    let maxCurvatureDry = 0, maxCurvatureWet = 0, checkedDry = 0;
    for (let line = 0; line < 200; line++) {
      const ax = (random() * 2 - 1) * half, az = (random() * 2 - 1) * half;
      const angle = random() * Math.PI * 2, dirx = Math.cos(angle), dirz = Math.sin(angle);
      let previousHeight = null, previousPreviousHeight = null, previousDry = false, previousPreviousDry = false;
      for (let t = -half * 1.4; t <= half * 1.4; t += step) {
        const x = ax + dirx * t, z = az + dirz * t;
        if (Math.abs(x) > half || Math.abs(z) > half) { previousHeight = null; previousPreviousHeight = null; continue; }
        const sample = composed.sample(x, z), dry = sample.shore >= 0;
        if (previousHeight !== null && previousPreviousHeight !== null) {
          const curvature = Math.abs(sample.height - 2 * previousHeight + previousPreviousHeight) / (step * step);
          if (dry && previousDry && previousPreviousDry) { maxCurvatureDry = Math.max(maxCurvatureDry, curvature); checkedDry++; }
          else maxCurvatureWet = Math.max(maxCurvatureWet, curvature);
        }
        previousPreviousHeight = previousHeight; previousHeight = sample.height;
        previousPreviousDry = previousDry; previousDry = dry;
      }
    }
    assert(checkedDry > 20000, `enough dry-land samples to be meaningful (${checkedDry})`);
    // The 09-14 landscape carries benches and knolls; banks meeting them round a
    // little tighter than against the old smooth valley (measured 6.3 at 256 m).
    assert(maxCurvatureDry < 7, `dry-land curvature is bounded (${maxCurvatureDry})`);
    assert(maxCurvatureWet < 6, `even across a wet/underwater polygon boundary, curvature is finite (${maxCurvatureWet})`);
  }
});
