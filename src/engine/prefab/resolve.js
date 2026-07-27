import { prefabRegistry } from "./registry.js";
import { isInstanceNode, isVariant, clone, newFid, TRANSFORM_KEYS, FLAG_KEYS } from "./format.js";

/**
 * Resolution turns a prefab def into a *resolved tree*: plain nodes only, with
 * every nested instance expanded in place and every variant's overrides
 * applied. Everything downstream (expansion into entities, diffing an instance,
 * the inspector) works on this one flat shape and never has to think about
 * nesting again.
 *
 * Each resolved node carries:
 *   fid       — its file-local id within its *owning* prefab
 *   fidPath   — the full path from the resolved root (["c2","c5"] crosses into
 *               nested instance c2). This is the address overrides use.
 *   instanceOf — set on the root of an expanded nested instance (its guid), so
 *               the editor can show a nested-prefab badge and Apply knows where
 *               the boundary is.
 */

/** Walks a resolved tree to the node at `path` (an fid array; [] = root). */
export function findByPath(tree, path = []) {
  let node = tree;
  for (const fid of path) {
    node = (node?.children ?? []).find((c) => c.fid === fid);
    if (!node) return null;
  }
  return node;
}

/** Parent of the node at `path`, plus the child index. */
function findParent(tree, path) {
  if (!path.length) return null;
  const parent = findByPath(tree, path.slice(0, -1));
  if (!parent) return null;
  const index = (parent.children ?? []).findIndex((c) => c.fid === path.at(-1));
  return index === -1 ? null : { parent, index };
}

const samePath = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Structural overrides must land before value overrides: a prop override on a
 *  component that an `addComponent` introduces would otherwise find nothing. */
const STRUCTURAL = new Set(["addEntity", "removeEntity", "addComponent", "removeComponent"]);

/**
 * Applies an override list to a resolved tree, in place.
 *
 * Overrides whose target no longer exists (the prefab moved on and dropped that
 * node) are skipped silently — they're stale, and because overrides are always
 * re-derived by diffing, they simply stop being emitted next time.
 */
export function applyOverrides(tree, overrides = [], seen) {
  const ordered = [
    ...overrides.filter((o) => STRUCTURAL.has(o.k)),
    ...overrides.filter((o) => !STRUCTURAL.has(o.k)),
  ];
  for (const ov of ordered) {
    const path = ov.t ?? [];
    switch (ov.k) {
      case "addEntity": {
        const parent = findByPath(tree, path);
        if (!parent) break;
        const child = resolveNode(ov.v, seen);
        if (child) (parent.children ??= []).push(child);
        break;
      }
      case "removeEntity": {
        const hit = findParent(tree, path);
        if (hit) hit.parent.children.splice(hit.index, 1);
        break;
      }
      case "addComponent": {
        const node = findByPath(tree, path);
        if (!node) break;
        node.components ??= [];
        const existing = node.components.find((c) => c.type === ov.c);
        if (existing) existing.props = clone(ov.v) ?? {};
        else node.components.push({ type: ov.c, props: clone(ov.v) ?? {} });
        break;
      }
      case "removeComponent": {
        const node = findByPath(tree, path);
        if (!node?.components) break;
        node.components = node.components.filter((c) => c.type !== ov.c);
        break;
      }
      case "prop": {
        const node = findByPath(tree, path);
        const component = node?.components?.find((c) => c.type === ov.c);
        if (component) (component.props ??= {})[ov.key] = clone(ov.v);
        break;
      }
      case "transform": {
        const node = findByPath(tree, path);
        if (node && TRANSFORM_KEYS.includes(ov.key)) node[ov.key] = clone(ov.v);
        break;
      }
      case "flag": {
        const node = findByPath(tree, path);
        if (node && FLAG_KEYS.includes(ov.key)) node[ov.key] = ov.v;
        break;
      }
      case "tags": {
        const node = findByPath(tree, path);
        if (node) node.tags = clone(ov.v) ?? [];
        break;
      }
      case "name": {
        const node = findByPath(tree, path);
        if (node) node.name = ov.v;
        break;
      }
      default:
        break;
    }
  }
  return tree;
}

/**
 * Resolves one node of a prefab's tree. Plain nodes are copied; instance nodes
 * are replaced by the resolved tree of the prefab they point at, with their
 * hoisted transform and their override list applied on top.
 *
 * `seen` guards against a prefab containing itself (directly or through a
 * chain) — that would otherwise recurse forever. The offending node resolves
 * to null and is dropped.
 */
function resolveNode(node, seen) {
  if (!node) return null;

  if (isInstanceNode(node)) {
    const guid = prefabRegistry.resolveLink(node.prefab);
    if (!guid || seen.has(guid)) return null; // missing prefab, or a cycle
    const sub = resolveTree(guid, seen);
    if (!sub) return null;
    // The nested instance's own identity replaces the sub-prefab root's: from
    // the outer prefab's perspective this node *is* `node.fid`.
    sub.fid = node.fid;
    sub.instanceOf = guid;
    // Transform is hoisted onto the instance node (readable in the file, and
    // never applied back to the source prefab — placement is per-instance).
    for (const key of TRANSFORM_KEYS) {
      if (node[key]) sub[key] = clone(node[key]);
    }
    applyOverrides(sub, node.overrides ?? [], seen);
    return sub;
  }

  return {
    fid: node.fid ?? newFid(),
    name: node.name ?? "Entity",
    position: clone(node.position) ?? [0, 0, 0],
    rotation: clone(node.rotation) ?? [0, 0, 0],
    scale: clone(node.scale) ?? [1, 1, 1],
    viewOnly: node.viewOnly ?? false,
    enabledInEditor: node.enabledInEditor !== false,
    enabledInGame: node.enabledInGame !== false,
    tags: clone(node.tags) ?? [],
    components: (node.components ?? []).map((c) => ({ type: c.type, props: clone(c.props) ?? {} })),
    children: (node.children ?? []).map((c) => resolveNode(c, seen)).filter(Boolean),
  };
}

/** Fills in `fidPath` on every node, top-down. Done once, after resolution, so
 *  the nested/variant machinery never has to keep paths in sync as it splices.
 *  `prefix === null` marks the root, which addresses as `[]` — an empty path is
 *  not the same as "no path", so the two cases can't share a sentinel. */
function assignPaths(node, prefix = null) {
  node.fidPath = prefix === null ? [] : [...prefix, node.fid];
  for (const child of node.children ?? []) assignPaths(child, node.fidPath);
  return node;
}

function resolveTree(guid, seen) {
  const def = prefabRegistry.getDef(guid);
  if (!def) return null;
  if (seen.has(guid)) return null;
  seen.add(guid);
  try {
    if (isVariant(def)) {
      const baseGuid = prefabRegistry.resolveLink(def.variantOf);
      if (!baseGuid) return null;
      const base = resolveTree(baseGuid, seen);
      if (!base) return null;
      applyOverrides(base, def.overrides ?? [], seen);
      return base;
    }
    return resolveNode(def.root, seen);
  } finally {
    seen.delete(guid);
  }
}

/**
 * The resolved tree for a prefab guid — nested instances expanded, variant
 * overrides applied, fid paths assigned. Memoised per registry version; the
 * cached tree is shared, so callers must not mutate it (`resolveFor` hands out
 * a private copy for exactly that reason).
 */
export function resolvePrefab(guid) {
  const cached = prefabRegistry._resolved.get(guid);
  if (cached !== undefined) return cached;
  const tree = resolveTree(guid, new Set());
  const finalized = tree ? assignPaths(tree) : null;
  prefabRegistry._resolved.set(guid, finalized);
  return finalized;
}

/** A private, mutable copy of a prefab's resolved tree with an instance's own
 *  overrides applied — i.e. exactly what that instance should look like. */
export function resolveInstance(link, overrides = []) {
  const guid = prefabRegistry.resolveLink(link);
  if (!guid) return null;
  const base = resolvePrefab(guid);
  if (!base) return null;
  const tree = structuredClone(base);
  applyOverrides(tree, overrides, new Set([guid]));
  return assignPaths(tree);
}
