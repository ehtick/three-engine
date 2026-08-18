import { useEffect, useState } from "react";
import {
  Blocks,
  Box,
  Building2,
  ChevronDown,
  ChevronUp,
  Cylinder,
  DoorOpen,
  Eraser,
  Eye,
  MousePointer2,
  Orbit,
  RectangleVertical,
  ShieldPlus,
  Settings2,
  Square,
  TriangleRight,
} from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  armLevelTool,
  disarmLevelTool,
  getActiveFloorComponent,
  getActiveLevelComponent,
  getDrawElevation,
  getLevelTool,
  getLevelToolSettings,
  isSnapSuspended,
  setDrawElevation,
  setLevelToolSetting,
  stepElevation,
  subscribeLevelTool,
} from "../levelTool.js";
import { addCollidersToLevel, ensureLevelAndFloor, physicsAvailable } from "../levelBuild.js";

/**
 * The blockout tool palette, floating over the viewport.
 *
 * It mirrors `levelTool.js` rather than owning state, because the pointer
 * handlers in `blockoutTool.js` read the same store — a React-owned tool would
 * mean the viewport asking a component what it is doing, which is backwards for
 * something driven by the mouse at 120 Hz.
 *
 * ONE row, deliberately. The first version stacked three (shapes, settings, a
 * per-tool hint line) and covered a third of the viewport — the wrong trade for
 * a tool whose whole job is to let you look at what is behind it. So: the
 * shapes, the two numbers that change every few minutes (grid, storey), the
 * greybox/materials switch, and a gear for everything else. The hints did not
 * disappear; they are the buttons' own tooltips.
 */

const TOOL_BUTTONS = [
  { id: "select", label: "Select", Icon: MousePointer2, key: "1" },
  { id: "floor", label: "Floor", Icon: Square, key: "2" },
  { id: "wall", label: "Wall", Icon: RectangleVertical, key: "3" },
  { id: "stair", label: "Stair", Icon: Blocks, key: "4" },
  { id: "ramp", label: "Ramp", Icon: TriangleRight, key: "5" },
  { id: "box", label: "Box", Icon: Box, key: "6" },
  { id: "column", label: "Column", Icon: Cylinder, key: "7" },
  { id: "opening", label: "Opening", Icon: DoorOpen, key: "8" },
  { id: "erase", label: "Erase", Icon: Eraser, key: "X" },
];

const HINTS = {
  select: "Click pieces to select them — the tools stay armed",
  floor: "Drag a rectangle for a slab, click for one grid cell",
  wall: "Drag from corner to corner. Hold Ctrl for free placement",
  stair: "Drag the direction of travel — it climbs one storey",
  ramp: "Drag the direction of travel",
  box: "Drag a footprint — it stands one wall height tall",
  column: "Click to place, drag out to thicken",
  opening: "Click a wall to punch a door / window / arch (O cycles)",
  erase: "Click a piece to delete it",
};

const GRID_STEPS = [0.25, 0.5, 1, 2, 4];

/**
 * A number field that commits on blur or Enter, not on every keystroke.
 *
 * Two reasons, and the second is the one that matters. Typing "3.25" through an
 * onChange handler momentarily commits 3, then 3.2 — so a level's wall height
 * passes through values nobody asked for. And because these settings are
 * written to the Level through the command bus, each of those keystrokes would
 * be its OWN undo entry: four presses of Ctrl+Z to take back typing one number,
 * with the walls you drew before it still waiting further down the stack.
 *
 * Escape reverts and gives the keyboard back — see `releaseKeyboard`.
 */
function ToolbarNumber({ value, min, step = 0.1, title, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number.parseFloat(text);
    if (Number.isFinite(next)) onCommit(min !== undefined ? Math.max(min, next) : next);
    else setText(String(value));
  };
  return (
    <input
      className="level-toolbar-number"
      type="number"
      step={step}
      min={min}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function useLevelToolState() {
  const [, bump] = useState(0);
  useEffect(() => subscribeLevelTool(() => bump((n) => n + 1)), []);
  return {
    tool: getLevelTool(),
    settings: getLevelToolSettings(),
    elevation: getDrawElevation(),
    level: getActiveLevelComponent(),
    floor: getActiveFloorComponent(),
    suspended: isSnapSuspended(),
  };
}

/** The arm/disarm button that lives in the main viewport toolbar. */
export function LevelToolButton() {
  const { tool } = useLevelToolState();
  return (
    <button
      className={`toolbar-btn icon-only ${tool ? "active" : ""}`}
      title="Level blockout tools (Esc to exit)"
      onClick={() => (tool ? disarmLevelTool() : armLevelTool("floor"))}
    >
      <Building2 size={13} />
    </button>
  );
}

/** The palette itself. Renders nothing while the tool is not armed. */
export function LevelToolbar() {
  const { tool, settings, elevation, level, floor, suspended } = useLevelToolState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Click-away and Escape close the popover. Registered only while it is open,
  // so an armed tool costs no listeners for a panel nobody has opened.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      // Escape while the popover is open closes IT, not the tool — the tool's
      // own Escape handler is on the viewport, which this stops short of.
      if (event.type === "keydown") event.stopPropagation();
      setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
    };
  }, [settingsOpen]);
  if (!tool) return null;

  const levelId = level?.entity?.id ?? null;
  const setPreview = (value) => {
    if (!levelId) return;
    commandBus.execute(new SetComponentPropCommand(levelId, "level", "preview", value, "Toggle preview"));
  };

  /**
   * Hands the keyboard back to the editor after a field is done with it.
   *
   * A focused `input`/`select` owns Ctrl+Z (see keyScope.js — a text field's
   * undo is its own text), so typing a grid size and then pressing Ctrl+Z used
   * to undo nothing at all: the walls stayed, the field ate the chord, and
   * there was no way to tell from the screen. Blurring on commit means the
   * chord reaches the command bus, which is where the user was aiming it.
   */
  const releaseKeyboard = (event) => event.currentTarget.blur();

  const storeyLabel = floor?.entity?.name?.replace(/^Floor\s*/, "") ?? `${elevation.toFixed(2)}m`;

  return (
    <div className="level-toolbar">
      {TOOL_BUTTONS.map(({ id, label, Icon, key }) => (
        <button
          key={id}
          className={`toolbar-btn icon-only ${tool === id ? "active" : ""}`}
          title={`${label} (${key}) — ${HINTS[id]}`}
          onClick={() => armLevelTool(id)}
        >
          <Icon size={13} />
        </button>
      ))}

      <span className="level-toolbar-divider" />

      {/* Grid and storey are the two numbers that change every few minutes, so
          they stay on the bar. Everything else lives behind the gear — a
          palette that covers a third of the viewport is worse than one extra
          click on the settings you touch once a session. */}
      <select
        className="level-toolbar-select"
        value={GRID_STEPS.includes(settings.grid) ? settings.grid : "custom"}
        onChange={(e) => {
          setLevelToolSetting("grid", Number.parseFloat(e.target.value));
          releaseKeyboard(e);
        }}
        title={`Grid snap — hold Ctrl to place freely${suspended ? " (held)" : ""}. [ and ] halve / double it`}
      >
        {GRID_STEPS.map((step) => (
          <option key={step} value={step}>{`${step} m`}</option>
        ))}
        {!GRID_STEPS.includes(settings.grid) && <option value="custom">{`${settings.grid} m`}</option>}
      </select>

      <div className="level-toolbar-storey" title={`Drawing at ${elevation.toFixed(2)} m — U / J change storey`}>
        <button className="level-toolbar-step" title="Storey down (J)" onClick={() => stepElevation(-1)}>
          <ChevronDown size={12} />
        </button>
        <span className={`level-toolbar-storey-label ${level ? "" : "muted"}`}>{storeyLabel}</span>
        <button className="level-toolbar-step" title="Storey up (U)" onClick={() => stepElevation(1)}>
          <ChevronUp size={12} />
        </button>
      </div>

      <span className="level-toolbar-divider" />

      <button
        className={`toolbar-btn icon-only ${level?.props.preview ? "active" : ""}`}
        title={level ? "Preview assigned materials instead of the greybox palette" : "Draw something first"}
        disabled={!level}
        onClick={() => setPreview(!level?.props.preview)}
      >
        <Eye size={13} />
      </button>

      {/* The one thing that was genuinely unguessable: the left button draws, so
          the button that normally orbits is taken. Small, muted, and it earns
          its width — without it the tool reads as "the camera is stuck". */}
      <span
        className="level-toolbar-nav"
        title="The left button draws. Alt-drag — or middle-drag — orbits the camera; right-drag pans, wheel zooms."
      >
        <Orbit size={11} />
        alt-drag
      </span>

      <div className="level-toolbar-more">
        <button
          className={`toolbar-btn icon-only ${settingsOpen ? "active" : ""}`}
          title="Level settings"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings2 size={13} />
        </button>
        {settingsOpen && (
          <div className="level-toolbar-popover" onPointerDown={(e) => e.stopPropagation()}>
            <label className="level-toolbar-field">
              <span>Wall height</span>
              <ToolbarNumber
                value={settings.wallHeight}
                min={0.1}
                onCommit={(next) => setLevelToolSetting("wallHeight", next)}
              />
            </label>
            <label className="level-toolbar-field">
              <span>Wall thickness</span>
              <ToolbarNumber
                value={settings.wallThickness}
                min={0.01}
                step={0.05}
                onCommit={(next) => setLevelToolSetting("wallThickness", next)}
              />
            </label>
            <label className="level-toolbar-field">
              <span>Slab thickness</span>
              <ToolbarNumber
                value={settings.slabThickness}
                min={0.01}
                step={0.05}
                onCommit={(next) => setLevelToolSetting("slabThickness", next)}
              />
            </label>
            <label className="level-toolbar-field">
              <span>Storey height</span>
              <ToolbarNumber
                value={settings.storeyHeight}
                min={0.1}
                onCommit={(next) => setLevelToolSetting("storeyHeight", next)}
              />
            </label>
            <label className="level-toolbar-field">
              <span>Stair width</span>
              <ToolbarNumber
                value={settings.stairWidth}
                min={0.1}
                onCommit={(next) => setLevelToolSetting("stairWidth", next)}
              />
            </label>
            <button
              className="toolbar-btn wide"
              disabled={!physicsAvailable()}
              title={
                physicsAvailable()
                  ? "Give every piece in this level a collider"
                  : "Enable the Physics (Rapier) module to make the level walkable"
              }
              onClick={() => {
                const id = levelId ?? ensureLevelAndFloor(elevation).levelId;
                const { added } = addCollidersToLevel(id);
                if (!added) console.info("Level: every piece already has a collider.");
                setSettingsOpen(false);
              }}
            >
              <ShieldPlus size={13} />
              Add colliders
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** True when the level-design module is on for this project — the gate for
 *  showing the arm button at all. Read from the live engine rather than the
 *  modules store so it is usable from non-React callers too. */
export function levelModuleEnabled() {
  return !!engine?.modules?.has?.("level-design");
}
