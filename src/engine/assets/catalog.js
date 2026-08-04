import { normalizePath } from "../prefab/format.js";

const basenameOf = (path) => String(path).split(/[\\/]/).pop() ?? path;

/**
 * Process-wide catalog of project assets — name + tags per path, so
 * `engine.assets.findByName`/`byTag` can resolve without a filesystem to
 * search. Same shape as `prefab/registry.js`'s `PrefabRegistry` (a module
 * singleton both hosts fill before scripts run), keyed by path instead of
 * guid — assets don't have a guid, they're addressed by path everywhere else
 * already (see `AssetRegistry.js`).
 *
 * Coverage is NOT "every file in the project": the editor fills it from
 * whatever project-wide asset scan / tag edit has run (see
 * `editor/assetCatalog.js`), and an exported build fills it only with assets
 * a shipped scene actually references (see `exportGame.js`) — a tagged but
 * unreferenced asset never ships, so it never appears here either.
 */
class AssetCatalog {
  constructor() {
    this.entries = new Map(); // normalized path -> { path, name, tags }
    this.byNameIndex = new Map(); // lowercased name -> Set<normalized path>
    this.byTagIndex = new Map(); // tag -> Set<normalized path>
  }

  register(entry) {
    if (!entry?.path) return;
    const key = normalizePath(entry.path);
    this.#unindex(key);
    const record = {
      path: entry.path,
      name: entry.name || basenameOf(entry.path),
      tags: [...new Set(entry.tags ?? [])],
    };
    this.entries.set(key, record);
    this.#index(key, record);
  }

  unregister(path) {
    const key = normalizePath(path);
    this.#unindex(key);
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.byNameIndex.clear();
    this.byTagIndex.clear();
  }

  get(path) {
    return this.entries.get(normalizePath(path)) ?? null;
  }

  all() {
    return [...this.entries.values()];
  }

  /** Every known path whose name matches `name` (case-insensitive, exact). */
  findByName(name) {
    return this.#pathsOf(this.byNameIndex.get(String(name ?? "").toLowerCase()));
  }

  /** Every known path carrying `tag`. */
  findByTag(tag) {
    return this.#pathsOf(this.byTagIndex.get(tag));
  }

  /** Every known path carrying at least one ("any", default) or every one
   *  ("all") of `tags`. */
  findByTags(tags, mode = "any") {
    const wanted = (tags ?? []).filter(Boolean);
    if (!wanted.length) return [];
    const sets = wanted.map((tag) => this.byTagIndex.get(tag) ?? new Set());
    const keys =
      mode === "all"
        ? [...sets[0]].filter((key) => sets.every((set) => set.has(key)))
        : [...new Set(sets.flatMap((set) => [...set]))];
    return keys.map((key) => this.entries.get(key)?.path).filter(Boolean);
  }

  #pathsOf(keySet) {
    if (!keySet?.size) return [];
    return [...keySet].map((key) => this.entries.get(key)?.path).filter(Boolean);
  }

  #index(key, record) {
    const nameKey = record.name.toLowerCase();
    if (!this.byNameIndex.has(nameKey)) this.byNameIndex.set(nameKey, new Set());
    this.byNameIndex.get(nameKey).add(key);
    for (const tag of record.tags) {
      if (!this.byTagIndex.has(tag)) this.byTagIndex.set(tag, new Set());
      this.byTagIndex.get(tag).add(key);
    }
  }

  #unindex(key) {
    const prev = this.entries.get(key);
    if (!prev) return;
    this.byNameIndex.get(prev.name.toLowerCase())?.delete(key);
    for (const tag of prev.tags) this.byTagIndex.get(tag)?.delete(key);
  }
}

export const assetCatalog = new AssetCatalog();

/** Loads entries from an exported scene's `assetIndex` array. */
export function registerAssetDefs(defs = []) {
  for (const def of defs) {
    if (def?.path) assetCatalog.register(def);
  }
}
