/**
 * The project's event catalog — what the Events panel authors.
 *
 * An assistant asked to "make the door open when the lever is pulled" needs the
 * same two things a person needs: to see which events a project already
 * declares, and to declare a new one when none fits. Without these ops the
 * catalog is reachable only by hand-writing the `events` block into
 * project.json, which means guessing the schema and then reloading the editor
 * to make the generated declarations catch up.
 *
 * Everything here goes through the same store the panel uses, so an op and a
 * click produce identical results — including the regenerated
 * `project-events.d.ts`, which is the whole reason the catalog exists.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { EVENT_PARAM_TYPES, EVENT_SCOPES } from "../../../engine/events/catalog.js";
import { ACTION_KINDS, ACTION_KIND_IDS } from "../../../engine/events/actions.js";
import { NODE_TYPES, EXEC } from "../../../engine/events/graph.js";

const store = async () => (await import("../../store/eventsStore.js")).useEventsStore.getState();

/** The catalog as a plain, describable object. */
const project = (event) => ({
  name: event.name,
  scope: event.scope,
  params: event.params,
  ...(event.description ? { description: event.description } : {}),
  ...(event.category ? { category: event.category } : {}),
  // The two lines an author would write. Handing these back means a model never
  // has to reconstruct the call from the parameter list — the same reason the
  // panel shows them.
  emit: `${event.scope === "entity" ? "entity" : "engine"}.emit("${event.name}"${
    event.params.length ? `, ${event.params.map((p) => p.name).join(", ")}` : ""
  })`,
});

defineOp({
  name: "events.list",
  readOnly: true,
  description:
    "List every event this project declares, with its parameters and the exact emit call to write. Read this before wiring any behaviour to an event — a name not in this list is not type-checked in scripts.",
  params: {},
  run: () => ({
    events: engine.events.list().map(project),
    paramTypes: Object.keys(EVENT_PARAM_TYPES),
    scopes: Object.keys(EVENT_SCOPES),
  }),
});

defineOp({
  name: "events.define",
  description:
    "Declare a new project event, making its name and payload type-checked in every script. Regenerates project-events.d.ts and saves project.json, exactly as the Events panel's Save does.",
  params: {
    name: {
      type: "string",
      required: true,
      description: "Event name, e.g. 'player-died'. Letters, digits, - and _; must not collide with a built-in engine event.",
    },
    scope: {
      type: "string",
      description: "'global' fires on the engine (default); 'entity' fires on one entity's own bus.",
    },
    params: {
      type: "array",
      description:
        "Payload, in order: [{ name, type, optional?, description? }]. type is one of number, string, boolean, vec3, color, entity, asset, any.",
    },
    description: { type: "string", description: "Shown as hover documentation in the code editor." },
    category: { type: "string", description: "Free-text grouping for the Events panel." },
  },
  run: async ({ name, scope, params, description, category }) => {
    const events = await store();
    let error = null;
    events.patch((list) => {
      // Validation lives in the catalog module and reports rather than throws,
      // so a rejected entry would silently vanish. Check before, not after.
      if (list.some((e) => e.name === name)) {
        error = `"${name}" is already declared.`;
        return null;
      }
      return [
        ...list,
        {
          name,
          scope: scope === "entity" ? "entity" : "global",
          params: Array.isArray(params) ? params : [],
          ...(description ? { description } : {}),
          ...(category ? { category } : {}),
        },
      ];
    });
    if (error) throw new Error(error);
    const created = engine.events.get(name);
    if (!created) {
      throw new Error(
        `"${name}" was rejected: ${(await store()).errors.join("; ") || "invalid name or parameters"}`,
      );
    }
    await (await store()).commit();
    return project(created);
  },
});

defineOp({
  name: "events.update",
  description:
    "Change a declared event's parameters, description, category or scope. Pass only the fields to change; omitted fields are left as they are.",
  params: {
    name: { type: "string", required: true, description: "The event to change." },
    params: { type: "array", description: "Replaces the whole parameter list. Same shape as events.define." },
    description: { type: "string", description: "New description." },
    category: { type: "string", description: "New category." },
    scope: { type: "string", description: "'global' or 'entity'." },
  },
  run: async ({ name, ...changes }) => {
    if (!engine.events.has(name)) throw new Error(`No event named "${name}".`);
    const patch = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    (await store()).update(name, patch);
    await (await store()).commit();
    return project(engine.events.get(name));
  },
});

defineOp({
  name: "events.rename",
  description:
    "Rename a declared event and rewrite every script that referenced the old name. This is a refactor: leaving the scripts alone would break them, since the old name stops being type-checked.",
  params: {
    name: { type: "string", required: true, description: "Current event name." },
    newName: { type: "string", required: true, description: "New event name." },
  },
  run: async ({ name, newName }) => {
    if (!engine.events.has(name)) throw new Error(`No event named "${name}".`);
    const error = (await store()).rename(name, newName);
    if (error) throw new Error(error);
    const { useProjectStore } = await import("../../store/projectStore.js");
    const rootPath = useProjectStore.getState().rootPath;
    const { renameEventInScripts } = await import("../../eventUsages.js");
    const rewritten = await renameEventInScripts(rootPath, name, newName);
    await (await store()).commit();
    return { ...project(engine.events.get(newName)), rewritten };
  },
});

defineOp({
  name: "events.remove",
  description:
    "Delete a declared event from the catalog. Scripts still referencing it stop type-checking — call events.usages first to see what would break.",
  params: {
    name: { type: "string", required: true, description: "The event to delete." },
  },
  run: async ({ name }) => {
    if (!engine.events.has(name)) throw new Error(`No event named "${name}".`);
    (await store()).remove(name);
    await (await store()).commit();
    return { removed: name };
  },
});

defineOp({
  name: "events.usages",
  readOnly: true,
  description:
    "Find every place a project script mentions an event name, as file/line/source-line. Use before renaming or removing one, and to answer 'what listens to this'.",
  params: {
    name: { type: "string", required: true, description: "The event name to search for." },
  },
  run: async ({ name }) => {
    const { useProjectStore } = await import("../../store/projectStore.js");
    const rootPath = useProjectStore.getState().rootPath;
    if (!rootPath) throw new Error("No project is open.");
    const { findEventUsages } = await import("../../eventUsages.js");
    const usages = await findEventUsages(rootPath, name);
    return {
      usages,
      files: new Set(usages.map((u) => u.path)).size,
      // The live count is the other half of the answer: a script can subscribe
      // through a variable, and a name with zero textual hits can still have
      // listeners attached at runtime.
      liveListeners: engine.listenerCount?.(name) ?? 0,
    };
  },
});

defineOp({
  name: "events.emit",
  description:
    "Fire an event right now, on the engine bus or on one entity. The fastest way to test that something is wired up without playing through to the trigger.",
  params: {
    name: { type: "string", required: true, description: "Event name." },
    args: { type: "array", description: "Payload arguments, in declaration order." },
    entityId: {
      type: "string",
      description: "Emit on this entity's own bus instead of the engine's. Required for 'entity'-scoped events.",
    },
  },
  run: ({ name, args = [], entityId }) => {
    const payload = Array.isArray(args) ? args : [args];
    if (entityId) {
      const entity = engine.getEntity(entityId);
      if (!entity) throw new Error(`No entity with id "${entityId}".`);
      const listeners = entity.listenerCount(name);
      entity.emit(name, ...payload);
      return { emitted: name, on: entity.name ?? entityId, listeners };
    }
    const listeners = engine.listenerCount?.(name) ?? 0;
    engine.emit(name, ...payload);
    return { emitted: name, on: "engine", listeners };
  },
});

defineOp({
  name: "events.monitor",
  description:
    "Record every event fired on every bus, then read back what happened — name, source, arguments and how many listeners each reached. Emissions with zero listeners are the usual reason something 'does nothing'.",
  params: {
    action: {
      type: "string",
      description: "'start' arms recording, 'read' returns what has been captured, 'stop' disarms it, 'clear' empties the buffer. Default 'read'.",
    },
    limit: { type: "number", description: "How many emissions to keep while recording. Default 500." },
    filter: { type: "string", description: "Only return emissions whose name or source contains this." },
  },
  run: async ({ action = "read", limit, filter }) => {
    const events = await store();
    if (action === "start") {
      // Through the store, not `engine.events.record` directly: the panel's
      // Monitor tab reads the store's flag, and an op that armed the tap behind
      // its back would leave the two disagreeing about whether it is recording.
      events.setMonitoring(true, limit ? { limit } : undefined);
      return { recording: true, limit: limit ?? 500 };
    }
    if (action === "stop") {
      events.setMonitoring(false);
      return { recording: false };
    }
    if (action === "clear") {
      engine.events.clearHistory();
      return { cleared: true };
    }
    if (!engine.events.recording) {
      throw new Error("Recording is not armed — call events.monitor with action 'start' first.");
    }
    const needle = String(filter ?? "").toLowerCase();
    const history = engine.events
      .history()
      .filter(
        (e) =>
          !needle ||
          e.name.toLowerCase().includes(needle) ||
          e.source.toLowerCase().includes(needle),
      );
    return {
      recording: true,
      count: history.length,
      emissions: history,
      unheard: history.filter((e) => e.listeners === 0).map((e) => e.name),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Bindings — the inspector wiring, drivable without knowing its JSON shape    */
/* -------------------------------------------------------------------------- */

/**
 * `component.setProp(id, "events", "bindings", [...])` can already write these,
 * but only for a caller who knows the row shape and every action's field list —
 * neither of which is discoverable from a schema that says `type: "bindings"`.
 * `events.actions` publishes the vocabulary and `events.bind` takes one row, so
 * an assistant wires a door the same way a person does instead of guessing at
 * an opaque blob.
 */
defineOp({
  name: "events.actions",
  readOnly: true,
  description:
    "List every action a binding can run, with each one's fields and types. Read this before calling events.bind — it is the vocabulary for a binding's `do` list.",
  params: {},
  run: () => ({
    actions: ACTION_KIND_IDS.map((id) => ({
      type: id,
      label: ACTION_KINDS[id].label,
      fields: ACTION_KINDS[id].fields.map((f) => ({
        key: f.key,
        type: f.type,
        label: f.label,
        ...(f.options ? { options: f.options } : {}),
        ...(f.description ? { description: f.description } : {}),
      })),
    })),
    sources: ["engine", "entity", "component", "input", "lifecycle"],
    argumentTokens: {
      $0: "the triggering event's first argument (also $1, $2, …)",
      $name: "the argument named `name` in the event's catalog entry",
      $self: "the entity the binding is on",
    },
  }),
});

defineOp({
  name: "events.bindings",
  readOnly: true,
  description:
    "List the event bindings on an entity — what it reacts to and what it does in response. Answers 'why does this happen when I click that'.",
  params: {
    entityId: { type: "string", required: true, description: "Entity to inspect." },
  },
  run: ({ entityId }) => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}".`);
    const bindings = entity.getComponent("events")?.props?.bindings ?? [];
    // A UI button's response lists are the same wiring in a different place;
    // reporting only the component would answer "nothing" for a menu that is
    // entirely wired through its buttons.
    const button = entity.getComponent("uibutton");
    const buttonActions = {};
    for (const key of ["onClick", "onPointerEnter", "onPointerExit", "onFocus", "onBlur"]) {
      const list = button?.props?.[key];
      if (list?.length) buttonActions[key] = list;
    }
    return { bindings, ...(Object.keys(buttonActions).length ? { buttonActions } : {}) };
  },
});

defineOp({
  name: "events.bind",
  description:
    "Add a binding to an entity: when something happens, run these actions — no script needed. Adds the Events component if the entity has none. Call events.actions first for the action vocabulary.",
  params: {
    entityId: { type: "string", required: true, description: "Entity the binding lives on." },
    when: {
      type: "object",
      required: true,
      description:
        "What fires it: { source: 'engine'|'entity'|'component'|'input'|'lifecycle', event?, target?, component?, action?, edge?, phase? }.",
    },
    actions: {
      type: "array",
      required: true,
      description: "What to do, in order: [{ type, ...fields, delay? }]. See events.actions.",
    },
    once: { type: "boolean", description: "Fire only the first time each Play session." },
    deferred: { type: "boolean", description: "Run next frame instead of inside the event." },
  },
  run: async ({ entityId, when, actions, once, deferred }) => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}".`);
    for (const action of actions ?? []) {
      if (!ACTION_KINDS[action?.type]) {
        throw new Error(
          `Unknown action type "${action?.type}". Call events.actions for the list.`,
        );
      }
    }
    const { commandBus } = await import("../../commands/CommandBus.js");
    if (!entity.getComponent("events")) {
      const { AddComponentCommand } = await import("../../commands/componentCommands.js");
      commandBus.execute(new AddComponentCommand(entityId, "events"));
    }
    const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
    const current = entity.getComponent("events")?.props?.bindings ?? [];
    const binding = {
      id: `a${Date.now().toString(36)}${current.length}`,
      enabled: true,
      ...(once ? { once: true } : {}),
      ...(deferred ? { deferred: true } : {}),
      when,
      do: actions ?? [],
    };
    commandBus.execute(
      new SetComponentPropCommand(entityId, "events", "bindings", [...current, binding], "Add binding"),
    );
    return { added: binding, total: current.length + 1 };
  },
});

defineOp({
  name: "events.unbind",
  description: "Remove one binding from an entity by its id (see events.bindings).",
  params: {
    entityId: { type: "string", required: true, description: "Entity holding the binding." },
    bindingId: { type: "string", required: true, description: "The binding's `id`." },
  },
  run: async ({ entityId, bindingId }) => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}".`);
    const current = entity.getComponent("events")?.props?.bindings ?? [];
    const next = current.filter((b) => b.id !== bindingId);
    if (next.length === current.length) throw new Error(`No binding with id "${bindingId}".`);
    const { commandBus } = await import("../../commands/CommandBus.js");
    const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
    commandBus.execute(
      new SetComponentPropCommand(entityId, "events", "bindings", next, "Remove binding"),
    );
    return { removed: bindingId, remaining: next.length };
  },
});

/* -------------------------------------------------------------------------- */
/* The node graph                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A graph is JSON an assistant can author directly — but only if it knows the
 * node types, their sockets and which wires are legal. `events.nodeTypes`
 * publishes exactly that, the same table the palette renders from, so writing a
 * graph is filling in a described schema rather than reverse-engineering one
 * from an example.
 */
defineOp({
  name: "events.nodeTypes",
  readOnly: true,
  description:
    "List every event-graph node type with its inputs, outputs and settable fields. Read this before events.setGraph — it is the vocabulary for a graph's nodes, and it says which sockets carry control flow versus values.",
  params: {},
  run: () => ({
    nodes: Object.entries(NODE_TYPES).map(([type, def]) => ({
      type,
      label: def.label,
      category: def.cat,
      inputs: (def.inputs ?? []).map((i) => ({ key: i.key, type: i.type })),
      outputs: (def.outputs ?? []).map((o) => ({ key: o.key, type: o.type })),
      fields: (def.fields ?? []).map((f) => ({
        key: f.key,
        type: f.type,
        ...(f.options ? { options: f.options } : {}),
      })),
    })),
    execSocketType: EXEC,
    notes:
      `Sockets typed "${EXEC}" carry control flow (what runs next); every other type carries a value. ` +
      "An action's field left unwired uses the node's own value, so a node with nothing wired behaves like the same action in a binding row.",
  }),
});

defineOp({
  name: "events.getGraph",
  readOnly: true,
  description:
    "Read an entity's event graph as nodes and edges. Returns null when it has none — the entity may still have binding rows; see events.bindings.",
  params: {
    entityId: { type: "string", required: true, description: "Entity to read." },
  },
  run: ({ entityId }) => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}".`);
    const graph = entity.getComponent("events")?.props?.graph ?? null;
    if (!graph) return { graph: null };
    // `__index` is a runtime cache hung off the graph object; it is not part of
    // the document and would be nonsense to hand back.
    return { graph: { nodes: graph.nodes ?? [], edges: graph.edges ?? [] } };
  },
});

defineOp({
  name: "events.setGraph",
  description:
    "Replace an entity's event graph. Use for wiring a binding row cannot express: a condition, a value passed from one action to the next, or several triggers sharing one chain. Adds the Events component if missing.",
  params: {
    entityId: { type: "string", required: true, description: "Entity the graph lives on." },
    nodes: {
      type: "array",
      required: true,
      description:
        "[{ id, type, props, position: {x,y} }]. `type` comes from events.nodeTypes; `props` holds that type's fields.",
    },
    edges: {
      type: "array",
      required: true,
      description:
        "[{ source, sourceHandle, target, targetHandle }] — handles are the socket keys from events.nodeTypes.",
    },
  },
  run: async ({ entityId, nodes, edges }) => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity with id "${entityId}".`);
    // Validated before it is stored: a bad node type in a saved graph is a
    // silently-dead branch at runtime, and the entity that "just doesn't react"
    // is expensive to trace back to a typo in a tool call.
    const ids = new Set();
    for (const node of nodes ?? []) {
      if (!node?.id) throw new Error("Every node needs an `id`.");
      if (ids.has(node.id)) throw new Error(`Duplicate node id "${node.id}".`);
      ids.add(node.id);
      if (!NODE_TYPES[node.type]) {
        throw new Error(`Unknown node type "${node.type}". Call events.nodeTypes for the list.`);
      }
    }
    for (const edge of edges ?? []) {
      if (!ids.has(edge?.source)) throw new Error(`Edge from unknown node "${edge?.source}".`);
      if (!ids.has(edge?.target)) throw new Error(`Edge to unknown node "${edge?.target}".`);
    }
    const { commandBus } = await import("../../commands/CommandBus.js");
    if (!entity.getComponent("events")) {
      const { AddComponentCommand } = await import("../../commands/componentCommands.js");
      commandBus.execute(new AddComponentCommand(entityId, "events"));
    }
    const { SetComponentPropCommand } = await import("../../commands/componentCommands.js");
    const graph = {
      nodes: (nodes ?? []).map((n) => ({
        id: n.id,
        type: n.type,
        props: n.props ?? {},
        position: n.position ?? { x: 0, y: 0 },
      })),
      edges: (edges ?? []).map((e) => ({
        source: e.source,
        sourceHandle: e.sourceHandle ?? "out",
        target: e.target,
        targetHandle: e.targetHandle,
      })),
    };
    commandBus.execute(
      new SetComponentPropCommand(entityId, "events", "graph", graph, "Set event graph"),
    );
    return { nodes: graph.nodes.length, edges: graph.edges.length };
  },
});
