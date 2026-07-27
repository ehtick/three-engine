import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { evaluateGeometryModifiers } from "../geometryModifiers.js";
import { disposeOrReleaseGeometry } from "../geometryAsset.js";

const matrixSignature = (matrix) => matrix.elements.map((value) => Math.round(value * 1e5)).join(",");

/**
 * Non-destructive mesh modifier stack. The source geometry is kept separate
 * from the evaluated render geometry so Edit Mode always edits the cage.
 */
export class GeometryModifiersComponent extends Component {
  static type = "geometryModifiers";
  static label = "Geometry Modifiers";
  static tags = ["geometry", "modeling", "modifier"];
  static requiredComponents = ["mesh"];
  static defaults = {
    booleanOperation: "none",
    booleanTarget: "",
    arrayCount: 1,
    arrayOffset: [1, 0, 0],
    subdivisionLevels: 0,
  };
  static schema = [
    { key: "booleanOperation", label: "Boolean", type: "select", options: ["none", "union", "subtract", "intersect"] },
    { key: "booleanTarget", label: "Boolean Target", type: "text", showIf: (props) => props.booleanOperation !== "none" },
    { key: "arrayCount", label: "Array Count", type: "number", min: 1, max: 256, step: 1 },
    { key: "arrayOffset", label: "Array Offset", type: "vec3", showIf: (props) => props.arrayCount > 1 },
    { key: "subdivisionLevels", label: "Subdivision Surface", type: "number", min: 0, max: 4, step: 1 },
  ];

  onAttach() {
    this.meshComponent = this.entity.getComponent("mesh");
    const live = this.meshComponent?.mesh?.geometry;
    if (live) this.sourceGeometry = live.clone();
    this._componentUnsub = this.entity.engine?.on?.("component-changed", (event) => {
      if (event?.entityId === this.entity.id && event.componentType === "mesh" && ["geometry", "geometryAsset"].includes(event.key)) {
        this.#captureLoadedSource();
      } else if (event?.entityId === this.props.booleanTarget && event.componentType === "mesh") {
        this.apply();
      }
    });
    this._tickUnsub = this.entity.engine?.onUpdate?.(() => this.#watchInputs());
    this.apply();
  }

  onDetach() {
    this._componentUnsub?.();
    this._tickUnsub?.();
    this._componentUnsub = null;
    this._tickUnsub = null;
    const mesh = this.meshComponent?.mesh;
    if (mesh && this.sourceGeometry) {
      // May still be the shared `.geom` instance other meshes render.
      disposeOrReleaseGeometry(mesh.geometry);
      mesh.geometry = this.sourceGeometry.clone();
    }
    this.sourceGeometry?.dispose?.();
    this.sourceGeometry = null;
  }

  onDisable() {
    const mesh = this.meshComponent?.mesh;
    if (!mesh || !this.sourceGeometry) return;
    disposeOrReleaseGeometry(mesh.geometry);
    mesh.geometry = this.sourceGeometry.clone();
  }

  onEnable() {
    this.apply();
  }

  onPropChanged() {
    this.apply();
  }

  getSourceGeometry() {
    return this.sourceGeometry ?? this.meshComponent?.mesh?.geometry ?? null;
  }

  /** Takes ownership of `geometry`, then re-evaluates the visible result. */
  setSourceGeometry(geometry) {
    if (!geometry) return;
    this.sourceGeometry?.dispose?.();
    this.sourceGeometry = geometry;
    this.apply();
  }

  #captureLoadedSource() {
    const live = this.entity.getComponent("mesh")?.mesh?.geometry;
    if (!live) return;
    this.sourceGeometry?.dispose?.();
    this.sourceGeometry = live.clone();
    this.apply();
  }

  #booleanContext() {
    const target = this.props.booleanTarget ? this.entity.engine?.getEntity(this.props.booleanTarget) : null;
    const targetMesh = target?.getComponent("mesh")?.mesh;
    const sourceMesh = this.meshComponent?.mesh;
    if (!targetMesh || !sourceMesh || target === this.entity) return {};
    sourceMesh.updateWorldMatrix(true, false);
    targetMesh.updateWorldMatrix(true, false);
    const booleanMatrix = sourceMesh.matrixWorld.clone().invert().multiply(targetMesh.matrixWorld);
    return { booleanGeometry: targetMesh.geometry, booleanMatrix };
  }

  #watchInputs() {
    const currentMesh = this.entity.getComponent("mesh");
    if (currentMesh !== this.meshComponent) {
      this.meshComponent = currentMesh;
      const live = currentMesh?.mesh?.geometry;
      if (live) {
        this.sourceGeometry?.dispose?.();
        this.sourceGeometry = live.clone();
        this.apply();
      }
    }
    if (this.props.booleanOperation === "none" || !this.props.booleanTarget) return;
    const { booleanMatrix } = this.#booleanContext();
    const signature = booleanMatrix ? matrixSignature(booleanMatrix) : "missing";
    if (signature === this._booleanSignature) {
      if (this._pendingSignature === signature && performance.now() - this._pendingSince > 120) {
        this._pendingSignature = null;
        this.apply();
      }
      return;
    }
    if (signature !== this._pendingSignature) {
      this._pendingSignature = signature;
      this._pendingSince = performance.now();
    }
  }

  apply() {
    const mesh = this.meshComponent?.mesh;
    if (!mesh || !this.sourceGeometry) return;
    if (!this.enabled) {
      this.onDisable();
      return;
    }
    try {
      const context = this.#booleanContext();
      const evaluated = evaluateGeometryModifiers(this.sourceGeometry, this.props, context);
      // May still be the shared `.geom` instance other meshes render.
      disposeOrReleaseGeometry(mesh.geometry);
      mesh.geometry = evaluated;
      this.lastError = "";
      this._booleanSignature = context.booleanMatrix ? matrixSignature(context.booleanMatrix) : "missing";
      this._pendingSignature = null;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      console.warn(`Geometry modifiers on "${this.entity.name}" failed: ${this.lastError}`);
      // May still be the shared `.geom` instance other meshes render.
      disposeOrReleaseGeometry(mesh.geometry);
      mesh.geometry = this.sourceGeometry.clone();
    }
  }
}

