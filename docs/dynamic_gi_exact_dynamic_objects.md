# Dynamic GI: Replace World-Space Dynamic Occupancy with Exact Object Intersections

## STATUS (2026-08-06) — IMPLEMENTED (phase 1 + rigid-mesh acceleration), MEASURED ON THE REAL PROJECT

Implementation: `src/modules/gi/dynamicObjects.js` (+ GISystem adoption wiring,
occupancyField reserved region, cascadeGather swept invalidation).

What shipped vs this doc:

- **Adoption on first motion, sticky**: a mover that classifies leaves the
  voxel path permanently — no placement, no slot, no bits, no per-frame
  re-voxelize. Representation (user directives): **every three.js default
  geometry with a closed form is analytic** — Box/Plane → OBB, Sphere →
  sphere (ellipsoid under scale), Capsule → capsule, Cylinder/Cone → conical
  frustum with caps (partial sweeps / open-ended → BVH); **every other rigid
  geometry** (custom, torus/knot/polyhedra/…) → **object-local wide BVH with
  exact triangle leaves** (this replaced §"sparse 8x8x8 bricks"): compressed
  8-wide nodes by default (origin + power-of-two steps + u8-quantized child
  bounds, conservative both ways), `__giDynBvhArity=4` = uncompressed A/B.
  Per-mesh override: the Mesh component's **"GI Dynamic" Inspector dropdown**
  (`auto | voxel | bvh | obb` — a typed component prop, also settable from
  scripts via `getComponent("mesh").setProp("giDynamic", …)` or, for raw
  THREE meshes, `mesh.userData.giDynamic`). Flips take effect live: the tag
  bypasses the classify cache, and an already-adopted mover releases and
  re-routes on the next frames — no rebuild.
  Skinned/morphing/over-budget (`__giDynMeshMaxTris`, default 120k) stay voxel.
- **Unified ray query**: composed as a wrapper over the occupancy field's
  `traceOccupancy`/`traceHybridPlane`/`traceHybridBrick` — every consumer
  (cascade transport, field feedback sun shadows, screen direct shadows,
  emitter record shadows, debug view) resolves nearest-of(static, exact
  dynamic) automatically. Object data + BVH pools live in a reserved tail of
  the already-bound `bits` buffer — **zero new bindings** at the 8-storage/
  12-uniform walls (verified: smoke arms still exactly 8).
- **Dynamic hit shading (phase-1 form)**: cascade rays hitting an exact
  surface sample the radiance field at the offset hit point (the same shading
  the voxel path used). Emissive/direct-at-hit material evaluation is still
  the doc's phase 2.
- **Penumbra**: an analytic closest-approach clearance term from each
  object's bounding OBB feeds the marchers' own r(t) = max(t/k, penWidth)
  band — width only, never admission.
- **Swept-bounds temporal invalidation**: per-object prev∪curr world AABB
  (expanded 1.5 field cells) cuts the feedback EMA retain weight to ≤0.35
  inside it while the object moves. `__giNoSweptInvalidation` disables.
- **Acceptance criteria measured** (run-gi-real-shadow-probe on the real
  Sponza, harness-driven 2-axis 0.6 rad/s rotation, 2026-08-06): direct
  BURST inter-frame churn 150–210 px baseline + 323–413 spikes → **3–32 px,
  zero spikes**; indirect CELLBURST **bigPops 4 → 0**, worst single-frame
  cell step **5.81 → 0.16 lum**. Occupancy is byte-stable under pure mover
  rotation (gi-gpu-smoke `?dynobj=1/2` asserts it).

Hatches: `__giDynamicObjects=false` (kill), `__giDynMeshWords` (pool size),
`__giDynBvhArity`, `__giMaxDynamicObjects`, `__giDynObjectsDebug`,
`__giNoSweptInvalidation`. Boot marker: `[gi] dynamic-objects: exact movers ON`.

Not built yet (per this doc's own phasing): material evaluation + emissive at
dynamic hits (phase 2), per-region candidate lists (unneeded ≤16 objects),
near-field exact rays (phase 4), deforming proxies (phase 4). Known small
gaps: adopted movers leave the composite SDF (width probes see static
geometry only; the OBB band term covers mover softness) and no longer
contribute occupancy-oracle AO; the legacy density-cone shadow arm is not
composed (analytic-width default is).

## Goal

Fix unstable indirect lighting, indirect shadows, and temporal flickering caused by rebuilding rotating or moving objects into the world-space occupancy grid.

The current binary occupancy representation has reached its quality limit for dynamic rigid objects. Rotating geometry changes voxel coverage discontinuously, which causes:

- flickering indirect shadows
- changing object thickness
- light leaks
- over-occlusion
- unstable radiance-cascade history
- ghost lighting after movement
- voxel-shaped silhouettes

Do not try to solve this only by increasing voxel resolution.

---

## Required Architecture

Use a hybrid scene-intersection system.

### Static geometry

Keep the existing world-space occupancy grid for:

- buildings
- terrain
- static props
- distant geometry
- broad-phase ray traversal

### Dynamic geometry

Do not rebuild rigid dynamic objects into the world occupancy grid.

Use:

- box/cube: analytic OBB intersection
- sphere: analytic sphere intersection
- capsule: analytic capsule intersection
- rigid arbitrary mesh: object-local acceleration structure with exact triangle refinement
- deforming/skinned mesh: capsules or a separate coarse dynamic proxy initially

### Radiance storage

Keep radiance cascades as the lighting cache.

Geometry visibility and radiance storage must be separate systems.

---

## Unified Ray Query

Every GI, indirect-shadow, AO, reflection, and visibility ray must query both:

1. static world occupancy
2. dynamic objects

Return the nearest hit.

```wgsl
fn traceScene(ray: Ray, region: u32) -> Hit {
    var closest = traceStaticOccupancy(ray);

    let candidates = getDynamicCandidates(region);

    for (var i = 0u; i < candidates.count; i++) {
        let object = dynamicObjects[candidates.ids[i]];
        let hit = traceDynamicObject(ray, object);

        if (hit.valid && hit.t < closest.t) {
            closest = hit;
        }
    }

    return closest;
}
```

The returned hit must contain:

```text
valid
t
worldPosition
worldNormal
materialId
objectId
transformVersion
albedo
emissive
```

---

## Immediate Implementation: Rotating Cubes

Represent every rotating cube as an oriented bounding box.

Store:

```text
worldMatrix
inverseWorldMatrix
normalMatrix
halfExtents
materialId
objectId
transformVersion
previousWorldBounds
currentWorldBounds
```

For each ray:

1. transform the world ray into cube-local space
2. intersect against the local axis-aligned box
3. do not normalize the transformed direction
4. preserve the ray parameter `t`
5. transform the local normal back to world space

```wgsl
fn intersectOBB(ray: Ray, object: DynamicObject) -> Hit {
    let ro = (object.inverseWorld * vec4f(ray.origin, 1.0)).xyz;
    let rd = (object.inverseWorld * vec4f(ray.direction, 0.0)).xyz;

    let invDir = 1.0 / rd;

    let t0 = (-object.halfExtents - ro) * invDir;
    let t1 = ( object.halfExtents - ro) * invDir;

    let tMin3 = min(t0, t1);
    let tMax3 = max(t0, t1);

    let tEnter = max(tMin3.x, max(tMin3.y, tMin3.z));
    let tExit  = min(tMax3.x, min(tMax3.y, tMax3.z));

    if (tExit < max(tEnter, 0.0)) {
        return noHit();
    }

    let t = max(tEnter, 0.0);
    let localPosition = ro + rd * t;
    let p = localPosition / object.halfExtents;

    var localNormal = vec3f(0.0);
    let a = abs(p);

    if (a.x > a.y && a.x > a.z) {
        localNormal.x = sign(p.x);
    } else if (a.y > a.z) {
        localNormal.y = sign(p.y);
    } else {
        localNormal.z = sign(p.z);
    }

    let worldNormal = normalize(object.normalMatrix * localNormal);

    return makeDynamicHit(
        t,
        ray.origin + ray.direction * t,
        worldNormal,
        object
    );
}
```

This must replace voxel rebuilding for cubes.

---

## Arbitrary Rigid Meshes

Build the acceleration structure once in object-local space.

Recommended first version:

```text
RigidMeshAcceleration
├── localBounds
├── sparse 8x8x8 bricks
├── brick occupancy bitmask
├── triangle-list offset/count per brick
├── triangle indices
├── vertices
└── material data
```

At runtime:

1. transform the ray into object-local space
2. intersect the object local bounds
3. traverse occupied bricks using DDA
4. test exact triangles inside candidate bricks
5. stop when the next brick entry distance exceeds the nearest triangle hit
6. transform hit position and normal to world space

Important:

- occupied voxels/bricks are only broad phase
- never treat occupancy as the final surface hit
- exact triangle intersection determines the silhouette
- rigid object rotation must only update its transform

---

## Dynamic Object Broad Phase

Do not begin with a full software TLAS unless required.

Start with one of these:

### Small dynamic-object count

Loop through object AABBs directly.

### Medium dynamic-object count

Build candidate lists per radiance-cascade region or spatial cell.

```text
region 0 -> objects [1, 4]
region 1 -> objects [0, 1, 7]
region 2 -> objects []
```

Each ray only tests objects affecting its current region.

### Large dynamic-object count

Add a lightweight top-level:

- uniform grid
- spatial hash
- LBVH
- refitted BVH

Profile before implementing this stage.

---

## Dynamic Hit Shading

When a radiance ray hits a dynamic object, evaluate:

```text
outgoing radiance =
    emissive
  + direct lighting at hit
  + previous-frame indirect irradiance * diffuse BRDF
```

Example:

```wgsl
let previousIndirect =
    samplePreviousRadianceField(hit.worldPosition, hit.worldNormal);

let outgoing =
    hit.emissive +
    evaluateDirectLighting(hit) +
    hit.albedo * previousIndirect * INV_PI;
```

Use previous-frame indirect lighting to avoid recursive same-frame updates.

---

## Near-Field Indirect Shadow Quality

Exact dynamic intersections remove voxel instability, but radiance-cascade resolution may still blur contact GI.

Add a near-field path:

```text
0-2 metres:
    short exact geometry rays

beyond near field:
    radiance cascades
```

Use near-field rays for:

- dynamic contact occlusion
- indirect shadow detail
- corners near moving objects
- high-frequency local GI

Blend into the radiance-cascade result with distance.

---

## Temporal Invalidation

Track the swept bounds of each dynamic object:

```text
sweptBounds = union(previousWorldBounds, currentWorldBounds)
```

Expand it by the relevant cascade footprint or maximum local tracing distance.

Mark affected probes or cache cells dirty.

Store temporal metadata:

```text
hitObjectId
objectTransformVersion
hitDistance
hitNormal
```

Reject or strongly reduce history when:

```text
object ID changed
transform version changed
hit distance changed significantly
normal changed significantly
sample lies inside an affected swept region
```

Suggested history behavior:

```text
unaffected static region: high history weight
affected dynamic region: low history weight
disoccluded region: zero history weight
```

Do not clear the full radiance field when one object moves.

---

## Direct Shadows

Use conventional raster shadow maps for primary directional-light shadows.

Do not force direct hard-shadow quality through the GI occupancy structure.

Recommended split:

```text
directional-light direct shadows -> cascaded shadow maps
point/spot direct shadows         -> shadow maps or cubemaps
indirect visibility               -> unified exact/static ray query
radiance storage                  -> radiance cascades
```

---

## Migration Plan

### Phase 1

- add dynamic object buffer
- implement analytic OBB intersection
- remove rotating cubes from world occupancy rebuild
- make radiance-cascade rays test OBBs
- make indirect-shadow rays test OBBs
- add swept-bound temporal invalidation

### Phase 2

- implement sphere and capsule primitives
- add per-region dynamic candidate lists
- add material evaluation for dynamic hits
- add previous-frame indirect sampling at dynamic surfaces

### Phase 3

- build object-local sparse-brick acceleration for rigid meshes
- add exact triangle refinement
- add duplicate-triangle suppression or brick-level triangle lists
- profile against direct AABB loops and any existing TLAS

### Phase 4

- add near-field exact indirect rays
- improve temporal rejection
- add deforming-object proxy support
- introduce a dynamic TLAS only if profiling proves it necessary

---

## Acceptance Criteria

The implementation is successful when:

- rotating cubes no longer trigger world voxel rebuilds
- cube indirect shadows rotate smoothly without snapping
- no changing voxel thickness is visible
- GI rays hit the exact OBB surface
- direct and indirect visibility agree on dynamic-object position
- moving objects do not leave long-lived ghost lighting
- static-scene performance remains close to the current version
- dynamic-object cost scales with nearby candidates, not total world size

---

## Non-Goals

Do not:

- solve this only by increasing occupancy resolution
- world-voxelize rigid objects every frame
- use binary occupancy as the final dynamic surface hit
- invalidate the entire radiance cache after object movement
- build a complex TLAS before profiling simpler candidate lists
- normalize object-space ray directions after inverse transformation

---

## Core Principle

Use occupancy for cheap static traversal and broad phase.

Use exact analytic or triangle intersections for dynamic-object visibility.

Use radiance cascades to store and reuse lighting, not as the source of geometric truth.
