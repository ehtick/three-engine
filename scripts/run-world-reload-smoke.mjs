/** Focused real-editor World save/reload with native WebGPU resource receipts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { installTauriShim } from './lib/tauriShim.mjs';
import { installGPUTextureTrace } from './lib/gpuTextureTrace.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5405/';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-world-reload-'));
const project = path.join(scratch, 'project');
const out = path.resolve(process.env.WORLD_RELOAD_ARTIFACTS ?? 'artifacts/world-reload');
fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ name: 'World reload', version: 1, modules: [] }));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', userDataDir: path.join(scratch, 'profile'),
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'],
});
const page = await browser.newPage(); page.setDefaultTimeout(60000);
const errors = [], snapshots = []; let booted = false;
page.on('pageerror', error => errors.push(error.stack ?? String(error)));
page.on('console', message => {
  if (message.text() === 'Editor ready') booted = true;
  if (message.type() === 'error' || /GPUValidationError|validation error/i.test(message.text())) errors.push(message.text());
});
await installTauriShim(page, { writableRoot: project });
await page.evaluateOnNewDocument(({ oldAsync, oldShadow }) => {
  globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 };
  if (oldAsync) globalThis.__asyncRenderPipelinesStandIn = false;
  if (oldShadow) globalThis.__shadowTargetInitialization = false;
  globalThis.__reloadTrace = { destroyed: [], stale: [] };
  document.addEventListener('DOMContentLoaded', () => { const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = 'data:,'; document.head.append(icon); }, { once: true });
}, { oldAsync: !!process.env.WORLD_RELOAD_NO_STANDINS, oldShadow: !!process.env.WORLD_RELOAD_OLD_SHADOW });
if (process.env.WORLD_RELOAD_TRACE) await page.evaluateOnNewDocument(installGPUTextureTrace);
const settle = async (frames = Number(process.env.WORLD_RELOAD_FRAMES ?? 3)) => {
  await page.waitForFunction(() => {
    const world = __reloadEngine.getEntity(__reloadId)?.getComponent('world');
    if (world?.status === 'Error') throw new Error(world.error);
    return world?.status === 'Ready';
  }, { timeout: 150000 });
  await page.evaluate(async frames => {
    // Wait for the real material-build wave and deferred native pipelines.
    for (let i = 0; i < frames; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    await __reloadEngine.renderer.backend.device.queue.onSubmittedWorkDone();
  }, frames);
};
try {
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Skip the project'))?.click());
  await page.waitForSelector('.viewport-toolbar');
  const deadline = Date.now() + 60000;
  while (!booted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(booted, 'ordinary editor boot');
  await page.evaluate(async project => {
    const { ensureEngine } = await import('/src/editor/engineInstance.js');
    const { useProjectStore } = await import('/src/editor/store/projectStore.js');
    const { useSelectionStore } = await import('/src/editor/store/selectionStore.js');
    const { setViewportFreezeEnabled } = await import('/src/editor/viewportFreeze.js');
    const { resetEditorScene } = await import('/src/editor/sceneIO.js');
    await resetEditorScene();
    useProjectStore.setState({ rootPath: project, currentPath: project, projectMeta: { name: 'World reload', version: 1, modules: [] } });
    globalThis.__reloadEngine = await ensureEngine();
    __reloadEngine.sceneName = 'World reload'; setViewportFreezeEnabled(false);
    const { createWorld } = await import('/src/editor/worldBuild.js');
    globalThis.__reloadId = (await createWorld({ surfaceMode: 'procedural', forestDensity: .08, groundDensity: .03, layout: { mode: 'study' } }, { focus: true })).entityId;
    useSelectionStore.getState().clear();
  }, project);
  if (process.env.WORLD_RELOAD_DELAY_FIRST_SHADOW) await page.evaluate(async () => {
    const { ShadowNode } = globalThis.__ENGINE_THREE__;
    const update = ShadowNode.prototype.updateBefore, seen = new WeakSet();
    ShadowNode.prototype.updateBefore = function (...args) {
      if (!seen.has(this)) { seen.add(this); return; }
      return update.apply(this, args);
    };
  });
  await settle();
  if (process.env.WORLD_RELOAD_TRACE) await page.evaluate(() => {
    const engine = __reloadEngine, backend = engine.renderer.backend, draw = backend.draw;
    __reloadTrace.draws = [];
    backend.draw = function (object, ...args) {
      for (const group of object.getBindings()) if (__reloadInspectGroup(backend.get(group).group).length && __reloadTrace.draws.length < 5) {
        __reloadTrace.draws.push({ object: object.object.name, material: object.material.name, group: group.name,
          bindings: group.bindings.filter(binding => binding.isSampledTexture).map(binding => ({ name: binding.name, version: binding.version, generation: binding.generation,
            texture: { id: binding.texture?.id, version: binding.texture?.version, name: binding.texture?.name },
            liveData: { generation: engine.renderer._textures.get(binding.texture).generation, version: engine.renderer._textures.get(binding.texture).version },
            groupNode: { name: binding.groupNode?.name, updateType: binding.groupNode?.updateType, version: binding.groupNode?.version },
          })) });
      }
      return draw.call(this, object, ...args);
    };
  });
  const rounds = Number(process.env.WORLD_RELOAD_ROUNDS ?? 6);
  for (let round = 0; round < rounds; round++) {
    const snapshot = await page.evaluate(async () => {
      const engine = __reloadEngine, world = engine.getEntity(__reloadId).getComponent('world');
      const { getViewportHandle } = await import('/src/editor/viewportHandle.js');
      const viewport = getViewportHandle();
      let meshes = 0; engine.scene.traverseVisible(object => { if (object.isMesh) meshes++; });
      return { status: world.status, document: structuredClone(world.props.document), entities: engine.entities.size, meshes,
        sun: { id: engine.__atmosphere?._sun?.light?.id, shadow: !!engine.__atmosphere?._sun?.light?.shadow.map },
        camera: viewport.camera.position.toArray(), limit: engine.renderer.backend.device.limits.maxStorageBuffersPerShaderStage };
    });
    snapshots.push(snapshot); await page.screenshot({ path: path.join(out, `round-${round}.png`) });
    console.log(`ROUND ${round}: ${JSON.stringify(snapshot.sun)}, entities=${snapshot.entities}, errors=${errors.length}`);
    if (round === rounds - 1) break;
    await page.evaluate(async () => {
      const { saveScene, currentScenePath, openScenePath } = await import('/src/editor/sceneIO.js');
      await saveScene();
      for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      await openScenePath(currentScenePath());
    });
    await settle();
  }
  assert.deepEqual(snapshots[1].document, snapshots[0].document);
  assert.equal(snapshots[1].entities, snapshots[0].entities);
  assert.ok(snapshots.every(snapshot => snapshot.limit === 8 && snapshot.sun.shadow));
  await settle(120);
  const visiblePixels = await page.evaluate(async () => {
    const { captureFrameDownsampled } = await import('/src/editor/frameCopy.js');
    const pixels = await captureFrameDownsampled(__reloadEngine, { width: 320, height: 200 });
    if (!pixels) return null;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > pixels[i] * 1.08 && pixels[i + 1] > pixels[i + 2] * 1.1 && pixels[i + 1] > 35) green++;
    return { green, total: pixels.length / 4 };
  });
  snapshots.push({ visiblePixels });
  await page.screenshot({ path: path.join(out, 'settled-world.png') });
  assert.ok(visiblePixels?.green > 1000, 'reloaded native landscape contributes visible green pixels');
  assert.deepEqual(errors, [], 'no editor or WebGPU errors during scene replacement');
  console.log('WORLD-RELOAD PASS');
} catch (error) { errors.push(error.stack ?? String(error)); console.error(`WORLD-RELOAD FAIL: ${String(error.message).slice(0,600)}`); process.exitCode = 1; }
finally {
  const trace = await page.evaluate(() => __reloadTrace).catch(() => null);
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed: !process.exitCode, url, scratch, snapshots, errors, trace }, null, 2));
  await browser.close(); console.log(`Artifacts: ${out}`);
}
