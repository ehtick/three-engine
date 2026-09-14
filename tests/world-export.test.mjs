import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three/webgpu';
import { rewriteComponentAssets } from '../src/editor/build/assetRefs.js';
import { createAssetNames } from '../src/editor/build/assetNames.js';
import { selectRuntimeFiles } from '../src/editor/build/runtimeFiles.js';
import { moduleIdsForComponentTypes } from '../src/editor/build/moduleRefs.js';
import { collectWorldDocumentAssets } from '../src/engine/world/worldAssetRefs.js';
import { loadWorldSurfaceMaps } from '../src/modules/world/worldSurfaceMaps.js';
import { WORLD_BUILTIN_SURFACES } from '../src/modules/world/worldBuiltinSurfaces.js';
import { collectSceneAssets, expandMaterialAssets } from '../src/engine/sceneManager.js';
import { setAssetResolver } from '../src/engine/assetResolver.js';

const getSchema = type => type === 'foliage' ? [{ key: 'customTexture', type: 'asset' }] : [];
const document = () => ({ version: 1, recipe: 'temperate-valley',
  settings: { seed: 8, style: 'natural' },
  resources: {
    materials: { ground: 'C:/project/ground/Surface.mat', cottage: 'C:/project/cottage/Surface.mat' },
    surfaceMaps: Object.fromEntries(['grass', 'soil', 'rock'].map(role => [role, {
      albedo: `C:/project/${role}/color.png`, height: `C:/project/${role}/height.png`, size: [2, 2],
    }])),
  },
  providerOverrides: {
    terrain: { type: 'terrain', props: { layers: [{ material: 'C:/project/terrain/Surface.mat', normalMap: 'C:/project/normal.png' }] } },
    'foliage/oak': { type: 'foliage', props: { customTexture: 'C:/project/oak.png' }, transform: { position: [1, 2, 3] } },
    cottage: { type: 'world-feature', mesh: { material: 'C:/project/facade/Surface.mat' } },
  },
  edits: [
    { id: 'roof.mat', kind: 'override', target: 'feature.mat', property: 'material', value: 'C:/project/roof/Surface.mat' },
    { id: 'tint', kind: 'override', target: 'feature.mat', property: 'material.tint', value: '#ee1177' },
    { id: 'snapshot', kind: 'pin', target: 'cottage', snapshot: { id: 'cottage', props: { material: 'C:/project/pinned/Surface.mat' } } },
  ],
});

test('embedded World refs and native provider assets share export allocation and preserve semantic IDs', () => {
  const source = document(), before = structuredClone(source);
  const component = { type: 'world', props: { document: source, variants: { mobile: { document: document() } } } };
  const names = createAssetNames(), docs = [];
  rewriteComponentAssets(component, { getSchema, claim: p => names.claim(p),
    claimDoc: p => names.claimGenerated(p), add: (kind, p) => docs.push([kind, p]) });
  const assets = collectWorldDocumentAssets(component.props.document, { getSchema });
  assert.equal(assets.length, 14);
  assert.ok(assets.every(p => p.startsWith('assets/')));
  assert.equal(new Set(assets).size, assets.length, 'same-named role assets must not overwrite one another');
  assert.equal(docs.filter(([kind]) => kind === 'material').length, 12);
  assert.deepEqual(component.props.variants.mobile.document, component.props.document);
  assert.equal(source.edits[0].id, 'roof.mat');
  assert.equal(source.edits[0].target, 'feature.mat');
  assert.equal(source.edits[1].value, '#ee1177');
  assert.deepEqual(source.providerOverrides['foliage/oak'].transform, before.providerOverrides['foliage/oak'].transform);
  const frozen = structuredClone(before);
  Object.freeze(frozen.resources.materials);
  assert.equal(collectWorldDocumentAssets(frozen, { getSchema }).length, assets.length);
  assert.deepEqual(frozen, before, 'preload discovery never mutates the authored document');
});

test('ordinary scene preload follows embedded World materials into their decoded texture dependencies', async () => {
  const world = document();
  const assets = collectSceneAssets({ entities: [{ components: [{ type: 'world', props: { document: world } }] }] });
  assert.ok(assets.includes(world.resources.materials.ground));
  assert.ok(assets.includes(world.resources.surfaceMaps.grass.height));
  const fetchBefore = globalThis.fetch;
  const materialImages = new Set();
  setAssetResolver(async value => `https://fixture.invalid/${encodeURIComponent(value)}`);
  globalThis.fetch = async url => {
    const path = decodeURIComponent(String(url).split('/').at(-1));
    const image = path.replace(/\.mat$/i, '.png'); materialImages.add(image);
    return { ok: true, json: async () => ({ map: image, shaderGraph: { nodes: [{ type: 'texture', props: { path: `${image}.normal.png` } }] } }) };
  };
  try {
    const expanded = await expandMaterialAssets(assets);
    assert.equal(materialImages.size, 6);
    assert.ok([...materialImages].every(path => expanded.includes(path) && expanded.includes(`${path}.normal.png`)));
  } finally { globalThis.fetch = fetchBefore; setAssetResolver(async value => value); }
});

test('cached native Terrain children rewrite the same layer assets as their World document', () => {
  const authored = document();
  authored.providerOverrides.terrain.props.scatterLayers = [{ model: 'C:/project/tree.glb' }];
  const world = { type: 'world', props: { document: authored } };
  const terrain = { type: 'terrain', props: structuredClone(authored.providerOverrides.terrain.props) };
  const scene = { entities: [{ components: [world], children: [{ components: [terrain] }] }] };
  const before = collectSceneAssets(scene);
  assert.ok(before.includes('C:/project/tree.glb'));
  const names = createAssetNames(), context = { getSchema, claim: path => names.claim(path),
    claimDoc: path => names.claimGenerated(path), add() {} };
  rewriteComponentAssets(world, context); rewriteComponentAssets(terrain, context);
  assert.deepEqual(terrain.props, world.props.document.providerOverrides.terrain.props);
  assert.ok(collectSceneAssets(scene).every(path => path.startsWith('assets/')));
});

function fakeLoader(failAt = -1) {
  const records = [];
  return { records, load(url, loaded, _progress, failed) {
    const map = new THREE.Texture({ width: 1024, height: 1024 });
    const record = { url, map, disposed: 0 };
    map.addEventListener('dispose', () => record.disposed++);
    const index = records.push(record) - 1;
    queueMicrotask(() => index === failAt ? failed(new Error('fixture')) : loaded(map));
    return map;
  } };
}

test('World project surface refs use the normal asset resolver and own all six decoded maps', async () => {
  const loader = fakeLoader(), resolved = [], source = document().resources.surfaceMaps;
  const owner = await loadWorldSurfaceMaps(source, { loader, resolve: async p => { resolved.push(p); return `blob:${p}`; } });
  assert.equal(resolved.length, 6);
  assert.ok(loader.records.every(record => record.url.startsWith('blob:')));
  for (const role of ['grass', 'soil', 'rock']) {
    assert.equal(owner[role].albedo.colorSpace, THREE.SRGBColorSpace);
    assert.equal(owner[role].height.colorSpace, THREE.NoColorSpace);
    assert.equal(owner[role].height.wrapS, THREE.RepeatWrapping);
  }
  owner.dispose(); owner.dispose();
  assert.deepEqual(loader.records.map(record => record.disposed), [1, 1, 1, 1, 1, 1]);
});

test('failed World surface decode retires every sibling texture; invalid manifests allocate nothing', async () => {
  const loader = fakeLoader(2);
  await assert.rejects(loadWorldSurfaceMaps(document().resources.surfaceMaps, { loader, resolve: async p => p }), /failed to load/);
  assert.deepEqual(loader.records.map(record => record.disposed), [1, 1, 1, 1, 1, 1]);
  const invalidLoader = fakeLoader(), source = document().resources.surfaceMaps;
  source.rock.size = [0, 2];
  await assert.rejects(loadWorldSurfaceMaps(source, { loader: invalidLoader, resolve: async p => p }), /positive tile/);
  assert.equal(invalidLoader.records.length, 0);
});

test('built-in World assets are the six original local maps at exact physical dimensions and hashes', async () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('../src/modules/world/assets/manifest.json', import.meta.url)));
  let bytes = 0;
  for (const role of WORLD_BUILTIN_SURFACES.assets) {
    const expected = metadata.assets.find(asset => asset.role === role.role);
    assert.deepEqual(role.physicalDimensions.meters, expected.physicalDimensions.meters);
    for (const kind of ['albedo', 'height']) {
      const url = new URL(role.maps[kind].url);
      assert.equal(url.protocol, 'file:');
      assert.ok(!url.pathname.includes('/public/') && !url.pathname.includes('/scripts/'));
      const data = fs.readFileSync(url); bytes += data.length;
      assert.equal(createHash('sha256').update(data).digest('hex'), expected.maps[kind].sha256);
    }
  }
  assert.equal(bytes, 6716074);
  const loader = fakeLoader();
  const owner = await loadWorldSurfaceMaps(null, { loader, resolve: () => { throw new Error('built-ins must bypass the project resolver'); } });
  assert.equal(owner.report.textureCount, 6); owner.dispose();
});

test('runtime trimming follows World module assets and rejects the public study payload', () => {
  const assets = WORLD_BUILTIN_SURFACES.assets.flatMap(role => Object.values(role.maps).map((map, i) => `_engine/${role.role}-${i}.png`));
  const manifest = {
    'player.html': { isEntry: true, file: '_engine/player.js', dynamicImports: ['src/modules/world/worldBuiltinSurfaces.js'] },
    'src/modules/world/worldBuiltinSurfaces.js': { file: '_engine/world-surfaces.js', assets },
  };
  const templateFiles = ['_engine/player.js', '_engine/world-surfaces.js', ...assets, 'world-study/surfaces/manifest.json', 'world-study/surfaces/duplicate.png'];
  const withWorld = selectRuntimeFiles({ manifest, templateFiles, modules: ['world'] });
  assert.ok(assets.every(asset => withWorld.files.includes(asset)));
  assert.ok(withWorld.files.every(file => !file.startsWith('world-study/')));
  assert.deepEqual(selectRuntimeFiles({ manifest, templateFiles }).files, ['_engine/player.js']);
  assert.deepEqual(moduleIdsForComponentTypes(['world'], [
    { id: 'unrelated', components: [{ type: 'gi' }] }, { id: 'world', components: [{ type: 'world' }] },
  ]), ['world']);
});

test('the World plan Worker chunk ships exactly when the World module is enabled', () => {
  // Vite emits `new Worker(new URL('./worldPlan.worker.js', import.meta.url))`
  // as its own hashed chunk under `_engine/`, unconnected to the manifest's
  // static/dynamic import graph (same as bvhBlasWorker.js and the other
  // workers above) — trimming it is a loose-file rule, not a manifest walk.
  const templateFiles = ['_engine/player.js', '_engine/worldPlan.worker-abc123.js'];
  const manifest = { 'player.html': { isEntry: true, file: '_engine/player.js' } };
  const withWorld = selectRuntimeFiles({ manifest, templateFiles, modules: ['world'] });
  assert.ok(withWorld.files.includes('_engine/worldPlan.worker-abc123.js'));
  const withoutWorld = selectRuntimeFiles({ manifest, templateFiles, modules: [] });
  assert.ok(!withoutWorld.files.includes('_engine/worldPlan.worker-abc123.js'));
});
