# World study performance: September 12, 2026

Three accepted changes reduce repeated foliage shading while retaining the current planting and appearance: skip inactive surface weather, order native foliage chunks by depth, and draw eligible trees' alpha-cutout depth before their lit material. In the final controlled pair at native 1920 × 1080, the forest view improved from **73.66 to 110.07 presented FPS**, with GPU time falling from **13.1 to 8.7 ms**. At native 3840 × 2160, it improved from **29.16 to 50.39 FPS**, with GPU time falling from **33.5 to 19.3 ms**. **This does not achieve 60 FPS at 4K.**

This is the existing 128 m World study, not production World integration or acceptance against the realistic nature reference. Full World authoring, streaming, GI/water composition and the planned 1 km valley remain open. The atmosphere's sky/cloud/weather appearance upgrade remains deferred.

## Measurement conditions

The owner closed the live preview before these controlled runs. GPU browsers ran serially, each using an external temporary Chromium profile, with one local Vite at `127.0.0.1:5401`. All four accepted reports record `isolation: true`, pass, portable `maxStorageBuffersPerShaderStage: 8`, and no page/WebGPU errors. The adapter identifies itself as NVIDIA Lovelace; the browser does not expose a precise model name in these receipts.

The viewport was 1920 × 1080 CSS pixels. DPR 1 produced an actual **1920 × 1080** canvas; DPR 2 produced an actual **3840 × 2160** canvas. Render scale remained 1. Neither density nor output resolution was reduced between an old/new pair. These are same-machine comparisons, not hardware-independent frame-rate promises or cold-start benchmarks.

Each stationary viewpoint and moving-sun window ran for approximately four seconds after preparation and a 2.2-second settling interval. The orbit window ran for approximately eight seconds, turning the camera through a full circle while the sun continued moving. Presented FPS is completed rendered frames divided by elapsed wall time. CPU is the complete engine phase capture, including render encoding, preparation, matrix updates, shadow classification and bookkeeping. GPU is the mean of freshly resolved GPU timestamps in that window. CPU/GPU overlap, so their values must not be added to predict frame duration; actual frame p95 is reported separately. These short windows are not a long-duration soak.

The comparison arms use the same source tree:

| Arm | Weather shading | Foliage packing | Eligible tree depth draws |
|---|---|---|---|
| Legacy | `__atmosphereDrySurfaceBranch = false` | `__foliageFrontToBack = false` | Disabled before initial compilation |
| Optimized | Normal dry-weather branch | Coarse front-to-back chunk order | Enabled before initial compilation |

The live sun, cloud drift, native foliage wind and native directional shadows remain enabled. The timed moving-sun windows change the actual light direction and record native shadow draws; a stale frozen light/shadow is not the source of the gain. Both timed arms are live simulations, so separate-run screenshots are not exact-pixel controls. The held comparisons below establish appearance and instance preservation separately.

## Complete frame results

All entries are **legacy → optimized**. CPU is milliseconds per complete engine frame, GPU is milliseconds per resolved frame, and p95 is actual presented-frame milliseconds.

### Native 1920 × 1080

| View / motion | Presented FPS | Complete CPU ms | GPU ms | Frame p95 ms | Median draws |
|---|---:|---:|---:|---:|---:|
| Valley | 91.34 → 120.07 | 3.640 → 3.983 | 10.6 → 6.8 | 12.3 → 9.1 | 71 → 80 |
| Shore | 108.15 → 119.98 | 4.347 → 4.377 | 8.8 → 7.0 | 10.7 → 8.9 | 70 → 82 |
| Forest | 73.66 → 110.07 | 4.295 → 4.440 | 13.1 → 8.7 | 14.9 → 10.4 | 70 → 82 |
| Cottage | 120.07 → 120.08 | 4.199 → 4.189 | 6.4 → 5.6 | 9.0 → 9.0 | 80 → 92 |
| Valley, moving sun | 82.14 → 117.66 | 3.981 → 3.931 | 11.7 → 8.1 | 13.6 → 9.6 | 72 → 81 |
| Full orbit, moving sun | 108.82 → 119.96 | 3.698 → 4.265 | 6.2 → 4.9 | 12.0 → 9.4 | 70 → 76 |

The orbit averages different views, including views with less foliage on screen. Its frame rate is not the forest viewpoint's sustained frame rate. The accepted changes primarily save GPU work; CPU did not improve in every window, and the table retains those increases.

Several 1080p windows reach the approximately 120 FPS presentation ceiling; their GPU savings do not imply uncapped frame rates. Sources: [final legacy 1080p receipt](../artifacts/world-performance-complete-before-1080/report.json), [final optimized 1080p receipt](../artifacts/world-performance-complete-after-1080/report.json). Runs began at 15:00:49 and 15:01:43 UTC respectively.

### Native 3840 × 2160

| View / motion | Presented FPS | Complete CPU ms | GPU ms | Frame p95 ms | Median draws |
|---|---:|---:|---:|---:|---:|
| Valley | 32.99 → 47.43 | 4.148 → 4.610 | 29.1 → 20.4 | 33.4 → 24.0 | 71 → 80 |
| Forest | 29.16 → 50.39 | 4.028 → 5.228 | 33.5 → 19.3 | 36.2 → 22.2 | 70 → 82 |
| Valley, moving sun | 30.15 → 47.45 | 3.721 → 4.480 | 31.5 → 19.9 | 34.9 → 22.7 | 72 → 81 |

No 4K orbit result was recorded in these accepted receipts. The 4K forest remains GPU limited, with approximately 19.3 ms of GPU work against roughly 5.2 ms of complete CPU work. The extra depth draws increase CPU work in this window; that cost is included above.

Sources: [final legacy 4K receipt](../artifacts/world-performance-complete-before-4k/report.json), [final optimized 4K receipt](../artifacts/world-performance-complete-after-4k/report.json). Runs began at 15:02:38 and 15:03:13 UTC respectively.

### Moving-light work beyond raster time

These are actual counters per rendered frame, legacy → optimized. “Walks” counts calls to the scene root's `traverse`, not every recursive object visit; complete CPU capture includes other traversal/classification work. Buffer writes include ordinary frame uniforms and native updates, not only instance uploads.

| Window | Queue submissions/frame | Buffer writes/frame | Native shadow draws/frame | Root walks/frame | Texture copies/frame | Actual sun turn |
|---|---:|---:|---:|---:|---:|---:|
| 1080p moving sun | 3.283 → 3.240 | 243.018 → 271.011 | 28.006 → 28.002 | 0.033 → 0.023 | 0 → 0 | 22.022° → 21.984° |
| 1080p orbit + moving sun | 3.468 → 3.595 | 261.020 → 286.988 | 28.584 → 28.681 | 0.024 → 0.022 | 0 → 0 | 43.834° → 43.836° |
| 4K moving sun | 3.521 → 3.379 | 243.058 → 271.032 | 28.025 → 28.011 | 0.083 → 0.058 | 0 → 0 | 22.117° → 21.957° |

Every accepted window records zero texture copies. These profiler shadow counters cover the entire scene. Stationary valley/forest windows retain 27/30 native shadow draws per frame respectively, because foliage wind is still running. Depth draws add buffer writes, and the orbit's submission cost also increases; both costs are included in the complete frame result. No directional-shadow cache replacement, resolution reduction or moving-light hold is introduced by this pass.

### Earlier two-change checkpoint

Before tree depth was accepted, dry-weather shading and chunk ordering alone improved the forest from 62.47 to 79.21 FPS at 1080p and 28.46 to 35.24 FPS at 4K. Those earlier pairs remain in the [legacy 1080p](../artifacts/world-performance-legacy-final/report.json), [optimized 1080p](../artifacts/world-performance-optimized-final/report.json), [legacy 4K](../artifacts/world-performance-legacy-4k/report.json) and [optimized 4K](../artifacts/world-performance-optimized-4k/report.json) receipts. They are historical measurements; the final three-change tables use their own fresh baseline, whose timing differs. Cross-checkpoint subtraction would not isolate the depth pass's contribution.

## Scene content retained

Both arms use seed 894, Natural style, material surfaces, tree/grass scale 1, density 1, and planting patchiness 0.65. All use the same **32,929 plants**:

| Population | Count |
|---|---:|
| Mature trees: 173 oak, 26 birch, 33 pine | 232 |
| Shrubs: 392 oak and 135 birch prototypes | 527 |
| Short meadow grass | 13,018 |
| Long meadow grass | 8,728 |
| Bank rushes | 916 |
| Flowers | 222 |
| Woodland floor plants | 9,286 |
| Ground cover subtotal | 32,170 |

Terrain retains 66,049 vertices and its current bank profiles. The six decoded 1024² albedo/height textures, bump strength and physical tile scales remain unchanged. Rocks retain 442 stone pieces, 35,240 triangles and three draws. The cottage, water domain, tree prototypes, leaf cards, cutout alpha, LOD distances, far-canopy representation and shadow settings remain in place.

The source geometry and planting stay unchanged, while depth draws deliberately add submitted geometry work. At 1080p, valley triangles rise from 2,659,755 to 3,696,261 and forest triangles from 7,508,320 to 10,555,056; the 4K forest rises from 7,418,349 to 10,437,673. These frame statistics include repeated rendered work and are not counts of unique asset triangles. Both optimized initial reports contain 12 eligible depth batches; per-view actual draws depend on native visibility. The gain comes from rejecting hidden fragments before full lighting, without replacing silhouettes or removing plants.

## Accepted implementation and correctness

### Dry surface weather

[weatherSurface.js](../src/modules/atmosphere/weatherSurface.js) previously evaluated snow/puddle noise and roof exposure even with both snow and wetness at zero. The material remained patched in dry weather, but its documented uniform branch was absent. `withSurfaceWeather` now leaves the complete weather graph installed and skips that work when both uniforms are exactly zero. Positive amounts, including very small transitions, execute the original formulas. Dry roughness retains the original `[0.02, 1]` clamp.

**Native normal initialization must precede the branch.** The weather diffuse wrapper builds before native material lighting. Its first `normalWorld` read can initialize `normalView`, the tangent frame and an authored normal map. The first branch implementation placed that initialization inside the conditional; dry lighting then reused zero normals and lost directional light. The real GPU test failed with a maximum error of 63 bytes and 34.9% changed RGB channels. Merely building a replacement fragment node had missed this native material ordering.

The fix explicitly calls `normalWorld.toStack()` before the conditional. The [corrected GPU receipt](../artifacts/world-performance-weather-parity-fixed/report.json) has **zero differing RGB channels in all six states**: dry, tiny wet, wet, snow, mixed and restored dry. Wet/snow controls visibly change 102,960 pixels, and uniform transitions compile zero shaders or render pipelines. It exercises actual production wrappers with authored color, normal, roughness and metalness nodes, including authored roughness 0 and 1.4. [The preserved failure](../artifacts/world-performance-weather-parity-debug/report.json) and generated WGSL document the rejected implementation.

`test:atmosphere` now passes 44 tests. The focused [surface tests](../tests/atmosphere-surface.test.mjs) build installed Three WGSL, verify all ten weather texture operations fall under uniform control flow, retain authored map/normal evaluation and dry clamping, and exercise the actual native material wrapper. An in-memory negative control removes only explicit normal initialization and fails the same native-normal gate, without editing workspace source.

### Native foliage chunk order

[foliageBatchOrder.js](../src/modules/foliage/foliageBatchOrder.js) sorts existing opaque, depth-writing chunk records from front to back. It uses world-space chunk bounds, 45° yaw and 30° pitch bins with 5° hysteresis. Camera translation does not change relative view-depth order. Whole typed-array ranges are copied only when LOD membership or an accepted direction bin changes; roots and matrices are not regenerated or edited.

Transparent, transmitting and non-depth-writing/tested materials retain their prior order. Offscreen selected chunks remain in the native batches so their shadows continue to render. **Paused/static shadow casters retain their packing on camera yaw:** changing instance-buffer versions for a purely ordering change would otherwise invalidate an unchanged native shadow cache. Animated casters may update order while their native wind already requires fresh shadows.

The [held native World comparison](../artifacts/world-performance-order-parity/report.json) passes valley, shore and forest at three forest angles. It validates the complete submitted matrix/impostor record multiset against source records, preserving multiplicity, instance counts and geometry; it also checks first-frame synchronization and restoration. Its instrumented shadow counters cover native foliage batches only. Whole-frame order differences are very small, but not universally byte identical: opaque coplanar depth ties changed at most 43 pixels out of 1,296,000 in the recorded cases. First/settled and restoration differences were zero or confined to the one-byte variation also observed by unchanged-order controls. This is separate from the exact weather-branch comparison.

## World tree depth: accepted for the isolated study

[worldDepthPrepassStudy.js](../scripts/lib/worldDepthPrepassStudy.js) now passes its held correctness and lifecycle gates and is enabled by default in the World HTML before initial shader compilation. It adds depth-only alpha-cutout draws for eligible native near/mid oak, birch and pine batches before their lit draws. These run in the same ordinary main pass, borrowing the exact source geometry, instance matrices and deformation node; they do not allocate a second renderer, scene override, offscreen target or texture. Depth proxies cast no shadows. Grass, flowers and distant impostors retain their native paths.

The benefit is that hidden tree fragments fail depth before executing the expensive lit material. It deliberately adds vertex work and draw calls rather than reducing tree detail. This implementation is restricted to the study's known opaque, depth-writing native tree materials. Unsupported alpha/depth/raster states and custom fragment/depth/mask nodes withdraw the borrower. Enabled or registering GI, an override material, MRT or renderer clipping also withdraw it. It is not production GI or arbitrary alternate-pass integration.

The helper synchronizes source count, visibility, matrices, layer mask and bounds before rendering. Removing or disposing a source withdraws its borrower immediately, before source geometry retires. Regeneration adopts the replacement native source. Material graph changes rebuild only the helper's owned depth material, and disposing the helper releases neither source geometry nor source material. Six [lifecycle/eligibility CPU tests](../tests/world-depth-prepass.test.mjs) cover those boundaries, including idempotent disposal and prevention of retired-source resurrection.

The [final hardened depth parity receipt](../artifacts/world-performance-depth-parity-final/report.json) passes all six cases: valley, forest, shore, two angled forest views and the first frame after a forced LOD repack. Native source records and instrumented foliage-only shadow draw counts stay unchanged (13 in valley, 14 in the other held views). The positive forest angle is byte exact; other comparisons have at most one byte per channel and remain inside the same-case unchanged-render variation. First/settled and restored frames are exact or within that measured one-byte floor. No extra depth-tie allowance is granted to the depth pass. Native alpha and wind deformation remain active at held time while actual render-frame identities advance, so the test exercises real matrix synchronization rather than repeatedly reading one cached frame.

Earlier [4K depth diagnostic timings](../artifacts/world-performance-depth-diagnostic/report.json) informed this implementation, but did not by themselves establish correctness. The final hardened parity gate and combined controlled receipts above supersede that diagnostic checkpoint.

## Validation receipts

| Check | Result and scope |
|---|---|
| CPU regression suites | **192 passed, zero failed**: [World 65](../artifacts/world-performance-world-cpu-final.log), [Foliage 83](../artifacts/world-performance-foliage-cpu-final.log), [Atmosphere 44](../artifacts/world-performance-weather-cpu-final.log). |
| Weather material parity | [Six states pass exactly](../artifacts/world-performance-weather-parity-fixed/report.json), authored nodes/clamping preserved, live uniform transitions without recompilation. |
| Native order and depth parity | [Order: five held cases](../artifacts/world-performance-order-parity/report.json); [depth: six held cases](../artifacts/world-performance-depth-parity-final/report.json), including immediate LOD repack, native alpha/wind and unchanged foliage shadow draws. Tolerances differ as explained above. |
| Native foliage GPU | [Full fixture](../artifacts/world-performance-foliage-gpu.log) passes portable eight, actual near/far GI reception, wind, interaction and 60,000 plants; [surface fixture](../artifacts/world-performance-foliage-surface.log) passes cutouts, shadow pixels and consecutive instance repacks. These native fixtures do not install the study-only depth helper. |
| Generic GI GPU | [GI-SMOKE PASS storage=8](../artifacts/world-performance-gi-smoke.log), without WebGPU binding validation errors. This generic arm opts out of SRC, so its tracer step/plane/triangle assertions are explicitly skipped; it does not certify full World GI or SRC transport. The native foliage fixture separately observes positive irradiance and changed GI pixels. |
| Build | [Final production Vite build passes](../artifacts/world-performance-build-final.log), with the existing externalization and large-chunk warnings. The actual study HTML/module is also exercised by the final GPU runs. |
| Final integrated landscape | [Pass](../artifacts/world-performance-landscape-final/report.json): real orbit/pan/zoom, preset/resize behavior, regeneration, manual roof preservation, native foliage buffers, material surface checks, water bindings/pixels and layer counts with depth enabled by default. |

All four final performance reports and the final integrated landscape receipt pass without page or WebGPU errors. The visual quality target and production World integration remain open.

## Reproduce

Close other GPU previews/editor loops before setting the isolation receipt flag; the flag records the operator's condition and does not stop other applications. Use one Vite and run these commands serially. `CHROME_PATH` can select a different installed Chromium executable.

```powershell
$env:WORLD_PROFILE_ISOLATED = '1'
$env:WORLD_PROFILE_DPR = '1'
$env:WORLD_PROFILE_POSES = 'valley,shore,forest,cottage'
$env:WORLD_PROFILE_ORBIT = '1'
$env:WORLD_PROFILE_OLD_WEATHER = '1'
$env:WORLD_PROFILE_OLD_ORDER = '1'
$env:WORLD_PROFILE_DEPTH = '0'
node scripts/profile-world-study.mjs http://127.0.0.1:5401/scripts/world-valley-study.html artifacts/world-performance-legacy-repeat
$env:WORLD_PROFILE_OLD_WEATHER = '0'
$env:WORLD_PROFILE_OLD_ORDER = '0'
$env:WORLD_PROFILE_DEPTH = '1'
node scripts/profile-world-study.mjs http://127.0.0.1:5401/scripts/world-valley-study.html artifacts/world-performance-optimized-repeat

$env:WORLD_PROFILE_DPR = '2'
$env:WORLD_PROFILE_POSES = 'valley,forest'
$env:WORLD_PROFILE_ORBIT = '0'
# Repeat the two arms above with separate output directories for 4K.

node scripts/run-atmosphere-surface-parity.mjs http://127.0.0.1:5401 artifacts/weather-parity-repeat
$env:WORLD_PARITY_DEPTH = '0'
node scripts/run-world-order-parity.mjs http://127.0.0.1:5401/scripts/world-valley-study.html artifacts/world-order-repeat
$env:WORLD_PARITY_DEPTH = '1'
node scripts/run-world-order-parity.mjs http://127.0.0.1:5401/scripts/world-valley-study.html artifacts/world-depth-repeat
$env:WORLD_PARITY_DEPTH = '0'
npm run test:world
npm run test:atmosphere
npm run test:foliage
```

The ordinary World preview enables the eligible depth draws by default; `?depth=0` disables them for inspection. The profiler deliberately chooses its arm before initial compilation: `WORLD_PROFILE_DEPTH=1` requests depth and `0` disables it, and the report requires that requested state to match actual installed batches. To reproduce the earlier two-change checkpoint, use optimized weather/order with depth set to 0. After TSL sampling changes, the repository's generic GI runtime smoke remains required at portable eight; a Vite build alone cannot certify GPU pipelines.
