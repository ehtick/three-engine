import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { BatchCommand, CreateEntityCommand, DeleteEntityCommand } from "./commands/entityCommands.js";
import { AddComponentCommand, SetComponentPropCommand } from "./commands/componentCommands.js";
import { getComponentClass } from "../engine/components/registry.js";
import {
  BLOCKOUT_COLORS,
  BLOCKOUT_DEFAULT_SIZE,
  OPENING_PRESETS,
  makeOpening,
} from "../modules/level-design/blockoutGeometry.js";
import {
  getActiveFloorId,
  getActiveLevelId,
  getLevelToolSettings,
  setActiveLevel,
} from "./levelTool.js";

/**
 * Turning a blockout gesture into scene entities.
 *
 * Everything here goes through the command bus, so a level built by dragging
 * undoes piece by piece exactly like one built by hand — no separate history,
 * no "the level tool's edits can't be undone" footnote. It is also the only
 * place that knows the SHAPE of a level (Level → storeys → pieces), which is
 * why the viewport tool, the inspector buttons and the MCP ops all call in
 * here rather than each assembling entities their own way.
 */

const PIECE_NAMES = {
  floor: "Floor",
  platform: "Platform",
  wall: "Wall",
  stair: "Stair",
  ramp: "Ramp",
  box: "Box",
  column: "Column",
};

/** Storeys are named by their elevation, the way a building is. */
export function floorName(elevation) {
  return `Floor ${elevation.toFixed(2)}m`;
}

/** True when the physics module is on, so pieces can be given colliders. A
 *  registry lookup rather than a module-list check: it is the component being
 *  registered that decides whether `addComponent("collider")` works. */
export function physicsAvailable() {
  return !!getComponentClass("collider");
}

/** The collider spec a walkable piece gets. `mesh` (a trimesh built from the
 *  rendered geometry at play start) rather than a box, because a stair and a
 *  wall with a door are not boxes — and because a trimesh re-derives itself
 *  when the piece is resized, so collision can never drift from the picture. */
function colliderSpec() {
  return { type: "collider", props: { shape: "mesh", friction: 0.6, restitution: 0 } };
}

/**
 * The components a new piece is created with.
 *
 * The Mesh comes FIRST and is not optional: a Blockout draws through the
 * entity's Mesh component (see BlockoutComponent) so the piece is a first-class
 * mesh to merging, culling and GI. Creating it here rather than leaning on the
 * component's own fallback keeps its material slot on the entity from the
 * start, which is what Preview mode later switches to.
 */
function pieceComponents(shape, props, collision, material = "") {
  const { material: _ignored, ...blockoutProps } = props;
  const components = [
    { type: "mesh", props: { castShadow: true, receiveShadow: true, material } },
    { type: "blockout", props: { shape, ...blockoutProps } },
  ];
  if (collision && physicsAvailable()) components.push(colliderSpec());
  return components;
}

/**
 * The level and storey a new piece should join, creating whatever is missing.
 *
 * A blockout starts on an empty scene far more often than not, so "there is no
 * level yet" is the normal case rather than an error: the first click builds
 * Level → Floor 0.00m → the piece as ONE undoable, which is what makes the
 * tool feel like drawing rather than like setting up a hierarchy.
 */
export function ensureLevelAndFloor(elevation, { name = "Level" } = {}) {
  const settings = getLevelToolSettings();
  let levelId = getActiveLevelId();
  let level = levelId ? engine.getEntity(levelId)?.getComponent?.("level") : null;

  // Fall back to the only level in the scene before making a second one —
  // drawing after a reload should continue the level that is already there.
  if (!level) {
    const found = [];
    for (const root of engine.rootEntities) root.traverse((entity) => {
      if (entity.getComponent?.("level")) found.push(entity);
    });
    if (found.length === 1) {
      levelId = found[0].id;
      level = found[0].getComponent("level");
      setActiveLevel(levelId);
    }
  }

  if (!level) {
    const command = new CreateEntityCommand({
      name,
      components: [{
        type: "level",
        props: {
          grid: settings.grid,
          angleSnap: settings.angleSnap,
          storeyHeight: settings.storeyHeight,
          wallHeight: settings.wallHeight,
          wallThickness: settings.wallThickness,
          slabThickness: settings.slabThickness,
          stairWidth: settings.stairWidth,
          collision: settings.collision,
        },
      }],
      children: [{
        name: floorName(elevation),
        transform: { position: [0, elevation, 0] },
        components: [{ type: "levelfloor", props: {} }],
      }],
    });
    commandBus.execute(command);
    levelId = command.entityId;
    const floor = engine.getEntity(levelId)?.children?.[0];
    setActiveLevel(levelId, floor?.id ?? null);
    return { levelId, floorId: floor?.id ?? null, created: true };
  }

  return { levelId, floorId: ensureFloor(levelId, elevation), created: false };
}

/**
 * The storey at `elevation` in this level, created if there is none within
 * half a storey of it.
 *
 * The tolerance is what stops a mezzanine drawn 20 cm above the floor from
 * spawning a storey of its own — pieces at odd heights are ordinary members of
 * the storey they sit above, exactly as a raised platform is part of a room.
 */
export function ensureFloor(levelId, elevation) {
  const levelEntity = engine.getEntity(levelId);
  const level = levelEntity?.getComponent?.("level");
  if (!level) return null;
  const tolerance = Math.max(0.05, (level.props.storeyHeight || 3) / 2 - 0.01);
  const near = level.floorAt(elevation);
  if (near && Math.abs(near.object3D.position.y - elevation) <= tolerance) return near.id;

  const command = new CreateEntityCommand({
    name: floorName(elevation),
    parentId: levelId,
    transform: { position: [0, elevation, 0] },
    components: [{ type: "levelfloor", props: {} }],
  });
  commandBus.execute(command);
  return command.entityId;
}

/** Adds a storey at `elevation` unconditionally (the Level inspector's "+"). */
export function addFloor(levelId, elevation) {
  const command = new CreateEntityCommand({
    name: floorName(elevation),
    parentId: levelId,
    transform: { position: [0, elevation, 0] },
    components: [{ type: "levelfloor", props: {} }],
  });
  commandBus.execute(command);
  return command.entityId;
}

const _worldPosition = new THREE.Vector3();

/**
 * Creates one piece.
 *
 * `position` and `rotationY` are WORLD space — that is what a viewport gesture
 * produces — and are converted into the storey's local space here, so moving
 * or rotating a storey later carries everything on it. `size` is local extents
 * as the geometry builder means them.
 */
export function createPiece({
  shape,
  position,
  rotationY = 0,
  size,
  props = {},
  floorId = null,
  collision = null,
  select = true,
  name = null,
} = {}) {
  const settings = getLevelToolSettings();
  const elevation = position?.[1] ?? 0;
  // ONE gesture, ONE Ctrl+Z. The first piece drawn in an empty scene also
  // creates a Level and a storey; without this the user undoes their wall and
  // is left staring at an empty Level they never asked for, and has to press
  // undo again to work out what happened. Each step is still its own command
  // (a failure part-way through leaves a real, undoable prefix) — they are
  // collapsed into one entry after the fact.
  const mark = commandBus.markGroup();
  let parentId = floorId ?? getActiveFloorId();
  if (!parentId || !engine.getEntity(parentId)) {
    parentId = ensureLevelAndFloor(elevation).floorId;
  }
  const parent = engine.getEntity(parentId);
  if (!parent) return null;

  const level = levelOf(parent)?.getComponent?.("level");
  const wantCollision = collision ?? level?.props.collision ?? settings.collision;

  _worldPosition.set(position?.[0] ?? 0, elevation, position?.[2] ?? 0);
  parent.object3D.updateWorldMatrix(true, false);
  const local = parent.object3D.worldToLocal(_worldPosition.clone());
  // Only the storey's own yaw is subtracted; a storey tilted in X/Z is not a
  // thing the tool creates, and pretending to correct for one would produce a
  // piece whose numbers no longer match what was drawn.
  const parentYaw = new THREE.Euler().setFromQuaternion(
    parent.object3D.getWorldQuaternion(new THREE.Quaternion()), "YXZ",
  ).y;

  const command = new CreateEntityCommand({
    name: name ?? PIECE_NAMES[shape] ?? "Blockout",
    parentId,
    transform: {
      position: local.toArray(),
      rotation: [0, rotationY - parentYaw, 0],
      scale: [1, 1, 1],
    },
    components: pieceComponents(
      shape,
      { size: size ?? BLOCKOUT_DEFAULT_SIZE[shape] ?? [1, 1, 1], ...props },
      wantCollision,
      props.material ?? "",
    ),
  });
  commandBus.execute(command);
  commandBus.collapseFrom(mark, `Draw ${PIECE_NAMES[shape] ?? shape}`);
  if (select) {
    // Imported lazily: the selection store pulls in React-side state, and this
    // module is also reached from the headless op layer.
    import("./store/selectionStore.js")
      .then(({ useSelectionStore }) => useSelectionStore.getState().select(command.entityId))
      .catch(() => {});
  }
  return command.entityId;
}

/** The nearest ancestor (or self) carrying a Level component. */
export function levelOf(entity) {
  let node = entity;
  while (node) {
    if (node.getComponent?.("level")) return node;
    node = node.parent;
  }
  return null;
}

/**
 * Punches an opening into a wall.
 *
 * `offset` is metres along the wall from its centre; the caller (the viewport
 * tool) gets that from where the ray hit the wall, which is why this takes a
 * number rather than a world point. Clamped so a door can't be created hanging
 * off the end of the wall it belongs to.
 */
export function addOpening(entityId, { offset = 0, kind = "door", width, height, sill } = {}) {
  const piece = engine.getEntity(entityId)?.getComponent?.("blockout");
  if (!piece || piece.props.shape !== "wall") return -1;
  const preset = OPENING_PRESETS[kind] ?? OPENING_PRESETS.door;
  const opening = makeOpening({
    width: width ?? preset.width,
    height: height ?? preset.height,
    sill: sill ?? preset.sill,
  });
  const half = (piece.props.size?.[0] ?? 1) / 2;
  opening.offset = THREE.MathUtils.clamp(offset, -half + opening.width / 2, half - opening.width / 2);
  const next = [...(piece.props.openings ?? []), opening];
  commandBus.execute(new SetComponentPropCommand(entityId, "blockout", "openings", next, `Add ${kind}`));
  return next.length - 1;
}

/** Removes the opening at `index` from a wall. */
export function removeOpening(entityId, index) {
  const piece = engine.getEntity(entityId)?.getComponent?.("blockout");
  if (!piece) return false;
  const openings = [...(piece.props.openings ?? [])];
  if (index < 0 || index >= openings.length) return false;
  openings.splice(index, 1);
  commandBus.execute(new SetComponentPropCommand(entityId, "blockout", "openings", openings, "Remove opening"));
  return true;
}

/** Deletes a piece (the Erase tool). */
export function erasePiece(entityId) {
  if (!engine.getEntity(entityId)) return false;
  commandBus.execute(new DeleteEntityCommand(entityId));
  return true;
}

/**
 * Gives every piece under `levelId` a mesh Collider, skipping those that
 * already have one. The repair path for the two ways a level ends up
 * non-walkable: it was drawn before the physics module was enabled, or with
 * the level's Collision switch off.
 */
export function addCollidersToLevel(levelId) {
  if (!physicsAvailable()) return { added: 0, physics: false };
  const root = engine.getEntity(levelId);
  if (!root) return { added: 0, physics: true };
  const commands = [];
  root.traverse((entity) => {
    if (!entity.getComponent?.("blockout") || entity.getComponent("collider")) return;
    commands.push(new AddComponentCommand(entity.id, "collider", colliderSpec().props));
  });
  if (!commands.length) return { added: 0, physics: true };
  commandBus.execute(new BatchCommand(commands, `Add colliders (${commands.length})`));
  return { added: commands.length, physics: true };
}

/** Every level entity in the scene, for the toolbar's level picker. */
export function listLevels() {
  const levels = [];
  for (const root of engine.rootEntities) {
    root.traverse((entity) => {
      if (entity.getComponent?.("level")) levels.push({ id: entity.id, name: entity.name });
    });
  }
  return levels;
}

/** Palette colour a shape draws with, for the toolbar swatches and the ghost. */
export function shapeColor(shape) {
  return BLOCKOUT_COLORS[shape] ?? "#9aa7b8";
}
