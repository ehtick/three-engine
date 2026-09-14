// @ts-check
import { getComponentClass, registerComponent, unregisterComponent } from "./components/registry.js";
import { freeze } from "./freezeLedger.js";
import { vmState } from "./vmState.js";

/**
 * Feature packs declare components and requires/optional module ID arrays.
 * Required providers are enabled first; optional capabilities never auto-enable.
 * setup(engine, { onCleanup, signal }) returns an optional dispose() handle.
 * Register partial allocations with onCleanup(fn) before an await can fail.
 * Callbacks complement the handle, running once in reverse order on failure or
 * disposal. signal aborts when the engine is disposed during setup.
 * Existing setup(engine) definitions and flat project arrays remain compatible.
 */
// Shared across Vite /src, /@fs and HMR copies, like componentClasses.
const definitions = (globalThis.__engineModuleDefinitions ??= new Map());
const aliases = (globalThis.__engineModuleAliases ??= new Map());
const engineStates = vmState("moduleLifecycle", () => new WeakMap());
const componentLeases = vmState("moduleComponentLeases", () => new Map());
const MODULE_MARK_MS = 30;

export function resolveModuleId(id) { return aliases.get(id) ?? id; }

export function registerModuleDefinition(def) {
  if (!def?.id) throw new Error("Module definition needs an id");
  definitions.set(def.id, def);
  for (const alias of def.aliases ?? []) aliases.set(alias, def.id);
}

export function getModuleDefinition(id) { return definitions.get(resolveModuleId(id)); }

export function getModuleDefinitions() {
  return [...definitions.values()].filter(d => !aliases.has(d.id)).map(d => ({
    ...d, category: d.category ?? "Other", tags: d.tags ?? [],
    requires: d.requires ?? [], optional: d.optional ?? [],
  }));
}

function dependencies(def) {
  for (const field of ["requires", "optional"]) {
    if (def[field] !== undefined && (!Array.isArray(def[field]) ||
        def[field].some(id => typeof id !== "string" || !id))) {
      throw new Error(`Module "${def.id}" needs an array of module IDs for ${field}`);
    }
  }
  return [...new Set((def.requires ?? []).map(resolveModuleId))];
}

/** Validate the entire graph before setup; return required providers first. */
export function resolveModuleDependencies(ids = [], { ignoreUnknown = false } = {}) {
  const result = [], complete = new Set(), path = [];
  const visit = id => {
    id = resolveModuleId(id);
    if (complete.has(id)) return;
    if (path.includes(id)) throw new Error(`Module dependency cycle: ${[...path, id].join(" -> ")}`);
    const def = definitions.get(id);
    if (!def) throw new Error(`Unknown module "${id}"${path.length ? ` required by "${path.at(-1)}"` : ""}`);
    path.push(id);
    for (const dependency of dependencies(def)) visit(dependency);
    path.pop();
    complete.add(id);
    result.push(id);
  };
  for (const id of ids) {
    if (ignoreUnknown && !definitions.has(resolveModuleId(id))) continue;
    visit(id);
  }
  return result;
}

function stateOf(engine) {
  let state = engineStates.get(engine);
  if (!state) {
    state = { explicit: new Set(engine.modules.keys()), records: new Map(),
      pending: new Map(), tail: Promise.resolve(), busy: 0, disposed: false,
      disposal: null, settingUp: null };
    // Handles created before an HMR lifecycle upgrade remain explicit choices.
    for (const [id, handle] of engine.modules) state.records.set(id, {
      id, handle, requires: dependencies(definitions.get(id) ?? { id }), cleanups: [], releases: [],
    });
    engineStates.set(engine, state);
  }
  return state;
}

/** Project persistence stores these choices, never implicit providers. */
export function getExplicitEngineModules(engine) { return [...stateOf(engine).explicit]; }

/** Active direct and transitive dependents for a useful disable explanation. */
export function getEngineModuleDependents(engine, id) {
  id = resolveModuleId(id);
  const state = stateOf(engine);
  const uses = (candidate, seen = new Set()) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    const required = state.records.get(candidate)?.requires ?? [];
    return required.includes(id) || required.some(child => uses(child, seen));
  };
  return [...engine.modules.keys()].filter(candidate => candidate !== id && uses(candidate));
}

// A module owns leases, not the global registry entry. Releasing one engine
// retains another engine's class, including a newer HMR class. Restore an
// independent registration that existed before the first lease.
function acquireComponent(cls) {
  if (!cls?.type) throw new Error("Component class needs a static type");
  let lease = componentLeases.get(cls.type);
  if (!lease) {
    lease = { baseline: getComponentClass(cls.type), owners: new Map(), installed: null };
    componentLeases.set(cls.type, lease);
  }
  const token = {};
  lease.owners.set(token, cls);
  lease.installed = cls;
  registerComponent(cls);
  return () => {
    lease.owners.delete(token);
    const next = [...lease.owners.values()].at(-1) ?? lease.baseline;
    // Do not erase an independent registration made while the lease was live.
    if (getComponentClass(cls.type) === lease.installed) {
      if (next) registerComponent(next);
      else unregisterComponent(cls.type);
      lease.installed = next;
    }
    if (!lease.owners.size) componentLeases.delete(cls.type);
  };
}

/** Run every cleanup despite throws; synchronous disposers remain synchronous. */
function runCleanups(tasks) {
  const errors = [];
  let index = 0;
  const next = () => {
    while (index < tasks.length) {
      let result;
      try { result = tasks[index++](); } catch (error) { errors.push(error); continue; }
      if (result?.then) return Promise.resolve(result).catch(error => { errors.push(error); }).then(next);
    }
    if (errors.length) throw new AggregateError(errors, "Module cleanup failed");
  };
  return next();
}

function retireRecord(engine, state, record) {
  state.records.delete(record.id);
  engine.modules.delete(record.id);
  return runCleanups([
    () => record.handle?.dispose?.(),
    ...record.cleanups.splice(0).reverse(),
    ...record.releases.splice(0).reverse(),
  ]);
}

function enqueue(engine, operation) {
  const state = stateOf(engine);
  if (state.disposed) return Promise.reject(new Error("Cannot change modules on a disposed engine"));
  ++state.busy;
  const result = state.tail.then(() => {
    if (state.disposed) throw new Error("Cannot change modules on a disposed engine");
    return operation(state);
  });
  state.tail = result.then(() => { --state.busy; }, () => { --state.busy; });
  return result;
}

async function setupRecord(engine, state, id) {
  const def = definitions.get(id);
  const record = { id, handle: null, requires: dependencies(def), cleanups: [], releases: [] };
  const controller = new AbortController();
  state.settingUp = controller;
  const previousRegistrant = engine._registrant;
  const started = performance.now();
  engine._registrant = { kind: "module", id };
  try {
    for (const cls of def.components ?? []) record.releases.push(acquireComponent(cls));
    record.handle = (await freeze.runAsync(`module:setup ${id}`, () => def.setup?.(engine, {
      signal: controller.signal,
      onCleanup(fn) {
        if (typeof fn !== "function") throw new TypeError("Module onCleanup needs a function");
        record.cleanups.push(fn);
      },
    }))) ?? {};
    if (state.disposed) throw new Error(`Module "${id}" setup cancelled: engine disposed`);
    const setupMs = performance.now() - started;
    if (setupMs >= MODULE_MARK_MS) freeze.bootMark(`module: ${id}`, setupMs);
    state.records.set(id, record);
    engine.modules.set(id, record.handle);
    return record;
  } catch (error) {
    try { await retireRecord(engine, state, record); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Module "${id}" setup and rollback failed`, { cause: error }); }
    throw error;
  } finally {
    engine._registrant = previousRegistrant;
    state.settingUp = null;
  }
}

async function reconcile(engine, state, explicit) {
  const closure = resolveModuleDependencies([...explicit]);
  const created = [];
  try {
    for (const id of closure) if (!engine.modules.has(id)) created.push(await setupRecord(engine, state, id));
    if (state.disposed) throw new Error("Module setup cancelled: engine disposed");
  } catch (error) {
    try { await runCleanups(created.reverse().map(record => () => retireRecord(engine, state, record))); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Module enable and rollback failed", { cause: error }); }
    throw error;
  }
  state.explicit = explicit;
  const want = new Set(closure);
  const removed = [...state.records.values()].reverse().filter(record => !want.has(record.id));
  try { await runCleanups(removed.map(record => () => retireRecord(engine, state, record))); }
  finally { engine.emit("modules-changed"); }
}

/** Explicitly enables a module and acquires its required providers. */
export function enableEngineModule(engine, id) {
  id = resolveModuleId(id);
  const state = stateOf(engine);
  if (state.pending.has(id)) return state.pending.get(id);
  const result = enqueue(engine, async current => {
    await reconcile(engine, current, new Set([...current.explicit, id]));
    return engine.modules.get(id);
  });
  state.pending.set(id, result);
  const clear = () => { if (state.pending.get(id) === result) state.pending.delete(id); };
  result.then(clear, clear);
  return result;
}

/** Refuses required providers; disabling a parent releases unused providers. */
export function disableEngineModule(engine, id) {
  id = resolveModuleId(id);
  const state = stateOf(engine);
  // Enable after a queued disable is a new choice, not an older pending enable.
  state.pending.clear();
  return enqueue(engine, async current => {
    const dependents = getEngineModuleDependents(engine, id);
    if (dependents.length) {
      const labels = dependents.map(dependent => `"${definitions.get(dependent)?.name ?? dependent}" (${dependent})`);
      throw new Error(`Cannot disable "${id}": required by ${labels.join(", ")}`);
    }
    const explicit = new Set(current.explicit);
    explicit.delete(id);
    await reconcile(engine, current, explicit);
  });
}

/** Replaces explicit project choices; retains their required closure.
 * Unknown top-level IDs in old project arrays remain tolerated. */
export function applyEngineModules(engine, ids = []) {
  const explicit = new Set(ids.map(resolveModuleId).filter(id => definitions.has(id)));
  stateOf(engine).pending.clear();
  return enqueue(engine, state => reconcile(engine, state, explicit));
}

/** Final engine teardown. Cancels setup and rejects future enables.
 * Ordinary handles release immediately. The optional completion hook retires
 * shared engine systems after async handles and pending setup have settled. */
export function disposeEngineModules(engine, afterDispose) {
  const state = stateOf(engine);
  if (state.disposal) {
    if (!afterDispose) return state.disposal;
    return state.disposal.then(afterDispose, error => runCleanups([() => { throw error; }, afterDispose]));
  }
  state.disposed = true;
  state.settingUp?.abort();
  state.pending.clear();
  const dispose = () => {
    state.explicit.clear();
    return runCleanups([
      ...[...state.records.values()].reverse().map(record => () => retireRecord(engine, state, record)),
      ...(afterDispose ? [afterDispose] : []),
    ]);
  };
  try { state.disposal = state.busy ? state.tail.then(dispose) : Promise.resolve(dispose()); }
  catch (error) { state.disposal = Promise.reject(error); }
  return state.disposal;
}
