// @ts-check
/**
 * The event graph: node types and the runtime that walks them.
 *
 * ## Why this exists next to the row list
 *
 * `EventBindingComponent`'s rows are "when X, do these, in order". That covers
 * most wiring and nothing else — a flat list cannot express a CONDITION
 * (`if health < 20 then A else B`), cannot pass one action's result to the
 * next (`spawn a crate, then set a prop on the crate you just spawned`), and
 * cannot fan several triggers into one shared chain without duplicating it.
 * Those three are the actual ceiling on what can be built without a script, and
 * they are exactly what a graph removes. Unreal's Blueprints are the mainstream
 * answer for the same reason.
 *
 * Rows and graph both run, independently, on the same component. They are NOT
 * two views of one thing: converting a graph with a branch into rows is lossy,
 * and a lossy round-trip through an editor is how authored work quietly
 * disappears. A row list is the small case written small; a graph is the case
 * that needs one.
 *
 * ## Execution model
 *
 * Two kinds of wire, distinguished by socket type — the toolkit's `event` type
 * (exclusive, so it can never land in a data socket) carries CONTROL, and the
 * value types carry DATA.
 *
 *   - control is PUSHED: a trigger fires, its `exec` output runs the node it
 *     points at, which runs its own `exec` output, and so on.
 *   - data is PULLED: a node reads an input only when it needs it, walking back
 *     along the wire and evaluating whatever produces it.
 *
 * Pull-with-memoisation is what makes `compare` and `get-prop` cheap: a value
 * feeding three inputs is computed once per run, and a value nobody reads is
 * never computed at all.
 */
import { ACTION_KINDS, ACTION_KIND_IDS, resolveValue } from "./actions.js";

/** Socket type for control flow. `event` is already exclusive in the toolkit's
 *  compatibility rules, so a control wire physically cannot land on a data
 *  socket — the graph cannot be miswired into nonsense. */
export const EXEC = "event";

/** Prefix marking a node type as an entry point. */
const TRIGGER_PREFIX = "on-";
/** Prefix marking a node type as one of the shared actions. */
const ACTION_PREFIX = "do-";

export const isTriggerNode = (type) => String(type).startsWith(TRIGGER_PREFIX);
export const actionKindFor = (type) =>
  String(type).startsWith(ACTION_PREFIX) ? String(type).slice(ACTION_PREFIX.length) : null;

/**
 * How many event arguments a trigger exposes as data outputs.
 *
 * Fixed rather than derived from the catalog because the graph is authored
 * against a node whose event can still change: sockets that appear and vanish
 * as a dropdown is used would drop the wires already attached to them. Four
 * covers every event the engine declares and all but pathological game ones.
 */
export const TRIGGER_ARG_COUNT = 4;

/** Trigger node types and the fields that configure them. */
export const TRIGGER_NODES = {
  "on-engine-event": {
    label: "On Engine Event",
    cat: "trigger",
    fields: [{ key: "event", label: "Event", type: "event" }],
    summary: (p) => p.event || "…",
  },
  "on-entity-event": {
    label: "On Entity Event",
    cat: "trigger",
    fields: [
      { key: "target", label: "On Entity", type: "entity" },
      { key: "event", label: "Event", type: "event" },
    ],
    summary: (p) => p.event || "…",
  },
  "on-component-event": {
    label: "On Component Event",
    cat: "trigger",
    fields: [
      { key: "component", label: "Component", type: "componentType" },
      {
        key: "event",
        label: "Event",
        type: "select",
        options: ["changed", "destroyed", "finished", "looped", "state-changed"],
      },
    ],
    summary: (p) => `${p.component || "…"}: ${p.event || "…"}`,
  },
  "on-input": {
    label: "On Input Action",
    cat: "trigger",
    fields: [
      { key: "action", label: "Action", type: "string" },
      { key: "edge", label: "Edge", type: "select", options: ["pressed", "released"] },
    ],
    summary: (p) => `${p.action || "…"} ${p.edge ?? "pressed"}`,
  },
  "on-lifecycle": {
    label: "On Lifecycle",
    cat: "trigger",
    fields: [{ key: "phase", label: "Phase", type: "select", options: ["start", "stop", "destroy"] }],
    summary: (p) => `on ${p.phase ?? "start"}`,
  },
};

/** Control-flow and value nodes — the part a row list has no equivalent for. */
export const LOGIC_NODES = {
  branch: {
    label: "Branch (If)",
    cat: "flow",
    inputs: [
      { key: "exec", type: EXEC },
      { key: "condition", label: "Condition", type: "float" },
    ],
    outputs: [
      { key: "true", label: "True", type: EXEC },
      { key: "false", label: "False", type: EXEC },
    ],
    fields: [],
  },
  sequence: {
    label: "Sequence",
    cat: "flow",
    inputs: [{ key: "exec", type: EXEC }],
    outputs: [
      { key: "0", label: "Then 1", type: EXEC },
      { key: "1", label: "Then 2", type: EXEC },
      { key: "2", label: "Then 3", type: EXEC },
    ],
    fields: [],
  },
  delay: {
    label: "Delay",
    cat: "flow",
    inputs: [{ key: "exec", type: EXEC }],
    outputs: [{ key: "exec", type: EXEC }],
    fields: [{ key: "seconds", label: "Seconds", type: "number" }],
    summary: (p) => `${p.seconds ?? 0}s`,
  },
  once: {
    label: "Once",
    cat: "flow",
    inputs: [{ key: "exec", type: EXEC }],
    outputs: [{ key: "exec", type: EXEC }],
    fields: [],
  },
  number: {
    label: "Number",
    cat: "value",
    inputs: [],
    outputs: [{ key: "out", type: "float" }],
    fields: [{ key: "value", label: "Value", type: "number" }],
    summary: (p) => String(p.value ?? 0),
  },
  string: {
    label: "Text",
    cat: "value",
    inputs: [],
    outputs: [{ key: "out", type: "any" }],
    fields: [{ key: "value", label: "Value", type: "string" }],
    summary: (p) => `"${p.value ?? ""}"`,
  },
  boolean: {
    label: "Boolean",
    cat: "value",
    inputs: [],
    outputs: [{ key: "out", type: "float" }],
    fields: [{ key: "value", label: "Value", type: "boolean" }],
    summary: (p) => (p.value ? "true" : "false"),
  },
  "entity-ref": {
    label: "Entity",
    cat: "value",
    inputs: [],
    outputs: [{ key: "out", type: "any" }],
    fields: [{ key: "entity", label: "Entity", type: "entity" }],
  },
  self: {
    label: "This Entity",
    cat: "value",
    inputs: [],
    outputs: [{ key: "out", type: "any" }],
    fields: [],
  },
  "get-prop": {
    label: "Get Property",
    cat: "value",
    inputs: [{ key: "target", label: "On", type: "any" }],
    outputs: [{ key: "out", type: "any" }],
    fields: [
      { key: "component", label: "Component", type: "componentType" },
      { key: "key", label: "Property", type: "componentProp" },
    ],
    summary: (p) => `${p.component || "…"}.${p.key || "…"}`,
  },
  compare: {
    label: "Compare",
    cat: "value",
    inputs: [
      { key: "a", label: "A", type: "any" },
      { key: "b", label: "B", type: "any" },
    ],
    outputs: [{ key: "out", type: "float" }],
    fields: [
      { key: "op", label: "Op", type: "select", options: ["==", "!=", "<", "<=", ">", ">="] },
    ],
    summary: (p) => `A ${p.op ?? "=="} B`,
  },
  not: {
    label: "Not",
    cat: "value",
    inputs: [{ key: "a", label: "A", type: "float" }],
    outputs: [{ key: "out", type: "float" }],
    fields: [],
  },
};

/**
 * Every node type in the graph, as `{ label, cat, inputs, outputs, fields }`.
 *
 * Actions are DERIVED from `ACTION_KINDS` rather than listed again, so the
 * graph gains a node the day an action is added to that table — the same
 * property the row list has, for the same reason. Each action's fields become
 * data INPUTS as well as inspector fields: an input left unwired falls back to
 * the field's literal, which is what lets a simple node stay simple.
 */
export function buildNodeTypes() {
  const types = {};
  for (const [type, def] of Object.entries(TRIGGER_NODES)) {
    types[type] = {
      ...def,
      inputs: [],
      outputs: [
        { key: "exec", label: "", type: EXEC },
        ...Array.from({ length: TRIGGER_ARG_COUNT }, (_v, i) => ({
          key: `arg${i}`,
          label: `arg ${i}`,
          type: "any",
        })),
      ],
    };
  }
  for (const id of ACTION_KIND_IDS) {
    const kind = ACTION_KINDS[id];
    types[`${ACTION_PREFIX}${id}`] = {
      label: kind.label,
      cat: "action",
      summary: kind.summary,
      inputs: [
        { key: "exec", label: "", type: EXEC },
        ...kind.fields
          // `args` is a variable-length list; a graph passes values by wiring
          // them, so the list editor has no meaning here.
          .filter((f) => f.type !== "args")
          .map((f) => ({ key: f.key, label: f.label, type: "any" })),
      ],
      outputs: [
        { key: "exec", label: "", type: EXEC },
        // Spawn is the motivating case for data-out on an action: "make a
        // crate, then set a prop ON THE CRATE" is unexpressible in a row list.
        ...(id === "spawn" ? [{ key: "spawned", label: "Spawned", type: "any" }] : []),
      ],
      fields: kind.fields.filter((f) => f.type !== "args"),
    };
  }
  for (const [type, def] of Object.entries(LOGIC_NODES)) types[type] = def;
  return types;
}

export const NODE_TYPES = buildNodeTypes();

/* -------------------------------------------------------------------------- */
/* Runtime                                                                     */
/* -------------------------------------------------------------------------- */

/** Every trigger node in a graph, so the component knows what to subscribe. */
export function collectTriggers(graph) {
  return (graph?.nodes ?? []).filter((n) => isTriggerNode(n.type));
}

/** Index a graph once per change instead of scanning edges per evaluation. */
function indexGraph(graph) {
  const nodes = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  /** `${nodeId}:${handle}` -> edge, for data pulls (one producer per input). */
  const byTarget = new Map();
  /** `${nodeId}:${handle}` -> [edge], for control pushes (fan-out allowed). */
  const bySource = new Map();
  for (const edge of graph?.edges ?? []) {
    byTarget.set(`${edge.target}:${edge.targetHandle}`, edge);
    const key = `${edge.source}:${edge.sourceHandle ?? "out"}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(edge);
  }
  return { nodes, byTarget, bySource };
}

/**
 * Runs a graph starting from one trigger node.
 *
 * `fired` is the component's per-Play set backing `once` nodes; passing it in
 * rather than storing it on the node keeps the graph itself pure data, so the
 * same graph on two entities does not share one node's fired flag.
 */
// Bounds a graph that wires a Sequence back into its own upstream. A cycle
// through EXEC is legal and useful (a loop), so this is a step budget rather
// than a cycle ban — it stops a runaway without forbidding a real pattern.
const GRAPH_STEP_BUDGET = 512;

export function runGraph(graph, startNodeId, ctx, fired = new Set(), trace = null) {
  const index = graph.__index ?? (graph.__index = indexGraph(graph));
  const memo = new Map();
  const budget = { steps: GRAPH_STEP_BUDGET };
  // `trace` is the editor's live view of what actually ran. Opt-in and null in
  // a build: a graph that fires every frame would otherwise write to a Map
  // nobody reads. The trigger is recorded here rather than in `runNode`, which
  // only ever sees the nodes downstream of it.
  if (trace) trace.set(startNodeId, (trace.get(startNodeId) ?? 0) + 1);
  execFrom(startNodeId, "exec", { ...ctx, index, memo, fired, budget, trace });
}

/** Follows one control output to whatever it points at. */
function execFrom(nodeId, handle, rt) {
  const edges = rt.index.bySource.get(`${nodeId}:${handle}`);
  if (!edges) return;
  for (const edge of edges) runNode(edge.target, rt);
}

function runNode(nodeId, rt) {
  if (--rt.budget.steps < 0) {
    console.warn("[events] Graph exceeded its step budget — check for a loop.");
    return;
  }
  const node = rt.index.nodes.get(nodeId);
  if (!node) return;
  if (rt.trace) rt.trace.set(nodeId, (rt.trace.get(nodeId) ?? 0) + 1);
  const props = node.props ?? {};

  switch (node.type) {
    case "branch": {
      const condition = readInput(node, "condition", rt);
      execFrom(nodeId, condition ? "true" : "false", rt);
      return;
    }
    case "sequence":
      for (const handle of ["0", "1", "2"]) execFrom(nodeId, handle, rt);
      return;
    case "once": {
      if (rt.fired.has(nodeId)) return;
      rt.fired.add(nodeId);
      execFrom(nodeId, "exec", rt);
      return;
    }
    case "delay": {
      const seconds = Number(props.seconds) || 0;
      if (seconds <= 0) {
        execFrom(nodeId, "exec", rt);
        return;
      }
      // On the engine's scheduler, so a wired delay obeys game time: it slows
      // with bullet time and stops dead when the game is paused, exactly as
      // the same wait written in a script would.
      //
      // The continuation gets a FRESH memo and step budget: a delayed resume
      // is a new run segment. The memo holds values pulled BEFORE the wait
      // (a get-prop read after the delay must see the world at resume time),
      // and a graph that loops through a delay would inherit an already-
      // spent budget and stall permanently once 512 total steps accumulated.
      rt.engine.time?.after?.(seconds, () =>
        execFrom(nodeId, "exec", { ...rt, memo: new Map(), budget: { steps: GRAPH_STEP_BUDGET } }),
      );
      return;
    }
    default:
      break;
  }

  const kindId = actionKindFor(node.type);
  if (!kindId) return;
  const kind = ACTION_KINDS[kindId];
  if (!kind) return;

  // An action's arguments come from its wired inputs where present and its own
  // literal fields where not — so a node with nothing wired behaves exactly
  // like the same action in a row list.
  const resolved = { type: kindId, ...props };
  for (const field of kind.fields) {
    if (field.type === "args") continue;
    const wired = readInput(node, field.key, rt, { onlyWired: true });
    if (wired !== undefined) resolved[field.key] = wired;
  }
  let produced;
  try {
    produced = kind.run(resolved, rt);
  } catch (err) {
    console.error(`[events] Graph action "${kindId}" failed: ${err?.message ?? err}`);
  }
  if (kindId === "spawn") rt.memo.set(`${nodeId}:spawned`, produced ?? null);
  execFrom(nodeId, "exec", rt);
}

/**
 * The value on one input: whatever is wired to it, or the node's own field.
 *
 * `onlyWired` returns `undefined` when nothing is connected, which is how an
 * action tells "wired to something that evaluated to nothing" apart from "not
 * wired at all" — the first must override the literal field, the second must
 * not.
 */
function readInput(node, handle, rt, { onlyWired = false } = {}) {
  const edge = rt.index.byTarget.get(`${node.id}:${handle}`);
  if (!edge) {
    if (onlyWired) return undefined;
    return resolveValue(node.props?.[handle], rt);
  }
  return evalOutput(edge.source, edge.sourceHandle ?? "out", rt);
}

/** Evaluates one node's data output, memoised for the duration of a run. */
function evalOutput(nodeId, handle, rt) {
  const key = `${nodeId}:${handle}`;
  if (rt.memo.has(key)) return rt.memo.get(key);
  // Seeded before evaluating so a data cycle resolves to null once instead of
  // recursing forever. Unlike control flow, a value that depends on itself has
  // no useful meaning.
  rt.memo.set(key, null);
  const node = rt.index.nodes.get(nodeId);
  if (!node) return null;
  const value = computeOutput(node, handle, rt);
  rt.memo.set(key, value);
  return value;
}

function computeOutput(node, handle, rt) {
  const props = node.props ?? {};
  if (isTriggerNode(node.type)) {
    const match = /^arg(\d+)$/.exec(handle);
    return match ? (rt.args?.[Number(match[1])] ?? null) : null;
  }
  switch (node.type) {
    case "number":
      return Number(props.value) || 0;
    case "string":
      return resolveValue(props.value ?? "", rt);
    case "boolean":
      return !!props.value;
    case "self":
      return rt.self ?? null;
    case "entity-ref":
      return props.entity ? (rt.engine.getEntity?.(props.entity) ?? null) : null;
    case "not":
      return !readInput(node, "a", rt);
    case "compare": {
      const a = readInput(node, "a", rt);
      const b = readInput(node, "b", rt);
      switch (props.op ?? "==") {
        case "!=":
          return a != b; // eslint-disable-line eqeqeq
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        default:
          return a == b; // eslint-disable-line eqeqeq
      }
    }
    case "get-prop": {
      const target = readInput(node, "target", rt) ?? rt.self;
      const component = target?.getComponent?.(props.component);
      return component ? (component.props?.[props.key] ?? null) : null;
    }
    default:
      // An action's data output (spawn's `spawned`) is written by `runNode`
      // when the action actually runs; reading it before that is null rather
      // than a re-run, because running an action to satisfy a data pull would
      // spawn a second crate.
      return rt.memo.get(`${node.id}:${handle}`) ?? null;
  }
}

/** Rewrites every entity id inside a graph through `idMap`. */
export function remapGraph(graph, idMap) {
  if (!graph?.nodes?.length || !idMap?.size) return graph;
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const props = node.props ?? {};
    let copy = null;
    for (const key of ["target", "entity", "parent", "at"]) {
      const mapped = idMap.get(props[key]);
      if (!mapped) continue;
      copy ??= { ...props };
      copy[key] = mapped;
      changed = true;
    }
    return copy ? { ...node, props: copy } : node;
  });
  // The index caches node objects, so a remapped graph must not keep the old
  // one — this is the bug where a duplicated scene drives the original's props.
  return changed ? { nodes, edges: graph.edges } : graph;
}
