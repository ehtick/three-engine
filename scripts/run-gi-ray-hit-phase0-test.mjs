import {
  buildWorldTriangles,
  intersectRayTriangle,
  traceTrianglesExact,
  validateRayHits,
} from "../src/modules/gi/rayHit/RayHitValidator.js";
import {
  RayHitMode,
  normalizeRayHitMode,
  rayHitModeName,
  resolveRayHitConfig,
} from "../src/modules/gi/rayHit/RayHitConfig.js";
import { RayHitCounter } from "../src/modules/gi/rayHit/RayHitDebug.js";
import {
  BRICK_VOXEL_COUNT,
  INVALID_RAY_HIT_INDEX,
  MacroCellType,
  buildHybridBrickWords,
  hybridBrickOccupied,
  macroCellWord,
  MACRO_CELL_BRICK_INDEX_WORD,
  traceHybridBrickBoxesCpu,
  traceVoxelBoxesCpu,
  unpackMacroCellMetadata,
  voxelIndexInBrick,
} from "../src/modules/gi/rayHit/RayHitPacking.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};
const near = (a, b, epsilon = 1e-8) => Math.abs(a - b) <= epsilon;

check("mode enum is stable", RayHitMode.OccupancyLegacy === 0 && RayHitMode.HybridExactComplex === 4);
check("mode names normalize", normalizeRayHitMode("hybrid-plane") === RayHitMode.HybridPlane);
check("unknown mode fails safely", normalizeRayHitMode("future-mode") === RayHitMode.OccupancyLegacy);
check("mode name round-trips", rayHitModeName(RayHitMode.HybridPlaneCoverage) === "hybrid-plane-coverage");
const phase4 = resolveRayHitConfig({ rayHitMode: "hybrid-exact-complex", rayHitProfiling: true }, {});
check("Phase-4 exact-complex mode activates", !phase4.fallbackToLegacy && phase4.activeMode === RayHitMode.HybridExactComplex);
const phase1 = resolveRayHitConfig({ rayHitMode: "hybrid-brick-box" }, {});
check("Phase-1 brick mode activates", !phase1.fallbackToLegacy && phase1.activeMode === RayHitMode.HybridBrickBox);
const phase2 = resolveRayHitConfig({ rayHitMode: "hybrid-plane" }, {});
check("Phase-2 plane mode activates", !phase2.fallbackToLegacy && phase2.activeMode === RayHitMode.HybridPlane);
const phase3 = resolveRayHitConfig({ rayHitMode: "hybrid-plane-coverage" }, {});
check("Phase-3 coverage mode activates", !phase3.fallbackToLegacy && phase3.activeMode === RayHitMode.HybridPlaneCoverage);
check("profiling opt-in resolves", phase4.enableProfiling === true);
check("counter buffer remains one aligned record", RayHitCounter.Count === 24 && (RayHitCounter.Count * 4) % 16 === 0);

check("brick indexing convention is x + y*4 + z*16", voxelIndexInBrick(3, 3, 3) === 63);
check("brick mask spans exactly 64 cells", BRICK_VOXEL_COUNT === 64);
const brickRes = { x: 7, y: 5, z: 6 };
const occupiedCells = new Set(["0,0,0", "3,3,1", "4,0,0", "6,4,5", "2,1,4"]);
const isOccupied = (x, y, z) => occupiedCells.has(`${x},${y},${z}`);
const packedBricks = buildHybridBrickWords(brickRes, isOccupied);
let packingMatches = true;
for (let z = 0; z < brickRes.z; z++) {
  for (let y = 0; y < brickRes.y; y++) {
    for (let x = 0; x < brickRes.x; x++) {
      packingMatches &&= hybridBrickOccupied(
        packedBricks.words, packedBricks.layout, x, y, z, brickRes,
      ) === isOccupied(x, y, z);
    }
  }
}
check("brick packing exactly reconstructs non-multiple-of-four edges", packingMatches);
const emptyMacroIndex = 3;
const emptyBrickIndex = packedBricks.words[macroCellWord(
  packedBricks.layout, emptyMacroIndex, MACRO_CELL_BRICK_INDEX_WORD,
)];
check("empty macrocells never expose a brick", emptyBrickIndex === INVALID_RAY_HIT_INDEX);
const occupiedMetadata = unpackMacroCellMetadata(packedBricks.words[1]);
check("occupied macro metadata selects a brick", occupiedMetadata.type === MacroCellType.Brick);

const ddaRes = { x: 8, y: 8, z: 8 };
const ddaOccupied = new Set(["1,1,1", "4,2,6", "7,7,7"]);
const ddaPredicate = (x, y, z) => ddaOccupied.has(`${x},${y},${z}`);
const ddaPacked = buildHybridBrickWords(ddaRes, ddaPredicate);
const ddaRays = [
  { origin: [0.1, 1.2, 1.2], direction: [1, 0, 0], tMax: 8 },
  { origin: [7.9, 7.2, 7.2], direction: [-1, 0, 0], tMax: 8 },
  { origin: [4.2, 2.2, 0.1], direction: [0, 0, 1], tMax: 8 },
  { origin: [0.2, 5.2, 0.2], direction: [0, 0, 1], tMax: 8 },
  { origin: [1.2, 1.2, 1.2], direction: [0, 1, 0], tMax: 8 },
];
let traversalMatches = true;
let bounded = true;
for (const ray of ddaRays) {
  const legacyBox = traceVoxelBoxesCpu(ray.origin, ray.direction, ddaRes, ddaPredicate, ray);
  const hybridBox = traceHybridBrickBoxesCpu(
    ray.origin, ray.direction, ddaRes, ddaPacked.words, ddaPacked.layout, ray,
  );
  traversalMatches &&= legacyBox.hit === hybridBox.hit &&
    (!legacyBox.hit || (legacyBox.voxel.join(",") === hybridBox.voxel.join(",") && near(legacyBox.t, hybridBox.t, 1e-3)));
  bounded &&= hybridBox.resolved === true && (hybridBox.brickSteps ?? 0) <= 16 * (hybridBox.macroSteps ?? 1);
}
check("coarse/local DDA matches legacy occupied-box hits", traversalMatches);
check("coarse/local DDA counters stay bounded", bounded);

const plane = [
  { a: [-1, -1, 0], b: [1, -1, 0], c: [1, 1, 0] },
  { a: [-1, -1, 0], b: [1, 1, 0], c: [-1, 1, 0] },
];
const hit = traceTrianglesExact([0, 0, 2], [0, 0, -1], plane, { minT: 0, maxT: 10 });
check("exact plane hit distance", hit && near(hit.t, 2), `t=${hit?.t}`);
check("exact plane normal faces ray", hit && hit.normal.z > 0.999);
check("axis-parallel ray misses cleanly", intersectRayTriangle([0, 0, 2], [1, 0, 0], plane[0].a, plane[0].b, plane[0].c) === null);
check("tMax clips exact hit", traceTrianglesExact([0, 0, 2], [0, 0, -1], plane, { maxT: 1.9 }) === null);
check("double-sided hit is intentional", !!traceTrianglesExact([0, 0, -2], [0, 0, 1], plane));
check("single-sided backface rejects", traceTrianglesExact([0, 0, -2], [0, 0, 1], plane, { doubleSided: false }) === null);

const geometry = {
  key: "tri",
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  index: new Uint32Array([0, 1, 2]),
};
const translation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, -3, -2, 1];
const world = buildWorldTriangles([geometry], [{ geometryKey: "tri", matrix: translation }]);
const negativeHit = traceTrianglesExact([-3.75, -2.75, 1], [0, 0, -1], world);
check("placements transform into negative world coordinates", negativeHit && near(negativeHit.t, 3));

const rays = [
  { origin: [0, 0, 2], direction: [0, 0, -1], maxT: 10 },
  { origin: [5, 5, 2], direction: [0, 0, -1], maxT: 10 },
];
const exactCandidate = (ray) => traceTrianglesExact(ray.origin, ray.direction, plane, ray);
const report = validateRayHits(rays, plane, exactCandidate);
check("validator reports exact agreement", report.falsePositives === 0 && report.falseNegatives === 0);
check("validator distance error is zero", report.distanceErrorP95 === 0);
const sentinelReport = validateRayHits([rays[1]], plane, () => ({ t: -1 }));
check("validator understands the GPU negative-t miss sentinel", sentinelReport.falsePositives === 0);

console.log(failed === 0 ? "\nGI-RAY-HIT-PHASE1 ALL PASS" : `\nGI-RAY-HIT-PHASE1 ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
