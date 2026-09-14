import * as THREE from 'three/webgpu';
import { desiredChunks, rectDistance } from '../../engine/world/chunkGrid.js';
import { buildTerrainTileSteps, TILE_LOD_RESOLUTION } from '../terrain/terrainTile.js';
import { createLandscapeGroundMaterial } from '../terrain/terrainGround.js';
import { rockLibraryStepsFor, variantGeometry, createRockMaterial } from '../terrain/terrainRocks.js';
import { placeRocks } from '../../engine/rocks/rockPlacement.js';
import { instanceScale } from '../../engine/rocks/rockLibrary.js';
import { stableInstanceCapacity } from '../../engine/instanceCapacity.js';

/**
 * ⚡ ROCK DISTANCE LODS (09-14, Complex scene). Every streamed stone drew its
 * full-detail mesh out to `rockRadius` (384 m) in BOTH the colour pass and the
 * sun's shadow map: 2.7 M triangles in 10 draws per pass. The library meshes
 * ~22 % and ~5 % LODs from the same field (`lodShares`); placements bucket by
 * distance from the viewer, and only the two nearest rings cast into the
 * shadow map (which covers ~100 m around the camera anyway).
 */
const ROCK_LOD_DISTANCES = [60, 160];
const ROCK_SHADOW_MAX_LOD = 1;
/** Viewer travel (m) that re-buckets the LODs — well inside the first ring. */
const ROCK_LOD_STEP = 16;

function rockLodFor(distance, variant) {
  const lod = distance < ROCK_LOD_DISTANCES[0] ? 0 : distance < ROCK_LOD_DISTANCES[1] ? 1 : 2;
  return Math.min(lod, variant.lods?.length ?? 0);
}

/** The mesh a LOD draws. The coarsest library LOD skips cavity occlusion
 * (`buildRockLibrarySteps`: `occlusion: share > .1`), so it takes the flat
 * fallback in `variantGeometry` instead of an unfilled term. */
function rockLodMesh(variant, lod) {
  if (lod === 0) return variant;
  const mesh = variant.lods[lod - 1];
  return lod === 1 ? mesh : { ...mesh, occlusion: null };
}
import { buildWaterChunkSteps } from '../../engine/terrain/landscapeWater.js';
import { createStreamedWaterMaterial } from './worldStreamWater.js';

const MiB = 2 ** 20;
const bytesOf = (...arrays) => arrays.reduce((sum, array) => sum + (array?.byteLength ?? 0), 0);
/** Rough JS heap per placement record (object + position array + fields). */
const PLACEMENT_BYTES = 160;

/**
 * World chunk streaming (09-14, T4/T6 in docs/TERRAIN_PLAN.md). The World keeps
 * its authored central region; this streams everything AROUND it as the camera
 * moves, as a residency manager — owner: "precise memory management: we load
 * what we see, what is left behind gets unloaded".
 *
 * Every chunk carries LAYERS, each with its own reach:
 *   ground  terrain tile (LOD rings 64/32/16 cells, skirts), within `radius`
 *   water   lakes and river ribbons from the landscape hydrology, within `radius`
 *   rocks   stone placements, instanced across chunks, within `rockRadius`
 *   plants  ecology placements fed to the World's foliage populations, within
 *           `plantRadius` (the owner supplies `plants: { placeSteps, feed }`)
 * plus a heightfield collider for LOD-0 ground within `physicsRadius`.
 *
 * Loading: one sliced job at a time on the caller's frame budget, in PRIORITY
 * order — distance, with chunks outside the view cone (camera `forward`) pushed
 * back 2.5x, so what is seen fills first and turning around replans. A chunk's
 * layers build nearest-first: ground, then water, rocks, plants.
 * Unloading: a layer is released the moment its chunk leaves that layer's reach
 * (plus half a chunk of hysteresis): geometry and instance buffers disposed
 * (GPU memory), placements dropped, colliders removed, foliage groups withdrawn.
 * A memory budget (bytes) is a hard ceiling on top: over it, the lowest-priority
 * chunks lose plants, then stone, then water, and nothing new is built for them.
 * `stats().memory` reports every byte the streamer holds, per layer.
 */
/**
 * ⚡ STREAMED GROUND AS ONE DRAW PER LOD (09-14, Complex scene CPU-bound at 24 ms:
 * ~490 draws × 30 µs of encoding, 180 of them ground tiles across colour, GI
 * g-buffer and three cascades). Every tile of an LOD has the same topology
 * (`tileIndices`), so each LOD is one `BatchedMesh` of fixed-size slots: a tile
 * leaving frees its slot, the next tile of that LOD is copied into it. Tiles
 * keep their own arrays so a batch that runs out of slots re-grows from them.
 * Positions are already in the World's frame, so every instance is identity.
 * `__worldGroundBatches = false` (read when a streamer is built) keeps one mesh per tile.
 */
export class GroundBatches {
  constructor(group, material, capacityFor = () => 16) {
    this.group = group; this.material = material; this.capacityFor = capacityFor;
    this.lods = new Map();
  }

  add(lod, data) {
    let batch = this.lods.get(lod);
    if (!batch || (!batch.free.length && batch.used >= batch.capacity)) batch = this.#grow(lod, batch, data);
    const slot = { lod, geometryId: -1, instanceId: -1, data };
    this.#place(batch, slot);
    return slot;
  }

  remove(slot) {
    const batch = slot && this.lods.get(slot.lod);
    if (!batch || !batch.live.has(slot)) return;
    batch.live.delete(slot);
    batch.mesh.setVisibleAt(slot.instanceId, false);
    batch.free.push({ geometryId: slot.geometryId, instanceId: slot.instanceId });
    slot.data = null;
    batch.boundsDirty = true;
  }

  /** Once a frame: bounds for the renderer's object-level culling. */
  flush() {
    for (const batch of this.lods.values()) {
      if (!batch.boundsDirty) continue;
      batch.boundsDirty = false;
      batch.mesh.visible = batch.live.size > 0;
      if (batch.live.size) { batch.mesh.computeBoundingBox(); batch.mesh.computeBoundingSphere(); }
    }
  }

  get draws() { let n = 0; for (const batch of this.lods.values()) n += batch.live.size ? 1 : 0; return n; }

  bytes() {
    let total = 0;
    for (const batch of this.lods.values()) {
      for (const attribute of Object.values(batch.mesh.geometry.attributes)) total += attribute.array.byteLength;
      total += batch.mesh.geometry.index?.array.byteLength ?? 0;
    }
    return total;
  }

  dispose() {
    for (const batch of this.lods.values()) { batch.mesh.removeFromParent(); batch.mesh.dispose(); }
    this.lods.clear();
  }

  #place(batch, slot) {
    const geometry = groundGeometry(slot.data);
    const free = batch.free.pop();
    if (free) {
      batch.mesh.setGeometryAt(free.geometryId, geometry);
      slot.geometryId = free.geometryId; slot.instanceId = free.instanceId;
    } else {
      slot.geometryId = batch.mesh.addGeometry(geometry, batch.vertices, batch.indices);
      slot.instanceId = batch.mesh.addInstance(slot.geometryId);
      batch.used++;
    }
    batch.mesh.setVisibleAt(slot.instanceId, true);
    batch.live.add(slot);
    batch.boundsDirty = true;
  }

  #grow(lod, old, data) {
    const vertices = data.vertexCount ?? data.positions.length / 3, indices = data.indices.length;
    const capacity = Math.max(8, this.capacityFor(lod), (old?.capacity ?? 0) * 2);
    const mesh = new THREE.BatchedMesh(capacity, capacity * vertices, capacity * indices, this.material);
    mesh.name = `World ground · lod ${lod}`;
    mesh.receiveShadow = true;
    mesh.castShadow = lod === 0;
    mesh.sortObjects = false;
    mesh.userData.giTrace = 'none';
    mesh.userData.worldStreamed = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    const batch = { mesh, capacity, vertices, indices, used: 0, free: [], live: new Set(), boundsDirty: true };
    this.lods.set(lod, batch);
    if (old) {
      for (const slot of old.live) this.#place(batch, slot);
      old.mesh.removeFromParent(); old.mesh.dispose();
    }
    return batch;
  }
}

function groundGeometry(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geometry;
}

export class WorldStreamer {
  constructor({ parent, landscape, chunkSize = 128, radius = 1024, exclude = 0, bounds = Infinity, rockRadius = 384, plantRadius = 420, lodDistances = null,
    physics = null, physicsRadius = 160, memoryBudget = 512 * MiB, plants = null, style = 'natural', settlements = null, buildings = null, buildingRadius = 900 }) {
    this.landscape = landscape;
    // A WorldStreamPhysics (or anything with setTile/removeTile/has/removeAll):
    // LOD-0 chunks within `physicsRadius` get a heightfield collider.
    this.physics = physics;
    this.physicsRadius = physicsRadius;
    this.size = chunkSize; this.radius = radius; this.exclude = exclude; this.bounds = bounds;
    this.rockRadius = rockRadius; this.plantRadius = plantRadius; this.lodDistances = lodDistances;
    this.memoryBudget = memoryBudget;
    this.plants = plants;
    this.group = new THREE.Group();
    this.group.name = 'World · streamed surroundings';
    this.group.userData.worldStreamed = true;
    parent?.add(this.group);
    // Settlements (landscapeSettlements.js): `landscape` is expected to be the
    // composed one, so every layer already sees their pads and lanes; a chunk
    // resolves its settlement cells before any of its layers build.
    this.settlements = settlements;
    this.buildings = buildings;
    this.buildingRadius = buildingRadius;
    this.buildingsDirty = false;
    if (buildings) this.group.add(buildings.group);
    this.groundMaterial = createLandscapeGroundMaterial();
    this.ground = globalThis.__worldGroundBatches === false ? null
      : new GroundBatches(this.group, this.groundMaterial, lod => this.#groundCapacity(lod));
    this.rockMaterial = createRockMaterial();
    this.waterSurface = landscape.hydrology ? createStreamedWaterMaterial({ style }) : null;
    let lo = Infinity, hi = -Infinity;
    for (const h of landscape.macro?.heights ?? []) { if (h < lo) lo = h; if (h > hi) hi = h; }
    this.range = Number.isFinite(lo) ? { lo, hi } : null;
    this.clock = { deadline: 0, due() { return performance.now() >= this.deadline; } };
    this.tiles = new Map();
    this.desired = [];
    this.lastPlan = null;
    this.lastForward = null;
    this.forward = null;
    this.job = null;
    this.library = null;
    this.librarySteps = landscape.options.rocks > 0 ? rockLibraryStepsFor(landscape, 3, this.clock) : null;
    this.rockMeshes = new Map();
    this.rockGeometries = new Map();
    this.rockBytes = 0;
    this.rocksDirty = false;
    this.lastRockBuild = -Infinity;
    this.rockViewer = null;
    this.overBudget = false;
    this.disposed = false;
  }

  /**
   * Once per frame with the camera in the World's local space. `forward` is the
   * camera's horizontal view direction [x, z] in the same space (optional).
   */
  update(x, z, { budgetMs = 6, forward = null } = {}) {
    if (this.disposed) return;
    if (forward) {
      const length = Math.hypot(forward[0], forward[1]);
      this.forward = length > 1e-6 ? [forward[0] / length, forward[1] / length] : null;
    }
    const moved = !this.lastPlan || Math.hypot(x - this.lastPlan[0], z - this.lastPlan[1]) > this.size * .25;
    const turned = !!this.forward && (!this.lastForward || this.forward[0] * this.lastForward[0] + this.forward[1] * this.lastForward[1] < .94);
    if (moved || turned) {
      this.desired = this.#plan(x, z);
      this.lastPlan = [x, z];
      this.lastForward = this.forward;
      this.#evict(x, z);
    }
    const start = performance.now();
    // ⛔ The rock library used to run only when no tile job was left in the
    // frame, so while ~260 tiles loaded it got nothing: the first settle took
    // 7227 frames (~2 min at 60 fps) before any streamed stone appeared. It now
    // takes the first 40 % of the budget until it is built.
    if (this.librarySteps) {
      this.clock.deadline = start + budgetMs * .4;
      while (this.librarySteps && !this.clock.due()) {
        const result = this.librarySteps.next();
        if (result.done) { this.library = result.value; this.librarySteps = null; }
      }
    }
    this.clock.deadline = start + budgetMs;
    if (!this.job) this.job = this.#nextJob();
    while (this.job && !this.clock.due()) {
      const result = this.job.steps.next();
      if (!result.done) continue;
      this.#commit(this.job, result.value);
      this.job = this.#nextJob();
    }
    if (this.rockViewer && this.rockMeshes.size && Math.hypot(x - this.rockViewer[0], z - this.rockViewer[1]) > ROCK_LOD_STEP) this.rocksDirty = true;
    if (this.rocksDirty && this.library && performance.now() - this.lastRockBuild > 250) this.#rebuildRocks(x, z);
    this.ground?.flush();
    if (this.buildings) {
      if (this.buildingsDirty) { this.buildingsDirty = false; this.buildings.setBuildings([...this.tiles.values()].flatMap(tile => tile.buildings ?? [])); }
      this.buildings.update(x, z);
    }
    this.#enforceBudget();
  }

  /**
   * A new ground palette (09-14, owner: "why do we reload the whole world when I
   * change the colour of terrain"). Colours are baked per tile, so ground
   * re-streams nearest-first into its existing batch slots and stones recolour;
   * water, plants, buildings and colliders are kept. Returns whether it changed.
   */
  setPalette(palette) {
    const next = JSON.stringify(palette ?? {});
    if (next === JSON.stringify(this.landscape.palette ?? {})) return false;
    this.landscape = Object.freeze({ ...this.landscape, palette: { ...palette } });
    for (const tile of this.tiles.values()) tile.stale = true;
    if (this.job?.layer === 'ground') this.job = null;
    for (const entry of this.rockMeshes.values()) { entry.mesh.removeFromParent(); entry.mesh.dispose(); }
    this.rockMeshes.clear();
    for (const geometry of this.rockGeometries.values()) geometry.dispose();
    this.rockGeometries.clear();
    this.rocksDirty = true;
    return true;
  }

  /** Advance animated materials (water ripples). */
  tick(seconds) { this.waterSurface?.update(seconds); }

  /** Desired chunks with at least one layer still to build. */
  get pending() {
    return this.desired.filter(want => this.#missingLayer(want, this.tiles.get(want.key), true)).length;
  }

  /** Every byte the streamer holds, per layer (CPU arrays mirror their GPU buffers). */
  memory() {
    const out = { ground: 0, water: 0, rocks: this.rockBytes, plants: 0, physics: 0 };
    const sharedIndices = new Set();
    for (const tile of this.tiles.values()) {
      out.ground += tile.groundBytes ?? 0;
      out.water += tile.waterBytes ?? 0;
      out.rocks += (tile.placements?.length ?? 0) * PLACEMENT_BYTES;
      out.plants += tile.plants?.bytes ?? 0;
      out.physics += tile.heights?.byteLength ?? 0;
      if (tile.mesh) sharedIndices.add(tile.mesh.geometry.index.array);
      else if (tile.groundData) sharedIndices.add(tile.groundData.indices);
    }
    for (const indices of sharedIndices) out.ground += indices.byteLength;
    out.ground += this.ground?.bytes() ?? 0;
    out.buildings = this.buildings?.bytes ?? 0;
    out.sites = this.settlements?.bytes() ?? 0;
    out.total = out.ground + out.water + out.rocks + out.plants + out.physics + out.buildings + out.sites;
    out.budget = this.memoryBudget;
    return out;
  }

  stats() {
    let triangles = 0, rocks = 0, waterChunks = 0, waterTriangles = 0, plantChunks = 0, plants = 0;
    for (const tile of this.tiles.values()) {
      triangles += tile.triangles ?? 0; rocks += tile.placements?.length ?? 0;
      if (tile.water) { waterChunks++; waterTriangles += tile.water.geometry.index.count / 3; }
      if (tile.plants) { plantChunks++; plants += tile.plants.count; }
    }
    return {
      tiles: this.tiles.size, desired: this.desired.length, pending: this.pending, triangles, rocks,
      rockDraws: [...this.rockMeshes.values()].filter(entry => entry.mesh.count > 0).length,
      waterChunks, waterTriangles, plantChunks, plants, overBudget: this.overBudget,
      buildings: this.buildings?.count ?? 0, hamlets: this.settlements?.plans().length ?? 0,
      inView: this.desired.filter(want => want.inView).length, memory: this.memory(),
    };
  }

  /** Slots an LOD's batch starts with: every chunk that LOD's band can hold, with room for the eviction ring. */
  #groundCapacity(lod) {
    const lods = this.lodDistances ?? [this.radius * .3, this.radius * .6];
    const chunks = desiredChunks({ x: 0, z: 0, radius: this.radius + this.size, size: this.size, bounds: this.bounds, exclude: this.exclude, lodDistances: lods });
    return Math.ceil(chunks.filter(want => want.lod === lod).length * 1.5) + 8;
  }

  #plan(x, z) {
    const chunks = desiredChunks({ x, z, radius: this.radius, size: this.size, bounds: this.bounds, exclude: this.exclude, lodDistances: this.lodDistances });
    for (const want of chunks) {
      const dx = (want.x0 + want.x1) / 2 - x, dz = (want.z0 + want.z1) / 2 - z, d = Math.hypot(dx, dz);
      // Within a chunk of the camera everything counts as seen: it is where
      // the camera turns next, and it is under the player's feet.
      want.inView = !this.forward || want.distance < this.size || (dx * this.forward[0] + dz * this.forward[1]) / (d || 1) > .34;
      want.priority = want.distance * (want.inView ? 1 : 2.5);
    }
    chunks.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
    return chunks;
  }

  #missingLayer(want, tile, ignoreBudget = false) {
    if (this.settlements && !this.settlements.resolvedRect(want)) return 'sites';
    if (!tile || tile.lod !== want.lod || tile.stale) return 'ground';
    const room = ignoreBudget || !this.overBudget;
    if (this.waterSurface && tile.waterLod !== want.lod && room) return 'water';
    if (this.buildings && want.distance <= this.buildingRadius && !tile.buildings) return 'buildings';
    if (this.landscape.options.rocks > 0 && want.distance <= this.rockRadius && !tile.placements && (this.library || ignoreBudget) && room) return 'rocks';
    if (this.plants && want.distance <= this.plantRadius && !tile.plants && room) return 'plants';
    return null;
  }

  #nextJob() {
    for (const want of this.desired) {
      const layer = this.#missingLayer(want, this.tiles.get(want.key));
      if (layer) return this.#makeJob(want, layer);
    }
    return null;
  }

  #makeJob(want, layer) {
    const streamer = this, rect = { x0: want.x0, z0: want.z0, size: want.size };
    const steps = (function* () {
      if (layer === 'sites') return yield* streamer.settlements.resolveRectSteps(want);
      if (layer === 'ground') return yield* buildTerrainTileSteps(streamer.landscape, { ...rect, resolution: TILE_LOD_RESOLUTION[want.lod], range: streamer.range }, streamer.clock);
      if (layer === 'water') return yield* buildWaterChunkSteps(streamer.landscape, { ...rect, lod: want.lod }, streamer.clock);
      if (layer === 'buildings') return streamer.settlements.buildingsIn(want.x0, want.z0, want.x1, want.z1);
      if (layer === 'rocks') return placeRocks(streamer.landscape, { x0: want.x0, z0: want.z0, size: want.size, variants: streamer.library.kinds,
        ...(streamer.settlements ? { accept: (x, z) => !streamer.settlements.blocked(x, z) } : {}) });
      return yield* streamer.plants.placeSteps(want, streamer.clock);
    })();
    return { key: want.key, want, layer, steps };
  }

  #commit(job, data) {
    const { key, want, layer } = job;
    if (layer === 'sites') return;
    const tile = this.tiles.get(key) ?? { key, lod: -1, waterLod: -1, mesh: null, water: null, placements: null, plants: null, buildings: null, triangles: 0 };
    this.tiles.set(key, tile);
    if (layer === 'ground') { tile.stale = false; this.#commitGround(tile, want, data); }
    else if (layer === 'water') this.#commitWater(tile, want, data);
    else if (layer === 'buildings') { tile.buildings = data; this.buildingsDirty = true; }
    else if (layer === 'rocks') { tile.placements = data; this.rocksDirty = true; }
    else {
      tile.plants = data ?? { count: 0, bytes: 0, groups: null };
      if (data?.groups) this.plants.feed(key, data.groups);
    }
    this.#syncTilePhysics(tile, want.distance);
  }

  #commitGround(tile, want, data) {
    if (this.ground) {
      if (tile.ground) this.ground.remove(tile.ground);
      tile.ground = this.ground.add(want.lod, data);
      this.#finishGround(tile, want, data);
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(data.x0, data.minY, data.z0), new THREE.Vector3(data.x0 + data.size, data.maxY, data.z0 + data.size));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geometry, this.groundMaterial);
    mesh.name = `World chunk ${tile.key} · lod ${want.lod}`;
    mesh.receiveShadow = true;
    mesh.castShadow = want.lod === 0;
    mesh.userData.giTrace = 'none';
    mesh.userData.worldStreamed = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (tile.mesh) { tile.mesh.removeFromParent(); tile.mesh.geometry.dispose(); }
    this.group.add(mesh);
    tile.mesh = mesh;
    this.#finishGround(tile, want, data);
  }

  #finishGround(tile, want, data) {
    // LOD 0 keeps its heights for a collider; coarser rings never collide.
    let heights = null;
    if (want.lod === 0) {
      const cols = data.resolution + 1;
      heights = new Float32Array(cols * cols);
      for (let i = 0; i < heights.length; i++) heights[i] = data.positions[i * 3 + 1];
    }
    Object.assign(tile, { lod: want.lod, size: want.size, resolution: data.resolution, heights, groundData: this.ground ? data : null,
      rect: { x0: want.x0, z0: want.z0, x1: want.x1, z1: want.z1 }, triangles: data.indices.length / 3,
      groundBytes: bytesOf(data.positions, data.normals, data.colors) });
  }

  #commitWater(tile, want, data) {
    this.#releaseWater(tile);
    tile.waterLod = want.lod;
    if (!data) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('waterFlow', new THREE.BufferAttribute(data.flow, 2));
    geometry.setAttribute('waterDepth', new THREE.BufferAttribute(data.depth, 1));
    geometry.setAttribute('waterEdge', new THREE.BufferAttribute(data.edge, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(data.x0 - 20, data.minY, data.z0 - 20), new THREE.Vector3(data.x0 + data.size + 20, data.maxY, data.z0 + data.size + 20));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geometry, this.waterSurface.material);
    mesh.name = `World water ${tile.key} · lod ${want.lod}`;
    mesh.receiveShadow = true;
    mesh.userData.giTrace = 'none';
    mesh.userData.worldStreamed = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    tile.water = mesh;
    tile.waterBytes = bytesOf(data.positions, data.normals, data.flow, data.depth, data.edge, data.indices);
  }

  #releaseWater(tile) {
    if (tile.water) { tile.water.removeFromParent(); tile.water.geometry.dispose(); }
    tile.water = null; tile.waterBytes = 0; tile.waterLod = -1;
  }

  #releasePlants(tile) {
    if (tile.plants?.groups) this.plants?.feed(tile.key, null);
    tile.plants = null;
  }

  #releaseRocks(tile) {
    if (tile.placements?.length) this.rocksDirty = true;
    tile.placements = null;
  }

  #syncTilePhysics(tile, distance) {
    if (!this.physics) return;
    const near = tile.lod === 0 && !!tile.heights && distance <= this.physicsRadius;
    if (near && !this.physics.has(tile.key)) {
      this.physics.setTile(tile.key, { heights: tile.heights, resolution: tile.resolution, size: tile.size, x0: tile.rect.x0, z0: tile.rect.z0 });
    } else if (!near && this.physics.has(tile.key)) {
      this.physics.removeTile(tile.key);
    }
  }

  #evict(x, z) {
    const slack = this.size * .5;
    for (const [key, tile] of this.tiles) {
      const distance = tile.rect ? rectDistance(x, z, tile.rect) : Infinity;
      if (distance > this.radius + slack) {
        tile.mesh?.removeFromParent();
        tile.mesh?.geometry.dispose();
        if (tile.ground) this.ground?.remove(tile.ground);
        this.#releaseWater(tile);
        this.#releaseRocks(tile);
        this.#releasePlants(tile);
        if (tile.buildings) this.buildingsDirty = true;
        this.physics?.removeTile(key);
        this.tiles.delete(key);
        if (this.job?.key === key) this.job = null;
        continue;
      }
      if (tile.buildings && distance > this.buildingRadius + slack) { tile.buildings = null; this.buildingsDirty = true; }
      if (tile.placements && distance > this.rockRadius + slack) this.#releaseRocks(tile);
      if (tile.plants && distance > this.plantRadius + slack) this.#releasePlants(tile);
      if (this.job?.key === key && ((this.job.layer === 'rocks' && distance > this.rockRadius + slack) || (this.job.layer === 'plants' && distance > this.plantRadius + slack))) this.job = null;
      this.#syncTilePhysics(tile, distance);
    }
    // Settlement plans far behind are forgotten; they re-plan identically.
    this.settlements?.prune(x, z, this.radius + this.size);
  }

  /** Over the ceiling: the lowest-priority chunks give up plants, then stone, then water. */
  #enforceBudget() {
    let total = this.memory().total;
    this.overBudget = total > this.memoryBudget;
    if (!this.overBudget) return;
    const priority = new Map(this.desired.map(want => [want.key, want.priority]));
    const order = [...this.tiles.values()].sort((a, b) => (priority.get(b.key) ?? Infinity) - (priority.get(a.key) ?? Infinity));
    for (const layer of ['plants', 'rocks', 'water']) {
      for (const tile of order) {
        if (total <= this.memoryBudget * .9) return;
        if (layer === 'plants' && tile.plants) { total -= tile.plants.bytes ?? 0; this.#releasePlants(tile); }
        else if (layer === 'rocks' && tile.placements) { total -= tile.placements.length * PLACEMENT_BYTES; this.#releaseRocks(tile); }
        else if (layer === 'water' && tile.water) { total -= tile.waterBytes; this.#releaseWater(tile); tile.waterLod = tile.lod; }
      }
    }
  }

  #rebuildRocks(x = this.lastPlan?.[0] ?? 0, z = this.lastPlan?.[1] ?? 0) {
    this.rocksDirty = false;
    this.lastRockBuild = performance.now();
    this.rockViewer = [x, z];
    const { library } = this.library;
    const buckets = new Map();
    for (const tile of this.tiles.values()) for (const placement of tile.placements ?? []) {
      const list = library.variants[placement.kind];
      if (!list?.length) continue;
      const variant = list[placement.variant % list.length];
      const lod = rockLodFor(Math.hypot(placement.position[0] - x, placement.position[2] - z), variant);
      const key = `${placement.kind}:${variant.index}:${lod}`;
      if (!buckets.has(key)) buckets.set(key, { variant, lod, items: [] });
      buckets.get(key).items.push(placement);
    }
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const [key, { variant, lod, items }] of buckets) {
      let entry = this.rockMeshes.get(key);
      // Stable sizes: a ≤1024 capacity is a literal in the vertex WGSL, so 16/32/64…
      // gave every stone variant several programs and cold compiles each boot.
      const capacity = stableInstanceCapacity(items.length);
      // Grow to fit; shrink when mostly empty, so unloading frees the buffer too.
      if (!entry || entry.capacity < items.length || entry.capacity > capacity * 4) {
        if (entry) { entry.mesh.removeFromParent(); entry.mesh.dispose(); }
        let geometry = this.rockGeometries.get(key);
        if (!geometry) { geometry = variantGeometry(rockLodMesh(variant, lod), this.landscape.palette); this.rockGeometries.set(key, geometry); }
        const mesh = new THREE.InstancedMesh(geometry, this.rockMaterial, capacity);
        mesh.name = `World streamed stone · ${key}`;
        mesh.receiveShadow = true;
        mesh.castShadow = lod <= ROCK_SHADOW_MAX_LOD;
        mesh.userData.giTrace = 'none';
        mesh.userData.worldStreamed = true;
        this.group.add(mesh);
        entry = { mesh, capacity };
        this.rockMeshes.set(key, entry);
      }
      items.forEach((placement, index) => {
        const [sx, sy, sz] = instanceScale(placement, variant);
        matrix.compose(position.fromArray(placement.position), rotation.setFromAxisAngle(up, placement.yaw), scale.set(sx, sy, sz));
        entry.mesh.setMatrixAt(index, matrix);
      });
      entry.mesh.count = items.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.computeBoundingSphere();
    }
    const loadedVariants = new Set([...buckets.keys()].map(key => key.slice(0, key.lastIndexOf(':'))));
    for (const [key, entry] of this.rockMeshes) {
      if (buckets.has(key)) continue;
      // Another LOD of this variant is still loaded: keep this one's mesh and
      // geometry, empty, rather than re-creating both every time the viewer
      // walks back and forth across a ring.
      if (loadedVariants.has(key.slice(0, key.lastIndexOf(':')))) { entry.mesh.count = 0; continue; }
      // Nothing of this variant is loaded: free its instance buffer and geometry.
      entry.mesh.removeFromParent(); entry.mesh.dispose();
      this.rockMeshes.delete(key);
      this.rockGeometries.get(key)?.dispose(); this.rockGeometries.delete(key);
    }
    this.rockBytes = 0;
    for (const entry of this.rockMeshes.values()) this.rockBytes += entry.mesh.instanceMatrix.array.byteLength;
    for (const geometry of this.rockGeometries.values()) for (const attribute of Object.values(geometry.attributes)) this.rockBytes += attribute.array.byteLength;
    for (const geometry of this.rockGeometries.values()) this.rockBytes += geometry.index?.array.byteLength ?? 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.job = null;
    this.librarySteps = null;
    this.physics?.removeAll();
    for (const tile of this.tiles.values()) {
      tile.mesh?.removeFromParent(); tile.mesh?.geometry.dispose();
      this.#releaseWater(tile);
      this.#releasePlants(tile);
    }
    this.tiles.clear();
    this.ground?.dispose();
    for (const entry of this.rockMeshes.values()) { entry.mesh.removeFromParent(); entry.mesh.dispose(); }
    this.rockMeshes.clear();
    for (const geometry of this.rockGeometries.values()) geometry.dispose();
    this.rockGeometries.clear();
    this.rockBytes = 0;
    this.buildings?.dispose();
    this.group.removeFromParent();
    this.groundMaterial.dispose();
    this.rockMaterial.dispose();
    this.waterSurface?.dispose();
  }
}
