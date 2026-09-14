/** The embedded World document owns these project references. Both scene
 * preloading and export use this walk; semantic IDs, labels and transform
 * targets are never interpreted as filenames. Built-in surfaces remain in
 * the module's Vite asset closure and are deliberately absent here. */
const ASSET_KEYS = new Set(['material', 'material2', 'material3', 'material4',
  'material5', 'material6', 'material7', 'material8', 'texture', 'albedo',
  'normalMap', 'roughnessMap', 'heightMap', 'geometryAsset', 'model']);
const text = value => typeof value === 'string' && value.length > 0;

/** Native Terrain retains these arrays in cached/generated children too. */
export function rewriteTerrainLayerAssets(value, rewrite) {
  for (const layer of [...(value?.layers ?? []), ...(value?.scatterLayers ?? [])]) {
    for (const key of ['material', 'albedo', 'normalMap', 'roughnessMap', 'model']) {
      if (text(layer?.[key])) layer[key] = rewrite(layer[key]);
    }
  }
}

export function rewriteWorldDocumentAssets(document, rewrite, { getSchema = () => [] } = {}) {
  if (!document || typeof document !== 'object') return document;
  const field = (object, key) => {
    if (text(object?.[key])) object[key] = rewrite(object[key]);
  };
  const props = (value, type) => {
    if (!value || typeof value !== 'object') return;
    const keys = new Set(ASSET_KEYS);
    for (const entry of getSchema(type) ?? []) if (entry.type === 'asset') keys.add(entry.key);
    for (const key of keys) field(value, key);
    // Native Terrain's layer/scatter arrays and model material overrides are
    // structured values, so no scalar schema field describes their assets.
    for (const layer of value.layers ?? []) props(layer, 'terrain-layer');
    for (const layer of value.scatterLayers ?? []) props(layer, 'terrain-scatter');
    for (const key of Object.keys(value.materials ?? {})) field(value.materials, key);
    for (const variant of Object.values(value.variants ?? {})) props(variant, type);
  };
  const feature = value => {
    props(value?.props, value?.type ?? value?.kind);
    props(value?.mesh, 'mesh');
  };
  for (const key of Object.keys(document.resources?.materials ?? {})) field(document.resources.materials, key);
  for (const role of ['grass', 'soil', 'rock']) {
    const layer = document.resources?.surfaceMaps?.[role];
    field(layer, 'albedo'); field(layer, 'height');
  }
  for (const value of Object.values(document.providerOverrides ?? {})) feature(value);
  const edit = operation => {
    if (!operation || typeof operation !== 'object') return;
    if (operation.kind === 'override') {
      const path = Array.isArray(operation.property) ? operation.property : String(operation.property ?? '').split('.');
      if (ASSET_KEYS.has(path.at(-1)) || (path.at(-1) === 'path' && path.includes('material'))) {
        field(operation, 'value');
      } else if (path.at(-1) === 'materials' && operation.value && typeof operation.value === 'object') {
        for (const key of Object.keys(operation.value)) field(operation.value, key);
      }
    }
    feature(operation.feature); feature(operation.snapshot);
  };
  for (const operation of document.edits ?? []) edit(operation);
  for (const layer of document.editLayers ?? []) for (const operation of layer.operations ?? []) edit(operation);
  for (const operation of document.orphanEdits ?? []) edit(operation);
  for (const value of document.authoredFeatures ?? []) feature(value);
  return document;
}

export function collectWorldDocumentAssets(document, options) {
  const out = new Set();
  // Discovery must be read-only: the shared walker writes its replacement
  // values, which would otherwise trip readonly authored-document accessors.
  rewriteWorldDocumentAssets(structuredClone(document), value => { out.add(value); return value; }, options);
  return [...out];
}
