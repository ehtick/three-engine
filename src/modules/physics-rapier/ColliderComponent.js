import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { physicsLayerNames } from "./layerConfig.js";

const GIZMO_COLOR = 0x2df098;

/**
 * Collision shape. Pairs with a Rigidbody on the same entity (or the nearest
 * ancestor Rigidbody — child colliders form a compound body). A collider with
 * no Rigidbody anywhere above it becomes static level geometry.
 *
 * `shape: "mesh"` builds a trimesh from the entity's rendered geometry at
 * play start (static/kinematic use only — Rapier trimeshes are hollow).
 * `shape: "heightfield"` reads the entity's sibling Terrain component
 * (resolution/heights/size) and builds a Rapier heightfield — requires a
 * Terrain component on the same entity (static/kinematic use only).
 * Both skip the wireframe gizmo — the rendered mesh is its own outline.
 */
export class ColliderComponent extends Component {
  static type = "collider";
  static label = "Collider";
  static tags = ["physics", "play-mode", "3d"];
  static defaults = {
    shape: "box",
    size: [1, 1, 1],
    radius: 0.5,
    height: 1,
    offset: [0, 0, 0],
    friction: 0.5,
    restitution: 0,
    isSensor: false,
    // Which collision layer this collider is on. The project's layer matrix
    // (Project Settings → Physics) decides which layers actually interact —
    // that is how a projectile stops hitting the player who fired it.
    layer: "Default",
  };
  static schema = [
    { key: "shape", label: "Shape", type: "select", options: ["box", "sphere", "capsule", "mesh", "heightfield"] },
    { key: "layer", label: "Layer", type: "select", options: physicsLayerNames },
    { key: "size", label: "Size", type: "vec3", showIf: (p) => p.shape === "box" },
    { key: "radius", label: "Radius", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.shape === "sphere" || p.shape === "capsule" },
    { key: "height", label: "Height", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.shape === "capsule" },
    { key: "offset", label: "Offset", type: "vec3", showIf: (p) => p.shape !== "mesh" && p.shape !== "heightfield" },
    { key: "friction", label: "Friction", type: "number", min: 0, max: 2, step: 0.05 },
    { key: "restitution", label: "Bounciness", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "isSensor", label: "Is Trigger", type: "boolean" },
  ];

  onAttach() {
    this.collider = null; // assigned by PhysicsSystem while playing
    // See RigidbodyComponent.onAttach: entities arrive after the world is
    // built, and nothing else tells the world they did.
    this.entity.engine?.physics?.markDirty(this.entity, { subtree: false });
    this.#buildGizmo();
    // Heightfield gizmo mirrors the sibling terrain's surface — rebuild it
    // whenever that terrain's heights (or size/resolution) change so the
    // collision preview keeps matching what the user just sculpted.
    if (this.props.shape === "heightfield") {
      this._terrainUnsub = this.entity.engine?.on?.("component-changed", (info) => {
        if (info?.entityId === this.entity.id && info?.componentType === "terrain") this.#rebuildGizmo();
      });
    }
  }

  onDetach() {
    const physics = this.entity.engine?.physics;
    // Before clearing the handle — that is what the world removes it by.
    physics?.removeEntity(this.entity, { subtree: false });
    physics?.markDirty(this.entity, { subtree: false });
    this.collider = null;
    this._terrainUnsub?.();
    this._terrainUnsub = null;
    this.#disposeGizmo();
  }

  #rebuildGizmo() {
    this.#disposeGizmo();
    this.#buildGizmo();
  }

  #buildGizmo() {
    const { shape, size, radius, height, offset } = this.props;
    let geometry = null;
    if (shape === "box") {
      geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0], size[1], size[2]));
    } else if (shape === "sphere") {
      geometry = new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 12, 8));
    } else if (shape === "capsule") {
      geometry = new THREE.WireframeGeometry(new THREE.CapsuleGeometry(radius, height, 4, 8));
    } else if (shape === "heightfield") {
      geometry = buildHeightfieldWireframe(this.entity);
    }
    if (!geometry) return; // mesh shape (or terrain not ready): rendered mesh is its own outline

    this.gizmo = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.gizmo.position.fromArray(offset);
    // Defer to scene depth so the wireframe hides behind walls instead of
    // painting over them; the previous `depthTest: false` made colliders
    // look like they sit in front of every solid object in the scene.
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

/**
 * Wireframe that traces the sibling Terrain's collision surface, for the
 * `heightfield` collider shape. Sampled on a coarse grid (the full heightmap
 * would be far too dense as line segments) at the terrain's live heights, and
 * lifted a hair above the surface to avoid z-fighting. Returns null if the
 * entity has no Terrain component yet (e.g. the collider was added first).
 */
function buildHeightfieldWireframe(entity) {
  const terrain = entity?.getComponent?.("terrain");
  if (!terrain?.heightsArray || typeof terrain.heightAtLocal !== "function") return null;
  const size = terrain.props?.size ?? 50;
  const segments = Math.min(32, Math.max(2, terrain.resolution ?? 32));
  const plane = new THREE.PlaneGeometry(size, size, segments, segments);
  plane.rotateX(-Math.PI / 2);
  const pos = plane.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrain.heightAtLocal(pos.getX(i), pos.getZ(i)) + 0.02);
  }
  pos.needsUpdate = true;
  const wire = new THREE.WireframeGeometry(plane);
  plane.dispose();
  return wire;
}
