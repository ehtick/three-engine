// @ts-check
import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { getComponentClass } from "./components/registry.js";

/**
 * Object pooling + budgeted async instantiation (roadmap item 15).
 *
 * Two features, one file, because they answer the same question from opposite
 * ends: *spawning costs time you don't have*. A prefab instantiation builds
 * entities, adds components, resolves materials and uploads geometry — fine
 * once, ruinous sixty times in the frame a wave of enemies arrives or a shotgun
 * fires. Pooling removes the cost by not paying it twice; the spawn queue
 * spreads the cost you cannot avoid across frames.
 *
 * ## Pooling
 *
 *   const bullet = engine.spawn(this.bulletPrefab, { position: muzzle });
 *   ...
 *   engine.despawn(bullet, 3);   // back to the pool in three seconds
 *
 * **Pools are keyed by prefab, and only prefabs can be pooled.** A pool's whole
 * promise is that a recycled instance is indistinguishable from a fresh one,
 * and that is only checkable against an authoritative template. A prefab is
 * that template; an arbitrary entity subtree has nothing to be reset *to*.
 *
 * A despawned entity leaves the world completely — out of `engine.entities`,
 * out of `rootEntities`, its `object3D` detached from the scene. Not merely
 * hidden: an invisible entity still answers `findByTag`, still gets its
 * per-frame visibility resolved, still lands in the physics world, and — the
 * one that actually corrupts something — still serializes into the scene file.
 * A level saved with a warm pool would gain two hundred invisible bullets.
 *
 * ## What "reset" means
 *
 * The set of components whose state lives outside `props` is already declared
 * in this engine: `static resetOnStop`, the marker that decides what leaving
 * Play tears down (see serialize.js `reconcileComponents`). Recycling asks the
 * identical question, so it reuses the identical answer — those components are
 * removed on despawn and re-added from the template on spawn. Everything else
 * is diffed against the template and only written where it actually differs, so
 * a bullet that changed nothing costs nothing to reset.
 *
 * Removing them on *despawn* rather than on spawn matters twice over: a script's
 * `onDestroy` fires when the object dies rather than minutes later when it is
 * next needed, and a pooled entity holds no component that ticks. That leaves
 * `onStart` / `onDestroy` as the spawn/despawn hooks — no new script surface to
 * learn, and code written against `instantiate` works unchanged under a pool.
 *
 * An instance whose *structure* changed while it was alive (a script added a
 * component or a child) is destroyed instead of recycled. Restoring arbitrary
 * structural edits is a scene-diffing problem; refusing to recycle costs one
 * instantiation and keeps the guarantee absolute.
 *
 * ## The spawn budget
 *
 *   await engine.pool.prewarm("prefabs/Enemy.prefab", 40);
 *   const e = await engine.instantiateAsync("prefabs/Boss.prefab");
 *
 * Queued work drains inside a wall-clock budget per frame (`budgetMs`,
 * default 2). Wall clock, not game time: prewarming happens behind a loading
 * screen with the game paused, and a budget measured in game time would never
 * advance there. **At least one item runs per frame regardless of the budget** —
 * a single prefab heavier than the whole budget would otherwise be deferred
 * forever, and a queue that never drains is worse than a hitch.
 */

/** Props are JSON-serializable by contract; the fallback is for anything that
 *  smuggled a class instance in, where a shallow copy is better than a throw. */
function cloneProps(props) {
  try {
    return structuredClone(props ?? {});
  } catch {
    return { ...(props ?? {}) };
  }
}

/** Cheap structural compare — same rule serialize.js uses for prop diffing. */
function sameProp(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const resetsOnRecycle = (type) => getComponentClass(type)?.resetOnStop === true;

/**
 * The template a bucket restores to: the instance exactly as the prefab
 * expander produced it, before any spawn options were applied.
 */
function snapshot(entity) {
  return {
    name: entity.name,
    transform: entity.getTransform(),
    viewOnly: !!entity.viewOnly,
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
    tags: [...(entity.tags ?? [])],
    components: [...entity.components.values()].map((c) => ({ type: c.type, props: cloneProps(c.props) })),
    children: entity.children.map(snapshot),
  };
}

export class PoolSystem {
  constructor(engine) {
    this.engine = engine;
    /** Wall-clock milliseconds per frame the spawn queue may spend. */
    this.budgetMs = 2;
    /** prefab guid -> bucket */
    this.buckets = new Map();
    /** Queued spawn work: { run, resolve, reject }. */
    this.queue = [];
    /** Pending timed despawns: { entity, remaining }. */
    this.timers = [];
    this._unsubs = [
      // Everything a pool holds was created during Play, and leaving Play
      // restores the authored scene — pooled instances are invisible to that
      // restore (they are not in the tree), so they would simply leak.
      engine.on("play-changed", (playing) => {
        if (!playing) this.reset();
      }),
    ];
  }

  dispose() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this.reset();
  }

  // ---- buckets -------------------------------------------------------------

  /** Resolves anything `instantiate` accepts to a prefab guid, or null. */
  #guidOf(ref) {
    if (!ref) return null;
    const link = typeof ref === "string" ? (prefabRegistry.has(ref) ? { guid: ref } : { path: ref }) : ref;
    return prefabRegistry.resolveLink(link);
  }

  #bucket(guid) {
    let bucket = this.buckets.get(guid);
    if (!bucket) {
      bucket = { guid, free: [], active: new Set(), template: null, created: 0, reused: 0, peak: 0 };
      this.buckets.set(guid, bucket);
    }
    return bucket;
  }

  // ---- spawn / despawn -----------------------------------------------------

  /**
   * Takes an instance from the pool, or creates one. Same signature as
   * `engine.instantiate`, and the same return: the instance root, or null when
   * the prefab can't be found.
   */
  spawn(ref, options = {}) {
    const guid = this.#guidOf(ref);
    if (!guid) {
      console.warn(`spawn: prefab not found (${typeof ref === "string" ? ref : JSON.stringify(ref)})`);
      return null;
    }
    const { parent = null, position, rotation, scale, name } = options;
    const bucket = this.#bucket(guid);
    const engine = this.engine;

    let entity = null;
    return engine.batchHierarchy(() => {
      while (bucket.free.length && !entity) {
        const candidate = bucket.free.pop();
        if (this.#recycle(candidate, bucket, parent)) entity = candidate;
        else engine.destroyEntity(candidate); // structurally modified — not ours to reuse
      }
      if (entity) {
        bucket.reused++;
      } else {
        entity = this.#create(bucket, parent);
        if (!entity) return null;
      }

      entity.pooled = false;
      if (position) entity.position = position;
      if (rotation) entity.rotation = rotation;
      if (scale) entity.scale = scale;
      if (name) entity.name = name;
      // After the transform, so anything that reads the entity's placement when
      // it attaches (a rigidbody's body pose) sees where the thing actually is.
      this.#addResetComponents(entity, bucket.template);
      bucket.active.add(entity);
      bucket.peak = Math.max(bucket.peak, bucket.active.size);
      // Systems that build from the entity tree (physics bodies) get one signal
      // per completed spawn rather than having to guess from `hierarchy-changed`
      // whether a half-built subtree is worth walking.
      engine.emit("entity-spawned", entity);
      return entity;
    });
  }

  /** Queued `spawn` — reuse is instant, a cold pool pays the budget. */
  spawnAsync(ref, options = {}) {
    return this.enqueue(() => this.spawn(ref, options));
  }

  /**
   * Returns an entity to its pool. `delay` (seconds of GAME time — bullet time
   * slows a corpse's fade the same way it slows everything else) defers it.
   *
   * An entity that never came from a pool is simply destroyed, so gameplay code
   * can call `despawn` uniformly without knowing how the thing was made.
   */
  despawn(entity, delay = 0) {
    if (!entity || entity.pooled) return false;
    if (delay > 0) {
      if (this.timers.some((t) => t.entity === entity)) return true;
      this.timers.push({ entity, remaining: delay });
      return true;
    }
    const engine = this.engine;
    const bucket = entity._poolGuid ? this.buckets.get(entity._poolGuid) : null;
    if (!bucket) {
      engine.destroyEntity(entity);
      return true;
    }
    bucket.active.delete(entity);
    return engine.batchHierarchy(() => {
      // Announced BEFORE the teardown, while the subtree is still whole and
      // still findable: systems that hold per-entity resources (a physics body)
      // have to be able to look the entity up in order to free them. The
      // mirror of `entity-spawned`, and the reason a parked crate does not go
      // on blocking the corridor it died in.
      engine.emit("entity-despawned", entity);
      this.#park(entity, bucket);
      engine.emit("hierarchy-changed");
      return true;
    });
  }

  /**
   * Fills a pool ahead of time, spread across frames. Awaiting it is the point:
   * a loading screen can hold until the pool is warm instead of the first wave
   * of enemies costing forty instantiations in one frame.
   *
   * Instances are created and parked without ever being spawned, so prewarming
   * never runs a frame of gameplay — an enemy's `onStart` firing (and its
   * `onDestroy` right behind it) while the level is still loading would be a
   * genuinely confusing thing for a pool to do.
   */
  async prewarm(ref, count = 1, options = {}) {
    const guid = this.#guidOf(ref);
    if (!guid) {
      console.warn(`prewarm: prefab not found (${typeof ref === "string" ? ref : JSON.stringify(ref)})`);
      return 0;
    }
    const bucket = this.#bucket(guid);
    const wanted = Math.max(0, Math.floor(count) - bucket.free.length);
    const made = await Promise.all(
      Array.from({ length: wanted }, () =>
        this.enqueue(() =>
          this.engine.batchHierarchy(() => {
            const entity = this.#create(bucket, options.parent ?? null);
            if (entity) this.#park(entity, bucket);
            return !!entity;
          }),
        ),
      ),
    );
    return made.filter(Boolean).length;
  }

  /** How many instances of `ref` are parked and ready. */
  free(ref) {
    const guid = this.#guidOf(ref);
    return guid ? (this.buckets.get(guid)?.free.length ?? 0) : 0;
  }

  /** Per-prefab counters, keyed by prefab path where one is known. */
  stats() {
    const out = {};
    for (const [guid, bucket] of this.buckets) {
      out[prefabRegistry.pathOf(guid) ?? guid] = {
        free: bucket.free.length,
        active: bucket.active.size,
        created: bucket.created,
        reused: bucket.reused,
        peak: bucket.peak,
      };
    }
    return out;
  }

  /** Total parked instances across every pool (the stats overlay's number). */
  get size() {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.free.length;
    return total;
  }

  /**
   * Destroys parked instances for one prefab (or all of them), leaving live
   * ones alone. Counters survive — they describe the session, not the stock.
   */
  clear(ref = null) {
    const guids = ref ? [this.#guidOf(ref)].filter(Boolean) : [...this.buckets.keys()];
    for (const guid of guids) {
      const bucket = this.buckets.get(guid);
      if (!bucket) continue;
      for (const entity of bucket.free.splice(0)) {
        // Back into the registry first: `destroyEntity` unregisters by id and
        // detaches from a parent, and a pooled entity has neither.
        this.#reattach(entity, null);
        this.engine.destroyEntity(entity);
      }
    }
  }

  /** Forgets everything: parked instances destroyed, queue cancelled, counters gone. */
  reset() {
    this.clear();
    this.buckets.clear();
    this.timers = [];
    const queued = this.queue.splice(0);
    for (const item of queued) item.resolve(null);
  }

  /** Drops a destroyed entity from its bucket's bookkeeping. */
  forget(entity) {
    const bucket = entity?._poolGuid ? this.buckets.get(entity._poolGuid) : null;
    if (!bucket) return;
    bucket.active.delete(entity);
    const index = bucket.free.indexOf(entity);
    if (index !== -1) bucket.free.splice(index, 1);
    const timer = this.timers.findIndex((t) => t.entity === entity);
    if (timer !== -1) this.timers.splice(timer, 1);
  }

  // ---- the spawn queue -----------------------------------------------------

  /** Queues `fn` against the frame budget; resolves with whatever it returns. */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ run: fn, resolve, reject });
    });
  }

  /** Items still waiting for a slot in the budget. */
  get pending() {
    return this.queue.length;
  }

  /**
   * Runs as much queued work as fits in this frame's budget. Called from the
   * engine tick with wall-clock time — see the header for why not game time.
   */
  drain() {
    if (!this.queue.length) return 0;
    const started = performance.now();
    let done = 0;
    // `do` rather than `while`: the first item always runs, so a prefab that
    // costs more than the whole budget still makes progress instead of being
    // re-deferred every frame forever.
    do {
      const item = this.queue.shift();
      try {
        item.resolve(item.run());
      } catch (error) {
        item.reject(error);
      }
      done++;
    } while (this.queue.length && performance.now() - started < this.budgetMs);
    return done;
  }

  /** Advances pending timed despawns. Game time, so a pause holds them. */
  update(dt) {
    if (!this.timers.length || !(dt > 0)) return;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const timer = this.timers[i];
      timer.remaining -= dt;
      if (timer.remaining > 0) continue;
      this.timers.splice(i, 1);
      // Could have been destroyed outright in the meantime.
      if (this.engine.entities.has(timer.entity.id)) this.despawn(timer.entity);
    }
  }

  // ---- recycling internals -------------------------------------------------

  /**
   * A brand-new instance, tagged for this bucket and snapshotted if first.
   *
   * Expands the prefab directly rather than going through `engine.instantiate`,
   * which announces `entity-spawned` as soon as it returns — a pooled spawn is
   * not finished at that point (the reset components are still to come), and a
   * physics body built against a half-restored instance is exactly the kind of
   * one-frame wrongness nobody can reproduce.
   */
  #create(bucket, parent) {
    const guid = bucket.guid;
    const entity = instantiatePrefabNode(
      this.engine,
      { prefab: { guid, path: prefabRegistry.pathOf(guid) } },
      parent,
    );
    if (!entity) return null;
    bucket.created++;
    // Taken before any spawn option is applied, so the template describes the
    // prefab rather than wherever the first bullet happened to be fired.
    bucket.template ??= snapshot(entity);
    entity._poolGuid = bucket.guid;
    return entity;
  }

  /** Tears an instance down to parked state and files it under its bucket. */
  #park(entity, bucket) {
    // Torn down while the entity is still in the tree, the same order
    // `destroyEntity` uses: a script's `onDestroy` should see a live scene.
    this.#removeResetComponents(entity);
    entity.traverse((e) => {
      for (const component of e.components.values()) component.setEnabledOverride(false);
    });
    this.#detach(entity);
    bucket.free.push(entity);
  }

  /**
   * Restores a parked instance to its template and puts it back in the world.
   * Returns false when the instance no longer matches the template, in which
   * case the caller destroys it — see the header on structural edits.
   */
  #recycle(entity, bucket, parent) {
    if (!bucket.template) return false;
    if (!this.#restore(entity, bucket.template)) return false;
    this.#reattach(entity, parent);
    return true;
  }

  /** Walks live subtree and template in lockstep, writing only differences. */
  #restore(entity, node) {
    if (!node) return false;
    if (entity.children.length !== node.children.length) return false;

    // The template lists every component; the ones that reset were removed at
    // despawn and come back afterwards, once the entity is placed.
    const expected = node.components.filter((c) => !resetsOnRecycle(c.type));
    if (entity.components.size !== expected.length) return false;

    entity.name = node.name;
    entity.setTransform(node.transform);
    entity.setViewOnly(node.viewOnly);
    entity.setTags(node.tags);
    entity.setEnabledInEditor(node.enabledInEditor);
    entity.setEnabledInGame(node.enabledInGame);
    // Cleared, not left to the next frame: both are vetoes the engine's
    // visibility resolve reads, and an instance parked while its LOD group had
    // it hidden would come back invisible and never be told otherwise.
    entity._lodHidden = false;
    entity._occluded = false;

    for (const { type, props } of expected) {
      const component = entity.getComponent(type);
      if (!component) return false;
      component.setEnabledOverride(null);
      for (const [key, value] of Object.entries(props)) {
        if (key === "enabled" || key === "viewOnly") {
          component.props[key] = value;
          continue;
        }
        if (!sameProp(component.props[key], value)) component.setProp(key, value);
      }
    }

    for (let i = 0; i < node.children.length; i++) {
      if (!this.#restore(entity.children[i], node.children[i])) return false;
    }
    return true;
  }

  /** Removes every `resetOnStop` component in the subtree (despawn side). */
  #removeResetComponents(entity) {
    entity.traverse((e) => {
      for (const type of [...e.components.keys()]) {
        if (resetsOnRecycle(type)) e.removeComponent(type);
      }
    });
  }

  /** Re-adds them from the template (spawn side), in template order. */
  #addResetComponents(entity, node) {
    if (!node) return;
    for (const { type, props } of node.components) {
      if (!resetsOnRecycle(type) || entity.components.has(type)) continue;
      try {
        entity.addComponent(type, cloneProps(props));
      } catch (error) {
        console.warn(`Pool: couldn't restore "${type}" on ${entity.name}: ${error.message}`);
      }
    }
    for (let i = 0; i < node.children.length && i < entity.children.length; i++) {
      this.#addResetComponents(entity.children[i], node.children[i]);
    }
  }

  /** Takes a subtree out of the world without destroying it. */
  #detach(entity) {
    const engine = this.engine;
    if (entity.parent) {
      const index = entity.parent.children.indexOf(entity);
      if (index !== -1) entity.parent.children.splice(index, 1);
      entity.parent.object3D.remove(entity.object3D);
      entity.parent = null;
    } else {
      const index = engine.rootEntities.indexOf(entity);
      if (index !== -1) engine.rootEntities.splice(index, 1);
      engine.scene.remove(entity.object3D);
    }
    entity.traverse((e) => {
      engine.entities.delete(e.id);
      e.pooled = true;
    });
  }

  /** The mirror of `#detach`: back into the registry and into the tree. */
  #reattach(entity, parent) {
    const engine = this.engine;
    entity.traverse((e) => {
      engine.entities.set(e.id, e);
      e.pooled = false;
    });
    entity.setParent(parent ?? null);
  }
}
