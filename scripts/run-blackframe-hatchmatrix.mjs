// ONE-OFF (2026-08-14, §12.66): the deposit's shaded radiance is ~0 on fresh
// boots (tiles meanLum 2e-5) while probes/rays/hits/emitter-seat are healthy.
// The lit-14:07 → black-14:40 boundary brackets today's SRC edits, all
// hatched. This boot applies hatches from FLAGS (JSON env var) at document
// start and reads frame lum + tile luminance — the regression bisector.
//   FLAGS='{"__giSrcSeed":false}' node scripts/run-blackframe-hatchmatrix.mjs
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const FLAGS = JSON.parse(process.env.FLAGS ?? "{}");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`FLAGS ${JSON.stringify(FLAGS)}`);
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
await page.evaluateOnNewDocument((project, flags) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, PROJECT, FLAGS);
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
const tiles = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const t = sys?.state?.screen?.srcProbes?.tiles;
  if (!t) return { error: "no tiles" };
  try {
    const s = await t.readStats(engine.renderer);
    return { meanLum: s.meanLum, maxLum: s.maxLum, lit: s.lit, coverage: +(+s.coverage).toFixed(3) };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
});
// CLEAN emitterShadow read (no profiler contamination in this script).
const esh = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const tex = sys?.state?.screen?.targets?.emitterShadow;
  if (!tex) return { error: "no emitterShadow" };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const W = tex.image.width, H = tex.image.height;
  const N = 40;
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
  let sum = 0, mn = Infinity, mx = -Infinity;
  const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) { sum += a[i]; if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
  return { size: [W, H], xMean: +(sum / count).toFixed(3), xMin: +mn.toFixed(3), xMax: +mx.toFixed(3) };
});
console.log(`emitterShadow(clean) ${JSON.stringify(esh)}`);
console.log(`VERDICT frame=${JSON.stringify(frame)} tiles=${JSON.stringify(tiles)} → ${frame.blackFrac < 0.5 ? "LIT" : "BLACK"}`);
await browser.close();
