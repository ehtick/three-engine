import { prefabRegistry } from "./registry.js";
import { resolvePrefab, findByPath } from "./resolve.js";
import { liveTree } from "./expand.js";
import { getComponentClass } from "../components/registry.js";
import { deepEqual, clone, isInstanceNode, isVariant, nodeFromSnapshot, TRANSFORM_KEYS, FLAG_KEYS } from "./format.js";

/**
 * Brings a def's saved component props up to the shape the live component
 * uses, so a props-format migration doesn't read as an override.
 *
 * A live component normalizes its props in its constructor; a prefab def is
 * raw JSON that never passes through one. Without this, every instance of
 * every prefab saved before the migration would diff dirty on the old keys
 * *and* the new ones — see `ScriptComponent.normalizeProps`, which moved a
 * single `{ path, attributes }` script into a `{ scripts: [...] }` list.
 *
 * Components without a migration (nearly all of them) return their props
 * untouched, so this costs a lookup per component per diff.
 */
const normalizeProps = (type, props) =>
  getComponentClass(type)?.normalizeProps?.(props) ?? props;

/**
 * Overrides are *derived*, never recorded.
 *
 * Instead of intercepting every edit (move gizmo, add component, delete child,
 * script prop change, terrain sculpt…) to log a modification, we compare the
 * live instance against what the prefab says it should be, and the difference
 * *is* the override list. Every existing command in the editor therefore
 * produces correct overrides for free, undo/redo included — there is no
 * second source of truth to keep in sync.
 *
 * The instance root's transform is excluded on purpose: placement is inherently
 * per-instance (it's hoisted onto the instance node in the scene file and is
 * never applied back to the asset), which matches Unity.
 */

/** Diffs one node pair. `path` is the fid path of `expected` from the root. */
function diffNode(expected, live, path, out, { isRoot }) {
  if (live.name !== expected.name) {
    out.push({ t: path, k: "name", v: live.name });
  }

  if (!isRoot) {
    for (const key of TRANSFORM_KEYS) {
      if (!deepEqual(live[key], expected[key])) out.push({ t: path, k: "transform", key, v: clone(live[key]) });
    }
  }

  for (const key of FLAG_KEYS) {
    const a = key === "viewOnly" ? !!expected[key] : expected[key] !== false;
    const b = key === "viewOnly" ? !!live[key] : live[key] !== false;
    if (a !== b) out.push({ t: path, k: "flag", key, v: b });
  }

  // Tags are a whole-list value, not per-item: "this instance is tagged
  // [boss, elite]" is one override the user can apply or revert as a unit.
  if (!deepEqual(live.tags ?? [], expected.tags ?? [])) {
    out.push({ t: path, k: "tags", v: clone(live.tags ?? []) });
  }

  // --- components ---------------------------------------------------------
  const expectedByType = new Map((expected.components ?? []).map((c) => [c.type, c]));
  const liveByType = new Map((live.components ?? []).map((c) => [c.type, c]));

  for (const [type, liveComponent] of liveByType) {
    const expectedComponent = expectedByType.get(type);
    if (!expectedComponent) {
      out.push({ t: path, k: "addComponent", c: type, v: clone(liveComponent.props) });
      continue;
    }
    const liveProps = normalizeProps(type, liveComponent.props ?? {});
    const expectedProps = normalizeProps(type, expectedComponent.props ?? {});
    const keys = new Set([...Object.keys(expectedProps), ...Object.keys(liveProps)]);
    for (const key of keys) {
      if (!deepEqual(liveProps[key], expectedProps[key])) {
        out.push({ t: path, k: "prop", c: type, key, v: clone(liveProps[key]) });
      }
    }
  }
  for (const type of expectedByType.keys()) {
    if (!liveByType.has(type)) out.push({ t: path, k: "removeComponent", c: type });
  }

  // --- children -----------------------------------------------------------
  // Matched by fid. A live child whose fid the prefab doesn't know was added by
  // the user; an expected fid with no live child was deleted from the instance.
  const liveByFid = new Map((live.children ?? []).map((c) => [c.fid, c]));
  const expectedFids = new Set((expected.children ?? []).map((c) => c.fid));

  for (const expectedChild of expected.children ?? []) {
    const liveChild = liveByFid.get(expectedChild.fid);
    if (!liveChild) {
      out.push({ t: expectedChild.fidPath, k: "removeEntity" });
      continue;
    }
    diffNode(expectedChild, liveChild, expectedChild.fidPath, out, { isRoot: false });
  }

  for (const liveChild of live.children ?? []) {
    if (expectedFids.has(liveChild.fid)) continue;
    // Added inside the instance: store the whole subtree, keeping its fids so
    // the entity keeps its identity (and its own overrides) across re-expansion.
    out.push({ t: path, k: "addEntity", v: nodeFromSnapshot(liveChild, (s) => s.fid) });
  }
}

/**
 * The override list for a live prefab instance root — i.e. every way it differs
 * from its prefab asset. Returns `[]` for a pristine instance.
 */
export function diffInstance(entity) {
  if (!entity?.prefab) return [];
  // An orphaned instance (asset missing) has no baseline to diff against; hand
  // back the overrides it was loaded with so they survive a save.
  if (entity.prefabMissing) return clone(entity.prefabOrphanOverrides) ?? [];
  const guid = prefabRegistry.resolveLink(entity.prefab);
  const expected = guid ? resolvePrefab(guid) : null;
  if (!expected) return clone(entity.prefabOrphanOverrides) ?? [];

  const out = [];
  diffNode(expected, liveTree(entity), [], out, { isRoot: true });
  return out;
}

/** Convenience: does this instance differ from its prefab at all? */
export const hasOverrides = (entity) => diffInstance(entity).length > 0;

/**
 * Groups an override list by the entity it targets, for the inspector's
 * "Overrides" dropdown. Returns `[{ path, key, overrides }]`.
 */
export function groupOverrides(overrides) {
  const groups = new Map();
  for (const ov of overrides) {
    const key = (ov.t ?? []).join("/");
    if (!groups.has(key)) groups.set(key, { path: ov.t ?? [], key, overrides: [] });
    groups.get(key).overrides.push(ov);
  }
  return [...groups.values()];
}

/**
 * Writes overrides *into a def* — the Apply operation.
 *
 * The subtlety is nesting. An override addressing a node inside a nested prefab
 * instance must not be inlined into the outer prefab's tree (that would fork
 * the nested prefab's data); it belongs on the nested instance node's own
 * override list, re-based to be relative to that nested prefab's root. So we
 * walk the def's *unresolved* tree and, the moment the path crosses an instance
 * node, hand the remainder of the path to that node.
 *
 * Variants have no tree of their own, so everything lands in `def.overrides`.
 */
export function absorbOverrides(def, overrides) {
  if (isVariant(def)) {
    def.overrides = mergeOverrides(def.overrides ?? [], overrides);
    return def;
  }
  for (const ov of overrides) absorbOne(def.root, ov);
  return def;
}

/** Replaces same-target overrides and appends the rest (last write wins). */
function mergeOverrides(existing, incoming) {
  const idOf = (o) => [(o.t ?? []).join("/"), o.k, o.c ?? "", o.key ?? ""].join("|");
  const merged = new Map(existing.map((o) => [idOf(o), o]));
  for (const ov of incoming) merged.set(idOf(ov), ov);
  return [...merged.values()];
}

/**
 * Walks a def's *unresolved* tree along an fid path and reports where it lands:
 *
 *   { kind: "def",      parent, node }        — a literal node of this def
 *   { kind: "instance", parent, node, rest }  — the path crossed into a nested
 *                                               prefab instance; `rest` is the
 *                                               remaining path, relative to that
 *                                               prefab's own root.
 */
function locate(root, path) {
  if (isInstanceNode(root)) return { kind: "instance", parent: null, node: root, rest: path };
  let node = root;
  for (let i = 0; i < path.length; i++) {
    const child = (node.children ?? []).find((c) => c.fid === path[i]);
    if (!child) return null;
    if (isInstanceNode(child)) {
      return { kind: "instance", parent: node, node: child, rest: path.slice(i + 1) };
    }
    if (i === path.length - 1) return { kind: "def", parent: node, node: child };
    node = child;
  }
  return { kind: "def", parent: null, node: root };
}

function absorbOne(root, ov) {
  const hit = locate(root, ov.t ?? []);
  if (!hit) return; // stale path — the def moved on

  if (hit.kind === "instance") {
    // Removing the nested instance outright is a change to *this* def's tree.
    if (ov.k === "removeEntity" && !hit.rest.length && hit.parent) {
      hit.parent.children = hit.parent.children.filter((c) => c.fid !== hit.node.fid);
      return;
    }
    // Placement of a nested instance is hoisted onto its node (keeps the file
    // readable and matches how the resolver reads it back).
    if (ov.k === "transform" && !hit.rest.length) {
      hit.node[ov.key] = clone(ov.v);
      return;
    }
    // Anything else inside the nested prefab stays an override *on the nested
    // instance node* — inlining it here would fork the nested prefab's data.
    hit.node.overrides = mergeOverrides(hit.node.overrides ?? [], [{ ...ov, t: hit.rest }]);
    return;
  }

  if (ov.k === "removeEntity") {
    if (hit.parent) hit.parent.children = hit.parent.children.filter((c) => c.fid !== hit.node.fid);
    return;
  }
  applyToDefNode(hit.node, ov);
}

function applyToDefNode(node, ov) {
  switch (ov.k) {
    case "name":
      node.name = ov.v;
      break;
    case "transform":
      node[ov.key] = clone(ov.v);
      break;
    case "flag":
      node[ov.key] = ov.v;
      break;
    case "tags":
      node.tags = clone(ov.v) ?? [];
      break;
    case "prop": {
      const component = (node.components ??= []).find((c) => c.type === ov.c);
      if (component) (component.props ??= {})[ov.key] = clone(ov.v);
      else node.components.push({ type: ov.c, props: { [ov.key]: clone(ov.v) } });
      break;
    }
    case "addComponent": {
      node.components ??= [];
      const existing = node.components.find((c) => c.type === ov.c);
      if (existing) existing.props = clone(ov.v);
      else node.components.push({ type: ov.c, props: clone(ov.v) ?? {} });
      break;
    }
    case "removeComponent":
      node.components = (node.components ?? []).filter((c) => c.type !== ov.c);
      break;
    case "addEntity":
      (node.children ??= []).push(clone(ov.v));
      break;
    default:
      break;
  }
}

/**
 * Applies a live instance back onto its prefab def: the def is mutated so it
 * matches the instance (minus the instance's own placement, which is
 * per-instance by design). Returns the def, ready to be written to disk.
 *
 * `only` restricts the apply to a subset of the instance's overrides — that's
 * the inspector's per-property "Apply to Prefab".
 */
export function applyInstanceToDef(entity, def, only = null) {
  const overrides = only ?? diffInstance(entity);
  absorbOverrides(def, overrides);
  return def;
}
