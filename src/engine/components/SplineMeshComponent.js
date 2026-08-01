import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveSpline } from "./SplineComponent.js";
import { buildSplineGeometry, applySplineGeometry, PROFILES } from "../spline/splineGeometry.js";
import { getDefaultMaterial, getMaterialInstance, loadMaterialAsset, subscribeMaterial } from "../materialAsset.js";

/**
 * Geometry swept along a spline (roadmap item 16) — roads, paths, ramps,
 * fences, pipes, cables, tunnels, river beds.
 *
 * ## Why not just model it
 *
 * Because a road is the one piece of level geometry that changes every time the
 * level changes. Moving a building means moving a building; moving the road it
 * sits on means re-modelling a mesh whose length, curvature and UVs all have to
 * be redone by hand. Sweeping it from the path means the edit is dragging one
 * knot — which is exactly the argument for having splines in the editor at all.
 *
 * ## The rebuild is coalesced
 *
 * Dragging a knot fires a change per pointer event, and each one is a full
 * re-sweep of up to a few thousand rings. The rebuild is deferred to the next
 * frame (the same trick the decal projector uses), so a drag across a 200m road
 * re-cuts once per frame rather than once per mouse move.
 */
export class SplineMeshComponent extends Component {
  static type = "splineMesh";
  static label = "Spline Mesh";
  static tags = ["gameplay", "3d"];
  static defaults = {
    path: "",
    profile: "road",
    width: 4,
    height: 1,
    radius: 0.5,
    sides: 12,
    density: 2,
    uvScale: 0.25,
    capEnds: true,
    material: "",
    castShadow: false,
    receiveShadow: true,
  };
  static schema = [
    { key: "path", label: "Path", type: "entity" },
    { key: "profile", label: "Profile", type: "select", options: PROFILES },
    { key: "width", label: "Width", type: "number", min: 0.01, step: 0.1, showIf: (p) => p.profile === "road" || p.profile === "box" },
    { key: "height", label: "Height", type: "number", min: 0.01, step: 0.1, showIf: (p) => p.profile === "wall" || p.profile === "box" },
    { key: "radius", label: "Radius", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.profile === "tube" },
    { key: "sides", label: "Sides", type: "number", min: 3, max: 128, step: 1, showIf: (p) => p.profile === "tube" },
    { key: "density", label: "Rings / Unit", type: "number", min: 0.05, max: 20, step: 0.05 },
    { key: "uvScale", label: "UV Tiling", type: "number", min: 0.001, step: 0.05 },
    { key: "capEnds", label: "Cap Ends", type: "boolean", showIf: (p) => p.profile === "tube" || p.profile === "box" },
    { key: "material", label: "Material", type: "asset", exts: ["mat"], emptyLabel: "Default" },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, getDefaultMaterial());
    this.mesh.userData.entityId = this.entity.id;
    // Never batched: the sweep is a one-off buffer with no shared geometry to
    // merge against, and it is rebuilt whenever the path moves.
    this.mesh.userData.noBatch = true;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = this.props.receiveShadow !== false;
    this.mesh.visible = this.enabled;
    this.entity.object3D.add(this.mesh);

    // Any spline in the scene can be this one's path, so listening for a
    // specific entity's change would mean re-subscribing whenever `path` is
    // repointed. The event is coalesced into a next-frame rebuild anyway.
    this.unsubSpline = this.entity.engine?.on?.("spline-changed", () => this.invalidate());
    if (this.props.material) this.#loadMaterial(this.props.material);
    this.rebuild();
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubSpline?.();
    this.unsubSpline = null;
    this.unsubRebuild?.();
    this.unsubRebuild = null;
    this.materialUnsub?.();
    this.materialUnsub = null;
    if (this.mesh) {
      this.entity.object3D.remove(this.mesh);
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
  }

  onPropChanged(key) {
    if (!this.mesh) {
      super.onPropChanged(key);
      return;
    }
    if (key === "material") {
      if (this.props.material) this.#loadMaterial(this.props.material);
      else this.#applyMaterial();
      return;
    }
    if (key === "castShadow") {
      this.mesh.castShadow = !!this.props.castShadow;
      return;
    }
    if (key === "receiveShadow") {
      this.mesh.receiveShadow = this.props.receiveShadow !== false;
      return;
    }
    this.invalidate();
  }

  /** Queues a rebuild for the next frame. Safe to call per pointer event. */
  invalidate() {
    if (this.unsubRebuild || !this.entity?.engine) return;
    this.unsubRebuild = this.entity.engine.onPreRender(() => {
      this.unsubRebuild?.();
      this.unsubRebuild = null;
      this.rebuild();
    });
  }

  get triangleCount() {
    return (this.geometry?.getIndex()?.count ?? 0) / 3;
  }

  rebuild() {
    if (!this.geometry) return;
    const path = resolveSpline(this.entity, this.props.path);
    if (!path?.spline?.valid) {
      this.geometry.setIndex(null);
      this.geometry.deleteAttribute("position");
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    // The path may live on another entity (one road spline feeding a kerb, a
    // pavement and a barrier). Sweep in the path's space, then bring the result
    // into this mesh's space — the alternative, parenting the mesh to the path,
    // would make the two entities' transforms silently interdependent.
    let matrix = null;
    if (path.entity !== this.entity) {
      path.entity.object3D.updateWorldMatrix(true, false);
      this.entity.object3D.updateWorldMatrix(true, false);
      matrix = _matrix.copy(this.entity.object3D.matrixWorld).invert().multiply(path.entity.object3D.matrixWorld);
    }
    const data = buildSplineGeometry(path.spline, {
      profile: this.props.profile,
      width: this.props.width,
      height: this.props.height,
      radius: this.props.radius,
      sides: this.props.sides,
      density: this.props.density,
      uvScale: this.props.uvScale,
      capEnds: this.props.capEnds,
      matrix,
    });
    applySplineGeometry(this.geometry, data);
    if (this.mesh) this.mesh.visible = this.enabled;
  }

  async #loadMaterial(path) {
    const generation = this.generation;
    await loadMaterialAsset(path);
    if (generation !== this.generation || !this.mesh) return;
    this.materialUnsub?.();
    this.materialUnsub = subscribeMaterial(path, () => this.#applyMaterial());
    this.#applyMaterial();
  }

  #applyMaterial() {
    if (!this.mesh) return;
    this.mesh.material = getMaterialInstance(this.props.material) ?? getDefaultMaterial();
  }
}

const _matrix = new THREE.Matrix4();
