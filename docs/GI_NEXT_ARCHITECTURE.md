# GI — Next Architecture

*Where radiance is STORED, not what rays HIT. Plus the hardware-ray-tracing question, answered.*

*Written 2026-08-07, after the block-size sweep; updated the same day once Phase 0 ran, and again
once Phase 1 ran. Supersedes the "voxelSize sets the block size" hypothesis in the session-34/35
handoffs — **that hypothesis is now falsified by measurement** (§1.1). Phase 1 falsified two more
things this document itself asserted: the far-field falloff shortfall is **not** an unexplained
transport loss, it is attributed to a single default flip (§1.3); and emissive blockiness and
mover blockiness are **not** the same artifact, they are 15× apart (§1.4). This document is the
plan; `GI_PLAN.md`, `GI_SHADOWS_PLAN.md` and `dynamic_gi_exact_dynamic_objects.md` remain the
history of what got us here.*

---

## 0. TL;DR

Four claims, each backed by a number in §1:

1. **"Bleed too strong, reaches too far" is attributed, and it is a tuning question.** The
   far-field falloff exponent is **−2.18** against an analytic **−2.72** on what ships today. The
   whole ~0.78 shortfall belongs to commit `b5961d7`, which flipped the `rayHitMode` default from
   `occupancy-legacy` to `auto`; `GLOBALS=__giRayHitMode=occupancy-legacy` reproduces the old
   −2.63 and, stacked with the current merge kernel, **−2.97**. Both modes are wrong in opposite
   directions — `auto` 0.54 too flat, legacy 0.25 too *steep* — so the answer is a merge visibility
   *tolerance* between them, not a revert (§1.3). This is a direct hit on the user's original
   complaint and it is the cheapest open item in this document.
2. **The blockiness is not the voxels.** A 5× sweep of `voxelSize` moves the measured block size
   by 2%. A 3.2× sweep of `probeSpacing` moves it 1.39×. The voxel grid is innocent of *this*
   artifact; the c0 probe lattice and the cascade merge are not. **The post-fix sweep reproduces
   both slopes** — 1.02× and 1.38× (§1.1).
3. **The parallax merge's error was the kernel's second moment, not its centre.** Off entirely:
   4.58% floor modulation. Snapped: 14.71%. The Phase-0 linear 3-tap fixed the tap *centre*:
   10.79%. The quadratic B-spline that also matches the *variance* now ships: **9.39%**, with
   falloff improving −1.88 → −1.94 → −2.18 on the same three arms — a strict win on both rigs
   (§1.2). Phase 0's ≤ 8% gate still **fails** by 1.4 points, and 4.8 points of parallax-added
   structure remain unattributed (§5).
4. **What is left after that is a radiance-STORAGE problem, and hardware ray tracing would not
   touch it.** Every current system (Lumen, RTXGI/SHaRC, AMD GI-1.0, Sannikov's own Split
   Radiance Cascades) abandoned dense world-grid radiance storage. We should too. That is
   Phase 2; its CPU half (card builder, atlas, packing, concavity) is **shipped and tested**
   (`7bc24f1`), with six corrections to §6 forced by building it.

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
default (§4's 0.2). Same command, same rig. **This sweep was taken on the linear 3-tap**; the
quadratic B-spline that superseded it (§1.2) moves the shared 0.15/0.375 point 10.79% → **9.39%**
and the sweep has *not* been re-run on it — treat the amplitude column as an upper bound and the
block column as unaffected, since no parallax kernel has ever moved block scale:

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
  intercept is a *floor* that does not follow either dial. **Phase 1b hunted its owner and did not
  find it** — the bilateral filter and AO were both cleared, and the one term that moved anything
  moved amplitude, not scale (§5's 1b). The intercept's owner is **still unidentified**.

**The z axis is not trustworthy.** z is the depth axis in this framing, heavily foreshortened
(122 px/m nominal but the patch spans a large depth range), and the z column is non-monotonic
(0.50 → 0.53 → 0.38 → 0.48). Quote x. Fix the rig's z geometry or drop the z column before
anyone builds an argument on it.

**Flicker is not in these arms, and `MOVER=1` does not put it there.** Every arm has `adopted: 0`
and a static panel, and a settled frame is deterministic to 1e-4 — a baseline re-run against
itself moves the residual by 0.01% rms. `MOVER=1` turns out **not to move the panel at all**: it
only tags it `giMobility: "dynamic"`, which changes *which path lights it* and nothing about
motion, so **every flicker number in this module taken before 2026-08-07 was taken on a still
frame**. The rig now has a real `SPIN=<deg/s>` arm that rotates the panel; the numbers it returned
are §1.4.

### 1.2 The parallax merge kernel — centre, then second moment

`cascadeMerge.js:383-460`. The parallax correction re-aims a child probe's tap at its parent and
then **snapped the tap to whole texels** (`floor(pu + 0.5) - 1`), so as a child probe slid across
its parent's cell the tap *index* jumped a whole angular bin and the merged radiance stepped with
it. Four-arm ablation on the block rig — emissive, voxelSize 0.15 / probeSpacing 0.375 — with the
matching bleed-rig falloff (§1.3) beside each, because a merge change is not measured until both
rigs have spoken:

- `__giParallaxMerge = false` — correction off entirely: **4.58%**, falloff **−1.09**
- `__giParallaxMergeSmooth = false` — the old snap: **14.71%**, falloff **−1.88**
- the Phase-0 linear 3-tap: **10.79%**, falloff **−1.94**
- baseline — the quadratic B-spline, now the shipped default (`923cd78`): **9.39%**,
  falloff **−2.18**

The ablation reproduces both recorded pre-fix numbers exactly, and a baseline re-run against
itself moves 0.01% rms, so the rig is deterministic and these four are comparable.

**The linear 3-tap fixed the tap centre and got the kernel wrong.** Linearly blending the two
integer-aligned boxes gives weights `[(1−f)/2, ½, f/2]`. Its **mass** is 1 and its **mean** is
right — but mass is not what sets small-source dilution, the **second moment** is, and that
kernel's variance is `0.25 + f − f²`: equal to the snapped 2-box at `f = 0` and `f = 1`, and
**double it at `f = 0.5`**. So the correction was smoothly widening and re-narrowing its own
footprint as a child probe slid across its parent's cell — a different periodic error in place of
the `floor()`'s. Solving mass + mean + variance simultaneously for taps at `{0, 1, 2}` has one
solution, the quadratic B-spline:

```
a = (1−f)²/2      b = ½ + f − f²      c = f²/2
```

which is a constant-variance, fractional-centre, separable 3-tap — same read count as the linear
form (9 instead of 4, in a loop already reading 8 parent probes).

**Read it:** the parallax correction *adds* 10.13 points of structure over having none; the linear
form recovered 3.92 of them (39%), the quadratic recovers **5.32 — 53%**, and it is a **strict win
on both rigs**: 14.71 → 10.79 → 9.39% floor modulation *and* −1.88 → −1.94 → −2.18 falloff, never
trading one for the other. That matters because Phase 1a found an arm that buys modulation by
selling falloff (§5's 1a). **4.8 points of parallax-added structure remain**, and the shipped
kernel misses §4's 0.1 gate of ≤ 8% by 1.4 points.

Hatches: `__giParallaxMergeSmooth = false` restores the snap; `__giParallaxMerge = false` turns the
correction off entirely. The linear form is superseded and is no longer reachable by a hatch.

### 1.3 The far-field falloff — attributed to a default flip, and it overshoots both ways

**This is the biggest single result in the document, and it lands on the user's original
complaint**: "our colour bleed is too strong and reaches too far; in Blender it fades out
quickly". `scripts/run-gi-bleed.mjs` measures exactly that as a far-field falloff exponent against
an exactly-integrable analytic reference, which sits at **−2.72**. Read the **white** channel: the
red channel is bracket-limited on this rig and the probe now flags that automatically, so red
exponents are not comparable across arms.

| arm | falloff |
|---|---|
| naive — `__giParallaxMerge = false` | **−1.09** |
| snapped box, `rayHitMode` `auto` | **−1.88** |
| linear 3-tap, `rayHitMode` `auto` | **−1.94** |
| **quadratic B-spline, `rayHitMode` `auto` — ships today** | **−2.18** |
| snapped box, `rayHitMode` `occupancy-legacy` | **−2.63** |
| quadratic B-spline + `occupancy-legacy` | **−2.97** |
| analytic ground truth | **−2.72** |

The value recorded for the snapped arm on 2026-08-04 was −2.66, and
`GLOBALS=__giRayHitMode=occupancy-legacy` reproduces it at −2.63. **So the ~0.78 exponent
shortfall that has sat on this module since 2026-08-05 is entirely attributable to commit
`b5961d7`**, which flipped the `GlobalIlluminationComponent` default `rayHitMode` from
`occupancy-legacy` to `auto` (`GlobalIlluminationComponent.js:105`, `rayHit/RayHitConfig.js:60-75`).
No transport term is missing; a default moved.

**Mechanism.** Under `auto`, plane/coverage hits resolve at the *fitted surface* rather than the
conservative voxel shell, so a grazing ray reports a **longer** free distance. At
`cascadeMerge.js:318-336` that shrinks `penetration = dist − parentRay.w`, so the visibility
proxy's smoothstep retains **more** coarse-parent weight, which inflates far-field energy. That
block sits *upstream* of the parallax branch — which is why the flip moved the naive arm too, and
why it shows up identically on every kernel in §1.2.

**Do not write this up as "revert the default."** The two effects stack and **overshoot**: `auto`
is 0.54 too flat, `occupancy-legacy` is 0.25 too **steep** — bleed dying too fast, the opposite
error, and one the user would complain about in the other direction. Re-fitting the stored samples
over nested windows (3–10 m, 3–8 m, 3–6 m) gives **−2.97 / −2.95 / −2.97** for the legacy arm, so
the overshoot is stable and not a noise-floor artifact of the fit window.

**The correct answer is between the two modes, which makes this a tolerance/contract question, not
a binary flip.** The dial is the merge visibility tolerance — `MERGE_VIS_TOLERANCE`,
`cascadeMerge.js:58`, hatched as `__giMergeVisTol`. **OPEN**, and per §12 it is arguably the
highest-value open item in this document: it is a direct hit on the original complaint, both
bracketing endpoints are already measured, and it is tuning rather than a rewrite.

### 1.4 Flicker under rotation — measured at last, and §4's 0.4 hypothesis is falsified

The rig gained a real `SPIN=<deg/s>` arm (`MOVER=1` only ever *tagged* the panel — §1.1).
Emissive panel at 20 °/s, yaw 28° across 3 frames:

| arm | flicker | size | **detrended flicker** | detrended size | level |
|---|---|---|---|---|---|
| `MODE=emissive` | 39.08% | 0.680 m | **7.48%** | **0.174 m** | 0.3478 |
| `MODE=albedo` | 1.68% | 1.017 m | **0.48%** | 0.121 m | 1.0324 |

"Detrended" = the same frame difference with a per-line cubic fitted out, so smooth aspect change
lands in the fit and **what survives cannot be honest relighting**. **7.48% at 0.174 m is the
user's "blocky and flickery indirect light", quantified for the first time.**

**§4's 0.4 asked whether emissive blockiness and mover-bleed blockiness are the same artifact.
They are not — 7.48% vs 0.48%, a 15× gap.** Two caveats, recorded so nobody over-reads the raw
column: in the emissive arm the rotating object **is** the light source, so much of the raw 39% is
legitimate; and the albedo arm is 3× brighter (level 1.0324 vs 0.3478), which flatters its
percentage. The detrended pair is the honest comparison, and it still says the emissive path
carries an order of magnitude more temporal structure than the mover path. Whatever fixes mover
bleed will not fix emissive flicker.

### 1.5 The other measured facts this plan inherits

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
| **(A) Visibility** | what a ray intersects | occupancy DDA + static BVH8 + analytic movers | not the cost (§1.5), not the block size (§1.1) |
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
                       │   merge: quadratic-B-spline parallax     │  shipped
                       │   merge: visibility tolerance ← OPEN     │  §1.3
                       │   probes: dense today → sparse (Phase 7) │
                       └─────────────────────────────────────────┘
```

The voxel radiance buffer does not disappear on day one. It degrades: first it stops being read
for mover hits (already true in the tree — the ambient proxy is off by default), then for
emissive-mesh hits, then for static hits (Phase 4). Occupancy and the distance field keep their
jobs — empty-space skipping and penumbra width — which is what they are actually good at.

---

## 4. Phase 0 — verify and land what is already in the tree

**Nothing new is designed until these numbers exist.** Run 2026-08-07. **All five are now done** —
0.3 and 0.4 closed once the rig gained a real rotating arm — and their numbers are folded into
§1.1, §1.2 and §1.4. The gate outcomes below are what scoped Phase 1 (§5).

**0.1 — The smooth-parallax number. GATE FAILED at 10.79%, and still fails at 9.39%.**
```
ABLATE="|__giParallaxMergeSmooth=false|__giParallaxMerge=false" node scripts/run-gi-block-size.mjs
```
(emissive rig, voxelSize 0.15, probeSpacing 0.375; the user's server on :5201 is already up — do
not start a second.) Returned **10.79%** smooth / 14.71% snap / 4.58% correction-off, reproducing
both recorded numbers exactly. The gate was **≤ 8%** and it missed by 2.8 points: the linear form
recovered 39% of the structure the parallax correction adds, not the ~two thirds the snap-vs-off
gap implied. Per this section's own instruction, **Phase 1 started by finding out why, not by
adding a second fix on top** — and the answer was that the kernel's *second moment* was wrong, not
just its centre (§1.2). The quadratic B-spline took it to **9.39%**, which still misses the gate
by 1.4 points; 4.8 points remain for §5.

**0.2 — Re-run the probe sweep with the fix on. A FOURTH OUTCOME: NEITHER TERM COLLAPSED.**
Post-fix table in §1.1. The three predicted outcomes were intercept-collapses, intercept-survives,
both-collapse; what came back is none of them. The probe **slope survived** at 1.38× (was 1.39×)
*and* the **intercept survived** at ~0.196 m (was ~0.19). Only amplitude moved, by roughly a
quarter, uniformly across arms. So the branch that fired is **both at once**: Phase 1 is a
screen-side ablation for the fixed-width floor *and* the probe-lattice work. §5 is scoped
accordingly; Phase 2 is not short-circuited.

**0.3 — The flicker number that had never been taken. DONE.** `MOVER=1` was believed to put the
panel on the user's rotating-box case. It does not: it only tags the panel `giMobility: "dynamic"`
and **leaves it static**, so it changes which path lights the panel and nothing about motion, and
flicker duly read ~0 on every arm of both sweeps. The rig now has a real `SPIN=<deg/s>` arm plus a
**detrended** flicker metric (per-line cubic fitted out, so smooth aspect change cannot masquerade
as flicker). At 20 °/s the emissive arm reads **7.48% detrended at 0.174 m** — the first number
this module has ever had for "jumpy" as opposed to "boxy". Full table and caveats: §1.4.

**0.4 — Emissive vs. mover. DONE, and the hypothesis is FALSIFIED.** Every number in §1.1's
post-fix table and §1.2 is `MODE=emissive`, the rig default. With the rotating arm the
`MODE=albedo` half finally ran, and the claim this section was written to test — "emissive
blockiness and mover-bleed blockiness are the same artifact" — **is false**: 7.48% vs 0.48%
detrended, a **15× gap** (§1.4). They are two artifacts and they need two fixes. Phase 2 targets
the mover/emissive *fidelity* side; nothing in it is justified as an emissive-flicker fix.

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

**Exit: met.** The tree is committed, §1.1 has its post-fix twin, both gates returned answers —
one failed, one unforeseen — and 0.3/0.4 closed once the rotating arm landed, taking one of this
document's own hypotheses down with them (§1.4).

---

## 5. Phase 1 — the residual: the fixed-width floor *and* the probe lattice

*Scope decided by Phase 0.2 — which returned **both branches**: the ~0.196 m intercept survived
and the probe slope survived at 1.38×. **1a and 1b have run.** 1a attributed the parallax residual
and shipped the kernel fix; 1b cleared three suspects and found no owner for the intercept. 1c is
untouched. **1d is new, and it is the largest result Phase 1 produced.***

**1a. The parallax residual — isolated, one arm shipped, one arm REJECTED.** Two discontinuities
remained in the parallax block after the linear 3-tap. Ablations, block rig, emissive,
0.15/0.375:

| arm | floor modulation | verdict |
|---|---|---|
| baseline (quadratic B-spline) | 9.39% | ships |
| `__giParallaxDepthMean` — mean instead of `min()` over the 4 depths | 11.53% | slightly **worse** |
| `__giParallaxDepthConst=1.0` — depth signal destroyed | 18.89%, floor 26% dimmer | much worse |
| `__giParallaxGateFade` — ramp reproj→naive on the valid-tap fraction | **6.55%** | **REJECTED** |

Read the depth pair first: **the `min()`-over-4 depth selection is innocent.** Destroying the
depth signal *adds* structure rather than removing it, which means that signal is carrying real
geometry, not noise. Neither hatch is a candidate; do not re-ablate them.

`__giParallaxGateFade` is the important one. Replacing the hard reproject/naive gate with a ramp
on the fraction of valid taps gave **6.55% — the best lateral number any arm has produced, and the
only one ever to clear §4's 0.1 gate of ≤ 8%.** It was **rejected anyway**: its falloff fell to
**−1.39**, between naive (−1.09) and snap (−1.88), handing back ~60% of the parallax correction's
far-field benefit — the exact thing §1.3 says the user complains about. **This is the
case where the block rig alone would have shipped the wrong thing** — a real 30% cut in visible
blockiness bought by re-inflating the exact long-range bleed the user complains about. §11 now
carries "judge every merge change on **both** rigs" as a standing trap.

**1b. The fixed-metre floor — hunted, three suspects cleared, owner still unidentified.** Block
size is `0.196 + 0.14·probeSpacing` m and the **0.196 m intercept follows neither lattice**.
Ablated with new hatches, same rig:

| arm | floor modulation | verdict |
|---|---|---|
| baseline | 9.39% | — |
| `__giBilateralTapScale=0` — bilateral collapsed to a single centre tap | 9.40% | **innocent** |
| `__giBilateralViewFrac=0,__giBilateralWorldEps=0.001` | 9.37% | **innocent** |
| `PROPS=aoStrength=0` | 9.38% (vs 9.39% baseline) | **AO innocent** |
| `__giNormalOffsetScale=0,__giNormalOffsetFloor=0.001` | **7.34%** (−2.05 points) | carries amplitude |

The normal offset is the only term that moved anything — and **the honest reading is amplitude,
not scale.** Three reasons it cannot be the 0.196 m intercept: the offset is voxel-proportional
(`cellMax·1.2 max 0.1`); the voxel dial is provably inert for block *scale* (5× → 1.02×, §1.1);
and zeroing it shifted the patch **mean by 4.28%**, so it is not a free win either — that lift
exists to stop self-intersection and removing it trades one artifact for another. **The
intercept's owner remains unidentified**, and the candidate list is now shorter by the bilateral
filter and AO.

**The methodology trap that cost a run, recorded so it does not cost another:** two of the first
three ablation arms were **inert by construction**, because each hatch sits inside a `max()` whose
*other* term dominated — `viewDist·0.02 ≈ 0.16 ≫ 0.001`, and `cellMax·1.2 = 0.18 ≫ 0.001`. Setting
the hatched term to zero changed nothing at all. The tell was an **exact 0.00% change rms** paired
with a garbage `−8195617107 m` block size, which is a divide-by-zero on an all-zero difference
image. An exact zero is never a measurement; it is a broken arm.

**1c. The known RC fixes we have not applied. UNTOUCHED.** The literature has named remedies for
exactly this artifact class — the *bilinear fix* and *non-linear accumulation* (both catalogued on
radiance.wiki), and Sannikov's post-publication depth-aware **"Bilinear 3D"** upscale, which the
Chalmers thesis on RC optimisation adopts specifically for 3D reconstruction quality. Each is a
merge/reconstruction change, cheap relative to Phase 2, and each is A/B-able on the block rig
under a `__gi…` hatch. **This is where 0.1's remaining 4.8 points belong**, and after 1a it is
where the next lateral gain is most likely to come from. Judge each on the bleed rig too.

**1d. The merge visibility tolerance — the falloff contract. RAN, AND FALSIFIED. Do not restart
it.** The plan was an interpolation, not an investigation: §1.3 brackets the target exactly
(`rayHitMode auto` −2.18, `occupancy-legacy` −2.97, truth −2.72), both endpoints measured on the
same rig with the same kernel, and the dial was `MERGE_VIS_TOLERANCE` / `__giMergeVisTol`
(`cascadeMerge.js:58`) acting on the `penetration = dist − parentRay.w` smoothstep. It was written
up here as the highest-value item in the document. It has no leverage at all. Bleed rig, white
channel, against a baseline of −2.18:

| arm | exponent |
|---|---|
| `__giVisTolModeAware=true`, kAngular 0 / 0.05 / 0.1 / 0.2 / 0.4 | all −2.18 |
| kAngular 10 (absurdly permissive) | −2.18 |
| `__giMergeVisTol=0` | −2.18 |
| **`__giNoVisProxy=true` — the proxy disabled outright** | **−2.18** |

Deleting the proxy entirely does not move the far field by one hundredth, so no tolerance value was
ever going to recover the −2.18 → −2.97 swing that `rayHitMode` produces. The block rig is equally
blind to it (9.38–9.39% across every arm). The two-term split shipped in `3dcff1c` is a correct
decomposition and stays, but **the controls that killed this should have run before it was built,
not after** — one `__giNoVisProxy` run costs minutes and would have saved the whole exercise. That
is the transferable lesson: for any "sweep the dial to hit the target" item, first prove the dial
is connected by disabling it entirely and checking the metric moves.

Where that leaves the falloff: the −2.18 ↔ −2.97 swing is real and belongs to `rayHitMode` itself
(§1.3), not to anything the merge does downstream of it. The two modes miss on opposite sides of
truth, which means `occupancy-legacy` was never "right" — it was masking a bias with a second one.
Whatever owns this is inside the hit classification, and it is **not yet identified**. The frozen
receiver cosine is the standing suspect (the gather applies it at the c0 texel *centre*; the
forward model predicts −2.095 against a measured −2.18) but the test for it is **inconclusive**:
raising `c0DirRes` dims the far field faster than the rig's 8-bit bracket can follow, so the
measurement runs out of dynamic range before the hypothesis resolves. That is an instrument
problem, and it is the thing to fix before spending another session on falloff.

**1g. THE SOLID-ANGLE NORMALIZATION — indirect is not invariant under `c0DirRes`. START HERE.**
Changing the angular resolution changes the ANSWER, not just its detail, and a convergent transport
cannot do that. Two independent measurements, one synthetic and one on the user's scene:

*Bleed rig*, far-field radiance at 3 m, `EMIT` fixed:

| `c0DirRes` | L3 | vs previous |
|---|---|---|
| 4 | 2.031e-3 | — |
| 8 | 1.339e-3 | ×0.66 |
| 16 | 6.864e-4 | ×0.51 |

Four-fold refinement costs 66% of the energy (≈ N^−0.78). Doubling the direction count halves the
solid angle each direction represents and doubles their number; the product must be invariant.

*User's Sponza*, live, `c0DirRes` 2 → 4 (`scripts/run-gi-shot-diff.mjs`):

| baseline luminance | share of frame | change |
|---|---|---|
| 0.0–0.1 (indirect-only) | 65% | **+73%** |
| 0.1–0.4 (midtones) | 10% | −53% … −74% |
| 0.4+ (direct-lit) | 25% | −13% |

Note the mean went *down* 11% while the indirect-only mass went *up* 73% — the reason the diff tool
buckets by baseline brightness instead of reporting a mean, and the reason this went unnoticed for
so long. Anyone who checked a scalar mean concluded "that made it darker" and moved on.

This is not new information, it is information that was written down and not acted on:
`cascadeTrace.js:130-144` already records the same non-convergence from the BRANCH A/B ("exponent
−1.44 → −2.03, which a convergent transport cannot do") and already names the suspect — "the
falloff bias's real home is the gather/merge solid-angle normalization, not this ladder". That note
sat there while 1b and 1d were scheduled and spent on other suspects.

Why it is now the top item: it is the only open lead attached to a **measured user-visible symptom**
(the "curtains too dark and contrasty" report, against a Blender reference), it explains why every
absolute-brightness result in this document is quality-tier-dependent and therefore only comparable
within a fixed `c0DirRes`, and it plausibly subsumes the falloff work — a normalization that is
wrong by a direction-count-dependent factor bends the exponent exactly the way §1.3 measures.

The acceptance test is sharp and needs no ground truth: **sweep `c0DirRes` over {2, 4, 8, 16} and
require total gathered irradiance constant within a few percent.** Fix the normalization until that
holds, then re-measure the exponent — do not tune the exponent first.

Suspects, in order: the gather's per-direction weight (`cascadeGather.js`) not carrying the 4π/N
solid angle; the merge's 2×2 angular-child accumulation (`cascadeMerge.js`) averaging where it
should sum, or summing where it should average; and the receiver-cosine application at the c0 texel
centre (§5/1d), which is a *separate* bias but lives in the same expression.

**1e. Ringing.** If the residual's ACF goes *negative* (the voxel arms already cross zero around
lag 28 px), that is ringing, not blocking, and it has its own fix in the same literature. Worth
one look at the stored `curve` arrays before assuming "blocks".

**Exit gate:** modulation ≤ 4% on the emissive arm — **9.39% today**, so this is still a 2.3×
further reduction, not a polish pass — **and falloff within 0.15 of −2.72**, which no shipped arm
has ever met and which 1a proved can be lost while the modulation gate is being passed. ≤ 6% on
the mover-path arm still stands, and the rotating arm adds a third: **detrended flicker ≤ 6% on
`MODE=emissive SPIN=20`, against 7.48% today** (§1.4). Or a written argument that the remaining
structure is *not* lattice-shaped and therefore belongs to Phase 2.

**Do NOT** start Phase 2 to fix blockiness if Phase 1 gets there. Phase 2's justification is
mover/emissive *fidelity* and the emitter cap — it is worth doing on those grounds alone, but it
is a much larger change and it must not be sold as a blockiness fix on the strength of the merge
result: two kernel fixes took 36% of the amplitude between them and **none of the block scale**.
0.4's falsification narrows the justification further — the **mover** path's detrended flicker is
already 0.48% (§1.4), so Phase 2's mover half cannot be sold as a flicker fix at all. The 7.48%
lives on the **emissive** path, and only the emissive half of Phase 2 (plus Phase 3) can claim it.

---

## 6. Phase 2 — Surface Radiance Cache (movers + emissive meshes)

**The structural change. This is the "something better than voxels" the whole plan is for.**

**Part 1 is shipped** (`7bc24f1`): `src/modules/gi/surfaceCache.js` — CPU card builder, atlas,
rect packing, concavity detector — plus `scripts/run-gi-surface-cache-test.mjs`, mutation-tested.
Nothing GPU-side exists yet. Building it forced **six corrections to this section**, each marked
inline below; the design as written before 2026-08-07 was wrong on memory by 4×, self-contradictory
on card count, and under-specified on three constants.

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

Each cached object gets a **fixed table of 6 orthographic cards** (±x, ±y, ±z). A card is a
projection of the object onto one axis-aligned plane in *object space*, rasterized into a shared
atlas rect.

Why cards and not mesh UVs: a card lookup needs only the object's inverse world matrix and its
half-extents — **both already in the header, words 0..15 and 16..18**. No mesh UV attribute, no
per-triangle attribute fetch, no index indirection in the hot kernel. That is exactly why Lumen
uses them.

**Correction (b): the slot table is ALWAYS 6. "plane: 2 cards" was wrong** — it contradicted
§6.4's own `argmax` lookup, which indexes the table directly and therefore needs a **constant
stride**. A variable card count means a per-object indirection in the hot kernel, which is the one
thing §6.2 exists to avoid, and §6.3 already says 48 words. So: every object gets **6 slots**;
what varies is how many are **active** and how many **atlas rects** are allocated. A plane
activates 2 and allocates 2 rects; the other 4 slots are marked inactive and cost 4 words of
zeros, not memory.

| classified type | active slots | atlas rects | note |
|---|---|---|---|
| OBB — box | 6 | 6 | |
| OBB — plane | 2 | **2** | a zero-thickness OBB is the exact rectangle already; 4 slots inactive |
| sphere / capsule / frustum | 6 | 6 | analytic shapes, cheap to rasterize |
| BVH mesh | 6 | 6 | Lumen's known failure mode is concave meshes; §6.7 |

**A hit that lands on an inactive slot takes the header mean-albedo fallback — the exact same path
a §6.7-demoted object takes.** One fallback, not two. That is the whole reason inactive slots are
cheap to allow.

**Correction (c): `__giSrcCards` cannot raise the card count, and now means something else.**
"6 default, `__giSrcCards` to raise" had nowhere to go: card-table word 4 is `axis|sign` = **6
representable states**, and §6.4's lookup is an `argmax` over **3 axes**. A 7th *direction* is
unrepresentable in both. Reinterpreted as **depth-peel layers in the same six directions**:

```
slot = layer·6 + axis·2 + signBit
```

which is also the only version of the knob that addresses the concave failure mode at all — on the
fin-array test mesh, argmax-card coverage goes **28.5% → 65.6% at 4 layers**. **Default stays 1
layer**, which keeps §6.4's ~15-ALU lookup exactly as written. **Layers > 1 need a layer-selection
step in the hot path that §6.4's budget does not cover** — depth-compare against `srcGeometry.b`
per layer — so multi-layer is §12's Phase 2c, not a flag anyone flips.

**Correction (d): the resolution formula had no `k` and no aspect rule.** Written as
`res = clamp(round(k · worldSize / distance), 8, 128)`, only **k = 480** satisfies both worked
examples: a 1 m crate at 30 m → `480/30 = 16` → 16²; the same crate at 2 m → 240, which
**reaches 128² only by hitting the clamp**, not by landing there. And a single `res` is wrong for
anything non-cubic — the card table already carries `resU|resV` as separate half-words (§6.3), so
the two in-plane extents are clamped **independently**:

```
resU = clamp(round(480 · extentU / distance), 8, 128)      // and likewise resV
```

Allocated at adopt time, re-allocated on a large distance change. This is the memory governor and
it is also the LOD story.

### 6.3 Data layout

**Atlas (new textures, NOT storage buffers):**

| texture | format | written | read by |
|---|---|---|---|
| `srcMaterial` | rgba16f — albedo.rgb + coverage.a | once per mesh (+ on material version change) | lighting pass |
| `srcGeometry` | rgba16f — oct normal.rg + object-space depth.b + emissive luminance.a | once per mesh | lighting pass |
| `srcRadiance` | rgba16f — outgoing radiance.rgb + age.a | **per frame** (staggered) | **the trace kernels** |

Only `srcRadiance` is bound in the hot path — **one extra sampled texture**.

**Correction (a): the memory figure was wrong by 4×.** At rgba16f (8 B/texel), 2048² is 33.6 MB
per texture and **100.7 MB across the three** — not the "≈ 25 MB" written here before. **25 MB is
the 1024² figure.** That changes the default: **start at 1024²** and tier up like
`dynamicObjectWords` already tiers, rather than opening at a tenth of a gigabyte of atlas on a
laptop.

| atlas | per texture | all three |
|---|---|---|
| 1024² | 8.4 MB | **25.2 MB** |
| 2048² | 33.6 MB | **100.7 MB** |

**Card table:** 8 words per card — `[u0, v0, du, dv, axis|sign, resU|resV, objIdx, flags]`.
**6 slots always** (§6.2's correction b) = 48 words per object, constant stride. Lives in the
**reserved tail of the occupancy bits buffer**, exactly where `OBJ_WORDS` and the BVH pool already
live (`dynamicObjectWordOffset`). Object block word **+23** becomes the card-table base offset.
Zero new storage bindings.

**Correction (f): +23 is confirmed free, and now locked — but the comment beside it is stale.**
The repo-wide scan came back clean: **no write, no read, anywhere**. `run-gi-surface-cache-test`
**locks that with a source scan**, so a future writer to +23 fails the test instead of corrupting
card lookups silently. The trap next door: the comment at `dynamicObjects.js:50-83` says
`16 + i*40` while `DYN_HEADER_RESERVED = 48`, so anyone deriving the card word from the comment
lands **32 bytes short**. Read the constant, not the comment.

### 6.4 The lookup (hot path, ~15 ALU)

At a dynamic hit the trace already returns `dynObj` (object index, via `trace({objId: true})`
riding the vec4's `pen` slot), the exact hit point, and an oct-packed normal. So:

```
pLocal  = invWorld · P                       // words 0..15, already loaded for the slab test
axis    = argmax |dot(nLocal, ±e_k)|         // 3 compares, no branch
slot    = axis·2 + signBit                   // constant stride 8 words; layer 0 (§6.2 correction c)
if (!(flags & ACTIVE)) → header mean albedo  // inactive slot = the §6.7 fallback, same path
(s, t)  = the two pLocal coords ⊥ axis, / halfExtents  →  [0,1]²
uv      = cardRect.xy + (s, t) · cardRect.zw
rad     = textureSampleLevel(srcRadiance, linearSampler, uv, 0).rgb
```

The `argmax` is over 3 axes and the slot index is a constant-stride offset — **that is why §6.2's
table cannot be variable-length and why word 4 cannot carry a 7th direction.** With
`__giSrcCards` > 1 the index becomes `layer·6 + axis·2 + signBit` and a per-layer depth compare
against `srcGeometry.b` has to be added; **that compare is not in this 15-ALU budget**, which is
why layers default to 1.

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
no card sees. Detection is cheap and is done at card-build time: compare rasterized card coverage
against the mesh's true surface area. Below a threshold, the object **keeps the header mean-albedo
path** (which stays, and stays correct) — the same fallback an inactive slot takes (§6.2). Log the
demotion by name so a content author can act on it — "split this mesh" is a real and normal answer.

**Correction (e): the threshold was unspecified, and so was what "coverage" measures.** It is
**0.65**, and it separates cleanly: the convex test mesh measures **100.0%**, the concave fin
array **28.5%**. Coverage is computed against the **argmax card only** — *not* the union of all
six — because the argmax slot is the one §6.4's lookup actually reads, so union coverage would
pass meshes whose reads still land on nothing. This is also the number `__giSrcCards` layers move:
28.5% → 65.6% at 4 layers, i.e. depth peeling is what pulls a concave mesh back over the bar
(§6.2's correction c).

### 6.8 Test plan

- **`test:gi-surface-cache`** — **SHIPPED** (`7bc24f1`, `scripts/run-gi-surface-cache-test.mjs`,
  CPU ground truth in the `test:gi-dynobj` mould). Builds cards for the six default geometries +
  a custom mesh and verifies (a) every surface point's chosen card and UV round-trips to within a
  texel, (b) atlas rects never overlap, (c) the concave detector fires at the 0.65 threshold on
  the fin array (28.5%) and not on a convex mesh (100.0%), (d) **object block word +23 is
  untouched repo-wide**, by source scan. Mutation-tested: each assertion was confirmed to fail
  when the code under it is broken, so a green run means something. Failures split into
  *structure bugs* vs *epsilon class* — that diagnostic shape is what convicted the BVH8 stride
  bug in minutes.
- **`probe:gi-mover-bounce`** — the existing hue rig. Voxel path 30.1% red excess, header path
  21.8%. Card path should land at or above the voxel path's figure *and* stay stable under
  rotation, which the header path already does and the voxel path does not.
- **`probe:gi-block-size` with `MOVER=1`** — the block size at a mover hit must now be the card
  texel, i.e. below the measurement floor. This arm is **static** (`MOVER=1` tags mobility, it does
  not animate — §1.1), so it measures block size only. Stability under rotation is a **separate,
  now-available arm**: `SPIN=20`, detrended, against the mover baseline of **0.48%** (§1.4). That
  baseline is already low, so the bar here is "does not regress", not "improves".
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
- **Do not "fix" the falloff by reverting `rayHitMode` to `occupancy-legacy`.** It overshoots:
  −2.97 against a truth of −2.72, stable across three fit windows (§1.3). Reverting trades "bleed
  reaches too far" for "bleed dies too fast" and the user will report the new one. The answer is
  the tolerance between the modes (§5's 1d).
- **Do not ship a merge change on the block rig's number alone.** `__giParallaxGateFade` measured
  6.55% — past the gate — and cost 0.55 of falloff exponent (§5's 1a).
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
  arm that is supposed to measure motion needs **`SPIN=<deg/s>`**, not this flag. The tell is
  `flick.rms` reading ~0 exactly as it does on the static arms. Every flicker number recorded in
  this module before 2026-08-07 was taken on a still frame; discard them.
- **Judge every merge change on BOTH rigs — block size AND bleed falloff.** They are not
  correlated and at least one arm improves one by wrecking the other (`__giParallaxGateFade`:
  6.55% modulation, the best ever measured, at −1.39 falloff, §5's 1a). A merge change with only
  one number attached is not measured, it is half-measured.
- **In the bleed rig, read the WHITE channel.** The red channel is bracket-limited on this rig and
  its exponent is not comparable across arms; the probe now flags this automatically, but the
  older recorded red numbers do not carry the flag.
- **A hatch inside a `max()` whose other term dominates is inert by construction.** Two of Phase
  1b's first three arms measured nothing for this reason (`viewDist·0.02 ≈ 0.16 ≫ 0.001`,
  `cellMax·1.2 = 0.18 ≫ 0.001`). The tell is an **exact 0.00% change rms**, often with a nonsense
  size like `−8195617107 m` from a divide-by-zero on an all-zero difference image. Before trusting
  an "innocent" verdict, confirm the hatch actually changed the value the shader uses.
- **A prop key that is in neither `onComponentProp`'s live route list nor `#structuralSignature`
  does nothing at all.** Found twice on 2026-08-07 and both now fixed: `aoStrength`/`aoRadius` were
  in neither, so the Inspector slider was inert while two comments claimed it was live (Phase 1b's
  AO ablation was meaningless until this was fixed); `resolveMaxPixels`/`lightShadowMaxPixels` were
  read from `component.props` but declared in **neither defaults nor schema**, so they were
  unreachable from both the Inspector and MCP. Same class of bug, two directions. Adding a prop
  means: defaults + schema + (live route **or** structural signature).
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

| phase | what | depends on | status / size |
|---|---|---|---|
| 0 | verify + commit the tree; the four missing numbers | — | **DONE 2026-08-07, all five items** |
| 1a | parallax kernel — fix the second moment, not just the centre | 0 | **DONE**, `923cd78` — 9.39%, −2.18 |
| 1b | find the 0.196 m block-size floor's owner | 0 | **RAN, NO OWNER** — bilateral, AO, normal-offset scale all cleared (§5) |
| 1d | merge visibility tolerance → land falloff on −2.72 | 0 | **RAN, FALSIFIED** — the proxy has zero falloff leverage; do not restart (§5) |
| **1g** | **solid-angle normalization — indirect must be invariant under `c0DirRes`** | — | **OPEN — start here (§5)** |
| 1f | bleed rig dynamic range — the falloff line is blocked on it | — | open, ~1 session; do 1g first |
| 1c | RC literature fixes (bilinear fix, Bilinear 3D, non-linear accumulation) | 0 | open, 1 session |
| 1e | ringing check on the stored ACF curves | 0 | open, ~1 hour |
| 2a | surface cache, CPU half — card builder, atlas, packing, concavity | 0 | **DONE**, `7bc24f1` |
| 2b | surface cache, GPU half — atlas textures, lighting pass, hot-path lookup | 2a | 2–3 sessions |
| 2c | depth-peel layers (`__giSrcCards` > 1) for concave meshes | 2b | 1 session, only if demotions are common |
| 3 | light tree + NEE; delete `MAX_EMITTERS` | 2b | 2 sessions |
| 4 | extend cache to static slots; retire voxel radiance | 2b, 3 | 2–3 sessions |
| 5 | subgroups | — (parallel) | 1 session |
| 6 | TLAS over movers | — | 1 session, on demand |
| 7 | sparse hashmap probes (Split RC) | 1 | 3+ sessions |
| 8 | Rust wgpu RT arbiter + bakers | — (parallel) | 2 sessions |

Phases 5 and 8 are independent of the main line and can be picked up whenever the main line is
blocked on a measurement.

**This paragraph used to say "start at 1d".** 1d ran and returned nothing (§5): the visibility
proxy has no leverage on falloff whatsoever, and disabling it outright moves the exponent by zero.
Phase 1 has now spent two scheduled items — 1b and 1d — on suspects that measured innocent, which
is worth stating plainly rather than burying: **the falloff owner and the block-scale owner are
both still unidentified**, and every cheap hypothesis is spent.

**Start at 1g — the solid-angle normalization (§5).** It is the only open lead attached to a
measured user-visible symptom, its acceptance test needs no ground truth (invariance under
`c0DirRes`), and it may subsume the falloff question outright. It also reframes 1f: "raising
`c0DirRes` dims the far field below the 8-bit floor" was filed as an instrument problem, but the
dimming is substantially REAL — it is this bug — so the rig's dynamic range is a smaller obstacle
than it appeared. Fix the normalization first and re-measure; extend the exposure ladder (1f) only
if the far field is still unresolvable afterwards.

After 1g: the frozen-cosine test, which either names the residual falloff owner or eliminates the
last cheap suspect and sends the question into 2b. Then 1c. 1b stays open but unscheduled — pick
it up only if a new suspect appears, because the obvious ones are eliminated and the block-scale
floor is not what the user is complaining about.

**Do not schedule another falloff sweep before 1f lands.** Two of the three falloff sessions so far
produced numbers that could not distinguish the hypothesis from the instrument.

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
