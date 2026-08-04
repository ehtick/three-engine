# Radiance-cascade ray hit: Phase 0 audit

This records the Phase 0 architecture and instrumentation required by
`radiance_cascades_hybrid_ray_hit_implementation.md`. The hybrid leaf formats
and traversal are intentionally not implemented yet.

## Current query path

1. `GISystem` builds the world volume and the conservative occupancy field.
2. `giField.createSceneTrace()` creates the stable scene-query closure.
3. `createRadianceCascades()` generates one world-space ray per
   probe/direction and calls that closure for the cascade shell interval.
4. `createOccupancySceneTrace()` applies the origin bias, calls the occupancy
   hierarchy, and samples the existing radiance field at the voxel-face hit.
5. `occupancyField.traceOccupancy()` performs a bounded hierarchical DDA over
   five OR-downsampled bit levels. A level-0 bit is the only hit condition.

The smallest hybrid insertion point is `giField.createSceneTrace()`. It keeps
cascade generation, interval semantics, radiance lookup, and downstream merge
logic unchanged. `RayHitMode` now gives this seam stable identifiers. During
Phase 0 every unfinished hybrid mode reports an explicit legacy fallback.

## Coordinates and indexing

- Cascade origins, directions, interval limits, and returned hit distances are
  world-space. Ray `t` is always measured in world units.
- Occupancy traversal uses level-0 voxel coordinates
  `q(t) = (worldOrigin - gridOrigin) * voxelInv + t * (worldDir * voxelInv)`.
  This changes the grid coordinate system without changing world-space `t`.
- Occupancy origin is the fitted volume's `bounds.min`. Negative world
  coordinates are valid because flooring occurs after subtracting that origin.
- A level `L` voxel spans `2^L` level-0 cells. The five levels are stored in a
  single contiguous `u32` storage buffer.
- Bits are packed along X. The CPU and shader-compatible address is
  `levelOffset + (z * resY + y) * wordsPerRow + (x >> 5)` with bit `x & 31`.
- Source triangles are stored in mesh-local space and transformed by the
  placement's column-major local-to-world matrix during conservative
  voxelization. The CPU validator uses the same serialized geometry and matrix
  convention.
- A cascade ray payload stores RGB interval radiance plus probe-relative hit
  distance in W. A negative distance is a miss.

## Existing buffers and portable binding budget

The occupancy hierarchy is one read-only packed buffer for all levels. Atomic
voxelization scratch, static snapshots, triangle data, and work-item data are
used by build kernels, not all by the cascade trace. Phase-0 counters add one
optional 32-byte atomic buffer containing eight `u32` fields:

`rays, hits, misses, macroSteps, maxMacroSteps, stepLimitExits,
invalidNumerics, legacyFallbacks`.

Profiling is off by default, so the shipping graph and cost are unchanged.
When enabled, the fully composed graph is runtime-tested with a device created
at WebGPU's portable `maxStorageBuffersPerShaderStage = 8`. The engine no
longer requests a limit of 16 and no longer disables occupancy below 10.

## Debug and validation interfaces

- Set the component's `rayHitProfiling` property (or set
  `globalThis.__giRayHitProfiling = true` before the GI build).
- Read counters with `await giSystem.readRayHitStats()`. Readback is explicit;
  it never stalls the normal frame path.
- `RayHitValidator.js` supplies deterministic double-precision,
  double-sided Moller-Trumbore intersection, occupancy-build geometry
  expansion, nearest-hit tracing, and candidate-vs-exact error metrics.
- Run the CPU checks with `npm run test:gi-rayhit`.
- Run the required portable pipeline smoke with Vite plus
  `node scripts/run-gpu-page.mjs http://127.0.0.1:<port>/scripts/gi-gpu-smoke.html 70000`.

## Profiling status

The engine's existing timestamp system reports aggregate render and compute GPU
time; it does not currently isolate each GI dispatch. The Phase-0 traversal
counters report work and limit failures but are not timers. The portable smoke
on the development adapter (2026-08-04, deterministic low scene) created the
device at limit 8 and composed the largest observed feedback kernel at exactly
8 storage buffers. One settled sample recorded 688,000 transport rays, 4.83
average hierarchy steps/ray, 39 maximum steps, zero step-limit exits, and zero
invalid numeric results. The engine timestamp readout was 0.17 ms for the whole
frame on this tiny 320x240 smoke scene; it includes render and all compute and
must not be presented as a ray-hit-only duration. A GI-pass-only duration is
not available yet.

## Phase 1 boundary

Phase 1 may add macrocell/brick data only after its proposed packing is counted
on the fully composed TSL graph. New per-cascade buffers are not acceptable:
three independent cascade records can turn three logical buffers into nine
bindings. Prefer one packed hierarchy buffer or sampled textures, and keep the
legacy query available at the `createSceneTrace()` seam.
