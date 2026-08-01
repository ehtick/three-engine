import * as THREE from "three/webgpu";
import { Component } from "./Component.js";

/**
 * An authored camera shake, attached to the thing that causes it.
 *
 * The shake an explosion produces belongs to the explosion prefab, not to a
 * `switch` inside the camera script — otherwise every new hazard means editing
 * the camera, and a designer can't tune the rumble without a programmer. Drop
 * this on the prefab, set the numbers, and fire it:
 *
 *     this.entity.getComponent("impulsesource").fire();
 *     this.entity.getComponent("impulsesource").fire({ magnitude: 0.8 });
 *
 * `fireOnStart` covers the most common case of all — a prefab that is spawned
 * *because* something happened, and should shake the moment it exists.
 */
export class ImpulseSourceComponent extends Component {
  static type = "impulsesource";
  static label = "Impulse Source";
  static tags = ["camera", "play-mode"];
  static defaults = {
    magnitude: 0.25,
    duration: 0.4,
    frequency: 18,
    radius: 15,
    rotation: 0.35,
    attack: 0,
    directional: false,
    direction: [0, 0, -1],
    fireOnStart: false,
  };
  static schema = [
    { key: "magnitude", label: "Magnitude", type: "number", min: 0, step: 0.05 },
    { key: "duration", label: "Duration", type: "number", min: 0.01, step: 0.05 },
    { key: "frequency", label: "Frequency", type: "number", min: 0.1, step: 1 },
    {
      key: "radius",
      label: "Radius",
      type: "number",
      min: 0,
      step: 1,
    },
    { key: "rotation", label: "Rotation", type: "number", min: 0, step: 0.05 },
    { key: "attack", label: "Attack", type: "number", min: 0, max: 0.9, step: 0.05 },
    { key: "directional", label: "Directional", type: "boolean" },
    { key: "direction", label: "Direction", type: "vec3", showIf: (p) => p.directional },
    { key: "fireOnStart", label: "Fire On Start", type: "boolean" },
  ];

  onAttach() {
    if (!this.props.fireOnStart) return;
    // Only while playing: an editor scene full of explosion prefabs would
    // otherwise rattle the viewport every time it reloaded.
    if (this.entity.engine.playing) this.fire();
  }

  /**
   * Emits the shake. `overrides` patches any authored field for this one shot —
   * a bigger blast from the same prefab, without a second prefab.
   */
  fire(overrides = {}) {
    const engine = this.entity.engine;
    if (!engine?.cameraImpulse) return null;
    const props = { ...this.props, ...overrides };
    this.entity.object3D.updateMatrixWorld(true);
    const position = this.entity.object3D.getWorldPosition(_position).toArray();
    // Direction is authored in the entity's own space so a prefab rotated to
    // face a wall kicks the camera away from that wall, not along world -Z.
    let direction = null;
    if (props.directional) {
      direction = _direction
        .fromArray(props.direction ?? [0, 0, -1])
        .applyQuaternion(this.entity.object3D.getWorldQuaternion(_quaternion))
        .toArray();
    }
    return engine.cameraImpulse.emit({
      position,
      direction,
      magnitude: props.magnitude,
      duration: props.duration,
      frequency: props.frequency,
      radius: props.radius,
      rotation: props.rotation,
      attack: props.attack,
    });
  }
}

const _position = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
