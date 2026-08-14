// ONE-OFF (2026-08-14, §12.66): tiles' merged radiance is ~0 while the CPU
// emitter seat is rgb=10 — under R5 a promoted emitter's palette emissive is
// zeroed, so ALL its light flows through the slot uniforms, which are
// "recreated at radius 0 by every GI rebuild" while compiled kernels keep the
// slot OBJECTS they captured at build. This boot: (1) dumps the live slot
// uniform values, (2) forces a full GI rebuild (slots + kernels rebuilt
// together), (3) re-reads slots/tiles/frame — heal ⇒ desync proven.
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\]/.test(t)) console.log(`  console: ${t.slice(0, 160)}`);
});
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
const readSlots = () => page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const slots = sys?.state?.emitterSlots ?? [];
  return slots.map((s) => ({
    radius: +(+s.radius.value).toFixed(3),
    color: s.color.value.toArray ? s.color.value.toArray().map((v) => +v.toFixed(1)) : [s.color.value.r, s.color.value.g, s.color.value.b].map((v) => +(+v).toFixed(1)),
    center: s.center?.value?.toArray?.().map((v) => +v.toFixed(2)) ?? null,
    kind: s.kind?.value ?? null,
  }));
});
const readTiles = () => page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const t = sys?.state?.screen?.srcProbes?.tiles;
  if (!t) return { error: "no tiles" };
  try {
    const s = await t.readStats(engine.renderer);
    return { meanLum: +(+s.meanLum).toExponential(2), maxLum: +(+s.maxLum).toFixed(4) };
  } catch (e) { return { error: String(e).slice(0, 100) }; }
});

console.log(`0-frame ${JSON.stringify(await readFrame())}`);
console.log(`0-slots ${JSON.stringify(await readSlots())}`);
console.log(`0-tiles ${JSON.stringify(await readTiles())}`);

// Force a full GI rebuild: blow the fingerprint so the next tick rebuilds.
await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  sys._fingerprint = "__forced_rebuild__";
  sys._rebuildQueued = true;
});
console.log("rebuild forced — waiting 25s for rebuild + compile wave…");
await wait(25000);

console.log(`1-frame ${JSON.stringify(await readFrame())}`);
console.log(`1-slots ${JSON.stringify(await readSlots())}`);
console.log(`1-tiles ${JSON.stringify(await readTiles())}`);
await wait(10000);
console.log(`2-frame (10s later) ${JSON.stringify(await readFrame())}`);
console.log(`2-tiles ${JSON.stringify(await readTiles())}`);
await browser.close();
