import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as api from "../src/engine/modules.js";
import { Engine } from "../src/engine/Engine.js";
import { Component } from "../src/engine/components/Component.js";
import { createComponent, getComponentClass, registerComponent, unregisterComponent } from "../src/engine/components/registry.js";

const { registerModuleDefinition: register, enableEngineModule: enable, disableEngineModule: disable,
  applyEngineModules: apply, disposeEngineModules: dispose, getExplicitEngineModules: explicit,
  getEngineModuleDependents: dependents, resolveModuleDependencies: closure } = api;
let serial = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function engine(t) {
  const value = { modules: new Map(), events: [], _registrant: { kind: "test" },
    emit(event) { this.events.push(event); } };
  t.after(() => dispose(value));
  return value;
}
function pack(t, options = {}) {
  const id = `module-lifecycle-${++serial}`;
  class Probe extends Component { static type = id; static defaults = { retained: true }; }
  const log = options.log ?? [];
  const def = { id, name: `Feature ${id}`, components: [Probe],
    setup() { log.push(`setup:${id}`); return { dispose() { log.push(`dispose:${id}`); } }; }, ...options };
  register(def);
  return { id, def, Probe, log };
}

test("resolves diamonds and aliases before setup; optional capabilities remain absent", async t => {
  const live = engine(t), log = [];
  const base = pack(t, { log, aliases: ["lifecycle-base-alias"] });
  const left = pack(t, { log, requires: [base.id] });
  const right = pack(t, { log, requires: ["lifecycle-base-alias"] });
  const root = pack(t, { log, requires: [left.id, right.id], optional: ["not-installed"] });
  const resolved = [base.id, left.id, right.id, root.id];
  assert.deepEqual(closure([root.id, "lifecycle-base-alias"]), resolved);
  await enable(live, root.id);
  assert.deepEqual([...live.modules.keys()], resolved);
  assert.deepEqual(explicit(live), [root.id]);
  assert.deepEqual(log, resolved.map(id => `setup:${id}`));
  assert.deepEqual(dependents(live, base.id), [left.id, right.id, root.id]);
  await disable(live, root.id);
  assert.equal(live.modules.size, 0);
  assert.deepEqual(log.slice(4), resolved.toReversed().map(id => `dispose:${id}`));
});

test("cycles, missing providers and malformed metadata fail before any setup or old teardown", async t => {
  const live = engine(t), log = [];
  const old = pack(t, { log });
  await enable(live, old.id);
  const good = pack(t, { log });
  const a = pack(t, { log }), b = pack(t, { log, requires: [a.id] });
  a.def.requires = [good.id, b.id];
  await assert.rejects(apply(live, [a.id]), error => error.message.includes(`${a.id} -> ${b.id} -> ${a.id}`));
  a.def.requires = [good.id, "missing-provider"];
  await assert.rejects(enable(live, a.id), /missing-provider.*required by/);
  a.def.requires = "not-an-array";
  await assert.rejects(enable(live, a.id), /array of module IDs/);
  assert.deepEqual(log, [`setup:${old.id}`]);
  assert.deepEqual([...live.modules.keys()], [old.id]);
  assert.equal(getComponentClass(good.id), undefined);
});

test("same pending enable shares a promise and setup across Vite module copies", async t => {
  const live = engine(t), start = deferred(), finish = deferred();
  let setups = 0;
  const p = pack(t, { aliases: ["lifecycle-pending-alias"], async setup() {
    ++setups; start.resolve(); await finish.promise; return { ready: true };
  } });
  const twin = await import("../src/engine/modules.js?lifecycle-twin");
  const first = enable(live, p.id);
  await start.promise;
  const second = twin.enableEngineModule(live, "lifecycle-pending-alias");
  assert.equal(first, second);
  finish.resolve();
  assert.equal(await first, await second);
  assert.equal(setups, 1);
  assert.deepEqual(explicit(live), [p.id]);
  assert.equal(live._registrant.kind, "test");
});

test("concurrent parents acquire one shared provider and release only unused leases", async t => {
  const live = engine(t), log = [];
  const provider = pack(t, { log });
  const a = pack(t, { log, requires: [provider.id] });
  const b = pack(t, { log, requires: [provider.id] });
  await Promise.all([enable(live, a.id), enable(live, b.id)]);
  assert.equal(log.filter(x => x === `setup:${provider.id}`).length, 1);
  await disable(live, a.id);
  assert.deepEqual([...live.modules.keys()], [provider.id, b.id]);
  await assert.rejects(disable(live, provider.id), error => error.message.includes(b.def.name));
  await disable(live, b.id);
  assert.equal(live.modules.size, 0);
});

test("explicit provider choices survive parent release, including promotion after automatic enable", async t => {
  const live = engine(t), log = [];
  const kept = pack(t, { log }), promoted = pack(t, { log }), automatic = pack(t, { log });
  const root = pack(t, { log, requires: [kept.id, promoted.id, automatic.id] });
  await enable(live, kept.id);
  await enable(live, root.id);
  await enable(live, promoted.id);
  await assert.rejects(disable(live, kept.id), /required by/);
  assert.deepEqual(explicit(live), [kept.id, root.id, promoted.id]);
  await disable(live, root.id);
  assert.deepEqual([...live.modules.keys()], [kept.id, promoted.id]);
  assert.equal(log.filter(x => x === `setup:${promoted.id}`).length, 1);
});

test("old flat arrays and replacement choices retain providers without tearing them down", async t => {
  const live = engine(t), log = [];
  const provider = pack(t, { log, aliases: ["lifecycle-legacy-provider"] });
  const root = pack(t, { log, requires: [provider.id] });
  await apply(live, ["lifecycle-legacy-provider", provider.id, root.id, "removed-plugin"]);
  assert.deepEqual(explicit(live), [provider.id, root.id]);
  const handle = live.modules.get(provider.id);
  await apply(live, [root.id]);
  assert.equal(live.modules.get(provider.id), handle);
  assert.deepEqual(explicit(live), [root.id]);
  await apply(live, [provider.id]);
  assert.equal(live.modules.get(provider.id), handle);
  assert.deepEqual(log, [`setup:${provider.id}`, `setup:${root.id}`, `dispose:${root.id}`]);
});

test("failed setup rolls back partial resources and new dependencies, retaining existing choices", async t => {
  const live = engine(t), log = [], error = new Error("allocation failed");
  const existing = pack(t, { log }), provider = pack(t, { log });
  const root = pack(t, { requires: [existing.id, provider.id], setup(e, { onCleanup }) {
    e.partial = true;
    onCleanup(() => { log.push("cleanup:partial"); delete e.partial; });
    throw error;
  } });
  await enable(live, existing.id);
  const oldHandle = live.modules.get(existing.id);
  await assert.rejects(enable(live, root.id), candidate => candidate === error);
  assert.deepEqual(explicit(live), [existing.id]);
  assert.deepEqual([...live.modules.keys()], [existing.id]);
  assert.equal(live.modules.get(existing.id), oldHandle);
  assert.equal(live.partial, undefined);
  assert.equal(getComponentClass(provider.id), undefined);
  assert.equal(getComponentClass(root.id), undefined);
  assert.deepEqual(log.slice(-2), ["cleanup:partial", `dispose:${provider.id}`]);
  root.def.setup = () => ({ recovered: true });
  assert.equal((await enable(live, root.id)).recovered, true);
});

test("a failed concurrent parent cannot erase another parent's eventual provider choice", async t => {
  const live = engine(t), log = [];
  const provider = pack(t, { log });
  const bad = pack(t, { requires: [provider.id], setup() { throw new Error("bad parent"); } });
  const good = pack(t, { requires: [provider.id] });
  const results = await Promise.allSettled([enable(live, bad.id), enable(live, good.id)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(explicit(live), [good.id]);
  assert.deepEqual([...live.modules.keys()], [provider.id, good.id]);
  assert.equal(getComponentClass(provider.id), provider.Probe);
});

test("failed rollback preserves the setup cause while still releasing all new providers", async t => {
  const live = engine(t), log = [], original = new Error("initial setup failure");
  const provider = pack(t, { log });
  const root = pack(t, { requires: [provider.id], setup(e, { onCleanup }) {
    onCleanup(() => { throw new Error("rollback failure"); });
    throw original;
  } });
  await assert.rejects(enable(live, root.id), error => error.cause === original);
  assert.deepEqual(log, [`setup:${provider.id}`, `dispose:${provider.id}`]);
  assert.equal(live.modules.size, 0);
  assert.deepEqual(explicit(live), []);
  assert.equal(getComponentClass(provider.id), undefined);
  assert.equal(getComponentClass(root.id), undefined);
});

test("enable, disable, enable ordering is not swallowed by pending deduplication", async t => {
  const live = engine(t), log = [], p = pack(t, { log });
  const first = enable(live, p.id), off = disable(live, p.id), last = enable(live, p.id);
  assert.notEqual(first, last);
  await Promise.all([first, off, last]);
  assert.deepEqual(log, [`setup:${p.id}`, `dispose:${p.id}`, `setup:${p.id}`]);
  assert.deepEqual(explicit(live), [p.id]);
});

test("throwing disposal still cleans callbacks, providers and registrations", async t => {
  const live = engine(t), log = [];
  const provider = pack(t, { log });
  const root = pack(t, { requires: [provider.id], setup(e, { onCleanup }) {
    onCleanup(() => { log.push("callback:first"); });
    onCleanup(() => { log.push("callback:last"); throw new Error("cleanup failure"); });
    return { dispose() { log.push("handle"); throw new Error("dispose failure"); } };
  } });
  await enable(live, root.id);
  await assert.rejects(disable(live, root.id), /Module cleanup failed/);
  assert.equal(live.modules.size, 0);
  assert.deepEqual(explicit(live), []);
  assert.deepEqual(log.slice(1), ["handle", "callback:last", "callback:first", `dispose:${provider.id}`]);
  assert.equal(getComponentClass(root.id), undefined);
  assert.equal(getComponentClass(provider.id), undefined);
});

test("two engines retain shared component registration until their last lease is gone", async t => {
  const first = engine(t), second = engine(t), p = pack(t);
  await Promise.all([enable(first, p.id), enable(second, p.id)]);
  await disable(first, p.id);
  assert.equal(getComponentClass(p.id), p.Probe);
  assert.equal(createComponent(p.id, {}).props.retained, true);
  await disable(second, p.id);
  assert.equal(getComponentClass(p.id), undefined);
});

test("cross-engine setup failure cannot unregister a successful engine's type", async t => {
  const first = engine(t), second = engine(t), p = pack(t);
  await enable(first, p.id);
  p.def.setup = () => { throw new Error("second engine failed"); };
  await assert.rejects(enable(second, p.id), /second engine failed/);
  assert.equal(getComponentClass(p.id), p.Probe);
});

test("leases restore older live classes and independent registry owners", async t => {
  const first = engine(t), second = engine(t), p = pack(t);
  class Baseline extends Component { static type = p.id; }
  class Replacement extends Component { static type = p.id; }
  registerComponent(Baseline);
  t.after(() => unregisterComponent(p.id));
  await enable(first, p.id);
  register({ ...p.def, components: [Replacement] });
  await enable(second, p.id);
  assert.equal(getComponentClass(p.id), Replacement);
  await disable(second, p.id);
  assert.equal(getComponentClass(p.id), p.Probe);
  await disable(first, p.id);
  assert.equal(getComponentClass(p.id), Baseline);
  await enable(first, p.id);
  registerComponent(Baseline);
  await disable(first, p.id);
  assert.equal(getComponentClass(p.id), Baseline);
});

test("engine disposal aborts pending setup and prevents queued or late module publication", async t => {
  const live = engine(t), started = deferred(), finish = deferred(), log = [];
  let signal;
  const provider = pack(t, { log });
  const root = pack(t, { requires: [provider.id], async setup(e, context) {
    signal = context.signal;
    context.onCleanup(() => { log.push("partial"); });
    started.resolve(); await finish.promise;
    return { dispose() { log.push("late handle"); } };
  } });
  const queued = pack(t, { log });
  const enabling = enable(live, root.id);
  await started.promise;
  const next = enable(live, queued.id);
  const settled = Promise.allSettled([enabling, next]);
  const disposal = dispose(live);
  assert.equal(signal.aborted, true);
  assert.equal(dispose(live), disposal);
  finish.resolve();
  await disposal;
  assert.deepEqual((await settled).map(r => r.status), ["rejected", "rejected"]);
  assert.deepEqual(log, [`setup:${provider.id}`, "late handle", "partial", `dispose:${provider.id}`]);
  assert.equal(live.modules.size, 0);
  assert.deepEqual(explicit(live), []);
  assert.equal(getComponentClass(root.id), undefined);
  await assert.rejects(enable(live, queued.id), /disposed engine/);
});

test("production Engine.dispose releases synchronous modules before renderer and is idempotent", async t => {
  const live = engine(t), log = [], provider = pack(t, { log });
  const root = pack(t, { log, requires: [provider.id] });
  await enable(live, root.id);
  Object.assign(live, { stop() {}, clear() {}, input: { detach() {} }, time: { clear() {} },
    renderOverrides: new Map(), renderer: { dispose() { log.push("renderer"); } }, _rendererRebuildSeq: 0 });
  for (const key of ["audio", "stats", "batching", "merging", "shadowMerge", "lod", "impostors", "occlusion", "decals", "pool", "paths"]) live[key] = { dispose() {} };
  const result = Engine.prototype.dispose.call(live);
  assert.deepEqual(log.slice(2), [`dispose:${root.id}`, `dispose:${provider.id}`, "renderer"]);
  assert.equal(Engine.prototype.dispose.call(live), result);
  await result;
  assert.equal(live.modules.size, 0);
});

test("production Engine.dispose waits for asynchronous module cleanup before providers and renderer", async t => {
  const live = engine(t), log = [], finish = deferred();
  const provider = pack(t, { log });
  const root = pack(t, { requires: [provider.id], setup() {
    return { async dispose() {
      log.push("async:start"); await finish.promise;
      assert.ok(live.renderer, "renderer remains usable during module cleanup");
      assert.ok(live.modules.has(provider.id), "provider remains usable during dependent cleanup");
      log.push("async:done");
    } };
  } });
  await enable(live, root.id);
  Object.assign(live, { stop() {}, clear() {}, input: { detach() {} }, time: { clear() {} },
    renderOverrides: new Map(), renderer: { dispose() { log.push("renderer"); } }, _rendererRebuildSeq: 0 });
  for (const key of ["audio", "stats", "batching", "merging", "shadowMerge", "lod", "impostors", "occlusion", "decals", "pool", "paths"]) live[key] = { dispose() {} };
  const result = Engine.prototype.dispose.call(live);
  assert.deepEqual(log, [`setup:${provider.id}`, "async:start"]);
  finish.resolve();
  await result;
  assert.deepEqual(log.slice(2), ["async:done", `dispose:${provider.id}`, "renderer"]);
  assert.equal(live.renderer, null);
});

test("editor persists explicit choices, mirrors closure and initializes new provider settings", async t => {
  const live = engine(t), applied = [], saved = [];
  const provider = pack(t, { settings: [{ key: "quality", default: 2 }], applySettings(value) { applied.push(value.quality); } });
  const root = pack(t, { requires: [provider.id] });
  const metadata = { modules: [], moduleSettings: { [provider.id]: { quality: 7 } } };
  const fixtures = { api, ensureEngine: async () => live,
    vmSingleton(_key, factory) { return factory(); },
    create(factory) {
      let value = factory();
      return { getState: () => value, setState(patch) { value = { ...value, ...patch }; } };
    },
    useProjectStore: { getState() { return { projectMeta: metadata, async updateMeta(patch) {
      saved.push(structuredClone(patch)); Object.assign(metadata, patch);
    } }; } },
  };
  globalThis.__moduleLifecycleEditor = fixtures;
  t.after(() => { delete globalThis.__moduleLifecycleEditor; });
  let source = await readFile(new URL("../src/editor/modules.js", import.meta.url), "utf8");
  source = source.replace(/^import .*;\r?\n/gm, "");
  source = source.replace(/async function engineModulesApi\(\) \{[\s\S]*?\n\}/,
    "async function engineModulesApi() { return globalThis.__moduleLifecycleEditor.api; }");
  source = "const { create, vmSingleton, useProjectStore, ensureEngine } = globalThis.__moduleLifecycleEditor;\n" + source;
  const editor = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await editor.setModuleEnabled(root.id, true);
  assert.deepEqual(metadata.modules, [root.id]);
  assert.deepEqual(editor.useModulesStore.getState(), {
    enabled: [provider.id, root.id], explicit: [root.id], requiredBy: { [provider.id]: [root.id], [root.id]: [] },
  });
  assert.deepEqual(applied, [7]);
  await editor.setModuleEnabled(provider.id, true);
  await editor.setModuleEnabled(root.id, false);
  assert.deepEqual(metadata.modules, [provider.id]);
  await Promise.all([editor.setModuleEnabled(root.id, true), editor.setModuleEnabled(root.id, false)]);
  assert.deepEqual(saved.at(-1).modules, [provider.id]);
  metadata.modules = [provider.id, root.id]; // Legacy flat list: both stay explicit.
  await editor.syncProjectModules();
  await editor.setModuleEnabled(root.id, false);
  assert.deepEqual(metadata.modules, [provider.id]);
});
