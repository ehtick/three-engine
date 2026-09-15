import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { EngineCSMShadowNode, csmCascadeCasts, renderWithCascadeCasters, cascadeReceiverRange, shadowReach } from "../src/engine/csmShadowNode.js";
import { foliageShadowCasterRanges, foliageLodThresholds, foliageShadowFar } from "../src/modules/foliage/foliageLod.js";

// 09-14 owner: "we must never see shadows suddenly appearing / disappearing".
// A caster stays in a cascade whenever a shadow it can cast may land on a
// receiver that cascade shades; the first cut (a per-tier table) dropped a 1.6×
// "near" tree at 45 m from cascade 1 and its shadow popped.

function fakeCsm({ breaks = [.064, .1195, 1], maxFar = 500, fov = 60, aspect = 1.43 } = {}) {
  const camera = new THREE.PerspectiveCamera(fov, aspect, .1, 1000);
  const lights = breaks.map((_, i) => ({ shadow: { camera: { left: -(20 * 4 ** i), right: 20 * 4 ** i }, mapSize: { width: 2048 } } }));
  return { camera, breaks, maxFar, lights };
}
const sun = new THREE.Vector3(.1, -.98, .1).normalize();
const reach = height => shadowReach(height, sun);
const mesh = (range, height) => ({ userData: { shadowCasterRange: range, shadowCasterHeight: height } });

test("receiver ranges cover each cascade's depth slice out to its frustum corner, with the fade", () => {
  const csm = fakeCsm();
  const c0 = cascadeReceiverRange(csm, 0), c1 = cascadeReceiverRange(csm, 1), c2 = cascadeReceiverRange(csm, 2);
  assert.equal(c0.near, 0);
  assert.ok(c0.far > .064 * 500, "the corner ray reaches past the split depth");
  assert.ok(c1.near < .064 * 500 && c1.far > .1195 * 500);
  assert.ok(c2.near < .1195 * 500 && c2.far >= 500);
  assert.ok(c0.far >= c1.near && c1.far >= c2.near, "consecutive cascades overlap, never leave a gap");
});

test("the tier table's failure: a 1.6x near-tier tree at 45 m stays in cascade 1", () => {
  const props = { lodNear: 25, lodFar: 90, maxDistance: 420, shadowFar: 50 };
  const { near, far, end } = foliageLodThresholds(props);
  const ranges = foliageShadowCasterRanges({ near, far, end, shadowFar: foliageShadowFar(props) }, .78, 1.6, 1);
  assert.ok(ranges[0][1] >= 45, `near tier reaches ${ranges[0][1]} m at scale 1.6`);
  const csm = fakeCsm();
  assert.equal(csmCascadeCasts(mesh(ranges[0], 13 * 1.6), cascadeReceiverRange(csm, 1), reach), true);
  assert.ok(ranges[1][1] >= 80, `mid tier reaches ${ranges[1][1]} m`);
  assert.equal(csmCascadeCasts(mesh(ranges[1], 13 * 1.6), cascadeReceiverRange(csm, 2), reach), true);
});

test("a caster whose shadow cannot reach a cascade's receivers is skipped; a low sun keeps it", () => {
  const csm = fakeCsm();
  const nearOnly = mesh([0, 20], 5);
  assert.equal(csmCascadeCasts(nearOnly, cascadeReceiverRange(csm, 2), reach), false);
  const lowSun = new THREE.Vector3(1, -.08, 0).normalize();
  assert.equal(csmCascadeCasts(nearOnly, cascadeReceiverRange(csm, 2), h => shadowReach(h, lowSun)), true, "a long evening shadow reaches far");
  assert.equal(csmCascadeCasts(mesh([200, 400], 10), cascadeReceiverRange(csm, 0), reach), false);
});

test("sub-texel casters are the only size-based skip; unpublished meshes always draw", () => {
  const csm = fakeCsm();
  const blade = mesh([0, 60], .3);
  assert.equal(csmCascadeCasts(blade, cascadeReceiverRange(csm, 0), reach), true);
  const far = cascadeReceiverRange(csm, 2);
  assert.ok(far.texel > .3, `far texel ${far.texel}`);
  assert.equal(csmCascadeCasts(blade, far, reach), false);
  assert.equal(csmCascadeCasts(new THREE.Mesh(), far, reach), true);
  globalThis.__csmCascadeCasters = false;
  try { assert.equal(csmCascadeCasts(mesh([0, 1], 1), far, reach), true); }
  finally { delete globalThis.__csmCascadeCasters; }
});

test("mid tier covers out to the end while its impostor is still ramping in", () => {
  const ranges = foliageShadowCasterRanges({ near: 25, far: 90, end: 420, shadowFar: 50 }, 1, 1, .5);
  assert.ok(ranges[1][1] >= 420);
});

test("the filter wraps the pass's render-object function and restores it", () => {
  const drawn = [];
  const shadowFn = (object) => drawn.push(object.name);
  let current = shadowFn;
  const renderer = { getRenderObjectFunction: () => current, setRenderObjectFunction: (fn) => { current = fn; } };
  const receivers = { near: 60, far: 700, texel: .3 };
  const objects = [
    Object.assign(new THREE.Mesh(), { name: "rock" }),
    Object.assign(mesh([0, 20], 5), { name: "near" }),
    Object.assign(mesh([50, 420], 13), { name: "impostor" }),
    Object.assign(mesh([0, 60], .25), { name: "grass" }),
  ];
  renderWithCascadeCasters(renderer, receivers, reach, () => { for (const o of objects) current(o, null, null); });
  assert.deepEqual(drawn, ["rock", "impostor"]);
  assert.equal(current, shadowFn);
});

test("lazy CSM setup installs the filter on every cascade's shadow node", () => {
  const light = new THREE.DirectionalLight();
  const owner = new THREE.Object3D();
  owner.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 500);
  const csm = new EngineCSMShadowNode(light, { cascades: 3, maxFar: 500 });
  csm._init({ camera, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: false } });
  assert.equal(csm._shadowNodes.length, 3);
  for (const node of csm._shadowNodes) assert.equal(node.__cascadeCasters, true);
  assert.ok(cascadeReceiverRange(csm, 0), "a real CSM node yields receiver ranges");
});

test("lazy CSM setup installs the filter under a reversed depth buffer too", () => {
  const light = new THREE.DirectionalLight();
  const owner = new THREE.Object3D();
  owner.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 500);
  camera._reversedDepth = true; // what a reversed renderer does to every camera
  camera.updateProjectionMatrix();
  const csm = new EngineCSMShadowNode(light, { cascades: 3, maxFar: 500 });
  csm._init({ camera, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: true } });
  assert.equal(csm._shadowNodes.length, 3);
  for (const node of csm._shadowNodes) assert.equal(node.__cascadeCasters, true);
  const range = cascadeReceiverRange(csm, 0);
  assert.ok(range, "a reversed CSM node yields receiver ranges");
});
