import { createId } from "../../shared/ids.js";

/**
 * Prefab file format (`.prefab`, JSON).
 *
 *   {
 *     prefab: 1,                       // format marker + version
 *     guid: "p_xxx",                   // stable identity; survives rename/move
 *     name: "Enemy",
 *     root: <Node>,                    // regular prefab
 *     // — or, for a variant —
 *     variantOf: { guid, path },
 *     overrides: [<Override>],         // applied on top of the base's tree
 *   }
 *
 * A Node is either a *plain node* (an entity: name, transform, components,
 * children) or an *instance node* (a nested prefab: `{ fid, prefab: {guid},
 * position…, overrides }`). Both carry an `fid` — a file-local id that is
 * stable across edits of the asset. Overrides address nodes by their **fid
 * path** relative to the instance root, so a path of `["c2", "c5"]` means
 * "node c5 inside the nested prefab instance c2" — this is what makes
 * overrides survive nesting.
 *
 * Scene entities reuse the *instance node* shape verbatim (with a runtime
 * `id` instead of an `fid`), so one resolver serves both scenes and prefabs.
 */

export const PREFAB_FORMAT_VERSION = 1;

/** Extension for prefab assets. `.entity` remains readable (see `upgradeLegacyEntity`). */
export const PREFAB_EXT = "prefab";
export const LEGACY_PREFAB_EXT = "entity";

export const newGuid = () => `p_${createId()}`;
export const newFid = () => `f_${createId()}`;

/** True when a node is a prefab reference rather than a literal entity. */
export function isInstanceNode(node) {
  return !!node?.prefab?.guid;
}

/** True when a parsed JSON blob looks like a prefab def (vs. a legacy snapshot). */
export function isPrefabDef(json) {
  return !!json && typeof json === "object" && typeof json.guid === "string" && "prefab" in json;
}

export const isVariant = (def) => !!def?.variantOf?.guid;

/** Paths are compared case-insensitively with normalised separators — the
 *  editor hands us Windows paths, the player relative POSIX ones. */
export function normalizePath(path) {
  return String(path ?? "").replaceAll("\\", "/").toLowerCase();
}

const TRANSFORM_KEYS = ["position", "rotation", "scale"];
export const FLAG_KEYS = ["viewOnly", "enabledInEditor", "enabledInGame"];
export { TRANSFORM_KEYS };

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  // Typed arrays (terrain heightmaps, splatmaps) compare element-wise.
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

export const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * Converts a `serializeEntity` snapshot (runtime ids) into a prefab node tree
 * (file-local fids). Used when authoring a prefab from a live entity and when
 * upgrading a legacy `.entity` snapshot.
 *
 * `fidOf(snapshot)` lets the caller preserve existing fids (Apply reuses the
 * fids the instance was expanded with, so overrides on *other* instances keep
 * pointing at the right nodes). Returns a fresh fid when it yields nothing.
 */
export function nodeFromSnapshot(snapshot, fidOf = () => null) {
  // A nested instance: keep it as a reference, don't inline its contents.
  if (isInstanceNode(snapshot)) {
    return {
      fid: fidOf(snapshot) ?? newFid(),
      prefab: { ...snapshot.prefab },
      position: clone(snapshot.position),
      rotation: clone(snapshot.rotation),
      scale: clone(snapshot.scale),
      overrides: clone(snapshot.overrides) ?? [],
    };
  }
  const node = {
    fid: fidOf(snapshot) ?? newFid(),
    name: snapshot.name ?? "Entity",
    position: clone(snapshot.position) ?? [0, 0, 0],
    rotation: clone(snapshot.rotation) ?? [0, 0, 0],
    scale: clone(snapshot.scale) ?? [1, 1, 1],
    components: (snapshot.components ?? []).map((c) => ({ type: c.type, props: clone(c.props) ?? {} })),
    children: (snapshot.children ?? []).map((c) => nodeFromSnapshot(c, fidOf)),
  };
  for (const key of FLAG_KEYS) {
    if (snapshot[key] !== undefined) node[key] = snapshot[key];
  }
  return node;
}

/** Wraps a legacy `.entity` snapshot (a bare serializeEntity dump, no guid)
 *  as a real prefab def so the rest of the system sees one shape. The guid is
 *  derived fresh; callers that persist the upgrade should write it back. */
export function upgradeLegacyEntity(snapshot, { guid = newGuid(), name } = {}) {
  return {
    prefab: PREFAB_FORMAT_VERSION,
    guid,
    name: name ?? snapshot?.name ?? "Prefab",
    root: nodeFromSnapshot(snapshot ?? {}),
  };
}

/** Parses a `.prefab` / legacy `.entity` file body into a def. */
export function parsePrefabFile(text, { name } = {}) {
  const json = JSON.parse(text);
  if (isPrefabDef(json)) return json;
  return upgradeLegacyEntity(json, { name });
}

/**
 * Builds an empty def around a root node.
 * @param {unknown} root
 * @param {{ guid?: string, name?: string }} [opts]
 */
export function makeDef(root, { guid = newGuid(), name } = {}) {
  return { prefab: PREFAB_FORMAT_VERSION, guid, name: name ?? root?.name ?? "Prefab", root };
}

/**
 * Builds a variant def: no tree of its own, only a base + overrides.
 * @param {{ guid: string, name?: string, path?: string | null }} base
 * @param {{ guid?: string, name?: string, overrides?: unknown[] }} [opts]
 */
export function makeVariantDef(base, { guid = newGuid(), name, overrides = [] } = {}) {
  return {
    prefab: PREFAB_FORMAT_VERSION,
    guid,
    name: name ?? `${base.name ?? "Prefab"} Variant`,
    variantOf: { guid: base.guid, path: base.path ?? null },
    overrides,
  };
}
