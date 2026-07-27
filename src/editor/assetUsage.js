import { getComponentClass } from "../engine/index.js";
import { useSceneStore } from "./store/sceneStore.js";
import { invoke } from "./assetOps.js";

/**
 * "Which files does this object actually use?" — the question the Assets panel
 * can't answer from the filesystem alone, because the answer lives in the
 * scene graph. Used by the panel's "Used by selection" filter so picking an
 * object in the viewport narrows the browser to just its art.
 *
 * Paths are compared case-insensitively with forward slashes, since the same
 * asset reaches us as both `C:\proj\a.mat` and `C:/proj/a.mat` depending on
 * whether it came from the OS, a drag, or a serialized scene.
 */

export const normalizePath = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();

/** Every descendant id of `id`, inclusive. */
function subtree(id, entities, out = []) {
  const entity = entities[id];
  if (!entity) return out;
  out.push(id);
  for (const child of entity.childIds ?? []) subtree(child, entities, out);
  return out;
}

/**
 * Direct asset references on one component's props. Schema-driven for the
 * common case (`type: "asset"` / `"prefab"`), with explicit handling for the
 * few components that hold references in a shape the schema can't describe —
 * lists and maps.
 */
function componentAssets(type, props, out) {
  const add = (value) => {
    if (typeof value === "string" && value.trim()) out.add(value);
  };

  for (const descriptor of getComponentClass(type)?.schema ?? []) {
    if (descriptor.type === "asset" || descriptor.type === "prefab") add(props[descriptor.key]);
  }

  if (type === "model") {
    add(props.path);
    for (const value of Object.values(props.materials ?? {})) add(value);
  } else if (type === "script") {
    for (const slot of props.scripts ?? []) add(slot?.path);
    add(props.path); // legacy single-script shape
  } else if (type === "sound") {
    for (const entry of props.entries ?? []) add(entry?.audioAsset);
  } else if (type === "particles") {
    // Particle textures live inside the component's node graph, not in a prop.
    for (const node of props.graph?.nodes ?? []) {
      if (node?.props?.path) add(node.props.path);
    }
  }
}

/**
 * Assets directly referenced by the given entities and everything under them.
 * Synchronous — reads the scene mirror only, no disk access.
 */
export function collectDirectAssets(entityIds) {
  const entities = useSceneStore.getState().entities;
  const out = new Set();
  const seen = new Set();
  for (const rootId of entityIds) {
    for (const id of subtree(rootId, entities)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entity = entities[id];
      for (const [type, props] of Object.entries(entity?.components ?? {})) {
        componentAssets(type, props ?? {}, out);
      }
    }
  }
  return out;
}

const materialTextureCache = new Map(); // .mat path -> string[]

/** Texture paths a `.mat` pulls in, via its top-level map and shader graph. */
async function materialTextures(path) {
  if (materialTextureCache.has(path)) return materialTextureCache.get(path);
  let textures = [];
  try {
    const def = JSON.parse(await invoke("read_text_file", { path }));
    const found = new Set();
    if (def.map) found.add(def.map);
    for (const node of def.shaderGraph?.nodes ?? []) {
      if (node.type === "texture" && node.props?.path) found.add(node.props.path);
    }
    textures = [...found];
  } catch {
    // Unreadable or not JSON — no textures to attribute to it.
  }
  materialTextureCache.set(path, textures);
  return textures;
}

/** Drops the cached texture list for a `.mat` the user just edited. */
export function invalidateMaterialTextures(path) {
  if (path) materialTextureCache.delete(path);
  else materialTextureCache.clear();
}

/**
 * Direct references plus one level of indirection: the textures reached
 * through referenced `.mat` files. Without this, selecting a textured object
 * and filtering to "used by selection" hides the very textures you went
 * looking for.
 */
export async function collectUsedAssets(entityIds) {
  const direct = collectDirectAssets(entityIds);
  const materials = [...direct].filter((path) => /\.mat$/i.test(path));
  const nested = await Promise.all(materials.map(materialTextures));
  const all = new Set([...direct].map(normalizePath));
  for (const list of nested) for (const path of list) all.add(normalizePath(path));
  return all;
}
