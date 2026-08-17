/**
 * Post-process graphs (`.post`) as documents an agent can author.
 *
 * The look of a frame — reflections, ambient occlusion, bloom, the grade — is a
 * node graph, and until it became a file the only way to change one was to draw
 * wires in a panel. These ops are the other half of that: `post.nodeTypes` is
 * the vocabulary, `post.get` / `post.set` read and write the document, and
 * `post.assign` points a camera at it.
 *
 * ## Why the file and not the component
 *
 * A `.post` is referenced by any number of cameras across any number of scenes
 * (see modules/postprocessing/postAsset.js), so writing the FILE is what
 * changes the look everywhere it is used — and it survives the scene being
 * closed without saving. `post.set` therefore writes to disk and pushes the new
 * graph into every live component using it, which is the same thing the panel's
 * Save does. Cameras that still carry the older inline graph and no asset are
 * addressed with `entityId` instead of `path`, and that write goes through the
 * undo stack as a component prop.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useProjectStore } from "../../store/projectStore.js";
import { useModulesStore } from "../../modules.js";
import { invalidateBlobUrl, listProjectAssets } from "../../assetLoader.js";
import { insideProject } from "./assets.js";
import {
  POST_EXT,
  createPostGraph,
  normalizePostAsset,
  normalizePostGraph,
  serializePostAsset,
  postGraphSummary,
} from "../../../modules/postprocessing/postAsset.js";
import { PP_NODE_TYPES, INPUT_PORT_LABELS } from "../../../modules/postprocessing/postGraph.js";

const invoke = async (cmd, args) => {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
};

const samePath = (a, b) => String(a ?? "").replaceAll("\\", "/") === String(b ?? "").replaceAll("\\", "/");

/**
 * Writing a `.post` is gated on the module for the same reason compression is
 * gated on `basis`: a project that has not enabled postprocessing should not
 * acquire post-process files because an agent asked nicely. Reading is not —
 * looking at a graph, or at the vocabulary, changes nothing.
 */
function requirePostprocessing() {
  if (!useModulesStore.getState().enabled.includes("postprocessing")) {
    throw new Error(
      'The "postprocessing" module is not enabled for this project. Enable it with module.setEnabled.',
    );
  }
}

function requireProject() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  return root;
}

/** Every live Postprocess component rendering the `.post` at `path`. */
function componentsUsing(path) {
  const out = [];
  if (!path) return out;
  for (const entity of engine.entities?.values?.() ?? []) {
    const comp = entity.getComponent?.("postprocess");
    if (comp && samePath(comp.props?.asset, path)) out.push({ entity, comp });
  }
  return out;
}

function requirePostComponent(entityId) {
  const entity = engine.getEntity(entityId);
  if (!entity) throw new Error(`No entity with id "${entityId}".`);
  const comp = entity.getComponent?.("postprocess");
  if (!comp) {
    throw new Error(
      `Entity "${entity.name ?? entityId}" has no Post Process component. Add one with component.add(type: 'postprocess').`,
    );
  }
  return { entity, comp };
}

/**
 * Rejects a graph the compiler would choke on, or silently render as a
 * passthrough. Validated here rather than at build time because a graph that
 * compiles to "the scene, unchanged" looks exactly like an effect that isn't
 * working, and tracing that back to a typo'd node type is expensive.
 */
function validateGraph(graph) {
  const normalized = normalizePostGraph(graph);
  for (const node of normalized.nodes) {
    if (!PP_NODE_TYPES[node.type]) {
      throw new Error(`Unknown post node type "${node.type}". Call post.nodeTypes for the list.`);
    }
  }
  if (!normalized.nodes.some((n) => n.type === "output")) {
    throw new Error("A post graph needs an Output node — that is what the frame is read from.");
  }
  if (!normalized.nodes.some((n) => n.type === "input")) {
    throw new Error("A post graph needs an Input node — that is where the rendered scene enters.");
  }
  return normalized;
}

async function readPostFile(path) {
  const full = insideProject(path);
  const text = await invoke("read_text_file", { path: full });
  return { path: full, doc: normalizePostAsset(JSON.parse(text)) };
}

// ---------------------------------------------------------------------------

defineOp({
  name: "post.nodeTypes",
  readOnly: true,
  description:
    "List every post-process node type with its sockets and parameters. Read this before post.set — it is the vocabulary for a graph's nodes, including which of a node's parameters are live uniforms (`hot`) and which force a shader rebuild (`struct`).",
  params: {},
  run: () => ({
    nodes: Object.entries(PP_NODE_TYPES).map(([type, meta]) => ({
      type,
      label: meta.label,
      category: meta.category,
      inputs: (meta.inputs ?? []).map((i) => ({ key: i.key, kind: i.kind })),
      outputs: (meta.outputs ?? []).map((o) => ({ key: o.key, kind: o.kind })),
      params: (meta.params ?? []).map((p) => ({
        key: p.key,
        label: p.label,
        type: p.type,
        kind: p.kind,
        default: p.default,
        ...(p.options ? { options: p.options } : {}),
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
      })),
    })),
    inputPorts: INPUT_PORT_LABELS,
    notes:
      "Every graph starts at an `input` node (the rendered scene: color / depth / normal / velocity) and ends at an `output` node. " +
      "Edges are { source, sourceHandle, target, targetHandle }, where the handles are socket keys. " +
      "A `hot` param changes a uniform without recompiling; a `struct` param rebuilds the pipeline.",
  }),
});

defineOp({
  name: "post.list",
  readOnly: true,
  description:
    "List the project's .post graphs with what each one does — the effect chain in graph order — plus which cameras render through them. This is how to find an existing look before authoring another one.",
  params: {},
  run: async () => {
    const root = requireProject();
    const paths = await listProjectAssets(root, [POST_EXT]);
    const graphs = [];
    for (const path of paths) {
      try {
        const { doc } = await readPostFile(path);
        graphs.push({
          path,
          ...postGraphSummary(doc.graph),
          usedBy: componentsUsing(path).map(({ entity }) => ({ entityId: entity.id, name: entity.name })),
        });
      } catch (err) {
        // A `.post` that won't parse is a fact about the project worth
        // reporting, not a reason to fail the listing.
        graphs.push({ path, error: String(err?.message ?? err) });
      }
    }
    // Cameras whose graph is still inline are the migration case; naming them
    // here is what tells an agent that post.get needs `entityId`, not `path`.
    const embedded = [];
    for (const entity of engine.entities?.values?.() ?? []) {
      const comp = entity.getComponent?.("postprocess");
      if (comp && !comp.props?.asset) embedded.push({ entityId: entity.id, name: entity.name });
    }
    return { graphs, embedded };
  },
});

defineOp({
  name: "post.get",
  readOnly: true,
  description:
    "Read a post-process graph: pass `path` for a .post file, or `entityId` for whatever a camera actually renders (its assigned .post, or its inline graph). Returns the nodes and edges plus a summary of the effect chain.",
  params: {
    path: { type: "string", description: "Absolute path to a .post in the project." },
    entityId: { type: "string", description: "Camera entity carrying a Post Process component." },
  },
  run: async ({ path, entityId }) => {
    if (path) {
      const { path: full, doc } = await readPostFile(path);
      return { path: full, graph: doc.graph, ...postGraphSummary(doc.graph) };
    }
    if (!entityId) throw new Error("Pass `path` (a .post file) or `entityId` (a camera).");
    const { comp } = requirePostComponent(entityId);
    const graph = normalizePostGraph(comp.activeGraph?.() ?? comp.props?.graph ?? createPostGraph());
    return {
      entityId,
      path: comp.props?.asset || null,
      source: comp.props?.asset ? "asset" : "embedded",
      graph,
      ...postGraphSummary(graph),
    };
  },
});

defineOp({
  name: "post.create",
  description:
    "Create a new .post graph file. With no `graph` it is a passthrough ready to have nodes added; pass `fromEntityId` to fork whatever a camera renders today (the way to lift an inline graph into a file). Pass `assignTo` to point a camera at the result.",
  params: {
    path: {
      type: "string",
      required: true,
      description: "Absolute path for the new file, inside the project. `.post` is appended if missing.",
    },
    graph: {
      type: "object",
      description: "{ nodes, edges } to seed it with. See post.nodeTypes for the vocabulary.",
    },
    fromEntityId: {
      type: "string",
      description: "Seed from this camera's current graph instead of an empty passthrough.",
    },
    assignTo: {
      type: "string",
      description: "Camera entity to point at the new file once it exists.",
    },
  },
  run: async ({ path, graph, fromEntityId, assignTo }) => {
    requirePostprocessing();
    requireProject();
    const target = insideProject(/\.post$/i.test(path) ? path : `${path}.${POST_EXT}`, { forWriting: true });
    let seed = graph;
    if (!seed && fromEntityId) {
      const { comp } = requirePostComponent(fromEntityId);
      seed = comp.activeGraph?.() ?? comp.props?.graph;
    }
    const validated = validateGraph(seed ?? createPostGraph());
    await invoke("save_scene", { path: target, contents: serializePostAsset(validated) });
    await useProjectStore.getState().refresh();
    let assigned = null;
    if (assignTo) assigned = await assignGraph(assignTo, target);
    return { path: target, ...postGraphSummary(validated), ...(assigned ? { assigned } : {}) };
  },
});

defineOp({
  name: "post.set",
  description:
    "Replace a post-process graph. With `path` it writes the .post file and every camera using it updates immediately; with `entityId` it writes that camera's inline graph through the undo stack. Rejects a graph with no Input or Output node, or an unknown node type.",
  params: {
    graph: {
      type: "object",
      required: true,
      description:
        "{ nodes: [{ id, type, props, position }], edges: [{ source, sourceHandle, target, targetHandle }] }. Types and socket keys come from post.nodeTypes.",
    },
    path: { type: "string", description: "The .post file to write." },
    entityId: { type: "string", description: "Camera whose inline graph to write, when it has no .post assigned." },
  },
  run: async ({ graph, path, entityId }) => {
    requirePostprocessing();
    const validated = validateGraph(graph);
    if (path) {
      const target = insideProject(path, { forWriting: true });
      await invoke("save_scene", { path: target, contents: serializePostAsset(validated) });
      // The resolver caches a blob: URL per path, so a component re-reading
      // this file would get the bytes from before the write. Drop the cache
      // AND push the graph — the push is what makes the change visible now.
      invalidateBlobUrl(target);
      const users = componentsUsing(target);
      for (const { comp } of users) comp.applyGraph?.(structuredClone(validated));
      await useProjectStore.getState().refresh();
      return {
        path: target,
        ...postGraphSummary(validated),
        appliedTo: users.map(({ entity }) => entity.id),
      };
    }
    if (!entityId) throw new Error("Pass `path` (a .post file) or `entityId` (a camera's inline graph).");
    const { comp } = requirePostComponent(entityId);
    if (comp.props?.asset) {
      throw new Error(
        `Entity "${entityId}" renders "${comp.props.asset}" — write that file with post.set(path: …), or clear the slot with post.assign(path: "").`,
      );
    }
    const { commandBus } = await import("../../commands/CommandBus.js");
    const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
    commandBus.execute(new SetComponentPropCommand(entityId, "postprocess", "graph", validated));
    return { entityId, source: "embedded", ...postGraphSummary(validated) };
  },
});

async function assignGraph(entityId, path) {
  requirePostprocessing();
  const { comp } = requirePostComponent(entityId);
  const target = path ? insideProject(path) : "";
  if (samePath(comp.props?.asset, target)) return { entityId, path: target, changed: false };
  const { commandBus } = await import("../../commands/CommandBus.js");
  const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
  commandBus.execute(new SetComponentPropCommand(entityId, "postprocess", "asset", target));
  return { entityId, path: target, changed: true };
}

defineOp({
  name: "post.assign",
  description:
    "Point a camera's Post Process component at a .post graph, or clear the slot with an empty path (which falls back to the camera's inline graph, if it has one). Undoable.",
  params: {
    entityId: { type: "string", required: true, description: "Camera carrying the Post Process component." },
    path: { type: "string", description: "Absolute path to a .post; omit or pass \"\" to clear." },
  },
  run: ({ entityId, path = "" }) => assignGraph(entityId, path),
});
