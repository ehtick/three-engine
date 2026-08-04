# Radiance-cascade ray hit: Phase 3 readiness

> **STATUS 2026-08-04: ACTIVATED.** Phase 2 shipped the fitted-plane records
> this document was blocked on, and `HybridPlaneCoverage` is now a live GPU
> mode — the coverage decode landed exactly where the "Required prerequisite"
> section below predicted (after the bounded plane acceptance, continuing the
> local DDA on an uncovered texel). See
> `radiance_cascades_ray_hit_phase_2.md` for the build pipeline and the
> CPU/GPU validation numbers. The rest of this file is the pre-activation
> design record.

Phase 3's shared CPU representation is implemented, but the
`HybridPlaneCoverage` GPU mode is intentionally not activated yet. The current
runtime tree contains Phase 1 brick-box traversal only; it has no Phase 2
fitted-plane records, GPU plane decoder, or ray-plane acceptance point. A
coverage mask cannot correctly refine an infinite plane until those Phase 2
prerequisites exist.

## Implemented foundation

`RayHitPacking.js` now defines the four-word simple-surface record and matching
CPU codecs for:

- octahedral `snorm16 x 2` normals;
- signed 16-bit cell-local plane offsets;
- scalar coverage and confidence bytes;
- dominant-axis selection and projection;
- conservative `4 x 4` triangle coverage rasterization;
- the required one-texel mask dilation;
- bounded plane/cell/coverage intersection validation.

Coverage occupies the existing `SurfaceRecord.flags` word and therefore adds
no storage-buffer binding:

```text
bits  0..15  4 x 4 coverage mask
bits 16..17  dominant projection axis
bit      18  coverage-valid flag
bits 19..31  surface flags
```

The standalone deterministic test is
`scripts/run-gi-ray-hit-phase3-test.mjs` (`npm run test:gi-rayhit-phase3`). It
checks normal and plane quantization, stable dominant-axis ties, mask packing,
boundary-conservative rasterization, non-wrapping dilation, opening rejection,
cell bounds, and parallel-ray rejection.

## Required prerequisite before activation

Phase 2 must build compact fitted-plane records from the existing conservative
triangle/voxel overlap pass. The records must be appended to the existing
occupancy `bits` allocation, because the profiled composed GI kernel already
uses the portable maximum of eight storage buffers. A separate surface buffer
would create the known nine-binding validation failure.

The surface pool must be compact and capped. Dense records are not viable at
the supported occupancy resolutions. Pool overflow and complex cells must keep
the occupied-box fallback and increment diagnostics; they must never become
misses. Once Phase 2 supplies those records, the GPU Phase 3 change is limited
to decoding the packed mask after a valid bounded plane intersection and
continuing the local DDA when the projected texel is uncovered.

