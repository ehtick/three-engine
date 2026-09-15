// @ts-check
import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { instanceNodeOf } from "./prefab/sync.js";
import { SCENE_SETTINGS_DEFAULTS } from "./sceneSettings.js";
import { waitForTextureAssets } from "./textureAsset.js";
import { migrateLegacySurfaceModules } from "./vfx/legacyModules.js";
import { freeze } from "./freezeLedger.js";
import { sliceLoop } from "./scheduling.js";

export const SCENE_VERSION = 1;

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
    // Same reasoning: only the rare entity that survives a scene load says so.
    ...(entity.persistent ? { persistent: true } : {}),
    // One enabled flag (both modes) and the editor's viewing aid. Older
    // scenes carried `enabledInEditor` / `enabledInGame`; the reader maps them.
    enabled: entity.enabled !== false,
    visibleInEditor: entity.visibleInEditor !== false,
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
  if (data.persistent) entity.setPersistent(true);
  // `enabled` (both modes) and `visibleInEditor`. Older scenes carried a
  // flag per mode: their game flag is the enabled flag now, and their
  // editor flag the viewing aid. Absent means true.
  if ((data.enabled ?? data.enabledInGame) === false) entity.setEnabled(false);
  if ((data.visibleInEditor ?? data.enabledInEditor) === false) entity.setVisibleInEditor(false);
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
 *
 * `resetStatefulComponents: false` keeps those alive unless their own props
 * changed. That is for applying an AUTHORED edit onto a scene that is still
 * running — the browser preview's live update. There the running game is the
 * thing being debugged, so restarting every script, sound and animation
 * because an unrelated entity moved would be indistinguishable from the page
 * reload this exists to avoid.
 */
export async function reconcileScene(engine, json, { resetStatefulComponents = true } = {}) {
  if (json.version !== SCENE_VERSION) {
    throw new Error(`Unsupported scene version ${json.version}`);
  }
  await migrateLegacySurfaceModules(engine, json);
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
      reconcileComponents(existing, data.components ?? [], resetStatefulComponents);
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
  entity.setPersistent(!!data.persistent);
  entity.setEnabled((data.enabled ?? data.enabledInGame) !== false);
  entity.setVisibleInEditor((data.visibleInEditor ?? data.enabledInEditor) !== false);
}

/** Cheap structural compare — prop values are always JSON-serializable. */
function sameProp(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when every prop the snapshot names already holds that value live.
 *
 * Compared against the DESKTOP value (`getBaseProp`), not `props[key]`: a
 * snapshot is `toJSON`'s base values, while `props` holds what a platform
 * layer put there (componentVariants.js). Comparing the two directly read
 * every phone-overridden key as "changed during play" and Stop un-applied
 * the phone layout.
 */
function propsAlreadyMatch(existing, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (!sameProp(existing.getBaseProp(key), value)) return false;
  }
  return true;
}

function reconcileComponents(entity, wanted, resetStateful = true) {
  const wantedTypes = new Set(wanted.map((c) => c.type));
  for (const type of [...entity.components.keys()]) {
    if (!wantedTypes.has(type)) entity.removeComponent(type);
  }
  for (const { type, props } of wanted) {
    const existing = entity.getComponent(type);
    if (!existing) {
      entity.addComponent(type, props);
      continue;
    }
    // Simulation state (a playing sound, an animation state machine's
    // position, a script instance's fields) lives outside props. Leaving Play
    // must re-attach regardless — that state diverged even where the props
    // did not. Applying a live authored edit must NOT: see the
    // `resetStatefulComponents` note on reconcileScene.
    if (existing.constructor.resetOnStop) {
      if (resetStateful || !propsAlreadyMatch(existing, props)) {
        entity.removeComponent(type);
        entity.addComponent(type, props);
      }
      continue;
    }
    // Base values, restored as base values (see propsAlreadyMatch). Then the
    // platform layers are re-applied: a script that wrote an overridden key
    // during play changed the effective slot, which the base compare cannot
    // see, and the idempotent re-apply is what puts the layer's value back.
    for (const [key, value] of Object.entries(props ?? {})) {
      if (!sameProp(existing.getBaseProp(key), value)) existing.setBaseProp(key, value);
    }
    if (existing.variants) existing.applyPlatformLayers(existing.platformLayers);
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
  await migrateLegacySurfaceModules(engine, json);
  // Hold the complete clear -> settings -> instantiate -> authored asset wave
  // in one transaction. Previously `clear()` published an empty hierarchy,
  // then each async MeshComponent swapped its box/white placeholders while the
  // editor was already rendering. On Bistro that looked like 1,500 entities
  // spawning one by one and repeatedly woke every scene-wide listener.
  await engine.batchHierarchy(async () => {
    const wasVisible = engine.scene.visible;
    engine.scene.visible = false;
    try {
      // Do not reset renderer settings to defaults only to restore the scene's
      // settings immediately afterwards. Besides doing two expensive rebuilds,
      // that allowed components to attach to the temporary renderer between the
      // two async initializations. Renderer-owned objects (notably post-process
      // pipelines) then retained a disposed backend and rendered black on Play.
      // ── EVERY PHASE OF THE STAGE MARKS ITS OWN WALL TIME ────────────────
      //
      // `scene: deserialize` measured 1.9 s on the user's project while its
      // one marked sub-step, entity instantiation, measured 111 ms. The other
      // 1.8 s had no name, and an unnamed stage is an unfixable one. The
      // freeze SPANS below only surface when a phase happens to land inside a
      // long task, which an await-heavy phase never does — so wall time is
      // marked separately. This is the same instrument that found the prefab
      // search (2 453 ms to locate 22 files) two units ago; it is worth
      // spending a `performance.now()` per phase to never guess again.
      const tClear = performance.now();
      freeze.run("scene:clear", () => engine.clear({ resetSettings: false }));
      freeze.bootMark("scene: clear previous", performance.now() - tClear);
      engine.sceneName = json.name ?? "Untitled";
      // `fromSceneLoad`: this scene's authored renderer block arrives because
      // the user OPENED it, not because they changed a setting — so it must not
      // destroy the GPU device on the way in. See Engine.applySettings.
      const tSettings = performance.now();
      await freeze.runAsync("scene:applySettings", () =>
        engine.applySettings(json.settings ?? structuredClone(SCENE_SETTINGS_DEFAULTS), { fromSceneLoad: true }));
      freeze.bootMark("scene: apply settings", performance.now() - tSettings);
      // Prefabs must be in the registry before any instance node is expanded.
      const tEmbedded = performance.now();
      let embedded = 0;
      for (const def of json.prefabs ?? []) {
        if (def?.guid) { prefabRegistry.register(def, def.path ?? null); embedded++; }
      }
      if (embedded) freeze.bootMark("scene: embedded prefabs", performance.now() - tEmbedded, `${embedded} defs`);

      // ── TIME-SLICED INSTANTIATION (zero-freeze plan unit 4.3) ──────────
      // This loop used to run to completion with no yield: on a 3 000-entity
      // scene that is one multi-second main-thread block with the whole
      // editor dead inside it. Slicing it hands the thread back every ~8 ms,
      // so panels, menus and the console stay alive while the scene builds.
      // The whole loop is still inside `batchHierarchy` with
      // `scene.visible = false`, so nothing observes a half-built tree — a
      // slice boundary is only a chance for the HOST to run, not for the
      // engine to publish.
      //
      // ⚠ Never make this a per-item yield. See scheduling.js's header: the
      // budget is what keeps the yield count bounded by time rather than by
      // entity count.
      const entities = json.entities ?? [];
      const instantiateStart = performance.now();
      const yields = await sliceLoop(entities, (entityData) => {
        instantiateEntity(engine, entityData, null);
      });
      freeze.note("scene:instantiate", instantiateStart);
      if (entities.length) {
        // `bootMark`, not `bootStage`: this is a sub-stage inside the open
        // "scene: deserialize" stage and must not close it.
        freeze.bootMark(
          "scene: instantiate entities",
          performance.now() - instantiateStart,
          `${entities.length} roots, ${yields} yields`,
        );
      }

      // Packed bytes make these resolve without further native IPC, but the
      // BufferGeometry/material adoption still happens asynchronously. Keep
      // the stage atomic until all authored mesh/model assets are in place.
      const pending = [];
      for (const entity of engine.entities.values()) {
        for (const component of entity.components.values()) {
          if ((component.type === "mesh" || component.type === "model") && typeof component.whenReady === "function") {
            pending.push(component.whenReady());
          }
        }
      }
      // The awaits themselves are cheap; what lands on the main thread inside
      // them is the geometry/material adoption each component does when its
      // bytes arrive, which is why both are spanned rather than assumed idle.
      const tMeshes = performance.now();
      await freeze.runAsync("scene:awaitMeshAssets", () => Promise.allSettled(pending));
      freeze.bootMark("scene: await mesh assets", performance.now() - tMeshes, `${pending.length} components`);
      const tTextures = performance.now();
      await freeze.runAsync("scene:awaitTextures", () => waitForTextureAssets());
      freeze.bootMark("scene: await textures", performance.now() - tTextures);
      const tPublish = performance.now();
      engine.emit("hierarchy-changed");
      freeze.bootMark("scene: publish hierarchy", performance.now() - tPublish);
    } finally {
      engine.scene.visible = wasVisible;
    }
  });
  // Editor scene open: compile what the scene will draw in the background.
  // Never awaited — opening a scene must not wait on the driver.
  void engine.prewarmShaders?.({ reason: "scene open" });
}
