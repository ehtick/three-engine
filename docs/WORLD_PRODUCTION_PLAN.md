# World: production-look program

Date: 2026-09-13. Owner brief (verbatim intent): the World component must govern Terrain, Foliage,
Atmosphere, Water, Architecture and GI into ONE coherent, production-ready environment — not a
blockout — in both realistic (KCD2 / RDR2) and stylized (Tiny Glade / Townscaper) directions, for
nature (forests, valleys, lakes) and small towns. Few controls, artistic ones only; it must look good
at every setting. Editing any parameter must be smooth, no freezes. Each provider component stays
individually tunable afterwards. A simple node-graph front end drives the generator. Assets are
procedural where they can be good; otherwise free (CC0) packs fill the props.

Execution model: the orchestrator (Fable) plans and reviews; executors (GLM via `model:"haiku"/"sonnet"`)
implement from the briefs below. Every brief is self-contained: anchors, interface, tests, self-check.
Executors run `npm run check:types` and the named test scripts; the orchestrator runs the live editor.

## 0. Findings the program is built on (09-13 surveys)

- World (`src/modules/world/worldPlan.js:301-330`) emits `terrain | water | rocks | foliage |
  foliage/meadow | building | atmosphere`. Buildings are the baked `worldCottage.js` study (4
  families) or, with `settlement.editableBuildings`, a massing-only architecture `model`
  (`cottageArchitecture.js`). Style is a two-value enum `natural|stylized` branched ad hoc.
  World sets Atmosphere `{timeOfDay:14, weather:'fair', dayLength:0, precipitation:false,
  cloudShadows:false}` (`worldPlan.js:330`). 88 controls in 9 groups (`worldConfig.js:32-138`).
- Architecture model = `{forms[box|round, roof hip|gable|flat|none], paths[], openings[window|door|arch]}`
  (`formModel.js:17-48`). Geometry is plane-clipped convex solids with a skin (`formGeometry.js`),
  flat colour per role, planar UVs, NO detail (no eaves, tiles, frames, sills, shutters, timber,
  chimneys, dormers, plinths). All of that exists only in the baked cottage. Whole-model rebuild
  per edit with a per-form LRU cache (`formGeometry.js:288-330`).
- Foliage trees: hand scaffold + bounded space colonisation (`treeGrowth.js`), golden-angle
  pinwheel leaders (`:46,52,68,73`), one shared crown attractor (`:104-113`), 3 real species,
  4 leaf atlas tiles. LOD is per CHUNK (up to 1024 plants) with chunk-relative thresholds
  (`foliageLod.js:13-37`) and a hard `visible` toggle (`FoliageComponent.js:773-786`); impostors
  (16-view octahedral, 64 px, `FoliageComponent.js:79`) pop in scene-wide when the single
  species bake resolves (`foliageLod.js:36`). Grass is a separate drawn field (by design, keep)
  with its own bend math and shading (`grassMaterial.js`) that does not match `foliageMaterial.js`.
- Atmosphere: Preetham sky, 4-slice clouds, height fog, cloud shadows, rain/snow. Post nodes
  (bloom, god rays, volumetric fog, lens flare, tone map) exist in
  `src/modules/postprocessing/postGraph.js:344-802` but nothing wires them. No aerial
  perspective on geometry, no exposure adaptation.
- Sun motion cost chain: `_applySun` re-aims the light every 0.023 deg (`AtmosphereComponent.js:90,
  1044-1050`) which redraws the CSM cascades; GI re-lights every 0.25 deg (`GISystem.js:135,16294-16306`)
  and never rests while the clock runs; sky refill/PMREM are already gated (1.5 deg, 1.2 s).
- Camera rotation: GI g-buffer fingerprint folds both camera matrices (`GISystem.js:4796-4808`);
  CSM refits every frame; foliage `_updateBatchOrder` rewrites EVERY chunk's instance buffers in
  one frame at each 30/45 deg bucket crossing (`FoliageComponent.js:609-676`, `foliageBatchOrder.js:4`).

## 1. Phases

| Phase | Deliverable | Briefs |
| --- | --- | --- |
| 1 | Foundations that fix the visible faults in isolation | P1-A trees, P1-B LOD crossfade, P1-C sun/rotation perf, P1-D..H architecture styles |
| 2 | World coherence: style presets, buildings as styled models, settlement massing grammar, ground/road surfaces, atmosphere look | P2-* |
| 3 | Ground cover unification (flowers/ferns/clover in the drawn field), shared foliage shading | P3-* |
| 4 | World graph panel (few nodes, table stays the law) and control reduction | P4-* |
| 5 | Props from CC0 packs (Poly Haven realistic, Poly Pizza stylized) placed by context rules; polish | P5-* |

Acceptance for every phase: `npm run check:types`, the named `test:*` scripts, no new freeze > 50 ms
in the live editor (`profile.freezes`), 60 fps floor kept (`profile.frameStats`).

## 2. Interfaces shared by several briefs

### 2.1 Building description (consumed by all style decorators)

`describeBuilding(model, opts) -> BuildingDescription` (new export of `formGeometry.js`), computed
AFTER the exposed faces and cut openings are known. All coordinates are model-local metres, Y up.

```
BuildingDescription {
  forms: [{ id, shape, position:[x,y,z], size:[w,h,d], rotationY, roof, roofAxis, roofHeight,
            storeys: number,                // round(h / 2.8) min 1
            base: number, top: number }],   // y of floor slab and of eave line
  walls: [{ id, formId, polygon:[[x,y,z]...], normal:[x,y,z], tangent:[x,y,z], up:[0,1,0],
            origin:[x,y,z],                 // bottom-left corner in the face frame
            width, height,                  // face extents along tangent / up
            exterior: boolean,              // false if this face is shared with another form
            openings:[{ id, kind:'window'|'door'|'arch', u, v, width, height }] }], // face-local, bottom-left
  roofs: [{ id, formId, kind:'hip'|'gable'|'flat', pitch: radians, axis:'x'|'z',
            ridge:[[x,y,z],[x,y,z]] | null, eaves:[{ a:[x,y,z], b:[x,y,z], outward:[x,0,z] }],
            slopes:[{ polygon:[[x,y,z]...], normal:[x,y,z], downhill:[x,y,z] }],
            gables:[{ polygon:[[x,y,z]...], normal:[x,y,z] }] }],
  footprint: [{ formId, edges:[{ a:[x,0,z], b:[x,0,z], outward:[x,0,z], groundY:number }] }],
  seed: number
}
```

Every decorator is a pure function `(description, style, rng) -> { role: BufferGeometry[] }` where
role is one of `wall | roof | trim | timber | stone | glass | door | chimney | metal`. Geometries are
merged per role by the integrator and get the style's material for that role. Decorators import
only `three` and `styles/rng.js`; they must run in Node (tests) with no renderer.

### 2.2 Style record (`src/modules/architecture/styles/catalog.js`)

```
Style { id, label, family:'realistic'|'stylized',
  palette: { wall:[hex...], roof:[hex...], trim:[hex...], timber:[hex...], stone:[hex...], door:[hex...] },
  roof:   { surface:'tiles'|'slate'|'shingles'|'thatch'|'metal'|'plaster', pitch:[min,max] rad,
            overhang: m, fascia: boolean, ridgeCap: boolean, bargeboard: boolean,
            chimney: 0..1 (probability), dormer: 0..1 },
  walls:  { surface:'plaster'|'timber-frame'|'stone'|'brick'|'plank'|'log',
            plinth: m (0 = none), quoins: boolean, cornice: boolean, stringCourse: boolean,
            timber: { spacing: m, braces: boolean, sillBeam: boolean } | null },
  openings:{ window:{ frame: m, sill: boolean, shutters: 0..1, mullions:'none'|'cross'|'grid', arch: 0..1 },
             door:  { frame: m, lintel: boolean, step: boolean, arch: 0..1, planks: boolean } },
  detail: 0..1   // stylized styles keep detail low and edges clean; realistic push jitter/wear
}
```

Catalogue (v1): `timber-medieval` (KCD2 half-timber, thatch/tile), `stone-cottage` (English/
Alpine stone, slate), `plaster-mediterranean` (white plaster, terracotta tiles, arches),
`wood-frontier` (RDR2 plank + shingle, porch-ready), `nordic-log` (log walls, turf/shingle),
`townscaper` (flat pastel plaster, clean edges, simple tile roofs, no jitter), `tiny-glade`
(cozy plaster + stone, rounded, warm palette). `family` says realistic or stylized.

### 2.3 Style surfaces (`src/modules/architecture/styles/surfaces.js`)

`styleSurface(kind, seed, {size, flat}) -> { map, normalMap, roughnessMap, repeat:[u,v] } | null`
for `plaster, brick, stone, plank, log, tiles, slate, shingles, thatch, metal, glass, timber`.
Canvas-generated like `src/modules/foliage/foliageSurfaceTexture.js` (procedural courses, mortar,
grain, colour variance), 512 px default, cached by `(kind, seed, size, flat)`. Node (no canvas)
returns `null` and the caller falls back to flat colour. `flat:true` (stylized family) gives a
near-uniform albedo with only a soft normal.

## 3. Phase 1 briefs

### P1-A: Realistic trees, Weber-Penn parametric model with species presets

Files: `src/modules/foliage/treeGrowth.js` (replace the growth core; keep the exported names and
the params the component sends: `height, width, seed, leafDensity, leafSize, branchDensity,
crownBase, crownSpread`), `src/modules/foliage/foliageGeometry.js` (consume the new skeleton;
leaf clusters), `src/modules/foliage/foliageSurfaceTexture.js` (8 leaf tiles per species instead
of 4, two bark variants), `src/editor/foliagePresets.js` (presets), the schema `species` list in
`FoliageComponent.js:129`. Tests: `tests/tree-quality.test.mjs`, `tests/foliage-geometry.test.mjs`
(`npm run test:foliage`). Preview: the script in `package.json` that runs
`scripts/run-foliage-tree-preview.mjs` renders trees headless; use it to judge shapes.

Implement Weber and Penn 1995 ("Creation and Rendering of Realistic Trees"), levels 0..3:
- Global: `shape` (0 conical, 1 spherical, 2 hemispherical, 3 cylindrical, 4 tapered-cylindrical,
  5 flame, 6 inverse-conical, 7 tend-flame), `baseSize`, `scale, scaleV`, `levels`, `ratio,
  ratioPower`, `lobes, lobeDepth`, `flare`, `attractionUp`. Pruning may be omitted in v1.
- Per level n: `downAngle, downAngleV, rotate, rotateV, branches, length, lengthV, taper,
  segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV`. Level 0 also `baseSplits`.
- Shape ratio (paper): conical `0.2 + 0.8r`; spherical `0.2 + 0.8 sin(pi r)`; hemispherical
  `0.2 + 0.8 sin(pi r / 2)`; cylindrical `1`; tapered-cylindrical `0.5 + 0.5 r`; flame
  `r <= 0.7 ? r/0.7 : (1 - r)/0.3`; inverse-conical `1 - 0.8 r`; tend-flame
  `r <= 0.7 ? 0.5 + 0.5 r/0.7 : 0.5 + 0.5 (1 - r)/0.3`, with `r = 1 - offset/parentLength`.
- Stem length: level 0 `length0 = scale * (length0 + rnd*lengthV0)` (scale itself is `scale +
  rnd*scaleV`); level 1 `lengthChild = parentLength * (length1 + rnd*lengthV1) * shapeRatio`;
  deeper `lengthChild = (lengthN + rnd*lengthVN) * (parentLength - 0.6*offset)`. Radius
  `radius0 = length0 * ratio`, child `radiusChild = radiusParent * (lengthChild/parentLength)^ratioPower`.
  Taper per the paper (0..1 linear to a point, 1..2 spherical end, 2..3 periodic). Flare at the
  base of the trunk (`flare`), lobes on the trunk cross-section (`lobes`, `lobeDepth`).
- Segment curvature: `curveRes` segments; per segment rotate by `curve/curveRes` (use `curveBack`
  for the second half when it is non-zero) plus `rnd*curveV/curveRes`. Splits: `segSplits` with an
  error-diffusion accumulator so counts are exact on average; split angle `splitAngle + rnd*splitAngleV`
  minus the declination; spread split clones around the parent axis.
- Children: `branches` scaled by the paper's density rule (level 1: `branches * (0.2 + 0.8 *
  (lengthChild/parentLength) / lengthChildMax)`; deeper `branches * (1 - 0.5 * offset/parentLength)`),
  placed along the parent above `baseSize * length0` for level 1. `downAngle` with negative
  `downAngleV` meaning the paper's varying rule (`downAngle + downAngleV * (1 - 2 * shapeRatio(0, (parentLength - offset)/(parentLength - baseLength)))`).
  `rotate` about the parent, negative meaning alternate sides (`180 + rotate + rnd*rotateV`).
- Leaves: `leaves` per last-level stem, distributed along it; leaf faces outward with
  `attractionUp` bias; leaf normal blended toward the crown ellipsoid normal (0.6) for soft
  lighting; group 3 to 5 leaves into one cluster card (two crossed quads) using the atlas tiles.
- Map the component's artistic controls onto the preset: `height -> scale`, `width -> crown
  spread multiplier on level-1 length`, `branchDensity -> branches multiplier`, `leafDensity ->
  leaves multiplier`, `crownBase -> baseSize`, `crownSpread -> blend of shape toward spherical`.
- Presets to ship (`SPECIES`): quaking-aspen (also serves `birch`), black-oak (`oak`),
  black-tupelo, weeping-willow (paper tables below), plus authored `pine` (shape 0, levels 3,
  whorled `rotate=140`, downAngle 80 low to 60 high, short level-2), `spruce` (shape 0, dense
  downward-curving level 1, `curve=+30`), `maple` (shape 1, 3 levels, wide), `poplar` (shape 3,
  narrow, attractionUp 1.5), `shrub` (scale 1.5 to 2.5, levels 2, baseSize 0.05, spherical) and
  `hawthorn` (scale 3 to 4, levels 3, tortuous curveV 60). Author these by adapting the four known
  sets; judge with the preview script. Keep the existing species ids `oak, birch, pine` working.
- Paper tables. Format: Shape, BaseSize, Scale, ScaleV, Levels, Ratio, RatioPower, Lobes, LobeDepth,
  Flare | per level: DownAngle/DownAngleV/Rotate/RotateV/Branches/Length/LengthV/Taper/SegSplits/
  SplitAngle/SplitAngleV/CurveRes/Curve/CurveBack/CurveV (level 0 has no down/rotate/branches;
  its extra is BaseSplits) | leaves: Leaves, LeafScale, LeafScaleX, AttractionUp.
  - Quaking Aspen: 7, .4, 13, 3, 3, .015, 1.2, 5, .07, .6 | L0: len 1/0, taper 1, segSplits 0,
    splitAngle 0/0, curveRes 3, curve 0/0/20, baseSplits 0 | L1: 60/-50/140/0/50/.3/0/1/0/0/0/5/-40/0/50
    | L2: 45/10/140/0/30/.6/0/1/0/0/0/3/-40/0/75 | L3: 45/10/77/0/10/0/0/1/0/0/0/1/0/0/0 | 25, .17, 1, .5
  - Black Oak: 2, .05, 10, 10, 3, .018, 1.3, 5, .1, 1.2 | L0: len 1/0, taper .95, segSplits .4,
    splitAngle 10/0, curveRes 8, curve 0/0/90, baseSplits 2 | L1: 30/-30/80/0/40/.8/.1/1/.2/10/10/10/40/-70/150
    | L2: 45/10/140/0/120/.2/.05/1/.1/10/10/3/0/0/-30 | L3: 45/10/140/0/0/.4/0/1/0/0/0/1/0/0/0 | 25, .12, .66, .8
  - Black Tupelo: 4, .2, 23, 5, 4, .015, 1.3, 3, .1, 1 | L0: len 1/0, taper 1.1, segSplits 0,
    splitAngle 0/0, curveRes 10, curve 0/0/40, baseSplits 0 | L1: 60/-40/140/0/50/.3/.05/1/0/0/0/10/0/0/90
    | L2: 30/10/140/0/25/.6/.1/1/0/0/0/10/-10/0/150 | L3: 45/10/140/0/12/.4/0/1/0/0/0/1/0/0/0 | 6, .3, .5, .5
  - Weeping Willow: 3, .05, 15, 5, 4, .03, 2, 9, .03, .75 | L0: len .8/0, taper 1, segSplits .1,
    splitAngle 3/2, curveRes 8, curve 0/20/120, baseSplits 2 | L1: 20/10/-120/30/25/.5/.1/1/.2/30/10/16/40/80/90
    | L2: 30/10/-120/30/10/1.5/0/1/.2/45/20/12/0/0/0 | L3: 20/10/140/0/300/.1/0/1/0/0/0/1/0/0/0 | 15, .12, .2, -3
- Budget: near-LOD tree at most 24k triangles (leaves as cluster cards, not per-leaf quads), mid
  at most 6k; generating one prototype at most 40 ms in Node. Make the builder a generator that
  yields at ~4 ms boundaries so `FoliageComponent`/`foliageWarmup.js` can slice it (check what
  warmup already slices and reuse that clock).
- Determinism: same seed gives identical geometry (test). Update `tree-quality.test.mjs` metrics
  only where their definition changed; keep the intent (crown fill, taper monotonic, no
  self-intersecting trunk, leaf count within budget) and add: trunk radius decreases monotonically
  with height, level-1 branch count within 20 % of the preset, crown silhouette matches `shape`
  (conical is widest near the base, spherical at mid-height).

### P1-B: Foliage LOD, per-instance dithered crossfade, no pops

Files: `src/modules/foliage/foliageLod.js`, `FoliageComponent.js` (LOD block `:764-786`,
repack `:582-676`), `foliageMaterial.js` (fade term), the impostor material (grep `impostor`
under `src/`), `docs/FOLIAGE.md:158`. Tests: `tests/foliage-runtime.test.mjs` plus new cases.

- Chunk assignment becomes a SUPERSET filter: a chunk is in tier k if its AABB distance range
  overlaps `[near_k - band, far_k + band]`. Tier membership no longer decides visibility.
- Per-instance visibility is computed in the shader: `d = length(instanceWorldPos - camera) /
  instanceScale`; tier weights are complementary smoothsteps across a `band` (default 12 % of the
  threshold, minimum 3 m). Fragment: screen-door dither (interleaved gradient noise per pixel,
  NOT animated per frame) discards when `noise >= weight`. Vertex: weight 0 collapses the instance
  to a degenerate. Both tiers draw an instance inside the band with complementary weights so
  coverage stays 1.
- Thresholds are species-level (`lodNear`, `lodFar`, `maxDistance` props) times the per-instance
  scale. Delete the chunk-relative rescale (`foliageLod.js:13-22`) and the hysteresis (`:32-35`);
  the continuous band replaces both. Keep `maxDistance` as a hard fade-out band.
- Impostor bake arrival: a uniform `impostorRamp` goes 0 to 1 over 0.8 s once the bake resolves;
  impostor weight is multiplied by the ramp and the mid tier keeps `1 - impostorWeight*ramp`.
  No scene-wide pop.
- Shadow passes: the dither must run in the depth/shadow material too. If the node shadow
  material cannot carry the fade, cast shadows from the mid tier only beyond `lodNear` and say
  so in the doc; never a hard visible toggle.
- Instance data: one float per instance (scale) if not already present; camera position uniform
  in the component's local frame (see `grassRenderer.js` for the frame trap).
- Receipt: a Node test that walks a camera from 0 to 200 m in 0.5 m steps against a 400-plant
  scatter and asserts every instance's summed tier weight is within 0.02 of 1 at every step and
  that no per-step weight change exceeds 0.25 (no pops). Document the mechanism in FOLIAGE.md.

### P1-C: Sun motion and camera rotation cost

Files: `src/modules/atmosphere/AtmosphereComponent.js` (`_applySun` `:988-1117`),
`src/modules/gi/GISystem.js:16294-16306` (`GI_SUN_DIR_STEP` only), `src/modules/foliage/
FoliageComponent.js:609-676` plus `foliageBatchOrder.js`. Tests: `npm run test:atmosphere`,
`npm run test:foliage`.

Measure first, in the live editor (MCP `profile.frameStats`, `profile.cpuFrame attribute:true`,
`profile.orbit`), on the open "Complex" scene: (a) sun frozen vs `dayLength` 10 min with
`runInEditor`; (b) camera still vs orbiting. Record the numbers in section 7 of this doc. Then:
- Sun: when the clock runs, hold the LIGHT direction in steps sized so a cascade redraw happens
  at most `SUN_SHADOW_HZ = 4` times per second at the current angular rate (step = rate/4,
  clamped 0.05 to 0.5 deg); light colour/intensity/fog stay continuous. Raise `GI_SUN_DIR_STEP`
  while the clock runs so GI re-lights at most once per 2 s (compute from the rate; a static
  clock keeps 0.25 deg). The sky refill/PMREM gates are already fine. One constant block, documented.
- Rotation: spread `_commitBatches` over frames (at most 4 chunks per frame, oldest bucket first)
  or drop the reorder for alpha-tested opaque foliage if the measurement shows it is not paying
  for itself (say which in the doc). Check `profile.cpuFrame` owners after.
- Receipt: before/after `cpuMs` and `fps` for (a) and (b) in section 7. Restore every prop you
  touched; do not save the scene; take no screenshots.

### P1-D: Architecture, building description + style catalogue + surfaces

Files: `src/modules/architecture/formGeometry.js` (add `describeBuilding`, section 2.1; do not
change existing output), new `src/modules/architecture/styles/catalog.js` (section 2.2, 7 styles,
`getStyle(id)`, `STYLE_IDS`, seeded palette pick `pickPalette(style, rng)`), new `styles/surfaces.js`
(section 2.3), new `styles/rng.js` (mulberry32 plus `range(a,b)`, `pick(array)`, `chance(p)`,
shared by decorators). Tests: new `tests/architecture-styles.test.mjs` (description: every wall
polygon planar, normals outward, openings inside their face, eave/ridge geometry consistent with
`roofHeight`; catalogue: every style validates; surfaces: Node returns null, keys cache). Add
it to `test:architecture` in `package.json`.

### P1-E: Roof decorator (`styles/roofDetail.js`)

`decorateRoofs(description, style, rng) -> {roof, trim, chimney, metal}`. Overhang: extend each
slope by `style.roof.overhang` beyond the eave and gable lines (rebuild the slope polygon, do not
scale the form). Fascia boards under eaves, bargeboards on gables. Ridge cap. Surface courses:
`tiles`/`slate`/`shingles` as overlapping row strips (row height 0.3/0.25/0.2 m, staggered,
jittered by `1 - detail`); `thatch` as a thick rounded slab with layered edge rolls; `metal` as
seamed panels; `plaster` flat. Chimneys: probability per form, on the ridge third nearest the
form centre, brick/stone stack with a cap. Dormers: gabled minis on long slopes of 2+-storey
forms with a window (emit `glass` and `trim`). Stylized family: no jitter, fewer, bigger courses.

### P1-F: Opening decorator (`styles/openingDetail.js`)

`decorateOpenings(description, style, rng) -> {trim, timber, glass, door, stone}`. Windows: frame
(depth into the reveal), sill (projecting, stone or wood per style), mullions (`cross`/`grid`),
glass pane recessed 0.08 m, shutters (probability; one leaf per side, plank pattern), arch head
when `arch` rolls (round or segmental). Doors: frame plus lintel, planked leaf with 2 battens,
step/threshold, arch head. All sized from the opening record; never overlap neighbouring openings.

### P1-G: Wall decorator (`styles/wallDetail.js`)

`decorateWalls(description, style, rng) -> {stone, timber, trim, wall}`. Plinth course (height
`walls.plinth`), corner quoins (alternating blocks) or corner posts (timber styles), cornice band
at the eave, string course between storeys, timber framing: posts at `timber.spacing`, sill and
head beams, diagonal braces per panel (`braces`), all panels avoiding openings (split panels
around each opening rect; a post at each jamb). `plank`/`log` surfaces: horizontal courses as
geometry (logs: half-round rows with notched corners). Skip non-exterior walls.

### P1-T: Procedural terrain lives on the Terrain component; World only uses it

Owner's rule (09-13): "that procedural terrain step must also be on the terrain component, world
itself should only use that." Today `TerrainComponent` (`src/modules/terrain/TerrainComponent.js`)
is a sculptable heightfield (`size`, `resolution`, base64 `heights`, splat) and the World computes
the landform privately (`src/engine/world/terrainShape.js` `createTerrainShape`, `landscapeNoise.js`,
composed with water/banks/roads/pads in `landscapeFields.js` `createValleyFields`) and emits a
baked grid (`worldPlan.js:302`, `encodedHeights`).

Target:
1. Move the landform generator to `src/engine/terrain/proceduralTerrain.js` (re-export the old
   names from `src/engine/world/terrainShape.js` so nothing else breaks). It exports
   `PROCEDURAL_TERRAIN_PARAMS` — the parameter table for the Terrain group (the same 12
   controls as `worldConfig.js`'s `terrain` group, same keys/ranges/defaults/hints; make
   `worldConfig.js` import and derive its `terrain` group from it so there is ONE definition),
   `createTerrainShape(params)` unchanged in behaviour, and
   `fillHeightfield(shape, { size, resolution, overlay, clock, target }) -> generator` that fills
   a `(resolution+1)^2` Float32Array row-major like the component's grid, yielding when
   `clock.due()` (copy the clock idea from `worldPlan.js`).
2. `TerrainComponent`: a `Procedural` schema group: `procedural:false`, `proceduralSeed:1`, then
   the 12 params from `PROCEDURAL_TERRAIN_PARAMS` (generate the schema rows from the table).
   When `procedural` is on the component generates its base grid itself, sliced over frames on
   the engine tick (previous grid stays until the new one is complete, no freeze > 16 ms per
   slice), then `heightsArray = base + edits` and the normal geometry/normals path. Sculpting on a
   procedural terrain writes the DELTA into a new `heightEdits` (base64, same layout, default
   "") and never into `heights`; `heights` is ignored while `procedural` is on (document this
   in the prop hint). Any procedural prop change regenerates the base and re-applies the edits.
   `size`/`resolution` changes regenerate too. Undo works because every prop is a prop.
3. Overlay API on the component for owners like World: `setShapeOverlay(owner, { key,
   evaluate(x, z, baseHeight) -> height, samples? })` and `clearShapeOverlay(owner)`. When set,
   the base grid is `evaluate(x, z, landform(x, z))`; when `samples` (a Float32Array already
   sampled at this grid by the owner from the same function) is given and its length matches,
   the component uses it instead of walking again (World already has `fieldCache`). `key`
   changes trigger regeneration.
4. World: the `terrain` feature's props become `{ size, resolution, splatResolution, castShadow,
   procedural: true, proceduralSeed: seed, ...terrainGroupValues }` — no `heights`. In
   `WorldComponent._installTerrainSurface` set the shape overlay (`key = fieldKey`, `evaluate`
   from the plan's `fields` (water beds, banks, road corridors, pads, ridges, escarpments — the
   `createValleyFields` composition minus the base landform), `samples` = the plan's sampled grid).
   World still builds `fields` for its own ecology/grass/water stages. `terrainEdits`
   (`featureEdits.js`) map onto `heightEdits`. `worldPlan.js` no longer encodes heights
   (`encodeWorldHeights` may stay exported for the player/export path if tests need it — read
   `tests/world-export.test.mjs` first).
5. Tests: `npm run test:world`, the terrain tests (grep `tests/` for `terrain`), `npm run
   test:foliage` (terrain-attach). Add `tests/terrain-procedural.test.mjs`: a bare Terrain with
   `procedural:true, landform:'valley'` produces a non-flat grid deterministic per seed; sliced
   fill equals whole fill byte-for-byte; a sculpt delta survives a landform change; the overlay
   with `samples` is used verbatim; World's terrain feature carries no `heights`.

### P1-H: Integration (after D to G land)

`formGeometry.js`: when `model.style` is set, run the three decorators and merge their output by
role. `ArchitectureComponent.js:8-19`: role to material from `styleSurface` (fallback flat
colour), glass gets roughness 0.1 and metalness 0. `formModel.js`: `model.style = { id, seed,
palette? }` validated against `STYLE_IDS`. `cottageArchitecture.js`: emit `style` (family from
World `style`), and make the World cottage path DEFAULT to the architecture model
(`editableBuildings` default true) so every house is editable and styled. Tests: extend
`architecture-styles.test.mjs` (a styled model has more triangles per role than unstyled; every
role present for `timber-medieval`; deterministic per seed) and `world-cottage-architecture.test.mjs`.
Editor: the Architecture inspector gets a Style select plus seed (find the model section by
grepping `architecture` under `src/editor`).

## 4. Phase 2: World coherence (briefs written when Phase 1 lands)

- Style presets replace the `natural|stylized` enum: `realistic-temperate`, `realistic-alpine`,
  `realistic-frontier`, `stylized-cozy` (Tiny Glade), `stylized-clean` (Townscaper). A preset
  binds: architecture style id, ground surface set, tree species mix, grass tone, atmosphere
  look (post chain plus fog), water look, prop pack. One control `look.preset`; the rest derive.
- Settlement massing grammar (`settlements.js` plots to `cottageArchitecture.js`): L/T plans, side
  wings, barns and sheds on farm plots, garden walls/fences along frontages, courtyards for town
  plots, orientation to the street, storeys by role. Buildings are styled models (P1-H).
- Roads: carriageway surface (dirt/gravel/cobble by preset) with verge blend, wheel ruts for
  dirt, kerbs for cobble; bridges at river crossings (architecture forms).
- Atmosphere look: aerial perspective (distance haze tinted by the sky model through the scene
  fog node), the post chain per preset (AgX tone map plus exposure, bloom, god rays lite), cloud
  coverage/altitude per preset, `dayLength` exposed as one "time passes" toggle.
- Ground: surface maps per preset with a macro-variation layer; wet/shore/rock transitions with
  height-blended masks; no more uniform dark ground.

## 5. Phase 3: Ground cover in the drawn field

Flowers, ferns, clover, heather as blade KINDS in the vertex shader (kind per cell from the packed
field), sharing wind, shading, ground blend and density with grass. Scattered `wildflowers`
retired for the World (kept for hand-placed use). Tree/grass shading unified: one
`foliageShading.js` (translucency, colour variation, wind sampler) used by both materials.

## 6. Phase 4: World graph and control reduction

Reuse the node-graph toolkit (events/post/shader graphs). Node types: Landform, Water, Forest,
Meadow, Village, Style, Atmosphere, Props, World. Each node exposes at most 6 artistic controls
that map onto the parameter table (the table stays the law: the graph is compiled to the
document). Multiple Forest/Village nodes are layers with region masks (everywhere / near water /
on slopes / painted). Advanced controls fold under an "Advanced" group per node.

## 7. Measurements

(filled by P1-C — orchestrator-measured on the open "Complex" scene; P1-C's own change skipped the
live-editor measurement step per the orchestrator's instruction and implemented directly from these
numbers)

### Before

| Arm | CPU/frame | fps | draws | Notes |
| --- | --- | --- | --- | --- |
| Parked (sun frozen, camera still) | 5.0 ms | 118 | 107 | baseline |
| Orbit, camera at 30 deg/s (sun frozen) | 7.5 ms | — | — | 39 ms spike on the first moving frame |

The sun-clock arm (`dayLength` running, camera still/orbiting) was not measured before this change —
the orchestrator will measure it after.

### After

(to be filled by the orchestrator's post-change measurement pass)

### 7.1 After Phase 1 (09-13, live editor, Complex scene, GI never booted after the reload — a known intermittent dead boot, so GI-side numbers are still owed)

| Arm | cpuMs | fps | draws | notes |
| --- | --- | --- | --- | --- |
| Far view, clock stopped | 11.45 | 83 | 103 | renderEncode 11.0 ms of it — see the material finding below |
| Far view, clock 10 min/day | 12.49 | 77 | 103 | the light re-aim gate holds shadows "frozen 3/3" between steps; ~1 ms delta |

Finding: the styled houses minted one material set per building (307 materials, 899 MB of
textures vs 100 / 124 MB before). Cause: `acquireStyledMaterial` keyed by seed and
`styleSurface` cached per seed. P1-H3 shares materials by (style, role, seed % 2, palette index).
Re-measure draw encode after it lands; the 11 ms encode is the suspect for the CPU-bound frame.

Visual receipts: styled cottages show slate roofs, framed windows, dormers and chimneys at
walking height; the new oaks read as broad spreading crowns; the shrub dither dots seen at
far range vanished once the impostor ramp completed; birches rendered as bare white poles
in the World's populations (P1-A follow-up in flight); an old saved scene kept its baked
terrain child as an authored override (P1-T follow-up in flight).

### 7.2 After the follow-ups (09-13, second reload)

| Arm | cpuMs | fps | draws | textureMB | materials |
| --- | --- | --- | --- | --- | --- |
| Near the village, clock stopped | 7.98 | 119 | 235 | 263 | 181 |

Shared style materials cut textures 899 -> 263 MB and materials 307 -> 181 (GI still dead-booted,
so 181 is the GI tier count of pending materials, not a GI receipt). The terrain child is now
`procedural:true` with `heights:''` after loading a pre-P1-T scene. Draws are 235 near the village
because every styled house draws one mesh per role (up to 9): Phase 2 should merge roles that
share a material and consider a settlement-level merge for static houses.

Still open after Phase 1: the white "poles" on the slopes are the World's CLIFFS feature (owner
selected one: entity "Cliffs"), rendered as white vertical capsules that flicker and vanish — T4
rebuilds them as embedded outcrops in the rock material with valid bounds; the scene's authored height fog (`heightFogDensity 1`, falloff 11.6)
whites out any view below ~25 m (a look issue for Phase 2's atmosphere preset), GI dead boot
after both reloads (pre-existing, see [[gi-watchdog-false-fire]]).

### 7.3 Owner verdict on Phase 1 (09-13 morning, three screenshots)

"trees shape got worse and less natural" (ground-level limbs, columnar crowns, spindly straight
limbs, blob leaves — the World's controls were mapped onto the presets without bounds),
"buildings got z fighting and unnatural textures" (random-hue mosaic per brick/stone; decorator
parts coplanar with their host faces), "foliage logs still flickery and often just disappear"
(these are the Cliffs). Fix briefs T1 (tree mapping + presets + leaf clusters, contact-sheet
receipt), T2 (natural palettes with bounded variance, explicit proud offsets, polygonOffset),
T3 (coverage across every LOD system state), T4 (cliffs) are in flight. Rule going forward: see
[[feedback-visual-units-need-rendered-receipts]] — no visual unit is done until a rendered receipt
with the consumer's real parameters has been looked at.

### 7.4 Third round (09-13 midday), verified live after reload

Seen live at late-morning light: a stone gable cottage with coursed rubble, frames and glass
seated in their openings at storey height, chimney and slate wing, tree shadows across the
gable; the slope that had the pillars shows small faceted boulders; birches carry crowns.
Fixes behind it: right-handed face frames (black parts), opening corner semantics (frames
offset by half a window), storey-aligned auto windows, reveal liner + opaque glass, timber
spacing 1.4 m with rails and short braces, natural stone painter, thatch palette, tree
control mapping bounds + leaf clusters (T1), natural palettes + proud offsets (T2), LOD
coverage across all states incl. the >48-chunk starvation blackout (T3), cliffs as slabs and
boulders with a facet angle (T4/T6), viewer-position uniform for the shadow-pass fade (T5).
In flight: T7 adaptive slice budget + world build stages in `profile.boot` (the two-minute
build is the sliced generator starving at 6 ms per 100-200 ms boot frame).
Owner scene props restored after the check (timeOfDay 15.509, heightFog on, viewport freeze on).

### 7.5 The two-minute build, attributed (09-13, `profile.boot` after T7)

World commit at 101.8 s after load (the scene loads twice on an editor reload: boot scene at
1.0 s, project reopen at 6.5 s, so the first plan runs ~5 s for nothing). Plan stages are not slow
in CPU terms, they are starved: `plan terrain` 27 s over 26 slices, `plan planting` 53 s over 40
slices, `plan water` 10 s over 33 slices, i.e. one slice per second, because the main thread is
BLOCKED 47 s in total (worst block 15.2 s) by the impostor bakes: wildflowers 15.7 s, oak 9.9 s
+ 2.8 s + 0.7 s + 2.1 s (five oak bakes for four oak populations), birch 10.6 s + 2.3 s + 1.9 s,
grass (bank-rushes) 7.5 s, pine 4.2 s + 2.2 s. The bake reads its render target back
synchronously while the compile wave holds the GPU queue, and the 2× supersample doubled that.
Prototype generation is cheap (oak 43-55 ms, others 2-37 ms), terrain fill 33 ms, commit 120 ms.
T8: bake downsample/dilation on the GPU, no sync readback, at most 4 views per frame, bakes
start only after the World has committed, one bake per species per renderer.

### 7.6 Where world generation time goes (09-13, owner asked for the split)

Pure CPU, Node, single-threaded, every safe point taken (`worldPlanSteps`, default document):

| Stage | 128 m | 256 m |
| --- | --- | --- |
| water (domain + surface grid) | 559 ms | 705 ms |
| planting (ecology scan) | 178 ms | 617 ms |
| terrain (field sampling) | 318 ms | 453 ms |
| geology (rocks) | 289 ms | 351 ms |
| roads | 277 ms | 39 ms |
| layout / materials / features | 48 / 26 / 8 ms | 10 / 55 / 14 ms |
| **total** | **1.7 s** | **2.2 s** |

Live wall time in the editor for the same 256 m plan (`profile.boot`, after T7/T8): layout 1.1 s,
roads 1.6 s, terrain 1.9 s (41 slices), planting 14.0 s (61 slices), water 2.7 s (35 slices),
commit 0.13 s — 21 s for 2.2 s of CPU, one slice per 200 ms+ boot frame. After the commit:
foliage prototypes 3-66 ms each (fine), impostor bake oak-wide 68 s over 9 frames (frames are
seconds apart during the shader compile wave), and before all of it the editor loaded the
project's MAIN scene (Sponza: GI build, cloth) for 17 s before reopening the last scene.
So the order of levers is: (1) stop the double scene load (T12), (2) run the plan in a worker
so 2.2 s of CPU takes 2.2 s (T13), (3) shrink the compile wave — the styled houses alone add
dozens of pipelines (T14: one material per role via texture arrays), (4) the bake stays off the
main thread (T8) and starts only after the World is ready.

### 7.7 T14 landed: one material per role, texture arrays replace per-style/seed materials (09-13)

Before (P1-H3, §7.2's live receipt): one material per `(style, role, seed % SURFACE_VARIANTS,
paletteIndex)` — 181 materials measured for the "near the village" arm with several styles/seeds
in view, bounded in theory by `roles(9) × SURFACE_VARIANTS(2) × N(3-6 palette combos per style) ×
styles-in-scene` — still one WGSL pipeline per style/seed/palette combination in the boot compile
wave, which is what T14 was scoped to remove.

After: `ArchitectureComponent.js` builds ONE `MeshStandardNodeMaterial` per architecture ROLE for
the WHOLE scene (`styledMaterialCacheKey` now keys purely on `descriptor.role`), sampling three
shared `DataArrayTexture`s (albedo/normal/roughness — `styles/surfaces.js`'s new
`styleSurfaceArray`, 512² layers, capped at 32) at a per-vertex `styleLayer` index, tinted by a
per-vertex `styleTint` — both written by `formGeometry.js` on every styled vertex (`materialIndex`
no longer folds colour/style/seed into the styled key; the per-vertex attributes carry that
instead). The kind-specific texture repeat is baked into the UV at build time (one shared array
sampler cannot carry a per-material `texture.repeat`). Measured directly
(`tests/architecture-styles.test.mjs` plus a throwaway script against all 7 catalogue styles, 40
uniquely-seeded houses — each style repeating roughly 5-6 times): **287 styled descriptor
instances collapse onto 8 distinct materials** — one per role this fixture actually reaches
(`wall, roof, trim, timber, stone, glass, door, chimney`; `metal` needs a metal roof/fitting no
catalogue style currently emits) — a hard cap of 9 for the whole scene, independent of how many
styles/seeds/palettes are in play, down from a count that scaled with all three. GI note: GI's
classic-field readers (`material?.map` in `src/modules/gi/voxelizeOnce.js` and
`src/modules/gi/materialNodeBindings.js`) cannot index a per-vertex array layer, so each styled
role material also carries a plain representative `map` (whichever `(kind, variant, flat)` combo
landed on array layer 0) purely for GI's benefit — a known limitation: GI's albedo for a styled
surface is one texture standing in for the whole role, not the specific kind/variant any one
building actually uses.

### 7.8 Grass, end of 09-13

Eye level matches the Tiny Glade reference (owner frame 19:28). Numeric gates on the rendered
receipt: luminance std/mean 0.115, 1 m box max/min 1.15, orbit spread 1.7 % lum / 5 % hue.
Remaining, both budget-bound: from above the near field still shows soft clump-scale
mottling, and the ring-0/1 seam is a 4.3 % row step (target 4 %) because giving ring 1 the
same 2-segment blade tripled its cost and, under the 2.7 M triangle cap, its density fell from
950 to 451 blades/m² (rings: 1730 / 451 / 15 per m², 2.68 M tris, 3 draws). Buying it back
means raising the cap (GPU was 13 ms in the owner's frame) or a cheaper mid-ring blade.
Causes closed today, each a per-cell constant reaching colour: value-noise plateaus, a
per-patch seam lottery, a half-texel field-read mismatch, a square clump partition for the
lean, a per-clump lean with no per-blade term, a hard ring-1 tone switch, a double-sided
material never flipping its custom normal, and a camera-distance-driven normal blend.

### 7.9 Grass "dark from above / view-dependent" — measured and closed (09-13)

Instrument: `scripts/grass-angles.html?variant=…` + `scripts/run-grass-variants.mjs` (grass-only mean luma per
view; `mg` paints the ground magenta so the straight-down grass fraction IS the blade cover).

| state | overhead blade cover | straight-down / eye-level luma |
|---|---|---|
| before | 2 % | 0.68 |
| arch + widening axis | 33 % | 0.80 |
| + wider far rings | ring 0 78 %, ring 1 83 % | 0.83 |

Root cause was geometry, not shading: a blade was a vertical needle (Bézier P1/P2 on the y axis, tip ≤ 14° off
vertical). Eye level stacks needles into a full sward; overhead sees the terrain between them. Fix in
`grassField.js`/`grassMaterial.js`: `GRASS_BLADE_ARCH` 0.6 rad with P2 pulled toward the tip, height rescaled by
1/cos(arch), widening axis = cross(bladeDir, view), ring 1/2 widthScale 2.4/3.6 and heightScale .85/.8. Also fixed
on the way: the ground normal was handed to `normalNode` in world space (three reads view space) — real, tested,
but not the visible cause. Live receipts at noon: full carpet from 8 m above, dense sward at three-quarter.
Remaining, separate: shadowed grass/foliage reads near-black at a low sun (sky term weak against the sun).
