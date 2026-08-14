// ONE-OFF (2026-08-14, §12.66): bind-group census PROVED the settled black
// frame's fragment bind groups reference the REAL 4096² ShadowDepthTexture
// (serial-verified) — the placeholder hypothesis is dead. Content good,
// binding good, sample hard-0 ⇒ the comparison itself. This boot:
//   1. dumps the full comparison state (compareFunction, reversedDepthBuffer,
//      autoUpdate, coordinateSystems, shadow.matrix)
//   2. samplers: census every comparison sampler created + which bind groups
//      pair them with the shadow depth view
//   3. CPU truth: raycast 4 visible points, transform by shadow.matrix,
//      textureLoad their texels (primed double-dispatch), z-vs-stored
//   4. live-flips depthTexture.compareFunction → GreaterEqual, then Always:
//      GE lights = ref-z too deep; Always still black = sampler path broken.
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
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
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  const C = globalThis.__cmpCensus = { texSerial: 0, samplers: [], pairs: [] };
  const patch = () => {
    if (!globalThis.GPUDevice?.prototype?.createTexture || GPUDevice.prototype.__ccPatched) return;
    GPUDevice.prototype.__ccPatched = true;
    const origTex = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (desc) {
      const tex = origTex.call(this, desc);
      try {
        tex.__ccInfo = {
          serial: ++C.texSerial, label: String(desc?.label ?? ""), format: desc?.format,
          size: Array.isArray(desc?.size) ? desc.size.slice(0, 2) : [desc?.size?.width, desc?.size?.height],
        };
      } catch {}
      return tex;
    };
    const origView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (desc) {
      const view = origView.call(this, desc);
      try { view.__ccTexInfo = this.__ccInfo ?? null; } catch {}
      return view;
    };
    const origSampler = GPUDevice.prototype.createSampler;
    GPUDevice.prototype.createSampler = function (desc) {
      const s = origSampler.call(this, desc);
      try {
        s.__ccInfo = {
          serial: C.samplers.length, compare: desc?.compare ?? null,
          magFilter: desc?.magFilter, minFilter: desc?.minFilter,
          wrap: [desc?.addressModeU, desc?.addressModeV],
        };
        C.samplers.push({ t: performance.now(), ...s.__ccInfo, stack: new Error().stack?.split("\n").slice(2, 7).join(" | ") });
      } catch {}
      return s;
    };
    const origBG = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (desc) {
      const bg = origBG.call(this, desc);
      try {
        let shadowDepth = null;
        const samplers = [];
        for (const e of desc?.entries ?? []) {
          const ti = e?.resource?.__ccTexInfo;
          if (ti && String(ti.format ?? "").startsWith("depth") && ti.size?.[0] === 4096) shadowDepth = { binding: e.binding, ...ti };
          const si = e?.resource?.__ccInfo;
          if (si && si.compare !== undefined && e.resource instanceof GPUSampler) samplers.push({ binding: e.binding, ...si });
        }
        if (shadowDepth) C.pairs.push({ t: performance.now(), depth: shadowDepth, samplers });
      } catch {}
      return bg;
    };
  };
  patch();
}, PROJECT);
console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(20000);

const readFrame = () => page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let black = 0, lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve({ blackFrac: +(black / (d.length / 4)).toFixed(4), meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4) });
    });
  });
});

console.log(`0-base ${JSON.stringify(await readFrame())}`);

// STEP 1: comparison state dump.
const state = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const r = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light.shadow;
  const dt = s.map?.depthTexture ?? null;
  return {
    reversedDepthBuffer: r.reversedDepthBuffer ?? null,
    logarithmicDepthBuffer: r.logarithmicDepthBuffer ?? null,
    highPrecision: r.highPrecision ?? null,
    shadowMapEnabled: r.shadowMap.enabled, shadowMapType: r.shadowMap.type,
    shadowMapTransmitted: r.shadowMap.transmitted ?? null,
    rendererCoordSys: r.coordinateSystem,
    shadowCamCoordSys: s.camera.coordinateSystem,
    autoUpdate: s.autoUpdate, needsUpdate: s.needsUpdate,
    bias: s.bias, normalBias: s.normalBias, intensity: s.intensity, radius: s.radius,
    perLightType: s.type ?? null, filterNode: s.filterNode ? "SET" : null,
    depthTex: dt ? { compareFunction: dt.compareFunction, version: dt.version, magFilter: dt.magFilter } : null,
    shadowMatrix: s.matrix.elements.map((v) => +v.toFixed(4)),
    cam: { near: s.camera.near, far: s.camera.far, left: s.camera.left, right: s.camera.right },
  };
});
console.log(`state ${JSON.stringify(state)}`);

// STEP 2: comparison samplers paired with the 4096² depth view in bind groups.
const samplerReport = await page.evaluate(() => {
  const C = globalThis.__cmpCensus;
  const byCompare = {};
  for (const p of C.pairs) {
    const k = p.samplers.map((s) => `b${s.binding}:${s.compare ?? "none"}`).join(",") || "NO-SAMPLER-ENTRIES";
    byCompare[k] = (byCompare[k] ?? 0) + 1;
  }
  const compareSamplers = C.samplers.filter((s) => s.compare);
  return {
    totalPairs: C.pairs.length, byCompare,
    comparisonSamplersCreated: compareSamplers.map((s) => ({ t: +(s.t / 1000).toFixed(1), compare: s.compare, mag: s.magFilter })),
    lastPair: C.pairs[C.pairs.length - 1] ?? null,
  };
});
console.log(`samplers ${JSON.stringify(samplerReport)}`);

// STEP 3: CPU truth — raycast 4 screen points, project through shadow.matrix,
// textureLoad stored depth (primed double-dispatch per §12.65.1).
const truth = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const renderer = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light.shadow;
  const depthTex = s.map.depthTexture;
  const cam = engine.camera;
  const ray = new THREE.Raycaster();
  const pts = [];
  for (const [nx, ny] of [[0, 0], [-0.4, -0.3], [0.4, -0.3], [0, 0.35]]) {
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const hits = ray.intersectObjects(engine.scene.children, true).filter((h) => h.object.isMesh && h.object.visible);
    if (hits[0]) pts.push({ p: hits[0].point, n: hits[0].face?.normal ?? new THREE.Vector3(0, 1, 0), name: hits[0].object.name });
  }
  if (!pts.length) return { error: "no raycast hits" };
  const mapW = s.mapSize?.x ?? 4096;
  const coords = pts.map(({ p, n }) => {
    const q = p.clone().addScaledVector(n, s.normalBias ?? 0);
    const v4 = new THREE.Vector4(q.x, q.y, q.z, 1).applyMatrix4(s.matrix);
    const u = v4.x / v4.w, v = v4.y / v4.w, z = v4.z / v4.w;
    return { u: +u.toFixed(4), v: +v.toFixed(4), z: +z.toFixed(4) };
  });
  // load stored depth at both v-orders to sidestep convention doubt
  const { Fn, If, instanceIndex, instancedArray, ivec2, texture } = TSL;
  const N = coords.length * 2;
  const buf = instancedArray(new Float32Array(N), "float");
  const node = texture(depthTex);
  const kernel = Fn(() => {
    coords.forEach((c, i) => {
      const px = Math.min(mapW - 1, Math.max(0, Math.round(c.u * mapW)));
      const pyA = Math.min(mapW - 1, Math.max(0, Math.round((1 - c.v) * mapW)));
      const pyB = Math.min(mapW - 1, Math.max(0, Math.round(c.v * mapW)));
      If(instanceIndex.equal(i * 2), () => { buf.element(instanceIndex).assign(node.load(ivec2(px, pyA)).x); });
      If(instanceIndex.equal(i * 2 + 1), () => { buf.element(instanceIndex).assign(node.load(ivec2(px, pyB)).x); });
    });
  })().compute(N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  renderer.compute(kernel);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  renderer.compute(kernel);
  const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value));
  return coords.map((c, i) => ({
    ...c, mesh: pts[i].name?.slice(0, 20),
    storedFlipV: +a[i * 2].toFixed(4), storedRawV: +a[i * 2 + 1].toFixed(4),
    litIfLE_flip: c.z <= a[i * 2], litIfLE_raw: c.z <= a[i * 2 + 1],
  }));
});
console.log(`cpu-truth ${JSON.stringify(truth, null, 1)}`);

// STEP 4: live compare-function flips.
const flip = async (name) => {
  await page.evaluate(async (cmpName) => {
    const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
    const THREE = await import("/node_modules/three/build/three.webgpu.js");
    let light = null;
    engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
    const dt = light.shadow.map.depthTexture;
    dt.compareFunction = THREE[cmpName];
    dt.needsUpdate = true;           // bump version → sampler key + texture recreate
    light.shadow.needsUpdate = true; // re-render map content after recreate
  }, name);
  await wait(2500);
  return await readFrame();
};
console.log(`flip GreaterEqualCompare → ${JSON.stringify(await flip("GreaterEqualCompare"))}`);
console.log(`flip AlwaysCompare       → ${JSON.stringify(await flip("AlwaysCompare"))}`);
console.log(`flip NeverCompare        → ${JSON.stringify(await flip("NeverCompare"))}`);
console.log(`flip LessEqualCompare    → ${JSON.stringify(await flip("LessEqualCompare"))}`);
await browser.close();
