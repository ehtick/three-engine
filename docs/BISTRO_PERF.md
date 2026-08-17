# Bistro: why it crawls, and what was actually wrong

---

# ✅ 2026-08-17: THE MERGE WAS PAYING FOR SOMETHING IT DIDN'T NEED

**The headline: merging was copying textures to solve a problem most of the
scene didn't have.** Bistro's main pass submitted **484 draws over 161 distinct
materials** — one material drawn 40 times, the next 27, then 21, 19, 17, 16.
Those meshes did not need a shading table. They needed their vertex buffers
concatenated.

| | before | after | |
|---|---|---|---|
| CPU frame | **54.0 ms** | **28.2 ms** | 1.9× |
| — `preRender` (GI per-frame) | 25.5 ms | 7.5 ms | 3.4× |
| — `renderEncode` | 23.1 ms | 20.7 ms | |
| — `merging.sync` | 3.3 ms | 1.7 ms | |
| GPU frame | 14.0 ms | 10.0 ms | |
| fps | 19 | 29 | |
| **main pass draws** | **484** | **88** | **5.5×** |
| total draws | 985 | 655 | |
| **merge texture arrays** | **611 MB** | **42 MB** | **15×** |
| **jsHeap** | **5.4–6.8 GB** | **2.45 GB** | **2.8×** |
| GI placements | 1020 (**252 unseated**) | 489 (0 unseated) | |
| pipelines compiled at boot | **564** (980 s summed) | **99** (100 s summed) | 5.7× |
| GI material compile wave | 15.3 s | 2.4 s | 6× |

Measured on `GAME/scenes/Test.scene`, RTX 4070, viewport 1344×744. ⚠ GI quality
drifted between captures (other sessions were attached to the same editor), so
treat the GI-side rows as directional; the draw and memory rows are not
quality-dependent.

## 1. Same-material merging — the merge that costs nothing

`uberIncompatibility` answers "how do I draw N meshes with N DIFFERENT materials
in one call", and its answer is expensive: copy every source texture into an
array (pure ADDITION — the originals stay resident for the hidden members), mint
a new `Uber(n)` material, and have GI compile a fresh shader variant for it. It
also refuses any material with a custom node, an emissive map or an AO map —
which on an imported PBR scene is most of them.

**None of that applies when the members already share one material instance.**
There is no table to build, no texture to copy, and no new material to compile:
the proxy is handed `members[0].material`, the identical object. The material's
own complexity becomes irrelevant, because it is never inspected.

`#buildGroup` now takes a free path whenever the group resolves to exactly one
distinct material, and `#collectGroups` prefers that keying whenever a material
is shared by `MIN_GROUP_SIZE` meshes or more. On Bistro: **119 of 122 groups**
went free on the first boot with it.

⚠ The trade is deliberate and not close. Ten meshes of material A and ten of B,
all four texture slots matching: uber merges the lot into ONE draw for ~100 MB
plus a compile wave; same-material produces TWO draws for nothing. One extra
draw call against a hundred megabytes is not a trade worth making.

Two things survive as refusals: **emissive surfaces** (GI promotes an emissive
mesh to an emitter keyed on the mesh, so merging two moves the light) and the
**attribute set**, which is now part of the group key — `mergeGeometries` keeps
an attribute only when EVERY member has it, so one uv-less mesh silently
stripped uv from the whole merge. That is where `THREE.AttributeNode: Vertex
attribute "uv" not found` was coming from.

## 2. The locality split refused to merge small objects at ANY distance

Same-material merging alone left the main pass at 571 draws with one material
still drawn **31 times** — with every gate passed and the merge eligible.
`#splitByLocality` had already diced those meshes into singletons.

Its cell was sized from the MEMBERS' mean radius (`meanRadius * 6 * 0.8`). A café
chair has a mean radius of ~0.4 m, so its cell came out at ~2 m — and forty
chairs down a 115 m street landed in forty different cells, every one below
`MIN_GROUP_SIZE`. **The rule scaled the wrong way**: small scattered props are
the cheapest and most numerous thing to merge, and they were the only thing it
could never merge.

The cell is now `max(member-relative, sceneDiagonal / MAX_LOCALITY_CELLS_PER_AXIS)`.
Room-sized scenes keep the old behaviour exactly (their diagonal is small, so the
floor never binds); a city gets ~19 m chunks, which is what a chunked renderer
would do anyway. Culling cares about the proxy's bound relative to the SCENE, not
relative to its members.

⚠ **`#splitByLocality` and `#buildGroup`'s backstop must read one allowance**
(`#mergeRadiusAllowance`). When they disagreed, the split diced groups precisely
so the backstop would reject them — 866 meshes once died that way.

### ⛔ AND THEN THE GROUPS GOT TOO BIG — the black patches

Letting groups grow properly immediately broke something one module over. User
report, on the live scene: *"when I start moving the camera, there are black
patches in some area, that starts filling with light, or turning black again as I
move the camera around."*

```
[gi] bvh: skipping "Merged(4)" (166676 tris > 150000 bvh cap)
[gi] surface records: 2036452/2097152 claimed, triangles 4241682/2097152,
     300306 dense cells exceed the per-cell exact-triangle limit
```

**A merged proxy is ONE object to every system downstream** — one frustum cull,
one entry in GI's reflection BVH, one occupancy slot, one surface-record owner —
and those systems are budgeted PER OBJECT. The triangle pool went 2× over budget,
and cells falling back to coarse voxel-box hits went **24 701 → 300 306**.
Surfaces whose exact triangles no longer fit lose their records; which ones lose
them changes as GI's detail box follows the camera, so the starved regions move
around the screen as you fly. A 166 676-triangle proxy was also over GI's
`bvh cap` outright, silently excluding it from exact reflections and traced
shadows.

`MAX_MERGED_TRIANGLES = 120_000` now chunks an over-budget group rather than
refusing it, so the draw saving is kept and nothing downstream is handed an
object it cannot represent. It sits deliberately BELOW `MAX_TRIS_PER_BVH_MESH`
(150 000, `gi/bvh/bvhScene.js`) with headroom.

**The general lesson, and it is the expensive one: merging trades draw calls for
GRANULARITY, and downstream systems are the ones who pay.** Every per-object
budget in the engine — BVH seats, occupancy slots, surface records, cull volumes
— is denominated in objects that merging is in the business of making fewer and
bigger. A merge limit is therefore not only about memory and culling; it is about
staying representable. The failure does not look like a merging bug, it looks
like a GI bug.

### ⛔ The bug this shipped with for one boot, and what caught it

The first version measured the scene with
`setFromMatrixPosition(mesh.matrixWorld)`. **Bistro's exporter bakes every node
transform into the VERTEX DATA and leaves all 1500 matrices at identity**, so the
scene measured **0 m across**, the floor evaluated to zero, and the entire fix
was inert — the merge report came back byte-identical to the run before it.

A zero floor is indistinguishable from a floor that did not need to bind, so the
outcome alone could not say. What said it was **putting the input on the report
line**: `Scene diagonal 0m ⇒ locality cell 0m floor` on a scene whose content is
109 × 115 m. `memberWorldCenter` now transforms the geometry's bounding-sphere
centre, which works for both conventions, and is shared by every caller.

The same line now carries the reject tally on SUCCESS, not just on total failure.
It previously reported a cheerful "122 groups" while silently turning away 895
meshes; "which gate ate the rest" is the only interesting number on an imported
scene.

## 3. `profile.cpuFrame` grew sub-phases

`preRender` was 25.5 ms of a 54 ms frame and named nothing inside itself.
`StatsSystem.markSub(name)` lets a module break its own work out; `gi.*` marks
now sit inside `preRender`. First capture immediately isolated
**`gi.gbufferPrepass` at 4.9 ms** — GI's second full scene submission — against
everything else in GI's tick being under 0.2 ms.

⚠ **A sub-phase may not outlive its phase, and only `markPhase` can enforce it.**
The first build had no close on the way out (GI's tick alone has a dozen early
returns), so the last sub-phase swallowed everything after it: `gi.screenChain`
reported **22.8 ms inside a 7.5 ms parent**. `markPhase` now closes any open
sub-phase — a sub-phase larger than its parent is the one symptom that makes the
mistake obvious, which is what keeps the numbers self-checking.

## 4. The shadow map became the frame

With the main pass at 88 draws, the ranking inverted:

| pass | draws |
|---|---|
| **`ShadowMap:2048x2048#`** | **459** |
| main opaque | 88 |
| depth prepass | 87 |

**70 % of the frame's draw calls, redrawn every frame for a static street under
a static sun.** A shadow map renders from the light's frustum, so view frustum
culling does not reduce it.

`shadowFreeze.js` fingerprints what actually feeds the map — per shadow CASTER:
world matrix, geometry id, visibility, plus the shadow camera's matrices — and
sets `shadow.autoUpdate = false` while it holds still, raising `needsUpdate` for
exactly one frame when it moves. Same pattern `godraysShadow.js` established.

⚠ Returns "never freeze" on skinned meshes and morph targets: they deform in the
vertex shader, so no property the walk can read moves when the shadow should. A
miss is a stale shadow — a visible artifact that reads as a lighting bug — so the
rule is biased towards doing the work. InstancedMesh is handled via
`instanceMatrix.version` rather than bailing, because bailing on them switched
the equivalent godrays optimisation off entirely on any batched scene.

⚠ A directional light's shadow camera TRACKS THE VIEW CAMERA, so panning
legitimately invalidates every frame and the freeze buys nothing while flying.
That is correct — the shadow really does change. The win is on a parked camera.

⚠ `settings.shadow.autoUpdate === false` is an authored choice and this system
must not re-enable it. Guarded by `npm run test:shadow-freeze` (12 checks, most
of them asserting it GIVES UP rather than that it freezes).

Result: **`renderEncode` 20.7 → 9.4 ms**, draws 826 → 602, CPU tick 30.4 → 21.4 ms.
The fingerprint walk itself costs 0.67 ms/frame, which is the honest price and is
worth quoting when someone next wonders where `shadowFreeze` went in the phase
table.

### ⛔ THE ORDERING BUG, and why a screenshot caught what the tests could not

The first version marked its phase **before** `preRender`. That is wrong, and the
reason is not discoverable from `shadowFreeze.js`:

> `LightComponent` recentres a directional light's shadow camera from an
> **`onPreRender` callback** (`LightComponent.js:305`).

So before that phase the shadow camera is still LAST frame's. The fingerprint
matched, the map froze — and then the real shadow camera moved underneath it. The
map stopped being redrawn while the matrix the shadow lookups use kept changing,
which renders as **hard stair-stepped shadow edges in the wrong place**, and reads
as a GI bug rather than a scheduling one.

Every unit test still passed: the harness has no `LightComponent`, so nothing in
it moved the shadow camera between the fingerprint and the render. What caught it
was `viewport.screenshot` on the real scene. **A perf change that alters WHEN
something is drawn needs a picture, not just a number** — the numbers were all
improving while the image got worse.

The phase now sits after `debugFlush`, and the ordering is asserted directly
against the `PHASES` table (`PHASE.shadowFreeze > PHASE.preRender`), because a
reorder is otherwise completely silent.

### ⛔ AND THE SECOND ONE: never write `shadow.needsUpdate`

Shipped live and killed the tick outright:

```
Uncaught TypeError: Cannot read properties of null (reading 'depthTexture')
    at #tick (Engine.js:1019)
```

```js
// three/src/nodes/lighting/ShadowNode.js — updateBefore()
let needsUpdate = shadow.needsUpdate || shadow.autoUpdate;
if ( needsUpdate ) {
  this.updateShadow( frame );
  if ( this.shadowMap.depthTexture.version === ... )   // UNGUARDED
```

The first version signalled "render one more frame" by setting
`shadow.needsUpdate = true`. That drives the branch above on a light whose
ShadowNode has not built its map yet — `this.shadowMap` is null — and the throw
escapes `renderer.render`, so the whole engine tick dies.

**`autoUpdate` alone expresses the entire optimisation.** three's own gate is
`needsUpdate || autoUpdate`, so restoring `autoUpdate = true` asks for exactly
the same render through the path three already owns, with its own initialisation
guarantees. This system now writes `autoUpdate` and nothing else, in either
direction — and a first sight deliberately changes NOTHING, so a light is only
frozen after three has completed at least one real shadow render.

Guarded by a test that redefines `shadow.needsUpdate` as an accessor and asserts
the write count is **zero** across freeze, invalidate, re-freeze and release.
Seven checks fail if the `needsUpdate` write comes back.

⚠ The general shape, worth more than the fix: **an optimisation that switches
someone else's work off should do it through the switch that owner already
reads, not by forging the signal that owner sets for itself.** `needsUpdate` is
three's own bookkeeping — it clears it after rendering — and writing into another
module's state machine is what turned a frame-rate win into a crash.

## The settled frame, after everything above

Verified over two consecutive 150-frame captures, GI `ultra`, 1344×744:

| phase | ms | |
|---|---|---|
| `renderEncode` | 11.27 | 45.6 % |
| `preRender` | 9.85 | 39.8 % |
| — of which `gi.gbufferPrepass` | 7.45 | |
| — of which `gi.screenChain` | 2.06 | |
| `merging.sync` | 1.69 | |
| `shadowFreeze` | 1.24 | |
| **CPU tick** | **24.57** | |
| GPU frame | 13.48 | |
| draws | 656 | |

⚠ **A capture that catches a GI rebuild is not a measurement.** One 150-frame
capture reported `gi.dynamicObjects` at **43.5 ms** — six seconds of stall spread
over the window by a `src pool grow` rebuild — against 0.007 ms in every settled
capture either side of it. The sub-phase instrument is what made that legible
instead of a mysterious 53 ms `preRender`; take two captures before believing a
number, which is the same rule the top of this file already states about the
compile wave.

## 5. The moving black patches: a pool-sizing arithmetic error

User report: *"when I start moving the camera, there are black patches in some
area, that starts filling with light, or turning black again as I move the camera
around."* It is not a shading bug.

```
[gi] surface records: 1985690/2097152 claimed, triangles 4173329/2097152
     289858 dense cells exceed the per-cell exact-triangle limit
```

The record pool at **95 %**, and the triangle pool asked for **199 % of its
capacity**. A cell that cannot get its exact triangles "degrades to an occupied
box" — the documented overflow contract — and because GI's detail box **follows
the camera** (§13 F2, covering 20 % of this scene), WHICH cells lose out changes
as you fly. Regions darken and refill.

### ⛔ The ratio had been decorative on every large volume

`occupancyField.js` clamped BOTH pools with the same `1 << 21`:

```js
const COMPLEX_TRIANGLES_PER_RECORD = 1.5;
complexTriangleCapacity = Math.min(1 << 21, ... surfaceCapacity * 1.5)
```

`surfaceCapacity` is itself capped at `1 << 21`, so the moment a scene reached the
record ceiling, `2097152 × 1.5 = 3145728` was clamped straight back to `2097152`
— **the triangle pool could never be larger than the record pool**, and the
tuned constant stopped meaning anything at exactly the scenes it was tuned for.
The ceiling is now DERIVED from the ratio (`3 145 728`), a 50 % increase.

**Why it survived the sessions that tuned it: it was untestable.** The sizing was
forty lines in the middle of `createOccupancyField`, which allocates GPU storage
and cannot run headlessly. It is now `planSurfacePools`, pure arithmetic, with
`npm run test:gi-surface-pool` (8 checks; three of them fail against the shared
ceiling).

### Grow-on-pressure, deferred to the next build

The SRC pools grow reactively (`#syncSrcPoolPressure`) because their rebuild is a
probe-store swap. **This pool cannot copy that**: it lives in the occupancy
allocation, so growing it re-mints the whole chain — a ~20 s freeze on the scene
that needs it most, which is the symptom being fixed. Forcing it automatically
would trade a shading artifact for a stall, repeatedly.

So demand is REMEMBERED (`_surfacePoolHint`) and sizes the next build that
happens for any other reason. `alloc.triangles` is a DEMAND counter — it keeps
incrementing past capacity while writes are rejected — which is exactly what
makes it usable as the next size.

⚠ The hint is released on comfortable headroom (60 %), never at the first reading
under capacity: relaxing the moment demand fits hands back the very headroom that
made it fit, and oscillates between two sizes at one full GI rebuild per flip.
A grow-only hint would instead leak — the pool is sized at BUILD time, so a hint
earned by deleted content keeps allocating for it all session.

### ⛔ AND THE SAME MISTAKE, ONE LEVEL UP: the ceiling was the default

The first version of the fix derived the ceiling from
`COMPLEX_TRIANGLES_PER_RECORD`. That is the same collision again, because **the
ceiling only ever binds for scenes whose real ratio came out ABOVE the default**
— so deriving it from the default guarantees it clamps exactly the scenes it
exists to serve. Bistro's hint asked for 3 955 759 and was handed 3 145 728: the
audit line dutifully reported the pool "converging" — 1.99× → 1.32× → 1.26× →
1.14× — on a limit it could never reach.

Sponza's measured 1.21 justifies a **1.5 default**. It says nothing about the
ceiling. Bistro measures **2.09** (3 581 595 triangles / 1 712 108 records) —
genuinely denser trim, not a misconfiguration. `MAX_COMPLEX_TRIANGLE_RATIO = 2.5`
is now its own constant, and the pool allocates from the measured hint, so
Bistro moves ~113 MB → ~129 MB and Sponza-class scenes allocate exactly what
they did before (asserted).

### One forced rebuild, bounded at two

The hint sizes the *next* build, and on a settled scene there may not be one: an
auto-fit refit slides the volume in place and never re-creates the occupancy
field, so a correct hint can wait indefinitely for a trigger that is not coming
while the scene stays visibly wrong. So the audit takes the ~20 s stall
deliberately when the hint GROWS, capped at two per session — an unbounded
version is a rebuild loop on any scene whose demand genuinely exceeds the
ceiling, and each iteration costs far more than the artifact.

The measured hint also carries **15 % headroom**: demand moves with the
camera-following detail box and with what merging last committed, so sizing to
exactly what was asked converges on 1.00× and re-overflows on the next frame
that wants a little more.

### The voxel dial, still available and still the author's call

```
[gi] 128x101x128 cells is heavy (ray-march steps scale with 1/voxelSize).
     For a 47m volume, voxelSize ~0.47 is usually plenty.
```

At 0.37 m. Going to ~0.47 cuts the cell count ~2× and the triangle-cell pairs
with it — it would make all of the above comfortable rather than merely
sufficient, at some loss of GI detail.

## 6. The SRC re-anchor — REAL, but NOT the black patches

⚠ **This section was written as the cause and then refuted by a three-way A/B.**
It is kept because the mechanism is real and worth fixing on its own; it is not
what the user was seeing. The refutation, run live in the editor console:

| hatch | what it isolates | result |
|---|---|---|
| `__giAoOverride = { strength: 0 }` | ambient occlusion | no change |
| `__giIrrHistWeight = 0` | GI temporal history | no change |
| `__giShadowTemporal = false` | shadow temporal accumulation | no change |

`__giIrrHistWeight = 0` is the decisive one. If the patches were **stale or
missing history**, dropping the temporal filter makes them grainy-but-LIT. They
stayed black — so there is no radiance in those pixels at all, and a cache that
was retired is not the explanation. The user put it exactly: *"those patches just
don't have any light in them, so they show the black shadow I originally had
there."* They are sun-shadowed regions whose INDIRECT FILL is absent, which is
§5's pool overflow (cells falling back to voxel-box hits produce no bounce), not
a lost temporal history.

**Method note worth keeping: three cheap polled hatches settled in one minute
what three rounds of reading code and screenshots got wrong.** Every `__gi*`
override in `#tick` is polled per frame, so an A/B costs no reload. Reach for
them first.

The mechanism below is still live and still costs a full cache flush every ~22 m
of camera travel — it just is not the artifact that was being chased.

The console, captured while the camera was moving:

```
[gi] follow: slide … anchor 52.5,16.6 → 55.5,23.6      ← 12 slides in ~22 s
[gi] follow: slide … anchor 55.5,23.6 → 50.5,16.6
…
[gi] src probes: re-anchored (#6) — every probe re-keys, which RETIRES it
[gi] src probes: re-anchored (#7)
[gi] src probes: re-anchored (#8)
```

**Every re-anchor throws away the entire SRC radiance cache.** The scene then
re-converges from nothing: black, filling with light, exactly as reported.

### Why it re-anchors, and why the scene cannot avoid it

The probe key is 32 bits — `[4b LOD | 1b secondary | 9b x | 9b y | 9b z]`
(`srcMathTsl.packProbeKey`) — so cell coordinates span ±256 cells from the
anchor. At Bistro-ultra `s₀ = 0.35 m`, that window is **±89 m**, and the scene is
**109 × 115 m**. The scene does not fit. So the anchor MUST follow the camera,
and `srcSystem.js:83` re-anchors once the camera drifts
`REANCHOR_CHEBYSHEV (64) × s₀ ≈ 22 m` — which on a street this size happens
every few seconds of ordinary navigation.

The header at `srcSystem.js:30-46` already states the key property:

> `latticeOrigin(anchor, s) = round(anchor/s)·s` is ALWAYS a multiple of s …
> **Re-anchoring never moves a probe. It only renumbers it.** The cost is a lost
> temporal history, not a spatial pop.

**That "lost temporal history" is the artifact.** The design note treats it as an
acceptable cost; on a scene that re-anchors every ~22 m of travel it is the
dominant visual defect.

### The real fix: a re-anchor is a RENUMBERING, so renumber

Because the probes do not move, a re-anchor could rebuild the hash with the new
keys instead of discarding it — one compute pass over the live probe table
(old key → world cell → new key → re-insert), dropping only probes whose new
cell genuinely falls outside the window. That preserves the radiance history
across a slide and removes the artifact at its source.

It is a new GPU kernel plus a hash rebuild with real ordering constraints, so it
wants its own session and its own gate.

### ⚠ The cheap dial, and why it was NOT turned here

`REANCHOR_CHEBYSHEV = 64` against a window the comment says allows `254·s₀`.
Raising it to ~200 would cut re-anchor frequency ~3× for one constant.

**Not done, deliberately.** The margin has to cover the probe PLACEMENT radius as
well as camera drift, and that radius was not measured. Overshooting makes
`packProbeKey` return EMPTY for near-camera probes — and the file's own header
records what that looks like: *"GI simply stops having probes, and the symptom is
a scene that lights fine at spawn and goes flat after a walk"*, silently. A dial
whose failure mode is silent absence of GI is not one to turn on a hunch; measure
the placement radius first, then raise it with that number in hand.

## Still open, ranked

1. **`renderEncode` is now the largest phase** (11.27 of 24.57 ms) at 656 draws —
   ~17 µs per draw, which is still high. Roughly 175 of those draws are the
   visible scene, so if the cost does not track draw count the remainder is
   per-FRAME, not per-draw: three's `projectObject` walks all 1699 entities once
   per render pass, and there are three passes. Measure before assuming.
2. **GI's gbuffer prepass is a second full scene submission** and is now the
   single costliest thing in `preRender` (7.45 ms CPU). It could reuse the main
   pass's depth/normal rather than re-drawing the scene.
3. **`shadowFreeze` costs 1.24 ms** to save ~11 ms — a good trade, but it walks
   the whole scene graph every frame to do it. `merging.js` solved the same shape
   of problem with a round-robin over `WATCH_WINDOW_FRAMES`; that does not apply
   directly (the hash has to be complete to compare), but restricting the walk to
   a registered caster list would.
3. **`bvh: 488 eligible meshes exceed the 64-mesh cap — seating the first 64`** —
   still traversal order, no spatial criterion (§B below). Merging brought this
   from 1019 to 488; it is now within sight of actually covering the scene.
4. **Load is ~35 s, not 1 s.** Breakdown: ~9–22 s streaming assets, 4.1 s static
   shadow BVH, 2.4 s GI material compile, ~5 s GI setup. The compile half is
   addressable with a persistent pipeline cache; the streaming half needs the
   geometry to arrive already merged, i.e. an import-time bake rather than a
   runtime merge.
5. **`component-changed:mesh x6013` during load** — still a storm, still
   producing 2 rebuilds in 10 s. It no longer costs a compile wave (the free path
   mints no materials), which is why it stopped being the emergency.

---

Measured 2026-08-16 on `GAME/scenes/Test.scene` (Amazon Lumberyard Bistro,
1699 entities, ~2.45 M unique triangles), RTX 4070, WebGPU, viewport 1302×618.

## THE HEADLINE: it was never a rendering problem

| | CPU ms | GPU ms | verdict |
|---|---|---|---|
| first reading (mid compile wave) | **418.9** | 25.07 | — |
| settled, scale 0.1, GI off | 8.44 | 2.07 | 112 fps |
| settled, scale 1.0, GI medium | **30.25** | 10.32 | **CPU-bound 3×** |

**The GPU is idle and the CPU is the ceiling in every configuration.** That is
why turning off shadows, GI and postprocess did not help — none of them are on
the critical path. `profile.frameStats` said so from the first call and nothing
in the module was looking at it.

### The instrument that was missing

The GPU side of a frame had two profilers (`profile.giPasses`,
`profile.renderPasses`). The CPU side had **one aggregate number**, `cpuMs`, so
every question about where the tick went could only be answered by subtraction —
and [[PERF_2X_PLAN]] records three sessions lost to exactly that mistake ("an
instrument's omissions read as zeros, and zeros read as innocence").

**`profile.cpuFrame` now exists** (`src/editor/api/ops/profile.js`, marks in
`Engine.#tick`, accumulators in `StatsSystem`). It reports mean ms per engine-tick
phase over a multi-frame capture, plus `bound: "cpu" | "gpu" | "balanced"`.
Disarmed it costs one boolean test per phase; nothing on the hot path allocates.

⚠ Adding a phase means adding it to `PHASES` **and** marking it in `#tick`. An
unmarked phase does not show as zero — it silently folds into the phase before
it, which reads as innocence for whichever phase took the blame.

### Where the 30 ms goes (settled, scale 1, GI medium, 850 draws)

| phase | ms | % |
|---|---|---|
| **renderEncode** — WebGPU command encoding | **16.09** | 51.1 |
| **preRender** — GI's per-frame CPU work | **13.02** | 41.3 |
| merging.sync | 1.91 | 6.1 |
| everything else (scripts, culling, LOD, audio…) | 0.49 | 1.5 |

~19 µs per draw call. The frame is spent *submitting geometry twice* (main pass
plus GI's full-res gbuffer prepass, which renders the whole scene through
`scene.overrideMaterial`) and running GI's per-frame setup. Both scale with
**draw count**, which is the one lever that matters here.

---

## FIXED THIS SESSION

### 1. The §12.56 watchdog was a thundering herd — load time 89.4 s → 15.8 s

`[gi] compile wave: materials warmed safely in **89414ms**` … four waves per
boot, and `SLOWEST PIPELINE: #49 [src#43] took 27.6s of **3366.3s summed over
591 pipelines**` — for a module that has **70 kernels**.

The watchdog re-rolls a `createComputePipelineAsync` that never settles. Its
gate is two-part, and its own comment states the assumption:

> during a healthy boot wave settles land constantly, so queued-behind-others
> never trips this

**On Bistro that assumption inverts.** Its SRC kernels reach 155 kB of WGSL and
single pipelines legitimately take 20–27 s, during which the driver is working
flat out and *nothing settles*. "Driver quiet for 6 s" stopped meaning "wedged"
and started meaning "busy". Worse, the gate is evaluated **per pipeline**, so it
passed for all of them at once — the console shows `src#16` … `src#56` plus
`gi:unnamed`, **41 pipelines re-rolled inside a single millisecond**, all stamped
`14:27:56.272Z`. Each duplicate compile kept the driver busier without settling
anything, which re-armed the gate and earned attempts 2, 3 and 4.

A positive-feedback loop: **70 kernels → 591 compiles**, and the scene never
finished loading. This is what "with GI on, the editor is just hanging" was.

Three changes, all in `giMaybeRerollPipeline`:

- **A self-expiring lease, one re-roll in flight globally.** ⚠ It is a
  *timestamp*, not a boolean — the failure this subsystem exists for is a promise
  that never settles, so a boolean lock would be taken once, never released by
  its `finally`, and the watchdog would be dead for the life of the page: a
  silent permanent version of the very wedge it heals.
- **The window is adaptive** — `max(retryMs, giSlowestSettledMs * 1.5)`. A fixed
  6 s encodes an assumption about how fast this machine compiles this scene's
  shaders. Only *successful* compiles widen it; a re-roll's own latency would
  ratchet the window up on the strength of the storm it is meant to prevent.
- Small scenes keep the old 6 s behaviour exactly (the floor).

Result: **compile wave 89414 ms → 15797 ms, and zero watchdog warnings.**
Guarded by `npm run test:gi-watchdog` (4 tests; the herd test fails loudly
against the old code).

### 2. Merging re-rasterised the whole scene six times per load

```
14:42:07  no groups formed — 3064 mesh entities considered
14:42:13    7 groups →   8 MB of texture arrays
14:42:14   49 groups → 217 MB
14:42:18   94 groups → 514 MB
14:42:24   99 groups → 581 MB
14:42:31  108 groups → 629 MB
```

~2 GB of texture-array allocation churn in one load, five sixths of it thrown
away seconds later. `SETTLE_MS` is supposed to collapse a load into one merge;
`MAX_DEFER_MS = 2000` overrode it every two seconds for the whole 30 s load.

`MAX_DEFER` exists for a scene that never goes quiet **at a stable size** (an
animated transform). A scene still **streaming in** is the opposite case —
waiting is exactly right, because every mesh that has not arrived yet forces the
merge to be redone. The two were indistinguishable.

⚠ **Entity count is the wrong discriminator** (tried first, and wrong): a
`.scene` file restores all 1699 entities at once and streams *geometry* in behind
them, so entity count is flat for the entire load. `#readyMeshCount()` counts
what `#collectGroups` would accept past its "mesh not built yet" gate — the
number the report line actually moves (3064 → 2938). While it moves, the deferral
clock is pushed forward, bounded by `MAX_LOAD_DEFER_MS = 60 s`.

### 3. merging.sync cost 1.9 ms/frame on a scene that never changes

Both watchers swept **every group every frame**: 1023 member matrices compared
element-by-element, plus a `materialSignature()` per merged material — and that
signature is a **joined string**, so the sweep also allocated ~200 short-lived
strings per frame on a scene already fighting its heap.

Now amortised round-robin over `WATCH_WINDOW_FRAMES = 4`. Nothing can be missed —
the cursor visits every group in order and both checks compare against cached
state that does not expire. Neither is latency-critical: a moved member is
already drawing in the wrong place when noticed, and the rebuild it triggers
costs far more than 4 frames.

### 4. GI auto-fit pruned merged meshes (latent)

`#autoFitAabb` skipped any mesh with `visible === false` unless it carried
`batchedInto` or `cameraHidden`. Static merging hides its members with
**`mergedInto`**, which was not in that list — and `selectionOutline.js:395`
tests both flags, so the two disagreed.

⚠ **The asymmetry with `#collectMeshes` is deliberate and must be kept.** That
walk covers the whole scene, so it picks up the scene-root merge *proxies* and
must keep skipping the members or every merged triangle is counted twice.
`#autoFitAabb` walks only the GI component's own entity subtree, which the
scene-root proxies are not in — pruning members there removes geometry with
nothing to replace it.

**Honest scope:** this did not explain the volume actually observed. The 0.1
scale did (below). It is a real latent bug, fixed, but it was not the cause.

---

## NOT FIXED — the real ceilings

### 0. ✅ THE HANG: FOUND AND FIXED — `MeshComponent` resurrected merged members

**Root cause, confirmed by the instrumentation below rather than by reasoning:**
`[merging] 51 group(s) … [rebuild #27, asked for by component-changed:mesh]`,
then `#28`, with a GI rebuild and a compile wave between them.

`batching.js` and `merging.js` both hide their members (`visible = false`), leave
them in the scene graph, and mark the claim with `userData.batchedInto` /
`userData.mergedInto`. **Six places in `MeshComponent` wrote `mesh.visible`
directly**, with no knowledge of that claim. The one that fired constantly is
`#applySharedMaterial`, which runs on **every `.mat` asset notification** — it
un-hid the member (so its geometry drew twice, once as itself and once inside the
proxy) and then called `#announceSwap`, emitting **`component-changed:mesh`**,
which is exactly what `merging.js` invalidates on.

The cycle:

1. A material notification un-hides a merged member and emits
   `component-changed:mesh`.
2. Merging invalidates and rebuilds.
3. The mesh set GI collects flips between proxies and members — **GI built at 580
   meshes, then at 1034 on the same scene** — so its geometry revision bumps.
4. GI runs a full rebuild and a material compile wave: **68 866 ms and
   77 381 ms**, with the `Uber(n)` proxies named as the slowest objects.
5. That churn produces more notifications. Go to 1.

**The fix** is one ownership rule, in one place: `#applyVisibility()` writes
`visible` from the component's authored state *unless* a proxy currently holds
the mesh. All five resurrect-capable sites route through it. Hiding is
deliberately NOT routed through it — a disabled component must take effect
immediately, and hiding can never resurrect. Deferring to the owner loses
nothing: `merging.js#teardown` restores members with the identical expression.

⚠ **The first version of the regression test passed against the BROKEN code.**
It drove `#applySharedMaterial` via `setProp("material", …)` — but that path sits
behind an `await loadMaterialAsset(...)` that never resolves in a headless run,
so the assertion was never reached. A test that cannot fail is worse than no
test, because it converts an open bug into a closed one. The shipped test uses
`onEnable`, which is synchronous, and **was verified to fail with the ownership
check removed.** Always confirm a regression test fails against the old code.

Confirmed effect: the editor now reaches GI instead of hanging indefinitely.
Frame rate is still CPU-bound (§A) — that is a separate ceiling, not this bug.

#### The event half, and the cache that was always missing

Fixing the resurrect stopped the infinite hang but **not the loop** — measured
after it, `component-changed:mesh` was still climbing (4460 → 4768 → **4911**),
driving 2-3 merging rebuilds every 10 s, each of which changed the mesh set GI
collects (**1532 → 1473 → 1328 → 1112**) and forced another GI rebuild.

`MeshComponent#announceSwap` fires on every material-asset notification, and a GI
scene generates those continuously. Merging's `component-changed` subscription
turned every one into a rebuild — but for a mesh merging **already holds**, that
announcement carries nothing its own precise detector does not already have:
`#watchForMaterialEdits` compares real material signatures and fires within
`WATCH_WINDOW_FRAMES`. So the handler now ignores announcements for meshes it
already merged, and still invalidates immediately for meshes it does not (a
material swap may have just made one mergeable).

**And the uber cache was keyed on member-encounter order.** `#buildGroup` built
its material list in the order members happened to be walked, and merging
re-derives member lists on every rebuild — so the *same material set* keyed
differently and missed, re-rasterising arrays that were already resident and
minting a fresh `Uber(n)` that GI then had to compile a shader variant for. Row
order is now canonical (sorted by uuid).

⚠ **The sort has to happen in `#buildGroup`, not in `#uberFor`.** `rowOf` is what
`mergeGeometries` stamps into each vertex's `materialIndex`, and the uber
material builds its layers in that same array's order. They are one numbering by
construction — canonicalise the key without the rows and a cache hit shades every
vertex from the wrong row. The existing check "every vertex is tagged with the
material row it shades from" is what guards this.

`MAX_CACHED_TEXTURE_BYTES` was also **below** the scene ceiling (128 MB against
256 MB), which guarantees the miss it exists to prevent: a rebuild evicted arrays
the next rebuild immediately asked for. Now 320 MB — it must exceed
`textureBudgetBytes` with room for one previous grouping to stay resident.

⚠ Writing that cache test surfaced a real constraint: **`setEnabled(false)` calls
`#clearCache()`**, so the off/on cycle the other checks use to bypass the
throttle destroys the thing under test. It winds back `_dirtiedAt` and
`_lastRebuildAt` instead.

### The original write-up (kept for the cycle's measurements)

The watchdog fix (above) removed the *pipeline* storm. There is a **second,
independent storm at the MATERIAL level**, and it is what "with GI on, the editor
is just hanging" actually is. Captured live after every fix above was in place:

```
14:54:35  [merging]  20 group(s)
14:55:51  [gi] built — 736 meshes  (was 580 one build earlier)
14:55:56  [merging] 112 group(s): 1049 meshes, 592 MB
14:57:00  [gi] compile wave: materials 68866ms
          slowest objects: Uber(2) 28843ms, Uber(6) 8670ms, Uber(3), Uber(5)
14:57:01  [gi] compile wave: materials 77381ms
          slowest objects: Uber(1) 30734ms, Uber(8) 17919ms, Uber(19) 8259ms
14:57:07  [merging] 102 group(s): 960 meshes, 558 MB
```

The loop:

1. Merging rebuilds and produces a **different grouping** each time — 20 → 112 →
   102, oscillating rather than converging.
2. A different grouping is a different material-set key, so `_uberCache` misses
   and **fresh `Uber(n)` materials are minted**.
3. Every new material is a new GI shader variant, so GI runs a **full compile
   wave** — measured at 68 866 ms and 77 381 ms, with the `Uber(n)` proxies named
   as the slowest objects in both.
4. The churn changes the mesh set GI collects (580 → 736 meshes between two
   builds), which bumps the geometry revision and re-mints the chain — and
   re-invalidates merging.

**Why the grouping does not converge is STILL NOT CONFIRMED.** Two hypotheses
were tested against the code and **refuted**, which is worth recording so nobody
spends the time again:

- *"Merging's candidate set is camera-dependent"* — the same bug Engine.js:850-861
  documents having already fixed in GI. **No.** `entityVisible()` reads
  `object3D.visible`, which is written only from `_lodHidden` / `_occluded` /
  authored flags; on this scene LOD reports `lodHidden: 0` and occlusion is
  disabled outright. `updateViewVisibility` writes `_inView` only, and is opt-in.
- *"Merging hides its own members, so the next pass sees them as ineligible"* —
  **No.** `#rebuild()` calls `#teardown()` before `#collectGroups()`.

Remaining suspects, now instrumented rather than guessed at: `#watchForMaterialEdits`
firing on a texture **`version`** bump (three increments it on every
`needsUpdate`, and GI's bounce-albedo pass re-tints compressed textures on the
GPU after load), and `#watchForMotion` evicting members into `_unstable`, which
is permanent for the session and so shrinks the grouping monotonically.

**The instrumentation to settle it shipped** (see below). On the next boot the
console names the trigger directly.

**Immediate workaround for the user:** turn OFF static merging
(`settings.performance.staticMerging`) while using GI on this scene. It breaks
the loop outright. The cost is draw calls — ~3 500 instead of ~920, so the frame
gets slower but the editor stops hanging and stops burning 70 s compile waves.
That is the right trade until this is fixed properly.

⚠ Do not "fix" this by making merging rebuild less often. The bug is that
successive rebuilds *disagree*; a stable scene must produce a stable grouping,
and a rate limit would only stretch the same oscillation over more wall clock.

#### Shipped against it (partial — the loop itself is still open)

**`invalidate(reason)` — merging now names its trigger.** Every invalidation
carries a reason (`hierarchy-changed`, `component-changed:mesh`, `play-changed`,
`member-moved`, or `material-edit:<field> <old>-><new>`), tallied for the
session. The outcome line gains `[rebuild #N, asked for by <reason>]`. The
material-edit reason names the **first differing signature field**, because
"a material changed" and "`map.version` went 3→4" are completely different
problems and only the second is a loop.

**A silent rebuild loop is now audible.** `#report` was change-gated — deliberately,
so a `hierarchy-changed` storm would not flood the console — which meant the
*worst* case logged nothing at all: a rebuild that produces the same grouping
every time still tears down and re-mints uber materials, and said nothing while
GI compiled for a minute. A separate throttled line now reports the rebuild RATE
and the top triggers every 10 s.

**A scene-wide texture ceiling** (`merging.textureBudgetBytes`, default 256 MB).
`MAX_GROUP_TEXTURE_BYTES` and `MAX_BYTES_PER_DRAW_SAVED` are both **per group** —
on a room-sized scene that bounds the total, on an imported city it does not.
Bistro's 112 groups were each individually affordable (largest ~1.5 MB per draw
saved against a 24 MB allowance) and summed to **630 MB of pure addition**. A
per-item budget with no aggregate is a rate limit, not a budget. Groups are taken
in formation order and the first to cross the line stops merging for that pass;
the rest draw normally. This directly bounds the "eating up memory" symptom even
while the loop is unfixed. Guarded by a test that lowers the ceiling rather than
enlarging the textures — `#uberFor` stacks real image data, so sizes cannot be
faked, and reproducing 256 MB end-to-end would make the suite the memory problem
it is testing for.

### A. Draw submission is the frame (16.09 ms of 30.25 ms)

`profile.drawCalls`: **1046 draws for 523 meshes**, `floorIfMerged: **9**`. The
scene is submitted twice (main + GI gbuffer prepass), and 173 distinct materials
resolve to **9 distinct pipeline states** — so the theoretical floor is ~9 draws
per pass against 523 actual.

Merging already saves 928 draws/pass, but it costs **630 MB of added texture
memory** to do it, and its budget is **per group** (`MAX_GROUP_TEXTURE_BYTES`,
`MAX_BYTES_PER_DRAW_SAVED`) with **no scene-wide ceiling** — 108 groups each
individually affordable summed to 630 MB.

The real fix is bindless/texture-array batching so draws collapse without
copying textures. That is the next substantial piece of work, and it is the only
thing that moves both `renderEncode` and `preRender` at once.

### B′. ✅ THE SLOT CAP (was: two thirds of the scene invisible to GI)

Raised `MAX_INSTANCE_SLOTS` 512 → 768 and moved the per-slot matrices to a
storage buffer. Three device-limit traps fired on the way, each one measured
live and each one rendering as a black/broken GI field rather than an error
dialog — recorded in full in `slotRegistry.js` and `occupancyField.js`:

1. **1024 slots made `bindGroup_object` invalid.** three packs ALL of a compute
   object's uniformArrays into ONE object-group UBO, so per-array arithmetic
   against the 64 KB limit is wrong — `localToWorld` shared the binding with
   `slotDynamic` and the palette. This is also the real reason the original
   constant was "half the limit".
2. **The storage-buffer conversion pushed the voxelizer to 9 storage buffers
   against the default per-stage limit of 8.** `resolveRendererLimits` now asks
   for `maxStorageBuffersPerShaderStage` (adapter-clamped; this adapter
   advertises 16).
3. **`maxBufferSize` and `maxStorageBufferBindingSize` are separate limits.**
   The binding ask has been 1 GB for a while; a 261 MB GI buffer still failed at
   *creation* against the default 256 MB `maxBufferSize`. Both are asked now,
   and GI's degrade ladder clamps against the `min()` of the two.

Verified on Bistro: all placements seat (610 → 624 slots, 0 pending), the field
went 274 k → **414 k occupied voxels / 1.28 M claimed triangles**, the static
shadow BVH covers all 2.83 M triangles, and the street is lit end-to-end — the
"GI concentrated on a small square" symptom is gone. The merge texture budget
default also rose to 768 MB (`merging.textureBudgetBytes`; the 256 MB estimate
was mostly block-copied compressed arrays — the whole renderer held 287 MB
real), with the idle uber-cache ceiling now *derived* from it
(`#cacheCeilingBytes`) so the two constants cannot drift apart again.

Steady state after all of it: **CPU 25.8 ms / GPU 9.5 ms / 883 draws** — from
45.4 ms CPU / 1674 draws at the start of the session. Still CPU-bound:
renderEncode 13.4 + preRender 11.5 own 93% of the tick, and the next 2× is
bindless/texture-array batching (§A), not GI.

### B. GI-traced shadows only see the first 64 meshes

```
[gi] bvh: 602 eligible meshes exceed the 64-mesh cap — seating the first 64
[gi] bvh: 542 dynamic (BVH-excluded) meshes exceed the 8 coverage slots
[gi] bvh: skipping "Merged(29)" (186541 tris > 150000 bvh cap)
```

`bvhScene.js:490` — `capped = eligible.slice(0, MAX_BVH_MESHES)`. **Traversal
order, no spatial or size criterion.** For an imported model "the first 64" is
one contiguous chunk of the hierarchy, i.e. one region of the map; the other 538
fall through to `DYNAMIC_CAPACITY = 8` coverage slots, which also overflows.

This is scale-independent, so it is still in effect at 0.1. If a ranked seat
selection is wanted, screen-area or camera distance is the obvious key — the
emitter seats already rank by `power/d²`.

### C. The probe lattice caps at 48/axis — this is why scaling down worked

```
built: 120.0x42.5x130.0m (auto-fit medium), c0 48x17x48
probe spacing is 2.50m (volume 120.0x42.5x130.0m at "medium")
```

`MAX_PROBE_AXIS = 48`, and `QUALITY_BUDGETS.ultra.probeAxis` is also 48
(48³ ≈ 110 592 = ultra's whole probe budget). **The GI volume covers the scene
correctly** — it is not clamped to a square. What is capped is *density*:

| scale | volume | probe spacing |
|---|---|---|
| 1.0 | 120 × 42.5 × 130 m | **2.50 m** |
| 0.1 | 11.7 × 4.2 × 12.0 m | **0.24 m** |

So scaling to 0.1 did not shrink the lit area — it bought **10× the probe
density**. That is a legitimate workaround, and the engine's own log says as
much ("build the scene at a smaller world scale").

The cost of that workaround is the other end: at 0.1 a 20 cm wall is 0.02 units
against a 0.19-unit cell, which is why **508 of 606 meshes** report "thinner than
2 GI cells" (at scale 1 it is 440 of 580, at 2.03 m cells). Either way most of
Bistro's geometry is sub-cell.

**A city-scale scene cannot be lit at world scale by a single uniform lattice at
this budget.** 1 m spacing over 120 × 42 × 130 m needs ~655 k probes, 6× ultra.
The structural answer is a volume that follows the camera (or genuine cascades)
rather than one that spans the whole city — not a bigger budget.

### D. jsHeap

Observed 3.6 GB on a fresh boot climbing to **8.0 GB** within minutes, with
`textureMemMB` also climbing. `profile.textures` reported **1062 of 1435
textures (454 MB) not referenced by the open scene** — the asset cache retaining
GPU memory for models no longer present. The watchdog storm was one source
(every duplicate compile retains a shader module) and merging's churn another;
both are fixed, and the fresh-boot figure is much healthier. **The residual
retention is not diagnosed** and wants its own session — `usedJSHeapSize` at
multiple GB puts major GCs squarely inside the frame, which is what the 418.9 ms
first reading was.

---

## D′. ✅ THE HEAP, first cut — merging's staged texels + the placeholder generation

The user called the merging heap cost the blocker ("it blocks us fixing
anything else"), and the editor proved it mid-session: a single material
recompile wave (sun Shadow Source flipped) wedged MCP for over a minute.
Two fixes, both in the load/rebuild path:

**1. Uber array textures now free their staged CPU texels after GPU upload**
(`releaseTexelsAfterUpload` in `uberMaterial.js`). Every group stages
`width*height*4*layers` bytes into one `Uint8Array` — ~630 MB per generation at
world scale — and three keeps that copy referenced FOREVER after upload; the
uber cache then retains it by design (the idle ceiling is ~960 MB since the
budget raise). None of it is ever read again: `needsUpdate` is set exactly once
at creation, a cache hit reuses the same texture object with its GPU copy
intact, and an evicted entry rebuilds from the SOURCE textures. The release
rides `texture.onUpdate`, which the common renderer calls AFTER
`backend.updateTexture` + mip generation — exact, never early, and headless it
simply never fires (the tests rely on that). Only `.data` is surrendered;
dimensions stay because the backend sizes bind groups from them every frame.

**2. While ANY mesh's assets are streaming, merging commits NOTHING.** This
took two iterations, and the first made things WORSE — the failure mode is
worth keeping:

- Iteration 1 (wrong): gate `#collectGroups` + `#readyMeshCount` on
  `assetLoadsPending`, so placeholder-material meshes never group (rebuild #10
  used to bake **1426 meshes into 4 mega-groups** on their placeholders and
  dissolve them 3 s later). But excluding them made the ready-count CLIMB for
  the whole transcode tail, and the deferral only held while the count was
  actively moving — transcodes land in WAVES, the SETTLE_MS release fired in
  every gap, and the reloaded editor committed **incremental generations at
  887 then 952 meshes** (rebuild #8, #9, …), each staging fresh texture arrays
  and handing GI a different mesh set: 3 fps, 5.1 GB heap, worse than before.
- Iteration 2 (shipped): `#scenePopulation()` returns `{ready, pending}`, and
  `pending > 0` is a HARD hold — an early `return` from the dirty path, not a
  clock push, because the wave-gap releases came through the SETTLE_MS path
  that clock-pushing does not gate. Bounded by `MAX_LOAD_DEFER_MS` (60 s) from
  a FIXED `_deferHoldStart` origin cleared only when pending hits zero — the
  old bound re-armed the clock it was bounding and was dead code. Past the
  bound: warn once, merge what arrived, `#collectGroups` keeps refusing the
  stragglers (they draw their placeholders unmerged). A moving ready-count
  stays a soft push — a hard return there would break "first sync after
  `setEnabled` merges immediately", since the first look at any scene registers
  as a population change. `setEnabled`'s `_urgent` is deliberately overridden
  by the hold: scene boot is exactly when everything is pending.

- Iteration 3 (the blind spot that broke iteration 2 live): **`assetLoadsPending`
  does not cover texture transcodes.** `loadMaterialAsset` resolves the material
  immediately and its maps land in DETACHED `.then()`s (`materialAsset.js`), so
  every mesh reads "arrived" for the entire KTX2 tail — the reloaded editor
  read pending=0, released the hold, and **1173 uber builds refused** ("uber
  material could not be built": sources without mip data / placeholder dims),
  dribbling 12- and 21-mesh generations while GI storm-rebuilt the UNMERGED
  scene (1532 placements into 768 slots — half invisible) behind each one.
  2 fps, and the GPU process eventually DIED (see below). Fix: `textureAsset.js`
  now exports **`textureLoadsInFlight()`** — a counter around the whole
  `loadTextureAsset` (basis queue included) — and BOTH merging's hold and GI's
  `#readyToRebuild` fold it into pending. Both bounds became **progress-aware**:
  a timeout measures a STALLED load, not a long one, so any change in the
  pending count re-arms it; a frozen nonzero count is what expires it.

- Iteration 3b (the last double build): even with textures gated, GI's 250 ms
  asset-stable window beat merging's 400 ms settle, so build #1 still ran
  against the UNMERGED scene and the merge commit invalidated it. Merging now
  exposes **`get settling()`** (`enabled && _dirty`) and GI's gate counts it as
  pending. Cannot deadlock: merging's own hold is bounded, and GI's stall bound
  covers a stuck flag regardless.

All guarded in `run-merging-test.mjs` (32 checks); the hold, the straggler
exclusion and the texel release were each verified to FAIL with their fix
neutered — exactly those and nothing else. ⚠ test trap: `performance.now()` in
Node counts from PROCESS start, so "an origin in the past" must be `-Infinity`,
not a small positive number (and the progress-aware bound also needs
`_lastPendingCount` pre-seeded, or the unseen count re-arms the origin being
wound back).

**Device loss, observed live:** the storm boot ended with the GPU process dead —
"Instance dropped in popErrorScope", then every `createBuffer` failing with
nonsense ("size (32) is too large"). Two diagnostics hardened on the way: GI's
`#maybeLogStats` readbacks now `.catch()` instead of throwing uncaught from the
tick, and `readbackBits` refuses buffers over 200 MB — **Chrome caps
`mappedAtCreation` staging near 256 MB regardless of the raised
`maxBufferSize`**, so the world-scale 321 MB bits map rejected every boot even
on a healthy device.

What this does NOT fix: the SOURCE textures' own CPU copies (KTX2 mip chains
stay in JS heap engine-wide — merging reads them on every cache-miss build, so
releasing them needs a re-fetch path first), and the 1062-unreferenced-textures
asset-cache retention below, which is still undiagnosed.

---

## Reproducing any of this

```
profile.frameStats     → is it CPU-bound at all? (cpuMs vs gpuMs)
profile.cpuFrame       → WHICH phase (this is the new one)
profile.drawCalls      → passes, floorIfMerged, merging's added texture MB
profile.textures       → orphaned/unreferenced retention
console.read           → the [gi] and [merging] report lines say most of it
```

⚠ Wait for the scene to settle. Every number above taken before
`compile wave: materials warmed` is measuring a scene that is not yet doing its
work — the first reading of the session was 418.9 ms CPU and meant nothing.

⚠ Three assistant sessions were attached to this editor during the measurements;
scene state (GI enabled, quality, selection) can change under you. Re-read rather
than trusting a cached value.
