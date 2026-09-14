/** Real editor World creation, native providers, persistent edits and scene IO.
 * Run serially, with the live editor stopped, against fresh Vite on :5401.
 * node scripts/run-world-ui-smoke.mjs [url]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { installTauriShim } from './lib/tauriShim.mjs';
import { installGPUTextureTrace } from './lib/gpuTextureTrace.mjs';
import { WORLD_SETTINGS } from '../src/engine/world/worldDocument.js';

const url = process.argv[2] ?? 'http://127.0.0.1:5401/';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-world-ui-'));
const project = path.join(scratch, 'project');
const out = path.resolve(process.env.WORLD_UI_ARTIFACTS ?? 'artifacts/world-ui');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ name: 'World UI smoke', version: 1, modules: [] }));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: process.env.HEADED ? false : 'new', userDataDir: path.join(scratch, 'profile'),
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.setDefaultTimeout(45000);
const errors = [], errorEvents = [], checks = [], snapshots = {};
const startedAt = Date.now();
const recordError = message => {
  errors.push(message);
  errorEvents.push({ afterCheck: checks.at(-1) ?? 'boot', elapsedMs: Date.now() - startedAt, message });
};
let booted = false;
page.on('pageerror', error => recordError(error.stack ?? error.message));
page.on('console', message => {
  if (message.text() === 'Editor ready') booted = true;
  if (message.type() === 'error' || /GPUValidationError|validation error|exceeds the maximum/i.test(message.text())) recordError(message.text());
});
const check = (name, value, detail) => {
  assert.ok(value, `${name}${detail ? `: ${detail}` : ''}`);
  checks.push(name); console.log(`PASS ${name}`);
};
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const clickText = async (selector, text, prefix = false) => {
  const handle = await page.waitForFunction((selector, text, prefix) => [...document.querySelectorAll(selector)]
    .find(element => !element.disabled && (prefix ? element.textContent.trim().startsWith(text) : element.textContent.trim() === text)), {}, selector, text, prefix);
  assert.ok(handle.asElement(), `Visible control ${text}`);
  await handle.asElement().click(); await handle.dispose();
};
const chord = async (key, shift = false) => {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
};
const shortcut = async (redo = false, key = 'KeyZ') => {
  await page.evaluate(() => document.activeElement?.blur());
  const bounds = await (await page.$('.viewport-panel canvas'))?.boundingBox();
  if (bounds) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await chord(key, redo);
};
const enter = async (label, value) => {
  await page.click(`[data-world-section] input[aria-label="${label}"]`, { clickCount: 3 });
  await chord('KeyA'); await page.keyboard.type(String(value)); await page.keyboard.press('Enter');
};
const tab = text => clickText('[data-world-section] .world-section-switch button', text);
const settle = async () => {
  await page.waitForFunction(() => {
    const world = __worldEngine.getEntity(__worldId)?.getComponent('world');
    if (world?.status === 'Error') throw new Error(world.error || 'World generation failed');
    return world?.status === 'Ready';
  }, { timeout: 150000 });
  await page.evaluate(async () => {
    const world = __worldEngine.getEntity(__worldId).getComponent('world');
    await world.whenReady();
    for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    await __worldEngine.renderer?.backend?.device?.queue.onSubmittedWorkDone();
  });
};
const snapshot = () => page.evaluate(() => {
  const entity = __worldEngine.getEntity(__worldId), world = entity?.getComponent('world');
  if (!world) return null;
  const hash = array => {
    if (!array) return null;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    let result = 2166136261;
    for (const byte of bytes) result = Math.imul(result ^ byte, 16777619);
    return result >>> 0;
  };
  let roof = null;
  const desiredRoofColor = world.getFeature('cottage')?.props.roofColor;
  const desired = desiredRoofColor ? new __ENGINE_THREE__.Color(desiredRoofColor).toArray() : [0, 0, 0];
  const targetMax = Math.max(...desired);
  world.getFeatureEntity('cottage')?.object3D.traverse(object => {
    if (!object.isMesh || object.userData.worldStudyRole !== 'roof') return;
    const colors = object.geometry.attributes.color?.array;
    let matching = 0;
    for (let i = 0; colors && i < colors.length; i += 3) {
      const maximum = Math.max(colors[i], colors[i + 1], colors[i + 2]);
      if (maximum > 0 && targetMax > 0 && desired.every((channel, axis) => Math.abs(colors[i + axis] / maximum - channel / targetMax) < .001)) matching++;
    }
    roof = { vertices: object.geometry.attributes.position.count, colorHash: hash(colors),
      positionHash: hash(object.geometry.attributes.position.array), matchingColorFraction: colors?.length ? matching / (colors.length / 3) : 0,
      visible: object.visible, renderable: !!object.material };
  });
  const terrain = world.getFeatureEntity('terrain')?.getComponent('terrain');
  const children = entity.children.map(child => ({ id: child.id, name: child.name,
    key: child.getComponent('world-feature')?.props.key, components: [...child.components.keys()],
    instances: child.getComponent('foliage')?.instances?.length ?? 0 }));
  const viewport = __worldViewport;
  return { entityId: entity.id, status: world.status, document: structuredClone(world.props.document), stats: { ...world.stats },
    selected: [...__worldSelection.getState().ids], undoDepth: __worldBus.undoStack.length, children,
    terrainVertices: terrain?.geometry?.attributes.position.count ?? 0, terrainHash: hash(terrain?.geometry?.attributes.position.array),
    roofColor: desiredRoofColor, roof,
    camera: { position: viewport.camera.position.toArray(), target: viewport.orbit.target.toArray(), quaternion: viewport.camera.quaternion.toArray() },
    storageLimit: __worldEngine.renderer?.backend?.device?.limits.maxStorageBuffersPerShaderStage };
});
const selectRow = async id => {
  const handle = await page.waitForFunction(id => [...document.querySelectorAll('.hierarchy-row[data-entity-id]')].find(row => row.dataset.entityId === id), {}, id);
  await handle.asElement().click(); await handle.dispose();
  await page.waitForFunction(id => __worldSelection.getState().ids[0] === id, {}, id);
};

try {
  await page.setViewport({ width: 1600, height: 1050, deviceScaleFactor: 1 });
  await installTauriShim(page, { writableRoot: project });
  if (process.env.WORLD_UI_TEXTURE_TRACE) await page.evaluateOnNewDocument(installGPUTextureTrace);
  await page.evaluateOnNewDocument(() => {
    globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 };
    document.addEventListener('DOMContentLoaded', () => {
      const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,'; document.head.append(icon);
    }, { once: true });
    globalThis.__importLive = modulePath => {
      const prefix = location.origin + modulePath;
      const fetched = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name === prefix || name.startsWith(`${prefix}?`));
      return import(fetched.find(name => name.includes('?')) ?? fetched[0] ?? modulePath);
    };
  });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Skip the project'))?.click());
  await page.waitForSelector('.viewport-toolbar', { timeout: 60000 });
  const bootDeadline = Date.now() + 60000;
  while (!booted && Date.now() < bootDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  check('Editor completes its ordinary boot', booted);
  await page.evaluate(async project => {
    const { ensureEngine } = await __importLive('/src/editor/engineInstance.js');
    const engine = await ensureEngine();
    const { useProjectStore } = await __importLive('/src/editor/store/projectStore.js');
    const { useSelectionStore } = await __importLive('/src/editor/store/selectionStore.js');
    const { useSceneStore } = await __importLive('/src/editor/store/sceneStore.js');
    const { commandBus } = await __importLive('/src/editor/commands/CommandBus.js');
    const { getViewportHandle } = await __importLive('/src/editor/viewportHandle.js');
    const { setViewportFreezeEnabled } = await __importLive('/src/editor/viewportFreeze.js');
    const { resetEditorScene } = await __importLive('/src/editor/sceneIO.js');
    const { openPanel } = await __importLive('/src/editor/EditorShell.jsx');
    useSelectionStore.getState().clear();
    await resetEditorScene();
    useProjectStore.setState({ rootPath: project, currentPath: project, projectMeta: { name: 'World UI smoke', version: 1, modules: [] } });
    engine.sceneName = 'World UI smoke'; useSceneStore.getState().refresh(); commandBus.clearHistory();
    setViewportFreezeEnabled(false); openPanel('hierarchy'); openPanel('inspector');
    Object.assign(globalThis, { __worldEngine: engine, __worldSelection: useSelectionStore, __worldScene: useSceneStore,
      __worldBus: commandBus, __worldViewport: getViewportHandle() });
  }, project);
  check('World creation is discoverable before its module is enabled', await page.evaluate(() => !__worldEngine.modules.has('world')));
  await page.click('.hierarchy-add-btn');
  check('Hierarchy Add presents Create World', await page.evaluate(() => [...document.querySelectorAll('.component-menu .dropdown-section-label')].some(label => label.textContent === 'Create World')));
  await shot('01-create-menu');
  await clickText('.component-menu .component-item', 'Temperate valley');
  await page.waitForFunction(() => {
    const entity = __worldEngine.getEntity(__worldSelection.getState().ids[0]);
    if (!entity?.getComponent('world')) return false;
    globalThis.__worldId = entity.id; return true;
  });
  await page.waitForSelector('[data-world-section]'); await settle();
  snapshots.default = await snapshot();
  assert.deepEqual(snapshots.default.document.settings, WORLD_SETTINGS);
  check('Actual default creation generates native Terrain, populated Foliage and a cottage',
    snapshots.default.terrainVertices >= 257 ** 2 && snapshots.default.children.some(child => child.components.includes('foliage') && child.instances > 0) && snapshots.default.roof?.vertices > 100);
  check('Creation selects the World inspector in one undo step', snapshots.default.selected[0] === snapshots.default.entityId && snapshots.default.undoDepth === 1);
  check('WebGPU uses the portable storage-buffer budget', snapshots.default.storageLimit === 8);
  check('Creation persists the World module to project.json', JSON.parse(fs.readFileSync(path.join(project, 'project.json'), 'utf8')).modules.includes('world'));
  await shot('02-default-world');

  // Preserve the mandatory default creation arm above. Subsequent UI actions
  // use a lighter population so this remains a functional editor gate.
  await enter('Tree density value', .08); await settle();
  let current = await snapshot();
  check('A parameter applies live, with no Apply step', current.document.settings.forestDensity === .08 && current.undoDepth === 1);
  await enter('Ground cover value', .03); await settle();
  current = await snapshot();
  check('Each live parameter edit is one undo command', current.document.settings.groundDensity === .03 && current.undoDepth === 2);
  check('The staging Apply button is gone', !(await page.$$eval('[data-world-section] button', nodes => nodes.map(node => node.textContent))).some(text => /Apply landscape/.test(text)));
  await tab('Look'); await page.click('[data-world-section] button[aria-label="Ground finish"]');
  await clickText('.tx-select-menu button', 'Procedural'); await settle();
  snapshots.beforeRoof = await snapshot();
  check('Ground finish changes through the real dropdown', snapshots.beforeRoof.document.settings.surfaceMode === 'procedural');

  await tab('Local edits'); await enter('Cottage roof color', '#23c6d8'); await settle();
  snapshots.customRoof = await snapshot();
  check('Arbitrary roof color changes actual submitted vertex colors', snapshots.customRoof.roofColor === '#23c6d8' &&
    snapshots.customRoof.roof.colorHash !== snapshots.beforeRoof.roof.colorHash && snapshots.customRoof.roof.matchingColorFraction > .5);
  assert.equal(snapshots.customRoof.roof.positionHash, snapshots.beforeRoof.roof.positionHash, 'Color edit preserves roof geometry');
  assert.equal(snapshots.customRoof.undoDepth, snapshots.beforeRoof.undoDepth + 1, 'One roof edit is one undo command');
  await shortcut(); await settle(); current = await snapshot();
  assert.deepEqual(current.document, snapshots.beforeRoof.document);
  assert.deepEqual(current.roof, snapshots.beforeRoof.roof);
  await shortcut(true); await settle(); current = await snapshot();
  assert.deepEqual(current.document, snapshots.customRoof.document);
  assert.deepEqual(current.roof, snapshots.customRoof.roof);
  check('Keyboard undo and redo restore the exact roof document and geometry colors', true);

  await tab('Landscape'); await clickText('[data-world-section] button', 'Regenerate'); await settle();
  snapshots.regenerated = await snapshot();
  check('Regenerate advances the seed and keeps the authored roof color', snapshots.regenerated.document.settings.seed === snapshots.customRoof.document.settings.seed + 1 && snapshots.regenerated.roofColor === '#23c6d8');
  assert.deepEqual(snapshots.regenerated.document.edits, snapshots.customRoof.document.edits);
  assert.ok(snapshots.regenerated.roof.matchingColorFraction > .5, 'Regenerated cottage keeps authored roof color on its current geometry');
  assert.deepEqual(snapshots.regenerated.camera, snapshots.customRoof.camera, 'Regeneration keeps the free viewport pose');
  await shortcut(); await settle(); assert.deepEqual((await snapshot()).document, snapshots.customRoof.document);
  await shortcut(true); await settle(); assert.deepEqual((await snapshot()).document, snapshots.regenerated.document);
  check('Regeneration uses ordinary keyboard undo and redo', true);

  await tab('Look'); await clickText('.world-look-options button', 'Stylized', true); await settle();
  snapshots.stylized = await snapshot();
  check('Stylized look preserves the custom roof in actual geometry', snapshots.stylized.document.settings.style === 'stylized' && snapshots.stylized.roofColor === '#23c6d8' && snapshots.stylized.roof.matchingColorFraction > .5);
  await tab('Local edits'); await clickText('[data-world-section] button', 'Reset roof color'); await settle();
  snapshots.reset = await snapshot();
  check('Reset roof color returns to the generated look', !snapshots.reset.document.edits.some(edit => edit.target === 'cottage' && edit.property === 'roofColor') && snapshots.reset.roofColor !== '#23c6d8' && snapshots.reset.roof.colorHash !== snapshots.stylized.roof.colorHash);
  await shortcut(); await settle(); assert.deepEqual((await snapshot()).roof, snapshots.stylized.roof);
  check('Reset is reversible through keyboard undo', true);
  await shot('03-local-roof-edit');

  const cottageId = snapshots.stylized.children.find(child => child.key === 'cottage').id;
  const terrainId = snapshots.stylized.children.find(child => child.key === 'terrain').id;
  const disclosure = await page.$(`.hierarchy-row[data-entity-id="${snapshots.stylized.entityId}"] .row-disclosure.collapsed`);
  if (disclosure) await disclosure.click();
  await selectRow(cottageId); await page.waitForSelector('.world-owner-link button');
  check('Generated cottage is a real selectable hierarchy entity', await page.evaluate(id => __worldSelection.getState().ids[0] === id && document.querySelector('.entity-name-field')?.value === 'Cottage', cottageId));
  await page.click('.world-owner-link button'); await page.waitForSelector('[data-world-section]');
  await tab('Local edits'); await clickText('[data-world-section] button', 'Select terrain');
  await page.waitForFunction(id => __worldSelection.getState().ids[0] === id, {}, terrainId);
  await page.waitForSelector('.inspector-panel button[title^="Sculpt terrain height"]');
  await page.click('.inspector-panel button[title^="Sculpt terrain height"]');
  check('Select terrain exposes and arms the native sculpt controls', await page.evaluate(async () => (await __importLive('/src/editor/terrainBrush.js')).getTerrainBrushMode() === 'sculpt'));
  await page.click('.inspector-panel button[title^="Sculpt terrain height"]');
  await shot('04-native-terrain-inspector');
  await page.click('.world-owner-link button'); await page.waitForSelector('[data-world-section]');
  await settle();

  await shortcut(false, 'KeyS');
  await page.waitForFunction(async () => !!(await __importLive('/src/editor/sceneIO.js')).currentScenePath() && !__worldScene.getState().dirty);
  const savedPath = await page.evaluate(async () => (await __importLive('/src/editor/sceneIO.js')).currentScenePath());
  check('Ctrl+S saves a real scene under the scratch project', savedPath.startsWith(project) && fs.existsSync(savedPath));
  const savedScene = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  const savedWorld = savedScene.entities.find(entity => entity.id === snapshots.default.entityId);
  snapshots.saved = await snapshot();
  assert.deepEqual(savedWorld.components.find(component => component.type === 'world').props.document, snapshots.saved.document);
  fs.writeFileSync(path.join(out, 'saved-world-document.json'), JSON.stringify(snapshots.saved.document, null, 2));
  await page.evaluate(() => __worldSelection.getState().clear());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(async savedPath => {
    const { openScenePath } = await __importLive('/src/editor/sceneIO.js');
    await openScenePath(savedPath);
    __worldSelection.getState().select(__worldId);
  }, savedPath);
  await settle(); await page.waitForSelector('[data-world-section]');
  snapshots.reloaded = await snapshot();
  assert.deepEqual(snapshots.reloaded.document, snapshots.saved.document);
  assert.deepEqual(snapshots.reloaded.roof, snapshots.saved.roof);
  assert.equal(snapshots.reloaded.terrainHash, snapshots.saved.terrainHash);
  assert.deepEqual(snapshots.reloaded.children.map(child => [child.id, child.key, child.components]).sort(), snapshots.saved.children.map(child => [child.id, child.key, child.components]).sort());
  check('Ordinary scene reload restores the document, actual roof and terrain, and native provider IDs without duplicates', true);
  await tab('Local edits');
  check('Reloaded inspector displays the preserved arbitrary roof color', await page.$eval('[data-world-section] input[aria-label="Cottage roof color"]', input => input.value === '#23c6d8'));
  await shot('05-reloaded-world');
  check('No editor or WebGPU validation errors', errors.length === 0, errors.join('\n'));
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed: true, url, scratch, savedPath, checks, errors, errorEvents, snapshots }, null, 2));
  console.log(`WORLD-UI PASS\nArtifacts: ${out}\nScratch project: ${project}`);
} catch (error) {
  await shot('failure').catch(() => {});
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed: false, url, scratch, checks, error: error.stack ?? String(error), errors, errorEvents, snapshots }, null, 2));
  console.error(`WORLD-UI FAIL\n${error.stack ?? error}\n${errors.join('\n')}\nArtifacts: ${out}\nScratch: ${scratch}`);
  process.exitCode = 1;
} finally {
  if (process.env.WORLD_UI_TEXTURE_TRACE) fs.writeFileSync(path.join(out, 'texture-trace.json'), JSON.stringify(await page.evaluate(() => __reloadTrace).catch(() => null), null, 2));
  await browser.close();
}
