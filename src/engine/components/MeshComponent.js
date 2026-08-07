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
    // ── GI: TWO INDEPENDENT AXES (src/modules/gi/dynamicObjects.js) ──────
    // Does it move, and what do rays intersect? Unrelated questions that used
    // to share one dropdown — which meant "I want exact triangles" could only
    // be said by ALSO declaring the object a mover. That conflation is what
    // put 30 static Sponza meshes into the per-ray mover loop (2026-08-06).
    //
    // giMobility — "auto": voxelized while it sits still, adopted into the
    // exact ray-traced mover path on first motion (and demoted back after a
    // long rest in edit mode). "static": never adopt — it stays in the voxel
    // field for radiance and in the world static shadow BVH, which ALREADY
    // gives it exact triangle shadows. "dynamic": adopt at load without
    // waiting for motion. Every mover is tested by every ray, so "dynamic"
    // is the expensive one — use it for things that actually move.
    giMobility: "auto",
    // giTrace — the surface a ray intersects once this mesh IS a mover.
    // "auto": by geometry (three.js primitives with a closed form → analytic
    // sphere/capsule/frustum/OBB, everything else → exact triangle BVH).
    // "bvh": force exact triangles. "obb": force the bounding box (cheapest).
    // "voxel": never go exact — keep the voxel path even while moving.
    // Ignored while giMobility is "static": static surfaces are already exact.
    giTrace: "auto",
    // LEGACY pre-split tag. Migrated to the pair above on attach, then left
    // alone; scenes written before the split still carry it.
    giDynamic: "auto",
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
    { key: "giMobility", label: "GI Mobility", type: "select", options: ["auto", "static", "dynamic"] },
    // Only meaningful for movers — a static mesh is traced exactly by the
    // world shadow BVH no matter what this says.
    { key: "giTrace", label: "GI Trace", type: "select", options: ["auto", "bvh", "obb", "voxel"], showIf: (props) => props.giMobility !== "static" },
    // `hidden` keeps this out of the inspector, but it does NOT cross the MCP
    // bridge: `component.types` projects key/label/type/options only, so an
    // assistant reading the schema sees THREE GI selects with nothing to rank
    // them. The label is the one piece of free text that projection carries per
    // property, so it has to name the replacement outright — otherwise the
    // cheapest thing for a model to reach for is the one word it already knows,
    // and setting `giDynamic` on a mesh whose pair is no longer "auto"/"auto"
    // is silently ignored by the migration below. "voxel" is in the option list
    // because scenes written before the split contain it, even though the
    // pre-split dropdown never offered it.
    {
      key: "giDynamic",
      label: "GI Dynamic (DEPRECATED — set giMobility + giTrace instead)",
      type: "select",
      options: ["auto", "static", "dynamic", "voxel", "bvh", "obb"],
      hidden: true,
    },
  ];

  constructor(props = {}) {
    super(props);
    // Scene-wide systems must not measure the placeholder box installed by
    // onAttach() while authored assets are still streaming in. Each flag
    // describes only the current request generation; a superseded promise
    // cannot clear a newer request's flag.
    this._geometryAssetLoading = false;
    this._materialAssetLoading = false;
    this._extraMaterialAssetsLoading = false;
  }

  /** True while this mesh still renders any async asset placeholder state. */
  get assetLoadsPending() {
    return this._geometryAssetLoading ||
      this._materialAssetLoading ||
      this._extraMaterialAssetsLoading;
  }

  onAttach() {
    const makeGeometry = geometryFactories[this.props.geometry] ?? geometryFactories.box;
    this.mesh = new THREE.Mesh(makeGeometry(), getDefaultMaterial());
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = !!this.props.receiveShadow;
    this.#applyGiDynamic();
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
    this.extraMaterialGeneration = (this.extraMaterialGeneration ?? 0) + 1;
    this._geometryAssetLoading = false;
    this._materialAssetLoading = false;
    this._extraMaterialAssetsLoading = false;
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
    this._materialAssetLoading = true;
    try {
      await loadMaterialAsset(path);
      if (generation !== this.sharedGeneration || !this.mesh) return;
      // Re-adopt on every change: the shared instance is swapped when the .mat
      // flips surface ↔ volume, and its renderable state flips when the graph's
      // Surface/Volume wiring changes.
      this.materialUnsub?.();
      this.materialUnsub = subscribeMaterial(path, () => this.#applySharedMaterial(path));
      this.#applySharedMaterial(path);
    } finally {
      if (generation === this.sharedGeneration) this._materialAssetLoading = false;
    }
  }

  async #loadExtraMaterials() {
    const generation = (this.extraMaterialGeneration = (this.extraMaterialGeneration ?? 0) + 1);
    const paths = Array.from({ length: 7 }, (_, index) => this.props[`material${index + 2}`] ?? '');
    this._extraMaterialAssetsLoading = paths.some(Boolean);
    try {
      await Promise.all(paths.filter(Boolean).map((path) => loadMaterialAsset(path)));
      if (generation !== this.extraMaterialGeneration || !this.mesh) return;
      this.extraMaterialUnsubs?.forEach((unsubscribe) => unsubscribe());
      this.extraMaterialUnsubs = paths.filter(Boolean).map((path) => subscribeMaterial(path, () => this.#applyMaterialSlots()));
      this.#applyMaterialSlots();
    } finally {
      if (generation === this.extraMaterialGeneration) this._extraMaterialAssetsLoading = false;
    }
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
    this._geometryAssetLoading = true;
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
    } finally {
      if (generation === this.geometryGeneration) this._geometryAssetLoading = false;
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
        this._geometryAssetLoading = false;
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
        this._materialAssetLoading = false;
        this.#applyMaterialSlots();
        this.materialRenderable = true;
        this.mesh.visible = this.enabled;
      }
    } else if (/^material[2-8]$/.test(key)) {
      this.#loadExtraMaterials();
    } else if (key === "castShadow" || key === "receiveShadow") {
      this.mesh[key] = !!this.props[key];
    } else if (key === "giDynamic" || key === "giMobility" || key === "giTrace") {
      // Live: the GI system re-reads the tags every frame for adopted movers
      // and before every adoption, so no rebuild is needed here.
      this.#applyGiDynamic();
    }
  }

  /**
   * Mirrors the GI tags onto the render mesh's userData — what the GI
   * classifier and the adoption path read (dynamicObjects.js). "auto" clears,
   * so an untagged mesh carries no userData at all.
   *
   * MIGRATION: a scene written before the mobility/trace split carries only
   * `giDynamic`. Its five values each meant a (mobility, trace) PAIR, so they
   * map cleanly — and the mapping is applied to the PROPS, once, so the next
   * save writes the new pair and the inspector shows what is actually in
   * effect. It is deliberately faithful: "dynamic"/"bvh"/"obb" really did pin
   * the object as a mover, and silently un-pinning them would change what the
   * scene renders. (If that pin was unintentional — the common case, since
   * wanting exact triangles was the only reason to reach for "bvh" — the GI
   * mover-cap warning names it, and GI Mobility "static" is the fix.)
   */
  #applyGiDynamic() {
    if (!this.mesh) return;
    const legacy = this.props.giDynamic;
    if (legacy && legacy !== "auto" && this.props.giMobility === "auto" && this.props.giTrace === "auto") {
      const map = {
        static: ["static", "auto"],
        voxel: ["auto", "voxel"],
        none: ["auto", "voxel"],
        dynamic: ["dynamic", "auto"],
        bvh: ["dynamic", "bvh"],
        obb: ["dynamic", "obb"],
      }[legacy];
      if (map) {
        this.props.giMobility = map[0];
        this.props.giTrace = map[1];
      }
    }
    const write = (key, v) => {
      if (v && v !== "auto") this.mesh.userData[key] = v;
      else delete this.mesh.userData[key];
    };
    write("giMobility", this.props.giMobility);
    write("giTrace", this.props.giTrace);
    // The legacy key is no longer read once either new tag is present, but a
    // stale value on the mesh would still answer giMobilityOf's fallback.
    delete this.mesh.userData.giDynamic;
  }
}
