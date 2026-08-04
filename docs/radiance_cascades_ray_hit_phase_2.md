# Radiance-cascade ray hit: Phase 2 (+ Phase 3 activation)

Phase 2 implements `HybridPlane` and, because the Phase-3 CPU foundation
already existed, activates `HybridPlaneCoverage` in the same trace variant.
`OccupancyLegacy` and `HybridBrickBox` are unchanged and remain selectable;
`HybridExactComplex` still resolves to the explicit legacy fallback.

## What an occupied voxel now returns

In the plane modes, an occupied level-0 voxel holding a usable SIMPLE record
resolves through a bounded ray-plane intersection instead of a voxel-box face:

1. rank of the voxel's bit inside its brick mask → record index
   (`surfaceOffset + rank`, `countOneBits` on the masked header words);
2. octahedral `snorm16x2` normal + signed 16-bit cell-local plane offset
   decode (WGSL `unpack2x16snorm`, exactly `RayHitPacking`'s codecs);
3. accept only if the plane `t` lies inside the cell's `[entry, exit]` ray
   interval (±`PLANE_HIT_INTERVAL_EPSILON`) and the ray is not near-parallel;
4. `HybridPlaneCoverage` additionally projects the hit into the record's
   dominant axis and tests the dilated 4x4 coverage bit;
5. an ACCEPTED hit returns the fitted-plane `t` and the decoded normal,
   flipped toward the ray (the radiance sampler picks the shell by it);
6. a REJECTED plane lets the local DDA continue — the accuracy improvement
   over occupied-box hits (a grazing ray no longer stops at a face the
   surface never crosses);
7. any cell without a usable record — complex fit, pool overflow,
   DynamicBrick, unfitted — keeps the exact legacy occupied-box hit, so
   classification can tighten accuracy but never turn into a miss.

The packed trace return changed for the plane variant only: `zw` carry the
oct-encoded voxel-space hit normal (fitted normals no longer fit the Phase-1
axis convention); the wrapper maps it to world space with the covariant
transform for the diagonal voxel scale (`n_world ∝ n_vox · voxelInv`).

## Record build (GPU)

Three passes ride the FULL occupancy chain only, wedged between the static
and dynamic voxelize stages. An extra `copy` + `hybridBuild` first lands the
STATIC-ONLY level-0 state in the pyramid and brick tail, so everything below
fits and rank-addresses against static masks:

- **allocate** — one thread per macrocell: `atomicAdd` a dense record range of
  `popcount(mask)` records; overflow writes `INVALID` (box fallback) and
  counts the brick in `surfAlloc[1]`.
- **accumulate** — the voxelizer's own (slot, triangle, chunk) work list and
  Akenine-Möller SAT, static slots only. Every conservative triangle/voxel
  overlap adds fixed-point (`SURFACE_FIT_SCALE`) atomics: area-weighted
  normal, cell-local plane offset `d = dot(n̂, centroid − cellOrigin)` and
  `d²` (layer-spread sigma), an overlap count, and conservative 4x4 coverage
  rasterized in ALL THREE dominant-axis projections (edge functions offset by
  the texel Minkowski radius — one geometry pass, no second pass after the
  axis is known). Integer atomics make the result order-independent.
- **finalize** — one thread per pool record: classification
  (`count ≤ 8`, coherence `|Σwn̂|/Σw ≥ 0.9`, `σ_d ≤ 0.1`, plane-through-cell)
  and packing. Complex or empty records stay all-zero → no SIMPLE flag → box
  fallback. Coverage is dilated one texel with nibble-masked shifts (proved
  equal to `dilateCoverageMask` over all 65536 masks).

FAST (dynamic-only) chains never touch the records: static bits cannot have
changed, and the final `hybridBuild` types any brick whose mask gained
non-static bits as `DynamicBrick` (compared against the `staticBits`
snapshot), which the tracer reads as "box semantics here". Records in
static-only bricks stay valid because their header masks equal the static
masks the records were rank-addressed against. The surface offset words are
owned by the allocator; `hybridBuild` no longer writes them in surface mode
(a fast chain re-running it would have erased the allocation).

## Binding budget and memory

The record pool is appended to the existing occupancy `bits` allocation —
**zero new storage bindings** in any trace-side kernel. Runtime-smoked at the
portable `maxStorageBuffersPerShaderStage = 8`: the largest composed profiled
kernel uses exactly 8 bindings in every mode.

Fit scratch (10 atomic i32/record) and the 4-word allocator are build-only
bindings. Pool capacity is `clamp(level0Voxels / 16, 2^14, 2^20)` records
(overridable via `surfaceRecordCapacity`); cost is 16 B/record pool +
40 B/record scratch, reported in `stats.bytes`/`stats.surfaceCapacity`.
Smoke scene: 4792 of 16384 records used, zero overflow.

## Validation (2026-08-04)

CPU (`npm run test:gi-rayhit-phase2`, deterministic, vs exact
double-precision Möller-Trumbore):

```text
flat floor    distance error 2.6e-5 vs 0.750 occupied-box; normals exact
45° ramp      distance error 2.4e-5 vs 1.600; normal error 0.002°
sealed room   0 false negatives / 400 rays (both plane modes)
thin wall     opposing faces in one voxel → complex → box; 0 leaks
coverage      uncovered texel rejects the infinite-plane false hit that
              plane-only mode exhibits; covered hit exact to 1e-3
starved pool  overflow reported, still 0 false negatives
dilation      GPU bitwise == dilateCoverageMask for all 65536 masks
```

GPU smoke (all four modes, `run-gpu-page.mjs` on `gi-gpu-smoke.html`,
storage=8, validation errors=0, limit exits=0, invalid numerics=0):

```text
occupancy-legacy        rays 552k   avgMacro 4.85            (baseline holds)
hybrid-brick-box        rays 696k   avgMacro 5.06  maxBrick 8   (Phase 1 unchanged)
hybrid-plane            planeTests 93k  accepts 42k  rejects 52k  fallbacks 12k
hybrid-plane-coverage   planeTests 127k accepts 56k  rejects 70k  fallbacks 16k
```

`maxBrick` rises 8 → 15 in plane modes — the reject-continue path marching
deeper into bricks, still under the 16 hard bound with zero limit exits.

`npm run test:gi-rayhit`, `test:gi-rayhit-phase3`, `check:types`, `build`
all pass. New counters (`planeTests/planeAccepts/planeRejects/
surfaceFallbacks`) live in the same single debug binding (now 16 words);
`occupancyField.readbackSurfaceAlloc()` reports pool usage/overflow.

## Debug view

The Occupancy debug view marches the ACTIVE query: in plane modes flat
surfaces render flat decoded-normal colour instead of voxel-face
quantization — the required plane-normal visualization, and the fastest
visual check that records are live.

## Known limits (deliberate, Phase-4+ candidates)

- Complex cells use the occupied-box fallback, not exact triangles
  (`HybridExactComplex` is the next phase; corners and thin walls therefore
  keep conservative box behaviour).
- Dynamic geometry keeps box semantics brick-wide (`DynamicBrick`); a proper
  dynamic overlay is Phase 7.
- `materialId` is reserved (0) in records.
- Grid jitter (`__giVoxelJitter`, default off) forces a full chain per
  dispatch and therefore a per-frame surface rebuild — the two remain
  mutually exclusive in practice.
