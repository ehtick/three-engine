import { useEffect, useState } from "react";
import { Lock, LockOpen, Pencil, Plus, ShieldPlus, Trash2 } from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { DeleteEntityCommand } from "../commands/entityCommands.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { addCollidersToLevel, addFloor, physicsAvailable } from "../levelBuild.js";
import {
  armLevelTool,
  getActiveFloorId,
  setActiveFloor,
  setActiveLevel,
  subscribeLevelTool,
} from "../levelTool.js";

/**
 * The Level inspector: the storeys, and the two actions that are awkward
 * anywhere else.
 *
 * A storey list rather than "look for the child entities in the hierarchy",
 * because which storey the tools draw into is a *mode* — the one piece of
 * blockout state that has no visual until you place something in the wrong
 * place. Showing the list here, with the active one marked, is what makes that
 * mode visible while you are editing the level's other settings.
 */
export function LevelSection({ entityId }) {
  const [, bump] = useState(0);
  useEffect(() => subscribeLevelTool(() => bump((n) => n + 1)), []);
  const entity = engine.getEntity(entityId);
  const level = entity?.getComponent?.("level");
  if (!level) return null;

  const floors = level.floors();
  const activeFloorId = getActiveFloorId();
  const pieceCount = level.pieces().length;
  const storeyHeight = level.props.storeyHeight || 3;
  const topElevation = floors.length ? floors[floors.length - 1].object3D.position.y : 0;

  const startDrawing = (floorId) => {
    setActiveLevel(entityId, floorId ?? null);
    armLevelTool("floor");
  };

  return (
    <div className="level-section">
      <div className="field-row">
        <span className="field-label">Storeys</span>
        <button
          className="toolbar-btn icon-only"
          title={`Add a storey at ${(topElevation + storeyHeight).toFixed(2)} m`}
          onClick={() => {
            const id = addFloor(entityId, +(topElevation + storeyHeight).toFixed(4));
            setActiveFloor(id);
          }}
        >
          <Plus size={13} />
        </button>
      </div>

      {!floors.length && <div className="level-empty">No storeys yet — draw something, or add one above.</div>}

      <div className="level-floor-list">
        {floors.map((floor) => {
          const component = floor.getComponent("levelfloor");
          const active = floor.id === activeFloorId;
          return (
            <div
              key={floor.id}
              className={`level-floor-row ${active ? "active" : ""}`}
              onClick={() => setActiveFloor(floor.id)}
              title="Click to draw into this storey"
            >
              <span className="level-floor-name">{floor.name}</span>
              <span className="level-floor-count">{component?.pieces().length ?? 0}</span>
              <button
                className="icon-btn"
                title={component?.props.locked ? "Unlock" : "Lock — keep the tools out of this storey"}
                onClick={(e) => {
                  e.stopPropagation();
                  commandBus.execute(
                    new SetComponentPropCommand(floor.id, "levelfloor", "locked", !component?.props.locked),
                  );
                  bump((n) => n + 1);
                }}
              >
                {component?.props.locked ? <Lock size={12} /> : <LockOpen size={12} />}
              </button>
              <button
                className="icon-btn"
                title="Select this storey"
                onClick={(e) => {
                  e.stopPropagation();
                  useSelectionStore.getState().select(floor.id);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="icon-btn danger"
                title="Delete this storey and everything on it"
                onClick={(e) => {
                  e.stopPropagation();
                  commandBus.execute(new DeleteEntityCommand(floor.id));
                  bump((n) => n + 1);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="level-section-actions">
        <button className="toolbar-btn wide" onClick={() => startDrawing(activeFloorId)}>
          <Pencil size={13} />
          Draw in this level
        </button>
        <button
          className="toolbar-btn wide"
          disabled={!physicsAvailable() || !pieceCount}
          title={
            physicsAvailable()
              ? "Give every piece a mesh collider so the level is walkable"
              : "Enable the Physics (Rapier) module first"
          }
          onClick={() => {
            const { added } = addCollidersToLevel(entityId);
            bump((n) => n + 1);
            if (!added) console.info("Level: every piece already has a collider.");
          }}
        >
          <ShieldPlus size={13} />
          Add colliders ({pieceCount})
        </button>
      </div>
    </div>
  );
}
