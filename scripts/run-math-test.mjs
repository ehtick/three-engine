/**
 * `engine.math` — the gameplay math package.
 *
 *   node scripts/run-math-test.mjs
 *
 * No browser, no dev server: the package imports nothing, which is the
 * property that lets this run in plain Node in under a second.
 *
 * ## What is actually being gated
 *
 * Not "does clamp clamp". Every function here exists because the obvious
 * implementation of it is subtly wrong, and these checks pin the specific
 * wrongness each one avoids:
 *
 *   - smoothing converges at the same rate whatever the frame rate (the bug in
 *     `lerp(a, b, 0.1)` per frame),
 *   - angle blending takes the short way round,
 *   - a seeded stream replays exactly, and two streams do not interfere,
 *   - directions sampled on a sphere are uniform, not corner-biased,
 *   - a ray starting inside a volume reports its exit,
 *   - a ballistic solve actually lands on the target when you integrate it.
 *
 * The last section is a drift guard: every member of the runtime `math`
 * namespace must appear in `script-types/engine.d.ts`. Nothing else catches a
 * function that ships without a type — `skipLibCheck` never validates the
 * d.ts, and a script calling an undeclared member just gets `any`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { math } from "../src/engine/math/index.js";

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
};
const near = (a, b, tolerance = 1e-6, message = "") =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message} got ${a}, want ${b} (±${tolerance})`);

// Pinned: a hash used as a save key or a seed must not move between versions.
const HASH_CHEST_04 = 3877208157;

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const length3 = (v) => Math.hypot(v.x, v.y, v.z);

// ---------------------------------------------------------------------------
console.log("\nmath — scalars");
// ---------------------------------------------------------------------------

check("clamp corrects a reversed range instead of returning nonsense", () => {
  assert.equal(math.clamp(5, 10, 0), 5);
  assert.equal(math.clamp(-5, 10, 0), 0);
  assert.equal(math.clamp(50, 10, 0), 10);
});

check("lerp is unclamped and lerpClamped is not", () => {
  assert.equal(math.lerp(0, 10, 2), 20);
  assert.equal(math.lerpClamped(0, 10, 2), 10);
});

check("inverseLerp on a zero-length range yields 0, not NaN", () => {
  assert.equal(math.inverseLerp(3, 3, 3), 0);
  assert.equal(math.inverseLerp(0, 10, 2.5), 0.25);
});

check("remap moves a value between two ranges", () => {
  assert.equal(math.remap(50, 0, 100, -1, 1), 0);
  assert.equal(math.remapClamped(500, 0, 100, -1, 1), 1);
  assert.equal(math.remap(500, 0, 100, -1, 1), 9);
});

check("smoothstep is flat at both ends", () => {
  assert.equal(math.smoothstep(0, 1, 0), 0);
  assert.equal(math.smoothstep(0, 1, 1), 1);
  near(math.smoothstep(0, 1, 0.5), 0.5);
  // Flat means a small step near the edge moves the output far less than it
  // would in the middle — the property that stops a fade from showing a corner.
  const edge = math.smoothstep(0, 1, 0.02) - math.smoothstep(0, 1, 0);
  const middle = math.smoothstep(0, 1, 0.52) - math.smoothstep(0, 1, 0.5);
  assert.ok(edge < middle / 10, `edge ${edge} vs middle ${middle}`);
});

check("mod and fract are Euclidean — negatives do not leak through", () => {
  assert.equal(math.mod(-1, 4), 3);
  assert.equal(math.mod(9, 4), 1);
  near(math.fract(-0.25), 0.75);
  assert.equal(math.mod(5, 0), 0, "a zero divisor does not produce NaN");
});

check("wrap and pingPong stay in range", () => {
  assert.equal(math.wrap(11, 0, 10), 1);
  assert.equal(math.wrap(-1, 0, 10), 9);
  assert.equal(math.pingPong(0, 5), 0);
  assert.equal(math.pingPong(5, 5), 5);
  assert.equal(math.pingPong(7, 5), 3);
  assert.equal(math.pingPong(10, 5), 0);
});

check("moveTowards lands exactly on the target, never past it", () => {
  assert.equal(math.moveTowards(0, 10, 3), 3);
  assert.equal(math.moveTowards(0, 10, 100), 10, "no overshoot");
  assert.equal(math.moveTowards(10, 0, 100), 0);
});

check("damp converges at the same rate whatever the frame rate", () => {
  // The whole reason this function exists. One 1-second step and a hundred
  // 10ms steps must land in the same place; `lerp(a, b, 0.1)` per frame does
  // not, which is why the same code feels different at 60 and 144 fps.
  const oneStep = math.damp(0, 100, 3, 1);
  let many = 0;
  for (let i = 0; i < 100; i++) many = math.damp(many, 100, 3, 0.01);
  near(oneStep, many, 0.02, "1×1s vs 100×10ms:");
  // And the documented meaning of lambda: ~63% of the gap per 1/lambda sec.
  near(math.damp(0, 1, 1, 1), 1 - Math.exp(-1), 1e-9);
});

check("dampLambdaFor hits 99% in the seconds asked for", () => {
  const lambda = math.dampLambdaFor(0.5);
  near(math.damp(0, 1, lambda, 0.5), 0.99, 1e-9);
});

check("smoothDamp converges without overshooting", () => {
  let value = 0;
  let velocity = 0;
  let maxSeen = 0;
  for (let i = 0; i < 200; i++) {
    const r = math.smoothDamp(value, 10, velocity, 0.3, 1 / 60);
    value = r.value;
    velocity = r.velocity;
    maxSeen = Math.max(maxSeen, value);
  }
  near(value, 10, 1e-3, "settles on the target:");
  assert.ok(maxSeen <= 10 + 1e-9, `never overshoots, peaked at ${maxSeen}`);
});

check("smoothDamp respects maxSpeed", () => {
  let value = 0;
  let velocity = 0;
  for (let i = 0; i < 60; i++) {
    const r = math.smoothDamp(value, 1000, velocity, 0.1, 1 / 60, 5);
    value = r.value;
    velocity = r.velocity;
  }
  assert.ok(value <= 5 * 1.05 + 1e-6, `1s at 5 u/s should be ~5, got ${value}`);
});

check("powers of two round the way a mip chain would", () => {
  assert.equal(math.nextPowerOfTwo(700), 1024);
  assert.equal(math.previousPowerOfTwo(700), 512);
  assert.equal(math.nearestPowerOfTwo(700), 512, "log-space, so 700 → 512");
  assert.equal(math.nearestPowerOfTwo(800), 1024);
  assert.ok(math.isPowerOfTwo(256) && !math.isPowerOfTwo(255) && !math.isPowerOfTwo(0));
});

check("snap / roundUp / roundDown quantize", () => {
  assert.equal(math.snap(1.4, 0.5), 1.5);
  assert.equal(math.snap(-1.4, 0.5), -1.5);
  assert.equal(math.roundUp(1.1, 0.5), 1.5);
  assert.equal(math.roundDown(1.9, 0.5), 1.5);
  assert.equal(math.roundTo(1.23456, 2), 1.23);
});

check("median ignores the outlier a mean would follow", () => {
  const frames = [16, 17, 16, 17, 400];
  assert.equal(math.median(frames), 17);
  assert.ok(math.average(frames) > 90);
  assert.equal(math.median([]), 0);
  assert.equal(math.average([]), 0);
});

check("bias and gain keep 0 and 1 fixed", () => {
  for (const amount of [0.2, 0.5, 0.8]) {
    near(math.bias(0, amount), 0);
    near(math.bias(1, amount), 1);
    near(math.gain(0, amount), 0);
    near(math.gain(1, amount), 1);
    near(math.gain(0.5, amount), 0.5, 1e-9, "gain pins the midpoint:");
  }
  near(math.bias(0.5, 0.5), 0.5, 1e-9, "0.5 is the identity:");
});

check("goldenAngleSpiral stays on the disc and does not clump", () => {
  const points = [];
  for (let i = 0; i < 64; i++) points.push(math.goldenAngleSpiral(i, 64));
  for (const p of points) assert.ok(Math.hypot(p.x, p.y) <= 1 + 1e-9);
  // No two of 64 points closer than a quarter of the mean spacing — the
  // property random sampling fails and this exists to provide.
  let closest = Infinity;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      closest = Math.min(closest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
  assert.ok(closest > 0.25 / Math.sqrt(64), `closest pair ${closest}`);
});

// ---------------------------------------------------------------------------
console.log("\nmath — angles");
// ---------------------------------------------------------------------------

check("wrapAngle lands in (-π, π]", () => {
  near(math.wrapAngle(math.TAU + 0.5), 0.5);
  near(math.wrapAngle(-math.TAU - 0.5), -0.5);
  near(math.wrapAngle(Math.PI), Math.PI, 1e-12, "the closed end is +π:");
  near(math.wrapAngle(-Math.PI), Math.PI, 1e-12, "so -π reads as +180°:");
  for (let i = -20; i <= 20; i++) {
    const w = math.wrapAngle(i * 0.7);
    assert.ok(w > -Math.PI - 1e-9 && w <= Math.PI + 1e-9, `${w} out of range`);
  }
});

check("deltaAngle takes the short way round", () => {
  near(math.deltaAngleDeg(350, 10), 20, 1e-9);
  near(math.deltaAngleDeg(10, 350), -20, 1e-9);
  near(math.deltaAngleDeg(0, 179), 179, 1e-9);
  near(math.deltaAngleDeg(0, 181), -179, 1e-9);
});

check("lerpAngle blends 350° → 10° through 360, not through 180", () => {
  const mid = math.lerpAngleDeg(350, 10, 0.5);
  near(math.wrapAngleDeg(mid), 0, 1e-9, "midpoint is 0°/360°:");
  assert.notEqual(Math.round(mid), 180, "the bug this function exists to avoid");
  near(math.lerpAngleDeg(350, 10, 0), 350, 1e-9);
});

check("moveTowardsAngle turns the short way at a capped rate", () => {
  near(math.wrapAngleDeg(math.moveTowardsAngleDeg(350, 10, 5)), -5, 1e-9);
  near(math.wrapAngleDeg(math.moveTowardsAngleDeg(350, 10, 90)), 10, 1e-9, "clamps to target:");
});

check("dampAngle is frame-rate independent and short-way", () => {
  const oneStep = math.dampAngle(math.degToRad(350), math.degToRad(10), 3, 1);
  let many = math.degToRad(350);
  for (let i = 0; i < 100; i++) many = math.dampAngle(many, math.degToRad(10), 3, 0.01);
  near(math.wrapAngle(oneStep - many), 0, 0.01);
});

check("averageAngle averages on the circle, not on the number line", () => {
  const avg = math.radToDeg(
    math.averageAngle([math.degToRad(350), math.degToRad(10)]),
  );
  near(math.wrapAngleDeg(avg), 0, 1e-9, "350° and 10° average to 0°, not 180°:");
});

check("yaw and direction round-trip", () => {
  for (const yaw of [0, 0.5, -2, 3.1]) {
    const dir = math.directionFromYaw(yaw);
    near(length3(dir), 1);
    near(math.wrapAngle(math.yawFromDirection(dir.x, dir.z) - yaw), 0, 1e-9);
  }
  near(math.pitchFromDirection(0, 1, 0), Math.PI / 2, 1e-9, "straight up is not NaN:");
  near(math.pitchFromDirection(0, -1, 0), -Math.PI / 2, 1e-9);
});

check("withinAngle is a field-of-view test", () => {
  assert.ok(math.withinAngle(math.degToRad(350), math.degToRad(10), math.degToRad(30)));
  assert.ok(!math.withinAngle(math.degToRad(350), math.degToRad(90), math.degToRad(30)));
});

// ---------------------------------------------------------------------------
console.log("\nmath — easing");
// ---------------------------------------------------------------------------

check("every easing starts at 0 and ends at 1", () => {
  for (const [name, fn] of Object.entries(math.ease)) {
    near(fn(0), 0, 1e-9, `${name}(0):`);
    near(fn(1), 1, 1e-9, `${name}(1):`);
  }
});

check("the overshoot curves really do overshoot", () => {
  assert.ok(math.ease.backOut(0.7) > 1);
  assert.ok(math.ease.backIn(0.3) < 0);
  assert.ok(math.ease.elasticOut(0.15) > 1);
  assert.ok(math.ease.elasticIn(0.85) < 0);
});

check("the non-overshoot curves stay inside [0, 1] and never go backwards", () => {
  // `bounce*` is excluded from the monotonic half of this check on purpose:
  // a bounce curve goes backwards at every bounce, which is the effect.
  const overshooting = /^(back|elastic)/;
  const bouncing = /^bounce/;
  for (const [name, fn] of Object.entries(math.ease)) {
    if (overshooting.test(name)) continue;
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const value = fn(i / 100);
      assert.ok(value >= -1e-9 && value <= 1 + 1e-9, `${name}(${i / 100}) = ${value}`);
      if (!bouncing.test(name))
        assert.ok(value >= previous - 1e-9, `${name} went backwards at ${i / 100}`);
      previous = value;
    }
  }
});

check("apply() clamps and falls back to linear on an unknown name", () => {
  assert.equal(math.easing.apply("quadIn", 2), 1, "t is clamped");
  assert.equal(math.easing.apply("nope", 0.4), 0.4, "unknown → linear, not a throw");
  assert.equal(math.easing.easingByName("nope"), null);
  assert.equal(typeof math.easing.easingByName("quadIn"), "function");
});

check("yoyo returns to where it started, peaking in the middle", () => {
  const curve = math.easing.yoyo(math.ease.quadOut);
  near(curve(0), 0);
  near(curve(1), 0);
  near(curve(0.5), 1);
});

check("cubicBezier(0,0,1,1) is the identity", () => {
  const linear = math.easing.cubicBezier(0, 0, 1, 1);
  for (const t of [0, 0.13, 0.5, 0.87, 1]) near(linear(t), t, 1e-4);
});

check("EASE_NAMES matches the table exactly", () => {
  assert.deepEqual([...math.easing.EASE_NAMES].sort(), Object.keys(math.ease).sort());
});

// ---------------------------------------------------------------------------
console.log("\nmath — random");
// ---------------------------------------------------------------------------

check("the same seed replays the same sequence", () => {
  const a = math.random.create(1234);
  const b = math.random.create(1234);
  for (let i = 0; i < 50; i++) assert.equal(a.value(), b.value());
});

check("a string seed works and differs from another string", () => {
  const a = math.random.create("chest_04");
  const b = math.random.create("chest_05");
  assert.notEqual(a.value(), b.value());
  assert.equal(math.random.create("chest_04").value(), math.random.create("chest_04").value());
});

check("derived streams are independent of draw order", () => {
  // The property that lets chunks generate identically whichever order they
  // load in: a child depends on its label, not on how many numbers the parent
  // has drawn since.
  const parent = math.random.create(7);
  const first = parent.derive("chunk:3,7").value();
  for (let i = 0; i < 100; i++) parent.value();
  const later = math.random.create(7).derive("chunk:3,7").value();
  assert.equal(first, later);
  assert.notEqual(first, math.random.create(7).derive("chunk:4,7").value());
});

check("value() covers its range and averages around the middle", () => {
  const rng = math.random.create(99);
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let i = 0; i < 20000; i++) {
    const v = rng.value(10, 20);
    min = Math.min(min, v);
    max = Math.max(max, v);
    total += v;
  }
  assert.ok(min >= 10 && max < 20, `range [${min}, ${max})`);
  near(total / 20000, 15, 0.1);
});

check("int() includes BOTH ends", () => {
  const rng = math.random.create(5);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(rng.int(1, 6));
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

check("gaussian has the mean and spread it claims", () => {
  const rng = math.random.create(3);
  const values = [];
  for (let i = 0; i < 50000; i++) values.push(rng.gaussian(5, 2));
  const mean = math.average(values);
  const variance = math.average(values.map((v) => (v - mean) ** 2));
  near(mean, 5, 0.05, "mean:");
  near(Math.sqrt(variance), 2, 0.05, "stdDev:");
});

check("onSphere is uniform, not biased toward the cube corners", () => {
  const rng = math.random.create(11);
  const sum = v3();
  let count = 0;
  for (let i = 0; i < 20000; i++) {
    const p = rng.onSphere();
    near(length3(p), 1, 1e-9, "unit length:");
    sum.x += p.x;
    sum.y += p.y;
    sum.z += p.z;
    count++;
  }
  // A uniform distribution has a mean of zero; a corner-biased one does not.
  assert.ok(length3(sum) / count < 0.02, `mean direction length ${length3(sum) / count}`);
});

check("inCircle is uniform by area, not bunched at the centre", () => {
  const rng = math.random.create(13);
  let radiusSum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const p = rng.inCircle();
    const r = Math.hypot(p.x, p.y);
    assert.ok(r <= 1 + 1e-9);
    radiusSum += r;
  }
  // Uniform-by-area gives a mean radius of 2/3; the naive version gives 1/2.
  near(radiusSum / n, 2 / 3, 0.01);
});

check("inSphere stays inside and inCone stays in the cone", () => {
  const rng = math.random.create(17);
  for (let i = 0; i < 2000; i++) assert.ok(length3(rng.inSphere()) <= 1 + 1e-9);
  const axis = v3(0, 1, 0);
  const half = math.degToRad(20);
  for (let i = 0; i < 5000; i++) {
    const d = rng.inCone(axis, half);
    near(length3(d), 1, 1e-6, "unit length:");
    assert.ok(Math.acos(Math.min(1, d.x * axis.x + d.y * axis.y + d.z * axis.z)) <= half + 1e-6);
  }
  // And a cone about -Z, the axis a hand-rolled basis usually degenerates on.
  const back = v3(0, 0, -1);
  for (let i = 0; i < 2000; i++) {
    const d = rng.inCone(back, half);
    assert.ok(Number.isFinite(d.x + d.y + d.z), "no NaN from the basis");
    assert.ok(Math.acos(Math.min(1, -d.z)) <= half + 1e-6);
  }
});

check("inTriangle lands inside the triangle", () => {
  const rng = math.random.create(19);
  const a = v3(0, 0, 0);
  const b = v3(4, 0, 0);
  const c = v3(0, 0, 3);
  for (let i = 0; i < 3000; i++) {
    const p = rng.inTriangle(a, b, c);
    const bary = math.intersect.barycentric(p, a, b, c);
    assert.ok(bary.u >= -1e-9 && bary.v >= -1e-9 && bary.w >= -1e-9, JSON.stringify(bary));
  }
});

check("shuffle is a permutation, not a resample", () => {
  const rng = math.random.create(23);
  const items = [...Array(50).keys()];
  const shuffled = rng.shuffled(items);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), items);
  assert.notDeepEqual(shuffled, items, "and it actually moved something");
  assert.deepEqual(items, [...Array(50).keys()], "shuffled() left the input alone");
});

check("pickWeighted honours zero weights and relative odds", () => {
  const rng = math.random.create(29);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 30000; i++) counts[rng.pickWeighted(["a", "b", "c"], [3, 1, 0])]++;
  assert.equal(counts.c, 0, "a zero weight is never picked");
  near(counts.a / counts.b, 3, 0.15, "3:1 odds:");
  assert.equal(rng.pickWeighted(["a"], [0]), undefined, "all-zero weights → undefined");
});

check("the shared stream is reseedable and callable", () => {
  math.random.setSeed(42);
  const first = [math.random(), math.random(2, 5)];
  math.random.setSeed(42);
  assert.deepEqual([math.random(), math.random(2, 5)], first);
  assert.equal(math.random.seed, 42);
  assert.ok(first[1] >= 2 && first[1] < 5);
});

// ---------------------------------------------------------------------------
console.log("\nmath — noise");
// ---------------------------------------------------------------------------

check("perlin is zero on the lattice and smooth between", () => {
  for (let i = -3; i <= 3; i++) near(math.noise.perlin2(i, i * 2), 0, 1e-12);
  let maxJump = 0;
  let previous = math.noise.perlin2(0, 0.5);
  for (let i = 1; i <= 2000; i++) {
    const value = math.noise.perlin2(i * 0.01, 0.5);
    maxJump = Math.max(maxJump, Math.abs(value - previous));
    previous = value;
  }
  assert.ok(maxJump < 0.1, `biggest step over 0.01 units was ${maxJump} — not coherent`);
});

check("perlin2 and perlin3 use the same scale and fill it", () => {
  let max2 = 0;
  let max3 = 0;
  for (let i = 0; i < 300; i++)
    for (let j = 0; j < 300; j++) {
      max2 = Math.max(max2, Math.abs(math.noise.perlin2(i * 0.137, j * 0.219)));
      max3 = Math.max(max3, Math.abs(math.noise.perlin3(i * 0.137, j * 0.219, i * 0.311)));
    }
  assert.ok(max2 > 0.7 && max2 <= 1.0001, `perlin2 peak ${max2}`);
  assert.ok(max3 > 0.7 && max3 <= 1.0001, `perlin3 peak ${max3}`);
});

check("a seeded field replays, and different seeds differ", () => {
  const a = math.noise.create(7);
  const b = math.noise.create(7);
  const c = math.noise.create(8);
  for (let i = 0; i < 20; i++) {
    const x = i * 0.31;
    assert.equal(a.perlin2(x, 1.5), b.perlin2(x, 1.5));
  }
  assert.notEqual(a.perlin2(0.31, 1.5), c.perlin2(0.31, 1.5));
});

check("fbm stays normalized however many octaves you ask for", () => {
  for (const octaves of [1, 4, 8]) {
    let max = 0;
    for (let i = 0; i < 4000; i++)
      max = Math.max(max, Math.abs(math.noise.fbm2(i * 0.017, i * 0.031, { octaves })));
    assert.ok(max <= 1.0001, `${octaves} octaves peaked at ${max}`);
    assert.ok(max > 0.3, `${octaves} octaves only reached ${max} — over-normalized`);
  }
});

check("ridged2 is non-negative and worley2 is a distance", () => {
  for (let i = 0; i < 500; i++) {
    const r = math.noise.ridged2(i * 0.013, i * 0.029);
    assert.ok(r >= 0 && r <= 1.0001, `ridged ${r}`);
    const w = math.noise.worley2(i * 0.013, i * 0.029);
    assert.ok(w >= 0 && w <= 1.5, `worley ${w}`);
  }
});

check("tileable2 has no seam at the period", () => {
  const period = 4;
  for (let i = 0; i <= 40; i++) {
    const y = i * 0.1;
    near(
      math.noise.tileable2(0, y, period),
      math.noise.tileable2(period, y, period),
      1e-12,
      `x seam at y=${y}:`,
    );
    near(
      math.noise.tileable2(y, 0, period),
      math.noise.tileable2(y, period, period),
      1e-12,
      `y seam at x=${y}:`,
    );
  }
  // And it is still continuous either side of the seam, not merely equal.
  const before = math.noise.tileable2(period - 0.001, 1.3, period);
  const after = math.noise.tileable2(0.001, 1.3, period);
  assert.ok(Math.abs(before - after) < 0.01, `discontinuous: ${before} vs ${after}`);
});

check("hash is stable across calls and orders", () => {
  const field = math.noise.create(5);
  const first = field.hash(12, 34, 56);
  for (let i = 0; i < 100; i++) field.perlin3(i, i, i);
  assert.equal(field.hash(12, 34, 56), first);
  assert.ok(first >= 0 && first < 1);
});

// ---------------------------------------------------------------------------
console.log("\nmath — vectors");
// ---------------------------------------------------------------------------

check("vec3.moveTowards lands exactly on the target", () => {
  const p = v3(0, 0, 0);
  math.vec3.moveTowards(p, v3(3, 4, 0), 2.5);
  near(length3(p), 2.5);
  math.vec3.moveTowards(p, v3(3, 4, 0), 100);
  assert.deepEqual(p, { x: 3, y: 4, z: 0 });
});

check("vec3.damp is frame-rate independent", () => {
  const a = v3(0, 0, 0);
  const b = v3(0, 0, 0);
  math.vec3.damp(a, v3(10, 20, 30), 4, 1);
  for (let i = 0; i < 100; i++) math.vec3.damp(b, v3(10, 20, 30), 4, 0.01);
  near(a.x, b.x, 0.01);
  near(a.z, b.z, 0.02);
});

check("vec3.smoothDamp settles and does not overshoot", () => {
  const p = v3(0, 0, 0);
  const velocity = v3(0, 0, 0);
  const target = v3(5, 0, 0);
  let peak = 0;
  for (let i = 0; i < 300; i++) {
    math.vec3.smoothDamp(p, target, velocity, 0.25, 1 / 60);
    peak = Math.max(peak, p.x);
  }
  near(p.x, 5, 1e-3);
  assert.ok(peak <= 5 + 1e-9, `peaked at ${peak}`);
});

check("vec3.smoothDamp caps diagonal speed the same as axis speed", () => {
  // Clamping per axis would let a diagonal move √3 times faster; this is the
  // check that would catch that.
  const run = (target) => {
    const p = v3(0, 0, 0);
    const velocity = v3(0, 0, 0);
    for (let i = 0; i < 60; i++) math.vec3.smoothDamp(p, target, velocity, 0.1, 1 / 60, 4);
    return length3(p);
  };
  near(run(v3(1000, 0, 0)), run(v3(577, 577, 577)), 0.25, "axis vs diagonal distance:");
});

check("vec3.slerp keeps unit length where lerp would not", () => {
  const a = v3(1, 0, 0);
  const b = v3(0, 0, 1);
  const out = v3();
  for (let i = 0; i <= 10; i++) {
    math.vec3.slerp(a, b, i / 10, out);
    near(length3(out), 1, 1e-9, `t=${i / 10}:`);
  }
  math.vec3.slerp(a, b, 0.5, out);
  near(out.x, Math.SQRT1_2, 1e-9);
  near(out.z, Math.SQRT1_2, 1e-9);
});

check("vec3.signedAngle knows left from right", () => {
  const up = v3(0, 1, 0);
  const forward = v3(0, 0, 1);
  // A positive rotation about +Y carries +Z to +X, so that is the positive
  // direction — the same convention `entity.rotation.y` uses.
  near(math.vec3.signedAngle(forward, v3(1, 0, 0), up), Math.PI / 2, 1e-9);
  near(math.vec3.signedAngle(forward, v3(-1, 0, 0), up), -Math.PI / 2, 1e-9);
  near(Math.abs(math.vec3.signedAngle(forward, v3(0, 0, -1), up)), Math.PI, 1e-9);
});

check("vec3.rotateTowards caps the turn", () => {
  const current = v3(0, 0, 1);
  math.vec3.rotateTowards(current, v3(1, 0, 0), math.degToRad(30));
  near(length3(current), 1, 1e-9);
  near(Math.acos(current.z), math.degToRad(30), 1e-9);
});

check("vec3.safeNormalize does not produce NaN on a zero vector", () => {
  const zero = v3(0, 0, 0);
  math.vec3.safeNormalize(zero);
  assert.deepEqual(zero, { x: 0, y: 0, z: 0 });
  const v = v3(0, 3, 4);
  math.vec3.safeNormalize(v);
  near(length3(v), 1);
});

check("yaw/pitch round-trips through a direction", () => {
  for (const [yaw, pitch] of [[0, 0], [1.2, 0.4], [-2.6, -1.1]]) {
    const dir = math.vec3.fromYawPitch(yaw, pitch, v3());
    near(length3(dir), 1);
    const back = math.vec3.toYawPitch(dir);
    near(math.wrapAngle(back.yaw - yaw), 0, 1e-9);
    near(back.pitch, pitch, 1e-9);
  }
});

check("horizontalDistance ignores height, within() agrees with it", () => {
  near(math.vec3.horizontalDistance(v3(0, 100, 0), v3(3, -50, 4)), 5);
  assert.ok(math.vec3.within(v3(0, 0, 0), v3(3, 4, 0), 5));
  assert.ok(!math.vec3.within(v3(0, 0, 0), v3(3, 4, 0.1), 5));
});

check("orthonormalBasis is orthonormal for every normal, including -Z", () => {
  const rng = math.random.create(31);
  const normals = [v3(0, 0, -1), v3(0, 0, 1), v3(0, 1, 0)];
  for (let i = 0; i < 500; i++) normals.push(rng.onSphere());
  const t = v3();
  const b = v3();
  for (const n of normals) {
    math.orthonormalBasis(n, t, b);
    near(length3(t), 1, 1e-6, "tangent unit:");
    near(length3(b), 1, 1e-6, "bitangent unit:");
    near(t.x * n.x + t.y * n.y + t.z * n.z, 0, 1e-6, "t ⟂ n:");
    near(b.x * n.x + b.y * n.y + b.z * n.z, 0, 1e-6, "b ⟂ n:");
    near(t.x * b.x + t.y * b.y + t.z * b.z, 0, 1e-6, "t ⟂ b:");
  }
});

check("vec2.clampStick normalizes diagonals but leaves partials alone", () => {
  const diagonal = { x: 1, y: 1 };
  math.vec2.clampStick(diagonal);
  near(Math.hypot(diagonal.x, diagonal.y), 1, 1e-9, "a diagonal is not faster:");
  const partial = { x: 0.5, y: 0 };
  math.vec2.clampStick(partial);
  near(partial.x, 0.5, 1e-9, "a half-deflection stays a half-deflection:");
  const inside = { x: 0.1, y: 0 };
  math.vec2.clampStick(inside, 0.2);
  assert.deepEqual(inside, { x: 0, y: 0 }, "inside the deadzone reads as zero");
  const edge = { x: 0.2001, y: 0 };
  math.vec2.clampStick(edge, 0.2);
  assert.ok(edge.x < 0.01, `no jump at the deadzone edge, got ${edge.x}`);
});

check("vec2 rotate / cross / signedAngle agree on handedness", () => {
  const v = { x: 1, y: 0 };
  math.vec2.rotate(v, Math.PI / 2);
  near(v.x, 0, 1e-9);
  near(v.y, 1, 1e-9);
  assert.ok(math.vec2.cross({ x: 1, y: 0 }, { x: 0, y: 1 }) > 0);
  near(math.vec2.signedAngle({ x: 1, y: 0 }, { x: 0, y: 1 }), Math.PI / 2, 1e-9);
});

check("quat.lookRotation down -Z is the identity, and aims where asked", () => {
  const q = { x: 0, y: 0, z: 0, w: 1 };
  math.quat.lookRotation(v3(0, 0, -1), v3(0, 1, 0), q);
  near(q.x, 0, 1e-9);
  near(q.y, 0, 1e-9);
  near(q.z, 0, 1e-9);
  near(Math.abs(q.w), 1, 1e-9);

  // Rotating three's default forward by the result must give the direction
  // that was asked for — the only test of a look-rotation that means anything.
  const applyToForward = (quaternion) => {
    const { x, y, z, w } = quaternion;
    const vx = 0;
    const vy = 0;
    const vz = -1;
    const ix = w * vx + y * vz - z * vy;
    const iy = w * vy + z * vx - x * vz;
    const iz = w * vz + x * vy - y * vx;
    const iw = -x * vx - y * vy - z * vz;
    return v3(
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    );
  };
  for (const target of [v3(1, 0, 0), v3(0, 0, 1), v3(0.3, 0.5, -0.8)]) {
    math.vec3.safeNormalize(target);
    math.quat.lookRotation(target, v3(0, 1, 0), q);
    const got = applyToForward(q);
    near(got.x, target.x, 1e-6, "x:");
    near(got.y, target.y, 1e-6, "y:");
    near(got.z, target.z, 1e-6, "z:");
  }
});

check("quat.lookRotation survives forward ∥ up", () => {
  const q = { x: 0, y: 0, z: 0, w: 1 };
  math.quat.lookRotation(v3(0, 1, 0), v3(0, 1, 0), q);
  assert.ok(Number.isFinite(q.x + q.y + q.z + q.w), `NaN quaternion: ${JSON.stringify(q)}`);
  near(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-6, "still normalized:");
});

check("quat.slerp takes the short way and quat.damp converges", () => {
  const half = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) };
  // The negated quaternion is the same rotation; slerping to it must not
  // travel the long way round.
  const negated = { x: -half.x, y: -half.y, z: -half.z, w: -half.w };
  const from = { x: 0, y: 0, z: 0, w: 1 };
  const q = { ...from };
  math.quat.slerp(q, negated, 0.5);
  near(math.quat.angleBetween(from, q), math.quat.angleBetween(q, half), 1e-6, "midpoint:");

  const c = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < 300; i++) math.quat.damp(c, half, 6, 1 / 60);
  near(math.quat.angleBetween(c, half), 0, 1e-3);
});

// ---------------------------------------------------------------------------
console.log("\nmath — intersection");
// ---------------------------------------------------------------------------

check("raySphere reports the near hit, and the exit from inside", () => {
  assert.equal(math.intersect.raySphere(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 5), 1), 4);
  assert.equal(math.intersect.raySphere(v3(0, 0, 5), v3(0, 0, 1), v3(0, 0, 5), 1), 1, "from inside");
  assert.equal(math.intersect.raySphere(v3(0, 0, 0), v3(0, 0, -1), v3(0, 0, 5), 1), null, "behind");
  assert.equal(math.intersect.raySphere(v3(0, 3, 0), v3(0, 0, 1), v3(0, 0, 5), 1), null, "miss");
});

check("rayBox handles axis-parallel rays without a NaN", () => {
  const min = v3(-1, -1, 3);
  const max = v3(1, 1, 5);
  assert.equal(math.intersect.rayBox(v3(0, 0, 0), v3(0, 0, 1), min, max), 3);
  assert.equal(math.intersect.rayBox(v3(0, 0, 4), v3(0, 0, 1), min, max), 1, "from inside");
  assert.equal(math.intersect.rayBox(v3(0, 5, 0), v3(0, 0, 1), min, max), null);
  assert.equal(math.intersect.rayBox(v3(0, 0, 0), v3(0, 0, -1), min, max), null, "behind");
});

check("rayPlane returns the distance and refuses a parallel ray", () => {
  // Plane y = 2, normal +Y, so constant is -2.
  assert.equal(math.intersect.rayPlane(v3(0, 0, 0), v3(0, 1, 0), v3(0, 1, 0), -2), 2);
  assert.equal(math.intersect.rayPlane(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), -2), null);
  assert.equal(math.intersect.rayPlane(v3(0, 3, 0), v3(0, 1, 0), v3(0, 1, 0), -2), null, "behind");
});

check("rayTriangle hits, culls, and reports usable barycentrics", () => {
  const a = v3(-1, -1, 5);
  const b = v3(1, -1, 5);
  const c = v3(0, 1, 5);
  const bary = { u: 0, v: 0, w: 0 };
  const t = math.intersect.rayTriangle(v3(0, 0, 0), v3(0, 0, 1), a, b, c, false, bary);
  near(t, 5);
  near(bary.u + bary.v + bary.w, 1, 1e-9, "weights sum to 1:");
  // Reconstructing the hit point from the weights must land on the ray.
  near(a.x * bary.u + b.x * bary.v + c.x * bary.w, 0, 1e-9);
  assert.equal(math.intersect.rayTriangle(v3(0, 5, 0), v3(0, 0, 1), a, b, c), null, "miss");
  // a→b→c winds counter-clockwise seen from -Z, so its normal faces +Z and a
  // +Z ray strikes its BACK. Culling must drop that one and keep the other.
  assert.equal(math.intersect.rayTriangle(v3(0, 0, 0), v3(0, 0, 1), a, b, c, true), null);
  near(math.intersect.rayTriangle(v3(0, 0, 0), v3(0, 0, 1), a, c, b, true), 5);
});

check("rayCapsule hits the body and the caps", () => {
  const a = v3(-2, 0, 5);
  const b = v3(2, 0, 5);
  near(math.intersect.rayCapsule(v3(0, 0, 0), v3(0, 0, 1), a, b, 1), 4, 1e-9, "body:");
  near(math.intersect.rayCapsule(v3(3, 0, 0), v3(0, 0, 1), a, b, 1), 5, 1e-9, "cap:");
  assert.equal(math.intersect.rayCapsule(v3(4, 0, 0), v3(0, 0, 1), a, b, 1), null, "past the cap");
  // A zero-length capsule is a sphere, and must behave like one.
  assert.equal(
    math.intersect.rayCapsule(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 5), v3(0, 0, 5), 1),
    math.intersect.raySphere(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 5), 1),
  );
});

check("closestPointOnSegment clamps to the ends", () => {
  const out = v3();
  math.intersect.closestPointOnSegment(v3(5, 1, 0), v3(0, 0, 0), v3(2, 0, 0), out);
  assert.deepEqual(out, { x: 2, y: 0, z: 0 });
  near(math.intersect.distanceToSegment(v3(1, 3, 0), v3(0, 0, 0), v3(2, 0, 0)), 3);
  // A degenerate segment is a point, not a division by zero.
  near(math.intersect.distanceToSegment(v3(3, 4, 0), v3(0, 0, 0), v3(0, 0, 0)), 5);
});

check("closestPointsBetweenSegments handles crossing and parallel", () => {
  const outA = v3();
  const outB = v3();
  // Two segments crossing at right angles, 2 apart in Y.
  const distance = math.intersect.closestPointsBetweenSegments(
    v3(-1, 0, 0), v3(1, 0, 0),
    v3(0, 2, -1), v3(0, 2, 1),
    outA, outB,
  );
  near(distance, 2);
  near(outA.x, 0, 1e-9);
  near(outB.z, 0, 1e-9);
  // Parallel: the naive derivation divides by zero here.
  const parallel = math.intersect.closestPointsBetweenSegments(
    v3(0, 0, 0), v3(5, 0, 0),
    v3(0, 3, 0), v3(5, 3, 0),
  );
  near(parallel, 3);
});

check("sweepSphereSphere catches a projectile that would tunnel", () => {
  // A point moving 100 units in one step, through a target 50 away: a
  // per-frame overlap test misses this entirely.
  const t = math.intersect.sweepSphereSphere(v3(0, 0, 0), v3(100, 0, 0), 0, v3(50, 0, 0), 1);
  assert.notEqual(t, null, "tunnelled straight through");
  near(t, 0.49, 1e-9);
  assert.equal(math.intersect.sweepSphereSphere(v3(0, 0, 0), v3(100, 0, 0), 0, v3(50, 5, 0), 1), null);
  assert.equal(
    math.intersect.sweepSphereSphere(v3(0, 0, 0), v3(1, 0, 0), 1, v3(0.5, 0, 0), 1),
    0,
    "already overlapping reports contact at the start of the step",
  );
});

check("overlap tests agree with each other", () => {
  assert.ok(math.intersect.sphereSphere(v3(0, 0, 0), 1, v3(1.9, 0, 0), 1));
  assert.ok(!math.intersect.sphereSphere(v3(0, 0, 0), 1, v3(2.1, 0, 0), 1));
  assert.ok(math.intersect.boxBox(v3(0, 0, 0), v3(2, 2, 2), v3(1, 1, 1), v3(3, 3, 3)));
  assert.ok(!math.intersect.boxBox(v3(0, 0, 0), v3(1, 1, 1), v3(2, 2, 2), v3(3, 3, 3)));
  assert.ok(math.intersect.boxSphere(v3(0, 0, 0), v3(1, 1, 1), v3(1.5, 0.5, 0.5), 1));
  assert.ok(!math.intersect.boxSphere(v3(0, 0, 0), v3(1, 1, 1), v3(3, 0.5, 0.5), 1));
  assert.ok(math.intersect.pointInBox(v3(0.5, 0.5, 0.5), v3(0, 0, 0), v3(1, 1, 1)));
});

check("pointInCone combines angle and range", () => {
  const apex = v3(0, 0, 0);
  const axis = v3(0, 0, 1);
  const half = math.degToRad(30);
  assert.ok(math.intersect.pointInCone(v3(0, 0, 5), apex, axis, half, 10));
  assert.ok(!math.intersect.pointInCone(v3(0, 0, 15), apex, axis, half, 10), "out of range");
  assert.ok(!math.intersect.pointInCone(v3(5, 0, 5), apex, axis, half, 10), "outside the angle");
  assert.ok(math.intersect.pointInCone(apex, apex, axis, half, 10), "the apex itself is inside");
});

check("2D helpers: segment crossing, concave polygons, winding", () => {
  const out = { x: 0, y: 0 };
  assert.ok(math.intersect.segmentSegment2D(
    { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }, out,
  ));
  near(out.x, 0);
  near(out.y, 0);
  assert.ok(!math.intersect.segmentSegment2D(
    { x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 1 }, { x: 1, y: 1 },
  ), "parallel");

  // An L-shape: the notch must read as outside.
  const shape = [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 },
    { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 },
  ];
  assert.ok(math.intersect.pointInPolygon2D({ x: 0.5, y: 0.5 }, shape));
  assert.ok(math.intersect.pointInPolygon2D({ x: 3, y: 0.5 }, shape));
  assert.ok(!math.intersect.pointInPolygon2D({ x: 3, y: 3 }, shape), "the notch is outside");
  assert.ok(!math.intersect.pointInPolygon2D({ x: 9, y: 9 }, shape));

  const ccw = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  near(math.intersect.polygonArea2D(ccw), 4);
  near(math.intersect.polygonArea2D([...ccw].reverse()), -4, 1e-9, "reversed winding:");
});

check("barycentric and triangleArea agree with hand calculation", () => {
  const a = v3(0, 0, 0);
  const b = v3(4, 0, 0);
  const c = v3(0, 3, 0);
  near(math.intersect.triangleArea(a, b, c), 6);
  const bary = math.intersect.barycentric(v3(4 / 3, 1, 0), a, b, c);
  near(bary.u, 1 / 3, 1e-9);
  near(bary.v, 1 / 3, 1e-9);
  near(bary.w, 1 / 3, 1e-9);
  const degenerate = math.intersect.barycentric(v3(1, 1, 0), a, a, a);
  assert.ok(Number.isFinite(degenerate.u + degenerate.v + degenerate.w), "no NaN on a degenerate tri");
});

// ---------------------------------------------------------------------------
console.log("\nmath — trajectory");
// ---------------------------------------------------------------------------

check("a ballistic solve actually lands on the target", () => {
  const from = v3(0, 0, 0);
  for (const to of [v3(10, 0, 0), v3(8, 3, 6), v3(-5, -2, 4)]) {
    for (const high of [false, true]) {
      const velocity = v3();
      assert.ok(math.trajectory.solveBallistic(from, to, 20, 9.81, high, velocity), "solvable");
      // flightTime, not timeToHeight: a low shot at a raised target reaches it
      // CLIMBING, and the vertical solution hands back the descent instead.
      const flight = math.trajectory.flightTime(from, to, velocity);
      assert.notEqual(flight, null);
      const landed = math.trajectory.projectileAt(from, velocity, flight, v3(), 9.81);
      near(landed.x, to.x, 1e-6, "x:");
      near(landed.y, to.y, 1e-6, "y:");
      near(landed.z, to.z, 1e-6, "z:");
    }
  }
});

check("the high arc really is higher than the low one", () => {
  const low = v3();
  const high = v3();
  math.trajectory.solveBallistic(v3(0, 0, 0), v3(10, 0, 0), 15, 9.81, false, low);
  math.trajectory.solveBallistic(v3(0, 0, 0), v3(10, 0, 0), 15, 9.81, true, high);
  assert.ok(math.trajectory.apex(high.y).height > math.trajectory.apex(low.y).height);
});

check("an impossible shot is reported, not guessed at", () => {
  assert.equal(math.trajectory.launchAngles(1000, 0, 5, 9.81), null, "out of range");
  assert.equal(
    math.trajectory.solveBallistic(v3(0, 0, 0), v3(1000, 0, 0), 5, 9.81, false, v3()),
    false,
  );
  // Straight up, too slow to reach: 5 m/s tops out at ~1.27 m.
  assert.equal(math.trajectory.launchAngles(0, 50, 5, 9.81), null);
  assert.notEqual(math.trajectory.launchAngles(0, 1, 5, 9.81), null);
});

check("jumpSpeedForHeight and apex are inverses", () => {
  for (const height of [0.5, 2, 7.25]) {
    const speed = math.trajectory.jumpSpeedForHeight(height, 9.81);
    near(math.trajectory.apex(speed, 9.81).height, height, 1e-9);
  }
});

check("interceptPoint leads the target by exactly the flight time", () => {
  const shooter = v3(0, 0, 0);
  const target = v3(30, 0, 0);
  const targetVelocity = v3(0, 0, 10);
  const speed = 40;
  const aim = v3();
  assert.ok(math.trajectory.interceptPoint(shooter, target, targetVelocity, speed, aim));
  // The projectile's travel time to the aim point must equal the time the
  // target needs to arrive there. That is the whole definition of a lead.
  const travel = length3(v3(aim.x - shooter.x, aim.y - shooter.y, aim.z - shooter.z)) / speed;
  const targetArrival = (aim.z - target.z) / targetVelocity.z;
  near(travel, targetArrival, 1e-6);
  assert.ok(aim.z > target.z, "aims ahead of the target, not at it");
});

check("a target that outruns the projectile cannot be intercepted", () => {
  const escaping = math.trajectory.interceptPoint(
    v3(0, 0, 0), v3(10, 0, 0), v3(50, 0, 0), 5, v3(),
  );
  assert.equal(escaping, false);
  assert.equal(math.trajectory.interceptTime(v3(10, 0, 0), v3(50, 0, 0), 5), null);
});

check("solveBallisticLead hits a moving target", () => {
  const from = v3(0, 0, 0);
  const target = v3(25, 0, 0);
  const targetVelocity = v3(0, 0, 4);
  const velocity = v3();
  assert.ok(math.trajectory.solveBallisticLead(from, target, targetVelocity, 25, 9.81, false, velocity));
  const flight = math.trajectory.timeToHeight(velocity.y, 0, 9.81);
  const landed = math.trajectory.projectileAt(from, velocity, flight, v3(), 9.81);
  const targetThen = v3(
    target.x + targetVelocity.x * flight,
    target.y + targetVelocity.y * flight,
    target.z + targetVelocity.z * flight,
  );
  const miss = Math.hypot(landed.x - targetThen.x, landed.y - targetThen.y, landed.z - targetThen.z);
  assert.ok(miss < 0.5, `missed by ${miss} — two passes should converge`);
});

check("sampleArc walks the arc from launch to maxTime", () => {
  const points = math.trajectory.sampleArc(v3(0, 0, 0), v3(10, 10, 0), 8, 2, 9.81);
  assert.equal(points.length, 9);
  assert.deepEqual(points[0], { x: 0, y: 0, z: 0 });
  const last = math.trajectory.projectileAt(v3(0, 0, 0), v3(10, 10, 0), 2, v3(), 9.81);
  assert.deepEqual(points[8], last);
});

// ---------------------------------------------------------------------------
console.log("\nmath — bits");
// ---------------------------------------------------------------------------

check("flag operations compose", () => {
  const A = math.bits.bit(0);
  const B = math.bits.bit(3);
  let flags = 0;
  flags = math.bits.setFlag(flags, A);
  flags = math.bits.setFlag(flags, B);
  assert.equal(flags, 9);
  assert.ok(math.bits.hasFlag(flags, A | B));
  assert.ok(!math.bits.hasFlag(flags, A | math.bits.bit(5)));
  assert.ok(math.bits.hasAnyFlag(flags, A | math.bits.bit(5)));
  flags = math.bits.clearFlag(flags, A);
  assert.equal(flags, 8);
  assert.equal(math.bits.toggleFlag(flags, B), 0);
  assert.equal(math.bits.writeFlag(0, B, true), 8);
  assert.equal(math.bits.writeFlag(8, B, false), 0);
});

check("bitCount and bitIndices read a mask back", () => {
  assert.equal(math.bits.bitCount(0), 0);
  assert.equal(math.bits.bitCount(0b1011), 3);
  assert.equal(math.bits.bitCount(0xffffffff), 32);
  assert.deepEqual(math.bits.bitIndices(0b1011), [0, 1, 3]);
  assert.equal(math.bits.lowestBitIndex(0b1000), 3);
  assert.equal(math.bits.lowestBitIndex(0), -1);
});

check("packing round-trips", () => {
  for (const value of [0, 1, 255, 65535, 0x12345678, 0xffffffff]) {
    const [b3, b2, b1, b0] = math.bits.intToBytes32(value);
    assert.equal(math.bits.bytesToInt32(b3, b2, b1, b0), value >>> 0, `32-bit ${value}`);
  }
  for (const value of [0, 1, 255, 0xabcdef]) {
    const [b2, b1, b0] = math.bits.intToBytes24(value);
    assert.equal(math.bits.bytesToInt24(b2, b1, b0), value >>> 0, `24-bit ${value}`);
  }
  const packed = math.bits.packUint16Pair(1234, 5678);
  assert.deepEqual(math.bits.unpackUint16Pair(packed), { high: 1234, low: 5678 });
  const color = math.bits.packColor(1, 0.5, 0);
  const unpacked = math.bits.unpackColor(color);
  near(unpacked.r, 1, 1 / 255);
  near(unpacked.g, 0.5, 1 / 255);
  near(unpacked.b, 0, 1 / 255);
});

check("hashString is stable and spreads similar inputs apart", () => {
  // Pinned: this value is what makes a hash usable as a save key. If it ever
  // changes, every seed derived from a name changes with it.
  assert.equal(math.bits.hashString("chest_04"), HASH_CHEST_04);
  assert.equal(math.bits.hashString(""), math.bits.hashInt(0x811c9dc5));
  assert.equal(math.seedFromString("chest_04"), HASH_CHEST_04, "one string hash, two names");
  const a = math.bits.hashToFloat(math.bits.hashString("enemy_01"));
  const b = math.bits.hashToFloat(math.bits.hashString("enemy_02"));
  assert.ok(Math.abs(a - b) > 0.05, `adjacent names hashed to ${a} and ${b}`);
  assert.notEqual(math.bits.hashCombine(1, 2), math.bits.hashCombine(2, 1), "order matters");
});

check("colorFromString is stable per name", () => {
  assert.equal(math.bits.colorFromString("player"), math.bits.colorFromString("player"));
  assert.notEqual(math.bits.colorFromString("player"), math.bits.colorFromString("enemy"));
  const c = math.bits.colorFromString("player");
  assert.ok(c >= 0 && c <= 0xffffff);
});

// ---------------------------------------------------------------------------
console.log("\nmath — the typed surface (drift guard)");
// ---------------------------------------------------------------------------

const DTS = readFileSync(
  fileURLToPath(new URL("../src/engine/script-types/engine.d.ts", import.meta.url)),
  "utf8",
);

// A member declared nowhere in the d.ts is `any` at every call site, and
// `skipLibCheck` means tsc will never say so. This is the only thing that
// catches it.
const declared = (name) => new RegExp(`(?:^|[\\s(<{,])${name}\\??[(:<]`, "m").test(DTS);

const SUB_NAMESPACES = ["vec3", "vec2", "quat", "intersect", "trajectory", "bits", "easing"];

check("every top-level math member is declared in engine.d.ts", () => {
  const missing = Object.keys(math).filter((key) => !declared(key));
  assert.deepEqual(missing, [], `undeclared: ${missing.join(", ")}`);
});

for (const namespace of SUB_NAMESPACES) {
  check(`every math.${namespace} member is declared in engine.d.ts`, () => {
    const missing = Object.keys(math[namespace]).filter((key) => !declared(key));
    assert.deepEqual(missing, [], `undeclared: ${missing.join(", ")}`);
  });
}

check("every math.random / math.noise member is declared", () => {
  // These two are callable objects, so their members come off the function.
  const members = [
    ...Object.keys(math.random),
    ...Object.keys(math.noise),
  ].filter((key) => !["length", "name", "prototype"].includes(key));
  const missing = members.filter((key) => !declared(key));
  assert.deepEqual(missing, [], `undeclared: ${missing.join(", ")}`);
});

check("the EasingName union matches the easing table exactly", () => {
  const union = /export type EasingName =([\s\S]*?);/.exec(DTS)?.[1] ?? "";
  const declaredNames = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(declaredNames, Object.keys(math.ease).sort());
});

check("math is on Engine and on Script in the d.ts", () => {
  assert.match(DTS, /export const math: MathAPI;/);
  // Two declarations — one on Engine, one on Script — plus the standalone
  // export above. Anything less and one of the three ways in is untyped.
  assert.equal(
    (DTS.match(/^\s*math: MathAPI;$/gm) ?? []).length,
    2,
    "expected `math: MathAPI;` on both Engine and Script",
  );
});

// The runtime side of the same contract: three separate wires, each of which
// can be cut without any other test noticing.
const source = (path) =>
  readFileSync(fileURLToPath(new URL(`../src/engine/${path}`, import.meta.url)), "utf8");

check('user scripts can `import { math } from "engine"`', () => {
  assert.match(source("scriptRuntime/runtime.js"), /export \{ math \} from "\.\.\/math\/index\.js";/);
});

check("engine.math is assigned on the Engine instance", () => {
  assert.match(source("Engine.js"), /this\.math = math;/);
  assert.match(source("Engine.js"), /import \{ math \} from "\.\/math\/index\.js";/);
});

check("this.math is injected on every script instance", () => {
  assert.match(source("components/ScriptComponent.js"), /instance\.math = math;/);
});

check("there is exactly one easing table", () => {
  // tween.js re-exports the math one; a second literal table here would mean
  // `math.ease.backOut` and `{ ease: "backOut" }` could silently diverge.
  const tween = source("tween.js");
  assert.match(tween, /export \{ EASINGS \} from "\.\/math\/easing\.js";/);
  assert.ok(!/EASINGS = \{/.test(tween), "tween.js redeclares the table");
});

check("the math package imports nothing outside itself", () => {
  // The property that lets this file run in plain Node, and lets a worker or a
  // build script use the package. One `import ... from "three"` would end it.
  for (const file of [
    "scalar.js", "angle.js", "easing.js", "random.js",
    "noise.js", "vector.js", "intersect.js", "trajectory.js", "bits.js", "index.js",
  ]) {
    // Only real import/export statements — the word "from" also appears in
    // prose inside these files' doc comments.
    const statements = /^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm;
    for (const [, specifier] of source(`math/${file}`).matchAll(statements)) {
      assert.ok(
        specifier.startsWith("./"),
        `math/${file} imports "${specifier}" — the package must stay dependency-free`,
      );
    }
  }
});

console.log(
  failures
    ? `\nMATH-TEST FAIL — ${failures}/${checks} checks failed`
    : `\nMATH-TEST PASS — ${checks}/${checks} checks`,
);
process.exit(failures ? 1 : 0);
