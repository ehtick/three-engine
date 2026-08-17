# GI: emitter delivery fix + world-anchored spatial rebuild

---

## ▶ NEXT SESSION STARTS HERE

**1. ✅ SPARSE-EMITTER SPLITTING — SHIPPED 2026-08-17.** See §13.7h below.
Measured on the user's own cafe, boot ledger: **19 of 19** sparse meshes refit,
worst fill **6.0e-5 → 3.5e-1**, and only **5 of 130** emitters still sparse
(was 19 of 95). Gate: `npm run test:gi-emitter-split`.

**2. S1's default flip** needs, in order: convert `srcRef.js`'s mirror and
`srcGizmos.js` to world-absolute keys (both gate/debug-only, mechanical); gate 1
as a PIXEL DIFF rather than a luminance mean; gate 3's "no frame > 2× median"
freezeless assertion (the spin rig reports recovery, not frame times); gate 4's
memory-fixed-across-a-5-minute-walk. Then flip `__giSrcWorldKeys` on.

**3. E3/E6** (`collectEmitters` over pre-merge members — wins back 448 draw
calls), then the cleanups: `AttributeNode: uv not found` spam, the jsHeap slope,
and `COUNTER_FRESH` reading 0 through `readPressure`.

**4. The 5 emitters still sparse after the split** are single connected pieces
that do not fill their own bounds (worst 3.5e-1, i.e. 3× too bright before
damping). §13.7g handles them correctly and they are no longer a delivery
failure — but if one is a facade mask, the right fix is the SPATIAL one the old
refusal comment describes, not a tighter fit.

✔ **The user's project is back as found.** `Spotlight_Emissive.mat`'s diagnostic
`emissiveStrength` 150 was reverted to 1 (2026-08-17). Nothing else was touched.

⚠ **METHOD RULE EARNED TODAY, THE HARD WAY.** Every emissive rig in this repo
authors a FLAT emissive colour, so none of them could reproduce the bug that
actually cost five sessions (a TEXTURE-driven `emissive` input). A rig that
passes is not evidence about the user's scene. **Read their material and their
live ledger first** — `console_read` + `material_get` over MCP found it in
minutes after rigs had missed it for weeks.

New gates registered this session: `test:gi-shadowed-bulb`,
`test:gi-emitter-size`, `test:gi-src-worldkeys` (pure Node),
`test:gi-spin-retention`, `test:gi-seat-churn`, `test:gi-emitter-split`.

---

## §13.7h — SPARSE-EMITTER SPLITTING (shipped 2026-08-17)

**One glTF mesh is not one light.** A glTF splits by MATERIAL, so a whole run of
party bulbs, every downlight in a ceiling, or every window pane on a facade
arrives as a single mesh — and `emitterFromMesh` fitted ONE shape to it. Live
ledger before: `P=1.8e+1 area=3.8e-2m² fill=0.000 rgb=0.0/0.0/0.0 r=12.03m`.

`collectEmitters` now refits a sparse mesh as **one emitter per connected
piece**. Connectivity, not a spatial grid: the pieces are already named by the
geometry (a bulb is a closed shell sharing no vertex with the next), and any
grid cell size splits a single long neon tube — which must stay ONE light —
while merging bulbs that happen to sit close. Vertices are welded by exact
position first, so a de-indexed or merged mesh does not read as one piece per
triangle. Result is cached on the geometry in LOCAL index space, because
`#refreshLightTree` re-runs `collectEmitters` whenever a lamp moves.

**Two things are easy to get wrong here and both were, first time:**

1. **Fill is nearly scale-invariant under merging.** Cut a 2-D scatter of N
   pieces into k groups and each holds N/k pieces across an extent ~E/√k, so its
   cross-section falls by the same k and the fill does not move. So the per-mesh
   cap's acceptance test cannot be a fill test — measured, 80 bulbs into 16
   groups gives meanFill 0.017 against the whole string's 0.022, and a fill-only
   rule REFUSES every capped split. The second criterion is PLACEMENT (mean
   fitted radius halved), which is the other half of the original bug anyway:
   every receiver stood INSIDE a 12 m sphere where the irradiance model has no
   meaning, and no radiance could have fixed that.
2. **Morton chunking is not good enough, and per-axis normalization is worse.**
   Normalizing each axis to its own range makes a 1.5 m step in Y compare equal
   to an 11.9 m step in X, so Morton sorts by the SHORT axes and every group
   spans the whole mesh (worst group radius 2.34 m against 2.86 m unsplit — the
   cap achieved nothing). Isotropic quantization fixed half of it (1.57 m); the
   rest was Morton's own boundary jumps. **Repeated median splits of the widest
   group** give 0.97 m and need no reasoning about curve order.

Refused when neither criterion wins — co-located duplicate pieces would
otherwise become N copies of the same wrong shape at N times the tile-cut cost.
Solid meshes (every lamp anyone has already authored) pass through
**bit-identical**; that is asserted, not assumed. Power and area are conserved
exactly across a split — this is a change of MODEL, not of content.

Hatches: `__giEmitterSplit = false`, `__giEmitterSplitBudget` (default 256 added
scene-wide; emitter count is a per-frame cost in the §12.70 tile cut).

⚠ `(meshId, instanceId)` in a packed record **is no longer an emitter identity** —
every piece of a split mesh carries the same pair.

---

## ⚑ SESSION RESULTS 2026-08-17 (read this first — two sections below are overturned)

**Shipped:** the Phase-E gate (`test:gi-shadowed-bulb`), B1, B2, B3, and S1's
core swap behind `__giSrcWorldKeys` with its property gate
(`test:gi-src-worldkeys`). Build green; `test:gi-src-math` (the TSL/mirror twin),
`test:gi-src-ref`, `test:gi-lighttree` all pass.

### ⛔ PART 1 PHASE E IS REFUTED. Do not spend another session on it.

E0 ran on the rig E4 asked for — one r=0.05 m bulb at authored strength 2000,
**hidden behind a shade so every measured pixel is delivered light**, wall patch
0.5 m away, no sun, no environment. That last property is why no existing rig
could see this: in the storm / NEE / emitter-scale rooms the lamps are IN FRAME,
and a lamp's own raster-emissive pixels are bright with the entire transport
severed. A centre-crop luminance statistic passes on a dead transport there.

| arm (95 tree emitters, measured bulb UN-SEATED) | lit | dark | delta | snr |
|---|---|---|---|---|
| tree + tile cut armed (**the default**) | 0.77852 | 0.66039 | **1.18e-1** | 385 |
| both hatches off (field emission) | 0.84786 | 0.84541 | 2.45e-3 | 22.6 |

**The armed path delivers 48× MORE than field emission, not zero.** Verified at
1 emitter (seated, delta 6.5e-1) and at 95 (un-seated, above) — i.e. at the
user's own emitter count, with the measured bulb proved un-seated by the seat
score (decoys out-rank it 2.4×). R5-zeroing-over-dead-delivery does not
reproduce; the tree/tile-cut path is what makes a small hidden emitter visible
at all, and the *field* path is the weak one.

So E1/E2/E3/E5/E6 are not chasing the reported symptom. If "emitters deliver
zero" is still visible in the user's scene, it is **scene-specific** and the next
step is to run this rig's method (hide the emitter, measure delivered light) on
that scene rather than to re-derive delivery from theory. E6 (`collectEmitters`
walking pre-merge members to win back the 448 draw calls) is still worth doing —
but as a PERF item, not a correctness one.

### ✅ E1 WAS REAL AFTER ALL — a texture-driven `emissive` baked BLACK

Found on the user's live scene, not on a rig. `tslGraph` compiles the BSDF's
emissive pair to `emissiveNode = mul(colorInput, strength)`. `resolveMaterialSurface`
had `emissiveTexture ? null : constantColorOf(…)`: a texture-driven emissive was
REFUSED outright, so the mesh emitted nothing and `emissiveStrength` multiplied a
node GI never evaluated — 1, 100 and 1500 were bit-identical darkness. The
"emitter bakes BLACK" warning was gated on `!emissiveTexture`, so this case
printed **nothing at all**.

Fixed: a texture-driven emissive resolves to its **mean × strength**. The old
refusal's spatial argument (a mask averaged over a facade misplaces the glow) is
right and is now WARNED about; its energy argument was backwards — emitted power
is `area × mean(radiance)`, so the mean is the energy-correct summary, the same
identity `textureAverageColor` is already trusted for on bounce albedo. The
strength needs `textureScaleOf` because that `mul` bakes it into the node and
`material.emissiveIntensity` stays at 1. `resolveMaterialSurface` is shared, so
the light tree is fixed by the same change. Verified live: the café went from
black to fully lit.

⚠ **METHOD.** This is the family E1 predicted ("authored strength is DISCARDED"),
on the branch E1 did not name — and it was dismissed earlier in this same session
on RIG evidence. Every emissive rig in this repo authors a FLAT COLOUR, so none
of them can reproduce it. Read the user's actual material and ledger before
generalising from a rig.

### ⛔ STILL OPEN — SPARSE EMITTERS DELIVER LITERALLY ZERO

Same scene, live ledger:
`P=1.8e+1 area=3.8e-2m² fill=0.000 rgb=0.0/0.0/0.0 r=12.03m` — an entire
string-light run welded into ONE emitter with a **12 m fitted radius**. §13.7g's
sparse correction damps its radiance ~12,000× to zero, and every receiver in the
café sits INSIDE that fitted sphere, where the sphere irradiance model is
meaningless. **19 of 95 emitters are in this state.**

The correction is not wrong in itself (it preserves far-field total power) — it
is papering over the real defect: `collectEmitters` fits ONE light to a mesh
holding dozens of separate bulbs. **Fix: split a sparse emissive mesh into spatial
clusters, one emitter per cluster at fill ≈ 1.** Needs no authoring change from
the user. NOT IMPLEMENTED — this is the top remaining emissive item.

### ⛔ "SMALL EMISSIVE OBJECTS DON'T EMIT" IS NOT A GI BUG — IT IS THE UNITS

User report after the delivery gate went green. `npm run test:gi-emitter-size`
runs the two sweeps that separate a transport bug from physics, with tone mapping
OFF and the readback linearized (AgX at a 0.65 mean would compress a real falloff
into a fake "reach cutoff"):

**Sweep A — radius at MATCHED TOTAL POWER** (radiance scaled by `(r₀/r)²` so
`π·A·L` is constant, confirmed by the ledger reading `P=4.7e+0` on every arm):

| radius | strength needed | delivered | vs r=0.2 |
|---|---|---|---|
| 0.2 m | 3 | 3.269e-2 | 1.000× |
| 0.1 m | 12 | 2.977e-2 | 0.911× |
| 0.05 m | 48 | 2.909e-2 | 0.890× |
| 0.025 m | 192 | 2.891e-2 | **0.885×** |

**Sweep B — falloff at r=0.05** out to 1.6 m is NOT steeper than inverse-square,
so the plan's E2 suspect (a reach/cutoff derived from geometric radius) is
CLEARED. ⚠ Only the low side of that ratio is a verdict — an enclosed room with a
wide crop is shallower than 1/d² by construction, so the measured 3.3–6.2× is
expected and is not evidence of super-physical reach.

**The finding:** the transport delivers small emitters correctly (0.885× at 8×
smaller radius). Look at the STRENGTH column — holding delivered light constant
took **3 at r=0.2 and 192 at r=0.025, a 64× authoring difference**, because
`strength` is RADIANCE and `power = π·area·radiance` falls with the square of
size. A bulb-sized mesh at a panel-sized strength is asking for a light two
orders of magnitude dimmer, and nothing told the author that.

**Shipped:** an `[gi] emitter SCALE hint` line that names the smallest emitter,
its power deficit, and the strength it would need for parity — verified live
(a 0.05 m bulb at strength 20 among 0.15 m decoys at 200 correctly asks for
~1.8e+3; area ratio 9.0 = strength ratio 9.0). `__giLogEmitterScaleHint = false`
silences it.

⚠ **DELIBERATELY A DIAGNOSTIC, NOT A CORRECTION.** Rescaling emission by area —
so `strength` means power and a small mesh is as bright as a big one — is the
authoring affordance people expect from other engines, and it is a ONE-LINE
change here. It is not made because it changes the look of every scene already
authored against the current meaning. **That is a product decision for the user,
and it is the open question this section leaves.**

### ⛔ S1's DENSE RING IS NOT BUILDABLE. The torus belongs on the KEY.

Priced in `run-gi-src-worldkeys-test.mjs` case 0, at s₀ = 0.35:

- c0/L0 alone: **16,777,216 cells to hold ~16,000 live probes — 1,049× waste.**
- all 40 (cascade, LOD) levels: 191,692,800 cells = **5.71 GB** of probe records
  and **338 GB** of direction bins.

A probe population is a **2-D manifold** (visible surfaces) inside a 3-D
lattice; a dense ring pays for the third dimension and gets nothing back. This
is the same arithmetic as §12.16 (0.24% of allocated bins ever sampled, 604 MB
against a 128 MiB limit) — the plan's own rejected-alternatives section names
that wall as the reason not to grow the hash, and the dense ring walks into it
from the other side. The plan's "32³ ring at 1 m covers 32 m" sketch is also
inconsistent with `LOD0_REACH = 64`: c0/L0 needs 256 cells per axis at s₀, not 32.

**What shipped instead — world-absolute keys.** Every property S1 wanted comes
from probe IDENTITY being a pure function of the world cell. That does not
require STORAGE to be indexed that way, so the hash stays sparse and the memory
stays honest. The 9-bit cell field now holds `worldCell mod 512` instead of a
cell relative to a camera-following anchor:

- **The re-anchor is gone.** `worldCellAt` = `round(anchor/s)` + `round((p −
  round(anchor/s)·s)/s)` ≡ `round(p/s)` for any integer origin cell, so the key
  does not depend on where the anchor is. The anchor keeps only its numerical
  job (holding the f32 division camera-relative — trap 4 in `srcMathTsl`) and may
  now follow the camera every frame at zero cost. `REANCHOR_CHEBYSHEV`, the
  cold-guard re-arm and "wholesale history loss on long moves" are unreachable.
- **The alias is unreachable by construction.** Live span on one axis at LOD L is
  `2·lodRadius(L+1)`; the key repeats every 512 cells of that level's spacing;
  period/extent = **2·2^cascade ≥ 2**. Asserted over all 40 pairs, not argued.
- **No cell is ever unrepresentable.** `packProbeKey` used to return EMPTY past
  ±256 cells — a probe that silently does not exist, the "lights fine at spawn,
  goes flat after a walk" failure. A toroidal window cannot produce it.
- **A 100 m teleport renumbers ZERO surviving probes** (101,484 (point, cascade,
  LOD) triples checked). Today's keying renumbers all of them past 64·s₀.

Gates: `test:gi-src-worldkeys` (8 cases, all pass, pure Node — these are claims
about integer arithmetic and should not need a browser). Live parity on the
shadowed-bulb rig, three ways — shipped **0.64866**, world keys **0.64930**
(+0.10%), world keys + retention **0.64952** (+0.13%). That is the LOD-boundary
tolerance class `test:gi-src-math` already documents, and it is the check that
matters most for retention: a held payload could have inflated delivered energy,
and it does not.

### ✅ AND LOCALITY RETIREMENT, which is what the symptom was actually about

World keys are the enabler; this is the unit that moves the picture. The shipped
rule retires a probe `PROBE_MAX_AGE` frames after the last PIXEL looked at it, so
turning the camera deletes the neighbourhood behind you along with its payload.
Retirement is now keyed to **locality** (is the probe still inside the shell its
LOD serves?) while visibility keeps deciding only who gets RAYS — which was
already right, since `srcRays` budgets off `pixelProbe`, so a retained probe costs
storage and nothing else.

**Two bounds, both load-bearing.** `outOfReach` retires immediately regardless of
age (which is also what keeps the ±256-cell alias proof true rather than merely
likely). `crowded` falls back to the visibility age above 60% of slot capacity —
retention grows the population from "visible surface cells" to "every surface cell
in the neighbourhood", and a failed insert is a probe that DOES NOT EXIST, which
is strictly worse than a cold one.

**The companion nobody would guess: the decay had to be frozen.** The decay pass
multiplies every allocated bin by `keep` every frame, so a probe held for a second
comes back holding `keep^60` — black. Retention alone would hold a slot whose
payload had faded, turning an absence into a DARK VOTE, which is exactly what R1
forbids. A sixth per-block region (`blockHeldBase`) carries a hold stamp and the
decay reads `keep = 1` on it. ⚠ The stamp keys on **visibility**
(`PROBE_AGE == 0`), NOT on "did it get rays": under the ray stride a *visible*
probe gets rays only every S-th frame and the decay is deliberately the S-th root
so the product over S frames is `1−α` (§12.23) — freezing on ray count would decay
visible probes S times too slowly and un-calibrate every temporal number in §12.

`npm run test:gi-spin-retention` — 360° spin in 90° steps, then a 100 m teleport
and back, three arms (shipped / world-keys-only / retention) so a win cannot be
attributed to the wrong half:

| arm | mean dip | mean recover | held↑ | FAILED↑ | reanchors |
|---|---|---|---|---|---|
| shipped | −33.7% | 720 ms | 0 | 0 | **3** |
| retain | **+6.6%** | **120 ms** | **1299** | 0 | **0** |

Per-pose, the shipped arm's 180°/270° turns and the teleport return show −64%,
−67% and −82% transients taking 1.26–1.62 s to settle; the retention arm's worst
is 11.0% settling in 180 ms. `held` climbs 433 → 866 → 1299 as the camera turns
(the neighbourhood being kept instead of churned) and `liveC0` accumulates
433 → 1732 and stays, where the shipped arm sits pinned at 1237. Zero re-anchors
across the 100 m teleport, against three for the shipped arm.

⚠ Confound to know about: the two arms booted at different gbuffer sizes (51,813
vs 78,780 px), so absolute `settled` luminance is NOT comparable across arms. Every
statistic above is within-arm (dip and recovery are relative to that arm's own
settled value), which is why the gate is written that way. Re-run with a pinned
resolve size before quoting cross-arm energy. Also `fresh↑` reads 0 on both arms —
`COUNTER_FRESH` is not surviving the `readPressure` path; harmless here (`held` and
`live` carry the finding) but it is a broken instrument worth fixing.

⚠ **ALL OF THIS IS OFF BY DEFAULT** (`__giSrcWorldKeys = true` opts in;
`__giSrcProbeRetain = false` disarms retention within it), as the plan requires.
Before the flip: `srcRef.js`'s mirror and `srcGizmos.js` are NOT converted (both
gate/debug-only, and the CPU suites run with the hatch down); S1 gate 1's
bit-comparable parked-camera arm has only been run as a luminance mean, not a
pixel diff; and gate 3's "no frame > 2× median" freezeless assertion is not
measured — the spin rig reports recovery, not frame times.

### ✅ S2 — seats retired as a delivery path

The plan gated this on "after Phase E proves delivery", and the shadowed-bulb rig
is that proof, so it went in. `#chooseEmitterSeats` no longer scores by
`power/d²` to the camera; it scores by RAW POWER, so seat identity is a property
of the SCENE and the `#checkFingerprint` camera-cadence re-rank is skipped
entirely (it could only re-derive a constant). Seats change only when the scene
does — a lamp dimming, spawning, despawning.

`npm run test:gi-seat-churn` — 12 static lamps (past MAX_EMITTERS), 48-step
orbit, **full delivery armed on BOTH arms**:

| arm | seat flips | same-pose jitter | worst | energy |
|---|---|---|---|---|
| follow (shipped) | **12** / 48 | 6.626e-4 | 2.652e-3 | 0.58300 |
| anchored (S2) | **0** / 48 | **4.973e-4** (0.75×) | **1.779e-3** | 0.58228 |

The follow arm's seat trail shows the churn directly:
`208,226,206,228 → 208,210,206,228 → 208,210,206,212 → …` — continuous turnover
across the lap. Energy ratio 0.999, so it is the same picture.

⚠ **`__giEmitterSeatsFollowCamera` exists ONLY so this A/B can be honest.** The
obvious control — tile cut off vs on — also changes what the un-seated lamps
deliver, so a jitter delta would be confounded with an energy change. Both arms
here run full delivery and differ in the seat policy alone.

⚠ **The jitter statistic took two attempts, and the first one lied.** Measuring
`|Δlum|` between consecutive ORBIT STEPS reported ratio **1.00** — which reads as
"S2 buys nothing" and was the instrument failing: moving the camera changes the
crop's content, and that swamps any temporal effect by ~60×. Holding the pose and
sampling twice removes it. Anyone re-measuring flicker during movement in this
module should hold the pose.

**Honest size of the win:** seats owned about **a quarter** of the same-pose
temporal instability on this rig (25% mean, 33% worst), not all of it. The
mechanism is gone and it cost nothing, but if flicker during movement is still
visible after this, the remaining three quarters are elsewhere — §12.63's flicker
instruments are the next place to look, not the seat code.

### Shipped from Part 2's ship-first list

- **B1** — pool sizes and the surface-pool hint persist per project+scene in
  `engine.prefs`. Boots stop re-climbing `700000→1400000→2800000`, and the
  surface hint's **forced ~20 s rebuild is not re-paid every boot**.
- **B2** — a pool grow no longer runs the whole resize path. It used to poke
  `screen.width = 0` to defeat the tolerance check, which bought the store swap
  *and* a fresh `createGiTargets` for every target at the size it already was —
  zeroing the §12.65 irradiance history, the emitter-shadow history and the
  light-shadow history. `#rebuildSrcProbesForPools` swaps the store, rebuilds only
  the resolve (it genuinely binds the store's buffers), and leaves every target
  and its history alone.
- **B3** — the surface-pool hint is compared against `SURFACE_POOL_CEILINGS`
  (now exported) BEFORE the forced rebuild. At the ceiling the hint is clamped
  and the stall is refused once, out loud, naming the lever that works (demand,
  not supply). This is the `forced rebuild 1/2` line the user saw every ultra boot
  — a ~20 s stall that allocated exactly what was already there.

---

Plan for the next session. Supersedes `GI_BUGFIX_HANDOFF.md` (its A1 ran and
confirmed density; its bug-A section is folded into Part 2 here). Everything
below carries its receipt from the 2026-08-17 session; nothing is theory
unless marked HYPOTHESIS.

**State as of writing:** scene is on `quality: "high"` (user may revert — it
was set for the A1 test and it does mask the record-pool starvation). The
slide/ray-cap fix is VERIFIED live (slides no longer arm the light-track
window; `armed by none, open 100%` lines are gone). Merge-refusal for
emissiveNode is live and costs 448 draw calls (504→952, gbufferPrepass
5.6→10.5 ms) — Part 1 E6 is the fix-forward that recovers them. Pools still
reset to floors every boot. User-visible state: black patches lag the camera,
light flickers on movement, fps halves on movement, emitters deliver ZERO.

**Method rules (each cost a wrong verdict this session):**
- Screenshot `camera:"game"` at the user's pose. The editor camera hid the
  bug twice.
- Instruments over theory: `dropped N inserts`, `deposit noBlock`, emitter
  ledger `fill/rgb/P`, light-track `open %`, `surface records …/…`.
- ZERO output is a severed path; a scaling bug still scales. The user proved
  emitters sit in shadow at 10,000 strength with no visible contribution —
  do not spend another round on radiance math until delivery is proven.

---

## Part 1 — Phase E: emitters deliver nothing

### The finding

`#isNeeEmitterMesh` (GISystem.js ~8459) returns true for **every tree
candidate** while `__giSrcLightTree` is armed (default ON), and three sites
zero those meshes' emissive on that answer: `#slotSurface` (~8510, the
field/voxel surface), the analytic-only occluder spheres (~10438), and
`isPromotedEmitter` for the dynamic set (~9881). That is R5/W5b working as
designed — an emitter the transport samples must not also emit on contact.

So all 95 emitters have field emission ZEROED, on the promise that the tree
delivers instead: [J] NEE in transport + the W4b per-pixel tile cut on
screen. The boot warning "analytic slots cover the 4 most apparent — the
rest emit through the field only" is **false under an armed tree** (the
field path it names is the thing R5 deletes) — fix the text when the rest
is fixed. If tree delivery fails for the 91 un-seated emitters, they
contribute exactly zero, which is exactly the report.

### E0 — confirm the severed path (one boot, no code)

Boot with `__giSrcLightTree = false` **and** `__giEmitterTileCut = false`
(⚠ W5b: the hatches are coupled — flip BOTH, the build warns if the cut is
armed alone; every rig this session learned this the hard way). Bulbs light
via restored field emission ⇒ R5 zeroing over dead delivery is confirmed and
Phase E is a delivery hunt. Bulbs still dark ⇒ stop, the bug is upstream of
delivery (go to E1 first).

### E1 — the intensity question (D1), settled by ledger

`resolveMaterialSurface` (voxelizeOnce.js): when `emissiveNode` folds to a
constant, `emissiveIntensity := 1` — assuming the node premultiplies. Engine
materials may carry strength in a uniform the folder cannot see, in which
case authored strength is DISCARDED. Test without code: set the café bulb
to strength 100, rescan, read its ledger line; then 10,000, rescan, read
again. `rgb` must scale ×100. If it does not, fold the material's intensity
into the resolved constant (only when the fold didn't already include it —
check the uber material's emissive graph shape before writing). This bug
would ALSO cap tree-NEE energy, so fix it regardless of E0's outcome.

### E2 — stage-walk the delivery (only if E0 lit the bulbs)

Instrument at the café pose, bulb 0.5 m from a wall:
1. Is the bulb's id in its own pixel-tile's cut list? (`EXTRA=` dev globals
   in `run-gi-emitter-scale.mjs` already decode lists.)
2. Is `emitterShadowPass` dispatching, and is the bulb's shadow channel
   nonzero at those pixels? ⚠ Memory records a §12.56-family race where
   `_emitterInfos` settles empty and shadow targets FAIL CLOSED (all-zero
   shadow × direct = zero everywhere) — check dispatch gating for the
   un-seated pseudo-slot path specifically.
3. Is the resolve's `emitterDirectAt` term nonzero there (debug view)?
Fix at the first failing stage. Candidate mechanisms, in order: fail-closed
shadow for pseudo-slots; reach/cutoff derived from geometric radius so a
0.05 m emitter is range-capped regardless of power (make it power-derived:
reach to where P/(4πd²) < ε); tile-cut ranking artifacts.

### E3 — the un-merge was necessary but not sufficient; make it free (E6)

Merging no longer welds emissive meshes (correct for fitting — fill went
0.001 → 1.0) but costs 448 draws on a CPU-bound scene. Fix-forward:
**`collectEmitters` walks pre-merge member meshes** (`proxy.members` /
`userData.mergedInto` both exist) and skips proxies — merged drawing, per-
member emitter fitting. Then REVERT `emissiveRefusal` in merging.js and
retarget the new gate case in `run-merging-test.mjs` (it currently asserts
refusal; it should assert per-member emitters from a merged group).

### E4 — gates

- Existing: `test:gi-lighttree-nee` (parity 4-lamp), `run-gi-emitter-scale`
  N=12 (⚠ set BOTH hatches explicitly on BOTH arms — post-flip they no
  longer discriminate otherwise), `test:merging`.
- NEW, the user's exact case as a rig: one small emitter (r≈0.05 m,
  authored strength ≥1000) in full shadow, a neutral patch 0.5 m away —
  gate on patch luminance ≫ noise vs an emitter-off arm, at BOTH hatch
  settings. This is the gate that would have caught R5-over-dead-delivery
  the day it shipped.

### E5 — stopgap if the delivery fix runs deep

Make the zeroing honest instead of hopeful: zero only emitters with a
PROVEN screen path (the 4 seats + ids verified present in tile lists), let
the rest keep field emission. Double-lit is a lesser evil than unlit; note
it in the console line.

---

## Part 2 — Phase S: the world-anchored rebuild ("the spatial problem")

### Requirement (user's words)

Camera may move fast, move a lot, move far. Handling must be fast,
seamless, freezeless.

### Why the current architecture cannot meet it

Every failure this session traced to one root: **GI state is keyed to what
is on screen right now.**

| Mechanism (receipt) | Consequence |
|---|---|
| Probes exist per visible pixel, retire when pixels leave; hash full at floor (`dropped 12467 inserts (16384/16384)`) | Turning the camera destroys a warm cache and cold-starts a new one at α≈0.02 → black patches that "cannot keep up" |
| Pool growth doubles/demand-sizes ON PRESSURE, and every grow REBUILDS the probe store; pools reset to floors each boot | unlit→lit flashes, "GI restarts", boot re-pays the ladder |
| Re-anchor re-keys every probe past 64·s₀ drift (`REANCHOR_CHEBYSHEV`) | wholesale history loss on long moves |
| Bins cannot back the slot ceiling (131k c0 → 16.8 M bins ≈ 604 MB vs 128 MiB binding limit; block-backed cap 21,875) | growth can never catch this scene — the wall is architectural |
| Emitter seats ranked `power/d²` TO THE CAMERA, re-ranked on move | light pops/flicker during movement |
| Detail box slides armed the light-settle window (FIXED: `_giSlideHeld` split — keep this pattern) | was the 3.8× deposit cost on every walk |

### S1 — toroidal clipmap probe store (the core swap)

Replace hash + freeStack + re-anchor with a **fixed-footprint, camera-
centred, world-anchored ring buffer** per cascade:

- Probe index = `worldCell mod ringSize` (toroidal). A probe's storage slot
  is a pure function of its world cell — no insert, no hash, no failure
  mode, no retirement of survivors, no re-anchor EVER.
- Camera movement re-purposes only the strip of cells that wrapped:
  O(strip), not O(population). A fast pan touches a bounded strip per
  frame; survivors keep payload and history untouched.
- Memory is fixed at build from the tier: `ringSize³` probes, `ringSize³ ×
  binCount` bins, sized once, **growth deleted as a concept**. (Today's
  c0 live ≈ 14–16k on this scene; a 32³ ring = 32,768 cells at 1 m spacing
  covers a 32 m radius neighbourhood — do the sizing pass against measured
  live counts per cascade before fixing ringSize.)
- RAYS stay screen-driven (visibility decides who gets rays this frame —
  that part of SRC is right); STORAGE becomes locality-driven (a probe that
  leaves view keeps its payload until its cell wraps out of the ring).
- Teleports/far moves: the whole ring re-purposes over a few frames under a
  per-frame strip budget (~2 ms); the §13 F3 far-field constant (already
  shipped, already the out-of-box answer) covers unfilled strips — the
  cover story exists, use it.
- Cascades already space 2× apart — keep them as concentric rings (fine c0
  near, coarse far), far field beyond the last ring = F3.

What survives verbatim: gather/merge/deposit kernels (they address probes
by index — the index derivation changes, the payload layout need not),
tiles atlas, [J], the screen chain, F1/F2/F3 (the slide becomes trivial:
the ring IS the slide), the `_giSlideHeld` α-floor pattern for uncovered
strips.

### S2 — emitters go fully world-anchored (after Phase E proves delivery)

The light tree is already world-anchored and live-refreshed (W5a). Once
tile-cut delivery is verified for all N (Phase E), retire the camera-ranked
4-seat promotion (`#chooseEmitterSeats` churn = the flicker) — seats become
at most a cache, never the delivery path, and seat re-ranking stops touching
the image.

### Ship-first interim units (kill the visible symptoms while S1 is built)

- **B1** persist grown pools + `_surfacePoolHint` per project+scene
  (`engine.prefs`); boots stop re-climbing (today: `700000→1400000` again
  every boot).
- **B2** hold the previous irradiance texture through a probe-store rebuild
  (targets are persistent) — no unlit flash.
- **B3** when the surface-pool hint exceeds its ceiling, clamp + log once,
  never force a rebuild that cannot succeed (`forced rebuild 1/2` fires
  per boot at ultra).

### Gates for S1

1. Parked static camera: bit-comparable image vs the hash arm (hatch
   `__giSrcClipmap`, keep the old store for A/B through the whole phase).
2. 360° spin: ZERO survivor retirements (counter), luminance recovery time
   vs today's — measured, expect ×N.
3. 100 m teleport: full refill under budget with no frame > 2× median
   (freezeless is a GATE, not a hope).
4. Memory: exactly fixed across a 5-min walk (no grow lines in console).
5. Rigs to reuse: `run-gi-volume-follow.mjs` (dolly + luminance-in-page),
   flicker instruments from §12.63, `run-gi-emitter-scale` for delivery.

### Alternatives considered and rejected

- Grow the hash + persist pools: dies on the 604 MB bin wall; re-anchor
  churn remains; growth rebuilds remain.
- Keep hash, add LRU retention for off-screen probes: halves the symptom,
  keeps insert failure, re-anchor, and growth — three of the four
  mechanisms survive.

---

## Cleanups to carry (small, do opportunistically)

- Fix the "emit through the field only" boot warning text (false under
  armed tree).
- `AttributeNode: uv not found` spam — the attribute-set group key exists;
  find the one straggler.
- The 7.2 GB jsHeap reading (fresh boot showed 1.9 GB — session growth, not
  static): park 60 s, measure slope; earlier session recorded +20 MB/s idle.
- `quality` back to user's choice once S1 lands (high is currently masking
  record-pool starvation at ultra).
