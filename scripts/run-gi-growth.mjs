// GI GROWTH PROBE — the user's report: "gpu ms grow with time, constantly,
// 20ms -> 30 in ~10 seconds when light and the cube move" on ultra. A cost
// that RISES under a constant workload is an accumulation defect, not a cost;
// this probe reproduces the workload (sun rotating + a spawned cube moving,
// every frame) and samples once per second:
//
//   - median per-frame GPU render/compute (self-driven resolveTimestampsAsync,
//     the session-21 recipe — renderer.info alone lies when a pool is empty)
//   - GPU OBJECT CREATION counters patched onto GPUDevice at document start
//     (buffers net-of-destroy + bytes, bind groups, pipelines, textures,
//     query sets): whichever counter climbs linearly names the leak class
//   - JS heap, compute dispatch calls per frame
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-growth.mjs
//
// Env:
//   PROJECT=<path>    default C:/Users/Khudiiash/Documents/GAME
//   SECONDS=30        measurement window
//   QUALITY=ultra     preset forced for the run (restored after)
//   STILL=1           control arm: same probe, nothing moving
//   NOSHADOW=1        bisect arm: sun shadowMode -> map for the run
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SECONDS = Number(process.env.SECONDS ?? 30);
const QUALITY = process.env.QUALITY ?? "ultra";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
// VIEW=2560x1440 reproduces the user's monitor — GI screen passes scale with
// resolution, so a 1400x900 probe understates their cost ~3x.
const VIEW = (process.env.VIEW ?? "1400x900").split("x").map(Number);
await page.setViewport({ width: VIEW[0] || 1400, height: VIEW[1] || 900, deviceScaleFactor: Number(process.env.DPR ?? 1) });
await installTauriShim(page, {});
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy|\[gi\] ray-hit|GROWTH/.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 400)}`);
});

// GPU object-creation counters, installed before any engine code runs.
await page.evaluateOnNewDocument((PROJECT) => {
  // The editor stops the engine loop for an unfocused viewport
  // (editorFramePacing) — headless is never focused, so without this every
  // motion arm reads a sleeping engine (giDisp ~8/s, compute 0.00).
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  const c = {
    buffer: 0, bufferDestroyed: 0, bufferBytes: 0,
    bindGroup: 0, computePipeline: 0, renderPipeline: 0,
    texture: 0, textureDestroyed: 0, querySet: 0, shaderModule: 0,
  };
  globalThis.__GPU_COUNTERS__ = c;
  const patch = (proto, name, fn) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...args) { fn(args); return orig.apply(this, args); };
  };
  if (globalThis.GPUDevice) {
    patch(GPUDevice.prototype, "createBuffer", (a) => { c.buffer++; c.bufferBytes += a[0]?.size ?? 0; });
    patch(GPUDevice.prototype, "createBindGroup", () => c.bindGroup++);
    patch(GPUDevice.prototype, "createComputePipeline", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createComputePipelineAsync", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createRenderPipeline", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createRenderPipelineAsync", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createTexture", () => c.texture++);
    patch(GPUDevice.prototype, "createQuerySet", () => c.querySet++);
    patch(GPUDevice.prototype, "createShaderModule", () => c.shaderModule++);
  }
  if (globalThis.GPUBuffer) {
    patch(GPUBuffer.prototype, "destroy", () => c.bufferDestroyed++);
  }
  if (globalThis.GPUTexture) {
    patch(GPUTexture.prototype, "destroy", () => c.textureDestroyed++);
  }
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = async (op, args = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
    try {
      return await page.evaluate(async ({ op, args }) => {
        try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
        catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
      }, { op, args });
    } catch (err) {
      if (attempt === 2) return { ok: false, error: err?.message ?? String(err) };
      await wait(4000);
    }
  }
};

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
const giEntity = entities.find((e) => componentOf(e, "global-illumination"));
const sunEntity =
  entities.find((e) => componentOf(e, "light")?.props?.kind === "directional" && componentOf(e, "light")?.props?.castShadow) ??
  entities.find((e) => componentOf(e, "light")?.props?.kind === "directional");
if (!giEntity || !sunEntity) { console.log("FATAL: gi or sun entity missing"); await browser.close(); process.exit(1); }
const giProps = componentOf(giEntity, "global-illumination")?.props ?? {};
const savedQuality = giProps.quality ?? "custom";

await wait(15000);

if (process.env.NOSHADOW) {
  await call("component.setProp", { id: sunEntity.id, type: "light", key: "shadowMode", value: "map" });
  console.log("  bisect: shadowMode -> map");
}
if (process.env.ANGLE) {
  await call("component.setProp", { id: sunEntity.id, type: "light", key: "sourceAngle", value: Number(process.env.ANGLE) });
  console.log(`  sourceAngle -> ${process.env.ANGLE}`);
}
if (QUALITY && QUALITY !== savedQuality) {
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: QUALITY });
  console.log(`  quality -> ${QUALITY}`);
  await wait(30000);
}

// Spawn the mover cube and force a structural rebuild so it enters the field.
await page.evaluate(async (anchorId) => {
  const api = globalThis.__editorApi;
  const eng = api?.entities?.live(anchorId)?.engine;
  const { THREE } = await import("/src/engine/index.js");
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
  );
  mesh.position.set(-1.5, 1.7, -0.4);
  mesh.rotation.set(0.5, 0.7, 0.3);
  mesh.updateMatrixWorld(true);
  eng.scene.add(mesh);
  globalThis.__GROWTH_MESH__ = mesh;
}, sunEntity.id);
// Force the structural rebuild that lets the spawned mesh enter the GI
// fingerprint. MUST be a real change: setting the prop to its saved value is
// a no-op and the mesh stays invisible to GI (compute 0.00, ambient-cadence
// dispatches — the broken-arm signature this line once produced).
// PROFILING=on|off|flip (default flip): the flip doubles as the structural
// poke that lets the spawned mesh enter the GI fingerprint. "on"/"off" pin
// the final value for cost A/Bs — the user's scene SAVES profiling on, and
// the counters are atomics in every trace, so the arms differ wildly.
const originalProfiling = giProps.rayHitProfiling === true;
const profilingWant =
  process.env.PROFILING === "on" ? true :
  process.env.PROFILING === "off" ? false : !originalProfiling;
if (profilingWant === originalProfiling) {
  // Still need a structural change for the mesh capture: flip away and back.
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: !originalProfiling });
  await wait(8000);
}
await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: profilingWant });
console.log(`  rayHitProfiling: saved=${originalProfiling} arm=${profilingWant}`);
await wait(30000);

// PLAY=1 — measure the frame the USER'S FPS panel measures: game camera,
// postprocess stack, scripts, everything. The edit-mode arms cannot see any
// of that, which is exactly how a 5ms edit-mode reading coexists with a
// 57ms panel reading.
if (process.env.PLAY) {
  const r = await call("play.set", { playing: true });
  console.log(`  play mode: ${JSON.stringify(r)}`);
  await wait(15000);
}

// Capture check: is the spawned mesh actually inside the GI field?
const captured = await page.evaluate((anchorId) => {
  const eng = globalThis.__editorApi?.entities?.live(anchorId)?.engine;
  const field = eng?.modules?.get('gi')?.system?.state?.volume?.occupancyField;
  const mesh = globalThis.__GROWTH_MESH__;
  return {
    hasField: !!field,
    placements: field?.placements?.length ?? -1,
    meshCaptured: !!field?.placements?.some((p) => p.mesh === mesh),
    slots: field?.stats?.slots ?? -1,
  };
}, sunEntity.id);
console.log(`  capture: ${JSON.stringify(captured)}`);

// The measurement: drive motion per frame in-page, sample once per second.
const rows = await page.evaluate(async ({ anchorId, sunId, seconds, still, mover, motion }) => {
  const api = globalThis.__editorApi;
  const eng = api.entities.live(anchorId).engine;
  const renderer = eng.renderer;
  const sunObj = api.entities.live(sunId)?.object3D;
  const mesh = globalThis.__GROWTH_MESH__;
  const base = mesh.position.clone();
  const counters = globalThis.__GPU_COUNTERS__ ?? {};
  const occStats = () => eng.modules?.get("gi")?.system?.state?.volume?.occupancyField?.stats ?? {};

  // Session-21 timestamp recipe: block the engine's own resolver, drive it
  // ourselves once per frame.
  const engineResolverBlock = new Promise(() => {});
  eng._gpuTimestampInFlight = engineResolverBlock;

  const rows = [];
  let gpuRender = [];
  let gpuCompute = [];
  let frames = 0;
  let sampling = false;
  const sampleGpu = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const calls0 = renderer.info?.compute?.calls ?? 0;
      const [rt, ct] = await Promise.all([
        renderer.resolveTimestampsAsync("render"),
        renderer.resolveTimestampsAsync("compute"),
      ]);
      const calls1 = renderer.info?.compute?.calls ?? 0;
      if (typeof rt === "number" && rt > 0) gpuRender.push(rt);
      if (typeof ct === "number") gpuCompute.push(calls1 > calls0 ? ct : 0);
    } catch { /* dropped sample */ }
    sampling = false;
  };
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const start = performance.now();
  let lastRow = start;
  const snap = () => ({ ...counters });
  let prev = snap();
  let prevDispatches = occStats().dispatches ?? 0;

  await new Promise((resolve) => {
    const step = (now) => {
      frames++;
      const t = (now - start) / 1000;
      if (!still) {
        if (mover !== "sun") {
          if (motion !== "rot") mesh.position.x = base.x + Math.sin(2 * Math.PI * 0.4 * t) * 1.2;
          if (motion !== "pos") mesh.rotation.y += 0.01;
          mesh.updateMatrixWorld(true);
        }
        if (mover !== "cube" && sunObj) {
          sunObj.rotation.z += 0.002;
          sunObj.updateMatrixWorld(true);
        }
      }
      sampleGpu();
      if (now - lastRow >= 1000) {
        const cur = snap();
        const st = occStats();
        const dispatches = st.dispatches ?? 0;
        rows.push({
          t: Math.round(t),
          render: median(gpuRender),
          compute: median(gpuCompute),
          frames,
          buffers: (cur.buffer - cur.bufferDestroyed) - (prev.buffer - prev.bufferDestroyed),
          bufferMB: (cur.bufferBytes - prev.bufferBytes) / 1e6,
          bindGroups: cur.bindGroup - prev.bindGroup,
          computePipes: cur.computePipeline - prev.computePipeline,
          renderPipes: cur.renderPipeline - prev.renderPipeline,
          textures: (cur.texture - cur.textureDestroyed) - (prev.texture - prev.textureDestroyed),
          heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1e6,
          giDispatches: dispatches - prevDispatches,
        });
        prevDispatches = dispatches;
        prev = cur;
        gpuRender = [];
        gpuCompute = [];
        frames = 0;
        lastRow = now;
      }
      if (t < seconds) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  return rows;
}, { anchorId: sunEntity.id, sunId: sunEntity.id, seconds: SECONDS, still: !!process.env.STILL, mover: process.env.MOVER ?? "both", motion: process.env.MOTION ?? "both" });

console.log(`\nGROWTH ${process.env.STILL ? "STILL" : "MOVING"} ${QUALITY} — per-second rows:`);
console.log("  t   render  compute  fps  Δbuf  ΔbufMB  ΔbindGrp  Δpipes(c/r)  Δtex  heapMB  giDisp");
for (const r of rows) {
  console.log(
    `  ${String(r.t).padStart(2)}  ${r.render.toFixed(2).padStart(6)}  ${r.compute.toFixed(2).padStart(7)}` +
    `  ${String(r.frames).padStart(3)}  ${String(r.buffers).padStart(4)}  ${r.bufferMB.toFixed(1).padStart(6)}` +
    `  ${String(r.bindGroups).padStart(8)}  ${String(r.computePipes).padStart(5)}/${r.renderPipes}` +
    `  ${String(r.textures).padStart(4)}  ${r.heapMB.toFixed(0).padStart(6)}  ${String(r.giDispatches).padStart(4)}`,
  );
}
const first = rows.slice(1, 4).reduce((a, r) => a + r.render + r.compute, 0) / 3;
const last = rows.slice(-3).reduce((a, r) => a + r.render + r.compute, 0) / 3;
console.log(`\n  GPU total first-3s ${first.toFixed(2)}ms -> last-3s ${last.toFixed(2)}ms  (${last > first * 1.2 ? "GROWING" : "flat"})`);

// Restore.
await page.evaluate((anchorId) => {
  const eng = globalThis.__editorApi?.entities?.live(anchorId)?.engine;
  const mesh = globalThis.__GROWTH_MESH__;
  if (eng?.scene && mesh) eng.scene.remove(mesh);
}, sunEntity.id);
await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: originalProfiling });
if (QUALITY !== savedQuality) {
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: savedQuality });
}
if (process.env.NOSHADOW) {
  await call("component.setProp", { id: sunEntity.id, type: "light", key: "shadowMode", value: "gi" });
}
console.log("\nGI-GROWTH DONE");
await browser.close();
process.exit(0);
