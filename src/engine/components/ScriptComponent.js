// @ts-check
import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadScriptModule } from "../assetResolver.js";
import {
  runsInEditMode,
  getMenuItemDefs,
  registerMenuItem,
  unregisterMenuItemsWithPrefix,
} from "../editorBridge.js";

const RELOAD_CHECK_INTERVAL = 0.75; // seconds

/** Throws tolerated from one script hook before that script is switched off. */
const MAX_ERRORS = 3;

/** Makes each component's menu-entry ids unique so two entities carrying the
 *  same script contribute two entries instead of overwriting each other. */
let menuInstanceSeq = 0;

/**
 * Runs user scripts against this entity. One component holds a LIST of scripts
 * (PlayCanvas's model), because an entity routinely needs several unrelated
 * behaviours — health, input, a spawner — and splitting those across files is
 * how anyone actually writes gameplay code.
 *
 * The alternative would have been letting an entity hold several `script`
 * components. That is Unity's model, but `Entity.components` is a Map keyed by
 * type and `addComponent` throws on a duplicate, so it would mean teaching the
 * registry, the inspector, serialization and the prefab differ about
 * N-of-a-type. A list inside one component gets the same capability without
 * touching any of that.
 *
 * A script module default-exports a class (or plain object) with optional
 * `onStart()` / `onUpdate(dt)` / `onDestroy()` / `onHotReload(old)` hooks, plus
 * whatever hooks other systems dispatch (physics sends `onCollisionEnter` and
 * friends; the UI button sends `onClick`). Scripts get `entity` / `engine` /
 * `THREE` / `input` injected rather than importing engine internals.
 *
 * Lifecycle only runs while `engine.playing` is true — editing a scene with
 * scripts attached doesn't execute game logic. Files are still polled and
 * re-imported on change regardless of play state, so edits are picked up as
 * soon as Play starts.
 *
 * ## Edit-mode scripts
 *
 * The exception is a class marked `@executeInEditMode` (see `editorBridge.js`),
 * Unity's `[ExecuteInEditMode]`. Those get their lifecycle and an
 * `onEditorUpdate(dt)` tick while the editor is stopped, which is how a script
 * can act as an authoring tool — procedurally laying out children, keeping a
 * spline in sync, drawing gizmos. `onUpdate` still fires only while playing, so
 * gameplay code never runs against the scene you are editing.
 *
 * Two hooks are dispatched outside the running gate entirely, because they are
 * editor surface rather than behaviour: `onDrawGizmos(gizmos)` (called by the
 * editor's gizmo pass for every loaded script) and `@menuItem`-decorated
 * methods (registered as menu entries as soon as the instance exists).
 *
 * ## props shape
 *
 *   { scripts: [{ path, enabled, attributes }] }
 *
 * Array order is execution order, and it's user-visible: the inspector can
 * reorder slots. `enabled` is per script, so one behaviour can be switched off
 * without detaching the others or losing its tuned attribute values.
 */
export class ScriptComponent extends Component {
  static type = "script";
  static label = "Scripts";
  // `#setRunning(false)` calls onDestroy but keeps the instance, so without
  // this a second Play would resume the same objects with all their
  // accumulated fields. Rebuild on stop — every Play gets fresh instances.
  static resetOnStop = true;
  static defaults = { scripts: [] };
  // Rendered by the inspector's dedicated Scripts section (a repeating list of
  // slots, each with its own attributes) rather than the generic schema loop.
  static schema = [];

  /**
   * Upgrades the pre-list props shape (`{ path, attributes }`, exactly one
   * script) to `{ scripts: [...] }`.
   *
   * This has to run on prefab *definition* JSON as well as on live props, not
   * just at construction. `prefab/diff.js` derives overrides by deep-comparing
   * every key of a def's saved props against the live component's props, so a
   * legacy def paired with a migrated instance would report `path`,
   * `attributes` and `scripts` as three spurious overrides — every prefab
   * instance in the project would show up as modified. See the call in
   * `diffNode`.
   *
   * Idempotent, and returns the input untouched when there is nothing to do so
   * the common path allocates nothing.
   */
  static normalizeProps(props) {
    if (!props || !("path" in props || "attributes" in props)) return props;
    const { path, attributes, ...rest } = props;
    // An empty legacy slot (component added but no file picked yet) becomes an
    // empty list rather than a slot pointing at "".
    const scripts = path
      ? [{ path, enabled: true, attributes: attributes ?? {} }]
      : [];
    // A saved `scripts` array wins if somehow both shapes are present.
    return { ...rest, scripts: rest.scripts?.length ? rest.scripts : scripts };
  }

  constructor(props = {}) {
    super(ScriptComponent.normalizeProps(props));
  }

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    // One runtime record per props.scripts entry:
    //   { path, instance, moduleVersion, running, errors, off }
    // `off` latches a script that threw too often; `errors` counts throws.
    this.slots = [];
    this.reloadTimer = 0;
    /** In-flight `#loadSlot` promises — see `whenReady`. @type {Set<Promise<unknown>> | undefined} */
    this._pending = undefined;
    // Namespace for this component's `@menuItem` registrations, so detaching
    // retires exactly its own entries (see `#registerSlotMenuItems`).
    this._menuPrefix = `script:${++menuInstanceSeq}:`;
    // Seed from the CURRENT play state, not just from future `play-changed`
    // events: a component attached mid-play (a script added in the inspector
    // while running, or an entity spawned by `engine.instantiate` from another
    // script) would otherwise never start, because the event it is waiting for
    // already fired.
    this._playing = !!this.entity.engine.playing;
    this.unsubUpdate = this.entity.engine.onUpdate((dt) => this.#tick(dt));
    this.unsubPlayChanged = this.entity.engine.on("play-changed", (playing) =>
      this.#setRunning(playing),
    );
    this.#syncSlots();
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.#setRunning(false);
    this.unsubUpdate?.();
    this.unsubPlayChanged?.();
    if (this._menuPrefix) unregisterMenuItemsWithPrefix(this._menuPrefix);
    this.slots = [];
  }

  onPropChanged(key) {
    if (key !== "scripts") return super.onPropChanged();
    this.#syncSlots();
  }

  // ---- public API for other systems and for scripts ------------------------

  /** Live script instances, in execution order. Includes disabled ones. */
  get instances() {
    return (this.slots ?? []).map((slot) => slot.instance).filter(Boolean);
  }

  /**
   * First script instance. Kept because plenty of call sites (and user
   * scripts) reach for `component.instance` from when a component held exactly
   * one script. Prefer `getScript(name)` — with several scripts attached,
   * "the first one" is rarely what you meant.
   */
  get instance() {
    return this.slots?.find((slot) => slot.instance)?.instance ?? null;
  }

  /**
   * Looks a script up by class name (`getScript("PlayerController")`), by file
   * stem, or by full asset path. Class name is the primary key because
   * `scriptClassSync.js` keeps the default-exported class name in sync with the
   * filename, so it is the name the user sees in both places.
   */
  getScript(name) {
    if (!name) return null;
    const wanted = String(name).toLowerCase();
    for (const slot of this.slots ?? []) {
      if (!slot.instance) continue;
      const className = slot.instance.constructor?.name?.toLowerCase();
      if (className === wanted) return slot.instance;
    }
    // Fall back to path matching so `getScript("scripts/player.ts")` and
    // `getScript("player")` both work.
    for (const slot of this.slots ?? []) {
      if (!slot.instance) continue;
      const path = slot.path.toLowerCase();
      const stem = path.split(/[\\/]/).pop()?.replace(/\.(ts|js)$/, "");
      if (path === wanted || stem === wanted) return slot.instance;
    }
    return null;
  }

  /**
   * Calls `hook` on every running script that defines it, and reports whether
   * anything handled it. This is how other systems reach scripts — physics
   * sends `onCollisionEnter`, the UI button sends `onClick`:
   *
   *     entity.getComponent("script")?.dispatch("onCollisionEnter", other);
   *
   * Dispatching through here rather than poking `.instance` directly is what
   * makes every hook reach all of an entity's scripts, and it contains throws
   * so one bad script can't stop the rest from running.
   */
  dispatch(hook, ...args) {
    let handled = false;
    for (const slot of this.slots ?? []) {
      if (!slot.running || slot.off) continue;
      if (typeof slot.instance?.[hook] !== "function") continue;
      this.#safeCall(slot, hook, args);
      handled = true;
    }
    return handled;
  }

  /** Attribute descriptors declared by the script in `index` (via @attribute). */
  getAttributeDefs(index = 0) {
    return this.slots?.[index]?.instance?.constructor?.attributes ?? {};
  }

  /**
   * Like {@link dispatch}, but reaches every LOADED script rather than every
   * RUNNING one — enabled slots included even when the editor is stopped.
   *
   * This exists for editor-surface hooks (`onDrawGizmos`), which have to work
   * exactly when scripts are not running: an authoring gizmo that only appears
   * once you press Play is useless. Behaviour hooks must keep using
   * `dispatch()`, or a stopped editor would start executing gameplay.
   */
  dispatchEditor(hook, ...args) {
    let handled = false;
    for (let i = 0; i < (this.slots?.length ?? 0); i++) {
      const slot = this.slots[i];
      if (slot.off || !this.#slotEnabled(i)) continue;
      if (typeof slot.instance?.[hook] !== "function") continue;
      this.#safeCall(slot, hook, args);
      handled = true;
    }
    return handled;
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Invokes one hook with throws contained. A script that keeps throwing is
   * latched off after `MAX_ERRORS` rather than logging every frame forever —
   * an `onUpdate` that throws would otherwise produce 60 identical console
   * lines a second and bury whatever else is wrong.
   */
  #safeCall(slot, hook, args = []) {
    try {
      slot.instance[hook](...args);
      return true;
    } catch (err) {
      slot.errors = (slot.errors ?? 0) + 1;
      const where = `${slot.path} → ${hook}()`;
      if (slot.errors >= MAX_ERRORS) {
        slot.off = true;
        console.error(
          `Script "${where}" threw ${slot.errors} times — disabling it for this session. Fix the script and save to reload it.`,
          err,
        );
      } else {
        console.error(`Script "${where}" threw:`, err);
      }
      return false;
    }
  }

  /** True when this slot should be executing right now. */
  #slotEnabled(index) {
    return this.props.scripts?.[index]?.enabled !== false;
  }

  /** True when this slot's class opted into running outside play mode. */
  #slotRunsInEditMode(index) {
    return runsInEditMode(this.slots?.[index]?.instance?.constructor);
  }

  /**
   * Rebuilds this component's menu entries: one per `@menuItem`-decorated
   * method on each loaded slot, bound to that slot's instance.
   *
   * Clear-and-rebuild rather than per-slot patching because slots reorder (the
   * inspector's up/down arrows) and the id encodes the index — a targeted
   * update would leave the old index's entry behind. The list is a handful of
   * closures, so rebuilding it costs nothing.
   *
   * Ids are stable across a hot reload, so re-registering REPLACES an entry
   * instead of appending a duplicate every 0.75-second poll; without that the
   * Tools menu grows without bound while you edit a file.
   */
  #refreshMenuItems() {
    if (!this._menuPrefix) return;
    unregisterMenuItemsWithPrefix(this._menuPrefix);
    for (let i = 0; i < (this.slots?.length ?? 0); i++) {
      const slot = this.slots[i];
      const instance = slot.instance;
      if (!instance || !this.#slotEnabled(i)) continue;
      for (const [method, def] of Object.entries(getMenuItemDefs(instance.constructor))) {
        if (typeof instance[method] !== "function") continue;
        registerMenuItem(def.path, () => this.#safeCall(slot, method), {
          id: `${this._menuPrefix}${i}:${method}`,
          order: def.order,
        });
      }
    }
  }

  /**
   * Reconciles `this.slots` against `props.scripts`. Slots whose path is
   * unchanged keep their instance, so editing an attribute (or toggling a
   * neighbouring script) never reloads a module and never resets script state.
   */
  #syncSlots() {
    const desired = this.props.scripts ?? [];
    const previous = this.slots ?? [];
    // Reuse by path. Several slots may legitimately point at the same file
    // (two independent spawners from one script), so consume matches from a
    // per-path queue instead of a plain lookup.
    const reusable = new Map();
    for (const slot of previous) {
      if (!reusable.has(slot.path)) reusable.set(slot.path, []);
      reusable.get(slot.path).push(slot);
    }

    const next = [];
    for (const entry of desired) {
      const path = entry?.path ?? "";
      const reused = reusable.get(path)?.shift();
      next.push(reused ?? { path, instance: null, moduleVersion: null, running: false, errors: 0, off: false });
    }

    // Anything left unclaimed was removed or repointed — stop it properly.
    for (const leftovers of reusable.values()) {
      for (const slot of leftovers) this.#stopSlot(slot);
    }

    this.slots = next;
    for (let i = 0; i < next.length; i++) {
      const slot = next[i];
      if (!slot.path) continue;
      if (slot.instance) {
        // Same module, possibly new attribute values / enabled state.
        this.#applyAttributes(i);
        this.#reconcileSlotRunning(i);
      } else {
        this.#loadSlot(i);
      }
    }
    this.#refreshMenuItems();
  }

  /** Writes saved attribute values (falling back to defaults) onto a slot. */
  #applyAttributes(index) {
    const slot = this.slots?.[index];
    if (!slot?.instance) return;
    const saved = this.props.scripts?.[index]?.attributes ?? {};
    for (const [key, def] of Object.entries(this.getAttributeDefs(index))) {
      slot.instance[key] = saved[key] !== undefined ? saved[key] : (def.default ?? slot.instance[key]);
    }
  }

  /** Scripts are their own context: this.entity / this.engine / this.THREE / this.input. */
  #bind(instance) {
    if (!instance) return instance;
    instance.entity = this.entity;
    instance.engine = this.entity.engine;
    instance.THREE = THREE;
    instance.input = this.entity.engine.input;
    return instance;
  }

  /** Play state for the whole component; each slot also honours its own flag. */
  #setRunning(playing) {
    this._playing = playing;
    for (let i = 0; i < (this.slots?.length ?? 0); i++) this.#reconcileSlotRunning(i);
  }

  /** Starts or stops one slot so it matches play state AND its enabled flag.
   *  `@executeInEditMode` classes are "running" whether or not we're playing —
   *  that's the whole point of the marker. */
  #reconcileSlotRunning(index) {
    const slot = this.slots?.[index];
    if (!slot?.instance) return;
    const live = !!this._playing || this.#slotRunsInEditMode(index);
    const should = live && this.#slotEnabled(index) && !slot.off;
    if (should === slot.running) return;
    slot.running = should;
    // Both hooks are OPTIONAL. Calling one that isn't there throws a TypeError
    // inside #safeCall, which counts toward MAX_ERRORS — so a script defining
    // only `onUpdate` used to log an error every Play and latch itself off on
    // the third one. Guard here the way `dispatch()` and `#stopSlot` already do.
    const hook = should ? "onStart" : "onDestroy";
    if (typeof slot.instance[hook] === "function") this.#safeCall(slot, hook);
  }

  /** Runs onDestroy if needed and clears the instance. */
  #stopSlot(slot) {
    if (slot.running && typeof slot.instance?.onDestroy === "function") {
      this.#safeCall(slot, "onDestroy");
    }
    slot.running = false;
    slot.instance = null;
    slot.moduleVersion = null;
  }

  /**
   * Resolves once every slot has finished importing and been reconciled.
   *
   * Script modules load asynchronously, so an entity created *right now*
   * (`engine.instantiate` of a prefab carrying scripts) has slots but no
   * instances for a tick or two. Anything that spawns an entity and then wants
   * to talk to its scripts has to wait for this — the save system respawning a
   * prefab from a slot is the motivating case: dispatching `onLoad` before the
   * import landed silently dropped the saved state on the floor and left a
   * default-constructed enemy standing there.
   *
   * Loops rather than awaiting a single snapshot because settling one slot can
   * queue another (a reload swapping a module mid-flight).
   */
  async whenReady() {
    for (let guard = 0; guard < 100 && this._pending?.size; guard++) {
      await Promise.allSettled([...this._pending]);
    }
    return this;
  }

  async #loadSlot(index) {
    this._pending ??= new Set();
    const tracked = this.#loadSlotInner(index);
    this._pending.add(tracked);
    tracked.finally(() => this._pending.delete(tracked));
    return tracked;
  }

  async #loadSlotInner(index) {
    const generation = this.generation;
    const slot = this.slots?.[index];
    if (!slot?.path) return;
    const path = slot.path;
    try {
      const mod = await loadScriptModule(path);
      // Bail if the component was detached, or the slot list changed shape,
      // while the import was in flight.
      if (generation !== this.generation) return;
      if (this.slots?.[index] !== slot) return;
      if (mod.version === slot.moduleVersion) return;

      const wasRunning = slot.running;
      const oldInstance = slot.instance;
      const Impl = mod.default;
      slot.instance = this.#bind(typeof Impl === "function" ? new Impl() : (Impl ?? null));
      slot.moduleVersion = mod.version;
      // A successful reload clears the error latch — the user has had a chance
      // to fix whatever was throwing.
      slot.errors = 0;
      slot.off = false;
      this.#applyAttributes(index);

      // Hot swap while running: if the script defines onHotReload, hand it the
      // old instance to carry state over instead of a destroy/start cycle.
      if (wasRunning && typeof slot.instance?.onHotReload === "function") {
        slot.running = true;
        this.#safeCall(slot, "onHotReload", [oldInstance]);
        this.#refreshMenuItems();
        this.entity.engine.emit("script-loaded", this);
        return;
      }
      if (wasRunning && typeof oldInstance?.onDestroy === "function") {
        try {
          oldInstance.onDestroy();
        } catch (err) {
          console.error(`Script "${path}" threw in onDestroy during reload:`, err);
        }
      }
      slot.running = false;
      this.#reconcileSlotRunning(index);
      this.#refreshMenuItems();
      this.entity.engine.emit("script-loaded", this);
    } catch (err) {
      console.error(`Script "${path}" failed to load: ${err.message}`);
    }
  }

  #tick(dt) {
    const config = this.entity.engine.config ?? {};
    const interval = (config.scriptReloadIntervalMs ?? RELOAD_CHECK_INTERVAL * 1000) / 1000;
    // Wall clock, not game time: hot reload is editor tooling. Timing it off
    // `dt` meant pausing the game (or setting timeScale to 0) also froze the
    // reload poll, so saving a script while paused did nothing until resume.
    this.reloadTimer += this.entity.engine.unscaledDeltaTime ?? dt;
    if (this.reloadTimer >= interval) {
      this.reloadTimer = 0;
      if (config.scriptHotReload !== false) {
        for (let i = 0; i < (this.slots?.length ?? 0); i++) {
          if (this.slots[i].path) this.#loadSlot(i);
        }
      }
    }
    // Edit mode: only `@executeInEditMode` slots are running at all (see
    // `#reconcileSlotRunning`), and they get `onEditorUpdate` rather than
    // `onUpdate` — a separate hook so gameplay code can never accidentally
    // execute against the scene the user is authoring.
    //
    // The frustum gate below is deliberately skipped here. It exists to save
    // cycles on off-screen gameplay; an authoring script that stopped
    // maintaining the scene the moment you orbited away from it would just
    // read as a bug.
    if (!this._playing) {
      for (const slot of this.slots ?? []) {
        if (!slot.running || slot.off) continue;
        if (typeof slot.instance?.onEditorUpdate !== "function") continue;
        this.#safeCall(slot, "onEditorUpdate", [dt]);
      }
      return;
    }

    // View-only gate: when the entity is outside the camera frustum we pause
    // `onUpdate` so scripts idle. `onStart` / `onDestroy` still fire on
    // play-changed so a script gets a clean lifecycle when it first becomes
    // visible (or stays running if it was already visible). We never tear an
    // instance down on frustum exit — re-creating it on re-entry would dwarf
    // the saved cycles.
    if (!this.isInView()) return;
    for (const slot of this.slots ?? []) {
      if (!slot.running || slot.off) continue;
      if (typeof slot.instance?.onUpdate !== "function") continue;
      this.#safeCall(slot, "onUpdate", [dt]);
    }
  }
}
