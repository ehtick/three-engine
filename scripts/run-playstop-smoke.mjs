// Leaving Play mode restores the scene by DIFFING the play snapshot against
// the live tree (serialize.js `reconcileScene`) instead of destroying and
// rebuilding everything. That's what keeps the stop from freezing the editor
// for seconds — but it only holds up if the restore is exact.
//
// Everything Play can do to a scene, done on purpose, then checked after Stop.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  // See run-editor-ui-smoke.mjs: a bare import would load a second copy of the
  // module graph, with its own Engine singleton.
  globalThis.__importLive = (path) => {
    const prefix = location.origin + path;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? path);
  };
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 2000));

// ---- a scene with every shape the restore has to handle
const setup = await page.evaluate(async () => {
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;
  engine.clear({ resetSettings: false });

  const parent = engine.createEntity({ name: "Parent" });
  parent.addComponent("mesh", { geometry: "box" });
  const childA = engine.createEntity({ name: "ChildA", parent });
  childA.addComponent("mesh", { geometry: "sphere" });
  const childB = engine.createEntity({ name: "ChildB", parent });
  childB.addComponent("light", { type: "point", intensity: 3 });
  const doomed = engine.createEntity({ name: "Doomed" });
  doomed.addComponent("mesh", { geometry: "plane" });
  const scripted = engine.createEntity({ name: "Scripted" });
  scripted.addComponent("script", { scripts: [] });
  scripted.setTags(["hero"]);

  // A prefab instance: its descendants are absent from the snapshot (it
  // serializes as a link), so the restore has to recognise the subtree as
  // prefab-owned instead of treating it as runtime spawn and deleting it.
  const { prefabRegistry } = await globalThis.__importLive("/src/engine/prefab/registry.js");
  prefabRegistry.register(
    {
      prefab: 1,
      guid: "p_smoke",
      name: "SmokePrefab",
      root: {
        fid: "f_root",
        name: "PrefabRoot",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: [{ type: "mesh", props: { geometry: "box" } }],
        children: [
          {
            fid: "f_child",
            name: "PrefabChild",
            position: [0, 1, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            components: [{ type: "light", props: { type: "point" } }],
            children: [],
          },
        ],
      },
    },
    "SmokePrefab.prefab",
  );
  const instance = engine.instantiate("p_smoke", { name: "Instance" });

  globalThis.__ids = {
    parent: parent.id,
    childA: childA.id,
    childB: childB.id,
    doomed: doomed.id,
    scripted: scripted.id,
    instance: instance.id,
    instanceChild: instance.children[0]?.id ?? null,
  };
  return { entities: engine.entities.size, instanceChildren: instance.children.length };
});
console.log(`scene built: ${setup.entities} entities`);
check("the prefab instance expanded", setup.instanceChildren === 1, `${setup.instanceChildren} children`);

// ---- play, then mutate the scene the way a running game would
const during = await page.evaluate(async () => {
  const { play } = await globalThis.__importLive("/src/editor/playMode.js");
  const engine = globalThis.__engine;
  const ids = globalThis.__ids;

  // Component identity BEFORE play — the whole point of reconciling is that
  // these survive, so their loaded GPU state is never rebuilt.
  globalThis.__before = {
    mesh: engine.getEntity(ids.parent).getComponent("mesh"),
    light: engine.getEntity(ids.childB).getComponent("light"),
    script: engine.getEntity(ids.scripted).getComponent("script"),
    instanceMesh: engine.getEntity(ids.instance).getComponent("mesh"),
  };

  await play();

  const parent = engine.getEntity(ids.parent);
  parent.setTransform({ position: [10, 20, 30] });                 // moved
  engine.getEntity(ids.childB).getComponent("light").setProp("intensity", 99); // prop changed
  engine.getEntity(ids.childA).addComponent("light", { type: "spot" });        // component added
  engine.destroyEntity(engine.getEntity(ids.doomed));              // entity destroyed
  const spawned = engine.createEntity({ name: "Spawned" });        // entity spawned
  spawned.addComponent("mesh", { geometry: "torus" });
  globalThis.__spawnedId = spawned.id;
  engine.getEntity(ids.scripted).setTags(["villain"]);             // tags changed

  return {
    playing: engine.playing,
    names: [...engine.entities.values()].map((e) => e.name).sort(),
  };
});
check("play() enters play mode", during.playing === true);
check(
  "scene mutated during play (one destroyed, one spawned)",
  during.names.includes("Spawned") && !during.names.includes("Doomed"),
  during.names.join(","),
);

// ---- stop, and check the scene came back exactly
await new Promise((r) => setTimeout(r, 500));
const after = await page.evaluate(async () => {
  const { stop } = await globalThis.__importLive("/src/editor/playMode.js");
  const engine = globalThis.__engine;
  await stop();
  const ids = globalThis.__ids;
  const parent = engine.getEntity(ids.parent);
  const before = globalThis.__before;
  return {
    playing: engine.playing,
    entities: engine.entities.size,
    parentPos: parent?.getTransform().position,
    doomedBack: !!engine.getEntity(ids.doomed),
    doomedHasMesh: !!engine.getEntity(ids.doomed)?.getComponent("mesh"),
    spawnedGone: !engine.getEntity(globalThis.__spawnedId),
    lightIntensity: engine.getEntity(ids.childB)?.getComponent("light")?.props.intensity,
    childAExtraLight: !!engine.getEntity(ids.childA)?.getComponent("light"),
    tags: [...(engine.getEntity(ids.scripted)?.tags ?? [])],
    childOrder: parent?.children.map((c) => c.name),
    rootOrder: engine.rootEntities.map((e) => e.name),
    // reconcile keeps these; resetOnStop rebuilds the script one
    meshSame: engine.getEntity(ids.parent)?.getComponent("mesh") === before.mesh,
    lightSame: engine.getEntity(ids.childB)?.getComponent("light") === before.light,
    scriptRebuilt: engine.getEntity(ids.scripted)?.getComponent("script") !== before.script,
    scriptPresent: !!engine.getEntity(ids.scripted)?.getComponent("script"),
    instanceChildren: engine.getEntity(ids.instance)?.children.length,
    instanceChildSame: engine.getEntity(ids.instance)?.children[0]?.id === ids.instanceChild,
    instanceMoved: engine.getEntity(ids.instance)?.getTransform().position,
    instanceMeshSame: engine.getEntity(ids.instance)?.getComponent("mesh") === before.instanceMesh,
  };
});

console.log("");
check("stop() leaves play mode", after.playing === false);
check("entity count is back to the pre-play scene", after.entities === 7, `${after.entities}`);
check("a transform changed during play is restored", JSON.stringify(after.parentPos) === "[0,0,0]", JSON.stringify(after.parentPos));
check("an entity destroyed during play comes back", after.doomedBack);
check("...with its components", after.doomedHasMesh);
check("an entity spawned during play is removed", after.spawnedGone);
check("a component prop changed during play is restored", after.lightIntensity === 3, String(after.lightIntensity));
check("a component added during play is removed", after.childAExtraLight === false);
check("tags are restored", JSON.stringify(after.tags) === '["hero"]', JSON.stringify(after.tags));
check("child order is preserved", JSON.stringify(after.childOrder) === '["ChildA","ChildB"]', JSON.stringify(after.childOrder));
check(
  "root order is preserved",
  JSON.stringify(after.rootOrder) === '["Parent","Doomed","Scripted","Instance"]',
  JSON.stringify(after.rootOrder),
);
check("an untouched mesh component is REUSED, not rebuilt", after.meshSame);
check("a prop-restored component is reused too", after.lightSame);
check("a script component is rebuilt (resetOnStop)", after.scriptRebuilt);
check("...and is still attached", after.scriptPresent);
check("an untouched prefab instance keeps its subtree", after.instanceChildren === 1, `${after.instanceChildren}`);
check("...with the same child entity id", after.instanceChildSame);
check("...and is not re-expanded", after.instanceMeshSame);

// ---- second round: mutate the prefab instance, which forces the respawn
// branch (the instance no longer matches its snapshot node).
const round2 = await page.evaluate(async () => {
  const { play, stop } = await globalThis.__importLive("/src/editor/playMode.js");
  const engine = globalThis.__engine;
  const ids = globalThis.__ids;
  await play();
  engine.getEntity(ids.parent).setTransform({ position: [1, 2, 3] });
  engine.getEntity(ids.instance).setTransform({ position: [5, 5, 5] });
  await stop();
  const instance = engine.getEntity(ids.instance);
  return {
    entities: engine.entities.size,
    pos: engine.getEntity(ids.parent)?.getTransform().position,
    names: engine.rootEntities.map((e) => e.name),
    instancePos: instance?.getTransform().position,
    instanceChildren: instance?.children.length,
    instanceChildSame: instance?.children[0]?.id === ids.instanceChild,
    stillLinked: !!instance?.prefab?.guid,
  };
});
console.log("");
check("a second play/stop round restores too", JSON.stringify(round2.pos) === "[0,0,0]", JSON.stringify(round2.pos));
check("...without duplicating entities", round2.entities === 7, `${round2.entities}`);
check(
  "...or reordering the roots",
  JSON.stringify(round2.names) === '["Parent","Doomed","Scripted","Instance"]',
  JSON.stringify(round2.names),
);
check("a prefab instance moved during play is put back", JSON.stringify(round2.instancePos) === "[0,0,0]", JSON.stringify(round2.instancePos));
check("...re-expanded with one child", round2.instanceChildren === 1, `${round2.instanceChildren}`);
check("...which kept its entity id", round2.instanceChildSame);
check("...and is still linked to its prefab", round2.stillLinked);

console.log("");
console.log(`${fail === 0 ? "PLAYSTOP-SMOKE PASS" : "PLAYSTOP-SMOKE FAIL"} — ${pass}/${pass + fail} checks`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
