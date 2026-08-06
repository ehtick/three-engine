# GI Motion Quality + Performance — Architecture Review and Plan of Record

**Date:** 2026-08-06 (session 30). **Brief:** "Performance is quite bad, and lighting/shadows are blocky and jumpy when objects move — rotating cubes don't align to the voxel grid. Deep analysis of both problems, then decide: fix the current architecture (voxel occupancy + 3D radiance cascades) or switch techniques for dynamic real-time game GI."

**Status: ANALYSIS + PLAN. Nothing here is built. Every proposed fix carries its validation bar; the module rule stands — no fix ships on read-the-code evidence.**

---

## §0 Verdict up front

**Keep the architecture. Do not switch techniques.** The re-scored alternatives table (§4) shows no candidate dominates under this engine's real constraints (WebGPU compute-only, 8-storage-buffer wall, web-ship without bakes, movers-first-class mandate, emissive/area lights first-class). More importantly, the two complaints do **not** trace to "radiance cascades over voxels is the wrong technique." They trace to four specific, code-located gaps — each fixable inside the existing design:

1. **Binary radiance injection** — the light side of the pipeline quantizes movers at *field-cell* granularity (coarser than the occupancy voxel) with full-amplitude pops. This is the dominant "light is blocky/jumpy" mechanism. (§2.3, fix §5.1)
2. **Binary probe admission** — buried-probe kills and visibility cuts flip per-probe as movers sweep the lattice → square-shaped stepping the module's own comments already name. (§2.4, fix §5.3)
3. **The exhaustion clamp** — ⅓ of direct-shadow pixels burn the full march budget within ~3 voxels of origin (measured, session 29 part 3c), producing fake umbra, bogus blocker distances, and the per-emissive fps cliff. An active bug, not architecture. (§3.4, fix §5.4)
4. **O(volume) dispatch scoping** — one rotating cube pays full-pyramid, full-macrocell-sweep, full-volume-feedback, full-cascade-trace prices every frame. Cost is proportional to the *world*, not the *change*. (§3.3, fix §5.5–5.6)

The precedent that this pattern works is the module's own recent history: shadows were "shitty on movers" until the trace side got deterministic sub-voxel data (fitted-plane records, dynamic refit, exact triangles) — after which the user's verdict was "those look awesome." The light/field side never received the same generation of fixes. §5 is, in essence, **"records for the field side" plus "scope dispatches to the change."**

---

## §1 The two problems, restated as measured facts

**Motion quality.** A rotating cube re-rasterizes into the axis-aligned bitset every frame. Translation churns only leading/trailing faces; rotation re-phases the rasterization staircase of *every* face continuously — it is the worst case by construction. Downstream consumers inherit that churn at three different quanta (§2.2), and the coarsest consumer (the radiance field) is the one the user sees as "light is blocky."

**Performance.** The sleep/wake design is excellent for an editor and irrelevant for a game: in gameplay something always moves, so the *awake* path is the true cost. Measured (sessions 21/22/26, ultra, Sponza-class): asleep ~0.12 ms GPU compute; awake ~4.5 ms compute post-peak-split (feedback 3.86 / traces 2.14 / probes 0.20 / merges 0.10 pre-split), plus the shadow channel (~1.4 ms at the 900k budget), plus resolve. Against the operative bar — **8.3 ms total frame at 120 fps** (StatsOverlay/SceneSettingsPanel treat this as the budget; `rc-gi-implementation-spec.md:194` sets "RC tracing ≤ 4 ms @ 1080p") — GI alone consumes most of the frame on the user's hardware. Current live result: 60–90 fps in Play after the session-26 shadow-pass split; target 120.

---

## §2 Problem 1 — why movement looks blocky (the mechanism chain)

### 2.1 The churn source

Conservative SAT voxelization ([occupancyField.js](../src/modules/gi/occupancyField.js)) rasterizes triangles into level-0 bits (0.10 m ultra → 0.25 m low, `GISystem.js:5511`). A rotated plane's voxelization is a staircase whose phase sweeps with angle; conservative rasterization bulges it ("teeth," session 26 part 4). Per frame of rotation, the occupied SET gains and loses whole voxels along every face. **This churn is unavoidable in any voxel-family technique** — what matters is at what amplitude and granularity each consumer inherits it.

### 2.2 The three quanta (the central table)

| Consumer | Spatial quantum | Amplitude of per-frame change | Status |
|---|---|---|---|
| Shadow/gather ray **traces** | **sub-voxel** — fitted planes + exact triangles, dynamic tail refit every frame | continuous (records move with the mesh) | **FIXED** (sessions 23–26), residual classes in §2.5 |
| Occupancy **bits/pyramid** (admission, oracles, AO) | 1 voxel (0.10–0.25 m) | binary per voxel | inherent; acceptable at voxel scale |
| Radiance **field injection** | **1 field cell — 2–3× coarser than a voxel** (see below) | **binary, full amplitude, instant appear/disappear** | **UNFIXED — dominant light-side artifact** |
| **Probe gather** (irradiance to receivers) | probe spacing (~0.25–0.5 m), 8-probe trilinear | binary per-probe admission flips | **UNFIXED — square stepping** |

The field-cell/voxel gap deserves emphasis: field resolution is capped at 128/axis with a cells budget (`GISystem.js:349, 363-368, 3227-3235`), while the occupancy pyramid has its own finer budget (`GISystem.js:5511-5519`). Example, a 40×10×40 m scene at ultra: field cell = max(40/128, ∛(16000/2.8M)) = **0.31 m**; occupancy voxel = **0.10 m**. **The light side's quantum is ~3× coarser than the shadow side's — and it grows with scene size while the voxel doesn't** (the 128-axis cap binds first). This is why light looks blockier than shadows, and why it gets worse on bigger scenes.

### 2.3 The light path is binary end-to-end (code-confirmed)

- Composite: `occupied = step(minD, occThreshold)` — [giField.js:309](../src/modules/gi/giField.js#L309); the pyramid contributes via `occupiedAtWorld(p) > 0.5` forcing distance 0 ([giField.js:307](../src/modules/gi/giField.js#L307)). No fractional coverage exists anywhere on this path (verified by sweep: the 4×4 coverage masks and fitted planes are consumed **only** by ray traces, never by injection).
- Staging/surface writes: `vec4(emissive·occupied, occupied)` / `vec4(albedo, occupied)` — w is 0 or 1 (`giField.js:475-476`).
- Feedback gates: `If(base.w < 0.5) → zero + Return` ([cascadeGather.js:855-862](../src/modules/gi/cascadeGather.js#L855)); reliability `surface.w > 0.35` (`:903`) — same binary bit.
- Injection: sun `direct = albedo·energy·shadow·smoothstep·(1/π)` added to the **full cell** (`:1040-1045`); emitters likewise (`:1111-1116`); bounce likewise (`:1132-1134`). A 5 %-covered edge cell injects identically to a 100 %-covered interior cell.
- Temporal: appear is instant (`wasEmpty → alpha 0`, `:1145`), disappear is instant (empty-clear same frame, `:855-862`) — **deliberately** (fade-in-from-black was worse). The EMA (`fieldSmoothing` 0.95, squared to 0.9025 under peak split) smooths cells whose *value* changes; it cannot smooth cells whose *membership* changes.
- Normals at injection come from the gradient of the binary-forced distance field (`distanceTexture.gba`, `:912-915`) — they snap between quantized directions as the staircase phase moves, so `ndotl` and the shadow-ray origin lurch even for cells that stay occupied.

**Net mechanism:** as the cube rotates, ~0.3 m blocks of injected radiance pop in at full brightness and vanish instantly, with snapping normals, and the probe/EMA chain then partially smears the steps into a lurch-then-settle. That is precisely "blocky and jumpy light."

**The physical framing (why §5.1 is the right fix, not a hack):** for a rigid mover, *surface area is the frame-to-frame invariant* — the bits representing the cube redistribute between neighboring cells but their count is nearly conserved. Binary occupancy destroys this conservation (a cell counts 1.0 whether it holds one bit or thirty). Area-weighted (popcount-weighted) injection restores it: total injected energy becomes stable under motion by construction, and popping becomes gradual redistribution. Side benefit: thin geometry currently *over*-emits (a 1-voxel pole bounces like a solid wall cell) — area weighting is more physical in the steady state too.

### 2.4 The gather side steps at probe granularity

The screen resolve gathers 8-probe trilinear irradiance with **binary per-probe admission**: buried-probe kill (`cascadeGather.js:419`), visibility cuts whose surviving-set switches as normals rotate through the lattice (`:258-268`), rejection state flipping "in probe-cell-sized blocks ('flickers in large squares')" (`:344-348` — the module documents its own artifact). A mover sweeping the lattice buries/unburies probes one at a time. Session 9 already proved the fix pattern on a sibling artifact: the merge's binary tolerance cut imprinted the parent lattice until it became a soft `[tol, 2·tol]` fade. The gather's admission needs the same generation of fix, plus the Chebyshev/variance weighting the existing depth-moments pass (`probeDepth`, `depthMomentsAlpha` 0.12) can already feed (§5.3).

Residual honesty: trilinear probe interpolation itself swims as receivers move relative to the lattice — inherent to every probe-grid GI (DDGI included, at coarser spacing than ours). The fixable part is the *binary admission flips*; the smooth swim is the accepted cost of the family.

### 2.5 The shadow path is sub-voxel — except five named classes

Movers get per-frame fitted-plane refit + exact triangles (suite: silhouette fattening 486→0). What still box-quantizes or degrades, in likely visibility order:

1. **The exhaustion clamp** (§3.4) — ⅓ of pixels as angle-independent fake umbra. Active bug, top of the ladder.
2. **Static cells inside a mover's brick** → box fallback (`occupancyField.js:1665-1667`) — contact regions fatten while an object moves next to static geometry.
3. **Complex (>8-tri simple max) cells** without a triangle pool at **low/medium** (`AUTO_MODE_BY_QUALITY` gives plane-only) → box silhouettes exactly on edges — i.e. on every silhouette of a rotated cube at those presets.
4. **Width-probe lattice etching** — both arms' raw carries a voxel-lattice grid (rawGrain 0.602, PNG-verified); one bilateral remains as insurance; the §9.5 monotonicity scan is the queued instrument.
5. **Dynamic tail overflow / missing flags** → box, counters exist.

---

## §3 Problem 2 — where the milliseconds go

### 3.1 The cost identity

Sleep/wake gates everything on `#fieldInputHash` + atlas revision (`GISystem.js:1332-1361, 4080-4132`). Camera motion correctly costs ~0 (measured, session 22). But **any** light or object change wakes the full transport, and a game always has one. So the design target must be: *awake cost ≤ budget*, not *sleep more often*.

### 3.2 Stage split (measured, session 21/22, ultra)

feedback 3.86 ms · cascade traces 2.14 · probes 0.20 · merges 0.10 · resolve ~0; peak split alternates feedback/traces on strict frame parity → ~4.5 ms compute observed. Shadow channel ~1.4 ms at 900k px. Emitters: pass at half the shadow budget; user-reported cliff ("one emissive −10 fps") predates the split and is entangled with §3.4.

### 3.3 Sink 1 — everything dispatches O(volume), nothing dispatches O(change)

Code-verified dispatch extents:

| Pass | Dispatch extent | Scoped to mover? |
|---|---|---|
| restoreStaticBits + copy (fast chain) | all level-0 words | no |
| OR-downsample L1–4 + density L1–4 | full pyramid, every level, every frame | no |
| hybridBuild + dynSurfAlloc | **every macrocell in the volume** | no |
| voxelize/accum/finalize (pair kernels) | whole scene pair list | thread-gated only (early-Return; cheap by measurement) |
| composite | full volume | thread-gated by dirty AABB (`giField.js:195-202`) — gate, not dispatch |
| **field feedback** | **every field cell** ([cascadeGather.js:1153](../src/modules/gi/cascadeGather.js#L1153)) | no — only the row-parity checkerboard (off at high/ultra) |
| **cascade traces** | **probeCount × dirCount × levels** (`cascadeTrace.js:218`) | no |
| merges/probes | full lattice | no |

There is **zero** dirty-region machinery in the radiance path (grep-verified). One rotating cube pays the cathedral price per frame. Session 27 fixed the *spawn* path (stable slots, incremental setGeometry); the *move* path has no equivalent. The spec's own bar — "dirty-brick update of one moving 1 m object ≤ 0.3 ms" (`rc-gi-implementation-spec.md:95`) — was never implemented for the per-frame chain.

### 3.4 Sink 2 — ~~the exhaustion clamp~~ RESOLVED 2026-08-06 (session 30): THE BUG DOES NOT EXIST

**The session-29 "⅓ exhaustion clamps" reading was three stacked instrument artifacts, taken apart with a paint ladder + shadow-ray profiling (this session):**

1. The kind-map paint was **multiplied by the burial gate downstream** ([giScreen.js](../src/modules/gi/giScreen.js) `traced.x.mul(burial)`) — a burial-zero pixel, a gate-failed pixel and a kind-4 clamp were all byte 0. (Fixed: kind-debug modes now bypass the multiply; sub-kinds 4/5/6 distinguish macro-limit / brick-limit / invalid-brick.)
2. The rig's temporary sun **pointed (0,0,−1) — horizontal** — because the entity's *position* was set but the LightComponent aims by *rotation* (and its forward is +z: `lookAt(origin)` aims the sun UP). Every floor pixel legitimately failed the 0.05 terminator gate → pre-assigned black.
3. The remaining black mass = **background texels** — never-rasterized gbuffer texels whose clear value passes the `g0.w > 0.5` geometry gate with normal (0,0,0) → cos 0 → black bytes **that no material ever samples**. Production-invisible. (Verified by projecting real-geometry points across the whole visible scene: floor 9 dark of 5,149, wall 31/800, panel 2/480.)

**The march itself is healthy: with shadow rays folded into the rayHitDebug counters (new `__giShadowProfile` hatch), 250M+ rays on the wall rig at high read ZERO macro-limit exits, ZERO brick-limit exits, ZERO invalid brick refs, maxMacro 37 of the 160 budget.** The per-emissive fps cliff is therefore NOT stuck rays — it needs per-pass timestamps (§7.2), not a marcher hunt.

**Real bug found and fixed en route — the BURIAL GATE probe height:** conservative voxelization builds a **2-row shell above a lattice-aligned surface** (bits-readback measured: floor plane at lattice phase 0.000 occupies its row *and* the row above), so the gate's 1.5-voxel probe sat inside/against that shell: on lit floors the free-radius oscillated with lattice phase between ~0.5 and ~1.25 voxels across the `smoothstep(0.5·voxMax, 1.25·voxMax)` window → a **30–60% dimming lattice etched across lit floors** (very likely session 29's "raw lattice etching", rawGrain 0.602 in both arms). Probe height now 3.5 voxels (`__giBurialProbeHeight`, build-time): measured ~3,850 px of the wall rig's floor moved from partially-dimmed to fully open; canopy burial (the gate's purpose) keeps working at ≤ ~0.5 m clearance. Open follow-ups: re-measure `run-gi-shadow-motion` grain, eyeball for white-dot regression on foliage-class scenes, background-texel `g0.w` clear hygiene, and the 2-row shell itself (fat contact shadows — separate item).

### 3.5 Sink 3 — emitters

Four slots compiled; the emitter pass invokes `emitterSlotShadow` **unconditionally per slot** inside the geometry branch ([giScreen.js:684-686](../src/modules/gi/giScreen.js#L684)) — verify internal gating and add a per-slot active/radius gate if absent. Combined with §3.4 (stuck rays at max cost), this is the remaining shape of "5 emissives = 2× drop."

### 3.6 Sink 4 — convergence cadence

The feedback↔trace ping-pong must run while anything changes; peak split already halves the per-frame peak by exploiting the ping-pong structure. Further rate cuts trade latency. The remaining safe levers are *locality* (§5.6), the feedback checkerboard at high/ultra (currently off pending a flicker eyeball — becomes viable once §5.1 removes the popping it would amplify), and half-rate shadows (unlocked by determinism, `GI_SHADOWS_PLAN.md` §7.2).

### 3.7 Budget arithmetic

Target: GI ≤ ~3 ms GPU total in gameplay (leaving 5+ ms for the game at 120 fps). Path: exhaustion fix (unknown, plausibly large on emissive scenes) + mover-scoped chain (O(volume)→O(mover); measure first, §7) + trace hit-caching for light-only frames (~1.6 ms class, session 21) + half-rate shadows (~0.7 ms class) + medium/high preset as the shipped game default (ultra is documented as 4× cost for no measurable banding/brightness win, session 9). The arithmetic closes without any architectural change — *if* the locality work lands.

---

## §4 The decision — alternatives re-scored against OUR constraints

Constraints that score candidates: WebGPU compute-only (no RT API) · 8 storage buffers / 12 uniform buffers on target devices · web-shippable with no offline bake (the SDF bake cache is Tauri-only; occupancy needs none) · movers first-class (standing mandate) · emissive/area lights first-class · open-world clipmap future · a large working investment in occupancy + records that is exactly the hard part of any voxel-family technique.

| Technique | Would it fix motion blockiness? | Would it fix perf? | Killer against our constraints |
|---|---|---|---|
| **DDGI / RTXGI probe grids** | **No** — traces the same voxel substrate (no BVH affordable per probe ray — GI_PLAN non-goal); probes *sparser* than our c0; hysteresis EMA (~0.97 typical) = **more** motion lag than ours | Partially (fixed ray budget/frame) — stealable without switching (§5.6) | Rewrite that inherits our quantization, loses the cascade angular ladder + radiance field (volumetrics), keeps probe-lattice swim |
| **VXGI / voxel cone tracing** | No — same voxel quanta, plus density≠opacity | No | **Already tried and measured in-repo** (density-cone arms, session 26): thin-solid 1/8 leak vs fail-dark black are congenital; §8 of GI_SHADOWS_PLAN stands |
| **SDFGI (Godot-style)** | No — movers famously excluded from GI contribution | — | Mesh-SDF bakes are the web ship-blocker this module already retreated from |
| **Lumen-style (mesh SDF + surface cache)** | Partially | Partially | Surface cache = the "surface-resident probes" non-goal; mesh SDFs retired; multi-structure design vs the 8-buffer wall; far over scope |
| **ReSTIR GI** | No (temporal lag under motion is its known weakness) | No | **Deleted 2026-07-16, standing don't-re-propose**; reservoir buffers vs the 8-storage wall |
| **Surfel GI (GIBS/GI-1.0 class)** | Partially (surfels move with geometry) | No (heavy management) | Needs a ray backend anyway; heavy temporal accumulation = the same motion-lag class; enormous scope |
| **Screen-space GI** | **Anti-fix** — disocclusion artifacts exactly under motion | Cheap | View-dependent; fails the design case outright; supplement at most |
| **Per-pixel PT + denoiser** | No — accumulation-vs-motion contradiction, re-litigated and closed by GI_SHADOWS_PLAN §8 | No | The module's three shipped denoiser rounds are the evidence |

**No candidate fixes the actual root causes** — every world-space technique on this hardware quantizes *somewhere*, and ours already has the finest-grained hit representation (records/triangles) of the family. The one genuinely good idea worth importing is DDGI's **Chebyshev visibility weighting** — and we already compute depth moments, so it imports as a weighting change, not an architecture change (§5.3).

**Kill criteria (what would reopen this decision):** if, *after* §5.1 + §5.4 + §5.5 land and validate, medium preset still pops visibly on the rotating-cube rig, or awake GPU still exceeds ~4 ms at high on the user's hardware — then the answer still isn't a technique swap (the table above doesn't improve under those failures); it is a scope negotiation (finer field cells as a cost knob, or preset ceilings for gameplay). Write that down now so nobody re-litigates the table under frustration.

---

## §5 The design — six workstreams

### 5.1 Coverage-weighted injection (the light-side "records moment") — HIGHEST QUALITY LEVERAGE

**v1 (minimal, zero semantic churn):** in `createBounceFeedback`, compute per-cell `coverage = clamp(popcount(level-0 bits inside this field cell) / K, ε, 1)` and multiply it into all three injection sites (analytic direct, emitter direct, bounce term — the shared `fieldAlbedo` sites). The bits buffer is **already bound** in the feedback kernel (the shadow closure marches it) — zero new bindings. A field cell spans ~2–3 voxels/axis → a handful of word fetches. `K` = the measured median surface-cell popcount per build (normalize once at composite time or CPU-side from the readback; exact value only shifts steady-state gain, which `bounceGain`/baseline A/B absorbs — the *derivative* win is normalization-independent).
- **What it buys:** per-frame injected-energy conservation under rigid motion (§2.3's physical framing) — popping amplitude drops from 1.0 to ~1/popcount granularity; thin-geometry over-emission also corrects.
- **Follow-on (v2):** bake fractional coverage into the composite's `w` channel so the trilinear radiance sampler's binary corner admission (`voxelizeOnce.js:349, If(voxel.w > 0.5)`) becomes weighted too. Requires the bounded `.w`-consumer audit: `staging.w−prev.w` ingest test (`cascadeGather.js:850`), `wasEmpty` (`:848`), empty-clear (`:855`), reliability 0.35 (`:903`), CPU direct bake threshold, `indirect.w` consumers. Do v2 only after v1's A/B proves the mechanism.
- **Hatch:** `__giCoverageInjection=false` restores binary. **Bars:** rotating-cube flicker arm (§7) step-amplitude ↓ ≥ 5×; splitroom sealed rows unchanged; sponza chroma/leak baselines within noise; converged stills ΔE small and uniform (a global gain shift is acceptable, a spatial pattern change is not).

### 5.2 Record-true normals + origins at injection

Replace the binary-distance-gradient normal at injection with the fitted-plane record normal where a record exists (records live inside the already-bound bits buffer — zero new bindings; `simplePlaneRecordAt` exists and is DynamicBrick-aware since session 26 part 4). Kills `ndotl` snapping and stabilizes the field shadow-ray origin for movers. Fallback to the gradient where no record exists. Bar: rotating-cube arm, lit-face luminance trace over rotation should turn from staircase to smooth; direct-arm screen shadows must stay bit-identical (field-side-only change).

### 5.3 Soft probe admission (import Chebyshev, keep the lattice)

Replace binary buried-probe kill + visibility cuts in the gather with: (a) the session-9 soft-fade pattern (`[tol, 2·tol]`) on every remaining hard cut; (b) Chebyshev weight from the existing depth-moments pass (mean/variance are already EMA'd at `depthMomentsAlpha` 0.12) as a continuous occlusion weight instead of set-membership. Bars: run-gi-flicker-frame "flickers in large squares" class (mover sweeping the lattice) rev/px ↓; curved-receiver banding non-regressed (`gatherBias` rig); leak rows hold (Chebyshev must only *darken* relative to the binary kill, never admit a buried probe more).

### 5.4 The exhaustion hunt — DONE 2026-08-06 (session 30), verdict in §3.4

Ran exactly as prescribed (paint the deciding branch before touching thresholds) and the verdict is: **no exhaustion exists; the instrument was lying three ways** (§3.4). Deliverables that remain useful: sub-kind fail-closed attribution (kinds 4/5/6 in the pen variant + the `"sub"` paint), the `__giShadowProfile` hatch (shadow rays → rayHitDebug counters — the smoke's zero-limit assertions now cover the shadow arm when set), the burial/free/gate/normy paint ladder in giScreen, SUN/SUNPOS/KINDSUB/FLOORY/PROFILE arms + kind histograms + visible-geometry sweep on `run-gi-emitter-shadow-probe.mjs`, anti-throttle flags on `run-gpu-page.mjs`, and the burial probe-height fix. Harness lesson for the permanent record: **a component light aims by entity rotation (+z forward), not position — and byte-identical bucket counts across a code change mean the changed branch never ran.**

### 5.5 Mover-scoped dispatch extents for the fast chain

Parameterize the volume-shaped fast-chain kernels with `(dirtyMin, dirtySize)` uniforms and dispatch exactly the AABB window (kernel maps linear index → AABB-local xyz; same code shape as the composite's `inDirty` but as a *small dispatch*, not a full dispatch with a gate). Per-slot old∪new AABBs are CPU-known (session-27 bookkeeping); `computeNode.count` live-bump is a proven pattern. Scope: restoreStaticBits window, copy, OR-downsample L1–4 (AABB>>level), density L1–4, hybridBuild + dynSurfAlloc macrocell windows. Restore must cover the union with *last* frame's AABB (bits must be restored where the mover left). Fallback to full extents when the union exceeds a threshold or `staticDirty`. **Measure first** (§7 per-pass timestamps) — the win is O(volume)→O(mover) on the chain's fixed overhead, and the honest expectation must come from the instrument, not this doc.

### 5.6 Radiance-path locality (the session-21 ladder, now with a design)

- **(a) Light-only frames — cached-hit re-shade (biggest single transport lever, ~1.6 ms class):** when the frame's change classifier says "lights changed, geometry didn't" (light hash moved, atlas revision didn't), cascade rays' *hit geometry* is unchanged — skip the DDA and re-shade the cached hit (t + cell id from last trace). Storage for the hit cache must be found inside existing targets (pack into trace-texture alpha or reuse a freed buffer) — the 8-storage wall is the design constraint to clear first. Sun arcs and flickering lamps — the common game case — get transport at re-shade cost.
- **(b) Mover frames — corridor invalidation:** rays whose probe-to-interval corridor intersects the mover's dilated AABB re-trace; the rest re-shade. Conservative distance test per (probe, dir-cone).
- **(c) Feedback distance-tiered cadence:** cells within k m of any change run full-rate; far cells run 1/4-rate with alpha compensation, on a **strict modulo phase** (the irregular-cadence pulse bug already shipped once — regularity is a hard requirement). Far cells' irradiance genuinely changes slowly (their view of the mover is small-solid-angle); the EMA already imposes more latency than this adds.
- **(d) Feedback checkerboard at high/ultra:** re-eyeball after §5.1 (the flicker that blocked it is mostly injection popping).
- **(e) Half-rate shadows** per GI_SHADOWS_PLAN §7.2 — already unlocked by determinism.

### 5.7 Only after 5.1–5.3 land: shrink the temporal machinery

`fieldSmoothing`/probe EMAs exist to hide popping. Once inputs stop popping, lower them (A/B on the flicker rig) — less lag, snappier light response. Do not touch them first; that order ships lag *and* pop simultaneously.

---

## §6 Explicitly rejected fixes (don't re-propose)

- **Voxelization-phase jitter + temporal accumulation (TAA the voxels):** converts popping into noise and re-imports the accumulation-vs-motion contradiction the shadow work just escaped. Determinism is the module's proven direction.
- **Technique swap** — §4. Includes "just use shadow maps for movers": surrenders emissive/area unification and violates the standing movers-first-class mandate.
- **Per-frame full static+dynamic re-voxelize to "unify" the chains:** the static/dynamic split is why spawn/move is affordable at all (session 19: 7.45→3.27 ms).
- **Finer field resolution as the popping fix:** cost scales cubically; §5.1 fixes amplitude at *any* resolution and is nearly free.
- **More denoising/multi-spp anywhere:** GI_SHADOWS_PLAN §8 stands.

---

## §7 Validation instruments (build before the fixes, per the standing rule)

1. **Rotating-cube arm** for `run-gi-flicker-frame`: a cube rotating at fixed rad/s on the camera ray (the session-22 pose lesson — verify "excluded > 0"), plus a **step-amplitude metric** (p95 per-pixel per-frame |Δ|, distinct from reversals — popping is a step, not oscillation) and a lit-face luminance-vs-angle trace (staircase → smooth is §5.2's bar).
2. **Per-pass GPU timestamps for the fast chain + feedback + traces** (extend the session-21 harness with self-driven `resolveTimestampsAsync` medians; never `renderer.info` pool reads). This is the §5.5/§5.6 before/after instrument, and it settles what the chain's fixed overhead actually is before anyone optimizes it.
3. **Energy-conservation A/B** for §5.1: splitroom sealed rows, sponza chroma/leak, bleed-rig far-field exponent (must stay ≈ −2.66) — coverage weighting must not bend the transport calibration.
4. **Exhaustion histogram** (§5.4) as a permanent smoke assertion: kind-4 fraction < 1 % on the wall rig, checked in CI like the 8-bindings assertion.
5. All existing suites: phase0–5, gi-occupancy, gi-spawn, rayhit-dynamic/shadow, smoke arms at exactly 8 bindings.

---

## §8 Sequencing

| Order | Work | Class | Why this order |
|---|---|---|---|
| 1 | §7 instruments (rotating-cube arm, per-pass timestamps) | instrument | everything downstream needs its ruler first |
| 2 | ~~§5.4 exhaustion hunt~~ **DONE session 30 — bug does not exist (§3.4); burial probe-height fix landed instead** | bug | — |
| 3 | §5.1 coverage-weighted injection v1 | quality | dominant visible artifact; zero new bindings; cheap |
| 4 | §5.2 record normals at injection | quality | completes the light-side records move |
| 5 | §5.5 mover-scoped dispatches | perf | O(volume)→O(mover); measured by instrument 2 |
| 6 | §5.3 soft probe admission + Chebyshev | quality | needs 3's calmer inputs to evaluate fairly |
| 7 | §5.6a/b hit caching + corridor invalidation | perf | biggest transport lever; 8-buffer design spike first |
| 8 | §5.6c/d/e cadence tiers, checkerboard, half-rate shadows | perf | safe only after popping is gone |
| 9 | §5.7 EMA shrink | quality | last, by construction |

Each lands behind a hatch, A/B'd on the instruments, one at a time — the session-15 rule ("never ship a GI fix whose evidence is 'this looks wrong'") applies to every row.
