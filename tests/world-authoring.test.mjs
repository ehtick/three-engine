import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Entity } from '../src/engine/Entity.js';
import { Component } from '../src/engine/components/Component.js';
import { registerComponent } from '../src/engine/components/registry.js';
import { serializeEntity, instantiateEntity } from '../src/engine/serialize.js';
import { vmSingleton } from '../src/editor/singleton.js';
import { createWorldDocument } from '../src/engine/world/worldDocument.js';
import { setViewportHandle } from '../src/editor/viewportHandle.js';
import { commandBus } from '../src/editor/commands/CommandBus.js';
import * as authoring from '../src/editor/worldBuild.js';

// Real Entity/Component, serializer and command history; provider generation has
// independent runtime gates. No renderer or browser is involved in these edits.
class DocumentComponent extends Component {
  static type = 'world';
  static defaults = { document: null };
  onPropChanged() {}
}

function fixture() {
  registerComponent(DocumentComponent);
  const listeners = new Map();
  const engine = {
    scene: new THREE.Scene(), entities: new Map(), rootEntities: [],
    viewOnlyComponents: new Set(), playing: false, sceneName: 'World authoring test',
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event).delete(listener);
    },
    emit(event, detail) { for (const listener of listeners.get(event) ?? []) listener(detail); },
    createEntity({ id, name, parent = null } = {}) {
      if (id && engine.entities.has(id)) throw new Error(`Duplicate entity id ${id}`);
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity); entity.setParent(parent); return entity;
    },
    getEntity(id) { return engine.entities.get(id); },
    destroyEntity(entity) {
      for (const child of [...entity.children]) engine.destroyEntity(child);
      entity.dispose();
      const siblings = entity.parent?.children ?? engine.rootEntities;
      siblings.splice(siblings.indexOf(entity), 1);
      entity.object3D.removeFromParent(); engine.entities.delete(entity.id);
    },
  };
  vmSingleton('engineInstance', () => ({ instance: null, loader: null })).instance = engine;
  setViewportHandle(null); commandBus.clearHistory();
  const entity = engine.createEntity({ name: 'Temperate valley' });
  entity.addComponent('world', { document: createWorldDocument() });
  return { engine, entity, document: () => entity.getComponent('world').props.document };
}

test('roof override survives regeneration and look changes; every undo restores the exact authored document', () => {
  const { entity, document } = fixture();
  const snapshots = [structuredClone(document())];
  authoring.setWorldRoofColor(entity.id, 'cottage', '#f0239a'); snapshots.push(structuredClone(document()));
  authoring.regenerateWorld(entity.id); snapshots.push(structuredClone(document()));
  authoring.setWorldStyle(entity.id, 'stylized'); snapshots.push(structuredClone(document()));
  assert.equal(document().edits[0].value, '#f0239a');
  assert.equal(document().settings.seed, 895);
  authoring.resetWorldRoofColor(entity.id); snapshots.push(structuredClone(document()));
  assert.equal(document().edits.length, 0);
  assert.equal(commandBus.undoStack.length, 4);
  for (let index = snapshots.length - 2; index >= 0; index--) { commandBus.undo(); assert.deepEqual(document(), snapshots[index]); }
  for (let index = 1; index < snapshots.length; index++) { commandBus.redo(); assert.deepEqual(document(), snapshots[index]); }
});

test('applying staged geography and vegetation keeps native provider edits and applies one history entry', () => {
  const { entity, document } = fixture();
  authoring.patchWorldDocument(entity.id, {
    terrainEdits: { resolution: 256, indices: [7, 15], deltas: [.25, -.375] },
    providerOverrides: { terrain: { type: 'terrain', props: { maxHeight: 100 } } },
  });
  authoring.setWorldRoofColor(entity.id, 'cottage', '#ee4020');
  const previous = structuredClone(document());
  commandBus.clearHistory();
  authoring.regenerateWorld(entity.id, { terrain: { height: 1.7 }, vegetation: { treeScale: .75 }, forestDensity: 1.5 });
  assert.equal(commandBus.undoStack.length, 1);
  assert.equal(document().settings.seed, previous.settings.seed, 'applying explicit changes keeps the seed');
  assert.equal(document().settings.terrain.height, 1.7);
  assert.equal(document().settings.geography.riverWidth, 5);
  assert.equal(document().settings.vegetation.treeScale, .75);
  for (const key of ['edits', 'providerOverrides', 'terrainEdits']) assert.deepEqual(document()[key], previous[key]);
  commandBus.undo(); assert.deepEqual(document(), previous);
});

test('no-op edits do not consume undo; invalid settings and colors leave the scene intact', () => {
  const { entity, document } = fixture();
  const before = serializeEntity(entity);
  authoring.setWorldStyle(entity.id, 'natural');
  authoring.resetWorldRoofColor(entity.id);
  assert.equal(commandBus.undoStack.length, 0);
  assert.throws(() => authoring.updateWorldSettings(entity.id, { geography: { relief: NaN } }), /finite|between/);
  assert.throws(() => authoring.setWorldRoofColor(entity.id, 'cottage', 'red'), /hex/);
  assert.throws(() => authoring.patchWorldDocument(entity.id, { version: 2 }), /version/i);
  assert.deepEqual(serializeEntity(entity), before);
  assert.equal(document().edits.length, 0);
  assert.equal(commandBus.undoStack.length, 0);
});

test('edited document round-trips through the ordinary scene serializer', () => {
  const { engine, entity } = fixture();
  authoring.setWorldRoofColor(entity.id, 'cottage', '#09a37f');
  authoring.updateWorldSettings(entity.id, { groundDensity: .5, style: 'stylized' });
  const original = serializeEntity(entity);
  engine.destroyEntity(entity);
  const restored = instantiateEntity(engine, original);
  assert.equal(restored.id, original.id);
  assert.deepEqual(serializeEntity(restored), original);
  authoring.resetWorldRoofColor(restored.id);
  commandBus.undo();
  assert.deepEqual(serializeEntity(restored), original);
});

test('only explicit World viewpoints move the native camera, including a transformed World root', () => {
  const { entity } = fixture();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(9, 8, 7);
  let changes = 0;
  const orbit = { target: new THREE.Vector3(1, 2, 3), update() {}, dispatchEvent() { changes++; } };
  setViewportHandle({ camera, orbit });
  const previous = { position: camera.position.toArray(), target: orbit.target.toArray() };
  authoring.regenerateWorld(entity.id);
  authoring.setWorldStyle(entity.id, 'stylized');
  authoring.setWorldRoofColor(entity.id, 'cottage', '#428eee');
  commandBus.undo(); commandBus.redo();
  assert.deepEqual({ position: camera.position.toArray(), target: orbit.target.toArray() }, previous);
  assert.equal(changes, 0);
  entity.setTransform({ position: [12, 4, -8], rotation: [0, .5, 0], scale: [2, 2, 2] });
  entity.object3D.updateWorldMatrix(true, false);
  const expected = entity.object3D.localToWorld(new THREE.Vector3(40, 12, 30));
  authoring.focusWorld(entity.id, 'cottage');
  assert.deepEqual(camera.position.toArray(), expected.toArray());
  assert.equal(changes, 1);
  setViewportHandle(null);
});
