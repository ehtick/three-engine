import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./nodegraph.css";
import { Plus, Undo2, Redo2, Map as MapIcon, Grid3x3, StickyNote, Maximize2 } from "lucide-react";
import { setGraphHovered, isPointerInside } from "./graphContext.js";
import { sharedNodeTypes } from "./GraphNode.jsx";
import { NodePalette, noteRecent } from "./palette.jsx";
import { createGraphHistory } from "./history.js";
import { ContextMenu } from "../ContextMenu.jsx";
import { copySelection, pasteClipboard, duplicateSelection } from "./clipboard.js";
import { makeConnectionValidator, wouldCycle } from "./socketTypes.js";
import {
  graphToFlow,
  flowToGraph,
  nodesInsideFrame,
  helperDefaults,
  FRAME_TYPE,
  REROUTE_TYPE,
} from "./graphUtils.js";

/**
 * The React Flow shell every node-graph editor sits on.
 *
 * It owns all *interaction* — undo/redo, clipboard, palette, frames, reroutes,
 * minimap, snapping, connection validation, edge reconnect — and knows nothing
 * about shaders or particles. A panel supplies a `registry` describing its node
 * types and receives `onChange(graph, meta)` whenever the graph changes; `meta`
 * distinguishes a value tweak from a structural edit so the panel can decide
 * between patching a live uniform and paying for a recompile.
 *
 * `registry`:
 *   describe(type)      → {label, cat, inputs, outputs, params}  (see GraphNode)
 *   items               → palette entries [{type,label,cat,catLabel,inputTypes,outputTypes}]
 *   defaults(type)      → fresh props object
 *   protectedTypes      → node types the user may not delete or copy
 *   guardRemove(nodes, ids) → optional extra veto (e.g. "keep one System node")
 */

const SNAP = [10, 10];

/** Below this, a container is a dock tab that hasn't been given space yet —
 *  fitting against it produces a nonsense zoom, so we wait. */
const MIN_FITTABLE = 80;

const FIT_OPTIONS = { padding: 0.22, maxZoom: 1 };

function makeNodeId(type) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`;
}

const isHelper = (type) => type === FRAME_TYPE || type === REROUTE_TYPE;

export const GraphEditor = forwardRef(function GraphEditor(
  {
    kind,
    registry,
    initialGraph,
    onChange,
    toolbar = null,
    overlay = null,
    hint = null,
    canPreview = false,
    registerThumb = null,
    nodeErrors = null,
  },
  ref,
) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(null);
  const [nodeMenu, setNodeMenu] = useState(null);
  const [showMinimap, setShowMinimap] = useState(() => localStorage.getItem(`engine.graph.minimap.${kind}`) === "1");
  const [snap, setSnap] = useState(() => localStorage.getItem(`engine.graph.snap.${kind}`) === "1");
  // `history` is a plain mutable object, so nothing re-renders when its stacks
  // change. Bumping this counter after every mutation is what keeps the
  // Undo/Redo buttons' disabled state honest.
  const [, setHistoryTick] = useState(0);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  // Bumped whenever a graph is loaded; the fit effect below compares it against
  // what it last fitted so a preset load re-frames but an ordinary edit doesn't.
  const [fitToken, setFitToken] = useState(0);
  const fittedRef = useRef(-1);
  /** Container size at the moment of the last successful fit. */
  const fittedSizeRef = useRef({ width: 0, height: 0 });
  /** True once the user has panned or zoomed by hand; suppresses auto-refit so
   *  we never yank away a view they deliberately set. */
  const userMovedRef = useRef(false);

  const history = useRef(createGraphHistory()).current;
  const wrapRef = useRef(null);
  const loadedRef = useRef(false);
  /** Live mirror of nodes/edges for callbacks that must not be re-created on
   *  every graph change (keyboard handler, drag handlers) — reading state
   *  through a ref keeps those listeners stable and avoids re-binding them
   *  dozens of times a second during a drag. */
  const live = useRef({ nodes: [], edges: [] });
  live.current = { nodes, edges };
  const connectStart = useRef(null);
  const frameDrag = useRef(null);

  // Guard against a stale hover flag if the panel unmounts while the pointer is
  // still over it (dockview close, tab switch) — otherwise the global Delete
  // shortcut keeps deferring to a graph that no longer exists.
  useEffect(() => () => setGraphHovered(false), []);

  const emit = useCallback(
    (nextNodes, nextEdges, meta) => {
      onChange?.(flowToGraph(nextNodes, nextEdges), meta);
    },
    [onChange],
  );

  /** Commits a graph mutation: updates state, records history, notifies. */
  const commit = useCallback(
    (nextNodes, nextEdges, meta = {}) => {
      setNodes(nextNodes);
      setEdges(nextEdges);
      history.push(nextNodes, nextEdges, meta.gesture ? `${meta.nodeId ?? ""}:${meta.param ?? ""}` : null);
      setHistoryTick((t) => t + 1);
      emit(nextNodes, nextEdges, meta);
    },
    [setNodes, setEdges, history, emit],
  );

  const load = useCallback(
    (graph, { record = false } = {}) => {
      const flow = graphToFlow(graph, { knownType: (t) => !!registry.describe(t) });
      setNodes(flow.nodes);
      setEdges(flow.edges);
      if (record) {
        history.push(flow.nodes, flow.edges, null);
        emit(flow.nodes, flow.edges, { kind: "structure", reason: "load" });
      } else {
        history.reset(flow.nodes, flow.edges);
      }
      setHistoryTick((t) => t + 1);
      setFitToken((t) => t + 1);
      loadedRef.current = true;
    },
    [registry, setNodes, setEdges, history, emit],
  );

  useImperativeHandle(ref, () => ({ load, getGraph: () => flowToGraph(live.current.nodes, live.current.edges) }), [load]);

  useEffect(() => {
    load(initialGraph);
  }, [initialGraph]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Frame the graph once it is actually measurable.
   *
   * React Flow's `fitView` PROP fits exactly once, during init, against
   * whatever the container measured at that instant. Inside dockview that is
   * routinely wrong: a panel's content mounts before its group has been sized,
   * so the fit is computed against a near-zero box and produces an absurd zoom
   * — the symptom is the whole graph rendered as a postage stamp in the top-left
   * corner. Fitting also has to wait for `useNodesInitialized`, because before
   * the nodes are measured their bounds are all zero-sized and the fit lands on
   * a point rather than the graph.
   *
   * So: fit imperatively when (a) the nodes are measured, (b) the container has
   * a believable size, and (c) we haven't already fitted this graph load.
   */
  useEffect(() => {
    if (!nodesInitialized || fittedRef.current === fitToken) return;
    const el = wrapRef.current;
    if (!el || el.clientWidth < MIN_FITTABLE || el.clientHeight < MIN_FITTABLE) return;
    fittedRef.current = fitToken;
    fittedSizeRef.current = { width: el.clientWidth, height: el.clientHeight };
    userMovedRef.current = false;
    fitView({ ...FIT_OPTIONS, duration: 0 });
  }, [nodesInitialized, fitToken, fitView, nodes.length]);

  /**
   * A dock tab that was hidden (or dragged to nothing) reports a zero-ish box;
   * when it finally gets real space, re-run the fit that could not happen
   * before.
   *
   * DEBOUNCED, and that matters: a dock panel does not jump from 0 to its final
   * size, it passes through every intermediate height as the layout settles.
   * Refitting on the first frame that clears MIN_FITTABLE fits against a ~90px
   * strip and leaves the graph at a 0.12 zoom for a panel that ends up 300px
   * tall. Waiting for the size to stop changing fits against the real box.
   *
   * Only the collapsed→usable transition triggers a refit, so a user
   * deliberately resizing a visible panel never has their framing yanked away.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const usableNow = () => el.clientWidth >= MIN_FITTABLE && el.clientHeight >= MIN_FITTABLE;
    let wasUsable = usableNow();
    let timer = null;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const usable = usableNow();
        const fitted = fittedSizeRef.current;
        // A panel that mounted at 90px and settled at 300px never crosses the
        // collapsed→usable edge, so growth is checked too — otherwise the graph
        // stays framed for the strip it briefly was.
        const grew =
          el.clientWidth > fitted.width * 1.35 || el.clientHeight > fitted.height * 1.35;
        if (usable && (!wasUsable || (grew && !userMovedRef.current))) {
          fittedRef.current = -1; // force the fit effect above to run again
          setFitToken((t) => t + 1);
        }
        wasUsable = usable;
      }, 160);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // --- props editing -------------------------------------------------------

  const handlePropsChange = useCallback(
    (nodeId, patch, meta = {}) => {
      // Preview / collapse change the node's natural box. Drop any explicit
      // width/height React Flow may have stamped on so the wrapper can
      // shrink-wrap again (otherwise Texture keeps a hollow shell).
      const relayout = patch.__thumb !== undefined || patch.__collapsed !== undefined;
      const next = live.current.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const updated = {
          ...n,
          data: { ...n.data, props: { ...n.data.props, ...patch } },
        };
        if (relayout) {
          delete updated.width;
          delete updated.height;
          if (updated.style) {
            const { width: _w, height: _h, ...rest } = updated.style;
            updated.style = Object.keys(rest).length ? rest : undefined;
          }
        }
        return updated;
      });
      commit(next, live.current.edges, { kind: "props", nodeId, patch, ...meta });
    },
    [commit],
  );

  // --- socket typing / validation -----------------------------------------

  const resolveTypes = useCallback(
    (nodeId) => {
      const node = live.current.nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      // A reroute is type-agnostic by construction: it forwards whatever it was
      // given, so it must never veto a connection.
      if (isHelper(node.data.nodeType)) return { outType: () => "any", inType: () => "any" };
      const def = registry.describe(node.data.nodeType);
      if (!def) return null;
      return {
        outType: (handle) => (def.outputs ?? []).find((o) => o.key === handle)?.type ?? def.out ?? "any",
        inType: (handle) => (def.inputs ?? []).find((i) => i.key === handle)?.type ?? "any",
      };
    },
    [registry],
  );

  const isValidConnection = useMemo(() => {
    const typeCheck = makeConnectionValidator(resolveTypes);
    return (connection) => {
      // Cycles hang the compilers' recursive build walk — both memoize per node
      // rather than per path, so a loop recurses until the stack blows.
      if (wouldCycle(live.current.edges, connection.source, connection.target)) return false;
      return typeCheck(connection);
    };
  }, [resolveTypes]);

  // --- connections ---------------------------------------------------------

  /** One wire per input handle: connecting replaces whatever was there. */
  const attach = useCallback((eds, connection) =>
    addEdge(
      connection,
      eds.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
    ),
  []);

  const onConnect = useCallback(
    (connection) => {
      commit(live.current.nodes, attach(live.current.edges, connection), { kind: "structure", reason: "connect" });
    },
    [commit, attach],
  );

  const onConnectStart = useCallback((_event, params) => {
    connectStart.current = params;
  }, []);

  /**
   * Releasing a wire on empty canvas opens the palette filtered to nodes that
   * can accept (or produce) that socket's type, and auto-wires whatever the
   * user picks. This is the fastest way to extend a graph — no hunting for the
   * node, then dragging the wire a second time.
   */
  const onConnectEnd = useCallback(
    (event, connectionState) => {
      const start = connectStart.current;
      connectStart.current = null;
      if (!start || connectionState?.toNode) return;
      const resolver = resolveTypes(start.nodeId);
      const type =
        start.handleType === "source"
          ? (resolver?.outType(start.handleId) ?? "any")
          : (resolver?.inType(start.handleId) ?? "any");
      const point = event.changedTouches?.[0] ?? event;
      setCanvasMenu({
        x: point.clientX,
        y: point.clientY,
        filter: { direction: start.handleType, type },
        autoWire: start,
      });
    },
    [resolveTypes],
  );

  // Drag an existing edge's end away from a socket to reconnect it, or drop it
  // on empty canvas to disconnect. `reconnectSuccessful` distinguishes a
  // completed reconnect (handled in onReconnect) from a drop-to-delete.
  const reconnectSuccessful = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge, connection) => {
      reconnectSuccessful.current = true;
      const kept = live.current.edges.filter((e) => e.id !== oldEdge.id);
      commit(live.current.nodes, attach(kept, connection), { kind: "structure", reason: "reconnect" });
    },
    [commit, attach],
  );
  const onReconnectEnd = useCallback(
    (_event, edge) => {
      if (!reconnectSuccessful.current) {
        commit(
          live.current.nodes,
          live.current.edges.filter((e) => e.id !== edge.id),
          { kind: "structure", reason: "disconnect" },
        );
      }
      reconnectSuccessful.current = true;
    },
    [commit],
  );

  /** Double-clicking a wire deletes it. Alt+double-click drops a reroute pin
   *  instead — routing a long connection around a dense graph is still
   *  possible, but the common gesture is the destructive one. */
  const onEdgeDoubleClick = useCallback(
    (event, edge) => {
      if (!event.altKey) {
        commit(live.current.nodes, live.current.edges.filter((e) => e.id !== edge.id), {
          kind: "structure",
          reason: "disconnect",
        });
        return;
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = makeNodeId("reroute");
      const node = {
        id,
        type: REROUTE_TYPE,
        position: { x: position.x - 7, y: position.y - 7 },
        data: { nodeType: REROUTE_TYPE, props: {} },
      };
      const rest = live.current.edges.filter((e) => e.id !== edge.id);
      commit(
        [...live.current.nodes, node],
        [
          ...rest,
          { id: `e-${edge.source}-${id}`, source: edge.source, sourceHandle: edge.sourceHandle, target: id, targetHandle: "in" },
          { id: `e-${id}-${edge.target}`, source: id, sourceHandle: "out", target: edge.target, targetHandle: edge.targetHandle },
        ],
        { kind: "structure", reason: "reroute" },
      );
    },
    [commit, screenToFlowPosition],
  );

  const onEdgeContextMenu = useCallback(
    (event, edge) => {
      event.preventDefault();
      commit(live.current.nodes, live.current.edges.filter((e) => e.id !== edge.id), {
        kind: "structure",
        reason: "disconnect",
      });
    },
    [commit],
  );

  // --- node changes / deletion guard --------------------------------------

  const guardedNodesChange = useCallback(
    (changes) => {
      const current = live.current.nodes;
      const removeIds = changes.filter((c) => c.type === "remove").map((c) => c.id);
      let allowed = changes;
      if (removeIds.length) {
        const blocked = new Set(
          removeIds.filter((id) => {
            const type = current.find((n) => n.id === id)?.data.nodeType;
            return registry.protectedTypes?.includes(type);
          }),
        );
        const extra = registry.guardRemove?.(current, removeIds.filter((id) => !blocked.has(id))) ?? [];
        for (const id of extra) blocked.add(id);
        allowed = changes.filter((c) => !(c.type === "remove" && blocked.has(c.id)));
      }

      const structural = allowed.some((c) => c.type === "remove" || c.type === "add");
      const moved = allowed.some((c) => c.type === "position" && c.dragging === false);
      onNodesChange(allowed);
      if (!structural && !moved) return;
      // React Flow applies changes asynchronously relative to us, so recompute
      // the post-change list here rather than reading stale state.
      setNodes((applied) => {
        history.push(applied, live.current.edges, null);
        setHistoryTick((t) => t + 1);
        emit(applied, live.current.edges, { kind: structural ? "structure" : "position" });
        return applied;
      });
    },
    [onNodesChange, setNodes, registry, history, emit],
  );

  const guardedEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
      if (!changes.some((c) => c.type === "remove")) return;
      setEdges((applied) => {
        history.push(live.current.nodes, applied, null);
        setHistoryTick((t) => t + 1);
        emit(live.current.nodes, applied, { kind: "structure", reason: "disconnect" });
        return applied;
      });
    },
    [onEdgesChange, setEdges, history, emit],
  );

  // --- frames carry their contents ----------------------------------------

  const onNodeDragStart = useCallback((_event, node) => {
    if (node.data?.nodeType !== FRAME_TYPE) return;
    frameDrag.current = {
      id: node.id,
      origin: { ...node.position },
      contained: nodesInsideFrame(node, live.current.nodes).map((n) => ({ id: n.id, position: { ...n.position } })),
    };
  }, []);

  const onNodeDrag = useCallback(
    (_event, node) => {
      const drag = frameDrag.current;
      if (!drag || drag.id !== node.id) return;
      const dx = node.position.x - drag.origin.x;
      const dy = node.position.y - drag.origin.y;
      const byId = new Map(drag.contained.map((c) => [c.id, c]));
      setNodes((nds) =>
        nds.map((n) => {
          const c = byId.get(n.id);
          return c ? { ...n, position: { x: c.position.x + dx, y: c.position.y + dy } } : n;
        }),
      );
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback(() => {
    frameDrag.current = null;
    history.endGesture();
  }, [history]);

  // --- adding nodes --------------------------------------------------------

  const addNode = useCallback(
    (type, screenPos, autoWire = null) => {
      setMenuOpen(false);
      setCanvasMenu(null);
      // No explicit position (the toolbar's Add menu) → the visible center of
      // the canvas. `screenToFlowPosition` takes PAGE-client coordinates, so
      // the wrapper's own width/2 is only correct when the panel happens to sit
      // at the page origin — docked anywhere else, nodes spawned off-screen.
      const rect = wrapRef.current?.getBoundingClientRect();
      const position = screenPos
        ? screenToFlowPosition({ x: screenPos.x, y: screenPos.y })
        : screenToFlowPosition({
            x: (rect?.left ?? 0) + (rect?.width ?? 1200) / 2,
            y: (rect?.top ?? 0) + (rect?.height ?? 800) / 2,
          });
      const id = makeNodeId(type);
      const node = {
        id,
        type: isHelper(type) ? type : "graphNode",
        position,
        data: { nodeType: type, props: isHelper(type) ? helperDefaults(type) : registry.defaults(type) },
        ...(type === FRAME_TYPE ? { style: { width: 320, height: 200 }, zIndex: -1 } : {}),
      };
      let nextEdges = live.current.edges;
      if (autoWire) {
        const def = registry.describe(type);
        // Wire into the first port whose type actually accepts the dropped
        // wire, not blindly the first port — dropping a colour on a Mix node
        // should land on `a`, not on its float `t`.
        const resolver = resolveTypes(autoWire.nodeId);
        if (autoWire.handleType === "source") {
          const from = resolver?.outType(autoWire.handleId) ?? "any";
          const port = (def?.inputs ?? []).find((i) => isValidConnection({
            source: autoWire.nodeId, sourceHandle: autoWire.handleId, target: id, targetHandle: i.key,
          })) ?? def?.inputs?.[0];
          if (port) {
            nextEdges = attach(nextEdges, {
              source: autoWire.nodeId,
              sourceHandle: autoWire.handleId,
              target: id,
              targetHandle: port.key,
            });
          }
          void from;
        } else {
          const port = (def?.outputs ?? [])[0];
          if (port) {
            nextEdges = attach(nextEdges, {
              source: id,
              sourceHandle: port.key,
              target: autoWire.nodeId,
              targetHandle: autoWire.handleId,
            });
          }
        }
      }
      commit([...live.current.nodes, node], nextEdges, { kind: "structure", reason: "add" });
    },
    [registry, screenToFlowPosition, commit, attach, resolveTypes, isValidConnection],
  );

  // --- clipboard + history keyboard ---------------------------------------

  const applyRestored = useCallback(
    (state) => {
      if (!state) return;
      setNodes(state.nodes);
      setEdges(state.edges);
      setHistoryTick((t) => t + 1);
      emit(state.nodes, state.edges, { kind: "structure", reason: "history" });
    },
    [setNodes, setEdges, emit],
  );

  // The selection operations, shared by the Ctrl-key handler below and the
  // node right-click menu. `protectedTypes` (the Material Output and friends)
  // are never cut or deleted — a graph without one can't compile and there is
  // no UI to bring it back.
  const removable = useCallback(
    () =>
      live.current.nodes.filter(
        (n) => n.selected && !registry.protectedTypes?.includes(n.data.nodeType),
      ),
    [registry],
  );

  const copyNodes = useCallback(
    () =>
      copySelection(kind, live.current.nodes, live.current.edges, {
        protectedTypes: registry.protectedTypes,
      }),
    [kind, registry],
  );

  const deleteNodes = useCallback(() => {
    const gone = new Set(removable().map((n) => n.id));
    if (!gone.size) return;
    commit(
      live.current.nodes.filter((n) => !gone.has(n.id)),
      live.current.edges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target)),
      { kind: "structure", reason: "delete" },
    );
  }, [commit, removable]);

  const cutNodes = useCallback(() => {
    if (copyNodes()) deleteNodes();
  }, [copyNodes, deleteNodes]);

  const pasteNodes = useCallback(
    (at = null) => {
      const pasted = pasteClipboard(kind, at ? { at } : {});
      if (!pasted) return;
      commit(
        [...live.current.nodes.map((n) => ({ ...n, selected: false })), ...pasted.nodes],
        [...live.current.edges, ...pasted.edges],
        { kind: "structure", reason: "paste" },
      );
    },
    [kind, commit],
  );

  const duplicateNodes = useCallback(() => {
    const dup = duplicateSelection(kind, live.current.nodes, live.current.edges, {
      protectedTypes: registry.protectedTypes,
    });
    if (!dup) return;
    commit(
      [...live.current.nodes.map((n) => ({ ...n, selected: false })), ...dup.nodes],
      [...live.current.edges, ...dup.edges],
      { kind: "structure", reason: "duplicate" },
    );
  }, [kind, registry, commit]);

  const nodeMenuItems = useCallback(
    ({ node }) => {
      const count = live.current.nodes.filter((n) => n.selected).length;
      const suffix = count > 1 ? ` (${count})` : "";
      const nodeProps = node.data?.props ?? {};
      const collapsed = !!nodeProps.__collapsed;
      const previewable = canPreview && !registry.describe(node.data.nodeType)?.noPreview;
      const locked = registry.protectedTypes?.includes(node.data.nodeType);
      return [
        {
          label: collapsed ? "Expand" : "Collapse",
          action: () => handlePropsChange(node.id, { __collapsed: !collapsed }),
        },
        previewable && {
          label: nodeProps.__thumb ? "Hide Preview" : "Show Preview",
          action: () => handlePropsChange(node.id, { __thumb: !nodeProps.__thumb }),
        },
        { separator: true },
        { label: `Copy${suffix}`, shortcut: "Ctrl+C", action: copyNodes },
        { label: `Cut${suffix}`, shortcut: "Ctrl+X", disabled: locked, action: cutNodes },
        { label: `Duplicate${suffix}`, shortcut: "Ctrl+D", action: duplicateNodes },
        { separator: true },
        {
          label: `Delete${suffix}`,
          shortcut: "Del",
          danger: true,
          disabled: locked,
          hint: locked ? "This node is required for the graph to compile" : undefined,
          action: deleteNodes,
        },
      ];
    },
    [canPreview, registry, handlePropsChange, copyNodes, cutNodes, duplicateNodes, deleteNodes],
  );

  useEffect(() => {
    const onKeyDown = (e) => {
      // Only act when this graph is the thing the user is pointing at, and
      // never while they're typing into one of its fields. `:hover` alone is
      // not enough — a dropdown's full-screen overlay steals it (see
      // graphContext.js), so fall back to a geometric pointer test.
      if (
        !wrapRef.current?.contains(document.activeElement) &&
        !wrapRef.current?.matches(":hover") &&
        !isPointerInside(wrapRef.current)
      ) {
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        // Bare F frames the graph — the standard 3D-app shortcut, and the
        // escape hatch when a panel opens badly framed.
        if (key === "f") {
          e.preventDefault();
          fitView({ ...FIT_OPTIONS, duration: 180 });
        }
        return;
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        applyRestored(history.undo());
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        applyRestored(history.redo());
      } else if (key === "c") {
        copyNodes();
      } else if (key === "x") {
        cutNodes();
      } else if (key === "v") {
        pasteNodes();
      } else if (key === "d") {
        e.preventDefault();
        duplicateNodes();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [history, applyRestored, fitView, copyNodes, cutNodes, pasteNodes, duplicateNodes]);

  // --- drag a node type from the palette onto the canvas -------------------

  const onDrop = useCallback(
    (event) => {
      const type = event.dataTransfer.getData("application/nodegraph-type");
      if (!type) return;
      event.preventDefault();
      noteRecent(kind, type);
      addNode(type, { x: event.clientX, y: event.clientY });
    },
    [addNode, kind],
  );

  // --- rendered node data --------------------------------------------------

  const nodesWithHandlers = useMemo(
    () =>
      nodes.map((n) => {
        const connectedHandles = new Set(edges.filter((e) => e.target === n.id).map((e) => e.targetHandle));
        return {
          ...n,
          data: {
            ...n.data,
            describe: registry.describe,
            onPropsChange: handlePropsChange,
            connectedHandles,
            registerThumb,
            canPreview,
            error: nodeErrors?.[n.id] ?? null,
          },
        };
      }),
    [nodes, edges, registry, handlePropsChange, registerThumb, canPreview, nodeErrors],
  );

  const toggleMinimap = () => {
    setShowMinimap((v) => {
      localStorage.setItem(`engine.graph.minimap.${kind}`, v ? "0" : "1");
      return !v;
    });
  };
  const toggleSnap = () => {
    setSnap((v) => {
      localStorage.setItem(`engine.graph.snap.${kind}`, v ? "0" : "1");
      return !v;
    });
  };

  return (
    <div className="shader-graph-panel">
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}>
            <Plus size={14} />
            Node
          </button>
          {menuOpen && (
            <NodePalette
              kind={kind}
              items={registry.items}
              onPick={(type) => addNode(type)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
        <button
          className="toolbar-btn icon-only"
          title="Undo (Ctrl+Z)"
          disabled={!history.canUndo}
          onClick={() => applyRestored(history.undo())}
        >
          <Undo2 size={14} />
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!history.canRedo}
          onClick={() => applyRestored(history.redo())}
        >
          <Redo2 size={14} />
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Frame all nodes (F)"
          onClick={() => fitView({ ...FIT_OPTIONS, duration: 180 })}
        >
          <Maximize2 size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="Add comment frame" onClick={() => addNode(FRAME_TYPE)}>
          <StickyNote size={14} />
        </button>
        <button
          className={`toolbar-btn icon-only${snap ? " active" : ""}`}
          title="Snap to grid"
          onClick={toggleSnap}
        >
          <Grid3x3 size={14} />
        </button>
        <button
          className={`toolbar-btn icon-only${showMinimap ? " active" : ""}`}
          title="Minimap"
          onClick={toggleMinimap}
        >
          <MapIcon size={14} />
        </button>
        {toolbar}
      </div>

      <div
        className="shader-graph-canvas"
        ref={wrapRef}
        onMouseEnter={() => setGraphHovered(true)}
        onMouseLeave={() => setGraphHovered(false)}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
      >
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          nodeTypes={sharedNodeTypes}
          onNodesChange={guardedNodesChange}
          onEdgesChange={guardedEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onReconnect={onReconnect}
          onReconnectStart={onReconnectStart}
          onReconnectEnd={onReconnectEnd}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onEdgeContextMenu={onEdgeContextMenu}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          isValidConnection={isValidConnection}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            // Otherwise the editor-wide fallback menu opens on top of the
            // node palette.
            e.stopPropagation();
            setCanvasMenu({ x: e.clientX, y: e.clientY });
          }}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            e.stopPropagation();
            // Right-clicking outside the selection makes that node the
            // selection, so the menu always acts on what's highlighted.
            if (!node.selected) {
              setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
              live.current.nodes = live.current.nodes.map((n) => ({
                ...n,
                selected: n.id === node.id,
              }));
            }
            setNodeMenu({ x: e.clientX, y: e.clientY, node });
          }}
          // React Flow passes the source event for user-driven pans/zooms and
          // null for programmatic ones (our own fitView) — that distinction is
          // what lets auto-refit back off once the user has framed things.
          onMoveStart={(event) => {
            if (event) userMovedRef.current = true;
          }}
          snapToGrid={snap}
          snapGrid={SNAP}
          deleteKeyCode={["Delete", "Backspace"]}
          colorMode="dark"
          fitView
          fitViewOptions={FIT_OPTIONS}
          minZoom={0.12}
          maxZoom={2.5}
          // Left or middle button pans; Shift+drag box-selects (React Flow's
          // default `selectionKeyCode`). The right button is deliberately NOT
          // in this list: React Flow's Pane `onContextMenu` returns EARLY when
          // `panOnDrag` includes button 2, so `onPaneContextMenu` never fires
          // and right-click-to-add-a-node silently stops working.
          panOnDrag={[0, 1]}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
          {showMinimap && (
            <MiniMap pannable zoomable className="graph-minimap" nodeStrokeWidth={2} maskColor="rgba(13,14,17,0.72)" />
          )}
        </ReactFlow>
        {overlay}
        {canvasMenu && (
          <NodePalette
            kind={kind}
            items={registry.items}
            filter={canvasMenu.filter}
            style={{ left: canvasMenu.x, top: canvasMenu.y }}
            onPick={(type) => addNode(type, canvasMenu, canvasMenu.autoWire)}
            onClose={() => setCanvasMenu(null)}
          />
        )}
        {nodeMenu && (
          <ContextMenu
            x={nodeMenu.x}
            y={nodeMenu.y}
            items={nodeMenuItems(nodeMenu)}
            onClose={() => setNodeMenu(null)}
          />
        )}
      </div>

      {hint && <div className="shader-graph-hint">{hint}</div>}
    </div>
  );
});
