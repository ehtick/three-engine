import { useEffect, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Pencil, Crosshair } from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { NumberField } from "../fields/NumberField.jsx";
import { normalizeKnot } from "../../engine/spline/splineMath.js";
import { getSplineEdit, selectKnot, setSplineEditArmed, subscribeSplineEdit } from "../splineEditing.js";

/**
 * Spline inspector (roadmap item 16).
 *
 * The knot list is here because a variable-length array of vectors cannot be
 * expressed in the flat key→type schema — the same reason the line renderer's
 * points and the LOD group's thresholds have their own sections.
 *
 * It is deliberately NOT the primary way to author a path. Typing coordinates
 * is how you nudge one knot by 5cm or read what you have; laying a road is a
 * viewport job, which is what the Edit button arms. The list exists so the two
 * stay in sync: clicking a row selects that knot in the viewport, and dragging
 * in the viewport updates the row.
 */
export function SplineSection({ entityId, props }) {
  const [edit, setEdit] = useState(getSplineEdit);
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("spline");

  useEffect(() => subscribeSplineEdit(setEdit), []);
  useEffect(() => {
    // The length is recomputed in the engine when a knot is dragged in the
    // viewport, which React has no way of hearing about.
    const id = setInterval(() => force((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  // Arming edit mode is a viewport affordance, so it must not survive the panel
  // going away — an armed mode with no visible control is a stuck editor.
  useEffect(() => () => setSplineEditArmed(false), []);

  const knots = (Array.isArray(props.knots) ? props.knots : []).map((k) => normalizeKnot(k));

  const commit = (next, label) => {
    commandBus.execute(new SetComponentPropCommand(entityId, "spline", "knots", next, label));
  };

  const setAxis = (index, axis, value) => {
    commit(
      knots.map((knot, i) =>
        i === index ? { ...knot, position: knot.position.map((v, a) => (a === axis ? value : v)) } : knot,
      ),
      "Move knot",
    );
  };

  const setRoll = (index, value) => {
    commit(knots.map((knot, i) => (i === index ? { ...knot, roll: value } : knot)), "Set knot roll");
  };

  const addKnot = () => {
    // Continue the path rather than stacking a duplicate on the last knot: two
    // knots in the same place have no direction between them, so the curve
    // doesn't change and the button looks broken.
    const last = knots[knots.length - 1];
    const previous = knots[knots.length - 2];
    const step = last && previous
      ? last.position.map((v, i) => v - previous.position[i])
      : [0, 0, 2];
    const position = last ? last.position.map((v, i) => v + step[i]) : [0, 0, 0];
    commit([...knots, { ...normalizeKnot({ position }), handleIn: step.map((v) => -v / 3), handleOut: step.map((v) => v / 3) }], "Add knot");
    selectKnot(knots.length, null);
  };

  const removeKnot = (index) => {
    if (knots.length <= 2) return;
    commit(knots.filter((_, i) => i !== index), "Remove knot");
    selectKnot(-1);
  };

  const moveKnot = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= knots.length) return;
    const next = [...knots];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next, "Reorder knots");
  };

  const armed = edit.armed;
  const selected = edit.selection?.knot ?? -1;

  return (
    <div className="spline-section">
      <div className="field-row">
        <span className="field-label">Edit</span>
        <button
          className={`toolbar-btn${armed ? " active" : ""}`}
          onClick={() => setSplineEditArmed(!armed)}
          title="Edit knots in the viewport — drag to move, Ctrl+click the curve to insert, Shift+click to extend, X to delete"
        >
          <Pencil size={12} /> {armed ? "Editing" : "Edit Path"}
        </button>
      </div>
      {armed && (
        <div className="inspector-hint">
          Drag a knot to move it · Ctrl+click the curve to insert · Shift+click to extend the
          path onto a surface · X deletes the selected knot
        </div>
      )}
      <div className="field-row">
        <span className="field-label">Length</span>
        <span className="field-value">{(component?.length ?? 0).toFixed(2)}</span>
      </div>

      <div className="inspector-subheader">Knots ({knots.length})</div>
      {knots.map((knot, index) => (
        <div className="field-row" key={index}>
          <button
            className={`toolbar-btn${selected === index ? " active" : ""}`}
            title="Select this knot in the viewport"
            onClick={() => {
              setSplineEditArmed(true);
              selectKnot(index, null);
            }}
          >
            <Crosshair size={12} /> {index}
          </button>
          <div style={{ display: "flex", gap: 4, flex: 1, alignItems: "center" }}>
            {[0, 1, 2].map((axis) => (
              <NumberField
                key={axis}
                value={knot.position[axis] ?? 0}
                step={0.1}
                onCommit={(value) => setAxis(index, axis, value)}
              />
            ))}
            <NumberField
              value={knot.roll ?? 0}
              step={1}
              title="Bank angle in degrees"
              onCommit={(value) => setRoll(index, value)}
            />
            <button className="toolbar-btn" title="Move up" onClick={() => moveKnot(index, -1)}>
              <ArrowUp size={12} />
            </button>
            <button className="toolbar-btn" title="Move down" onClick={() => moveKnot(index, 1)}>
              <ArrowDown size={12} />
            </button>
            <button
              className="toolbar-btn"
              title={knots.length <= 2 ? "A path needs at least two knots" : "Remove knot"}
              disabled={knots.length <= 2}
              onClick={() => removeKnot(index)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
      <div className="field-row">
        <span className="field-label" />
        <button className="toolbar-btn" onClick={addKnot} title="Append a knot, continuing the path">
          <Plus size={12} /> Add Knot
        </button>
      </div>
    </div>
  );
}

/**
 * Spline mesh readout: how much geometry the sweep actually produced.
 *
 * A road that is missing tells you nothing about why — no path, a path with one
 * knot, a density of zero and a profile of zero width all look identical
 * (nothing on screen). One triangle count separates "swept nothing" from
 * "swept something you cannot see".
 */
export function SplineMeshSection({ entityId }) {
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("splineMesh");
  useEffect(() => {
    // The rebuild is deferred to the next frame, so a count read straight after
    // a prop edit would always be one edit stale.
    const id = setInterval(() => force((v) => v + 1), 400);
    return () => clearInterval(id);
  }, []);
  if (!component) return null;
  const triangles = component.triangleCount;
  return (
    <div className="field-row">
      <span className="field-label">Swept</span>
      <span className={triangles > 0 ? "field-value ok" : "field-value warn"}>
        {triangles > 0 ? `${triangles} triangles` : "no path to sweep"}
      </span>
    </div>
  );
}

/** Follower readout: where on the path this thing is, live, while playing. */
export function SplineFollowerSection({ entityId }) {
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("splineFollower");
  useEffect(() => {
    const id = setInterval(() => force((v) => v + 1), 150);
    return () => clearInterval(id);
  }, []);
  if (!component) return null;
  const length = component.pathLength;
  if (!length) {
    return <div className="inspector-hint">No path — point this at an entity with a Spline component.</div>;
  }
  return (
    <div className="field-row">
      <span className="field-label">Progress</span>
      <span className="field-value">
        {component.position.toFixed(2)} / {length.toFixed(2)} ({Math.round(component.progress * 100)}%)
      </span>
    </div>
  );
}
