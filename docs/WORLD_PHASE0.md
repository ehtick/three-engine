# World Phase 0: implemented studies and evidence

Date: 2026-09-12. Status: **technical prototypes implemented; visual quality gate still open**.

This continues [WORLD_PLAN.md](WORLD_PLAN.md). It provides a runnable engine specimen and tests for the two highest-risk data contracts. It does not register a production World component or replace the existing modules. The first complete release remains the 1 km temperate valley with forest, river, lake and village described in the plan.

The [current performance report](WORLD_PERFORMANCE.md) records isolated same-content comparisons after the owner closed the preview: forest performance improved from 73.66 to 110.07 FPS at native 1080p and 29.16 to 50.39 FPS at native 4K. Dry-weather shading, native foliage chunk order and eligible tree depth draws retain all 32,929 plants, native wind and moving-sun shadows; 192 CPU tests, held appearance comparisons and the final integrated landscape check pass. The study enables tree depth before initial compilation, while production World integration, the realistic visual target and 60 FPS at 4K remain open.

## Run and inspect

Start one Vite server:

```powershell
npx vite --host 127.0.0.1 --port 5401 --strictPort
```

Open [the valley study](http://127.0.0.1:5401/scripts/world-valley-study.html). Four camera buttons show the valley, shore, cottage and tree specimens. Left-drag to orbit, right-drag to pan, and use the wheel or pinch to zoom; arrow keys pan while the canvas has focus. Camera buttons restore their preset, while resizing preserves the current pose. New cottage variation changes the architectural layout and generator seed. The Roof color picker records any chosen color as an override; Use generated color removes it and restores the current generator's palette. The controls explicitly distinguish generated color from custom color retained during regeneration. Baseline and two style links expose comparison arms, with the active mode highlighted. Moving sun advances the real Atmosphere-owned light.

The study uses a configurable 128 m valley recipe, native Terrain and Foliage components, the existing Atmosphere component, a procedural cottage specimen and a water-domain surface prototype. The scrollable Landscape panel exposes seed, five geography controls, planting density, tree scale, grass height, planting patches and surface source/scale/bump. Generate Landscape rebuilds the fixture and retains these settings, cottage variation and custom roof color in its URL. These controls remain a test fixture, not the planned World editor workspace. Production Architecture remains unchanged. Atmosphere has a native environment-refresh scheduling fix; its sky/cloud/weather appearance upgrade is still deferred.

Natural defaults to local material surfaces; Stylized defaults to procedural surfaces. With no explicit `surface` query, style links use the new style's default. Selecting a surface source or pressing Generate makes that choice explicit and preserves it across style changes. The surface status reports the maps actually loaded. Use `?surface=procedural` for a Natural comparison without the optional maps; `?style=stylized&surface=materials` combines the Stylized recipe with material surfaces.

```powershell
npm run test:world
npm run smoke:world-study
npm run smoke:world-landscape
node scripts/run-world-study.mjs "http://127.0.0.1:5401/scripts/world-valley-study.html?baseline=1" artifacts/world-study-baseline
node scripts/run-world-study.mjs "http://127.0.0.1:5401/scripts/world-valley-study.html?style=stylized" artifacts/world-study-stylized
```

Run GPU commands sequentially, with the user's live editor loop stopped. The runner creates an external scratch Chromium profile, records actual GPU errors, captures viewpoints, and writes a fresh report even when a rerun fails. `CHROME_PATH` can override its Windows Chrome default. Screenshots and detailed JSON receipts are generated under the ignored `artifacts/` directory. Set `$env:WORLD_STUDY_FUNCTIONAL = '1'` to skip benchmark windows when checking behavior while a preview may be open; these receipts explicitly make no performance claim.

## Implemented contracts

| File | Responsibility and boundary |
|---|---|
| `src/engine/world/featureEdits.js` | Pure JSON feature-edit resolution, durable semantic IDs and independent named random streams; no engine/editor dependency |
| `src/modules/water/worldWaterDomain.js` | Validated concave polygon lakes and directed downhill river polylines; CPU queries and a shared packed raster; no production water integration |
| `scripts/lib/worldCottageStudy.js` | Deterministic procedural cottage geometry and materials; a visual specimen, not an Architecture provider |
| `scripts/lib/worldValleyStudy.js` | Fixture terrain, water surface, rocks, populations and cottage edit loop |
| `scripts/lib/worldWaterGpuProbe.js` | Exact packed texture upload/compute-read/readback comparison on a real WebGPU device |
| `scripts/world-valley-study.html` | Actual Engine loop, comparison controls, bounded measurements and error reporting |
| `scripts/run-world-study.mjs` | Isolated browser run, camera captures, moving-light and visible-edit assertions, result receipts |

### Persistent artistic edits

`resolveFeatureEdits(features, operations)` returns resolved features and diagnostic orphan operations without mutating either input. Operations run in document order: property overrides, absolute transforms, suppression, authored additions and snapshot pins. Removing an operation restores inheritance from the current generated input; undo/redo can resolve the original operation history again.

Property paths select existing object fields rather than inventing generator schema or relying on array indices. Missing targets retain their operations for later reconciliation. A missing pinned feature remains visible from its snapshot and also reports an orphan. Orphans are diagnostic output: do not append them back to the original operations list. Attachment changes require explicit attachment coordinates; the pure resolver does not evaluate surface transforms.

`stableFeatureId(namespace, ...keys)` derives identity from semantic keys, independently of display names and generation order. `featureRandom(seed, featureId, channel)` isolates random choices so adding an unrelated sample does not reshuffle existing choices. Providers still need to define durable semantic keys and topology migration; these helpers cannot infer identity across an arbitrary redesign.

The 16 CPU tests cover inherited versus overridden values, reordered generation, missing targets/paths, pins, additions, transforms/anchors, ordered reset/undo/redo/JSON replay, immutability, duplicate identity and invalid persisted data. The browser fixture exercises actual roof-paint controls and checks rendered pixels before paint, after regeneration and after reset. This is not yet editor command-bus undo, scene serialization, export or player integration.

### Shared water domain

One domain contains three lakes at different elevations and one descending river entering the main lake. Each body has a stable ID. Queries return surface height, nominal design depth, horizontal flow and conservative footprint clearance. The raster stores `[surfaceY, bedY, flowX, flowZ]` in RGBA32F, with an explicit finite dry sentinel. Row zero corresponds to minimum world Z; samples are at texel centers.

The fixed 512 × 512 field occupies 4 MiB. The GPU probe reads it using **one sampled texture and one storage buffer**, and compares all 4,194,304 bytes. The device is capped at the portable eight storage buffers per stage. Body count does not introduce per-body shader bindings in this representation. This establishes a feasible representation; it does not establish the final composed GI/water shader budget or unbounded-world memory cost.

The 15 CPU tests cover concave footprints, downhill grade/flow, more than two bodies, deterministic overlaps and flat junction landings, CPU/raster packing, input independence, invalid geometry/scalars and bounded raster allocation. Lakes cannot overlap at incompatible elevations; connected river mouths require flat landing reaches across their width. General graded junctions and sharp-bend surface continuity need a later solver.

The visible surface uses the packed wet mask. Its vertex elevations extend neighboring wet heights across shore triangles so dry sentinel values cannot pull the shoreline down into the ground. This is a fixture mesh with interpolated elevations, not an exact production surface tessellator. The byte comparison proves texture transport, not rendered shoreline parity or physical water correctness.

Two additional CPU regressions sample actual indexed water and terrain triangles at packed wet texel centers. They require the elevated pond's shoreline surface to remain at water height and its wet footprint to clear the terrain. Restoring either the original dry-sentinel displacement or the mismatched circular terrain carve makes the corresponding negative control fail. At the cottage/foliage checkpoint below, these checks and the five cottage tests brought `test:world` to 38 passing tests.

The current landscape follow-up adds shared-domain terrain carving, actual fixture depth and surface shading. Remaining production water work includes full union shore queries, variable widths/cross sections, robust confluences, local reflections/refraction, foam, underwater medium, caustics, buoyancy, attachment transforms, chunking and shared runtime resource ownership. No production Water slots, GI kernels or device limits were changed.

## Original visual result and content accounting (historical)

The original cottage was an 8 × 6 m detailed specimen: genuine apertures, recessed glazing, mullions, shutters, door hardware, masonry foundation/corners, plaster and wood relief, slate courses/eaves/ridge, chimney, entry hood, steps and planting boxes. It used 12 role meshes and 18,820 triangles, with three generated microrelief textures. The follow-up below replaces its nearly identical seed variations with four construction families. Natural and stylized treatments vary proportions, palette and surface response; neither is a general style-resource system yet.

The original landscape contained 66,049 terrain vertices, a simple rock specimen, 12 existing tree prototypes across pine/oak/birch, up to 6,500 grass instances and 500 wildflowers. Its terrain used vertex material colors plus procedural grain. These counts describe the original specimen, not the current landscape follow-up or intended final ecosystem density and content catalog.

Original visual review: the cottage demonstrated a concrete step beyond the supplied blockout. The broader valley had smooth generic hills, simple rocks, sparse/repetitive vegetation, elementary water and an authored layout. It did **not** meet the requested naturalistic/game-ready appearance. That style comparison likewise did not establish full artistic control or two complete production looks. A finished cliff/shore/forest material and species patch remains a Phase 0 deliverable.

The original baseline arm used an existing Architecture form, repeated tree seeds and simpler terrain shading. It was a qualitative content comparison, not an equivalent-workload optimization benchmark or a recreation of the user's screenshot. The current baseline arm has a different scope, documented in the landscape follow-up below.

## Cottage and foliage follow-up

The owner's first review exposed two problems: cottage variations kept essentially one silhouette, and the one-click red paint control did not explain why subsequent generations stayed red. The new builder has four deterministic families: an 8 × 6 m gabled cottage, a broad farmhouse with a transverse roof and full porch, a narrow two-storey house, and an L-shaped side-wing cottage. Later seed cycles also vary dimensions and generated palettes. Actual roof axis, aperture locations, footprint, entry position, storeys, porch and wing geometry change; this is not just metadata or a color reroll.

Roof color now accepts any color through the picker. A custom color deliberately persists when the building regenerates, matching the procedural-plus-authored contract. **Use generated color** removes that override. The UI reports this state, names the current family, highlights the active style and frames the actual building bounds. Baseline explicitly disables unavailable specimen editing.

Five CPU tests drive the real builder: raycast physical family differences and genuine glazing/apertures across both styles; reject an uncut-wall negative control; compare deterministic geometry and paint-only changes; and require complete, exactly-once disposal. The revised browser runner checks actual geometry, projected silhouettes and visible roof triangle pixels through four generations, arbitrary blue/green edits and reset. It writes failure receipts immediately rather than leaving an old pass on disk.

The foliage changes are in the production module, so World and independent Foliage share them. Oak, birch and pine use four varied twig textures with species-specific leaf outlines, smaller irregular attached clusters and retained secondary branches in middle-distance geometry. Leaf size/density preserve the branch scaffold; branch density and crown shape change actual growth. Texture alpha, normals, padding and roughness are shared between the live material, shadow silhouette and neutral impostor bake. No vertex or storage-buffer bindings were added.

| Tree control | Default | Authored range |
|---|---:|---:|
| Leaf density | 1 | 0.5–1.6 |
| Leaf size | 1 | 0.6–1.5 |
| Branch density | 1 | 0.6–1.4 |
| Crown base offset | 0 | −0.15–0.2 |
| Crown spread | 1 | 0.7–1.3 |

These controls appear only for trees in the inspector. They rebuild the prototype and its cached distant representation while retaining the same scattered instances and surface anchors. Existing presets reset the shape controls to neutral values. The World specimen uses fuller per-species settings and correct birch bark coloring; these are example settings, not a new species catalog or ecosystem generator.

CPU gates cover real attachment positions, middle-distance twig connectivity, parameter effects, deterministic retained leaf identity and finite geometry at extreme settings. The existing limits remain 12,000 near and 2,000 mid triangles per prototype. Default seed-42 near triangles changed from 9,562 to 11,006 for oak, 9,332 to 10,554 for birch, and 9,090 to 9,290 for pine. Those are geometry counts, not frame-time measurements. Four 256-pixel twig variants occupy a 512-pixel texture per species, with custom mips; this adds texture memory relative to the original single tile.

All 68 foliage CPU tests and the real editor smoke passed, including each control's keyboard undo/redo and exact placements after scene reload. One existing wind-clock test needed its fixture set to Play: production intentionally freezes editor wind unless Run in Editor is enabled. The corrected test also checks that paused-editor behavior; production wind timing was not changed.

Before/after tree captures are under `artifacts/foliage/trees-before` and `trees-after`. The before arm serves source retained from the recorded Git revision without changing the working files. Leaf repetition improved, but visual review still finds sparse crowns and simple bark; this is not acceptance against the owner's realistic nature reference. The subsequent far-distance leaf-loss report is tracked with the mip and rendered-canopy regression below.

The chosen reference sets the target for layered mature canopies, undergrowth, irregular mixed banks, credible shallow water and coherent lighting. Sky/cloud/weather quality is explicitly deferred at the owner's request; [WORLD_PLAN.md](WORLD_PLAN.md) records that later scope. No atmosphere overhaul is included in this follow-up.

### Distant leaves disappearing: cause and regression

The first four-variant leaf mip builder rounded approximately 20% coverage to zero when a variant reached one texel. It then produced fully transparent 2 × 2 and 1 × 1 atlas mips. The existing 64-pixel whole-tree bake sampled those mips and captured trunks without their canopy. This was a real regression introduced by the texture update; the initial surface/atlas smoke passed because bark alone supplied nonzero pixels.

Leaf mip chains now end at an 8 × 8 cutout per variant (16 × 16 atlas). Three allocates exactly the supplied mip count, so extreme minification clamps to surviving sparse coverage. Every mip keeps transparent tile gutters. The fix neither fills coarse tiles opaque nor extends the tree draw distance or disables impostors. Bark retains its full mip chain. CPU tests inspect the installed Three mip allocation and bilinearly filtered coverage, including an old-tail negative control.

`smoke:foliage-trees` now compares actual near, mid and two-triangle impostor draws for oak, birch and pine at three matched camera angles. It measures green canopy pixels independently of bark, spatial occupancy and crown extents, and saves comparison strips. All nine comparisons pass. Mid models retain 91–96% of near green pixels; the low-resolution impostors cover 123–146%, with 83–93% of the near canopy's occupied spatial bins. This proves canopy survival, not pixel-equivalent LOD appearance: the 64-pixel impostor remains coarser and fuller when magnified.

The `--old-mip-tail` arm appends the broken tiny mips before upload. It fails the same rendered test with **zero green impostor pixels in every species/angle**, while the corrected arm has no page or GPU errors. Corrected valley captures also show leaves on the trees across the lake.

```powershell
node scripts/run-foliage-tree-preview.mjs http://127.0.0.1:5401 artifacts/foliage/trees-fixed
# Expected failure: reproduces the missing distant canopy.
node scripts/run-foliage-tree-preview.mjs http://127.0.0.1:5401 artifacts/foliage/trees-old-mip-tail --old-mip-tail
```

The [tree inspection page](http://127.0.0.1:5401/scripts/foliage-tree-preview.html) exposes species, view, detail level and angle controls for the same specimens.

### Cottage/foliage follow-up receipts (historical checkpoint)

| Check | Evidence |
|---|---|
| World CPU: 38 pass | `artifacts/world-cpu-final.log` |
| Foliage CPU: 68 pass | `artifacts/foliage-cpu-final.log` |
| Actual foliage WebGPU: pass, storage limit 8, no errors | `artifacts/foliage/gpu-result.json`; cutout/normal/shadow, wind/repacking, near/far GI reception and the 60k-instance fixture |
| Required generic GI runtime: pass at storage limit 8 | `artifacts/world-gi-final.log`; no WebGPU validation errors, hybrid-brick-box arm with SRC traversal explicitly skipped |
| Tree canopy: pass; old tail fails all distant views | `artifacts/foliage/trees-fixed/result.json`, `trees-old-mip-tail/result.json` and comparison PNGs |
| Editor fields, keyboard undo/redo and reload: pass | `artifacts/foliage-ui-final.log`, `artifacts/foliage/tree-controls-ui.json`, `tree-controls-ui.png` |
| Natural/stylized cottage regeneration and roof pixels: pass | `artifacts/world-study-variations/report.json`, `artifacts/world-study-variations-stylized/report.json`; both `functional-only`, no performance claim |
| Baseline controls/active mode: pass | `artifacts/world-study-variations-baseline/report.json`; recorded before the final tree-mip correction |
| Production Vite build: pass | `artifacts/world-build-final.log`; existing externalized Node dependency and chunk-size warnings remain |

These follow-up runs are functional checks, serialized on the GPU with external browser profiles. A user preview may be active, so their timings are not accepted as performance measurements. The historical benchmark below describes the original content only.

## Landscape integration and lighting checkpoint (historical)

This checkpoint connected terrain shape, water boundaries, ground treatment and vegetation to one deterministic valley recipe. Its recorded counts and runtime receipts below precede the bank and surface follow-up. The shared contracts remain in use; they do not implement the production World document, provider lifecycle or unified editor.

| Implementation | Current responsibility |
|---|---|
| `src/engine/world/landscapeFields.js` | Pure `createValleyFields()` factory: shared water domain, terrain height, signed shore distance, actual depth, moisture, forest, rock, path and slope queries |
| `src/engine/world/valleyEcology.js` | Seeded, stable placement candidates filtered by shared fields; mature trees, understory and ground populations with independent density controls |
| Native Foliage `placements` distribution | Explicit transforms use the existing Foliage rendering, wind, LOD, impostor and disposal path; the study supplies ten population layers |
| `scripts/lib/worldLandscapeStudy.js` | World-scale ground/stone surface treatment and bounded procedural outcrop, boulder, talus and pebble specimens |
| `scripts/lib/worldWaterSurfaceStudy.js` | Flow-driven ripple normals, depth-dependent shallow water, dielectric surface response and a signed-distance edge using the shared domain and actual terrain depth |
| `scripts/lib/worldValleyStudy.js` and its HTML fixture | Compose the fields, native components and owned study resources; expose reproducible landscape regeneration controls |

The main lake has an irregular polygonal shore; the two elevated ponds retain distinct levels, including the upland ellipse regression. A smoother meandering river descends into the main lake. Ridges, gullies and rock regions vary the broad hills, while the cottage pad remains flat at `[22, 2.2, 6]`. Water carving and ecological exclusions use the same domain. Vegetation roots and the water shading depth sample the actual 0.5 m terrain triangles, avoiding a mismatch between analytic heights and the rendered mesh.

The ten native foliage layers cover mature oak/birch/pine specimens, two understory approximations and four grass/flower populations. Placement responds to moisture, shore, slope, rocks, paths and the cottage clearing. The understory reuses existing growth families; this is not yet a complete species catalog or production biome system. Rock and ground helpers likewise establish a configurable visual specimen, not the planned geology provider.

Seven CPU tests in `tests/world-landscape-fields.test.mjs` pass. They cover deterministic independent fields, configurable domain geometry and downhill river grade, coherent water/terrain/ecology queries, analytic slope accuracy, pad/path exclusions and bounded inputs. The shoreline regression checks every wet texel against both possible diagonals of the actual float32 terrain grid across three recipes; restoring the mismatched circular pond carve still fails its negative control. Eight ecology tests additionally pin independent density controls, unchanged candidate identities/positions when density increases, exclusions, rendered-height placement and bounded populations. These checks establish field and mesh coherence, not visual acceptance or frame-time performance.

The native Foliage placement mode accepts caller-owned IDs and local position/rotation/scale lists. Component transforms, wind, bounds and shared LOD batches use the existing rendering path. The constructor allocates an independent empty list for each component; sharing the shallow default array allowed edits in one population to contaminate others. Four placement-helper tests and two additional component regressions cover validation, transformed parents, actual batch matrices/bounds, unchanged uploads and serialized appearance. This mode does not yet implement individual-plant viewport editing or reseating after terrain edits.

Generate Landscape stores `seed`, `forest` and `ground` in the URL and rebuilds the page fixture. It preserves the cottage variation and any explicit custom `roof` override; generated roof colors remain inherited. This makes the study reproducible, but it is not an incremental generation transaction or editor undo/save/export integration.

**Comparison boundary:** the current `baseline=1` arm shares the new landscape, ecology, materials and water, and swaps only the cottage for basic existing Architecture. It therefore cannot show the landscape's visual before state. The preserved captures in `artifacts/world-landscape-before` are the landscape before images. The original single-cottage benchmark and its measurements below remain historical and unchanged.

The realistic nature reference remains the open target for dense layered greenery, believable ground and broken banks, and convincing shallow water at walking height. Close views still expose repeated plant shapes, simple leaves/grass and procedural surface patterns. Water reflects the sky environment; local geometry reflections and refraction remain open. Sky/cloud/weather appearance upgrades remain explicitly deferred. Full World is not complete, and Phase 0 continues.

Visual inspection caught a terrain blend error that the first functional checks missed: TSL's chained `t.mix(a, b)` uses the receiver as its interpolation factor. Treating the receiver as the first color made flat ground nearly black. The helper now uses explicit `mix(a, b, t)`. A real GPU material gate renders flat and 45-degree ground/stone specimens against a neutral Standard-material control, with the exact reversed-mix graph as a negative control; the incorrect graph retained less than 1% of the reference signal.

A second pixel comparison found that changing the sun could make water nearly black even while the visible sky looked unchanged. A live PMREM refresh ran inside the main renderer's asynchronous compilation/build budget and could cache incomplete lighting. `prepareSkyEnvironment()` now finishes pending work on the already-created native sky PMREM from Atmosphere's preRender callback. It reuses Three's actual source, cache and target, leaves first creation to Three, skips GI/foreign environments and active main-render scopes, and stores a source-version receipt only after success. It does not disable asynchronous compilation or change shadows. Five CPU regressions cover the cache/version boundary, identity and failure retry; the real live/held pond RGB ratio after resetting the sun is 1.000 on all channels. This is a lighting correctness fix, not the deferred Atmosphere visual redesign.

The isolated old-behavior arm (`WORLD_STUDY_SKIP_SKY_PREPARE=1`) fails the same live-pixel gate with RGB ratios 0.311 / 0.261 / 0.157 and no WebGPU validation errors (`artifacts/world-landscape-old-sky/report.json`). The helper is intercepted only for that test process. This demonstrates why successful pipeline validation and a later manually repaired screenshot were insufficient evidence. The final generic GI smoke also passes at storage limit 8 (`artifacts/world-landscape-gi.log`); its SRC traversal counters remain explicitly skipped by the existing fixture.

This checkpoint's functional receipts are in `artifacts/world-landscape-final/report.json`: 231 trees, 453 understory plants and 30,125 ground plants reached native placement rendering. The harness observed actual submitted batches, removed/restored foliage to verify its pixels, checked live sky-reflection persistence, validated the packed 4 MiB water field at portable-eight limits, and regenerated seed 894 into 931 while preserving the cottage's actual roof geometry and authored color. That geology specimen used 36,692 triangles in three merged draws. These are historical fixture counts, not performance measurements or a large-world benchmark.

At that checkpoint, `test:world` passed 53 tests, `test:foliage` 74 and `test:atmosphere` 41. The real Foliage GPU and editor flows passed, including native placed-population shape/color edits, keyboard undo/redo and scene reload; receipts are `artifacts/world-foliage-gpu.log`, `artifacts/world-foliage-ui.log` and `artifacts/world-foliage-ui/`. The Atmosphere GPU fixture passed in `artifacts/world-atmosphere-gpu.log`. Natural and Stylized functional runs passed with viewpoint captures and cottage edit checks in `artifacts/world-landscape-natural/` and `artifacts/world-landscape-stylized/`. Production build and `git diff --check` passed. These historical functional runs used portable-eight limits and do not certify throughput or the subsequent surface changes.

## Bank and surface follow-up (historical)

Close shore/forest views exposed a smooth wall where a low bank blended into high hills over roughly seven metres. `landscapeFields.js` now rolls the dry bank into a shallow, varied floodplain and limits the shoulder's elevation gain until it meets the original ridges. The water footprint, wet bed, cottage pad and parameter ranges remain unchanged. Two new CPU regressions measure actual half-metre height gradients across three seeds, reject the former bank blend, and check bank-width behavior, analytic derivatives and exact recovery of distant ridges. `test:world` now passes 55 tests, including nine field and eight ecology tests.

The procedural geology treatment uses interrupted directional bedding and sparse cross-joints. It removes the closed cellular crack pattern and individual cell colors that made exposed stone resemble fitted paving. Field-driven outcrops, fallen stone and shore pebbles remain bounded merged geometry. The current browser report confirms 232 trees, 489 understory plants and 32,815 ground plants for seed 894. Geology uses 35,240 triangles in three merged draws, with 558 foundation vertices seated below the terrain. Counts are not performance measurements.

Optional material surfaces come from six local 1024-pixel maps: albedo and height pairs for grass, soil and rock, totaling **6,716,074 file bytes**. [The manifest](../public/world-study/surfaces/manifest.json) records the Poly Haven assets, CC0 license, authors, checksums and physical tile dimensions; [the asset notes](../public/world-study/surfaces/README.md) accompany them. `loadWorldSurfaceMaps()` in `scripts/lib/worldSurfaceMaps.js` loads only the selected material mode. Another manifest can supply the same three roles. The study owns and disposes the returned textures; file size is not decoded GPU memory usage.

Material mode retains the source albedo colors with neutral broad vertex modulation instead of multiplying them by the old colored terrain palette. Shared soil/rock/moisture/forest fields choose the surface layers; world-scale sampling and rock projections keep the material attached to the landscape. Browser-decoded height maps provide adjustable artistic bump. Their source files and metadata do not establish a calibrated physical displacement amplitude or retained upload bit depth, and this path does not displace geometry.

The swatch test exposed a second silent material error: sharing texture sample nodes between color and bump let BumpMap's offset-UV reads reuse an unshifted cached value. Soil and stone bump then subtracted the same sample from itself and produced exactly zero pixel change. The normal branch now has independent texture sample and height-blend nodes while sharing the same six texture resources. The procedural ground and rock branches received the same correction. Material bump amplitudes are relative artistic values of 0.35 for grass, 0.45 for soil and 1 for rock, multiplied by the user's bump control; they are not displacement distances.

Under fixed oblique lighting, the material swatch now changes with bump 0 versus 1 (readback RGB mean absolute error 0.0024325; 12.05% changed pixels) and detail scale 0.5 versus 2 (0.0183482; 85.318%). Restoring the original normal settings restores the pixels exactly. Four procedural normal-off comparisons also restore exactly. The earlier failing receipt, `artifacts/world-surfaces-bump-diagnostic/report.json`, records zero bump MAE and no GPU validation errors, establishing that shader validation alone missed the defect. The corrected swatches verify source-albedo layer selection and all six loaded material textures in the compiled shader, with no material storage buffers; Three's ordinary DFG lookup texture is separate.

The five geography controls and three surface controls extend the existing seed, forest density and ground cover controls:

| Control | URL key | Default and range |
|---|---|---|
| Relief | `relief` | 1; 0–2.5 |
| River width | `riverWidth` | 5 m; 2–8 m |
| Bank width | `shoreWidth` | 1; 0.65–1.8, scaling the apron and shoulder |
| Rockiness | `rockiness` | 1; 0–2 |
| Forest coverage | `forestCover` | 0.72; 0–1 |
| Surface source | `surface` | `materials` for Natural, `procedural` for Stylized unless explicitly selected |
| Surface detail scale | `surfaceScale` | 1; 0.5–2 |
| Bump strength | `surfaceBump` | 1; 0–2 |

Detail scale and bump strength affect terrain in both surface modes. `scripts/lib/worldStudySettings.js` preserves all settings through landscape regeneration and style links; cottage edits also update their URL state while preserving the landscape and explicit surface choice. Generated roof color still inherits until an artistic override is applied. These are reproducible fixture controls, not World document transactions or editor undo/export integration.

The visual before captures for this pass are `artifacts/world-surfaces-before/`. The current baseline arm still shares the full landscape and changes only the cottage to basic Architecture; it is not a landscape before image. Older `world-landscape-*` receipts and the original single-cottage measurements remain historical.

The running Vite instance initially served an older field module despite updated files on disk. Restarting the owned server resolved it. The landscape runner now compares terrain probes from the actual browser scene against fields imported by a separate Node process from current source, so a stale preview cannot certify a new terrain recipe. The passing run changes the seed to 931, relief to 0.8, river width to 6.2, bank width to 1.25, rockiness/forest coverage to 0.8, forest density to 0.85 and ground cover to 1.1. It verifies 243 trees, 512 understory plants and 37,747 ground plants while preserving the cottage and its custom roof. The live/held pond RGB ratio remains 1.000 on every channel after sky refresh.

| Current-pass receipt | Status |
|---|---|
| `artifacts/world-surfaces-natural/report.json` | Pass: current-source Natural material surfaces, viewpoint captures and cottage validation |
| `artifacts/world-surfaces-stylized/report.json` | Pass: current-source Stylized procedural surfaces, viewpoint captures and cottage validation |
| `artifacts/world-surfaces-landscape/report.json` | Pass: geography/surface controls, current-source terrain probes, native populations, map bindings/swatches, bump/scale pixels, roof preservation and live sky lighting |
| `artifacts/world-surfaces-bump-diagnostic/report.json` | Expected failure of the earlier bump graph: zero pixel effect, no GPU validation errors |
| `artifacts/world-surfaces-gi.log` | `GI-SMOKE PASS storage=8 mode=hybrid-brick-box`, exit 0, no validation errors; SRC traversal counters explicitly skipped by the existing fixture |
| `artifacts/world-surfaces-build.log` | Pass: production build, approximately 1 minute 11 seconds |

All three final World browser reports record zero errors and that checkpoint's terrain/population source. They are functional checks; they do not establish landscape throughput or a composed World/GI production renderer. The final World CPU count at that checkpoint was 55. The vegetation follow-up below changes the source after these runs.

The realistic nature reference remains unaccepted. These terrain and material changes require new visual review; prior technical passes cannot certify their appearance. The standalone World module is still not registered, the full valley release is unfinished, and Phase 0 continues. Atmosphere's visual upgrade remains deferred.

## Vegetation and navigation follow-up (current)

The preceding shore and forest captures still showed isolated grass tufts, repetitive understory and an overly uniform rush strip. `sampleValleyPlanting()` now supplies coherent, seeded planting signals: ground density varies over 7.5 m, shrubs over 11 m, plant-type stands over 6.2 m and rushes over 4.4 m. These are noise sampling scales, not fixed patch diameters. Terrain's soil mask uses the same bare-patch signal, connecting exposed ground to sparse planting. Suitable habitat, wet-bed/path/cottage exclusions and the 420-tree, 900-shrub and 75,000-ground caps remain in force.

| Vegetation control / URL key | Default and range | Effect |
|---|---|---|
| Tree scale / `treeScale` | 1; 0.65–1.5 | Multiplies mature `trees/*` placement scale; retains roots, membership and species |
| Grass height / `grassHeight` | 1; 0.5–1.75 | Multiplies the height of ground prototypes, including rushes and flowers; retains placements |
| Planting patches / `patchiness` | 0.65; 0–1 | Blends uniform candidate chances into coherent density and plant-type patches |

These settings live in the fixture's `vegetation` settings object and survive URL regeneration, style links and cottage edits. Patchiness can change membership and the selected population group; a surviving candidate retains its ID, root, rotation and scale. Candidate jitter is independent of the patch signals. Tree scale and grass height do not reroll plants or change density.

The study now supplies eleven native population layers. A low `woodland-floor` grass prototype (0.12 m height, 0.72 m width before scaling) gradually replaces meadow plants under stronger forest cover. Short and long meadow prototypes are 0.23 m and 0.58 m tall. Most ground layers remain visible to 195 m, with flowers at 160 m, covering the 128 m specimen. They use ordinary Foliage placement rendering, wind, LOD, impostors and shared batches. Understory still approximates species using the existing tree families; these changes do not establish a complete vegetation catalog.

The fixture now uses native Three OrbitControls for free inspection. Input updates the actual scene camera, preset buttons restore reproducible views and resize updates the projection without resetting the pose. Input listeners and the preRender callback are released when the page leaves its lifecycle. This is camera navigation for the study, not collision-aware player traversal or a World editor tool.

`test:world` passes **59 CPU tests**, including nine field and twelve ecology tests (`artifacts/world-vegetation-cpu.log`). Four new ecology regressions verify isolated shape controls, bounded settings, unchanged surviving transforms and spatially coherent actual populations. On homogeneous fields across two seeds, default ground-count Moran correlation is 0.57–0.62 versus approximately zero for uniform planting; shrub correlation is 0.11–0.12. Deterministically shuffling the same quadrat counts fails the spatial gate, and short/long cohorts must also correlate. This rejects independent speckle without asserting that statistical clustering alone looks natural.

Oak and birch now use four compound twig-card variants carrying 42 small, separate leaves on six lateral shoots and their leader, replacing the previous six-leaf cluster. Nominal cards are 0.84 × 0.70 m for oak and 0.70 × 0.58 m for birch; individual unscaled blades remain at most 0.105 m and 0.078 m long. Larger crowns receive more card area within the existing 12,000 / 2,000 / 1,100 triangle limits for near, middle and fallback geometry. Native distant impostors remain separate billboards. Pine and meadow prototypes retain their prior geometry/surface contracts.

The full Foliage CPU suite passes **76 tests** (`artifacts/world-vegetation-foliage-cpu.log`), including 29 geometry, surface and tree-quality checks. A new crown-area regression projects actual indexed triangles and samples their alpha texture from three directions. It requires adult broadleaf coverage to improve by over 50% against a half-sized-card control with identical roots, card count and atlas. Template tests retain physical blade sizes, attached shoots, varied leaf directions, transparent tile borders and useful mip coverage. This measures real leaf coverage within the geometry budget, not merely card counts or bounds.

Current tree GPU checks pass for oak, birch and pine at near, middle and impostor detail from three matched angles, with zero errors (`artifacts/world-vegetation-trees/result.json`). The gate measures visible green canopy, occupied regions and silhouette bounds against the near representation. It verifies canopy survival; it does not certify realistic leaf appearance or exact near/far pixel equality. Reintroducing the transparent mip tail against the current source fails that same GPU gate at every tested angle: impostors retain only 23–33% of oak green pixels, 2.6–4.4% of birch and zero pine. The negative run has zero browser/GPU errors; the failure is the intended loss of visible canopy.

The landscape browser report also passes with zero errors (`artifacts/world-vegetation-landscape/report.json`). Real orbit, wheel zoom and pan change 76.59% of the image; resize preserves the camera pose and the Valley button restores its position and target exactly. The report starts with 232 trees, 527 understory plants and 32,170 ground plants, then changes the seed and controls, including tree scale 1.15, grass height 1.25 and patchiness 0.8. The regenerated 243 / 625 / 37,920 populations use native placement batches while the cottage's actual roof geometry and authored color remain unchanged. Current-source terrain probes, surface map/bump checks, rendered foliage removal/restoration and live sky-lighting persistence also pass. These are functional receipts, not throughput measurements or visual acceptance.

| Vegetation-pass receipt | Status |
|---|---|
| `artifacts/world-vegetation-before/` | Preserved visual before state for this pass |
| `artifacts/world-vegetation-cpu.log` | Pass: 59 World CPU tests |
| `artifacts/world-vegetation-foliage-cpu.log` | Pass: 76 Foliage CPU tests, including 29 geometry/surface/tree-quality checks |
| `artifacts/world-vegetation-landscape/report.json` | Pass: controls, current-source placements, actual orbit/zoom/pan pixels, resize/preset restoration and existing render/roof/map gates; zero errors |
| `artifacts/world-vegetation-natural/report.json`, `artifacts/world-vegetation-stylized/report.json` | Pass: both style captures, four cottage families and preserved/reset roof edits; zero errors, functional-only |
| `artifacts/world-vegetation-trees/result.json` | Pass: three species, three matched angles, near/middle/impostor canopy checks; zero errors |
| `artifacts/world-vegetation-trees-old-mip-tail/result.json` | Expected failure, exit 1: restored transparent mips lose canopy for all three species and angles; zero browser/GPU errors |
| `artifacts/world-vegetation-foliage-gpu.log` | Pass, exit 0: native Foliage at portable-eight limits, including the 60k-plant fixture, GI reception, wind/motion and alpha |
| `artifacts/world-vegetation-foliage-surface.log` | Pass, exit 0: leaf cutouts, atlas normals, native shadows and motion/repacking checks |
| `artifacts/world-vegetation-gi.log` | Pass, exit 0: `GI-SMOKE PASS storage=8`, no validation errors; SRC traversal assertions explicitly skipped because this fixture compiles SRC out |
| `artifacts/world-vegetation-build.log` | Pass, exit 0: production build, approximately 1 minute 32 seconds |

Current Natural captures show much fuller crowns, but the scene still looks dark and flat, and repeated twig patterns remain visible close up. Sky and lighting quality, bank transitions and exposed rock polish remain visibly below the owner's reference. **The visual quality gate is still open.** All current GPU runs are functional receipts, with no new performance certification. Earlier bank/surface and foliage passes remain historical evidence for their source versions. Atmosphere's sky/cloud/weather visual upgrade remains deferred, and the production World module, unified authoring lifecycle and complete playable valley remain unfinished.

## Measurement method and interpretation

Reference system: Ryzen 9 8945HS, 32 GiB installed RAM, NVIDIA Lovelace adapter (RTX 4070 Laptop GPU on this machine), Chrome 152, 1440 × 900 at device pixel ratio 1. Reports record the adapter identity exposed by WebGPU; they do not infer speed on other adapters.

Every arm starts a fresh browser profile. Cold readiness includes imports, scene construction, atlas preparation, initial material/pipeline compilation, first frame and submitted-work completion. It is a fixture-specific readiness measure, not a certificate that every possible camera's shaders or full game systems are ready. Initial scene shader preparation runs while this isolated scene is stopped; the engine starts after that preparation. Subsequent native sky refresh work runs in preRender and remains part of full-frame CPU/GPU costs.

The runner measures five seconds at a fixed camera with a fixed sun, followed by five seconds with continuously advancing Atmosphere time. The latter must rotate the actual light and issue native shadow draws. Full instrumented Engine CPU phase totals, resolved aggregate GPU timestamps, presented-frame intervals, queue submissions/writes, texture copy calls and shadow draw callbacks are recorded. Explicit `scene.traverse` calls are counted; individual caster classifications and internal renderer object visits are not separately counted. No new shadow implementation is being assessed here.

GPU times describe the existing timestamp instrumentation, not isolated shadow raster duration. Fixed-sun and moving-sun results are sequential warm-up stages with different lighting; they cannot establish that moving lights are faster. Draw counts include the current camera and native shadows. Copy counts cover encoded texture copies during each window, not CPU copies or work outside it.

**GI is disabled in the visual fixture.** There is no collision/player traversal, live editor overhead, camera sweep, large-world streaming, repeated-generation soak or target mobile profile. Those costs must be measured before promoting any result to a World release claim. Raw reports are the source of exact measurements.

### Original single-cottage measurements

All three original arms passed on 2026-09-12, before the four-family variation follow-up. These are individual runs, not confidence intervals or performance measurements of the revised buildings. Fresh Chromium profiles were used; OS/driver caches were not cleared.

| Arm | Fresh-profile ready | Fixed-sun CPU mean | Moving-sun CPU mean | Moving-sun GPU mean | Moving-sun frame p95 |
|---|---:|---:|---:|---:|---:|
| Existing-content baseline | 4.32 s | 2.849 ms | 2.735 ms | 1.9 ms | 8.9 ms |
| Natural specimen | 4.57 s | 2.999 ms | 2.703 ms | 2.0 ms | 8.8 ms |
| Stylized specimen | 4.59 s | 3.142 ms | 2.819 ms | 2.0 ms | 8.8 ms |

The natural specimen spent 0.80 s constructing the scene and 2.62 s in atlas/initial compile preparation. Its moving sun rotated 0.480 radians during the capture, with 26 native shadow draw callbacks, 4.09 queue submissions, 197 buffer writes and zero encoded texture copies per frame. The renderer reported approximately 147.1 MiB of tracked resources before artistic edits; this is not total process/adapter memory. The median draw count was 63. Native shadows and wind remained active.

The natural roof patch's measured red/green ratio changed from 0.949 to 1.685 when painted, remained 1.684 after reseeding, and returned to the new generator color at 1.128 after reset. Both style arms passed the same visible-paint checks. Natural-arm image receipts include `cottage.png`, `roof-painted.png`, `roof-regenerated.png` and `roof-reset.png`; all arms include four viewpoint captures and `report.json`.

The required generic GI runtime smoke also passed using a separate external profile:

```powershell
$env:GPU_SMOKE_PROFILE = Join-Path $env:TEMP ('world-gi-' + [guid]::NewGuid().ToString('N'))
node scripts/run-gpu-page.mjs http://127.0.0.1:5401/scripts/gi-gpu-smoke.html 70000
```

Receipt: `GI-SMOKE PASS storage=8 mode=hybrid-brick-box`, with no WebGPU validation errors (`artifacts/world-gi-smoke.log`). This arm compiles SRC out and explicitly skips its traversal counters; it validates the existing runtime fixture, not SRC transport quality/performance or a composed World water/GI shader. Its unrelated missing-resource 404 is recorded in the log.

## Integration findings

1. Initial native shadow-depth allocation can replace a depth texture that a receiver binding has already sampled. In the isolated study, complete initial material compilation and initialize the shadow targets before starting the loop. This avoids the observed destroyed-texture validation error. It is not a production fix or a reason to compile a live scene with temporary override materials.
2. Terrain's async material resolution can overwrite a fixture-assigned material. The study waits for initial resource preparation and then installs its owned material; a real provider must use the engine's material ownership contract.
3. Atmosphere time advances through the engine's playing state. Merely setting a day length gave a false moving-light benchmark while the loop rendered in edit mode. The fixture now starts playing and asserts actual light-angle change plus shadow draw work.
4. Dry sentinel elevations cannot feed interpolated shoreline vertices: a fragment mask does not repair triangles displaced below the surface. The surface extension and matching pond footprint correct the fixture's initial shoreline errors.

## Remaining gates and next implementation

| Gate | Status |
|---|---|
| Pure edit identity, inheritance, orphan/pin and replay behavior | 16 tests pass |
| Validated water domain and CPU/raster representation | 15 tests pass |
| Fixture shoreline triangles and matching pond carve | 2 regression tests pass, including old-bug controls |
| Shared valley fields, terrain clearance and ecological masks | 9 field + 12 ecology CPU tests and current-source landscape browser checks pass |
| Vegetation shape/patch controls and free camera navigation | CPU controls/patches and current browser interaction/render checks pass |
| Optional material surfaces and geography/surface controls | Natural/material and Stylized/procedural browser, landscape swatch/control, portable-eight GI and build checks pass |
| Placed populations and native sky refresh | Current 83 Foliage and 44 Atmosphere CPU tests, native GPU and live/held sky checks pass; earlier editor-flow receipts retained |
| Distinct cottage families and arbitrary persistent roof color | 5 CPU tests and both style browser arms pass |
| Shared tree shape controls, retained placements, undo/reload | CPU and real editor checks pass |
| Distant tree canopy survival | Current three-species/three-angle near/middle/impostor comparisons pass; old transparent-tail failure retained as historical evidence |
| Packed field on real WebGPU at portable limits | Exact 4 MiB comparison passes |
| Actual continuously moving sunlight | Light-angle and native shadow-draw assertions pass |
| Finished terrain/shore/forest/rock patch | Open; present landscape is a technical specimen |
| Production shared water, physics and GI composition | Open |
| World document/module, editor commands, assets and export | Phase 1; not implemented |

Next work should close the visual specimen gate and then implement Phase 1's smallest complete document/provider path. Keep the resolver as a pure layer, add versioned document/operation ownership and generation transactions, adapt one Terrain edit and one building feature, and prove edit → regenerate → undo/redo → save/reload → duplicate → exported player. Do not promote this fixture's direct scene/material manipulation into the production provider contract.
