// @ts-check
import { Component } from "../../engine/components/Component.js";

/**
 * One storey of a level.
 *
 * A floor is a plain entity holding the pieces drawn at its elevation, and the
 * elevation is its TRANSFORM — not a prop. That is the whole design: raising a
 * storey is dragging it with the ordinary move gizmo, which carries every wall
 * and slab on it, and undo/redo, snapping and multi-select all work because
 * nothing new was invented. A prop would have been a second source of truth
 * that the gizmo could silently disagree with.
 *
 * What the component adds is the two things a transform cannot say: how tall
 * this storey is (walls drawn here default to it), and whether the tool is
 * allowed to draw into it. `locked` matters more than it sounds — the moment a
 * level has three storeys, every click lands on whichever one the ray hit
 * first, and locking the finished ones is how you keep working on the top.
 */
export class LevelFloorComponent extends Component {
  static type = "levelfloor";
  static label = "Level Floor";
  static tags = ["level", "blockout", "world"];
  static defaults = {
    /** Storey height in metres. 0 = inherit the Level's `storeyHeight`. */
    height: 0,
    /** The tool skips locked storeys when picking what to draw into. */
    locked: false,
  };
  static schema = [
    { key: "height", label: "Height", type: "number", min: 0, step: 0.1 },
    { key: "locked", label: "Locked", type: "boolean" },
  ];

  /** Elevation in world space — the walkable surface of this storey. */
  get elevation() {
    return this.entity.object3D.position.y;
  }

  /** Resolved storey height: this floor's own, or the Level's default. */
  get storeyHeight() {
    if (this.props.height > 0) return this.props.height;
    let node = this.entity.parent;
    while (node) {
      const level = node.getComponent?.("level");
      if (level) return level.props.storeyHeight;
      node = node.parent;
    }
    return 3;
  }

  /** The Blockout pieces parented to this storey. */
  pieces() {
    const found = [];
    const walk = (entity) => {
      const piece = entity.getComponent?.("blockout");
      if (piece) found.push(piece);
      for (const child of entity.children ?? []) walk(child);
    };
    for (const child of this.entity.children ?? []) walk(child);
    return found;
  }
}
