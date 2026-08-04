// Phase-5 CPU validation: the conservative empty-space skip.
//
// The hybrid GPU traces have ridden occupancy-pyramid levels 3-4 since Phase 1
// (occupancyField.js, the `level` var in the macro loop); the CPU tracers were
// pure macro+brick, so skip-equivalence had never been proven anywhere. Both
// tracers now take the same optional pyramid, and every check below asks one
// question: does riding it change an ANSWER, or only the step count?
//
// Everything runs in level-0 voxel space with unit cells — the space the GPU
// passes use — so t, voxel coordinates and normals compare directly.
import {
  buildHybridBrickWords,
  buildOccupancyPyramidCpu,
  buildSurfaceRecordsCpu,
  traceHybridBrickBoxesCpu,
  traceHybridPlaneCpu,
  triBoxOverlapCpu,
} from "../src/modules/gi/rayHit/RayHitPacking.js";
import { resolveRayHitConfig } from "../src/modules/gi/rayHit/RayHitConfig.js";
import { validateRayHits } from "../src/modules/gi/rayHit/RayHitValidator.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};

// Seeded PRNG: every scene and ray battery in this file must reproduce byte
// for byte across runs, so nothing here may touch Math.random or the clock.
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

// The phase-2/4 scene idiom: conservative CPU voxelization with the voxelizer's
// own SAT and span, then the Phase-1 + Phase-2/4 build, plus the Phase-5
// pyramid over the SAME occupancy predicate.
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
  const predicate = (x, y, z) => occupied.has(`${x},${y},${z}`);
  const { layout, words } = buildHybridBrickWords(resolution, predicate);
  const surfaces = buildSurfaceRecordsCpu(resolution, words, layout, triangles, options);
  return {
    resolution,
    occupied,
    layout,
    words,
    surfaces,
    pyramid: buildOccupancyPyramidCpu(resolution, predicate),
    exact: triangles.map(([a, b, c]) => ({ a, b, c })),
  };
};

// A voxel-only scene: no triangles, so the box tracer is the only meaningful
// consumer and the pyramid is built straight off the occupancy set.
const buildVoxelScene = (resolution, occupied) => {
  const predicate = (x, y, z) => occupied.has(`${x},${y},${z}`);
  const { layout, words } = buildHybridBrickWords(resolution, predicate);
  return {
    resolution,
    occupied,
    layout,
    words,
    pyramid: buildOccupancyPyramidCpu(resolution, predicate),
  };
};

// The gate's equality: a hit is the same hit only if it is the same voxel, the
// same resolution KIND, and the same surface orientation. t is allowed the
// epsilon slack the coarse skip's own +RAY_HIT_DDA_EPSILON advance introduces.
const T_TOLERANCE = 2e-3;
const sameResult = (a, b) => {
  if (a.hit !== b.hit || a.resolved !== b.resolved) return "hit/resolved";
  if (!a.hit) return null;
  if (!(Math.abs(a.t - b.t) <= T_TOLERANCE)) return `t ${a.t} vs ${b.t}`;
  if ((a.kind ?? null) !== (b.kind ?? null)) return `kind ${a.kind} vs ${b.kind}`;
  const va = a.voxel ?? null;
  const vb = b.voxel ?? null;
  if ((va === null) !== (vb === null)) return "voxel presence";
  if (va && (va[0] !== vb[0] || va[1] !== vb[1] || va[2] !== vb[2])) return `voxel ${va} vs ${vb}`;
  const na = a.normal ?? null;
  const nb = b.normal ?? null;
  if ((na === null) !== (nb === null)) return "normal presence";
  if (na && (na[0] !== nb[0] || na[1] !== nb[1] || na[2] !== nb[2])) return `normal ${na} vs ${nb}`;
  return null;
};

/**
 * The adversarial ray battery: axis-parallel both ways, corner diagonals,
 * directions with mixed-sign components, a golden-spiral fan from the middle,
 * origins parked deep inside EMPTY top-level blocks (the rays the skip is for),
 * and rays that graze the level-4 block boundary planes from either side.
 */
const rayBattery = (resolution, pyramid, seed) => {
  const rng = mulberry32(seed);
  const size = [resolution.x, resolution.y, resolution.z];
  const centre = size.map((value) => value / 2);
  const maxT = (size[0] + size[1] + size[2]) * 2;
  const rays = [];
  const push = (origin, direction) => {
    if (origin.some((value, axis) => !(value > 0 && value < size[axis]))) return;
    rays.push({ origin, direction: normalize3(direction), maxT });
  };

  for (let axis = 0; axis < 3; axis++) {
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (const sign of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const origin = [0, 0, 0];
          origin[axis] = sign > 0 ? 0.37 : size[axis] - 0.37;
          origin[others[0]] = (i + 0.5) * (size[others[0]] / 4) + 0.13;
          origin[others[1]] = (j + 0.5) * (size[others[1]] / 4) - 0.29;
          const direction = [0, 0, 0];
          direction[axis] = sign;
          push(origin, direction);
        }
      }
    }
  }

  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        push([
          sx > 0 ? 0.6 : size[0] - 0.6,
          sy > 0 ? 0.35 : size[1] - 0.35,
          sz > 0 ? 0.8 : size[2] - 0.8,
        ], [sx, sy, sz]);
        // Mixed-sign, non-diagonal: nothing about the skip may depend on the
        // direction's sign pattern lining up with the block lattice.
        push([
          sx > 0 ? 1.2 : size[0] - 1.2,
          sy > 0 ? 2.7 : size[1] - 2.7,
          sz > 0 ? 3.4 : size[2] - 3.4,
        ], [sx * 0.31, sy * 1, sz * 0.67]);
      }
    }
  }

  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 40; i++) {
    const y = 1 - (2 * (i + 0.5)) / 40;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    push([centre[0] + 0.3, centre[1] - 0.2, centre[2] + 0.1],
      [Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }

  // Deep inside empty top-level blocks: exactly the geometry where the level-4
  // skip fires, aimed both at the scene and away from it.
  const top = pyramid.levels[pyramid.levelCount - 1];
  const scale = 1 << (pyramid.levelCount - 1);
  let emptyBlocks = 0;
  for (let z = 0; z < top.res.z && emptyBlocks < 8; z++) {
    for (let y = 0; y < top.res.y && emptyBlocks < 8; y++) {
      for (let x = 0; x < top.res.x && emptyBlocks < 8; x++) {
        if (top.occupied(x, y, z)) continue;
        emptyBlocks++;
        const origin = [(x + 0.5) * scale, (y + 0.5) * scale, (z + 0.5) * scale];
        push(origin, sub3(centre, origin));
        push(origin, sub3(origin, centre));
        push(origin, [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]);
      }
    }
  }

  // Grazing the level-4 boundary planes: parallel a hair to either side, and
  // crossing them at a near-tangent angle.
  for (let axis = 0; axis < 3; axis++) {
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let bound = scale; bound < size[axis]; bound += scale) {
      for (const offset of [-1e-3, 1e-3, -0.5, 0.5]) {
        const origin = [0, 0, 0];
        origin[axis] = bound + offset;
        origin[others[0]] = 0.45;
        origin[others[1]] = size[others[1]] * 0.5 + 0.21;
        const parallel = [0, 0, 0];
        parallel[others[0]] = 1;
        push([...origin], parallel);
        const shallow = [0, 0, 0];
        shallow[others[0]] = 1;
        shallow[axis] = offset < 0 ? 4e-3 : -4e-3;
        push([...origin], shallow);
      }
    }
  }

  return rays;
};

// ---------------------------------------------------------------------------
// a. Pyramid builder units.
{
  const resolution = { x: 8, y: 8, z: 8 };
  const cells = new Set(["5,3,6", "0,0,0", "1,0,0", "7,7,7"]);
  const pyramid = buildOccupancyPyramidCpu(resolution, (x, y, z) => cells.has(`${x},${y},${z}`));
  check("pyramid reports the requested level count", pyramid.levelCount === 5 && pyramid.levels.length === 5);
  check("level 0 mirrors the predicate",
    pyramid.levels[0].occupied(5, 3, 6) && pyramid.levels[0].occupied(7, 7, 7) &&
    !pyramid.levels[0].occupied(5, 3, 5));
  check("out-of-bounds reads false at every level",
    pyramid.levels.every((level) =>
      !level.occupied(-1, 0, 0) && !level.occupied(0, -1, 0) && !level.occupied(0, 0, -1) &&
      !level.occupied(level.res.x, 0, 0) && !level.occupied(0, level.res.y, 0) &&
      !level.occupied(0, 0, level.res.z)));

  // The whole downsample contract, brute-forced: for every cell of every level
  // above 0, occupied must equal the OR of its up-to-eight children.
  let parentMismatches = 0;
  for (let level = 1; level < pyramid.levelCount; level++) {
    const here = pyramid.levels[level];
    const child = pyramid.levels[level - 1];
    for (let z = 0; z < here.res.z; z++) {
      for (let y = 0; y < here.res.y; y++) {
        for (let x = 0; x < here.res.x; x++) {
          let any = false;
          for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                if (child.occupied(x * 2 + dx, y * 2 + dy, z * 2 + dz)) any = true;
              }
            }
          }
          if (any !== here.occupied(x, y, z)) parentMismatches++;
        }
      }
    }
  }
  check("a parent is occupied iff any child is", parentMismatches === 0, `mismatches=${parentMismatches}`);
  check("the single interior voxel lifts exactly its own ancestors",
    pyramid.levels[1].occupied(2, 1, 3) && !pyramid.levels[1].occupied(2, 1, 2) &&
    pyramid.levels[2].occupied(1, 0, 1) && !pyramid.levels[2].occupied(0, 0, 1));

  // A region with nothing in it must stay empty all the way up — the property
  // the skip relies on. Corner (0..1)^3 seeded, block x>=4 deliberately clear.
  const sparse = new Set(["0,0,0", "1,1,1"]);
  const deep = buildOccupancyPyramidCpu(resolution, (x, y, z) => sparse.has(`${x},${y},${z}`));
  let leaks = 0;
  for (let level = 0; level < deep.levelCount; level++) {
    const here = deep.levels[level];
    const span = 1 << level;
    for (let z = 0; z < here.res.z; z++) {
      for (let y = 0; y < here.res.y; y++) {
        for (let x = 0; x < here.res.x; x++) {
          // Cells whose whole level-0 footprint sits past the seeded corner.
          if (x * span >= 2 || y * span >= 2 || z * span >= 2) {
            if (here.occupied(x, y, z)) leaks++;
          }
        }
      }
    }
  }
  check("a deep-empty region stays empty at every level", leaks === 0, `leaks=${leaks}`);
}

{
  // 48 is a non-power-of-two multiple of 16: levels must clamp with
  // max(1, res >> L) exactly as planLevels does, and 8 must bottom out at 1.
  const wide = buildOccupancyPyramidCpu({ x: 48, y: 48, z: 48 }, () => false);
  const expected = [48, 24, 12, 6, 3];
  check("48^3 level resolutions follow max(1, res >> L)",
    wide.levels.every((level, index) =>
      level.res.x === expected[index] && level.res.y === expected[index] && level.res.z === expected[index]),
    wide.levels.map((level) => level.res.x).join(","));
  const tiny = buildOccupancyPyramidCpu({ x: 8, y: 4, z: 48 }, () => false);
  check("levels clamp to 1 instead of collapsing to 0",
    tiny.levels.map((level) => `${level.res.x}x${level.res.y}x${level.res.z}`).join(" ") ===
      "8x4x48 4x2x24 2x1x12 1x1x6 1x1x3",
    tiny.levels.map((level) => `${level.res.x}x${level.res.y}x${level.res.z}`).join(" "));
}

// ---------------------------------------------------------------------------
// b. Skip-equivalence — the Phase-5 gate. Five scenes, one comparison each,
// between them covering all three resolution kinds (plane, triangles, box).
let equivalenceRays = 0;
const compareScene = (name, scene, traceFn, seed) => {
  const rays = rayBattery(scene.resolution, scene.pyramid, seed);
  equivalenceRays += rays.length;
  let mismatches = 0;
  let firstMismatch = "";
  let hits = 0;
  let coarseSkips = 0;
  let unresolved = 0;
  for (const ray of rays) {
    const off = traceFn(scene, ray, null);
    const on = traceFn(scene, ray, scene.pyramid);
    if (off.hit) hits++;
    if (off.resolved === false || on.resolved === false) unresolved++;
    coarseSkips += on.coarseSkipsL3 + on.coarseSkipsL4;
    const reason = sameResult(off, on);
    if (reason) {
      mismatches++;
      if (!firstMismatch) firstMismatch = `${JSON.stringify(ray.origin)}->${JSON.stringify(ray.direction)}: ${reason}`;
    }
  }
  // `coarseSkips > 0` is part of the gate: a scene whose geometry happens to
  // occupy every coarse block would pass equivalence without ever skipping,
  // which proves nothing.
  check(`${name}: pyramid changes no answer`, mismatches === 0 && unresolved === 0 && coarseSkips > 0,
    `rays=${rays.length} hits=${hits} skips=${coarseSkips} mismatches=${mismatches} unresolved=${unresolved}${firstMismatch ? ` first=${firstMismatch}` : ""}`);
  return rays;
};

const traceBox = (scene, ray, pyramid) => traceHybridBrickBoxesCpu(
  ray.origin, ray.direction, scene.resolution, scene.words, scene.layout,
  { tMax: ray.maxT, maxMacroSteps: 4096, pyramid },
);
const tracePlane = (scene, ray, pyramid) => traceHybridPlaneCpu(
  ray.origin, ray.direction, scene.resolution, scene.words, scene.layout, scene.surfaces.records,
  {
    tMax: ray.maxT,
    coverage: true,
    exactComplex: scene.exactComplex === true,
    trianglePool: scene.exactComplex === true ? scene.surfaces.trianglePool : null,
    maxMacroSteps: 4096,
    pyramid,
  },
);

// Scene 1: sealed 32^3 triangle room. Walls at 4 and 28 leave the interior
// level-3 blocks ([8,16) and [16,24)) genuinely empty — with the walls ON a
// block boundary instead, the conservative voxelizer's one-cell skin occupies
// every coarse block and the ride can only ever descend. Every level-4 block
// still holds wall, so this scene is about level-3 skips.
const ROOM_RESOLUTION = { x: 32, y: 32, z: 32 };
const roomTriangles = (() => {
  const lo = 4;
  const hi = 28;
  return [
    ...quad([lo, lo, lo], [hi, lo, lo], [hi, lo, hi], [lo, lo, hi]),   // floor
    ...quad([lo, hi, lo], [hi, hi, lo], [hi, hi, hi], [lo, hi, hi]),   // ceiling
    ...quad([lo, lo, lo], [lo, hi, lo], [lo, hi, hi], [lo, lo, hi]),   // -x wall
    ...quad([hi, lo, lo], [hi, hi, lo], [hi, hi, hi], [hi, lo, hi]),   // +x wall
    ...quad([lo, lo, lo], [hi, lo, lo], [hi, hi, lo], [lo, hi, lo]),   // -z wall
    ...quad([lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, hi, hi]),   // +z wall
  ];
})();
const room = (() => {
  const scene = buildScene(ROOM_RESOLUTION, roomTriangles);
  scene.exactComplex = true;
  return scene;
})();
const roomRays = compareScene("sealed 32^3 room", room, tracePlane, 0x5eed01);

// Scene 1b: the same room with a starved record pool, so EVERY hit takes the
// occupied-box fallback. That path's normal comes from the carried-over DDA
// `axis`, the one piece of tracer state the coarse skip also writes — the only
// place a ride could silently change a normal.
const starvedRoom = (() => {
  const scene = buildScene(ROOM_RESOLUTION, roomTriangles, { capacity: 8 });
  scene.exactComplex = true;
  return scene;
})();
compareScene("sealed room, starved records (box normals)", starvedRoom, tracePlane, 0x5eed05);

// Scene 2: the thin double wall — 0.2 cells apart, opposing winding, so the
// cells are complex and every hit resolves against the triangle pool.
const thinWall = (() => {
  const resolution = { x: 32, y: 32, z: 32 };
  const walls = [
    ...quad([16.4, 4, 4], [16.4, 28, 4], [16.4, 28, 28], [16.4, 4, 28]),
    ...quad([16.6, 4, 4], [16.6, 28, 4], [16.6, 28, 28], [16.6, 4, 28]),
  ];
  const scene = buildScene(resolution, [walls[0], walls[1], flip(walls[2]), flip(walls[3])]);
  scene.exactComplex = true;
  return scene;
})();
compareScene("thin double wall", thinWall, tracePlane, 0x5eed02);

// Scene 3: a UV sphere in 48^3 — a non-power-of-two-multiple grid whose level-4
// resolution is 3, plus curved geometry that resolves through the triangle pool.
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
const sphere = (() => {
  const resolution = { x: 48, y: 48, z: 48 };
  const scene = buildScene(resolution, uvSphere([24, 24, 24], 9, 16, 12));
  scene.exactComplex = true;
  return scene;
})();
compareScene("UV sphere 48^3 (exact complex)", sphere, tracePlane, 0x5eed03);

// Scene 4: a pure-box 64^3 scene of seeded random clusters, traced with the
// Phase-1 tracer. No records at all — only the DDA and the pyramid.
const randomBoxes = (() => {
  const resolution = { x: 64, y: 64, z: 64 };
  const rng = mulberry32(0xc0ffee);
  const occupied = new Set();
  for (let cluster = 0; cluster < 24; cluster++) {
    const ox = Math.floor(rng() * 60);
    const oy = Math.floor(rng() * 60);
    const oz = Math.floor(rng() * 60);
    const span = 1 + Math.floor(rng() * 3);
    for (let z = 0; z < span; z++) {
      for (let y = 0; y < span; y++) {
        for (let x = 0; x < span; x++) occupied.add(`${ox + x},${oy + y},${oz + z}`);
      }
    }
  }
  return buildVoxelScene(resolution, occupied);
})();
compareScene("seeded random boxes 64^3", randomBoxes, traceBox, 0x5eed04);
check("skip-equivalence covers at least 100 rays", equivalenceRays >= 100, `rays=${equivalenceRays}`);

// ---------------------------------------------------------------------------
// c. False negatives against exact triangles, pyramid ON. The skip is
// conservative or it is a leak; there is no third option.
{
  const candidate = (ray) => {
    const hit = tracePlane(room, ray, room.pyramid);
    return hit.hit ? { t: hit.t, normal: hit.normal } : { t: -1 };
  };
  const report = validateRayHits(roomRays, room.exact, candidate);
  check("sealed room with the pyramid ON leaks nothing", report.falseNegatives === 0,
    `FN=${report.falseNegatives}/${roomRays.length} FP=${report.falsePositives}`);
  const inward = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 200; i++) {
    const y = 1 - (2 * (i + 0.5)) / 200;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    inward.push({
      origin: [16.3, 16.1, 15.8],
      direction: normalize3([Math.cos(theta) * radius, y, Math.sin(theta) * radius]),
      maxT: 48,
    });
  }
  const interior = validateRayHits(inward, room.exact, candidate);
  check("sealed room stays sealed from the inside with the pyramid ON",
    interior.falseNegatives === 0, JSON.stringify(interior));
}

// ---------------------------------------------------------------------------
// d. Step reduction: one 2^3 cluster in a far corner of a 64^3 grid, long rays
// through the emptiness that the pyramid exists to skip.
{
  const occupied = new Set();
  for (let z = 60; z < 62; z++) {
    for (let y = 60; y < 62; y++) {
      for (let x = 60; x < 62; x++) occupied.add(`${x},${y},${z}`);
    }
  }
  const scene = buildVoxelScene({ x: 64, y: 64, z: 64 }, occupied);
  const rays = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      rays.push({
        origin: [0.5, 2.3 + i * 10, 3.7 + j * 9],
        direction: [1, 0, 0],
        maxT: 200,
      });
    }
  }
  rays.push({ origin: [0.5, 0.5, 0.5], direction: normalize3([1, 1, 1]), maxT: 200 });
  rays.push({ origin: [63.5, 0.5, 0.5], direction: normalize3([-1, 1, 1]), maxT: 200 });
  rays.push({ origin: [0.5, 63.5, 32.5], direction: normalize3([1, -1, 0.2]), maxT: 200 });
  rays.push({ origin: [32.5, 63.5, 0.5], direction: normalize3([0.1, -1, 1]), maxT: 200 });

  let stepsOff = 0;
  let stepsOn = 0;
  let skipsL4 = 0;
  let unresolved = 0;
  let mismatches = 0;
  for (const ray of rays) {
    const off = traceBox(scene, ray, null);
    const on = traceBox(scene, ray, scene.pyramid);
    stepsOff += off.macroSteps;
    stepsOn += on.macroSteps;
    skipsL4 += on.coarseSkipsL4;
    if (off.resolved === false || on.resolved === false) unresolved++;
    if (sameResult(off, on)) mismatches++;
  }
  check("step reduction: at least 40% fewer macro steps", stepsOn < stepsOff * 0.6,
    `on=${stepsOn} off=${stepsOff} rays=${rays.length} ratio=${(stepsOn / stepsOff).toFixed(3)}`);
  check("step reduction: the top level actually skips", skipsL4 > 0, `skipsL4=${skipsL4}`);
  check("step reduction: neither run hits a traversal limit", unresolved === 0, `unresolved=${unresolved}`);
  check("step reduction: answers still agree", mismatches === 0, `mismatches=${mismatches}`);
}

// ---------------------------------------------------------------------------
// e. Boundary adversarial: occupied voxels straddling a level-4 block edge.
// A skip that overshoots by one voxel would show up here and nowhere else.
{
  const occupied = new Set();
  for (let y = 20; y < 44; y++) {
    for (let z = 20; z < 44; z++) {
      occupied.add(`31,${y},${z}`);
      occupied.add(`32,${y},${z}`);
    }
  }
  const scene = buildVoxelScene({ x: 64, y: 64, z: 64 }, occupied);
  const rays = [];
  for (const offset of [-1e-3, 1e-3, -0.25, 0.25, -1.5, 1.5]) {
    for (let i = 0; i < 6; i++) {
      // Along the boundary plane, a hair to either side of it.
      rays.push({ origin: [32 + offset, 21.4 + i * 3.7, 22.6 + i * 3.1], direction: [0, 1, 0.31], maxT: 200 });
      rays.push({ origin: [32 + offset, 43.6 - i * 3.7, 41.4 - i * 3.1], direction: [0, -1, -0.27], maxT: 200 });
      // Straight through it from both sides.
      rays.push({ origin: [0.5, 24.5 + i * 3, 26.5 + i * 2], direction: [1, 1e-3 * (i - 3), 0], maxT: 200 });
      rays.push({ origin: [63.5, 24.5 + i * 3, 26.5 + i * 2], direction: [-1, 1e-3 * (3 - i), 0], maxT: 200 });
      // Entering the boundary block from just before / just after the plane.
      rays.push({ origin: [32 + offset, 22.5 + i * 3, 0.5], direction: normalize3([0.02, 0.01, 1]), maxT: 200 });
    }
  }
  let mismatches = 0;
  let firstMismatch = "";
  let hits = 0;
  for (const ray of rays) {
    const off = traceBox(scene, ray, null);
    const on = traceBox(scene, ray, scene.pyramid);
    if (off.hit) hits++;
    const reason = sameResult(off, on);
    if (reason) {
      mismatches++;
      if (!firstMismatch) firstMismatch = `${JSON.stringify(ray.origin)}: ${reason}`;
    }
  }
  check("boundary-straddling voxels keep hit/voxel parity", mismatches === 0,
    `rays=${rays.length} hits=${hits} mismatches=${mismatches}${firstMismatch ? ` first=${firstMismatch}` : ""}`);
  check("boundary scene actually blocks rays", hits > rays.length / 3, `hits=${hits}/${rays.length}`);
}

// ---------------------------------------------------------------------------
// f. Config: Phase 5 flips enableSkipDistance to an opt-OUT.
{
  check("skip distance defaults ON", resolveRayHitConfig({}, {}).enableSkipDistance === true);
  check("the runtime global can switch it off",
    resolveRayHitConfig({}, { __giRayHitSkipDistance: false }).enableSkipDistance === false);
  check("the component prop can switch it off",
    resolveRayHitConfig({ rayHitSkipDistance: false }, {}).enableSkipDistance === false);
}

// ---------------------------------------------------------------------------
// g. Counter plumbing: the coarse counters must be reported by both tracers,
// and must be exactly zero when no pyramid was handed in.
{
  const ray = { origin: [16.3, 16.1, 15.8], direction: normalize3([1, 0.2, -0.35]), maxT: 64 };
  const on = tracePlane(room, ray, room.pyramid);
  const off = tracePlane(room, ray, null);
  check("a pyramid run reports coarse steps", on.coarseSteps > 0,
    `steps=${on.coarseSteps} descends=${on.coarseDescends} l3=${on.coarseSkipsL3} l4=${on.coarseSkipsL4}`);
  check("coarse steps split into descends and skips",
    on.coarseSteps === on.coarseDescends + on.coarseSkipsL3 + on.coarseSkipsL4,
    `steps=${on.coarseSteps} descends=${on.coarseDescends} l3=${on.coarseSkipsL3} l4=${on.coarseSkipsL4}`);
  check("a no-pyramid run reports zero coarse steps",
    off.coarseSteps === 0 && off.coarseDescends === 0 &&
    off.coarseSkipsL3 === 0 && off.coarseSkipsL4 === 0,
    JSON.stringify({ s: off.coarseSteps, d: off.coarseDescends, l3: off.coarseSkipsL3, l4: off.coarseSkipsL4 }));
  const boxOn = traceBox(randomBoxes, ray, randomBoxes.pyramid);
  const boxOff = traceBox(randomBoxes, ray, null);
  check("the Phase-1 tracer plumbs the same counters",
    boxOn.coarseSteps > 0 && boxOff.coarseSteps === 0,
    `on=${boxOn.coarseSteps} off=${boxOff.coarseSteps}`);
}

console.log(failed === 0 ? "\nGI-RAY-HIT-PHASE5 ALL PASS" : `\nGI-RAY-HIT-PHASE5 ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
