// @ts-check
import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadMaterialAsset } from "../materialAsset.js";
import { acquireModelAsset, releaseModelAsset, instantiateModel } from "../modelAsset.js";
import { invalidateEntityBounds } from "../viewFrustum.js";
import { applyCastShadow } from "../shadowMerge.js";

export class ModelComponent extends Component {
  static type = "model";
  static label = "Model";
  // Internal owner for skinned/animated GLBs. User-facing render controls are
  // exposed through Mesh handles; this component only owns the loaded GLB,
  // skeleton and animation clips.
  static internal = true;
  static defaults = {
    path: "",
    materials: {}, // GLTF material name -> .mat asset path override
    castShadow: true,
    receiveShadow: true,
    // Read by the optional physics module. Deleting its generated Collider
    // persists as `none` here, so reopening the scene does not recreate it.
    collision: "auto",
  };
  static schema = [
    { key: "path", label: "File", type: "asset", exts: ["glb"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
    { key: "collision", label: "Default Collider", type: "select", options: ["auto", "none"], module: "physics-rapier" },
  ];

  onAttach() {
    this.root = null;
    this.template = null; // borrowed parse from modelAsset.js; owns geometry/materials/textures
    this.clips = [];
    this.skeletonBindings = [];
    this.unsubSkeletonSync = null;
    this.sharedMaterials = new Set(); // .mat-backed materials we must not dispose
    this.generation = (this.generation ?? 0) + 1;
    const generation = this.generation;
    this.assetLoadsPending = !!this.props.path;
    this._readyPromise = this.props.path
      ? this.#load(this.props.path, generation).finally(() => {
          if (generation === this.generation) this.assetLoadsPending = false;
        })
      : Promise.resolve();
  }

  /** Resolves after the model and any material overrides are attached. */
  whenReady() {
    return this._readyPromise ?? Promise.resolve();
  }

  async #load(path, generation) {
    try {
      // One parse per GLB path, shared by every entity (see modelAsset.js).
      const template = await acquireModelAsset(path);
      if (generation !== this.generation) {
        releaseModelAsset(template); // detached/reloaded meanwhile
        return;
      }
      this.template = template;
      // Clips come pre-rebased (master-timeline exports) and are shared;
      // the array is this entity's own.
      const { root, clips } = instantiateModel(template);
      this.root = root;
      // Commit the model atomically after overrides. Large GLBs otherwise show
      // bare geometry first and repaint one material at a time while GI sees a
      // half-authored scene.
      this.root.visible = false;
      this.clips = clips;
      this.root.userData.entityId = this.entity.id;
      this.root.traverse((obj) => {
        obj.userData.entityId = this.entity.id;
        if (obj.isMesh) {
          applyCastShadow(obj, this.props.castShadow !== false, this.entity.engine);
          obj.receiveShadow = this.props.receiveShadow !== false;
        }
      });
      this.entity.object3D.add(this.root);
      await this.#applyMaterialOverrides(generation);
      // Honour the enabled flag at load time — visible by default, hidden if
      // the user saved the scene with the component disabled.
      this.root.visible = this._enabled;
      this.bindSkeletonEntities();
      // A model's meshes hang off `entity.object3D`, not off child ENTITIES, so
      // nothing in the bounding-sphere cache's per-entity hash can see them
      // appear — and the entity did not move while loading. Without this the
      // cache keeps answering "no geometry" or the placeholder's radius for the
      // rest of the session, which is what stopped imported buildings from ever
      // being tagged as occluders. See viewFrustum.js.
      invalidateEntityBounds();
      this.entity.engine.emit("model-loaded", this.entity);
    } catch (err) {
      console.error(`Failed to load model "${path}": ${err.message}`);
    }
  }

  /**
   * Connects imported `bone` entities below this model to their matching GLB
   * Bones.  The entity hierarchy remains normal engine data; each frame we
   * copy the final animated bone pose into those entities, which means an
   * ordinary child entity automatically becomes an attachment (weapon, VFX,
   * hitbox, ...).
   */
  bindSkeletonEntities() {
    if (!this.root || !this.entity) return;
    const bindings = [];
    this.entity.traverse((entity) => {
      const bone = entity.getComponent("bone");
      if (!bone || nearestModel(entity) !== this) return;
      const source = objectAtPath(this.root, bone.props.path);
      if (source?.isBone) bindings.push({ entity, source });
    });
    this.skeletonBindings = bindings;

    // Late stage, at the END of the pose pipeline: the animator writes bones
    // during onUpdate and IK solvers bend them at late-order 0, so reading the
    // pose at order 100 gets the FINAL bone transforms. Ordering this by
    // subscription time instead (which is what it used to do, relying on the
    // GLB finishing after AnimationComponent attached) left an attached weapon
    // holding the pre-IK pose — one frame of lag that only shows up on the
    // hand that IK actually moved.
    if (bindings.length && !this.unsubSkeletonSync) {
      this.unsubSkeletonSync = this.entity.engine.onLateUpdate(() => this.#syncSkeletonEntities(), 100);
    }
    if (!bindings.length) {
      this.unsubSkeletonSync?.();
      this.unsubSkeletonSync = null;
    }
    this.#syncSkeletonEntities();
  }

  #syncSkeletonEntities() {
    if (!this.root || !this.skeletonBindings.length) return;
    // AnimationMixer changes local transforms. Refresh the GLB's world
    // matrices once before deriving every attachment's local pose.
    this.entity.object3D.updateMatrixWorld(true);
    this.root.updateMatrixWorld(true);
    for (const { entity, source } of this.skeletonBindings) {
      const parent = entity.parent?.object3D;
      if (!parent) continue;
      parent.updateMatrixWorld(true);
      _relative.multiplyMatrices(_inverse.copy(parent.matrixWorld).invert(), source.matrixWorld);
      _relative.decompose(entity.position, entity.quaternion, entity.scale);
    }
  }

  /** Swaps named GLTF materials for shared .mat assets (props.materials). */
  async #applyMaterialOverrides(generation) {
    const overrides = this.props.materials ?? {};
    if (!this.root || !Object.keys(overrides).length) return;
    const plans = [];
    const loads = new Map();
    this.root.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const array = Array.isArray(mesh.material);
      const materials = array ? [...mesh.material] : [mesh.material];
      const paths = materials.map((material) =>
        material?.name != null ? overrides[material.name] : null,
      );
      for (const path of paths) {
        if (path && !loads.has(path)) loads.set(path, loadMaterialAsset(path));
      }
      plans.push({ mesh, array, materials, paths });
    });

    const resolved = new Map();
    await Promise.all([...loads].map(async ([path, promise]) => {
      resolved.set(path, await promise);
    }));
    if (generation !== this.generation) return;

    for (const { mesh, array, materials, paths } of plans) {
      const replaced = materials.map((material, index) => {
        const shared = paths[index] ? resolved.get(paths[index]) : null;
        if (!shared) return material;
        this.sharedMaterials.add(shared);
        // Never dispose the GLB material here: it belongs to the cached
        // template, and other instances of this model still render it.
        return shared;
      });
      mesh.material = array ? replaced : replaced[0];
    }
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.assetLoadsPending = false;
    this.unsubSkeletonSync?.();
    this.unsubSkeletonSync = null;
    this.skeletonBindings = [];
    if (this.root) this.entity.object3D.remove(this.root);
    this.root = null;
    this.clips = [];
    this.sharedMaterials?.clear();
    // Geometry, GLB materials and their textures are the template's; the cache
    // disposes them (textures included) when the last instance releases.
    if (this.template) releaseModelAsset(this.template);
    this.template = null;
  }

  onDisable() {
    if (this.root) this.root.visible = false;
  }

  onEnable() {
    if (this.root) this.root.visible = true;
  }

  onPropChanged(key) {
    if (key === "collision") return;
    if ((key === "castShadow" || key === "receiveShadow") && this.root) {
      this.root.traverse((obj) => {
        if (!obj.isMesh) return;
        if (key === "castShadow") applyCastShadow(obj, this.props[key] !== false, this.entity.engine);
        else obj[key] = this.props[key] !== false;
      });
      return;
    }
    this.onDetach();
    this.onAttach();
  }
}

const _inverse = new THREE.Matrix4();
const _relative = new THREE.Matrix4();

/** Returns the nested Object3D addressed by a slash-separated child index path. */
function objectAtPath(root, path) {
  if (typeof path !== "string" || !path) return null;
  let object = root;
  for (const part of path.split("/")) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0) return null;
    object = object.children[index];
    if (!object) return null;
  }
  return object;
}

/** The closest model ancestor owns a bone marker (nested models stay isolated). */
function nearestModel(entity) {
  for (let current = entity.parent; current; current = current.parent) {
    const model = current.getComponent("model");
    if (model) return model;
  }
  return null;
}
