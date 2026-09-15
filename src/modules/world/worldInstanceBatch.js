import * as THREE from 'three/webgpu';

/**
 * ⚡ ONE BATCHEDMESH FOR MANY INSTANCED SHAPES (09-14, Complex scene CPU-bound on
 * draws at ~30 µs each). Streamed stone was one InstancedMesh per
 * `kind:variant:LOD` and streamed houses one per `variant:part`; each bound
 * spanned the whole streamed area, so none was ever culled and render objects
 * scaled with variants × LODs × parts × passes. A batch is ONE render object per
 * pass whatever it holds, and three culls it per instance against whichever
 * camera draws it (`BatchedMesh.onBeforeRender` / `onBeforeShadow`), shadow
 * cameras included — a stone behind the viewer still casts.
 *
 * Capacities only grow, by doubling: a new instance count or geometry size swaps
 * the batch's texture/geometry, which is a new render object for three (the
 * matrices texture uuid is in its cache key; the WGSL reads sizes at runtime, so
 * the program text is unchanged). Freed geometry ranges are compacted with
 * `optimize()` only when an add would not fit — never per frame.
 * The mesh is created on the first geometry, which fixes the attribute layout.
 */
export class InstanceBatch {
  constructor({ group, material, name, castShadow = true, receiveShadow = true, instances = 1024, vertices = 0, indices = 0 }) {
    Object.assign(this, { group, material, name, castShadow, receiveShadow });
    this.hint = { instances: Math.max(1, instances), vertices, indices };
    this.mesh = null;
    this.live = 0;
    this.boundsDirty = false;
  }

  addGeometry(geometry) {
    this.#room(geometry);
    this.boundsDirty = true;
    return this.mesh.addGeometry(geometry);
  }

  /** Same-size replacement (a recolour): every instance of it follows. */
  setGeometryAt(geometryId, geometry) { this.mesh.setGeometryAt(geometryId, geometry); this.boundsDirty = true; }

  /** Drops the geometry and any instance still drawing it; its range is compacted on a later add that needs the room. */
  deleteGeometry(geometryId) {
    const mesh = this.mesh;
    for (let i = 0; i < mesh._instanceInfo.length; i++) {
      const info = mesh._instanceInfo[i];
      if (info.active && info.geometryIndex === geometryId) this.remove(i);
    }
    mesh.deleteGeometry(geometryId);
    this.boundsDirty = true;
  }

  add(geometryId, matrix) {
    const mesh = this.mesh;
    // live < max ⇒ addInstance has a free id or room at the end.
    if (this.live >= mesh.maxInstanceCount) mesh.setInstanceCount(mesh.maxInstanceCount * 2);
    const id = mesh.addInstance(geometryId);
    mesh.setMatrixAt(id, matrix);
    this.live++;
    this.boundsDirty = true;
    return id;
  }

  setGeometryIdAt(instanceId, geometryId) { this.mesh.setGeometryIdAt(instanceId, geometryId); this.boundsDirty = true; }

  remove(instanceId) {
    this.mesh.deleteInstance(instanceId);
    this.live--;
    this.boundsDirty = true;
  }

  /** After a re-bucket: the batch-wide bound for the renderer's object-level test. */
  flush() {
    if (!this.mesh || !this.boundsDirty) return;
    this.boundsDirty = false;
    this.mesh.visible = this.live > 0;
    if (this.live) { this.mesh.computeBoundingBox(); this.mesh.computeBoundingSphere(); }
  }

  bytes() {
    const mesh = this.mesh;
    if (!mesh) return 0;
    let total = mesh._matricesTexture.image.data.byteLength + mesh._indirectTexture.image.data.byteLength;
    for (const attribute of Object.values(mesh.geometry.attributes)) total += attribute.array.byteLength;
    return total + (mesh.geometry.index?.array.byteLength ?? 0);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh = null;
    this.live = 0;
  }

  #room(geometry) {
    const vertices = geometry.getAttribute('position').count, indices = geometry.index?.count ?? 0;
    if (!this.mesh) {
      const hint = this.hint;
      const mesh = new THREE.BatchedMesh(hint.instances, Math.max(hint.vertices, vertices), Math.max(hint.indices, indices), this.material);
      mesh.name = this.name;
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      // Opaque: per-instance culling only, no per-pass depth sort.
      mesh.sortObjects = false;
      mesh.userData.giTrace = 'none';
      mesh.userData.worldStreamed = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.mesh = mesh;
      return;
    }
    const mesh = this.mesh;
    const fits = () => mesh.unusedVertexCount >= vertices && mesh.unusedIndexCount >= indices;
    if (fits()) return;
    mesh.optimize();
    if (fits()) return;
    const usedVertices = mesh._maxVertexCount - mesh.unusedVertexCount, usedIndices = mesh._maxIndexCount - mesh.unusedIndexCount;
    mesh.setGeometrySize(Math.max(mesh._maxVertexCount * 2, usedVertices + vertices), Math.max(mesh._maxIndexCount * 2, usedIndices + indices));
  }
}
