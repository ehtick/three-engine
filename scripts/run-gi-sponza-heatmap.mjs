// ONE-OFF (2026-08-14): localize the post-pan hold churn on the real Sponza.
// Stats cleared capacity pressure and mass cold-starts; the discriminator now
// is SPATIAL — reversal counts concentrated at the pan's newly-revealed edge
// mean young-probe convergence, a uniform field means a global temporal
// mechanism. Runs ONE pan→hold cycle with the calibrated accumulator, then
// writes two heatmap PNGs (reversals, changed-frames) via an in-page canvas.
// Delete with the flicker investigation.
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/sponza-heatmap";
await mkdir(OUT, { recursive: true });
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
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
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
await page.evaluate(() => globalThis.__editorApi.call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] }));
console.log("settling…");
await wait(30000);

const result = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const renderer = engine?.renderer;
  const targets = system?._giTargets;
  const { width, height } = system._giTargetSize;
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, If, float, instanceIndex, instancedArray, ivec2, select, texture, uniform, vec3, vec4 } = TSL;
  const stateBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const irrNode = texture(targets.irradiance);
  const widthU = uniform(width, "uint");
  const armed = uniform(0);
  const accumulator = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const prev = stateBuf.element(instanceIndex).toVar();
    const delta = lum.sub(prev.x).toVar();
    const threshold = float(0.002).max(prev.x.mul(0.01)).toVar();
    const moved = delta.abs().greaterThan(threshold).toVar();
    const outDelta = float(prev.y).toVar();
    const outRev = float(prev.z).toVar();
    const outChanged = float(prev.w).toVar();
    If(moved.and(armed.greaterThan(0.5)), () => {
      const flipped = delta.mul(prev.y).lessThan(0);
      outRev.assign(prev.z.add(select(flipped, float(1), float(0))));
      outDelta.assign(delta);
      outChanged.assign(prev.w.add(1));
    });
    stateBuf.element(instanceIndex).assign(vec4(lum, outDelta, outRev, outChanged));
  })().compute(width * height);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const cam = await api.call("viewport.getCamera", {});
  const [tx, ty, tz] = cam.target;
  const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
  const setCam = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return api.call("viewport.setCamera", {
      position: [tx + dx * c - dz * s, cam.position[1], tz + dx * s + dz * c],
      target: [tx, ty, tz],
    });
  };
  for (let i = 0; i < 30; i++) { await frame(); renderer.compute(accumulator); }
  // ONE pan out (seeding prevLum, not counting), then a 3s hold, counting.
  armed.value = 0;
  for (let i = 0; i < 120; i++) {
    await frame();
    await setCam(((i + 1) / 120) * 0.35);
    renderer.compute(accumulator);
  }
  armed.value = 1;
  const holdFrames = 240;
  for (let i = 0; i < holdFrames; i++) { await frame(); renderer.compute(accumulator); }
  const state = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
  // Render heatmaps to PNG data URLs. Reversals normalized to p99.
  const mk = (get, cap) => {
    const cnv = document.createElement("canvas");
    cnv.width = width; cnv.height = height;
    const ctx = cnv.getContext("2d");
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const v = Math.min(1, get(i) / cap);
      // black → blue → yellow → white ramp
      const r = Math.min(1, Math.max(0, v * 2 - 0.5)) * 255;
      const g = Math.min(1, Math.max(0, v * 1.6 - 0.2)) * 255;
      const b = Math.min(255, v < 0.5 ? v * 2 * 255 : (1 - (v - 0.5)) * 255 + 128);
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cnv.toDataURL("image/png");
  };
  const revs = (i) => state[i * 4 + 2];
  const changed = (i) => state[i * 4 + 3];
  // p99 of reversals for the cap
  const sortedRev = Array.from({ length: width * height }, (_, i) => revs(i)).sort((a, b) => a - b);
  const revCap = Math.max(1, sortedRev[Math.floor(sortedRev.length * 0.99)]);
  let revSum = 0, changedPx = 0, lit = 0;
  for (let i = 0; i < width * height; i++) {
    if (state[i * 4] > 0.002) lit++;
    revSum += revs(i);
    if (changed(i) > 0) changedPx++;
  }
  return {
    width, height, holdFrames, revCap,
    revPerLitPxS: +(revSum / Math.max(1, lit) / (holdFrames / 96)).toFixed(3),
    changedPxPct: +((changedPx / Math.max(1, lit)) * 100).toFixed(1),
    revPng: mk(revs, revCap),
    changedPng: mk(changed, holdFrames * 0.3),
  };
});
console.log(JSON.stringify({ ...result, revPng: "(saved)", changedPng: "(saved)" }));
await writeFile(`${OUT}/reversals.png`, Buffer.from(result.revPng.split(",")[1], "base64"));
await writeFile(`${OUT}/changed.png`, Buffer.from(result.changedPng.split(",")[1], "base64"));
await page.screenshot({ path: `${OUT}/view-after-hold.png` });
console.log(`heatmaps → ${OUT}`);
await browser.close();
