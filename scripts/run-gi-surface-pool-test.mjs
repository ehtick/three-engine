/**
 * GI surface-record pool sizing (src/modules/gi/occupancyField.js).
 *
 *   node scripts/run-gi-surface-pool-test.mjs
 *
 * `planSurfacePools` is pure arithmetic and this file exists because it USED to
 * be forty lines inside `createOccupancyField`, which allocates GPU storage and
 * cannot run headlessly. That is precisely how the bug below survived the
 * sessions that tuned it: the numbers had no way of being asserted on, so a
 * constant collision that silently disabled a measured ratio went unnoticed
 * until it showed up on screen as moving black patches.
 */
import assert from "node:assert/strict";

// `createOccupancyField` builds TSL node graphs, which are CPU-side objects — no
// device required. These stubs are only for three's DOM-sniffing at import.
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.document ??= {
  createElement: () => ({ style: {}, getContext: () => null }),
  addEventListener() {},
  body: {},
};

const THREE = await import("three/webgpu");
const { planSurfacePools, createOccupancyField } = await import("../src/modules/gi/occupancyField.js");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

const on = { surfaceEnabled: true, complexEnabled: true };
/** Bistro at GI ultra: a 448 x 352 x 448 level-0 grid over a 47 m volume. */
const BISTRO_VOXELS = 448 * 352 * 448;
/** Cornell-scale: the small end the /12 baseline exists for. */
const CORNELL_VOXELS = 64 * 64 * 64;

check("the triangle pool actually gets its 1.5x ratio at the record ceiling", () => {
  // ⚠ THE REGRESSION. Both pools were clamped by the same `1 << 21`, so once a
  // scene reached the record ceiling the intended 2097152 * 1.5 = 3145728 was
  // clamped straight back to 2097152 and the triangle pool could never exceed
  // the record pool. Live on Bistro that read
  // `triangles 4173329/2097152` — 199% of a capacity it could not be given —
  // and 289858 cells fell back to voxel-box hits.
  const pools = planSurfacePools({ level0VoxelCount: BISTRO_VOXELS, ...on });
  assert.equal(pools.surfaceCapacity, 1 << 21, "precondition: this scene reaches the record ceiling");
  assert.ok(
    pools.complexTriangleCapacity > pools.surfaceCapacity,
    `THE REGRESSION: triangle pool ${pools.complexTriangleCapacity} <= record pool ${pools.surfaceCapacity} — the ratio was clamped away`,
  );
  assert.equal(
    pools.complexTriangleCapacity, 3_145_728,
    "the ceiling must be derived from COMPLEX_TRIANGLES_PER_RECORD, not collide with it",
  );
});

check("the ratio holds below the ceiling too", () => {
  const pools = planSurfacePools({ level0VoxelCount: CORNELL_VOXELS, ...on });
  assert.equal(
    pools.complexTriangleCapacity,
    Math.ceil(pools.surfaceCapacity * 1.5),
    "a small scene must show the same relationship as a large one",
  );
});

check("a small scene is unchanged — the /12 baseline still governs", () => {
  // The record pool's own sizing is untouched by the triangle fix, and this is
  // the check that says so: §12.52.2 raised Cornell-ultra to a /3-of-grid pool
  // against an 8 MB budget, and that number must not move.
  const pools = planSurfacePools({ level0VoxelCount: CORNELL_VOXELS, ...on });
  assert.equal(pools.surfaceCapacity, Math.ceil(CORNELL_VOXELS / 3));
  assert.ok(pools.surfaceCapacity >= 1 << 14, "and never below the floor");
});

check("an explicit capacity override wins, and is still clamped", () => {
  // This is the path the grow-on-pressure hint uses (`_surfacePoolHint`), so a
  // runaway demand counter must not be able to allocate an arbitrary buffer.
  const asked = planSurfacePools({
    level0VoxelCount: BISTRO_VOXELS, ...on, complexTriangleCapacity: 2_500_000,
  });
  assert.equal(asked.complexTriangleCapacity, 2_500_000, "an override under the ceiling is honoured");
  const absurd = planSurfacePools({
    level0VoxelCount: BISTRO_VOXELS, ...on, complexTriangleCapacity: 999_999_999,
  });
  assert.equal(
    absurd.complexTriangleCapacity, 5_242_880,
    "an override above the ceiling must clamp, not allocate a gigabyte",
  );
});

check("the ceiling covers the measured Bistro demand, with margin", () => {
  // ⚠ THE CEILING IS NOT THE DEFAULT. Deriving it from
  // COMPLEX_TRIANGLES_PER_RECORD made it clamp exactly the scenes it exists to
  // serve — every scene whose real ratio came out ABOVE the default. Bistro's
  // grow-on-pressure hint asked for 3 955 759 and was handed 3 145 728: still
  // 1.14x oversubscribed, "converging" on a limit it could never reach.
  //
  // 4 173 329 is the peak demand read off the live scene; its real ratio is
  // 2.09 triangles per record against Sponza's 1.21.
  // ⚠ Pass the demand as an OVERRIDE — that is the path `_surfacePoolHint`
  // takes, and the only path the ceiling is on. With no override the function
  // returns the 1.5 DEFAULT and the ceiling is never consulted, so asserting on
  // a plain call would test the wrong number entirely.
  const measuredPeakDemand = 4_173_329;
  const granted = planSurfacePools({
    level0VoxelCount: BISTRO_VOXELS, ...on, complexTriangleCapacity: measuredPeakDemand,
  });
  assert.equal(
    granted.complexTriangleCapacity, measuredPeakDemand,
    `THE REGRESSION: the measured demand was clamped to ${granted.complexTriangleCapacity} — ` +
      "cells fall back to voxel boxes and the patches come back",
  );
});

check("a scene that does not need the headroom does not allocate it", () => {
  // The ceiling only binds an explicit request. The DEFAULT is still the 1.5
  // ratio measured on Sponza, so raising the ceiling must not enlarge any pool
  // that never asked — otherwise this trades the artifact for 76 MB on every
  // room-sized scene in the project.
  const small = planSurfacePools({ level0VoxelCount: CORNELL_VOXELS, ...on });
  assert.equal(
    small.complexTriangleCapacity,
    Math.ceil(small.surfaceCapacity * 1.5),
    "an unmeasured scene must still size from the 1.5 default, not from the ceiling",
  );
  const big = planSurfacePools({ level0VoxelCount: BISTRO_VOXELS, ...on });
  assert.equal(
    big.complexTriangleCapacity,
    Math.ceil(big.surfaceCapacity * 1.5),
    "and so must a large scene that has not yet reported oversubscription",
  );
});

check("disabled features allocate nothing", () => {
  const off = planSurfacePools({
    level0VoxelCount: BISTRO_VOXELS, surfaceEnabled: false, complexEnabled: false,
  });
  assert.equal(off.surfaceCapacity, 0);
  assert.equal(off.complexTriangleCapacity, 0);
  assert.equal(off.dynamicSurfaceCapacity, 0);
  assert.equal(off.dynamicComplexTriangleCapacity, 0);
});

check("records on, complex triangles off — the plane-only tiers", () => {
  const planeOnly = planSurfacePools({
    level0VoxelCount: BISTRO_VOXELS, surfaceEnabled: true, complexEnabled: false,
  });
  assert.ok(planeOnly.surfaceCapacity > 0, "records still allocate");
  assert.equal(planeOnly.complexTriangleCapacity, 0, "the triangle pool is complex-only");
  assert.equal(planeOnly.dynamicComplexTriangleCapacity, 0);
});

check("the dynamic tail stays a small fraction of the static pool", () => {
  // It is re-fitted every chain for movers only; sizing it like the static pool
  // would be pure waste in a buffer that is already the field's largest term.
  const pools = planSurfacePools({ level0VoxelCount: BISTRO_VOXELS, ...on });
  assert.ok(
    pools.dynamicSurfaceCapacity <= pools.surfaceCapacity / 8,
    "the dynamic record tail must stay small next to the static pool",
  );
  assert.equal(pools.dynamicComplexTriangleCapacity, pools.dynamicSurfaceCapacity * 2);
});

// ---- the field actually builds ---------------------------------------------

check("createOccupancyField still constructs with records + complex triangles", () => {
  // ⚠ THE GAP THIS CLOSES, and it cost a live editor break. Extracting the pool
  // sizing left `complexEnabled` undeclared while eight later call sites still
  // read it — a plain `ReferenceError` that a clean `vite build` and every other
  // suite sailed straight past, because nothing constructed the field outside a
  // browser. It surfaced only as `Uncaught ReferenceError: complexEnabled is not
  // defined` in the running editor's console, after a two-minute boot.
  //
  // It needs no GPU: the field builds TSL node graphs, which are CPU-side.
  // Cheap coverage for the whole allocator's top half.
  const bounds = new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8));
  const field = createOccupancyField(bounds, { x: 32, y: 32, z: 32 }, {
    enableSurfaceRecords: true,
    enableComplexTriangles: true,
    enableHybridBrick: true,
  });
  assert.ok(field, "the field must construct");
  assert.equal(field.hasSurfaceRecords, true, "records must be reported as present");
});

check("createOccupancyField constructs in the plane-only and records-off tiers", () => {
  // The other two branches through the same code, since `complexEnabled` and
  // `surfaceEnabled` gate different halves of it.
  const bounds = new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8));
  assert.ok(createOccupancyField(bounds, { x: 32, y: 32, z: 32 }, {
    enableSurfaceRecords: true, enableComplexTriangles: false, enableHybridBrick: true,
  }), "plane-only must construct");
  assert.ok(createOccupancyField(bounds, { x: 32, y: 32, z: 32 }, {
    enableSurfaceRecords: false, enableComplexTriangles: false,
  }), "records-off must construct");
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
