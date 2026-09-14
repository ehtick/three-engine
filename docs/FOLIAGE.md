# Foliage

The optional `foliage` module provides procedural oak, pine, birch, meadow grass,
and wildflowers. A Foliage component owns an individual plant or an entire
scatter layer; generated plants do not become separate entities.

## Authoring

Select a Mesh, Model, or Terrain and use **Procedural Foliage → Trees / Grass /
Flowers** in its inspector. The same actions appear as **Scatter Trees / Grass /
Flowers** in the hierarchy context menu for a mesh surface or a group containing
meshes. These actions enable the Foliage module, create a child layer referencing
the selected surface, and select it for editing.

With the module enabled, the hierarchy's create menu also offers **Foliage Tree**,
**Foliage Grass**, and **Foliage Flowers**. Creating under a surface scatters on
that surface; creating without one places a single plant. Switch **Placement**
between **Single plant** and **Scatter on surface** in the Foliage inspector.
The **Surface** field accepts Mesh, Model, Terrain, or a group of mesh surfaces.
An empty reference uses the Foliage entity's own mesh, model or terrain, or its
parent's surfaces.

All controls are scene properties and use the editor's command/undo system.
Changing **Species** applies its shape, colors, placement, and distance preset
together in one undo step. **New variation** increments the seed, changing both
the prototype and its seeded distribution. Use separate layers with different
species or seeds for mixed vegetation.

| Control | Meaning |
| --- | --- |
| Plants / m² | Population per square metre of accepted world-space triangle area, before the plant limit and minimum-spacing rejection. |
| Plant limit | Maximum population in this layer, including plants currently outside draw distance. |
| Height / Width | Procedural shape dimensions in metres. Crown extents are approximate botanical envelopes. |
| Foliage / Bark / Flower color | Vertex colors on the generated geometry; color changes also invalidate its impostor atlas. |
| Scale | Seeded uniform per-plant scale range. |
| Spacing | Minimum three-dimensional root-to-root distance in metres, enforced across spatial-cell boundaries. |
| Slope ° | Allowed face angle from world up: 0° is upward ground, 90° a wall, 180° an underside. |
| Altitude | Allowed world-space Y range. Triangles crossing its boundaries are clipped when calculating eligible area. |
| Follow normal | Align local plant up to its source face normal; disable for upright trees on hillsides. |
| Wind / Wind response | Enable animation and choose how strongly this plant responds to the shared Scene wind. |
| Gust response / Gust size / Turbulence | Response to Scene gusts, world-space gust-pattern size, and finer leaf/blade-tip movement. Defaults: 0.6, 12 metres, and 0.25. |
| Collider bending / Bend strength / Extra reach | Visual displacement around nearby colliders and character controllers, with an added influence distance in metres. |
| Detail distance | Change from detailed geometry to the simpler mesh. |
| Impostor distance | Change from the simpler mesh to its baked, dynamically lit billboard once the atlas is ready. |
| Draw distance | Hide chunks beyond this distance. |
| Cell size | World-space chunk size. Smaller cells improve detail/culling precision; larger cells reduce CPU bookkeeping. Plant size also caps the effective cell size; rendering shares at most three batches per layer. |
| Cast / Receive shadows | Normal engine shadow participation. |

Species presets establish useful starting scales and distances; they are not
fixed performance guarantees:

| Preset | Height × width, m | Plants / m² | Spacing, m | Detail / impostor / draw distance, m |
| --- | --- | --- | --- | --- |
| Oak | 8 × 6 | 0.015 | 4 | 35 / 90 / 350 |
| Pine | 10 × 4 | 0.025 | 3 | 35 / 90 / 350 |
| Birch | 9 × 4 | 0.03 | 2.5 | 30 / 80 / 300 |
| Grass | 0.65 × 0.65 | 3 | 0.15 | 12 / 30 / 65 |
| Wildflowers | 0.8 × 0.6 | 0.8 | 0.3 | 15 / 35 / 80 |

## Terrain and mesh surfaces

Placement samples actual triangle area, including indexed and nonindexed meshes,
nested imported models, instance transforms, and nonuniform or mirrored parent
transforms. Disconnected surfaces do not populate their empty bounding box.
Degenerate triangles are skipped. Batched and merged source meshes remain
plantable even while the optimizer hides them; render proxies and generated
foliage are excluded from sampling.

Every plant stores its source triangle and barycentric attachment. Terrain
sculpting updates positions and normals on those same attachments, preserving
seed, scale, yaw, and plant identity. Changing height alone therefore preserves
the root's XZ location. A source transform also moves its attached distribution.
Source topology changes or changes to placement parameters produce a fresh
deterministic distribution. Scene reload reconstructs the generated resources
from serialized component properties and the referenced surface; asynchronous
mesh/model geometry arrival replaces any initial placeholder distribution.

Slope, altitude, density, and spacing are distribution constraints. Reseating
existing attachments after a sculpt preserves plants rather than deleting or
repopulating them whenever a face crosses a constraint. Edit a placement control
or choose **New variation** to recalculate the distribution. Current skinned and
morph geometry can be sampled as a snapshot; continuously following arbitrary
animated deformation is not the runtime's attachment contract. Terrain's painted
material-layer weights do not currently mask foliage, and there is no foliage
painting or erasing brush.

## Rendering and scale

The tree generator starts from a species scaffold: spreading low forks for oak,
a slender leader and arching/drooping limbs for birch, and apical whorls for pine.
A bounded space-colonization pass grows fine branches toward nearby attraction
points, removes reached points, and biases continuation by inherited direction
and species tropism. A spatial hash bounds neighborhood searches. Pipe-model
weights set relative branch vigor; an additional monotone taper connects those
coarse structural pipes to thin leafy shoots. Shared curve points and parallel
transport frames produce tapered branch surfaces rather than disconnected rods.
The attraction/kill-distance method and pipe formulation follow
[Runions, Lane and Prusinkiewicz (2007)](https://algorithmicbotany.org/papers/colonization.egwnp2007.pdf).
This is a deliberately bounded adaptation, not an implementation of
[Interactive Invigoration's volumetric strand model (2024)](https://storage.googleapis.com/pirk.io/projects/invigoration/index.html).

Skeletons are cached across LODs and color changes, with limits of 640 nodes,
1,600 attraction points, 30 growth iterations, and 24 cached skeletons. Tree
foliage uses folded spray cards with procedurally generated alpha-tested masks:
18 small leaves per broadleaf card, or 256 needles in irregular paired pine fascicles.
The longest template leaf is approximately 10.5 cm for oak, 8.2 cm for birch,
and 13 cm for pine needles, before the spray's 0.82-1.14 size variation.
Increasing spray coverage adds more leaf silhouettes rather than turning a card
into one oversized polygon leaf. Pine cards measure 0.34 by 0.32 m and roll
around smooth lateral boughs as well as terminal shoots, filling the crown
without flat fern-like sprays. Young pine crown massing and paired needles use
[botanical references](https://landscapeplants.oregonstate.edu/plants/pinus-nigra)
as guidance; the preset is a procedural approximation. Bark uses metre-based
branch UVs and generated surface detail.

Grass remains curved tapered blades, and wildflowers retain their petaled shape.
Each layer shares a prototype and material across all of its instances; yaw and
size vary per plant. A seed changes the prototype as a whole, so a single layer
does not contain independently generated branch topology for every tree.

`createFoliagePrototype(props, lod)` supports three decreasing geometry levels
with stable seeded branch layouts. The runtime uses detailed LOD0, simpler LOD1,
and the engine's existing octahedral impostor implementation for its final tier.
The third generated geometry level remains available to callers. Distant plants
use two-triangle instanced quads, alpha-tested coverage, and baked albedo/normal
atlases that respond to current scene lighting. The runtime bakes 4 × 4 views at
64 pixels per view and caches the resulting atlas by renderer and shape
properties. Until baking finishes, the simpler mesh continues drawing.

World-space cells are split at 1,024 plants, along their widest spatial axis, so
their children occupy smaller regions. Species size caps the effective cell size.
Cells choose detail and retain detached source buffers, while **three shared
render meshes per layer** submit its near, middle, and impostor populations.
Typed-array ranges are packed only when LOD membership or placement changes;
ordinary wind updates and camera rotation do not rewrite instance transforms.
Batch attributes use version-driven upload usage: Three's `DynamicDrawUsage`
uploads even unchanged buffers on every render pass. A regression drives the
installed Three attribute manager, verifying zero stationary uploads and fresh
ranges after a LOD repack; its previous-usage control makes 180 redundant uploads.
Three r185 also synchronizes its private instance-matrix mirror after geometry
upload. A Foliage-only `OnBeforeObjectUpdate` forwards versions and partial ranges
to the compiled position and wind matrix mirrors before upload. Matching arrays
limits the hook to this object's matrices; no dependency or renderer patch is
installed. The GPU gate covers immediate repacks and untouched partial-upload
tails for static and dynamic usage at capacities 4 and 1,100.
An instrumented eight-second GI camera sweep measured foliage writes falling
from 1,072.3 MB to 75.4 MB (93.0%); a three-second stationary interval fell from
322.5 MB to 7.37 MB (97.7%). Stationary grass/flower matrices and impostor
placement buffers now upload zero bytes until repacking. Remaining stationary
foliage writes are the much smaller tree uniform buffers. Byte-attribution runs
are separate from uninstrumented FPS measurements.
Thus smaller cells improve distance decisions without adding a draw per cell.

### LOD: per-instance dithered crossfade (P1-B, 09-13)

A chunk's `level` — its single "best" tier, used only for bookkeeping (stats,
per-chunk template visibility, the impostor raycast fallback) — is a plain
boundary compare on the nearest point of its tight detail box: `distance <
lodNear ? 0 : distance < lodFar ? 1 : distance < maxDistance ? 2 : 3`
(`foliageLodLevel`, `foliageLod.js`). There is no hysteresis and no
chunk-relative rescale by projected pixel size any more
(`foliageDetailDistances` is deleted): a plant's tier is a property of the
plant and the camera, never of which render target or zoom level is looking
at it, or which spatial cell it happened to land in.

Which shared render mesh(es) actually RECEIVE a chunk's instance data is a
SEPARATE, superset value: `chunk.tierMask`, a bitmask from
`foliageChunkTierMask` — a chunk belongs to every tier whose band overlaps
its own distance RANGE (nearest corner to farthest corner of its detail box,
not just the nearest point `level` uses), so a chunk straddling a crossfade
band is copied into BOTH tiers' buffers, and the per-instance shader weight
(below) decides how much of each actually draws. The mask compares against
each instance's SCALE-NORMALIZED distance, the same quantity the shader and
`foliageTierWeights` compare to a threshold, not the box's raw one: the near
edge divides by the chunk's largest instance scale (the most a big plant's
normalized distance could shrink below its raw one) and the far edge by the
smallest (the most a small plant's could grow) — `_measureChunkPlants` tracks
both extremes per chunk. Getting this wrong is invisible to the pure-formula
math test and only shows up walking a real component (see the two "THE
RECEIPT" tests in `foliage-runtime.test.mjs`).

What actually keeps this from popping is a **per-instance shader crossfade**,
computed independently of chunk assignment, in both the tree/grass material
(`foliageMaterial.js`) and the impostor material (`impostorMaterial.js`):

- In the vertex stage, `d = length(instancePivot - viewerPosition) /
  instanceScale` — the instance's own world pivot and world scale (recovered
  from its instance matrix's basis-vector length, or from the impostor's
  baked `aSize` divided by the atlas radius), never a per-vertex value, so one
  tree's own leaves never dither out of step with its own trunk. `viewerPosition`
  is a per-object uniform (`mesh.userData.foliageViewerPosition`), never TSL's
  builtin `cameraPosition` — **09-13 shadow bug, fixed**: `cameraPosition` is
  the world position of whichever camera renders the CURRENT PASS, which
  during a shadow-map pass is the light's orthographic camera, not the
  viewer. Every instance's distance from that far-off ortho camera read as
  past `maxDistance`, so every tree faded to weight 0 — collapsing its
  vertices onto its own pivot and, via the same `maskShadowNode` discard
  below, dropping it from the shadow map entirely — while the color pass,
  using the real viewport camera, drew it normally: trees cast no shadow,
  rocks (no LOD crossfade) still did. `FoliageComponent.update()` now reads
  `engine.camera` itself once a frame into a component-owned `Vector3` and
  writes it onto every one of its own render meshes (near, mid, impostor
  alike), so the fade measures distance from the real viewer in every pass.
- Three complementary smoothsteps cross the near/far/maxDistance boundaries,
  each over a band `max(threshold * 0.25, 6 m)` (`foliageLodBand`): near
  weight `1 - fadeNear`, mid weight `fadeNear * (1 - fadeFar)`, impostor
  weight `fadeFar * (1 - fadeEnd)`. These three sum to 1 everywhere except
  past `maxDistance`, which is a genuine hard cutoff (a plant is meant to
  vanish there, not be held up by a fourth tier) — `foliageTierWeights` in
  `foliageLod.js` is the exact CPU mirror the shader's formula matches.
  `foliageLodThresholds` additionally widens an author's `lodFar`/
  `maxDistance` (`enforceLodGap`) whenever they sit closer than the two
  bands' own widths, so the near/far and far/end crossfades never touch —
  the complementary discard rule below is only exact when one boundary's
  fade is fully saturated to 0 or 1 while the other is live.
- **09-13, owner's verdict — the discard rule is COMPLEMENTARY, not a shared
  "keep if `noise < weight`" test.** Testing every tier against its own
  weight with the same `<` comparison sums the three weights to 1 correctly
  but still leaves a band of `noise` values kept by NEITHER tier at a
  boundary — the reported "one mesh disappears into nothing, then a new one
  appears" — and another band kept by BOTH. The tier on the FAR side of any
  one boundary instead keeps the COMPLEMENT, `noise >= 1 - weight`: the near
  tier always keeps `noise < weight` (it is always the close side of the
  near/mid boundary); the impostor tier always keeps `noise >= 1 - weight`
  (always the far side of its one boundary, mid/impostor — its own weight
  already folds in the `maxDistance` fade-out, so the same rule thins it to
  nothing there too); the mid tier sits between two boundaries and plays each
  role once, switching at the midpoint of `lodNear`/`lodFar` (the far/`noise
  >= 1 - weight` rule below it, the close/`noise < weight` rule beyond it).
  `foliageTierKeeps(tier, distance, noise, thresholds)` in `foliageLod.js` is
  the CPU mirror of this exact per-pixel test; `foliageDitherSurvives` in
  `foliageMaterial.js` and the equivalent block in `impostorMaterial.js` are
  the TSL twins. The crossfade band also moved out and widened (0.25 of the
  threshold, floored at 6 m, up from 0.12/3 m) and the species-level default
  distances moved from 25/70/180 m to 45/130/320 m, so the transition is
  spread over roughly 10-30 m and starts well clear of the camera rather than
  "triggering very close" to it.
- The fragment stage discards by a **screen-door dither**: interleaved
  gradient noise from `screenCoordinate` (stable per pixel, never animated
  per frame, so two instances mid-band cover complementary pixels instead of
  both blending at reduced alpha) multiplies the surface's own alpha toward
  0 when the complementary test above fails, and the material's existing
  `alphaTest` does the actual discarding — the same mechanism the leaf/bark
  cutout already used. Because the shadow-map material reads `maskShadowNode`
  and never `opacityNode`, both materials rebuild `maskShadowNode` from this
  same faded value, so a plant fades out of its own shadow in step with the
  color pass — shadows carry the dither too, not the escape-hatch fallback.
- A weight of (near) zero collapses every vertex of that instance onto its
  own pivot instead of animating and rasterizing geometry the fragment stage
  would only discard anyway.

Thresholds ride as per-OBJECT state (`mesh.userData.foliageLodNear/Far/End`,
written once a frame by `FoliageComponent.update()`), read back with
`.onObjectUpdate`, never as a material uniform: the tree/grass material is
shared across components by species (`foliageMaterialKey`), and two
components can legitimately author different `lodNear`/`lodFar` — baking one
holder's distances into the shared shader graph would leak into every other
holder's draw, the same trap `animateTree`'s pre-existing `height` literal
already has and this deliberately does not repeat.

An impostor bake's arrival is capped by `impostorReady` exactly as before (a
chunk that would classify to the impostor tier stays on mid detail until the
atlas exists), promoting the instant it does — the near/mid and mid/impostor
crossfade formulas already agree exactly at their shared boundary by
construction, so that promotion is a detail-geometry swap, never a coverage
pop. Both materials also carry a `foliageImpostorRamp` uniform
(`foliageApplyImpostorRamp` in `foliageLod.js`) that is now LIVE:
`FoliageComponent.update()` writes 0 the instant the bake resolves, ramping
to 1 over 0.8 s (`mesh.userData.foliageImpostorRamp`, read the same way as
`foliageLodNear/Far/End`), tracking the atlas's own identity so a rebake gets
its own fresh ramp-in. While the ramp has not finished,
`extendMidToImpostor` folds the impostor tier's whole span into the mid
tier's `tierMask` range, so the mid render mesh keeps holding a newly-arrived
chunk's data too — exactly what the shader's `midWeight = midRaw +
impostorRaw*(1-ramp)` leftover needs somewhere to draw from.

The commit path (`foliageBatchOrder.js`'s `commitBatchChunksFull`/
`stepBatchOrderJob`) copies a chunk into a tier's shared buffer whenever that
tier's bit is set in the chunk's `commitMask` — `tierMask`, but FROZEN: a
resumable job that read live per-chunk state directly, mid-spread across
several frames, could see the same chunk under two different tier
assignments (one from before a reassignment, one from after) and commit it
into both. `FoliageComponent._commitBatches` freezes `commitMask` from
`tierMask` for every chunk in one pass whenever `_batchVersion` (bumped only
on an actual membership change) has moved past the version last frozen, and
drops every in-flight job so all three tiers restart together against that
one consistent snapshot; a job that has already finished for the current
snapshot is left alone rather than being rebuilt from scratch merely because
a sibling tier is still spread across frames.

### LOD commit: per-tier debut, a starvation guard, and mid-pass accretion (09-13 follow-up)

A 400-plant/275-chunk walk that reads back the render meshes' ACTUAL
`instanceMatrix`/`aCenter` contents — not just `chunk.tierMask` — every 0.5 m
of a 0–250 m camera walk (`tests/foliage-runtime.test.mjs`'s "a moving camera
keeps every instance covered by an ACTUALLY-COMMITTED tier…") found the
freeze-on-every-bump design above starving completely once the camera moves
continuously and the scatter exceeds `FOLIAGE_ORDER_SPREAD_CHUNKS`: some
chunk's `tierMask` changes on nearly every 0.5 m step, so `_batchVersion`
kept bumping and refreezing+resetting every in-flight job before
`stepBatchOrderJob`'s fixed 4-chunks-per-tier-per-frame budget ever finished
a single pass — measured at 466 refreezes over 500 steps, with every render
mesh stuck at `count === 0` for the entire walk. Three additions in
`FoliageComponent._commitBatches`/`foliageBatchOrder.js` close this without
reintroducing the double-commit bug the freeze exists to prevent:

- **Per-tier debut.** `_tierEverCommitted[lod]` (reset by `_disposeChunks`)
  tracks whether a given render mesh has EVER completed a commit. A tier's
  first-ever commit always uses the synchronous `commitBatchChunksFull` path
  regardless of chunk count — a one-time, load-time cost — because it has no
  earlier picture to show while it spreads. This is per tier, not per
  component: the impostor mesh is born long after the tree/grass tiers
  already have a settled commit (it waits on `_requestAtlas`/`_buildImpostors`
  to resolve), so its own debut needs the same synchronous exemption on its
  own schedule.
- **A starvation guard.** Once a pass is running (`midSpread`, i.e. some
  tier's job for the frozen snapshot is not yet `.done`), the NEXT refreeze
  is deferred until every tier's job for the CURRENT snapshot finishes (or
  none have started). This bounds the staleness a moving camera can cause to
  "one pass's worth of frames" instead of "forever". `foliageCommitBudget`
  additionally scales `stepBatchOrderJob`'s per-frame budget so a full pass —
  worst case, every chunk in `chunks` matches — completes within
  `FOLIAGE_ORDER_SETTLE_FRAMES` (6) frames regardless of scatter size, rather
  than the fixed 4/frame that made a few-hundred-chunk pass take tens of
  frames.
- **Mid-pass accretion.** While a pass runs, `commitMask` is still allowed to
  GROW (never shrink) every frame from the live `tierMask`
  (`chunk.commitMask |= chunk.tierMask`), so a chunk a slower job hasn't
  reached yet still picks up a freshly-needed bit the moment its cursor gets
  there. For a bit that arrives AFTER a tier's job already passed that chunk
  — `chunk._visitedMask`, set by `stepBatchOrderJob` for every chunk its
  cursor passes, matched or not — `appendChunkToJob` (job still running) or
  `appendChunkToTier` (job already `.done`) patches that ONE chunk in
  directly, at the cost of exactly one chunk's worth of work, rather than
  waiting a whole extra pass. Bits are only ever DROPPED at the settle point,
  so this can only make a chunk MORE included than strictly necessary for a
  few frames, never less: an extra tier briefly drawing a near-zero-weight
  instance dithers away silently (a "brighter dither" for a frame or two, not
  a coverage gap), while a missing tier is the instance vanishing outright.
  An instantaneous, no-crossfade reassignment of an entire scatter (a camera
  teleport, not a walk) can therefore show a BRIEF, self-healing overlap
  between two tiers for a couple of frames before it settles — the traded-off
  failure mode, and the one covered by
  `tests/foliage-batch-order.test.mjs`'s reassignment regression.

Separate conservative motion bounds drive frustum and shadow culling. Selected
offscreen cells remain in the batches so they can cast shadows; a batch is culled
as a whole. Short grass/flower distances and moderate cell sizes matter as much
as population; increasing an authored detail distance cannot force subpixel
plant detail to stay at its most expensive level.

The inspector's plants/cells/draws are component counters. Draws count the active
shared render batches, at most three per layer, before renderer frustum culling
and extra shadow passes. Triangles count all selected instances. These counters
are not GPU timing or a complete renderer draw-call measurement.

Hard bounds are **100,000 plants per component**, **1,000,000 sampled source
triangles**, and at most **20 placement attempts per requested plant**, capped at
2,000,000 attempts. Exceeding the triangle budget gives a diagnostic requesting a
simpler or smaller source; a crowded spacing request can legitimately place fewer
plants. Population and triangle caps bound work and memory, but initial generation
and surface rebuilding still run on the main thread. The layer retains placement
records, source triangle data, instance transforms, and impostor attributes.
Multiple layers add those costs. There is no terrain streaming, GPU procedural
placement, or zero-freeze guarantee for maximum-sized rebuilds.

### Vertex-input and varying budget (09-13 fix)

WebGPU caps a pipeline at **16 vertex-input locations** and **16 vertex→fragment
varyings** (`front_facing` takes one of the varying slots). The P1-B LOD
crossfade pushed the "Foliage · living surface" material over both limits —
`renderPipeline_Foliage · living surface` failed to compile
(`nodeAttribute17`/`18`/… past location 16). Root cause and fix:

**Vertex inputs.** `foliageAnimatedPosition` (tree/meadow motion) and
`foliageFadeNode` (the crossfade) each need the instance's full 4x4 matrix and
each called `foliageInstanceMatrix(builder)` independently. Three's
`NodeBuilder.getBufferAttributeFromNode` dedupes buffer-attribute nodes by
*node identity*, never by the underlying buffer+offset, so two independently
constructed mat4 reads of the identical interleaved mirror cost **eight**
locations instead of four. `foliageInstanceMatrix` (`foliageWind.js`) now
caches the constructed node per mesh (guarded by `instanceMatrix` identity, so
a repartitioned chunk still invalidates correctly), and every call site
shares one node.

| Attribute (tree, LOD0) | Components | Locations |
| --- | --- | --- |
| `position`, `color`, `uv`, `normal` | vec3/vec3/vec2/vec3 | 4 |
| `treeBranch`, `treeBranchAxis`, `treeLeaf`, `treeLeafAxis` | vec4 each (one shared interleaved buffer; `foliageWind` and `foliagePart` are packed into `treeBranchAxis.w`/`treeLeafAxis.w`, not separate attributes) | 4 |
| instance matrix (`foliageInstanceMatrix`, one shared read) | mat4 | 4 |
| **Total (this module's own budget)** | | **12** |

The impostor billboard (`impostorMaterial.js`) never reads an instance matrix
at all — it is driven entirely by `position`/`normal`/`uv` (shared unit quad)
plus `aCenter`/`aSize`/`aAxisX`/`aAxisY` (7 total).

**Varyings — round 1.** `createFoliageMaterial`'s dither crossfade used to
carry both `distance` and `weight` to the fragment stage as two separate
`.toVarying()` floats, purely so the near/mid complementary-discard rule
(`foliageDitherSurvives`) could pick which comparison to run *per fragment*.
Every input to that choice (`distance`, `lod.near/far/mid`) is already known
per instance in the vertex stage, so the rule itself is now resolved there
(`foliageDitherThreshold`) and only its one numeric outcome crosses to the
fragment stage (`foliageDitherSurvivesFromThreshold` decodes it against the
per-pixel noise) — one varying instead of two.

**Varyings — round 2.** Fixing the vertex-input side moved the failure to the
fragment stage: `Total fragment input variables count (17 = 16 user-defined +
1 front_facing) exceeds the maximum (16)`. Three's `NodeBuilder.getVaryingFromNode`
has the exact same dedup rule as the attribute case above — by *node identity*,
never by name or by which underlying value a node reads — so two independently
built promotions of identical data still cost two varying slots. Two more
instances of that pattern, both fixed by sharing one node instead of building
it twice:

- `createFoliageSurfaceMaterial` called `uv()` twice (`leafSample`,
  `barkSample` — the leaf and bark texture reads). Two fresh `AttributeNode`s,
  each independently promoted to its own fragment-stage varying. Fixed: one
  `uv()` call (`uvCoord`), reused by both samples.
- The dither threshold (`foliageDitherThreshold`, round 1's fix) and the
  leaf/bark part id (`foliagePartValue`) were each their own varying — one
  explicit, one auto-promoted because the fragment reads a vertex-only
  attribute. Both scalars now share one packed vec4 varying (`pack`: `.x` =
  threshold, `.y` = part id, `.z`/`.w` reserved for the next scalar that needs
  to cross this boundary) — one `@location`, not two.

| Varying (tree, textured species) | Before | After |
| --- | --- | --- |
| `uv` (leaf sample) | 1 | shared |
| `uv` (bark sample) | 1 | ↑ (same node) |
| dither threshold | 1 (`.toVarying()`) | folded into `pack.x` |
| leaf/bark part id | 1 (auto-promoted) | folded into `pack.y` |
| `pack` (vec4: threshold, part id, reserved ×2) | — | 1 |
| **This module's own contribution** | **4** | **2** (`uv`, `pack`) |

The framework's own MeshStandardNodeMaterial varyings (position view/world,
normal view/world, vertex colour, and the tangent-frame terms `normalMap`
needs since this geometry carries no explicit tangent attribute) are not
reproducible without a live WebGPU pipeline build — outside what a headless
test can measure — but this module's OWN controllable contribution dropped
from 4 to 2, which is what closed the gap to the reported 16.

**Varyings — round 3: the repeated-rebuild leak.** Live WGSL (`profile.wgsl`)
after rounds 1–2 still showed RAW vertex attributes in the fragment
VaryingsStruct — `treeBranch`, `treeBranchAxis`, `treeLeaf`, `treeLeafAxis`,
raw `position`, raw `normal`, `instanceIndex` — despite nothing in fragment
shading needing them directly. Root cause: three's `VaryingNode.generate()`
(`core/VaryingNode.js`) caches its "forced vertex rebuild" by
`(node, builder.currentStack)`, not by node alone — a varying read from N
different stacks re-triggers N independent rebuilds of its DEFINING
EXPRESSION. Two values here are read from more than one place:

- `normalView` (`transformNormalToView(normalLocal)`) — read once by the
  framework's own `TBNViewMatrix`/`normalMap()` machinery, and once more by
  this material's own per-light back-diffuse term (`model.direct`, called
  once per light, apparently one stack per light).
- `pack` — read by `colorNode`/`opacityNode`/`roughnessNode` (via `part` =
  `pack.y`) and separately by `survives` (via `pack.x`).

`normalLocal` is the SAME mutable var `animateTree` repeatedly `.assign()`s
while reading `treeBranch`/`treeLeaf`/their axes and the instance matrix
(itself reading `instanceIndex`) — a repeated rebuild of its expression is
exactly the leak. Fix: pin both with an extra `.toVar()` AFTER the varying is
established (`pinnedNormalView = normalView.toVar()`, `pack.toVarying().toVar()`)
— a plain local variable is cached per-node, not per-stack, so every later
reader shares the one already-built value instead of re-triggering the
rebuild.

Receipt: `tests/foliage-runtime.test.mjs` — `foliageInstanceMatrix` identity/
dedup tests, the tree/impostor attribute-inventory tests, a real node-graph
walk (`.traverse()`) proving `createFoliageSurfaceMaterial` reads `uv()` only
once, a source-level guard asserting `createFoliageMaterial` carries exactly
one `.toVarying()` call feeding both the dither rule and the part id through
`pack`, and a guard asserting both `normalView` and `pack` are pinned with
`.toVar()` before their multiple fragment readers.

## Animation, interaction, and lighting

Wind combines traveling gust fronts, delayed recovery, and finer tip motion.
Grass curves along circular centerlines of fixed arc length. Its rest fit keeps
the original roots, tips, widths and topology; intermediate points moved by at
most 3.844 cm across six default-geometry seeds. Flower stems bend while each
flower head follows one attachment as a rigid group. Tree motion rotates the
trunk, primary limbs, and leaf cards around their own attachments, with slower
woody response and faster flutter. The same rotations update surface normals.
Wind and interaction controls
update uniforms without reallocating instance matrices. Modal simulation
suspension and disabled entities pause updates; frame delta is clamped to 0.1
seconds. Impostors receive coarse whole-plant sway; their baked individual leaves
do not independently deform or react to local collider bending.

The motion design follows the two-scale moving field described by
[Sucker Punch's effects team](https://blog.playstation.com/2021/01/12/how-stunning-visual-effects-bring-ghost-of-tsushima-to-life/)
and the approach demonstrated in
[SimonDev's Quick_Grass](https://github.com/simondevyoutube/Quick_Grass).
Two samples from a shared 64-pixel noise texture run in the vertex stage.
Hierarchical motion also draws on the separate main/detail response in
[Crytek's vegetation animation](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)
and the shallow branch hierarchy and frequency bands described by
[Renaldas Zioma](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees).
This is procedural motion, not a physical branch solver. Smooth force limits
retain variation in strong weather. Root transforms use the same update cadence
as Three's instance positions, including the first frame after batch compaction.

Direction, force, and gust frequency always come from **Scene → Wind**, using
`engine.settings.wind.{vector,gust,gustFrequency}` and shared scene elapsed time.
Per-layer controls adjust plant response, gust-pattern scale, and turbulence;
they do not create independent wind directions or clocks. The Wind checkbox
turns that layer's animation off. A missing scene wind block uses the engine
defaults: vector `[0, 0, 2]`, gust `0`, and frequency `1` Hz. A legacy scalar
wind vector means `[0, 0, scalar]`, preserving the historical +Z direction.
Previously serialized Foliage `windDirection` and `windSpeed` values remain
loadable for compatibility but do not override Scene wind.

Interaction uses at most eight enabled collider/character influences nearest the
camera. Boxes use oriented extents, spheres use their radius, convex colliders
use an oriented bounds approximation, and capsules use an enclosing sphere.
Sensors, disabled entities/components, and unsupported concave triangle shapes
are excluded. Bending is visual, capped to one metre of combined collider push;
it does not simulate breakage or make scattered trunks solid. Add an ordinary
scene collider where gameplay should stop against a tree.

Foliage uses lit `MeshStandardNodeMaterial` surfaces, direct shadows, and the
engine's existing GI reception path — every tier RECEIVES world GI through a
per-pixel field lookup in its own material, unconditionally.

Explicit GI tags decide what each tier is allowed to COST (2026-09-13 policy;
`userData.giTrace`/`giMobility`/`giInstanceCap`, read by
`GISystem.js#placementsOf`, `dynamicObjects.js#giTraceOf`):

- Grass field rings (`grassRenderer.js`), scattered grass/wildflower
  populations (every LOD tier), and every impostor-tier mesh (foliage's own
  and the engine's generic `ImpostorSystem`) carry `giTrace: "none"` +
  `giMobility: "static"`. This is stronger than the old "voxel" fallback: the
  mesh contributes NO atlas slot, NO SDF/analytic bake, NO static-BVH
  triangle, and is not counted in any GI tier tally — it is fully invisible
  to GI's cost accounting, not merely voxelized.
- A tree/shrub population's near tier (closest, highest instance count) also
  carries `giTrace: "none"` for the same reason. Its mid tier is the ONE
  seated proxy per population: `userData.giInstanceCap = 48` narrows
  `GISystem.js`'s per-mesh instance-seat cap (`MAX_INSTANCES_PER_MESH = 256`)
  down to `MAX_FOLIAGE_INSTANCES_PER_MESH = 48` for that InstancedMesh, so
  one population can no longer claim 256 atlas slots for its own canopy while
  starving everything else in the scene.
- Nothing foliage reaches the static shadow BVH: `#placementsOf` is the same
  function `#occupancyContentOf` reads to build that BVH's triangle soup, so
  a `giTrace: "none"` tag removes a mesh from both at once.

The forest still does not contribute its own colored bounce or occlude GI
rays past the mid tier's low seat count — this avoids expanding every grass
blade/leaf card instance into the GI field. Cached foliage-specific GI
override materials preserve the billboard's alpha cutout, baked normals,
sidedness and vertex positions in the deferred prepass. Foliage deformation
uses uniforms and attributes rather than additional storage buffers; the
composed GI graph must continue to pass the portable eight-buffer smoke test.

The material combines vertex color with generated leaf coverage, veins, normal
detail, bark patterns, and a small direct back-light contribution for thin leaves.
It has no imported botanical asset dependency or seasonal growth system.
Nonuniformly scaled single plants keep their full matrix
in mesh levels; the existing impostor representation uses the largest scale axis
for conservative billboard sizing and approximates their distant proportions.

## Code contracts

- `foliageGeometry.js`: `FOLIAGE_SPECIES`, `foliageRandom(seed)`, and
  `createFoliagePrototype(props, lod = 0)` returning a `BufferGeometry` with
  `position`, `normal`, `color`, and `uv` attributes. Trees share one interleaved
  buffer with four vec4 attributes: `treeBranch` (primary pivot, flexibility),
  `treeBranchAxis` (axis, wind weight), `treeLeaf` (attachment, phase), and
  `treeLeafAxis` (length axis, surface part: 0 bark / 1 leaf / 2 needle).
  Meadow geometry retains scalar `foliageWind` and one interleaved buffer with
  `foliageBlade` (root X/Z, rest length, attachment progression) and
  `foliageCurve` (rest direction X/Z, arc angle, signed cross-section offset).
  Negative curve angles identify flower attachments and unchanged undergrowth.
  Including both instance-matrix readers, trees use 16 attributes / 7 buffers,
  meadow uses 15 attributes / 8 buffers. Tree diagnostic metadata
  exposes actual card/branch counts and physical leaf dimensions.
- `treeGrowth.js`: `growTreeSkeleton(props)` returns the cached rooted graph,
  curved scaffold, pipe weights/radii, branch paths, terminal sites, and measured
  growth-work counters. No growth computation runs during ordinary camera motion.
- `foliageScatter.js`: `collectSurfaceTriangles(rootOrRoots, options)` returns
  transformed triangle positions, normals, cumulative areas, bounds, stats, and a
  `topologyKey`. A triangle-budget overflow throws an explicit `RangeError`.
  `scatterFoliage(rootOrSurface, props)` returns `{ instances, surface, stats }`;
  instances carry world position/normal/quaternion, scale, yaw, seed, source
  `triangleIndex`, and `barycentric` weights. The optional lower-level `count`
  overrides density while retaining the population cap.
- `reseatFoliageInstances(surface, instances)` mutates positions, normals, and
  orientations while retaining other identity fields, returning
  `{ instances, updated, invalid }`. Compare `topologyKey` before reseating;
  position/version or world-transform changes alone do not invalidate topology.
- `FoliageComponent`: owns placement/resource lifetime, source-change tracking,
  chunking, atlas references, motion uniforms, distance selection, and diagnostic
  `stats`. Generated resources are disposed on detach; late atlas promises cannot
  repopulate a detached or superseded component.
- `foliageWarmup.js`: prepares hidden detail variants for the ordinary main
  framebuffer. GI and post-processing own their pass variants: Three reads live
  MRT state during asynchronous node construction, so temporarily installing an
  MRT for compilation can produce an incorrect graph and black GI. Temporary
  visibility is restored before awaiting. Resources being compiled are retained
  through reshape/detach and disposed when the outstanding compile releases them.

## Validation

Run `npm run test:foliage` for geometry, scatter, runtime, authoring, and actual
Terrain attachment tests. These include disabled/deleted colliders, module
teardown/re-enable, shared matrices across detail levels, world-space entity
bounds, live terrain reseating, and Terrain's canonical grid dimensions.

Start a fresh `npx vite --host 127.0.0.1 --port 5335 --strictPort`, then run the
GPU tests sequentially:

```text
npm run smoke:foliage
npm run smoke:foliage-surface
npm run smoke:foliage-ui
npm run smoke:impostor-lighting
node scripts/run-gpu-page.mjs http://127.0.0.1:5335/scripts/gi-gpu-smoke.html 70000
npm run preview:foliage-trees
npm run preview:foliage-wind
npm run profile:foliage
```

The foliage runners create isolated Chromium profiles. For the generic runner,
set `GPU_SMOKE_PROFILE` to a fresh temporary directory if another Chrome profile
is already in use. The GI fixture enables active SRC explicitly and waits for
the irradiance dispatch; a field allocation alone does not establish lighting.
Source ground, wall and emitter meshes are hidden during receiver comparisons,
so their own bright pixels cannot impersonate foliage GI reception. Both captures
use the same compiled material/light graph; a zero irradiance texture is the
control for the real positive field. Removing/re-adding the GI light rebuilds
asynchronous variants and can measure compiler readiness instead of lighting.
Manual render-target captures wait for foliage warmup while the engine loop is
still running, including after moving into the impostor tier. Stopping first
prevents queued preparation from completing and can falsely report zero GI
reception while the irradiance texture itself contains valid light.

Editor verification drives the actual Terrain preset button, module persistence,
density edits, entity surface picker, species presets, real keyboard undo/redo,
and scene reload. Production editor and player builds are also checked. The
repository's broader script-types test retains 17 existing unrelated failures;
the added Foliage registration checks pass.
An unrelated missing array bracket in `architectureEnvironment.js` was also
corrected when it blocked every module-index import during final verification.

GPU measurements and screenshots are written to `artifacts/foliage/`. The
component's `drawCalls` statistic counts selected shared batches before renderer
frustum rejection and excludes extra shadow/GI passes. CPU update timing is
not GPU frame time or an FPS guarantee. Initial procedural generation, instance
uploads and atlas baking have a separate construction cost; this implementation
does not promise hitch-free authoring of maximum-size layers.

### Regression evidence

The surface gate drives the actual production vertex shader, using both a small
uniform-buffer instance batch and a 1,100-instance attribute batch. Twenty
consecutive matrix repacks and draw-count changes preserve roots and radial
blade distances within 0.000006 m. Its served `--old-matrix` arm restores the
previous static/per-object wind reader and fails with a 1.231 m error. This
catches the one-frame towering-grass regression without waiting for it to settle.

The generated-geometry motion gate separately checks 24 consecutive repacks at
capacities 4 and 1,100: grass arc-length error stays below 0.5 micrometres. Its
old rigid-rotation arm fails by 7.61 cm. Flower heads move 15.7 cm while changing
shape by less than 1.5 micrometres; tree roots and branch joints stay attached,
with separate leaf flutter, branch sway and rotating normals. These measurements
establish deformation continuity, not a physical simulation of wood or stems.

The main-render impostor gate uses the component's actual cloned material.
It verifies `alphaTest = 0.35` and compares the cutout with an opaque rectangle.
Testing only the GI override would miss this failure: that override explicitly
copies the alpha threshold even when the main material clone loses it. Near
leaf geometry, native shadows, and all five albedo/normal atlas pairs also have
GPU coverage checks. Scene wind edits reach an already-compiled blade, and zero
scene force and gust return it to rest.

Far wind preserves undeformed atlas coordinates while moving the billboard's
geometry and GI positions. The final regression shifts the tip by 6.9 pixels while
the root strip moves 0.75 pixels and 98.9% of the cutout coverage remains; restoring
the previous projection leaves the silhouette stationary and fails the check.
Full integration also verifies positive GI changes with the source meshes hidden
(31,202 near foliage pixels and 44,632 far foliage pixels on the final fixture).

`smoke:impostor-lighting` compares absolute near/far RGB, including the actual
4-by-64 grass atlas with dark authored color and low ambient light. The neutral
bake uses PI irradiance to avoid applying Lambert's factor twice, retains Three's
already face-correct normal, and pads transparent border RGB/normals within each
tile without changing alpha. Each previous defect independently fails the gate.
Controlled grass matches ambient RGB within 1.3% and directional RGB within
6.1%. Existing in-memory atlases need regeneration after these bake changes.

`scripts/foliage-wind-preview.html` provides grass, flowers, oak, birch and pine
under calm, steady, gusty and strong Scene wind, with a direction control.
`preview:foliage-wind` records grass/flower/oak WebM clips and stills in
`artifacts/foliage/wind/`; each clip switches from a breeze to force 10 / gust 10.

### Camera-motion performance

`profile:foliage` recreates the captured 50 m scene with 7,500 grass plants,
2,000 flowers and 37 trees at 1300 x 724, DPR 1 and MSAA 4. It compares the
previous cell/draw strategy with the current one using identical current tree
geometry and shaders; source hashes must remain unchanged between runs. Both
arms retain every authored plant. Measurements count frames after actual engine
renders and verify that the rendered camera changes throughout a full sweep.
GPU timings are fresh timestamp-query samples, separate from CPU and presented
frame intervals. The isolated browser is uncapped to expose rendering headroom;
this is not a measurement of the editor shell or a universal hardware guarantee.

The original captured scene has no active GI component. Set `FOLIAGE_GI=1` and
`FOLIAGE_ARMS=current` for an explicitly active SRC GI arm, which records its
own field/gather state, nonzero irradiance readback and actual scene wind configuration. Reports and images
are under `artifacts/foliage/performance-*`; use mean, P95 and worst frame time,
not a stationary FPS reading alone. The 120 FPS budget is 8.33 ms per frame.
Initial generation and pipeline preparation are reported separately from steady
camera motion. The generic GI fixture also remains mandatory after TSL changes.

Final measured runs on 2026-09-10 used the same production source hash
`cd2eccab830a0eb7c6e3f0179a139c0c9e549e662831d231dfb37e7217b2f8ac` and
an NVIDIA Lovelace adapter (the browser did not expose its model). These are
isolated benchmark results, not a guarantee for every scene or GPU.

| Camera sweep | Average FPS | P95 frame time | Worst frame | Frames above 8.33 ms |
|---|---:|---:|---:|---:|
| Previous cell/draw strategy, warm, GI off | 151.9 | 10.4 ms | 16.3 ms | 206 / 1,216 |
| Current strategy, first, GI off | 206.7 | 7.1 ms | 13.0 ms | 23 / 1,241 |
| Current strategy, warm, GI off | 205.8 | 7.1 ms | 11.9 ms | 30 / 1,647 |
| Current strategy, first, active SRC GI | 127.9 | 18.5 ms | 214.4 ms | 170 / 769 |
| Current strategy, warm, active SRC GI | 138.5 | 16.2 ms | 125.6 ms | 248 / 1,108 |

Both current warm averages exceed 120 FPS, but neither establishes a strict
120 FPS minimum. Ordinary motion misses the budget in 1.8% of measured frames;
the active-GI stress case still has substantial frame-time spikes.
All current timed windows have zero shader builds or synchronous pipeline
creation. Active GI is verified by about 625,000 nonzero irradiance channels
and actual ray, deposit and gather dispatches. Its 25 fresh warm GPU samples
average 5.3 ms; this is distinct from presented frame intervals. Remaining long
frames include GI pre-render/screen-chain work, GPU queue submission, and pauses
without a recorded owner. The upload fix removes the repeated large foliage
transfers; it does not prove those remaining spikes solved. All authored plants
and shadows remain enabled in the final timings.

Full reports retain intervals, upload/compile activity and GPU samples:
`artifacts/foliage/performance-isolated-{legacy,current}.json` and
`artifacts/foliage/performance-isolated-current-gi.json`.
The final CPU suite passes 60 tests; full foliage, surface, editor UI, impostor
lighting and portable-eight-buffer GI smoke tests pass, as do editor/player
production builds. Tree stills and wind clips were regenerated from the final
production geometry and shaders.

## Grass

Grass is the Foliage component's `grass` species, and it is **drawn, not scattered**. There is no separate grass component: a Foliage population of that species swaps its whole scatter pipeline — prototypes, chunks, LOD meshes, impostors, instance buffers — for the drawn renderer in `grassRenderer.js`. `Drawn grass` off returns it to the old scattered prototypes, which is what a test exercising the batching or LOD machinery asks for.

A drawn sward is drawn, not scattered. The rest of Foliage places prototypes — every plant is a placement in a CPU array, uploaded as instance data, editable and persisted one by one. That is the right contract for a tree and the wrong one for a lawn: an unbroken sward is hundreds of thousands of blades, which no per-instance list can hold, upload or rebuild inside a frame.

A field owns no blades. It draws three instanced rings that follow the camera, and the vertex shader derives every blade from its own instance index:

- **A blade belongs to a world cell, not to an instance index.** Each ring is a jittered grid over a world-aligned lattice; every per-blade value — jitter, height, yaw, lean, colour — is hashed from that cell's absolute coordinate. The grid is only the window currently drawing it, and each ring snaps that window to a whole number of its own cells. ⛔ Hashing from the instance's slot in the current grid instead makes one step of the origin hand every blade its neighbour's values, and the entire field swims across the terrain as the camera orbits. `test:foliage` gates this: a whole-cell step must redraw the same world cells from different instance indices.
- **Cells, not randomness.** One blade per cell, displaced inside it. Pure random placement clumps and leaves holes at exactly the density where a lawn has to look continuous.
- **Rings, and a dense short sward instead of sparse ribbons underfoot (09-13 mass rebuild).** The owner's verdict against Tiny Glade references: structure was right (clumps, lean, darker roots) but the field still read as individual thin ribbons with hard per-blade contrast, and past ~8 m it went flat with no fuzz. Ring 0 (0–5 m, **two** segments a blade — down from three, to fund the other two rings' wider fans) shrinks its own radius rather than the budget to reach **≥1300 blades/m²** at the World's default 480 000-blade budget (~1730/m² at the tuned defaults, `test:foliage` gates the floor). Ring 1 (5–~19 m, one segment) draws **10-blade tuft fans** (up from 8) at **≥900 blades/m²** visual density. Ring 2 (~19–84 m, one segment, extended further for the silhouette below) is now genuinely dense short fuzz — **12-blade fans**, 0.6× ring 0's blade height, a fixed 0.3 m fan width regardless of the ring's own (much larger) cell — so a hillside silhouette keeps a fibrous edge past 20 m instead of reading as flat green ground. Cells in a hole keep their vertices and lose their size — the instance count has to stay the constant the draw call was built from.
- **The 480 000-blade / ≤2.7 M-triangle budget is a hard ceiling.** Triangle cost is exactly `(segments×2−1)×tuft` per instance, so a ring's segment count matters as much as its fan width — ring 0 dropping to 2 segments is what buys the headroom ring 1/2's wider fans spend. At the tuned defaults the whole field costs ~2.64 M triangles (ring 0 ~0.52 M, ring 1 ~1.27 M, ring 2 ~0.86 M): comfortably inside the cap, with ring 1 clearing its 900/m² floor by a margin rather than sitting exactly on it.
- **Ring boundaries are circular and soft, not square (09-13).** ⛔ Owner receipt: "density gets cut off very soon with a rectangle shape." The old cutout measured Chebyshev distance (max of `|x|,|y|`) from a ring's own centre — a square by construction, whatever curve sat on top of it. Each ring now fades on true radial (Euclidean) distance, over a real 3 m-wide band centred on its own boundary radius. The field's true outer edge fades to zero over the last 15% of its own radius, since there is no further ring to hand off to. The packed ground field's own rectangular UV bounds get the same treatment — a hard `step` at its edge is a genuine second rectangle, independent of the ring maths, whenever the field (typically the World's own extent) is smaller than a ring's reach; it now fades over the last 8% of the field on each axis.
  - ⛔ **09-13 FOLLOW-UP OWNER RECEIPT: a dark annulus at ring 0's outer edge.** The first version multiplied each ring's own continuous fade into `coverage`, checked against that ring's OWN independent per-cell lottery — two independent probabilities near a seam (one fading 1→0, the other 0→1) do not guarantee exactly one of them survives at any physical spot, so through the middle of the band both could keep a blade at once and sum their very different native densities into a visibly denser/darker ring. Fixed with the same rule the foliage LOD tier dither already uses: ONE shared coin flip, tested against a THRESHOLD rather than folded into a probability — the two sides of a seam are mutually exclusive by construction, never both, never neither.
  - ⛔⛔ **09-13 THIRD FOLLOW-UP: whole 0.3 m patches — and, in rings 1/2, whole 1-2 m TUFT cells — still dropped out together**, reading as squares and dark holes. A 0.3 m SHARED patch is coarser than a single blade, and it was hashed from the tuft's shared root position, not each fan member's own spot. The lottery key is now `floor(bladeXZ / cell0)` — ring 0's OWN (finest) cell size, pushed to every ring as the `cell0` uniform — where `bladeXZ` is each blade's (or fan member's) own FINAL position including its `slotOffset`, never the tuft's shared centre. Nothing coarser than a single blade ever switches sides, and both rings compute the IDENTICAL hash for the identical world cell since they read the same absolute position at the same fixed scale. `grassBoundaryLottery`/`grassSeamWeight` (`grassField.js`) mirror `grassMaterial.js`'s `boundaryLottery`/`seamWeight` exactly; `test:foliage` gates that many independent boundary-cell samples at a given radius land on the theoretical linear blend of the two rings' native densities within 5%.
- **The outermost ring reaches past its own density share, thinned.** `grassRings({ horizon })` stretches only the last ring's outer radius beyond what its instance share would otherwise cover — the same instances spread over more ground, each cell bigger — so a hill's silhouette fades into thin fuzzy tufts instead of stopping at a hard terrain edge.
- **Ground.** `FoliageComponent.setPackedField(packed)` supplies one RGBA float texture: terrain height, grass density, height scale and dryness. The shader reconstructs it bilinearly at level 0, because float32 filtering is an optional device feature. A population nobody hands ground to derives one from its own placements instead — a hand-scattered or painted patch still draws, at the heights and density its placements describe. **A repeated `setPackedField` reuses the existing material and texture objects** — it used to rebuild every ring's material on every call, which the freeze ledger caught costing 5 s across 257 rebuilds during a few terrain edits; now only a genuine shape change (a field or ground colour appearing/disappearing, not new samples at the same on/off status) rebuilds anything (`test:foliage`).
- **No lattice, and no even carpet.** A blade's jitter spans a whole cell in either direction, so it wanders into its neighbours and the grid stops being visible. On top of that a metre-scale value noise gathers the field into tufts and thin patches — an evenly covered lawn is the other way grass reads as artificial.
- **⛔ Wind bends every blade the same way, in one world direction, and it is signed.** The blade is rotated bodily about the axis across the wind heading, by an angle that grows up its length. Two mistakes are easy here and both were made: folding the wind into the blade's own lean makes each blade sway along its own random axis, so a gust never reads as a gust; and driving the angle from the shared field's force channel — which is a *positive* travelling front — only ever pushes one way, so the field throbs instead of swaying. Grass leans over, comes back through upright and leans the other way. The angle is a signed two-scale swell travelling along the heading, scaled by that front and by the weather's strength, plus a small per-blade flutter so neighbours are never in lockstep. No automated gate: it is shader behaviour.
- **One wind provider.** The field reads `sceneWind(engine)`, which is `engine.windOverride` — owned by Atmosphere when the project has one — and otherwise the scene's own wind setting. Grass, cloth and trees all move with the same weather.
- **Its controls are in the Foliage inspector's `Grass` group** — drawn sward, coverage, blade budget, blade width, lean, blend with ground and the three colours. `Detail distance` and `Draw distance` are the ring boundaries, because that is what they mean; `Impostor distance`, `Cell size`, `Width`, `Plants / m²` and `Plant limit` are scatter-only and hidden while drawing.
- **The glint is not the colour.** A blade is thin and nearly edge-on most of the time, so a standard material's dielectric Fresnel rim lights its whole silhouette — no albedo you choose will remove it, which is why a sward can stay bright and sparkly through every colour picker. Grass is `MeshPhysicalNodeMaterial` for one reason: `specularIntensity` reaches zero (the default now, alongside roughness 1) — the reference has almost no per-blade specular contrast at all. Six controls sit beside the colours, all of them uniforms or plain material properties so none forces a rebuild: **Brightness** (multiplies the whole albedo — the one that actually takes a sward dark, default 0.65), **Root shading** (how dark the litter end is; the default now sits the base at 0.35, tip at 1.0), **Colour variation** (spread between neighbouring tufts; zero is uniform), **Glint**, **Roughness** and **Sky light**.
- **A subtle translucency hook.** A `sun` uniform (direction from a blade to the sun; defaults straight up, i.e. inert) lets the tip pick up up to 15% extra brightness when the sun sits roughly opposite the camera across the blade — a thin blade lets a little light straight through near the tip. Nothing wires the scene's real sun into it yet; a caller passes `sunDirection: [x,y,z]` through `configure()` to light it.
- **Blade scale matches a short dense sward, not a meadow.** Height ranges 0.10–0.28 m (World meadow default 0.18 m), width **0.02–0.03 m** (default 0.022 m, up from 0.016 m — rings 0-1 both land in 0.02-0.028 m through their own `widthScale`) — the reference is 8–25 cm tall, wider fibre than a thin ribbon. Ring 1 is 0.75× and ring 2 is 0.6× ring 0's own blade height. Rest-pose taper is now a rounded, elliptical profile (exponent 0.5, a true circle/ellipse) instead of a pinched point, so a blade tip reads as soft fibre rather than a sharp ribbon end.
- **Shading is for a mass, not for blades (09-13, then a follow-up sun-direction rebuild).** The blade normal blends toward straight up with distance — but not too far, too fast: an initial 90%→100% by 3 m over-corrected into a NEW owner receipt (below). No per-blade specular (`specularIntensity` 0 by default). The root-to-tip AO ramp is linear (was `pow(along, 1.6)`); the combined AO×depth-shading term is clamped as ONE thing, never darker than 0.55 of the tip albedo under direct light (two independent 0.55/0.5 floors multiplied together could still fall to ~0.28). Per-blade brightness quantisation is capped at ±10% (`grass.variation` default 0.2, clamped in-shader) and is hashed from the smooth patch-noise field, never a blade's own cell. Tip colour is clamped in HSL (S ≤ 0.55, L ≤ 0.62) so a picker-chosen vivid/light tip cannot read as a solid poster colour; the derived root additionally desaturates 18% toward its own average before darkening. Sun-facing tips (blade normal toward the sun, not the backlit-translucency view term) get up to a +10% warm lift, weighted to the tip only.
- **⛔ 09-13 FOLLOW-UP OWNER RECEIPT: facing the sun the field washed to a flat pale colour; facing away it read dark and blocky.** Cause: a normal blended almost entirely to world-up shades near-identically under the real scene light regardless of viewing angle, so the only VIEW-DEPENDENT term left in the whole material was the backlit lift — it dominated one direction and vanished in the other, leaving only the (still slightly blocky) front-lit AO/depth terms visible looking away. Two fixes: (1) the up-blend is far less aggressive up close — 0.65 within 3 m rising to 0.95 by 15 m (was 0.9→1.0 by 3 m) — so nearby blades keep more of their own facing and actually vary against their neighbours; (2) the backlit translucency is rebuilt as an ADDITIVE, per-blade, root/tip-structured term instead of a flat multiplier: `T = max(0, dot(viewLookDirection, toSun))³ · (1 − AO) · tBlade · alongLift`, where `tBlade` is a per-blade 0.4–1.0 hash (fan members salted by their own `bladeSlot` too, closing the last of the per-tuft blockiness) and `alongLift` runs root ×0.3 to tip ×1.3 — added as `sunColor × tipColour × 0.45 × T`, so a backlit sward shows bright structured tips over a dim base rather than one uniform glow. A flat hemisphere ambient (sky × 0.6, ground × 0.4, weighted 0.15) floors every blade so a shadowed or away-facing one is never literally black. `grassBladeLuminance`/`grassLuminanceMeans` (`grassField.js`) mirror this exactly for a regression gate: mean luminance over 1000 deterministic blade samples, sun at 30° elevation, facing the sun vs facing away — the ratio stays in 0.8–1.25 (measured ≈1.05), so a camera flip may brighten a real backlit sward somewhat but never washes it out.
- **Patch noise is two-octave GRADIENT noise, not one hard-quantised lattice, and not value noise either (09-13, two follow-ups).** ⛔ Owner receipt: "regular rectangular patches of different colors" — a single-octave value noise (or, worse, a hard `floor(hash×4)/4` bucketing of one) traces its own lattice cell as a visible edge the moment two neighbours differ. First fix: `patchNoise`/`grassPatchNoise` sum two fixed-scale octaves (1.5 m and 4 m, independently salted) with quintic (C2) interpolation between lattice corners. ⛔⛔ SECOND OWNER RECEIPT, close enough (a character-height debug-patch render, isolated from every ring/tuft/field-texel term) to rule out everything else: a checkerboard of ~1 m, world-axis-aligned, HARD-edged squares still came through the "smooth" noise itself. Root cause: interpolating raw HASH VALUES at each corner (value noise) has a well-documented "blocky" character even when C2-continuous — quintic's own derivative is deliberately near zero AT a corner, so the field sits nearly flat at that corner's fully random value for a good fraction of the cell, moving only through the middle. `noiseOctave` (`grassMaterial.js`) and `grassNoiseOctave` (`grassField.js`) now interpolate a GRADIENT direction at each corner instead (classic Perlin noise) — a corner contributes exactly zero there and rises at roughly the same rate in every direction, so there is no per-cell "identity" left to read as a square. `test:foliage` gates both the 0.05 m continuity (worst ≈0.033 unrotated / ≈0.052 after the rotation below, across a 4000-point sweep) and the corner-vs-centre rate-of-change (a corner must not be far flatter than mid-cell, the value-noise signature this replaces).
  - ⛔⛔⛔ **THIRD FOLLOW-UP: still "world-axis aligned" per an isotropy check** (horizontal/vertical vs diagonal gradient energy on the top-down debug panel; `run-grass-preview.mjs` computes and reports `isotropyRatio`). Classic 2D Perlin noise is well known to carry a faint axis-aligned bias from its own SQUARE lattice, gradients or not — it is the reason Ken Perlin later devised simplex noise on a triangular lattice. A first attempt rotated the sample point by a fixed angle before the (still square) lattice — moved the bias off the world's own axes without removing it (≈1.35 → ≈1.34, target ≤1.3 at the time).
  - ⛔⛔⛔⛔ **SIXTH OWNER RECEIPT: replace the lattice, not just rotate the input.** `noiseOctave` (`grassMaterial.js`) and `grassNoiseOctave` (`grassField.js`) now implement actual 2D SIMPLEX noise — skew `F2=(√3−1)/2` / unskew `G2=(3−√3)/6`, three simplex corners (not four square ones) each weighted by the radially-symmetric `(0.5−d²)⁴` kernel, an 8-direction discrete gradient set — replacing the square lattice with a triangular one that has no preferred axis to rotate away from in the first place. A from-scratch, independently-written third implementation of the same published algorithm (built without copying `grassNoiseOctave`, sharing only the underlying hash) agrees with it to 1e-4 across 500 points (`test:foliage`), guarding the two hand-transcribed TSL/JS copies against silent divergence. Measured isotropy: ≈1.33 — closer than rotated Perlin's ≈1.34, but still above the ≤1.15 target. The residual is most likely no longer the COLOUR noise's own lattice at all (simplex's triangular lattice is the standard fix for exactly this and is now provably isotropic in its own arithmetic) but the SURVIVAL LOTTERY and the tuft grid it rides on: `worldCell` for every ring is still a jittered SQUARE instance grid, and which cells survive the density lottery is a binary per-cell decision on that square lattice — a real image's brightness gradient energy responds to blade COVERAGE as much as blade COLOUR, and coverage's own randomness still lives on axis-aligned cells. Not yet fixed; would need decorrelating the grid's own placement (e.g. blue-noise/Poisson-disk jitter) rather than another noise-function swap.
  - ⛔⛔⛔⛔ **FOURTH FOLLOW-UP: the tuft fan's own colour/height/width/brightness read as one value per fan, not per member.** Every fan member shared the tuft's own root position (`world`) for these hashes — correct for coverage/existence and wind (one coin decides if the whole fan grows, one gust moves it), wrong for anything visual, since 10-12 blades all reading the identical noise sample paints one flat patch the size of the fan's own (0.15-0.9 m) cell. `bladeXZ` (`world` plus that member's own `slotOffset`) is now what every colour/height/width/brightness/depth noise read uses; only the survival lottery and wind stay keyed on the shared tuft cell.
- **No grass in the water means freeboard, not distance.** The water surface renders wherever the level stands above the ground, ungated by the channel polygon, so on a wide flat valley floor it floods past the banks. Masking grass on distance-to-channel therefore left blades standing mid-river. The field masks on `height − waterLevel`, eroded over the texel neighbourhood the shader blends across, and the survival gate carries a hard `step(.004, coverage)` floor — `step` passes on equality, so a bare cell whose hash landed on zero still grew a blade.
- **The root of a blade *is* the ground.** Two things have to agree for a sward to meet the terrain instead of standing on it. Its **colour**: the packed field carries what the ground actually renders — the surface maps' own average colours blended by the same masks the terrain material uses, or the procedural palette when there are no maps — and the root takes it (`Blend with ground`, 0.6 by default) while the tip stays grass. And its **shading**: at the root the blade's normal is straight up, exactly like the ground beneath it, turning into the blade's own normal over the first third of its length. Colour alone is not enough — a vertical ribbon and a horizontal surface catch completely different light, so a correctly tinted root still reads as a separate object. The occlusion ramp is gated the same way, because darkening the root would ring every blade in shadow.
- **The ground under a sward is the sward's own MEAN VISIBLE colour, not its root (09-13).** ⛔ Owner receipt: "does not blend with terrain well." `worldPlanData.js` used to converge the ground tint on the blade's derived ROOT tone alone — always the darkest, greenest end of a blade, which a viewer never actually sees in isolation. It now blends ≈0.4×root + 0.6×tip (each given the same dryness lerp toward the dry colour the shader gives a real blade), then multiplies by 0.8 — the mean of the shader's own 0.6–1.0 depth-darkening range — and uses that single mean for both the terrain's own vertex colour (`colors`) and the packed field's ground channel (`groundTint`). The shader's far-field convergence (`groundTone`, `smoothstep(8, 45, distance)` — tightened from 60 m) reads that same packed value directly now (its old ×1.45 brightening multiplier is gone), so ground, mid field and far fuzz all converge on one tone by 45 m instead of the ground running brighter than what the blades themselves fade to, or staying visibly tinted well past ring 2's own fuzz.
- **⛔ No grass in the water, and none within a texel of it.** The field is read bilinearly, so it is not enough for the wet texels to be empty: a blade standing just offshore would pick up a dry neighbour's density. The wet region is dilated by more than one texel before packing, and the margin scales with the grid because that is what the leak scales with. `test:world` samples this the way the shader does.
- **Coverage is separate from the budget.** `Blade budget` is what the field costs to consider; `Coverage` is the share of it that survives, so a sward thins without getting cheaper or dearer. The ground it grows on thins it further.
- **Cost is the blade budget and nothing else.** Three draw calls at any world size, and the population submits no other geometry. The World's default 480 000 blades keeps to ≤2.7 M triangles (ring 0 ~0.52 M, ring 1 ~1.27 M, ring 2 ~0.86 M at the current tuning); the component's own default is also 480 000.

Shape and shading follow the reference this was rebuilt from (SimonDev's grass, section 13): a cubic Bézier bend whose gradient gives the normal; **that normal blended toward straight up with distance**, which is what stops far grass reading as dark noise instead of lit ground; a **view-space widening** so a blade turned edge-on never thins into nothing; a fake occlusion ramp because the litter a sward grows out of is genuinely dark; and per-cell quantised brightness so colour varies in patches rather than per blade. Wind is the shared scene field, so grass and trees move as one weather.

- **⛔ 09-13: THE WIDENING VANISHES FOR A TOP-DOWN CAMERA, AND EVERY BLADE HITS THAT EXACT CASE.** The widening `thicken` term used to be `pow(1-facing,4) * smoothstep(0,.22,facing)` — the extra `smoothstep` factor was meant to taper widening in gently, but it also exactly ZEROES the one value (`facing = 0`) the mechanism exists to fix. From a side-on camera `facing` (a blade's own normal dotted with the view direction) rarely lands on exactly 0, so this went unnoticed; from directly above it is EXACTLY 0 for every blade, always — a blade's normal always sweeps the horizontal plane, perpendicular to a straight-down view, regardless of yaw. No blade ever widened, so the true near-invisible, thread-thin geometry aliased into whatever pixels its raw silhouette happened to cross: a moiré of the jittered grid that reproduced under ANY colour function, noise or a plain positional ramp, and was mistaken for a noise bug at first. `thicken` is now `pow(1-facing,4)` alone (matching the stated intent — maximum right at edge-on, none once the blade faces the camera). The widening AXIS (`cross(up, view)`) has the same failure mode — near-zero and numerically unstable exactly when the view is near-vertical — fixed with a tiny nudge that is negligible for the ordinary side-on case.

Where a World is present it packs the field from the same samples its terrain was built from — grass on dry, unpaved, unshaded, unstony ground, taller and greener where it is damp — and **the scattered short and long sward stands down entirely**: the drawn field is the World's grass now, and the scatter keeps only the bank reeds and the meadow flowers, which are distinct silhouettes worth an individual plant. That takes a default 128 m world from about 31 800 scattered ground plants to 600. `test:foliage` covers the ring layout, the blade strip, the packed field round trip, resource ownership, camera snapping and the node graph building with and without ground; `test:world` covers the integration.

Not yet done: the field does not cast shadows, has no per-blade texture, and its density comes only from the packed field — a paint brush for it is future work. `scripts/run-grass-preview.mjs` (+ `scripts/grass-preview.html`) renders a flat meadow at eye height and from 15 m up, following `scripts/run-foliage-tree-preview.mjs`'s pattern, but no GPU receipt from it has actually been captured yet — starting a local dev server to drive it was refused in the session that wrote this.
