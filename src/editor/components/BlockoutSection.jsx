import { useEffect, useState } from "react";
import { DoorOpen, Plus, Trash2 } from "lucide-react";
import { engine } from "../engineInstance.js";
import { addOpening, removeOpening } from "../levelBuild.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { OPENING_PRESETS } from "../../modules/level-design/blockoutGeometry.js";

/**
 * The Blockout inspector's extra half: the openings on a wall, and the piece's
 * real-world dimensions.
 *
 * Openings are an array prop, so the generic schema-driven inspector cannot
 * show them — and they are the one part of a blockout that people tune by
 * number rather than by dragging ("that door is 90 cm, this one is 110"). The
 * viewport tool puts them roughly where you click; this is where they become
 * exact.
 */

function NumberCell({ value, step = 0.05, min, onCommit, title }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number.parseFloat(text);
    if (Number.isFinite(next)) onCommit(min !== undefined ? Math.max(min, next) : next);
    else setText(String(value));
  };
  return (
    <input
      className="number-field blockout-opening-number"
      type="number"
      step={step}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          setText(String(value));
          e.target.blur();
        }
      }}
    />
  );
}

export function BlockoutSection({ entityId, props }) {
  const [, bump] = useState(0);
  const piece = engine.getEntity(entityId)?.getComponent?.("blockout");
  if (!piece) return null;

  const [sx, sy, sz] = props.size ?? [1, 1, 1];
  const openings = props.openings ?? [];
  const isWall = props.shape === "wall";

  const setOpening = (index, key, value) => {
    const next = openings.map((opening, i) => (i === index ? { ...opening, [key]: value } : opening));
    commandBus.execute(new SetComponentPropCommand(entityId, "blockout", "openings", next, "Edit opening"));
    bump((n) => n + 1);
  };

  return (
    <div className="blockout-section">
      <div className="field-row">
        <span className="field-label">Footprint</span>
        <span className="blockout-readout">
          {`${sx.toFixed(2)} × ${sz.toFixed(2)} m · ${(props.shape === "floor" || props.shape === "platform"
            ? sx * sz
            : sx * sy).toFixed(2)} m²`}
        </span>
      </div>

      {isWall && (
        <>
          <div className="field-row">
            <span className="field-label">Openings</span>
            <div className="blockout-opening-add">
              {Object.keys(OPENING_PRESETS).map((kind) => (
                <button
                  key={kind}
                  className="toolbar-btn icon-only"
                  title={`Add a ${kind}`}
                  onClick={() => {
                    addOpening(entityId, { kind });
                    bump((n) => n + 1);
                  }}
                >
                  {kind === "door" ? <DoorOpen size={13} /> : <Plus size={13} />}
                  <span className="blockout-opening-kind">{kind}</span>
                </button>
              ))}
            </div>
          </div>

          {!openings.length && (
            <div className="level-empty">Solid wall. Add a door or window, or use the Opening tool (8).</div>
          )}

          {openings.length > 0 && (
            <div className="blockout-opening-head">
              <span>Offset</span>
              <span>Width</span>
              <span>Height</span>
              <span>Sill</span>
              <span />
            </div>
          )}

          {openings.map((opening, index) => (
            <div className="blockout-opening-row" key={index}>
              <NumberCell
                value={opening.offset}
                title="Metres from the wall's centre"
                onCommit={(v) => setOpening(index, "offset", v)}
              />
              <NumberCell value={opening.width} min={0.01} onCommit={(v) => setOpening(index, "width", v)} />
              <NumberCell value={opening.height} min={0.01} onCommit={(v) => setOpening(index, "height", v)} />
              <NumberCell
                value={opening.sill}
                min={0}
                title="Height of the hole's bottom edge — 0 is a doorway"
                onCommit={(v) => setOpening(index, "sill", v)}
              />
              <button
                className="icon-btn danger"
                title="Remove this opening"
                onClick={() => {
                  removeOpening(entityId, index);
                  bump((n) => n + 1);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
