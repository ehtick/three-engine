/**
 * Level blockout, as ops. `character.create` used to live here too, before
 * the Character Controller became its own module — see `ops/character.js`.
 *
 * The viewport tools are a mouse gesture — press, drag, release — which an
 * agent cannot make. What it CAN do is say the same thing in numbers, so every
 * op here takes either the two points of a drag (`from`/`to`, run through the
 * exact same solver the pointer handlers use) or an explicit position and size.
 * The first form is what makes "draw a room" one call per wall instead of four
 * lines of trigonometry per wall; the second is what makes a generated level
 * reproducible.
 *
 * Deliberately NOT exposed: the armed tool's pointer state. An agent that could
 * arm a tool but not click would leave the editor in a mode the user then has
 * to escape from. `level.setTool` exists because handing the user a viewport
 * that is already in Wall mode is a genuinely useful handoff, and it is the
 * only stateful thing here.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useModulesStore } from "../../modules.js";

function requireLevelModule() {
  if (!useModulesStore.getState().enabled.includes("level-design")) {
    throw new Error(
      'The "level-design" module is not enabled for this project. Enable it with module.setEnabled.',
    );
  }
}

function requireEntity(entityId) {
  const entity = engine.getEntity(entityId);
  if (!entity) throw new Error(`No entity with id "${entityId}".`);
  return entity;
}

/** Every level in the scene with its storeys and piece counts. */
function describeLevels() {
  const levels = [];
  for (const root of engine.rootEntities) {
    root.traverse((entity) => {
      const level = entity.getComponent?.("level");
      if (!level) return;
      levels.push({
        entityId: entity.id,
        name: entity.name,
        preview: !!level.props.preview,
        grid: level.props.grid,
        storeyHeight: level.props.storeyHeight,
        pieces: level.pieces().length,
        floors: level.floors().map((floor) => ({
          entityId: floor.id,
          name: floor.name,
          elevation: floor.object3D.position.y,
          locked: !!floor.getComponent("levelfloor")?.props.locked,
          pieces: floor.getComponent("levelfloor")?.pieces().length ?? 0,
        })),
      });
    });
  }
  return levels;
}

defineOp({
  name: "level.list",
  readOnly: true,
  description:
    "Every blockout level in the scene: its storeys, their elevations, how many pieces each holds, and whether the level is showing greybox or its real materials. Read this before adding pieces so they land in the storey you mean.",
  params: {},
  run() {
    requireLevelModule();
    return { levels: describeLevels() };
  },
});

defineOp({
  name: "level.create",
  undoable: true,
  description:
    "Create a blockout level: an entity with a Level component plus its first storey. Grid, storey height and default wall/slab dimensions live on the level, so set them here and every piece drawn afterwards follows.",
  params: {
    name: { type: "string", default: "Level", description: "Entity name." },
    elevation: { type: "number", default: 0, description: "Y of the first storey, in metres." },
    grid: { type: "number", default: 1, description: "Snap step in metres." },
    storeyHeight: { type: "number", default: 3, description: "Distance between storeys, in metres." },
    wallHeight: { type: "number", default: 3, description: "Height of walls drawn in this level." },
    wallThickness: { type: "number", default: 0.2, description: "Thickness of walls drawn in this level." },
    slabThickness: { type: "number", default: 0.2, description: "Thickness of floor slabs." },
    collision: {
      type: "boolean",
      default: true,
      description: "Give every piece a mesh collider so the level is walkable (needs the physics-rapier module).",
    },
  },
  async run(args) {
    requireLevelModule();
    const { CreateEntityCommand } = await import("../../commands/entityCommands.js");
    const { commandBus } = await import("../../commands/CommandBus.js");
    const { floorName } = await import("../../levelBuild.js");
    const { setActiveLevel } = await import("../../levelTool.js");
    const elevation = args.elevation ?? 0;
    const command = new CreateEntityCommand({
      name: args.name ?? "Level",
      components: [{
        type: "level",
        props: {
          grid: args.grid ?? 1,
          storeyHeight: args.storeyHeight ?? 3,
          wallHeight: args.wallHeight ?? 3,
          wallThickness: args.wallThickness ?? 0.2,
          slabThickness: args.slabThickness ?? 0.2,
          collision: args.collision ?? true,
        },
      }],
      children: [{
        name: floorName(elevation),
        transform: { position: [0, elevation, 0] },
        components: [{ type: "levelfloor", props: {} }],
      }],
    });
    commandBus.execute(command);
    const floorId = engine.getEntity(command.entityId)?.children?.[0]?.id ?? null;
    setActiveLevel(command.entityId, floorId);
    return { entityId: command.entityId, floorId, elevation };
  },
});

defineOp({
  name: "level.addFloor",
  undoable: true,
  description:
    "Add a storey to a level at a given elevation. Pieces parented to it move with it, so raising a storey later carries its walls and slabs along.",
  params: {
    levelId: { type: "string", required: true, description: "Entity id of the Level." },
    elevation: { type: "number", required: true, description: "Y of the new storey, in metres." },
  },
  async run({ levelId, elevation }) {
    requireLevelModule();
    const entity = requireEntity(levelId);
    if (!entity.getComponent("level")) throw new Error(`Entity "${entity.name}" has no Level component.`);
    const { addFloor } = await import("../../levelBuild.js");
    return { entityId: addFloor(levelId, elevation), elevation };
  },
});

defineOp({
  name: "level.addPiece",
  undoable: true,
  description:
    "Add one blockout piece. Two ways to say where: `from`/`to` describes the drag a person would make (a wall runs between the points, a floor spans the rectangle, a stair climbs from the first toward the second), or give `position` + `size` outright. Shapes: floor, wall, stair, ramp, box, column, platform.",
  params: {
    shape: {
      type: "string",
      required: true,
      description: "floor | wall | stair | ramp | box | column | platform",
    },
    from: { type: "array", description: "Drag start [x, y, z] in world space. Y is the storey elevation." },
    to: { type: "array", description: "Drag end [x, y, z]. Omit for a click-place (one grid cell / a column)." },
    position: { type: "array", description: "Explicit world position [x, y, z]; overrides from/to." },
    size: { type: "array", description: "Explicit local size [x, y, z]: X length, Y height, Z depth." },
    rotationY: { type: "number", description: "Yaw in radians, when giving an explicit position." },
    floorId: { type: "string", description: "Storey to parent to. Defaults to the level's storey nearest the elevation." },
    levelId: { type: "string", description: "Level to draw into when there is more than one." },
    steps: { type: "number", description: "Stairs: step count. 0 or omitted derives ~18 cm risers." },
    open: { type: "boolean", description: "Stairs: open treads instead of a solid staircase." },
    sides: { type: "number", description: "Columns: 4 is a square pillar, 8 or more reads as round." },
    color: { type: "string", description: "Hex tint overriding the greybox palette." },
    material: { type: "string", description: "A .mat asset path, shown when the level is in Preview." },
    collision: { type: "boolean", description: "Override the level's collision setting for this piece." },
    name: { type: "string", description: "Entity name. Defaults to the shape's name." },
  },
  async run(args) {
    requireLevelModule();
    const { createPiece } = await import("../../levelBuild.js");
    const { pieceFromDrag } = await import("../../blockoutDraw.js");
    const { getLevelToolSettings, setActiveLevel, getActiveFloorId } = await import("../../levelTool.js");

    if (args.levelId) setActiveLevel(args.levelId, args.floorId ?? null);

    const extras = {};
    for (const key of ["steps", "open", "sides", "color", "material"]) {
      if (args[key] !== undefined) extras[key] = args[key];
    }

    let spec;
    if (args.position && args.size) {
      spec = {
        shape: args.shape,
        position: args.position,
        rotationY: args.rotationY ?? 0,
        size: args.size,
        props: {},
      };
    } else {
      const from = args.from ?? [0, 0, 0];
      const a = { x: from[0], y: from[1] ?? 0, z: from[2] };
      const to = args.to ?? from;
      const b = { x: to[0], y: to[1] ?? a.y, z: to[2] };
      // The level's own settings, not the tool's held-modifier state: an op is
      // not holding Ctrl, and a piece placed by an agent should come out the
      // size the level says walls are.
      spec = pieceFromDrag(args.shape, a, b, { ...getLevelToolSettings(), grid: 0, angleSnap: 0 });
      if (!spec) {
        throw new Error(
          `A ${args.shape} needs a direction — pass both "from" and "to", or give "position" and "size".`,
        );
      }
      if (args.rotationY !== undefined) spec.rotationY = args.rotationY;
      if (args.size) spec.size = args.size;
    }

    const entityId = createPiece({
      shape: spec.shape,
      position: spec.position,
      rotationY: spec.rotationY,
      size: spec.size,
      props: { ...(spec.props ?? {}), ...extras },
      floorId: args.floorId ?? getActiveFloorId(),
      collision: args.collision ?? null,
      name: args.name ?? null,
      select: false,
    });
    const entity = entityId ? engine.getEntity(entityId) : null;
    return {
      entityId,
      shape: spec.shape,
      size: spec.size,
      position: spec.position,
      rotationY: spec.rotationY,
      parentId: entity?.parent?.id ?? null,
    };
  },
});

defineOp({
  name: "level.addOpening",
  undoable: true,
  description:
    "Punch a door, window or arch through a wall piece. `offset` is metres along the wall from its centre, so 0 is the middle and a negative value is toward the wall's -X end.",
  params: {
    entityId: { type: "string", required: true, description: "Entity id of the wall piece." },
    kind: { type: "string", default: "door", description: "door | window | arch — presets for width/height/sill." },
    offset: { type: "number", default: 0, description: "Metres along the wall from its centre." },
    width: { type: "number", description: "Override the preset width." },
    height: { type: "number", description: "Override the preset height." },
    sill: { type: "number", description: "Height of the hole's bottom edge. 0 is a doorway." },
  },
  async run({ entityId, kind = "door", offset = 0, width, height, sill }) {
    requireLevelModule();
    requireEntity(entityId);
    const { addOpening } = await import("../../levelBuild.js");
    const index = addOpening(entityId, { kind, offset, width, height, sill });
    if (index < 0) throw new Error("That entity is not a wall — only walls take openings.");
    const piece = engine.getEntity(entityId).getComponent("blockout");
    return { entityId, index, openings: piece.props.openings };
  },
});

defineOp({
  name: "level.removeOpening",
  undoable: true,
  description: "Remove one opening from a wall by index (see level.addOpening's return, or the piece's `openings` prop).",
  params: {
    entityId: { type: "string", required: true, description: "Entity id of the wall piece." },
    index: { type: "number", required: true, description: "Index into the wall's openings array." },
  },
  async run({ entityId, index }) {
    requireLevelModule();
    requireEntity(entityId);
    const { removeOpening } = await import("../../levelBuild.js");
    if (!removeOpening(entityId, index)) throw new Error(`No opening at index ${index}.`);
    return { entityId, openings: engine.getEntity(entityId).getComponent("blockout").props.openings };
  },
});

defineOp({
  name: "level.addColliders",
  undoable: true,
  description:
    "Give every piece in a level a mesh collider, skipping those that already have one. The fix for a level drawn before the physics module was enabled, or with the level's Collision switch off — a level without colliders is scenery the player falls through.",
  params: {
    levelId: { type: "string", required: true, description: "Entity id of the Level." },
  },
  async run({ levelId }) {
    requireLevelModule();
    requireEntity(levelId);
    const { addCollidersToLevel } = await import("../../levelBuild.js");
    const result = addCollidersToLevel(levelId);
    if (!result.physics) {
      throw new Error(
        'The "physics-rapier" module is not enabled, so there is no Collider component to add. Enable it with module.setEnabled.',
      );
    }
    return result;
  },
});

defineOp({
  name: "level.setPreview",
  undoable: true,
  description:
    "Switch a level between the greybox palette and the materials assigned to its pieces. Preview on is what a walkthrough looks like; off is what the blockout reads as.",
  params: {
    levelId: { type: "string", required: true, description: "Entity id of the Level." },
    preview: { type: "boolean", required: true, description: "true = real materials, false = greybox." },
  },
  async run({ levelId, preview }) {
    requireLevelModule();
    requireEntity(levelId);
    const { commandBus } = await import("../../commands/CommandBus.js");
    const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
    commandBus.execute(new SetComponentPropCommand(levelId, "level", "preview", !!preview, "Toggle preview"));
    return { levelId, preview: !!preview };
  },
});

defineOp({
  name: "level.setTool",
  description:
    "Arm (or disarm) the viewport's blockout tools and point them at a level, storey and elevation — the handoff for 'I have built the shell, you carry on drawing'. Pass tool: null to disarm.",
  params: {
    tool: {
      type: "string",
      description: "select | floor | wall | stair | ramp | box | column | platform | opening | erase. Omit or pass an empty string to disarm.",
    },
    levelId: { type: "string", description: "Level to draw into." },
    floorId: { type: "string", description: "Storey to draw into." },
    elevation: { type: "number", description: "Elevation to draw at, when not naming a storey." },
    grid: { type: "number", description: "Snap step in metres." },
  },
  async run({ tool, levelId, floorId, elevation, grid }) {
    requireLevelModule();
    const levelTool = await import("../../levelTool.js");
    if (levelId || floorId) levelTool.setActiveLevel(levelId ?? levelTool.getActiveLevelId(), floorId ?? null);
    if (elevation !== undefined) levelTool.setDrawElevation(elevation);
    if (grid !== undefined) levelTool.setLevelToolSetting("grid", grid);
    if (tool === undefined) {
      // Nothing said about the tool: this was a "point it there" call.
    } else if (!tool) {
      levelTool.disarmLevelTool();
    } else {
      levelTool.armLevelTool(tool);
    }
    return {
      tool: levelTool.getLevelTool(),
      levelId: levelTool.getActiveLevelId(),
      floorId: levelTool.getActiveFloorId(),
      elevation: levelTool.getDrawElevation(),
      settings: { ...levelTool.getLevelToolSettings() },
    };
  },
});
