/**
 * The wiring half of the events system: actions, and the component that runs
 * them (`EventBindingComponent`).
 *
 * Exercised against stub engine/entity objects rather than a booted engine —
 * the component only ever touches `engine.playing`, the buses, and the handful
 * of methods each action calls, and a headless WebGPU engine is both slow and
 * unavailable here. The stubs are shaped like the real thing on purpose: where
 * a test had to guess an API (`setEnabledInGame` rather than `entity.enabled`,
 * `pool.despawn` for pooled entities only), that guess was checked against the
 * real class first, because a stub that agrees with a wrong assumption tests
 * nothing.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import {
  ACTION_KINDS,
  runActions,
  resolveValue,
  remapActions,
  remapBindings,
} from "../src/engine/events/actions.js";
import { EventBindingComponent } from "../src/engine/components/EventBindingComponent.js";
import { listen, attachListeners, detachListeners } from "../src/engine/scriptRuntime/listen.js";
import { runGraph, collectTriggers, remapGraph, NODE_TYPES } from "../src/engine/events/graph.js";

let failures = 0;
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

/* -------------------------------------------------------------------------- */
/* Stubs                                                                       */
/* -------------------------------------------------------------------------- */

class StubEntity extends EventEmitter {
  constructor(engine, name = "Entity") {
    super();
    this.engine = engine;
    this.id = `e-${name}`;
    this.name = name;
    this.components = new Map();
    this.enabledInGame = true;
    this.destroyed = false;
  }
  getComponent(type) {
    return this.components.get(type) ?? null;
  }
  setEnabledInGame(v) {
    this.enabledInGame = !!v;
  }
}

class StubEngine extends EventEmitter {
  constructor() {
    super();
    this.playing = true;
    this.entities = new Map();
    this.destroyed = [];
    this.loaded = [];
    this.timers = [];
    this.events = { get: () => null };
    this.input = {
      handlers: new Map(),
      onAction(name, fn) {
        this.handlers.set(`press:${name}`, fn);
        return () => this.handlers.delete(`press:${name}`);
      },
      onRelease(name, fn) {
        this.handlers.set(`release:${name}`, fn);
        return () => this.handlers.delete(`release:${name}`);
      },
    };
    this.time = {
      after: (s, fn) => this.timers.push({ s, fn }),
      nextFrame: () => ({ then: (fn) => this.timers.push({ s: 0, fn }) }),
    };
    this.pool = {
      spawned: [],
      despawned: [],
      spawn: (ref, opts) => {
        this.pool.spawned.push({ ref, opts });
        return new StubEntity(this, "spawned");
      },
      despawn: (entity) => {
        this.pool.despawned.push(entity);
        return true;
      },
    };
    this.prefs = { values: new Map(), set(k, v) { this.values.set(k, v); } };
    this.saves = { state: { values: new Map(), set(k, v) { this.values.set(k, v); } } };
  }
  getEntity(id) {
    return this.entities.get(id) ?? null;
  }
  destroyEntity(entity) {
    entity.destroyed = true;
    this.destroyed.push(entity);
  }
  loadScene(path, opts) {
    this.loaded.push({ path, opts });
  }
  /** Runs every timer the actions queued, as a frame would. */
  flush() {
    const due = this.timers.splice(0);
    for (const t of due) t.fn();
  }
}

/** An engine, an entity carrying an `events` component, and the component. */
function scene(bindings) {
  const engine = new StubEngine();
  const self = new StubEntity(engine, "Self");
  engine.entities.set(self.id, self);
  const component = new EventBindingComponent({ bindings });
  component.entity = self;
  self.components.set("events", component);
  component.onAttach();
  return { engine, self, component };
}

/* -------------------------------------------------------------------------- */
/* Value resolution                                                            */
/* -------------------------------------------------------------------------- */

check("a plain value passes through untouched", () => {
  const ctx = { args: [1, 2] };
  assert.equal(resolveValue(42, ctx), 42);
  assert.equal(resolveValue("hello", ctx), "hello");
  assert.equal(resolveValue(true, ctx), true);
  // A literal that LOOKS numeric must not be read as an index.
  assert.equal(resolveValue("0", ctx), "0");
});

check("$0 / $1 pull the event's positional arguments", () => {
  const ctx = { args: ["fell", 7] };
  assert.equal(resolveValue("$0", ctx), "fell");
  assert.equal(resolveValue("$1", ctx), 7);
  assert.equal(resolveValue("$9", ctx), undefined);
});

check("$name pulls an argument by its catalog parameter name", () => {
  // The thing neither Godot's binds nor Unity's static argument can do.
  const ctx = { args: ["fell", 7], params: [{ name: "cause" }, { name: "amount" }] };
  assert.equal(resolveValue("$cause", ctx), "fell");
  assert.equal(resolveValue("$amount", ctx), 7);
  assert.equal(resolveValue("$nope", ctx), undefined);
});

check("$self is the entity the binding is on, and $$ escapes a literal dollar", () => {
  const self = {};
  assert.equal(resolveValue("$self", { self }), self);
  assert.equal(resolveValue("$$0", {}), "$0");
});

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

check("emit fires on the engine bus with resolved arguments", () => {
  const engine = new StubEngine();
  const seen = [];
  engine.on("player-died", (...args) => seen.push(args));
  runActions([{ type: "emit", event: "player-died", args: ["$0", "literal"] }], {
    engine,
    args: ["fell"],
  });
  assert.deepEqual(seen, [["fell", "literal"]]);
});

check("emit routes an entity-scoped event to the entity, not the engine", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Target");
  engine.entities.set(target.id, target);
  engine.events = { get: (n) => (n === "damaged" ? { scope: "entity", params: [] } : null) };
  let onEngine = 0;
  let onEntity = null;
  engine.on("damaged", () => onEngine++);
  target.on("damaged", (amount) => (onEntity = amount));
  runActions([{ type: "emit", event: "damaged", target: target.id, args: [5] }], { engine, args: [] });
  assert.equal(onEngine, 0, "a per-entity event must not reach the global bus");
  assert.equal(onEntity, 5);
});

check("call dispatches a named method to the target's scripts", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Door");
  engine.entities.set(target.id, target);
  const calls = [];
  target.components.set("script", { dispatch: (...args) => calls.push(args) });
  runActions([{ type: "call", target: target.id, method: "open", args: ["$0"] }], {
    engine,
    args: [true],
  });
  assert.deepEqual(calls, [["open", true]]);
});

check("an empty target means the entity the binding is on", () => {
  const engine = new StubEngine();
  const self = new StubEntity(engine, "Self");
  const calls = [];
  self.components.set("script", { dispatch: (...args) => calls.push(args) });
  // No `target` — this is what makes a wired-up prefab work, since a hard-coded
  // id would point at whichever copy was authored.
  runActions([{ type: "call", method: "ping" }], { engine, self, args: [] });
  assert.deepEqual(calls, [["ping"]]);
});

check("setProp writes through the component's setProp", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Lamp");
  engine.entities.set(target.id, target);
  const writes = [];
  target.components.set("light", { setProp: (k, v) => writes.push([k, v]) });
  runActions(
    [{ type: "setProp", target: target.id, component: "light", key: "intensity", value: 3 }],
    { engine, args: [] },
  );
  assert.deepEqual(writes, [["intensity", 3]]);
});

check("setActive toggles the entity's IN-GAME flag", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Wall");
  engine.entities.set(target.id, target);
  runActions([{ type: "setActive", target: target.id, mode: "disable" }], { engine, args: [] });
  assert.equal(target.enabledInGame, false);
  runActions([{ type: "setActive", target: target.id, mode: "toggle" }], { engine, args: [] });
  assert.equal(target.enabledInGame, true);
});

check("destroy parks a pooled entity and destroys a plain one", () => {
  // Destroying a pooled instance outright silently defeats the pool it came
  // from — the bucket keeps a slot for something that no longer exists.
  const engine = new StubEngine();
  const pooled = new StubEntity(engine, "Bullet");
  pooled._poolGuid = "guid-1";
  const plain = new StubEntity(engine, "Crate");
  engine.entities.set(pooled.id, pooled);
  engine.entities.set(plain.id, plain);
  runActions([{ type: "destroy", target: pooled.id }], { engine, args: [] });
  runActions([{ type: "destroy", target: plain.id }], { engine, args: [] });
  assert.deepEqual(engine.pool.despawned, [pooled]);
  assert.deepEqual(engine.destroyed, [plain]);
});

check("spawn passes parent and position as options, not as an afterthought", () => {
  const engine = new StubEngine();
  const parent = new StubEntity(engine, "Root");
  const at = new StubEntity(engine, "SpawnPoint");
  at.position = { x: 1, y: 2, z: 3 };
  engine.entities.set(parent.id, parent);
  engine.entities.set(at.id, at);
  runActions([{ type: "spawn", prefab: "p.prefab", parent: parent.id, at: at.id }], {
    engine,
    args: [],
  });
  assert.equal(engine.pool.spawned.length, 1);
  assert.equal(engine.pool.spawned[0].opts.parent, parent);
  assert.deepEqual(engine.pool.spawned[0].opts.position, { x: 1, y: 2, z: 3 });
});

check("a delayed action goes on the game-time scheduler, not a wall clock", () => {
  const engine = new StubEngine();
  let ran = 0;
  engine.on("boom", () => ran++);
  runActions([{ type: "emit", event: "boom", delay: 2 }], { engine, args: [] });
  assert.equal(ran, 0, "must not run immediately");
  assert.equal(engine.timers[0].s, 2);
  engine.flush();
  assert.equal(ran, 1);
});

check("a disabled action is skipped, and a throwing one doesn't stop the rest", () => {
  const engine = new StubEngine();
  const order = [];
  engine.on("a", () => order.push("a"));
  engine.on("c", () => order.push("c"));
  const original = ACTION_KINDS.log.run;
  ACTION_KINDS.log.run = () => {
    throw new Error("boom");
  };
  try {
    runActions(
      [
        { type: "emit", event: "a" },
        { type: "emit", event: "skipped", enabled: false },
        { type: "log", message: "explodes" },
        { type: "emit", event: "c" },
      ],
      { engine, args: [] },
    );
  } finally {
    ACTION_KINDS.log.run = original;
  }
  // One bad row in a list of four must not silently swallow the other three —
  // "the door opened but the sound didn't play" is near-impossible to diagnose.
  assert.deepEqual(order, ["a", "c"]);
});

/* -------------------------------------------------------------------------- */
/* The binding component                                                       */
/* -------------------------------------------------------------------------- */

check("an engine-event binding runs its actions", () => {
  const { engine } = scene([
    { id: "b1", when: { source: "engine", event: "wave-cleared" }, do: [{ type: "emit", event: "done" }] },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  engine.emit("wave-cleared");
  assert.equal(done, 1);
});

check("nothing fires while the editor is not playing", () => {
  // A `destroy` action triggered by an edit-mode event would eat the scene as
  // it is being built.
  const { engine } = scene([
    { id: "b1", when: { source: "engine", event: "tick" }, do: [{ type: "emit", event: "done" }] },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  engine.playing = false;
  engine.emit("tick");
  assert.equal(done, 0);
  engine.playing = true;
  engine.emit("tick");
  assert.equal(done, 1);
});

check("`once` fires one time, and re-arms on the next Play", () => {
  const { engine } = scene([
    { id: "b1", once: true, when: { source: "engine", event: "tick" }, do: [{ type: "emit", event: "done" }] },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  engine.emit("tick");
  engine.emit("tick");
  engine.emit("tick");
  assert.equal(done, 1);
  // Leaving and re-entering Play must arm it again, or a second playthrough
  // silently skips the row.
  engine.emit("play-changed", false);
  engine.emit("play-changed", true);
  engine.emit("tick");
  assert.equal(done, 2);
});

check("a disabled binding never subscribes", () => {
  const { engine } = scene([
    {
      id: "b1",
      enabled: false,
      when: { source: "engine", event: "tick" },
      do: [{ type: "emit", event: "done" }],
    },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  engine.emit("tick");
  assert.equal(done, 0);
});

check("the entity source listens on ONE entity's own bus", () => {
  const { engine, self } = scene([
    { id: "b1", when: { source: "entity", event: "damaged" }, do: [{ type: "emit", event: "hurt" }] },
  ]);
  const other = new StubEntity(engine, "Other");
  let hurt = 0;
  engine.on("hurt", () => hurt++);
  other.emit("damaged", 1);
  assert.equal(hurt, 0, "another entity's bus must not reach this binding");
  self.emit("damaged", 1);
  assert.equal(hurt, 1);
});

check("the input source binds press and release separately", () => {
  const { engine } = scene([
    { id: "b1", when: { source: "input", action: "Jump" }, do: [{ type: "emit", event: "jumped" }] },
    {
      id: "b2",
      when: { source: "input", action: "Jump", edge: "released" },
      do: [{ type: "emit", event: "landed" }],
    },
  ]);
  const seen = [];
  engine.on("jumped", () => seen.push("jumped"));
  engine.on("landed", () => seen.push("landed"));
  engine.input.handlers.get("press:Jump")();
  engine.input.handlers.get("release:Jump")();
  assert.deepEqual(seen, ["jumped", "landed"]);
});

check("a lifecycle row runs on play start, not on every event", () => {
  const engine = new StubEngine();
  engine.playing = false;
  const self = new StubEntity(engine, "Self");
  const component = new EventBindingComponent({
    bindings: [
      { id: "b1", when: { source: "lifecycle", phase: "start" }, do: [{ type: "emit", event: "began" }] },
    ],
  });
  component.entity = self;
  component.onAttach();
  let began = 0;
  engine.on("began", () => began++);
  assert.equal(began, 0, "attaching in edit mode must not fire it");
  engine.playing = true;
  engine.emit("play-changed", true);
  assert.equal(began, 1);
});

check("the event's own payload reaches the actions", () => {
  const { engine } = scene([
    {
      id: "b1",
      when: { source: "engine", event: "scored" },
      do: [{ type: "emit", event: "relay", args: ["$0", "$1"] }],
    },
  ]);
  let seen = null;
  engine.on("relay", (...args) => (seen = args));
  engine.emit("scored", 10, "bonus");
  assert.deepEqual(seen, [10, "bonus"]);
});

check("a deferred binding runs next frame, not inside the emit", () => {
  const { engine } = scene([
    {
      id: "b1",
      deferred: true,
      when: { source: "engine", event: "tick" },
      do: [{ type: "emit", event: "done" }],
    },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  engine.emit("tick");
  assert.equal(done, 0, "must not run inside the emit");
  engine.flush();
  assert.equal(done, 1);
});

check("detaching unsubscribes everything", () => {
  const { engine, component } = scene([
    { id: "b1", when: { source: "engine", event: "tick" }, do: [{ type: "emit", event: "done" }] },
  ]);
  let done = 0;
  engine.on("done", () => done++);
  component.onDetach();
  engine.emit("tick");
  assert.equal(done, 0, "a detached component must not keep reacting");
});

/* -------------------------------------------------------------------------- */
/* Entity-id remapping                                                         */
/* -------------------------------------------------------------------------- */

check("remapActions rewrites entity ids and leaves everything else alone", () => {
  const idMap = new Map([["old", "new"]]);
  const actions = [
    { type: "call", target: "old", method: "open" },
    { type: "spawn", prefab: "p", parent: "old" },
    { type: "log", message: "old" },
  ];
  const next = remapActions(actions, idMap);
  assert.equal(next[0].target, "new");
  assert.equal(next[1].parent, "new", "spawn's entity field is `parent`, not `target`");
  assert.equal(next[2].message, "old", "a message that happens to read 'old' is not an id");
  assert.equal(actions[0].target, "old", "must not mutate the caller's array");
});

check("remapActions returns the SAME array when nothing changed", () => {
  // The caller may be holding cached scene JSON about to be loaded again;
  // cloning on every load would quietly double the memory a big scene costs.
  const actions = [{ type: "call", target: "untouched" }];
  assert.equal(remapActions(actions, new Map([["other", "x"]])), actions);
  assert.equal(remapActions(actions, new Map()), actions);
});

check("remapBindings reaches ids in both the trigger and the actions", () => {
  const idMap = new Map([["a", "A"], ["b", "B"]]);
  const bindings = [
    { when: { source: "entity", target: "a", event: "x" }, do: [{ type: "call", target: "b" }] },
  ];
  const next = remapBindings(bindings, idMap);
  assert.equal(next[0].when.target, "A");
  assert.equal(next[0].do[0].target, "B");
  assert.equal(bindings[0].when.target, "a", "must not mutate the caller's data");
});

check("every action kind declares fields the inspector can render", () => {
  // The inspector generates each editor from this table, so an action added
  // without `fields` would appear in the dropdown and then render nothing.
  for (const [id, kind] of Object.entries(ACTION_KINDS)) {
    assert.ok(kind.label, `${id} has no label`);
    assert.ok(Array.isArray(kind.fields), `${id} has no fields`);
    assert.equal(typeof kind.run, "function", `${id} has no run()`);
    for (const field of kind.fields) {
      assert.ok(field.key, `${id} has a field with no key`);
      assert.ok(field.type, `${id}.${field.key} has no type`);
    }
  }
});


/* -------------------------------------------------------------------------- */
/* @listen + waitFor                                                           */
/* -------------------------------------------------------------------------- */

/** Applies the decorator the way the compiler does, so these tests exercise the
 *  real code path rather than a hand-built metadata object. */
const decorate = (proto, key, event, options) =>
  listen(event, options)(proto, key, { value: proto[key] });

check("@listen subscribes on attach and unsubscribes on detach", () => {
  const engine = new StubEngine();
  const self = new StubEntity(engine, "Self");
  class Hud {
    constructor() { this.seen = []; }
    onScore(total) { this.seen.push(total); }
  }
  decorate(Hud.prototype, "onScore", "score-changed");
  const instance = new Hud();
  instance.engine = engine;
  instance.entity = self;

  engine.emit("score-changed", 1);
  assert.deepEqual(instance.seen, [], "nothing before attach");
  attachListeners(instance);
  engine.emit("score-changed", 10);
  assert.deepEqual(instance.seen, [10]);
  detachListeners(instance);
  engine.emit("score-changed", 99);
  assert.deepEqual(instance.seen, [10], "a detached script must stop hearing events");
});

check("@listen keeps `this` bound to the instance", () => {
  const engine = new StubEngine();
  class A {
    constructor() { this.hits = 0; }
    onTick() { this.hits++; }
  }
  decorate(A.prototype, "onTick", "tick");
  const instance = new A();
  instance.engine = engine;
  attachListeners(instance);
  engine.emit("tick");
  assert.equal(instance.hits, 1, "an unbound handler would have thrown on `this`");
});

check("attaching twice does not double-subscribe", () => {
  // A stop/start cycle or a hot reload calling attach again must not make one
  // authored handler fire twice — a score that goes up by two is exactly the
  // bug hand-rolled subscribe-on-start produces, and it is invisible until
  // something counts.
  const engine = new StubEngine();
  class A {
    constructor() { this.hits = 0; }
    onTick() { this.hits++; }
  }
  decorate(A.prototype, "onTick", "tick");
  const instance = new A();
  instance.engine = engine;
  attachListeners(instance);
  attachListeners(instance);
  engine.emit("tick");
  assert.equal(instance.hits, 1);
});

check("@listen picks the bus: engine, entity and input stay independent", () => {
  const engine = new StubEngine();
  const self = new StubEntity(engine, "Self");
  const other = new StubEntity(engine, "Other");
  class A {
    constructor() { this.log = []; }
    onGlobal() { this.log.push("global"); }
    onLocal() { this.log.push("local"); }
    onJump() { this.log.push("jump"); }
  }
  decorate(A.prototype, "onGlobal", "wave-cleared");
  decorate(A.prototype, "onLocal", "damaged", { on: "entity" });
  decorate(A.prototype, "onJump", "Jump", { on: "input" });
  const instance = new A();
  instance.engine = engine;
  instance.entity = self;
  attachListeners(instance);

  other.emit("damaged");
  assert.deepEqual(instance.log, [], "another entity's bus is not this entity's");
  engine.emit("wave-cleared");
  self.emit("damaged");
  engine.input.handlers.get("press:Jump")();
  assert.deepEqual(instance.log, ["global", "local", "jump"]);
});

check("a subclass inherits its base's @listen declarations, and only its own leak", () => {
  const engine = new StubEngine();
  class Base {
    constructor() { this.log = []; }
    onBase() { this.log.push("base"); }
  }
  decorate(Base.prototype, "onBase", "a");
  class Child extends Base {
    onChild() { this.log.push("child"); }
  }
  decorate(Child.prototype, "onChild", "b");

  const child = new Child();
  child.engine = engine;
  attachListeners(child);
  engine.emit("a");
  engine.emit("b");
  assert.deepEqual(child.log, ["base", "child"]);

  // Decorating the child must not have pushed into the list it INHERITED —
  // that would subscribe every sibling class to the child's events.
  const base = new Base();
  base.engine = engine;
  attachListeners(base);
  engine.emit("b");
  assert.deepEqual(base.log, [], "a child's declaration leaked onto its base");
});

check("@listen on a field or an accessor is refused with a usable message", () => {
  assert.throws(() => listen("x")({}, "f", undefined), /field/);
  assert.throws(() => listen("x")({}, "g", { get: () => 1 }), /getter or setter/);
  assert.throws(() => listen(""), /needs an event name/);
});

check("once:true unsubscribes after the first call", () => {
  const engine = new StubEngine();
  class A {
    constructor() { this.hits = 0; }
    onBoot() { this.hits++; }
  }
  decorate(A.prototype, "onBoot", "boot", { once: true });
  const instance = new A();
  instance.engine = engine;
  attachListeners(instance);
  engine.emit("boot");
  engine.emit("boot");
  assert.equal(instance.hits, 1);
});

await asyncCheck("waitFor resolves with the event's arguments as an array", async () => {
  const engine = new StubEngine();
  const pending = engine.waitFor("player-died");
  engine.emit("player-died", "fell", 3);
  // Always an array, even for one argument: a shape that changes with the
  // payload cannot be destructured the same way twice.
  assert.deepEqual(await pending, ["fell", 3]);
  const empty = engine.waitFor("nothing-here");
  engine.emit("nothing-here");
  assert.deepEqual(await empty, []);
});

await asyncCheck("waitFor times out to null and takes its listener with it", async () => {
  const engine = new StubEngine();
  assert.equal(await engine.waitFor("never", { timeout: 0.01 }), null);
  assert.equal(engine.listenerCount("never"), 0, "a timed-out wait must not leave a listener");
});


/* -------------------------------------------------------------------------- */
/* The node graph — the three things a row list cannot express                 */
/* -------------------------------------------------------------------------- */

/** Builds a graph in the shape `flowToGraph` persists. */
const g = (nodes, edges) => ({ nodes, edges });
const node = (id, type, props = {}) => ({ id, type, props, position: { x: 0, y: 0 } });
const wire = (source, sourceHandle, target, targetHandle) => ({
  source,
  sourceHandle,
  target,
  targetHandle,
});

check("a trigger runs the action its exec wire points at", () => {
  const engine = new StubEngine();
  const graph = g(
    [node("t", "on-engine-event", { event: "go" }), node("a", "do-emit", { event: "done" })],
    [wire("t", "exec", "a", "exec")],
  );
  let done = 0;
  engine.on("done", () => done++);
  runGraph(graph, "t", { engine, args: [] });
  assert.equal(done, 1);
});

check("BRANCH picks a path from a condition — a row list cannot do this at all", () => {
  const engine = new StubEngine();
  const graph = g(
    [
      node("t", "on-engine-event", { event: "hit" }),
      node("cmp", "compare", { op: "<" }),
      node("lo", "number", { value: 20 }),
      node("br", "branch"),
      node("dead", "do-emit", { event: "died" }),
      node("hurt", "do-emit", { event: "hurt" }),
    ],
    [
      wire("t", "exec", "br", "exec"),
      wire("t", "arg0", "cmp", "a"),
      wire("lo", "out", "cmp", "b"),
      wire("cmp", "out", "br", "condition"),
      wire("br", "true", "dead", "exec"),
      wire("br", "false", "hurt", "exec"),
    ],
  );
  const seen = [];
  engine.on("died", () => seen.push("died"));
  engine.on("hurt", () => seen.push("hurt"));
  runGraph(graph, "t", { engine, args: [5] });
  runGraph(graph, "t", { engine, args: [90] });
  assert.deepEqual(seen, ["died", "hurt"]);
});

check("DATA FLOWS between actions — spawn, then act on the thing you spawned", () => {
  // The second thing rows cannot express: an action's result feeding the next.
  const engine = new StubEngine();
  const graph = g(
    [
      node("t", "on-lifecycle", { phase: "start" }),
      node("sp", "do-spawn", { prefab: "crate.prefab" }),
      node("kill", "do-destroy"),
    ],
    [wire("t", "exec", "sp", "exec"), wire("sp", "exec", "kill", "exec"), wire("sp", "spawned", "kill", "target")],
  );
  runGraph(graph, "t", { engine, args: [] });
  assert.equal(engine.pool.spawned.length, 1);
  // The destroy targeted the spawned entity, not the graph's own.
  assert.equal(engine.destroyed.length + engine.pool.despawned.length, 1);
  const killed = engine.destroyed[0] ?? engine.pool.despawned[0];
  assert.equal(killed.name, "spawned");
});

check("FAN-IN: two triggers share one chain without duplicating it", () => {
  // The third thing rows cannot express.
  const engine = new StubEngine();
  const graph = g(
    [
      node("t1", "on-engine-event", { event: "a" }),
      node("t2", "on-engine-event", { event: "b" }),
      node("shared", "do-emit", { event: "shared" }),
    ],
    [wire("t1", "exec", "shared", "exec"), wire("t2", "exec", "shared", "exec")],
  );
  let hits = 0;
  engine.on("shared", () => hits++);
  runGraph(graph, "t1", { engine, args: [] });
  runGraph(graph, "t2", { engine, args: [] });
  assert.equal(hits, 2);
});

check("an unwired input falls back to the node's own field", () => {
  // What keeps a simple node simple: wire nothing and it behaves exactly like
  // the same action in a row list.
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Lamp");
  engine.entities.set(target.id, target);
  const writes = [];
  target.components.set("light", { setProp: (k, v) => writes.push([k, v]) });
  const graph = g(
    [
      node("t", "on-lifecycle", { phase: "start" }),
      node("set", "do-setProp", { target: target.id, component: "light", key: "intensity", value: 7 }),
    ],
    [wire("t", "exec", "set", "exec")],
  );
  runGraph(graph, "t", { engine, args: [] });
  assert.deepEqual(writes, [["intensity", 7]]);
});

check("a wired input overrides the field", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "Lamp");
  engine.entities.set(target.id, target);
  const writes = [];
  target.components.set("light", { setProp: (k, v) => writes.push([k, v]) });
  const graph = g(
    [
      node("t", "on-engine-event", { event: "x" }),
      node("n", "number", { value: 3 }),
      node("set", "do-setProp", { target: target.id, component: "light", key: "intensity", value: 7 }),
    ],
    [wire("t", "exec", "set", "exec"), wire("n", "out", "set", "value")],
  );
  runGraph(graph, "t", { engine, args: [] });
  assert.deepEqual(writes, [["intensity", 3]]);
});

check("SEQUENCE runs its outputs in order", () => {
  const engine = new StubEngine();
  const graph = g(
    [
      node("t", "on-engine-event", { event: "x" }),
      node("seq", "sequence"),
      node("a", "do-emit", { event: "a" }),
      node("b", "do-emit", { event: "b" }),
      node("c", "do-emit", { event: "c" }),
    ],
    [
      wire("t", "exec", "seq", "exec"),
      wire("seq", "0", "a", "exec"),
      wire("seq", "1", "b", "exec"),
      wire("seq", "2", "c", "exec"),
    ],
  );
  const order = [];
  for (const n of ["a", "b", "c"]) engine.on(n, () => order.push(n));
  runGraph(graph, "t", { engine, args: [] });
  assert.deepEqual(order, ["a", "b", "c"]);
});

check("ONCE gates on the component's own fired set, not on the node", () => {
  // Per-instance, so the same graph on two entities does not share one node's
  // flag — which would make the second copy of a prefab silently inert.
  const engine = new StubEngine();
  const graph = g(
    [node("t", "on-engine-event", { event: "x" }), node("o", "once"), node("a", "do-emit", { event: "a" })],
    [wire("t", "exec", "o", "exec"), wire("o", "exec", "a", "exec")],
  );
  let hits = 0;
  engine.on("a", () => hits++);
  const firedA = new Set();
  const firedB = new Set();
  runGraph(graph, "t", { engine, args: [] }, firedA);
  runGraph(graph, "t", { engine, args: [] }, firedA);
  assert.equal(hits, 1, "second run through the same set is gated");
  runGraph(graph, "t", { engine, args: [] }, firedB);
  assert.equal(hits, 2, "a different instance's set is independent");
});

check("DELAY goes on the game-time scheduler", () => {
  const engine = new StubEngine();
  const graph = g(
    [
      node("t", "on-engine-event", { event: "x" }),
      node("d", "delay", { seconds: 3 }),
      node("a", "do-emit", { event: "a" }),
    ],
    [wire("t", "exec", "d", "exec"), wire("d", "exec", "a", "exec")],
  );
  let hits = 0;
  engine.on("a", () => hits++);
  runGraph(graph, "t", { engine, args: [] });
  assert.equal(hits, 0);
  assert.equal(engine.timers[0].s, 3);
  engine.flush();
  assert.equal(hits, 1);
});

check("a value feeding two inputs is evaluated once per run", () => {
  const engine = new StubEngine();
  const target = new StubEntity(engine, "T");
  engine.entities.set(target.id, target);
  let reads = 0;
  target.components.set("light", {
    setProp: () => {},
    get props() {
      reads++;
      return { intensity: 5 };
    },
  });
  const graph = g(
    [
      node("t", "on-engine-event", { event: "x" }),
      node("get", "get-prop", { component: "light", key: "intensity" }),
      node("ent", "entity-ref", { entity: target.id }),
      node("cmp", "compare", { op: "==" }),
      node("br", "branch"),
      node("a", "do-emit", { event: "a" }),
    ],
    [
      wire("t", "exec", "br", "exec"),
      wire("ent", "out", "get", "target"),
      wire("get", "out", "cmp", "a"),
      wire("get", "out", "cmp", "b"),
      wire("cmp", "out", "br", "condition"),
      wire("br", "true", "a", "exec"),
    ],
  );
  let hits = 0;
  engine.on("a", () => hits++);
  runGraph(graph, "t", { engine, args: [] });
  assert.equal(hits, 1, "5 == 5 should take the true branch");
  assert.equal(reads, 1, "the get-prop node should have been evaluated once, not twice");
});

check("a data cycle resolves to null instead of recursing forever", () => {
  const engine = new StubEngine();
  const graph = g(
    [node("t", "on-engine-event", { event: "x" }), node("n", "not"), node("a", "do-emit", { event: "a" })],
    // `not` reading its own output.
    [wire("t", "exec", "a", "exec"), wire("n", "out", "n", "a")],
  );
  let hits = 0;
  engine.on("a", () => hits++);
  runGraph(graph, "t", { engine, args: [] });
  assert.equal(hits, 1, "the rest of the graph still runs");
});

check("an exec loop is bounded by a step budget rather than banned", () => {
  // A control cycle is a legal, useful pattern (a loop), so this must not hang
  // and must not refuse the shape either.
  const engine = new StubEngine();
  const graph = g(
    [node("t", "on-engine-event", { event: "x" }), node("a", "do-emit", { event: "a" })],
    [wire("t", "exec", "a", "exec"), wire("a", "exec", "a", "exec")],
  );
  let hits = 0;
  engine.on("a", () => hits++);
  runGraph(graph, "t", { engine, args: [] });
  assert.ok(hits > 0 && hits < 1000, `expected a bounded number of runs, got ${hits}`);
});

check("collectTriggers finds every entry point", () => {
  const graph = g(
    [
      node("t1", "on-engine-event", { event: "a" }),
      node("t2", "on-input", { action: "Jump" }),
      node("a", "do-emit", { event: "x" }),
    ],
    [],
  );
  assert.deepEqual(collectTriggers(graph).map((n) => n.id), ["t1", "t2"]);
});

check("remapGraph rewrites entity ids in node props", () => {
  const graph = g(
    [node("a", "do-call", { target: "old" }), node("b", "entity-ref", { entity: "old" }), node("c", "do-log", { message: "old" })],
    [],
  );
  const next = remapGraph(graph, new Map([["old", "new"]]));
  assert.equal(next.nodes[0].props.target, "new");
  assert.equal(next.nodes[1].props.entity, "new");
  assert.equal(next.nodes[2].props.message, "old", "a message reading 'old' is not an id");
  assert.equal(graph.nodes[0].props.target, "old", "must not mutate the caller's graph");
});

check("every node type declares what the editor needs to render it", () => {
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    assert.ok(def.label, `${type} has no label`);
    assert.ok(def.cat, `${type} has no category`);
    assert.ok(Array.isArray(def.inputs), `${type} has no inputs array`);
    assert.ok(Array.isArray(def.outputs), `${type} has no outputs array`);
  }
  // Every action in the shared table is reachable as a node — the property
  // that keeps rows and graph from drifting apart.
  for (const id of Object.keys(ACTION_KINDS)) {
    assert.ok(NODE_TYPES[`do-${id}`], `action "${id}" has no graph node`);
  }
});

console.log(failures ? `\n${failures} failing` : "\nall event binding checks passed");
process.exit(failures ? 1 : 0);
