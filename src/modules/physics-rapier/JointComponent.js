import { Component } from "../../engine/components/Component.js";

/**
 * A physical constraint between this entity's Rigidbody and another one —
 * doors, hatches, ropes, swings, suspension, ragdoll limbs.
 *
 * Leaving Connected Body empty pins the body to the WORLD at its current pose,
 * which is how a swinging sign or a hinged door on static level geometry is
 * built. That is the common case, so it is the default.
 *
 * Anchors are in each body's LOCAL space and are what actually places the
 * pivot: a door hinged on its left edge has `anchor = [-halfWidth, 0, 0]`.
 *
 * Hinge limits and motor speed are in DEGREES (and degrees/second) — a door
 * that swings "±45" reads wrong in radians. A slider's are in metres. The
 * conversion happens in PhysicsSystem when the joint is built.
 *
 * The joint itself lives in the Rapier world, so like Rigidbody it only exists
 * while playing; `this.joint` is null in the editor.
 */
export class JointComponent extends Component {
  static type = "joint";
  static label = "Joint";
  static tags = ["physics", "play-mode", "3d"];
  static defaults = {
    kind: "hinge",
    connectedEntity: "", // empty = anchored to the world
    anchor: [0, 0, 0],
    connectedAnchor: [0, 0, 0],
    axis: [0, 1, 0],
    enableCollision: false,
    limitsEnabled: false,
    limitMin: -45,
    limitMax: 45,
    motorEnabled: false,
    motorSpeed: 0,
    motorMaxForce: 10,
    restLength: 1,
    stiffness: 50,
    damping: 5,
  };
  static schema = [
    {
      key: "kind",
      label: "Type",
      type: "select",
      options: ["fixed", "hinge", "ball", "slider", "spring", "rope"],
    },
    { key: "connectedEntity", label: "Connected Body", type: "entity" },
    { key: "anchor", label: "Anchor", type: "vec3" },
    { key: "connectedAnchor", label: "Connected Anchor", type: "vec3" },
    {
      key: "axis",
      label: "Axis",
      type: "vec3",
      showIf: (p) => p.kind === "hinge" || p.kind === "slider",
    },
    { key: "restLength", label: "Rest Length", type: "number", min: 0, step: 0.1, showIf: (p) => p.kind === "spring" || p.kind === "rope" },
    { key: "stiffness", label: "Stiffness", type: "number", min: 0, step: 1, showIf: (p) => p.kind === "spring" },
    { key: "damping", label: "Damping", type: "number", min: 0, step: 0.5, showIf: (p) => p.kind === "spring" },
    { key: "limitsEnabled", label: "Limits", type: "boolean", showIf: (p) => p.kind === "hinge" || p.kind === "slider" },
    { key: "limitMin", label: "Limit Min", type: "number", step: 1, showIf: (p) => p.limitsEnabled && (p.kind === "hinge" || p.kind === "slider") },
    { key: "limitMax", label: "Limit Max", type: "number", step: 1, showIf: (p) => p.limitsEnabled && (p.kind === "hinge" || p.kind === "slider") },
    { key: "motorEnabled", label: "Motor", type: "boolean", showIf: (p) => p.kind === "hinge" || p.kind === "slider" },
    { key: "motorSpeed", label: "Motor Speed", type: "number", step: 0.1, showIf: (p) => p.motorEnabled && (p.kind === "hinge" || p.kind === "slider") },
    { key: "motorMaxForce", label: "Motor Force", type: "number", min: 0, step: 1, showIf: (p) => p.motorEnabled && (p.kind === "hinge" || p.kind === "slider") },
    { key: "enableCollision", label: "Bodies Collide", type: "boolean" },
  ];

  onAttach() {
    this.joint = null; // assigned by PhysicsSystem while playing
    // A spawned ragdoll or rope arrives complete: its joints are built in the
    // same flush as its bodies, which is the only order that can work.
    this.entity.engine?.physics?.markDirty(this.entity, { subtree: false });
  }

  onDetach() {
    this.entity.engine?.physics?.removeJoints(this.entity);
    this.joint = null;
  }

  // ---- Script-facing API --------------------------------------------------

  /**
   * Drives the joint like a motor — an automatic door, a winch, a powered
   * wheel. Hinge and slider only.
   *
   *     this.entity.getComponent("joint").setMotorVelocity(2, 20);
   */
  setMotorVelocity(speed, maxForce = this.props.motorMaxForce) {
    this.joint?.configureMotorVelocity?.(speed, maxForce);
  }

  /** Drives the joint toward an angle (hinge) or offset (slider). */
  setMotorTarget(target, stiffness = this.props.stiffness, damping = this.props.damping) {
    this.joint?.configureMotorPosition?.(target, stiffness, damping);
  }

  setLimits(min, max) {
    this.joint?.setLimits?.(min, max);
  }
}
