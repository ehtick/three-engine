// @ts-check
import { Component } from "../../engine/components/Component.js";
import { getDefaultMaterial, getMaterialInstance } from "../../engine/materialAsset.js";
import {
  BLOCKOUT_SHAPES,
  BLOCKOUT_COLORS,
  BLOCKOUT_DEFAULT_SIZE,
  blockoutBounds,
  blockoutBoxes,
  buildBlockoutGeometry,
  defaultSteps,
  makeOpening,
} from "./blockoutGeometry.js";
import { acquireBlockoutMaterial, releaseBlockoutMaterial } from "./blockoutMaterial.js";

/**
 * One piece of level blockout — a wall, a floor slab, a staircase, a ramp, a
 * box, a column.
 *
 * ## One component with a `shape`, not seven components
 *
 * Mid-blockout you constantly discover that a wall wanted to be a doorway, or
 * that a floor should have been a platform one step up. With one component
 * that is a dropdown; with seven it is delete-and-redraw, losing the entity's
 * name, its place in the hierarchy, and anything already attached to it.
 *
 * ## It drives the entity's Mesh component rather than owning a mesh
 *
 * Same arrangement as Terrain, and for a reason that is easy to get wrong: a
 * mesh parented under the entity but outside a Mesh COMPONENT is invisible to
 * everything that reasons about scene geometry. `merging.js` collects
 * candidates by `entity.components.get("mesh")`, so a level of five hundred
 * private meshes would be five hundred draw calls that same-material merging
 * could not touch; the occlusion pass skips engine-owned objects, so the walls
 * — the best occluders a level has — would occlude nothing.
 *
 * So the piece computes geometry and hands it to the Mesh component, adding one
 * if the entity has none. Shadows, materials, picking, culling, GI and merging
 * then treat a blockout wall as exactly what it is: a mesh.
 *
 * Collision comes from a sibling Collider set to `mesh` (the editor adds one
 * when the physics module is on). The trimesh is built from the rendered
 * geometry at play start, so re-dragging a wall's length changes what the
 * player bumps into with no extra step.
 */
export class BlockoutComponent extends Component {
  static type = "blockout";
  static label = "Blockout";
  static tags = ["level", "blockout", "3d", "world"];
  static defaults = {
    shape: "wall",
    /**
     * Local extents in metres, always [x, y, z] and always meaning the same
     * axes: X is length/width, Y is height (or thickness, for a slab), Z is
     * depth. Every shape reading one vec3 is what lets the tool drag any piece
     * with the same code, and what lets `shape` change without remapping props.
     */
    size: [4, 3, 0.2],
    /** Walls only: [{ offset, width, height, sill }] holes along the length. */
    openings: [],
    /** Stairs: step count. 0 = derive from the rise (~18 cm risers). */
    steps: 0,
    /** Stairs: open treads instead of a solid staircase. */
    open: false,
    /** Columns: 4 = square pillar, 8/16 read as round. */
    sides: 4,
    /** "" = the shape's greybox palette colour. Ignored while the parent Level
     *  is previewing, which shows the Mesh component's material instead. */
    color: "",
  };
  static schema = [
    { key: "shape", label: "Shape", type: "select", options: BLOCKOUT_SHAPES },
    { key: "size", label: "Size", type: "vec3", step: 0.1 },
    { key: "steps", label: "Steps", type: "number", min: 0, max: 64, step: 1, showIf: (p) => p.shape === "stair" },
    { key: "open", label: "Open Treads", type: "boolean", showIf: (p) => p.shape === "stair" },
    { key: "sides", label: "Sides", type: "number", min: 3, max: 32, step: 1, showIf: (p) => p.shape === "column" },
    { key: "color", label: "Greybox Tint", type: "color" },
  ];

  onAttach() {
    this.mesh = null;
    this.geometry = null;
    this.greyboxMaterial = null;
    this.previousGeometry = null;
    this.boxes = [];
    // A Blockout added to a bare entity (from the Add Component menu rather
    // than from the tool) has nothing to draw with. Adding the Mesh is better
    // than rendering nothing and making the user work out why.
    if (!this.entity.getComponent("mesh")) {
      this.entity.addComponent("mesh", { castShadow: true, receiveShadow: true });
    }
    this.#adopt();
    // The Mesh component replaces its own geometry and material asynchronously
    // (a .mat resolving, the Primitive dropdown being changed). Each of those
    // announces itself; re-adopting is what stops a piece reverting to a white
    // box the first time its material finishes loading.
    this.unsubMesh = this.entity.engine?.on?.("component-changed", (info) => {
      if (info?.entityId === this.entity.id && info?.componentType === "mesh") this.#adopt();
    });
    this.entity.engine?.physics?.markDirty?.(this.entity, { subtree: false });
  }

  onDetach() {
    this.unsubMesh?.();
    this.unsubMesh = null;
    // Hand the mesh back the geometry it had, or it keeps drawing a wall that
    // no longer has a component describing it.
    if (this.mesh) {
      if (this.previousGeometry) this.mesh.geometry = this.previousGeometry;
      // Releasing the claim is what lets the Mesh component paint its own
      // material again — without it the piece keeps the greybox tint forever.
      // Re-applied here rather than through setProp, which would see the same
      // value and do nothing.
      this.mesh.userData.materialOwner = null;
      const path = this.entity.getComponent("mesh")?.props.material;
      this.mesh.material = (path && getMaterialInstance(path)) || getDefaultMaterial();
    }
    this.geometry?.dispose();
    this.geometry = null;
    releaseBlockoutMaterial(this.greyboxMaterial);
    this.greyboxMaterial = null;
    this.mesh = null;
  }

  onPropChanged(key) {
    if (key === "color") {
      this.refreshMaterial();
      return;
    }
    // Changing `shape` deliberately keeps the previous shape's size: a wall
    // turned into a doorway keeps its length and height, which is what makes
    // the conversion useful in the first place.
    this.#rebuildGeometry();
    this.entity.engine?.physics?.markDirty?.(this.entity, { subtree: false });
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
  }

  onDisable() {
    // The piece keeps its geometry and its place in the tree; it just stops
    // being drawn, which is what "switch this wall off for a moment" means
    // while trying a different layout.
    if (this.mesh) this.mesh.visible = false;
  }

  /* ---- Script-facing API ------------------------------------------------ */

  /** The piece's local bounding box as [[minX,minY,minZ],[maxX,maxY,maxZ]].
   *  Slabs hang below the origin; everything else stands on it. */
  bounds() {
    return blockoutBounds(this.props.shape, this.props);
  }

  /** The convex boxes this piece is made of, in local space. */
  parts() {
    return blockoutBoxes(this.props.shape, this.#geometryProps());
  }

  /** Adds an opening (door/window) to a wall and rebuilds it. Returns its
   *  index, or -1 when the piece is not a wall. */
  addOpening(opening = {}) {
    if (this.props.shape !== "wall") return -1;
    const next = [...(this.props.openings ?? []), makeOpening(opening)];
    this.setProp("openings", next);
    return next.length - 1;
  }

  /** Removes the opening at `index`. */
  removeOpening(index) {
    const openings = [...(this.props.openings ?? [])];
    if (index < 0 || index >= openings.length) return false;
    openings.splice(index, 1);
    this.setProp("openings", openings);
    return true;
  }

  /**
   * Re-picks the material: the greybox tint, or the Mesh component's own
   * material while the parent Level is previewing.
   *
   * Called by the piece when its tint changes and by the Level when Preview is
   * toggled — a direct call rather than an event, because a Level knows exactly
   * which pieces are its own and a scene can hold several levels in different
   * preview states.
   */
  refreshMaterial() {
    if (!this.mesh) return;
    if (this.#previewing()) {
      // Hand the mesh back to its own component: Preview means "show me what
      // the Mesh component says", including any .mat still streaming in.
      this.mesh.userData.materialOwner = null;
      const path = this.entity.getComponent("mesh")?.props.material;
      // The Mesh component's own async load will land on the same instance;
      // this is what makes the switch immediate rather than one frame late.
      this.mesh.material = (path && getMaterialInstance(path)) || getDefaultMaterial();
      releaseBlockoutMaterial(this.greyboxMaterial);
      this.greyboxMaterial = null;
      return;
    }
    // Claim the material before assigning it. MeshComponent finishes its own
    // async material pass a microtask after attach and would otherwise reset
    // every piece to the default white — see its #applyMaterialSlots.
    this.mesh.userData.materialOwner = "blockout";
    const color = this.props.color || BLOCKOUT_COLORS[this.props.shape] || "#9aa7b8";
    const next = acquireBlockoutMaterial(color);
    const previous = this.greyboxMaterial;
    this.greyboxMaterial = next;
    this.mesh.material = next;
    // Released after acquiring the replacement: the two are usually the same
    // interned instance, and releasing first would dispose it at zero users.
    if (previous && previous !== next) releaseBlockoutMaterial(previous);
  }

  /* ---- Internals -------------------------------------------------------- */

  /** True while the nearest ancestor Level is showing real materials. A piece
   *  outside any Level previews only if it has a material to preview. */
  #previewing() {
    let node = this.entity;
    while (node) {
      const level = node.getComponent?.("level");
      if (level) return !!level.props.preview;
      node = node.parent;
    }
    return !!this.entity.getComponent("mesh")?.props.material;
  }

  /** Takes over the Mesh component's mesh, remembering what it was drawing. */
  #adopt() {
    const mesh = this.entity.getComponent("mesh")?.mesh;
    if (!mesh) return;
    if (mesh !== this.mesh) {
      this.mesh = mesh;
      // Only the FIRST geometry seen is worth restoring — after that, what the
      // mesh is holding is ours.
      this.previousGeometry = mesh.geometry === this.geometry ? this.previousGeometry : mesh.geometry;
    }
    this.#rebuildGeometry();
    this.refreshMaterial();
  }

  /** Props as the geometry builder wants them — the one place `steps: 0`
   *  becomes "derive from the rise", so the prop can stay a plain number the
   *  inspector shows as 0 = automatic. */
  #geometryProps() {
    const size = this.props.size ?? BLOCKOUT_DEFAULT_SIZE[this.props.shape] ?? [1, 1, 1];
    return {
      ...this.props,
      size,
      steps: this.props.steps > 0 ? this.props.steps : defaultSteps(Math.max(0.001, size[1])),
    };
  }

  #rebuildGeometry() {
    if (!this.mesh) return;
    const previous = this.geometry;
    const { geometry, boxes } = buildBlockoutGeometry(this.props.shape, this.#geometryProps());
    this.geometry = geometry;
    this.boxes = boxes;
    this.mesh.geometry = geometry;
    previous?.dispose();
  }
}
