import { Component } from "../../engine/components/Component.js";

/**
 * Physics body driven by the Rapier world while playing. The PhysicsSystem
 * assigns `this.body` (a RAPIER.RigidBody) when the world builds on Play and
 * clears it on Stop — all runtime methods no-op outside play mode.
 *
 * dynamic   — simulated; physics owns the transform.
 * kinematic — scripts/animations own the transform; pushes dynamic bodies.
 * fixed     — static level geometry.
 */
export class RigidbodyComponent extends Component {
  static type = "rigidbody";
  static label = "Rigidbody";
  static tags = ["physics", "play-mode", "3d"];
  static defaults = {
    bodyType: "dynamic",
    mass: 1,
    linearDamping: 0,
    angularDamping: 0.05,
    gravityScale: 1,
    ccd: false,
    lockRotationX: false,
    lockRotationY: false,
    lockRotationZ: false,
  };
  static schema = [
    { key: "bodyType", label: "Type", type: "select", options: ["dynamic", "kinematic", "fixed"] },
    { key: "mass", label: "Mass", type: "number", min: 0.001, step: 0.1, showIf: (p) => p.bodyType === "dynamic" },
    { key: "linearDamping", label: "Lin. Damping", type: "number", min: 0, step: 0.05, showIf: (p) => p.bodyType === "dynamic" },
    { key: "angularDamping", label: "Ang. Damping", type: "number", min: 0, step: 0.05, showIf: (p) => p.bodyType === "dynamic" },
    { key: "gravityScale", label: "Gravity Scale", type: "number", step: 0.1, showIf: (p) => p.bodyType === "dynamic" },
    { key: "ccd", label: "Continuous CD", type: "boolean", showIf: (p) => p.bodyType === "dynamic" },
    { key: "lockRotationX", label: "Lock Rot X", type: "boolean", showIf: (p) => p.bodyType === "dynamic" },
    { key: "lockRotationY", label: "Lock Rot Y", type: "boolean", showIf: (p) => p.bodyType === "dynamic" },
    { key: "lockRotationZ", label: "Lock Rot Z", type: "boolean", showIf: (p) => p.bodyType === "dynamic" },
  ];

  onAttach() {
    this.body = null; // assigned by PhysicsSystem while playing
    // While playing, the world is already built — say so, or an entity spawned
    // mid-game (every bullet, every enemy) keeps a null body forever. Whole
    // subtree: a rigidbody appearing above existing child colliders changes
    // which body those colliders belong to.
    this.entity.engine?.physics?.markDirty(this.entity);
  }

  onDetach() {
    this.body = null;
    const physics = this.entity.engine?.physics;
    // Immediate, not deferred: the entity is usually being destroyed, and a
    // dirty flush skips entities that are no longer in the scene — which would
    // leave this body simulating in a world nothing references.
    physics?.removeEntity(this.entity, { subtree: false });
    physics?.markDirty(this.entity);
  }

  onPropChanged(key, value) {
    // Live-tune simple body params mid-play; structural props (bodyType,
    // mass, locks) apply on the next world build.
    if (!this.body) return;
    if (key === "linearDamping") this.body.setLinearDamping(value);
    else if (key === "angularDamping") this.body.setAngularDamping(value);
    else if (key === "gravityScale") this.body.setGravityScale(value, true);
  }

  // ---- Script-facing API (world space, [x, y, z] arrays) ----

  applyImpulse([x, y, z]) {
    this.body?.applyImpulse({ x, y, z }, true);
  }

  applyForce([x, y, z]) {
    this.body?.addForce({ x, y, z }, true);
  }

  applyTorqueImpulse([x, y, z]) {
    this.body?.applyTorqueImpulse({ x, y, z }, true);
  }

  setLinearVelocity([x, y, z]) {
    this.body?.setLinvel({ x, y, z }, true);
  }

  getLinearVelocity() {
    const v = this.body?.linvel();
    return v ? [v.x, v.y, v.z] : [0, 0, 0];
  }

  setAngularVelocity([x, y, z]) {
    this.body?.setAngvel({ x, y, z }, true);
  }

  getAngularVelocity() {
    const v = this.body?.angvel();
    return v ? [v.x, v.y, v.z] : [0, 0, 0];
  }

  /** Teleports the body (world position, optional quaternion [x,y,z,w]). */
  teleport(position, quaternion) {
    if (!this.body) return;
    const [x, y, z] = position;
    this.body.setTranslation({ x, y, z }, true);
    if (quaternion) {
      const [qx, qy, qz, qw] = quaternion;
      this.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
    }
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}
