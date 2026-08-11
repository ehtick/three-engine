// WHICH LIGHT JITTERS? — the §12.45.2 diagnostic.
//
// The flicker rig's motion sampling found `_giTrackMotion` latched at 1.00 on
// a PARKED camera in the GAME scene while sh/em/lum maxima read 0.012/0/0 —
// i.e. a small CONSTANT light-matrix motion keeps re-arming the §12.43
// tracking window forever (fast α + relaxed root + since bd3a0a6 a lifted
// cap, all silently permanent in this scene). This probe boots the same page,
// parks everything, and reports PER-LIGHT matrixWorld deltas per frame so the
// jitter has a name.
//
//   node scripts/run-gi-light-jitter-probe.mjs [url]
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
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
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((P) => {
  localStorage.setItem("engine.projectRoot.v1", P);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
// Let the scene + GI settle fully before sampling.
await wait(25000);

const report = await page.evaluate(async () => {
  const list = await globalThis.__editorApi.call("entity.list", {});
  const giEnt = list.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
  if (!giEnt) return { err: "no gi entity" };
  const eng = globalThis.__editorApi.entities.live(giEnt.id)?.engine;
  const system = eng?.modules?.get("gi")?.system;
  if (!system) return { err: "no gi system" };
  const lights = system._lightObjects ?? [];
  const prev = lights.map((l) => ({ e: [...l.matrixWorld.elements], lum: l.intensity }));
  const rows = lights.map((l) => ({
    name: l.name || l.type, type: l.type, intensity: l.intensity,
    maxDir: 0, maxPos: 0, framesMoving: 0, parent: l.parent?.name || l.parent?.type || "?",
  }));
  const trSamples = [];
  const FRAMES = 120;
  for (let f = 0; f < FRAMES; f++) {
    await new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < lights.length; i++) {
      const e = lights[i].matrixWorld.elements;
      const p = prev[i].e;
      const dirDelta = Math.hypot(e[8] - p[8], e[9] - p[9], e[10] - p[10]);
      const posDelta = Math.hypot(e[12] - p[12], e[13] - p[13], e[14] - p[14]);
      rows[i].maxDir = Math.max(rows[i].maxDir, dirDelta);
      rows[i].maxPos = Math.max(rows[i].maxPos, posDelta);
      if (dirDelta + posDelta * 0.05 > 1e-4) rows[i].framesMoving++;
      prev[i].e = [...e];
    }
    trSamples.push({
      tr: system._giTrackMotion ?? 0,
      sh: system._giShadowLastMotion ?? 0,
      em: system._giEmitterLastMotion ?? 0,
      lum: system._giLightLumMotion ?? 0,
    });
  }
  const max = (k) => Math.max(...trSamples.map((s) => s[k]));
  const openFrames = trSamples.filter((s) => s.tr > 0).length;
  return {
    lightCount: lights.length, rows, FRAMES,
    trOpen: openFrames, trMax: max("tr"), shMax: max("sh"), emMax: max("em"), lumMax: max("lum"),
    cap: globalThis.__giSrcTransport?.probeRayCap ?? null,
  };
});

if (report.err) { console.log(`FAIL: ${report.err}`); await browser.close(); process.exit(1); }
console.log(`\n=== LIGHT JITTER PROBE (parked camera, ${report.FRAMES} frames, ${report.lightCount} lights) ===`);
for (const r of report.rows) {
  console.log(`  ${String(r.name).padEnd(24)} ${String(r.type).padEnd(18)} intensity ${String(r.intensity).padEnd(6)} ` +
    `parent ${String(r.parent).padEnd(16)} maxDir ${r.maxDir.toFixed(5)} maxPos ${r.maxPos.toFixed(5)} moving ${r.framesMoving}/${report.FRAMES}`);
}
console.log(`  window: tr>0 on ${report.trOpen}/${report.FRAMES} frames (trMax ${report.trMax.toFixed(2)}), ` +
  `shMax ${report.shMax.toFixed(4)} emMax ${report.emMax.toFixed(2)} lumMax ${report.lumMax.toFixed(4)}, live cap ${report.cap}`);
await browser.close();
process.exit(0);
