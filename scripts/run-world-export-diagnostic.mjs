/** Diagnose the exact retained export from run-world-export-smoke; no source
 * imports or runtime rebuild. Requires the exclusive serial GPU slot. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

const prior = JSON.parse(fs.readFileSync('artifacts/world-export/report.json', 'utf8'));
const root = path.resolve(process.argv[2] ?? path.join(prior.scratch, 'game'));
const output = path.resolve('artifacts/world-export/diagnostic'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'world-export-diagnostic-'));
const report = { root, playerTemplateBuilt: prior.playerTemplateBuilt, errors: [], cases: {} };
const types = { '.js': 'text/javascript', '.json': 'application/json', '.scene': 'application/json', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  try {
    if (!pathname.startsWith('/nested/game/')) throw new Error('Unknown route');
    const relative = pathname.slice('/nested/game/'.length) || 'index.html';
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Outside export');
    const bytes = fs.readFileSync(target); response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream' }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profile,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 }; });
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/nested/game/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__engine?.entities?.get('world')?.getComponent('world')?.status === 'Ready', { timeout: 120000 });
  await new Promise(resolve => setTimeout(resolve, 3500));
  report.state = await page.evaluate(async () => {
    const engine = __engine, renderer = engine.renderer, world = engine.entities.get('world').getComponent('world'), terrain = world.terrainEntity.getComponent('terrain');
    engine.stop(); await renderer.backend.device.queue.onSubmittedWorkDone();
    const frame = renderer._nodes.nodeFrame, heldTime = frame.time;
    frame.update = function () { this.frameId++; this.deltaTime = 0; this.time = heldTime; };
    const wrapper = terrain.material, source = world._plan.groundMaterial;
    const state = globalThis.__worldDiagnostic = { engine, renderer, world, terrain, wrapper, source, initial: terrain.mesh.material, shader: '', bindings: [], images: {} };
    const draw = renderer.backend.draw;
    renderer.backend.draw = function (renderObject, ...args) {
      if (renderObject.object === terrain.mesh && renderObject.material === terrain.mesh.material) {
        state.shader = renderObject.getNodeBuilderState().fragmentShader;
        state.bindings = renderObject.getBindings().flatMap(group => group.bindings.filter(binding => binding.isSampledTexture)
          .map(binding => ({ name: binding.name, uuid: binding.texture?.uuid, textureName: binding.texture?.name })));
      }
      return draw.call(this, renderObject, ...args);
    };
    const describe = material => ({ uuid: material.uuid, name: material.name, type: material.type, version: material.version,
      colorNode: material.colorNode && { type: material.colorNode.constructor.name, uuid: material.colorNode.uuid },
      normalNode: material.normalNode && { type: material.normalNode.constructor.name, uuid: material.normalNode.uuid },
      vertexColors: material.vertexColors, color: material.color.toArray() });
    return { wrapper: describe(wrapper), source: describe(source), actual: describe(terrain.mesh.material), materialOwner: terrain.mesh.userData.materialOwner ?? null,
      renderTarget: renderer.getRenderTarget()?.texture?.name ?? null, sameBorrowedMaterial: terrain._proceduralMaterial.material === source,
      meshUsesWrapper: terrain.mesh.material === wrapper, meshMaterialProp: terrain.meshComponent.props.material,
      maps: ['grass', 'soil', 'rock'].flatMap(role => ['albedo', 'height'].map(kind => ({ role, kind, uuid: world._maps[role][kind].uuid, url: world._maps[role][kind].image.src }))) };
  });
  for (const name of ['initial', 'wrapper', 'direct', 'clone', 'rewired', 'restored']) {
    const result = await page.evaluate(async name => {
      const s = __worldDiagnostic;
      if (name === 'initial') s.terrain.mesh.material = s.initial;
      else if (name === 'direct') s.terrain.mesh.material = s.source;
      else if (name === 'clone') {
        s.clone = s.wrapper.clone();
        for (const slot of ['colorNode', 'normalNode', 'roughnessNode', 'metalnessNode', 'aoNode']) s.clone[slot] = s.wrapper[slot];
        s.clone.vertexColors = s.wrapper.vertexColors; s.terrain.mesh.material = s.clone;
      } else if (name === 'rewired') {
        s.terrain.setProceduralMaterial(s.world, s.source);
      } else s.terrain.mesh.material = s.wrapper;
      s.shader = ''; s.bindings = [];
      for (let i = 0; i < 3; i++) await s.renderer.renderAsync(s.engine.scene, s.engine.camera);
      await s.renderer.backend.device.queue.onSubmittedWorkDone();
      return { shader: s.shader, bindings: s.bindings, material: s.terrain.mesh.material.uuid };
    }, name);
    fs.writeFileSync(path.join(output, `${name}.wgsl`), result.shader);
    const png = await page.screenshot({ path: path.join(output, `${name}.png`), encoding: 'base64' });
    fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
    const pixels = await page.evaluate(async ({ name, png }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const s = __worldDiagnostic; s.images[name] = pixels;
      let changed = 0, error = 0;
      const baseline = s.images.initial;
      for (let i = 0; i < pixels.length; i += 4) {
        const delta = Math.abs(pixels[i] - baseline[i]) + Math.abs(pixels[i+1] - baseline[i+1]) + Math.abs(pixels[i+2] - baseline[i+2]);
        changed += delta > 3 ? 1 : 0; error += delta;
      }
      return { changedPixels: changed, meanRGBDifference: error / (pixels.length / 4 * 3) };
    }, { name, png });
    report.cases[name] = { ...result, shader: undefined, shaderBytes: result.shader.length, pixels };
  }
  console.log(JSON.stringify({ state: report.state, cases: report.cases, errors: report.errors }, null, 2));
} catch (error) { report.failure = String(error.stack ?? error); console.error(report.failure); process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  if (!path.resolve(profile).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('Profile outside scratch root');
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
