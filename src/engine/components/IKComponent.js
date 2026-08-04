// @ts-check
import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { alignTipRotation, solveTwoBoneIK } from "../anim/ik.js";

/**
 * Two-bone IK on a sibling Model's skeleton: pick the tip bone (foot, hand) and
 * the chain is the two bones above it. One component per limb.
 *
 * Runs in the engine's late stage at order 0 — after the animator has posed the
 * skeleton for this frame, before bone-attachment entities read the result.
 * That ordering is the whole point: IK is a *correction* to an animated pose,
 * so it must see the pose, and anything parented to the corrected bone must see
 * the correction.
 *
 * Ground probe mode is the foot-planting case. Instead of authoring a target
 * entity you let the component raycast down from where the animation put the
 * foot and pin it to whatever it finds — which is what stops a walk cycle
 * authored on a flat floor from sinking into a ramp. It needs a physics world,
 * so it only does anything while playing.
 */
export class IKComponent extends Component {
  static type = "ik";
  static label = "IK (Two Bone)";
  static tags = ["animation"];
  static defaults = {
    tipBone: "",
    target: "",
    pole: "",
    weight: 1,
    matchTipRotation: false,
    groundProbe: false,
    probeUp: 0.5,
    probeDown: 1,
    footOffset: 0,
    probeLayers: "",
    softness: 0.03,
  };
  static schema = [
    // Rendered by the inspector's IK section as a dropdown of the rig's bones;
    // the schema entry is what makes it serialize and undo like any other prop.
    { key: "tipBone", label: "Tip Bone", type: "text" },
    { key: "target", label: "Target", type: "entity", showIf: (p) => !p.groundProbe },
    { key: "pole", label: "Pole", type: "entity" },
    { key: "weight", label: "Weight", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "matchTipRotation", label: "Match Tip Rotation", type: "boolean" },
    { key: "softness", label: "Softness", type: "number", min: 0, max: 0.5, step: 0.01 },
    { key: "groundProbe", label: "Ground Probe", type: "boolean" },
    { key: "probeUp", label: "Probe Up", type: "number", min: 0, step: 0.05, showIf: (p) => !!p.groundProbe },
    { key: "probeDown", label: "Probe Down", type: "number", min: 0, step: 0.05, showIf: (p) => !!p.groundProbe },
    { key: "footOffset", label: "Foot Offset", type: "number", step: 0.005, showIf: (p) => !!p.groundProbe },
    { key: "probeLayers", label: "Probe Layers", type: "text", showIf: (p) => !!p.groundProbe },
  ];

  onAttach() {
    this._chain = null;
    this._warned = false;
    this.unsubLate = this.entity.engine.onLateUpdate(() => this.#solve(), 0);
    // The chain can't be resolved until the GLB is in memory.
    this.unsubModel = this.entity.engine.on("model-loaded", (entity) => {
      if (entity === this.entity) this._chain = null;
    });
  }

  onDetach() {
    this.unsubLate?.();
    this.unsubModel?.();
    this._chain = null;
  }

  onPropChanged() {
    this._chain = null;
    this._warned = false;
  }

  /** The loaded model root, for the editor's bone picker. */
  getModelRoot() {
    return this.entity.getComponent("model")?.root ?? null;
  }

  /**
   * Resolves tip → mid → root by walking two parents up from the named bone.
   * Cached until the model reloads or a prop changes; re-resolving per frame
   * would mean a `getObjectByName` traversal of the whole skeleton every frame,
   * per limb.
   */
  #resolveChain() {
    if (this._chain) return this._chain;
    const root = this.entity.getComponent("model")?.root;
    if (!root || !this.props.tipBone) return null;
    const tip = root.getObjectByName(this.props.tipBone);
    const mid = tip?.parent;
    const upper = mid?.parent;
    if (!tip || !mid?.isBone || !upper?.isBone) {
      if (!this._warned) {
        this._warned = true;
        console.warn(
          `IK on "${this.entity.name}": ` +
            (tip
              ? `bone "${this.props.tipBone}" doesn't have two bones above it — pick the END of the chain (a foot, not a thigh).`
              : `no bone named "${this.props.tipBone}" on this model.`),
        );
      }
      return null;
    }
    this._chain = { upper, mid, tip };
    return this._chain;
  }

  #solve() {
    if (!this.enabled) return;
    if (!this.isInView()) return;
    const weight = THREE.MathUtils.clamp(this.props.weight ?? 1, 0, 1);
    if (weight <= 0) return;
    const chain = this.#resolveChain();
    if (!chain) return;

    const engine = this.entity.engine;
    let targetPos = null;
    let targetQuat = null;

    if (this.props.groundProbe) {
      const hit = this.#probeGround(chain.tip);
      if (!hit) return; // nothing under the foot — leave the animated pose alone
      targetPos = hit.position;
      targetQuat = hit.quaternion;
    } else {
      const targetEntity = this.props.target ? engine.getEntity(this.props.target) : null;
      if (!targetEntity) return;
      targetEntity.object3D.updateMatrixWorld(true);
      targetPos = targetEntity.object3D.getWorldPosition(_targetPos);
      if (this.props.matchTipRotation) {
        targetQuat = targetEntity.object3D.getWorldQuaternion(_targetQuat);
      }
    }

    let polePos = null;
    const poleEntity = this.props.pole ? engine.getEntity(this.props.pole) : null;
    if (poleEntity) {
      poleEntity.object3D.updateMatrixWorld(true);
      polePos = poleEntity.object3D.getWorldPosition(_polePos);
    }

    solveTwoBoneIK(chain.upper, chain.mid, chain.tip, targetPos, polePos, weight, {
      softness: this.props.softness,
    });
    if (targetQuat && this.props.matchTipRotation) alignTipRotation(chain.tip, targetQuat, weight);
  }

  /**
   * Casts down from just above the animated foot position and returns where the
   * foot should actually sit, plus the rotation that lays it flat on the
   * surface.
   *
   * The ray starts ABOVE the foot on purpose: starting at the foot itself
   * misses the ground entirely on any frame where the animation has already
   * pushed the foot below the surface, which is the exact frame that needs
   * correcting.
   */
  #probeGround(tip) {
    const physics = this.entity.engine.physics;
    if (!physics?.raycast) return null;
    tip.updateMatrixWorld(true);
    tip.getWorldPosition(_tipPos);
    const up = this.props.probeUp ?? 0.5;
    const down = this.props.probeDown ?? 1;
    const origin = [_tipPos.x, _tipPos.y + up, _tipPos.z];
    const layers = String(this.props.probeLayers ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = physics.raycast(origin, [0, -1, 0], up + down, {
      exclude: this.entity,
      ...(layers.length ? { layers } : {}),
    });
    if (!hit) return null;
    _targetPos.set(hit.point[0], hit.point[1] + (this.props.footOffset ?? 0), hit.point[2]);
    let quaternion = null;
    if (this.props.matchTipRotation) {
      _normal.set(hit.normal[0], hit.normal[1], hit.normal[2]);
      if (_normal.lengthSq() > 1e-8) {
        // Keep the foot's animated heading and only re-pitch it onto the
        // surface: a full look-at would spin the foot to face the slope's
        // downhill direction.
        tip.getWorldQuaternion(_targetQuat);
        _up.set(0, 1, 0).applyQuaternion(_targetQuat);
        quaternion = _targetQuat.premultiply(_swing.setFromUnitVectors(_up, _normal.normalize()));
      }
    }
    return { position: _targetPos, quaternion };
  }
}

const _targetPos = new THREE.Vector3();
const _polePos = new THREE.Vector3();
const _tipPos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
