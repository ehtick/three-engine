import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Play, Trash2, Zap } from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useUpdateNodeInternals,
  BaseEdge,
  getStraightPath,
  EdgeLabelRenderer,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { ANY_STATE, START_STATE } from "../../engine/animGraph.js";
import { setGraphHovered } from "../nodegraph/graphContext.js";
import { ContextMenu } from "../ContextMenu.jsx";

/**
 * Node-graph editor for .anim animation-controller assets (Unity-style):
 * state nodes wired by transition edges, a parameters sidebar, per-transition
 * conditions/blend settings. Save writes the file and live-applies the graph
 * to every Animation component referencing it.
 */

const PARAM_TYPES = ["number", "boolean", "trigger"];
const NUMBER_OPS = [">", "<", ">=", "<=", "==", "!="];

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// graph <-> react-flow mapping
// ---------------------------------------------------------------------------

function conditionSummary(data, paramTypes) {
  const conditions = data.conditions ?? [];
  if (!conditions.length) return "exit";
  return conditions
    .map((c) =>
      paramTypes[c.param] === "trigger" ? c.param : `${c.param} ${c.op ?? "=="} ${c.value}`,
    )
    .join(" · ");
}

function graphToFlow(graph) {
  const startNode = {
    id: START_STATE,
    type: "startState",
    position: graph.startPosition ?? { x: 40, y: 200 },
    data: {},
    deletable: false,
    draggable: false,
  };
  const nodes = [
    startNode,
    {
      id: ANY_STATE,
      type: "anyState",
      position: graph.anyPosition ?? { x: 40, y: 40 },
      data: {},
      deletable: false,
    },
    ...(graph.states ?? []).map((s) => ({
      id: s.id,
      type: "animState",
      position: { x: s.x ?? 0, y: s.y ?? 0 },
      data: { state: { ...s } },
    })),
  ];
  const startEdges = (graph.startTransitions ?? []).map((t) => ({
    id: t.id ?? uid("st"),
    source: START_STATE,
    target: t.to,
    data: {
      conditions: t.conditions ?? [],
      kind: "start",
      sourceAnchor: t.sourceAnchor,
      targetAnchor: t.targetAnchor,
    },
  }));
  const edges = [
    ...startEdges,
    ...(graph.transitions ?? []).map((t) => ({
      id: t.id ?? uid("t"),
      source: t.from,
      target: t.to,
      data: {
        conditions: t.conditions ?? [],
        duration: t.duration ?? 0.25,
        exitTime: t.exitTime ?? null,
        kind: "state",
        sourceAnchor: t.sourceAnchor,
        targetAnchor: t.targetAnchor,
      },
    })),
  ];
  return { nodes, edges };
}

function flowToGraph(nodes, edges, parameters) {
  const startNode = nodes.find((n) => n.id === START_STATE);
  const anyNode = nodes.find((n) => n.id === ANY_STATE);
  const states = nodes
    .filter((n) => n.type === "animState")
    .map((n) => ({ ...n.data.state, x: n.position.x, y: n.position.y }));
  const startTransitions = edges
    .filter((e) => e.source === START_STATE)
    .map((e) => ({
      id: e.id,
      to: e.target,
      conditions: e.data?.conditions ?? [],
      sourceAnchor: e.data?.sourceAnchor,
      targetAnchor: e.data?.targetAnchor,
    }));
  const transitions = edges
    .filter((e) => e.source !== START_STATE)
    .map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      conditions: e.data?.conditions ?? [],
      duration: e.data?.duration ?? 0.25,
      exitTime: e.data?.exitTime ?? null,
      sourceAnchor: e.data?.sourceAnchor,
      targetAnchor: e.data?.targetAnchor,
    }));
  return {
    version: 1,
    parameters,
    states,
    startTransitions,
    transitions,
    startPosition: startNode?.position,
    anyPosition: anyNode?.position,
  };
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

/**
 * PlayCanvas-style connection handles: a thin invisible strip along each of the
 * node's four borders. In loose connection mode every strip is both a source
 * and a target (`isConnectableStart` + `isConnectableEnd`), so a transition can
 * be dragged out of any border and dropped onto any border of another node. The
 * node interior stays free so clicks there select / drag the node. The canvas's
 * `connectionRadius` snaps a drop to the nearest strip, so you don't have to
 * land exactly on the border.
 *
 * One handle per side (not a source/target pair) keeps the DOM — and the
 * z-stacking of the strips that poke a few px outside the node — simple, which
 * is what makes connections start reliably from EVERY node, including ones
 * added after the graph first laid out.
 */
const EDGE_HANDLE_STYLE = {
  background: "transparent",
  border: "none",
  borderRadius: 0,
  minWidth: 0,
  minHeight: 0,
  transform: "none",
  pointerEvents: "all", // override RF's default `none` so the perimeter is grabbable
};
const EDGE_HANDLE_SIDES = [
  ["l", Position.Left, { width: 12, height: "100%", top: 0, left: -6 }],
  ["r", Position.Right, { width: 12, height: "100%", top: 0, right: -6 }],
  ["t", Position.Top, { width: "100%", height: 12, top: -6, left: 0 }],
  ["b", Position.Bottom, { width: "100%", height: 12, bottom: -6, left: 0 }],
];

function EdgeHandles() {
  return (
    <>
      {EDGE_HANDLE_SIDES.map(([id, position, style]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          className="anim-edge-handle"
          isConnectableStart
          isConnectableEnd
          style={{ ...EDGE_HANDLE_STYLE, ...style }}
        />
      ))}
    </>
  );
}

function StateNode({ data, selected }) {
  return (
    <div className={`shader-node cat-anim ${selected ? "selected" : ""}`}>
      <EdgeHandles />
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{data.state.name}</span>
      </div>
      <div className="shader-node-body">
        <div className="shader-node-row">
          <span className="shader-port-label">{data.state.clip || "no clip"}</span>
        </div>
      </div>
    </div>
  );
}

function AnyStateNode({ selected }) {
  return (
    <div className={`shader-node cat-any ${selected ? "selected" : ""}`}>
      <EdgeHandles />
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">Any State</span>
      </div>
    </div>
  );
}

/** Start pseudo-state. Unity-style entrance to the graph — the first wire
 *  dragged out of this node points at the state the animation begins in. */
function StartStateNode({ data, selected }) {
  const wired = !!data?.hasWires;
  return (
    <div className={`shader-node cat-start ${selected ? "selected" : ""}`}>
      <EdgeHandles />
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">Start</span>
      </div>
      {!wired && <div className="shader-node-body start-hint">drag → entry</div>}
    </div>
  );
}

const nodeTypes = { animState: StateNode, anyState: AnyStateNode, startState: StartStateNode };

// ---------------------------------------------------------------------------
// floating straight edge (PlayCanvas/Unity-style). Each endpoint is anchored to
// a specific point on its node's border — the exact spot the user grabbed /
// dropped — stored as a NORMALISED position (nx, ny ∈ [0,1] of the node box) so
// it stays glued to that border spot while the node is dragged or resized. Two
// transitions between the same pair (A→B and B→A) therefore leave from and
// arrive at different points and never overlap. Edges without a stored anchor
// (e.g. added programmatically) fall back to a centre-line border intersection.
// ---------------------------------------------------------------------------

function nodeGeom(node) {
  const p = node.internals?.positionAbsolute ?? node.position;
  const w = node.measured?.width;
  const h = node.measured?.height;
  if (!p || !w || !h) return null;
  return { x: p.x, y: p.y, w, h };
}

/** Absolute flow point for a normalised border anchor on `node`. */
function anchorPoint(node, anchor) {
  const g = nodeGeom(node);
  if (!g) return null;
  return { x: g.x + anchor.nx * g.w, y: g.y + anchor.ny * g.h };
}

/** Convert a flow-space point to a normalised anchor snapped onto the nearest
 *  border edge of `node`. Used when a transition is first drawn. */
function toBorderAnchor(point, node) {
  const g = nodeGeom(node);
  if (!g) return null;
  let nx = Math.min(Math.max((point.x - g.x) / g.w, 0), 1);
  let ny = Math.min(Math.max((point.y - g.y) / g.h, 0), 1);
  // Snap to whichever of the four edges is closest so the anchor sits ON the
  // border, not floating inside the box.
  const d = { l: nx, r: 1 - nx, t: ny, b: 1 - ny };
  const nearest = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), "l");
  if (nearest === "l") nx = 0;
  else if (nearest === "r") nx = 1;
  else if (nearest === "t") ny = 0;
  else ny = 1;
  return { nx, ny };
}

/** The point on `node`'s border that lies on the straight line toward
 *  `other`'s centre. Standard React Flow floating-edge intersection math —
 *  the fallback for edges that carry no explicit anchor. */
function borderPoint(node, other) {
  const g = nodeGeom(node);
  const og = nodeGeom(other);
  if (!g || !og) return null;
  const hw = g.w / 2;
  const hh = g.h / 2;
  const cx = g.x + hw;
  const cy = g.y + hh;
  const ox = og.x + og.w / 2;
  const oy = og.y + og.h / 2;
  const dx = (ox - cx) / (2 * hw) - (oy - cy) / (2 * hh);
  const dy = (ox - cx) / (2 * hw) + (oy - cy) / (2 * hh);
  const scale = 1 / (Math.abs(dx) + Math.abs(dy) || 1);
  const ux = scale * dx;
  const uy = scale * dy;
  return { x: hw * (ux + uy) + cx, y: hh * (-ux + uy) + cy };
}

function FloatingEdge({ id, source, target, markerEnd, selected, label, data }) {
  const nodeLookup = useStore((s) => s.nodeLookup);
  const s = nodeLookup?.get?.(source);
  const t = nodeLookup?.get?.(target);
  if (!s || !t) return null;
  const sp = (data?.sourceAnchor && anchorPoint(s, data.sourceAnchor)) || borderPoint(s, t);
  const tp = (data?.targetAnchor && anchorPoint(t, data.targetAnchor)) || borderPoint(t, s);
  if (!sp || !tp) return null;
  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={22}
        style={{ strokeWidth: selected ? 2.5 : 1.5 }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan animator-edge-label${selected ? " selected" : ""}`}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { default: FloatingEdge };

/** Live straight wire drawn while dragging a new transition out of a node. */
function StraightConnectionLine({ fromX, fromY, toX, toY }) {
  return (
    <path
      d={`M ${fromX},${fromY} L ${toX},${toY}`}
      fill="none"
      stroke="var(--accent, #4d9dff)"
      strokeWidth={2}
    />
  );
}

// ---------------------------------------------------------------------------
// sidebar editors
// ---------------------------------------------------------------------------

/**
 * Animator parameters list. In edit mode the right-hand column edits each
 * parameter's *default* value (the value the runtime initialises it to). In
 * play mode the right-hand column drives the *current runtime* value on a
 * bound Animation component, so you can poke parameters and watch the state
 * machine react. Both modes let you rename / remove / add parameters.
 */
function ParametersSection({
  parameters,
  onChange,
  playMode,
  drivenComponent,
  drivenOptions,
  onPickDriven,
}) {
  const add = (type) => {
    let i = 1;
    while (parameters.some((p) => p.name === `param${i}`)) i++;
    onChange([...parameters, { name: `param${i}`, type, default: type === "number" ? 0 : false }]);
  };

  const patch = (index, p) => onChange(parameters.map((x, i) => (i === index ? { ...x, ...p } : x)));
  const remove = (index) => onChange(parameters.filter((_, i) => i !== index));

  const currentState = playMode && drivenComponent ? drivenComponent.currentState : null;

  return (
    <div className="inspector-section">
      <div className="section-header">
        {playMode ? "Parameters (Live)" : "Parameters"}
        <div className="dropdown-wrap">
          <ParamAddButton onPick={add} />
        </div>
      </div>
      {playMode && drivenOptions.length > 1 && (
        <div className="field-row">
          <span className="field-label">Drives</span>
          <select
            className="select-field animator-target-select"
            value={drivenComponent?.entity.id ?? ""}
            onChange={(e) => onPickDriven(e.target.value)}
            title="Pick which bound entity these live values drive"
          >
            {drivenOptions.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {playMode && (
        <div className="animator-current-state">
          State: <span className="animator-current-state-name">{currentState ?? "—"}</span>
        </div>
      )}
      {!playMode && parameters.length === 0 && <div className="asset-hint">No parameters</div>}
      {playMode && !drivenComponent?.runtime && (
        <div className="asset-hint">
          No bound entity with a live runtime — add an Animation component using this controller to drive values.
        </div>
      )}
      {parameters.map((p, i) => (
        <div className="field-row animator-param-row" key={p.name + ":" + i}>
          <input
            className="text-field"
            defaultValue={p.name}
            key={p.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== p.name) patch(i, { name });
            }}
          />
          <span className="animator-param-type">{p.type}</span>
          {playMode ? (
            drivenComponent?.runtime ? (
              <LiveParamControl param={p} component={drivenComponent} />
            ) : (
              <span className="animator-param-default" />
            )
          ) : p.type === "number" ? (
            <input
              className="number-field animator-param-default"
              type="number"
              step={0.1}
              value={p.default ?? 0}
              onChange={(e) => patch(i, { default: parseFloat(e.target.value) || 0 })}
            />
          ) : p.type === "boolean" ? (
            <input type="checkbox" checked={!!p.default} onChange={(e) => patch(i, { default: e.target.checked })} />
          ) : (
            <span className="animator-param-default" />
          )}
          <button className="icon-btn" title="Remove parameter" onClick={() => remove(i)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Per-parameter runtime control. Re-renders on the parent's rAF tick so
 *  trigger consumption and external script writes show up immediately. */
function LiveParamControl({ param, component }) {
  const value = component.getParam(param.name);
  if (param.type === "number") {
    return (
      <input
        className="number-field animator-param-default"
        type="number"
        step={0.1}
        value={typeof value === "number" ? value : 0}
        onChange={(e) => component.setNumber(param.name, parseFloat(e.target.value) || 0)}
      />
    );
  }
  if (param.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => component.setBool(param.name, e.target.checked)}
      />
    );
  }
  // trigger
  return (
    <button
      className={`toolbar-btn tiny${value ? " active" : ""}`}
      onClick={() => component.setTrigger(param.name)}
      title="Fire trigger (auto-cleared after a transition consumes it)"
    >
      {value ? "set" : "fire"}
    </button>
  );
}

function ParamAddButton({ onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" title="Add parameter" onClick={() => setOpen((v) => !v)}>
        <Plus size={12} />
      </button>
      {open && (
        <>
          <div className="dropdown-overlay" onClick={() => setOpen(false)} />
          <div className="dropdown-menu align-right">
            {PARAM_TYPES.map((t) => (
              <button
                key={t}
                className="dropdown-item"
                onClick={() => {
                  setOpen(false);
                  onPick(t);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function StateSection({ node, clipNames, onPatch, onPreview }) {
  const state = node.data.state;
  return (
    <div className="inspector-section">
      <div className="section-header">State</div>
      <div className="field-row">
        <span className="field-label">Name</span>
        <input
          className="text-field"
          key={node.id + state.name}
          defaultValue={state.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== state.name) onPatch({ name });
          }}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Clip</span>
        {clipNames.length ? (
          <select className="select-field" value={state.clip ?? ""} onChange={(e) => onPatch({ clip: e.target.value })}>
            <option value="">None</option>
            {clipNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-field"
            key={node.id + (state.clip ?? "")}
            defaultValue={state.clip ?? ""}
            placeholder="clip name"
            onBlur={(e) => onPatch({ clip: e.target.value.trim() })}
          />
        )}
      </div>
      <div className="field-row">
        <span className="field-label">Speed</span>
        <input
          className="number-field"
          type="number"
          step={0.1}
          value={state.speed ?? 1}
          onChange={(e) => onPatch({ speed: parseFloat(e.target.value) || 1 })}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Loop</span>
        <input type="checkbox" checked={state.loop !== false} onChange={(e) => onPatch({ loop: e.target.checked })} />
      </div>
      <button className="toolbar-btn wide" onClick={onPreview}>
        <Play size={12} />
        Preview
      </button>
    </div>
  );
}

function TransitionSection({ edge, parameters, stateNames, onPatch }) {
  const data = edge.data ?? {};
  const conditions = data.conditions ?? [];
  const isStart = data.kind === "start";

  const patchCondition = (index, patch) =>
    onPatch({ conditions: conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const conditionRow = (c, i) => {
    const type = parameters.find((p) => p.name === c.param)?.type ?? "number";
    return (
      <div className="field-row animator-cond-row" key={i}>
        <select
          className="select-field"
          value={c.param}
          onChange={(e) => {
            const param = e.target.value;
            const t = parameters.find((p) => p.name === param)?.type;
            patchCondition(i, {
              param,
              op: t === "number" ? ">" : "==",
              value: t === "number" ? 0 : true,
            });
          }}
        >
          {parameters.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {type === "number" && (
          <>
            <select
              className="select-field animator-op"
              value={c.op ?? ">"}
              onChange={(e) => patchCondition(i, { op: e.target.value })}
            >
              {NUMBER_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              className="number-field"
              type="number"
              step={0.1}
              value={c.value ?? 0}
              onChange={(e) => patchCondition(i, { value: parseFloat(e.target.value) || 0 })}
            />
          </>
        )}
        {type === "boolean" && (
          <select
            className="select-field"
            value={String(c.value ?? true)}
            onChange={(e) => patchCondition(i, { op: "==", value: e.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        )}
        {type === "trigger" && (
          <span className="animator-trigger-hint" title="Fires this transition when the trigger is set from a script (setTrigger). Auto-consumed.">
            when fired
          </span>
        )}
        <button
          className="icon-btn"
          title="Remove condition"
          onClick={() => onPatch({ conditions: conditions.filter((_, x) => x !== i) })}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  };

  return (
    <div className="inspector-section">
      <div className="section-header">
        Transition
        <button
          className="icon-btn"
          title="Add condition"
          disabled={!parameters.length}
          onClick={() => {
            const p = parameters[0];
            onPatch({
              conditions: [
                ...conditions,
                { param: p.name, op: p.type === "number" ? ">" : "==", value: p.type === "number" ? 0 : true },
              ],
            });
          }}
        >
          <Plus size={12} />
        </button>
      </div>
      <div className="animator-transition-label">
        {stateNames[edge.source] ?? (isStart ? "Start" : "Any State")} → {stateNames[edge.target] ?? "?"}
      </div>
      {conditions.length === 0 && (
        <div className="asset-hint">
          {isStart ? "No conditions — this is the default entry" : "No conditions — fires at exit time"}
        </div>
      )}
      {conditions.map(conditionRow)}
      {!isStart && (
        <>
          <div className="field-row">
            <span className="field-label">Blend (s)</span>
            <input
              className="number-field"
              type="number"
              step={0.05}
              min={0}
              value={data.duration ?? 0.25}
              onChange={(e) => onPatch({ duration: Math.max(0, parseFloat(e.target.value) || 0) })}
            />
          </div>
          <div className="field-row">
            <span className="field-label">Exit time</span>
            <input
              className="number-field"
              type="number"
              step={0.05}
              min={0}
              max={1}
              placeholder="—"
              value={data.exitTime ?? ""}
              onChange={(e) => {
                const v = e.target.value === "" ? null : Math.min(1, Math.max(0, parseFloat(e.target.value) || 0));
                onPatch({ exitTime: v });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

/** Animation components in the scene bound to this controller file. */
function componentsUsing(animPath) {
  const out = [];
  try {
    for (const entity of engine.entities.values()) {
      const comp = entity.getComponent("animation");
      if (comp?.props.controller === animPath) out.push(comp);
    }
  } catch {
    // Engine not booted yet.
  }
  return out;
}

/** Clip names available for this controller (from a bound model, else any model). */
function collectClipNames(animPath) {
  const names = new Set();
  const bound = componentsUsing(animPath);
  try {
    if (bound.length) {
      for (const comp of bound) for (const n of comp.getClipNames()) names.add(n);
    } else {
      for (const entity of engine.entities.values()) {
        for (const clip of entity.getComponent("model")?.clips ?? []) names.add(clip.name);
      }
    }
  } catch {
    // Engine not booted yet.
  }
  return [...names];
}

function AnimatorEditor({ animPath }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [parameters, setParameters] = useState([]);
  const [dirty, setDirty] = useState(false);
  const { screenToFlowPosition, getInternalNode } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [canvasMenu, setCanvasMenu] = useState(null);
  const [pickedEntityId, setPickedEntityId] = useState(null);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.animator") === "1";
    } catch {
      return false;
    }
  });
  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("engine.autosave.animator", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let graph = null;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        graph = JSON.parse(await invoke("read_text_file", { path: animPath }));
      } catch (err) {
        console.error(`Failed to read animator: ${err}`);
        return;
      }
      if (!live) return;
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setParameters(graph.parameters ?? []);
      setDirty(false);
    })();
    return () => (live = false);
  }, [animPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const paramTypes = useMemo(() => Object.fromEntries(parameters.map((p) => [p.name, p.type])), [parameters]);
  const stateNames = useMemo(
    () => Object.fromEntries(nodes.filter((n) => n.type === "animState").map((n) => [n.id, n.data.state.name])),
    [nodes],
  );
  const clipNames = useMemo(() => collectClipNames(animPath), [animPath, nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedNode = nodes.find((n) => n.selected && n.type === "animState");
  const selectedEdge = !selectedNode && edges.find((e) => e.selected);

  // React Flow measures a node's handle bounds when it first mounts. Our state
  // nodes use full-edge handles sized at height/width 100%, and a node added
  // dynamically after the graph is already laid out doesn't get those
  // percentage-sized strips re-measured — so you can't start a transition from
  // it (only the states present at load work). Re-register each newly-seen
  // node's internals once it has mounted AND been measured (defer a frame so
  // `measured` width/height exist before RF recomputes handle bounds).
  const seenNodeIds = useRef(new Set());
  useEffect(() => {
    const fresh = [];
    for (const n of nodes) {
      if (seenNodeIds.current.has(n.id)) continue;
      seenNodeIds.current.add(n.id);
      fresh.push(n.id);
    }
    if (!fresh.length) return;
    const raf = requestAnimationFrame(() => fresh.forEach((id) => updateNodeInternals(id)));
    return () => cancelAnimationFrame(raf);
  }, [nodes, updateNodeInternals]);

  // Track adds/removes of Animation components referencing this controller.
  // Event-driven: the old per-frame RAF re-scan walked every entity AND
  // returned a fresh array each frame — a guaranteed full panel re-render
  // at 60Hz for as long as the Animator was open. The scene only changes
  // through commands, which emit these events.
  const [boundComponents, setBoundComponents] = useState([]);
  useEffect(() => {
    const refresh = () => {
      setBoundComponents((prev) => {
        const next = componentsUsing(animPath);
        // Keep the previous array identity when nothing changed so React
        // bails out of the re-render entirely.
        if (prev.length === next.length && prev.every((c, i) => c === next[i])) return prev;
        return next;
      });
    };
    refresh();
    const unsubs = [
      engine.on?.("hierarchy-changed", refresh),
      engine.on?.("component-changed", refresh),
      engine.on?.("model-loaded", refresh),
    ];
    return () => {
      for (const un of unsubs) un?.();
    };
  }, [animPath]);

  // Track play mode (engine.setPlaying flips this). The play-mode UI shows
  // each parameter's *runtime* value on a bound Animation component, so we
  // need to react to play-changed events and re-render on every frame while
  // playing (consumed triggers / script writes should be visible immediately).
  const [playMode, setPlayMode] = useState(() => engine.playing);
  useEffect(() => {
    const onChange = (v) => setPlayMode(v);
    engine.on("play-changed", onChange);
    setPlayMode(engine.playing);
    return () => engine.off("play-changed", onChange);
  }, []);
  const [, setLiveTick] = useState(0);
  useEffect(() => {
    if (!playMode) return;
    let alive = true;
    let last = 0;
    // 10Hz readout refresh (same cadence as the stats overlay) — it's a
    // parameter READOUT, and a full panel re-render every frame during
    // play mode was a measurable FPS cost.
    const loop = (t) => {
      if (!alive) return;
      if (t - last >= 100) {
        last = t;
        setLiveTick((v) => (v + 1) & 0xffff);
      }
      requestAnimationFrame(loop);
    };
    const id = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [playMode]);

  const drivenComponent = useMemo(() => {
    if (!boundComponents.length) return null;
    const picked = boundComponents.find((c) => c.entity.id === pickedEntityId);
    return picked ?? boundComponents[0];
  }, [boundComponents, pickedEntityId]);

  // Guard against a stale graph-hovered flag if the panel unmounts while
  // the pointer is still over it (dockview close, tab switch, …).
  useEffect(() => () => setGraphHovered(false), []);

  // Reset the picker if the previously-chosen entity disappears.
  useEffect(() => {
    if (pickedEntityId && boundComponents.length && !boundComponents.some((c) => c.entity.id === pickedEntityId)) {
      setPickedEntityId(null);
    }
  }, [boundComponents, pickedEntityId]);
  const drivenOptions = useMemo(
    () => boundComponents.map((c) => ({ id: c.entity.id, name: c.entity.name ?? c.entity.id })),
    [boundComponents],
  );

  // Refresh derived node/edge data on every change.
  const decoratedNodes = useMemo(() => {
    const startHasWires = edges.some((e) => e.source === START_STATE);
    return nodes.map((n) =>
      n.id === START_STATE ? { ...n, data: { ...n.data, hasWires: startHasWires } } : n,
    );
  }, [nodes, edges]);
  const decoratedEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: "default",
        animated: e.source === ANY_STATE,
        // Only surface the condition summary while the transition is selected —
        // keeps the graph uncluttered when nothing is being edited.
        label: e.selected
          ? e.data?.kind === "start"
            ? "entry"
            : conditionSummary(e.data ?? {}, paramTypes)
          : undefined,
        markerEnd: { type: "arrowclosed" },
      })),
    [edges, paramTypes],
  );

  const addState = (screenPos) => {
    setCanvasMenu(null);
    setDirty(true);
    let i = 1;
    while (nodes.some((n) => n.data?.state?.name === `State ${i}`)) i++;
    const id = uid("state");
    // Toolbar-added states cascade instead of stacking on the same spot, so
    // their borders stay individually grabbable for drawing transitions.
    const stateCount = nodes.filter((n) => n.type === "animState").length;
    const position = screenPos
      ? screenToFlowPosition(screenPos)
      : { x: 220 + (stateCount % 3) * 60, y: 120 + (stateCount % 4) * 70 };
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "animState",
        position,
        data: { state: { id, name: `State ${i}`, clip: clipNames[0] ?? "", speed: 1, loop: true } },
      },
    ]);
  };

  const patchState = (nodeId, patch) => {
    setDirty(true);
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, state: { ...n.data.state, ...patch } } } : n)),
    );
  };

  const patchEdge = (edgeId, patch) => {
    setDirty(true);
    setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, ...patch } } : e)));
  };

  // Grab/drop points (flow space) captured during a connection drag, used to
  // anchor the new edge to the exact border spots. Component-scoped (not
  // module-scoped) so React Fast Refresh can't leave a stale reference behind.
  const dragPointRef = useRef({ start: null, end: null });

  // Keep the live drop point current while a connection is being dragged
  // (React Flow's onConnect doesn't include the cursor position).
  useEffect(() => {
    const onMove = (e) => {
      if (!dragPointRef.current.start) return;
      dragPointRef.current.end = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [screenToFlowPosition]);

  const onConnect = useCallback(
    (connection) => {
      if (connection.source === connection.target) return; // self-loops make no sense here
      setDirty(true);
      const isStart = connection.source === START_STATE;
      const data = isStart
        ? { conditions: [], kind: "start" }
        : { conditions: [], duration: 0.25, exitTime: null, kind: "state" };
      // Anchor the endpoints to the exact border points the user grabbed and
      // dropped, stored normalised so they follow the nodes. Falls back to a
      // floating centre-line endpoint if a point couldn't be captured.
      const { start, end } = dragPointRef.current;
      const srcNode = getInternalNode(connection.source);
      const tgtNode = getInternalNode(connection.target);
      const sa = start && srcNode && toBorderAnchor(start, srcNode);
      const ta = end && tgtNode && toBorderAnchor(end, tgtNode);
      if (sa) data.sourceAnchor = sa;
      if (ta) data.targetAnchor = ta;
      setEdges((eds) =>
        addEdge(
          { ...connection, id: isStart ? uid("st") : uid("t"), data },
          eds.filter((e) => !(e.source === connection.source && e.target === connection.target)),
        ),
      );
    },
    [setEdges, getInternalNode],
  );

  const guardedNodesChange = useCallback(
    (changes) => {
      const guarded = changes.filter(
        (c) => !(c.type === "remove" && (c.id === ANY_STATE || c.id === START_STATE)),
      );
      // The Start node is a fixed-position anchor: never let the user drag it.
      const startLocked = guarded.map((c) => {
        if (c.type === "position" && c.id === START_STATE) return { ...c, position: undefined };
        return c;
      });
      if (startLocked.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
      onNodesChange(startLocked);
    },
    [onNodesChange],
  );

  const buildGraph = () => flowToGraph(nodes, edges, parameters);

  const save = async () => {
    const graph = buildGraph();
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", { path: animPath, contents: JSON.stringify(graph, null, 2) });
    for (const comp of componentsUsing(animPath)) comp.applyGraph(structuredClone(graph));
    setDirty(false);
    console.log(`Animator saved: ${animPath}`);
  };

  // Autosave: when enabled, commit every change. Debounced so transient
  // mutations (e.g. dragging a node, which fires onNodesChange on every
  // intermediate position) collapse into a single write at the end of the
  // gesture. Selection-only updates and the initial load keep `dirty` false
  // and never reach the timer.
  useEffect(() => {
    if (!autosave) return;
    if (!dirty) return;
    const id = setTimeout(save, 150);
    return () => clearTimeout(id);
  }, [autosave, nodes, edges, parameters, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = (stateName) => {
    const bound = componentsUsing(animPath);
    if (!bound.length) {
      console.warn("No entity in the scene uses this controller — add an Animation component first.");
      return;
    }
    // Preview runs the current (possibly unsaved) graph.
    const graph = buildGraph();
    for (const comp of bound) {
      comp.applyGraph(structuredClone(graph));
      comp.play(stateName, 0.15);
    }
  };

  return (
    <div className="shader-graph-panel animator-panel">
      <div className="panel-toolbar">
        <button className="toolbar-btn" onClick={() => addState()}>
          <Plus size={14} />
          State
        </button>
        <span className="asset-path" title={animPath}>
          {animPath.split(/[\\/]/).pop()}
        </span>
        <button
          className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
          title={autosave ? "Autosave on — changes save instantly" : "Autosave off — click Save to commit"}
          onClick={toggleAutosave}
        >
          <Zap size={14} />
        </button>
        <button className="toolbar-btn" disabled={!dirty || autosave} onClick={save}>
          <Save size={13} />
          Save{dirty ? " •" : ""}
        </button>
      </div>
      <div className="animator-body">
        <div className="animator-sidebar">
          <ParametersSection
            parameters={parameters}
            onChange={(next) => {
              setParameters(next);
              setDirty(true);
            }}
            playMode={playMode}
            drivenComponent={drivenComponent}
            drivenOptions={drivenOptions}
            onPickDriven={setPickedEntityId}
          />
          {selectedNode && (
            <StateSection
              node={selectedNode}
              clipNames={clipNames}
              onPatch={(patch) => patchState(selectedNode.id, patch)}
              onPreview={() => preview(selectedNode.data.state.name)}
            />
          )}
          {selectedEdge && (
            <TransitionSection
              edge={selectedEdge}
              parameters={parameters}
              stateNames={stateNames}
              onPatch={(patch) => patchEdge(selectedEdge.id, patch)}
            />
          )}
        </div>
        <div
          className="shader-graph-canvas"
          onMouseEnter={() => setGraphHovered(true)}
          onMouseLeave={() => setGraphHovered(false)}
        >
          <ReactFlow
            nodes={decoratedNodes}
            edges={decoratedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionLineComponent={StraightConnectionLine}
            connectionRadius={40}
            onNodesChange={guardedNodesChange}
            onEdgesChange={(changes) => {
              if (changes.some((c) => c.type === "remove")) setDirty(true);
              onEdgesChange(changes);
            }}
            onConnect={onConnect}
            onConnectStart={(event) => {
              const pt =
                event && event.clientX != null
                  ? screenToFlowPosition({ x: event.clientX, y: event.clientY })
                  : null;
              dragPointRef.current.start = pt;
              dragPointRef.current.end = pt;
            }}
            onConnectEnd={() => {
              // onConnect (if the drop was valid) has already read the points.
              dragPointRef.current.start = null;
              dragPointRef.current.end = null;
            }}
            onEdgeDoubleClick={(_event, edge) => {
              // Double-click a transition to remove it.
              setEdges((eds) => eds.filter((e) => e.id !== edge.id));
              setDirty(true);
            }}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCanvasMenu({ x: e.clientX, y: e.clientY });
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            connectionMode="loose"
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {canvasMenu && (
            <ContextMenu
              x={canvasMenu.x}
              y={canvasMenu.y}
              items={[{ label: "New State", action: () => addState(canvasMenu) }]}
              onClose={() => setCanvasMenu(null)}
            />
          )}
        </div>
      </div>
      <div className="shader-graph-hint">
        Drag between states to add a transition · select an edge to edit conditions · Save applies to the scene
      </div>
    </div>
  );
}

export function AnimatorPanel() {
  const assetPath = useSelectionStore((s) => s.assetPath);
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const animPath = assetPath?.toLowerCase().endsWith(".anim")
    ? assetPath
    : entity?.components?.animation?.controller || null;

  if (!animPath) {
    return (
      <div className="shader-graph-panel empty">
        Select a .anim asset (or an entity whose Animation component has a controller) to edit it.
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <AnimatorEditor key={animPath} animPath={animPath} />
    </ReactFlowProvider>
  );
}
