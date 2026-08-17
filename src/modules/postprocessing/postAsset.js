/**
 * Post-process graph assets (`.post`): one node graph serialized as JSON.
 *
 *   {
 *     version: 1,
 *     graph: {
 *       nodes: [{ id, type, props, position }],
 *       edges: [{ id, source, sourceHandle, target, targetHandle }]
 *     }
 *   }
 *
 * ## Why a file and not a component prop
 *
 * The graph used to live inline in `postprocess.props.graph`, which meant a
 * look — "filmic grade, bloom, a touch of grain" — belonged to exactly one
 * camera in exactly one scene. Every other camera that wanted it got a
 * copy-paste, and the copies drifted. As a document it is authored once,
 * referenced by any number of cameras across any number of scenes, and diffs
 * as its own file in source control instead of as a blob inside a `.scene`.
 *
 * Inline graphs still load (`PostprocessComponent` falls back to `props.graph`
 * when no asset is assigned), so scenes authored before this exist keep
 * rendering; the panel's "Save As" is what converts one into a file.
 *
 * ## Deliberately free of `three`
 *
 * `postGraph.js` imports `three/tsl` at module scope — it is the compiler. This
 * module is the *format*, so the Assets panel, the exporter and `node --test`
 * can read, write and validate a `.post` without pulling a renderer in behind
 * it. `postGraph.js` re-exports `DEFAULT_POST_GRAPH` from here so there is one
 * definition of "what a fresh graph is".
 */

export const POST_VERSION = 1;
export const POST_EXT = "post";

/**
 * A one-node passthrough (Color → Output), so a freshly created graph renders
 * the scene unchanged rather than black. Every "new graph" path starts here:
 * the Assets panel's New Post Process Graph, a component with nothing
 * assigned, and a `.post` file that turns out to be empty.
 */
export const DEFAULT_POST_GRAPH = {
  nodes: [
    { id: "input", type: "input", props: {}, position: { x: 80, y: 160 } },
    { id: "output", type: "output", props: {}, position: { x: 480, y: 180 } },
  ],
  edges: [{ source: "input", sourceHandle: "color", target: "output", targetHandle: "color" }],
};

/** A fresh, independently mutable passthrough graph. */
export function createPostGraph() {
  return structuredClone(DEFAULT_POST_GRAPH);
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const point = (p) => ({
  x: Number.isFinite(p?.x) ? p.x : 0,
  y: Number.isFinite(p?.y) ? p.y : 0,
});

/**
 * Coerces a graph into the shape the compiler and the editor both assume.
 *
 * Everything here defends against a file rather than against our own writer:
 * a `.post` is plain JSON in the project, so it can be hand-edited, merged by
 * git, or written by an agent through `post.set`. The compiler walks edges
 * without checking that their endpoints exist, so a dangling edge — the normal
 * result of deleting a node in a text editor — would throw at build time with a
 * message about a missing node id rather than about the file. Dropping them
 * here turns a crash into a graph that is merely missing a wire.
 */
export function normalizePostGraph(graph) {
  const nodes = [];
  const seen = new Set();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (!isObject(node) || typeof node.id !== "string" || typeof node.type !== "string") continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push({
      id: node.id,
      type: node.type,
      props: isObject(node.props) ? { ...node.props } : {},
      position: point(node.position),
    });
  }
  if (!nodes.length) return createPostGraph();

  const edges = [];
  for (const [i, edge] of (Array.isArray(graph?.edges) ? graph.edges : []).entries()) {
    if (!isObject(edge)) continue;
    if (!seen.has(edge.source) || !seen.has(edge.target)) continue;
    const sourceHandle = edge.sourceHandle ?? null;
    const targetHandle = edge.targetHandle ?? null;
    edges.push({
      id: typeof edge.id === "string" && edge.id ? edge.id : `e${i}-${edge.source}.${sourceHandle}->${edge.target}.${targetHandle}`,
      source: edge.source,
      sourceHandle,
      target: edge.target,
      targetHandle,
    });
  }
  return { nodes, edges };
}

/**
 * Parses a `.post` document. Accepts the versioned envelope AND a bare
 * `{ nodes, edges }` — an inline graph lifted out of a `.scene` by hand is the
 * obvious first thing anyone tries, and rejecting it would be pedantry.
 */
export function normalizePostAsset(json) {
  const graph = isObject(json) && isObject(json.graph) ? json.graph : json;
  return {
    version: POST_VERSION,
    name: typeof json?.name === "string" ? json.name : "",
    graph: normalizePostGraph(graph),
  };
}

/** The document text to write for `graph`. */
export function serializePostAsset(graph, { name = "" } = {}) {
  const doc = { version: POST_VERSION, ...(name ? { name } : {}), graph: normalizePostGraph(graph) };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * One-line description of what a graph does, for the Assets panel and for MCP
 * callers deciding whether this is the file they meant. Input/Output are the
 * frame, not the effect, so they are left out — "Input → Output" reads as a
 * graph that does something when it is the passthrough.
 */
export function postGraphSummary(graph) {
  const nodes = normalizePostGraph(graph).nodes;
  const effects = nodes.map((n) => n.type).filter((t) => t !== "input" && t !== "output");
  return {
    nodeCount: nodes.length,
    effects,
    label: effects.length ? effects.join(" → ") : "Passthrough",
  };
}
