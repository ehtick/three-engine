import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import {
  evaluateGeometryModifier,
  evaluateGeometryModifiers,
  normalizeGeometryModifierStack,
} from "../geometryModifiers.js";
import { disposeOrReleaseGeometry } from "../geometryAsset.js";

const matrixSignature = (matrix) => matrix.elements.map((value) => Math.round(value * 1e5)).join(",");
const LEGACY_KEYS = [
  "mirrorAxis", "booleanOperation", "arrayCount", "solidifyThickness", "subdivisionLevels",
  "smoothIterations", "simpleDeformMethod", "castType", "displaceStrength", "waveHeight",
  "decimateRatio", "weldThreshold", "edgeSplitAngle", "weightedNormals",
];
const REFERENCE_KEYS = [
  "target", "auxiliaryTarget", "origin", "mirrorObject", "objectOffset", "startCap", "endCap", "fitCurve",
  "curve", "lattice", "cage", "fromTarget", "toTarget", "from", "to", "startObject",
];

/**
 * Ordered, non-destructive Blender-style modifier stack. The source geometry
 * stays separate from the evaluated render result so Edit Mode edits the cage.
 */
export class GeometryModifiersComponent extends Component {
  static type = "geometryModifiers";
  static label = "Geometry Modifiers";
  static tags = ["geometry", "modeling", "modifier"];
  static requiredComponents = ["mesh"];
  static defaults = { modifiers: [] };
  // The Inspector renders the ordered stack with its dedicated editor.
  static schema = [];

  onAttach() {
    this.#migrateLegacyProps();
    this.meshComponent = this.entity.getComponent("mesh");
    const live = this.meshComponent?.mesh?.geometry;
    if (live) this.sourceGeometry = live.clone();
    this._componentUnsub = this.entity.engine?.on?.("component-changed", (event) => {
      if (event?.entityId === this.entity.id && event.componentType === "mesh" && ["geometry", "geometryAsset"].includes(event.key)) {
        this.#captureLoadedSource();
      } else if (event?.componentType === "mesh" && this.#referencesEntity(event?.entityId)) {
        this.apply();
      }
    });
    this._tickUnsub = this.entity.engine?.onUpdate?.(() => this.#watchInputs());
    this.apply();
  }

  #migrateLegacyProps() {
    const hasLegacy = LEGACY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(this.props, key));
    if (!Array.isArray(this.props.modifiers) || (this.props.modifiers.length === 0 && hasLegacy)) {
      const legacy = { ...this.props };
      delete legacy.modifiers;
      this.props.modifiers = normalizeGeometryModifierStack(legacy);
    } else {
      this.props.modifiers = normalizeGeometryModifierStack(this.props);
    }
    // Do not keep serializing the superseded fixed-stack controls.
    for (const key of Object.keys(this.props)) {
      if (LEGACY_KEYS.some((prefix) => key === prefix || key.startsWith(prefix.replace(/(Axis|Operation|Count|Thickness|Levels|Iterations|Method|Type|Strength|Height|Ratio|Threshold|Angle|Normals)$/, "")))) {
        if (key !== "enabled" && key !== "viewOnly" && key !== "modifiers") delete this.props[key];
      }
    }
  }

  onDetach() {
    this._componentUnsub?.();
    this._tickUnsub?.();
    this._componentUnsub = null;
    this._tickUnsub = null;
    const mesh = this.meshComponent?.mesh;
    if (mesh && this.sourceGeometry) {
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

  onEnable() { this.apply(); }
  onPropChanged() { this.apply(); }

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

  /**
   * Evaluates the visible stack through `modifier` for Apply. Modifiers before
   * the selected entry are part of its input, so they must be baked with it;
   * evaluating the selected entry against the authored cage would not match
   * the viewport whenever the stack is order-dependent.
   */
  evaluateThroughModifier(modifier, source = this.sourceGeometry) {
    if (!source || !modifier) return null;
    const index = (this.props.modifiers ?? []).findIndex((entry) => entry.id === modifier.id);
    if (index < 0) return null;
    return evaluateGeometryModifiers(
      source,
      { modifiers: this.props.modifiers.slice(0, index + 1) },
      this.#stackContext(),
    );
  }

  // Kept for editor integrations written against the first stack version.
  evaluateModifier(modifier) { return this.evaluateThroughModifier(modifier); }

  /**
   * Evaluates the complete visible stack against an arbitrary source cage.
   * Edit Mode uses this for its live modifier preview: its in-memory BMesh is
   * newer than `sourceGeometry` until autosave/reload catches up, so previewing
   * the component's cached result would always be one edit behind.
   */
  evaluateGeometry(source) {
    if (!source) return null;
    if (!this.enabled) return source.clone();
    return evaluateGeometryModifiers(source, this.props, this.#stackContext());
  }

  #captureLoadedSource() {
    const live = this.entity.getComponent("mesh")?.mesh?.geometry;
    if (!live) return;
    this.sourceGeometry?.dispose?.();
    this.sourceGeometry = live.clone();
    this.apply();
  }

  #referencesEntity(entityId) {
    return !!entityId && (this.props.modifiers ?? []).some((modifier) =>
      REFERENCE_KEYS.some((key) => modifier[key] === entityId));
  }

  #modifierContext(modifier) {
    const sourceMesh = this.meshComponent?.mesh;
    sourceMesh?.updateWorldMatrix?.(true, false);
    const sourceMatrix = sourceMesh?.matrixWorld?.clone?.() ?? new THREE.Matrix4();
    const inverseSource = sourceMatrix.clone().invert();
    const references = {};
    for (const key of REFERENCE_KEYS) {
      const entityId = modifier?.[key];
      if (!entityId || entityId === this.entity.id) continue;
      const entity = this.entity.engine?.getEntity(entityId);
      if (!entity) continue;
      const targetMesh = entity.getComponent?.("mesh")?.mesh;
      const object = targetMesh ?? entity.object3D;
      object?.updateWorldMatrix?.(true, false);
      const worldMatrix = object?.matrixWorld?.clone?.() ?? new THREE.Matrix4();
      const matrix = inverseSource.clone().multiply(worldMatrix);
      references[key] = {
        entity,
        geometry: targetMesh?.geometry ?? null,
        worldMatrix,
        matrix,
        point: new THREE.Vector3().setFromMatrixPosition(matrix),
      };
    }
    const target = references.target;
    sourceMesh?.skeleton?.update?.();
    const boneMatrices = sourceMesh?.skeleton?.boneMatrices
      ? Array.from({ length: sourceMesh.skeleton.bones.length }, (_, index) =>
        new THREE.Matrix4().fromArray(sourceMesh.skeleton.boneMatrices, index * 16))
      : null;
    return {
      sourceMatrix,
      boneMatrices,
      references,
      targetGeometry: target?.geometry,
      targetMatrix: target?.matrix,
      targetPoint: target?.point,
      fromMatrix: references.from?.matrix ?? references.fromTarget?.matrix,
      toMatrix: references.to?.matrix ?? references.toTarget?.matrix,
      // Backwards-compatible names used by the original Boolean evaluator.
      booleanGeometry: target?.geometry,
      booleanMatrix: target?.matrix,
    };
  }

  #stackContext() {
    const modifierContexts = new Map();
    for (const modifier of this.props.modifiers ?? []) {
      modifierContexts.set(modifier.id, this.#modifierContext(modifier));
    }
    const sourceMesh = this.meshComponent?.mesh;
    sourceMesh?.updateWorldMatrix?.(true, false);
    return { modifierContexts, sourceMatrix: sourceMesh?.matrixWorld?.clone?.() ?? new THREE.Matrix4() };
  }

  #inputSignature() {
    return (this.props.modifiers ?? [])
      .filter((modifier) => modifier.enabled !== false)
      .map((modifier) => {
        const context = this.#modifierContext(modifier);
        const refs = Object.entries(context.references ?? {}).map(([key, value]) =>
          `${key}:${modifier[key]}:${matrixSignature(value.matrix)}:${value.geometry?.uuid ?? "transform"}`);
        return `${modifier.id}:${refs.join(";")}`;
      })
      .join("|");
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
    const signature = this.#inputSignature();
    if (signature === this._inputSignature) {
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
      const evaluated = evaluateGeometryModifiers(this.sourceGeometry, this.props, this.#stackContext());
      disposeOrReleaseGeometry(mesh.geometry);
      mesh.geometry = evaluated;
      this.lastError = "";
      this._inputSignature = this.#inputSignature();
      this._pendingSignature = null;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      console.warn(`Geometry modifiers on "${this.entity.name}" failed: ${this.lastError}`);
      disposeOrReleaseGeometry(mesh.geometry);
      mesh.geometry = this.sourceGeometry.clone();
    }
  }
}
