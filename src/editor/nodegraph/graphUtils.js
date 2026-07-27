/**
 * Authoring-only node types the toolkit owns. They live here rather than in
 * GraphNode.jsx so this module stays free of React — the graph transforms
 * below are pure functions and are unit-tested directly under node.
 */
export const FRAME_TYPE = "__frame";
export const REROUTE_TYPE = "__reroute";

/** Fresh props for a helper node — a panel's registry is never asked for these. */
export function helperDefaults(type) {
  if (type === FRAME_TYPE) return { title: "Comment", color: "#4d9dff", width: 320, height: 200 };
  return {};
}

/**
 * Conversion between the persisted graph JSON
 * (`{nodes:[{id,type,props,position}], edges:[{source,sourceHandle,target,targetHandle}]}`)
 * and React Flow's node/edge shape, plus the pass that strips authoring-only
 * helpers before a graph reaches a compiler.
 *
 * Both editors persisted their own near-identical copies of the first two
 * functions; they live here now so a fix (e.g. edge id stability) lands once.
 */

export function graphToFlow(graph, { knownType } = {}) {
  const nodes = (graph?.nodes ?? [])
    .filter((n) => n.type === FRAME_TYPE || n.type === REROUTE_TYPE || !knownType || knownType(n.type))
    .map((n) => ({
      id: n.id,
      type: n.type === FRAME_TYPE || n.type === REROUTE_TYPE ? n.type : "graphNode",
      position: n.position ?? { x: 0, y: 0 },
      data: { nodeType: n.type, props: n.props ?? {} },
      // Frames sit behind everything and must not swallow clicks meant for the
      // nodes drawn on top of them.
      ...(n.type === FRAME_TYPE
        ? { style: { width: n.props?.width ?? 320, height: n.props?.height ?? 200 }, zIndex: -1, selectable: true }
        : {}),
    }));
  const edges = (graph?.edges ?? []).map((e, i) => ({
    id: e.id ?? `e${i}-${e.source}-${e.sourceHandle ?? "out"}-${e.target}-${e.targetHandle}`,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out",
    target: e.target,
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

export function flowToGraph(nodes, edges) {
  return {
    nodes: nodes.map((n) => {
      const props = { ...n.data.props };
      // A resized frame carries its box in `style`; fold it back into props so
      // it survives a save/load round-trip.
      if (n.data.nodeType === FRAME_TYPE) {
        props.width = Math.round(n.width ?? n.style?.width ?? 320);
        props.height = Math.round(n.height ?? n.style?.height ?? 200);
      }
      return { id: n.id, type: n.data.nodeType, props, position: n.position };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

/**
 * Removes authoring-only nodes so a compiler never sees them:
 *
 *  - **frames** are pure annotation and are simply dropped;
 *  - **reroutes** are collapsed — every edge arriving at a reroute's output is
 *    rewired straight to the original upstream source, following chains of
 *    reroutes to their real origin.
 *
 * Callers run this immediately before compiling. The *saved* graph keeps both,
 * so a user's layout and comments survive a reload.
 */
export function stripHelpers(graph) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const helpers = new Set(nodes.filter((n) => n.type === FRAME_TYPE || n.type === REROUTE_TYPE).map((n) => n.id));
  if (!helpers.size) return graph;

  const reroutes = new Set(nodes.filter((n) => n.type === REROUTE_TYPE).map((n) => n.id));
  const incoming = new Map(); // rerouteId -> feeding edge
  for (const e of edges) if (reroutes.has(e.target)) incoming.set(e.target, e);

  /** Walks back through reroute chains to the first real producer. */
  const origin = (nodeId, handle, seen = new Set()) => {
    if (!reroutes.has(nodeId)) return { source: nodeId, sourceHandle: handle };
    if (seen.has(nodeId)) return null; // reroute loop — drop the wire
    seen.add(nodeId);
    const feed = incoming.get(nodeId);
    if (!feed) return null; // dangling reroute feeds nothing
    return origin(feed.source, feed.sourceHandle ?? "out", seen);
  };

  const out = [];
  for (const e of edges) {
    if (helpers.has(e.target)) continue; // edge INTO a helper: resolved above
    const from = origin(e.source, e.sourceHandle ?? "out");
    if (!from) continue;
    out.push({ ...e, source: from.source, sourceHandle: from.sourceHandle });
  }
  return { ...graph, nodes: nodes.filter((n) => !helpers.has(n.id)), edges: out };
}

/** Nodes whose box contains `frame`'s box — the set a frame drag carries. */
export function nodesInsideFrame(frame, nodes) {
  const fx = frame.position.x;
  const fy = frame.position.y;
  const fw = frame.width ?? frame.style?.width ?? 320;
  const fh = frame.height ?? frame.style?.height ?? 200;
  return nodes.filter((n) => {
    if (n.id === frame.id || n.data?.nodeType === FRAME_TYPE) return false;
    const w = n.measured?.width ?? n.width ?? 150;
    const h = n.measured?.height ?? n.height ?? 60;
    return n.position.x >= fx && n.position.y >= fy && n.position.x + w <= fx + fw && n.position.y + h <= fy + fh;
  });
}
