import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import Textures from '../node_modules/three/src/renderers/common/Textures.js';
import Info from '../node_modules/three/src/renderers/common/Info.js';
import DataMap from '../node_modules/three/src/renderers/common/DataMap.js';
import { installShadowNodeGuard } from '../src/engine/shadowNodeGuard.js';

installShadowNodeGuard();

function fixture() {
  const backend = new DataMap(), allocations = [], destroyed = [];
  Object.assign(backend, {
    isWebGPUBackend: true,
    createTexture(texture) {
      const gpu = { texture, retired: false }; allocations.push(gpu);
      this.get(texture).texture = gpu;
    },
    destroyTexture(texture) {
      const gpu = this.get(texture).texture;
      if (gpu) { gpu.retired = true; destroyed.push(gpu); }
      this.delete(texture);
    },
  });
  const renderer = {
    backend, info: new Info(), shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    hasCompatibility: () => true, reversedDepthBuffer: false,
  };
  renderer._textures = new Textures(renderer, backend, renderer.info);
  const light = new THREE.DirectionalLight(); light.castShadow = true;
  light.shadow.mapSize.set(64, 64);
  const builder = {
    renderer, camera: new THREE.PerspectiveCamera(), material: new THREE.MeshStandardNodeMaterial(), context: {},
    createRenderTarget: (width, height, options) => new THREE.RenderTarget(width, height, options),
  };
  const node = new THREE.ShadowNode(light);
  return { renderer, backend, allocations, destroyed, builder, node, light };
}

function receiverBeforeFirstShadow({ old = false } = {}) {
  const previous = globalThis.__shadowTargetInitialization;
  globalThis.__shadowTargetInitialization = !old;
  const f = fixture();
  try {
    const autoUpdate = f.light.shadow.autoUpdate, needsUpdate = f.light.shadow.needsUpdate;
    f.node.setupShadow(f.builder);
    assert.equal(f.light.shadow.autoUpdate, autoUpdate);
    assert.equal(f.light.shadow.needsUpdate, needsUpdate);
    const map = f.node.shadowMap, depth = map.depthTexture;
    // The native binding path may run before the first native shadow draw.
    f.renderer._textures.updateTexture(depth);
    const bound = f.backend.get(depth).texture, version = depth.version;
    // Three's first target initialization sets dimensions/samples, increments
    // the depth version, and replaces any pre-existing sampled allocation.
    f.renderer._textures.updateRenderTarget(map);
    return { ...f, bound, live: f.backend.get(depth).texture, version, depth };
  } finally { globalThis.__shadowTargetInitialization = previous; }
}

test('native shadow target initialization preserves receiver bindings before first shadow render', () => {
  const f = receiverBeforeFirstShadow();
  assert.equal(f.bound, f.live, 'the receiver still binds the current GPU depth allocation');
  assert.equal(f.bound.retired, false);
  assert.equal(f.depth.version, f.version, 'first rendering requires no texture generation change');
  assert.equal(f.allocations.length, 2, 'one native color and one native depth allocation');
  assert.equal(f.destroyed.length, 0, 'initialization performs no retirement or replacement');
  for (let i = 0; i < 4; i++) f.renderer._textures.updateRenderTarget(f.node.shadowMap);
  assert.equal(f.allocations.length, 2, 'stationary rendering never reallocates');
  f.node.dispose();
  assert.equal(f.destroyed.length, 2, 'normal native disposal releases both owned attachments once');
  f.node.dispose(); assert.equal(f.destroyed.length, 2);
});

test('negative control reproduces the retired version-zero shadow allocation', () => {
  const f = receiverBeforeFirstShadow({ old: true });
  assert.equal(f.version, 0);
  assert.equal(f.depth.version, 2);
  assert.notEqual(f.bound, f.live);
  assert.equal(f.bound.retired, true, 'an unchanged receiver would submit this destroyed texture');
  assert.equal(f.allocations.length, 3, 'the original path allocates the depth image twice');
  f.node.dispose();
});

test('independent suns retain independent native targets across scene retirement', () => {
  const a = receiverBeforeFirstShadow(), b = receiverBeforeFirstShadow();
  assert.notEqual(a.live, b.live);
  a.node.dispose();
  assert.equal(a.live.retired, true);
  assert.equal(b.live.retired, false);
  b.renderer._textures.updateRenderTarget(b.node.shadowMap);
  assert.equal(b.backend.get(b.depth).texture, b.live);
  assert.equal(b.allocations.length, 2);
  b.node.dispose();
});
