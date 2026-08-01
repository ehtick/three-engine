import * as THREE from "three/webgpu";
import { RibbonBuffer } from "./ribbon.js";

/**
 * The three.js side of a ribbon: a `Mesh` whose attributes are re-pointed at a
 * `RibbonBuffer` and whose draw range follows however much of it is live.
 *
 * The buffers are over-allocated (a trail's point count moves every frame), so
 * everything here is careful to describe only the written prefix:
 *
 *   - `setDrawRange` bounds the index count, not the vertex count,
 *   - the bounding sphere is written explicitly. three only *computes* one when
 *     it is null, and a computed one would read the whole capacity — including
 *     the stale tail past `vertexCount` — giving a sphere that is either far
 *     too big (the ribbon never culls) or centred on the origin (it culls while
 *     on screen). Both look like "sometimes it disappears".
 */
/**
 * Effective visibility of an entity and its ancestors.
 *
 * A world-space VFX mesh hangs off the scene ROOT so its geometry can be in
 * absolute coordinates — which also means it no longer inherits anything from
 * the entity that owns it. Hiding the entity (or an ancestor, or switching to a
 * mode the entity is disabled in) would leave its trail hanging in the air.
 */
export function entitySubtreeVisible(entity) {
  for (let node = entity; node; node = node.parent) {
    if (node.object3D?.visible === false) return false;
  }
  return true;
}

export class RibbonMesh {
  constructor(material, { name = "__ribbon" } = {}) {
    this.buffer = new RibbonBuffer();
    this.geometry = new THREE.BufferGeometry();
    this.attributes = null;
    this.generation = -1;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = name;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.geometry.boundingSphere = new THREE.Sphere();
  }

  /** Pushes `this.buffer`'s current contents to the GPU. */
  upload() {
    const buffer = this.buffer;
    if (!buffer.indexCount) {
      this.mesh.visible = false;
      this.geometry.setDrawRange(0, 0);
      return;
    }
    if (this.generation !== buffer.generation) {
      // The typed arrays were reallocated by a growth step — new
      // BufferAttributes, not just a needsUpdate flag.
      this.generation = buffer.generation;
      this.attributes = {
        position: new THREE.BufferAttribute(buffer.positions, 3),
        aTangent: new THREE.BufferAttribute(buffer.tangents, 3),
        aSide: new THREE.BufferAttribute(buffer.sides, 1),
        aWidth: new THREE.BufferAttribute(buffer.widths, 1),
        aColor: new THREE.BufferAttribute(buffer.colors, 4),
        uv: new THREE.BufferAttribute(buffer.uvs, 2),
      };
      for (const [name, attribute] of Object.entries(this.attributes)) {
        attribute.setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute(name, attribute);
      }
      this.geometry.setIndex(new THREE.BufferAttribute(buffer.indices, 1));
    }
    for (const attribute of Object.values(this.attributes)) {
      attribute.needsUpdate = true;
      attribute.clearUpdateRanges?.();
      attribute.addUpdateRange?.(0, buffer.vertexCount * attribute.itemSize);
    }
    const index = this.geometry.getIndex();
    index.needsUpdate = true;
    this.geometry.setDrawRange(0, buffer.indexCount);
    this.geometry.boundingSphere.center.set(...buffer.center);
    this.geometry.boundingSphere.radius = buffer.radius;
    this.mesh.visible = true;
  }

  setMaterial(material) {
    this.mesh.material = material;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material?.dispose?.();
    this.mesh.removeFromParent();
  }
}
