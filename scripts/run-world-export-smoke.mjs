/** Real exportGame -> exact exported folder -> unmodified production player.
 * Usage: npm run build:player; start Vite; node scripts/run-world-export-smoke.mjs http://127.0.0.1:5401
 * Serial GPU ownership is required. Scratch project/profile stay outside Vite.
 * The exporter page never initializes a renderer; only the player owns a GPU. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { installTauriShim } from './lib/tauriShim.mjs';
import { createWorldDocument } from '../src/engine/world/worldDocument.js';
import { WORLD_BUILTIN_SURFACES } from '../src/modules/world/worldBuiltinSurfaces.js';
import { fileURLToPath } from 'node:url';

const origin = (process.argv[2] ?? 'http://127.0.0.1:5401').replace(/\/$/, '');
const output = path.resolve(process.argv[3] ?? 'artifacts/world-export');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'world-export-'));
const project = path.join(scratch, 'project').replaceAll('\\', '/');
const exported = path.join(scratch, 'game');
const profile = path.join(scratch, 'profile');
const templateSource = path.resolve('dist-player');
const template = path.join(scratch, 'template');
const report = { pass: false, timestamp: new Date().toISOString(), errors: [], requests: [], scratch };
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(exported, { recursive: true });
const saveReport = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
saveReport();
const inside = (root, relative) => {
  const target = path.resolve(root, relative), base = path.resolve(root);
  assert.ok(target === base || target.startsWith(`${base}${path.sep}`), `Path escaped scratch directory: ${relative}`);
  return target;
};
const write = (root, relative, data) => {
  const destination = inside(root, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data); return destination.replaceAll('\\', '/');
};
const listFiles = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? listFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`) :
    [[`${prefix}${entry.name}`, fs.statSync(path.join(directory, entry.name)).size]]);
const entity = (id, components, extra = {}) => ({ id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components, children: [], ...extra });
const baseDocument = createWorldDocument({ seed: 894, forestDensity: .08, groundDensity: .03 });
baseDocument.edits.push({ id: 'authored-roof', kind: 'override', target: 'cottage', property: 'roofColor', value: '#ad375f' });
const optionalDocument = structuredClone(baseDocument);
optionalDocument.resources.surfaceMaps = {};
for (const role of WORLD_BUILTIN_SURFACES.assets) {
  const layer = { size: role.physicalDimensions.meters.slice() };
  for (const kind of ['albedo', 'height']) {
    const source = fileURLToPath(role.maps[kind].url), ext = path.extname(source);
    layer[kind] = write(project, `textures/${role.role}/${kind}${ext}`, fs.readFileSync(source));
  }
  optionalDocument.resources.surfaceMaps[role.role] = layer;
}
const materialTexture = write(project, 'textures/material/albedo.jpg', fs.readFileSync(fileURLToPath(WORLD_BUILTIN_SURFACES.assets[0].maps.albedo.url)));
write(project, 'textures/material/albedo.jpg.meta', '{}');
const materialPath = write(project, 'materials/Ground.mat', JSON.stringify({ name: 'World exported custom ground', color: '#f8eeee', roughness: .8, map: materialTexture }));
write(project, 'materials/Ground.mat.meta', '{}');
optionalDocument.resources.materials.ground = materialPath;
for (const [name, document] of [['Main', baseDocument], ['Optional', optionalDocument]]) {
  write(project, `scenes/${name}.scene`, JSON.stringify({ version: 1, name, entities: [
    entity('world', [{ type: 'world', props: { document } }]),
    entity('camera', [{ type: 'camera', props: { near: .1, far: 800, fov: 55 } }], { position: [48, 35, 68], rotation: [-.45, .55, 0] }),
  ] }));
}
write(project, 'project.json', JSON.stringify({ name: 'World export fixture', modules: [], mainScene: 'scenes/Main.scene' }));

let browser, server, manifest;
try {
  assert.ok(fs.existsSync(path.join(templateSource, '.vite/manifest.json')), 'Run npm run build:player before this smoke');
  // A live editor may refresh dist-player as source changes. Export against
  // one completed template, so that refresh cannot replace half its chunks.
  fs.cpSync(templateSource, template, { recursive: true });
  report.playerTemplateBuilt = fs.readFileSync(path.join(template, 'index.html'), 'utf8').match(/player-template-built ([0-9T:.Z-]+)/)?.[1];
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, userDataDir: profile, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  const exporter = await browser.newPage();
  exporter.on('pageerror', error => report.errors.push(`export: ${error.message}`));
  await installTauriShim(exporter, { writableRoot: scratch, extraCommands: {
    read_player_template: ({ rel }) => fs.readFileSync(inside(template, rel), 'utf8'),
    list_player_template: () => listFiles(template),
    export_game: args => {
      assert.equal(path.resolve(args.outDir), path.resolve(exported)); manifest = args;
      assert.ok(Array.isArray(args.templateFiles), 'Real export must select a runtime manifest closure');
      for (const relative of args.templateFiles) write(exported, relative, fs.readFileSync(inside(template, relative)));
      for (const [source, relative] of args.assets) write(exported, relative, fs.readFileSync(source));
      for (const [relative, contents] of args.files) write(exported, relative, contents);
      write(exported, 'scene.json', args.sceneJson); return [];
    },
  } });
  await exporter.goto(`${origin}/scripts/world-export.html`, { waitUntil: 'load', timeout: 60000 });
  report.export = await exporter.evaluate(async ({ project, exported }) => {
    await import('/src/modules/index.js');
    const { ensureEngine } = await import('/src/editor/engineInstance.js');
    const engine = await ensureEngine();
    if (engine.renderer) throw new Error('Exporter fixture unexpectedly initialized a GPU renderer');
    const { useProjectStore } = await import('/src/editor/store/projectStore.js');
    useProjectStore.setState({ rootPath: project, projectMeta: { name: 'World export fixture', modules: [] } });
    const { useModulesStore } = await import('/src/editor/modules.js');
    useModulesStore.setState({ enabled: [], explicit: [] });
    const { exportGame } = await import('/src/editor/exportGame.js');
    return exportGame({ outDir: exported, buildOverride: { target: 'web', startScene: 'scenes/Main.scene',
      scenes: ['scenes/Main.scene', 'scenes/Optional.scene'], quality: 'ultra', runtimeTrim: true } });
  }, { project, exported });
  assert.equal(report.export.ok, true, JSON.stringify(report.export));
  assert.deepEqual(report.export.warnings, []);
  const config = JSON.parse(manifest.sceneJson);
  for (const id of ['world', 'terrain', 'water', 'foliage', 'architecture', 'atmosphere']) assert.ok(config.modules.includes(id), `Missing module ${id}`);
  assert.ok(manifest.templateFiles.every(file => !file.startsWith('world-study/')));
  const optional = JSON.parse(fs.readFileSync(path.join(exported, 'scenes/Optional.scene'), 'utf8'));
  const resources = optional.entities[0].components[0].props.document.resources;
  for (const role of Object.values(resources.surfaceMaps)) for (const kind of ['albedo', 'height']) {
    assert.ok(role[kind].startsWith('assets/')); assert.ok(fs.existsSync(inside(exported, role[kind])));
  }
  const material = JSON.parse(fs.readFileSync(inside(exported, resources.materials.ground), 'utf8'));
  assert.ok(material.map.startsWith('assets/')); assert.ok(fs.existsSync(inside(exported, material.map)));
  report.assetCopies = manifest.assets.length; report.modules = config.modules;
  await exporter.close();

  // Serve only the exported directory, under a nested path. No dev-source or
  // public fixture fallback can make an incorrectly packaged player pass.
  const prefix = '/nested/game/';
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.scene': 'application/json',
    '.mat': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.css': 'text/css' };
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    try {
      const relative = pathname.slice(prefix.length) || 'index.html';
      const file = inside(exported, relative);
      const bytes = fs.readFileSync(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const player = await browser.newPage(); await player.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await player.evaluateOnNewDocument(() => { globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 }; });
  player.on('pageerror', error => report.errors.push(`player: ${error.message}`));
  player.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  player.on('response', response => {
    const url = response.url(); report.requests.push({ url, status: response.status() });
    if (response.status() >= 400 && !url.endsWith('/favicon.ico')) report.errors.push(`HTTP ${response.status()} ${url}`);
  });
  const playerURL = `http://127.0.0.1:${server.address().port}${prefix}`;
  await player.goto(playerURL, { waitUntil: 'load', timeout: 60000 });
  await player.waitForFunction(() => globalThis.__engine?.entities?.get('world')?.getComponent('world'), { timeout: 120000 });
  const inspect = async (name, expectedMap = null) => {
    await player.waitForFunction(() => {
      const world = globalThis.__engine?.entities?.get('world')?.getComponent('world');
      return world?.status === 'Error' || world?.status === 'Ready' && globalThis.__engine.stats?.readout?.drawCalls > 0;
    }, { timeout: 180000 });
    await player.evaluate(() => {
      const engine = __engine, world = engine.entities.get('world').getComponent('world'), terrain = world.terrainEntity?.getComponent('terrain');
      const draw = engine.renderer.backend.draw;
      globalThis.__exportGroundDraw = { draw, bindings: [], shader: '' };
      engine.renderer.backend.draw = function (renderObject, ...args) {
        if (renderObject.object === terrain?.mesh && renderObject.camera === engine.camera && renderObject.material === terrain.mesh.material) {
          __exportGroundDraw.shader = renderObject.getNodeBuilderState().fragmentShader;
          __exportGroundDraw.bindings = renderObject.getBindings().flatMap(group => group.bindings)
            .filter(binding => binding.isSampledTexture).map(binding => binding.texture?.uuid);
        }
        return draw.call(this, renderObject, ...args);
      };
    });
    await new Promise(resolve => setTimeout(resolve, 3500));
    const state = await player.evaluate(expectedMap => {
      const engine = globalThis.__engine, world = engine.entities.get('world').getComponent('world');
      const terrain = world.terrainEntity?.getComponent('terrain');
      const groundMapURL = terrain?._proceduralMaterial?.material?.map?.image?.src ?? null;
      const receipt = __exportGroundDraw; engine.renderer.backend.draw = receipt.draw;
      const builtinMaps = ['grass', 'soil', 'rock'].flatMap(role => ['albedo', 'height'].map(kind => world._maps?.[role]?.[kind]?.uuid));
      const children = world.entity.children.map(entity => ({ name: entity.name, components: [...entity.components.values()].map(component => component.type) }));
      const meshes = []; world.entity.object3D.traverse(object => { if (object.isMesh) meshes.push(object); });
      return { status: world.status, error: world.error, children, meshCount: meshes.length, drawCalls: engine.stats.readout.drawCalls,
        storageLimit: engine.renderer.backend.device.limits.maxStorageBuffersPerShaderStage,
        document: world.props.document,
        textured: meshes.filter(mesh => !!mesh.material?.map).length,
        groundMapURL,
        groundUsesTerrainWrapper: !!terrain && terrain.mesh?.material === terrain.material,
        groundShader: receipt.shader,
        boundSurfaceMaps: builtinMaps.filter(uuid => receipt.bindings.includes(uuid)).length,
        customGround: !!expectedMap && groundMapURL?.endsWith(`/${expectedMap}`) &&
          terrain.mesh?.material === terrain.material && !!terrain.material?.colorNode,
      };
    }, expectedMap);
    fs.writeFileSync(path.join(output, `${name}-ground.wgsl`), state.groundShader);
    state.groundShaderBytes = state.groundShader.length; delete state.groundShader;
    report[name] = state;
    await player.screenshot({ path: path.join(output, `${name}.png`) });
    assert.equal(state.status, 'Ready', state.error ?? JSON.stringify(state));
    assert.ok(state.children.some(child => child.components.includes('terrain')), 'World must generate native Terrain in actual player');
    assert.ok(state.children.some(child => child.components.includes('foliage')), 'World must generate native Foliage in actual player');
    assert.ok(state.meshCount > 8 && state.drawCalls > 0);
    assert.equal(state.groundUsesTerrainWrapper, true, 'Async Mesh material updates replaced native Terrain ground');
    if (!expectedMap) assert.equal(state.boundSurfaceMaps, 6, 'The actual default terrain draw must bind all six supplied surface textures');
    assert.equal(state.storageLimit, 8, 'Player must retain the portable storage-buffer budget');
    assert.equal(state.document.edits[0].value, '#ad375f');
    return state;
  };
  report.builtin = await inspect('builtin');
  await player.evaluate(() => globalThis.__engine.loadScene('scenes/Optional.scene', { setCamera: true }));
  report.optional = await inspect('optional', material.map);
  assert.ok(report.optional.customGround, 'The nested custom material must reach a rendered ground mesh');
  assert.ok(report.requests.every(({ url }) => !/\/scripts\/|\/src\/|\/world-study\//.test(url)), 'Player reached dev-only URLs');
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  report.pass = true;
  console.log(`WORLD-EXPORT PASS modules=${report.modules.length} copies=${report.assetCopies} requests=${report.requests.length}`);
} catch (error) {
  report.failure = String(error.stack ?? error); console.error(report.failure); process.exitCode = 1;
} finally {
  saveReport(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  // Keep the tiny scratch project and exact exported folder for inspection.
  // Browser profiles can be large; delete only the checked scratch child.
  const resolvedProfile = inside(scratch, 'profile');
  fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
