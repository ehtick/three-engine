import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { shadow } from "three/tsl";
import { ClipmapShadowNode } from "../src/engine/clipmapShadowNode.js";
import { ShadowFreezeSystem } from "../src/engine/shadowFreeze.js";

function fixture({ transformed = false, flattened = false, reversed = false, ...options } = {}) {
  const scene = new THREE.Scene();
  const parent = new THREE.Object3D();
  if (transformed) {
    parent.position.set(7, -3, 4);
    parent.rotation.set(-1.2, 0.3, 0.2);
    parent.scale.set(1.2, 0.8, 1.6);
  }
  scene.add(parent);
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  light.position.set(0, 0, 0);
  light.target.position.set(0, 0, -1);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 720;
  light.shadow.mapSize.set(512, 512);
  parent.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 300);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  // A reversed renderer reverses every camera it renders (Renderer._updateCamera).
  camera._reversedDepth = reversed;
  camera.updateProjectionMatrix();
  scene.add(camera);
  scene.updateMatrixWorld(true);
  if (flattened) { scene.attach(light); scene.attach(light.target); }
  const renderer = { coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: reversed, info: { render: { calls: 0 } } };
  const clipmap = new ClipmapShadowNode(light, { levels: 3, nearSize: 20, scale: 4, cache: false, ...options });
  light.shadow.shadowNode = clipmap;
  clipmap._init({ camera, renderer });
  const engine = { scene, camera, renderer, settings: { shadow: { autoUpdate: true } } };
  const freeze = new ShadowFreezeSystem(engine);
  const pose = () => {
    clipmap.prepare(camera);
    for (const level of clipmap.lights) level.shadow.updateMatrices(level);
  };
  pose();
  return { scene, parent, light, camera, clipmap, engine, freeze, pose };
}

const matrices = (clipmap) => clipmap.lights.map((light) => [...light.matrixWorld.elements, ...light.target.matrixWorld.elements, ...light.shadow.camera.projectionMatrix.elements]);

test("a full camera turn and arbitrary projection edits leave every clipmap matrix byte-identical", () => {
  const f = fixture({ transformed: true });
  const before = matrices(f.clipmap);
  const shadowBefore = f.clipmap.lights.map((level) => level.shadow.matrix.toArray());
  for (let i = 0; i < 72; i++) {
    f.camera.rotation.set(Math.sin(i) * 0.4, i * Math.PI / 36, Math.cos(i) * 0.2);
    f.camera.fov = 30 + i;
    f.camera.near = 0.02 + i / 100;
    f.camera.far = 400 + i * 10;
    f.camera.updateProjectionMatrix();
    f.pose();
    assert.deepEqual(matrices(f.clipmap), before);
    assert.deepEqual(f.clipmap.lights.map((level) => level.shadow.matrix.toArray()), shadowBefore);
  }
});

test("a reversed depth buffer changes no clipmap matrix and keeps them turn-invariant", () => {
  const standard = fixture({ transformed: true });
  const f = fixture({ transformed: true, reversed: true });
  assert.equal(f.camera.reversedDepth, true);
  const before = matrices(f.clipmap);
  assert.deepEqual(before, matrices(standard.clipmap), "light-space grids do not depend on the depth convention");
  for (let i = 0; i < 36; i++) {
    f.camera.rotation.set(Math.sin(i) * 0.4, i * Math.PI / 18, 0);
    f.camera.updateProjectionMatrix();
    f.pose();
    assert.deepEqual(matrices(f.clipmap), before);
  }
});

test("sub-texel translation holds; crossing the near cell changes only that level", () => {
  const f = fixture();
  const before = matrices(f.clipmap);
  const texel = 20 / 512;
  f.camera.position.x = texel * 0.2;
  f.pose();
  assert.deepEqual(matrices(f.clipmap), before);
  f.camera.position.x = texel * 0.6;
  f.pose();
  const moved = matrices(f.clipmap);
  assert.notDeepEqual(moved[0], before[0]);
  assert.deepEqual(moved.slice(1), before.slice(1), "coarse maps hold their larger texel cells");
  f.camera.position.z = 0.9;
  f.pose();
  assert.deepEqual(matrices(f.clipmap), moved, "depth holds inside the shared 2.5 m cell");
  f.camera.position.z = 1.3;
  f.pose();
  assert.ok(matrices(f.clipmap).every((matrix, i) => matrix.some((v, j) => v !== moved[i][j])));
});

test("equivalent world light poses produce equivalent maps under rotated, scaled and translated parents", () => {
  const a = fixture({ transformed: true });
  const b = fixture({ transformed: true, flattened: true });
  for (const position of [[0, 0, 0], [15, -3, 24], [-42, 30, 11]]) {
    a.camera.position.set(...position);
    b.camera.position.set(...position);
    a.pose(); b.pose();
    for (let i = 0; i < 3; i++) {
      const x = a.clipmap.lights[i].shadow.matrix.elements;
      const y = b.clipmap.lights[i].shadow.matrix.elements;
      assert.ok(x.every((v, j) => Math.abs(v - y[j]) < 1e-8));
    }
  }
});

test("the finest containing map wins independently of view direction and behind-camera positions", () => {
  const f = fixture();
  assert.deepEqual(f.clipmap.getLevelWeights(new THREE.Vector3(0, 0, 0)), [1, 0, 0, 0]);
  assert.deepEqual(f.clipmap.getLevelWeights(new THREE.Vector3(20, 0, 0)), [0, 1, 0, 0]);
  assert.deepEqual(f.clipmap.getLevelWeights(new THREE.Vector3(80, 0, 0)), [0, 0, 1, 0]);
  assert.deepEqual(f.clipmap.getLevelWeights(new THREE.Vector3(180, 0, 0)), [0, 0, 0, 1]);
  assert.deepEqual(f.clipmap.getLevelWeights(new THREE.Vector3(0, 0, 400)), [0, 0, 0, 1]);
  const points = [new THREE.Vector3(20, 0, 30), new THREE.Vector3(-20, 0, -30), new THREE.Vector3(6, 5, 0)];
  const before = points.map((p) => f.clipmap.getLevelWeights(p));
  f.camera.rotation.y = Math.PI;
  f.pose();
  assert.deepEqual(points.map((p) => f.clipmap.getLevelWeights(p)), before);
});

test("overlap and outer fade stay continuous, bounded and normalized", () => {
  const f = fixture();
  let previous = f.clipmap.getLevelWeights(new THREE.Vector3(0, 0, 0));
  let blended = 0;
  for (let x = 0.05; x <= 180; x += 0.05) {
    const weights = f.clipmap.getLevelWeights(new THREE.Vector3(x, 0, 0));
    assert.ok(weights.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    assert.ok(weights.filter((value) => value > 0).length <= 2, "only adjacent maps blend across planar borders");
    assert.ok(weights.every((value, i) => Math.abs(value - previous[i]) < 0.06), "no abrupt level or outer-edge pop");
    if (weights.filter((value) => value > 0).length === 2) blended++;
    previous = weights;
  }
  assert.ok(blended > 100, "the test crosses actual blend bands");
});

test("ShadowFreeze can keep all native maps frozen through camera rotation, then invalidates a moved level", () => {
  const f = fixture({ createLevelShadowNode: (light, lightShadow) => shadow(light, lightShadow) });
  const frame = () => {
    f.clipmap.prepare(f.camera);
    f.freeze.update();
    for (const level of f.clipmap.lights) if (level.shadow.autoUpdate) level.shadow.updateMatrices(level);
    f.engine.renderer.info.render.calls++;
  };
  for (let i = 0; i < 4; i++) frame();
  assert.equal(f.freeze.frozenLights, 3);
  for (let i = 0; i < 40; i++) {
    f.camera.rotation.y += 0.1;
    frame();
    assert.equal(f.freeze.frozenLights, 3);
  }
  f.camera.position.x = 20 / 512 * 0.6;
  frame();
  assert.equal(f.freeze.frozenLights, 2);
  assert.equal(f.clipmap.lights[0].shadow.autoUpdate, true);
});

test("cache controls share one coordinator, invalidate every level and retain native map ownership", () => {
  const f = fixture({ cache: true });
  assert.equal(f.clipmap.isClipmapShadowNode, true);
  assert.ok(f.clipmap._shadowNodes.every((node) => node.cache === f.clipmap.cache && node.cacheEnabled));
  assert.ok(f.clipmap.lights.every((light) => light.shadow.clipmapCacheOwned === true));
  for (const node of f.clipmap._shadowNodes) {
    node._combinedReceipt = ["old"];
    node._staticReceipt = ["old"];
  }
  const before = f.clipmap.cache.generation;
  f.clipmap.cacheEnabled = false;
  assert.equal(f.clipmap.cache.generation, before + 1);
  assert.ok(f.clipmap._shadowNodes.every((node) => !node.cacheEnabled && node._combinedReceipt === null && node._staticReceipt === null));
  f.clipmap.cacheEnabled = true;
  assert.ok(f.clipmap._shadowNodes.every((node) => node.cacheEnabled));
});

test("level node hooks preserve shared coordinator access and release every owned node", () => {
  const constructed = [];
  const disposed = [];
  const prepared = [];
  const f = fixture({
    createLevelShadowNode: (light, lightShadow, index, node) => {
      constructed.push({ light, lightShadow, index, node });
      return { dispose() { disposed.push(index); } };
    },
    beforePrepare: (camera, node) => { prepared.push({ camera, node }); },
  });
  assert.equal(constructed.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(constructed[i].light, f.clipmap.lights[i]);
    assert.equal(constructed[i].lightShadow, f.clipmap.lights[i].shadow);
    assert.equal(constructed[i].node, f.clipmap);
  }
  assert.ok(prepared.every(({ camera, node }) => camera === f.camera && node === f.clipmap));
  f.clipmap.dispose();
  assert.deepEqual(disposed, [0, 1, 2]);
  assert.ok(f.clipmap.lights.every((light) => light.parent === null && light.target.parent === null));
});
