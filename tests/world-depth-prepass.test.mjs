import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Entity } from '../src/engine/Entity.js';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';
import { installWorldDepthPrepass } from '../src/modules/world/worldDepthPrepass.js';
import { installWorldDepthPrepass as installStudyDepthPrepass } from '../scripts/lib/worldDepthPrepassStudy.js';

function fixture() {
  const engine = new EventEmitter(); let mrt = null;
  Object.assign(engine, { scene: new THREE.Scene(), modules: new Map(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(),
    playing: true, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id); engine.onPreRender = fn => engine.on('preRender', fn);
  engine.camera.position.set(0, 2, 5);
  const entity = new Entity(engine, { id: 'trees' }); engine.entities.set(entity.id, entity); entity.setParent(null);
  const layer = entity.addComponent(new FoliageComponent({ species: 'oak', height: 3, width: 2, distribution: 'placements',
    placements: [{ id: 'a', position: [0, 0, 0] }, { id: 'b', position: [12, 1, -4], rotation: [0, .8, 0], scale: 1.2 }] }));
  engine.renderer = { getMRT: () => mrt };
  const controller = installWorldDepthPrepass(engine, [layer]);
  assert.equal(controller.entries.length, 2, 'both native tree geometry LODs are eligible');
  return { engine, entity, layer, controller, setMRT: value => { mrt = value; }, cleanup() { controller.dispose(); entity.removeComponent('foliage'); } };
}

test('study depth borrows exact source buffers, bounds and counts, without extra shadows or resource ownership', () => {
  const f = fixture();
  try {
    const borrowed = [...f.layer.geometries, f.layer.material]; let disposed = 0;
    borrowed.forEach(resource => resource.addEventListener('dispose', () => disposed++));
    const identities = f.controller.entries.map(entry => entry.mesh);
    for (const { source, mesh } of f.controller.entries) {
      assert.equal(mesh.geometry, source.geometry); assert.equal(mesh.instanceMatrix, source.instanceMatrix);
      assert.equal(mesh.material.positionNode, source.material.positionNode); assert.equal(mesh.material.alphaTest, source.material.alphaTest);
      assert.equal(mesh.material.colorWrite, false); assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
      source.count = 1; source.visible = false; source.matrix.makeTranslation(3, 4, 5); source.instanceMatrix.needsUpdate = true;
    }
    f.controller.sync();
    assert.deepEqual(f.controller.entries.map(entry => entry.mesh), identities, 'ordinary frames retain native shader object identities');
    for (const { source, mesh } of f.controller.entries) {
      assert.equal(mesh.count, source.count); assert.equal(mesh.visible, false); assert.equal(mesh.boundingSphere, source.boundingSphere);
      assert.deepEqual(mesh.matrix.elements, source.matrix.elements); assert.equal(mesh.instanceMatrix.version, source.instanceMatrix.version);
    }
    f.controller.dispose(); assert.equal(disposed, 0, 'disposing the borrower never disposes source geometry/material/matrices');
  } finally { f.cleanup(); }
});

test('study compatibility entry uses the exact production World implementation', () => {
  assert.equal(installStudyDepthPrepass, installWorldDepthPrepass);
});

test('GI/postprocessing modules and setup, render overrides and MRTs withdraw depth before alternative passes', () => {
  const f = fixture();
  try {
    f.engine.modules.set('gi', {}); f.engine.emit('modules-changed'); assert.equal(f.controller.entries.length, 0, 'enabled GI without a system field is still GI');
    f.engine.modules.delete('gi'); f.engine.emit('modules-changed'); assert.equal(f.controller.entries.length, 2);
    f.engine._registrant = { id: 'gi' }; f.controller.sync(); assert.equal(f.controller.entries.length, 0);
    f.engine._registrant = null; f.controller.sync(); assert.equal(f.controller.entries.length, 2);
    f.engine.modules.set('postprocessing', {}); f.engine.emit('modules-changed'); assert.equal(f.controller.entries.length, 0, 'even an enabled module without an active camera is conservatively excluded');
    f.engine.modules.delete('postprocessing'); f.engine.emit('modules-changed'); assert.equal(f.controller.entries.length, 2);
    f.engine._registrant = { id: 'postprocessing' }; f.engine.emit('preRender'); assert.equal(f.controller.entries.length, 0, 'setup withdraws borrowers before postprocessing is published in engine.modules');
    f.engine._registrant = null; f.engine.emit('preRender'); assert.equal(f.controller.entries.length, 2);
    f.engine.renderOverrides = new Set([{ render() {} }]); f.engine.emit('preRender'); assert.equal(f.controller.entries.length, 0, 'a direct camera render override is not the ordinary main raster pass');
    f.engine.renderOverrides.clear(); f.engine.emit('preRender'); assert.equal(f.controller.entries.length, 2);
    f.engine.scene.overrideMaterial = new THREE.MeshBasicNodeMaterial(); f.controller.sync(); assert.equal(f.controller.entries.length, 0);
    f.engine.scene.overrideMaterial.dispose(); f.engine.scene.overrideMaterial = null; f.controller.sync(); assert.equal(f.controller.entries.length, 2);
    f.setMRT({}); f.controller.sync(); assert.equal(f.controller.entries.length, 0);
    f.setMRT(null); f.controller.sync(); assert.equal(f.controller.entries.length, 2);
  } finally { f.cleanup(); }
});

test('unsupported alpha, depth and raster states cannot occlude native color draws', () => {
  const f = fixture();
  try {
    const material = f.layer.material;
    for (const [key, value] of [['transparent', true], ['depthWrite', false], ['depthTest', false], ['depthFunc', THREE.AlwaysDepth],
      ['opacity', .5], ['alphaHash', true], ['alphaToCoverage', true], ['alphaTest', 0], ['side', THREE.FrontSide],
      ['polygonOffset', true], ['stencilWrite', true], ['clippingPlanes', [new THREE.Plane()]], ['maskNode', material.opacityNode],
      ['fragmentNode', material.colorNode], ['depthNode', material.opacityNode], ['map', new THREE.Texture()]]) {
      const before = material[key]; material[key] = value; f.controller.sync(); assert.equal(f.controller.entries.length, 0, key);
      material[key] = before; f.controller.sync(); assert.equal(f.controller.entries.length, 2, `${key} restored`);
    }
  } finally { f.cleanup(); }
});

test('native regeneration withdraws old borrowers before source geometry retires and adopts replacement draws', () => {
  const f = fixture();
  try {
    const oldSources = [...f.layer.renderMeshes], oldProxies = f.controller.entries.map(entry => entry.mesh);
    let retired = 0;
    for (const geometry of f.layer.geometries) geometry.addEventListener('dispose', () => {
      retired++; assert.ok(oldProxies.every(mesh => mesh.parent === null), 'source retirement sees no attached borrowed draw');
    });
    f.layer.setProp('height', 4); f.layer.update(true);
    assert.equal(retired, 2); assert.equal(f.controller.entries.length, 0);
    f.controller.sync(); assert.equal(f.controller.entries.length, 2);
    assert.ok(f.controller.entries.every(entry => !oldSources.includes(entry.source) && entry.mesh.geometry === entry.source.geometry));
    const source = f.controller.entries[0].source;
    source.removeFromParent(); assert.ok(f.controller.entries.every(entry => entry.source !== source), 'detach removes the borrower without waiting a frame');
    f.controller.sync(); assert.ok(f.controller.entries.every(entry => entry.source !== source));
  } finally { f.cleanup(); }
});

test('material graph edits rebuild only owned depth materials and disposed sources never reappear', () => {
  const f = fixture();
  try {
    const previous = f.controller.entries[0].mesh.material; let disposals = 0;
    previous.addEventListener('dispose', () => disposals++);
    f.layer.material.opacityNode = f.layer.material.opacityNode.mul(1); f.controller.sync();
    assert.equal(disposals, 1, 'one shared depth material is released exactly once');
    assert.ok(f.controller.entries.every(entry => entry.mesh.material !== previous));
    assert.equal(new Set(f.controller.entries.map(entry => entry.mesh.material)).size, 1, 'both LODs share the replacement depth material');
    const geometry = f.layer.geometries[0]; geometry.dispose();
    assert.ok(f.controller.entries.every(entry => entry.geometry !== geometry));
    f.controller.sync(); assert.ok(f.controller.entries.every(entry => entry.geometry !== geometry), 'sync never resurrects a retired geometry');
    const source = f.controller.entries[0].source; source.dispose();
    assert.equal(f.controller.entries.length, 0); assert.ok(source.parent, 'disposed source deliberately remains attached as the negative control');
    f.controller.sync(); assert.equal(f.controller.entries.length, 0, 'a disposed draw object cannot be re-created by the borrower');
    f.layer.material.dispose(); assert.equal(f.controller.entries.length, 0); f.controller.sync(); assert.equal(f.controller.entries.length, 0);
  } finally { f.cleanup(); }
});

test('disposal is idempotent and unsubscribes regeneration/module callbacks permanently', () => {
  const f = fixture();
  try {
    const proxies = f.controller.entries.map(entry => entry.mesh), material = proxies[0].material; let disposed = 0;
    material.addEventListener('dispose', () => disposed++);
    f.controller.dispose(); f.controller.dispose(); f.controller.sync();
    f.engine.emit('preRender'); f.engine.emit('modules-changed');
    assert.equal(disposed, 1); assert.equal(f.controller.entries.length, 0); assert.ok(proxies.every(mesh => mesh.parent === null));
    f.layer.setProp('height', 5); f.layer.update(true); f.engine.emit('preRender'); assert.equal(f.controller.entries.length, 0);
  } finally { f.cleanup(); }
});
