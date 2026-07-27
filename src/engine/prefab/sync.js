import { prefabRegistry } from "./registry.js";
import { resolvePrefab } from "./resolve.js";
import { diffInstance, applyInstanceToDef } from "./diff.js";
import { instantiatePrefabNode, getPrefabRoot, liveTree } from "./expand.js";
import { isInstanceNode, isVariant, makeDef, makeVariantDef, newFid, clone } from "./format.js";

/**
 * Keeping live instances and prefab assets in step.
 *
 * Every mutation of an instance (apply, revert, a prefab asset changing on
 * disk) is expressed as one primitive: rebuild the instance's entity subtree
 * from its prefab plus an override list. Rebuilding is safe because entity ids
 * are carried over — selection, script references and the undo stack all
 * address entities by id, so from their point of view nothing moved.
 */

/** The scene-file node for a live instance root: link + placement + overrides. */
export function instanceNodeOf(entity, overrides = null) {
  return {
    id: entity.id,
    prefab: { ...entity.prefab },
    ...entity.getTransform(),
    overrides: overrides ?? diffInstance(entity),
  };
}

/** fidPath -> entity id, so a rebuild can hand every entity back its old id. */
function idMapOf(entity) {
  const map = new Map();
  entity.traverse((e) => {
    if (e.fidPath) map.set(e.fidPath.join("/"), e.id);
  });
  return map;
}

function siblingsOf(engine, entity) {
  return entity.parent ? entity.parent.children : engine.rootEntities;
}

/**
 * Rebuilds an instance's subtree from its prefab with the given overrides.
 * Preserves the root's id, parent, sibling position and placement, and reuses
 * the ids of every descendant that still exists in the new tree.
 */
export function respawnInstance(engine, entity, overrides) {
  const parent = entity.parent;
  const siblings = siblingsOf(engine, entity);
  const index = siblings.indexOf(entity);
  const node = instanceNodeOf(entity, overrides);
  const ids = idMapOf(entity);

  engine.destroyEntity(entity);
  const next = instantiatePrefabNode(engine, node, parent, {
    idFor: (fidPath) => ids.get((fidPath ?? []).join("/")),
  });

  const nextSiblings = siblingsOf(engine, next);
  const at = nextSiblings.indexOf(next);
  if (at !== -1 && index !== -1 && at !== index) {
    nextSiblings.splice(at, 1);
    nextSiblings.splice(index, 0, next);
  }
  engine.emit("hierarchy-changed");
  return next;
}

/** Every guid a prefab depends on (nested instances + variant bases). */
export function dependenciesOf(guid, out = new Set()) {
  const def = prefabRegistry.getDef(guid);
  if (!def || out.has(guid)) return out;
  out.add(guid);
  if (isVariant(def)) {
    const base = prefabRegistry.resolveLink(def.variantOf);
    if (base) dependenciesOf(base, out);
  }
  const walk = (node) => {
    if (!node) return;
    if (isInstanceNode(node)) {
      const nested = prefabRegistry.resolveLink(node.prefab);
      if (nested) dependenciesOf(nested, out);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(def.root);
  // A variant's overrides can introduce whole subtrees (addEntity), which may
  // themselves reference prefabs.
  for (const ov of def.overrides ?? []) {
    if (ov.k === "addEntity") walk(ov.v);
  }
  return out;
}

/** Live instance roots affected by a change to `guid` (directly or via nesting). */
export function instancesAffectedBy(engine, guid) {
  const out = [];
  for (const entity of engine.entities.values()) {
    if (!entity.prefab) continue;
    const own = prefabRegistry.resolveLink(entity.prefab);
    if (!own) {
      // An orphan whose prefab just came back: match on the recorded path/guid.
      if (entity.prefab.guid === guid) out.push(entity);
      continue;
    }
    if (own === guid || dependenciesOf(own).has(guid)) out.push(entity);
  }
  return out;
}

/**
 * Registers a new/updated def and re-expands every live instance that depends
 * on it. Overrides are captured *before* the swap (they're relative to the old
 * def) and re-applied after, which is what makes "edit the prefab, every
 * instance updates but keeps its own tweaks" work.
 */
export function reloadPrefab(engine, def, path = null, { overridesById = null } = {}) {
  const affected = instancesAffectedBy(engine, def.guid);
  const captured = affected.map((entity) => ({
    entity,
    // Undo needs to *force* the overrides an instance had before the change:
    // re-deriving them would read the post-change state and silently bake the
    // very edit we're undoing into the instance.
    overrides: overridesById?.get(entity.id) ?? diffInstance(entity),
  }));

  prefabRegistry.register(def, path);

  for (const { entity, overrides } of captured) {
    // The entity may have been destroyed by an earlier respawn (a nested
    // instance under another affected root) — skip if it's gone.
    if (!engine.getEntity(entity.id)) continue;
    respawnInstance(engine, entity, overrides);
  }
  engine.emit("prefabs-changed", def.guid);
  return def;
}

// ---- Authoring ------------------------------------------------------------

/** Live entity -> prefab node. Descendant instances stay *references* (nested
 *  prefabs), so editing the inner prefab still propagates into this one.
 *
 *  The fid is written back onto the entity: the entity we snapshot is about to
 *  *become* an instance of the prefab we're building, and it can only keep its
 *  identity (and its children theirs) if both sides agree on the fids. */
function nodeFromEntity(entity, isRoot = false) {
  if (entity.prefab && !isRoot) {
    return {
      fid: (entity.fid ??= newFid()),
      prefab: { ...entity.prefab },
      ...entity.getTransform(),
      overrides: diffInstance(entity),
    };
  }
  const node = {
    fid: (entity.fid ??= newFid()),
    name: entity.name,
    ...entity.getTransform(),
    viewOnly: !!entity.viewOnly,
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
    tags: [...(entity.tags ?? [])],
    components: [...entity.components.values()].map((c) => {
      const { type, props } = c.toJSON();
      return { type, props: clone(props) ?? {} };
    }),
    children: entity.children.map((child) => nodeFromEntity(child)),
  };
  return node;
}

/** Builds a prefab def from a live entity tree (Create Prefab). */
export function createDefFromEntity(entity, { name, guid } = {}) {
  return makeDef(nodeFromEntity(entity, true), { name: name ?? entity.name, guid });
}

/**
 * Turns the entity a prefab was just authored from into an instance of it —
 * the second half of Create Prefab, and what makes the source object stay in
 * sync with the asset from then on.
 *
 * Relies on `createDefFromEntity` having stamped fids onto the live entities:
 * that's what lets every entity keep its id (and so its inbound references)
 * as the subtree is rebuilt from the prefab.
 */
export function bindEntityToPrefab(engine, entity, def, path = null) {
  prefabRegistry.register(def, path);

  // Pair the resolved prefab tree with the live tree in lockstep: the def was
  // built from this very entity, so child *i* of a node is child *i* of the
  // entity. Deriving the fids structurally (rather than reading `entity.fid`)
  // also makes this correct on redo, where undo has replaced the entities with
  // fresh, untagged ones.
  const tree = resolvePrefab(def.guid);
  const ids = new Map();
  const pair = (node, e) => {
    if (!node || !e) return;
    e.fid = node.fid;
    ids.set((node.fidPath ?? []).join("/"), e.id);
    (node.children ?? []).forEach((child, i) => pair(child, e.children[i]));
  };
  pair(tree, entity);

  const parent = entity.parent;
  const siblings = siblingsOf(engine, entity);
  const index = siblings.indexOf(entity);
  const node = { id: entity.id, prefab: { guid: def.guid, path }, ...entity.getTransform(), overrides: [] };

  engine.destroyEntity(entity);
  const next = instantiatePrefabNode(engine, node, parent, { idFor: (fidPath) => ids.get((fidPath ?? []).join("/")) });

  const nextSiblings = siblingsOf(engine, next);
  const at = nextSiblings.indexOf(next);
  if (at !== -1 && index !== -1 && at !== index) {
    nextSiblings.splice(at, 1);
    nextSiblings.splice(index, 0, next);
  }
  engine.emit("hierarchy-changed");
  return next;
}

/** Builds a *variant* def from a live instance (Create Variant): the instance's
 *  current overrides become the variant's own. */
export function createVariantDefFromInstance(entity, { name, guid } = {}) {
  const baseGuid = prefabRegistry.resolveLink(entity.prefab);
  if (!baseGuid) throw new Error("Entity is not a prefab instance");
  const base = prefabRegistry.getDef(baseGuid);
  const def = makeVariantDef(
    { guid: baseGuid, name: base?.name, path: prefabRegistry.pathOf(baseGuid) },
    { name: name ?? `${entity.name} Variant`, guid },
  );
  def.overrides = diffInstance(entity);
  return def;
}

/** Def matching a live instance (Apply). The caller persists it and calls
 *  `reloadPrefab` — which then clears the overrides off every instance. */
export function defWithInstanceApplied(entity, only = null) {
  const guid = prefabRegistry.resolveLink(entity.prefab);
  const def = prefabRegistry.getDef(guid);
  if (!def) throw new Error("Prefab asset not found");
  return applyInstanceToDef(entity, structuredClone(def), only);
}

/** Def for a prefab being saved out of Prefab Mode: the staged root entity *is*
 *  the prefab, so we rebuild the def's tree from it, keeping fids stable. */
export function defFromStageRoot(entity, def) {
  // A variant owns no tree of its own — its edits fold into its override list
  // (which is exactly what Apply does), so reuse that path.
  if (isVariant(def)) return applyInstanceToDef(entity, structuredClone(def));

  const next = structuredClone(def);
  next.root = nodeFromEntity(entity, true);
  next.name = entity.name;
  return next;
}

export { getPrefabRoot, liveTree, resolvePrefab, diffInstance };
