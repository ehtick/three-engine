# GI Rebuild Plan — Split Radiance Cascades (SRC)

**Goal:** replace the dense world-grid Radiance Cascades transport with Split Radiance Cascades
(Freeman & Sannikov, arXiv:2607.20384): sparse hashmap world-space probes anchored to visible
surfaces, full-length rays traced from on-screen pixels and **split** across cascade radiance
intervals by hit distance, camera-distance LODs for open worlds.

**Companion docs:** `docs/split-radiance-cascades-webgpu.md` (the WebGPU implementation guide —
read §2 below FIRST, several of its `[inferred]` sections are now corrected against the actual
paper), `docs/GI_NEXT_ARCHITECTURE.md` (prior art for phases we now supersede),
`docs/GI_MOTION_PERF_PLAN.md` (the session-30 technique review whose "KEEP RC" verdict this plan
honors — SRC **is** RC, restructured).

**Prerequisite:** commit the uncommitted session-38 working tree before any rebuild work starts.
The rebuild runs behind a backend flag against the live system; a clean baseline commit is the
only undo that survives.

---

## 1. Why rebuild — current pains mapped to what SRC actually fixes

The current system (dense probe lattice over a fitted AABB + voxel radiance field + per-cell
feedback) works, but its five most expensive open problems are all **structural consequences of
dense world-grid storage**. SRC removes the structure that causes them:

| Open pain (measured, sessions 25–38) | Root cause today | What SRC does instead |
|---|---|---|
| Small/moving emitters: 22% delivery at r=0.4 vs 66% at r=1.2; MAX_EMITTERS=4; ~6× promotion pop; 17.1ms fire-fight feedback cost | Cascade rays from fixed lattice probes can structurally miss small sources; per-cell emitter march is O(volume × emitters) | Rays are traced **from every visible pixel** and averaged into far-cascade direction bins — effective angular resolution far away is bounded by ray count, not by c0DirRes. Emitter energy at hits comes from analytic NEE (light tree), not chance |
| Open worlds: "smaller volumes does not cut it"; auto-fit AABB is a hard wall | Field + probe lattice are volume-allocated; 128³ field = 218MB | Probes exist only near visible surfaces; **LOD system** (paper §4.1) keeps probe screen-size constant → memory is screen-proportional, unbounded world |
| Settled panel residual (~10% detr): six-way exonerated → lives in screen-chain / c0 angular quantization (frozen texel-centre cosine) | c0DirRes=4 → 16 fixed directions per probe, same every frame | Per-frame R2-jittered ray directions inside bins + count-weighted averaging: the cosine seen by a bin is sampled, not frozen. Paper's C(−1) screen-space merge is a further (optional) fix shape |
| Mover popping ladder (adoption, eviction, analytic-only movers, sticky seats — ~2,500 lines of lifecycle) | Radiance is *stored in the medium*, so anything moving needs a special path in/out of the medium | Radiance is stored **at probes near receiving surfaces**; a mover is just geometry the full-length rays hit. Probes don't move; their content refreshes per frame (single-frame mode is a first-class result in the paper) |
| Feedback/trace peak cost is O(occupied cells), sleep/cadence machinery to hide it | Per-cell bounce feedback iterates the whole field every frame | No radiance field. Bounce = secondary probe cache at ray hit points (2 LODs coarser), fed temporally |

What does **not** change: the tracing medium. Occupancy bitset pyramid + hierarchical DDA +
surface records + exact dynamic objects stay as the intersection backend (paper uses OptiX; we
use our proven software tracer). The paper explicitly leaves movable objects to future work —
**our exact-dynamics and analytic-emitter machinery is the part of the current system that
survives as our competitive edge on top of the paper.**

---

## 2. Paper reconciliation — corrections to `split-radiance-cascades-webgpu.md`

The guide was written from the abstract; the full paper (fetched 2026-08-08, text extracted) is
now the authority. Differences that change the design — the guide is **wrong or incomplete** on
each of these:

1. **Scaling factors: β=4 AND γ=4** (branching *and* interval length ×4/level; guide assumed the
   classic γ-as-you-like, our current code uses BRANCH=2). The paper's core theoretical claim
   (§3.2, Appendix A): minimize `max(spatial error α, angular error ε)` *simultaneously* — γ=4
   makes ε scale with α so both stay balanced; γ=2 lets angular error dominate far cascades.
   With γ=4, **N=4 cascades** covers a scene (r₀·4³ + sky). See §11 Decision log for why this
   does not conflict with our two prior BRANCH=4 rejections.
2. **Rays spawn from PIXELS, not probe positions** (§5). One ray budget per pixel; direction from
   the R2 low-discrepancy sequence mapped through equal-area spherical mapping, sign-flipped into
   the surface hemisphere (`ω ← ω·sign(ω·n)`), globally jittered per frame. This kills the
   recessed-probe / self-occlusion bias class (paper Fig. 7/8) — do NOT implement the guide's
   "offset probe along normal" anchor heuristic for ray origins.
3. **Split assignment** (§5): ray from pixel-P hits at distance d with `r_{k-1} < d ≤ r_k` →
   cascade k gets `(radiance=L_hit, T=0)`, every cascade j<k gets `(0, T=1)`, and cascades **above
   k get NOTHING** (the "extend and deposit occlusion upward" option was tested by the authors and
   rejected for bias — guide had it as the mechanism; it is not). Deposits are cumulative sums +
   **count** per (probe, direction-bin); merge divides by count and **ignores zero-count bins**.
4. **Probe insertion** (§4, Alg. 1): per pixel insert the *nearest* c0 probe only (paper
   explicitly does NOT insert the 8 trilinear corners — "halves the amount of probes for little
   quality loss"); then each c(i−1) probe inserts its nearest c(i) probe. Gather/merge use
   **sparse trilinear**: sum found probes × weight, renormalize by total found weight. (Matches
   our earned "rejection weights are epsilons, never zeros" rule.)
5. **Direction bins are NOT octahedral** for the cascade payload. Paper footnote: octahedral and
   Clarberg schemes measured *worse* despite better uniformity. They use the **equal-area
   cylindrical mapping** (Alg. 2: φ=2πx, z=2y−1) on a 2w×w grid (w₀=4 → |D₀|=32), with the
   4→1 parent mapping being integer halving `(x/2, y/2)`. Octahedral survives in exactly one
   place: the per-probe **6×6 octahedral irradiance texture** used for final shading (§6) — which
   is where our hard-won `octahedralTexelWeight`/`octahedralUV` math gets reused.
6. **LOD system exists and is core** (§4.1 — the guide missed it entirely). Each probe carries an
   LOD index; each LOD doubles s₀ and r₀; LOD chosen by ⌊log₂(Chebyshev distance from camera)⌋
   (Chebyshev, not Euclidean — fewer artifacts with grid-aligned probes); LODs never interact;
   LOD interval starts shortened ×0.9 to overlap, with linear blending across the overlap at
   shading. This is the open-world mechanism AND the constant-cost mechanism ("probes quantity is
   nearly constant due to LODs").
7. **Hashmap details** (§6): one hashmap **per cascade**; key = 64-bit packed probe coords
   (18b/axis + 10b LOD); lockless linear probing; values are **indices into an indirection
   buffer** holding the actual per-probe direction payload (hashmap runs at low occupancy
   cheaply); hashmaps are **rebuilt every frame from the indirection buffer** — eviction is
   "don't re-insert", no deletion support needed. WebGPU has no 64-bit atomics — §4.2 below gives
   our 32-bit key design.
8. **Ray-count bookkeeping** (Alg. 3): rays-per-probe counted from pixels, propagated up cascades
   (each c(i) probe's count = Σ of its children's), then offsets assigned top-down so probes
   sharing a parent occupy **contiguous R2-sequence segments** — that's what makes every cascade's
   direction bins semi-uniformly covered. This is a hierarchical prefix-sum; plan real GPU scan
   work here.
9. **Merge optimizations** (§6): directional data stored in **Morton order** so the 4 child bins
   merging into one parent bin are contiguous; **pre-averaging** (store the already-averaged cone
   value the next level will consume, not raw per-bin cones); one workgroup per probe with parent
   probes fetched once into workgroup memory.
10. **Final shading** (§6): NOT a raw per-pixel gather over all bins (32 dirs × 8 probes = 256
    unfiltered reads — the paper calls this out as prohibitive). Instead: per-probe pass bakes the
    Lambertian rendering-equation integral into a **6×6 octahedral irradiance texture + 1-texel
    border**, then pixels do ≤8 *filtered* samples in the normal direction over the nearest
    probes. Our existing `giIrradiance` screen-target + material-sampling architecture is exactly
    the right consumer.
11. **Multibounce** (§6): a **secondary probe cache** spawned from the previous frame's ray hit
    points (same insertion/ray-gen/merge code, positions+normals from hits instead of pixels),
    sampled at all ray hits; it samples *itself* temporally → infinite bounces. Secondary probes
    sit **2 LODs coarser**. No third-bounce probes.
12. **Temporal accumulation** (§5.2): blend previous cascades with new intervals per
    (probe, bin); world-space ⇒ **zero reprojection**. Explicitly listed as naive/future work:
    adaptive ray allocation to new probes, and **movable objects are not handled by the paper at
    all** — our territory.
13. **Reference configuration + perf** (§7): γ=4, β=4, |D₀|=32, r₀ ≈ 1.6·s₀, N=4. RTX 3080
    Laptop, single frame: Sponza 8.6ms / San Miguel 11.5ms, of which trace = 1.3 / 4.5ms **with
    OptiX hardware RT**. Our tracer is software DDA — assume trace dominates and budget
    accordingly (§9).
14. **Known limitations the authors admit** (set expectations now): misses detail smaller than
    s₀; interpolation light-leak (brightened shadows in Sponza cutouts); overblurred hard contact
    shadows (San Miguel plant); up to 4× ray-density difference between nearest/farthest probes
    in one LOD. Their optional fix for sub-s₀ detail is **C(−1) merging**: per-pixel screen-space
    short-range march merged below c0 (cost warning: 23ms in their unoptimized form — treat as a
    Phase-8 experiment, not core).

---

## 3. Non-negotiable design rules (paid for across 38 sessions)

These are the recorded lessons that must constrain the SRC design from day one. Full ledger in
memory (`gi-module.md`); the ones that bind hardest here:

**Transport/estimator physics**
- R1. **No binary anything.** Admission, membership, step-exhaustion, LOD selection — every hard
  flip became regional popping. SRC touchpoints: LOD transitions (paper already blends ×0.9
  overlap — keep), probe birth (fast-α warmup, seed fresh probes from parent-level merged result),
  zero-count bins (renormalize, never zero-weight cliffs), emitter promotion boundary (energy
  calibration before caps).
- R2. **Tolerances track the quantization of whatever traced the ray** — occupancy voxel, never
  probe spacing, never field cell. Every bias/epsilon in deposit, merge visibility, and gather
  must be derived from the DDA medium.
- R3. **Step exhaustion fails CLOSED from detail, OPEN in open space** (discriminate on last DDA
  level). The full-length SRC rays are *longer* than today's interval rays — this rule gets more
  load-bearing, not less.
- R4. **In-loop feedback gain provably < 1.** The secondary bounce cache is a temporal fixed-point
  iteration: `E = π·Σ(L·cosθ)/Σcos` normalization, albedo clamp ≤ 0.9, artistic gain outside the
  loop. Three separate divergences taught this.
- R5. **Two representations of one light must agree on energy before caps/clustering matter.**
  Analytic emitter direct vs ray-hit emissive must not double count and must match magnitude at
  the handoff (§4.4).
- R6. **EMAs smooth values, not membership.** Temporal accumulation α is tuned only after probe
  population is stable frame-to-frame; fresh-probe warmup is a separate fast-α path.

**WebGPU / TSL / three.js walls (all previously hit)**
- R7. Portable budget: **8 storage buffers / 12 uniform buffers / 4 storage textures per stage**;
  `maxStorageBufferBindingSize` default 128MB — audit every buffer's worst case; query adapter
  limits first, request only what's advertised.
- R8. No float atomics → fixed-point `atomic<u32>` accumulation + resolve pass; `.toVar()` any
  atomic return before conversion (the silent-default-0 trap); any TSL soft error = data
  corruption until attributed.
- R9. `sharedFn` for anything called from >1 kernel; wrap mutation blocks in active `Fn()` stacks;
  braces in `If` arrows; no WGSL reserved words as param names; uniform nodes are not numbers.
- R10. Async pipelines skip unresolved dispatches → **destructive kernels must share compile
  freshness with their producers** (the spawn-blink class). The SRC deposit-clear must be rebuilt
  in the same wave as the deposit kernel.
- R11. Kernel size discipline: runtime `Loop`s + sharedFn, keep grid/world params in **uniforms**
  so LOD/world changes never recompile (bounds-as-uniforms is already won — keep it won).
- R12. Every A/B hatch for shader behavior is a **uniform** (`__gi*` live convention), never a
  build-time global read inside an Fn body.

**Process**
- R13. **No fix ships on code-reading evidence.** Every phase gate below is a harness number plus
  the user's eye on their real project.
- R14. **Run the isolation arm before the first fix**; paint kind-maps early; measure the
  artifact's world period, not amplitude; validate each new metric on a known-good/known-bad pair.
- R15. Never edit `src/modules/gi` while a harness or the user's editor runs; land edits, then
  launch arms; interleave A/B arms in one session; `__editorKeepRendering` on every probe.
- R16. **Zero scope drift per phase.** Each phase has a named deliverable and gate; artifacts
  discovered mid-phase get logged, not chased.
- R17. Every new component prop ships schema-declared (auto-MCP) with `test:mcp` coverage in the
  same change; typed `editor.d.ts` surface stays complete.
- R18. **GI initialization is ≤ 1 second to first correct frame** — measured by `probe:gi-boot` on
  the user's real project, never asserted. As of 2026-08-10 it is **55 s**, reproducible across
  back-to-back runs. **83% of that window is inside pipeline creation and 3.4% is GI's CPU work**
  (voxelize 41ms for 262k tris, BVH 807ms, setup 885ms) — so the CPU side already fits the budget
  and is not where any effort goes. The driver SERIALIZES pipeline compilation (§13.3: eight equal
  kernels return in a ~4s arithmetic ladder), which makes the cost **pipeline COUNT × average**, not
  kernel size — a 154kB kernel compiles 85× faster than a 16kB one. So this rule constrains HOW MANY
  KERNELS A DESIGN SHIPS, and "one more compute pass" is the decision it exists to make expensive.
  Full budget, measurement, re-ranked levers and **the four things its first version got wrong**: **§13**.

---

## 4. Target architecture

### 4.1 Frame pipeline (per frame, steady state)

```
[A] G-buffer            — reuse renderGiGBuffer (half-res worldPos+normal); add motion later
[B] Probe init          — per pixel: LOD from Chebyshev camera distance; insert nearest c0
                          probe (hash CAS); cascade ladder: c(i−1) probes insert nearest c(i)
[C] Compaction          — new probes claim indirection-buffer slots; payload cleared;
                          fresh-probe flag set; indirect dispatch args written GPU-side
[D] Ray generation      — Alg. 3: per-probe ray counts (from pixel histogram), hierarchical
                          prefix-sum offsets, R2 sequence + equal-area DecodeDir + hemisphere
                          flip + global temporal jitter
[E] Trace + split       — full-length rays through occupancy DDA (+records +exact dynamics);
                          hit shading (§4.4); fixed-point atomic deposit of (L,T,count) into
                          the containing cascade's bin, (0,1,count) into all nearer cascades
[F] Resolve deposits    — fixed-point → filterable payload; temporal blend with resident
                          probe history (per-bin α, fast-α for fresh probes)
[G] Merge               — cascade N−1 → 0; sparse-trilinear parent lookup (renormalized),
                          4→1 bin pre-averaging, Morton payload order, workgroup-per-probe
[H] Probe irradiance    — per-probe 6×6 octahedral irradiance bake + 1-texel border
[I] Screen gather       — per pixel: ≤8 probes (LOD-blended), filtered irradiance-texture
                          samples in normal direction → giIrradiance / giRadiance targets
[J] Secondary cache     — steps B–H re-run over last frame's hit points (2 LODs coarser)
                          for multibounce; sampled by [E]'s hit shading
[K] Hashmap rebuild     — next frame's hashmaps re-inserted from surviving indirection
                          entries (age-based survival), retiring stale probes for free
```

Screen chain downstream of `[I]` (materials sampling `giIrradiance`, AO, reflections, analytic
emitter direct + emitter shadows, three's shadow maps for suns) is **unchanged** — SRC replaces
the transport, not the deferred-resolve architecture, the `GICascadeLight` material injection, or
the light-instance-reuse compile discipline.

All passes stay **TSL compute with wgslFn islands** (not raw `device.createComputePipeline`):
`giCompute`, `installAsyncComputePipelines`, `sharedFn`, the compile wave, and the binding-audit
smoke all assume TSL nodes, and that infrastructure encodes more shipped failure-fixes than a raw
frame graph would save us. wgslFn is available where TSL fights us (hash CAS loops, Morton math,
workgroup-memory merge), exactly as BVH traversal does today.

### 4.2 Data structures + WebGPU adaptations

**Probe key — 32-bit, not the paper's 64-bit** (WGSL has no 64-bit atomics). The LOD system makes
this exact rather than lossy: within one LOD, probe spacing doubles with distance, so the number
of distinct cells an LOD shell can contain is **bounded by a constant**. Key layout (per-cascade
hashmap, so cascade index is not in the key):

```
[ 4b LOD | 1b secondary-cache | 9b x | 9b y | 9b z ]   x,y,z = cell coords relative to the
                                                        LOD's camera-anchored origin, offset
                                                        +256; 512 cells/axis per LOD covers
                                                        the LOD's annulus with margin
```

Insert = single `atomicCompareExchangeWeak` on the packed key (0 reserved empty, hash-mix
per the guide's PCG family). Cells outside a LOD's 9-bit window cannot occur by construction
(LOD selection clamps); a CPU-mirror test proves the bijection. If the window ever needs to grow,
fall back to a two-word CAS-claim protocol — designed but not built until needed.
**Camera-anchored origins re-quantize on large camera moves** — re-anchoring is a probe-retirement
event, rate-limited, never per-frame (R1: no binary flips per frame).

**Buffers** (respecting R7 — fold, don't multiply bindings):
- `probeHash` — one storage buffer, all cascades × {primary, secondary} at fixed offsets
  (pattern proven by the occupancy `bits` tail). Capacity per cascade ~2× expected probes;
  telemetry the load factor (guide §4.1), grow via rebuild.
- `probeTable` — indirection/header buffer: key echo, LOD, age, flags (fresh), payload slot,
  ray-count, ray-offset (Alg. 3 lives here), parent-probe slot (resolved once at init for the
  merge), irradiance-tile slot.
- `binScratch` — fixed-point deposit region: per (probe, bin) `3×u32` RGB + `u32` T +
  `u32` count. Only cascade-live slots; cleared by slot on claim (R10: clear shares freshness
  with deposit).
- `binPayload` — resolved rgba16f payload (radiance + transmittance), Morton bin order, plus the
  pre-averaged cone mirror written by the merge.
- `irradianceAtlas` — 2D rgba16f atlas of 8×8 tiles (6×6 + border), slot-addressed.
- Counts/indirect-args — small u32 buffer, GPU-written.

**Memory envelope** (1080p-class, |D₀|=32, N=4, β=4): c0 probes ≈ unique visible surface cells
≈ 30–80k typical (LOD-bounded); per-cascade bin totals are ~constant (probes ÷8, bins ×4 —
paper §5.1); order 5M live bins × (16B payload + 20B scratch) ≈ **~180MB worst-case, ~60MB
typical** — versus today's 218MB field + up to 110MB cascade buffers at ultra, and unlike today
it does not scale with world size. High-water telemetry from day one; quality tiers scale s₀ and
rays/pixel, not the world.

**No more:** dense c0 lattice, `giField` six-buffer radiance field (staging/base/radiance/
surface/normal/indirect — 96B/cell), field EMA, `distanceTexture` (checked: the soft-shadow
penumbra estimator's width probe reads it — that consumer moves to `freeRadiusAtWorld` off the
occupancy pyramid, which is already its fallback), slotRegistry's 64MB atlas spine (bookkeeping
reduces to per-mesh albedo/emissive resolution at voxelize time, which `cellAttr` already does).

### 4.3 Tracing backend — reused verbatim

`createOccupancySceneTrace` (giField.js:1534) already has exactly the contract step [E] needs —
`sceneTrace(origin, dir) → {rad, t}` over bits + surface records + `composeFieldDynamics`
(exact movers) — minus the field-sampling part of hit shading, which SRC replaces (§4.4). Extract
it (plus `pickOccTrace`, the record march, and the dynamics composition) into a standalone
`srcTrace.js` that does **not** import the radiance field. Keep:
- hierarchical DDA + pyramid skip (cannot tunnel — the property every leak hunt converged on),
- surface records for sub-voxel hit positions/normals (`hybrid-plane` default; `exact-complex`
  at high/ultra; the five-mode ladder collapses to those two — R16: deletion happens in Phase 7),
- exact dynamic objects (`composeFieldDynamics`) so movers are hit geometry, not medium,
- R3 step-exhaustion discipline and record-aware bias rules (R2).

Distance-LOD: past each cascade boundary, step up a pyramid level (far intervals tolerate coarse
geometry — and this is where software-DDA cost is won back; see §9).

### 4.4 Hit shading — where our machinery beats the paper

At hit point H with record normal n̂ (sign-aligned to occupancy gradient — the one-sided-gather
lesson): `L_hit = emissive(H) + albedo(H)/π · [ Σ_analytic_lights direct(H) + E_secondary(H) ]`.

- **Sun/directional:** analytic radiance × one shadow ray through the DDA (record-march oracle
  exists; three's shadow map is view-frustum-bound and unavailable at off-screen hits).
- **Emitters:** the promoted-slot loop is replaced by **light-tree NEE** (`lightTree.js` — built,
  MC-verified, currently unwired; this is its designed first consumer) using the
  `emitterShapes.js` closed-form factors per kind. Emissive surfaces ALSO deposit their emission
  when hit directly — so every emitter mesh must be flagged and its **hit-emission zeroed when it
  is NEE-sampled** (R5: one representation per light per path, energy-calibrated at the boundary).
  Analytic emitter **direct + emitter shadows at pixels stay in the screen chain unchanged**;
  SRC feeds indirect only. MAX_EMITTERS/promotion-pop work continues as its own workstream — but
  the 17.1ms per-cell feedback march and the per-frame emitter record trace **die with the field**.
- **Multibounce:** `E_secondary(H)` = sparse-trilinear sample of the secondary cache's merged
  irradiance (probe missing → 0 + let temporal fill; never a fixed-radius fallback — R1).
- **Mover hits:** header mean albedo/emissive Lambert shading (session-38 machinery, reused).
- **Sky:** rays that escape the last cascade composite `skyColor·skyIntensity` (existing uniform).

### 4.5 LODs and the open world

Straight from paper §4.1: LOD = ⌊log₂(Chebyshev(camera, P)/s₀)⌋ clamped to [0, 10); spacing and
r₀ double per LOD; no cross-LOD interaction; ×0.9 interval overlap with linear blend at gather.
This retires `autoFit`/`sizeX/Y/Z` as *transport* concepts (the occupancy volume still needs
bounds — that stays, and is the remaining scene-scale limit to solve separately, possibly with
occupancy clipmaps later; out of scope here — R16).

### 4.6 Temporal accumulation

Per-bin exponential blend of resolved deposits into resident payload (α≈0.1; α≈0.3 while
age < 8 frames), R2 jitter phase advancing per frame. Single-frame mode (α=1) is the **quality
gate configuration** — the paper demonstrates it usable, our flicker-frame instrument judges it,
and accumulation is only allowed to *improve* on it (R6, R13). Probe age drives survival at the
per-frame hashmap rebuild; evict-by-age (~60 frames unseen). No reprojection anywhere —
world-space probes are the point.

### 4.7 What happens to sleep/cadence

Converged-idle sleep survives in reduced form: idle ⇒ drop rays/pixel toward a floor and skip
secondary-cache refresh (cost scales down smoothly — R1 applies to cadence too), heartbeat
retained. Peak split, feedback/trace parity checkerboards, spawn fast-lane blink guards, dirty-
brick composite scoping: all deleted with the passes they scheduled. The occupancy static/dynamic
voxelize split **stays** (it schedules the medium, not the transport).

---

## 5. Keep / delete inventory

**Keep (unchanged or lightly adapted)**
- `occupancyField.js` — voxelization, pyramid, DDA, records, density pyramid, `freeRadiusAtWorld`
- `dynamicObjects.js` — shape classification, BVH4/8 builders+traversal, `composeFieldDynamics`,
  header shading, swept invalidation; **minus** the adoption/eviction lifecycle
- `emitterShapes.js` + `giLight.js` TSL twins (change together), MC arbiter test
- `lightTree.js` — promoted from scaffold to the NEE engine at hits
- `giScreen.js` — gbuffer, resolve targets, filters, history; `giLight.js` material injection,
  light-instance reuse, roughness buckets; BVH exact reflections
- `cascadeGather.js:octahedral*` math (for the irradiance tiles), `resolveMaterialSurface`,
  trilinear-sampler patterns; `giFn.js` sharedFn; async-pipeline install; compile wave; boot
  ambient; `quantizeOccupancyRes`
- Static shadow BVH8 + mover shadow oracle (sun rays at hits can upgrade to it later)
- The **entire harness stack** and `profile.giPasses`

**Delete (at Phase 7, not before — the old backend runs behind the flag until parity)**
- Dense cascade trace/merge over the lattice (`cascadeTrace.js` trace kernels, `cascadeMerge.js`
  parallax kernel + visibility proxy), dense-lattice gather path
- `giField.js` radiance field + `createBounceFeedback` (the fire cost dies here)
- Adoption lifecycle (~2,500 lines: tryAdopt/release/evict/reconcile/readopt, analytic-only
  movers, sticky seats, mover-occluder top-K in *transport* — occluder bundles for the gather die
  with the gather)
- Emitter promotion feedback march + `#buildEmitterRecordTrace`; promoted slots remain only as
  the screen-chain analytic direct (unchanged) and light-tree input
- Settle/cadence machinery listed in §4.7; `sparseField.js`; `sdf-legacy` backend; slotRegistry
  atlas spine; rayHit mode ladder (keep two modes); surface cache Phase-2 scaffold (superseded by
  the secondary probe cache — decide before more accretes on card-table word +23)

---

## 6. Config surface migration

`GlobalIlluminationComponent` keeps: `quality` (tiers now scale s₀ + rays/pixel + w₀),
`intensity`, `skyColor/skyIntensity`, `bounce` (0 = primary only, ≥1 enables secondary cache),
`bleedSaturation`, `probeSmoothing` (→ accumulation α), `reflections`/`exactReflections`, `ao`
(+strength/radius), `resolveScale`/`resolveMaxPixels`, `emissiveShadows`, `debugProbes`
(new views: probe spheres by cascade/LOD, bin heatmap, count coverage), `autoRebake`,
`bootAmbient`. Per-mesh `giMobility`/`giTrace`/`giProxy` and per-light `shadowMode` unchanged.

New: `backend: "occupancy" | "split-rc"` (default stays `"occupancy"` until Phase 6 sign-off),
`probeSpacing` → **`spacing0`** (c0 spacing at LOD 0, the ONE spatial dial — session-36 lesson:
this is the live dial; `voxelSize` remains a medium dial only), `raysPerPixel` (1–4),
`temporalMode: "single-frame" | "accumulate"`.

Deprecated (kept reading, mapped, warned): `cascadeCount` (γ=4 fixes N=4 within LOD),
`c0DirRes` (→ w₀), `probeSpacing`, `sparseField`, `backend:"sdf-legacy"`, `rayHitMode` ladder
(→ `"plane" | "exact"`), `peakSplit`, `temporalBlend`, `autoFit`/`sizeX/Y/Z` (transport no longer
volume-bound; occupancy keeps its own fit). All schema changes ship with `test:mcp` +
`test:script-typings` in the same commits (R17).

---

## 7. Phase plan

Each phase: named deliverable, harness gate, user-eye check on the real project (R13). Old
backend stays default and untouched until Phase 6. New code in `src/modules/gi/src/` (module-local
subdir: `srcProbes.js`, `srcRays.js`, `srcTrace.js`, `srcMerge.js`, `srcShade.js`,
`srcSecondary.js`, `srcSystem.js`) — GISystem grows one `backend === "split-rc"` branch that
early-outs into `srcSystem`, not tentacles.

**Phase 0 — CPU reference + math kernel tests (no GPU)**
JS mirror of the full algorithm (the lightTree/bvh mirror-test pattern): equal-area mapping
round-trip + 4→1 parent consistency, R2 sequence, 32-bit key bijection over LOD windows, hashmap
insert/collision storm, Alg. 3 count/offset prefix sums (contiguity property), split assignment
(interval containment, nearer-transparent, nothing-above), sparse-trilinear renormalization,
merge Eq. 6/7 vs brute-force MC on a toy scene, **furnace test** (uniform emissive sky, albedo 1
→ flat 1.0; interval boundaries exact, no epsilon gaps).
Gate: `test:gi-src-ref` green. *(New script; register in package.json + AGENTS test index.)*

**Phase 1 — Probe population on GPU**
Steps [B],[C],[K] + debug gizmos (instanced spheres colored by cascade/LOD). Reuses gbuffer.
Gate: `smoke:gi-gpu?src=1` — binding audit ≤8 storage, probe counts vs CPU mirror on a fixed
camera, LOD rings hug surfaces at expected radii, load-factor telemetry prints. Eye check:
gizmos over Sponza + the user's game scene.

**Phase 2 — Rays, trace, deposit, c0-only resolve**
Steps [D],[E],[F] with merge disabled; shade from raw c0 (AO-like short-range bounce look —
guide §8.3's single-level sanity). Trace via `srcTrace.js` extraction (extraction is this phase's
riskiest edit: run the full existing `test:gi-rayhit-*` + `test:gi-dynobj` suites to prove the
old backend unaffected).
Gate: single-level sanity screenshot-diffed; fixed-point resolve fuzz (no overflow at 4 rays/px
× worst count); deposits-vs-CPU-mirror on a frozen frame; sparkle = atomics race (guide §8.7 —
fireflies are impossible by construction, any sparkle is a bug).

**Phase 3 — Merge + irradiance tiles + screen gather**
Steps [G],[H],[I] feeding the existing `giIrradiance` targets — materials light up with no
material-side change. Single-frame mode only.
Gate: GPU furnace test; `probe:gi-falloff` vs analytic −2.72 (the metric the current default
fails at −2.18 — **this time a test guards the default**); `run-gi-rc-splitroom` leak rows;
`gate:gi-gather` invariance; interval-boundary ring check (guide §8.5). Eye check: Cornell +
Sponza vs old backend A/B.

**Phase 4 — LODs + temporal accumulation**
Steps in §4.5/§4.6, LOD blending, fresh-probe warmup, hashmap re-anchoring.
Gate: `run-gi-flicker-frame` ROTATE + fly-through arms ≤ old-backend baseline; `probe:gi-block-size`
ACF (expect block scale to track s₀·LOD — measure the world period, R14); memory high-water in
budget on an open-world test scene (the scene the current system cannot do — build a probe rig
for it).

**Phase 5 — Hit shading completeness: multibounce + emitters + movers**
Secondary cache [J]; light-tree NEE at hits with emitter-flag double-count guard; sun shadow rays
at hits; mover hit shading + per-probe swept invalidation (mover moves ⇒ probes whose bins saw it
get fast-α, not reset — R1).
Gate: `probe:gi-mover-bounce` (colored-mover floor hue); `probe:gi-emissive-cost` scaling (target:
sub-linear in emitter count, versus today's 0.73ms/emitter/cell-pass); `probe:gi-emitter-cap`
(past-cap delivery must not fall off the ~17% cliff — light tree has no cap); `run-gi-game-perf-probe`
fire arm vs the 20.1ms session-38 baseline; energy A/B: emitter analytic-vs-hit handoff within
tolerance (R5). Eye check: the user's emissive-projectile game, in play mode, judged in motion.

**Phase 6 — Parity sign-off + default flip**
Full probe sweep on both backends, one session, interleaved (R15): falloff, flicker, block-size,
leak rows, game perf, **`probe:gi-boot` (R18 — a backend that renders identically but takes 40s to
appear does not ship as the default)**, `profile.giPasses` on the real editor. The user's F5 is the acceptance
test. Flip `backend` default; old backend stays selectable one release.

**Phase 7 — Deletion + doc/memory sweep**
The §5 delete list; collapse rayHit ladder; retire deprecated props (mapped reads stay); update
`AGENTS.md`, `docs/`, memory. Expected net: **−8,000 to −12,000 lines.**
Gate: re-run `probe:gi-boot`. This is where R18's kernel-breadth lever is collected — the sweep's
whole point is removing code, and §13.4 item 2 predicts the 73kB kernel goes with the rayHit ladder.

**Phase 8 (optional, post-ship experiments)** — C(−1) screen-space merge for sub-s₀ contact
detail (budget-gated: paper's naive form cost 23ms); specular cones from cascade data; subgroup
pre-reduction in deposit if scatter contention shows up (guide §9 predicts it as the first perf
cliff — profile before building).

---

## 8. Test & measurement plan

- **New CPU suites:** `test:gi-src-ref` (Phase 0 scope). Every GPU kernel keeps a line-for-line
  CPU mirror where the bvh/occupancy suites set the pattern.
- **Reused gates:** `probe:gi-falloff`, `run-gi-flicker-frame`, `probe:gi-block-size`,
  `run-gi-rc-splitroom`, `probe:gi-mover-bounce`, `probe:gi-emissive-cost`, `probe:gi-emitter-cap`,
  `run-gi-game-perf-probe`, `run-gi-dark-probe`, `smoke:gi-gpu` (+ `?src=` arms), `gate:gi-gather`,
  `profile.giPasses` op. Harness rules R13–R15 and the instrument-trap ledger (§2d of the memory
  digest) apply unmodified — especially: controls first (GI on/off must differ), byte-identical
  = branch never ran, world-period metrics, exposure brackets on falloff fits.
- **New telemetry (ships with Phase 1, permanent):** hashmap load factor, probe counts per
  cascade/LOD, bin coverage % (zero-count bins per cascade), payload high-water MB, rays/frame —
  surfaced in `profile.giPasses` and a debug panel line, MCP-readable (R17).

## 9. Performance budget

Paper single-frame totals: 8.6–11.5ms on a 3080-Laptop **with hardware RT** (trace 1.3–4.5ms).
Our trace is software DDA; today's full cascade-trace pass (millions of short interval rays) runs
~5.6ms on the 4070 — SRC traces **fewer, longer** rays (~2M/frame at 1080p×1rpp vs the lattice's
probe×dir product) with pyramid-mip LOD past each cascade boundary keeping far-segment cost
logarithmic-ish. Working budget on the user's RTX 4070 @ 120fps target (8.3ms frame, GI ≤ ~4ms
steady):

| Stage | Budget | Levers |
|---|---|---|
| Init+compact+raygen | 0.6ms | scan efficiency, probe caps |
| Trace+split+deposit | 2.0–3.5ms | rays/pixel, DDA mip-LOD, record mode, ray budget under temporal |
| Resolve+merge+irradiance | 0.8ms | Morton coherence, pre-averaging, f16 |
| Screen gather | 0.5ms | resolveScale (existing cap) |
| Secondary cache | 0.5–1.0ms | 2-LOD-coarser, every-other-frame refresh |

If trace blows the budget, the ordered levers are: rays/pixel < 1 (checkerboard + temporal),
harder DDA mip-LOD, ray-count floor under accumulation (paper §5.2) — never binary pass-skipping
(R1). The current system's floor for comparison: 14.98ms GI queue on Sponza-editor, 20.1ms game
fire median. Beating those while fixing the §1 table is the success criterion — parity is not
enough to justify the rebuild.

## 10. Risks and open questions

1. **Software-trace cost is THE risk.** Mitigation: Phase 2 measures trace-only cost before any
   merge work; if 1 rpp full-length rays exceed ~4ms on the 4070 at 1080p, the temporal ray-budget
   path moves from Phase 4 into Phase 2.
2. **Scatter contention** on high-cascade bins (thousands of rays → one atomic bin). Predicted by
   guide §9; profile first, then subgroup pre-reduction (Chrome ships subgroups) or
   gather-restructure.
3. **32-bit key window overflow** at extreme LOD counts / teleporting cameras — CPU-mirror
   property test + the two-word fallback design on the shelf.
4. **Prefix-sum complexity** (Alg. 3 is the least-familiar GPU code in the plan). Fallback: paper
   notes plain per-pixel spawn with R2 still works, just with up-to-4× coverage imbalance — ship
   that first if the hierarchical assignment stalls a phase.
5. **Emitter energy handoff** (analytic direct vs hit-emission vs NEE) — R5 says calibrate before
   integrating; a dedicated Phase-5 harness arm, not an afterthought.
6. **The paper doesn't handle movers** — our per-probe swept invalidation is novel work; judge it
   with flicker-frame ROTATE/mover arms before believing it (R13).
7. **Deforming/skinned meshes** remain voxel-path-only (unchanged from today; not worsened).
8. **Dual-backend window**: two transports share giScreen/giLight surfaces for ~5 phases. The
   flag branch must stay an early-out, and every phase runs the OLD backend's suites too
   (regression = stop).

## 11. Decision log

- **γ=4 / β=4 despite two prior BRANCH=4 rejections.** The rejections (sessions 33–34 era,
  written into `cascadeTrace.js` comments) were measured on the *dense lattice with the parallax
  merge kernel at c0DirRes 2–4* — a regime where angular resolution couldn't be raised to
  compensate; both rejections were falloff/chroma verdicts of that merge path. The paper supplies
  the theory (balance α=ε), Appendix-A evidence, AND a different merge (count-weighted sparse,
  pre-averaged, no parallax re-aim). This is new-evidence re-litigation as the memory rule
  requires — and Phase 3's gate re-runs the exact falloff/chroma probes that produced the original
  rejections. If γ=4 fails those gates in the NEW architecture, that's a real finding to take
  upstream, not a config to quietly fudge.
- **Equal-area cylindrical bins, octahedral only for irradiance tiles** — paper's measured
  footnote beats our octahedral habit; our octahedral math still ships in the shading path.
- **TSL compute, not raw pipelines** — §4.1 rationale; revisit only if a measured TSL overhead
  is attributed (R13 applies to infrastructure too).
- **Screen chain, analytic emitter direct, sun shadow maps, exact reflections: untouched** — the
  user's measured pivots stand; SRC replaces diffuse indirect transport only.
- **Probe anchoring from pixels without trilinear-corner insertion** — paper measured the corner
  insertion as 2× probes for little gain; sparse renormalized interpolation instead.

---

## 12. Phase 0 results — DONE, and two plan corrections it forced

**Status:** shipped 2026-08-08, commit `5cb804d`. `npm run test:gi-src-ref` — 79 checks, green,
~2s, no GPU. Files: `srcConfig.js` (hierarchy), `srcMath.js` (math kernel), `srcRef.js` (full CPU
reference + brute-force MC arbiter), `scripts/run-gi-src-ref-test.mjs`.

Deviation from §7: the new files live in `src/modules/gi/` directly rather than a `src/`
subdirectory. The `src` filename prefix already disambiguates them and the old backend is being
deleted outright (§5 moved to the front at the user's direction), so a segregating subdir would
only add a `gi/src/srcTrace.js` path stutter. A/B baseline is a git worktree pinned at `034d8b2`
(`../engine-gi-baseline`) instead of a live backend flag.

### 12.1 The 4→1 mapping's DIRECTION (corrects §2 item 5)

§2 item 5 says the parent mapping is "integer halving `(x/2, y/2)`" without saying which cascade
the halved index addresses, and the natural reading is wrong. **Bins get FINER as the cascade index
rises** (`|D_i| = 2·w₀²·4^i`), so:

- a cascade-`c` bin consumes the **pre-average of its four finer bins at cascade `c+1`**, at Morton
  slots `4m … 4m+3`;
- halving your own bin index to address the level above reads a bin pointing somewhere else
  entirely. It costs no energy, throws no error, and delivers the wrong direction's radiance.

Caught by the furnace arm (bins read 0 instead of 1) and the boundary sweep (collapse to zero past
the first interval). Post-fix the furnace is **exact** — worst `|L−1|` = 0.00e+0 in f64.

This is also the concrete payoff of the Morton requirement in §2 item 9: the four children are
contiguous *because* `morton(2i+dx, 2j+dy) = 4·morton(i,j) + dx + 2dy`, proved in the suite.

### 12.2 The octahedral border is a CORRECTNESS requirement (sharpens §2 item 10)

§2 item 10 records the paper's "6×6 octahedral irradiance texture + 1-texel border" as a layout
detail. It is not — it is load-bearing, and here is the measured size of skipping it:

The octahedral square's centre is +Z and **all four of its corners are −Z**. Without a border, every
bilinear tap for `n̂ = (0,0,−1)` clamps onto one interior corner texel whose own direction at 6×6 is
`(0.236, 0.236, −0.943)` — **19.4° off axis**. The probe then reports a tilted normal's irradiance:
**+32%** on a −Z-facing receiver, with a blue cast borrowed from the +X wall.

It is an **axis-aligned** error, so an identical wall reads differently depending which way it
faces; it does not average out, and no temporal accumulation touches it. Post-fix that receiver is
5.8% and the pole-vs-equator penalty went **21.7pp → 2.4pp**.

**How it was attributed, which is the transferable part:** the transport arm asserts **convergence**,
not a tolerance. The error was invariant to probe spacing (29.2 → 25.5% over 4× refinement) *and* to
angular resolution (26.9 → 25.1% over 4×), and a plateau where the model predicts convergence is a
failure. A tolerance-based arm would have been set at 35% and shipped the bug. Add this to R13/R14:
**for a biased estimator, gate on the refinement trend, not on an absolute number** — the absolute
number can only ever encode today's build.

### 12.3 Smaller things worth not re-deriving

- **Bin cosine weights are a sub-sampled quadrature, not the cosine at the bin centre.** A c0 bin is
  ~0.39 sr (≈40° across); one-point quadrature over that leaves an angular bias no spatial
  refinement reaches. Because bins are equal-area in `(x,y)`, uniform sub-sampling in `(x,y)` *is*
  the solid-angle average — no Jacobian. The table depends only on `(w, tileRes, sub)`, so on the GPU
  it is a small read-only buffer (32 bins × 36 texels at c0), computed once.
- **The 32-bit key stores LOD BIASED BY ONE.** Without the bias, cell `(−256,−256,−256)` at LOD 0 in
  the primary cache packs to exactly `0` — the hashmap's EMPTY sentinel — i.e. a probe at the
  camera's own cell that silently does not exist. Costs one of 16 LOD codes; `MAX_LODS` is 10.
- **`lodBlend` is deliberately discontinuous at integer LOD; the SHELL WEIGHTS are continuous.**
  Just below `lodF=1` the shells are `{LOD0:0, LOD1:1}`; just above, `{LOD1:1}` — same shell, same
  weight. Testing `lodBlend` directly reports a 1.0 jump no pixel can see. `lodShells` /
  `lodShellWeight` are the API and the R1 continuity gate measures those.
- **`|D₀|=32` is not the accuracy floor** — with the border in place, w₀ 4→16 moves the worst
  receiver only 7.6% → 9.2%. The `SRC_QUALITY.ultra` w₀=8 is cheap insurance, not a fix for
  anything measured.

### 12.4 Instrument faults, logged because they cost the most time

Three arms had to be rewritten because the **instrument** was wrong, not the code — R14 in
practice, and each is a trap the GPU phases can repeat verbatim:

1. **A 1e-9 bar on f32 storage.** Tiles are `Float32Array` because the GPU atlas is; π is only
   representable to ~6e-8 relative. The exactness claim belongs on the f64 merged bin value, not on
   the tile.
2. **An absolute R2-discrepancy threshold.** 256 points on 64 cells has mean 4, so a cell range of 4
   is excellent — and my threshold of 3 failed it for no reason. The claim is "better than random";
   the gate is a random control.
3. **Pixel jitter that pushed samples through the walls.** A pixel outside the room is not a gbuffer
   sample any renderer can produce, and the fixture traced it as an entry rather than an exit — so
   the estimator was fed invalid geometry and then blamed for the result (a spurious 30%). Jitter is
   now tangential, on the receiver's own plane.

### 12.5 The deletion sweep's blocker — recorded, then RESOLVED in §12.6

> **Status: cleared.** The blocker below is preserved as written because its *reasoning* is the
> thing to learn from; the premise it rests on turned out to be false, and §12.6 has the
> measurements. Read both — the mistake is more instructive than the conclusion.

`srcTrace.js` is extracted (geometry-only: `{hit, t, position, normal, dynObj}` — the old
`createOccupancySceneTrace` fused trace with field-sampling hit shading, which SRC replaces).

The deletion sweep was then attempted and **reverted**, because dry-running it surfaced a hard
dependency the plan assumed away. Recording it here so the next attempt starts from the real
constraint rather than rediscovering it.

**What was verified first (all good news):**

- The delete cluster is genuinely self-contained. `slotRegistry`, `instanceGrid`, `sparseField`,
  `surfaceCache{,Gpu,Light}` are reachable ONLY through `giField.js` and `GISystem.js`. No surviving
  file imports any of them; `giScreen.js` and `giLight.js` never touch `volume` at all — they take
  what they need as parameters. Deleting the ten files costs **−9,797 lines** (33,333 → 23,536).
- `npx esbuild src/modules/gi/index.js --bundle --external:three*` is a 16s verification loop, and
  because JS requires private names to be declared, it also catches calls to deleted `#methods`.
  That is the right harness for this surgery.

**The blocker.** `giField.js` cannot be deleted as a unit, because it owns `distanceTexture` — the
composited **continuous** distance field — and two of its consumers are in the **surviving screen
chain**, not in the transport:

- `createShadowTrace` → `volume.createSoftShadowTrace`, which is `light.shadowTraceFn` (emitter
  shadows at pixels) and the GI-traced light shadows in `#buildLightShadow`;
- `createWidthProbeFn` → `volume.createWidthProbe`, the mid-field penumbra width term.

Both take their **base** distance from `texture3D(distanceTexture, …)` (`giField.js:1034` and
`:808`). §4.2 says this consumer "moves to `freeRadiusAtWorld` off the occupancy pyramid, which is
already its fallback" — **it is not a fallback, it is a refinement**: under `killSdf` the code reads
`dRaw.assign(dRaw.min(occField.freeRadiusAtWorld(...)))`, i.e. the oracle only *sharpens* a distance
the SDF texture supplied.

Why that matters rather than being a detail: the penumbra estimator is `min(k·d/t)` with
closest-approach interpolation, which **needs a continuous d**. `freeRadiusAtWorld`'s near field
measures distance to occupied VOXEL AABBs — a staircase of boxes. Swapping it in wholesale is
exactly the failure the surrounding comments were written to fight ("dirty shadows", "squarish light
changes", the fp16-not-u8 note explaining that distance error becomes penumbra error amplified by
k/t).

**So the sweep needs one preceding piece of work, with its own gate:** a `srcVolume.js` holding the
world uniform bundle plus an occupancy-only `createSoftShadowTrace` / `createWidthProbe`, and a
measured A/B of soft-shadow quality against the current composited-distance version before the
distance field is allowed to die. That is a shadow-quality change, and it is separable from — and
must land before — the transport deletion. Note this also means the composited distance field is
**not** pure transport machinery, which is the assumption §5's "Delete" column encodes.

### 12.6 §12.5 step 1 DONE — and the blocker's premise was false

**Status:** shipped 2026-08-09. Files: `srcVolume.js` (world bundle + oracle-direct
`createSoftShadowTrace`/`createWidthProbe`), `srcVolumeRef.js` (CPU mirror of both distance arms +
the ground truth), `scripts/run-gi-src-volume-test.mjs` (`npm run test:gi-src-volume` — 17 checks,
green, ~7s, no GPU). A/B seam: `__giSrcVolumeShadows = "probe" | "trace" | "both"` in `giField.js`,
sharing giField's own `world` bundle so the arms differ in exactly one thing.

#### 12.6.1 One line refutes the blocker

§12.5 argued the oracle is "a staircase of voxel boxes" that cannot replace a continuous distance.
That is true of the SDF-baking build. In the shipping build, `giField.js`'s composite is:

```js
minD.assign(occField.freeRadiusAtWorld(p, undefined, true, world.capWorld))   // giField.js:216
```

**The composited distance field IS the oracle** — resampled onto the 0.33m radiance lattice,
quantized to fp16, read back through hardware trilinear. The two "different distance sources" are
one function, one of them low-passed. So the question was never "can a staircase replace a smooth
field"; it was "what does removing a blur cost". `killSdf` is `!!occField`, i.e. always on, so
every SDF-era branch the §12.5 reasoning leaned on is unreachable code.

The transferable rule: **before accepting a dependency as load-bearing, read what actually feeds
it.** §4.2 called the oracle this consumer's "fallback"; §12.5 corrected that to "a refinement, not
a fallback" and got closer but still wrong. It is neither — it is the *source*.

#### 12.6.2 What the CPU arbiter measured

Synthetic room, 64³ voxels @ 0.125m under a 24³ coarse lattice @ 0.333m (the shipped ratio); truth
= exact distance to the nearest occupied level-0 voxel AABB, brute-forced. Every number is
restricted to the band where the value is *used as a distance* (below `0.85·capWorld`), because
every consumer gates saturated samples out of the estimator entirely.

| | oracle-direct | composited texture |
|---|---|---|
| conservative in-band | **0 violations** | overshoots on 7.6% of samples |
| …of which from a saturated corner | — | 77 samples, mean **0.64m**, max **1.86m** |
| contact band `|d−truth|` (< 2 voxels) | **0.0178m** | 0.0411m |
| hugging floor @ 1.5 vox | **0.0229m** | 0.0473m |
| per-step `|Δd|`, mean / worst | 0.0040m / 0.248m | 0.0025m / 0.030m |
| **penumbra width vs truth** (mean) | **0.186** | 0.212 |
| penumbra closer to truth on | **528 rays** | 277 rays |

- **Smoothness is the one place the oracle is genuinely worse: 1.64× the mean per-step |Δd| and
  8.18× the worst.** ⚠️ *An earlier revision of this section claimed 0.99× / 2.4× and called the
  cost "nil". That was wrong* — a stale reading taken before the arm's in-band gating was
  finished, and it was overstating the case for the change it was justifying. The suite prints the
  live ratio on every run; trust that line, not a number copied out of it.
  What makes the flip correct anyway is that the discontinuity is **bounded and invisible**, not
  absent: the worst oracle jump is 0.248m = 1.99 voxels, inside the ladder's own predicted bound of
  0.5·voxel·2^L = 1.0m (the one thing this arm *gates*, so a violation means a mirror bug rather
  than a surprise) — and `grain`, the GPU instrument that exists to catch exactly this failure
  (a quantized distance etching a regular pattern into a floor), does not move: 0.0305 → 0.0307 on
  the shipping path, 0.0250 → 0.0255 with the slab, and 0.0162 → **0.0153** on the sphere arm.
  A 2-voxel C0 step in `d` is real and sits below the visibility floor of `k·d/t`.
- **The composite is not conservative, and cannot be.** Trilinear interpolation of a 1-Lipschitz
  function overshoots between samples (measured ≤ 0.098m, under a third of a cell — the Lipschitz
  bound). The *large* overshoots are a different mechanism: interpolating a real distance against a
  **saturated** neighbour blends in `capWorld` itself, so a cell a voxel from a wall reports metres
  of free space. That is a leak the oracle structurally does not have.
- **Whole-band `|d−truth|` marginally favours the composite (0.5375 vs 0.5571) and that is not a
  point in its favour** — it wins on 990 samples, and it reached 67 of those by reporting more free
  space than exists. Both arms are lower bounds, so averaging one upward moves it toward truth: the
  blur buys mean absolute error with exactly the conservativeness it gives up. **A gate on
  `|d−truth|` rewards the leak.** This is why the decisive arm is the estimator's *output*.

#### 12.6.3 What the GPU A/B measured

`run-gi-emitter-shadow-probe.mjs` — the waffle-grid instrument, chosen because its headline metrics
*are* the failure class §12.5 predicts: `grain` is the voxel-lattice number, `leak` the seal. Reads
back the emitterShadow texture materials sample, not a screenshot. New env `SRCVOL=probe|trace|both`,
composes with `HATCH`.

| arm | penumbraPx | grain | leak (`SLAB=1`) |
|---|---|---|---|
| record march + composited probe (**shipping**) | 16388 | 0.0305 | 0.2819 |
| record march + **oracle** probe | 16601 (+1.3%) | 0.0307 (+0.7%) | 0.2819 (identical) |
| sphere arm + composited | 11696 | 0.0162 | 0.2824 |
| sphere arm + **oracle** | 12333 (+5.4%) | **0.0153 (−5.6%)** | 0.2836 (+0.4%) |

No grain regression on the shipping path and a 5.6% grain *improvement* on the sphere arm — the
opposite direction from the prediction. Both arms gain penumbra coverage, which is the expected sign:
removing the composite's undershoot raises `d`, so `k·d/t` widens the soft band.

**The identical leak on the probe arm is a positive result, not a dead branch** — the width probe is
WIDTH ONLY NEVER ADMISSION, so it structurally cannot move the seal, and `grain`/`penumbraPx` both
moved, which is the branch-ran control. (Byte-identical output = the branch never ran — the standing
harness rule.)

**Cost**, `run-gi-shadow-perf-probe.mjs` on the real project, 240 frames: GPU median
**1.41ms → 1.56ms** (+0.15ms, +11%) for the probe arm; frame median 15.1 → 15.0ms (noise). The
oracle is ~59 buffer fetches per tap against one texture fetch and it costs a tenth of a millisecond,
because 12 taps × one light is not where the frame goes. Compile-wave numbers moved both directions
(materials 9.8→17.0s, computes 37.2→34.5s) — headless wave timings are noise, per the session-15 trap.

#### 12.6.4 Binding safety, checked rather than assumed

`giLight.js:955` states a hard rule: the in-material emitter fallback "must never compile the
occupancy bits buffer into fragment shaders", and that fallback (`giLight.js:1332`) uses
`shadowTraceFn` = `createSoftShadowTrace`. So the `trace` arm looks like it violates it.

It does not, and the reason matters: **the existing `createShadowTrace` already binds `bits`** — its
refinement call `occField.freeRadiusAtWorld(p, 2, true, …)` (giField.js:1069) is unconditional under
`killSdf`. Whatever shader compiles that trace today already has the buffer. The srcVolume arm reads
the same buffer through the same `sharedFn`, so it adds **no new binding to any shader**. The width
probe is the one that gains a `bits` read — and its three consumers (`#buildLightShadow`,
`#buildEmitterRecordTrace`, the feedback compute) are all computes that already bind it; it never
enters a material. Nothing moves against the 8-storage-buffer wall.

#### 12.6.5 Two findings worth not re-deriving

1. **`capWorld = 16·minCell` is 2.67× the oracle's real ceiling, and it costs a 23% false-open
   rate.** The oracle's largest emptiness proof is `voxel · 2^(OCC_LEVELS−1)` = 16 *voxels*; the
   consumers' `d < 0.85·capWorld` cut is sized off 16 *coarse cells*. Measured on the same scene:
   samples reporting "open space" while truth says a wall is inside the cut fall from **23.3% → 4.1%**
   when `capWorld` is the oracle's own ceiling, and the saturated-corner smear falls from 1.86m to
   0.35m max. `createSrcWorld(bounds, null, occField)` derives it that way and the CPU suite runs both
   settings end to end. Not adopted yet — it changes the width probe's reach (5.3m → 2.0m) and is
   therefore its own A/B, not a free win to fold into this one.
2. **The oracle is blunter than the composite in the 2–8 voxel band** (hugging @3 vox: 0.203m vs
   0.148m) and this is structural, not a bug. The near field is a 3×3×3 at level 0, so it reaches
   ~1.5 voxels; past that the ladder's *2×2×2* blocks give bounds in [0.5, 1]·voxel·2^L, a ~1.4×
   average and 2× worst underestimate. **The fix, if the mid field ever needs it:** make each ladder
   level a 3×3×3 (bounds move to [1, 1.5]·voxel·2^L) and add the near field's AABB-gap term to it —
   27 taps per level instead of 8. Adding the gap term to the *current* 2×2×2 buys nothing, because
   `min(gap, inset)` is already pinned by the smaller inset. Out of scope here: it is a change to
   `occupancyField.js` shared with the composite, the AO taps and the burial gate.

#### 12.6.6 What this did NOT do

- **The sphere trace is the fallback arm, not the shipping one.** The shipping default for both
  surviving consumers is the *record march* plus the analytic width probe; `createSoftShadowTrace`
  survives as `light.shadowTraceFn` (resolve compute, four emitter slots), the in-material emitter
  fallback, and the records-absent light arm. §12.5 listed both consumers without this ordering — the
  **width probe is the load-bearing one**, and it is the arm to watch.
- No user-eye check on the real project yet (R13). The numbers say the shipping path is unchanged to
  within 1%, so this is a confirmation step, not a gate.
- `run-gi-rc-penumbra.mjs` is **partly broken and was not used**: two of its three arms report
  `shadowMin ≈ lit` (39 vs 40) and the first returns `edgeWidth null`. Pre-existing, unrelated to
  this change, and worth fixing before it is trusted as a gate again. It gained `PRESET_GLOBALS`/`TAG`
  support in the attempt, which is inert when unset.

Order from here:

1. **The §5 deletion + the GISystem rewrite as ONE edit** — unblocked. They are one unit, since the
   dense transport's removal and the SRC orchestrator's arrival are the same edit to the same
   8,326-line file. `giField.js` keeps `distanceTexture` alive only for the debug SDF view and the
   mirror trace at that point; the two shadow consumers move to `createSrcVolume`. Verify each step
   with the esbuild loop.
2. Then Phase 1 (GPU probe population), diffed against `srcRef.js`'s mirror on a frozen frame.
3. Deferred, each with its own A/B: the `capWorld` derivation (12.6.5 #1), the ladder's 3×3×3
   widening (12.6.5 #2), and retuning `planeCut` 3.5→2.5 voxels and the width probe's
   `0.6·planeHeight` gate now that the undershoot those numbers fight is measurably gone
   (`__giSrcWidthPlaneFactor` exists for it).

---

### 12.7 The deletion sweep, part 1 — two more §5 errors of the §12.5 kind

**Status:** the sweep is UNDERWAY and green, not finished. Commits on `feature/gi-src`:
`8fa692b` (octahedral rescue), `a41924f` (oracle becomes the default shadow distance),
`4bbd28f` (debug views rehomed, SDF view rewritten), `9d4bd5e` (surface radiance cache deleted).
Module: **33,355 → 30,398 lines**. Every commit passes the esbuild loop, the CPU suites, and the
emitter-shadow GPU probe.

Ordered leaf-first on purpose. §12.6 called the deletion and the GISystem rewrite "ONE edit"; that
is true of the dense transport and false of everything around it, and the leaves are where the
surprises were. Each stage below left the tree green and the GPU numbers unchanged, so any later
regression is attributable.

#### 12.7.1 Two more delete-list entries that a consumer actually needs

Same failure mode as §12.5, found the same way — reading what feeds a thing before deleting it.
**§5's delete column is not trustworthy as written; audit each entry against its callers.**

1. **`#buildEmitterRecordTrace` MUST SURVIVE.** §5 deletes it in one bullet with the "emitter
   promotion feedback march", but they are different machinery: the feedback march is transport, and
   this is the **record-march emitter shadow** — the shipping default for emitter shadows at pixels
   (§12.6.6 already named it the load-bearing consumer). It depends on `volume.occupancyField`,
   `volume.rayHitMode`, `volume.createWidthProbe` and `this._dynSet` — every one of which survives.
   Deleting it would have silently removed the good emitter-shadow arm and left the sphere fallback.
2. **`createMirrorTrace` is ALREADY DEAD CODE.** §12.6's own closing order justified keeping
   `distanceTexture` alive for "the debug SDF view and the mirror trace". There is no mirror-trace
   caller — `volume.createMirrorTrace` appears nowhere outside its own definition and two comments.
   Mirror rays moved to the BVH path. So the SDF debug view was the *only* remaining reason, and
   rewriting it (12.7.3) removes the last one.

#### 12.7.2 The octahedral map had to be rescued before its file died

`cascadeTrace.js` owns the four TSL octahedral functions, and §5's keep-list wants them (SRC's ray
bins are the paper's equal-area cylindrical ones, but its **irradiance tiles** are octahedral). Moved
to `srcOctahedral.js` verbatim; `cascadeTrace` imports `octahedralDirection` back rather than keeping
a second copy, so there is exactly one definition at every point in the sweep. The comments moved
with them because they carry measured results (the 2.73× solid-angle Jacobian, the reciprocal-cube
weight). `run-gi-gather-invariance-test.mjs` is the arbiter for the CPU/TSL pair.

#### 12.7.3 The "SDF" debug view is now a DISTANCE view, and it shows more

It marched `distanceTexture` and shaded from the normal the composite mirrored into `.gba`. Both die
with the transport, so it now sphere-traces `volume.distance` — literally the closure the shadow arms
take, which is what keeps the standing rule true (a debug view that renders a different field than
the traces lies about the thing it exists to show). Normal comes from six central-difference taps of
the oracle, at the hit only. Per §12.6 this is a fidelity *gain*: no lattice resample, no fp16 step,
and it sees the sub-voxel plane fits the records carry.

`srcDebugViews.js` takes both views (the occupancy one moved byte-for-byte, which turned out to be
the control that mattered).

#### 12.7.4 Harness findings, and why four of five failures were the instrument again

`run-gi-debug-views-probe.mjs` (`probe:gi-debug-views`) exists because TSL graphs build eagerly but
WGSL only compiles when a mesh first renders, and these views start hidden — so **the bundle check
cannot see a broken overlay shader.** It immediately caught a real bug: `MeshBasicNodeMaterial` off
`three` instead of `three/webgpu` throws "is not a constructor" at RENDER time.

Then four instrument faults, each of which reported "the overlay shader is broken":

1. **`gi.props.debugProbes = mode` does nothing.** A raw props write skips the component's prop
   accessor, so `onPropChanged` → `onComponentProp` → `#applyDebugVisibility` never fires. Use
   `setProp`. (Generalizes to every probe that pokes a component prop.)
2. **A full-page screenshot measures the editor's chrome.** The viewport panel is a few hundred
   pixels of a 1000×700 page, so every arm scored 98.9% coverage at identical mean luminance whether
   the overlay drew or not — the panel LAYOUT was the measurement.
3. **OrbitControls owns the camera's orientation**, so writing `engine.camera.position` + `lookAt` is
   reverted on the controls' next update and the probe aims at a room it never sees.
   `__editorApi.viewport.setCamera(pos, target)` is the supported path and calls `orbit.update()`.
   `src/editor/api/ops/viewport.js:187` says this in a comment. **This is the leading suspect for
   `run-gi-rc-penumbra.mjs`'s broken arms** (§12.6.6): it aims `engine.camera` and then projects
   world→screen through it, so it samples pixels that are not where it thinks they are. Fixing that
   probe should start here.
4. **Diffing a no-gizmo control against a with-gizmo arm measures the GRID** — that produced a
   meaningless Δ=1.55 that nearly read as "the overlay works".

And one structural fact worth keeping: **`viewport.screenshot` disables `EDITOR_LAYER`, and these
overlays are on it**, so the offscreen capture is a *structurally blind* instrument for them —
every arm's Δ is exactly 0.00 there, which looks identical to a shader that never drew.

OPEN, and deliberately not gated: in the headless rig **both** views march and then discard
essentially every pixel (the mesh is drawn — draw calls 13→15, GPU 0.7→1.5ms — and the frame moves
by less than the temporal-accumulation noise floor). This is equally true of the occupancy view,
which this sweep only *moved*, byte-for-byte. **Symptom-invariance across the swap puts the cause in
the rig, not the rewrite**, so the probe gates page errors and reports the picture. Two untested
candidates: a storage buffer read from a FRAGMENT stage (giLight.js:955 forbids exactly this for the
occupancy bits, and these overlay materials are the one place they deliberately do it), and headless
WebGPU. The real check is a person switching Debug View in the editor.

#### 12.7.5 What the surface-cache deletion cost, and what it left

Taken first because it was **default off both ways** (`__giSurfaceCache`, the `surfaceCache` prop),
so no shipped behaviour could depend on it, and §5 files it as Phase-2 scaffold superseded by SRC's
secondary probe cache. −2,957 lines. GPU probe **16601 / grain 0.0307 — identical** to the commit
before it, which is the intended result for a dead default and the control that says so.

Two things left standing on purpose:

- **`dynamicObjects.js` keeps card-table word +23** plus `setCardTable`/`cardFrameAt`. Inert now, but
  removing them is an `OBJ_WORDS` layout change to a SURVIVING file with its own suite
  (`test:gi-dynobj`) — its own unit. This is precisely the "decide before more accretes on card-table
  word +23" that §5 flags, and the decision is: it goes, but not inside this sweep.
- giField's mover-hit shading keeps an always-taken `cached` branch where the cache lookup was,
  rather than unwrapping a TSL `If` inside a function that dies with the file.

#### 12.7.6 Pre-existing RED gates — neither caused by this sweep

- **`gate:gi-gather` fails 6 cases**, identically at the pinned baseline worktree (`034d8b2`).
  Verified by running it there, not assumed.
- `run-gi-rc-penumbra.mjs` still reports `shadowMin ~ lit` on two arms — see 12.7.4 #3 for the likely
  cause.

Do not read either as sweep damage, and do not treat them as green either.

Order from here:

1. **D2+D3 as one unit: the dense transport.** `cascadeTrace.js` (trace kernels), `cascadeMerge.js`,
   `cascadeGather.js`, `giField.js`, and with them `sparseField.js`, `instanceGrid.js` and the
   `slotRegistry.js` atlas spine — plus the GISystem half that drives them (most of `#rebuild`, the
   transport part of `#tick`, and the ~2,500-line adoption lifecycle). These genuinely are one edit:
   `giField.js` no longer has a single surviving consumer (12.7.1 #2 and 12.7.3 removed the last
   two), so it dies as a unit, and the two shadow consumers move to `createSrcVolume`.
   The surviving chain must keep working with NO diffuse indirect until Phase 3 — the screen chain,
   AO, reflections, emitter direct and sun shadows all stay, so `#buildScreenResolve` needs to
   tolerate a null gather. Check that first; it is the load-bearing unknown of the whole edit.
2. Then Phase 1 (GPU probe population), diffed against `srcRef.js` on a frozen frame.
3. The deferred A/Bs of §12.6.5, plus `dynamicObjects`' card words (12.7.5).

---

### 12.8 The dense transport, part 1 — the load-bearing question, answered; and the unit re-scoped

**Status:** the prerequisite is landed and measured (`e9bffc9`); the deletion itself is NOT started.
§12.7's closing order named one thing to check first and it turned out to be the smaller of the two
things this section found.

#### 12.8.1 Can the screen chain run with a null gather? Yes — but not for the reason it looked like

§12.7 asked whether `#buildScreenResolve` tolerates a null `gather`. The material side already did:
giLight's `light.gatherFn` is the **non-deferred fallback only** (giLight.js:1296), the deferred path
keys off `giIrradianceNode`, and the guard at giLight.js:1163 accepts either. So the only live
consumer was `createGiResolve` itself, and making it optional is four lines.

**The real hazard was next to it, and it is a survivors'-plumbing bug, not a delete-list one.** The
camera position was a field of the CASCADE RADIANCE bundle:

    const radiance = radianceLookup ? { lookup, cameraPosition: uniform(new THREE.Vector3()) } : null;

Four things read it and exactly one is about reflections — the resolve's back-face `facing` flip, the
gather's view bias, the reflection-hit incident ray, and (via `radiance?.cameraPosition ?? null`) the
**emitter shadow pass**. Delete the cascades and `radiance` is null, at which point three surviving
passes stop flipping back-faces: `facing` degenerates to `+1`, the emitter pass takes its own
documented `cameraPosition = null` fallback, and a double-sided wall seen from inside a room gathers
the wrong hemisphere — the exact artifact giScreen.js:291 and giLight.js:1184 both exist to prevent.

Nothing shipped with `radiance` off, so nothing shipped broken. **The deletion is what would have made
it real — and as a "pure removal" of a dead field, with no diff to point at.** That is the §12.5
failure mode relocated: not an entry in §5's delete column, but a survivor whose input arrives through
the thing being deleted.

Fixed ahead of the deletion, so the fix is measurable in isolation: one system-owned
`_giResolveCamU`, persistent across rebuilds (the tick holds the only reference that matters, and the
resize path re-binds the same one), passed explicitly to the resolve, the reflection-hit shading and
both emitter-shadow-pass call sites. `radiance` keeps only `{ lookup }`; the tick's camera write is no
longer gated on it. `bvhShade.cameraPosition` went the same way — two uniforms that merely happen to
be written from the same camera each tick are one write-ordering bug away from striped reflections.

Behaviour-preserving today, and **measured** rather than asserted: emitter-shadow GPU probe
`penumbraPx=16601 grain=0.0307`, identical to the four commits before it. That is the whole point of
doing it as its own commit — after the deletion there is no arm left to compare against.

A null gather now compiles the diffuse term out rather than multiplying by zero, and takes the AO
ladder with it (~50 oracle fetches per pixel to modulate a zero). An exact-reflection hit falls back
to its direct terms: dim, but correct, where a missing base would have been black.

#### 12.8.2 `giField.js` does NOT die as a unit — it SPLITS, and `createSrcVolume` is the survivor half

§12.7's order says "`giField.js` no longer has a single surviving consumer … so it dies as a unit".
**That is wrong**, and the count says so immediately: GISystem uses `volume.occupancyField` **28
times** and `volume.world` **12 times**, and both reach it through giField's return object. Its
return mixes two unrelated things:

| survives (the spine) | dies (the dense transport) |
| --- | --- |
| `world` (the uniform bundle), `res`, `bounds`, `cell`, `minCell`, `capWorld` | `compositeCompute`, `distanceTexture` |
| `occupancyField`, `occupancy`, `distance` | `staging`/`base`/`radiance`/`surface`/`normal`/`indirect` buffers |
| `rayHitMode`, `createSoftShadowTrace`, `createWidthProbe` | `grid`, `sparse`, `updateGrid`, `updateSparse`, `coarseLevel` |
| `setBounds` (the world/occupancy half of the refit) | `atlas`, `createSceneTrace`, `readbackStats` |

The good news, and it makes this much smaller than the table suggests: **GISystem already builds the
occupancy field itself** (`createOccupancyField` at GISystem.js:6827, with the whole binding-size
degrade ladder around it). giField merely re-exports it. So the split is not a rehoming of the
pyramid — it is `createSrcVolume` growing the handful of spine members giField currently adds, and
GISystem calling it instead of `createGiField`.

`srcVolume.js` already has the right nucleus: `createSrcWorld(bounds, res, occField)` builds the same
uniform bundle **and already has `refit(nextBounds)`** — the world half of `setBounds`. What it needs
is the top-level value mirrors (`res`/`bounds`/`cell`/`minCell`/`capWorld`, ~9 call sites between
them) and a `setBounds` that calls `world.refit` + `occField.refit()` and drops the atlas/grid/sparse
invalidation that dies with them.

**And §12.6.5 #1 (the `capWorld` derivation A/B) is a no-op — close it.** giField: `SDF_CAP * minCell`
with `SDF_CAP = 16` (giField.js:35). srcVolume: `16 * minCell` (srcVolume.js:113). Identical, by
independent derivation from opposite ends — the byte-quantized texture's useful reach and the
pyramid's own `voxel · 2^(OCC_LEVELS-1)` ceiling. The surviving question is **which lattice**, not
which multiplier: `createSrcWorld` accepts `res: null`, in which case `cell` comes from
`occField.voxel` (the voxel lattice) instead of `size/res` (the cell lattice), and those differ by a
factor of ~3.3 at the shipping presets. Pass `res` and the two agree exactly; that is the arm to take
into the split, and the `res: null` mode is a separate, later question.

#### 12.8.3 `slotRegistry.js` splits too — the fourth §5 delete-column error

§5 files `slotRegistry.js`'s "atlas spine" for deletion and §12.7's order repeated it as if the file
went with it. **GISystem imports nine symbols from it** (GISystem.js:39-49), and they fall on both
sides of the cut:

- **Survives — slot/placement IDENTITY**, which the occupancy path stands on: the `SlotRegistry`
  class's `allocateSlot`/`releaseSlot`/`setAnalyticSlot`/`worldMatrixOf`/`refreshSlotTransform`/
  `refreshTransforms`, plus `slotKeyOf`, `geometryContentHash`, `instanceCapacityFor` and
  `MAX_INSTANCE_SLOTS`. `field.setSlotMatrix(p.slot, …)` and `field.setGeometry(geometries,
  placements)` are the occupancy field consuming exactly this.
- **Dies — the SDF TILE ATLAS**: `acquireTile`/`releaseTile`, `setSlot(…, sdf, …)`, `sampleSlot`,
  `refineDetail`, `encodeMeshSdf`/`decodeMeshSdf`, `MESH_SDF_*`, `SLOTS_PER_LAYER`,
  `MAX_ATLAS_LAYERS`, `MAX_MESH_SDF_SLOTS`, `DETAIL_SLOTS`, `atlasCapacityFor`.

So the corrected unit is **split two files, delete five** — not "delete seven". `cascade{Trace,Merge,
Gather}.js`, `sparseField.js` and `instanceGrid.js` do die whole (and `cascadeTrace.js` is already
down to 203 lines after §12.7.2 took the octahedral map out).

Recorded as a pattern, because it is now four for four: **every §5 entry checked against its callers
has been wrong in the same direction** — the delete column names files by what they were BUILT for and
not by everything they ended up carrying. Read the return object and count the consumers before
cutting; the count takes a minute and has been decisive every time.

#### 12.8.4 Order from here

1. **Grow `createSrcVolume` into the volume provider** — the spine members above, additive, with
   `run-gi-src-volume-test.mjs` extended to cover the refit. Additive means it cannot regress the
   shipping path, and it de-risks the big edit by moving the "what does the spine actually need"
   question out of it.
2. **Then the split proper**, as one edit because this half genuinely is one: GISystem's
   `#rebuild` (cascades, merge, gather, probe irradiance, feedback, the queue assembly), the
   transport half of `#tick`, the ~2,500-line adoption lifecycle, and the five whole-file deletions.
   The screen chain is already ready for it (12.8.1).
3. Then Phase 1 (GPU probe population), diffed against `srcRef.js` on a frozen frame.

---

### 12.9 The dense transport is GONE — what landed, and every constant it took with it

**Status:** §12.8's unit is DONE, in three commits, `93a4a8e` → `25e1d09`. 30,498 → **24,634 lines**
(33,355 at the start of the deletion sweep). Every gate green at every commit, and the emitter-shadow
GPU probe reports `penumbraPx=16601 grain=0.0307` at all three — the same numbers as the four commits
before them.

**DIFFUSE INDIRECT IS NOW ABSENT.** Direct light, GI-traced light shadows, emitter shadows, AO and
exact BVH reflections are live; bounce, sky and the glossy-environment term read zero. The build says
so on its own console line, which is the point of it — "GI builds, logs happily, contributes no
bounce" is the signature of at least three real bugs this module has shipped (a stale `backend`
value, an empty field, an unregistered light), so the interregnum has to be distinguishable from
them without reading the source.

#### 12.9.1 What each commit did

1. **`93a4a8e` — the cascades.** `cascadeTrace.js`, `cascadeMerge.js`, `cascadeGather.js` and the
   GISystem half that drove them: the ~420-line construction chain, the transport's per-frame uniform
   writes, the queue triplet's transport entries, the peak split, the `__giFreeze` stage bisect, the
   probe gizmos, the trace-budget ladder. 3,401 lines.
2. **`25e1d09` — the field.** `giField.js`, `sparseField.js`, `instanceGrid.js`; `createSrcVolume`
   takes over as the volume provider at a ONE-LINE call site (which is what growing its spine first,
   `1b20e93`, bought). The composite pass, the fp16 distance texture, six per-cell rgba32f buffers,
   the instance grid, the sparse page table, the dirty-brick narrowing, `createSceneTrace` and
   `readbackStats` all go. 2,463 lines.

**The composite's removal is §12.6 confirmed by experiment rather than by argument.** §12.6 argued
the composited `distanceTexture` WAS `freeRadiusAtWorld` resampled onto the coarse lattice and
quantized to fp16; deleting it outright changed the probe by **zero** (`16601 / 0.0307` before and
after). A resample was removed, not a source.

`res` is passed to `createSrcVolume`, not `res: null`: the two lattices measure **3.61× apart** at
the shipping presets and every tuned constant in the shadow estimators is expressed in coarse-cell
units, so switching lattice and producer in one commit would make an eye-check unattributable. The
`res: null` arm stays a separate A/B (§12.6.5).

#### 12.9.2 The rule that decided what stayed: authored props park, mechanism dies

Six uniforms survive with **no consumer** — `skyRadiance`, `probeSmoothing`, `bounceGain`,
`bleedSaturation`, `temporalBlend`, `fieldSmoothing`. Each is written by `#applyLiveProps` from an
Inspector prop that is **serialized into the user's scene**, each is mixed into `#fieldInputHash`,
and Phase 1-3 consumes every one of them unchanged. Deleting them means deleting those writes, the
schema entries and the saved values — and silently rewriting the user's authored numbers on the next
save.

The transport's MECHANISM uniforms went outright, because each addressed exactly one deleted kernel
and had no authored surface to preserve: `normalLift`, `fieldShadowOff`, `shadowJitter`,
`dynShadeAmbient`, both checkerboard parities, the cascade `intervals`, the field width probe.

**The `__giFreeze` bisect's prefixes were DELETED rather than left to degrade.** `"field"`,
`"transport"`, `"traces"` and `"merges"` named the feedback pass, the cascade traces, the merges and
the probe integral. With none of them in the queue every cut would have silently become "run the
whole thing" — a knob reporting success while doing nothing, which is the failure mode this module
has paid for twice already (the coerced `c0DirRes` string; the stale `backend` value). `"all"`
survives because it still means precisely what it says.

**The queue TRIPLET survives with identical contents**, and that is deliberate: every screen pass is
hot-swapped BY INDEX into all three arrays on resize (`#syncScreenResolveSize`, ~25 sites), and Phase
1-3 gives them different contents again. Collapsing them means rewriting that path twice.

#### 12.9.3 THE TUNING, transcribed — because these were measured, several against user reports

Re-deriving any of this is strictly more expensive than reading it. Phase 1-3 should **re-tune from
these numbers, not from scratch.**

**Cascade geometry** (`cascadeTrace.js`)
- `cascadeCount = min(6, max(2, props.cascadeCount || 5))`; `c0Grid` = volume size / probeSpacing per
  axis, clamped to `MAX_PROBE_AXIS`.
- `BRANCH = __giCascadeBranch ?? 2`. Interval *n* has length `t0·BRANCH^n`, starting at
  `t0·(BRANCH^n − 1)/(BRANCH − 1)`. Footprint/spacing scales as `BRANCH/4` per level, i.e. it is
  constant ONLY at `BRANCH = 4` — and 4 was A/B'd on the bleed rig and rejected. Ship 2.
- `t0 = probeSpacing`, `farT = 2 × the longest volume axis`. Both were rescaled by the STRETCH refit;
  Phase 1-3 must restore that, because moving the lattice without moving the ray lengths silently
  changes what each level covers.
- `c0DirRes = props.c0DirRes === 2 ? 2 : 4`, with `__giC0DirRes` clamped to a power of two in [2, 16].
  **The `=== 2` is strict on purpose.** The user's Sponza stores `c0DirRes: "2"` — a STRING, an
  Inspector serialization artifact — so that scene has always rendered at 4. Adding `Number()` here
  (tried 2026-08-07, reverted the same hour) makes the stale value take effect: 4 directions on the
  whole sphere, visibly flat and bright. A knob that was silently IGNORED becoming silently HONOURED
  is the same class of regression as the reverse.
- At `c0DirRes = 4` there are 16 texels on the whole sphere, so on the bleed rig the floor→panel
  direction stays inside ONE texel across the entire 3–10 m fit window: the applied cosine freezes at
  0.3162 while the true energy-weighted cosine decays as ~1/d. That is a bent EXPONENT, not a
  brightness error — forward model predicts −2.095 against measured −2.18 (analytic −2.718).

**Gather / merge / probe** (`cascadeGather.js`, `cascadeMerge.js`)
- `gatherBias = 0.5`, `gatherViewBias = 0.5` (fractions of a probe cell, normal and toward-camera).
  User-eye-tuned on their Sponza, 2026-08-03, as the closest match to the Blender reference for
  curved receivers. `__giGatherBias` / `__giGatherViewBias`; 0/0 = the unbiased cage.
- `probeSnapAlpha = 0.35` (adaptive-hysteresis snap; 0 = the old fixed-alpha EMA).
  `depthMomentsAlpha = 0.12` (visibility integrator; 1 = this frame only).
  `probeNoiseAlpha = 0.25`.
- `BURIED_PROBE_WEIGHT = 0.02` — non-zero on purpose; a hard zero produced visible blotch/scallop.
- `DEFAULT_VIS_TOL_RADIAL = 1.75`, `DEFAULT_VIS_TOL_ANGULAR = 0`,
  `LEGACY_RADIAL_QUANT_VOXELS = 1`, `HYBRID_RADIAL_QUANT_VOXELS = 2.6e-5`. The merge's
  `DEFAULT_MERGE_VIS_TOLERANCE` was the same 1.75 — the radial/angular split is ONE contract across
  the merge, the resolve gather and the feedback gather, and all three must size their tolerance off
  the same trace medium (`rayHitConfig.activeMode`, never `props.rayHitMode` — `"auto"` is not a mode).
- `fieldSmoothing = 0.95`, user-confirmed live 2026-08-03; **squared under the peak split**, so the
  per-run retain covers two frames and the time constant does not move.

**Trace budgets, per quality** — the three that died were `feedback` 18/24/32/40,
`feedbackEmitter` 8/10/14/20, `feedbackEmitterMacro` 16/20/28/40 (low/medium/high/ultra), overridable
via `__giFieldEmitterSteps` / `__giFieldEmitterMacroSteps`. `shadow` 24/32/44/56 SURVIVES (the
emitter shadow trace still uses it). `mirror` 32/40/56/64 was already dead.
- **The emitter march is the scene's steepest per-object cost: 0.73 ms per live emitter** at a
  128×32×128 volume, linear in count, because every occupied cell re-marched to every emitter every
  frame (`scripts/run-gi-emissive-cost.mjs`).
- Field sun shadow steps: `__giFieldShadowSteps || 96` on the record march, `|| 64` on the DDA.
  `penWidth` floor `= cellMax × 0.5` — a razor sun traced 10–60 m through architecture read
  centimetre clearances at aperture edges and multiplied whole regions to ~0 (MEASURED on the user's
  Sponza: lit-strip cells 0.002 lum vs 0.18 with `__giNoFieldShadows`, while a CPU DDA over the
  readback bits proved 52/60 paths CLEAR).
- **The field width probe was OFF by default** from 2026-08-06: its min k·D/t over blurred distance
  taps read ~0 wherever a long ray passes near aperture edges, a further ×3 energy loss on the same
  slit. The SCREEN arm keeps its width probe (user-validated).
- `normalLift = minCell × 1.2`. `shadowJitter.penAngle = 0.025` rad (`__giSunAngle`);
  `shadowJitter.angle = 0` — the stochastic dither cone is OFF because any stochastic term flickers
  under a static light unless Light Smoothing integrates it ("it flickers even when the light is not
  moving").

**Cadence and cost**
- Peak split, MEASURED on the user's Sponza at ultra (2026-08-04, `run-gi-perf.mjs`): waking the
  field cost **6.3 ms** of GPU compute per frame — feedback **3.86**, traces+merges+probes **2.44**.
  Both ran every frame while a light moved, and 6.3 ms plus the rest of the frame crosses a 120 Hz
  budget, at which point the compositor halves the presented rate in one step. That cliff was the
  user's "FPS drops 2×". The two halves are a ping-pong (neither reads its own output within a
  frame), so alternating them by STRICT frame parity converges to the same fixed point at half the
  rate. Strict parity, not a free-running counter: an irregular feedback rate PULSES the lighting,
  which is a bug this module shipped once (2 iterations, then 0, then 1, at low/medium only).
- `CHECKER_WARMUP_FRAMES = 8`. Both checkerboards leave their skipped half holding whatever the
  buffer had, and a fresh buffer holds ZEROS — which a cascade ray decodes as "hit at t=0, black",
  not as "no data". Feedback checker default ON at low/medium (`__giFeedbackChecker`); trace checker
  opt-in (`__giTraceChecker`).
- Sparse bricks: `brickAxis = 6` (4/6/8 by tier), `maxBricks` 60k/120k/220k/260k. Sized from a
  MEASURED scene: the user's Sponza wants 207,925 bricks at 0.33 m coarse cells
  (`run-gi-sdf-coverage`). A budget under that is not a soft quality knob — the cells that miss out
  keep the coarse field, so the building seals in some places and leaks in others.
- Injection arms, all default ON: coverage-weighted injection (`__giCoverageInjection`),
  record-true injection normals (`__giRecordInjectionNormals`), swept-bounds history invalidation
  (`__giNoSweptInvalidation` to disable), `dynShadeAmbient = 0` (`__giDynShadeAmbient`; 1 = the
  pre-2026-08-07 value).

**THE DIRTY-BRICK LESSON, which is no longer learnable from the code.** The composite recomposited
only the union AABB of changed slots. A narrowed recomposite **can permanently miss the pyramid
arriving**: the first composite ran whole-volume against a pyramid whose voxelize dispatches were
still skipped (async pipeline compiles), so every cell read empty — and every LATER composite was
atlas-bumped with a small dirty AABB, recompositing only that region. The rest of the volume kept the
empty boot result forever, and nudging the building 1 cm was what "fixed" it (probe-measured: 0.021
lum settled boot → 0.105 after the nudge). **Anything incremental built over the SRC field has to
answer that case before it ships.** An every-3rd-frame composite throttle was also tried and
REVERTED — it staggered moving shadows into visible judder and bunched cost into spike frames.

#### 12.9.4 Two findings the cut produced on its own

**`sparseField` has been UNREACHABLE since 2026-08-02 — a week of sessions, not since §12.8.** Its
gate was `!this.#killSdfEnabled() && (props.sparseField === true || __giSparseField === true)`. The
gate itself is correct — the bricks RESAMPLE the per-mesh SDF grids, and with no grids to fill them
they would overwrite the occupancy oracle's good answer with cap distances. But `#killSdfEnabled()`
has returned an unconditional `true` ever since the bake pipeline was deleted, so the left operand is
always false. The component's "Sparse Fine Field" checkbox and the `__giSparseField` hatch have both
been inert while reading as live quality knobs, and `sparseField.js` was dead code behind them.
Recorded in the component schema. **This is the fifth §5-adjacent entry to be wrong on inspection,
and the first in the OTHER direction: not "a delete-column file a survivor needs", but "a file the
column called live that had already died".**

**The `debugProbes` menu lost `"raw"` and `"merged"`** rather than keeping them inert, and the
distinction from the parked props is worth stating: those two sit inside a control whose other
options still work, so keeping them means two of five entries silently doing nothing while the other
two respond. A parked prop in a feature that is wholly absent is honest; a dead option beside live
ones in the same dropdown is not.

#### 12.9.5 An instrument fix that nearly cost a wrong conclusion

Mid-sweep the emitter-shadow probe reported `penumbraPx=0 grain=0.0000` on code that gave
`16601 / 0.0307` on the three runs around it — **1 run in 4**. A zero there is indistinguishable from
"the emitter shadow chain is broken"; it is the same signature. The only thing separating them in the
output was the ABSENCE of the field's readback log line, i.e. the readback had landed before the
pyramid was voxelized.

That log line is therefore now a **precondition** of the measurement, not a thing you notice missing:
`[gi] field ready: <n> occupied voxels` (renamed from `[gi] composited field:` and re-sourced from
the pyramid's own readback), and the probe FAILS rather than printing a number if it never appears.
This is §12.4 again — the instrument is wrong before the code is — and the sharper form of it: an
instrument that reports a plausible wrong number is worse than one that crashes, because this rig's
entire purpose is A/B-ing a shadow chain against a recorded number.

#### 12.9.6 Order from here — and why the slotRegistry split is NOT next

§12.8.3 filed `slotRegistry.js`'s SDF-tile-atlas half as part of this unit. It is still correct that
the file splits, and the atlas half is now **entirely unreachable**: under `killSdf` every entry gets
an analytic shape (a fitted primitive, or a synthesized bounding box), so `contentKey` is always null
and no tile is ever acquired — `acquireTile`, `releaseTile`, `setSlot`-with-a-grid, `sampleSlot`,
`refineDetail`, `encodeMeshSdf`/`decodeMeshSdf`, `MESH_SDF_*`, `SLOTS_PER_LAYER`,
`MAX_ATLAS_LAYERS`, `atlasCapacityFor`, `DETAIL_SLOTS`, `#selectHiResMeshes` and `atlas.detailBudget`
are all dead in every shipping configuration.

**But its payoff is hygiene only, and a previous session already took the win that mattered:** the
40 MB tile texture is ALREADY a 4×4×4 token texture holding "far" (the user's scene had allocated
7 layers ≈ 58 MB for data nothing wrote). So deleting the atlas half frees no VRAM and no GPU time —
it removes ~500 lines of slotRegistry plus the GISystem tile paths, from the module's single
most-referenced object (`atlas.*`), for clarity alone.

So:

1. **Phase 1 — GPU probe population**, diffed against `srcRef.js` on a frozen frame. This is the next
   substantive unit: it is what puts diffuse light back, and it reads the occupancy field, not the
   atlas, so the vestigial tile machinery does not shape it.
2. **Phase 2/3** per §3, then the slotRegistry atlas sweep as hygiene whenever it is convenient. It
   is no longer blocking anything.
3. Deferred, each with its own A/B and none of them urgent now: the ladder's 3×3×3 widening
   (§12.6.5 #2); `planeCut` 3.5→2.5 voxels and the width probe's `0.6·planeHeight` gate;
   `dynamicObjects.js`'s inert card-table word; the `res: null` lattice (§12.6.5, measured 3.61×).
4. Still outstanding and unchanged by this sweep: `gate:gi-gather` fails 6 cases and
   `run-gi-rc-penumbra.mjs` reports `shadowMin ≈ lit` on two arms — both verified at the pinned
   baseline worktree, so neither is sweep damage. `gate:gi-gather` measures the DELETED estimator and
   should be retired or rewritten against SRC in Phase 1 rather than fixed.
5. **No user-eye check has happened yet.** Both GI debug overlay views discard essentially every pixel
   in the headless rig, and that symptom is invariant across a byte-for-byte move — so it is the rig.
   The real check is a person switching Debug View in the editor, and now also confirming the
   interregnum reads as expected: direct light and shadows present, bounce absent.

---

### 12.10 The SDF goes too — and where the line between "delete" and "park" fell

**Status:** done, `fd1300b` → `c75fba5`, on the user's call ("we have all of it in git if we ever
need it — delete everything we don't need, sdf included"). 24,634 → **23,404 lines**, i.e. 33,355 →
23,404 across the whole sweep, a 30% cut. Every gate green at every commit and the emitter-shadow
probe at `penumbraPx=16601 grain=0.0307` throughout, including the SUN arm's `floorIn=12865
miss=14573`.

#### 12.10.1 What went

**`slotRegistry.js`: 911 → 231 lines.** The tile texture and its pool (`acquireTile`/`releaseTile`/
`#findTileBlock`/`#findTileSingle` and the tail-first single allocation that existed only to stop
block fragmentation), `setSlot`-with-a-baked-grid, the `.sdf` file format
(`encodeMeshSdf`/`decodeMeshSdf`/`geometryFingerprintOf`), all NINE per-slot uniform arrays,
`sampleSlot`'s five-branch analytic SDF (grid / box / ellipsoid / box-shell / ellipsoid-shell), the
per-step `refineDetail`, the detail-slot list, the dirty-bounds accumulator, and the
`grid`/`sparse`/`slotPriority` attachment points.

**`occupancyField.js`: 4,645 → 4,571 lines**, and this is the part with a runtime cost attached. The
coarse SURFACE-ATTRIBUTION grid is gone: `cellAttr` (atomic u32 over composite cells — 2.6 MB at high
on the probe rig), `staticAttr`, the `slotAtlas` numbering bridge, `setCoarseRes`, and a clear +
snapshot + restore pass. **The voxelizer's hot loop drops three divides and an `atomicMax` per
(triangle, voxel) overlap.**

**`GISystem.js`:** `#killSdfEnabled()` itself (a method returning unconditional `true`, read at four
sites), the hi-res 128³ grant selection (`#selectHiResMeshes`), `contentKeyOf`, the tile/instance
capacity tiering, `#refreshOccupancySlotRemap`, the detail-slot ranking block, and `atlas.aabbExpand`/
`minAnalyticHalfWorld`.

**`voxelizeOnce.js`: 399 → 205 lines.** `createVoxelSceneTrace` (the TSL Amanatides-Woo DDA) and
`createTrilinearRadianceSampler` (the side-aware trilinear read every transport hit shaded through).
The file now imports nothing from three at all — it is pure CPU material/mesh resolution.

**`scripts/run-gi-gather-invariance-test.mjs` and its `gate:gi-gather` entry.** This is the "two RED
gates" item from §12.9, resolved rather than carried: the gate was a CPU port of
`cascadeGather.js:939`'s estimator, written as an acceptance criterion for a fix that will never land
because the estimator is deleted. Its four findings are worth keeping in mind for Phase 1-3 and are
the reason it is recorded here rather than merely dropped: **`c0DirRes = 2` is DEGENERATE** (all four
octahedral texel centres land on the equator, so a ±Z-facing surface gathers exactly zero);
**octahedral texels vary 2.73× in solid angle** and the estimator never wrote Δω down, so it was
silently area-weighted (1.46× at the pole vs 0.75× at the map corner); a well-resolved 40° source
**drifted 2.1× across 16…4096 directions instead of converging**; and sub-texel sources were
hit-or-miss, which was the emissive flicker under motion. An SRC gather has to satisfy these
invariants, and a fresh gate should be written against SRC rather than this one repaired.

#### 12.10.2 What proved it dead — "unreferenced" is not "unreachable"

Two independent facts, and the second is the one that made this safe:

1. **No tile is ever acquired.** Under `killSdf` — unconditional since the bake pipeline was deleted —
   `#buildEntries` synthesizes a bounding box for anything `fitPrimitive` cannot name, so every entry
   is analytic, `contentKey` is always null, and the tile path is never entered.
2. **No GPU reader was left for the per-slot uniform arrays.** `bvhScene.js` keeps its OWN
   `worldToLocal`/`aabbMin`/`aabbMax` (bvhScene.js:549-551) — the `atlas.albedo` mentions in that file
   are comments and its `atlasTexture` is a separate per-mesh albedo CanvasTexture. The composite that
   bound slotRegistry's arrays went with the transport.

A prior session had already replaced the 40 MB tile texture with a **4×4×4 token** holding "far"
(their scene had allocated 7 layers ≈ 58 MB for data nothing wrote), so this deletion frees code and
one hot-loop atomic, not VRAM. That was worth knowing BEFORE deciding, and is why §12.9 filed the
sweep as hygiene.

#### 12.10.3 WHAT SURVIVES, and the rule

`slotRegistry.js` is not deleted, because something load-bearing was hiding under the atlas: the
census must know which placements exist, hold each one's surface, and **notice when one MOVES**.
`revision` is the wake signal the pyramid's refresh branch triggers on, so without it a dragged mesh
marks the field dirty and nothing ever consumes it. `refreshSlotTransform` now does exactly one thing
— re-cache the world matrix — because that cache is what `#matrixChanged` compares.

**The rule this sweep converged on, stated once:**

> A REPRESENTATION that is gone forever gets deleted. MECHANISM for a feature that returns gets
> parked, with a comment saying so.

Applied:

| deleted | parked |
| --- | --- |
| the SDF atlas, tiles, `.sdf` format, `sampleSlot`/`refineDetail` | the six authored transport props (bounce, bleed, temporal/probe/field smoothing, sky) |
| the coarse attribution grid | the mover-occluder bundle (`#moverOccluders`, `#syncMoverOccluders`, `giProxySpheres`) |
| the dense-field readers (`createVoxelSceneTrace`, `createTrilinearRadianceSampler`) | the queue triplet |
| `peakSplit`, `sparseField`, `autoRebake`, `backend`, `debugProbes`' raw/merged | the idle-sleep branch |

The mover-occluder bundle is the interesting case: `#moverOccluders` has **no caller** right now, so
the bundle is never created and `#syncMoverOccluders` early-returns at zero cost. It stays because the
two halves of `__giDiffuseSkipMovers` are ONE change and shipping either alone is strictly worse than
shipping neither (rays skipping movers with no analytic term back = movers cast no indirect shadow;
the analytic term with rays still hitting them = every mover shadow applied twice). Phase 1-3 needs
precisely this bundle the moment diffuse rays skip movers again, `giProxySpheres` and
`run-gi-proxy-fit-test` hang off it and stay green, and the code now SAYS it is parked — because
inert-but-intentional is otherwise indistinguishable from forgotten.

Five Inspector knobs were removed outright on the same rule, and a parked prop is not one of them: a
parked prop belongs to a feature that is visibly absent, while `peakSplit` (the transport's two-half
ping-pong), `sparseField` (inert since 2026-08-02), `autoRebake` (no bakes to re-run), `backend` (its
only other value named a deleted transport — the coercion and warning stay so old scenes load, and
`__giBackend` survives as a diagnostic kill switch) and `debugProbes`' raw/merged described machinery
that no longer exists at all. Saved scenes keep the values harmlessly: an unknown prop is ignored.

#### 12.10.4 Two facts transcribed out of the attribution grid, because both were paid for

- **The crossed-numbering bug.** Placement slots and atlas slots were numbered independently
  (mesh-walk order vs `#syncSlots` priority), which once fed the composite a different mesh's colour.
  The remap was applied in the VOXELIZER rather than read in the composite for a hard reason: the
  composite kernel already sat at the user GPU's **12-uniform-buffer per-stage limit**, and buffer 13
  fails `CreateBindGroupLayout`, which drops the WHOLE compute batch.
- **The deterministic-winner fix.** Last-write-wins re-rolled every multi-mesh seam cell's colour by
  GPU scheduling on every dispatch, and a moving object re-voxelizes every frame — so the bounce
  amplified it into visible flicker. `atomicMax` made the winner in a shared cell deterministic.

Anything that re-introduces per-cell surface attribution inherits both.

#### 12.10.5 Order from here, unchanged

**Phase 1 — GPU probe population**, diffed against `srcRef.js` on a frozen frame. Then Phase 2/3.

Still open, and now the complete list: `run-gi-rc-penumbra.mjs` reports `shadowMin ≈ lit` on two arms
(pre-existing at the pinned baseline). The GPU rigs that measure DIFFUSE indirect —
`run-gi-bleed`, `run-gi-block-size`, `run-gi-flicker`, `run-gi-emissive`, `run-gi-mover-bounce`,
`run-gi-rc-lattice`, `run-gi-rc-splitroom`, `run-gi-perf` — all measure a term that is currently zero;
they are instruments for a feature that returns, so they are kept, and a zero from any of them right
now means nothing. `lightTree.js` (1,129 lines, plus a green suite) has **no importer in `src/`** — it
is a built-but-unwired many-lights sampler from the superseded `GI_NEXT_ARCHITECTURE.md` §7, and it
is flagged rather than deleted only because it is orthogonal to this rebuild; say the word and it goes.
And the user-eye check in the editor is still outstanding.

### 12.11 Phase 1, part 1 — the math twins and the probe hashmap

**Status:** two commits, `7a85548` → `ceb9fbc`. Both halves of the foundation Phase 1 stands on are
in and gated; the driver that feeds them (real gbuffer → c0, the cascade ladder, debug gizmos,
`smoke:gi-gpu?src=1`, GISystem wiring) is not. New gates: `test:gi-src-math`, `test:gi-src-probes`.
Both are browser-driven against the dev server on 5201 — headless WebGPU has never worked here, so
a real adapter is the only place a WGSL transcription error is observable at all.

#### 12.11.1 The twins, and the four things the twin gate found on its first run

`srcMathTsl.js` is the TSL expression of `srcMath.js` plus srcConfig's scalar half.
`scripts/gi-src-math.html` runs every twin in a real compute pass and diffs it against the JS
original **in the same page**: 687 cases, 17 integer families held BIT-EXACT with no tolerance at
all, 16 float families at 4e-6 with the worst observed error printed rather than only pass/fail.
The integer families are exact because they are what the probe hashmap is keyed on — a one-bit
difference there is a different probe, not a small error, and Phase 1's "probe counts vs the CPU
mirror" gate would be comparing two different algorithms.

The input set is adversarial deliberately. Random inputs pass all of this on the first run: every
finding below came from a case chosen to sit exactly on a boundary.

1. **THE R2 SEQUENCE CANNOT BE EVALUATED IN FLOATS, and the mirror could never have told us.**
   `fract(0.5 + a*n)` in f32 has 16384 distinct values at n=1024, 256 at n=65536, 32 at n=500,000
   and **EIGHT at n=2e6** — §9's ray count. A 16×16 coverage histogram over 4096 points starting at
   n=2e6 goes from a uniform 13..19 occupancy to **0..66, with empty cells**. At that point cascade
   3's 2048 bins are fed by eight azimuths. In f64 the mirror is perfect at every index, so this is
   invisible to `test:gi-src-ref` by construction. Both sides now run the additive recurrence in
   **u32 fixed point** (`R2_ALPHA1_FX = 3242174889`, `R2_ALPHA2_FX = 2447445414`, both odd so the
   period is 2^32): exact on both sides, `Math.imul` and WGSL's u32 multiply are the same operation,
   and the measured discrepancy is identical to the f64 float form on every arm. The per-frame
   jitter is a **u32 phase**, not a float, for the same reason. A new Phase-0 arm pins it with the
   f32 float form as an explicit canary, so the finding fails on the CPU, in bare node, forever.
2. **`atan2(0, 0)` is UNDEFINED in WGSL and every exactly-axial ±Z direction hits it.** This adapter
   returned pi/2 where JS returns 0, so a pole ray binned to a different azimuth wedge. The point is
   not that one answer is better — at the pole every wedge is equally defensible — it is that
   "implementation-defined" also means two GPUs may disagree, and a deposit that lands in a
   different bin per vendor is not something a later gate can attribute. Pinned to 0.
3. **`sqrt(1 - z^2)` cancels at the poles**: 1.3e-5 of absolute error in the decoded x/y at
   y = 0.999999, three orders worse than anything else in the file. Both files now use
   `sqrt((1-z)(1+z))`, where whichever factor goes small is computed exactly (Sterbenz). 400× better
   in f32, and better in f64 too — it was simply never observable there.
4. **The gate itself was wrong first.** It fed the mirror f64 inputs the GPU never received, so
   every float family was partly measuring input quantization. `lodBlend` divides by the 0.1-wide
   overlap band and therefore **multiplies its input's rounding by ten**, which is why it was the
   first float family to fail — by 1.1×, which is exactly the kind of margin that gets "fixed" with
   a looser tolerance. Cases are now rounded through f32 before either side runs; worst float error
   across all sixteen families fell to 6.3e-7.

Two ambiguities are **counted rather than tolerated**, because a tolerance wide enough to cover
them would also cover a genuinely inverted fold or a wrong bin: a ray within 1e-5 of tangent has an
f32-noise-decided hemisphere fold sign and the two sides emit antipodal rays (1/687), and a
direction sitting exactly on a wedge seam may bin either side (2/687, e.g. exactly 45°). The
downstream families are fed **the GPU's own bin index** so that `binMorton` tests Morton and not
`dirToBin` — a shared input reported five failures for one seam and hid whether Morton was ever
wrong.

Also recorded, because it decides how every rounding in the twin is written: **WGSL `round()` is
ties-to-EVEN and JS `Math.round` is ties-toward +inf.** `nearestCell` rounds, so a probe exactly
halfway between two lattice cells would insert a different probe on each side. Every rounding in
`srcMathTsl.js` is `floor(x + 0.5)`, and `latticeOriginFor` moved out of `srcRef.js` into
`srcMath.js` so the reference, the twin and the gate share one definition.

**A tolerance the Phase-1 probe gate has to carry, not a bug to chase:** LOD selection takes a
`log2` and then a `floor`, so a world point within ~1e-6 of a LOD boundary can floor to different
shells on the two sides. A handful of boundary pixels inserting the neighbouring LOD's probe is
correct behaviour.

#### 12.11.2 The hashmap — what the design commits to

`srcProbes.js`. One buffer per role with all cascades at fixed offsets (R7, and AGENTS.md leads
with the 8-storage-buffer limit for a reason): `hashKeys` (atomic), `hashSlot`, `probeTable`
(8 words/probe), `counters` (atomic), `freeStack`, `freeTop` (atomic).

- **CAS is a `wgslFn` island.** TSL has no `atomicCompareExchangeWeak` — three r185's
  `AtomicFunctionNode` ships load/store/add/sub/max/min/and/or/xor and stops — and the insert is not
  expressible with any of them: `atomicMax` on the key makes the LARGEST key win a contended slot,
  which is not a hashmap, and a load-then-store loop has a window where two probes claim one slot.
  The vehicle is the one `bvhGpu.js`/`dynamicObjects.js` already prove out, a
  `ptr<storage, array<atomic<u32>>, read_write>` parameter that three's `FunctionCallNode` passes as
  `&buffer` (`ptr<...>` maps to `pointer` in `WGSLNodeFunction`'s type table; the `isAtomic` flag on
  the node is what emits `array<atomic<u32>>`, independent of how the buffer is used in that
  shader). **The hash mix is NOT in the island** — `srcMathTsl.hashKey` computes it and it is passed
  in, so there is no second WGSL copy to drift from the gated one.
- **The "Weak" is load-bearing.** `atomicCompareExchangeWeak` may report `exchanged == false` with
  `old_value == expected`. Advancing the probe sequence on that scatters one key across several
  slots and gives one probe two indirection entries — two payloads, half the rays each. The loop
  distinguishes all three outcomes and **retries the same slot** when the old value came back EMPTY.
- **Indices never move.** Compacting the table each frame is the obvious way to keep it dense, and
  it moves the payload — the expensive part — every frame. Instead the table is fixed, the age pass
  pushes dead entries onto a free stack, and new probes pop. A surviving probe is not touched at
  all, which is also why [K] costs nothing for the steady-state majority.
- **A failed allocation leaves `SLOT_EMPTY`, never index 0.** "No probe here" is a state every
  consumer already renormalizes around (R1); clamping to 0 would pour every overflowing probe's rays
  into one record.
- **`srcHashFind` stops at the first EMPTY slot**, which is sound ONLY because there is no deletion
  path — the table is cleared and rebuilt, never tombstoned. That is a design rule, not an
  implementation detail, and a future delete would break the scan silently.
- `[B]` hands its caller a **hash slot**, not a probe index, and `[C]` allocates. Fusing them is the
  race this split exists to avoid: the thread that loses the CAS would have to spin until the winner
  allocated. Every boundary between the passes is a real barrier and WebGPU has no device-wide
  barrier inside a dispatch, so "fusing for speed" here produces a race, not a faster kernel.

#### 12.11.3 What the probe gate found, including one with a delayed fuse

`scripts/gi-src-probes.html` holds the map to `SrcProbeMap` as a **SET** — the two cannot agree on
index assignment (the GPU allocates by `atomicAdd` in scheduler order, the mirror in insertion
order) and pretending otherwise is a gate that fails for the wrong reason.

1. **Nothing marked a probe as SEEN.** `age` means frames-since-last-seen, but a key CAS'd into a
   slot the age pass already re-populated finds the entry present and touches nothing — so a probe
   looked up every single frame still aged out. It was then immediately re-created from the key
   still sitting in the hash: **same probe, new index, every `maxAge` frames, forever.** The storm
   arm passed. The stability arm (one frame) passed. Only "survivors STILL hold their original
   indices AFTER the sweep" caught it, and the Phase-4 symptom would have been the entire frame's
   temporal history resetting on a beat. Resolving is now the touch, because resolving is the only
   moment in the pipeline that means "a consumer is using this probe".
2. **The load instrument cried wolf at rest.** Steps ÷ live probes reported 10.66 mean probe steps
   on a map whose real mean is 1.10 — off by exactly the pixels-to-probes ratio, and the mirror's
   own `probeSteps/inserts` had the same wrong denominator. `COUNTER_ATTEMPTS` is the denominator
   now. An instrument reading 10× over budget on a healthy map is worse than no instrument.
3. **A bare JS `return` inside an `If` body is not an early exit.** It ends the builder callback and
   emits an EMPTY branch, so the code below runs anyway; it compiles and it validates. Three of them
   would have double-freed every dead slot. Caught by reading, not by the gate. `Return()` is the
   TSL statement, and `occupancyField.js` has used it correctly at five sites for a year.

**Measured, stable over three runs:** 4096 contended inserts over 400 distinct keys →
**0 wrong resolutions**, key set identical to the mirror, no key inserted twice, mean probe length
**1.10 vs the mirror's 1.05** (the sequential-cell run is in there specifically because adjacent
probe keys differ by 1 in z and would cluster under a weak mix), survivors immobile across a full
retirement sweep, retirement landing on exactly frame `maxAge + 1`, **134/134 retired indices
recycled**, and 4× overflow counted (3472 failures) with `live == capacity` and no index handed out
twice.

One test-side trap worth the line: the recycle arm's "new" keys were originally `cx = 300 + i`,
outside the ±256 key window, so `packProbeKey` correctly returned EMPTY for all 134 and the arm
measured a recycle rate over an empty set. Both liveness assertions in front of it exist now.

#### 12.11.4 What is left in Phase 1

The driver, and it is the half that touches the engine: pixels → c0 keys off the real half-res
gbuffer, the cascade ladder (each c(i-1) probe inserting its nearest c(i) probe and keeping the
link, which is both the merge's parent pointer and Alg. 3's count-propagation edge), the debug
gizmos (instanced spheres coloured by cascade/LOD), the `profile.giPasses` telemetry line, the
GISystem entry point, and the `smoke:gi-gpu?src=1` arm with its binding audit. The eye check —
gizmos over Sponza and the user's game scene — closes the phase.

Nothing above is wired into `GISystem.js` yet, so the shipping build is byte-identical to `dfa868f`
and the emitter-shadow probe does not need re-running for these two commits.

### 12.12 Phase 1, part 2 — the driver, the engine, and the gizmos

**Status:** three commits, `8ea0d25` → `711a8e1`. Phase 1 is code-complete; the only
thing left in it is the **user-eye check in the editor**, which none of the below substitutes for.
New gates: `test:gi-src-populate`, `smoke:gi-gpu?src=1`. The shipping build is unchanged and this
is measured, not argued — `run-gi-emitter-shadow-probe` reports `penumbraPx=16601 grain=0.0307`
and the `SUN=1` arm `floorIn=12865 miss=14573`, both EXACT matches to the recorded baseline, with
all 12 GI CPU suites green.

#### 12.12.1 The frame, and what it commits to

`createSrcProbeFrame` assembles [K] + [B] + [C]: hash reset, survivors re-entering with the
indices they already have, every gbuffer pixel inserting its nearest c0 cell, then the ladder —
each c(i−1) probe inserting its nearest c(i) probe and keeping the link. Fourteen dispatches at
N=4 (seventeen with the pixel resolve), each boundary a real barrier: WebGPU has no device-wide
barrier inside a dispatch, so "fusing for speed" here produces a race, not a faster kernel.

- **A pixel inserts the NEAREST cell only**, not the eight trilinear corners it will later
  interpolate over. If a later phase reports interpolation holes the fix is the gather's
  renormalization, not more probes here.
- **A child's world position comes from its OWN KEY.** Three fewer words per probe, and — the real
  reason — no second source of truth that a re-anchor could desynchronize from the key.
- **The ladder climbs in CASCADE and never in LOD.** They are orthogonal axes (spacing doubles with
  both) and mixing them hands a probe a parent whose interval boundaries do not line up with its
  own. §4.5 forbids cross-LOD interaction anywhere; the gate asserts it directly.
- **`PROBE_PARENT` transiently holds the parent's HASH SLOT** between the ladder's insert and its
  resolve, because the index does not exist until compaction has run. Documented at the field.

**Measured against `srcRef.buildProbes`** on 4,980 synthetic pixels (293 invalid), camera and
anchor both off-lattice: probes **410 → 115 → 65 → 64**, key set IDENTICAL at every cascade, every
valid pixel on the mirror's own probe with **zero LOD-boundary ties needed**, every parent link
right, every c0 ancestor chain reaching the top, mean probe length 1.00, and a second identical
frame creating nothing and moving nothing.

The gate uses a SYNTHETIC gbuffer on purpose: the pixel set spans every LOD ring by construction
instead of by luck, and when the real gbuffer is wired in a failure there cannot be the population
math. Its ring arm reports what it actually proves — the slack is half a cell diagonal and the
cell doubles per cascade, so by c2 it admits everything; the c0 rows are load-bearing and have
their own assertion, and the higher cascades are constrained by the ladder arm, which checks keys
rather than radii.

**`u32(-1)` IS NOT A REPRESENTABLE WGSL LITERAL**, and it took the whole ladder with it. `onSlot(i,
int(-1))` failed `CreateShaderModule` for every ladder kernel, so cascades 1–3 stayed at zero
probes — and nothing threw, the passes were simply skipped. The "counts match" arm would have read
a plausible 410 → 0 → 0 → 0 if the ancestor-chain arm had not been there. Every absence in
`srcProbes.js` is now the unsigned `SLOT_EMPTY` end to end, which is also smaller: a signed
sentinel forces a `select` at every store and an int/uint pair at every buffer.

#### 12.12.2 The engine entry, and the anchor

`srcSystem.js` is §7's "one branch that early-outs into srcSystem, not tentacles" — four arguments
in, one object out, fifteen lines in GISystem next to the gbuffer render. It goes there because
[A] → [B] is the frame's first consumer of the frame's own geometry, and **deliberately not in
`state.queue`**: that queue is rate-gated, idle-skipped and freeze-bisected, and skipping
population on an idle frame ages every probe toward retirement while the camera sits still.

`__giSrcProbes` is OFF by default and stays off until Phase 6. The population produces no light, so
enabling it would cost GPU time, change nothing on screen, and make every number already in §12
incomparable.

**THE ANCHOR IS THE ONE NON-OBVIOUS PIECE.** Probe keys carry 9 bits per axis RELATIVE to a lattice
anchor, so an anchor pinned at the world origin makes every near-camera probe unrepresentable once
the player walks ~130 m (±254·s₀ is the real window). `packProbeKey` returns EMPTY there, correctly
and silently, so the symptom is a scene that lights at spawn and goes flat after a walk. The anchor
follows the camera on a **64·s₀ threshold with a 16·s₀ quantum** — never per frame, because
re-anchoring re-keys every probe, which retires it, which is the per-frame binary flip R1 forbids.

One property makes that cheap and is worth knowing before anyone tries to make re-anchoring
cleverer: `latticeOrigin(anchor, s) = round(anchor/s)·s` is ALWAYS a multiple of s, so every lattice
is world-aligned regardless of where the anchor sits. **Re-anchoring never MOVES a probe; it only
renumbers it.** The cost is a lost temporal history, not a spatial pop.

Telemetry ships with it and is permanent (§8) — probe counts, load factor, mean probe length,
dropped inserts — rate-limited with an **in-flight guard**, because a readback slower than its
interval otherwise queues another every frame and becomes the cost it reports. Surfaced on
`profile.giPasses` and warned about unconditionally: a dropped insert is a probe that does not
exist, and a dark patch that moves with the camera is not a symptom anyone attributes quickly.

#### 12.12.3 The counts do NOT thin monotonically, and that is correct

The `?src=1` arm measured c0 = 12, c1 = 18 and I wrote it up as a ladder bug before working out that
the arm was right. Each c0 probe inserts exactly one c1 probe, so |c1| ≤ |c0| **within a frame** —
but retirement cascades with a **one-lifetime LAG PER LEVEL**. A c0 probe no pixel sees is still
ALIVE for `PROBE_MAX_AGE` frames, and while it is alive the ladder keeps inserting its parent, so the
parent's age keeps resetting. The parent only begins aging when its LAST child retires, and its own
parent only after that: c3 outlives its c0 descendant by three full lifetimes (~4 s at 60 fps and
the default 60-frame age).

That is the price of every ancestor chain staying complete for a probe's whole life — which a split
deposit requires and `test:gi-src-populate` asserts — so it is correct rather than tolerated. The
structural claim (the ladder inserts at the PARENT's spacing) belongs in the population gate, where
a fixed camera and a key-set comparison can state it exactly; the smoke checks only that every
cascade got populated at all.

#### 12.12.4 `smoke:gi-gpu` WAS ALREADY BROKEN, on every arm

Not caused by any of this, and worth recording because the sweep's verification list did not
include it. The deletion sweep removed every consumer of the ray-hit profiling counters —
`resetCompute` has no caller and the module's only `profile: true` is in the un-wired
`srcTrace.js` — so nothing binds the counter buffer, nothing allocates it, and
`getArrayBufferAsync` threw `Cannot read properties of undefined (reading 'size')` from three's
internals, sixty seconds into a boot, with a stack naming neither GI nor the deletion that caused
it. Everything after that point in the harness — the binding audit, the dynobj arm, the validation
check — never ran.

Two fixes. `RayHitDebug.readback` reports `dispatched: false` instead of throwing, because **a
diagnostic must not be able to take down the harness that calls it**, and "nothing fed these" is a
real and currently correct answer that has to be distinguishable from a measured zero. And the
smoke's counter assertions are gated on the counters actually being fed, loudly noted, and pinnable
back on with `?requirerays=1` so the leniency cannot outlive the interregnum by accident. One of
those assertions — `skip=0`'s "still executed N coarse levels" — would have PASSED on structural
zeros, which is the worse failure mode.

A related trap of my own making, recorded because it is the same shape: breaking the harness's
counter-wait loop on a fixed 10-second timer shortened the BOOT WINDOW every later arm relies on,
and the exact-complex dynobj arm then measured an occupancy field that had not voxelized yet
(0 → 0). The exit condition is `_fieldReadyOnce`, not a stopwatch. `GI_SMOKE_PAGE` now lets the
driver point at another copy of the harness, which is how the pre-existing break was attributed on
the same adapter in the same session.

#### 12.12.5 The gizmos, and two ways to draw nothing useful

`srcGizmos.js`: one InstancedMesh per cascade, hue by LOD (golden-ratio stepped, so ADJACENT LODs
are far apart in hue — a linear ramp puts lod 3 and 4 in neighbouring greens, which is exactly
where a boundary artifact would hide), size by the probe's own spacing, white for newborn so churn
reads as a shimmer against a still image. Debug View → "src-probes".

The vertex stage reads the probe table directly rather than reading it back: 2.5 MB per frame at a
realistic probe count, and a readback makes the view lag the membership churn it exists to show.
Positions come from `srcMathTsl`'s own `keyCell`/`latticeOrigin`/`cellPosition` — the functions the
population inserts with — and the gizmos share the population's anchor UNIFORM rather than a copy.
A gizmo that re-derived either would be a second definition of where a probe is, and the first
thing it would do is disagree silently.

**Zero coverage and total coverage are the same failure.** The arm renders the same frame twice
into an offscreen target, gizmos hidden then shown, and requires the images to differ AND to differ
on less than 90% of pixels:

- *Nothing drew*: a NaN `positionNode`, a collapsed radius, or — the real trap — instance matrices
  left uninitialized. `positionNode` places every instance but three applies the instance matrix on
  top, and an unset `InstancedMesh` matrix array is ZEROS, which collapses every sphere to the
  origin and looks exactly like a bug in the population. They are explicitly set to identity.
- *Everything drew*: the first run reported **9216 of 9216 pixels**. Radius was proportional to
  probe spacing with no ceiling, and at cascade 3 / LOD 8 the spacing is ~900 m — a 125-metre ball
  around the camera. An overlay that paints the whole frame hides the scene it annotates and passes
  a did-anything-draw test. Radius is now capped at an ANGULAR size, keeping near probes
  proportional (the LOD-ring reading the view is for) while distant ones settle into dots.
  Coverage 9216 → **24 of 9216**.

Also: `readRenderTargetPixelsAsync`'s sixth argument is the TEXTURE INDEX, not an output buffer,
and the pixels are the return value. Passing a `Uint8Array` there throws "Invalid value used as
weak map key" from inside three, which names nothing.

#### 12.12.6 Where Phase 1 stands

Code-complete. `smoke:gi-gpu?src=1` reports 17 dispatches, 1.12 MB, probes 13/10/10/10 at hash
loads ≤ 0.005 with zero dropped inserts, gizmos at 24/9216 pixels, and the whole population inside
the **portable 8-storage-buffer limit** with no validation errors — on both default modes.

Outstanding, and it is the one thing the harness cannot do: **a person switching Debug View to
"src-probes" over Sponza and over the emissive-projectile game, with `__giSrcProbes = true` set
before the module builds, and judging the rings in motion.** [[gi-harness-viewport-traps]] is why
that has to be a person: both existing debug views discard nearly every pixel in the headless rig,
symptom-invariant across a byte-for-byte move, so the rig is the thing that is wrong.

Then Phase 2: rays, trace, deposit, c0-only resolve. `srcTrace.js` is written and unwired, which is
also why the ray-hit counters are unfed — wiring it closes both.

### 12.13 Phase 2 entry brief — and one thing that is assumed, not verified

#### 12.13.1 THE EYE CHECK IS DEFERRED, NOT PASSED

Phase 1 closes with the user's call: *"Cant check on the editor now. Lets says its correct."* That
is a decision to proceed, and it is recorded here as an **assumption carried forward**, because in
this module the difference has bitten before — "GI builds, logs happily, contributes no bounce" is
the signature of three shipped bugs, and every automated gate in Phase 1 would report exactly what
it reports today if the gizmos were drawing a correct-looking lattice in the wrong place.

What is actually verified: the probe SET matches the CPU mirror exactly, every parent link and
ancestor chain is right, the LOD rings sit in their bands numerically, the gizmos rasterize
somewhere between 0% and 90% of the frame, and nothing exceeds the portable binding limit. What is
NOT verified: that the spheres land on the geometry a person sees. The cheapest thing that would
falsify it is one look, and it stays on the list:

> **Outstanding eye check.** `__giSrcProbes = true` before the GI module builds, then Inspector →
> GI → Advanced → Debug View → "src-probes", over Sponza and the emissive-projectile game. Hue is
> LOD, size is probe spacing (angular-capped), white is newborn — a steady scene should be a still
> image, and a shimmer is membership churn.

If Phase 2 produces light that is subtly misplaced, this is the first thing to rule out, not the
last.

#### 12.13.2 What Phase 2 starts from

**The CPU mirror is already complete and already gated.** `srcRef.js` has `assignRays` (Alg. 3),
`traceAndDeposit`, `resolveProbes`, and `srcMath.js` has `splitDeposits`/`resolveBin` — all green
under `test:gi-src-ref`, including the split arm's three properties and the furnace. Phase 2 is
therefore a pure "make the GPU agree with a mirror that already exists" job, which is the cheapest
shape this rebuild has had so far.

**`srcTrace.js` is written and unwired.** It is the geometry-only extraction of the occupancy
trace, with `pickOccTrace`, the record march and `composeFieldDynamics` intact. Wiring it is Phase
2's first act — and it also closes §12.12.4's interregnum, because `srcTrace` is the module's only
`profile: true` and the ray-hit counters have been unfed since the transport died. When
`smoke:gi-gpu ?requirerays=1` passes again, the leniency added in `711a8e1` can come back out.

**Missing:** `srcRays.js` (Alg. 3 on the GPU), the deposit's fixed-point atomics, the resolve, and
the c0-only shading path.

#### 12.13.3 The one hard structural question, answered before it costs a session

Alg. 3 propagates ray COUNTS up (a parent's count is the sum of its children's) and hands OFFSETS
down, so that every probe sharing a parent occupies a contiguous segment of the one global R2
sequence. Up is trivial on the GPU — one `atomicAdd` from each child into its parent, and the
parent pointer is already resolved (§12.12.1).

Down looks like it needs a **child list per parent**, i.e. a compaction pass, because "the children
of probe P" is not a contiguous range anywhere. It does not. Give each parent an atomic CURSOR
initialized to its own `rayOffset`, and let each child claim its slice with a single
`atomicAdd(cursor, childCount)` — the returned value IS the child's offset. That produces an exact
partition of the parent's range with no gaps and no overlaps, which is the property the mirror
tests, and it costs one atomic per probe instead of a compaction.

**What it does NOT preserve is ORDER within a parent**, and that has one consequence worth writing
down now rather than discovering in a diff: the assignment is scheduler-dependent, so a probe's ray
INDICES differ between two runs of the same frame. The mirror comparison must therefore check the
PARTITION (every index used exactly once, every parent's children covering its range contiguously)
and not the specific indices — exactly as `test:gi-src-probes` compares key sets rather than
indirection indices, and for the same underlying reason. Under temporal accumulation the
non-determinism is a mild positive: a probe's directions vary frame to frame, which is extra
coverage the R2 sequence would not otherwise give.

#### 12.13.4 The fixed-point deposit, with the headroom measured

`binScratch` is per (probe, bin) 3×u32 RGB + u32 T + u32 count (§4.2), because WGSL has no float
atomics. The question is how many fractional bits, and the answer depends on how many rays can land
in one bin.

The plan's §4.2 claim that per-cascade bin totals stay roughly constant is **confirmed
arithmetically** at §9's 2M rays/frame — the probes÷4 and bins×4 per level cancel almost exactly:

| cascade | probes | bins | rays/probe | rays/bin |
|---|---|---|---|---|
| c0 | 80,000 | 32 | 25 | 0.78 |
| c1 | 20,000 | 128 | 100 | 0.78 |
| c2 | 5,000 | 512 | 400 | 0.78 |
| c3 | 1,250 | 2,048 | 1,600 | 0.78 |

So the AVERAGE bin sees well under one ray per frame — the payload is sparse, which is why
zero-count bins are "unknown" rather than zero (srcMath's `resolveBin`) and why that rule is
load-bearing rather than fastidious. Storing `round(L/Lmax · 2^F)` overflows at `2^32 / 2^F`
saturated rays in a single bin:

| F | resolution (of Lmax) | overflows at |
|---|---|---|
| 12 | 2.4e-4 | 1,048,576 rays/bin |
| **16** | **1.5e-5** | **65,536 rays/bin** |
| 20 | 9.5e-7 | 4,096 rays/bin |

**Recommend F = 16.** It leaves ~84,000× headroom over the measured average — enough that even a
pathological cluster (one c0 probe owning a large flat screen region, every ray in one bin) cannot
reach it — while giving 1.5e-5 relative resolution, which is finer than the f16 payload the resolve
writes into anyway. The Phase-2 gate should still fuzz it (§7 asks for exactly that) rather than
trust the table.

**Left open deliberately, because it is an energy decision and not an implementation one:** `Lmax`
implies a per-ray radiance CLAMP, and a clamp loses energy at exactly the bright hits that matter
most. The guide argues fireflies are impossible here by construction, which would mean the clamp
never binds — but "never binds" is a claim to measure, not to assume, and the alternative (a
per-frame auto-exposure driving Lmax as a uniform) is more machinery. Decide it with a measurement
of the actual hit-radiance distribution on the user's scenes, not in advance.

#### 12.13.5 The unit decomposition

Four commits, in this order, each gated before the next:

1. **Wire `srcTrace.js`** — the trace closure built against `srcVolume`'s world bundle and the
   occupancy field, fired from a throwaway kernel over the existing probe set. Gate: the ray-hit
   counters come back (`smoke:gi-gpu ?requirerays=1` green), and the interregnum leniency is
   removed in the same commit. This is deliberately its own unit because §7 calls the extraction
   "this phase's riskiest edit" and the full `test:gi-rayhit-*` suite has to prove the old backend
   unaffected — which is now cheap, since all twelve are green as of `711a8e1`.
2. **`srcRays.js`** — Alg. 3: the pixel histogram into per-probe counts, the up-propagation, the
   atomic-cursor down-pass of §12.13.3. Gate: a new standalone page in the
   `gi-src-{math,probes,populate}` family, diffing the PARTITION against `assignRays`.
3. **Trace + split + deposit** — [E] and [F], the fixed-point scatter and the resolve. Gate:
   deposits-vs-mirror on a frozen frame, plus the overflow fuzz. **Sparkle is an atomics race** —
   guide §8.7 says fireflies are impossible by construction here, so any sparkle at all is a bug
   with a specific cause, not a tuning problem.
4. **c0-only resolve** — shade straight from raw c0 with the merge disabled, which the guide's §8.3
   calls the single-level sanity check and which produces an AO-like short-range bounce. **This is
   the commit where the screen stops being dark**, and the first honest eye check of the rebuild.

#### 12.13.6 Traps carried into Phase 2, all already paid for

- **The R2 sequence is u32 fixed point** (§12.11.1). `srcRays.js` must use `r2PointFx`, never a
  re-derived float form — the float one has eight distinct values at the ray counts this phase will
  actually run at, and the f64 mirror cannot see it.
- **`u32(-1)` is not a representable WGSL literal** (§12.12.1) and it kills the whole shader module
  silently. Absences are `SLOT_EMPTY`.
- **A bare JS `return` inside a TSL `If` is not an early exit** (§12.11.3) — use `Return()`.
- **`atomicCompareExchangeWeak` can fail spuriously**; anything new that CASes must retry the same
  slot (§12.11.2).
- **Zero-count bins are UNKNOWN, not zero** — the single most consequential line in `resolveBin`,
  and the sparsity table above is why.
- **Deposits go into the ANCESTOR CHAIN of the pixel's c0 probe**, and nothing is deposited ABOVE
  the owning cascade. The companion guide has this wrong; the authors rejected upward extension for
  bias (srcMath's `splitDeposits` header).
- **Rays originate at PIXELS, never at probe positions.** Offsetting the origin along the normal to
  fix a self-occlusion artifact IS the artifact (srcMathTsl's `rayDirection`).

### 12.14 Phase 2 unit 1 — `srcTrace` gets a caller, and three things the gate caught

`4c004ee`. `srcRayPass.js` fires one profiled ray per gbuffer pixel that owns a c0 probe, traced
against the occupancy medium through `createSrcSceneTrace`. It deposits nothing, merges nothing and
shades nothing — **the screen is still dark, and unit 4 is where that changes.** It is its own file
so unit 3 deletes it in one line rather than unpicking it from a kernel that grew around it.

The ray already obeys the three standing rules, because getting them wrong in a scaffold is how they
get inherited: origin is the PIXEL (never the probe position), length is `intervalBoundary(0, lod,
s₀)` read rather than re-derived, direction is `rayDirection` on the u32 R2 sequence.

#### 12.14.1 What it costs in bindings, and why the probe table is not in it

The kernel reads `pixelProbe` and nothing else from the store. The LOD is RECOMPUTED from the camera
uniform rather than read out of `PROBE_KEY`, because the probe table would be a second storage
binding in a kernel already carrying the occupancy pyramid, and this module has died on the portable
8-buffer limit often enough that AGENTS.md leads with it. The two agree by construction — same
camera uniform, same `lodAtDistance`, same `floor`. The binding audit walks the pass (it is in
`system.passes`) and it stays under the line.

The SINK is four atomic words in its own buffer, not the ray-hit counters: those are shared with
every other profiled trace in a build, so a nonzero `rays` there would not prove THIS pass ran. It
also exists so the trace has an observable side effect at all — a traced result nothing reads is a
traced result a compiler may delete, and the deletion would present as a pass that dispatches, costs
nothing and reports zero.

#### 12.14.2 THE SMOKE WAS ASSERTING A TRACER THAT NO LONGER RUNS

The first green run failed on `hybrid local-brick traversal counters stayed at zero`, and the
assertion was wrong rather than the code. `pickOccTrace` ships TWO rungs, not five (§4.3): the plane
marcher for modes 2-4, the legacy occupancy march below it. Since the scaffold is now the module's
ONLY profiled tracer, the counters that get written are the ones **SRC's rung** writes —
`traceOccupancy` feeds rays/hits/macroSteps and nothing else, so `?mode=hybrid-brick-box` reports
`brickSteps = 0` legitimately.

The mode assertions now key off `srcPlaneTrace`/`srcExactTrace` rather than the engine's requested
mode. Nothing user-facing lost a gate: every quality tier ships HybridPlane or above (RayHitConfig),
so the rungs SRC dropped are not rungs any user is on. **The general lesson is worth more than the
fix — an assertion written against a backend outlives the backend, and reads as a regression in the
one that replaced it.**

The leniency §12.12.4 added SHRINKS rather than vanishing, and that is the honest end state: the
counters are fed if and only if `?src=1`, so that arm now REQUIRES them without needing
`?requirerays=1`, and the skip survives only where SRC is compiled out. `?requirerays=1` alone still
FAILS, which is the check that the pin itself still works.

#### 12.14.3 THE STEP BUDGET WAS THE DENSE BACKEND'S — 274 → 1 → 0

`createSrcSceneTrace`'s default 96 is the interval-ray number, and srcTrace's own header warns SRC's
rays are longer. They are. On the smoke scene (8 m, 19,200 rays), the legacy rung:

| steps | stepLimitExits | hit rate |
|---|---|---|
| 96 | **274** | 77.2% |
| 128 | 1 | 77.0% |
| **192** | **0** | **77.0%** |
| 256 | 0 | 77.0% |

**The hit rate converging on the same schedule is the confirmation that matters.** An exhausted ray
fails CLOSED from detail (occupancyField's "fail closed on step exhaustion" note), so those 274 were
arriving as hits — the budget was not merely tight, it was manufacturing geometry.

Shipped at 192, not at the lowest passing value, because **the budget is a loop CEILING and not a
cost**: a ray that resolves in twenty steps pays twenty whatever the bound is. The only thing a
higher ceiling buys is that the rays which would have given up finish instead. The plane rung clears
96 on its own — 192 is sized for the rung that does not. `?raysteps=N` keeps the A/B, and **this was
measured on an 8 m scene, so unit 3 has to re-measure it on a real one.**

#### 12.14.4 A u32 SUM WRAPPED AND REPORTED A PLAUSIBLE BUG

The sink first accumulated since boot, exactly as `RayHitDebug` does. The boot window reported
**136,012,800 rays at a mean hit distance of 0.027 m** — below the trace's own `tMin` self-bias, so
arithmetically impossible. The sum had wrapped a u32 twenty-odd times.

Recorded because the surviving number looked like a REAL failure: an implausibly small mean hit
distance is the signature of rays hitting their own origin voxel, which is precisely what this pass
exists to detect. A diagnostic whose overflow mode impersonates the fault it is watching for is
worse than no diagnostic. Now cleared per frame by a 1-thread dispatch ahead of the trace, which
also makes `rays` a number a reader can check by hand against the pixel count.

#### 12.14.5 The refinement trend, which is the closest thing to an eye check here

Same scene, same rays, three intersection backends:

| rung | hit rate | mean hit t | max t |
|---|---|---|---|
| legacy occupancy (whole-voxel) | 77.1% | 0.643 m | 7.10 m |
| hybrid-plane (surface records) | 41.0% | 1.945 m | 9.17 m |
| exact-complex (triangle pool) | 34.7% | 2.101 m | 8.35 m |

Each sharper rung rejects more conservative-voxelization bulge and finds the real surface further
out. That is §12.2's rule applied to a new instrument — **the gate measures the refinement TREND,
not a tolerance** — and it is the strongest available evidence that the rays are geometrically
sane before anything shades them. It is NOT a substitute for §12.13.1's outstanding eye check.

#### 12.14.6 What unit 2 starts from

Unchanged from §12.13: the CPU mirror is complete and green, `srcRays.js` is Alg. 3 with the
atomic-cursor down-pass, and the mirror diff compares the PARTITION rather than the indices.
One thing is now settled that was not: the trace closure exists, is bound, and its budget is
measured — so unit 3's deposit is wiring a known-good tracer into a known-good probe set.

Gates at `4c004ee`, all green: `smoke:gi-gpu` on `?src=1`, `+mode=hybrid-plane`,
`+mode=hybrid-exact-complex`, `+dynobj=2`, both non-src defaults, and `?requirerays=1` alone failing
as designed. `test:gi-src-{math,probes,populate}` ×2, `test:gi-src-{ref,volume}`, `test:gi-dynobj`,
proxy-fit, boot-ambient, light-tree. **Emitter shadow probe EXACT on both arms** —
`penumbraPx=16601 grain=0.0307`, `floorIn=12865 miss=14573`, unchanged from `711a8e1`.

### 12.15 Phase 2 unit 2 — Algorithm 3, and the two passes it does not need

`85a2062`. `srcRays.js`: counts UP the ladder, offsets DOWN, ten dispatches. §12.13.3 pre-decided
the shape and it survived contact — what follows is what it cost and what the gate had to be.

#### 12.15.1 An atomic cursor IS an offset allocator

Read as written, Alg. 3 wants two things the GPU is bad at: a prefix scan over the top cascade, and
a child list per parent (a compaction, since "the children of probe P" is not a contiguous range
anywhere). One trick removes BOTH, and it is worth stating in that generality because the second use
was not in §12.13.3:

> Seed a cursor with a range's start, and `atomicAdd(cursor, n)` returns a slice of it. The claims
> partition the range exactly — no gaps, no overlaps — and it costs one atomic per claimant.

- **Down the ladder**: each parent's cursor starts at its own `rayOffset`; each child claims.
- **The top cascade**: one GLOBAL cursor starting at 0; each top probe claims. That is the scan.
- **The pixels**: each c0 probe's cursor, already seeded, hands out `raysPerPixel` per pixel. Same
  allocator, third use.

**Each probe seeds its OWN cursor in the same pass that claims its slice**, which is safe rather
than lucky: its children read that cursor in the NEXT dispatch, so it is a write-then-read across a
barrier. That collapses what looked like two passes per level (init, then claim) into one.

#### 12.15.2 THE COUNTS CANNOT LIVE IN `probeTable`, AND THE REASON IS THE DEBUG VIEW

`PROBE_RAYS`/`PROBE_RAYOFF` were reserved for this in Phase 1 and both are still written — but as
PLAIN copies by the owning thread, after the fact. The accumulator has to be atomic (every pixel
adds into its c0 probe, every child into its parent), and **`probeTable` cannot become an atomic
buffer: `srcGizmos.js` reads it from a VERTEX stage, where WebGPU binds storage buffers read-only
and an atomic needs `read_write`.** Converting the table would have compiled, then failed the gizmo
pipeline — i.e. it would have cost the debug view that §12.13.1's outstanding eye check depends on.

Aliasing one buffer behind an atomic and a non-atomic node is the other obvious escape, and
`srcProbes.js` had already considered and rejected it ("one buffer, one definition of what it is").
So the accumulators are their own buffers (`rayCount`, `rayCursor`, one atomic word for the total)
and the table keeps the settled answer, which is what every non-atomic reader wants anyway.

`rayCursor` is deliberately NOT cleared per frame: every live probe overwrites it before any child
reads it, and a dead probe's stale cursor is never read. `PROBE_RAYOFF` clears to **SLOT_EMPTY, not
0** — zero is a VALID offset that exactly one probe per frame owns, so a dead probe left at 0 is
indistinguishable from the probe owning the start of the sequence, and a consumer walking a broken
chain would deposit into ray 0.

#### 12.15.3 The gate compares the partition, and proves the non-determinism is real

`test:gi-src-rays` — standalone page, own renderer, synthetic gbuffer, no engine, same isolation
`gi-src-populate` gets. Six arms: counts by KEY, top-cascade tiling of `[0, total)`, each parent's
children tiling ITS range, pixel slices tiling their probe's segment, `[0, total)` as a permutation
end to end, and a rerun. `raysPerPixel` is pinned to **2**, because at 1 a probe's count equals its
pixel count and an implementation that forgot the multiply passes every arm.

Result: **9,374 rays over 410 → 115 → 65 → 64 probes**, matching the mirror exactly, with
conservation checked at EVERY level rather than only at the top (a level whose sum drops is a broken
parent link eating rays silently).

The rerun arm is the one worth copying. It asserts the total and the counts are identical, and
**REPORTS the number of probes handed a different offset rather than asserting anything about it** —
measured at 169 / 93 / 115 / 54 across four runs. A run where NOTHING moved would mean the atomics
happened to serialize, and the gate would be passing without ever exercising the scheduler
non-determinism its whole design is built around. Printing it is how a future session can tell a
green from a vacuous green.

#### 12.15.4 The scaffold now fires the real indices, which buys an end-to-end invariant

`srcRayPass.js` used the PIXEL index as its R2 index because Alg. 3 did not exist yet. It now uses
`pixelRayBase[i] + k`, unrolled `raysPerPixel` times (the marcher is a `sharedFn`, so N rays are N
call sites, not N copies of the DDA). That makes the scaffold's own ray count equal the frame's
`totalRays`, and the two numbers come from OPPOSITE ENDS of the frame — one from Alg. 3's global
cursor on the CPU readback, one from an atomic inside the marcher's kernel. The smoke asserts they
match: **19,200 traced = 19,200 budgeted on every arm.**

That check covers exactly what the standalone gate cannot: the REAL gbuffer. A pixel whose probe
exists but whose range never arrived keeps `SLOT_EMPTY` and simply does not fire — silent
everywhere else.

The ray frame is built UNCONDITIONALLY (unlike the scaffold trace, which needs a volume): the budget
is not a diagnostic, it is the numbering every later deposit is addressed by, and unit 3 needs it
either way. Ten tiny dispatches over the probe table, no marching — the smoke's SRC arm went 19 → 29
dispatches and the binding audit still finds nothing near the portable limit.

#### 12.15.5 What unit 3 starts from

Everything it addresses now exists: a probe set, a complete ancestor chain per probe, a bound and
budget-measured tracer, and a global ray numbering whose partition is proven against the mirror. The
deposit's remaining decisions are §12.13.4's — F = 16, and the `Lmax` clamp-vs-auto-exposure question
that is deliberately still open pending a measured hit-radiance distribution. The scaffold's sink
already reports mean and max hit distance per frame, which is the instrument that question needs.

Gates at `85a2062`: `test:gi-src-rays` ×4, `test:gi-src-{math,probes,populate,ref,volume}`,
`smoke:gi-gpu` on all four src arms and both non-src defaults, emitter shadow probe EXACT
(`penumbraPx=16601 grain=0.0307`).

### 12.16 Phase 2 unit 3 — the split scatter, and a gate with no scene to trace

`975cd58`. `srcDeposit.js`: [E] the fixed-point scatter and [F] the resolve. Unit 1's scaffold ray
pass is deleted — this kernel traces the same rays through the same closure and additionally does
something with the answer.

#### 12.16.1 What is fixed point and what deliberately is not

Radiance accumulates as `round(L/Lmax · 2^16)`, per §12.13.4. **Transmittance does not.** Every
deposit's T is exactly 0 or 1, so `sumT` is an integer COUNT of clear deposits and `T = sumT/count`
is exact — spending fixed-point bits on a two-valued integer is precision theatre. Layout is five
words per bin: R, G, B, sumT, count.

Headroom, measured rather than assumed: the gate's worst bin held **21 deposits** and its worst
accumulator reached **18,850 of 2^32** — a 2.28e5× margin against §12.13.4's predicted
65,536-saturated-ray overflow bound.

**`Lmax` is still open, and now it has an instrument.** The clamp counts itself (`STAT_CLAMPED`,
`STAT_MAXL`), so the clamp-vs-auto-exposure decision gets made from a measured hit-radiance
distribution as §12.13.4 required. `smoke:gi-gpu` asserts the count is ZERO while hit shading is
null — the moment it stops being zero, that assertion says so instead of the clamp quietly eating
energy at exactly the bright hits that matter.

#### 12.16.2 No hit shading is the plan, not a gap

`shadeHit` defaults to null and the engine passes null. §7 puts full hit shading in **Phase 5** and
describes Phase 2's look as "AO-like short-range bounce" for precisely this reason: with radiance
zero, what survives the resolve is TRANSMITTANCE, and a receiver lit by transmittance alone against
the sky is ambient occlusion. That is not a placeholder standing in for the real thing — it is the
real thing with one term still zero, which is exactly why it is checkable now.

#### 12.16.3 THE BINS ARE SIZED BY PROBE CAPACITY, AND THAT IS A NAMED DEBT

A bin's slot is `binBase[cascade] + localProbeIndex · binCount(cascade) + morton`. Direct, no
indirection — and sized by probe CAPACITY rather than by live probes. §4.2's design says "only
cascade-live slots", which needs a claimed bin block per probe (`PROBE_SPARE` is the reserved word).
That indirection is NOT built here because it has to be claimed and released on the probe's
lifetime, which is Phase 3/4 machinery, and unit 3 is about whether the scatter is correct.

The cost is real, bounded, and asserted rather than hoped for:

| c0 probes | bins | scratch + payload |
|---|---|---|
| 4,096 (the gate) | 2.88M | 99 MB |
| 16,384 (the engine default) | 3.67M | 127 MB |

`createSrcBinStore` throws by name past `maxStorageBufferBindingSize` (128 MiB), which is roughly
32k c0 probes. **Past that, SRC cannot build until the bin-block claim exists** — so this is the
thing Phase 3 has to do first, not an optimization to schedule later. The gate measures the waste
directly: **0.24% of allocated bins were sampled.**

#### 12.16.4 A gate with no scene: the trace is keyed on the RAY INDEX

The standalone family has no occupancy field, which raises the obvious question of what the deposit
traces. The answer is the interesting part of this unit.

**Not geometry, and above all not anything keyed on the DIRECTION.** `rayDirection` runs through
`decodeDir`'s sin/cos, which are not bit-identical between WGSL and JS, so a hit distance derived
from `dir` disagrees in the last ulp — and a `t` a hair either side of an interval boundary lands in
a DIFFERENT CASCADE on the two sides. That is a real disagreement about nothing, and it would make
an exact diff impossible forever.

The ray INDEX is a u32 both sides agree on exactly. So:
- **the trace is `t = hash(n) · T_SPAN`** — `hash >> 8` is a 24-bit integer, exactly representable
  in f32, and `2^-24` is exact, so the conversion is bit-identical;
- **the shading is a 12-bit integer × `Lmax/65536` with `Lmax = 16`, a power of two** — so
  `round(L/Lmax · 2^16)` recovers that integer exactly and **every RGB comparison is integer
  arithmetic with no tolerance anywhere.** Without this the RGB accumulator would have no exercise
  at all, since the engine's `shadeHit` is null until Phase 5.

`srcRef.js`'s `traceAndDeposit` now passes the ray index to its trace closure — a third argument no
real tracer uses and a synthetic one needs. And the mirror runs against **the GPU's own
`pixelRayBase`**: unit 2's gate owns the partition, this one owns what happens to the rays in it.

`t` is deliberately independent of the pixel's reach. A reach-scaled `t` would need the mirror's
trace closure to know which pixel it was called for, which `traceAndDeposit` does not tell it — and
the gate would then have to re-implement the very loop it exists to diff against.

#### 12.16.5 The arm split that makes exactness possible

**Per-PROBE aggregates are bin-INDEPENDENT and therefore exact.** Direction quantization can move a
deposit between BINS of one probe; it can never move it between probes. So the arm that carries the
split rule, the ancestor-chain walk and the fixed point compares per-probe totals — **0 wrong on
count, sumT and fixed-point RGB across 460 probes.** The per-BIN arm is direction-dependent, so its
ties are counted and bounded (0–3 of 6,889, ≤0.5% budget) rather than asserted to zero. Pinning that
at zero would be pinning two transcendental implementations together, which is not a property this
module has or needs.

#### 12.16.6 The finding: stopping at the reach is the TRACE's job

The first synthetic trace returned a bare positive `t` and let `splitDeposits` handle the past-reach
case. Every deposit matched exactly — and the mirror reported **4,216 hits against the GPU's
4,118**. Both are right about the deposits (a `t` past every bound makes `splitCascade` return
`bounds.length`, which IS the escape case) and they disagree about whether the ray HIT. A real
marcher stops at `tMax`; a synthetic one has to as well, and it can, because the reach is
recoverable from the ray origin.

#### 12.16.7 Deposits per ray, and why the number is a cross-check

Bounded by `[1, N]` by construction — never 0 (even a hit inside cascade 0's interval deposits
there) and never above N (nothing is deposited above the owning cascade). `smoke:gi-gpu` asserts
both ends: 0 would mean the chain is not being walked, > N would mean the split deposits upward.

On the real scene it tracks the hit rate coherently, which is the cheapest available confirmation
that the split is doing what it claims:

| rung | hit rate | mean t | deposits/ray |
|---|---|---|---|
| legacy occupancy | 77.2% | 0.65 m | 1.685 |
| exact-complex | 35.4% | 2.19 m | 2.946 |

Nearer hits mean fewer cascades below them. Nothing enforces that relationship — it falls out.

#### 12.16.8 What unit 4 starts from

Every bin now resolves to `(rgb, T)` with **T = -1 meaning UNKNOWN** — outside transmittance's
[0,1] range, so it cannot be mistaken for data (2.88M bins checked). Unit 4 shades straight from raw
c0 with the merge disabled, composites sky where transmittance survives, and is **the commit where
the screen stops being dark**. It is also the first honest eye check of the rebuild, and §12.13.1's
deferred Phase-1 check is the first thing to rule out if the light lands in the wrong place.

Gates at `975cd58`: `test:gi-src-deposit` ×3, `test:gi-src-{rays,populate,ref,math,probes,volume}`,
`smoke:gi-gpu` on all four src arms and both non-src defaults, emitter shadow probe EXACT
(`penumbraPx=16601 grain=0.0307`).

### 12.17 Phase 2 unit 4 — the screen stops being dark, and what 46% of it was hiding

`aabd237`. **PHASE 2 IS COMPLETE.** `srcGather.js` shades straight from raw cascade 0 with the merge
disabled — guide §8.3's single-level sanity check, and the first thing in this rebuild a person can
look at and judge.

#### 12.17.1 What it computes, and why that is ambient occlusion

A c0 bin holds `(L, T)`. Hit shading is Phase 5, so every `L` is zero and what survives is
`sky · T` — how much of the hemisphere can see out. §7 calls Phase 2's look "AO-like short-range
bounce" for exactly this reason. It is not a stand-in for the algorithm; it is the algorithm with one
term still zero, which is why it is checkable now.

**The sky is `skyIntensity`/`skyColor`** — a live uniform that lost its consumer when the dense
transport died (§12.8) and gets one back here. It **defaults to zero**, so a project that never
touched it renders exactly as before, and the eye check needs the Sky Light slider turned up. That
is an authored control rather than a constant invented in the renderer.

#### 12.17.2 THE π MUST BE ANALYTIC, and the 1% that proved it

`E = π · (cosine-weighted mean radiance over the SAMPLED bins)`. The π is the analytic hemisphere
integral of the cosine, NOT `Σ max(0,cos)·Δω` over the bins. They are the same integral and the
discrete form carries a quadrature error that does not cancel: the first version measured a peak of
**3.173 against π = 3.1416**, one percent of energy invented out of 32-bin discretization.

Dividing by the sampled weight and multiplying by the exact π returns `π·L` identically, whatever
the bin count and whichever bins happened to be sampled. That is what makes the smoke's
`peak ≤ π·sky` a real CEILING rather than a tolerance — confirmed at two sky values, **3.1414 at
sky=1 and 6.283 at sky=2**.

#### 12.17.3 Its own pass, and the screen-space consequence stated rather than hidden

`createGiResolve` inlines its `gather` closure, and that kernel already carries the gbuffer, the
emitter slots, the occupancy pyramid for AO and the BVH against the PORTABLE eight-storage-buffer
limit. SRC's version would have added the probe table, the payload and the hash. So the gather is its
own pass writing a half-res texture, and the resolve SAMPLES it — a texture binding is free of that
limit. `createGiResolve` gained a `screenGather` input alongside `gather` for this.

The consequence: **this gather is SCREEN-SPACE.** It answers for the pixel, not for an arbitrary
world point, so it is wired to the primary diffuse term only and the exact-reflection hit path keeps
its documented `gather == null` behaviour. Phase 3's position-indexed probe gather is what fixes
that.

#### 12.17.4 THE BUG, AND THE THREE WRONG GUESSES BEFORE THE COUNTER FOUND IT

46% of the smoke's pixels came back with no GI. In order:

1. **Probe density** — wrong. A 3.2× finer `s₀` moved the count by 8 out of 8,809. (It also
   re-taught something worth keeping: **`s₀` barely changes probe density at distance**, because
   `lod = floor(log2(cheb/s₀))` and `probeSpacing = s₀·2^lod` — spacing is distance-proportional by
   design. c0 went 11 → 15 probes for a 3.2× finer lattice.)
2. **Back-facing normals** — wrong. Adding the face-forward flip changed the count by zero.
3. **Hemisphere coverage** — wrong, and it was the plausible one: probes are position-only, so a
   probe shared by opposing surfaces genuinely has bins in only one hemisphere.

A **one-word bad-normal counter named it in a single run**: those 8,809 pixels had a valid
`position.w` and a **ZERO NORMAL**. They are background. Every one of them inserted a probe at the
world origin, was handed a ray budget, fired a hemisphere of rays around `normalize(0) = NaN`, and
gathered nothing — because `NaN > 0` is false, so every bin was skipped and R1 correctly reported
"no information".

**`position.w > 0.5` is what `createGiResolve` tests, which is exactly why it looked like the right
test to copy. It is not sufficient.** Validity now tests BOTH channels, in `readPixel`, so the
population, the ray budget, the deposit and the gather all inherit one definition of "this pixel is
real". Rays dropped **19,200 → 10,391**: 46% were being fired from the origin into a NaN hemisphere,
polluting the origin probe on the way.

The general lesson is the diagnostic one. Three hypotheses cost three runs each and none was right;
a counter that could only be true or false cost one run and was decisive. **When a symptom has
several plausible causes, add the instrument that separates them rather than testing them in
order.**

#### 12.17.5 THE FACE-FORWARD FLIP BELONGS AT THE BOUNDARY, and the gate proved it

Putting the flip inside the deposit kernel made the GPU and the CPU mirror disagree about **28% of
bins** in `test:gi-src-deposit`. That is correct behaviour from the gate: `srcRef.js`'s
`traceAndDeposit` takes the normal it is handed, because the flip is a GBUFFER FACT and not an
algorithm property.

Moved into `readPixel`, where the deposit's ray hemisphere and the gather's query hemisphere are the
same vector by construction. **A flip on one side only would have each read the half of the bin
sphere the other never filled** — which is the same failure mode as the bad normals, arriving by a
different route.

#### 12.17.6 Step exhaustion is a RATE now, and that was measured not assumed

`stepLimitExits !== 0` was written for the dense backend's short INTERVAL rays. SRC's are
full-length and hemispherical from every pixel, so a few are tangent to the surface they were born
on by construction — and occupancyField's own note says exhaustion "leaks worst exactly where the
DDA descends most: a light raking along a floor or wall". Those rays fail CLOSED, which is designed.

What makes it a ray class and not a budget: the count is **0 or 1 in ~10,400 rays and INSENSITIVE to
the ceiling — 1 at 192 steps, still 1 at 256.** A budget problem would clear. The bound is 0.05%,
tight enough that a real traversal regression still trips it. (This is §12.14.2's lesson a second
time: an assertion written against one backend outlives it and reads as a regression in the next.)

#### 12.17.7 Where it landed

| arm | lit | peak | contrast |
|---|---|---|---|
| `sky=1` hybrid-plane | 10,391 / 10,391 | 3.1414 | 0.68 |
| `sky=1` exact-complex | 10,391 / 10,391 | 3.1414 | 0.49 |
| `sky=2` | — | 6.283 | 0.999 |
| `sky=0` | **0 / 10,391** | 0 | 0 |

Zero empty-probe, zero wrong-hemisphere, zero bad-normal on every arm. The `sky=0` row is asserted
too: no hit shading and no sky means genuinely no light, so a lit pixel there would be light from
nothing.

#### 12.17.8 THE OUTSTANDING EYE CHECK — THE ONLY THING PHASE 2 STILL OWES

Everything above is a number. What no number here establishes is that the light lands on the
geometry a person sees.

> **`__giSrcProbes = true` before the GI module builds, Sky Light above zero, over Sponza and the
> emissive-projectile game.** Expect an AO-shaped short-range darkening in corners and under
> geometry, with no bounce colour (hit shading is Phase 5) and no long-range term (the merge is
> Phase 3). A shimmer on a still camera is membership churn, not noise.

**§12.13.1's deferred Phase-1 gizmo check is the first thing to rule out if the light is misplaced,
not the last.** It has been an assumption carried forward since `711a8e1`, and this is the commit
where a wrong lattice would finally become visible.

Gates at `aabd237`: `smoke:gi-gpu` on five src arms and both non-src defaults, `test:gi-src-deposit`
×2, `-populate`, `-math`, `-rays`, `-ref`, `-volume`. Emitter shadow probe EXACT
(`penumbraPx=16601 grain=0.0307`).

### 12.18 Phase 3 entry brief — read this before writing anything

Phase 2 is complete and green (§12.14–§12.17). This section is to Phase 3 what §12.13 was to
Phase 2: what exists, what is already decided, and the two things that must happen in a specific
order before [G] is touched at all.

#### 12.18.1 THE ORDER IS NOT §7's ORDER, AND THIS IS THE MAIN POINT

§7 lists Phase 3 as "[G] merge + [H] irradiance tiles + [I] screen gather". **Do not start there.**
Two findings from Phase 2 sit in front of it, they are coupled, and doing them in the wrong order
means doing the second one twice:

1. **The bin-block claim** (§12.16.3). Bins are addressed by probe CAPACITY, 127 MB at the engine
   default, and `createSrcBinStore` throws past the 128 MiB binding limit at roughly 32k c0 probes.
2. **The LOD-0 reach constant** (§12.17.4, and the arithmetic below). Probe spacing is currently
   ≈ the camera distance, which is why the Cornell render is made of rectangles.

They are coupled because **fixing the LOD constant multiplies the probe count, and the probe count
is what the bin memory is a function of.** Fix LOD first and the bin store immediately refuses to
build. So: block claim, then LOD, then the merge.

#### 12.18.2 The LOD constant — the fix is one number, and it is derivable

`lodAtDistance` returns 0 only while `cheb ≤ s₀`, and `probeSpacing(0, lod, s₀) = s₀·2^lod`.
Composed, spacing ≈ cheb: LOD 0 applies **within 0.45 m of the camera** at the shipping s₀, and
everything beyond it is coarser in proportion to its distance. Angular probe spacing is therefore a
constant ~1 radian, about 57°, where it needs to be a fraction of a degree.

The correct form introduces the distance at which s₀ stops being fine enough:

> `lod = log2(cheb / (LOD0_REACH · s₀))`, clamped at 0.

`LOD0_REACH` is `s₀ / α` for a target angular spacing α. At α ≈ 1/100 rad (0.57°), that is
**64–128** — the same order as `REANCHOR_CHEBYSHEV`'s 64·s₀, which is not a coincidence: both are
"how far out does the LOD-0 lattice have to stay usable".

What it does to the probe count, estimated from visible surface area (probes ≈ area / spacing²):

| scene | visible area | today | at LOD0_REACH = 64 |
|---|---|---|---|
| Cornell (§12.17's render) | ~100 m² | **19** | ~280 |
| Sponza-class interior | ~2,000 m² | order 100s | ~10,000 |

Both land under the 16,384 c0 capacity `expectedC0Probes` already allocates, which is the useful
part: **the capacity was sized for the right answer all along, and only the LOD law was wrong.**

**Do not change this before the block claim lands, and do not change it in the same commit.** Every
probe count, load factor, mean-probe-step and timing in §12.11–§12.17 was measured under the current
law. Land it alone, re-measure the whole Phase-1/2 gate set, and record the new baseline — otherwise
every number in this document silently retires and nothing says so.

Suggested shape: a `LOD0_REACH` constant in `srcConfig.js` used by BOTH twins (`srcConfig`'s
`lodAtDistance` and `srcMathTsl`'s), because `test:gi-src-math` holds them bit-identical and a
one-sided change fails it — which is the gate doing its job.

**The framing conflict, which is worth knowing before anyone tries to make a demo picture.** The
visual probe (`probe:gi-src-visual`) currently renders something that does not read as a Cornell
box, and that is not only bad camera work. The two requirements fight:

- the canonical framing needs the camera well back from the aperture with a narrow field, and there
  the LOD law gives **3 probes** — the frame is literally three flat rectangles;
- pulling the camera inside the room raises it to ~19 probes and the shapes become legible, but the
  camera is then inside the box and the room reads as a corner rather than as the scene.

So **there is no camera placement that both frames the scene and shows structure**, and chasing one
is wasted effort until §12.18.2 lands. After it, the canonical framing should give a few hundred
probes and the picture becomes worth looking at. Re-shoot the probe then; it is the cheapest
before/after this rebuild will get.

#### 12.18.3 The bin-block claim — and it REDUCES memory rather than costing it

The instinct is that per-live-probe bin blocks are a ceiling-raiser bought with complexity. They are
not: they are a straight saving, and a large one, because the current scheme allocates for capacity
while §12.16's gate measured **0.24% of allocated bins ever sampled**.

| scheme | probes | bins | scratch + payload |
|---|---|---|---|
| by capacity (today) | 16,384 cap / 19 live | 3.67 M | **127 MB** |
| by claimed block | 10,000 live (post-LOD-fix Sponza) | ~1.3 M | **~47 MB** |

So the claim makes the LOD fix affordable *and* cuts the default footprint. Design, which is already
implied by the existing machinery:

- **`PROBE_SPARE` (word 7) is the reserved slot** — Phase 1 named it "irradiance tile slot (Phase
  3)" and this is that.
- **Reuse the free-stack pattern from `createSrcProbeStore`** verbatim: a pool of block indices, an
  atomic top, `atomicSub` to pop and `atomicAdd` to push. It is already written, already gated, and
  already handles exhaustion by leaving `SLOT_EMPTY` rather than clamping to 0.
- **Claim in the COMPACTION pass** (`createCompactPass`), which is where a probe is created and
  already pops a free index — one more pop in the same thread, no new dispatch.
- **Release in the AGE pass**, where a probe retires.
- **R10 says clear-shares-freshness-with-deposit**: a freshly claimed block must be zeroed before
  the first deposit lands in it. The claiming thread can do it (it owns the block and no one else
  can reach it yet), which also deletes the whole-buffer clear the deposit currently runs every
  frame over 3.67 M bins.
- **Failure mode to write down before it bites:** a probe that fails to claim a block must be
  treated as having no bins — i.e. its deposits are dropped and its gather returns UNKNOWN. NOT
  block 0. The `SLOT_EMPTY`-not-index-0 rule is already the module's convention (§12.15.2) and this
  is the same rule in a new place.

#### 12.18.4 What Phase 3 proper starts from — the mirror is complete

Same happy situation Phase 2 had. `srcRef.js` already has, all green under `test:gi-src-ref`:

- `mergeCascades` — Eq. 6/7, cascade N−1 → 0, with the top merging against the sky.
- `preAverage` / `preAverageChildBins` — the 4→1 pre-averaged cone, with unknown children SKIPPED
  and the average renormalized over what was found.
- `bakeProbeIrradiance`, `fillOctahedralBorder`, `binCosineWeights` — [H], the 6×6+border tiles.
- `sampleTile`, `gatherPixel` — [I].
- `sparseGather` / `trilinearCorners` in `srcMath.js` — the sparse-trilinear reader.

So Phase 3 is again "make the GPU agree with an existing mirror", and the gate family
(`gi-src-{math,probes,populate,rays,deposit}.html`) is the template: own renderer, synthetic
gbuffer, no engine.

#### 12.18.5 The gather this replaces, and the invariants it inherits

`srcGather.js` is the **c0-only, screen-space** placeholder and Phase 3 deletes it. Two things it
established should carry forward rather than be rediscovered:

- **The analytic π** (§12.17.2). `E = π · (cosine-weighted mean over sampled bins)`. Using the
  discrete `Σ max(0,cos)·Δω` instead invented 1% of energy. Whatever [I] looks like, it must keep
  the property that uniform radiance returns exactly π·L.
- **A real probe gather fixes the screen-space limitation** §12.17.3 records: `createGiResolve`
  calls `gather` at an exact-reflection HIT, an arbitrary world point that a screen texture cannot
  answer for. That call site has been on `gather == null` since the transport died. Phase 3 is when
  it comes back, and `screenGather` in `createGiResolve` should go away with it.

**§12.10.1 archives the retired `gate:gi-gather`'s four invariants and says to write a FRESH gate
rather than repair the old one.** They still apply: c0DirRes 2 is degenerate; texels varying 2.73×
in solid angle with Δω never written; a 40° source drifting 2.1× instead of converging. SRC's
equal-area bins already satisfy the solid-angle one by construction — say so in the gate rather than
assuming it.

#### 12.18.6 Traps carried in

- **The 4→1 parent mapping's DIRECTION** (§12.1): bins get FINER as cascade rises. The merge reads
  a parent whose grid is 2× wider per axis, and `preAverage` is what collapses four child bins into
  the one value the parent level consumes.
- **The octahedral border is CORRECTNESS, not layout** (§12.2) — +32% on a −Z receiver. `[H]`'s
  tiles are 6×6 interior + 1 border for this reason and `fillOctahedralBorder` is the mirror.
- **Zero-count bins are UNKNOWN, not zero**, through the merge as well as the resolve. `mergeBin`
  and `preAverage` both skip unknowns and renormalize; a merge that treats them as black
  reintroduces the cliff at every sparsely-sampled edge.
- **Accuracy gates measure the REFINEMENT TREND, not a tolerance** (§12.2).
- **`atomicLoad` on an atomic buffer** — WGSL will not implicitly convert `atomic<u32>` to `u32`
  and it fails at `CreateShaderModule`, which surfaces as a validation error rather than a wrong
  picture (§12.16, the resolve pass).
- **`probeTable` cannot become atomic** — `srcGizmos.js` reads it from a VERTEX stage (§12.15.2).
  Anything the merge wants to accumulate needs its own buffer.
- **The portable limit is 8 storage buffers per stage.** The merge will want probeTable, the
  payload, the hash and its own output; the resolve is already full, which is why `srcGather` runs
  as its own pass and hands over a texture (§12.17.3).
- **Row padding to 256 B** on any readback a new gate does (§12.17's visual probe paid for it).

#### 12.18.7 Suggested unit decomposition

1. **Bin-block claim.** No behaviour change, memory falls, `test:gi-src-deposit` and the smoke stay
   green on identical numbers. Gate: the existing suite, plus a new arm asserting blocks are
   released on retirement and that a claim failure yields UNKNOWN rather than block 0.
2. **`LOD0_REACH`, alone.** Both twins together. Re-measure and re-record the whole Phase-1/2 gate
   set — this is the commit that retires §12's probe numbers, so it should replace them.
3. **[G] the merge** — `srcMerge.js`, cascade N−1 → 0, against `mergeCascades`. Gate: a fresh
   standalone page in the family.
4. **[H] irradiance tiles** — the atlas, the border, the cosine weights. Gate: vs
   `bakeProbeIrradiance` + the furnace.
5. **[I] screen gather** — sparse-trilinear, position-indexed, replacing `srcGather.js` and
   `screenGather`. Gate: §12.10.1's four invariants, freshly written.

Then §7's Phase-3 gates: GPU furnace, `probe:gi-falloff` against analytic −2.72 (the metric the
current default fails at −2.18 — **this time a test guards the default**), `run-gi-rc-splitroom`
leak rows, and the interval-boundary ring check.

#### 12.18.8 Still owed from Phase 2

**The eye check.** `__giSrcProbes = true` before the GI module builds, **Sky Light above zero**, over
Sponza and the projectile game. Expect AO-shaped short-range darkening; no bounce colour (Phase 5),
no long-range term (Phase 3), and — until §12.18.2 lands — a visibly coarse lattice, which is
expected rather than a fault. §12.13.1's deferred Phase-1 gizmo check is the first thing to rule out
if the light is misplaced.

`npm run probe:gi-src-visual` renders the Cornell box to `artifacts/gi-src-visual/` (direct / gi /
both) if a picture is wanted without launching the editor.

### 12.19 Phase 3, units 1-2 — the block claim, the LOD law, and one property

Two of §12.18.7's five units, in the order §12.18.1 insisted on, plus a config
change that came from the user mid-session and belongs in the same record.

#### 12.19.1 Unit 1 — the bin-block claim (`3bfde7c`)

Landed as §12.18.3 describes: `PROBE_SPARE` became `PROBE_BLOCK`, a probe claims
a block in `createCompactPass` and releases it in `createAgePass`, and a failed
claim is `SLOT_EMPTY` rather than block 0.

**Measured: 3.67M bins → 1.40M, 133MB → 49.41MB on the engine smoke.** The
deposit gate fell 99.0MB → 33.0MB. §12.18.3 predicted 127 → ~47; the difference
is the probe store's own growth, which is the pool plus the wider slot ladder
below.

**THE POOL LIVES IN THE PROBE STORE, SHARING THE FREE STACK — and the reason is
the binding budget, not tidiness.** `createCompactPass` already binds six
storage buffers against a portable limit of EIGHT. A separate pair of pool
buffers would have put the pass that creates every probe exactly at the ceiling
with nothing left for the merge. One buffer, two regions: probe indices (global)
first, block indices (local to their cascade) after, with block tops at
`[cascadeCount, 2N)` in the same `freeTop`.

**§12.18.3'S "THE CLAIM DELETES THE WHOLE-BUFFER CLEAR" IS WRONG, and this is
the correction.** Claim-time zeroing is right for a PERSISTENT accumulator.
These are a single frame's estimate, so they need zeroing on every frame a probe
survives, not only the frame it was born. What the claim actually buys the clear
is that the buffer is 2.6× smaller. The claiming thread does not zero its block
either, and does not need to: compaction runs three dispatches before the clear,
so a block claimed this frame is covered by it anyway. Folding the clear INTO
the resolve would delete a full pass over `binTotal` and was not taken — the
deposit gate reads `bins.scratch` after every pass has run, and a
resolve-and-zero would hand it a buffer of zeros.

**Three new gate arms, because nothing in the existing suite could see any of
this:**
- **BLOCKS** — one block per live probe, distinct, in range. Two probes sharing
  a block passes every pre-existing arm while their bins are silently summed
  together, which is why distinctness is asserted directly rather than inferred.
- **STARVED** — `binBudget: 1` floors every cascade at `MIN_BLOCKS` and really
  runs the pool out (283 probes unclaimed at the time). The probes that DID
  claim still match the mirror exactly, which is what rules out a block-0
  fallback; dropped + landed reconciles to the mirror's total exactly.
- **RETIREMENT** — after every probe dies, each cascade's free stack must be a
  PERMUTATION of its blocks. One assertion covering both a leak and a
  double-free. A leak here is invisible for `blockCapacity` probe lifetimes and
  then permanent, which is the worst shape a bug can have: it survives every
  gate, ships, and becomes "GI stops working after a few minutes of walking".

**A SMOKE ARM WAS FLAKING ONE RUN IN FOUR and running it is what found it.**
§12.17 made `stepLimitExits` a 0.05% rate for SRC's tangent grazers but left the
macro/brick detail line a hard `!== 0`, so the same tolerated ray class still
tripped it: `hybrid-exact-complex&src=1` reported `brick=1` once in four
consecutive runs on identical code. Whether a grazer exists at all is a property
of the DRAW — the ray index comes from a scheduler-ordered atomic cursor
(§12.15) — so the two checks now share one budget. A budget that tolerates a ray
class in aggregate and then forbids it per rung is the same test with a coin
toss attached.

#### 12.19.2 Unit 2 — `LOD0_REACH`, and the new baseline (`ee2efde`)

`lodAtDistance` is now `log2(cheb / (LOD0_REACH · s₀))` with **LOD0_REACH = 64**,
in both twins. 128 — §12.18.2's other end — is rejected by arithmetic: it
quadruples the probe count and puts a Sponza-class interior at ~40,000 c0
probes, past both the slot capacity and the block pool. A power of two, so
`s₀·64` is exact in f32 and f64 alike and the twins cannot drift on the new
multiply.

**THE NEW BASELINE. Every probe count, load factor and timing in §12.11–§12.17
is retired by this line.** Real gbuffer, `smoke:gi-gpu ?src=1`:

| | before | after |
|---|---|---|
| probes c0/c1/c2/c3 | 13 / 10 / 10 / 10 | **184 / 45 / 18 / 8** |
| gizmo pixels | 24 | 412 |
| rays | 10,630 | 10,849 |
| deposits | 13,353 (1.256/ray) | 15,040 (1.386/ray) |
| memory | 49.41MB | 49.88MB |

14× the c0 probes, against §12.18.2's estimate of 15×. The population gate reads
**3,637 → 2,637 → 2,080 → 1,862** on its own set and the deposit gate
1,831 → 1,405 → 997 → 825.

**THE FALL ACROSS CASCADES IS THE LOAD-BEARING NUMBER, and the two sets
disagree about it.** On the real scene it is 4.1× / 2.5× / 2.3× — the
surface-manifold argument holding. On the synthetic sets it is nearly FLAT. That
matters well beyond tidiness, because the block pool's equal-bins-per-cascade
split IS that argument: bins rise 4× per cascade, so if probes do not fall 4×
the top cascade dominates and the budget stops working (c3 at 10,000 probes
would want 737MB). The reason the gates flatten is specific and does not
generalise: their LOD shells are 120-220 scattered points on a box whose area is
thousands of cells wide at EVERY cascade, so nothing ever merges. A contiguous
surface merges. `createSrcProbeStore` gained a `blockCapacity` override so a
gate can size a pool shaped like its own set rather than the engine's budget
being reshaped around an adversarial one — and `COUNTER_NOBLOCK`/`STAT_NOBLOCK`
are what will say so if a real scene ever disagrees.

**FOUR GATES ENCODED THE OLD LAW IN THEIR OWN GEOMETRY.** All four caught the
change, which is the system working, but they are now written through
`lodRadius` — the law's own inverse — so the next change moves them with it:
- `test:gi-src-ref` FAILED on `lodAtDistance(8·s₀) === 3`, the old law spelled
  out as a number. It now tests through the inverse, pins `LOD0_REACH` itself,
  and asserts the angular spacing is under a degree — the property the constant
  exists for, as something a reader can check.
- populate/rays/deposit placed their LOD shells at `s₀·2^lod`, which under the
  new law is entirely inside LOD 0. **They would have KEPT PASSING while testing
  a single ring.**
- The populate gate's ring arm called 265 correct probes wrong, because **LOD 0
  is a BALL now and the arm assumed a shell**. Under the old law that band was
  `[0, 2·s₀)` and the lower bound never bit.

**TWO REAL CAPACITY FINDINGS, both from the population gate:**
1. **1,063 INSERT FAILURES AT CASCADE 2** — silently missing probes, i.e. holes
   in the light. `c0Probes / 4^c` assumes the 4× fall; the measured ladder
   reaches that limit and then leaves it (410→115→65→64 = 3.5×/1.8×/1.0×). A
   slot is ~40 bytes, so `CASCADE_SLOT_FALLOFF = 2` brackets the measured range
   for ~0.4MB and does not touch bin memory, which is capped by the block pool.
2. The deposit gate's set starved c2/c3 (997 live for 683 blocks, 825 for 170) —
   the flat-profile artifact above, fixed with the explicit pool.

**THE PICTURE IS STILL BLOCKY, AND THE CAUSE IS NOT DENSITY.**
`probe:gi-src-visual` re-shot at the canonical framing gives 67 → 24 → 9 → 4
probes (19 at best before) and 75,760/76,800 lit at contrast 0.912 — but the
frame is made of ~0.6 m rectangles, and those rectangles ARE the probe cells at
the correct new spacing. `srcGather.js` assigns ONE probe per pixel and reads
its bins directly; there is no interpolation anywhere in it. **Unit 5 ([I], the
sparse-trilinear gather) is what removes the blocks, not a smaller s₀** —
`sparseGather`/`trilinearCorners` are already green in `srcMath.js`. Worth
knowing before anyone reads the picture as a probe-density failure and spends a
session on the LOD constant again.

#### 12.19.3 The config surface — §6, done properly, at the user's instruction

Mid-session the user made the call §6 had been circling: **"GI must not have any
params except the quality preset. GI is either correct or wrong. Having 20
params turns it into a puzzle — whenever something is wrong we have a headache
about which parameter broke our lighting."**

That is right, and it is a sharper statement of the problem than §6 had. The
component declared **27 properties**; it declares **one**. Everything else is
derived in the new `giConfig.js` — one table, four rows.

The distinction that makes it coherent: a preset trades COST against ACCURACY
and every level of it is meant to be correct, whereas a knob that can make the
lighting wrong is a bug generator with a label on it. Two things were neither
and moved rather than died — **sky light** to the scene's own environment
(`scene.environment` + `environmentIntensity`, where three.js and Scene Settings
already keep IBL), and **the debug view** to `globalThis.__giDebugView`, since it
draws an overlay and has no path to the lit image at all.

**Behaviour is unchanged and it is checked rather than asserted:** every value
sits at exactly the default the 27-property component shipped, so the two
tier-varying entries (`resolveScale`, `exactReflections`) differ only at
`ultra`. `penumbraPx=16601 grain=0.0307` and the SUN arm's `floorIn=12865
miss=14573` both pinned; smoke probes and memory identical; the sky arm peaks at
lum 6.283 = 2π exactly, so §12.17's analytic-π ceiling survives the new sky path.

**Two findings worth carrying:**
- **A LIVE PROPERTY WAS THE ONLY THING KEEPING THE SKY CURRENT.**
  `#applyLiveProps` runs on property change, and nothing notifies GI when the
  SCENE's environment changes — so the first version sampled the sky once at
  build and the visual probe went from 75,760 lit pixels to zero. Polled per
  frame now, beside the boot-ambient poll that exists for the same reason.
- **A SILENTLY-IGNORED PROPERTY IS THE EXACT FAILURE THE COLLAPSE IS AIMED AT,
  and the collapse created a dozen of them in the harnesses.**
  `run-gi-emitter-shadow-probe` passed `emissiveShadows: true` and would have
  gone on measuring a feature that was no longer built — it failed loudly only
  because the readback hit an undefined texture, which is luck rather than
  design. The component now NAMES the retired properties it ignores, once, and
  nine probes are converted to `globalThis.__giConfigOverride`: ONE measurement
  hatch that forces any derived value, deliberately not authored, not
  serialized, not in the Inspector and not reachable from a scene — the same
  category as the fifteen `__gi*` flags the module already carries. One hatch
  rather than one global per field, so the list cannot quietly grow back into a
  parameter surface.

**Sky chroma is open and stated rather than hidden:** an environment map's
average colour needs a 1×1 downsample, so a coloured HDRI currently contributes
NEUTRAL sky at the right brightness. Colour belongs with Phase 5's hit shading,
which has to sample the environment per-direction anyway.

#### 12.19.4 THE PHASE-1 EYE CHECK IS PASSED — and it was an assumption for three sessions

§12.13.1 recorded it as DEFERRED, NOT PASSED, on the user's "can't check the editor now, let's say
it's correct". That assumption has been load-bearing ever since: **every Phase-1 and Phase-2 gate
would have reported exactly what it reported if the gizmos drew a correct-looking lattice in the
wrong place.** The user ran it on Sponza after `f2f0173` and confirmed the thing that could not be
settled from a screenshot — **the probes HUG THE SURFACES**, rather than filling the volume, which
is what one-probe-per-visible-cell is supposed to produce.

Corroborated by the same frame:
- the lattice is regular and axis-aligned, receding cleanly down the nave, so
  `latticeOrigin = round(anchor/s)·s` is placing it where it claims to;
- spacing ≈ s₀ ≈ 0.6 m at the `medium` preset;
- **every probe is the same hue, i.e. all LOD 0** — correct under `LOD0_REACH = 64` (38 m of reach
  against a shorter nave), and a direct visual confirmation of §12.19.2: under the OLD law the same
  frame would have been a handful of enormous probes;
- **89 FPS** with population, Algorithm 3 and the split deposit all live.

So nothing downstream is resting on an assumption about the lattice any more, which matters most for
[G]: a merge built on a mislocated parent lattice would have produced plausible, wrong light with no
gate able to say so.

**What is still unjudged is the LIGHT, and the reason is worth writing down**: the user's Sponza had
no environment, so the sky term was exactly zero, and with hit shading still Phase 5 that means GI
genuinely contributes nothing — which is what the smoke asserts rather than a fault. Judging the
light is only worth doing after [I], because the current gather is one-probe-per-pixel with no
interpolation, so the lit image is ~0.6 m rectangles however good the lattice is (§12.19.2).

#### 12.19.5 What is next

§12.18.7's units 3-5, unchanged and in this order: **[G] the merge**
(`srcMerge.js` against `mergeCascades`), **[H] irradiance tiles**, **[I] the
screen gather**.

**[G] FIRST IS NOT NEGOTIABLE, AND THE REASON IS NOT THE PLAN'S ORDERING.** The
tempting shortcut is to do [I] alone — a position-indexed sparse-trilinear
gather over c0 would remove the blockiness a unit earlier and give a picture to
look at. It does not work: cascade 0's interval is r₀ ≈ 1.6·s₀ ≈ 1 m, so a
c0-only gather is smooth but SHORT-RANGE and reads as ambient occlusion rather
than as GI. **The merge is what gives it range.** Anyone reaching for the
shortcut to get a demo sooner will spend a unit and arrive somewhere less
convincing than where they started.

Everything [G] needs is already green in `srcRef.js` (§12.18.4) and the lattice
it merges over is now VERIFIED rather than assumed (§12.19.4) — which matters
specifically here, because a merge built on a mislocated parent lattice produces
plausible, wrong light and no gate in the suite could say so.

### 12.20 Phase 3, unit 3 — [G] the merge, and the mirror that was the wrong one

§12.18.7's third unit: `srcMerge.js`, cascade N−1 → 0 against `mergeCascades`,
with `test:gi-src-merge` as its gate. This is the commit where GI stops being a
one-metre effect.

#### 12.20.1 What it does, and what changes on screen

Eq. 6/7, in place over `[F]`'s resolved payload:

    L_merged = L_self + T_self · L_parent
    T_merged = T_self · T_parent

with the top cascade merging against the sky and `L_parent` the sparse-trilinear,
4→1 pre-averaged value from the cascade above.

**THE VISIBLE PAYOFF IS RANGE, AND IT ARRIVES EVEN THOUGH EVERY `L` IS ZERO.**
Hit shading is still Phase 5, so run the ladder with `L = 0` everywhere: the top
gives `L = T_top·sky, T = 0`, and each level below multiplies its own
transmittance in. Cascade 0 comes out holding `sky · Π T_i` — sky visibility over
the WHOLE reach — where the c0-only gather computed `sky · T_c0`, sky visibility
over about a metre. Same estimator, four levels of range. The Cornell probe shows
it directly: `lum 0.190..1.242` against a `π·sky = 6.28` ceiling, i.e. a sealed
box now correctly admits almost no sky, where before every direction unoccluded
at one metre voted full brightness.

#### 12.20.2 `srcGather.js` NEEDED NO CHANGE, and that is a property

The gather composites `L + T·sky` per bin. After the merge that expression is
correct in both cases it can now meet, which is why the file was not touched:

- a fully merged bin has **T = 0**, so the sky term vanishes and the `L` that
  already carries the sky down the chain stands alone — no double count;
- a bin whose parent chain broke keeps its own `T`, and `L_self + T_self·sky` is
  **exactly its old c0-only answer**.

So a missing parent degrades to the previous behaviour rather than to black. R1
falls out of the arithmetic instead of being coded for. Worth carrying into unit
5: [I] replaces this gather and has to preserve the same property.

#### 12.20.3 The three structural decisions

1. **IT MERGES IN PLACE.** Cascade c's dispatch reads cascade c+1's region —
   written by the previous dispatch — and writes only its own. No thread reads
   the region it writes, and the dispatch boundary is the barrier that makes the
   read legal. A second payload buffer would be another 22 MB at the engine
   default to hold values that die the moment the level below consumes them.

2. **THE 8 CORNERS ARE RESOLVED ONCE PER PROBE, NOT ONCE PER BIN**, in their own
   pass. The stencil is a property of the probe's POSITION, so hoisting it turns
   8 hash lookups per bin into 8 per probe — a factor of `binCount`, which is 32
   at c0 and 2,048 at c3. The records are indexed by **BIN BLOCK**, not probe
   slot: smaller (a cascade has fewer blocks than slots) and already the index
   the merge kernel holds, so no reverse map is needed.

3. **THE RECORD STORES THE PARENT'S BLOCK, NOT ITS PROBE INDEX.** One
   dereference moved out of the inner loop, and it keeps `probeTable` out of the
   merge kernel entirely — which matters at a portable limit of 8 storage
   buffers, since the kernel already wants payload + two corner buffers + stats.

Cost: 8 dispatches, ~0.9 MB of corner records (50.75 MB total, from 49.88).

#### 12.20.4 A STALE CORNER RECORD CANNOT BE READ, and the argument is the frame order

The corner pass writes records only for blocks a live probe currently holds, so a
block sitting in the free pool keeps whatever it was told last time it was
claimed — a dangling parent pointer, if anything read it. Nothing does: an
unclaimed block took no deposits this frame, the deposit's clear zeroed its
accumulators, and `[F]` therefore wrote UNKNOWN into every one of its bins, so
the merge takes its `selfT < 0` early-out before it ever looks at the record.

**The safety comes from the frame order, not from a clear.** Worth stating rather
than assuming: it is exactly the kind of invariant a later reordering breaks
silently.

#### 12.20.5 THE GATE SYNTHESIZES ITS OWN INPUT, and that is the design

`gi-src-merge.html` runs the probe population and then **does not run the
deposit**. It writes the resolved field straight into the payload buffer from a
hash of `(cascade, probe key, morton)`, and the CPU mirror reads the same
function.

Two reasons, and the second is the real one. First, `test:gi-src-deposit` already
owns whether the payload is right, so running it here would make every merge
failure arrive wearing a deposit failure's clothes. Second — **the interesting
inputs for a merge are the awkward ones**: unknown bins, parents whose four
children are only partly known, probes whose parent lattice has holes. A real
deposit produces those by luck; a synthesized field produces them by
construction, at a chosen rate (1 bin in 8 unknown).

**THE TRILINEAR WEIGHTS ARE EXACT, AND IT IS A PROPERTY OF THE LATTICE, NOT OF
THE GATE.** The parent lattice is exactly 2× coarser than the child's and both
are anchored by `round(anchor/s)·s`, so a child sits either ON a parent lattice
point or exactly HALFWAY between two on every axis. The fractions are exactly
{0, 0.5} and the eight weights are exact products of halves; with `s0` a power of
two nothing in that chain rounds on either side. So the corner arm demands **bit
equality** rather than a tolerance — an off-by-one in the stencil would otherwise
hide inside an epsilon. The merged-value arm is the only place in the gate with a
tolerance at all, because the merge's two divisions (by the known-child count
1-4, and by the found stencil weight) are where f32 and f64 finally part company:
**worst deviation 2.65e-7 against a 2e-5 bound, over 784,128 bins.**

#### 12.20.6 THE FURNACE ARM, and the one bug it exists for

Every bin `(L = 0, T = 1)` — a medium that blocks nothing. Then the merge has one
correct answer at every level and it is EXACT: the pre-average of four identical
values is that value, and a weighted mean renormalized by the weight FOUND is
that value again whatever the stencil looked like. So every merged bin must come
out **exactly the sky with T = 0**, and every orphan untouched at `(0, 1)`.
Nothing in between. Measured: **896,640 bins, worst error 0.**

That arm exists for one specific bug. A renormalization dividing by the FULL
stencil weight instead of the weight FOUND is invisible wherever all eight
corners exist and dims every probe where they do not — and on this set only
**2.03 of 8 corners** are found on average, so it would be wrong nearly
everywhere and still pass a per-bin diff against a mirror carrying the same bug.
Uniform-in-uniform-out is the check that does not care.

#### 12.20.7 THE MIRROR WAS THE ONE THAT WAS WRONG — `buildProbes` dropped probes

First run: `c3: 305 gpu / 256 mirror probes, 49 DIFFER`, and 27,065 of 696,253
merged bins disagreed. **The GPU was right.**

`buildProbes` sized each cascade's CPU map as `pixels.length >> c` — the
surface-manifold prediction that probe counts fall per cascade, spent as a
capacity. §12.19.2 had already measured that prediction failing (ladders flatten:
410 → 115 → 65 → 64), and this gate's scattered set runs **548 → 480 → 377 →
305**. At `>> 3` cascade 3 got a 256-slot map for 305 keys, `SrcProbeMap.insert`
answers a full map with −1, and `buildProbes` stores that as "no parent". So the
REFERENCE silently lost 49 probes, its merge then found fewer parent corners, and
the error propagated down the ladder into every c0 bin.

Two fixes, and the second is the one that matters:

- capacity is now **`pixels.length` at every cascade** — not a better guess, a
  BOUND: a cascade-c probe exists only because some c(c−1) probe inserted it,
  back to a pixel, so no cascade can hold more probes than there are pixels. A
  CPU-side map is two typed arrays.
- **`SrcProbeMap.insertFailures` now counts**, and the gate asserts it is zero.
  This is the GPU's `COUNTER_FAILED` on the CPU side, and it turns "the mirror is
  quietly incomplete" into one line of output.

**THE LESSON IS NOT "SIZE YOUR MAPS".** It is that a reference implementation
carrying a performance heuristic will eventually be wrong about the very thing it
is the reference for — and when it is, every gate reports the GPU as broken.
§12.19.2 had ALREADY published the measurement that invalidated this heuristic;
nothing connected it to the mirror, because the mirror's capacity looked like an
allocation detail rather than a correctness assumption.

#### 12.20.8 Two more findings, both from arms that were quietly vacuous

- **`atomicStore`, not `.assign`, on the stats clear.** WGSL will not implicitly
  convert `u32` to `atomic<u32>`; it fails at `CreateShaderModule`. The counters
  still LOOKED right, because a fresh buffer is already zero and the gate reads
  them after one frame — the bug's real shape is telemetry that doubles on frame
  two. Same trap `srcDeposit.js` records from the other side (`atomicLoad` on a
  read). It surfaced only because the gate asserts on `uncapturederror`.

- **"UNCHANGED" IS NOT "ORPHANED".** The orphan arm went through two false
  starts. It first looked for probes whose whole STENCIL was empty, found none,
  and passed while proving nothing. Rewritten to assert that the byte-identical
  bins ARE the orphans, it read **14,895 against the kernel's 44** — and that is
  not a bug either: a bin whose own `T_self` is ZERO merges to `L + 0·L_parent`
  and `0·T_parent`, byte-identical to what it was. One known bin in sixteen
  carries T = 0 in the synthetic field, and 237,926/16 ≈ 14,870.

  The arm now RE-DERIVES orphan-hood — a bin is an orphan when no corner of its
  stencil yields a known pre-average — and checks both directions: every orphan
  byte-identical, every non-orphan with T > 0 changed. **44 derived, 44 counted.**

#### 12.20.9 The numbers

Gate (`test:gi-src-merge`, three identical runs):

    probes 548/480/377/305     2.03/8 corners found (scattered synthetic set)
    784,128 bins diffed vs mergeCascades, worst 2.65e-7 against a 2e-5 bound
    237,882/237,926 known bins merged, 44 orphaned (0.02%), 100% reached the sky
    furnace: 896,640 bins, worst error 0
    11,240 corners and weights, bit-exact

Smoke (`?src=1&sky=1`, real gbuffer):

    40 dispatches (was 32), 50.75MB (was 49.88)
    3,575/4,352 known bins merged, 4.53/8 corners, 17.9% orphan, 100% to sky
    gather: 10,664/10,849 lit, lum 0.0007..3.1414, contrast 1.000

`peak = 3.1414 = π·sky` **exactly**, unchanged by the merge — the §12.17.2
ceiling is still a ceiling, which is the energy statement that matters.

Cornell (`probe:gi-src-visual`): 75,663/76,800 lit, `lum 0.190..1.242`, contrast
0.847.

**⚠ CORRECTION, MEASURED IN §12.21: DO NOT READ THAT CONTRAST AS A TREND.** This
section first said "contrast FELL from 0.912, and that is the merge working". It
is not supported. Four runs of the probe over an unchanged screen path give
`minLum` 0.031 / 0.035 / 0.062 / 0.190 and contrast 0.847 / 0.952 / 0.973 /
0.976 — a min over 76,800 pixels is a single-pixel extremum and one probe's
membership churn moves it. **`lit` (75,7xx) and the GI mean (≈53.5/255) are the
stable statistics here; `minLum` and `contrast` are not.** The merge's effect is
evidenced by the telemetry that does hold still — 100% of merged bins reaching
the sky, 4.53/8 corners found — and by the arithmetic, not by this number.

Shipping path unchanged — `run-gi-emitter-shadow-probe` still reads
`penumbraPx=16601 grain=0.0307`, and `__giSrcProbes` is still opt-in.

**THE PICTURE IS STILL BLOCKY AND [G] WAS NEVER GOING TO FIX THAT** — one probe
per pixel with no interpolation is unit 5 ([I]). Do not read the blocks as a
merge fault.

#### 12.20.10 New assertions, and what is next

`smoke:gi-gpu ?src=1` gained a merge block. The gate owns the arithmetic on a
synthesized field; what it cannot see is the REAL population, so the smoke checks
the ladder's CONNECTIVITY instead: the accounting closes
(`merged + orphans == bins`), the top cascade skied something, and — the arm that
matters — **the orphan rate is under 25%**. A merge whose parent lookups all miss
is arithmetically perfect and completely pointless: every bin keeps its own
one-metre interval and the picture is the c0-only one this unit exists to
replace.

Next: §12.18.7's units 4 and 5 — **[H] irradiance tiles** (the 6×6+border
octahedral atlas, against `bakeProbeIrradiance` + the furnace; the border is
CORRECTNESS, §12.2), then **[I] the screen gather** (sparse-trilinear,
position-indexed, replacing `srcGather.js` and `createGiResolve`'s `screenGather`
— and with it the `gather == null` on the exact-reflection hit path). [I] is what
removes the blocks.

### 12.21 Phase 3, unit 4 — [H] the irradiance tiles, and a kernel with no octahedral math

§12.18.7's fourth unit: `srcTiles.js`, the per-probe 6×6+border octahedral
irradiance atlas, gated by `test:gi-src-tiles` against `bakeProbeIrradiance`.

#### 12.21.1 What it bakes, and why cascade 0 alone

`E(n̂) = π · Σ L_bin·W(bin, n̂) / Σ W(bin, n̂)` per texel, over merged c0 bins,
into one `RGBA16F` atlas — 8×8 tiles, 128 per row, 1024×688 and 5.6 MB at the
engine default.

**c0 ONLY, and only because [G] already happened.** A merged c0 bin carries the
whole cascade chain's radiance and transmittance, so cascade 0 is not "the near
field" any more — it is the complete answer at the finest spacing the hierarchy
has. Tiles for cascades 1-3 would bake the same light more coarsely and nothing
would read them.

The normalization is the analytic-π form `srcGather.js` had to be corrected to
(§12.17.2). It is EXACT for uniform radiance at any bin count and whichever bins
were sampled, which is what makes the furnace arm a statement about the
estimator rather than about discretization, and what bounds Phase 5's
multibounce gain below 1 by construction.

#### 12.21.2 THE KERNEL HAS NO OCTAHEDRAL MATH AND NO BORDER PASS

Two facts collapse into one uploaded table, and the result is the smallest
kernel in the module:

1. `W(bin, n̂)` depends only on `(w, interior, sub)` — never on the scene — so it
   is computed once on the CPU by `binCosineWeights`, the SAME function the
   mirror calls. **There is no twin to keep in sync because there is no second
   implementation.**
2. A BORDER texel's value is by definition the interior integral at its wrapped
   texel. So instead of copying values after the fact, the border texel's table
   ROW is its wrapped interior row — and the thread that owns it simply computes
   that integral.

`tileCosineWeights` folds both into a `[texel · nBins + bin]` array covering all
64 texels of the bordered tile. What is left in WGSL is a loop multiplying two
numbers. No fold, no wrap, no copy pass — and, the part that actually mattered,
**no read-after-write on the atlas**, which a border-copy pass would have needed
and which WebGPU forbids for a texture bound writable in the same dispatch.

To get there, `binCosineWeights` MOVED from `srcRef.js` to `srcMath.js` and the
wrap rule became `octahedralBorderMap`, which `fillOctahedralBorder` now walks
rather than open-coding. One definition, two consumers, and the existing
`test:gi-src-ref` arms (including the −Z antisymmetry one, which reads
−8.88e-16) gate the refactor.

#### 12.21.3 THE TAPS CANNOT LEAVE THEIR OWN TILE, which is what makes a packed atlas safe

`sampleTile`'s interior-space coordinate is `(f·0.5 + 0.5)·interior − 0.5 +
border` with `f ∈ [−1, 1]`, so it spans `[0.5, interior + 0.5]` and the four
bilinear taps land in `[0, interior + 1]` — exactly the tile's own `interior + 2`
texels. No tap can reach a neighbouring tile, at any normal, for any probe.

That is asserted rather than argued: the `bleed` arm lights ONE tile in a field
of black ones and samples its four atlas neighbours at 4,096 normals. Any leak
in reads non-zero; any leak out darkens the lit tile below π·L. **0 of 6,144
channels either way.**

Hardware bilinear IS available here — `.sample(uv).level(0)`, with the explicit
level required because a compute stage has no derivatives to pick a mip with
(`bvhScene.js` pays the same tax). That is why the atlas is `RGBA16F` and not
`RGBA32F`: `rgba32float` is a storage format but is NOT filterable without an
optional feature, and filtering is the entire reason the tiles are octahedral.

#### 12.21.4 ALPHA IS COVERAGE, and it is there for [I]

1 where a texel found at least one known bin, 0 where it found none. The channel
was otherwise wasted, and what it buys is R1 implemented in the texture unit:
bilinear over RGB gives `Σ w_i·E_i` (empty texels store 0 and contribute
nothing), bilinear over alpha gives `Σ w_i` over the same taps, so `rgb / a` is
the renormalized average over the taps that HAD information — exactly
`sparseGather`'s rule, at the filter hardware's cost of nothing.

**NOTHING DIVIDES BY IT YET, deliberately.** The RGB written is bit-for-bit what
`bakeProbeIrradiance` produces, so [H] stays a make-the-GPU-agree unit and the
gate can diff it exactly. Whether [I] renormalizes — and whether the mirror's
`sampleTile` grows a coverage channel to match — is unit 5's decision, to be made
with the measured rate in hand: **6.7% of the texels of claimed tiles on the
smoke scene find no known bin.**

#### 12.21.5 A HEMISPHERE IS NOT ENOUGH TO LEAVE A TEXEL UNCOVERED

The coverage arm was vacuous on its first two attempts and the second failure is
the interesting one. Restricting a quarter of the probes to `z > 0` — a full
hemisphere, the shape a probe on a flat surface really has — still covered every
texel.

**Because a 6×6 tile has no texel AT the −Z pole.** Its four corners sit 19.4°
off it — the same 19.4° the border exists for — and a cosine lobe tilted 19.4°
off the pole still reaches bins on the far side of the equator. So at this tile
resolution a probe that saw a full hemisphere has an answer for every normal,
which is a reassuring thing to know and not what the arm needed. What produces
genuinely uncovered texels is a probe whose bins span much LESS than a
hemisphere — the real case at 0.78 rays per bin. One z band of four does it:
**8.6% uncovered, and the GPU's own empty counter agrees with the mirror
exactly (21,064 covered both sides).**

#### 12.21.6 The −Z arm, restated as an assertion

§12.2's finding was that without a border all four bilinear taps at
`n̂ = (0,0,−1)` collapse onto ONE interior corner texel whose own direction is
19.4° off axis — a systematic, orientation-dependent **+32%** on a −Z receiver,
invisible to any test that does not vary surface orientation and invariant to
probe spacing, ray count and angular resolution.

The gate now asserts the mechanism directly: all four border corners carry the
diagonally opposite interior corner, and a −Z sample equals the MEAN of the four
interior corners. And it prints what that is worth — **the four corners differ
by 51.3% of their mean** on the synthetic field, which is the size of the error a
border-less tile would make by returning one of them.

#### 12.21.7 THREE ARMS WERE WRONG BEFORE THE CODE WAS

Every one was a measurement mistake, not a bug, and each is worth its line:

- **"Lit texels must be a whole number of tiles."** True on the gate's dense
  synthetic field, false on a real one, and the smoke failed at 10,965/64 =
  171.3. A probe is POSITION-only: its bins are populated only in the directions
  its contributing pixels' hemispheres covered, so **a real tile is PARTIALLY
  lit**. Replaced with a ceiling (`lit ≤ liveProbes · 64`) plus an accounting
  identity (`lit + empty == texels`).

- **A relative error divided by the value.** The interior arm read 9.69e-4
  against a "1e-3 bound" — 97% of the way to failing, and pure arithmetic: a
  texel whose irradiance is 1e-4 carries an f16 rounding that is large
  relatively and irrelevant absolutely. Now reported as a fraction of its own
  ALLOWANCE (64.8%), which is the number a reader actually wants and cannot
  mislead that way.

- **The sampler's relative error, next to a zero texel.** Failed 6 of 12,288
  channels at 6.2% once the one-sided probes put hard `0 → π·L` edges in the
  tiles. Also not a bug: WebGPU permits bilinear weights at reduced precision
  (commonly 8 fractional bits), so the absolute error scales with the SPREAD of
  the four taps — and next to an uncovered texel that spread is the tile's whole
  range while the interpolated value is near zero. Restated as a fraction of the
  tile's RANGE, it measures **0.36%, against a 1% bound and a predicted 1/256**.
  The arm keeps its teeth: an addressing fault reads a different texel, which is
  an error of order the whole range.

**The pattern across all three: an invariant that holds for a DENSE field and
fails for a sparse one, and a relative error whose denominator can go to zero.**
Both are worth checking for in the next gate before running it.

#### 12.21.8 The numbers

Gate (`test:gi-src-tiles`, two identical runs):

    360 tiles of 512 blocks, 256×128 atlas, 0.26MB
    12,960 interior texels vs bakeProbeIrradiance — worst used 64.8% of its allowance
    10,080 border texels BIT-EXACT against their interior twins
    furnace 69,120 channels, worst 3.08e-4 relative (π·L, f16 rounding)
    corner spread 51.3%; 8.6% of texels uncovered, GPU counter == mirror
    4,096 sampler queries, worst 0.36% of tile range
    bleed: 0/6,144 in, 0/6,144 out

Smoke (`?src=1&sky=1`, real gbuffer):

    42 dispatches (was 40), 56.13MB (was 50.75) — the 5.6MB atlas
    10,990/11,776 texels lit in claimed tiles (93.3%), 8.8/32 known bins per texel
    peak tile E = 3.1414 = π·sky EXACTLY

Shipping path untouched — `penumbraPx=16601 grain=0.0307`, and the screen still
goes through `srcGather`.

**⚠ `probe:gi-src-visual`'s `minLum` AND `contrast` ARE NOISY.** Four runs over
an unchanged screen path: min 0.031 / 0.035 / 0.062 / 0.190, contrast 0.847 /
0.952 / 0.973 / 0.976. A min over 76,800 pixels is a single-pixel extremum and
one probe's membership churn moves it. **`lit` (75,7xx) and the GI mean
(≈53.5/255) are the stable statistics; do not read a single sample of the other
two as a trend** — §12.20.9 did, and has been corrected.

#### 12.21.9 What is next

§12.18.7's unit 5 — **[I] the screen gather**: sparse-trilinear, position-indexed,
replacing `srcGather.js` and `createGiResolve`'s `screenGather`. It is what
removes the blocks, and it carries three decisions this unit deliberately left
open:

1. **Does it renormalize by the coverage alpha?** The channel is written and
   measured (6.7% of claimed-tile texels uncovered on the smoke scene). Doing so
   diverges from `sampleTile` unless the mirror grows the same channel.
2. **What happens to the residual-transmittance sky term?** `srcGather`'s
   `L + T·sky` is what gives an ORPHANED c0 bin its answer today (§12.20.2), and
   the tile bake reads radiance only — so an orphan currently contributes zero
   through the tiles where it contributed `T·sky` through the gather. At 17.9%
   orphan on the smoke scene that is not a rounding difference.
3. **The exact-reflection hit path.** `createGiResolve` calls `gather` at an
   arbitrary world point and has been on `gather == null` since the transport
   died (§12.17.3). A position-indexed gather is what brings it back.

§12.10.1's four retired gather invariants apply to [I] and say to write a FRESH
gate rather than repair the old one.

### 12.22 Phase 3, unit 5 — [I] the screen gather. PHASE 3 IS COMPLETE.

§12.18.7's last unit: `srcScreenGather.js`, the sparse-trilinear, coverage-
weighted, LOD-blended probe gather, against `srcRef.js`'s `gatherPixel`.
`srcGather.js` is deleted.

#### 12.22.1 THE BLOCKS ARE GONE, and the measurement says so before the eye does

Every frame since §12.17 has been ~0.6 m rectangles, and §12.19 established they
were the probe cells at the CORRECT spacing — one probe per pixel with no
interpolation is piecewise CONSTANT across a cell, so no probe density could ever
have removed them.

The gate measures it directly rather than asking anyone to look: a scan line of
512 samples at **3.9 cm steps**, well inside one 0.5 m cell.

    interpolated:    100.0% of steps change value
    nearest-probe:     7.8%   (the same measurement, interpolation off)

The control is what makes the number mean something — 7.8% is the rate at which
that scan line crosses a cell boundary at all. And the Cornell render confirms
it: smooth gradients, contact darkening under and between the blocks, no cell
structure anywhere.

#### 12.22.2 ONE INTEGRAL, TWO CALL SITES

`gatherAt(position, normal)` answers for an ARBITRARY world point, and both
consumers inline the same closure:

- the **primary diffuse term**, once per gbuffer pixel, in this file's own
  compute pass, handed to `createGiResolve` as a texture;
- the **exact-reflection HIT**, at a world point no screen texture can answer
  for. That call site has been on `gather == null` since the transport died
  (§12.17.3). It is back.

Why the primary term still goes through a texture: the resolve kernel already
carries the gbuffer, the emitter slots, the occupancy pyramid and the BVH against
a portable limit of EIGHT storage buffers per stage. The closure costs two of
them, which is affordable ONCE and not per-pixel on top of all that.

**`createSrcHashBlockFrame` is what made even one affordable.** The natural
corner lookup is three fetches — `hashKeys` → hash slot, `hashSlot` → probe
index, `probeTable[probe].block` → the tile. The frame now publishes one word per
c0 hash slot holding that slot's BIN BLOCK directly, written by a pass that runs
after compaction has settled both halves. 128 KB at the engine default, and the
probe INDEX turns out never to be wanted by a gather at all — only its tile — so
carrying it through was pure indirection.

**A double-count nearly shipped with it.** `createGiResolve` applies `gather` to
the primary term AND adds `screenGather`, and since [I] those are the same
integral — so with both wired the pixel's irradiance was added to itself. The
primary line is now `if (gather && !screenGather)`. While there, the AO gate went
from `if (gather && ao…)` to `if ((gather || screenGather) && ao…)`: testing only
`gather` meant SRC's indirect went un-obscured for the whole of Phase 2 and 3,
which is not a decision anybody made.

#### 12.22.3 THE THREE DECISIONS §12.21.9 LEFT, ALL SETTLED, ALL MEASURED

**1. Coverage IS folded in, and it is worth up to 55%.** The atlas's alpha is
`Σ w_tap` over the covered taps exactly as its rgb is `Σ w_tap·E`, so each corner
contributes `rgb·w` to the numerator and `a·w` to the denominator and ONE division
at the end is the coverage-weighted mean over every contributing texel of every
contributing probe. Two consequences, both wanted: a probe that knows NOTHING
about a direction drops out of the interpolation (the same treatment
`sparseGather` gives a probe that does not exist), and a probe whose tap straddles
the edge of what it knows contributes in proportion to what it knows. Dividing per
tap instead would give every probe an equal vote regardless of how much of its tap
was real. The gate measures the alternative directly: **12 channels differ from
the coverage-blind gather, by up to 55%.**

`srcRef.js` grew `bakeProbeCoverage` and an optional `coverage` argument to
`gatherPixel` to match — a separate array rather than a fourth channel, because
the tile stride is 3 in `sampleTile`, in `fillOctahedralBorder` and in the Phase-0
suite's own arms. On the GPU it rides the atlas's otherwise-unused alpha.

**2. The residual-transmittance sky term moved INTO the bake**, in both twins:
`L + T·sky` per bin. Correct in both cases it can meet, for the same reason
§12.20.2 records — a merged bin has T = 0 so it reduces to `L`, and an ORPHANED
bin keeps its own T and gets exactly the answer the c0-only gather gave it.
Without it an orphan contributes zero where it used to contribute `T·sky`, and
§12.21.9 measured 17.9% orphans on the smoke scene. It changes nothing for a
fully merged field, which is why every existing furnace arm is unaffected.

**3. The reflection-hit path is wired** — see §12.22.2.

#### 12.22.4 What the gate checks, and §12.10.1's four retired invariants

`test:gi-src-gather` carries the retired gather gate's findings forward rather
than repairing it, as §12.10.1 instructs:

- *"c0DirRes 2 is DEGENERATE"* — not applicable; SRC's angular resolution is w₀
  and there is no dirRes knob.
- *"texels vary 2.73× in solid angle with Δω never written"* — satisfied BY
  CONSTRUCTION and said so rather than asserted: SRC's ray bins are equal-area
  cylindrical, so a bin average IS a solid-angle average, and the only octahedral
  surface left is the irradiance tile, which is sampled by a NORMAL.
- *"a 40° source drifted 2.1× instead of converging"* — the FURNACE arm is the
  strict form: uniform radiance returns exactly π·L at every pixel, at any probe
  density and whatever the stencil found. **Worst 1.14e-3.**
- *"accuracy gates measure the REFINEMENT TREND"* — the smooth arm, above.

Plus: every point against `gatherPixel` (**0 of 3,504 channels differ, worst
0.14% of the scene's peak**), LOD-shell continuity across `lodF = 1`, and a point
with no probes reading exactly zero AND being counted as empty rather than being
read off the screen as darkness.

**THE EMPTY ARM NEEDED ITS OWN GATHER, and the first version was a gate bug.**
Sixteen "far from every probe" points were put in the gbuffer — where the
population promptly inserted sixteen probes at exactly those positions and
gathered from them. A point with no probes cannot be expressed as a gbuffer
pixel. It gets a second `createSrcScreenGather` over query points the population
never saw — which is also the exact shape the reflection-hit call site uses, so
the arm covers that path too.

**AND THE COVERAGE ARM'S CAP AXIS MATTERED.** Capping a quarter of the probes to
`z > 0.5` changed nothing measurable, because the scan line's normals are
(0, 1, 0) and a +Z cap still leaves bins with a positive dot against +Y. A cap
OPPOSITE the query normal is what makes a contributing probe genuinely uninformed
about the direction being asked.

#### 12.22.5 THE CORNELL BOX IS NOW THE CORNELL BOX, and it found two harness bugs

At the user's request the visual probe was rebuilt from the Cornell University
Program of Computer Graphics' 1985 MEASUREMENT — the same quads every published
Cornell render uses — rather than a stack of `BoxGeometry` at roughly the right
proportions. Scaled ×100 (the measurements are millimetres: at 0.55 m the whole
box fits inside one probe cell), with the measured reflectances, the measured
130×105 ceiling luminaire, and the original's own camera.

**The canonical camera only became usable at §12.19.2.** The old harness sat 2 m
from the aperture with a 52° field and a comment explaining that standing where
the original does produced three probes for the whole scene — because under the
old LOD law `spacing ≈ the Chebyshev distance to the camera`. `LOD0_REACH`
replaced that law, the far corner of this box is 14 m from the canonical eye, and
everything is now LOD 0: **441 c0 probes, up from 67.**

Two bugs fell out, both silently wrong for the whole of Phase 2 and 3, both
invisible until a scene with a KNOWN CORRECT APPEARANCE existed:

1. **EVERY IMAGE THIS PROBE EVER WROTE WAS UPSIDE DOWN.** The capture flipped
   rows on the strength of "render targets read bottom-up" — the WebGL
   convention, not this backend's. A grey room with a plain slab at each end
   looks the same either way. A Cornell box has its light in the CEILING and its
   blocks on the FLOOR, and the flip was caught within one render of it arriving.

2. **THE LIGHT WAS NEVER A POINT LIGHT.** The component's prop is `kind`, not
   `type`, so `type: "point"` was accepted, stored in props, and ignored —
   leaving the DEFAULT DIRECTIONAL light lighting the "direct" arm. It read as
   plausible (the old arm rendered at 203/255) right up until the arm stopped
   responding to the lamp at all: **11.75/255, unchanged from intensity 5 to 400
   and from the ceiling to the room's centre.** An arm whose output does not move
   when its input moves is the signature, and it is worth more than any amount of
   staring at the number itself.

**The lesson is the reference scene's, not the bugs'.** Neither was found by a
test; both were found by a picture whose correct appearance was known in advance.
That is what a canonical scene is FOR, and this module went three phases without
one.

#### 12.22.6 The numbers

Gate (`test:gi-src-gather`, two runs):

    1,168 points vs gatherPixel over 437 probes — worst 0.14% of peak
    SMOOTH 100.0% of 3.9cm steps vary, against a 7.8% nearest-probe control
    furnace worst 1.14e-3; coverage worth up to 55%; LOD step 0.117 vs 0.068 median
    32 no-probe query points: 0 lit, 32 counted empty

Smoke (`?src=1&sky=1`, real gbuffer):

    43 dispatches, 56.26MB
    10,838/10,849 pixels lit, 0 no-probe, 4.54/8 probes per pixel
    peak 3.1406 ≈ π·sky — the ceiling still holds end to end
    exact-complex arm: 10,849/10,849 lit, contrast 0.973

Cornell (`probe:gi-src-visual`, canonical scene): 53,853/53,853 lit,
`lum 0.095..4.149`, contrast 0.977, 4.3/8 probes per pixel, probes
441 → 153 → 58 → 26.

Shipping path untouched — `penumbraPx=16601 grain=0.0307`, `__giSrcProbes` still
opt-in.

#### 12.22.7 Where Phase 3 stands, and what is next

**[G], [H] and [I] are done. Phase 3 is complete.** SRC now runs end to end:
population → ray budget → split scatter → resolve → merge → irradiance tiles →
smooth position-indexed gather, with the exact-reflection hit path restored.

What is still ABSENT, by plan rather than by omission:

- **Hit shading (Phase 5).** Every deposited radiance is zero, so the only term
  is transmittance and what the frame shows is sky visibility over the whole
  cascade reach. No bounce COLOUR — a Cornell box with no red on the white block
  is the correct picture of this commit.
- **Temporal accumulation (Phase 4).** Every frame is a fresh estimate; §12.13.4
  reserved the EMA for the resolved payload.
- **The eye check on Sponza and the projectile game**, which is a person's job.
  `__giSrcProbes = true`, Sky Light above zero. Expect smooth AO-shaped
  long-range darkening and no bounce colour.

Phase 4 is next per §7. `run-gi-rc-penumbra.mjs`'s `shadowMin ≈ lit` remains open
and pre-existing; the diffuse-measuring GPU rigs (`run-gi-bleed`/`block-size`/
`flicker`/`emissive`/`mover-bounce`/`rc-lattice`/`rc-splitroom`) measure a term
that is still partly zero, so a number from them means nothing until Phase 5.

### 12.23 Phase 4, unit 1 — the temporal blend, one stage earlier than planned

§4.6's exponential accumulation. `test:gi-src-temporal` is the new gate; the
mechanism is ~40 lines across `srcMath.js`, `srcDeposit.js` and `srcProbes.js`,
and every one of the findings below came out of holding it to a measurement.

#### 12.23.1 THE PLAN'S PLACEMENT WAS NO LONGER AVAILABLE, and the replacement is better

§4.1 step [F] says "temporal blend with resident probe history" and §4.2 sizes
`binPayload` to match — "the resolved payload PLUS the pre-averaged cone mirror
written by the merge", i.e. the merge had a destination of its own. **[G] merged
IN PLACE** (§12.20.1, worth 22 MB), so the resolved payload does not survive its
own frame: by the time the next frame could blend against it, the merge has
overwritten it with `own + T·parent`.

**Blending the merged payload in place is not merely inelegant — it multiplies
the parent's light by 1/α.** With `H ← (1−α)H + αS` followed by `H ← H + T·P`,
the fixed point is

    H = L + T·P/α

so at α = 0.1 the entire cascade above a probe arrives TEN TIMES OVER. Keeping
the plan's placement therefore means giving back exactly the 22 MB [G] saved.

So the blend moved one stage earlier, onto the fixed-point deposit
ACCUMULATORS: decay every word by `keep = 1 − α` before the frame's rays land on
top, so `ΣR/Σcount` is an exponentially-weighted mean over RAYS. Better on three
counts and worse on none:

1. **It weights by EVIDENCE.** A payload EMA gives one frame's single ray the
   same weight as another frame's twenty. At §12.13.4's measured **0.78 rays per
   bin** that is the difference between an average and a lottery.
2. **It needs no warmup path, and R6 comes free.** The plan carried
   `ALPHA_FRESH = 0.3` / `FRESH_FRAMES = 8` because a payload EMA starting from
   `H = 0` gives a newborn probe `0.1·S` and makes it crawl up from black over
   ~20 frames — precisely R6's "smooths MEMBERSHIP, not values". A fresh block's
   sums are ZERO, so its first frame resolves to that frame's own rays at full
   weight. **Both constants are deleted.**
3. **α = 1 is the code, not a branch.** `keep = 0` zeroes every word, which is
   the clear pass this replaced. §4.6's quality-gate configuration is one
   uniform — and every single-frame gate in the suite is unaffected at ANY α,
   because frame one has no history either way.

It costs a read where the clear only wrote, one word per bin block, and nothing
in the dispatch count (43, unchanged).

#### 12.23.2 COUNT AND TRANSMITTANCE BECAME FIXED POINT, and the resolve got simpler

`floor(1 · 0.9) = 0`. A count of ONE — which at 0.78 rays/bin is the common case
and not the corner — would drop to zero on the next frame and the bin would go
back to UNKNOWN having just been sampled. So `BIN_T` and `BIN_COUNT` carry
`DEPOSIT_F` fractional bits like radiance, and are no longer counts but WEIGHTS;
one ray deposits `2^16` rather than `1`.

The scale then **cancels out of `L = ΣR/Σcount` exactly** — `toL` is `Lmax/count`
with no `2^F` in it at all — so the resolve lost a term rather than gaining one.
The cost is one order of magnitude of overflow headroom, because a steady state
is `1/α` frames' worth: §12.13.4's 84,000× becomes 8,400×, measured at 123,000×
on the gate's own set.

#### 12.23.3 IT ROUNDS, AND THE FIRST VERSION TRUNCATED — WHICH ATE DIM LIGHT

The first implementation truncated, on the argument that rounding has a fixed
point (`round(x·0.9) = x` for every `x ≤ 5`) and would leave a bin reporting a
ray it saw a thousand frames ago. The STEADY arm failed at **1.8% relative**, and
chasing it produced the sharper statement.

A decaying integer accumulator does not settle on a point but inside an
INTERVAL, and the intervals differ in width AND in placement:

    truncation   x ∈ ( r/α − 1/α ,  r/α ]           entirely BELOW the truth
    rounding     x ∈ [ r/α − 0.5/α, r/α + 0.5/α )   half as wide, STRADDLING it

Either way the error is a fixed number of QUANTA, which makes it a RELATIVE
error inversely proportional to the signal — measured, converging from zero as a
fresh bin does:

    influx r/frame      6       65      650     6500    65536
    truncated       -15.0%   -1.39%   -0.14%  -0.014%  -0.001%
    rounded          -6.7%   -0.62%   -0.06%  -0.006%  -0.001%

`r` is `(L/Lmax)·2^F` per deposit, so **truncation is a systematic darkening that
gets worse as the light gets dimmer** — the worst possible direction for a term
whose whole subject is dim and indirect. And the width is only half the story:
the gather AVERAGES many bins, so a two-sided error cancels there and a one-sided
one accumulates into a darkening of the entire image. Measured after the change:
per-bin spread −0.479%..+0.033%, **mean −0.013%** — 36× smaller than the spread,
which is the cancellation itself.

Rounding's fixed point stops mattering because the resolve tests a WEIGHT FLOOR
rather than zero (§12.23.4). `MIN_WEIGHT` is 1024 against a residue of 5, a 205×
margin, asserted rather than assumed.

**And the mirror decays in f32 explicitly.** It happens to be unnecessary at
α = 0.1 — the f32 product's half-ulp is wider than the gap between `0.9_f32` and
`0.9_f64`, so both land on the same integer, verified over 285k values — but that
is a property of one α, and a twin that agrees for a reason nobody wrote down
stops agreeing when somebody changes the number.

#### 12.23.4 THE TAIL VOTES BLACK, and that is R1 broken by arithmetic

A bin that stops being sampled does not stop reporting: its weight fades
geometrically and `ΣR/Σcount` renormalizes by that same fading weight, so it
keeps FULL confidence in an ever-staler answer. That alone is defensible. Where
it ends up is not.

**The radiance word retires before the count does.** `R` is `L/Lmax` of `count`,
so for any bin dimmer than the ceiling it is the smaller number and rounding
kills it first. The last frames of a bin's life resolve to `almost-nothing /
small` — full-confidence BLACK, from a bin that was merely old, arriving by
arithmetic rather than by anyone deciding it. That is exactly the dark vote R1
forbids.

`MIN_WEIGHT` = a sixty-fourth of one ray retires the bin while `R` still has
bits. Measured over 1,208 tracked bins: **4.48% worst error on the last readable
frame, 3,177% one frame past the floor.** The guarantee holds while
`L/Lmax > 1/MIN_WEIGHT`; below that a bin fades out first, and by then it is
1/64 of a ray old and worth a thousandth of Lmax.

At α = 1 every count is a whole number of rays, so the floor never binds and the
test is the zero test it always was.

#### 12.23.5 A RECLAIMED BLOCK, AND A `NaN` THAT COMPILED

Persistent accumulators need something a cleared one does not: a block handed to
a new probe still holds the DEAD probe's history, geometrically unrelated, and
would fade in over ~1/α frames rather than being discarded.

`createCompactPass` now stamps the frame number onto every block it claims, and
a stamp equal to THIS frame makes `keep` zero. No fresh-block list, no second
dispatch, no ordering subtlety — the claim runs three dispatches before the decay
and the stamp goes stale by itself. It rides the pool buffer's tail rather than
taking a binding of its own (R7), because the pass that writes it already binds
six storage buffers against a limit of eight.

**The first version indexed `freeStack[NaN]`.** `createSrcBinStore` copies four
fields off each probe-store cascade and `blockBase` was not one of them, so
`stampBase + info.blockBase` was `undefined`; `uint(NaN)` compiled, ran, and read
the PROBE free stack, comparing probe indices against a frame number. It cleared
a scattering of blocks by coincidence. Only the RECLAIM arm caught it, and only
after that arm's own bug was fixed (below). The builder now throws on a
non-integer base — the cheapest possible guard against a class of failure that
produces no error at all.

#### 12.23.6 The gate, and the two arms that were measuring the wrong thing

Nine arms: `exact` (every word of a pure decay against `decayFixed`, bit-exact),
`forget`, `bias`, `dark`, `steady`, `single`, `bounded`, `reclaim`, `variance`.

**The trace is CONSTANT, and that is the whole design.** The deposit gate keys
its synthetic trace on the ray INDEX, which is right there and useless here:
§12.13.3's partition is scheduler-dependent, so an index-keyed trace feeds a
different signal every frame — the one thing a test of temporal convergence
cannot have. With every ray hitting at the same distance with the same radiance,
a bin's resolved value is independent of how many rays landed in it, so the
steady arm is exact UNDER the shuffle rather than in spite of it. And the arms
that test the decay do not trace at all.

Two arms had to be corrected, both for the same underlying reason — asserting a
property of the *model* rather than of the thing measured:

1. **"No bin was BRIGHTENED by the decay"** failed at −0.479%. I had mistaken the
   from-below convergence of the constant-influx orbit (which does land at the
   bottom of the interval) for a property of the operator. The per-bin error is
   two-sided; only the MEAN is systematic. The arm now checks that the errors
   CANCEL — |mean| < spread/10 — which is the property that actually matters
   downstream.
2. **The reclaim arm summed the whole pool** and read 3,068 bins holding decayed
   weights. Correct behaviour: a freed block nobody has claimed keeps its history,
   because the stamp fires at CLAIM and nothing walks the free list. That memory
   is unreachable and is zeroed by whoever claims it next. An arm that counts it
   is measuring the pool rather than the transport; it now walks live probes'
   blocks.

**And one arm exists because none of the others would have failed on a feature
that did nothing.** Every arm above tests that the blend is ARITHMETICALLY right;
a decay computing a flawless weighted mean of a signal with no variance would
pass all of them and buy nothing. `variance` feeds a genuinely noisy signal and
measures the frame-to-frame RMS of the resolved payload at α = 1 against α = 0.1,
against the `sqrt(α/(2−α))` an EMA of i.i.d. samples predicts:

    frame-to-frame RMS  4.023e-1 at α=1  →  8.673e-2 at α=0.1
    4.64x, against a predicted 4.36x

#### 12.23.7 The numbers

Gate (`test:gi-src-temporal`):

    20,963 bins held a constant signal to 2.34e-3 (0.033% relative, mean 0.013%)
    pure decay matched decayFixed word for word over 118 frames, 0 wrong
    1,208 tracked bins all retired BEFORE going dark; 4.48% vs 3,177% past the floor
    17.4 rays of accumulated weight (123,000x headroom), R <= count everywhere
    3,350 stale bins discarded on reclaim, 0 inherited
    frame-to-frame variation fell 4.64x against a predicted 4.36x

Smoke (`?src=1&sky=1`): 43 dispatches (unchanged), 56.32 MB (+0.06 for the
stamps), 10,573/10,573 pixels lit, peak **3.1406 ≈ π·sky** — the furnace ceiling
still holds end to end. Cornell: 53,853/53,853 lit, `lum 0.144..4.096`; the floor
rose from 0.095, which is the accumulation smoothing the darkest single-frame
estimates over the probe's three frames.

Shipping path pinned: `penumbraPx=16601 grain=0.0307`.

#### 12.23.8 What is left in Phase 4

§7's Phase 4 is "LODs + temporal accumulation", and the LOD half is already
done — the ladder and `LOD0_REACH` at §12.19.2, the ×0.9 overlap blend in [I],
re-anchoring at §12.12.2. Fresh-probe warmup is deleted rather than built
(§12.23.1). So what remains is §7's own gate list, which is measurement rather
than mechanism:

- **`run-gi-flicker-frame` ROTATE + fly-through arms** against the old-backend
  baseline. The `variance` arm proves the blend reduces variance on a synthetic
  signal; this is the same claim on a real one, in motion, where probe MEMBERSHIP
  changes too — and membership is the half an EMA cannot smooth (R6).
- **`probe:gi-block-size` ACF**, expecting block scale to track s₀·LOD (R14).
- **Memory high-water on an open-world scene**, which needs a rig built.

Phase 5 (hit shading) is where the radiance words stop being zero — and it
inherits one number from this unit rather than a surprise: the decay's relative
error is `~0.5·α/r` quanta with `r = (L/Lmax)·2^F` per deposit, so `Lmax` is the
exposure that sets it. §12.13.4 left clamp-versus-auto-exposure open pending a
measurement of the hit-radiance distribution; this is a second reason to close
it, and it does not bind until Phase 5 makes those words non-zero.

### 12.24 Phase 4, unit 2 — the flicker measurement, on a real scene in motion

§7's Phase 4 gate: `run-gi-flicker-frame` against the temporal blend. §12.23's
`variance` arm measured 4.64× on a synthetic signal with STABLE probe
membership; this is the same claim on Sponza, with a rotating box, where
membership churns — and R6 is explicit that membership is the half an EMA
cannot smooth.

#### 12.24.1 THE INSTRUMENT FORBADE THE OBVIOUS A/B, so α became live

`run-gi-flicker-frame.mjs`'s own header records that the SAME baseline config
read **1.404 and 5.194 reversals/px in two processes** — a 3.7× spread, larger
than any effect anyone has tried to measure with it — and that two conclusions
had already been drawn from cross-process comparisons and had to be withdrawn.

An α read once at GI build time can only be A/B'd by reloading the page, which
is exactly that forbidden comparison. So `__giSrcAlpha` is now **polled per frame
in `syncCamera`**, the same convention `__giDebugView` runs under, and the A/B
happens in one page, one renderer, one load. The uniform is written only when the
value changes, so a still scene's upload count stays at zero.

#### 12.24.2 TWO THINGS THE RIG NEEDED, and one of them is a lie detector

**A sky.** With hit shading still Phase 5 the sky is the ONLY radiance SRC
transports, so a run without one measures a uniformly black resolve texture and
reports a flawless absence of flicker — the same shape of failure the harness's
own `__editorKeepRendering` note documents ("that is not a quiet scene, it is a
stopped one, and it reads exactly like no flicker"). `sceneSkyRadiance` never
samples the environment texture (chroma is deliberately unread until Phase 5), so
a 1×1 white equirect is radiometrically exact here and needs no HDRI in the
project.

**Interleaving.** Running α=1 after α=0.1 once confounds the comparison with
whatever drifts over a five-minute page. Two rounds alternating the two values
make that drift visible instead: the first attempt read a **21% round-to-round
spread at α=1** against 3% at the default, which is most of the effect being
claimed. The reported run has 3% on both.

#### 12.24.3 THE MOTION-EXCESS RATIO IS THE WRONG STATISTIC ACROSS α

"Excess over the still control" is the right figure for comparing two BUILDS at
one α — the control cancels the page's load, which is what it was written for.
It falls apart across α, because **temporal accumulation moves the control**. At
α = 1 every pixel churns every frame from the R2 jitter alone, so the still floor
saturates and the moving arm has nothing to rise above:

    alpha 1     moving 6.815   still 6.919   "excess" -2%
    alpha 0.1   moving 3.318   still 2.688   "excess" +23%

Dividing those two excesses gave **−15.6**, which the first version of the block
printed and meant nothing by. Within one page the RAW counts are comparable —
that is precisely the condition the still-control note establishes — so the A/B
reports them directly, at both α, moving and still, over two rounds.

#### 12.24.4 What it measures: the noise halves, the STEPS do not move

Sponza, rotating box on two axes at 0.6 rad/s, 403×196 half-res, 150 frames per
arm, `QUALITY=high`, SRC on, sky 1:

    round  arm       reversals mv/still   stepP95 mv/still   walk mv/still
    1      alpha 1   5.886 / 5.357        0.1484 / 0.0567    0.333 / 0.292
    1      default   2.745 / 2.487        0.1410 / 0.0519    0.119 / 0.103
    2      alpha 1   6.071 / 6.225        0.1122 / 0.0646    0.312 / 0.335
    2      default   2.677 / 2.701        0.1515 / 0.0628    0.123 / 0.114

    round-to-round spread 3% at both alpha — the effect clears it
    reversals  /2.21 moving, /2.23 still
    mean walk  /2.67 moving
    step p95   x0.89 moving  — UNCHANGED

**Accumulation halves the per-frame churn and does not touch the worst-case
step.** Both halves of that are worth having in one sentence, because they answer
different questions and only the first is what the blend was built for.

#### 12.24.5 THE STEP FLOOR IS MEMBERSHIP, AND R6 NAMED IT IN ADVANCE

The 2×2 is what separates the two readings, and it needed the STILL arm's step
amplitude to close:

    step p95   alpha 1   0.1303 moving / 0.0607 still   (x2.1)
               default   0.1463 moving / 0.0573 still   (x2.6)

Two facts fall out. The moving step is ~2× the still step at BOTH α, so most of
it is real geometric change — a rotating box genuinely alters what a probe sees,
and smoothing that would be smoothing the SIGNAL. But the STILL step floor is
~0.06 at both α as well, and **if it were value noise α would have cut it by
four**. It did not, so it is not value noise.

The mechanism is bin-level membership. A bin that stops being sampled leaves the
readable set — at α = 1 the frame it is not sampled, at α = 0.1 about forty
frames later when its weight crosses `MIN_WEIGHT` — and the merge and the gather
renormalize over the bins they FOUND (R1). A bin flipping between "known dim" and
"absent" therefore changes the denominator, which is a step no accumulator on the
VALUES can smooth. R6 says exactly this and says it about probes; the same
argument holds one level down, at bins.

**This is the gap between the two measurements**, and it is the useful number:
the synthetic gate's 4.64× and this scene's 2.67× differ by what membership
contributes. It is not a defect discovered late — it is R6 being right — but it
does mean the tool for the remaining half is not a smaller α. Deliberately NOT
chased here: hit shading (Phase 5) changes what a bin CONTAINS, so the sampling
density that drives bin membership is about to change, and tuning against the
current distribution would be tuning against a distribution that is going away.

#### 12.24.6 Where Phase 4 stands

Mechanism (§12.23) and the motion measurement (this section) are done. Still open
from §7's gate list:

- **`probe:gi-block-size` ACF** — block scale should track s₀·LOD (R14). Note
  §12.22's finding stands in front of it: the blocks that probe was built to
  measure are gone, so it needs re-reading rather than re-running.
- **Memory high-water on an open-world scene**, which needs a rig built. SRC's
  envelope is screen-proportional by construction (§4.2), so this is a check of a
  claim rather than a search for a number: 56.32 MB at the engine default on the
  smoke scene, against §4.2's ~180 MB worst case.

`__giSrcProbes` remains opt-in until Phase 6, and the "diffuse indirect" build
line now distinguishes the three states it can be in (absent / live but unlit /
sky visibility) rather than reporting ABSENT unconditionally — it had stopped
being able to tell them apart the moment the transport landed, which is the one
job its own comment claims for it.

### 12.25 Phase 4, unit 3 — the world-scale probe. THE CENTRAL CLAIM HOLDS, AND R16 IS NOW PRICED.

§7's last Phase 4 gate item, and §1's whole case for the rebuild: SRC's cost is
SCREEN-proportional and "unlike today it does not scale with world size" (§4.2).
Every §12 number until now was taken on an eight-metre room.
`probe:gi-src-worldscale` sweeps the world 8 m → 216 m — **729× the ground
area** — with the screen pinned at 320×240 and the block pitch constant, so a
wider world is more geometry over more ground rather than the same scene
stretched.

#### 12.25.1 What it measured

    scale     meshes   SRC      c0 probes   load    lit      occupancy
      8 m          5   56.32MB        105   0.003   100%     2.7MB @ 0.14m
     24 m         37   56.32MB        487   0.018   100%     8.2MB @ 0.15m
     72 m        325   56.32MB       1047   0.031   99.9%  107.5MB @ 0.16m
    216 m       2917   56.32MB        563   0.032   100%   143.1MB @ 0.26m

**The transport is flat to the byte**, which is true by construction (SRC's
buffers are sized from the pixel count and `BIN_BUDGET`) and is therefore a
regression guard rather than a discovery. The arms that could have failed are
the other three, and none did: probe population grew ~5–10× against 729× area,
the hashmap never passed a 0.034 load factor against its 0.5 budget, **zero
failed inserts and zero probes without a bin block at any scale**, and the
gather resolved essentially the whole gbuffer every time with the π·sky ceiling
intact.

The probe count is worth reading carefully. It is **not monotonic** — 1047 at
72 m against 563 at 216 m — because what drives it is how much distinct surface
falls in the near LOD shells, not how much world exists. At 216 m most of the
frame is far enough away to be coarsely sampled, which is exactly what the LOD
law is for and what §12.19.2 rewrote. This is the first evidence it holds past
14 m.

#### 12.25.2 THE HEADLINE IS THE OTHER TERM

§4.5 leaves the occupancy volume out of scope as "the remaining scene-scale
limit to solve separately" (R16). This is the first time it has been priced, and
it is not a rounding error beside the win:

**At 216 m the occupancy field costs 143 MB — 2.5× SRC's entire footprint — and
it is coarsening (0.14 m → 0.26 m voxels) while it climbs.** Resolution degrades
and memory grows at the same time.

So the accurate statement of the rebuild's central claim is narrower than "GI no
longer scales with the world": **the TRANSPORT no longer does, and the MEDIUM it
traces through still does, now dominantly.** Both halves belong in the same
sentence. A report that quoted the flat 56.32 MB alone would be true and
misleading at once, which is why this arm exists at all.

Nothing is asserted about the field's direction, deliberately — an arm that
failed unless the occupancy kept growing would lock in the defect and go red the
day somebody fixes it with the clipmaps §4.5 gestures at. The guard is a ceiling
on the TOTAL, so a regression in either term is caught without anyone having to
predict which.

#### 12.25.3 Two harness faults, both of which read as "SRC is broken"

Neither was a transport bug and both produced the same symptom — `state` null,
no probe system, 120 seconds of waiting:

1. **A `global-illumination` COMPONENT is what builds the system**, not
   `enableEngineModule`. The module compiles GI in; the system stays null until
   an entity carries the component.
2. **`engine.start()` is what runs it.** GI does its per-frame work from the
   Engine's preRender callbacks, so driving `renderer.renderAsync` by hand
   renders the scene and advances nothing at all.

And a third that was worse because it PASSED: the occupancy byte count lives on
`occupancyField.stats.bytes`, and reading `occupancyField.bytes` returned
`undefined` → 0.0 MB at every scale. The arm reported the field as free, which
is a stronger claim than the true one and in the wrong direction. It throws on a
missing count now — the honest half of a result has to fail loudly when it goes
missing, or it quietly becomes a press release.

#### 12.25.4 Phase 4 is complete except for one re-read

Mechanism (§12.23), motion (§12.24) and scale (this section) are done.

`probe:gi-block-size` is the one §7 item left, and it needs **re-reading rather
than re-running**: it sweeps `voxelSize` and `probeSpacing` with `autoFit` off,
and all three were retired when GI collapsed to one property (§12.19.5). Its ACF
metric is still the right instrument — the world period of the residual
structure — but the only dial left is `quality`, whose four tiers set s₀ to
0.8 / 0.6 / 0.45 / 0.35. That is the sweep to rebuild it around, and the
prediction §12.22 already made is that it finds NO period at s₀ at all.

### 12.26 Phase 5, unit 1 — hit shading in the CPU mirror. THE REFERENCE FOR `shadeHit`.

**Status:** landed on `feature/gi-src`, three commits, CPU only — `srcRef.js` +
`scripts/run-gi-src-ref-test.mjs`, nothing else touched. `npm run test:gi-src-ref`
is **124 checks, green, ~9s, no GPU**. `srcDeposit.js`'s `shadeHit` is still
`null`; this section is the executable spec it has to be filled from, and every
number below is the mirror's, not a GPU measurement.

#### 12.26.1 What §4.4 turns into, in code

    L_hit = emissive(H) + ρ(H)/π · [ Σ_lights direct(H) + E_secondary(H) ]

New in `srcRef.js`: `faceForward`, `clampLoopAlbedo`, `hashUnitFloat`,
`makeVisibility`, `sunIrradiance`, `emitterIrradianceExact` (the arbiter),
`emitterIrradianceNee`, `makeHitShader`, `shadeTrace`, `makeSecondaryCache`,
`IMPORTANCE_FLOOR_FRACTION`. `traceAndDeposit` needed **no change**: on the CPU
the geometry trace and the shading compose (`shadeTrace`), which is the same
split the GPU has (`createSrcSceneTrace` returns a record, `shadeHit` is
`createSrcDepositFrame`'s own option) and it is what lets the brute-force
arbiter run the EXACT shading the estimator ran.

Two structural calls worth stating because they are absences:

- **Movers are not a branch.** §4.4 asks for "header mean albedo/emissive
  Lambert shading", which is the same expression with the surface read from
  somewhere else — so provenance lives entirely in `surfaceAt` and `shadeHit`
  never asks. A mover-shaped `if` is the shape of the bug where a moving crate
  lights the room differently from the identical static one beside it, and that
  bug is invisible until someone picks the crate up. Gated as an invariance.
- **The sky is not here.** A ray that escapes composites the sky in
  `mergeCascades`, at the top cascade, exactly once. Adding it at the hit would
  double it for every ray that both misses and merges.

#### 12.26.2 R4 IS NOW A MEASUREMENT, AND IT LANDS ON 0.9000 EXACTLY

The multibounce loop is run for real: a closed box, the secondary cache wired to
the previous iteration's tiles, eleven iterations. In a closed enclosure the
form-factor matrix has row sums of 1, so the operator is ρ·F and its spectral
radius is ρ — and `bakeProbeIrradiance` returning exactly π·L̄ for uniform
radiance (§12.17.2's analytic π) is what makes one turn of the loop exactly ρ·L.

| authored ρ | ceiling | E over 11 iterations | tail increment ratio |
|---|---|---|---|
| 1.0 | `MAX_LOOP_ALBEDO` = 0.9 | 0.686 → 3.418 | 0.8988 0.9004 0.8999 **0.9000** |
| 1.0 | 1.0 (canary) | 0.686 → 5.390 | 0.9986 1.0004 0.9999 **1.0000** |

The clamped series stays under its bound `E₀/(1−ρ)` = 6.86; the canary does not
converge at all. **The measured rate IS the ceiling, to four figures** — which
is the strongest form R4 can take, because it says the clamp is not merely
present but is the thing setting the rate.

**THE CLAIM IS ASYMPTOTIC AND THE FIRST VERSION ASSERTED MORE.** "Every
increment ratio < 1" failed on the SECOND increment at 1.2494, and the assertion
was the thing that was wrong: this is a power iteration, and the ratio converges
to the spectral radius rather than starting there. Bounce 0 is a small bright
ceiling seen directly; bounce 1 redistributes it over every wall, a larger
transfer than bounce 0 was. The early ratios carry the geometry of each
successive redistribution; only the tail carries ρ.

**THE CLAMP SCALES, IT DOES NOT CLIP PER CHANNEL.** Both forms satisfy the
bound; only one keeps the colour, and colour bleed is the entire product. A
per-channel `min(ρ, 0.9)` shifts the chromaticity of a warm white (1.0, 0.95,
0.90) by **1.75e-2**; scaling by `ceiling/peak` shifts it by 5.6e-17 and touches
nothing at or below the ceiling.

**A BRIGHTENING CANARY GETS EATEN BY THE CEILING.** The transport arm's injected
fault was ×1.6 on a 0.75 albedo — which is 1.2, which the clamp returns to 0.9,
a ×1.2 fault worth 11.6% of error and comfortably inside the bar. R4 absorbing
an injected fault is R4 working; it just makes a brightening canary a poor
instrument for anything else. It darkens (×0.55) now, and reads 52.9%.

#### 12.26.3 ⚠ THE SHADOW LIFT MOVES THE ORIGIN, SO IT MOVES `maxT` — AND THE WHOLE ANALYTIC EMITTER TERM VANISHES

The single most expensive finding in this unit, and it is one `srcTrace.js` has
to answer for too.

`createSrcVisibility` starts its shadow ray **0.75 voxels off the surface**
(R2: every bias tracks the DDA medium's quantization). Its `maxT` is supplied by
the caller and is naturally measured from the SURFACE point, because that is
where the light's distance is known. Those two facts do not compose: the same
world point sits at a different `t` once the origin has moved, and **the emitter
is the very next thing along the ray past its own `maxT`**. So the shadow ray
hits the light itself — every light, every hit.

Measured in the mirror as exactly that: **100% of the analytic emitter term
lost, on three receivers**, while the geometric emission path read correct
values right beside it. No NaN, no warning, a shadow-ray count that looks
perfectly healthy, and a scene that is simply black.

The fix needs nothing the GPU does not already have — the endpoint is
recoverable from `(point, toLight, maxT)` alone, so `makeVisibility` reconstructs
it and re-measures from the lifted origin. **`createSrcVisibility` in
`srcTrace.js` needs the same three lines** (not made here; that file belongs to
another session's working set as of this write).

The lift's other consequence is now measured rather than assumed: **an occluder
closer to a surface than 0.75 · voxel is stepped over and its contact shadow is
lost**. Swept at voxel 0.2m (lift 0.150m): lit at 0.02 / 0.08 / 0.14, shadowed at
0.16 / 0.20 / 0.35 — the threshold is exactly the lift. That is not an epsilon to
tune down (a smaller one re-acnes at the same voxel scale); it is the medium
showing through, and the value of having the number is that a lost contact
shadow becomes recognizable instead of investigable.

`makeVisibility` **throws without a voxel size**. A caller that does not know its
medium's quantization cannot cast a correct shadow ray, and inventing a default
is how the wrong bias ships.

#### 12.26.4 THE FACE-FORWARD FLIP BELONGS HERE, AND NOT FOR THE REASON §12.17 GAVE

§12.17 concluded that the face-forward flip belongs at the engine boundary
(`readPixel`) and never in a kernel, because a flip on one side of the CPU/GPU
boundary made each side fill the half of the bin sphere the other never read.
**The hit normal is not that normal.** It is produced by the trace inside the
same kernel that consumes it, one line earlier, and a record normal is
sign-aligned to the occupancy gradient — it knows nothing about which side a
particular ray approached from. Unflipped, every hit on the far face of a wall
returns cos < 0 for every light and shades black: half the geometry in a closed
room, dark.

Gated two ways: `faceForward` only ever flips the SIGN (2,000 random pairs), and
a scene whose record normals are all reported the other way round shades
**bit-identically**.

#### 12.26.5 ONE-SAMPLE NEE IS EXACT IN LUMINANCE AND NOT PER CHANNEL

With `p_i ∝ luminance(E_i)`, `E_i/p_i` is the SUM in luminance for whichever i is
drawn: one sample is not an unbiased estimate of the total, it **is** the total,
to 2.28e-16, for every ray index.

It does not hold per channel, and the first version of the arm asserted that it
did (it failed at 7.4×). The reason is a property of every importance-sampled
NEE and it will arrive on the GPU as coloured noise nobody predicted: **the pdf
is one scalar and the signal has three components**, so a draw that is exact in
the ranked quantity redistributes the other two. A red emitter drawn in place of
a blue one of equal luminance returns the right amount of light in the wrong
hue. Measured spread over the same 4,000 draws: **740% per channel, 2.28e-16 in
luminance.** The control that turns the paragraph into a measurement is a
grey-emitter arm, where the per-channel error collapses to 1.14e-16 too.

Consequences worth carrying into the GPU work: compare estimators in the
quantity they estimate (a per-channel standard error reported **1.17×** for a
change actually worth 3.00×), and if chromatic noise ever matters, the fix is to
rank per channel or spend samples — not to blame the tree.

**What a knows-nothing ranking costs: 3.00× the standard error at equal sample
count, i.e. 9× the samples for equal noise.** That is the ceiling on what
`lightTree.js`'s bounds-based descent can lose against the exact factor, and the
reason the reference takes `importance` as a parameter instead of asserting the
exact one.

**`neeSamples` is stratified** (`(s + hash)/S`, one draw per stratum):
1 → 4 samples cuts the standard error **2.61×** where independent draws would
give 2.00×. Asserting only "the mean is still right" would have passed on a loop
that draws the same light S times and divides by S.

#### 12.26.6 THE IMPORTANCE FLOOR IS A DIAGNOSIS, NOT A REPAIR

R1 in its sampling costume: an emitter with a nonzero contribution and a zero
pick probability is energy that vanishes with nothing to attribute it to. The
first version floored the weight at a fixed `1e-12` — which trades a lost light
for a **firefly**, because the estimator divides by the pdf, and "fireflies are
impossible by construction here" is a property this module relies on.

The floor is now `IMPORTANCE_FLOOR_FRACTION` (1/1024) of the **mean importance
among contributors** — scale-invariant, because a light tree's importance is in
units of its own and not comparable to an irradiance. It binds only when an
importance function is wrong, so the exact-pdf case is untouched and the
zero-variance property survives, and `stats.importanceFloored` counts the times
it bound.

Measured on a zero-ranked VISIBLE emitter, 200,000 draws: energy survives
(2.08% off, inside its own 3σ), worst single-sample weight **3577× the mean
against the 4096 = contributors/floorFraction analytic bound**, standard error
**37×** the correct ranking's. So: the floor keeps the energy, bounds the
firefly, and hands back the variance. It does not make a broken ranking usable
— the counter is what says one is broken.

**The first version of that arm zero-ranked an OCCLUDED emitter** and passed
with the floor doing no work at all: an arm whose subject contributes zero
cannot fail.

#### 12.26.7 R5: THE HANDOFF, MEASURED AT 1.45% — AND THE FIRST COMPARISON WAS OF TWO DIFFERENT QUANTITIES

The two representations of one emitter only meet **at a shading point**. The
first version of this arm measured a floor receiver's irradiance with NEE off
(the light arriving *directly* from the emitter) against the same receiver with
NEE on and the emission zeroed (the light arriving *after bouncing off the
walls*) — the direct and indirect terms, which have no reason to be equal. It
read a 100% gap while both halves were correct.

Stated properly, at a point H:

- **analytic** — `refSphereAt`'s closed form (imported from `emitterShapes.js`,
  not re-derived: the horizon-faded factor NEE actually evaluates) × one binary
  visibility ray;
- **geometric** — brute-force MC over H's hemisphere with the emitter as the
  only emissive surface and every albedo zero.

Worst gap over three receivers: **1.45%** (0.17% under the luminaire, 0.29% off
to one side, 1.45% on a wall). That is R5's calibration and it is the number the
GPU's emitter handoff has to reproduce. It is approximate by construction — an
analytic form factor times a single binary visibility cannot resolve a
partially-occluded emitter — and it is the SAME approximation the screen chain's
analytic emitter direct already makes, which is precisely why they can agree.

**The flag, through the whole transport.** SRC feeds indirect only; the pixel's
direct emitter light comes from the screen chain. A ray that lands on a
NEE-sampled emitter and reports its emission delivers that direct light a second
time. Flagged vs unflagged, mean floor irradiance over the whole floor:
**0.666 vs 1.734 — 2.60×.**

**A single gather point could not see it.** The first version read one floor
point and found 1.00×: the ~57 rays that land on the emitter are spread thinly
across the floor's probes, and the sampled point's eight probes happened to hold
none of them. The double count was there the whole time. **An energy claim wants
an energy statistic** — the mean over the floor, not a sample of it.

#### 12.26.8 BOUNCE COLOUR REACHES THE SCREEN, AND A BOUNCE NEEDS SOMETHING TO BOUNCE

The headline arm: a 4m box, one red wall, one green wall, a spherical luminaire,
NEE, flagged. Floor chromaticity —

| where | r | g | b |
|---|---|---|---|
| near the red wall | **0.402** | 0.319 | 0.278 |
| centre | 0.372 | 0.346 | 0.282 |
| near the green wall | 0.333 | **0.389** | 0.278 |

with the R14 control first: **`shadeHit` absent gives the floor exactly zero.**

Against the brute-force arbiter over the same shading, receivers ≥ 2·s₀ from
every wall: **14.4% at s₀=0.4, 11.1% at s₀=0.2** — bounded and non-diverging,
the same discipline (and the same reason) as the unshaded transport arm, with a
×0.55 albedo canary at 52.9%.

Three instrument findings, all of which read as transport failures:

- **A BOUNCE NEEDS SOMETHING TO BOUNCE.** The first version lit the room with an
  emissive CEILING and no analytic light. A wall hit then shades
  `emissive + ρ/π·E` with E = 0 — every wall returns black, the only nonzero
  radiance in the room is the ceiling's own emission, and the floor reads a
  flawless neutral 3.12. That is a correct single bounce of a light that reaches
  surfaces by no path. **Colour bleed is a second transport**: something has to
  light the wall before the wall can tint anything, and in SRC that something is
  the hit shading's own direct term.
- **THE PIXEL GRID HAS TO FOLLOW s₀.** A fixed 0.4m grid feeding a 0.2m lattice
  leaves lattice nodes with no pixel on them, and a query point sitting exactly
  ON such a node puts all eight trilinear weights on corners that do not exist —
  the gather renormalizes over an empty set and returns 0, which the refinement
  sweep read as "halving s₀ made the error 100%". A gbuffer is denser than the
  probe lattice by construction, so the fixture has to be too.
- **A SUN CANNOT BE TESTED INSIDE A CLOSED BOX.** Every shadow ray reported
  occluded — correctly, because a ceiling is between every point and the sun.
  Every sun measurement read zero, which is indistinguishable from a broken
  shadow ray. `makeOpenScene` exists for this now.

The centre-vs-wall chromaticity was also **sampling noise until the ray budget
quadrupled**: at 24 rays/pixel the room's centre read *redder* than the point
beside the red wall. A chromaticity difference of a few points is well inside the
per-probe noise of a sparse field, so a bleed arm needs a budget chosen for the
statistic, not for the runtime.

#### 12.26.9 THE COARSE SECONDARY CACHE BRIGHTENS — AND THAT IS THE LEAK, IN A FEEDBACK LOOP

§4.1 step [J] runs the secondary cache "2 LODs coarser". That needs no parameter:
a coarser cache **is** a frame built at a coarser `spacing0`, handed to the same
`makeSecondaryCache`. What matters is what survives it.

| cache spacing (2m box, s₀ = 0.5) | E_final | contraction rate |
|---|---|---|
| 0.5 (same) | 3.4176 | 0.9000 |
| 1.0 (1 LOD coarser) | 3.4347 | 0.9001 |
| 2.0 (2 LODs coarser) | 3.5539 | 0.9001 |

**R4 survives the coarsening exactly** — the fixed point moves, the rate does
not. But the direction is the opposite of the one I asserted first: I claimed a
coarse cache "costs energy monotonically, never gains any", reasoning that
averaging over a bigger cell can only blur light away. It failed at **+3.99%**.

The cause is a limitation this suite already has an arm for: **the near-geometry
interpolation leak is proportional to PROBE SPACING**, so a 4× coarser cache has
4× the spacing over which its trilinear corners can straddle a wall, and leak is
one-sided BRIGHT. Coarsening [J] does not lose energy — it invents some. That
matters more here than at the primary field because this one is **in a feedback
loop**: a leak that brightens the cache brightens the next bounce that reads it.
R4 is what stops it running away, and the flat 0.9001 column is the evidence.

The other half of the finding: **the coarsening is bounded by SCENE SCALE, not
chosen freely.** A 2m box at 2 LODs coarser has a 2m cache lattice — one probe
for the whole room — so the +3.99% is a property of the ratio (cache spacing /
scene size) and not a verdict on the 4×. On a Sponza-scale scene the same 4× is
a 2m cache in a 30m nave. Pick it against a real scene.

#### 12.26.10 WHAT THE GPU SIDE NEEDS FROM THIS, AND WHAT IS NOT DONE

Handoff list, in the order a Phase-5 GPU unit would want it:

1. **`shadeHit(hitRecord, dir, rayIndex) → vec3`** in `srcDeposit.js` —
   `makeHitShader` is the body, line for line. `rayIndex` is already threaded
   through the kernel (it is `n`), and NEE needs it for exactly the reason the
   synthetic trace does: a pure function of a u32 is bit-identical across the
   boundary where an RNG state is not.
2. **`createSrcVisibility` must re-measure `maxT` from the lifted origin**
   (§12.26.3). Three lines, no new bindings. Without it the analytic emitter
   term is exactly zero and nothing says so.
3. **The emitter flag has to reach the hit.** R5's zeroing needs `surfaceAt` to
   report *which* emitter a hit landed on, which means the voxelize-time surface
   record (and the mover header) carry an emitter id, not just an emissive
   colour. This is the one item that is not a shader change.
4. `MAX_LOOP_ALBEDO` is applied **scaled, not clipped per channel**, and it is
   applied at the hit — inside the loop — never at the `intensity` prop.
5. The face-forward flip is at the HIT, in the kernel (§12.26.4) — which is a
   deliberate exception to §12.17's rule, for a stated reason.

**Not done, and not claimed:** `lightTree.js` is still unwired. The reference
defines the interface NEE needs (`irradianceAt`, `sampleTarget`, a pluggable
`importance`) and prices what a bounds-based ranking can cost (3.00×), but it
does not build or descend a tree — that is GPU-side integration with its own
suite (`run-gi-light-tree-test.mjs`). Neither is the swept per-probe mover
invalidation from §7's Phase-5 list, nor any of that phase's GPU probe gates
(`probe:gi-mover-bounce`, `probe:gi-emissive-cost`, `probe:gi-emitter-cap`,
`run-gi-game-perf-probe`) — those measure a GPU that has no hit shading yet.
This unit is the mirror, and the mirror is green.

### 12.27 Phase 4, unit 4 — the lattice probe. PHASE 4 IS COMPLETE.

§7's last Phase 4 gate item: *"`probe:gi-block-size` ACF (expect block scale to
track s₀·LOD — measure the world period, R14)."*

#### 12.27.1 The old rig could not answer it, so the FINDINGS moved and the code did not

`run-gi-block-size.mjs` sweeps `voxelSize` and `probeSpacing` with `autoFit`
OFF, and all three were retired when GI collapsed to one property (§12.19.5).
§12.10.1's instruction for the retired gather gate applies unchanged — carry the
findings forward, not the file:

- **The metric survives intact.** A piecewise-constant field of block size `b`
  has a triangular ACF, `1 − k/b`, so the half-crossing is at `b/2` and
  `blockSize = 2 × (lag where the ACF crosses one half)`. Detrend with a CUBIC
  first, because a polynomial has no length scale of its own.
- **The sweep axis does not.** The only dial left is `quality`, whose four tiers
  set s₀ to 0.8 / 0.6 / 0.45 / 0.35 m — and that is a BETTER sweep for this
  question than the one it replaces, because it moves the probe lattice and
  nothing else. The old rig's two dials each moved a different lattice and
  telling them apart was the whole point.
- **The `autoFit` trap dies with the props.** It cost the previous attempt at
  this question an entire run of identical builds.

The view is orthographic, straight down at the floor, so "lag → metres" is exact
and constant rather than a projected pixel scale, and a row of texels IS a line
of constant z.

#### 12.27.2 A NULL FROM A NOISY INSTRUMENT IS WORTHLESS, so the probe self-tests

§12.22 already measured the blocks gone, so this expects to find nothing — and
that is exactly the result a broken instrument returns for free. **White noise
decorrelates at lag 1**, which drives the half-width to ~1 texel and reports "no
blocks" whatever the frame contains.

Three things answer it. Frames are AVERAGED (16) before the fit; the surviving
frame-to-frame noise is measured and reported; and the estimator is run against
SYNTHETIC piecewise-constant fields at each tier's own s₀, carrying the same
noise, to prove it finds a period that IS there.

**The control failed three times before it was worth trusting, and each failure
was the control's fault rather than the estimator's:**

1. **Noise at the wrong stage.** The first version added RAW frame-to-frame
   noise to blocks of the same amplitude — SNR 1 — and failed at 95%. The
   measurement averages 16 frames, so the noise it actually carries is smaller
   by sqrt(16), and that is the regime the control has to reproduce.
2. **A weak cell hash.** `((cx·73856093) ^ (cy·19349663)) & 1023` correlates
   strongly between ADJACENT cells, which widens the ACF and makes synthetic
   blocks read BIGGER than they are. The control was measuring its own field's
   defect and billing the estimator for it.
3. **Too few blocks per line.** The residual bias is monotone in
   blocks-per-line and nothing else — 40% at 8.7, 22% at 11.6, 9.6% at 15.6 —
   because a cubic detrend absorbs block-scale variance when the blocks are
   large relative to the line. Blocks per line is `window · WORLD / s₀` and does
   NOT depend on resolution, so a bigger target does not help; a bigger WORLD
   does. At 16 m the coarsest tier gets 14 blocks and the finest 32, while
   768 px keeps the finest s₀ at 8.4 texels. Both ends have to stay resolved,
   which pins the choice to a compromise rather than a maximum.

Settled control: **the estimator recovers synthetic blocks to 7.2–16.2%**, and
the residual error is still monotone in blocks-per-line, which is the signature
that says the remaining bias is the detrend and not something unexplained.

#### 12.27.3 What it measured, and the statistic that actually answers R14

    tier     s0      block x   block z   block/s0
    low     0.80m     1.037m    0.884m   1.30 / 1.10
    medium  0.60m     1.139m    0.826m   1.90 / 1.38
    high    0.45m     1.201m    0.796m   2.67 / 1.77
    ultra   0.35m     1.302m    0.961m   3.72 / 2.75

**"Is the block small" is the wrong test and the first version asked it**, with
`block/s₀ < 0.5`, and failed at 1.67 having proved nothing either way. R14 asks
whether the structure's length SCALES WITH the lattice, and no single ratio can
answer that at any value.

The statistic that does needs no threshold pulled from the air:

    s0 divides by 2.29 from low to ultra.
    The measured length MULTIPLIES by 1.18 (0.96m -> 1.13m).
    Tracking would have predicted 0.42m.

It moves the wrong way. A probe-cell artifact cannot get LARGER as the probe
cells get smaller, so whatever this ~1 m correlation length is, it is not the
lattice. `block/s₀` spreads 3.37× across the sweep; a lattice would hold it
near constant, which is what "tracking" means.

**Left open, and named rather than explained away:** there IS a residual
structure at ~1 m, 17× above the averaged noise floor and independent of s₀. The
scene is a floor and two walls, so it is not geometry. Phase 5 is the right time
to chase it — hit shading changes what a bin CONTAINS, and a correlation length
measured on transmittance alone is measuring half the signal.

#### 12.27.4 Two harness faults, and one that cost a run by looking like a real bug

- **A `global-illumination` COMPONENT builds the system; `engine.start()` runs
  it.** Same pair as §12.25.3 — recorded twice because both probes hit it.
- **`quality` CHANGES THE GI TARGET RESOLUTION** (256² at low/medium/high here,
  512² at ultra), and GISystem rebuilds `_giTargets` when the size changes. A
  `texture(targets.irradiance)` node captured once therefore points at a
  DISPOSED target from the second tier onward — **and a disposed target reads as
  zero**. The ultra arm produced a uniformly black frame and reported a block
  size of 0.000 m, which the ratio arm then divided by.

  It read exactly like SRC being broken at ultra. The counters said otherwise in
  the same breath: **262,144 of 262,144 pixels lit, zero empty, 1.9 M deposits,
  zero dropped.** The frame was fine and the handle was dead. That is why the
  "never lit" path now DIAGNOSES — SRC-refused-to-build, pool-starved and
  gather-found-nothing are three different failures and the counters separate
  them — instead of only failing.
- **The occluders had to be 1.5 m thick.** Auto-fit sizes the occupancy voxel
  from the scene AABB, and GI warns when a mesh is thinner than two cells
  because the field cannot keep its faces apart. A 0.5 m wall tripped that at
  0.30 m voxels, and an occluder that does not occlude leaves the floor
  uniformly lit — at which point this probe is measuring the ACF of a flat
  field, which is noise wearing a result's clothes.

#### 12.27.5 PHASE 4 IS COMPLETE

Mechanism (§12.23), motion (§12.24), scale (§12.25) and the lattice (this
section). §7's Phase 4 gate list is discharged, and the LOD half of the phase
landed earlier at §12.19.2 and in [I].

What Phase 4 did NOT do, by plan rather than omission: **membership**. §12.24
measured the per-frame reversal rate halving while the worst-case per-pixel STEP
did not move, and closed the 2×2 that shows the step floor is bin-level
membership rather than value noise — R6 said an EMA smooths values and not
membership, and it was right. That is not a smaller-alpha problem and it is
deliberately not chased here, because Phase 5 changes what a bin contains.

**Next is Phase 5 — hit shading.** It is the phase that makes the picture stop
being sky visibility: `shadeHit` is still `null`, every deposited radiance is
still zero, and a Cornell box with no red on the white block remains the correct
picture until it lands.

### 12.28 Phase 5, unit 2 — `shadeHit` ON THE GPU. THE MIRROR READS 0.0000%.

**Status:** landed on `feature/gi-src`, three commits — `srcShade.js` (new),
`srcTrace.js`, `srcDeposit.js`, `srcSystem.js`, plus `scripts/gi-src-shade.html`
and its driver. `npm run test:gi-src-shade` is **33 checks, green**, ~40s on a
real WebGPU device. `test:gi-src-ref`, `test:gi-src-deposit` and
`test:gi-src-temporal` all stay green. Static surface attribution is another
session's unit and is NOT here; `__giSrcShade` defaults OFF and requires it.

#### 12.28.1 The headline, and what it is a headline about

`createSrcHitShader` is §12.26's `makeHitShader` line for line, and the two arms
that say so read **0.0000%** — unshadowed and shadowed, at 96 synthetic hits over
three analytic emitters. That number is the whole point of having built the
mirror first: the port had no design decisions left in it, and every arm below
that failed, failed on the INSTRUMENT rather than on the shader.

The gate needs no occupancy field and no engine. Both things it has to check
about a shadow ray are properties of its BUDGET, so `createSrcVisibility` is
handed a fake medium whose `traceOccupancy` reports a hit wherever the fixture
puts one. That also means it never imports the file the parallel unit is editing,
which is why the two sessions could run at once.

#### 12.28.2 ⚠ THE SHADOW BIAS WAS APPLIED TWICE, AND EVERY COMMENT SAID 0.75

§12.26.3's fix (re-measure `maxT` from the lifted origin) went in first and its
arm passes: the shadow ray no longer hits the light it is aiming at. The sweep
NEXT to it is what found the second bug.

`createSrcVisibility` moved the origin 0.75 voxels along the normal **and**
started the march at `t0 = lift` along the ray. Two biases. The lost-contact-
shadow threshold was therefore **1.5 voxels** — double what the mirror measured,
double what this document said, and double what the function's own comment
claimed. Measured at voxel 0.2 m: lit at 0.16 and 0.20, which should both have
been shadowed.

The along-ray term is **not** redundant and does not simply get deleted: 0.75
along a body-diagonal normal is only 0.43 per axis, so a grazing shadow ray from
a lifted origin can still sit inside the surface's own voxel. It stays, as the
SAME quarter-cell self-bias `createSrcSceneTrace` uses — derived from the same
quantity (R2) rather than being a second lift. Threshold is now `0.75 + 0.25 =
1.0` voxel, and `SHADOW_LIFT_CELLS`/`SHADOW_SELF_BIAS_CELLS` are exported so the
gate asserts their SUM. **A threshold written down twice is one that drifts**,
and this one had already drifted before anyone measured it.

#### 12.28.3 A COLOURED ALBEDO BREAKS THE LUMINANCE EXACTNESS. THAT IS THE FORM THAT MATTERS.

§12.26.5 established that one-sample NEE with `p ∝ luminance(E)` returns the
exact sum in luminance, to 2.28e-16. The GPU arm asserting it failed at
**31.17%**, and the shader was right.

The identity is exact in the luminance of the **irradiance**. Reflected radiance
is `ρ ⊙ E`, and a COLOURED ρ re-weights the three channels *before* the luminance
is taken — so §12.26.5's own measured 740% per-channel spread leaks straight into
luminance. Grey albedo: 0.0000%. Coloured: 31.17%.

This is not a technicality about a test fixture. **What reaches the screen is the
reflected radiance**, so the operative statement is: one-sample NEE is exact in
luminance on a grey surface and is not on a coloured one, and every coloured
surface in the scene pays chromatic noise the estimator's error bars do not show.
§12.26.5's rule — compare estimators in the quantity they estimate — is what
makes the arm readable; it is also what makes the SCREEN's error a different
number from the estimator's.

Both forms are now gated: exact on grey, and a third check asserting the coloured
case does NOT collapse to it, so nobody can quietly grey the fixture and lose the
finding.

#### 12.28.4 AN ENERGY CLAIM ABOUT THE FLOOR NEEDS ~1/floorFraction SAMPLES

§12.26.6 measured the importance floor's energy survival at 200,000 draws and
read 2.08%. The GPU gate's first version compared two ONE-sample estimates over
96 hits, read **26.1%** against a 5% bar, and that was not a defect — it was 96
draws of an estimator whose entire subject is excess variance.

The floor is 1/1024 of the mean importance among contributors, so a floored
emitter is drawn about once per `1024 · contributors` samples. Swept rather than
asserted, because the shape IS the finding:

| samples/hit | energy gap | rms per-hit |
|---|---|---|
| 64 | 30.99% | 40.6% |
| 256 | 8.13% | 42.4% |
| 1024 | 3.76% | 39.2% |
| 4096 | 1.30% | 11.7% |
| 16384 | **0.25%** | 3.63% |

So the energy does survive, and **the sample count that can say so is set by the
floor fraction itself**. Below that scale the arm measures its own noise, and a
bar picked without knowing this passes or fails on where the fixture's seed
landed.

The cost, stated in the units a sample budget is actually spent in: **the correct
ranking is exact at ONE sample (9.8e-14); the broken one is still 3.63% per hit
at 16,384.** That is §12.26.6's 37× standard error, re-expressed. The control had
to be rewritten too — the first version compared the correct ranking's values
against themselves, which is 0 by construction; it now compares 1 sample against
16,384, so "exact" is measured rather than restated.

#### 12.28.5 `dot(n, dir) == 0` IS THE ONE INPUT THE FLIP CANNOT ANSWER

The face-forward arm (§12.26.4: reversing every record normal must shade
identically) failed at 100% on hit 0. `faceForward` tests `dot > 0`, so at
exactly grazing incidence **n and −n both return themselves** — the flip is a
no-op on both and the two runs genuinely differ.

Measure zero in a real trace; unmissable in a fixture built from trig on
face-aligned normals, which produces exact zeros. The fixture now asserts its own
minimum `|n·d|`, with a bar set from f32 sign determinacy (1e-4 against a 1.2e-7
epsilon) rather than from steep incidence, because the requirement is that the
SIGN is decidable and nothing more.

#### 12.28.6 `STAT_EMIT_ZEROED` IS REDEFINED RATHER THAN FED — AND ZERO IS THE HEALTHY READING

The parallel unit raised this and was right about the symptom: with the counter
as §12.26 specified it, it would read 0 forever and the 2.60× arm would pass
while measuring nothing. The proposed remedy — ship unzeroed emissive in the
attribution palette so the shader has something to withhold — is **vetoed**, and
the reason generalises.

R5's zeroing already happens at bake time. `GISystem#slotSurface` and
`dynamicObjects`' `writeSurface` both publish a promoted emitter's emissive as
zero, and that guard is itself the fix for this exact double count:
`writeSurface`'s own comment records that it once published raw material emissive
unconditionally, so a mesh that was both promoted AND traced delivered its light
twice. **The promotion set IS the NEE set**, so the bake zeroes exactly what the
sampler will deliver.

Unzeroing to feed a counter would put R5 in a third implementation and give one
fact two sources of truth — the crossed-numbering shape §12.9 warns every
successor about, and an instrument dictating a design.

So the shader keeps its zeroing branch and the counter changes meaning: it now
counts hits that landed on a NEE-flagged emitter **and still carried emission**,
i.e. surfaces the bake missed. Nonzero is a promotion-bookkeeping bug, caught
before it reaches the image as light delivered twice. The handoff's real gate
stays an ENERGY arm (§12.26.7's analytic-on vs analytic-off, mean over a region),
which measures the same property under either design — and which this gate runs
on the mirror at 1.176× on its own fixture.

#### 12.28.7 What is wired, and what is deliberately not

`createSrcProbeSystem` takes `lighting` and `staticSurfaceAt`, and builds the
shader only when `__giSrcShade` is on and BOTH are supplied. Two arguments and
not one switch, because shading with `lighting` alone would light the entire
static world at one default albedo — plausible, wrong everywhere, and read as a
shader bug rather than a missing input. `wantDynObj` now follows `shadeEnabled`
rather than being pinned false; the packed mover id costs the marcher its
dynamic-object bookkeeping per ray and the hit shader is its only reader.

Provenance lives in `srcSystem`'s `surfaceAt` and nowhere else. `srcShade.js`
never asks whether a hit moved (§12.26.1), and a mover wants no emitter flag for
the §12.28.6 reason.

**Not done, and not claimed:** static surface attribution (the parallel unit),
the secondary cache [J] — so this is a single bounce and R4's ceiling has no loop
to bound yet, though it applies at the hit either way — `lightTree.js`'s ranking,
the swept per-probe mover invalidation, and every GPU probe gate in §7's Phase 5
list. `__giSrcNeeSamples` is the A/B for the sample count; the tiers have no
measurement to set it from and deliberately do not carry one.

### 12.29 Phase 5, unit 3 — STATIC SURFACE ATTRIBUTION. §12.26.10 ITEM 3, THE ONE THAT IS NOT A SHADER CHANGE.

**Status:** landed on `feature/gi-src` — `srcSurface.js` (new),
`occupancyField.js`, `slotRegistry.js`, plus `scripts/gi-src-surface.html` and
its driver. `npm run test:gi-src-surface` is **30 checks, green three runs
running**, ~35 s on a real WebGPU device. `test:gi-src-ref`,
`test:gi-src-deposit`, `test:gi-src-shade`, `test:gi-src-merge`,
`test:gi-src-tiles`, all seven `test:gi-rayhit-*`, `test:gi-dynobj` and
`smoke:gi-gpu` (both default arms plus `?src=1&sky=1`) all stay green.

This is the half §12.28 named as absent: `srcShade.js`'s `surfaceAt` had no
static answer, so every static hit shaded at `defaultAlbedo` with no emission.

#### 12.29.1 The premise, confirmed before anything was designed

All three legs of it held:

- `occupancyField.js` had no `surfaceAt` — the coarse attribution grid
  (`cellAttr`/`staticAttr`/`slotAtlas`) went with the field in §12.9, and its
  epitaph is still in the file at the declaration site;
- `SURFACE_MATERIAL_ID_WORD` (word 2 of the 4-word surface record) is genuinely
  taken — `packComplexRange` writes it at `RayHitPacking.js:1053` and `:1346` and
  both traces read it back;
- and **the two slot numberings §12.9's crossed-numbering bug came from are
  still live**. `GISystem#occupancyContentOf` hands out occupancy slots from a
  stable monotonic map (`:6270`); `SlotRegistry.allocateSlot` pops a free stack
  (`slotRegistry.js:98`). They are different numbers for the same mesh today.

#### 12.29.2 KEYED ON THE SURFACE RECORD — the 100 MB objection answered by moving the key

§12.9 rejected per-level-0 attribution at 12.6M voxels × 8 B = 100 MB and
settled for a COARSE cell, accepting that a 0.5 m cell shared by a column and a
floor gets one colour. That trade does not have to be made. Surface RECORDS
already exist per OCCUPIED level-0 voxel — `surfaceCapacity` is
`level0VoxelCount / 12` precisely because surfaces are ~2D — so **one u32 per
record is level-0 precision at surface-manifold cost**, and it is also the
resolution the intersection was computed at, which is R2 applied to attribution
rather than to a bias.

Measured on the gate's field (128×64×128, 92,844 records): attribution
**0.71 MB of the occupancy allocation's 6.45 MB, 11.0%**. Arithmetic projection
to Sponza-ultra (432×192×272 ⇒ 1,945,600 records): **14.84 MB** — the persistent
stamp, its build scratch, and a 512-entry palette. Against 100 MB, and against
the 121 MB that same pool already spends on records + fit scratch.

#### 12.29.3 IT COSTS ZERO BINDINGS, AND THAT IS THE POINT RATHER THAN A BONUS

Both the stamp and the palette are tail regions of the `bits` allocation, the
pattern that file already uses for macro cells, records, the triangle pool,
density, dynamic objects and the static BVH. A consumer that already traces
reads them through a binding it already holds: **zero new storage buffers and
zero new uniform buffers on the deposit kernel** (R7).

That is not tidiness, and §12.9 says why: the last attribution grid had its slot
remap applied *in the voxelizer rather than read in the consumer* **because that
kernel had already reached the user GPU's 12-uniform-buffer per-stage limit**. A
design that needs a binding here does not get to be correct later.

The palette cannot be a CPU-written buffer for the same reason it cannot be its
own binding: it has to live in `bits`, and `bits` is GPU-written every chain, so
a CPU upload would clobber the pyramid. It is a `uniformArray` landed by a
512-thread compute — one binding, in a pass nowhere near any wall.

#### 12.29.4 THE TWO BUGS §12.9 PAID FOR, AND THE ARM THAT PASSES BY FAILING

**Crossed numbering — deleted, not remapped.** The stamp is the OCCUPANCY slot
(`pairSlot`, the number the voxelizer already holds when it sets a bit) and the
palette is indexed by that same number, built from `field.placements`. The
registry is reached by KEY — `slotKeyOf(mesh, instanceId)` — never by index. One
numbering on the GPU, nothing left to get backwards.

Asserting that needed the failure to be reproducible, so the gate seats the two
boxes as an exact PERMUTATION (occupancy A=0 B=1, registry A=1 B=0) and
`crossNumbering: true` writes the palette under the registry's index. Result, and
this is the arm that proves the one above it can see anything at all:
**1366/1366 clear-of-seam rays went wrong, and 1366/1366 read the OTHER mesh's
albedo** — the bug, exactly, not merely an absence.

**The deterministic winner — `atomicMax` on the stamp.** A level-0 voxel shared
by several meshes picks the highest occupancy slot every dispatch, whatever order
the threads arrive in. Measured: **0 of 6144 ray comparisons differ over four
re-voxelizes.**

#### 12.29.5 ⚠ THE DETERMINISM ARM FAILED FOR THE HARNESS'S REASON, AND READ 44,106

Its first version compared the attribution buffer word-for-word across
re-voxelizes and reported **44,106 of 262,146 words differing** on a stamp that
was in fact perfectly deterministic.

`surfAllocCompute` claims each brick's record offset with a racing `atomicAdd`,
so **RECORD INDICES PERMUTE EVERY DISPATCH BY DESIGN.** A buffer whose addressing
is order-dependent cannot be diffed by address. What has to be stable is the
attribution AT A VOXEL — which is also the only thing a consumer can observe — so
the arm re-probes the same rays instead and compares the slot each one reports.

The lesson is the reverse of the usual one: "byte-identical" is the standard
proof in this module, and here it was the wrong instrument because the address
space is not stable. **Diff what the consumer sees, not where the answer lives.**

#### 12.29.6 ⚠ AND ITS VACUITY GUARD IS THE HARD PART, NOT THE ASSERTION

Determinism only means something where two meshes actually CONTEST a level-0
voxel. With no shared voxel the stamp is a constant and four identical readbacks
prove nothing — this is §12.27.2's "a null from a noisy instrument is free",
wearing a different costume. Overlapping the boxes by 1.5 voxels is not enough
either: the conservative SAT decides whether a voxel is contested, not the
arithmetic in the fixture.

So it is MEASURED. Swap the two occupancy slot NUMBERS and re-probe: a ray on
uncontested geometry follows its mesh and its reported slot flips, while a ray on
a contested voxel reports the SAME number both times, because `atomicMax` picks
the higher id and that id now belongs to the other box. **335 rays keep their
slot, 1713 follow their mesh, 0 lose attribution.** The 335 are the contested
set, and the arm is sharper than a rerun as well: a non-atomic winner would put
uncontested rays in the count too.

#### 12.29.7 ⚠ `a.mix(b, t)` IS NOT `mix(a, b, t)` IN THIS TSL — AND IT LOOKS LIKE A PARTIAL FAILURE

The unattributed fallback was written `vec3(fallback).mix(p.albedo, valid)`.
Every clear ray came back wrong, and the wrongness was *plausible*: box A's
`[0.820, 0.110, 0.090]` read `[0.893, 0.451, 0.408]`, box B's
`[0.100, 0.740, 0.160]` read `[0.466, 0.840, 0.454]` — every surface washed
toward the fallback grey, which reads as "the attribution is partly missing"
rather than as an operator bug.

Solving it componentwise settles what was emitted: `fallback·(1−albedo) +
valid·albedo`, i.e. **`mix(a, t, b)` — the method's two arguments consumed in the
wrong roles**, with the ALBEDO as the interpolant and `valid` as the far
endpoint. It reproduces to three decimals on both boxes. `select` is used
instead, and `valid` is exactly 0 or 1 here so there was never anything to
interpolate.

**WHAT FOUND IT WAS THE INSTRUMENT, NOT THE READING** — §12.17.4's rule, and it
took one run instead of a session. Three things can be wrong here and they are
indistinguishable from a shaded ray: the CPU palette, the upload into `bits`, and
the lookup. The gate now separates all three permanently (a CPU-side palette
readback plus per-ray `stamp` / `slot` / palette `base` / pre-mix albedo debug
lanes), and the answer came back unambiguous: stamp 1 and 2, slots 0 and 1, base
637500 and 637508 *exactly* as predicted, pre-mix albedo *exactly* A's and B's —
so everything except the blend was already right.

One footnote worth keeping, because it briefly looked like a second bug: the raw
palette word read back as **1062333312 against an expected 1062333317**. That is
the diagnostic lane itself — a u32 above 2^24 rounds on its way into an f32, so a
bit pattern cannot be carried in a float channel. The lane is fine for "is the
address right"; it is not fine for equality.

#### 12.29.8 THE FACE RETRY, AND WHY THE PASSTHROUGH IS NOT ONE LINE

`createSrcSceneTrace` hands over `voxel` rather than letting a consumer re-derive
it, because `position` is lifted and floors to the SHELL cell. That fixes the
lift, not the face: `voxelAtHit` is `floor(q0 + dq·t)`, and a hit landing exactly
ON a cell face floors either side of it.

The marcher's own record index would settle it, and the parallel session offered
the passthrough. **It is not a one-line change:** `traceHybridPlane`'s inner
`sharedFn` returns a `vec4` with all four components spoken for (hit, t, oct.x,
oct.y), so surfacing the record is a return-type change to the most-measured code
in the module. Declined, and instrumented instead — R13, rather than surgery on
the strength of a predicted precision problem.

So `surfaceAt` asks at `voxel` first and, when that has no stamp, once more a
quarter voxel along −n (R2, the same fraction of the medium the trace's own
self-bias uses), which is inside the surface cell whichever side the floor fell.

**Measured: 0 retries in 2048 real hits.** The hazard did not occur in this
scene at all. Which makes the retry an untested branch reporting a healthy zero —
the vacuous-arm shape — so the gate checks that it EXECUTES: an unstamped
empty-space query has no stamp, and **16 of 64 of them cross a cell boundary
(25.0%, which is the geometry for a point dropped anywhere inside a cell** — a
real hit lies ON a face, so its step always crosses).

#### 12.29.9 R5: THE FLAG SHIPS, THE ZEROING DOES NOT MOVE

This unit raised the `STAT_EMIT_ZEROED` problem and §12.28.6 vetoed the remedy;
the veto is right and it simplified this side. The palette carries
`#slotSurface`'s output VERBATIM — already zeroed for a promoted entry — so there
is no second implementation of R5 here and no third source of truth. `emitter` is
the NEE index, and it is a flag the consumer can assert against rather than a
mechanism it depends on. Round-trip: **666/666 hits on the seated emitter report
emitter 0, 0 false flags on the non-emitter, 0 emissive hits on the NEE light.**

What the veto leaves is a failure mode **no GPU counter can see**, precisely
because nothing carries emission to notice it: a surface whose material emits,
whose published emissive is zero, and whose emitter id is −1 — light deleted from
BOTH paths. `stats.emissiveOrphans` checks it on the CPU. The gate seats a third
box that emits and is unclaimed (**orphans = 1**) and then claims it
(**orphans = 0, emitters = 2**) — the control that proves the counter tracks the
claim rather than the geometry.

The ENERGY arm stays where §12.28.6 put it. A mean over a region needs the
deposit and the gather; what this gate owns is the input to it being right.

#### 12.29.10 A RECOLOUR NO LONGER RE-VOXELIZES ANYTHING

The deleted grid held COLOURS per cell, so the only way to change one was to
re-run the voxelizer that wrote it. Here the stamp is a slot id and colour lives
in the palette, so `SlotRegistry` grew a separate `surfaceRevision`:
`setSlotSurface` bumps only that, and `revision` — the signal `GISystem#tick`'s
field-refresh branch triggers on — no longer moves for a colour. Nothing else was
reading `revision` for colour (the composite that did is gone, `bvhScene.js`
keeps its own per-mesh table, `writeSurface` runs off its own material stamp).

Gated end to end: after a `setSlotSurface` that changes a colour, `revision`
4 → 4, `geometryRevision` 1 → 1, `isDirty` false, the attribution region **0
words changed**, and **700/700 rays read the new albedo**. So the claim is not
"it skips work" but "the new colour reaches the GPU without any of it".

#### 12.29.11 The numbers, and what is logged rather than chased

Gate: 2048 rays, 2048 hits, **1366 clear-of-seam all correct, 0 unattributed**,
682 seam rays measured and deliberately not asserted (which of two overlapping
boxes owns a shared voxel is a choice, not a fact). 21,984 of 92,844 static
records stamped. Fallback albedo `[0.407, 0.383, 0.350]` = the scene's own mean,
matched to 1e-5. Empty space: 0/64 claim valid, 0/64 come back black, 0 claim an
emitter. `smoke:gi-gpu?src=1&sky=1` unchanged at **56.32 MB**, storage 8.

**Two RED gates are PRE-EXISTING, verified by running and not assumed** (§12.7.6
discipline): `test:gi-occupancy` fails "composite clamps from a level at least as
coarse as its cell" — it reads `volume.coarseLevel`, a property of the composite
§12.9 deleted, i.e. §12.14.2's "an assertion written against a backend outlives
the backend" again — and `test:gi-spawn` fails "field never quiesced after boot".
Both fail IDENTICALLY in a clean worktree at `5cc52c8` with its own dev server.

Logged, not chased (R16):

1. **The mover half of the emitter id is deliberately absent** and §12.28.6 is
   why: a mover wants no flag, because the bake already zeroed it and the
   promotion set is the NEE set. Nothing to do unless that ruling changes.
2. **`_occSlotNext` is monotonic and never reused**, so a long session of spawns
   and despawns can hand out an occupancy slot past the 512-entry palette. It
   lands as UNATTRIBUTED and counted (`stats.slotOverflow`), which is the correct
   direction for an aliasing failure — another mesh's colour would be worse than
   the scene mean — but the ceiling is real and it is the same slot-ID exhaustion
   that forced a mid-game full rebuild in the gi-module session-38 work.
3. **`enableSurfaceAttribution` is opt-in and nothing passes it yet.** The field
   allocates zero words and emits no extra WGSL when it is off, so the old
   backend pays nothing; wiring it is one option on `GISystem`'s
   `createOccupancyField` call plus `srcSystem` constructing the module — the
   parallel session's side of the seam.

---

### 12.30 THE EYE CHECK, ON PIXELS — AND THE FOOTGUN IT FOUND

2026-08-11. `npm run eyecheck:gi-src` (`scripts/run-gi-src-eyecheck.mjs`), the
user's own project and scene, the verified nave pose, `viewport.screenshot` at
700×460, four arms differing by one flag each.

| arm | screen mean | lit (L>12) | `maxL` | vs sky-only |
| --- | --- | --- | --- | --- |
| `shade-off` — SRC probes, sky-only radiance | 0.02891 | **4.0%** | — | — |
| `bias-0.25` | 0.14806 | 68.2% | 0.4387 | **5.12×** |
| `bias-0.75` | 0.14769 | 68.2% | 0.7891 | **5.11×** |
| `noshadow` — visibility dropped, the ceiling | 0.59304 | 97.1% | 0.5644 | 20.5× |

Phase 5's hit shading works and is worth 5.1× the sky-only frame. Shadows take it
to 0.249× of the unshadowed ceiling, which is what an interior arcade should cost.

#### 12.30.1 ⚠ `__giSrcProbes` WITHOUT `__giSrcShade` RENDERS A BLACK SCENE

Look at the first row again: **4% of pixels lit**. That is not "dimmer". The
`shade-off` capture is black but for the sliver of sky through the opening, and
it is the exact picture the user reported as "no GI after enabling flags".

It is structural, not a bug in either half. `createGiResolve` takes the SRC
screen gather as the PRIMARY diffuse term and the legacy closure is switched off
against it — `if (gather && !screenGather)` in giScreen.js, deliberately, because
since [I] both are the same integral and running both adds a pixel's irradiance
to itself. So `__giSrcProbes = true` REPLACES the working diffuse term with SRC's,
and until Phase 5 SRC's carried sky only. One flag on, one flag off is a state in
which the renderer is working perfectly and the screen is black.

Two flags where one of the four combinations is guaranteed-black is a footgun,
and it cost this session most of a day: the black frame was read as a transport
failure and chased through `maxL`, step budgets, attribution and the shadow bias,
none of which were broken. **`srcShadeEnabled()` now follows `srcProbesEnabled()`**
— shading is on whenever probes are, and `__giSrcShade = false` is the explicit
opt-out that keeps the sky-only arm available for the gates that need it. The
combination that renders black is now one nobody reaches by accident.

#### 12.30.2 ⚠ §12.28.2's "THE BIAS WAS APPLIED TWICE" WAS A MISREADING. RETRACTED.

`bias-0.25` and `bias-0.75` differ by 0.25% of screen mean — **noise**. The
along-ray self-bias does not measurably affect the rendered frame at either
value, and the session's confident "my change to the along-ray `tMin` broke every
shadow ray, confirmed and reproduced" was wrong.

What produced that false confirmation is worth more than the fix:

1. **The instrument had no camera.** The predecessor harness never called
   `viewport.setCamera`, so it measured whatever pose the editor booted with —
   58,653 shaded hits against this file's 249,860. Its `maxL` readings across
   runs (0.0000, 0.0485, 0.0877, 0.3037) were not a bias sweep. They were four
   different views.
2. **`maxL` is an extremum, and extrema are the noisiest thing to A/B.** It is a
   fine "is anything alive" tripwire — that is why §12.28 added it — and a bad
   difference detector. Note the table: `noshadow` has a LOWER `maxL` than
   `bias-0.75` while being 4× brighter on screen. Nothing is wrong with either
   number; one hit's maximum simply does not order two frames.
3. **A model disagreed and I believed the machine.** `scratchpad/biasderive.mjs`,
   400k samples: a 0.75-cell lift leaves the origin inside its own cell for 19.9%
   of hits, and a 0.25-cell along-ray bias clears 51.7% of those — so ~9.6% of
   hits are spuriously self-shadowed, a RAMP. The observation was a CLIFF
   (`maxL` exactly 0). A ramp-vs-cliff disagreement is not a detail to reconcile
   later; it means one of the two is measuring something else, and here it was
   the machine. R13 says no fix on code-reading evidence. This is its complement:
   **no fix on measurement that contradicts a derivation, until the contradiction
   is resolved.**

The constant stays at the quarter cell `createSrcSceneTrace` uses — derived from
one quantity rather than written down twice — and the `__giSrcSelfBias` A/B hatch
is removed now that it has answered. The lost-contact-shadow threshold really is
`0.75 + 0.25 = 1.0` voxel, and the gate still asserts the SUM of the two exported
constants rather than a literal.

#### 12.30.3 What the gates could not have caught, and what fixes that

`test:gi-src-shade` hands `createSrcVisibility` a FAKE occupancy field in which
"inside the surface's own voxel" does not exist. It measured the budget
arithmetic — correctly — and was structurally incapable of seeing a self-bias
problem. Same shape as §12.29's seam: **both units pass; the thing between them
is untested.** The eye check is now that missing arm, and it is cheap: four boots,
one screenshot each, one number per arm that a person can also just look at.

#### 12.30.4 ⚠ ARMS THAT RENDER DIFFERENT GBUFFER COVERAGE ARE NOT COMPARABLE

The eye check's own instrument fault, found by the eye check, and it produced two
more wrong conclusions before it was caught.

The editor sometimes builds a gbuffer with **78,988** valid pixels and sometimes
**124,930**. At 2 rays/px that is exactly the 157,976-vs-249,860 split in the hit
count, and it moves the frame mean by ~30%.

**The cause is NOT pinned down and this section twice said it was.** First
diagnosis: "arm 1 has not converged" — refuted, the convergence poll settles at
157,976 and stays there. Second: "the first page in a fresh browser builds a
different system" — refuted by the next run, which read 78,988 on *all six* arms
where its predecessor had read 78,988 on arms 1–2 and 124,930 from arm 3 on.
Viewport/canvas layout settling is the leading suspect and it is a suspect.

The confound is perfect whenever the arm you put first is also the arm whose
configuration you are questioning, and twice it was:

1. `probes-only` ran first and read 0.773× of `shade-on` — written up as "the
   footgun fix leaves a residual gap". It does not; in a fair position the two
   agree.
2. `runtime` ran alone (so, first) and read 0.06059 against 0.14721 — written up
   as "setting the flags in the console and toggling the component is NOT
   equivalent to a reload, and the toggle/reload gap is a real defect". **It is
   not a defect.** Re-run in position 5 the same path reads 0.14759, i.e. equal
   to a reload. Retracted.

Both survived a first pass because each had a plausible mechanism ready to
explain it — a half-engaged rebuild, a stale resolve. **A mechanism you can tell
a story about is not evidence**; the arm that settles it is the same
configuration in a different position, and it costs one boot.

**The fix does not depend on knowing the cause, which is the point.** The harness
records each arm's gbuffer pixel count and the verdict is WITHHELD — non-zero
exit, ratios not printed — when two arms disagree. A caveat would not have
helped: a 30% difference reads as an effect, and both wrong conclusions were
drawn from numbers that looked entirely reasonable. Also kept, as cheap
insurance rather than as the defence: a discarded warm-up boot, and capture on a
settled hit count instead of a fixed timer.

Open follow-ups this run surfaced, none of them today's job:
- `occupancyField.traceHybridPlane` already has an `excludePoint` mode that skips
  any accept whose plane CONTAINS the receiving point — written for exactly the
  self-shadow-staircase problem. It is gated behind the penumbra variant, so
  `createSrcVisibility` cannot reach it. **Excluding the receiver's own plane is
  the principled replacement for a fat along-ray bias**, and it would let the
  threshold shrink toward the quantization instead of away from it.
- `count.shadowRays(1)` fires whether or not `visibility` exists, so the
  `noshadow` arm reports 249,860 shadow rays it never cast. Fixed; an instrument
  that reports work it did not do is the same defect class as the eye check that
  printed `NO SCREENSHOT` for two sessions.
- A black diamond-shaped object sits unlit in every shaded arm, and 1.5% of hits
  land UNATTRIBUTED. Both are small, both are real, and neither is the footgun.

---

## 13. Startup budget — GI must initialize in ≤ 1 second

Added 2026-08-10 at the user's request, mid-Phase-5. A REQUIREMENT, not a
nice-to-have: a GI system that takes a minute to appear is one the user cannot
iterate against.

**§13.2–§13.4 were rewritten the same day, after `probe:gi-boot` contradicted
them.** The first version was written from the engine's own aggregate log lines
and got the headline number, the ranked levers and the cold/warm verdict wrong.
§13.8 records how, because the way it was wrong is reusable.

### 13.1 The definition, because "initialized" has three candidates

**The budget is on TIME-TO-FIRST-CORRECT-FRAME**: from the start of GI's
initialization burst to the first frame in which GI's own light is on screen and
is the right light. Not to a *converged* image — a temporally-accumulated system
is still resolving noise for tens of frames after that, and holding the frame
back until it is quiet would be worse for the person watching. Convergence is a
separate curve with a separate number (§12.24).

It says the boot-ambient hemisphere (`bootAmbient.js`) is a *bridge over a
compile*, not a substitute for one — and that a build meeting R18 has no use for
it at all.

### 13.2 THE MEASUREMENT — `probe:gi-boot`, user's Sponza, 262k tris

Two consecutive warm runs in one invocation (so nothing outside them could
change), plus the cold arm. Reproducible to within 8%:

| | cold | warm #1 | warm #2 |
|---|---|---|---|
| **time to first correct frame** | 54,451 ms | **59,329 ms** | **54,943 ms** |
| slowest single pipeline | 27,339 ms | 31,007 ms | 28,287 ms |
| GI CPU work (voxelize + BVH + setup) | 1,783 ms | ~2,000 ms | ~1,900 ms |
| span first-creation → last-completion | — | 60,204 ms | 55,789 ms |
| …of which SOME pipeline was busy | — | **83%** | **83%** |
| …idle between compiles | — | 17% | 17% |

Per-stage, from the engine's own lines: voxelize **41 ms**, static shadow BVH
**807 ms**, GI setup **885 ms**. 29 compute pipelines and ~40 render pipelines.

**The CPU side is 3.4% of startup and already fits the budget with room to
spare.** Do not go optimizing voxelization, the BVH, slot fitting or probe
allocation — voxelizing a quarter-million triangles costs 41 milliseconds.

**The wall clock is inside pipeline creation: 83% busy, 17% idle.** That kills
the "it is really TSL node-graph generation in JS between compiles" hypothesis
the timeline instrument was built to test. It is shader compilation.

### 13.3 ⚠ THE PER-PIPELINE NUMBER IS LATENCY, NOT COMPILE TIME — THE DRIVER SERIALIZES

The single most misleading thing in this data, and the reason "which kernel costs
the 40 seconds" has no answer as asked.

Eight 16 kB kernels came back at **5,295 / 6,111 / 9,082 / 13,620 / 17,336 /
20,323 / 24,600 / 29,897 ms** — an arithmetic ladder in ~4 s steps. That is not
eight kernels of differing difficulty; it is one queue. Every pipeline's measured
`ms` is *request-to-completion*, so it includes waiting for the ones ahead of it.

Consequences that change what a fix looks like:

- **"The slowest pipeline" is mostly the one that queued last.** In warm #2 it is
  a **16 kB kernel with 1 loop and 18 ifs** at 28,287 ms. Nothing that small
  compiles for 28 seconds on its own merit.
- **Async concurrency buys no wall clock.** `installAsyncComputePipelines` keeps
  frames flowing — which is real and worth having — but it does not shorten
  startup, because the driver compiles them one at a time anyway.
- **The lever is TOTAL COMPILE WORK, which for a serialized queue means PIPELINE
  COUNT × average cost.** ~70 pipelines over a ~50 s busy window is ~0.7 s each.
  Halving the count halves startup; making one kernel smaller does almost
  nothing.

### 13.4 ⚠ WGSL SIZE DOES NOT PREDICT COMPILE COST — SO "KERNEL BREADTH" WAS THE WRONG LEVER

The first version of this section ranked "kernel breadth" second and reasoned
that a 73 kB kernel must be the problem because it was the biggest. Measured, in
the same run, same device:

| kernel | size | time |
|---|---|---|
| the "slowest" | 16 kB | 28,287 ms |
| the biggest | 154 kB | **366 ms** |

**85× faster at 9.4× the size.** Whatever costs the time, it is not code volume,
and a kernel diet aimed at byte count would have been effort spent in the wrong
place. (Part of that gap is queueing per §13.3 — but a 154 kB kernel finishing in
366 ms while a 16 kB one takes 28 s cannot be explained by size under any
apportionment.)

### 13.5 THE CACHE: IT WORKED ONCE, SPECTACULARLY, AND WILL NOT DO IT AGAIN

§13.4's first version made cold-vs-warm item 1, on the reasoning that everything
else was conditional on it. That was right, and the answer is genuinely strange.

- Reproducibly, **warm ≈ cold**: 54,451 ms vs 54,943 ms, and two back-to-back
  warm runs agree. On that evidence the cache does nothing.
- But **one run compiled the whole set warm**: slowest pipeline **474 ms**, all
  70 summed to 7.8 s — against 43,876 ms for the same kernel a run earlier. That
  is a ~90× cache hit, so the mechanism plainly exists and works.

So the finding is not "the cache does not help" but **"the cache does not
reliably engage"**, which is a lever in its own right and an open question:
Chrome may flush its GPU disk cache only on clean shutdown (puppeteer's
`browser.close()` may not qualify), or it may be size-capped and thrashing on a
~180 kB working set. Worth answering, because a reliably warm cache is the
difference between 55 s and ~8 s without touching a single kernel.

### 13.6 The levers, re-ranked from the measurement

1. **PIPELINE COUNT.** §13.3: a serialized queue makes total work ≈ count ×
   average. 29 compute pipelines is the number to attack, and SRC is
   structurally better placed than the dense backend here — §12.9/§12.10 already
   deleted the dense transport and the SDF, and Phase 7 collapses the rayHit
   ladder. **This is the measurement Phase 7 owes.**
2. **MAKE THE CACHE ENGAGE RELIABLY** (§13.5). Potentially ~7× for zero
   algorithmic change, and it is a question, not yet a fix.
3. **Compile only what frame 1 needs.** The wave prewarms every kernel before
   resuming. A staged ramp trades a partial first frame for latency — a startup
   RAMP, not a per-frame flip, so R1 permits it, but it must degrade continuously
   (a missing kernel means a dimmer frame, never a black or popping one).
4. **The 603–701 ms resume recompile** the log has been flagging as unfixed
   (*"pipelines recompiled at resume… report this"*). It is 60–70% of the budget
   on its own once the rest is fixed, so it matters last and blocks last.
5. **Permutations** — anything compiled per quality tier, material bucket or
   ray-hit mode multiplies the count that item 1 is about.

**Explicitly NOT levers, measured:** the CPU work (3.4%), WGSL byte count
(§13.4), and async concurrency (§13.3).

### 13.7 Where this lands in the phase plan

R18 is a cross-cutting gate, not a phase:

- **Phase 5 (now):** `probe:gi-boot` exists and the baseline is recorded. No fix
  yet — item 1's answer is mostly a Phase 7 outcome, and fixing before the sweep
  would be optimizing code that is about to be deleted.
- **Phase 6:** startup is a sign-off metric beside falloff, flicker and game
  perf. A backend that renders identically but takes 55 s to appear does not ship
  as the default.
- **Phase 7:** re-measure. The sweep is where pipeline count actually falls.

### 13.8 ⚠ WHAT THE FIRST VERSION OF THIS SECTION GOT WRONG, AND HOW

Written from the engine's own aggregate log lines, published, and then
contradicted by the probe built to confirm it. Four errors, all of one kind:

- **"~98% of startup is the WGSL compiler."** Came from `[gi] compile wave:
  computes 86880ms` — a log that measures the whole compute phase, not pipeline
  creation. Directionally survivable (83% of the span is pipeline-busy) but the
  number was not measured, and R18's rule text quoted it as if it were.
- **"5 kernels, 183 kB."** `[gi] compute kernels` counts only `state.queue`.
  There are **29** compute pipelines. 24 were invisible to the instrument that
  the conclusion was drawn from — which is why a "3-pipeline" wave took 86 s.
- **"Kernel breadth is lever 2."** Refuted by §13.4: size does not predict cost.
- **"Cold vs warm: 1.0×, the cache is not the lever."** An artifact of the
  harness: the parallel session was landing `occupancyField.js` edits *during*
  those runs, so the WGSL changed between them and every "warm" arm was cold.
  R15 says never edit `src/modules/gi` while a harness runs; it applies to the
  OTHER session's edits too, which is a rule this project had not needed before
  two sessions shared a branch.

And three bugs in the probe itself, each of which produced a confident wrong
number before it was caught — recorded in `run-gi-boot-probe.mjs`'s header: the
sum of concurrent async compiles reported as a cost (149% of TTFF), a `t0`
anchored on the first `[gi]` line of the whole session (which made TTFF read 50 s
on a run where every pipeline finished in 550 ms), and a `\b` that survived three
layers of quoting as a literal backspace byte.

**The transferable lesson is the one §12.26 keeps re-teaching:** an aggregate
number that names a stage is not a measurement of that stage, and the instrument
that would have said so is usually one level finer than the one already in the
log.

### 13.9 THE 44 PIPELINES NOBODY WAS WAITING FOR

**User report, 2026-08-11: "the GI appears after like 3-4 minutes of wait, and
performs at 3 fps on ultra."** §13's budget said 55 s. The gap is not drift — it
is a set of pipelines that the startup instrument cannot see, and the mechanism
is fully determined by code that was read, not guessed.

`installAsyncComputePipelines` makes every GI compute pipeline creation async
and non-blocking, and a dispatch whose pipeline has not landed is **SKIPPED**
(`backend.compute`, GISystem.js — `if (!data.pipeline) … return`). That is the
right design: frames keep flowing while the driver compiles. It also means a
pipeline nobody awaits is invisible *and* its pass silently does nothing.

The prewarm loop awaits exactly one list:

```js
const computeNodes = [...state.queue];        // GISystem.js:1909
```

`state.queue` is assembled at GISystem.js:4110–4327 and contains **only the
screen chain** — resolve, the four light-shadow passes, the emitter chain.
`profile.giPasses` confirms it from the running editor: `queueMs` has **5**
entries. SRC's passes are not in it. They are dispatched directly:

```js
giCompute(renderer, state.screen.srcProbes.passes);   // GISystem.js:1363
```

and `profile.giPasses` counts them separately: **`dispatches: 44`**.

So on the user's machine:

| | pipelines | awaited by the wave? | counted in the log? |
|---|---|---|---|
| `state.queue` | 5 | yes | yes (`compute kernels: 5`) |
| **SRC** | **44** | **no** | **no** |

The wave prints `compile wave: materials 1647ms, computes 68312ms` and declares
itself finished. The first frame after it then triggers 44 async pipeline
creations, the driver serializes them (§13.3, and the per-pipeline number is
LATENCY not compile time), and every SRC dispatch is skipped until the last one
resolves. Since [I] made SRC's screen gather the **primary** diffuse term
(§12.30.1), skipped SRC dispatches mean no indirect light at all.

**That is the whole of "GI appears after 3-4 minutes":** 68 s of counted wave,
then an uncounted second wave of 44 more pipelines during which GI is
structurally absent. Neither log line is wrong about what it measures; between
them they cover 5 pipelines out of 49 and imply completion at the point where
90% of the work starts.

Two more things the same console dump shows, worth separating from the above so
they are not conflated with it:

- **Two GI systems compiled concurrently.** `4 compute pipelines … 62926ms` and
  `2 compute pipelines … 134891ms` printed at the same millisecond, from two
  waves whose `materials` legs differ (896 ms vs 4000 ms). A rebuild does not
  cancel the outgoing system's in-flight compiles, so the second wave queues
  behind the first on a serializing driver and pays 135 s for 2 pipelines.
- **`resolveMaxPixels: 1_600_000` is not biting but is close.** The editor's
  drawing buffer is 1656×950 = 1,573,200. A slightly larger viewport crosses the
  ceiling and the resolve shrinks isotropically — which would change SRC's
  entire cost model as a side effect of a window drag. Recorded because the next
  person to measure a frame at a different window size needs to know.

**The fix has two independent halves and only the first is cheap.** (1) Put
SRC's passes in the prewarm set and in the kernel count, so the wave covers what
it claims and the number is honest — this does not make startup faster, it makes
it *measured*, and it moves the stall inside the window `bootAmbient` exists to
cover. (2) R18's ≤1 s needs the pipeline COUNT down or the disk cache reliably
engaged (§13.5); 49 pipelines at the measured ~0.7 s of serialized latency each
is ~34 s no matter how small each kernel is, and §13.4 already showed a 154 kB
kernel compiling 85× faster than a 16 kB one. **Merging dispatches is therefore
the direction, not splitting them** — but every merge candidate has to survive
the barrier argument in `srcRays.js`'s [D] header, which is why this is a
measurement task and not a refactor.

### 12.31 WHERE THE 3 FPS IS — AND THE TIER THE FIRST SWEEP MEASURED

**User report, 2026-08-11: "3 fps on ultra… we need <1 sec startup for GI and at
least stable 60 fps on ultra, 120 fps on low."** (The sky is deliberately at
zero: "first we make lights right, then the sky." So the §12.30.3 environment
note is answered and closed — it is not a bug, it is the order of work.)

`profile.giPasses` against the live editor, Sponza, ultra, drawing buffer
1656×950:

| group | ms | dispatches |
|---|---|---|
| **deposit (trace + shade)** | **249.048** | **3** |
| gather | 6.151 | 2 |
| rays | 1.888 | 10 |
| populate | 1.877 | 17 |
| merge | 0.877 | 8 |
| tiles | 0.481 | 2 |
| hashBlock / surfaces | 0.021 | 2 |
| **SRC chain** | **260.343** | 44 |
| screen resolve | 5.661 | — |

One group is the frame: **95.7%**. The other 41 dispatches total 11.3 ms.

The transport's domain is the screen. `srcSystem` sets `pixelCount = width *
height`; the population inserts a probe per gbuffer pixel, `srcRays`'s [D1]
gives each pixel `raysPerPixel` rays, and the deposit is dispatched **per pixel**
with the ray loop unrolled inside (`srcDeposit.js`'s [E]). At ultra that is
1,573,200 px × 2 = **3,146,400 rays per frame**, servicing **5,692 live probes** —
about 553 rays per probe per frame, against the 0.78 rays/bin this design
measured for itself in §12.13.

`srcConfig.js` says the intended domain in as many words — "`raysPerPixel` counts
full-length rays per **half-res** gbuffer pixel" — but `giConfig.js`'s tier table
gives ultra `resolveScale: 1`, and its comment prices that choice with the DENSE
backend's cost model: *"Half-res resolve… Ultra pays ~4× the resolve to remove
it"* (measured then at 9 ms → 22 ms). Under SRC `resolveScale` is no longer the
price of a resolve pass — the resolve pass still costs 5.66 ms at full res — it
is the size of the entire transport. **The tier table was never re-derived when
the backend under it was replaced.**

#### 12.31.1 The first sweep measured tier LOW and answered a different question

`probe:gi-src-cost` sweeps `resolveScale` through `__giConfigOverride` with
everything else held. Run 1, four arms:

```
scale   transport px      rays    deposit ms   ns/ray   screen mean   lit
1           315952     315952        1.598      5.1       0.07585 31.8%
0.5          78988      78988        1.642     20.8       0.06853 29.0%
0.25         19796      19796        0.763     38.5       0.06792 29.4%
```

and it printed, confidently: *"NOT a clean per-ray cost — ns/ray moves across
the sweep."*

Every number there is real and the conclusion does not apply, because **all
three arms ran at tier `low`** (s₀=0.8, w₀=4, 1 ray/px, secondary cache off) —
the tier the scene happened to be saved at, not the ultra the question was
about. The probe forced `resolveScale` and inherited `quality`. It is now
pinned: `resolveGiConfig` applies `BY_TIER[quality]` *before* the override, so
`{quality, resolveScale}` sets the SRC tier and the pixel count independently.

**The instrument fault underneath is worth more than the run.** The verdict
thresholded `max(ns/ray) / min(ns/ray)` against 1.35. But the deposit is
`floor + slope·rays`, and when the floor is comparable to the ray term ns/ray
*must* climb as rays fall **on a perfectly linear cost**. At tier low the whole
deposit is 1.6 ms, so the floor is nearly all of it — the statistic measured the
floor and reported it as a refutation of linearity. It now fits both terms by
least squares and prices the fix off the SLOPE, because cutting rays can never
buy back a floor. Same family as §12.28's `maxL`: a summary statistic chosen
before the cost model was written down.

**One thing run 1 did establish, and it is good news:** at tier low the entire
SRC chain is **2.43 ms** over 44 dispatches. The 120 fps-on-low target is not
far away; the work is at the top of the ladder.

#### 12.31.2 Two corrections to what was said about the deposit

- **"NEE fires four shadow rays per hit" — WRONG for this scene.** `MAX_GI_LIGHTS`
  is 4 and `srcShade.js` unrolls four *slots*, but each is gated on
  `cos > 0 AND E > 0`, and the user's Sponza has **1 active light and 0
  emitters**. A hit casts at most one shadow ray. The code says so at the loop:
  *"Measure before assuming it matters — the cosine gate means most hits pay for
  one or none."* `lightTree.js` is therefore NOT the lever it was billed as, and
  drops well down the list.
- **The 44 SRC dispatches are not in the compile wave** — see §13.9. That is the
  startup half of the same report and it has a different cause.

### 13.10 THE CACHE WORKS, 72×, AND STARTUP DID NOT MOVE

`probe:gi-boot`, 2026-08-11, after SRC's passes joined the warm set:

```
cold  TTFF 49360ms   slowest pipeline 44157ms
warm  TTFF 52474ms   slowest pipeline   611ms
```

**The slowest pipeline compiled 72× faster warm and TTFF moved −6%.** §13.5 left
"make the cache engage" as lever 2 and estimated 55 s → ~8 s from it. That
estimate is now refuted by the thing it was an estimate about: the cache engaged,
completely, and bought nothing. So pipeline compilation is not what startup is
made of — which also retires §13.2's ranking of PIPELINE COUNT as lever 1, since
count only matters through compile time.

Where the wall clock actually is, same run:

```
first creation → last completion   53384ms
  of which SOME pipeline was busy    969ms   2%
  idle between compiles            52415ms  98%
all pipelines, summed               8317ms   (concurrent, hence 969ms of span)
GI CPU work (voxelize+BVH+setup)    1670ms   3.2%
```

8.3 s of pipeline work overlapped into 969 ms of wall clock, inside a 53 s span.
Fifty-two seconds is neither the driver nor the GI CPU work this plan has
measured three times.

**⚠ AND THAT LAST SENTENCE IS WHERE THIS COULD GO WRONG AGAIN.** "Idle between
compiles" is computed by ELIMINATION — it is whatever is left after subtracting
spans that were measured. The probe labels it "TSL node-graph build + WGSL
generation", which is a hypothesis wearing a measurement's clothes, and naming a
stage from a leftover is exactly the §13.8 mistake that put four wrong claims
into the first version of this section. Candidates the subtraction cannot
separate: TSL graph construction, WGSL codegen, the material compile wave, JS GC,
the prewarm loop's own per-node macrotask yields, asset work on the same thread.

So it is now measured directly rather than inferred: the prewarm loop times the
SYNCHRONOUS part of each `giCompute` — which is precisely where three builds the
node graph and generates WGSL, before anything reaches the device — and logs
`[gi] node-graph build + WGSL codegen (JS, synchronous): Nms over K kernels,
worst Mms at #i`. If that number is tens of seconds the attribution is
established and the lever changes completely (fewer/smaller TSL graphs, not
fewer/smaller shaders). If it is small, the 52 s is somewhere else and the next
instrument goes there.

**What is already safe to say:** a shader cache cannot fix this, a kernel diet by
byte count cannot fix this (§13.4 again — 154 kB in 172 ms vs 2 kB in 611 ms,
4× faster at 69× the size), and the cold arm's single 44 s pipeline is a COMPILER
PATHOLOGY in one 2 kB / 0-loop / 5-if kernel rather than a volume problem.

### 13.11 IT IS NOT TSL EITHER — 6 ms OF 40,832 ms

The direct measurement §13.10 asked for, warm boot, user's Sponza:

```
[gi] node-graph build + WGSL codegen (JS, synchronous): 6ms over 49 kernels, worst 0ms at #48
[gi] 1 compute pipelines compiled concurrently in 70ms (frames kept flowing)
[gi] compile wave: materials 7315ms, computes 40832ms (viewport remained live)
```

**Six milliseconds.** `probe:gi-boot`'s "idle between compiles ← TSL node-graph
build + WGSL generation (JS; no shader cache touches it)" is refuted. So is the
version of it §13.10 was written around. Building all 49 node graphs and
generating 630 kB of WGSL costs 6 ms; draining every pending pipeline costs 70
ms; and the phase those two live inside reports **40,832 ms**.

That label has now cost two rounds and it was never a measurement — it is the
name the probe prints on a subtraction. §13.8 recorded four wrong claims of
exactly this shape and the fix written down then was "measure the stage
directly". It worked; it just needed doing a third time, because the leftover
had been relabelled rather than measured.

**What is left inside `computes`** — the window is `t1` (materials done) to the
log line, and it contains, in order: the prewarm creation loop (49 iterations,
each `await new Promise(setTimeout(0))` **then** `giCompute`), the pipeline
drain, the re-dispatch loop, and `#warmOverridePass`. Two of those four are now
measured at 76 ms combined. The remaining candidates are the **yields** and the
**postprocess pass warm**, and they are very different problems:

- **The yields.** One macrotask per kernel, deliberately — "frames kept
  flowing" is the feature. But a yield lets the browser run a whole frame, so
  the loop's wall time is ≈ `kernels × frameTime`, and this scene's frames were
  not cheap while GI was unoptimized. **⚠ AND THIS SECTION'S OWN CHANGE
  MULTIPLIED THE KERNEL COUNT BY TEN** (5 → 49, §13.9). If the yields dominate,
  putting SRC's passes in the wave made the wave roughly 10× longer while fixing
  the accounting — a regression introduced by a fix, which is worth stating
  plainly before any number is claimed for it.
- **`#warmOverridePass`.** Already suspected once: the engine logs "first frame
  after compile wave took 655ms — pipelines recompiled at resume (likely the
  postprocess render path; report this)".

Both are inside `computes` and neither is timed. That is the next instrument,
and this time the two candidates get separate timers rather than one label.

**⚠ A METHOD NOTE THAT KEEPS EARNING ITS KEEP.** The `node-graph build` line was
invisible for two runs: `probe:gi-boot` parses a fixed set of log lines into its
report and drops everything else, so a log line added *after* the probe was
written cannot reach it. It was read by echoing it from
`run-gi-src-cost-probe.mjs`, which keeps every `[gi]` line verbatim. Same family
as yesterday's grep filter that hid working per-group output for three rounds:
in both cases the instrument was correct and the READER was discarding it.
Prefer a probe that echoes unrecognised lines over one that parses only what it
already expects.

### 12.32 WHAT THE CEILING COSTS TO LOOK AT

Three arms at the SAME 499,720 transport pixels and the same 806×620 resolve,
differing only in `__giSrcTransportRays`:

| ceiling | traced rays | stride | deposit ms | screen mean | lit |
|---|---|---|---|---|---|
| 262,144 | 249,860 | 4 | 4.696 | 0.16325 | 71.2% |
| 65,536 | 62,465 | 16 | 2.548 | 0.15241 | 67.9% |
| 16,384 | 16,120 | 62 | 1.509 | 0.15163 | 68.2% |

**16× fewer rays costs 7.1% of screen mean and buys 3.1× on the deposit.** The
shape matters more than the endpoints: the image falls 6.6% between 262k and 65k
and then **stops** (−0.5% over the next 4× cut) while cost keeps dropping. So
there is a knee, the tier defaults sit above it, and the region below 65k is
paying real time for a difference the picture has already stopped registering.

**The deposit does not fall 16×, and the reason is now the binding constraint.**
Least squares: `deposit ms ≈ 1.930 + 8.2 ns × rays`. That 1.9 ms floor is the
strided dispatch still launching **every pixel's thread** so that 15 of 16 can
compute one modulo and return. The ray ceiling caps the ray work and leaves the
thread work untouched.

Scaled to the user's 1,573,200 px that floor is ~4.7 ms of pure launch overhead,
which no ceiling can remove. **The next lever is therefore the dispatch count**:
`.compute(ceil(pixelCount/stride))` with thread → pixel mapping instead of
`.compute(pixelCount)`. It was deferred when the ceiling landed on the grounds
that a baked dispatch count costs a rebuild to change; the honest version of
that trade is now visible — bake the count off the TIER's ceiling (a build-time
constant) and keep a uniform stride for movement inside it, which also makes
every SRC dispatch count independent of the viewport and stops a window resize
rebuilding the frame.

**⚠ AND THE REST OF THE CHAIN IS STILL PER-PIXEL.** At the user's resolution the
non-deposit groups measured 11.3 ms — gather 6.15, populate 1.88, rays 1.89,
merge 0.88, tiles 0.48 — none of which the ray ceiling touches, plus a 5.66 ms
screen resolve. **So ~17 ms of GI survives a perfect deposit at 1,573,200 px,
which is already past a 60 fps frame budget before the scene is drawn.** 60 fps
at ultra needs SRC's transport resolution decoupled from `resolveScale` as well
— the fix identified when this started and not yet done. Stating it now so the
ceiling is not mistaken for the whole answer.

#### 12.32.1 Two instrument faults, one of them mine to own

- **The sweep could not hold its own control.** `SWEEP=ceiling` exists to fix
  the resolve and move only the ceiling, and its arms still came back at 315,952
  and 499,720 px — the editor's viewport panel settles to different sizes across
  page loads, so one-arm-per-page cannot hold a resolution. The verdict withheld
  (correctly), and three of four arms happened to agree, which is luck, not
  method. **Fixed properly: the ceiling is now POLLED PER FRAME**, the same rule
  `__giSrcAlpha` follows and for the reason §12.23 wrote down — a build-time
  value can only be A/B'd by reloading, and a reload is the comparison this
  module keeps getting wrong. The whole sweep can now run inside one page, one
  build, one viewport.
- **R15 was violated, by me, mid-run.** `srcSystem.js` was edited while that
  sweep was still executing. The edit is behaviourally identical at build time
  (a fixed global polls to the value it was read as), so the numbers above are
  believed sound — but a Vite reload landing mid-arm kills an arm outright, and
  "believed sound" is a weaker claim than these tables usually carry. Recorded
  rather than quietly re-run, because the rule exists precisely because this
  failure is invisible when it does not happen to break anything.

### 13.12 THE WAVE WAS WAITING, NOT WORKING — 10 ms OF WORK IN 24,478 ms

The decomposition §13.11 asked for, warm boot, ultra:

```
[gi] prewarm loop 24478ms over 49 kernels
       = 10ms node-graph build + WGSL codegen (worst 5ms at #34)
       + 24468ms YIELDING (499ms per kernel — one macrotask each, so one rendered frame each)
[gi] 1 compute pipelines compiled concurrently in 294ms
[gi] compile wave: materials 25754ms, computes 24778ms
```

**99.96% of the loop is the yield.** The prewarm did `await new Promise(setTimeout(0))`
before every kernel; a macrotask lets the browser run a whole frame, and a frame
during startup costs ~499 ms. So the loop's wall time was `kernels × frameTime`
and had nothing to do with how much work it had to do — which is 10 ms.

That closes the chain §13.10 opened. Warm boots are not pipeline-bound (the
cache works, 44×), not TSL-bound (§13.11, 6 ms), and not GI-CPU-bound (1.6 ms,
3.2%). They were bound by a yield cadence.

**⚠ AND §13.9's FIX MADE IT TEN TIMES WORSE.** Putting SRC's 44 passes into the
warm set was correct — without it a skipped dispatch meant no diffuse light at
all — but it took the kernel count from 5 to 49 and the yield count with it. A
right fix with a cost that was invisible because nothing timed the loop against
its own work. Worth keeping as the example: the change was reviewed, reasoned
about, documented, committed, and it carried a 10× regression in the number the
user actually complains about.

**The fix is a budget, and it is the shape this file already uses** — the
material wave yields "270 skipped by the 40ms budget". The prewarm now yields
only after holding the thread ≥ 8 ms. At 10 ms of total work that is about one
yield: the viewport loses one frame instead of forty-nine.

**⚠ TWO REGIMES, AND THE HARNESS ONLY SHOWS ONE.** The user's editor logged
`3 compute pipelines compiled concurrently in 68250ms` — the DRAIN, not the
yields, because their cache was cold. The harness's drain is 70–294 ms because
it is warm. So:

| | warm (harness) | cold (user's editor) |
|---|---|---|
| dominant term | prewarm yields, 24.5 s | pipeline drain, 68 s |
| what fixes it | the yield budget | nothing here — see §13.4 |

Both are real and they are different problems. The yield budget cannot help a
cold boot, and the shader cache cannot help a warm one. R18's ≤1 s needs both,
and the cold half still has no lever that has survived measurement — §13.4's one
2 kB / 0-loop / 5-if kernel taking 24–44 s is a compiler pathology, not a volume
problem, and it is the next thing to isolate.

#### 13.12.1 Verified, and the win is smaller than the loop's own number

```
                    before      after
prewarm loop      24478ms        2ms     (yielding 24468ms → 0ms)
pipeline drain      294ms     8347ms
compile wave "computes"
                  24778ms     8356ms     = 2.97×, saving 16.4s
```

**The drain grew by 8 s and that is not noise — it is the yields' one real
service, now withdrawn.** Yielding between kernels handed the driver time to
compile *while the loop was still running*, so by the time the drain started
most pipelines had landed and it measured 294 ms. Without the yields every
creation fires in one burst and the drain waits for all of them.

So the honest accounting is 24.8 s → 8.4 s, **not** the 24.5 s the loop's own
line would suggest. Quoting the loop's saving alone would have been true about
the loop and wrong about startup, which is the failure this section has now
recorded three times in three different costumes.

**What is now the largest term, and it is not GI's compute at all:** the
MATERIAL wave, and it is wildly unstable across otherwise identical boots —
5,606 / 7,315 / 8,369 / 16,798 / 25,754 / **42,015** ms. That spread is bigger
than everything this section just fixed. It is the next thing to measure, and
nothing about it should be guessed at from here: §13.8's four wrong claims and
§13.10/§13.11's two wrong labels all came from reasoning about a stage instead of
timing it.

### 12.33 THE DISPATCH SHRINKS — AND A HYPOTHESIS FOR THE 5× ns/ray GAP

§12.32 left the ray ceiling capping rays while the dispatch still launched one
thread per gbuffer pixel, 15 of 16 of which computed a modulo and returned: a
1.930 ms floor at 499,720 px, ~6 ms at the user's 1,599,840. Now [D1], [D5] and
the deposit's [E] dispatch **transport threads**, and thread `t` owns pixel
`t·stride + phase` (`transportPixel`, srcMathTsl — one definition, three
callers, because a mismatch between [D5]'s write set and [E]'s read set is a
silent cross-probe corruption rather than a crash).

The thread count is **baked from the TIER's ceiling**, not from the resolution:
three bakes `.compute(n)`, so it cannot be a uniform, and deriving it from the
tier makes the transport's dispatch size **resolution-independent** — a viewport
resize no longer rebuilds these three passes. The stride stays a uniform, so the
live `__giSrcTransportRays` A/B still works *inside* that budget; a hatch set
above the tier's ceiling clamps, which is stated in the code because a probe
that raises it and sees nothing change would otherwise conclude the ceiling is
inert.

`stride = max(1, floor(pixelCount/threads), ceil(naturalRays/ceiling))`. The
middle term is what spreads a baked thread count across the whole screen; drop
it and a *looser* ceiling produces a stride too small to reach the far side of
the image, so the transport samples a CROP — top strip lit, rest dark, which
reads as a GI bug rather than as a budget.

#### 12.33.1 The gate found the bug, and it was the gate's

ARM 7 failed on the first run: 3,125 pixels "fired out of class", 2,062
duplicate ray indices, 4,188 out of range — every message pointing confidently
at the [D1]/[D5] disagreement the arm exists to catch. All of it stale reads.

A strided [D5] writes `pixelRayBase` only for the pixels it owns, so every other
slot keeps whatever the earlier full-dispatch runs left there, and the arm scans
the WHOLE buffer. The production code is fine — [E] walks the same mapping with
the same uniforms in the same frame, so it reads only what [D5] just wrote — and
the comment saying "not safe for a consumer that scans the whole buffer" was
already in `srcRays.js` when its first such consumer failed. The arm now takes a
fresh `createSrcRayStore` (`fill(SLOT_EMPTY)`), which keeps the whole-buffer scan
meaningful rather than masking it to the owned pixels; masking would have made
the arm blind to a [D5] writing outside its own set, which is the one thing it
is for.

**And the mirror was wrong in a way only a non-zero phase could show.**
`srcRef`'s predicate was `(index + phase) % stride === 0` — the residue class
`−phase` — while the kernel enumerates `+phase`. They coincide **exactly at
phase 0**, so the mirror agreed on frame 0 of every gate and disagreed on every
other frame. Now written as the kernel enumerates it, plus the span bound
(`t < threads`), and the totals match exactly (3124 = 3124) across three runs.

#### 12.33.2 The unexplained 5×, and a testable guess

The same kernel measures **~13 ns/ray in the harness and 61–85 ns/ray in the
user's editor**, both at ultra, both on the same machine. §12.31 recorded this as
unexplained. A candidate that has not been tested and should be, because it is
cheap and it would be a product fact rather than a bug:

**Ray LENGTH is a function of camera distance.** `reach = intervalBoundary(N−1,
lod, s₀)` and `lod = floor(lodAtDistance(chebyshev(P, camera), …))`, so a probe
further from the camera sits at a higher LOD and its rays are ~2^lod longer. The
harness pins the verified nave pose; the user's editor camera is wherever they
left it. A view from outside the model would raise every LOD at once and
multiply per-ray traversal cost across the whole frame.

If that is it, GI's cost depends on how far back the camera sits, which is worth
knowing independently of this rebuild — and it is one `viewport.getCamera` away.
Do not attribute the gap to cache pressure or clocks (the two guesses so far)
until this one has been ruled out.

### 12.34 WHAT ULTRA'S FULL-RES RESOLVE BUYS — AND WHY THE MEAN CANNOT ANSWER IT

With the ceiling holding ray count constant, a `resolveScale` sweep finally
isolates resolve resolution alone. Ultra, same tier, same 249,860 rays:

| scale | transport px | deposit ms | screen mean | lit |
|---|---|---|---|---|
| 1.00 | 499,720 | 3.735 | 0.16325 | 71.6% |
| 0.50 | 124,930 | 3.381 | 0.16094 | 70.6% |

Four times fewer resolve pixels for **1.4%** of screen mean. Also confirms the
thread-sized dispatch is free: 4.696 → 3.735 ms at 499,720 px with the mean
IDENTICAL at 0.16325, i.e. it changed cost and not the image.

**⚠ DO NOT FLIP THE TIER ON THAT 1.4%.** `giConfig.js` justifies ultra's
`resolveScale: 1` as removing "bad corners under a bright sun" — an EDGE
artifact along silhouettes. A frame mean is nearly blind to edges: a thin rim of
wrong pixels around every object moves it by a fraction of a percent while being
exactly the thing a person notices. The statistic and the claim are about
different quantities, which is the §12.28 `maxL` mistake in a new costume, and
1.4% is what it looks like when you make it. The measurement that would settle
this is an edge-localized one (or a person), and neither has been run.

What the sweep does establish is the SIZE of the prize: gather (7.55 ms) +
resolve (4.54 ms) + populate (2.06 ms) on the user's editor are all
per-resolve-pixel, so ~14 ms rides on this tier flag. The principled version
keeps the resolve at full res — it is the AO/shadow composite, and it is what
ultra is FOR — and runs only SRC's gather at half res into a texture the resolve
samples by UV instead of `load(coord)`. That preserves the edge quality the flag
was chosen for and still takes 7.55 ms to ~1.9 ms.

**Not done, and deliberately ranked below the next item:** the deposit at the
user's resolution is still ~16–22 ms and is RAY-bound at 61–85 ns/ray against
the harness's ~13. Closing that gap is worth ~18 ms; the gather is worth ~5.6 ms.
So §12.33.2's camera-distance hypothesis gets tested first — `SWEEP=camera` in
`probe:gi-src-cost`, which holds tier, resolveScale and the ceiling (so ray
count is constant and ns/ray is pure traversal cost) and moves the camera
straight back along its own view axis at 1×/3×/6×.

### 12.35 THE CAMERA HYPOTHESIS IS REFUTED, AND THE ARM THAT REFUTED IT IS ALSO CONFOUNDED

§12.33.2 guessed that the 5× ns/ray gap between the harness and the user's
editor was ray LENGTH via camera distance. `SWEEP=camera`, ultra, ceiling
holding ray count:

| arm | rays | deposit ms | ns/ray | hits shaded | screen mean |
|---|---|---|---|---|---|
| nave (1×) | 210,635 | 3.064 | 14.5 | 210,636 | 0.11819 |
| back 3× | 249,860 | 1.471 | 5.9 | 69,756 | 0.77573 |

Pulling back made it **2.5× CHEAPER per ray**, the opposite of the prediction.
The hypothesis in its "longer rays cost more" form is dead.

**And the arm cannot be read as a distance measurement anyway.** `hits shaded`
falls from 210,636 to 69,756 — a **28% hit rate against the nave's ~100%** — and
the screen mean goes 0.118 → 0.776. The camera left the building. From outside,
most rays escape to sky in a few DDA steps instead of crossing a colonnade, so
the arm changed WHAT the rays traverse and not merely how far. Moving straight
back along the view axis was chosen to hold the subject fixed and it does not,
once the camera passes the wall.

**The transferable result is the one that was not being looked for: per-ray cost
varies 2.5× with camera pose in a single scene.** So an ns/ray figure is only
meaningful next to the pose that produced it — which retroactively voids
comparing this harness's pinned nave pose against the user's unknown one. The
5× "gap" may be partly or entirely that comparison, and no amount of re-running
the harness can tell, because the harness cannot see their camera.

**What that changes:** stop attributing the gap. It has now survived three
guesses — cache pressure, sustained-load clocks, camera distance — and not one
was measured against the thing it claimed. The next step is not another
hypothesis; it is a `profile.giPasses` **and** a `viewport.getCamera` from the
user's editor in the same breath, so cost and pose are read together. Their
editor is detached from the MCP bridge at the time of writing.

Two lesser facts from the same run, recorded because they cost nothing to keep:
- Enclosure, not distance, is what makes a ray expensive here. A scene where
  most rays escape is cheap; an interior is not. That is a property of the
  content, and it means "GI costs N ms" is not a per-scene constant.
- The prewarm loop reads 2–3 ms on every arm now (was 24,478 ms), and `computes`
  is dominated by the pipeline drain again (30–44 s cold) — the harness gets a
  fresh Chrome profile per run, so it is cold every time by construction and
  **cannot measure a warm restart**. Do not read its material/compute wave
  numbers as what the user experiences on a re-open.

### 12.36 THE HALF-RES GATHER: MEASURED, VISIBLE, AND BACKED OUT

The gather is the #2 cost on the user's editor — **7.55 ms of a 34 ms SRC
chain** — and unlike the deposit it cannot be strided, because every output
pixel needs a value this frame. The only lever is producing fewer of them.

Landed: the gather has its own grid (`SRC_GATHER_SCALE`, `gatherWidth ×
gatherHeight`) with an index map into the full-res gbuffer, and `giScreen`'s
resolve reads it with a **UV sample** instead of `load(coord)` so the hardware
bilinear does the upsample. Deliberately NOT `resolveScale`: that would take the
AO/shadow composite's silhouette edges down with it, which is the thing ultra
pays for (§12.34).

It works. No validation errors, no page errors, the chain drops.

**And it is set to 1.** At 2 it bleeds irradiance across silhouettes, and not
theoretically — a box in the Sponza nave renders **pure black with sharp edges
at 1:1 and soft mid-grey at 2:1**, having picked up its neighbours' light. The
control that settles the attribution is a shot taken *before this code existed*:
`resolveScale 0.5` with a full-res gather shows the **same grey box**. So the
artifact belongs to a coarse irradiance carrier in general, this change
reproduces it faithfully, and it is not a mapping bug.

Shipping it would trade a measured 5.6 ms for light leaking onto every
silhouette — the same artifact class ultra's `resolveScale: 1` exists to avoid,
which makes it a strange thing to introduce two sections after declining to flip
that flag for the same reason.

**What unlocks it is already in the codebase.** `giConfig.js` describes the
resolve→screen path as upsampling through "the position-validated bilateral".
The gather→resolve step is a *second* upsample with no such filter. Give it the
same treatment and the 5.6 ms is available; the plumbing, the index map and the
UV sample are all in place and gated behind one constant.

**Why this is written down rather than quietly reverted:** the next person to
look at a 7.55 ms gather will have exactly this idea, and the useful thing to
inherit is not "don't" — it is the measured size (5.6 ms), the specific artifact,
the control image that proves it is not a bug in the mapping, and the name of
the filter that fixes it.

### 13.13 THE MOST EXPENSIVE OBJECT IN THE BOOT IS A KERNEL THAT NEVER RUNS

`probe:gi-boot`, cold, user's Sponza, SRC off — their editor's exact
configuration:

```
TIME TO FIRST CORRECT FRAME       141,107 ms
slowest SINGLE pipeline           132,803 ms   94.1% of TTFF
  77 kB WGSL, 4 loops, 204 ifs
  fns: giDynBvh8, dynNz8, giDynShapeHit_1, giFreeRadius4nsr1_3,
       giStaticBvh8, statNz8, giDynTrace00100_0, tsl_mod_float
GI CPU work                         2,719 ms    1.9%
```

Those function names are the **GI-traced light shadow marcher**
(`static-bvh8 + exact-dynamics + analytic-width`). And `profile.giPasses`,
against the same live editor, says of that exact pass:

> `lightShadowPass: "1.7206 (NOT dispatched — no light uses Shadow Source \"gi\")"`

**Ninety-four percent of GI startup is compiling a kernel the scene never
dispatches.** Their editor logs the same shape independently: `1 compute
pipelines compiled concurrently in 62046ms`.

The frame loop has skipped these six passes since 2026-08-07 when no light asks
for GI shadows (`anyGiShadow`) — worth ~0.4 ms a frame, and the comment says so.
Nothing ever skipped *compiling* them, and nobody looked, because every startup
measurement this plan has taken reported a total.

**Why code-reading could not have found it.** §13.4's rule holds: a **154 kB**
kernel compiles in **4.5 s** in the same run while this **77 kB** one takes
**132 s** — 29× slower at half the size. The fingerprint that separates them is
**4 loops against 0**. That is the BVH descent, and a shader compiler unrolling
four nested loops over 204 branches is where two minutes go. No amount of
staring at WGSL byte counts gets there; the per-pipeline timer plus the
loops/ifs readout does it in one run.

**The fix is a RAMP, not a removal (R1).** The passes are still built. They are
only left out of the prewarm when `anyGiShadow` is false. Flag a light with
Shadow Source "gi" and the pipeline is created on first dispatch — async, frames
keep flowing, the dispatch is skipped until it lands, which is the path every GI
pipeline already takes. The cost moves from *every boot of every scene* to *the
first frames after you ask for it*.

⚠ Filtered out of BOTH prewarm loops. The second one re-dispatches "for real"
after the drain, and leaving it unfiltered would trigger the very creation the
first loop skipped — a fix that measures as no change and reads as a mystery.

**This also re-ranks §13 one final time.** The levers, as measured rather than
assumed:

| claim | status |
|---|---|
| "83% is pipeline creation" | true of the *span*, useless as a lever |
| "PIPELINE COUNT is lever 1" | refuted (§13.10) — the cache engaged 44× and TTFF did not move |
| "make the cache engage" (55 s → 8 s) | refuted (§13.10) — it engaged, completely |
| "98% is TSL node-graph build" | refuted (§13.11) — 6 ms |
| the prewarm's yield cadence | REAL, 24.8 s → 8.4 s (§13.12) |
| **compiling undispatched passes** | **REAL, 94% of a cold boot** |

Six explanations, two of them real, and the two real ones were both found by
timing a thing directly after an aggregate had already been read three ways.

#### 13.13.1 CORRECTION: two kernels share that fingerprint, and only one was skipped

§13.13 above names the 132,803 ms kernel as the GI-traced light shadow marcher.
**That attribution is not established, and the evidence now says at least one
more kernel wears the same fingerprint.**

The skip works — proven, not assumed:

```
[gi] skipping 4 light-shadow pipelines at warm-up — no light uses Shadow Source "gi"
[gi] compute kernels: 45 totaling 516kB WGSL (1 screen chain of 5 + 44 SRC; …)
[gi] compile wave: materials 52016ms, computes 30ms
```

One of five screen kernels warmed, and the compute leg of the wave is **30 ms**.
But:

```
[gi] SLOWEST PIPELINE: #48 took 51.1s (?kB WGSL) of 292.1s over 61 pipelines
```

**#48 is past the 45 warmed kernels** — that is what the `?kB` means, there is no
`kernelSizes[48]` — so this pipeline is created OUTSIDE the prewarm, and the
boot probe's post-skip run shows it with the identical 77 kB / 4 loops / 204 ifs
/ `giStaticBvh8`+`giDynBvh8`+`giFreeRadius…` signature at 50,137 ms.

Both the shadow marcher and the **BVH exact-reflection prepass** descend the
same BVH through the same shared functions, so the fingerprint cannot tell them
apart. What separates them is dispatch: the reflection prepass runs EVERY frame
that `exactReflections` is on (a tier property, true at ultra), so it cannot be
skipped — only warmed honestly. It is now in the prewarm, same reasoning as
SRC's 44 in §13.9.

**So the boot-probe drop from 141,107 ms to 57,053 ms is NOT yet attributable to
the skip.** This probe has reported 49 s, 141 s and 57 s for nominally the same
cold configuration; a single before/after pair across runs that vary 3× is not a
measurement, and treating it as one would be the §12.31.1 mistake again. What IS
established: the skip fires, four kernels leave the wave, and `computes` reads
30 ms. What is NOT established: how much of TTFF that bought, and which of the
two BVH kernels owned the original 132 s.

The next honest step is a within-run A/B — the same page, the ceiling-sweep
pattern — not another cold boot compared against a remembered number.

#### 13.13.2 The BVH reflect pass was also unwarmed — and it is still not #48

Adding `screen.bvhReflect` to the prewarm (same reasoning as SRC's 44):

```
[gi] compute kernels: 46 … (2 screen chain of 5 + 44 SRC; sizes 72/16/2/2/5/…kB)
[gi] SLOWEST PIPELINE: #48 took 47.5s (?kB) of 262.3s over 61 pipelines
```

The reflect pass is the 16 kB entry and is now warmed. **#48 is still outside the
prewarm** — 61 compute pipelines exist in the process and only 46 are warmed, so
roughly fifteen GI compute passes are created somewhere other than `state.queue`,
`srcProbes.passes` or `bvhReflect`. Candidates not yet enumerated: the occupancy
pyramid build, the composite, the dynamic-object passes, the BVH atlas blit.

**Stopping the chase here, deliberately.** Warming a pipeline does not make it
compile faster — §13.9 said so when SRC's 44 went in and it is still true. It
moves the cost inside the wave and makes the log honest, which is worth doing,
but the 47–132 s belongs to a COMPILER PATHOLOGY (77 kB, **4 loops**, 204 ifs,
against a 154 kB / 0-loop kernel at 2.2 s) and the fix for that is to restructure
the loops or to not build the kernel, not to warm it earlier.

So the open item is precise: **one BVH-descent kernel costs 47–132 s to compile,
it is created outside every prewarm list, and its identity is one enumeration
away.** Everything else about GI startup is now either fixed or measured.

### 13.14 THE PREWARM FIX HELD, AND STARTUP IS NOW ONE PIPELINE

The user's editor, reloaded 2026-08-11 08:43 with every startup commit in it:

```
[gi] compile wave: materials warmed safely in 4133ms while viewport remained live
[gi] skipping 4 light-shadow pipelines at warm-up — no light uses Shadow Source "gi"
[gi] prewarm loop 2ms over 45 kernels = 2ms node-graph build + WGSL codegen
      (worst 0ms at #0) + 0ms YIELDING
[gi] 2 compute pipelines compiled concurrently in 178005ms (frames kept flowing)
[gi] SLOWEST PIPELINE: #47 took 181.6s (?kB WGSL, "computePipeline_compute")
      of 233.2s summed over 51 pipelines
[gi] field ready: 753995 occupied voxels          ← 3 min 10 s after boot
```

Three of the four startup findings are now closed in the shipping build:

| stage | before | now |
|---|---|---|
| prewarm loop (§13.12, yield budget) | 24,468 ms | **2 ms** |
| materials wave | 5.6–42 s | 4,133 ms |
| never-dispatched shadow kernels (§13.13) | compiled | **skipped, 4 of them** |
| **one unwarmed compute pipeline** | 47–132 s | **181.6 s** |

**Startup is now exactly one object.** 178 of the 190 seconds between boot and
`field ready` are a single `createComputePipelineAsync`, and the other pipeline
in that wave accounts for the rest. Nothing else in the boot is above 5 s.

⚠ **THE COST IS NOT STABLE — 47 s, 132 s, 181.6 s FOR THE SAME KERNEL.** It grew
when a player-runtime build ran concurrently (autosave at 10 s triggers one every
~20 s, and one landed at 08:44:19 inside this wave). So the driver's compile of
this shader is contending for CPU with everything else on the machine, which
means a measurement of it taken under different load is not comparable — the
same trap §13.3 recorded for pipeline latency, one level up.

#### 13.14.1 `?kB WGSL` was the blocker, and it was self-inflicted

`kernelSizes` is collected only inside the prewarm loop, so the zip
`kernelSizes[slowest.order]` is defined only for warmed kernels — and the slow one
has been outside the prewarm every single time. **The instrument could name every
kernel except the one it existed to name.** three's own label for it is the
generic `computePipeline_compute`, so the log carried an index into a list the
kernel is not a member of.

Fixed by recording the WGSL against the shader module itself
(`device.createShaderModule` → `WeakMap<GPUShaderModule, string>`), so the
pipeline descriptor becomes self-describing regardless of which list built it.
The report now prints size, entry point, loop/if counts and the first storage
bindings — **the bindings name a kernel; the index does not.**

### 12.32 THE STRIDE'S FLICKER, MEASURED — AND WHY THE VERDICT LINE LIED FIRST

The ray ceiling (§12.31) refreshes a pixel every `S`-th frame while the decay pass
runs every frame, so `keep = (1-α)^(1/S)` was added to make the decay follow the
REFRESH rate. `test:gi-src-temporal` only covers the `S = 1` no-op, so the strided
arm needed its own measurement: `CEILING_AB=1` on `run-gi-flicker-frame.mjs`, two
interleaved rounds of still-only arms, tight ceiling 16,384 against the tier's.

```
strides: tight 10 (ceiling 16384), default 2 (ceiling 131072), pixelCount 78988
raw reversals/px:      tight 0.837   vs   default 3.090   (-73%)
reversals per REFRESH: tight 0.0465  vs   default 0.0343  (+35%)
step p95:              tight 0.0383  vs   default 0.0485  (-21%)
round-to-round spread on the DEFAULT arm: 0.287 of 3.090 = 9.3%
```

⚠ **THE RAW REVERSAL COUNT IS CONFOUNDED BY THE VARIABLE UNDER TEST.** A pixel can
only reverse on a frame where its value CHANGED, and a stride-`S` transport
refreshes it once every `S` frames — so the count falls with `S` mechanically.
"More stable" and "refreshed less often" are the same number. The first run's
verdict block printed **the opposite of its own data** on top of that, because the
effect size was `Math.abs(tight − dflt)` compared against a noise floor: an 80%
DECREASE tripped the "flickers more" branch. Two failures stacked — a confounded
statistic and a sign-blind test — and they happened to cancel into a conclusion
that read plausibly.

Dividing by the refresh count separates them, and that ratio is what the
correction actually claims: a refresh should land the same step at any `S`, not
that there should be fewer of them. **Per-refresh flicker is +35% at 5× the
stride, against a 9% round-to-round noise floor.** Small, real, and nowhere near
what an UNCORRECTED decay would give — at `S = 10` without the root, a bin keeps
`0.9¹⁰ = 0.35` of its evidence between refreshes and each refresh is close to a
reset. So the correction does the bulk of its job; a residual remains.

⚠ `step p95` is NOT usable at this sample count. The DEFAULT arm read 0.0307 and
0.0663 in the two rounds of one page — a 2.2× spread on an unchanged config. Its
noise floor is ~100%, so the "-21%" above is not evidence of anything and must not
be quoted as the correction improving magnitude.

#### 12.32.1 THE STRIDE IS A FREQUENCY CHANGE, AND THE METRIC CANNOT SEE THAT

The finding that matters for the user's report is not the +35%. It is that
**the stride moves the GI update rate into the eye's most sensitive temporal
band.** At the user's stride of 7 and 60 fps, every pixel's indirect term steps
8.6 times a second with a p95 step of ~5% luminance. At stride 1 the same
per-refresh noise arrives at 60 Hz, where the eye integrates it away.

Human temporal contrast sensitivity peaks around 5–15 Hz. So the ray ceiling —
a pure performance fix that took the SRC chain from 260 ms to 34 ms — bought its
speed by moving noise from an invisible frequency to the worst possible one, at
roughly constant amplitude. **`reversals/px` counts events and therefore scores
that trade as an IMPROVEMENT.** No pixel statistic in this harness can represent
"same amplitude, worse frequency"; the metric is blind by construction to the
mechanism most likely to explain what the user is looking at.

That reframes the fix. Neither α nor MIN_WEIGHT is the lever, because the problem
is not that a refresh is too big — it is that refreshes are too far apart and land
as steps. The candidates, in order of how well they fit the mechanism:

1. **Price the transport in PROBES, not screen pixels.** The boot line reads
   `421132 gbuffer pixels … 2 rays/px` for a field of ~5,692 probes. The ceiling
   is a band-aid over a cost model that scales with resolution instead of with the
   thing being estimated. Fixing this removes the stride entirely at 60 fps, which
   removes the frequency problem AND the perf problem in one change.
2. **Ramp between refreshes** — let the resolve lerp toward a probe's new value
   over the following `S` frames instead of adopting it instantly, converting a
   step train into a piecewise-linear signal. Cheap, but it adds `S` frames of lag
   and is a treatment of the symptom.
3. Spatially decorrelate which probes refresh on which frame, so the existing
   spatial interpolation averages several refresh phases per pixel.

(1) is the one that serves both of the user's stated requirements. It is a Phase 6
cost-model change, not a Phase 5 unit, and is recorded here rather than started.

#### 13.14.2 It is NOT the reflection prepass — and the A/B that refuted it also
#### showed why every boot measurement so far is untrustworthy

The kernel's function set (`giStaticBvh8`, `giDynBvh8`, `giDynShapeHit`,
`giFreeRadius…`) is the same one §13.13 attributed to the shadow marcher and
§13.13.2 to `bvhReflect` — both descend the same BVH, so the fingerprint does not
distinguish them. The scene's own material buckets made reflections the obvious
suspect: **`0 mirror, 1 specular, 27 diffuse-only, 0 dynamic-roughness`**, and
`exactReflections` is derived from `quality`, so high/ultra turns the prepass on
whether or not any material consumes it. Exactly the shadow-chain pattern.

`FLAGS='{"__giNoBvhReflections":true}'` (new, `probe:gi-boot`) tests it without a
code change (R12):

```
                            reflections ON        reflections OFF
  slowest single pipeline        109,409 ms            237,990 ms
  its fingerprint            77kB, 4 loops         77kB, 4 loops   ← unchanged
  TTFF                           113,469 ms            259,048 ms
  a TYPICAL other pipeline         ~1,800 ms             ~15,500 ms
```

**REFUTED.** The kernel compiles with the reflection prepass disabled, so it
belongs to neither reflections nor shadows — both of which are now excluded from
this boot. `giDynTrace00100` decodes as `pen=0, penWidth=0, meshes=1, excl=0,
objId=0` (`dynamicObjects.js` `trace()`), a plain nearest-exact-hit query, and it
sits next to `giFreeRadius4nsr1_3` — the occupancy marcher. That pairing is the
`hybrid-exact-complex` ray-hit path the boot log reports as active: **march the
field, resolve the hit exactly.** It is the main GI trace, it has no consumer to
switch off, and it must run.

⚠ **THE TWO ARMS ABOVE ARE NOT COMPARABLE, AND THE ROW THAT SAYS SO IS THE LAST
ONE.** Every *other* pipeline in the second run read ~15.5 s against ~1.8 s in the
first — 8.6x, uniformly, on kernels the flag does not touch. §13.3 already
recorded why: `createComputePipelineAsync` returns LATENCY, and the driver
serializes, so a slower monster inflates every number in the same process. The
only claim the A/B supports is the within-run one — *the kernel is still there* —
and the 109 → 238 s figure is not evidence of anything.

Same kernel, five measurements, one machine: **47 s / 109 s / 132 s / 182 s /
238 s.** Any conclusion drawn from a single cold boot compared against a
remembered number is worthless, and several in §13.13 were.

#### 13.14.3 `probe:wgsl-compile` — the instrument the rest of this needs

A 5-minute run with 5x spread cannot bisect a compiler pathology. `DUMP=<path>`
on `probe:gi-boot` writes the slowest kernel's WGSL to disk (keyed by a creation
COUNTER, not by array position — async pipelines resolve out of order and the
length-at-creation would hand back a different kernel's source), and
`probe:wgsl-compile <file.wgsl> [more…]` compiles it in an empty page: no engine,
no other pipelines, a fresh profile so §13.5's 72x shader cache cannot answer for
it, `getCompilationInfo()` checked first so a validation failure cannot be
reported as a fast compile.

⚠ Its absolute number is NOT the editor's — no engine bind-group layout, nothing
else competing. It exists for RATIOS between variants of the same shader, which
is the only comparison the fix needs.

#### 13.14.4 THE KERNEL, BISECTED — AND WHY R18 IS NOT REACHABLE BY TRIMMING IT

`probe:wgsl-compile`, 3 reps each, all arms in ONE process. Within-file spread is
**under 2%** once each rep gets unique source text (see the trap below), which is
the first time anything in §13 has been precise enough to bisect with.

| arm | median | vs baseline |
|---|---|---|
| baseline (as dumped) | 11,886 ms | — |
| `giDynBvh8` body stubbed | 12,069 ms | **no change** |
| stack `array<u32,44>` → 16 | 12,272 ms | **no change** |
| stack `array<u32,44>` → 8 | 12,332 ms | **no change** |
| `giStaticBvh8` body stubbed | 6,833 ms | −43% |
| both descents stubbed | 6,680 ms | −44% |

Then, holding everything else byte-identical and stubbing call sites one at a
time — 4 / 3 / 2 / 1 / 0 inlinings of `giStaticBvh8`:

```
  11,814ms   11,704ms   9,739ms   8,526ms   6,938ms
```

**THE LEVER IS THE NUMBER OF INLINED DESCENTS, ~1.2 s EACH.** `giStaticBvh8` has
**four** call sites at lines 2559 / 2704 / 2849 / 2994 — 145 lines apart, identical
arguments, variable numbering in strides of 40, sitting next to four calls to
`srcShadowWidthProbe`. That is **the 4-light shadow loop, unrolled at TSL graph-build
time**, each copy inlining a whole 2-nested-loop BVH8 descent. `giDynBvh8` has one
call site and costs nothing measurable, which is the same finding from the other
direction.

⚠ **NOT the traversal stack.** `array<u32, 44>` looked like the classic
dynamically-indexed-local-array pathology and it is not: 44 → 16 → 8 moves nothing.
An earlier single-rep run said 16 and 8 were **2.4× SLOWER**, which was noise.

⚠ **EVERY REP NEEDS UNIQUE SOURCE TEXT.** The first isolated run read 28,087 ms
then 13 ms for the same file — the device answers a byte-identical module from its
in-process cache, so reps 2..N time the cache and the median of `[28087, 13]` is
meaningless. Fixed with a trailing `// rep N` comment, which changes the string and
not one instruction of the result. ⚠ And `about:blank` is not a secure context, so
the first version reported `no navigator.gpu` — which reads as "this machine has no
WebGPU" rather than "this page may not have it". It serves a blank page from
127.0.0.1 now.

##### The conclusion R18 has to absorb

Rolling that light loop is worth **~3.7 s of 11.8 s (31%)** on this kernel, and it
is worth doing. But **stubbing BOTH BVH descents entirely still leaves 6.9 s**, for
ONE kernel, in an empty page with nothing else competing. R18's budget is 1 s for
all of GI.

**So this kernel cannot be trimmed into the budget, and no further diet on it
should be attempted on the theory that it can.** The remaining candidates are
architectural, and each needs its own measurement before it is believed:

1. **Persistent compiled-pipeline cache.** §13.5 measured Chrome's own at 72× when
   it engages, and §13.10 measured it engaging 44× with TTFF unmoved — so "the
   cache works" and "the cache helps startup" are separate claims and the second
   one is currently false. Why is the open question.
2. **Boot on a cheaper ray-hit mode and upgrade in the background** (R1 ramp).
   `hybrid-exact-complex` is one rung of an existing ladder; if a lower rung
   compiles in ~1 s, GI is correct-but-coarse immediately and sharpens when the
   exact pipeline lands. This is the only candidate that reaches ≤1 s *by
   construction* rather than by hoping a compiler gets faster.
3. Fewer boot-time kernels — Phase 7's deletion sweep, whose value here is now
   measurable rather than assumed.

#### 13.14.5 THE SUM, MEASURED — IT IS ONE KERNEL, AND ITS COST IS FOUR COPIES OF ONE CALL

§13.3's "the per-pipeline number is LATENCY, not compile time" raises an obvious
possibility: if the driver compiles one at a time, startup is the SUM over every
pipeline and "the slowest" was never the target. `DUMP_ALL=<dir>` writes all 75
compute kernels; `probe:wgsl-compile` compiles the lot in one empty page:

```
  total isolated compile      39,264 ms   over 75 kernels
  slowest single              26,061 ms   66.4% of the total
  median kernel                   40 ms
```

**The sum hypothesis is REFUTED and the one-kernel finding is now quantitative.**
74 kernels together are 13.2 s; one is 26.1 s. And a kernel that compiles in 40 ms
alone appears in the boot list as `lat2586ms` — 65× its own cost, spent waiting
behind the monster, which is §13.3 confirmed from the other side and the reason
every "slowest pipeline" attribution in §13.13 pointed at whatever queued last.

(The editor's wave is ~99 s against 39 s of real compile work — a 2.5× overhead
from everything else the boot is doing. Worth its own measurement; not the lever.)

##### Where the 26 s comes from: `MAX_GI_LIGHTS` copies of a BVH descent

`srcShade.js:488` — `for (const slot of lights)`, a **JS** loop, so it unrolls at
graph-build time and each iteration inlines `visibility(...)`, i.e. a whole
2-nested-loop BVH8 descent. §13.14.4 measured those four inlinings at ~1.2 s each.

The scene has **one** light (`[gi] built … 1 lights (GPU)`). It emits **four**
descents anyway, because `makeLightSlots()` always builds `MAX_GI_LIGHTS = 4`
uniform slots and gates them on an `active` uniform at runtime. That is R11 done
correctly for *updates* — adding a light never recompiles — and it is why the
compile cost is fixed at four descents no matter what the scene contains.

The comment above the loop already names the fix and attributes it to Phase 5:

> *folding the light slots into the NEE set below collapses it to one ray for
> lights AND emitters together, which is what `lightTree.js` does*

`neeIrradiance` (same file, line 278) already does exactly this for emitters —
"Four predicated copies, so the one expensive thing below — the shadow ray — is
issued once and not once per emitter." The punctual lights simply do not go
through it yet.

##### The chosen design, and why not the cheaper one

Two ways to stop emitting four descents:

1. **Emit only as many light blocks as the scene has.** One line, ~3.7 s saved
   immediately. **Rejected: it violates R11** — the light count becomes part of
   the shader, so adding or removing a light triggers a rebuild, and a rebuild
   currently costs the very 26 s this is trying to remove. Trading a one-time
   boot cost for a per-edit one is a worse product.
2. **A uniform ARRAY of light slots plus a TSL `Loop`**, so the descent is inlined
   once and iterated at runtime, gated on `active` exactly as now. Keeps R11,
   costs the same at runtime, and is the shape `neeIrradiance` already uses.

**(2), scoped narrowly**: a compact array packed for the SRC hit shader only,
rather than re-laying-out `makeLightSlots` and every consumer of it
(`analyticDirectAt`, GISystem's direct term, the shadow marcher). Duplicating four
lights' worth of uniforms is free; a data-layout change across all consumers is
not, and it would put the shadow marcher — a kernel this is not trying to touch —
in the blast radius.

⚠ **DO NOT fold lights into the NEE *estimator* in the same change.** That
replaces four deterministic shadow rays with one stochastic sample: fewer rays,
higher variance, and §12.32.1 has the user reporting flicker already. Rolling the
loop is an emission change with byte-identical results; NEE folding is an
estimator change that needs its own energy A/B and its own flicker arm.

#### 13.14.6 ⚠ CORRECTION — §13.14.2 THROUGH §13.14.5 BISECTED A KERNEL THE USER NEVER COMPILES

The 77 kB / 4-loop / 204-if kernel that §13.14 named, §13.14.4 bisected and §13.14.5
attributed to `srcShade.js:488` is **the GI light-shadow marcher**. The tell was in
its own function list the whole time: `srcShadowWidthProbe`, which is built at
`GISystem.js:2457` (`analyticWidth ? volume.createWidthProbe() : null`) inside the
shadow marcher and nowhere else.

**The user's editor skips it.** Their boot logs `skipping 4 light-shadow pipelines
at warm-up — no light uses Shadow Source "gi", so they are never dispatched`. The
harness does not skip it, so every cold boot here was dominated by a shader that
does not exist in the build being complained about.

Consequences, stated plainly:

1. **§13.14.2's "REFUTED: it is not `bvhReflect`" IS NOT VALID.** That arm turned
   reflections off and observed the 77 kB kernel still present — but that kernel is
   the shadow marcher, which the flag does not touch and which masked whatever
   reflections cost behind it. The hypothesis is UNTESTED, not refuted.
2. **§13.14.4's bisection is sound as measurement and misattributed as cause.** The
   numbers (call-site cost ~1.2 s, stack depth irrelevant, 6.9 s floor) are real and
   reproducible; they describe the shadow marcher.
3. **§13.14.5's fix targets the wrong file.** Rolling `srcShade.js`'s light loop was
   verified by dumping the kernel before and after — **byte-identical, same md5** —
   which is exactly what a change to a file that does not build this shader looks
   like. The edit is kept (it removes four inlined descents from the kernel it *does*
   build, and `test:gi-src-shade` is green), but it is **unmeasured**, and the gate
   has zero coverage of the `lights` path (`grep -c "lights:" ` → 0).

##### What the user's editor actually says

```
[gi] bvh: exact reflections ON — 25 meshes, 262267 tris, DENSE (full-screen), hit-shaded
[gi] material GI buckets: 0 mirror, 0 specular, 27 diffuse-only, 0 dynamic-roughness (0/27)
[gi] skipping 4 light-shadow pipelines at warm-up
[gi] prewarm loop 1ms over 46 kernels
```

A full-screen exact-reflection BVH pass, in a scene with **zero materials in the
buckets that consume it** — and `#bvhReflectionsEnabled()` gates only on
`quality ∈ {high, ultra}` and `exactReflections`, never on whether a consumer
exists. That is the shadow-chain pattern verbatim, and §13.13.2 already recorded
that `bvhReflect` carries `giStaticBvh8`/`giDynBvh8`/`giFreeRadius…` — the same
function set, which is precisely why the fingerprint could not tell the two apart.

##### The methodological rule this earns

**A HARNESS THAT DOES NOT REPRODUCE THE USER'S GATES IS NOT MEASURING THE USER'S
BUILD.** `probe:gi-boot` must report which optional chains it compiled — shadow
marcher, reflections, hit shading — beside its timings, and any attribution must
name the gate state it was taken under. Three sessions of "which kernel is the slow
one" have now been answered three different ways, and every wrong answer came from
comparing across configurations that were never the same.

And: **"slowest single pipeline" must stop being quoted as a cost.** It is latency
(§13.3), it selects whatever queued last, and it is what pointed at the shadow
marcher here. The defensible statistic is the SUM of isolated compiles
(`DUMP_ALL` + `probe:wgsl-compile`), which is why that pair exists.
