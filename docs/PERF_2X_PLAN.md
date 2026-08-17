# 30 → 60 fps on ultra — where the frame actually goes

Baseline measured 2026-08-16 on the banner Sponza, GI component `quality: "ultra"`,
viewport 1588×898, renderScale 1, editor (not Play).

## The GPU was honest this time

`nvidia-smi dmon -s pucm -c 10` — **2190–2385 MHz, 69–88 W, 85–97 % SM, mclk pinned
8001**. No duty-cycling, no power cap. Unlike 2026-08-13 ([[dual-gpu-webview2-pin]])
and unlike the 990↔2400 MHz oscillation of [[gi-frame-budget]], every millisecond
below is real. Re-run `dmon` (NOT `-q`) before trusting any future number.

## Beware the warming transient

A first reading gave **52 fps / 14.88 ms**. It was worthless: GI's field only goes
ready ~50 s after boot (`occupancy chain to first field: 50064ms over 1166 frames`),
and `unattributedRate` read **100 %** at that moment versus **1.47 %** once settled.
Any perf number taken before the field is ready is measuring a scene that is not
yet doing its work. Wait for `field ready:` in the console.

## Settled ultra baseline

| | ms |
|---|---|
| GPU frame | **33.66** |
| CPU frame | 7.84 |
| **Budget for 60 fps** | **16.67** |
| **Must remove** | **~17 ms** |

## THE FINDING: GI is not the bottleneck

`profile.giPasses`, settled, ultra:

| group | ms |
|---|---|
| screen passes (`lightShadowPass` 1.71, `resolve` 1.00, filters 0.46) | 3.18 |
| SRC probes (57 dispatches; `gather` 1.16 is the worst) | 3.80 |
| frame queue | 3.83 |
| **GI total** | **~7.6** |

**~26 of the 33.66 ms is NOT GI.** Cutting GI quality cannot buy 2× — it can buy
at most 7.6 ms and costs exactly the look the user said not to lose. This matches
[[new-sponza-perf]]'s "per-pixel bound, three ~12 ms blocks" and redirects the
whole effort at the raster + postprocess side.

## Where the other 26 ms is: the scene's geometry is drawn FOUR times

`profile.drawCalls` — **139 draws, 1,053,286 triangles** for a scene of **25 meshes
/ 262 k triangles**:

| pass | draws | tris | ships in a build? |
|---|---|---|---|
| `output:1588x898#` main opaque | 41 | 264 k | yes |
| `output:1588x898#` depth-only via MeshBasicNodeMaterial | 26 | 264 k | yes |
| `selectionOutlineMask:1588x898#` depth-only | 25 | 262 k | **no — editor only** |
| `rt:1024x1024#` godrays shadow, depth-only | 25 | 262 k | yes |

Plus the per-pixel stack, all at full res: `SSRNode.SSR` + 5 `SSRNode.Blur`,
`GTAONode.AO`, **11 `UnrealBloomPass` passes** (bright + 5 h/v mip pairs),
`Godrays` (at 397×225, cheap).

Notes:
- The outline mask draws all 25 meshes because **`sponza2`, the model ROOT, is
  selected** — every mesh is its descendant. Not a bug, but it is a full extra
  scene draw that vanishes on deselect and never exists in a build. Deselecting
  did NOT move fps here (27 either way), so it is not on the critical path at
  this resolution — but it is on the list for a heavier scene.
- The godrays map re-renders **all 25 meshes at 1024² every frame** although both
  the sun and the geometry are static. §12.81's motion mask is the precedent.
- `floorIfMerged: 8` on the main pass vs 41 draws: 35 distinct materials over 25
  meshes, `staticMerging: false`. Draw count is not the bottleneck at 262 k tris,
  but the depth prepass and godrays pass would both shrink with it.

## Fixed this session

**Godrays shadow pass was poisoning the command buffer.** `renderGodraysShadow`
set `scene.overrideMaterial` and called `renderer.render` with lights visible and
the postprocess MRT still pinned. Both make three compile a fragment shader with
an EMPTY output struct — `structures must have at least one member` → invalid
ShaderModule → invalid RenderPipeline → **the whole `CommandEncoder` is dropped,
so every submit that frame is lost.** A dropped submit reads as a frame-rate
problem, never as an error. `selectionOutline.js:635-661` already documented both
guards for the identical failure; `godraysShadow.js` carried neither. It now hides
lights and nulls the MRT around the render, restoring both in `finally`.

## The A/B that settles it: postprocess OFF

User-measured, same scene, post disabled: **37 fps / 24.1 ms GPU / 5.8 ms CPU**
(vs 33.66 ms with). So the frame decomposes as:

| block | ms | share |
|---|---|---|
| base scene render | **~16.5** | 49 % |
| postprocess stack | ~9.6 | 28 % |
| GI compute | ~7.6 | 23 % |

**The base scene render is the single biggest block, and it is absurd for its
size.** 262 k triangles across 25 meshes on a 4070 at 1588×898 should cost 1–2 ms.
16.5 ms means the cost is PER-PIXEL, not per-triangle — which is exactly what
[[new-sponza-perf]] concluded independently ("per-pixel bound, three ~12 ms
blocks"). Turning post off does not fix it, and neither will any draw-call work.

### Prime suspect: 24 of 32 materials compile the expensive GI shader

From the boot log:

```
[gi] material GI buckets: 0 mirror, 0 specular, 8 diffuse-only,
     24 dynamic-roughness (mirror + dynamic = the expensive shaders; 24/32)
```

Three quarters of the scene's materials are on the `dynamic-roughness` path —
GI's costliest per-pixel variant — because their roughness arrives as a texture or
node rather than a constant, so GI cannot specialise them down. Every one of those
pixels pays the expensive gather. This is the first thing to measure and the first
thing to attack: if Sponza's trim, walls and floors can bucket as `diffuse-only`,
the per-pixel cost of half the screen falls with them.

## EMISSIVE PROJECTILES: 60 → 30 fps, plus freezes (2026-08-16)

Two unrelated causes. One is fixed; the other is measured but not yet cut.

### MEASURED with `BallLauncher.autoFire = 0.4` (a shot every 0.4 s, 24 live)

| | fps | CPU ms | GPU ms | draws |
|---|---|---|---|---|
| before | 25 | **37.42** | 18.59 | 274 |
| after the BVH resync debounce | **37** | **13.76** | 20.85 | 274 |

Identical ball load both runs (274 draws, 843,970 triangles). **CPU 37.4 → 13.8
ms**, and the console's `bvh: exact reflections ON` + 55-tile atlas blit —
which had been firing 2-3 times per SECOND — stopped entirely.

**The projectile problem was never the GPU.** At 37.4 ms of CPU against 18.6 ms
of GPU the frame was CPU-bound two to one, and no shader or resolution change
could have touched it. `profile.frameStats`' `cpuMs` is what said so; reaching
for `giPasses` first would have found nothing wrong.

The script gained an `autoFire` attribute (seconds between automatic shots
along the camera's forward axis, 0 = off, deterministic 5×3 spread lattice) for
exactly this reason: a hand-clicked burst is different every run, so nothing
measured against it can be compared with anything.

### The freezes: a seat re-rank was rebuilding the whole BVH — FIXED

`#checkFingerprint` signalled "the emitter seats changed" by setting
`this._fingerprint = null`. That is a hammer: it made the content comparison on
the next line report a change it had never seen, so a seat swap dragged the
entire content path with it —

- `buildBvhScene` over **262 k triangles**,
- a fresh `createGiBvhReflect` compute node, and three keys pipelines on node
  ID, so a new node is **always** a pipeline-cache miss and a fresh
  multi-second `createComputePipelineAsync` (the boot log measured that kernel
  at 7.3 s),
- a 55-tile albedo atlas re-blit.

Seats are re-ranked by apparent brightness (`power/d²` to the camera) on EVERY
scan, so with emissive projectiles in flight the ranking churns continuously.
The live console during play showed `bvh: exact reflections ON — 56 meshes,
262629 tris` and its atlas blit firing **every ~1.4 s**.

The BVH scene is a pure function of the mesh set and its geometry, and a seat
swap changes neither — every one of those rebuilds was guaranteed to produce an
identical BVH. `#syncBvhScene` is now gated on the content fingerprint actually
moving; `#syncSlots` and `#refreshOccupancyContent` still run for a seat change,
because promotion strips an emitter's baked emissive out of the field and that
content genuinely does move.

### The 60 → 30: the emitter shadow chain is a step function

`createGiEmitterShadowPass` unrolls **`MAX_EMITTERS` = 4 traced shadows per
pixel** (`slots.forEach` over the seat array), so the cost does not scale with
how many emissives are actually in flight — the whole 4-slot BVH8 any-hit march
switches on the moment the first one is promoted, followed by the filter and
two wide passes. [[gi-frame-budget]]'s note that ONE static emissive priced
~14 ms of a 40 ms LOW frame is the same effect, and 16.7 → 33 ms is consistent
with it.

Dials, cheapest first: `#emitterShadowScale` (0.55 at ultra — the buffer is
437×247, and soft area shadows survive a lower res behind the bilateral); a
tier cap on how many seats are actually MARCHED rather than compiled; and a
per-emitter "light but no traced shadow" flag, which is what a projectile
actually wants. **Measure before choosing** — with emitters live,
`profile.giPasses` reports `emitterShadowPass` for real instead of the
`NOT dispatched` stub.

## WHY `low` AND `medium` BOTH SIT AT ~80 fps (2026-08-16)

They are not GPU-bound. Measured, same scene, same 101 draws, settled:

| | GPU ms | CPU ms (engine tick) | GI compute |
|---|---|---|---|
| ultra | 16.51 | ~5.5 | 11.4 |
| medium | **6.68** | **8.52** | 3.1 |
| low | **6.96** | **8.64** | — |

**Two independent ceilings, and neither is the GI preset.**

1. **GPU: low and medium are within 4 % of each other because GI is already
   spent.** At medium the whole module is 3.1 ms (screen chain 0.70 — the
   resolve drops to 794×449 and the shadow channel to 397×225 — plus SRC
   probes 2.39). The other ~3.6 ms of the frame is postprocess (~2.5) and the
   scene draw (~1.0), and **GI quality does not touch either.** Lowering the
   preset further cannot move a frame whose GI share is already under half.
2. **CPU: the engine tick is 8.5 ms, which caps the frame at ~117 fps before
   the GPU is consulted at all.** At ultra the GPU (16.5) hid it; below ~9 ms
   of GPU it becomes the binding constraint, which is exactly why the two
   cheap tiers report the same number.

⚠ And the CPU number is suspect in a specific direction: `workMs` is wall time
across the whole tick (`Engine.js` — `performance.now() - frameStarted` around
`renderer.render`), so **any GC pause that lands inside the tick is counted as
CPU work.** `jsHeapMB` went **1562 → 2180 in about 60 seconds — ~10 MB/s** — on
a scene where nothing moves. At 2.2 GB, majors are expensive and frequent.

So the next perf work is not a shader. It is: (a) find the per-frame
allocation (plan step 6, still never investigated), and (b) if the post stack
must scale with the preset, wire `resolutionScale` to the quality tier instead
of leaving it a per-node authored constant — see the SSR finding below for how
badly a frozen one bites.

## THE LEDGER (2026-08-16): 28 fps → 51 fps at ultra, post ON

Banner Sponza, GI `ultra`, 1588×898, every reading settled past `field ready:`
with `gpuMsIsReal: true`.

| step | GPU ms | fps |
|---|---|---|
| baseline | 31.85 | 28 |
| `bvhReflect` one ray per 2×2 block (13.09 → 4.23) | 26.02 | 34 |
| Bloom `resolutionScale` 1 → 0.5 | 24.25 | 36 |
| **SSR + GTAO `resolutionScale` 1 → 0.5** | **16.51** | **51** |

**SSR at full resolution was ~7 ms — the single biggest win of the session, and
it was a DROPDOWN, not code.** The user's saved post graph pinned SSR, GTAO and
Bloom to `resolutionScale: "1"`; the node registry's own defaults are 0.5 for
bloom/godrays, and `resScale`'s comment already said screen-space reflections
are "usually indistinguishable after the upsample". Godrays was already 0.25,
which is exactly why it profiled at 0.58 ms while its neighbours did not.

⚠ **Stored graphs freeze the default they were authored with.** These props
were almost certainly "1" because `resScale()` defaulted to "1" when the graph
was created; changing the default later fixed new graphs and nothing else.
Before optimising a single line of code on a scene, READ ITS POST GRAPH.

Where the 16.51 ms sits now (giPasses + renderPasses, and it adds up):

| block | ms |
|---|---|
| SRC probes | 4.03 |
| `bvhReflect` | 3.84 |
| lightShadow chain | 1.95 |
| resolve + irrTemporal/irrHistory | 1.63 |
| **GI total** | **11.4** |
| postprocess (all four effects) | ~4.1 |
| scene draw | ~1.0 |

GI is now 69 % of the frame and postprocess is 25 % — the reverse of where the
session started.

### ⚠ `profile.renderPasses` per-effect numbers are INFLATED

It reported Bloom at 10.77 ms; halving its resolution saved 1.77 ms, so the
real cost was ~2.4 ms — roughly 4-5× over. Driving `updateBefore` by hand
measures something the frame does not pay every frame. **Treat its rows as a
RANKING, not as absolutes**, and confirm any candidate with a before/after on
`profile.frameStats`. `profile.giPasses` does not have this problem — its
numbers reconcile with the frame total.

## ✅ CONFIRMED: `bvhReflect` is 13.09 ms of a 31.85 ms frame

`profile.giPasses` with the pass finally in its list, ultra, 1588×898, settled:

| pass | ms |
|---|---|
| **bvhReflect** (exact-reflection BVH trace) | **13.09** |
| lightShadowPass | 1.62 |
| resolve | 1.06 |
| lightShadow filter + wide ×2 | 0.78 |
| SRC probes (57 dispatches) | 3.21 |
| queue extras (irrTemporal + irrHistory) | 0.54 |
| **GI total** | **~20.3** |
| postprocess pipeline | ~10.6 |
| scene draw | 0.59 |
| **frame** | **31.5 vs 31.85 measured** |

**The frame adds up for the first time.** One pass is 41 % of it, and GI is
two thirds — the exact opposite of the "GI is only 7.6 ms, the money is in
raster" conclusion two sessions were built on. Nothing changed in the engine to
make that true; the instrument was blind to the pass.

### The fix shipped: one ray per 2×2 block

`createGiBvhReflect` now traces one reflection ray per `stride`×`stride` block
(default 2 ⇒ **4× fewer BVH traversals**) and replicates the result across the
block. The targets stay FULL resolution, so no consumer changes: the resolve
reads them with `load(coord)` on its own full-res grid and materials sample by
`screenUV`. A genuinely half-res texture would have meant touching both.

Replication is **validated, not blind** — each neighbour's gbuffer position and
normal are compared against the traced texel's (view-relative tolerance, 0.9
normal dot) and a texel whose block straddles a silhouette is written as a MISS
instead of inheriting a wrong hit distance. The consumer reconstructs the hit
point from `t` and its OWN normal, so a wrong `t` puts the reflected sample
somewhere else entirely — that is the bright smear half-res reflections are
known for. A miss is not a hole: it is what a masked-off pixel already gets,
and the material falls back to the cascade lookup. `__giBvhReflectStride = 1`
restores per-pixel tracing for an A/B.

## ⛔ THE REFRAME BELOW WAS HALF RIGHT — READ THIS FIRST

`profile.renderPasses` measured it, and the arithmetic's "~16 ms base scene
render" **does not exist**:

| measured, ultra, 1588×898 | ms |
|---|---|
| **scene draw** (`PassNode.updateBefore`) | **0.59** |
| postprocess pipeline | ~10.6 |
| GI compute, as `profile.giPasses` reported it | ~7 |
| **total accounted** | **~18** |
| actual GPU frame | **31.7** |

262 k triangles cost 0.59 ms, which is what a 4070 should cost. The reframe's
CONCLUSION — the quality-dependent 18 ms is GI's — still stands; its MECHANISM
(a gather compiled into every material's fragment shader) does not. The
irradiance is already deferred: `giLight.js:1345` samples
`light.giIrradianceNode` at `screenUV` through a 4-tap bilateral, not a cascade
walk.

**The ~13 ms hole has a named occupant: `bvhReflect`.** GI dispatches a
full-screen, hit-shaded exact-reflection BVH trace every frame
(`GISystem.js:1909`), and `profile.giPasses`' `SCREEN_PASSES` list **did not
include it** — so the module's costliest pass reported as nothing at all. That
is why GI "measured" 7 ms while moving 18 ms between `low` and `ultra`:
`#bvhReflectionsEnabled()` requires high/ultra, so `low` does not run it. It is
now in the list; the next `profile.giPasses` confirms or kills this.

Two lessons worth more than the number: **an instrument's omissions read as
zeros, and zeros read as innocence** — three sessions of frame-rate work were
aimed at raster because the profiler that could see GI wasn't looking at all of
it. And **an arithmetic residual is not evidence about the thing you subtracted
it from**; "total − post − GI = 16 ms of scene render" was true arithmetic over
a wrong assumption that GI's measured total was GI's real total.

## The reframe (2026-08-16): the frame's quality-dependent 18 ms is GI's

The quality slider is the A/B the plan never ran. Same scene, same camera, same
101 draws / 762 k triangles, same postprocess stack, both settled past
`field ready:`, both `gpuMsIsReal: true`:

| GI quality | GPU frame | fps |
|---|---|---|
| `low` | **13.89 ms** | 53 |
| `ultra` | **32.29 ms** | 28 |

**18.4 ms — 57 % of the ultra frame — moves with the GI quality preset.** But
`profile.giPasses` at ultra totals only ~7 ms (screen 3.18 + SRC probes 3.18 +
irrTemporal/irrHistory 0.57), and postprocess is quality-independent at ~9.6 ms.
That leaves the sum only balancing if roughly **12 ms of the ~16 ms "base scene
render" is the GI irradiance gather compiled INTO every lit material's fragment
shader** — `GICascadeLightNode.setup`'s `context.irradiance.addAssign(...)`,
paid per pixel, per material, inside the main opaque pass.

`profile.giPasses` cannot see it: it measures COMPUTE dispatches, and this is a
render pass. That is why two sessions of "GI is only 7.6 ms, the money is in
raster" were chasing the wrong block — the raster block is GI wearing a raster
costume. 262 k triangles were never the point; the per-pixel gather is.

⚠ Before building on this, close the loop the cheap way: run `profile.giPasses`
at `low` as well. If GI compute at low is ~2 ms, the material-side gather is
confirmed at ~12 ms and it is the single largest item in the frame. If compute
at low is ~2 ms *and* the frame still does not add up, the missing time is in
the postprocess stack after all and step 2 becomes urgent instead.

Everything downstream of this belongs to the gather: cascade count and probe
lattice per quality tier, how many texture fetches a gather does, whether the
diffuse-only bucket's gather can be cheaper than the mirror bucket's (it is the
same gather today), and whether the gather can run at half res into a screen
target the materials sample — which is what "SRC screen passes" already does
for the shadow/resolve half of GI.

## What entering Play mode does (2026-08-16)

Reproduced live, ultra, one clean play/stop cycle:

- Play spawns physics bodies: GI rebuilds at **56 meshes / 56 placements** vs 26
  editing (`27 resident, 29 pending`), material count 30 → 32.
- **Exact reflections switch ON during play and stay on after Stop**:
  `[gi] bvh: exact reflections ON — 26 meshes, 262269 tris, DENSE (full-screen),
  hit-shaded`. This is `#hasReflectionConsumer`'s deferred ramp firing — the
  editing session before Play had no such pass in `profile.drawCalls`. A scene
  therefore renders differently after a play/stop than it did before one, with
  no user action in between.
- `textureMemMB` 577 → 640 (playing) → **734 after Stop**; it does not come
  back. Two cycles would be ~1 GB of textures for a scene that reports 372 MB
  at `low`.
- Sun shadows did NOT visibly break in this cycle (before/after screenshots are
  pixel-identical), so the user-reported "GI shadows break after exiting play
  mode" is either intermittent or needs the emitter path — see below.

### The §12.56 watchdog was inert (FIXED 2026-08-16)

The boot before this one wedged `emitterShadowPass` — 236 skipped dispatches,
pending 7 s — and the watchdog that exists to heal exactly that failed:

```
§12.56 WATCHDOG: re-roll for "emitterShadowPass" REJECTED: Failed to read the
'layout' property from 'GPUPipelineDescriptorBase': The provided value 'null'
is not a valid enum value of type GPUAutoLayoutMode
```

Cause: three fills a **module-level singleton** (`_computePipelineDescriptor`,
class `GPUComputePipelineDescriptor`) and calls `.reset()` on the line after
`device.createComputePipeline(...)` returns. GISystem's interceptor kept the
REFERENCE, so by retry time every pending pipeline aliased one blank object.
**The watchdog has never once healed a wedge since it shipped** — every firing
was a rename of the failure. Fixed by snapshotting `{label, layout, compute}`;
guarded by `npm run test:gi-watchdog`, which fails on the old code.

A wedged `emitterShadowPass` means emissive lamps cast no GI shadows for the
rest of the session, and the recovery path was dead — that is the most likely
mechanism behind "GI shadows break", though it was not reproduced on demand.
**The fix needs a full editor reload to take effect**: the wrapper is installed
once behind `backend.__giAsyncComputePipelines`, so Vite HMR re-evaluates the
module without re-installing it.

## Ranked next steps (not yet done)

1. ~~**Bucket a roughness-MAPPED material by its map's RANGE, not by the
   presence of the map.**~~ **REFUTED 2026-08-16 — do not build this.** Two
   independent reasons, either one fatal. The original write-up is kept below
   the refutation because the *invariant* it documents is still true and the
   next person to touch bucketing needs it.

   **(a) The named mechanism is not the one this scene takes.** Sponza's
   materials are shader-GRAPH materials, not stock PBR: `Material_0.mat` wires
   `tex_arm.g → bsdf.roughness`, and `matchStockPbr` rejects the graph (it
   allows only texture→color and texture→normalMap→normal, and this graph has
   `color` + `multiply` nodes). So `material.roughnessMap` is **null** and
   `material.roughnessNode` is a TSL swizzle of a texture sample. Bucket 3 is
   reached through `staticRoughnessOf` returning null at `giLight.js:75`, not
   through the `roughnessMap` line at `giLight.js:74` the plan blamed. Any fix
   keyed on `roughnessMap` would have moved **zero** of the 24.

   **(b) Even a perfect range analysis does not pay.** All 20 ORM maps scanned
   off disk (`sharp`, raw green channel, full res, no downsample):

   | min(g) band | materials | bucket by min |
   |---|---|---|
   | ≤ 0.45 | **16** | 0 — mirror |
   | 0.45–0.6 | 2 | 1 — directional |
   | ≥ 0.6 | 2 | 2 — diffuse-only |

   Nine of them bottom out at or near 0.000, and it is not a stray texel:
   `Material_3` has **97.6 %** of its pixels under the mirror gate,
   `Material_22` 90 %, `Material_21` 76 %. And bucket 0 generates the SAME code
   as bucket 3 — `giLight.js:1424` is `canMirror = bucket === 0 || bucket === 3`,
   and both compile the mirror trace and the BVH hit blend. So the best case is
   2 of 20 materials moving to the cheap build.

   **The `24 dynamic-roughness` line was never a misclassification.** This
   Sponza's ORM maps really do say most of its stone and cloth is near-mirror
   smooth. The expensive shader is the CORRECT shader for that content, and the
   old Sponza's `27 diffuse-only` differs because it had no roughness maps at
   all — not because something regressed. Bucketing is not the lever; if this
   scene is too glossy that is an **authoring** question about the ORM maps, not
   a rendering one.

   (Side note, cheap and unrelated to frame time: buckets 0 and 3 emit
   identical code but hash to different cache keys, so a scene holding both
   pays two codegens for one program. Worth folding into one key if the
   material wave is ever the target again.)

   <details><summary>The original design, kept for its invariant</summary>

   `giLight.js:74`: `if (material.roughnessMap) return 3;` — unconditional. The
   banner Sponza is a PBR re-import carrying roughness maps on 24 of 32
   materials; the old one carried none, which is exactly why `GISystem.js:5320`
   records this same scene once logging `27 diffuse-only, 0 dynamic-roughness`.
   Bucket 3 compiles the full mirror + hit-lighting block that `giLight.js:48-57`
   measures at **~70 % of a material's GI shader compile cost** — on stone,
   cloth and wood that can never be mirror-like.

   A roughness map does not mean "might be a mirror". It means roughness varies
   per pixel. Three's effective roughness is `material.roughness * roughnessMap.g`,
   so if `material.roughness * min(roughnessMap.g) > GI_SPECULAR_ROUGHNESS_MAX`
   (0.6), NO pixel of that material can take the directional or mirror path and
   it can compile the same cheap diffuse-only build a constant-rough wall gets.
   For Sponza's trim/walls/floors that should be nearly all 24.

   ⚠ **THE INVARIANT THIS MUST NOT BREAK.** `giRoughnessBucketOf` feeds BOTH the
   light node's setup (what code is generated) and the `customProgramCacheKey`
   override (`GISystem.js:8413`, what key it is stored under). `giLight.js:66`
   states it outright: *they must never disagree* — when they did, mirror
   materials rendered with the diffuse-only build. So the map scan MUST NOT be
   async inside this function. Required shape:
   - scan the decoded image on the CPU once, cache `min` on `texture.userData`;
   - `giRoughnessBucketOf` reads ONLY the cached value and returns **3 when it is
     absent** — identical to today's behaviour, so an unscanned material is never
     mis-keyed;
   - run the scan during the mesh walk that fills `_bucketTally`, then let the
     existing `#refreshMirrorBucket` recompile path move the materials, exactly
     as it already does for a static-roughness edit crossing a gate;
   - compressed textures (KTX2/basis) cannot be read back — they stay bucket 3.

   Do it this way or not at all: a half-applied version desyncs the cache key
   from the generated code, and that failure looks like wrong shading, not like
   a crash.
   </details>
2. ~~Instrument the postprocess stack per-pass~~ **SHIPPED 2026-08-16 as
   `profile.renderPasses`** (`src/editor/api/ops/profile.js`) — and it covers
   more than post: `PassNode` is a node in the same graph, so **the scene draw
   is measured directly** instead of by subtraction, which is the number the
   whole reframe above rests on. Each row is one `updateBefore` timed K× inside
   `resolveTimestampsAsync("render")`; it also reports `frameTotalMs` from a
   full `pipeline.render()` so the residual is visible rather than assumed.
   Implementation notes worth keeping: filter on `updateBeforeType !== 'none'`
   (the base `Node` defines an empty `updateBefore`, so the method's existence
   matches every node in the graph), and walk the graph iteratively with a
   visited set — `Node.traverse` re-descends every shared subtree of what is a
   DAG. **Needs an editor reload to appear** (the op registry is read at boot).

   First questions to put to it, in order: is the scene draw really ~16 ms?
   Does Bloom's 11 passes or SSR's 6 own the post block? And run it at `low` as
   well — the delta on `sceneDrawMs` alone settles the reframe.

   ⚠ **Two traps the first build of this op fell into, both of which return a
   plausible small number instead of an error:**

   - **Resolve after EVERY render, never once after K of them.** `giPasses`
     batches K dispatches and resolves once, which is safe because a GI pass is
     one dispatch. A full `pipeline.render()` opens ~20 render passes, and
     three's `WebGPUTimestampQueryPool` holds **`maxQueries = 256`** — K=24
     overflows it after the fifth render, every later
     `allocateQueriesForContext` silently returns null, and the resolve reports
     a fraction of the truth. First reading: **0.53 ms for a 32 ms frame.**
     Compounding it, `_resolveQueries` returns `framesDuration[frames.at(-1)]`
     — the LAST frame group only, keyed on `renderer.info.frame`.
   - **Take the scene draw from `PostprocessComponent.scenePass` directly, not
     from the graph walk.** The walk returned zero nodes on the first run and an
     empty `passes` list is indistinguishable from "this frame has no effects",
     so the op now also reports `walk: { nodesVisited, byUpdateBeforeType }` —
     the one line that says whether the walk reached the graph at all.

   ⚠ **An op's `run` body does not hot-reload.** `defineOp`'s fingerprint is
   `description + params` and deliberately excludes `String(run)` (Vite rewrites
   dynamic imports with a `?t=` buster). Change only the body and HMR
   re-registers it as a no-op re-evaluation, keeping the OLD implementation —
   the editor must be reloaded. Changing the description instead makes
   `defineOp` **throw** on the HMR pass.
3. **Bloom: 11 passes** descending from full res. Start the mip chain at half res.
4. **The depth prepass draws 264 k tris including `Background.mesh`** — a
   background in a depth prepass writes far-plane depth and occludes nothing.
5. ~~Freeze the godrays 1024² map~~ **SHIPPED 2026-08-16.**
   `godraysShadow.js` now fingerprints its own inputs — the shadow camera's
   projection·view plus every drawn mesh's world matrix, geometry id and
   visibility — and skips the render when nothing that feeds the map has moved.
   On the banner Sponza that removes **25 draws and 262 k triangles at 1024²
   from every idle frame**, a quarter of the frame's draw calls.

   The fingerprint returns `null` — read as "never freeze" — the moment it sees
   a skinned mesh, a morph target or an InstancedMesh, because those deform
   without their matrix changing and a transform fingerprint is blind to them.
   A miss here is a stale volumetric shadow, not a crash, so the conservative
   rule costs nothing on scenes that cannot use the optimisation anyway. It is
   a rolling integer hash, not a joined string: 400+ `toFixed` calls per frame
   to save ~1 ms of GPU work would be a bad trade. Panning the viewport
   correctly invalidates it — LightComponent recentres the shadow camera on the
   active camera, so the camera matrices are part of the fingerprint.
6. **jsHeap 1765 → 2167 MB across two reads minutes apart** (and `textureMemMB`
   384 → 580 over the same interval). [[gi-frame-budget]] recorded ~20 MB/s idle
   growth. At 2.24 GB this is GC-pause territory — a separate investigation from
   the GPU frame, and the likely source of the *fluctuation* in "26–31 fps".
