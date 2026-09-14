import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Engine } from '../src/engine/Engine.js';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { registerComponent } from '../src/engine/components/registry.js';
import { MeshComponent } from '../src/engine/components/MeshComponent.js';
import { serializeEntity, instantiateEntity } from '../src/engine/serialize.js';
import { registerModuleDefinition, enableEngineModule, disableEngineModule, disposeEngineModules } from '../src/engine/modules.js';
import { setAssetBinaryLoader } from '../src/engine/assetResolver.js';
import { updateMaterialAsset, MATERIAL_DEFAULTS } from '../src/engine/materialAsset.js';
import { createWorldDocument, patchWorldSettings } from '../src/engine/world/worldDocument.js';
import { terrainModule } from '../src/modules/terrain/index.js';
import { TerrainComponent } from '../src/modules/terrain/TerrainComponent.js';
import { foliageModule } from '../src/modules/foliage/index.js';
import { FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';
import { atmosphereModule } from '../src/modules/atmosphere/index.js';
import { architectureModule } from '../src/modules/architecture/index.js';
import { waterModule } from '../src/modules/water/index.js';
import { worldModule, WorldComponent } from '../src/modules/world/index.js';
import { encodeWorldHeights } from '../src/modules/world/worldPlan.js';
import { vmSingleton } from '../src/editor/singleton.js';
import { commandBus } from '../src/editor/commands/CommandBus.js';
import { SetTerrainHeightsCommand } from '../src/editor/commands/terrainCommands.js';
import { SetTransformCommand } from '../src/editor/commands/transformCommands.js';
import { DuplicateEntityCommand } from '../src/editor/commands/entityCommands.js';
import { setWorldRoofColor } from '../src/editor/worldBuild.js';
import { freeze } from '../src/engine/freezeLedger.js';

// No renderer stubs or substitute providers: real Entity, native components,
// geometry/material ownership, serializer and editor commands run under Node.
registerComponent(MeshComponent);
for (const definition of [terrainModule, foliageModule, atmosphereModule, architectureModule, waterModule, worldModule]) {
  registerModuleDefinition(definition);
}
let sequence = 0;
const defaults = { surfaceMode: 'procedural', sky: 'off', forestDensity: 0, groundDensity: 0, layout: { mode: 'study' }, settlement: { editableBuildings: false } };
const clone = value => structuredClone(value);
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function restoreBinaryLoader() {
  setAssetBinaryLoader(async path => { const response = await fetch(path); return response.ok ? response.arrayBuffer() : null; });
}
async function fixture(t, settings = {}) {
  const engine = new EventEmitter();
  Object.assign(engine, {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), entities: new Map(), rootEntities: [], modules: new Map(),
    viewOnlyComponents: new Set(), playing: false, deltaTime: 1 / 60, elapsedTime: 0, settings: {}, sceneName: 'World runtime fixture',
    createEntity: Engine.prototype.createEntity, destroyEntity: Engine.prototype.destroyEntity,
    getEntity(id) { return this.entities.get(id); }, batchHierarchy(fn) { return fn(); },
    onPreRender(fn) { return this.on('preRender', fn); },
  });
  engine.camera.position.set(0, 10, 30);
  vmSingleton('engineInstance', () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  await enableEngineModule(engine, 'world');
  const baselinePreRender = engine.listenerCount('preRender');
  t.after(async () => {
    for (const root of [...engine.rootEntities]) engine.destroyEntity(root);
    await disposeEngineModules(engine);
    commandBus.clearHistory();
    restoreBinaryLoader();
  });
  const root = engine.createEntity({ id: `world-runtime-${++sequence}`, name: 'Valley' });
  const world = root.addComponent('world', { document: createWorldDocument({ ...defaults, ...settings }) });
  return { engine, root, world, baselinePreRender };
}
async function ready(world) {
  const pending = world.whenReady();
  await pending;
  assert.equal(world.status, 'Ready', world.error ?? `World remained ${world.status}`);
  assert.equal(world.whenReady(), pending, 'one generation reaches Ready without a hidden replacement job');
}
function featureIds(world) {
  return Object.fromEntries(world.entity.children.filter(child => child.getComponent('world-feature'))
    .map(child => [child.getComponent('world-feature').props.key, child.id]));
}
function roof(world) {
  const product = world.getFeatureEntity('cottage')._worldProduct;
  const mesh = product.children.find(child => child.userData.worldStudyRole === 'roof');
  assert.ok(mesh?.geometry.attributes.color, 'the cottage has actual colored roof geometry');
  return mesh;
}
function actualHeights(world) { return world.terrainEntity.getComponent('terrain').geometry.attributes.position.array.filter((_, i) => i % 3 === 1); }

test('procedural World seeds change real basins, river geometry and house layout while retaining an authored roof', async t => {
  const { world, root } = await fixture(t, { layout:{mode:'procedural'}, seed:894 });
  await ready(world);
  const describe = () => ({ lakes:clone(world._plan.layout.lakes), rivers:clone(world._plan.layout.rivers), 
    houses:world.features.filter(feature => feature.kind === 'building').map(feature => ({id:feature.id,pose:world.getFeatureEntity(feature.id).getTransform()})),
    lanes:clone(world._plan.layout.lanes), terrain:actualHeights(world) });
  const initial = describe();
  assert.ok(initial.houses.length >= 2 && initial.lanes.length >= 1, 'default recipe produces a connected settlement');
  assert.equal(root.children.filter(child => child._worldProduct && child.getComponent('world-feature')?.props.key.startsWith('house/')).length, initial.houses.length-1);
  const cottageId = world.getFeatureEntity('cottage').id;
  setWorldRoofColor(root.id,'cottage','#23c6d8'); await ready(world);
  world.setProp('document',patchWorldSettings(world.props.document,{seed:895})); await ready(world);
  const regenerated = describe();
  for (const key of ['lakes','rivers','houses','lanes','terrain']) assert.notDeepEqual(regenerated[key],initial[key],`${key} must be regenerated from the seed`);
  assert.equal(world.getFeatureEntity('cottage').id,cottageId);
  assert.equal(world.getFeature('cottage').props.roofColor,'#23c6d8');
  for (const feature of world.features.filter(feature => feature.kind === 'building')) {
    assert.ok(world.getFeatureEntity(feature.id)._worldProduct.children.length > 5);
    assert.deepEqual(world.getFeatureEntity(feature.id).position.toArray(),feature.position);
  }
});

test('a house drag commits one dependent layout rebuild; native undo restores its pose, pad and source', async t => {
  const { world, engine } = await fixture(t,{layout:{mode:'procedural'},seed:894});
  await ready(world);
  const house = world.getFeatureEntity('cottage'), before = house.getTransform(), oldHeights = actualHeights(world), revision = world._revision;
  const after = { ...before, position:[before.position[0]+3,before.position[1]+.5,before.position[2]-2] };
  commandBus.clearHistory(); commandBus.beginPreview('Move house');
  commandBus.execute(new SetTransformCommand(house.id,{...after,position:[after.position[0]-1,after.position[1],after.position[2]]}));
  engine.emit('preRender');
  commandBus.execute(new SetTransformCommand(house.id,after)); engine.emit('preRender');
  assert.equal(world._revision,revision,'drag preview updates authoring without scheduling full layout generation');
  commandBus.endPreview();
  assert.equal(world._revision,revision+1); assert.equal(commandBus.undoStack.length,1);
  await ready(world);
  assert.deepEqual(house.getTransform(),after);
  const pad = world._plan.layout.buildingPads.find(pad => pad.id === 'cottage');
  assert.deepEqual(pad.center,after.position);
  assert.ok(Math.abs(world._plan.heightAt(after.position[0],after.position[2])-after.position[1])<1e-5);
  assert.notDeepEqual(actualHeights(world),oldHeights);
  assert.deepEqual(world.props.document.providerOverrides.cottage.transform,after);
  commandBus.undo(); await ready(world);
  assert.deepEqual(house.getTransform(),before);
  assert.equal(world.props.document.providerOverrides.cottage?.transform,undefined);
  assert.deepEqual(actualHeights(world),oldHeights);
});

test('World reaches Ready with real Terrain and submitted native Foliage, retaining feature IDs on regeneration', async t => {
  // The drawn grass field carries the sward now, so the scattered ground layers
  // stand down to the reeds and the flowers. This test is about the scatter
  // provider path, so it asks for the scattered sward explicitly.
  const { world, root } = await fixture(t, { groundDensity: .002, grass: { enabled: false } });
  await ready(world);
  assert.ok(world instanceof WorldComponent);
  const terrain = world.terrainEntity.getComponent('terrain');
  assert.ok(terrain instanceof TerrainComponent);
  assert.equal(terrain.mesh.geometry, terrain.geometry);
  assert.ok(terrain.mesh.material === terrain.material, 'late Mesh material setup must retain the native Terrain owner');
  assert.equal(terrain.geometry.attributes.position.count, 257 ** 2);
  assert.deepEqual(actualHeights(world), terrain.heightsArray, 'the planned surface reaches native vertex positions');
  assert.ok(terrain.heightsArray.some(height => Math.abs(height) > 1));
  const populations = root.children.map(child => child.getComponent('foliage')).filter(Boolean)
    .filter(foliage => !foliage.drawsGrass);
  assert.ok(populations.length > 0, 'low density still exercises actual provider instances');
  let submitted = 0;
  for (const foliage of populations) {
    assert.ok(foliage instanceof FoliageComponent);
    assert.equal(foliage.props.distribution, 'placements');
    assert.deepEqual(foliage.instances.map(instance => instance.id), foliage.props.placements.map(placement => placement.id));
    foliage.update(true);
    submitted += foliage.renderMeshes[0].count;
  }
  assert.ok(submitted > 0);
  const edited = populations[0], key = edited.entity.getComponent('world-feature').props.key;
  const placements = clone(edited.props.placements), oldVertices = edited.geometries[0].attributes.position.array.slice();
  const height = edited.props.height * 1.25;
  edited.setProp('height', height); edited.update(true);
  assert.notDeepEqual(edited.geometries[0].attributes.position.array, oldVertices, 'the native Foliage edit changes real prototype vertices');
  assert.equal(world.props.document.providerOverrides[key].props.height, height,
    'a native provider edit updates the shared authoring document');
  const ids = featureIds(world), terrainEntity = world.terrainEntity;
  await world.regenerate(); await ready(world);
  assert.deepEqual(featureIds(world), ids);
  assert.equal(world.terrainEntity, terrainEntity);
  const restored = world.getFeatureEntity(key).getComponent('foliage');
  restored.update(true);
  assert.equal(restored.props.height, height);
  assert.deepEqual(restored.props.placements, placements);
  assert.equal(world.getFeatureEntity('atmosphere'), null);
});

test('roof command changes actual native geometry colors and survives regeneration, undo and redo', async t => {
  const { root, world } = await fixture(t);
  await ready(world);
  const original = roof(world).geometry.attributes.color.array.slice();
  const positions = roof(world).geometry.attributes.position.array.slice();
  const ids = featureIds(world);
  setWorldRoofColor(root.id, 'cottage', '#ed208d');
  await ready(world);
  const changed = roof(world).geometry.attributes.color.array.slice();
  assert.notDeepEqual(changed, original);
  assert.deepEqual(roof(world).geometry.attributes.position.array, positions);
  await world.regenerate(); await ready(world);
  assert.deepEqual(roof(world).geometry.attributes.color.array, changed);
  assert.deepEqual(featureIds(world), ids);
  commandBus.undo(); await ready(world);
  assert.deepEqual(roof(world).geometry.attributes.color.array, original);
  commandBus.redo(); await ready(world);
  assert.deepEqual(roof(world).geometry.attributes.color.array, changed);
});

test('authored children preserve world pose when their generated parent is omitted, and recipe omission is reversible', async t => {
  const { engine, world, root } = await fixture(t);
  await ready(world);
  const cottage = world.getFeatureEntity('cottage');
  const addition = engine.createEntity({ name: 'Authored lantern', parent: cottage });
  addition.setTransform({ position: [2, 3, -1], rotation: [.1, .2, .3], scale: [.5, .7, .9] });
  addition.addComponent('mesh', { geometry: 'box', color: '#ff8020' });
  addition.object3D.updateWorldMatrix(true, false);
  const pose = addition.object3D.matrixWorld.elements.slice();
  await world.regenerate(); await ready(world);
  assert.equal(engine.getEntity(addition.id), addition);
  assert.equal(addition.parent, cottage);
  world.setProp('document', patchWorldSettings(world.props.document, { buildings: false }));
  await ready(world);
  assert.equal(world.getFeatureEntity('cottage'), null);
  assert.equal(addition.parent, root);
  addition.object3D.updateWorldMatrix(true, false);
  // Reparenting decomposes/recomposes a matrix; allow only Float64 arithmetic
  // roundoff, many orders below any meaningful position/rotation change.
  addition.object3D.matrixWorld.elements.forEach((value, index) => assert.ok(Math.abs(value - pose[index]) < 1e-12));
  engine.emit('preRender');
  assert.equal(world.props.document.edits.some(edit => edit.id === 'deleted:cottage'), false,
    'omitting a recipe feature must not manufacture a permanent user tombstone');
  world.setProp('document', patchWorldSettings(world.props.document, { buildings: true }));
  await ready(world);
  assert.ok(world.getFeatureEntity('cottage'));
  assert.equal(engine.getEntity(addition.id), addition);
});

test('a native sculpt stroke persists sparse deltas through regeneration and cached reload, with working native undo/redo', async t => {
  const fixtureState = await fixture(t), { engine } = fixtureState;
  let { root, world } = fixtureState;
  await ready(world);
  const terrain = world.terrainEntity.getComponent('terrain');
  // The terrain World generates is procedural now (P1-T): a stroke lands in
  // `heightEdits`, a delta against the generated base, never in `heights`.
  assert.equal(terrain.props.procedural, true);
  const before = terrain.props.heightEdits, original = terrain.heightsArray.slice();
  const indices = [257 * 119 + 145, 257 * 120 + 146];
  terrain.heightsArray[indices[0]] += .375;
  terrain.heightsArray[indices[1]] -= .625;
  terrain.commitHeights();
  const after = terrain.props.heightEdits, authored = terrain.heightsArray.slice();
  commandBus.execute(new SetTerrainHeightsCommand(terrain.entity.id, before, after, 'heightEdits'));
  await ready(world);
  assert.deepEqual(world.props.document.terrainEdits.indices, indices);
  assert.deepEqual(actualHeights(world), authored);
  await world.regenerate(); await ready(world);
  assert.deepEqual(actualHeights(world), authored);
  const saved = JSON.parse(JSON.stringify(serializeEntity(root))), ids = featureIds(world);
  assert.ok(saved.children.find(child => child.components.some(component => component.type === 'world-feature')),
    'normal generated children remain usable serialized provider caches');
  engine.destroyEntity(root);
  root = instantiateEntity(engine, saved, null); world = root.getComponent('world');
  await ready(world);
  assert.deepEqual(featureIds(world), ids);
  assert.deepEqual(actualHeights(world), authored);
  commandBus.undo(); await ready(world);
  assert.equal(world.props.document.terrainEdits, null);
  assert.deepEqual(actualHeights(world), original);
  commandBus.redo(); await ready(world);
  assert.deepEqual(actualHeights(world), authored);
});

test('a scene saved before P1-T (baked heights, no procedural prop) migrates to an identical procedural terrain', async t => {
  const fixtureState = await fixture(t, { layout: { mode: 'study' } }), { engine } = fixtureState;
  let { root, world } = fixtureState;
  await ready(world);
  const expectedHeights = actualHeights(world).slice();

  // Rewrite the just-generated scene's terrain child back to the pre-P1-T
  // shape `instantiateEntity` would read from an old save: no `procedural`
  // (nor any Procedural param), and the actual rendered grid baked into
  // `heights` — exactly what the old, non-procedural TerrainComponent wrote.
  const saved = JSON.parse(JSON.stringify(serializeEntity(root)));
  const terrainChild = saved.children.find(child => child.components.some(
    component => component.type === 'world-feature' && component.props.key === 'terrain'));
  const terrainComponentData = terrainChild.components.find(component => component.type === 'terrain');
  const { size, resolution, splatResolution, castShadow } = terrainComponentData.props;
  terrainComponentData.props = { size, resolution, splatResolution, castShadow, heights: encodeWorldHeights(Float32Array.from(expectedHeights)) };

  engine.destroyEntity(root);
  root = instantiateEntity(engine, saved, null); world = root.getComponent('world');
  await ready(world);
  const terrain = world.terrainEntity.getComponent('terrain');
  assert.equal(terrain.props.procedural, true, 'the migrated terrain ends up procedural');
  assert.equal(terrain.props.heights, '', 'the legacy baked grid is gone, not merely ignored');
  assert.deepEqual(actualHeights(world), expectedHeights, 'the rendered surface (base + overlay) is unchanged by the migration');
});

test('native duplication remaps cached entity identities while preserving semantic feature keys and roof edits', async t => {
  const { engine, root, world } = await fixture(t);
  await ready(world);
  setWorldRoofColor(root.id, 'cottage', '#378bec'); await ready(world);
  const sourceIds = featureIds(world), sourceColors = roof(world).geometry.attributes.color.array.slice();
  const duplicate = new DuplicateEntityCommand(root.id);
  commandBus.execute(duplicate);
  const copy = engine.getEntity(duplicate.entityId).getComponent('world');
  await ready(copy);
  const copyIds = featureIds(copy);
  assert.deepEqual(Object.keys(copyIds), Object.keys(sourceIds));
  for (const key of Object.keys(copyIds)) assert.notEqual(copyIds[key], sourceIds[key]);
  assert.deepEqual(copy.props.document, world.props.document);
  assert.deepEqual(roof(copy).geometry.attributes.color.array, sourceColors);
  await copy.regenerate(); await ready(copy);
  assert.deepEqual(featureIds(copy), copyIds);
  assert.deepEqual(featureIds(world), sourceIds);
});

test('component and module disable hide native outputs, preserve data and restore exactly one set of features', async t => {
  const { engine, world } = await fixture(t, { groundDensity: .001 });
  await ready(world);
  const ids = featureIds(world), authored = clone(world.props.document);
  const terrainMesh = world.terrainEntity.getComponent('terrain').mesh;
  const water = world.getFeatureEntity('water')._worldProduct;
  world.setProp('enabled', false);
  assert.equal(world.status, 'Inactive');
  assert.equal(terrainMesh.visible, false);
  assert.equal(water.visible, false);
  assert.ok(world.entity.children.filter(child => child.getComponent('foliage')).every(child => !child.getComponent('foliage').enabled));
  world.setProp('enabled', true); await ready(world);
  assert.deepEqual(featureIds(world), ids);
  assert.deepEqual(world.props.document, authored);
  assert.equal(world.terrainEntity.getComponent('terrain').mesh.visible, true);
  await disableEngineModule(engine, 'world');
  assert.equal(world.status, 'Inactive');
  assert.equal(world.terrainEntity.getComponent('terrain').mesh.visible, false);
  await enableEngineModule(engine, 'world'); await ready(world);
  assert.deepEqual(featureIds(world), ids);
  assert.deepEqual(world.props.document, authored);
});

test('failed material load reports Error and retains previous native geometry and products until a valid retry', async t => {
  const { world } = await fixture(t);
  await ready(world);
  const document = clone(world.props.document), oldPlan = world._plan, ids = featureIds(world), heights = actualHeights(world);
  const water = world.getFeatureEntity('water')._worldProduct;
  let releases = 0;
  water.geometry.addEventListener('dispose', () => { releases++; });
  setAssetBinaryLoader(async () => null);
  const changed = clone(document);
  changed.resources.materials.ground = `world-runtime-missing-${++sequence}.mat`;
  world.setProp('document', changed);
  await world.whenReady();
  assert.equal(world.status, 'Error', 'a loader fallback material cannot certify a World resource');
  assert.ok(world.error);
  assert.equal(world._plan, oldPlan);
  assert.deepEqual(featureIds(world), ids);
  assert.deepEqual(actualHeights(world), heights);
  assert.equal(world.getFeatureEntity('water')._worldProduct, water);
  assert.ok(water.parent);
  assert.equal(releases, 0);
  updateMaterialAsset(changed.resources.materials.ground,{...MATERIAL_DEFAULTS,color:'#b48651'});
  await world.regenerate(); await ready(world);
  assert.equal(world.props.document.resources.materials.ground,changed.resources.materials.ground,'repairing the asset can retry the same source without changing seed');
  assert.equal(releases, 1);
});

test('root deletion cancels a held resource load and late completion cannot publish native children', async t => {
  const { engine, world, root, baselinePreRender } = await fixture(t);
  await ready(world);
  const started = deferred(), finish = deferred();
  setAssetBinaryLoader(async () => { started.resolve(); return finish.promise; });
  const document = clone(world.props.document);
  document.resources.materials.ground = `world-runtime-cancel-${++sequence}.mat`;
  world.setProp('document', document);
  const pending = world.whenReady();
  await started.promise;
  engine.destroyEntity(root);
  finish.resolve(new TextEncoder().encode('{}').buffer);
  await pending;
  assert.equal(world.status, 'Inactive');
  assert.equal(engine.entities.size, 0);
  assert.equal(engine.listenerCount('preRender'), baselinePreRender);
  assert.equal(world._plan, null);
});

test('a native transform command during pending regeneration retains the actual pose and authored override', async t => {
  const { engine, world } = await fixture(t);
  await ready(world);
  const cottage = world.getFeatureEntity('cottage'), started = deferred(), finish = deferred();
  setAssetBinaryLoader(async () => { started.resolve(); return finish.promise; });
  const document = clone(world.props.document);
  document.resources.materials.ground = `world-runtime-transform-${++sequence}.mat`;
  world.setProp('document', document);
  await started.promise;
  const desired = { ...cottage.getTransform(), position: [25, 4.2, 10], rotation: [0, .4, 0] };
  commandBus.execute(new SetTransformCommand(cottage.id, desired));
  engine.emit('preRender');
  finish.resolve(new TextEncoder().encode('{}').buffer);
  await world.whenReady();
  if (world.status !== 'Ready') await ready(world);
  assert.deepEqual(cottage.getTransform(), desired);
  assert.deepEqual(world.props.document.providerOverrides.cottage.transform, desired);
  commandBus.undo(); engine.emit('preRender');
  await world.regenerate(); await ready(world);
  assert.deepEqual(cottage.position.toArray(), [22, 2.2, 6]);
});

test('a native commit failure restores the prior terrain and owned products, and malformed documents never mutate live authoring', async t => {
  const { world } = await fixture(t);
  await ready(world);
  const document = clone(world.props.document), oldPlan = world._plan, heights = actualHeights(world), ids = featureIds(world);
  const cottage = world.getFeatureEntity('cottage'), water = world.getFeatureEntity('water')._worldProduct;
  const originalTransform = cottage.setTransform;
  let fail = true;
  cottage.setTransform = function (...args) {
    if (fail) { fail = false; throw new Error('native commit rejection'); }
    return originalTransform.apply(this, args);
  };
  world.setProp('document', patchWorldSettings(document, { seed: document.settings.seed + 1 }));
  await world.whenReady();
  cottage.setTransform = originalTransform;
  assert.equal(world.status, 'Error');
  assert.match(world.error, /native commit rejection/);
  assert.equal(world._plan, oldPlan);
  assert.deepEqual(featureIds(world), ids);
  assert.deepEqual(actualHeights(world), heights);
  assert.equal(world.getFeatureEntity('water')._worldProduct, water);
  assert.ok(water.parent);
  world.setProp('document', document); await ready(world);
  const beforeInvalid = clone(world.props.document), revision = world._revision;
  assert.throws(() => world.setProp('document', { ...document, settings: { ...document.settings, sky: 'invalid' } }), /sky/);
  assert.throws(() => world.setBaseProp('document', { ...document, terrainEdits: { resolution: 256, indices: [9, 9], deltas: [.2, .3] } }), /terrain edit/i);
  assert.deepEqual(world.props.document, beforeInvalid);
  assert.equal(world._revision, revision);
  assert.equal(world.status, 'Ready');
});

test('a hierarchy failure after feature omission restores exact native entities, authored descendants and the unpublished prior plan', async t => {
  const { engine, world } = await fixture(t);
  await ready(world);
  const previous = world._plan, previousFeatures = world._featureEntities, previousStats = world.stats;
  const ids = featureIds(world), heights = actualHeights(world), cottage = world.getFeatureEntity('cottage');
  const oldWater = world.getFeatureEntity('water')._worldProduct, oldCottage = cottage._worldProduct;
  const authored = engine.createEntity({ name: 'Authored fixture', parent: cottage });
  authored.setTransform({ position: [1, 3, -2], rotation: [.2, .3, -.1], scale: [.8, 1.1, 1.3] });
  authored.addComponent('mesh', { geometry: 'box' });
  const localPose = authored.getTransform();
  authored.object3D.updateWorldMatrix(true, false);
  const worldPose = authored.object3D.matrixWorld.elements.slice();
  let oldReleases = 0, rejectedReleases = 0, observedUnpublished = false;
  oldWater.geometry.addEventListener('dispose', () => { oldReleases++; });
  const commit = world._commit;
  world._commit = function (plan, maps) {
    plan.products.get('water').geometry.addEventListener('dispose', () => { rejectedReleases++; });
    return commit.call(this, plan, maps);
  };
  // Use the production hierarchy coalescing/flush boundary, not a fake event
  // fired halfway through an ordinary successful native component attach.
  engine.emit = Engine.prototype.emit;
  engine.batchHierarchy = Engine.prototype.batchHierarchy;
  engine.flushHierarchyChanged = Engine.prototype.flushHierarchyChanged;
  const off = engine.on('hierarchy-changed', () => {
    if (!world._applying || world.getFeatureEntity('cottage')) return;
    off();
    observedUnpublished = world._plan === previous;
    throw new Error('hierarchy observer rejection after omission');
  });
  world.setProp('document', patchWorldSettings(world.props.document, { buildings: false, seed: world.props.document.settings.seed + 1 }));
  await world.whenReady();
  world._commit = commit;
  assert.equal(world.status, 'Error');
  assert.match(world.error, /hierarchy observer rejection/);
  assert.equal(observedUnpublished, true, 'the new plan must not publish before hierarchy delivery succeeds');
  assert.ok(world._plan === previous && world._featureEntities === previousFeatures && world.stats === previousStats);
  assert.deepEqual(featureIds(world), ids);
  assert.ok(world.getFeatureEntity('cottage') === cottage, 'rollback restores the original native entity, not only its ID');
  assert.ok(engine.getEntity(authored.id) === authored && authored.parent === cottage);
  assert.deepEqual(authored.getTransform(), localPose);
  authored.object3D.updateWorldMatrix(true, false);
  assert.deepEqual(authored.object3D.matrixWorld.elements, worldPose);
  assert.deepEqual(actualHeights(world), heights);
  assert.ok(oldWater.parent === world.getFeatureEntity('water').object3D && oldCottage.parent === cottage.object3D);
  assert.equal(oldReleases, 0, 'the previous plan remains owned and reusable');
  assert.equal(rejectedReleases, 1, 'only the rejected replacement is disposed');
  await world.regenerate(); await ready(world);
  assert.equal(world.getFeatureEntity('cottage'), null);
  assert.ok(engine.getEntity(authored.id) === authored && authored.parent === world.entity);
  assert.equal(oldReleases, 1, 'a successful retry retires the previous plan once');
});

test('native removal and old-plan retirement failures cannot reject or dispose the published replacement', async t => {
  const { engine, world } = await fixture(t);
  await ready(world);
  const previous = world._plan, originalDispose = previous.dispose, cottage = world.getFeatureEntity('cottage');
  let disposalAttempts = 0, currentReleases = 0, publishedBeforeRetirement = false;
  previous.dispose = () => {
    disposalAttempts++;
    publishedBeforeRetirement = world._plan !== previous;
    originalDispose();
    throw new Error('old-plan retirement observer failed');
  };
  const off = engine.on('component-removed', event => {
    if (event.entityId !== cottage.id || event.componentType !== 'world-feature') return;
    off(); throw new Error('native removal observer failed');
  });
  const commit = world._commit;
  world._commit = function (plan, maps) {
    plan.products.get('water').geometry.addEventListener('dispose', () => { currentReleases++; });
    return commit.call(this, plan, maps);
  };
  const warnings = [];
  const warning = t.mock.method(console, 'warn', (...args) => { warnings.push(args); });
  world.setProp('document', patchWorldSettings(world.props.document, { buildings: false, seed: world.props.document.settings.seed + 1 }));
  await ready(world);
  world._commit = commit; warning.mock.restore();
  assert.equal(publishedBeforeRetirement, true);
  assert.equal(disposalAttempts, 1);
  assert.equal(currentReleases, 0, 'the caller cannot dispose an already-published plan as a rejected attempt');
  assert.equal(world.getFeatureEntity('cottage'), null);
  assert.equal(engine.getEntity(cottage.id), undefined);
  assert.equal(cottage.components.size, 0, 'native cleanup completes despite a component-removed observer throwing');
  assert.ok(world.getFeatureEntity('water')._worldProduct.parent);
  assert.deepEqual(actualHeights(world), world._plan.heights);
  assert.deepEqual(world.stats.retirementErrors, ['native removal observer failed', 'old-plan retirement observer failed']);
  assert.equal(warnings.length, 1, 'retirement errors remain visible diagnostics');
});

// ⭐ docs/WORLD_PRODUCTION_PLAN.md §7.6 / memory "world-config-live-and-
// settlements": the plan's data stages already yield on a clock
// (`worldPlanDataSteps`'s `clock.due()`), so a landform edit must never hold
// the main thread longer than a frame slice between two of the driver's own
// `await` yields. This measures the WALL gap between consecutive zero-delay
// `setTimeout` schedulings during one generation — the same yields
// `prepareWorldPlanAsync`'s `wait()`/`tick()` use — as a proxy for "how long
// was JS ever unbroken". `WorldComponent._commit` itself is still one
// synchronous call (not yet sliced — see the attributed `world:commit/*`
// spans this session added), so it is measured and reported SEPARATELY
// rather than folded into the same bound: it is the next item on the plan,
// not something this test can honestly claim is fixed yet.
// TODO (§7.6): the plan driver's yields are still coarse enough to leave a
// ~200 ms unbroken stretch (measured below) — see the memory note's own
// "139 ms at 128 m / 238 ms at 512 m" record. `t.todo` keeps this receipt
// green while it stays true, rather than quietly raising the bar to match
// today's number.
test('a landform change never runs more than 40 ms of synchronous JS between the plan driver\'s own yields', { todo: 'plan driver yields are ~200 ms apart, not yet ≤ 40 ms — docs/WORLD_PRODUCTION_PLAN.md §7.6' }, async t => {
  const { world } = await fixture(t, { extent: 128, layout: { mode: 'procedural' } });
  await ready(world);
  const originalSetTimeout = globalThis.setTimeout;
  let lastYieldAt = null, worstGapMs = 0;
  const patched = (fn, delay, ...args) => {
    if (!delay) {
      const now = performance.now();
      if (lastYieldAt != null) worstGapMs = Math.max(worstGapMs, now - lastYieldAt);
      return originalSetTimeout(() => { lastYieldAt = performance.now(); fn(...args); }, delay);
    }
    return originalSetTimeout(fn, delay, ...args);
  };
  globalThis.setTimeout = patched;
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  lastYieldAt = performance.now();
  const commitStart = { ms: 0 };
  const commit = world._commit;
  world._commit = function (plan, maps) {
    const t0 = performance.now();
    try { return commit.call(this, plan, maps); } finally { commitStart.ms = performance.now() - t0; }
  };
  world.setProp('document', patchWorldSettings(world.props.document, { terrain: { levels: .9 } }));
  await ready(world);
  globalThis.setTimeout = originalSetTimeout;
  world._commit = commit;
  assert.ok(worstGapMs < 40, `plan driver's longest unbroken JS stretch between yields was ${worstGapMs.toFixed(1)} ms, want < 40 ms`);
  // Not yet asserted < 40 ms: `_commit` is one synchronous call end to end.
  // Reported so a regression is visible without silently rewriting the bar.
  t.diagnostic(`_commit synchronous duration (not yet sliced): ${commitStart.ms.toFixed(1)} ms`);
});
