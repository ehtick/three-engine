/**
 * Object pooling + budgeted async instantiation (roadmap item 15).
 *
 * A pool is a correctness feature disguised as a performance one: the whole
 * question is whether a recycled instance is indistinguishable from a fresh
 * one, and every answer to that is a decision, not a picture. So this drives
 * the real Engine, the real prefab expander and (for the physics half) the real
 * Rapier world, with no renderer in sight.
 *
 * The physics section exists because pooling exposed a latent bug rather than
 * introducing one: the world was built exactly once, at Play, so anything
 * spawned afterwards had a Rigidbody whose body stayed null forever — and
 * anything destroyed left its collider in the world.
 */
import nodeAssert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

// Almost every operand in this file is an Entity or a Component, and node
// builds an AssertionError's message EAGERLY, inspecting both operands with
// `depth: 1000` and `getters: true`. On an entity that walks entity -> engine
// -> scene -> all of three.js, invoking every getter it passes. So a one-line
// regression does not fail the run: it kills the process twenty seconds later
// with "heap out of memory" and no clue which check was to blame — and, worse,
// every check after it goes unreported. Comparing first and describing the
// operands briefly keeps a failure a failure. Same semantics as
// `node:assert/strict` (`equal` is `strictEqual`, `deepEqual` is
// `deepStrictEqual`), only the message differs.
const brief = (value) =>
  value && typeof value === "object"
    ? inspect(value, { depth: 0, getters: false, customInspect: false, breakLength: 100 })
    : inspect(value);
const because = (message) => (message ? `${message} — ` : "");
const assert = {
  ok: nodeAssert.ok,
  rejects: nodeAssert.rejects,
  equal(actual, expected, message) {
    if (Object.is(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
  notEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) return;
    throw new Error(`${because(message)}expected anything but ${brief(expected)}`);
  },
  deepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
};

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
// Rapier's wasm-bindgen glue takes a browser path the moment `window` exists
// and then calls `window.performance.now()` — see run-physics-test.mjs.
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const {
  Engine,
  Component,
  registerBuiltInComponents,
  registerComponent,
  registerPrefabDefs,
  applyEngineModules,
  setScriptLoader,
  setSceneLoader,
  newGuid,
  newFid,
} = await import("../src/engine/index.js");
await import("../src/modules/index.js"); // registers the module catalog

registerBuiltInComponents();

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A component that counts its own lifecycle. Everything the pool promises is
 * about how often things are rebuilt, and a real component's rebuilds are
 * invisible from the outside.
 */
class ProbeComponent extends Component {
  static type = "probe";
  static label = "Probe";
  static defaults = { value: 1 };
  static schema = [{ key: "value", label: "Value", type: "number" }];
  static attaches = 0;
  static detaches = 0;
  static propWrites = 0;
  static reset() {
    ProbeComponent.attaches = 0;
    ProbeComponent.detaches = 0;
    ProbeComponent.propWrites = 0;
  }
  onAttach() {
    ProbeComponent.attaches++;
  }
  onDetach() {
    ProbeComponent.detaches++;
  }
  onPropChanged() {
    ProbeComponent.propWrites++;
  }
}

/** The same, but declaring its state to live outside props — the marker the
 *  pool reuses to decide what has to be rebuilt from scratch. */
class VolatileComponent extends ProbeComponent {
  static type = "volatile";
  static label = "Volatile";
  static resetOnStop = true;
  static defaults = { value: 1 };
  static attaches = 0;
  static detaches = 0;
  static propWrites = 0;
  onAttach() {
    VolatileComponent.attaches++;
    this.runtimeState = 0; // deliberately not in props
  }
  onDetach() {
    VolatileComponent.detaches++;
  }
}

registerComponent(ProbeComponent);
registerComponent(VolatileComponent);

/** A script that accumulates state and reports its own lifecycle. */
class Enemy {
  health = 100;
  onStart() {
    Enemy.starts++;
  }
  onDestroy() {
    Enemy.destroys++;
  }
}
Enemy.starts = 0;
Enemy.destroys = 0;
setScriptLoader(async (path) => ({ default: path === "scripts/Enemy.ts" ? Enemy : null }));

const node = (name, extra = {}) => ({
  fid: newFid(),
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components: [],
  children: [],
  ...extra,
});

const BULLET = newGuid();
const NESTED = newGuid();
const SCRIPTED = newGuid();
const PHYSICAL = newGuid();
const MODELLED = newGuid();

registerPrefabDefs([
  {
    guid: BULLET,
    path: "prefabs/Bullet.prefab",
    root: node("Bullet", {
      position: [0, 1, 0],
      components: [{ type: "probe", props: { value: 7 } }],
    }),
  },
  {
    guid: NESTED,
    path: "prefabs/Nested.prefab",
    root: node("Rig", {
      components: [{ type: "probe", props: { value: 1 } }],
      children: [node("Muzzle", { position: [0, 0, 2] })],
    }),
  },
  {
    guid: SCRIPTED,
    path: "prefabs/Enemy.prefab",
    root: node("Enemy", {
      components: [
        { type: "volatile", props: { value: 3 } },
        { type: "script", props: { scripts: [{ path: "scripts/Enemy.ts", enabled: true, attributes: {} }] } },
      ],
    }),
  },
  {
    guid: MODELLED,
    path: "prefabs/WithModel.prefab",
    root: node("Prop", {
      components: [{ type: "model", props: { path: "models/thing.glb" } }],
    }),
  },
  {
    guid: PHYSICAL,
    path: "prefabs/Crate.prefab",
    root: node("Crate", {
      components: [
        { type: "collider", props: { shape: "box", size: [1, 1, 1] } },
        { type: "rigidbody", props: { bodyType: "dynamic" } },
      ],
    }),
  },
]);

const engineOf = () => {
  const engine = new Engine();
  ProbeComponent.reset();
  VolatileComponent.reset();
  return engine;
};

/** One frame of the pool's own bookkeeping (no renderer involved). */
const frame = (engine, dt = 1 / 60) => {
  engine.pool.update(dt);
  engine.pool.drain();
};

/** Lets queued microtasks (script module imports) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

section("pool — spawn and despawn");

await check("spawn produces a live entity, registered and in the scene", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  assert.ok(bullet, "spawn returned null");
  assert.equal(engine.getEntity(bullet.id), bullet);
  assert.equal(bullet.object3D.parent, engine.scene);
  assert.equal(bullet.pooled, false);
});

await check("despawn takes it out of the world without destroying it", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  const probe = bullet.getComponent("probe");
  engine.despawn(bullet);
  assert.equal(bullet.pooled, true);
  assert.equal(engine.getEntity(bullet.id), undefined, "still registered");
  assert.equal(engine.rootEntities.includes(bullet), false, "still a root");
  assert.equal(bullet.object3D.parent, null, "still in the scene graph");
  // The component survives — that is the entire point.
  assert.equal(bullet.getComponent("probe"), probe);
  assert.equal(ProbeComponent.detaches, 0, "a parked component was torn down");
});

await check("a despawned entity is invisible to queries and to serialization", async () => {
  const { serializeScene } = await import("../src/engine/serialize.js");
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  bullet.addTag("bullet");
  engine.despawn(bullet);
  assert.deepEqual(engine.findByTag("bullet"), []);
  const json = serializeScene(engine);
  // A level saved with a warm pool must not gain two hundred invisible bullets.
  assert.equal(JSON.stringify(json).includes("Bullet"), false);
});

await check("the next spawn reuses the same entity", () => {
  const engine = engineOf();
  const first = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(first);
  const second = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(second, first, "a parked instance was not reused");
  const stats = engine.pool.stats()["prefabs/Bullet.prefab"];
  assert.equal(stats.created, 1);
  assert.equal(stats.reused, 1);
});

await check("two live spawns are two instances", () => {
  const engine = engineOf();
  const a = engine.spawn("prefabs/Bullet.prefab");
  const b = engine.spawn("prefabs/Bullet.prefab");
  assert.notEqual(a, b);
  assert.equal(engine.pool.stats()["prefabs/Bullet.prefab"].created, 2);
});

await check("reuse rebuilds nothing — the component is never re-attached", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(ProbeComponent.attaches, 1);
  for (let i = 0; i < 5; i++) {
    engine.despawn(bullet);
    engine.spawn("prefabs/Bullet.prefab");
  }
  assert.equal(ProbeComponent.attaches, 1, "recycling re-attached a component");
  assert.equal(ProbeComponent.detaches, 0);
});

await check("free() and size report the stock", () => {
  const engine = engineOf();
  const a = engine.spawn("prefabs/Bullet.prefab");
  const b = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 0);
  engine.despawn(a);
  engine.despawn(b);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 2);
  assert.equal(engine.pool.size, 2);
});

await check("despawning something that never came from a pool destroys it", () => {
  const engine = engineOf();
  const loose = engine.createEntity({ name: "Loose" });
  assert.equal(engine.despawn(loose), true);
  assert.equal(engine.getEntity(loose.id), undefined);
});

await check("despawning twice is a no-op, not a double entry in the pool", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet);
  assert.equal(engine.despawn(bullet), false);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 1);
});

await check("spawning an unknown prefab warns and returns null", () => {
  const engine = engineOf();
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    assert.equal(engine.spawn("prefabs/Nope.prefab"), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, 1);
});

section("pool — a recycled instance matches a fresh one");

await check("a bullet that flew away comes back at the prefab's transform", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  bullet.position.set(9, 50, -3);
  bullet.scale.set(4, 4, 4);
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.deepEqual(again.position.toArray(), [0, 1, 0], "authored position lost");
  assert.deepEqual(again.scale.toArray(), [1, 1, 1]);
});

await check("spawn options win over the restored transform", () => {
  const engine = engineOf();
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  const again = engine.spawn("prefabs/Bullet.prefab", { position: [5, 5, 5], name: "Shot" });
  assert.deepEqual(again.position.toArray(), [5, 5, 5]);
  assert.equal(again.name, "Shot");
});

await check("a prop the last life changed is restored", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  bullet.getComponent("probe").setProp("value", 999);
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(again.getComponent("probe").props.value, 7);
});

await check("...and props that did not change are not rewritten", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  ProbeComponent.propWrites = 0;
  for (let i = 0; i < 10; i++) {
    engine.despawn(bullet);
    engine.spawn("prefabs/Bullet.prefab");
  }
  // Ten round trips that changed nothing must cost zero component rebuilds —
  // otherwise pooling is just instantiation with extra steps.
  assert.equal(ProbeComponent.propWrites, 0);
});

await check("a name and tags set during play are restored", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  bullet.name = "Tracer";
  bullet.addTag("onfire");
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(again.name, "Bullet");
  assert.deepEqual(again.tags, []);
});

await check("a child moved by gameplay comes back where the prefab put it", () => {
  const engine = engineOf();
  const rig = engine.spawn("prefabs/Nested.prefab");
  rig.children[0].position.set(0, 0, 99);
  engine.despawn(rig);
  const again = engine.spawn("prefabs/Nested.prefab");
  assert.deepEqual(again.children[0].position.toArray(), [0, 0, 2]);
});

await check("an entity disabled during play comes back enabled", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  bullet.setEnabledInGame(false);
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(again.enabledInGame, true);
});

await check("an LOD/occlusion veto does not survive into the next life", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  // Both are written by systems that will never look at a parked entity again,
  // so an instance parked while hidden would come back invisible forever.
  bullet._lodHidden = true;
  bullet._occluded = true;
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(again._lodHidden, false);
  assert.equal(again._occluded, false);
});

await check("components are disabled while parked and live again on spawn", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet);
  assert.equal(bullet.getComponent("probe").enabled, false, "a parked component still ticks");
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.equal(again.getComponent("probe").enabled, true);
});

await check("a component whose state lives outside props IS rebuilt", () => {
  const engine = engineOf();
  const enemy = engine.spawn("prefabs/Enemy.prefab");
  enemy.getComponent("volatile").runtimeState = 42;
  const before = VolatileComponent.attaches;
  engine.despawn(enemy);
  const again = engine.spawn("prefabs/Enemy.prefab");
  assert.equal(VolatileComponent.attaches, before + 1, "resetOnStop component was not rebuilt");
  assert.equal(again.getComponent("volatile").runtimeState, 0, "runtime state leaked across lives");
  assert.equal(again.getComponent("volatile").props.value, 3);
});

await check("a parked instance holds no component that ticks", () => {
  const engine = engineOf();
  const enemy = engine.spawn("prefabs/Enemy.prefab");
  engine.despawn(enemy);
  // The script component is removed outright rather than merely disabled: its
  // update subscription lives on the engine, not on the entity.
  assert.equal(enemy.getComponent("script"), undefined);
  assert.equal(enemy.getComponent("volatile"), undefined);
});

await check("a script gets a fresh instance and a fresh onStart per spawn", async () => {
  const engine = engineOf();
  Enemy.starts = 0;
  Enemy.destroys = 0;
  engine.setPlaying(true);
  const enemy = engine.spawn("prefabs/Enemy.prefab");
  await enemy.getComponent("script").whenReady();
  await tick();
  assert.equal(Enemy.starts, 1);
  enemy.getScript("Enemy").health = 1;

  engine.despawn(enemy);
  assert.equal(Enemy.destroys, 1, "onDestroy did not fire at despawn");

  const again = engine.spawn("prefabs/Enemy.prefab");
  await again.getComponent("script").whenReady();
  await tick();
  assert.equal(again, enemy, "not the same pooled entity");
  assert.equal(Enemy.starts, 2, "onStart did not fire on respawn");
  assert.equal(again.getScript("Enemy").health, 100, "script state leaked across lives");
  engine.setPlaying(false);
});

await check("a structurally modified instance is destroyed rather than recycled", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  const id = bullet.id;
  // Gameplay bolted something on. Restoring arbitrary structural edits is a
  // scene-diffing problem; refusing to recycle keeps the guarantee absolute.
  engine.createEntity({ name: "Attachment", parent: bullet });
  engine.despawn(bullet);
  const again = engine.spawn("prefabs/Bullet.prefab");
  assert.notEqual(again.id, id, "a modified instance came back out of the pool");
  assert.equal(again.children.length, 0);
  assert.equal(engine.pool.stats()["prefabs/Bullet.prefab"].created, 2);
});

await check("...and an added component counts as structural too", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  const id = bullet.id;
  bullet.addComponent("light", {});
  engine.despawn(bullet);
  assert.notEqual(engine.spawn("prefabs/Bullet.prefab").id, id);
});

section("pool — lifetime");

await check("leaving Play destroys the stock", () => {
  const engine = engineOf();
  engine.setPlaying(true);
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  assert.equal(engine.pool.size, 1);
  engine.setPlaying(false);
  assert.equal(engine.pool.size, 0, "parked instances outlived Play");
  assert.equal(ProbeComponent.detaches, 1, "a parked instance was dropped without teardown");
});

await check("engine.clear() disposes parked instances too", () => {
  const engine = engineOf();
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  engine.clear();
  assert.equal(engine.pool.size, 0);
  assert.equal(ProbeComponent.detaches, 1);
});

await check("clear(ref) drops one prefab's stock and leaves live instances alone", () => {
  const engine = engineOf();
  const live = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  engine.pool.clear("prefabs/Bullet.prefab");
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 0);
  assert.equal(engine.getEntity(live.id), live, "a live instance was destroyed");
});

await check("a single-mode scene load empties the pool", async () => {
  setSceneLoader(async () => ({
    version: 1,
    name: "Level2",
    entities: [],
    settings: {},
  }));
  const engine = engineOf();
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  await engine.loadScene("scenes/Level2.scene");
  // A parked bullet holds geometry from the level being unloaded, and its
  // prefab may not exist in the next one.
  assert.equal(engine.pool.size, 0);
});

await check("destroying a live pooled instance keeps the counters honest", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.destroyEntity(bullet);
  assert.equal(engine.pool.stats()["prefabs/Bullet.prefab"].active, 0);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 0);
});

await check("peak records the high-water mark, not the current count", () => {
  const engine = engineOf();
  const live = [];
  for (let i = 0; i < 5; i++) live.push(engine.spawn("prefabs/Bullet.prefab"));
  for (const entity of live) engine.despawn(entity);
  const stats = engine.pool.stats()["prefabs/Bullet.prefab"];
  assert.equal(stats.peak, 5);
  assert.equal(stats.active, 0);
});

section("pool — the spawn budget");

await check("instantiateAsync waits for the queue to drain", async () => {
  const engine = engineOf();
  let resolved = null;
  const promise = engine.instantiateAsync("prefabs/Bullet.prefab").then((e) => (resolved = e));
  await tick();
  assert.equal(resolved, null, "the work ran without a frame");
  assert.equal(engine.pool.pending, 1);
  frame(engine);
  await promise;
  assert.ok(resolved, "never resolved");
  assert.equal(engine.pool.pending, 0);
});

await check("a zero budget still runs one item per frame", () => {
  const engine = engineOf();
  engine.pool.budgetMs = 0;
  for (let i = 0; i < 5; i++) engine.pool.spawnAsync("prefabs/Bullet.prefab");
  // A prefab costing more than the whole budget would otherwise be deferred
  // forever, and a queue that never drains is worse than a hitch.
  frame(engine);
  assert.equal(engine.pool.pending, 4);
  frame(engine);
  assert.equal(engine.pool.pending, 3);
});

await check("a generous budget drains the whole queue in one frame", () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  for (let i = 0; i < 20; i++) engine.pool.spawnAsync("prefabs/Bullet.prefab");
  frame(engine);
  assert.equal(engine.pool.pending, 0);
});

await check("a queued item that throws rejects its own promise and nothing else", async () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  const bad = engine.pool.enqueue(() => {
    throw new Error("boom");
  });
  const good = engine.pool.enqueue(() => 42);
  frame(engine);
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 42);
});

await check("prewarm fills the pool without putting anything in the scene", async () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  const warmed = engine.pool.prewarm("prefabs/Bullet.prefab", 8);
  for (let i = 0; i < 10 && engine.pool.pending; i++) frame(engine);
  assert.equal(await warmed, 8);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 8);
  assert.equal(engine.rootEntities.length, 0, "prewarmed instances were left in the scene");
});

await check("prewarm tops up to the count rather than adding it again", async () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  const first = engine.pool.prewarm("prefabs/Bullet.prefab", 4);
  for (let i = 0; i < 8 && engine.pool.pending; i++) frame(engine);
  await first;
  const second = engine.pool.prewarm("prefabs/Bullet.prefab", 4);
  for (let i = 0; i < 8 && engine.pool.pending; i++) frame(engine);
  assert.equal(await second, 0);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 4);
});

await check("prewarming runs no gameplay — a pooled script never starts", async () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  engine.setPlaying(true);
  Enemy.starts = 0;
  const warmed = engine.pool.prewarm("prefabs/Enemy.prefab", 3);
  for (let i = 0; i < 8 && engine.pool.pending; i++) frame(engine);
  await warmed;
  await tick();
  await tick();
  assert.equal(Enemy.starts, 0, "prewarming ran an enemy's onStart");
  engine.setPlaying(false);
});

await check("a warm pool spawns without touching the queue", () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  engine.despawn(engine.spawn("prefabs/Bullet.prefab"));
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  assert.ok(bullet);
  assert.equal(engine.pool.pending, 0);
});

await check("resetting the pool resolves queued spawns rather than hanging them", async () => {
  const engine = engineOf();
  const pending = engine.pool.spawnAsync("prefabs/Bullet.prefab");
  engine.pool.reset();
  assert.equal(await pending, null);
});

section("pool — timed despawn");

await check("a delayed despawn happens on game time", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet, 0.5);
  assert.equal(bullet.pooled, false, "despawned immediately");
  for (let i = 0; i < 29; i++) frame(engine); // 0.483s
  assert.equal(bullet.pooled, false, "despawned early");
  frame(engine);
  frame(engine);
  assert.equal(bullet.pooled, true, "never despawned");
});

await check("a paused game holds a pending despawn", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet, 0.1);
  for (let i = 0; i < 60; i++) frame(engine, 0); // paused: dt is zero
  assert.equal(bullet.pooled, false);
});

await check("asking twice does not queue two despawns", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet, 0.1);
  engine.despawn(bullet, 0.1);
  assert.equal(engine.pool.timers.length, 1);
});

await check("an entity destroyed before its timer fires does not resurrect", () => {
  const engine = engineOf();
  const bullet = engine.spawn("prefabs/Bullet.prefab");
  engine.despawn(bullet, 0.05);
  engine.destroyEntity(bullet);
  for (let i = 0; i < 10; i++) frame(engine);
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 0, "a destroyed entity landed in the pool");
});

section("pool — the Prefab Pool component");

await check("the component prewarms its prefab when Play starts", async () => {
  const engine = engineOf();
  engine.pool.budgetMs = 1000;
  const manager = engine.createEntity({ name: "Pools" });
  manager.addComponent("pool", { prefab: "prefabs/Bullet.prefab", count: 5 });
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 0, "prewarmed while stopped");
  engine.setPlaying(true);
  for (let i = 0; i < 8 && engine.pool.pending; i++) frame(engine);
  await tick();
  assert.equal(engine.pool.free("prefabs/Bullet.prefab"), 5);
});

await check("a prefab field is followed when collecting a scene's assets", async () => {
  const { collectSceneAssets } = await import("../src/engine/sceneManager.js");
  // The pooled prefab's own contents are not in the scene tree at all, so
  // nothing else would reach the model a spawn is about to need.
  const assets = collectSceneAssets({
    entities: [
      {
        id: "e1",
        name: "Pools",
        components: [{ type: "pool", props: { prefab: "prefabs/WithModel.prefab", count: 2 } }],
        children: [],
      },
    ],
  });
  assert.ok(assets.includes("models/thing.glb"), `expected the pooled model, got ${JSON.stringify(assets)}`);
});

section("pool — physics registration");

/** An engine with the real Rapier world running. */
async function physicsEngine() {
  const engine = engineOf();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  engine.setPlaying(true);
  return engine;
}
const step = (engine, n = 1) => {
  for (let i = 0; i < n; i++) engine.physics.update(1 / 60);
};

await check("an entity spawned mid-play gets a body and falls", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 10, 0] });
  // The world used to be built exactly once, at Play: every bullet and every
  // enemy spawned afterwards had a null body and hung in the air.
  assert.ok(crate.getComponent("rigidbody").body, "no body after spawn");
  step(engine, 30);
  assert.ok(crate.position.y < 9.5, `never fell (y = ${crate.position.y})`);
});

await check("the body is built at the spawn position, not the prefab's", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [4, 20, -2] });
  const t = crate.getComponent("rigidbody").body.translation();
  assert.ok(Math.abs(t.x - 4) < 1e-6 && Math.abs(t.y - 20) < 1e-6, `body at ${t.x},${t.y},${t.z}`);
});

await check("a spawned collider answers raycasts", async () => {
  const engine = await physicsEngine();
  engine.spawn("prefabs/Crate.prefab", { position: [0, 0, 0] });
  const hit = engine.physics.raycast([0, 5, 0], [0, -1, 0], 20);
  assert.ok(hit, "the spawned crate is not in the world");
});

await check("despawning removes the body from the world", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 0, 0] });
  engine.despawn(crate);
  step(engine);
  // Compared by name, not by identity: a failed `assert.equal` against a hit
  // would try to diff the entity's whole object graph (engine, scene, three).
  assert.equal(engine.physics.raycast([0, 5, 0], [0, -1, 0], 20)?.entity.name ?? null, null,
    "a parked collider still blocks rays");
  // The component itself STAYS — that is what makes the next spawn a recycle
  // rather than a rebuild. Only its Rapier handles are surrendered.
  assert.equal(crate.getComponent("rigidbody").body, null, "a parked body still exists");
  assert.equal(crate.getComponent("collider").collider, null, "a parked collider still exists");
});

await check("a respawned instance starts at rest, not at last life's velocity", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 10, 0] });
  step(engine, 60);
  const falling = crate.getComponent("rigidbody").getLinearVelocity()[1];
  assert.ok(falling < -5, `expected a falling crate, got ${falling}`);
  engine.despawn(crate);
  const again = engine.spawn("prefabs/Crate.prefab", { position: [0, 10, 0] });
  assert.equal(again, crate, "not the pooled instance");
  const v = again.getComponent("rigidbody").getLinearVelocity();
  assert.ok(Math.abs(v[1]) < 1e-6, `velocity carried over: ${v}`);
});

await check("destroying an entity mid-play takes its collider with it", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 0, 0] });
  assert.ok(engine.physics.raycast([0, 5, 0], [0, -1, 0], 20));
  engine.destroyEntity(crate);
  step(engine);
  // Without this, a corridor slowly fills with invisible walls where enemies
  // died — and nothing in the scene explains why the player is stuck.
  assert.equal(engine.physics.raycast([0, 5, 0], [0, -1, 0], 20)?.entity.name ?? null, null,
    "the collider outlived its entity");
});

await check("removing a collider component leaves the rigidbody working", async () => {
  const engine = await physicsEngine();
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 10, 0] });
  crate.removeComponent("collider");
  step(engine, 10);
  assert.ok(crate.getComponent("rigidbody").body, "the body went away with the collider");
  assert.ok(crate.position.y < 10);
});

await check("a hundred spawn/despawn cycles leave one body in the world", async () => {
  const engine = await physicsEngine();
  for (let i = 0; i < 100; i++) {
    const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 5, 0] });
    step(engine, 2);
    engine.despawn(crate);
  }
  const crate = engine.spawn("prefabs/Crate.prefab", { position: [0, 5, 0] });
  step(engine);
  // Leaked bodies are invisible until the frame rate is gone, so count them.
  assert.equal(engine.physics.world.bodies.len(), 1, "bodies leaked across recycles");
  engine.despawn(crate);
});

console.log(failures === 0 ? "\nall pool checks passed" : `\n${failures} pool check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
