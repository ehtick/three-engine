/**
 * Entity and component operations.
 *
 * Every mutation goes through `commandBus`, never through `engine.*` directly.
 * That is the single most important rule in this file: a script (or an MCP
 * client) that spawned entities straight into the engine would produce a scene
 * the user cannot undo, and a `dirty` flag that never gets set, so the work
 * would be silently lost on the next scene load. Routing through the bus makes
 * automated edits indistinguishable from hand edits — including in the undo
 * menu, where "Undo Create Spawner" is exactly what the user expects to see.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { commandBus } from "../../commands/CommandBus.js";
import {
  CreateEntityCommand,
  DeleteEntityCommand,
  RenameEntityCommand,
  ReparentEntityCommand,
  DuplicateEntityCommand,
  SetEntityTagsCommand,
  BatchCommand,
  topMostIds,
} from "../../commands/entityCommands.js";
import {
  AddComponentCommand,
  RemoveComponentCommand,
  SetComponentPropCommand,
} from "../../commands/componentCommands.js";
import { SetTransformCommand } from "../../commands/transformCommands.js";
import { getComponentClass, getComponentTypes } from "../../../engine/index.js";
import { optionsOf, preparePropValue, preparePropsObject } from "../props.js";

/** Looks an entity up, throwing a useful message rather than returning null —
 *  an automated caller passing a stale id should hear about it. */
function mustGet(id) {
  const entity = engine.getEntity(id);
  if (!entity) throw new Error(`No entity with id "${id}"`);
  return entity;
}

/**
 * Serializable view of an entity. Deliberately NOT the live `Entity` — an op
 * result has to survive a JSON round-trip to reach an MCP client, and handing
 * scripts the live object here would make the two consumers behave differently.
 * Scripts that want the live object have `Editor.entities.live(id)`.
 */
export function describeEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    parentId: entity.parent?.id ?? null,
    childIds: entity.children.map((child) => child.id),
    tags: [...(entity.tags ?? [])],
    transform: entity.getTransform(),
    components: [...entity.components.values()].map((component) => ({
      type: component.type,
      props: { ...component.props },
    })),
  };
}

defineOp({
  name: "entity.list",
  readOnly: true,
  description:
    "List every entity in the open scene as a flat array of { id, name, parentId, childIds, tags, transform, components }. Use entity.get for one entity.",
  params: {
    tag: { type: "string", description: "Only entities carrying this tag." },
    nameContains: { type: "string", description: "Case-insensitive name substring filter." },
  },
  run({ tag, nameContains }) {
    let list = [...engine.entities.values()];
    if (tag) list = list.filter((entity) => entity.tags?.includes(tag));
    if (nameContains) {
      const needle = nameContains.toLowerCase();
      list = list.filter((entity) => entity.name.toLowerCase().includes(needle));
    }
    return list.map(describeEntity);
  },
});

defineOp({
  name: "entity.get",
  readOnly: true,
  description: "Full description of one entity, including every component's props.",
  params: { id: { type: "string", required: true, description: "Entity id." } },
  run({ id }) {
    return describeEntity(mustGet(id));
  },
});

defineOp({
  name: "entity.create",
  undoable: true,
  description:
    "Create an entity and return its description. Components can be attached in the same call, which is one undo step rather than several.",
  params: {
    name: { type: "string", default: "Entity", description: "Display name." },
    parentId: { type: "string", description: "Parent entity id; omit for a root entity." },
    transform: {
      type: "object",
      description: "{ position?: [x,y,z], rotation?: [x,y,z], scale?: [x,y,z] } in local space.",
    },
    components: {
      type: "array",
      description: "[{ type, props? }] attached on creation, e.g. [{ type: 'mesh', props: { geometry: 'box' } }].",
      items: { type: "object" },
    },
  },
  run({ name = "Entity", parentId, transform, components = [] }) {
    // `CreateEntityCommand` resolves an unknown parentId to null and silently
    // creates a root entity. That is fine for the inspector, which can only
    // pass ids it just read, and wrong for an automated caller: a stale or
    // mistyped id produces an entity in the wrong place with nothing to
    // indicate it. Fail loudly instead.
    if (parentId && !engine.getEntity(parentId)) {
      throw new Error(`No entity with id "${parentId}" to parent to.`);
    }
    // Inline components used to go straight through unchecked, so
    // `[{ type: "no_such_component_xyz" }]` SUCCEEDED and attached a garbage
    // component — while `component.add`, the other route to the same result,
    // correctly refused it. The garbage then serialised into the `.scene` file
    // and the editor warned about it on every subsequent load. Same checks on
    // both paths, before anything is created.
    const checked = components.map((entry, index) => {
      const type = entry?.type;
      if (!type) throw new Error(`components[${index}] has no "type".`);
      if (!getComponentClass(type)) {
        throw new Error(`Unknown component type "${type}" in components[${index}]. See component.types.`);
      }
      return { ...entry, type, props: preparePropsObject(type, entry.props ?? {}) };
    });
    const command = new CreateEntityCommand({ name, parentId, transform, components: checked });
    commandBus.execute(command);
    return describeEntity(mustGet(command.entityId));
  },
});

defineOp({
  name: "entity.delete",
  undoable: true,
  description: "Delete entities (and their descendants). Accepts one id or many.",
  params: {
    ids: { type: "array", required: true, description: "Entity ids to delete.", items: { type: "string" } },
  },
  run({ ids }) {
    // Built as one BatchCommand so a multi-delete is a single Ctrl+Z, matching
    // what deleting a multi-selection in the hierarchy does. `topMostIds` drops
    // ids whose ancestor is also being deleted — those get removed with the
    // parent anyway, and keeping them would make undo restore them twice.
    const commands = topMostIds(ids)
      .filter((id) => engine.getEntity(id))
      .map((id) => new DeleteEntityCommand(id));
    if (!commands.length) return { deleted: 0 };
    commandBus.execute(new BatchCommand(commands, `Delete ${commands.length} entities`));
    return { deleted: commands.length };
  },
});

defineOp({
  name: "entity.rename",
  undoable: true,
  description:
    "Rename one entity. Names are labels, not identifiers — nothing resolves by name, so duplicates are allowed and renaming breaks no references.",
  params: {
    id: { type: "string", required: true },
    name: { type: "string", required: true },
  },
  run({ id, name }) {
    mustGet(id);
    commandBus.execute(new RenameEntityCommand(id, name));
    return describeEntity(mustGet(id));
  },
});

defineOp({
  name: "entity.reparent",
  undoable: true,
  description:
    "Move an entity under a new parent, preserving its world transform. Omit parentId to move it to the scene root.",
  params: {
    id: { type: "string", required: true },
    parentId: { type: "string", description: "New parent id; omit for the scene root." },
    index: { type: "number", description: "Position among the new parent's children." },
  },
  run({ id, parentId = null, index = null }) {
    mustGet(id);
    commandBus.execute(new ReparentEntityCommand(id, parentId, index));
    return describeEntity(mustGet(id));
  },
});

defineOp({
  name: "entity.duplicate",
  undoable: true,
  description: "Duplicate entities including their subtrees. Returns the new entities.",
  params: {
    ids: { type: "array", required: true, items: { type: "string" } },
  },
  run({ ids }) {
    const commands = ids.filter((id) => engine.getEntity(id)).map((id) => new DuplicateEntityCommand(id));
    if (!commands.length) return [];
    commandBus.execute(new BatchCommand(commands, `Duplicate ${commands.length} entities`));
    // `entityId` is only assigned by do(), which the bus has now run.
    return commands
      .map((command) => engine.getEntity(command.entityId))
      .filter(Boolean)
      .map(describeEntity);
  },
});

defineOp({
  name: "entity.setTransform",
  undoable: true,
  description:
    "Set an entity's local transform. Omitted channels keep their current value, so this doubles as 'just move it'.",
  params: {
    id: { type: "string", required: true },
    position: { type: "array", description: "[x, y, z]", items: { type: "number" } },
    rotation: { type: "array", description: "[x, y, z] Euler in radians", items: { type: "number" } },
    scale: { type: "array", description: "[x, y, z]", items: { type: "number" } },
  },
  run({ id, position, rotation, scale }) {
    const entity = mustGet(id);
    const before = entity.getTransform();
    const after = {
      position: position ?? before.position,
      rotation: rotation ?? before.rotation,
      scale: scale ?? before.scale,
    };
    commandBus.execute(new SetTransformCommand(id, after, before));
    return describeEntity(entity);
  },
});

defineOp({
  name: "entity.setTags",
  undoable: true,
  description:
    "Replace an entity's tag list outright (not a merge). Tags are how scripts and entity.list find entities by role rather than by name.",
  params: {
    id: { type: "string", required: true },
    tags: { type: "array", required: true, items: { type: "string" } },
  },
  run({ id, tags }) {
    mustGet(id);
    commandBus.execute(new SetEntityTagsCommand(id, tags));
    return describeEntity(mustGet(id));
  },
});

// ---- components -------------------------------------------------------------

defineOp({
  name: "component.types",
  readOnly: true,
  description:
    "List every registered component type with its label and inspector schema. This is how you discover what `component.add` accepts and which props a type has. A prop of type 'select' carries its `options` — those are the only legal values, so read them rather than guessing. A prop whose label says DEPRECATED exists only so older scenes still load; set the prop its label names instead, because writing the deprecated one is ignored once the replacement has been set. Entries marked `inferred: true` are props the type has a default for but does not describe in its schema, because its inspector section is hand-written — the key and the default are real, the type is a guess from the default's shape.",
  params: {},
  run() {
    return getComponentTypes().map((type) => {
      const cls = getComponentClass(type);
      const declared = (cls?.schema ?? []).map((descriptor) => ({
        key: descriptor.key,
        label: descriptor.label,
        type: descriptor.type,
        // `options` can be a FUNCTION — see optionsOf. Spreading the raw value
        // put a function into a JSON result, where it vanishes: `collider.layer`
        // and `charactercontroller.layer` both advertised `type: "select"` with
        // no options at all, against a description promising the options are the
        // only legal values.
        ...(descriptor.options ? { options: optionsOf(descriptor) ?? [] } : {}),
        ...(descriptor.min !== undefined ? { min: descriptor.min } : {}),
        ...(descriptor.max !== undefined ? { max: descriptor.max } : {}),
      }));
      // A component whose inspector section is hand-written declares
      // `schema = []` and a full set of defaults — `uielement` exposes
      // anchorMin, anchorMax, pivot, pos, size, opacity, visible and
      // raycastTarget that way, none of which were discoverable here. That is
      // fine for the Inspector and useless for anything reading the API, so the
      // defaults it does not describe are listed too, marked as inferred.
      const described = new Set(declared.map((entry) => entry.key));
      const inferred = Object.entries(cls?.defaults ?? {})
        .filter(([key]) => !described.has(key) && key !== "enabled")
        .map(([key, value]) => ({
          key,
          label: key,
          type:
            typeof value === "number" ? "number"
            : typeof value === "boolean" ? "boolean"
            : typeof value === "string" ? "string"
            : Array.isArray(value) ? "array"
            : value && typeof value === "object" ? "object"
            : "any",
          inferred: true,
        }));
      return {
        type,
        label: cls?.label ?? type,
        tags: cls?.tags ?? [],
        defaults: { ...(cls?.defaults ?? {}) },
        schema: [...declared, ...inferred],
      };
    });
  },
});

defineOp({
  name: "component.add",
  undoable: true,
  description: "Attach a component to an entity. Use component.types to see what's available.",
  params: {
    id: { type: "string", required: true, description: "Entity id." },
    type: { type: "string", required: true, description: "Component type, e.g. 'mesh', 'light', 'script'." },
    props: { type: "object", description: "Initial props; unspecified keys use the type's defaults." },
  },
  run({ id, type, props = {} }) {
    const entity = mustGet(id);
    if (!getComponentClass(type)) {
      throw new Error(`Unknown component type "${type}". See component.types.`);
    }
    if (entity.components.has(type)) throw new Error(`Entity "${entity.name}" already has a "${type}" component`);
    commandBus.execute(new AddComponentCommand(id, type, preparePropsObject(type, props)));
    return describeEntity(entity);
  },
});

defineOp({
  name: "component.remove",
  undoable: true,
  description:
    "Detach a component from an entity, discarding its properties. Undoable, so the properties come back with history.undo.",
  params: {
    id: { type: "string", required: true },
    type: { type: "string", required: true },
  },
  run({ id, type }) {
    const entity = mustGet(id);
    if (!entity.components.has(type)) throw new Error(`Entity "${entity.name}" has no "${type}" component`);
    commandBus.execute(new RemoveComponentCommand(id, type));
    return describeEntity(entity);
  },
});

defineOp({
  name: "component.setProp",
  undoable: true,
  description:
    "Set one property on an entity's component. The key must be a property the type actually declares (component.types lists them) and, for a 'select' property, the value must be one of its options — both are refused rather than stored, because a props object accepts anything and a bad write would otherwise look like it succeeded.",
  params: {
    id: { type: "string", required: true },
    type: { type: "string", required: true },
    key: { type: "string", required: true },
    value: {
      description:
        "The value itself — a number, boolean, array or object as the property requires. NOT its JSON text: \"7.5\" and \"[1, 2, 3]\" are strings and are refused.",
    },
  },
  run({ id, type, key, value }) {
    const entity = mustGet(id);
    const component = entity.components.get(type);
    if (!component) throw new Error(`Entity "${entity.name}" has no "${type}" component`);
    const next = preparePropValue(type, key, value, component);
    commandBus.execute(new SetComponentPropCommand(id, type, key, next));
    return describeEntity(entity);
  },
});
