import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { alignedChunkSize, chunkOffset, desiredChunks, rectDistance } from '../src/engine/world/chunkGrid.js';
import { getLandscape } from '../src/engine/terrain/landscapeGenerator.js';
import { buildTerrainTile, perimeterVertices } from '../src/modules/terrain/terrainTile.js';
import { WorldStreamer } from '../src/modules/world/worldStreaming.js';
import { createWorldDocument } from '../src/engine/world/worldDocument.js';
import { prepareWorldPlan } from '../src/modules/world/worldPlan.js';

test('the chunk grid is aligned to the World, never overlaps it, and covers the view circle', () => {
  for (const [extent, requested] of [[128, 128], [192, 128], [256, 128], [384, 64], [512, 256]]) {
    const size = alignedChunkSize(extent, requested), half = extent / 2;
    assert.ok(Number.isInteger(Math.round(extent / size)) && Math.abs(extent / size - Math.round(extent / size)) < 1e-9, `${extent}/${size} is whole`);
    const offset = chunkOffset(half, size);
    assert.ok(Math.abs(((half - offset) / size) - Math.round((half - offset) / size)) < 1e-9, 'the World edge is a chunk edge');
    const chunks = desiredChunks({ x: 30, z: -20, radius: 700, size, bounds: 1024, exclude: half });
    const keys = new Set(chunks.map(chunk => chunk.key));
    assert.equal(keys.size, chunks.length, 'no duplicate chunks');
    for (const chunk of chunks) {
      const overlapsX = Math.min(chunk.x1, half) - Math.max(chunk.x0, -half), overlapsZ = Math.min(chunk.z1, half) - Math.max(chunk.z0, -half);
      assert.ok(!(overlapsX > 1e-6 && overlapsZ > 1e-6), `chunk ${chunk.key} overlaps the authored region at ${extent} m`);
      assert.ok(chunk.distance <= 700);
    }
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].distance >= chunks[i - 1].distance, 'nearest first');
    // Every point within the radius (outside the World, inside bounds) is covered by exactly one chunk.
    for (let k = 0; k < 400; k++) {
      const a = k * 2.399, r = 690 * Math.sqrt((k + .5) / 400), px = 30 + Math.cos(a) * r, pz = -20 + Math.sin(a) * r;
      if ((Math.abs(px) < half && Math.abs(pz) < half) || Math.abs(px) > 1024 || Math.abs(pz) > 1024) continue;
      const hits = chunks.filter(chunk => px >= chunk.x0 && px < chunk.x1 && pz >= chunk.z0 && pz < chunk.z1);
      assert.equal(hits.length, 1, `point ${px.toFixed(1)},${pz.toFixed(1)} is in exactly one chunk`);
    }
    const lods = chunks.map(chunk => chunk.lod);
    // LOD follows distance; a big World pushes every streamed chunk past the
    // near ring (512 m: the closest is > 200 m away), so only small Worlds
    // must show all three rings.
    for (let i = 1; i < chunks.length; i++) assert.ok(lods[i] >= lods[i - 1], 'LOD never gets finer with distance');
    assert.ok(lods.includes(2), 'the far ring exists');
    if (half + 30 < 700 * .3) assert.ok(lods.includes(0), 'a small World is ringed by near chunks');
  }
});

test('neighbouring tiles share their border exactly: positions, normals and ground colours', () => {
  const landscape = getLandscape({ style: 'highlands', seed: 4, extent: 1024 });
  const range = { lo: -60, hi: 80 };
  const left = buildTerrainTile(landscape, { x0: 128, z0: -64, size: 64, resolution: 16, range });
  const right = buildTerrainTile(landscape, { x0: 192, z0: -64, size: 64, resolution: 16, range });
  const cols = 17;
  for (let r = 0; r < cols; r++) {
    const a = (r * cols + 16) * 3, b = (r * cols) * 3;
    for (let k = 0; k < 3; k++) {
      assert.equal(left.positions[a + k], right.positions[b + k], `position row ${r}`);
      assert.equal(left.normals[a + k], right.normals[b + k], `normal row ${r}`);
      assert.equal(left.colors[a + k], right.colors[b + k], `colour row ${r}`);
    }
  }
  // Skirt: one hanging vertex per border vertex, below it.
  const perimeter = perimeterVertices(16);
  assert.equal(left.vertexCount, cols * cols + perimeter.length);
  for (let k = 0; k < perimeter.length; k++) {
    assert.ok(left.positions[(cols * cols + k) * 3 + 1] < left.positions[perimeter[k] * 3 + 1] - 1, 'skirt hangs below its edge');
  }
  // Ground faces up.
  assert.ok(left.normals[(8 * cols + 8) * 3 + 1] > 0);
});

function drive(streamer, x, z, frames = 4000) {
  for (let i = 0; i < frames; i++) {
    streamer.update(x, z, { budgetMs: 50 });
    if (streamer.pending === 0 && !streamer.librarySteps && !streamer.rocksDirty && !streamer.job) return i;
  }
  return frames;
}

test('the streamer builds the desired chunks around the camera, evicts behind it, and disposes cleanly', () => {
  const landscape = getLandscape({ style: 'hills', seed: 3, extent: 2048, rocks: 0 });
  const parent = new THREE.Group();
  const streamer = new WorldStreamer({ parent, landscape, chunkSize: 128, radius: 400, exclude: 64, bounds: 1024 });
  assert.ok(parent.children.includes(streamer.group));
  drive(streamer, 0, 0);
  const first = streamer.stats();
  assert.equal(first.pending, 0);
  assert.equal(first.tiles, first.desired, 'every desired chunk has a tile');
  assert.ok(first.tiles > 20, `a 400 m radius loads a real ring of chunks (${first.tiles})`);
  for (const tile of streamer.tiles.values()) {
    // 09-14: ground is one BatchedMesh per LOD; each tile owns a slot in it.
    const batch = streamer.ground.lods.get(tile.lod);
    assert.ok(batch?.live.has(tile.ground) && batch.mesh.parent === streamer.group && batch.mesh.userData.giTrace === 'none');
    assert.ok(!(tile.rect.x0 >= -64 && tile.rect.x1 <= 64 && tile.rect.z0 >= -64 && tile.rect.z1 <= 64), 'the World region is not streamed over');
  }
  // One frame at the normal budget never builds more than the budget allows by much.
  streamer.update(700, 0, { budgetMs: 6 });
  drive(streamer, 700, 0);
  for (const tile of streamer.tiles.values()) assert.ok(rectDistance(700, 0, tile.rect) <= 400 + 64 + 1e-6, 'far tiles were evicted');
  assert.ok(streamer.stats().tiles >= streamer.stats().desired);
  const meshes = [...streamer.ground.lods.values()].map(batch => batch.mesh);
  assert.ok(meshes.length >= 1 && meshes.length <= 3, `one ground draw per LOD (${meshes.length})`);
  streamer.dispose();
  assert.equal(parent.children.includes(streamer.group), false);
  assert.equal(streamer.tiles.size, 0);
  assert.ok(meshes.every(mesh => !mesh.parent));
});

test('near chunks get instanced stone once the library is ready', () => {
  const landscape = getLandscape({ style: 'canyon', seed: 5, extent: 1024, rocks: .6, levels: .8 });
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 128, radius: 260, rockRadius: 260, exclude: 0, bounds: 512 });
  drive(streamer, 200, 100, 20000);
  // A second pass picks up chunks that were built before the library finished.
  drive(streamer, 200, 100, 20000);
  const stats = streamer.stats();
  assert.ok(stats.rocks > 0, `stone was placed (${JSON.stringify(stats)})`);
  // One instanced draw per (variant, distance LOD): at most three rings per variant.
  assert.ok(stats.rockDraws > 0 && stats.rockDraws <= 48, `stone is instanced (${stats.rockDraws} draws)`);
  streamer.dispose();
});

/** `#rebuildRocks` is throttled on the wall clock (250 ms); a drive that runs
 * out of frames before that can return ahead of the last re-bucket. */
function settleRocks(streamer, x, z) {
  const until = performance.now() + 5000;
  while (streamer.rocksDirty && performance.now() < until) streamer.update(x, z, { budgetMs: 50 });
  assert.equal(streamer.rocksDirty, false, 'streamed stone settled');
}

/** Every drawn streamed stone, from either path (09-14: RockBatches, or the
 * per-`kind:variant:LOD` InstancedMeshes under `__worldRockBatches = false`). */
function rockInstances(streamer) {
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), out = [];
  const push = (key, variant, lod, mesh, triangles) => {
    point.setFromMatrixPosition(matrix);
    out.push({ key, variant, lod, castShadow: mesh.castShadow, triangles, x: point.x, z: point.z, matrix: [...matrix.elements] });
  };
  if (streamer.rocks) {
    for (const [placement, { entry, id }] of streamer.rocks.instances) {
      const mesh = entry.batch.mesh;
      mesh.getMatrixAt(id, matrix);
      push(`${placement.kind}:${entry.variant.index}:${entry.lod}`, entry.variant, entry.lod, mesh, mesh.getGeometryRangeAt(entry.id).indexCount / 3);
    }
    return out;
  }
  for (const [key, { mesh }] of streamer.rockMeshes) {
    const [kind, index, lod] = key.split(':');
    const variant = streamer.library.library.variants[kind].find(v => String(v.index) === index);
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); push(key, variant, Number(lod), mesh, mesh.geometry.index.count / 3); }
  }
  return out;
}

test('⚡ streamed stone draws distance LODs and only the near rings cast shadows', () => {
  // 09-14, Complex scene: full-detail stone out to 384 m in the colour pass AND
  // the shadow map was 2.7 M triangles per pass.
  const landscape = getLandscape({ style: 'canyon', seed: 5, extent: 1024, rocks: .6, levels: .8 });
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 128, radius: 384, rockRadius: 384, exclude: 0, bounds: 512 });
  drive(streamer, 0, 0, 20000);
  drive(streamer, 0, 0, 20000);
  settleRocks(streamer, 0, 0);
  let drawn = 0, fullDetail = 0, shadow = 0;
  const lods = new Set();
  for (const { key, lod, variant, castShadow, triangles, x, z } of rockInstances(streamer)) {
    lods.add(lod);
    drawn += triangles;
    fullDetail += variant.indices.length / 3;
    if (castShadow) shadow += triangles;
    assert.equal(castShadow, lod <= 1, `${key}: only the two nearest rings cast into the shadow map`);
    const d = Math.hypot(x, z);
    if (lod === 0) assert.ok(d < 60 + 1e-6, `${key}: full detail stays inside the first ring (${d.toFixed(1)} m)`);
    if (lod === 2) assert.ok(d >= 160 - 1e-6, `${key}: the coarsest LOD starts at the second ring (${d.toFixed(1)} m)`);
  }
  assert.ok(lods.has(2), `far stone draws the coarsest LOD (${[...lods]})`);
  assert.ok(drawn < fullDetail * .5, `LODs cut the colour pass (${drawn} of ${fullDetail} triangles)`);
  assert.ok(shadow < fullDetail * .5, `and the shadow pass (${shadow} of ${fullDetail} triangles)`);
  let expected = 0;
  if (streamer.rocks) expected = streamer.rocks.bytes();
  for (const { mesh } of streamer.rockMeshes.values()) {
    const capacity = mesh.instanceMatrix.count;
    assert.ok(capacity >= 1024 && (capacity & (capacity - 1)) === 0, `${mesh.name}: stable instance capacity keeps one program per variant (${capacity})`);
    expected += mesh.instanceMatrix.array.byteLength;
  }
  for (const geometry of streamer.rockGeometries.values()) {
    for (const attribute of Object.values(geometry.attributes)) expected += attribute.array.byteLength;
    expected += geometry.index?.array.byteLength ?? 0;
  }
  assert.equal(streamer.rockBytes, expected, 'rockBytes stays exact with LOD meshes');
  // Walking re-buckets around the new viewer.
  drive(streamer, 150, 0, 20000);
  settleRocks(streamer, 150, 0);
  for (const { key, lod, x, z } of rockInstances(streamer)) {
    if (lod === 0) assert.ok(Math.hypot(x - 150, z) < 60 + 1e-6, `${key}: full detail follows the viewer`);
  }
  streamer.dispose();
});

function fakePhysics() {
  let handles = 0;
  const bodies = new Set();
  const self = {
    disposed: false, colliderEntity: new Map(), colliderLayer: new Map(),
    layers: { indexOf: name => ({ Default: 0, Ground: 4 })[name] ?? -1, groupsFor: index => index },
    forgetCollider(handle) { self.colliderEntity.delete(handle); self.colliderLayer.delete(handle); },
    RAPIER: {
      RigidBodyDesc: { fixed: () => ({ translation: null, setTranslation(x, y, z) { this.translation = [x, y, z]; return this; } }) },
      ColliderDesc: { heightfield: (rows, cols, heights, scale) => ({ rows, cols, heights, scale, setFriction() { return this; }, setCollisionGroups(g) { this.groups = g; return this; } }) },
    },
    world: {
      createRigidBody(desc) { const body = { desc }; bodies.add(body); return body; },
      createCollider(desc, body) { const collider = { desc, body, handle: ++handles }; body.collider = collider; return collider; },
      removeRigidBody(body) { bodies.delete(body); },
    },
    bodies,
  };
  return self;
}

test('near LOD-0 chunks get heightfield colliders that follow the camera and survive Stop/Play', async () => {
  const { WorldStreamPhysics } = await import('../src/modules/world/worldStreamPhysics.js');
  const landscape = getLandscape({ style: 'hills', seed: 3, extent: 2048, rocks: 0 });
  const owner = { id: 'world' };
  const colliders = new WorldStreamPhysics({ entity: owner });
  const physics = fakePhysics();
  colliders.build(physics);
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 96, radius: 600, exclude: 96, bounds: 1024, physics: colliders, physicsRadius: 160 });
  drive(streamer, 0, 0);
  const near = [...streamer.tiles.values()].filter(tile => tile.lod === 0 && rectDistance(0, 0, tile.rect) <= 160);
  assert.ok(near.length > 4, `a real ring of near chunks (${near.length})`);
  assert.equal(colliders.colliderCount, near.length, 'exactly the near LOD-0 chunks collide');
  assert.equal(physics.bodies.size, near.length);
  for (const [, entry] of colliders.live) {
    assert.equal(physics.colliderEntity.get(entry.collider.handle), owner, 'hits report the World entity');
    assert.equal(physics.colliderLayer.get(entry.collider.handle), 4, 'streamed ground is on the Ground layer');
    const { rows, cols, heights, scale } = entry.collider.desc;
    assert.equal(rows, 64); assert.equal(cols, 64); assert.equal(heights.length, 65 * 65); assert.equal(scale.x, 96);
  }
  // A body sits at its chunk centre, and its height grid is the landscape (row = z, column-major).
  const [key, entry] = colliders.live.entries().next().value;
  const tile = colliders.tiles.get(key), [bx, , bz] = entry.body.desc.translation;
  assert.equal(bx, tile.x0 + 48); assert.equal(bz, tile.z0 + 48);
  const r = 10, c = 30, expected = landscape.sample(tile.x0 + c * 1.5, tile.z0 + r * 1.5, {}).height;
  assert.ok(Math.abs(entry.collider.desc.heights[r + c * 65] - expected) < 1e-3, 'column-major height matches the landscape');
  // Walk away: colliders move with the camera.
  drive(streamer, 600, 0);
  for (const key of colliders.live.keys()) assert.ok(rectDistance(600, 0, streamer.tiles.get(key).rect) <= 160 + 1e-6);
  assert.ok(colliders.colliderCount > 4);
  // Stop: bodies freed, tiles remembered; Play: rebuilt.
  const remembered = colliders.tiles.size;
  colliders.clear();
  assert.equal(physics.bodies.size, 0);
  assert.equal(colliders.tiles.size, remembered);
  colliders.build(physics);
  assert.equal(physics.bodies.size, remembered);
  streamer.dispose();
  assert.equal(physics.bodies.size, 0, 'disposing the streamer frees every streamed collider');
});

test('streamed water: chunks draw every lake cell and river segment exactly once', async () => {
  const { buildWaterChunk } = await import('../src/engine/terrain/landscapeWater.js');
  const landscape = getLandscape({ style: 'hills', seed: 7, extent: 2048 });
  const { lakes, reaches } = landscape.hydrology;
  assert.ok(lakes.length && reaches.length, 'the fixture has lakes and rivers');
  // A 256 m window over the first lake, and one over a river's middle.
  const lake = lakes[0].bounds, river = reaches[0].points, mid = Math.floor(river.length / 10) * 5;
  const snap = v => Math.floor(v / 128) * 128;
  for (const [cx, cz] of [[(lake[0] + lake[2]) / 2, (lake[1] + lake[3]) / 2], [river[mid], river[mid + 1]]]) {
    const x0 = snap(cx) - 128, z0 = snap(cz) - 128;
    const whole = buildWaterChunk(landscape, { x0, z0, size: 256, lod: 0 });
    const parts = [[0, 0], [128, 0], [0, 128], [128, 128]].map(([dx, dz]) => buildWaterChunk(landscape, { x0: x0 + dx, z0: z0 + dz, size: 128, lod: 0 }));
    const triangles = parts.reduce((sum, part) => sum + (part ? part.indices.length / 3 : 0), 0);
    assert.ok(whole && whole.indices.length > 0, `water near ${cx.toFixed(0)},${cz.toFixed(0)}`);
    assert.equal(triangles, whole.indices.length / 3, 'four chunks draw exactly the triangles of their union');
    // Everything faces up and sits at a real water level.
    for (const part of parts.filter(Boolean)) {
      for (let t = 0; t < part.indices.length; t += 3) {
        const [a, b, c] = [part.indices[t], part.indices[t + 1], part.indices[t + 2]].map(i => i * 3);
        const e1x = part.positions[b] - part.positions[a], e1z = part.positions[b + 2] - part.positions[a + 2];
        const e2x = part.positions[c] - part.positions[a], e2z = part.positions[c + 2] - part.positions[a + 2];
        assert.ok(e1z * e2x - e1x * e2z >= 0, 'water faces up');
      }
    }
  }
});

test('streamed plants partition by chunk: four chunks place exactly the plants of their union', async () => {
  const { createLandscapeEcology } = await import('../src/engine/world/landscapeEcology.js');
  const landscape = getLandscape({ style: 'hills', seed: 7, extent: 2048 });
  const ecology = createLandscapeEcology(landscape, { seed: 7 });
  const drain = steps => { for (;;) { const s = steps.next(); if (s.done) return s.value; } };
  const key = (id, p) => `${id}:${p.position.map(v => v.toFixed(3)).join(',')}`;
  const collect = result => [...result.groups].flatMap(([id, list]) => list.map(p => key(id, p)));
  const rect = (x0, z0, size) => ({ x0, z0, x1: x0 + size, z1: z0 + size, distance: 0 });
  const union = collect(drain(ecology.placeSteps(rect(256, 256, 256)))).sort();
  const parts = [[256, 256], [384, 256], [256, 384], [384, 384]].flatMap(([x0, z0]) => collect(drain(ecology.placeSteps(rect(x0, z0, 128))))).sort();
  assert.ok(union.length > 200, `${union.length} plants in 256 m`);
  assert.equal(new Set(parts).size, parts.length, 'no plant placed twice');
  assert.deepEqual(parts, union);
  assert.ok(union.some(id => id.startsWith('oak') || id.startsWith('birch') || id.startsWith('pine')), 'trees grow');
  // Nothing grows in the water.
  const point = {};
  for (const id of union) {
    const [x, , z] = id.split(':')[1].split(',').map(Number);
    landscape.sample(x, z, point);
    assert.ok(!(Number.isFinite(point.water) && point.waterDepth > .05), `${id} stands in water`);
  }
});

test('residency: what is seen loads first, what is left behind unloads, and memory is accounted to the byte', async () => {
  const { createLandscapeEcology } = await import('../src/engine/world/landscapeEcology.js');
  const landscape = getLandscape({ style: 'hills', seed: 7, extent: 2048, rocks: 0 });
  const ecology = createLandscapeEcology(landscape, { seed: 7 });
  const fed = new Map();
  const plants = { placeSteps: ecology.placeSteps, feed: (chunk, groups) => { if (groups) fed.set(chunk, groups); else fed.delete(chunk); } };
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 128, radius: 400, plantRadius: 260, exclude: 64, bounds: 1024, plants });
  // Looking along +x: the first chunks to load are the ones in view.
  streamer.update(0, 0, { budgetMs: 0, forward: [1, 0] });
  const order = streamer.desired.filter(want => want.distance >= 128).slice(0, 8);
  assert.ok(order.every(want => want.inView), 'in-view chunks are first in line');
  drive(streamer, 0, 0);
  let stats = streamer.stats();
  assert.equal(stats.pending, 0);
  assert.ok(stats.plantChunks > 0 && stats.plants > 1000, `plants loaded (${stats.plants})`);
  assert.ok(stats.memory.ground > 0 && stats.memory.plants > 0, JSON.stringify(stats.memory));
  assert.equal(fed.size, [...streamer.tiles.values()].filter(tile => tile.plants?.groups).length, 'every loaded plant chunk was fed');
  for (const tile of streamer.tiles.values()) if (tile.plants) assert.ok(rectDistance(0, 0, tile.rect) <= 260 + 64, 'plants only within their reach');
  // Move away: behind the camera is released.
  drive(streamer, 900, 0);
  stats = streamer.stats();
  for (const [chunk] of fed) assert.ok(rectDistance(900, 0, streamer.tiles.get(chunk).rect) <= 260 + 64, `${chunk} kept plants it left behind`);
  for (const tile of streamer.tiles.values()) assert.ok(rectDistance(900, 0, tile.rect) <= 400 + 64);
  // The accounting is exact for what it counts: the sum of the live arrays.
  let ground = 0;
  const shared = new Set();
  for (const tile of streamer.tiles.values()) {
    for (const array of [tile.groundData.positions, tile.groundData.normals, tile.groundData.colors]) ground += array.byteLength;
    shared.add(tile.groundData.indices);
  }
  for (const indices of shared) ground += indices.byteLength;
  ground += streamer.ground.bytes();
  assert.equal(stats.memory.ground, ground);
  let water = 0;
  for (const tile of streamer.tiles.values()) if (tile.water) {
    for (const attribute of Object.values(tile.water.geometry.attributes)) water += attribute.array.byteLength;
    water += tile.water.geometry.index.array.byteLength;
  }
  assert.equal(stats.memory.water, water);
  // A tight budget sheds plants (then stone and water) from the lowest priority chunks.
  streamer.memoryBudget = stats.memory.total - stats.memory.plants * .8;
  streamer.update(900, 0, { budgetMs: 0 });
  assert.ok(streamer.memory().total <= streamer.memoryBudget || streamer.memory().plants === 0, 'shed down to the budget');
  streamer.dispose();
  assert.equal(fed.size, 0, 'disposing withdraws every streamed plant group');
  assert.equal(streamer.memory().total, 0);
});

test('streamed settlements: one plan per cell in any load order, level pads, graded lanes, buildings that come and go with their chunks', async () => {
  const { createLandscapeSettlements, composeLandscape } = await import('../src/engine/world/landscapeSettlements.js');
  const { StreamBuildings, buildingVariant } = await import('../src/modules/world/worldStreamBuildings.js');
  const { describeCottageStudy } = await import('../src/modules/world/worldCottage.js');
  const landscape = getLandscape({ style: 'hills', seed: 7, extent: 2048, rocks: 0 });
  const footprint = seed => describeCottageStudy({ seed: buildingVariant(seed) }).footprint;
  const make = () => createLandscapeSettlements(landscape, { seed: 7, density: 1, reserve: 192, footprint });
  const drain = steps => { for (;;) { const s = steps.next(); if (s.done) return s.value; } };
  const cells = [];
  for (let iz = -2; iz <= 1; iz++) for (let ix = -2; ix <= 1; ix++) cells.push([ix, iz]);
  const a = make(), b = make();
  for (const [ix, iz] of cells) drain(a.resolveCellSteps(ix, iz));
  for (const [ix, iz] of [...cells].reverse()) drain(b.resolveCellSteps(ix, iz));
  const list = s => s.buildingsIn(-1280, -1280, 1280, 1280).map(x => `${x.id}@${x.position.map(v => v.toFixed(3)).join(',')}`).sort();
  assert.ok(a.plans().length >= 3, `${a.plans().length} hamlets in 16 cells`);
  assert.ok(list(a).length >= 12, `${list(a).length} buildings`);
  assert.deepEqual(list(a), list(b), 'load order never changes a village');
  for (const plan of a.plans()) assert.ok(!(plan.bounds[0] < 128 && plan.bounds[2] > -128 && plan.bounds[1] < 128 && plan.bounds[3] > -128), `${plan.id} crowds the World region`);
  const ground = composeLandscape(landscape, a), out = {};
  for (const plan of a.plans()) {
    for (const pad of plan.pads) assert.ok(Math.abs(ground.sample(pad.center[0], pad.center[2], out).height - pad.center[1]) < 1e-9, `a pad of ${plan.id} is level`);
    for (const road of plan.roads) {
      const k = Math.floor(road.points.length / 2), [x, z] = road.points[k];
      ground.sample(x, z, out);
      assert.ok(Math.abs(out.height - road.elevations[k]) < 1e-6 && out.path > .9, `${road.id} is graded and marked`);
    }
  }
  for (const [x, z] of [[-1270, -1270], [1270, 1270], [0, 0], [700, -40]]) {
    if (a.plans().some(p => x >= p.bounds[0] && x <= p.bounds[2] && z >= p.bounds[1] && z <= p.bounds[3])) continue;
    assert.equal(ground.sample(x, z, {}).height, landscape.sample(x, z, {}).height, 'away from villages the ground is the landscape');
  }
  // Streamed: buildings arrive with their chunks and leave with them.
  const plan = a.plans()[0], [hx, hz] = plan.site;
  const settlements = make(), settled = composeLandscape(landscape, settlements);
  const buildings = new StreamBuildings({ nearRadius: 0 });
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape: settled, settlements, buildings, chunkSize: 128, radius: 320, buildingRadius: 320, exclude: 96, bounds: 1024 });
  drive(streamer, hx, hz);
  let stats = streamer.stats();
  assert.ok(buildings.list.filter(x => x.settlement === plan.id).length === plan.buildings.length, `${plan.id} streamed in whole (${stats.buildings} buildings)`);
  assert.ok(stats.memory.buildings > 0 && buildings.draws > 0, JSON.stringify(stats.memory));
  // No plant stands on a lane or a plot.
  const { createLandscapeEcology } = await import('../src/engine/world/landscapeEcology.js');
  const plants = drain(createLandscapeEcology(settled, { seed: 7 }).placeSteps({ x0: plan.bounds[0], z0: plan.bounds[1], x1: plan.bounds[2], z1: plan.bounds[3], distance: 0 }));
  for (const list of plants.groups.values()) for (const p of list) assert.ok(!settlements.blocked(p.position[0], p.position[2]), 'a plant on a lane or plot');
  const away = [hx > 0 ? hx - 900 : hx + 900, hz];
  drive(streamer, ...away);
  assert.ok(buildings.list.every(x => x.settlement !== plan.id), 'the village left behind is unloaded');
  streamer.dispose();
  assert.equal(buildings.farMeshes.size, 0);
  assert.equal(buildings.batches?.far.mesh ?? null, null);
  assert.equal(buildings.group.children.length, 0);
});

function withHatch(name, value, make) {
  const previous = globalThis[name];
  globalThis[name] = value;
  try { return make(); } finally { if (previous === undefined) delete globalThis[name]; else globalThis[name] = previous; }
}

/** Every drawn house part as `role|variant|matrix`, from either path. */
function buildingInstances(buildings) {
  const matrix = new THREE.Matrix4(), out = [];
  const line = (role, variant) => `${role}|${variant}|${matrix.elements.join(',')}`;
  if (buildings.batches) {
    for (const record of buildings.batches.records.values()) for (const [batch, id] of record.ids) {
      batch.mesh.getMatrixAt(id, matrix);
      out.push(line(record.near ? batch.name.split(' · ')[1] : 'far', record.variant));
    }
  } else {
    for (const [key, { mesh }] of buildings.nearMeshes) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      out.push(line(mesh.name.split(' · ').at(-1), Number(key.split(':')[0])));
    }
    for (const [key, { mesh }] of buildings.farMeshes) for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); out.push(line('far', Number(key))); }
  }
  return out.sort();
}

test('⚡ streamed houses: one batch per material role across variants, placed exactly as the per-part InstancedMeshes', async t => {
  // 09-14 Complex scene: one InstancedMesh per variant × part, never culled.
  const { StreamBuildings } = await import('../src/modules/world/worldStreamBuildings.js');
  const list = [];
  for (let i = 0; i < 24; i++) {
    const a = i * 2.399, r = 20 + i * 12;
    list.push({ id: `b${i}`, variationSeed: i * 7 + 1, position: [Math.cos(a) * r, 3, Math.sin(a) * r], rotation: [0, a, 0], scale: 1 + (i % 3) * .1 });
  }
  const make = hatch => withHatch('__worldBuildingBatches', hatch, () => new StreamBuildings({ nearRadius: 140 }));
  const batched = make(undefined), legacy = make(false);
  assert.ok(batched.batches && !legacy.batches, 'the hatch selects the path at construction');
  const settle = (x, z) => { for (const b of [batched, legacy]) { b.setBuildings(list); for (let k = 0; k < 12; k++) b.update(x, z); } };
  settle(0, 0);
  const near = buildingInstances(batched).filter(line => !line.startsWith('far')).length;
  assert.ok(near > 20 && batched.library.size >= 3, `near houses with several variants (${near} parts, ${batched.library.size} variants)`);
  assert.deepEqual(buildingInstances(batched), buildingInstances(legacy), 'same parts, variants and matrices');
  // Render objects per pass: every one of them draws in colour, GI prepass and each cascade.
  const roles = batched.batches.roles.size;
  t.diagnostic(`draw objects per pass: batched ${batched.draws}, per-part InstancedMeshes ${legacy.draws}`);
  assert.ok(batched.draws <= roles + 1, `one draw per role plus the silhouettes (${batched.draws})`);
  assert.ok(legacy.draws > roles + 1, `negative control: the per-part path fails that gate (${legacy.draws})`);
  // A borrowed role material outlives its study; nothing else keeps it alive past dispose.
  let disposed = 0;
  for (const batch of batched.batches.roles.values()) batch.material.addEventListener('dispose', () => disposed++);
  // Walk away: every house is a silhouette, the studies are released.
  settle(2000, 0);
  assert.equal(batched.library.size, 0);
  assert.equal(batched.batches.nearGeometry.size, 0);
  assert.ok([...batched.batches.roles.values()].every(batch => batch.live === 0 && !batch.mesh.visible));
  assert.equal(batched.batches.far.live, list.length);
  assert.deepEqual(buildingInstances(batched), buildingInstances(legacy));
  // And back: role batches refill their freed ranges without new materials.
  settle(0, 0);
  assert.deepEqual(buildingInstances(batched), buildingInstances(legacy));
  assert.equal(disposed, 0, 'no role material was disposed while a batch draws with it');
  assert.ok(batched.bytes > 0);
  batched.dispose(); legacy.dispose();
  assert.ok(disposed >= roles, 'dispose releases the borrowed role materials');
  assert.equal(batched.group.children.length, 0);
});

test('a streamed World region meets the streamed landscape without a step at its border', async () => {
  const { createValleyFields } = await import('../src/engine/world/landscapeFields.js');
  const { createWorldLayout } = await import('../src/engine/world/worldLayout.js');
  const terrain = { style: 'meadow', height: .7, landscapeExtent: 2048 };
  const layout = createWorldLayout({ seed: 320, extent: 192, terrain, lakeCount: 6, houseCount: 12, water: { riverCount: 2 } });
  const streamed = createValleyFields({ seed: 320, extent: 192, terrain, layout });
  const alone = createValleyFields({ seed: 320, extent: 192, terrain: { style: 'meadow', height: .7 }, layout });
  const landscape = streamed.shape.landscape, out = {};
  let worst = 0, crossed = 0;
  for (const side of [0, 1, 2, 3]) for (let t = -96; t <= 96; t += 1.5) {
    const [x, z] = [[96, t], [-96, t], [t, 96], [t, -96]][side];
    // Every border point, roads included: a road stops grading in the last few
    // metres (BORDER_EDGE), so it meets the streamed landscape too.
    const step = Math.abs(streamed.sampleHeight(x, z) - landscape.sample(x, z, out).height);
    worst = Math.max(worst, step); crossed++;
  }
  assert.ok(crossed > 500);
  assert.ok(worst < 1e-3, `the region border is the streamed landscape (worst step ${worst.toFixed(4)} m)`);
  // Away from the band nothing changes, and without streaming nothing changes at all.
  assert.equal(streamed.sampleHeight(10, -12), createValleyFields({ seed: 320, extent: 192, terrain, layout }).sampleHeight(10, -12));
  const inner = createValleyFields({ seed: 320, extent: 192, terrain: { ...terrain }, layout });
  assert.equal(inner.sampleHeight(0, 0), streamed.sampleHeight(0, 0));
  assert.ok(alone.sampleHeight(95, 0) !== undefined, 'the unstreamed field still evaluates the edge');
  // Pads stay exactly level: they are applied after the blend.
  for (const pad of layout.buildingPads) {
    const value = streamed.sample(pad.center[0], pad.center[2]);
    assert.ok(Math.abs(value.height - pad.center[1]) < 1e-9, `pad ${pad.id} is level`);
  }
  // The analytic slope inside the band still matches the surface.
  for (const [x, z] of [[90, 7.3], [-88.5, -40], [12, 91], [-30, -93]]) {
    const e = 1e-4, v = streamed.sample(x, z);
    const dx = (streamed.sampleHeight(x + e, z) - streamed.sampleHeight(x - e, z)) / (2 * e);
    const dz = (streamed.sampleHeight(x, z + e) - streamed.sampleHeight(x, z - e)) / (2 * e);
    assert.ok(Math.abs(v.slope - Math.hypot(dx, dz)) < 1e-3, `blend slope at ${x},${z}`);
  }
});

test('open dry meadow keeps its grass even where a nearby lake sits above it', async () => {
  const { sampleGrassField } = await import('../src/modules/foliage/grassField.js');
  const { FIELD_STRIDE } = await import('../src/modules/world/worldPlanData.js');
  const document = createWorldDocument({ streaming: { enabled: true, extent: 2048 }, terrain: { style: 'meadow', height: .7 },
    sky: 'off', forestDensity: 0, groundDensity: 0, layout: { lakeCount: 6 }, settlement: { editableBuildings: false } });
  const plan = prepareWorldPlan(document);
  try {
    const { grid, fieldCache } = plan, cols = grid.resolution + 1;
    let open = 0, bare = 0, belowALake = 0;
    for (let z = -grid.half + 4; z <= grid.half - 4; z += 2) for (let x = -grid.half + 4; x <= grid.half - 4; x += 2) {
      const c = Math.round((x + grid.half) / grid.step), r = Math.round((z + grid.half) / grid.step), f = (r * cols + c) * FIELD_STRIDE;
      const shore = fieldCache[f + 1], rock = fieldCache[f + 2], forest = fieldCache[f + 4], path = fieldCache[f + 5], level = fieldCache[f + 6];
      if (shore < 8 || rock > .3 || path > .05 || forest > .5) continue;
      open++;
      if (plan.heights[r * cols + c] < level + .85) belowALake++;
      if (sampleGrassField(plan.grassField, x, z).density < .08) bare++;
    }
    assert.ok(open > 300, `enough open meadow to judge (${open})`);
    assert.ok(belowALake > 0, 'the fixture really has meadow below a lake level (the case that went bare)');
    assert.ok(bare / open < .05, `open dry meadow is grassed (${bare} of ${open} bare, ${belowALake} below a lake level)`);
  } finally {
    plan.dispose();
  }
});

test('a streamed World cuts its region from the larger landscape and says so to its Terrain', () => {
  const document = createWorldDocument({ streaming: { enabled: true, extent: 1024 }, sky: 'off', forestDensity: 0, groundDensity: 0,
    grass: { enabled: false }, settlement: { editableBuildings: false } });
  const plan = prepareWorldPlan(document);
  try {
    assert.equal(plan.fields.shape.landscape.extent, 1024);
    const terrain = plan.generated.find(feature => feature.id === 'terrain');
    assert.equal(terrain.props.proceduralExtent, 1024);
  } finally {
    plan.dispose();
  }
});

test('a palette change recolours streamed ground in place, keeping every other layer', () => {
  const landscape = getLandscape({ style: 'hills', seed: 3, extent: 2048, rocks: 0 });
  const streamer = new WorldStreamer({ parent: new THREE.Group(), landscape, chunkSize: 128, radius: 300, exclude: 64, bounds: 1024 });
  drive(streamer, 0, 0);
  const tiles = new Map(streamer.tiles), before = [...streamer.tiles.values()][0].groundData.colors.slice(0, 3);
  assert.equal(streamer.setPalette(landscape.palette), false, 'the same palette is a no-op');
  assert.equal(streamer.setPalette({ ...landscape.palette, grass: '#ff00ff', soil: '#ff00ff', rock: '#ff00ff' }), true);
  assert.ok(streamer.pending > 0, 'ground re-streams');
  drive(streamer, 0, 0);
  assert.equal(streamer.pending, 0);
  for (const [key, tile] of tiles) assert.equal(streamer.tiles.get(key), tile, 'tiles are kept, not rebuilt');
  const after = [...streamer.tiles.values()][0].groundData.colors.slice(0, 3);
  assert.notDeepEqual([...after], [...before], 'ground took the new colours');
  streamer.dispose();
});
