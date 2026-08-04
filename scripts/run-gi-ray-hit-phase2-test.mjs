// Phase-2/3 CPU validation: fitted simple-plane records + coverage masks vs
// exact double-precision triangle intersection. Everything runs in level-0
// voxel space with unit cells, the same space the GPU passes use, so plane
// offsets, intervals and normals are directly comparable to world space.
import {
  BRICK_SURFACE_OFFSET_WORD,
  INVALID_RAY_HIT_INDEX,
  SURFACE_FLAG_SIMPLE,
  SURFACE_RECORD_WORDS,
  SURFACE_FLAGS_WORD,
  COVERAGE_FLAGS_SHIFT,
  buildHybridBrickWords,
  buildSurfaceRecordsCpu,
  brickHeaderWord,
  dilateCoverageMask,
  popcount32,
  traceHybridBrickBoxesCpu,
  traceHybridPlaneCpu,
  triBoxOverlapCpu,
  unpackSimplePlaneRecord,
  voxelIndexInBrick,
} from "../src/modules/gi/rayHit/RayHitPacking.js";
import { traceTrianglesExact, validateRayHits } from "../src/modules/gi/rayHit/RayHitValidator.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};

// ---------------------------------------------------------------------------
// GPU dilation parity: the finalize pass dilates with nibble-masked shifts.
// Prove the bit trick equals dilateCoverageMask on every possible mask.
{
  const bitDilate = (m) => {
    const h = (m | ((m << 1) & 0xeeee) | ((m >>> 1) & 0x7777)) & 0xffff;
    return (h | (h << 4) | (h >>> 4)) & 0xffff;
  };
  let mismatches = 0;
  for (let mask = 0; mask < 0x10000; mask++) {
    if (bitDilate(mask) !== dilateCoverageMask(mask, 1)) mismatches++;
  }
  check("GPU bitwise dilation equals dilateCoverageMask for all 65536 masks", mismatches === 0, `mismatches=${mismatches}`);
}

// ---------------------------------------------------------------------------
// Shared scene machinery: conservative CPU voxelization with the same SAT and
// span the GPU voxelizer uses, then the full Phase-1 + Phase-2 build.
const buildScene = (resolution, triangles, options = {}) => {
  const occupied = new Set();
  const h = 0.5 + 1e-4;
  for (const [a, b, c] of triangles) {
    const lo = [0, 1, 2].map((axis) =>
      Math.max(0, Math.floor(Math.min(a[axis], b[axis], c[axis]) - 0.5)));
    const hi = [0, 1, 2].map((axis) => Math.min(
      [resolution.x, resolution.y, resolution.z][axis] - 1,
      Math.floor(Math.max(a[axis], b[axis], c[axis]) + 0.5)));
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let x = lo[0]; x <= hi[0]; x++) {
          if (triBoxOverlapCpu([x + 0.5, y + 0.5, z + 0.5], h, a, b, c)) occupied.add(`${x},${y},${z}`);
        }
      }
    }
  }
  const { layout, words } = buildHybridBrickWords(
    resolution, (x, y, z) => occupied.has(`${x},${y},${z}`),
  );
  const surfaces = buildSurfaceRecordsCpu(resolution, words, layout, triangles, options);
  const exact = triangles.map(([a, b, c]) => ({ a, b, c }));
  return { occupied, layout, words, surfaces, exact };
};

const planeCandidate = (scene, coverage) => (ray) => {
  const hit = traceHybridPlaneCpu(
    ray.origin, ray.direction, scene.resolution, scene.words, scene.layout,
    scene.surfaces.records, { tMax: ray.maxT, coverage },
  );
  return hit.hit ? { t: hit.t, normal: hit.normal } : { t: -1 };
};
const boxCandidate = (scene) => (ray) => {
  const hit = traceHybridBrickBoxesCpu(
    ray.origin, ray.direction, scene.resolution, scene.words, scene.layout, { tMax: ray.maxT },
  );
  return hit.hit ? { t: hit.t } : { t: -1 };
};

const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];

// ---------------------------------------------------------------------------
// Scene A: flat axis-aligned floor at y = 3.25 (mid-cell). The Phase-2
// acceptance case: distance error should collapse from ~voxel scale to
// ~quantization scale, and normals become exact instead of face-quantized.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = quad([1, 3.25, 1], [15, 3.25, 1], [15, 3.25, 15], [1, 3.25, 15]);
  const scene = { resolution, ...buildScene(resolution, triangles) };

  // Inspect one interior floor cell's record directly.
  const surfaceOffset = scene.words[brickHeaderWord(scene.layout, (2 * scene.layout.macroResolution.y + 0) * scene.layout.macroResolution.x + 2, BRICK_SURFACE_OFFSET_WORD)];
  check("floor bricks allocate surface records", surfaceOffset !== INVALID_RAY_HIT_INDEX);
  const low = scene.words[brickHeaderWord(scene.layout, (2 * scene.layout.macroResolution.y + 0) * scene.layout.macroResolution.x + 2, 0)];
  const bit = voxelIndexInBrick(0, 3, 0); // cell (8, 3, 8) → local (0,3,0)
  const rank = popcount32(low & ((1 << bit) - 1));
  const packed = scene.surfaces.records.slice(
    (surfaceOffset + rank) * SURFACE_RECORD_WORDS,
    (surfaceOffset + rank) * SURFACE_RECORD_WORDS + SURFACE_RECORD_WORDS,
  );
  const decoded = unpackSimplePlaneRecord(packed);
  const simpleFlag = ((packed[SURFACE_FLAGS_WORD] >>> COVERAGE_FLAGS_SHIFT) & SURFACE_FLAG_SIMPLE) !== 0;
  check("floor cell classifies simple", simpleFlag);
  check("floor record normal is +Y", Math.abs(decoded.normal[1]) > 0.999, `n=${decoded.normal}`);
  check("floor record plane offset is 0.25 cell-local", Math.abs(Math.abs(decoded.planeOffset) - 0.25) < 2e-3, `d=${decoded.planeOffset}`);

  const rays = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      rays.push({ origin: [2.3 + i, 9, 2.7 + j], direction: [0, -1, 0], maxT: 12 });
    }
  }
  const planeReport = validateRayHits(rays, scene.exact, planeCandidate(scene, false));
  const coverReport = validateRayHits(rays, scene.exact, planeCandidate(scene, true));
  const boxReport = validateRayHits(rays, scene.exact, boxCandidate(scene));
  check("floor: plane mode adds no false negatives", planeReport.falseNegatives === 0, JSON.stringify(planeReport));
  check("floor: coverage mode adds no false negatives", coverReport.falseNegatives === 0, JSON.stringify(coverReport));
  check(
    "floor: plane distance error collapses vs boxes",
    planeReport.distanceErrorMedian < 0.01 && boxReport.distanceErrorMedian > 0.2,
    `plane=${planeReport.distanceErrorMedian.toExponential(2)} box=${boxReport.distanceErrorMedian.toFixed(3)}`,
  );
  check(
    "floor: plane normals are exact",
    planeReport.normalErrorMedianDegrees < 0.5,
    `median=${planeReport.normalErrorMedianDegrees.toFixed(3)}deg`,
  );
}

// ---------------------------------------------------------------------------
// Scene E-lite: 45-degree ramp. Oblique normals cannot be represented by voxel
// faces at all; the fitted plane must recover both distance and orientation.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = quad([4, 2, 2], [12, 10, 2], [12, 10, 14], [4, 2, 14]);
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const rays = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      rays.push({ origin: [5.2 + i * 0.6, 13, 3.1 + j], direction: [0, -1, 0], maxT: 13 });
    }
  }
  const planeReport = validateRayHits(rays, scene.exact, planeCandidate(scene, true));
  const boxReport = validateRayHits(rays, scene.exact, boxCandidate(scene));
  check("ramp: no false negatives", planeReport.falseNegatives === 0, JSON.stringify(planeReport));
  check(
    "ramp: distance error improves substantially",
    planeReport.distanceErrorMedian < boxReport.distanceErrorMedian / 5,
    `plane=${planeReport.distanceErrorMedian.toFixed(4)} box=${boxReport.distanceErrorMedian.toFixed(3)}`,
  );
  check(
    "ramp: oblique normal recovered within 10 degrees",
    planeReport.normalErrorMedianDegrees < 10,
    `median=${planeReport.normalErrorMedianDegrees.toFixed(2)}deg`,
  );
}

// ---------------------------------------------------------------------------
// Scene B: closed room, rays outward from the centre. The leak gate — plane
// resolution may sharpen hits but must never let a ray out of a sealed box.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const lo = 4, hi = 12;
  const c = (x, y, z) => [x, y, z];
  const triangles = [
    ...quad(c(lo, lo, lo), c(hi, lo, lo), c(hi, lo, hi), c(lo, lo, hi)),   // floor
    ...quad(c(lo, hi, lo), c(hi, hi, lo), c(hi, hi, hi), c(lo, hi, hi)),   // ceiling
    ...quad(c(lo, lo, lo), c(lo, hi, lo), c(lo, hi, hi), c(lo, lo, hi)),   // -x wall
    ...quad(c(hi, lo, lo), c(hi, hi, lo), c(hi, hi, hi), c(hi, lo, hi)),   // +x wall
    ...quad(c(lo, lo, lo), c(hi, lo, lo), c(hi, hi, lo), c(lo, hi, lo)),   // -z wall
    ...quad(c(lo, lo, hi), c(hi, lo, hi), c(hi, hi, hi), c(lo, hi, hi)),   // +z wall
  ];
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const rays = [];
  const count = 400;
  for (let i = 0; i < count; i++) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    rays.push({
      origin: [8, 8, 8],
      direction: [Math.cos(theta) * radius, y, Math.sin(theta) * radius],
      maxT: 24,
    });
  }
  for (const coverage of [false, true]) {
    const report = validateRayHits(rays, scene.exact, planeCandidate(scene, coverage));
    check(
      `sealed room stays sealed (coverage=${coverage})`,
      report.falseNegatives === 0,
      `FN=${report.falseNegatives}/${rays.length}`,
    );
  }
  const stats = scene.surfaces;
  check("room build classifies a mix of cells", stats.simpleCells > 0 && stats.complexCells > 0,
    `simple=${stats.simpleCells} complex=${stats.complexCells} allocated=${stats.allocated}`);
}

// ---------------------------------------------------------------------------
// Scene C/D: two opposing faces inside one voxel column (a 0.2-cell wall).
// Opposing normals cancel → coherence fails → complex → conservative box.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = [
    ...quad([8.4, 2, 2], [8.4, 14, 2], [8.4, 14, 14], [8.4, 2, 14]),
    ...quad([8.6, 2, 2], [8.6, 14, 2], [8.6, 14, 14], [8.6, 2, 14]),
  ];
  // Give the two walls opposing orientations explicitly.
  const flip = ([a, b, c]) => [a, c, b];
  const oriented = [triangles[0], triangles[1], flip(triangles[2]), flip(triangles[3])];
  const scene = { resolution, ...buildScene(resolution, oriented) };
  const rays = [];
  for (let i = 0; i < 8; i++) {
    rays.push({ origin: [2, 3.4 + i, 8.2 + i * 0.4], direction: [1, 0, 0], maxT: 14 });
    rays.push({ origin: [14, 3.4 + i, 8.2 + i * 0.4], direction: [-1, 0, 0], maxT: 14 });
  }
  const report = validateRayHits(rays, scene.exact, planeCandidate(scene, true));
  check("thin double-faced wall never leaks", report.falseNegatives === 0, `FN=${report.falseNegatives}`);
  check(
    "thin-wall cells fall back to complex/box",
    scene.surfaces.complexCells > 0,
    `complex=${scene.surfaces.complexCells}`,
  );
}

// ---------------------------------------------------------------------------
// Phase-3 acceptance: a quarter-cell triangle. Without coverage the infinite
// plane false-hits; with the mask the ray through the open part passes.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = [[[8, 8.5, 8], [8.45, 8.5, 8], [8, 8.5, 8.45]]];
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const hitRay = { origin: [8.05, 12, 8.05], direction: [0, -1, 0], maxT: 8 };
  const missRay = { origin: [8.9, 12, 8.9], direction: [0, -1, 0], maxT: 8 };

  const cov = planeCandidate(scene, true);
  const noCov = planeCandidate(scene, false);
  const exactHit = traceTrianglesExact(hitRay.origin, hitRay.direction, scene.exact, hitRay);
  const covHit = cov(hitRay);
  check("coverage keeps the covered hit", exactHit && covHit.t > 0 && Math.abs(covHit.t - exactHit.t) < 0.01,
    `exact=${exactHit?.t} cov=${covHit.t}`);
  check("uncovered texel rejects the infinite-plane false hit", cov(missRay).t < 0, `t=${cov(missRay).t}`);
  check("without coverage the plane false-hits (the Phase-3 gap)", noCov(missRay).t > 0);
}

// ---------------------------------------------------------------------------
// Pool overflow: a deliberately starved pool must degrade to occupied-box
// fallback — sealed, never leaking, never missing.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = quad([1, 3.25, 1], [15, 3.25, 1], [15, 3.25, 15], [1, 3.25, 15]);
  const scene = { resolution, ...buildScene(resolution, triangles, { capacity: 8 }) };
  check("starved pool reports overflow", scene.surfaces.overflowBricks > 0,
    `overflow=${scene.surfaces.overflowBricks}`);
  const rays = [];
  for (let i = 0; i < 10; i++) rays.push({ origin: [2.4 + i, 9, 8.3], direction: [0, -1, 0], maxT: 12 });
  const report = validateRayHits(rays, scene.exact, planeCandidate(scene, true));
  check("starved pool still blocks every ray", report.falseNegatives === 0, `FN=${report.falseNegatives}`);
}

// ---------------------------------------------------------------------------
// Counters: bounded traversal and sensible plane accounting on the floor.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const triangles = quad([1, 3.25, 1], [15, 3.25, 1], [15, 3.25, 15], [1, 3.25, 15]);
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const hit = traceHybridPlaneCpu([8.2, 9, 8.2], [0, -1, 0], resolution, scene.words, scene.layout,
    scene.surfaces.records, { tMax: 12, coverage: true });
  check("floor trace resolves via a plane", hit.hit && hit.kind === "plane", JSON.stringify(hit.counters));
  check("plane counters are sensible",
    hit.counters.planeTests === hit.counters.planeAccepts + hit.counters.planeRejects &&
    hit.counters.planeAccepts === 1 && hit.counters.surfaceFallbacks === 0,
    JSON.stringify(hit.counters));
  check("traversal stays bounded", hit.macroSteps <= 128 && hit.brickSteps <= 16 * hit.macroSteps,
    `macro=${hit.macroSteps} brick=${hit.brickSteps}`);
}

console.log(failed === 0 ? "\nGI-RAY-HIT-PHASE2 ALL PASS" : `\nGI-RAY-HIT-PHASE2 ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
