import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { instanceNodeOf } from "./prefab/sync.js";
import { SCENE_SETTINGS_DEFAULTS } from "./sceneSettings.js";

const SCENE_VERSION = 1;

/**
 * A prefab instance serializes as a *link*, not as a tree: the entities under
 * it are the prefab's business, and only the differences (its overrides) belong
 * to the scene. That's what makes editing a prefab update every instance in
 * every scene. See engine/prefab/ for the format.
 */
export function serializeEntity(entity) {
  if (entity.prefab) return instanceNodeOf(entity);
  return {
    id: entity.id,
    name: entity.name,
    ...entity.getTransform(),
    viewOnly: !!entity.viewOnly,
    // Omitted entirely when empty — the overwhelmingly common case, and a
    // `"tags": []` on every entity would bloat every scene file for nothing.
    ...(entity.tags?.length ? { tags: [...entity.tags] } : {}),
    // Newer scenes may include entities without these flags — defaults are
    // booleans, but we still defensively normalise on read.
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
    components: [...entity.components.values()].map((c) => c.toJSON()),
    children: entity.children.map(serializeEntity),
  };
}

/**
 * `embedPrefabs` bundles every registered prefab def into the scene JSON. The
 * editor doesn't need it (it scans the project for `.prefab` files), but an
 * exported build has no project to scan — and the player must be able to
 * resolve instances (and `engine.instantiate` from scripts) with no I/O.
 */
export function serializeScene(engine, { embedPrefabs = false } = {}) {
  const scene = {
    version: SCENE_VERSION,
    name: engine.sceneName,
    settings: structuredClone(engine.settings),
    entities: engine.rootEntities.map(serializeEntity),
  };
  if (embedPrefabs) scene.prefabs = structuredClone(prefabRegistry.all());
  return scene;
}

export function instantiateEntity(engine, data, parent) {
  if (data.prefab) return instantiatePrefabNode(engine, data, parent);

  const entity = engine.createEntity({ id: data.id, name: data.name, parent });
  entity.setTransform(data);
  // Restore the entity-wide viewOnly flag before attaching components so
  // their initial `_viewOnlyActive` cache picks up the inherited state.
  if (data.viewOnly) entity.setViewOnly(true);
  if (data.tags?.length) entity.setTags(data.tags);
  // Per-mode enabled flags. Older scenes omit them — default to true so
  // existing scenes keep their current behaviour.
  if (data.enabledInEditor === false) entity.setEnabledInEditor(false);
  if (data.enabledInGame === false) entity.setEnabledInGame(false);
  for (const { type, props } of data.components ?? []) {
    entity.addComponent(type, props);
  }
  for (const childData of data.children ?? []) {
    instantiateEntity(engine, childData, entity);
  }
  return entity;
}

/**
 * Restores a serialized scene ONTO the live one, reusing whatever already
 * matches instead of destroying and rebuilding it.
 *
 * This is what leaving Play mode uses. The full deserializeScene path is
 * correct there but brutally expensive: destroying every entity throws away
 * loaded models, uploaded geometry, and — worst — the GI component, whose
 * re-attach kicks off a complete revoxelize + shader-compile wave. Measured on
 * a real project that was a ~2.2s frozen main thread, against ~0.3s for
 * everything else in the stop path put together.
 *
 * Play almost never changes scene *structure*: scripts move things. So diff
 * the snapshot against the live scene and touch only what actually differs.
 * Components that keep simulation state outside their props (`resetOnStop`)
 * are still torn down and re-attached, so a second Play starts as clean as it
 * does today.
 */
export async function reconcileScene(engine, json) {
  if (json.version !== SCENE_VERSION) {
    throw new Error(`Unsupported scene version ${json.version}`);
  }
  engine.sceneName = json.name ?? "Untitled";
  await engine.applySettings(json.settings ?? structuredClone(SCENE_SETTINGS_DEFAULTS));
  for (const def of json.prefabs ?? []) {
    if (def?.guid) prefabRegistry.register(def, def.path ?? null);
  }

  await engine.batchHierarchy(() => {
    // A prefab instance serializes as a link, so its descendants are absent
    // from the snapshot. Deciding those subtrees first means the sweep below
    // can tell "not in the snapshot because it was spawned at runtime" from
    // "not in the snapshot because a prefab owns it".
    const survivors = new Set();
    const respawn = [];
    const plan = [];
    const indexNode = (data, parent, order) => {
      survivors.add(data.id);
      if (data.prefab) {
        const live = engine.getEntity(data.id);
        // Untouched instance → leave the whole subtree alone. Anything else
        // (moved, overridden, gone) goes back through the prefab expander,
        // which is the only thing that can rebuild it correctly.
        // Either way the subtree is prefab-owned, so shield it from the
        // runtime-spawn sweep below. A respawn destroys it itself, and has to
        // be the one to do it: the sweep would take the descendants out from
        // under it, losing the fid→id map that hands them back their ids.
        live?.traverse((e) => survivors.add(e.id));
        if (!(live?.prefab && JSON.stringify(instanceNodeOf(live)) === JSON.stringify(data))) {
          respawn.push({ data, parent, order });
        }
        return;
      }
      plan.push({ data, parent, order });
      (data.children ?? []).forEach((child, i) => indexNode(child, data.id, i));
    };
    (json.entities ?? []).forEach((data, i) => indexNode(data, null, i));

    // 1. Entities that exist only because Play created them.
    for (const entity of [...engine.entities.values()]) {
      if (!survivors.has(entity.id) && engine.entities.has(entity.id)) {
        engine.destroyEntity(entity);
      }
    }

    // 2. Plain entities: reuse in place, create the ones Play destroyed.
    //    Parents come before children in `plan`, so a parent always exists by
    //    the time its children are reparented onto it.
    for (const { data, parent } of plan) {
      const parentEntity = parent === null ? null : engine.getEntity(parent) ?? null;
      const existing = engine.getEntity(data.id);
      if (!existing) {
        const created = engine.createEntity({ id: data.id, name: data.name, parent: parentEntity });
        applyEntityData(created, data);
        for (const { type, props } of data.components ?? []) created.addComponent(type, props);
        continue;
      }
      if (existing.parent !== parentEntity) existing.setParent(parentEntity);
      existing.name = data.name;
      applyEntityData(existing, data);
      reconcileComponents(existing, data.components ?? []);
    }

    // 3. Prefab instances that need rebuilding from their def. After the plain
    //    pass, so an instance parented under an entity Play destroyed has that
    //    parent back by now.
    for (const { data, parent } of respawn) {
      const live = engine.getEntity(data.id);
      // Hand every descendant back its old id: selection, script references
      // and the undo stack all address entities by id (same contract as
      // prefab/sync.js `respawnInstance`).
      const ids = new Map();
      if (live) {
        live.traverse((e) => {
          if (e.fidPath) ids.set(e.fidPath.join("/"), e.id);
        });
        engine.destroyEntity(live);
      }
      instantiatePrefabNode(engine, data, parent === null ? null : engine.getEntity(parent) ?? null, {
        idFor: (fidPath) => ids.get((fidPath ?? []).join("/")),
      });
    }

    // 4. Sibling order. The hierarchy panel renders `children` directly, so a
    //    script that reparented something must not leave the tree reshuffled.
    orderSiblings(engine, plan, respawn);

    // Inside the batch, so this collapses into the single event the batch
    // emits on exit. Transform-only restores mutate nothing that emits on its
    // own, and the editor's React mirror still has to be told.
    engine.emit("hierarchy-changed");
  });
}

function applyEntityData(entity, data) {
  entity.setTransform(data);
  entity.setViewOnly(!!data.viewOnly);
  entity.setTags(data.tags ?? []);
  entity.setEnabledInEditor(data.enabledInEditor !== false);
  entity.setEnabledInGame(data.enabledInGame !== false);
}

/** Cheap structural compare — prop values are always JSON-serializable. */
function sameProp(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function reconcileComponents(entity, wanted) {
  const wantedTypes = new Set(wanted.map((c) => c.type));
  for (const type of [...entity.components.keys()]) {
    if (!wantedTypes.has(type)) entity.removeComponent(type);
  }
  for (const { type, props } of wanted) {
    const existing = entity.getComponent(type);
    // Simulation state (a playing sound, an animation state machine's
    // position, a script instance's fields) lives outside props and would
    // otherwise leak from one Play session into the next.
    if (existing && existing.constructor.resetOnStop) {
      entity.removeComponent(type);
      entity.addComponent(type, props);
      continue;
    }
    if (!existing) {
      entity.addComponent(type, props);
      continue;
    }
    for (const [key, value] of Object.entries(props ?? {})) {
      if (!sameProp(existing.props[key], value)) existing.setProp(key, value);
    }
  }
}

function orderSiblings(engine, plan, respawn) {
  const wantedOrder = new Map(); // parentId (or null) -> [entity id, ...]
  for (const { data, parent, order } of [...plan, ...respawn]) {
    if (!wantedOrder.has(parent)) wantedOrder.set(parent, []);
    wantedOrder.get(parent)[order] = data.id;
  }
  for (const [parent, ids] of wantedOrder) {
    const siblings = parent === null ? engine.rootEntities : engine.getEntity(parent)?.children;
    if (!siblings) continue;
    const byId = new Map(siblings.map((e) => [e.id, e]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    // Entities a prefab or a component owns aren't in the snapshot; keep them
    // after the authored ones rather than dropping them on the floor.
    const rest = siblings.filter((e) => !ids.includes(e.id));
    siblings.length = 0;
    siblings.push(...ordered, ...rest);
  }
}

/** Replaces the current scene contents with the serialized scene. */
export async function deserializeScene(engine, json) {
  if (json.version !== SCENE_VERSION) {
    throw new Error(`Unsupported scene version ${json.version}`);
  }
  // Do not reset renderer settings to defaults only to restore the scene's
  // settings immediately afterwards. Besides doing two expensive rebuilds,
  // that allowed components to attach to the temporary renderer between the
  // two async initializations. Renderer-owned objects (notably post-process
  // pipelines) then retained a disposed backend and rendered black on the
  // next Play. Apply and await the final settings before attaching anything.
  engine.clear({ resetSettings: false });
  engine.sceneName = json.name ?? "Untitled";
  await engine.applySettings(json.settings ?? structuredClone(SCENE_SETTINGS_DEFAULTS));
  // Prefabs must be in the registry before any instance node is expanded.
  for (const def of json.prefabs ?? []) {
    if (def?.guid) prefabRegistry.register(def, def.path ?? null);
  }
  // One "hierarchy-changed" for the whole load: each listener is O(scene), so
  // the per-entity event this used to fire made loading quadratic.
  await engine.batchHierarchy(() => {
    for (const entityData of json.entities ?? []) {
      instantiateEntity(engine, entityData, null);
    }
    engine.emit("hierarchy-changed");
  });
}
