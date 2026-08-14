// ONE-OFF (2026-08-14, §12.66): gbuffer full, emitter seat rgb=10, probes
// live, 22k hits shaded — yet SRC's screenGather output is 0.000. The gather
// reads the c0 TILE ATLAS. This boot reads the atlas + its bake telemetry
// (tiles.readStats), and censuses per-frame SKIPPED computes over 60 frames
// (giSkippedComputes is per-frame; snapshot at postRender before the clear).
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

// 1. tile bake telemetry
const stats = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const tiles = sys.state.screen?.srcProbes?.tiles;
  if (!tiles) return { error: "no tiles" };
  try { return await tiles.readStats(engine.renderer); } catch (e) { return { error: String(e).slice(0, 200) }; }
});
console.log(`tileStats ${JSON.stringify(stats)}`);

// 2. atlas content
const atlas = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const tex = sys.state.screen?.srcProbes?.tiles?.atlas;
  if (!tex) return { error: "no atlas" };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const W = tex.image.width, H = tex.image.height;
  const N = 64;
  const buf = instancedArray(new Float32Array(N * N * 4), "vec4");
  const node = texture(tex);
  const sx = Math.max(1, Math.floor(W / N)), sy = Math.max(1, Math.floor(H / N));
  const kernel = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(sx));
    const py = instanceIndex.div(uint(N)).mul(uint(sy));
    buf.element(instanceIndex).assign(vec4(node.load(ivec2(px.toInt(), py.toInt()))));
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
  let sum = 0, mx = 0, cover = 0;
  const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
    if (Number.isFinite(l)) { sum += l; if (l > mx) mx = l; }
    if (a[i + 3] > 0.5) cover++;
  }
  return { size: [W, H], rgbMean: +(sum / count).toFixed(4), rgbMax: +mx.toFixed(3), coverFrac: +(cover / count).toFixed(3) };
});
console.log(`atlas ${JSON.stringify(atlas)}`);

// 3. skip census over 60 frames
const skips = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const names = {};
  let frames = 0;
  await new Promise((resolve) => {
    const off = engine.onPostRender(() => {
      const set = globalThis.__giSkippedComputesSet;
      if (set) for (const n of set) {
        const label = n?.__giPassName ?? n?.name ?? "?";
        names[label] = (names[label] ?? 0) + 1;
      }
      if (++frames >= 60) { off(); resolve(); }
    });
  });
  return { frames, skipped: names };
});
console.log(`skips ${JSON.stringify(skips)}`);
await browser.close();
