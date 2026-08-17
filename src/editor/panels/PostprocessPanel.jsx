import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Sparkles, Zap, Save, Camera, FilePlus2 } from "lucide-react";
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
import { AssetField } from "../fields/AssetField.jsx";
import { invoke, createAssetFile } from "../assetOps.js";
import { invalidateBlobUrl, extOf } from "../assetLoader.js";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import {
  PP_NODE_TYPES,
  PP_CATEGORY_LABELS,
  INPUT_PORT_LABELS,
  nodeDefaults,
} from "../../modules/postprocessing/postGraph.js";
import {
  DEFAULT_POST_GRAPH,
  createPostGraph,
  normalizePostAsset,
  normalizePostGraph,
  serializePostAsset,
} from "../../modules/postprocessing/postAsset.js";

/**
 * The post-process graph editor.
 *
 * ## What it edits
 *
 * A `.post` document (see modules/postprocessing/postAsset.js), which is what a
 * camera's Postprocess component points at. The panel is therefore a document
 * editor with a preview target rather than a property sheet: the Graph slot
 * opens any `.post` in the project, Save writes the file, and Save As forks the
 * current canvas into a new one — so a look can be authored once and pointed at
 * by every camera that wants it.
 *
 * A camera whose component still carries the older inline `props.graph` and no
 * asset is edited in place ("Embedded" in the slot), exactly as before. Save As
 * is what converts one into a file.
 *
 * ## Live preview vs saving
 *
 * Every edit is pushed straight into the components rendering this document
 * (`applyGraph`), debounced — a post-process parameter that only takes effect
 * after a save is a parameter you cannot tune. The file is written by Save (or
 * continuously, with autosave on). Leaving with unsaved edits re-reads the file
 * into those components, so the preview never outlives the panel.
 */

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

/**
 * The engine component doesn't validate — it just builds — so an unwired
 * Output silently renders the passthrough beauty. Surface it here instead.
 */
function validate(graph) {
  if (graph.nodes.some((n) => n.type === "output")) return true;
  console.error("Post-process graph needs an Output node");
  return false;
}

const samePath = (a, b) => String(a ?? "").replaceAll("\\", "/") === String(b ?? "").replaceAll("\\", "/");

/** Every live Postprocess component rendering this `.post`. */
function componentsUsing(path) {
  const out = [];
  if (!path) return out;
  for (const entity of engine.entities?.values?.() ?? []) {
    const comp = entity.getComponent?.("postprocess");
    if (comp && samePath(comp.props?.asset, path)) out.push(comp);
  }
  return out;
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
// Save As: a name, and the folder it will land in.
// ---------------------------------------------------------------------------

/**
 * Shown as a dropdown rather than a modal because it is a two-field decision
 * (name, and a reminder of where it goes) and a modal over a graph hides the
 * thing being saved.
 */
function SaveAsPopover({ defaultName, folder, onClose, onCreate }) {
  const [name, setName] = useState(defaultName);
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onCreate(trimmed.toLowerCase().endsWith(".post") ? trimmed : `${trimmed}.post`);
  };
  return (
    <>
      <div className="dropdown-overlay" onClick={onClose} />
      <div className="dropdown-menu save-as-menu">
        <div className="node-palette-group">Save graph as</div>
        <input
          autoFocus
          className="text-field"
          type="text"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="postprocess-hint" title={folder}>
          in {folder ? basename(folder) : "the project"}
        </div>
        <button className="toolbar-btn" disabled={!trimmed} onClick={submit}>
          Create
        </button>
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

function PostprocessEditor({ entityId, docPath, onOpenDoc }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.postprocess") === "1";
    } catch {
      return false;
    }
  });
  const { screenToFlowPosition } = useReactFlow();
  // The preview and the unmount revert both run outside React's render, so
  // they read the graph through refs rather than through stale closures.
  const graphRef = useRef(null);
  const dirtyRef = useRef(false);
  const docRef = useRef(null);
  dirtyRef.current = dirty;
  docRef.current = docPath;

  const loadGraph = useCallback(
    (graph) => {
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
    },
    [setNodes, setEdges],
  );

  // --- loading ---------------------------------------------------------------

  useEffect(() => {
    let live = true;
    (async () => {
      if (docPath) {
        try {
          const json = JSON.parse(await invoke("read_text_file", { path: docPath }));
          if (!live) return;
          loadGraph(normalizePostAsset(json).graph);
        } catch (err) {
          // A `.post` that won't parse is still a file the user asked to open;
          // showing a passthrough they can overwrite beats an empty canvas
          // with no explanation of which file failed.
          console.error(`Failed to open "${docPath}": ${err?.message ?? err}`);
          if (!live) return;
          loadGraph(createPostGraph());
        }
      } else if (entityId) {
        const comp = engine.getEntity(entityId)?.getComponent?.("postprocess");
        loadGraph(normalizePostGraph(comp?.props?.graph ?? DEFAULT_POST_GRAPH));
      } else {
        loadGraph(createPostGraph());
      }
      if (live) setDirty(false);
    })();
    return () => {
      live = false;
    };
  }, [docPath, entityId, loadGraph]);

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

  // --- the current canvas, as a graph ----------------------------------------

  const graph = useMemo(() => flowToGraph(nodes, edges), [nodes, edges]);
  graphRef.current = graph;

  // --- live preview ----------------------------------------------------------

  /**
   * Push the working graph into whatever is rendering this document, so a
   * slider drag is visible while it is being dragged. Debounced because a
   * structural change recompiles the pipeline.
   *
   * Only for asset-backed docs: the embedded case has nowhere to put a graph
   * except `props.graph`, and writing that is a scene edit (an undo entry), so
   * it stays behind Apply exactly as before.
   */
  useEffect(() => {
    if (!docPath || !dirty) return undefined;
    const id = setTimeout(() => {
      for (const comp of componentsUsing(docPath)) comp.applyGraph?.(structuredClone(graphRef.current));
    }, 150);
    return () => clearTimeout(id);
  }, [docPath, dirty, nodes, edges]);

  // Unsaved edits must not outlive the panel or the document: put the
  // components back on what the file actually says.
  useEffect(
    () => () => {
      if (!dirtyRef.current || !docRef.current) return;
      for (const comp of componentsUsing(docRef.current)) comp.reloadAsset?.();
    },
    [],
  );

  // --- saving ----------------------------------------------------------------

  const apply = useCallback(async () => {
    const current = graphRef.current;
    if (!validate(current)) return;
    if (docPath) {
      await invoke("save_scene", { path: docPath, contents: serializePostAsset(current) });
      // `resolveAssetUrl` hands back a blob: URL cached by path, so a component
      // re-reading this file would get the bytes from before the save. Drop the
      // cache AND push the graph, which is what makes the save take effect now.
      invalidateBlobUrl(docPath);
      for (const comp of componentsUsing(docPath)) comp.applyGraph?.(structuredClone(current));
      setDirty(false);
      console.log(`Post graph saved: ${basename(docPath)}`);
      return;
    }
    if (!entityId) return;
    commandBus.execute(new SetComponentPropCommand(entityId, "postprocess", "graph", current));
    setDirty(false);
  }, [docPath, entityId]);

  // Autosave: debounced so transient mutations (e.g. dragging a node)
  // collapse into a single write at the end of the gesture.
  useEffect(() => {
    if (!autosave) return undefined;
    if (!dirty) return undefined;
    if (!docPath && !entityId) return undefined;
    const id = setTimeout(apply, 200);
    return () => clearTimeout(id);
  }, [autosave, nodes, edges, dirty, docPath, entityId, apply]);

  const saveAsNew = async (fileName) => {
    setSaveAsOpen(false);
    const current = graphRef.current;
    if (!validate(current)) return;
    const path = await createAssetFile(fileName, serializePostAsset(current));
    if (!path) {
      console.error("Save As needs an open project folder.");
      return;
    }
    setDirty(false);
    // The new file becomes what this camera renders — the alternative is a
    // saved graph that nothing uses and no indication of how to attach it.
    onOpenDoc(path);
  };

  const onEdgeDoubleClick = useCallback(
    (_event, edge) => {
      setDirty(true);
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges],
  );

  useEffect(() => () => setGraphHovered(false), []);

  if (!entityId && !docPath) {
    return (
      <div className="shader-graph-panel postprocess-empty">
        <div className="empty-state">
          <Sparkles size={32} />
          <h3>Pick a camera or a graph</h3>
          <p>
            Add a <code>Post Process</code> component to any camera in the scene and select that
            camera above, or open a <code>.post</code> graph from the Graph slot. New graphs come
            from Assets → right-click → New Post Process Graph.
          </p>
        </div>
      </div>
    );
  }

  const folder = useProjectStore.getState().currentPath;
  const saveLabel = docPath ? "Save" : "Apply";

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
          title={autosave ? "Autosave on — changes are written as you make them" : `Autosave off — click ${saveLabel} to commit`}
          onClick={toggleAutosave}
        >
          <Zap size={14} />
        </button>
        <button
          className={`toolbar-btn${dirty ? "" : " disabled"}`}
          disabled={!dirty}
          onClick={apply}
          title={dirty ? (docPath ? `Write ${basename(docPath)}` : "Apply to the camera") : "No pending changes"}
        >
          <Save size={14} />
          {dirty ? saveLabel : "Saved"}
        </button>
        <div className="dropdown-wrap">
          <button
            className="toolbar-btn"
            onClick={() => setSaveAsOpen((v) => !v)}
            title="Fork this graph into a new .post file"
          >
            <FilePlus2 size={14} />
            Save As
          </button>
          {saveAsOpen && (
            <SaveAsPopover
              defaultName={docPath ? basename(docPath).replace(/\.post$/i, " Copy") : "NewPostFX"}
              folder={folder}
              onClose={() => setSaveAsOpen(false)}
              onCreate={saveAsNew}
            />
          )}
        </div>
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
// Top-level panel: camera picker + document slot + editor.
// ---------------------------------------------------------------------------

export function PostprocessPanel() {
  const cameras = useCamerasWithPost();
  const [activeId, setActiveId] = useState(null);
  const [pending, setPending] = useState(null);
  // A `.post` selected in the Assets panel opens here, the same way the
  // Timeline panel follows the selected `.timeline`.
  const selectedAsset = useSelectionStore((s) => s.assetPath);
  const sceneEntities = useSceneStore((s) => s.entities);

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

  const assignedPath = sceneEntities?.[activeId]?.components?.postprocess?.asset || "";
  // A browsed `.post` wins over the camera's assignment: the user just
  // double-clicked it, and refusing to show it because the selected camera
  // uses a different one is the panel arguing with an explicit request.
  const [browsedPath, setBrowsedPath] = useState(null);
  useEffect(() => {
    if (selectedAsset && extOf(selectedAsset) === "post") setBrowsedPath(selectedAsset);
  }, [selectedAsset]);
  // Assigning a graph to the camera supersedes whatever was being browsed.
  useEffect(() => {
    setBrowsedPath(null);
  }, [assignedPath, activeId]);

  const docPath = browsedPath || assignedPath || null;

  /**
   * Opening a graph points the selected camera at it — the whole reason to
   * open one here is to see it, and a graph no camera renders shows nothing.
   * With no camera in the scene the panel is still a usable `.post` editor,
   * it just has nothing to preview through.
   */
  const openDoc = (path) => {
    setBrowsedPath(path || null);
    if (!activeId) return;
    if (samePath(assignedPath, path)) return;
    commandBus.execute(new SetComponentPropCommand(activeId, "postprocess", "asset", path || ""));
  };

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
          <span className="postprocess-hint">Graph</span>
          <AssetField
            descriptor={{ exts: ["post"], emptyLabel: "Embedded" }}
            value={docPath ?? ""}
            onCommit={openDoc}
          />
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
        <PostprocessEditor
          key={docPath ?? activeId ?? "empty"}
          entityId={activeId}
          docPath={docPath}
          onOpenDoc={openDoc}
        />
      </div>
    </ReactFlowProvider>
  );
}
