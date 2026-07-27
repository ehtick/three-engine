import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import {
  loadMaterialAsset,
  getDefaultMaterial,
  isVolumeMaterial,
  getMaterialInstance,
  isMaterialRenderable,
  subscribeMaterial,
} from "../materialAsset.js";
import { acquireGeometryAsset, disposeOrReleaseGeometry } from "../geometryAsset.js";

const geometryFactories = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
  plane: () => new THREE.PlaneGeometry(1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
  cone: () => new THREE.ConeGeometry(0.5, 1, 32),
  torus: () => new THREE.TorusGeometry(0.4, 0.15, 16, 48),
};

/**
 * Geometry + a material asset reference. All surface properties live in the
 * .mat asset (shared instance, see materialAsset.js); with no material
 * assigned the mesh uses the shared default white material. Meshes never
 * dispose materials — they don't own them.
 */
export class MeshComponent extends Component {
  static type = "mesh";
  static label = "Mesh";
  static defaults = {
    geometry: "box",
    geometryAsset: "",
    material: "", // .mat asset path; empty = default white
    material2: "",
    material3: "",
    material4: "",
    material5: "",
    material6: "",
    material7: "",
    material8: "",
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "geometry", label: "Primitive", type: "select", options: Object.keys(geometryFactories), showIf: (props) => !props.geometryAsset },
    { key: "geometryAsset", label: "Geometry", type: "asset", exts: ["geom"] },
    { key: "material", label: "Material", type: "asset", exts: ["mat"], emptyLabel: "Default" },
    // Slots 2-8 exist for multi-material geometry, but a mesh starts with one.
    // `hidden` keeps them out of the generic schema-driven inspector rows; the
    // Mesh section renders a dedicated slot list that grows on demand instead
    // of showing eight mostly-empty pickers on every mesh in the scene.
    { key: "material2", label: "Material 2", type: "asset", exts: ["mat"], hidden: true },
    { key: "material3", label: "Material 3", type: "asset", exts: ["mat"], hidden: true },
    { key: "material4", label: "Material 4", type: "asset", exts: ["mat"], hidden: true },
    { key: "material5", label: "Material 5", type: "asset", exts: ["mat"], hidden: true },
    { key: "material6", label: "Material 6", type: "asset", exts: ["mat"], hidden: true },
    { key: "material7", label: "Material 7", type: "asset", exts: ["mat"], hidden: true },
    { key: "material8", label: "Material 8", type: "asset", exts: ["mat"], hidden: true },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    const makeGeometry = geometryFactories[this.props.geometry] ?? geometryFactories.box;
    this.mesh = new THREE.Mesh(makeGeometry(), getDefaultMaterial());
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = !!this.props.receiveShadow;
    this.entity.object3D.add(this.mesh);
    if (this.props.geometryAsset) this.#loadGeometry(this.props.geometryAsset);
    if (this.props.material) this.#loadSharedMaterial(this.props.material);
    this.#loadExtraMaterials();
    // Honour the enabled flag at attach time.
    this.mesh.visible = this.enabled;
  }

  onDetach() {
    if (!this.mesh) return;
    this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
    this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
    this.materialUnsub?.();
    this.materialUnsub = null;
    this.extraMaterialUnsubs?.forEach((unsubscribe) => unsubscribe());
    this.extraMaterialUnsubs = [];
    this.entity.object3D.remove(this.mesh);
    this.#releaseGeometry(this.mesh.geometry);
    this.mesh = null;
  }

  /**
   * Drops this mesh's claim on `geometry`. Geometry loaded from a `.geom` is a
   * SHARED instance (see geometryAsset.js) that other meshes may still be
   * rendering, so it must be refcount-released rather than disposed outright;
   * anything else (a primitive we built, an evaluated modifier result) is ours
   * alone and is disposed.
   */
  #releaseGeometry(geometry) {
    disposeOrReleaseGeometry(geometry);
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    // A material with nothing wired to Surface/Volume must stay hidden even
    // when the component is enabled.
    if (this.mesh) this.mesh.visible = this.materialRenderable !== false;
  }

  async #loadSharedMaterial(path) {
    const generation = (this.sharedGeneration = (this.sharedGeneration ?? 0) + 1);
    await loadMaterialAsset(path);
    if (generation !== this.sharedGeneration || !this.mesh) return;
    // Re-adopt on every change: the shared instance is swapped when the .mat
    // flips surface ↔ volume, and its renderable state flips when the graph's
    // Surface/Volume wiring changes.
    this.materialUnsub?.();
    this.materialUnsub = subscribeMaterial(path, () => this.#applySharedMaterial(path));
    this.#applySharedMaterial(path);
  }

  async #loadExtraMaterials() {
    const generation = (this.extraMaterialGeneration = (this.extraMaterialGeneration ?? 0) + 1);
    const paths = Array.from({ length: 7 }, (_, index) => this.props[`material${index + 2}`] ?? '');
    await Promise.all(paths.filter(Boolean).map((path) => loadMaterialAsset(path)));
    if (generation !== this.extraMaterialGeneration || !this.mesh) return;
    this.extraMaterialUnsubs?.forEach((unsubscribe) => unsubscribe());
    this.extraMaterialUnsubs = paths.filter(Boolean).map((path) => subscribeMaterial(path, () => this.#applyMaterialSlots()));
    this.#applyMaterialSlots();
  }

  #applyMaterialSlots() {
    if (!this.mesh) return;
    const paths = [this.props.material ?? '', ...Array.from({ length: 7 }, (_, index) => this.props[`material${index + 2}`] ?? '')];
    const hasExtraMaterial = paths.slice(1).some(Boolean);
    // Geometry groups retain their numeric material slot even when that slot
    // has no asset assigned. Keep the complete slot array so faces in an empty
    // (especially trailing) slot render with the default material instead of
    // disappearing because Three.js cannot resolve the group index.
    const materials = paths.map((path) => getMaterialInstance(path) ?? getDefaultMaterial());
    // Three.js only renders a material array through BufferGeometry groups.
    // Most GLTF primitives are unpacked as one mesh per material and therefore
    // have no groups; assigning an array to those makes every face disappear.
    // Built-in primitives also have implementation-detail groups (a box has
    // one per side). Until an extra slot is explicitly assigned, keep a single
    // material so Material 1 covers the entire primitive instead of only group
    // 0. Once a second slot is used, preserve all slots for authored geometry.
    this.mesh.material = hasExtraMaterial && this.mesh.geometry?.groups?.length ? materials : materials[0];
  }

  async #loadGeometry(path) {
    const generation = (this.geometryGeneration = (this.geometryGeneration ?? 0) + 1);
    try {
      const geometry = await acquireGeometryAsset(path);
      if (generation !== this.geometryGeneration || !this.mesh) {
        this.#releaseGeometry(geometry);
        return;
      }
      const terrain = this.entity.getComponent("terrain");
      if (terrain?.mesh === this.mesh) {
        // Terrain owns the live deformable geometry; the .geom remains the
        // persistent base asset shown in this component input.
        this.#releaseGeometry(geometry);
      } else {
        this.#releaseGeometry(this.mesh.geometry);
        this.mesh.geometry = geometry;
        // Material binding depends on whether the newly-loaded geometry has
        // groups. The placeholder box does, while many imported GLTF
        // primitives do not, so re-evaluate after the asynchronous swap.
        this.#applyMaterialSlots();
      }
      this.#announceSwap("geometryAsset"); // same stale-reference problem as material
    } catch (err) {
      console.warn(`Couldn't load geometry asset "${path}": ${err}`);
    }
  }

  #applySharedMaterial(path) {
    if (!this.mesh) return;
    const terrainManaged = this.entity.getComponent("terrain")?.mesh === this.mesh;
    if (!terrainManaged) this.#applyMaterialSlots();
    this.materialRenderable = isMaterialRenderable(path);
    // A volume material renders nothing on the box's faces — the geometry is
    // just the raymarch container, so it must be the unit box that
    // `unitBoxMask` clips against. Snap non-box geometry to one.
    if (!terrainManaged && isVolumeMaterial(path) && (this.props.geometry !== "box" || this.props.geometryAsset)) {
      this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
      console.warn(`Mesh "${this.entity?.name ?? this.entity?.id}" uses a volume .mat — snapping geometry to box for correct raymarch bounds.`);
      this.#releaseGeometry(this.mesh.geometry);
      this.mesh.geometry = new THREE.BoxGeometry(1, 1, 1);
      this.props.geometry = "box";
      this.props.geometryAsset = "";
    }
    this.mesh.visible = this.enabled && this.materialRenderable !== false;
    // `mesh.material` is a *new object* now — the shared .mat instance replaced
    // the placeholder default we were created with. Anything that captured the
    // old reference (terrain scatter builds InstancedMeshes from this mesh) is
    // holding a stale material and would render white forever. This resolve is
    // async and isn't a `setProp`, so nothing else announces it.
    this.#announceSwap("material");
  }

  #announceSwap(key) {
    this.entity?.engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key,
    });
  }

  onPropChanged(key) {
    if (key === "geometry" || !this.mesh) {
      super.onPropChanged();
      return;
    }
    if (key === "geometryAsset") {
      this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
      if (this.props.geometryAsset) {
        this.#loadGeometry(this.props.geometryAsset);
      } else {
        this.#releaseGeometry(this.mesh.geometry);
        const makeGeometry = geometryFactories[this.props.geometry] ?? geometryFactories.box;
        this.mesh.geometry = makeGeometry();
      }
    } else if (key === "material") {
      this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
      this.materialUnsub?.();
      this.materialUnsub = null;
      if (this.props.material) {
        // Adopt the cached instance immediately when already loaded — without
        // this the mesh sits on `getDefaultMaterial()` (white) for one frame
        // between the commit and `loadMaterialAsset` resolving. `#loadSharedMaterial`
        // will still run for the visibility / generation / subscribe plumbing.
        const cached = getMaterialInstance(this.props.material);
        if (cached) {
          const paths = [this.props.material, ...Array.from({ length: 7 }, (_, index) => this.props[`material${index + 2}`] ?? '')];
          const hasExtraMaterial = paths.slice(1).some(Boolean);
          this.mesh.material = hasExtraMaterial && this.mesh.geometry?.groups?.length ? paths.map((p) => getMaterialInstance(p) ?? getDefaultMaterial()) : cached;
          this.materialRenderable = isMaterialRenderable(this.props.material);
          this.mesh.visible = this.enabled && this.materialRenderable !== false;
        } else {
          // Cold cache: leave the mesh on its current material rather than
          // reverting to the default placeholder — the `#loadSharedMaterial`
          // call below will adopt the real instance once it arrives.
        }
        this.#loadSharedMaterial(this.props.material);
      } else {
        this.#applyMaterialSlots();
        this.materialRenderable = true;
        this.mesh.visible = this.enabled;
      }
    } else if (/^material[2-8]$/.test(key)) {
      this.#loadExtraMaterials();
    } else if (key === "castShadow" || key === "receiveShadow") {
      this.mesh[key] = !!this.props[key];
    }
  }
}
