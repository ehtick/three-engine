import { useEffect, useState } from "react";
import { Images, Layers3 } from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { CreateEntityCommand } from "../commands/entityCommands.js";
import { NumberField } from "../fields/NumberField.jsx";

/**
 * LOD group inspector (roadmap item 14).
 *
 * The thresholds are a variable-length list bound to the group's CHILDREN, so
 * the flat key→type schema cannot express them — same reason the line
 * renderer's points get their own section.
 *
 * The live readout is not decoration. Every question an author has about an LOD
 * group is "which level am I looking at, and why" — and the whole point of a
 * good LOD chain is that you cannot tell by looking. Without the measured
 * screen height next to the thresholds, tuning one means guessing, moving the
 * camera, and guessing again.
 */
export function LodSection({ entityId, props }) {
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("lod");

  useEffect(() => {
    // The level is decided in the engine's frame loop, not in React, so nothing
    // here would ever re-render on its own.
    const id = setInterval(() => force((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  if (!component) return null;

  const children = component.levelEntities;
  const thresholds = component.thresholds;
  const active = component.activeLevel;

  const commit = (next) => {
    commandBus.execute(new SetComponentPropCommand(entityId, "lod", "levels", next));
  };

  const setThreshold = (index, value) => {
    const next = thresholds.map((v, i) => (i === index ? value : v));
    commit(next);
  };

  /**
   * Appends a billboard level.
   *
   * It is an ordinary child entity with an Impostor component, because that is
   * all an impostor level is — the group needs no knowledge of it. The button
   * exists because "add a child, add a component, leave Source empty" is three
   * correct steps that read like an incantation, and the last cheap level of a
   * chain is the one everybody wants and nobody remembers how to make.
   */
  const addImpostorLevel = () => {
    const alreadyThere = children.some((child) => child.getComponent?.("impostor"));
    if (alreadyThere) return;
    commandBus.execute(
      new CreateEntityCommand({
        name: `${engine.getEntity(entityId)?.name ?? "LOD"}_Impostor`,
        parentId: entityId,
        // No `source`: an empty one resolves to the first sibling, which is
        // LOD0 — and unlike a stored id it cannot dangle when a level is
        // deleted or the group is duplicated.
        components: [{ type: "impostor", props: {} }],
      }),
    );
  };

  const hasImpostor = children.some((child) => child.getComponent?.("impostor"));

  if (children.length === 0) {
    return (
      <div className="inspector-hint">
        An LOD group's levels are its child entities, finest first. Parent your detail
        meshes under this entity to build the chain.
      </div>
    );
  }

  return (
    <div className="lod-section">
      <div className="field-row">
        <span className="field-label">On screen</span>
        <span className="field-value">
          {/* A forced level short-circuits the measurement, so showing a stale
              number next to it would read as the group being stuck. */}
          {props.forcedLevel >= 0
            ? "— (level forced)"
            : `${(component.coverage * 100).toFixed(1)}% of frame height`}
        </span>
      </div>
      <div className="inspector-subheader">Levels ({children.length})</div>
      {children.map((child, index) => (
        <div className="field-row" key={child.id ?? index}>
          <span className="field-label" title={child.name}>
            {active === index && <Layers3 size={11} style={{ marginRight: 4 }} />}
            LOD{index}
          </span>
          <div style={{ display: "flex", gap: 6, flex: 1, alignItems: "center" }}>
            <NumberField
              value={thresholds[index] ?? 0}
              min={0}
              max={1}
              step={0.01}
              onCommit={(value) => setThreshold(index, value)}
            />
            <span className={active === index ? "field-value ok" : "field-value"}>
              {child.name}
            </span>
          </div>
        </div>
      ))}
      <div className="field-row">
        <span className="field-label">Culled</span>
        <span className={active === -1 ? "field-value warn" : "field-value"}>
          {thresholds[thresholds.length - 1] > 0
            ? `below ${(thresholds[thresholds.length - 1] * 100).toFixed(1)}%`
            : "never"}
        </span>
      </div>
      <div className="field-row">
        <span className="field-label" />
        <button
          className="toolbar-btn"
          title="Add a billboard level that stands in for the whole prop"
          onClick={addImpostorLevel}
          disabled={hasImpostor}
        >
          <Images size={12} /> {hasImpostor ? "Impostor level added" : "Add impostor level"}
        </button>
      </div>
      <div className="inspector-hint">
        Each number is the smallest share of the frame's height at which that level is
        still used. Set the last one to 0 to keep the group drawing at any distance.
      </div>
    </div>
  );
}
