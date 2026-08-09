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
| per-step `|Δd|`, mean / worst | 0.0040m / 0.248m | 0.0041m / 0.103m |
| **penumbra width vs truth** (mean) | **0.185** | 0.210 |
| penumbra closer to truth on | **524 rays** | 266 rays |

- **Smoothness — the one real risk — costs 0.99× the mean step and 2.4× the worst step.** Nil.
  The worst oracle jump is 0.248m (2 voxels), well inside the ladder's own predicted bound of
  0.5·voxel·2^L = 1.0m, which is checked so a violation would mean a mirror bug rather than a
  surprise.
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
