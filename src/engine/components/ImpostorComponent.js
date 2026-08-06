import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { entitySubtreeVisible } from "../vfx/ribbonMesh.js";

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * A billboard standing in for a whole prop — the last level of an LOD chain
 * (roadmap item 14).
 *
 * LOD groups take a prop from ten thousand triangles down to a few hundred, and
 * then stop: the coarsest hand-authored level still costs vertex work and a
 * material. For the things that fill a landscape — trees, rocks, fence posts,
 * five hundred of them — an impostor replaces the prop with ONE quad sampling a
 * pre-rendered octahedral atlas, and every impostor sharing that atlas draws in
 * a single instanced call (see `ImpostorSystem`).
 *
 * ## It is a level, not a mode
 *
 * The component goes on a CHILD of an LOD group, alongside the mesh levels, and
 * the group treats it like any other level — same thresholds, same hysteresis,
 * same "the children are the levels" rule. Nothing in LOD selection had to
 * learn what an impostor is. It also works alone, on a prop that is only ever
 * seen from far away, which is why it does not require a group.
 *
 * ## The component draws nothing itself
 *
 * There is no mesh under this entity. The billboard is one instance in a shared
 * buffer at the scene root, and this component's job is to answer, once per
 * frame, where that instance is and whether it should be visible. That is what
 * `instanceData` is: the entity's world transform decomposed into the centre,
 * size and two axes the material needs, with `size = 0` standing in for hidden.
 *
 * ## The source defaults to the sibling above it
 *
 * `source` is an entity reference, and an empty one means "the first sibling
 * that is not me" — which in an LOD chain is LOD0. That default is what makes
 * the common case need no wiring at all, and it cannot dangle: it is resolved
 * from the scene graph on demand rather than stored.
 */
export class ImpostorComponent extends Component {
  static type = "impostor";
  static label = "Impostor";
  static tags = ["rendering", "3d", "performance"];
  static defaults = {
    /** Entity to bake. Empty = the first sibling under the same parent. */
    source: "",
    /** Views per octahedral axis: 8 → 64 frames, roughly 15° apart. */
    frames: 8,
    /** Texels per view. */
    tile: 128,
    /** Upper hemisphere only — right for anything standing on the ground. */
    hemisphere: true,
    /** Coverage below this is discarded, so the quad reads as a silhouette. */
    alphaTest: 0.5,
    /** Light the billboard from the baked normals (off = show the bake flat). */
    lit: true,
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "source", label: "Source", type: "entity" },
    { key: "frames", label: "Frames", type: "number", min: 2, max: 16, step: 1 },
    { key: "tile", label: "Frame Size", type: "number", min: 16, max: 512, step: 16 },
    { key: "hemisphere", label: "Upper Hemisphere", type: "boolean" },
    { key: "alphaTest", label: "Alpha Cutoff", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "lit", label: "Lit", type: "boolean" },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  constructor(props) {
    super(props);
    this.atlasKey = null;
    this.batchKey = null;
    this.atlas = null;
    this.detached = false;
    this.bakeError = null;
    this.pendingSource = false;
    this._data = {
      center: new THREE.Vector3(),
      axisX: new THREE.Vector3(1, 0, 0),
      axisY: new THREE.Vector3(0, 1, 0),
      size: 0,
    };
  }

  onAttach() {
    this.detached = false;
    this.entity.engine?.impostors?.request(this);
  }

  onDetach() {
    this.detached = true;
    this.entity.engine?.impostors?.cancel(this);
    this.entity.engine?.impostors?.release(this);
  }

  /** Nothing to hide: a disabled impostor reports `size = 0` on the next sync,
   *  which is the same path an LOD-hidden one takes. */
  onDisable() {}
  onEnable() {}

  /** The settings that decide what gets baked — also the cache key's tail. */
  bakeSettings() {
    return {
      frames: this.props.frames,
      tile: this.props.tile,
      hemisphere: this.props.hemisphere !== false,
      alphaTest: this.props.alphaTest,
      lit: this.props.lit !== false,
    };
  }

  /**
   * The `Object3D` subtree to bake.
   *
   * Deliberately resolved live rather than cached: a scene deserializes in an
   * arbitrary order, so the sibling this defaults to may not exist yet when the
   * component attaches, and a cached null would be an impostor that never
   * appears with nothing in the UI to say why.
   */
  resolveSource() {
    const engine = this.entity.engine;
    if (this.props.source) {
      const target = engine?.getEntity?.(this.props.source);
      return target && target !== this.entity ? target.object3D : null;
    }
    const siblings = this.entity.parent ? this.entity.parent.children : null;
    if (!siblings) return null;
    for (const sibling of siblings) {
      if (sibling === this.entity) continue;
      if (sibling.getComponent?.("impostor")) continue;
      return sibling.object3D;
    }
    return null;
  }

  /** Called by `ImpostorSystem` when an atlas (fresh or cached) is available. */
  applyAtlas(atlasKey, batchKey, atlas) {
    this.atlasKey = atlasKey;
    this.batchKey = batchKey;
    this.atlas = atlas;
    this.bakeError = null;
  }

  /**
   * This frame's instance data.
   *
   * The centre is the atlas's centre carried through the entity's world matrix,
   * so an impostor authored off-origin sits where its source sat; the axes are
   * the entity's own, normalised, which is what lets the shader get back into
   * the space the atlas was baked in; and the size is the baked diameter scaled
   * by the entity's world scale, so scaling a tree scales its billboard.
   *
   * `size = 0` is the "not drawn" signal — LOD hid it, an ancestor is disabled,
   * or the component is switched off. Writing a degenerate quad costs one float
   * and rasterises nothing; removing the instance from the buffer instead would
   * mean compacting the whole forest every time one tree crossed a threshold.
   */
  instanceData(atlas) {
    const data = this._data;
    const visible =
      this.enabled &&
      this.entity._lodHidden !== true &&
      entitySubtreeVisible(this.entity) &&
      !!atlas;
    if (!visible) {
      data.size = 0;
      return data;
    }
    this.entity.object3D.updateWorldMatrix(true, false);
    _matrix.copy(this.entity.object3D.matrixWorld);
    _matrix.decompose(_position, _quaternion, _scale);
    data.center.copy(atlas.center).applyMatrix4(_matrix);
    data.axisX.set(1, 0, 0).applyQuaternion(_quaternion);
    data.axisY.set(0, 1, 0).applyQuaternion(_quaternion);
    // One scale for the billboard: it is a sphere's diameter, and a sphere has
    // no way to be 2× wide and 1× tall. The largest axis is the safe choice —
    // it over-covers rather than clipping the silhouette.
    const scale = Math.max(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z));
    data.size = atlas.radius * 2 * scale;
    return data;
  }

  /** True once there is something to draw — what the inspector reports. */
  get ready() {
    return !!this.atlas;
  }

  onPropChanged(key) {
    if (key === "castShadow" || key === "receiveShadow") {
      // Shadow flags are part of the BATCH key (they cannot vary within one
      // draw), so changing one has to move this instance to another batch.
      this.entity.engine?.impostors?.rebake(this);
      return;
    }
    // Everything else changes what the atlas IS, so the old one is handed back
    // and a new bake requested. The base class's detach/attach rebuild would
    // work too, and would leak the atlas refcount.
    this.entity.engine?.impostors?.rebake(this);
  }
}
