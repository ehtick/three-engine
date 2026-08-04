# Radiance-cascade ray hit: Phase 5 (conservative empty-space skip)

Phase 5's *mechanism* shipped early: since Phase 1, both hybrid macro loops
(`giHybridBrickTrace`, `giHybridPlaneTrace` in `occupancyField.js`) have ridden
the existing occupancy pyramid's levels 3–4 above the macro grid — descend on
an occupied ancestor, advance to the aligned block's exit on an empty one.
This phase delivers what the spec still required before the phase could be
called complete: an A/B kill switch, skip instrumentation, a CPU mirror of the
coarse ride, and validation that skips change traversal cost but never results.

## The adaptation (spec escape clause invoked)

The spec's Phase 5 asks for a stored low-bit empty-space distance per
macrocell. This module deliberately does not store one — the design note at
the top of `occupancyField.js` is the authority:

- An OR-downsampled pyramid parent is empty **only if all 8 children are**, so
  skipping its full extent can never cross geometry. That is strictly stronger
  than a distance bound: no safety subtraction, no overestimate risk.
- It costs **0 bytes** on top of the pyramid the legacy path already needs,
  and — decisive for this engine's static/dynamic split — it is rebuilt by the
  OR-downsample passes in **every** voxelize chain, so it can never go stale
  when a dynamic object moves into previously-empty space. A stored distance
  field computed in the full chain only would leak exactly there, violating
  the spec's own "the skip must never cross a potentially occupied cell".

Skip lengths are therefore block-aligned (a level-3 block = 2 macrocells, a
level-4 block = 4) rather than up-to-63-cell jumps; the per-level skip
counters below are the spec's "skip-length histogram" in that representation.

## What Phase 5 added

- **Kill switch** — `resolveRayHitConfig().enableSkipDistance` now defaults
  **ON** (the ride was always-on and every prior phase validated with it);
  `globalThis.__giRayHitSkipDistance = false` or the component prop
  `rayHitSkipDistance: false` compiles skip-free trace variants
  (`rayHitCoarseSkip` option → distinct variant key; the disabled variant's
  WGSL contains no coarse-level reads at all, and `level` pins to 2).
- **Counters** — `RayHitCounter` grows 20 → 24: `CoarseSteps` (loop
  iterations spent at levels 3–4), `CoarseSkipsL3` / `CoarseSkipsL4` (empty-
  ancestor advances, by level = the 2-bucket skip-length histogram) and
  `CoarseDescends` (occupied-ancestor level drops). 96 B keeps the counter
  buffer's 16-byte alignment; recording stays profile-gated.
- **CPU mirror** — `buildOccupancyPyramidCpu()` (OR-downsample from the same
  level-0 predicate) and a `pyramid` option on both CPU tracers replicating
  the GPU loop exactly, including the two subtleties: a descend consumes a
  macro-loop iteration *without advancing t*, and every completed macro cell
  re-ascends to level 3.
- **Smoke arm** — `?skip=0` on `gi-gpu-smoke.html` runs the skip-free
  variants; the default arm asserts the ride engaged (`coarseSteps > 0`,
  skips > 0), the skip=0 arm asserts it is truly absent (`coarseSteps === 0`).

## Validation (2026-08-04)

CPU (`npm run test:gi-rayhit-phase5`, 29/29):

```text
skip-equivalence     1012 rays × 5 scenes (sealed room, starved-records room,
                     thin double wall, UV sphere w/ exact-complex, seeded
                     random boxes): 0 mismatches on hit/voxel/kind/normal,
                     |Δt| ≤ 2e-3, plus 4000-ray probes at 0 mismatches
false negatives      sealed room, pyramid ON: FN 0/176 outside, 0/200 inside
                     (distance error median 3.6e-15)
step reduction       sparse 64³, 40 long rays: 208 vs 683 macro iterations
                     (3.3×), skipsL4=158, no limit exits either way
box-normal parity    the starved-records scene forces 176/176 box hits — the
                     one path whose normal rides the DDA `axis` the skip also
                     writes — 0 divergences. (Structural reason: coarse block
                     edges are also macro-cell edges, so the crossed face is
                     identical with and without the ride.)
```

GPU smoke (storage=8, validation errors 0, all arms):

```text
hybrid-plane-coverage           avgMacro=5.23 maxMacro=41  coarse=6.15M
  skipL3=1.12M skipL4=0.82M descends=4.21M  limitExits=0 invalid=0
hybrid-plane-coverage&skip=0    avgMacro=3.99 maxMacro=23  coarse=0 exactly
  (kill switch compiles the ride out; PASS criteria otherwise unchanged)
hybrid-exact-complex            regression PASS, boxFallbacks=0 preserved
hybrid-brick-box                regression PASS, coarse counters flow
```

Note the smoke inversion: in that tiny auto-fit volume the floor occupies
nearly every level-3/4 block, so descend chains make skip-on *cost* ~1.3
iterations/ray more — the win is in sparse air (the 3.3× above), which is
where cascade rays spend their long intervals in real scenes. That trade is
inherent to hierarchical DDA (legacy behaves identically); the counters now
make it visible per scene.

Regression: phases 0/2/3/4 CPU suites, `check:types`, and `build` all green
after integration.

## Known limits / notes

- In *dense* traversal neighbourhoods the ride can cost slightly more loop
  iterations than pure macro DDA (descend chains consume iterations); the win
  is in sparse/open space, which is where cascade rays actually spend their
  long intervals. This matches the legacy 5-level hierarchical DDA's
  behaviour, and `MAX_MACRO_STEPS` (128) already budgets for descents.
- Skips are proven result-neutral (same hit, voxel, kind, normal; |Δt| within
  the DDA epsilon accumulation) — not byte-identical `t`, because each skip
  adds one `RAY_HIT_DDA_EPSILON` advance. Leaf (plane/exact) hit distances
  are computed from the surface equations and are unaffected.
- Next per the spec's ordering: Phase 6 (ray-cone LOD), Phase 7 (dynamic
  overlay — DynamicBrick typing already covers the record-invalidation half),
  Phase 8 (dispatch coherence). Next per the user's stated direction: route
  the `shadowMode:"gi"` sun/emissive cone traces through the hybrid hit path,
  then radiance-field volumetric fog/godrays.
