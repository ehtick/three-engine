/**
 * The `GraphEditor` registry for event graphs.
 *
 * The toolkit owns every interaction (palette, undo, clipboard, frames,
 * reroutes, connection validation); a panel only has to describe its nodes.
 * This describes them straight off `engine/events/graph.js`'s `NODE_TYPES`,
 * which is itself derived from the shared action table — so an action added
 * once appears in the row list, in the graph palette and in the runtime,
 * with nothing here to update.
 *
 * The only work this file really does is turning the event system's field
 * types (`event`, `entity`, `componentType`, `componentProp`) into widgets the
 * shared node renderer already has. All four become a `select` with computed
 * options, which is better than the text box they would otherwise be: the
 * options are the actual events in the catalog, the actual entities in the
 * scene, the actual components on the target.
 */
import { engine } from "./engineInstance.js";
import { useProjectStore } from "./store/projectStore.js";
import { cachedMethodsForEntity } from "./scriptIntrospect.js";
import { NODE_TYPES, EXEC } from "../engine/events/graph.js";
import { RESERVED_EVENT_NAMES } from "../engine/events/catalog.js";

const CATEGORY_LABELS = {
  trigger: "Triggers",
  action: "Actions",
  flow: "Flow",
  value: "Values",
};

/** Every event name, project first. Rebuilt per describe() so a newly declared
 *  event shows up without reopening the graph. */
function eventOptions() {
  const project = (engine.events?.list?.() ?? []).map((e) => ({
    value: e.name,
    label: `${e.name}${e.params.length ? ` (${e.params.map((p) => p.name).join(", ")})` : ""}`,
  }));
  const builtIn = RESERVED_EVENT_NAMES.filter((n) => n !== "events-changed").map((n) => ({
    value: n,
    label: n,
  }));
  return [{ value: "", label: "— none —" }, ...project, ...builtIn];
}

/** Every entity in the open scene, as `{ value: id, label: name }`. */
function entityOptions() {
  const out = [{ value: "", label: "— this entity —" }];
  for (const root of engine.rootEntities ?? []) {
    root.traverse?.((entity) => out.push({ value: entity.id, label: entity.name || entity.id }));
  }
  return out;
}

/** Component types present on the entity a node targets, or on any entity. */
function componentOptions(entityId) {
  const entity = entityId ? engine.getEntity(entityId) : null;
  const types = entity ? [...(entity.components?.keys() ?? [])] : allComponentTypes();
  return [{ value: "", label: "— none —" }, ...types.map((t) => ({ value: t, label: t }))];
}

function allComponentTypes() {
  const seen = new Set();
  for (const root of engine.rootEntities ?? []) {
    root.traverse?.((entity) => {
      for (const type of entity.components?.keys() ?? []) seen.add(type);
    });
  }
  return [...seen];
}

/** Property keys of the component a node names. */
function componentPropOptions(entityId, componentType) {
  const entity = entityId ? engine.getEntity(entityId) : null;
  const component = componentType ? entity?.getComponent?.(componentType) : null;
  const keys = (component?.constructor?.schema ?? []).map((f) => f?.key).filter(Boolean);
  return [{ value: "", label: "— none —" }, ...keys.map((k) => ({ value: k, label: k }))];
}

/**
 * Turns one event-system field descriptor into a node widget spec.
 *
 * `props` is the node's current values, because three of these are CONTEXTUAL —
 * which components exist depends on which entity the node targets, and which
 * properties exist depends on which component. A static option list would offer
 * every component in the project on every node, which is a longer list that is
 * wrong more often.
 */
function widgetFor(field, props) {
  const base = { key: field.key, label: field.label, description: field.description };
  switch (field.type) {
    case "event":
      return { ...base, type: "select", options: eventOptions() };
    case "entity":
      return { ...base, type: "select", options: entityOptions() };
    case "componentType":
      return { ...base, type: "select", options: componentOptions(props.target) };
    case "componentProp":
      return { ...base, type: "select", options: componentPropOptions(props.target, props.component) };
    case "select":
      return { ...base, type: "select", options: field.options ?? [] };
    case "number":
      return { ...base, type: "number", step: field.step ?? 0.1, min: field.min, max: field.max };
    case "boolean":
      return { ...base, type: "boolean" };
    case "asset":
      return { ...base, type: "asset", exts: field.exts };
    case "prefab":
      return { ...base, type: "asset", exts: ["prefab"] };
    case "scriptMethod": {
      // A dropdown of the target's real methods, from the cache the panel warms
      // on mount. Cold (or no target picked yet) falls back to a text input
      // rather than an empty dropdown — an empty dropdown reads as "this script
      // has no methods", which is a different and wrong statement.
      const methods = cachedMethodsForEntity(
        engine.getEntity(props.target) ?? null,
        useProjectStore.getState().rootPath,
      );
      if (!methods?.length) return { ...base, type: "string", placeholder: "onOpen" };
      return {
        ...base,
        type: "select",
        options: [
          { value: "", label: "— none —" },
          ...methods.map((m) => ({
            value: m.name,
            label: `${m.name}(${(m.params ?? []).map((p) => p.name).join(", ")})`,
          })),
        ],
      };
    }
    default:
      return { ...base, type: "string" };
  }
}

/**
 * `describe(type, props)` — the shape `GraphNode` renders.
 *
 * An action's fields are exposed BOTH as data inputs (so a value can be wired
 * in) and as inline editors on those inputs (so an unwired node is still
 * directly editable). That is the toolkit's `editable` mechanism, and it is
 * what keeps a simple node simple: wire nothing and it behaves exactly like the
 * same action in a row list.
 */
export function describeEventNode(type, props = {}) {
  const def = NODE_TYPES[type];
  if (!def) return null;
  const fieldByKey = new Map((def.fields ?? []).map((f) => [f.key, f]));
  const inputs = (def.inputs ?? []).map((input) => {
    if (input.type === EXEC) return { ...input, label: input.label ?? "" };
    const field = fieldByKey.get(input.key);
    if (!field) return input;
    const widget = widgetFor(field, props);
    return { ...input, label: field.label, editable: true, widget: widget.type, options: widget.options, exts: widget.exts, step: widget.step, placeholder: widget.placeholder };
  });
  // Fields already shown inline on an input must not also appear as a param,
  // or every action node renders each of its settings twice.
  const inlined = new Set(inputs.map((i) => i.key));
  const params = (def.fields ?? [])
    .filter((f) => !inlined.has(f.key))
    .map((f) => widgetFor(f, props));
  return { label: def.label, cat: def.cat, inputs, outputs: def.outputs ?? [], params };
}

/** Fresh props for a new node — the fields' own defaults. */
export function eventNodeDefaults(type) {
  const def = NODE_TYPES[type];
  if (!def) return {};
  const props = {};
  for (const field of def.fields ?? []) {
    if (field.type === "select") props[field.key] = field.options?.[0] ?? "";
    else if (field.type === "number") props[field.key] = 0;
    else if (field.type === "boolean") props[field.key] = false;
    else props[field.key] = "";
  }
  return props;
}

/** Palette entries, grouped by category. */
export const eventPaletteItems = Object.entries(NODE_TYPES).map(([type, def]) => ({
  type,
  label: def.label,
  cat: def.cat,
  catLabel: CATEGORY_LABELS[def.cat] ?? def.cat,
  inputTypes: (def.inputs ?? []).map((i) => i.type),
  outputTypes: (def.outputs ?? []).map((o) => o.type),
}));

/** The registry object `GraphEditor` takes. */
export const eventGraphRegistry = {
  describe: describeEventNode,
  items: eventPaletteItems,
  defaults: eventNodeDefaults,
  protectedTypes: [],
};
