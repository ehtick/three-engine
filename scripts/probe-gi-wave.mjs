// Where does the GI compile wave's wall-time actually go?
// Splits it into: JS node codegen (NodeBuilder.build), WGSL shader-module
// creation, and driver pipeline compilation (createRenderPipeline[Async]).
// Also reports generated WGSL sizes — the GI light node injects its cascade
// gather + emitter shadow traces into every lit material's shader.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on("console", (m) => { if (/\[gi\]|PROBE/.test(m.text())) console.log(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
await page.goto("http://localhost:5201/", { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

// A/B switch for the per-builder Fn layouts (giFn.js): NOLAYOUTS=1 reproduces
// the old fully-inlined codegen on the SAME machine state.
if (process.env.NOLAYOUTS) await page.evaluate(() => { globalThis.__giNoLayouts = true; });

const MESHES = Number(process.env.MESHES ?? 0);

await page.evaluate(async (meshCount) => {
  const { THREE } = await import("/src/engine/index.js");
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  for (let i = 0; i < meshCount; i++) {
    const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color().setHSL(i / meshCount, 0.6, 0.55) });
    m.roughness = 0.2 + (i % 5) * 0.18;
    m.metalness = i % 2 ? 0.9 : 0;
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), m);
    box.position.set(-4 + (i % 5) * 2, 0.6 + Math.floor(i / 5) * 1.4, -3 + (i % 3) * 3);
    engine.scene.add(box);
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    (() => { const m = new THREE.MeshStandardNodeMaterial({ color: 0xcccccc }); m.roughness = 0.9; return m; })(),
  );
  ground.rotation.x = -Math.PI / 2;
  engine.scene.add(ground);
  const lampMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  lampMat.roughness = 1;
  lampMat.emissive = new THREE.Color(0xffffff);
  lampMat.emissiveIntensity = 8;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 14), lampMat);
  lamp.position.set(0, 4.2, 0);
  engine.scene.add(lamp);
  engine.camera.position.set(0.4, 4.2, 14);
  engine.camera.lookAt(0, 2, 0);
  engine.camera.updateMatrixWorld(true);

  // ---- instrumentation -------------------------------------------------
  const stats = (globalThis.__stats = {
    shaderModules: [], pipelines: [], nodeBuilds: [], wgslChars: 0,
  });
  const device = engine.renderer.backend?.device;
  if (!device) throw new Error("no WebGPU device on renderer.backend");
  const origModule = device.createShaderModule.bind(device);
  device.createShaderModule = (desc) => {
    const t = performance.now();
    const out = origModule(desc);
    stats.shaderModules.push({ ms: performance.now() - t, chars: desc?.code?.length ?? 0, label: desc?.label ?? "" });
    stats.wgslChars += desc?.code?.length ?? 0;
    // Keep the biggest shader for inspection.
    if (!stats.biggest || (desc?.code?.length ?? 0) > stats.biggest.chars) {
      stats.biggest = { chars: desc.code.length, label: desc.label ?? "", code: desc.code };
    }
    return out;
  };
  for (const key of ["createRenderPipeline", "createComputePipeline"]) {
    const orig = device[key].bind(device);
    device[key] = (desc) => {
      const t = performance.now();
      const out = orig(desc);
      stats.pipelines.push({ kind: key, ms: performance.now() - t, async: false, label: desc?.label ?? "" });
      return out;
    };
  }
  for (const key of ["createRenderPipelineAsync", "createComputePipelineAsync"]) {
    const orig = device[key].bind(device);
    device[key] = async (desc) => {
      const t = performance.now();
      const out = await orig(desc);
      stats.pipelines.push({ kind: key, ms: performance.now() - t, async: true, label: desc?.label ?? "" });
      return out;
    };
  }
  // JS-side node codegen: three builds each material's node graph here.
  const nodes = engine.renderer._nodes;
  const builderProto = Object.getPrototypeOf(nodes);
  const origGetForRender = builderProto.getForRender;
  builderProto.getForRender = function (renderObject, ...rest) {
    const had = renderObject.getNodeBuilderState !== undefined;
    const t = performance.now();
    const out = origGetForRender.call(this, renderObject, ...rest);
    const ms = performance.now() - t;
    if (ms > 5) stats.nodeBuilds.push({ ms, material: renderObject.material?.type ?? "?" });
    return out;
  };
  console.log(`PROBE instrumented (${meshCount} extra materials)`);
}, MESHES);

await page.evaluate((props) => {
  const e = globalThis.__engine.createEntity({ name: "GI" });
  globalThis.__waveStart = performance.now();
  // `reflections`/`emissiveShadows` are no longer properties — they go through
  // the measurement hatch (src/modules/gi/giConfig.js). `quality` still does.
  globalThis.__giConfigOverride = {
    reflections: props.reflections, emissiveShadows: props.emissiveShadows,
  };
  globalThis.__gi = e.addComponent("global-illumination", { quality: props.quality });
}, {
  reflections: !process.env.NOREFL,
  emissiveShadows: !process.env.NOEMSH,
  quality: process.env.QUALITY ?? "high",
});

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const done = await page.evaluate(() => globalThis.__engine.renderSuspended === false);
  if (done && i > 0) break;
}

if (process.env.REBUILD) {
  await page.evaluate(() => {
    const s = globalThis.__stats;
    s.shaderModules.length = 0;
    s.pipelines.length = 0;
    s.nodeBuilds.length = 0;
    s.mark = performance.now();
    globalThis.__gi.props.quality = "ultra";
    globalThis.__gi.onPropChanged("quality");
  });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const done = await page.evaluate(() => globalThis.__engine.renderSuspended === false);
    if (done && i > 1) break;
  }
  await new Promise((r) => setTimeout(r, 4000));
  const rb = await page.evaluate(() => {
    const s = globalThis.__stats;
    const sum = (a) => a.reduce((x, y) => x + y.ms, 0);
    const sync = s.pipelines.filter((p) => !p.async);
    const async_ = s.pipelines.filter((p) => p.async);
    return {
      syncPipelines: sync.length,
      syncMs: sum(sync),
      worstSync: Math.max(0, ...sync.map((p) => p.ms)),
      worstSyncKind: sync.sort((a, b) => b.ms - a.ms)[0]?.kind,
      asyncPipelines: async_.length,
      asyncMs: sum(async_),
      shaderModules: s.shaderModules.length,
      biggestKB: Math.round(Math.max(0, ...s.shaderModules.map((m) => m.chars)) / 1024),
    };
  });
  console.log("\n=== rebuild (quality → ultra) ===");
  console.log(JSON.stringify(rb, null, 2));
}

const report = await page.evaluate(() => {
  const s = globalThis.__stats;
  const sum = (a) => a.reduce((x, y) => x + y.ms, 0);
  const top = (a, n) => [...a].sort((x, y) => y.ms - x.ms).slice(0, n)
    .map((e) => `${e.ms.toFixed(0)}ms${e.chars ? ` (${(e.chars / 1024).toFixed(0)}kB)` : ""}${e.label ? ` ${e.label}` : ""}${e.material ? ` ${e.material}` : ""}`);
  return {
    shaderModuleCount: s.shaderModules.length,
    shaderModuleMs: sum(s.shaderModules),
    pipelineCount: s.pipelines.length,
    pipelineMs: sum(s.pipelines),
    asyncPipelineMs: sum(s.pipelines.filter((p) => p.async)),
    syncPipelineMs: sum(s.pipelines.filter((p) => !p.async)),
    nodeBuildCount: s.nodeBuilds.length,
    nodeBuildMs: sum(s.nodeBuilds),
    totalWgslKB: (s.wgslChars / 1024).toFixed(0),
    biggestShaderKB: s.biggest ? (s.biggest.chars / 1024).toFixed(0) : null,
    biggestShaderLabel: s.biggest?.label,
    fragmentKB: s.shaderModules.filter((m) => /fragment/.test(m.label)).map((m) => Math.round(m.chars / 1024)).sort((a, b) => b - a),
    topShaderModules: top(s.shaderModules, 5),
    topPipelines: top(s.pipelines, 5),
    topNodeBuilds: top(s.nodeBuilds, 5),
  };
});
console.log("\n=== wave cost breakdown ===");
console.log(JSON.stringify(report, null, 2));

if (process.env.DUMP) {
  const code = await page.evaluate(() => globalThis.__stats.biggest?.code ?? "");
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.DUMP, code);
  console.log(`biggest shader written to ${process.env.DUMP} (${(code.length / 1024).toFixed(0)}kB)`);
}

await browser.close();
process.exit(0);
