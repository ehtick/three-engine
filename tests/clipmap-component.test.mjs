import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { PCFShadowFilter } from "three/tsl";
import { LightComponent } from "../src/engine/components/LightComponent.js";
import { ClipmapShadowNode } from "../src/engine/clipmapShadowNode.js";
import { EngineCSMShadowNode } from "../src/engine/csmShadowNode.js";
import { Entity } from "../src/engine/Entity.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { serializeEntity, instantiateEntity } from "../src/engine/serialize.js";
import { SHADOW_PROXY_LAYER } from "../src/engine/editorLayers.js";

registerComponent(LightComponent);

function makeEngine({ webgpu = true } = {}) {
  const callbacks = new Set();
  const listeners = new Map();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 500);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(10, 5, 20);
  scene.add(camera);
  const engine = {
    playing: false, entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(),
    scene, camera, settings: { shadow: { autoUpdate: true } },
    renderer: {
      coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: false,
      backend: { isWebGPUBackend: webgpu }, info: { frame: 0, render: { calls: 0 } },
    },
    emit(event, payload) { for (const fn of listeners.get(event) ?? []) fn(payload); },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    onPreRender(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
    createEntity({ id, name, parent } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      if (parent) {
        entity.parent = parent;
        parent.children.push(entity);
        parent.object3D.add(entity.object3D);
      } else {
        engine.rootEntities.push(entity);
        scene.add(entity.object3D);
      }
      return entity;
    },
    frame() {
      scene.updateMatrixWorld(true);
      for (const fn of callbacks) fn();
      engine.renderer.info.frame++;
      engine.renderer.info.render.calls++;
    },
  };
  return engine;
}

function makeLight(props = {}, options = {}) {
  const engine = makeEngine(options);
  const entity = engine.createEntity({ name: "Sun" });
  entity.rotation.set(-Math.PI / 3, 0.4, 0);
  const component = entity.addComponent(LightComponent, { kind: "directional", castShadow: true, shadowMode: "clipmap", ...props });
  engine.frame();
  return { engine, entity, component, node: component.light.shadow?.shadowNode };
}

test("directional shadow mode selects clipmaps independently of the saved CSM flag", () => {
  for (const csm of [false, true]) {
    const f = makeLight({ csm });
    assert.ok(f.node instanceof ClipmapShadowNode);
    assert.equal(f.node.levels, 3);
    assert.equal(f.node.cacheEnabled, true);
    assert.deepEqual(f.node.lights.map((light) => light.shadow.camera.right * 2), [20, 80, 320]);
    assert.equal(f.component.light.userData.giShadowMode, "map");
  }
  assert.ok(makeLight({ shadowMode: "map", csm: true }).node instanceof EngineCSMShadowNode);
  assert.equal(makeLight({ shadowMode: "map", csm: false }).node, undefined);
});

test("local lights and a WebGL renderer retain native maps for authored clipmap mode", () => {
  for (const kind of ["point", "spot"]) {
    const f = makeLight({ kind, csm: true });
    assert.equal(f.node, undefined);
    assert.equal(f.component.props.shadowMode, "clipmap", "fallback must not rewrite saved data");
    assert.equal(f.component.light.castShadow, true);
    assert.equal(f.component.light.userData.giShadowMode, "map");
    assert.equal(f.component.light.shadow.mapSize.width, 2048);
  }
  const fallback = makeLight({}, { webgpu: false });
  assert.equal(fallback.node, undefined);
  // 09-14: a plain directional map's slab reaches ≥ 2× its half-size UP-SUN
  // plus its half-size past the viewer (never less than the authored far) —
  // a far-equals-shadowCamFar slab centred on the viewer clipped casters above
  // the viewer and made shadows pop as the camera moved.
  const { shadowCamFar, shadowCamSize } = fallback.component.props;
  assert.equal(fallback.component.light.shadow.camera.far, Math.max(shadowCamFar, shadowCamSize * 2) + shadowCamSize);
});

test("⛔ a plain directional map keeps up-sun casters: the viewer sits ≥ 2× half-size deep in the slab", () => {
  // 09-14 "shadows in frustum appear and disappear as I move the camera": the
  // slab was centred on the viewer, so a ridge of trees > far/2 up-sun sat in
  // front of the near plane, cast nothing, and popped as the viewer moved.
  // The user's scene values: with the defaults the authored far dominates and
  // a viewer-centred slab also passes (the first cut of this gate was blind).
  const { engine, component } = makeLight({ shadowMode: "map", csm: false, shadowCamSize: 100, shadowCamFar: 100 });
  engine.frame();
  const { shadowCamSize: size } = component.props;
  const light = component.light;
  const lightWorld = light.getWorldPosition(new THREE.Vector3());
  const direction = light.target.getWorldPosition(new THREE.Vector3()).sub(lightWorld).normalize();
  const viewerDepth = engine.camera.getWorldPosition(new THREE.Vector3()).sub(lightWorld).dot(direction);
  const tolerance = size * 0.1; // the depth axis is snapped to the recentre grid
  assert.ok(viewerDepth >= size * 2 - tolerance, `casters need ≥ ${size * 2} m up-sun, got ${viewerDepth.toFixed(2)}`);
  assert.ok(light.shadow.camera.far - viewerDepth >= size - tolerance, "receivers keep the map's half-size past the viewer");
});

test("GI sees one combined sampled map per level, ordered near to far", () => {
  const { component, node } = makeLight();
  for (let i = 0; i < node.levels; i++) {
    node.lights[i].shadow.map = { name: `combined-${i}` };
    node._shadowNodes[i]._staticMap = { name: `static-${i}` };
  }
  const maps = component.light.userData.giShadowMaps();
  assert.deepEqual(maps, node.lights.map((light) => light.shadow));
  assert.deepEqual(maps.map((map) => map.map.name), ["combined-0", "combined-1", "combined-2"]);
  assert.ok(maps.every((map, i) => map === node._shadowNodes[i].shadow && map.map !== node._shadowNodes[i]._staticMap));
});

test("castShadow off releases level nodes and cache maps, and on recreates them on the same light", () => {
  const { engine, component, node } = makeLight();
  const light = component.light;
  const disposed = [];
  const depthsDisposed = [];
  for (let i = 0; i < node.levels; i++) {
    const target = new THREE.RenderTarget(16, 16);
    target.depthTexture = new THREE.DepthTexture(16, 16);
    target.textures.length = 0;
    target.addEventListener("dispose", () => disposed.push(i));
    target.depthTexture.addEventListener("dispose", () => depthsDisposed.push(i));
    node._shadowNodes[i]._staticMap = target;
  }
  component.setProp("castShadow", false);
  assert.equal(component.light, light);
  assert.equal(light.shadow.shadowNode, undefined);
  assert.deepEqual(light.userData.giShadowMaps(), []);
  assert.ok(node.lights.every((level) => level.parent === null && level.target.parent === null));
  assert.deepEqual(disposed, [0, 1, 2]);
  assert.deepEqual(depthsDisposed, [0, 1, 2]);
  engine.frame();
  component.setProp("castShadow", true);
  assert.equal(component.light, light);
  assert.ok(light.shadow.shadowNode instanceof ClipmapShadowNode);
  assert.notEqual(light.shadow.shadowNode, node);
  assert.equal(light.userData.giShadowMaps().length, 3);
});

test("coverage, depth padding and cache edits preserve the node; level count rebuilds it", () => {
  const { engine, component, node } = makeLight();
  const light = component.light;
  component.setProp("clipmapNearSize", 12);
  component.setProp("clipmapScale", 3);
  component.setProp("clipmapLightMargin", 50);
  component.setProp("clipmapCache", false);
  assert.equal(component.light, light);
  assert.equal(component.light.shadow.shadowNode, node);
  assert.deepEqual(node.lights.map((level) => level.shadow.camera.right * 2), [12, 36, 108]);
  assert.ok(node.lights.every((level) => level.shadow.camera.far === 208));
  assert.equal(node.cacheEnabled, false);
  assert.ok(node._shadowNodes.every((level) => level.cacheEnabled === false));
  engine.frame();
  component.setProp("clipmapLevels", 4);
  const replacement = component.light.shadow.shadowNode;
  assert.notEqual(replacement, node);
  assert.equal(replacement.levels, 4);
  assert.equal(replacement.cacheEnabled, false);
  assert.ok(node.lights.every((level) => level.parent === null));
});

test("map dimensions, depth range, biases and PCF radius reach every level without rebuilding", () => {
  const { engine, component, node } = makeLight();
  for (const [key, value] of Object.entries({
    shadowMapWidth: 1024, shadowMapHeight: 768, shadowCamNear: 2, shadowCamFar: 900,
    shadowBias: -0.001, shadowNormalBias: 0.04, shadowRadius: 3.25,
  })) component.setProp(key, value);
  engine.frame();
  assert.equal(component.light.shadow.shadowNode, node);
  for (const level of node.lights) {
    const s = level.shadow;
    assert.deepEqual(s.mapSize.toArray(), [1024, 768]);
    assert.equal(s.camera.near, 2);
    assert.equal(s.camera.far, 900);
    const texel = (s.camera.right - s.camera.left) / 1024;
    // Bias keeps the authored world size (|bias| × (far − near)), or a coarse
    // level's texel needs, whichever is larger.
    assert.ok(Math.abs(-s.bias * (s.camera.far - s.camera.near) - Math.max(0.001 * 898, texel * 1.5)) < 1e-9);
    assert.equal(s.normalBias, Math.max(0.04, texel));
    assert.equal(s.radius, 3.25);
    assert.equal(s.filterNode, PCFShadowFilter);
    assert.ok(s.camera.layers.isEnabled(SHADOW_PROXY_LAYER));
  }
});

// 09-14 "why does our grass no longer cast shadows — it got super flat": four
// levels share a 1680 m slab, and the raw -0.0005 bias was 84 cm of it, which
// swallowed every shadow shorter than that. Grass blades are 18 cm.
test("a deep clipmap slab keeps the authored bias's world size near the viewer", () => {
  const { engine, node } = makeLight({ clipmapLevels: 4, shadowBias: -0.0005, shadowCamNear: 0.1,
    shadowCamFar: 100, shadowMapWidth: 2048, shadowMapHeight: 2048 });
  engine.frame();
  const [near, second] = node.lights.map((level) => level.shadow);
  const depth = near.camera.far - near.camera.near;
  assert.ok(depth > 1000, `the slab under test is deep (${depth} m)`);
  assert.ok(0.0005 * depth > 0.5, "negative control: the raw bias would be over half a metre");
  const worldBias = -near.bias * depth;
  assert.ok(Math.abs(worldBias - 0.0005 * 99.9) < 1e-9, `finest level world bias ${worldBias} m`);
  assert.ok(-second.bias * depth < 0.18, "the second level still keeps grass-height shadows");
});

test("PCSS and VSM radius edits reach every sampled level", () => {
  for (const shadowMapType of ["PCSSShadowMap", "VSMShadowMap"]) {
    const { component, node } = makeLight({ shadowMapType, shadowRadius: 1 });
    component.setProp("shadowRadius", 4.5);
    assert.equal(component.light.shadow.shadowNode, node);
    assert.ok(node.lights.every((level) => level.shadow.radius === 4.5), `${shadowMapType} must read the edited radius`);
  }
});

test("scene entity roundtrip preserves authored clipmap settings and reconstructs fresh runtime maps", () => {
  const { entity, component, node } = makeLight({
    clipmapLevels: 4, clipmapNearSize: 16, clipmapScale: 3, clipmapLightMargin: 90,
    clipmapCache: false, shadowMapWidth: 1024, shadowMapHeight: 512, shadowRadius: 2.5,
  });
  const saved = JSON.parse(JSON.stringify(serializeEntity(entity)));
  assert.equal(saved.components[0].props.shadowMode, "clipmap");
  const restoredEngine = makeEngine();
  const restored = instantiateEntity(restoredEngine, saved);
  restoredEngine.frame();
  const restoredComponent = restored.getComponent(LightComponent);
  const restoredNode = restoredComponent.light.shadow.shadowNode;
  assert.deepEqual(restoredComponent.toJSON(), component.toJSON());
  assert.ok(restoredNode instanceof ClipmapShadowNode);
  assert.notEqual(restoredNode, node);
  assert.deepEqual(restoredNode.lights.map((level) => level.shadow.camera.right * 2), [16, 48, 144, 432]);
  assert.equal(restoredNode.cacheEnabled, false);
});

test("renderer rebuild and GI mode changes release old clipmap nodes and reconstruct the selected owner", () => {
  const { engine, component, node } = makeLight();
  const light = component.light;
  engine.renderer = { ...engine.renderer, backend: { isWebGPUBackend: true } };
  engine.emit("renderer-rebuilt");
  const replacement = component.light.shadow.shadowNode;
  assert.equal(component.light, light);
  assert.ok(replacement instanceof ClipmapShadowNode);
  assert.notEqual(replacement, node);
  assert.ok(node.lights.every((level) => level.parent === null));
  component.setProp("shadowMode", "gi");
  assert.equal(component.light.userData.giShadowMode, "gi");
  assert.equal(component.light.shadow.shadowNode?.isClipmapShadowNode, undefined);
  assert.deepEqual(component.light.userData.giShadowMaps(), []);
  assert.ok(replacement.lights.every((level) => level.parent === null));
  component.setProp("shadowMode", "clipmap");
  assert.ok(component.light.shadow.shadowNode instanceof ClipmapShadowNode);
  assert.equal(component.light.userData.giShadowMode, "map");
});

test("inspector offers clipmaps only for directional lights and shows the matching settings", () => {
  for (const kind of ["directional", "point", "spot", "ambient"]) {
    const props = { ...LightComponent.defaults, kind, castShadow: true, shadowMode: "clipmap" };
    const visible = LightComponent.schema.filter((row) => !row.showIf || row.showIf(props));
    const sources = visible.filter((row) => row.key === "shadowMode");
    assert.equal(sources.length, kind === "ambient" ? 0 : 1);
    if (sources.length) assert.equal(sources[0].options.includes("clipmap"), kind === "directional");
    assert.equal(visible.some((row) => row.key === "clipmapLevels"), kind === "directional");
    assert.equal(visible.some((row) => row.key === "csm"), false);
  }
});
