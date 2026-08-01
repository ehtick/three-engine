/**
 * Save/load + persistent data (`engine.saves`, `engine.prefs`).
 *
 * A game needs two very different kinds of persistence and conflating them is
 * the usual mistake:
 *
 *   - **Save slots** — a snapshot of a playthrough. Written on demand, read
 *     back into a specific scene, versioned because the game will change shape
 *     after players already have saves on disk.
 *   - **Preferences** — volume, difficulty, keybinds, "seen the intro".
 *     Global, written immediately, and must survive deleting every save slot.
 *
 * `engine.saves` is the first; `engine.prefs` is the second.
 *
 * ## What ends up in a save
 *
 * NOT the whole scene. Re-serializing every entity would make saves enormous,
 * would bake level geometry into them (so a level fix could never reach an
 * existing save), and would still miss the things that actually matter — the
 * quest flags and cooldowns living in script fields.
 *
 * Instead the game opts in, per script, through two hooks:
 *
 *     export default class Chest extends Script {
 *       opened = false;
 *       onSave() { return { opened: this.opened }; }
 *       onLoad(data) { this.opened = data.opened; if (this.opened) this.#open(); }
 *     }
 *
 * Any entity with a script defining `onSave` is captured — its transform and
 * activeness come along automatically, since "where the player was standing" is
 * wanted by essentially every save. `onLoad` runs *after* the transform is
 * applied, so a script that wants different placement just sets it there and
 * has the last word.
 *
 * Prefab instances spawned at runtime (enemies, dropped loot) are recorded with
 * their prefab link and respawned on load, so the save is authoritative for the
 * set of save-participating spawns rather than only for their contents.
 *
 * ## Versioning
 *
 * `data.version` is the *game's* save version (`engine.config.saveVersion`),
 * not this file's format version. Bump it when the shape of what your scripts
 * write changes, and register a migration:
 *
 *     engine.saves.registerMigration(2, (data) => { … return data; });
 *
 * A save older than the current version with no registered path to it is
 * REFUSED, not loaded — silently feeding v1 data to v2 scripts corrupts a
 * playthrough in ways the player only discovers hours later.
 *
 * ## Storage
 *
 * The runtime never touches Tauri or the filesystem (exported games are plain
 * web pages), so storage is a swappable backend like `assetResolver`. The
 * default is `localStorage`, with an in-memory fallback when it is unavailable
 * (private-mode browsers, Node tests) so nothing throws — but `saves.durable`
 * reports which one is live, because a game that silently "saves" to memory is
 * worse than one that admits it cannot.
 */

/** Envelope format version — bumped only when THIS file changes shape. */
export const SAVE_FORMAT_VERSION = 1;

const KEY_PREFIX = "engine.save.v1";

/** In-memory fallback so a missing/blocked localStorage degrades instead of throwing. */
function memoryBackend() {
  const map = new Map();
  return {
    durable: false,
    async read(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async write(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

function localStorageBackend(storage) {
  return {
    durable: true,
    async read(key) {
      return storage.getItem(key);
    },
    async write(key, value) {
      storage.setItem(key, value);
    },
    async remove(key) {
      storage.removeItem(key);
    },
    async keys() {
      const out = [];
      for (let i = 0; i < storage.length; i++) out.push(storage.key(i));
      return out;
    },
  };
}

function defaultBackend() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return memoryBackend();
    // Safari private mode has a localStorage that throws on write. Find out
    // now, while we can still fall back, rather than when the player saves.
    const probe = `${KEY_PREFIX}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return localStorageBackend(storage);
  } catch {
    return memoryBackend();
  }
}

let backend = null;

/**
 * Replaces the storage backend — the editor points this at the project folder,
 * a packaged desktop build at the OS save directory, a server-backed game at
 * its API. `{ read, write, remove, keys }`, all async, values are strings.
 * Pass null to return to the default (localStorage, else memory).
 */
export function setSaveBackend(next) {
  backend = next;
}

export function getSaveBackend() {
  if (!backend) backend = defaultBackend();
  return backend;
}

/**
 * A small persisted key/value bag. `engine.prefs` writes through on every
 * change (settings must survive a crash); `engine.saves.state` does not — it
 * is captured into whichever slot the game writes next.
 */
export class KeyValueStore {
  constructor({ onChange = null } = {}) {
    this._data = new Map();
    this._onChange = onChange;
  }

  get(key, fallback = null) {
    return this._data.has(key) ? this._data.get(key) : fallback;
  }

  set(key, value) {
    if (value === undefined) return this.delete(key);
    this._data.set(key, value);
    this._onChange?.();
    return value;
  }

  has(key) {
    return this._data.has(key);
  }

  delete(key) {
    const had = this._data.delete(key);
    if (had) this._onChange?.();
    return had;
  }

  keys() {
    return [...this._data.keys()];
  }

  clear() {
    if (this._data.size === 0) return;
    this._data.clear();
    this._onChange?.();
  }

  /** Adds `amount` to a numeric key (missing = 0) — score, coins, kills. */
  increment(key, amount = 1) {
    return this.set(key, (Number(this.get(key, 0)) || 0) + amount);
  }

  toJSON() {
    return Object.fromEntries(this._data);
  }

  load(object) {
    this._data = new Map(Object.entries(object ?? {}));
  }
}

/**
 * The per-script key inside an entity's save entry. Uses the script's FILE
 * STEM, not its index in the list: reordering an entity's scripts in the
 * inspector must not scramble existing saves. Two copies of the same script on
 * one entity disambiguate as `stem#1`, `stem#2`.
 */
function scriptKeys(component) {
  const slots = component?.slots ?? [];
  const seen = new Map();
  return slots.map((slot) => {
    const stem =
      slot?.path?.split(/[\\/]/).pop()?.replace(/\.(ts|js)$/i, "").toLowerCase() ?? "script";
    const n = seen.get(stem) ?? 0;
    seen.set(stem, n + 1);
    return n === 0 ? stem : `${stem}#${n}`;
  });
}

function captureTransform(entity) {
  const o = entity.object3D;
  return [
    o.position.x, o.position.y, o.position.z,
    o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w,
    o.scale.x, o.scale.y, o.scale.z,
  ];
}

function applyTransform(entity, t) {
  if (!Array.isArray(t) || t.length < 10) return;
  const o = entity.object3D;
  o.position.set(t[0], t[1], t[2]);
  o.quaternion.set(t[3], t[4], t[5], t[6]);
  o.scale.set(t[7], t[8], t[9]);
  o.updateMatrixWorld(true);
}

export class SaveSystem {
  constructor(engine) {
    this.engine = engine;
    /**
     * Namespaces the storage keys so two games served from the same origin
     * (or two projects in the editor) never read each other's saves.
     */
    this.namespace = "default";
    this._migrations = new Map();
    /** Game progress captured into the next slot written. See class docs. */
    this.state = new KeyValueStore();
  }

  /** The game's own save version — bumped by the project, not the engine. */
  get version() {
    return this.engine.config?.saveVersion ?? 1;
  }

  /** False when saves are going to memory only (blocked/absent localStorage). */
  get durable() {
    return getSaveBackend().durable !== false;
  }

  setNamespace(name) {
    this.namespace = String(name || "default").replace(/[^\w.-]+/g, "_");
  }

  _key(suffix) {
    return `${KEY_PREFIX}.${this.namespace}.${suffix}`;
  }

  /**
   * Registers an upgrade from version `toVersion - 1` to `toVersion`.
   * Migrations run in ascending order until the save reaches the current
   * version, so each one only has to know about a single step.
   */
  registerMigration(toVersion, fn) {
    this._migrations.set(toVersion, fn);
  }

  _migrate(data) {
    let out = data;
    let from = out.version ?? 1;
    while (from < this.version) {
      const step = this._migrations.get(from + 1);
      if (!step) {
        console.warn(
          `[saves] refusing a save at version ${from}: no migration to ${from + 1} ` +
            `(current version ${this.version}). Register one with ` +
            `engine.saves.registerMigration(${from + 1}, fn).`,
        );
        return null;
      }
      out = step(out) ?? out;
      from += 1;
      out.version = from;
    }
    return out;
  }

  // ---- capture / restore ---------------------------------------------------

  /**
   * Builds the save payload from the live scene without writing it — for a
   * custom slot UI, a checkpoint held in memory, or a test.
   */
  capture(extra = null) {
    const entities = [];
    for (const entity of this.engine.entities.values()) {
      const component = entity.getComponent?.("script");
      if (!component) continue;
      const keys = scriptKeys(component);
      const data = {};
      let opted = false;
      (component.slots ?? []).forEach((slot, index) => {
        if (typeof slot?.instance?.onSave !== "function") return;
        opted = true;
        try {
          const value = slot.instance.onSave();
          if (value !== undefined) data[keys[index]] = value;
        } catch (error) {
          console.warn(`[saves] onSave threw on "${entity.name}":`, error?.message ?? error);
        }
      });
      if (!opted) continue;
      const entry = {
        id: entity.id,
        name: entity.name,
        transform: captureTransform(entity),
        scripts: data,
      };
      if (entity.parent) entry.parent = entity.parent.id;
      // "Enabled in game" is the flag gameplay actually toggles (a picked-up
      // item, a defeated boss); the editor flag is authoring state and has no
      // business in a save.
      if (entity.enabledInGame === false) entry.enabled = false;
      // Only a prefab instance can be recreated from a save; a plain runtime
      // entity has no recipe to rebuild it from, so it is recorded but will
      // only restore if the scene still provides it.
      if (entity.prefab) entry.prefab = { ...entity.prefab };
      entities.push(entry);
    }

    return {
      format: SAVE_FORMAT_VERSION,
      version: this.version,
      savedAt: Date.now(),
      scene: this.engine.scenes?.active?.path ?? null,
      playTime: this.engine.elapsedTime ?? 0,
      state: this.state.toJSON(),
      entities,
      ...(extra ? { meta: extra } : null),
    };
  }

  /**
   * Applies a captured payload to the live scene.
   *
   * @param data       a payload from `capture()` / `read()`
   * @param loadScene  load `data.scene` first when it isn't the active one.
   *                   Default true — a save names the level it belongs to, and
   *                   restoring player state into the wrong level is nonsense.
   * @param prune      destroy save-participating prefab instances that the
   *                   save doesn't contain (enemies killed before saving must
   *                   not be standing there after loading). Default true.
   */
  async restore(data, { loadScene = true, prune = true } = {}) {
    if (!data) return false;

    const target = data.scene;
    if (loadScene && target && this.engine.scenes?.active?.path !== target) {
      const record = await this.engine.loadScene(target);
      // A superseded load resolves to null; applying entity state to whatever
      // scene won the race would scatter it across the wrong level.
      if (!record) return false;
    }

    this.state.load(data.state);

    const entries = data.entities ?? [];
    const wanted = new Set(entries.map((e) => e.id));

    if (prune) {
      for (const entity of [...this.engine.entities.values()]) {
        if (!entity.prefab || wanted.has(entity.id)) continue;
        if (typeof entity.getComponent?.("script")?.dispatch !== "function") continue;
        const participates = (entity.getComponent("script").slots ?? []).some(
          (slot) => typeof slot?.instance?.onSave === "function",
        );
        if (participates) this.engine.destroyEntity(entity);
      }
    }

    // Respawn first, then wait for the new entities' scripts to finish
    // importing. Script modules load asynchronously, so dispatching `onLoad`
    // straight after `instantiate` reaches a slot with no instance yet and the
    // saved state is silently dropped — a default enemy standing where a
    // half-dead one was saved.
    const respawned = [];
    for (const entry of entries) {
      if (this.engine.getEntity(entry.id) || !entry.prefab) continue;
      const entity = this._respawn(entry);
      if (entity) respawned.push(entity);
    }
    await Promise.all(
      respawned.map((entity) => entity.getComponent?.("script")?.whenReady?.()),
    );

    for (const entry of entries) {
      const entity = this.engine.getEntity(entry.id);
      if (!entity) {
        console.warn(`[saves] entity "${entry.name}" (${entry.id}) is not in this scene — skipped`);
        continue;
      }
      applyTransform(entity, entry.transform);
      // Absent `enabled` means "was enabled when saved" — restore it either
      // way, so loading twice in a session can't leave a disabled entity off.
      entity.setEnabledInGame?.(entry.enabled !== false);

      const component = entity.getComponent?.("script");
      if (!component) continue;
      const keys = scriptKeys(component);
      (component.slots ?? []).forEach((slot, index) => {
        if (typeof slot?.instance?.onLoad !== "function") return;
        const value = entry.scripts?.[keys[index]];
        try {
          slot.instance.onLoad(value ?? null);
        } catch (error) {
          console.warn(`[saves] onLoad threw on "${entity.name}":`, error?.message ?? error);
        }
      });
    }

    this.engine.emit?.("save-restored", { data });
    return true;
  }

  /** Re-creates a prefab instance recorded in a save, keeping its saved id. */
  _respawn(entry) {
    const parent = entry.parent ? this.engine.getEntity(entry.parent) ?? null : null;
    const entity = this.engine.instantiate?.(entry.prefab, { parent, name: entry.name });
    if (!entity) return null;
    // Re-key it to the id the save refers to, so a second load of the same
    // save (or a script holding the id) still resolves to this entity.
    this.engine.entities.delete(entity.id);
    entity.id = entry.id;
    entity.object3D.userData.entityId = entry.id;
    this.engine.entities.set(entry.id, entity);
    return entity;
  }

  // ---- slots ---------------------------------------------------------------

  /** Captures the live scene and writes it to `slot`. Returns the payload. */
  async save(slot, extra = null) {
    const data = this.capture(extra);
    await this.write(slot, data);
    return data;
  }

  /** Reads `slot` and applies it. Returns false when the slot is missing or refused. */
  async load(slot, options = {}) {
    const data = await this.read(slot);
    if (!data) return false;
    return this.restore(data, options);
  }

  async write(slot, data) {
    await getSaveBackend().write(this._key(`slot.${slot}`), JSON.stringify(data));
    this.engine.emit?.("save-written", { slot, data });
  }

  /** Parsed + migrated slot contents, or null (missing, corrupt, or too old). */
  async read(slot, { migrate = true } = {}) {
    const raw = await getSaveBackend().read(this._key(`slot.${slot}`));
    if (raw == null) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`[saves] slot ${slot} is corrupt and was ignored`);
      return null;
    }
    return migrate ? this._migrate(data) : data;
  }

  async has(slot) {
    return (await getSaveBackend().read(this._key(`slot.${slot}`))) != null;
  }

  async delete(slot) {
    await getSaveBackend().remove(this._key(`slot.${slot}`));
    this.engine.emit?.("save-deleted", { slot });
  }

  /**
   * Every written slot, newest first — the shape a load menu wants. Headers
   * only (slot, savedAt, scene, playTime, version, meta), not the entity data.
   */
  async list() {
    const prefix = this._key("slot.");
    const keys = await getSaveBackend().keys();
    const out = [];
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const slot = key.slice(prefix.length);
      let header = null;
      try {
        const parsed = JSON.parse(await getSaveBackend().read(key));
        header = {
          slot,
          savedAt: parsed.savedAt ?? 0,
          scene: parsed.scene ?? null,
          playTime: parsed.playTime ?? 0,
          version: parsed.version ?? 1,
          ...(parsed.meta ? { meta: parsed.meta } : null),
        };
      } catch {
        header = { slot, savedAt: 0, scene: null, playTime: 0, version: 0, corrupt: true };
      }
      out.push(header);
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }
}

/**
 * `engine.prefs` — settings and cross-playthrough flags. Writes through to
 * storage on every change, so it survives a crash mid-session, and is NOT
 * touched by loading or deleting a save slot.
 */
export class PreferenceStore extends KeyValueStore {
  constructor(engine) {
    super();
    this.engine = engine;
    this._writing = null;
    this._onChange = () => this._schedule();
  }

  _key() {
    return `${KEY_PREFIX}.${this.engine.saves?.namespace ?? "default"}.prefs`;
  }

  /** Coalesces a burst of `set()` calls (a settings slider) into one write. */
  _schedule() {
    if (this._writing) return this._writing;
    this._writing = Promise.resolve().then(async () => {
      this._writing = null;
      try {
        await getSaveBackend().write(this._key(), JSON.stringify(this.toJSON()));
      } catch (error) {
        console.warn("[prefs] write failed:", error?.message ?? error);
      }
    });
    return this._writing;
  }

  /** Reads persisted preferences in. Called by the engine at boot. */
  async hydrate() {
    try {
      const raw = await getSaveBackend().read(this._key());
      if (raw != null) this.load(JSON.parse(raw));
    } catch (error) {
      console.warn("[prefs] load failed:", error?.message ?? error);
    }
    return this;
  }

  /** Resolves once every pending write has landed (tests, quit-to-desktop). */
  async flush() {
    await this._writing;
  }
}
