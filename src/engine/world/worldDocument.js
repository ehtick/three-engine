import { resolveFeatureEdits } from './featureEdits.js';
import { worldDefaultSettings, validateWorldSettings, validateWorldParameter, worldParameter, clampWorldSettings,
  worldResolution, worldTerrainStep, WORLD_SETTING_GROUPS } from './worldConfig.js';

export const WORLD_DOCUMENT_VERSION = 1;
/** Default extent. A document's own `settings.extent` is authoritative. */
export const WORLD_EXTENT = 128;
const deepFreeze = value => {
  if (value && typeof value === 'object') for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};
export const WORLD_SETTINGS = deepFreeze(worldDefaultSettings());

/** The terrain grid a set of settings resolves to. Cells stay between 0.5 m and
 * 1 m: larger worlds add segments up to a bounded maximum, then coarsen. */
export function worldGrid(settings = WORLD_SETTINGS) {
  const extent = settings?.extent ?? WORLD_EXTENT, resolution = worldResolution(extent);
  return { extent, resolution, vertices: (resolution + 1) ** 2, step: worldTerrainStep(extent), half: extent / 2 };
}

const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function json(value, path = 'World', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !plain(value) || seen.has(value)) throw new TypeError(`${path} must contain finite plain JSON data`);
  seen.add(value); const out = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path} contains an unsupported property`);
    }
    out[key] = json(descriptor.value, `${path}.${key}`, seen);
  }
  if (Array.isArray(value) && (out.length !== value.length || Object.keys(out).length !== value.length)) throw new TypeError(`${path} cannot contain sparse arrays`);
  seen.delete(value); return out;
}

export function normalizeWorldDocument(input = {}) {
  const source = json(input);
  if (!plain(source)) throw new TypeError('World document must be an object');
  if ((source.version ?? 1) !== 1) throw new Error(`Unsupported World document version ${source.version}`);
  if ((source.recipe ?? 'temperate-valley') !== 'temperate-valley') throw new Error(`Unknown World recipe ${source.recipe}`);
  const given = source.settings ?? {};
  if (!plain(given)) throw new TypeError('World settings must be an object');
  for (const key of WORLD_SETTING_GROUPS) if (given[key] != null && !plain(given[key])) throw new TypeError(`${key} must be an object`);
  for (const key of Object.keys(given)) if (!(key in WORLD_SETTINGS)) throw new TypeError(`Unknown World setting ${key}`);
  for (const key of WORLD_SETTING_GROUPS) for (const field of Object.keys(given[key] ?? {})) {
    if (!(field in WORLD_SETTINGS[key])) throw new TypeError(`Unknown World setting ${key}.${field}`);
  }
  const settings = { ...WORLD_SETTINGS, ...given };
  for (const key of WORLD_SETTING_GROUPS) settings[key] = { ...WORLD_SETTINGS[key], ...given[key] };
  if (!['procedural','study'].includes(settings.layout.mode)) throw new TypeError('Unknown World layout mode');
  if (settings.layout.mode === 'study' && settings.extent !== WORLD_EXTENT) throw new TypeError('The study layout fixture only exists at 128 m');
  validateWorldSettings(settings);
  if (typeof settings.buildings !== 'boolean') throw new TypeError('buildings must be a boolean');
  const grid = worldGrid(settings);
  const edits = source.edits ?? [];
  // Missing features are deliberately retained as orphan edits by the resolver.
  resolveFeatureEdits([], edits);
  const providerOverrides = source.providerOverrides ?? {}, resources = source.resources ?? { materials: {} };
  if (!plain(providerOverrides) || !plain(resources) || resources.materials != null && !plain(resources.materials)) throw new TypeError('World overrides/resources must be objects');
  for (const [id, override] of Object.entries(providerOverrides)) {
    if (!id || !plain(override) || !['terrain', 'foliage', 'world-feature', 'atmosphere', 'architecture'].includes(override.type)) throw new TypeError(`Invalid provider override ${id}`);
    if (override.props != null && !plain(override.props) || override.mesh != null && !plain(override.mesh)) throw new TypeError(`Invalid properties for ${id}`);
    if (override.transform != null && !plain(override.transform)) throw new TypeError(`Invalid ${id} transform`);
    if (id === 'terrain') {
      for (const [key, value] of Object.entries({ size: grid.extent, resolution: grid.resolution })) if (override.props?.[key] != null && override.props[key] !== value) throw new TypeError(`This World uses a ${grid.extent} m / ${grid.resolution} segment terrain grid`);
      if (override.props?.heights != null) throw new TypeError('Use terrainEdits for World sculpting');
    }
    for (const [axis, vector] of Object.entries(override.transform ?? {})) {
      if (!['position', 'rotation', 'scale'].includes(axis) || !Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) throw new TypeError(`Invalid ${id} transform`);
    }
  }
  for (const [role, path] of Object.entries(resources.materials ?? {})) {
    if (!['ground','rock','cottage','water'].includes(role) || typeof path !== 'string') throw new TypeError(`Invalid World material role ${role}`);
  }
  const terrainEdits = source.terrainEdits ?? null;
  if (terrainEdits) {
    // Sculpt edits are indices into this document's own grid. A resized world
    // cannot silently reinterpret them against a different vertex count.
    if (terrainEdits.resolution !== grid.resolution || !Array.isArray(terrainEdits.indices) || !Array.isArray(terrainEdits.deltas) || terrainEdits.indices.length !== terrainEdits.deltas.length) throw new TypeError('Invalid World terrain edit grid');
    let previous = -1;
    for (let i = 0; i < terrainEdits.indices.length; i++) {
      const index = terrainEdits.indices[i], delta = terrainEdits.deltas[i];
      if (!Number.isInteger(index) || index <= previous || index >= grid.vertices || !Number.isFinite(delta) || Math.abs(delta) > 10000) throw new TypeError('Invalid World terrain edit sample');
      previous = index;
    }
  }
  return { version: 1, recipe: 'temperate-valley', settings, edits, providerOverrides, terrainEdits, resources: { materials: {}, ...resources } };
}

export function createWorldDocument(settings = {}) { return normalizeWorldDocument({ settings }); }
export function patchWorldSettings(document, patch) {
  const current = normalizeWorldDocument(document), next = json(patch);
  const settings = { ...current.settings, ...next };
  for (const key of WORLD_SETTING_GROUPS) settings[key] = { ...current.settings[key], ...next[key] };
  return normalizeWorldDocument({ ...current, settings });
}

/** Set one declared parameter by its dotted path, validated against the table. */
export function setWorldParameter(document, path, value) {
  if (!worldParameter(path)) throw new TypeError(`Unknown World setting ${path}`);
  validateWorldParameter(path, value);
  const keys = path.split('.'), patch = {};
  if (keys.length === 1) patch[keys[0]] = value; else patch[keys[0]] = { [keys[1]]: value };
  return patchWorldSettings(document, patch);
}
export function resetWorldFeatureOverride(document, target, property) {
  const next = normalizeWorldDocument(document);
  next.edits = next.edits.filter(edit => !(edit.kind === 'override' && edit.target === target && edit.property === property));
  return next;
}
export function setWorldFeatureOverride(document, target, property, value) {
  const next = resetWorldFeatureOverride(document, target, property);
  if (property === 'roofColor' && !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('Roof color must be a six-digit hex color');
  next.edits.push({ id: `override:${target}:${property}`, kind: 'override', target, property, value: json(value) });
  return normalizeWorldDocument(next);
}

export function captureWorldTerrainEdits(base, authored, resolution = Math.round(Math.sqrt(base.length)) - 1) {
  if ((resolution + 1) ** 2 !== base.length || authored.length !== base.length) throw new Error('World terrain grid mismatch');
  const indices = [], deltas = [];
  for (let i = 0; i < base.length; i++) {
    if (!Number.isFinite(authored[i])) throw new Error('Terrain heights must be finite');
    const delta = authored[i] - base[i];
    if (delta !== 0) { indices.push(i); deltas.push(delta); }
  }
  return indices.length ? { resolution, indices, deltas } : null;
}
export function applyWorldTerrainEdits(base, edits) {
  const result = new Float32Array(base);
  if (edits) for (let i = 0; i < edits.indices.length; i++) result[edits.indices[i]] += edits.deltas[i];
  return result;
}

/** Load-time migration: a document saved under an older parameter table gets every numeric
 * setting clamped into the current range (warning per change) BEFORE the strict
 * `normalizeWorldDocument`, which keeps rejecting out-of-range authoring. */
export function clampWorldDocument(input = {}) {
  const source = json(input);
  if (!plain(source) || !plain(source.settings)) return source;
  migrateLegacyTerrain(source.settings);
  clampWorldSettings(source.settings);
  return source;
}

/** 09-14: the analytic landform (12 terrain controls) and the Landforms group
 * (12 ridge/cliff controls) were replaced by the style-driven landscape. A
 * saved document keeps its character: its landform picks the nearest style
 * and its rock exposure becomes the Stone control; the rest is dropped. */
const LEGACY_TERRAIN_KEYS = ['macroShape', 'macroScale', 'baseHeight', 'featureScale', 'roughness', 'detail', 'warp', 'ridged',
  'terraces', 'terraceStrength', 'ridgeCount', 'ridgeAmplitude', 'ridgeWidth', 'ridgeLength', 'ridgeAlignment', 'ridgeVariation',
  'cliffCount', 'cliffHeight', 'cliffWidth', 'cliffLength', 'cliffAlignment', 'cliffVariation'];
const STYLE_FOR_LANDFORM = { plains: 'meadow', basin: 'meadow', valley: 'hills', slope: 'hills', highland: 'highlands', plateau: 'canyon', ridgeline: 'alpine' };
function migrateLegacyTerrain(settings) {
  const terrain = plain(settings.terrain) ? settings.terrain : null, geography = plain(settings.geography) ? settings.geography : null;
  if (terrain && typeof terrain.macroShape === 'string' && terrain.style === undefined) terrain.style = STYLE_FOR_LANDFORM[terrain.macroShape] ?? 'hills';
  if (terrain && geography && Number.isFinite(geography.rockiness) && terrain.rocks === undefined) terrain.rocks = Math.min(1, geography.rockiness / 2);
  if (terrain) for (const key of LEGACY_TERRAIN_KEYS) delete terrain[key];
  if (geography) { delete geography.relief; delete geography.rockiness; }
}
