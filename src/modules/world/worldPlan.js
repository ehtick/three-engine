import * as THREE from 'three/webgpu';
import { createValleyFields } from '../../engine/world/landscapeFields.js';
import { sampleValleyPlanting } from '../../engine/world/valleyEcology.js';
import { normalizeWorldDocument, applyWorldTerrainEdits, worldGrid } from '../../engine/world/worldDocument.js';
import { resolveFeatureEdits, terrainEditsToHeightEdits } from '../../engine/world/featureEdits.js';
import { PROCEDURAL_TERRAIN_PARAMS } from '../../engine/terrain/proceduralTerrain.js';
import { planTerrain } from '../../engine/world/worldConfig.js';
import { worldLandscapeOptions } from '../../engine/terrain/proceduralTerrain.js';
import { getLandscapeSteps } from '../../engine/terrain/landscapeGenerator.js';
import { createLandscapeMaterials } from './worldLandscape.js';
import { createTerrainStone } from '../terrain/terrainRocks.js';
import { createStudyWaterSurface } from './worldWaterSurface.js';
import { createCottageStudy, describeCottageStudy } from './worldCottage.js';
import { cottageArchitectureModel } from './cottageArchitecture.js';
import { freeze } from '../../engine/freezeLedger.js';
import { FIELD_STRIDE, worldStageKey, sampleWorldHeight, makeGroundPalette, paintGroundVertex, worldPlanDataSteps, effectiveSwardSettings, terrainGroundColorProps } from './worldPlanData.js';

export { worldStageKey, sampleWorldHeight };

/** Never due: the synchronous driver runs straight through. */
const ALWAYS_RUN = { due: () => false };

// ---------------------------------------------------------------------------
// Worker dispatch (T-worker, 2026-09-13): `worldPlanDataSteps`'s pure-CPU work
// — layout/roads, the sampled terrain field, vegetation scatter, the drawn
// grass field and the water domain rasters — is what a boot/edit frame was
// starving at one slice per (100-200 ms, shader-compiling) frame (docs/
// WORLD_PRODUCTION_PLAN.md §7.5). Run off-thread, it finishes in its own CPU
// time. A persistent module-scope worker (matching `bvhBlasWorker.js`'s
// pattern) is created on first use and reused for every generation.
// ---------------------------------------------------------------------------

let planWorker = null, planWorkerBroken = false, nextPlanJobId = 1;

/** A manual escape hatch — never a generator parameter, so it cannot appear in
 * a World document's own settings table. Node/tests/export never see a global
 * `Worker` at all, so they always take the inline path without needing this. */
function mainThreadPlanForced() {
  return typeof globalThis !== 'undefined' && globalThis.__WORLD_PLAN_MAIN_THREAD__ === true;
}

function ensurePlanWorker() {
  if (planWorker || planWorkerBroken) return planWorker;
  try {
    planWorker = new Worker(new URL('./worldPlan.worker.js', import.meta.url), { type: 'module' });
    planWorker.addEventListener('error', () => { planWorker = null; planWorkerBroken = true; });
  } catch { planWorker = null; planWorkerBroken = true; }
  return planWorker;
}

/** Only the structured-cloneable subset of a `reuse` plan `worldPlanDataSteps`
 * actually reads — a live plan also carries THREE textures/materials, a
 * `products` Map of scene objects, and closures (`heightAt`, `update`,
 * `dispose`), none of which can cross a postMessage boundary and none of
 * which the data steps need. */
function reusableWorkerData(reuse) {
  if (!reuse) return null;
  const { layoutKey, layout, sites, fieldKey, fieldCache, scatterKey, ecology, grassField, packed, shoreCache, waterHeights } = reuse;
  return { layoutKey, layout, sites, fieldKey, fieldCache, scatterKey, ecology, grassField, packed, shoreCache, waterHeights };
}

/** Only the role averages `worldPlanDataSteps` reads out of `detailMaps` for
 * the grass field's baked ground colour — never the THREE textures themselves. */
function reusableWorkerMaps(detailMaps) {
  if (!detailMaps) return null;
  const out = {};
  for (const role of ['grass', 'soil', 'rock']) if (detailMaps[role]?.average) out[role] = { average: detailMaps[role].average };
  return out;
}

/**
 * Run `worldPlanDataSteps` inside `worldPlan.worker.js` for one generation.
 * Resolves to the finished reuse-shaped result, `'cancelled'` if `shouldCancel`
 * fired first (the worker is told to abandon that job, cooperatively — see
 * the worker's own header for why a respawn is not needed), or `null` if the
 * worker cannot be used at all (missing, failed to start, or it errored/threw)
 * so the caller falls back to the inline sliced generator.
 */
function runWorldPlanDataInWorker(input, { detailMaps, reuse, shouldCancel, onProgress } = {}) {
  const instance = ensurePlanWorker();
  if (!instance) return Promise.resolve(null);
  const id = nextPlanJobId++;
  return new Promise(resolve => {
    let settled = false, poll = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      instance.removeEventListener('message', onMessage);
      instance.removeEventListener('error', onError);
      if (poll != null) clearInterval(poll);
      resolve(value);
    };
    const onMessage = event => {
      const message = event.data;
      if (message?.id !== id) return;
      if (message.type === 'done') finish(message.result);
      else if (message.type === 'error') finish(null);
      else if (message.type === 'progress') onProgress?.(message.stage);
    };
    const onError = () => finish(null);
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', onError);
    if (shouldCancel) poll = setInterval(() => {
      if (shouldCancel()) { instance.postMessage({ type: 'cancel', id }); finish('cancelled'); }
    }, 30);
    try {
      instance.postMessage({ type: 'run', id, input, detailMaps: reusableWorkerMaps(detailMaps), reuse: reusableWorkerData(reuse) });
    } catch { finish(null); }
  });
}

/**
 * The Terrain component's own "Procedural" props, read out of a World
 * document's settings via `PROCEDURAL_TERRAIN_PARAMS.worldPath` — the same
 * table `worldConfig.js`'s `terrain` settings group derives from, so this
 * mapping cannot drift from what the Terrain schema actually declares (P1-T).
 */
function proceduralTerrainProps(settings) {
  const read = (path) => path.split('.').reduce((value, key) => value?.[key], settings);
  return Object.fromEntries(PROCEDURAL_TERRAIN_PARAMS.map((param) => [param.key, read(param.worldPath)]));
}

/** Kept for the player/export path (a baked-heightmap fallback); no longer
 *  used to feed the terrain feature itself — a procedural Terrain grows its
 *  own base grid and takes World's composition through an overlay instead
 *  (see `WorldComponent#_installTerrainSurface`, `landscapeFields.js`
 *  `createShapeOverlay`). */
export function encodeWorldHeights(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength); let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}

function waterGeometry(values, grid) {
  const geometry = new THREE.PlaneGeometry(grid.extent, grid.extent, grid.resolution, grid.resolution).rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, values[i]);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

/**
 * Generate a World in resumable steps.
 *
 * Each `yield` is a safe point: the caller may hand the frame back to the
 * renderer and continue, or call `.return()` to cancel, which disposes
 * everything this pass allocated. `prepareWorldPlan` drives it to completion
 * for tests, export and the player; the editor drives it a few milliseconds at
 * a time so a live parameter edit never blocks a frame.
 *
 * `reuse` is a previously published plan. Anything whose stage key still
 * matches is taken from it instead of being recomputed.
 */
export function* worldPlanSteps(input, { detailMaps = null, roleMaterials = {}, reuse = null, clock = ALWAYS_RUN } = {}) {
  const document = normalizeWorldDocument(input), settings = document.settings, start = performance.now();
  const { seed, style, geography, water: waterConfig, settlement, vegetation, surfaceScale, surfaceBump } = settings;
  const terrain = planTerrain(settings);
  const grid = worldGrid(settings), { extent, resolution } = grid;
  const owned = [], products = new Map();
  let disposed = false, published = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const resource of owned.reverse()) resource.dispose(); };
  try {
    // Every stage whose cost is pure CPU sampling — layout/roads, the sampled
    // terrain field, vegetation scatter, the drawn grass field and the water
    // domain rasters — lives in `worldPlanDataSteps` so it can also run inside
    // a Worker exactly as it runs here (see `prepareWorldPlanAsync`). What
    // follows only assembles THREE materials/geometry/meshes from what it
    // returns, plus its own `fields`/`domain`, cheaply rebuilt from the same
    // (possibly-refit) `layout` to sample rocks, buildings and the water texture.
    const data = yield* worldPlanDataSteps(document, { detailMaps, reuse, clock });
    const { layoutKey, layout, sites, fieldKey, fieldCache, scatterKey, ecology, grassField, packed, shoreCache, waterHeights } = data;

    // `sites` is deliberately the generator's ORIGINAL (un-refit) siting, even
    // when `layout` itself was refit around an authored move — see the note
    // on `worldPlanDataSteps`. `houses` below feeds `generated`, and the
    // ordinary feature-edit pipeline (`resolveFeatureEdits` further down)
    // reapplies the exact same authored transform on top of it either way.
    // Editable buildings carry their architecture model on the generated props,
    // so provider overrides capture user models against this exact default.
    const editableBuildings = settings.settlement.editableBuildings !== false;
    const houses = sites.map(site => {
      const variation = (site.variationSeed + settings.cottageVariation) >>> 0;
      const building = describeCottageStudy({ style, seed:variation });
      return { id:site.id, kind:'building', position:site.position, rotation:site.rotation,
        ...(editableBuildings ? { provider:'architecture' } : {}),
        props:{ roofColor:building.roofColor, variation, family:building.family, label:building.label,
          role:site.role ?? 'house', settlement:site.settlement ?? null, buildingScale:site.scale ?? 1,
          ...(editableBuildings ? { model:cottageArchitectureModel({ style, seed:variation, roofColor:building.roofColor, buildingScale:site.scale ?? 1 }) } : {}) } };
    });
    // When the data stages ran in the Worker, this thread's landscape cache is
    // empty and the next line would build the macro grid (0.5-1.3 s at 2048 m)
    // in one block — part of the 09-14 Play freeze. Build it sliced first.
    yield* getLandscapeSteps(worldLandscapeOptions(terrain, { seed, extent }), clock);
    const fields = createValleyFields({ ...geography, terrain, water: waterConfig, seed, extent, terrainStep: grid.step,
      pathWidth: settlement.laneWidth, ...(layout ? { layout } : {}) });
    const baseHeights = new Float32Array(grid.vertices), colors = new Float32Array(baseHeights.length * 3), surface = new Float32Array(baseHeights.length * 4);
    // What the finished ground actually looks like, kept whatever it is
    // textured with, because the grass reads it so a blade's root can be the
    // colour of the ground it grows out of. In procedural mode that is the
    // palette below; with surface maps it is those maps' own average colours
    // blended by the same masks the terrain material blends them with.
    const groundTint = new Float32Array(baseHeights.length * 3);
    const natural = style === 'natural';
    // `fieldCache` is always populated by `worldPlanDataSteps` above — reused
    // from a previous plan, freshly sampled here, or freshly sampled off-thread
    // in a Worker — so this loop never calls `fields.sample()` again; it only
    // paints the vertex colours a look-only edit can still repaint every time.
    const palette = makeGroundPalette({ style, detailMaps, grassSettings: effectiveSwardSettings(settings.grass, document.providerOverrides?.['foliage/meadow']?.props), groundSettings: settings.ground });
    for (let r = 0; r <= resolution; r++) {
      // Yield on elapsed time, never on a row count: a fixed stride is a 2 s
      // freeze at 512 m and a wasted context switch at 128 m.
      if (clock.due()) yield 'terrain';
      for (let c = 0; c <= resolution; c++) {
        const x = c * grid.step - grid.half, z = r * grid.step - grid.half, i = r * (resolution + 1) + c, f = i * FIELD_STRIDE;
        const shoreDistance = fieldCache[f+1], rockMask = fieldCache[f+2], moisture = fieldCache[f+3], forestMask = fieldCache[f+4], pathMask = fieldCache[f+5];
        baseHeights[i] = fieldCache[f];
        const planting = sampleValleyPlanting(seed, x, z, vegetation.patchiness);
        // Channel 0 is bare soil. Woodland has a litter floor, not a mud floor:
        // at .55 every canopy sample painted the ground more than half mud,
        // which is why a forest read as tan dirt with tufts on it.
        surface[i*4] = Math.max(pathMask, (1 - THREE.MathUtils.smoothstep(shoreDistance, .05, 3.2)) * .97, forestMask * .20, planting.bare * .30);
        surface[i*4+1] = rockMask; surface[i*4+2] = moisture; surface[i*4+3] = forestMask;
        paintGroundVertex(palette, fieldCache, i, grid, seed, vegetation.patchiness, groundTint, colors);
      }
    }
    yield 'terrain';
    // Ground swatches are a LOOK edit (09-14): the grass field's data stage is
    // reused, so its ground channel is refreshed from this plan's own paint —
    // vertex-for-vertex, the pack samples this exact grid — rather than re-packed.
    let plannedGrassField = grassField;
    if (grassField?.ground && grassField.size === resolution + 1 && grassField.ground.length === groundTint.length / 3 * 4) {
      const ground = grassField.ground;
      let changed = false;
      for (let i = 0; i < groundTint.length && !changed; i++) changed = Math.abs(ground[(i / 3 | 0) * 4 + i % 3] - Math.min(8, Math.max(0, groundTint[i]))) > 1e-6;
      if (changed) {
        const next = new Float32Array(ground.length);
        for (let v = 0; v < groundTint.length / 3; v++) {
          for (let c = 0; c < 3; c++) next[v * 4 + c] = Math.min(8, Math.max(0, groundTint[v * 3 + c]));
          next[v * 4 + 3] = 1;
        }
        plannedGrassField = { ...grassField, ground: next };
      }
    }
    const heights = applyWorldTerrainEdits(baseHeights, document.terrainEdits), heightAt = (x, z) => sampleWorldHeight(heights, x, z, grid);
    // The Terrain component now grows this same surface itself (P1-T): it
    // generates its own bare landform from the Procedural props below, and
    // World hands it the reshaping (banks/roads/pads/ridges/escarpments) and
    // this exact `baseHeights` grid through a shape overlay
    // (`WorldComponent#_installTerrainSurface`) instead of a baked `heights`
    // blob — no per-generation base64 encode of a quarter-megapixel grid.
    const materials = createLandscapeMaterials({ style, extent, detailMaps, surfaceScale, surfaceBump }); owned.push(materials);
    yield 'materials';
    const grassSettings = settings.grass;
    const generated = [
      // No `heights`: the Terrain component grows its own bare landform from
      // the Procedural props below; World's own reshaping arrives through a
      // shape overlay, not a baked prop (see `_installTerrainSurface`).
      // `heightEdits` carries any sculpt delta the document already holds, so
      // a freshly-created or reloaded terrain child shows it immediately, and
      // `_captureProvider`'s generic diff (unchanged from any other feature)
      // reapplies it identically after a regeneration.
      { id: 'terrain', kind: 'terrain', props: { size: extent, resolution, splatResolution: 32, castShadow: true,
          procedural: true, proceduralSeed: seed, proceduralExtent: settings.streaming?.enabled ? settings.streaming.extent : extent, proceduralReserve: extent, stoneLayer: false, ...proceduralTerrainProps(settings), ...terrainGroundColorProps(settings.ground),
          heightEdits: terrainEditsToHeightEdits(document.terrainEdits, resolution) }, position: [0,0,0] },
      { id: 'water', kind: 'water', props: {}, position: [0,0,0] },
      { id: 'rocks', kind: 'rocks', props: {}, position: [0,0,0] },
      // The ecology layers are scattered populations with real placements; only
      // the meadow below is a drawn sward. Grass draws by default now, so a
      // layer that means to scatter has to say so.
      ...ecology.groups.map(group => ({ id: `foliage/${group.id}`, kind: 'foliage', props: { ...group.props, placements: group.placements, drawnGrass: false,
        // The accent keeps its gold in both treatments; every other group
        // follows the shared stylized canopy override.
        ...(group.id === 'accent' ? { leafColor: natural ? '#c99a3a' : '#ecc258' }
          : !natural ? { leafColor: ['grass','wildflowers'].includes(group.props.species) ? '#93ad60' : '#75a45b' } : {}) }, position: [0,0,0] })),
      // The sward is an ordinary Foliage population of the grass species. It
      // draws rather than scatters, so it carries no placements — the ground it
      // grows on is handed to the component directly.
      ...(grassSettings.enabled ? [{ id: 'foliage/meadow', kind: 'foliage', position: [0, 0, 0], props: {
        species: 'grass', distribution: 'placements', placements: [], drawnGrass: true,
        blades: grassSettings.blades, grassDensity: grassSettings.density,
        height: grassSettings.height, bladeWidth: grassSettings.width,
        grassLean: grassSettings.lean, maxDistance: grassSettings.distance,
        // Ring 0 — the dense sward underfoot — is always ~5m: the density this
        // close to the camera comes from the ring being small, not from a
        // bigger blade budget, and that stays true whatever the draw distance is.
        lodNear: Math.min(5, grassSettings.distance * .5),
        groundBlend: grassSettings.groundBlend, castShadow: false,
        grassBrightness: grassSettings.brightness, grassOcclusion: grassSettings.occlusion,
        grassVariation: grassSettings.variation, grassSpecular: grassSettings.specular,
        grassRoughness: grassSettings.roughness, grassSky: grassSettings.sky,
        // 09-13: the sward's colours are WORLD controls (`grass.color` / `grass.dryColor`),
        // not two literals a user could never reach ("pale white no matter what colors I choose").
        barkColor: natural ? '#3d5622' : '#4a6b28', leafColor: grassSettings.color || '#7c9448',
        dryColor: grassSettings.dryColor || '#a89b5c',
      } }] : []),
      ...houses,
      ...(settings.sky !== 'off' ? [{ id: 'atmosphere', kind: 'atmosphere', props: { timeOfDay: 14, weather: 'fair', dayLength: 0, precipitation: false, cloudShadows: false }, position: [0,0,0] }] : []),
    ];
    const resolved = resolveFeatureEdits(generated, document.edits);
    const features = resolved.features.map(feature => {
      const override = document.providerOverrides[feature.id];
      const role = feature.id.startsWith('house/') ? 'building' : { terrain:'terrain', water:'water', rocks:'rocks', cottage:'building', atmosphere:'atmosphere' }[feature.id];
      if (feature.kind !== 'foliage' && role !== feature.kind) throw new Error(`Unsupported World feature ${feature.id} (${feature.kind})`);
      if (feature.space === 'attachment') throw new Error(`World attachment evaluation is not implemented for ${feature.id}`);
      const props = { ...feature.props, ...override?.props };
      // A user's architecture model wins outright; otherwise the generated model
      // is re-derived from the merged props so a roof-colour override repaints it.
      if (feature.provider === 'architecture' && !override?.props?.model) {
        props.model = cottageArchitectureModel({ style, seed:props.variation, roofColor:props.roofColor, buildingScale:props.buildingScale });
      }
      return { ...feature, props, ...override?.transform };
    });
    yield 'features';
    // The water texture never needs to be finer than the terrain grid it sits
    // in. `packed`/`shoreCache`/`waterHeights` all came back from
    // `worldPlanDataSteps` above (reused, freshly sampled here, or freshly
    // sampled off-thread in a Worker) — this only interleaves them into the
    // RGBA textures the water material reads, no domain queries of its own.
    const domain = fields.domain, n = Math.min(256, resolution);
    const domainTexture = new THREE.DataTexture(packed, n, n, THREE.RGBAFormat, THREE.FloatType); domainTexture.needsUpdate = true; owned.push(domainTexture);
    const shoreData = new Float32Array(packed.length);
    for (let index = 0; index < n * n; index++) {
      const i = index * 4;
      shoreData[i] = shoreCache[index * 2]; shoreData[i+1] = shoreCache[index * 2 + 1];
      shoreData[i+2] = packed[i+2]; shoreData[i+3] = packed[i+3];
    }
    const shoreTexture = new THREE.DataTexture(shoreData,n,n,THREE.RGBAFormat,THREE.FloatType); shoreTexture.needsUpdate = true; owned.push(shoreTexture);
    const waterSurface = createStudyWaterSurface({ domainTexture, shoreTexture, style, extent, localDomain: true }); owned.push(waterSurface);
    // The water plane is smooth, so it carries a fraction of the terrain's
    // vertices; 513² of them was over a second of domain queries on its own.
    const waterResolution = Math.min(192, resolution);
    const waterGrid = { ...grid, resolution: waterResolution, step: grid.extent / waterResolution, vertices: (waterResolution + 1) ** 2 };
    yield 'water';
    const waterGeo = waterGeometry(waterHeights, waterGrid); owned.push(waterGeo);
    const water = new THREE.Mesh(waterGeo, roleMaterials.water ?? waterSurface.material); water.receiveShadow = true;
    products.set('water', water);
    yield 'water';
    // Stone is the Terrain module's generator (09-14): cliff walls, spires,
    // arches, ledges and talus sited from the landscape's own cliff/tower
    // masks, seated on the composed World heights, kept off water/roads/pads.
    const stone = createTerrainStone({ landscape: fields.shape.landscape, x0: -extent / 2, z0: -extent / 2, size: extent, groundAt: heightAt,
      accept: (x, z) => { const s = fields.sample(x, z); return !!s && s.naturalWeight > .85 && s.path < .05; },
      material: roleMaterials.rock ?? null });
    owned.push(stone); products.set('rocks', stone.group);
    yield 'geology';
    for (const cottageFeature of features.filter(feature => feature.kind === 'building' && feature.provider !== 'architecture')) {
      const cottage = createCottageStudy(THREE, { style, seed: cottageFeature.props.variation, roofColor: cottageFeature.props.roofColor });
      const buildingScale = cottageFeature.props.buildingScale ?? 1;
      if (buildingScale !== 1) cottage.scale.setScalar(buildingScale);
      owned.push({ dispose: () => cottage.userData.dispose() });
      if (roleMaterials.cottage) cottage.traverse(object => { if (object.isMesh) object.material = roleMaterials.cottage; });
      products.set(cottageFeature.id, cottage);
      yield 'buildings';
    }
    published = true;
    return { document, features, generated, orphanEdits: resolved.orphanEdits, layout, fields, domain, ecology, products,
      baseHeights, heights, colors, groundTint, surface, grid, layoutKey, fieldKey, scatterKey, fieldCache, shoreCache, grassField: plannedGrassField,
      packed, waterHeights,
      groundMaterial: roleMaterials.ground ?? materials.groundMaterial, detailMaps, heightAt,
      generationMs: performance.now() - start, update: seconds => waterSurface.update(seconds), dispose };
  } finally {
    // A thrown error or a cancelling `.return()` both land here, so an
    // abandoned pass can never leak the textures and geometry it had built.
    if (!published) dispose();
  }
}

/** Drive the whole generation now: tests, export and the runtime player. */
export function prepareWorldPlan(input, options) {
  const steps = worldPlanSteps(input, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Generate without blocking the frame: run for `budget` milliseconds, hand the
 * frame back, continue. `shouldCancel` is consulted at every safe point, and a
 * cancelled pass disposes everything it had allocated before returning null.
 *
 * `budget` may be a function, called fresh before every slice — the caller
 * (`WorldComponent`) passes `() => frameSliceBudget(engine)` so a slow, GPU-
 * compiling boot frame buys this driver a longer slice instead of the fixed
 * 6 ms sized for a 60 fps frame (see `src/engine/frameSlice.js`).
 *
 * Every named stage this drives (`worldPlanSteps`'s `yield` values: `layout`,
 * `terrain`, `materials`, `planting`, `features`, `water`, `geology`,
 * `buildings`) reports its own wall time and how many real frame-hand-backs
 * it took to the boot ledger as `world: plan <stage>`, and the same summary
 * is handed to `onStage` so `WorldComponent.stats.timeline` can carry it too
 * — see the freeze ledger docs on why an unmarked stage reads as invisible
 * rather than free.
 *
 * When a Worker is available (`typeof Worker !== 'undefined'` — false in
 * Node, so tests/export/the sync `prepareWorldPlan` never take this path) and
 * not forced off (`forceMainThreadPlan`, or the manual
 * `globalThis.__WORLD_PLAN_MAIN_THREAD__` escape hatch), the pure-data half of
 * the plan (`worldPlanDataSteps` — layout/roads, the terrain field, the
 * scatter, the drawn grass field, the water rasters: everything §7.5 found
 * starving at one slice per boot frame) runs off-thread first and finishes in
 * its own CPU time; its result is then handed to `worldPlanSteps` as `reuse`,
 * whose existing cache-key checks take the fast path for every one of those
 * stages, leaving only THREE material/geometry/mesh assembly to slice here.
 * A worker that fails to start, errors, or is cancelled by a newer request
 * falls back to (or resumes as) the ordinary inline sliced generator.
 */
export async function prepareWorldPlanAsync(input, options = {}, { budget = 6, shouldCancel = null, onProgress = null, defer = null, onStage = null, forceMainThreadPlan = false } = {}) {
  const wait = defer ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
  const nextBudget = typeof budget === 'function' ? budget : () => budget;
  let stageName = null, stageStart = performance.now(), stageSlices = 0;
  const closeStage = () => {
    if (stageName == null) return;
    const ms = performance.now() - stageStart;
    freeze.bootMark(`world: plan ${stageName}`, ms, `${stageSlices} slice(s)`);
    onStage?.({ stage: stageName, ms: +ms.toFixed(1), slices: stageSlices });
  };
  const markStage = name => {
    if (name !== stageName) { closeStage(); stageName = name; stageStart = performance.now(); stageSlices = 0; }
    onProgress?.(name);
  };

  let workerResult = null;
  if (!forceMainThreadPlan && !mainThreadPlanForced() && typeof Worker !== 'undefined') {
    workerResult = await runWorldPlanDataInWorker(input, {
      detailMaps: options.detailMaps, reuse: options.reuse, shouldCancel, onProgress: markStage,
    });
    if (workerResult === 'cancelled') { closeStage(); return null; }
  }
  if (shouldCancel?.()) { closeStage(); return null; }

  // The clock only bounds what is left after a successful worker run —
  // materials/geometry/mesh assembly, which rarely needs more than one slice
  // — and bounds the whole thing as before when the worker was not used.
  const clock = { deadline: performance.now() + nextBudget(), due() { return performance.now() >= this.deadline; } };
  const reuse = workerResult ?? options.reuse;
  const steps = worldPlanSteps(input, { ...options, reuse, clock });
  try {
    for (;;) {
      if (shouldCancel?.()) { closeStage(); steps.return(); return null; }
      const step = steps.next();
      if (step.done) { closeStage(); return step.value; }
      markStage(step.value);
      if (!clock.due()) continue;
      stageSlices++;
      await wait();
      clock.deadline = performance.now() + nextBudget();
    }
  } catch (error) { closeStage(); steps.return(); throw error; }
}
