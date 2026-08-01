import * as THREE from "three/webgpu";
import { Component } from "./Component.js";

const _matrix = new THREE.Matrix4();
const _size = new THREE.Vector3();

/**
 * An authored decal projector — a scorch mark on a wall, a manhole cover, a
 * poster, a puddle stain (roadmap item 13).
 *
 * The entity IS the projector: its transform is the box, it looks along its own
 * -Z the way a camera does, and the texture spans the box's XY. So placing one
 * is the ordinary move gizmo, and `Object3D.lookAt(surfacePoint)` aims it.
 *
 * It projects through the same `engine.decals` batches the runtime API uses, so
 * forty authored decals sharing a texture are one draw call, exactly like forty
 * bullet holes. That also means an authored decal is not clickable in the
 * viewport (there is no mesh of its own to hit) — it is selected from the
 * hierarchy or by its projector gizmo, which is how Unity's decal projector and
 * every light in this engine already behave.
 *
 * ## When it re-projects
 *
 * A decal is a clipped copy of the geometry beneath it, so it is stale the
 * moment either moves. Baking is deferred to the next frame and coalesced:
 * dragging the gizmo across a wall re-projects once per frame rather than once
 * per pointer event, and the model it lands on finishing its async load
 * triggers exactly one more.
 */
export class DecalComponent extends Component {
  static type = "decal";
  static label = "Decal";
  static tags = ["vfx", "3d"];
  // engine.decals.clear() runs on Stop (a bullet hole from Play must not
  // survive into the edited scene), which takes authored decals with it. The
  // detach/attach a reset gives us is what puts them back.
  static resetOnStop = true;
  static defaults = {
    texture: "",
    color: "#ffffff",
    opacity: 1,
    size: [1, 1, 0.5],
    maxAngle: 90,
    offset: 0.01,
    lit: true,
    blending: "alpha",
    targetTag: "",
  };
  static schema = [
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "size", label: "Size", type: "vec3", step: 0.05 },
    { key: "color", label: "Tint", type: "color" },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "maxAngle", label: "Max Angle", type: "number", min: 1, max: 179, step: 1 },
    { key: "offset", label: "Surface Offset", type: "number", min: 0, step: 0.001 },
    { key: "lit", label: "Lit", type: "boolean" },
    { key: "blending", label: "Blending", type: "select", options: ["alpha", "additive"] },
    { key: "targetTag", label: "Target Tag", type: "text" },
  ];

  onAttach() {
    this.handle = null;
    this._baked = new THREE.Matrix4();
    this._dirty = true;
    this._hasBaked = false;
    const engine = this.entity.engine;
    this.unsubTick = engine?.onPreRender(() => this.#maybeProject());
    // Geometry appearing (an async model load, an undo that re-adds a wall)
    // changes what there is to project onto, and the projector has no other way
    // to hear about it. The event is already coalesced to one per microtask.
    this.unsubHierarchy = engine?.on("hierarchy-changed", () => {
      this._dirty = true;
    });
  }

  onDetach() {
    this.unsubTick?.();
    this.unsubHierarchy?.();
    this.unsubTick = null;
    this.unsubHierarchy = null;
    this.handle?.remove();
    this.handle = null;
  }

  onDisable() {
    this.handle?.remove();
    this.handle = null;
  }

  onEnable() {
    this._dirty = true;
  }

  #maybeProject() {
    if (!this.enabled) return;
    this.entity.object3D.updateWorldMatrix(true, false);
    const matrix = this.entity.object3D.matrixWorld;
    // Moving the projector invalidates the bake as surely as editing it does,
    // and a per-frame comparison of 16 floats is cheaper than subscribing to
    // every path that can move an entity (gizmo, undo, script, physics, a
    // parent moving).
    if (!this._dirty && matrix.equals(this._baked)) return;
    this._dirty = false;
    this._baked.copy(matrix);
    this.project();
  }

  /**
   * Re-projects now. Exposed for scripts and the inspector's Rebake button —
   * geometry can change in ways nothing announces (a terrain sculpt, a mesh
   * edited in the geometry editor).
   */
  project() {
    const engine = this.entity.engine;
    if (!engine?.decals) return null;
    this.handle?.remove();
    this.handle = null;
    if (!this.enabled) return null;
    const size = this.props.size ?? [1, 1, 1];
    _size.set(size[0] ?? 1, size[1] ?? 1, size[2] ?? 1);
    _matrix.copy(this.entity.object3D.matrixWorld);
    this.handle = engine.decals.spawn({
      matrix: _matrix,
      size: _size,
      texture: this.props.texture,
      color: this.props.color,
      opacity: this.props.opacity,
      lit: this.props.lit !== false,
      blending: this.props.blending,
      maxAngle: this.props.maxAngle,
      offset: this.props.offset,
      tag: this.props.targetTag,
    });
    this._hasBaked = true;
    return this.handle;
  }

  /** Triangles this decal contributed, or 0 when it hit nothing — what the
   *  inspector reports so "my decal is invisible" has an answer. */
  get triangleCount() {
    return this.handle ? this.handle.vertexCount / 3 : 0;
  }

  /**
   * The projector volume, drawn while selected.
   *
   * A decal that hits nothing is invisible, and the two reasons — the box does
   * not reach the wall, or it is aimed at its back — are both impossible to
   * diagnose without seeing the box and which way it points. The arrow runs
   * along -Z, the direction it projects.
   */
  onDrawGizmosSelected(gizmos) {
    const object = this.entity.object3D;
    object.updateWorldMatrix(true, false);
    const size = this.props.size ?? [1, 1, 1];
    const hit = this.triangleCount > 0;
    gizmos.transform(object.matrixWorld);
    gizmos.color(hit ? "#4da3ff" : "#ff7a5c");
    gizmos.box([0, 0, 0], [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1]);
    gizmos.arrow([0, 0, (size[2] ?? 1) / 2], [0, 0, -(size[2] ?? 1) / 2]);
    gizmos.transform(null);
  }

  onPropChanged() {
    // Never the default detach/attach: a rebuild would drop and recreate the
    // batch entry for a tint change. The next frame re-projects instead.
    this._dirty = true;
  }
}
