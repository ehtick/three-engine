# GI — Next Architecture

*Where radiance is STORED, not what rays HIT. Plus the hardware-ray-tracing question, answered.*

*Written 2026-08-07, after the block-size sweep, and updated the same day once Phase 0 ran.
Supersedes the "voxelSize sets the block size" hypothesis in the session-34/35 handoffs — **that
hypothesis is now falsified by measurement** (§1). This document is the plan; `GI_PLAN.md`,
`GI_SHADOWS_PLAN.md` and `dynamic_gi_exact_dynamic_objects.md` remain the history of what got us
here.*

---

## 0. TL;DR

Three claims, each backed by a number in §1:

1. **The blockiness is not the voxels.** A 5× sweep of `voxelSize` moves the measured block size
   by 2%. A 3.2× sweep of `probeSpacing` moves it 1.39×. The voxel grid is innocent of *this*
   artifact; the c0 probe lattice and the cascade merge are not. **The post-fix sweep reproduces
   both slopes** — 1.02× and 1.38× (§1.1).
2. **The one `floor()` in the parallax merge was worth a quarter of the amplitude, not two
   thirds, and none of the block scale.** Turning the parallax correction off entirely takes
   modulation 14.71% → 4.58%; the continuous form that replaced the `floor()` landed at
   **10.79%**, i.e. it recovered 3.92 of those 10.13 points — 39%. It is measured, committed and
   shipped. Phase 0's ≤ 8% gate **failed**, and 6.2 points of parallax-added structure are still
   unexplained (§1.2, §4).
3. **What is left after that is a radiance-STORAGE problem, and hardware ray tracing would not
   touch it.** Every current system (Lumen, RTXGI/SHaRC, AMD GI-1.0, Sannikov's own Split
   Radiance Cascades) abandoned dense world-grid radiance storage. We should too. That is
   Phase 2, and it is the structural work in this document.

Hardware RT: **not reachable, not soon, and not the fix** (§2). The Rust backend gets a real but
*offline* job (§9).

---

## 1. The measurements that set the plan

### 1.1 Block size vs. the two lattices

`npm run probe:gi-block-size` — emissive panel over an open floor, `autoFit` OFF (the trap that
voided every earlier attempt: under `autoFit` **both** `voxelSize` and `probeSpacing` are inert,
and editing an advanced field flips `quality` → "custom" → "high", which coarsens *both* lattices
at once — that is almost certainly what the qualitative "bigger voxels → bigger spots" observation
actually measured). Block size = 2 × the lag where the detrended residual's autocorrelation
crosses ½, in metres. Raw data: `.gi-shots/block-size/block-size.json`.

**Pre-fix** — the snap parallax merge (§1.2):

| dial  | voxelSize | probeSpacing | **blockX (m)** | blockZ (m) | modulation | flicker RMS |
|-------|-----------|--------------|----------------|------------|------------|-------------|
| voxel | 0.10      | 0.375        | **0.2716**     | 0.5317     | 14.9%      | 0           |
| voxel | 0.15      | 0.375        | **0.2716**     | 0.5346     | 14.7%      | 0           |
| voxel | 0.225     | 0.375        | **0.2701**     | 0.5154     | 14.8%      | 0           |
| voxel | 0.34      | 0.375        | **0.2702**     | 0.5238     | 16.0%      | 0           |
| voxel | 0.50      | 0.375        | **0.2662**     | 0.5282     | 19.6%      | 0           |
| probe | 0.15      | 0.25         | **0.2369**     | 0.5015     | 10.0%      | 6.1e-5      |
| probe | 0.15      | 0.375        | **0.2716**     | 0.5346     | 14.7%      | 4.8e-5      |
| probe | 0.15      | 0.55         | **0.3007**     | 0.3776     | 11.2%      | 1.1e-4      |
| probe | 0.15      | 0.80         | **0.3285**     | 0.4756     | 22.3%      | 4.2e-5      |

**Read it:** `voxelSize` × 5 → block size × 0.98. `probeSpacing` × 3.2 → block size × 1.39,
monotonic. The dial was live in both sweeps — the arm-to-arm image `diff.rms` is 0.037…0.276 for
the voxel arms, so the builds *did* change; they changed *brightness and energy*, not block scale.

**Post-fix** — the identical sweep re-run with the continuous parallax merge as the shipped
default (§4's 0.2). Same command, same rig:

| dial  | voxelSize | probeSpacing | **blockX (m)** | modulation |
|-------|-----------|--------------|----------------|------------|
| voxel | 0.10      | 0.375        | **0.268**      | 11.69%     |
| voxel | 0.15      | 0.375        | **0.268**      | 10.79%     |
| voxel | 0.225     | 0.375        | **0.267**      | 10.60%     |
| voxel | 0.34      | 0.375        | **0.267**      | 12.94%     |
| voxel | 0.50      | 0.375        | **0.263**      | 15.77%     |
| probe | 0.15      | 0.25         | **0.231**      | 6.99%      |
| probe | 0.15      | 0.375        | **0.268**      | 10.79%     |
| probe | 0.15      | 0.55         | **0.261**      | 8.03%      |
| probe | 0.15      | 0.80         | **0.318**      | 19.34%     |

**Read it: the fix cut AMPLITUDE by roughly a quarter, uniformly, and left BLOCK SCALE untouched.**
Modulation falls on every arm (14.7 → 10.79 at the shared 0.15/0.375 point, 22.3 → 19.34 at probe
0.80) and the geometry does not move: the voxel dial spans 5.0× → block spans **1.02×**, slope
−0.01, r² 0.82 — the rig's own summary is "the artifact IGNORES this dial". The probe dial spans
3.2× → block spans **1.38×** (was 1.39×), slope 0.14, r² 0.85, intercept **~0.196 m** (was ~0.19).
Both the probe-lattice term and the fixed-width floor survived the fix intact; see §4's 0.2 for
what that does to Phase 1.

Two caveats on this run. The rig warned that **1 arm has clipped pixels in the patch** — the
highest-level arm, probe 0.80 at level 0.3125 — so that arm's residual under-reports. And flicker
read ~0 on every arm, which is what a static rig must read.

Two consequences the plan is built on:

- **Any fix aimed at the voxel cell will not move the block size.** Do not spend a session on
  voxelSize, occupancy resolution, or the trilinear sampler's footprint expecting the blocks to
  shrink.
- **Block size is sub-proportional to probe spacing** — roughly `0.196 + 0.14·spacing` in x
  post-fix, `0.19 + 0.17·spacing` pre-fix. **The parallax fix moved neither term.** The ~0.196 m
  intercept is a *floor* that does not follow either dial. That floor is a separate term
  (candidates: the screen resolve's reconstruction footprint, the bilateral filter width) and it
  needs its own measurement — see Phase 1.

**The z axis is not trustworthy.** z is the depth axis in this framing, heavily foreshortened
(122 px/m nominal but the patch spans a large depth range), and the z column is non-monotonic
(0.50 → 0.53 → 0.38 → 0.48). Quote x. Fix the rig's z geometry or drop the z column before
anyone builds an argument on it.

**Flicker is not in this rig, and `MOVER=1` does not put it there.** Every arm has `adopted: 0`
and a static panel, and a settled frame is deterministic to 1e-4 — a baseline re-run against
itself moves the residual by 0.01% rms. `MOVER=1` turns out **not to move the panel at all**: it
only tags it `giMobility: "dynamic"`, which changes *which path lights it* and nothing about
motion. The user's flicker complaint is about a *rotating* mover and about *emissive* meshes.
**That is still unmeasured**; a rotating arm is being added to the rig separately (§4's 0.3).

### 1.2 The parallax merge's `floor()` — found, fixed, measured

`cascadeMerge.js:383-460`. The parallax correction re-aims a child probe's tap at its parent and
then **snapped the tap to whole texels** (`floor(pu + 0.5) - 1`), so as a child probe slid across
its parent's cell the tap *index* jumped a whole angular bin and the merged radiance stepped with
it. Three-arm ablation on the block rig — emissive, voxelSize 0.15 / probeSpacing 0.375:

- `__giParallaxMerge = false` — correction off entirely: **4.58%**
- `__giParallaxMergeSmooth = false` — the old snap: **14.71%**
- baseline — the continuous form, now the shipped default: **10.79%**

The ablation reproduces both recorded pre-fix numbers exactly, and a baseline re-run against
itself moves 0.01% rms, so the rig is deterministic and these three are comparable.

**Read it:** the parallax correction *adds* 10.13 points of structure over having none, and the
continuous form recovers **3.92 of them — 39%**. The "two thirds" the snap-vs-off gap suggested
was the correction's whole contribution, not the `floor()`'s: the `floor()` was worth about a
quarter of the amplitude, and **6.2 points of parallax-added structure remain**. The fix is real,
measured and shipped, and it misses §4's ≤ 8% gate by 2.8 points.

The continuous form is a separable 3-tap `[(1−f)/2, ½, f/2]` box per axis, same box *width*
(dilution preserved), fractional *centre*; 9 reads instead of 4, in a loop already reading 8
parent probes. Hatch `__giParallaxMergeSmooth = false` restores the snap.

### 1.3 The other measured facts this plan inherits

Established in earlier sessions, do not re-derive:

- **Tracing is not the cost.** 30.6 pops / 19 triangle tests per shadow ray on 262k-tri Sponza;
  `__giShadowStaticBvh=false` saved 19%; `lightShadowPass` 0.204 ms of a 3.68 ms GI queue.
  Traversal caps, slot-mask OOB and rebuild hitching were each suspected and each killed by
  measurement.
- **Small emitters are angularly under-sampled, and no constant fixes it.** Same lamp, same
  place: transport delivers 22% of the analytic path at r = 0.4 m, 66% at r = 1.2 m. A 3× larger
  emitter closes most of the gap ⇒ this is solid angle vs. `c0DirRes`, not calibration.
- **Past-cap emissives deliver ~17% of promoted ones** ⇒ a ~6× light pop every time an object
  crosses the `MAX_EMITTERS = 4` promotion boundary. That pop is worse than the cap.
- **The screen emitter pass is per-ray-traversal bound, not per-pixel** (158k px / 3 emitters =
  10.53 ms in the real editor vs. 158k px / 4 emitters = 0.23 ms in the rig — 60× apart at equal
  pixel count). Resolve scale is the wrong lever for it.
- **An adopted mover contributed zero of its own colour** until the header mean-albedo shipped
  (`dynamicObjects.js` words 34..39). That fix is in the tree and measured (0.0% → 21.8% red
  excess vs. 30.1% on the voxel path).

---

## 2. Hardware ray tracing: the verdict

**Not reachable from this stack, and it would not fix the artifact.**

### 2.1 WebGPU

- [`gpuweb#535`](https://github.com/gpuweb/gpuweb/issues/535) ("Ray Tracing extension") has been
  **open since January 2020, unassigned**. Proposal, not work item.
- **Bindless is the hard prerequisite** — the working group's own framing is "folks really want
  ray and mesh shading but bindless is required for both." Bindless itself is still proposal
  stage.
- Ray tracing: **earliest 2027, "if ever"**. The WG has not committed.
- The two "extensions" that exist are dead ends: `maierfelix/dawn-ray-tracing` (a 2020 Dawn fork
  — requires shipping our own Chromium) and WebRTX (software RT in compute, i.e. what we already
  have, at 10–100× hardware cost).

### 2.2 Tauri specifically

On Windows we run on the **system WebView2 runtime**. We cannot ship a patched Dawn. We *can*
pass `additionalBrowserArgs` (`--enable-unsafe-webgpu --enable-dawn-features=allow_unsafe_apis`),
and Phase 8 wires that up — but a flag can only enable a feature that exists, and this one does
not. Note the known Tauri trap: changing `additional_browser_args` requires changing
`data_directory` if multiple webviews are opened, or the second window comes up blank.

### 2.3 Rust / wgpu

wgpu **does** have it: `Features::EXPERIMENTAL_RAY_QUERY` — inline ray queries plus BLAS/TLAS,
Vulkan first with Metal and DX12 work landed or in flight; ray *pipelines* still WIP; the docs'
own warning is "may have major bugs… expected to be subject to breaking changes."

The blocker is not wgpu, it is the process boundary. The webview's `GPUDevice` is Dawn's, in
Edge's GPU process. There is no shared-texture handoff. Using wgpu RT for the *frame* means
rendering the frame natively — which costs three.js, this entire module, and the web/zip build
target. **Rejected.** What it is good for is offline work — §9.

### 2.4 Why it would not fix the artifact anyway

Separate the two representations. We have been arguing about the wrong one:

| | what it is | ours | measured verdict |
|---|---|---|---|
| **(A) Visibility** | what a ray intersects | occupancy DDA + static BVH8 + analytic movers | not the cost (§1.3), not the block size (§1.1) |
| **(B) Radiance cache** | where light is **stored and read back** | `radianceBuffer`, `giField.js:92`, read via `createTrilinearRadianceSampler`, `voxelizeOnce.js:321` | the residual after §1.2 |

Hardware RT replaces **(A)**. Swap in perfect ray-traced visibility and we still write radiance
into cells of size `voxelSize` and read it back as 8 trilinear taps. Same storage, same
quantization, same temporal churn when a rotating surface changes cell membership.

The clinching outside evidence: **Lumen traces mesh SDFs** — the representation we would call the
worst of the three — and has no voxel-blocky bleed, because its radiance lives in a *surface
cache*, not a grid. Epic kept the "bad" tracing and fixed the caching.

Everyone converged on the same move:

| system | radiance storage | tracing |
|---|---|---|
| **Split Radiance Cascades** (Freeman & Sannikov, arXiv 2607.20384, 22 Jul 2026) | **sparse hashmap** of world-space probes; rays cast *from visible surfaces*, contribution assigned to cascade intervals by hit distance ("ray splitting") | not stated in the abstract |
| **Lumen** (UE5) | **surface cache** — ~6–8 orthographic cards per mesh in a shared atlas, lit on the atlas | mesh SDF + global SDF |
| **SHaRC** (RTXGI 2.0) | **spatial hash**, logarithmic level from camera distance, ~160 MiB at 2²² entries, temporal accumulation + stale eviction | hardware RT |
| **GI-1.0/1.1** (AMD) | screen probes over a **world-space radiance + irradiance cache** | hardware RT |
| **Surfels** (SEED) | radiance on **surface discs** | hardware RT |
| **ours** | **dense uniform world grid, trilinear** | ← the one thing none of them kept |

---

## 3. Target architecture

```
                       ┌─────────────────────────────────────────┐
  GEOMETRY (A)         │ occupancy pyramid  ── empty-space skip   │  unchanged
  "what a ray hits"    │ static BVH8        ── exact triangles    │  unchanged
                       │ per-object OBB / analytic / BVH8         │  unchanged
                       └─────────────────────────────────────────┘
                                        │  hit → (objId, P, N)
                                        ▼
                       ┌─────────────────────────────────────────┐
  RADIANCE (B)         │ SURFACE RADIANCE CACHE                  │  NEW  (Phase 2/4)
  "what light is there"│   card atlas, object-space projection   │
                       │   lit once per texel, not per ray       │
                       └─────────────────────────────────────────┘
                                        ▲
                                        │  lit by
                       ┌─────────────────────────────────────────┐
  LIGHTS               │ analytic slots (sun/point/spot)          │  unchanged
                       │ LIGHT TREE over emissive meshes + NEE    │  NEW  (Phase 3)
                       └─────────────────────────────────────────┘
                                        │
                                        ▼
                       ┌─────────────────────────────────────────┐
  TRANSPORT            │ radiance cascades, c0…cN                 │  unchanged shape
                       │   merge: continuous parallax (shipped)   │
                       │   probes: dense today → sparse (Phase 7) │
                       └─────────────────────────────────────────┘
```

The voxel radiance buffer does not disappear on day one. It degrades: first it stops being read
for mover hits (already true in the tree — the ambient proxy is off by default), then for
emissive-mesh hits, then for static hits (Phase 4). Occupancy and the distance field keep their
jobs — empty-space skipping and penumbra width — which is what they are actually good at.

---

## 4. Phase 0 — verify and land what is already in the tree

**Nothing new is designed until these numbers exist.** Run 2026-08-07. 0.1, 0.2, 0.4 and 0.5 are
done and their numbers are folded into §1.1 and §1.2; **0.3 is still open** because the rig cannot
produce it yet. The two gate outcomes below are what scope Phase 1 (§5).

**0.1 — The smooth-parallax number. GATE FAILED at 10.79%.**
```
ABLATE="|__giParallaxMergeSmooth=false|__giParallaxMerge=false" node scripts/run-gi-block-size.mjs
```
(emissive rig, voxelSize 0.15, probeSpacing 0.375; the user's server on :5201 is already up — do
not start a second.) Returned **10.79%** smooth / 14.71% snap / 4.58% correction-off, reproducing
both recorded numbers exactly. The gate was **≤ 8%** and it missed by 2.8 points: the smooth form
recovered 39% of the structure the parallax correction adds, not the ~two thirds the snap-vs-off
gap implied. Per this section's own instruction, **Phase 1 therefore starts by finding out why,
not by adding a second fix on top** — the residual 6.2 points are the first thing §5's 1a/1b have
to account for.

**0.2 — Re-run the probe sweep with the fix on. A FOURTH OUTCOME: NEITHER TERM COLLAPSED.**
Post-fix table in §1.1. The three predicted outcomes were intercept-collapses, intercept-survives,
both-collapse; what came back is none of them. The probe **slope survived** at 1.38× (was 1.39×)
*and* the **intercept survived** at ~0.196 m (was ~0.19). Only amplitude moved, by roughly a
quarter, uniformly across arms. So the branch that fired is **both at once**: Phase 1 is a
screen-side ablation for the fixed-width floor *and* the probe-lattice work. §5 is scoped
accordingly; Phase 2 is not short-circuited.

**0.3 — The flicker number that has never been taken. STILL OPEN — the rig cannot take it yet.**
`MOVER=1` was believed to put the panel on the user's rotating-box case. It does not: it only tags
the panel `giMobility: "dynamic"` and **leaves it static**, so it changes which path lights the
panel and nothing about motion. Flicker duly read ~0 on every arm of both sweeps. A **rotating**
arm is being added to the rig separately; until it lands, "jumpy" as opposed to "boxy" has no
number. `run-gi-mover-bounce.mjs` and the `SPIN=1` arm in the real-shadow probe already have the
pattern.

**0.4 — Emissive arm.** Every number in §1.1's post-fix table and §1.2 is `MODE=emissive`, the rig
default, and emissive modulation dropped by a quarter. The `MODE=albedo MOVER=1` half is blocked
on the same missing rotating arm as 0.3 — with `MOVER=1` static it exercises the exact-mover
*path*, not moving-mover *bleed*, so the user's "emissive and mover blockiness are the same
artifact" claim stays untested.

**0.5 — Commit. DONE.** Pushed to `origin/main` in three reviewable slices: the MCP multi-session
broker + EditorApi 1.4.0; the editor/scripting typings + the schema-driven export asset walk; and
the GI slice (continuous parallax merge, the `giDynamic` → `giMobility` + `giTrace` split, the
probe fleet, and this document). `.gi-shots/` and `scripts/.gi-*/` are now gitignored as
regenerable. Suite green: `check:types`, `gi-gpu-smoke` on `?dynobj=2` and
`?mode=hybrid-exact-complex&dynobj=2` (read its `bindingAudit`, not its banner — §6.8),
`test:gi-sunleak`, `test:gi-lightvis`, `test:gi-dynobj`, `test:gi-occupancy`, `test:gi-spawn`.
The standing MCP rule was **audited rather than assumed**: the prop surface is schema-driven end
to end (`component.setProp` is generic, `component.types` reflects `cls.schema` at runtime), so
the mobility/trace split needed **no new ops** — `test:mcp` 26/26 and `test:mcp-coverage` 50/50.

**Exit: met except 0.3.** The tree is committed, §1.1 has its post-fix twin, and both gates
returned answers — one failed, one unforeseen. The flicker number carries into Phase 1 as an open
input, not a blocker.

---

## 5. Phase 1 — the residual: the fixed-width floor *and* the probe lattice

*Scope decided by Phase 0.2 — which returned **both branches**: the ~0.196 m intercept survived
and the probe slope survived at 1.38×. 1a and 1b are both in scope, and 0.1's unexplained 6.2
points is the first thing they have to account for. Do not pre-commit to a fix.*

The candidates, in the order the evidence would pick them:

**1a. The reconstruction floor — live, because the ~0.196 m intercept survived the parallax fix.**
Ablate the screen side with the block rig: resolve scale, the bilateral filter radius, the
checker/rate cadence
(`queue` / `queueNoFeedback` / `queueFeedbackOnly`), and the probe reconstruction in the resolve
(`giScreen.js`, the ~0.59 ms pass — the single most expensive screen term). One dial at a time,
one modulation number each. The rig's `GLOBALS=a=1,b=0` env sets live GI knobs before any module
runs, which is what makes this a one-boot sweep rather than a rebuild per arm.

**1b. The known RC fixes we have not applied.** The literature has named remedies for exactly
this artifact class — the *bilinear fix* and *non-linear accumulation* (both catalogued on
radiance.wiki), and Sannikov's post-publication depth-aware **"Bilinear 3D"** upscale, which the
Chalmers thesis on RC optimisation adopts specifically for 3D reconstruction quality. Each is a
merge/reconstruction change, cheap relative to Phase 2, and each is A/B-able on the block rig
under a `__gi…` hatch like everything else in this module. **This is also where 0.1's residual
belongs**: the continuous form took 39% of what the parallax correction adds and left 6.2 points,
and these remedies act on the same merge stage.

**1c. Ringing.** If the residual's ACF goes *negative* (the voxel arms already cross zero around
lag 28 px), that is ringing, not blocking, and it has its own fix in the same literature. Worth
one look at the stored `curve` arrays before assuming "blocks".

**Exit gate:** modulation ≤ 4% on the emissive arm — **10.79% today**, so this is a 2.7× further
reduction, not a polish pass — and ≤ 6% on the `MOVER=1` arm, which needs the rotating arm 0.3 is
waiting on. Or a written argument that the remaining structure is *not* lattice-shaped and
therefore belongs to Phase 2.

**Do NOT** start Phase 2 to fix blockiness if Phase 1 gets there. Phase 2's justification is
mover/emissive *fidelity* and the emitter cap — it is worth doing on those grounds alone, but it
is a much larger change and it must not be sold as a blockiness fix on the strength of the merge
result: that fix took a quarter of the amplitude and none of the block scale.

---

## 6. Phase 2 — Surface Radiance Cache (movers + emissive meshes)

**The structural change. This is the "something better than voxels" the whole plan is for.**

### 6.1 What it replaces

Today, a transport ray that hits an object gets its radiance from one of two places, and both are
lossy:

- **voxel path** — `createTrilinearRadianceSampler` over `radianceBuffer`: 8 taps at cell
  resolution, side-aware weighting, and the value is a *cell average*. Block scale = `voxelSize`.
- **exact mover path** — `dynamicObjects.js` header words 34..36 (mean albedo) / 37..39 (mean
  emissive): **one colour for the whole object**. The comment says it plainly: "Mean per OBJECT,
  not per texel: per-texel would need textures bound in the compute pass, and the gap being
  closed here is wrong-vs-right, not right-vs-detailed."

Phase 2 is the "right-vs-detailed" half. **And the binding objection in that comment no longer
holds** — see §6.5.

### 6.2 Cards, not UVs

Each cached object gets K orthographic **cards**. A card is a projection of the object onto one
axis-aligned plane in *object space*, rasterized into a shared atlas rect.

Why cards and not mesh UVs: a card lookup needs only the object's inverse world matrix and its
half-extents — **both already in the header, words 0..15 and 16..18**. No mesh UV attribute, no
per-triangle attribute fetch, no index indirection in the hot kernel. That is exactly why Lumen
uses them.

Card count by shape, reusing `classifyDynamicShape`'s existing taxonomy:

| classified type | cards | note |
|---|---|---|
| OBB (box, plane) | 6 (plane: 2) | a zero-thickness OBB is the exact rectangle already |
| sphere / capsule / frustum | 6 | analytic shapes, cheap to rasterize |
| BVH mesh | 6 default, `__giSrcCards` to raise | Lumen's known failure mode is concave meshes; §6.7 |

Card resolution is **screen-projected**, allocated at adopt time and re-allocated on a large
distance change: `res = clamp(round(k · worldSize / distance), 8, 128)`. A 30 m-away crate gets
16², a 2 m-away one gets 128². This is the memory governor, and it is also the LOD story.

### 6.3 Data layout

**Atlas (new textures, NOT storage buffers):**

| texture | format | written | read by |
|---|---|---|---|
| `srcMaterial` | rgba16f — albedo.rgb + coverage.a | once per mesh (+ on material version change) | lighting pass |
| `srcGeometry` | rgba16f — oct normal.rg + object-space depth.b + emissive luminance.a | once per mesh | lighting pass |
| `srcRadiance` | rgba16f — outgoing radiance.rgb + age.a | **per frame** (staggered) | **the trace kernels** |

Only `srcRadiance` is bound in the hot path — **one extra sampled texture**. Start at 2048²
(≈ 25 MB across the three at rgba16f) and tier it like `dynamicObjectWords` already tiers.

**Card table:** 8 words per card — `[u0, v0, du, dv, axis|sign, resU|resV, objIdx, flags]`.
6 cards = 48 words per object. Lives in the **reserved tail of the occupancy bits buffer**,
exactly where `OBJ_WORDS` and the BVH pool already live (`dynamicObjectWordOffset`). Object block
word **+23 is free** — it becomes the card-table base offset. Zero new storage bindings.

### 6.4 The lookup (hot path, ~15 ALU)

At a dynamic hit the trace already returns `dynObj` (object index, via `trace({objId: true})`
riding the vec4's `pen` slot), the exact hit point, and an oct-packed normal. So:

```
pLocal  = invWorld · P                       // words 0..15, already loaded for the slab test
axis    = argmax |dot(nLocal, ±e_k)|         // 3 compares, no branch
(s, t)  = the two pLocal coords ⊥ axis, / halfExtents  →  [0,1]²
uv      = cardRect.xy + (s, t) · cardRect.zw
rad     = textureSampleLevel(srcRadiance, linearSampler, uv, 0).rgb
```

Bilinear filtering across the card is free (hardware) and is what makes the result *continuous* —
the property the trilinear voxel read was trying and failing to provide.

### 6.5 Why the binding walls do not block this — and the one that could

There are **three** walls, and the one that can actually kill Phase 2 is not the one the
mean-albedo comment assumed. Audited in the tree, 2026-08-07.

**Storage buffers — limit 8, and we are at 8.** The module's standing rule is the portable
8-storage-buffer stage limit (`dynamicObjects.js:38`, `occupancyField.js:193`), and the composed
feedback kernel `createBounceFeedback` (`cascadeGather.js:748`) sits **exactly at 8, enumerable,
zero margin** — `cascadeGather.js:951-954` documents evicting `normalBuffer` to buy the last slot.
Resolve and composite sit at the **12-uniform-buffer** wall. A new storage buffer is not
available, and that is the constraint §6.3 is built around (card table in the bits tail, zero new
storage bindings).

**Sampled textures — limit 16, and we use at most one.** Different binding class, and the headroom
is larger than this section originally claimed. The shipping occupancy transport trace
`createOccupancySceneTrace` (`giField.js:1503`) samples **zero** textures; the composed feedback
kernel samples exactly **one** (`distanceTexture`, `cascadeGather.js:955`). The sparse page/pool
is **two** textures, not one, and it is **off by default** (`sparseField.js:311` and `:334`, gated
at `giField.js:122`); a fourth 3D texture is reachable only on the degraded no-occupancy arm
(`giField.js:1066` → `slotRegistry.js:791`) and is dead whenever an occupancy field exists. So
`srcRadiance` costs **1 of 16 against a worst case of 3**.

Two audited facts make that safe to rely on: there are **no hard-coded `@binding`/`@group` indices
and no bind-group-layout constants anywhere in `src/modules/gi/`** — TSL auto-assigns all of them
— and `maxSampledTexturesPerShaderStage` is **never requested anywhere in the repo**, so the
16/16 baseline applies unmodified and adding a sampled texture needs no `requiredLimits` change.

**Storage textures — limit 4, and this is the wall to respect.** *Sampling* the card atlas is
free; **writing** it is not. §6.6's per-texel accumulate into `srcRadiance` is a `textureStore`
target, and the WebGPU baseline is only **4 storage textures per stage**. `GISystem.js:1889-1895`
already records that the resolve writes irradiance + emitterShadow + radiance, plus a BVH radiance
target when exact reflections are on — 3, or 4 with reflections. A **dedicated** card-lighting
dispatch, as §6.6 specifies, writes exactly **1** and is fine. **Folding any of the card
accumulate into the resolve puts it on the 5th storage texture and silently drops the entire GI
compute on a baseline device.** Keep the pass separate; §6.9 carries this as a kill criterion.

**Verify on the smoke harness before building anything else** — and read its `bindingAudit`, not
its banner: §6.8.

### 6.6 The lighting pass

One compute dispatch over **allocated, recently-used** atlas texels — not over the atlas, and not
over volume cells. Per texel:

1. Reconstruct world P (card rect → object space → `matrixWorld`) and N (from `srcGeometry`).
2. **Direct**: loop the analytic light slots (uniforms, already threaded through
   `createSceneTrace({lightSlots, ambient})`), one visibility ray each through
   `composeFieldDynamics` with `dynamics: false`. This is the *same code* as today's per-hit
   `visibility()` in `createOccupancySceneTrace` — moved from per-ray to per-texel, which is
   strictly fewer evaluations.
3. **Emissive**: from `srcMaterial`/`srcGeometry`, matching `resolveMaterialSurface` exactly —
   the same resolver the voxel path uses, deliberately, so an object crossing the cached/uncached
   boundary does not step hue. (The existing header path already made this mistake once and fixed
   it the same way.)
4. **Bounce**: sample the cascade field at P. Phase 2 keeps the existing trilinear read *here*
   only — it is one indirect bounce arriving at a surface, not the surface's own colour, so its
   quantization is a second-order term. Phase 4 revisits it.
5. Accumulate into `srcRadiance` with a short EMA keyed on the age channel, invalidated on
   transform change (the swept-bounds machinery in words 24..30 already computes exactly the
   right invalidation signal, including the translation-scaled retain factor).

**Count this pass against the 12-uniform wall while threading it.** `giScreen.js:1195-1199`
records that inlining a trace *plus* light slots *plus* emitter slots measured **16 uniform
buffers against a baseline of 12** — which is why BVH hit-shading was moved to the resolve in the
first place. Steps 2–4 thread that same three-way combination into one kernel, so it has to be
counted, not assumed.

**Update cadence**: round-robin N cards per frame, priority = screen-projected area × age. Same
governor Lumen uses. Budget it as a hard texel count per frame, and `log()` what got dropped —
the module's own rule about silent caps.

**Lambert normalisation must match `cascadeGather`'s `direct` term exactly (`/PI`).** A different
normalisation makes cached objects read brighter than the geometry beside them; that bug has
already been made once in this module and is called out in `giField.js`.

### 6.7 Failure mode, and the fallback that must ship with it

Cards are an orthographic projection. A **concave** mesh (Lumen's documented limit: "importing an
entire room with furniture as a single mesh is not expected to work well") has interior surfaces
no card sees. Detection is cheap and must be done at card-build time: compare rasterized card
coverage against the mesh's true surface area. Below a threshold, the object **keeps the header
mean-albedo path** (which stays, and stays correct). Log the demotion by name so a content author
can act on it — "split this mesh" is a real and normal answer.

### 6.8 Test plan

- **`test:gi-surface-cache`** (new, CPU ground truth in the `test:gi-dynobj` mould): build cards
  for the six default geometries + a custom mesh, verify (a) every surface point's chosen card
  and UV round-trips to within a texel, (b) atlas rects never overlap, (c) the concave detector
  fires on a deliberately concave test mesh and not on a convex one. Split failures into
  *structure bugs* vs *epsilon class* — that diagnostic shape is what convicted the BVH8 stride
  bug in minutes.
- **`probe:gi-mover-bounce`** — the existing hue rig. Voxel path 30.1% red excess, header path
  21.8%. Card path should land at or above the voxel path's figure *and* stay stable under
  rotation, which the header path already does and the voxel path does not.
- **`probe:gi-block-size` with `MOVER=1`** — the block size at a mover hit must now be the card
  texel, i.e. below the measurement floor. This arm is **static** (`MOVER=1` tags mobility, it does
  not animate — §4's 0.3), so it measures block size only; stability under rotation needs the
  rotating arm.
- **`gi-gpu-smoke`** — new arm `?srccache=1`. **Do not gate on the `storage=8` banner: it cannot
  fail.** Every value on `scripts/gi-gpu-smoke.html:701` is interpolated except that one, which is
  a hard-coded string literal — the old instruction here was a tautology. What the harness really
  provides is three things: it **pins the device to the portable limit** (`:111-112` throws unless
  `maxStorageBuffersPerShaderStage === 8`); it **captures uncaptured validation errors**
  (`:107-109`) and throws if any occurred (`:395`), so a 9th storage buffer fails loudly through
  pipeline validation; and it runs a **per-compute-node regex audit** (`:386-394`) that logs
  `GI-SMOKE BINDINGS` and fills `__GI_SMOKE_RESULT__.bindingAudit[].storageBindings`. **Gate on
  `bindingAudit`.** Note its blind spot: it counts **no textures at all**, so it will not notice a
  new sampled texture, and it will not notice a 5th storage texture either — that one surfaces
  only as a validation error, and only on a device actually at the baseline of 4.
- **`profile.giPasses`** — the atlas lighting pass gets its own queue entry, and the acceptance
  bar is that it costs **less than the `feedback` pass it displaces** (0.73 ms per emitter today,
  0.56 ms for four after the record-march fix). Measure in the user's editor, not headless —
  headless numbers do not extrapolate (503×221 vs ~1.6M px).
- **MCP**: `profile.giSurfaceCache` op (cards allocated, atlas occupancy %, texels lit/frame,
  demoted-concave list) + the new props on `GlobalIlluminationComponent`. Standing rule: ships in
  the same change, with `test:mcp-coverage` green.

### 6.9 Kill criteria

Abandon and revert if any of these hold after 6.8:
- `bindingAudit[].storageBindings` exceeds 8 on any smoke arm and cannot be brought back.
- The card-lighting write cannot be kept to its own dispatch and the resolve reaches a **5th
  storage texture** (§6.5). That is not a regression, it is total GI failure on baseline hardware,
  and it will not show up on a dev machine with a higher limit.
- The lighting pass cannot be threaded within **12 uniform buffers** (§6.6).
- The atlas lighting pass costs more than the `feedback` pass it displaces, at equal quality.
- More than ~20% of a real scene's meshes demote to the concave fallback (then the card model is
  wrong for this content and surfels or a hash grid is the better shape — §10).

---

## 7. Phase 3 — many-light NEE and a light tree

**Fixes: `MAX_EMITTERS = 4`, the ~6× promotion pop, the 22%-at-r=0.4 under-delivery, and the
77%-of-screen-work emitter pass. One change, four symptoms.**

Today an emissive mesh is either *promoted* to one of 4 analytic uniform slots (exact silhouette,
full energy) or *not* (transport-only, ~17% of the energy). `giScreen.js:754` allocates
`MAX_EMITTERS` shadow vars **per resolve pixel** and `giScreen.js:763` loops the slots — O(lights
× pixels) by construction. Promotion **ranks by power**, so ordering churns as objects spawn and
despawn, and every crossing is a visible pop fired exactly when the player shoots.

**The design:**

1. **One representation.** Every emissive mesh becomes an entry in a **light tree** — a small BVH
   over emitter bounds carrying `{bounds, power, mean direction, cone half-angle}` per node.
   Built on CPU with the same `buildBvhWords` machinery the static BVH uses, packed into the bits
   tail like everything else. No cap, no promotion, no second path — so **the pop cannot happen**.
2. **NEE at the cache texel, not at the pixel.** The Phase 2 lighting pass picks 1–2 lights by
   importance-weighted descent (PBRT/Cycles "many lights with adaptive tree splitting"), evaluates
   the analytic area-light integral, and casts **one** shadow ray through the existing structure.
   Cost is O(log n) per texel and **independent of light count**.
   This is also the fix for the r = 0.4 m under-delivery: an explicitly sampled emitter cannot be
   missed by a ray that never pointed at it. That was already identified as the only structural
   option — "there is no factor that makes a missed ray hit."
3. **The screen pass stops looping slots.** Emitter light reaches a pixel through the cache, so
   `emitterShadowPass` shrinks to the direct-visibility term it actually needs. `emitterCutoff`
   demotes from a correctness-critical dial (trace gate and contribution smoothstep must stay
   locked or dim light crosses walls) to a pure importance threshold — much less dangerous.
4. **Clustered/froxel assignment is now optional**, not required. It was the plan when the light
   count multiplied per-pixel work; with NEE at cache texels it becomes a nice-to-have for the
   direct specular term only.

**Ordering note:** Phase 3 depends on Phase 2 (it needs somewhere to put the result). If Phase 2
is killed by §6.9, Phase 3 degrades to "light tree + NEE at cascade probes", which is worse
(probes are coarser than card texels) but still removes the cap and the pop.

**Tests:** `probe:gi-emitter-cap` with `LAMPS=8,16,32` — per-lamp delivered luminance must be
**flat** across lamps and match the current promoted value; `RAMP` (the strength ramp that moves
promotion ranking without moving lamps) must produce **no** change in relative delivery, because
there is no ranking left. `probe:gi-emissive-cost` — per-emitter marginal cost must go
approximately flat instead of the current 0.73 ms/emitter linear.

---

## 8. Phase 4–7 — the longer arc

**Phase 4 — extend the surface cache to static geometry.** `MAX_INSTANCE_SLOTS = 512` static
slots get cards too, and the voxel `radianceBuffer` stops being a *radiance* store entirely. It
keeps occupancy and the distance field (empty-space skipping, penumbra width) — its real jobs.
This is where the remaining voxel-quantized bleed goes away, and it is also where atlas memory
becomes a real budget question. Gate it on Phase 2 succeeding on movers first.

**Phase 5 — subgroups.** Shipped in Chrome stable (f16 available by requesting `shader-f16` +
`subgroups` together; `subgroups-f16` is deprecated). BVH8 traversal and the cache lighting pass
are textbook workloads — ballot-shared stack, `subgroupBroadcastFirst` for wave-uniform node
fetch. Reported gains on comparable shaders: 2.3–2.9× (Google Meet), 2.5× (Intel). Compile a
subgroup variant behind adapter feature detection and **keep the scalar path** — the web build
must run everywhere. This is the closest thing to hardware RT actually available to us, and
unlike hardware RT it exists.

**Phase 6 — TLAS over movers.** Justified by the **cap** (16) and by scale (200 movers), *not* by
current cost: the marginal cost of an adopted mover measured +0.007 ms. Re-measure with
BVH-traced (not OBB) movers before sizing it. Do not build it on cost grounds; that proposal was
already killed once by measurement.

**Phase 7 — sparse hashmap probes (Split Radiance Cascades).** Sannikov's own current answer:
probes in a sparse hashmap keyed by quantized position and level, cell size from camera distance,
plus ray splitting (trace from visible surfaces, assign to cascade intervals by hit distance).
This is a **memory and scale** fix — it is what lets near-camera probes be dense without paying
for a dense volume everywhere. Note the ordering carefully: §1.1 says probe spacing sets block
size, so this *does* touch the artifact — but Phase 0/1 will have already taken the cheap two
thirds, and this is a rewrite of the probe storage. Read the paper properly before scoping it;
the abstract alone does not say what it traces against.

---

## 9. Phase 8 — what the Rust backend actually gets

Not the frame. Three jobs where a native `EXPERIMENTAL_RAY_QUERY` path pays for itself and
nothing depends on it at runtime:

1. **The ground-truth arbiter.** "Are the GI shadows correct" is *still unarbitrated* — the
   shadow-map second opinion rendered the scene essentially black and was abandoned as a separate
   bug. A wgpu path tracer over the same scene, driven by the same harness, gives a numeric
   reference instead of a visual impression. This is the highest-value item on the list and it is
   independent of everything above.
2. **Bakers.** Card capture, concavity analysis, and any future probe/irradiance prebake are
   offline by nature and embarrassingly ray-traced.
3. **BVH builds.** SAH build is 564–1523 ms in JS today, one-time but user-visible.

Plus the cheap forward-looking bit: wire `additionalBrowserArgs` (`--enable-unsafe-webgpu
--enable-dawn-features=allow_unsafe_apis`) behind an editor setting, with the `data_directory`
caveat handled, so that when Dawn does expose something we can opt in without a release. Feature-
detect and fall back silently; never make the editor's startup depend on a flag.

---

## 10. What NOT to do

Each of these was proposed and killed by measurement. Re-proposing one costs a session.

- **Do not chase `voxelSize`, occupancy resolution, or the trilinear sampler footprint to shrink
  the blocks.** §1.1: 5× dial, 2% effect.
- **Do not re-suspect the traversal caps, the slot-mask OOB, or periodic rebuild hitching.**
  Max 82 pops against a 1024 guard, `slotId < 512` by construction, 1 rebuild per session,
  `framesOver100ms = 0`.
- **Do not build a TLAS on cost grounds.** +0.007 ms/mover. Cap and scale are the only arguments.
- **Do not look for a calibration constant for the promoted-vs-past-cap emissive gap.** 22% at
  r = 0.4 vs 66% at r = 1.2 — it is size-dependent, so no scalar exists.
- **Do not re-propose the ReSTIR GI module.** Deleted 2026-07-16. Phase 3's light tree is
  deliberately *not* reservoir-based: reservoirs need storage bindings we do not have and
  reintroduce the stochastic noise that forces the bilateral blur the user already objects to.
- **Do not suspect `__giSunJitter` for the dither.** It defaults to 0.
- **Do not restore the neighbourhood-radiance ambient proxy** on the exact-mover path. It was the
  last voxel-quantized term in an otherwise exact path, it measured as contributing ~nothing (an
  adopted mover's cells are *empty*), and it is a live suspect for "large square patches of colour
  bleed that appear and disappear fast".
- **Do not plan a native wgpu runtime renderer.** §2.3.

---

## 11. Standing traps that apply to every phase

- **`autoFit: true` makes `voxelSize` and `probeSpacing` inert**, and editing an advanced field
  in the Inspector flips `quality` → "custom" → "high", coarsening both lattices at once. Any rig
  that sweeps either dial must run `autoFit` OFF with explicit bounds and read the built
  resolution back.
- **`MOVER=1` in the block rig does not move anything.** It tags the panel
  `giMobility: "dynamic"`, which switches the *path* that lights it; the panel stays static. Any
  arm that is supposed to measure motion needs the rotating arm, not this flag. The tell is
  `flick.rms` reading ~0 exactly as it does on the static arms.
- **Headless numbers do not extrapolate.** The probe's GI resolve is ~315k px against a real
  editor's 1.6M cap, and every screen pass is per-resolve-pixel. Use `profile.giPasses` in the
  user's editor for anything per-frame. On HiDPI the drawing buffer is ~4× the CSS size, which is
  why the same scene reads 5 ms on one monitor and 40 ms on another.
- **`profile.giPasses` freezes the loop and re-dispatches with the last tick's uniforms.** Take a
  per-pass median of 3.
- **Verify the user reloaded** before trusting any number they report. Twice in one session the
  numbers came from a pre-fix build.
- **The dev server on :5201 is the user's** — do not start a second (`strictPort` fails), and
  their editor is live on the same project: it contends for the GPU *and* edits the scene under
  probes. Re-read scene state before quoting it.
- **`page.screenshot()` captures the whole page**; the viewport canvas is a sub-rectangle. Add
  `getBoundingClientRect().left/top` or every sample lands on editor side panels. The tell is
  values identical to five decimals across runs that should differ.
- **A tunable is not done until it is MCP-reachable.** Ops and `test:mcp` ship in the same change
  as the UI.

---

## 12. Sequencing

| phase | what | depends on | size |
|---|---|---|---|
| 0 | verify + commit the tree; the four missing numbers | — | **done 2026-08-07, except 0.3** |
| 1 | reconstruction floor **and** probe lattice — 0.2 returned both | 0 | 1–2 sessions |
| 2 | Surface Radiance Cache — movers + emissive | 0 | 3–4 sessions |
| 3 | light tree + NEE; delete `MAX_EMITTERS` | 2 | 2 sessions |
| 4 | extend cache to static slots; retire voxel radiance | 2, 3 | 2–3 sessions |
| 5 | subgroups | — (parallel) | 1 session |
| 6 | TLAS over movers | — | 1 session, on demand |
| 7 | sparse hashmap probes (Split RC) | 1 | 3+ sessions |
| 8 | Rust wgpu RT arbiter + bakers | — (parallel) | 2 sessions |

Phases 5 and 8 are independent of the main line and can be picked up whenever the main line is
blocked on a measurement.

**Phase 0 has returned. Start at Phase 1, both branches (§5)** — the screen-side ablation for the
~0.196 m floor and the merge/reconstruction work for the 6.2 unexplained points, in that order,
one dial at a time. 0.3's flicker number lands when the rotating arm does.

---

## References

- [Split Radiance Cascades: Real-Time GI via Sparse Radiance Probes](https://arxiv.org/abs/2607.20384) — Freeman & Sannikov, 22 Jul 2026
- [Lumen Technical Details](https://dev.epicgames.com/documentation/unreal-engine/lumen-technical-details-in-unreal-engine) — surface cache / mesh cards
- [NVIDIA SHaRC](https://github.com/NVIDIA-RTX/SHARC) — spatially hashed radiance cache
- [GI-1.0: Two-Level Radiance Caching](https://gpuopen.com/download/publications/GPUOpen2022_GI1_0.pdf) — AMD
- [radiance.wiki](https://radiance.wiki/) — RC variants, the bilinear fix, ringing fixes
- [Exploration and Optimization of Radiance Cascades](https://odr.chalmers.se/items/3ee9fb4e-1880-46c2-802a-a660e38dc9ee) — Chalmers; "Bilinear 3D" upscaling
- [gpuweb#535 — Ray Tracing extension](https://github.com/gpuweb/gpuweb/issues/535)
- [wgpu ray tracing API spec](https://github.com/gfx-rs/wgpu/blob/trunk/docs/api-specs/ray_tracing.md)
- [What's New in WebGPU — subgroups](https://developer.chrome.com/blog/new-in-webgpu-144)
