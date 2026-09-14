import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { computeEntityBoundingSphere } from "../src/engine/viewFrustum.js";
import { FoliageComponent } from "../src/modules/foliage/FoliageComponent.js";
import {
  foliageApplyImpostorRamp, foliageCellSize, foliageChunkTierMask, foliageLodBand, foliageLodLevel,
  foliageLodThresholds, foliageTierKeeps, foliageTierWeights, partitionFoliage,
} from "../src/modules/foliage/foliageLod.js";
import { createFoliageSurfaceMaterial, createFoliageUniforms, installFoliagePassHooks } from "../src/modules/foliage/foliageMaterial.js";
import { foliageInstanceMatrix } from "../src/modules/foliage/foliageWind.js";
import { createFoliagePrototype } from "../src/modules/foliage/foliageGeometry.js";
import { createImpostorMaterial, createImpostorGeometry } from "../src/engine/lod/impostorMaterial.js";
import { updateFoliageInteractions } from "../src/modules/foliage/foliageInteraction.js";
import { foliageModule } from "../src/modules/foliage/index.js";
import { holdFoliageResources } from "../src/modules/foliage/foliageWarmup.js";
import { disableEngineModule, enableEngineModule, registerModuleDefinition } from "../src/engine/modules.js";
import { MissingComponent } from "../src/engine/components/registry.js";
import Attributes from "three/src/renderers/common/Attributes.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";

function engineFixture() {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id);
  engine.onPreRender = fn => engine.on("preRender", fn);
  engine.camera.position.set(0, 3, 10);
  return engine;
}

function entityFixture(engine, id, parent = null) {
  const entity = new Entity(engine, { id });
  engine.entities.set(id, entity);
  entity.setParent(parent);
  return entity;
}

function surfaceFixture(engine, id = "surface") {
  const entity = entityFixture(engine, id);
  const geometry = new THREE.PlaneGeometry(12, 12, 3, 3).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardNodeMaterial());
  mesh.userData.entityId = entity.id;
  entity.object3D.add(mesh);
  return { entity, mesh };
}

function scatterFixture(props = {}) {
  const engine = engineFixture();
  const surface = surfaceFixture(engine);
  const entity = entityFixture(engine, "foliage");
  const component = entity.addComponent(new FoliageComponent({ species: "grass", drawnGrass: false, height: .6, width: .5, distribution: "scatter", surface: surface.entity.id, density: 1, maxInstances: 1000, chunkSize: 32, ...props }));
  return { engine, surface, entity, component };
}

function placementFixture() {
  const engine = engineFixture(), parent = entityFixture(engine, 'placed parent'), entity = entityFixture(engine, 'placed trees', parent);
  parent.position.set(14, 3, -9); parent.rotation.set(.1, .37, -.08); parent.scale.set(1.4, 2, .8);
  entity.position.set(3, .2, -1); entity.rotation.set(0, .2, .03);
  const placements = [
    { id: 'north:oak', position: [1, 0, 2], rotation: [.04, .7, -.02], scale: .85 },
    { id: 'bank:oak', position: [-2, .7, -3], rotation: [0, -.4, .1], scale: 1.2 },
    { id: 'meadow:oak', position: [4, -.2, -1] },
  ];
  const component = entity.addComponent(new FoliageComponent({ species: 'oak', distribution: 'placements', placements,
    height: 5, width: 3, lodNear: 10000, lodFar: 20000, maxDistance: 30000, runInEditor: false }));
  return { engine, parent, entity, component, placements };
}

function assertPlacementMatricesAndBounds(component, placements) {
  component.entity.object3D.updateWorldMatrix(true, false);
  const expected = new Map(placements.map(plant => {
    const local = new THREE.Object3D();
    local.position.fromArray(plant.position); local.rotation.set(...(plant.rotation ?? [0, 0, 0])); local.scale.setScalar(plant.scale ?? 1); local.updateMatrix();
    return [plant.id, component.entity.object3D.matrixWorld.clone().multiply(local.matrix)];
  }));
  const bound = new THREE.Sphere();
  assert.equal(computeEntityBoundingSphere(component.entity, bound), true);
  const actual = new THREE.Matrix4(), vertex = new THREE.Vector3();
  let batchIndex = 0;
  for (const chunk of component.chunks) for (let i = 0; i < chunk.instances.length; i++) {
    const instance = chunk.instances[i], matrix = expected.get(instance.id);
    assert.ok(matrix, `the runtime retains authored ID ${instance.id}`);
    assert.deepEqual(instance.matrix.elements, matrix.elements);
    chunk.meshes[0].getMatrixAt(i, actual);
    assert.deepEqual(actual.elements, matrix.elements.map(Math.fround), 'chunk matrices contain actual world transforms');
    component.renderMeshes[0].getMatrixAt(batchIndex++, actual);
    assert.deepEqual(actual.elements, matrix.elements.map(Math.fround), 'the submitted batch uses the same transform in its first draw');
    for (const geometry of component.geometries) {
      const positions = geometry.attributes.position;
      for (let p = 0; p < positions.count; p++) {
        vertex.fromBufferAttribute(positions, p).applyMatrix4(matrix);
        assert.ok(bound.containsPoint(vertex), 'entity culling encloses actual transformed geometry');
        assert.ok(chunk.bounds.containsPoint(vertex), 'chunk culling encloses actual transformed geometry');
      }
    }
  }
  assert.equal(batchIndex, placements.length);
  assert.equal(component.renderMeshes[0].count, placements.length);
  return bound;
}

test('placed populations keep stopped buffers, IDs and anchors through shape and color edits', () => {
  const { engine, entity, component, placements } = placementFixture();
  try {
    component.update(true);
    assert.equal(engine.playing, false);
    assertPlacementMatricesAndBounds(component, placements);
    const buffers = component.renderMeshes.slice(0, 2).map(mesh => mesh.instanceMatrix);
    let uploads = 0;
    const attributes = new Attributes({ createAttribute() {}, updateAttribute() { uploads++; } }, { createAttribute() {} });
    const submit = () => buffers.forEach(buffer => attributes.update(buffer, AttributeType.VERTEX));
    submit();
    const snapshots = buffers.map(buffer => buffer.array.slice());
    for (let frame = 0; frame < 30; frame++) { component.update(true); submit(); }
    assert.equal(uploads, 0, 'stationary authored populations do not re-upload even when transform checking is forced');
    buffers.forEach((buffer, index) => assert.deepEqual(buffer.array, snapshots[index]));
    const authored = JSON.parse(JSON.stringify(component.props.placements));
    for (const [key, value] of Object.entries({ height: 7, crownSpread: 1.1, leafColor: '#75824c' })) {
      const previous = component.geometries[0];
      component.setProp(key, value); component.update(true);
      assert.notEqual(component.geometries[0], previous, `${key} updates the actual tree prototype`);
      assert.deepEqual(component.props.placements, authored, `${key} preserves the saved placement list`);
      assert.deepEqual(component.instances.map(instance => instance.id), placements.map(plant => plant.id));
      assertPlacementMatricesAndBounds(component, placements);
    }
  } finally { entity.removeComponent('foliage'); }
});

test('placed populations follow translated, rotated and nonuniformly scaled parents and survive JSON reconstruction', () => {
  const { parent, entity, component, placements } = placementFixture();
  let reloaded;
  try {
    const before = assertPlacementMatricesAndBounds(component, placements);
    parent.position.add(new THREE.Vector3(21, 2, -7)); parent.rotation.set(.31, -.62, .17); parent.scale.set(2.3, .8, 1.6);
    component.update(true);
    const after = assertPlacementMatricesAndBounds(component, placements);
    assert.ok(after.center.distanceTo(before.center) > 10, 'culling follows the moved parent instead of the old world position');
    const saved = JSON.parse(JSON.stringify({ parent: parent.getTransform(), entity: entity.getTransform(), component: component.toJSON() }));
    const otherEngine = engineFixture(), otherParent = entityFixture(otherEngine, 'restored parent');
    otherParent.setTransform(saved.parent); reloaded = entityFixture(otherEngine, 'restored trees', otherParent); reloaded.setTransform(saved.entity);
    const restored = reloaded.addComponent(new FoliageComponent(saved.component.props));
    assert.equal(restored.props.distribution, 'placements');
    assert.deepEqual(restored.props.placements, placements, 'JSON keeps local positions, radians, scales and IDs');
    assertPlacementMatricesAndBounds(restored, placements);
    assert.deepEqual(restored.instances.map(instance => instance.matrix.elements.map(Math.fround)), component.instances.map(instance => instance.matrix.elements.map(Math.fround)));
  } finally { entity.removeComponent('foliage'); reloaded?.removeComponent('foliage'); }
});

test("tree shape controls rebuild prototypes while retaining authored scatter anchors", () => {
  const { entity, component } = scatterFixture({ species: "oak", height: 8, width: 6, density: .04, maxInstances: 12 });
  try {
    const anchors = component.instances;
    const positions = anchors.map(instance => [...instance.position]);
    assert.ok(anchors.length > 0);
    for (const [key, value] of Object.entries({ leafDensity: 1.2, leafSize: .85, branchDensity: 1.2, crownBase: .08, crownSpread: 1.15 })) {
      const geometry = component.geometries[0];
      component.setProp(key, value);
      assert.equal(component._shapeDirty, true, `${key} invalidates the prototype and atlas`);
      assert.equal(component._resample, false, `${key} does not request a new scatter`);
      component.update(true);
      assert.notEqual(component.geometries[0], geometry, `${key} rebuilds actual geometry`);
      assert.equal(component.instances, anchors, `${key} retains the authored scatter candidates`);
      assert.deepEqual(component.instances.map(instance => [...instance.position]), positions);
      assert.equal(component.toJSON().props[key], value, `${key} persists for reload`);
    }
  } finally { entity.removeComponent("foliage"); }
});

test("stationary foliage buffers skip real Three uploads while LOD repacks upload new ranges", () => {
  const {engine, entity, component} = scatterFixture({lodNear:4,lodFar:8});
  component._atlasEntry = {atlas:{center:new THREE.Vector3(0,.3,0),radius:.7,dispose(){}},material:new THREE.MeshStandardNodeMaterial(),refs:1,cache:new Map(),key:"upload fixture"};
  component._buildImpostors(); component.update();
  const buffers = component.renderMeshes.flatMap((mesh,lod)=>lod<2?[mesh.instanceMatrix]:["aCenter","aSize","aAxisX","aAxisY"].map(key=>mesh.geometry.attributes[key]));
  let uploads = 0;
  const attributes = new Attributes({createAttribute(){},updateAttribute(){uploads++;}}, {createAttribute(){}});
  const submit = () => { for(const buffer of buffers) attributes.update(buffer,AttributeType.VERTEX); };
  submit();
  for(let frame=0;frame<30;frame++) { component.update(); submit(); }
  assert.equal(uploads,0,"unchanged matrices and atlas placements must not upload every draw (DynamicDrawUsage forces this in Three)");
  // 09-14: a move that changes only `chunk.level` (bookkeeping) while every
  // chunk keeps the same tier MEMBERSHIP re-committed identical data before;
  // it must upload nothing now. The probe run showed masks [7,7,7,7] on both
  // sides of this move.
  const masksAt = () => component.chunks.map(chunk => chunk.tierMask);
  const levelsAt = () => component.chunks.map(chunk => chunk.level);
  const stillMasks = masksAt(), stillLevels = levelsAt();
  engine.camera.position.set(0,.5,0); component.update(); submit();
  assert.deepEqual(masksAt(), stillMasks, "fixture: this move keeps every chunk's tier membership");
  assert.notDeepEqual(levelsAt(), stillLevels, "fixture: this move changes chunk levels");
  assert.equal(uploads, 0, "a level-only change must not re-commit and upload identical instance data");
  engine.camera.position.set(0,.5,60); component.update(); submit();
  assert.notDeepEqual(masksAt(), stillMasks, "fixture: this move really changes tier membership");
  assert.ok(uploads>0,"LOD membership changes still upload through actual attribute versions");
  assert.ok(uploads<=buffers.length,"each changed buffer uploads only once");
  const afterRepack=uploads; submit();
  assert.equal(uploads,afterRepack,"the same repacked data is reused by the next render pass");
  entity.removeComponent("foliage");
});

test("foliage hierarchy ownership preserves world placement and world bounds under scaled parents", () => {
  const engine = engineFixture();
  const parent = entityFixture(engine, "parent");
  parent.position.set(60, 4, -20);
  parent.scale.set(2, 3, 4);
  const entity = entityFixture(engine, "tree", parent);
  entity.position.set(3, 0, 2);
  const component = entity.addComponent(new FoliageComponent({ species: "pine", height: 5, width: 2 }));
  engine.scene.updateMatrixWorld(true);
  assert.equal(component.root.parent, entity.object3D);
  assert.deepEqual(component.root.matrixWorld.elements, new THREE.Matrix4().elements);
  const actual = new THREE.Matrix4(); component.chunks[0].meshes[0].getMatrixAt(0, actual);
  assert.deepEqual(actual.elements, entity.object3D.matrixWorld.elements);
  const bound = new THREE.Sphere();
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.center.x > 60 && bound.center.y > 4 && bound.radius > 4, "world-space foliage contributes the actual transformed extent");
  parent.position.x += 10;
  component.update(true);
  assert.equal(component.instances[0].position[0], 76);
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.center.x > 70);
  component.setProp("height", 10); component.update();
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.radius > 10);
  entity.removeComponent("foliage");
});

test("sculpt reseats stable barycentric identities, shares matrices across LODs and excludes its own generated geometry", () => {
  const { engine, surface, component, entity } = scatterFixture();
  assert.equal(component.instances.length, 144);
  assert.equal(component.chunks[0].meshes[0].instanceMatrix, component.chunks[0].meshes[1].instanceMatrix);
  const original = component.instances.map(instance => ({ position: [...instance.position], barycentric: [...instance.barycentric], seed: instance.seed }));
  const position = surface.mesh.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setY(i, position.getX(i) * .15 + 2);
  position.needsUpdate = true;
  surface.mesh.geometry.computeVertexNormals();
  component.update(true);
  assert.equal(component.instances.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.deepEqual(component.instances[i].barycentric, original[i].barycentric);
    assert.equal(component.instances[i].seed, original[i].seed);
    assert.ok(Math.abs(component.instances[i].position[0] - original[i].position[0]) < 1e-8);
    assert.ok(Math.abs(component.instances[i].position[1] - (original[i].position[0] * .15 + 2)) < 1e-6);
  }
  entity.setParent(surface.entity);
  component.setProp("surface", "");
  component.update(true);
  assert.equal(component.instances.length, 145, "density sees only the deformed source surface, never the generated grass");
  surface.entity.position.y += 4;
  component.update(true);
  assert.ok(component.instances.every(instance => instance.position[1] > 5));
  entity.removeComponent("foliage");
});

test("async source geometry swap rebuilds, removed source clears, detached subscriptions cannot resurrect foliage", () => {
  const { engine, surface, component, entity } = scatterFixture();
  surface.mesh.geometry = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2).translate(30, 0, 0);
  engine.emit("component-changed", { entityId: surface.entity.id, componentType: "mesh", key: "geometryAsset" });
  component.update();
  assert.equal(component.instances.length, 16);
  assert.ok(component.instances.every(instance => instance.position[0] >= 28));
  const near = component.chunks[0].meshes[0];
  component.setProp("windSpeed", 3); component.setProp("interaction", true); component.update();
  assert.equal(component.chunks[0].meshes[0], near, "motion edits keep the instance allocation");
  const radius = near.boundingSphere.radius;
  component.setProp("windStrength", 7);
  assert.ok(near.boundingSphere.radius >= radius, "clamped blade rotation stays covered by its full bend envelope");
  engine.entities.delete(surface.entity.id);
  engine.emit("hierarchy-changed"); component.update();
  assert.equal(component.instances.length, 0);
  entity.removeComponent("foliage");
  engine.emit("model-loaded", surface.entity); engine.emit("preRender");
  assert.equal(component.root, null);
  assert.equal(component.stats.instances, 0);
  assert.equal(engine.listenerCount("preRender"), 0);
});

test("disable, global ancestor disable and simulation suspension pause both rendering work and the clamped clock", () => {
  const { engine, component, entity } = scatterFixture();
  engine.deltaTime = 100;
  const before = component._time;
  component.update();
  assert.ok(Math.abs(component._time - before - .1) < 1e-12);
  engine.simulationSuspended = true;
  const paused = component._time;
  component.update(); assert.equal(component._time, paused);
  engine.simulationSuspended = false;
  component.setEnabled(false); component.update();
  assert.equal(component.root.visible, false); assert.equal(component._time, paused);
  component.setEnabled(true); component.update();
  assert.equal(component.root.visible, true);
  const ancestor = entityFixture(engine, "disabled ancestor");
  entity.setParent(ancestor);
  ancestor.enabled = false;
  component.update(); assert.equal(component.root.visible, false);
  entity.removeComponent("foliage");
});

test("LOD is a plain boundary compare with no hysteresis, and distant chunks become actual two-triangle instances", () => {
  const props = { lodNear: 10, lodFar: 30, maxDistance: 100 };
  // No `previous`/hysteresis argument any more: the SAME distance always gives
  // the SAME level, approaching from either side (`foliageLod.js` deleted the
  // sticky-boundary behaviour along with the chunk-relative pixel rescale —
  // the per-instance shader crossfade, not a sticky CPU boundary, is what
  // keeps this from popping now; see `foliageTierWeights`).
  assert.equal(foliageLodLevel(9, props), 0);
  assert.equal(foliageLodLevel(10.5, props), 1);
  assert.equal(foliageLodLevel(9.5, props), 0);
  assert.equal(foliageLodLevel(50, props), 2);
  assert.equal(foliageLodLevel(110, props), 3);
  const { engine, component, entity } = scatterFixture(props);
  const atlas = { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} };
  component._atlasEntry = { atlas, material: new THREE.MeshStandardNodeMaterial({alphaTest:.35}), refs: 1, cache: new Map(), key: "fixture" };
  component._buildImpostors();
  assert.equal(component.renderMeshes[2].material.alphaTest,.35,"the cloned living impostor retains real Three alpha testing instead of becoming an opaque brick");
  engine.camera.position.set(0, 2, 65); component.update();
  assert.ok(component.stats.impostorChunks > 0);
  assert.equal(component.stats.triangles, component.instances.length * 2);
  for (const chunk of component.chunks) {
    assert.equal(chunk.meshes[2].geometry.index.count, 6);
    assert.equal(chunk.meshes[2].geometry.instanceCount, chunk.instances.length);
    assert.deepEqual(chunk.meshes.map(mesh => mesh.visible), [false, false, true]);
    assert.equal(chunk.meshes[2].userData.vfxSimulation, "foliage");
  }
  for (const mesh of component.renderMeshes) {
    assert.equal(mesh.userData.foliageLodNear, 10); assert.equal(mesh.userData.foliageLodFar, 30);
    assert.equal(mesh.userData.foliageLodEnd, 100);
  }
  assert.equal(component.renderMeshes[0].userData.foliageLodTier, 0);
  assert.equal(component.renderMeshes[1].userData.foliageLodTier, 1);
  engine.camera.position.z = 300; component.update();
  assert.equal(component.stats.drawCalls, 0);
  entity.removeComponent("foliage");
});

/**
 * ⭐⭐ 09-13: OWNER'S VERDICT, WITH A SCREENSHOT — "Trees don't cast shadows"
 * after the per-instance LOD crossfade (P1-B) landed; rocks (no LOD fade)
 * still did. Root cause: `foliageFadeNode`'s distance term read TSL's
 * builtin `cameraPosition` — the world position of whichever camera renders
 * the CURRENT PASS. In the color pass that is the viewport camera; in the
 * shadow-map pass it is the LIGHT's orthographic camera, sitting far down
 * the sun's direction. Every instance's distance from that camera read as
 * far past `maxDistance`, so every instance faded to weight 0 — collapsing
 * onto its own pivot AND, through the shared `maskShadowNode` discard,
 * removing it from the shadow map — while the color pass drew it normally.
 * `impostorMaterial.js`'s impostor tier had the identical bug.
 *
 * Fixed by reading a per-object uniform (`mesh.userData.foliageViewerPosition`)
 * instead: `FoliageComponent.update()` now owns a `Vector3`, refreshed once a
 * frame from `engine.camera` (the real viewer, never the pass camera), and
 * writes the SAME object onto every one of its own render meshes — near, mid
 * and impostor alike — so the fade measures viewer distance in every pass.
 *
 * This test does not render or compile a shader (a full node-graph diff
 * would run Node out of memory on a material this size — see the ⭐⭐ block
 * above `createFoliageMaterial`'s sharing scheme). It instead: (a) reads back
 * plain `castShadow` booleans off real meshes, and (b) calls the exposed LOD
 * uniforms' own `.update()` functions directly — one JS call each — to prove
 * their SOURCE is `object.userData.foliageViewerPosition`, by object identity,
 * without touching WGSL at all.
 */
test("trees keep casting shadows: every LOD tier inherits castShadow, and the fade uniform reads the component's own viewer position — never the pass camera (09-13)", () => {
  const props = { castShadow: true, lodNear: 10, lodFar: 30, maxDistance: 100 };
  const { engine, component, entity } = scatterFixture(props);
  const atlas = { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} };
  component._atlasEntry = { atlas, material: new THREE.MeshStandardNodeMaterial({ alphaTest: .35 }), refs: 1, cache: new Map(), key: "fixture" };
  component._buildImpostors();
  engine.camera.position.set(4, 5, 6);
  component.update();
  assert.ok(component.stats.instances > 0, "the fixture actually populated instances");

  // (a) castShadow reaches every tier of every mesh: the three shared batch
  // meshes AND every chunk's own template meshes (bounds/raycast/impostor
  // source), not just whichever one a stale check happened to look at.
  assert.equal(component.renderMeshes.length, 3);
  for (const mesh of component.renderMeshes) assert.equal(mesh.castShadow, true, "every shared render-batch tier casts a shadow");
  for (const chunk of component.chunks) for (const mesh of chunk.meshes) assert.equal(mesh.castShadow, true, "every chunk-template tier casts a shadow");

  // (b) the viewer position is the component's OWN object, shared BY
  // REFERENCE across its own render meshes — never `camera.position` (which
  // can be a rig-local offset, not the world position), and never some other
  // component's write.
  const expectedViewer = new THREE.Vector3();
  engine.camera.getWorldPosition(expectedViewer);
  assert.ok(component._viewerPosition.equals(expectedViewer), "the component's viewer position matches the real viewer camera's world position");
  for (const mesh of component.renderMeshes) {
    assert.equal(mesh.userData.foliageViewerPosition, component._viewerPosition, "every render mesh reads the SAME component-owned viewer-position object");
  }

  // (c) the tree/grass material's fade uniform reads exactly
  // `object.userData.foliageViewerPosition` — proven by calling the uniform
  // node's own update function with a synthetic object, never by walking or
  // diffing the compiled node graph.
  const lod = component.material.userData.foliageLod;
  assert.ok(lod?.viewerPosition?.isUniformNode, "the shared material exposes its LOD uniforms for inspection");
  const probe = new THREE.Vector3(11, 22, 33);
  lod.viewerPosition.update({ object: { userData: { foliageViewerPosition: probe } } });
  assert.equal(lod.viewerPosition.value, probe, "the fade uniform's source is object.userData.foliageViewerPosition, never a global or pass camera");
  lod.viewerPosition.update({ object: { userData: {} } });
  assert.equal(lod.viewerPosition.value, probe, "a draw with no per-object write yet keeps the last-known viewer position instead of snapping to the origin");
  // 09-14 per-level clipmap LOD: the level draw's force flag reaches the shader.
  assert.ok(lod.shadowForce?.isUniformNode, "the living material exposes its shadow-force uniform");
  lod.shadowForce.update({ object: { userData: { foliageShadowForce: true } } });
  assert.equal(lod.shadowForce.value, 1, "a forced clipmap level draw casts every instance");
  lod.shadowForce.update({ object: { userData: {} } });
  assert.equal(lod.shadowForce.value, 0, "the colour pass never sees the force");

  // (d) the impostor material carries the identical contract. Built directly
  // (not through the component's clone-on-bake-resolve path, whose
  // `Material.copy()` JSON-round-trips `userData` and would hand back an
  // inert snapshot instead of the live uniform) so the node identity checked
  // here is the exact one the shader graph holds.
  const impostorMaterial = createImpostorMaterial(
    { albedo: new THREE.Texture(), normal: new THREE.Texture(), frames: 4, tile: 64, hemisphere: true, radius: .7 },
    { alphaTest: .35 },
  );
  const impostorLod = impostorMaterial.userData.impostorLod;
  assert.ok(impostorLod?.viewerPosition?.isUniformNode, "the impostor material exposes its LOD uniforms for inspection");
  impostorLod.viewerPosition.update({ object: { userData: { foliageViewerPosition: probe } } });
  assert.equal(impostorLod.viewerPosition.value, probe, "the impostor fade uniform's source is object.userData.foliageViewerPosition too");
  // (e) 09-14 "rects casted from impostors": the atlas lookup read the COLOUR
  // fade's collapsed position, so between shadowFar and far every shadow quad
  // sampled the crown's centre texel and cast a solid rectangle.
  // Compared by node `id` after unwrapping: `toVarying()` wraps its source in a
  // SubBuildNode, so neither identity nor the wrapper's id ever matched (the
  // first two cuts of this check were blind — negative control passed).
  let atlasSource = impostorLod.atlasPosition?.node;
  while (atlasSource?.constructor?.name === "SubBuildNode") atlasSource = atlasSource.node;
  const atlasSourceId = atlasSource?.id;
  assert.ok(Number.isInteger(atlasSourceId), "the impostor exposes the varying its atlas lookup reads");
  assert.notEqual(atlasSourceId, impostorMaterial.positionNode.id,
    "the atlas lookup must not read the colour-fade-collapsed position, or shadow quads sample one texel and cast rectangles");
  assert.notEqual(atlasSourceId, impostorMaterial.castShadowPositionNode.id,
    "nor the shadow-pushed/collapsed caster position");

  entity.removeComponent("foliage");
});

test("100k dense placements have bounded spatial draw groups and never allocate per-plant objects", () => {
  const placements = Array.from({ length: 100000 }, (_, i) => ({ position: [i % 100, 0, Math.floor(i / 100) % 100] }));
  const chunks = partitionFoliage(placements, 24);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.instances.length, 0), placements.length);
  assert.ok(chunks.every(chunk => chunk.instances.length <= 1024));
  assert.ok(chunks.length < 225, "spatial median splits stay bounded by twice the dense capacity plus edge cells");
});

test("dense spatial splitting tightens real extents instead of slicing identical random cell bounds", () => {
  const instances = Array.from({ length: 4096 }, (_, i) => ({ position: [((i * 733) % 4096) / 4096 * 24, 0, .5] }));
  const chunks = partitionFoliage(instances, 24);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) {
    const x = chunk.instances.map(instance => instance.position[0]);
    assert.ok(Math.max(...x) - Math.min(...x) < 6.01, "each child covers a quarter of the source extent");
  }
  assert.equal(new Set(chunks.flatMap(chunk => chunk.instances)).size, instances.length);
});

test("cell size still adapts to species/height; LOD thresholds no longer rescale with screen size", () => {
  const props = { species: "grass", drawnGrass: false, height: .65, chunkSize: 24, lodNear: 12, lodFar: 30, maxDistance: 65 };
  assert.ok(Math.abs(foliageCellSize(props) - 7.8) < 1e-9);
  assert.equal(foliageCellSize({ ...props, chunkSize: 3 }), 3, "an authored smaller cell remains smaller");
  // The chunk-relative pixel rescale (`foliageDetailDistances`) is deleted: a
  // plant's tier is species-level distance only, never which render target or
  // zoom level is looking at it (`foliageLod.js`'s own file-level doc).
  assert.equal(foliageLodLevel(8, props), 0, "close blades retain full detail");
  assert.equal(foliageLodLevel(20, props), 1);
  assert.equal(foliageLodLevel(40, props), 2);
  assert.equal(foliageLodLevel(70, props), 3);
});

test("the crossfade band floors at 6 m and otherwise scales with the threshold", () => {
  assert.equal(foliageLodBand(10), 6, "25% of 10 is 2.5, below the 6 m floor");
  assert.equal(foliageLodBand(24), 6, "25% of 24 is exactly the 6 m floor");
  assert.ok(Math.abs(foliageLodBand(100) - 25) < 1e-9);
});

test("tier weights are complementary at both crossfade edges and sum to 1 through the whole band", () => {
  const props = { lodNear: 40, lodFar: 120, maxDistance: 400 };
  // At `near` itself the near/mid crossfade is exactly half-faded either way.
  const atNear = foliageTierWeights(40, props);
  assert.ok(Math.abs(atNear.near - .5) < 1e-9); assert.ok(Math.abs(atNear.mid - .5) < 1e-9);
  assert.ok(Math.abs(atNear.impostor) < 1e-9);
  const atFar = foliageTierWeights(120, props);
  assert.ok(Math.abs(atFar.mid - .5) < 1e-9); assert.ok(Math.abs(atFar.impostor - .5) < 1e-9);
  for (const d of [0, 10, 39, 40, 41, 80, 119, 120, 121, 200, 350, 400, 500]) {
    const w = foliageTierWeights(d, props);
    assert.ok(w.near >= -1e-9 && w.mid >= -1e-9 && w.impostor >= -1e-9, `no tier goes negative at d=${d}`);
    if (d <= 380) assert.ok(Math.abs(w.near + w.mid + w.impostor - 1) < .02, `tiers sum to 1 at d=${d}, well inside maxDistance's own fade-out`);
  }
  // Deep in impostor range the near/mid tiers are fully faded out.
  const far = foliageTierWeights(300, props);
  assert.ok(far.near < 1e-6 && far.mid < 1e-6); assert.ok(far.impostor > .99);
  // `maxDistance` is a true hard cutoff, on purpose: total coverage is allowed
  // to fall below 1 there (a plant this far is meant to vanish).
  const beyond = foliageTierWeights(500, props);
  assert.ok(beyond.near + beyond.mid + beyond.impostor < .05);
});

/** ⭐⭐ THE RECEIPT (P1-B brief, §"Receipt"): walk a camera through a 400-plant
 * scatter and check the two claims that make this "no pops" — every instant,
 * every plant's three tier weights sum back to (about) 1, and no single
 * step moves any one tier's weight by more than a quarter. This is the CPU
 * mirror of the exact formula the vertex shader evaluates
 * (`foliageMaterial.js#foliageFadeNode`, `impostorMaterial.js`'s twin) — same
 * `foliageLodBand`, same complementary smoothsteps, same per-instance-scale
 * division — so a pass here is a pass on the shader's own arithmetic. */
test("walking a camera through 400 scattered plants keeps coverage near 1 and never pops a tier by more than 0.25 in one step", () => {
  // `maxDistance` sits far past anything this walk can reach (worst case:
  // z=0 paired with the far end of a 200 m walk, divided by the smallest
  // authored scale, ~200/.85 ≈ 235 m) so the hard fade-out at the very end
  // never enters this receipt — it is a DIFFERENT, deliberate exception
  // ("tier weights are complementary..." above documents it) and not part of
  // the "no pop" claim this walk is checking.
  const props = { lodNear: 40, lodFar: 120, maxDistance: 400 };
  // Deterministic mulberry32, so the fixture never flakes.
  let state = 20260913;
  const rng = () => { state |= 0; state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const plants = Array.from({ length: 400 }, () => ({ x: (rng() - .5) * 20, z: rng() * 200, scale: .85 + rng() * .3 }));
  let previous = null;
  for (let camZ = 0; camZ <= 200; camZ += .5) {
    const weights = plants.map(plant => {
      const distance = Math.hypot(plant.x, plant.z - camZ) / plant.scale;
      return foliageTierWeights(distance, props);
    });
    for (let i = 0; i < plants.length; i++) {
      const w = weights[i];
      const sum = w.near + w.mid + w.impostor;
      assert.ok(Math.abs(sum - 1) < .02, `plant ${i} summed to ${sum} at camZ=${camZ} (maxDistance's own fade-out never enters this 0..200 m walk)`);
      if (previous) {
        const p = previous[i];
        for (const tier of ["near", "mid", "impostor"]) {
          assert.ok(Math.abs(w[tier] - p[tier]) <= .25 + 1e-9, `plant ${i}'s ${tier} weight jumped from ${p[tier]} to ${w[tier]} at camZ=${camZ}`);
        }
      }
    }
    previous = weights;
  }
});

/** ⭐⭐ THE RECEIPT, through the MEMBERSHIP path (P1-B, item 4): the test above
 * checks the weight FORMULA in isolation; this one drives an actual
 * `FoliageComponent` (real chunks, real `tierMask`, real `_commitBatches`)
 * over the same 400-plant walk and checks the weight of every tier that a
 * plant's OWN chunk actually admits it to (`chunk.tierMask`) — not every
 * tier that formula alone would want. A membership bug (a band computed too
 * narrow, a chunk's distance range measured wrong, `extendMidToImpostor`
 * wired backwards) would show up here as a plant's contained coverage
 * dropping well under 1 while the pure-formula test above stays green,
 * because that test never asks whether the render batch a plant's data was
 * actually copied into agrees with the formula at all. */
test("walking a camera through a real 400-plant component keeps each instance's OWN chunk-admitted coverage near 1", () => {
  const props = { lodNear: 40, lodFar: 120, maxDistance: 400 };
  let state = 20260913;
  const rng = () => { state |= 0; state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const placements = Array.from({ length: 400 }, (_, i) => ({
    id: `plant${i}`, position: [(rng() - .5) * 20, 0, rng() * 200], rotation: [0, 0, 0], scale: .85 + rng() * .3,
  }));
  const engine = engineFixture();
  const entity = entityFixture(engine, "receipt membership fixture");
  const component = entity.addComponent(new FoliageComponent({ species: "oak", distribution: "placements", placements,
    height: 5, width: 3, chunkSize: 24, runInEditor: true, ...props }));
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "receipt membership fixture" };
  component._buildImpostors();
  engine.camera.position.set(0, 0, 0);
  component.update();
  assert.equal(component.instances.length, 400);
  assert.ok(component.chunks.length > 1, "the 200 m spread actually forms more than one spatial chunk");
  // The scatter itself never changes during this walk (only the camera
  // does), so which chunk owns which instance is fixed for the whole test —
  // read it once from the real partition instead of re-deriving it.
  const chunkOf = new Map();
  for (const chunk of component.chunks) for (const instance of chunk.instances) chunkOf.set(instance, chunk);
  assert.equal(chunkOf.size, 400);
  let previousContained = null;
  let sawStraddle = false;
  for (let camZ = 0; camZ <= 200; camZ += .5) {
    engine.camera.position.set(0, 0, camZ);
    component.update();
    const contained = component.instances.map(instance => {
      const [x, , z] = instance.position;
      const distance = Math.hypot(x, z - camZ) / instance.scale;
      const w = foliageTierWeights(distance, props);
      const mask = chunkOf.get(instance).tierMask;
      if (mask !== 0b001 && mask !== 0b010 && mask !== 0b100) sawStraddle = true;
      return (mask & 0b001 ? w.near : 0) + (mask & 0b010 ? w.mid : 0) + (mask & 0b100 ? w.impostor : 0);
    });
    for (let i = 0; i < contained.length; i++) {
      assert.ok(Math.abs(contained[i] - 1) < .02,
        `instance ${i} (chunk mask ${chunkOf.get(component.instances[i]).tierMask}) admitted coverage ${contained[i]} at camZ=${camZ} — its own chunk did not carry every tier the formula wants`);
      if (previousContained) {
        assert.ok(Math.abs(contained[i] - previousContained[i]) <= .25 + 1e-9,
          `instance ${i}'s admitted coverage jumped from ${previousContained[i]} to ${contained[i]} at camZ=${camZ} — a mask flip popped instead of crossfaded`);
      }
    }
    previousContained = contained;
  }
  assert.ok(sawStraddle, "the walk must actually exercise the superset (some chunk straddling a band at some point), or this receipt never touches the membership path it claims to");
  entity.removeComponent("foliage");
});

/** ⭐⭐ THE HOLE-AND-DOUBLE-DRAW RECEIPT (owner's verdict, 09-13): the two
 * receipts above check the WEIGHT formula; this one checks the actual
 * per-pixel DISCARD decision (`foliageTierKeeps`) that the weight formula
 * alone cannot — testing `noise < ownWeight` in every tier independently
 * (the previous shader) sums weights to 1 correctly while still leaving a
 * band of `noise` values kept by NEITHER tier (a hole: "one mesh disappears
 * into nothing, then a new one appears") and another band kept by BOTH. A
 * pass here is a pass on the exact boolean the fragment shader evaluates.
 *
 * `foliageChunkTierMask` (not a hand-rolled per-instance test) supplies the
 * mask for every swept distance, using a real chunk-sized window
 * (`foliageCellSize`'s own species cap) centred on that distance — the exact
 * function `FoliageComponent.update()` calls to fill in `chunk.tierMask`
 * every frame, so a mask bug there would show up here too. A real
 * `FoliageComponent` scatter of 400 placed plants additionally confirms this
 * isn't a hypothetical: a straddling superset mask (0b011 / 0b110) actually
 * occurs during an ordinary camera walk over it. */
test("the complementary discard rule keeps exactly one real tier per (distance, noise) pair up to maxDistance's own fade-out, and never two", () => {
  // A different threshold triple from the two weight-formula receipts above,
  // chosen so `maxDistance`'s own fade-out band (`end ± bandEnd/2`) finishes
  // well inside the 0..350 m sweep the brief asks for, leaving room to assert
  // "none" past it too.
  const props = { species: "oak", lodNear: 45, lodFar: 130, maxDistance: 260 };
  const thresholds = foliageLodThresholds(props);
  assert.equal(thresholds.near, 45); assert.equal(thresholds.far, 130); assert.equal(thresholds.end, 260,
    "this triple is already well separated — `enforceLodGap` must be a no-op here, not silently rewriting it");

  // Confirm the superset this receipt leans on is not hypothetical: drive a
  // real 400-plant component through a real camera walk and require at least
  // one straddling mask to actually occur.
  let state = 20260913 ^ 0x5bd1e995;
  const rng = () => { state |= 0; state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const placements = Array.from({ length: 400 }, (_, i) => ({
    id: `plant${i}`, position: [(rng() - .5) * 20, 0, rng() * 350], rotation: [0, 0, 0], scale: .85 + rng() * .3,
  }));
  const engine = engineFixture();
  const entity = entityFixture(engine, "complementary discard fixture");
  const component = entity.addComponent(new FoliageComponent({
    species: "oak", distribution: "placements", placements, height: 5, width: 3, chunkSize: 60, runInEditor: true, ...props,
  }));
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "complementary discard fixture" };
  component._buildImpostors();
  let sawStraddle = false;
  for (let camZ = 0; camZ <= 350; camZ += 7) {
    engine.camera.position.set(0, 0, camZ);
    component.update();
    for (const chunk of component.chunks) if (chunk.tierMask !== 0b001 && chunk.tierMask !== 0b010 && chunk.tierMask !== 0b100) sawStraddle = true;
  }
  assert.ok(sawStraddle, "the walk must actually exercise a straddling superset mask, or this receipt never touches the case the fix is for");
  entity.removeComponent("foliage");

  // The fine (distance, noise) grid, driven by the SAME real membership
  // function (`foliageChunkTierMask`) `FoliageComponent.update()` calls every
  // frame — a real chunk-sized window (species-capped `foliageCellSize`)
  // centred on each swept distance, which the superset proof already
  // established (`foliageChunkTierMask`'s own test) contains every tier with
  // nonzero weight anywhere inside it, hence at the centre distance itself.
  const halfSpan = foliageCellSize({ species: "oak", height: 5, chunkSize: 60 }) / 2;
  const noises = [0, .05, .1, .15, .2, .25, .3, .35, .4, .45, .5, .55, .6, .65, .7, .75, .8, .85, .9, .95];
  const fadeLo = thresholds.end - thresholds.bandEnd / 2, fadeHi = thresholds.end + thresholds.bandEnd / 2;
  for (let d = 0; d <= 350; d += .25) {
    const mask = foliageChunkTierMask(Math.max(0, d - halfSpan), d + halfSpan, props);
    for (const noise of noises) {
      let keeps = 0;
      for (let tier = 0; tier < 3; tier++) {
        if (!(mask & (1 << tier))) continue;
        if (foliageTierKeeps(tier, d, noise, thresholds)) keeps++;
      }
      if (keeps > 1) assert.fail(`distance=${d} noise=${noise} mask=${mask} kept ${keeps} tiers at once — a double draw`);
      if (d >= fadeHi) { if (keeps !== 0) assert.fail(`distance=${d} noise=${noise} is past maxDistance's own fade-out but kept ${keeps}`); }
      else if (d < fadeLo) { if (keeps !== 1) assert.fail(`distance=${d} noise=${noise} mask=${mask} kept ${keeps} tiers — want exactly 1, well inside maxDistance`); }
      // Inside [fadeLo, fadeHi) coverage may genuinely fall to 0 — the same
      // deliberate "coverage drops below 1 near maxDistance" exception the
      // pure-formula receipt above already documents; "at most 1" (checked
      // unconditionally above) is the only invariant that still applies there.
    }
  }

  // The owner's verdict: crossfades must start "on a larger distance", never
  // close to the camera. No tier's transition may begin below 0.75×lodNear.
  const earliestBandStart = thresholds.near - thresholds.bandNear / 2;
  assert.ok(earliestBandStart >= 0.75 * thresholds.near - 1e-9,
    `the near band starts at ${earliestBandStart} m, closer than 0.75 × lodNear = ${0.75 * thresholds.near} m`);
});

test("the impostor arrival ramp moves its raw weight to mid and back without changing the sum", () => {
  const props = { lodNear: 20, lodFar: 60, maxDistance: 200 };
  const raw = foliageTierWeights(90, props);
  assert.ok(raw.impostor > .9);
  const notReady = foliageApplyImpostorRamp({ ...raw }, 0);
  assert.ok(notReady.impostor < 1e-9, "nothing draws impostor detail while the ramp is at 0");
  assert.ok(Math.abs(notReady.mid - (raw.mid + raw.impostor)) < 1e-9, "mid absorbs the whole leftover");
  assert.ok(Math.abs(notReady.near + notReady.mid + notReady.impostor - (raw.near + raw.mid + raw.impostor)) < 1e-9);
  const half = foliageApplyImpostorRamp({ ...raw }, .5);
  assert.ok(Math.abs(half.impostor - raw.impostor * .5) < 1e-9);
  assert.ok(Math.abs(half.mid - (raw.mid + raw.impostor * .5)) < 1e-9);
  const done = foliageApplyImpostorRamp({ ...raw }, 1);
  assert.ok(Math.abs(done.impostor - raw.impostor) < 1e-9); assert.ok(Math.abs(done.mid - raw.mid) < 1e-9);
});

test("chunk tier membership is a superset: a chunk spanning a crossfade band belongs to both tiers", () => {
  const props = { lodNear: 20, lodFar: 60, maxDistance: 200 };
  // A chunk entirely inside `near` belongs only to tier 0.
  assert.equal(foliageChunkTierMask(2, 8, props), 0b001);
  // A chunk whose distance RANGE straddles `near`'s band belongs to both 0 and 1.
  assert.equal(foliageChunkTierMask(17, 23, props), 0b011);
  // Comfortably inside `mid`, away from either band, belongs only to tier 1.
  assert.equal(foliageChunkTierMask(30, 35, props), 0b010);
  // Straddling `far` belongs to both mid and impostor.
  assert.equal(foliageChunkTierMask(57, 63, props), 0b110);
  // Deep in impostor range, away from `maxDistance`, belongs only to tier 2.
  assert.equal(foliageChunkTierMask(100, 110, props), 0b100);
  // `extendMidToImpostor` (the impostor-not-ready-yet case) folds tier 2's
  // span into tier 1's, so a chunk far past `far` still reaches the mid mesh.
  assert.equal(foliageChunkTierMask(150, 160, props, false), 0b100);
  assert.equal(foliageChunkTierMask(150, 160, props, true), 0b110);
});

/** ⭐ P1-B: `impostorRamp` was wired into both shaders (`foliageMaterial.js`,
 * `impostorMaterial.js`) but always read its `object.userData` default of 1
 * — nothing ever wrote a real value. This is the live wiring: 0 the instant
 * the bake resolves, 0.8 s later 1, and while below 1 the mid mesh must keep
 * holding the far chunk's data too (`extendMidToImpostor` in the LOD block),
 * or the shader's `midWeight = midRaw + impostorRaw*(1-ramp)` leftover would
 * have nothing to draw. */
test("impostorRamp rides mesh.userData from 0 to 1 over 0.8s once the bake resolves, and the mid tier holds the leftover meanwhile", () => {
  const engine = engineFixture();
  const entity = entityFixture(engine, "ramp fixture");
  const placements = [{ id: "far", position: [0, 0, 500], rotation: [0, 0, 0], scale: 1 }];
  const component = entity.addComponent(new FoliageComponent({ species: "oak", distribution: "placements", placements,
    height: 5, width: 3, lodNear: 20, lodFar: 60, maxDistance: 2000, runInEditor: true }));
  engine.camera.position.set(0, 2, 0); // distance ≈ 500: deep impostor territory once the bake exists.
  component.update();
  assert.equal(component.stats.impostorReady, false);
  assert.equal(component.renderMeshes[1].userData.foliageImpostorRamp, 0, "no bake yet — the ramp default of 1 must not leak through unwritten");
  assert.equal(component.chunks[0].level, 1, "the pending bake keeps the chunk on mid detail (the old level===2-forced-to-1 gate)");
  // The bake resolves.
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "ramp fixture" };
  component._buildImpostors();
  engine.deltaTime = .1;
  component.update();
  assert.equal(component.chunks[0].level, 2, "promotes to the impostor tier the instant the bake exists");
  assert.ok(component.renderMeshes[1].userData.foliageImpostorRamp < 1e-9, "ramp starts at 0 the instant the bake resolves");
  assert.ok(component.renderMeshes[2].userData.foliageImpostorRamp < 1e-9);
  assert.equal(component.chunks[0].tierMask, 0b110, "still ramping in: the mid mesh keeps this chunk's data alongside the impostor mesh");
  for (let i = 0; i < 4; i++) component.update(); // + .1s × 4 = .4s since the bake resolved
  const half = component.renderMeshes[1].userData.foliageImpostorRamp;
  assert.ok(Math.abs(half - .5) < .02, `ramp ≈ .5 at .4s, got ${half}`);
  assert.equal(component.chunks[0].tierMask, 0b110, "still mid-ramp: both tiers still hold this chunk's data");
  for (let i = 0; i < 5; i++) component.update(); // + .1s × 5 more = .9s total, past the .8s ramp
  assert.equal(component.renderMeshes[1].userData.foliageImpostorRamp, 1);
  assert.equal(component.renderMeshes[2].userData.foliageImpostorRamp, 1);
  assert.equal(component.chunks[0].tierMask, 0b100, "fully arrived: the far chunk stops duplicating into the mid mesh");
  entity.removeComponent("foliage");
});

/** Reads back what a render mesh ACTUALLY carries right now — the real
 * committed GPU-bound buffer, not `chunk.tierMask`/`commitMask` bookkeeping —
 * as `[x, z]` world positions, one per currently-committed instance slot. */
function readCommittedPositions(mesh, isImpostor) {
  const out = [];
  if (isImpostor) {
    const attr = mesh?.geometry.attributes.aCenter;
    const n = mesh?.geometry.instanceCount ?? 0;
    for (let i = 0; i < n; i++) out.push([attr.getX(i), attr.getZ(i)]);
  } else {
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const n = mesh?.count ?? 0;
    for (let i = 0; i < n; i++) { mesh.getMatrixAt(i, m); m.decompose(p, q, s); out.push([p.x, p.z]); }
  }
  return out;
}
// 5 mm buckets: far finer than any placement's real separation, far coarser
// than float32 round-trip error over this walk's ~250 m range.
function posKey(x, z) { return `${Math.round(x * 200)}:${Math.round(z * 200)}`; }

/**
 * ⭐⭐⭐ THE FULL RECEIPT (P1-B follow-up): the two "THE RECEIPT" tests above
 * check `chunk.tierMask` — a bookkeeping field — against the formula. Neither
 * can see whether the render meshes' ACTUAL buffer contents (what the GPU
 * really draws) agree with that bookkeeping once a resumable, multi-frame
 * commit is involved: a chunk can be reassigned in `tierMask` for several
 * frames before `_commitBatches`'s spread job actually finishes copying it
 * into (or out of) a tier's shared buffer. This test reads back the real
 * `instanceMatrix`/`aCenter` contents of all three render meshes on every
 * step of a 0..250 m camera walk and asks the only question that matters to
 * the user: does SOME tier's ACTUALLY-COMMITTED copy of this instance carry
 * nonzero weight everywhere the live crossfade formula wants one?
 *
 * It drives every system state the brief names: bake pending (no atlas,
 * ramp 0), bake arriving (ramp swept 0..1 across the walk by a slowed
 * clock), bake done (ramp pinned at 1 before the walk starts), and — because
 * 400 mixed-scale plants over a 30 m×230 m field at a 4 m chunk size forms
 * several hundred chunks — the >48-chunk resumable spread path the smaller
 * fixtures elsewhere never reach.
 */
test("a moving camera keeps every instance covered by an ACTUALLY-COMMITTED tier through bake-pending, bake-arriving, bake-done and the >48-chunk spread job", () => {
  const props = { lodNear: 40, lodFar: 90, maxDistance: 250 };
  let seed = 20260913;
  const rng = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Mixed scales, deliberately wide (0.35..3.5): scale-normalized distance —
  // pivotDistance / instanceScale — is what the mask AND the shader actually
  // compare to a threshold, and a chunk mixing tiny and huge plants is where
  // a mask computed from the wrong scale extreme would first show a gap.
  const placements = Array.from({ length: 400 }, (_, i) => ({
    id: `plant${i}`, position: [(rng() - .5) * 30, 0, rng() * 230], rotation: [0, 0, 0], scale: .35 + rng() * 3.15,
  }));

  function makeFixture() {
    const engine = engineFixture();
    // The camera is positioned at the walk's actual starting point BEFORE the
    // component attaches, so `onAttach`'s own internal `update(true)` already
    // commits against the position this walk cares about — matching a real
    // scene load, where the camera already sits at its resting viewpoint
    // before a layer streams in, not a synthetic teleport-right-after-attach
    // that would spend the one-time "first commit is synchronous" allowance
    // (see `_commitBatches`) on a throwaway frame nobody will ever see.
    engine.camera.position.set(0, 0, 0);
    const entity = entityFixture(engine, `full receipt ${Math.random()}`);
    const component = entity.addComponent(new FoliageComponent({
      species: "oak", distribution: "placements", placements, height: 5, width: 3, chunkSize: 4, runInEditor: true, ...props,
    }));
    component.update(true);
    assert.ok(component.chunks.length > 48, "exceeds the spread threshold — the >48-chunk job path must actually run in this fixture");
    return { engine, entity, component };
  }

  function positionIndex(component) {
    const map = new Map();
    for (let i = 0; i < component.instances.length; i++) {
      const [x, , z] = component.instances[i].position;
      map.set(posKey(x, z), i);
    }
    assert.equal(map.size, component.instances.length, "placements must be distinct enough to identify an instance back from a raw buffer read");
    return map;
  }

  function runWalk(label, { component, engine }, index) {
    let sawSpreadInFlight = false;
    for (let camZ = 0; camZ <= 250; camZ += .5) {
      engine.camera.position.set(0, 0, camZ);
      component.update();
      if (component._orderSpread?.some(job => job && !job.done)) sawSpreadInFlight = true;
      const ramp = component._impostorRamp;
      const buffers = [
        readCommittedPositions(component.renderMeshes[0], false),
        readCommittedPositions(component.renderMeshes[1], false),
        readCommittedPositions(component.renderMeshes[2], true),
      ];
      const presentIn = [new Set(), new Set(), new Set()];
      for (let tier = 0; tier < 3; tier++) {
        const seenThisTier = new Set();
        for (const [x, z] of buffers[tier]) {
          const idx = index.get(posKey(x, z));
          assert.ok(idx !== undefined, `${label}: camZ=${camZ} tier ${tier} committed an unrecognised position (${x}, ${z})`);
          assert.ok(!seenThisTier.has(idx), `${label}: camZ=${camZ} tier ${tier} committed instance ${idx} twice in one buffer (item 2d — a duplicate reads as a brighter dither, i.e. flicker)`);
          seenThisTier.add(idx);
          presentIn[tier].add(idx);
        }
      }
      for (let i = 0; i < component.instances.length; i++) {
        const [x, , z] = component.instances[i].position;
        const distance = Math.hypot(x, z - camZ) / component.instances[i].scale;
        const raw = foliageTierWeights(distance, props);
        if (raw.near + raw.mid + raw.impostor < .98) continue; // maxDistance's own deliberate fade-out — excluded per the brief
        const committedMid = raw.mid + raw.impostor * (1 - ramp);
        const committedImpostor = raw.impostor * ramp;
        const contained = (presentIn[0].has(i) ? raw.near : 0) + (presentIn[1].has(i) ? committedMid : 0) + (presentIn[2].has(i) ? committedImpostor : 0);
        assert.ok(contained >= .98 - 1e-6,
          `${label}: instance ${i} at camZ=${camZ} (normalized distance ${distance.toFixed(1)}) had only ${contained.toFixed(3)} of its weight in an actually-committed tier`);
      }
    }
    assert.ok(sawSpreadInFlight, `${label}: never actually observed the resumable spread job mid-pass — this walk must exercise that state, not just the >48-chunk chunk count`);
  }

  {
    const fixture = makeFixture();
    runWalk("bake pending", fixture, positionIndex(fixture.component));
    fixture.entity.removeComponent("foliage");
  }
  {
    const fixture = makeFixture();
    const { component, engine } = fixture;
    component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "full receipt arriving" };
    component._buildImpostors();
    const index = positionIndex(component);
    // 500 steps × 2 ms = 1 s of `_time`: the 0.8 s ramp sweeps 0..1 across
    // most of the walk instead of resolving in the very first step.
    engine.deltaTime = .002;
    runWalk("bake arriving", fixture, index);
    fixture.entity.removeComponent("foliage");
  }
  {
    const fixture = makeFixture();
    const { component, engine } = fixture;
    component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "full receipt done" };
    component._buildImpostors();
    component.update();
    component._impostorRampStart = component._time - 10; // force fully arrived before the walk starts
    const index = positionIndex(component);
    runWalk("bake done", fixture, index);
    fixture.entity.removeComponent("foliage");
  }
});

/** ⭐ P1-B item 2b: `mesh.userData.foliageLodNear/Far/End` is what
 * `.onObjectUpdate` re-reads for the shared tree/grass and impostor
 * materials — if a chunk's newly-committed render mesh became visible this
 * frame while that userData still held a previous frame's (or no) value, the
 * very first frame it draws would use the wrong threshold. `update()` writes
 * these fields to every render mesh, unconditionally, BEFORE `_commitBatches`
 * can make a previously-invisible mesh visible for the first time — this
 * pins that ordering down with a real prop change landing in the same frame
 * a mesh flips from invisible to visible. */
test("mesh.userData LOD fields already carry the CURRENT frame's thresholds the instant a render mesh first becomes visible", () => {
  const engine = engineFixture();
  const entity = entityFixture(engine, "userdata ordering fixture");
  const placements = [{ id: "p0", position: [0, 0, 50], rotation: [0, 0, 0], scale: 1 }];
  const component = entity.addComponent(new FoliageComponent({ species: "oak", distribution: "placements", placements,
    height: 5, width: 3, lodNear: 100, lodFar: 200, maxDistance: 400, runInEditor: true }));
  engine.camera.position.set(0, 0, 0);
  component.update();
  assert.equal(component.renderMeshes[1].visible, false, "the plant starts inside lodNear — the mid mesh has never been committed yet");
  // Change the threshold AND move the plant into mid-tier territory in the
  // exact same update() call.
  component.setProp("lodNear", 10);
  component.setProp("lodFar", 30);
  component.update();
  assert.equal(component.chunks[0].level, 1, "the plant is now classified as mid detail");
  assert.equal(component.renderMeshes[1].visible, true, "the mid mesh is committed and made visible for the first time on this very call");
  assert.equal(component.renderMeshes[1].userData.foliageLodFar, 30, "userData already carries THIS frame's threshold, not a stale one, on the frame the mesh is first drawn");
  assert.equal(component.renderMeshes[1].userData.foliageLodNear, 10);
  entity.removeComponent("foliage");
});

test("40 m dense grass patch no longer submits full-detail geometry across oversized cells", () => {
  const engine = engineFixture();
  const surface = surfaceFixture(engine);
  // Kept under `FOLIAGE_ORDER_SPREAD_CHUNKS` (48; `foliageBatchOrder.js`) on
  // purpose: this fixture predates that multi-frame commit path and wants a
  // single-`update()` settle, which only `commitBatchChunksFull` gives.
  surface.mesh.geometry = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
  engine.renderer = { getDrawingBufferSize: target => target.set(1300, 724) };
  engine.rendererReady = false;
  engine.camera.position.set(19, 2, 0);
  const entity = entityFixture(engine, "grass performance");
  const component = entity.addComponent(new FoliageComponent({ species: "grass", drawnGrass: false, height: .65, width: .65, distribution: "scatter", surface: surface.entity.id, density: 3, maxInstances: 10000, lodNear: 12, lodFar: 30, maxDistance: 65 }));
  const authored = structuredClone(component.props);
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "perf fixture" };
  component._buildImpostors(); component.update();
  const fullDetail = component.instances.length * component.geometries[0].index.count / 3;
  assert.equal(component.instances.length, 4800);
  assert.ok(component.chunks.length < 48, "stays under the spread threshold so one update() fully commits");
  // The chunk-relative pixel rescale that used to shrink these thresholds
  // for tiny grass blades is gone (`foliageDetailDistances` deleted per
  // P1-B); species-level `lodNear`/`lodFar` alone select less near-tier
  // detail than the old projection-based tightening did, but LOD still cuts
  // triangles well under half of all-near.
  assert.ok(component.stats.triangles < fullDetail * .45, `selected ${component.stats.triangles} vs ${fullDetail} all-near triangles`);
  assert.ok(component.stats.nearChunks > 0, "grass at the camera stays geometry");
  assert.ok(component.stats.impostorChunks > 0, "distant plants use the actual baked atlas");
  assert.equal(component.stats.culledChunks, 0, "all authored density within draw distance survives");
  assert.ok(component.stats.drawCalls <= 3, "small spatial cells share three actual render batches");
  assert.equal(component.root.children.length, 3);
  assert.ok(component.chunks.every(chunk => chunk.meshes.every(mesh => mesh.parent === null)), "chunk templates are never separately submitted");
  // P1-B superset membership: a chunk whose distance RANGE straddles a
  // crossfade band belongs to BOTH tiers it overlaps (`foliageChunkTierMask`),
  // so the committed total is the sum over chunks of instances × how many
  // tiers that chunk's `tierMask` actually sets — 4800 only when nothing
  // straddles, which this scatter's cell/band sizes do not guarantee.
  const tierCount = mask => (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0);
  const expectedCommitted = () => component.chunks.reduce((sum, chunk) => sum + chunk.instances.length * tierCount(chunk.tierMask), 0);
  assert.equal(component.renderMeshes.reduce((n,mesh,i)=>n+(i===2?mesh.geometry.instanceCount:mesh.count),0),expectedCommitted());
  assert.deepEqual(component.props, authored, "automatic detail does not rewrite saved properties");
  const meshes = component.chunks.map(chunk => chunk.meshes[0]);
  const actualMeshes=[...component.renderMeshes],versions=actualMeshes.slice(0,2).map(mesh=>mesh.instanceMatrix.version);
  engine.camera.rotation.y += .4; component.update();
  assert.deepEqual(component.chunks.map(chunk => chunk.meshes[0]), meshes, "camera rotation does not allocate instance buffers");
  assert.deepEqual(component.renderMeshes.slice(0,2).map(mesh=>mesh.instanceMatrix.version),versions,"camera rotation and wind do not upload matrices");
  engine.camera.position.set(0,2,0);component.update();
  assert.deepEqual(component.renderMeshes,actualMeshes,"LOD changes retain actual mesh/pipeline identity");
  assert.equal(component.renderMeshes.reduce((n,mesh,i)=>n+(i===2?mesh.geometry.instanceCount:mesh.count),0),expectedCommitted(),"LOD repacking matches current tier membership exactly — no instance dropped, none stuck in a stale tier");
  for(let lod=0;lod<2;lod++) {
    const expected=component.chunks.filter(chunk=>chunk.tierMask&(1<<lod)).flatMap(chunk=>chunk.instances);
    const render=component.renderMeshes[lod],matrix=new THREE.Matrix4();
    assert.equal(render.count,expected.length);
    for(let i=0;i<expected.length;i+=97){render.getMatrixAt(i,matrix);assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(new THREE.Vector3().fromArray(expected[i].position))<1e-5);}
  }
  entity.removeComponent("foliage");
});

test("species material changes rebuild the tree-specific shader without changing authored scatter", () => {
  const { component, entity } = scatterFixture();
  const grass = component.material;
  component.setProp("species", "oak"); component.update();
  assert.notEqual(component.material, grass);
  assert.ok(component.material.opacityNode, "tree coverage is present after a grass-to-tree edit");
  const oak = component.material;
  component.setProp("windSpeed", 3); component.update();
  assert.equal(component.material, oak);
  component.setProp("species", "grass"); component.update();
  assert.notEqual(component.material, oak);
  entity.removeComponent("foliage");
});

test("tree joint wind bounds follow prototype length and nonuniform world scale even in calm weather", () => {
  const engine = engineFixture(), entity = entityFixture(engine, "scaled tree");
  entity.object3D.scale.set(2,3,4);
  const component = entity.addComponent(new FoliageComponent({species:"oak",distribution:"single",height:12,width:8,windStrength:0}));
  component.update();
  const expected = 1 + .35 * component._prototypeSize * 4;
  assert.equal(component._motionMargin(), expected);
  const chunk = component.chunks[0];
  assert.ok(chunk.bounds.min.x <= chunk.detailBounds.min.x - expected + 1e-5, "culling already covers the full possible branch sweep");
  component.setProp("windStrength", 50);component.update();
  assert.equal(component._motionMargin(), expected, "clamped joint angles stay inside the envelope when wind increases");
  component.setProp("height", 24);component.update();
  assert.ok(component._motionMargin() > expected, "a taller tree reserves a longer tip sweep");
  entity.removeComponent("foliage");
});

test("new layers join the shared gust clock while detached and suspended layers stop updating", () => {
  const engine = engineFixture();engine.playing=true;engine.elapsedTime=20;
  const firstEntity=entityFixture(engine,"old grass"),secondEntity=entityFixture(engine,"new grass");
  const first=firstEntity.addComponent(new FoliageComponent({species:"grass",drawnGrass:false}));
  engine.elapsedTime=35;first.update();
  const second=secondEntity.addComponent(new FoliageComponent({species:"grass",drawnGrass:false}));
  assert.equal(first.uniforms.time.value,35);assert.equal(second.uniforms.time.value,35);
  assert.notEqual(first._time,second._time,"different component ages do not change gust phase");
  engine.playing=false;engine.elapsedTime=35.5;first.update();second.update();
  assert.equal(first.uniforms.time.value,35);assert.equal(second.uniforms.time.value,35,"editor wind stays held without Run in Editor");
  engine.playing=true;
  engine.simulationSuspended=true;engine.elapsedTime=36;first.update();second.update();
  assert.equal(first.uniforms.time.value,35);assert.equal(second.uniforms.time.value,35);
  firstEntity.removeComponent("foliage");secondEntity.removeComponent("foliage");
});

test("actual component rebuild and detach withdraw old draws but preserve resources borrowed by async warmup", async () => {
  const {component,entity}=scatterFixture();
  const oldGeometry=component.geometries[0],oldMaterial=component.material,oldMesh=component.renderMeshes[0];
  let geometryDisposals=0,materialDisposals=0,meshDisposals=0,finish;
  oldGeometry.addEventListener("dispose",()=>geometryDisposals++);
  oldMaterial.addEventListener("dispose",()=>materialDisposals++);
  oldMesh.addEventListener("dispose",()=>meshDisposals++);
  const pending=holdFoliageResources(component,()=>new Promise(resolve=>{finish=resolve;}));
  component.setProp("species","oak");component.update();
  assert.equal(oldMesh.parent,null);assert.notEqual(component.material,oldMaterial);
  assert.equal(geometryDisposals+materialDisposals+meshDisposals,0,"the compiler still owns its captured old resources");
  entity.removeComponent("foliage");assert.equal(component.root,null);
  assert.equal(geometryDisposals+materialDisposals+meshDisposals,0);
  finish();await pending;
  assert.equal(geometryDisposals,1);assert.equal(materialDisposals,1);assert.equal(meshDisposals,1);
});

test("bounded collider uniforms respect sensors, characters, removed components/entities and disabled ancestors", () => {
  const engine = engineFixture();
  const uniforms = createFoliageUniforms(), camera = new THREE.Vector3();
  const actors = [];
  for (let i = 0; i < 12; i++) {
    const entity = entityFixture(engine, `actor${i}`);
    entity.position.x = i;
    const collider = { enabled: true, props: { shape: "box", size: [1, 2, 1], autoFit: false, autoCenter: false } };
    entity.components.set("collider", collider);
    actors.push(entity);
  }
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, 0, true), 8);
  assert.equal(uniforms.colliders[7].center.value.x, 7);
  actors[0].getComponent("collider").props.isSensor = true;
  actors[1].enabled = false;
  actors[2].components.delete("collider");
  engine.entities.delete(actors[3].id);
  actors[4].components.delete("collider");
  actors[4].components.set("charactercontroller", { enabled: true, props: { radius: .4, height: 1.2 } });
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .01, true), 8);
  assert.equal(uniforms.colliders[0].center.value.x, 4);
  assert.equal(uniforms.colliders[0].center.value.w, 2, "character capsule uses the documented enclosing sphere");
  assert.ok(Math.abs(uniforms.colliders[0].x.value.w - 1) < 1e-6);
  const parent = entityFixture(engine, "hidden parent");
  actors[4].setParent(parent); parent.enabled = false;
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .02, true), 7);
  assert.equal(uniforms.colliders[0].center.value.x, 5);
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .03, false), 0);
  assert.ok(uniforms.colliders.every(row => row.center.value.w === 0));
});

test("module disable disposes existing components and callbacks; re-enable restores authored foliage once", async () => {
  const engine = engineFixture(); engine.modules = new Map();
  registerModuleDefinition(foliageModule);
  await enableEngineModule(engine, "foliage");
  const entity = entityFixture(engine, "module tree");
  const component = entity.addComponent("foliage", { seed: 734 });
  const oldRoot = component.root;
  assert.equal(engine.listenerCount("preRender"), 1);
  await disableEngineModule(engine, "foliage");
  assert.equal(component.root, null); assert.equal(oldRoot.parent, null);
  assert.equal(engine.listenerCount("preRender"), 0);
  component.setProp("height", 12);
  component.onAttach();
  assert.equal(component.root, null, "a direct attach cannot wake a disabled module");
  await enableEngineModule(engine, "foliage");
  assert.ok(component.root);
  assert.equal(component.props.seed, 734); assert.equal(component.props.height, 12);
  assert.equal(engine.listenerCount("preRender"), 1);
  await disableEngineModule(engine, "foliage");
  const missingEntity = entityFixture(engine, "saved disabled foliage");
  missingEntity.addComponent(new MissingComponent({ species: "birch", height: 9, seed: 919 }, "foliage"));
  await enableEngineModule(engine, "foliage");
  const restored = missingEntity.getComponent("foliage");
  assert.ok(restored instanceof FoliageComponent);
  assert.equal(restored.props.species, "birch"); assert.equal(restored.props.seed, 919);
  assert.ok(restored.root);
  await disableEngineModule(engine, "foliage");
  entity.removeComponent("foliage");
  missingEntity.removeComponent("foliage");
});

test("layers with different animation ages share one collider registry and actor packing per rendered frame", () => {
  const engine = engineFixture(); engine.renderer = { info: { frame: 5 } };
  const entity = entityFixture(engine, "shared actor");
  entity.components.set("collider", { enabled: true, props: { shape: "sphere", radius: 1 } });
  let reads = 0;
  const originalValues = engine.entities.values.bind(engine.entities);
  engine.entities.values = () => { reads++; return originalValues(); };
  const a = createFoliageUniforms(), b = createFoliageUniforms(), camera = new THREE.Vector3();
  updateFoliageInteractions(engine, a, camera, 200, true);
  updateFoliageInteractions(engine, b, camera, 1, true);
  updateFoliageInteractions(engine, a, camera, 200.016, true);
  updateFoliageInteractions(engine, b, camera, 1.016, true);
  assert.equal(reads, 1);
  assert.deepEqual(a.colliders[0].center.value, b.colliders[0].center.value);
  entity.position.x = 8; engine.renderer.info.frame++;
  updateFoliageInteractions(engine, a, camera, 200.032, true);
  assert.equal(a.colliders[0].center.value.x, 8);
});

test("GI override borrows foliage coverage, normals and sidedness without changing any following object's pass", () => {
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const normal = material.normalNode = { marker: "baked normal" };
  const opacity = material.opacityNode = { marker: "silhouette" };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  installFoliagePassHooks(mesh);
  const override = new THREE.MeshBasicNodeMaterial(); override.name = "GI gbuffer";
  const scene = { overrideMaterial: override };
  mesh.onBeforeRender(null, scene);
  const specialized = scene.overrideMaterial;
  assert.notEqual(specialized, override);
  assert.equal(specialized.side, THREE.DoubleSide);
  assert.equal(specialized.normalNode, normal); assert.equal(specialized.opacityNode, opacity);
  assert.equal(specialized.setupNormal, THREE.NodeMaterial.prototype.setupNormal);
  mesh.onAfterRender();
  assert.equal(scene.overrideMaterial, override);
  assert.equal(override.side, THREE.FrontSide);
  assert.equal(override.normalNode, null); assert.equal(override.opacityNode, null);
  mesh.onBeforeRender(null, scene);
  assert.equal(scene.overrideMaterial, specialized, "unchanged source/pass reuses the same material and graph");
  mesh.onAfterRender();
  const changedOpacity = material.opacityNode = { marker: "new silhouette" };
  const version = specialized.version;
  mesh.onBeforeRender(null, scene);
  assert.equal(scene.overrideMaterial, specialized);
  assert.equal(specialized.opacityNode, changedOpacity); assert.ok(specialized.version > version);
  mesh.onAfterRender();
  override.name = "Unrelated override";
  mesh.onBeforeRender(null, scene);
  assert.equal(override.normalNode, null); assert.equal(override.opacityNode, null);
  mesh.onAfterRender(); mesh.geometry.dispose(); material.dispose(); override.dispose();
});

/**
 * ── VERTEX-INPUT BUDGET (09-13, "renderPipeline_Foliage · living surface"
 * exceeded WebGPU's 16-location limit) ──────────────────────────────────────
 *
 * `foliageInstanceMatrix` used to mint a FRESH set of four
 * `instancedBufferAttribute` nodes on every call. `foliageAnimatedPosition`
 * (tree/meadow motion) and `foliageFadeNode` (the LOD crossfade) each call it
 * once per material build, and three's `NodeBuilder.getBufferAttributeFromNode`
 * dedupes buffer-attribute nodes by NODE IDENTITY, never by the underlying
 * buffer+offset — so two independently-built mat4 reads of the identical
 * mirror cost eight vertex-input locations, not four. These tests hold the
 * fix: one real mesh gets exactly one shared node, reused across every call
 * site (and, safely, across passes — see the fix's own comment).
 */
function fakeFoliageBuilder(object, uniformBufferLimit = 65536) {
  const builder = { object, getUniformBufferLimit: () => uniformBufferLimit, bufferAttributes: [] };
  // Every real call site reaches this function through its OWN fresh
  // `secureNodeBuilder` proxy (see `ShaderNode.call` in three's TSL core) —
  // never the same JS object twice, even within one build. A cache keyed on
  // the received `builder` parameter itself would never hit; wrap in a plain
  // pass-through Proxy here so the test exercises the real failure mode.
  return new Proxy(builder, { get: (target, prop, receiver) => Reflect.get(target, prop, receiver) });
}

function countBufferAttributeLeaves(node) {
  let count = 0;
  node.traverse((child) => { if (child.isBufferNode) count++; });
  return count;
}

test("⭐⭐ foliageInstanceMatrix: one mesh, one node, however many call sites read it", () => {
  const instanceMatrix = { count: 4000, array: new Float32Array(4000 * 16), usage: THREE.StaticDrawUsage };
  const mesh = { instanceMatrix };
  // Two DIFFERENT proxy wrappers of a builder pointed at the SAME mesh — the
  // exact shape `foliageAnimatedPosition`'s Fn and `foliageFadeNode`'s Fn each
  // receive for one material build.
  const fromAnimate = foliageInstanceMatrix(fakeFoliageBuilder(mesh, 4096));
  const fromFade = foliageInstanceMatrix(fakeFoliageBuilder(mesh, 4096));
  assert.equal(fromFade, fromAnimate, "both call sites must share the identical node, not just equal data");
  assert.equal(countBufferAttributeLeaves(fromAnimate), 4, "one mat4 worth of attributes — never eight");
});

test("foliageInstanceMatrix: different meshes never share a node", () => {
  const meshA = { instanceMatrix: { count: 4000, array: new Float32Array(4000 * 16), usage: THREE.StaticDrawUsage } };
  const meshB = { instanceMatrix: { count: 4000, array: new Float32Array(4000 * 16), usage: THREE.StaticDrawUsage } };
  const nodeA = foliageInstanceMatrix(fakeFoliageBuilder(meshA, 4096));
  const nodeB = foliageInstanceMatrix(fakeFoliageBuilder(meshB, 4096));
  assert.notEqual(nodeA, nodeB);
});

test("foliageInstanceMatrix: a mesh handed a NEW instanceMatrix invalidates the cached node", () => {
  const mesh = { instanceMatrix: { count: 4000, array: new Float32Array(4000 * 16), usage: THREE.StaticDrawUsage } };
  const first = foliageInstanceMatrix(fakeFoliageBuilder(mesh, 4096));
  mesh.instanceMatrix = { count: 4000, array: new Float32Array(4000 * 16), usage: THREE.StaticDrawUsage };
  const second = foliageInstanceMatrix(fakeFoliageBuilder(mesh, 4096));
  assert.notEqual(second, first, "a repartitioned chunk's new attribute must not silently reuse the stale node");
});

test("⭐ tree living-surface vertex-input budget stays at or under 14 locations", () => {
  // Geometry-level attributes are exactly what `foliageGeometry.js`'s
  // `TreeBuilder` writes for a tree species: position/color/uv/normal plus the
  // one shared tree-motion interleaved stream, exposed as four named vec4
  // attributes (treeBranch/treeBranchAxis/treeLeaf/treeLeafAxis) — `foliageWind`
  // and `foliagePart` are deliberately NOT separate attributes; they are
  // packed into `treeBranchAxis.w`/`treeLeafAxis.w` (see `TreeBuilder.finish`).
  const geometry = createFoliagePrototype({ species: "oak" }, 0);
  const attributeNames = Object.keys(geometry.attributes).sort();
  assert.deepEqual(attributeNames, ["color", "normal", "position", "treeBranch", "treeBranchAxis", "treeLeaf", "treeLeafAxis", "uv"]);
  // The instance transform costs one mat4 worth of vertex-input locations
  // once (`foliageInstanceMatrix`'s own dedup, verified above) — three's own
  // automatic per-InstancedMesh transform is a separate, framework-level
  // vertex-input cost this headless test cannot reproduce without a live
  // WebGPU pipeline build, so this budget covers what this module controls.
  const instanceMatrixLocations = 4;
  const total = attributeNames.length + instanceMatrixLocations;
  assert.ok(total <= 14, `expected at most 14 locations from geometry + one instance-matrix read, got ${total}`);
});

test("impostor billboard vertex-input budget stays well under 14 locations", () => {
  const geometry = createImpostorGeometry(8);
  const attributeNames = Object.keys(geometry.attributes).sort();
  assert.deepEqual(attributeNames, ["aAxisX", "aAxisY", "aCenter", "aSize", "normal", "position", "uv"]);
  // No instance matrix at all: the impostor batch sits at the scene root with
  // an identity transform and is driven entirely by these instanced attributes.
  assert.ok(attributeNames.length <= 14);
});

/**
 * ── VERTEX→FRAGMENT VARYING BUDGET (live receipt: fragment stage alone hit
 * 17 = 16 user-defined + front_facing, against a 16-slot limit) ─────────────
 *
 * Two independent bugs, both the same SHAPE as the vertex-attribute one
 * above — three's `getVaryingFromNode` dedupes by NODE IDENTITY, never by
 * name or by which underlying attribute/value a node reads, so anything built
 * as two separate node objects costs two varying slots even when they carry
 * identical data:
 *
 * 1. `createFoliageSurfaceMaterial` called `uv()` twice (`leafSample`,
 *    `barkSample`) — two fresh `AttributeNode`s, each independently promoted
 *    to its own fragment-stage varying. Fixed: one `uv()` call, reused.
 * 2. `createFoliageMaterial` used to carry the dither rule's `distance` AND
 *    `weight` as two separate `.toVarying()` floats (resolved down to one,
 *    `foliageDitherThreshold`, in the PREVIOUS fix), and separately let
 *    `createFoliageSurfaceMaterial` promote the leaf/bark part id
 *    (`foliagePartValue`) as its OWN varying. Both scalars now share ONE
 *    packed vec4 varying (`pack`: `.x` threshold, `.y` part id, `.z`/`.w`
 *    reserved) — one `@location`, not two.
 *
 * These are source-level regression guards: a true graph-level varying count
 * needs a live WebGPU pipeline build this headless suite cannot run — but the
 * `uv()` dedup IS graph-checkable without one, since `createFoliageSurfaceMaterial`
 * builds its colour/opacity/normal graph eagerly (unlike the Fn-deferred
 * position/fade graph), so the test below walks the REAL node graph.
 */
test("⭐ createFoliageSurfaceMaterial reads uv() exactly once — shared, not re-attributed per sample", () => {
  const material = createFoliageSurfaceMaterial({ species: "oak" });
  const uvAttributeNodes = new Set();
  for (const root of [material.colorNode, material.opacityNode, material.normalNode, material.roughnessNode]) {
    root?.traverse((node) => { if (node.type === "AttributeNode" && node._attributeName === "uv") uvAttributeNodes.add(node); });
  }
  assert.equal(uvAttributeNodes.size, 1, "leaf and bark samples must read the identical uv() node, not two separately-promoted ones");
});

test("⭐ createFoliageMaterial's dither fade and part id share ONE packed varying, not two", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/modules/foliage/foliageMaterial.js", import.meta.url), "utf8");
  const bodyStart = source.indexOf("export function createFoliageMaterial");
  const bodyEnd = source.indexOf("\nexport function", bodyStart + 1);
  const body = source.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
  // Strip comments before counting — this file's own prose mentions
  // `.toVarying()` several times to explain the fix, which would otherwise
  // inflate a naive text match.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const varyingCalls = code.match(/\.toVarying\(/g) ?? [];
  assert.equal(varyingCalls.length, 1, "the fade rule and the part id must cross as one packed vec4 varying");
  // The surface material must receive the SHARED pack's part-id component
  // rather than minting its own separate promotion.
  assert.match(code, /createFoliageSurfaceMaterial\(props, hasSurfaceTextures \? pack\.y : null\)/);
});

/**
 * ── THE THIRD RECEIPT: FRAGMENT-STAGE RAW-ATTRIBUTE LEAK VIA REPEATED VARYING
 * REBUILDS (09-13) ───────────────────────────────────────────────────────────
 *
 * Live WGSL (`profile.wgsl`) showed the compiled VaryingsStruct still carrying
 * RAW vertex attributes — `treeBranch`, `treeBranchAxis`, `treeLeaf`,
 * `treeLeafAxis`, raw `position`, raw `normal`, and `instanceIndex` — despite
 * both earlier fixes. Three's `VaryingNode.generate()` caches its "forced
 * vertex rebuild" by `(node, builder.currentStack)`, NOT by node alone
 * (`core/VaryingNode.js`): a varying referenced from N different stacks
 * re-triggers N independent rebuilds of its DEFINING EXPRESSION. Two values
 * in this material are read from more than one place, each potentially its
 * own stack:
 *
 *  - `normalView` (`transformNormalToView(normalLocal)`), read once by the
 *    framework's own `TBNViewMatrix`/`normalMap()` machinery AND once more by
 *    this material's own per-light back-diffuse term (`model.direct`, called
 *    once per light — likely one stack per light).
 *  - `pack` (this material's own fade+part-id varying), read by
 *    `material.colorNode`/`opacityNode`/`roughnessNode` (via `part` = `pack.y`)
 *    AND separately by `survives` (via `pack.x`).
 *
 * `normalLocal` is the SAME mutable var `animateTree` repeatedly `.assign()`s
 * while reading `treeBranch`/`treeLeaf`/their axes and the instance matrix
 * (which reads `instanceIndex`) — a repeated rebuild of its expression is
 * exactly the raw-attribute leak reported live. The fix pins both values with
 * an extra `.toVar()` AFTER the varying is established: a plain local variable
 * is cached per-node (not per-stack), so every later reader shares the one
 * already-built value instead of re-triggering the expensive rebuild.
 */
test("⭐ normalView and pack are pinned with .toVar() before their multiple fragment readers", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/modules/foliage/foliageMaterial.js", import.meta.url), "utf8");
  // The leaf light model moved to `foliageLighting.js` (09-14), shared with the impostor.
  const lighting = fs.readFileSync(new URL("../src/modules/foliage/foliageLighting.js", import.meta.url), "utf8");
  assert.match(source, /installFoliageLeafLighting\(material, /, "the living surface installs the shared leaf light model");
  assert.match(
    lighting, /const pinnedNormalView = normalView\.toVar\(\);/,
    "normalView must be pinned once, outside the per-light callback, before the leaf terms read it",
  );
  assert.match(
    lighting, /direct\.call\(this, light, directBuilder\);\s*const dotNL = pinnedNormalView\.dot/,
    "the leaf terms must read the PINNED normalView, not the raw singleton, inside the per-light callback",
  );
  // The packed varying must share NO node with the animated-position path: it is computed by
  // its own Fn from `foliageFadeWeightNode` (uniforms + instance matrix only) and is a plain
  // `.toVarying()` — never a `.toVar()` of a struct that also carries the wind-animated
  // position (that shared variable was generated in the fragment stage and promoted every
  // wind attribute to a varying, 09-13).
  assert.match(source, /const pack = Fn\(\(builder\) => \{\s*const fade = foliageFadeWeightNode\(builder, lod\);/, "pack computes its own fade weight");
  assert.doesNotMatch(source, /\.toVarying\(\)\.toVar\(\);/, "pack must not be pinned into a material-scope variable");
  assert.match(source, /material\.positionNode = Fn\(\(builder\) => foliageFadeNode\(builder, lod, animated\)\)\(\)\.get\("position"\);/, "position path is independent of the varying");
});

test("GI policy (2026-09-13): every render-batch tier carries the tag GISystem.js expects, per species", () => {
  // Tree/shrub population: near (lod0) and impostor (lod2) opt fully out of
  // GI seating/baking; the mid tier (lod1) is the population's one seat,
  // capped well below GISystem.js's MAX_INSTANCES_PER_MESH (256) via
  // giInstanceCap so one dense stand cannot eat the whole scene's atlas.
  const tree = scatterFixture({ species: "oak", height: 8, width: 6, density: .3, maxInstances: 200 });
  const treeAtlas = { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} };
  tree.component._atlasEntry = { atlas: treeAtlas, material: new THREE.MeshStandardNodeMaterial({ alphaTest: .35 }), refs: 1, cache: new Map(), key: "fixture" };
  tree.component._buildImpostors();
  tree.component.update();
  assert.ok(tree.component.stats.instances > 0, "the tree fixture actually populated instances");
  assert.equal(tree.component.renderMeshes.length, 3, "near/mid/impostor tiers must all exist to check their GI tags");
  const [near, mid, impostor] = tree.component.renderMeshes;
  assert.equal(near.userData.giTrace, "none", "tree near tier must never seat/bake into GI");
  assert.equal(near.userData.giMobility, "static");
  assert.equal(mid.userData.giTrace, undefined, "tree mid tier keeps the default trace — it DOES seat, just capped");
  assert.equal(mid.userData.giInstanceCap, 48, "tree mid tier's seat budget must be the foliage cap, not the full 256");
  assert.equal(impostor.userData.giTrace, "none", "impostor tier has no volume worth a GI seat");
  assert.equal(impostor.userData.giMobility, "static");

  // Meadow (grass/wildflower) populations get NO GI presence at any tier —
  // not even the mid tier's capped seat, because ground cover has no
  // trunk/canopy volume worth occluding with.
  const meadow = scatterFixture({ species: "wildflowers", height: .6, width: .5, density: .5, maxInstances: 200 });
  const meadowAtlas = { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} };
  meadow.component._atlasEntry = { atlas: meadowAtlas, material: new THREE.MeshStandardNodeMaterial({ alphaTest: .35 }), refs: 1, cache: new Map(), key: "fixture" };
  meadow.component._buildImpostors();
  meadow.component.update();
  assert.ok(meadow.component.stats.instances > 0, "the meadow fixture actually populated instances");
  assert.equal(meadow.component.renderMeshes.length, 3, "near/mid/impostor tiers must all exist to check their GI tags");
  for (const mesh of meadow.component.renderMeshes) {
    assert.equal(mesh.userData.giTrace, "none", `every meadow tier (${mesh.name}) must opt fully out of GI`);
    assert.equal(mesh.userData.giMobility, "static");
    assert.equal(mesh.userData.giInstanceCap, undefined, "a tier with giTrace:\"none\" needs no cap — it never reaches the cap check");
  }
});

test("GI policy: drawn grass field rings (grassRenderer.js, owned by a \"grass\" FoliageComponent) opt fully out of GI seating", () => {
  const { engine, component } = scatterFixture({ species: "grass", drawnGrass: true, height: .3, width: .05, density: 1 });
  component.update();
  assert.ok(component.drawsGrass, "the fixture must actually take the drawn-grass path, not the scattered one");
  assert.ok(component._grass?.rings.length > 0, "the grass renderer actually built ring meshes");
  for (const ring of component._grass.rings) {
    assert.equal(ring.mesh.userData.giTrace, "none", "a grass ring's blades are placed in the vertex shader — nothing for GI to seat");
    assert.equal(ring.mesh.userData.giMobility, "static");
  }
});
