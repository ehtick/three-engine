# Radiance-cascade ray hit: Phase 1

Phase 1 implements `HybridBrickBox` behind the existing runtime ray-hit mode
while preserving `OccupancyLegacy`. It intentionally does not add planes,
coverage masks, complex triangles, skip-distance metadata, cone LOD, or a
dynamic overlay.

## Runtime path

`giField.createSceneTrace()` remains the single query seam. Selecting
`hybrid-brick-box` swaps only the scene-hit closure; cascade shell intervals,
world-space ray `t`, radiance sampling, and downstream merging are unchanged.
Unimplemented later modes still fall back explicitly to legacy.

The hybrid traversal uses the existing occupancy pyramid levels 4 and 3 for
conservative empty-space broad phase. Level 2 is exactly one `4 x 4 x 4`
group of level-0 voxels and selects a Phase-1 macrocell/brick. A bounded local
DDA then visits the brick mask front to back and returns the first occupied
voxel box, matching legacy leaf semantics.

## Packed layout and binding budget

The Phase-1 tail is appended to the existing occupancy pyramid buffer. No new
transport storage binding is introduced.

```text
existing occupancy pyramid
macrocell records: macroCount * 2 u32
  [brickIndex, metadata]
brick headers: macroCount * 4 u32
  [occupancyLow, occupancyHigh, 0xffffffff, 0xffffffff]
```

Empty macrocells use `brickIndex = 0xffffffff`. Brick indices are dense and
deterministic; no allocator or atomic append is required. The last two brick
words reserve the future surface and complex offsets without allocating any
surface records. Local voxel indexing is shared by CPU and GPU:

```text
index = x + y * 4 + z * 16
```

At the smoke scene's `48 x 32 x 48` level-0 resolution, the Phase-1 tail is
`12 x 8 x 12 * 24 = 27,648` bytes. In general it costs 24 bytes per macrocell,
or 0.375 bytes per represented level-0 voxel before edge padding.

The fully composed profiled feedback kernel was runtime-smoked at WebGPU's
portable `maxStorageBuffersPerShaderStage = 8` and used exactly 8 bindings.

## Bounds, counters, and debug view

- Macro traversal is hard-bounded at 128 iterations.
- Local brick traversal is hard-bounded at 16 iterations per visited brick.
- Invalid brick references are checked before the clamped storage read.
- The one atomic debug allocation now contains 12 `u32` counters, including
  total/maximum brick steps and separate macro/brick limit exits.
- The existing Occupancy debug view automatically uses the active query. In
  hybrid mode it displays alternating macrocell tint, local brick coordinates,
  and a red traversal-step heat overlay.

## Validation

The deterministic CPU suite validates packing at partial edge bricks, exact
64-bit reconstruction, metadata, active/fallback modes, legacy occupied-box
hit parity, axis-parallel rays, rays starting occupied, negative world-space
triangle placement, and bounded counters.

Validation completed on 2026-08-04:

```text
npm run test:gi-rayhit  PASS
npm run check:types     PASS
npm run build           PASS
hybrid WebGPU smoke     PASS, storage=8, validation errors=0
```

Hybrid smoke sample with the hybrid debug view visible: 648,000 rays, average
macro steps 5.00, average brick steps 0.10, maximum macro/brick steps 41/8,
zero limit exits, and zero invalid numeric results. The reported 0.90 ms is
aggregate frame GPU time for the tiny
smoke scene, not an isolated GI traversal duration.
