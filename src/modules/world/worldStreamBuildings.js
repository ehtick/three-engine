import * as THREE from 'three/webgpu';
import { createCottageStudy, describeCottageStudy } from './worldCottage.js';
import { stableInstanceCapacity } from '../../engine/instanceCapacity.js';

/**
 * Buildings of streamed settlements (09-14, T6 W6): no entities, instanced.
 *
 *   near  (≤ nearRadius) the full cottage study, from a shared library of
 *         BUILDING_VARIANTS variants (one per construction family × 2), one
 *         InstancedMesh per variant material role. A variant is built only when
 *         a building within reach needs it (≈ 35-90 ms, once) and released once
 *         none is within twice the reach.
 *   far   a walls-and-gable-roof silhouette of the same variant (≈ 20 tris),
 *         one InstancedMesh per variant.
 * Re-bucketed when the building set changes or the camera moves 16 m.
 * `bytes` = every geometry attribute and instance buffer it holds.
 */

export const BUILDING_VARIANTS = 8;
/** The library variant a planner seed renders as (same construction family). */
export const buildingVariant = seed => ((seed >>> 0) % 4) + 4 * (Math.floor((seed >>> 0) / 4) % 2);

function farHouseGeometry(spec) {
  const positions = [], colors = [];
  const wall = new THREE.Color(spec.palette.plaster), roof = new THREE.Color(spec.palette.roof);
  const push = (points, color) => { for (const p of points) { positions.push(...p); colors.push(color.r, color.g, color.b); } };
  const quad = (a, b, c, d, color) => push([a, b, c, a, c, d], color);
  const tri = (a, b, c, color) => push([a, b, c], color);
  const o = .45;
  for (const v of spec.volumes) {
    const x0 = v.x - v.width / 2, x1 = v.x + v.width / 2, z0 = v.z - v.depth / 2, z1 = v.z + v.depth / 2, h = v.wallHeight, r = v.ridgeHeight;
    quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], wall);
    quad([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0], wall);
    quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1], wall);
    quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], wall);
    if (v.roofAxis === 'z') {
      const e = h - (r - h) * o / (v.width / 2);
      quad([x0 - o, e, z1 + o], [v.x, r, z1 + o], [v.x, r, z0 - o], [x0 - o, e, z0 - o], roof);
      quad([x1 + o, e, z0 - o], [v.x, r, z0 - o], [v.x, r, z1 + o], [x1 + o, e, z1 + o], roof);
      tri([x0, h, z1], [x1, h, z1], [v.x, r, z1], wall);
      tri([x1, h, z0], [x0, h, z0], [v.x, r, z0], wall);
    } else {
      const e = h - (r - h) * o / (v.depth / 2);
      quad([x0 - o, e, z1 + o], [x1 + o, e, z1 + o], [x1 + o, r, v.z], [x0 - o, r, v.z], roof);
      quad([x1 + o, e, z0 - o], [x0 - o, e, z0 - o], [x0 - o, r, v.z], [x1 + o, r, v.z], roof);
      tri([x1, h, z1], [x1, h, z0], [x1, r, v.z], wall);
      tri([x0, h, z0], [x0, h, z1], [x0, r, v.z], wall);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

export class StreamBuildings {
  constructor({ parent = null, style = 'natural', nearRadius = 140 } = {}) {
    this.style = style; this.nearRadius = nearRadius;
    this.group = new THREE.Group();
    this.group.name = 'World · streamed buildings';
    this.group.userData.worldStreamed = true;
    parent?.add(this.group);
    this.farMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .92, metalness: 0 });
    this.farMaterial.name = 'World streamed building · far';
    this.farGeometries = new Map();
    this.library = new Map();
    this.nearMeshes = new Map(); this.farMeshes = new Map();
    this.list = []; this.dirty = false; this.camera = null; this.bytes = 0;
  }

  setBuildings(list) { this.list = list; this.dirty = true; }

  get count() { return this.list.length; }

  update(x, z) {
    if (!this.camera || Math.hypot(x - this.camera[0], z - this.camera[1]) > 16) { this.camera = [x, z]; this.dirty = true; }
    if (this.nearRadius > 0) {
      const need = this.list.find(b => !this.library.has(buildingVariant(b.variationSeed)) && Math.hypot(b.position[0] - x, b.position[2] - z) <= this.nearRadius);
      if (need) {
        const variant = buildingVariant(need.variationSeed);
        this.library.set(variant, createCottageStudy(THREE, { seed: variant, style: this.style }));
        this.dirty = true;
      }
    }
    if (this.dirty) this.#rebuild();
  }

  #farGeometry(variant) {
    let geometry = this.farGeometries.get(variant);
    if (!geometry) { geometry = farHouseGeometry(describeCottageStudy({ seed: variant, style: this.style })); this.farGeometries.set(variant, geometry); }
    return geometry;
  }

  #rebuild() {
    this.dirty = false;
    const [cx, cz] = this.camera ?? [0, 0];
    const near = new Map(), far = new Map(), wanted = new Set();
    for (const building of this.list) {
      const variant = buildingVariant(building.variationSeed), d = Math.hypot(building.position[0] - cx, building.position[2] - cz);
      if (d <= this.nearRadius * 2) wanted.add(variant);
      const bucket = d <= this.nearRadius && this.library.has(variant) ? near : far;
      if (!bucket.has(variant)) bucket.set(variant, []);
      bucket.get(variant).push(building);
    }
    this.#fill(this.farMeshes, far, variant => [{ key: `${variant}`, geometry: this.#farGeometry(variant), material: this.farMaterial }]);
    this.#fill(this.nearMeshes, near, variant => this.library.get(variant).children.map(mesh => ({ key: `${variant}:${mesh.name}`, geometry: mesh.geometry, material: mesh.material })));
    // Release library variants nobody is near any more, and unused silhouettes.
    for (const [variant, group] of this.library) if (!wanted.has(variant)) { group.userData.dispose(); this.library.delete(variant); }
    for (const [variant, geometry] of this.farGeometries) if (!far.has(variant)) { geometry.dispose(); this.farGeometries.delete(variant); }
    let bytes = 0;
    const attributes = geometry => { for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength; bytes += geometry.index?.array.byteLength ?? 0; };
    for (const group of this.library.values()) for (const mesh of group.children) attributes(mesh.geometry);
    for (const geometry of this.farGeometries.values()) attributes(geometry);
    for (const meshes of [this.nearMeshes, this.farMeshes]) for (const entry of meshes.values()) bytes += entry.mesh.instanceMatrix.array.byteLength;
    this.bytes = bytes;
  }

  #fill(meshes, buckets, partsOf) {
    const used = new Set();
    for (const [variant, items] of buckets) for (const part of partsOf(variant)) {
      used.add(part.key);
      let entry = meshes.get(part.key);
      // A stable capacity: three writes a small one into the vertex WGSL, so an
      // exact size recompiles the program every time a village loads (instanceCapacity.js).
      const capacity = stableInstanceCapacity(items.length);
      if (!entry || entry.capacity < items.length || entry.capacity > capacity * 4 || entry.mesh.geometry !== part.geometry) {
        if (entry) { entry.mesh.removeFromParent(); entry.mesh.dispose(); }
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = `World streamed building · ${part.key}`;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.giTrace = 'none';
        mesh.userData.worldStreamed = true;
        this.group.add(mesh);
        entry = { mesh, capacity };
        meshes.set(part.key, entry);
      }
      items.forEach((building, index) => {
        matrix.compose(position.fromArray(building.position), rotation.setFromAxisAngle(up, building.rotation[1]), scale.setScalar(building.scale ?? 1));
        entry.mesh.setMatrixAt(index, matrix);
      });
      entry.mesh.count = items.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.computeBoundingSphere();
    }
    for (const [key, entry] of meshes) if (!used.has(key)) { entry.mesh.removeFromParent(); entry.mesh.dispose(); meshes.delete(key); }
  }

  dispose() {
    for (const meshes of [this.nearMeshes, this.farMeshes]) { for (const entry of meshes.values()) { entry.mesh.removeFromParent(); entry.mesh.dispose(); } meshes.clear(); }
    for (const group of this.library.values()) group.userData.dispose();
    this.library.clear();
    for (const geometry of this.farGeometries.values()) geometry.dispose();
    this.farGeometries.clear();
    this.farMaterial.dispose();
    this.group.removeFromParent();
    this.list = []; this.bytes = 0;
  }
}
