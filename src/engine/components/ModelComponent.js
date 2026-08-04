import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { loadMaterialAsset } from "../materialAsset.js";
import { getGltfLoader, rebaseClipToZero } from "../gltfLoader.js";

// Draco-enabled shared loader: Draco-compressed .glb (from the draco module)
// decode transparently; plain .glb are unaffected.
const loader = getGltfLoader();

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
  };
  static schema = [
    { key: "path", label: "File", type: "asset", exts: ["glb"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.root = null;
    this.clips = [];
    this.skeletonBindings = [];
    this.unsubSkeletonSync = null;
    this.sharedMaterials = new Set(); // .mat-backed materials we must not dispose
    this.generation = (this.generation ?? 0) + 1;
    this._readyPromise = this.props.path
      ? this.#load(this.props.path, this.generation)
      : Promise.resolve();
  }

  /** Resolves after the model and any material overrides are attached. */
  whenReady() {
    return this._readyPromise ?? Promise.resolve();
  }

  async #load(path, generation) {
    try {
      const url = await resolveAssetUrl(path);
      const gltf = await loader.loadAsync(url);
      if (generation !== this.generation) return; // detached/reloaded meanwhile
      this.root = gltf.scene;
      // Rebase clips exported from a shared master timeline (keyframes not
      // starting at t=0) so they actually play instead of holding one pose.
      this.clips = (gltf.animations ?? []).map(rebaseClipToZero);
      this.root.userData.entityId = this.entity.id;
      this.root.traverse((obj) => {
        obj.userData.entityId = this.entity.id;
        if (obj.isMesh) {
          obj.castShadow = this.props.castShadow !== false;
          obj.receiveShadow = this.props.receiveShadow !== false;
          // Provenance for derived-data sidecars (e.g. baked mesh SDFs):
          // GLB-internal geometries have no asset path of their own, so
          // consumers key persisted artifacts off the model file instead.
          if (obj.geometry && !obj.geometry.userData.sourceModelPath) {
            obj.geometry.userData.sourceModelPath = path;
          }
        }
      });
      this.entity.object3D.add(this.root);
      await this.#applyMaterialOverrides(generation);
      // Honour the enabled flag at load time — visible by default, hidden if
      // the user saved the scene with the component disabled.
      this.root.visible = this._enabled;
      this.bindSkeletonEntities();
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
    const meshes = [];
    this.root.traverse((obj) => obj.isMesh && meshes.push(obj));
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const replaced = await Promise.all(
        mats.map(async (mat) => {
          const matPath = mat?.name != null ? overrides[mat.name] : null;
          if (!matPath) return mat;
          const shared = await loadMaterialAsset(matPath);
          this.sharedMaterials.add(shared);
          if (mat && !this.sharedMaterials.has(mat)) mat.dispose();
          return shared;
        }),
      );
      if (generation !== this.generation) return;
      mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0];
    }
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubSkeletonSync?.();
    this.unsubSkeletonSync = null;
    this.skeletonBindings = [];
    if (!this.root) return;
    this.entity.object3D.remove(this.root);
    this.root.traverse((obj) => {
      obj.geometry?.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (mat && !this.sharedMaterials.has(mat)) mat.dispose();
      }
    });
    this.root = null;
    this.clips = [];
    this.sharedMaterials.clear();
  }

  onDisable() {
    if (this.root) this.root.visible = false;
  }

  onEnable() {
    if (this.root) this.root.visible = true;
  }

  onPropChanged(key) {
    if ((key === "castShadow" || key === "receiveShadow") && this.root) {
      this.root.traverse((obj) => {
        if (obj.isMesh) obj[key] = this.props[key] !== false;
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
