import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { physicsLayerNames } from "./layerConfig.js";

const GIZMO_COLOR = 0x2d8bf0;

/**
 * Kinematic character controller — a self-contained way to move a player/NPC
 * that walks, climbs slopes/steps, and slides along walls without tunnelling,
 * driven by Rapier's `KinematicCharacterController`.
 *
 * Unlike a Rigidbody+Collider pair, this owns its own kinematic body and
 * capsule (built by the PhysicsSystem on Play), so it does NOT need a separate
 * Rigidbody or Collider component. Add it alone and drive it from a script.
 *
 * Movement is velocity-based (units/second) so it's framerate-independent — the
 * PhysicsSystem integrates it on the fixed timestep. Gravity is applied
 * internally when `applyGravity` is on; the script only supplies horizontal
 * intent and jumps.
 *
 * Script API (all world-space):
 *   cc.move([x, y, z])      // desired horizontal velocity (y ignored — gravity/jump own it)
 *   cc.jump(speed)          // launch upward at `speed` if grounded
 *   cc.isGrounded()         // touching the floor after the last step?
 *   cc.getVelocity()        // current [x, y, z] velocity
 *   cc.setVelocity([x,y,z]) // override the full velocity (advanced)
 *   cc.teleport([x, y, z])  // instant reposition, clears vertical velocity
 */
export class CharacterControllerComponent extends Component {
  static type = "charactercontroller";
  static label = "Character Controller";
  static tags = ["physics", "play-mode", "3d", "controller"];
  static defaults = {
    radius: 0.3,
    height: 1.0,
    offset: [0, 0, 0],
    slopeClimbAngle: 45,
    slopeSlideAngle: 30,
    autostep: true,
    autostepHeight: 0.3,
    autostepMinWidth: 0.2,
    snapToGround: true,
    snapDistance: 0.3,
    applyGravity: true,
    gravityScale: 1,
    pushDynamicBodies: false,
    skinWidth: 0.02,
    layer: "Player",
  };
  static schema = [
    { key: "layer", label: "Layer", type: "select", options: physicsLayerNames },
    { key: "radius", label: "Radius", type: "number", min: 0.01, step: 0.05 },
    { key: "height", label: "Height", type: "number", min: 0.01, step: 0.05 },
    { key: "offset", label: "Offset", type: "vec3" },
    { key: "slopeClimbAngle", label: "Max Slope °", type: "number", min: 0, max: 89, step: 1 },
    { key: "slopeSlideAngle", label: "Min Slide °", type: "number", min: 0, max: 89, step: 1 },
    { key: "autostep", label: "Auto-step", type: "boolean" },
    { key: "autostepHeight", label: "Step Height", type: "number", min: 0, step: 0.05, showIf: (p) => p.autostep },
    { key: "autostepMinWidth", label: "Step Min Width", type: "number", min: 0, step: 0.05, showIf: (p) => p.autostep },
    { key: "snapToGround", label: "Snap To Ground", type: "boolean" },
    { key: "snapDistance", label: "Snap Distance", type: "number", min: 0, step: 0.05, showIf: (p) => p.snapToGround },
    { key: "applyGravity", label: "Apply Gravity", type: "boolean" },
    { key: "gravityScale", label: "Gravity Scale", type: "number", step: 0.1, showIf: (p) => p.applyGravity },
    { key: "pushDynamicBodies", label: "Push Bodies", type: "boolean" },
    { key: "skinWidth", label: "Skin Width", type: "number", min: 0.001, step: 0.005 },
  ];

  onAttach() {
    // Assigned by PhysicsSystem while playing; runtime methods no-op otherwise.
    this.body = null;
    this.collider = null;
    this.controller = null;
    this.velocity = [0, 0, 0]; // units/second (world space)
    this.grounded = false;
    // A character spawned mid-play (a respawn, a second player joining) needs
    // its body built now — the world is long since built. See PhysicsSystem.
    this.entity.engine?.physics?.markDirty(this.entity, { subtree: false });
    this.#buildGizmo();
  }

  onDetach() {
    this.entity.engine.physics?.unregisterCharacter?.(this);
    this.body = null;
    this.collider = null;
    this.controller = null;
    this.#disposeGizmo();
  }

  onPropChanged() {
    // Shape/controller params are structural — they apply on the next world
    // build (Stop → Play). Rebuild the editor gizmo so it reflects edits now.
    this.#disposeGizmo();
    this.#buildGizmo();
  }

  // ---- Script-facing API ----

  /** Desired horizontal velocity (units/s). `y` is ignored — gravity/jump own
   *  vertical motion; use setVelocity for full control. */
  move([x, , z]) {
    this.velocity[0] = x ?? 0;
    this.velocity[2] = z ?? 0;
  }

  /** Launch upward at `speed` (units/s) — only takes effect when grounded. */
  jump(speed) {
    if (this.grounded) this.velocity[1] = speed;
  }

  setVelocity([x, y, z]) {
    this.velocity[0] = x;
    this.velocity[1] = y;
    this.velocity[2] = z;
  }

  getVelocity() {
    return [this.velocity[0], this.velocity[1], this.velocity[2]];
  }

  isGrounded() {
    return this.grounded;
  }

  /**
   * The moving platform the character is standing on, or null. The controller
   * already carries the character along with it — this is for gameplay that
   * needs to know (parenting an effect, "you are on the lift" triggers).
   */
  getPlatform() {
    return this.platformEntity ?? null;
  }

  /** Instantly repositions the character (world space) and clears fall speed. */
  teleport([x, y, z]) {
    this.velocity[1] = 0;
    this.entity.object3D.position.set(x, y, z);
    // setTranslation moves a kinematic body *now*; setNextKinematicTranslation
    // would just be a step target that the per-step resolve overwrites.
    if (this.body) this.body.setTranslation({ x, y, z }, true);
  }

  // ---- editor gizmo (capsule outline on the editor-only layer) ----

  #buildGizmo() {
    const { radius, height, offset } = this.props;
    this.gizmo = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.CapsuleGeometry(radius, height, 4, 8)),
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.gizmo.position.fromArray(offset);
    // Respect scene depth so the capsule outline hides behind walls instead
    // of drawing on top of every solid object in the scene — `depthTest: true`
    // (default) makes the wireframe a normal depth-tested overlay.
    this.gizmo.renderOrder = 1;
    this.gizmo.layers.set(EDITOR_LAYER);
    this.gizmo.userData.engineOwned = true;
    this.gizmo.raycast = () => {}; // never intercept viewport picking
    this.entity.object3D.add(this.gizmo);
  }

  #disposeGizmo() {
    if (!this.gizmo) return;
    this.entity.object3D.remove(this.gizmo);
    this.gizmo.geometry.dispose();
    this.gizmo.material.dispose();
    this.gizmo = null;
  }
}
