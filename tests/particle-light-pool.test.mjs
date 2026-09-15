/**
 * Particle point lights (src/engine/vfx/particleLightPool.js): a scene-wide
 * budget of lights, created once and driven by intensity only, so spawning,
 * despawning, enabling and disabling effects never changes three's lights hash
 * (LightsNode.customCacheKey: every rendered light's id + castShadow) and so
 * never re-mints lit materials.
 *
 * The hash is reproduced from the render list three builds (Renderer.
 * _projectObject skips `visible === false` subtrees before `pushLight`).
 * Negative control: the old per-subsystem lights with visibility toggles must
 * move that hash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { ParticleLightPool, PARTICLE_LIGHT_BUDGET, selectLightSlots } from "../src/engine/vfx/particleLightPool.js";

function renderedLights(scene) {
  const out = [];
  (function walk(object) {
    if (object.visible === false) return;
    if (object.isLight) out.push(object);
    for (const child of object.children) walk(child);
  })(scene);
  return out;
}
const lightsHash = (scene) => renderedLights(scene).map((l) => `${l.id}:${l.castShadow ? 1 : 0}`).join(",");

function makeEngine() {
  const updates = new Set();
  const camera = new THREE.PerspectiveCamera();
  return {
    scene: new THREE.Scene(), camera,
    onUpdate(fn) { updates.add(fn); return () => updates.delete(fn); },
    tick() { for (const fn of updates) fn(); },
    updates,
  };
}

function makeRig(scene, count, at) {
  const object = new THREE.Object3D();
  object.position.copy(at);
  scene.add(object);
  const clusters = Array.from({ length: count }, () => ({
    position: new THREE.Vector3(), color: new THREE.Color(1, 0.5, 0.2), intensity: 0, distance: 6, world: new THREE.Vector3(),
  }));
  return { object, clusters, active: true };
}

test("zero lights until an effect asks; then exactly the budget, whatever the demand", () => {
  const engine = makeEngine();
  const pool = new ParticleLightPool(engine);
  assert.equal(renderedLights(engine.scene).length, 0, "no effect, no lights");
  const rigs = [0, 1, 2].map((i) => makeRig(engine.scene, 8, new THREE.Vector3(i * 3, 0, -5)));
  const releases = rigs.map((rig) => pool.acquire(rig));
  assert.equal(PARTICLE_LIGHT_BUDGET, 4);
  assert.equal(renderedLights(engine.scene).length, 4, "3 systems × 8 clusters → 4 lights");
  assert.ok(renderedLights(engine.scene).every((light) => light.castShadow === false));
  for (const release of releases) release();
  pool.release();
  assert.equal(renderedLights(engine.scene).length, 0, "released once nothing uses them");
});

test("spawn, despawn, disable and system churn never move the lights hash", () => {
  const engine = makeEngine();
  const pool = new ParticleLightPool(engine);
  const a = makeRig(engine.scene, 8, new THREE.Vector3(0, 0, -4));
  const b = makeRig(engine.scene, 2, new THREE.Vector3(40, 0, -4));
  const releaseA = pool.acquire(a);
  pool.acquire(b);
  const hash = lightsHash(engine.scene);
  let lit = 0;
  for (let frame = 0; frame < 300; frame++) {
    // Particles bloom and die: cluster intensities come and go.
    a.clusters.forEach((c, k) => { c.intensity = Math.max(0, Math.sin(frame * 0.05 + k)) * 5; c.position.set(k * 0.3, 1, 0); });
    b.clusters.forEach((c) => { c.intensity = frame % 60 < 30 ? 3 : 0; });
    if (frame === 100) a.active = false;       // component disabled
    if (frame === 150) a.active = true;
    if (frame === 200) releaseA();               // one system destroyed
    if (frame === 220) pool.acquire(makeRig(engine.scene, 4, new THREE.Vector3(0, 0, -2))); // another built
    engine.tick();
    lit = Math.max(lit, renderedLights(engine.scene).filter((l) => l.intensity > 0).length);
    assert.equal(lightsHash(engine.scene), hash, `frame ${frame}: lights hash moved`);
  }
  assert.equal(lit, 4, "the budget is actually used");
});

test("lights show the brightest nearby clusters, in world space, and fade when idle", () => {
  const engine = makeEngine();
  const pool = new ParticleLightPool(engine, { budget: 2 });
  const near = makeRig(engine.scene, 2, new THREE.Vector3(0, 0, -3));
  const far = makeRig(engine.scene, 2, new THREE.Vector3(0, 0, -300));
  pool.acquire(near);
  pool.acquire(far);
  near.clusters[0].intensity = 2; near.clusters[0].position.set(1, 0, 0);
  near.clusters[1].intensity = 1;
  far.clusters[0].intensity = 50; far.clusters[1].intensity = 50;
  engine.tick();
  const shown = pool.lights.map((l) => l.position.z).sort();
  assert.deepEqual(shown, [-3, -3], "the nearby fire outranks a brighter one 300 m away");
  assert.ok(pool.lights.some((l) => l.position.x === 1 && l.intensity === 2));
  near.active = false; far.active = false;
  for (let i = 0; i < 60; i++) engine.tick();
  assert.ok(pool.lights.every((l) => l.intensity === 0), "idle lights fade to exactly 0");
});

test("slot assignment is stable while the chosen set is unchanged", () => {
  const [x, y, z] = ["x", "y", "z"];
  const first = selectLightSlots([{ key: x, score: 3 }, { key: y, score: 2 }, { key: z, score: 1 }], 2);
  assert.deepEqual(first, [x, y]);
  assert.deepEqual(selectLightSlots([{ key: x, score: 1 }, { key: y, score: 5 }], 2, first), [x, y], "rank swap keeps slots");
  assert.deepEqual(selectLightSlots([{ key: z, score: 9 }, { key: y, score: 5 }], 2, first), [z, y], "y keeps its slot");
  assert.deepEqual(selectLightSlots([{ key: x, score: 0 }], 2, first), [null, null]);
});

test("negative control: per-subsystem lights with visible toggles move the hash", () => {
  const scene = new THREE.Scene();
  const entity = new THREE.Object3D();
  scene.add(entity);
  const lights = Array.from({ length: 8 }, () => { const l = new THREE.PointLight(0xffffff, 0); entity.add(l); return l; });
  const hash = lightsHash(scene);
  for (const light of lights) light.visible = false;      // old onDisable
  assert.notEqual(lightsHash(scene), hash);
  for (const light of lights) light.visible = true;
  const extra = new THREE.PointLight(); entity.add(extra); // old: a second system built
  assert.notEqual(lightsHash(scene), hash);
});
