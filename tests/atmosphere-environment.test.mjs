import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { prepareSkyEnvironment } from '../src/modules/atmosphere/prepareSkyEnvironment.js';

function fixture() {
  const texture = new THREE.Texture();
  texture.needsPMREMUpdate = true;
  const renderer = { _pipelines: { __asyncRenderPipelines: { active: false } } };
  const scene = new THREE.Scene();
  scene.environment = texture;
  const engine = { renderer, scene };
  const cache = THREE.EnvironmentNode.prototype._getPMREMNodeCache(renderer);
  const calls = [];
  const node = {
    value: texture, _pmrem: new THREE.Texture(), _generator: {},
    updateBefore(frame) { calls.push({ frame, node: this, version: this.value.pmremVersion }); },
  };
  cache.set(texture, node);
  return { engine, renderer, scene, texture, cache, node, calls };
}

test('changed sky flushes its actual cached node once per source version outside the main scope', () => {
  const f = fixture();
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].node, f.node);
  assert.deepEqual(f.calls[0].frame, { renderer: f.renderer });
  assert.equal(f.node._pmrem.pmremVersion, 0, 'native output texture version need not follow its private render target');
  for (let frame = 0; frame < 10; frame++) assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  assert.equal(f.calls.length, 1, 'the private output-texture version cannot cause per-frame updates');
  f.texture.needsUpdate = true;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false, 'ordinary source upload is not a PMREM publication');
  f.texture.needsPMREMUpdate = true;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.renderer._pipelines.__asyncRenderPipelines.active, false);
});

test('first creation and an already-current native PMREM never get eagerly compiled', () => {
  const f = fixture();
  f.cache.delete(f.texture);
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  assert.equal(f.cache.has(f.texture), false, 'a missing node stays missing');
  f.cache.set(f.texture, f.node);
  const pmrem = f.node._pmrem, generator = f.node._generator;
  f.node._pmrem = null;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  f.node._pmrem = pmrem; f.node._generator = null;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  f.node._generator = generator; pmrem.pmremVersion = f.texture.pmremVersion;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  assert.equal(f.calls.length, 0);
});

test('foreign environments, GI overrides, absent renderers and suspended/main-render work are untouched', () => {
  for (const change of [
    f => { f.engine.renderer = null; },
    f => { f.engine.scene = null; },
    f => { f.scene.environment = new THREE.Texture(); },
    f => { f.scene.environmentNode = { isNode: true }; },
    f => { f.engine.simulationSuspended = true; },
    f => { f.engine.rendererReady = false; },
    f => { f.renderer._pipelines.__asyncRenderPipelines.active = true; },
    f => { f.node.value = new THREE.Texture(); },
  ]) {
    const f = fixture(); change(f);
    assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(prepareSkyEnvironment(null, null), false);
  const f = fixture();
  assert.equal(prepareSkyEnvironment(f.engine, null), false);
});

test('native update errors retain their identity and leave the source eligible for retry', () => {
  const f = fixture(), error = new Error('native PMREM failed'), update = f.node.updateBefore;
  f.node.updateBefore = () => { throw error; };
  assert.throws(() => prepareSkyEnvironment(f.engine, f.texture), cause => cause === error);
  assert.equal(f.texture.pmremVersion, 1, 'failure does not mark the source clean or bump its version');
  f.node.updateBefore = update;
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), true, 'the same version retries after failure');
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), false);
  assert.equal(f.calls.length, 1);
});

test('receipts follow the actual source object and each renderer has its own native node', () => {
  const f = fixture(), other = fixture();
  assert.equal(prepareSkyEnvironment(f.engine, f.texture), true);
  other.scene.environment = f.texture;
  other.node.value = f.texture;
  other.cache.set(f.texture, other.node);
  assert.equal(prepareSkyEnvironment(other.engine, f.texture), true);
  assert.equal(other.calls.length, 1, 'another renderer cannot borrow the first renderer\'s receipt');
  const replacement = new THREE.Texture(); replacement.needsPMREMUpdate = true;
  f.scene.environment = replacement; f.node.value = replacement; f.cache.set(replacement, f.node);
  assert.equal(replacement.pmremVersion, f.texture.pmremVersion);
  assert.equal(prepareSkyEnvironment(f.engine, replacement), true, 'same version on a new source still refreshes a reused node');
  assert.equal(f.calls.length, 2);
});
