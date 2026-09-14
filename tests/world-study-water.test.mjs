import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaneGeometry } from 'three/webgpu';
import { createStudyDomain, createStudyWaterGeometry, studySurface, STUDY_EXTENT } from '../scripts/lib/worldValleyStudy.js';
import { WATER_DOMAIN_DRY_HEIGHT } from '../src/modules/water/worldWaterDomain.js';

const resolution = 512, segments = 256, half = STUDY_EXTENT / 2;
const domain = createStudyDomain();
const packed = domain.rasterize({ minX: -half, minZ: -half, maxX: half, maxZ: half, width: resolution, height: resolution });

function packedHeight(x, z) {
  const col = Math.max(0, Math.min(resolution - 1, Math.floor((x + half) * resolution / STUDY_EXTENT)));
  const row = Math.max(0, Math.min(resolution - 1, Math.floor((z + half) * resolution / STUDY_EXTENT)));
  return packed[(row * resolution + col) * 4];
}

// Interpolate the actual indexed triangles, not the continuous input function.
function triangleSample(geometry, x, z) {
  const step = STUDY_EXTENT / segments, p = geometry.attributes.position;
  const col = Math.floor((x + half) / step), row = Math.floor((z + half) / step);
  const start = (row * segments + col) * 6;
  for (let triangle = 0; triangle < 2; triangle++) {
    const ids = [0, 1, 2].map(i => geometry.index.getX(start + triangle * 3 + i));
    const [a, b, c] = ids;
    const ax = p.getX(a), az = p.getZ(a), bx = p.getX(b), bz = p.getZ(b), cx = p.getX(c), cz = p.getZ(c);
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
    const wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) >= -1e-8) {
      return { height: wa * p.getY(a) + wb * p.getY(b) + wc * p.getY(c), ids };
    }
  }
  assert.fail(`No triangle at ${x}, ${z}`);
}

function wetPondTexels() {
  const result = [];
  for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
    const height = packed[(row * resolution + col) * 4];
    if (height !== 3 && height !== 4) continue;
    result.push({ x: -half + (col + .5) * STUDY_EXTENT / resolution, z: -half + (row + .5) * STUDY_EXTENT / resolution, height });
  }
  return result;
}

test('high-pond shoreline triangles retain water elevation where the exact packed mask is wet', () => {
  const geometry = createStudyWaterGeometry(domain), old = geometry.clone();
  try {
    const p = geometry.attributes.position, oldPositions = old.attributes.position;
    // Negative control: the original vertex shader nearest-sampled the packed
    // field, then clamped its dry sentinel to -10 before adding the water lift.
    for (let i = 0; i < oldPositions.count; i++) {
      oldPositions.setY(i, Math.max(-10, packedHeight(oldPositions.getX(i), oldPositions.getZ(i))) + .025);
    }
    let shorelineSamples = 0, oldSunkenSamples = 0;
    for (const texel of wetPondTexels()) {
      const sample = triangleSample(geometry, texel.x, texel.z);
      if (!sample.ids.some(i => packedHeight(p.getX(i), p.getZ(i)) === WATER_DOMAIN_DRY_HEIGHT)) continue;
      shorelineSamples++;
      assert.ok(Math.abs(sample.height - texel.height - .025) < 1e-5, 'wet shoreline triangle must stay at pond elevation');
      if (triangleSample(old, texel.x, texel.z).height < texel.height - .1) oldSunkenSamples++;
    }
    assert.ok(shorelineSamples > 50, 'exercise wet fragments in triangles containing dry vertices');
    assert.ok(oldSunkenSamples > 50, 'the previous sentinel displacement must fail the same coverage samples');
    assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
    assert.ok(geometry.boundingBox && geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius));
  } finally { geometry.dispose(); old.dispose(); }
});

test('actual upland wet texels remain above the triangulated terrain; old circular carve fails', () => {
  const geometry = new PlaneGeometry(STUDY_EXTENT, STUDY_EXTENT, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const old = geometry.clone();
  try {
    const p = geometry.attributes.position, oldPositions = old.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, studySurface(x, z).height);
      // Within this pond the old circle was the nearest body and its distance
      // stayed below the hillside blend's threshold. This is its original bed.
      const circularDistance = Math.hypot(x - 38, z + 32) - 3.5;
      oldPositions.setY(i, 4 + Math.max(-2, Math.min(2.5, circularDistance * .34)));
    }
    let wetSamples = 0, oldHiddenSamples = 0;
    for (const texel of wetPondTexels().filter(texel => texel.height === 4)) {
      wetSamples++;
      const waterHeight = texel.height + .025;
      assert.ok(triangleSample(geometry, texel.x, texel.z).height <= waterHeight, 'a packed wet texel must not be buried by terrain');
      if (triangleSample(old, texel.x, texel.z).height > waterHeight) oldHiddenSamples++;
    }
    assert.ok(wetSamples > 500, 'cover the full actual upland ellipse');
    assert.ok(oldHiddenSamples > 20, 'the old circular carve must obscure the elliptical footprint');
  } finally { geometry.dispose(); old.dispose(); }
});
