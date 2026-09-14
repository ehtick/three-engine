import puppeteer from 'puppeteer-core';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5401/scripts/world-valley-study.html';
const output = resolve(process.argv[3] ?? 'artifacts/world-performance');
const dpr = Number(process.env.WORLD_PROFILE_DPR ?? 1);
const seconds = Number(process.env.WORLD_PROFILE_SECONDS ?? 4);
const poses = (process.env.WORLD_PROFILE_POSES ?? 'valley,shore,forest,cottage').split(',');
await mkdir(output, { recursive: true });
const oldWeather = process.env.WORLD_PROFILE_OLD_WEATHER === '1';
const oldOrder = process.env.WORLD_PROFILE_OLD_ORDER === '1';
const depth = process.env.WORLD_PROFILE_DEPTH === '1';
const masks = (process.env.WORLD_PROFILE_MASKS ?? 'none,ground,trees,foliage,water,terrain,shadows,none').split(',');
const diagnosticPose = process.env.WORLD_PROFILE_DIAGNOSTIC_POSE ?? 'valley';
const report = { pass: false, url, dpr, oldWeather, oldOrder, depthPrepass: depth, timestamp: new Date().toISOString(), isolation: process.env.WORLD_PROFILE_ISOLATED === '1', samples: [], errors: [] };
const receipt = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
await receipt();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: await mkdtemp(join(tmpdir(), 'world-performance-')), headless: true,
  args: ['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(({ oldWeather, oldOrder, depth }) => {
    globalThis.__atmosphereDrySurfaceBranch = !oldWeather;
    globalThis.__foliageFrontToBack = !oldOrder;
    globalThis.__worldDepthPrepass = depth;
  }, { oldWeather, oldOrder, depth });
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: dpr });
  page.on('pageerror', e => report.errors.push(e.stack ?? e.message));
  page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__WORLD_STUDY_RESULT__, { timeout: 200000 });
  report.initial = await page.evaluate(() => globalThis.__WORLD_STUDY_RESULT__);
  if (!report.initial.pass) throw new Error(JSON.stringify(report.initial));
  if (report.initial.treeDepthPrepass !== depth) throw new Error('Requested depth arm must match the actual World preview');
  if (depth && !report.initial.treeDepthBatches) throw new Error('Depth arm must have actual eligible native tree batches');
  const settle = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2200)));
  await page.evaluate(() => { globalThis.__WORLD_STUDY__.resetSun(); document.body.classList.add('capture'); });
  await settle();
  report.canvas = await page.evaluate(() => ({ width: document.querySelector('canvas').width, height: document.querySelector('canvas').height, dpr: devicePixelRatio }));
  for (const pose of poses) {
    await page.evaluate(pose => globalThis.__WORLD_STUDY__.moveCamera(pose), pose);
    await settle();
    await page.screenshot({ path: join(output, `${pose}.png`) });
    const result = await page.evaluate(async seconds => {
      const api = globalThis.__WORLD_STUDY__, e = globalThis.__WORLD_STUDY_ENGINE__;
      return { ...(await api.measure({ seconds })), stats: e.stats.readout, camera: api.cameraState(), layers: api.study.populations.map(p => ({ species: p.props.species, ...p.stats })) };
    }, seconds);
    report.samples.push({ pose, ...result }); await receipt();
    console.log('WORLD PROFILE', JSON.stringify({ pose, fps: result.presentedFps, cpu: result.cpu, gpu: result.gpu, counts: result.meanPerFrame }));
  }
  await page.evaluate(() => globalThis.__WORLD_STUDY__.moveCamera('valley'));
  await settle();
  const moving = await page.evaluate(seconds => globalThis.__WORLD_STUDY__.measure({ seconds, movingSun: true }), seconds);
  report.samples.push({ pose: 'valley-moving-sun', ...moving }); await receipt();
  console.log('WORLD PROFILE MOVING', JSON.stringify(moving));
  if (process.env.WORLD_PROFILE_ORBIT === '1') {
    await page.evaluate(() => globalThis.__WORLD_STUDY__.resetSun());
    await settle();
    const orbit = await page.evaluate(async () => {
      const e = globalThis.__WORLD_STUDY_ENGINE__, api = globalThis.__WORLD_STUDY__;
      const eye = e.camera.position.clone(), target = api.controls.target.clone();
      const offset = eye.clone().sub(target), start = performance.now(), duration = 8000;
      const off = e.onUpdate(() => {
        const angle = (performance.now() - start) / duration * Math.PI * 2;
        e.camera.position.set(target.x + offset.x * Math.cos(angle) + offset.z * Math.sin(angle), eye.y,
          target.z - offset.x * Math.sin(angle) + offset.z * Math.cos(angle));
        e.camera.lookAt(target);
      });
      try { return await api.measure({ seconds: duration / 1000, movingSun: true }); }
      finally { off(); api.moveCamera('valley'); api.resetSun(); }
    });
    report.samples.push({ pose: 'orbit-moving-sun', ...orbit }); await receipt();
    console.log('WORLD PROFILE ORBIT', JSON.stringify(orbit));
  }
  if (process.env.WORLD_PROFILE_DIAGNOSTICS === '1') {
    await page.evaluate(() => globalThis.__WORLD_STUDY__.resetSun());
    await page.evaluate(pose => globalThis.__WORLD_STUDY__.moveCamera(pose), diagnosticPose);
    for (const mask of masks) {
      await page.evaluate(mask => {
        const e = globalThis.__WORLD_STUDY_ENGINE__, s = globalThis.__WORLD_STUDY__.study;
        globalThis.__worldProfileOff?.();
        for (const p of s.populations) {
          p._profileOriginalChunks ??= p.chunks.slice();
          p.chunks = p._profileOriginalChunks.slice();
          if (mask === 'front' || mask === 'back') {
            const eye = e.camera.position;
            p.chunks.sort((a, b) => (mask === 'front' ? 1 : -1) * (a.detailBounds.distanceToPoint(eye) - b.detailBounds.distanceToPoint(eye)));
          }
          p._batchDirty = true;
        }
        globalThis.__worldProfileOff = e.onPreRender(() => {
          for (const p of s.populations) {
            const low = ['grass', 'wildflowers'].includes(p.props.species);
            p.root.visible = !(mask === 'foliage' || mask === 'ground' && low || mask === 'trees' && !low);
            if (mask === 'wind') p.uniforms.strength.value = 0;
            for (const mesh of p.renderMeshes) mesh.castShadow = mask !== 'shadows' && p.props.castShadow;
          }
          s.water.visible = mask !== 'water';
          s.terrain.mesh.visible = mask !== 'terrain';
        });
      }, mask);
      await settle();
      const result = await page.evaluate(seconds => globalThis.__WORLD_STUDY__.measure({ seconds }), seconds);
      report.samples.push({ pose: diagnosticPose, diagnosticMask: mask, ...result }); await receipt();
      console.log('WORLD PROFILE MASK', JSON.stringify({ mask, fps: result.presentedFps, cpu: result.cpu, gpu: result.gpu, counts: result.meanPerFrame }));
    }
  }
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  report.pass = true;
} catch (e) { report.failure = e.stack ?? String(e); throw e; }
finally { await receipt(); await browser.close(); }
