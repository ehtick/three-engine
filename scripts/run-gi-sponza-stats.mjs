// ONE-OFF (2026-08-14): pan-hold churn on the real Sponza is ~2.2 rev/px/s
// with every live hatch inside replicate noise — so the residual is probe
// lifecycle, not the temporal filters. This dumps EVERY readStats-bearing
// frame on `state.screen.srcProbes` twice — MID-PAN and PARKED — looking for
// capacity pressure (`noBlock` refusals, seed orphan/cold rates, probe churn).
// Delete with the flicker investigation.
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
  if (/\[gi\] (surface records|src)/.test(t)) console.log(`  ${t.slice(0, 400)}`);
});
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

const dump = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const renderer = engine?.renderer;
  const src = system?.state?.screen?.srcProbes;
  if (!src) return { error: "no srcProbes" };
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const statBearers = [];
  const seen = new Set();
  const scan = (obj, path, depth) => {
    if (!obj || typeof obj !== "object" || depth > 2 || seen.has(obj)) return;
    seen.add(obj);
    if (typeof obj.readStats === "function") { statBearers.push([path, obj]); return; }
    for (const k of Object.keys(obj)) {
      if (k.startsWith("_")) continue;
      try { scan(obj[k], `${path}.${k}`, depth + 1); } catch {}
    }
  };
  scan(src, "src", 0);
  const readAll = async () => {
    const out = {};
    for (const [path, obj] of statBearers) {
      try { out[path] = await obj.readStats(renderer); } catch (e) { out[path] = String(e).slice(0, 120); }
    }
    return out;
  };
  // Structural facts worth having beside the stats.
  const store = src.store ?? src.binStore ?? null;
  const structure = {
    keys: Object.keys(src),
    cascades: (store?.cascades ?? []).map((c) => ({
      probeCapacity: c.probeCapacity, blockCapacity: c.blockCapacity, bins: c.bins,
    })),
    statBearers: statBearers.map(([p]) => p),
  };
  // PARKED read.
  for (let i = 0; i < 10; i++) await frame();
  const parked = await readAll();
  // MID-PAN read: pan continuously, read stats while the camera is IN MOTION.
  const cam = await api.call("viewport.getCamera", {});
  const [tx, ty, tz] = cam.target;
  const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
  let panning = true;
  (async () => {
    let theta = 0, dir = 1;
    while (panning) {
      await frame();
      theta += dir * 0.003; if (Math.abs(theta) > 0.35) dir = -dir;
      const c = Math.cos(theta), s = Math.sin(theta);
      await api.call("viewport.setCamera", {
        position: [tx + dx * c - dz * s, cam.position[1], tz + dx * s + dz * c],
        target: [tx, ty, tz],
      });
    }
  })();
  for (let i = 0; i < 40; i++) await frame(); // 40 frames into the pan
  const midPan = await readAll();
  for (let i = 0; i < 40; i++) await frame();
  const midPan2 = await readAll();
  panning = false;
  await api.call("viewport.setCamera", { position: cam.position, target: cam.target });
  return { structure, parked, midPan, midPan2 };
});
console.log(JSON.stringify(dump, null, 1));
await browser.close();
