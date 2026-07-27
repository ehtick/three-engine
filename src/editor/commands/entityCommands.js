import { engine } from "../engineInstance.js";
import { serializeEntity, instantiateEntity } from "../../engine/index.js";

export class CreateEntityCommand {
  /**
   * spec: { name, parentId?, transform?, components?: [{type, props?}],
   *         children?: [spec] } — children nest recursively (no parentId).
   */
  constructor(spec) {
    this.spec = spec;
    this.entityId = null; // assigned on first do(), reused on redo
    this.snapshot = null; // serialized tree captured after first do()
    this.label = `Create ${spec.name}`;
  }

  #build(spec, parent) {
    const entity = engine.createEntity({ name: spec.name, parent });
    if (spec.transform) entity.setTransform(spec.transform);
    for (const { type, props } of spec.components ?? []) {
      entity.addComponent(type, props);
    }
    for (const childSpec of spec.children ?? []) this.#build(childSpec, entity);
    return entity;
  }

  do() {
    const parent = this.spec.parentId ? engine.getEntity(this.spec.parentId) : null;
    // Redo re-instantiates the serialized tree so every entity (including
    // children) keeps its original id.
    if (this.snapshot) {
      instantiateEntity(engine, this.snapshot, parent);
      return;
    }
    const entity = this.#build(this.spec, parent);
    this.entityId = entity.id;
    this.snapshot = serializeEntity(entity);
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    if (entity) engine.destroyEntity(entity);
  }
}

export class DeleteEntityCommand {
  constructor(entityId) {
    const entity = engine.getEntity(entityId);
    this.snapshot = serializeEntity(entity);
    this.parentId = entity.parent?.id ?? null;
    this.index = entity.parent
      ? entity.parent.children.indexOf(entity)
      : engine.rootEntities.indexOf(entity);
    this.entityId = entityId;
    this.label = `Delete ${entity.name}`;
  }

  do() {
    const entity = engine.getEntity(this.entityId);
    if (entity) engine.destroyEntity(entity);
  }

  undo() {
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    const entity = instantiateEntity(engine, this.snapshot, parent);
    // Restore original sibling position.
    const siblings = parent ? parent.children : engine.rootEntities;
    const idx = siblings.indexOf(entity);
    if (idx !== -1 && this.index !== -1 && idx !== this.index) {
      siblings.splice(idx, 1);
      siblings.splice(this.index, 0, entity);
    }
  }
}

export class RenameEntityCommand {
  constructor(entityId, newName) {
    this.entityId = entityId;
    this.newName = newName;
    this.oldName = engine.getEntity(entityId)?.name;
    this.label = `Rename to ${newName}`;
  }

  do() {
    const entity = engine.getEntity(this.entityId);
    if (entity) entity.name = this.newName;
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    if (entity) entity.name = this.oldName;
  }
}

/**
 * Replaces an entity's tag list. Tags are a whole-list value rather than a
 * per-tag toggle, so one add or remove is one undo step — which is what the
 * user perceives ("I added the boss tag"), and keeps the command trivial.
 */
export class SetEntityTagsCommand {
  constructor(entityId, tags) {
    this.entityId = entityId;
    this.tags = [...tags];
    this.oldTags = [...(engine.getEntity(entityId)?.tags ?? [])];
    this.label = "Set tags";
  }

  do() {
    engine.getEntity(this.entityId)?.setTags(this.tags);
  }

  undo() {
    engine.getEntity(this.entityId)?.setTags(this.oldTags);
  }
}

/**
 * Toggles the entity-wide `viewOnly` flag. When true, every component on
 * the entity opts into frustum-gated ticking (the per-component `viewOnly`
 * is an OR with this — see `Entity.setViewOnly`).
 */
export class SetEntityViewOnlyCommand {
  constructor(entityId, value) {
    this.entityId = entityId;
    this.value = !!value;
    this.oldValue = !!engine.getEntity(entityId)?.viewOnly;
    this.label = this.value ? "View Only" : "Always On";
  }

  do() {
    engine.getEntity(this.entityId)?.setViewOnly(this.value);
  }

  undo() {
    engine.getEntity(this.entityId)?.setViewOnly(this.oldValue);
  }
}

/**
 * Toggles the "enabled in editor" flag on a single entity. Visible in the
 * editor (i.e. when `!engine.playing`) when true. The engine applies this
 * to `entity.object3D.visible` on every frame so changing it doesn't
 * require an explicit redraw.
 */
export class SetEntityEnabledInEditorCommand {
  constructor(entityId, value) {
    this.entityId = entityId;
    this.value = !!value;
    this.oldValue = engine.getEntity(entityId)?.enabledInEditor !== false;
    this.label = this.value ? "Show in Editor" : "Hide in Editor";
  }

  do() {
    engine.getEntity(this.entityId)?.setEnabledInEditor(this.value);
  }

  undo() {
    engine.getEntity(this.entityId)?.setEnabledInEditor(this.oldValue);
  }
}

/** Mirrors SetEntityEnabledInEditorCommand for the in-game (play) mode. */
export class SetEntityEnabledInGameCommand {
  constructor(entityId, value) {
    this.entityId = entityId;
    this.value = !!value;
    this.oldValue = engine.getEntity(entityId)?.enabledInGame !== false;
    this.label = this.value ? "Show in Game" : "Hide in Game";
  }

  do() {
    engine.getEntity(this.entityId)?.setEnabledInGame(this.value);
  }

  undo() {
    engine.getEntity(this.entityId)?.setEnabledInGame(this.oldValue);
  }
}

/** True if `candidateId` is `entityId` itself or one of its descendants. */
export function isDescendantOf(candidateId, entityId) {
  const entity = engine.getEntity(entityId);
  if (!entity) return false;
  let found = false;
  entity.traverse((e) => {
    if (e.id === candidateId) found = true;
  });
  return found;
}

export class ReparentEntityCommand {
  /**
   * newIndex (optional): sibling position under the new parent. Computed
   * against the sibling list *without* the moved entity; null = append.
   */
  constructor(entityId, newParentId, newIndex = null) {
    const entity = engine.getEntity(entityId);
    this.entityId = entityId;
    this.newParentId = newParentId;
    this.newIndex = newIndex;
    this.oldParentId = entity.parent?.id ?? null;
    this.oldIndex = entity.parent
      ? entity.parent.children.indexOf(entity)
      : engine.rootEntities.indexOf(entity);
    this.oldTransform = entity.getTransform();
    this.label = `Move ${entity.name}`;
  }

  #move(parentId, index) {
    const entity = engine.getEntity(this.entityId);
    const parent = parentId ? engine.getEntity(parentId) : null;
    // attach() keeps the world transform while re-computing the local one.
    (parent ? parent.object3D : engine.scene).attach(entity.object3D);
    entity.setParent(parent); // appends to the sibling list
    if (index != null) {
      const siblings = parent ? parent.children : engine.rootEntities;
      siblings.splice(siblings.indexOf(entity), 1);
      siblings.splice(Math.min(index, siblings.length), 0, entity);
    }
    engine.emit("hierarchy-changed");
  }

  do() {
    this.#move(this.newParentId, this.newIndex);
  }

  undo() {
    this.#move(this.oldParentId, this.oldIndex === -1 ? null : this.oldIndex);
    const entity = engine.getEntity(this.entityId);
    entity.setTransform(this.oldTransform);
  }
}

/** Groups several commands into one undo/redo step. */
export class BatchCommand {
  constructor(commands, label) {
    this.commands = commands;
    this.label = label ?? commands[0]?.label ?? "Batch";
  }

  do() {
    for (const c of this.commands) c.do();
  }

  undo() {
    for (const c of [...this.commands].reverse()) c.undo();
  }
}

/** Instantiates serialized entity snapshots (clipboard paste). */
export class PasteCommand {
  constructor(snapshots, parentId) {
    // Own the snapshots: ids get pinned on first do() for stable redo.
    this.snapshots = structuredClone(snapshots);
    this.parentId = parentId ?? null;
    this.entityIds = [];
    this.label = snapshots.length === 1 ? `Paste ${snapshots[0].name}` : `Paste ${snapshots.length} entities`;
  }

  do() {
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    this.entityIds = this.snapshots.map((snapshot) => {
      const entity = instantiateEntity(engine, snapshot, parent);
      snapshot.id = entity.id;
      return entity.id;
    });
    engine.emit("hierarchy-changed");
  }

  undo() {
    for (const id of this.entityIds) {
      const entity = engine.getEntity(id);
      if (entity) engine.destroyEntity(entity);
    }
  }
}

/**
 * Filters a selection down to entities whose ancestors are NOT also selected.
 * Batch operations (delete, copy, reparent…) must skip descendants or they'd
 * be processed twice.
 */
export function topMostIds(ids) {
  const set = new Set(ids);
  return ids.filter((id) => {
    let entity = engine.getEntity(id);
    for (let p = entity?.parent; p; p = p.parent) {
      if (set.has(p.id)) return false;
    }
    return true;
  });
}

export class DuplicateEntityCommand {
  constructor(entityId) {
    const entity = engine.getEntity(entityId);
    this.snapshot = stripIds(serializeEntity(entity));
    this.snapshot.name = `${entity.name} Copy`;
    this.parentId = entity.parent?.id ?? null;
    this.entityId = null;
    this.label = `Duplicate ${entity.name}`;
  }

  do() {
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    const entity = instantiateEntity(engine, this.snapshot, parent);
    this.entityId = entity.id;
    this.snapshot.id = entity.id; // stable id across redo
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    if (entity) engine.destroyEntity(entity);
  }
}

export function stripIds(data) {
  const { id, children, ...rest } = data;
  return { ...rest, children: (children ?? []).map(stripIds) };
}
