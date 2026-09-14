# EDITOR BOOT — WHERE THE TIME ACTUALLY GOES, AND WHAT RUST CAN BUY (2026-09-12)

Companion to `ZERO_FREEZE_PLAN.md`. That document audited the boot in
September 7 and shipped Stages 0–1 plus most of 3–5; this one is **one
measured boot of the project as it stands today**, taken live through the
editor's own instruments, plus an honest answer to "what should move to
Rust".

The headline, before any detail:

> **Boot to a usable editor is 4.3 s. Boot to a LIT scene is 165 s.**
> Of that 165 s, essentially none is JavaScript and none of it is work
> Rust can do. It is the GPU driver compiling 6.2 MB of WGSL that we
> generate freshly on most boots. **Rust is worth ~3–5 s of a ~170 s
> boot.** Spend the sprint on shader size and shader-text stability
> first; Rust becomes the right tool immediately after, because once the
> wave is fixed the remaining boot IS scene I/O, instantiation and the
> BVH — which is exactly what Rust is good at.

---

## 1. THE MEASUREMENT

Live editor, `GAME/scenes/Complex.scene` — **19 entities**, 3 roots, 2.04 M
triangles, 74 draws, 3 650 catalogued assets, GI ultra auto-fit, modules:
world / foliage / terrain / atmosphere / water / postprocessing / gi.

`profile.boot`, `profile.freezes` and the editor console, one session:

| milestone | wall | main thread blocked |
|---|---|---|
| engine import module graph | 623 ms | |
| engine construct | 739 ms | |
| modules import + enable (+ `module: gi` 401 ms) | 180 ms | |
| renderer construct | 534 ms | |
| prefabs (24 files, 16 concurrent) | 286 ms | |
| **scene: read file** (15.5 MB, **read twice**) | 460 ms | |
| scene: instantiate entities (3 roots, **1 yield**) | 1 235 ms | **1 216 ms in ONE task** |
| scene: await textures | 214 ms | |
| **→ "Editor ready"** | **4 340 ms** | 1 390 ms / 3 tasks |
| GI build (16 meshes, setup) | 527 ms | 1 720 ms block (SAH 375, kernel builds) |
| static BVH disk-cache preflight | **4 388 ms → MISS** | |
| **→ GI compile wave** | **165 270 ms** | **30 800 ms in 2 tasks** |
| **→ field first pass / scene lights** | **165 496 ms** | |

Session totals from the freeze ledger: **42 tasks, 41 506 ms blocked,
worst 17 093 ms**, `stalls.waitingOnGpuMs` 5 734 ms.

The two blocks that own three-quarters of the frozen time:

```
[freeze] 17093 ms — gi:wave/material MeshBasicMaterial 16980.5  [sync gpu: 4r/0c/7m, 89kB WGSL]
[freeze] 13838 ms — gi:wave/material World study · depth and reflective water 13745.9
```

Note what is NOT in them: `MeshBasicMaterial`'s own TSL node build cost
**21 ms** across 2 builds for the whole session. The 17 s is one
`compileAsync` call parked on WebGPU-wire backpressure while the GPU
process chews through the pipelines queued before it — the mechanism
established in [[zero-freeze-gpu-stall-standins-0910]], now firing on a
19-entity scene.

The driver's own numbers:

```
[gi] render pipelines: 93 compiled, slowest Foliage · living surface 61kB frag/35kB vert 131.7s,
     Foliage · living surface 65kB frag/29kB vert 128.5s, Cottage · plaster 52kB frag 125.4s
[gi] compute kernels: 72 totaling 1323kB WGSL
[gi] SLOWEST PIPELINE: #71 [resolve] took 121.3s (51kB WGSL) of 3399.1s summed over 74 pipelines
[gi] compile wave: materials warmed safely in 165270ms while viewport remained live
```

**167 pipelines, ~6.2 MB of WGSL, for 19 entities.** 3 399 s summed
against 165 s wall = Dawn is using ~20 threads and is still the
bottleneck by two orders of magnitude over everything else in this
document.

**Steady state, for contrast (`profile.cpuFrame`, 90 frames):** CPU
**4.99 ms**, GPU 4.59 ms, 74 draws, 2.04 M tris, heap 526 MB. The running
editor is *fast*. **Selecting an entity: 0 blocks, ~26 ms of node builds**
— Stage 5 and the outline fixes worked; the old "10 s click" did not
reproduce. The complaint is boot and the wave, not the editor.

---

## 2. WHAT IS BROKEN, RANKED BY MEASURED SECONDS

### B1 — ⛔ A PIPELINE THAT FAILS AT CREATION, FOREVER *(fixed 2026-09-12)*

```
THREE.WebGPURenderer: Async render pipeline creation failed (renderPipeline_Foliage · living surface_134):
  The number of sampled textures (17) in the Fragment stage exceeds the maximum per-stage limit (16).
  This adapter supports a higher maxSampledTexturesPerShaderStage of 48, which can be specified in
  requiredLimits when calling requestDevice.
```

`resolveRendererLimits` (`sceneSettings.js`) asks for six raised limits and
had **never asked for this one**. Baseline is 16; a GI-injected foliage
fragment reached 17; the adapter offers 48.

Why it is not a cosmetic error: **a pipeline that never becomes ready is
cached by nothing.** three re-mints the material's node graph on every
frame that tries to draw it. Measured on an *idle* editor 3 minutes after
boot: `Foliage · living surface` **31 → 52 node builds and climbing**,
1 925 ms and rising, WGSL modules **338 → 375 and rising**. The invalid
layout then cascades:

```
Async render pipeline creation failed (renderPipeline_MeshStandardNodeMaterial_133):
  [Invalid PipelineLayout (unlabeled)] is invalid due to a previous error.
Async render pipeline creation failed (renderPipeline_GI gbuffer · Foliage_213):
  [Invalid BindGroupLayout (unlabeled)] is invalid due to a previous error.
```

**Fixed:** `sceneSettings.js` now asks for
`maxSampledTexturesPerShaderStage = min(32, adapter)` when the adapter
beats the baseline, adapter-clamped exactly like its five neighbours.
`tests/renderer-limits.test.mjs` (`npm run test:renderer-limits`) pins the
ask, the never-exceed-the-adapter rule, and the `__engineLimitsCap` floor —
nothing had covered that function before.

⚠ **Requires a full editor restart** (device limits are fixed at
`requestDevice`), and it is a *hardware-dependent* fix: a baseline-16
device still fails. **The portable fix is to get foliage's fragment below
16 samplers** — that is a real unit, not a footnote.

### B2 — 165 s OF DRIVER COMPILE: THE SHADERS ARE TOO BIG AND THEIR TEXT MOVES

Two multiplicands, both addressable.

**(a) Size.** `ZERO_FREEZE_PLAN` §2.5 R2 already named it: *the material IS
the GI renderer*. Today's receipt on a 19-entity scene: 61–65 kB fragment
programs for foliage, 51–52 kB for cottage plaster and mortar, and
`[gi] material GI buckets: 0 mirror, 1 specular, 13 diffuse-only, **14
dynamic-roughness**` — 14 of 28 materials carry the expensive
dynamic-roughness consumer. Stage 2's deferred specular (materials back to
~27–40 kB) is still the single largest unshipped lever in the engine.

**(b) Stability.** `profile.freezes.wgsl` this boot:

```
modules 338 (5 188 kB) · rawHitsFromLastBoot 109 · canonicalHitsFromLastBoot 274 · rescuedByRename 165
stillUnstable: compute 111 kB ×3 · fragment_Foliage · octahedral impostor 69 kB
               fragment_World landscape · natural layered stone 68 kB
               fragment_Foliage · living surface 65 kB ×3
```

**64 of 338 modules changed text since the previous boot — and they are
the same shaders the driver named as its slowest compiles.** The
`wgslStable.js` rename rescued 165 modules; these eight are what is left,
and they are carrying the whole 165 s.

**⭐⭐⭐ SOLVED, 2026-09-12 — see §6 for the exact literals.** The
diff did not need two boots: two modules *in the same boot* with identical
byte length and different canonical hashes are the same graph rebuilt, and
`profile.wgsl` can dump both.

**(c) Queue order — a hypothesis worth one A/B.** `GISystem.js:6548-6568`
submits the occupancy + SRC compute kernels to the driver *before* the
material loop, deliberately, to overlap them. But nothing the user can see
exists until the **materials** land, and the SRC field cannot run before
them either. With a saturated driver pool, 74 compute pipelines (up to
148 kB each) sitting ahead of 93 render pipelines plausibly costs the
*visible* editor most of its wait. Cheap test: move `early` to after the
material loop and re-read `[gi] render pipelines: … slowest`.

**(d) 25 variants → 93 pipelines.** `[gi] compile wave: 25 unique material
variants of 37 drawable objects` yet 93 render pipelines were compiled —
×3.7. Shadow pass, GI g-buffer pass, main pass and the outline mask are
separate contexts. Worth a census before assuming it is irreducible.

### B3 — THE MAIN THREAD BLOCKS *INSIDE* `compileAsync`

The wave loop yields correctly on its own wall clock between objects, so
this is not a scheduling bug: **one** `compileAsync` blocked 17 s.
`stalls.waitingOnGpuMs` 5.7 s over 15 blocks. Until B2 shrinks the queue
this is unavoidable; the mitigation is to stop *waiting* on the wire —
submit and let `isReady` skip, which `asyncRenderPipelines.js` already does
for draws but not for the wave's own `compileAsync`.

### B4 — 15.5 MB OF PRETTY-PRINTED JSON FOR 19 ENTITIES

```
entities            5 864 520 B compact   (15 570 451 B on disk — `JSON.stringify(json, null, 2)`)
  foliage placements 5 340 000 B          32 929 placements across 11 components
  terrain              352 475 B
  everything else        4 500 B
```

A placement is
`{"id":"trees/15/0","position":[15.087602438554171, …],"rotation":[…],"scale":…}`
— full f64 text, ~160 B each, every id distinct.

Three separate costs fall out of this one fact:

1. **The file is read from disk and crossed over IPC TWICE per boot.**
   `peekBootRendererSettings` (`sceneIO.js:156`) invokes `load_scene` and
   parses it to read `settings.renderer`; `restoreLastScene` (`:238`)
   invokes `load_scene` **again** for `contents`, then throws that string
   away in favour of the cached parse (`takeParsedScene(path) ??
   JSON.parse(contents)`). The second read exists only to print a kB
   label. **460 ms and 15 MB of IPC, free.**
2. **`scene: instantiate entities` is 1 216 ms in ONE unyielded task** —
   32 929 placement objects allocated from JSON, one at a time.
3. **Autosave re-stringifies all 15.5 MB on the main thread**
   (`sceneIO.js:378`, `autosaveSeconds: 10`). It is idle-gated, so the
   user rarely feels it, but it is the largest recurring allocation in the
   editor.

At 32 B per placement (pos f32×3, rot f32×3, scale f32, prototype u16) the
same data is **1.0 MB binary** — 5× the payload, ~15× the disk, and zero
per-placement object allocation because the runtime can view the buffer
directly.

### B5 — THE STATIC-BVH DISK CACHE SPENT 4 388 ms TO REPORT A MISS

```
[gi] static BVH cache preflight: miss in 4388ms
[gi] static BVH scene pointer was stale (750d8937 -> 82e4eba0)
[gi] static shadow bvh: 185204 tris, 7.2MB, built in 376ms
[gi] static BVH cache wrote 7.2MB
```

The build is 376 ms. **The cache lookup is 4 388 ms and misses anyway.**
Fix the key before anyone rewrites the builder — this is the exact trap
[[probe-blind-statistics]] warns about.

### B6 — 143 454 `writeBuffer` CALLS / 667 MB IN ONE 261 ms TASK

```
[freeze] 261 ms — material:nodeBuild GI gbuffer · Foliage 180.4 …
  [sync gpu: 20r/2c/23m, 581kB WGSL, 667.5MB written in 143454 write(s), largest 0.5MB]
```

~4.6 kB mean per write, immediately after the wave, in the foliage /
GI-g-buffer path. Not yet attributed to a call site — `FoliageComponent.js`
around `:541-584` (per-chunk `instanceMatrix` + per-attribute
`needsUpdate`) is the first place to look. Flagged, not diagnosed.

---

## 3. THE RUST QUESTION — AN HONEST LEDGER

Rust is **already in-process**: Tauri 2, `src-tauri/src/lib.rs` is 125 kB
with 40+ commands, and the IPC is already well-built for this
(`read_binary_files` packs N files into one aligned `tauri::ipc::Response`,
`read_text_files` exists precisely to kill per-file round trips). So the
cost of adding Rust work is low. That makes it *more* important to be
honest about where it pays.

### Where Rust CANNOT help — 165 of the 170 seconds

| work | ms this boot | why not |
|---|---|---|
| GI compile wave | **165 270** | Dawn/Tint inside the GPU process. No Tauri command reaches it. |
| ↳ main thread blocked in it | 30 800 | Same. Fixed by smaller WGSL + not awaiting the wire. |
| TSL node-graph builds | ~2 500 | Produces live three.js node objects in the JS heap. Crossing IPC per material would cost more than it saves. |
| engine import / construct / renderer | 1 896 | JS module evaluation and WebGPU device setup. |
| per-frame work | 4.99 ms/frame | An IPC hop is more expensive than the whole frame. |

**If the only thing that changes this quarter is Rust, boot goes from
~170 s to ~165 s.** That is the number to keep in view.

### Where Rust DOES pay — and it becomes the whole boot once B1/B2 land

Ordered by payoff *after* the compile wave is fixed, at which point the
boot is ~5 s and every row below is a visible fraction of it.

**R1 — Binary scene payloads (foliage placements, terrain fields).** The
biggest and the easiest. Split `placements` (and the terrain heightfield)
out of the `.scene` JSON into a binary sidecar Rust writes and reads;
`.geom` already establishes the pattern and `pack_binary_files`/`BPK1`
already establishes the transport. Kills B4 entirely: 15.5 MB → ~1.3 MB on
disk, one read instead of two, a typed-array view instead of 32 929 object
allocations (most of the 1 216 ms instantiate block), and an autosave that
writes bytes instead of stringifying 15 MB. **Also fix the free half
first** — make `restoreLastScene` read the file only on a cache *miss*
(one `if`, 460 ms).

**R2 — Scene serialize + write off the main thread.** With R1 done, what
remains to stringify is ~4.5 kB. Without R1, hand the entity tree to Rust
and let it serialize and write atomically (`write_binary_file_raw_atomic`
and its `ReplaceFileW` path already exist). Do R1 and this mostly
evaporates.

**R3 — Foliage scatter, tree growth, terrain meshing.** `foliageScatter.js`
(204 lines), `treeGrowth.js` (259), `TerrainComponent.js` (1 525) generate
the very data R1 makes binary. Generating it in Rust makes scatter and
sculpt *interactive* rather than a rebuild, and it is embarrassingly
parallel (rayon). Natural follow-on to R1, not a prerequisite.

**R4 — The SAH BVH8 builder.** 375 ms here; seconds on Bistro/Sponza.
⚠ **Do B5 first** — a 4 388 ms cache miss dwarfs a 376 ms build, and
`bvhBlasWorker.js` already moved this off the main thread, so Rust buys
throughput, not latency. Real, but fourth.

**R5 — `.geom` decode and merge/batching geometry.** Currently main-thread
(`geometryAsset.js:377-441`). Rust can decode, weld and build merged
buffers, returning one aligned IPC buffer the engine views directly.

**R6 — Asset catalog.** 3 650 assets. The *walk* is already Rust
(`list_dir_recursive`); the `.meta` reads are still per-file IPC
(`assetFlags.js`). One batched command in the shape of `read_text_files`
closes it. Small, cheap, do it opportunistically.

**Not worth it:** anything per-frame; anything that must hand JS live
object graphs; texture transcode (already in three's worker pools);
meshoptimizer simplify (already WASM).

---

## 4. ORDER OF WORK

1. **B1 restart + confirm.** ✅ shipped. Restart the editor and re-read
   `profile.freezes` — `Foliage · living surface` node builds must stop
   climbing while idle, and the `[Invalid PipelineLayout]` pair must be
   gone. *(This alone may take a large bite out of the 165 s; measure
   before doing anything else.)*
2. **Cut foliage's fragment below 16 samplers.** The portable half of B1.
3. **B2(b) — WGSL stability on the eight named modules.** Dump two boots
   with `profile.wgsl`, diff, kill the moving literals. Biggest yield per
   hour in the document.
4. **B2(c) — queue-order A/B.** One-line move of `early`, re-read
   `[gi] render pipelines … slowest`. An afternoon.
5. **B5 — the 4 388 ms cache miss.**
6. **B4 free half** — stop reading the scene twice.
7. **R1 — binary placements.** Then R2/R3 follow naturally.
8. **B2(a) — deferred specular, materials out of the GI consumer.** The
   big one, and the one `ZERO_FREEZE_PLAN` Stage 2 already specifies.

Gate every step on `profile.boot` + `profile.freezes` from a real boot of
`Complex.scene`, and quote `[gi] compile wave: … ms` — that one line is the
whole complaint.

---

## 5. LEDGER

### 2026-09-12 — B1 SHIPPED: the limit nobody asked for

`sceneSettings.js` now requests `maxSampledTexturesPerShaderStage`
(adapter-clamped to 32). `tests/renderer-limits.test.mjs` +
`npm run test:renderer-limits`, 6 tests, green. Documented in `AGENTS.md`.
Needs a restart to take effect. Before: `Foliage · living surface` 52 node
builds and climbing on an idle editor, WGSL modules 338 → 375 and climbing,
two `[Invalid …Layout]` cascades. After: unmeasured — **re-read
`profile.freezes` on the next boot and record it here.**

---

## 6. ⭐⭐⭐ WHY THE SHADER CACHE NEVER HITS — SOLVED 2026-09-12

### 6.0 The user's question: "Chrome compiles all that WGSL a lot faster"

It does, and **not because Chrome's compiler is faster.** Same Dawn, same
Tint, same NVIDIA driver, same machine. Three measurements settle it:

| claim | measurement | verdict |
|---|---|---|
| the compiler backend is slow (FXC vs DXC) | `probe:wgsl-compile`, same kernel: default **11.4 s**, `use_dxc` **12.3 s** (`GI_SRC_REBUILD_PLAN` §13.14.8) | ⛔ **dead.** 8 %, and `use_dxc` is the SLOWER arm — yet it is in our shipped `additionalBrowserArgs`. |
| the disk cache is too small | flags already set: `--gpu-disk-cache-size-mb=1024`, `--gpu-program-cache-size-kb=262144`. Measured **`DawnWebGPUCache` = 17 MB / 54 entries** against a 1 GB cap, while ONE boot creates **167 pipelines / 6.2 MB of WGSL** | ⛔ **dead.** The cache is not evicting. It is not *filling*. |
| the cache KEY misses | warm vs cold on byte-identical text: **19 082 ms → 9 ms** (harness, persistent profile) | ⭐ **this is the entire gap.** |

So: Chromium keys Dawn's cache on the **WGSL source text**. Chrome running
the harness on a fixed scene from a persistent profile regenerates the same
text every launch, hits the cache, and looks instant. **The editor
regenerates DIFFERENT text every boot, so every boot is a cold compile.**
17 MB / 54 entries is the fingerprint of exactly that: each boot writes new
entries that the next boot cannot use.

### 6.1 The literals that move — proven, with the diff

`wgslStable.js` already canonicalises the two identifier families three
derives from process-wide node ids (`NodeBuffer_<id>`, `__range<id>`) and
that rescued 268 of 541 modules this session. What remained was never
identifiers at all.

**The method — no second boot required:** two modules in the SAME boot with
identical byte length and different canonical hashes are one graph rebuilt.
`profile.wgsl` indices 457 and 525, both `compute`, both **204 682 bytes**,
canon `3d9596cd` vs `c8448a9c`. **21 differing lines out of 6 639**, in
three families and nothing else:

```
L3857  atomicLoad( &NodeBuffer_1.value[ 79993120u ] )   vs  [ 79994560u ]
L3866  nodeVar1 = ( 79993121u + ( nodeVar0 * 20u ) )    vs  ( 79994561u + … )
L3909  nodeVar17 = ( nodeVar10 >= 14797600u )           vs  >= 14182720u
L3934  nodeVar20 = ( nodeVar10 >= 33756960u )           vs  >= 35678400u
L3959  nodeVar23 = ( nodeVar10 >= 55028000u )           vs  >= 56063680u
L5285…L6452  (x16)   … + 0.5 ) / 1448.0 )               vs  / 1392.0
```

Three literal families, two source families:

1. **The tile-atlas dimensions** — `srcTiles.js:659-660`:
   ```js
   const uv = vec2(
     bx.mul(tileSize).add(u).add(0.5).div(layout.width),
     by.mul(tileSize).add(v).add(0.5).div(layout.height),
   ).toVar();
   ```
   `layout` comes from `tileAtlasLayout(blocks, tileSize)` where `blocks =
   info.blockCapacity`. Width clamps to 4096 and is stable; **height is
   `rows * tileSize` and moves with the pool** — 1448 / 1392 here, 1264 at
   boot (`4096x1264 tile atlas (80896 x 8²)`). Sixteen occurrences per
   kernel.
2. **The cascade bin partition** — `srcDeposit.js:1116` and `:1916`,
   `srcMerge.js:520/599/693/877`, `srcSeed.js:429/444/467/487`. The source
   says it out loud: *"The cascades partition `binTotal` at bases known when
   the graph is built, so this is a chain of at most four comparisons
   against **JS constants**"* — `lo = info.binBase`, `hi = lo + info.bins *
   info.blockCapacity`.
3. **The slot bases** — `srcDeposit.js:1540`, `:1732`: `uint(infoC.binBase)
   .add(…)`.

All three derive from the SRC pool capacities, and the boot log shows those
are *measured*, not fixed:

```
[gi] src pools restored from this scene's measured demand: c0Probes 131072,
     blocks 80896/19456/4608/1280 (10.06M bins; peaks 39952/12636/3564/970)
```

**So the capacities adapt to what the last session measured, which changes
the kernel text, which guarantees a cold compile.** The feature that was
built to skip the grow ladder is what keeps the shader cache cold. That
same mechanism is why *"a pool grow = 68-kernel recompile, 73 s"*
([[gi-probe-memory-ledger-0903]]) and *"a GI resize = ~56 fresh pipelines"*
(`GISystem.js:12251`) — one root cause, three reported symptoms.

### 6.2 THE UNIT — capacities as uniforms (was §3.1, now fully specified)

Replace every baked capacity with a uniform read. One small uniform block:

| uniform | replaces | sites |
|---|---|---|
| `srcAtlasRcp` (vec2, `1/width`, `1/height`) | `div(layout.width)`, `div(layout.height)` | `srcTiles.js:659-660` |
| `srcBinBase[4]` (uvec4) | `uint(info.binBase)`, `uint(infoC.binBase)` | `srcDeposit.js:1116,1540,1732,1916`, `srcMerge.js:520,599,693,877`, `srcSeed.js:429,444,467,487` |
| `srcBinHi[4]` (uvec4) | `lo + info.bins * info.blockCapacity` | `srcDeposit.js:1116,1916` |
| `srcBlockBase[4]` (uvec4) | `info.blockBase` in the same chains | same |

Notes for whoever takes it:
- The atlas one is a *speedup* as well: a multiply by a reciprocal uniform
  replaces a divide by a literal.
- The `lo`/`hi` chain becomes a uniform compare — the loop shape is
  unchanged, four comparisons either way.
- ⛔ Keep the JS-side `Number.isInteger(base)` guard at
  `srcDeposit.js:1128`. With literals, a NaN was a compile error; with
  uniforms it becomes a silent read of the probe free stack. The guard is
  the only thing that still catches it.
- **⛔⛔ DO NOT SHIP THIS IN HALVES.** The cache key is the whole module
  text. Fixing the atlas divisor alone leaves the bin bases moving, the hash
  still misses, and the measured benefit is **exactly zero**. All four
  uniforms land together or the unit has not shipped.
- Receipt: two consecutive boots, `profile.freezes.wgsl` →
  `canonicalHitsFromLastBoot` must reach ~100 % for the `compute` labels and
  `stillUnstable` must lose every `compute` row; then
  `[gi] compile wave: … ms` on the second boot is the number that matters.

> **✅ SHIPPED 2026-09-13 — every SRC kernel, not just the four families.**
> The capacity values now flow through uniforms (`srcCapacityUniforms.js`:
> `binPartitionUniforms` / `blockChainUniforms` / `probeRegionUniforms` /
> `valuesUniform` / `scalarUniform`, all f32-exactness-guarded at factory
> time), at every site that addresses the bin store, the block chains
> (live/stamp/held/stack/influx/surprise), the probe and hash regions, the
> corner records, and the tile atlas (rcp multiply — `srcTiles`' sampleTile,
> so the gather family is covered too). Files touched: srcDeposit, srcMerge,
> srcSeed, srcTiles, srcRays, srcProbes, srcGizmos. The guards the unit
> demanded stay (srcDeposit's `Number.isInteger` chain checks run on the JS
> sums); the known residual literal is `statB` in srcRays' surprise publish
> (a `statBase + BSTAT_WORDS·blockBase` chain — moves only with a
> probe-pool grow, on a niche path).
>
> Receipt machine: `npm run test:gi-src-wgsl-stability` — builds the whole
> chain in one page under two off-rung pool vectors (blocks AND c0Probes
> both varied) and diffs the module text after `canonicalizeWgsl`.
> Before the unit: **21 of 44 modules differed** (the 111 kB deposit kernels
> among them, matching the audit); after: **42/42 byte-identical**. The
> numerics gates all still pass against their CPU mirrors
> (`test:gi-src-deposit`, `test:gi-src-merge`, `test:gi-src-tiles` — border
> texels still bit-exact under the rcp multiply — `test:gi-src-rays`,
> `test:gi-src-probes`, `test:gi-src-priority-packets`). The two-boot
> `profile.freezes.wgsl` receipt above is still owed by the next real boots;
> note the FIRST boot after this change is necessarily cold (the uniform
> declarations change every module's text once).

### 6.3 THE FRAGMENTS ARE A DIFFERENT PROBLEM — a clean negative

`fragment_Foliage · living surface` (64.5 kB x3) is also in `stillUnstable`,
but it is **not** this mechanism. Scanned module 227:

- capacity literals (`/1448.0`, `/1392.0`, `/1264.0`, `/4096.0`): **zero**
- uint literals of 6+ digits: **zero**
- identifier families whose max ordinal exceeds their count (the signature
  of a process-wide id): **none** — `nodeVar` 376 distinct / max 479,
  `nodeUniform` 122 / 130, both ordinary per-module ordinals with gaps
- long-decimal floats: all mathematical constants (`0.3183098861837907` =
  1/π, `0.1111111111111111` = 1/9, `3.141592653589793`), nothing
  scene-derived

**Hypothesis (untested):** the fragment "instability" is a *consequence of
B1*, not an independent cause. The previous boot recorded 635 modules and
this one 541 while the scene did not change, because the failing foliage
pipeline makes three re-mint variants endlessly — so the two boots simply
do not contain the same set of material variants, and a variant that only
existed last boot reads as "unstable" this boot. **Test: fix B1, restart
twice, and see whether the `fragment_*` rows leave `stillUnstable` on their
own.** Do that before specifying any fragment-side unit.

### 6.4 WHAT IS *NOT* THE PROBLEM — for the next person who is offered advice

Checked, measured, and already done. None of these is the cause:

- **"Use `createRenderPipelineAsync` instead of `createRenderPipeline`."**
  Already the default (`asyncRenderPipelines.js`); the ledger prints
  `[async]` per pipeline and `syncPipelines` exists to catch the rest. And
  it is **not sufficient**: a *synchronous* create returns in 0.1 ms but
  parks the GPU process's command thread, so the main thread blocks later,
  in a task with no GPU call in it ([[zero-freeze-gpu-stall-standins-0910]]).
  Async fixed the shape of the freeze, not its cause.
- **"Cache and reuse pipelines; don't recreate them in the render loop."**
  The caches exist (`giComputePipelineCache.js`, three's program/pipeline
  caches, `nodeBuilderCache`). We *are* recreating in the loop — because a
  pipeline that FAILS (B1) is never cached, and a cache KEY that moves
  (§6.1) can never hit. The advice names the symptom; §6.1 and B1 are the
  causes.
- **"WebView2's Dawn can lag on complex WGSL layout parsing."** Testable and
  tested: DXC vs default, 12.3 s vs 11.4 s. Not it.
- **Rust `[profile.dev] opt-level`, `mold`/`lld`, stripping `wgpu`
  backends, `include_str!` shaders.** ⛔ **Inapplicable — our Rust side has
  no GPU crates at all.** `src-tauri/Cargo.toml` is tauri, serde,
  libloading, ureq, url, portable-pty, base64, zip, walkdir, notify,
  rustls, rcgen, windows-sys. No `wgpu`, no `naga`, no embedded WGSL. Every
  shader is compiled by the WebView2 GPU process at runtime; no Cargo
  profile can touch it. Worse, the suggested `[profile.dev.package."*"]
  opt-level = 3` would *conflict* with the deliberate `debug = false`
  tuning already in that file (added to cut ~590 MB and shorten the
  per-restart link) and would make `tauri dev` restarts slower for zero
  runtime gain.
- One loose end worth an A/B, though it is small: **`--enable-dawn-features=
  use_dxc`** is still in `additionalBrowserArgs` even though it measured as
  the SLOWER arm (12.3 s vs 11.4 s). ⚠ Do not just delete it — FXC has hard
  limits that large shaders hit, and whoever added it may have been fixing a
  compile failure rather than chasing speed. Measure the wave with and
  without on a real boot, and check the console for compile errors in the
  without-arm, before changing the shipped config.

### 2026-09-12 — ⭐⭐⭐ SHIPPED: THE CAPACITY LADDER (§6.2, the low-risk form)

The unit specified in §6.2 was **not** implemented as 15 TSL edits. Tracing
every baked literal back to its source showed all three families —
`binBase`, the `lo`/`hi` cascade partition, the slot bases, and the tile
atlas's height through `tileAtlasLayout(info.blockCapacity, …)` — derive
from **one input**: `blockCapacity` per cascade. So the fix is upstream of
the shaders, in plain JS, and the TSL is untouched.

**What shipped** (`srcConfig.js`, `GISystem.js`):
- `snapBlockCapacity(blocks, cascade, {down})` — a geometric ladder,
  `BLOCK_RUNGS_PER_OCTAVE = 4`, so a capacity can only ever be one of four
  values per octave and the overshoot is bounded at 25 %.
- Applied **last** in `blockVectorFromPeaks`, after the floor, the
  carried-forward `current`, the headroom and the slot cap have all had
  their say — the pre-existing `quantum` (1024 >> cascade) only ever shaped
  `grown`, and the other four exits bypassed it.
- `{down: true}` in the device-ceiling rescale, which must floor to a rung:
  rounding up there would re-cross the limit the rescale exists to enforce.
- Snapped on **restore** too (`#srcPoolsForBuild`), so an existing project's
  persisted off-ladder record heals on its next boot with no migration.

**Why the ladder rather than uniforms.** Uniforms would touch ~15 sites in
`srcDeposit` / `srcMerge` / `srcSeed` / `srcTiles` — the bin ADDRESSING of
the most delicate subsystem in the engine — and turn a NaN that used to be
a compile error into a silent read of the probe free stack
(`srcDeposit.js:1128`'s guard). The ladder is a pure JS change with no GPU
behaviour change at all, and it fixes a second thing uniforms would not: a
pool GROW also lands on a rung, so the set of kernel texts a scene can ever
produce is small enough for the disk cache to hold all of them.

**Receipt on the live scene's own numbers** (`blocks 80896/19456/4608/1280`,
`peaks 39952/12636/3564/970`):

| | vector | bins |
|---|---|---|
| persisted, off-ladder | 80896/19456/4608/1280 | 10.06 M |
| restored → snapped | **81920/20480/5120/1280** | 10.49 M |
| after the grow ladder | **81920/20480/5120/1280** (unchanged — a fixed point) | 10.49 M |

**+4.2 % bin memory.** The two capacities that produced two different
204 682-byte kernels inside one session (89 088 and 92 672) now both snap to
**98 304 — one text**. Distinct cascade-0 capacities reachable in one
octave: **4, down from ~64**.

`npm run test:gi-capacity-ladder`, 11 tests, green. `tests/gi-component-levels.test.mjs`
has one failure (`SRC_QUALITY.ultra.probeRayCap > …high`) that is **not
ours** — it fails identically with these edits stashed; it belongs to
another session's uncommitted work.

⚠ **THE FIRST BOOT AFTER THIS IS STILL COLD, BY CONSTRUCTION.** The text
moved once, deliberately (80896 → 81920). The receipt is the **SECOND**
boot: `profile.freezes.wgsl` → `canonicalHitsFromLastBoot` should approach
the module count and `stillUnstable` should lose every `compute` row, and
then `[gi] compile wave: … ms` is the number that matters. Record both here.

**Still owed on this line:** §6.3's fragment question (a clean negative so
far — the fragments carry none of these literals; the hypothesis is that
their instability is B1's re-mint churn and will resolve on its own once B1
is verified live).

### 2026-09-12 — FIRST BOOT AFTER THE FIXES: the freeze half won, the wave did not

Live boot, same scene. **Measured, not claimed:**

| | before | after |
|---|---|---|
| main thread blocked | 41 506 ms / 42 tasks | **12 243 ms / 19 tasks** |
| worst single block | 17 093 ms | **6 544 ms** |
| "Editor ready" | 4 340 ms | **3 983 ms** |
| static-BVH cache preflight | 4 388 ms | **869 ms** |
| scene file reads | 2 (15.5 MB each) | **1** (`scene: reuse boot parse`, 0 ms) |
| pipeline-creation failures | 3 cascading | **1** |
| GI rebuilds this session | — | **1** (`component-attached`; no pool-grow storm) |

`maxSampledTexturesPerShaderStage: 32` is in the limits ask and the foliage
failure is gone. GI runs: 80 dispatches a frame, the whole SRC chain.

**⛔ THE COMPILE WAVE DID NOT IMPROVE — still running past 80 s**
(`124 async / 3956 kB still compiling`), and `stillUnstable` still lists the
three 111 kB compute modules. `canonicalHitsFromLastBoot` 171 of 274.

**Why — and the prediction that was wrong.** The previous entry said "the
SECOND boot is the receipt". That was incomplete: the ladder snaps the
capacity VECTOR, but its INPUT kept moving. The persisted peaks went
`39952/12636/3564/970` → **`107081/33452/13482/2684`** in one session, so the
vector climbed a rung (10.06 M → 14.68 M bins, 368 → 510 MB) and the kernel
text changed again.

### 2026-09-12 — ⛔⛔ AND THE BUG THAT FOUND: AT THE CEILING THE VECTOR NEVER SETTLES

Chasing the moving peaks turned up something worse than "not converged yet".
`blockVectorFromPeaks`' own header warns:

> ⛔ THIS IS NOT §10.8's DEAD END. That proposal re-split a FIXED total by a
> parked SNAPSHOT of demand — which moves budget away from cascade 0.

**The device-ceiling rescale is that dead end, reached from the other side.**
A ceiling-clamped pool can never satisfy anybody, so `noBlock` stays high
every frame and `peaks` — a running max of `live + noBlock`, persisted across
sessions — climbs without bound. Each climb re-splits the same fixed ceiling
by a different ratio. Simulated from the live numbers, four sessions at
+50 % peak against the 16 M-bin ceiling:

```
65536/28672/10240/1792 → 49152/24576/10240/2048
                       → 40960/20480/10240/2560
                       → 32768/16384/ 8192/3584
```

**Cascade 0 — the lattice the screen reads — HALVES**, while cascade 3
(2048 bins per block against c0's 32) doubles on demand nobody can see. And
every step is a fresh set of baked literals: ~70 kernels recompiled and a
field re-converging from black, for a pool that did not get bigger. This is
a runaway, not a convergence — it would never have settled.

**FIXED:** the rescale now LATCHES. If we already hold a vector that fits the
ceiling and the slot vector, keep it — at the ceiling there is no growth to be
had and stability is worth more than a re-split the header already argues is
the wrong shape. A genuinely smaller ceiling (another device, a smaller
binding) fails the `bins(held)` test and rescales normally; a shrunken `slots`
vector fails the per-cascade test. Verified: six sessions of +50 % peaks leave
`65536/28672/10240/1792` untouched.

`npm run test:gi-capacity-ladder` is now **15 tests, green** (the latch, the
cascade-0 starvation shape, yielding to a smaller ceiling, yielding to
shrunken slots). Full `tests/gi-*`: 239 pass / 5 fail, the **same 5** that
fail with these edits stashed.

**STILL OWED / STILL OPEN:**
1. One more boot to see whether the capacities finally hold and
   `stillUnstable` loses its `compute` rows. The vector should now be pinned.
2. **The wave's SIZE is untouched** — 6.2 MB of WGSL, 77 compute pipelines
   created in ONE 6 544 ms task (`sync gpu: 26r/77c/105m, 2574kB WGSL`), 65
   passes / 14 groups. Even a perfect cache pays this the first time a rung is
   seen. §2 B2(a) (deferred specular) and the kernel COUNT are the remaining
   levers, and they are the big ones.
3. One `[Invalid PipelineLayout]` on `MeshStandardNodeMaterial_141` remains,
   with no primary error logged — Dawn reported only the cascade. Find what
   fails first.
4. `giTiers.pendingMaterials 16 / pendingMeshes 29` — the §16 R4b tier drain
   is still stuck (a pre-existing OPEN item).


### 2026-09-12 — THE WAVE CENSUS: FOLIAGE IS HALF OF IT

`profile.wgsl`, 336 modules / 5 082 kB, one boot:

| stage | kB | modules | share |
|---|---|---|---|
| **vertex** | 1 948 | 181 | **38 %** |
| fragment | 1 635 | 77 | 32 % |
| compute (GI kernels) | 1 498 | 77 | 29 % |

By owner:

| owner | kB | modules | distinct | share |
|---|---|---|---|---|
| **Foliage · living surface** | **1 897** | 50 | **30** | **37 %** |
| (GI compute) | 1 498 | 77 | 72 | 29 % |
| GI gbuffer · Foliage | 473 | 19 | 12 | 9 % |
| Foliage · surface | 167 | 24 | 6 | 3 % |
| World landscape · natural layered stone | 143 | 4 | 4 | 3 % |
| selectionOutlineMask (both) | 157 | 67 | 23 | 3 % |

**Foliage, all stages: 2 597 kB = 51 % of the boot's WGSL.** Vertex being the
largest stage at all is the tell — a 28–37 kB VERTEX shader is the wind/LOD
graph, minted per component.

**WHY: one material per component.** `FoliageComponent.js:136` does
`this.uniforms = createFoliageUniforms()` and `:279`
`this.material ??= createFoliageMaterial(this.uniforms, this.props)` — **per
component instance**. This scene has ELEVEN foliage components. three keys
programs on node IDENTITY (`Node.customCacheKey() → this.id`), so eleven
structurally identical materials compile eleven separate programs, ×(vertex +
fragment) ×(main + GI gbuffer + shadow). Exactly the trap
`ZERO_FREEZE_PLAN` §2.5.1 documents.

The good news is that the graph shape barely varies. `foliageAnimatedPosition`
(`foliageWind.js:235`) branches only on JS booleans — `props.species` being
grass/wildflowers (`meadow`), `treeMotion`, and
`builder.geometry.hasAttribute(...)`. Everything else — strength, direction,
time, speed, interaction, colliders, radius — is already a UNIFORM, not a baked
literal. `createFoliageSurfaceMaterial` adds `props.species` (textures) and one
`leafRoughness` literal (3 values).

**NEXT UNIT (not yet built): share the foliage material by shape key.** Cache on
`(species, meadow, treeMotion, geometry-attribute set, leafRoughness)` PLUS the
wind/interaction props, because `updateFoliageUniforms` writes per-component
`props.windStrength / windGustStrength / windScale / windTurbulence /
interaction / interactionStrength / interactionRadius` into the shared uniform
object — components with different wind tuning must keep their own material or
the last writer would win. Components with matching props share one. On this
scene that should collapse 11 → ~5–6. The fuller fix (one material per species,
per-component scalars moved to an instanced attribute) removes the props
condition entirely and is the real destination.

### 2026-09-12 — SHIPPED: MODULE INTERNING BY CANONICAL TEXT

**129 of 336 modules were redundant — 1 148 kB, 23 % of the boot's WGSL**, handed
to the GPU process that is the boot's bottleneck. three interns its programs on
the text IT generated; `canonicalizeWgsl` runs later, at `createShaderModule`.
So two graphs differing only in `NodeBuffer_<node.id>` naming are two programs
to three and one identical blob to the driver. Worst: `vertex_Foliage · living
surface` ×4, `fragment_Foliage · surface` ×5.

`WgslRegistry.intern` now returns the same `GPUShaderModule` for byte-identical
canonical source (immutable, may back any number of pipelines — the same thing
three does one level up). Keyed by canonical hash AND length, with the stored
source COMPARED before reuse, so a hash collision can never hand the driver the
wrong shader. Per registry, and the registry is per device, so a lost device
cannot serve a dead module. `profile.freezes.wgsl` gains
`internedDuplicates` / `internedKB`. Hatch: `__wgslInternModules = false`.
`npm run test:wgsl-intern`, 6 tests, green. GI suite unchanged at 239 pass /
the same 5 pre-existing fails.

⚠ Honest bound on this one: it removes module PARSING, not pipeline COMPILATION,
and the driver's per-pipeline work is the larger half. Expect a useful dent, not
a fix.

### 2026-09-12 — ⛔ A LEVER THAT LOOKS OBVIOUS AND IS REFUTED

`Foliage · living surface` carries `roughness: .88, metalness: 0` and its
`roughnessNode` is provably ≥ 0.64 (`select(leafSample.r.oneMinus().mul(.12)
.add(leafRoughness), .96)`), yet it sits in GI bucket 3 — dynamic-roughness, the
most expensive shader — because `giRoughnessSourceOf` only recognises
`texture × const` and returns null for anything else ("21 walk-blind" in the
R4b census). Demoting it by a provable roughness bound is the obvious 78 kB win.

**Do not.** `giRoughnessBucketOf` gates exactly that behind
`__giRoughnessFloorClassify === true`, and its comment records the refutation:
twice in one night, by the user's eyes plus two A/B boots on Sponza — floor →
bucket 2 turned shadowed walls near-black, floor → bucket 1 was still murky,
because the missing energy is the canMirror block's HIT-SHADED EXACT RADIANCE
(at grazing angles Fresnel drives rough-surface specular high). *"The 22.7 ms is
real lighting, not waste. The perf lever is making the prepass CHEAPER for rough
pixels, not removing them."* Bucket-3 membership is load-bearing for the look.

Also checked and NOT available: the postprocess second render context (§2.5.3's
"every program compiles twice") — the Main Camera carries no Postprocess
component in this scene, so that 2× is already off.


### 2026-09-12 — SHIPPED: ONE FOLIAGE MATERIAL PER SHADER, NOT PER COMPONENT

The census said foliage was **51 % of the boot's WGSL**. The cause was one line
of lifecycle: `FoliageComponent` called `createFoliageUniforms()` +
`createFoliageMaterial()` **per instance**, and three keys programs on node
IDENTITY, so eleven components compiled eleven copies of one shader — in vertex
AND fragment, again for the GI g-buffer and the shadow pass.

**The key is short, and that is the finding.** `foliageAnimatedPosition`
(`foliageWind.js:235`) reads exactly ONE prop — `props.species`, via `meadow`.
Every other branch comes from `builder.geometry.hasAttribute(...)`, which three
already keys on, so components sharing a material but carrying different
geometry still get the programs they need. `createFoliageSurfaceMaterial` reads
species for its textures and one `leafRoughness` literal. Strength, direction,
time, speed, interaction, colliders and radius were already uniforms.

So the bucket key is `species` + every prop `updateFoliageUniforms` /
`updateFoliageInteractions` WRITE into the uniforms (`wind`, `windStrength`,
`windGustStrength`, `windScale`, `windTurbulence`, `interaction`,
`interactionStrength`, `interactionRadius`) — sharing a material means sharing
its uniforms, and two holders write them every frame, so they must write the
same numbers or the last writer would silently win. (The interaction field is
already engine-global — `foliageInteraction.js` — so `props.interaction` is its
only per-component input.)

**RECEIPT on the user's own scene, from the scene file's real props:**

```
foliage components: 11
material buckets  : 5     <-- was 11
   [oak        ] x3  oak-wide, oak-elder, hazel-study
   [birch      ] x2  birch-tall, young-growth
   [pine       ] x1  pine-tall
   [grass      ] x4  meadow-short, meadow-long, bank-rushes, woodland-floor
   [wildflowers] x1  meadow-flowers
```

Refcounted like `releaseAtlas`; ⚠ `_rebuildShape` ACQUIRES BEFORE RELEASING, or
a rebuild landing on the same key would drop the count to zero and dispose the
material it is about to reuse. `onDetach` releases rather than disposes.
Hatch `__foliageShareMaterials = false`. `npm run test:foliage` now 91 green
(8 new in `tests/foliage-material-sharing.test.mjs`).

⭐ This is the stronger of the two dedup fixes: module interning removed shader
PARSES, but two materials still produced two programs, two stages and two
PIPELINES. One material is one pipeline — and pipeline compilation is the half
that owns the wave.

**⚠ THE WORLD SUITE IS FLAKY — do not read a regression into it.** Identical
command, identical tree, five runs with these changes IN: **102/6, 106/2,
107/1, 108/0, 108/0** — it reaches FULLY GREEN twice. The failing test
NAMES change between runs (basins, river mouths, house pads, lanes). Isolate
with `__foliageShareMaterials=false` + `__wgslInternModules=false` via
`--import` if you need a clean arm, and run it more than once before believing
it. `test:foliage` (91) and `tests/gi-*` (239 pass / the same 5 pre-existing
fails) are stable.

### 2026-09-12 — WHY THE WATER MODULE DOES NOT MAKE THE WORLD'S WATER

Asked by the user. It is not an oversight and not a bug — it is a planned
integration that has not happened, with a named blocker.

`src/modules/world/worldWaterSurface.js` is the World module's OWN surface, and
its header says what it is: *"Phase 0 pond/river appearance… There is no local
geometry reflection capture, underwater view or physical light transport
here."* Its material is `World study · depth and reflective water` — the "study"
in the name is literal.

`docs/WORLD_PLAN.md` §"Water and hydrology" already calls for the opposite:
*"Reuse Water's shading and interaction where compatible, adding a common
arbitrary-domain query used by rendering, buoyancy, underwater effects,
shoreline foam and GI. CPU and GPU must agree about the same water body."* And
it names the blocker: *"Replace the assumption of a slot per independent
primitive with stable shared domain/field resources… **The two-slot limitation
must be resolved or explicitly bounded before accepting a world with multiple
water bodies; silently losing underwater/caustic behavior is a failure.**"*

So the Water module's per-primitive slot architecture is what stands between the
two. A valley with a lake plus several river reaches is many bodies; Water
assumes few.

**And the placeholder is not cheap.** In the first boot measured today,
`gi:wave/material World study · depth and reflective water` was one of the two
blocks that froze the main thread — **13 838 ms** — and the material is 71-75 kB
and sits in `stillUnstable`. Doing the real integration would replace a
placeholder that costs a quarter of the boot's worst freezes, so this is a
performance unit as well as a fidelity one.


### 2026-09-12 — ⛔⛔ RETRACTED: "323-484 MB PER FRAME" WAS AN INSTRUMENT ARTEFACT

A boot with **GI disabled by the user** still blocked 14 707 ms, and three
blocks during camera motion read:

```
editor:zoomProbe 48 ms  —  323,623,592 bytes in  64,715 writeBuffer calls
editor:zoomProbe 50 ms  —  484,087,544 bytes in 123,097 writeBuffer calls
```

Half a gigabyte in a 60 ms task reads as a catastrophic per-frame upload. It is
not. `FreezeLedger.gpu` is reset **only inside `recordTask`** — a
PerformanceObserver reports tasks over 50 ms, so nothing resets the counters at
the start of an ordinary one. Those numbers therefore cover everything **since
the previous long task**: seven seconds of ordinary 60 fps rendering, i.e.
**~293 writeBuffer calls and ~1.15 MB per frame**, which is unremarkable.

⚠ The same artefact is very likely behind the older "667.5 MB written in
143 454 write(s)" reading (B6 in §2) — that item should be considered
unsubstantiated rather than open.

**FIXED so it cannot mislead again:** `recordTask` now records `gpu.windowMs`
(the span the counters actually cover), the `[freeze]` console line says
"over the last Ns", and `profile.freezes`' note leads with "⚠ `gpu` is NOT the
block's own work — DIVIDE BY `windowMs`". The rule this belongs to is already
in the house: *before believing any number, ask whether the instrument can see
its subject* — including when the number is enormous, not only when it is zero.

### 2026-09-12 — SHIPPED: THE IMPOSTOR BAKE'S SOURCE MATERIAL, SHARED PER SPECIES

With GI off, the remaining duplication was stark: **`Foliage · surface` 44
modules for 6 distinct texts, `Impostor normal` 44 for 4** — ~80 redundant
programs, and programs are pipelines, which is the expensive half.

Both came from ONE call. `acquireAtlas` (`FoliageComponent.js`) caches the baked
ATLAS on a twelve-prop key (seed, height, colours, densities — correct, those
change the picture) but minted a fresh `createFoliageSurfaceMaterial(props)` for
every entry, and that function reads exactly one prop: `props.species`. It cost
double, because `impostorBake.js` memoises its normal-pass material PER SOURCE
MATERIAL (`normalMaterials.set(sourceMaterial, …)`) — a fresh source defeats
that memo too, which is why the two counts are identical.

`acquireFoliageSurfaceMaterial` / `releaseFoliageSurfaceMaterial` key it on
species and refcount it; the bake releases instead of disposing (bakes are
queued per renderer, so two species-mates overlap and an early dispose would
pull the shader out from under the second). `foliageMaterialSharing()` reports
`bakeBuckets`/`bakeHolders`. `npm run test:foliage` 93 green.

**Owed:** every number in this section is from a GI-OFF boot, because the user
disabled the GI component to make the editor usable. The wave work (capacity
ladder, module interning, material sharing) still has no GI receipt.
