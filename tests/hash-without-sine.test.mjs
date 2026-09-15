import test from 'node:test';
import assert from 'node:assert/strict';
import { grassCellHash2, grassClumpHash } from '../src/modules/foliage/grassField.js';

// The shader hashes (grassMaterial `cellHash2`/`cellHash1`, waterFoam `hash2`,
// outputDither `hash22`) are Dave Hoskins' "hash without sine". `grassCellHash2`
// is the float32 CPU mirror of the exact hash22 constants all three share, and
// `grassClumpHash` of hash13. They replaced `fract(sin(x)·43758)`, whose quality
// depended on float32 `sin` precision at large arguments (mobile banding). These
// gates pin that the replacement stays uniform in [0,1) and decorrelated, over
// negative, small and very large (far-from-origin) integer cells alike.

const BINS = 20;
// χ² critical value, 19 degrees of freedom, p = 0.001.
const CHI2_CRIT = 43.82;

function chiSquare(values) {
  const counts = new Array(BINS).fill(0);
  for (const v of values) counts[Math.floor(v * BINS)]++;
  const expected = values.length / BINS;
  return counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
}

function correlation(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return cov / Math.sqrt(va * vb);
}

const ORIGINS = [[-100, -100], [0, 0], [27000, -41000], [-80000, 64000]];

for (const [ox, oz] of ORIGINS) {
  test(`hash22 (grass jitter / foam cells / output dither) is uniform and decorrelated near cell ${ox},${oz}`, () => {
    const u1 = [], u2 = [], right = [];
    for (let x = 0; x < 200; x++) for (let z = 0; z < 200; z++) {
      const [a, b] = grassCellHash2([ox + x, oz + z]);
      assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1, `range at ${ox + x},${oz + z}: ${a}, ${b}`);
      u1.push(a); u2.push(b);
      right.push(grassCellHash2([ox + x + 1, oz + z])[0]);
    }
    assert.ok(chiSquare(u1) < CHI2_CRIT, `u1 χ²=${chiSquare(u1).toFixed(1)}`);
    assert.ok(chiSquare(u2) < CHI2_CRIT, `u2 χ²=${chiSquare(u2).toFixed(1)}`);
    assert.ok(Math.abs(correlation(u1, u2)) < .02, `u1/u2 r=${correlation(u1, u2)}`);
    assert.ok(Math.abs(correlation(u1, right)) < .02, `neighbour r=${correlation(u1, right)}`);
  });

  test(`hash13 (salted grass cell hash) is uniform and salt-independent near cell ${ox},${oz}`, () => {
    const saltA = [], saltB = [];
    for (let x = 0; x < 200; x++) for (let z = 0; z < 200; z++) {
      const a = grassClumpHash([ox + x, oz + z], 17.3), b = grassClumpHash([ox + x, oz + z], 41.3);
      assert.ok(a >= 0 && a < 1, `range: ${a}`);
      saltA.push(a); saltB.push(b);
    }
    assert.ok(chiSquare(saltA) < CHI2_CRIT, `χ²=${chiSquare(saltA).toFixed(1)}`);
    assert.ok(chiSquare(saltB) < CHI2_CRIT, `χ²=${chiSquare(saltB).toFixed(1)}`);
    assert.ok(Math.abs(correlation(saltA, saltB)) < .02, `salt r=${correlation(saltA, saltB)}`);
  });
}

test('the fan-slot salts the grass shader actually uses stay mutually decorrelated', () => {
  // grassMaterial.js: slotAngle/slotRadius/vary/widthVary/yawJitter/depthJitter salts per fanSlot.
  const saltsFor = slot => [slot * 23.7 + 121.3, slot * 31.1 + 205.7, slot * 19.3 + 53.1, slot * 23.1 + 91.7, slot * 97.3 + 53.9, slot * 43.1 + 61.3];
  const columns = saltsFor(0).map(() => []);
  for (let slot = 0; slot < 12; slot++) for (let x = 0; x < 60; x++) for (let z = 0; z < 60; z++) {
    // The shader evaluates the salt expression in float32.
    saltsFor(slot).forEach((salt, i) => columns[i].push(grassClumpHash([x - 30, z + 900], Math.fround(salt))));
  }
  for (let i = 0; i < columns.length; i++) {
    assert.ok(chiSquare(columns[i]) < CHI2_CRIT, `salt ${i} χ²=${chiSquare(columns[i]).toFixed(1)}`);
    for (let j = i + 1; j < columns.length; j++) {
      assert.ok(Math.abs(correlation(columns[i], columns[j])) < .03, `salts ${i}/${j} r=${correlation(columns[i], columns[j])}`);
    }
  }
});

test('output dither keeps a zero-mean triangular PDF spanning ±1 LSB at pixel centres', () => {
  // outputDither.js: d = (n.x + n.y − 1)·LSB with n = hash22(screenCoordinate).
  const values = [];
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const [a, b] = grassCellHash2([x + .5, y + .5]);
    values.push(a + b - 1);
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  assert.ok(Math.abs(mean) < .01, `mean ${mean}`);
  // Triangular on [-1, 1]: variance 1/6. Uniform-sum shape, not a flat or peaked one.
  assert.ok(Math.abs(variance - 1 / 6) < .01, `variance ${variance}`);
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= -1 && hi < 1, `range [${lo}, ${hi}]`);
  const inner = values.filter(v => Math.abs(v) < .5).length / values.length;
  assert.ok(Math.abs(inner - .75) < .02, `|d|<.5 LSB fraction ${inner} (triangular = 0.75)`);
});
