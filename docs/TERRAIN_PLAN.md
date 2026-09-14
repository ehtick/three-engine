# Terrain generation rebuild + chunk streaming

Owner brief (09-14): the procedural terrain "has too many confusing settings and the result is always
awful and unnatural". Wanted: natural, multilevel terrain with relief, hills and cliffs; exaggerated
fantasy (Elden Ring) *and* neutral meadows; much better procedural rock, including whole stone
structures; several algorithms chosen by style. Follow-up: "consider performance and scale … split the
world in chunks so we can stream chunks into existence as we move around. It should be governed by the
World component."

## 0. Why the old terrain looked the way it did

- One analytic sum: value noise (square plateaus per octave) + a fixed landform curve + Gaussian
  "ridges" + quintic "escarpments". Every feature was a bump with a profile, so cliffs were ramps and
  ranges were blobs; nothing was *structured* (no benches, no drainage, no strata).
- 12 terrain controls + 12 "Landforms" controls + erosion, with relation clamps between them
  (`ridgeWidth ≥ 1.4 × amplitude`, footprint ≥ 2.5 × height) that existed to stop the profiles from
  producing fins. That was the confusion the owner saw.
- Rocks were 6-8-sided jittered prisms and icosahedra, capped by tests to "never pillars" — so no
  cliff walls, spires or arches could exist at all.
- Erosion ran on the whole grid, which also makes chunking impossible.

## 1. Architecture (landed in Node, 09-14)

`src/engine/terrain/landscapeGenerator.js` — style recipes → a landscape with `sample(x, z)`.

| Layer | What | Where it runs |
|---|---|---|
| MACRO | style forms (fBm / ridged multifractal / gradient-damped fBm / tilted Voronoi plates) through a domain warp → stream-power erosion (existing `terrainErosion.js`) → drainage map → channels carved along drainage → priority-flood depression fill → blurred reference grid | once per (style, seed, extent, controls), ≤ 257² cells, 0.3-1.3 s — a worker |
| DETAIL | pure function of (x, z): bicubic macro read, per-point plate sharpening, tiers gated by relative elevation and regional patches, towers (world-space lattice), fine fBm (ridged + elevation-gained for alpine), downhill gully stripes, strata banding on steep faces | per chunk sample, 2-6 µs/sample |

Because DETAIL is pure and MACRO is global-but-coarse, **any chunk is generated alone and matches
its neighbours bit-for-bit** (`tests/landscape-generator.test.mjs`).

Styles (a table row each): `meadow`, `hills`, `highlands`, `alpine`, `canyon`, `karst`, `shattered`.
Controls (`LANDSCAPE_CONTROLS`, 7): `style`, `height`, `scale`, `levels`, `wildness`, `erosion`,
`rocks`; each style maps 0..1 into its own range, .5 = its designed look.

Masks from `sample`: `cliff` (tier riser / plate fracture / tower flank), `tower`, `channel`, `flow`,
`tier`. `landscape.towers(rect)` lists tower features for rock wrapping.

Stone: `src/engine/rocks/`
- `rockSdf.js` — SDF builders: `boulder`, `slab`, `ledge`, `spire`, `columns` (basalt), `arch`, `wall`
  (jointed block row, or columnar). Fracture planes (tight smooth-max), domain warp, irregular bedding.
- `surfaceNets.js` — typed-array surface nets with narrow-band skipping, SDF normals, cavity AO.
- `rockLibrary.js` — N variants per kind at canonical size, voxel from a triangle budget
  (boulder 3.5k … columns 22k). Built once per (seed, kinds); instanced everywhere.
- `rockPlacement.js` — per chunk, world-lattice anchors in half-open chunk rects (no duplicates, no
  neighbour reads): walls snapped onto cliffs and sized to the measured drop, spires wrapping towers
  and lone hoodoos, rare arches beside cliffs, ledges/slabs on steep grass, talus below cliffs.

Receipts (the orchestrator LOOKS at these before calling a unit landed):
- `node scripts/landscape-receipt.mjs --styles highlands --view low --rocks 1 --out <dir>`
  (CPU ray-march + rasterized rock library + hillshade)
- `node scripts/rock-receipt.mjs --out <dir>` (contact sheet of every kind, the shipped meshes)

## 1.1 Status (09-14 end of session)

Landed and green (`npm run test:world` 158 + 1 pre-existing todo, `test:foliage` 198,
`test:architecture` 107, `terrain-sculpt` 5, `check:types` unchanged at 110 pre-existing):
- Generator, stone library, placement, receipts (section 1), `tests/landscape-generator.test.mjs`.
- T2 core: Terrain Procedural group = seed + the 7 controls; `proceduralExtent` / `proceduralOrigin`
  (chunk tiles, seam test); `stoneLayer` + instanced stone (`src/modules/terrain/terrainRocks.js`);
  `terrain.create` MCP op takes `style` + controls.
- T3 core: World Terrain group derived from the same table (defaults `hills`, height .7 — a 128 m
  hills plot at height 1 seats 2 of 12 cluster houses); Landforms group deleted; legacy documents
  migrate (`worldDocument.js#migrateLegacyTerrain`); `landscapeShape.js` adapts the landscape to
  `createValleyFields`; World's erosion pass removed; World stone = same builder with World heights
  and water/road/pad exclusion. `tests/world-cliffs.test.mjs` retired; spire-rock tests retired.
- Fixed on the way: road T-junctions now share a vertex (`worldLayout.js#splitAtCrossings`), gully
  filter seams (compact kernel) and crest-steering spikes, tier riser clamp kink, surface-nets
  low-side holes.

09-14 live attempt 1: creating a 512 m highlands Terrain (rocks .6) in the shared editor was followed
by a page reload (no watchdog reloads the page; cause unproven — another session's reload or a lost
device). Headless it blocked 3.5 s on attach and drew 7.1 M stone triangles. Fixed and re-measured
headless (512 m, res 256, rocks .6):

| | attach | worst slice | stone tris |
|---|---|---|---|
| before | 3470 ms (sync) | — | 7.1 M (highlands) |
| after | 38-78 ms | 36-66 ms | 0.83 M karst · 1.22 M highlands · 1.35 M canyon · 2.05 M shattered |

How: flat attach + sliced fill when a frame loop exists (sync headless), sliced library meshing
(`meshSignedDistanceSteps`), placement in 4x4 sub-rectangles (exact by the chunk contract), columns only
for styles that place them, triangle budgets cut ~3x, wall lattice 7 -> 12 m. A sliced fill now
announces `terrain-surface-changed`.

09-14 live attempt 2 (after reload): a 512 m highlands Terrain (seed 7, rocks .6) attached, filled over
10 slices during boot, painted its style ground (new `src/modules/terrain/terrainGround.js`: slope ->
rock, hollows -> soil, top of relief -> snow; replaces the untextured default that blew out white) and
built its stone. Screenshot: green benches, stone walls on the risers, snow crest, talus. 120 fps,
35 draws in view. One 210 ms `frame:preRender` block seen during the fill (a landscape stage that does
not yield: blur / depression fill). Test entity deleted afterwards.

NOT done / owed:
- The 210 ms landscape slice above; stone walls still read as a row of blocks at mid distance.
- Slices still overrun the 6 ms budget to ~40-65 ms (one surface-nets z-slab / one placement cell).
- 1-2 M stone triangles per 512 m terrain is still too many without distance LOD (T4).
- **Live receipt**: nothing here has been seen in the WebGPU editor (the shared editor was not
  reloaded). Owner screenshot per style is the gate for T5.
- Stone: no physics colliders yet; simple vertex-colour material; library meshing runs on the main
  thread (~1-2 s once per style) — move into the World worker; GI seats instanced rocks (set
  `giTrace` per T4 item 8); no far LOD selection (library can emit LODs, `lodShares`).
- Standalone Terrain ground material is still the splat material (no slope/snow procedural ground).
- T4 streaming entirely.

## 2. Phases

### T2 — Terrain component uses the landscape (standalone)
1. `TerrainComponent` Procedural group = `procedural`, `proceduralSeed`, then `LANDSCAPE_CONTROLS`
   (generated rows, like today's table rows). Delete the 12 old rows. Migration on load: an old
   `landform` maps to a style (`plains|basin → meadow`, `valley|slope → hills`, `highland → highlands`,
   `plateau → canyon`, `ridgeline → alpine`); old keys are dropped silently.
2. New props: `proceduralExtent` (landscape extent, default = `size`) and `proceduralOrigin` `[x, z]`
   (this tile's centre inside the landscape, default `[0, 0]`) — a chunk tile is just a Terrain whose
   origin is not zero. `fillHeightfield` samples `origin + local`.
3. The landscape object is cached per `(style controls, seed, extent)` in a module-level LRU (2
   entries) so N tiles share one macro build.
4. Stone layer: when `rocks > 0`, Terrain builds the rock library (sliced generator, yields on the
   clock) and places rocks over its rect; renders one `BatchedMesh` (or one `InstancedMesh` per
   variant if BatchedMesh misbehaves on WebGPU) as a non-serialized child. `giTrace` receive-only
   beyond 60 m is decided in T4; for T2 rocks are ordinary static meshes.
5. Rock material: extend `worldLandscape.js#makeRockMaterial` — triplanar stone with bedding along
   world Y, `occlusion` attribute multiplied into albedo and AO, moss/grass tint on `normal.y > .7`
   with the style palette. One material per terrain.
6. Ground material for a standalone procedural terrain: slope → rock, flow → soil, snowline → snow,
   palette from the style (vertex colours, same approach as World's ground).
7. Physics: rock colliders = one convex hull per variant, instanced per placement with scale (Rapier
   convex with scaled points); heightfield collider unchanged.
8. MCP: `terrain_create` accepts `style` + controls; `component_setProp` covers the rest.
9. Tests: `tests/terrain-procedural.test.mjs` rewritten for the new props (determinism, sliced fill,
   sculpt delta survives a style change, overlay samples verbatim, origin offset tiles seamlessly).
   Receipt: one live screenshot per style at walking height, **with the owner's permission**.

### T3 — World uses it (single extent, no streaming yet)
1. `worldConfig.js` Terrain group derives from `LANDSCAPE_CONTROLS`; the **Landforms group (12
   ridge/cliff controls) is deleted**; `documentVersion` bump + migration that drops them.
2. `createValleyFields` takes the landscape: `shape.evaluate(x, z, out)` adapter over
   `landscape.sample` (height, gradient by central differences at 0.5 m, `outcrop = cliff`,
   `upland = relative elevation`, `n0/n2` from the landscape's own noise). Water/banks/roads/pads
   composition is unchanged.
3. `worldPlanData.js` erosion block is removed (the landscape already eroded).
4. `worldLandscape.js#createLandscapeRocks` is replaced by the library + placement.
5. Tests to retire (they pin the deleted analytic landform): `world-cliffs.test.mjs`,
   `world-spires.test.mjs` rock-shape cases, the C1 ridge/escarpment cases in
   `terrain-procedural.test.mjs`. Settlement/road/water tests stay and must pass on the new shape
   (update seed-exact expectations only where a test asserts a specific siting, and say which).

### T4 — Chunk streaming governed by World

**T4 step 1 (09-14, landed in Node):**
- `src/engine/world/chunkGrid.js`: aligned chunk size (the World region is a whole number of chunks),
  desired chunks within the radius, nearest first, LOD ring by distance, central square excluded.
- `src/modules/terrain/terrainTile.js`: sliced tile build (positions, normals, style ground colours,
  skirts) from a padded grid, so same-LOD neighbours match bit for bit (test); skirts hide LOD cracks.
- `src/modules/world/worldStreaming.js` `WorldStreamer`: plain meshes under the World object
  (`giTrace:'none'`, no entities/events/undo), one build at a time on the frame budget, the old tile
  stays until its new LOD is ready, eviction at radius + half a chunk, stone instanced across chunks
  within `rockRadius` (library sliced).
- World settings group **Streaming**: `streaming.enabled` (default off), `streaming.extent`
  (1024-8192), `streaming.radius`, `streaming.chunkSize`. With streaming on, `planTerrain` cuts the
  authored region from the streamed landscape (`landscapeExtent`), so tiles and region are one ground.
- `WorldComponent`: `_syncStreaming` after each commit (streamer kept unless landscape/streaming
  settings changed), `_updateStreaming` per frame from `engine.camera` in the World's frame, disposed
  with the plan; hidden with the World.
- Tests: `tests/world-streaming.test.mjs` (grid coverage/no overlap, tile seams, lifecycle/eviction,
  streamed stone, plan landscape extent).

**Live receipt 09-14** (owner's "Temperate valley", extent 192, streaming 2048 m / radius 1024 / chunk
128→96): the valley sits in a continuous streamed landscape to the horizon. Settled: 113 fps, 7.8 ms
CPU, 244 draws, 4.6 M triangles, heap back to 670 MB. Headless replay of the same load: 262 tiles
(48/76/138 per LOD), 110 frames, 0.7 s CPU total, worst frame 14 ms, 12.8 MB of tile attributes. The
573 ms freeze and 1.4 GB of GPU writes seen during the switch coincided with the valley's own
regeneration (re-sited houses/foliage), not with the streamer, whose whole output is ~13 MB — not
proven by attribution.

**T4 step 2 (09-14): streamed-ground physics.** `src/modules/world/worldStreamPhysics.js` — one fixed
body + heightfield collider per LOD-0 chunk within `physicsRadius` (160 m), added/removed as the camera
moves, owned through the physics RIG contract (`WorldComponent.physicsRig`, `buildRig`/`clearRig`), so
colliders exist only while the physics world does and are rebuilt from remembered tiles on the next Play.
Hits report the World entity, on the `Ground` layer. Same row/column convention and centring as
Terrain's own heightfield. Receipts: fake-physics lifecycle test (near-only, follows the camera,
Stop/Play, dispose) and a REAL Rapier test (`tests/world-stream-physics-rapier.test.mjs`: rays land on
the tile surface, nothing outside the chunk, Stop frees the body). Streamed stone has no colliders yet.

**T4 step 3 (09-14): region border seam.** Live probes in Play (`world.streamingStatus` with `probe`,
new MCP op) showed streamed ground colliding (owner = the World) and the valley Terrain inside, but a
step at the border: headless along the whole edge, mean 0.96 m, 34/388 samples over 1 m, worst 15.2 m
beside a border lake. Cause: banks and shoulders never rejoin the raw landscape before the edge. Fix in
`landscapeFields.js`: with streaming on (`terrain.landscapeExtent > extent`) the composed ground eases to
the raw landscape over `borderBlend` (15 % of extent, ≤ 32 m) after banks and before roads/pads, and a
road stops grading over the last `BORDER_EDGE` (4 m). Pads stay exactly level (siting keeps lots inside
the region). Test: every border sample equals the landscape. Caveat: a lake touching the border keeps
its water plane while the ground under it eases down — a floating water edge is possible there.

**09-14 owner round: Play froze; bare meadow patches.**
- Freeze (owner: "the whole world was building and streaming was building all at once"): streaming now
  only builds while the World is `Ready`; the landscape macro build is warmed sliced (`getLandscapeSteps`)
  in `worldLayoutSteps` and in the main-thread `worldPlanSteps` (it was one 0.6-1.3 s block inside the
  first field evaluation); the terrain adapter samples the landscape 5 times per evaluate, not 9; route
  search checks the clock every 16 cells (was 256: a 1.8 s block); road grading samples in slices.
  Headless valley layout: worst slice 1812 ms → 442 ms (settlement planning, still synchronous; it runs
  in the plan worker when one is available).
- Bare patches: 54 % of the valley's dry land had no grass, 90 % of it from the packer's freeboard gate
  (ground below the NEAREST water body's level). The water shader draws only inside the outline
  (`maskNode: shore < 0`), so that ground is visibly dry. The gate now applies only within ~6 m of the
  shore; the World grass test's "wet" definition was updated to the drawn water. Test: open dry meadow
  below a lake level stays grassed.

Still owed from the list below: worker builds (2), foliage/grass feed (6), sparse edits (9),
authored-region seam (World banks/pads at the region edge are not blended into the tiles), live receipt.

Original design:
Findings that shape it (09-14 survey): layout/water/grass/ecology are sized to one origin-centred
square ≤ 512 m; Terrain has no origin, skirts or LOD; `terrainEdits` are global vertex indices; the
water shader ignores mesh origin; GI resyncs the whole static BVH whenever the mesh set changes; several
Terrain entities side by side already work for physics and architecture.

1. **Chunk grid**: World settings `chunkSize` (128 m default), `streamRadius` (m), world `extent` up to
   8192 m. Desired set = chunks intersecting the camera circle (editor camera in edit, game camera in
   play), hysteresis 0.15 × chunk.
2. **Worker service**: `worldChunk.worker.js` holds the landscape (built once from the document) and
   answers `{ix, iz, resolution}` with heights + masks + rock placements + ecology placements as
   transferables. Main thread never samples the landscape for streamed chunks.
3. **Tiles**: runtime-only entities (not serialized, hidden in Hierarchy under the World) carrying a
   Terrain with `proceduralOrigin`, LOD rings by distance (resolution 128 / 64 / 32), skirts
   (vertical strip at each border, depth = 2 × local relief step) to hide LOD cracks.
4. **Budget**: ≤ 1 chunk commit per frame, ≤ 4 ms main-thread per commit (geometry upload + normals);
   generation entirely in the worker. Far chunks drop rocks below a projected-size threshold.
5. **Rocks**: one library per World; chunk placements appended to per-variant instance buffers
   (BatchedMesh add/remove instance), not per-chunk meshes.
6. **Foliage**: one Foliage component per population with a runtime placement feed
   (`setStreamedPlacements(chunkKey, placements | null)`), merged into its internal 24 m chunk grid,
   never serialized. Grass: one meadow component whose packed field is re-packed around the camera when
   it moves > ¼ field extent.
7. **Physics**: heightfield + rock colliders only within 192 m.
8. **GI**: streamed tiles and rocks are `giTrace: 'none'` outside the GI volume; entering/leaving must
   not trigger `#syncBvhScene` (fingerprint excludes streamed objects). Needs a GI-side unit.
9. **Edits**: `terrainEdits` become sparse per chunk `{ "ix,iz": {resolution, indices, deltas} }`;
   migration converts the old global form for extents ≤ 512 m.
10. **Layout** (settlements/water/roads) stays one central authored region in T4; placing
    settlements across a streamed world is a later phase.
11. Gates: walk at 10 m/s across 4 km with no frame > 33 ms from streaming (`profile.freezes`),
    ≤ 60 fps floor held, seam test (heights identical on shared borders across LOD rings after skirts).

### T6 — The World's content in chunks (09-14)

Owner: "we have terrain chunks expanding far, but we don't have the world extending far. Also, terrain must
account for rivers and lakes. Make world know about terrain chunks, and build buildings, rivers, grass, trees
etc there" and "we need a precise memory management here — we load what we see, what is left behind gets
unloaded".

**W1 Hydrology in the landscape** (`src/engine/terrain/landscapeHydrology.js`, new `water` control 0..1,
option `reserve`). Macro stage after the depression fill: lakes = basins under their spill level (kept +
dug on flat valley floors), sharing a coverage budget (≤ 7 % of the land at water 1; an oversized basin
floods only its largest low piece at a lower level); rivers = D8 drainage of the graded surface with a
flat-tie jitter, reaches traced source→mouth (end at lake / confluence / edge / reserve), Chaikin-smoothed
plus a slope-scaled meander, surface = running minimum of the ground (only descends), tributaries land on
the level they join, width ∝ √catchment. Per point (end of `sample`): lake bed clamped under the level, a
held rim just outside, parabolic river bed + banks + low levee (smooth min/max, C1). Outputs `water`,
`waterDepth`, `shore`, `flowX/Z`, `wet`. A World region is `reserve`d (it keeps its authored water):
`worldLandscapeOptions()` is the ONE options builder for every World call site; region Terrain gets
`proceduralReserve`. Receipts (2048 m, seed 7): 3-4 lakes, 7-9 reaches per style, ~4 % wet, +0.2-0.5 µs
per sample. First count put 29-35 % of the land under water (budget added) and 0-5 reaches (threshold
lowered); straight D8 reaches on filled flats and slopes (jitter + meander).

**W2 Streamed water** (`landscapeWater.js` builder, `worldStreamWater.js` material): lakes as a flat grid
on a world lattice (2/4/8 m by LOD), river ribbons per segment owned by the chunk holding its start point;
attributes carry depth/flow/edge (no extent-bound textures). Test: four chunks draw exactly the triangles
of their union.

**W3 Residency** (`worldStreaming.js` rewrite): per-chunk layers ground / water / rocks / plants (+ LOD-0
colliders), each with its own reach; loading in priority order (distance, ×2.5 outside the camera's view
cone, replanned on move or a 20° turn); a layer is released the moment its chunk leaves its reach
(geometry disposed, instance buffers shrunk, foliage groups withdrawn); `memoryBudget` (World setting
`streaming.memory`, MB) sheds plants → stone → water from the lowest-priority chunks. `stats().memory`
= exact bytes per layer (test checks it against the live arrays).

**W4 Streamed plants** (`landscapeEcology.js`, `ecologyPopulations()` shared with the valley scatter):
world-lattice candidates, chunk-exact (test), habitat from landscape + hydrology; fed into the World's own
foliage populations through `FoliageComponent.setStreamedPlacements(chunkKey, placements|null)`
(incremental: 3-7 ms add, 1-2.5 ms remove vs 40-85 ms full rebuild; `memoryBytes()`). With streaming on
the valley keeps empty populations alive (`keepEmpty`).

**W5 Streamed grass** (`worldGrassWindow.js`): one camera-centred window field (region field copied inside
the region, landscape terms outside), re-packed sliced at 2 ms/frame when the camera moves a quarter
window, handed over in place (no material rebuild).

**W6 Settlements in chunks** (`src/engine/world/landscapeSettlements.js`, `worldStreamBuildings.js`, World
setting `streaming.villages`). 640 m cells; a cell may hold one hamlet sited by hash, planned by the
valley's own `planSettlements` on a 256 m window of the raw landscape (15-31 ms per hamlet, measured); the
window and every feather lie inside the cell, so a plan is a pure function of the cell (test: two load orders,
identical villages). Lanes graded (smoothed ground, grade-limited, side streets land on their street);
`composeLandscape()` folds lanes (the valley's corridor profile) and pads (its rounded-rectangle blend) into
every sample, so tiles, colliders, water depth, plants, grass and stone all see them; tiles paint lanes and
plots as packed earth; plants and stone use `settlements.blocked()`. The streamer resolves a chunk's cells
as a `sites` job before its layers, and a `buildings` layer (within 900 m) instances them: full cottage
study near (≤ 140 m, shared 8-variant library, built on demand once: 33-88 ms, 19-24 k tris, 2.4-3 MB each,
released when nobody is near) and a ~20-tri walls-and-gable silhouette far. Far plans are pruned.
`stats()` adds `buildings`, `hamlets`, `memory.buildings`, `memory.sites`.

Tests (`tests/world-streaming.test.mjs`, 12): tile seams, lifecycle, stone, colliders, water exactly once
per chunk set, plants chunk-exact and dry, residency (in-view first, released behind, bytes equal the
live arrays, budget shedding, dispose to zero), settlements (order independence, level pads, graded
lanes, no plant on a plot, village unloads), border seam, meadow grass, plan extent.
`tests/landscape-generator.test.mjs` (10): rivers only descend, lakes contained, reserve keeps no water.
Types 110 (unchanged).

Owed after this batch: live receipt (owner's valley); region adopting landscape hydrology (today a
river reaching the region fades out across `RESERVE_FADE`); grass density seam at the region border;
worker-built chunks and cottage variants (the 33-88 ms variant build is one main-thread block);
building and stone colliders; streamed lanes connecting villages to each other and to the region.

### T5 — Look pass live
Rock material tuning (bedding scale per style, moss, wetness), ground blends, snow, far-field
impostor for streamed rocks. Owner screenshots decide.
