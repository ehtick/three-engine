// "ARE THE EXACT SHADOWS CORRECT?" — AN ARBITER, NOT AN OPINION (session 33b).
//
// The user's screenshots say the static-BVH sun shadows are wrong, but a
// screenshot of a lit scene cannot separate a wrong SHADOW from a wrong
// ALBEDO, a wrong BOUNCE, or a sun that simply does not reach there. This
// probe removes every other term and puts the two shadow implementations
// side by side from the SAME camera:
//
//   giBias002  GI-traced shadows, exact arm, the new ~2mm bias
//   giBias250  GI-traced, exact arm, bias cranked to the OLD voxel scale
//              (`__giShadowExactBias` is a LIVE uniform — no rebuild, so this
//              is a true single-boot A/B of the bias hypothesis)
//   map        three.js's own shadow map for the same light — the ARBITER.
//              It is a completely independent implementation; wherever the
//              two agree the GI shadow is right, and wherever they disagree
//              the disagreement is the bug, localized on screen.
//
// GI intensity is forced to 0 in every shot, so what remains is direct light
// x shadow — the shadow term, isolated.
//
// Run: node scripts/run-gi-shadow-truth-probe.mjs
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
    "--window-size=2000,1300",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1250, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
let waveDone = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|light shadows|static shadow bvh|compile wave: materials \d+ms/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (/compile wave: materials \d+ms/.test(t)) waveDone = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((PROJECT, G) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const [k, v] of Object.entries(G)) globalThis[k] = v;
  globalThis.__editorKeepRendering = true;
}, PROJECT, JSON.parse(process.env.PRESET_GLOBALS ?? "{}"));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 120 && !built; i++) await wait(1000);
for (let i = 0; i < 220 && !waveDone; i++) await wait(1000);
await wait(10000);

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });

const ents = (await call("entity.list", {})).value ?? [];
const giEnt = ents.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
const lightEnt = ents.find((e) => (e.components ?? []).some((c) => c.type === "light" && c.props?.shadowMode === "gi"))
  ?? ents.find((e) => (e.components ?? []).some((c) => c.type === "light" && c.props?.kind === "directional"));
console.log(`  gi=${giEnt?.name} light=${lightEnt?.name}`);

// The user's camera: down the nave, crates ahead, arcade both sides.
await call("viewport.setCamera", {
  position: [-6.5, 2.2, 0.4],
  target: [6.0, 1.2, 0.4],
});
// Isolate the shadow term — no bounce, no AO.
if (giEnt) {
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "intensity", value: 0 });
  await call("component.setProp", { id: giEnt.id, type: "global-illumination", key: "aoStrength", value: 0 });
}
await wait(6000);

const shot = async (name) => {
  await wait(4000);
  await page.screenshot({ path: `scripts/gi-truth-${name}.png` });
  console.log(`  shot: gi-truth-${name}.png`);
};

// 1. the exact arm at the new bias
await page.evaluate(() => { globalThis.__giShadowExactBias = 0.02; });
await shot("giBias002");
// 2. same build, bias cranked back to the voxel scale it inherited
await page.evaluate(() => { globalThis.__giShadowExactBias = 2.5; });
await shot("giBias250");
await page.evaluate(() => { globalThis.__giShadowExactBias = 0.02; });
// 3. THE ARBITER — three's own shadow map for the same light, same camera
if (lightEnt) {
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "shadowMode", value: "map" });
  await wait(8000);
  await shot("map");
  await call("component.setProp", { id: lightEnt.id, type: "light", key: "shadowMode", value: "gi" });
}
await browser.close();
console.log("\n  compare scripts/gi-truth-giBias002.png vs gi-truth-map.png — disagreement IS the bug");
