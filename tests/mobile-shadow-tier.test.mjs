/**
 * Mobile directional-shadow tier (src/engine/mobileShadowTier.js): a phone
 * renders 2 CSM cascades / clipmap levels where a desktop renders the authored
 * 4 / 3 — without touching resolution, without writing props, and never over
 * an authored `variants.mobile` value.
 *
 * `LIGHT_COMPONENT_MODULE` lets the negative control run this file against the
 * pre-tier LightComponent (it must fail the mobile assertions).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { platformLayers } from "../src/engine/componentVariants.js";
import {
  coveragePreservingClipmapScale, practicalBreaks, reducedPracticalBreaks, resolveShadowLevelCount,
} from "../src/engine/mobileShadowTier.js";

const modulePath = process.env.LIGHT_COMPONENT_MODULE ?? "../src/engine/components/LightComponent.js";
const { LightComponent } = await import(modulePath);
registerComponent(LightComponent);

function makeEngine(platform = "desktop") {
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
    variantComponents: new Set(),
    platform: { platform, orientation: "landscape" },
    get platformLayers() { return platformLayers(engine.platform); },
    /** Engine.#resolvePlatform: re-apply variant components, then announce. */
    setPlatform(next) {
      engine.platform = { platform: next, orientation: "landscape" };
      for (const component of engine.variantComponents) component.applyPlatformLayers(engine.platformLayers);
      engine.emit("platform-changed", { ...engine.platform, layers: engine.platformLayers });
    },
    scene, camera, settings: { shadow: { autoUpdate: true } },
    renderer: {
      coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: false,
      backend: { isWebGPUBackend: true }, info: { frame: 0, render: { calls: 0 } },
    },
    emit(event, payload) { for (const fn of [...(listeners.get(event) ?? [])]) fn(payload); },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    onPreRender(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
    createEntity({ id, name } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      engine.rootEntities.push(entity);
      scene.add(entity.object3D);
      return entity;
    },
    frame() {
      scene.updateMatrixWorld(true);
      for (const fn of callbacks) fn();
      engine.renderer.info.frame++;
    },
  };
  return engine;
}

function makeSun(platform, props = {}) {
  const engine = makeEngine(platform);
  const entity = engine.createEntity({ name: "Sun" });
  entity.rotation.set(-Math.PI / 3, 0.4, 0);
  const component = entity.addComponent(LightComponent, {
    kind: "directional", castShadow: true, shadowMode: "map", csm: true, ...props,
  });
  engine.frame();
  const node = () => component.light.shadow.shadowNode;
  return { engine, entity, component, node };
}

test("CSM: 4 cascades on desktop, 2 on mobile, same resolution, props and JSON untouched", () => {
  const desktop = makeSun("desktop");
  assert.equal(desktop.node().cascades, 4);
  const mobile = makeSun("mobile");
  assert.equal(mobile.node().cascades, 2, "a phone renders two cascades");
  assert.equal(mobile.component.props.csmCascades, 4, "the authored prop is not rewritten");
  assert.equal(mobile.component.toJSON().props.csmCascades, 4);
  assert.equal(mobile.component.toJSON().props.variants, undefined, "no implicit variant is saved");
  assert.equal(mobile.component.light.shadow.mapSize.x, desktop.component.light.shadow.mapSize.x, "no resolution cap");
});

test("an authored mobile variant for csmCascades wins over the tier", () => {
  const f = makeSun("mobile", { variants: { mobile: { csmCascades: 3 } } });
  assert.equal(f.node().cascades, 3);
  assert.equal(f.component.toJSON().props.csmCascades, 4);
  const g = makeSun("mobile", { variants: { mobile: { csmCascades: 4 } } });
  assert.equal(g.node().cascades, 4, "an author may keep all four on a phone");
});

test("the tier follows a platform change (phone boot, editor Mobile preview)", () => {
  const f = makeSun("desktop");
  assert.equal(f.node().cascades, 4);
  f.engine.setPlatform("mobile");
  f.engine.frame();
  assert.equal(f.node().cascades, 2);
  f.engine.setPlatform("desktop");
  f.engine.frame();
  assert.equal(f.node().cascades, 4);
});

test("reduced splits keep the desktop near cascade and still reach maxFar", () => {
  const f = makeSun("mobile");
  const breaks = [];
  f.node().customSplitsCallback(2, 0.1, 1000, breaks);
  const desktop = practicalBreaks(4, 0.1, 1000, 0.9);
  assert.equal(breaks.length, 2);
  assert.ok(Math.abs(breaks[0] - desktop[0]) < 1e-12, `near split ${breaks[0] * 1000} m`);
  assert.equal(breaks[1], 1);
  assert.ok(breaks[0] < practicalBreaks(2, 0.1, 1000, 0.9)[0] / 2, "denser than a native 2-cascade split");
});

test("clipmap: 2 levels on mobile with the same outermost coverage", () => {
  const desktop = makeSun("desktop", { shadowMode: "clipmap" });
  const mobile = makeSun("mobile", { shadowMode: "clipmap" });
  const widths = (f) => f.node().lights.map((light) => light.shadow.camera.right * 2);
  assert.deepEqual(widths(desktop), [20, 80, 320]);
  assert.equal(mobile.node().levels, 2);
  const w = widths(mobile);
  assert.equal(w[0], 20, "finest level unchanged");
  assert.ok(Math.abs(w[w.length - 1] - 320) < 1e-9, "outermost coverage preserved");
  assert.equal(mobile.component.toJSON().props.clipmapLevels, 3);
  const authored = makeSun("mobile", { shadowMode: "clipmap", variants: { mobile: { clipmapLevels: 3 } } });
  assert.equal(authored.node().levels, 3);
});

test("pure resolver", () => {
  const base = { key: "csmCascades", fallback: 4, min: 2, max: 4, mobile: 2 };
  assert.deepEqual(resolveShadowLevelCount({ ...base, value: 4, layers: [] }), { count: 4, authored: 4, reduced: false });
  assert.deepEqual(resolveShadowLevelCount({ ...base, value: 4, layers: ["mobile", "portrait"] }), { count: 2, authored: 4, reduced: true });
  assert.deepEqual(resolveShadowLevelCount({ ...base, value: 2, layers: ["mobile"] }), { count: 2, authored: 2, reduced: false });
  assert.equal(resolveShadowLevelCount({ ...base, value: 3, layers: ["mobile", "landscape"], variants: { landscape: { csmCascades: 3 } } }).count, 3);
  assert.equal(resolveShadowLevelCount({ ...base, value: 4, layers: ["mobile", "landscape"], variants: { portrait: { csmCascades: 4 } } }).count, 2, "an inactive layer does not count");
  assert.deepEqual(reducedPracticalBreaks(3, 4, 0.1, 1000, 0.9).slice(0, 2), practicalBreaks(4, 0.1, 1000, 0.9).slice(0, 2));
  assert.equal(coveragePreservingClipmapScale(4, 3, 2), 16);
});
