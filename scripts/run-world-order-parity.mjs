import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Serial functional GPU gate: the actual World scene, native canvas, alpha
// cutouts, lighting, wind and shadows. This runner makes no FPS claim.
const url = process.argv[2] ?? 'http://127.0.0.1:5401/scripts/world-valley-study.html';
const depthMode = process.env.WORLD_PARITY_DEPTH === '1';
const output = resolve(process.argv[3] ?? (depthMode ? 'artifacts/world-depth-parity' : 'artifacts/world-order-parity'));
const profile = await mkdtemp(join(tmpdir(), 'world-order-parity-'));
await mkdir(output, { recursive: true });
const report = { pass: false, mode: depthMode ? 'tree-depth-prepass' : 'opaque-chunk-order', url, timestamp: new Date().toISOString(), cases: [], errors: [],
  tolerance: `${depthMode ? 'Depth prepass has no additional coplanar-tie allowance.' : 'Reordered opaque coplanar depth ties: mean RGB error <= 0.03 byte, <= 0.1% pixels over 8 bytes, <= 0.02% over 32.'} First/settled and restored pixels must be exact unless same-order no-op controls in that case demonstrate native 1-byte variation; then maximum 1 byte and <= 0.05% changed pixels. In depth mode the same strict rule applies to off/on pixels.` };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
let browser, page;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: profile, protocolTimeout: 240000,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { globalThis.__worldDepthPrepass = false; });
  page.on('pageerror', error => report.errors.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error' || /GPUValidationError|WebGPU validation|exceeds the maximum/i.test(message.text())) report.errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__WORLD_STUDY_RESULT__, { timeout: 220000 });
  report.initial = await page.evaluate(() => __WORLD_STUDY_RESULT__);
  assert.equal(report.initial.pass, true, JSON.stringify(report.initial)); assert.equal(report.initial.storageLimit, 8);
  for (const pose of ['valley', 'forest', 'shore']) {
    await page.evaluate(pose => __WORLD_STUDY__.moveCamera(pose), pose);
    await new Promise(resolve => setTimeout(resolve, 1400));
  }
  await page.evaluate(async () => {
    const engine = __WORLD_STUDY_ENGINE__, renderer = engine.renderer;
    engine.stop(); await renderer.backend.device.queue.onSubmittedWorkDone();
    document.body.classList.add('capture');
    const frame = renderer._nodes.nodeFrame;
    // Advance update identities, holding time itself. Freezing frameId would
    // bypass native matrix synchronization instead of testing a real new frame.
    const state = globalThis.__WORLD_ORDER_PARITY__ = { images: {}, deltaTime: engine.deltaTime, nodeUpdate: frame.update,
      time: frame.time, elapsed: engine.elapsedTime, oldFlag: globalThis.__foliageFrontToBack };
    engine.deltaTime = 0;
    frame.update = function () { this.frameId++; this.deltaTime = 0; this.time = state.time; };
    if (!renderer.shadowMap.enabled || engine.loopActive) throw new Error('Require native shadows and a fully stopped engine loop');
  });
  const render = (order, frames = 1) => page.evaluate(async (order, frames) => {
    const engine = __WORLD_STUDY_ENGINE__, { study } = __WORLD_STUDY__, renderer = engine.renderer, backend = renderer.backend;
    if (engine.loopActive) throw new Error('Parity must hold the whole engine loop');
    globalThis.__foliageFrontToBack = order;
    for (const layer of study.populations) layer.update();
    const state = __WORLD_ORDER_PARITY__;
    if (state.depth) {
      if (state.depthEnabled) state.depth.sync();
      else for (const { mesh } of state.depth.entries) mesh.visible = false;
    }
    engine.scene.updateMatrixWorld(true);
    const layers = study.populations.map(layer => {
      // Compare complete GPU records against canonical source records, with
      // multiplicity. The render stream may permute them, never modify them.
      const levels = layer.renderMeshes.map((mesh, lod) => {
        const names = lod < 2 ? ['matrix'] : ['aCenter', 'aSize', 'aAxisX', 'aAxisY'];
        const attributes = object => names.map(name => name === 'matrix' ? object.instanceMatrix : object.geometry.attributes[name]);
        const record = (attrs, i) => attrs.flatMap(attr => Array.from(attr.array.subarray(i * attr.itemSize, (i + 1) * attr.itemSize))).join(',');
        const expected = new Map(); let count = 0;
        for (const chunk of layer.chunks.filter(chunk => chunk.level === lod)) for (let i = 0; i < chunk.instances.length; i++) {
          const key = record(attributes(chunk.meshes[lod]), i); expected.set(key, (expected.get(key) ?? 0) + 1); count++;
        }
        const actual = lod < 2 ? mesh.count : mesh.geometry.instanceCount;
        if (actual !== count) throw new Error('Repacking dropped or duplicated selected plants');
        for (let i = 0; i < actual; i++) {
          const key = record(attributes(mesh), i), remaining = expected.get(key);
          if (!remaining) throw new Error('A submitted world matrix or impostor record differs from its source');
          if (remaining === 1) expected.delete(key); else expected.set(key, remaining - 1);
        }
        if (expected.size) throw new Error('Not every source plant reached the batch');
        return { instances: count, castShadow: mesh.castShadow, geometry: mesh.geometry.uuid };
      });
      return { id: layer.entity.id, roots: layer.instances.length, levels };
    });
    const batches = new Map(study.populations.flatMap(layer => layer.renderMeshes.map((mesh, lod) => [mesh, `${layer.entity.id}/${lod}`])));
    const depthEntries = state.depthEnabled ? state.depth.entries : [];
    for (const { source, mesh } of depthEntries) {
      if (mesh.geometry !== source.geometry || mesh.instanceMatrix !== source.instanceMatrix || mesh.count !== source.count || mesh.castShadow || mesh.receiveShadow || mesh.material.colorWrite) {
        throw new Error('Depth proxy must borrow the exact native geometry/matrices/count and never cast shadows or write color');
      }
    }
    const depthMeshes = new Map(depthEntries.map(entry => [entry.mesh, batches.get(entry.source)]));
    const draw = backend.draw; let submitted, shadowDraws, depthSubmitted;
    backend.draw = function (object, ...args) {
      if (batches.has(object.object)) {
        if (object.camera === engine.camera && object.material === object.object.material) submitted[batches.get(object.object)] = object.getDrawParameters()?.instanceCount;
        else if (object.object.castShadow) shadowDraws++;
      }
      if (depthMeshes.has(object.object)) {
        if (object.camera !== engine.camera || object.material !== object.object.material) throw new Error('Depth specimen leaked into another render pass');
        depthSubmitted[depthMeshes.get(object.object)] = object.getDrawParameters()?.instanceCount;
      }
      return draw.call(this, object, ...args);
    };
    try {
      for (let i = 0; i < frames; i++) {
        submitted = {}; shadowDraws = 0; depthSubmitted = {};
        engine.scene.traverse(object => { if (object.isLight && object.castShadow && object.shadow) object.shadow.needsUpdate = true; });
        renderer._nodes.nodeFrame.update();
        await renderer.renderAsync(engine.scene, engine.camera); await backend.device.queue.onSubmittedWorkDone();
      }
    } finally { backend.draw = draw; }
    if (!Object.keys(submitted).length || !shadowDraws) throw new Error('Actual native foliage and shadow draws must reach the GPU');
    if (state.depthEnabled) {
      const expected = Object.fromEntries(depthEntries.map(entry => batches.get(entry.source)).filter(key => key in submitted).map(key => [key, submitted[key]]));
      const canonicalJSON = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (!Object.keys(expected).length || canonicalJSON(expected) !== canonicalJSON(depthSubmitted)) throw new Error('Every visible native tree geometry batch needs exactly one same-count main-pass depth draw');
    }
    return { layers, submitted, shadowDraws, depthSubmitted, orderKeys: study.populations.map(layer => layer._orderDirection?.key ?? null),
      windTimes: study.populations.map(layer => layer.uniforms.time.value), materialTime: renderer._nodes.nodeFrame.time };
  }, order, frames);
  const installDepth = () => page.evaluate(async () => {
    const engine = __WORLD_STUDY_ENGINE__, state = __WORLD_ORDER_PARITY__;
    if (engine.modules?.get('gi')?.system || engine.scene.overrideMaterial || engine.renderer.getMRT()) throw new Error('Depth specimen currently supports only the World study main pass without GI');
    if (!state.depth) {
      const { installWorldDepthPrepass } = await import('/scripts/lib/worldDepthPrepassStudy.js');
      state.depth = installWorldDepthPrepass(engine, __WORLD_STUDY__.study.populations);
      // Compile without drawing: the next captured frame is still the first
      // actual depth render. This separates readiness from pixel correctness.
      await engine.renderer.compileAsync(engine.scene, engine.camera);
      await engine.renderer.backend.device.queue.onSubmittedWorkDone();
    }
    state.depthEnabled = true;
  });
  const disposeDepth = () => page.evaluate(() => { const state = __WORLD_ORDER_PARITY__; state.depth?.dispose(); state.depth = null; state.depthEnabled = false; });
  const capture = async name => {
    const png = await page.screenshot({ encoding: 'base64' }); await writeFile(join(output, `${name}.png`), Buffer.from(png, 'base64'));
    await page.evaluate(async (name, png) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      __WORLD_ORDER_PARITY__.images[name] = context.getImageData(0, 0, image.width, image.height).data;
    }, name, png);
  };
  const compare = (a, b) => page.evaluate((a, b) => {
    const first = __WORLD_ORDER_PARITY__.images[a], second = __WORLD_ORDER_PARITY__.images[b];
    if (first.length !== second.length) throw new Error('Same physical canvas required');
    let sum = 0, changed = 0, over8 = 0, over32 = 0, maximum = 0;
    const coordinates = [], width = __WORLD_STUDY_ENGINE__.renderer.domElement.width;
    for (let i = 0; i < first.length; i += 4) {
      let delta = 0;
      for (let c = 0; c < 3; c++) { const difference = Math.abs(first[i + c] - second[i + c]); delta = Math.max(delta, difference); sum += difference; }
      maximum = Math.max(maximum, delta); if (delta) changed++; if (delta > 8) over8++; if (delta > 32) over32++;
      if (delta && coordinates.length < 128) coordinates.push({ x: (i / 4) % width, y: Math.floor(i / 4 / width), before: [...first.subarray(i, i + 3)], after: [...second.subarray(i, i + 3)] });
    }
    const pixels = first.length / 4;
    return { meanAbsoluteBytes: sum / (pixels * 3), pixels, changed, over8: over8 / pixels, over32: over32 / pixels, maximum, coordinates };
  }, a, b);
  const cases = [['valley', 0], ['forest', 0], ['shore', 0], ['forest', 55], ['forest', -55]];
  if (depthMode) cases.push(['valley', 0, 'lod-repack']);
  for (const [pose, angle, repack] of cases) {
    const name = `${pose}-${angle}${repack ? `-${repack}` : ''}`;
    let primed = null;
    if (repack) {
      await page.evaluate(() => __WORLD_STUDY__.moveCamera('forest'));
      await render(true, 2); await installDepth(); primed = await render(true, 2);
      await page.evaluate(() => { __WORLD_ORDER_PARITY__.depthEnabled = false; });
    }
    await page.evaluate((pose, angle) => { __WORLD_STUDY__.moveCamera(pose); __WORLD_STUDY_ENGINE__.camera.rotateY(angle * Math.PI / 180); }, pose, angle);
    const old = await render(depthMode, 3); await capture(`${name}-old`);
    // Calibrate the native canvas's quantization floor before any permutation.
    // Each control keeps canonical order, camera, clocks, geometry and shading;
    // one pair also repeats only the screenshot, without another GPU render.
    const noop = [];
    await capture(`${name}-same-frame`); noop.push({ kind: 'same submitted frame', pixels: await compare(`${name}-old`, `${name}-same-frame`) });
    for (let i = 0; i < 3; i++) {
      const receipt = await render(depthMode); await capture(`${name}-noop-${i}`);
      assert.deepEqual(receipt.layers, old.layers); assert.deepEqual(receipt.submitted, old.submitted);
      assert.deepEqual(receipt.windTimes, old.windTimes); assert.equal(receipt.materialTime, old.materialTime);
      noop.push({ kind: 'canonical rerender', pixels: await compare(`${name}-old`, `${name}-noop-${i}`) });
    }
    if (depthMode) await installDepth();
    const sorted = await render(true); await capture(`${name}-first`);
    const settled = await render(true, 2); await capture(`${name}-settled`);
    if (depthMode) await disposeDepth();
    const restored = await render(depthMode); await capture(`${name}-restored`);
    const nativeByteVariation = noop.some(control => control.pixels.maximum === 1) && noop.every(control => control.pixels.maximum <= 1 && control.pixels.changed <= control.pixels.pixels * .0005);
    const result = { name, old, sorted, settled, restored, primed, noop, nativeByteVariation, pixels: await compare(`${name}-old`, `${name}-first`),
      firstFrame: await compare(`${name}-first`, `${name}-settled`), restoration: await compare(`${name}-old`, `${name}-restored`) };
    report.cases.push(result);
    for (const receipt of [sorted, settled, restored]) {
      assert.deepEqual(receipt.layers, old.layers, 'actual roots, selected geometry/counts and caster flags are unchanged');
      assert.deepEqual(receipt.submitted, old.submitted, 'identical native main-camera draw counts');
      assert.equal(receipt.shadowDraws, old.shadowDraws, 'depth work or order changes never add native shadow draws');
      assert.deepEqual(receipt.windTimes, old.windTimes); assert.equal(receipt.materialTime, old.materialTime);
    }
    if (depthMode) assert.ok(result.pixels.maximum <= (nativeByteVariation ? 1 : 0) && result.pixels.changed <= (nativeByteVariation ? result.pixels.pixels * .0005 : 0), `Depth must preserve pixels within the calibrated native floor: ${JSON.stringify(result.pixels)}`);
    else assert.ok(result.pixels.meanAbsoluteBytes <= .03 && result.pixels.over8 <= .001 && result.pixels.over32 <= .0002, `Only rare coplanar ties may change: ${JSON.stringify(result.pixels)}`);
    for (const [key, pixels] of [['firstFrame', result.firstFrame], ['restoration', result.restoration]]) {
      assert.ok(pixels.maximum <= (nativeByteVariation ? 1 : 0) && pixels.changed <= (nativeByteVariation ? pixels.pixels * .0005 : 0),
        `${key} must match held pixels; only a measured same-case native quantization floor permits 1 byte: ${JSON.stringify({ nativeByteVariation, maximum: pixels.maximum, changed: pixels.changed })}`);
    }
    if (angle && !depthMode) assert.notDeepEqual(sorted.orderKeys, old.orderKeys, 'the real camera move crosses a coarse order bin');
    if (depthMode) {
      assert.deepEqual(old.depthSubmitted, {}); assert.deepEqual(restored.depthSubmitted, {});
      assert.ok(Object.keys(sorted.depthSubmitted).length > 0); assert.deepEqual(settled.depthSubmitted, sorted.depthSubmitted);
      if (primed) assert.notDeepEqual(primed.layers.map(layer => layer.levels.map(level => level.instances)), old.layers.map(layer => layer.levels.map(level => level.instances)), 'the retained proxies encounter a real native LOD repack');
    }
    await page.evaluate(() => { __WORLD_ORDER_PARITY__.images = {}; });
    const { coordinates, ...pixelSummary } = result.pixels;
    console.log(depthMode ? 'WORLD-DEPTH case' : 'WORLD-ORDER case', name, JSON.stringify({ ...pixelSummary, nativeByteVariation }));
  }
  assert.deepEqual(await page.evaluate(() => __WORLD_STUDY__.errors), []); assert.deepEqual(report.errors, []);
  report.pass = true; console.log(depthMode ? 'WORLD-DEPTH PASS' : 'WORLD-ORDER PASS', output);
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1; console.error(depthMode ? 'WORLD-DEPTH FAIL' : 'WORLD-ORDER FAIL', report.failure);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await page?.evaluate(() => {
    const saved = globalThis.__WORLD_ORDER_PARITY__; if (!saved) return;
    saved.depth?.dispose();
    __WORLD_STUDY_ENGINE__.deltaTime = saved.deltaTime; __WORLD_STUDY_ENGINE__.renderer._nodes.nodeFrame.update = saved.nodeUpdate;
    globalThis.__foliageFrontToBack = saved.oldFlag;
  }).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close();
}
