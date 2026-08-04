# Radiance-cascade ray hit: Phase 4 (exact complex-cell triangles)

`HybridExactComplex` is active. Complex cells — the ones Phase 2's
classification refused a plane for (incoherent normals, multi-layer,
too many triangles, degenerate fits) — now resolve through short exact
triangle lists instead of the occupied-box fallback. Implemented as two
parallel tracks (CPU mirror + tests, GPU passes + trace) against the shared
layout constants in `RayHitPacking.js`.

## Representation

A complex cell reuses its ALREADY-ALLOCATED four-word SurfaceRecord:

```text
word 2  poolTriangleOffset (26 bits) | count << 26   (count ≤ 16)
flags   SURFACE_FLAG_COMPLEX (bit 20), coverage-valid 0
```

The triangle pool is appended to the same `bits` allocation after the
surface-record pool — **still zero new trace-side storage bindings**. One pool
triangle = 9 f32-bitcast words (3 vertices, CELL-LOCAL voxel space, UNCLIPPED,
full precision — quantization is deferred per the design doc). Capacity
defaults to `clamp(surfaceCapacity * 2, 2^12, 2^21)` triangles
(`complexTriangleCapacity` option); over-limit cells (> 16 triangles) and
pool exhaustion keep the occupied-box fallback and count into
`surfAlloc[3]` — never a miss.

## Build

Two additions to the FULL-chain surface build (fast chains still never touch
records; DynamicBrick semantics unchanged):

- **finalize** now reserves: a record with weight but no accepted plane —
  including the degenerate cancelled-normal case (opposing faces), which the
  restructured pass routes past the simple fit — claims a pool range via
  `atomicAdd`, packs word 2, sets the COMPLEX flag, and resets its scratch
  overlap-count word to zero as the write cursor.
- **a new geometry pass** (structural clone of the accumulate pass: same
  static-slot filter, same SAT, same degenerate-triangle reject — the two
  MUST agree exactly on which (triangle, cell) pairs exist or a short list
  reads as an exact miss, i.e. a leak) claims cursor slots per overlap and
  writes the cell-local vertices.

## Traversal

In the brick DDA, after the simple-plane branch and before the box fallback:
a COMPLEX record runs a bounded (`MAX_COMPLEX_TRIANGLES`) double-sided
Möller–Trumbore loop over its list, nearest hit inside the cell's
`[entry, exit]` ray interval. Found → exact `t` + geometric normal (flipped
toward the ray; voxel-space cross products transform to world through the
same `voxelInv` covariant map the plane normals use). **Empty result → the
DDA CONTINUES** — with the complete per-cell triangle list an exact miss is a
real miss, which is the whole accuracy point over the box. Barycentric
acceptance carries ±1e-6 slack: shared-edge seams computed from independent
f32 cross products would otherwise let rays through — and here a false miss
continues the march, i.e. leaks.

## Validation (2026-08-04)

CPU (`npm run test:gi-rayhit-phase4`, 21/21, vs exact double MT):

```text
thin double wall   box err 0.400 → exact 6.0e-9; all rays kind "triangles"; FN 0
sealed room        FN 0/200 corner rays, median error 0.0 (was box at corners)
UV sphere          FN 0/96, median 1.2e-8 vs box 0.731; polar >16-tri cells
                   correctly degrade to boxes (P95 0.36, "explicitly reported")
nested sphere+floor  FP 0 FN 0, 64/64 rays pick the nearest surface
starved pool       overflow=195 reported, FN 0 (box seals)
range packing      offset/count round-trips at field-width edges
```

GPU smoke (`?mode=hybrid-exact-complex`, storage=8, validation errors 0,
post-cursor-fix numbers — see the addendum below):

```text
rays 1.46M · complexTests 7552 · triangleTests 17792 · complexAccepts 2816
complexMisses 4736 (exact misses that CONTINUED the march)
poolTris 1652 · complexOverflow 0 · boxFallbacks 0  ← every occupied cell in
the scene now resolves via plane or exact triangles
limitExits 0 · invalid 0 · largest composed kernel exactly 8 storage bindings
```

## Addendum (2026-08-04, later): the write-cursor default-zero bug

The pass shipped with `atomicAdd(scratch_i32, int(1)).toUint()` as the pool
write cursor. In three's TSL, a ConvertNode as an atomic's only consumer does
not register as a value parent, so the atomic emits as a bare statement and
the value read is SUBSTITUTED WITH A DEFAULT 0 — announced only by a soft
`THREE.TSL: Invalid generated code, expected a "int"` console error that the
harness greps happened to filter (it contains no "error" substring). Effect:
every overlapping triangle wrote pool slot 0, so each complex cell's list
held one arbitrary triangle plus zeros, and the missing triangles read as
exact misses — which in this design CONTINUE the march, i.e. leaks. The CPU
suites could not see it (the CPU mirror's pool was correct); the counters
could not see it (allocation and counts were right). Fix: `.toVar()` DIRECTLY
on the atomic (the shape finalize's u32 claim already used), then convert.
Post-fix the same smoke scene resolves 2816 accepts / 4736 misses instead of
203 / 903 — the lists are simply complete now. Bisected via temporary
`__giDiag*` compile-out hooks; audit found no sibling occurrence (all other
atomics either discard the return or `.toVar()` it directly).

Regression arms after integration: `hybrid-plane-coverage` and
`hybrid-brick-box` smoke PASS unchanged; all four CPU suites + `check:types`
+ `build` green.

## Known limits / follow-ups

- **Pool sizing on real scenes**: the default (`surfaceCapacity * 2`) is
  ~1.57M triangles ≈ 57 MB at Sponza-scale resolution (total `bits` ~72 MB,
  under the 128 MiB binding floor, allocated only in exact-complex mode).
  The smoke's `poolTris` readout is the number to size from; expect a
  measured default revision after a real-scene run.
- Triangle order within a list is GPU-write order (atomic cursor), not
  deterministic across rebuilds; nearest-hit over the set is
  order-independent, so results are stable even though buffer bytes are not.
- Dynamic geometry still box-resolves brick-wide (DynamicBrick); skinned
  meshes are not voxelized at all (unchanged engine-wide limit).
- Next levers (user-requested direction): route the emitter/sun GI-shadow
  cone traces through this hybrid hit path (removes voxel-hull silhouettes
  from `shadowMode:"gi"` at small source angles), then a volumetric
  fog/godray march sampling the radiance field with occupancy-shadowed sun.
