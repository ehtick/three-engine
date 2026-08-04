// @ts-check
import { instantiateEntity, SCENE_VERSION } from "./serialize.js";
import { prefabRegistry } from "./prefab/registry.js";
import { assetCatalog } from "./assets/catalog.js";
import { resolveInstance } from "./prefab/resolve.js";
import { SCENE_SETTINGS_DEFAULTS } from "./sceneSettings.js";
import { loadSceneJson, resolveAssetUrl } from "./assetResolver.js";
import { getComponentClass } from "./components/registry.js";
import { enableEngineModule } from "./modules.js";
import { collectTimelineAssets } from "./timeline/timelineAsset.js";
import { createId } from "../shared/ids.js";

/**
 * Runtime scene loading — the thing that turns a scene into a game.
 *
 * Until this existed a build could show exactly one scene: the one baked into
 * `scene.json` at export. No menu → level 1 → level 2, no "restart the level",
 * no streaming a room in beside the one you're standing in. `deserializeScene`
 * could technically be called again, but it destroys everything first (so no
 * game manager survives the transition), takes an already-parsed object (so
 * the caller has to know where scenes live), and reports no progress (so a
 * loading screen has nothing to draw).
 *
 * A scene is addressed by its PROJECT-RELATIVE PATH — `"scenes/Level2.scene"`.
 * The same string works in the editor (resolved against the open project) and
 * in a build (fetched as a relative URL), because the exporter copies scene
 * files across at the same relative path. Scripts never learn which one they
 * are running in.
 *
 *   await this.engine.loadScene("scenes/Level2.scene");
 *   await this.engine.loadScene("scenes/Hud.scene", { mode: "additive" });
 *
 * Load modes:
 *   "single"   replaces the current scene, keeping persistent entities
 *   "additive" adds the scene alongside what is already loaded
 *
 * Progress is reported per phase for a loading screen; see `load`'s options.
 */

// Fractions of the reported 0..1 progress each phase is worth. Preload
// dominates deliberately — it is the only phase whose duration scales with
// the size of the level, and the only one where a progress bar earns its keep.
const PHASE_WEIGHTS = {
  fetch: 0.05,
  modules: 0.05,
  preload: 0.6,
  unload: 0.05,
  instantiate: 0.25,
};
const PHASE_ORDER = ["fetch", "modules", "preload", "unload", "instantiate"];

const IMAGE_RE = /\.(png|jpe?g|webp|ktx2|basis|exr|hdr|tga)$/i;

/** Superseded loads reject with this so callers can tell "cancelled" from "broken". */
export class SceneLoadCancelled extends Error {
  constructor(path) {
    super(`Scene load cancelled: ${path}`);
    this.name = "SceneLoadCancelled";
    this.cancelled = true;
  }
}

/** Normalises a scene reference to a comparable forward-slash path. */
export function sceneRefToPath(ref) {
  const raw = typeof ref === "string" ? ref : ref?.path;
  if (!raw) throw new Error("loadScene: expected a scene path");
  return String(raw).replaceAll("\\", "/");
}

export function sceneNameFromPath(path) {
  const base = path.split("/").pop() ?? "Untitled";
  return base.replace(/\.(scene|json)$/i, "");
}

/** Depth-first search for a CameraComponent's camera. */
export function findSceneCamera(entities) {
  for (const entity of entities) {
    const camera = entity.getComponent?.("camera")?.camera;
    if (camera) return camera;
    const child = findSceneCamera(entity.children ?? []);
    if (child) return child;
  }
  return null;
}

export class SceneManager {
  constructor(engine) {
    this.engine = engine;
    /** Loaded scene records, in load order: `{ path, name, mode, rootIds }`. */
    this.loaded = [];
    /** `{ path, mode }` while a load is in flight, else null. */
    this.pending = null;
    // Bumped by every load/reset. An in-flight load compares the token it
    // captured at entry after each await and bails if a newer load (or a
    // Stop in the editor) superseded it — otherwise two overlapping
    // `loadScene` calls interleave their instantiate phases into one scene.
    this._token = 0;
  }

  /** The most recent "single"-mode scene — the level you are actually in. */
  get active() {
    for (let i = this.loaded.length - 1; i >= 0; i--) {
      if (this.loaded[i].mode === "single") return this.loaded[i];
    }
    return this.loaded[0] ?? null;
  }

  get isLoading() {
    return !!this.pending;
  }

  isLoaded(ref) {
    const path = sceneRefToPath(ref);
    return this.loaded.some((s) => s.path === path);
  }

  /**
   * Loads a scene.
   *
   * @param ref   project-relative scene path (`"scenes/Level2.scene"`)
   * @param mode  "single" (replace) | "additive" (add alongside)
   * @param preload  true = prefetch the assets the scene references before
   *                 instantiating, so the level does not pop in over the first
   *                 seconds of play. false skips it; an array preloads exactly
   *                 those paths.
   * @param onProgress  `({ phase, loaded, total, progress }) => void`, also
   *                 emitted on the engine as "scene-load-progress"
   * @param setCamera  repoint `engine.camera` at the new scene's camera.
   *                 Defaults to "auto" = only while playing, so loading a
   *                 scene in the editor never steals the viewport camera.
   * @returns the scene record, or null if a newer load superseded this one
   */
  async load(ref, { mode = "single", preload = true, onProgress = null, setCamera = "auto" } = {}) {
    const path = sceneRefToPath(ref);
    if (mode !== "single" && mode !== "additive") {
      throw new Error(`loadScene: unknown mode "${mode}" (expected "single" or "additive")`);
    }
    const token = ++this._token;
    const engine = this.engine;
    this.pending = { path, mode };
    engine.emit("scene-load-start", { path, mode });

    const report = (phase, loaded = 1, total = 1) => {
      let base = 0;
      for (const key of PHASE_ORDER) {
        if (key === phase) break;
        base += PHASE_WEIGHTS[key];
      }
      const ratio = total > 0 ? Math.min(1, loaded / total) : 1;
      const progress = Math.min(1, base + PHASE_WEIGHTS[phase] * ratio);
      const payload = { path, mode, phase, loaded, total, progress };
      onProgress?.(payload);
      engine.emit("scene-load-progress", payload);
    };
    // Every await is followed by this: the load is only still the current one
    // if nobody started another in the meantime.
    const alive = () => this._token === token;

    try {
      report("fetch", 0, 1);
      const json = await loadSceneJson(path);
      if (!alive()) return null;
      if (!json || typeof json !== "object") throw new Error(`Scene not found: ${path}`);
      if (json.version !== SCENE_VERSION) {
        throw new Error(`Unsupported scene version ${json.version} in ${path}`);
      }
      report("fetch", 1, 1);

      // Modules register component types, so they must be live before any
      // entity instantiates. Only ever ENABLES: a scene that lists fewer
      // modules than the project must not tear down physics mid-game.
      const wanted = json.modules ?? [];
      report("modules", 0, wanted.length || 1);
      for (const [index, id] of wanted.entries()) {
        if (!engine.modules.has(id)) await enableEngineModule(engine, id);
        if (!alive()) return null;
        report("modules", index + 1, wanted.length);
      }
      report("modules", 1, 1);

      // Prefab defs before instantiation — an instance node with no def in the
      // registry cannot expand.
      for (const def of json.prefabs ?? []) {
        if (def?.guid) prefabRegistry.register(def, def.path ?? null);
      }
      // Name/tag catalog for `engine.assets.findByName`/`byTag`. Embedded once,
      // on the start scene, alongside prefabs — see exportGame.js.
      for (const def of json.assetIndex ?? []) {
        if (def?.path) assetCatalog.register(def);
      }

      let assets = preload === false ? [] : Array.isArray(preload) ? preload : collectSceneAssets(json);
      if (preload === true && assets.length) assets = await expandMaterialAssets(assets);
      if (!alive()) return null;
      await this.#preload(assets, report, alive);
      if (!alive()) return null;

      report("unload", 0, 1);
      if (mode === "single") this.#unloadAll();
      report("unload", 1, 1);

      report("instantiate", 0, 1);
      if (mode === "single") {
        engine.sceneName = json.name ?? sceneNameFromPath(path);
        await engine.applySettings(json.settings ?? structuredClone(SCENE_SETTINGS_DEFAULTS));
        if (!alive()) return null;
      }

      // Additive scenes were authored independently, so two of them (or the
      // same one loaded twice) can carry the same entity ids. The engine keys
      // its entity map by id, so a collision would silently replace the
      // earlier entity's map entry and leak it.
      const entities = mode === "additive" ? remapCollidingIds(engine, json.entities ?? []) : json.entities ?? [];

      const rootIds = [];
      await engine.batchHierarchy(() => {
        for (const [index, data] of entities.entries()) {
          const entity = instantiateEntity(engine, data, null);
          if (entity) rootIds.push(entity.id);
          report("instantiate", index + 1, entities.length);
        }
        engine.emit("hierarchy-changed");
      });
      if (!alive()) return null;

      // Entity construction is synchronous, but model parsing and script
      // modules continue asynchronously after their components attach. Do not
      // publish scene-loaded (or let the player start physics) until every
      // component that exposes readiness has settled. Otherwise dynamic
      // bodies can fall while a large model is still being parsed and the
      // first visible frame is not the authored scene.
      await this.#waitForEntityReadiness(alive);
      if (!alive()) return null;

      const record = { path, name: engine.sceneName, mode, rootIds };
      if (mode === "single") this.loaded = [record];
      else this.loaded.push(record);

      const shouldSetCamera = setCamera === "auto" ? engine.playing : !!setCamera;
      if (shouldSetCamera && mode === "single") {
        // The outgoing scene's camera was just destroyed; without this the
        // renderer keeps drawing through a detached camera and the game
        // renders the last frame of the previous level forever.
        const camera = findSceneCamera(engine.rootEntities);
        if (camera) engine.camera = camera;
      }

      report("instantiate", 1, 1);
      engine.emit("scene-loaded", { path, mode, name: record.name, rootIds });
      return record;
    } catch (error) {
      if (alive()) engine.emit("scene-load-error", { path, mode, error });
      throw error;
    } finally {
      if (this._token === token) this.pending = null;
    }
  }

  async #waitForEntityReadiness(alive) {
    const pending = [];
    for (const entity of this.engine.entities.values()) {
      for (const component of entity.components.values()) {
        if (typeof component.whenReady === "function") pending.push(component.whenReady());
      }
    }
    await Promise.allSettled(pending);
  }

  /**
   * Removes an additively-loaded scene. Entities the scene created at runtime
   * are not tracked and survive — only what the scene file put there is
   * destroyed, which is the same contract Unity's `UnloadSceneAsync` has.
   */
  unload(ref) {
    const path = sceneRefToPath(ref);
    const index = this.loaded.findIndex((s) => s.path === path);
    if (index === -1) return false;
    const [record] = this.loaded.splice(index, 1);
    const engine = this.engine;
    engine.batchHierarchy(() => {
      for (const id of record.rootIds) {
        const entity = engine.getEntity(id);
        if (entity && !entity.persistent) engine.destroyEntity(entity);
      }
      engine.emit("hierarchy-changed");
    });
    engine.emit("scene-unloaded", { path, name: record.name });
    return true;
  }

  /**
   * Forgets all bookkeeping without touching entities. The editor calls this
   * when leaving Play mode — the scene snapshot is restored by
   * `reconcileScene`, so the manager must not also try to unload whatever the
   * game loaded, but it must stop claiming that scene is still loaded.
   */
  reset({ path = null, name = null } = {}) {
    ++this._token; // cancel any in-flight load
    this.pending = null;
    this.loaded = path ? [{ path: sceneRefToPath(path), name: name ?? sceneNameFromPath(path), mode: "single", rootIds: [] }] : [];
  }

  /** Destroys every non-persistent root, re-rooting persistent descendants. */
  #unloadAll() {
    const engine = this.engine;
    // Pools are per level. A parked instance holds geometry and materials from
    // the scene being unloaded, and its prefab may not even exist in the next
    // one — handing it out in level 2 is worse than paying for a fresh spawn.
    engine.pool.reset();
    engine.batchHierarchy(() => {
      // Persistent entities buried in the outgoing hierarchy would be
      // destroyed along with their ancestors. Unity solves this by moving
      // the object to a scene of its own; re-rooting is the same idea with
      // the tree we have.
      for (const entity of [...engine.entities.values()]) {
        if (!entity.persistent || !entity.parent) continue;
        if (hasPersistentAncestor(entity)) continue;
        entity.setParent(null);
      }
      for (const entity of [...engine.rootEntities]) {
        if (!entity.persistent) engine.destroyEntity(entity);
      }
      engine.emit("hierarchy-changed");
    });
    this.loaded = this.loaded.filter(() => false);
  }

  async #preload(paths, report, alive) {
    const total = paths.length;
    report("preload", 0, total || 1);
    if (!total) return;
    let done = 0;
    // Sequential-with-a-window rather than Promise.all: a level with 400
    // textures would otherwise open 400 concurrent requests, which in a
    // packaged build means the browser queues them anyway and the progress
    // bar jumps from 0 to 100 with a long stall in between.
    const CONCURRENCY = 8;
    const queue = [...paths];
    const worker = async () => {
      while (queue.length) {
        if (!alive()) return;
        const path = queue.shift();
        try {
          const url = await resolveAssetUrl(path);
          // A blob: URL means the editor already read the file into memory
          // and cached it — fetching it back would only copy bytes around.
          if (typeof url === "string" && !url.startsWith("blob:")) {
            const res = await fetch(url);
            if (res.ok) await res.arrayBuffer();
          }
        } catch (error) {
          // A missing preload must never stop a level from loading — the
          // component that actually needs it reports the real error later.
          console.warn(`[scenes] preload failed (${path}): ${error?.message ?? error}`);
        }
        report("preload", ++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  }
}

function hasPersistentAncestor(entity) {
  for (let p = entity.parent; p; p = p.parent) {
    if (p.persistent) return true;
  }
  return false;
}

/**
 * Rewrites ids that are already taken in the live engine, keeping the tree's
 * internal parent/child links intact (they are structural, not id-based, so
 * only the ids themselves need changing).
 */
function remapCollidingIds(engine, entities) {
  const idMap = new Map();
  const walk = (node) => {
    const next = { ...node };
    if (next.id && engine.entities.has(next.id)) {
      const fresh = createId();
      idMap.set(next.id, fresh);
      next.id = fresh;
    }
    if (next.children?.length) next.children = next.children.map(walk);
    return next;
  };
  const out = entities.map(walk);
  if (!idMap.size) return entities;

  // Second pass: props that REFERENCE an entity (a joint's connected body, an
  // IK target, a camera's follow target) still name the ids we just replaced,
  // so the second copy of a scene would wire itself to the first copy's
  // entities. Found through the schema's `type: "entity"` fields, the same way
  // `collectSceneAssets` finds asset paths — so a new component with an entity
  // reference is handled the day it is added, not the day someone notices.
  //
  // Rebuilds rather than mutates: `walk` shallow-copies each node, so the
  // component objects are still the caller's, and the caller's JSON may be a
  // cached scene about to be loaded again.
  const remap = (node) => ({
    ...node,
    components: node.components?.map((comp) => {
      const schema = getComponentClass?.(comp.type)?.schema ?? [];
      let props = comp.props;
      for (const field of schema) {
        if (field?.type === "entityMap") {
          // A map whose VALUES are entity ids (a timeline director's track
          // bindings). Same problem as a plain entity field, one level down —
          // and a second copy of a cutscene driving the first copy's props is
          // the most confusing version of it, because the scene that plays is
          // the one you weren't looking at.
          const table = props?.[field.key];
          if (!table || typeof table !== "object") continue;
          let next = null;
          for (const [key, value] of Object.entries(table)) {
            const mapped = idMap.get(value);
            if (!mapped) continue;
            next ??= { ...table };
            next[key] = mapped;
          }
          if (!next) continue;
          if (props === comp.props) props = { ...props };
          props[field.key] = next;
          continue;
        }
        if (field?.type !== "entity") continue;
        const mapped = idMap.get(props?.[field.key]);
        if (!mapped) continue;
        if (props === comp.props) props = { ...props };
        props[field.key] = mapped;
      }
      return props === comp.props ? comp : { ...comp, props };
    }),
    children: node.children?.map(remap),
  });
  return out.map(remap);
}

/**
 * Every asset path a scene references, derived from component schemas rather
 * than a hand-maintained list — a new component with an `asset` field is
 * preloaded the day it is added.
 */
export function collectSceneAssets(json) {
  const out = new Set();
  for (const path of json.preload ?? []) if (path) out.add(path);

  const visitComponent = ({ type, props }, depth = 0) => {
    if (!props) return;
    const schema = getComponentClass?.(type)?.schema ?? [];
    for (const field of schema) {
      // A prefab field (a pool's stock, a spawner's bullet) names content that
      // is not in the scene tree at all, so nothing else here would reach it.
      // Prewarming a pool whose model has not been fetched yet buys nothing:
      // the hitch simply moves to the first spawn.
      if (field?.type === "prefab") {
        const ref = props[field.key];
        if (typeof ref === "string" && ref && depth < 8) {
          try {
            const tree = resolveInstance({ path: ref }, []);
            if (tree) visitNode({ ...tree, prefab: null }, depth + 1);
          } catch {
            // Unresolvable here is not fatal — the spawn reports it.
          }
        }
        continue;
      }
      if (field?.type !== "asset") continue;
      const value = props[field.key];
      if (typeof value === "string" && value) out.add(value);
    }
    // Per-material overrides on an imported model are a name -> path map, not
    // a schema field.
    if (type === "model" && props.materials && typeof props.materials === "object") {
      for (const value of Object.values(props.materials)) {
        if (typeof value === "string" && value) out.add(value);
      }
    }
    // Scripts are loaded through their own module loader, but fetching the
    // file early still removes the round-trip.
    if (typeof props.path === "string" && /\.(ts|js)$/i.test(props.path)) out.add(props.path);
  };

  const visitNode = (node, depth = 0) => {
    if (!node || depth > 64) return;
    if (node.prefab) {
      // A prefab instance keeps its contents in the def, not in the scene.
      try {
        const tree = resolveInstance(node.prefab, node.overrides ?? []);
        if (tree) visitNode({ ...tree, prefab: null }, depth + 1);
      } catch {
        // An unresolvable prefab is the expander's problem to report.
      }
      return;
    }
    for (const component of node.components ?? []) visitComponent(component, depth);
    for (const child of node.children ?? []) visitNode(child, depth + 1);
  };
  for (const node of json.entities ?? []) visitNode(node);

  return [...out];
}

/**
 * Second pass over the preload list: a `.mat` is a few hundred bytes, but the
 * textures it points at are the megabytes that actually make a level pop in.
 * Materials are the only indirection worth following — everything else either
 * is the payload (`.glb`) or is negligible.
 */
export async function expandMaterialAssets(paths) {
  const out = new Set(paths);
  await Promise.all(
    paths
      .filter((path) => /\.(mat|timeline)$/i.test(path))
      .map(async (path) => {
        try {
          const url = await resolveAssetUrl(path);
          const res = await fetch(url);
          if (!res.ok) return;
          const json = await res.json();
          // A timeline is a list of references, same as a material: the clips
          // its audio tracks name are what has to be decoded before the
          // cutscene starts, or the first line of dialogue is missing.
          if (/\.timeline$/i.test(path)) {
            for (const asset of collectTimelineAssets(json)) out.add(asset);
          } else {
            collectImagePaths(json, out);
          }
        } catch {
          // Best effort — the material loader reports real failures.
        }
      }),
  );
  return [...out];
}

function collectImagePaths(value, out, depth = 0) {
  if (depth > 12 || !value) return;
  if (typeof value === "string") {
    if (IMAGE_RE.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePaths(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectImagePaths(item, out, depth + 1);
  }
}
