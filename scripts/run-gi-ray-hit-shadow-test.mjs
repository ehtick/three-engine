// Record-aware shadow distance: CPU validation of the sharpened near field.
//
// WHAT IS BEING PROVEN. GI soft shadows sphere-trace a penumbra estimator
// min(k·d/t) whose short-range `d` is the occupancy oracle's near field: for
// every occupied voxel in the 3x3x3 neighbourhood, the gap from the sample to
// that voxel's AABB. Boxes make box-shaped isosurfaces, which is why the shadow
// silhouettes read as stair-steps. `recordAwareNearFieldCpu` replaces that gap
// with the Phase-2 fitted plane wherever a SIMPLE record exists, via
// max(gapWorld, planeWorld) — and the whole feature is only shippable if three
// properties hold simultaneously:
//
//   SHARPER  — it must actually raise the distance where the voxel hull was
//              the binding constraint (otherwise nothing changes on screen).
//   SAFE     — it must never exceed the true point-to-triangle distance by
//              more than the fit's own slack, or sphere tracing steps THROUGH
//              geometry and shadows develop holes. This is the load-bearing one.
//   CONTINUOUS — a jump anywhere would show up as a hard seam in the penumbra,
//              which is the exact artefact the near field was written to avoid.
//
// Everything runs in level-0 voxel space with unit cells (the space the GPU
// passes use), so plane offsets, gaps and distances compare directly. The
// ground truth is exact double-precision point-to-triangle distance over the
// FULL triangle set — never an approximation of it.
import {
  INVALID_RAY_HIT_INDEX,
  MACRO_CELL_BRICK_INDEX_WORD,
  MACRO_CELL_METADATA_WORD,
  MacroCellType,
  RECORD_AWARE_PLANE_SLACK,
  SIMPLE_MAX_PLANE_SIGMA,
  buildHybridBrickWords,
  buildSurfaceRecordsCpu,
  hybridBrickOccupied,
  macroCellLinearIndex,
  macroCellWord,
  packMacroCellMetadata,
  pointToTrianglesDistanceCpu,
  recordAwareNearFieldCpu,
  triBoxOverlapCpu,
  unpackMacroCellMetadata,
} from "../src/modules/gi/rayHit/RayHitPacking.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};

// Seeded PRNG only: every scene, sample battery and probe in this file must
// reproduce byte for byte across runs (check g depends on it, and so does any
// future bisect of a regression).
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize3 = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const flip = ([a, b, c]) => [a, c, b];

// The phase-2/4/5 scene idiom: conservative CPU voxelization with the
// voxelizer's own SAT and span, then the Phase-1 + Phase-2 build. The SAME
// predicate feeds buildHybridBrickWords, so "occupied" here and "occupied"
// inside the near field are one definition, not two that happen to agree.
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
  return { resolution, occupied, layout, words, surfaces, triangles };
};

// ---------------------------------------------------------------------------
// The A/B reference. Deliberately written from the spec text rather than
// extracted from the implementation: if both drifted together the identity
// check below would prove nothing. This is the pure AABB near field the shader
// has shipped since the occupancy backend landed.
const aabbOnlyNearField = (q0, scene, voxelWorld = [1, 1, 1]) => {
  const cell = [Math.floor(q0[0]), Math.floor(q0[1]), Math.floor(q0[2])];
  let nearest = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const v = [cell[0] + dx, cell[1] + dy, cell[2] + dz];
        if (!hybridBrickOccupied(scene.words, scene.layout, v[0], v[1], v[2], scene.resolution)) continue;
        const gap = [0, 1, 2].map((axis) =>
          Math.max(v[axis] - q0[axis], q0[axis] - (v[axis] + 1), 0) * voxelWorld[axis]);
        nearest = Math.min(nearest, Math.hypot(gap[0], gap[1], gap[2]));
      }
    }
  }
  const inset = [0, 1, 2].map((axis) => {
    const local = q0[axis] - cell[axis];
    return Math.min(local + 1, 2 - local) * voxelWorld[axis];
  });
  return Math.min(nearest, Math.min(inset[0], Math.min(inset[1], inset[2])));
};

const sharpened = (q0, scene, voxelWorld = [1, 1, 1], options = {}) =>
  recordAwareNearFieldCpu(q0, scene.resolution, scene.words, scene.layout, scene.surfaces.records,
    { voxelWorld, ...options });

// Ground truth in the SAME anisotropic world the near field reports in: scale
// both the query point and every triangle vertex by voxelWorld componentwise.
const exactDistance = (q0, scene, voxelWorld = [1, 1, 1]) => {
  const scaled = scene.scaledTriangles?.get(voxelWorld.join(",")) ?? (() => {
    const list = scene.triangles.map((triangle) => triangle.map((vertex) => [
      vertex[0] * voxelWorld[0], vertex[1] * voxelWorld[1], vertex[2] * voxelWorld[2],
    ]));
    if (!scene.scaledTriangles) scene.scaledTriangles = new Map();
    scene.scaledTriangles.set(voxelWorld.join(","), list);
    return list;
  })();
  return pointToTrianglesDistanceCpu(
    [q0[0] * voxelWorld[0], q0[1] * voxelWorld[1], q0[2] * voxelWorld[2]], scaled);
};

/**
 * Deterministic sample battery. Four interleaved modes, because the bound is
 * hardest in different places for different reasons:
 *   0 uniform in the grid            — the far/empty regime, where inset rules
 *   1 within +/-1.5 cells of a surface voxel — the sharpening regime
 *   2 strictly INSIDE a surface voxel — where the box gap is exactly 0 and the
 *     plane is the only thing carrying the value
 *   3 snapped onto a cell border     — where the 3x3x3 window shifts
 */
const samplePoints = (scene, seed, count) => {
  const rng = mulberry32(seed);
  const cells = Array.from(scene.occupied, (key) => key.split(",").map(Number));
  const size = [scene.resolution.x, scene.resolution.y, scene.resolution.z];
  const points = [];
  const pickCell = () => cells[Math.floor(rng() * cells.length) % cells.length];
  while (points.length < count) {
    const mode = cells.length === 0 ? 0 : points.length & 3;
    if (mode === 0) {
      points.push([rng() * size[0], rng() * size[1], rng() * size[2]]);
    } else if (mode === 1) {
      const c = pickCell();
      points.push([c[0] + rng() * 3 - 1, c[1] + rng() * 3 - 1, c[2] + rng() * 3 - 1]);
    } else if (mode === 2) {
      const c = pickCell();
      points.push([c[0] + rng(), c[1] + rng(), c[2] + rng()]);
    } else {
      const c = pickCell();
      const p = [c[0] + rng() * 2 - 0.5, c[1] + rng() * 2 - 0.5, c[2] + rng() * 2 - 0.5];
      const axis = Math.floor(rng() * 3) % 3;
      p[axis] = Math.round(p[axis]) + (rng() < 0.5 ? -1e-9 : 1e-9);
      points.push(p);
    }
  }
  return points;
};

// ---------------------------------------------------------------------------
// Scenes.
const FLOOR_RESOLUTION = { x: 32, y: 32, z: 32 };
// Spans the whole grid so every floor brick holds a full 4x4 footprint — that
// is what makes the capacity-8 starvation check below total rather than partial.
const FLOOR_TRIANGLES = quad([1, 10.25, 1], [31, 10.25, 1], [31, 10.25, 31], [1, 10.25, 31]);
const floor = buildScene(FLOOR_RESOLUTION, FLOOR_TRIANGLES);

// 45-degree ramp: the plane x - y = 0, an orientation no voxel face can express.
const ramp = buildScene({ x: 32, y: 32, z: 32 },
  quad([6, 6, 4], [22, 22, 4], [22, 22, 28], [6, 6, 28]));

// UV sphere, the curvature case: adjacent facets disagree, so a cell's fitted
// plane is a genuine approximation and the slack has to absorb the residual.
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
    return normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2] >= 0 ? triangle : flip(triangle);
  };
  const triangles = [];
  for (let lat = 0; lat < latitudes; lat++) {
    for (let lon = 0; lon < longitudes; lon++) {
      const a = point(lon, lat);
      const b = point(lon + 1, lat);
      const c = point(lon + 1, lat + 1);
      const d = point(lon, lat + 1);
      if (lat > 0) triangles.push(outward([a, b, c]));
      if (lat < latitudes - 1) triangles.push(outward([a, c, d]));
    }
  }
  return triangles;
};
const sphere = buildScene({ x: 48, y: 48, z: 48 }, uvSphere([24, 24, 24], 9, 16, 12));

// Thin double wall, 0.2 cells apart with opposing winding: the normals cancel,
// no plane can be fitted, and every one of those cells must keep box semantics.
const thinWall = (() => {
  const walls = [
    ...quad([16.4, 4, 4], [16.4, 28, 4], [16.4, 28, 28], [16.4, 4, 28]),
    ...quad([16.6, 4, 4], [16.6, 28, 4], [16.6, 28, 28], [16.6, 4, 28]),
  ];
  return buildScene({ x: 32, y: 32, z: 32 },
    [walls[0], walls[1], flip(walls[2]), flip(walls[3])]);
})();

// ---------------------------------------------------------------------------
// 0. The ground-truth instrument itself. A validation suite whose reference is
// wrong reports green forever, so the exact distance is checked against three
// closed-form answers first (face region, edge region, vertex region).
{
  const triangle = [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]];
  const face = pointToTrianglesDistanceCpu([0.25, 0.25, 0.7], triangle);
  const edge = pointToTrianglesDistanceCpu([1, 1, 0], triangle); // nearest: hypotenuse midpoint
  const vertex = pointToTrianglesDistanceCpu([-1, -1, 0], triangle);
  check("point-to-triangle: face region is the perpendicular drop",
    Math.abs(face - 0.7) < 1e-12, `d=${face}`);
  check("point-to-triangle: edge region hits the hypotenuse",
    Math.abs(edge - Math.SQRT1_2) < 1e-12, `d=${edge} expected=${Math.SQRT1_2}`);
  check("point-to-triangle: vertex region hits the corner",
    Math.abs(vertex - Math.SQRT2) < 1e-12, `d=${vertex}`);
  const degenerate = pointToTrianglesDistanceCpu([0, 0, 2], [[[1, 1, 0], [1, 1, 0], [1, 1, 0]]]);
  check("point-to-triangle: a degenerate triangle stays finite",
    Number.isFinite(degenerate) && Math.abs(degenerate - Math.hypot(1, 1, 2)) < 1e-12, `d=${degenerate}`);
}

// ---------------------------------------------------------------------------
// The shared sample battery. Built once, reused by the safety, floor and
// determinism checks so that every property is measured over the SAME points.
const BATTERY = [
  { name: "floor", scene: floor, points: samplePoints(floor, 0x5ad001, 200) },
  { name: "ramp", scene: ramp, points: samplePoints(ramp, 0x5ad002, 150) },
  { name: "sphere", scene: sphere, points: samplePoints(sphere, 0x5ad003, 200) },
  { name: "thin wall", scene: thinWall, points: samplePoints(thinWall, 0x5ad004, 150) },
];
const BATTERY_COUNT = BATTERY.reduce((sum, entry) => sum + entry.points.length, 0);

// ---------------------------------------------------------------------------
// 1. The A/B: recordAware:false must be the pure AABB near field, bit for bit.
{
  let mismatches = 0;
  let firstMismatch = "";
  for (const { name, scene, points } of BATTERY) {
    for (const p of points) {
      const off = sharpened(p, scene, [1, 1, 1], { recordAware: false });
      const reference = aabbOnlyNearField(p, scene);
      if (!Object.is(off, reference)) {
        mismatches++;
        if (!firstMismatch) firstMismatch = `${name} ${JSON.stringify(p)}: ${off} vs ${reference}`;
      }
    }
  }
  check("recordAware:false is bit-identical to the AABB-only near field",
    mismatches === 0, `points=${BATTERY_COUNT} mismatches=${mismatches}${firstMismatch ? ` first=${firstMismatch}` : ""}`);

  // The same identity through the other door: records present, but the pool
  // handed in empty. Nothing may resolve, so the value must not move.
  let poolMismatches = 0;
  for (const { scene, points } of BATTERY) {
    for (const p of points) {
      const empty = recordAwareNearFieldCpu(p, scene.resolution, scene.words, scene.layout, new Uint32Array(0));
      if (!Object.is(empty, aabbOnlyNearField(p, scene))) poolMismatches++;
    }
  }
  check("an empty record pool degrades to AABB-only exactly", poolMismatches === 0,
    `mismatches=${poolMismatches}`);
}

// ---------------------------------------------------------------------------
// 2 (a). SHARPER. Flat floor, deterministic points 0.1-1.5 voxels above the
// surface. Below 0.75 the sample is still INSIDE the occupied row, so the box
// gap is exactly zero and the plane carries the whole distance; above it the
// box gap exists but is short by the quarter-cell the surface sits inside.
{
  const rng = mulberry32(0x5ad0a0);
  const SURFACE_Y = 10.25;
  const points = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const height = 0.1 + ((i * 20 + j) / 399) * 1.4;
      points.push({
        p: [3 + rng() * 26, SURFACE_Y + height, 3 + rng() * 26],
        height,
      });
    }
  }
  let regressions = 0;
  let bandTotal = 0;
  let bandStrict = 0;
  let sharpenSum = 0;
  let bandSharpenSum = 0;
  let worstError = 0;
  for (const { p, height } of points) {
    const on = sharpened(p, floor);
    const off = aabbOnlyNearField(p, floor);
    if (on < off) regressions++;
    sharpenSum += on - off;
    // The band where the voxel hull dominates: the plane is a quarter cell
    // inside the occupied row, so the box can be short by up to 0.75.
    if (height >= 0.2 && height <= 0.9) {
      bandTotal++;
      bandSharpenSum += on - off;
      if (on > off) bandStrict++;
      // In this band the sharpened value should also be close to the truth
      // (height minus the slack), which the box form cannot approach at all.
      worstError = Math.max(worstError, Math.abs(on - Math.max(height - RECORD_AWARE_PLANE_SLACK, 0)));
    }
  }
  const meanSharpening = sharpenSum / points.length;
  const bandMeanSharpening = bandSharpenSum / bandTotal;
  check("floor: record-aware never regresses below AABB-only", regressions === 0,
    `points=${points.length} regressions=${regressions}`);
  check("floor: strictly sharper for >=60% of the 0.2-0.9 band",
    bandStrict >= bandTotal * 0.6,
    `strict=${bandStrict}/${bandTotal} (${((bandStrict / bandTotal) * 100).toFixed(1)}%)`);
  check("floor: mean sharpening is a real improvement", meanSharpening > 0.1,
    `mean=+${meanSharpening.toFixed(4)} voxels over 0.1-1.5, band mean=+${bandMeanSharpening.toFixed(4)}`);
  check("floor: the sharpened value tracks the true height minus slack",
    worstError < 5e-3, `max|d-(h-slack)|=${worstError.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 3 (b). SAFE. The load-bearing bound: the reported distance may never exceed
// the exact point-to-triangle distance by more than the fit's own slack. A
// violation here is a sphere trace stepping through geometry — a shadow hole.
const SAFETY_EPSILON = 1e-6;
const safetyReport = (label, entries, voxelWorld) => {
  const minVoxelWorld = Math.min(voxelWorld[0], voxelWorld[1], voxelWorld[2]);
  const tolerance = RECORD_AWARE_PLANE_SLACK * minVoxelWorld + SAFETY_EPSILON;
  let violations = 0;
  let worst = -Infinity;
  let worstAt = "";
  let points = 0;
  for (const { name, scene, points: list } of entries) {
    for (const p of list) {
      points++;
      const on = sharpened(p, scene, voxelWorld);
      const truth = exactDistance(p, scene, voxelWorld);
      const excess = on - truth;
      if (excess > worst) {
        worst = excess;
        worstAt = `${name} ${p.map((v) => v.toFixed(3)).join(",")} d=${on.toFixed(4)} true=${truth.toFixed(4)}`;
      }
      if (excess > tolerance) violations++;
    }
  }
  return { label, violations, worst, worstAt, points, tolerance };
};
{
  for (const entry of BATTERY) {
    const report = safetyReport(entry.name, [entry], [1, 1, 1]);
    check(`safe: ${entry.name} never exceeds exact distance + slack`,
      report.violations === 0,
      `points=${report.points} violations=${report.violations} worstExcess=${report.worst.toExponential(2)} tol=${report.tolerance.toExponential(2)} at=${report.worstAt}`);
  }
  check("safe: the battery covers at least 500 points", BATTERY_COUNT >= 500,
    `points=${BATTERY_COUNT}`);
}

// ---------------------------------------------------------------------------
// 3b. Is the bound above a MARGIN or a coincidence? Re-run with slack 0 and
// take the largest overshoot: that number IS the fitted planes' worst residual
// against exact geometry, i.e. the slack the formula actually needs. A safety
// check whose margin is never approached proves very little, so the residual is
// also measured on progressively higher-curvature spheres, where a cell's
// triangles genuinely disagree and the fit has something to be wrong about.
{
  const requiredSlack = (entries) => {
    let required = 0;
    let at = "";
    for (const { name, scene, points } of entries) {
      for (const p of points) {
        const on = sharpened(p, scene, [1, 1, 1], { slack: 0 });
        const excess = on - exactDistance(p, scene);
        if (excess > required) {
          required = excess;
          at = `${name} ${p.map((v) => v.toFixed(2)).join(",")}`;
        }
      }
    }
    return { required, at };
  };

  const base = requiredSlack(BATTERY);
  // Curvature ladder: the per-cell fit residual scales with cell/radius, so a
  // radius-4 sphere in unit cells is the tight end of anything the voxelizer
  // will realistically see.
  const curvature = [
    { name: "sphere r4 16x12", scene: buildScene({ x: 32, y: 32, z: 32 }, uvSphere([16, 16, 16], 4, 16, 12)) },
    { name: "sphere r4 32x24", scene: buildScene({ x: 32, y: 32, z: 32 }, uvSphere([16, 16, 16], 4, 32, 24)) },
    { name: "sphere r6 24x16", scene: buildScene({ x: 32, y: 32, z: 32 }, uvSphere([16, 16, 16], 6, 24, 16)) },
    { name: "sphere r9 32x24", scene: buildScene({ x: 48, y: 48, z: 48 }, uvSphere([24, 24, 24], 9, 32, 24)) },
  ].map((entry, index) => ({ ...entry, points: samplePoints(entry.scene, 0x5ad0b0 + index, 200) }));
  const curved = requiredSlack(curvature);
  const overall = base.required >= curved.required ? base : curved;

  check("the shipped slack covers the measured fit residual with headroom",
    overall.required < RECORD_AWARE_PLANE_SLACK,
    `required=${overall.required.toFixed(5)} shipped=${RECORD_AWARE_PLANE_SLACK} headroom=${(RECORD_AWARE_PLANE_SLACK / Math.max(overall.required, 1e-9)).toFixed(2)}x battery=${base.required.toFixed(5)} curvature=${curved.required.toFixed(5)} worstAt=${overall.at}`);
  // And the curvature ladder must still be SAFE at the shipped slack, which is
  // the property the ladder was added to stress.
  const curvedReport = safetyReport("curvature", curvature, [1, 1, 1]);
  check("curvature ladder stays inside the shipped bound", curvedReport.violations === 0,
    `points=${curvedReport.points} violations=${curvedReport.violations} worstExcess=${curvedReport.worst.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 3c. Non-vacuity. Every scene above must actually EXERCISE the record path —
// a scene with no simple planes would pass every safety check for the wrong
// reason (it would just be measuring the box form again).
{
  const rows = [];
  let barren = 0;
  for (const { name, scene, points } of BATTERY) {
    let sharper = 0;
    for (const p of points) if (sharpened(p, scene) > aabbOnlyNearField(p, scene)) sharper++;
    rows.push(`${name}:simple=${scene.surfaces.simpleCells},sharper=${sharper}/${points.length}`);
    // The thin wall is the deliberate exception: it exists to have no planes.
    if (name !== "thin wall" && (scene.surfaces.simpleCells === 0 || sharper === 0)) barren++;
  }
  check("floor, ramp and sphere all exercise the record path", barren === 0, rows.join(" "));
}

// ---------------------------------------------------------------------------
// 4 (c). LOWER-BOUND FLOOR. max(gap, plane) guarantees this structurally, but
// the whole feature's safety argument rests on the record path only ever
// raising the value, so it is verified over the full battery anyway.
{
  let regressions = 0;
  let firstRegression = "";
  let strictlyGreater = 0;
  for (const { name, scene, points } of BATTERY) {
    for (const p of points) {
      const on = sharpened(p, scene);
      const off = aabbOnlyNearField(p, scene);
      if (on < off) {
        regressions++;
        if (!firstRegression) firstRegression = `${name} ${JSON.stringify(p)}: ${on} < ${off}`;
      } else if (on > off) strictlyGreater++;
    }
  }
  check("record-aware >= AABB-only over the whole battery", regressions === 0,
    `points=${BATTERY_COUNT} regressions=${regressions} strictlySharper=${strictlyGreater}${firstRegression ? ` first=${firstRegression}` : ""}`);
}

// ---------------------------------------------------------------------------
// 5 (d). CONTINUITY. max(gap, plane) is continuous because a voxel leaving the
// 3x3x3 window sits exactly one voxel away at the crossing, where its gap term
// alone already equals the inset the result is clamped by. A jump means the
// window shift became visible — the seam artefact this whole design avoids.
{
  const PROBE_STEPS = 400;
  const probes = [
    // Floor: along the surface, diagonally across it, straight down through it,
    // and a shallow oblique that crosses macro borders on two axes at once.
    { scene: floor, from: [2.13, 10.65, 7.37], to: [29.87, 10.65, 7.37] },
    { scene: floor, from: [2.31, 10.9, 2.19], to: [29.41, 10.9, 29.73] },
    { scene: floor, from: [13.37, 15.9, 17.21], to: [13.37, 5.1, 17.21] },
    { scene: floor, from: [2.7, 13.3, 4.1], to: [29.3, 8.7, 26.9] },
    // Sphere: through the middle, a chord, a near-tangent graze (the hardest
    // continuity case — the nearest record flips between facets constantly),
    // and a vertical through both poles.
    { scene: sphere, from: [6.11, 24.37, 24.29], to: [41.89, 24.37, 24.29] },
    { scene: sphere, from: [8.23, 15.71, 12.37], to: [39.77, 32.29, 35.63] },
    { scene: sphere, from: [6.5, 33.4, 24.11], to: [41.5, 33.4, 24.11] },
    { scene: sphere, from: [24.19, 6.3, 23.83], to: [24.19, 41.7, 23.83] },
  ];
  let violations = 0;
  let worstRatio = 0;
  let worstAt = "";
  let samples = 0;
  for (const { scene, from, to } of probes) {
    const delta = sub3(to, from);
    const stepLength = Math.hypot(delta[0], delta[1], delta[2]) / PROBE_STEPS;
    const limit = stepLength * 1.75 + 1e-6;
    let previous = null;
    for (let i = 0; i <= PROBE_STEPS; i++) {
      const s = i / PROBE_STEPS;
      const p = [from[0] + delta[0] * s, from[1] + delta[1] * s, from[2] + delta[2] * s];
      const d = sharpened(p, scene);
      samples++;
      if (previous !== null) {
        const jump = Math.abs(d - previous);
        if (jump / stepLength > worstRatio) {
          worstRatio = jump / stepLength;
          worstAt = `${p.map((v) => v.toFixed(3)).join(",")} jump=${jump.toFixed(5)}`;
        }
        if (jump > limit) violations++;
      }
      previous = d;
    }
  }
  check("continuity: no step exceeds 1.75x the probe step", violations === 0,
    `probes=${probes.length} samples=${samples} violations=${violations} worstRatio=${worstRatio.toFixed(3)} at=${worstAt}`);
  check("continuity: the probes actually moved the value", worstRatio > 0.5,
    `worstRatio=${worstRatio.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 6 (e). FALLBACK EXACTNESS. Three different ways to have no usable record, all
// of which must reproduce the AABB-only value EXACTLY — not approximately.
{
  // e1: the thin double wall. Opposing normals cancel, so no plane is fitted.
  check("thin wall fits no simple planes at all", thinWall.surfaces.simpleCells === 0,
    `simple=${thinWall.surfaces.simpleCells} complex=${thinWall.surfaces.complexCells}`);
  let wallMismatches = 0;
  for (const p of samplePoints(thinWall, 0x5ad0e1, 300)) {
    if (!Object.is(sharpened(p, thinWall), aabbOnlyNearField(p, thinWall))) wallMismatches++;
  }
  check("complex cells reproduce AABB-only exactly", wallMismatches === 0,
    `mismatches=${wallMismatches}`);

  // e2: a starved record pool. Every floor brick holds 16 occupied voxels, so
  // capacity 8 leaves every surfaceOffset INVALID — total, not partial.
  const starved = buildScene(FLOOR_RESOLUTION, FLOOR_TRIANGLES, { capacity: 8 });
  check("starved build allocates no records at all",
    starved.surfaces.overflowBricks > 0 && starved.surfaces.simpleCells === 0,
    `overflow=${starved.surfaces.overflowBricks} allocated=${starved.surfaces.allocated} simple=${starved.surfaces.simpleCells}`);
  let starvedMismatches = 0;
  const starvedPoints = samplePoints(starved, 0x5ad0e2, 300);
  for (const p of starvedPoints) {
    if (!Object.is(sharpened(p, starved), aabbOnlyNearField(p, starved))) starvedMismatches++;
  }
  check("starved records reproduce AABB-only exactly", starvedMismatches === 0,
    `mismatches=${starvedMismatches}`);
  // The same points on the fully-built floor must NOT match, or the check above
  // is vacuous — it would pass on a function that ignored records entirely.
  let starvedDifferences = 0;
  for (const p of starvedPoints) {
    if (!Object.is(sharpened(p, floor), aabbOnlyNearField(p, floor))) starvedDifferences++;
  }
  check("the same points DO diverge once records exist", starvedDifferences > 0,
    `divergent=${starvedDifferences}/${starvedPoints.length}`);

  // e3: a DYNAMIC macro cell. Its records describe a previous frame's geometry,
  // so the STATIC gate must reject them exactly as the tracer's does.
  const dynamic = {
    ...floor,
    words: Uint32Array.from(floor.words),
  };
  let flipped = 0;
  for (let macroIndex = 0; macroIndex < dynamic.layout.macroCellCount; macroIndex++) {
    const word = macroCellWord(dynamic.layout, macroIndex, MACRO_CELL_METADATA_WORD);
    const metadata = unpackMacroCellMetadata(dynamic.words[word]);
    if (metadata.type !== MacroCellType.Brick) continue;
    dynamic.words[word] = packMacroCellMetadata({ ...metadata, type: MacroCellType.DynamicBrick });
    flipped++;
  }
  // Occupancy is read from the brick-index word, which is untouched: the scene
  // must still be solid, only its records unusable.
  const stillOccupied = hybridBrickOccupied(dynamic.words, dynamic.layout, 12, 10, 12, dynamic.resolution) &&
    dynamic.words[macroCellWord(dynamic.layout,
      macroCellLinearIndex(3, 2, 3, dynamic.layout.macroResolution), MACRO_CELL_BRICK_INDEX_WORD)] !== INVALID_RAY_HIT_INDEX;
  let dynamicMismatches = 0;
  for (const p of starvedPoints) {
    if (!Object.is(sharpened(p, dynamic), aabbOnlyNearField(p, dynamic))) dynamicMismatches++;
  }
  check("dynamic macro cells reject their records and stay AABB-only",
    flipped > 0 && stillOccupied && dynamicMismatches === 0,
    `flipped=${flipped} occupied=${stillOccupied} mismatches=${dynamicMismatches}`);

  // e4: the explicit flag. Same scene, same points, records present.
  let flagMismatches = 0;
  for (const p of starvedPoints) {
    if (!Object.is(sharpened(p, floor, [1, 1, 1], { recordAware: false }), aabbOnlyNearField(p, floor))) {
      flagMismatches++;
    }
  }
  check("recordAware:false reproduces AABB-only on a fully-built scene",
    flagMismatches === 0, `mismatches=${flagMismatches}`);
}

// ---------------------------------------------------------------------------
// 7 (f). ANISOTROPY. Scaling a plane distance by diag(s) divides it by
// |S^-1 n| <= 1/min(s), so scaling by the MIN component is a lower bound for
// every normal orientation. If the formula used the axis-matched scale instead,
// this is the check that would catch it.
{
  const voxelWorld = [0.1, 0.2, 0.1];
  const report = safetyReport("anisotropic", BATTERY, voxelWorld);
  check("anisotropic: exact-distance bound still holds", report.violations === 0,
    `points=${report.points} violations=${report.violations} worstExcess=${report.worst.toExponential(2)} tol=${report.tolerance.toExponential(2)} at=${report.worstAt}`);
  let regressions = 0;
  let sharper = 0;
  for (const { scene, points } of BATTERY) {
    for (const p of points) {
      const on = sharpened(p, scene, voxelWorld);
      const off = aabbOnlyNearField(p, scene, voxelWorld);
      if (on < off) regressions++;
      else if (on > off) sharper++;
    }
  }
  check("anisotropic: record-aware >= AABB-only and still sharpens",
    regressions === 0 && sharper > 0, `regressions=${regressions} sharper=${sharper}`);
}

// ---------------------------------------------------------------------------
// 8 (g). DETERMINISM. Two full passes over the battery, compared with Object.is
// so that a -0/NaN drift would count as a difference.
{
  const run = () => BATTERY.flatMap(({ scene, points }) =>
    points.map((p) => sharpened(p, scene)));
  const first = run();
  const second = run();
  let differences = 0;
  for (let i = 0; i < first.length; i++) if (!Object.is(first[i], second[i])) differences++;
  check("two runs produce identical outputs",
    differences === 0 && first.length === BATTERY_COUNT, `values=${first.length} differences=${differences}`);
}

// ---------------------------------------------------------------------------
// 9. Slack provenance: the shared CPU/GPU constant must stay the fit-residual
// ceiling plus the packing margin, or the two halves silently disagree.
{
  check("the shared slack is SIMPLE_MAX_PLANE_SIGMA + 0.02",
    Math.abs(RECORD_AWARE_PLANE_SLACK - (SIMPLE_MAX_PLANE_SIGMA + 0.02)) < 1e-12,
    `slack=${RECORD_AWARE_PLANE_SLACK}`);
  // An absurdly large slack must collapse the plane term to zero, leaving the
  // AABB form — proof that `slack` is genuinely the only knob on that branch.
  let collapsed = 0;
  for (const { scene, points } of BATTERY) {
    for (const p of points) {
      if (!Object.is(sharpened(p, scene, [1, 1, 1], { slack: 1e6 }), aabbOnlyNearField(p, scene))) collapsed++;
    }
  }
  check("an infinite slack collapses the plane term back to the box", collapsed === 0,
    `mismatches=${collapsed}`);
}

console.log(failed === 0 ? "\nGI-RAY-HIT-SHADOW ALL PASS" : `\nGI-RAY-HIT-SHADOW ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
