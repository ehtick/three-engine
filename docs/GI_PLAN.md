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

## Shipped 2026-08-02 — reflections: sparse, and lit at the right point

Three independent causes behind "BVH is super expensive and bad looking":

- **`exactReflections` was still missing from `#structuralSignature`** (diagnosed
  2026-08-01, never fixed). The Inspector toggle did nothing until an unrelated
  edit forced a rebuild — so past A/B evaluations of exact reflections may have
  been measuring a stale build. Now structural, next to `sparseField`.
- **The prepass was DENSE.** `createGiBvhReflect` fired one BVH ray plus a
  dynamic-coverage slab test for *every* gbuffer pixel, on every frame it was
  enabled, whether or not a reflective surface was on screen. Now sparse: a new
  `GI_MIRROR_LAYER` (28) tags meshes whose material is in roughness bucket 0/3,
  a second small gbuffer render marks exactly those pixels in the normal
  attachment's unused `w`, and non-mirror threads exit before traversal. Masked
  pixels still write `t = -1`, so miss semantics are unchanged. Tagging is
  idempotent because `mesh.layers.mask` is part of the static batching key.
  A/B hatch: `__giNoBvhMask`.
- **Hit shading used the RECEIVER's irradiance.** `giLight`'s fast exact path
  multiplied the hit's albedo by the *mirror's own* irradiance, so a mirror in
  shadow showed a darkened copy of a sunlit object and a mirror in sunlight
  over-brightened everything it reflected (the `+0.06` floor existed only to
  stop that going black). The per-material "true mirror" block that would have
  shaded it properly is dead code — `GISystem` nulls `mirrorSampleFn` et al.
  deliberately (a 39 s compile wave). Hits are now shaded **in the resolve
  pass**: it reads the prepass's t + face normal + albedo, reconstructs the hit,
  and applies the cascade gather, the emitters (shadowed) and the analytic
  lights *at the hit*, writing radiance to a third target `bvhRadiance`.

**Why the resolve and not the prepass.** Shading inside the BVH pass asks for
**16 uniform buffers in one compute stage against a WebGPU baseline of 12** —
the emitter bundle is the part that blows it. Over the limit the pipeline is
invalid and *every compute submitted with it is dropped*: GI goes black rather
than degrading. The resolve already binds the gather, the emitters and the light
slots, so shading there costs two texture reads and one storage write.
`resolveRendererLimits()` now also raises this limit where the adapter allows,
but the dev machine advertises exactly 12 — the resolve-pass design is not an
optimisation, it is the only one that works there. Consequence for the resize
path: the BVH targets must be recreated *before* the resolve is rebuilt.

**Verification.** `run-gi-rc-mirror` never actually had `exactReflections` on —
the prop defaults false and the harness never set it, so every "BVH arm" number
it ever printed was the SDF path. It now takes `EXACT=1` (and `MASK=0`). With
exact reflections genuinely on and hit-shaded, `mirrorLeft` lands on
**rgb(39,1,0)** — the documented reference — where the receiver-lit path gave
44 and the SDF path 35. Sparse vs dense is **byte-identical** on every sample.
Splitroom (L39-41 / L68-75), penumbra (0.05 m / 0.2 m), emitter-leak (none / 0 /
63), build and `check:types` all hold.

Also fixed here: a real ViewportPanel mount-effect race (the `engine` proxy
throws before `ensureEngine()` resolves; a throw in a mount effect unmounts the
React tree, which presents as "there is no canvas") — new `isEngineReady()`.
`run-gi-bvh-reflect` boots again as a result, but still reports nonsense in both
arms including the `BVH=0` one, which is code-path-identical to HEAD — that
harness is broken independently of GI. Use `run-gi-rc-mirror EXACT=1`.

## Shipped 2026-08-02 — the legacy SDF transport backend is gone

`backend` (prop, Inspector dropdown, `__giBackend` hatch) and
`createSdfSceneTrace` are deleted. Occupancy is the only transport backend.
Two transport paths meant every leak fix had to be made and verified twice, and
the legacy one *was* the leak: it did no detail refinement, so diffuse GI saw
only the coarse blobs while shadows and mirrors saw sub-cell geometry.

**The composited SDF stays.** Shadows need a continuous distance for the
penumbra estimator (`min(k·d/t)` with closest-approach interpolation — a bitset
has none) and the mirror sphere trace needs a surface to march to.

**Two baselines legitimately moved**, because occupancy is now always on rather
than opt-in — both are the session-14 behaviour arriving by default, not
regressions:

- `run-gi-rc-penumbra` **r015 edge 0.05 m → 0.10 m.** The shadow trace's
  occupancy hard block (`occupiedAtWorld(p, 0)` → `penumbra = 0`) quantizes the
  sharpest contact shadows to roughly one voxel, and high-quality voxels are
  0.125 m. r090 is unchanged at 0.2 m — it was already far wider than a voxel.
  The lever, if contact shadows want to be sharper, is the per-tier occupancy
  voxel target (`high: 0.125`, `ultra: 0.1`).
- `run-gi-rc-splitroom` **restored L67-75 → L68-78.** The composite's occupancy
  clamp gives sub-cell geometry a radiance shell, so slightly more bounce.
  Sealed stays L39-41 — the leak fix holds.

**One behaviour change worth knowing:** a device failing the
`maxStorageBuffersPerShaderStage ≥ 10` gate used to fall back to the SDF trace.
It now gets no GI at all, and says so.

### It hung a GPU first — occupancy's cost tiers were opt-in tiers

Selecting **ultra** on a real 43 m scene immediately after this change killed
the device (`DXGI_ERROR_DEVICE_HUNG`). The occupancy tiers (`traceSteps` 48 /
64 / 96 / **128**, budget to 128e6 voxels) were written while the backend was
opt-in, where they mean "spend more if you ask for it". Making it the only
backend re-read the same numbers as *the default cost on every scene*: ultra
went from a 128-step DDA you opted into, to 128 steps on every transport ray,
replacing a ~48-step sphere trace, with an auto-fit refit loop on top.

`traceSteps` is now capped by what the grid can use —
`min(tierSteps, clamp(⌈‖res‖/4⌉, 48, 128))` — and ultra's voxel budget is
128e6 → 80e6. The cap costs nothing measurable: splitroom and penumbra return
**byte-identical** results at 48–51 actual steps instead of 96, i.e. those tiers
were buying steps the grid could not use. The build log now prints the real
number.

**The general rule this earned:** when an opt-in path becomes the only path,
its cost tiers are no longer tuned — re-derive them.

### Do we still need the SDFs? (40 MB on Sponza)

Yes — for **soft shadows**. With transport on occupancy, `atlas.refineDetail`
is sampled at runtime by exactly two production traces, `createShadowTrace` and
`createMirrorTrace`. The penumbra estimator `min(k·d/t)` needs a *continuous*
distance and a bitset has none.

The 40 MB is the per-mesh atlas: 256×256×64 fp16 per layer = 8.39 MB holding 16
tiles, so Sponza's ~5 layers ≈ 42 MB (ceiling 64 MB at 8 layers). Levers, with
their real costs:

- tile axis 64³ → 32³ → ~5 MB, but loses exactly the fine silhouettes
  `refineDetail` exists for;
- fp16 → u8 → 20 MB, and reintroduces the shadow "marble" Phase 1 fixed;
- drop `refineDetail` from both traces → atlas needed only at composite time,
  except the composite re-runs whenever anything moves;
- **replace the penumbra estimator with an occupancy-based soft shadow** — the
  only option that actually deletes the 40 MB, and a project rather than a
  cleanup.

## 2026-08-02 — SDF-free mode, the feedback-rate pulse, and the preview server

**The pyramid is the distance oracle, and it is now wired.** New
`occupancyField.freeRadiusAtWorld(p, maxLevel)`: per level, the 2×2×2 block of
level-L voxels nearest `p`; all-empty ⇒ nothing occupied inside a box extending
half a level-L voxel from `p`, so the distance is at least `p`'s distance to
that box's face. The coarsest passing level wins. **It is continuous** — the
value is a distance to a box face, not a power of two — which is the property
the penumbra estimator needs and the reason the atlas outlived every previous
removal attempt. Pure dataflow, no `If` around the fetches, no early exit
(occupancy is monotone across levels, so `max` *is* "coarsest passing level").

Behind `killSdf` (component prop + `__giKillSdf`, structural, **default OFF**):
the composite takes its distance from the oracle instead of min-ing atlas
slots, both traces swap `atlas.refineDetail` for it (3 levels — the bound
reaches ~4 voxels, which brackets a coarse cell where the trilinear far field
takes over), and `#ensureMeshSdf` returns immediately. Slot metadata (mean
albedo/emissive, AABBs) stays — it is uniforms, not grids. `sparseField` is
force-disabled with it: the bricks resample the grids that are gone, and both
traces trust a valid brick *over* the coarse distance, so blank bricks would
overwrite the good answer.

**Known trade to check by eye:** the oracle quantizes to the occupancy voxel
(0.125 m at high) where a baked SDF was 0.02–0.15 m — contact-shadow sharpness
and mirror-hit silhouettes are where it will show first.

**The flicker was an irregular feedback rate.** The bounce feedback is a
fixed-point iteration, so the level you see depends on how many iterations ran
since the light last changed. `runFeedback` was `feedbackEveryFrame || frame % 2
=== 0` against a free-running counter, while the composite branch ran the FULL
queue unconditionally — so at low/medium, the moment anything moved, the cadence
went 2 iterations, then 0, then 1. `bounce` defaults to 1, so each iteration is
visible. High/ultra iterate exactly once per frame by construction, which is why
it was tier-dependent. Now gated on frames since the last ACTUAL run, and the
composite branch honours the same decision. `__giFeedbackEveryFrame` forces full
rate (the confirming A/B); `__giLegacyFeedbackRate` restores the old behaviour.

**The hosted-build hang was the preview server, not GI.** `serve_build_lan`
marks its listeners non-blocking to poll the stop flag, and **on Windows an
accepted socket inherits that**. So every browser/Wi-Fi connection was
non-blocking: `read_line` returned `WouldBlock` and the handler treated any read
error as "give up" (connection closed, no response), and `write_all` returned
`WouldBlock` mid-body with the result discarded by `let _ =` (truncated
response, `Content-Length` promising bytes that never came — a browser waits
forever). That is the whole report: assets randomly missing, textures and meshes
half-loaded, page hanging "most of the time". Fixed by `prepare_stream` on every
accepted socket (blocking + nodelay + timeouts), `io::copy` streaming with
propagated errors, HTTP keep-alive (a build is hundreds of files and each close
was another chance to lose one), `ETag`/304 with `no-cache` instead of
`no-store` (a phone re-pulling 200 MB per reload is indistinguishable from a
hang), TLS `close_notify`, and a graceful `Shutdown::Write`. Export now writes
via `replace_atomically` — live preview rebuilds the same directory the browser
is fetching from, and a truncated `scene.json` fails the whole boot.

## Reflection roadmap (agreed 2026-08-02)

Four systems chosen per surface type. Three already exist in some form; the work
is a **classifier**, not four new systems.

| Tier | Status |
| --- | --- |
| Large flat mirror / polished floor → planar render | ☑ done — `PlanarReflectionComponent` over three's `reflector()`, `npm run test:planar` |
| Smooth metal/glass → stochastic Hi-Z SSR | `SSRNode` is wired in `postGraph.js`, but is a fixed 64-step *linear* march + thickness test |
| Rough glossy/metal → RC or probes | RC does this (`giLight.js` roughness-blended cascade levels); local probes missing |
| SSR misses on smooth → sparse exact tracing | ☑ done above |

Order: planar → Hi-Z SSR → local probes. **Design constraint:** SSR, the GI
mirror path and planar can all claim the same pixel; the classifier must be a
single authority emitting one tier per pixel rather than three systems each
blending in. The mirror mask above is its first stage — widen `giNormal.w` from
a flag to a tier id.

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
