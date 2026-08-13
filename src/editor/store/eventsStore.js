// @ts-check
import { create } from "zustand";
import { vmSingleton, oncePerVm } from "../singleton.js";
import { engine, ensureEngine } from "../engineInstance.js";
import { serializeEventCatalog, eventNameError } from "../../engine/events/catalog.js";

/**
 * Editor mirror of `engine.events` — the project's event catalog.
 *
 * Same contract as `inputStore`: the live engine registry is the source of
 * truth, edits are pushed to it immediately so the rest of the editor sees them
 * without a save, and an explicit Save commits to `project.json` *and*
 * regenerates the declarations that make the names type-checked in scripts.
 *
 * Living edits matter more here than they do for input. The catalog is what
 * every future event dropdown reads, so an event that only existed after a save
 * would be an event you couldn't wire up in the same sitting as you created it.
 */

/**
 * True while `patch` is pushing its own edit into the engine.
 *
 * `applyEvents` emits `events-changed`, which this store subscribes to in order
 * to notice catalogs loaded by *anything else* (project open, an MCP op, a live
 * update). Without this guard that echo re-hydrates from the engine on every
 * keystroke — which clears `dirty`, so the Save button never lights up, and
 * clears the selection, so the row being edited deselects itself mid-word.
 */
let applyingLocally = false;

/**
 * The live engine.
 *
 * Deliberately the shared proxy rather than a module-level `let` filled in from
 * `ensureEngine().then(...)`. The store itself is a `vmSingleton`, so a second
 * evaluation of this module (Vite serves a touched file as both `foo.js` and
 * `foo.js?t=…`) gets the SAME store object but its own module scope — and a
 * cached-engine variable in that second copy is never assigned. Every action
 * would then early-return on `if (!engine)` and the panel's buttons would
 * silently do nothing, which is the exact failure mode the vmSingleton rules
 * exist to prevent. `inputStore.js` still has the cached-variable shape.
 */
const live = () => engine;

export const useEventsStore = vmSingleton("eventsStore", () => create((set, get) => ({
  /** @type {any[]} */ events: [],
  /** @type {string[]} */ errors: [],
  /** @type {string | null} */ selected: null,
  filter: "",
  dirty: false,
  saving: false,

  /* ---- monitor --------------------------------------------------------- */
  monitoring: false,
  /** @type {any[]} */ emissions: [],

  /** Re-reads the catalog from the live engine. */
  hydrate() {
    const events = live().events?.list?.();
    if (!events) return;
    const selected = get().selected;
    set({
      events,
      dirty: false,
      // Keep the selection when the event survived the reload; a project switch
      // drops it because the name now means something else (or nothing).
      selected: events.some((/** @type {any} */ e) => e.name === selected) ? selected : null,
    });
  },

  setFilter(filter) {
    set({ filter });
  },

  select(name) {
    set({ selected: name });
  },

  /**
   * Applies an edit to the working catalog and pushes it to the live engine.
   *
   * `updater` receives a deep copy and returns the next list. Validation errors
   * come back from the engine (one code path for "is this catalog usable",
   * shared with boot) and are surfaced in the panel rather than thrown.
   */
  patch(updater) {
    const engine = live();
    if (!engine.events) return;
    const next = updater(structuredClone(engine.events.list()));
    if (!next) return;
    applyingLocally = true;
    try {
      const errors = engine.applyEvents(next);
      set({ events: engine.events.list(), errors, dirty: true });
    } finally {
      applyingLocally = false;
    }
  },

  /** Adds an event with a unique default name and selects it. */
  add() {
    let name = "my-event";
    const taken = get().events.map((/** @type {any} */ e) => e.name);
    for (let i = 2; taken.includes(name); i++) name = `my-event-${i}`;
    get().patch((events) => [...events, { name, scope: "global", params: [] }]);
    set({ selected: name });
  },

  remove(name) {
    get().patch((events) => events.filter((/** @type {any} */ e) => e.name !== name));
    if (get().selected === name) set({ selected: null });
  },

  duplicate(name) {
    const source = get().events.find((/** @type {any} */ e) => e.name === name);
    if (!source) return;
    let copy = `${name}-copy`;
    const taken = get().events.map((/** @type {any} */ e) => e.name);
    for (let i = 2; taken.includes(copy); i++) copy = `${name}-copy-${i}`;
    get().patch((events) => [...events, { ...structuredClone(source), name: copy }]);
    set({ selected: copy });
  },

  /** Merges `changes` into one event. Use `rename` to change the name. */
  update(name, changes) {
    get().patch((events) =>
      events.map((/** @type {any} */ e) => (e.name === name ? { ...e, ...changes } : e)),
    );
  },

  /**
   * Renames an event in the catalog. Script sources are NOT touched here — the
   * panel asks first, then calls `renameEventInScripts`, because rewriting
   * someone's files is not something a text field should do on blur.
   *
   * @returns an error string when the new name is unusable, else null.
   */
  rename(oldName, newName) {
    const value = String(newName ?? "").trim();
    if (value === oldName) return null;
    const others = get()
      .events.map((/** @type {any} */ e) => e.name)
      .filter((/** @type {string} */ n) => n !== oldName);
    const error = eventNameError(value, others);
    if (error) return error;
    get().patch((events) =>
      events.map((/** @type {any} */ e) => (e.name === oldName ? { ...e, name: value } : e)),
    );
    if (get().selected === oldName) set({ selected: value });
    return null;
  },

  /* ---- parameters ------------------------------------------------------ */

  addParam(eventName) {
    get().patch((events) =>
      events.map((/** @type {any} */ e) => {
        if (e.name !== eventName) return e;
        const params = [...(e.params ?? [])];
        let name = "value";
        for (let i = 2; params.some((p) => p.name === name); i++) name = `value${i}`;
        params.push({ name, type: "number" });
        return { ...e, params };
      }),
    );
  },

  updateParam(eventName, index, changes) {
    get().patch((events) =>
      events.map((/** @type {any} */ e) => {
        if (e.name !== eventName) return e;
        const params = [...(e.params ?? [])];
        if (!params[index]) return e;
        params[index] = { ...params[index], ...changes };
        return { ...e, params };
      }),
    );
  },

  removeParam(eventName, index) {
    get().patch((events) =>
      events.map((/** @type {any} */ e) =>
        e.name === eventName
          ? { ...e, params: (e.params ?? []).filter((/** @type {any} */ _p, i) => i !== index) }
          : e,
      ),
    );
  },

  moveParam(eventName, index, delta) {
    get().patch((events) =>
      events.map((/** @type {any} */ e) => {
        if (e.name !== eventName) return e;
        const params = [...(e.params ?? [])];
        const target = index + delta;
        if (!params[index] || !params[target]) return e;
        [params[index], params[target]] = [params[target], params[index]];
        return { ...e, params };
      }),
    );
  },

  /* ---- persistence ----------------------------------------------------- */

  /**
   * Writes the catalog to `project.json` and regenerates the declarations.
   *
   * The generated `.d.ts` is the whole point of the panel, so it is written on
   * the same click rather than on a watcher: a user who adds an event and
   * alt-tabs to their IDE expects it to be there, and "it appears eventually"
   * is indistinguishable from "it's broken".
   */
  async commit() {
    const engine = live();
    if (!engine.events || get().saving) return;
    set({ saving: true });
    try {
      const events = serializeEventCatalog(engine.events.list());
      const { useProjectStore } = await import("./projectStore.js");
      const rootPath = useProjectStore.getState().rootPath;
      if (!rootPath) return;
      await useProjectStore.getState().updateMeta({ events });
      const { writeProjectEventTypes, syncProjectEventTypesToMonaco } = await import(
        "../projectEventTypes.js"
      );
      const generated = await writeProjectEventTypes(rootPath, events);
      await syncProjectEventTypesToMonaco(generated);
      set({ dirty: false });
    } finally {
      set({ saving: false });
    }
  },

  /** Drops uncommitted edits, restoring the catalog from `project.json`. */
  async revert() {
    const engine = live();
    if (!engine.events) return;
    const { useProjectStore } = await import("./projectStore.js");
    applyingLocally = true;
    try {
      engine.applyEvents(useProjectStore.getState().projectMeta?.events ?? []);
    } finally {
      applyingLocally = false;
    }
    set({ events: engine.events.list(), errors: [], dirty: false });
  },

  /* ---- monitor --------------------------------------------------------- */

  /**
   * Arms or disarms the emission tap. The panel turns it on when its Monitor
   * tab is shown and off when it isn't, so a normal session never pays for it.
   */
  setMonitoring(on, opts) {
    const engine = live();
    if (!engine.events) return;
    // The one path that arms the tap, so a caller can't set a limit here and
    // have a second `record(true)` elsewhere quietly reset it to the default.
    engine.events.record(!!on, opts);
    set({ monitoring: !!on, ...(on ? {} : { emissions: [] }) });
  },

  /**
   * Copies the tap's ring buffer into React state.
   *
   * Driven by a timer in the panel rather than by the tap itself — a store
   * write per emit would rerender the editor from inside `emit`, which is the
   * one place that must stay cheap.
   *
   * The `seq` comparison is what makes an idle monitor free. Dockview detaches
   * an inactive tab's element without unmounting it, so this panel keeps
   * polling for as long as it is open even when the user is looking at
   * something else; copying a 500-entry array into a new reference every tick
   * would rerender several hundred rows forever on a panel nobody can see.
   * Nothing emitted means nothing changed means no `set`.
   */
  pollEmissions() {
    const engine = live();
    if (!engine.events || !get().monitoring) return;
    const history = engine.events.history();
    const current = get().emissions;
    if (history.length === current.length && history.at(-1)?.seq === current.at(-1)?.seq) return;
    set({ emissions: [...history] });
  },

  clearEmissions() {
    live().events?.clearHistory?.();
    set({ emissions: [] });
  },
})));

// One subscription per VM — a re-evaluated copy of this module would otherwise
// attach a second `events-changed` listener to the one engine and re-hydrate on
// every change twice, growing with each hot reload. Same reasoning as
// inputStore/sceneStore.
if (oncePerVm("eventsStore.subscribe")) {
  ensureEngine().then((ready) => {
    ready.on("events-changed", () => {
      if (applyingLocally) return;
      useEventsStore.getState().hydrate();
    });
    useEventsStore.getState().hydrate();
  });
}
