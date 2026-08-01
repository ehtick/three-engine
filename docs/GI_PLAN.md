# GI Fidelity & Performance Plan

*2026-07-31. Owner: GI module (`src/modules/gi/`). Status legend: ☐ planned ◐ in progress ☑ done*

## Context

The GI module is 3D Radiance Cascades over a voxel-free SDF scene: per-mesh SDFs
(analytic primitives + baked grids in a tiled atlas) are GPU-composited into one
global distance field; cascades trace it every frame (no temporal accumulation —
deliberate, the editor needs same-frame response); a deferred screen resolve
applies irradiance + glossy. After the 2026-07 fidelity rounds (shaped OBB
emitters, comparative shadow exclusion, fp16 composited field, 128³ hi-res SDF
blocks), two problems remain:

1. **Shadows/reflections are SDF-limited.** A baked, quantized, finite-res SDF
   can never produce exact visibility — penumbras carry bake noise, sharp
   reflections show melted geometry.
2. **CPU/GPU spikes while objects move.** Dragging bumps the atlas revision
   every frame; each bump re-runs the whole-volume composite (~1M cells × a
   32-slot loop, `sdfScene.js` `compositeCompute`) **plus the full cascade
   queue including feedback** (`GISystem.js` `#tick`), every frame of the drag.

## Reference analysis (`docs/shadertoy_*.glsl` — "Radiance Cascades 3D", Mathis)

Its `TraceRay` never marches an SDF: it intersects nine primitives
**analytically** (exact quads/boxes/spheres/cylinders) and knows the exact
albedo at each hit; reflections are literally a second analytic trace. So its
"perfect shadows and reflections" come from **exact per-ray visibility + exact
hit shading**, not from the cascade machinery. What transfers to arbitrary
meshes: exact rays = a triangle **BVH ray query**. What does not transfer:
surface-resident probes (needs lightmap-quality parameterization of arbitrary
GLBs) and temporal merging (its own header admits "light lag and flickering" —
fatal in an editor).

**Decision: keep Radiance Cascades for diffuse (millions of cheap rays — where
the SDF earns its keep). Add exact triangle rays only where the eye can resolve
sharpness: sharp reflections and primary emitter shadows.**

## Phase 1 — fp16 mesh-SDF atlas ☑ *(shipped 2026-07-31)*

The composited global field is already fp16 (that fix visibly cleaned shadow
"marble"), but the per-mesh atlas tiles are still u8: each tile quantizes
distance to `span/255`, and the shadow trace amplifies distance error by `k/t`
into penumbra dirt. Promote the atlas the same way:

- `bakeCore.js` `bakeMeshSdf`: emit `Uint16Array` half-float bits of the
  normalized distance (`min(1, d/MESH_SDF_CAP)`) instead of u8.
- `meshSdfAtlas.js`: `Data3DTexture` → `RedFormat` + `HalfFloatType`
  (r16float — filterable in base WebGPU), fills `255` → `0x3c00` (half 1.0).
  Shader decode (`texel.r × distScale`) is **unchanged** — zero shader edits.
- `.sdf` cache format `SDF_VERSION` 1 → 2 (u16 payload). Old v1 files decode
  to `null` → the existing staleness path rebakes automatically. No migration.
- Memory ceiling 32 MB → 64 MB (only at the 8-layer/128-slot maximum; typical
  scenes sit at 1–2 layers).

## Phase 2 — kill the moving-object cost ☑ *(shipped 2026-07-31)*

Two independent fixes; both keep full quality at rest:

- **2a. Dirty-brick composite.** The atlas accumulates a dirty world-AABB —
  the union of each changed slot's **old ∪ new** expanded bounds (move, SDF
  arrival, surface edit, clear). The composite gets `dirtyMin`/`dirtyMax`
  uniforms and skips cells outside the box. Full-volume composite remains for:
  first build, refits (`refreshAllSlots` → mark-all; volume bounds/capWorld
  change invalidates every cell), and any revision bump without a mark
  (fail-safe null → whole volume). Escape hatch `globalThis.__giNoDirtyBrick`.
- **2b. Drag-rate throttle.** While the revision keeps bumping every frame
  (continuous drag), run the composite + full queue at most every 3rd frame
  (dirty bounds keep accumulating in between); the frame after changes stop,
  run one final settle composite. First change after idle still composites
  immediately — edit responsiveness is unchanged. Escape hatch
  `globalThis.__giNoMoveThrottle`.
- Measured by a new harness `scripts/run-gi-move-cost.mjs`: frame-time
  avg/p95 while a baked mesh orbits continuously, then a correctness check
  that the shadow lands at the final position (and the old position re-lights)
  — A/B via the two hatches.

## Phase 3 — exact rays where the eye can tell (BVH) ☑ *(coverage build verified + default ON at high/ultra, 2026-08-01 late)*

**Resolution of the black-mirror saga:** two conflated failure modes. (a) An
intermittent no-camera/no-GI boot hang tied to per-origin editor state —
protocol now: **fresh vite PORT per harness run**. (b) A real bug in
giLight's coverage-consumption branch: hoisting the texture sample through
`.toVar()` and gating the SDF trace behind `If(flag)` rendered black; the
same pass with v1-style **pure dataflow** consumption passes. Rewritten that
way (direct `.sample().r/.g` reads + nested `select`, unconditional SDF
trace — costs what pre-BVH always cost). Verified on clean origins:
coverage build 60.1 vs SDF 40.0, mirror baseline rgb(39,1,0) exact with
default ON. Static geometry now reflects exactly; skinned meshes stay
visible via the coverage union.

**Field report (user's real scene) forced two corrections.** (1) The Phase 2b
drag throttle staggered moving shadows into visible judder on heavy scenes —
REVERTED; the dirty-brick alone was the right fix and now composites every
frame. (2) BVH-alone erased rigged characters from mirrors (skinned meshes are
BVH-excluded). Fix implemented: a **dynamic-coverage flag** — the reflect pass
slab-tests the live AABBs of every BVH-excluded mesh and writes a per-pixel
flag (texture g channel); the mirror path trusts BVH except on flagged pixels,
where the SDF trace joins via nearest-positive union. An *unconditional*
union was tried first and rejected: SDF melted-blob phantom hits sit in front
of true surfaces, re-sealing every silhouette (harness delta 20 → 0).
**Verification of the flagged build is blocked** by a harness environment
issue (BVH arm reads black on this session's bash-launched vite; the
executor's own server verified v1 fine — suspect the `/@fs` module-twin
class, see memory). Until `run-gi-bvh-reflect` passes both arms again,
`exactReflections` is **opt-in (default false)** — the default path is the
pre-Phase-3 SDF trace, baseline-exact (mirror rgb(39,1,0) re-verified).

**v1 shipped — exact BVH mirror reflections.** Architecture as designed: a
half-res compute pre-pass (`createGiBvhReflect`, giScreen.js) traces mirror
rays from the gbuffer against `bvh/bvhScene.js` (all static GI meshes, walls
included, concatenated BLAS + per-frame transform table — moving needs no
rebuild) and writes hit-t to a **NearestFilter** StorageTexture (bilinear on a
depth-like t corrupts silhouettes); giLight's mirror block swaps its t source
to that texture compile-time — hit shading, miss semantics, fallbacks all
unchanged. Enabled at high/ultra via `exactReflections` prop;
`__giNoBvhReflections` hatch. Verified: scene-BVH 399/400 vs CPU raycasts,
mirror baseline rgb(39,1,0) EXACT in both arms, reflected-silhouette contrast
60.1 (BVH) vs 40.0 (SDF), ~+0.3 ms GPU on small scenes, build+types green.
Integration traps recorded: BoxGeometry's 6 default groups make three-mesh-bvh
build one root per group (degroup before building or boxes silently vanish);
TSL `.element(i)` reads inside a `Loop` must be `.toVar()`-hoisted before
`If()` or the condition is silently always-false.

**Still open (v2):** skinned meshes are excluded from the BVH (absent from
exact reflections — needs per-frame BLAS refit); per-hit real texture UVs
(barycentrics are available — retires mean-color albedo); BVH any-hit emitter
shadow rays in the resolve.

## Shipped 2026-08-01 evening (post-diagnosis session tail)

- **Texture-at-hit reflections**: build-time 2048² albedo atlas (8×8 tiles,
  drawImage or solid-color fallback) + concatenated per-vertex UV buffer;
  `firstHit` returns barycentric-interpolated atlas albedo; second screen
  target (rgb+flag); giLight substitutes it for the mean-color albedo (pure
  dataflow). Gates: knot A/B PASS, mirror baseline exact.
- **Striped hit lighting fixed**: true face normal from the hit triangle
  (oct-encoded in the t-target's .zw), hit points offset along the SURFACE
  normal (0.15× normalOffset — larger offsets over-blur fine geometry,
  empirically tuned) instead of the ray; face normals also replace
  SDF-gradient normals in hit shading. Knot contrast 61.0-61.6 stable
  (baseline 60.1), mirror rgb(38,1,0). Residual under heavy zoom: the
  half-res buffer's own pixel grid — cured by the existing full-res /
  edge-aware upsample item, not a standoff issue.
- **GI panel simplified**: Quality + Intensity primary; all else in a
  collapsed Advanced group; `custom` quality (engine maps tier lookups via
  `qualityTierOf`, high-tier budgets); editing an advanced field flips to
  custom in one undo step; named presets rewrite nothing. 14/14 UI
  assertions (`run-gi-panel-smoke.mjs`).
- Known pre-existing, untouched: auto-fit null-deref on mesh-less scenes;
  intermittent React double-createRoot harness crash.

## Priorities after the 2026-08-01 real-project diagnosis (GAME/Main.scene)

Ranked by the user's actual pain, with evidence:

1. **Kill the ~6 s freeze = the rebuild compile wave** (`materials 5931ms
   (node builds 5931ms)` measured in their scene; per-frame motion is FLAT
   8.33 ms — the per-frame path is done, stop touching it). Directions:
   eliminate mid-session rebuild triggers (atlas-capacity hysteresis, no
   drift-rebuilds during play, tier prewarm) and shrink node-build cost of
   the mirror-bucket materials.
2. **Skinned meshes in exact reflections** — their mirrors' main subject IS
   the skinned character (screenshots: white SDF ghost in the box mirror).
   Per-frame BLAS refit (three-mesh-bvh `refit()`) + the coverage flag
   already shipped. Pair with **texture-at-hit shading** — the ghost is
   mean-color albedo as much as geometry.
3. **Ceiling/wall marble-contour shadow artifact** — persists at ULTRA
   (user screenshot), so it is the old unsolved 7f contour class, not a
   budget issue. Needs its own investigation with a HIGH-PASS banding
   metric (|d2| nulls every A/B — see memory), using the kept
   `run-gi-diagnose-game.mjs` harness (fix its emissive predicate first).
4. BVH-on blackness on the harness env — bisect on a clean env before any
   default flip.

**Spike verdict:** three-mesh-bvh's packed BVH traverses correctly and fast in
hand-written WGSL on this stack — **512/512 agreement** with CPU `raycastFirst`
(two runs), **7–11 M rays/s** on 200k-ray batches (wall-clock incl. readback
fence — an underestimate of in-shader throughput). Working pieces:
`src/modules/gi/bvh/bvhGpu.js` (packing + `wgslFn` traversal, not yet wired
into the GI module) and `scripts/run-gi-bvh-spike.mjs`. Key facts for the
integration: `wgslFn` + 4 flat storage buffers via
`attributeArray(...).toReadOnly()` (access mode must match the WGSL `ptr`
signature; never vec3-typed storage arrays — 16-byte stride vs the packed
12-byte data); node layout is 32 B = 6×f32 bounds + 2×u32 contents straight
from `bvh._roots[0]`; **three-mesh-bvh is now 0.9.13 and ships a NATIVE
WebGPU/TSL raycast module (`src/webgpu/`) — evaluate reusing it before
hand-rolling more**; fragment-stage use still needs texture packing (the
8-storage-buffer limit).

Gate: a ~1-day spike proving a WGSL/TSL traversal of three-mesh-bvh's packed
BVH (its stock shader packs are GLSL; the dead 2026-07-16 ReSTIR attempt
already taught the 8-storage-buffer limit → pack in textures). If the spike
holds up:

- **Sharp reflections** (roughness below threshold): BVH closest-hit behind
  the existing pluggable seams — `light.mirrorTraceFn` / `hitSurfaceFn`
  (`GISystem.js` ~1200, `giLight.js` ~601). A triangle hit gives barycentrics
  → UV → sample the *actual texture* at the hit (retires the mean-color-tint
  approximation entirely). Rough reflections stay on the SDF cone path; SSR
  still wins where it hits.
- **Primary emitter shadows**: any-hit rays (early-out) for the K brightest
  emitters, only in the half-res deferred resolve. SDF keeps soft/secondary
  occlusion and all probe rays.
- **Two-level BVH** (per-mesh local BLAS + transform TLAS): motion is a
  matrix update — no rebake on the exact path.

## Non-goals

- Surface-resident probes / lightmap parameterization.
- Temporal accumulation of cascade results.
- Replacing the SDF for diffuse probe rays (BVH per probe ray is unaffordable).

## Verification

Existing baselines that must hold (harnesses in `scripts/`):
`run-gi-rc-mirror` rgb(39,1,0)±1 · `run-gi-rc-splitroom` sealed L39-41 /
restored L67-75 · `run-gi-rc-penumbra` r015 ≈0.05 m, r090 ≈0.2–0.25 m ·
`run-gi-emitter-leak` "LEAK none", tint 63 · `run-gi-sdf-hires` clean knot
shadow, single build. Plus `npm run build` + `npm run check:types`, and the
new `run-gi-move-cost` A/B for Phase 2. Note: the fp16 format bump makes the
first post-upgrade run log `mesh SDF baked` (not `loaded`) once per mesh —
expected, not a regression.

**Phase 1+2 verification results (2026-07-31):** every baseline above held
exactly (mirror rgb(39,1,0), splitroom L39-41 / L68-75, penumbra 0.05 m /
0.2 m, leak none + reversals 0 + tint 63, hi-res knot profile clean, single
build). `run-gi-move-cost`: move avg 8.33 ms ≈ static 8.43 ms with the fixes
on; the dirty-brick and full composites produced **pixel-identical** floor
samples in the HEAVY A/B (29/152/46 both ways) — correctness proven. The
dev-machine GPU pins both configs at 120 Hz vsync even in HEAVY mode, so the
frame-time win is structural here (composite threads early-out outside the
brick; 3× fewer dispatches while dragging) and should be re-measured on the
real project scene.
