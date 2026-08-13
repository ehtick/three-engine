/**
 * EventEmitter runtime behavior — the super-events-style additions
 * (once/emitAsync/callAll/callAllAsync/callFirst/callFirstAsync/clear) on
 * top of the original sync on/off/emit. `Engine` and `InputManager` both
 * extend this class and get all of it for free, so testing the base class
 * directly covers both without booting a full engine.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import {
  normalizeEventCatalog,
  generateEventTypes,
  serializeEventCatalog,
  RESERVED_EVENT_NAMES,
} from "../src/engine/events/catalog.js";
import { EventRegistry } from "../src/engine/events/EventRegistry.js";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const asyncCheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

check("on/emit delivers args to every listener", () => {
  const e = new EventEmitter();
  const seen = [];
  e.on("x", (a, b) => seen.push([a, b]));
  e.on("x", (a, b) => seen.push([a, b]));
  e.emit("x", 1, 2);
  assert.deepEqual(seen, [[1, 2], [1, 2]]);
});

check("off removes a listener registered via on", () => {
  const e = new EventEmitter();
  let calls = 0;
  const fn = () => calls++;
  e.on("x", fn);
  e.off("x", fn);
  e.emit("x");
  assert.equal(calls, 0);
});

check("the Unsub returned by on() removes it", () => {
  const e = new EventEmitter();
  let calls = 0;
  const unsub = e.on("x", () => calls++);
  unsub();
  e.emit("x");
  assert.equal(calls, 0);
});

check("once fires exactly once", () => {
  const e = new EventEmitter();
  let calls = 0;
  e.once("x", () => calls++);
  e.emit("x");
  e.emit("x");
  e.emit("x");
  assert.equal(calls, 1);
});

check("once's Unsub cancels it before it ever fires", () => {
  const e = new EventEmitter();
  let calls = 0;
  const unsub = e.once("x", () => calls++);
  unsub();
  e.emit("x");
  assert.equal(calls, 0);
});

check("off(event, originalFn) also removes a once-registered listener", () => {
  const e = new EventEmitter();
  let calls = 0;
  const fn = () => calls++;
  e.once("x", fn);
  e.off("x", fn);
  e.emit("x");
  assert.equal(calls, 0);
});

check("callAll collects return values in registration order", () => {
  const e = new EventEmitter();
  e.on("x", () => 1);
  e.on("x", () => 2);
  e.on("x", () => 3);
  assert.deepEqual(e.callAll("x"), [1, 2, 3]);
});

check("callAll on an event with no listeners returns []", () => {
  const e = new EventEmitter();
  assert.deepEqual(e.callAll("nope"), []);
});

check("callAll throws if a listener returns a Promise", () => {
  const e = new EventEmitter();
  e.on("x", async () => 1);
  assert.throws(() => e.callAll("x"), /callAllAsync/);
});

check("callFirst returns the first non-nullish return value", () => {
  const e = new EventEmitter();
  e.on("x", () => null);
  e.on("x", () => undefined);
  e.on("x", () => 42);
  e.on("x", () => 99);
  assert.equal(e.callFirst("x"), 42);
});

check("callFirst returns undefined when every listener returns nullish", () => {
  const e = new EventEmitter();
  e.on("x", () => null);
  e.on("x", () => undefined);
  assert.equal(e.callFirst("x"), undefined);
});

check("callFirst throws if a listener returns a Promise", () => {
  const e = new EventEmitter();
  e.on("x", async () => 1);
  assert.throws(() => e.callFirst("x"), /callFirstAsync/);
});

check("clear(event) removes only that event's listeners", () => {
  const e = new EventEmitter();
  let xCalls = 0;
  let yCalls = 0;
  e.on("x", () => xCalls++);
  e.on("y", () => yCalls++);
  e.clear("x");
  e.emit("x");
  e.emit("y");
  assert.equal(xCalls, 0);
  assert.equal(yCalls, 1);
});

check("clear() with no argument removes every listener on every event", () => {
  const e = new EventEmitter();
  let calls = 0;
  e.on("x", () => calls++);
  e.on("y", () => calls++);
  e.clear();
  e.emit("x");
  e.emit("y");
  assert.equal(calls, 0);
});

await asyncCheck("emitAsync awaits every async listener before resolving", async () => {
  const e = new EventEmitter();
  const order = [];
  e.on("x", async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("slow");
  });
  e.on("x", () => order.push("fast"));
  await e.emitAsync("x");
  assert.ok(order.includes("slow") && order.includes("fast"), "both listeners ran");
  assert.equal(order.length, 2, "emitAsync did not resolve early");
});

await asyncCheck("callAllAsync collects resolved values in registration order", async () => {
  const e = new EventEmitter();
  e.on("x", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "slow";
  });
  e.on("x", () => "fast");
  const results = await e.callAllAsync("x");
  assert.deepEqual(results, ["slow", "fast"]);
});

await asyncCheck("callFirstAsync returns the first non-nullish resolved value", async () => {
  const e = new EventEmitter();
  e.on("x", async () => null);
  e.on("x", async () => 7);
  e.on("x", async () => 8);
  const first = await e.callFirstAsync("x");
  assert.equal(first, 7);
});

await asyncCheck("callFirstAsync returns undefined when every listener resolves nullish", async () => {
  const e = new EventEmitter();
  e.on("x", async () => null);
  e.on("x", async () => undefined);
  const first = await e.callFirstAsync("x");
  assert.equal(first, undefined);
});

// Entity extends EventEmitter directly (see the class doc comment in
// Entity.js) — a local, per-instance bus separate from `engine.on`/`emit`.
// The `engine` constructor arg is never touched by on/off/emit, so a stub
// is enough here.
check("Entity has its own on/off/once/emit, identical to EventEmitter", () => {
  const e = new Entity({}, { name: "Test" });
  let calls = 0;
  e.on("damaged", (amount) => (calls += amount));
  e.emit("damaged", 5);
  assert.equal(calls, 5);
});

check("two entities have independent listener sets", () => {
  const a = new Entity({}, { name: "A" });
  const b = new Entity({}, { name: "B" });
  let aCalls = 0;
  let bCalls = 0;
  a.on("damaged", () => aCalls++);
  b.on("damaged", () => bCalls++);
  a.emit("damaged", 1);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 0, "emitting on entity A must not reach entity B's listeners");
});

check("entity.callFirst works the same way as the base EventEmitter", () => {
  const e = new Entity({}, { name: "Test" });
  e.on("query", () => null);
  e.on("query", () => 7);
  assert.equal(e.callFirst("query"), 7);
});

// Component also extends EventEmitter (see the class doc comment in
// Component.js) — every component gets `changed`/`destroyed` for free,
// fired from Component.setProp and Entity.removeComponent respectively.
// A bare, unattached component (entity: null) exercises this fine since
// setProp's engine-emit calls are all optionally chained.
check("component.setProp fires local 'changed' with the key", () => {
  const c = new Component({ enabled: true });
  const seen = [];
  c.on("changed", (key) => seen.push(key));
  c.setProp("enabled", false);
  c.setProp("viewOnly", true);
  c.setProp("someProp", 1);
  assert.deepEqual(seen, ["enabled", "viewOnly", "someProp"]);
});

check("entity.removeComponent fires 'destroyed' exactly once, not on an internal rebuild", () => {
  const e = new Entity({}, { name: "Test" });
  const c = new Component({});
  let destroyedCalls = 0;
  c.on("destroyed", () => destroyedCalls++);
  // Simulate attach without going through the type registry — removeComponent
  // only needs the entity's `components` Map to hold it under a key.
  e.components.set("mock", c);
  // A default onPropChanged rebuild (detach+attach) must NOT fire "destroyed".
  c.setProp("someProp", 1);
  assert.equal(destroyedCalls, 0, "an internal rebuild is not a destroy");
  e.removeComponent("mock");
  assert.equal(destroyedCalls, 1);
});

/* -------------------------------------------------------------------------- */
/* The project event catalog                                                   */
/* -------------------------------------------------------------------------- */

check("normalizeEventCatalog accepts a bare string as a no-arg event", () => {
  const { events, errors } = normalizeEventCatalog(["wave-cleared"]);
  assert.deepEqual(errors, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "wave-cleared");
  assert.equal(events[0].scope, "global");
  assert.deepEqual(events[0].params, []);
});

check("normalizeEventCatalog reads both the array and the { events } shapes", () => {
  const bare = normalizeEventCatalog([{ name: "a" }]);
  const wrapped = normalizeEventCatalog({ events: [{ name: "a" }] });
  assert.deepEqual(bare.events, wrapped.events);
});

check("a name colliding with a built-in engine event is refused", () => {
  const { events, errors } = normalizeEventCatalog([{ name: "play-changed" }]);
  assert.equal(events.length, 0, "must not emit a duplicate interface member");
  assert.match(errors[0], /engine event/);
});

check("duplicate names are refused, the first wins", () => {
  const { events, errors } = normalizeEventCatalog([
    { name: "dup", description: "first" },
    { name: "dup", description: "second" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].description, "first");
  assert.match(errors[0], /already defined/);
});

check("a name that isn't a usable identifier is refused", () => {
  for (const bad of ["", "9lives", "has space", "-leading", "quote\"d"]) {
    const { events } = normalizeEventCatalog([{ name: bad }]);
    assert.equal(events.length, 0, `"${bad}" should have been refused`);
  }
  // ...but the shapes people actually write are all fine.
  for (const good of ["player-died", "playerDied", "player_died", "_private"]) {
    const { events } = normalizeEventCatalog([{ name: good }]);
    assert.equal(events.length, 1, `"${good}" should have been accepted`);
  }
});

check("an unknown parameter type degrades to `any` and says so", () => {
  const { events, errors } = normalizeEventCatalog([
    { name: "e", params: [{ name: "x", type: "quaternion" }] },
  ]);
  assert.equal(events[0].params[0].type, "any");
  assert.match(errors[0], /unknown type/);
});

check("an optional parameter before a required one is reordered, not emitted", () => {
  // `[a?: number, b: string]` is not a legal tuple; TypeScript's error for it
  // would point at the generated file rather than at anything the user wrote.
  const { events, errors } = normalizeEventCatalog([
    { name: "e", params: [{ name: "a", type: "number", optional: true }, { name: "b", type: "string" }] },
  ]);
  assert.deepEqual(
    events[0].params.map((p) => p.name),
    ["b", "a"],
  );
  assert.match(errors[0], /optional/);
  assert.match(generateEventTypes(events), /\[b: string, a\?: number\]/);
});

check("duplicate parameter names are refused", () => {
  const { events, errors } = normalizeEventCatalog([
    { name: "e", params: [{ name: "x", type: "number" }, { name: "x", type: "string" }] },
  ]);
  assert.equal(events[0].params.length, 1);
  assert.match(errors[0], /used twice/);
});

check("generateEventTypes writes a labelled tuple into the right event map", () => {
  const { events } = normalizeEventCatalog([
    { name: "player-died", params: [{ name: "cause", type: "string" }] },
    { name: "damaged", scope: "entity", params: [{ name: "amount", type: "number" }] },
  ]);
  const dts = generateEventTypes(events);
  assert.match(dts, /interface EngineEventMap \{/);
  assert.match(dts, /"player-died": \[cause: string\];/);
  assert.match(dts, /interface EntityEventMap \{/);
  assert.match(dts, /"damaged": \[amount: number\];/);
  // The augmentation has to target the module scripts import from, and the
  // file has to BE a module for the augmentation to apply at all.
  assert.match(dts, /declare module "engine"/);
  assert.match(dts, /export \{\};/);
});

check("generateEventTypes types every declarable parameter kind", () => {
  const { events } = normalizeEventCatalog([
    {
      name: "e",
      params: [
        { name: "n", type: "number" },
        { name: "s", type: "string" },
        { name: "b", type: "boolean" },
        { name: "v", type: "vec3" },
        { name: "c", type: "color" },
        { name: "ent", type: "entity" },
        { name: "a", type: "asset" },
        { name: "x", type: "any" },
        { name: "opt", type: "number", optional: true },
      ],
    },
  ]);
  const dts = generateEventTypes(events);
  assert.match(dts, /n: number/);
  assert.match(dts, /v: import\("three"\)\.Vector3/);
  assert.match(dts, /ent: Entity/); // resolves inside `declare module "engine"`
  assert.match(dts, /opt\?: number/);
});

check("an empty catalog still generates a valid module", () => {
  const dts = generateEventTypes([]);
  assert.doesNotMatch(dts, /declare module/);
  assert.match(dts, /export \{\};/);
  assert.match(dts, /GENERATED/);
});

check("descriptions become JSDoc so hover text works in the IDE", () => {
  const { events } = normalizeEventCatalog([
    {
      name: "e",
      description: "Fired on death.",
      params: [{ name: "cause", type: "string", description: "what killed them" }],
    },
  ]);
  const dts = generateEventTypes(events);
  assert.match(dts, /Fired on death\./);
  assert.match(dts, /@param cause what killed them/);
});

check("serializeEventCatalog round-trips through normalize unchanged", () => {
  const source = [
    { name: "a", scope: "entity", description: "d", category: "c", params: [{ name: "p", type: "vec3", optional: true, description: "pd" }] },
    { name: "b" },
  ];
  const first = normalizeEventCatalog(source).events;
  const again = normalizeEventCatalog(serializeEventCatalog(first)).events;
  assert.deepEqual(again, first);
});

check("RESERVED_EVENT_NAMES has not drifted from EngineEventMap in engine.d.ts", () => {
  // The whole point of the reserved list is to stop the codegen emitting a
  // duplicate interface member. A name added to engine.d.ts but not here would
  // be silently accepted in the panel and then break every declaration in the
  // generated file — so the two lists are checked against each other rather
  // than trusted to be maintained in step.
  const dts = readFileSync(
    new URL("../src/engine/script-types/engine.d.ts", import.meta.url),
    "utf8",
  );
  const start = dts.indexOf("export interface EngineEventMap {");
  assert.ok(start !== -1, "EngineEventMap not found in engine.d.ts");
  const body = dts.slice(start, dts.indexOf("\n  }\n", start));
  // Interface members sit at exactly 4 spaces; anything nested inside a tuple's
  // object type is deeper, and doc comments don't start with a quote.
  const declared = [...body.matchAll(/^ {4}"([^"]+)":/gm)].map((m) => m[1]);
  assert.ok(declared.length > 20, `only parsed ${declared.length} members — parser broke`);
  const missing = declared.filter((name) => !RESERVED_EVENT_NAMES.includes(name));
  assert.deepEqual(missing, [], "add these to RESERVED_EVENT_NAMES in engine/events/catalog.js");
});

/* -------------------------------------------------------------------------- */
/* EventRegistry + the emission monitor                                        */
/* -------------------------------------------------------------------------- */

check("EventRegistry exposes the loaded catalog", () => {
  const registry = new EventRegistry();
  registry.load([{ name: "a", params: [{ name: "x", type: "number" }] }, "b"]);
  assert.deepEqual(registry.list().map((e) => e.name), ["a", "b"]);
  assert.equal(registry.has("a"), true);
  assert.equal(registry.has("nope"), false);
  assert.equal(registry.get("a").params[0].name, "x");
  assert.equal(registry.get("nope"), null);
});

check("the monitor records emissions that reached NOBODY", () => {
  // The whole reason the tap runs before the no-listener early return: "I
  // emitted it and nothing happened" is the case people are actually debugging.
  const registry = new EventRegistry();
  registry.record(true);
  try {
    const bus = new EventEmitter();
    bus.emit("into-the-void", 1);
    const history = registry.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].name, "into-the-void");
    assert.equal(history[0].listeners, 0);
    assert.equal(history[0].declared, false);
  } finally {
    registry.record(false);
  }
});

check("the monitor counts listeners and flags declared events", () => {
  const registry = new EventRegistry();
  registry.load([{ name: "known" }]);
  registry.record(true);
  try {
    const bus = new EventEmitter();
    bus.on("known", () => {});
    bus.on("known", () => {});
    bus.emit("known");
    const [entry] = registry.history();
    assert.equal(entry.listeners, 2);
    assert.equal(entry.declared, true);
  } finally {
    registry.record(false);
  }
});

check("recorded arguments are summaries, not the live objects", () => {
  // The ring buffer outlives the objects that travelled through it. Holding
  // real references would pin despawned entities for the rest of the session —
  // the monitor would leak exactly what it is used to prove got destroyed.
  const registry = new EventRegistry();
  registry.record(true);
  try {
    const bus = new EventEmitter();
    const entity = { id: "e1", name: "Player", components: new Map() };
    bus.emit("spawned", entity, 42, "hi", true, null);
    const [entry] = registry.history();
    assert.equal(entry.args[0], "<Player>");
    assert.equal(typeof entry.args[0], "string", "must not retain the entity");
    assert.deepEqual(entry.args.slice(1), [42, "hi", true, null]);
  } finally {
    registry.record(false);
  }
});

check("turning the monitor off detaches the tap entirely", () => {
  const registry = new EventRegistry();
  registry.record(true);
  registry.record(false);
  assert.equal(EventEmitter.monitor, null, "a live tap taxes every emit in the app");
  assert.equal(registry.recording, false);
  new EventEmitter().emit("x");
  assert.equal(registry.history().length, 0);
});

check("the monitor's history is capped", () => {
  const registry = new EventRegistry();
  registry.record(true, { limit: 10 });
  try {
    const bus = new EventEmitter();
    for (let i = 0; i < 500; i++) bus.emit("spam", i);
    const history = registry.history();
    assert.equal(history.length, 10);
    // Keeps the NEWEST, which is what a tail is for.
    assert.equal(history.at(-1).args[0], 499);
  } finally {
    registry.record(false);
  }
});

check("listenerCount reports what emit would reach", () => {
  const e = new EventEmitter();
  assert.equal(e.listenerCount("x"), 0);
  const off = e.on("x", () => {});
  e.on("x", () => {});
  assert.equal(e.listenerCount("x"), 2);
  off();
  assert.equal(e.listenerCount("x"), 1);
});

console.log(failures ? `\n${failures} failing` : "\nall events checks passed");
process.exit(failures ? 1 : 0);
