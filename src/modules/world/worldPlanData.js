import * as THREE from 'three/webgpu';
import { createValleyFields } from '../../engine/world/landscapeFields.js';
import { worldLayoutSteps, refitWorldLayoutSteps } from '../../engine/world/worldLayout.js';
import { valleyEcologySteps, sampleValleyPlanting } from '../../engine/world/valleyEcology.js';
import { streamedPopulationIds } from '../../engine/world/landscapeEcology.js';
import { normalizeWorldDocument, applyWorldTerrainEdits, worldGrid } from '../../engine/world/worldDocument.js';
import { WORLD_PARAMETERS, planTerrain } from '../../engine/world/worldConfig.js';
import { resolveFeatureEdits } from '../../engine/world/featureEdits.js';
import { describeCottageStudy } from './worldCottage.js';
import { packGrassField, deriveGrassBaseColor, grassSwardTones } from '../foliage/grassField.js';

/**
 * The pure-CPU half of a World plan: everything `worldPlanSteps` (in
 * `worldPlan.js`) needs that is typed arrays and JSON, never a THREE scene
 * object. `worldPlanSteps` drives this via `yield*` on the main thread
 * exactly as it always has; `prepareWorldPlanAsync` also runs it inside a
 * Worker (`worldPlan.worker.js` imports only this module) so the sampling
 * that dominates a first generation — the terrain field, vegetation scatter,
 * the drawn grass field and the water domain rasters — finishes in its own
 * CPU time instead of one slice per boot frame while shaders compile (see
 * docs/WORLD_PRODUCTION_PLAN.md §7.5).
 *
 * Nothing here imports a canvas, `document` or `window`: `createLandscapeMaterials`
 * (`worldLandscape.js`, which pulls in the canvas-using `worldSurfaceMaps.js`),
 * `createStudyWaterSurface`, `createCottageStudy` and the freeze ledger all stay
 * out of this file's import graph on purpose, so it loads cleanly in a Worker.
 * `three/webgpu` itself is safe here: `worldPlan.js` already imports it and
 * every World test runs under plain `node --test`, with no DOM at all.
 */

/** Never due: a synchronous driver (tests, export, the worker's own drive
 * loop) runs straight through without ever handing back a "frame". */
const ALWAYS_RUN = { due: () => false };

/** Per-vertex stride of the cached field sample: height, shore, rock,
 * moisture, forest, path, waterLevel. `worldPlan.js` reads this same layout
 * to paint the terrain without re-sampling the landscape fields. */
export const FIELD_STRIDE = 7;

/** Stage keys let a live edit reuse work it cannot possibly have changed: a
 * new leaf colour keeps the layout, the fields, the planting and the geology. */
export function worldStageKey(settings, stages) {
  const wanted = new Set(stages);
  return JSON.stringify(WORLD_PARAMETERS.filter(parameter => wanted.has(parameter.stage))
    .map(parameter => parameter.path.split('.').reduce((value, key) => value?.[key], settings)));
}

/** Authored edits change the world as surely as a setting does. Roof colour is
 * the one override that only repaints, so it stays out of the placement key. */
function editKey(document) {
  const placement = document.edits.filter(edit => edit.kind !== 'override' || edit.property !== 'roofColor');
  const transforms = Object.entries(document.providerOverrides)
    .map(([id, override]) => [id, override.transform ?? null]).filter(([, transform]) => transform);
  return JSON.stringify([placement, transforms]);
}

/** A cheap, exact-enough digest of a sparse sculpt: any changed index or delta
 * changes it, so cached heights cannot survive a stroke. */
function sculptKey(edits) {
  if (!edits) return '0';
  let digest = Math.imul(edits.indices.length, 2654435761) >>> 0;
  for (let i = 0; i < edits.indices.length; i++) {
    digest = (Math.imul(digest ^ edits.indices[i], 0x85ebca6b) ^ Math.imul(Math.round(edits.deltas[i] * 4096) | 0, 0xc2b2ae35)) >>> 0;
  }
  return String(digest);
}

/** Bilinear height lookup into a baked/plan grid. Kept for the player/export
 * path (a baked-heightmap fallback) and for `heightAt` closures below. */
export function sampleWorldHeight(heights, x, z, grid = null) {
  const resolution = grid?.resolution ?? Math.round(Math.sqrt(heights.length)) - 1;
  const half = (grid?.extent ?? 128) / 2, stride = resolution + 1, scale = resolution / (half * 2);
  const px = THREE.MathUtils.clamp((x + half) * scale, 0, resolution - 1e-6), pz = THREE.MathUtils.clamp((z + half) * scale, 0, resolution - 1e-6);
  const col = Math.floor(px), row = Math.floor(pz), a = px - col, b = pz - row, i = row * stride + col;
  return a + b <= 1 ? heights[i] * (1 - a - b) + heights[i + 1] * a + heights[i + stride] * b
    : heights[i + stride + 1] * (a + b - 1) + heights[i + 1] * (1 - b) + heights[i + stride] * (1 - a);
}

/** Surface heights for the water plane, sampled from the shared water domain. */
export function* waterSurfaceHeights(domain, grid, clock = ALWAYS_RUN) {
  const stride = grid.resolution + 1, values = new Float32Array(stride * stride);
  const neighbors = [];
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) if (x || z) neighbors.push({ x: x * grid.step / 2, z: z * grid.step / 2, d: x * x + z * z });
  neighbors.sort((a, b) => a.d - b.d || a.z - b.z || a.x - b.x);
  for (let row = 0; row < stride; row++) {
    if (clock.due()) yield 'water';
    for (let column = 0; column < stride; column++) {
      const x = column * grid.step - grid.half, z = row * grid.step - grid.half;
      let sample = domain.sample(x, z);
      if (!sample) for (const offset of neighbors) { sample = domain.sample(x + offset.x, z + offset.z); if (sample) break; }
      values[row * stride + column] = (sample?.height ?? 0) + .025;
    }
  }
  return values;
}

/**
 * The reusable half of the ground palette: the five named colours and the
 * detail-map role averages, built once per generation rather than once per
 * vertex. `paintGroundVertex` below is the actual per-vertex blend, shared by
 * the terrain colour loop (`worldPlan.js`'s `worldPlanSteps`) and the grass
 * field bake here — a blade's root must be the colour of the ground it grows
 * out of, never a second palette independently derived from this one.
 */
export function makeGroundPalette({ style, detailMaps, grassSettings, groundSettings = null }) {
  const natural = style === 'natural';
  const swardEnabled = !!grassSettings?.enabled;
  // 09-14: the tones the renderer really draws (tip/dry clamps), not the raw swatches.
  const tones = swardEnabled ? grassSwardTones(grassSettings.color, grassSettings.dryColor) : null;
  return {
    natural,
    // 09-13: the role colours come from the World's Ground group (`ground.meadow/soil/rock`);
    // forest floor and river bed are derived darker from meadow and soil so one swatch each
    // moves a whole family of ground. The old style literals remain the fallbacks.
    grass: new THREE.Color(groundSettings?.meadow || (natural ? '#85855a' : '#94ae67')),
    shore: new THREE.Color(groundSettings?.soil || (natural ? '#8f8066' : '#b4a47f')),
    forest: groundSettings?.meadow ? new THREE.Color(groundSettings.meadow).multiplyScalar(.78) : new THREE.Color(natural ? '#646448' : '#6e874b'),
    bed: groundSettings?.soil ? new THREE.Color(groundSettings.soil).multiplyScalar(.76) : new THREE.Color(natural ? '#686353' : '#89856b'),
    rock: new THREE.Color(groundSettings?.rock || '#858177'), color: new THREE.Color(),
    meadowChroma: (() => { const c = new THREE.Color(groundSettings?.meadow || (natural ? '#85855a' : '#94ae67')); const l = Math.max(.05, c.r * .3 + c.g * .59 + c.b * .11); return c.multiplyScalar(1 / l).lerp(new THREE.Color(1, 1, 1), .35); })(),
    average: detailMaps ? ['grass', 'soil', 'rock'].map(role => detailMaps[role]?.average ?? [.1, .1, .08]) : null,
    // ⛔ 09-14 OWNER: "green colour for grass in terrain looks dark brown". The
    // ground under a sward used to converge onto the sward's own mean colour, so
    // an olive meadow leaf dragged a picked green to brown. The terrain colour is
    // the authority now; blades converge onto IT before their draw distance
    // (`grassMaterial.js` `farGround`). `__swardTintsGround = true` restores the pull.
    swardDensity: swardEnabled && globalThis.__swardTintsGround === true ? grassSettings.density : 0,
    // The blade's OWN root colour — `deriveGrassBaseColor` applied to the
    // exact leaf/dry TIP tones `worldPlan.js` hands the meadow feature
    // (`leafColor`/`dryColor` there), kept byte-identical here on purpose, so
    // the ground under a sward and the blade root it grows out of are never
    // two independently-tuned greens (`grassRenderer.js` derives the same
    // uniform the same way from the same tip colour).
    swardBase: tones ? tones.base : null,
    // The un-derived TIP tone `swardBase` above was itself derived from —
    // kept alongside it so the ground can blend to the sward's MEAN visible
    // colour (root and tip together), not the root alone. Byte-identical to
    // the tip colour `worldPlan.js` hands the meadow feature.
    swardTip: tones ? tones.tip : null,
    swardDry: tones ? tones.dry : null,
    swardRoot: new THREE.Color(), swardTipTone: new THREE.Color(), swardMean: new THREE.Color(), swardTint: new THREE.Color(),
  };
}

/** The sward's colours as they are actually drawn: the meadow Foliage's own
 * leaf/dry/density override (a user tuning the population directly) wins over
 * the World's `grass` table value (09-14). */
export function effectiveSwardSettings(grass = {}, meadow = null) {
  if (!meadow) return grass;
  return { ...grass, ...(meadow.leafColor ? { color: meadow.leafColor } : {}), ...(meadow.dryColor ? { dryColor: meadow.dryColor } : {}),
    ...(Number.isFinite(meadow.grassDensity) ? { density: meadow.grassDensity } : {}) };
}

/** A sward's mean visible colour at `dryness`: ≈0.4 root + 0.6 tip, × the 0.9
 * depth-shade mean — the target `paintGroundVertex` converges ground onto. */
export function swardMeanColor(grass = {}, dryness = 0) {
  const { tip, base, dry } = grassSwardTones(grass.color, grass.dryColor);
  const root = base.lerp(dry, dryness * .5);
  return root.lerp(tip.lerp(dry, dryness * .5), .6).multiplyScalar(.9);
}

/** What streamed tiles, their rocks and the grass window paint with (09-14):
 * the World's Ground swatches over the style palette, used AS PICKED. ⛔ The
 * first cut pulled the grass role onto the sward's mean colour; with an olive
 * meadow leaf (#585a07) that turned a picked #9bbd28 into #3f4212 — "green
 * looks dark brown". The terrain colour is the authority; the grass converges
 * onto it before its draw distance (`grassMaterial.js` `farGround`). */
export function worldStreamPalette(base = {}, settings = {}) {
  const ground = settings.ground ?? {}, out = { ...base };
  if (ground.meadow) out.grass = ground.meadow;
  if (ground.soil) out.soil = ground.soil;
  if (ground.rock) out.rock = ground.rock;
  return out;
}

/** A World's Terrain shows the World's Ground swatches as its own colours. */
export function terrainGroundColorProps(ground = {}) {
  return { customColors: true, grassColor: ground?.meadow || '#6f7a4a', soilColor: ground?.soil || '#8f8066', rockColor: ground?.rock || '#858177' };
}

/**
 * Paint one vertex of `groundTint` (always) and `colors` (when supplied) from
 * a cached field sample. Identical to the palette maths `worldPlanSteps` used
 * to run inline; factored out so the grass field bake below and the terrain
 * vertex-colour loop can never independently drift from each other.
 */
export function paintGroundVertex(palette, fieldCache, vertex, grid, seed, patchiness, groundTint, colors = null) {
  const f = vertex * FIELD_STRIDE;
  const shoreDistance = fieldCache[f + 1], rockMask = fieldCache[f + 2], moisture = fieldCache[f + 3], forestMask = fieldCache[f + 4], pathMask = fieldCache[f + 5];
  const stride = grid.resolution + 1, column = vertex % stride, row = Math.floor(vertex / stride);
  const x = column * grid.step - grid.half, z = row * grid.step - grid.half;
  const planting = sampleValleyPlanting(seed, x, z, patchiness);
  const { grass, shore, forest, bed, rock, color, average, swardDensity, swardBase, swardTip, swardDry, swardRoot, swardTipTone, swardMean, swardTint, meadowChroma } = palette;
  color.copy(grass).lerp(forest, forestMask * .7).lerp(shore, (1 - THREE.MathUtils.smoothstep(shoreDistance, .1, 2.8)) * .85);
  color.lerp(rock, rockMask * .85).lerp(shore, pathMask * .92);
  if (shoreDistance < 0) color.copy(bed).lerp(shore, .25 + .12 * Math.sin(x * 1.7 + z));
  const grain = .94 + Math.sin(x * .6 + z * .13) * Math.sin(z * .7) * .06;
  color.multiplyScalar(grain);
  if (average) {
    const soil = Math.max(pathMask, (1 - THREE.MathUtils.smoothstep(shoreDistance, .05, 3.2)) * .97, forestMask * .20, planting.bare * .30);
    const soilWeight = THREE.MathUtils.smoothstep(soil, .05, .95);
    const stoneWeight = THREE.MathUtils.smoothstep(rockMask, .10, .85);
    const wet = 1 - THREE.MathUtils.smoothstep(moisture, .60, .98) * .38;
    for (let channel = 0; channel < 3; channel++) {
      const ground = average[0][channel] + (average[1][channel] - average[0][channel]) * soilWeight;
      groundTint[vertex * 3 + channel] = (ground + (average[2][channel] - ground) * stoneWeight) * wet;
    }
    // With detail maps the vertex colour is a tint over the photo texture: the meadow
    // swatch's chroma (softened toward white) where the ground is neither soil nor stone.
    color.setRGB(1, 1, 1).lerp(meadowChroma, (1 - soilWeight) * (1 - stoneWeight) * .6).multiplyScalar((1 - forestMask * .10) * grain);
  } else color.toArray(groundTint, vertex * 3);
  if (swardDensity > 0) {
    // The same terms the packed grass field itself is sampled from (dry
    // ground, unpaved, unshaded, unstony) — not a second, independently
    // tuned density, so "where the sward covers" agrees between the two.
    const dryFade = THREE.MathUtils.smoothstep(shoreDistance, grid.step * 1.5 + .25, grid.step * 1.5 + 2.65);
    const density = swardDensity * dryFade * (1 - pathMask) * (1 - rockMask) * (1 - forestMask * .3);
    // ⛔ A REAL COLOUR BLEND, NOT A UNIFORM DARKEN. The old step multiplied
    // whatever the ground already was by a flat scalar, so a sward standing
    // on soil still read as darkened soil — visibly a different colour from
    // the blades themselves past the distance a viewer stops seeing the two
    // meet. Below the sward's own visibility floor the ground still reads as
    // itself; above it, it converges on the blade's own MEAN VISIBLE colour —
    // met from the other side by the blade's own far-field convergence to
    // this same ground tone (`grassMaterial.js`'s `groundTone`) — so the
    // carpet's edge is a colour match, not a shadow ring around a still-brown
    // floor. ⛔ 09-13 OWNER RECEIPT: "does not blend with terrain well" — the
    // ground used to converge on the blade's ROOT alone, which is always the
    // darkest, greenest part of a blade a viewer never actually sees in
    // isolation; a sward reads as a MIX of its root and tip, so the ground
    // has to target that mix, not one end of it.
    const weight = THREE.MathUtils.smoothstep(density, .2, .55);
    if (weight > 0) {
      // Leaf/dry mix, at the same moisture the packed field itself reads.
      // `swardBase` is already the blade's own derived, darkened root tone
      // (`deriveGrassBaseColor`) — has to arrive at exactly that value, not a
      // second, independently darkened copy of it. `swardTip` gets the same
      // dryness blend the shader gives the tip end of a real blade.
      const drynessWeight = Math.max(0, Math.min(1, 1 - moisture * 1.5));
      swardRoot.copy(swardBase).lerp(swardDry, drynessWeight * .5);
      swardTipTone.copy(swardTip).lerp(swardDry, drynessWeight * .5);
      // The sward's own MEAN VISIBLE colour: ≈0.4 root + 0.6 tip (a blade
      // shows more tip than root to a viewer), then the same depth-darkening
      // mean (`grassMaterial.js`'s `depthShade`, .6..1) averages to — a
      // viewer never sees a sward at its brightest single-blade tip colour.
      // ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: overhead/three-quarter shots still
      // showed the ground under a gap reading near-black next to the sward —
      // 0.8 → 0.9 of the sward's own tip-weighted mean, so a bare patch under
      // cover reads only ~15% darker than the blades themselves, not a
      // near-black hole.
      swardMean.copy(swardRoot).lerp(swardTipTone, .6).multiplyScalar(.9);
      if (average) {
        // The terrain's own vertex colour here is a near-white MULTIPLIER
        // onto the surface maps' own textures (`applyGroundSurfaceMaps`), so
        // the bias has to be a TINT normalised to the same brightness —
        // otherwise it would flatten the soil texture's own detail to a flat
        // colour instead of biasing it toward the sward's hue.
        const luma = Math.max(.05, swardMean.r * .3 + swardMean.g * .59 + swardMean.b * .11);
        // ⛔ 09-13 "the terrain itself is saturated green": normalising the sward mean to
        // luma 1 made a PURE chroma — the most saturated green the palette can express —
        // and the vertex took 85 % of it. Soften toward white and take less of it.
        swardTint.copy(swardMean).multiplyScalar(1 / luma).lerp(new THREE.Color(1, 1, 1), .4);
        color.lerp(swardTint, weight * .6);
      } else {
        color.lerp(swardMean, weight);
      }
      for (let channel = 0; channel < 3; channel++) {
        const swardComponent = channel === 0 ? swardMean.r : channel === 1 ? swardMean.g : swardMean.b;
        groundTint[vertex * 3 + channel] = groundTint[vertex * 3 + channel] * (1 - weight) + swardComponent * weight;
      }
    }
  }
  if (colors) color.toArray(colors, vertex * 3);
}

/**
 * Resumable pure-data generation: layout (siting, roads, authored refit),
 * the sampled field cache, vegetation scatter, the drawn grass field and the
 * water domain rasters. Returns exactly the fields `worldPlanSteps` reads off
 * a `reuse` plan (`layoutKey`, `layout`, `fieldKey`, `fieldCache`,
 * `scatterKey`, `ecology`, `grassField`, `packed`, `shoreCache`,
 * `waterHeights`) — a fresh call is therefore usable as `reuse` for a later
 * one, and the Worker's result is usable exactly the same way.
 *
 * `document` must already be `normalizeWorldDocument`-clean (the worker
 * normalizes the raw document it is posted; `worldPlanSteps` already has one).
 */
export function* worldPlanDataSteps(document, { detailMaps = null, reuse = null, clock = ALWAYS_RUN } = {}) {
  const settings = document.settings;
  const { seed, style, geography, water: waterConfig, settlement, vegetation, forestDensity, groundDensity } = settings;
  const terrain = planTerrain(settings);
  const grid = worldGrid(settings), { extent, resolution } = grid;
  const layoutKey = worldStageKey(settings, ['layout']) + editKey(document);
  const fieldKey = layoutKey + worldStageKey(settings, ['field']) + sculptKey(document.terrainEdits);
  const scatterKey = fieldKey + worldStageKey(settings, ['scatter']);

  // ---- layout: siting, roads, and refitting around any authored move ----
  const footprint = variation => describeCottageStudy({ style, seed: (variation + settings.cottageVariation) >>> 0 }).footprint;
  const keptLayout = reuse?.layoutKey === layoutKey ? reuse.layout : undefined;
  let layout = keptLayout !== undefined ? (keptLayout && structuredClone(keptLayout))
    : settings.layout.mode === 'procedural' ? yield* worldLayoutSteps({ ...settings.layout, seed, extent,
      geography, terrain, water: waterConfig, settlement, buildings: settings.buildings, footprint, clock }) : null;
  yield 'layout';
  const sites = layout ? layout.buildings : settings.buildings ? [{ id: 'cottage', position: [22, 2.2, 6], rotation: [0, 0, 0], variationSeed: 0 }] : [];
  if (layout) {
    // Only placement matters here: this throwaway `houses` list exists solely
    // to detect whether an authored edit moved a building off the generator's
    // own siting, so the layout (and the terrain it shapes) can be refit
    // around it. `layout` itself may be reassigned to the refit result below;
    // `sites` (returned as-is) deliberately is not — `worldPlanSteps` builds
    // the real, fully-described feature list from these ORIGINAL (un-refit)
    // positions, exactly as before this was split out of it: the authored
    // edit is re-applied on top of them by the ordinary feature-edit pipeline
    // either way, but the World component also compares a feature's live
    // pose against this "generated" pose to know whether an authored
    // override is still active, and that comparison needs the generator's
    // own siting, never a pose already folded onto the authored one.
    const houses = sites.map(site => ({ id: site.id, kind: 'building', position: site.position, rotation: site.rotation, props: {} }));
    const effective = resolveFeatureEdits(houses, document.edits).features.filter(feature => feature.kind === 'building')
      .map(feature => ({ ...feature, ...document.providerOverrides[feature.id]?.transform }));
    const changed = effective.length !== houses.length || effective.some((feature, i) => feature.id !== houses[i]?.id ||
      JSON.stringify([feature.position, feature.rotation, feature.scale ?? [1, 1, 1]]) !== JSON.stringify([houses[i]?.position, houses[i]?.rotation, [1, 1, 1]]));
    if (changed) {
      layout = { ...layout, buildings: effective.map(feature => {
        const site = sites.find(site => site.id === feature.id), scale = feature.scale ?? [1, 1, 1];
        return { ...site, id: feature.id, position: feature.position, rotation: feature.rotation ?? [0, 0, 0],
          halfWidth: Math.max(.1, (site?.halfWidth ?? 7) * Math.abs(scale[0])), halfDepth: Math.max(.1, (site?.halfDepth ?? 8) * Math.abs(scale[2])), feather: site?.feather ?? 3 };
      }) };
      layout = yield* refitWorldLayoutSteps(layout, { geography, terrain, water: waterConfig, settlement, clock });
    }
  }
  yield 'layout';

  // ---- the sampled terrain/water field, cached per vertex ----
  const fields = createValleyFields({ ...geography, terrain, water: waterConfig, seed, extent, terrainStep: grid.step,
    pathWidth: settlement.laneWidth, ...(layout ? { layout } : {}) });
  const vertices = grid.vertices;
  const cachedField = reuse?.fieldKey === fieldKey && reuse.fieldCache?.length === vertices * FIELD_STRIDE ? reuse.fieldCache : null;
  const fieldCache = cachedField ?? new Float32Array(vertices * FIELD_STRIDE);
  const point = {};
  // Erosion is part of the landscape itself (landscapeGenerator.js macro pass, 09-14).
  if (!cachedField) {
    for (let r = 0; r <= resolution; r++) {
      if (clock.due()) yield 'terrain';
      for (let c = 0; c <= resolution; c++) {
        const x = c * grid.step - grid.half, z = r * grid.step - grid.half, i = r * (resolution + 1) + c, f = i * FIELD_STRIDE;
        const sample = fields.sample(x, z, point);
        fieldCache[f] = sample.height; fieldCache[f + 1] = sample.shore; fieldCache[f + 2] = sample.rock;
        fieldCache[f + 3] = sample.moisture; fieldCache[f + 4] = sample.forest; fieldCache[f + 5] = sample.path;
        fieldCache[f + 6] = sample.waterLevel;
      }
    }
  }
  yield 'terrain';

  const baseHeights = new Float32Array(vertices);
  for (let i = 0; i < vertices; i++) baseHeights[i] = fieldCache[i * FIELD_STRIDE];
  const heights = applyWorldTerrainEdits(baseHeights, document.terrainEdits);
  const heightAt = (x, z) => sampleWorldHeight(heights, x, z, grid);

  // ---- vegetation scatter ----
  const ecology = reuse?.scatterKey === scatterKey && reuse.ecology
    ? reuse.ecology : yield* valleyEcologySteps(fields, { seed, forestDensity, groundDensity, heightAt, vegetation, clock, drawnGrass: settings.grass.enabled,
      // A streamed World feeds its surroundings' plants into these populations,
      // so they must exist even where the valley itself grew none.
      keepEmpty: settings.streaming?.enabled ? streamedPopulationIds({ drawnGrass: settings.grass.enabled }) : null });
  yield 'planting'; yield 'planting';

  // ---- the drawn grass field ----
  const grassSettings = settings.grass;
  let grassField = null;
  if (grassSettings.enabled) {
    if (reuse?.fieldKey === fieldKey && reuse.grassField) grassField = reuse.grassField;
    else {
      // Needs the same ground palette the terrain colour loop paints, so a
      // blade's root matches the ground it grows out of: see `paintGroundVertex`.
      const palette = makeGroundPalette({ style, detailMaps, grassSettings, groundSettings: settings.ground });
      const groundTint = new Float32Array(vertices * 3);
      for (let i = 0; i < vertices; i++) paintGroundVertex(palette, fieldCache, i, grid, seed, vegetation.patchiness, groundTint, null);
      grassField = packGrassField((x, z) => {
        const column = Math.min(resolution, Math.max(0, Math.round((x + grid.half) / grid.step)));
        const row = Math.min(resolution, Math.max(0, Math.round((z + grid.half) / grid.step)));
        const vertex = row * (resolution + 1) + column, f = vertex * FIELD_STRIDE;
        const shore = fieldCache[f + 1], rock = fieldCache[f + 2], moisture = fieldCache[f + 3];
        const forest = fieldCache[f + 4], path = fieldCache[f + 5];
        // ⛔ NO GRASS IN THE WATER, AND NONE WITHIN A TEXEL OF IT — see
        // `worldPlan.js`'s history for why this margin/freeboard shape exists;
        // kept byte-identical here on purpose.
        const margin = grid.step * 1.5 + .25;
        let freeboard = Infinity;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const nc = Math.min(resolution, Math.max(0, column + dc));
          const nr = Math.min(resolution, Math.max(0, row + dr));
          const n = nr * (resolution + 1) + nc;
          freeboard = Math.min(freeboard, heights[n] - fieldCache[n * FIELD_STRIDE + 6]);
        }
        // ⛔ 09-14 owner receipt: "large green ground regions where grass does not
        // grow at all". `waterLevel` on dry land is the NEAREST body's level, so on
        // the flatter 09-14 landscape whole meadows tens of metres from any shore sat
        // below a lake's surface and the freeboard gate cut them: 54 % of the valley's
        // dry land was bare, 90 % of it by this term. The gate exists for the strip
        // beside the water (a texel over a submerged vertex); it fades out by 6 m past it.
        const nearWater = 1 - THREE.MathUtils.smoothstep(shore, margin + 2.4, margin + 6);
        const dry = Math.min(THREE.MathUtils.smoothstep(shore, margin, margin + 2.4),
          1 - nearWater * (1 - THREE.MathUtils.smoothstep(freeboard, .12, .85)));
        return {
          height: heights[vertex],
          density: dry * (1 - path) * (1 - rock) * (1 - forest * .3) * (.6 + moisture * .45),
          scale: .72 + moisture * .62,
          dryness: Math.max(0, 1 - moisture * 1.5),
          color: [groundTint[vertex * 3], groundTint[vertex * 3 + 1], groundTint[vertex * 3 + 2]],
        };
      }, { extent, resolution: resolution + 1, origin: [0, 0] });
    }
  }
  yield 'planting';

  // ---- water domain rasters: the packed field texture and the shore/depth field ----
  const domain = fields.domain, n = Math.min(256, resolution);
  const packed = reuse?.fieldKey === fieldKey && reuse.packed?.length === n * n * 4 ? reuse.packed
    : domain.rasterize({ minX: -grid.half, minZ: -grid.half, maxX: grid.half, maxZ: grid.half, width: n, height: n });
  const shoreCached = reuse?.fieldKey === fieldKey && reuse.shoreCache?.length === n * n * 2 ? reuse.shoreCache : null;
  const shoreCache = shoreCached ?? new Float32Array(n * n * 2);
  if (!shoreCached) {
    for (let r = 0; r < n; r++) {
      if (clock.due()) yield 'water';
      for (let c = 0; c < n; c++) {
        const index = r * n + c;
        const x = (c + .5) / n * extent - grid.half, z = (r + .5) / n * extent - grid.half;
        const sample = fields.sample(x, z, point);
        shoreCache[index * 2] = sample.shore; shoreCache[index * 2 + 1] = Math.max(0, sample.waterLevel - heightAt(x, z));
      }
    }
  }
  yield 'water';

  const waterResolution = Math.min(192, resolution);
  const waterGrid = { ...grid, resolution: waterResolution, step: grid.extent / waterResolution, vertices: (waterResolution + 1) ** 2 };
  const waterHeights = reuse?.fieldKey === fieldKey && reuse.waterHeights?.length === waterGrid.vertices
    ? reuse.waterHeights : yield* waterSurfaceHeights(domain, waterGrid, clock);

  return { layoutKey, layout, sites, fieldKey, fieldCache, scatterKey, ecology, grassField, packed, shoreCache, waterHeights };
}

/** Drive the data steps to completion now (Node/tests/a Worker's own drive
 * loop): no slicing, no cancellation, just the finished pure-data result. */
export function prepareWorldPlanData(input, options) {
  const document = normalizeWorldDocument(input);
  const steps = worldPlanDataSteps(document, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
