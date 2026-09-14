import * as THREE from "three/webgpu";
import { attribute, mix, normalMap as normalMapNode, texture, vec2, vec3, vec4 } from "three/tsl";
import { Component } from "../../engine/components/Component.js";
import { levelRooms } from "../level-design/rooms.js";
import { normalizeArchitectureModel } from "./formModel.js";
import { buildArchitectureFormGeometry } from "./formGeometry.js";
import { disposeOrReleaseGeometry } from "../../engine/geometryAsset.js";
import { styleSurfaceArray, configureStyleSurfaceCache, ALBEDO_MEAN } from "./styles/surfaces.js";
import { getDerivedDataPath, loadAssetBinary, saveAssetBinary } from "../../engine/assetResolver.js";

// Disk cache for painted style-surface layers (owner: "maybe you write those textures once to
// disk and they just reuse rather than generate at runtime?"). Wired through the same
// project-derived-data seam GI's static BVH cache uses (`src/modules/gi/staticBvhDiskCache.js`):
// the editor resolves it under `<project>/Library` over Tauri; the exported player resolves it
// under its shipped `Library/` folder over `fetch` (`src/player/main.js`). Neither wiring is
// architecture-specific — this module only supplies WHAT to read/write, not HOW.
configureStyleSurfaceCache({
  read: async (relPath) => {
    const path = getDerivedDataPath(relPath);
    if (!path) return null;
    const buffer = await loadAssetBinary(path);
    return buffer ? new Uint8Array(buffer) : null;
  },
  write: async (relPath, bytes) => {
    const path = getDerivedDataPath(relPath);
    if (!path) return;
    await saveAssetBinary(path, bytes);
  },
});

// Z-FIGHTING SAFETY NET (owner verdict: "buildings got z fighting"): the styles/*.js
// decorators now give every part an explicit outward standoff so it never shares a
// plane with a base massing wall/roof face (see styles/wallDetail.js, roofDetail.js,
// openingDetail.js), but `polygonOffset` on every DETAIL role material is cheap
// insurance against whatever small-scale coplanarity slips through (a diagonal brace
// crossing a panel, a voussoir ring, a dormer against its own roof, ...). `wall` and
// `roof` are deliberately excluded — those are the base massing faces every offset
// above is measured FROM, so biasing them would just move the coplanarity problem
// onto the next thing that sits flush against a wall/roof instead of fixing it.
const POLYGON_OFFSET_ROLES = new Set(["trim", "timber", "stone", "metal", "glass", "door", "chimney"]);
function applyPolygonOffset(material, role) {
  if (!POLYGON_OFFSET_ROLES.has(role)) return;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
}

const modelMaterials = new Map();
function acquireModelMaterial(descriptor) {
  if (descriptor.styled) return acquireStyledMaterial(descriptor);
  const key = `${descriptor.color}:${descriptor.role}`;
  let record = modelMaterials.get(key);
  if (!record) {
    const material = new THREE.MeshStandardNodeMaterial({ color: descriptor.color, roughness: descriptor.role === "glass" ? .25 : .82, metalness: 0 });
    material.name = `Architecture ${descriptor.role}`;
    applyPolygonOffset(material, descriptor.role);
    modelMaterials.set(key, record = { material, refs: 0 });
  }
  record.refs++;
  return record.material;
}

// ---------------------------------------------------------------------------------------------
// Styled roles (World production plan §3, P1-H4): ONE node material per role for the whole
// scene — at most 9 pipelines total (`formGeometry.js`'s `STYLE_ROLES`), regardless of how many
// styles/seeds/palettes are in play. What used to distinguish one building's look from another
// (its surface kind, its palette tint) now rides two per-vertex attributes `formGeometry.js`
// stamps on every styled vertex — `styleLayer` (which layer of the shared style-surface arrays
// this vertex samples) and `styleTint` (its linear-space palette colour) — so the material only
// has to know how to read them, not which style/seed/kind produced them.
// ---------------------------------------------------------------------------------------------

/** The descriptor's material slot: purely the role, `styled` flag implied by the caller only
 * ever routing `descriptor.styled` entries here. Kept as a function (rather than inlining
 * `descriptor.role`) so every caller — and the tests — has one named place documenting that a
 * styled descriptor's `color`/`styleId`/`seed` no longer affect which material it gets. */
export function styledMaterialCacheKey(descriptor) {
  return `styled:${descriptor.role}`;
}

const styledRoleMaterials = new Map(); // role -> { material, refs, colorTex, normalTex, roughTex }
let lastStyleArrays = null;

/** Keeps every already-built styled-role material pointed at the CURRENT shared array
 * textures. `styleSurfaceArray`'s three `DataArrayTexture`s are allocated ONCE, at their full
 * static size, and never replaced afterward (`styles/surfaces.js`'s `STATIC_LAYERS`) — so this
 * no longer needs to rewire `.value` on growth. It still re-runs its (cheap: at most 9 role
 * records) loop on every call rather than short-circuiting on object identity, because a
 * material built before `representativeMap` had its first real layer painted must still pick
 * that texture up once the incremental paint pump (`pumpStyleSurfaceArray`) fills it in. */
function syncStyleArrayTextures() {
  const arrays = styleSurfaceArray();
  lastStyleArrays = arrays;
  // Node/no-canvas (arrays stays null forever in that process): every styled material
  // already sits on the flat tint-only fallback below and there is nothing to point at.
  if (!arrays) return arrays;
  for (const record of styledRoleMaterials.values()) {
    if (!record.colorTex) continue; // built on the flat fallback before any array existed — left alone, matching styleSurface's own no-upgrade contract.
    record.colorTex.value = arrays.map;
    record.normalTex.value = arrays.normalMap;
    record.roughTex.value = arrays.roughnessMap;
    if (arrays.representativeMap) record.material.map = arrays.representativeMap;
  }
  return arrays;
}

/** Builds the one shared material for `role`. `arrays` is `styleSurfaceArray()`'s current
 * result — `null` in Node/a build worker, where every styled role falls back to a flat
 * `styleTint`-only colour, the exact shape the old unstyled path already used. */
function buildStyledRoleMaterial(role, arrays) {
  // Styled geometry batches into four materials (formGeometry.js): "surface" (every textured
  // opaque part), "glass", "metal" and "light" (emissive strips/lanterns). A vertex carries its
  // array layer and styleTint = [linear colour × shade × AO, texture detail strength].
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `Architecture styled ${role}`;
  material.transparent = false;
  const tintAttr = attribute("styleTint", "vec4"), tint = tintAttr.rgb, detail = tintAttr.a;
  if (role === "glass") {
    material.colorNode = vec4(tint, 1); material.metalness = .35; material.roughness = .08;
    return { material, refs: 0, colorTex: null, normalTex: null, roughTex: null };
  }
  if (role === "light") {
    material.colorNode = vec4(tint, 1); material.emissiveNode = tint.mul(2.5); material.roughness = .4;
    return { material, refs: 0, colorTex: null, normalTex: null, roughTex: null };
  }
  material.metalness = role === "metal" ? .6 : 0;
  if (arrays) {
    // `+0.5 then floor` so interpolation noise cannot land one layer below the intended index.
    const layerIndex = attribute("styleLayer", "float").add(0.5).floor().toInt();
    const colorTex = texture(arrays.map).depth(layerIndex);
    const normalTex = texture(arrays.normalMap).depth(layerIndex);
    const roughTex = texture(arrays.roughnessMap).depth(layerIndex);
    material.colorNode = vec4(tint.mul(mix(vec3(1), colorTex.rgb.div(ALBEDO_MEAN), detail)), 1);
    material.normalNode = normalMapNode(normalTex, vec2(detail, detail));
    material.roughnessNode = role === "metal" ? roughTex.r.mul(.6) : mix(.85, roughTex.r, detail);
    // GI reads classic fields when it cannot walk a per-vertex array lookup (one texture stands in).
    material.map = arrays.representativeMap ?? null;
    return { material, refs: 0, colorTex, normalTex, roughTex };
  }
  material.colorNode = vec4(tint, 1);
  material.roughness = role === "metal" ? .4 : .82;
  return { material, refs: 0, colorTex: null, normalTex: null, roughTex: null };
}

function acquireStyledMaterial(descriptor) {
  const arrays = syncStyleArrayTextures();
  const role = descriptor.role;
  let record = styledRoleMaterials.get(role);
  if (!record) styledRoleMaterials.set(role, record = buildStyledRoleMaterial(role, arrays));
  record.refs++;
  return record.material;
}

function releaseModelMaterials(materials = []) {
  for (const material of materials) {
    let released = false;
    for (const [key, record] of modelMaterials) if (record.material === material) {
      if (--record.refs === 0) { material.dispose(); modelMaterials.delete(key); }
      released = true; break;
    }
    if (released) continue;
    // Styled role materials never own the shared style-surface arrays — that cache lives in
    // `styles/surfaces.js`, is shared scene-wide, and outlives any one role material.
    for (const [role, record] of styledRoleMaterials) if (record.material === material) {
      if (--record.refs === 0) { material.dispose(); styledRoleMaterials.delete(role); }
      break;
    }
  }
}

/** A live architectural shell with an editable model document. Roots without
 * a model continue to host authored freeform assemblies from earlier scenes. */
export class ArchitectureComponent extends Component {
  static type = "architecture";
  static label = "Architecture";
  static tags = ["architecture", "building", "city", "assembly", "structure", "world"];
  static defaults = { settings: {}, generatedRootId: "", version: 1, preview: true, model: null, collision: true, followTerrain: true, terrainId: "", terrainBindings: {} };
  static structuralProps = ["model"];
  static schema = [{ key: "preview", label: "Preview Materials", type: "boolean" }];
  onAttach() {
    this._ownedGeometries = new WeakSet();
    this._disposedGeometries = new WeakSet();
    this._modelMaterials = [];
    this._modelFootprints = [];
    this.surfaces = [];
    this._unsubModelMesh = this.entity.engine?.on?.("component-changed", (info) => {
      if (!this.props.model || info?.entityId !== this.entity.id || info.componentType !== "mesh" || info.architectureGenerated) return;
      if (!this.geometry || this._disposedGeometries.has(this.geometry)) this._rebuildModel();
      else this._adoptModelMesh();
    });
    this._unsubModelDependencies = this.entity.engine?.on?.("component-added", (info) => {
      if (!this.props.model || info?.entityId !== this.entity.id) return;
      if (info.componentType === "collider") this._syncModelCollider();
    });
    if (this.props.model) this._rebuildModel();
  }
  onDetach() {
    this._unsubModelMesh?.(); this._unsubModelMesh = null;
    this._unsubModelDependencies?.(); this._unsubModelDependencies = null;
    this._releaseModel();
  }
  onEnable() { if (this.props.model) this._adoptModelMesh(); }
  onDisable() {
    if (!this.props.model) return;
    if (this.mesh) this.mesh.visible = false;
    this.entity.getComponent("collider")?.setEnabledOverride?.(false);
  }
  onPropChanged(key) {
    if (key === "model") { this._rebuildModel(); return; }
    if (key === "collision" && this.props.model) {
      this._syncModelCollider();
      return;
    }
    if (key === "preview") for (const piece of this.pieces()) piece.refreshMaterial();
  }
  _disposeGeometry(geometry) {
    if (geometry && !this._disposedGeometries?.has(geometry)) geometry.dispose();
  }
  _releaseModel() {
    const source = this.entity.getComponent("mesh");
    if (this.mesh && source?.mesh === this.mesh) {
      if (this.mesh.geometry === this.geometry && this._previousGeometry) this.mesh.geometry = this._previousGeometry;
      if (this.mesh.userData.materialOwner === "architecture-model") {
        this.mesh.material = this._previousMaterial;
        this.mesh.userData.materialOwner = null;
      }
      delete this.mesh.userData.architectureSurfaces;
      delete this.mesh.userData.architectureModel;
      // The mesh returns to plain Mesh-component ownership: lift the merge/batch
      // opt-out with it, or the entity could never be instanced again.
      delete this.mesh.userData.noMerge;
      delete this.mesh.userData.noBatch;
    } else if (this._previousGeometry) disposeOrReleaseGeometry(this._previousGeometry);
    this._disposeGeometry(this.geometry);
    releaseModelMaterials(this._modelMaterials);
    for (const piece of this._modelFootprints ?? []) piece.geometry.dispose();
    if (this.mesh || this._model) this.entity.getComponent("collider")?.setEnabledOverride?.(null);
    this.geometry = null; this.mesh = null; this._model = null; this.surfaces = [];
    this._previousGeometry = null; this._previousMaterial = null;
    this._modelMaterials = []; this._modelFootprints = []; this._roomCache = null;
  }
  _adoptModelMesh() {
    if (!this.geometry || !this.props.model) return;
    let source = this.entity.getComponent("mesh");
    if (!source) {
      source = this.entity.addComponent("mesh", { collision: "none", castShadow: true, receiveShadow: true });
      // A component added to a bare entity must serialize its dependency first.
      // Otherwise reload would attach Architecture, add Mesh, then add it twice.
      this.entity.components.delete(this.type); this.entity.components.set(this.type, this);
    }
    const mesh = source.mesh;
    if (!mesh) return;
    if (!this._ownedGeometries.has(mesh.geometry) && mesh.geometry !== this._previousGeometry) {
      if (this._previousGeometry) disposeOrReleaseGeometry(this._previousGeometry);
      this._previousGeometry = mesh.geometry;
    }
    if (mesh !== this.mesh) this._previousMaterial = mesh.material;
    this.mesh = mesh;
    mesh.geometry = this.geometry;
    mesh.material = this._modelMaterials;
    mesh.userData.entityId = this.entity.id;
    mesh.userData.materialOwner = "architecture-model";
    mesh.userData.architectureModel = true;
    mesh.userData.architectureSurfaces = this.surfaces;
    // ⚠ NEVER A MERGE/BATCH MEMBER. The geometry is regenerated on every model
    // edit, and the editor's sculpt gestures rewrite it many times a second. A
    // static proxy would bake ONE snapshot, hide this member (`visible = false`
    // with `mergedInto`/`batchedInto` set), and — because merging early-returns
    // on announcements from a member it already holds — swallow every later
    // rebuild: the building on screen froze mid-drag at whatever thin early
    // state the proxy had captured, and that stale shape is what got committed.
    // This is the same ownership rule as skinnedmesh/terrain, just stamped per
    // mesh because the component only owns `mesh` through the Mesh component.
    mesh.userData.noMerge = true;
    mesh.userData.noBatch = true;
    const visible = this.enabled && source.enabled && this.geometry.attributes.position.count > 0;
    if (!visible || (!mesh.userData.mergedInto && !mesh.userData.batchedInto)) mesh.visible = visible;
    this._syncModelCollider();
  }
  _syncModelCollider() {
    const collides = this.enabled && this.props.collision !== false && this.geometry?.attributes.position.count > 0;
    this.entity.getComponent("collider")?.setEnabledOverride?.(collides ? null : false);
  }
  _rebuildModel() {
    if (!this.props.model) { this._releaseModel(); return; }
    const model = normalizeArchitectureModel(this.props.model);
    const built = buildArchitectureFormGeometry(model, { draft: !!this._draft });
    const materials = built.materials.map(acquireModelMaterial);
    const previous = this.geometry, previousMaterials = this._modelMaterials;
    this._model = model;
    this._terrainPreviewDirty = false;
    this.geometry = built.geometry;
    this._ownedGeometries.add(built.geometry);
    built.geometry.addEventListener("dispose", () => this._disposedGeometries.add(built.geometry));
    this._modelMaterials = materials;
    this.surfaces = built.surfaces;
    this._roomCache = null;
    this._adoptModelMesh();
    this._disposeGeometry(previous);
    releaseModelMaterials(previousMaterials);
    this._rebuildModelFootprints();
    this.entity.engine?.physics?.markDirty?.(this.entity, { subtree: false });
    // Geometry consumers subscribe to Mesh swaps, including picking bounds,
    // instancing, collision and GI. The authored source remains this model.
    this.entity.engine?.emit?.("component-changed", { entityId: this.entity.id, componentType: "mesh", key: "geometry", architectureGenerated: true });
  }
  /** Live gestures build a draft (silhouette, overhangs, openings; no coverings or small props);
   * leaving draft rebuilds full detail, mostly from the per-form cache. */
  setDraft(on) {
    on = !!on;
    if (this._draft === on) return;
    this._draft = on;
    if (!on && this.props.model) this._rebuildModel();
  }
  /** Terrain strokes move each connected building rigidly. Preview translates
   * the existing shell, avoiding geometry rebuilds, collider cooks and GI
   * invalidations for each brush dab. Stroke completion regenerates supports
   * and apertures and publishes the normal mesh change once. The followed
   * positions and attachment clearance serialize together, so loading a scene
   * or undoing terrain heights cannot accumulate another vertical offset. */
  applyTerrainModel(input, { preview = false } = {}) {
    const next = normalizeArchitectureModel(input);
    if (!preview || !this.geometry || !this._model) {
      this.props.model = next;
      this._terrainPreviewDirty = false;
      this._rebuildModel();
      this.entity.engine?.emit?.("component-changed", { entityId: this.entity.id, componentType: "architecture", key: "model", terrainFollowing: true });
      return;
    }
    const previous = new Map(this._model.forms.map(form => [form.id, form]));
    const deltas = new Map();
    for (const form of next.forms) {
      const old = previous.get(form.id);
      if (!old) return this.applyTerrainModel(next);
      const delta = form.position.map((value, i) => value - old.position[i]);
      if (delta.some(value => Math.abs(value) > 1e-10)) deltas.set(form.id, delta);
    }
    if (!deltas.size) return;
    const position = this.geometry.attributes.position, index = this.geometry.index;
    const visited = new Uint8Array(position.count);
    for (const surface of this.surfaces) {
      const delta = deltas.get(surface.formId);
      if (!delta) continue;
      for (let i = surface.start; i < surface.start + surface.count; i++) {
        const vertex = index.getX(i);
        if (visited[vertex]) continue;
        visited[vertex] = 1;
        position.setXYZ(vertex, position.getX(vertex) + delta[0], position.getY(vertex) + delta[1], position.getZ(vertex) + delta[2]);
      }
    }
    position.needsUpdate = true;
    this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere();
    for (let i = 0; i < next.forms.length; i++) {
      this._modelFootprints[i]?.entity.object3D.position.fromArray(next.forms[i].position);
    }
    this.props.model = next; this._model = next;
    this._roomCache = null; this._terrainPreviewDirty = true;
    this.entity.engine?.emit?.("architecture-terrain-preview", { entityId: this.entity.id });
  }
  /** Three's raycast faceIndex addresses triangles; surface ranges address indices. */
  surfaceAt(faceIndex) {
    if (!Number.isInteger(faceIndex)) return null;
    const index = faceIndex * 3;
    if (!Number.isInteger(index) || index < 0) return null;
    return this.surfaces?.find((surface) => index >= surface.start && index < surface.start + surface.count) ?? null;
  }
  _rebuildModelFootprints() {
    for (const piece of this._modelFootprints ?? []) piece.geometry.dispose();
    this._modelFootprints = [];
    const append = (position, rotationY, size, footprint, geometry) => {
      const object = new THREE.Object3D();
      object.position.fromArray(position); object.rotation.y = rotationY;
      // A mathematical child, never added to the scene or entity hierarchy.
      object.parent = this.entity.object3D;
      const pseudoEntity = { object3D: object, parent: this.entity, enabled: true };
      this._modelFootprints.push({ entity: pseudoEntity, geometry, enabled: true,
        props: { size, footprint, holes: [] }, bounds: () => [[-size[0] / 2, 0, -size[2] / 2], [size[0] / 2, size[1], size[2] / 2]] });
    };
    for (const form of this._model.forms) {
      const [w, h, d] = form.size;
      const geometry = form.shape === "round"
        ? new THREE.CylinderGeometry(.5, .5, h, 24, 1, false, Math.PI / 2).scale(w, 1, d).translate(0, h / 2, 0)
        : new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
      // The exported footprint is root-local; this pseudo-piece uses a local ring.
      const footprint = form.shape === "round" ? Array.from({ length: 24 }, (_, i) => [Math.cos(i / 24 * Math.PI * 2) * w / 2, Math.sin(i / 24 * Math.PI * 2) * d / 2]) : [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
      append(form.position, form.rotationY, form.size, footprint, geometry);
    }
    for (const path of this._model.paths) for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < .001) continue;
      const size = [length, .1, path.width];
      append([(a[0] + b[0]) / 2, path.elevation, (a[1] + b[1]) / 2], Math.atan2(-(b[1] - a[1]), b[0] - a[0]), size,
        [[-length / 2, -path.width / 2], [length / 2, -path.width / 2], [length / 2, path.width / 2], [-length / 2, path.width / 2]], new THREE.BoxGeometry(...size).translate(0, .05, 0));
    }
  }
  footprintPieces() { return this.props.model ? this._modelFootprints ?? [] : this.pieces(); }
  _modelRooms(options) {
    if (!this.mesh || !this.geometry || !this._model) return [];
    this.mesh.updateWorldMatrix(true, false);
    const matrix = this.mesh.matrixWorld;
    const maxRooms = Math.max(1, Math.min(64, Number(options.maxRooms) || 16));
    if (this._roomCache?.geometry === this.geometry && this._roomCache.maxRooms === maxRooms && this._roomCache.matrix.every((value, index) => value === matrix.elements[index])) return this._roomCache.rooms;
    const rooms = [], keys = new Set(), ray = new THREE.Raycaster();
    ray.layers.mask = this.mesh.layers.mask;
    const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const form of this._model.forms) {
      if (rooms.length >= maxRooms) break;
      if (form.roof === "none") continue;
      let center, distances;
      // Try above ordinary door/window heads, then off-center interior samples.
      // A doorway through one sample must not discard the whole inhabited room.
      for (const [x, y, z] of [[0, .72, 0], [0, .45, 0], [.15, .65, .15], [-.15, .65, -.15]]) {
        center = new THREE.Vector3(x * form.size[0], y * form.size[1], z * form.size[2]);
        center.applyAxisAngle(new THREE.Vector3(0, 1, 0), form.rotationY).add(new THREE.Vector3(...form.position)).applyMatrix4(matrix);
        distances = directions.map((direction) => {
          ray.set(center, new THREE.Vector3(...direction));
          return ray.intersectObject(this.mesh, false)[0]?.distance ?? null;
        });
        if (distances.every(distance => distance !== null && distance >= .1)) break;
      }
      // A capture point must sit in an enclosed cavity; open roofs, doorways
      // through the sample and solid masses do not invent reflection rooms.
      if (distances.some((distance) => distance === null || distance < .1)) continue;
      const size = [distances[0] + distances[1], distances[2] + distances[3], distances[4] + distances[5]];
      const boxCenter = center.clone().add(new THREE.Vector3((distances[0] - distances[1]) / 2, (distances[2] - distances[3]) / 2, (distances[4] - distances[5]) / 2));
      const key = [...boxCenter.toArray(), ...size].map((value) => Math.round(value * 10)).join(":");
      if (keys.has(key)) continue; keys.add(key);
      rooms.push({ key: `${this.entity.id}:form:${form.id}`, center: boxCenter.toArray(), size, capture: center.toArray(), area: size[0] * size[2] });
    }
    this._roomCache = { geometry: this.geometry, matrix: [...matrix.elements], maxRooms, rooms };
    return rooms;
  }
  pieces() {
    const pieces = [];
    const walk = entity => {
      if (entity !== this.entity && entity.getComponent?.("architecture")) return;
      const piece = entity.getComponent?.("architecturepiece") ?? entity.getComponent?.("blockout");
      if (piece) pieces.push(piece);
      for (const child of entity.children ?? []) walk(child);
    };
    walk(this.entity);
    return pieces;
  }
  /** Discover enclosed volumes from actual wall heights. Grouping is inferred
   * from the geometry, so a bridge, tilted assembly or open pavilion requires
   * no artificial floors or reflection rooms. */
  rooms(options = {}) {
    if (this.props.model) return this._modelRooms(options);
    const groups = new Map();
    const point = new THREE.Vector3(), top = new THREE.Vector3();
    for (const piece of this.pieces()) {
      if (piece.enabled === false || piece.props.shape !== "wall") continue;
      const object = piece.entity.object3D;
      object.updateWorldMatrix(true, false);
      point.set(0, 0, 0).applyMatrix4(object.matrixWorld);
      top.set(0, piece.props.size?.[1] ?? 3, 0).applyMatrix4(object.matrixWorld);
      const height = top.y - point.y;
      if (height < .5 || Math.hypot(top.x - point.x, top.z - point.z) > .05) continue;
      const key = `${Math.round(point.y * 20)}`;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { pieces: [], elevation: point.y, height });
      group.height = Math.min(group.height, height); group.pieces.push(piece);
    }
    const rooms = [];
    const maxRooms = Math.max(1, Math.min(64, Number(options.maxRooms) || 16));
    for (const [key, group] of groups) {
      if (rooms.length >= maxRooms) break;
      const origin = new THREE.Object3D(); origin.position.y = group.elevation;
      const proxy = { entity: { id: `${this.entity.id}:${key}`, object3D: origin }, props: { storeyHeight: group.height }, pieces: () => group.pieces };
      rooms.push(...levelRooms(proxy, { ...options, cell: Math.max(.05, Number(options.cell) || .25), maxRooms: maxRooms - rooms.length }).map(room => ({ ...room, key: `${this.entity.id}:${key}:${room.key}` })));
    }
    return rooms;
  }
}
