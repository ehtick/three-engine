// Dynamic-record-refit CPU validation: movers get per-chain fitted-plane
// records instead of occupied-box hits. Mirrors the GPU chain order exactly:
// static build (masks + static records fitted against STATIC-only state),
// then the final hybridBuild's merged-mask + DynamicBrick re-typing, then the
// dynamic tail refit (alloc against merged masks, dynamic triangles only,
// simple-plane finalize). Everything runs in level-0 voxel space with unit
// cells, the same space the GPU passes use.
import {
  BRICK_DYNAMIC_OFFSET_WORD,
  BRICK_SURFACE_OFFSET_WORD,
  INVALID_RAY_HIT_INDEX,
  MACRO_CELL_METADATA_WORD,
  MacroCellType,
  SURFACE_RECORD_WORDS,
  buildDynamicSurfaceRecordsCpu,
  buildHybridBrickWords,
  buildSurfaceRecordsCpu,
  brickHeaderWord,
  macroCellLinearIndex,
  macroCellWord,
  traceHybridPlaneCpu,
  triBoxOverlapCpu,
  unpackMacroCellMetadata,
  updateHybridBrickWordsCpu,
} from "../src/modules/gi/rayHit/RayHitPacking.js";

let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed++;
};

// Conservative CPU voxelization with the voxelizer's own SAT and span.
const voxelize = (resolution, triangles) => {
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
  return occupied;
};

const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const STATIC_CAPACITY = 4096;
const DYNAMIC_CAPACITY = 512;

const STATIC_TRI_CAPACITY = 4096;
const DYNAMIC_TRI_CAPACITY = 1024;

/**
 * Full CPU mirror of one GPU dispatch: static build once, then a merged
 * re-type + dynamic refit for the mover's CURRENT triangles. Returns
 * everything a trace needs plus the build diagnostics. `complex: true`
 * mirrors exact-complex mode: one flat absolute-offset triangle pool shared
 * by the static build ([0, STATIC_TRI_CAPACITY)) and the dynamic tail slice
 * after it.
 */
const buildFrame = (resolution, staticTriangles, moverTriangles, {
  dynamicCapacity = DYNAMIC_CAPACITY,
  complex = false,
} = {}) => {
  const staticOccupied = voxelize(resolution, staticTriangles);
  const staticPred = (x, y, z) => staticOccupied.has(`${x},${y},${z}`);
  const { layout, words } = buildHybridBrickWords(resolution, staticPred);
  const staticBuild = buildSurfaceRecordsCpu(resolution, words, layout, staticTriangles, {
    capacity: STATIC_CAPACITY,
    triangleCapacity: STATIC_TRI_CAPACITY,
  });
  const moverOccupied = voxelize(resolution, moverTriangles);
  const mergedPred = (x, y, z) => staticPred(x, y, z) || moverOccupied.has(`${x},${y},${z}`);
  updateHybridBrickWordsCpu(resolution, words, layout, mergedPred, staticPred);
  const records = new Uint32Array((STATIC_CAPACITY + dynamicCapacity) * SURFACE_RECORD_WORDS);
  records.set(staticBuild.records);
  let trianglePool = null;
  if (complex) {
    trianglePool = new Float32Array((STATIC_TRI_CAPACITY + DYNAMIC_TRI_CAPACITY) * 9);
    trianglePool.set(staticBuild.trianglePool);
  }
  const dynamicBuild = buildDynamicSurfaceRecordsCpu(resolution, words, layout, moverTriangles, {
    dynamicBase: STATIC_CAPACITY,
    dynamicCapacity,
    records,
    ...(complex
      ? { complexPool: { base: STATIC_TRI_CAPACITY, capacity: DYNAMIC_TRI_CAPACITY, pool: trianglePool } }
      : {}),
  });
  return { layout, words, records, trianglePool, staticBuild, dynamicBuild, staticOccupied, moverOccupied };
};

const trace = (frame, resolution, origin, direction, opts = {}) => traceHybridPlaneCpu(
  origin, direction, resolution, frame.words, frame.layout, frame.records,
  {
    tMax: 32, coverage: true,
    ...(frame.trianglePool ? { exactComplex: true, trianglePool: frame.trianglePool } : {}),
    ...opts,
  },
);

// Double-precision Möller-Trumbore for exact silhouette references.
const exactHit = (origin, direction, triangles) => {
  let best = Infinity;
  for (const [a, b, c] of triangles) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      direction[1] * e2[2] - direction[2] * e2[1],
      direction[2] * e2[0] - direction[0] * e2[2],
      direction[0] * e2[1] - direction[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
    ];
    const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (t > 1e-6 && t < best) best = t;
  }
  return best;
};

// ---------------------------------------------------------------------------
// Scene: static floor quad at y = 3.25 across the volume; the MOVER is an
// axis-aligned quad at y = 8.25 (mid-air, its own bricks) plus a tilted quad
// variant for the normal check.
const resolution = { x: 16, y: 16, z: 16 };
const floorTris = quad([1, 3.25, 1], [15, 3.25, 1], [15, 3.25, 15], [1, 3.25, 15]);
const moverTris = quad([5, 8.25, 5], [11, 8.25, 5], [11, 8.25, 11], [5, 8.25, 11]);

{
  const frame = buildFrame(resolution, floorTris, moverTris);

  // --- typing + allocation
  const moverMacro = macroCellLinearIndex(2, 2, 2, frame.layout.macroResolution); // cell (8,8,8)
  const moverMeta = unpackMacroCellMetadata(
    frame.words[macroCellWord(frame.layout, moverMacro, MACRO_CELL_METADATA_WORD)],
  );
  check("mover brick types DynamicBrick", moverMeta.type === MacroCellType.DynamicBrick,
    `type=${moverMeta.type}`);
  const moverDynOffset = frame.words[brickHeaderWord(frame.layout, moverMacro, BRICK_DYNAMIC_OFFSET_WORD)];
  check("mover brick claims a dynamic tail offset >= dynamicBase",
    moverDynOffset !== INVALID_RAY_HIT_INDEX && moverDynOffset >= STATIC_CAPACITY,
    `offset=${moverDynOffset}`);
  const floorMacro = macroCellLinearIndex(0, 0, 0, frame.layout.macroResolution);
  const floorMeta = unpackMacroCellMetadata(
    frame.words[macroCellWord(frame.layout, floorMacro, MACRO_CELL_METADATA_WORD)],
  );
  check("pure-static brick stays type Brick", floorMeta.type === MacroCellType.Brick,
    `type=${floorMeta.type}`);
  check("pure-static brick keeps INVALID dynamic offset",
    frame.words[brickHeaderWord(frame.layout, floorMacro, BRICK_DYNAMIC_OFFSET_WORD)] === INVALID_RAY_HIT_INDEX);
  check("dynamic tail allocated records for the mover's occupied voxels",
    frame.dynamicBuild.allocated > 0 && frame.dynamicBuild.overflowBricks === 0,
    `allocated=${frame.dynamicBuild.allocated}`);
  check("mover cells fit simple planes", frame.dynamicBuild.simpleCells > 0,
    `simple=${frame.dynamicBuild.simpleCells}`);

  // --- the acceptance case: sub-voxel mover hit instead of the voxel hull.
  // Down ray from y=12 onto the mover plane at y=8.25: exact t = 3.75. The
  // box arm stops at the voxel's top face y=9 → t = 3.0.
  const hit = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0]);
  check("mover resolves via fitted plane", hit.hit && hit.kind === "plane", `kind=${hit.kind}`);
  check("mover hit distance is sub-voxel exact", hit.hit && Math.abs(hit.t - 3.75) < 5e-3,
    `t=${hit.t}`);
  check("mover hit normal is +Y", hit.hit && Math.abs(hit.normal[1] - 1) < 1e-3,
    `n=${hit.normal}`);

  // Strip the dynamic offsets (refit off / pre-feature state): same ray must
  // fall back to the box arm — never a miss, but voxel-quantized again.
  const stripped = frame.words.slice();
  for (let macro = 0; macro < frame.layout.macroCellCount; macro++) {
    stripped[brickHeaderWord(frame.layout, macro, BRICK_DYNAMIC_OFFSET_WORD)] = INVALID_RAY_HIT_INDEX;
  }
  const boxHit = traceHybridPlaneCpu(
    [8.3, 12, 8.7], [0, -1, 0], resolution, stripped, frame.layout, frame.records,
    { tMax: 32, coverage: true },
  );
  check("without dynamic records the mover still hits (box fallback, no miss)",
    boxHit.hit && boxHit.kind === "box", `kind=${boxHit.kind}`);
  check("box fallback is voxel-quantized (the artifact this feature removes)",
    boxHit.hit && Math.abs(boxHit.t - 3.0) < 5e-3, `t=${boxHit.t}`);

  // --- static floor unaffected: far from the mover, records still serve.
  const floorHit = trace(frame, resolution, [3.4, 9, 3.6], [0, -1, 0]);
  check("static floor still resolves via its static record", floorHit.hit && floorHit.kind === "plane",
    `kind=${floorHit.kind}`);
  check("static floor hit stays sub-voxel exact", floorHit.hit && Math.abs(floorHit.t - 5.75) < 5e-3,
    `t=${floorHit.t}`);

  // --- pen (shadow) variant reads dynamic records too: a ray blocked by the
  // mover keeps its hit, a clear ray stays pen = 1.
  const penHit = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0], { penumbraK: 8, voxelWorld: 1 });
  check("pen variant hits the mover plane", penHit.hit === true, `hit=${penHit.hit}`);
  const penClear = trace(frame, resolution, [8.3, 12.5, 1.2], [0, 0, 1], { penumbraK: 8, voxelWorld: 1 });
  check("pen variant clear ray stays unoccluded", !penClear.hit && penClear.pen === 1,
    `pen=${penClear.pen}`);
}

// ---------------------------------------------------------------------------
// Mixed brick: mover UNDER the floor shares the floor's brick. Mover cells
// get dynamic plane records; the brick's STATIC cells refit unfitted (no
// dynamic triangles touch them) and must fall back to box — never a miss.
{
  const lowMover = quad([5, 2.5, 5], [7, 2.5, 5], [7, 2.5, 7], [5, 2.5, 7]);
  const frame = buildFrame(resolution, floorTris, lowMover);
  const macro = macroCellLinearIndex(1, 0, 1, frame.layout.macroResolution); // cells (4-7, 0-3, 4-7)
  const meta = unpackMacroCellMetadata(
    frame.words[macroCellWord(frame.layout, macro, MACRO_CELL_METADATA_WORD)],
  );
  check("mixed floor+mover brick types DynamicBrick", meta.type === MacroCellType.DynamicBrick,
    `type=${meta.type}`);

  // Up ray in the mover's column: mover voxel (y=2) comes first → plane hit
  // at y=2.5, t = 2.0 from y=0.5.
  const up = trace(frame, resolution, [5.6, 0.5, 5.4], [0, 1, 0]);
  check("mover cell in mixed brick resolves via dynamic plane", up.hit && up.kind === "plane",
    `kind=${up.kind}`);
  check("mixed-brick mover hit is sub-voxel exact", up.hit && Math.abs(up.t - 2.0) < 5e-3,
    `t=${up.t}`);

  // Up ray outside the mover footprint but inside the same brick: first
  // occupied voxel is the STATIC floor cell (y=3) whose dynamic record is
  // unfitted → box fallback, hit at the voxel's bottom face y=3 (t=2.5).
  const staticCol = trace(frame, resolution, [7.5, 0.5, 5.4], [0, 1, 0]);
  check("static cell in a DynamicBrick falls back to box (never a miss)",
    staticCol.hit && staticCol.kind === "box", `kind=${staticCol.kind}, hit=${staticCol.hit}`);
  check("static-cell box fallback lands on the voxel face", staticCol.hit && Math.abs(staticCol.t - 2.5) < 5e-3,
    `t=${staticCol.t}`);
}

// ---------------------------------------------------------------------------
// Tilted mover: the fitted normal must follow the mover's real orientation,
// not a voxel face — the silhouette-exactness the feature exists for.
{
  const s = Math.SQRT1_2;
  const tilted = quad(
    [6, 8 - 1.5 * s, 6], [10, 8 - 1.5 * s, 6],
    [10, 8 + 1.5 * s, 10], [6, 8 + 1.5 * s, 10],
  ); // slope dy/dz = 3s/4 → true normal ∝ (0, 1, -3s/4)
  const slope = (3 * s) / 4;
  const invLen = 1 / Math.hypot(1, slope);
  const trueNormal = [0, invLen, -slope * invLen];
  const frame = buildFrame(resolution, floorTris, tilted);
  const hit = trace(frame, resolution, [8.2, 12, 7.8], [0, -1, 0]);
  check("tilted mover resolves via fitted plane", hit.hit && hit.kind === "plane", `kind=${hit.kind}`);
  const alignment = hit.hit
    ? hit.normal[1] * trueNormal[1] + hit.normal[2] * trueNormal[2]
    : 0;
  check("tilted mover normal follows the geometry (not a voxel face)",
    hit.hit && Math.abs(alignment) > 0.999, `n=${hit.normal}`);
}

// ---------------------------------------------------------------------------
// ROTATED mover cube in exact mode — the class the dynamic triangle tail
// exists for: the silhouette (as seen along the ray) is formed by EDGE cells
// holding two faces, which fail the simple fit; without exact triangles they
// box-fall-back and quantize the shadow outline to full voxels.
const rotatedBox = (center, half, ry, rx) => {
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const corners = [];
  for (const dz of [0, 1]) {
    for (const dy of [0, 1]) {
      for (const dx of [0, 1]) {
        let x = (dx * 2 - 1) * half, y = (dy * 2 - 1) * half, z = (dz * 2 - 1) * half;
        [x, z] = [x * cy + z * sy, -x * sy + z * cy];
        [y, z] = [y * cx - z * sx, y * sx + z * cx];
        corners.push([center[0] + x, center[1] + y, center[2] + z]);
      }
    }
  }
  const idx = (dx, dy, dz) => dz * 4 + dy * 2 + dx;
  const quads = [
    [idx(0, 0, 0), idx(1, 0, 0), idx(1, 1, 0), idx(0, 1, 0)],
    [idx(1, 0, 1), idx(0, 0, 1), idx(0, 1, 1), idx(1, 1, 1)],
    [idx(0, 0, 1), idx(0, 0, 0), idx(0, 1, 0), idx(0, 1, 1)],
    [idx(1, 0, 0), idx(1, 0, 1), idx(1, 1, 1), idx(1, 1, 0)],
    [idx(0, 1, 0), idx(1, 1, 0), idx(1, 1, 1), idx(0, 1, 1)],
    [idx(0, 0, 1), idx(1, 0, 1), idx(1, 0, 0), idx(0, 0, 0)],
  ];
  const tris = [];
  for (const [a, b, c, d] of quads) {
    tris.push([corners[a], corners[b], corners[c]], [corners[a], corners[c], corners[d]]);
  }
  return tris;
};
{
  const box = rotatedBox([8, 8, 8], 1.5, 0.6, 0.4);
  const frame = buildFrame(resolution, floorTris, box, { complex: true });
  check("rotated mover reserves dynamic exact triangles",
    frame.dynamicBuild.dynamicTriangles > 0 && frame.dynamicBuild.complexOverflowCells === 0,
    `tris=${frame.dynamicBuild.dynamicTriangles}, complexCells=${frame.dynamicBuild.complexCells}`);

  // The box-arm control: strip the dynamic offsets so every mover brick keeps
  // voxel-box semantics — the pre-feature state.
  const stripped = frame.words.slice();
  for (let macro = 0; macro < frame.layout.macroCellCount; macro++) {
    stripped[brickHeaderWord(frame.layout, macro, BRICK_DYNAMIC_OFFSET_WORD)] = INVALID_RAY_HIT_INDEX;
  }

  // Sun-style down-ray sweep across the footprint, judged against
  // double-precision triangle intersection. Silhouette metric: rays the real
  // geometry MISSES must sail past the mover and reach the floor (t = 9.75);
  // any that get stopped are silhouette FATTENING. Hit rays must land close.
  let hitErrMax = 0;
  let hitMissed = 0;
  let boxKindHits = 0;
  let triangleKindHits = 0;
  let missCount = 0;
  let fattenedExact = 0;
  let fattenedBox = 0;
  for (let ix = 0; ix <= 40; ix++) {
    for (let iz = 0; iz <= 40; iz++) {
      const origin = [5 + (6 * ix) / 40, 13, 5 + (6 * iz) / 40];
      const dir = [0, -1, 0];
      const exact = exactHit(origin, dir, box);
      const hit = trace(frame, resolution, origin, dir);
      if (Number.isFinite(exact)) {
        if (!hit.hit) { hitMissed++; continue; }
        hitErrMax = Math.max(hitErrMax, Math.abs(hit.t - exact));
        if (hit.kind === "box") boxKindHits++;
        if (hit.kind === "triangles") triangleKindHits++;
      } else {
        missCount++;
        if (!(hit.hit && Math.abs(hit.t - 9.75) < 0.05)) fattenedExact++;
        const boxHit = traceHybridPlaneCpu(
          origin, dir, resolution, stripped, frame.layout, frame.records,
          { tMax: 32, coverage: true },
        );
        if (!(boxHit.hit && Math.abs(boxHit.t - 9.75) < 0.05)) fattenedBox++;
      }
    }
  }
  check("rotated mover blocked rays never miss", hitMissed === 0, `missed=${hitMissed}`);
  check("rotated mover hits are geometry-exact (edge cells included)", hitErrMax < 0.06,
    `maxErr=${hitErrMax.toFixed(4)} voxels`);
  check("no mover cell degrades to box in exact mode", boxKindHits === 0, `boxKinds=${boxKindHits}`);
  check("edge cells resolve via exact triangles", triangleKindHits > 0, `triangleHits=${triangleKindHits}`);
  check("silhouette fattening collapses vs the box arm",
    fattenedBox > 0 && fattenedExact <= Math.ceil(fattenedBox * 0.35),
    `exact=${fattenedExact} vs box=${fattenedBox} of ${missCount} miss rays`);
}

// ---------------------------------------------------------------------------
// Refit-on-move: the same words/records rebuilt for the mover's NEW pose must
// serve the new position plane-exact and leave nothing at the old one —
// dynamic records live one dispatch, so staleness is structurally impossible.
{
  const frame = buildFrame(resolution, floorTris, moverTris);
  const before = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0]);
  check("pre-move mover hit (control)", before.hit && Math.abs(before.t - 3.75) < 5e-3, `t=${before.t}`);

  // Frame 2: mover moved +0.5 in y (sub-voxel) — rebuild merged masks +
  // dynamic tail in place, exactly what a fast chain does.
  const movedTris = quad([5, 8.75, 5], [11, 8.75, 5], [11, 8.75, 11], [5, 8.75, 11]);
  const movedOccupied = voxelize(resolution, movedTris);
  const staticPred = (x, y, z) => frame.staticOccupied.has(`${x},${y},${z}`);
  updateHybridBrickWordsCpu(
    resolution, frame.words, frame.layout,
    (x, y, z) => staticPred(x, y, z) || movedOccupied.has(`${x},${y},${z}`),
    staticPred,
  );
  const refit = buildDynamicSurfaceRecordsCpu(resolution, frame.words, frame.layout, movedTris, {
    dynamicBase: STATIC_CAPACITY,
    dynamicCapacity: DYNAMIC_CAPACITY,
    records: frame.records,
  });
  check("refit reallocates from a reset cursor", refit.allocated > 0 && refit.overflowBricks === 0,
    `allocated=${refit.allocated}`);
  const after = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0]);
  check("post-move hit tracks the new pose sub-voxel exact",
    after.hit && Math.abs(after.t - 3.25) < 5e-3, `t=${after.t}, kind=${after.kind}`);

  // Frame 3: mover leaves entirely — its bricks revert to type Brick with no
  // dynamic bits, and the volume above the floor is clear again.
  updateHybridBrickWordsCpu(resolution, frame.words, frame.layout, staticPred, staticPred);
  buildDynamicSurfaceRecordsCpu(resolution, frame.words, frame.layout, [], {
    dynamicBase: STATIC_CAPACITY,
    dynamicCapacity: DYNAMIC_CAPACITY,
    records: frame.records,
  });
  const gone = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0]);
  check("departed mover leaves no stale hit — ray reaches the floor's static record",
    gone.hit && gone.kind === "plane" && Math.abs(gone.t - (12 - 3.25)) < 5e-3,
    `t=${gone.t}, kind=${gone.kind}`);
  const revertMacro = macroCellLinearIndex(2, 2, 2, frame.layout.macroResolution);
  const revertMeta = unpackMacroCellMetadata(
    frame.words[macroCellWord(frame.layout, revertMacro, MACRO_CELL_METADATA_WORD)],
  );
  check("departed mover's brick reverts to Empty", revertMeta.type === MacroCellType.Empty,
    `type=${revertMeta.type}`);
}

// ---------------------------------------------------------------------------
// Tail overflow: with a capacity too small for the mover, allocation denies
// the bricks, offsets stay INVALID, the counter reports it, and every ray
// degrades to box — never a miss.
{
  const frame = buildFrame(resolution, floorTris, moverTris, { dynamicCapacity: 4 });
  check("starved tail reports overflow bricks", frame.dynamicBuild.overflowBricks > 0,
    `overflow=${frame.dynamicBuild.overflowBricks}`);
  const hit = trace(frame, resolution, [8.3, 12, 8.7], [0, -1, 0]);
  check("starved mover brick degrades to box, never a miss", hit.hit && hit.kind === "box",
    `kind=${hit.kind}, hit=${hit.hit}`);
}

// ---------------------------------------------------------------------------
// Static-offset sanity: the static allocator's offsets survive the merged
// re-type untouched (the GPU kernels never write word 2 outside the static
// allocator — this guards the CPU mirror's parity with that rule).
{
  const frame = buildFrame(resolution, floorTris, moverTris);
  const staticOnly = buildHybridBrickWords(resolution,
    (x, y, z) => frame.staticOccupied.has(`${x},${y},${z}`));
  buildSurfaceRecordsCpu(resolution, staticOnly.words, staticOnly.layout, floorTris, {
    capacity: STATIC_CAPACITY,
  });
  let mismatches = 0;
  for (let macro = 0; macro < frame.layout.macroCellCount; macro++) {
    const a = frame.words[brickHeaderWord(frame.layout, macro, BRICK_SURFACE_OFFSET_WORD)];
    const b = staticOnly.words[brickHeaderWord(staticOnly.layout, macro, BRICK_SURFACE_OFFSET_WORD)];
    if (a !== b) mismatches++;
  }
  check("static surface offsets identical before/after the dynamic build", mismatches === 0,
    `mismatches=${mismatches}`);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
