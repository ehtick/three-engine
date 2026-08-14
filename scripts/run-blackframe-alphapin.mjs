// ONE-OFF (2026-08-14, §12.66): slots live+correct, per-boot tiles luminance
// varies 5e-6..2e-4 and creeps upward — convergence-from-black suspiciously
// slow. This boot pins the SRC temporal alpha high (FLAGS, default
// __giSrcAlpha=0.5) and tracks frame lum + tile meanLum every 20s for 3min:
// lights-up = convergence-rate regression; stays black = evidence is ~0.
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const FLAGS = JSON.parse(process.env.FLAGS ?? '{"__giSrcAlpha":0.5}');
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

const read = async (tag) => {
  const r = await page.evaluate(async () => {
    const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
    const sys = engine.modules?.get?.("gi")?.system;
    const frame = await new Promise((resolve) => {
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
    let tiles = null;
    try {
      const s = await sys.state.screen.srcProbes.tiles.readStats(engine.renderer);
      tiles = { meanLum: +(+s.meanLum).toExponential(2), maxLum: +(+s.maxLum).toFixed(4) };
    } catch (e) { tiles = { error: String(e).slice(0, 80) }; }
    return { frame, tiles };
  });
  console.log(`${tag} ${JSON.stringify(r)}`);
};
await wait(15000);
for (let t = 0; t <= 180; t += 20) {
  await read(`t+${t}s`);
  if (t < 180) await wait(20000);
}
await browser.close();
