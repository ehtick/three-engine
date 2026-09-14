/**
 * Heightfield colliders for the streamed chunks near the camera (09-14, T4
 * step 2: "a player walking out of the valley falls through").
 *
 * Streamed tiles are plain meshes, not entities, so they cannot take the
 * entity Collider path. This follows the rig contract instead (see
 * `physics-rapier/rig.js`): the World component is registered as a physics rig
 * and forwards `buildRig` / `clearRig` here, so colliders exist exactly while
 * the physics world does (Play), and are rebuilt from the remembered tiles when
 * Play starts again.
 *
 * One fixed body + one heightfield collider per chunk, keyed by chunk, added
 * and removed individually as the camera moves. Colliders report the World
 * entity as their owner, so a raycast that hits streamed ground names it.
 * Row/column convention and centring match TerrainComponent's heightfield in
 * PhysicsSystem (rows run along +z, the grid is centred on the body).
 */

/** Row-major (row = z) -> Rapier's column-major, exactly as PhysicsSystem does for Terrain. */
export function toColumnMajor(heights, resolution) {
  const cols = resolution + 1;
  const out = new Float32Array(heights.length);
  for (let r = 0; r <= resolution; r++) for (let c = 0; c <= resolution; c++) out[r + c * cols] = heights[r * cols + c];
  return out;
}

export class WorldStreamPhysics {
  constructor({ entity = null, layer = 'Ground', friction = .8 } = {}) {
    this.entity = entity;
    this.layer = layer;
    this.friction = friction;
    /** World-space offset of the World's local frame (translation only). */
    this.offset = [0, 0, 0];
    /** key -> { heights (row-major), resolution, size, x0, z0 } — survives Stop. */
    this.tiles = new Map();
    /** key -> { body, collider } — only while a physics world exists. */
    this.live = new Map();
    this.physics = null;
  }

  get colliderCount() { return this.live.size; }
  has(key) { return this.tiles.has(key); }

  setTile(key, tile) {
    this.tiles.set(key, tile);
    if (this.physics?.world) { this.#remove(key); this.#create(key, tile); }
  }

  removeTile(key) {
    this.tiles.delete(key);
    this.#remove(key);
  }

  /** Rig contract: the physics world was just built. */
  build(physics) {
    this.clear();
    this.physics = physics;
    if (!physics?.world) return;
    for (const [key, tile] of this.tiles) this.#create(key, tile);
  }

  /** Rig contract: the physics world is being torn down. Tiles are remembered. */
  clear() {
    for (const key of [...this.live.keys()]) this.#remove(key);
    this.physics = null;
  }

  /** The streamer went away: forget everything. */
  removeAll() {
    const physics = this.physics;
    this.clear();
    this.tiles.clear();
    this.physics = physics;
  }

  #layerIndex() {
    const layers = this.physics.layers;
    const index = layers?.indexOf?.(this.layer) ?? -1;
    return index >= 0 ? index : Math.max(0, layers?.indexOf?.('Default') ?? 0);
  }

  #create(key, { heights, resolution, size, x0, z0 }) {
    const { world, RAPIER } = this.physics;
    const [ox, oy, oz] = this.offset;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x0 + size / 2 + ox, oy, z0 + size / 2 + oz));
    const layer = this.#layerIndex();
    const desc = RAPIER.ColliderDesc.heightfield(resolution, resolution, toColumnMajor(heights, resolution), { x: size, y: 1, z: size })
      .setFriction(this.friction)
      .setCollisionGroups(this.physics.layers.groupsFor(layer));
    const collider = world.createCollider(desc, body);
    this.physics.colliderEntity?.set(collider.handle, this.entity);
    this.physics.colliderLayer?.set(collider.handle, layer);
    this.live.set(key, { body, collider });
  }

  #remove(key) {
    const entry = this.live.get(key);
    if (!entry) return;
    this.live.delete(key);
    const physics = this.physics;
    if (!physics || physics.disposed || !physics.world) return;
    // Removing the body frees its collider; only the bookkeeping is dropped by hand
    // (the use-after-free PhysicsRig.clear documents).
    physics.forgetCollider?.(entry.collider.handle);
    try { physics.world.removeRigidBody(entry.body); } catch { /* already gone with the world */ }
  }
}
