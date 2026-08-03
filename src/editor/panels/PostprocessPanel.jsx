import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Sparkles, Zap, Save, X, Camera } from "lucide-react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { setGraphHovered } from "../nodegraph/graphContext.js";
import { engine } from "../engineInstance.js";
import { ensureModules } from "../modules.js";
import {
  PP_NODE_TYPES,
  PP_CATEGORY_LABELS,
  INPUT_PORT_LABELS,
  nodeDefaults,
  DEFAULT_POST_GRAPH,
} from "../../modules/postprocessing/postGraph.js";

/**
 * Graph shape ↔ React Flow shape conversions. The graph JSON on disk is
 * `{ nodes: [{ id, type, props, position }], edges: [{ source, sourceHandle,
 * target, targetHandle }] }`; React Flow's internal form adds a `type`
 * discriminator so its custom node renderer (`PostNode`) can render each
 * registered node type from the registry.
 */
function graphToFlow(graph) {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "postNode",
      position: n.position ?? { x: 0, y: 0 },
      data: { nodeType: n.type, props: n.props ?? {} },
    })),
    edges: (graph.edges ?? []).map((e, i) => ({
      id: e.id ?? `e${i}-${e.source}.${e.sourceHandle}->${e.target}.${e.targetHandle}`,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

function flowToGraph(nodes, edges) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      props: n.data.props,
      position: n.position,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

// ---------------------------------------------------------------------------
// Per-input / per-param field editor
// ---------------------------------------------------------------------------

function ParamField({ param, value, onChange }) {
  const v = value ?? param.default;
  switch (param.type) {
    case "number":
      return (
        <input
          className="number-field nodrag"
          type="number"
          step={param.step ?? 0.1}
          min={param.min}
          max={param.max}
          value={v}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            if (!Number.isNaN(parsed)) onChange(parsed);
          }}
        />
      );
    case "color":
      return (
        <input
          className="color-field nodrag"
          type="color"
          value={v ?? "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "boolean":
      return (
        <input
          className="nodrag"
          type="checkbox"
          checked={!!v}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "select":
      return (
        <select className="select-field nodrag" value={v} onChange={(e) => onChange(e.target.value)}>
          {param.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Node renderer (mirrors shader-node visuals so palette + canvas match)
// ---------------------------------------------------------------------------

function PostNode({ id, data, selected }) {
  const meta = PP_NODE_TYPES[data.nodeType];
  if (!meta) return null;

  const isInput = data.nodeType === "input";
  const isOutput = data.nodeType === "output";

  return (
    <div className={`shader-node post-node cat-${meta.category} ${selected ? "selected" : ""}`}>
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{meta.label}</span>
      </div>
      <div className="shader-node-body">
        {/* Input nodes expose the auto-fed sockets; everything else
            has its declared inputs (rendered as wire targets). */}
        {isInput && (
          <>
            <div className="shader-node-row">
              <Handle type="source" position={Position.Right} id="color" className="shader-handle pt-vec4" />
              <span className="shader-port-label">{INPUT_PORT_LABELS.color}</span>
            </div>
            <div className="shader-node-row">
              <Handle type="source" position={Position.Right} id="depth" className="shader-handle pt-float" />
              <span className="shader-port-label">{INPUT_PORT_LABELS.depth}</span>
            </div>
            <div className="shader-node-row">
              <Handle type="source" position={Position.Right} id="normal" className="shader-handle pt-vec3" />
              <span className="shader-port-label">{INPUT_PORT_LABELS.normal}</span>
            </div>
            <div className="shader-node-row">
              <Handle type="source" position={Position.Right} id="velocity" className="shader-handle pt-vec4" />
              <span className="shader-port-label">{INPUT_PORT_LABELS.velocity}</span>
            </div>
          </>
        )}
        {!isInput &&
          (meta.inputs ?? []).map((input) => (
            <div className="shader-node-row" key={input.key}>
              <Handle type="target" position={Position.Left} id={input.key} className={`shader-handle pt-${input.kind}`} />
              <span className="shader-port-label">{input.key}</span>
            </div>
          ))}
        {/* Source handles. Input pseudo-sources are rendered explicitly in
            the `isInput` branch above (with friendlier translated labels
            from INPUT_PORT_LABELS) — skip the generic loop there to avoid
            duplicating each output socket. */}
        {!isInput &&
          (meta.outputs ?? []).map((output) => (
            <div className="shader-node-row out-row" key={output.key}>
              <span className="shader-port-label">{output.key}</span>
              <Handle type="source" position={Position.Right} id={output.key} className={`shader-handle pt-${output.kind}`} />
            </div>
          ))}
        {(meta.params ?? []).map((param) => (
          <div className="shader-node-row field" key={param.key}>
            <span className="shader-port-label param-label">{param.label}</span>
            <ParamField
              param={param}
              value={data.props[param.key]}
              onChange={(v) => data.onPropsChange(id, { [param.key]: v })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { postNode: PostNode };

// ---------------------------------------------------------------------------
// Node palette (toolbar dropdown + canvas right-click)
// ---------------------------------------------------------------------------

const PALETTE = Object.entries(PP_CATEGORY_LABELS).map(([cat, group]) => ({
  group,
  types: Object.entries(PP_NODE_TYPES)
    .filter(([, meta]) => meta.category === cat)
    .map(([type]) => type),
}));

function NodePalette({ style, onPick, onClose }) {
  return (
    <>
      <div className="dropdown-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={`dropdown-menu node-palette ${style ? "context-menu" : ""}`} style={style}>
        <div className="node-palette-list">
          {PALETTE.map(({ group, types }) => (
            <div key={group}>
              <div className="node-palette-group">{group}</div>
              {types.map((type) => (
                <button key={type} className="dropdown-item node-palette-item" onClick={() => onPick(type)}>
                  <span className={`shader-node-dot cat-${PP_NODE_TYPES[type].category}`} />
                  {PP_NODE_TYPES[type].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Camera picker: every camera in the scene with a `postprocess` component
// is a valid target for the editor. Selecting one switches the active graph.
// ---------------------------------------------------------------------------

function useCamerasWithPost() {
  const [items, setItems] = useState([]);
  const refresh = useCallback(() => {
    const out = [];
    const e = engine;
    if (!e?.entities) return;
    for (const ent of e.entities.values()) {
      const post = ent.getComponent?.("postprocess");
      if (!ent.getComponent?.("camera") || !post) continue;
      out.push({ entityId: ent.id, name: ent.name, showInEditor: !!post.props.showInEditor });
    }
    setItems(out);
  }, []);
  useEffect(() => {
    refresh();
    const off = engine.on?.("hierarchy-changed", refresh);
    const off2 = engine.on?.("modules-changed", refresh);
    return () => {
      off?.();
      off2?.();
    };
  }, [refresh]);
  return items;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function PostprocessEditor({ entityId }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.postprocess") === "1";
    } catch {
      return false;
    }
  });
  const { screenToFlowPosition } = useReactFlow();

  const loadGraph = useCallback(
    (graph) => {
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (!entityId) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const ent = engine.getEntity(entityId);
    const comp = ent?.getComponent?.("postprocess");
    const graph = comp?.props?.graph ?? DEFAULT_POST_GRAPH;
    loadGraph(graph);
    setDirty(false);
  }, [entityId, loadGraph]);

  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("engine.autosave.postprocess", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const handlePropsChange = useCallback(
    (nodeId, patch) => {
      setDirty(true);
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, props: { ...n.data.props, ...patch } } } : n)),
      );
    },
    [setNodes],
  );

  const nodesWithHandlers = useMemo(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, onPropsChange: handlePropsChange } })),
    [nodes, handlePropsChange],
  );

  const onConnect = useCallback(
    (connection) => {
      setDirty(true);
      // Only one wire per target handle — replace any existing wire into
      // the same socket rather than stacking them.
      setEdges((eds) =>
        addEdge(
          connection,
          eds.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
        ),
      );
    },
    [setEdges],
  );

  const guardedNodesChange = useCallback(
    (changes) => {
      // Don't allow removing the input pseudo-source or the output sink —
      // both are required for the graph to compile. Multiple input/output
      // nodes are unusual but legal (chains fan out / merge before
      // reaching a single Output); only the LAST removal of a unique
      // node type is blocked.
      const inputCount = nodes.reduce((n, x) => n + (x.data.nodeType === "input" ? 1 : 0), 0);
      const outputCount = nodes.reduce((n, x) => n + (x.data.nodeType === "output" ? 1 : 0), 0);
      const guarded = changes.filter((c) => {
        if (c.type !== "remove") return true;
        const t = nodes.find((x) => x.id === c.id)?.data.nodeType;
        if (t === "input" && inputCount <= 1) return false;
        if (t === "output" && outputCount <= 1) return false;
        return true;
      });
      if (guarded.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
      onNodesChange(guarded);
    },
    [nodes, onNodesChange],
  );

  const addNode = (type, screenPos) => {
    setMenuOpen(false);
    setDirty(true);
    const position = screenPos
      ? screenToFlowPosition(screenPos)
      : { x: 60 + Math.random() * 220, y: 60 + Math.random() * 220 };
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => [
      ...nds,
      { id, type: "postNode", position, data: { nodeType: type, props: nodeDefaults(type) } },
    ]);
  };

  const apply = () => {
    if (!entityId) return;
    const graph = flowToGraph(nodes, edges);
    // Validate before committing: the engine component doesn't validate
    // (it just builds), so an unwired Output would silently render the
    // passthrough beauty — better to surface the error here.
    const hasOutput = graph.nodes.some((n) => n.type === "output");
    if (!hasOutput) {
      console.error("Post-process graph needs an Output node");
      return;
    }
    commandBus.execute(new SetComponentPropCommand(entityId, "postprocess", "graph", graph));
    setDirty(false);
  };

  // Autosave: debounced so transient mutations (e.g. dragging a node)
  // collapse into a single write at the end of the gesture.
  useEffect(() => {
    if (!autosave) return;
    if (!dirty || !entityId) return;
    const id = setTimeout(apply, 200);
    return () => clearTimeout(id);
  }, [autosave, nodes, edges, dirty, entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onEdgeDoubleClick = useCallback(
    (_event, edge) => {
      setDirty(true);
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges],
  );

  useEffect(() => () => setGraphHovered(false), []);

  if (!entityId) {
    return (
      <div className="shader-graph-panel postprocess-empty">
        <div className="empty-state">
          <Sparkles size={32} />
          <h3>Pick a camera</h3>
          <p>
            Add a <code>Post Process</code> component to any camera in the scene, then select that
            camera from the dropdown above to author its post graph.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="shader-graph-panel">
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}>
            <Plus size={14} />
            Node
          </button>
          {menuOpen && <NodePalette onPick={(type) => addNode(type)} onClose={() => setMenuOpen(false)} />}
        </div>
        <button
          className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
          title={autosave ? "Autosave on — changes apply instantly" : "Autosave off — click Apply to commit"}
          onClick={toggleAutosave}
        >
          <Zap size={14} />
        </button>
        <button
          className={`toolbar-btn${dirty ? "" : " disabled"}`}
          disabled={!dirty}
          onClick={apply}
          title={dirty ? "Apply changes" : "No pending changes"}
        >
          <Save size={14} />
          {dirty ? "Apply" : "Saved"}
        </button>
      </div>
      <div
        className="shader-graph-canvas"
        onMouseEnter={() => setGraphHovered(true)}
        onMouseLeave={() => setGraphHovered(false)}
      >
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          onNodesChange={guardedNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          nodeTypes={nodeTypes}
          // Enable Delete / Backspace to remove the selected node (or
          // selected edges). The Input pseudo-source and Output sink are
          // guarded in `guardedNodesChange` so the graph never loses its
          // last entry/exit point via the keyboard. Marking dirty on the
          // `*Deleted` callbacks (rather than on Change) avoids a spurious
          // dirty flip from React Flow's own select-only updates.
          deleteKeyCode={["Delete", "Backspace"]}
          onNodesDelete={() => setDirty(true)}
          onEdgesDelete={() => setDirty(true)}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            addNode(Object.keys(PP_NODE_TYPES)[0], { x: e.clientX, y: e.clientY });
            // Open the palette so the user can pick a different node from
            // the same context menu.
            setMenuOpen(true);
          }}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(255,255,255,0.05)" />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level panel: camera picker + editor.
// ---------------------------------------------------------------------------

export function PostprocessPanel() {
  const cameras = useCamerasWithPost();
  const [activeId, setActiveId] = useState(null);
  const [pending, setPending] = useState(null);

  // Resolve the active entity ID through the engine (the source of truth).
  // If the previously-selected entity was removed, fall back to the first
  // available camera so the panel never gets stuck on a stale id.
  useEffect(() => {
    if (activeId && engine.getEntity(activeId)) return;
    setActiveId(cameras[0]?.entityId ?? null);
  }, [activeId, cameras]);

  // Best-effort: make sure the postprocessing module is registered. The
  // editor's module panel does this lazily, but the postprocess panel can
  // be opened from the menu bar before any module is enabled — calling
  // ensureModules() is a no-op if it's already registered.
  useEffect(() => {
    ensureModules().catch(() => {});
  }, []);

  const activeCamera = cameras.find((item) => item.entityId === activeId) ?? null;
  const setShowInEditor = (value) => {
    if (!activeId) return;
    commandBus.execute(new SetComponentPropCommand(activeId, "postprocess", "showInEditor", value));
  };

  return (
    <ReactFlowProvider>
      <div className="postprocess-panel">
        <div className="postprocess-header">
          <div className="dropdown-wrap">
            <button className="toolbar-btn" onClick={() => setPending((v) => !v)}>
              <Camera size={14} label="Pick a camera" />
              {activeCamera?.name ?? "Camera"}
            </button>
            {pending && (
              <>
                <div className="dropdown-overlay" onClick={() => setPending(false)} />
                <div className="dropdown-menu">
                  {cameras.length === 0 && (
                    <div className="dropdown-item" style={{ opacity: 0.6, pointerEvents: "none" }}>
                      No cameras with a Post Process component
                    </div>
                  )}
                  {cameras.map(({ entityId, name }) => (
                    <button
                      key={entityId}
                      className="dropdown-item"
                      onClick={() => {
                        setPending(false);
                        setActiveId(entityId);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <label className="postprocess-preview-toggle" title="Apply this graph to the editor viewport outside Play mode">
            <input
              type="checkbox"
              checked={!!activeCamera?.showInEditor}
              disabled={!activeCamera}
              onChange={(event) => setShowInEditor(event.target.checked)}
            />
            <span>Show in Editor</span>
          </label>
        </div>
        <PostprocessEditor entityId={activeId} />
      </div>
    </ReactFlowProvider>
  );
}
