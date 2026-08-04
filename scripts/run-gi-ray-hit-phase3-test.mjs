import assert from "node:assert/strict";

import {
  CELL_LOCAL_PLANE_OFFSET_RANGE,
  COVERAGE_MASK_MASK,
  DominantAxis,
  SURFACE_RECORD_WORDS,
  buildCoverageMask,
  coverageMaskContainsPoint,
  dilateCoverageMask,
  dominantAxis,
  intersectPlaneCoverageCpu,
  octDecodeNormal,
  octEncodeNormal,
  packCoverageRecord,
  packOctNormal,
  packPlaneOffset,
  packSimplePlaneRecord,
  rasterizeTriangleCoverageMask,
  unpackCoverageRecord,
  unpackOctNormal,
  unpackPlaneOffset,
  unpackSimplePlaneRecord,
} from "../src/modules/gi/rayHit/RayHitPacking.js";

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalized(value) {
  const length = Math.hypot(...value);
  return value.map((component) => component / length);
}

function testNormalPacking() {
  const normals = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1], [1, 2, 3], [-4, 2, -1],
  ];
  for (const input of normals) {
    const expected = normalized(input);
    const floatingRoundTrip = octDecodeNormal(octEncodeNormal(input));
    const packedRoundTrip = unpackOctNormal(packOctNormal(input));
    assert.ok(dot(expected, floatingRoundTrip) > 0.999999999, `floating oct round-trip failed for ${input}`);
    assert.ok(dot(expected, packedRoundTrip) > 0.99999999, `packed oct round-trip failed for ${input}`);
    assert.ok(Math.abs(Math.hypot(...packedRoundTrip) - 1) < 1e-12);
  }
}

function testPlaneAndRecordPacking() {
  const quantizationStep = CELL_LOCAL_PLANE_OFFSET_RANGE / 32767;
  for (const offset of [-CELL_LOCAL_PLANE_OFFSET_RANGE, -0.73, 0, 0.42, CELL_LOCAL_PLANE_OFFSET_RANGE]) {
    const decoded = unpackPlaneOffset(packPlaneOffset(offset));
    assert.ok(Math.abs(decoded - offset) <= quantizationStep, `plane offset error for ${offset}`);
  }

  const words = packSimplePlaneRecord({
    normal: normalized([1, -2, 4]),
    planeOffset: 0.375,
    coverage: 173,
    confidence: 229,
    materialId: 0xfedcba98,
    flags: 0x87654321,
  });
  assert.equal(words.length, SURFACE_RECORD_WORDS);
  const decoded = unpackSimplePlaneRecord(words);
  assert.ok(dot(decoded.normal, normalized([1, -2, 4])) > 0.99999999);
  assert.ok(Math.abs(decoded.planeOffset - 0.375) <= quantizationStep);
  assert.equal(decoded.coverage, 173);
  assert.equal(decoded.confidence, 229);
  assert.equal(decoded.materialId, 0xfedcba98);
  assert.equal(decoded.flags, 0x87654321);
}

function testDominantAxisAndCoveragePacking() {
  assert.equal(dominantAxis([4, 4, 1]), DominantAxis.X, "axis ties must be stable");
  assert.equal(dominantAxis([1, -5, 5]), DominantAxis.Y);
  assert.equal(dominantAxis([1, 2, -8]), DominantAxis.Z);

  const packed = packCoverageRecord({ mask: 0xa55a, axis: DominantAxis.Y, valid: true, flags: 0x12ab });
  assert.deepEqual(unpackCoverageRecord(packed), {
    mask: 0xa55a,
    axis: DominantAxis.Y,
    valid: true,
    flags: 0x12ab,
  });
  assert.equal(dilateCoverageMask(1 << 5), 0x0777, "center texel must expand to its 3x3 neighborhood");
  assert.equal(dilateCoverageMask(1), 0x0033, "corner dilation must not wrap across rows");
  assert.equal(dilateCoverageMask(COVERAGE_MASK_MASK), COVERAGE_MASK_MASK);
}

function testConservativeRasterization() {
  const triangle = [
    [0.30, 0.30, 0.5],
    [0.44, 0.30, 0.5],
    [0.30, 0.44, 0.5],
  ];
  const raw = rasterizeTriangleCoverageMask(...triangle, { axis: DominantAxis.Z, dilate: false });
  assert.equal(raw, 1 << 5, "triangle wholly inside texel (1,1) should set that texel");
  const conservative = rasterizeTriangleCoverageMask(...triangle);
  assert.equal(conservative, 0x0777, "default rasterization must include one-texel dilation");

  // Boundary contact is deliberately conservative: both adjacent texels set.
  const boundaryTriangle = [
    [0.25, 0.05, 0.5],
    [0.25, 0.20, 0.5],
    [0.40, 0.10, 0.5],
  ];
  const boundaryMask = rasterizeTriangleCoverageMask(...boundaryTriangle, { axis: DominantAxis.Z, dilate: false });
  assert.ok((boundaryMask & 0b11) === 0b11);

  const secondTriangle = triangle.map(([x, y, z]) => [x + 0.45, y + 0.45, z]);
  const built = buildCoverageMask([triangle, secondTriangle], [0, 0, 1], { dilate: false });
  assert.equal(built.axis, DominantAxis.Z);
  assert.ok(coverageMaskContainsPoint(built.mask, [0.35, 0.35, 0.5], built.axis));
  assert.ok(coverageMaskContainsPoint(built.mask, [0.80, 0.80, 0.5], built.axis));
  assert.ok(!coverageMaskContainsPoint(built.mask, [0.05, 0.95, 0.5], built.axis));
}

function testCoverageIntersection() {
  const triangle = [
    [0.05, 0.05, 0.5],
    [0.12, 0.05, 0.5],
    [0.05, 0.12, 0.5],
  ];
  const { mask, axis } = buildCoverageMask([triangle], [0, 0, 1]);
  const hit = intersectPlaneCoverageCpu(
    [0.08, 0.08, -1], [0, 0, 1], [0, 0, 1], 0.5, mask, axis,
  );
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.t - 1.5) < 1e-12);

  const opening = intersectPlaneCoverageCpu(
    [0.9, 0.9, -1], [0, 0, 1], [0, 0, 1], 0.5, mask, axis,
  );
  assert.deepEqual(opening.reason, "coverage");
  const parallel = intersectPlaneCoverageCpu(
    [0.08, 0.08, 0.5], [1, 0, 0], [0, 0, 1], 0.5, mask, axis,
  );
  assert.deepEqual(parallel, { hit: false, reason: "parallel" });
}

testNormalPacking();
testPlaneAndRecordPacking();
testDominantAxisAndCoveragePacking();
testConservativeRasterization();
testCoverageIntersection();

console.log("GI ray-hit Phase 3 packing tests PASS");
