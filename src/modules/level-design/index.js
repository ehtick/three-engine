// @ts-check
import { LevelComponent } from "./LevelComponent.js";
import { LevelFloorComponent } from "./LevelFloorComponent.js";
import { BlockoutComponent } from "./BlockoutComponent.js";

/**
 * Level Design module — greybox blockouts you can walk through.
 *
 * Three components and no runtime system: a blockout is authored data that
 * builds its own geometry, so there is nothing to tick and nothing to
 * initialise. That is deliberate. The module can be enabled on a shipping
 * project without adding a frame of cost, which is what lets a blockout stay in
 * the level as the grey box behind the art instead of being deleted the moment
 * modelling starts.
 *
 * Physics is not a dependency but is the point: with the Rapier module enabled,
 * the editor's tools give every piece a mesh Collider, so a level is walkable
 * the moment it is drawn. Without it the pieces are scenery, and nothing
 * errors.
 */
export const levelDesignModule = {
  id: "level-design",
  name: "Level Design",
  version: "1.0.0",
  category: "World",
  tags: ["level", "blockout", "greybox", "whitebox", "prototyping", "world", "3d"],
  description:
    "Greybox level blockouts: draw walls, floors, stairs, ramps, boxes and " +
    "columns on a snapped grid, stacked into storeys. Pieces build their own " +
    "geometry from numbers, take mesh colliders so the level is walkable " +
    "immediately, and swap to real materials with one Preview toggle.",
  components: [LevelComponent, LevelFloorComponent, BlockoutComponent],
};

export { LevelComponent, LevelFloorComponent, BlockoutComponent };
