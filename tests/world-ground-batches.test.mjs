import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { GroundBatches } from "../src/modules/world/worldStreaming.js";
import { tileIndices } from "../src/modules/terrain/terrainTile.js";

// 09-14 Complex scene: 180 of ~490 draws per frame were streamed ground tiles.
// Each LOD is one BatchedMesh of fixed-size slots.
function tile(resolution, x0) {
  const cols = resolution + 1, P = resolution * 4, count = cols * cols + P;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { positions[i * 3] = x0 + (i % cols); positions[i * 3 + 2] = Math.floor(i / cols); }
  return { positions, normals: new Float32Array(count * 3).fill(1), colors: new Float32Array(count * 3).fill(.5), indices: tileIndices(resolution), vertexCount: count, resolution };
}

test("one draw per LOD however many tiles, freed slots reused, batch regrows from live tiles", () => {
  const group = new THREE.Group(), material = new THREE.MeshStandardNodeMaterial();
  const batches = new GroundBatches(group, material, () => 2);
  const slots = [];
  for (let i = 0; i < 20; i++) slots.push(batches.add(0, tile(8, i * 8)));
  for (let i = 0; i < 12; i++) batches.add(2, tile(4, i * 8));
  batches.flush();
  assert.equal(group.children.length, 2, "two LODs → two meshes");
  assert.equal(batches.draws, 2);
  const lod0 = batches.lods.get(0);
  assert.ok(lod0.capacity >= 20 && lod0.live.size === 20);
  assert.equal(lod0.mesh.castShadow, true);
  assert.equal(batches.lods.get(2).mesh.castShadow, false);
  // Release and re-add: the slot is reused, the batch does not grow.
  const capacity = lod0.capacity, used = lod0.used;
  batches.remove(slots[3]);
  const again = batches.add(0, tile(8, 999));
  assert.equal(lod0.capacity, capacity);
  assert.equal(lod0.used, used);
  assert.equal(again.instanceId, slots[3].instanceId);
  batches.flush();
  assert.ok(lod0.mesh.boundingBox.max.x >= 999, "bounds follow the reused slot");
  batches.dispose();
  assert.equal(group.children.length, 0);
});
