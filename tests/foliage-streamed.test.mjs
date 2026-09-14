import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { FoliageComponent } from "../src/modules/foliage/FoliageComponent.js";
import { stableInstanceCapacity } from "../src/engine/instanceCapacity.js";

// World chunk streaming feed (09-14): `FoliageComponent.setStreamedPlacements`
// loads/unloads one streaming cell's plants without rebuilding the population.

function engineFixture() {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id);
  engine.onPreRender = fn => engine.on("preRender", fn);
  engine.camera.position.set(0, 3, 10);
  return engine;
}

function fixture(props = {}) {
  const engine = engineFixture();
  const entity = new Entity(engine, { id: "streamed trees" });
  engine.entities.set(entity.id, entity);
  entity.setParent(null);
  const component = entity.addComponent(new FoliageComponent({ species: "oak", distribution: "placements", placements: [],
    height: 5, width: 3, chunkSize: 24, lodNear: 100000, lodFar: 200000, maxDistance: 300000, runInEditor: false, ...props }));
  component.update(true);
  return { engine, entity, component };
}

/** Deterministic plants in one square streaming cell. */
function cell(ix, iz, count, size = 96, seed = 1) {
  let state = (ix * 73856093 ^ iz * 19349663 ^ seed * 83492791) >>> 0;
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: count }, () => ({ position: [ix * size + next() * size, 0, iz * size + next() * size], rotation: [0, next() * 6.28, 0], scale: .8 + next() * .4 }));
}

const groupChunks = (component, key) => component.chunks.filter(chunk => chunk.streamGroup === key);

function settle(component, frames = 20) { for (let i = 0; i < frames; i++) component.update(); }

/** Every committed near-tier matrix is a streamed plant, and every plant is committed exactly once. */
function assertNearBatchIsExactly(component) {
  const mesh = component.renderMeshes[0];
  assert.equal(mesh.count, component.instances.length, "the near batch draws every plant exactly once");
  const expected = new Map();
  for (const plant of component.instances) {
    const key = Array.from(plant.matrix.elements, Math.fround).map(v => v.toFixed(3)).join(",");
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    const key = matrix.elements.map(v => v.toFixed(3)).join(",");
    const left = expected.get(key);
    assert.ok(left > 0, `batch instance ${i} is a live plant`);
    expected.set(key, left - 1);
  }
}

test("streamed groups add, replace and remove only their own chunks", () => {
  const { component } = fixture();
  const shape = component._rebuildShape, layout = component._rebuildLayout;
  let shapeCalls = 0, layoutCalls = 0;
  component._rebuildShape = function (...args) { shapeCalls++; return shape.apply(this, args); };
  component._rebuildLayout = function (...args) { layoutCalls++; return layout.apply(this, args); };
  const prototypes = component.geometries;

  component.setStreamedPlacements("0,0", cell(0, 0, 300));
  component.setStreamedPlacements("1,0", cell(1, 0, 200));
  assert.equal(component.instances.length, 500);
  assert.equal(component.stats.streamedGroups, 2);
  assert.equal(component.stats.streamedInstances, 500);
  assert.ok(component.chunks.length > 2);
  assert.ok(component.chunks.every(chunk => chunk.streamGroup === "0,0" || chunk.streamGroup === "1,0"), "no chunk exists for anything but the two groups");
  assert.ok(component.chunks.every(chunk => chunk.key.startsWith(`${chunk.streamGroup}|`)), "chunk keys carry their group");
  assert.equal(new Set(component.chunks.map(chunk => chunk.key)).size, component.chunks.length, "chunk keys never collide");
  settle(component);
  assertNearBatchIsExactly(component);

  const keptB = groupChunks(component, "1,0"), keptBMeshes = keptB.flatMap(chunk => chunk.meshes);
  const oldA = groupChunks(component, "0,0"), oldAMeshes = oldA.flatMap(chunk => chunk.meshes);
  let disposed = 0;
  for (const mesh of oldAMeshes) { const original = mesh.dispose.bind(mesh); mesh.dispose = () => { disposed++; return original(); }; }

  component.setStreamedPlacements("0,0", cell(0, 0, 120, 96, 2));
  assert.equal(component.instances.length, 320);
  assert.equal(disposed, oldAMeshes.length, "the replaced group's meshes were released");
  assert.ok(oldA.every(chunk => !component.chunks.includes(chunk)));
  assert.deepEqual(groupChunks(component, "1,0"), keptB, "the other group's chunks are the same objects");
  assert.deepEqual(groupChunks(component, "1,0").flatMap(chunk => chunk.meshes), keptBMeshes);
  settle(component);
  assertNearBatchIsExactly(component);

  const newA = groupChunks(component, "0,0");
  component.setStreamedPlacements("0,0", null);
  assert.equal(component.instances.length, 200);
  assert.equal(component.stats.streamedGroups, 1);
  assert.ok(newA.every(chunk => !component.chunks.includes(chunk)));
  assert.deepEqual(component.chunks, keptB);
  settle(component);
  assertNearBatchIsExactly(component);

  component.setStreamedPlacements("never", []);
  component.setStreamedPlacements("never", null);
  assert.equal(component.stats.streamedGroups, 1, "removing an absent group is a no-op");

  assert.equal(shapeCalls, 0, "feeds never rebuild prototypes");
  assert.equal(layoutCalls, 0, "feeds never rebuild the population layout");
  assert.equal(component.geometries, prototypes, "the prototype geometry is untouched");
});

test("streamed plants are runtime-only and survive layout and shape rebuilds", () => {
  const authored = [{ id: "authored:oak", position: [4, 0, 4] }];
  const { component } = fixture({ placements: authored });
  component.setStreamedPlacements("2,2", cell(2, 2, 150));
  assert.equal(component.instances.length, 151);
  assert.deepEqual(component.toJSON().props.placements, authored, "serialized placements exclude streamed plants");
  assert.equal(component.props.placements.length, 1);

  component.setProp("chunkSize", 40);
  settle(component);
  assert.equal(component.instances.length, 151, "a layout rebuild keeps the streamed group");
  assert.ok(groupChunks(component, "2,2").length > 0);
  assert.equal(component.chunks.filter(chunk => chunk.streamGroup == null).reduce((sum, chunk) => sum + chunk.instances.length, 0), 1);
  assertNearBatchIsExactly(component);

  component.setProp("height", 7);
  settle(component);
  assert.equal(component.instances.length, 151, "a shape rebuild keeps the streamed group");
  assert.ok(groupChunks(component, "2,2").every(chunk => chunk.meshes[0].geometry === component.geometries[0]), "streamed chunks use the new prototypes");
  assertNearBatchIsExactly(component);

  // Moving the entity re-resolves streamed plants in its new frame on the next layout rebuild.
  component.entity.position.set(10, 0, 0);
  component.entity.object3D.updateMatrixWorld(true);
  component._layoutDirty = true;
  settle(component);
  const plant = component._streamed.get("2,2").instances[0];
  assert.ok(Math.abs(plant.position[0] - (component._streamed.get("2,2").placements[0].position[0] + 10)) < 1e-6, "local-frame placements follow the entity");
  assertNearBatchIsExactly(component);
});

test("feeds before the component is built are picked up by its first layout", () => {
  const engine = engineFixture();
  const entity = new Entity(engine, { id: "late" });
  engine.entities.set(entity.id, entity);
  entity.setParent(null);
  const component = entity.addComponent(new FoliageComponent({ species: "oak", distribution: "placements", placements: [], height: 5, width: 3, lodNear: 100000, lodFar: 200000, maxDistance: 300000 }));
  component.setStreamedPlacements("0,0", cell(0, 0, 80));
  assert.equal(component.instances.length, 80);
  settle(component);
  assert.ok(groupChunks(component, "0,0").length > 0);
  assertNearBatchIsExactly(component);
});

test("impostors exist for streamed chunks and the shared batches grow past their capacity", () => {
  const { component } = fixture({ lodNear: 10, lodFar: 30, maxDistance: 5000 });
  component.setStreamedPlacements("0,0", cell(0, 0, 10));
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial({ alphaTest: .35 }), refs: 1, cache: new Map(), key: "streamed fixture" };
  component._buildImpostors();
  settle(component);
  const firstBatch = component.renderMeshes[0];
  component.setStreamedPlacements("5,5", cell(5, 5, 2000));
  assert.ok(component.chunks.every(chunk => chunk.meshes[2]), "every chunk, streamed ones included, has an impostor mesh");
  assert.notEqual(component.renderMeshes[0], firstBatch, "an outgrown batch is replaced");
  assert.ok(component.renderMeshes[0].instanceMatrix.array.length / 16 >= 2010);
  assert.ok(component.renderMeshes[2].geometry.attributes.aCenter.count >= 2010);
  settle(component, 30);
  const near = component.renderMeshes[0].count, mid = component.renderMeshes[1].count, far = component.renderMeshes[2].geometry.instanceCount;
  assert.ok(near + mid + far >= 2010, `every plant is in some tier (${near}/${mid}/${far})`);
  assert.ok(far > 0, "far streamed plants draw as impostors");
  const loaded = component.memoryBytes();
  assert.ok(loaded.instances > 0 && loaded.impostors > 0 && loaded.prototypes > 0 && loaded.total > loaded.instances);
  component.setStreamedPlacements("5,5", null);
  const unloaded = component.memoryBytes();
  assert.ok(unloaded.total < loaded.total / 4, `unloading releases the group's bytes (${loaded.total} -> ${unloaded.total})`);
});

test("⭐ shared batch capacities come from a stable set, so growing a population keeps its shader text", () => {
  // 09-14, Complex scene: three writes a ≤1024-matrix capacity into the vertex
  // WGSL (`array< mat4x4<f32>, N >`). Exact sizes compiled a new ~44 kB program
  // per size and missed Dawn's shader cache on every boot.
  assert.deepEqual([1, 900, 1024, 1025, 3000].map(stableInstanceCapacity), [1024, 1024, 1024, 2048, 4096]);
  const { component } = fixture({ lodNear: 10, lodFar: 30, maxDistance: 5000 });
  component.setStreamedPlacements("0,0", cell(0, 0, 10));
  settle(component);
  const batch = component.renderMeshes[0];
  assert.equal(batch.instanceMatrix.count, 1024, "a small streamed population still allocates the stable floor");
  component.setStreamedPlacements("1,0", cell(1, 0, 700));
  settle(component);
  assert.equal(component.renderMeshes[0], batch, "growth inside the stable capacity keeps the same mesh, and so the same program");
  component.setStreamedPlacements("2,0", cell(2, 0, 700));
  settle(component);
  const grown = component.renderMeshes[0].instanceMatrix.count;
  assert.ok(grown > 1024 && (grown & (grown - 1)) === 0, `outgrowing it lands on a power of two (${grown})`);
});

test("cost receipt: adding one cell to a 20k-plant streamed population is far cheaper than a rebuild", () => {
  const { component } = fixture();
  let total = 0, index = 0;
  while (total < 20000) { component.setStreamedPlacements(`${index % 4},${Math.floor(index / 4)}`, cell(index % 4, Math.floor(index / 4), 1430)); total += 1430; index++; }
  settle(component, 10);
  const timed = fn => { const start = performance.now(); fn(); return performance.now() - start; };
  const adds = [], removes = [];
  for (let round = 0; round < 3; round++) {
    adds.push(timed(() => { component.setStreamedPlacements("9,9", cell(9, 9, 1500, 96, round + 3)); component.update(); }));
    removes.push(timed(() => { component.setStreamedPlacements("9,9", null); component.update(); }));
  }
  const add = Math.min(...adds), remove = Math.min(...removes);
  const rebuild = Math.min(...[0, 1, 2].map(() => timed(() => { component._layoutDirty = true; component.update(); })));
  console.log(`[foliage-streamed] ${component.instances.length} plants: add 1500 = ${add.toFixed(1)} ms, remove = ${remove.toFixed(1)} ms, full rebuild = ${rebuild.toFixed(1)} ms`);
  assert.ok(add < rebuild / 3, `adding a cell (${add.toFixed(1)} ms) is well below a full rebuild (${rebuild.toFixed(1)} ms)`);
  assert.ok(remove < rebuild / 3, `removing a cell (${remove.toFixed(1)} ms) is well below a full rebuild (${rebuild.toFixed(1)} ms)`);
  settle(component);
  assertNearBatchIsExactly(component);
});
