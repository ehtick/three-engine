// Phase-4 CPU validation: complex cells that a fitted plane cannot represent
// resolve against their own bounded triangle list instead of the occupied box.
// Everything runs in level-0 voxel space with unit cells — the space the GPU
// passes use — so distances and normals compare directly against the exact
// double-precision triangle reference.
import {
  COMPLEX_RANGE_OFFSET_MASK,
  MAX_COMPLEX_TRIANGLES,
  buildHybridBrickWords,
  buildSurfaceRecordsCpu,
  packComplexRange,
  traceHybridBrickBoxesCpu,
  traceHybridPlaneCpu,
  triBoxOverlapCpu,
  unpackComplexRange,
} from "../src/modules/gi/rayHit/RayHitPacking.js";
import { traceTrianglesExact, validateRayHits } from "../src/modules/gi/rayHit/RayHitValidator.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};

// ---------------------------------------------------------------------------
// Shared scene machinery: conservative CPU voxelization with the same SAT and
// span the GPU voxelizer uses, then the full Phase-1 + Phase-2/4 build.
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

const trace = (scene, ray, { coverage = true, exactComplex = true } = {}) => traceHybridPlaneCpu(
  ray.origin, ray.direction, scene.resolution, scene.words, scene.layout, scene.surfaces.records,
  {
    tMax: ray.maxT,
    coverage,
    exactComplex,
    trianglePool: exactComplex ? scene.surfaces.trianglePool : null,
  },
);
const planeCandidate = (scene, options) => (ray) => {
  const hit = trace(scene, ray, options);
  return hit.hit ? { t: hit.t, normal: hit.normal, kind: hit.kind } : { t: -1 };
};
const boxCandidate = (scene) => (ray) => {
  const hit = traceHybridBrickBoxesCpu(
    ray.origin, ray.direction, scene.resolution, scene.words, scene.layout, { tMax: ray.maxT },
  );
  return hit.hit ? { t: hit.t } : { t: -1 };
};

const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const flip = ([a, b, c]) => [a, c, b];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize3 = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

// Two opposing faces 0.2 cells apart inside one voxel column. Their normals
// cancel exactly, so no plane exists to fit — the canonical Phase-4 cell.
const THIN_WALL_RESOLUTION = { x: 16, y: 16, z: 16 };
const thinWallTriangles = (() => {
  const walls = [
    ...quad([8.4, 2, 2], [8.4, 14, 2], [8.4, 14, 14], [8.4, 2, 14]),
    ...quad([8.6, 2, 2], [8.6, 14, 2], [8.6, 14, 14], [8.6, 2, 14]),
  ];
  return [walls[0], walls[1], flip(walls[2]), flip(walls[3])];
})();
const thinWallRays = (() => {
  const rays = [];
  for (let i = 0; i < 8; i++) {
    rays.push({ origin: [2, 3.4 + i, 8.2 + i * 0.4], direction: [1, 0, 0], maxT: 14 });
    rays.push({ origin: [14, 3.4 + i, 8.2 + i * 0.4], direction: [-1, 0, 0], maxT: 14 });
  }
  return rays;
})();

// UV sphere with outward-facing winding; the curved-surface case where every
// cell holds a handful of differently-oriented triangles.
const uvSphere = (center, radius, longitudes, latitudes) => {
  const point = (lon, lat) => {
    const phi = (lon / longitudes) * Math.PI * 2;
    const theta = (lat / latitudes) * Math.PI;
    const ring = Math.sin(theta);
    return [
      center[0] + radius * ring * Math.cos(phi),
      center[1] + radius * Math.cos(theta),
      center[2] + radius * ring * Math.sin(phi),
    ];
  };
  const outward = (triangle) => {
    const [a, b, c] = triangle;
    const e0 = sub3(b, a);
    const e1 = sub3(c, a);
    const normal = [
      e0[1] * e1[2] - e0[2] * e1[1],
      e0[2] * e1[0] - e0[0] * e1[2],
      e0[0] * e1[1] - e0[1] * e1[0],
    ];
    const radial = sub3([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], center);
    const facing = normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2];
    return facing >= 0 ? triangle : flip(triangle);
  };
  const triangles = [];
  for (let lat = 0; lat < latitudes; lat++) {
    for (let lon = 0; lon < longitudes; lon++) {
      const a = point(lon, lat);
      const b = point(lon + 1, lat);
      const c = point(lon + 1, lat + 1);
      const d = point(lon, lat + 1);
      if (lat > 0) triangles.push(outward([a, b, c]));            // pole rings are degenerate
      if (lat < latitudes - 1) triangles.push(outward([a, c, d]));
    }
  }
  return triangles;
};

// ---------------------------------------------------------------------------
// Range packing: word 2 carries a 26-bit pool offset and a 6-bit count.
{
  let mismatches = 0;
  for (const offset of [0, 1, 65535, COMPLEX_RANGE_OFFSET_MASK]) {
    for (const count of [0, 1, MAX_COMPLEX_TRIANGLES, 63]) {
      const decoded = unpackComplexRange(packComplexRange(offset, count));
      if (decoded.offset !== offset || decoded.count !== count) mismatches++;
    }
  }
  check("complex range round-trips at both field limits", mismatches === 0, `mismatches=${mismatches}`);
}

// ---------------------------------------------------------------------------
// Scene 1: the thin double-faced wall. Phase 2 could only report the entry
// face of the occupied cell; the triangle list resolves the real surface.
{
  const resolution = THIN_WALL_RESOLUTION;
  const scene = { resolution, ...buildScene(resolution, thinWallTriangles) };
  check("thin-wall cells pack exact triangle lists",
    scene.surfaces.complexRecords > 0 && scene.surfaces.complexTriangles > 0 &&
    scene.surfaces.complexOverflowCells === 0,
    `records=${scene.surfaces.complexRecords} triangles=${scene.surfaces.complexTriangles} overflow=${scene.surfaces.complexOverflowCells}`);

  let worstError = 0;
  let nonTriangle = 0;
  for (const ray of thinWallRays) {
    const exact = traceTrianglesExact(ray.origin, ray.direction, scene.exact, ray);
    const hit = trace(scene, ray);
    if (!hit.hit || hit.kind !== "triangles") { nonTriangle++; continue; }
    worstError = Math.max(worstError, Math.abs(hit.t - exact.t));
  }
  check("thin wall: every ray resolves against triangles", nonTriangle === 0, `other=${nonTriangle}`);
  check("thin wall: the near face is exact from both sides", worstError < 1e-3,
    `maxError=${worstError.toExponential(2)}`);

  const exactReport = validateRayHits(thinWallRays, scene.exact, planeCandidate(scene));
  const boxReport = validateRayHits(thinWallRays, scene.exact, boxCandidate(scene));
  check("thin wall: no false negatives", exactReport.falseNegatives === 0, JSON.stringify(exactReport));
  check("thin wall: box error is a voxel, exact-complex error is not",
    boxReport.distanceErrorMedian > 0.3 && exactReport.distanceErrorMedian < 1e-3,
    `box=${boxReport.distanceErrorMedian.toFixed(3)} exact=${exactReport.distanceErrorMedian.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// Scene 2: sealed room, rays outward from the centre. Corners hold two or
// three wall planes at once and used to fall back to the box; the leak gate
// must still hold now that a complex cell is allowed to report a real miss.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const lo = 4, hi = 12;
  const triangles = [
    ...quad([lo, lo, lo], [hi, lo, lo], [hi, lo, hi], [lo, lo, hi]),   // floor
    ...quad([lo, hi, lo], [hi, hi, lo], [hi, hi, hi], [lo, hi, hi]),   // ceiling
    ...quad([lo, lo, lo], [lo, hi, lo], [lo, hi, hi], [lo, lo, hi]),   // -x wall
    ...quad([hi, lo, lo], [hi, hi, lo], [hi, hi, hi], [hi, lo, hi]),   // +x wall
    ...quad([lo, lo, lo], [hi, lo, lo], [hi, hi, lo], [lo, hi, lo]),   // -z wall
    ...quad([lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, hi, hi]),   // +z wall
  ];
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const rays = [];
  const count = 200;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    rays.push({
      origin: [8, 8, 8],
      direction: [Math.cos(theta) * radius, y, Math.sin(theta) * radius],
      maxT: 24,
    });
  }
  const exactReport = validateRayHits(rays, scene.exact, planeCandidate(scene));
  const planeReport = validateRayHits(rays, scene.exact, planeCandidate(scene, { exactComplex: false }));
  check("sealed room stays sealed with exact complex cells", exactReport.falseNegatives === 0,
    `FN=${exactReport.falseNegatives}/${rays.length}`);
  check("sealed room: corner distances are exact", exactReport.distanceErrorMedian < 5e-3,
    `exact=${exactReport.distanceErrorMedian.toExponential(2)} plane=${planeReport.distanceErrorMedian.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// Scene 3: a curved surface. No single plane per cell can be right everywhere,
// which is the accuracy case Phase 4 exists for.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const center = [8, 8, 8];
  const triangles = uvSphere(center, 3, 12, 8);
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const rays = [];
  const count = 96;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const origin = [
      center[0] + 6 * Math.cos(angle),
      center[1] + 1.8 * Math.sin(angle * 3),
      center[2] + 6 * Math.sin(angle),
    ];
    // Aim well inside the polyhedron's inradius: no ray is near-tangent, so
    // the comparison measures resolution accuracy, not silhouette luck.
    const target = [
      center[0] + 0.9 * Math.cos(angle * 2.3),
      center[1] + 0.9 * Math.sin(angle * 1.7),
      center[2] + 0.9 * Math.cos(angle * 1.1),
    ];
    rays.push({ origin, direction: normalize3(sub3(target, origin)), maxT: 14 });
  }
  const exactReport = validateRayHits(rays, scene.exact, planeCandidate(scene));
  const boxReport = validateRayHits(rays, scene.exact, boxCandidate(scene));
  check("sphere: triangle count stays inside the per-cell limit",
    scene.surfaces.complexRecords > 0,
    `records=${scene.surfaces.complexRecords} triangles=${scene.surfaces.complexTriangles} overflow=${scene.surfaces.complexOverflowCells}`);
  check("sphere: no false negatives", exactReport.falseNegatives === 0, JSON.stringify(exactReport));
  check("sphere: curved surface distances are exact", exactReport.distanceErrorMedian < 5e-3,
    `exact=${exactReport.distanceErrorMedian.toExponential(2)}`);
  check("sphere: at least a 10x improvement over occupied boxes",
    exactReport.distanceErrorMedian * 10 < boxReport.distanceErrorMedian,
    `exact=${exactReport.distanceErrorMedian.toExponential(2)} box=${boxReport.distanceErrorMedian.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Scene 4: nested geometry — the sphere floating over a floor. The nearest hit
// must switch surfaces across the silhouette, and the exact reference agrees
// only if both are resolved in the same traversal.
{
  const resolution = { x: 16, y: 16, z: 16 };
  const center = [8, 8, 8];
  const triangles = [
    ...uvSphere(center, 3, 12, 8),
    ...quad([1, 3.25, 1], [15, 3.25, 1], [15, 3.25, 15], [1, 3.25, 15]),
  ];
  const scene = { resolution, ...buildScene(resolution, triangles) };
  const ring = (radii) => {
    const rays = [];
    for (const radius of radii) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        rays.push({
          origin: [center[0] + radius * Math.cos(angle), 14.5, center[2] + radius * Math.sin(angle)],
          direction: [0, -1, 0],
          maxT: 13,
        });
      }
    }
    return rays;
  };
  // Inside the silhouette / clear of the sphere's voxel footprint: no ray is
  // ambiguous about WHICH surface it should find.
  const sphereRays = ring([0.4, 1.0, 1.6, 2.2]);
  const floorRays = ring([4.5, 5.0, 5.5, 6.0]);
  const rays = [...sphereRays, ...floorRays];

  let wrongSurface = 0;
  for (const ray of sphereRays) {
    const hit = trace(scene, ray);
    if (!hit.hit || ray.origin[1] - hit.t < 4.9) wrongSurface++;
  }
  for (const ray of floorRays) {
    const hit = trace(scene, ray);
    if (!hit.hit || Math.abs(ray.origin[1] - hit.t - 3.25) > 5e-3) wrongSurface++;
  }
  check("nested: nearest hit picks the sphere inside the silhouette and the floor outside",
    wrongSurface === 0, `wrong=${wrongSurface}/${rays.length}`);

  const report = validateRayHits(rays, scene.exact, planeCandidate(scene));
  check("nested: no false positives or negatives",
    report.falsePositives === 0 && report.falseNegatives === 0, JSON.stringify(report));
  check("nested: distances stay exact across both surfaces", report.distanceErrorMedian < 5e-3,
    `median=${report.distanceErrorMedian.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// Scene 5: a starved triangle pool. Over-limit and out-of-room cells must
// degrade to the occupied box — sealed, never leaking.
{
  const resolution = THIN_WALL_RESOLUTION;
  const scene = { resolution, ...buildScene(resolution, thinWallTriangles, { triangleCapacity: 2 }) };
  check("starved pool reports overflow cells", scene.surfaces.complexOverflowCells > 0,
    `overflow=${scene.surfaces.complexOverflowCells} triangles=${scene.surfaces.complexTriangles}`);
  check("starved pool never exceeds its capacity", scene.surfaces.complexTriangles <= 2,
    `triangles=${scene.surfaces.complexTriangles}`);
  const report = validateRayHits(thinWallRays, scene.exact, planeCandidate(scene));
  check("starved pool still blocks every ray", report.falseNegatives === 0, `FN=${report.falseNegatives}`);
}

// ---------------------------------------------------------------------------
// Scene 6: counters. The triangle loop must stay bounded and account for every
// complex cell it entered.
{
  const resolution = THIN_WALL_RESOLUTION;
  const scene = { resolution, ...buildScene(resolution, thinWallTriangles) };
  const totals = { complexTests: 0, triangleTests: 0, complexAccepts: 0, complexMisses: 0 };
  for (const ray of thinWallRays) {
    const hit = trace(scene, ray);
    for (const key of Object.keys(totals)) totals[key] += hit.counters[key];
  }
  check("complex counters record every entered cell", totals.complexTests > 0, JSON.stringify(totals));
  check("triangle tests stay inside the per-cell limit",
    totals.triangleTests <= totals.complexTests * MAX_COMPLEX_TRIANGLES, JSON.stringify(totals));
  check("every complex cell either accepts or misses",
    totals.complexTests === totals.complexAccepts + totals.complexMisses, JSON.stringify(totals));
}

console.log(failed === 0 ? "\nGI-RAY-HIT-PHASE4 ALL PASS" : `\nGI-RAY-HIT-PHASE4 ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
