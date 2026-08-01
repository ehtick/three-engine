import { useEffect, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Stamp } from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { NumberField } from "../fields/NumberField.jsx";

/**
 * Inspector sections for the gameplay VFX components (roadmap item 13).
 *
 * The line renderer's points are a variable-length list of vectors, which the
 * flat key→type schema cannot express, so they get an explicit editor here —
 * the same reason SoundComponent's entries do. Every mutation goes through
 * `SetComponentPropCommand` on the whole `points` array, so one drag of one
 * axis is one undo step rather than a partial edit nobody can back out of.
 */
export function LinePointsSection({ entityId, props }) {
  const points = Array.isArray(props.points) ? props.points : [];

  const commit = (next) => {
    commandBus.execute(new SetComponentPropCommand(entityId, "line", "points", next));
  };

  const setAxis = (index, axis, value) => {
    const next = points.map((point, i) =>
      i === index ? point.map((v, a) => (a === axis ? value : v)) : point,
    );
    commit(next);
  };

  const addPoint = () => {
    // A new point continues the line rather than landing on top of the last
    // one: a duplicate has no direction, so the strip it adds is invisible and
    // the button looks broken.
    const last = points[points.length - 1] ?? [0, 0, 0];
    const previous = points[points.length - 2] ?? [last[0], last[1], last[2] - 1];
    const next = [
      ...points,
      [last[0] + (last[0] - previous[0]), last[1] + (last[1] - previous[1]), last[2] + (last[2] - previous[2])],
    ];
    commit(next);
  };

  const removePoint = (index) => commit(points.filter((_, i) => i !== index));

  const movePoint = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= points.length) return;
    const next = [...points];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <div className="line-points-section">
      <div className="inspector-subheader">Points ({points.length})</div>
      {points.map((point, index) => (
        <div className="field-row" key={index}>
          <span className="field-label">{index}</span>
          <div style={{ display: "flex", gap: 4, flex: 1, alignItems: "center" }}>
            {[0, 1, 2].map((axis) => (
              <NumberField
                key={axis}
                value={point[axis] ?? 0}
                step={0.1}
                onCommit={(value) => setAxis(index, axis, value)}
              />
            ))}
            <button className="toolbar-btn" title="Move up" onClick={() => movePoint(index, -1)}>
              <ArrowUp size={12} />
            </button>
            <button className="toolbar-btn" title="Move down" onClick={() => movePoint(index, 1)}>
              <ArrowDown size={12} />
            </button>
            <button className="toolbar-btn" title="Remove point" onClick={() => removePoint(index)}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
      <div className="field-row">
        <span className="field-label" />
        <button className="toolbar-btn" onClick={addPoint} title="Append a point, continuing the line">
          <Plus size={12} /> Add Point
        </button>
      </div>
      {points.length < 2 && (
        <div className="inspector-hint">A line needs at least two points to draw.</div>
      )}
    </div>
  );
}

/**
 * Decal section: what the projection actually found.
 *
 * A decal that hits nothing renders nothing, and the box gizmo alone doesn't
 * say whether the miss was geometric (the box does not reach the wall) or a
 * filter (max angle, target tag, a skinned mesh it will never project onto).
 * The triangle count answers that in one number.
 */
export function DecalSection({ entityId }) {
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("decal");
  useEffect(() => {
    // The bake is deferred to the next frame, so a count read straight after a
    // prop edit would always be one edit stale.
    const id = setInterval(() => force((v) => v + 1), 400);
    return () => clearInterval(id);
  }, []);
  if (!component) return null;

  const triangles = component.triangleCount;
  return (
    <div className="decal-section">
      <div className="field-row">
        <span className="field-label">Projected</span>
        <span className={triangles > 0 ? "field-value ok" : "field-value warn"}>
          {triangles > 0 ? `${triangles} triangles` : "nothing in range"}
        </span>
      </div>
      <div className="field-row">
        <span className="field-label" />
        <button
          className="toolbar-btn"
          title="Re-project against the current geometry"
          onClick={() => {
            component.project();
            force((v) => v + 1);
          }}
        >
          <Stamp size={12} /> Rebake
        </button>
      </div>
      <div className="inspector-hint">
        Projects along -Z onto the geometry inside its box. Skinned meshes are skipped.
      </div>
    </div>
  );
}

/** Trail section: a Clear button, because a trail recorded while dragging the
 *  object around the editor otherwise hangs there until it ages out. */
export function TrailSection({ entityId }) {
  const component = engine.getEntity(entityId)?.getComponent?.("trail");
  if (!component) return null;
  return (
    <div className="field-row">
      <span className="field-label" />
      <button className="toolbar-btn" title="Drop the recorded trail" onClick={() => component.clear()}>
        <Trash2 size={12} /> Clear Trail
      </button>
    </div>
  );
}
