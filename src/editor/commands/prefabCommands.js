// @ts-check
import { engine } from "../engineInstance.js";
import {
  prefabRegistry,
  serializeEntity,
  instantiateEntity,
  instantiatePrefabNode,
  diffInstance,
  reloadPrefab,
  respawnInstance,
  unpackInstance,
  createDefFromEntity,
  bindEntityToPrefab,
  defWithInstanceApplied,
  instancesAffectedBy,
} from "../../engine/index.js";

/**
 * Undoable prefab operations.
 *
 * The asset file is written as a side effect (the filesystem isn't part of the
 * undo stack the way entities are), but undo *does* rewrite the previous def
 * back to disk — so Ctrl+Z after an accidental Apply really does restore the
 * prefab, not just the scene.
 */

/**
 * Writes a def to disk. Commands can't be async (do/undo are called
 * synchronously by the bus), so the write is queued rather than awaited —
 * chained per path so an undo can't overtake the write it's undoing.
 *
 * Callers that need the file to exist before they act on it (refreshing the
 * Assets panel, say) must await `flushPrefabWrites()`.
 */
const writeQueues = new Map(); // path -> promise
function writeDef(path, def) {
  if (!path) return Promise.resolve();
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_scene", { path, contents: JSON.stringify(def, null, 2) });
    })
    .catch((err) => console.error(`Couldn't write ${path}: ${err}`));
  writeQueues.set(path, next);
  return next;
}

/** Resolves once every queued def write has landed on disk. */
export function flushPrefabWrites() {
  return Promise.all([...writeQueues.values()]);
}

/** Overrides of every live instance of `guid`, so undo can restore them exactly. */
function snapshotOverrides(guid) {
  const map = new Map();
  for (const entity of instancesAffectedBy(engine, guid)) {
    map.set(entity.id, diffInstance(entity));
  }
  return map;
}

/** Swaps the def in the registry, on disk, and across every live instance. */
function swapDef(def, path, overridesById = null) {
  reloadPrefab(engine, def, path, { overridesById });
  writeDef(path, def);
  // The catalog (names, new prefabs) may have changed — refresh the UI mirror.
  import("../store/prefabStore.js").then(({ usePrefabStore }) => usePrefabStore.getState().bump());
}

export class InstantiatePrefabCommand {
  constructor(link, { position = null, parentId = null, name = null } = {}) {
    this.link = link;
    this.position = position;
    this.parentId = parentId;
    this.name = name;
    this.entityId = null;
    const def = prefabRegistry.getDef(prefabRegistry.resolveLink(link));
    this.label = `Add ${def?.name ?? "Prefab"}`;
  }

  do() {
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    const node = { id: this.entityId ?? undefined, prefab: this.link, overrides: [] };
    if (this.position) node.position = this.position;
    const entity = instantiatePrefabNode(engine, node, parent);
    if (this.name) entity.name = this.name;
    this.entityId = entity.id; // pinned so redo reuses it
    engine.emit("hierarchy-changed");
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    if (entity) engine.destroyEntity(entity);
  }
}

/**
 * Create Prefab: writes the asset, then converts the source entity into an
 * instance of it (Unity's behaviour — the object you dragged out stays linked).
 *
 * Undo relinks the entity back to a plain tree but deliberately leaves the
 * `.prefab` file on disk: deleting a file the user may already have referenced
 * elsewhere is not something an undo should do silently.
 */
export class CreatePrefabCommand {
  /**
   * @param {string} entityId
   * @param {string} path
   * @param {{ name?: string }} [opts]
   */
  constructor(entityId, path, { name } = {}) {
    const entity = engine.getEntity(entityId);
    this.entityId = entityId;
    this.path = path;
    this.snapshot = serializeEntity(entity); // the pre-prefab tree, for undo
    this.parentId = entity.parent?.id ?? null;
    this.def = null;
    this.name = name ?? entity.name;
    this.label = `Create Prefab ${this.name}`;
  }

  do() {
    const entity = engine.getEntity(this.entityId);
    if (!entity) return;
    // Built once; redo reuses the same def (and so the same guid) so instances
    // created in between keep resolving.
    this.def ??= createDefFromEntity(entity, { name: this.name });
    bindEntityToPrefab(engine, entity, this.def, this.path);
    writeDef(this.path, this.def);
    import("../store/prefabStore.js").then(({ usePrefabStore }) => usePrefabStore.getState().bump());
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    if (entity) engine.destroyEntity(entity);
    instantiateEntity(engine, this.snapshot, parent);
    engine.emit("hierarchy-changed");
  }
}

/** Apply: push an instance's overrides into the prefab asset. `only` limits it
 *  to a subset (the inspector's per-property "Apply to Prefab"). */
export class ApplyPrefabCommand {
  constructor(entityId, only = null) {
    const entity = engine.getEntity(entityId);
    this.entityId = entityId;
    this.guid = prefabRegistry.resolveLink(entity.prefab);
    this.path = prefabRegistry.pathOf(this.guid);
    this.prevDef = structuredClone(prefabRegistry.getDef(this.guid));
    this.nextDef = defWithInstanceApplied(entity, only);
    this.prevOverrides = snapshotOverrides(this.guid);
    this.label = only ? "Apply to Prefab" : "Apply All to Prefab";
  }

  do() {
    swapDef(this.nextDef, this.path);
  }

  undo() {
    // Restore both halves: the asset *and* each instance's override list. Left
    // to re-derive itself, an instance would diff against the restored def and
    // silently keep the applied values as overrides.
    swapDef(this.prevDef, this.path, this.prevOverrides);
  }
}

/** Revert: drop an instance's overrides (all, or a subset). */
export class RevertPrefabCommand {
  constructor(entityId, only = null) {
    const entity = engine.getEntity(entityId);
    this.entityId = entityId;
    this.before = diffInstance(entity);
    // Reverting a subset means keeping everything that wasn't selected.
    this.after = only ? this.before.filter((o) => !only.includes(o)) : [];
    this.label = only ? "Revert" : "Revert All";
  }

  #respawn(overrides) {
    const entity = engine.getEntity(this.entityId);
    if (entity) respawnInstance(engine, entity, structuredClone(overrides));
  }

  do() {
    this.#respawn(this.after);
  }

  undo() {
    this.#respawn(this.before);
  }
}

/** Unpack: sever the link, keep the entities. */
export class UnpackPrefabCommand {
  constructor(entityId, { deep = false } = {}) {
    const entity = engine.getEntity(entityId);
    this.entityId = entityId;
    this.deep = deep;
    // The instance node fully describes the instance — re-expanding from it is
    // an exact undo.
    this.node = serializeEntity(entity);
    this.parentId = entity.parent?.id ?? null;
    this.label = deep ? "Unpack Prefab Completely" : "Unpack Prefab";
  }

  do() {
    const entity = engine.getEntity(this.entityId);
    if (entity) unpackInstance(entity, { deep: this.deep });
    engine.emit("hierarchy-changed");
  }

  undo() {
    const entity = engine.getEntity(this.entityId);
    const parent = this.parentId ? engine.getEntity(this.parentId) : null;
    if (entity) engine.destroyEntity(entity);
    instantiatePrefabNode(engine, this.node, parent);
    engine.emit("hierarchy-changed");
  }
}

export { writeDef };
