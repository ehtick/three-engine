/**
 * One declarative description of every World parameter.
 *
 * Defaults, validation ranges, inspector grouping and automation metadata all
 * come from this table, so a new control cannot exist in the generator without
 * also being configurable, serializable and reachable from the editor API.
 *
 * `path` is the storage location inside the World document's settings. Legacy
 * groups (`geography`, `layout`, `vegetation`) keep their original paths so old
 * scenes normalize unchanged; `group` is the authoring category the inspector
 * renders, which is deliberately independent of that storage history.
 *
 * `stage` declares what a change invalidates:
 *   layout  – siting: water courses, landform features, settlements, routes
 *   field   – the continuous height/mask fields sampled by every provider
 *   scatter – vegetation population only
 *   look    – appearance only; no placement or elevation changes
 */

import { PROCEDURAL_TERRAIN_PARAMS } from '../terrain/proceduralTerrain.js';

const P = (path, group, label, spec) => ({ path, group, label, ...spec });
const num = (min, max, step = .05, hint) => ({ kind: 'number', min, max, step, hint });
const int = (min, max, hint) => ({ kind: 'integer', min, max, step: 1, hint });
const pick = (choices, hint) => ({ kind: 'enum', choices, hint });
const color = (hint) => ({ kind: 'color', hint });

/** Terrain grids stay square and bounded; larger worlds use coarser cells. */
export const WORLD_EXTENTS = Object.freeze([128, 192, 256, 384, 512]);
export const worldResolution = extent => extent <= 192 ? 256 : extent <= 320 ? 320 : 384;
export const worldTerrainStep = extent => extent / worldResolution(extent);
export const STREAMING_EXTENTS = Object.freeze([1024, 2048, 4096, 8192]);

/** The terrain settings a plan builds from: with streaming on, the central
 * region is cut from a landscape as large as the streamed land, so the
 * streamed tiles around it are the same ground. */
export function planTerrain(settings) {
  return settings?.streaming?.enabled ? { ...settings.terrain, landscapeExtent: settings.streaming.extent } : settings.terrain;
}

export const WORLD_PARAMETERS = Object.freeze([
  // ---- World ----------------------------------------------------------------
  P('extent', 'World', 'World size (m)', { ...pick(WORLD_EXTENTS, 'Square extent in metres. Larger worlds use coarser terrain cells.'), default: 128, stage: 'layout' }),
  P('seed', 'World', 'Seed', { ...int(0, 0xffffffff, 'Chooses every procedural decision. Artistic edits survive a new seed.'), default: 894, stage: 'layout' }),

  // ---- Terrain ----------------------------------------------------------
  // Derived from `PROCEDURAL_TERRAIN_PARAMS` (P1-T) — that table is now the
  // ONE definition of these 12 controls; the Terrain component's own schema
  // generates its "Procedural" rows from the exact same array, under its own
  // (bare, dotless) prop keys. Every key/range/step/default/hint here must
  // stay byte-identical to what that table declares (`tests/world-settlements
  // .test.mjs` walks this array for round-trippability).
  ...PROCEDURAL_TERRAIN_PARAMS.map(param => P(param.worldPath, 'Terrain', param.label, {
    kind: param.kind, min: param.min, max: param.max, step: param.step, choices: param.choices,
    // 'layout': the landform decides where water, settlements and roads go.
    // A World hosts water, roads and settlements: it opens on gentle rolling hills,
    // not the Terrain component's showcase highlands. Height .7: at full height a
    // 128 m hills plot left room for 2 of 12 cluster houses; at .7 it seats 7.
    hint: param.hint, default: ({ style: 'hills', height: .7 })[param.key] ?? param.default, stage: 'layout',
  })),

  // ---- Water ----------------------------------------------------------------
  P('layout.lakeCount', 'Water', 'Lakes', { ...int(1, 8, 'Maximum basins. Siting can place fewer.'), default: 2, stage: 'layout' }),
  P('water.lakeSize', 'Water', 'Lake size', { ...num(.25, 3, .05, 'Scale of every generated basin.'), default: 1, stage: 'layout' }),
  P('water.lakeDepth', 'Water', 'Lake depth (m)', { ...num(.5, 12, .1, 'Depth of the main basin below its surface.'), default: 2, stage: 'field' }),
  P('water.riverCount', 'Water', 'Rivers', { ...int(0, 4, 'Independent main watercourses draining into the basins.'), default: 1, stage: 'layout' }),
  P('water.tributaries', 'Water', 'Tributaries', { ...int(0, 6, 'Side streams joining each main river.'), default: 1, stage: 'layout' }),
  P('layout.riverMeander', 'Water', 'Meandering', { ...num(0, 1, .05, 'Lateral wandering of the river route.'), default: .65, stage: 'layout' }),
  P('geography.riverWidth', 'Water', 'River width (m)', { ...num(2, 24, .1, 'Surface width of the main channel.'), default: 5, stage: 'layout' }),
  P('water.riverDepth', 'Water', 'River depth (m)', { ...num(.4, 6, .1, 'Channel depth below the water surface.'), default: 1.2, stage: 'field' }),
  P('water.riverFall', 'Water', 'River fall (m)', { ...num(0, 40, .25, 'Elevation the river descends from its source to its mouth.'), default: 3, stage: 'layout' }),

  // ---- Banks ----------------------------------------------------------------
  P('geography.shoreWidth', 'Banks', 'Shore softness', { ...num(.4, 3, .05, 'Master scale for the whole bank profile.'), default: 1, stage: 'field' }),
  P('water.bedSlope', 'Banks', 'Bed slope', { ...num(.05, 1.5, .01, 'Underwater gradient from the shoreline down to the bed.'), default: .3, stage: 'field' }),
  P('water.beachWidth', 'Banks', 'Beach width (m)', { ...num(0, 20, .1, 'Width of the near-flat alluvial bench above the waterline.'), default: 1.8, stage: 'field' }),
  P('water.beachGrade', 'Banks', 'Beach grade', { ...num(0, .5, .005, 'Gradient of that bench. Higher values remove the flat shore.'), default: .055, stage: 'field' }),
  P('water.bench', 'Banks', 'Flood terrace', { ...num(0, 1, .05, 'Strength of a second, wider floodplain step behind the beach.'), default: 0, stage: 'field' }),
  P('water.shoulderStart', 'Banks', 'Shoulder start (m)', { ...num(0, 30, .1, 'Distance from the water where the bank starts climbing to the hills.'), default: 3.8, stage: 'field' }),
  P('water.shoulderGrade', 'Banks', 'Shoulder grade', { ...num(.05, 2, .01, 'Steepness of that climb. High values make gorges and cut banks.'), default: .35, stage: 'field' }),
  P('water.shoulderLength', 'Banks', 'Shoulder length (m)', { ...num(1, 40, .5, 'Distance over which the shoulder eases into the surrounding land.'), default: 5.5, stage: 'field' }),
  P('water.bankRoughness', 'Banks', 'Bank roughness', { ...num(0, 3, .05, 'Irregularity of the bank line and its profile.'), default: 1, stage: 'field' }),

  // ---- Settlements ----------------------------------------------------------
  P('settlement.count', 'Settlements', 'Settlements', { ...int(0, 6, 'How many separate places the seed tries to found.'), default: 1, stage: 'layout' }),
  P('settlement.pattern', 'Settlements', 'Town plan', { ...pick(['scattered', 'cluster', 'street', 'grid'], 'The road and plot grammar each settlement is built from.'), default: 'cluster', stage: 'layout' }),
  P('layout.houseCount', 'Settlements', 'Max buildings', { ...int(0, 160, 'Total building budget across all settlements. Siting can use fewer.'), default: 5, stage: 'layout' }),
  P('layout.settlementSpread', 'Settlements', 'Spread', { ...num(0, 1, .05, 'Tight around the centre at 0; loosely dispersed at 1.'), default: .65, stage: 'layout' }),
  P('settlement.waterAffinity', 'Settlements', 'Water affinity', { ...num(0, 1, .05, 'How strongly settlements are drawn to the shore.'), default: .5, stage: 'layout' }),
  P('settlement.plotFrontage', 'Settlements', 'Plot frontage (m)', { ...num(8, 60, .5, 'Spacing of buildings along their street.'), default: 22, stage: 'layout' }),
  P('settlement.plotDepth', 'Settlements', 'Plot depth (m)', { ...num(8, 60, .5, 'Depth of a plot back from its street.'), default: 20, stage: 'layout' }),
  P('settlement.setback', 'Settlements', 'Setback (m)', { ...num(0, 20, .25, 'Distance from the street edge to the building face.'), default: 4.5, stage: 'layout' }),
  P('settlement.orientationJitter', 'Settlements', 'Orientation jitter', { ...num(0, 1, .05, 'Facing every building squarely to its street at 0; casual angles at 1.'), default: .25, stage: 'layout' }),
  P('settlement.roadWidth', 'Settlements', 'Main road width (m)', { ...num(2, 14, .1, 'Width of the street through a settlement.'), default: 4, stage: 'layout' }),
  P('settlement.laneWidth', 'Settlements', 'Lane width (m)', { ...num(.6, 8, .1, 'Width of the connecting footpaths between places.'), default: 2.2, stage: 'layout' }),
  P('settlement.maxGrade', 'Settlements', 'Max road grade', { ...num(.08, 1, .01, 'Steepest slope a road may climb before rerouting.'), default: .35, stage: 'layout' }),
  P('settlement.outbuildings', 'Settlements', 'Outbuildings', { ...num(0, 1, .05, 'Share of barns, sheds and stores among the buildings.'), default: .3, stage: 'layout' }),
  P('settlement.landmark', 'Settlements', 'Landmark', { kind: 'boolean', default: true, stage: 'layout', hint: 'Place a larger hall at the centre of a settlement big enough for one.' }),
  P('settlement.buildingScale', 'Settlements', 'Building size', { ...num(.5, 2.5, .05, 'Scale of the generated building footprints.'), default: 1, stage: 'layout' }),
  P('settlement.editableBuildings', 'Settlements', 'Editable buildings', { kind: 'boolean', default: true, stage: 'layout', hint: 'Generate houses as editable architecture models; off bakes the legacy decorative cottages.' }),
  P('buildings', 'Settlements', 'Include buildings', { kind: 'boolean', default: true, stage: 'layout', hint: 'Generate the settlement, or leave the landscape empty.' }),
  P('cottageVariation', 'Settlements', 'Building variation', { ...int(0, 0xffffffff, 'Rerolls building families and detail without moving anything.'), default: 8, stage: 'layout' }),

  // ---- Grass ----------------------------------------------------------------
  // 09-13 owner: "the colors of the terrain itself … saturated green, and there is no way to change it".
  // The ground palette was five literals in worldPlanData.js. These three swatches drive it: the meadow
  // role colour (also the chroma the ground takes under a drawn sward), the soil/shore/path colour, and rock.
  // 09-14 owner: "why do we reload the whole world when I change the colour of terrain" — these
  // were 'field', which re-sampled the terrain field and re-scattered every population. A colour
  // is a repaint: 'look' reuses every data stage (the grass ground channel refreshes in worldPlan.js).
  P('ground.meadow', 'Ground', 'Meadow ground', { ...color('Colour of open grassy ground and the tint the terrain takes under the drawn sward. Forest floor is derived darker from it.'), default: '#6f7a4a', stage: 'look' }),
  P('ground.soil', 'Ground', 'Soil', { ...color('Bare earth: shores, paths and worn ground. River beds are derived darker from it.'), default: '#8f8066', stage: 'look' }),
  P('ground.rock', 'Ground', 'Rock', { ...color('Exposed rock on steep and rocky ground.'), default: '#858177', stage: 'look' }),
  P('grass.enabled', 'Grass', 'Drawn grass', { kind: 'boolean', default: true, stage: 'scatter', hint: 'A continuous sward drawn in the shader rather than scattered clumps. Scattered ground plants thin out when it is on.' }),
  P('grass.blades', 'Grass', 'Blade budget', { ...int(0, 2400000, 'Blades drawn across the whole field. This is the cost, and it is linear.'), default: 480000, stage: 'scatter' }),
  P('grass.density', 'Grass', 'Coverage', { ...num(0, 1, .02, 'Share of the budget that survives where the ground allows grass at all.'), default: .85, stage: 'scatter' }),
  P('grass.height', 'Grass', 'Blade height (m)', { ...num(.1, .28, .01, 'Height of a blade on ground of average moisture.'), default: .18, stage: 'scatter' }),
  P('grass.width', 'Grass', 'Blade width (m)', { ...num(.012, .03, .001), default: .022, stage: 'scatter' }),
  P('grass.lean', 'Grass', 'Lean', { ...num(0, 1.2, .05, 'How far a blade leans at rest, before any wind.'), default: .38, stage: 'scatter' }),
  P('grass.brightness', 'Grass', 'Brightness', { ...num(0, 2, .05, "Multiplies the whole sward's colour. This is what takes it darker than any colour can."), default: .65, stage: 'look' }),
  P('grass.occlusion', 'Grass', 'Root shading', { ...num(0, 1, .05, 'How dark a blade is at the litter it grows out of.'), default: .65, stage: 'look' }),
  P('grass.color', 'Grass', 'Colour', { ...color("The sward's tip colour. The blade root and the ground tint under the grass are derived from it, so this one swatch moves the whole meadow."), default: '#7c9448', stage: 'look' }),
  P('grass.dryColor', 'Grass', 'Dry colour', { ...color('What the driest tips lean toward. Held no lighter than the tip colour, so a pale straw can never bleach the sward white.'), default: '#a89b5c', stage: 'look' }),
  P('grass.variation', 'Grass', 'Colour variation', { ...num(0, 1, .05, 'Spread of brightness between neighbouring tufts, shared by a patch of blades rather than each one. Clamped to ±10% in the shader.'), default: .2, stage: 'look' }),
  P('grass.specular', 'Grass', 'Glint', { ...num(0, 1, .01, 'The specular rim on a blade edge. Zero removes it.'), default: 0, stage: 'look' }),
  P('grass.roughness', 'Grass', 'Roughness', { ...num(0, 1, .01), default: 1, stage: 'look' }),
  P('grass.sky', 'Grass', 'Sky light', { ...num(0, 2, .05, 'How much ambient sky the sward takes.'), default: 1, stage: 'look' }),
  P('grass.groundBlend', 'Grass', 'Blend with ground', { ...num(0, 1, .05, "How much of the terrain's own colour the base of a blade takes, so the sward meets the ground."), default: .6, stage: 'look' }),
  P('grass.distance', 'Grass', 'Draw distance (m)', { ...num(20, 400, 5, 'Where the field stops. The budget is spent inside this radius.'), default: 70, stage: 'scatter' }),

  // ---- Vegetation -----------------------------------------------------------
  P('geography.forestCover', 'Vegetation', 'Forest coverage', { ...num(0, 1, .05, 'Fraction of suitable ground that becomes woodland.'), default: .72, stage: 'field' }),
  P('forestDensity', 'Vegetation', 'Tree density', { ...num(0, 2, .05, 'Trees per unit of forest.'), default: 1, stage: 'scatter' }),
  P('groundDensity', 'Vegetation', 'Ground cover', { ...num(0, 2, .05, 'Grass, ferns and small plants.'), default: 1, stage: 'scatter' }),
  P('vegetation.patchiness', 'Vegetation', 'Natural clusters', { ...num(0, 1, .05, 'Even planting at 0; clumped communities and clearings at 1.'), default: .65, stage: 'scatter' }),
  P('vegetation.treeScale', 'Vegetation', 'Tree size', { ...num(.65, 1.5, .05, 'Height of the mature canopy.'), default: 1, stage: 'scatter' }),
  P('vegetation.grassHeight', 'Vegetation', 'Grass height', { ...num(.5, 1.75, .05, 'Height of the ground layer.'), default: 1, stage: 'scatter' }),
  P('vegetation.accentTrees', 'Vegetation', 'Golden accent trees', { ...num(0, 2, .05, 'Sparse golden trees standing on rocky shelves and high ground.'), default: 1, stage: 'scatter' }),

  // ---- Look -----------------------------------------------------------------
  // ---- Streaming ------------------------------------------------------------
  // 09-14: the authored region stays as it is; the landscape around it streams in chunks as the camera moves.
  P('streaming.enabled', 'Streaming', 'Stream surroundings', { kind: 'boolean', default: false, stage: 'layout',
    hint: 'Draw the landscape beyond the World in chunks that load around the camera. The authored region is cut from the same, larger landscape.' }),
  P('streaming.extent', 'Streaming', 'Streamed land (m)', { ...pick(STREAMING_EXTENTS, 'Size of the whole landscape the World sits in.'), default: 2048, stage: 'layout' }),
  P('streaming.radius', 'Streaming', 'View radius (m)', { ...num(256, 4096, 32, 'How far from the camera chunks are drawn. Cost grows with its square.'), default: 1024, stage: 'look' }),
  P('streaming.chunkSize', 'Streaming', 'Chunk size (m)', { ...pick([64, 128, 256], 'Side of one streamed chunk. Adjusted so the World is a whole number of chunks.'), default: 128, stage: 'look' }),
  P('streaming.villages', 'Streaming', 'Villages', { ...num(0, 1, .05, 'How often the streamed land around the World is settled: hamlets and villages with lanes, sited and planned like the valley\'s own.'), default: .5, stage: 'look' }),
  P('streaming.memory', 'Streaming', 'Memory budget (MB)', { ...pick([128, 256, 512, 1024, 2048], 'Ceiling on everything streamed in (ground, water, stone, plants). Over it, the farthest and unseen chunks drop plants, then stone, then water.'), default: 512, stage: 'look' }),

  P('style', 'Look', 'Treatment', { ...pick(['natural', 'stylized'], 'Palette and form language.'), default: 'natural', stage: 'look' }),
  P('surfaceMode', 'Look', 'Ground finish', { ...pick(['materials', 'procedural']), default: 'materials', stage: 'look' }),
  P('surfaceScale', 'Look', 'Surface scale', { ...num(.5, 2, .05), default: 1, stage: 'look' }),
  P('surfaceBump', 'Look', 'Surface relief', { ...num(0, 2, .05), default: 1, stage: 'look' }),
  P('sky', 'Look', 'Sky', { ...pick(['auto', 'off', 'world']), default: 'auto', stage: 'look' }),
]);

export const WORLD_PARAMETER_GROUPS = Object.freeze([...new Set(WORLD_PARAMETERS.map(p => p.group))]);
const byPath = new Map(WORLD_PARAMETERS.map(parameter => [parameter.path, parameter]));

export function worldParameter(path) { return byPath.get(path) ?? null; }

const readPath = (source, path) => path.split('.').reduce((value, key) => value?.[key], source);
function writePath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
  return target;
}

/** The default document settings, rebuilt from the table so the two cannot drift. */
export function worldDefaultSettings() {
  const settings = {};
  for (const parameter of WORLD_PARAMETERS) writePath(settings, parameter.path, parameter.default);
  settings.layout.mode = 'procedural';
  return settings;
}

/** Groups that exist purely as containers; unknown members are still rejected. */
export const WORLD_SETTING_GROUPS = Object.freeze(['geography', 'vegetation', 'layout', 'terrain', 'water', 'settlement', 'grass', 'ground', 'streaming']);

export function validateWorldParameter(path, value) {
  const parameter = byPath.get(path);
  if (!parameter) throw new TypeError(`Unknown World setting ${path}`);
  // Messages name the storage path, so a validation failure points at the
  // setting a caller actually wrote rather than at its display label.
  const { kind } = parameter;
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${path} must be true or false`);
    return value;
  }
  if (kind === 'enum') {
    if (!parameter.choices.includes(value)) throw new TypeError(`${path} must be one of ${parameter.choices.join(', ')}`);
    return value;
  }
  if (kind === 'color') {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError(`${path} must be a #rrggbb colour`);
    return value.toLowerCase();
  }
  const integer = kind === 'integer';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < parameter.min || value > parameter.max || integer && !Number.isInteger(value)) {
    throw new RangeError(`${path} must be ${integer ? 'an integer ' : ''}between ${parameter.min} and ${parameter.max}`);
  }
  return value;
}

/** Migration for documents saved under an older table: a finite number outside its
 * parameter's current range is clamped into it (with a warning) instead of rejecting the
 * whole World — the 09-13 grass rebuild moved `grass.height` from 0.42 to 0.1..0.28 and
 * every saved scene would otherwise fail to load. Enums and booleans are left to validation. */
export function clampWorldSettings(settings, warn = (message) => console.warn(message)) {
  for (const parameter of WORLD_PARAMETERS) {
    if (parameter.kind === 'boolean' || parameter.kind === 'enum') continue;
    const value = readPath(settings, parameter.path);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let next = Math.min(parameter.max, Math.max(parameter.min, value));
    if (parameter.kind === 'integer') next = Math.round(next);
    if (next !== value) { writePath(settings, parameter.path, next); warn(`World setting ${parameter.path} = ${value} is outside ${parameter.min}..${parameter.max}; clamped to ${next}`); }
  }
  return settings;
}

/** Validate every declared parameter of an already merged settings object. */
export function validateWorldSettings(settings) {
  for (const parameter of WORLD_PARAMETERS) validateWorldParameter(parameter.path, readPath(settings, parameter.path));
  return settings;
}

/** Inspector/automation description: the parameters of one group, in order. */
export function describeWorldParameters(group = null) {
  return WORLD_PARAMETERS.filter(parameter => !group || parameter.group === group)
    .map(({ path, group: category, label, kind, min, max, step, choices, default: fallback, hint, stage }) =>
      ({ path, group: category, label, kind, min, max, step, choices, default: fallback, hint, stage }));
}
