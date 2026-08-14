// ONE-OFF (2026-08-14, §12.66): black boots are the sun's shadow evaluation
// (castShadow off→lit, on→black; PP/occlusion/tonemap/shadowMapType all
// exonerated; PPOFF boots have ZERO shader errors). This boot dumps the live
// shadow state the frame actually renders with: the leaked-disable check
// (renderGiGBuffer sets renderer.shadowMap.enabled=false OUTSIDE its
// try/finally), NaN checks on the shadow camera, and every scalar on
// light.shadow. Delete with the fix.
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
  globalThis.__ppForceDisabled = true;
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
await wait(20000);

// Shadow-map CONTENT: 64×64 grid of textureLoad over the 4096² depth map.
// Primed-read discipline: first dispatch is SKIPPED while its pipeline
// compiles (the §12.65.1 instrument artifact) — dispatch, wait quiet,
// dispatch again, then read.
const mapContent = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const renderer = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const depthTex = light?.shadow?.map?.depthTexture ?? light?.shadow?.map?.texture;
  if (!depthTex) return { error: "no shadow depth texture" };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint } = TSL;
  const N = 64;
  const buf = instancedArray(new Float32Array(N * N), "float");
  const node = texture(depthTex);
  const step = Math.floor((light.shadow.mapSize?.x ?? 4096) / N);
  const copy = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(step));
    const py = instanceIndex.div(uint(N)).mul(uint(step));
    buf.element(instanceIndex).assign(node.load(ivec2(px.toInt(), py.toInt())).x);
  })().compute(N * N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  renderer.compute(copy);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  renderer.compute(copy);
  const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value));
  let min = Infinity, max = -Infinity, sum = 0, zeros = 0, ones = 0;
  for (const v of a) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v === 0) zeros++;
    if (v === 1) ones++;
  }
  return {
    texType: depthTex.constructor?.name,
    min: +min.toFixed(4), max: +max.toFixed(4), mean: +(sum / a.length).toFixed(4),
    zeroFrac: +(zeros / a.length).toFixed(3), oneFrac: +(ones / a.length).toFixed(3),
    compareFunction: depthTex.compareFunction ?? null,
    format: depthTex.format, type: depthTex.type,
    magFilter: depthTex.magFilter, minFilter: depthTex.minFilter,
  };
});
console.log(`shadow-map content ${JSON.stringify(mapContent)}`);

const state = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const r = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light?.shadow;
  const nan = (arr) => arr.some((v) => Number.isNaN(v));
  return {
    shadowMapEnabled: r.shadowMap.enabled,
    shadowMapAutoUpdate: r.shadowMap.autoUpdate,
    shadowMapType: r.shadowMap.type,
    light: light ? {
      intensity: light.intensity,
      castShadow: light.castShadow,
      matrixWorldNaN: nan(light.matrixWorld.elements),
      targetPos: light.target?.position?.toArray?.(),
      targetInScene: !!light.target?.parent,
    } : null,
    shadow: s ? {
      autoUpdate: s.autoUpdate,
      needsUpdate: s.needsUpdate,
      intensity: s.intensity,
      bias: s.bias,
      normalBias: s.normalBias,
      radius: s.radius,
      mapType: s.map?.constructor?.name ?? null,
      camNear: s.camera?.near, camFar: s.camera?.far,
      camLeft: s.camera?.left, camRight: s.camera?.right,
      camProjNaN: s.camera ? nan(s.camera.projectionMatrix.elements) : null,
      camWorldNaN: s.camera ? nan(s.camera.matrixWorld.elements) : null,
      camPos: s.camera?.position?.toArray?.().map((v) => +v.toFixed(2)),
      matrixNaN: s.matrix ? nan(s.matrix.elements) : null,
      matrix: s.matrix ? s.matrix.elements.map((v) => +v.toFixed(3)) : null,
    } : null,
  };
});
console.log(JSON.stringify(state, null, 1));

// BIAS SWEEP — shadow.bias/normalBias are live uniforms. A frame that lights
// up under a large positive bias means the comparison fails everywhere by a
// systematic offset (depth-range or reversed-Z mismatch), not by content.
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
      let lumSum = 0;
      for (let i = 0; i < d.length; i += 4) lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      resolve(+(lumSum / (d.length / 4) / 255).toFixed(4));
    });
  });
});
// THE CULLING CHAIN (14:17 save flipped the camera component enabled=true →
// it now governs culling → cullShadowCasters:true reaches OcclusionSystem):
const cull = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  try {
    await api.call("component.setProp", { id: "KT0sShKBX-", type: "camera", key: "cullShadowCasters", value: false });
    return { set: true };
  } catch (e) { return { set: false, err: String(e?.message ?? e).slice(0, 150) }; }
});
console.log(`cullShadowCasters=false ${JSON.stringify(cull)}`);
await wait(3000);
console.log(`after-cullShadowCasters-off → meanLum ${await readFrame()}`);
// And the whole camera component disabled (pre-14:17 state):
await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  try { await api.call("component.setProp", { id: "KT0sShKBX-", type: "camera", key: "enabled", value: false }); } catch {}
});
await wait(3000);
console.log(`after-camera-component-disabled → meanLum ${await readFrame()}`);
await browser.close();
