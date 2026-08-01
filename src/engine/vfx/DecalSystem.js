import * as THREE from "three/webgpu";
import { projectDecal, decalOrientation } from "./decalProjection.js";
import { createDecalMaterial } from "./vfxMaterial.js";
import { loadTextureAsset } from "../textureAsset.js";

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _size = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _color = new THREE.Color();

/**
 * `engine.decals` — the runtime surface for gameplay decals (roadmap item 13).
 *
 *     const hit = this.engine.physics.raycast(origin, direction, 100);
 *     if (hit) this.engine.decals.spawn({
 *       position: hit.point, normal: hit.normal,
 *       texture: "textures/bullet_hole.png", size: 0.15, lifetime: 20,
 *     });
 *
 * ## One buffer per look, not one mesh per decal
 *
 * A firefight leaves a hundred bullet holes. As individual meshes that is a
 * hundred draw calls for perhaps two hundred triangles — the cost is entirely
 * submission overhead, which is exactly the shape of problem the batching
 * system exists to fix, except decals are created at runtime and never repeat a
 * geometry. So decals sharing a texture and blend mode are concatenated into
 * one buffer, and the whole firefight is one draw call.
 *
 * The buffer is rebuilt on spawn and expiry — events, not frames. A decal
 * FADING costs one small sub-range upload of its own vertex colours, because
 * the per-decal alpha lives in the vertex colour rather than in a uniform (a
 * uniform would mean a material, and therefore a draw call, per decal).
 *
 * ## Budget
 *
 * `maxDecals` is a hard ring: the oldest goes when the newest arrives. A
 * shooter with no cap accumulates decals for as long as the player keeps
 * firing, and the failure mode is a level that gets slower the longer you play
 * it — which nobody attributes to bullet holes.
 */
export class DecalSystem {
  constructor(engine) {
    this.engine = engine;
    /** Batches keyed by look (texture + blending + lit). */
    this.batches = new Map();
    /** Live decals, oldest first. */
    this.decals = [];
    this.maxDecals = 256;
    this._textures = new Map(); // path -> Promise<Texture>
  }

  /**
   * Places a decal.
   *
   * `position` + `normal` is the surface-hit form (what a raycast gives you);
   * `matrix` is the explicit form used by the authored DecalComponent. `size`
   * accepts a number (a square, projected one unit deep) or an [x,y,z] box.
   *
   * Returns a handle with `remove()`. The call is synchronous even when its
   * texture is still loading — geometry is projected now and the texture
   * appears when it arrives, because a bullet hole that shows up 200ms after
   * the bullet is worse than one that starts out white.
   */
  spawn({
    position = null,
    normal = null,
    matrix = null,
    rotation = null,
    roll = 0,
    size = 0.25,
    texture = "",
    color = "#ffffff",
    opacity = 1,
    lit = true,
    blending = "alpha",
    maxAngle = 90,
    offset = 0.01,
    lifetime = 0,
    fadeTime = 0,
    tag = "",
    targets = null,
  } = {}) {
    const world = _matrix.identity();
    if (matrix) {
      world.copy(matrix);
    } else {
      _position.set(position?.x ?? 0, position?.y ?? 0, position?.z ?? 0);
      if (rotation) {
        _quaternion.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0, rotation.w ?? 1);
      } else {
        _normal.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
        if (_normal.lengthSq() < 1e-9) _normal.set(0, 1, 0);
        decalOrientation(_normal.normalize(), roll, _quaternion);
      }
      world.compose(_position, _quaternion, _scale.set(1, 1, 1));
    }
    if (typeof size === "number") _size.set(size, size, size);
    else _size.set(size?.x ?? size?.[0] ?? 1, size?.y ?? size?.[1] ?? 1, size?.z ?? size?.[2] ?? 1);

    const geometry = projectDecal({
      engine: this.engine,
      targets,
      matrix: world,
      size: _size,
      maxAngle,
      offset,
      tag,
    });
    // Nothing was hit. Returning null (rather than an empty handle) lets a
    // caller tell "I shot the sky" from "the decal is there".
    if (!geometry) return null;

    _color.set(color ?? "#ffffff");
    const entry = {
      positions: geometry.positions,
      normals: geometry.normals,
      uvs: geometry.uvs,
      vertexCount: geometry.vertexCount,
      color: [_color.r, _color.g, _color.b, opacity],
      fade: 1,
      age: 0,
      lifetime: Math.max(0, lifetime),
      fadeTime: Math.max(0, Math.min(fadeTime, lifetime || fadeTime)),
      start: 0,
      batch: null,
      remove: () => this.remove(entry),
    };

    const batch = this.#batchFor({ texture, lit, blending });
    batch.add(entry);
    entry.batch = batch;
    this.decals.push(entry);
    // The ring is enforced after the insert, so the newest decal always makes
    // it in — a cap that dropped the incoming one would make the gun stop
    // leaving holes exactly when the fight got busy.
    while (this.decals.length > this.maxDecals) this.remove(this.decals[0]);
    return entry;
  }

  remove(entry) {
    if (!entry) return;
    const index = this.decals.indexOf(entry);
    if (index >= 0) this.decals.splice(index, 1);
    entry.batch?.remove(entry);
    entry.batch = null;
  }

  /** Drops every decal. Called on Stop — a bullet hole punched during Play must
   *  not still be in the wall when the editor comes back. */
  clear() {
    for (const batch of this.batches.values()) batch.clear();
    this.decals.length = 0;
  }

  /** Per-frame ageing. Game time: a decal is part of the world, so bullet time
   *  slows its fade and a pause menu freezes it. */
  update(dt) {
    if (!this.decals.length || !(dt > 0)) return;
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const entry = this.decals[i];
      if (!entry.lifetime) continue;
      entry.age += dt;
      if (entry.age >= entry.lifetime) {
        this.remove(entry);
        continue;
      }
      const remaining = entry.lifetime - entry.age;
      const fade = entry.fadeTime > 0 ? Math.min(1, remaining / entry.fadeTime) : 1;
      if (Math.abs(fade - entry.fade) > 1e-3) {
        entry.fade = fade;
        entry.batch?.refreshColors(entry);
      }
    }
  }

  #batchFor({ texture, lit, blending }) {
    const key = `${texture}|${lit ? 1 : 0}|${blending}`;
    let batch = this.batches.get(key);
    if (batch) return batch;
    batch = new DecalBatch(this.engine, { lit, blending });
    this.batches.set(key, batch);
    if (texture) this.#texture(texture).then((map) => batch.setMap(map));
    return batch;
  }

  /** Textures are loaded once per path — a hundred bullet holes share one. */
  #texture(path) {
    let pending = this._textures.get(path);
    if (!pending) {
      pending = loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace }).catch((err) => {
        console.warn(`Decal texture failed to load: ${path}`, err);
        return null;
      });
      this._textures.set(path, pending);
    }
    return pending;
  }

  dispose() {
    for (const batch of this.batches.values()) batch.dispose();
    this.batches.clear();
    this.decals.length = 0;
    for (const pending of this._textures.values()) pending.then((texture) => texture?.dispose());
    this._textures.clear();
  }
}

/**
 * One merged mesh: every decal that shares a texture, blend mode and lighting
 * model, concatenated.
 *
 * The mesh lives at the scene root with an identity transform because decal
 * geometry is already in world space — it was clipped out of world geometry, so
 * giving it a parent transform would only be a chance to get it wrong.
 */
export class DecalBatch {
  constructor(engine, { lit = true, blending = "alpha" } = {}) {
    this.engine = engine;
    this.entries = [];
    this.capacity = 0;
    this.positions = new Float32Array(0);
    this.normals = new Float32Array(0);
    this.uvs = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.vertexCount = 0;
    this.geometry = new THREE.BufferGeometry();
    this.material = createDecalMaterial({ lit, blending });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "__decalBatch";
    this.mesh.frustumCulled = false; // bounds change with every spawn
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = !!lit;
    this.mesh.castShadow = false;
    // Decals draw over the surface they were cut from, which is the same depth.
    // renderOrder decides that tie; depth bias alone does not, because the two
    // are coplanar by construction.
    this.mesh.renderOrder = 10;
    this.mesh.userData.noDecal = true;
    this.mesh.userData.noBatch = true;
    this.mesh.userData.engineOwned = true;
    this.mesh.visible = false;
    engine?.scene?.add(this.mesh);
  }

  setMap(map) {
    if (!map) return;
    this.map = map;
    const old = this.material;
    this.material = createDecalMaterial({
      map,
      lit: old.isMeshStandardNodeMaterial,
      blending: old.blending === THREE.AdditiveBlending ? "additive" : "alpha",
    });
    this.mesh.material = this.material;
    old.dispose();
  }

  add(entry) {
    entry.start = this.vertexCount;
    this.entries.push(entry);
    this.#ensure(this.vertexCount + entry.vertexCount);
    this.#write(entry);
    this.vertexCount += entry.vertexCount;
    this.#sync(true);
  }

  remove(entry) {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    // Rebuild by compaction rather than by leaving a hole. Decals expire in
    // roughly the order they were spawned, so a free-list would fragment into
    // exactly the pattern it is worst at, and a full rewrite of a few thousand
    // floats is cheaper than the bookkeeping to avoid it.
    this.vertexCount = 0;
    for (const remaining of this.entries) {
      remaining.start = this.vertexCount;
      this.#write(remaining);
      this.vertexCount += remaining.vertexCount;
    }
    this.#sync(true);
  }

  clear() {
    this.entries.length = 0;
    this.vertexCount = 0;
    this.#sync(true);
  }

  /** Rewrites just this decal's vertex colours — the fade path. */
  refreshColors(entry) {
    const alpha = entry.color[3] * entry.fade;
    for (let v = 0; v < entry.vertexCount; v++) {
      const at = (entry.start + v) * 4;
      this.colors[at] = entry.color[0];
      this.colors[at + 1] = entry.color[1];
      this.colors[at + 2] = entry.color[2];
      this.colors[at + 3] = alpha;
    }
    const attribute = this.geometry.getAttribute("color");
    if (!attribute) return;
    attribute.needsUpdate = true;
    attribute.clearUpdateRanges?.();
    attribute.addUpdateRange?.(entry.start * 4, entry.vertexCount * 4);
  }

  #ensure(vertices) {
    if (vertices <= this.capacity) return;
    let next = Math.max(this.capacity || 256, 256);
    while (next < vertices) next *= 2;
    const positions = new Float32Array(next * 3);
    const normals = new Float32Array(next * 3);
    const uvs = new Float32Array(next * 2);
    const colors = new Float32Array(next * 4);
    positions.set(this.positions);
    normals.set(this.normals);
    uvs.set(this.uvs);
    colors.set(this.colors);
    this.positions = positions;
    this.normals = normals;
    this.uvs = uvs;
    this.colors = colors;
    this.capacity = next;
    this._attributes = null; // force fresh BufferAttributes over the new arrays
  }

  #write(entry) {
    this.#ensure(entry.start + entry.vertexCount);
    this.positions.set(entry.positions, entry.start * 3);
    this.normals.set(entry.normals, entry.start * 3);
    this.uvs.set(entry.uvs, entry.start * 2);
    const alpha = entry.color[3] * entry.fade;
    for (let v = 0; v < entry.vertexCount; v++) {
      const at = (entry.start + v) * 4;
      this.colors[at] = entry.color[0];
      this.colors[at + 1] = entry.color[1];
      this.colors[at + 2] = entry.color[2];
      this.colors[at + 3] = alpha;
    }
  }

  #sync(structural) {
    if (!this._attributes) {
      this._attributes = {
        position: new THREE.BufferAttribute(this.positions, 3),
        normal: new THREE.BufferAttribute(this.normals, 3),
        uv: new THREE.BufferAttribute(this.uvs, 2),
        color: new THREE.BufferAttribute(this.colors, 4),
      };
      for (const [name, attribute] of Object.entries(this._attributes)) {
        attribute.setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute(name, attribute);
      }
    }
    if (structural) {
      for (const attribute of Object.values(this._attributes)) {
        attribute.needsUpdate = true;
        attribute.clearUpdateRanges?.();
        attribute.addUpdateRange?.(0, this.vertexCount * attribute.itemSize);
      }
    }
    this.geometry.setDrawRange(0, this.vertexCount);
    this.mesh.visible = this.vertexCount > 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.entries.length = 0;
  }
}
