# Radiance-cascade ray hit: record-aware shadow distance

The user-requested follow-up to Phases 2–5: GI-traced soft shadows
(`shadowMode:"gi"` suns, emitter shadows) lose their voxel-hull "squarish"
silhouettes by sharpening the distance the penumbra estimator marches on —
NOT by replacing the march with hit rays (a single hit ray gives hard
shadows; the `min(k·d/t)` estimator is what makes area sources soft).

## Mechanism

The shadow trace's near-surface distance comes from the occupancy oracle
(`freeRadiusAtWorld` near field): per occupied voxel in the 3×3×3 around a
sample, distance to that voxel's AABB — conservative, but its isosurfaces
are voxel-shaped. With surface records present, an occupied **static-brick**
voxel with a valid **SIMPLE** record now contributes

```text
max( aabbGap,  (|n̂ · (q0 − v) − d_plane| − slack) · minVoxelComponent )
```

- `max(...)` because the plane is only authoritative inside its cell — the
  AABB gap keeps the bound valid outside it, and a max of two lower bounds
  is a lower bound.
- `slack = SIMPLE_MAX_PLANE_SIGMA + 0.02` (`RECORD_AWARE_PLANE_SLACK`,
  one definition in RayHitPacking.js): the classifier's residual ceiling
  plus snorm16/oct packing margin. **Measured requirement 0.0948 vs shipped
  0.12 — 1.27× headroom, all of it from the σ ceiling. σ and this slack
  must move together or the conservativeness proof breaks.**
- Complex cells, DynamicBrick macrocells, invalid offsets, starved pools:
  plain AABB gap, unchanged.
- Zero new bindings: records live in the `bits` buffer the oracle already
  reads. The skip-off/record-off WGSL is byte-identical to before (distinct
  sharedFn variant `giFreeRadius2nsr1`; every old variant keeps its name).

Flags: `rayHitShadowRecords` prop / `__giRayHitShadowRecords` global,
default ON whenever records exist (plane-family mode + SDF-free). Only the
shadow-trace oracle calls pass it — mirror traces, the composite, AO taps
and burial ramps are untouched.

## Why this is flicker-safe

Records are fitted in FULL chains only (static geometry), so the sharpened
distance is constant between rebuilds; and `max(gap, plane)` is continuous
in the sample point (measured worst |Δd|/step = 1.000, exactly the box
form's Lipschitz constant — no window-shift seam). The stable feedback
estimator gets the same sharpened input, so groups of cells crossing a
threshold together (the session-19 flicker mechanism) see a *smoother*
threshold, never a new discontinuity.

## Validation (2026-08-04)

CPU (`npm run test:gi-rayhit-shadow`, 33/33, vs exact point-to-triangle):

```text
sharper   flat floor, 400 pts, 0.1–1.5 voxel heights: mean +0.458 voxel
          (band 0.2–0.9: +0.414, 200/200 strictly sharper); inside occupied
          voxels the AABB form reads 0 while records read true height ±2.6e-5
safe      500+ pts across floor/ramp/sphere/thin-wall + curvature ladder:
          0 violations of d ≤ exact + slack·minVoxel (incl. anisotropic
          voxels via min-component scaling)
floor     d ≥ AABB-only everywhere (max() shape)
continuity 8 line probes × 400 steps: worst |Δd|/step = 1.000
fallback  DynamicBrick flip, starved pool, recordAware:false → AABB-only
          byte-identical
```

GPU: `check:types` clean; smoke arms `hybrid-plane-coverage`,
`hybrid-exact-complex`, `occupancy-legacy` all PASS at exactly 8 storage
bindings with the record-aware oracle compiled into every GI-lit material's
shadow trace (records on by default in plane-family modes).

## Not yet done

- No editor eyeball of the softened silhouettes (flip the scene to
  `hybrid-plane-coverage` and watch a small-sourceAngle sun edge).
- No perf delta measured for the record fetches in the shadow loop (the
  lookup is gated to occupied near-field neighbours; expect small — verify
  with `RAYHIT=1` sweep or the flicker harness's aggregate GPU number).
- Complex cells still contribute voxel-hull distance (triangle-distance in
  the oracle would be exact but expensive; revisit only if curved-geometry
  silhouettes still read blocky in the eyeball).
