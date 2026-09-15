import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { EngineCSMShadowNode } from "../src/engine/csmShadowNode.js";
import { ShadowFreezeSystem } from "../src/engine/shadowFreeze.js";
import { LightComponent } from "../src/engine/components/LightComponent.js";
import { Entity } from "../src/engine/Entity.js";
import { registerComponent } from "../src/engine/components/registry.js";

registerComponent(LightComponent);
const renderer = {
  coordinateSystem: THREE.WebGPUCoordinateSystem,
  reversedDepthBuffer: false,
};

function fixture(NodeClass = EngineCSMShadowNode, { flattened = false, reversed = false } = {}) {
  const scene = new THREE.Scene();
  const owner = new THREE.Object3D();
  owner.rotation.set(-Math.PI / 3, 0.4, 0.2);
  owner.position.set(7, -3, 4);
  owner.scale.set(1.2, 0.8, 1.6);
  scene.add(owner);
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  light.position.set(0, 0, 0);
  light.target.position.set(0, 0, -1);
  light.shadow.camera.far = 1000;
  light.shadow.mapSize.set(2048, 1024);
  owner.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 300);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  // A reversed renderer reverses every camera it renders (Renderer._updateCamera).
  camera._reversedDepth = reversed;
  camera.updateProjectionMatrix();
  camera.position.set(30, 5, 25);
  scene.add(camera);
  scene.updateMatrixWorld(true);
  if (flattened) {
    scene.attach(light);
    scene.attach(light.target);
  }
  const csm = new NodeClass(light, { cascades: 4, maxFar: 150, lightMargin: 200 });
  csm._init({ camera, renderer: reversed ? { ...renderer, reversedDepthBuffer: true } : renderer });
  light.shadow.shadowNode = csm;
  return { scene, owner, light, camera, csm };
}

function pose(f) {
  f.scene.updateMatrixWorld(true);
  f.csm.updateBefore();
  f.scene.updateMatrixWorld(true);
  for (const cascade of f.csm.lights) cascade.shadow.updateMatrices(cascade);
}

function coverage(f) {
  let maxXY = 0;
  let clipped = 0;
  for (let i = 0; i < f.csm.cascades; i++) {
    const camera = f.csm.lights[i].shadow.camera;
    for (const p of [...f.csm.frustums[i].vertices.near, ...f.csm.frustums[i].vertices.far]) {
      const clip = p.clone().applyMatrix4(f.camera.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      maxXY = Math.max(maxXY, Math.abs(clip.x), Math.abs(clip.y));
      if (Math.abs(clip.x) > 1.003 || Math.abs(clip.y) > 1.003 || Math.abs(clip.z) > 1) clipped++;
    }
  }
  return { maxXY, clipped };
}

test("rotated and scaled light parents cover the view throughout a full camera turn", () => {
  const f = fixture();
  for (let i = 0; i < 72; i++) {
    f.camera.rotation.set(0.2 * Math.sin(i), i * Math.PI / 36, 0);
    pose(f);
    assert.equal(coverage(f).clipped, 0, `camera yaw ${i * 5} degrees must remain shadowed`);
  }
  // Same geometry, old implementation: the camera/light coordinate mismatch
  // must actually break this fixture, or the test is not guarding the defect.
  const old = fixture(CSMShadowNode);
  old.camera.rotation.y = 1.2;
  pose(old);
  assert.ok(coverage(old).clipped > 0, "upstream coordinate mismatch is a failing negative control");
});

test("a reversed depth buffer keeps full cascade coverage through a camera turn", () => {
  const f = fixture(EngineCSMShadowNode, { reversed: true });
  assert.equal(f.camera.reversedDepth, true);
  assert.equal(f.csm.mainFrustum.vertices.near[0].z > f.csm.mainFrustum.vertices.far[0].z, true,
    "near vertices sit in front of far ones (frustum read with the reversed convention)");
  for (let i = 0; i < 72; i++) {
    f.camera.rotation.set(0.2 * Math.sin(i), i * Math.PI / 36, 0);
    pose(f);
    assert.equal(coverage(f).clipped, 0, `reversed: camera yaw ${i * 5} degrees must remain shadowed`);
  }
});

test("equivalent world light poses produce equivalent shadow matrices regardless of parenting", () => {
  const parented = fixture();
  const flat = fixture(EngineCSMShadowNode, { flattened: true });
  for (const yaw of [0, 0.4, 1.2, 2.7]) {
    parented.camera.rotation.y = flat.camera.rotation.y = yaw;
    pose(parented);
    pose(flat);
    for (let i = 0; i < 4; i++) {
      const a = parented.csm.lights[i].shadow.matrix.elements;
      const b = flat.csm.lights[i].shadow.matrix.elements;
      assert.ok(a.every((v, j) => Math.abs(v - b[j]) < 1e-9), `cascade ${i}, yaw ${yaw}`);
    }
  }
});

test("camera motion does not rebuild cascade bounds; projection and settings edits do", () => {
  const { csm, camera } = fixture();
  let builds = 0;
  const original = csm.updateFrustums.bind(csm);
  csm.updateFrustums = () => { builds++; original(); };
  for (let i = 0; i < 180; i++) {
    camera.position.x += 0.01;
    camera.rotation.y += 0.01;
    csm.prepare(camera);
    csm.updateBefore();
  }
  assert.equal(builds, 0, "360 pose preparations must reuse the same projection-derived bounds");
  const edits = [
    () => { camera.fov += 5; },
    () => { camera.aspect = 1; },
    () => { camera.near = 0.5; },
    () => { camera.far = 120; },
    () => { csm.maxFar = 100; },
    () => { csm.fade = true; },
    () => { csm.mode = "uniform"; },
  ];
  for (const edit of edits) {
    const before = builds;
    edit();
    camera.updateProjectionMatrix();
    csm.prepare(camera);
    csm.prepare(camera);
    assert.equal(builds, before + 1, "one settings edit rebuilds exactly once");
  }
  const other = camera.clone();
  csm.prepare(other);
  assert.equal(csm.camera, other);
  assert.equal(builds, edits.length + 1, "camera replacement refreshes even an equal projection");
});

test("custom off-axis camera projection survives lazy initialization, posing and bounds refresh", () => {
  const f = fixture();
  // This matrix cannot be reconstructed from the PerspectiveCamera fields.
  f.camera.projectionMatrix.elements[8] = 0.21;
  f.camera.projectionMatrix.elements[9] = -0.13;
  f.camera.projectionMatrixInverse.copy(f.camera.projectionMatrix).invert();
  const expected = f.camera.projectionMatrix.clone();
  const csm = new EngineCSMShadowNode(f.light, { cascades: 4, maxFar: 150 });
  csm._init({ camera: f.camera, renderer });
  assert.ok(f.camera.projectionMatrix.equals(expected));
  for (let i = 0; i < 10; i++) {
    f.camera.rotation.y += 0.1;
    csm.prepare(f.camera, { force: i === 5 });
    csm.updateBefore();
    assert.ok(f.camera.projectionMatrix.equals(expected));
  }
});

function componentFixture() {
  const callbacks = new Set();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 300);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(30, 5, 25);
  scene.add(camera);
  const engine = {
    scene, camera, settings: { shadow: { autoUpdate: true } }, playing: false,
    entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(),
    renderer: { ...renderer, backend: { isWebGPUBackend: true }, info: { frame: 0, render: { calls: 0 } } },
    emit() {}, on: () => () => {},
    onPreRender: (fn) => { callbacks.add(fn); return () => callbacks.delete(fn); },
  };
  const entity = new Entity(engine);
  scene.add(entity.object3D);
  entity.rotation.set(-Math.PI / 3, 0.4, 0);
  const component = entity.addComponent(LightComponent, {
    kind: "directional", castShadow: true, csm: true, csmMaxFar: 150,
  });
  const csm = component.light.shadow.shadowNode;
  // Shader setup performs this lazily on the first real frame.
  csm._init({ camera, renderer: engine.renderer });
  const freeze = new ShadowFreezeSystem(engine);
  function beforeRender() {
    scene.updateMatrixWorld(true);
    for (const fn of callbacks) fn();
    freeze.update();
  }
  function render() {
    csm.updateBefore();
    for (const light of csm.lights) {
      if (light.shadow.autoUpdate || light.shadow.needsUpdate) {
        light.shadow.updateMatrices(light);
        light.shadow.needsUpdate = false;
      }
    }
    engine.renderer.info.frame++;
    engine.renderer.info.render.calls++;
  }
  return { engine, csm, freeze, beforeRender, render };
}

test("production LightComponent invalidates frozen cascades on the FIRST camera rotation frame", () => {
  const f = componentFixture();
  for (let i = 0; i < 5; i++) { f.beforeRender(); f.render(); }
  assert.equal(f.freeze.frozenLights, 4, "stationary cascades must freeze");
  const previous = f.csm.lights.map((light) => light.matrixWorld.clone());
  f.engine.camera.rotation.y += 0.8;
  f.beforeRender();
  assert.equal(f.freeze.frozenLights, 0, "current view poses must invalidate before the draw");
  for (let i = 0; i < 4; i++) {
    assert.equal(f.csm.lights[i].matrixWorld.equals(previous[i]), false);
    assert.equal(f.csm.lights[i].shadow.autoUpdate, true);
  }
  const prepared = f.csm.lights.map((light) => light.matrixWorld.clone());
  f.render();
  assert.ok(f.csm.lights.every((light, i) => light.matrixWorld.equals(prepared[i])),
    "render must use exactly the pose whose inputs were fingerprinted");
  for (let i = 0; i < 4; i++) { f.beforeRender(); f.render(); }
  assert.equal(f.freeze.frozenLights, 4, "the map must freeze again after motion stops");
});

// 09-14 "why does our grass no longer cast shadows — it got super flat": the
// cascades share a slab of maxFar + both margins, and three applies bias in
// normalized depth, so the raw bias grew with that slab until it swallowed
// every shadow shorter than itself. Grass blades are 18 cm.
test("cascade bias keeps grass-height contact shadows in a deep CSM slab", () => {
  const f = componentFixture();
  for (let i = 0; i < 4; i++) { f.beforeRender(); f.render(); }
  const authored = f.csm.light.shadow.bias;
  const near = f.csm.lights[0].shadow;
  const depth = near.camera.far - near.camera.near;
  assert.ok(Math.abs(authored) * depth > 0.18,
    `negative control: the raw bias over this ${depth} m slab (${Math.abs(authored) * depth} m) would hide grass`);
  const worldBias = -near.bias * depth;
  assert.ok(worldBias > 0 && worldBias < 0.18, `nearest cascade world bias ${worldBias} m`);
  for (const light of f.csm.lights) {
    const s = light.shadow;
    const texel = (s.camera.right - s.camera.left) / s.mapSize.width;
    assert.ok(-s.bias * (s.camera.far - s.camera.near) >= texel * 1.5 - 1e-9, "never below the acne floor");
  }
});

test("the old bounds-only preRender leaves every cascade frozen on the first rotation frame", () => {
  const f = componentFixture();
  // Execute the former division of work: the component updates only frustums,
  // while Three waits until the draw to change the cascade poses.
  f.csm.prepare = function (camera) { this.camera = camera; this.updateFrustums(); };
  f.csm.updateBefore = CSMShadowNode.prototype.updateBefore;
  for (let i = 0; i < 6; i++) { f.beforeRender(); f.render(); }
  assert.equal(f.freeze.frozenLights, 4);
  f.engine.camera.rotation.y += 0.8;
  f.beforeRender();
  assert.equal(f.freeze.frozenLights, 4, "negative control must reproduce the stale first-frame receipt");
});

test("preparing before lazy setup leaves camera unset and authored freeze flags survive posing", () => {
  const light = new THREE.DirectionalLight();
  const csm = new EngineCSMShadowNode(light);
  csm.prepare(new THREE.PerspectiveCamera());
  assert.equal(csm.camera, null, "setup's initialization condition must survive preRender");
  const f = fixture();
  for (const cascade of f.csm.lights) {
    cascade.shadow.autoUpdate = false;
    cascade.shadow.needsUpdate = false;
  }
  f.csm.prepare(f.camera);
  assert.ok(f.csm.lights.every((cascade) => !cascade.shadow.autoUpdate && !cascade.shadow.needsUpdate));
});
