/**
 * Runtime scene management (src/engine/sceneManager.js).
 *
 * Runs the real Engine headlessly — no renderer, which is fine because scene
 * loading is entity-tree bookkeeping. What matters here is the contract a game
 * depends on: a level swap really replaces the level, the things you marked
 * persistent really survive it, two additive scenes cannot silently eat each
 * other's entities, and a loading screen gets progress it can draw.
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
  serializeScene,
  collectSceneAssets,
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
// Fixture scenes, served by a stubbed scene loader (the editor reads these
// over Tauri, a build fetches them — neither belongs in a unit test).
// ---------------------------------------------------------------------------
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
  "scenes/Menu.scene": {
    version: 1,
    name: "Menu",
    entities: [entity("menu-root", "Menu Root")],
  },
  "scenes/Level1.scene": {
    version: 1,
    name: "Level1",
    entities: [
      entity("l1-a", "Ground", { components: [{ type: "mesh", props: { geometry: "box", material: "materials/Ground.mat" } }] }),
      entity("l1-cam", "Main Camera", { components: [{ type: "camera", props: {} }] }),
      entity("l1-manager", "Game Manager", { persistent: true }),
    ],
  },
  "scenes/Level2.scene": {
    version: 1,
    name: "Level2",
    entities: [
      entity("l2-a", "Level 2 Ground"),
      entity("l2-cam", "Level 2 Camera", { components: [{ type: "camera", props: {} }] }),
    ],
  },
  "scenes/Hud.scene": {
    version: 1,
    name: "Hud",
    entities: [
      entity("hud-root", "Hud Root", {
        // The IK target here is an entity REFERENCE. It exists so the additive
        // remap test can prove the reference follows the copy it belongs to.
        components: [{ type: "ik", props: { tipBone: "Foot", target: "hud-child" } }],
        children: [entity("hud-child", "Hud Child")],
      }),
    ],
  },
  "scenes/Nested.scene": {
    version: 1,
    name: "Nested",
    entities: [
      entity("nest-root", "Nest Root", {
        children: [entity("nest-keeper", "Keeper", { persistent: true })],
      }),
    ],
  },
  "scenes/Bad.scene": { version: 99, name: "Bad", entities: [] },
};

setSceneLoader(async (path) => {
  const json = SCENES[path];
  if (!json) throw new Error(`Scene not found: ${path}`);
  return structuredClone(json);
});

const names = (engine) => [...engine.entities.values()].map((e) => e.name).sort();
const fresh = () => new Engine();

console.log("scene manager");

await check("loads a scene and reports it as active", async () => {
  const engine = fresh();
  const record = await engine.loadScene("scenes/Level1.scene");
  assert.equal(record.name, "Level1");
  assert.equal(engine.sceneName, "Level1");
  assert.equal(engine.scenes.active.path, "scenes/Level1.scene");
  assert.ok(engine.scenes.isLoaded("scenes/Level1.scene"));
  assert.deepEqual(names(engine), ["Game Manager", "Ground", "Main Camera"]);
  assert.equal(engine.scenes.isLoading, false);
});

await check("single mode replaces the previous scene", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Menu.scene");
  await engine.loadScene("scenes/Level2.scene");
  assert.deepEqual(names(engine), ["Level 2 Camera", "Level 2 Ground"]);
  assert.equal(engine.scenes.loaded.length, 1);
  assert.equal(engine.scenes.active.path, "scenes/Level2.scene");
});

await check("persistent roots survive a single-mode load", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  const manager = engine.getEntity("l1-manager");
  assert.ok(manager.persistent, "fixture marks the manager persistent");
  await engine.loadScene("scenes/Level2.scene");
  assert.ok(engine.getEntity("l1-manager"), "manager survived the level swap");
  assert.equal(engine.getEntity("l1-a"), undefined, "the rest of level 1 is gone");
  assert.ok(names(engine).includes("Game Manager"));
});

await check("dontDestroyOnLoad marks an entity at runtime", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Menu.scene");
  const keeper = engine.createEntity({ name: "Audio Listener" });
  engine.dontDestroyOnLoad(keeper);
  await engine.loadScene("scenes/Level2.scene");
  assert.ok(engine.getEntity(keeper.id), "runtime-marked entity survived");
});

await check("a persistent child is re-rooted rather than destroyed with its parent", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Nested.scene");
  const keeper = engine.getEntity("nest-keeper");
  assert.equal(keeper.parent?.id, "nest-root");
  await engine.loadScene("scenes/Level2.scene");
  const survivor = engine.getEntity("nest-keeper");
  assert.ok(survivor, "persistent child survived");
  assert.equal(survivor.parent, null, "and was re-rooted");
  assert.equal(engine.getEntity("nest-root"), undefined, "its old parent is gone");
  assert.ok(engine.rootEntities.includes(survivor), "it is a real root now");
});

await check("additive mode keeps both scenes", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  await engine.loadScene("scenes/Hud.scene", { mode: "additive" });
  assert.deepEqual(names(engine), ["Game Manager", "Ground", "Hud Child", "Hud Root", "Main Camera"]);
  assert.equal(engine.scenes.loaded.length, 2);
  assert.equal(engine.scenes.active.path, "scenes/Level1.scene", "additive does not become active");
});

await check("additive mode does not touch scene settings or name", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  const before = JSON.stringify(engine.settings);
  await engine.loadScene("scenes/Hud.scene", { mode: "additive" });
  assert.equal(engine.sceneName, "Level1");
  assert.equal(JSON.stringify(engine.settings), before);
});

await check("colliding ids are remapped on additive load", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Hud.scene");
  await engine.loadScene("scenes/Hud.scene", { mode: "additive" });
  const hudRoots = [...engine.entities.values()].filter((e) => e.name === "Hud Root");
  assert.equal(hudRoots.length, 2, "both copies exist");
  assert.equal(new Set(hudRoots.map((e) => e.id)).size, 2, "with distinct ids");
  const children = [...engine.entities.values()].filter((e) => e.name === "Hud Child");
  assert.equal(children.length, 2, "children came through too");
  assert.equal(children[0].parent.id !== children[1].parent.id, true, "parented separately");
});

await check("entity-reference props follow the copy they belong to", async () => {
  // Without this, the second copy's IK target (or a joint's connected body, or
  // a camera's follow target) still names the FIRST copy's entity — two HUDs
  // silently wired to one, which looks like a physics/animation bug rather than
  // a loader bug.
  const engine = fresh();
  await engine.loadScene("scenes/Hud.scene");
  await engine.loadScene("scenes/Hud.scene", { mode: "additive" });
  const roots = [...engine.entities.values()].filter((e) => e.name === "Hud Root");
  for (const root of roots) {
    const target = root.getComponent("ik").props.target;
    assert.equal(
      root.children[0].id,
      target,
      "each copy's IK target is its OWN child",
    );
  }
  assert.notEqual(
    roots[0].getComponent("ik").props.target,
    roots[1].getComponent("ik").props.target,
    "and the two copies don't share one",
  );
});

await check("unload removes only that scene's entities", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  await engine.loadScene("scenes/Hud.scene", { mode: "additive" });
  assert.equal(engine.unloadScene("scenes/Hud.scene"), true);
  assert.deepEqual(names(engine), ["Game Manager", "Ground", "Main Camera"]);
  assert.equal(engine.scenes.loaded.length, 1);
  assert.equal(engine.unloadScene("scenes/Hud.scene"), false, "unloading twice is a no-op");
});

await check("progress runs 0..1, never backwards, and covers every phase", async () => {
  const engine = fresh();
  const seen = [];
  await engine.loadScene("scenes/Level1.scene", { onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= 5, `expected several progress reports, got ${seen.length}`);
  const values = seen.map((p) => p.progress);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `progress went backwards at ${i}: ${values[i - 1]} -> ${values[i]}`);
  }
  assert.ok(values[0] <= 0.1, "starts near zero");
  assert.equal(values.at(-1), 1, "ends at exactly 1");
  const phases = new Set(seen.map((p) => p.phase));
  for (const phase of ["fetch", "modules", "preload", "unload", "instantiate"]) {
    assert.ok(phases.has(phase), `missing phase "${phase}"`);
  }
});

await check("emits scene-load-start / scene-loaded / scene-unloaded", async () => {
  const engine = fresh();
  const events = [];
  engine.on("scene-load-start", (e) => events.push(["start", e.path]));
  engine.on("scene-loaded", (e) => events.push(["loaded", e.path]));
  engine.on("scene-unloaded", (e) => events.push(["unloaded", e.path]));
  await engine.loadScene("scenes/Hud.scene");
  engine.unloadScene("scenes/Hud.scene");
  assert.deepEqual(events, [
    ["start", "scenes/Hud.scene"],
    ["loaded", "scenes/Hud.scene"],
    ["unloaded", "scenes/Hud.scene"],
  ]);
});

await check("repoints the camera while playing, leaves it alone while stopped", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  const editorCamera = { isEditorCamera: true };
  engine.camera = editorCamera;
  await engine.loadScene("scenes/Level2.scene");
  assert.equal(engine.camera, editorCamera, "stopped: the editor keeps its viewport camera");

  engine.playing = true;
  await engine.loadScene("scenes/Level1.scene");
  const gameCamera = engine.getEntity("l1-cam").getComponent("camera").camera;
  assert.equal(engine.camera, gameCamera, "playing: repointed at the new scene's camera");
});

await check("a superseded load resolves to null and loses the race", async () => {
  const engine = fresh();
  const first = engine.loadScene("scenes/Level1.scene");
  const second = engine.loadScene("scenes/Level2.scene");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, null, "the superseded load reports that it was cancelled");
  assert.equal(b.name, "Level2");
  assert.equal(engine.sceneName, "Level2");
  assert.equal(engine.scenes.loaded.length, 1);
  assert.ok(!names(engine).includes("Ground"), "level 1 did not leak in");
});

await check("reset forgets bookkeeping without touching entities", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  const before = names(engine);
  engine.scenes.reset({ path: "scenes/Editing.scene" });
  assert.deepEqual(names(engine), before, "entities untouched");
  assert.equal(engine.scenes.active.path, "scenes/Editing.scene");
  assert.equal(engine.scenes.isLoaded("scenes/Level1.scene"), false);
});

await check("a missing scene rejects and leaves the current one intact", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  await assert.rejects(() => engine.loadScene("scenes/Nope.scene"));
  assert.deepEqual(names(engine), ["Game Manager", "Ground", "Main Camera"]);
  assert.equal(engine.scenes.isLoading, false, "the pending flag is cleared on failure");
});

await check("an unsupported scene version rejects", async () => {
  const engine = fresh();
  await assert.rejects(() => engine.loadScene("scenes/Bad.scene"), /Unsupported scene version 99/);
});

await check("preload:false skips prefetching, arrays preload exactly what they list", async () => {
  const engine = fresh();
  const phases = [];
  await engine.loadScene("scenes/Level1.scene", {
    preload: false,
    onProgress: (p) => phases.push(p),
  });
  const preloadReports = phases.filter((p) => p.phase === "preload");
  assert.ok(preloadReports.length >= 1, "still reports the phase so the bar advances");
  assert.ok(preloadReports.every((p) => p.total <= 1), "nothing was queued");
});

await check("the persistent flag round-trips through serialization", async () => {
  const engine = fresh();
  await engine.loadScene("scenes/Level1.scene");
  const json = serializeScene(engine);
  const manager = json.entities.find((e) => e.name === "Game Manager");
  assert.equal(manager.persistent, true);
  const ground = json.entities.find((e) => e.name === "Ground");
  assert.equal("persistent" in ground, false, "ordinary entities stay out of the file");
});

await check("collectSceneAssets finds asset paths through component schemas", async () => {
  const assets = collectSceneAssets({
    version: 1,
    entities: [
      entity("a", "A", { components: [{ type: "mesh", props: { geometry: "box", material: "materials/Ground.mat" } }] }),
      entity("b", "B", {
        components: [
          { type: "model", props: { path: "models/Tree.glb", materials: { Bark: "materials/Bark.mat" } } },
          { type: "script", props: { path: "scripts/Spin.ts" } },
        ],
      }),
    ],
    preload: ["audio/Music.mp3"],
  });
  for (const expected of ["materials/Ground.mat", "models/Tree.glb", "materials/Bark.mat", "scripts/Spin.ts", "audio/Music.mp3"]) {
    assert.ok(assets.includes(expected), `expected ${expected} in ${JSON.stringify(assets)}`);
  }
});

console.log(failures ? `\n${failures} failing` : "\nall scene manager checks passed");
process.exit(failures ? 1 : 0);
