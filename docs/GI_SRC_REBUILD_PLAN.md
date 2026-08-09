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
leak rows, game perf, `profile.giPasses` on the real editor. The user's F5 is the acceptance
test. Flip `backend` default; old backend stays selectable one release.

**Phase 7 — Deletion + doc/memory sweep**
The §5 delete list; collapse rayHit ladder; retire deprecated props (mapped reads stay); update
`AGENTS.md`, `docs/`, memory. Expected net: **−8,000 to −12,000 lines.**

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
