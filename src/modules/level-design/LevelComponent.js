// @ts-check
import { Component } from "../../engine/components/Component.js";

/**
 * The root of a blockout: the settings every piece under it is drawn with, and
 * the switch between greybox and the real thing.
 *
 * It holds no geometry. What it owns is the *authoring* state that would
 * otherwise be editor-only preferences — grid size, storey height, default
 * wall height — and that matters because those numbers are a property of the
 * level, not of whoever last opened it. Reopening a project a week later, or on
 * another machine, restores a 1 m grid and 3 m storeys because the level said
 * so, instead of whatever the tool happened to remember.
 *
 * `preview` flips the whole level between the greybox palette and the .mat
 * assets assigned to its pieces. It is on the Level rather than on each piece
 * so the toggle is one click during a walkthrough, and it is a saved prop
 * rather than a viewport toggle because "does this level have its materials
 * yet" is a real state of the work.
 */
export class LevelComponent extends Component {
  static type = "level";
  static label = "Level";
  static tags = ["level", "blockout", "world"];
  static defaults = {
    /** XZ snap in metres. Pieces land on multiples of this. */
    grid: 1,
    /** Rotation snap in degrees for walls/stairs. 0 = free. */
    angleSnap: 15,
    /** Distance between storeys — what the +/- floor buttons step by. */
    storeyHeight: 3,
    /** Defaults for newly drawn pieces. */
    wallHeight: 3,
    wallThickness: 0.2,
    slabThickness: 0.2,
    stairWidth: 1.4,
    /** Add a mesh Collider to every piece the tool draws (needs the physics
     *  module). Off makes a level scenery you walk through. */
    collision: true,
    /** false = greybox palette, true = the pieces' assigned materials. */
    preview: false,
  };
  static schema = [
    { key: "grid", label: "Grid", type: "number", min: 0.01, step: 0.05 },
    { key: "angleSnap", label: "Angle Snap", type: "number", min: 0, max: 90, step: 5 },
    { key: "storeyHeight", label: "Storey Height", type: "number", min: 0.1, step: 0.1 },
    { key: "wallHeight", label: "Wall Height", type: "number", min: 0.1, step: 0.1 },
    { key: "wallThickness", label: "Wall Thickness", type: "number", min: 0.01, step: 0.01 },
    { key: "slabThickness", label: "Slab Thickness", type: "number", min: 0.01, step: 0.01 },
    { key: "stairWidth", label: "Stair Width", type: "number", min: 0.1, step: 0.1 },
    { key: "collision", label: "Collision", type: "boolean" },
    { key: "preview", label: "Preview Materials", type: "boolean" },
  ];

  onPropChanged(key) {
    // Every piece asks its nearest ancestor Level whether to show materials, so
    // flipping the switch means telling them to look again. Walking the subtree
    // (rather than emitting an engine event) keeps two levels in one scene
    // independent — a common setup when a hub scene holds several rooms.
    if (key === "preview") for (const piece of this.pieces()) piece.refreshMaterial();
  }

  /** Every Blockout piece under this level, in tree order. */
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

  /** The storey entities directly under this level, lowest first. */
  floors() {
    return (this.entity.children ?? [])
      .filter((child) => child.getComponent?.("levelfloor"))
      .sort((a, b) => a.object3D.position.y - b.object3D.position.y);
  }

  /** The storey nearest `elevation`, or null when the level has none yet. */
  floorAt(elevation) {
    let best = null;
    let bestDistance = Infinity;
    for (const floor of this.floors()) {
      const distance = Math.abs(floor.object3D.position.y - elevation);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = floor;
      }
    }
    return best;
  }
}
