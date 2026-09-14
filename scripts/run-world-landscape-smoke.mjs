import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createValleyFields } from '../src/engine/world/landscapeFields.js';

// Run serially on a real WebGPU adapter with the editor loop isolated. This
// checks functionality and actual pixels; it does not certify the art target.
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5401/scripts/world-valley-study.html');
const output = resolve(process.argv[3] ?? 'artifacts/world-landscape-smoke');
const skipSkyPrepare = process.env.WORLD_STUDY_SKIP_SKY_PREPARE === '1';
const checkCurrentTerrainSource = result => {
  const current = createValleyFields(result.fieldsSettings);
  for (const probe of result.sourceProbes) assert.ok(Math.abs(probe.height - Math.fround(current.sampleHeight(probe.x, probe.z))) < 1e-5,
    `rendered terrain at ${probe.x},${probe.z} must match the current source on disk; restart a stale Vite module cache`);
};
url.searchParams.delete('baseline'); url.searchParams.set('style', 'natural');
url.searchParams.delete('roof'); // Begin with generated color before exercising the artistic override.
url.searchParams.set('seed', '894'); url.searchParams.set('forest', '1'); url.searchParams.set('ground', '1');
url.searchParams.set('surface', 'materials'); url.searchParams.set('surfaceScale', '1'); url.searchParams.set('surfaceBump', '1');
url.searchParams.set('treeScale', '1'); url.searchParams.set('grassHeight', '1'); url.searchParams.set('patchiness', '.65');
const profile = await mkdtemp(join(tmpdir(), 'world-landscape-smoke-'));
await mkdir(output, { recursive: true });
const report = { pass: false, scope: 'functional GPU coverage, not visual-quality acceptance', url: url.href,
  timestamp: new Date().toISOString(), skipSkyPrepare, skyPrepareInterceptions: 0, errors: [] };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
let browser, page;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: profile, protocolTimeout: 240000,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  if (skipSkyPrepare) {
    await page.setRequestInterception(true);
    page.on('request', async request => {
      if (new URL(request.url()).pathname !== '/src/modules/atmosphere/prepareSkyEnvironment.js') return request.continue();
      try {
        // Fetch Vite's resolved module, preserving its imports and every other
        // export. This arm removes only the new preparation call's behavior.
        const response = await fetch(request.url());
        if (!response.ok) throw new Error(`Sky preparation negative source: HTTP ${response.status}`);
        const source = await response.text();
        const entry = /(function prepareSkyEnvironment\s*\([^)]*\)\s*\{)/;
        if (!entry.test(source)) throw new Error('Cannot intercept the actual prepareSkyEnvironment export');
        const body = source.replace(entry, '$1\n return false; // retained missing-sky-preparation negative control\n');
        report.skyPrepareInterceptions++;
        await request.respond({ status: 200, contentType: 'text/javascript', body });
      } catch (error) { report.errors.push(error.stack ?? error.message); await request.abort(); }
    });
  }
  page.on('pageerror', error => report.errors.push(error.stack ?? error.message));
  page.on('console', message => {
    if (message.type() === 'error' || /GPUValidationError|WebGPU validation|exceeds the maximum|invalid.*pipeline/i.test(message.text())) report.errors.push(message.text());
    if (message.text().startsWith('WORLD-STUDY')) console.log(message.text());
  });
  const ready = async () => {
    await page.waitForFunction(() => globalThis.__WORLD_STUDY_RESULT__, { timeout: 220000 });
    const result = await page.evaluate(() => globalThis.__WORLD_STUDY_RESULT__);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.storageLimit, 8, 'the real device uses the portable storage limit');
    return result;
  };
  const inspect = () => page.evaluate(() => {
    const { study } = __WORLD_STUDY__, engine = __WORLD_STUDY_ENGINE__;
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    require(study.fields?.sample && study.heightAt && study.ecology?.groups, 'expose real fields, rendered terrain sampler and ecology');
    let terrainHash = 2166136261, placementHash = 2166136261, surfaceHash = 2166136261, maxHeightError = 0, sampledMatrices = 0;
    const heights = study.terrain.geometry.attributes.position;
    const surface = study.terrain.geometry.attributes.worldSurface;
    require(surface?.itemSize === 4 && surface.count === heights.count, 'actual terrain carries the four-channel surface field');
    const surfaceMin = [1, 1, 1, 1], surfaceMax = [0, 0, 0, 0], surfaceActive = [0, 0, 0, 0];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < heights.count; i++) {
      const y = heights.getY(i); require(Number.isFinite(y), 'finite actual terrain vertices');
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      terrainHash = Math.imul(terrainHash ^ Math.round(y * 10000), 16777619);
      for (let channel = 0; channel < 4; channel++) {
        const value = surface.array[i * 4 + channel];
        require(Number.isFinite(value) && value >= 0 && value <= 1, 'finite bounded soil/rock/moisture/forest masks');
        surfaceMin[channel] = Math.min(surfaceMin[channel], value); surfaceMax[channel] = Math.max(surfaceMax[channel], value);
        if (value > .25) surfaceActive[channel]++;
        surfaceHash = Math.imul(surfaceHash ^ Math.round(value * 10000), 16777619);
      }
      if (i % 131 === 0) {
        const sample = study.fields.sample(heights.getX(i), heights.getZ(i));
        require(sample && Math.abs(surface.getY(i) - sample.rock) < 1e-6
          && Math.abs(surface.getZ(i) - sample.moisture) < 1e-6 && Math.abs(surface.getW(i) - sample.forest) < 1e-6,
        'uploaded surface channels describe the actual terrain location');
      }
    }
    require(surfaceActive.every(count => count > 100), 'all four real terrain masks have meaningful coverage');
    require(study.surfaceMaps && study.terrain.mesh.material.userData.landscape?.surfaceMode === 'materials', 'the actual ground uses the loaded map material');
    const counts = { trees: 0, shrubs: 0, ground: 0 }, seen = new Set(), layers = [];
    for (const layer of study.populations) {
      require(layer.props.distribution === 'placements', 'every population uses native authored placements');
      require(layer.instances.length === layer.props.placements.length, 'all authored plants reach runtime instances');
      for (const plant of layer.instances) {
        require(typeof plant.id === 'string' && !seen.has(plant.id), 'runtime plants retain globally unique candidate IDs'); seen.add(plant.id);
        const kind = plant.id.split('/')[0]; require(kind in counts, `known population kind ${kind}`); counts[kind]++;
        const [x, y, z] = plant.position, height = study.heightAt(x, z);
        maxHeightError = Math.max(maxHeightError, Math.abs(y - height));
        for (const value of plant.matrix.elements) {
          require(Number.isFinite(value), 'finite actual world matrices');
          placementHash = Math.imul(placementHash ^ Math.round(value * 10000), 16777619);
        }
      }
      // Read real chunk instance buffers, rather than trusting props/stats.
      for (const chunk of layer.chunks) for (let i = 0; i < chunk.instances.length; i += Math.max(1, Math.floor(chunk.instances.length / 8))) {
        const matrix = chunk.instances[i].matrix.elements, data = chunk.meshes[0].instanceMatrix.array;
        for (let axis = 0; axis < 16; axis++) require(data[i * 16 + axis] === Math.fround(matrix[axis]), 'native GPU instance data matches the resolved plant');
        sampledMatrices++;
      }
      layers.push({ species: layer.props.species, authored: layer.props.placements.length, actual: layer.instances.length, draws: layer.stats.drawCalls });
    }
    require(counts.trees > 12 && counts.ground > 7000, 'actual tree/ground populations exceed the former 12/7000 specimen layout');
    require(maxHeightError < 1e-4 && sampledMatrices > 0, 'plants sit on the rendered terrain and reach actual instance buffers');
    require(maxY - minY > 3, 'actual terrain has meaningful relief');
    for (const kind of Object.keys(counts)) require(counts[kind] === study.ecology.counts[kind], `${kind} ecology reaches native rendering`);
    const waterIDs = new Set();
    for (let z = -63; z < 64; z += 2) for (let x = -63; x < 64; x += 2) {
      const sample = study.domain.sample(x, z); if (sample) waterIDs.add(sample.id);
    }
    require(waterIDs.size >= 4, 'the connected field includes the river and all three lake/pond domains');
    require(study.water?.material === study.waterSurface?.material, 'the actual water mesh uses the surface helper');
    require(study.water.material.normalNode && study.water.material.roughnessNode, 'the actual water has its normal/roughness graph');
    require(engine.renderer.backend.isWebGPUBackend && engine.renderer.backend.device.limits.maxStorageBuffersPerShaderStage === 8, 'native portable-eight WebGPU');
    const sourceProbes = [[-36, 4], [-47, 4], [-48, -32], [-23, 22], [41, 15], [5, -29]]
      .map(([x, z]) => ({ x, z, height: study.heightAt(x, z) }));
    return { seed: study.seed, forestDensity: study.forestDensity, groundDensity: study.groundDensity, counts, layers, sourceProbes,
      terrainHash: (terrainHash >>> 0).toString(16), placementHash: (placementHash >>> 0).toString(16),
      fieldsSettings: study.fields.settings, surfaceScale: study.surfaceScale, surfaceBump: study.surfaceBump, vegetation: study.vegetation,
      surface: { hash: (surfaceHash >>> 0).toString(16), min: surfaceMin, max: surfaceMax, active: surfaceActive,
        material: study.terrain.mesh.material.userData.landscape, loaded: study.surfaceMaps.report },
      terrainVertices: heights.count, heightRange: [minY, maxY], maxHeightError, sampledMatrices,
      waterIDs: [...waterIDs], cottage: study.cottageState, errors: __WORLD_STUDY__.errors.slice() };
  });
  await page.goto(url.href, { waitUntil: 'load', timeout: 60000 });
  report.initial = await ready(); report.before = await inspect();
  checkCurrentTerrainSource(report.before);
  if (skipSkyPrepare) assert.ok(report.skyPrepareInterceptions > 0, 'negative control bypassed the actual sky preparation helper');

  // Real pointer/wheel input must move the rendered camera. Resizing must
  // retain an inspected pose; a preset is the deliberate way to reset it.
  const cameraState = () => page.evaluate(() => __WORLD_STUDY__.cameraState());
  const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
  const initialCamera = await cameraState();
  const cameraBeforeImage = await page.screenshot({ encoding: 'base64' });
  await page.mouse.move(690, 405); await page.mouse.down();
  await page.mouse.move(860, 465, { steps: 12 }); await page.mouse.up();
  const orbited = await cameraState();
  assert.ok(distance(initialCamera.position, orbited.position) > 5, 'left-drag orbits the actual camera');
  assert.ok(distance(initialCamera.target, orbited.target) < 1e-6 && Math.abs(initialCamera.distance - orbited.distance) < 1e-5, 'orbit keeps its target and radius');
  await page.mouse.wheel({ deltaY: -420 });
  await page.waitForFunction(before => __WORLD_STUDY__.cameraState().distance < before * .92, {}, orbited.distance);
  const zoomed = await cameraState();
  assert.ok(distance(zoomed.target, orbited.target) < 1e-6, 'wheel zoom preserves the inspected target');
  await page.mouse.move(650, 420); await page.mouse.down({ button: 'right' });
  await page.mouse.move(740, 455, { steps: 10 }); await page.mouse.up({ button: 'right' });
  const panned = await cameraState();
  assert.ok(distance(zoomed.target, panned.target) > 1 && Math.abs(zoomed.distance - panned.distance) < 1e-5, 'right-drag pans target and camera together');
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const off = __WORLD_STUDY_ENGINE__.onPostRender(() => { if (++frames === 3) { off(); resolve(); } }); }));
  const cameraAfterImage = await page.screenshot({ encoding: 'base64' });
  const cameraPixels = await page.evaluate(async (before, after) => {
    const decode = async png => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const a = await decode(before), b = await decode(after); let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
    return { changedPixels: changed, fraction: changed / (a.length / 4) };
  }, cameraBeforeImage, cameraAfterImage);
  assert.ok(cameraPixels.fraction > .2, 'camera interactions change the actual displayed scene substantially');
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });
  await page.waitForFunction(() => innerWidth === 1360 && __WORLD_STUDY_ENGINE__.camera.aspect === 1360 / 860);
  const resized = await cameraState();
  assert.ok(distance(panned.position, resized.position) < 1e-5 && distance(panned.target, resized.target) < 1e-5, 'resize keeps the artist camera pose');
  await page.screenshot({ path: join(output, 'orbit-pan-zoom-controls.png') });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.waitForFunction(() => innerWidth === 1440 && __WORLD_STUDY_ENGINE__.camera.aspect === 1440 / 900);
  await page.click('[data-camera="valley"]');
  const resetCamera = await cameraState();
  assert.ok(distance(initialCamera.position, resetCamera.position) < 1e-5 && distance(initialCamera.target, resetCamera.target) < 1e-5, 'the Valley button restores its actual preset');
  report.navigation = { initial: initialCamera, orbited, zoomed, panned, resized, reset: resetCamera, pixels: cameraPixels };

  // Reproduce the live refresh that formerly cached a black PMREM. Capture
  // the presented frame BEFORE any stopped render can repair that cache.
  await page.evaluate(() => {
    __WORLD_STUDY__.moveCamera('shore'); __WORLD_STUDY__.resetSun();
    document.body.classList.add('capture');
  });
  await new Promise(resolve => setTimeout(resolve, 1800));

  // Stop the whole loop, not only simulation. Both arms use the same canvas,
  // camera, time, materials and textures. No render-target reallocations.
  await page.evaluate(async () => {
    const engine = __WORLD_STUDY_ENGINE__; engine.stop();
    await engine.renderer.backend.device.queue.onSubmittedWorkDone();
    document.body.classList.add('capture');
  });
  const liveSkyRefresh = await page.screenshot({ encoding: 'base64' });
  await writeFile(join(output, 'shore-live-sky-refresh.png'), Buffer.from(liveSkyRefresh, 'base64'));
  report.materialSanity = await page.evaluate(async () => {
    const { THREE } = await import('/src/engine/index.js');
    const { createLandscapeMaterials } = await import('/scripts/lib/worldLandscapeStudy.js');
    const engine = __WORLD_STUDY_ENGINE__, renderer = engine.renderer;
    if (engine.loopActive) throw new Error('Material readback requires the whole engine loop stopped');
    const materials = createLandscapeMaterials({ style: 'natural', extent: 128 });
    const control = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .94, metalness: 0 });
    const old = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .94, metalness: 0 });
    const geometry = new THREE.PlaneGeometry(8, 8, 32, 32).rotateX(-Math.PI / 2);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
    // RGBA32F retains linear radiance without clipping a bright white control;
    // 128 * 16 bytes per row satisfies WebGPU readback row alignment.
    const target = new THREE.RenderTarget(128, 128, { type: THREE.FloatType, format: THREE.RGBAFormat });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-4.5, 4.5, 4.5, -4.5, .1, 30);
    const plane = new THREE.Mesh(geometry, control), sun = new THREE.DirectionalLight(0xffffff, Math.PI * .35);
    const ambient = new THREE.AmbientLight(0xffffff, .8);
    sun.position.set(5, 10, 4); scene.add(plane, ambient, sun, sun.target);
    camera.up.set(0, 0, -1);
    const saved = { target: renderer.getRenderTarget(), toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure, clearColor: renderer.getClearColor(new THREE.Color()).clone(), clearAlpha: renderer.getClearAlpha() };
    const samples = [], bumpSamples = [], normalOffClones = [];
    const read = async material => {
      plane.material = material; scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      await renderer.compileAsync(scene, camera); await renderer.renderAsync(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128);
      const rgb = [0, 0, 0]; let count = 0;
      // The central square is wholly covered for both orientations. Fail on
      // absent rasterization rather than averaging clear pixels into a result.
      for (let y = 16; y < 112; y++) for (let x = 16; x < 112; x++) {
        const index = (y * 128 + x) * 4;
        if (!(pixels[index + 3] > .99)) throw new Error('Material specimen failed to cover its readback region');
        for (let channel = 0; channel < 3; channel++) {
          if (!Number.isFinite(pixels[index + channel])) throw new Error('Nonfinite landscape shader output');
          rgb[channel] += pixels[index + channel];
        }
        count++;
      }
      return { rgb: rgb.map(value => value / count), pixels };
    };
    const difference = (a, b) => {
      let absolute = 0, changed = 0, count = 0;
      for (let y = 16; y < 112; y++) for (let x = 16; x < 112; x++) {
        const index = (y * 128 + x) * 4;
        let delta = 0; for (let channel = 0; channel < 3; channel++) delta += Math.abs(a[index + channel] - b[index + channel]);
        absolute += delta; if (delta > .00003) changed++; count++;
      }
      return { meanAbsoluteError: absolute / (count * 3), changedFraction: changed / count };
    };
    try {
      renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1;
      renderer.setClearColor(0, 0); renderer.setRenderTarget(target);
      // Reproduce the shipped operand reversal on the REAL material's graph,
      // preserving its textures, exposure field and normal/roughness response.
      // No production material is patched. This arm must fail the same RGB gate.
      let blend = materials.groundMaterial.colorNode;
      while (blend?.isVarNode) blend = blend.node;
      if (blend?.method !== 'mix') throw new Error('Cannot construct the retained reversed-mix regression control');
      old.colorNode = blend.aNode.mix(blend.bNode, blend.cNode);
      old.normalNode = materials.groundMaterial.normalNode; old.roughnessNode = materials.groundMaterial.roughnessNode;
      for (const degrees of [0, 45]) {
        plane.rotation.z = THREE.MathUtils.degToRad(degrees);
        camera.position.set(0, 12, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), plane.rotation.z); camera.lookAt(0, 0, 0);
        const { rgb: referenceRGB } = await read(control);
        for (const [kind, material] of [['ground', materials.groundMaterial], ['rock', materials.rockMaterial], ...(degrees === 0 ? [['old-reversed-mix', old]] : [])]) {
          const { rgb } = await read(material);
          samples.push({ kind, degrees, rgb, referenceRGB, ratios: rgb.map((value, channel) => value / referenceRGB[channel]) });
        }
      }
      // Grazing illumination exposes an actual bump gradient. The reference
      // is the identical production material with ONLY normalNode removed;
      // color/roughness texture variation cannot certify this comparison.
      ambient.intensity = .12; sun.intensity = Math.PI * .9;
      for (const degrees of [0, 45]) {
        plane.rotation.z = THREE.MathUtils.degToRad(degrees);
        camera.position.set(0, 12, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), plane.rotation.z); camera.lookAt(0, 0, 0);
        sun.position.set(8, 2, 3).applyAxisAngle(new THREE.Vector3(0, 0, 1), plane.rotation.z);
        for (const [kind, material] of [['ground', materials.groundMaterial], ['rock', materials.rockMaterial]]) {
          const normalOff = material.clone(); normalOff.normalNode = null; normalOffClones.push(normalOff);
          if (normalOff.colorNode !== material.colorNode || normalOff.roughnessNode !== material.roughnessNode) throw new Error('Procedural bump control must preserve the real color and roughness graphs');
          const actual = await read(material), flat = await read(normalOff), restored = await read(material);
          const delta = difference(actual.pixels, flat.pixels);
          bumpSamples.push({ kind, degrees, actualRGB: actual.rgb, normalOffRGB: flat.rgb, ...delta,
            relativeMeanAbsoluteError: delta.meanAbsoluteError / Math.max(1e-9, flat.rgb.reduce((sum, value) => sum + value, 0) / 3),
            restored: difference(actual.pixels, restored.pixels) });
        }
      }
      return { lighting: 'white ambient 0.8 + fixed white directional 0.35 PI; no environment', samples,
        bumpLighting: 'white ambient 0.12 + grazing directional 0.9 PI, fixed relative to each specimen', bumpSamples };
    } finally {
      await renderer.backend.device.queue.onSubmittedWorkDone();
      renderer.setRenderTarget(saved.target); renderer.toneMapping = saved.toneMapping; renderer.toneMappingExposure = saved.exposure;
      renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      target.dispose(); geometry.dispose(); old.dispose(); control.dispose(); normalOffClones.forEach(material => material.dispose()); materials.dispose();
    }
  });
  const materialPasses = sample => sample.referenceRGB.every(value => value > .1)
    && sample.ratios.every(value => value > .35 && value < 1.65);
  for (const sample of report.materialSanity.samples.filter(sample => sample.kind !== 'old-reversed-mix')) {
    assert.ok(materialPasses(sample), `${sample.kind} at ${sample.degrees} degrees preserves neutral vertex-color brightness: ${JSON.stringify(sample)}`);
  }
  const oldMaterial = report.materialSanity.samples.find(sample => sample.kind === 'old-reversed-mix');
  assert.ok(oldMaterial && !materialPasses(oldMaterial), 'the actual reversed-mix shader must fail the same neutral-brightness gate');
  for (const sample of report.materialSanity.bumpSamples) {
    // This float gate detects a lost normal graph, not art quality: the former
    // cached-height shader produces EXACT zero, while these minima reject
    // floating-point noise without demanding exaggerated procedural grain.
    assert.ok(sample.meanAbsoluteError > .00001 && sample.relativeMeanAbsoluteError > .0001 && sample.changedFraction > .15,
      `${sample.kind} at ${sample.degrees} degrees has a real procedural bump gradient: ${JSON.stringify(sample)}`);
    assert.ok(sample.restored.meanAbsoluteError < 1e-7, `${sample.kind} bump comparison restores its identical held pixels`);
  }

  report.surfaceSwatches = await page.evaluate(async () => {
    const { THREE } = await import('/src/engine/index.js');
    const { texture, positionWorld, vec2 } = THREE.TSL;
    const { applyGroundSurfaceMaps } = await import('/scripts/lib/worldSurfaceMaps.js');
    const engine = __WORLD_STUDY_ENGINE__, renderer = engine.renderer, maps = __WORLD_STUDY__.study.surfaceMaps;
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    require(!engine.loopActive && maps, 'surface swatches require the stopped loop and actual loaded study maps');
    const loaded = [], borrowed = new Set(), disposals = [];
    const onDispose = event => disposals.push(event.target.uuid);
    for (const role of ['grass', 'soil', 'rock']) {
      require(maps[role]?.size?.length === 2 && maps[role].size.every(value => Number.isFinite(value) && value > 0), `${role} has physical map dimensions`);
      for (const kind of ['albedo', 'height']) {
        const map = maps[role][kind];
        require(map?.isTexture && map.image?.width === 1024 && map.image?.height === 1024, `${role}/${kind} is an actual decoded 1024-square texture`);
        require(map.colorSpace === (kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace), `${role}/${kind} uses the correct color/data decoding`);
        require(map.wrapS === THREE.RepeatWrapping && map.wrapT === THREE.RepeatWrapping, `${role}/${kind} repeats at its physical tile scale`);
        loaded.push({ role, kind, uuid: map.uuid, width: map.image.width, height: map.image.height, colorSpace: map.colorSpace, metres: maps[role].size });
        borrowed.add(map); map.addEventListener('dispose', onDispose);
      }
    }
    require(borrowed.size === 6, 'all six loaded surface maps are distinct textures');
    const geometry = new THREE.PlaneGeometry(6, 6, 32, 32).rotateX(-Math.PI / 2);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
    const masks = new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 4), 4);
    geometry.setAttribute('worldSurface', masks);
    const ownedMaterials = [], images = {}, samples = {}, references = {}, bindings = new Map(), shaders = {};
    const mapped = (scale = 1, bump = 0) => {
      const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .94, metalness: 0 });
      applyGroundSurfaceMaps(material, maps, { scale, bump }); ownedMaterials.push(material); return material;
    };
    const flat = mapped(), bumped = mapped(1, 1), small = mapped(.5, 0), large = mapped(2, 0);
    const reference = role => {
      const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: role === 'rock' ? .86 : .94, metalness: 0 });
      material.colorNode = texture(maps[role].albedo, positionWorld.xz.div(vec2(...maps[role].size))).rgb;
      ownedMaterials.push(material); return material;
    };
    const target = new THREE.RenderTarget(256, 256, { type: THREE.FloatType, format: THREE.RGBAFormat });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-3.25, 3.25, 3.25, -3.25, .1, 30);
    const plane = new THREE.Mesh(geometry, flat), sun = new THREE.DirectionalLight(0xffffff, Math.PI * .85);
    sun.position.set(5, 3, 2); scene.add(plane, new THREE.AmbientLight(0xffffff, .22), sun, sun.target);
    camera.position.set(0, 10, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
    const saved = { target: renderer.getRenderTarget(), toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
      clearColor: renderer.getClearColor(new THREE.Color()).clone(), clearAlpha: renderer.getClearAlpha(), draw: renderer.backend.draw };
    renderer.backend.draw = function(renderObject, ...args) {
      if (renderObject.object === plane && (renderObject.material === bumped || renderObject.material === flat)) {
        shaders[renderObject.material === bumped ? 'bumped' : 'flat'] = renderObject.getNodeBuilderState().fragmentShader;
      }
      if (renderObject.object === plane && renderObject.material === bumped) {
        for (const group of renderObject.getBindings()) for (const binding of group.bindings) {
          require(!binding.isStorageBuffer, 'the composed surface shader uses no storage buffers');
          if (binding.isSampledTexture && binding.texture) bindings.set(binding.texture.uuid, binding.texture.name);
        }
      }
      return saved.draw.call(this, renderObject, ...args);
    };
    const select = role => {
      const field = role === 'soil' ? [1, 0, 0, 0] : role === 'rock' ? [0, 1, 0, 0] : [0, 0, 0, 0];
      for (let i = 0; i < masks.count; i++) masks.setXYZW(i, ...field);
      masks.needsUpdate = true;
    };
    const read = async (name, material, saveImage = true) => {
      plane.material = material; scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      await renderer.compileAsync(scene, camera); await renderer.renderAsync(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      const rgb = [0, 0, 0], square = [0, 0, 0], values = [];
      for (let y = 20; y < 236; y++) for (let x = 20; x < 236; x++) {
        const at = (y * 256 + x) * 4;
        require(pixels[at + 3] > .99, 'surface specimen fills the actual readback region');
        for (let channel = 0; channel < 3; channel++) {
          const value = pixels[at + channel]; require(Number.isFinite(value) && value >= 0, 'finite nonnegative actual map shader output');
          rgb[channel] += value; square[channel] += value * value; values.push(value);
        }
      }
      const count = values.length / 3, mean = rgb.map(value => value / count);
      samples[name] = { meanRGB: mean, stdRGB: square.map((value, channel) => Math.sqrt(Math.max(0, value / count - mean[channel] ** 2))), pixels: count };
      if (saveImage) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d'), frame = context.createImageData(256, 256);
        for (let i = 0; i < pixels.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            const value = Math.max(0, pixels[i + channel]);
            frame.data[i + channel] = Math.round(Math.min(1, value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055) * 255);
          }
          frame.data[i + 3] = Math.round(Math.min(1, pixels[i + 3]) * 255);
        }
        context.putImageData(frame, 0, 0); images[name] = canvas.toDataURL('image/png').split(',')[1];
      }
      return values;
    };
    const difference = (a, b) => {
      require(a.length === b.length, 'surface pixel comparisons have equal coverage');
      let absolute = 0, changed = 0;
      for (let i = 0; i < a.length; i += 3) {
        let delta = 0; for (let channel = 0; channel < 3; channel++) delta += Math.abs(a[i + channel] - b[i + channel]);
        absolute += delta; if (delta > .015) changed++;
      }
      return { meanAbsoluteError: absolute / a.length, changedFraction: changed / (a.length / 3) };
    };
    let result;
    try {
      renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1; renderer.setClearColor(0, 0); renderer.setRenderTarget(target);
      const pixels = {};
      for (const role of ['grass', 'soil', 'rock']) {
        select(role); pixels[role] = await read(role, flat); references[role] = await read(`${role}-source`, reference(role), false);
      }
      select('rock'); const bump = await read('rock-bump-1', bumped), half = await read('rock-scale-0.5', small), double = await read('rock-scale-2', large);
      const restored = await read('rock-restored', flat, false);
      const selection = Object.fromEntries(['grass', 'soil', 'rock'].map(role => [role,
        Object.fromEntries(['grass', 'soil', 'rock'].map(source => [source, difference(pixels[role], references[source])]))]));
      result = { loaded, lighting: 'fixed white oblique directional 0.85 PI + ambient 0.22; no environment or tone mapping',
        samples, selection, bump: difference(pixels.rock, bump), scale: difference(half, double), restored: difference(pixels.rock, restored),
        boundTextures: [...bindings].map(([uuid, name]) => ({ uuid, name })), images, shaders };
      require([...borrowed].every(map => bindings.has(map.uuid)), 'the actual bumped draw binds all six borrowed study textures');
    } finally {
      await renderer.backend.device.queue.onSubmittedWorkDone(); renderer.backend.draw = saved.draw;
      renderer.setRenderTarget(saved.target); renderer.toneMapping = saved.toneMapping; renderer.toneMappingExposure = saved.exposure;
      renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      target.dispose(); geometry.dispose(); ownedMaterials.forEach(material => material.dispose());
      for (const map of borrowed) map.removeEventListener('dispose', onDispose);
    }
    require(disposals.length === 0, 'surface test materials must not dispose the study textures they borrow');
    return result;
  });
  for (const [name, png] of Object.entries(report.surfaceSwatches.images)) await writeFile(join(output, `surface-${name}.png`), Buffer.from(png, 'base64'));
  delete report.surfaceSwatches.images;
  for (const [name, source] of Object.entries(report.surfaceSwatches.shaders)) await writeFile(join(output, `surface-${name}.wgsl`), source);
  delete report.surfaceSwatches.shaders;
  for (const role of ['grass', 'soil', 'rock']) {
    const sample = report.surfaceSwatches.samples[role], fits = report.surfaceSwatches.selection[role];
    assert.ok(Math.max(...sample.meanRGB) > .015 && Math.max(...sample.stdRGB) > .003, `${role} contributes visible textured pixels`);
    assert.ok(fits[role].meanAbsoluteError < .025, `${role} mask reproduces its actual source albedo`);
    for (const other of ['grass', 'soil', 'rock'].filter(value => value !== role)) {
      assert.ok(fits[other].meanAbsoluteError > fits[role].meanAbsoluteError * 2 + .001 && fits[other].changedFraction > .2,
        `${role} selection must differ from the wrong ${other} map: ${JSON.stringify(fits)}`);
    }
  }
  assert.ok(report.surfaceSwatches.bump.meanAbsoluteError > .002 && report.surfaceSwatches.bump.changedFraction > .10, 'bump 0 versus 1 changes actual obliquely lit rock pixels');
  assert.ok(report.surfaceSwatches.scale.meanAbsoluteError > .008 && report.surfaceSwatches.scale.changedFraction > .25, 'surface scale 0.5 versus 2 changes actual texture pattern pixels');
  assert.ok(report.surfaceSwatches.restored.meanAbsoluteError < 1e-7, 'restoring the same map/mask/settings recovers exact held pixels');

  const render = (pose, waterVisible = true, observe = false, foliageVisible = true) => page.evaluate(async (pose, waterVisible, observe, foliageVisible) => {
    const engine = __WORLD_STUDY_ENGINE__, { study, moveCamera } = __WORLD_STUDY__;
    if (engine.loopActive) throw new Error('Water comparison requires a stopped engine loop');
    moveCamera(pose); study.water.visible = waterVisible;
    for (const population of study.populations) population.update(true);
    // This held render replaces the engine's normal pre-render callbacks.
    study.depthPrepass?.sync();
    const visibility = study.populations.map(layer => layer.root.visible);
    if (!foliageVisible) for (const layer of study.populations) layer.root.visible = false;
    engine.scene.updateMatrixWorld(true);
    const renderer = engine.renderer, backend = renderer.backend, draw = backend.draw;
    const batches = new Map(study.populations.flatMap(layer => layer.renderMeshes.map((mesh, lod) => [mesh, { layer, lod }])));
    const bindings = [], foliageDraws = []; let waterDraws = 0, roofDraws = 0, frame = 0;
    if (observe) backend.draw = function(renderObject, ...args) {
      if (renderObject.object === study.water && renderObject.material === study.water.material) {
        waterDraws++;
        for (const group of renderObject.getBindings()) for (const binding of group.bindings) if (binding.isSampledTexture) {
          const texture = binding.texture;
          bindings.push({ name: texture.name, uuid: texture.uuid, mapping: texture.mapping,
            width: texture.image?.width, height: texture.image?.height });
        }
      }
      // Record only the final main-camera draw, not shadow draws or warm-up
      // frames. These are the real shared batches, not dormant chunk meshes.
      if (frame === 2 && renderObject.material === renderObject.object.material && renderObject.camera === engine.camera) {
        if (renderObject.object.userData.worldStudyRole === 'roof') roofDraws++;
        const batch = batches.get(renderObject.object);
        if (batch) {
          const { layer, lod } = batch, mesh = renderObject.object, parameters = renderObject.getDrawParameters();
          const selected = layer.chunks.filter(chunk => chunk.level === lod);
          const expected = selected.reduce((count, chunk) => count + chunk.instances.length, 0);
          if (!parameters || parameters.instanceCount !== expected || expected === 0) throw new Error('Submitted foliage count must match the selected native placements');
          // Opaque depth ordering may permute whole chunks. Resolve each
          // submitted chunk independently from its actual first tuple rather
          // than assuming canonical layout order or mirroring the sort code.
          const sourceAttributes = chunk => lod < 2 ? [chunk.meshes[lod].instanceMatrix]
            : ['aCenter', 'aSize', 'aAxisX', 'aAxisY'].map(key => chunk.meshes[lod].geometry.attributes[key]);
          const destinations = lod < 2 ? [mesh.instanceMatrix]
            : ['aCenter', 'aSize', 'aAxisX', 'aAxisY'].map(key => mesh.geometry.attributes[key]);
          const tuple = (attributes, index) => attributes.flatMap(attribute => Array.from(attribute.array.subarray(index * attribute.itemSize, (index + 1) * attribute.itemSize))).join(',');
          const remaining = new Map(selected.map(chunk => [tuple(sourceAttributes(chunk), 0), chunk]));
          if (remaining.size !== selected.length) throw new Error('World fixture requires distinct first-root tuples per chunk');
          let offset = 0, checked = 0;
          while (offset < expected) {
            const key = tuple(destinations, offset), chunk = remaining.get(key);
            if (!chunk) throw new Error('Actual batch must contain every selected chunk exactly once');
            remaining.delete(key);
            const attributes = lod < 2 ? [[mesh.instanceMatrix, chunk.meshes[lod].instanceMatrix]]
              : ['aCenter', 'aSize', 'aAxisX', 'aAxisY'].map(key => [mesh.geometry.attributes[key], chunk.meshes[lod].geometry.attributes[key]]);
            for (const index of new Set([0, chunk.instances.length - 1])) for (const [destination, source] of attributes) {
              for (let channel = 0; channel < source.itemSize; channel++) {
                if (destination.array[(offset + index) * source.itemSize + channel] !== source.array[index * source.itemSize + channel]) {
                  throw new Error('Actual submitted foliage attributes must contain the selected chunk data');
                }
              }
              checked++;
            }
            offset += chunk.instances.length;
          }
          if (remaining.size || offset !== expected) throw new Error('Actual batch must preserve selected chunk coverage');
          foliageDraws.push({ population: layer.entity.name, species: layer.props.species, kind: layer.instances[0].id.split('/')[0],
            lod, instances: parameters.instanceCount, verticesPerInstance: parameters.vertexCount, checked });
        }
      }
      return draw.call(this, renderObject, ...args);
    };
    try {
      for (frame = 0; frame < 3; frame++) { await renderer.renderAsync(engine.scene, engine.camera); await backend.device.queue.onSubmittedWorkDone(); }
    } finally { backend.draw = draw; study.populations.forEach((layer, index) => { layer.root.visible = visibility[index]; }); }
    return { waterDraws, bindings, foliageDraws, roofDraws, environment: engine.scene.environment ? { uuid: engine.scene.environment.uuid,
      width: engine.scene.environment.image?.width, height: engine.scene.environment.image?.height } : null };
  }, pose, waterVisible, observe, foliageVisible);
  const capture = async name => {
    const png = await page.screenshot({ encoding: 'base64' });
    await writeFile(join(output, `${name}.png`), Buffer.from(png, 'base64')); return png;
  };
  const inspectRoof = async name => {
    const submitted = await render('cottage', true, true);
    assert.ok(submitted.roofDraws > 0, 'the actual roof material reaches a framed scene draw');
    await capture(name);
    return page.evaluate(() => {
      const roof = []; __WORLD_STUDY__.study.cottage.traverse(mesh => { if (mesh.isMesh && mesh.userData.worldStudyRole === 'roof') roof.push(mesh); });
      let geometryHash = 2166136261, colorHash = 2166136261, vertices = 0;
      for (const mesh of roof) {
        const geometry = mesh.geometry, position = geometry.attributes.position, color = geometry.attributes.color;
        if (!mesh.material.vertexColors || color?.count !== position.count) throw new Error('Roof appearance must use actual vertex colors');
        const hashGeometry = value => { geometryHash = Math.imul(geometryHash ^ Math.round(value * 10000), 16777619); };
        for (const value of mesh.matrixWorld.elements) hashGeometry(value);
        for (const value of position.array) hashGeometry(value);
        for (const value of geometry.index?.array ?? []) hashGeometry(value);
        for (const value of color.array) colorHash = Math.imul(colorHash ^ Math.round(value * 1000000), 16777619);
        vertices += position.count;
      }
      if (!vertices) throw new Error('An actual roof is required');
      return { meshes: roof.length, vertices, geometryHash: (geometryHash >>> 0).toString(16), colorHash: (colorHash >>> 0).toString(16) };
    });
  };
  // Complete an identical-source refresh while stopped for the reference.
  // A failed live bake marks its native cache current, so a plain redraw can
  // preserve the failure and cannot by itself establish a valid reference.
  await page.evaluate(() => { __WORLD_STUDY_ENGINE__.scene.environment.needsPMREMUpdate = true; });
  report.waterBindings = await render('shore', true, true);
  const on = await capture('shore');
  await render('shore', false); const off = await capture('shore-water-hidden');
  await render('shore', true); const restored = await capture('shore-water-restored');
  report.waterPixels = await page.evaluate(async (on, off, restored, live) => {
    const { THREE } = await import('/src/engine/index.js');
    const decode = async png => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const a = await decode(on), b = await decode(off), c = await decode(restored), d = await decode(live);
    if ([b, c, d].some(image => image.width !== a.width || image.height !== a.height)) throw new Error('Water comparisons require identical capture dimensions');
    const camera = __WORLD_STUDY_ENGINE__.camera, domain = __WORLD_STUDY__.study.domain;
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point = new THREE.Vector3();
    let changed = 0, pondSamples = 0, pondChanged = 0, restoreDifference = 0;
    const colors = new Set(), sum = [0, 0, 0], square = [0, 0, 0], liveSum = [0, 0, 0];
    for (let i = 0; i < a.data.length; i += 4) {
      const delta = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      for (let channel = 0; channel < 3; channel++) restoreDifference += Math.abs(a.data[i + channel] - c.data[i + channel]);
      if (delta > 18) changed++;
      const pixel = i / 4, x = pixel % a.width, y = Math.floor(pixel / a.width);
      if (x % 3 || y % 3) continue;
      ray.setFromCamera(new THREE.Vector2((x + .5) / a.width * 2 - 1, 1 - (y + .5) / a.height * 2), camera);
      if (!ray.ray.intersectPlane(plane, point)) continue;
      const wet = domain.sample(point.x, point.z);
      if (!wet || Math.abs(wet.height) > .03 || wet.shoreDistance < .3) continue;
      pondSamples++;
      if (delta <= 18) continue;
      pondChanged++; colors.add([0, 1, 2].map(channel => a.data[i + channel] >> 3).join(','));
      for (let channel = 0; channel < 3; channel++) {
        const value = a.data[i + channel]; sum[channel] += value; square[channel] += value * value;
        liveSum[channel] += d.data[i + channel];
      }
    }
    const mean = sum.map(value => value / Math.max(1, pondChanged));
    return { changedPixels: changed, pondSamples, changedPondSamples: pondChanged, distinctPondColors: colors.size,
      pondMeanRGB: mean, pondStdRGB: square.map((value, i) => Math.sqrt(Math.max(0, value / Math.max(1, pondChanged) - mean[i] ** 2))),
      livePondMeanRGB: liveSum.map(value => value / Math.max(1, pondChanged)),
      liveToHeldPondRGB: liveSum.map((value, channel) => value / Math.max(1, sum[channel])),
      restoredMeanAbsoluteError: restoreDifference / (a.width * a.height * 3) };
  }, on, off, restored, liveSkyRefresh);
  assert.ok(report.waterBindings.waterDraws > 0, 'the real water material submitted draws');
  assert.ok(report.waterBindings.environment?.width > 1, 'an actual atmospheric environment exists');
  assert.ok(report.waterBindings.bindings.some(binding => binding.mapping === 306 && binding.width > 1), 'the submitted water draw binds a real CubeUV PMREM environment');
  assert.ok(report.waterPixels.changedPixels > 1000 && report.waterPixels.changedPondSamples > 150, 'water visibility changes actual pixels over the wet pond');
  assert.ok(report.waterPixels.distinctPondColors > 12 && Math.max(...report.waterPixels.pondStdRGB) > 4, 'visible water has nonuniform rendered color');
  assert.ok(report.waterPixels.restoredMeanAbsoluteError < .5, 'restoring water recovers the held frame; unrelated animation cannot certify the A/B');
  assert.ok(report.waterPixels.liveToHeldPondRGB.every(ratio => ratio >= .8 && ratio <= 1.2),
    `live sky refresh retains completed pond lighting before manual repair: ${JSON.stringify(report.waterPixels)}`);
  await render('valley'); await capture('valley');
  report.forestDraws = await render('forest', true, true);
  const forestOn = await capture('forest');
  const forestHiddenDraws = await render('forest', true, true, false);
  const forestOff = await capture('forest-foliage-hidden');
  const forestRestoredDraws = await render('forest', true, true);
  const forestRestored = await capture('forest-foliage-restored');
  report.forestPixels = await page.evaluate(async (on, off, restored) => {
    const decode = async png => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const a = await decode(on), b = await decode(off), c = await decode(restored);
    let changed = 0, greenChanged = 0, restoreDifference = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta > 18) { changed++; if (a[i + 1] > a[i] * 1.05 && a[i + 1] > a[i + 2] * 1.08) greenChanged++; }
      for (let channel = 0; channel < 3; channel++) restoreDifference += Math.abs(a[i + channel] - c[i + channel]);
    }
    return { changedPixels: changed, greenChangedPixels: greenChanged, restoredMeanAbsoluteError: restoreDifference / (a.length / 4 * 3) };
  }, forestOn, forestOff, forestRestored);
  const drawn = report.forestDraws.foliageDraws;
  for (const kind of ['trees', 'ground']) assert.ok(drawn.some(draw => draw.kind === kind && draw.instances > 0 && draw.checked > 0), `${kind} reaches actual native batch draws`);
  assert.equal(forestHiddenDraws.foliageDraws.length, 0, 'withdrawing foliage removes the actual submitted draws');
  assert.deepEqual(forestRestoredDraws.foliageDraws, drawn, 'restoring foliage restores the same actual batch counts and attributes');
  assert.ok(report.forestPixels.changedPixels > 10000 && report.forestPixels.greenChangedPixels > 2000, 'native foliage contributes visible green forest pixels');
  assert.ok(report.forestPixels.restoredMeanAbsoluteError < .5, 'the held forest frame is restored after the visibility control');

  // Native controls perform a same-path rebuild; changing the seed must change
  // actual terrain and placement data while retaining the current cottage edit.
  report.generatedRoof = await inspectRoof('cottage-generated-roof');
  const roof = '#42698c';
  report.customCottage = await page.evaluate(roof => {
    document.body.classList.remove('capture');
    const input = document.querySelector('#roof-color');
    if (!input || input.disabled) throw new Error('enabled native roof control required');
    input.value = roof; input.dispatchEvent(new Event('change', { bubbles: true }));
    return __WORLD_STUDY__.study.cottageState;
  }, roof);
  assert.equal(report.customCottage.roofColor, roof); assert.ok(report.customCottage.edits.length > 0);
  await page.evaluate(() => document.body.classList.add('capture'));
  report.paintedRoof = await inspectRoof('cottage-painted-roof');
  assert.equal(report.paintedRoof.geometryHash, report.generatedRoof.geometryHash, 'painting preserves actual roof geometry');
  assert.notEqual(report.paintedRoof.colorHash, report.generatedRoof.colorHash, 'the authored edit changes real rendered roof vertex colors');
  await page.evaluate(() => document.body.classList.remove('capture'));
  const settings = { '#world-seed': 931, '#forest-density': .85, '#ground-density': 1.1,
    '#terrain-relief': .8, '#river-width': 6.2, '#shore-width': 1.25, '#rockiness': .8, '#forest-cover': .8,
    '#surface-scale': 1.2, '#surface-bump': .8, '#tree-scale': 1.15, '#grass-height': 1.25, '#vegetation-patchiness': .8 };
  for (const [selector, value] of Object.entries(settings)) {
    const input = await page.waitForSelector(selector); await input.click();
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.type(String(value)); await page.keyboard.press('Tab');
  }
  await page.select('#surface-mode', 'materials');
  await page.screenshot({ path: join(output, 'landscape-controls.png') });
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#generate-world')]);
  report.regenerated = await ready(); report.after = await inspect();
  checkCurrentTerrainSource(report.after);
  const rebuiltURL = new URL(page.url()); report.rebuiltURL = rebuiltURL.href;
  for (const [key, value] of Object.entries({ treeScale: 1.15, grassHeight: 1.25, patchiness: .8 })) {
    assert.equal(Number(rebuiltURL.searchParams.get(key)), value, `${key} persists in the navigation URL`);
    assert.equal(report.after.vegetation[key], value, `${key} reaches the native ecology settings`);
  }
  assert.equal(rebuiltURL.pathname, url.pathname);
  assert.equal(rebuiltURL.searchParams.get('seed'), '931');
  assert.equal(Number(rebuiltURL.searchParams.get('forest')), .85); assert.equal(Number(rebuiltURL.searchParams.get('ground')), 1.1);
  const geography = { relief: .8, riverWidth: 6.2, shoreWidth: 1.25, rockiness: .8, forestCover: .8 };
  for (const [key, value] of Object.entries(geography)) {
    assert.equal(Number(rebuiltURL.searchParams.get(key)), value, `${key} control persists in the real navigation URL`);
    assert.equal(report.after.fieldsSettings[key], value, `${key} control configures the actual terrain/water fields`);
  }
  assert.equal(rebuiltURL.searchParams.get('surface'), 'materials');
  for (const [key, value] of Object.entries({ surfaceScale: 1.2, surfaceBump: .8 })) {
    assert.equal(Number(rebuiltURL.searchParams.get(key)), value, `${key} persists in the navigation URL`);
    assert.equal(report.after[key], value, `${key} reaches the constructed study`);
    assert.equal(report.after.surface.material[key], value, `${key} reaches the actual terrain material`);
  }
  assert.equal(await page.$eval('#surface-status', element => element.dataset.mode), 'materials', 'the UI reports the actual loaded material mode');
  assert.equal(report.after.surface.loaded.mode, 'materials'); assert.equal(report.after.surface.loaded.textureCount, 6);
  assert.equal(Number(rebuiltURL.searchParams.get('cottage')), report.customCottage.seed);
  assert.equal(`#${rebuiltURL.searchParams.get('roof')?.replace(/^#/, '')}`, roof);
  assert.equal(report.after.seed, 931); assert.equal(report.after.forestDensity, .85); assert.equal(report.after.groundDensity, 1.1);
  assert.notEqual(report.after.terrainHash, report.before.terrainHash, 'new seed changes actual terrain vertices');
  assert.notEqual(report.after.surface.hash, report.before.surface.hash, 'regeneration changes the actual uploaded terrain material masks');
  assert.notEqual(report.after.placementHash, report.before.placementHash, 'regeneration changes actual native placement matrices');
  assert.equal(report.after.cottage.architecture.family, report.customCottage.architecture.family);
  assert.equal(report.after.cottage.seed, report.customCottage.seed); assert.equal(report.after.cottage.roofColor, roof);
  assert.deepEqual(report.after.cottage.edits, report.customCottage.edits, 'World regeneration preserves authored roof intent');
  await page.evaluate(async () => { const engine = __WORLD_STUDY_ENGINE__; engine.stop(); await engine.renderer.backend.device.queue.onSubmittedWorkDone(); document.body.classList.add('capture'); });
  report.regeneratedRoof = await inspectRoof('cottage-regenerated-roof');
  assert.deepEqual(report.regeneratedRoof, report.paintedRoof, 'World regeneration preserves the actual rendered roof geometry and authored vertex colors');
  await render('valley'); await capture('regenerated-valley');
  assert.deepEqual(report.before.errors, []); assert.deepEqual(report.after.errors, []);
  assert.deepEqual(await page.evaluate(() => __WORLD_STUDY__.errors), []); assert.deepEqual(report.errors, []);
  report.pass = true;
  console.log('WORLD-LANDSCAPE PASS', JSON.stringify({ counts: report.before.counts, waterPixels: report.waterPixels, output }));
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  console.error('WORLD-LANDSCAPE FAIL', report.failure);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
}
