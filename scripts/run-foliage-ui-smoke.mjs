import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

// Run alone after the GPU smoke, against a freshly started Vite server.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-foliage-ui-"));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: path.join(root, "profile"),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("console", (message) => {
  if (message.type() === "error" || /GPUValidationError|validation error|exceeds the maximum/i.test(message.text())) errors.push(message.text());
});
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${name}`); };
const control = async (label, selector = "input") => {
  const handle = await page.evaluateHandle((label, selector) => [...document.querySelectorAll("[data-foliage-section] .field-row")]
    .find((row) => row.querySelector(".field-label")?.textContent === label)?.querySelector(selector), label, selector);
  assert.ok(handle.asElement(), `Foliage field ${label}`);
  return handle.asElement();
};
async function editNumber(label, value) {
  const input = await control(label);
  await input.click();
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.type(String(value)); await page.keyboard.press("Enter");
}
async function shortcut(redo = false) {
  await page.evaluate(() => document.activeElement?.blur());
  const viewport = await page.$(".viewport-panel canvas");
  const bounds = await viewport?.boundingBox();
  if (bounds) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.keyboard.down("Control");
  if (redo) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (redo) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}
try {
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await installTauriShim(page, { writableRoot: root });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "data:,"; document.head.append(icon);
    }, { once: true });
    globalThis.__importLive = (p) => {
      const prefix = location.origin + p;
      const resources = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
      return import(resources.find((n) => n.includes("?")) ?? resources[0] ?? p);
    };
  });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5335/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Skip the project"))?.click());
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await page.evaluate(async (root) => {
    const { engine } = await __importLive("/src/editor/engineInstance.js");
    const { useProjectStore } = await __importLive("/src/editor/store/projectStore.js");
    const { useSceneStore } = await __importLive("/src/editor/store/sceneStore.js");
    const { useSelectionStore } = await __importLive("/src/editor/store/selectionStore.js");
    const { commandBus } = await __importLive("/src/editor/commands/CommandBus.js");
    const { setModuleEnabled } = await __importLive("/src/editor/modules.js");
    const { openPanel } = await __importLive("/src/editor/EditorShell.jsx");
    useProjectStore.setState({ rootPath: root, currentPath: root, projectMeta: { modules: ["terrain"] } });
    await setModuleEnabled("terrain", true);
    engine.clear();
    const terrain = engine.createEntity({ id: "foliage-smoke-ground", name: "Foliage Smoke Ground" });
    terrain.addComponent("terrain", { size: 12, resolution: 8 });
    const surface = engine.createEntity({ id: "foliage-smoke-mesh", name: "Other Mesh Surface" });
    surface.setTransform({ position: [20, 0, 0], rotation: [-90, 0, 0], scale: [8, 8, 1] });
    surface.addComponent("mesh", { geometry: "plane" });
    const light = engine.createEntity({ name: "Sun" });
    light.addComponent("light", { kind: "directional", intensity: 3 });
    useSceneStore.getState().refresh(); useSelectionStore.getState().select(terrain.id);
    commandBus.clearHistory();
    openPanel("hierarchy"); openPanel("inspector");
    Object.assign(globalThis, { __foliageEngine: engine, __foliageSelection: useSelectionStore, __foliageBus: commandBus });
  }, root);
  await page.waitForSelector('[data-foliage-surface="foliage-smoke-ground"]');
  check("Terrain offers procedural foliage before its module is enabled", await page.evaluate(() => !__foliageEngine.modules.has("foliage")));
  const grass = await page.evaluateHandle(() => [...document.querySelectorAll('[data-foliage-surface="foliage-smoke-ground"] button')].find((button) => button.textContent === "Grass"));
  await grass.asElement().click();
  await page.waitForSelector("[data-foliage-section]", { timeout: 30000 });
  await page.waitForFunction(() => {
    const entity = __foliageEngine.getEntity(__foliageSelection.getState().ids[0]);
    if (!(entity?.getComponent("foliage")?.stats?.instances > 0)) return false;
    globalThis.__foliageId = entity.id;
    return true;
  }, { timeout: 45000 });
  const created = await page.evaluate(() => {
    const entity = __foliageEngine.getEntity(__foliageId), foliage = entity.getComponent("foliage");
    return { parent: entity.parent?.id, ...foliage.props, instances: foliage.stats.instances, history: __foliageBus.undoStack.length };
  });
  check("Grass button enables Foliage and creates populated terrain scatter", created.surface === "foliage-smoke-ground" && created.parent === created.surface && created.species === "grass" && created.distribution === "scatter" && created.instances > 0);
  check("Creation is one undo step", created.history === 1);
  check("Foliage enabling persists in project.json", JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8")).modules.includes("foliage"));
  await shortcut();
  await page.waitForFunction(() => !__foliageEngine.getEntity(__foliageId));
  await shortcut(true);
  await page.waitForFunction(() => !!__foliageEngine.getEntity(__foliageId)?.getComponent("foliage"));
  check("Real Ctrl+Z / Ctrl+Shift+Z remove and restore the entire layer with its id", true);
  await page.evaluate(() => __foliageSelection.getState().select(__foliageId));
  await page.waitForSelector("[data-foliage-section]");
  await editNumber("Plants / m²", 1.25);
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25);
  await shortcut();
  await page.waitForFunction((density) => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === density, {}, created.density);
  await shortcut(true);
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25);
  check("Density edits work live and keyboard undo/redo restores them", true);

  await (await control("Surface", '[role="button"]')).click();
  const meshChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.entity-browser [role="option"]')].find((button) => button.textContent.includes("Other Mesh Surface")));
  await meshChoice.asElement().click();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.surface === "foliage-smoke-mesh");
  check("Surface browser retargets terrain foliage onto an ordinary mesh", true);
  await (await control("Species", "button")).click();
  const flowersChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.tx-select-menu button')].find((button) => button.textContent.trim() === "Wildflowers"));
  await flowersChoice.asElement().click();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.species === "wildflowers");
  const flowers = await page.evaluate(() => ({ ...__foliageEngine.getEntity(__foliageId).getComponent("foliage").props }));
  check("Species preset changes shape and density while retaining the selected surface", flowers.surface === "foliage-smoke-mesh" && flowers.height < 1 && flowers.density === 0.8);
  await shortcut();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.species === "grass");
  check("A multi-property species preset is one keyboard undo", await page.evaluate(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25));

  const treeControls = [
    { key: "leafDensity", label: "Leaf density", value: 1.3 },
    { key: "leafSize", label: "Leaf size", value: .85 },
    { key: "branchDensity", label: "Branch density", value: 1.2 },
    { key: "crownBase", label: "Crown base offset", value: .1 },
    { key: "crownSpread", label: "Crown spread", value: 1.15 },
  ];
  check("Grass hides every tree-only shape control", await page.evaluate(labels => {
    const visibleLabels = [...document.querySelectorAll("[data-foliage-section] .field-label")].map(label => label.textContent);
    return labels.every(label => !visibleLabels.includes(label));
  }, treeControls.map(control => control.label)));
  // Bound the layer before switching species; each shape edit rebuilds both
  // geometry LODs and its atlas, so this UI gate needs only a few actual trees.
  await editNumber("Plant limit", 3);
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.maxInstances === 3);
  await (await control("Species", "button")).click();
  const oakChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.tx-select-menu button')].find(button => button.textContent.trim() === "Oak"));
  await oakChoice.asElement().click();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.species === "oak");
  await editNumber("Plants / m²", .2);
  const settleTree = async (key, value) => page.waitForFunction((key, value) => {
    const component = __foliageEngine.getEntity(__foliageId)?.getComponent("foliage");
    return component?.props[key] === value && component.props.species === "oak" &&
      component.instances.length > 0 && component.instances.length <= 3 &&
      !component._shapeDirty && !component._layoutDirty && !component._resample;
  }, { timeout: 45000 }, key, value);
  await settleTree("density", .2);
  const readPlacements = () => page.evaluate(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").instances.map(instance => ({
    position: [...instance.position], quaternion: [...instance.quaternion], scale: instance.scale,
    seed: instance.seed, triangleIndex: instance.triangleIndex, barycentric: [...instance.barycentric],
  })));
  const treePlacements = await readPlacements();
  const treeDefaults = await page.evaluate(keys => {
    const component = __foliageEngine.getEntity(__foliageId).getComponent("foliage");
    return Object.fromEntries(keys.map(key => [key, component.props[key]]));
  }, treeControls.map(control => control.key));
  check("Oak has a populated scatter bounded to three trees", treePlacements.length > 0 && treePlacements.length <= 3);
  for (const { key, label, value } of treeControls) {
    await editNumber(label, value);
    await settleTree(key, value);
    assert.deepEqual(await readPlacements(), treePlacements, `${label} must not resample the planted trees`);
    await shortcut();
    await settleTree(key, treeDefaults[key]);
    assert.deepEqual(await readPlacements(), treePlacements, `Undo ${label} must preserve tree placements`);
    await shortcut(true);
    await settleTree(key, value);
    assert.deepEqual(await readPlacements(), treePlacements, `Redo ${label} must preserve tree placements`);
    check(`${label} changes through its NumberField and keyboard undo/redo without moving trees`, true);
  }
  const treeEdited = Object.fromEntries(treeControls.map(({ key, value }) => [key, value]));

  // Match sceneIO's selection clearing before replacing the scene. A raw
  // deserializer does not own editor TransformControls or their selection.
  await page.evaluate(() => __foliageSelection.getState().clear());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reload = await page.evaluate(async () => {
    const { serializeScene, deserializeScene, getModuleDefinition } = await __importLive("/src/engine/index.js");
    const scene = JSON.parse(JSON.stringify(serializeScene(__foliageEngine)));
    globalThis.__foliageSavedScene = scene;
    await deserializeScene(__foliageEngine, scene);
    __foliageSelection.getState().select(__foliageId);
    return { registered: getModuleDefinition("foliage")?.components[0]?.type, props: __foliageEngine.getEntity(__foliageId)?.getComponent("foliage")?.props };
  });
  check("Scene reload restores module component and the explicit mesh surface", reload.registered === "foliage" && reload.props?.surface === "foliage-smoke-mesh");
  assert.equal(reload.props.species, "oak");
  assert.equal(reload.props.maxInstances, 3);
  assert.equal(reload.props.density, .2);
  for (const { key, label, value } of treeControls) {
    assert.equal(reload.props[key], value, `${label} survives scene serialization`);
  }
  await settleTree("crownSpread", treeEdited.crownSpread);
  assert.deepEqual(await readPlacements(), treePlacements, "Scene reload preserves the authored tree scatter");
  await page.waitForSelector("[data-foliage-section]");
  for (const { label, value } of treeControls) {
    const input = await control(label);
    assert.equal(await input.evaluate(element => Number(element.value)), value, `${label} displays the saved value after reload`);
  }
  check("All five tree controls and stable placements survive scene reload", true);
  fs.writeFileSync(path.join(root, "tree-controls.json"), JSON.stringify({ defaults: treeDefaults, edited: treeEdited, placements: treePlacements, reloaded: reload.props }, null, 2));

  // Seed an existing authored population, as the World generator does. The
  // UI owns the mode change and every subsequent edit/undo; there is no hidden
  // scatter-to-placements conversion command to pretend we tested here.
  const nativePlacements = await page.evaluate(async () => {
    const { THREE } = await __importLive('/src/engine/index.js');
    const entity = __foliageEngine.getEntity(__foliageId), component = entity.getComponent('foliage');
    entity.object3D.updateWorldMatrix(true, false);
    const inverse = entity.object3D.matrixWorld.clone().invert();
    const placements = component.instances.map((instance, index) => {
      const position = new THREE.Vector3(...instance.position), quaternion = new THREE.Quaternion(...instance.quaternion);
      const scale = new THREE.Vector3().setScalar(instance.scale);
      const local = new THREE.Matrix4().compose(position, quaternion, scale).premultiply(inverse);
      local.decompose(position, quaternion, scale);
      return { id: `authored-oak:${index}`, position: position.toArray(), rotation: new THREE.Euler().setFromQuaternion(quaternion).toArray().slice(0, 3), scale: scale.x };
    });
    component.setProp('placements', placements);
    return placements;
  });
  await settleTree('distribution', 'scatter');
  await (await control('Placement', 'button')).click();
  const placedChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.tx-select-menu button')]
    .find(button => button.textContent.trim() === 'Placed population'));
  await placedChoice.asElement().click();
  await settleTree('distribution', 'placements');
  const readPlacedState = () => page.evaluate(() => {
    const component = __foliageEngine.getEntity(__foliageId).getComponent('foliage');
    return { authored: component.props.placements, plants: component.instances.map(instance => ({ id: instance.id,
      position: [...instance.position], matrix: instance.matrix.toArray().map(Math.fround) })) };
  });
  const placedState = await readPlacedState();
  assert.deepEqual(placedState.authored, nativePlacements);
  assert.deepEqual(placedState.plants.map(plant => plant.id), nativePlacements.map(plant => plant.id));
  placedState.plants.forEach((plant, index) => plant.position.forEach((value, axis) =>
    assert.ok(Math.abs(value - treePlacements[index].position[axis]) < 1e-6, 'seeded local placements preserve their actual world anchors')));
  check('Placement dropdown renders the seeded authored population with stable IDs', placedState.plants.length === treePlacements.length);
  await shortcut(); await settleTree('distribution', 'scatter');
  assert.deepEqual(await readPlacements(), treePlacements, 'undoing the mode change restores the same seeded scatter');
  await shortcut(true); await settleTree('distribution', 'placements');
  assert.deepEqual(await readPlacedState(), placedState, 'redoing the mode change restores authored IDs and matrices');

  const placedDefaults = await page.evaluate(() => {
    const props = __foliageEngine.getEntity(__foliageId).getComponent('foliage').props;
    return { height: props.height, leafColor: props.leafColor };
  });
  const placedEdits = { height: placedDefaults.height + .75, leafColor: '#72844b' };
  await editNumber('Height', placedEdits.height); await settleTree('height', placedEdits.height);
  assert.deepEqual(await readPlacedState(), placedState, 'height edits preserve authored anchors');
  await shortcut(); await settleTree('height', placedDefaults.height);
  assert.deepEqual(await readPlacedState(), placedState, 'undo height preserves authored anchors');
  await shortcut(true); await settleTree('height', placedEdits.height);
  assert.deepEqual(await readPlacedState(), placedState, 'redo height preserves authored anchors');
  const colorInput = await control('Foliage color', 'input[type="color"]');
  await colorInput.evaluate((input, value) => {
    // Native picker UI cannot be driven headlessly; dispatch its actual input
    // event through the mounted controlled field and normal command handler.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, placedEdits.leafColor);
  await settleTree('leafColor', placedEdits.leafColor);
  assert.deepEqual(await readPlacedState(), placedState, 'color edits preserve authored anchors');
  await shortcut(); await settleTree('leafColor', placedDefaults.leafColor);
  assert.deepEqual(await readPlacedState(), placedState, 'undo color preserves authored anchors');
  await shortcut(true); await settleTree('leafColor', placedEdits.leafColor);
  assert.deepEqual(await readPlacedState(), placedState, 'redo color preserves authored anchors');
  check('Placed population shape and color edits use normal keyboard undo/redo without moving plants', true);

  await page.evaluate(() => __foliageSelection.getState().clear());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(async () => {
    const { serializeScene, deserializeScene } = await __importLive('/src/engine/index.js');
    const saved = JSON.parse(JSON.stringify(serializeScene(__foliageEngine)));
    await deserializeScene(__foliageEngine, saved);
    __foliageSelection.getState().select(__foliageId);
  });
  await settleTree('distribution', 'placements');
  await settleTree('height', placedEdits.height); await settleTree('leafColor', placedEdits.leafColor);
  assert.deepEqual(await readPlacedState(), placedState, 'real scene reload preserves authored IDs, local data and runtime matrices');
  await page.waitForSelector('[data-foliage-section]');
  assert.equal(await (await control('Height')).evaluate(input => Number(input.value)), placedEdits.height);
  assert.equal(await (await control('Foliage color')).evaluate(input => input.value), placedEdits.leafColor);
  check('Native placed population and edited appearance survive scene reload', true);
  fs.writeFileSync(path.join(root, 'authored-placements.json'), JSON.stringify({ ...placedState, defaults: placedDefaults, edited: placedEdits }, null, 2));
  await page.screenshot({ path: path.join(root, "foliage-authoring.png") });
  check("No editor or WebGPU errors", errors.length === 0);
  console.log(`FOLIAGE-UI PASS\nArtifacts: ${root}`);
} catch (error) {
  console.error(error, errors);
  await page.screenshot({ path: path.join(root, "failure.png") }).catch(() => {});
  console.error(`FOLIAGE-UI FAIL\nArtifacts: ${root}`);
  process.exitCode = 1;
} finally { await browser.close(); }
