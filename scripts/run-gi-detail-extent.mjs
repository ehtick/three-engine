// §13 F1 GATE — the detail box actually buys density.
//
// Boots the REAL project with `__giConfigOverride.detailExtent = true` (the
// F1 hatch, tier-default extent — default stays scene-covering until F3) and
// gates on the boot log: the clamp must ARM, the built volume must be the
// box on ALL THREE axes (the first rig run proved Bistro's 32 m facades
// alone pin medium to ≥1.3 m spacing, so the detail box clamps Y too,
// ground-anchored), and probe spacing must land ≥2× finer than the 2.50 m
// the uncapped 120x130 m fit produces (F0's baseline run).
//
// Medium's numbers, derived not hoped: probeAxis 28 and probes 28³ mean a
// 24 m box + 1.05 pad + margins snaps to 28 m / 28 cells = 1.0 m probes,
// spending EXACTLY the tier's existing budget. The screenshot is the visual
// record: fine GI inside the box, crushed-black far field OUTSIDE it —
// expected and correct until F3.
//
// Usage:  node scripts/run-gi-detail-extent.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-40, 28, -40], target: [5, -2, 10] };
const TIER_EXTENT = 24; // DETAIL_EXTENT_BY_TIER.medium
const OUT = ".gi-shots/detail-extent";
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
const lines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) lines.push(t.slice(0, 320));
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "medium", detailExtent: true };
}, PROJECT);

console.log(`opening ${PROJECT} … (quality=medium, detailExtent=true → tier ${TIER_EXTENT}m)`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);

for (let i = 0; i < 360 && !built; i++) await wait(1000);
if (!built) {
  console.log("FATAL: never built. [gi] lines seen:");
  for (const l of lines.slice(-20)) console.log(`  ${l}`);
  await browser.close();
  process.exit(1);
}
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(8000);
await page.evaluate(async (pose) => {
  try { await globalThis.__editorApi.call("viewport.setCamera", pose); } catch {}
}, POSE);
await wait(15000);
await page.screenshot({ path: `${OUT}/built.png` });

// ── gates from the boot log ───────────────────────────────────────────────
const armed = lines.find((l) => /detail volume armed/.test(l));
const builtLine = lines.find((l) => /\[gi\] built/.test(l)) ?? "";
// "[gi] built (voxel-free): 28.0x28.0x28.0m (auto-fit medium, voxel 0.29, probes 1.00), …"
const dims = builtLine.match(/built \(voxel-free\): ([\d.]+)x([\d.]+)x([\d.]+)m/);
const probes = builtLine.match(/probes ([\d.]+)\)/);
const sx = dims ? +dims[1] : NaN;
const sy = dims ? +dims[2] : NaN;
const sz = dims ? +dims[3] : NaN;
const spacing = probes ? +probes[1] : NaN;

console.log("");
console.log(`armed:  ${armed ?? "MISSING — the clamp never fired"}`);
console.log(`built:  ${builtLine}`);
// extent + 1.05 pad + one spacing margin per face + lattice snap ≈ 28; 30 is the alarm line
const cap = TIER_EXTENT * 1.05 + 6;
const gates = [
  ["clamp armed", !!armed],
  [`volume x/z within the box (${sx}x${sz} vs tier ${TIER_EXTENT} → cap ${cap.toFixed(0)})`, sx <= cap && sz <= cap],
  [`volume Y capped too (${sy} vs cap ${cap.toFixed(0)} — facades must not pin spacing)`, sy <= cap],
  [`probes >=2x finer than the 2.50m baseline (${spacing})`, spacing > 0 && spacing <= 1.25],
];
let pass = true;
for (const [name, ok] of gates) { console.log(`GATE ${ok ? "ok  " : "FAIL"} ${name}`); pass &&= ok; }
for (const l of lines.filter((x) => /probe spacing|detail|built|field ready/.test(x)).slice(0, 12)) console.log(`  log: ${l}`);
console.log(`shot in ${OUT}/built.png`);
await browser.close();
process.exit(pass ? 0 : 1);
