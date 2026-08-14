// ONE-OFF (2026-08-14, §12.66): the "hard-0 shadow sample" is CORRECT — the
// sponza prefab has a real roof (sponza_25) occluding the whole interior; the
// live editors are lit by the GI screen chain (emissive-cube emitter →
// emitterShadowPass → resolve → light.giIrradianceNode). Fresh boots have
// healthy GI *field* textures but NO GI in the frame. This boot measures the
// GI SCREEN chain in the black state:
//   frame lum, profile.giPasses (same op the live editor answers), pending
//   compute pipelines, and the screen irradiance target's actual content.
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
page.on("pageerror", (e) => console.log(`  PAGEERROR: ${(e.stack ?? e.message ?? String(e)).slice(0, 200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
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

const frame = await page.evaluate(async () => {
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
console.log(`0-base ${JSON.stringify(frame)}`);

const pending = await page.evaluate(() => ({
  pendingComputePipelines: globalThis.__giPendingComputePipelines?.size ?? "n/a",
}));
console.log(`pending ${JSON.stringify(pending)}`);

// The exact op the live editor answered: per-pass GI profile.
const profile = await page.evaluate(async () => {
  try {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 10 });
    return { emitters: r.emitters, adoptedMovers: r.adoptedMovers, screenPassesMs: r.screenPassesMs, screenTotalMs: r.screenTotalMs, srcNote: r.srcProbes?.note, shadedHits: r.srcProbes?.shadedHitsPerFrame, unattributed: r.srcProbes?.unattributedRate, queueTotalMs: r.queueTotalMs };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; }
});
console.log(`giPasses ${JSON.stringify(profile, null, 1)}`);

// Read the screen irradiance target's content (primed double-dispatch).
const irr = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  if (!sys) return { error: "no gi system" };
  const tex =
    sys._giTargets?.irradiance ??
    sys._giIrradianceNode?.value ?? null;
  if (!tex) return { error: "no irradiance target", keys: Object.keys(sys).filter((k) => /target|irr/i.test(k)).slice(0, 20) };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint } = TSL;
  const W = tex.image?.width ?? 0, H = tex.image?.height ?? 0;
  if (!W) return { error: "no size", type: tex.constructor?.name };
  const N = 48;
  const buf = instancedArray(new Float32Array(N * N * 3), "vec3");
  const node = texture(tex);
  const sx = Math.max(1, Math.floor(W / N)), sy = Math.max(1, Math.floor(H / N));
  const kernel = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(sx));
    const py = instanceIndex.div(uint(N)).mul(uint(sy));
    buf.element(instanceIndex).assign(node.load(ivec2(px.toInt(), py.toInt())).xyz);
  })().compute(N * N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  engine.renderer.compute(kernel);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  engine.renderer.compute(kernel);
  const a = new Float32Array(await engine.renderer.getArrayBufferAsync(buf.value));
  let sum = 0, mx = 0, nz = 0;
  for (let i = 0; i < a.length; i += 4) { // vec3 storage strides as vec4? read conservatively
    const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
    if (Number.isFinite(l)) { sum += l; if (l > mx) mx = l; if (l > 0.001) nz++; }
  }
  const count = a.length / 4;
  return { size: [W, H], texType: tex.constructor?.name, mean: +(sum / count).toFixed(4), max: +mx.toFixed(3), litFrac: +(nz / count).toFixed(3) };
});
console.log(`irradiance ${JSON.stringify(irr)}`);

// Does the material-side giLight actually reference this texture?
const hook = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  let giLight = null;
  engine.scene.traverse((o) => { if (o.isLight && o.giIrradianceNode && !giLight) giLight = o; });
  return {
    giLightFound: !!giLight,
    giLightType: giLight?.constructor?.name ?? null,
    giLightVisible: giLight?.visible ?? null,
    giLightIntensity: giLight?.intensity ?? null,
    nodeValueSameAsTarget: giLight ? giLight.giIrradianceNode?.value === (sys?._giTargets?.irradiance ?? null) : null,
    nodeValueType: giLight?.giIrradianceNode?.value?.constructor?.name ?? null,
  };
});
console.log(`hook ${JSON.stringify(hook)}`);
await browser.close();
