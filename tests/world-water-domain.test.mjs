import test from "node:test";
import assert from "node:assert/strict";
import { createWaterDomain, WATER_DOMAIN_DRY_HEIGHT } from "../src/modules/water/worldWaterDomain.js";

function square(id = "lake", x = 0, z = 0, level = 3, depth = 2) {
  return { id, points: [[x, z], [x + 10, z], [x + 10, z + 10], [x, z + 10]], level, depth };
}

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test("empty domains have no coverage and encode explicit finite dry texels", () => {
  const domain = createWaterDomain();
  assert.equal(domain.bounds, null);
  assert.equal(domain.sample(0, 0), null);
  const packed = domain.rasterize({ minX: -10, minZ: -20, maxX: 10, maxZ: 20, width: 2, height: 3 });
  assert.ok(packed instanceof Float32Array);
  assert.deepEqual([...packed], Array.from({ length: 6 }, () => [WATER_DOMAIN_DRY_HEIGHT, WATER_DOMAIN_DRY_HEIGHT, 0, 0]).flat());
  assert.ok(packed.every(Number.isFinite));
});

test("concave lake excludes its inlet notch, includes shore and reports authored depth", () => {
  const lake = { id: "concave", points: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]], level: 12, depth: 5 };
  const domain = createWaterDomain({ lakes: [lake] });
  assert.deepEqual(domain.bounds, { minX: 0, minZ: 0, maxX: 10, maxZ: 10 });
  assert.deepEqual(domain.sample(2, 7), { id: "concave", height: 12, depth: 5, flow: [0, 0], shoreDistance: 2 });
  assert.equal(domain.sample(7, 7), null, "a bounding rectangle or convex hull would wrongly flood the notch");
  assert.equal(domain.sample(4, 7).shoreDistance, 0);
  assert.equal(domain.sample(4.001, 7), null);
  assert.equal(domain.sample(10, 4).height, 12);
  assert.equal(domain.sample(-1, 3), null);
  const reversed = createWaterDomain({ lakes: [{ ...lake, points: [...lake.points].reverse() }] });
  const closed = createWaterDomain({ lakes: [{ ...lake, points: [...lake.points, lake.points[0]] }] });
  for (const [x, z] of [[2, 7], [7, 7], [4, 7], [10, 4]]) {
    assert.deepEqual(reversed.sample(x, z), domain.sample(x, z));
    assert.deepEqual(closed.sample(x, z), domain.sample(x, z));
  }
});

test("river follows downhill polyline elevations and world XZ direction, with round caps", () => {
  const domain = createWaterDomain({ rivers: [{ id: "stream", points: [[0, 12, 0], [10, 7, 0], [10, 3, 10]], width: 4, depth: 1.5 }] });
  assert.deepEqual(domain.bounds, { minX: -2, minZ: -2, maxX: 12, maxZ: 12 });
  assert.deepEqual(domain.sample(5, 1), { id: "stream", height: 9.5, depth: 1.5, flow: [1, 0], shoreDistance: 1 });
  assert.deepEqual(domain.sample(11, 5), { id: "stream", height: 5, depth: 1.5, flow: [0, 1], shoreDistance: 1 });
  assert.deepEqual(domain.sample(10, 0), { id: "stream", height: 7, depth: 1.5, flow: [1, 0], shoreDistance: 2 });
  assert.equal(domain.sample(5, 2).shoreDistance, 0);
  assert.equal(domain.sample(5, 2.001), null);
  assert.equal(domain.sample(-2, 0).height, 12);
  assert.equal(domain.sample(-2, 1), null, "caps are circular, not extended rectangles");
  assert.equal(domain.sample(10, 12).height, 3);
  const diagonal = createWaterDomain({ rivers: [{ id: "diagonal", points: [[0, 6, 0], [6, 2, 8]], width: 2, depth: 1 }] });
  const sample = diagonal.sample(3, 4);
  close(sample.height, 4); close(sample.flow[0], 0.6); close(sample.flow[1], 0.8);
});

test("flat lake mouths connect to graded reaches without endpoint or finite-width height cracks", () => {
  const lake = square("basin", 0, -5, 3, 2);
  const river = { id: "inlet", points: [[-20, 7, 0], [-5, 3, 0], [5, 3, 0]], width: 4, depth: 1 };
  const domain = createWaterDomain({ lakes: [lake], rivers: [river] });
  close(domain.sample(-12.5, 0).height, 5);
  close(domain.sample(-0.001, 0).height, 3);
  assert.equal(domain.sample(0, 0).id, "basin");
  close(domain.sample(0.001, 0).height, 3);
  assert.ok(domain.sample(0, 0).shoreDistance > 0, "the connected mouth is not a dry seam");
  assert.equal(domain.sample(5, 0).depth, 2, "the lake owns the sample inside its footprint");

  assert.throws(() => createWaterDomain({ lakes: [lake], rivers: [{ ...river, points: [[-20, 7, 0], [0, 3, 0]] }] }), /level mouth/,
    "an endpoint-only agreement conceals the capsule's mismatched mouth edges");
  assert.throws(() => createWaterDomain({ lakes: [lake], rivers: [{ ...river, points: [[-20, 2, 0], [5, 2, 0]] }] }), /level mouth/);
  assert.throws(() => createWaterDomain({ lakes: [lake], rivers: [{ ...river, points: [[-20, 7, 0], [20, 2, 0]] }] }), /level mouth/,
    "a through-going reach is checked even when both endpoints are outside the lake");
  assert.throws(() => createWaterDomain({ lakes: [lake], rivers: [{ ...river, points: [[-1, 4, -20], [-1, 4, 20]] }] }), /level mouth/,
    "a wide footprint can graze the lake even with an entirely exterior centerline");
});

test("body count exceeds the old two-slot limit and disconnected islands retain different levels", () => {
  const lakes = Array.from({ length: 6 }, (_, i) => square(`basin-${i}`, i * 20, 0, 5 + i, 1 + i));
  const domain = createWaterDomain({ lakes });
  for (let i = 0; i < lakes.length; i++) {
    const sample = domain.sample(i * 20 + 5, 5);
    assert.equal(sample.id, `basin-${i}`);
    assert.equal(sample.height, 5 + i);
    assert.equal(sample.depth, 1 + i);
    assert.equal(domain.sample(i * 20 + 15, 5), null);
  }
});

test("equal-level lake overlap and river junctions are deterministic under input reordering", () => {
  const lakes = [square("z-last", 30), square("a-first", 35)];
  const rivers = [
    { id: "z-outlet", points: [[0, 3, 0], [10, 3, 0]], width: 4, depth: 1 },
    { id: "a-tributary", points: [[0, 3, -10], [0, 3, 0]], width: 4, depth: 2 },
  ];
  const a = createWaterDomain({ lakes, rivers });
  const b = createWaterDomain({ lakes: [...lakes].reverse(), rivers: [...rivers].reverse() });
  assert.equal(a.sample(0, 0).id, "a-tributary");
  assert.equal(a.sample(37, 5).id, "a-first");
  const raster = { minX: -3, minZ: -13, maxX: 48, maxZ: 13, width: 111, height: 79 };
  assert.deepEqual(a.rasterize(raster), b.rasterize(raster));
});

test("packing preserves CPU height, authored bed and signed XZ flow at texel centers", () => {
  const domain = createWaterDomain({
    lakes: [square("lake", 8, 3, 7.25, 2.5)],
    rivers: [{ id: "west-stream", points: [[5, 5, 0], [-7, 2, 0]], width: 2, depth: 0.6 }],
  });
  const raster = { minX: -10, minZ: -3, maxX: 20, maxZ: 16, width: 47, height: 29 };
  const packed = domain.rasterize(raster);
  let wet = 0, dry = 0, negativeFlow = 0;
  for (let row = 0; row < raster.height; row++) {
    for (let col = 0; col < raster.width; col++) {
      const x = raster.minX + (col + 0.5) * (raster.maxX - raster.minX) / raster.width;
      const z = raster.minZ + (row + 0.5) * (raster.maxZ - raster.minZ) / raster.height;
      const q = domain.sample(x, z);
      const offset = (row * raster.width + col) * 4;
      const expected = q ? [q.height, q.height - q.depth, ...q.flow].map(Math.fround) : [WATER_DOMAIN_DRY_HEIGHT, WATER_DOMAIN_DRY_HEIGHT, 0, 0];
      assert.deepEqual([...packed.slice(offset, offset + 4)], expected);
      if (q) { wet++; if (q.flow[0] < 0) negativeFlow++; }
      else dry++;
    }
  }
  assert.ok(wet > 0 && dry > 0 && negativeFlow > 0);
  const one = domain.rasterize({ minX: 10, minZ: 5, maxX: 12, maxZ: 7, width: 1, height: 1 });
  assert.deepEqual([...one], [7.25, 4.75, 0, 0]);
});

test("compiled domains, samples and raster buffers do not retain mutable author data", () => {
  const source = { lakes: [square()], rivers: [] };
  const before = structuredClone(source);
  const domain = createWaterDomain(source);
  assert.deepEqual(source, before, "compilation must not reorder or close the source polygon");
  const expected = domain.sample(5, 5);
  source.lakes[0].points[0][0] = 900;
  source.lakes[0].level = 800;
  source.lakes[0].depth = 300;
  source.lakes.push(square("extra", 20));
  assert.deepEqual(domain.sample(5, 5), expected);
  assert.equal(domain.sample(25, 5), null);
  const queried = domain.sample(5, 5);
  queried.flow[0] = 500; queried.height = 500;
  assert.deepEqual(domain.sample(5, 5), expected);
  assert.throws(() => { domain.bounds.minX = -999; }, TypeError);
  const extent = { minX: 0, minZ: 0, maxX: 10, maxZ: 10, width: 2, height: 2 };
  const first = domain.rasterize(extent), second = domain.rasterize(extent);
  first.fill(0);
  assert.equal(second[0], 3);
});

test("invalid and unrepresentable scalar inputs cannot leak NaN, infinity or dry-sentinel collisions", () => {
  for (const bad of [NaN, Infinity, -Infinity, "5", null, undefined, 1e100]) {
    assert.throws(() => createWaterDomain({ lakes: [{ ...square(), level: bad }] }), /finite/);
    assert.throws(() => createWaterDomain({ lakes: [{ ...square(), depth: bad }] }), /finite/);
    assert.throws(() => createWaterDomain({ lakes: [{ ...square(), points: [[bad, 0], [10, 0], [10, 10]] }] }), /finite/);
  }
  for (const bad of [0, -1]) assert.throws(() => createWaterDomain({ lakes: [{ ...square(), depth: bad }] }), /positive/);
  assert.throws(() => createWaterDomain({ lakes: [{ ...square(), level: -999999, depth: 2 }] }), /sentinel/);
  assert.throws(() => createWaterDomain({ lakes: [{ ...square(), level: -999999.99, depth: 0.00001 }] }), /sentinel/);
  assert.throws(() => createWaterDomain({ lakes: [{ ...square(), level: 1e20, depth: 1 }] }), /precision/);
  const domain = createWaterDomain();
  assert.throws(() => domain.sample(NaN, 0), /finite/);
  assert.throws(() => domain.sample(0, Infinity), /finite/);
});

test("malformed polygon topology is rejected before field generation", () => {
  for (const points of [
    [], [[0, 0], [1, 1]],
    [[0, 0], [1, 0], [2, 0]],
    [[0, 0], [10, 10], [0, 10], [10, 0]],
    [[0, 0], [10, 0], [10, 0], [0, 10]],
    [[0, 0], [10, 0], [5, 0], [5, 5], [0, 5]],
    [[0, 0], [10, 0], [0, 0], [0, 10]],
  ]) {
    assert.throws(() => createWaterDomain({ lakes: [{ ...square(), points }] }), RangeError);
  }
  assert.throws(() => createWaterDomain({ lakes: [{ ...square(), points: [[0, 0, 0], [10, 0], [0, 10]] }] }), /coordinates/);
});

test("river validation rejects uphill, vertical, folded and self-crossing reaches", () => {
  const river = { id: "invalid", width: 2, depth: 1 };
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, points: [[0, 1, 0]] }] }), /two points/);
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, points: [[0, 1, 0], [10, 2, 0]] }] }), /uphill/);
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, points: [[0, 5, 0], [0, 2, 0]] }] }), /vertical/);
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, points: [[0, 5, 0], [10, 4, 0], [5, 3, 0]] }] }), /doubles back/);
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, points: [[0, 5, 0], [10, 4, 10], [0, 3, 10], [10, 2, 0]] }] }), /self-intersects/);
  assert.throws(() => createWaterDomain({ rivers: [{ ...river, width: 0, points: [[0, 3, 0], [10, 3, 0]] }] }), /positive/);
});

test("intersecting and contained lakes must agree on level, while separate basins need not", () => {
  assert.throws(() => createWaterDomain({ lakes: [square("one"), square("two", 5, 0, 4)] }), /disagree on level/);
  assert.throws(() => createWaterDomain({ lakes: [square("one"), square("touch", 10, 0, 4)] }), /disagree on level/);
  assert.throws(() => createWaterDomain({ lakes: [square("outer"), { id: "inner", points: [[2, 2], [4, 2], [3, 4]], level: 4, depth: 1 }] }), /disagree on level/);
  assert.doesNotThrow(() => createWaterDomain({ lakes: [square("one"), square("two", 11, 0, 4)] }));
});

test("crossing and parallel overlapping rivers cannot silently select incompatible heights", () => {
  const one = { id: "one", points: [[0, 3, 0], [10, 3, 0]], width: 4, depth: 1 };
  assert.throws(() => createWaterDomain({ rivers: [one, { ...one, id: "crossing", points: [[5, 5, -10], [5, 5, 10]] }] }), /junction height/);
  assert.throws(() => createWaterDomain({ rivers: [one, { ...one, id: "parallel", points: [[0, 5, 3], [10, 5, 3]] }] }), /junction height/);
  assert.throws(() => createWaterDomain({ rivers: [one, { ...one, id: "sloping-crossing", points: [[5, 5, -10], [5, 1, 10]] }] }), /flat landing/,
    "equal height at a centerline crossing cannot certify agreement across two finite-width surfaces");
  assert.doesNotThrow(() => createWaterDomain({ rivers: [one, { ...one, id: "separate", points: [[0, 5, 5], [10, 5, 5]] }] }));
});

test("raster bounds, dimensions and allocation budget are validated before allocation", () => {
  const domain = createWaterDomain();
  const valid = { minX: 0, minZ: 0, maxX: 10, maxZ: 10, width: 2, height: 2 };
  for (const patch of [{ minX: NaN }, { maxZ: Infinity }, { maxX: 0 }, { maxZ: -1 }, { width: 0 }, { height: -2 }, { width: 1.5 }, { height: NaN }, { width: 100_000, height: 100_000 }]) {
    assert.throws(() => domain.rasterize({ ...valid, ...patch }), RangeError);
  }
  assert.throws(() => domain.rasterize(), /finite/);
});

test("body identity is nonempty and unique across provider kinds", () => {
  assert.throws(() => createWaterDomain({ lakes: [square(" ")] }), /nonempty/);
  assert.throws(() => createWaterDomain({ lakes: [null] }), /nonempty/);
  assert.throws(() => createWaterDomain({ lakes: {} }), /arrays/);
  assert.throws(() => createWaterDomain({ lakes: [square("same"), square("same", 20)] }), /duplicate/);
  assert.throws(() => createWaterDomain({ lakes: [square("same")], rivers: [{ id: "same", points: [[-20, 3, 0], [-10, 3, 0]], width: 2, depth: 1 }] }), /duplicate/);
});
