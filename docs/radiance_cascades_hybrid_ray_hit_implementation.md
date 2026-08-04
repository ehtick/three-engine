# Hybrid Ray-Hit System for WebGPU Radiance Cascades

## Purpose

Implement a reliable, high-performance ray–scene hit system for a WebGPU radiance-cascades global-illumination pipeline.

The system must replace inaccurate pure occupancy hits without returning to:

- a dense global SDF,
- full-resolution voxel traversal,
- or a full-scene software TLAS/BLAS traversal for every GI ray.

The target design is a hybrid hierarchy:

1. Coarse clipmapped occupancy for broad-phase traversal.
2. Hierarchical DDA and conservative distance skips for empty-space traversal.
3. Compact `4 × 4 × 4` occupancy masks inside active bricks.
4. Quantized local surface planes or surfels for accurate first-hit reconstruction.
5. Small triangle lists or micro-BVHs only for geometrically complex cells.
6. Ray-cone-driven level-of-detail selection for diffuse GI.
7. Direction-grouped compute dispatches to preserve coherence.

The existing occupancy implementation must remain available as a fallback until the new system passes validation.

---

# Instructions for the AI Coding Agent

## Primary directive

Implement this system incrementally and conservatively.

Do not replace the current ray-hit path in one large change. Add the new implementation behind feature flags, preserve the existing path, and validate each stage before proceeding.

The implementation order in this document is mandatory unless the current engine architecture makes a step impossible. In that case, explain the conflict in code comments and choose the smallest compatible adaptation.

## Non-negotiable rules

1. Inspect the existing renderer, scene representation, radiance-cascade passes, GPU resource manager, and shader conventions before editing code.
2. Reuse existing abstractions where practical.
3. Do not rewrite unrelated rendering systems.
4. Do not change radiance-cascade sampling semantics until the new ray-hit path is working.
5. Keep the old occupancy traversal accessible through a runtime feature flag.
6. Add GPU debug views and CPU validation tools before optimizing aggressively.
7. Prefer deterministic, debuggable algorithms over clever but fragile shortcuts.
8. Do not introduce unbounded loops in WGSL.
9. Every traversal loop must have a hard iteration limit.
10. Every GPU buffer layout must have matching TypeScript and WGSL definitions.
11. All structures must obey WebGPU alignment requirements.
12. Avoid shader recursion.
13. Avoid per-ray dynamic allocation.
14. Avoid pointer-like linked structures with random memory access.
15. Avoid a scene-wide software BVH in the first implementation.
16. Static and dynamic geometry must be handled separately.
17. Build and shader compilation must succeed after every implementation phase.
18. Add profiling counters before declaring a phase complete.

---

# Expected Engine Context

Assume the engine has:

- Three.js or a Three.js-compatible scene graph.
- WebGPU compute support.
- WGSL shaders.
- A radiance-cascade GI implementation.
- An existing occupancy representation.
- Existing geometry buffers or access to indexed triangle meshes.
- Some form of world-space cascade clipmap or volume.

Adapt names and modules to the engine's conventions.

Do not assume hardware ray tracing is available.

---

# High-Level Architecture

```text
Radiance Cascade Ray
        |
        v
Clipmap Level Selection
        |
        v
Coarse Macrocell Traversal
  - hierarchical DDA
  - conservative empty-space skip
        |
        v
Active Brick Lookup
        |
        v
4x4x4 Occupancy Mask
        |
        +--------------------------+
        |                          |
        v                          v
Simple Surface Cell          Complex Surface Cell
Quantized Plane/Surfel       Triangle List or Micro-BVH
        |                          |
        +-------------+------------+
                      |
                      v
              Accurate First Hit
                      |
                      v
         Distance + Normal + Material
```

---

# Representation Overview

## 1. Clipmap hierarchy

Use multiple world-space clipmap levels centered around the active GI region or camera.

Recommended initial configuration:

```text
3 to 5 clipmap levels
2× spatial scale per level
fixed number of macrocells per level
power-of-two dimensions where possible
```

Each level contains coarse macrocells.

Each macrocell is one of:

```text
EMPTY
UNIFORM_OCCUPIED
BRICK
DYNAMIC_BRICK
```

The macrocell structure must be compact and GPU-friendly.

Suggested logical representation:

```wgsl
struct MacroCell {
    brickIndex: u32,
    metadata: u32,
};
```

Suggested metadata packing:

```text
bits  0..5   conservative skip distance
bits  6..7   cell type
bits  8..15  occupancy summary or coverage
bits 16..23  version or update generation
bits 24..31  flags
```

Exact packing may change, but document all fields in one shared source of truth.

## 2. Brick layout

Use `4 × 4 × 4` subvoxels in the first implementation.

That gives 64 occupancy bits.

Represent the mask as two `u32` values:

```wgsl
struct BrickHeader {
    occupancyLow: u32,
    occupancyHigh: u32,
    surfaceOffset: u32,
    complexOffset: u32,
};
```

Interpretation:

```text
occupancyLow  = voxels 0..31
occupancyHigh = voxels 32..63
```

A brick must also contain metadata describing which occupied cells are simple or complex.

Possible layouts:

```wgsl
struct BrickExtra {
    complexMaskLow: u32,
    complexMaskHigh: u32,
    materialOffset: u32,
    flags: u32,
};
```

Do not store a full surface record for empty voxels.

Compact active surface records into a separate linear buffer.

## 3. Simple surface representation

A simple surface cell contains a local planar approximation.

Store:

- quantized normal,
- quantized plane offset,
- coverage information,
- material identifier,
- optional thickness or confidence.

Suggested logical structure:

```wgsl
struct SurfaceRecord {
    packedNormal: u32,
    packedPlaneCoverage: u32,
    materialId: u32,
    flags: u32,
};
```

Initial packing recommendation:

```text
packedNormal
    octahedral normal encoding
    2 × 16-bit signed or normalized components

packedPlaneCoverage
    16-bit plane offset in cell-local coordinates
    8-bit coverage
    8-bit confidence or flags
```

The plane is defined as:

```text
dot(n, p) = d
```

Store `d` relative to the subvoxel's local coordinate frame.

Never store large world-space plane offsets when a cell-local representation can be used.

## 4. Complex geometry fallback

Cells that cannot be represented reliably by one plane must use exact geometry.

Use one of the following:

### Initial implementation

A short contiguous triangle list.

Recommended threshold:

```text
1 to 16 triangles per complex cell
```

### Later optimization

A tiny stackless wide BVH local to a brick.

Do not implement the micro-BVH before the short triangle-list path is correct and profiled.

Suggested complex record:

```wgsl
struct ComplexCellRecord {
    triangleOffset: u32,
    triangleCount: u32,
    flags: u32,
    reserved: u32,
};
```

Store triangles in brick-local coordinates where practical.

Quantize positions only after the unquantized implementation passes accuracy tests.

---

# Build Pipeline

## Static geometry

Static geometry should be voxelized and classified when:

- the scene loads,
- a static mesh is added,
- a static mesh transform changes,
- or the relevant clipmap region is rebuilt.

Do not rebuild all static bricks every frame.

## Dynamic geometry

Dynamic geometry should use a separate overlay.

Initial supported dynamic categories:

- moving rigid meshes,
- animated transforms,
- optionally skinned meshes later.

Do not merge dynamic data destructively into the static brick map.

Recommended lookup order:

```text
1. Test dynamic overlay for the current macrocell.
2. Test static brick data.
3. Select the nearest valid hit.
```

Alternatively, maintain combined macrocell metadata but separate leaf data.

Choose the implementation that best matches the engine's update model.

## Conservative voxelization

Voxelization must be conservative.

A triangle intersecting any part of a subvoxel must mark that subvoxel occupied.

Do not rely only on sampling the triangle center or voxel center.

Recommended broad workflow:

1. Transform triangle into brick-local space.
2. Compute triangle AABB.
3. Enumerate overlapped subvoxels.
4. Use triangle-box overlap or conservative rasterization logic.
5. Mark occupancy.
6. Accumulate geometry for surface fitting.

A false-positive occupied voxel is acceptable.

A false-negative occupied voxel is not acceptable because it causes light leaking.

---

# Surface Classification

For every occupied subvoxel, classify its local geometry.

## Simple-plane criteria

A cell may use one plane when all conditions pass:

1. The number of contributing triangles is below a safe threshold.
2. Triangle normals are sufficiently coherent.
3. The fitted plane residual is below an error threshold.
4. The geometry does not form multiple disconnected layers inside the cell.
5. The cell is not marked thin, double-sided, alpha-tested, or transparent.
6. The surface does not require more than one dominant orientation.
7. The fitted plane intersects the cell volume.
8. Plane coverage exceeds a minimum threshold.

Suggested initial thresholds:

```text
normal coherence:
    dot(n_i, fittedNormal) >= 0.9

maximum plane residual:
    <= 0.1 × subvoxel size

simple-cell triangle count:
    <= 8

minimum coverage:
    tune experimentally, begin near 25%
```

Keep thresholds configurable.

## Complex-cell triggers

Mark a cell complex when:

- it contains multiple surface layers,
- normals disagree strongly,
- it contains thin geometry,
- it contains intersecting triangles,
- the plane residual is too high,
- it contains too many triangles,
- it contains curved geometry that fails validation,
- it contains alpha-tested or partially transparent material,
- or classification confidence is low.

When uncertain, classify as complex.

Correctness is more important than minimizing the complex-cell count in the first implementation.

---

# Plane Fitting

Use a stable local-space plane fit.

Possible first implementation:

1. Accumulate triangle-area-weighted normals.
2. Normalize the accumulated normal.
3. Compute the area-weighted centroid.
4. Set plane offset from the centroid.
5. Measure maximum and RMS point-to-plane residual.

For better quality later, use PCA on contributing positions.

Do not add PCA until the simpler method is implemented and measured.

Pseudo-code:

```ts
function fitCellPlane(samples: SurfaceSample[]): PlaneFit {
    let weightedNormal = vec3(0);
    let weightedCentroid = vec3(0);
    let totalWeight = 0;

    for (const sample of samples) {
        const weight = Math.max(sample.area, EPSILON);
        weightedNormal += sample.normal * weight;
        weightedCentroid += sample.position * weight;
        totalWeight += weight;
    }

    const normal = normalize(weightedNormal);
    const centroid = weightedCentroid / totalWeight;
    const offset = dot(normal, centroid);

    let maxResidual = 0;
    let sumSquaredResidual = 0;

    for (const sample of samples) {
        const residual = abs(dot(normal, sample.position) - offset);
        maxResidual = max(maxResidual, residual);
        sumSquaredResidual += residual * residual;
    }

    return {
        normal,
        offset,
        maxResidual,
        rmsResidual: sqrt(sumSquaredResidual / samples.length),
    };
}
```

Use cell-local positions to improve numerical stability.

---

# Coverage Representation

A plane alone is insufficient because it behaves like an infinite surface.

The hit must be clipped to local coverage.

Initial implementation options, in preferred order:

## Option A: coarse 2D coverage mask

Project the surface into its dominant axis plane and store a small mask.

Example:

```text
4 × 4 coverage mask = 16 bits
```

The dominant projection axis is selected from the largest absolute normal component.

At runtime:

1. Intersect the ray with the plane.
2. Convert the hit point to cell-local coordinates.
3. Project to the dominant 2D plane.
4. Sample the 4 × 4 coverage mask.
5. Accept only covered texels.

This is recommended for the first accurate implementation.

## Option B: scalar coverage only

Store one coverage byte and probabilistically or conservatively accept hits.

This is easier but less accurate.

Use only as an intermediate milestone.

## Option C: two-plane representation

For cells with two dominant surfaces, store two plane records.

Do not implement this before the one-plane-plus-complex-fallback path is stable.

---

# Traversal

## Mandatory traversal stages

Every GI ray must follow these stages:

1. Determine valid ray interval for the current radiance-cascade shell.
2. Select a starting clipmap level from the ray footprint.
3. Traverse coarse macrocells.
4. Skip empty space using hierarchical DDA and optional conservative distance.
5. On a brick hit, derive candidate occupied subvoxels.
6. Test candidate cells in front-to-back order.
7. Use plane or surfel intersection for simple cells.
8. Use exact triangle intersection for complex cells.
9. Return the nearest valid hit.
10. Fall back to the previous occupancy result only when debugging mode requests it.

## Hard limits

All loops need compile-time or uniform-configured limits.

Example:

```wgsl
const MAX_MACRO_STEPS: u32 = 128u;
const MAX_BRICK_STEPS: u32 = 16u;
const MAX_COMPLEX_TRIANGLES: u32 = 16u;
```

Expose counters when limits are reached.

A limit hit must not silently return an arbitrary valid hit.

Return a debug status code or set a counter.

---

# Hierarchical DDA

Implement ordinary DDA first.

Then extend it to hierarchical traversal.

The first version should prioritize correctness over minimal instruction count.

Required DDA data:

```wgsl
struct DDAState {
    cell: vec3<i32>,
    step: vec3<i32>,
    tMax: vec3<f32>,
    tDelta: vec3<f32>,
};
```

At every macrocell:

1. Check bounds.
2. Read macrocell metadata.
3. If empty, advance.
4. If a conservative skip value is present, advance safely by multiple cells.
5. If brick-backed, enter brick traversal.
6. Exit when current `t` exceeds ray maximum.

Avoid recomputing reciprocals inside the loop.

Precompute safe inverse ray direction:

```wgsl
fn safeInverse(v: vec3<f32>) -> vec3<f32> {
    let eps = vec3<f32>(1e-8);
    return 1.0 / select(v, sign(v) * eps, abs(v) < eps);
}
```

Verify WGSL `select` argument order against current shader conventions.

---

# Conservative Empty-Space Distance

Distance metadata is not a surface SDF.

It is only a lower bound on the number of definitely empty neighboring cells.

Use integer distances such as:

- Manhattan distance,
- Chebyshev distance,
- or a conservative chamfer approximation.

Store 4 or 6 bits initially.

The skip must never cross a potentially occupied cell.

When in doubt, skip fewer cells.

Pseudo-logic:

```wgsl
if cellType == CELL_EMPTY {
    let skipCells = max(1u, metadataSkipDistance);
    advanceDDAConservatively(skipCells);
}
```

Do not use world-space sphere tracing against these values.

---

# Brick Candidate Traversal

For a `4 × 4 × 4` brick, begin with a small local DDA.

This is simpler and safer than attempting an advanced analytical ray mask immediately.

Initial algorithm:

1. Intersect ray with brick bounds.
2. Start a local DDA at brick entry.
3. Traverse at most 4 cells per axis crossing.
4. Check the corresponding occupancy bit.
5. Test occupied candidates.
6. Stop on the first confirmed hit.
7. Continue after rejected plane hits.

Maximum local voxel visits are bounded and small.

After correctness is established, optionally replace or supplement local DDA with a precomputed conservative ray mask.

Occupancy bit helpers:

```wgsl
fn isOccupied(low: u32, high: u32, index: u32) -> bool {
    if index < 32u {
        return ((low >> index) & 1u) != 0u;
    }
    return ((high >> (index - 32u)) & 1u) != 0u;
}
```

Choose a single voxel indexing convention and document it.

Recommended:

```text
index = x + y * 4 + z * 16
```

Use the same ordering in CPU build code, debug tools, and WGSL.

---

# Simple Surface Intersection

For each candidate simple cell:

1. Decode normal.
2. Decode local plane offset.
3. Compute ray-plane intersection.
4. Reject near-parallel rays.
5. Ensure `t` lies inside the current cell interval.
6. Compute cell-local hit position.
7. Confirm the point lies inside the subvoxel with a small tolerance.
8. Evaluate coverage mask.
9. If accepted, return hit.

Formula:

```text
t = (d - dot(n, rayOrigin)) / dot(n, rayDirection)
```

Use local coordinates.

Suggested WGSL structure:

```wgsl
fn intersectSurfaceCell(
    rayOriginLocal: vec3<f32>,
    rayDirection: vec3<f32>,
    cellMin: vec3<f32>,
    cellMax: vec3<f32>,
    tCellMin: f32,
    tCellMax: f32,
    surface: SurfaceRecord
) -> SurfaceHit {
    // Decode.
    // Plane intersection.
    // Cell bounds validation.
    // Coverage validation.
    // Return hit status, distance, normal, material.
}
```

Do not accept hits behind the current DDA segment.

Use a small configurable geometric epsilon.

---

# Complex Cell Triangle Intersection

Implement Möller–Trumbore or the engine's existing robust ray-triangle test.

Requirements:

- front-to-back nearest-hit tracking,
- optional double-sided handling,
- no early exit unless the nearest possible remaining triangle cannot beat the current hit,
- bounded triangle count,
- material and normal output,
- triangle data contiguous in memory.

Use brick-local triangle coordinates if possible.

Suggested WGSL:

```wgsl
fn intersectTriangle(
    origin: vec3<f32>,
    direction: vec3<f32>,
    a: vec3<f32>,
    b: vec3<f32>,
    c: vec3<f32>,
    doubleSided: bool
) -> TriangleHit
```

Do not normalize the ray direction repeatedly.

Add a separate path for alpha-tested geometry later.

Treat alpha-tested geometry as opaque in the first milestone unless the engine already has a robust GPU material-opacity lookup.

Document that limitation.

---

# Ray Cones and LOD

Diffuse GI rays have a finite footprint.

Track a ray-cone radius:

```text
radius(t) = baseRadius + t × tan(coneHalfAngle)
```

Choose clipmap level based on the footprint.

Initial level estimate:

```text
desiredCellSize ≈ 2 × radius(t)
level = clamp(floor(log2(desiredCellSize / baseCellSize)), minLevel, maxLevel)
```

To avoid excessive level switching:

- choose the level at ray-segment start, or
- allow only monotonic transitions toward coarser levels.

Do not switch repeatedly between fine and coarse levels.

For glossy or metallic rays:

- use a smaller cone,
- prefer finer levels,
- and require exact complex-cell refinement more often.

For diffuse radiance-cascade visibility:

- permit coarser levels at long distances,
- but preserve conservative occlusion.

---

# Radiance-Cascade Integration

Do not change cascade topology while integrating the new traversal.

The ray-hit function should expose a stable interface:

```wgsl
struct SceneHit {
    hit: u32,
    t: f32,
    normal: vec3<f32>,
    materialId: u32,
    transmittance: f32,
    debugCode: u32,
};
```

Suggested function:

```wgsl
fn traceSceneHybrid(
    origin: vec3<f32>,
    direction: vec3<f32>,
    tMin: f32,
    tMax: f32,
    coneHalfAngle: f32,
    flags: u32
) -> SceneHit
```

Keep the old path:

```wgsl
fn traceSceneOccupancy(...)
```

Runtime selection:

```wgsl
if settings.rayHitMode == RAY_HIT_MODE_HYBRID {
    hit = traceSceneHybrid(...);
} else {
    hit = traceSceneOccupancy(...);
}
```

Do not duplicate radiance accumulation code.

Only swap the hit-query implementation.

---

# Direction-Grouped Dispatch

Radiance-cascade rays are coherent.

Group work by:

```text
cascade index
direction index
neighboring probe block
```

Prefer:

```text
one workgroup processes neighboring probes for one or a small set of directions
```

Avoid:

```text
one workgroup processes all directions of one probe
```

when that causes highly divergent traversal.

Initial optimization:

1. Keep the current dispatch layout.
2. Add counters for divergence proxies:
   - average macro steps,
   - maximum macro steps,
   - active lanes,
   - complex-cell rate.
3. Only then reorganize dispatch dimensions.

Do not combine dispatch reorganization with the first traversal implementation.

---

# GPU Buffers

Create separate storage buffers for:

```text
macrocell metadata
brick headers
brick extra metadata
surface records
coverage masks
complex-cell records
triangle positions
triangle material indices
debug counters
```

Combine buffers only after profiling proves that fewer bindings or better locality outweighs complexity.

Recommended access properties:

```text
Macrocell data:
    frequent random reads
    compact

Brick headers:
    moderately random reads
    compact

Surface records:
    sparse reads
    contiguous per brick

Triangles:
    rare reads
    contiguous per complex cell
```

Use read-only storage buffers for traversal.

Use a staging/update system for changed bricks.

---

# CPU/GPU Synchronization Strategy

Use double buffering for rebuilt scene data when necessary.

Recommended process:

1. Build or update data in CPU-side arrays.
2. Upload changed ranges.
3. Swap active buffer generation at frame boundary.
4. Keep prior generation alive until no command buffer references it.

Avoid resizing GPU buffers every frame.

Use capacity growth:

```text
newCapacity = max(required, oldCapacity × 1.5)
```

or the engine's existing policy.

Track brick generations to reject stale references.

---

# Static and Dynamic Updates

## Static

Static clipmap bricks may be cached.

Use dirty regions.

When a static object changes:

1. Compute previous and new world AABBs.
2. Mark overlapping macrocells dirty.
3. Rebuild only affected bricks.
4. Update skip-distance metadata around affected regions.
5. Upload changed ranges.

## Dynamic

For the first implementation, use one of:

### Preferred

A small dynamic brick overlay rebuilt every frame for moving objects.

### Alternative

A coarse per-object dynamic AABB list tested before static traversal.

The overlay is more scalable.

The object-list approach is easier and may be acceptable as a temporary milestone.

Do not rebuild the full static hierarchy for moving objects.

---

# Debugging Requirements

Implement these debug modes before tuning thresholds.

## Required visualizations

1. Clipmap level visualization.
2. Macrocell type visualization.
3. Occupied-brick visualization.
4. Simple versus complex cell visualization.
5. Plane-normal visualization.
6. Coverage-mask visualization.
7. Traversal step heatmap.
8. Complex triangle-test heatmap.
9. Hybrid versus occupancy disagreement visualization.
10. Ground-truth versus hybrid disagreement visualization.
11. Reached-step-limit visualization.
12. Light-leak visualization if the engine has a suitable test scene.

## Required debug counters

Use GPU atomics or per-workgroup reduction.

Track:

```text
rays traced
rays hit
rays missed
macrocell steps
brick-cell steps
simple-cell tests
simple-cell accepted hits
simple-cell rejected hits
complex-cell tests
triangle tests
step-limit exits
invalid brick references
stale generation references
NaN or infinity detections
fallback-path uses
```

Read back counters only periodically.

Do not stall the GPU every frame.

---

# CPU Ground-Truth Validator

Create a CPU reference path for small test scenes.

It should perform exact ray-triangle intersection against scene geometry.

Use it offline or in a developer-only validation mode.

For a sampled set of rays, compare:

```text
hit/miss agreement
distance error
normal error
material agreement
false-positive rate
false-negative rate
```

Most important metric:

```text
false-negative occlusion rate
```

False negatives cause GI leaks.

Recommended acceptance targets for static opaque test scenes:

```text
false-negative rate:
    < 0.1% initially
    lower for production

distance error:
    median < 0.25 subvoxel
    95th percentile < 1 subvoxel

normal error:
    median < 10 degrees for simple cells

step-limit exits:
    0 in standard scenes
```

Set final thresholds based on engine scale and content.

---

# Test Scenes

Create deterministic scenes.

## Scene A: Single plane

Purpose:

- plane fitting,
- normal decoding,
- ray-plane intersection,
- coverage clipping.

## Scene B: Axis-aligned room

Purpose:

- GI leak detection,
- wall thickness,
- corners,
- large planar cells.

## Scene C: Thin wall

Purpose:

- conservative voxelization,
- false-negative detection,
- two-sided handling.

## Scene D: Two close parallel walls

Purpose:

- multiple surface layers,
- complex-cell classification.

## Scene E: Curved mesh

Purpose:

- plane approximation residuals,
- complex fallback frequency.

## Scene F: Dense triangle prop

Purpose:

- triangle-list performance,
- complex-cell memory cost.

## Scene G: Large empty environment

Purpose:

- HDDA and skip-distance effectiveness.

## Scene H: Moving rigid object

Purpose:

- dynamic overlay correctness.

## Scene I: Nested geometry

Purpose:

- overlapping meshes,
- nearest-hit selection.

## Scene J: Radiance-cascade production scene

Purpose:

- image quality,
- temporal stability,
- real performance.

All tests must use fixed camera, scene scale, and random seeds.

---

# Implementation Phases

## Phase 0: Audit and instrumentation

### Tasks

- Locate existing occupancy build code.
- Locate existing ray traversal WGSL.
- Locate radiance-cascade ray generation.
- Document coordinate spaces.
- Document voxel indexing.
- Add existing-path profiling counters.
- Add a runtime ray-hit mode enum.
- Add debug buffer infrastructure.
- Add a small CPU exact ray validator.

### Completion criteria

- Existing rendering is unchanged.
- Occupancy path still works.
- Counters are visible.
- Exact CPU validation can be run on a small scene.

Do not proceed without these.

---

## Phase 1: Brick hierarchy using existing occupancy semantics

### Goal

Replace flat occupancy traversal with macrocell-plus-brick traversal while preserving the same effective geometry approximation.

### Tasks

- Add clipmap macrocell buffers.
- Add `4 × 4 × 4` brick masks.
- Build masks from current occupancy data.
- Implement coarse DDA.
- Implement local brick DDA.
- Return occupied-cell-box hits as before.
- Add debug visualizations.

### Completion criteria

- Hybrid hierarchy matches previous occupancy output within expected indexing differences.
- No new false negatives.
- Traversal is stable.
- No out-of-bounds GPU accesses.
- Step counters are bounded.

Do not add plane surfaces yet.

---

## Phase 2: Simple-plane surface records

### Goal

Replace occupied-box hits with local plane hits for simple cells.

### Tasks

- Gather contributing triangles per occupied cell.
- Fit local planes.
- Classify simple versus complex.
- Add normal and plane packing.
- Add GPU decode.
- Add ray-plane intersection.
- Keep complex cells using old occupied-box fallback temporarily.
- Add visualizations for fitted planes and residuals.

### Completion criteria

- Flat-wall distance error is substantially reduced.
- Plane normals are stable.
- No NaNs.
- Simple-cell acceptance and rejection counters are sensible.
- False-negative rate does not increase.

---

## Phase 3: Coverage masks

### Goal

Prevent infinite-plane false hits.

### Tasks

- Add dominant-axis projection.
- Build `4 × 4` coverage masks.
- Pack masks into surface records or a separate buffer.
- Validate hit points against coverage.
- Tune conservative dilation.

### Conservative dilation

Dilate coverage by one mask texel initially.

This reduces false negatives.

Later, reduce dilation if false positives are excessive.

### Completion criteria

- Openings and corners are represented more accurately.
- False plane hits fall substantially.
- Thin-wall leakage remains controlled.

---

## Phase 4: Exact complex-cell triangle fallback

### Goal

Handle multi-layer and irregular geometry accurately.

### Tasks

- Create compact complex-cell records.
- Create contiguous local triangle storage.
- Add bounded triangle-loop WGSL.
- Select nearest hit.
- Output exact triangle normal and material.
- Replace occupied-box fallback for complex cells.

### Completion criteria

- Close parallel walls and curved meshes pass validation.
- Triangle test count remains localized.
- No unbounded complex cells.
- Cells over the triangle limit are subdivided, simplified conservatively, or explicitly reported.

---

## Phase 5: Conservative skip distance

### Goal

Accelerate traversal through empty regions.

### Tasks

- Compute low-bit empty-space distances per macrocell.
- Upload metadata.
- Add conservative multi-cell advancement.
- Compare hit results before and after skips.
- Add skip-length histogram.

### Completion criteria

- Results are bitwise or nearly identical to no-skip traversal.
- False-negative rate does not increase.
- Macrocell steps decrease in sparse scenes.

---

## Phase 6: Ray-cone LOD

### Goal

Use coarser hierarchy levels when the ray footprint grows.

### Tasks

- Add cone parameters to ray requests.
- Add clipmap-level selection.
- Ensure monotonic coarsening.
- Add level-selection debug view.
- Compare diffuse GI stability.
- Keep glossy rays finer.

### Completion criteria

- Diffuse GI performance improves.
- Long-distance temporal noise or aliasing does not worsen.
- No obvious new light leaks.
- Level transitions are visually stable.

---

## Phase 7: Dynamic overlay

### Goal

Support moving scene geometry.

### Tasks

- Add dynamic dirty-region tracking.
- Add dynamic brick buffers or object-list fallback.
- Merge static and dynamic hit results.
- Add generation/version validation.
- Test moving objects crossing clipmap boundaries.

### Completion criteria

- Dynamic geometry occludes GI correctly.
- No stale geometry remains after movement.
- Update cost is proportional to changed regions.

---

## Phase 8: Dispatch coherence optimization

### Goal

Improve SIMD utilization.

### Tasks

- Profile current dispatch.
- Group by cascade and direction.
- Compare neighboring-probe grouping.
- Measure average and maximum traversal steps.
- Measure frame time and occupancy.

### Completion criteria

- Measurable improvement on target GPUs.
- No quality change.
- No major regression on integrated GPUs.

---

## Phase 9: Optional micro-BVH

Implement only if triangle-list profiling shows a real bottleneck.

### Requirements

- Local to one brick.
- Contiguous nodes.
- Stackless traversal.
- Quantized bounds only after validation.
- 4-wide or 8-wide nodes preferred.
- Must outperform triangle lists on real production content.

Do not add this phase by default.

---

# Feature Flags

Add runtime flags:

```ts
enum RayHitMode {
    OccupancyLegacy = 0,
    HybridBrickBox = 1,
    HybridPlane = 2,
    HybridPlaneCoverage = 3,
    HybridExactComplex = 4,
}
```

Additional flags:

```text
enableSkipDistance
enableRayConeLOD
enableDynamicOverlay
enableComplexTriangles
visualizeTraversal
validateAgainstLegacy
validateAgainstCPU
```

Keep defaults conservative until production validation passes.

---

# Shared Layout Definitions

Avoid manually duplicating packing constants in multiple files.

Create a shared TypeScript definition module containing:

```ts
export const BRICK_RESOLUTION = 4;
export const BRICK_VOXEL_COUNT = 64;
export const MAX_MACRO_STEPS = 128;
export const MAX_BRICK_STEPS = 16;
export const MAX_COMPLEX_TRIANGLES = 16;

export const MACRO_CELL_TYPE_SHIFT = 6;
export const MACRO_CELL_TYPE_MASK = 0b11;
```

Generate or mirror WGSL constants from one clearly documented source.

At minimum, add unit tests that confirm CPU and WGSL-compatible packing.

---

# Numerical Robustness

## Coordinate spaces

Use:

```text
world space
    for clipmap selection and initial ray setup

clipmap-local space
    for macrocell traversal

brick-local space
    for subvoxel traversal

cell-local space
    for plane fitting and intersection
```

Transform once per hierarchy transition.

Avoid repeatedly converting between world and local coordinates inside inner loops.

## Epsilon policy

Define named epsilon values:

```wgsl
const RAY_EPSILON: f32 = ...;
const PLANE_PARALLEL_EPSILON: f32 = ...;
const CELL_BOUNDS_EPSILON: f32 = ...;
```

Scale epsilon relative to voxel size where appropriate.

Do not scatter hardcoded `0.0001` values throughout shaders.

## NaN handling

In debug builds:

- check decoded normals,
- check inverse directions,
- check plane intersection denominator,
- check hit distance,
- increment an error counter on invalid values.

A NaN must never be allowed to become the nearest hit silently.

---

# Memory Budgeting

Before finalizing formats, report estimated memory for a representative scene.

Track:

```text
macrocell bytes
brick header bytes
surface-record bytes
coverage-mask bytes
complex-record bytes
triangle bytes
dynamic overlay bytes
total bytes
bytes per occupied cell
bytes per visible cubic meter
```

Recommended optimization order:

1. Remove redundant records.
2. Compact empty cells.
3. Quantize local coordinates.
4. Pack normals.
5. Merge rarely accessed metadata.
6. Consider micro-BVH.
7. Consider more advanced compression.

Do not quantize everything before validation.

---

# Performance Metrics

Measure on at least:

- one discrete GPU,
- one integrated GPU if available,
- the user's primary target hardware.

Report:

```text
GI pass GPU time
scene-build CPU time
dynamic-update CPU time
buffer upload bytes/frame
average macrocell steps/ray
95th percentile macrocell steps/ray
average brick steps/ray
simple tests/ray
complex tests/ray
triangle tests/ray
hit rate
memory usage
```

Compare:

```text
legacy occupancy
hybrid without skip distance
hybrid with skip distance
hybrid with ray-cone LOD
```

Do not claim an optimization is successful from FPS alone.

Use GPU timestamps where supported.

---

# Quality Metrics

Capture fixed-frame comparisons.

Evaluate:

```text
light leakage
contact shadow stability
corner darkening
thin-wall occlusion
small-object occlusion
normal correctness
temporal flicker
cascade transition artifacts
glossy reflection hit stability
```

For image-space comparison, store:

```text
reference image
legacy occupancy image
hybrid image
absolute difference image
```

The reference can be:

- a high-resolution exact CPU ray trace,
- a slow GPU triangle traversal,
- or an offline renderer.

---

# Failure Handling

## If plane fitting causes leaks

- increase conservative occupancy dilation,
- lower the simple-cell confidence threshold,
- classify more cells as complex,
- dilate coverage masks,
- verify cell-local plane offset packing,
- verify near/far DDA intervals.

## If too many cells become complex

- improve plane fitting,
- permit two planes per cell later,
- increase brick resolution selectively,
- split problematic bricks,
- inspect whether mesh duplication is inflating triangle counts.

## If traversal remains slow

Profile before changing algorithms.

Likely causes:

- too many macrocell steps,
- poor memory locality,
- overly fine clipmap selection,
- too many complex cells,
- dispatch divergence,
- excessive buffer indirection,
- dynamic overlay overpopulation.

## If GPU memory is too high

- confirm only occupied cells have surface records,
- compact triangle storage,
- quantize brick-local positions,
- reduce clipmap extent before reducing near-field resolution,
- stream far clipmap levels,
- compress static data separately from dynamic data.

## If temporal instability appears

- stabilize clipmap snapping,
- avoid rebuilding unchanged bricks,
- maintain deterministic triangle order,
- preserve stable quantization,
- hysteretically classify simple/complex cells,
- avoid frame-dependent random acceptance.

---

# Code Review Checklist

Before considering the implementation complete, verify:

## Correctness

- [ ] CPU and WGSL voxel indexing match.
- [ ] All GPU buffers respect alignment.
- [ ] Every index is bounds checked in debug mode.
- [ ] Clipmap wrapping is correct.
- [ ] Negative world coordinates work.
- [ ] Rays starting inside occupied cells work.
- [ ] Rays with zero or near-zero direction components work.
- [ ] Double-sided geometry is handled intentionally.
- [ ] Thin geometry is conservative.
- [ ] Simple and complex cells select the nearest hit.
- [ ] Static and dynamic hits are merged correctly.
- [ ] Step-limit exits are visible.
- [ ] No NaNs reach lighting accumulation.

## Performance

- [ ] No per-ray allocations.
- [ ] No recursion.
- [ ] No unbounded loops.
- [ ] Triangle data is contiguous.
- [ ] Surface records are compacted.
- [ ] Empty cells allocate no leaf data.
- [ ] Buffer uploads use dirty ranges.
- [ ] GPU readback is not performed every frame.
- [ ] Ray traversal timing is measured.

## Maintainability

- [ ] Old occupancy path remains available.
- [ ] Feature flags are documented.
- [ ] Packing constants are centralized.
- [ ] Shader and CPU structures are documented.
- [ ] Test scenes are checked into the repository.
- [ ] Debug visualizations can be enabled independently.
- [ ] Public interfaces have clear comments.
- [ ] The implementation is split into reviewable commits.

---

# Required Commit Strategy

Use small commits.

Recommended sequence:

```text
1. Add ray-hit feature flags and counters.
2. Add CPU validation utilities.
3. Add macrocell and brick data structures.
4. Build brick masks from current occupancy.
5. Add coarse and local DDA traversal.
6. Add debug visualizations.
7. Add plane fitting and packing.
8. Add plane intersection.
9. Add coverage masks.
10. Add complex-cell triangle storage.
11. Add exact triangle fallback.
12. Add conservative skip distances.
13. Add ray-cone LOD.
14. Add dynamic overlay.
15. Optimize dispatch coherence.
16. Profile and document results.
```

Each commit must:

- compile,
- keep old mode working,
- include relevant tests,
- avoid unrelated formatting changes.

---

# Suggested Module Structure

Adapt to the engine.

```text
src/rendering/gi/rayHit/
    RayHitConfig.ts
    RayHitTypes.ts
    RayHitPacking.ts
    HybridSceneBuilder.ts
    ClipmapBuilder.ts
    BrickBuilder.ts
    SurfaceFitter.ts
    CoverageBuilder.ts
    ComplexGeometryBuilder.ts
    DynamicOverlayBuilder.ts
    RayHitDebug.ts
    RayHitValidator.ts

src/rendering/gi/shaders/rayHit/
    rayHitTypes.wgsl
    rayHitDecode.wgsl
    dda.wgsl
    clipmapTraversal.wgsl
    brickTraversal.wgsl
    surfaceIntersection.wgsl
    triangleIntersection.wgsl
    hybridTrace.wgsl
    rayHitDebug.wgsl
```

Keep shader helpers small enough to test and inspect separately.

---

# Minimum Viable Production Version

The minimum version worth shipping includes:

- coarse macrocell hierarchy,
- `4 × 4 × 4` brick masks,
- correct local DDA,
- simple-cell planes,
- coverage masks,
- exact complex-cell triangle fallback,
- legacy occupancy fallback,
- static geometry,
- basic dynamic geometry,
- profiling counters,
- debug visualizations,
- CPU comparison tests.

Skip-distance fields, dispatch regrouping, and micro-BVHs may be added afterward.

---

# Recommended First Experiment

Before implementing the entire architecture, perform this controlled experiment:

1. Keep the existing occupancy hierarchy and traversal.
2. For every occupied voxel, gather contributing triangles.
3. Fit one local plane.
4. Classify unreliable cells as complex.
5. Replace the box hit with:
   - plane intersection for simple cells,
   - exact local triangles for complex cells.
6. Compare against current occupancy and CPU ground truth.

This isolates whether current visual errors primarily come from surface quantization rather than broad-phase traversal.

Expected result:

- much better hit distance,
- better normals,
- fewer block-shaped shadows,
- less incorrect occlusion,
- improved glossy reflection stability,
- similar broad-phase traversal cost.

If this experiment does not materially improve accuracy, investigate voxelization conservativeness and clipmap resolution before implementing more hierarchy complexity.

---

# Definition of Done

The system is complete only when all of the following are true:

1. It can be enabled and disabled at runtime.
2. Legacy occupancy remains functional.
3. It produces fewer false ray hits than pure occupancy.
4. It produces no meaningful increase in false-negative occlusion.
5. It improves surface-hit distance and normal accuracy.
6. It handles thin walls and close surfaces through complex fallback.
7. It works with negative coordinates and clipmap wrapping.
8. It supports static and moving rigid geometry.
9. It has no unbounded WGSL loops.
10. It reports all traversal-limit failures.
11. It has deterministic test scenes.
12. It has a CPU exact-intersection validator.
13. It has GPU debug visualizations.
14. It is profiled on target hardware.
15. Its memory use is documented.
16. It does not introduce unrelated engine regressions.
17. It is integrated into radiance cascades through one stable hit-query interface.
18. It has a written comparison against the previous occupancy implementation.

---

# Final Instruction to the AI Agent

Start by auditing the current engine and implementing **Phase 0 only**.

After Phase 0:

- summarize the current ray-hit architecture,
- list relevant files,
- document coordinate spaces and buffer layouts,
- report current GPU timing and traversal counters,
- identify the smallest insertion point for the hybrid path,
- and only then begin Phase 1.

Do not attempt to implement all phases in one response or one commit.

Reliability, validation, and easy rollback are more important than minimizing the number of changes.
