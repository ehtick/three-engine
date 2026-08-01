import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { DEBUG_LAYER } from "../../engine/editorLayers.js";

/**
 * An off-mesh link: a connection between two points on the navmesh that isn't
 * walkable ground — a ladder, a jump across a gap, a drop from a ledge, a
 * teleporter.
 *
 * Without these, a navmesh describes only what an agent can walk on, so a gap
 * of any width is an impassable wall and an agent will happily path around the
 * entire level rather than step across a half-metre ditch. The link tells
 * recast the two ends are connected; how the agent *traverses* it (a jump
 * animation, a ladder climb) is gameplay, and a script drives that by watching
 * for the agent entering the link.
 *
 * Links are baked INTO the navmesh, so adding or moving one needs a re-bake.
 */
export class NavLinkComponent extends Component {
  static type = "navlink";
  static label = "Nav Link";
  static tags = ["navigation"];
  static defaults = {
    end: [0, 0, 4],
    endEntity: "",
    radius: 0.5,
    bidirectional: true,
    showGizmo: true,
  };
  static schema = [
    { key: "endEntity", label: "End Entity", type: "entity" },
    { key: "end", label: "End Offset", type: "vec3", showIf: (p) => !p.endEntity },
    { key: "radius", label: "Radius", type: "number", min: 0.05, step: 0.05 },
    { key: "bidirectional", label: "Both Ways", type: "boolean" },
    { key: "showGizmo", label: "Show Gizmo", type: "boolean" },
  ];

  onAttach() {
    this.gizmo = null;
    this.#register();
    // The module's wasm loads asynchronously, so a scene deserialized during
    // that window attaches its links before `engine.navigation` exists. Without
    // re-registering, those links are silently missing from every later bake —
    // and a missing off-mesh link looks exactly like a pathfinding bug.
    this._unsubReady = this.entity.engine.on("navmesh-changed", () => this.#register());
    this.#refreshGizmo();
  }

  onDetach() {
    this.entity.engine.navigation?.links.delete(this);
    this._unsubReady?.();
    this.#clearGizmo();
  }

  #register() {
    this.entity.engine.navigation?.links.add(this);
  }

  onPropChanged() {
    this.#refreshGizmo();
  }

  onDisable() {
    this.#clearGizmo();
  }

  onEnable() {
    this.#refreshGizmo();
  }

  /** World-space start (this entity) and end (an entity, or a local offset). */
  endpoints() {
    this.entity.object3D.updateMatrixWorld(true);
    const start = this.entity.object3D.getWorldPosition(new THREE.Vector3());
    const target = this.props.endEntity
      ? this.entity.engine.getEntity(this.props.endEntity)
      : null;
    if (target) {
      target.object3D.updateMatrixWorld(true);
      return { start, end: target.object3D.getWorldPosition(new THREE.Vector3()) };
    }
    // A local offset, so a link authored on a prefab (a ladder) rotates with
    // the instance instead of always pointing the same way in world space.
    const end = new THREE.Vector3()
      .fromArray(this.props.end ?? [0, 0, 4])
      .applyQuaternion(this.entity.object3D.getWorldQuaternion(new THREE.Quaternion()))
      .add(start);
    return { start, end };
  }

  /** The link as recast's `OffMeshConnectionParams`, or null if disabled. */
  toConnectionParams() {
    if (!this.enabled) return null;
    const { start, end } = this.endpoints();
    if (start.distanceToSquared(end) < 1e-6) return null;
    return {
      startPosition: { x: start.x, y: start.y, z: start.z },
      endPosition: { x: end.x, y: end.y, z: end.z },
      radius: this.props.radius ?? 0.5,
      bidirectional: this.props.bidirectional !== false,
      area: 0,
      flags: 1,
    };
  }

  #clearGizmo() {
    if (!this.gizmo) return;
    this.entity.engine.scene.remove(this.gizmo);
    this.gizmo.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
    this.gizmo = null;
  }

  /**
   * Draws the link as a line between its two ends with a ring at each.
   *
   * Baked into the mesh means invisible after the fact, and a link whose end
   * has drifted off the navmesh silently does nothing — so seeing where the
   * ends actually are is the difference between a two-minute fix and an
   * afternoon.
   */
  #refreshGizmo() {
    this.#clearGizmo();
    if (!this.enabled || !this.props.showGizmo) return;
    const { start, end } = this.endpoints();
    const group = new THREE.Group();
    group.name = "__navLinkGizmo";
    const material = new THREE.LineBasicMaterial({ color: 0x7cf47c, depthTest: false, transparent: true });
    group.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), material),
    );
    for (const point of [start, end]) {
      const ring = new THREE.TorusGeometry(this.props.radius ?? 0.5, 0.02, 6, 20);
      ring.rotateX(Math.PI / 2);
      ring.translate(point.x, point.y, point.z);
      group.add(new THREE.LineSegments(new THREE.WireframeGeometry(ring), material));
    }
    group.traverse((child) => {
      child.layers.set(DEBUG_LAYER);
      child.frustumCulled = false;
    });
    group.renderOrder = 991;
    this.gizmo = group;
    this.entity.engine.scene.add(group);
  }
}
