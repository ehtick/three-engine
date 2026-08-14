// ONE-OFF BISECT (2026-08-13): masked exact reflections render a broken frame
// (white walls / black floor) on the enclosed mirror storm rig. Two suspects,
// separable because `wantsMirrorMask` (GISystem #tick) re-reads __giBvhMask
// EVERY FRAME while the prepass kernel bakes its gate at build:
//   flip __giBvhMask=false LIVE →
//     frame recovers  ⇒ the gbuffer MASK PASS render is the corruptor
//     frame stays bad ⇒ the masked PREPASS/consumer path is
// Uses the storm rig already generated at scripts/.gi-emissive-cost by
// run-gi-emissive-cost.mjs (MIRROR=1 arm). Delete this file when the bug is
// closed.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-emissive-cost").replaceAll("\\", "/");
const OUT = ".gi-shots/mask-bisect";
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\]/.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  // §12.56 REVERTED the mask's default flip — it is opt-in again, so the
  // repro must opt in explicitly or this script measures a dense boot.
  globalThis.__giBvhMask = true;
}, GEN_ROOT);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
for (let i = 0; i < 150 && !built; i++) await wait(1000);
console.log(`built=${built}`);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await page.evaluate(
  (args) => globalThis.__editorApi.call("viewport.setCamera", args),
  { position: [0, 1.9, 6.2], target: [0, 0.8, -2] },
);
// The numeric story: which stage goes dark. Deposits → shaded hits → merge →
// gather → (screen) — read off the live system, no texture readback needed.
const stats = () => page.evaluate(async () => {
  const ids = await globalThis.__editorApi.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const eng = anyId ? globalThis.__editorApi.entities.live(anyId)?.engine : null;
  const gi = eng?.modules?.get?.("gi")?.system;
  const src = gi?.state?.screen?.srcProbes;
  const renderer = eng?.renderer;
  if (!src || !renderer) return { error: "no src system" };
  const s = await src.readStats(renderer);
  return {
    rays: s.rays ? {
      rays: s.rays.rays, hits: s.rays.hits, deposits: s.rays.deposits,
      shaded: s.rays.shaded, maxL: s.rays.maxRadianceFraction,
      secondaryHits: s.rays.secondaryHits,
    } : null,
    merge: s.merge ? { bins: s.merge.bins, merged: s.merge.merged, sky: s.merge.sky } : null,
    gather: s.gather ?? null,
    seed: s.seed ?? null,
    live: (s.cascades ?? []).map((c) => c.live),
  };
});
console.log("built — settling 20s under masked defaults…");
await wait(20000);
// §12.56's split appeared WITH THE EMITTERS LIT — the saved rig boots with
// most lamps hidden (the emissive-cost sweep toggles them in-page via the
// storm script's global). Light 4, same as the sweep's hot arm.
const lit = await page.evaluate(() => {
  const S = globalThis.__storm;
  if (!S) return { error: "no __storm" };
  for (let i = 0; i < S.lamps.length; i++) S.lamps[i].visible = i < 4;
  return { visible: S.lamps.filter((l) => l.visible).length };
});
console.log(`emitters lit: ${JSON.stringify(lit)} — settling 12s…`);
await wait(12000);
console.log(`masked stats: ${JSON.stringify(await stats())}`);
await page.screenshot({ path: `${OUT}/1-masked-on.png` });
console.log("flipping __giBvhMask=false LIVE (mask pass stops, prepass kernel unchanged)…");
await page.evaluate(() => { globalThis.__giBvhMask = false; });
await wait(4000);
console.log(`mask-stopped stats: ${JSON.stringify(await stats())}`);
await page.screenshot({ path: `${OUT}/2-mask-pass-stopped.png` });

// ── the DENSE control, fresh page in the same process ───────────────────────
// The prepass kernel bakes its gate at build, so the dense arm needs a boot
// without the opt-in — same rig, same process, same clocks.
const page2 = await browser.newPage();
await page2.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page2, {});
let built2 = false;
page2.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built2 = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  dense console.error: ${t.slice(0, 200)}`);
});
await page2.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, GEN_ROOT);
await page2.goto(url, { waitUntil: "load", timeout: 60000 });
await page2.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page2.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
for (let i = 0; i < 150 && !built2; i++) await wait(1000);
await page2.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await page2.evaluate(
  (args) => globalThis.__editorApi.call("viewport.setCamera", args),
  { position: [0, 1.9, 6.2], target: [0, 0.8, -2] },
);
console.log("dense control — settling 20s…");
await wait(20000);
const lit2 = await page2.evaluate(() => {
  const S = globalThis.__storm;
  if (!S) return { error: "no __storm" };
  for (let i = 0; i < S.lamps.length; i++) S.lamps[i].visible = i < 4;
  return { visible: S.lamps.filter((l) => l.visible).length };
});
console.log(`dense emitters lit: ${JSON.stringify(lit2)} — settling 12s…`);
await wait(12000);
const stats2 = () => page2.evaluate(async () => {
  const ids = await globalThis.__editorApi.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const eng = anyId ? globalThis.__editorApi.entities.live(anyId)?.engine : null;
  const gi = eng?.modules?.get?.("gi")?.system;
  const src = gi?.state?.screen?.srcProbes;
  const renderer = eng?.renderer;
  if (!src || !renderer) return { error: "no src system" };
  const s = await src.readStats(renderer);
  return {
    rays: s.rays ? {
      rays: s.rays.rays, hits: s.rays.hits, deposits: s.rays.deposits,
      shaded: s.rays.shaded, maxL: s.rays.maxRadianceFraction,
      secondaryHits: s.rays.secondaryHits,
    } : null,
    merge: s.merge ? { bins: s.merge.bins, merged: s.merge.merged, sky: s.merge.sky } : null,
    gather: s.gather ?? null,
    seed: s.seed ?? null,
    live: (s.cascades ?? []).map((c) => c.live),
  };
});
console.log(`dense stats: ${JSON.stringify(await stats2())}`);
await page2.screenshot({ path: `${OUT}/3-dense-control.png` });
console.log(`shots → ${OUT}`);
await browser.close();
