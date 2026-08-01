/**
 * Save/load + persistent data (src/engine/saveSystem.js).
 *
 * Drives the real Engine headlessly with real ScriptComponents (a stubbed
 * script loader hands back real classes), so what is exercised is the contract
 * a game depends on rather than a mock of it: a script's `onSave` value comes
 * back through `onLoad`, the player is standing where they saved, an enemy
 * killed before saving is not alive after loading, preferences survive wiping
 * every slot, and a save from an older version is REFUSED rather than fed to
 * scripts that no longer understand it.
 */
import assert from "node:assert/strict";

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
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const {
  Engine,
  registerBuiltInComponents,
  setSceneLoader,
  setScriptLoader,
  setSaveBackend,
  registerPrefabDefs,
  newGuid,
  newFid,
} = await import("../src/engine/index.js");

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

// ---------------------------------------------------------------------------
// Fixtures: two scenes, three scripts, one prefab.
// ---------------------------------------------------------------------------

/** A script that saves a value — the ordinary case. */
class Player {
  health = 100;
  onSave() {
    return { health: this.health };
  }
  onLoad(data) {
    this.health = data?.health ?? 100;
  }
}

/** A script that opts in but stores nothing — transform-only participation. */
class Crate {
  onSave() {}
  onLoad() {
    this.loaded = true;
  }
}

/** A script with no hooks at all — must never appear in a save. */
class Decoration {
  onUpdate() {}
}

/** Throws from both hooks: one bad script must not sink the whole save. */
class Cursed {
  onSave() {
    throw new Error("boom");
  }
  onLoad() {
    throw new Error("boom");
  }
}

const SCRIPTS = {
  "scripts/Player.ts": Player,
  "scripts/Crate.ts": Crate,
  "scripts/Decoration.ts": Decoration,
  "scripts/Cursed.ts": Cursed,
};
setScriptLoader(async (path) => ({ default: SCRIPTS[path] }));

const scriptComponent = (...paths) => ({
  type: "script",
  props: { scripts: paths.map((path) => ({ path, enabled: true, attributes: {} })) },
});

const entity = (id, name, extra = {}) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components: [],
  children: [],
  ...extra,
});

const SCENES = {
  "scenes/Level1.scene": {
    version: 1,
    name: "Level1",
    entities: [
      entity("player", "Player", { components: [scriptComponent("scripts/Player.ts")] }),
      entity("crate", "Crate", { components: [scriptComponent("scripts/Crate.ts")] }),
      entity("tree", "Tree", { components: [scriptComponent("scripts/Decoration.ts")] }),
    ],
  },
  "scenes/Level2.scene": {
    version: 1,
    name: "Level2",
    entities: [entity("player", "Player", { components: [scriptComponent("scripts/Player.ts")] })],
  },
};
setSceneLoader(async (path) => {
  const json = SCENES[path];
  if (!json) throw new Error(`Scene not found: ${path}`);
  return structuredClone(json);
});

// An enemy prefab, so runtime spawns have a recipe to be rebuilt from.
const ENEMY_GUID = newGuid();
registerPrefabDefs([
  {
    guid: ENEMY_GUID,
    path: "prefabs/Enemy.prefab",
    root: {
      fid: newFid(),
      name: "Enemy",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [scriptComponent("scripts/Player.ts")],
      children: [],
    },
  },
]);

/**
 * Scripts only instantiate while playing, and slot loading is async — so a
 * usable fixture is "loaded, playing, and settled".
 */
async function game(scene = "scenes/Level1.scene") {
  const engine = new Engine();
  engine.saves.setNamespace(`test-${Math.random().toString(36).slice(2)}`);
  await engine.loadScene(scene);
  engine.setPlaying(true);
  await settle(engine);
  return engine;
}

/** Waits for every script slot to finish importing and start running. */
async function settle(engine) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const pending = [...engine.entities.values()].some((e) => {
      const c = e.getComponent?.("script");
      return c && (c.props.scripts ?? []).length !== (c.slots ?? []).filter((s) => s.instance).length;
    });
    if (!pending) return;
  }
  throw new Error("scripts never finished loading");
}

const scriptOn = (engine, id, index = 0) =>
  engine.getEntity(id)?.getComponent("script")?.slots?.[index]?.instance;

// A fresh in-memory backend per group keeps slots from leaking between checks.
function memoryBackend() {
  const map = new Map();
  return {
    durable: true,
    async read(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async write(k, v) {
      map.set(k, v);
    },
    async remove(k) {
      map.delete(k);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}
setSaveBackend(memoryBackend());

// ---------------------------------------------------------------------------
console.log("saves — capture");

await check("only scripts that define onSave are captured", async () => {
  const engine = await game();
  const data = engine.saves.capture();
  const ids = data.entities.map((e) => e.id).sort();
  assert.deepEqual(ids, ["crate", "player"], "Tree has no onSave and must not appear");
});

await check("a captured value survives the round trip", async () => {
  const engine = await game();
  scriptOn(engine, "player").health = 42;
  const data = engine.saves.capture();
  assert.deepEqual(
    data.entities.find((e) => e.id === "player").scripts,
    { player: { health: 42 } },
    "keyed by file stem, not slot index",
  );
});

await check("a script that opts in but returns nothing still gets its entity captured", async () => {
  const engine = await game();
  const entry = engine.saves.capture().entities.find((e) => e.id === "crate");
  assert.ok(entry, "Crate opted in via onSave");
  assert.deepEqual(entry.scripts, {}, "no value, but the transform is still recorded");
});

await check("transform is captured without the game asking", async () => {
  const engine = await game();
  engine.getEntity("player").object3D.position.set(1, 2, 3);
  const entry = engine.saves.capture().entities.find((e) => e.id === "player");
  assert.deepEqual(entry.transform.slice(0, 3), [1, 2, 3]);
});

await check("the payload names the scene it belongs to", async () => {
  const engine = await game("scenes/Level2.scene");
  assert.equal(engine.saves.capture().scene, "scenes/Level2.scene");
});

await check("a throwing onSave doesn't lose the rest of the save", async () => {
  const engine = await game();
  const component = engine.getEntity("crate").getComponent("script");
  component.slots[0].instance = new Cursed();
  const data = engine.saves.capture();
  assert.ok(
    data.entities.find((e) => e.id === "player").scripts.player,
    "the Player's data still made it into the save",
  );
});

await check("a script without onStart isn't punished for it (regression)", async () => {
  // `#reconcileSlotRunning` used to call onStart/onDestroy unconditionally, so
  // a script defining only onUpdate threw a TypeError on every Play — and
  // MAX_ERRORS latched it OFF on the third one, taking its save data with it.
  const engine = await game();
  for (let i = 0; i < 4; i++) {
    engine.setPlaying(false);
    engine.setPlaying(true);
    await settle(engine);
  }
  const slot = engine.getEntity("player").getComponent("script").slots[0];
  assert.equal(slot.off, false, "still enabled after four Play/Stop cycles");
  assert.equal(slot.errors ?? 0, 0, "and never counted an error");
  assert.ok(engine.saves.capture().entities.find((e) => e.id === "player"));
});

// ---------------------------------------------------------------------------
console.log("saves — restore");

await check("onLoad receives what onSave returned", async () => {
  const engine = await game();
  scriptOn(engine, "player").health = 7;
  const data = engine.saves.capture();
  scriptOn(engine, "player").health = 100;
  await engine.saves.restore(data);
  assert.equal(scriptOn(engine, "player").health, 7);
});

await check("the player is standing where they saved", async () => {
  const engine = await game();
  engine.getEntity("player").object3D.position.set(5, 0, -5);
  const data = engine.saves.capture();
  engine.getEntity("player").object3D.position.set(0, 0, 0);
  await engine.saves.restore(data);
  const p = engine.getEntity("player").object3D.position;
  assert.deepEqual([p.x, p.y, p.z], [5, 0, -5]);
});

await check("a disabled entity comes back disabled", async () => {
  const engine = await game();
  engine.getEntity("crate").setEnabledInGame(false);
  const data = engine.saves.capture();
  engine.getEntity("crate").setEnabledInGame(true);
  await engine.saves.restore(data);
  assert.equal(engine.getEntity("crate").enabledInGame, false);
});

await check("...and re-enabling is restored too (loading twice can't strand it off)", async () => {
  const engine = await game();
  const data = engine.saves.capture(); // saved while enabled
  engine.getEntity("crate").setEnabledInGame(false);
  await engine.saves.restore(data);
  assert.equal(engine.getEntity("crate").enabledInGame, true);
});

await check("restoring a save from another scene loads that scene first", async () => {
  const engine = await game("scenes/Level2.scene");
  const data = engine.saves.capture();
  await engine.loadScene("scenes/Level1.scene");
  engine.setPlaying(true);
  await settle(engine);
  assert.equal(engine.scenes.active.path, "scenes/Level1.scene");
  await engine.saves.restore(data);
  assert.equal(engine.scenes.active.path, "scenes/Level2.scene");
});

await check("a throwing onLoad doesn't stop the other entities restoring", async () => {
  const engine = await game();
  const data = engine.saves.capture();
  engine.getEntity("crate").getComponent("script").slots[0].instance = new Cursed();
  scriptOn(engine, "player").health = 1;
  await engine.saves.restore(data);
  assert.equal(scriptOn(engine, "player").health, 100, "Player still restored");
});

await check("an entity in the save that the scene no longer has is skipped, not fatal", async () => {
  const engine = await game();
  const data = engine.saves.capture();
  data.entities.push({ id: "ghost", name: "Ghost", transform: null, scripts: {} });
  assert.equal(await engine.saves.restore(data), true);
});

// ---------------------------------------------------------------------------
console.log("saves — runtime spawns");

await check("a prefab spawned at runtime is respawned by a load", async () => {
  const engine = await game();
  const enemy = engine.instantiate(ENEMY_GUID);
  await settle(engine);
  scriptOn(engine, enemy.id).health = 33;
  const data = engine.saves.capture();
  const savedId = enemy.id;

  engine.destroyEntity(enemy);
  assert.equal(engine.getEntity(savedId), undefined, "gone before the load");

  await engine.saves.restore(data);
  await settle(engine);
  const revived = engine.getEntity(savedId);
  assert.ok(revived, "respawned under its saved id");
  assert.equal(scriptOn(engine, savedId).health, 33);
});

await check("an enemy killed before saving is not alive after loading", async () => {
  const engine = await game();
  const data = engine.saves.capture(); // no enemies yet
  const enemy = engine.instantiate(ENEMY_GUID);
  await settle(engine);
  await engine.saves.restore(data);
  assert.equal(engine.getEntity(enemy.id), undefined, "pruned — the save is authoritative");
});

await check("prune:false leaves spawns the save doesn't know about alone", async () => {
  const engine = await game();
  const data = engine.saves.capture();
  const enemy = engine.instantiate(ENEMY_GUID);
  await settle(engine);
  await engine.saves.restore(data, { prune: false });
  assert.ok(engine.getEntity(enemy.id), "kept");
});

// ---------------------------------------------------------------------------
console.log("saves — slots");

await check("save then load a slot", async () => {
  const engine = await game();
  scriptOn(engine, "player").health = 55;
  await engine.saves.save(1);
  scriptOn(engine, "player").health = 100;
  assert.equal(await engine.saves.load(1), true);
  assert.equal(scriptOn(engine, "player").health, 55);
});

await check("loading a slot that was never written is false, not a throw", async () => {
  const engine = await game();
  assert.equal(await engine.saves.load("nope"), false);
});

await check("list() reports headers newest first, without the entity payload", async () => {
  const engine = await game();
  await engine.saves.write("old", { ...engine.saves.capture(), savedAt: 1000 });
  await engine.saves.write("new", { ...engine.saves.capture(), savedAt: 2000 });
  const list = await engine.saves.list();
  assert.deepEqual(list.map((s) => s.slot), ["new", "old"]);
  assert.equal(list[0].scene, "scenes/Level1.scene");
  assert.equal(list[0].entities, undefined, "headers only");
});

await check("has() and delete()", async () => {
  const engine = await game();
  await engine.saves.save("tmp");
  assert.equal(await engine.saves.has("tmp"), true);
  await engine.saves.delete("tmp");
  assert.equal(await engine.saves.has("tmp"), false);
});

await check("a corrupt slot is reported, not thrown, and doesn't break the list", async () => {
  const engine = await game();
  await engine.saves.save("good");
  const backend = (await import("../src/engine/saveSystem.js")).getSaveBackend();
  await backend.write(`engine.save.v1.${engine.saves.namespace}.slot.bad`, "{not json");
  assert.equal(await engine.saves.read("bad"), null);
  const list = await engine.saves.list();
  assert.equal(list.find((s) => s.slot === "bad")?.corrupt, true);
  assert.ok(list.find((s) => s.slot === "good"), "the good slot still lists");
});

await check("two namespaces cannot see each other's slots", async () => {
  const a = await game();
  const b = await game();
  a.saves.setNamespace("game-a");
  b.saves.setNamespace("game-b");
  await a.saves.save(1);
  assert.equal(await b.saves.has(1), false);
});

// ---------------------------------------------------------------------------
console.log("saves — progress state");

await check("saves.state rides along in the slot", async () => {
  const engine = await game();
  engine.saves.state.set("coins", 10);
  engine.saves.state.increment("coins", 5);
  await engine.saves.save(1);
  engine.saves.state.clear();
  await engine.saves.load(1);
  assert.equal(engine.saves.state.get("coins"), 15);
});

await check("state.get returns the fallback for a missing key", async () => {
  const engine = await game();
  assert.equal(engine.saves.state.get("nothing", "default"), "default");
});

// ---------------------------------------------------------------------------
console.log("saves — versioning");

await check("a save at the current version loads unchanged", async () => {
  const engine = await game();
  await engine.saves.save(1);
  assert.ok(await engine.saves.read(1));
});

await check("an older save with no migration is REFUSED, not fed to new scripts", async () => {
  const engine = await game();
  await engine.saves.save(1);
  engine.config.saveVersion = 2;
  assert.equal(await engine.saves.read(1), null);
  assert.equal(await engine.saves.load(1), false, "and load() reports the failure");
});

await check("a registered migration upgrades an old save", async () => {
  const engine = await game();
  scriptOn(engine, "player").health = 20;
  await engine.saves.save(1);
  engine.config.saveVersion = 2;
  engine.saves.registerMigration(2, (data) => {
    for (const e of data.entities) if (e.scripts.player) e.scripts.player.health *= 2;
    return data;
  });
  const data = await engine.saves.read(1);
  assert.equal(data.version, 2);
  assert.equal(data.entities.find((e) => e.id === "player").scripts.player.health, 40);
});

await check("migrations chain one version at a time", async () => {
  const engine = await game();
  await engine.saves.save(1);
  engine.config.saveVersion = 3;
  const seen = [];
  engine.saves.registerMigration(2, (d) => (seen.push(2), d));
  engine.saves.registerMigration(3, (d) => (seen.push(3), d));
  const data = await engine.saves.read(1);
  assert.deepEqual(seen, [2, 3]);
  assert.equal(data.version, 3);
});

// ---------------------------------------------------------------------------
console.log("prefs");

await check("preferences persist immediately, without a slot", async () => {
  const engine = await game();
  engine.prefs.set("volume", 0.5);
  await engine.prefs.flush();
  const reloaded = await game();
  reloaded.saves.setNamespace(engine.saves.namespace);
  await reloaded.prefs.hydrate();
  assert.equal(reloaded.prefs.get("volume"), 0.5);
});

await check("deleting every save slot leaves preferences standing", async () => {
  const engine = await game();
  engine.prefs.set("difficulty", "hard");
  await engine.prefs.flush();
  await engine.saves.save(1);
  await engine.saves.delete(1);
  await engine.prefs.hydrate();
  assert.equal(engine.prefs.get("difficulty"), "hard");
});

await check("loading a save does not overwrite preferences", async () => {
  const engine = await game();
  await engine.saves.save(1);
  engine.prefs.set("volume", 0.2);
  await engine.saves.load(1);
  assert.equal(engine.prefs.get("volume"), 0.2);
});

await check("a burst of sets coalesces into one write", async () => {
  const engine = await game();
  let writes = 0;
  const backend = memoryBackend();
  const inner = backend.write.bind(backend);
  backend.write = async (k, v) => {
    if (k.endsWith(".prefs")) writes++;
    return inner(k, v);
  };
  setSaveBackend(backend);
  for (let i = 0; i < 10; i++) engine.prefs.set("slider", i);
  await engine.prefs.flush();
  assert.equal(writes, 1, `coalesced 10 sets into ${writes} write(s)`);
  setSaveBackend(memoryBackend());
});

// ---------------------------------------------------------------------------
console.log("saves — storage");

await check("a blocked storage degrades to memory and admits it", async () => {
  const { setSaveBackend: setBackend, getSaveBackend } = await import("../src/engine/saveSystem.js");
  setBackend(null); // back to the default probe
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => null,
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {},
  };
  setBackend(null);
  const backend = getSaveBackend();
  assert.equal(backend.durable, false, "reports itself as non-durable");
  await backend.write("k", "v");
  assert.equal(await backend.read("k"), "v", "still functions in memory");
  if (original === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = original;
  setBackend(memoryBackend());
});

await check("engine.saves.durable reflects the live backend", async () => {
  const engine = await game();
  assert.equal(engine.saves.durable, true);
});

if (failures) {
  console.error(`\n${failures} save-system check(s) failed`);
  process.exit(1);
}
console.log("\nall save-system checks passed");
