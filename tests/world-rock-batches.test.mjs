import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { getLandscape } from '../src/engine/terrain/landscapeGenerator.js';
import { WorldStreamer } from '../src/modules/world/worldStreaming.js';
import { InstanceBatch } from '../src/modules/world/worldInstanceBatch.js';

// 09-14 Complex scene (CPU-bound on draws): streamed stone was one InstancedMesh
// per kind:variant:LOD, each bound spanning the streamed area, so ~29 render
// objects per pass that were never culled. RockBatches: two BatchedMeshes, culled
// per stone against each pass's camera. `__worldRockBatches = false` = old path.

function withHatch(name, value, make) {
  const previous = globalThis[name];
  globalThis[name] = value;
  try { return make(); } finally { if (previous === undefined) delete globalThis[name]; else globalThis[name] = previous; }
}

function settle(streamer, x, z) {
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 20000; i++) {
    streamer.update(x, z, { budgetMs: 50 });
    if (streamer.pending === 0 && !streamer.librarySteps && !streamer.rocksDirty && !streamer.job) break;
  }
  // The re-bucket is throttled on the wall clock (250 ms).
  const until = performance.now() + 5000;
  while (streamer.rocksDirty && performance.now() < until) streamer.update(x, z, { budgetMs: 50 });
  assert.equal(streamer.rocksDirty, false, 'streamed stone settled');
}

/** Every stone as `kind:index:lod|casts|matrix`, from either path. */
function stones(streamer) {
  const matrix = new THREE.Matrix4(), out = [];
  if (streamer.rocks) {
    for (const [placement, { entry, id }] of streamer.rocks.instances) {
      entry.batch.mesh.getMatrixAt(id, matrix);
      out.push(`${placement.kind}:${entry.variant.index}:${entry.lod}|${entry.batch.mesh.castShadow}|${matrix.elements.join(',')}`);
    }
  } else {
    for (const [key, { mesh }] of streamer.rockMeshes) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      out.push(`${key}|${mesh.castShadow}|${matrix.elements.join(',')}`);
    }
  }
  return out.sort();
}

/** Stone render objects in the colour pass and in a shadow pass. */
function stoneDraws(streamer) {
  let colour = 0, shadow = 0;
  streamer.group.traverse(object => {
    if (!object.name.includes('stone') || !object.visible) return;
    if (!(object.isBatchedMesh ? object.instanceCount > 0 : object.count > 0)) return;
    colour++;
    if (object.castShadow) shadow++;
  });
  return { colour, shadow };
}

test('⚡ streamed stone: two batches hold exactly the placements, LODs and matrices of the per-variant meshes', t => {
  const landscape = getLandscape({ style: 'canyon', seed: 5, extent: 1024, rocks: .6, levels: .8 });
  const make = hatch => withHatch('__worldRockBatches', hatch, () => new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 128, radius: 384, rockRadius: 384, exclude: 0, bounds: 512 }));
  const batched = make(undefined), legacy = make(false);
  try {
    for (const [x, z] of [[0, 0], [150, 0]]) {
      settle(batched, x, z); settle(legacy, x, z);
      const a = stones(batched), b = stones(legacy);
      assert.ok(a.length > 500, `a real field of stone (${a.length})`);
      assert.ok(batched.rocks && !legacy.rocks, 'the hatch selects the path at construction');
      assert.deepEqual(a, b, `same stones at ${x},${z}`);
      assert.equal(batched.rocks.cast.live + batched.rocks.flat.live, batched.stats().rocks);
      // Render objects per frame = colour + GI prepass (all) + 3 cascades (casters).
      const on = stoneDraws(batched), off = stoneDraws(legacy);
      t.diagnostic(`at ${x},${z}: batched ${on.colour} colour / ${on.shadow} shadow objects (${on.colour * 2 + on.shadow * 3} per frame); per-variant ${off.colour} / ${off.shadow} (${off.colour * 2 + off.shadow * 3})`);
      assert.ok(on.colour <= 2 && on.shadow <= 1, `draw objects are the batches (${JSON.stringify(on)})`);
      assert.equal(batched.stats().rockDraws, on.colour);
      assert.ok(off.colour > 2, `negative control: the per-variant path fails that gate (${off.colour})`);
      assert.equal(batched.rockBytes, batched.rocks.bytes());
    }
    // A re-bucket (20 m > ROCK_LOD_STEP, no replan) moves stones between LODs
    // without resizing: same textures and geometry, so three keeps its render objects.
    const meshes = [batched.rocks.cast.mesh, batched.rocks.flat.mesh];
    const shape = () => meshes.map(mesh => [mesh._matricesTexture.uuid, mesh.geometry.uuid, mesh.maxInstanceCount]);
    const before = shape(), ids = new Map([...batched.rocks.instances].map(([placement, record]) => [placement, record.id]));
    const lodsBefore = stones(batched).map(line => line.split('|')[0]).join();
    settle(batched, 170, 0); settle(legacy, 170, 0);
    assert.equal(batched.rockViewer[0], 170, 're-bucketed around the new viewer');
    assert.notEqual(stones(batched).map(line => line.split('|')[0]).join(), lodsBefore, 'some stone changed LOD');
    assert.deepEqual(stones(batched), stones(legacy));
    assert.deepEqual(shape(), before, 'capacity stable across the re-bucket');
    let kept = 0;
    for (const [placement, record] of batched.rocks.instances) if (ids.get(placement) === record.id) kept++;
    assert.ok(kept > ids.size * .8, `stones keep their instance ids (${kept} of ${ids.size})`);
    // A palette change recolours in place.
    batched.setPalette({ ...landscape.palette, rock: '#ff0000' });
    assert.deepEqual(shape(), before, 'recolour keeps the batches');
    assert.equal(batched.rocksDirty, false);
  } finally {
    batched.dispose(); legacy.dispose();
  }
  assert.equal(batched.rocks, null);
  assert.equal(batched.group.children.length, 0);
  assert.equal(batched.memory().rocks, 0);
});

test('a batched stone off screen is culled for the viewer but kept for a shadow camera that sees it', () => {
  const group = new THREE.Group(), material = new THREE.MeshStandardNodeMaterial();
  const batch = new InstanceBatch({ group, material, name: 'stone test', castShadow: true, instances: 4 });
  const box = batch.addGeometry(new THREE.BoxGeometry(2, 2, 2));
  const ahead = batch.add(box, new THREE.Matrix4().makeTranslation(0, 0, -20));
  const behind = batch.add(box, new THREE.Matrix4().makeTranslation(0, 0, 20));
  batch.flush();
  group.updateMatrixWorld(true);
  const mesh = batch.mesh;
  const viewer = new THREE.PerspectiveCamera(60, 1, .1, 100);
  viewer.updateMatrixWorld();
  const sun = new THREE.OrthographicCamera(-40, 40, 40, -40, .1, 300);
  sun.position.set(0, 100, 0); sun.up.set(0, 0, -1); sun.lookAt(0, 0, 0);
  sun.updateMatrixWorld(); sun.updateProjectionMatrix();
  const drawn = () => [...mesh._indirectTexture.image.data.slice(0, mesh._multiDrawCount)].sort();
  mesh.onBeforeRender(null, null, viewer, mesh.geometry, material);
  assert.deepEqual(drawn(), [ahead], 'the stone behind the viewer is not drawn in colour');
  // Shadow path: three's shadow render-object function calls onBeforeShadow with the light's camera.
  mesh.onBeforeShadow(null, mesh, viewer, sun, mesh.geometry, material);
  assert.deepEqual(drawn(), [ahead, behind].sort(), 'but still casts: the shadow camera culls on its own frustum');
  // Negative control: the batch-wide bound alone (all an InstancedMesh gets) keeps both for the viewer.
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(viewer.projectionMatrix, viewer.matrixWorldInverse));
  assert.equal(frustum.intersectsObject(mesh), true, 'object-level culling alone would draw the stone behind');
  // Growth by doubling past the capacity swaps the matrices texture (a new render object) and keeps matrices.
  const uuid = mesh._matricesTexture.uuid, matrix = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) batch.add(box, new THREE.Matrix4().makeTranslation(i, 0, 0));
  assert.equal(mesh.maxInstanceCount, 8);
  assert.notEqual(mesh._matricesTexture.uuid, uuid, 'a capacity change is visible to three — the stability gate above can fail');
  mesh.getMatrixAt(behind, matrix);
  assert.equal(matrix.elements[14], 20);
  // Geometry growth compacts freed ranges before resizing.
  const geometryUuid = mesh.geometry.uuid;
  batch.deleteGeometry(box);
  assert.equal(batch.live, 0);
  batch.addGeometry(new THREE.BoxGeometry(1, 1, 1));
  assert.equal(mesh.geometry.uuid, geometryUuid, 'a freed range is reused via optimize, not a resize');
  batch.addGeometry(new THREE.SphereGeometry(1, 16, 8));
  assert.notEqual(mesh.geometry.uuid, geometryUuid, 'past the room the geometry doubles');
  batch.dispose();
  assert.equal(group.children.length, 0);
});
