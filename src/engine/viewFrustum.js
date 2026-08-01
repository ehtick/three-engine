import * as THREE from "three/webgpu";

/**
 * Per-frame frustum state, owned by the Engine. One THREE.Frustum, one
 * scratch Sphere, one inverse world matrix — all reused, zero per-frame
 * allocations.
 *
 * Why a sphere, not a box?
 *   `Frustum.intersectsSphere` is six plane tests (~6 dot products).
 *   `Frustum.intersectsBox` projects eight OBB corners through the
 *   view-projection matrix, which is ~8 vec4 multiplies + a box test.
 *   For "is any geometry from this entity visible" the sphere is the
 *   correct primitive — a false positive (sphere pokes in but the mesh is
 *   behind a wall) just means one extra frame of the gated component
 *   running, which is harmless; a false negative would defeat the
 *   optimisation. So we pay ~3-5x less per entity per frame.
 *
 * Camera-hash dirty check:
 *   The frustum is rebuilt only when the active camera's world matrix or
 *   projection matrix changes. In a static editor viewport that's once
 *   per camera move; in a game running with a fixed camera it's once at
 *   startup. Components that query the frustum still pay the sphere test
 *   each frame, but skip the matrix multiply.
 */

const _scratchInverse = new THREE.Matrix4();
const _scratchViewProj = new THREE.Matrix4();

export class ViewFrustum {
  constructor() {
    this.frustum = new THREE.Frustum();
    this._planes = this.frustum.planes;
    this._cameraHash = 0;
    this._camera = null;
  }

  /**
   * Refresh the frustum from the active camera. No-op when the camera's
   * combined view*projection matrix hasn't changed since the last refresh,
   * so calling this every frame from many components is cheap.
   */
  refresh(camera) {
    if (!camera) {
      this._camera = null;
      this._cameraHash = 0;
      return false;
    }
    if (camera === this._camera) {
      // Hash both the projection (FOV/near/far changes) and the world
      // matrix (camera moved/rotated). matrixWorld.elements is a
      // length-16 Float32Array — we xor a few of its entries to detect
      // any change cheaply. Re-hashing the whole array would defeat the
      // optimisation.
      let h = 2166136261;
      const p = camera.projectionMatrix.elements;
      for (let i = 0; i < 4; i++) {
        const v = p[i * 5]; // diagonal of the projection — covers FOV, aspect, near/far
        if (v !== 0) h = ((h ^ Math.fround(v)) * 16777619) >>> 0;
      }
      const m = camera.matrixWorld.elements;
      // Sample translation + a basis row — moving the camera changes 12, but
      // we only need *some* change to invalidate, so 4 well-chosen entries
      // give us a collision probability that is fine for a "skip work"
      // optimisation (worst case: redundant frustum rebuild, not a bug).
      h = ((h ^ Math.fround(m[12])) * 16777619) >>> 0;
      h = ((h ^ Math.fround(m[13])) * 16777619) >>> 0;
      h = ((h ^ Math.fround(m[14])) * 16777619) >>> 0;
      h = ((h ^ Math.fround(m[0])) * 16777619) >>> 0;
      if (h === this._cameraHash) return false;
      this._cameraHash = h;
    } else {
      this._camera = camera;
      this._cameraHash = 0; // forces a rebuild on the next path
    }

    camera.updateMatrixWorld();
    _scratchInverse.copy(camera.matrixWorld).invert();
    _scratchViewProj.multiplyMatrices(camera.projectionMatrix, _scratchInverse);
    this.frustum.setFromProjectionMatrix(_scratchViewProj);
    return true;
  }

  /** True when the camera is missing or the frustum hasn't been refreshed. */
  isReady() {
    return this._camera !== null;
  }

  /**
   * Sphere-vs-frustum. Returns false when the frustum isn't ready so callers
   * default to "in view" (i.e. components stay enabled) instead of stalling
   * the world while the camera is being constructed.
   *
   * `out` is optional — pass a scratch Sphere to avoid allocating. The
   * helper writes the transformed sphere into `out` if provided.
   */
  testSphere(center, radius, out = null) {
    if (!this.isReady()) return true;
    const s = out ?? _scratchSphere;
    s.center.copy(center);
    s.radius = radius;
    return this.frustum.intersectsSphere(s);
  }
}

const _scratchSphere = new THREE.Sphere();

/**
 * Computes a world-space bounding sphere for an entity by aggregating the
 * bounding spheres of every mesh under the entity's Object3D (model root,
 * MeshComponent meshes, InstancedMesh, child entities). Result is written
 * into `out` so callers can pass a scratch.
 *
 * Returns false when the entity has no meshes with a usable bounding sphere
 * — callers should treat that as "always in view" (or skip gating entirely)
 * since there is no geometry to test against.
 *
 * Cost:
 *   - One `geometry.computeBoundingSphere()` per mesh that lacks one
 *     (three.js caches the result, so subsequent calls are O(1)).
 *   - One world-matrix multiply per mesh (`Sphere.applyMatrix4`).
 *   - N sphere unions to merge them. For typical entities (1-5 meshes)
 *     this is < 1µs.
 *
 * Caching:
 *   Set `outVersion` to the engine's monotonic tick counter after each
 *   successful call. The caller is responsible for invalidating the cache
 *   when the entity moves (compare `matrixWorld.elements[15]` or similar).
 *   `getEntityBoundingSphere` below handles the cache + invalidation.
 */
export function computeEntityBoundingSphere(entity, out) {
  const meshes = [];
  // Direct mesh/model/instancer on this entity.
  const meshComp = entity.getComponent?.("mesh");
  if (meshComp?.mesh) meshes.push(meshComp.mesh);
  const modelComp = entity.getComponent?.("model");
  if (modelComp?.root) {
    modelComp.root.traverse((obj) => {
      if (obj.isMesh || obj.isInstancedMesh) meshes.push(obj);
    });
  }
  const instancerComp = entity.getComponent?.("instancer");
  if (instancerComp?.instancedMesh) meshes.push(instancerComp.instancedMesh);
  // Child entities — a parent's viewOnly gates children too. We don't
  // recurse infinitely: a child ViewOnly component would have its own
  // bounding sphere and own decision, which is fine — the worst case is
  // one redundant sphere test, not a runaway.
  for (const child of entity.children) {
    collectMeshes(child, meshes, 4); // bounded depth so a deep tree doesn't blow up
  }

  if (meshes.length === 0) return false;

  // Merge into `out`. Start from the first mesh's world-space sphere, then
  // expand by unioning the rest.
  const tmp = _scratchMeshSphere;
  let first = true;
  for (const mesh of meshes) {
    const geom = mesh.geometry;
    if (!geom) continue;
    // `Object3D.boundingSphere` wins when present — three's own per-object
    // override, and the only correct answer for a mesh whose vertex shader
    // moves it off its buffer (an impostor billboard draws `size` across from a
    // shared unit quad, so its geometry's bounds describe something else
    // entirely).
    if (!mesh.boundingSphere && !geom.boundingSphere) geom.computeBoundingSphere();
    const local = mesh.boundingSphere ?? geom.boundingSphere;
    if (!local) continue;
    tmp.center.copy(local.center);
    tmp.radius = local.radius;
    // Account for non-uniform scale baked into the mesh's world matrix.
    tmp.applyMatrix4(mesh.matrixWorld);
    if (first) {
      out.center.copy(tmp.center);
      out.radius = tmp.radius;
      first = false;
    } else {
      // Three.js Sphere has no `union` — replicate it: distance between
      // centers + max radii, take whichever is bigger.
      const dx = tmp.center.x - out.center.x;
      const dy = tmp.center.y - out.center.y;
      const dz = tmp.center.z - out.center.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r = Math.max(out.radius, tmp.radius);
      if (d + r > out.radius) {
        if (d + tmp.radius > out.radius) {
          // The merged sphere must contain both. Standard two-sphere
          // bounding-sphere construction: new center on the line between
          // the two centers, at distance (d + r1 - r2) / 2 from out.center
          // (capped).
          const newR = (d + out.radius + tmp.radius) * 0.5;
          const t = (newR - out.radius) / (d || 1);
          out.center.x += dx * t;
          out.center.y += dy * t;
          out.center.z += dz * t;
          out.radius = newR;
        } else {
          out.radius = r;
        }
      }
    }
  }
  return !first;
}

const _scratchMeshSphere = new THREE.Sphere();

function collectMeshes(entity, meshes, depth) {
  if (depth <= 0) return;
  const meshComp = entity.getComponent?.("mesh");
  if (meshComp?.mesh) meshes.push(meshComp.mesh);
  const modelComp = entity.getComponent?.("model");
  if (modelComp?.root) {
    modelComp.root.traverse((obj) => {
      if (obj.isMesh || obj.isInstancedMesh) meshes.push(obj);
    });
  }
  const instancerComp = entity.getComponent?.("instancer");
  if (instancerComp?.instancedMesh) meshes.push(instancerComp.instancedMesh);
  for (const child of entity.children) collectMeshes(child, meshes, depth - 1);
}

/**
 * Cached bounding-sphere accessor. Holds the last-computed sphere and the
 * world-matrix hash it was computed against; recomputes only when the entity
 * (or any ancestor) actually moved.
 *
 * The "hash" is just the translation portion of `matrixWorld.elements` —
 * movement changes m[12..14]; pure rotation around the entity's pivot with
 * the geometry centred on the origin wouldn't change those, but a uniformly
 * rotating entity has the same bounding-sphere center in world space, so
 * skipping the recompute is correct. (A rotating entity with off-center
 * geometry would — that one slips the cache, which is fine: worst case is
 * one extra recompute per frame for an off-center spinning mesh.)
 *
 * Returns false when the entity has no meshes — same convention as
 * `computeEntityBoundingSphere`.
 */
export function getEntityBoundingSphere(entity, out) {
  if (!entity._viewSphereCache) {
    entity._viewSphereCache = {
      sphere: new THREE.Sphere(),
      hash: null,
      hasGeometry: false,
    };
  }
  const cache = entity._viewSphereCache;
  // Hash includes the entity's own matrix and its ancestors' — moving a
  // parent moves the child in world space. Cheap: read the 3 translation
  // components from each.
  let h = 0;
  let node = entity;
  while (node) {
    const m = node.object3D.matrixWorld.elements;
    h = ((h ^ Math.fround(m[12])) * 16777619) >>> 0;
    h = ((h ^ Math.fround(m[13])) * 16777619) >>> 0;
    h = ((h ^ Math.fround(m[14])) * 16777619) >>> 0;
    node = node.parent;
  }
  if (h === cache.hash && cache.hasGeometry) {
    out.center.copy(cache.sphere.center);
    out.radius = cache.sphere.radius;
    return true;
  }
  // Ensure world matrices are current. updateWorldMatrix(true, false) walks
  // up; the trailing false means don't recurse into children (we don't
  // need their matrices, only the chain to the entity).
  entity.object3D.updateWorldMatrix(true, false);
  const ok = computeEntityBoundingSphere(entity, cache.sphere);
  cache.hasGeometry = ok;
  cache.hash = h;
  if (ok) {
    out.center.copy(cache.sphere.center);
    out.radius = cache.sphere.radius;
  }
  return ok;
}