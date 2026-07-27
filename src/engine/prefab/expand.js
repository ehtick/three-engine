import { prefabRegistry } from "./registry.js";
import { resolveInstance } from "./resolve.js";
import { newFid, FLAG_KEYS } from "./format.js";

/**
 * Instance ⇄ entity plumbing.
 *
 * An expanded instance is an ordinary entity subtree — components tick, scripts
 * run, gizmos work, nothing in the engine treats it specially. The only extra
 * state is bookkeeping so we can find our way back to the asset:
 *
 *   entity.prefab   — `{ guid, path }`, set on the *instance root* only.
 *                     Its presence is what makes an entity an instance root.
 *   entity.fid      — this entity's id inside the prefab it came from. Entities
 *                     the user adds inside an instance get a fresh fid so their
 *                     `addEntity` override keeps a stable identity across
 *                     re-expansion.
 *   entity.fidPath  — address from the instance root; [] for the root itself.
 *   entity.prefabSourceGuid — set on the root of a *nested* instance, for the
 *                     inspector's "nested prefab" badge.
 *
 * Entities inside an instance are otherwise untagged, which is deliberate: any
 * code that walks the scene keeps working, and an entity that loses its tags
 * (unpack) is just a normal entity again.
 */

/** The instance root governing this entity, or null when it isn't in a prefab. */
export function getPrefabRoot(entity) {
  for (let e = entity; e; e = e.parent) {
    if (e.prefab) return e;
  }
  return null;
}

export const isPrefabRoot = (entity) => !!entity?.prefab;

/** True when the entity lives inside an instance but isn't its root. */
export function isInsidePrefab(entity) {
  const root = getPrefabRoot(entity);
  return !!root && root !== entity;
}

/** Assigns tags to a freshly created entity inside an instance. */
function tag(entity, node) {
  entity.fid = node.fid;
  entity.fidPath = node.fidPath ?? [];
  if (node.instanceOf) entity.prefabSourceGuid = node.instanceOf;
}

/** Clears every prefab tag from a subtree (Unpack, and Create Prefab's source). */
export function clearPrefabTags(entity, { deep = true } = {}) {
  entity.prefab = null;
  entity.fid = null;
  entity.fidPath = null;
  entity.prefabSourceGuid = null;
  entity.prefabMissing = false;
  entity.prefabOrphanOverrides = null;
  if (deep) for (const child of entity.children) clearPrefabTags(child);
}

/**
 * Builds entities from a resolved tree.
 *
 * `idFor(fidPath)` lets a re-expansion (a prefab asset changed under a live
 * scene) hand back the ids the previous entities had, so selection, script
 * references and undo history survive the swap.
 */
function buildEntities(engine, node, parent, idFor) {
  const entity = engine.createEntity({ id: idFor?.(node.fidPath), name: node.name, parent });
  entity.setTransform(node);
  if (node.viewOnly) entity.setViewOnly(true);
  if (node.enabledInEditor === false) entity.setEnabledInEditor(false);
  if (node.enabledInGame === false) entity.setEnabledInGame(false);
  if (node.tags?.length) entity.setTags(node.tags);
  tag(entity, node);
  for (const { type, props } of node.components ?? []) {
    try {
      entity.addComponent(type, structuredClone(props ?? {}));
    } catch (err) {
      console.warn(`Prefab: couldn't add "${type}" to ${node.name}: ${err.message}`);
    }
  }
  for (const child of node.children ?? []) buildEntities(engine, child, entity, idFor);
  return entity;
}

/**
 * Instantiates a prefab instance node (the scene-file shape:
 * `{ id?, prefab: {guid, path}, position…, overrides }`) under `parent`.
 *
 * A missing prefab yields a placeholder entity that *keeps the link and the
 * overrides* — so a scene saved while an asset was temporarily unavailable
 * doesn't silently discard the instance's data.
 */
export function instantiatePrefabNode(engine, node, parent = null, { idFor } = {}) {
  const guid = prefabRegistry.resolveLink(node.prefab);
  const tree = guid ? resolveInstance(node.prefab, node.overrides ?? []) : null;

  if (!tree) {
    const name = node.name ?? `Missing Prefab (${node.prefab?.path?.split(/[\\/]/).pop() ?? node.prefab?.guid ?? "?"})`;
    console.warn(`Prefab not found: ${node.prefab?.path ?? node.prefab?.guid} — kept as a placeholder`);
    const placeholder = engine.createEntity({ id: node.id, name, parent });
    placeholder.setTransform(node);
    placeholder.prefab = { ...node.prefab };
    placeholder.prefabMissing = true;
    // Park the overrides so a re-link (or simply re-saving once the asset is
    // back) restores the instance exactly as it was.
    placeholder.prefabOrphanOverrides = structuredClone(node.overrides ?? []);
    placeholder.fidPath = [];
    return placeholder;
  }

  // The instance's own placement lives on the node, not in the tree.
  for (const key of ["position", "rotation", "scale"]) {
    if (node[key]) tree[key] = structuredClone(node[key]);
  }

  // The instance root keeps the id the scene gave it; descendants reuse theirs
  // via `idFor` (a re-expansion) or get fresh ones (a first spawn).
  const resolveId = (fidPath) => (fidPath?.length ? idFor?.(fidPath) : (node.id ?? idFor?.([])));
  const root = buildEntities(engine, tree, parent, resolveId);
  root.prefab = { guid, path: prefabRegistry.pathOf(guid) ?? node.prefab?.path ?? null };
  root.fidPath = [];
  root.prefabSourceGuid = null; // the outermost root is an instance, not a *nested* one
  return root;
}

/**
 * Reads a live entity subtree back into node form for diffing. Mirrors the
 * resolved-tree shape so `diffInstance` can compare like with like.
 *
 * Entities with no fid (added by the user inside an instance) get one assigned
 * *on the entity* here, so the identity we mint survives into the override and
 * back out on the next expansion.
 */
export function liveTree(entity, parentPath = null) {
  const fid = entity.fid ?? (entity.fid = newFid());
  // `null` parent path means "this is the instance root" — it addresses as [].
  const fidPath = parentPath === null ? [] : [...parentPath, fid];
  const node = {
    fid,
    fidPath,
    name: entity.name,
    ...entity.getTransform(),
    viewOnly: !!entity.viewOnly,
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
    tags: [...(entity.tags ?? [])],
    instanceOf: entity.prefabSourceGuid,
    components: [...entity.components.values()].map((c) => {
      const { type, props } = c.toJSON();
      return { type, props };
    }),
    children: [],
  };
  node.children = entity.children.map((child) => liveTree(child, node.fidPath));
  // Keep the entity's own path in sync — reparenting inside an instance moves it.
  entity.fidPath = node.fidPath;
  return node;
}

/** Detaches an instance from its prefab: the entities stay, the link goes.
 *  `deep: false` unpacks only the outer instance, leaving nested instances
 *  linked (Unity's "Unpack Prefab" vs "Unpack Completely"). */
export function unpackInstance(entity, { deep = true } = {}) {
  if (!entity.prefab) return;
  if (deep) {
    clearPrefabTags(entity);
    return;
  }
  // Shallow: nested instance roots survive as instance roots of their own.
  const promote = (e, isRoot) => {
    const nestedGuid = e.prefabSourceGuid;
    e.prefab = null;
    e.fid = null;
    e.fidPath = null;
    e.prefabSourceGuid = null;
    if (!isRoot && nestedGuid) {
      // This nested instance becomes a standalone instance of its own prefab.
      e.prefab = { guid: nestedGuid, path: prefabRegistry.pathOf(nestedGuid) };
      e.fidPath = [];
      // Re-fid its subtree relative to itself so its overrides address correctly.
      const rebase = (node, prefix) => {
        node.fidPath = prefix;
        for (const child of node.children) rebase(child, [...prefix, (child.fid ??= newFid())]);
      };
      rebase(e, []);
      return; // don't descend: it owns its subtree now
    }
    for (const child of e.children) promote(child, false);
  };
  promote(entity, true);
}

export { FLAG_KEYS };
