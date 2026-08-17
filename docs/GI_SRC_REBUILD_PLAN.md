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
- R19. **Thousands of moving objects must run at full speed with GI on** (user requirement,
  2026-08-13: "we're making a game engine — thousands of objects might be moving"). What today
  violates it: the exact-mover set is a PER-RAY LINEAR LOOP (dynamicObjects.js `Loop(0..count)`,
  ~15 buffer reads + inverse transform + slab test per object per ray) — that is WHY the cap is
  16 (hard clamp 64 via `__giMaxDynamicObjects`), and overflow degrades to PER-FRAME
  RE-VOXELIZATION, which is both slow and reads as blocky flickering light. The rule splits into
  three obligations, cheapest first:
    (a) **Overflow must degrade to "no GI occlusion", never to per-frame re-voxelization** — a
        prop with no exact shadow is fine; a prop that flickers and costs CPU every frame is not.
    (b) **The exact-set budget must be spent by RELEVANCE, not arrival order** — the user's live
        scene holds 15 of 16 slots on objects that have NEVER moved (first-come adoption). Evict
        by recent-motion × screen coverage × emissive so the 16 that trace are the 16 that show.
    (c) **The scaling architecture is a TLAS over mover instances** — a per-frame refit BVH over
        adopted AABBs (leaves = analytic shapes or per-GEOMETRY BLAS, so 1,000 pooled projectiles
        share ONE mesh BVH + 1,000 instance transforms), replacing the linear loop with a
        descent. CPU refit of thousands of AABBs is ~ms and uploads one buffer; the per-ray cost
        becomes log-ish in N and zero when the ray's AABB path misses the mover set. Scale
        honesty: no engine gives thousands of movers individual exact GI occlusion — (c) raises
        the ceiling to hundreds-of-relevant, (a)+(b) make the tail free and invisible.

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

#### 13.14.7 THE GATE LADDER, MEASURED — AND THE KERNEL THAT SURVIVES ALL OF IT

`probe:gi-boot` prints GATE STATE first now (§13.14.6). With it, the optional
chains can finally be priced one variable at a time on one harness:

| shadow chain | exact reflections | SRC hit shading | TTFF |
|---|---|---|---|
| SKIPPED | **ON** | ON | 113,469 ms |
| SKIPPED | off | ON | 89,925 ms |
| SKIPPED | off | **off** | **54,314 ms** |

**Exact reflections ≈ 23 s. SRC hit shading ≈ 35 s.** The reflection half is
gated and shipped (§13.14.6). Hit shading is not — it changes what GI *looks*
like, so it needs a ramp rather than a gate.

⚠ **AND WITH ALL THREE OFF, THE 77 kB / 4-LOOP / 204-IF KERNEL IS STILL THERE**,
at 47,836 ms and 88% of a 54 s TTFF, across 74 compute pipelines. So it is none of
the three optional chains: it is a **core, always-built** kernel. Every earlier
attribution of it — shadow marcher (§13.13), `bvhReflect` (§13.13.2), the
`srcShade` light loop (§13.14.5) — is now excluded by direct measurement under a
printed gate state.

##### The remaining candidate, and why it fits

`state.queue[0]` is `screen.resolve.compute` (`GISystem.js:4658`) — the deferred GI
resolve, and the engine's own kernel list calls index 0 the 72 kB "composite". It
is built in every configuration because it *is* the GI output. `GISystem.js:4573`
gives **every light slot** its own `light.shadowTraceFn =
volume.createSoftShadowTrace(…, "giResolveShadowTrace")`, and `MAX_GI_LIGHTS = 4`.

That predicts exactly what the fingerprint shows — four inlined BVH descents in a
kernel nothing can switch off — and it explains why §13.14.5's fix did nothing:
**the mechanism was identified correctly and the file was not.** §13.14.4's
measurement (≈1.2 s of compile per inlined descent, stack depth irrelevant, a
~6.9 s floor) stands and now has a plausible owner.

**Not yet confirmed.** The confirmation is a binding-level match between the dumped
77 kB WGSL and the resolve's own buffers, or a `MAX_GI_LIGHTS = 1` arm. Given this
section's record — three wrong owners for one fingerprint — it is recorded as the
leading candidate and nothing is built on it until that arm runs.

##### And the resolve candidate is already weakened — read the outputs

Two facts, both free, both against it:

* **Sizes disagree.** The engine's own kernel list calls index 0 (the resolve /
  "composite") **72 kB**; the slow kernel is **77 kB**. In the user's boot both
  appear — `sizes 72/16/2/2/5/…` for the warmed set and `#48 … 77kB` outside it.
  They are different shaders.
* **The outputs are wrong for a resolve.** The 77 kB kernel declares
  `texture_storage_2d<rgba8unorm, write>` **twice** and one storage buffer, and
  dispatches `@workgroup_size(64,1,1)` — a 1-D dispatch over a list. A GI resolve
  writes HDR irradiance over a screen-shaped grid, not a pair of 8-bit textures
  over a 1-D index. Two LDR atlas writes plus an exact BVH trace plus the
  free-radius marcher reads as an **atlas bake**, not as the resolve.

So: recorded, and the resolve candidate goes back on the pile rather than into a
fix. The identification is now a bounded task — the tooling names outputs — and
the rule from §13.14.6 applies to it too: no fix until the owner is confirmed.

#### 13.14.8 TWO SETTLED NEGATIVES, THEN THE OWNER

**The DXC hypothesis is dead.** `probe:wgsl-compile` grew a `DAWN=<toggles>` env
(`--enable-dawn-features=…`) to test whether the minutes were FXC-vs-DXC — the
classic Windows explanation for loop-heavy shaders compiling pathologically.
Same kernel, same process shape: default **11.4 s**, `use_dxc` **12.3 s**. No
compiler-flag rescue exists; the cost is real work in whatever backend Chrome
already uses.

**The "reflections ≈ 23 s / hit shading ≈ 35 s" ladder (§13.14.7) is VOID.** The
90 s "shading ON" arm ran while the user's editor was compiling its own 133.6 s
wave — the same config re-measured on a quiet machine reads 52.5 s. The driver
queue is effectively machine-wide, so §13.3's rule ("the per-pipeline number is
latency") extends across PROCESSES: no boot-probe number taken while any other
WebGPU process is compiling is comparable to anything. The reflection consumer
gate (§13.14.6) remains correct — the pass compiles for nobody — but its measured
price on a quiet machine is TBD.

##### The owner, pinned by dispatch logic rather than fingerprint

The dumped kernel's tail is two `textureStore`s of FOUR SCALARS each — a
shadow-channel pair (filtered/raw or shadow/dist), not a resolve's color. Two
passes have that shape and the same estimator family: `createGiLightShadowPass`
and `createGiEmitterShadowPass`. The fingerprint cannot separate them — but the
dispatch logic can:

* the light-shadow chain is in `coldShadow` (§13.13) — never warmed, never
  dispatched with no gi-flagged light, so its pipeline is NEVER CREATED;
* the emitter chain is dispatch-skipped at runtime on 0-emitter scenes
  (`GISystem.js:1688`, shipped for a 0.119 ms filter cost) — **but it sits in
  `state.queue`, so the warm-up compiled it anyway.**

A pipeline that exists but is never frame-dispatched must have been created by
the warm-up: **the monster is the emitter shadow chain's trace kernel.** Four
`MAX_EMITTERS` slots, each with a full BVH8 any-hit descent + exact dynamic
trace + analytic width probe (the 2026-08-06 estimator unification), compiled at
capacity for a scene logging `0 emitters` — while the very next frame refuses to
dispatch it. §13.13's sentence recurs one twin over: the most expensive object
in the boot is a kernel that never runs.

Fix: the emitter chain joins the same `coldShadow` warm-up filter when
`_emitterInfos` is empty. The ramp costs nothing new — the moment an emitter
appears, the 1688 skip lifts, the first dispatch creates the pipeline
asynchronously, and frames keep flowing while it compiles. No rebuild involved.

Residual named honestly: a scene that GAINS its first emitter mid-game pays the
compile then (async, non-blocking, but emitter shadows are absent until it
lands). The follow-up that shrinks that window is rolling the 4-slot unroll into
a GPU loop — one descent instead of four — which §13.14.4's call-site bisection
already priced. Separate change, separate measurement.

#### 13.14.9 THE ANSWER: `#47 [lightShadowPass]`, DISPATCHED THROUGH A LEAK — AND WHY "PREVIOUS GI TOOK 2-3 s"

The naming instrument's first run ended the hunt: **`SLOWEST PIPELINE: #47
[lightShadowPass] took 43.8s`** (the user's editor: 133.6 s). The gi-traced
light-shadow trace — `MAX_GI_LIGHTS` slots × a full BVH8 any-hit descent + exact
dynamic trace + analytic width probe — compiled on every boot of every scene,
**for a feature enabled by flagging a light Shadow Source "gi", which nothing in
the scene had done.** The texture it writes is sampled only by gi-flagged lights.
It was, exactly, the §13.13 sentence again: the most expensive object in the boot
was a kernel that never runs — and §13.13 had already "skipped" this very chain,
which is why nobody looked at it again.

The falsifier: the warm-up skip removes it from the WARM list, and the frame
loop's `anyGiShadow` filter removes it from the MAIN dispatch — but the
occupancy-wait branch dispatched `rateQueue = state.queue` **unfiltered**, and
every boot takes that branch while pipelines are pending. First occ-wait frame →
full queue → pipeline created → the wave's drain waits 44-133 s for it. Fixed by
hoisting one skip set above every dispatch site (c68b1c1).

Verified cold with gate state printed: **75 → 71 pipelines, the 77 kB kernel
absent, compute wave 130,400 ms → 11 ms.** (That run's 97 s TTFF is 96 s of
material wave under cross-process contention — the user's live editor was
compiling beside the harness; the structural facts are load-independent.)

This also answers the user's question "why did the previous GI take 2-3 s":
the old backend never carried an always-compiled BVH8 estimator at light-slot
capacity. The 2026-08-06 estimator unification (static-bvh8 + exact-dynamics +
analytic-width, "up to 4 lights") made the light-shadow kernel a monster, and the
rateQueue leak made every scene pay it. The regression was the INTERACTION of an
upgrade and a leak, which is why neither's author saw it.

##### The five wrong owners, and the two rules that survive

shadow-marcher (§13.13, right pass, wrong dispatch story) → `bvhReflect`
(§13.13.2) → `srcShade`'s light loop (§13.14.5, byte-identical dump) → the
resolve (§13.14.7, un-weakened then re-weakened) → the emitter chain (§13.14.8,
gate shipped, monster stayed). All five died on one fact: **the estimator family
shares a WGSL fingerprint, so only a name recorded at the dispatch site
attributes anything.** Rule one: `giCurrentComputeNode` + `__giPassName` is now
the ONLY accepted attribution; fingerprints corroborate, never conclude. Rule
two: no boot number taken while any other WebGPU process is compiling is
comparable to anything (`[occupancy#4]` read 1.5 s and 30.5 s across two runs of
identical code).

##### What R18 still owes, by name

| item | measured | next lever |
|---|---|---|
| light-shadow chain at boot | **0 ms (eliminated)** | roll the 4-slot unroll so first-flag compile shrinks |
| emitter chain at boot | **0 ms (eliminated)** | same roll, same reason |
| exact reflections at boot | 0 ms without a consumer (d9fe69a) | — |
| material wave | 3.6-96 s, load-dominated | own session; §13.12's instability is now the top term |
| occupancy chain | ~1.5-6.3 s quiet | `[occupancy#4]` 154 kB, 324 ifs |
| SRC's 44 kernels | ~2 s summed isolated | fine |

A quiet-machine cold boot after this fix is the number the user's F5 will
report; the harness cannot produce it while their editor is open, and saying so
beats inventing one.

## 13.15 The material wave, measured — 27 same-bucket materials mint 26 distinct shaders

With the boot's compute side solved (§13.14.9), the wave is the top term:
3.6-4.8 s on the user's quiet machine, 9-96 s under contention. The probe now
groups render pipelines by fragment-source signature (`moduleOf` was reading the
VERTEX module — every material looked like 2 kB boilerplate and hid this):

```
36 render pipelines over 26 distinct fragment shaders (10 reuse an already-seen one)
sizes 24-27 kB   driver compile 0-191 ms each
material GI buckets: 0 mirror, 0 specular, 27 diffuse-only, 0 dynamic-roughness
```

Three facts fall out:

1. **The "180-250 kB fragment" era is over** — SRC-mode injection emits 24-27 kB.
   The wave's cost is not shader size and not the driver (0-191 ms/pipeline).
2. **The cost is 26 × main-thread JS** — node-graph build + WGSL codegen per
   material, 300-1000 ms each in the user's own `wave breakdown` line. That is
   what `compileAsync`-per-object measures once the pipeline promises are
   intercepted (the driver wait is hoisted out).
3. **27 materials in ONE bucket should compile to a HANDFUL of programs, not 26.**
   Factors ride uniforms and textures are bindings; only structure (has-map,
   alphaTest, vertex colors) should fork the text. Something per-material leaks
   into the WGSL. **Next step is mechanical: dump two same-size fragments and
   diff them.** If it is an inlined per-material literal, the fix is small and
   the wave collapses to ~a few codegens; the übermaterial is then a runtime
   draw-call feature, not a boot necessity.

The material-merge ladder, for when the diff answers (user request, Tiny
Glade-style): **T1** content-hash dedupe of identical imported material
instances (safe, automatic, also cuts per-frame binds); **T2** byte-identical
WGSL per structural family (the diff decides how); **T3** one übermaterial per
bucket — textures in `texture_2d_array`s (arrays, NOT atlases: layers keep
native UV repeat, which Sponza's tiling needs), per-instance material index,
factors in a storage buffer. T3 composes with the batcher and is a draw-call
win independent of boot time.

### 13.15.1 The diff verdict: nothing leaks by VALUE — three keys programs on node IDENTITY

`DUMP_RENDER` (one file per distinct fragment signature) + a normalizer that
canonicalizes the node-id families (`nodeVarN`/`nodeUniformN`/…) settles it in
three steps:

1. Raw same-family pairs differ by thousands of bytes — but normalized,
   sorted, and number-erased, a 419-line pair (`m12`/`m13`, the 17 kB Sponza
   map-only family) differs in **8 shape-lines**: two trailing commas (struct
   member order) and ONE temp-materialization choice (`a = u*x; b = c*a` vs
   `b = c*(u*x)`). Same math, same uniforms, same textures. **No value, factor,
   or texture parameter is inlined anywhere.** The leak is IDENTITY and ORDER:
   `Node.customCacheKey() → this.id` (r185 Node.js:472) plus emission order.
2. The in-page key probe (`run-material-key-probe.mjs`, reconstructing r185's
   `getMaterialCacheKey` walk WITH property names kept) shows the 26-member
   `MeshPhysicalNodeMaterial[map]` family: **26 distinct keys, and the ONLY
   differing component is `customProgramCacheKey`** — every walked property
   (texture mapping/filters/wraps included) is identical. Zero instancing
   involved.
3. The reason the materials carry per-instance nodes at all: every imported
   .mat is a shader graph, and `compileShaderGraph` mints fresh
   uniform/texture nodes per material (`makeUniform` per unwired input — even
   two identical constants-only materials never share).

Two fixes, both landed:

- **Stock-PBR expression** (`matchStockPbr` in tslGraph.js + `applyStockPbr`
  in materialAsset.js): the canonical import shapes — `texture→principledBsdf
  →output`, optional `texture→normalMap→normal`, constants elsewhere — are
  expressed as PLAIN material properties (map/normalMap/color/roughness/…)
  with NO `*Node` slots, so the material keeps three's stock program key.
  Conservative bail on anything else (wire-only props, swizzles, wired UVs,
  opacity≠1, ao≠1, non-black emissive — texture-fed emissive must stay on the
  graph path or it bypasses `resolveMaterialSurface`'s area-light guard).
  32/46 GAME .mats match, including all 24 Sponza. Wired-color pins the color
  factor to white (the graph path had no factor multiply). Textures load via
  the graph path's own cached loader (same SRGB default + .meta override) for
  pixel parity. Terrain unaffected (it compiles layer graphs itself via
  `compileMaterialGraph`); GI's `resolveMaterialSurface` reads props as its
  fallback and now sees graph-true values instead of stale def ones.
- **The saboteur the first measurement caught**: after the stock expression,
  the wave DIDN'T collapse (30→30 distinct). The key probe named it:
  `#markObservedMaterial` attached `giMonitorNode = float(0)` — a FRESH node
  per material — and `_getNodeChildren()` walks ANY own `.isNode` property, so
  the marker's instance id re-forked every key. The very override installed
  five lines below documents "still letting same-bucket materials share one
  build" — defeated by its own marker since the day it shipped. Fix: ONE
  shared marker instance (`GISystem._giMonitorMarker ??= float(0)`); the
  observer only needs `.isNode` to exist, and the roughness-bucket suffix in
  the key keeps mirror/diffuse variants separate as designed.

### 13.15.2 Measured: 26 material program keys → 3, the wave 53-95 s (contended) → 1.7 s

The key probe after both fixes, live scene:

```
MeshPhysicalNodeMaterial[map]            members 14   DISTINCT KEYS 1
MeshPhysicalNodeMaterial[map+normalMap]  members 12   DISTINCT KEYS 2   (side: 0 vs 2 — front vs double-sided, a REAL program fork)
```

26 imported materials → 3 program keys. The boot probe, same machine state
(driver so contended the compute queue showed 30 s latencies — the state that
previously produced 53-95 s material waves):

```
material compile wave        1656 ms
render pipelines             33, driver 241 ms summed
idle between compiles        53% → 14% of the compile span
```

The remaining distinct render fragments (28) are per-family × per-CONTEXT
variants — the live base-light render, the wave's GI-light variant, the
postprocess MRT variant — plus the graph-path stragglers (the two dragonkin
multiply-chain materials, Floor.mat's legacy-props BSDF, emissives, volumes)
and editor UI. Per-material minting is gone; a family's sig set no longer
scales with material count.

Found along the way, not yet fixed: **Floor.mat carries legacy prop names**
(`baseColor`/`specular`/`sheenTint`/`alpha`…) and its stray numeric values on
wire-only channels (`sheen: 0`, `clearcoat: 0`) compile to LIVE uniform nodes
— the floor renders through sheen+clearcoat lighting paths for zero visual
effect. The matcher correctly bails (preserves behavior); a def migration
would both fix the material and let it stock-express.

### 12.37 SRC GOES DEFAULT-ON, AND THE EMITTER SLOTS REACH THE SOCKET — "EMISSIVES DO NOT WORK" WAS A CONFIG CONSTANT

User, 2026-08-11: "enable the SRC GI by default so I don't have to enable it via
console flags every time. Also, notice that light flickers and emissives do not
work currently." This section is the first two; the flicker is §12.32's
standing verdict and gets its own unit.

#### 12.37.1 The default flip

`srcProbesEnabled()` is now `__giSrcProbes !== false`. The Phase 1–4 rationale
for off-by-default — the population produced no light, so it was pure cost —
died with Phase 5: SRC is the ONLY diffuse-indirect term this module has, so
off-by-default meant every project shipped with no bounce unless someone typed
a console flag before boot. `__giSrcProbes = false` is the explicit opt-out
(R12), and it is load-bearing for four harnesses whose numbers or meanings were
recorded against the legacy-only chain:

- `gi-gpu-smoke.html` non-src arms now PIN false (they mean "the legacy screen
  chain in isolation" — that is what their assertions were written against).
- `run-gi-emitter-shadow-probe.mjs` pins false: its exact-match numbers
  (`penumbraPx=16601 grain=0.0307`) would otherwise gain SRC's diffuse term in
  the same luminance readback.
- `run-gi-flicker-frame.mjs` pins false unless `SRC=1`, because the SRC arm
  also sets the sky the instrument needs — "SRC by default without the sky"
  is exactly the §12.23 flawless-absence-of-flicker trap.
- `run-gi-boot-probe.mjs` is three-state (`SRC=1`/`SRC=0`/unset = shipping
  default), so its headline TTFF keeps measuring what a user actually boots.
  Any comparison against pre-flip numbers must set `SRC=0`.

#### 12.37.2 "Emissives do not work" — the whole feature hung off `emissiveShadows: false`

The live editor said it plainly: the SRC boot line read **"SHADING (4 lights,
0 emitters"**. `GISystem` only creates the MAX_EMITTERS uniform slots when
`props.emissiveShadows !== false`, and giConfig's CONSTANT table said `false`
for every tier — so `srcSystem` got `emitters: []`, and `createSrcHitShader`
compiles NEE out at BUILD time (`useNee = emitters.length > 0`). The name
undersells the flag: it gates the slots, the per-frame promotion, the analytic
receiver-direct term AND the NEE set. Per R5 (§12.29) the promotion set IS the
NEE set and the analytic-direct set — bake-time zeroing hands a promoted
emitter's energy to exactly those two consumers — so with the slots absent, a
promoted emitter's light would be deleted from BOTH paths. Worse for the
user's actual game: session 38's sub-voxel projectiles are ANALYTIC-ONLY
(no voxel placement, no surface record), so the slots are their ONLY
representation — with `emissiveShadows: false` they are invisible to lighting
entirely, which is precisely "emissives do not work".

`emissiveShadows: true` in CONSTANT now. What OFF used to buy is still bought
elsewhere: with zero PROMOTED emitters the warm-up skips the emitter-shadow
chain and the per-frame "CAPABILITY IS NOT USE" checks drop the trace and its
bilateral — a scene with no emissive meshes pays uniforms, not passes.
`__giConfigOverride = { emissiveShadows: false }` is the hatch.

#### 12.37.3 The end-to-end gate, and the assertion that had R5 backwards

`probe:gi-src-emissive` (new, `run-gi-src-emissive-probe.mjs`): boots the
generated Cornell project (emissive cube, NO other light) with **no flags at
all**, reads the MECHANISM through the engine object before any pixel (socket
slot count, promoted count — gi-harness-viewport-traps' rule), then measures
wall patches, then reruns with the opt-out override. All PASS:

```
defaults: srcBuilt=true shading={lights:4, emitters:4, attributed:true} promoted=1
          walls lit by the cube alone, mean 0.1292
optout:   shading.emitters=0 promoted=0 — the override flows
R5 live:  defaults 0.1292 vs optout 0.1605 wall energy — 19.5% apart
```

⚠ **The first version of the last check asserted the two arms DIFFER by >10%,
which is asserting R5 is broken.** Promoted (analytic direct + NEE, emission
zeroed at hits) and unpromoted (emission on the ray path) are two
representations of ONE light, calibrated to agree (§12.26.7: 1.45% worst at a
shading point). The model SWITCH is proven by the mechanism readout; the
pixels owe us AGREEMENT — asserted at <25%, the slack being the soft path's
one-sided-bright leak at coarse probe spacing (§12.26.9) plus run noise.

Other gates re-run at the flip: `test:gi-src-ref` (124) PASS,
`test:gi-src-shade` (36, incl. R5 zeroing + real-slot-shaped emitter terms)
PASS, `smoke:gi-gpu` all four arms PASS (non-src arms log "SRC compiled out",
src arms hold the π·sky ceiling and the 8-storage-buffer audit).

Also retired quietly: `run-gi-emissive.mjs`'s arms set the `emissiveShadows`
COMPONENT PROP, which the one-property collapse turned into a no-op — its
off/on arms have measured the same configuration since then. The new probe
uses `__giConfigOverride`, which is the only remaining way to force the value.

### 12.38 THE FLICKER IS VARIANCE, AND α BECOMES A FUNCTION OF SCENE MOTION

User ask 2 of 3 (2026-08-11): "notice that light flickers." §12.32 had already
established the stride is NOT the source (per-refresh instability is nearly
stride-invariant, and the STILL control out-flickers the moving arm), and its
frequency-band reframing pointed at Phase 6's re-pricing as the fix. Before
building a scheduler, this unit asked the cheaper question first: what IS the
still-scene instability?

#### 12.38.1 The suspicion, and why the schedule survived

The §12.32.1 story ("stride moves each pixel's refresh into the eye's 5–15 Hz
band") quietly assumes a pixel's VALUE refreshes when its own rays fire. It
does not: a pixel reads its probe's accumulators through a 4.5-probe gather,
and a typical Sponza c0 probe covers ~55 gbuffer pixels whose linear indices
span every stride residue class — so the accumulators of a well-covered probe
receive evidence EVERY frame at any shipping stride. Only small-footprint
probes (silhouettes, grazing surfaces) skip frames. The stride was convicted
on a mechanism most probes don't have; what §12.32 measured as "+35% per
refresh, small" is what it was.

The alternative suspect: **Phase 5 multiplied per-ray variance.** §12.23 tuned
α = 0.1 against transmittance-only deposits — every deposit 0 or 1, variance
bounded. Hit shading made a deposit's radiance depend on a binary sun-shadow
ray and a one-sample NEE draw, at ~0.7 rays/bin/frame — and nobody re-measured
α after the estimator under it changed.

#### 12.38.2 ALPHA_SWEEP — and the settle arm that saved it from itself

`run-gi-flicker-frame.mjs` grew `ALPHA_SWEEP="0.1,0.05,0.02"`: still + moving
arms per α, interleaved ×2 with round 2 walking the list in reverse, all in ONE
page (`__giSrcAlpha` is polled per frame — the same property that made the
ceiling A/B possible).

⚠ **THE FIRST SWEEP MEASURED THE ACCUMULATOR'S OWN RE-EQUILIBRATION AND CALLED
IT FLICKER.** After an α switch the sums converge over ~1/α refreshes — ~150
frames at α = 0.02 and stride 3, five times `body()`'s 30-frame warmup. The
α = 0.02 row read a step p95 of **26 luminance units** with a 7.7× round
spread; the α = 0.05 rows agreed at 6% only because 1/α fit inside the warmup
there. One full discarded measure (240 frames) after every switch fixed it —
and the fixed rows agree across rounds at 3–9%:

```
α        still rev/px   still p95   moving rev/px   moving p95
0.1      4.32           0.25        4.48            0.49
0.05     1.15  (÷3.75)  0.61        1.64            0.67
0.02     0.40  (÷10.9)  0.82        0.92            0.63
```

**The still-scene shimmer falls monotonically with α — it is MONTE CARLO
VARIANCE, and α is the lever.** The rising per-change p95 is a selection
effect: at low α most changes drop below the instrument's 0.002 threshold, and
the counted set shrinks toward the sparse structural events α cannot touch —
§12.24's bin-membership floor, a separate and already-named debt. The moving
arms get calmer too (4.48 → 1.64 rev/px at 0.05) at a modest +35% step p95.

#### 12.38.3 The fix: velocity-scaled α, on the shadow chain's own precedent

Flat 0.05 would double every convergence lag; flat 0.02 would put a light
toggle at ~2.5 s. The light-shadow chain already solved this exact tension —
"VELOCITY-SCALED MEMORY", whose comment records why a flush-on-change and a
binary moved/still split both failed a script-driven sun — so SRC's α takes
the same shape:

    α = ALPHA_STILL + m · (TEMPORAL_ALPHA − ALPHA_STILL),   m ∈ [0,1]

- `TEMPORAL_ALPHA_STILL = 0.05` (srcConfig, with the sweep table in its
  docstring); `TEMPORAL_ALPHA = 0.1` unchanged — a fully-moving scene runs at
  exactly the α every §12 measurement used.
- `m` = max of three normalized sources, each computed once per frame by
  machinery that already existed: the light-motion loop (HOISTED out of the
  shadow-pass gate — one computation, because the WeakMap prev is consumed by
  the delta and a second loop would read zeros forever), the emitter slots'
  own decayed `moved` retains, and the mover set's largest per-frame
  displacement (translation + basis-column delta × half-extent, so a box
  spinning in place — §12.24's named worst case — registers).
- **The camera is deliberately NOT a source.** Probe evidence is
  world-anchored; a camera move changes which probes are visible, not what
  they know. Charging the still scene for looking around would forfeit the
  3.75× for nothing.
- All CPU: `readAlpha()` was already polled per frame and already feeds the
  §12.32 stride-root (`keep = (1−α)^(1/S)`), so the adaptive value composes
  with the ceiling with no kernel or uniform changes. `__giSrcAlpha` outranks
  the ramp (R12) — the sweep itself depends on that. A standalone gate that
  passes no `sceneMotion` gets flat TEMPORAL_ALPHA: every pre-existing gate
  measures exactly what it measured before (`test:gi-src-temporal` re-run
  green).
- Known blind spot, stated: INTENSITY changes are invisible to all three
  sources (the light loop reads matrices only), so a lamp toggling in a still
  scene converges at the 0.05 floor — ~1 s. That is the argument for 0.05
  over 0.02; an intensity-delta joining the signal is what unlocks the
  remaining 2.9×.

#### 12.38.4 Verified — the ramp lands where it predicts, in one page

Re-run with the ADAPTIVE default as the base arms and pinned `__giSrcAlpha`
rows as in-page references (the pinned rows also prove the hatch still
outranks the ramp):

```
pinned 0.1:   still 4.42 rev/px    moving 4.60      (matches the sweep: 4.32/4.48)
pinned 0.05:  still 1.20           moving 1.68      (matches: 1.15/1.64; fall 3.69×)
ADAPTIVE:     still 1.49           moving 2.29
```

The adaptive still arm sits at the 0.05 floor (its +0.3 over the pinned row is
the moving→still transition tail — the base arms have no discarded settle arm
between them). The adaptive moving arm lands BETWEEN the pinned rows exactly
as the ramp predicts for a ~13 mm/frame mover (m ≈ 0.24 → α ≈ 0.062). Against
the old flat 0.1, the shipped behaviour is **~3× calmer still and ~2× calmer
even while moving**.

`eyecheck:gi-src` after the change: shading gain 4.696×, shadow cost 0.243×,
footgun 1.083×, toggle path 1.018× — all in band, nave pose renders correctly.
`test:gi-src-temporal` green (it pins its own α; standalone gates get flat
TEMPORAL_ALPHA by construction).

Still open after this unit, in flicker terms: the STRUCTURAL residue (§12.24's
bin-membership floor — the sparse pops that dominate the counted set at low
α), and §12.32's option (1) transport re-pricing, which is now a PERF unit
rather than a flicker unit.

### 12.39 [J] THE MULTIBOUNCE — THE PRIMARY ATLAS IS THE CACHE, AND THE INLINE VERSION COST 48 SECONDS OF COMPILE

Phase 5's last open unit. §4.1's [J] prescribed "steps B–H re-run over last
frame's hit points (2 LODs coarser)"; what landed is smaller and, on §12.26.9's
own numbers, more accurate — and its first wiring re-taught §13.14's compile
lesson at the user's expense within the hour.

#### 12.39.1 No second cache — the tile atlas already is one

`shadeHit`'s `secondary` socket is `gatherAt(P, n)` over the PRIMARY tile
atlas. Three facts make that the right cache:
- The atlas is re-baked AFTER the deposit each frame, so a hit samples LAST
  frame's irradiance — a temporal fixed-point iteration, which is R4's model,
  not the within-frame closure §12.26 forbade (that warning was about the
  mirror's single-frame `runSrcFrame`).
- §12.26.9 measured the SAME-SPACING cache as the least-leaky row of its table
  (coarsening BRIGHTENS — the trilinear near-geometry leak scales with probe
  spacing, one-sided, inside the loop). "2 LODs coarser" was a COST choice
  from before [H] existed; the primary lattice is the accuracy choice.
- `clampLoopAlbedo` was already applied at the hit "so turning [J] on later
  must not change what one bounce looks like" — the ceiling was waiting for
  its loop.

Two structural changes carry it:
- **The hash→block words moved into `hashKeys`' TAIL** (`hashBlockBase`), so
  the key→block lookup costs ONE storage buffer. The deposit kernel is at 7 of
  the portable 8 in both ray-hit modes (measured by the smoke's new ≥6
  storage report), so the old two-buffer lookup did not fit it at all. One
  buffer, one atomic node, atomic ops throughout — the store's own fold
  pattern, not the rejected atomic/non-atomic aliasing. `test:gi-src-gather`
  and `test:gi-src-tiles` re-run green through the folded lookup (borders
  still bit-exact).
- **`hashBlockFrame.pass` MOVED to directly after the population**, and the
  move is correctness: [K] rebuilds the hash every frame with
  scheduler-dependent contention, so a key's SLOT does not survive the
  rebuild — a tail written at the END of last frame is misaligned with THIS
  frame's keys, and a consumer would read the wrong probe's block with no
  error anywhere (the §12.31 cross-probe shape). After compaction both of the
  pass's inputs are settled and neither changes within the frame, so the
  gather far below reads the same truth it always did.

First pictures: the Cornell probe now shows red/green bleed on the white
blocks — the picture §12.22.5 said a bounce-less build could not draw — and
the smoke's exact-complex arm's tiles rose 0.3992 → 0.4478 peak irradiance
(the deeper bounces accumulating) with the π·sky ceiling still exact on the
no-shading sky arm.

#### 12.39.2 ⚠⚠ THE INLINE WIRING PUT 48 SECONDS INTO THE DEPOSIT'S PIPELINE COMPILE

`gatherAt` inlined into the hit shader — 16 hash-find LOOPS and 16 filtered
tile taps at the shading site — took the deposit kernel from 58 kB / 2 loops
to **323 kB / 3 loops / 642 ifs**, and the user's editor measured the
pipeline compile at **48.1 s** (`#32 [src#30]`, their own boot log) inside a
46 s compute wave. That is §13.14's unroll pathology re-created by hand: the
WGSL cost of a kernel is not its runtime cost, and a loop-bearing helper
inlined into the fattest kernel in the module multiplies compile time, not
frame time. The runtime cost was fine — the COMPILE cost is disqualifying
(R18 is a 1 s budget, and every quality toggle pays it again).

**So [J] is OPT-IN (`__giSrcSecondary = true`) until it is a SEPARATE PASS**
— which is what §4.1's own line prescribed all along: "re-run over last
frame's HIT POINTS". The shape for the next unit: the deposit records compact
hit points; a small dedicated kernel (the gather compiles ONCE, ~20 kB, like
the screen gather's own pass) shades the secondary term and adds it into the
bins. Everything landed here — the fold, the pass order, the socket, the R4
gate — is what that pass plugs into.

`test:gi-src-secondary` (`run-gi-src-secondary-probe.mjs`) is the R4 gate
either way: closed Cornell box, the bounce arm opted in from boot, tail
contraction asserted on the ROUND INCREMENTS (§12.26's lesson — a power
iteration overshoots early, so only the tail is a contraction claim), the
fixed point bounded between +8% over the single-bounce arm and R4's ×10 hard
ceiling, and the boot line's MULTIBOUNCE/single-bounce wording asserted
against the BUILT system.

#### 12.39.3 The user's live ladder, profiled in the same breath as the pose

`profile.giPasses` + `viewport.getCamera` on their editor (§12.35's named next
step), quality high, camera inside the nave at (7.6, 1.3, −1.1):

```
SRC chain 26.6 ms of which deposit 21.2 (worst pass 17.4) — gather 2.0,
populate 1.0, tiles 1.0, merge 0.8, rays 0.5; screen passes 0.3.
126,008 rays at stride 5 ⇒ ~138 ns/ray INSIDE the nave.
```

Their fps ladder (ultra 15–20, high 35–40, medium 60, low 80–90) attributes
cleanly to the deposit's marching cost — and 138 ns/ray against the harness's
13–14 confirms §12.35's finding that per-ray cost is a property of ENCLOSURE:
the pinned harness pose is cheap, their inside-the-nave pose is not. The
transport re-pricing (§12.32 option 1, rays ∝ probes not pixels) is now the
top open unit by user priority, with the ns/ray content-dependence measured
here as its second axis.

One diagnostic caveat from the same profile: it reported `shadedHitsPerFrame:
0` while the boot line says SHADING and the frame visibly carries bounce —
the profiler suspends rendering to measure, and the stat words it reads are
per-frame cleared, so a suspended-frame readback can catch them empty. The
counter needs a read-before-clear or the note will cry wolf. Logged, not yet
fixed.

#### 12.39.4 The R4 gate, hardened by its own first failure — and green

The first run of `test:gi-src-secondary` read 0.0000 on every round of BOTH
arms and reported "the loop adds no energy": it had measured its eight rounds
INSIDE the bounce arm's 48 s pipeline compile, with no field-ready wait and no
stability polling — the instrument-not-looking family the harness-traps memory
exists for. Hardened (per-arm `[gi] field ready` wait, rounds polled to a 2%
tail over a 150 s ceiling, and a BOTH-ARMS-BLACK result is a named instrument
fault rather than a loop verdict), it passes:

```
multibounce  tail increments 0.0003 → 0.0003 → 0.0004 (noise floor 0.0031)
energy       0.1541 vs single 0.1365  (+12.8% in a closed box)
R4           1.13× — inside the 1/(1−0.9) = 10× hard ceiling
telemetry    boot line says MULTIBOUNCE opted-in, single bounce opted-out
```

Smoke re-run at the shipping default: both src arms green, the exact arm's
tiles back at single-bounce energy (0.41), the brick-box arm at zero. The
loop exists, converges, is bounded, and costs nothing until asked for.

### 12.40 THE PER-PROBE RAY CAP — §12.32.1's OPTION (1), DELIVERED THROUGH THE
### EXISTING MACHINERY, AND THE HISTOGRAM THAT SIZED IT FIRST

Phase 6's first unit, promoted to the top by the user's report ("performance
is very poor … must have been faster than the previous"). §12.32.1 named the
fix — price the transport in PROBES, not screen pixels — and the temptation
was to rebuild the transport around it (ray-major dispatch, reservoir
origins, a new allocation). What landed is ~40 lines inside Alg. 3, because
the measurement that was supposed to justify the rebuild justified something
much smaller instead.

#### 12.40.1 Measure before designing: the membership histogram

`SWEEP=histo` (new, `probe:gi-src-cost`) reads `PROBE_RAYS` off the live
probe table for a few frames — each frame is one stride phase — before any
design decision. Sponza, high, the pinned nave pose:

```
2,432 live c0 probes, 126,381 rays/frame (the boot line's traced count ÷1)
per-probe rays/frame:  p10 0   p50 8   p90 137   p99 763   max 1,794
```

The MEDIAN probe fires 8 rays a frame; the fattest fires 1,794. The
distance-adaptive lattice (§12.29) does NOT flatten screen coverage — a wall
filling the viewport still concentrates hundreds of rays on bins that
converged long ago, which is §12.32.1's "553 rays per probe" scandal
surviving the ray ceiling in miniature. Capping each c0 probe at B:

```
cap B    Σ min(count, B)   probes AT the cap
  8         0.105×             41%
 16         0.171×             28%
 32         0.261×             19%
```

Two design facts fall out, and the first one KILLED the rebuild: at the
knee, most saved rays come from a few hundred probes — so a CAP on the
existing pixel-priced counts captures ~80–90% of what full probe-pricing
could ever capture, without touching the dispatch shape, the origins, or the
allocator. And a capped probe still receives B fresh rays EVERY frame (its
members span the stride's residue classes), so the cap converts the fat tail
to uniform per-frame refresh — rays ∝ probes exactly where membership is
high, which is what option (1) meant.

#### 12.40.2 What landed: a clamp, a denial, and one uniform

- **[D1'] clamps at the source** (`srcRays.js`): after [D1] counts, a pass
  over c0 stores `min(count, cap)`. [D2] then propagates capped sums, [D3]/
  [D4] partition capped sums, [D5] hands out capped segments — one clamp,
  four consumers, no second definition of the budget anywhere.
- **[D5] denies whole slices**: a claim past the probe's (capped) segment
  writes SLOT_EMPTY instead of a base. The cap is floored to a multiple of
  `raysPerPixel` (`srcProbeRayCap`), so `off < end` and `off + rpp ≤ end`
  are the same statement and the winners tile the capped segment EXACTLY —
  the coverage gate's "every index claimed once" survives capping intact.
  The deposit's [E] needed NOTHING: a denied pixel's SLOT_EMPTY base is the
  same early-return an empty-probe pixel always took.
- **The cap is a POLLED UNIFORM** (`__giSrcProbeRayCap` — positive caps
  live, 0/unset is OFF; tiers ship NO default, §12.40.4 is why). Same rule
  as the ceiling and α, same reason: every A/B in one page, no rebuild.
  Scheduler order picks WHICH members win each frame, so origins rotate
  over the probe's footprint for free. (The first tier values — 8/16/16/32,
  chosen per-bin — lasted exactly as long as it took the flicker rig to
  price them; the model error is written down in §12.40.4.)
- The mirror (`assignRays`) clamps and denies identically; winners differ by
  order (pixel order vs scheduler order), so gates compare counts, totals
  and claimed-slot sets, never who claimed them.

`test:gi-src-rays` ARM 8 (new): capped counts match the mirror BY KEY on all
four cascades (parents hold sums of capped children — a clamp applied after
propagation would pass c0 and fail c1), totals match, the permutation holds
under denial (0 duplicates / 0 out of range / 0 unclaimed of 8,714), winners
are exactly count/rpp on every probe, 330 denials balanced. All PASS; the
uncapped arms are bit-identical to before (no cap → no clamp pass built).

Live confirmation at the shipping default: the settled per-frame line reads
**21,520 hits shaded under cap 16 vs 126,382 uncapped** on the same
scene/pose — a 5.87× ray cut, within 0.5% of the histogram's Σ min
prediction (21,615).

#### 12.40.3 ⚠ THE CAP BROKE `profile.giPasses`, BECAUSE THE PROFILER WAS
#### TIMING GARBAGE ALL ALONG

The first cap sweep read `deposit 0.68 ms, 0 rays fired` on every arm —
against a live frame provably shading 21,520 hits. The op timed each pass in
ISOLATION, K reps each: [D1]'s counts inflate K× (the clear is a different
pass), [D3]'s partition marches K× past the buffer, and [D5] hands the
deposit garbage offsets. **The old numbers survived by luck** — a deposit
tracing from garbage offsets costs the same as one tracing from real ones,
so every deposit figure in §12.31–§12.36 was timed on corrupted state that
happened not to matter. The cap's denial ended the luck: against inflated
state every claim is out of segment, so [E] timed an EMPTY dispatch. An
instrument that breaks when the code gets safer is mis-built.

Fixed rep-major: each rep dispatches the whole SRC chain in frame order
(uniforms don't advance — the same frame re-run), per-pass timestamps
accumulate across reps, attribution unchanged, reps capped at 8. Two
artifacts die at once: the deposit now times real work under any cap, and
`readStats` afterwards reads a REAL frame's tallies — which also closes
§12.39.3's `shadedHitsPerFrame: 0`, whose second layer was a wrong path in
the relay (`stats.shaded` for `stats.rays.shaded`, an `undefined ?? 0`
wearing an empty readback's costume — fixed in the same commit).

Instrument guards that earned their lines: the cap sweep refuses its own
verdict when an arm reports 0 shaded hits (it did, and said so); the histo
and every non-cap sweep PIN the cap off — a capped histogram of
min(count, B) reads as "the skew is gone" when what is gone is the
instrument, and ns/ray divided by the boot line's now-upper-bound would
underreport by exactly the savings under test.

Second casualty, found by the fix's own first output (negative chain
totals): `info.compute.timestamp` is ASSIGNED per resolve — the batch just
resolved, not a running total — so the op's before/after subtraction was
computing `thisBatch − prevBatch` everywhere. For K same-pass dispatches
behind a 1-dispatch warm batch that is a clean-looking **−1/K bias**, and
the new unbiased instrument confirms it arithmetically: the biased reading
was 2.571 ms where the unbiased one reads 2.99 — a ratio of 0.860 against
(K−1)/K = 0.857 at the probe's K=7. Every deposit millisecond in
§12.31–§12.36 is uniformly ~14% low; every RATIO in those tables stands.
`resolveTimestampsAsync`'s return value is the batch duration, and both
timing paths now use it directly.

#### 12.40.4 The flicker price, measured — and the cap ships OPT-IN

The cost sweep's in-page arms (fired counts kernel-tallied; the harness pose
is floor-dominated so ns/ray does not transfer, the CUT does):

```
cap      fired rays      deposit ms
off        126,382          2.99          least squares vs the capped arms:
 32         32,996*         2.58            ≈ 1.7 ms floor + ~10 ns × rays
 16         21,706*         1.85            (harness pose; the user's editor
  8         13,318*         2.17             measured 138 ns/ray in-nave)
      * pose-matched run; every arm within 0.6% of the histogram's Σ min
```

On the user's own profile (21.2 ms deposit, 126,008 rays at 138 ns/ray),
cap 16's 5.8× cut is worth ~14 ms of the deposit and roughly halves the SRC
chain — the fps ladder's fix, sized. Δ screen mean across arms sat inside
the sweep's own noise (−7.5/−0.7/+1.0%, non-monotonic; one run's camera
never reached the nave and is recorded as a pose fault, not data).

**And the flicker rig said no — at every value tried.** CAP arms (new,
`CAP_AB=1 CAP_VALUE=n`, still arms interleaved ×2, full discarded settle
after every switch):

```
                      still rev/px          vs off      rig noise floor
high,  cap 16      6.051 vs 2.356           2.57×            0.451
ultra, cap 16      4.952 vs 1.620           3.06×            0.049
ultra, cap 32      2.889 vs 1.620           1.78×         (in-run control)
```

Step p95 is UNCHANGED (+7% at high) — the steps are the same size, there
are 2.5× more of them. The regression tracks **√(ray cut)**, which is what
variance arithmetic predicts when the cut lands on the near-field,
screen-filling probes: a 700-ray probe capped to 16 loses 44× its evidence
stream exactly where one probe's noise covers the most pixels. The per-bin
framing that chose the tier values (0.5 rays·bin⁻¹·frame⁻¹ ≥ the median
probe's rate) was the wrong model — the median probe's noise is spread over
a few pixels; the capped probe's is not.

At the current α floor there is NO cap value with a meaningful cut inside
§12.38's band, and "light is still popping" is the user's own open item —
so no tier ships a default cap. The mechanism, the gates, the sweeps and
the rig arms all stay (`__giSrcProbeRayCap = 32` is live in any page,
in-page A/B, no rebuild), because they are the harness the unlock needs:

**Next unit: per-probe α compensation.** A capped probe keeps
proportionally more history — `keep′` chosen so influx/(1−keep′) is held
constant — making the cap variance-NEUTRAL by construction and paid in
responsiveness only where evidence was cut (the motion-adaptive α already
covers the moving case; the still case's lag bound is the lamp-toggle blind
spot §12.38.3 already carries). That needs a per-block influx word and its
own gates; it is the difference between this cap being a measurement lever
and being the fps fix the user asked for.

Verification of the shipped (cap-off) defaults: the rays gate's uncapped
arms are byte-identical and green; the live editor page fires and shades
exactly `natural/stride` (126,382) with the hatch unset; the rig's off arms
sit in §12.38's band. `eyecheck:gi-src` WITHHELD twice on its own
coverage guard — the editor viewport settled at three different sizes
across its per-arm pages (78,988/315,952/499,720 px), the §12.30.4
instability again; its header's "pin the viewport before the GI module
builds" hardening is now a named harness errand, and the withhold is the
guard working, not a regression signal.

### 12.41 THE α SIGNAL LEARNS TO SEE A LAMP — §12.38.3's BLIND SPOT, CLOSED

The user hit the documented blind spot in as many words ("temporal is way
too slow, making light too slow to change"): the motion signal read light
MATRICES, emitter retains and mover displacement, so an intensity or color
change registered as a perfectly still scene and converged at the 0.05
floor. Now the hoisted light loop tracks each light's emitted luminance
(intensity × color luma) beside its matrix, and the RELATIVE per-frame
delta joins `sceneMotion` under the same saturation constant — a one-frame
toggle saturates the ramp outright, a fade holds it up for its duration,
sub-0.1%/frame flicker stays under the floor.

Two deliberate boundaries: the luminance term is a SEPARATE track
(`_giLightLumMotion`) because `_giShadowLastMotion` also drives the GI
shadow pass's temporal weights and the shadow factor is pure visibility —
a fade must shorten radiance memory, never shadow memory. And the α the
frame actually uses is now published (`__giSrcAlphaLive`, one number write
in `syncCamera`) because the ramp was UNGATEABLE end to end before — §12.38
was verified only through downstream flicker statistics, and this fix
would otherwise have shipped on faith.

`run-gi-src-alpha-signal-probe.mjs` (`probe:gi-src-alpha`) gates it on the
Cornell project with a probe-owned point light: still max α 0.0500 over 60
frames, one `setProp` halving intensity spikes the same frame's α to
0.1000 (the sampler starts BEFORE the setProp — the spike is transient and
a loop started after the await can miss it), and 3 s later it is back at
0.0500. All three arms exact.

### 12.42 PER-BLOCK α COMPENSATION — THE CAP'S UNLOCK, BUILT AND GATED

§12.40.4 priced the cap's flicker at √(ray cut) and named the unlock:
hold `influx/(1−keep′)` — the accumulator's effective sample count — at its
UNCAPPED value, per block, so the cap stops buying variance with its ray
cut. That is now in, riding the machinery the cap already built.

#### 12.42.1 The mechanism, in the order the frame runs it

- **[D1'] saves the natural count** into `rayCursor` before clamping —
  the cursor is dead storage between [D0] and [D3], and after the clamp
  the natural value exists nowhere else. Under a cap [D0] clears the
  cursor (parents need a zero accumulator); uncapped it stays uncleared,
  the old header's argument intact.
- **[D1''] propagates the naturals up** ([D2]'s exact shape on the cursor
  buffer) and **publishes one INFLUX WORD per block**:
  `floor(fl32(capped/natural)·65536 + 0.5)`, `INFLUX_ONE` (= 0x10000) when
  nothing was demanded. ALL cascades — a capped child starves its whole
  ancestor chain, so parent blocks carry their aggregate ratio too. The
  words ride `freeStack`'s tail beside the claim stamps (fourth region,
  `blockInfluxBase`, R7: fold, don't multiply bindings), initialized to
  INFLUX_ONE so an unpublished block decays bit-identically.
- **The decay compensates per block**: `keep′ = 1 − (1−keep)·(ratio·
  (1−lift) + lift)`, computed BEFORE the claim-stamp check so a fresh
  block's `k = 0` always wins (the reverse order would fade a dead probe's
  history into its successor at `1 − lift`). The `INFLUX_ONE` skip and the
  lift-at-1 path are exact in f32 (`1−k` and `1−(1−k)` are exact
  subtractions for k ∈ [0.5, 1]), so uncapped and fully-lifted frames are
  bit-identical to the pre-compensation kernel.
- **The LIFT rides the motion-adaptive α** (`srcSystem.liftFor`): 0 at the
  still floor (full compensation), 1 at the moving α (none), derived from
  α itself so a pinned `__giSrcAlpha` pins the lift and gates with no
  motion getter (flat TEMPORAL_ALPHA) get the exact pre-compensation
  decay. Published per frame as `__giSrcCompLiftLive`;
  `__giSrcAlphaComp = false` is the polled opt-out.

#### 12.42.2 Why the lift exists at all — the rounding fixed point

Exact compensation on a hard-cut probe pushes `keep′` so close to 1 that
the integer decay's rounding fixed point `0.5/(1−keep′)` can park a
no-longer-sampled bin ABOVE `MIN_WEIGHT` (cap 16 on a 1,794-ray probe at
stride 7: parked ≈ 7,900 quanta ≈ 0.12 ray vs the floor's 1/64) — a
forever-readable stale bin, R1's dark vote by arithmetic, §12.23.4's exact
hazard resurfacing. The lift dissolves it: full compensation exists only
while the scene is STILL, where a stale value is by definition still true;
any change the motion signal can see raises α, lifts the compensation,
restores the fast decay and retires the bin normally. The same coupling is
the responsiveness answer — a light toggle raises α to 0.10 AND suspends
the compensation, so capped probes converge at the fast rate exactly when
the user is looking at a change (and the transient noise a change unmasks
is §12.38's own moving-α trade, unchanged). The one gap is a change the
signal misses — §12.38.3's blind-spot list (now shorter by §12.41) is the
authoritative price tag.

#### 12.42.3 The gates

- **`test:gi-src-rays` ARM 9** (mirror exactness): before any capped frame
  every word reads INFLUX_ONE (14,524 words); after one, every live
  block's word matches `influxWordFor` — the `Math.fround`-on-the-divide
  twin — EXACTLY, 7,127 blocks, 444 genuinely below ONE at the fixture's
  cap, 0 above (capped never exceeds natural). Probe → block goes through
  the GPU's own table; the mirror has no block allocator to agree with.
- **`test:gi-src-temporal` ARM 9** (decay exactness + the physics):
  seeded words decay word-for-word against `keepCompensated`+`decayFixed`
  at lift 0, 0.5 and 1 — lift 1 BIT-identical to the plain decay. Then
  the leg that makes it physics: a real capped transport (cap 1, rpp 1)
  publishing real words, where the UNCAPPED steady state must be a FIXED
  POINT of the compensated capped frame — held at **1.018** over 8,290
  bins for 40 frames (window 0.88–1.12; captured at 30 uncapped frames =
  96% of S∞, because a state captured short of steady CLIMBS under the
  slow keep′ and fails the window on its own transient) — and releasing
  the lift must let the sums fall toward the capped level: **0.464**,
  which is also the proof the cap was really cutting ~2× on those blocks
  and only the compensation held the level. A compensation that merely
  froze the buffer (keep′ = 1) passes the hold and fails the release.
- Regression: rays/probes/deposit/ref/temporal all green; both SRC smoke
  arms PASS at 8 storage buffers (the influx read rides the freeStack
  binding the decay already had).

#### 12.42.4 The rig's verdict — the regression FLIPS, and the cap ships

Same instrument, same interleaved discipline as §12.40.4, compensation in
the loop (the rig now records `__giSrcCompLiftLive` per capped arm —
a derived number nothing prints is a number probes will guess):

```
                     capped vs off rev/px    §12.40.4 (uncomp)   noise floor
high,  cap 16        3.771 vs 5.152  −27%        2.57× WORSE        0.178
ultra, cap 16        1.284 vs 1.509  −15%        3.06× WORSE        0.110
ultra, cap 32        1.354 vs 1.512  −10%        1.78× WORSE        0.048
```

Not merely inside the band — BELOW the off arm at every point, and the
mechanism is real rather than luck: the compensated (slower) decay carries
a starved block's bins THROUGH influx gaps that used to drop them below
`MIN_WEIGHT`, so §12.24's membership churn falls alongside the variance.
The high/16 delta is 7.8× the rig's own round-to-round noise.

**Tier defaults ship: `probeRayCap: 16` on high AND ultra** (ultra/16 beat
ultra/32 on reversals with the same p95, and its ray cut is deeper —
0.171× vs 0.261× of the natural budget). low/medium ship none: their fps
was never the complaint and no arm measured them. On the user's own
profile (§12.40.4: 126,008 rays at 138 ns/ray = 21.2 ms deposit) the 5.8×
cut is worth ~14 ms of the deposit — the fps fix, now on by default.
`__giSrcProbeRayCap = 0` forces OFF over the tier (the harness pins keep
their instruments); a positive hatch still overrides live.

Recorded honestly, not tuned away:

- **step p95 reads +23–31% capped, at every point** (0.1200 vs 0.0914
  high; 0.7263/0.7376 vs ~0.59 ultra). Fewer membership events, chunkier
  each — the same §12.24 floor, now the dominant residual. That queue item
  was already open; this is its number.
- **the lift snapshot is post-measure, not an in-measure integral** — one
  ultra round read `lift 0.944` after its capped still arm (a motion
  retain caught mid-decay) while the arm's numbers sat with its clean
  round. A future rig improvement is to integrate the lift across the
  measured window; the verdicts above stand on interleaved means whose
  clean-lift rounds agree.
- the alpha probe (`probe:gi-src-alpha`) re-ran green under the default
  cap end to end (0.05 still / 0.10 toggle / 0.05 recovery, exact), and
  the boot chain grew 45 → 52 passes — [D1'']'s three natural propagates
  and four publishes, visible in the pass count as designed.

The §12.38/§12.40 harness pins are unchanged in meaning: non-cap sweeps
and the histogram pin `__giSrcProbeRayCap = 0`, which now means "force
off" rather than "restate the default" — the instruments survive the
default flipping under them.

### 12.43 THE TRACKING WINDOW — "TEMPORAL IS TOO SLOW" WAS THE STRIDE ROOT,
### MEASURED, AND THE FIELD NOW CONVERGES 8× FASTER AT THE USER'S REGIME

The user re-reported after §12.41+§12.42 shipped: "temporal being too slow —
not fixed". The α RAMP was exact (its probe said so); what nobody had
measured was the FIELD — how long the resolved lighting takes to reach its
new steady state after a light steps. `probe:gi-src-converge` (new) measures
exactly that: Cornell, a probe-owned light stepping 2→6, mean resolve
luminance per frame, t90 in wall-clock seconds, four arms in one page:

```
                                     t90 BEFORE      t90 AFTER the window
default (cap 16 + comp, stride 1)      1.65 s              0.56 s
comp-off                               0.60 s              0.57 s
cap-off                                0.34..0.48 s        0.34 s
strided ~12 (ultra fullscreen)         7.42 s              0.92 s   ← 8×
```

Two mechanisms owned the slowness, in proportion the arms separate cleanly:

1. **The α spike from a step is ~ONE FRAME long** (a toggle is one frame of
   luminance delta), so the field's convergence ran at the STILL floor —
   with §12.42's compensation re-engaged on capped blocks. That is the
   1.65 vs 0.60 gap at stride 1: the compensation tail.
2. **The stride root multiplies the convergence time constant by S.**
   `keep = (1−α)^(1/S)` is the §12.32 fix that stopped the decay destroying
   evidence between sparse refreshes — and it equally preserves STALE
   evidence after a step: per-frame α at ultra's stride ≈ 12 is 0.0087, and
   t90 ≈ ln10/0.0087 ≈ 263 frames ≈ 7.4 s measured. The user's standing
   complaint, twice reported across two fixes, was this line.

The fix (`__giSrcMotionTrack = false` opts both halves out, polled):

- **PEAK-HOLD** (GISystem's `sceneMotion` closure): a motion peak ≥
  ALPHA_TRACK_THRESHOLD (0.5) arms an ALPHA_TRACK_HOLD_MS (1200 ms) window
  reporting the held peak — α and the §12.42 lift stay up while the field
  converges, instead of for one frame.
- **THE ROOT RELAXES WITH MOTION** (srcSystem.syncCamera):
  `keep = (1−α)^(1/(1+(S−1)·(1−mRoot)))` with mRoot the THRESHOLDED remap
  of m — at a step the root is gone (history is known-wrong; preserving it
  is not stability, it is lag), and below the threshold the exponent is
  §12.32's EXACTLY, so a parked scene's jitter (the rig reads m ≈ 0.13 on
  still Sponza) cannot perturb the still-scene arithmetic. The same
  threshold discipline as the hold, for the same reason, stated once in
  srcConfig.
- The two opt-outs are DECOUPLED (`motionOf` vs `liftFor` in srcSystem):
  `__giSrcAlphaComp = false` disables compensation only — routing it
  through the lift would have made "disable compensation" silently mean
  "always decay at the tracking rate".

Verified: `probe:gi-src-alpha` all-exact under the window (the hold expires
at 1.2 s, the recovery arm samples at 3 s — still 0.05/0.10/0.05); the
converge probe's after-column above. The moving-scene price of the relaxed
root is TRACK_AB's job (the rig gained interleaved moving arms on the
hatch + still controls), run before this section's commit.

#### 12.43.2 TRACK_AB REFUTED THE FIRST DRAFT THE DAY IT WAS WRITTEN —
#### THE WINDOW NOW ARMS ON LIGHT EVENTS ONLY

The draft above tied the hold and the root to the BLENDED motion signal
(any peak ≥ threshold, root from α's own ramp position). TRACK_AB, ultra:

```
  moving rev/px: on 21.537  vs off 0.997      still control: on 21.210
  moving p95:    on 0.0370  vs off 0.0557                    off  0.916
```

The still controls are the disqualifier — 23× on a PARKED scene. The mover
term spikes spuriously on still ultra Sponza (§12.42.4's lift snapshot had
already recorded 0.944 on a still arm, before any tracking code existed),
and the hold amplifies each spike from one frame of raised α into a 1.2 s
burst of relaxed-root fast decay. The user, whose editor runs the working
tree, reported the draft live: "GI is jumpy, like the floor is covered in
water and there are sun glints moving everywhere" — the instrument and the
eye agreeing within the hour.

The redesign is a scoping, not a retreat, and it is the physically right
scope: **a LIGHT change (matrix, luminance, emitter) invalidates the whole
field; a moving OBJECT invalidates it locally while the sources stay
true.** So `sceneMotion` splits: light-side terms arm the hold and are
what the window holds; mover displacement keeps §12.38's shipped behaviour
in full and can never arm anything. The root relaxation moved off α onto a
dedicated `trackMotion` getter that is nonzero ONLY while the light-event
window is open (gating lives in ONE place, GISystem's closure; standalone
gates pass no getter and keep §12.32's root identically). The two
mechanisms remain one switch: `__giSrcMotionTrack = false`.

Verification of the redesign: converge probe (the window still fires on
its light step — that is the point), alpha probe, and TRACK_AB re-run
(moving AND still arms must now agree on ≈ off) — results below.

#### 12.43.3 The redesign's numbers, and what the instrument taught back

- **TRACK_AB (the §12.43.2 disqualifier), redesigned build:** moving on
  1.388 vs off 1.053 rev/px (+32%, ≈2× the 0.153 round spread — borderline,
  logged), step p95 on 0.0274 vs off 0.0488 (−44%), and the STILL controls
  **0.949 vs 0.843 — inside the round spread**. A parked scene cannot arm
  the window any more, by construction and now by measurement.
- **`probe:gi-src-alpha`:** exact through the window (0.05 / 0.10 / 0.05).
- **Converge, clean run:** strided t90 **2.52 s vs 7.42 s pre-fix**, and
  strided/default fell 4.5× → 1.9×. The comp tail at stride 1 is down to
  1.30 vs 0.93 s (was 1.65 vs 0.60).
- ⚠ **The instrument's sampling rate varies by boot** (the same script read
  ~49 samples/s on one boot and ~14 on two others), and t90 is wall-clock
  against a FIXED 1200 ms window — on a slow page the window covers fewer
  engine frames and expires before 90%, inflating every arm (the 0.92 s
  strided reading came from the fast boot). Within-run ratios are the
  quotable currency, same rule as the flicker rig's header. At the user's
  30–60 fps the window covers 36–70 frames ≈ full convergence inside it.
  If a future unit needs the tail gone entirely, the window can retrigger
  while the field's own delta remains large — not built now (R16).

### 12.44 RAY COMPACTION — THE CAP'S RAY CUT FINALLY REACHES THE WALL CLOCK

§12.42 shipped the cap and the user's fps roughly doubled — but the live
profile (their editor, ultra, 1776×862) read **deposit 19.0 ms for 25,038
rays**: 760 ns/ray against the 138 the same machine measures when every
thread traces. The cap cuts RAYS, not WARP OCCUPANCY: at ~19% surviving
density the winners are SCATTERED over the thread → pixel stride, so
essentially every 32-wide warp still contains a tracer (1 − 0.81³² ≈ 100%)
and [E] runs at full width. The cut bought bandwidth, not latency.

The fix is the classic one: a WORKLIST. [D5] — the one place "this pixel
fires this frame" is decided — appends each winner to `rayWork` (dense,
atomic cursor, capacity `pixelCount`, cleared in [D0]); [E] traces
`rayWork[instanceIndex]` and the threads past the count return in WHOLE
warps, the cheap kind of idle. No indirect dispatch needed: the dispatch
size stays the transport's baked thread count. Written in [D5] rather than
a separate pass because a second pass would be a second definition of the
winner set — the exact class of mismatch the `transportPixel` discipline
exists to prevent; on the worklist path that hazard DISSOLVES (the list is
written by [D5] in the same frame, so [E] cannot enumerate a pixel [D5]
did not own). The classic mapping survives for every gate built before
compaction: pass neither buffer and [E] is byte-identical to §12.33's.

Gate (`test:gi-src-deposit` ARM 0b): classic and compacted [E] run on the
SAME untouched transport frame (re-running [D] would reshuffle the
scheduler-dependent partition and the synthetic trace's keys — the diff
would measure the shuffle); integer atomics make sums order-independent,
so the bar is EXACT: worklist = winners (2,108 = 2,108), accumulators
bit-identical (0 of 14,745,600 words differ), deposits equal. Regression:
rays, temporal, smoke — green.

#### 12.44.1 THE TWO-BUFFER DRAFT FAILED PIPELINE VALIDATION, AND ONLY THE
#### SMOKE COULD SEE IT

The first worklist was a list buffer plus a count buffer: +2 storage
bindings on [E], which sits at **7 of 8** in the smoke's profiled ray-hit
config (§12.39's own measurement — and the smoke IS the binding-budget
gate, its header says so). 9 > 8 → pipeline creation fails → **[E]
silently never dispatches**: the smoke read `0.00 deposits per ray`
against a worklist provably holding all 10,849 winners, for as long as
anyone polled. Three instrument layers earned their keep in one failure:
the deposit gate PASSED (its tiny fixture binds fewer buffers), the
editor page WORKED (unprofiled [E] had one slot spare — lit 19.9%, caps
scaling), and only the smoke's profiled config crossed the line. A
feature that works everywhere but the binding-budget gate is a feature
that is over the budget.

Fold, don't multiply (R7): `rayWork[0]` is the atomic count, entries
follow, ONE buffer. [E] compiles at exactly 8/8 in the profiled config
(the smoke's storage report line), the gate is still bit-exact
(2,108 = 2,108 winners, 0 of 14.7M words differ), deposits 1.394/ray.
The smoke's src-arm read also gained the §12.39 stability poll with
self-reporting (statRays/worklist/rayTotal per second) — the zeros-vs-
full-worklist line is what turned "the split rule is wrong" into "the
pipeline never compiled" in one read.

Harness cap sweep with compaction (ultra, Sponza, 315,952 px — the
floor-dominated pose, so the RATIO is the message): cap 16 deposit
2.128 ms vs off 4.363 ms — **2.05× where §12.40.4 measured 1.62×** — and
cap 8 ≈ cap 16 says what remains is the floor, not rays. The user-editor
number (19 ms deposit for 25k rays, the unit's whole motivation) owes its
re-measurement after their next reload.

### 12.45 THE GLINTS HAVE TWO OWNERS — THE WINDOW LIFTS THE CAP, AND THE
### PAN CHURN OUTLIVES ITS OWN INSTRUMENT ARM

The 2026-08-12 re-report named two symptoms: "glint movement settles when
the camera does not move, as it starts moving — lights are moving all over
again" and "anytime light updates, it starts flickering." Two new rig arms
(R13 — instrument before fix) priced them separately, and they turned out
to be DIFFERENT mechanisms.

**LIGHT_STEP (interleaved ×2, a real intensity step 2↔6 through the
editor's own prop path at frame 60, directions balanced per config):**
post-step churn read **shipped 24.08 / cap-off 15.32 / window-off 3.71
rev/px** (shipped round spread 0.394 — 22× under the effect). The §12.43
tracking window converges fast by decaying fast, and the §12.42 cap denies
it evidence at exactly the moment it needs the most: the cap owned 8.76
rev/px — 36% — of the light-update flicker. Window-off's calm 3.71 is the
slow-convergence reference (t90 7.4 s, the complaint §12.43 fixed), not a
target.

**THE FIX (this section's commit): the tier cap LIFTS to OFF while the
tracking window is open** — CPU-only, in `syncCamera`'s existing cap poll,
riding the same `tr` the root relaxation already reads. The deposit pays
uncapped cost for the window's 1.2 s, which is the point: spend rays when
evidence is stale, save them when it isn't. A cap PINNED via
`__giSrcProbeRayCap` NEVER lifts (pins belong to instruments — §12.42's
non-cap-sweep rule would silently break otherwise); `__giSrcCapWindowLift
= false` opts out, and is the rig's `no-lift` arm.

**CAMERA_AB (pan–hold cycles ±25°, counting holds only — a during-pan
count is 100% reprojection; capped 16 vs forced off, interleaved ×2):**
the headline statistic said "cap-invariant" (pan excess over own still:
capped 2.08 vs off 1.28, against a 0.86 noise threshold) — but its OWN
BASELINE was the finding. Post-pan still arms read 13.2–14.7 (capped) and
8.2–8.9 (off) against the same page's clean pre-pan floor of 4.18: the
pan's churn OUTLIVED a full 270-frame arm in both configs. Re-anchor is
ruled out by arithmetic (threshold 64·s₀ = 28.8 m; the pan moves the eye
~6.5 m; zero re-anchor log lines). The standing suspect is probe
POPULATION turnover — newly revealed surfaces allocate cold blocks, and
blocks reclaimed while off-screen return cold when the camera pans back.
The cap multiplies the tail ~1.6× but is not its source. still2 arm added
to time the tail's decay; diagnosis continues before any fix is designed.

#### 12.45.1 VERIFY

Post-fix LIGHT_STEP rerun (same rig, fresh page — absolute numbers do not
cross the process boundary, ratios do): **shipped-with-lift 11.45 /
no-lift 17.07 / window-off 4.75 rev/px**, shipped round spread 0.294 —
the effect is 19× the rig's own noise. The lift removed **33%** of
post-step churn within its page (the pre-fix run priced the ceiling at
36%), directions balanced (2→6 and 6→2 agree within 0.6 rev/px on every
config). `no-lift` (`__giSrcCapWindowLift = false`) reproduces the
pre-§12.45 behavior and is the standing regression arm.

#### 12.45.2 THE PAN GLINTS WERE THE SUN FOLLOWING THE CAMERA

The camera-lift verify (tier cap unpinned, `__giSrcCamCapLift` on/off)
first read NO EFFECT — and its per-frame cap sampling showed why: the cap
was lifted in BOTH arms, 118-120/120 frames, pans AND holds, with
`tr = 1.00` held open while sh/em/lum maxima read 0.012/0/0. The §12.43
window was arming on every pan. The jitter probe
(`run-gi-light-jitter-probe.mjs`) exonerated the parked scene — one
directional sun, zero matrix motion, window closed, cap 16 live — which
left the arithmetic: sh 0.012 = posDelta·0.05 at 0.24 m/frame, exactly a
±25° pan's eye speed. THE SUN'S POSITION TRACKS THE CAMERA (cascade
shadow fitting), and the light-motion loop's position term counted that
as a light event. Every pan → "light moved" → 1.2 s of fast α + relaxed
root — field-wide fast decay over history that was WORLD-VALID. The
user's report was literal: "as the camera starts moving, lights are
moving all over again."

Fix: one line — a DIRECTIONAL light's position is radiometrically
meaningless, so `posDelta` no longer contributes for directionals
(rotation still arms: the script-driven day cycle is the design case;
point/spot dollying still arms). Side effect, deliberate: the GI shadow
chain's velocity-scaled memory also stops flushing on pans (same
measurement, one definition — a camera-tracking sun position never made
shadows stale either).

Verify (same rig, same page discipline): pans no longer arm (`tr` 0.00,
lift-off arm 0/120 lifted frames), and pan-hold churn COLLAPSED 9.1-9.7 →
2.9-3.5 rev/px — pans now read BELOW their own stills (negative pan
excess, both rounds). The §12.45.2 camera cap lift (srcSystem tracks its
own per-frame camera deltas; 5 mm / 0.1° per-frame thresholds; same
1200 ms hold; `__giSrcCamCapLift = false` opts out; pinned caps never
lift) survives as a small real margin on top: lift-on 2.89 vs lift-off
3.40 (≈4× the 0.13 round spread) — the cold-block burst-fill. The
§12.45 CAMERA_AB numbers (pan excess 6.66 capped / 1.66 off) were
measured UNDER the coupling — fast decay ran in all those arms; the
turnover diagnosis stands but its magnitude was mostly the window's.

### 12.46 A LIGHT EVENT IS A CROSSING, NOT A STATE — THE DAY CYCLE PINNED
### THE TRACKING WINDOW OPEN FOR THE ENTIRE SESSION

The user's 2026-08-12 verdict on the shipped §12.42→§12.45 stack was flat:
"FPS seems even lower than before, 45-50 for High, 30 when moving the
camera… when Light moves flicker is still strong. So no much win since
last session." Both halves have ONE cause, and it is in the arming
condition §12.43 shipped.

**THE ARITHMETIC CAME FIRST.** Their scene runs `scripts/LightScript.ts`,
a day cycle that ping-pongs the sun's elevation across 140° with a
cosine/quadInOut ease over a 10 s half-period. Mid-swing that is
~0.005 rad per frame at their 30 fps. `ALPHA_MOTION_SAT` is
`(0.94−0.86)/30 = 0.00267`, so `mLight = min(1, dirDelta/SAT)` **saturates
at 1.0 on every single frame of the swing** — 1.9× the constant at their
worst-case frame rate, more at higher rates. §12.43's arm was
LEVEL-triggered (`if (mLight >= ALPHA_TRACK_THRESHOLD) holdUntil = now +
1200`), so every frame re-pushed the hold and **the window never closed
while the sun moved**. Consequences, both of them user-visible:

- §12.45's cap lift keyed off `tr > 0` ⇒ the tier cap sat at
  `PROBE_RAY_CAP_OFF` permanently. **§12.42's entire fps win — ~14 ms of
  their 21.2 ms deposit — was cancelled for the whole day cycle.** That is
  the "fps even lower" report, and it is why the shipped build measured
  worse for them than the capped build it replaced.
- The window's fast decay (`rootS = 1`, α pinned at 0.1) became the STEADY
  STATE. §12.45 accepted that churn explicitly as "transient 1.2 s" — the
  transient never ended. That is "when light moves, flicker is still
  strong."

**LIGHT_ROT (new rig arm) PRICED IT BEFORE THE FIX** — a continuous sun
ping-pong driven on the light's matrix in-page (matrix motion needs no
prop path; GISystem's loop polls `matrixWorld` deltas, exactly as the
user's script drives it), per-frame cap/`tr`/α sampling, a discarded
rotating settle arm before each measured arm so the measurement is the
STEADY state and the legitimate onset window lands in the discard:

| config | rev/px | capLift% | trMax | αmean |
|---|---|---|---|---|
| shipped (level arm) | 4.62 | **100** | 1.00 | 0.100 |
| no-lift | 30.88 | 0 | 1.00 | 0.100 |
| window-off | 5.07 | 0 | 0.00 | 0.100 |

Round spread on shipped 0.378. Read the first and third rows together:
**shipped and window-off are the same churn (4.62 vs 5.07, inside 1.3×
the spread) — but shipped pays uncapped deposit for it and window-off pays
tier-capped.** The window buys nothing in this regime and costs the cap.
The middle row is the guardrail: pinning the window open WITHOUT the lift
is 6.7× worse than either, so the lift is not the thing to remove —
**the arming is.**

**THE FIX: arm on RISING EDGES.** `mLight` crossing the threshold arms the
window once; sustained saturation re-arms nothing. A crossing only counts
after the peak has spent `ALPHA_TRACK_REARM_MS = 800` BELOW threshold —
the eased ping-pong dwells sub-threshold ~0.6 s at each extreme, and
without the dwell every swing reversal would arm a fresh 1.2 s uncapped
window, i.e. a periodic churn burst twice per cycle. A genuine isolated
event (a toggle, a teleport, a cut) follows seconds of quiet and always
arms, so §12.43's and §12.45's step behaviour is untouched. Accepted
limitation, stated rather than hidden: a step DURING sustained motion
cannot edge-trigger and rides the already-saturated α ramp — fast α is
already the ceiling of what the ramp buys there.
`__giSrcTrackLevelArm = true` restores level arming as the rig's
regression arm; it is never a shipping config.

#### 12.46.1 VERIFY

Post-fix LIGHT_ROT, four arms interleaved ×2 in one page (fresh process —
absolute numbers do not cross a process boundary, the within-page
comparison does):

| config | rev/px | capLift% | trMax | still-after |
|---|---|---|---|---|
| **shipped (rising edge)** | **4.676** | **0** | 0.00 | **0.95** |
| level-arm (pre-fix) | 4.665 | 100 | 1.00 | 3.28 |
| no-lift | 27.01 | 0 | 1.00 | 10.9 |
| window-off | 5.00 | 0 | 0.00 | 0.95 |

Shipped round spread 0.590; page still floor 0.718.

**The headline is the first two rows being the SAME number.** 4.676 vs
4.665 is inside 1/50th of the spread: the rising-edge fix costs **zero**
flicker during the day cycle and buys back the tier cap on 100% of frames
— §12.42's ~14 ms of deposit, restored for the regime the user actually
plays in. `capLift 0%` with `trMax 0.00` is the mechanism confirmed
directly rather than inferred: the window is genuinely closed during
sustained rotation, not merely cheaper.

**The unadvertised win is the `still-after` column** — a full still arm
measured immediately after the sun parks, which is also what every
ping-pong ENDPOINT looks like. Pre-fix the field stayed churning at
3.21-3.34 rev/px; post-fix it settles to 0.92-0.99, i.e. **3.4× calmer,
and within 1.35× of the page's own still floor.** The pre-fix elevation
outlasts the window's own 1.2 s by most of a 240-frame arm, so it is not
the open window being counted — it is the field re-equilibrating from an
uncapped fast-decay state back to the capped slow-decay one. Under a
ping-pong cycle that transient never got to finish before the next swing.

**✅ CONFIRMED LIVE IN THE USER'S EDITOR.** Same scene playing with the day
cycle running, same tier (s₀ = 0.45), same 889×461 resolve, same 81 draws
/ 786,852 tris, camera 5% further from target than the before-reading (if
anything costlier): **frame GPU 26.81 → 16.78 ms (−37%), fps 30 → 50** —
while the PROFILED chain stayed flat, 21.67 → 22.28 ms. That combination
is the signature rather than a puzzle: `profile.giPasses` suspends the
tick, so the sun parks and the tracking window closes during measurement
in BOTH builds, and the only frames that changed are the ones the profiler
never sees. **⚠ Corollary: giPasses cannot A/B this fix** — it measures
the window-closed state either way. (jsHeap 1701 → 566 MB is the restart
clearing their sun script's per-frame `console.log` flood, not the fix.)

**REPRODUCED IN A SECOND PAGE** (the α-sweep run's own config block, a
fresh process): shipped **12.50 @ capLift 0%** / level-arm **12.90 @
capLift 100%** / no-lift 23.90 / window-off 12.49, round spread 0.173,
still-after 2.07 vs 6.30 (**3.0× calmer**, against 3.4× in the first
page). The absolutes moved 2.7× between pages — the documented
cross-process spread, which is exactly why this rig only ever quotes
within-page comparisons — and every ratio and every capLift held.

**HONEST RESIDUAL, AND IT IS THE NEXT UNIT.** Churn *during* rotation is
~4.7 rev/px in every arm that has a window at all — 6.5× the page's 0.718
still floor — and window-off's 5.00 shows removing the window does not
touch it either. So the user's "when light moves, flicker is still
strong" is only PARTLY closed by §12.46 (the endpoints and the fps are;
the swing itself is not). What all four arms share is `αmean = 0.100`:
`m` saturates under sustained rotation, so the §12.38 ramp pins α at its
fast end for the entire cycle, and §12.38 measured α=0.1 at ~3× the churn
of α=0.05. The open question is whether sustained SMOOTH motion needs the
fast α at all — per-frame innovation is small and monotone, so a slower α
should cost a bounded angular LAG rather than accuracy, which is a very
different trade from a step. That is an α sweep under LIGHT_ROT, and it
wants a lag statistic as well as a churn one (§12.38's lesson: a
smoothing change that eats real signal passes every calm metric). Worth
knowing before designing it: the paper's own §8.1 future-work names this
exact trade and proposes "a multi-scale mean estimator or other methods
of adaptive averaging" — several accumulators at different rates rather
than one tuned α — which is the principled fallback if the trade is real.

#### 12.46.2 FOUR INSTRUMENT TRAPS THE α SWEEP PAID FOR

Recorded because each one produced a plausible-looking table, and three
of the four would have biased the answer toward the hypothesis:

1. **The decisive column came back `NaN`.** `netSettle` was computed
   inside `body()` and never added to its return object. The churn column
   looked perfect, the verdict line printed confidently, and the verdict
   logic divided `NaN`s without complaint. A sweep whose *deciding* metric
   is silently absent still reads as a result.
2. **The settle window was sized for the FASTEST α.** The post-stop slide
   takes ~1/α refreshes × stride frames — 150 at α=0.02, stride 3 — so a
   90-frame window truncated the slowest arm's slide and would have
   reported it as LESS lag. Now 480 frames (≥3× the slowest constant), the
   SAME window every arm. This is §12.38's discarded-arm lesson in its
   mirror image: there the transient was counted as flicker, here it would
   have gone uncounted as lag.
3. **`rev/px` and `step p95` are conditioned on α.** The accumulator only
   counts a frame when `|Δlum|` clears `max(0.002, 1% of lum)`, and
   per-frame innovation scales with α — so a lower α pushes pixels under
   the visibility threshold and shrinks the population both metrics are
   computed over. Part of any collapse is real (sub-visible change is not
   flicker) and part is the denominator moving. `changedPx` prints beside
   them now, and **step p95 must never be quoted across α rows** — it is a
   p95 over a different pixel set per row.
4. **The eased-curve mode crashed every non-rotating arm.** `ROT_EASE`'s
   `rotLight.halfFrames` was read at definition time, but still and base
   arms pass `rotLight: null`. Every `rotLight.*` read now stays inside a
   callback that only fires when one exists.

#### 12.46.3 THE α SWEEP RAN, AND ITS DECIDING COLUMN REFUTED ITSELF

`ROT_ALPHA=0.1,0.05,0.02` under the shipping config (rising-edge arming ⇒
window closed, tier cap engaged, so α is the only variable), interleaved
×2, round 2 reversed, a full discarded rotating arm per switch:

| α | churn rev/px (r1/r2) | changedPx | post-stop displacement |
|---|---|---|---|
| 0.10 | 14.32 / 14.31 | 252k / 243k | 0.0214 / 0.0161 |
| 0.05 | 0.93 / 0.84 | 74k / 56k | 0.0159 / 0.0142 |
| 0.02 | 0.42 / 0.39 | 32k / 30k | 0.0112 / 0.0117 |

**The churn side is unambiguous: 34× between α=0.1 and α=0.02**, far
outside any spread this rig has ever shown. Part of that is real and part
is trap 3 above (the count threshold), and `changedPx` shows the
conditioning moving with it.

**But the accuracy side is not measured, and the sweep proves it rather
than merely leaving it open.** The post-stop displacement column FALLS as
α falls — 0.0188 → 0.0150 → 0.0115 averaged over rounds. EMA lag for a
ramp input scales as (1−α)/α, so α=0.02 should read ~5× MORE than α=0.1;
it reads 1.6× LESS. **A column that moves the wrong way with α is
measuring the wrong quantity** — here σ, because `mean |Δ|` over pixels
does not cancel zero-mean noise (E|X| > 0 and grows with σ), which is the
error in the reasoning that built it.

**SO NO α CHANGE SHIPS ON THIS.** What can be said: lag is not LARGE at
α=0.02 (a (1−α)/α lag would have dominated the column and did not), and
the churn win is real. What cannot be said is the trade-off, which is the
whole decision. The rig now refuses to print an α verdict and prints the
self-refutation instead; an earlier revision did print "sustained motion
does not need the fast α" off exactly these numbers.

**THE CORRECT INSTRUMENT — average over PASSES, not over time.** Park the
sun at a test angle, converge, time-average to get a noise-free TRUTH for
that angle; then let the ping-pong carry the sun through that same angle N
times and sample the live field at each crossing. Lag is identical every
pass while noise falls as 1/√N, so they separate. Time-averaging the live
field instead does NOT work: the sun sweeps ~17° through a 60-frame
window, smearing the very signal being measured, and shortening the window
reintroduces an α-dependent convergence bias (20 frames is ~2 time
constants at α=0.1 and nearly none at α=0.02). The paper's §8.1 already
points past a single tuned α to "a multi-scale mean estimator or other
methods of adaptive averaging", which is the design to reach for if the
proper arm confirms the trade.

#### 12.46.4 THE EASED CURVE — AND THE TRIANGLE UNDERSOLD THE FIX 2.4×

`ROT_EASE=1 FRAMES=600` (their composition, ROT_HALF=300 ⇒ two turns per
arm), same four configs, ×2:

| config | rev/px | capLift% | trMax | αmean | still-after |
|---|---|---|---|---|---|
| **shipped** | **13.70** | 30 | 0.50 | 0.083 | 3.66 |
| level-arm (pre-fix) | 33.28 | 93 | 1.00 | 0.097 | 8.39 |
| no-lift | 58.78 | 0 | 1.00 | 0.100 | 20.6 |
| window-off | 19.20 | 0 | 0.00 | 0.083 | 3.66 |

Shipped round spread 0.574. **Two corrections to §12.46.1, both from using
the right curve.**

**(a) The fix is worth 2.4× in FLICKER, not just in fps.** On the triangle,
shipped and level-arm read identically (4.68 vs 4.67) and the entire claim
was "same churn, capped cost". On their actual curve it is **33.28 → 13.70**,
with the post-park settle 8.39 → 3.66 (2.3×). The triangle is a
*degenerate* input for this mechanism: its rate never dips, so it never
turns, so it never exercises the arm/close cycle that the user's swing
performs twice a period. It could measure the pin and the fps, and it
systematically understated the flicker win.

**(b) The turn windows EARN their cost — shipped now beats window-off**
(13.70 vs 19.20, −29%), where on the triangle window-off was marginally
better. This inverts the §12.46 framing: the window is not merely harmless
once it stops being pinned, it is *useful* precisely at the turns, which is
where the field is most stale relative to a sun that is accelerating again.
A light event really is a crossing, and a turn really is one.

**capLift 30% is the CORRECT reading here, not a leak** — two turns per
600-frame arm, each arming one 1200 ms window. The predicted duty was ~12%
(one window per 10 s half-swing); 30% is higher because the harness runs
faster than 30 fps, so a fixed-millisecond hold covers more frames. The
verdict bar is now curve-dependent (`ROT_EASE` ⇒ 0.6) and additionally
requires shipped to sit under 0.6× level arming, because the invariant that
must hold in both regimes is the SEPARATION, not an absolute percentage.

And the reason `ROT_EASE` exists at all is a fifth, subtler one: **the
constant-rate triangle cannot test the re-arm dwell.** Its per-frame delta
never dips below the arming threshold, so it can only ever report 0% or
100% lift — it validates the pin and the fix, but says nothing about
whether the 800 ms dwell is long enough for a real curve. Their double
ease (`cos` ∘ `quadInOut`) goes as frac⁴ near a turn: solving for the
threshold crossing puts the sun sub-threshold for **~2.6 s at each
endpoint** of a 10 s half-swing, comfortably past the dwell, so each turn
is expected to arm one legitimate window — a ~12% lift duty rather than
100%. `ROT_EASE=1` reproduces their composition and span so that number is
measured rather than asserted.

### 13.16 STARTUP IS ONE KERNEL AGAIN — AND IT IS THE EMITTER SLOT UNROLL,
### NOT THE BVH DESCENT EVERY PREVIOUS SESSION SUSPECTED

Cold `probe:gi-boot` on the user's Sponza, 2026-08-12, gates reported first
(light-shadow SKIPPED, emitter-shadow SKIPPED, reflections off, SRC hit
shading ON):

| stage | ms |
|---|---|
| voxelize (CPU) | 66 |
| static shadow BVH | 1,274 |
| GI setup | 1,465 |
| material compile wave | 3,070 |
| **compute pipeline compile** | **46,731** |
| first frame after wave | 2,708 |
| **TIME TO FIRST CORRECT FRAME** | **58,794** (58.8× over R18) |

79 compute pipelines. **One is 49,114 ms of it — 83.5% of TTFF, the
wall-clock floor** — 200 kB, 2 loops, 498 ifs, `giDynBvh8` + `giDynShapeHit`
+ `giHybridPlaneTrace192x` + the analytic emitter shapes: the SRC deposit
(trace + shade). Second is 37 kB at 22,646 ms; everything else is ~2-3 s.
The material wave holding at 3.1 s confirms §13.15.2 is still shipping.

**Isolated (`probe:wgsl-compile`, empty page, 3 reps — the defensible
statistic, since in-boot latency includes queue serialization):** deposit
**13,603 ms**, the 37 kB kernel 2,085 ms, a 154 kB kernel 1,611 ms. So the
deposit alone is 78.6% of the isolated sum, and §13.5's "WGSL SIZE DOES NOT
PREDICT COST" holds again — 154 kB compiles 8.4× faster than 200 kB.

**THE BISECTION (text surgery on the DUMPED kernel, so no engine edit and no
disturbing the user's live editor; each arm paired against the baseline in
the SAME page because absolute numbers do not survive a process boundary —
baseline read 12.2-13.1 s across five pages, ~3% within-page spread):**

| variant | median | vs baseline |
|---|---|---|
| baseline | 12.7 s | — |
| `giDynBvh8` body gutted | 11.5 s | 1.1× |
| `giHybridPlaneTrace` call sites 6→1 | 9.3 s | 1.4× |
| **emitter trio call sites 8→2** | **5.6 s** | **2.3×** |
| both cuts | 3.5 s | 3.5× |

**THE BVH DESCENT IS WORTH 1 SECOND.** It has been the prime suspect since
§13.13 and it is not the cost here — and its arm is generous, since gutting
the body also removed both loops (`2 loops`→`0`), so 1.1× is an UPPER bound.
The cost is `giEmitterFactor_4` / `giShapeRayEnter_10` / `giBoxRayEnter_9`,
**each inlined 8× in `main` = MAX_EMITTERS(4) × two consumers**, at ~0.9 s
per call site — the same per-inline law §13.14.5 measured at ~1.2 s for the
light slots, in the one loop that was never rolled. `neeIrradiance`
(`srcShade.js:287`) still does `slots.map(...)`, a JS map, while the LIGHT
loop right below it at :512 was rolled and carries the comment explaining
exactly why.

**AND THE SCENE HAS ZERO EMITTERS.** `profile.giPasses` reports `emitters: 0`
and the boot gates report the emitter-shadow chain SKIPPED, yet all four
slots are compiled into the kernel, because §12.37 made `emissiveShadows`
true so that MAX_EMITTERS uniform slots always exist and an emitter appearing
later never forces a rebuild (R11). That is a defensible design — but the
price was never measured, and it is **7.5 s of compile in a scene with no
emissive surface at all.** This is §13.14.9's shape exactly (a chain compiled
for a feature nothing in the scene uses), one level down.

**TWO FIXES, AND THEY COMPOSE.** (A) **Roll the emitter loop**, as the light
loop already is — universal, keeps R11 intact, helps scenes that DO have
emitters. ⚠ Its one real obstacle: `neeIrradiance` needs every slot's `luma`
at once to build the importance CDF, so the funnel cannot be a plain copy of
the light loop's shape. Weighted-reservoir sampling would collapse it to one
pass but CHANGES THE ESTIMATOR (§12.26 measured stratified at 2.61× vs 2.00×
for independent), so it owes an energy A/B and a flicker arm; a fixed-size
indexable local for the weights preserves the estimator exactly and is the
first thing to try. (B) **Gate emitter support on the scene having an
emissive surface**, with the `_reflectionConsumerAppeared` rebuild pattern
§13.14 already uses for reflections — trivial, precedented, and worth the
whole 7.5 s on this user's scene today, at the cost of one rebuild when a
scene gains its first emitter.

⚠ Neither reaches R18. Even both cuts leave 3.5 s for ONE kernel in an empty
page, and §13.14.6's conclusion stands: ≤1 s is architectural (boot a cheaper
ray-hit rung and upgrade in the background), not reachable by trimming this
kernel. What these buy is 58.8 s → plausibly the high teens, which is the
difference between "the editor is broken" and "the editor is slow".

### 12.47 THE CAMERA CAP LIFT WAS HALVING THE FRAME RATE — NOW OPT-IN

User, 2026-08-12, after §12.46 shipped: "**30 fps on high when moving
camera, 60 fps when still**." That is §12.46's pathology in the camera
path, and it survived that fix because §12.46 only re-armed the LIGHT side.

`syncCamera`'s camera lift is LEVEL-triggered — every frame with
`posDelta > CAM_LIFT_POS` or `rotDelta > CAM_LIFT_ROT` re-pushes a 1200 ms
hold — so the cap is lifted for the **whole duration** of any camera
movement, not for a window after it. §12.42 priced uncapped deposit at
~14 ms of a 21 ms deposit, so lifting it doubles GI cost, and a 60 fps
still scene lands on 30 while the camera moves. The reported ratio is the
mechanism's prediction exactly.

**Rising-edge arming does NOT rescue this one**, unlike §12.46: a pan
reveals cold blocks CONTINUOUSLY, so a one-shot burst at the start of the
movement buys a 1.2 s hitch and then stops helping precisely while the pan
is still revealing geometry. The honest choice is on-or-off, and the
measurement decides it: §12.45.2 priced the benefit at **2.89 vs 3.40
rev/px** on pan-holds — marginal against its own round spread — against a
**halved frame rate during the single most common interaction in the
editor**. So: OFF by default, `__giSrcCamCapLift = true` opts back in.

⚠ The rig's `CAMERA_VERIFY` lift-on arm now sets `true` explicitly. Left as
`undefined` it would run two identical arms and report the fix as "no
effect" — the null-result shape this instrument has produced before.

**The version worth building** is per-block: lift the cap for NEWLY
ALLOCATED blocks only rather than globally, which is the same targeting
§12.42's per-block α compensation already does. It needs the cap to stop
being one global uniform first.

#### 12.47.1 AND WHY §13.16's FIX (B) IS WITHDRAWN

§13.16 proposed gating emitter slot compilation on the scene actually
having an emissive surface, on the `_reflectionConsumerAppeared` precedent,
worth 7.5 s of startup on this scene. **Withdrawn: it re-introduces the
exact failure session 38 removed.** A scene that SPAWNS its first emissive
object — the emissive-projectile game — would trigger a full GI rebuild
mid-game, and "kills the slot-exhaustion MID-GAME FULL REBUILD" is
precisely what that session's analytic-only path was built to achieve.
Gating on project-wide emissive material assets rather than live meshes
weakens the trigger without removing it (a prefab's material need not be in
the scene graph before it spawns).

So **fix (A), rolling the loop, is the only startup fix here** — it keeps
the capability always compiled, so no rebuild can ever fire. Its constraint
stands from §13.16: `neeIrradiance` needs every slot's `luma` for the
importance CDF, and `luma` comes FROM the expensive `giEmitterFactor`. The
way out is that importance sampling is unbiased under ANY positive weight
function: use a CHEAP analytic proxy (colour luma × inverse square ×
cosine gate, no shape functions) for the weights and evaluate the exact
`E`/`maxT` for the PICKED slot only — one call each instead of four. That
is a variance change, not a bias change, so it owes a variance A/B rather
than an energy one. ⚠ Before building it, resolve why `main` holds EIGHT
call sites and not four: `neeIrradiance` is called once, so the ×2 is a
second inlining of the whole hit shader somewhere in the deposit, and if
that inlining is itself removable it is a free 2× with no estimator change
at all.

### 13.17 THE RAY LOOP WAS A JS LOOP — 2.3× ON THE KERNEL THAT OWNS THE BOOT

`srcDeposit.js`'s per-ray loop was `for (let k = 0; k < raysPerPixel; k++)`,
a JS loop, so the WHOLE body — trace, hit shading, NEE set, analytic emitter
shapes, cascade scatter — was emitted once per ray. At the shipping
`raysPerPixel = 2` that is two complete copies, and the dumped WGSL showed
it plainly: `giEmitterFactor` appeared **8× in `main`, in two byte-identical
clusters 1,700 lines apart** differing only in which hit point they read.
That is where §13.16's "8 call sites = 4 slots × two consumers" reading was
wrong — the ×2 is the RAY loop, not a second consumer.

Rolled into a GPU `Loop`. **Nothing about the estimator changes**: iterations
are independent, each ray keeps its own R2 index, its own trace and its own
scatter, in the same order — which is what makes this much cheaper than the
emitter-slot roll (an importance CDF to preserve) or slot gating (§12.47.1's
mid-game rebuild). `k` was used in exactly ONE place (`base.add(uint(k))`),
audited before the change because a JS-indexed array in the body would not
survive becoming a GPU index; the cascade scatter still unrolls on its own
JS `c`, deliberately (N=4 iterations of a few atomics over captured nodes).

**Measured, isolated and paired in one page:** 13,907 → **6,054 ms, 2.3×**.
Kernel 200 kB/498 ifs → 150 kB/373 ifs; call sites emitter 8→4, trace 6→3,
exactly as predicted. Cold boot: slowest pipeline 49,114 → 42,993 ms,
**summed pipeline work 177,003 → 116,626 ms (−34%, more than the kernel
shrank — the monster inflates everything it contends with)**, TTFF 58,794 →
~52,800 ms. Gates green: `test:gi-src-deposit` (including its bit-exact
CPU-mirror arms), `test:gi-src-rays`, `test:gi-src-temporal`.

### 13.18 WHY THE SHADER CACHE NEVER HELPED: THE DEPOSIT'S WGSL IS NOT
### BYTE-STABLE ACROSS BOOTS, AND IT IS THREE BAKED BUFFER OFFSETS

§13.5 left "make the cache engage" as lever 2 and recorded that warm ≈ cold
"reproducibly, yet ONE run compiled the whole set warm". Measured now,
`ARMS=cold,warm` in one process:

| | cold | warm |
|---|---|---|
| TTFF | 42,228 ms | **27,142 ms** |
| material compile wave | 2,019 ms | 748 ms |
| all pipelines, summed | 559,205 ms | 118,642 ms |
| **slowest SINGLE pipeline** | 21,981 ms | **19,450 ms** |

**The cache works — for everything except the kernel that matters.** The
material wave is served (2.7×), the summed pipeline work collapses 4.7×,
and the slowest compute pipeline does not move. So warm boots are still
~27 s and the deposit is ~72% of that.

**The reason, found by diffing the dumped deposit WGSL from two cold boots
of identical code: they differ, and by exactly SIX LINES holding THREE
BAKED BUFFER OFFSETS** — `37714886u` vs `37711862u` (twice) and `39660486u`
vs `39657462u`, both a delta of 3024:

```
nodeVar95  = NodeBuffer_5345.value[ ( 37714886u + u32( nodeVar96 ) ) ];
nodeVar104 = ( 39660486u + ( nodeVar103 * 8u ) );      // stride 8 = PROBE_WORDS
```

These are sub-buffer bases — the `hashBlockBase` / `blockStampBase` /
`blockInfluxBase` tail regions (`srcProbes.js:417,460,469`) and the probe
table — added as JS NUMBERS and therefore constant-folded into the shader.
**That is an R11 violation** ("grid/world params in uniforms, never baked
into the graph; a refit must not recompile"), and its second consequence is
the one that costs the user: a shader whose text changes between boots can
never hit a content-keyed disk cache. Chrome's cache is keyed on WGSL
source; three's own pipeline cache is keyed on node ids and misses on every
rebuild anyway (§13.5).

**THE FIX: make those bases uniforms.** They are scalars in the shared
uniform struct, not new buffers, so R7's binding budget is untouched. ⚠ Do
it for ALL of them at once and re-diff two cold boots — one surviving baked
offset keeps the text unstable and buys nothing, which is the shape of
partial fix this section exists to prevent. ⚠ And `blockInfluxBase +
info.blockBase` (srcRays.js:339, srcDeposit.js:463) is a JS sum of TWO
JS numbers: the per-cascade `blockBase` bakes as well, so the uniform has to
absorb the sum or be added on the GPU.

**What this buys, and what it does not.** If the deposit becomes
cache-servable, a warm boot loses its 19.5 s pole and lands near the
~8 s §13.5 predicted — which is the developer's actual loop, since every
editor restart after the first would hit it. It does NOT help a first-ever
boot or a shader edit, so **R18's ≤1 s still needs §13.14.6's ramp** (boot a
cheaper ray-hit rung, upgrade in the background). The two compose: the ramp
covers the cold case, the cache covers every case after it.

### 13.19 THE CACHE SERVES THE KERNEL 200× — IT JUST NEVER GOT THE CHANCE

§13.18 hypothesised that stabilizing the deposit's WGSL would let Chrome's
content-keyed disk cache serve it. **Tested before fixing** (new `PROFILE=<dir>`
arm on `probe:wgsl-compile`, which otherwise uses a throwaway profile so a
cache can never answer an A/B): the SAME file, the SAME profile, three
separate processes —

| run | compile |
|---|---|
| 1 (cold profile) | 3,665 ms |
| 2 (same profile) | **18 ms** |
| 3 (same profile) | **22 ms** |

**~200×.** The cache has always been able to serve this kernel. It never got
the chance because the text moved between boots.

**THE FIX IS PADDING, NOT UNIFORMS.** §13.18 proposed uniformizing the baked
offsets; that would have traded shader speed for text stability
(`occupiedAtLevel0` bakes its constants deliberately — the oracle calls it 27×
per sample) and touched ~10 sites. The actual variance has a narrower source:
the bases are a chain of cumulative JS sums, and two links wobble —
`staticBvhWords` (a BVH build) and `dynamicObjectWords` (whichever movers were
adopted). Everything after them moves, including the attribution/palette pair
the SRC deposit reads. So each region base is now rounded up to
`LAYOUT_GRANULE = 1 << 16` words: a sub-granule wobble moves nothing, the
offsets stay literal (no uniform, no lost constant folding), and the cost is
≤1 granule of padding per region — **~1 MB against a 157 MB allocation.**

**GATE — a re-diff of two fresh cold boots, not a code reading:** the deposit
WGSL is now **byte-identical** across boots (it differed by 6 lines before).
Correctness gates green: `test:gi-src-surface`, `test:gi-rayhit-phase4`,
`test:gi-rayhit-dynamic` (the three that read the moved regions), plus
`test:gi-src-deposit`.

**RESULT, WARM BOOT — which is the developer's loop, since every editor
restart after the first is warm:**

| | before | after |
|---|---|---|
| **compute pipeline compile** | 19,082 ms | **9 ms** |
| slowest single pipeline | 19,450 ms | **545 ms** |
| all pipelines, summed | 118,642 ms | 26,902 ms |
| **TTFF** | 27,142 ms | **12,675 ms** |

⚠ The cold arm of that run TIMED OUT (429 s) and is NOT usable — it was
contending with the user's live editor and this session's own background jobs,
which is §13.5's "no boot number beside another compiling WebGPU process is
comparable" landing again. Warm is the trustworthy half and warm is the point.

**WHAT IS LEFT IN THE WARM 12.7 s** (and it is no longer shader compilation):
the material wave 1,762 ms, render pipelines 1,390 ms, GI CPU work (BVH ~1.3 s
+ setup ~1.5 s), and first-frame. That 12.7 s was also measured under load, so
a quiet machine should read lower — re-measure before optimizing any of it.

**AND THE NEXT LEVER IS NOW VISIBLE.** 18 kernels still differ between cold
boots, and diffing one shows why: they are the PER-SLOT voxelize kernels, with
grid dimensions baked per slot (`% 12u` in one boot, `% 96u` in the other),
so slot assignment order changes the text. Uniformizing those dims would
stabilize them AND collapse ~15 distinct pipelines into one — which is §13.5's
lever 1 (PIPELINE COUNT), still never measured, worth ~20 s of cold latency by
their summed in-boot times. That is the cold-boot unit, and it composes with
the §13.14.6 ramp rather than replacing it.

---

### 12.48 ONE STATIC EMISSIVE WAS CYCLING THE CAP THROUGH EVERY REBUILD — AND THE RESIZE PATH HAD TWO REAL BUGS (2026-08-12, commit `882484a`)

User re-report: "gpu time constantly ballooning" with one emissive; "25 fps
with any emissive object in the scene at low quality preset". The §12.47-era
arm counter (`8a32503`, log-only) answered the first half FROM THE LIVE
EDITOR before anything changed — which is the only instrument this class of
bug accepts (three harness-green regressions shipped in one day, §12.44.1):

    [gi] light-track window: 1 arms in 2.2s (0.5/s), open 17% … armed by emitter 1, peak 1.00
    [gi] light-track window: 2 arms in 2.0s (1.0/s), open 58% … armed by emitter 2, peak 1.00
    [gi] light-track window: 1 arms in 2.0s (0.5/s), open 81% … armed by emitter 1, peak 1.00

**Peak EXACTLY 1.00 named the branch**: `#refreshEmitterSlots`' fresh-seat
arm (`hadRadius ? motionOf(...) : 1`), not `motionOf` (a parked mesh reads
dCenter 0). A slot re-seats from radius 0 only when the SLOT was reset — and
`emitterSlots` are uniforms created inside the state build, so **every GI
rebuild re-seats every parked emitter with `moved = 1`**. The §12.46
rising-edge arm then fires legitimately (a decayed-below + re-crossed
signal), the window lifts the tier cap (§12.45), and the deposit swings 3.8×
(133.3 ms cap-off / 34.8 ms cap-16, measured seconds apart on their ultra).
Under dynamic resolution the loop closes on itself: window → slow frame →
DRS step → resize → srcProbes recreate → (rebuild-adjacent seat churn) →
window. "Constantly ballooning" was this loop breathing.

**FIX: pose memory lives on the EMITTER OBJECT, not the slot.**
`_emitterPoseCache` = WeakMap keyed by mesh/provider, carrying
{center, axis, moved} across rebuilds; `publishMoved` seeds 1 only for a
key never seen (a genuinely new emitter IS a light event), else runs
`motionOf` against the CACHED pose. Parked slots zero their cached moved so
a return-at-same-pose cannot ride a stale retain over the threshold. A
throttled spike log (`[gi] emitter slot N motion X — new emitter | pose
delta dC=… dA=…`) names cause per seat, so the next report of this family
is diagnosable from the console alone. **Live: one boot arm ("new
emitter"), next frame "pose delta dC=0.0000", zero arms in the following
minute** — where pre-fix it armed every ~2 s. `test:gi-spawn` 16/16,
`test:gi-emitter-shapes` 795 checks.

**THE LOW-TIER HALF WAS A DIFFERENT BUG ENTIRELY.** At low/medium the
window lift is a NO-OP — those tiers never had `probeRayCap`, so
`readCap()` was already OFF ("their fps was never the complaint",
srcConfig). The live editor at LOW read: deposit **10.1 ms** of an 18.99 ms
SRC chain, 62,484 rays for **1,046 live c0 probes** — the coarse low
lattice concentrates ~60 rays on a mean probe, so a cap cuts MORE here
than at the tiers it was priced on. And the emitter-shadow marcher (which
profiled 0.0002 ms only because its pipeline was still compiling —
async-compile skip, not cheapness) prices at ~65 ns/px × 219k px ≈ 14 ms
once landed. 25.6 ms (SRC + scene) + ~14 ms (marcher) ≈ 40 ms ≈ the
user's 25 fps.

**SHIPPED (both halves through their mandated gates):**
1. `probeRayCap: 16` on low AND medium. Flicker rig `CAP_AB=1 CAP_VALUE=16
   QUALITY=low SRC=1`: capped BELOW off on both metrics (reversals 0.623
   vs 0.686, step p95 0.0482 vs 0.0554; off-arm spread 0.077 = noise
   floor), **compensation lift 0.000** — §12.42's sign-flip reproduces at
   low. Harness cap sweep at low (`SWEEP=cap QUALITY=low`): 31,595 →
   7,093 rays (4.5×), Δ mean +2.3%, deposit 1.015 → 0.877 ms — ratios
   only, the §12.33.2 editor gap stands.
2. `#emitterShadowScale()`: the emitter buffer's 0.7071 was a bare literal
   at BOTH allocation sites, tier-blind. Now low 0.45 / medium 0.5 /
   high 0.6 / ultra 0.7071 (unchanged), `__giEmitterShadowScale` in-page
   override. ⚠ The tier `macroSteps` ladder is DEAD on the shipping
   static-BVH arm (only `traceHybridPlane` receives it) — resolution is
   the honest lever until the marcher itself goes on a diet. The same
   sweep's boot log crowned it: `SLOWEST PIPELINE: #76 [emitterShadowPass]
   38.0s (110kB, 4 loops / 236 ifs)` of 263.8 s summed at LOW — the first
   emissive costs a marcher compile too.

**THE RESIZE PATH HAD TWO REAL BUGS, BOTH SHIPPED SINCE [I], BOTH FOUND BY
READING WHAT setSize ACTUALLY FORWARDS** (the dynamic-resolution churn
investigation — 427 pipelines in one session vs 79 clean):
1. `srcSystem.setSize` forwarded 6 of 10 create args —
   `lighting`/`surfaces`/`sceneMotion`/`trackMotion` defaulted null, so
   the FIRST viewport resize rebuilt the deposit WITHOUT hit shading
   (radiance silently degraded to sky-only) and recompiled a
   differently-shaped kernel on top of the churn.
2. The resize rebuild of the resolve passed the BUILD-TIME `gather`
   closure — closing over the srcProbes that `setSize` had JUST disposed —
   and omitted `screenGather` entirely. `createGiResolve`'s
   `gather && !screenGather` fallback then INLINED gatherAt into the
   resolve (the 58→323 kB pathology this plan documents everywhere),
   bound to dead buffers. **Every post-resize resolve since [I] was a
   monster compile whose diffuse term read zeros.** Both inputs now
   re-derive from the just-rebuilt srcProbes, exactly as the first build
   derives them.

**AND GI NO LONGER FOLLOWS DYNAMIC RESOLUTION AT ALL.** The DRS controller
steps `_drsScale` up to 2×/sec hunting a GPU budget that GI itself
dominates; every step landed in `#screenResolveSize` as a new integer size;
a GI resize costs ~56 pipelines plus ALL temporal accumulation. GI now
divides `_drsScale` back out (`__giFollowDrs = true` restores the
coupling) — GI owns `resolveScale`/`resolveMaxPixels` already, DRS keeps
scaling the scene render it was built for, and a manual renderScale drag
still resizes GI. The resize gate takes a 2 px tolerance so the rounded
reconstruction cannot wobble a teardown into existence. ⚠ Intervention C
(setSize re-points instead of rebuilding — only 6 of ~44 passes and 4
buffers are genuinely resolution-dependent, because `expectedC0Probes`
saturates at 131,072 on any real viewport) is mapped but NOT built; it is
the remaining churn unit if manual resizes ever matter.

⚠ OPEN: editor-side confirmation of units 2-6 lands on the user's next
focus — WebView2 defers the Vite reload while the window is unfocused, so
the live editor is still running pre-fix code as of this entry. The
pose-cache fix (unit 1) WAS confirmed live before the deferral began.

---

### 12.49 [J] MULTIBOUNCE IS A PASS, AND IT IS ON (2026-08-13, commit `0630196`)

The §4.1 line finally built as written — and §4.1's own phrase "last frame's
hit points" was WRONG in a way that mattered: a literal last-frame hit list
carries bin-block indices [C] has since re-claimed (silent cross-probe
contamination, §12.31's shape). The correct temporal reading is **last
frame's ATLAS, this frame's hits** — [H] bakes after the deposit, so a pass
between [E] and [F] reads the previous frame's tiles with bin slots that are
still valid. Same fixed point R4 models, no stale addressing.

**Shape:** [E] appends one 12-word entry per shaded hit (P, face-forwarded
n, POST-clamp ρ, destination bin word base) to a hit list riding `scratch`'s
tail — zero new bindings on [E] (R7). Capacity = transportThreads ×
raysPerPixel is an EXACT bound; `STAT_SEC_OVERFLOW` counts it being wrong
anyway. [J] (`srcSecondary.js`, 64 kB, exactly 3 storage bindings: scratch,
hashKeys, stats — the atlas is a texture) re-shades each hit via `gatherAt`
and atomicAdds ρ·E/π into BIN_R/G/B only — [E] already counted the ray, so
[F]'s Σ/count weighs it with no second normalizer.

**Numbers:** deposit WGSL 177.3 kB default vs 175.5 kB opted out (**+1.07%**
— the inline flag was 58→323 kB / 48 s compiles); closed box **+30.3%**
energy (0.1768 vs 0.1357), inside R4's 1/(1−0.9)=10× ceiling; convergence
tail at the rig's noise floor; 8,294 secondary deposits of 131,072 capacity,
overflow 0. `test:gi-src-deposit` stays bit-exact (no `secondary` option ⇒
byte-identical kernel — the sink is not built).

**Config truths:** `secondaryOn` = tier default (`low` stays single-bounce)
with `__giSrcSecondary = false` the opt-out; the inline path is DELETED.
`SECONDARY_LOD_OFFSET` ships **0**, not the paper's 2 — [B] inserts keys
only at the camera-derived LOD, so a +2 bias reads SLOT_EMPTY on every
corner and the renormalizing gather erases the shell; it stays a live
uniform (`__giSrcSecondaryLodBias`) because that is a property of the
POPULATION, not the estimator.

⚠ Gate polarity: the secondary probe's single-bounce arm HAD to flip
`__giSrcSecondary = undefined` → `= false`; under default-on the old arm
compared the loop to itself. ⚠ `smoke:gi-gpu`'s default arms pin quality
low and therefore never build [J] — the [J] arm is
`?src=1&mode=hybrid-exact-complex&sky=0.5&quality=high`, asserted for
exactly 3 bindings + the deposit-size A/B.

**THE NAMED FOLLOW-ON (the real deposit diet):** widen the entry (~4 words:
emissive, emitter id, rayIndex — words 10-11 are reserved for this) and move
the WHOLE `shadeHit` — visibility marcher, 4 rolled light slots, NEE emitter
set, analytic shapes — out of [E] into [J]. [E] becomes trace + attribute +
append; [J] becomes shade + gather + deposit. §13.17's evidence says two
~75 kB kernels compiling in parallel beat one 177 kB monster by MORE than
the byte ratio. That unit also owns the user's startup ask.

---

### 12.50 THE §12.33.2 "EDITOR IS 10× THE HARNESS" MYSTERY WAS THE INTEGRATED GPU (2026-08-13, commit `afda086`)

User: "in the browser, performance is a lot better (stable 60+ fps on ultra)
while in the editor the same thing is 25fps". Root cause, verified in
Chromium source and this machine's registry: **Dawn requests the LOW-POWER
adapter by default** (`dawn_context_provider.cc` — one adapter per GPU
process, chosen before any page runs; `requestAdapter({powerPreference})`
cannot override it), and this box's `HKCU UserGpuPreferences` pins
**chrome.exe** to `GpuPreference=2` while **msedgewebview2.exe has no
entry**. So the editor's WebView2 ran every GPU frame on the Radeon 780M
while every Chrome harness and every exported build ran the RTX 4070.

**⚠ EVERY editor-side performance number in this document before this entry
is an iGPU number.** The kernel-dependence of the gap (deposit 700 vs
70 ns/ray = 10×; emitter marcher 87 vs 65 ns/px = 1.3×) is atomics/
bandwidth-heavy kernels scaling worst on shared LPDDR5 — not a kernel
pathology, not WebView2's Dawn (same Chromium 151 as Chrome).

**FIX:** `--force-high-performance-gpu` (+ underscore twin) in
`additionalBrowserArgs` for the editor AND `desktopScaffold.js` (every
shipped desktop game had the same trap on dual-GPU laptops;
`run-build-test.mjs` asserts it). The string REPLACES wry's defaults — the
msWebOOUI/msPdfOOUI/msSmartScreenProtection disables are restored after
being silently dropped since the flag was first set. A `[gpu] adapter:`
boot line (sceneSettings.js `resolveRendererLimits`) keeps it honest.

**MEASURED, user's editor, ultra, full-res resolve, 73,578 rays flowing:**
SRC chain **37.63 → 3.49 ms**, deposit 24.08 → 0.93 (12.6 ns/ray), gather
5.18 → 0.56, [J] 0.64 → 0.20. ⚠ The FIRST post-restart profile read
near-zero with `raysPerFrame: 0` — skipped dispatches during the fresh
adapter's cold compile wave (§12.40.3's empty-dispatch trap); never quote a
post-adapter-switch profile until hits flow. ⚠ A new adapter = cold shader
cache: one full cold compile wave, then §13.19's 200× cache resumes.

---

### 12.51 THE EMITTER-SHADOW MUD WAS THE WIDTH PROBE — AND THE CHANNEL FAILED CLOSED (2026-08-13, commit `90221cc`)

Cornell-box report: shadows "kick in much later than the indirect light",
"severe mud and blocky artifacts". Structural key: on the shipping
static-BVH arm, admission is binary exact triangles — an open ceiling's
pixel IS the width probe's output, nothing else. Five fixes, one commit:
(1) the static-BVH arm passed `tEnd` where the records arm passes the
lamp-exclusion `tProbe` — a copy-from-the-direct-arm bug the records arm's
own comment describes verbatim; (2) the probe's `capCut` (0.85·capWorld)
admitted `freeRadiusAtWorld`'s lattice-inset bounds (levels 1-3 emit
4-16-voxel pseudo-occluders on a 0.75 m world lattice) — tightened to 0.5
(`__giShadowWidthCapCut`); SLAB leak A/B read **0.3062 at BOTH cuts** —
the leak is a pre-existing fallback residual, NOT this change; (3) the
zero-initialized shadow targets read "fully occluded" during the marcher's
async compile, so the emissive contributed NO direct light until the
110 kB pipeline landed — `createGiShadowClearPass` stamps white at target
(re)creation, fail-open; (4) the emitter filter gets a mid-σ via the
existing `softness` plumbing (was the hardcoded stochastic-arm σ1.6);
(5) the specular-glow bilateral sampled the emitter pack with the SHADOW
channel's texel — per-texture texel now. Blocky CONTACT quantization is
SRC probe spacing, a different system. ⚠ The default-arm probe FAILED once
on "field never logged ready" under 4-way process contention — re-run,
don't diagnose, when other WebGPU processes are compiling.

---

### 12.52 PER-BLOCK COLD FILL + SURPRISE-ADAPTIVE α (2026-08-13, commit `8533a55`)

The ghost/pop-in unit — global signals replaced by per-block state on the
§12.42 influx-word template. COLD FILL: blocks claimed within 4 frames run
the cap at ×4 ([D1'] only — the clamp propagates through PROBE_RAYS, [D5]
never learns; shift-not-multiply keeps the rpp flooring; +36% worst-case
rays on a fast pan vs the withdrawn global lift's +485%); boostEnable is
zeroed while the cap is pinned and for COLD_GUARD_FRAMES after
build/setSize/re-anchor. SURPRISE: the [D1''] publish keeps slow per-block
accumulators (decayed by the SAME keepCompensated as the bins) + a fast
signed drift EMA of (frame mean − accumulated mean) normalized by shot
noise; u ramps 2σ→4σ, decay composes `keep′ = 1−(1−keep)·mix(liftedRatio,
surpriseF, u)` — at u=1 a block decays at PER-FRAME α 0.1 regardless of
stride, and u self-terminates as the mean converges (no timer). u ≥ 0.5
also buys cap ×2. ONE-SWITCH RULE: the governor scales the PUBLISHED word,
so fast decay and fast evidence can never separate (§12.45's 27-58 rev/px
is what separation ships). Sustained GLOBAL light motion degrades the
mechanism off continuously.

State: 5 atomic words/block on `scratch`'s tail + 1 surprise word as
`freeStack`'s FIFTH region (0 = today's decay bit-for-bit). [E] stays 8/8.
SUM_SHIFT=10 against u32 wrap. Everything behind optional bundles —
absent ⇒ byte-identical kernels; the whole bit-exact set re-verified.

**MEASURED INSTRUMENT TRUTHS (temporal ARM 10):** detection at 4σ,
saturation at **9σ** (the plan's 3σ/6-frame estimate was optimistic — the
drift EMA peaks at 0.62·Δ while M chases the step; the arm records the
real thresholds); self-termination 8 frames; 0 false positives at the
model σ, 0.11% at the measured σ — which is **1.78× the shot model
because SUM_SHIFT quantization at GI-realistic luma (~3% of Lmax = 1-2
quanta/deposit) adds comparable noise**; the T0 dead zone absorbs it.
Recorded, not tuned away.

OPEN (next unit): flicker-rig arms (SURPRISE_AB / LIGHT_STEP per-block /
ROT_EASE / CAMERA_VERIFY cold-fill) + the converge t90 target (≤ ~2 s
strided); step 11 (C) — mover-term scoping + window-lift conditional —
deliberately unshipped until those arms exist.

#### 12.52.1 CONVERGE VERDICT + THE LIVE CORNELL DECOMPOSITION (2026-08-13, `3d8cede`)

`probe:gi-src-converge` with the per-block unit live: **strided-12 t90 =
0.93 s** (the user's 10-20 s ghost regime; was 2.52 s with the §12.43
window, 7.42 s bare), default 0.64 s, comp-off 0.68, cap-off 0.69 — the
surprise mechanism converges a seen step in under a second at every config.

Live Cornell profile (ultra, dGPU, at REST): GPU 17.6 ms of which
**emitterShadowPass 9.95 ms = 56%** (full-res resolve ⇒ 786k marcher px);
SRC total 5.4 (deposit 1.9, [J] 0.575, gather 1.0). Ultra's emitter scale
dropped 0.7071 → 0.55 as the stopgap (`3d8cede`). `unattributedRate` read
**63.23% after a LIVE quality switch** (fresh boots ~3%) — the §12.44
tier-switch staleness, now visibly damaging shading ("weird lighting").
A scripted MCP-cadence drag of the emissive did NOT reproduce "lagging
hard" (42→43 fps) — the gizmo-drag path (per-frame transforms + editor
overlay) remains the suspect; reproduce with a play-mode script next.

**QUEUE, in order:** (1) attribution re-stamp on tier change (repro
headlessly first: boot GAME page, flip quality, read unattributedRate both
ways); (2) analytic-penumbra rewrite (blocker distance from the BVH the
arm already traces — kills the waffle grain AND most of the marcher's
per-pixel cost; step 5 of the §12.51 plan); (3) the [E] shadeHit split
into [J]'s seam (the cold-startup monster, §12.49 §9); (4) flicker-rig
arms for the per-block unit (SURPRISE_AB / LIGHT_STEP per-block /
ROT_EASE / CAMERA_VERIFY cold-fill) + step (C) mover-term scoping.

#### 12.52.2 QUEUE UNIT (1) REFUTED AND REPLACED: THE ATTRIBUTION STALENESS WAS POOL STARVATION (2026-08-13, commit `22740e5`)

The re-stamp unit died on its repro: `probe:gi-attribution` (new) switched
GAME/Sponza high↔ultra live and read **0.00% unattributed in both
directions at every delay** — `#rebuild()` re-creates registry, field and
attribution, whose palette sync runs on construction and every frame, so
nothing CAN survive a tier switch to go stale. §12.44's "96.53% after a
switch" and §12.52.1's "63.23%" were **cross-scene comparisons** (Cornell's
number against Sponza's healthy 3%); a switch moves the rate only because
the tier moves the voxel size.

The real owner, visible on FRESH boots of any enclosed scene:
`surfaceCapacity = level0VoxelCount/12` assumes Sponza's 5.5% occupancy; a
closed 5 m room at 0.1 m voxels is **12.9% occupied**, `surfAllocCompute`
denies the overflowing bricks, denied bricks carry no records ⇒ no stamps ⇒
the palette-mean wash ("weird lighting"). Cornell-ultra: stamps saturated
at 21,833/21,846 pool, 75.3% unattributed, with the engine's own `POOL
STARVED` warning firing unread. FIX: the pool takes what an 8 MB budget
allows (floor /12, ceiling /3; crossover ~1.8M voxels), so Cornell gets
87,382 records (+3.7 MB, 0 denied, stamps == occupied EXACTLY) while
Sponza-ultra is **byte-identical** (preserves §13.18's stable WGSL).
Ultra 75.3→43.9%, high 56.4→42.4%, medium 25.9→8.6%.

Also fixed, measured a NO-OP, documented so nobody re-derives it: the face
retry stepped `world.minCell·0.25` — the COARSE SRC cell, 0.13 voxels on
Cornell (could never cross a face); now a quarter-cell in the attribution
grid's own units. The gate never saw it because `gi-src-surface.html`
passes `world = { minCell: VOXEL }`.

**OPEN (new unit): Cornell's residual ~44% at ultra.** Not the palette
(stamp&live == stamps), not the pool (0 denied), not the retry (no-op).
~7 points are the exact-complex trace path (hybrid-plane reads 36.4 vs
43.6); the rest is hits whose voxel maps to no static record, unowned.
Enclosed-scene shading visibly wears this. ⚠ Instrument truths from the
probe build: a freshly-minted compute node's FIRST dispatch is silently
skipped by the async-pipeline patch (a `stamps 0` read on a healthy frame);
breaking a retry loop on the first counter that moves reports whichever
pipeline compiled first; editing `src/modules/gi/*` hot-reloads the page
under a running probe (one Sponza run hung >1 h).

---

### 12.53 THE SHADEHIT SPLIT: [E] = TRACE+ATTRIBUTE+APPEND, [J] = SHADE+GATHER+DEPOSIT (2026-08-13, commit `daea2ae`)

§12.49's named follow-on, built to spec with five recorded deviations. The
whole shadeHit (visibility marcher, 4 rolled light slots, NEE emitter set +
analytic shapes, R5 zeroing) moved into [J]; the hit entry grew 12→16 words
(`SEC_LE` 10-12, `SEC_EMITTER` 13, `SEC_RAY` 14 — a u32 hashKey pick, not
float bits — `SEC_SUML` 15). The deposit SPLIT partitions, estimator
unchanged: T/count/miss deposits + the every-ray stat denominators
(`SHADED`/`UNATTRIBUTED`/`ALBEDO_CLAMPED` keep §12.52.2's comparability)
stay in [E]; radiance atomics + their stats move to [J]. §12.52's per-block
words split the same way the bins do: `BSTAT_SUM_W` from [E], `BSTAT_SUM_L`
from [J] at a word ADDRESS [E] writes into the record.

**Kernels (high arm): [E] 178.9→87.6 kB (470→264 ifs), [J] 64→154.6 kB
with bounce / 93.8 shade-only; critical path 0.864× by bytes, 0.781× by
isolated compile** (contended — flagged) — §13.17's superlinearity again:
each kernel now carries ONE marcher instance where the un-split deposit
inlined two. Bindings: [E] stays 8/8; [J] 3→4 with bounce (scratch, stats,
hashKeys, `bits` — the medium is one buffer), 3 without; the smoke's
exactly-3 assertion updated deliberately.

Deviations from §12.49: (1) the split clamp is RETIRED — both terms sum and
clamp once in [J]; `STAT_SEC_CLAMPED` re-aimed at the bounce term alone;
(2) a 5th entry word beyond the spec's 4 (the §12.52 luma address);
(3) the gather stayed in [J] — measured FIRST at ~274 ms of a 3,339 ms
compile (~10%), a third kernel would re-introduce the split clamp for 8% of
the critical path; (4) `__giSrcSplitShade = false` rebuilds the one-kernel
form so the split's compile A/B is in-process (§13.14's 47-vs-238 s rule);
(5) mover-stat denominators shrank to hits only ([J] does no work for the
~76% of rays that miss — the un-split kernel shaded garbage and discarded
it).

**⚠ THE GATE POLARITY TRAP, AGAIN, INVERTED:** `__giSrcSecondary = false`
(and low tier) now gates ONLY the `gatherAt` term — [J] still builds,
dispatches and SHADES. The secondary gate's old `pass === false` assertion
would now bless a black frame; replaced by `pass:true, bounce:false,
hits>0`, asserted live. Gates: `test:gi-src-deposit` bit-exact PASS,
`test:gi-src-secondary` 13/13 (closed box +11.6% vs §12.49's +30.3% —
BOTH arms brightened across `90221cc`'s fail-open shadow; the ratio
compressed, the mechanism is intact), rays/temporal/shade PASS,
`smoke:gi-gpu` default ×2 + [J] arm PASS.

Named follow-on: [J]'s compile is the critical path and it is marcher CALL
SITES (rolled lights / NEE / sun), not bytes — fold through ONE predicated
visibility call; an emission change owing an energy A/B (NEE pick stats
must hold).

---

### 12.54 ANALYTIC PCSS PENUMBRA — THE WIDTH PROBE LEAVES THE STATIC-BVH EMITTER ARM (2026-08-13, commit `3861491`)

Queue unit (2). The marcher's per-miss-pixel cost WAS the probe: 12
log-spaced `freeRadiusAtWorld` pyramid descents, whose lattice-inset bounds
were also the waffle (§12.51's capCut trim was a partial). The exact BVH8
hit already returns blocker distance, so penumbra is closed-form now:
`emitterShadowDist` (rgba16f, METRES — an rgba8 span normalization
quantizes to ~25 cm ≈ 30 texels/step) holds `reff·t_b/(dist − t_b)`; two
chained wide passes (the light channel's wide pass grown a world-width
mode — slot table/span/tanHalf drop out of its bindings) reconstruct the
penumbra in screen space. Chain: raw → filter → MID → wide₁ → WIDE →
wide₂ → emitterShadow; materials' contract untouched.

Load-bearing details: blocker search is OWN-WIDTH-FIRST then
average-over-shadowed (the light arm's `max` propagated a wedge's far end
into the contact band and dissolved the umbra — caught on the rig, with
the image); a 1 mm floor on hit widths is the occupancy sentinel (contact
≠ lit); tap acceptance RAMPS over one texel in world-width mode (a hard
cut renders 16 contour bands of a smoothly-growing radius; grain
0.0622→0.0453); width-probe creation is lazy so the records arm keeps it.

Rig: kernel **116 kB/247 ifs/23.2 s → 92 kB/188 ifs/3.3 s** (the §13.14.8
startup term); waffle lattice GONE at 4× zoom; `soft` 0.688→0.380 (the mud
— ~8k partial-shadow px on open floor with no occluder — deleted; ⚠
`grain` is not cross-arm comparable, its support changed; `grainAll` is,
0.0376→0.0366); width map monotone near 0.518 m → far 1.217 m, smooth (the
feared any-hit jitter does not show); resolution-invariant across
low/high/ultra; resize probe 0 errors ×4; smoke 2/2 at 8/8 storage.

⚠ WATCH: SLAB leak 0.3062→0.3862, decomposed clean — `nowide` reads
0.3062 BIT-IDENTICAL, so admission is unchanged and the +0.08 is the wide
passes pulling lit neighbours into a narrow fully-occluded strip (penumbra
the leak metric was never built to distinguish). Thin occluders in Sponza
are the live check. Open surfaces read exactly 1.0 where the mud had them
at 30-70% grey — emissives read brighter. Hatches:
`__giEmitterAnalyticPenumbra=false`, `__giEmitterWidePass=false`,
`__giEmitterWidthDebug=<m>`. New arms on `probe:gi-emitter-shadow`:
nopenumbra/nowide/widthmap/temporal.

### 12.55 THE SURPRISE DETECTOR WAS MANUFACTURING STILL-SCENE FLICKER (2026-08-13)

The user's re-report after the §12.52-54 wave: "flicker is still there,
smaller, but still there." The rig grew the SURPRISE_AB arm §12.52 queued
(still arms only, in-page interleaved ×2, `__giSrcSurpriseGain` 0 vs the
governor — gain is live-polled and the governor publishes 1 on a parked
scene, so "natural at rest" IS the fully-armed state):

    still reversals/px, ultra, user's Sponza (shipped 2/4 ramp, rate 0.25):
      armed 2.784  vs  gain-0 1.410   (+97%, round spread 0.164)

**The §12.52 detector was re-tripping on noise at rest and roughly DOUBLING
still-scene churn — about half of the user's remaining flicker.** Mechanism:
the ramp's 2σ trip is priced against the SHOT model, live noise is 1.78×
that (§12.52's own measured truth), and the drift EMA's σ is ~0.38 of its
input's — so 2σ-model ≈ 3σ of the drift's true spread: ~0.1-0.3% of
block-frames × thousands of resident blocks = several fires per frame, each
running fast decay on its block. The fixture's FP leg saw 0.11% and called
it absorbed; across a real scene it is not.

**Shipped: `SURPRISE_T0/T1` 2/4 → 3.5/6.5 and `SURPRISE_RATE` 0.25 → 0.45**
(srcConfig.js — CPU mirror and WGSL both read from there). The rate raise is
what keeps detection inside the temporal fixture's own gate at the higher
trip point: the drift EMA carries more of a step's Δ inside the 6-frame
detection window while its noise passband grows only as √(r/(2−r)).
Gates after: `test:gi-src-temporal` ALL PASS — detection 6σ (gate ≤6),
saturation 11σ (gate ≤12), self-termination 3 frames (was 8), noise fires
0/6400 at model σ and 2/6400 grazing u≈0.1 at measured σ (was firing at
u≈0.95 there). `test:gi-src-math`, `test:gi-src-rays` PASS.
`probe:gi-src-converge` t90 strided-12 = **0.92s** (§12.52.1 read 0.93) —
the ghost-regime win is intact.

Re-measured live (same arm, same discipline): armed 2.242 vs gain-0 1.448 —
**the armed excess halved (+97% → +55%) but is still 4.5× the round
spread.** The residual is expected: live per-frame block means are NOT
gaussian around M — R2 ray-set rotation cycles different ray directions
through a block per frame, a deterministic oscillation the shot-σ model
cannot represent and the faster EMA passes MORE of. **THE NAMED NEXT UNIT:
a per-block SELF-CALIBRATING noise scale** — normalize drift by an EMA of
|I−M| (the block's own measured innovation floor) instead of the analytic
shot σ; a block whose rays oscillate learns its own floor. Costs one more
per-block word (a sixth BSTAT region) + [D1''] publish + both mirrors +
the full gate battery — a dedicated unit, not a constants tweak. The paper
§8.1's "multi-scale mean estimator" is this.

⚠ INSTRUMENT NOTES for whoever re-runs: the SURPRISE_AB verdict text
prints the same fix hint regardless of magnitude — read the numbers, not
the hint line, when judging a partial fix. And the arm inherits every rig
discipline: in-page only, ×2 interleaved, gain-0 spread is the noise floor.

**CROSS_LAG (§12.46.3's "correct instrument") IS ALSO BUILT** — same rig,
`CROSS_LAG=1 CROSS_ALPHA=0.1,0.02`: parked-truth at the eased curve's
midpoint (default-α truth, mode-−1 pipeline warmup against the §12.52.2
first-dispatch skip), then per-pixel pass-mean accumulation at each
midpoint crossing, ascending/descending kept separate, first post-α-switch
cycle discarded. Self-check refuses the verdict if lag falls as α falls
(the netSettle failure mode). Results land in the session log / memory.

#### 12.55.1 CROSS_LAG RAN — THE α TRADE IS PRICED, AND THE LAG SIDE IS A BOUND

Three runs, each self-contained (per-arm parked truth):

1. First estimator (mean-|per-pixel pass-mean|) SELF-REFUTED exactly as the
   §12.46.3 note predicted — E|X| noise residue at 6 passes swamped the lag
   and the α ordering came out inverted. The instrument refused the verdict;
   the refusal worked.
2. Rebuilt on the ANTISYMMETRY estimator: the field trails the sun, so lag
   structure at ascending crossings is the NEGATIVE of descending ones,
   while noise and truth-side bias are direction-blind. With mU/mD the
   per-pixel pass-means, `lagRMS = sqrt(max(0, Var((mU−mD)/2) −
   Var((mU+mD)/2)))` cancels the noise bias to first order AND cancels any
   systematic swing-vs-rest level shift (it lands in the symmetric field).
   Result (ultra, user's Sponza, eased curve H=300, 5 cycles, in-page):
   **lagRMS 0.00000 at BOTH α=0.1 and α=0.02** — noise floors 0.030/0.024
   luma RMS. No resolvable lag at either α.
3. VALIDATION ARM — α=0.02 with `CROSS_GAIN=0` (surprise OFF, so nothing
   per-block can bound a raw EMA lag): still lagRMS 0, and the TOTAL
   per-pass |diff| read **0.0062 luma ≈ 2% of mean** — where a naive
   τ≈50-refresh EMA lag (~12° of sun angle) should have dwarfed it. The
   "surprise bounds the lag" hypothesis is REFUTED; the honest reading is
   that on this scene the BOUNCE field's angular gradient at the crossing
   is small enough that even naive-EMA staleness costs ~2% instantaneous
   luma error. (The α=0.1 arms read HIGHER per-pass |diff| — 0.023-0.025 —
   because at α=0.1 the diff is variance-dominated: the noisier α reads as
   MORE total error at the crossing than the laggier one.)

**THE TRADE, QUOTABLE: on the user's scene and their own sun curve,
α=0.02 under sustained smooth rotation costs ≤2% instantaneous luma error
(unresolvable lag + less noise than α=0.1) and buys the §12.46.3 34× churn
cut.** The α-under-rotation ship is therefore de-risked ON THIS EVIDENCE:
make the α ramp edge-aware the way §12.46 made the WINDOW edge-aware —
sustained saturation of `sceneMotion` (no rising edge for ~2s) slides the
tracked α from TEMPORAL_ALPHA down toward ~0.04; any edge restores it.
⚠ THE MISSING GATE, named before anyone ships this: a MID-ROTATION STEP
arm. §12.46's rising-edge arming needs an 800ms sub-threshold dwell, so a
step landing DURING continuous rotation re-arms nothing TODAY — currently
covered by the always-fast swing α; after this change it would lean
entirely on per-block surprise (§12.52), whose live still-scene behavior
§12.55 just showed is not yet trustworthy. Build the arm (LIGHT_STEP
landing mid-ROT_EASE), then ship. Do not ship on the existing arms alone.

Rig knobs added this session: `SURPRISE_AB=1`, `CROSS_LAG=1`,
`CROSS_ALPHA`, `CROSS_CYCLES`, `CROSS_ROUNDS`, `CROSS_GAIN`. All arms
in-page, ×2 interleave where cheap, per-arm truth where not.

### 12.56 EMITTERS × EXACT REFLECTIONS — THE RESOLVE'S HIT-PATH EMITTER MARCH (2026-08-13, uncommitted)

**The user's "a few emissive lights → 5 fps at ultra" is an INTERACTION term, not an
emitter cost.** Live MCP repro on their Sponza (dGPU, viewport unfreeze, ultra, SSR on):
baseline 42 fps / 21.5 ms GPU with 0 emitters; THREE 0.4-scale emissive spheres
(CannonBall.mat) → 9 fps / 101.5 ms. `profile.giPasses` attribution: **`resolve`
1.67 → 60.35 ms** (1640×912), `emitterShadowPass` 14.0, SRC chain FLAT at 4.4 ms,
rays capped at ~25.6k throughout (§12.48's pose cache held — each sphere armed the
light-track window exactly once). SSR itself is 2.4 ms (toggle A/B) — not the story.

**Mechanism, read at source:** their scene has a bucket-0/3 material, so the
exact-reflection prepass runs — and `#bvhMaskEnabled()` has been a dead opt-in since
2026-08-04 (`=== true`, the `__giSrcSecondary` polarity trap; its own doc comment said
"on by default"), so it runs **DENSE full-screen, hit-shaded**. The resolve's
`bvhShade` branch shades every hit pixel with `emitterDirectAt` **without**
`shadowSample` (a hit is a different world point than the pixel), which runs the full
`emitterSlotShadow` record-march + BVH descent inline, per slot, per pixel. Enclosed
scene ⇒ ~every reflected ray hits ⇒ ~1.5M px × 3 slots × ~13 ns.

**Rig:** `run-gi-emissive-cost.mjs` gained `MIRROR=1` (floor roughness 0.3 = bucket 0,
quality defaults ultra — exactReflections exists only there) and `ENCLOSED=1`
(walls+ceiling; an OPEN mirror rig reflects the sky, every ray MISSES, and the branch
under test never executes — the first two runs measured nothing and looked green).
Camera parks INSIDE when enclosed. In-page 0→4-emitter sweep, Δresolve:

| arm | Δresolve (0→4 emitters) |
|---|---|
| dense + trace-all (= what shipped yesterday) | **+9.35 ms** |
| masked + trace-all | +4.37 ms (image BROKEN, see below) |
| dense + hit-trace diet 24 (**NEW SHIPPING**) | **+1.29 ms (7.3×)** |
| masked + diet | +0.82 ms (image broken) |

**SHIPPED — the hit-path trace diet:** `emitterSlotShadow` gained
`params.traceCutoffScale` (default 1 = unchanged); the resolve's hit call site passes
`__giHitEmitterTraceScale` (default **24**, baked at build). Above-gate slots trace as
before; dimmer slots contribute **unshadowed** — a deliberate, BOUNDED exception to
the show==trace coupling: leak ≤ 24 × emitterCutoff ≈ 0.036 luma, only inside
reflections, traded against a per-pixel BVH march whose reach otherwise grows as
cutoff⁻¹. Dedicated emitterShadowPass and the legacy in-material arm take `?? 1` —
byte-identical. Rig shot dense+diet vs dense+trace-all: visually equivalent (lamp
pools, crate contact shadows intact). Gates: test:gi-emitter-shapes 795 ✓,
test:gi-src-shade ✓, test:gi-rayhit-shadow ✓. ⚠ test:gi-lightvis "component disabled
stops GI" FAILS — **verified pre-existing on a clean HEAD worktree**, not from this.

**SHIPPED — GI_MIRROR_LAYER tagging (the mask's missing half):** #collectMeshes now
tags bucket-0/3 meshes into GI_MIRROR_LAYER (harmless under dense; stale tag = cost,
never a wrong image). **REVERTED same-day — the mask default flip:** with tagging in
place, masked boots render a BROKEN frame on the enclosed rig (white/black split where
dense lights correctly, at live=0 too), and `scripts/run-gi-mask-bisect.mjs` shows
stopping the mask pass LIVE does not recover ⇒ the fault is masked-prepass/consumption
side, not the second gbuffer render. `__giBvhMask` stays opt-in; the mask unit is
queued with rig + bisect script and a real prize (halves the interaction term again).

**OPEN, filed here:**
1. **Masked-mode broken frame** (above) — diagnose with `MIRROR=1` rig + bisect.
   **REFRAMED 2026-08-14 (extended bisect, per-stage stats both arms):** NOT a
   mask-data bug. Two masked boots of the same rig, same code, minutes apart:
   one healthy (gather lit 141,602/141,602, secondaryHits 16,972), one fully
   dark with `secondaryHits: 0, maxL: 0, gather lit: 0` while rays/hits/
   deposits/merge ALL count normally — §12.53's documented signature of [J]'s
   PIPELINE silently failing to create (nothing shades ⇒ black GI), with ZERO
   console errors either boot. The mask flag changes compile batching enough
   to move the odds, which is why brokenness correlated with masked boots; the
   §12.56 "white/black split" is plausibly the same race landing on a
   different pipeline. Same family as the OPEN occluder-pipeline race
   (occlusion-culling ledger) and the "first frame after compile wave took
   NNNms — pipelines recompiled at resume" warnings. The extended
   `run-gi-mask-bisect.mjs` (per-stage stats + dense control page) is the
   instrument; the detection signature is `secondaryHits == 0 && shaded > 0`
   on a settled frame. **WATCHDOG SHIPPED AND VERIFIED (2026-08-14):** one
   async readback 5 s after the compile wave resumes; on the signature it
   console.errors "[gi] DEAD SHADING PASS …" naming this section — fired on
   the very next dead masked boot, silent on the healthy dense arm. The
   AUTO-RETRY (rebuild [J]'s pipeline on detection) stays FILED — the race's
   root cause (why an async compute pipeline validation-fails
   nondeterministically, also the occluder pass's open bug) is the real
   target, and it needs a Dawn-level error-scope capture to even name the
   failing pipeline.
2. **Plain-prop emissive .mat never promotes**: a material_create'd .mat with
   `emissive/emissiveIntensity` as flat fields (no shader graph) reads `emitters: 0`
   while the graph-emissive CannonBall promotes instantly on the same mesh in the same
   scene. resolveMaterialSurface handles flat `.emissive` — suspect the .mat→material
   application path. User-facing: "my emissive material doesn't light".
3. **`emitterShadowPass` is now the emitter pole again** (14 ms / 3 emitters on Sponza
   ultra at 902×502): reach is priced by `emitterCutoff` (area ∝ cutoff⁻¹) — the
   next lever after the two above.
4. test:gi-lightvis pre-existing failure (above).

#### 12.56.1 THE DIET WAS NOT ENOUGH LIVE — HIT-PATH EMITTER SHADOWS GO UNSHADOWED BY DEFAULT (2026-08-13, same session)

**User: "a little better, still 10 fps." Their editor HAD reloaded (171kB resolve kernel
in the boot log) — the diet was live and weak: resolve 60.35 → 49.6 ms.** Two wrong
assumptions found and priced on their REAL content:

1. **The luma gate is ABSOLUTE and their lamps are strength 100** (CannonBall.mat;
   the rig validated at strength 8). A strength-100 lamp keeps earning marches to
   ~14 m ⇒ the gate never fires indoors on Sponza.
2. **Cost is per-INVOCATION, not per-metre.** A 4 m march-length cap
   (`maxTraceDistance` through emitterSlotShadow, `__giHitEmitterMarchCap`) moved the
   real-Sponza arm 10.96 → 10.21 ms (−7%). The BVH descent setup dominates; ray length
   does not.

**The ceiling arm settled it:** `run-gi-hitcap-sponza.mjs` (new; tauri-shim boots the
REAL GAME project read-only, spawns 3 CannonBall spheres in-page at the same pose as
the live MCP repro, reads profile.giPasses) — trace-nothing reads **resolve 0.27 ms vs
10.96 traced** (806×392; editor scale ≈ 2 vs 50 ms), and the A/B screenshots are
**INDISTINGUISHABLE** on their scene. So emitter shadows inside reflections buy nothing
visible here while costing ~the whole resolve. **Shipped: the hit path defaults to
`shadowSample: () => 1`** — same trade analyticDirectAt documents for lights, and the
shadowSample shape keeps the marcher OUT of the resolve WGSL (the traced resolve was
the boot's slowest pipeline at 22.9 s — this is also a §13 startup win).
`__giHitEmitterShadows = true` restores tracing with the §12.56 gate+cap dials.
Gates re-run green (emitter-shapes 795 / src-shade / rayhit-shadow). Editor-scale
expectation, 3 emitters at ultra+SSR: GI ≈ resolve ~2 + emitterShadowPass ~13 + src ~5
⇒ the emitter pole is now **emitterShadowPass** (§12.56 open item 3, reach ∝ cutoff⁻¹).

⚠ Live-editor session noise, recorded: baseline GPU read 21.5 ms and 41.6 ms for the
SAME scene/pose two hours apart (0 emitters both times, GI flat at ~8 ms — NOT GI;
three assistant sessions were live-editing framePacing/occlusion at the time), and the
unfocused-viewport path presents 9 fps where unfreezing reads 21 fps on the same frame.
Their scene also sits at the 16-mover cap with 15 never-moved movers (engine warns;
`giMobility: static` on the props is the user-side fix).

### 12.57 "STILL LOW FPS ON EVERY PRESET" — THE FRAME WAS POWER-CAPPED, NOT PASS-BOUND (2026-08-13, evening)

User: "still very low fps even on lower quality presets; we need 60 fps on ultra."
Live Sponza, viewport 1642×974, ultra, SSR on, 0 emitters: **30 fps / 30.8 ms GPU
(real timestamps), CPU 5.9 ms.**

Attribution first — the per-pass ledger at that state:
- GI real steady state ≈ **11.5 ms**: srcProbes 9.6 (deposit 2.9, gather 2.8,
  tiles 0.95, shade[J] 0.92, populate 0.87, rest ~1.1) + resolve 1.9. The 1.9 ms of
  `lightShadowFilterPass`/wide entries in `queueMs` was a PROFILER ARTIFACT — the op
  times raw `state.queue` nodes; the frame loop's `frameSkip` never dispatches them
  (no light uses Shadow Source "gi"). `profile.js` now annotates those entries
  "NOT dispatched" and excludes them from `queueTotalMs`.
- Then the eliminations that refused to eliminate: PP/SSR off → 31.3. Shadow map
  frozen → 31.5. `castShadow` off entirely → 31.7. MSAA 4→1 → 32.3. **Four
  removals, zero movement** — the classic fingerprint of a clock ceiling, where
  removed work just redistributes inside a fixed power budget.
- renderScale 0.5 → **11.9 ms / 67 fps** — the frame IS per-pixel bound, it's the
  per-pixel RATE that's absurd (≈16 ns/px of beauty+GI on a Lovelace chip).

The rate had a reason: **`nvidia-smi -q -d PERFORMANCE,POWER` — RTX 4070 Laptop at
P4, 1410 of 3105 MHz, 100% utilization, Current Power Limit 33.00 W (default 55,
max 90), `SW Power Cap: Active`, `SW Thermal Slowdown: Active` at 69 °C, throttle
counters at 12+ hours.** 33 W is the ASUS ROG Zephyrus G14's SILENT-mode dGPU cap.
The user-side fix is one keypress (Fn+F5 / Armoury Crate → Performance or Turbo);
expected ≈2.2× on every GPU number, i.e. this exact frame lands ~14 ms ≈ 60 fps on
ultra with SSR at viewport res. §12.56.1's "baseline doubled 21.5→41.6 ms same
scene" almost certainly = this cap engaging/releasing, and every ladder in §12
measured on the editor today carries an unknown clock state. Rule going forward:
**record the power state next to any editor measurement** (the harness Chromes run
the same silicon under the same cap).

Engine-side facts this session still banked:
- **Scene Settings' shadow `autoUpdate` was dead wiring on WebGPU** — three r185's
  `ShadowNode.updateBefore` gates on the PER-LIGHT `shadow.needsUpdate ||
  shadow.autoUpdate` and never reads `renderer.shadowMap.autoUpdate`. Fixed:
  `applySettingsToScene` mirrors the setting onto every light (gi-mode lights stay
  frozen; a freeze with no rendered map forces one render first — the null
  `depthTexture` crash), and `LightComponent#configureShadow` initializes new
  lights from `engine.settings`. The 4096² sun map on static Sponza re-rendered
  every frame all along (56 draws / 264 k tris); with the checkbox now real, a
  static scene can actually freeze it.
- Full frame = scene rasterized 4×: beauty 75 draws + shadow 56 + a full-res
  depth-only prepass 41 (PP input) + occluder 24 (which still culls 0/33 — the
  camera has `occlusionCulling: "on"` overriding the scene's off; recommend off in
  Sponza).
- Next engine cuts, in order, ONCE REMEASURED UNTHROTTLED: srcProbes cadence
  (9.6 ms is preset-independent — the "lower presets don't help" half of the user's
  report is real and lives here), GI resolve scale on ultra (resolve+gather+
  emitter chain are per-resolve-pixel), dedupe the PP depth prepass against the
  gbuffer, R19 mover units a/b.

### 12.58 EMITTER SEATS FOLLOW THE CAMERA (2026-08-13, evening — uncommitted)

User: "after 3-4 emissives, all other emissives do not emit any light." Mechanism:
`MAX_EMITTERS = 4` analytic slots ranked by raw emitted power (luminance·r²) with
sticky 1.5× hysteresis — camera position played no role, so the four highest-power
lamps ANYWHERE held every seat forever, and an un-promoted lamp shows only its field
transport (~17% of the energy, lightTree.js header) → next to a promoted neighbour it
reads as OFF.

Shipped: `#chooseEmitterSeats` (extracted from `#buildEntries`) scores by APPARENT
brightness — power/(1+d²) to `engine.camera` — and `#checkFingerprint` re-asks the
seating question every 250ms scan (a camera move never touches the mesh fingerprint,
so the re-rank must ride the scan loop; a changed answer nulls the fingerprint and the
flip goes through the sanctioned reconcile: slot re-surface → atlas revision →
composite, EMA cut). Sticky seats + the 1.5× ratio survive unchanged — on a
camera-relative score the ratio is hysteresis in DISTANCE, so turnover happens at
door-to-door walking cadence, never per scan. No camera (headless) = raw power, the
old ordering.

Verified `scripts/run-gi-seat-follow.mjs` (NEW; vite 5201): 8 identical lamps on a
ring — (A) camera by lamp 0 seats exactly the 4 nearest; (B) jump to the opposite
side, seats follow within a few scans; (C) 6s still camera, zero seat changes.
ALL PASS. ⚠ Harness trap worth keeping: park the probe camera at an ANGULAR OFFSET
from a lamp — dead-on is mirror-symmetric, the 4th/5th nearest tie EXACTLY, and the
tie-break is arbitrary (first run "failed" on an equally-correct seat set).

NOT the endgame: the cap itself stands. `lightTree.js` (CPU half built, UNWIRED —
srcShade.js:81) is the real many-lights design: O(log n) tree descent per shading
point, no promotion boundary at all. Seat-following makes the 4-slot budget spend
itself on the lamps the player can see, which is the honest interim.

### 12.59 DARK-AREA FLICKER: A REAL STILL-SCENE BASELINE AT LAST (2026-08-13, night)

User: "in darker areas it is very flickering." The per-frame instrument
(`run-gi-flicker-frame.mjs`) needed THREE fixes before it measured anything real —
each one a way to report a FLAWLESS ZERO on a broken run:
1. It grabbed `_giTargets` before the quality-override rebuild replaced them →
   accumulated over a dead texture. Now waits for `_rebuildQueued` clear + 60
   stable frames, AND fails loud ("INSTRUMENT FAILURE") when a MOVING mover
   produces zero changed pixels — flawless zeros are never printed silently again.
2. It PINS `__giSrcProbes` OFF by default (written pre-Phase-5, when SRC was the
   experiment); on today's engine that leaves the sampled resolve unwritten.
   `SRC=1` is MANDATORY for any current measurement (it also sets the sky).
3. (Same class, fixed in the outline repro: puppeteer reports console.warn as
   type "warn", not "warning" — exact-match filters silently eat every warning.)

The baseline, real Sponza, ultra, SRC live, 806×392 @ 240 frames:
- STILL scene: **0.468 reversals/px, step p95 0.026** — a still scene should sit
  near zero; this residual oscillation IS the user's dark-area shimmer, and the
  histogram shape (280 881 px at 0 reversals vs 8 741 px above 10) says it is
  CONCENTRATED in a minority of pixels, which matches "darker areas" (low
  evidence rate → high relative variance).
- MOVING (sub-voxel sinusoid): 0.823 rev/px (+76%), step p95 0.2422 (+826%).

Next: bisect the still-scene residual with the existing arms — CAP_AB (per-probe
ray cap variance on low-evidence probes), SURPRISE_AB (§12.52's per-block α),
and the light-track window (this evening's console shows it re-arming off the
SHADOW signal at peak 453 on a still scene — every arm lifts the ray cap and
re-rolls the noise, which presents exactly as shimmer). §12.55 closed the
surprise-detector half; this 0.468 is what remains.

### 12.59.1 THE STILL-SCENE BISECT: EVERY RESIDENT SUSPECT ACQUITTED — THE FLICKER IS CAMERA-MOTION CHURN (2026-08-14)

Three A/B arms, one page, real Sponza ultra + SRC (`run-gi-flicker-frame.mjs`,
SURPRISE_AB + TRACK_AB + CAMERA_AB; CAP_AB ran in its own page first):

- **Ray cap: acquitted.** capped 0.221 vs off 0.246 rev/px — the CAPPED arm is
  no worse (−10%, inside spread). §12.38's calm survives the cap.
- **Surprise detector: acquitted at rest.** armed 0.215 vs gain-0 0.208 (+3%).
- **Tracking window: acquitted at rest.** still on/off IDENTICAL (0.235/0.235).
  Moving arms: reversals +3% (noise) but step p95 +73% (0.0417 vs 0.0240) — the
  window's fast decay does amplify pop amplitude during real motion; that is
  its designed trade (responsiveness), noted, not the still-scene bug.
- **Camera pan: THE FINDING.** ±25° pan–hold: pan-window reversals 0.69–0.77/px
  with **step p95 ≈ 3.14** (the clean still reads 0.015 — a ~200× amplitude
  jump), CAP-INVARIANT (capped and off arms within spread on every column), and
  the churn OUTLIVES the pan: post-pan stills read 0.18–0.35 against the page's
  clean 0.204 floor, still elevated a full 270-frame arm later. The rig's own
  verdict line: **look at fresh-probe seeding/α, not the ray budget.**

Mechanism this points at: camera motion anchors FRESH PROBES for newly-visible
gbuffer pixels; they start with no history, seed at full variance, and converge
in view — which the eye reads as dark-area shimmer while navigating (dark = low
absolute signal = highest relative amplitude; the user's exact report). Next
unit, in order of expected value:
  (a) seed a fresh probe from its CASCADE PARENT / spatial neighbours instead
      of zero history (the field already holds a converged coarser answer);
  (b) a per-probe age-scaled α so newborn probes drink evidence fast but
      RENDER at reduced weight until variance settles (confidence-weighted
      resolve blend);
  (c) re-anchor hysteresis: §12.43's reanchor already slides whole cells —
      check whether pans re-anchor MORE probes than the view change requires
      (reanchors: 1 per profile snapshot looked sane, but that was one pose).
Baseline bookkeeping: page-to-page still floors ranged 0.20–0.47 across the
night's runs — only in-page interleaved arms are quotable (the instrument's
own warning, now measured twice over).

#### 12.59.2 THE SEED UNIT, SPECCED (implementation spec — next work unit)

§12.52's COLD FILL is a RAY-BUDGET lift (×4 for 4 frames) — newborn bins still
converge FROM ZERO in view, and the §12.59.1 pan A/B is the CAMERA_VERIFY arm
§12.52 left open: cap-invariant churn proves faster intake does not hide the
convergence. The fix is a RADIANCE PRIOR, not more rays:

**Seed pass** (new, in the populate group, after compaction — PROBE_PARENT
holds the parent probe INDEX only after compaction resolves it, §srcProbes
PROBE_PARENT comment):
- select: probes with `FLAG_FRESH` set AND `PROBE_PARENT != SLOT_EMPTY` AND a
  claimed `PROBE_BLOCK`;
- for each bin direction of the child, sample the PARENT's bins at the same
  world direction — srcMerge already owns the parent↔child angular resampling
  (reuse its mapping, do not re-derive);
- write the parent's mean as the child's starting accumulator value with a
  modest effective sample count (start conservative: the equivalent of ~8
  frames of evidence — enough to kill the from-zero swing, small enough that
  real local evidence dominates within ~1/α);
- root cascade (no parent): fall back to the probe's spatial neighbours at the
  same cascade, and if none, today's from-zero behaviour.
Known traps that WILL bite (from §12's ledger): compute binding budget is 8
per pass; `atomicStore` not `.assign`; TSL `Return()` inside `Fn`.

**Verification** = the §12.59.1 pan arm, unchanged: PAN EXCESS over own still
(0.543 capped / 0.462 off) and the post-pan elevated stills (0.22-0.35 vs
0.204 floor) are the two numbers the seed must move; the still floor itself
(~0.20, all suspects acquitted) is NOT expected to move and serves as the
no-regression control. Run `SRC=1 CAMERA_AB=1` before AND after on the same
build; only in-page arms are quotable.

#### 12.59.3 THE SEED SHIPPED AND HOLDS — PAN EXCESS ÷9.6 (2026-08-14, uncommitted)

Implemented as specced, with one design upgrade and one ordering trap the spec
had not priced:

- **The prior reads the parent's MERGED payload, not its accumulator.** The
  merged answer is full-range (own interval + ladder + sky) — the same domain
  the child's bins reach after ITS merge — and the handover is STATIONARY: a
  clear-truth bin resolves `L = W·Lp/(W+w), T = w/(W+w)`, its merge adds
  `T·Lp`, total `Lp` at every w. A raw-accumulator seed would describe the
  parent's own 2× interval AND be double-counted by the child's merge.
  `srcSeed.js`'s header carries the argument.
- **The deposit's decay ZEROES blocks claimed this frame** (the stamp check),
  so a seed pass in the populate group is silently wiped every frame and
  renders exactly like not existing. The seed dispatches between
  `deposit.decay` and the scatter; writes are `atomicAdd` (commutes with [E],
  correct anywhere in the decay→resolve window). Third trap, dodged by flag:
  a parent that is ITSELF fresh has a previous owner's stale payload —
  skipped and counted (`SEED_COLD`).
- Cascades 0..N−2 only; the top-cascade spatial-neighbour fallback stays
  DEFERRED (below: the demand signal did not materialize).

`SRC=1 SEED_AB=1` (storm-free Sponza page, ±25° pan–hold ×2, interleaved ×2,
liveness gate on the mid-pan readback — on: 192/347 bins seeded, off: 0):

    PAN EXCESS over own still:  seed-on 0.086   seed-off 0.827   (spread 0.022)
    post-pan stills:            on 1.253→1.298  off 1.160→1.139  (floor 1.260)
    pan step p95:               on 3.12         off 3.11         (unchanged)

⇒ **÷9.6 on the §12.59.1 mechanism**; a seed-on pan is statistically near its
own still. The still floor did not move (the all-suspects-acquitted control).
Residuals, both filed rather than open: (1) step p95 unchanged — the seed
kills the OSCILLATION, not the single first convergence step of a
newly-revealed surface; (2) mid-pan `cold` 106–312 vs 10–18 seeded — the pan's
leading edge births whole ladders in one frame, so most edge probes still
start cold, and the excess STILL fell 9.6× — the seeded interior/trailing
fills evidently carried the visible churn. If a future report names the
leading edge, the spatial-neighbour fallback (same-cascade, root included) is
the specced next step and `SEED_COLD` is its demand instrument.

Files: `srcSeed.js` (new — passes, stats, `formatSrcSeed`), `srcConfig.js`
(`SEED_RAYS = 6` ≈ 8 frames of 0.78 rays/bin, just under the decay's steady
state so a newborn is never harder to move than a settled bin), `srcSystem.js`
(build hatch `__giSrcSeed`, live dial `__giSrcSeedRays` polled per frame,
passGroups split, seed telemetry in readStats + debug line),
`run-gi-flicker-frame.mjs` (`SEED_AB=1` arm + mid-pan liveness readback).

### 12.60 THE STILL FLOOR SPENDS ITS BANKED HEADROOM — ALPHA_STILL 0.05 → 0.02 (2026-08-14, uncommitted)

User (post-seed build live in their editor): "flicker is still present" — with the
pan churn fixed (§12.59.3), what remains AT REST is the §12.59 still floor:
per-pixel ray-noise VARIANCE, worst in dark pixels (largest relative amplitude —
and their Sponza currently has NO environment, so dark areas are single-bounce
lamp light with no fill at all; recommended user-side regardless).

The lever was measured and priced in §12.38's ALPHA_SWEEP table: still floor
1.15 rev/px at α_still 0.05 → 0.40 at 0.02 (÷2.9). It shipped at 0.05 ONLY for
the light-toggle convergence trade — "intensity changes are invisible to the
motion signal" — with the extra 2.9× explicitly banked as "headroom for when an
intensity-delta joins the motion signal". §12.43 then built exactly that (the
tracking window's `lightLum` arming term, driven by real prop-path intensity
steps in the LIGHT_STEP harness), so the toggle now converges at the WINDOW's
rate whatever the still floor is. The headroom is spendable; spent.

Gate (`SRC=1 LIGHT_STEP=1` on the 0.02 build, one page, interleaved ×2):
shipped 4.03 rev/px per step arm vs no-lift 11.40 vs window-off 0.46 (spread
0.318) — "THE WINDOW CAP LIFT HOLDS", i.e. step convergence still rides the
lifted evidence rate and re-caps after. In-page still control 0.517 rev/px.
One constant changed (`TEMPORAL_ALPHA_STILL`); `motionOf`/lift/surpriseF all
derive from it and recompute. Note `surpriseF` at rest is now 5 (was 2) — a
surprised block forgets 5× faster relative to the slower floor, which is the
mechanism's intent (surprise means the truth moved).

### 12.62 LIGHT-TREE WIRING — THE STAGED PLAN (recorded 2026-08-14; execution next)

`lightTree.js` is COMPLETE CPU-side (1,129 lines, `test:gi-lighttree` PASS —
`estimateLightTree` converges to 0.013% of reference; block layout, importance,
sampling and pdf all mirrored and gated) and has ZERO consumers. §12.58's
camera-apparent seats mitigated the user's "4 emitters then nothing" report;
this is the endgame that removes the cap entirely. The wiring is a MULTI-UNIT
migration — one unit per consumer, each with its own gate, never a big-bang
swap (a tree-sampled emitter and a promoted one must deliver the SAME number
or the migration itself is a visible change — the file's own header):

- **Unit W1 — build + upload. ✅ SHIPPED + GATE PASS (2026-08-14).** GISystem
  builds the block right after `#buildEntries` (⚠ NOT inside
  `#buildOccupancyField` — the field builds BEFORE the entries walk, so
  `_emitterCands` is always null there; the gate's first FAIL caught exactly
  that) over the seat-candidate meshes, `allocPoolWords` +
  `queueRegionUpload` — the static shadow BVH's own allocator and staging
  queue, zero new bindings. Publishes `__giLightTreeLive`
  {abs,rel,words,counts,power} and a boot line. Hatch: `__giLightTree=false`.
  Gate `run-gi-lighttree-upload.mjs`: PASS — 4 emitters / 1 node / 244 words
  round-trip off the GPU with exact counts and f32-exact totalPower, static
  BVH header as the known-good control. ⚠ GATE TRAP, PAID TWICE: an in-page
  copy kernel built from a SECOND `three.tsl` import over the app's `bits`
  node renders ZEROS with no error (the duplicate-three trap in harness
  costume — both the tree region and the known-good control read 0, which is
  what indicted the read path). Whole-buffer `getArrayBufferAsync` + slice is
  the honest read. Incidentally: the dead-[J] watchdog fired on 2 of 4 gate
  boots — the §12.56 race frequency holding on an UNMASKED rig.
- **Unit W2 — WGSL descent, twin-gated. ✅ SHIPPED + GATE PASS (2026-08-14).**
  `sampleLightTree`/`clusterImportance`
  as TSL/WGSL against the block, diffed bit-level against the CPU mirror on a
  seeded RNG (the srcRef discipline; the CPU side already exists as the
  mirror). No consumer yet — a standalone gate kernel only. Traps by
  construction: the 8-storage-buffer ceiling (the block rides `bits`, costing
  ZERO new bindings — that is the whole reason W1 stages it there), and
  `hashKey`-based rng (u32-pure, §srcShade's divide caveat).
- **Unit W3 — [J] first. ✅ WIRED + FIXTURE GATE PASS (2026-08-14 — §12.69;
  hatch `__giSrcLightTree`, default OFF pending the live energy arm).**
  `createSrcHitLighting`'s NEE swaps the 4-slot
  emitter loop for ONE tree sample + pdf (the `importance` parameter at
  srcShade.js:81 was left for exactly this). [J] is the right first consumer:
  its output is temporally accumulated (variance-tolerant), and §12.26.5
  priced bounds-based ranking at 3.00× standard error — the tree's
  cone-bounded importance must be A/B'd against that number, not asserted.
  Gate: §12.26.7's energy arm (analytic-on vs tree, mean over a region) plus
  the flicker harness still floor.
- **Unit W4 — the resolve's emitterDirectAt + emitterShadowPass.** The
  screen-side swap, priced by §12.56.1's ledger (emitterShadowPass ~13-14 ms
  with 3 emitters is the emitter pole — the tree turns O(slots×pixels) into
  O(log n×pixels) and unifies the reach question with the importance cut).
- **Unit W5 — retire the promotion path** (slots, seats, `MAX_EMITTERS`, the
  R5 zeroing handoff moves to the tree's NEE set). Only after W3+W4 hold
  their energy gates on the real Sponza.

### 12.61 THE REST CADENCE — THE PRESET-INDEPENDENT 9.6ms GETS ITS FIRST CUT (2026-08-14, uncommitted)

§12.57 queued "srcProbes cadence" as the next engine cut and the re-run cost
probe (group parsing fixed for the §12.53/§12.59.2 group splits) finally put
per-group numbers on the ultra chain. At scale 1.00, 210,635 rays: deposit
(trace+attribute) 7.58 · [J] 2.72 · decay 1.12 · resolve[F] 1.06 · everything
else ~1.8 = chain 14.30 ms (33 W-capped silicon; ratios are the claim). The
three-arm least-squares: **deposit ≈ 3.7 ms floor + 42.2 ns/ray — rays are 71%
of the deposit.** Two prior hypotheses died here: resolve-scale work cannot
move the SRC chain (gather is 0.33 ms — the per-resolve-pixel cost lives in
the SCREEN chain, §12.57's resolve 1.9 + emitter passes), and the bin-pool
passes are a 2.2 ms floor, not the pole.

**Shipped: the transport ceiling scales down AT REST.** §12.60's α 0.02 is
what makes it affordable — a parked scene accumulates ~50 frames, so half the
rays reach the same steady state at a √2 variance cost the ÷2.9 dwarfs. The
drive term is `max(mLight, tr, camTerm)`: the α motion ramp, the §12.43
tracking window, and camera recency (600 ms hold + 400 ms FADE — a budget
step on the frame a pan ends is R1's cliff in miniature; deltas now computed
unconditionally, the §12.47 cap lift stays opt-in and unchanged). Every term
inherits the arming discipline its own mechanism already paid for. The decay's
stride ROOT reads the post-cadence stride — the ceiling poll MOVED above the
keep computation, closing a pre-existing one-frame root/stride skew that only
mattered when the ceiling moved per-frame. `restFactor` is published on
`__giSrcTransport` and `__giSrcRestFactorLive` (the §12.42 "a number nothing
prints" rule). Hatches: `__giSrcRestCadence=false` (off), `__giSrcRestFraction`
(live dial); a pinned `__giSrcTransportRays` is never scaled.

All 10 `test:gi-src-*` node suites pass on the combined tree (seed + α + rest).

**The receipt (same machine, minutes apart, same-px arms):** parked scale-0.50
arm pre-cadence chain 15.43 ms / deposit 14.29 → post-cadence 9.78 / 8.64
(−37% / −40%), the trace group EXACTLY halved (9.35 → 4.62 ms) and the image
byte-similar (mean 0.1603 vs 0.1599, lit 70.8/70.7%). Editor-scale
expectation: srcProbes ~9.6 → ~6 ms parked, full budget the instant anything
moves. TWO TRAPS PAID FOR SHIPPING IT: (1) `publishTransport` runs at
CONSTRUCTION and the first draft declared `restFactor` 500 lines later — the
TDZ ReferenceError silently cost the ENTIRE SRC build and rendered a 4.7%-lit
black scene with no error anywhere near the cause (the cost probe's "prewarm
1 kernels" line was the tell); (2) the boot hold (`REST_BOOT_HOLD_MS` 3 s,
same hold+fade shape as the camera term) — the fill-from-black is the one
convergence the seed cannot prior, and the camera term alone gave it ~1 s.
⚠ The cost probe's "traced rays"/stride columns parse the BOOT line, which
reports build-time values — under the cadence the SETTLED rate is the factor
times that; read the group table, not the rays column, on a parked page.

### 12.63 THE RESIDUAL FLICKER IS THE PAN'S AFTERMATH — MEASURED ON THE REAL SPONZA, AND THE CAMERA-SETTLE α FLOOR (2026-08-14, uncommitted)

User (with §12.59.3 + §12.60 + §12.61 live in their editor): "AO is great, but
the flicker still persists." The rig arms were all green, so this round was
measured ON THEIR SCENE — `run-gi-sponza-flicker/panab/stats/heatmap.mjs` boot
the real GAME project read-only (tauri shim) and run the flicker harness's
accumulator over the live resolve. What the tour established, in order:

- **The console's constant `emitter slot 0 motion` lines are PLAY-MODE
  physics** (launched emissive balls rolling; `peak 344` = a pooled ball
  parking), not a tracker fault: a 20 s parked edit-mode watch read dC exactly
  0.00000 on all four slots. The `armed by shadow` clusters are the day-cycle
  sun (LightScript.ts, ±70° ping-pong) arming at its eased endpoints —
  §12.46's designed behaviour. The play-transition `static shadow bvh`
  rebuilds are reconciliation, debounced and counted by design.
- **Three states, one in-page instrument** (rev/px/s over lit pixels): edit
  parked **0.155** (rest cadence engaged, nothing armed — the at-rest fixes
  HOLD on Sponza); play with the sun sweeping **0.475** (α ramp doing its
  job; small 0.005 steps — but the interior is near-black at parts of the
  cycle, so relative visibility is high and the missing scene ENVIRONMENT
  makes it worse); edit pan→hold **2.45 — 16× the parked floor, the dominant
  state the user actually works in.**
- **Hold-churn suspects, priced live** (hatches, interleaved): rest cadence
  off and α pinned at 0.05 both INSIDE the ±40% replicate spread — acquitted.
  Seed rays 0: **3.1–3.5 rev/px/s and 4.5× the hot-pixel population** — the
  §12.59.3 seed re-earns its keep on this scene. Stats dump: hash load 1–2%,
  `noBlock` 0, `failed` 0, ~30 fresh probes/frame, seed live — every
  capacity/cold-start suspect acquitted. Heatmap: churn **UNIFORM over lit
  content** (curtains, bounce-lit vaults), not the pan's leading edge.
- **Mechanism**: the transport is SCREEN-DRIVEN, so the set of surface points
  feeding each probe is view-dependent — a pan shifts every probe's estimator
  equilibrium slightly, and at α 0.02 the whole field crawls to the new
  equilibrium over ~50 frames in full view. Evidence never becomes WRONG
  (ALPHA_STILL's doc stays true); it becomes DIFFERENTLY SAMPLED.

**Shipped: `CAM_SETTLE_ALPHA` 0.05 (§srcConfig doc carries the full argument).**
α is floored on the SAME camera-recency hold+fade envelope the rest cadence
reads (one envelope, two consumers — hoisted above `readAlpha`), so
re-equilibration compresses into the window that already runs at full rays.
Parked scenes never see it (camTerm 0); a pinned `__giSrcAlpha` outranks it;
`__giSrcCamSettleAlpha` = false is the A/B arm, a number pins the floor.

**Receipt (same-page interleaved, real Sponza):** short holds (1.25 s, biased
AGAINST the fix) — hot pixels ÷1.6 (3/3 replicates), step amp lower 3/3, rev
−12%; long holds (2.5 s) — **rev −23% (1.20 vs 1.56, 2/2 replicates,
off-arm spread 1.557..1.569), churn −16%, step amp −12%**. Liveness:
`alphaHold 0.020..0.050` on vs `0.020..0.020` off. `test:gi-src-temporal`
green (standalone gates pass no motion getter and never see the floor).

**Residual + next lever, filed:** post-pan holds still sit ~8× the parked
floor after the settle — that residual is per-frame estimator variance on
bright indirect content plus the α-invariant part of the redistribution
transient, and no CPU dial reaches it. The specced next step is a
RESOLVE-SPACE FILTER: either the gather→resolve spatial filter §12.53 already
names as "lacking", or a temporal reprojection EMA on the resolve target
(prev-VP infrastructure exists — `_giPrevVPStore`; depth is in hand;
neighborhood clamp against ghosting). It would also buy down the play-mode
sun number and the §12.59 still floor. Sponza probes stay in
`scripts/run-gi-sponza-*.mjs` until it ships.

### 12.64 THE ENVIRONMENT MUST NOT ALSO LIGHT MATERIALS DIRECTLY — IBL SUPPRESSION UNDER GI (2026-08-14, uncommitted)

User (after following §12.63's "set an environment" advice): "when adding
environment, it fills the whole sponza with ambient, which is not correct, as
it must have very dark areas where light almost does not reach." Exactly
right, and it is a WIRING GAP, not tuning: three applies `scene.environment`
as per-material image-based light — diffuse `iblIrradiance` AND specular
radiance, both UNOCCLUDED (EnvironmentNode.setup) — while GI ALSO carries the
same environment correctly (escaping rays return `sceneSkyRadiance` through
cascade transmittance). Every surface got the flat copy on top of the
occluded one. At roughness 1 the "specular" half degenerates into a second
ambient, so keeping it would leak the same wash — both halves go.

**Shipped:** while GI is active and an environment exists, GISystem sets
`scene.environmentNode = vec3(0)` — the supported three seam: a node there
REPLACES the one three builds from `scene.environment`, which itself stays
untouched (GI's sky read, Scene Settings, background all keep working).
Installed in the per-frame poll beside the sky read (nothing notifies);
removed on dispose only if still ours; mirrored onto the §12.55 background
compileTarget so the warm pipelines match the live ones. `__giKeepIBL = true`
restores the old behaviour (the A/B arm).

**Gate** `run-gi-env-ibl-gate.mjs` (real Sponza via shim, in-page 64×32 white
env, SUN ZEROED, beauty-frame region means via onPostRender readback):

    deep-arch region:  no-env 0.0244   ibl-on 0.4825 (the 20× wash)   suppressed 0.0605
    full frame:        no-env 0.2017   ibl-on 0.4884                  suppressed 0.2181

⇒ the wash is gone; the arch keeps only GI's occluded sky (+0.036 through
real openings); open areas stay lit. Eyecheck frame: atrium lit from the sky,
vaults self-shading, corridor end genuinely dark.

**THREE INSTRUMENT TRAPS this gate paid for, in order:** (1) a "dark region"
rect chosen off a sun-lit screenshot measured LIT content — the sun at
intensity 50 tonemap-drowns a ±1 environment to ~1% of the frame; zero the
sun for any environment-scale measurement (this is also WHEN the user sees
the wash: the day-cycle sun spends much of play below the horizon).
(2) The PMREM of a 1×1 DataTexture comes out ~black — the first sun-off run
measured GI sky in BOTH arms and called the suppression dead; 64×32 works.
(3) Toggling `scene.environmentNode` mid-session must be followed by a
`material.needsUpdate` sweep in a harness — at BOOT the GI compile wave
covers it, which is the shipping path.

### 12.65 THE IRRADIANCE TEMPORAL FILTER — POST-PAN CHURN ÷12, STILL FLOOR ~0 (2026-08-14, uncommitted)

The §12.63 residual, built: a reprojected screen-space EMA over the GI
resolve. The probes' own temporal layer cannot absorb the pan aftermath — it
IS the thing converging — but a SCREEN layer can, because for a parked or
panning camera over static geometry the same world radiance lands on
reprojectable pixels.

**Shape** (`createGiIrradianceTemporalPass`, giScreen.js): the resolve now
writes `irradianceRaw` (a SHIM targets view — createGiResolve destructures
only irradiance/radiance, so `{...targets, irradiance: raw}` re-targets it
without touching its code); the filter validates history exactly like the
light-shadow filter (prev-VP clip, row-flip, world-position epsilon, 3×3
silhouette rescue — that pass's comments carry the measured reasons) and
writes `targets.irradiance`, the texture every persistent material binding
has always pointed at — materials never learn the filter exists. History
snapshot = `createGiLightShadowHistoryPass` REUSED VERBATIM at 1:1 scale.
The trio (`irradianceRaw/Hist/HistPos`) is lazy like the shadow trios
(~30MB at editor res, paid only when built).

**Ghosting control is the shadow chain's, not a neighborhood clamp:** the
weight uniform runs `0.9 × (1 − mLight)` and zeroes while a §12.43 window is
open — light motion (matrix, luminance, emitter — the α ramp's family)
stales history semantically in a way position validation cannot see. Camera
motion deliberately does NOT drop it; that is the point. Hatches:
`__giIrrTemporal = false` (build-time, removes the chain),
`__giIrrHistWeight` (live pin; 0 = same-page passthrough off-arm).

**Wired into all four dispatch paths** — build queues (×3), the idle
frameQueue (with the filter built, the resolve writes RAW; dropping the pair
there would freeze `irradiance` for the whole idle stride), and the resize
rebuild+splice contract (fresh targets, queue positions preserved). The
prev-VP store gets exactly one writer per frame: the irr block copies BEFORE
the shadow block overwrites, and owns the update when the shadow block is
compiled out (analytic arm).

**Receipts (all with the filter live):**
- Sponza pan-holds (SEG=240, interleaved ×2, off-arm = weight pinned 0,
  same cost both arms): **0.048/0.059 vs 0.626/0.683 rev/px/s — ÷12**,
  churn −32%, and the filtered hold floor sits BELOW the old parked floor.
- Rig `SRC=1 LIGHT_STEP=1`: **still control 0.004 rev/px** (the §12.59
  floor, ~0.2–0.5 pre-filter, is effectively gone); **the window cap lift
  HOLDS** — shipped 1.03 vs no-lift 3.91 rev/px, tight round spread 0.080,
  no lag/ghost signature in step amplitudes: light events pass straight
  through the motion-zeroed weight.
- `smoke:gi-gpu` both arms PASS with the filter in-chain.

Play-mode sun sweep is deliberately UNCHANGED (weight ≈ 0 under sustained
light motion — that state runs on the α ramp as before). If a future report
names it, the §12.53 gather→resolve spatial filter is the remaining specced
lever.

#### 12.65.1 POSTMORTEM: THE FILTER IS OPT-IN UNTIL §12.56 IS FIXED (2026-08-14, same day)

User (after the reload that delivered §12.63–65): "there are some weird
places where light never appears, though visually it should reach it" — and
the dark-pocket probe walked a black pixel to a probe ladder CARRYING LIGHT
(c0 payload 32/32 known, meanL 0.36), a lit gather (min 0.02, empty 0), a
lit RAW resolve (2.36, 2.17, 1.77) — and `targets.irradiance` at EXACT ZERO
across the whole band. The filter pass sat in every queue with weight 0.9
and was never dispatched.

**The wedge, established by bisect** (`run-gi-irrfilter-forcedispatch.mjs`):
the pair's pipelines are silently never created from the BATCHED frame path
on some boots (others are fine — same §12.56 nondeterminism), and a batch
containing a pending member drops the WHOLE submit — the resolve's own
writes included, which is why even the fail-safe rawCopy topology (shipped,
kept) still read black. Dispatching the HISTORY pass ALONE from page context
created its pipeline and the entire frame path unwedged on the spot, every
boot tried (7/7).

**Four priming shapes, all fired, all failed** — from ENGINE context the
identical dispatch never creates the pipeline: (1) in-tick batched pair;
(2) `_fieldReadyOnce`-gated single-shot (plus the `_frame % 60` trap — that
counter pins near zero, use a dedicated one); (3) task-context single-node
`renderer.compute`; (4) `renderer.computeAsync`. Page-context
`renderer.compute([node])` — same renderer object, same node object — works
instantly. The engine-vs-page difference is unidentified and lives somewhere
in `installAsyncComputePipelines`' interaction with the frame loop; the
replay guard only covers depth-0 skips by design, and batch skips assume
"next frame the pipeline is ready", which is exactly what the wedge breaks.

**Shipped state:** `__giIrrTemporal === true` opts IN (default off); all
§12.65 code, the fail-safe resolve topology and the A/B instruments stay.
The §12.56 GENERAL FIX — an auto-retry/watchdog that detects a
pending-forever pipeline and re-rolls it — is now the top GI reliability
item: it gates this filter's ÷12, the known dead-[J] race AND the open
occluder-pipeline race. The dark-pocket + force-dispatch probes are its
ready-made gates.

### 12.66 THE BLACK FRESH BOOT — OPEN, with the full exoneration ledger (2026-08-14 afternoon)

**Symptom.** Every fresh harness boot of the user's GAME/Sponza since ~14:40
renders a BLACK viewport (blackFrac 0.9957-0.9998, meanLum 0.0003-0.0004,
IDENTICAL across ~12 boots — a constant image, not a dark render). The editor
UI is fine, the loop ticks at ~100fps, GI textures are lit and healthy, three
assistant-session live editors render LIT, and a boot at 14:07 (flicker
verification run, page loaded ~13:52-14:00) rendered LIT with the same
procedure. **`castShadow=false` on the sun lights the frame to meanLum 0.89.**
The sun's shadow SAMPLE reads ~0 at every pixel.

**The two decisive receipts:**
- `shadow.bias` ±0.05 moves NOTHING; `shadow.intensity=0.5` reads exactly
  `mix(1, ~0, 0.5)` — the sample is a hard 0 independent of the comparison
  reference. A real-map comparison CANNOT be bias-independent ⇒ the shader is
  not comparing against the real map content.
- The real map is VERIFIED GOOD: 64×64 compute census reads min 0.204 / mean
  0.902 / 15% geometry coverage — exactly Sponza's footprint in an 80m ortho
  (early "85% far-plane = casters culled" reading was wrong — that IS the
  correct coverage). One 4096² ShadowDepthTexture created per boot (t=2.3s,
  ShadowNode.renderShadow — device.createTexture census with stacks).

**Exonerated, each by a dedicated boot or live toggle** (scripts:
`run-blackframe-bisect.mjs` PPOFF/NOWAVE/GIOFF/NOGUARD env-matrix,
`run-blackframe-shadowstate.mjs`, `run-blackframe-texcensus.mjs`,
`run-blackframe-wgsl-capture.mjs`):
- §12.65 filter (default-off + IRR=0 control black), the §12.56 watchdog
  (never fired — its warn lines are absent), PP (component removed live AND
  `__ppForceDisabled` from frame zero — the ONLY valid PP bisect for
  compile poisoning), GI wholesale (`__giOff`), the compile wave
  (`__giNoCompileWave`), the 14:02 gbuffer shadows-off guard
  (`__giGbufShadowGuard=false`), ALL COMBINATIONS of wave+guard+PP off,
  occlusion culling + `cullShadowCasters` (camera-governed culling, Engine.js
  rework), tonemap/exposure (state dump + NoToneMapping live), shadowMapType
  Basic→PCFSoft, bias/normalBias sweeps, camera component enabled on/off,
  scene light props (byte-identical to GAME-HEAD), Chrome version (update
  staged 4:51 but chrome.exe unswapped), vite dep re-optimization (deps
  cache untouched since 9:57 — before the lit boots), duplicate-three.
- The empty-fragment-struct pipeline errors (`struct OutputType {}`) are
  PP-warm collateral — GISystem #warmOverridePass compiling the PP scenePass
  builds one scene-material fragment with zero outputs (33KB full-beauty
  WGSL, captured with stacks) — but PPOFF boots have ZERO of them and are
  still black. Real bug, separate ticket, NOT this.
- Unlit white MeshBasicNodeMaterial probe cube: never rendered (its fresh
  pipeline compiles into the broken state too) — blackness is not
  content-specific.
- `castShadow` off→on re-arms the black (a LIVE shadow-node rebuild
  re-enters the broken state — it is not boot-order-once).

**Standing hypothesis (untested):** the frame's bind groups hold a view of a
PLACEHOLDER/dummy depth texture instead of the real ShadowDepthTexture, and
whatever refreshes bindings placeholder→real is defeated in this tree state.
Next instrument, prescribed: document-start wrap of `device.createBindGroup`
(+ `texture.createView` correlation) — census which texture view the settled
frame's fragment bind groups reference for the comparison sampler, compared
against the t=2.3s real texture. That turns "which texture does the shader
read" from theory into a boot log line.

**Timeline paradox, unresolved:** the lit 14:07 run vs black 14:40+ runs
differ by (a) the user's 14:17 scene+project save — every individual delta
tested and exonerated, whole-file A/B impossible (no pre-save copy exists);
(b) giScreen@14:02 + GISystem@14:34(mine) — both behaviorally exonerated via
hatches/absent log lines. Either an untested interaction of the 14:17 save,
or the 14:07 run's lit-ness itself deserves suspicion (its page loaded
during an edit window; its arms dispatched page-context computes
continuously — though the same dispatches demonstrably do NOT heal black
boots now).

**User impact: an editor RESTART on the current tree will boot black.** The
live sessions stay lit only because their material bindings predate the
breaking state. Mitigation available to the user if hit before the fix:
turn the sun's Cast Shadow off/on is NOT enough — set Shadow → castShadow
OFF renders lit (no sun shadows) until the fix lands.

**Hatches added this session (all §12.66-labeled, keep until closed):**
`__ppForceDisabled`, `__giOff`, `__giNoCompileWave`, `__giGbufShadowGuard`,
`__ppScalarParams` (PostprocessComponent matParams bisect). Plus the SSR
composite rewrite to pure premultiplied ADD (postGraph.js — correct
regardless of this bug; the displacement term `k` modeled factors the addon
premultiplies and its comment's "runs LOW" claim was wrong on fresnel).

**RESOLVED (2026-08-14 evening). THE BLACK FRESH BOOT IS A CORRECT RENDER —
of the saved scene, from the harness's default camera pose. No engine bug;
no fix; no code changed.** The decisive receipt is one screenshot: the
user's own LIVE, healthy, brightly-lit editor was pointed (via MCP
`viewport_setCamera`, pose saved and restored) at the exact pose every
harness boot measures — position (7,5,9) → target (5.25,3.75,6.75) — and it
rendered the SAME near-black frame. The dark view is real scene content.

The full causal chain, every link measured on fresh boots
(`run-blackframe-{bindcensus,comparecensus,frameid,ghostcaster,ghostid,
giresolve,gistages,gbufread,srctiles,hatchmatrix,slotdesync,alphapin,
emitterchain,dispatchcensus,verify}.mjs`):

1. **The shadow pipeline is CORRECT end-to-end** — the standing
   placeholder-binding hypothesis is REFUTED. Document-start
   createBindGroup/createView census: every settled-frame fragment bind
   group references the REAL 4096² ShadowDepthTexture (serial-verified
   against `backend.get(depthTexture).texture`); one comparison sampler,
   `less-equal`, correctly paired; `reversedDepthBuffer` false both sides;
   the map re-renders EVERY frame (94.9 passes/s counted at
   `beginRenderPass`, `updateMatrices` 94.9/s, far=50 at every call); the
   shadow matrix's implied sun direction matches the scene file to 3
   decimals. Live compare-flips behave exactly as a healthy pipeline must:
   GreaterEqual/Always → lit (0.83), LessEqual/Never → black.
2. **The hard-0 sample is TRUE occlusion.** `sponza_25` is a REAL 37×23 m
   roof slab (geometry bbox y 12.8–14.3) spanning the entire building —
   castShadow bisect: killing only sponza_25 lifts the frame 0.0003 →
   0.117 (correctly-shadowed Sponza, not the all-lit 0.83). CPU truth:
   view surfaces project ~0.21 deeper than the stored roof depth at their
   texels — bias ±0.05 (±2.5 m) rightly cannot bridge a 10.5 m roof-to-
   floor gap, which is the whole "bias-independent" receipt. (The earlier
   "map content = 85% far-plane + Sponza footprint = GOOD" reading was
   right; the missing insight was that the footprint's interior IS the
   roof, over everything.)
3. **The scene is mostly dark BY CONTENT.** Sky/ambient are authored 0
   (GI override skyIntensity 0, scene ambient off), the sun (intensity 50)
   is roof-blocked over the whole interior, and the single interior light
   is a 1 m emissive-×10 cube (`Mesh 7.mat`). Under that lighting the
   default-framing view is genuinely near-black even with GI converged —
   the live-editor A/B proves it.
4. **Why 14:07 was lit and 14:40+ black:** the harness's fresh browser
   profile has NO saved viewport pose, so every boot frames the scene at
   the DEFAULT pose; the 14:17 scene+project save changed what that
   framing shows (and the assistants'/user's live editors keep their own
   localStorage poses in the lit gallery). The prior session's delta hunt
   compared light/camera-component props — the one delta that mattered was
   the VIEWPORT POSE, which lives outside the scene diff. Its
   "castShadow off→on re-arms the black" was the sun flooding vs not; its
   "unlit white probe cube never rendered" was the §12.65.1 instrument
   artifact (fresh material pipeline's first frames), not output-chain
   poisoning.

**Verification (fresh boots at the user's WORKING pose,
`run-blackframe-verify.mjs`):** PPOFF boot 1 PASS (blackFrac 0.0259,
meanLum 0.3301, seats 0); PPOFF boot 2 PASS (0.0254 / 0.3075, seats 1);
PP-on boots 3+3' both LIT at meanLum 0.3097 / 0.3064 with blackFrac
0.0383 / 0.0386 — nominally over the 0.03 gate, reproducibly, because the
PP tonemap crushes the arcade vaults' deep-shadow pixels below the 2/255
threshold (~3.9% vs ~2.5% PP-off); a 0.31-mean frame is 1000× the black
boots' 0.0003 and unambiguously lit, so the gate for PP-on runs should be
meanLum-based (> 0.1), not blackFrac. castShadow ON in every boot.
`npm run smoke:gi-gpu` PASS both arms; `npm run test:gi-spawn` ALL PASS.
The original bisect gate (lit at the DEFAULT pose) is unsatisfiable by
construction and retired with this entry. Note boots 1/3/3' passed WITH
ZERO EMITTER SEATS (sun through openings + bounce carries this pose)
while boot 2 seated the cube — the seat race is per-boot real; its
receipt is in the finding below.

**Real (secondary) findings kept open from this hunt:**
- **Emitter-seat streaming race (OPEN, §12.56-family):** one census boot
  settled 20 s past "[gi] built" with `_emitterInfos` EMPTY
  (`run-blackframe-dispatchcensus.mjs`: emitterInfosLen 0, emitter chain
  frameSkip'd every frame, shadow targets at birth-zero) while sibling
  boots seated the cube (rgb=10) — the promotion depends on
  `resolveMaterialSurface` seeing the streamed material, and the
  fingerprint rescan (which DOES hash resolved emissive) had not caught it
  by +21 s. With a seat absent the lamp contributes nothing anywhere
  (R5 zeroes the palette emissive for promoted/would-be-promoted paths).
  Needs a dedicated boot-matrix before shipping a fix.
- The emitter/light shadow chains' **fail-open clear is one silently
  skippable dispatch** (§12.56 first-dispatch skip): until the chain's
  first real dispatch lands, fresh targets read 0 = fully occluded —
  fail-CLOSED in practice. Harmless when the chain runs; a black-lamp
  amplifier whenever the seat race (above) or a §12.56 wedge stalls the
  chain.
- `giSkippedComputes` is cleared at the END of the GI tick
  (GISystem.js ~line 2180), so any postRender skip census reads an empty
  set by construction — an instrument trap that cost this hunt one wrong
  "zero skips" conclusion. Sample it inside the tick or before the clear.
- "[gi] first frame after compile wave took 1446ms — pipelines recompiled
  at resume (likely the postprocess render path; report this)" — logged on
  every fresh boot; already self-reporting, still unfixed.

**Cleanup:** the `run-blackframe-*.mjs` one-offs (19 scripts: this
session's 15 + the prior session's bisect/shadowstate/texcensus/
wgsl-capture) are superseded by this entry and can be deleted with it —
keep `run-blackframe-verify.mjs` until the emitter-seat race closes; the
§12.66 hatches above stay until then too. The `__giSrcSecondary`
memory-note stands. The `sponza_25` roof is the user's content decision —
if they want the classic open-atrium Sponza look, castShadow off on
sponza_25 (or deleting the roof) is a SCENE edit, not an engine matter.

### 12.67 LIGHT-DEPARTURE TAIL — stale bleed + flicker after a light leaves (user report 2026-08-14, spec)

User: "when lights was lighting some surface, and then went away, this surface
continue color bleeding and flickering for quite some time after that."

Mechanism, read at srcSystem.js §12.61 drive block: `restDrive =
max(mLight, tr, camTerm, bootTerm)`. A departing light arms the §12.43 window
(tr=1, relaxed root, cap lift) — but the window closes on the EVENT cadence,
not on re-convergence. After close: tr=0, mLight subsides, restDrive→0 ⇒ α
returns to TEMPORAL_ALPHA_STILL (0.02) AND the rest cadence cuts rays to
REST_TRANSPORT_FRACTION. The previously-lit surfaces still hold the OLD
equilibrium: stale bounce energy now decays at still-α on a REDUCED evidence
rate — and §12.52 surprise cannot rescue it (it needs fresh deposits to detect
the disagreement; starved blocks keep their ghost until rays revisit, then
correct in sparse blotches = the reported flicker). The camera version of this
exact hole is what §12.63 fixed with the settle envelope.

Fix shape (NOT YET BUILT — src is locked on §12.66 until the forensics agent
lands): a LIGHT-settle hold+fade twin of camTerm — the §12.43 window CLOSING
starts `lightTerm` (hold ~REST_CAM_HOLD_MS-class, fade REST_CAM_FADE_MS-class)
feeding BOTH the α floor (§12.63 shape) and restDrive, so the field keeps
full evidence + elevated α until the departed light's ghost has re-converged.
Hatches: `__giSrcLightSettleHold(Ms)`, pin rules as §12.63.

Gate: extend the flicker rig with a LIGHT_DEPART arm — light parked over a
surface until settled → step OFF → measure (a) tail half-life of the region's
luminance error vs final, (b) rev/px during the tail. A/B hatch-off vs on;
the §12.63 SEG=240 protocol (short holds bias against settle fixes).

#### 12.67.1 ENVELOPE SHIPPED; RIG VERDICT OPEN (2026-08-14)

Shipped: `LIGHT_SETTLE_HOLD_MS 1500 / FADE 800` (srcConfig), `tr` hoisted, α
floor takes `max(camTerm, lightTerm)` (one CAM_SETTLE_ALPHA floor, two
envelopes), restDrive gains `lightTerm`. Hatches `__giSrcLightSettle`,
`__giSrcLightSettleHoldMs/FadeMs`. All 10 gi-src node suites PASS.

Rig: LIGHT_STEP gained a `settle-off` config + a TAIL measure per arm. First
run read shipped-tail 0.569 vs settle-off 0.622 (÷1.09 — a wash) — but the
PROTOCOL IS CONFOUNDED: configs alternate step direction, so `shipped` got
the 2→6 (arrival) arms and `settle-off` the 6→2 (departure) arms, and the
rig never steps to ZERO — the user's regime is a true departure with
multibounce residue, which a 6→2 dim on the small rig barely exercises.
Verdict OPEN until the arm is direction-matched (reset light between
configs), steps to ~0, and takes a LONGER tail (the §12.63 lesson: short
holds bias against settle fixes). The envelope stays in (mechanism sound,
cost bounded: ~2.3 s of full budget after a light event), and the REAL gate
is the user's Sponza with a toggled lamp.

### 12.68 PRESET ENERGY — "MEDIUM IS TOO DARK" WAS THE HYBRID-PLANE BOX
### FALLBACK HALVING THE TRANSPORT'S FREE PATH (2026-08-14, uncommitted)

User report, with screenshot: on the MEDIUM preset their Sponza is "too dark
in most places" — deep arches/interiors near-black, sun-lit areas fine — and
"low has the same problem doubled"; ultra/high look correct. Since §12.64 the
environment lights ONLY through GI, so a preset that loses GI energy shows
exactly as this. A preset may buy noise and coarseness; it must not lose
energy — this section is the measurement of where medium/low lost it, and the
fix.

**The instrument** (`scripts/run-gi-preset-energy.mjs`, kept until this
section is verified in the user's editor): one FRESH boot per arm against the
real read-only Sponza, all at the §12.66 working pose, preset forced via
`__giConfigOverride = { quality, resolveScale, exactReflections }` before
boot. Per arm: beauty-frame luminance percentiles + an 8×6 cell grid (canvas
readback, 5-frame mean), `_giTargets.irradiance` percentiles (PRIMED compute
readback — §12.65.1 discipline), the live deposit/merge/gather stats, and the
boot config lines. Repeat boots reproduce to 3 decimals (medium ran twice:
GI mean 0.35804 / 0.35547).

#### 12.68.1 The ladder, and the cliff

    arm            ray-hit mode            GI screen mean   GI p25    frame p05   dark cells (7/14/47)
    ultra          hybrid-exact-complex        1.808        1.084       0.204     0.32 / 0.31 / 0.14
    high           hybrid-exact-complex        1.659        0.917       0.206     0.32 / 0.30 / 0.15
    medium         hybrid-plane (auto)         0.358        0.108       0.093     0.08 / 0.10 / 0.09
    low            hybrid-plane (auto)         0.253        0.052       0.076     0.06 / 0.08 / 0.08

The loss is IN THE FIELD (the gather's own meanLum shows the full collapse:
1.49 vs 0.35), not the resolve or composite; the cliff sits exactly at the
high→medium boundary; and it is ENERGY, not variance — every percentile of
the GI distribution drops ~3-5×.

#### 12.68.2 Single-knob isolation — the mode owns it, everything else acquitted

    arm                                     GI screen mean      Δ vs its tier
    medium + __giRayHitMode=exact-complex       1.460           ×4.1  (≈ high)
    high   + __giRayHitMode=hybrid-plane        0.614           ÷2.7  (≈ medium)

The medium+exact arm changes NOTHING else: same 256×128×176 @ 0.164 m
occupancy grid, same s₀ 0.6, same 1 ray/px, same 26,330 rays/frame, same
probe budgets — and recovers to within 11% of high. Acquitted by the same
table: ray budget (ultra fires 8× low's rays for +9% mean), spacing0,
raysPerPixel, probe budgets, resolveScale, record-pool starvation (§12.52.2's
suspect — pool 355k/481k claimed at medium, NOT saturated), and attribution
(unattributedRate 1.4% plane / 2.6% exact — both noise).

#### 12.68.3 The mechanism, from the deposit stats

    medium, same pose        hitRate    mean free path    deposits/ray
    hybrid-plane              0.984         2.00 m            1.57
    hybrid-exact-complex      0.966         3.92 m            2.09

HybridPlane resolves an occupied voxel through its fitted SIMPLE plane — but
any cell WITHOUT a usable record (complex fit: edges, trim, curved mouldings,
foliage; pool overflow; unfitted) keeps occupied-BOX semantics
(`occupancyField.js`, traceHybridPlane header): the ray stops on the voxel
HULL even where the actual surface never crosses its path. Sponza's surfaces
at 0.164-0.234 m voxels are dense with complex-flagged cells, so the
transport's mean free path HALVES: rays die on phantom hulls near their birth
surface instead of reaching the sun-lit courtyard or the sky, and each false
hit deposits the phantom's (dark, often back-facing) radiance with T = 0 —
occluding the cascade chain's real answer behind it. A multiplicative energy
sink, worst exactly where all light is indirect. Exact-complex runs the
cell's ≤16-triangle list and lets a genuinely empty crossing CONTINUE — §4.3
calls that "the ONE case where a cell is left without a hit on exact
evidence" — which is precisely the difference the ladder measured.

#### 12.68.4 The fix, and the post-fix ladder

`AUTO_MODE_BY_QUALITY` (src/modules/gi/rayHit/RayHitConfig.js): low/medium
move from HybridPlane to HybridExactComplex — hit precision is now
preset-INDEPENDENT, and the presets keep trading rays, probe density and
resolution (variance and reach, never energy). `__giRayHitMode =
"hybrid-plane"` remains the A/B hatch. Measured cost on the real Sponza,
medium: occupancy 37→72 MB (the tri pool), GPU 5.6→6.4 ms, 74→70 fps on the
power-capped 4070 (§12.57 caveat applies); low: 15.5→29.9 MB.

    arm (auto mode)      GI screen mean         frame p05   dark cells (7/14/47)
    medium POST-FIX       1.480  (was 0.358)      0.196     0.31 / 0.28 / 0.12
    low    POST-FIX       0.819  (was 0.253)      0.115     0.12 / 0.12 / 0.11

Medium sits within 11% of high — the user's report is resolved at the tier
they named. Low recovers 3.2× but stays ~½ of high BY DESIGN, and the
residual is now the documented trades, not the bug: `secondary: false` (low
ships single-bounce — SRC_QUALITY), and 0.234 m voxels whose over-limit dense
cells (4,351 exceed MAX_COMPLEX_TRIANGLES) keep box hits. If "low is still
too dark" survives this fix, those two are the remaining owners, in that
order — note there is NO hatch to force the second bounce at low
(`__giSrcSecondary` is opt-OUT only; the tier gate wins).

Gates after the flip: `test:gi-src-gather`, `test:gi-src-merge`,
`test:gi-src-temporal`, `smoke:gi-gpu` — all green (the smoke takes explicit
`?mode=`, so the auto flip changes no smoke arm).

**Instrument note for future preset work:** `__giConfigOverride = { quality }`
steers every tier-keyed table (both `qualityTierOf`s read the settled
`config.quality`) but NOT `BY_TIER`'s resolveScale/exactReflections, which
were already spread into the settled object — force those two alongside or a
"forced ultra" runs at the saved scene's resolve scale.

#### 12.67.2 DIRECTION-MATCHED VERDICT (2026-08-14)

Protocol fixed (every config re-lit to 6, settled, stepped 6→0; two tail
windows). Result ×2 rounds: tail1 shipped 1.007 vs settle-off 1.135 rev/px
(÷1.13, shipped also tighter: 1.004/1.010 vs 1.053/1.218); tail2 a wash
(0.836 vs 0.822). Still control UNCHANGED with the envelope in (0.901) — no
noise leak into parked scenes. Interpretation: at rig scale the departure
ghost drains within ~one window regardless, so the envelope's full value
(multibounce residue on real content) is not measurable here; the rig CAN
however say the envelope costs nothing. Note for a future half-life metric:
rev/px per window under-credits settle fixes structurally — window-off reads
the LOWEST tail1 (0.705) precisely because it converges slowest (its ghost
outlives the window, churning less per window but lasting longer — the exact
"quite some time" the user reported). Tail LUMINANCE ERROR vs final is the
right metric when this next needs numbers. Envelope stays shipped; the
user's Sponza lamp scenario is the standing referee.

### 12.69 UNIT W3 — [J]'S NEE THROUGH THE LIGHT TREE, TWIN-GATED (2026-08-14 evening, uncommitted; hatch-off)

§12.62's W3, executed. `createSrcHitLighting` gains a `lightTree` option that
REPLACES the slot NEE (never both — two estimators over overlapping light sets
double-deliver every emitter both can reach): one W2 descent per hit, up to two
samples, each contributing `E·v/pdf` — `estimateLightTree`'s estimator verbatim.
Wiring: GISystem hangs `{baseWord: _lightTreeRegion.abs, emitterCount, maxDepth}`
on the `lighting` object (the region is built+queued BEFORE `createSrcProbeSystem`
runs, so the base word bakes as a compile-time constant); srcSystem builds the
sampler + eval over `volume.occupancyField.bits` — the block rides the bits tail
the visibility marcher already binds, so [J] stays at 4/8 storage bindings.
Hatch: `__giSrcLightTree = true` (build-time, DEFAULT OFF). Boot line
`[gi] src [J] NEE: light tree (base …)` per the §12.42 rule.

**The new GPU math — `createLightTreeEmitterEval` (lightTreeGpu.js)** — is the
CPU `emitterIrradiance` term for term: cone gate via the cosSub identity +
Sterbenz complements (no acos round-trip), then giLight's OWN `sphereLightFactor`
/ `boxLightFactor` / `boxRayEnter` fed record words instead of slot uniforms —
parity with the promoted path BY SHARED CODE for the two kinds records can hold
(`LT_KIND` 0/1 matches giLight's enum; `emitterSurfaceT` deliberately NOT reused
— its kind dispatch would compile five dead shape intersectors into [J]).
⚠ The cone gate exists ONLY on the tree arm (unbiasedness: contribution > 0 must
imply importance > 0 at every ancestor); a promoted slot emits full-sphere. The
two arms differ by exactly that gate, by design, tree matching the reference.

**Estimator discipline kept:** ONE visibility call site for both samples (the
rolled predicated funnel — ~1.2 s compile per site, §13.14.5); seed a pure
function of rayIndex (same 0x9e37 family as the slot draw it replaces — no frame
term, the still floor's accumulation relies on the repeat). R5: the zeroing
branch now arms under `useNee || useTree`; the flag still speaks promoted-slot
indices, which is exactly the subset it can name — a NON-promoted tree emitter
that also emits on contact would double-deliver, which production cannot hit
today (promoted statics zero at palette bake, movers at writeSurface, and the
palette's own emitter flag ships −1 — srcSurface `emitterMeshes` unwired).
Moving the WHOLE handoff to the tree set is W5's charter. Also W5's: mover
emitters sit in the tree at BUILD POSE (records are static words; slots refresh
per frame) — tree arm treats a moved emitter from its bake position until a
rebuild.

**Fixture gate (test:gi-lighttree-descent): ALL 19 PASS** — the W2 arms
unchanged (index parity exact, pdf 1.98e-6, canary fails on purpose) plus the
two W3 arms over 76,500 (case,emitter) evals and 3,500 full-estimator cases:
E per channel vs `emitterIrradiance`, dirTo 1.6e-7, maxT 2.6e-3× its bar;
estimator Σ E/pdf vs `estimateLightTree` same-seed, 0 bad. THE CALIBRATION IS
THE FINDING — three rounds of honest bars, each measured not asserted:
  · box factor f32 noise is ABSOLUTE and DISTANCE-SCALED (24 acos calls, ε/sinθ
    per edge, sinθ ≈ diag/dist): flat 5e-5 left 60 bad, flat 2e-4 left 10, all
    farther out; the bar that closed it is 1.5e-5·dist (floor 1e-4), ~2× the
    measured envelope (2.1e-4 at dist 32), ~100× under any real defect up close.
  · the estimator inherits that noise ×(1/pdf) — the abs floor must RIDE THE
    DIVISION (per-case Σ rawFloor(dist,kind)/pdf); a fixed floor misread pure
    scale-amplified drift as 8.5% "failures".
  · ONE-SIDED ZERO FLIPS (hard gates: cone, slab miss — f64 exactly OFF, f32 a
    hair inside) get population accounting, not rel comparisons: PASS is
    ≤2% of cases AND ≤0.1% of total energy (measured 14/3500, 0.000% — a
    missing/inverted gate flips a population, not a boundary sliver).

**Live gate (test:gi-lighttree-nee, NEW):** ABBA arms on an enclosed 4-STATIC-
lamp storm rig — exactly MAX_EMITTERS so tree set ≡ promoted set (the parity
scene; §12.26.7: an energy claim wants an energy statistic — the centre-crop
mean over frames). Verdict = energy within 5% + tree arms actually armed (the
boot line) + noise ratio reported against §12.26.5's 3.00×-SE ceiling.

**LIVE GATE: PASS (2026-08-14 evening).** ABBA, one invocation:
slot 0.2323/0.2175 · tree 0.2354/0.2153 mean centre-crop luminance —
**energy ratio 1.002** (slot round spread 0.0148, i.e. 6.6% boot-order drift
that the ABBA pairing absorbs: adjacent arms track to <1.5%); **frame-noise
ratio 0.71×** — the tree arm is QUIETER than the slots, far under the 3.00×
ceiling (at 4 emitters the tree is one leaf ranking on the full importance ≈
the exact contribution, and the root split hands every hit TWO stratified
samples where the slot path draws one). Both arms ticking, both tree boots
printed the arm line (base 3670704, 4 emitters, depth 0). Coverage note: the
rig's tree is depth 0, so the LIVE run exercises leaf sampling + production
wiring; deep descents are the fixture's 14-fixture job — together they cover.

**Hatch stays OFF.** Not for doubt about [J] — for the two documented W5 gaps
that only bite where the tree WINS (>4 emitters): a non-promoted emitter that
is emissive on contact double-delivers (R5's handoff still speaks slot
indices), and mover emitters sit at build pose in the packed records. Flip
order per §12.62: W4 (screen-side swap, priced by §12.56.1's emitterShadowPass
pole) then W5 (the handoff + seat retirement) — THEN the default, gated on the
real Sponza.

### 12.70 UNIT W4 SPEC — THE SCREEN-SIDE TREE, AND THE TWO WALLS IT MUST RESPECT (2026-08-14 night; spec first, execution staged)

§12.62's W4 said "swap emitterDirectAt + emitterShadowPass onto the tree, O(slots×
pixels) → O(log n×pixels)". The read-through that priced it (this section) says the
literal swap is the WRONG first move, and why.

**What the screen path actually is (mapped at source):** `emitterDirectAt` is a
BUILD-TIME unroll over 4 per-field uniform bundles (giLight.js:861-900 — not a
uniformArray, not a buffer; every slot costs its instructions whether live or not),
its result added RAW per frame into the resolve accumulator (giScreen.js:479).
`emitterShadowPass` (giScreen.js:864-928) is one record-march per slot per pixel at
~0.5× light-shadow res, output packed as ONE RGBA — **channel i ≡ slot i** — then
bilateral + wide passes; the resolve AND the material specular-glow path both sample
it under that channel contract. The §12.65 irradiance temporal filter sits on the
COMPOSITED resolve, and its history weight is deliberately driven to ZERO by light
motion (GISystem.js:1652-1662).

**The two walls:**
1. **The channel↔slot contract.** Any per-pixel emitter SELECTION (stochastic or
   deterministic) breaks the packed texture's meaning under SPATIAL filtering —
   neighbors with different emitter sets bilateral-blend visibilities of different
   lights. Selection granularity must be ≥ the filter kernel's, or the texture must
   be re-keyed and re-filtered per whatever replaces slots.
2. **The history is killed exactly when stochastic noise would spike.** A per-pixel
   tree SAMPLE leans on temporal accumulation; ours zeroes on light motion by design
   (ghost-vs-lag §12.43 lineage). Stochastic direct = a reservoir + its own
   denoising story = the deleted-ReSTIR shape. Not a unit — a project.

**The honest pricing at Sponza scale:** with 3-4 emitters, selection is NOT the
cost — the ~13-14 ms IS the marches (K contributing emitters need K marches under
any selector; §12.56.1 already took the reflection-hit marches to unshadowed). The
tree's screen-side value is the MANY-emitter regime: today a 12-lamp room lights
exactly 4 globally-chosen seats (§12.58 camera-apparent ranking), the rest fall to
[J]'s indirect only (which W3's tree now covers behind its hatch — the direct hole
is the remaining half).

**Staged W4, each stage gated:**
- **W4a — the many-emitter baseline rig. ⚠ FIRST RECORDING RETRACTED, THEN
  RE-MEASURED (run-gi-emitter-scale.mjs).** The original N=12 numbers
  (emitterShadow 0.03 ms, meanLum 0.1786, "the 12-lamp room reads DARKER")
  were the §12.66 pose artifact in a new costume: the pulled-back pose
  z=7.4 sat OUTSIDE the enclosed room (near wall at half = 7.05) — every
  reading was the box's EXTERIOR (no emitter light, back-facing receivers
  gating all marches, importance ties collapsing every tile list to
  {0,1,2,3}). Caught by the rig's own P-SPREAD instrument (tile receivers
  read x±0.47, z≡7.05 — a wall patch, not a room), which is now printed on
  every cut readback: **a generated-rig pose must be verified INSIDE the
  scene bounds, and the P spread is the cheap proof.** Re-measured interior
  (same pose as N=4): N=12 seats-only reads meanLum ~0.666, emitterShadow
  ~0.7-0.9 ms, all 12 ids in play across tile lists with visibility-shaped
  frequency. The REAL baseline facts: the camera-apparent seats own the NEAR
  half of the frame (the crop mean barely misses them); what the cap costs
  is the FAR half's direct — a REGIONAL quantity, which is why the W4b
  recovery gate is (topΔ − bottomΔ), not a mean ratio.
- **W4b — per-TILE deterministic top-K cut (the recommended architecture).
  SLICE (i) ✅ SHIPPED + GATE PASS (2026-08-14 night):** `createGiEmitterTileCutPass`
  (giScreen) — one thread per 8×8 tile of the emitter-shadow grid, gbuffer
  reconstruction at the tile centre (the shadow pass's own load + facing flip),
  then an O(N) scan over ALL tree emitter records ranked by
  `createLightTreeEmitterImportance` (lightTreeGpu — `buildImportanceMath`
  extracted and SHARED with the descent, fixture re-gated 19/19 bit-identical
  after the refactor, pdf 1.98e-6). NOT a tree walk, on purpose: thousands of
  tiles × ≤127 records makes the flat scan cheaper than a best-first stack —
  the TREE stays [J]'s sampling structure, the screen borrows only the ranking
  key. Kept 4 are **sorted by EMITTER ID** before writing (rank order is the
  one thing neighbouring tiles may disagree on without artifacts; wherever two
  tiles agree on the SET they agree on every channel's meaning). Zero-importance
  emitters excluded even with free seats (strict `>` — the cone/horizon the
  importance already prices). Buffers: 2×vec4/tile (P+valid, N) + 4×u32 ids;
  dev handle `__giTileCutLive`; hatch `__giEmitterTileCut` (build-time, default
  OFF); queued FIRST in the emitter chain; resize follows the rebuild+splice
  contract (a stale sx/sy would rank at wrong world points). CONSUMERLESS this
  slice. Gate (`TILECUT=1 run-gi-emitter-scale.mjs`, both N): **N=12 and N=4 —
  465 tiles, 450 valid, 450/450 EXACT set matches vs the CPU's
  `emitterImportance` ranking (now exported), 0 near-ties, 0 structural**;
  boot line asserted; smoke:gi-gpu both arms PASS on the untouched default.
  **SLICE (ii) ✅ SHIPPED + GATE PASS (2026-08-14):** emitterShadowPass +
  the resolve's emitterDirectAt read the tile's id list, loading per-emitter
  data from tree RECORDS (`createLightTreeRecordSlot` pseudo-slot fed
  `emitterSlotShadow`/`emitterSlotFactor` — the W3 shared-code pattern);
  material glow keeps GLOBAL slots and goes unshadowed under the hatch (its
  channel assumption cannot survive tile keying — documented trade, W5's to
  re-key). Recorded gate (`AB=1 LAMPS=4,12 SETTLE=18000
  run-gi-emitter-scale.mjs`, 4 boots, hatch-off vs hatch-on interleaved):
  **N=4 PARITY ratio 1.032 (bar ≤1.05), sets 450/450 exact, marches
  0.37→0.7 ms; N=12 REGIONAL RECOVERY (topΔ − bottomΔ) = 0.0663 (bar
  ≥0.008; topΔ +0.0651, bottomΔ −0.0012 — the far half gains, the seated
  near floor stays flat), mean 0.5965→0.6249, all 12 ids live in tile lists
  with visibility-shaped frequency [372..158], emitterShadow 1.53→0.96 ms,
  sets ok, boot lines asserted, P spread interior on every arm.** The cut
  costs nothing measurable and the 12-lamp march bill went DOWN — per-tile
  lists march nearer, cheaper records than 4 global camera-apparent seats.
  Hatch `__giEmitterTileCut` stays default OFF. **SEAM IMAGING (SEAM=1, 2026-08-14):
  NO SEAM BY EYE — statistic v1 inconclusive.** Census: 110/435 H and 160/420 V
  boundaries carry DIFFERENT sets (mean Δset ~2.7-3, worst 8 = fully disjoint);
  the ×6 crop at the Δset-8 boundary shows a smooth transition, no grid-aligned
  edge (`.gi-shots/emitter-scale/seam-*.png`). The soft gate FAILED on Y-grad
  excess +0.110, but the true-pitch ratios were nearly EQUAL across arms
  (off 1.130 / on 1.159) — the excess came from the single incommensurate-pitch
  CONTROL fold moving between arms (0.731 → 0.650): one control pitch is a
  sample of size 1 from the null. v2 needs a PHASE-SHIFTED null (same pitch,
  M shifted phases → z-score) for the gradient stat, and a multi-pitch control
  family for the fold. REMAINING before default: seam statistic v2, and the
  Sponza-scale ms re-ledger (ultra res, strength-100 lamps).
- **W4c — THE SEAM WAS REAL, AND THE TILE WAS THE SEAM. ✅ SHIPPED + GATE PASS
  (2026-08-15).** W4b's "no seam by eye, statistic inconclusive" verdict above
  is **RETRACTED**: it blamed the incommensurate-pitch control for the Y-grad
  excess without ever running the null. Running it settles it in one line.
  - **The null: N=4, same rig, same statistic.** At 4 lamps every tile keeps
    the full set — census 0/435 H and 0/420 V boundaries differ, so no seam
    can exist by construction, and the statistic reads **+0.015 / −0.016**.
    That is the instrument's noise floor. N=12 at the same tile size read
    **+0.110 X / +0.140 Y**, seven times the floor, on BOTH axes. The
    statistic was never the problem.
  - **The eyes agree, once you look at the right thing.** The centre crop
    (not the boundary crop) shows it immediately: rectangular bright frames
    hugging the storm's cubes. Grid-locked, tile-sized, and anchored to
    SILHOUETTES — which names the mechanism. It is not "adjacent tiles keep
    different sets" as a smooth-field step; it is **the tile centre landing
    on a different surface than the pixel**. A tile straddling a silhouette
    ranks all 64 of its pixels for whichever surface its centre hit, so the
    pixels on the far surface get the near surface's four lamps.
  - **Confirmed by exclusion, then by sweep.** The emitter shadow FILTER and
    the two WIDE passes blur the packed channels, and under a tile cut a tap
    from the neighbouring tile means a different emitter — the obvious
    suspect. `EXTRA='{"__giEmitterWidePass":false}'` (new rig knob: dev
    globals on BOTH arms) left the excess at +0.126. Not the filters. The
    tile-size sweep then walked the artifact down monotonically —
    **8 → +0.19/+0.16, 4 → +0.09/+0.11, 2 → (pitch too fine to measure),
    1 → noise floor** — which is what a per-tile representative error does
    and nothing else does.
  - **The fix is to stop having a tile: `tileSize` defaults to 1** (one
    ranking per emitter-shadow pixel, shared by the shadow march and the
    resolve — still ONE dispatch, still the same buffers). **It is also
    FASTER**: the cut pass goes 0.02 → 0.04 ms while emitterShadowPass drops
    0.82 → 0.60 ms, because each pixel now marches its own nearest four
    instead of a representative's. Adjacent-pixel set disagreement falls to
    **4.4%** (1261/28438) from 19% at tileSize 8 — the ranking is smooth in
    P, so the survivors are genuine geometric transitions. The scan is O(N)
    per tile and nothing caps the tree's emitter count, so the default keeps
    `tiles × N` bounded at ~16 evaluations per shadow pixel:
    `tileSize = clamp(ceil(sqrt(N/16)), 1, 8)` — 1 up to 16 emitters, 2 to
    64, 4 to 256. `__giEmitterTileSize` pins it.
  - **TAIL COMPENSATION (`__giTileCutCompensate`, cap 2).** A top-4 cut drops
    the tail's energy outright; the cut pass already scans every emitter, so
    it now also writes `Σimp / Σimp(kept)` per tile (the normal vec4's free
    `.w`) and the resolve scales its emitter direct by it — Walter's
    lightcuts answer, the kept representatives carry the dropped power.
    Measured: p50 1.17, p95 1.71, exactly 1.000 at N=4 (so PARITY is
    untouched), **+2.7% canvas energy** over the uncompensated arm.
    ⚠ **It must stay NEAREST, never interpolated** — the ratio is paired with
    its own tile's kept sum, and blending it across tile centres hands tile
    A's sum tile B's divisor and re-opens the step WIDER. ⚠ **The tail rides
    the kept lamps' visibility**, since `importance` has no occlusion term; the
    cap is 2 rather than the natural N/4 to bound what that costs in a
    room-partitioned scene, and clipping under-delivers, which is the safe
    direction. ⚠ At tileSize 8 the compensation made the seam WORSE
    (+0.11 → +0.19 X) for the same reason the sets did — a centre-sampled
    ratio applied across a silhouette. At tileSize 1 it is seam-neutral
    (fold Δ +0.0020/+0.0004 vs +0.0016/+0.0004 uncompensated).
  - **Rig hardening.** Three instrument fixes shipped with this: `EXTRA=` dev
    globals on both arms (attribution by exclusion); the pitch now comes from
    the LIVE tileSize instead of a hardcoded 8; and the boundary/interior
    ratio returns **null, not 1**, when the pitch leaves no interior — it was
    silently returning "no excess" below ~8 px, i.e. a gate that passes
    because its instrument stopped existing. Below that pitch the verdict
    says UNMEASURED out loud and rests on the luma fold and the crops. A
    phase-folded |gradient| statistic was added (works at any pitch) but is
    printed, not gated: it read +0.018 on the run where the boundary ratio
    read +0.19, so it is not a sensitive detector.
  - **Gate, at the shipping default (`SEAM=1 LAMPS=4,12`):** N=4 PARITY 1.023
    (bar ≤1.05, comp exactly 1.000 everywhere); N=12 RECOVERY 0.0482 (bar
    ≥0.008); SEAM **PASS**; sets ok, boot lines asserted, P spread interior;
    emitterShadow 1.23 → 0.80 ms. **W4b SLICE-(ii): PASS.**
  - Filed and still not planned: the original W4c idea (stochastic +
    reservoir). Per-pixel ranking made it unnecessary at this N.

- **W5a — THE TREE FOLLOWS THE LAMP. ✅ SHIPPED + GATE PASS (2026-08-15).**
  The tree's emitter records are packed WORDS frozen at build time, where the
  promoted slots opposite them are uniforms refreshed every frame — so every
  record reader ([J]'s NEE since W3, the whole screen emitter chain since W4b)
  lit a moving lamp from its BAKE POSE until the next full GI rebuild, and a
  mesh drag never triggers one ("moving scene geometry costs a uniform update"
  is the design). Closed by `#refreshLightTree`, called right after
  `#refreshEmitterSlots` so the two descriptions of one lamp can never be a
  frame apart. It covers dimming and colour ramps too — the same words carry
  power.
  - **The upload had to be new machinery.** `queueRegionUpload` builds a fresh
    staging buffer AND a fresh compute per call, i.e. a new pipeline per call
    — fine at build time, ruinous per frame. `createRegionUploader(maxWords)`
    (dynamicObjects) reserves through the same bump allocator, compiles ONE
    copy kernel, and re-sends only the attribute's bytes; it rides
    `pendingDispatch`/`confirmDispatch` exactly as the header sync does, so a
    skipped-pipeline frame retries instead of losing the write. The region is
    reserved at `estimateLightTreeWords(N) × 1.25`, not at the first pack's
    size — a re-pack of a slightly different set can want more words, and a
    region sized to the first pack would refuse every later write and freeze
    the tree at the build pose, which is the bug this closes wearing a hat.
  - **Two bugs the gate found, neither of them the one it was written for.**
    (1) `#chooseEmitterSeats` SORTS `_emitterCands` IN PLACE by camera-apparent
    power, so an index-keyed pose cache compares one lamp's matrix against
    another's — it reads "changed" on a still scene and repacks the whole tree
    every frame the camera turns. The cache is a WeakMap keyed by mesh now.
    (2) The same sort made emitter IDS a function of camera direction: the
    first gate run saw 10 of 12 records renumbered by a single lamp move.
    Nothing persists an id across frames today so it was harmless by luck;
    `#lightTreeMeshes` sorts by object id and makes the id a stable name.
  - **Self-throttled by measurement.** An animated emissive changes the
    signature every frame; a repack that MEASURED over 0.5 ms is spaced to
    ~10% of the time it costs, and a cheap one (a dozen lamps: tens of
    microseconds) is never delayed. The pose is at most one throttle window
    stale, never a rebuild away.
  - **Gate (`npm run test:gi-lighttree-mover`, NEW).** Moves `Lamp0` +2.5 in Y
    through `entity.setTransform` and reads the packed block back out of the
    occupancy bits, twice, keyed BY MESH (`meshId:instanceId` — an id-keyed
    diff reads a legitimate repack permutation as motion). **refresh ON: 1
    record tracks the delta (2.500), 0 others move (worst drift 0.0000), 0
    renumbered, no GI rebuild fired. refresh OFF (`__giLightTreeRefresh =
    false`, the control that proves the assertion is sensitive to the
    mechanism and not to some other thing that repacks trees): 0 records
    move.** The no-rebuild assertion is load-bearing — a rebuild repacks the
    tree anyway and would make the whole measurement vacuous.
- **W5b — R5's HANDOFF MOVES TO THE TREE SET. ✅ SHIPPED + GATE PASS
  (2026-08-15).** R5: a light that is SAMPLED must not also be hit by chance,
  or its energy arrives twice (§12.26.7 measured 2.60× on mean floor
  irradiance). Three sites enforced it — the static palette bake
  (`#slotSurface`), the mover surface words (`isPromotedEmitter`) and the
  analytic-only occluder spheres — and all three asked "does this mesh hold one
  of the four PROMOTED SEATS?", which was the whole NEE set when they were
  written. `#isNeeEmitterMesh` now answers for the tree set as well.
  - ⚠ **IT KEYS ON `__giSrcLightTree`, NOT ON `__giEmitterTileCut`, AND THE
    DIFFERENCE IS THE WHOLE FINDING.** R5 is a statement about the TRANSPORT
    ([J] samples it); the tile cut is a statement about the SCREEN (which
    emitters shade a visible pixel). Keyed to the screen hatch, the zeroing
    deleted the un-seated lamps' emission from the field while nothing in the
    transport had taken over sampling them: their entire multi-bounce
    contribution vanished and a single screen-space direct term came back in
    its place. The rig read it in one run — **RECOVERY +0.052 → −0.063, the
    far half DARKER with the cut on than off.** Re-keyed to the transport
    hatch and run with both armed, RECOVERY is **+0.0833**, the best the cut
    has measured, because the comparison is finally honest on both sides (the
    off arm's mean drops 0.599 → 0.562 — that was double-delivered energy).
    **The two hatches are not independent and flip together**; the build now
    warns when the cut is armed alone.
  - **`emitterMeshes` WIRED** (srcSurface's palette flag, defaulted to
    "nobody" since it was written). It made `emissiveOrphans` — the one check
    a GPU counter structurally cannot make, "this surface's light exists on
    neither path" — fire on every correctly-zeroed emitter. The palette now
    names the NEE set (seats first, so an index below MAX_EMITTERS still means
    the slot it always did), and the stats object is published as
    `__giSurfacePaletteLive` so a gate can read it. The GPU R5 branch is
    unaffected: it compares against giLight's SLOT array, so a tree-only index
    reads "not a slot light" and finds nothing to zero — the palette having
    zeroed it on the CPU already.
  - **Gate (folded into `SEAM=1 LAMPS=4,12 TREE=1 run-gi-emitter-scale.mjs`):**
    NEE-flagged palette entries **N=4: 4/4 both arms; N=12: 12/12 both arms**,
    `emissiveOrphans` **0 everywhere**. With N=4 PARITY 1.020, N=12 RECOVERY
    +0.0833, SEAM PASS, emitterShadow 1.21 → 0.82 ms. `test:gi-lighttree-nee`
    re-run: energy ratio 1.008, noise 0.96×.
- **THE SPONZA-SCALE ms LEDGER. ✅ RECORDED (2026-08-15,
  `npm run test:gi-lighttree-sponza`).** The last gate the plan named, and it
  opened with a finding about the scene rather than the tree:
  **the user's Sponza carries ZERO emissive meshes and no light on GI shadow
  source** — probed at 73 entities / 130 meshes, and every emitter pass reads
  "NOT dispatched — 0 emitters" end to end. As saved, that scene cannot price
  the tree at all, and a ledger run against it would have reported a
  meaningless Δ0.000 as a pass.
  So the rig MAKES emitters, in memory only: N meshes drawn from **GI's own
  entry list** get a cloned material at `emissiveIntensity` 100. Two traps,
  both now written into the rig — (1) a scene traverse reaches UI meshes, and
  `Material.clone()` deep-copies `userData` THROUGH JSON, which turns a
  UiImage's uniform NODES into plain objects and throws once per frame until
  CDP times out; (2) a one-shot clone survives exactly ONE GI rebuild before
  the editor re-applies the material from its asset — the first run built a
  15-emitter tree and then measured a system with `_emitterCands` back to 0,
  so the injection is a self-healing watcher that re-applies and re-requests
  the rebuild. Nothing is written to disk: the tauri shim has no write path
  and `scene.save` is never called.
  **Ledger (2 rounds, ABBA, 15 bright emitters at strength 100, same canvas
  area on both arms, high preset):**

  | | slots | tree+cut | Δ |
  |---|---|---|---|
  | screen total | 6.572 ms | **6.162 ms** | **−0.410** |
  | emitter chain | 6.293 | 6.026 | −0.267 |
  | emitterShadowPass | 6.010 | 5.722 | −0.288 |
  | resolve | 0.168 | 0.202 | +0.034 |
  | emitterTileCut (new pass) | — | 0.05–0.06 | — |

  Both tree rounds armed (cut boot line 242×118 tiles at **tileSize 1**, and
  the `[J]` NEE line at depth 4 over 15 emitters); palette NEE flags **4 →
  15** with `emissiveOrphans` **0 on all four arms**. At real scene scale the
  tree+cut is CHEAPER while lighting 15 emitters instead of 4 — the per-pixel
  cut's O(N) scan costs 0.06 ms and buys back more than that in the march.
  ⚠ **The energy column is NOT a result here.** One slots arm captured a black
  frame (meanLum 0.000 with entirely normal ms — the §12.66 black-boot class,
  and the retry loop the rig now carries did not clear it), and the
  injected-lamp harness heals asynchronously, so it is not a fair energy
  instrument either. The energy claims stay where they were measured: the
  storm rig's PARITY/RECOVERY and `test:gi-lighttree-nee`.
- **W5c — retire the seats** (`MAX_EMITTERS`, the promotion path, the
  camera-cadence re-rank, giLight's slot glow re-keyed to tile lists). NOT
  DONE. It is pure removal once the defaults flip, and doing it before they
  flip would leave no arm to A/B against.

Order stands W4a → W4b → W4c → W5a → W5b → ledger → **THE FLIP ✅ TAKEN
2026-08-15.** `__giSrcLightTree` and `__giEmitterTileCut` are `!== false` now,
**together** (§12.70 W5b — never one).

**The off arms went first, and that ordering is the point.** Every rig armed by
setting the hatch `true` and took the DEFAULT as its control, so flipping the
default alone would have turned `run-gi-emitter-scale`, `run-gi-lighttree-nee`
and `run-gi-sponza-lighttree` into on-vs-on — every gate would keep printing
PASS while comparing the tree against itself. All three now set the hatches
explicitly on BOTH arms. The proof the fix worked is that the gates still
DISCRIMINATE after the flip:

| gate | post-flip |
|---|---|
| N=4 PARITY | 1.040 (bar ≤1.05) |
| N=12 RECOVERY | **+0.0816** (bar ≥0.008) — an on-vs-on gate would read ~0 |
| SEAM | PASS |
| R5 palette flags / orphans | 4→4 and 12→12 / 0 everywhere |
| `test:gi-lighttree-nee` | energy 1.009, noise 0.98× |
| `test:gi-lighttree-mover` | both arms PASS |
| `test:gi-lighttree`, `-descent`, `test:gi-occupancy`, `smoke:gi-gpu` | PASS |

Also flipped with them: the "UNARMED" diagnostic now prints only when the
scene HAS emitters (a scene with none is not missing anything), and the
"armed without `__giSrcLightTree`" warning fires on an explicit `false` rather
than on a missing `true`.

**What the flip does NOT touch: a scene with no emissive meshes.** Measured on
the user's real Sponza, which has zero: GI screen total 0.047 → 0.104 ms
inside the run-to-run spread, the cut logs UNARMED (`region=false`), and
meanLum is identical to four decimal places (0.3041 vs 0.3033). Whole-frame
fps on that harness is NOT a usable instrument — four boots of identical
configuration read 27/45/51/68 fps and 10.4–20.8 ms GPU, with the viewport
panel coming back at two different heights. Quote GI pass ms, never harness
fps.

Still open: **W5c**.

Known limits carried into that decision, none of them blockers but all of
them unmeasured: the tail compensation rides the KEPT lamps' visibility (no
occlusion term in `importance`, capped at 2); giLight's material glow goes
unshadowed under the cut (the W4b trade, W5c's to re-key); and a mover emitter
that is ALSO adopted as an exact dynamic object has no gate of its own.

### 12.71 THE NEW-SPONZA QUALITY LEDGER — what the banner Sponza exposed (2026-08-14 night)

The user's Intel/banner Sponza (26 meshes, 262k tris, curtains + gold-metal
embroidery, Belfast HDR env, day-cycle sun script) against their Blender
reference. Perf ledger + acquittals live in the `new-sponza-perf` memory; this
section is the QUALITY spec. Verified that night: the boot is clean (the
empty-struct MRT-leak class is fixed — see the 2026-08-14 NIGHT memory block),
post/compression/shadow-map/sun-death all acquitted by live bisect. Three
structural gaps remain, ranked:

**(a) SUB-CELL SURFACES SHARE ONE RADIANCE CELL — the flat-curtain mechanism.**
Not ray tunneling: the composited field gives thin geometry one occupancy
shell per side, needing ~2 cells across a wall; a 2-5cm curtain at 0.26m
ultra cells collapses BOTH faces into one cell, so the lit side and the dark
side become one value — double-lit flat fabric, "unresponsive to probe
density, a CELL SIZE problem" (GISystem's watertightness note, ~6331). The
volume-shrink advice in that warning does NOT rescue cloth: corridor-only
bounds move cells 0.26→~0.17m, still 4-8× thicker than a curtain. ⚠ The
per-mesh thin-detector under-counts here — it tests each mesh's UNION box
thinnest axis, and a mesh holding 20 curtains spread across the building has
a thick union; only 3 real meshes flagged while every curtain is locally
sub-cell. FIX DIRECTION (its own unit, not an evening): normal-side-aware
cell radiance at the GATHER — surface records already carry per-surface
normals + §12.52 attribution; a receiver should reject/weight cell radiance
whose attributed source normal opposes its own. Prereq reading:
cascadeGather's ONE-SIDED notes, gi-src-surface-attribution memory. Interim
content-side truth: none of the shipping knobs fix cloth; say so rather than
sell a preset.

**(b) METALS GO BLACK INDOORS.** §12.64 suppresses per-material env IBL under
GI (correct — unoccluded IBL washed the scene); metals then live on SSR
(user runs it half-res, `screenEdgeFade 0` shows the white background
fallback at full strength on screen-exit rays — the embroidery blowout that
bloom smears into blotches) + whatever GI specular the bucket gives them
(this scene: 0 mirror / 24 dynamic-roughness). Braziers read pure black,
embroidery blows white — Blender's metals reflect the interior.

**ROOT CAUSE PROVEN 2026-08-14 night (live probe sphere, metalness flip):**
a gray metal sphere (albedo #b0b0b0, m=1) renders PITCH BLACK in the sunlit
corridor at r=0.25 AND r=0.05, while the identical sphere at metalness 0 is
beautifully lit ⇒ GI diffuse fine, `context.radiance` ≡ 0. Two nulls stack:
(1) `deferredRadianceLookup` is PERMANENTLY null — GISystem ~5908's own
comment: the cascade reader (createRadianceLookup) was deleted with the
cascades and "rough/glossy surfaces lose their blurred environment term
until Phase 1-3"; with `radianceFn`/`giRadianceNode` both null, giLight's
ENTIRE specular block (gate at giLight ~1409) compiles out — including,
note, the exact-BVH mirror blend at ~1474, which sits INSIDE the gated
block: `bvh: exact reflections ON` traces and shades hits every frame that
no material can read. (2) three's `indirectSpecular = radiance·single +
multi·(iblIrradiance/π)` — the iblIrradiance leg was the env IBL, which
§12.64 now suppresses. 0 + 0 = black metal; old Sponza had no metals so it
shipped unseen. FIX (the deferred Phase 1-3, now due): rebuild the
directional radiance lookup over TODAY's field — resample the SRC probe
tile atlas (or the resolve's radiance target, once the resolve writes it
for non-mirror pixels) along `reflect(V,N)` with roughness-driven
blur/cascade choice, assign it to `deferredRadianceLookup`, and the whole
dormant giLight machinery (sharp/soft mixes, exact-hit blend, mirror gate)
comes back for free. Verify with the SAME probe-sphere protocol. Plus: SSR
screenEdgeFade default > 0 in the post node (user's stored 0 → 0.4 fixed
live 2026-08-14).

**v1 SHIPPED AND DEMOTED TO OPT-IN THE SAME NIGHT (`__giGlossyRadiance =
true` to arm).** Gates passed (smoke 8/8 storage, SRC-on NEE energy 0.966)
but the user's lamp-lit night scene showed FLICKERING WHITE BLOBS on the
metallic embroidery, confirmed ours by zeroing SSR live (blobs persisted,
flickering). Mechanism: the diffuse gather averages many bins THEN rides
the §12.65 temporal filter; the directional lookup samples ~one bin along
one direction into a radiance target NO temporal pass touches — per-frame
probe noise on every glossy pixel — and it re-delivers emitters the
resolve's emitter-direct term already lights (double delivery, so lamps
blob twice as bright). v2 checklist before default-ON: (1) temporal filter
on the radiance target (reuse createGiIrradianceTemporalPass verbatim —
same shim pattern as §12.65); (2) emitter de-duplication (either subtract
the emitter-direct estimate from the lookup or exclude promoted-emitter
energy from the bins the lookup reads); (3) luminance cap tied to the
emitter-direct scale; (4) the probe-sphere protocol AND a lamp-lit flicker
rig (rev/px on a metal patch, same instrument family as §12.59) as gates.
Dark-but-stable metals until then.

**(c) LOWER PRESETS DARKEN INDIRECT-ONLY REGIONS on this scene** (medium vs
ultra: sunlit areas match, vaults/arcades visibly darker; live screenshot
pair 2026-08-14). §12.68-class preset-energy violation, NEW scene shape
(no emitters, env-only + sun through apertures). Needs the rig with
readbacks — same-pose meanLum by region across quality arms on the real
project via the tauri shim (run-gi-sponza-* pattern), then find which
derived term loses energy. Presets trade rays/probes/resolution, NEVER
energy.

Also recorded: the day-cycle LightScript moves the sun every play session —
no cross-session look comparison is valid without matching sun angle first
(two of this night's false suspicions came from exactly that).

---

## 12.72 PRESET ENERGY, PART 2 — THE OCCUPANCY VOXEL (2026-08-15, SHIPPED)

§12.71(c)'s open item, closed with the readback rig it asked for. The user's
report was the same sentence §12.68 answered ("GI produces less indirect light
than it used to, and it gets worse on lower presets") and the answer is the same
SHAPE with a different knob: a second HIT-PRECISION control was still tier-keyed,
and hit precision costs ENERGY, not detail.

`GISystem.#buildOccupancyField` sized the occupancy voxel from a tier table —
low 0.25 / medium 0.175 / high 0.125 / ultra 0.1 m, "relaxed for cost". A coarser
voxel fattens every surface by ~half a cell: arcade openings narrow, grazing rays
stop on phantom hulls near their birth surface, and the deposit carries that dark
hit with T=0. It is multiplicative and it lands exactly where GI is the only
light — the vaults and arcades the user pointed at.

**Measured on the user's banner Sponza** (`run-gi-preset-energy.mjs`, one fresh
boot per arm, §12.66 pose, single knob — `__giOccVoxelTarget`/`__giOccBudget`
are the new dials):

| occ voxel | mean free path | GI gather mean | frame blackFrac | field |
|---|---|---|---|---|
| 0.225 m (low, was) | 2.45 m | 0.283 | 4.0 % | 23 MB |
| 0.163 m (medium, was) | 2.87 m | 0.389 | 14.6 % | 43 MB |
| 0.114 m | 3.28 m | 0.662 | 0.9 % | 110 MB |
| 0.095 m | 3.51 m | 0.756 | 0.9 % | 177 MB |
| 0.092 m (ultra) | 3.59 m | **0.730** | — | 153 MB |

**Medium at ultra's PRECISION matches ultra's ENERGY while still firing 8× fewer
rays** (26 330 vs 210 635 rays/frame; gather mean 0.771 vs 0.730 after the fix).
That is the whole thesis in one row: rays buy noise, the voxel buys energy.
hitRate is flat (0.957–0.965) and unattributedRate is flat (2–3 %) across every
arm — attribution and the record pool are innocent, as in §12.68.

SHIPPED: the target is preset-independent at 0.1 m (spec §1.1's own range) and
the tier ladder moved to the BUDGET, which is a real memory ceiling in cells —
low 8e6 / medium 16e6 / high 32e6 / ultra 64e6. The budget binds only on volumes
too large to hold at 0.1 m and then degrades knowingly; on this scene ultra is
byte-identical, medium goes 43 → 177 MB, low 23 → 107 MB (0.121 m, still
budget-clamped: gather 0.617, and low's remaining gap to ultra is its documented
single-bounce tier).

⚠ GATE TRAP PAID: `test:gi-occupancy`'s INSTANCED assertion probed a fixed
**±2-voxel** window around each instance centre. Occupancy is a SURFACE
voxelization, so an instance's centre is empty and the only bits are its 0.6 m
cube's shell at ±0.3 m — the window reached it at 0.116 m voxels and read ZERO
the moment the field got finer, reporting "instances are not voxelized" while
they were. The radius is in METRES now. (`composite clamps from a level at least
as coarse as its cell` still FAILS on both arms — pre-existing, verified against
a stashed baseline.)

ALSO FOUND, SCENE-SIDE, NOT AN ENGINE BUG: the scene's Environment is EMPTY
(`environment.cubemap: ""`), so `sceneSkyRadiance` returns 0 and the GI boot log
says so in full — "every photon here comes from a lamp and ONE bounce". With one
directional light, no emitters and ambient 0, shadowed regions have literally no
fill, which is most of the gap against the user's Blender reference (whose world
lights the shade). Set Scene → Environment to get the occluded sky fill back.

## 12.73 A LIGHT GOING OUT IS A LIGHT EVENT (2026-08-15, SHIPPED)

User: "after an emissive object disappears, light from it remains for like a
minute until completely vanish." It did, and the code said so: all three of
`#refreshEmitterSlots`'s "this slot has no emitter now" paths — seat unfilled,
provider returning no shape, mesh hidden or despawned — published
`slot.moved = 0`. The one frame on which the field is most wrong was reported
as a quiet frame, so `mLight` never crossed `ALPHA_TRACK_THRESHOLD`, §12.43's
window never armed, and the stale deposit drained at the still α (0.02 per
refresh interval ⇒ t90 ≈ 30–60 s at stride ~9 / 30 fps).

SHIPPED: `publishGone(i, slot, key)` publishes a full event on the FALLING
edge, exactly as a fresh promotion publishes one on the rising edge, with
liveness tracked per SLOT on the system (`_emitterSlotLive`) so a GI rebuild
cannot fake either edge — the §12.48 trap that made a parked lamp re-arm the
window every rebuild and pinned the ray cap OFF. `publishMoved` also grew a
LUMINANCE term (`dLum`, the light arm's §12.38.3 `lumMotion` on the emitter's
own radiance): a dimming lamp or an animated emissive changed the field while
`motionOf` — pose only — reported nothing.

## 12.74 THE ROOT AND THE CAP WERE ONE SIGNAL (2026-08-15, SHIPPED)

User, same session: "any light that moves, temporal is just too slow to keep
up, it feels very unresponsive." The decay root
`rootS = 1 + (stride − 1)·(1 − tr)` relaxes only while the light-event window
is open, and §12.46 made that window RISING-EDGE precisely so a continuously
moving light could not hold it open — because an open window ALSO lifts the
per-probe ray cap to OFF, a 3.8× deposit swing. Two effects, one signal: the
cheap half (forget faster) was withheld because the expensive half (fire more
rays) had to be. With the window shut, α is spread across a whole refresh
interval by the stride root, so a moving light settles with t90 ≈ 7 s.

SHIPPED: the root now also relaxes with SUSTAINED motion —
`max(tr, sustained)`, where `sustained` requires `mLight ≥ 0.15` continuously
for `MOTION_SUSTAIN_MS` (250 ms) — while the cap keeps reading `tr` alone and
stays capped. History that is being continuously invalidated is not evidence
worth preserving, and preserving it costs nothing to stop. Expected: t90 ≈ 0.8 s
at 30 fps for a moving light, with no extra rays. ⚠ The sustain requirement IS
the safety argument: §12.43's first draft derived the root from α directly and
TRACK_AB refuted it — a one-frame spurious spike became a burst of relaxed-root
fast decay, still controls 21.2 vs 0.92 rev/px ("water caustics on a parked
floor"). A spike cannot survive 250 ms of continuous above-threshold motion.
Hatch: `__giSrcMotionRoot = false`; `__giSrcMotionRootLive` publishes the term.

## 12.75 THE COMPRESSOR ATE THE IMPORT SETTINGS (2026-08-15, SHIPPED)

Found while chasing "the metallic roughness map is slipped, not matching the
albedo". `basisCompress.writeMeta` merged the new `basis` block into
`(await readAssetMeta(...)) ?? {}` — and `readAssetMeta` returns null for BOTH
"no meta file" and "the read or the parse failed", so one unreadable read
rewrote the sidecar as `{"basis": {...}}` and dropped everything else. All 69
of the user's sponza2 metas were in exactly that state, missing the glTF
importer's `flipY: false` and `colorSpace: "linear"`.

Both losses are INVISIBLE while every map is compressed — a compressed texture
cannot be flipped at upload, so all of them agreed on the wrong orientation —
and both bite the moment one map is not: a PNG ORM against a KTX2 albedo comes
back flipped against it (the "slipped" report), and normal/ORM maps start being
sRGB-decoded as colour, which is a silent PBR error on every surface.

SHIPPED: `writeMeta` distinguishes "no sidecar" (write the first one) from "a
sidecar that would not parse" (throw, naming the file — refusing to compress
beats losing import settings). The user's 69 metas were restored by hand
(flipY false, colorSpace srgb for diffuse / linear for orm+normal) and the
whole sponza2 set left uncompressed, which also retires the ETC1S-on-a-non-
colour-map damage until the encoder grows UASTC (§12.71's queued unit).

## 12.76 THE THIN-GEOMETRY WARNING WAS LYING (2026-08-15, MEASURED + FIXED)

Scoping the "banners don't block GI" quality item started with the measurement
it deserved, and killed the item.

`THICK=0.05 npm run test:gi-sunleak` at quality high — a 5 cm wall against
0.089 m voxels, i.e. HALF a cell — sealed box, sun outside:

| wall | interior added by GI | verdict |
|---|---|---|
| 0.40 m | 0.00000 | PASS |
| 0.10 m | 0.00000 | PASS |
| 0.05 m | 0.00000 | PASS |

Bit-identical, against a 0.002 threshold. `test:gi-occupancy` agrees from the
other side: sub-voxel 0.08 m walls fully present (1350/1350 probes), closed
room SEALED (400/400 rays blocked). **Thin geometry blocks GI light.** The
warning claiming otherwise was written for the COMPOSITED distance field —
which did need ~2 cells to keep a wall's two faces apart — and never updated
when occupancy became conservatively rasterized with exact per-cell triangles.

It cost real work: the banner Sponza's flat curtains were filed against it, and
this session's "sparse occupancy field" plan was scoped around it. Rewritten to
say what is actually true — thin meshes block, but their two faces share a cell,
hence one surface record and one bounce colour, so no front/back shading
difference and no sub-cell detail. Same lesson as §12.66, in a second place.

**And the memory it was used to justify is not where the memory is.** The
occupancy field's 150.49 MB on the user's Sponza (336×160×224 @ 0.095 m):

| term | words | MB | scales with |
|---|---|---|---|
| surface records + scratch | 14.9 M | 59.7 | `level0VoxelCount / 12` |
| complex triangles | 18.1 M | 72.3 | `surfaceCapacity × 2` |
| attribution stamps + palette | 2.1 M | 8.5 | records |
| level-0 bits | 0.38 M | 1.5 | dense cells |
| density pyramid | ~0.43 M | ~1.7 | dense cells |

The BITS — the thing a brick allocator would sparsify — are 3 MB of 150. 88% is
the record/triangle pools, which are already claimed on demand (803,173 of
1,003,520 records live on this scene) but SIZED from the dense cell count. That
is the real defect: occupied cells scale with SURFACE AREA (1/s²) while the
`/12` heuristic scales with VOLUME (1/s³), so every halving of the voxel
over-allocates twice as badly. Sizing the pools from measured or estimated
occupancy — with the existing POOL STARVED audit as the safety net — is worth
~20-25% here and is the precondition for any finer-cell plan. NEXT UNIT.

**§12.76a triangle-pool ceiling SHIPPED + MEASURED (2026-08-15).** `2 triangles
per record` → 1.5, from the live ratio (976,084 / 805,328 = **1.21**). Same
scene, same pose, ultra: field **153.49 → 136.26 MB (−17.2, −11%)**, pool 65%
used instead of 48%, and the per-cell overflow count is 2,666 — IDENTICAL to
the pre-change run, so nothing new fell back to box hits. `test:gi-rayhit-phase4`
ALL PASS (including its starved-pool arm). The record pool is untouched: on this
scene `/12` lands within 25% of the truth (805,328 of 1,003,520 claimed), so the
surface-area estimator is only worth building when a preset or a tighter volume
makes the cells finer — where `/12` (volume) diverges from occupancy (area).

## 12.77 THE FRAME BUDGET — WHAT 60 FPS AT ULTRA AND 120 FPS AT LOW ACTUALLY COST (2026-08-15, MEASURED)

User target: **60+ fps at ultra, 120+ fps at low, without losing quality.** This
section prices it. Every number below is one live reading of the banner Sponza
(`GAME/scenes/Sponza.scene`, 73 entities, 191 draws, 762k tris, 1192 MB texture
memory, 0 emitters, no gi-shadow light) at 1588×898, renderScale 1, ultra.

⚠ **AND EVERY NUMBER IS A THROTTLED NUMBER.** `nvidia-smi` at the moment of
measurement: **P3, 51.25 W against a 72.54 W limit, 1785 of 3105 MHz, `SW Power
Cap: Active` AND `SW Thermal Slowdown: Active`.** This is not the 33 W Silent
cap of [[dual-gpu-webview2-pin]] — it is a milder one, but the GPU is still
running at ~57% of its boost clock. Re-measure the whole ladder from Turbo
before treating any single item below as a ceiling.

### The frame, decomposed

`profile_frameStats`: **34.41 ms GPU / 27 fps**, cpu 6.83 ms.

`profile_giPasses` — GI is **12.22 ms, 35% of the frame**:

| block | ms |
|---|---|
| srcProbes chain | 9.225 |
| resolve | 2.169 |
| irrTemporalPass + irrHistoryPass | 0.823 |
| **GI total** | **12.22** |
| **everything else (raster + post)** | **22.19** |

⚠ `resolve` appears in BOTH `screenPassesMs` and `queueMs` — same pass, two
tables. Counting it twice inflates GI by 2.2 ms; the ledger above counts it once.
The `emitterShadow*` rows print a nonzero ms next to "NOT dispatched — 0
emitters" and cost nothing on this scene.

### THE FINDING: the SRC chain's cost is proportional to the POOL, not to the live probes

The cascade occupancy table, same reading:

| cascade | live | capacity | load factor | failedInserts |
|---|---|---|---|---|
| 0 | 1,788 | 131,072 | 0.007 | 0 |
| 1 | 598 | 65,536 | 0.005 | 0 |
| 2 | 183 | 32,768 | 0.003 | 0 |
| 3 | 54 | 16,384 | 0.002 | 0 |

**2,623 live probes in 245,760 slots — 1.07%.** And `.compute()` bakes its thread
count, so the passes sized from `probeCapacity` / `hashCapacity` /
`blockCapacity` / `binTotal` sweep the whole allocation every frame regardless.
Splitting the group table by what each pass is proportional to:

| group | ms | proportional to |
|---|---|---|
| gather | 2.713 | resolve pixels |
| deposit (trace + attribute) | 1.577 | rays (17,130) |
| **deposit (decay)** | **0.954** | **bin pool** |
| **populate** | **0.936** | **probe + hash capacity** |
| **tiles** | **0.894** | **block pool x texels** |
| shade + bounce [J] | 0.836 | hits |
| **deposit (resolve)** | **0.486** | **binTotal** |
| **merge** | **0.411** | **blockCapacity x bins** |
| **rays** | **0.309** | **probeCapacity (6 sites)** |
| **seed** | **0.082** | **probeCapacity x groups** |
| **hashBlock** | **0.020** | **hash capacity** |
| surfaces (palette) | 0.008 | records |

**Live-proportional: 5.13 ms. Capacity-proportional: 4.09 ms — 44% of the
srcProbes chain, 33% of all GI, spent on slots that are 99% empty.**

This is the identity of §12.57's unexplained residue ("srcProbes 9.6 ms is
PRESET-INDEPENDENT — the true 'lower presets do not help' term"). Presets move
rays, probe density and resolve scale; not one of them moves an allocation, so
4 ms of GI is the same at low as at ultra. It is also why §12.72's fix — which
was right on energy — made low and medium *more* expensive in memory without
buying frame time back.

The sizing input is the culprit and it is a proxy for a measured quantity:
`expectedC0Probes(pixelCount)` is a quarter of the pixel count, floored at
16,384, saturating at 131,072 — while the system counts `live`, `failedInserts`
and `COUNTER_NOBLOCK` every single frame.

### Unit A — pool sizing (≈ −4 ms at EVERY preset, no quality change)

Cheapest first. A1 and A2 are hours; A3 is the real fix.

- **A2 (do this first — it is one boot).** `__giSrcBinBudget` ALREADY EXISTS as a
  build hatch on `BIN_BUDGET` (1.4 M bins ≈ 48 MB), and it drives decay,
  deposit-resolve, merge and tiles = 2.75 ms. Boot the user's Sponza at
  175,000 and read `giPasses` + `COUNTER_NOBLOCK` + a screenshot A/B. This is
  the decisive experiment for the whole section: if those four passes fall
  proportionally with `noBlock` still 0, Unit A is confirmed and A1/A3 are
  scheduling, not research.
- **A1.** Add the matching `__giSrcC0Probes` hatch (there is none — c0 is
  pixel-derived), then replace the pixel proxy with a measured high-water mark:
  size from `live` with hysteresis, grow on `failedInserts`/`noBlock` pressure.
  The starvation counters are the safety net and they already exist; §12.52.2's
  record-pool starvation is the failure mode to respect — **grow-on-pressure
  must land before shrink-on-slack ships**, or an enclosed scene gets the
  palette-mean wash again.
  ⚠ The store rebuild is the §12.48 resize path, which has bitten twice
  (`setSize` forwarding 6 of 10 args; the resolve rebuilt over disposed
  buffers). Re-sizing must ride that path, not a new one.
- **A3.** Drive the capacity passes off the compact pass's live count by
  indirect dispatch. Blocked on whether three's WebGPU backend exposes
  `dispatchWorkgroupsIndirect` through TSL at all — `.compute(n)` bakes n, and
  srcSystem's own comment at :438 says the thread count "cannot be a uniform".
  Check before planning around it; if it is not reachable, A1+A2 is the whole
  win and A3 is a three.js upstream item.

### Unit B — the per-pixel half of GI (ultra only)

gather 2.713 + resolve 2.169 = 4.88 ms of full-resolution work. Ultra is
*defined* as the full-res resolve (BY_TIER's comment: ultra pays ~4x to remove
the upsampled shadow/AO edges), so cutting it IS losing quality and it sits
below the line the user drew. Noted for completeness; not proposed.

### Unit C — the other 22.19 ms, which is the majority of the 60 fps job

**Arithmetic first: with GI free, this frame is 22.19 ms = 45 fps.** No amount of
GI work reaches 60 at ultra on its own. Named levers, from the ledger in
[[new-sponza-perf]]:

- **SSR is the pole and it is blocked on a denoiser.** Full-res + 5 blur levels;
  the user's own no-post test put the whole post chain at ~7-13 ms. Half-res SSR
  was tried and *caused* the metallic-embroidery flicker (user-confirmed by an
  intensity-0 A/B), so the unit is **an SSR temporal/reprojection pass first,
  then half res** — worth ~2-3 ms and it is the single biggest non-GI win.
- **Godrays at half res.** GTAO is already 849x453.
- **Raster ≈ 12 ms** over 1192 MB of uncompressed 4K PBR — bandwidth. The lever
  is texture compression and it is blocked on **UASTC in the Rust encoder**
  (ETC1S crushed the ORM/normal maps; the rule and the mitigation are in
  [[new-sponza-perf]]). Queued with a known spec.
- **MSAA 4 and the sun shadow map are both ACQUITTED** — measured, each < 1 ms.
  Do not re-spend time there.

### Unit D — the machine (free, and it is not engine work)

Armoury Crate → Turbo, and re-check `nvidia-smi -q -d PERFORMANCE,POWER`. Going
from 51 W / 1785 MHz to the 90 W ceiling is worth roughly 1.4-1.7x on a
per-pixel-bound frame: 34.4 ms → ~22 ms → ~45 fps before a line of code changes.

### Verdict against the two targets

**60 fps at ultra (16.7 ms): reachable, but not from GI alone.**
`(34.4 − 4 [A] − 3 [C: SSR]) x ~0.67 [D]` ≈ 18 ms ≈ 55 fps, with texture
compression (UASTC) as the reserve that closes it. Every term is required.

**120 fps at low (8.3 ms): the GI preset cannot deliver it, and that needs
saying plainly.** `BY_TIER` only sets `resolveScale` and `exactReflections` —
the preset governs GI and nothing else. Raster + post stay ~22 ms at low, which
is 45 fps before GI runs. **120 fps at low is a RENDERER target (Unit C + D +
renderScale), not a GI target.** What GI owes it:

| | today at low | after Unit A |
|---|---|---|
| capacity passes | 4.09 | ~0.5 |
| deposit trace + shade | ~2.4 | ~1.2 |
| gather + resolve + irr chain (÷4 at resolveScale 0.5) | ~1.4 | ~1.4 |
| **GI at low** | **~7.9 ms** | **~3.1 ms** |

Today GI at low is the ENTIRE 120 fps budget. Unit A is what makes the target
arguable at all. Getting from 3.1 to the ~2 ms a 120 fps frame can spare is
§9's named lever, untouched since it was written: **rays/pixel < 1 —
checkerboard + temporal ray budget.** That is the next GI unit after A.

### Order of work

1. **A2** — the `__giSrcBinBudget` boot A/B. One experiment, decides Unit A.
2. **D** — unthrottle, re-measure the whole ladder. Costs nothing, moves everything.
3. **A1** — measured pool sizing, grow-on-pressure before shrink-on-slack.
4. **C** — SSR temporal → half-res SSR; godrays half-res.
5. **UASTC** in the Rust encoder, then re-enable the sponza2 metas.
6. **Rays/pixel < 1** for the low preset.

## 12.78 GI IS NO LONGER WHY BASIS IS OFF — THE ENCODER IS (2026-08-15, AUDITED)

User: *"I believe we disable basis for GI, so textures are huge. Isn't there a way
we could use texture compression with GI?"* — the belief is out of date by one
session, and the real blocker is somewhere else.

**GI handles compressed textures. That shipped.** `voxelizeOnce`'s bounce-albedo
sampler used the canvas path, and a KTX2 texture has no drawable `image`, so it
cached null and the near-white glTF base-colour factor stood in — the washout the
user correctly attributed to compression. The fix is in the tree and verified
this session: `computeCompressedTextureAverage` (giScreen.js:2285 — a 32×32 quad
render of the compressed texture into a LINEAR rgba8 target plus a readback, with
the sRGB decode in-shader so the mean is unbiased), the `pendingTextureAverages`
queue in voxelizeOnce (compressed → queue and return null UNCACHED, riding the
existing retry-next-scan contract), and the drain in GISystem's tick (:1910,
gated on `!this._compileWaveActive` and draining the WHOLE queue in one tick —
the trickle caused a boot rebuild storm). **Nothing about GI requires uncompressed
textures today.**

**What actually turned the 69 metas off is `compress_texture_basis`
(src-tauri/src/lib.rs:22).** It takes a path and nothing else, and hardcodes:

```
basisu <path> -ktx2 -mipmap -linear -q 180 -output_file <path>.basis
```

Two defects in one line, both confirmed against the vendored encoder's own help
text (`node_modules/@gpu-tex-enc/basis/bin/win32-x64/basisu.exe`):

1. **ETC1S for everything.** There is no `-uastc`, so ORM and normal maps get a
   codec built for perceptual colour — which is what crushed the thread-scale
   metalness to ~0 while the source PNG histogrammed fine, and killed the
   embroidery reflections. The rule is already written down: never ETC1S a
   non-colour map.
2. **`-linear` unconditionally — and that one is wrong for the ALBEDO.** basisu's
   help: *"By default, textures will be converted from sRGB to linear light
   before mipmap filtering, then back to sRGB … unless `-linear` is specified"*,
   and `-linear` also swaps the codec's sRGB error metric for a linear one. So
   every compressed diffuse map was mip-filtered in the wrong space and had its
   bits allocated against the wrong metric. **This is a live candidate for the
   OPEN residual in [[new-sponza-perf]]** — the user's *"mostly gone… a bit more
   saturated before, still"* after the bounce-albedo fix. It was never on the
   suspect list because nobody read the encoder invocation.

**THE MAP-TYPE SIGNAL ALREADY EXISTS AND NEEDS NO NEW METADATA.** The glTF
importer writes `colorSpace` into each `.meta` — `srgb` for diffuse, `linear` for
orm/normal (this is exactly what §12.75's clobbering bug destroyed and what was
restored by hand). So the selection rule is one read:

| `.meta` colorSpace | codec | flags |
|---|---|---|
| `srgb` (albedo, emissive) | ETC1S | `-q 180`, **no `-linear`** |
| `linear` (ORM, metal-rough) | UASTC | `-uastc -uastc_level 2 -uastc_rdo_l 1.0 -linear` |
| `linear` + normal map | UASTC | as above plus `-normal_map` |

`-normal_map` is a real flag and does the right thing (*"linear colorspace
metrics, linear mipmap filtering, no selector RDO, no sRGB"*). `-q` is
ETC1S-only and is ignored under `-uastc`. KTX2 UASTC is Zstandard-compressed by
default, so the on-disk cost is not the raw 8 bpp.

**What it is worth.** The user's Sponza reports **1192 MB** of texture memory and
[[new-sponza-perf]] prices the raster block at ~12 ms of a 34 ms frame — that
block is bandwidth over uncompressed 4K PBR. ETC1S is ~8× off RGBA8 and UASTC
~4×; a mixed policy lands the set near 200-250 MB and stays compressed in VRAM
rather than only on disk. **This is Unit C's cheapest term and it unblocks the
§12.77 60 fps arithmetic.**

**Work order:** (1) add a `mode` parameter to `compress_texture_basis` and pass
the flag sets above; (2) have `compressTextureBasisImpl` read `colorSpace` from
the `.meta` and choose — the `writeMeta` clobber guard is already in place
(basisCompress.js:37, throws rather than dropping settings); (3) gate it
NUMERICALLY — decode the KTX2 through a harness readback and compare rows and
channel means against the source PNG. That gate is also what settles the OPEN
orientation mystery, which was last chased by flipping `flipY` at the live scene
and reading nothing. (4) Only then re-enable the 69 metas.

⚠ Do not re-enable compression before the gate exists. This asset set has now
been damaged twice — once by the codec, once by the meta writer — and both times
it was diagnosed from the picture rather than from a number.

## 12.77.1 UNIT A MEASURED — THE A2 EXPERIMENT RAN, AND IT CONFIRMS WITH ONE CORRECTION (2026-08-15)

`scripts/run-gi-poolsize.mjs` (NEW), four fresh boots of the REAL project at the
§12.66 pose, ultra, **identical resolve dims (806×392) on all four** so the
comparison is legitimate. Two controls, two treatments. `__giSrcC0Probes` was
added to srcSystem.js this session — the bin pool had a dial, the probe-slot
pool did not.

| arm | capacityMs | GI total | MB | orphanRate | frameMean | rays |
|---|---|---|---|---|---|---|
| control | 3.685 | 9.045 | 88.22 | 0.216 | 0.2672 | 28118 |
| control (replicate) | 3.544 | 7.053 | 88.22 | 0.257 | 0.2152 | 28104 |
| `__giSrcBinBudget=700000` | 1.594 | 6.271 | 60.84 | 0.068 | 0.2717 | 28066 |
| + `__giSrcC0Probes=16384` | **1.187** | **5.762** | **47.66** | 0.068 | 0.2723 | 28078 |

`noBlock 0`, `clamped 0`, `failedInserts [0,0,0,0]` on **all four arms**. Rays,
hits (0.955), meanT (3.47-3.50), shaded and deposits are identical to within
0.2% everywhere — **nothing was skipped; the same transport ran cheaper.**

**THE DISSOCIATION IS THE RESULT, not the totals.** Each knob moved its own
group and left the other flat, which is what rules out "the treatment boot was
luckier":

| group | sized from | control | bin700k | +c0 16k |
|---|---|---|---|---|
| deposit (decay) | bin pool | 1.678 | 0.257 | 0.256 |
| deposit (resolve) | bin pool | 0.693 | 0.201 | 0.199 |
| tiles | block pool | 0.346 | 0.182 | 0.179 |
| merge | blocks × bins | 0.265 | 0.231 | 0.201 |
| populate | probe + hash cap | 0.294 | 0.306 | **0.180** |
| rays | probeCapacity | 0.338 | 0.342 | **0.144** |
| seed | probeCapacity | 0.054 | 0.056 | **0.022** |
| hashBlock | hashCapacity | 0.017 | 0.019 | **0.006** |
| gather | resolve pixels | 0.324 | 0.338 | 0.345 |

The four probe-slot passes are FLAT across the bin-budget arm and only fall when
the slot dial moves; the four bin-pool passes do the reverse. **The cost model in
§12.77 is correct.**

### THE CORRECTION: the two pools are over-allocated by very different factors

§12.77 read "245,760 slots for 2,623 live probes — 1.07%" and priced the whole
4.09 ms against that ratio. Wrong, and the arithmetic says why. `blockCapacities`
splits `BIN_BUDGET` equally across cascades and divides by `binCount(c)`, which
rises 4× per cascade:

| budget | c0/c1/c2/c3 blocks | headroom over live | binTotal | MB |
|---|---|---|---|---|
| 1,400,000 (default) | 10937/2734/683/170 | 3.99/3.01/2.42/2.36 | 1,397,792 | 48.0 |
| 700,000 | 5468/1367/341/85 | 2.00/1.51/1.21/1.18 | 698,624 | 24.0 |
| 525,000 | 4101/1025/256/64 | 1.50/1.13/**0.91**/**0.89** | 524,576 | 18.0 |

**The BIN pool was only ~3× over-allocated and 700k is already near its floor** —
525k starves c2/c3 on this scene. The PROBE-SLOT pool is the one that was 48×
over (131,072 for 2,740 live), and it took a ÷8 with headroom to spare. So the
realistic recoverable figure is **~2.4 ms, not ~4 ms**: control mean 3.61 →
1.19, with GI total ~8.05 → ~6.02 (−25%) and the store 88.2 → 47.7 MB (−46%).

### ⚠ THE DECAY PASS IS SUPERLINEAR, AND THAT IS A CACHE CLIFF, NOT A SLOPE

`binTotal` halves exactly from 1,400k to 700k, but decay fell 1.678 → 0.257.
Even against the noisy control replicate (0.955) it is ~3.7×, not 2×. The bin
pool at 9 words/bin is **48.0 MB at the default and 24.0 MB at 700k**, and the
4070 Laptop's L2 is in between. A pool that fits in L2 is a different machine
from one that does not. Consequences: **the target is not "as small as safe" but
"under L2"**, the win is hardware-specific in MAGNITUDE though not in direction,
and the sizing law should be validated with a budget SWEEP looking for the knee
rather than a single ratio. Not yet run.

### ⚠ TWO THINGS THAT ARE NOT YET UNDERSTOOD — READ BEFORE SHIPPING UNIT A

1. **`orphanRate` improves 3.5× and I cannot explain it.** Controls read 0.216
   and 0.257; BOTH treatments read exactly 0.068. That is replicated and far
   outside the control spread, so it is real, not noise. `orphanRate` is the
   fraction of known bins whose parent lattice had no probe at all — merge's own
   header calls it "the one to watch" — and a smaller pool should if anything
   make it WORSE. `resolvedRate` falling 0.99 → 0.86 is arithmetically expected
   and not a regression: the previously-orphaned bins (kept as-is, outside
   `merged`) now merge, growing the denominator, and they are the far ones that
   do not reach T=0. Live probe counts are identical across arms
   (2740/907/282/72 vs 2740/898/290/81), so it is not a population effect.
   **A pool-size change that alters merge connectivity is not purely a budget
   change. Find the mechanism before this ships** — the direction is favourable
   (more indirect light reaching the ladder, which is the user's standing
   complaint), which is exactly why it would be easy to bank and wrong to.
2. **Cross-boot IMAGE comparison on this rig is weak and the replicate proves
   it.** The two identical controls read frameMean **0.2672 and 0.2152 — a 24%
   spread** on the same config, same pose, same resolve size. The treatments are
   much tighter (0.2717/0.2723) and sit at the top of the control range, and the
   8×6 region grid shows +2.4% mean / +9.9% max, almost all positive. That is
   consistent with the orphan finding but **it is not evidence on its own**.
   Same lesson as §12.63 and [[gi-harness-viewport-traps]]: only the
   capacity-ms split and the replicated orphanRate are quotable here. `decay`
   alone is NOT (0.955 vs 1.678 across two identical controls).

### What this changes in the work order

A2 is **done and positive**. A1 (measured pool sizing) is now scheduling rather
than research, with three constraints the experiment added: size the bin pool
**per cascade from measured live counts**, not by an equal split of one budget
(c2/c3 are the tight ones and the equal split is what makes them tight); aim the
bin pool **under L2** rather than at a fixed ratio; and **explain the orphan
effect first**. The probe-slot pool is the easy half — 48× over, ÷8 measured
clean, and `__giSrcC0Probes` now exists to A/B it.

## 12.78.1 THE ENCODER FIX — SHIPPED AND MEASURED ON THE DAMAGED ASSETS (2026-08-15)

User: *"1GB is occupied with textures, and I think that's why it is slower, we
need to be able to use compressed textures."* Live overlay at the time read
1.04 GB textures; `profile.frameStats` a moment later read 1060.6 MB, 23.14 ms
GPU, 39 fps. (The screenshot's 17 fps was transient — 26.5 ms GPU cannot produce
17 fps; treat single overlay samples as anecdote.)

**SHIPPED, three files.** `compress_texture_basis` (src-tauri/src/lib.rs) takes a
`mode: Option<String>` and builds its arg vector from it; `basisModeFor`
(src/editor/basisCompress.js) derives the mode from the asset's own `.meta`;
`compressTextureBasisImpl` reads the meta BEFORE encoding and records the chosen
`mode` in the `basis` block. `cargo check` clean. **UASTC RDO is deliberately
off** — it trades precision for LZ size, and UASTC transcodes to BC7 either way,
so RDO would shrink the file on disk and give back exactly the precision this
change exists to restore.

### The gate, and what it measured

`scripts/basis-codec-gate.ps1` (NEW, `npm run test:basis-codec -- -Dir <dir>`).
It needs **no editor, no Tauri build and no GPU**: it drives the vendored
`basisu` directly, encodes each source both ways, transcodes both back with
basisu's own `-unpack`, and compares per pixel against the source. That loop
runs in seconds, which is why the flag choice could be validated before the app
was ever rebuilt.

**The map from the damage report, found by scanning all 23 sponza2 ORM sources
for metalness content — `Material_15 orm.png`, B mean 0.0725, 31.4% of texels
above 0.06. That is the map §12.75's dossier describes (`mean 0.072, max 1.0,
31%>0.06`), identified by number rather than by memory.** Transcoded to BC7,
which is what an NVIDIA GPU actually receives:

| codec | MAE R (AO) | MAE G (rough) | **MAE B (metal)** | metal mean | **texels > 0.06** |
|---|---|---|---|---|---|
| source | — | — | — | 0.0736 | **31.66%** |
| OLD (ETC1S `-linear -q 180`) | 0.0088 | 0.0268 | **0.0361** | 0.0703 | **28.25%** |
| NEW (UASTC level 2) | 0.0023 | 0.0056 | **0.0052** | 0.0745 | **32.27%** |

**ETC1S's error on the metalness channel is 0.0361 against a channel mean of
0.0736 — 49% relative — and it deleted 11% of the metal texel population
outright.** UASTC reads 0.0052 (7% relative) and holds the population to +1.9%.
That is the dead-embroidery-reflections bug, measured, on the exact asset.
Across the first six sponza2 maps the data-map improvement is **3.5× to 15.4×**.

### The `-linear`-on-albedo defect is REAL and it lives in the MIP CHAIN

Same protocol on `Material_15 diffuse.png`, comparing `-linear` against correct
sRGB filtering:

| | R | G | B | linear-light luminance |
|---|---|---|---|---|
| source (1024²) | 0.1407 | 0.3043 | 0.4829 | 0.0815 |
| OLD `-linear`, mip 0 | 0.1393 | 0.3035 | 0.4803 | 0.08051 |
| NEW sRGB, mip 0 | 0.1393 | 0.3041 | 0.4808 | 0.08037 |
| **OLD `-linear`, mip 3** | **0.1379** | 0.3002 | 0.4849 | **0.07406** |
| **NEW sRGB, mip 3** | **0.1628** | 0.3114 | 0.4701 | **0.07958** |

**Mip 0 is indistinguishable; mip 3 is 6.9% darker and its RED channel is 15.3%
lower** under `-linear`, while blue rises 3.1%. Averaging sRGB code values
directly instead of in linear light is darker by construction (mid-grey of 0 and
255 is 128, not 188), and the error is largest where contrast is highest —
which is per-channel, hence a hue shift, not just a dim. Across the gate's
sample the mip-3 luminance drift ran **3.2% to 10.9%**.

**A Sponza interior samples mips 2-5 over almost its whole screen area.** So the
compressed albedo was being minified into something darker and cooler than the
source, warm content losing the most — which is a specific, mechanical candidate
for the user's OPEN *"mostly gone… a bit more saturated before, still"*. Not
proven to be the whole residual; it is now the first thing to re-measure.

⚠ **A METRIC CAVEAT THE GATE ENCODES DELIBERATELY.** On colour maps the NEW arm
scores slightly WORSE on mip-0 MAE (0.8×) — because MAE is a linear per-channel
absolute error and `-linear` optimises the codec against exactly that, while
sRGB metrics optimise perceived error. **The MAE metric structurally favours the
broken arm on colour maps.** That is why the gate judges data maps by MAE and
colour maps by mip-chain drift, and why a single "which number is lower" summary
across both would have concluded the old flags were fine.

### What it is worth, and what is NOT yet done

sponza2 is 69 maps at 1024²: ~5.6 MB each as RGBA8 with mips ≈ **386 MB**, going
to ~0.7 MB (ETC1S→BC1) for the 23 colour maps and ~1.4 MB (UASTC→BC7) for the 46
data maps ≈ **80 MB**. Roughly **4.8×**, and it stays compressed in VRAM rather
than only on disk, which is the part that buys raster bandwidth back.

**NOT DONE — and it needs the user:** the 69 metas still carry
`basis.enabled:false`, and re-enabling them needs the editor rebuilt onto the new
Rust command (an `.meta` written by the OLD binary would record `mode` while
having been encoded ETC1S). Sequence: rebuild → `npm run test:basis-codec` on
the target folder → re-enable → confirm textureMemMB falls and the embroidery
reflections return. The orientation mystery ([[new-sponza-perf]]) is still open
and this gate is the instrument for it: transcode and compare ROW ORDER against
the source rather than flipping `flipY` at the live scene.

## 12.78.2 THE RE-ENABLE WAS A SILENT NO-OP — THE OPT-OUT AND THE DAMAGE CONTROL ARE THE SAME BIT (2026-08-15)

User rebuilt, re-enabled compression, and reported texture memory moving **1.02 GB
→ 969 MB — about 5%, where ~4.8× was predicted.** "Maybe it didn't work?"

It hadn't run. Three pieces of disk evidence, before any theory:

1. **All 69 sponza2 metas still read `"enabled": false`.** Zero at true.
2. **Every `.basis` was dated 2026-08-14 23:38** — the previous night's ETC1S pass.
3. **`Material_15 orm.png.meta` recorded `compressed: 175005`, byte-identical to
   the OLD-flags encode produced by the gate in §12.78.1**, and **no meta
   anywhere carried a `mode` field** — so the new JS had never touched them.

**ROOT CAUSE: `compressAllProjectTexturesImpl` skips any texture whose meta says
`basis.enabled === false`** — and the ETC1S mitigation had set exactly those 69
to false. The bulk pass therefore skipped precisely the set that needed fixing,
returned `{compressed: 0}`, and said nothing. **An opt-out written as damage
control is indistinguishable, in the data, from a deliberate one**, so the fix
for a bad codec is structurally unable to reach the assets that codec damaged.

**FIXED:** `compressAllProjectTextures({force})` re-encodes opted-out textures
and re-enables them; `skipped` is now RETURNED and logged (`[basis] N texture(s)
skipped — they carry basis.enabled:false`) instead of being silent; the
`asset.compressAllTextures` op gained a `force` param documenting why it exists.
A bulk operation that does nothing must say so.

### Verifying the Rust rebuild without trusting "I restarted the dev server"

`npm run dev` restarts Vite; the Tauri binary is a separate build, and "restarted
the dev server" cannot distinguish them. **The output SIZE is an exact
discriminator** and needs one call: on `Material_15 orm.png`, old ETC1S = 175,005
bytes, new UASTC = 963,610 bytes (both measured in §12.78.1). One
`asset.compress` returned **963,610** ⇒ new JS *and* new Rust both live. Cheaper
and more certain than reading a version banner.

### The re-encode ledger

Driven through `asset.compress` per file — that path never consulted the opt-out,
so it needed no HMR-fresh code. All 69, zero failures:

| mode | files | |
|---|---|---|
| `srgb` (ETC1S) | 25 | diffuse — ~170-300 kB each |
| `normal` (UASTC) | 24 | ~450 kB-1.35 MB |
| `linear` (UASTC) | 20 | ORM — ~360 kB-1.2 MB |

On-disk derivatives **133.0 MB → 45.6 MB**, and an audit confirms **all 69 kept
`flipY: false` and their `colorSpace`** — the §12.75 clobber guard holding under
a 69-file rewrite, which is the first time it has been exercised at scale.

⚠ **`textureMemMB` DOES NOT MOVE UNTIL A RELOAD, and that is not a failure.**
Immediately after the re-encode it still read 969.7 MB: the derivatives are on
disk but the GPU still holds textures uploaded from the PNGs, and
`invalidateBlobUrl` clears a cache, not a live upload. **The measurement must be
taken after a scene/editor reload**, or the honest conclusion is "no data yet"
rather than "no effect" — the same class of mistake as the 17 fps overlay sample
in §12.78.1. Confirmation of the VRAM figure is therefore still PENDING.

### CONFIRMED AFTER RELOAD — and the ratio needs an honest denominator

| | before | after |
|---|---|---|
| textureMemMB | 1020 | **543.2** |
| GPU ms | 23.14 | **20.37** |
| fps | 39 | **44** |

**−2.77 ms off the frame (−12%) for zero quality cost** — the first confirmed
non-GI cut of the §12.77 programme, and it lands squarely on the raster block
that section priced at ~12 ms.

**The user's correction is right and worth writing down: 1020 → 543 is 1.88×, not
the 4.8× predicted.** The prediction was not wrong; the DENOMINATOR was. 4.8× was
computed for *sponza2's 69 maps in isolation*, while `textureMemMB` counts every
resident GPU texture — and most of what remains is not compressible source art:

* **Render targets.** At 1588×898 the GI chain alone holds gbuffer position +
  normal, irradiance raw/filtered/history, radiance, the shadow channels and an
  873×494 emitter-shadow set, mostly rgba16f; the post chain adds 4× MSAA colour
  and depth, full-res SSR plus 5 blur levels, GTAO and bloom mips. That is
  comfortably 300-400 MB, and **no codec touches any of it.**
* **103 other project textures** still on the old flags (171 total; the 68
  opt-outs were all sponza2). The Old Church interior set alone carries 27.8,
  20.2, 19.6 and 14.7 MB source PNGs — one 4096² RGBA8 with mips is ~89 MB of
  VRAM by itself.

Backing the arithmetic out: a 477 MB drop from a set that compressed ~4× implies
those maps held ~636 MB and now hold ~159 MB, leaving ~384 MB of targets and
untouched textures. Self-consistent, and it means **the achievable ratio on the
overall counter is bounded well below the per-asset ratio.** Quote the per-asset
figure and the frame time; do not quote `textureMemMB` ratios as codec
performance.

⚠ The remaining 103 are already `enabled: true`, so a plain
`asset.compressAllTextures` (no `force`) now re-encodes them correctly — left for
the user, since it rewrites assets outside the scene under test.

## 12.80 ULTRA JOINS THE SHADOW-SCALE LADDER — AND A REBUILD DROPS THE GI SUN (2026-08-15, SHIPPED + ONE OPEN BUG)

(§12.79/§12.79b — the analytic-penumbra diet and the `#lightShadowScale` ladder
this section extends — shipped earlier today from a parallel session; their
ledger is in [[gi-frame-budget]] pending that session's write-up here.)

**The user's directive: gi shadows should cost no more than shadow maps, so they
can replace them outright** (they already return ~256 MB of texture memory — the
four 4096² maps). The live ultra frame said the blocker out loud:
`lightShadowPass` **16.38 ms of a 31.6 ms frame (52%)** at 1588×898, because
§12.79b deliberately left `ultra: 1` in the scale ladder ("the tier that does
not get capped"). That contract predates the measurement; it is the same
"presets don't move the expensive thing" defect §12.77/§12.79b fixed everywhere
else, surviving on the one tier the user actually runs.

**SHIPPED: `ultra: 1 → 0.5`** (GISystem.js `#lightShadowScale`). Ultra's shadow
channel now matches HIGH's absolute pixel count (high = 0.7071²-scaled resolve ×
0.7071² again ≈ 0.25× drawing buffer = ultra's 1 × 0.5²). `__giShadowScale = 1`
is the one-boot A/B back.

**Gate (run-gi-poolsize.mjs, 2 fresh boots of the real project, ultra, identical
806×392 resolve):**

| arm | shadowPx | lightShadowPass | shadow chain | frameMean | blackFrac | rays |
|---|---|---|---|---|---|---|
| `__giShadowScale=1` | 806×392 | 5.686 | 6.507 | 0.2046 | 0.0557 | 28056 |
| default (0.5) | 403×196 | **1.858 (−67%)** | **2.115** | 0.2048 (+0.1%) | 0.0539 | 28102 |

Screenshots indistinguishable; per-pixel cost ~18-19 ns on both arms (the pass
scales clean with pixels — no per-invocation floor worth chasing yet).

**Live editor (user's Sponza, ultra 1588×898, gi-mode sun):** lightShadowPass
16.38 → 6.91 ms, whole shadow chain 19.08 → 8.54 ms, **frame 31.6 → 24.2 ms**.
GPU healthy P0 84 W of 87 (Performance mode — NOT the Silent cap; checked first
per [[dual-gpu-webview2-pin]]).

**Shadow-map parity arithmetic, measured on the same scene minutes apart:** with
the sun back on 2048² Basic maps the frame read 20.05 ms; on gi shadows 24.19 —
**gi shadows currently cost ~4.1 ms more than a 2048 map on this scene.** The
named next levers, in order of confidence: (1) checkerboard trace + temporal
fill — the filter already integrates frame-jittered IGN samples, so tracing half
the pixels per frame is the mechanism the chain was built for (~3.5 → ~1.8 ms,
but the 20-second day-cycle sun stresses history reuse — gate on §12.67's
settle); (2) N·L/sky early-outs in the trace kernel (back-facing receivers
already skip via the terminator gate — audit what fraction remains); (3) further
scale (0.35) — cheapest to test, softest result. Parity also buys the win twice:
a gi sun needs no shadow-map render pass AND no 64-256 MB of map textures.

### The 60 fps ledger (2026-08-15 night — user's target restated: 60+ at ultra)

16.6 ms budget against a 24.2 ms frame; GI owns ~18.7 (shadow chain 8.54 + SRC
8.77 + resolve/temporal 1.4), raster+rest ~5.5. The ~7.6 ms must come out of GI:

| lever | Δms (live 1588×898) | status |
|---|---|---|
| SRC pool defaults (bin 700k + c0 16k, §12.77.1) | **−2.6** | measured, ships behind grow-on-pressure; orphan question NARROWED (below) |
| checkerboard shadow trace + temporal fill | **~−3.4** | mechanism in place (IGN jitter + filter/history/reprojection); gate on moving-sun flicker rig |
| shadow scale 0.5 → 0.35 | **−3.1** | priced this session (1.858 → 1.095 ms harness, luminance flat) — overlaps checkerboard; softer penumbra; NEEDS same-boot visual A/B (the 0.35 arm booted into a different day-cycle phase, screenshots incomparable) |
| N·L / sky early-outs | ~0 | already exist (terminator gate + gbuffer gate) — struck from the list |
| renderScale 0.75 | ~−5 | instant, whole-frame, the pragmatic fallback |

Arithmetic: pools + checkerboard ≈ 18.2 ms (55 fps); adding EITHER scale 0.42-ish
OR ~1 ms of small cuts reaches 16.6. Pools + 0.35-now ≈ 18.5 ms tonight. ⚠ The
GPU sits at its 87 W cap (P0, Performance mode) — ms figures breathe ±10% with
thermals; native-res ultra dynamic GI at 60 fps on an 87 W laptop 4070 has no
slack for regressions.

### §12.80.1 UNIT A SHIPPED — POOL FLOORS + GROW-ON-PRESSURE (2026-08-15 night, VERIFIED)

The pools no longer allocate to the pixel proxy up front. `SRC_POOL_FLOORS`
(srcSystem.js: c0Probes 16384, binBudget 700k — the §12.77.1 treatment values)
are the boot state; `expectedC0Probes(pixelCount)` and `BIN_BUDGET` became the
growth CEILINGS (`srcPoolCeilings`). GISystem's `#syncSrcPoolPressure` reads the
demand counters on a ~1.5 s cadence (8 s post-build settle, 10 s post-grow
cooldown), doubles a starved pool toward its ceiling, and rebuilds srcProbes
through the SAME `#syncScreenResolveSize → setSize(w, h, pools)` path a resize
takes (`state.screen.width = 0` defeats the tolerance check; setSize now
compares pools, grow-only). Grown sizes live on `this._srcPools` and survive
quality changes and resizes. Suspended while `__giSrcC0Probes`/`__giSrcBinBudget`
are set (deterministic A/B arms); `__giSrcPoolInit` = growth-permitted initial
sizes for exercising the path.

**⚠ THE FIRST VERIFICATION RUN CAUGHT A REAL SIGNAL BUG — the birth-time
`COUNTER_NOBLOCK` alone is NOT the bin signal.** Birth claims go quiet once the
population stabilizes while every standing blockless probe fails its DEPOSIT
each frame: the growth arm sat at bins 175k with birth noBlock 0, deposit
noBlock 38,268/frame, and a visibly darkened image (frameMean 0.156 vs 0.204,
blackFrac 0.23 — the §12.52.2 wash, reproduced on demand). `readPressure` now
reads BOTH counters (two small readbacks); either grows the bin pool.

**Verified (2 fresh ultra boots each, second round):** control (floors) grew
bins once 700k→1.4M on deposit noBlock 471 — the scene under test had gained 4
emitters from live editing — ending failed 0 / noBlock 0 / frameMean 0.2101;
growth arm (c0 2048, bins 175k) logged two grows and converged to failed 0 /
noBlock 0 / **frameMean 0.2094 — 0.3% from control**. Slot pool stays at the
floor on Sponza (the 48× over-allocation is gone). Live editor after apply:
**24.2 → 22.3 ms GPU, 41 fps**, textureMem −33 MB. Note the two runs ended at
different bin sizes (700k vs 1.4M) — demand near the 700k boundary is
borderline and the guard is deliberately trigger-happy (growing one step early
costs ~1 ms; not growing costs the image). A deposit-noBlock threshold (e.g.
>0.1% of deposits) is a refinement if the extra step ever matters.

**Orphan question, narrowed from the §12.77.1 data (now moot for the ship, kept
for the record):**
orphanRate 0.068 is IDENTICAL on both treatment arms, which share
`__giSrcBinBudget=700000` and differ on the slot knob — so the improvement keys
to the BIN cut, not the slot cut. Candidate mechanism: a smaller bin pool evicts
far/stale blocks sooner, so the surviving bin population is nearer/fresher and
more of it has parent probes — an eviction-freshness effect, favourable and
mundane. Confirm with a bin-only sweep reading the orphan numerator/denominator
separately (the L2-knee sweep §12.77.1 already wants doubles as the vehicle).

### §12.80.2 UNIT B SHIPPED — CHECKERBOARD SHADOW TRACE (2026-08-16, GATED, ONE OPEN GATE)

`createGiLightShadowPass` now traces HALF the pixels per dispatch (giScreen.js):
each thread maps to one checkerboard cell (compact indexing off a `checker`
parity uniform, dispatch count halved at build) and the untraced half keeps
last frame's texel — the raw/dist targets are persistent, so skipping the store
IS the fill, and the filter integrates the two phases. **The dispatch halves,
NOT the lanes**: an in-kernel parity skip leaves every warp half-active through
the BVH descent and saves ~nothing. The parity uniform advances every frame in
the tick, independent of the jitter phase (which freezes under
`__giShadowTemporal=false` and never exists on the analytic arm — a frozen
parity = half the buffer permanently stale). Wired at BOTH creation sites
including the resize splice (the frozen-dither bug's MUST-match rule).
`__giShadowCheckerboard=false` restores full dispatch.

**Gate (2 fresh ultra boots, 403×196 shadow):** lightShadowPass 1.955 → 1.417 ms
(−28% — under the ideal 2× because traced cells 2 px apart cost warp coherence),
frameMean 0.2107 vs 0.2114 (+0.3%), screenshot clean, no pattern. Live ultra
projection: ~6.9 → ~5.0 ms, frame ~22.3 → ~20.4 ms. ⚠ **OPEN GATE: moving-sun
flicker is untested** — scripts don't run in the harness editor mode, so the
day-cycle stress on the one-frame-stale half needs either the mover rig or a
live session with the sun animating before this is called fully verified; the
analytic arm's deterministic trace makes the risk low (only real motion
differentiates the phases), but low is not measured.

### ✅ RESOLVED §12.81 — FROZEN PLAY-MODE MOVER SHADOWS = THE 16-MOVER CAP (2026-08-16)

The full mechanism, established live on the user's editor with the game camera
(⚠ instrument trap first: in play mode, `viewport.screenshot` with the default
`camera: "editor"` composites the editor view OVER the game camera's frame — a
translucent double exposure that reads as "no shadows anywhere / washed out".
Two hours of this session chased that ghost. In play, screenshot with
`camera: "game"`, always):

1. The Physics Playground is `enabledInEditor: false, enabledInGame: true` —
   the ~30 crates DO NOT EXIST in edit mode. Every edit-mode field build is 26
   Sponza meshes; the crates enter the GI world only via the play-entry
   fingerprint rescan → full field rebuild (~5.5 s compile wave), which bakes
   their static-BVH triangles at the ENTRY (pyramid) pose.
2. First motion then adopts exactly `maxObjects = 16` of them
   (`adoptedMovers: 16` measured in play — adoption WORKS; the earlier
   `adoptedMovers: 0` reading was taken in EDIT mode where the crates aren't
   placements at all, which is also why "adoption worked earlier reading 16"
   confused two different worlds). The other ~14 keep pyramid-pose triangles
   in the static BVH: tumbling crates, baked pyramid shadow. The debounced
   rebuild can never fire while they keep moving (motion re-arms it), so the
   ghost persists exactly as long as the pile keeps settling.

SHIPPED (needs editor reload to take effect — the WebView does not HMR
GISystem):
- **Tiered mover cap** — `{low/medium: 16, high: 24, ultra: 32}`
  (`__giMaxDynamicObjects` still overrides; hard ceiling stays 64 for the
  f32-exact card ids). The marcher loops over the LIVE header count, so an
  uncontended scene pays nothing for the headroom. 30-crate pile at ultra now
  adopts whole.
- **Motion masks static-BVH triangles** — the `#refreshOccupancyTransforms`
  moving branch now calls `setStaticMaskBit(p.slot, true)` beside its
  `_staticBvhStale` arm: any voxel-split mover (over-cap or pinned "static")
  loses its build-pose shadow WHILE moving instead of dragging it around; the
  rest-debounced rebuild rebuilds at current poses and `resetStaticMask([])`
  clears every motion mask. No shadow while moving beats a shadow that stopped
  following.

STILL OPEN, same area: `#maybeRebuildStaticBvh` is a SYNCHRONOUS main-thread
stall (measured 554-657 ms on this Sponza, fires ~3 s after a settle — in play
that is a visible hitch right after the action ends). The build is pure typed-
array math (`buildStaticSceneBvhWords`) — worker candidate, spec it before the
next play-heavy milestone. And play-entry/exit each pay a full field rebuild +
compile wave (~5-6 s) because the playground flips the fingerprint; a
placement-level add/remove that reuses the compiled kernels would kill the
worst editor-feel hitch that remains.

### ✅ COULD NOT REPRODUCE (2026-08-16, clean boot) — map→gi SWITCH AND REBUILD-FORGETS-SUN

On today's fresh editor boot (all modules from disk, no hot-swap drift), every
arm of yesterday's lifecycle failure worked first try, in BOTH modes:
- map → gi in play: claim logged, GI shadows on screen (game camera verified).
- map → gi in edit: GI shadows appear within ~2 s (first-use pipeline compile).
- gi through TWO full rebuilds (ultra→high→ultra quality bounces): the claim
  re-established both times — boot line says `1 lights (GPU)`, light-shadow
  chain compiled, shadows in the screenshot.
- gi → map: three's map shadows return.

Yesterday's "no shadow until full GI reload" and "rebuild forgets the sun"
were observed in a 5-session editor whose GISystem had been live-edited under
it repeatedly (vite pushed new srcSystem/giScreen while the running GISystem
instance stayed old) — the mixed-module state is the prime suspect, and it is
not a state a user reaches from a normal boot. KEEP THE SYMPTOM IN MIND but do
not chase it on current code without a fresh-boot repro. If the user still
sees it after reloading with today's build, the repro recipe that matters is:
exact sequence from boot, `console_read` for the claim line, and
`profile.giPasses` `lightShadowPass` dispatch state.

### 🔎 §12.82 — THE "18-40 FPS ON A STATIC SCENE" OSCILLATION IS THE GPU CLOCK (2026-08-16)

`nvidia-smi dmon -s pucm -c 10` during an idle editor view, static scene, no
edits, GPU utilization pinned ~100%:

    pclk (MHz): 2400 → 1140 → 990 → 1290 → 1650 → 2085 → 2385 → 2310 → 2400 → 1185
    power (W):    26 →   27 →  27 →   31 →   45 →   65 →   79 →   79 →   55 →   29

The core clock duty-cycles 990↔2400 MHz with a ~8-10 s period UNDER CONSTANT
LOAD — a 2.4× per-second performance swing from the laptop's power profile,
not from anything the engine does. Consecutive `profile.frameStats` samples on
the identical static frame read GPU 20.9 / 26.7 / 26.1 / 22.7 ms — each sample
is just a different phase of the clock wave, and the presented fps then snaps
between vsync divisions (47 → 39 → 33 → 19), which is exactly the user's
"constantly dropping and rising". Engine-side contributors that DID exist
(the 1.5 s pool-pressure readback → §12.80.1 backoff; light-track window arms
on real light events) are shipped/behaved today. CONSEQUENCES:
- ⚠ EVERY single-sample ms on this machine is ±25% until the power profile
  is pinned (ASUS profile to Turbo/Performance + Windows power mode Best
  performance, plugged in; verify with dmon showing steady ~2.3-2.4 GHz under
  load). This extends [[dual-gpu-webview2-pin]]: P-state and instantaneous
  power alone are NOT enough — P0 at 39 W of a 79 W cap still wobbled; only
  dmon over ~10 s tells the truth.
- The two ~1 s windows where GPU util fell to 24% mid-wave are CPU-side
  stalls: the JS heap sat at 2.5-2.6 GB and grew ~20 MB/s ON AN IDLE SCENE
  (allocation churn → major GC pauses). Separate engine bug worth its own
  session: find the per-frame allocator (heap snapshot diff over 30 idle
  seconds), because a 2.6 GB heap turns every major GC into a dropped-frame
  cluster regardless of GPU headroom.
- Steady-state at full boost today: ~20-21 ms (both shadow modes, post off,
  1588×898 drawing buffer) — i.e. the gi-vs-map parity §12.80 measured stands,
  and the remaining 60 fps work is real engine work (§12.80's ledger: gather
  half-rate bilateral −5.6 ms, SSR half-res + denoise, GTAO half-res), on top
  of a machine whose clock must first be pinned to make any of it measurable.

---

## ✅ RESOLVED §12.83 — GI SUN SHADOWS DIED ON EVERY SCENE CHANGE: THE STATIC BVH'S `triBase` WAS A COMPILE-TIME LITERAL (2026-08-16)

**User report, three times over three sessions, each time read as a different
bug:** "gi shadows break after exiting playmode" · "gi shadows get broken with
emissive objects in the scene (editor mode)" · "it often happens that gi shadows
disappear when scene changes". The decisive evidence was the user's own two
screenshots from ONE camera: 48 fps / GPU 11.4 ms with crisp sun shadows, then
seconds later 40 fps / GPU 18.0 ms with **no shadows at all** — identical 111
draws and 800,751 triangles in both. Same geometry, same emissives, same camera.
That refuted every energy/exposure theory: whatever changed was *state*, not light.

### The mechanism

The sun's GI shadow marcher is `static-bvh8` — it traverses the world-space
static shadow BVH that rides the `bits` buffer. Two absolute word offsets locate
it: `nodeBase` (the region offset) and `triBase = nodeBase + packed.nodeWords`.
They reached the shader through `dynamicObjects.js`:

```js
return bvh8MaskedTraceWgsl(
  vec3(origin), vec3(dir), float(tMin), float(tMax),
  uint(info.nodeBase), uint(info.triBase),   // ← CONSTANT NODES
  ...
);
```

`uint(number)` is a **constant node**: three bakes it into the WGSL as a literal
when the shadow kernel is compiled — once, during the GI build. But
`#maybeRebuildStaticBvh` re-packs the BVH at runtime (debounced 180 frames ≈ 3 s)
and calls `attachStaticBvh({nodeBase, triBase})`, which only mutated a JS object.
**Nothing recompiled.** The new words landed in the region; the kernel kept the
old literals.

`nodeBase` is the region offset and never moves, which is why this hid for so
long — the traversal walked the *new* node array correctly. `triBase` is
`nodeBase + nodeWords`, and `nodeWords` is the BVH's node count, which moves
whenever the tree shape changes. So after such a rebuild every leaf test fetched
its 9 triangle words from the wrong offset, read whatever lived there, missed —
and **every sun shadow in the scene vanished, permanently**, until something
forced a full GI rebuild (which recompiles the kernels).

**Why it was intermittent**: a rebuild whose node count happened to land
unchanged left `triBase` valid and looked perfectly fine. "Often", not always.

**Why all three reports are one bug**: `_staticBvhStale` is armed by a changed
placement set (`#refreshOccupancyContent`), by a demoted/evicted mover, and by a
"static"-mobility mesh that moved. Exiting play mode churns movers; emissive
projectiles churn the placement set; a scene edit churns both. Every one of them
lands on the same debounced rebuild ~3 s later — which is exactly the "a few
seconds later" in the user's A/B.

Observed on a clean boot of the banner Sponza with no projectiles at all:

```
13.761  static shadow bvh: 260877 tris, 11.5MB, built in 689ms
13.982  bvh: exact reflections ON — 30 meshes, 266109 tris
24.576  bvh: exact reflections ON — 26 meshes, 262269 tris    ← 4 meshes leave
27.674  static shadow bvh: rebuild #1 — 257037 tris in 542ms  ← 14 s after load
```

### The fix (three parts, all shipped)

1. **The bases are runtime uniforms, not literals** (`dynamicObjects.js`).
   `staticNodeBaseUniform` / `staticTriBaseUniform` are created once per set;
   `attachStaticBvh` writes them, so every already-compiled kernel follows. Two
   uniform reads against a 44-deep stack walk — free. `set.staticBvh` still gates
   *compilation* (no BVH ⇒ the arm is not emitted), which is unchanged.

2. **The swap is atomic** (`GISystem.js`). `queueRegionUpload` builds a fresh
   compute — a fresh pipeline, so async compilation can skip it for a frame or
   more. Flipping the bases at pack time therefore pointed the traversal at a
   region that still held the previous build. `#maybeRebuildStaticBvh` now only
   *stages* `_staticBvhPendingAttach`; `#commitStaticBvhAttach` publishes the
   bases the frame the upload actually dispatches, called right after
   `confirmDispatch` and **before** that frame's screen passes read it. Until
   then the previous BVH stays attached and keeps casting shadows. One rebuild
   in flight at a time. A full `#rebuild` clears any staged attach — region
   offsets are per-field and `_dynSet` is replaced.

3. **The motion mask can no longer leak** (`GISystem.js`). A moving
   "static"-mobility placement is masked out of the shadow BVH
   (`setStaticMaskBit(p.slot, true)`), and `resetStaticMask` inside a *successful*
   rebuild was the ONLY thing that cleared it. Both bail-outs — no packable
   geometry, and the capacity-overflow warning — cleared `_staticBvhStale` and
   returned with the mask still set, so those slots stopped casting any shadow
   for the rest of the session. Both now reset the mask; a shadow at the build
   pose is the lesser artifact, and the pose corrects at the next full rebuild.
   The `!field?.placements` bail re-arms the flag instead of dropping it.

### Traps this leaves behind

- ⚠ **Any offset handed to a GI kernel as `uint(jsNumber)` is frozen at compile
  time.** If the value can change while the kernel lives, it MUST be a uniform.
  The static BVH was the only one that also had a runtime mutator; check any new
  one against its lifetime, not against how it reads.
- ⚠ **`attachStaticBvh` is now live for every compiled kernel.** Never call it
  before the words it describes are on the GPU — the pair is atomic, and a base
  pointing at a stale region is the same garbage read this section is about.
- The rebuild log now prints `triBase <nodeWords> (live)`, and the build log
  prints `triBase <nodeWords>`. **A rebuild whose `triBase` differs from the
  build's is precisely the case that used to kill every shadow** — that one
  number is the whole diagnosis if this ever resurfaces.
- 4 meshes leave the GI mesh set ~10 s after this scene boots (30 → 26 in the
  reflections scan). Unexplained and NOT part of this bug, but it is what arms
  the rebuild on an otherwise idle scene. Worth its own look.

## 13 THE CAMERA-FOLLOWING VOLUME — CITY-SCALE GI (2026-08-16, SCOPED)

### 13.0 The problem, with the numbers that prove it

The probe lattice is capped at `MAX_PROBE_AXIS = 48` per axis, so spacing is a
function of VOLUME EXTENT, and extent today comes from the scene AABB
(auto-fit). Bistro at world scale: 120×42.5×130 m → **2.5 m probes, 1.02 m
record cells**. Measured consequences, all on the healthy post-§12.83 build
(they are NOT churn artifacts — verified same-pose after the merge/GI boot
fixes of BISTRO_PERF D′):

- A ~5 cm colored bulb smears a **~3 m halo** (trilinear over 2.5 m probes),
  and 95 bulbs strung down the street aggregate into a blue-violet wash on
  every facade. The engine's own boot warning predicts exactly this.
- **37,572 dense cells** exceed the per-cell exact-triangle cap and keep
  voxel-box hits at 1.02 m (vs ~3.8 k at 0.1 scale) — the meter-wide soot
  blotches on rooflines (ivy, wires, trim collapsed into solid blocks).
- 486 of 610 meshes are sub-cell: one surface record and one bounce color per
  chair/post/trim — the chunky black silhouettes vs the reference render.
- The user's 0.1-scale workaround is exactly a 10× density purchase
  (2.5 m → 0.25 m probes). It works; it should not be the product answer.

Budget cannot fix this: a 48-axis lattice dense enough for this street would
need ~1000 axis cells to also cover the city. **Density near the camera, not
volume, is the resource.**

### 13.1 The design — and the mechanism that ALREADY EXISTS

`#refitInPlace` already SLIDES the volume on the probe lattice ("refit in
place (slide, nothing resampled)") and STRETCHES it without recompiling.
`#applyBounds` → `volume.setBounds` mutates the world-bounds uniforms,
`atlas.refreshAllSlots()` + `#syncSlots` re-voxelize the pyramid against the
moved box on the next tick, and §12's own comment records that "a refit
recomposites the whole field from the slot SDFs anyway". The §12.83 lesson
already forced every base/offset a kernel reads to be a uniform. So a
camera-following volume is NOT a new field architecture; it is:

1. **Decouple extent from the scene** (F1): when the scene outgrows a
   threshold, the volume clamps to a quality-tiered detail box centered on the
   camera instead of the scene AABB.
2. **Drive the slide from the camera** (F2): hysteresis + snap + throttle on
   the existing slide path.
3. **A far-field answer for pixels outside the box** (F3): today the volume
   covers the scene, so the out-of-bounds composite path is essentially
   UNTESTED — it must become a deliberate fallback, not an accident.

Phase-1 is ONE volume that follows the camera. A second, coarse far-field
volume (true clipmap) is a separate go/no-go AFTER F3 ships — it doubles pool
memory (the pools are the memory: ~150 MB class, not the 3 MB bits), and F3's
fallback may be visually sufficient at street scale.

What this buys on Bistro medium with a 48 m detail box: probes 48/48 = **1.0 m**
(2.5× denser), record cells ~0.4 m (2.5× finer, far fewer boxed cells per
volume of trim) — and at high with a 32 m box, **0.66 m probes**. The bulb halo
shrinks from 3 m to ~1 m at medium, sub-meter at high.

### 13.2 Unit F0 — instrument and inventory (no behavior change)

Before anything moves, answer with rigs, not reading:

- **What does the composite do for a pixel whose surface is OUTSIDE the
  volume?** (Suspect: no indirect at all — black next to lit. Must know the
  exact term.) Rig: shrink bounds via `__giConfigOverride` on Sponza,
  screenshot the in/out seam.
- **What does a 20 m slide cost, end to end?** The recomposite is "free" in
  architecture but not in ms. Add a `[gi] slide: <ms> recomposite, <n> slots`
  log to `#applyBounds` and drive slides from a debug hatch
  (`__giVolumeSlide = [dx, dz]`). Measure on Bistro: slide cost, frames to
  visually settle (the §12.67 light-settle should hide re-accumulation —
  verify it arms on a slide).
- **Inventory every consumer of `state.bounds`/`center`/`probeSpacing`**
  (shadow marcher reach, cascade intervals t0/farT — the stretch path rescales
  them and a slide must NOT — emitter tile cut, light tree, `diagU`, screen
  tile mapping). One table: consumer → re-derives per frame / reads uniform /
  bakes at build. Anything in the third column is a §12.83-class bug waiting.

Gate: the table exists in this doc; slide cost and settle time have numbers on
Bistro; the out-of-bounds term is named.

**F0 MEASURED (2026-08-16, `scripts/run-gi-volume-slide.mjs`, Bistro medium,
one 40 m slide east):**

- **Slide cost: 1.6 ms CPU** (`#applyBounds`, 610 slots re-synced). The
  recomposite rode the next occupancy chain with no visible stall in the rig.
- **Both gates PASS**: no `compile wave started`, no `[gi] built` after the
  slide. The bounds path is genuinely rebuild-free — F2 can build on it as-is.
- **The auto-fit return trip works unprompted**: the content watcher noticed
  the mismatch and slid back ("refit in place (slide, nothing resampled)")
  within the 17.5 s window. F2 must DISABLE or subordinate this watcher while
  the camera drives — two drivers for one box is an oscillator.
- **Out-of-volume shading = CRUSHED BLACK, no fallback.** The screenshot pair
  (`.gi-shots/volume-slide/1-before.png` vs `2-after-slide.png`) shows the
  west building fully lit before and pitch black after — only direct glints
  survive. F3 is mandatory, not cosmetic: without it every slide paints a
  black wake at the trailing edge.
- ⚠ Rig trap for F2's dolly harness: reading the WebGPU canvas via
  `drawImage` OUTSIDE `engine.onPostRender` returns black (mean 0) — the
  luminance probe must ride post-render exactly as run-gi-poolsize.mjs does;
  `page.screenshot` of the composited page works from anywhere.

**F0 INVENTORY (2026-08-16, full sweep of the gi module):**

Bottom line: **a pure translation is structurally clean.** `world.min` (the
srcVolume uniform bundle) and `gridOrigin`/`voxel`/`voxelInv` (occupancyField,
rewritten by `syncVoxel` via `setBounds` → `refit`) are the only
absolute-position values any kernel reads, both are uniforms the slide path
already writes, `staticDirty` forces the re-voxelization, and `#applyBounds`
re-poses the debug gizmos. Every DDA/oracle/deposit/record kernel, the shadow
marcher's reach (`srcTrace.js:231` — a node off `world.size`, moves with no
recompile), the width probe, the AO ladder and the attribution grid all
resolve through those uniforms — classification (b).

The (c) BAKED entries all bite on **STRETCH**, not slide — and F1 IS a
stretch (arming detail mode changes extent), so they are F1 blockers:

- **`GISystem.js:4201` `maxRay` — a LIVE BUG TODAY, independent of §13.** It
  reads `volume.world.size.value.length()` ONCE at `#buildScreenResolve` and
  bakes it as a WGSL literal (via `srcShade.js:249 float(maxRay)`) — the
  sun/directional shadow-ray budget at every off-screen hit. `#refitInPlace`'s
  stretch branch updates `diagU` (`:8881`) and CANNOT reach this literal, so
  any content-growth stretch today already leaves sun-visibility rays at the
  old length. Must become a uniform in F1's first commit.
- `state.buildSize` (`:6716`) is copied once BY DESIGN (the anti-walk baseline
  for the [0.55,1.9] stretch gate) — leave it, but know the gizmo scale
  denominators depend on it.
- The debug gizmo boxes are baked-with-a-compensator — re-posed only by
  `#applyBounds`; any new path that replaces them must go through it.
- Cell counts/pool allocations are extent-sized arrays: fine on slide,
  intentional coarsening on stretch.

Searched and CLEAN (do not chase): the `t0`/`farT` cascade-interval pair is
DEAD CODE-side — the `:8876` comment about restoring it is stale (today's
intervals are pure functions of `spacing0` in srcConfig.js); **the SRC cascade
lattice is ALREADY CAMERA-ANCHORED** (`srcSystem.js:246 anchorU`, 1686-1700) —
a volume slide never touches it, and it is precedent that camera-anchoring
works in this architecture; bvh/bvhScene.js reads no volume state (per-mesh
`worldToLocal` refreshed per frame; ray length is the `diagU` node); the
emitter tile cut is pure screen-space; the light tree packs emitters' own
AABBs and never reads the volume.

### 13.3 Unit F1 — detail extent (internal; quality stays the ONE property)

Auto-fit gains an internal mode: if any scene axis exceeds `DETAIL_TRIGGER`
(~60 m), volume extent = min(scene, tiered detail box — e.g. low 32, medium
48, high/ultra 64 m; y clamps to scene height) centered on the camera's
snapped position at build time. No new component property —
`__giConfigOverride` gets `detailExtent` for harnesses only.

Gates: (a) Cornell/small scenes: detail mode never arms, builds bit-identical
(zero-diff screenshot vs pre-F1); (b) Bistro medium: boot log reports probes
≤1.0 m and the volume centered on the camera; (c) the probe-spacing boot
warning stops firing on Bistro at high.

**F1 SHIPPED 2026-08-16 — ALL GATES PASS, but the extents above were wrong
and the box must clamp Y.** The first rig run (48 m box, medium) measured
probes landing at **2.25 m, not ~1.0** — two structural reasons the plan's
guessed extents could never work:

1. **The binder on medium is `probeAxis: 28`, not the probe total** — the
   budgets are literally probeAxis³ (20³/28³/40³/48³), so the finest spacing
   a box can reach is `extent·1.05/(probeAxis − 2 margin cells)`. 48 m on
   medium bottoms out at ~1.8 → ladder-stepped to 2.25.
2. **Bistro's 32 m facades ALONE pin y**: with the box keeping full content
   height, counts.y = 33.6/s + 2 forces s ≥ 1.3 m on a 28 axis no matter how
   small the horizontal box gets. So `#detailClampAabb` clamps Y too —
   GROUND-ANCHORED (`min.y … min.y + extent`), not camera-anchored: street
   GI lives at street height, upper facades join the F3 far field.

`DETAIL_EXTENT_BY_TIER` is now **derived from each tier's own axis cap**
(≈ (probeAxis·1.0 − 2)/1.05, rounded down): `{low: 20, medium: 24, high:
36, ultra: 42}` — every tier lands ~1.0-1.2 m WITHIN its existing budgets,
zero pool growth (§13.8). Rig rerun (`detailExtent: true`, medium):
**28.0×28.0×28.0 m, c0 28×28×28 = exactly the 21,952 budget, probes 1.00 m
(2.5× finer), voxel 0.32 (was 0.58)**, anchored 7.0,5.0,9.0 from the camera
pose. Gate (a) small-scene zero-diff is structural (the clamp early-outs
when span ≤ extent — the hatch is also OFF by default); (c) at high is
untested until a high-tier run. ⚠ the first rig attempt reported "FATAL:
never built" with zero [gi] lines — environmental (dev-server mid-restart
at session end), not a code failure; the rig now dumps its last 20 [gi]
lines on FATAL so the next one is diagnosable.

### 13.4 Unit F2 — the camera drives the slide

Reuse `#refitInPlace`'s slide with: snap to the probe lattice (already there),
an inner hysteresis band (slide only when the camera leaves the central
third), a throttle (≥500 ms between slides; a slide requested while one
settles queues, never stacks), and the light-settle window armed on every
slide so re-accumulation ramps instead of pops. Editor camera drives it in
edit mode, game camera in play (the `camera:"game"` screenshot trap applies to
every rig here).

Gates: (a) dolly rig (`scripts/run-gi-volume-follow.mjs`): camera dollies the
Bistro street at 2 m/s for 60 m — no flash, no trailing darkness (mean
luminance of a tracked wall patch stays within ±10% through the pass — a mean,
not an extremum, per the harness-traps memory); (b) stationary camera: ZERO
slides over 5 min (hysteresis holds against orbit jitter); (c) steady-state
frame cost unchanged within noise when not sliding.

**F2 IMPLEMENTED 2026-08-16** — `#detailFollowTick(now)`, called every
`#tick` (two null-checks deep when disarmed):

- **Hysteresis** = the central third: slide only when `|cam − anchor|` on x
  or z exceeds `extent/6` (4 m on medium's 24 m box). **Throttle**
  `DETAIL_SLIDE_MIN_INTERVAL_MS = 500` needs no queue — the band condition
  persists, so a request landing inside the interval re-fires on a later
  tick (queued, never stacked, exactly the spec's wording).
- **The anchor is the only thing F2 moves.** It jumps to the camera
  (clamped into the content AABB — flying off the map cannot drag the box
  into empty space), then the move routes through the SAME `#fitBoundsFor`
  funnel the build and the watcher use, then `#refitInPlace(fit)` does the
  lattice-snapped translate. The watcher agrees by construction — same
  funnel, same anchor — so it can never fight the follow.
- **Every slide arms the §12.67 light-settle window directly**
  (`_giMotionHeld = max(held, 0.5)`, `_giMotionHoldUntil = now +
  ALPHA_TRACK_HOLD_MS`) — half strength: the uncovered strip has no history
  and needs the floored α + lifted cap; ~2/3 of the field slid over VALID
  history that full panic would needlessly decay. Walking re-arms it
  continuously (correct — the leading edge needs fast fill); standing still
  closes it in ALPHA_TRACK_HOLD_MS.
- **The follow path never rebuilds.** If `#refitInPlace` refuses (only
  possible when the box was BUILT truncated against a content edge and
  walking toward the middle wants it grown past the [0.55,1.9] stretch
  window), the anchor is restored and the watcher's debounced cadence
  arbitrates. `[gi] follow: refit refused` in a log is that edge case, not
  a crash.
- Y never follows — ground-anchored at the content floor (F1's clamp).
  Towers/verticality are an F3+ question.
- Rig note: the dolly is flown AERIALLY on the diagonal (slides key on
  horizontal position only; an aerial path cannot blindly clip through
  facades), and the luminance instrument is `viewport.screenshot` decoded
  IN PAGE — the WebGPU-canvas drawImage trap does not apply to a
  render-target readback. The ±10% tracked-wall-patch gate needs a fixed
  world patch; the smoke rig gates on a flash/darkness envelope
  (min ≥ 0.5× median, max ≤ 2× median) and prints the series for judgment.

**F2 SHIPPED 2026-08-16 — run 3 (post-fix, dolly-window wave gate) passes
ALL FIVE GATES: parked 0 slides, 10/10 pure slides at ~1 ms CPU, zero
rebuilds/waves/refusals in the dolly window, luminance median 120.5 range
[108, 126] (the dip is bit-repeatable shaded content). The 5-min SOAK=1
park is the outstanding formality. History of the two runs before it:**

Run 1 (truncating clamp): parked 0 slides ✓, 10 dolly slides at ~1 ms CPU
✓, luminance stable (median 120.2, range 106-125 — the mid-pass dip to
~107 is honest shaded content, bit-repeatable across runs) ✓ — but THREE
of ten refits took the STRETCH tier (box flapping 28.0 ↔ 23.1×28.6×28.6 ↔
28.6³, live spacing drifting to a non-ladder 1.02). Root cause: the clamp
box TRUNCATED against content edges, so its span and center moved by
arbitrary non-lattice amounts as the anchor walked, and `#fitBoundsFor`'s
floor/ceil snap flapped between 28/29 cells → rung bump 1.0→1.1 → fit
BIGGER than the live box → stretch (probes resample mid-walk — the exact
thing a follow must never do).

THE INVARIANCE RECIPE (the fix, two halves — both required):
1. `#detailClampAabb` builds a CONSTANT-SIZE box that clamps its POSITION
   into the content (`clamp(anchor−half, min, max−extent)`), never an
   intersection. An axis with content smaller than the extent keeps the
   content bounds (also constant).
2. `#detailFollowTick` moves the anchor only in WHOLE live-spacing steps,
   preserving the fractional offset the volume was BUILT with, and does
   NOT clamp the anchor to content (the box clamps itself; an off-map
   camera pins the box at the edge — detected via unmoved bounds, which
   skips the settle-arm and backs the retry off ×9).
   With both, `laid()`'s center translates by exact lattice multiples →
   cell counts are translation-invariant → same rung forever → every
   follow refit is the slide tier. Run 2: ten of ten "slide, nothing
   resampled", box 28.0³/probes 1.00 throughout, anchor stepping whole
   metres.

Run 2's one remaining FAIL was the RIG's: it counted "compile wave
started" over the whole session, and the one wave was the BOOT material
warm (prints before `[gi] built`; its "warmed in 15832ms" completion
drained through the park on the cold cache). Gate now counts only waves
starting inside the dolly window. Two boot-path lines worth knowing, both
pre-existing: "first frame after compile wave took 2331ms — likely the
postprocess render path" (the §12.56-family PP-warm item), and the wave
completion landing long after `built` when the transcode tail is cold.

### 13.5 Unit F3 — the far field must not be an accident

Out-of-volume surfaces get a deliberate fallback indirect term: start with a
hemispherical constant fed by the field's own average irradiance (cheap, no
new pools), feathered across the last 2 probe cells inside the boundary.
Direct sun + gi-traced shadows are volume-independent (static BVH) and keep
working at any distance — verify, don't assume: the marcher's reach reads
`diagU`.

Gates: (a) far buildings in the dolly rig are lit plausibly (not black, not
glowing); (b) a sweep screenshot across the boundary shows no band at the
feather (luminance step below what the §12.70 tile-seam gate accepted); (c)
disabling the fallback via hatch reproduces the F0 baseline exactly (proves
the term is isolated).

**F3 SHIPPED 2026-08-16 — ALL FIVE RIG GATES PASS**: with NO hatches the
detail box AND the fallback both armed on Bistro (the default flip works);
`__giFarField=false` reproduced the baseline; the far field's dark fraction
fell **54.5% → 28.2%** with the mean up only 17% (93.4 → 108.9 — no glow).
The remaining deep blacks in the aerial record are sun-shadowed facades,
in-box and honest. Implementation, with one design substitution forced by
archaeology: the plan said "fed by the field's own average irradiance", but
the dense probe-irradiance lattice died with the transport (§12.8) and SRC's
c0 is a sparse camera-anchored hash with no cheap whole-field reduction. The
average is therefore THE SCREEN GATHER'S: `createGiFarFieldAvgPass`
(giScreen.js) appends two dispatches to the SRC pass list right after the
gather —

- `accum`: one thread per gather texel; LIT texels (luminance above a hair)
  fixed-point-atomic their RGB into 4 words. LIT-ONLY IS LOAD-BEARING: the
  crushed out-of-volume pixels this term exists to fix must not drag their
  own fallback toward black.
- `ema`: one thread; average → EMA α=0.05 (~1.3 s — hides view churn,
  tracks a lamp toggle) → `textureStore` into a persistent 1×1 half-float
  texture → reset accumulators. <64 lit texels keeps last frame's answer
  (boot frames, camera in a wall). Dispatch split = the synchronization; a
  TEXTURE because the resolve sits at the 8-storage-buffer limit and
  texture bindings are free of it.

The resolve (`farField` input): signed inside-distance to the box off the
LIVE `world.min/size` uniforms (F2 slides move the feather for free),
`w = 1 − clamp(inside/feather)` with feather = 2 probe cells, and
`out = mix(out, avg × hemi, w)` where hemi = `0.6 + 0.4·n.y` (sky-down with
a ground-bounce floor — the average already contains ground bounce, so a
hard cosine would starve soffits). Placed AFTER the AO block (the AO
oracle's taps are undefined outside the volume — a broken obscurance must
not re-crush the fallback) and BEFORE every direct term (sun/analytic/
emitter direct are volume-independent and survive at any distance).
View-dependence of the screen average is the accepted v1 tradeoff — EMA
smooths it; F4 remains the go/no-go if screenshots say it's not enough.

**F3 POLISH (same day, after the first live street look — "not quite")**:
the user's street-level screenshots showed (1) the RAW average painted as
saturated lavender fog over everything past ~18 m — at street level the far
field is MOST of the frame; (2) black/white blocking on facades near the
box edge — boundary probes are starved (rays exit the occupancy
immediately) and a 2-cell feather didn't cover their trilinear support.
Fixes: the EMA pass now PUBLISHES SHAPED, ACCUMULATES RAW — keep 35% of
the average's chroma, damp to 0.6 (materials multiply by their own albedo,
so far surfaces keep color variation; only the tint and energy go) — and
the feather widened 2 → 4 cells to swallow the sick zone. The coverage
warning ("receives NO GI") now logs a by-design one-liner instead when the
detail box is armed. Verified at the user's exact captured pose
(`run-gi-farfield-look.mjs`): no fog, no blocking; absolute brightness not
comparable (mid-transcode shot). Remaining look levers if still not
enough: §13.7 bulb-halo damping (near-field purple is genuine bulb gather
at 1 m), then F4.

**AND THE §13 DEFAULT FLIP RIDES ON F3**: `DETAIL_TRIGGER = 60` — with no
hatch, `#detailClampAabb` arms the tier detail box when the scene's
horizontal span exceeds 60 m. `detailExtent: false` force-disables,
`true`/metres force-arm; `__giFarField = false` kills just the fallback
(gate c's baseline). Small scenes are structurally untouched. Rig:
`run-gi-farfield.mjs` — two boots, same pose; gates: box+fallback arm with
NO hatch, kill switch works, ON darkFrac < OFF darkFrac − 2 pts, ON mean ≤
1.8× OFF (not glowing).

### 13.6 Unit F4 — far-field coarse volume (GO/NO-GO, after F3)

Only if F3's constant fallback visibly fails the product bar: a second volume
at scene extent with today's 2.5 m probes behind the detail box. Doubles pool
cost — requires pool-budget splitting before it is even priceable. Decide on
Bistro screenshots, not on principle.

### 13.7 Parallel cheap exploration — the bulb halo specifically

Even at 1.0 m probes a bright pea-sized emitter over-smears. Two bounded
experiments (hatch-gated, OFF by default, each with an A/B rig): clamp the
deposit splat radius for emitters whose physical extent is far below cell
size, and/or let the light tree's per-tile cut (§12.70) damp sub-cell emitters
at resolve. Neither ships without the flip discipline (§12.70's lesson: every
rig's OFF arm is the default and must be set `false` first).

**13.7 SHIPPED 2026-08-16 (variant: damp in the TREE EVAL, default ON)** —
after F3's polish the user's street look still showed meters-wide saturated
patches on mid-distance facades ("too many weird color bleeds, possibly
from emissive bulbs" — correct diagnosis). The shipped lever:
`createLightTreeEmitterEval` (lightTreeGpu.js) scales a record's field
contribution by `clamp(aR / (0.5·spacing0), 0.15, 1)` — `aR` is the
PHYSICAL radius word (disc-equivalent for boxes), so this is a size test,
not a solid-angle change. Emitters ≥ half a cell (Cornell panels, Sponza
banners) are bit-identical; pea bulbs keep a 15% floor. The bulbs' DIRECT
light is untouched — the screen chain (tile cut + shadow pass) delivers it
per-pixel at full strength, so bulbs keep their crisp local pools and lose
only the probe-lattice wash. Default ON (product-driven — the flip
discipline was written for measurement rigs; the kill switch is
`__giSubCellEmitterDamp = false`). The `__giSrcLightTree = false`
promoted-slot arm is deliberately NOT damped (A/B baseline). ⚠ FIXTURE
TRAP: the W3/NEE parity fixtures compare the GPU eval against the undamped
CPU `emitterIrradiance` — a parity rig with sub-cell emitters must set
`__giSubCellEmitterDamp = false` or its energy gate reads the 0.15 floor as
a miss.

### 13.7b The "dirty colors" — BOUNCE CHROMA, and why it is an ERROR term

After F3's polish and §13.7's bulb damp the user's street frame still read
wrong: "still same dirty colors, gi is not correct on those" — saturated
blue/teal/purple blotches, metres across, on neutral stone and pavement.
Neither previous lever could have fixed it, and the elimination is on the
record so nobody re-runs it:

- **NOT the sky.** `sceneSkyRadiance` (giConfig.js:252) returns
  `(i, i, i)` — the SRC transport's sky term is NEUTRAL GREY at any
  environment. A blue sky cannot tint anything through this path.
- **NOT the emitters.** §13.7 already damps sub-cell emitters, and the
  blotches survive it.
- **NOT the far field.** The blotches are in the near field, inside the
  detail box, where the F3 mix weight is exactly 0.

It is the BOUNCE ALBEDO, `resolveMaterialSurface` (voxelizeOnce.js:148):
ONE colour per mesh — `material.color × textureAverageColor(map)` — is the
entire bounce answer for every ray that lands on that mesh. Two
approximations inflate its CHROMA specifically:

1. **One average per mesh.** A shopfront textured blue paint + white trim
   + glass bounces the average over its whole area — the trim and the
   glass deliver the blue too.
2. **Shared cells.** Thin geometry shares a voxel cell, hence one surface
   record and one colour, with whatever is behind it. Live Bistro at high:
   **373 of 636 meshes are thinner than 2 GI cells** (0.70 m at voxel
   0.35), so awnings/signs/shopfronts stamp their colour onto the wall.
   Compounding it, the exact-triangle pool is OVERSUBSCRIBED — `triangles
   2805815/2097152`, **115,358 dense cells fall back to voxel-box hits**
   (records themselves are fine: 1,098,474/2,097,152 = 52%). Both pools
   are at the `1 << 21` hard cap (occupancyField.js:328), so raising them
   is a memory decision (~136 MB to double) needing §12.81 noBlock
   evidence — NOT a casual fix.

Then probe variance amplifies it: at 1 m probes a single probe whose few
rays happened to hit a saturated record paints a ~2 m trilinear blob, and
the temporal EMA holds it there. Metres-wide saturated blotches ARE that.

**The lever: `__giBounceSaturation`** (default 1 = untouched — this ships
as a measured choice, not a silent one). It damps the palette colour
toward its own LUMINANCE, correcting in the direction of the known error
while preserving how much light bounces (the quantity the estimator does
get right). It lands in `resolveMaterialSurface`, whose colour
`#computeFingerprint` hashes — so setting it re-tints the whole palette on
the next fingerprint scan, **live, with no rebuild and no compile wave**,
which is what makes `run-gi-bounce-saturation.mjs`'s four-arm single-boot
sweep possible. The rig gates that the dial moves COLOUR and not ENERGY
(luminance within 15% across the sweep); the arm choice is the user's, on
their own frame.

Follow-ups if the dial is not enough, in cost order: per-cell albedo
instead of per-mesh (kills error 1 outright), triangle-pool growth for the
box-fallback cells (error 2, memory decision), more rays per probe or a
spatial filter on the probe field (the variance amplifier).

### 13.7c THE STRING LIGHTS — MEASURED, AND TWO HYPOTHESES KILLED

User: "confirmed, those light contamination comes from string lights". The
number, at their street pose, on a cobblestone patch that ought to be
neutral grey (`run-gi-emitter-path.mjs`, two pre-boot arms):

| arm | patch chroma | patch p95 | patch lum |
|---|---|---|---|
| default (light tree + tile cut) | **0.174** | 0.429 | 114.4 |
| `__giSrcLightTree=false` + `__giEmitterTileCut=false` | **0.095** | 0.493 | 102.2 |

**The emitter delivery path nearly DOUBLES the chroma of the street while
adding 12% luminance.** That is the contamination, confirmed. The two
hatches flip together (§12.70 W5b) and the OFF arm loses 91 of 95 bulbs'
direct light, so it is a diagnosis, not a fix.

TWO HYPOTHESES DIED HERE, both with receipts — do not re-run them:

- **NOT the baked field via instanced meshes.** `#buildEntries` excludes
  `isInstancedMesh` from the candidate set, which looked like the smoking
  gun (instanced emissive is delivered by the FIELD alone — no NEE, no R5
  zeroing, out of reach of §13.7's tree damp). It is not: the new
  `[gi] emitters delivered by the FIELD ONLY:` diagnostic prints NOTHING on
  this scene. The bulbs are ordinary meshes, already tree emitters, already
  R5-zeroed. §13.7c's damp measured **1%** and is now DEFAULT OFF.
- **NOT bounce-albedo saturation.** A four-arm live sweep of
  `__giBounceSaturation` (1 → 0.15) moved whole-frame chroma by 1%. The
  dial ships at 1 (inert) with the mechanism documented in §13.7b.

⚠ **INSTRUMENT LESSON (cost: two rigs).** Whole-frame chroma CANNOT see
this artifact — a street frame's chroma is dominated by the scene's own
albedo (red awnings, green cafe, blue shopfront), and it read 0.159 vs
0.158 across a sweep that should have moved it. Measure a patch that ought
to be NEUTRAL, and report p95 as well as the mean: a blotch is a tail.

⚠ **FLIP DISCIPLINE, RE-LEARNED.** §13.7 and §13.7c both shipped
default-ON on hypotheses and neither survived measurement; both are now
default-OFF behind `__giSubCellEmitterDamp` / `__giSubCellEmissiveDamp`.
Everything left default-ON in §13 (F1, F2, F3 + its polish) has a rig
number behind it.

### 13.7d NEXT: THE REFERENCE COMPARISON SAYS *DIRECT*, NOT COLOUR

With the user's side-by-side (ours vs the Lumberyard reference at the same
corner) the remaining gap is not hue at all — it is **occlusion contrast**:
"too bright in the areas under the red covers, should be darker there,
overall ours look too flat, lacking contrast". Two separable mechanisms,
neither yet actioned:

1. **Indirect leaks under thin occluders.** At 1.0 m probes the space
   under an awning holds ~one probe, and the sparse-trilinear gather pulls
   in corners from outside the awning. AO cannot rescue it: the ladder's
   self-surface allowance is **2 voxels = 0.70 m** at this scene's 0.35 m
   cell, and `capacity = (d − allowance)/d` zeroes every tap inside that,
   so AO is blind exactly where contact darkening is wanted. Levers: a
   smaller detail extent (finer cells shrink the allowance with them),
   probe-visibility weighting in the gather (`chebyshev` is already
   imported by srcScreenGather), or an AO radius that scales with cell.
2. **Ambient-to-sun ratio + a half-res shadow channel.**
   `#lightShadowScale` is 0.5 at every tier except high (0.7071) —
   §12.79b traded 16.4 ms of a 31.6 ms ultra frame for it, and it buys
   penumbra DETAIL. `__giShadowScale = 1` is the documented one-boot A/B.
   Note the reference's sun is at a different angle, so part of the
   "flat" impression is scene setup, not the engine — separate that
   before chasing it.

### 13.7e THE GATHER HAD NO NORMAL WEIGHT — found, fixed, priced, HATCHED

**The gap:** `srcScreenGather.js`'s corner weight was pure trilinear ×
coverage — a function of POSITION ONLY. A probe on the far side of the
surface being shaded contributed exactly as much as one in front of it.
On thin geometry that is a direct leak: an awning's sunlit TOP and its
shaded UNDERSIDE share a cell (live Bistro: **373 of 636 meshes thinner
than two cells**), so the underside gathered the top's probes. Repeated
across 59% of the scene's meshes, that is both "too bright in the areas
under the red covers" and the "flat, lacking contrast" that comes with it.
(Correcting an earlier note in this section: `chebyshev` in that file is
the max-norm DISTANCE used for LOD selection, NOT a visibility term. There
was no visibility or normal test anywhere in the gather.)

**The fix:** the standard DDGI wrap weight `((n·d)·0.5 + 0.5)^k`, smooth
rather than a hard cutoff (a hard one seams exactly where the tangent
plane cuts the cell), floored at 1e-3 so a fully back-facing corner cannot
collapse `wsum` — the renormalization then divides by what actually
contributed, so such a point goes DARK, not BLACK. Mirrored in
`srcRef.js`'s `gatherPixel` off the SAME global, or `test:gi-src-gather`
would diff a weighted GPU against an unweighted CPU and call the fix a
regression.

**Priced on Bistro** (`run-gi-gather-normal.mjs`, user's street pose,
quality high, k=2):

| | OFF (today) | ON (k=2) | |
|---|---|---|---|
| under-awning patch | 65.3 | **38.1** | −42% — the reported artifact |
| darks (p5) | 10.6 | 3.9 | −63% |
| frame mean | 99.5 | 64.6 | **−35%** |
| std | 53.2 | 42.2 | −21% |
| **std/mean (relative contrast)** | 0.535 | **0.653** | **+22%** |

So it does exactly what it should — cavities darken, relative dynamic
range goes UP — but k=2 also takes 35% of the frame's brightness with it,
because it was leaked light holding the whole image up. Absolute std FALLS
while relative contrast RISES; on a change that moves the mean this hard,
std alone is the wrong read.

**Shipped HATCHED, default OFF** (flip discipline). `__giGatherNormalWeight
= true` is k=2; a NUMBER is the exponent, so `= 1` is the soft half for
scenes that cannot afford the brightness. Gate status: `test:gi-src-gather`
PASSES with it armed (worst 0.14% GPU-vs-CPU, unchanged) — but note that
fixture's field is near-uniform, where corner reweighting normalizes away,
so it proves AGREEMENT and compilation, never effect. Only a scene rig
shows effect.

### 13.7f AO IS OFF BY DEFAULT, AND TURNING IT ON DID NOT FINISH COMPILING

`ao: false` (giConfig.js:140) and no tier overrides it, so the obscurance
ladder — the only mechanism that can darken SUB-probe-scale cavities — has
never run in this scene. Its own comment explains the default ("it only
ever removes light, and it shipped default-on once in the same change that
darkened the whole module"), and that reasoning still holds, but the
consequence was unpriced.

Attempting to price it (`run-gi-ao-sweep.mjs`, `ao: true`, 4 live arms via
the new `__giAoOverride` dial — `aoStrength`/`aoRadius` are uniforms, only
the `ao` prop is structural): **the build never finished in 600 s**, having
reached "detail volume armed". The ladder's ~50 oracle fetches per pixel
inflate the resolve kernel, and this module's own history says WGSL size
buys compile seconds (§13.14: a 122 kB kernel took 17.9 s). Two things
follow: AO's cost is a COMPILE cost before it is a frame cost, and the
sweep needs a longer boot budget or a smaller scene than Bistro.

⚠ Also note for the ladder itself: `allowance = 2 voxels = 0.70 m` at this
scene's 0.35 m cell, and `capacity = (d − allowance)/d` zeroes every tap
inside that — so the default `aoRadius` 0.6 is already below the floor
`reach = max(radius, allowance × 2.5) = 1.75 m`. Any AO arm that does not
raise the radius past 1.75 m is testing the same reach twice.

### 13.7g ⭐ THE REAL BUG: SPARSE EMITTERS DELIVERED THEIR BOUNDING BOX'S LIGHT

The user isolated it in one screenshot — **sun off, bulbs only, whole street
lit**: "those are the lights from those tiny string bulbs, their emissive goes
A LOT further than it should. Technically, considering their size, they should
reach 0.5 m maximum." That framing is what cracked it, because it is a
statement about AREA, and area is the one thing the emitter model was getting
from the wrong source.

**Mechanism.** A GLB splits meshes BY MATERIAL, so every bulb of one colour on
a 6 m string lands in ONE mesh. `collectEmitters` fits that mesh's emitter to
its BOUNDING volume — live Bistro, `StringLights_01a1_6473_1`: box
2.4 × 1.3 × 5.9 m, bounding radius **3.26 m**, standing in for a few cm² of
actual bulb. Both irradiance models scale with the FITTED SHAPE's projected
area (`boxLightFactor` over the OBB; the sphere arm's `π·sin²(R/d)`), so the
mesh delivered a 3 m area light's worth of energy in every direction.
Measured on the live scene: **19 of 95 tree emitters are sparse, worst fill
6.0e-5 — that emitter was 16,636× too bright.**

The tree's own `power` (`π·area·mean`) has always used the TRUE world triangle
area, so the importance heuristic knew the bulbs were tiny while the irradiance
model lit the street. The two were simply never reconciled.

**Fix: scale RADIANCE by the fill fraction, never the geometry.** Energy
delivered is (projected area) × (radiance), so a shape 1000× too large carrying
1/1000 the radiance delivers the right amount. Shrinking the shape instead is
the trap: `angularRadius`/`half` also set where a shadow ray STOPS (`maxT` =
the OBB entry, or `dist − aR`), so a shrunken shape sends rays INTO the string
where they self-shadow on the bulbs' own occupancy cells and delete the light
entirely. **Radiance carries energy; geometry carries occlusion. Only the
first was wrong.**

**The denominator is the LARGEST CROSS-SECTION, and that choice is
load-bearing.** Cauchy's mean projected area (surface/4) is the instinctive
pick and it is WRONG here: it holds for CLOSED bodies, while an emissive panel
is a one-sided plate whose triangles are counted once — Cauchy scores it 0.5
and would silently HALVE every flat light in every existing scene. "Does this
mesh's emitting area cover its own widest cross-section?" separates solid from
scattered and is safe on all of them:

| emitter | fill score | result |
|---|---|---|
| flat panel | exactly 1.0 | untouched |
| closed cube lamp | 6 | clamps to 1, untouched |
| single sphere bulb | π | clamps to 1, untouched |
| Bistro string-light mesh | 0.0035 (worst 6.0e-5) | corrected |

`test:gi-lighttree` passes unchanged (its emitters are solid → fill 1), which
is the no-regression property stated as a test rather than a hope.

**Diagnostics** (the §12.42 rule — this was invisible for an entire session):
`[gi] N of M emitters are SPARSE …` naming the worst offender and its factor,
plus `[gi] emitter ledger — …` listing the top emitters by power with area,
fill, rgb and fitted radius. `__giLogEmitterLedger = false` silences the
ledger. After the fix the ledger reads sanely: top bulbs at 6 cm radius and
0.024 m².

**Consequence to expect:** with the sun off, the street is now nearly black
with visible bulbs and no pools — because the ASSET authors these bulbs at
radiance ~1 over ~0.02 m², which really is almost no light. The flood was
never the bulbs being bright; it was their area being wrong. A scene that
wants visible bulb pools should now raise the bulbs' emissive intensity, and
that dial finally behaves physically: a brighter bulb makes a small bright
pool instead of washing the whole street.

⚠ PARALLEL CASE, NOT YET FIXED: the four promoted ANALYTIC slots fit their
shape through `emitterShapes.js fitEmitterShape`, whose `reff`/`radius` come
from the bounding sphere/half-extents on the same assumption. A sparse mesh
that wins a seat would flood exactly as before. The same fill ratio applies —
it needs the true triangle area at that call site (cache it per geometry;
`#refreshEmitterSlots` runs per frame).

### 13.8 Traps carried in (do not rediscover)

- **No rebuild on slide, ever.** A rebuild is a compile wave (68–77 s on
  Bistro). If any consumer forces `requestRebuild` on a bounds change, that
  consumer is the bug. The §12.56 watchdog will happily re-roll pipelines a
  slide-storm queues — the fix is not sliding per frame.
- **Any value a kernel bakes as a WGSL literal is frozen** (§12.83/triBase).
  The F0 inventory's third column is the checklist.
- Pools are the memory (150 MB class); the detail volume REUSES them —
  smaller extent, same budgets. Any unit that grows a pool must show
  §12.81-style deposit `noBlock` evidence first.
- `__giSrcSecondary = false` still SHADES; quality-only `__giConfigOverride`
  A/B trap; `props.x = v` skips setProp; OrbitControls owns the editor camera
  — every rig sets its camera explicitly or its runs are incomparable.
- The temporal filter (§12.65 ÷12 default-ON) will smear a slide's first
  frames; the light-settle window (§12.67) is what makes that a ramp. A/B any
  flicker claim against `__giShadowTemporal = false` before blaming the slide.
- Merging interaction: GI now waits for `merging.settling` at boot
  (BISTRO_PERF D′). A slide must NOT wait on merging — it is not a rebuild.

### 13.9 Sequencing and exit

F0 → F1 → F2 → F3, each gated before the next starts; 13.7 (halo) parallel
any time after F0; F4 is a decision, not a default. Exit criteria for the
milestone, judged against the user's reference render on Bistro at scale 1,
medium: bulb halos ≤ ~1 m and no facade-wide color wash; street-level indirect
visibly follows the camera with no pops while walking; small scenes untouched
(zero-diff); no new compile waves after boot.
