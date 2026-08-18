import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";

/**
 * Armed state for the level blockout tools — the same module-level store
 * pattern as `terrainBrush.js`, for the same reason: the viewport's pointer
 * handlers and the React toolbar both need it, and neither owns the other.
 *
 * ## Where the settings actually live
 *
 * Grid size, storey height and the default wall dimensions belong to the
 * LEVEL (see LevelComponent) — they are how this level is built, not how this
 * user likes to work, and they must survive a reload and reach a teammate.
 * So this store is a *mirror*: activating a level pulls its numbers in, and
 * changing one here writes back through the command bus so it is undoable and
 * saved. Before any level exists the mirror holds the defaults a new level
 * will be created with, which is what lets the toolbar be usable on an empty
 * scene.
 */

const TOOLS = ["select", "floor", "wall", "stair", "ramp", "box", "column", "platform", "opening", "erase"];

/** Tools that draw a new piece by dragging out its footprint. */
export const DRAW_TOOLS = new Set(["floor", "wall", "stair", "ramp", "box", "column", "platform"]);

let tool = null; // null = the tool is not armed at all; "select" = armed but picking
let levelId = null;
let floorId = null;
/** Draw elevation in world Y. Mirrors the active storey; editable on its own
 *  so a mezzanine can be drawn without creating a storey for it first. */
let elevation = 0;
/** Held-Ctrl override. The reference blockout tools all use "hold to disable
 *  snapping" rather than a mode, because you want it for one piece, not for
 *  the next twenty. */
let snapSuspended = false;

const settings = {
  grid: 1,
  angleSnap: 15,
  storeyHeight: 3,
  wallHeight: 3,
  wallThickness: 0.2,
  slabThickness: 0.2,
  stairWidth: 1.4,
  collision: true,
  /** How far a ramp climbs over its drag. Stairs use the storey height (they
   *  connect floors); a ramp is usually a kerb or a platform approach. */
  rampRise: 1,
  /** Column cross-section: 4 = square pillar, 8/16 read as round. */
  columnSides: 4,
  /** What the Opening tool punches: "door" | "window" | "arch". */
  opening: "door",
  /** Stairs/ramps: flip which way the drag climbs. */
  descend: false,
  /** Stairs: open treads. */
  openTreads: false,
};

/** Level props this store mirrors, and the prop each setting maps to. */
const MIRRORED = ["grid", "angleSnap", "storeyHeight", "wallHeight", "wallThickness", "slabThickness", "stairWidth", "collision"];

const listeners = new Set();
function notify() {
  for (const cb of listeners) cb();
}

export function subscribeLevelTool(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLevelTool() {
  return tool;
}

export function armLevelTool(next) {
  tool = TOOLS.includes(next) ? next : null;
  notify();
}

export function disarmLevelTool() {
  if (tool === null) return false;
  tool = null;
  snapSuspended = false;
  notify();
  return true;
}

export function getLevelToolSettings() {
  return settings;
}

/**
 * Changes one setting. Mirrored settings are written to the active Level so
 * they persist with the scene; the rest (which opening, which direction) are
 * gestures, not level data, and stay here.
 */
export function setLevelToolSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  const level = getActiveLevelComponent();
  if (level && MIRRORED.includes(key) && level.props[key] !== value) {
    commandBus.execute(new SetComponentPropCommand(levelId, "level", key, value));
  }
  notify();
}

export function getActiveLevelId() {
  return levelId;
}

export function getActiveFloorId() {
  return floorId;
}

export function getDrawElevation() {
  return elevation;
}

export function setDrawElevation(value) {
  const next = Number.isFinite(value) ? value : 0;
  if (elevation === next) return;
  elevation = next;
  notify();
}

export function isSnapSuspended() {
  return snapSuspended;
}

export function setSnapSuspended(value) {
  if (snapSuspended === !!value) return;
  snapSuspended = !!value;
  notify();
}

/** Grid step in metres, honouring the held-Ctrl override. 0 = free placement. */
export function activeGrid() {
  return snapSuspended ? 0 : Math.max(0, settings.grid);
}

/** Angle step in degrees, honouring the held-Ctrl override. */
export function activeAngleSnap() {
  return snapSuspended ? 0 : Math.max(0, settings.angleSnap);
}

/** The live LevelComponent of the active level, or null. */
export function getActiveLevelComponent() {
  return levelId ? engine.getEntity(levelId)?.getComponent?.("level") ?? null : null;
}

/* -------------------------------------------------------------------------- */
/* Following the undo stack                                                    */
/* -------------------------------------------------------------------------- */

/** Torn down and re-made whenever the active level changes. */
let unwatch = null;
/** A level the tool was pointed at that undo removed — re-adopted if redo
 *  brings it back (commands restore entities under their original ids). */
let lostLevelId = null;

/**
 * Re-reads the mirrored settings from the Level component.
 *
 * This is what makes Ctrl+Z reach the toolbar. Grid size and storey height are
 * written to the level through the command bus, so undo puts the OLD value back
 * on the component — and without this the toolbar would keep showing (and
 * drawing with) the value that was just undone, which reads as "undo didn't
 * work" while quietly being worse than that.
 */
function pullSettings() {
  const level = getActiveLevelComponent();
  if (!level) return;
  let changed = false;
  for (const key of MIRRORED) {
    if (settings[key] === level.props[key]) continue;
    settings[key] = level.props[key];
    changed = true;
  }
  if (changed) notify();
}

/** Subscribes to the engine so the tool follows undo/redo of its own level. */
function watchActiveLevel() {
  unwatch?.();
  unwatch = null;
  try {
    const offProp = engine.on("component-changed", (info) => {
      if (info?.entityId === levelId && info?.componentType === "level") pullSettings();
    });
    const offTree = engine.on("hierarchy-changed", () => {
      validateActiveLevel();
      // Redo re-instantiates the serialized tree under the SAME ids, so a level
      // undone and redone can be re-adopted rather than leaving the tool
      // pointed at nothing (and silently creating a second level on the next
      // click).
      if (lostLevelId && engine.getEntity(lostLevelId)?.getComponent?.("level")) {
        const recovered = lostLevelId;
        lostLevelId = null;
        setActiveLevel(recovered);
      }
    });
    unwatch = () => {
      offProp?.();
      offTree?.();
    };
  } catch {
    // The engine has not booted yet (a store read during editor start-up).
    // The next setActiveLevel re-tries, and nothing before then can mutate a
    // level that does not exist.
  }
}

/** The live LevelFloorComponent of the active storey, or null. */
export function getActiveFloorComponent() {
  return floorId ? engine.getEntity(floorId)?.getComponent?.("levelfloor") ?? null : null;
}

/**
 * Points the tool at a level (and optionally one of its storeys), pulling the
 * level's own settings into the mirror. Passing null for the floor picks the
 * storey nearest the current draw elevation, which is what makes clicking a
 * level in the hierarchy enough to keep drawing where you left off.
 */
export function setActiveLevel(nextLevelId, nextFloorId = null) {
  levelId = nextLevelId ?? null;
  if (levelId) lostLevelId = null;
  watchActiveLevel();
  const level = getActiveLevelComponent();
  if (level) for (const key of MIRRORED) settings[key] = level.props[key];

  let floorEntity = nextFloorId ? engine.getEntity(nextFloorId) : null;
  if (!floorEntity?.getComponent?.("levelfloor")) floorEntity = level?.floorAt(elevation) ?? null;
  floorId = floorEntity?.id ?? null;
  if (floorEntity) elevation = floorEntity.object3D.position.y;
  notify();
}

export function setActiveFloor(nextFloorId) {
  const entity = nextFloorId ? engine.getEntity(nextFloorId) : null;
  if (!entity?.getComponent?.("levelfloor")) return false;
  floorId = entity.id;
  elevation = entity.object3D.position.y;
  // A storey implies its level, so selecting one in the hierarchy re-targets
  // both — otherwise pieces would be drawn into another level's storey.
  let node = entity.parent;
  while (node) {
    if (node.getComponent?.("level")) {
      if (node.id !== levelId) setActiveLevel(node.id, entity.id);
      break;
    }
    node = node.parent;
  }
  notify();
  return true;
}

/**
 * Re-derives the active level/storey from a selected entity. Called when the
 * selection changes: selecting any piece of a level should make that level the
 * one you are drawing into, because the alternative — drawing into whichever
 * level you last touched — puts walls in another building with no warning.
 */
export function syncActiveFromEntity(entityId) {
  let node = entityId ? engine.getEntity(entityId) : null;
  let floorEntity = null;
  while (node) {
    if (!floorEntity && node.getComponent?.("levelfloor")) floorEntity = node;
    const level = node.getComponent?.("level");
    if (level) {
      setActiveLevel(node.id, floorEntity?.id ?? null);
      return true;
    }
    node = node.parent;
  }
  return false;
}

/** Drops the active target when its entity is gone (deleted, or a scene
 *  swapped underneath us). Cheap enough to call from the tool's hot paths. */
export function validateActiveLevel() {
  if (levelId && !engine.getEntity(levelId)) {
    lostLevelId = levelId;
    levelId = null;
    floorId = null;
    notify();
    return;
  }
  if (floorId && !engine.getEntity(floorId)) {
    floorId = null;
    notify();
  }
}

/**
 * Storey-relative elevation stepping — the U / J keys in every blockout tool.
 * Moves to the next existing storey in that direction when there is one, and
 * otherwise steps by the storey height, so the first press of J on the ground
 * floor takes you to a basement rather than doing nothing.
 */
export function stepElevation(direction) {
  const level = getActiveLevelComponent();
  const step = settings.storeyHeight || 3;
  const floors = level?.floors() ?? [];
  const ordered = direction > 0 ? floors : [...floors].reverse();
  const next = ordered.find((floor) => direction * (floor.object3D.position.y - elevation) > 1e-4);
  if (next) {
    setActiveFloor(next.id);
    return elevation;
  }
  setDrawElevation(+(elevation + direction * step).toFixed(4));
  // Off the top of the level: the storey the pieces land on is whichever is
  // nearest, and the tool creates a new one on first use (see levelBuild.js).
  const nearest = level?.floorAt(elevation);
  if (nearest && Math.abs(nearest.object3D.position.y - elevation) < 1e-4) setActiveFloor(nearest.id);
  return elevation;
}

/**
 * Keyboard shortcuts, live only while a level tool is armed so they can never
 * shadow the editor's global keys. Returns true when the event was consumed.
 *
 *   1..8  pick a tool     Esc  disarm     U / J  storey up / down
 *   [ / ]  shrink / grow the grid          O  cycle door / window / arch
 *   Shift+D  flip a stair or ramp's climb direction
 */
export function dispatchLevelToolKey(e) {
  if (!tool || e.metaKey || e.altKey || e.ctrlKey) return false;
  const key = (e.key || "").toLowerCase();
  const picks = ["select", "floor", "wall", "stair", "ramp", "box", "column", "opening"];
  const index = Number.parseInt(key, 10);
  if (!e.shiftKey && index >= 1 && index <= picks.length) {
    armLevelTool(picks[index - 1]);
    return true;
  }
  if (e.shiftKey && key === "d") {
    setLevelToolSetting("descend", !settings.descend);
    return true;
  }
  if (e.shiftKey) return false;
  switch (key) {
    case "escape":
      return disarmLevelTool();
    case "u":
      stepElevation(1);
      return true;
    case "j":
      stepElevation(-1);
      return true;
    case "[":
      setLevelToolSetting("grid", Math.max(0.05, +(settings.grid / 2).toFixed(3)));
      return true;
    case "]":
      setLevelToolSetting("grid", Math.min(16, +(settings.grid * 2).toFixed(3)));
      return true;
    case "o": {
      const kinds = ["door", "window", "arch"];
      setLevelToolSetting("opening", kinds[(kinds.indexOf(settings.opening) + 1) % kinds.length]);
      return true;
    }
    case "delete":
    case "x":
      armLevelTool("erase");
      return true;
    default:
      return false;
  }
}

export { TOOLS as LEVEL_TOOLS };
