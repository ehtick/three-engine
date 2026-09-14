# World editor integration

The first World recipe is integrated into the normal editor and exported player. Its default is a seeded 128 × 128 m layout, with a generated landform, basins, watercourses, ridges, a settlement and its road network. It is not acceptance of the realistic nature reference or completion of the large-world plan.

## Create and edit

In the Hierarchy creation menu, choose **World → Temperate valley**. World enables its required Terrain, Water, Foliage, Architecture and Atmosphere modules. Each remains independently usable; a provider required by World cannot be disabled underneath it. Previously selected modules remain enabled after World is disabled.

Select the World root for its inspector. **Every parameter applies as you move it** — there is no Apply or Regenerate step for settings. Dragging a slider cancels the in-flight generation and starts again from the new value, so the viewport follows the control. Generation runs in short slices with the frame handed back to the renderer between them, and the previous world stays visible and interactive until the new one is complete. A whole drag collapses into one undo entry.

### The parameter table

`src/engine/world/worldConfig.js` is the single source of every control: its default, its range, its authoring group, its help text and the stage it invalidates. The inspector, document validation and the editor API are all generated from it, so a generator control cannot exist without also being configurable, serializable and reachable from automation. `describeWorldParameters()` returns that description.

| Group | Controls |
| --- | --- |
| World | Extent (128–512 m) and seed |
| Terrain | Landform (valley, basin, plains, highland, plateau, slope, ridgeline), landform strength, relief, base height, feature scale, roughness, detail, domain warp, ridge sharpness, terracing, rock exposure |
| Landforms | Number, height, width, length, alignment and variation of the generated hill ranges; number, height, face width, length, alignment and variation of the generated cliff escarpments (bounded mesas with a steep rock face, a flat top and a talus foot — steep cells automatically read as rock, grow larger outcrop formations and exclude vegetation) |
| Water | Lake count/size/depth, river count, tributaries, meandering, river width/depth/fall |
| Banks | Shore softness, bed slope, beach width and grade, flood terrace, shoulder start/grade/length, bank roughness |
| Settlements | Settlement count, town plan (scattered, cluster, street, grid), building budget, spread, water affinity, plot frontage/depth/setback, orientation jitter, road and lane widths, maximum road grade, outbuilding share, landmark, building size |
| Vegetation | Forest coverage, tree and ground density, clustering, tree size, grass height |
| Look | Natural/Stylized treatment, ground finish, surface scale and relief, sky ownership |

Each parameter declares what a change invalidates — `layout`, `field`, `scatter` or `look`. A colour change reuses the layout, the sampled fields, the planting and the geology; a density change reuses the layout and the fields; only a landform or siting change re-runs everything. That is what keeps a live edit affordable.

**New seed** advances the seed as an ordinary undoable edit. **Local edits** selects an individual building for a persistent roof colour or direct Architecture editing (forms, openings, paint — model edits survive regeneration as provider overrides), or the native Terrain for its sculpt and paint brushes.

### What the generator decides

`worldLayout.js` derives, from the seed and the configuration: the basin centres and contours, connected downhill rivers with level confluences for their tributaries, the ridge and cliff-escarpment features, the settlement sites, their street networks, the plots along those streets and the lanes between places.

`settlements.js` plans a place rather than scattering houses. It scores sites for dry, workable, water-adjacent ground; grows streets that follow the contour within the configured grade; spaces plots along the street frontage; and faces each building at the street it fronts. Buildings carry a role — house, barn or hall — which selects a construction family and a footprint, and a settlement is reported as a hamlet, village or town by the number of buildings it actually got. Counts are maxima: the inspector reports how many of the requested buildings had no dry, level, road-served plot.

Roads are one network. Crossing reaches share their junction vertex, every reach samples the same ground, and each is then relaxed to its grade limit with junctions held. The terrain grades its own carriageway to that profile, so a street is walkable rather than painted onto bumpy ground. A connecting lane prefers ground an existing road already surfaces and is trimmed to the spur that is genuinely new, so two roads never lay competing surfaces over each other.

Building pads flatten their own rectangle exactly. Every pad's blend is shortened until it fits: it may not reach inside a neighbouring plot, run off the terrain, or repave a road.

## Runtime and persistence

`WorldComponent.props.document` is a versioned, renderer-independent JSON value: recipe/settings, semantic feature edits, native provider overrides, sparse additive terrain edits and explicit resource references. Stable feature keys connect generated products to their source. Children are serialized as a normal provider cache and reconciled by feature key; regeneration reuses their entity IDs, including after scene reload or duplication. This deliberately retains existing scene/command behavior at the cost of larger cached scene files.

Native hand-placed descendants survive a generator omitting their former feature: they move under the World root while preserving their world pose. Explicitly deleted generated features retain deletion tombstones; native Undo restores their feature keys. A settings toggle such as “Include houses” does not create a user deletion. Edits targeting a house omitted by a new seed remain in the document as orphan edits, ready if that feature returns.

Generation loads resources and prepares the next recipe before changing the live scene. New requests invalidate old pending requests. Deleting/disabling World cancels publication and releases its owned runtime resources. Resource failures keep the previous scene and display an error; native commit failures restore the previous provider state. This is revision cancellation and transactional publication, not worker-based or region-based incremental generation.

The native Terrain owns its geometry, paint layers and final surface material. World lends the procedural base to its normal layer blend, preserving material paint. Selecting the Terrain does not create a replacement flat material. World owns the grid its extent resolves to — 256 segments up to 192 m, 320 up to 320 m, 384 above — which keeps terrain cells between 0.5 m and 1.35 m at every size; independent Terrain retains its own size/resolution controls. Sculpt edits are stored against that grid and a document cannot reinterpret them at another resolution.

`whenReady()` resolves after the current generation and foliage atlas jobs. Check `status === 'Ready'` or `status === 'Error'`; caught failures resolve with an error status. It does not certify that all renderer pipelines have completed their ordinary asynchronous warm-up.

## Assets and export

World's default grass/soil/rock surfaces ship as six local CC0 maps (6,716,074 file bytes), with provenance under `src/modules/world/assets/`. Production uses bundled URLs, without a dependency on development pages or `/world-study/` assets. Optional `resources.surfaceMaps` replaces the three roles, each with `{albedo,height,size:[metresX,metresY]}`. `resources.materials` accepts `.mat` references for `ground`, `rock`, `cottage` and `water`; those materials are borrowed from the ordinary asset cache.

Export infers World and its dependency closure from shipped scenes/prefabs even if project module preferences omit them. Explicit World refs, nested native provider refs, materials and their textures are rewritten and copied. The export smoke invokes the real exporter, then serves the exact result under a nested path to the unmodified player. See [WORLD_EXPORT.md](WORLD_EXPORT.md).

## Deliberate first-integration limits

- Terrain, Foliage and optional Atmosphere are native providers. Settlement houses are generated **as editable Architecture models** (`settlement.editableBuildings`, default on): each house is one connected `architecture` component (gable-roofed forms, real door/window apertures) that the Architecture shelf/sculpt tools edit in place; model edits are captured as provider overrides and survive regeneration, exactly like roof colours. Setting the flag off restores the legacy baked study cottages (which the isolated 128 m study keeps regardless). Geology and the bounded water surface use promoted World provider code shared with the study; the river/lake appearance is not yet the full native water simulation/physics adapter.
- This is one fixed-size procedural valley/settlement recipe, not a full town grammar, bridge network, biome library, streaming world or 1 km² quality/performance milestone. Its lanes are terrain surface masks, not finished road meshes. Colliders, navigation, interiors and full gameplay readiness are not supplied automatically.
- Generation is sliced across frames and reuses everything a change cannot have invalidated, but it still rebuilds whole stages rather than dirty regions. Worker scheduling, region-level invalidation, full style resources and generator asset editors remain on the plan. A 128 m world is about 2.0 s of work cold with a worst uninterrupted block of 139 ms; a 512 m world is 4.4 s with a worst block of 238 ms. Those residual blocks are the water material graph, one water mesh's normals, one building and one row of a large world's planting.
- **World water is not the Water module.** The native `water` component simulates on a primitive plane or solid (`box`, `cylinder`, `sphere`, `cone`, `capsule`) and `MAX_WATER_SLOTS` is 2. The World's lakes are organic polygons and its rivers are sloping splines, so neither its shape nor its count fits that contract. World therefore renders its own domain-clipped surface, which gives it sky reflection, depth absorption and flow ripples but **not** the module's FFT waves, foam, buoyancy, underwater medium or caustics. Closing this means teaching the water module an arbitrary sampled domain for both its shader and its volume queries, and resolving the slot budget — the plan's Phase 3 work, and it needs GPU verification.
- Coastlines and archipelagos need a water body that is the complement of its islands, which the shared domain does not yet have; the landform list therefore stops at inland forms.
- Sky/cloud/weather appearance remains the existing Atmosphere implementation. The realistic nature visual target is still open.
- The latest standalone-study FPS figures are historical measurements of that scene. Editor and exported-player integration must be profiled separately at matched resolution and quality before making a new FPS claim.

The proven native tree depth prepass is shared with the study and used only in ordinary raster rendering; it withdraws for GI, postprocessing, render overrides, MRTs and unsupported source materials. Foliage keeps native wind/alpha/LOD and unchanged-buffer handling. This carries the implementation forward, without transferring the study's FPS measurement to the editor.

## Verification

`npm run test:world` includes document validation, deterministic fields/ecology, real native runtime and editor command ownership, terrain stroke/save/undo, cached duplication, cancellation/rollback and export resource closure. `npm run test:modules` covers dependency setup, leases, rollback and disposal ordering. `smoke:world-ui` and `smoke:world-export` use external scratch projects/browser profiles and run serially; the latter requires a current `npm run build:player`.

Current execution receipts and any remaining limitations are recorded with the integration checkpoint in [WORLD_PLAN.md](WORLD_PLAN.md).
