// §13 F2 GATE — the camera drives the slide.
//
// Boots the REAL project with the detail box armed (tier extent), then:
//   1. PARKED 45 s   — gate: ZERO follow slides (hysteresis holds; §13.4
//                      asks for 5 min — this is the smoke version, the full
//                      soak is a manual run with SOAK=1).
//   2. DOLLY 60 m at 2 m/s (diagonal over the Bistro street, aerial pose —
//      slides key on horizontal camera position only, and an aerial path
//      cannot blindly clip through facades) — gates: enough follow slides
//      to have crossed the hysteresis band ~10×, NO rebuild, NO compile
//      wave, NO refit refusal; and the centre-patch luminance series never
//      crashes (< 0.5× its median = trailing darkness / outran the box) or
//      flashes (> 2× median). §13.4's ±10% tracked-wall-patch mean needs a
//      fixed world patch; the centre patch pans across honest content
//      change, so the tight band would false-fail — the series is printed
//      for the ledger and the gate is the flash/darkness envelope.
//
// Luminance is sampled through `viewport.screenshot` (a real render-target
// readback — renderTargetImage.js owns row order), decoded IN PAGE. The
// WebGPU-canvas drawImage trap (reads black outside onPostRender) never
// applies to it.
//
// Usage:  node scripts/run-gi-volume-follow.mjs [url]     (SOAK=1 → 5 min park)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const START = { position: [-40, 28, -40], target: [5, -2, 10] };
const DIR = { x: Math.SQRT1_2, z: Math.SQRT1_2 }; // diagonal, +x+z
const DOLLY_M = 60;
const SPEED = 2; // m/s
const PARK_MS = process.env.SOAK ? 300_000 : 45_000;
const OUT = ".gi-shots/volume-follow";
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

let built = 0;
const lines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) lines.push(t.slice(0, 320));
  if (/\[gi\] built/.test(t)) built++;
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "medium", detailExtent: true };
}, PROJECT);

console.log(`opening ${PROJECT} … (quality=medium, detailExtent=true; park ${PARK_MS / 1000}s, dolly ${DOLLY_M}m @ ${SPEED}m/s)`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);

for (let i = 0; i < 360 && built === 0; i++) await wait(1000);
if (!built) {
  console.log("FATAL: never built. [gi] lines seen:");
  for (const l of lines.slice(-20)) console.log(`  ${l}`);
  await browser.close();
  process.exit(1);
}
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(8000);

const setCam = (pose) =>
  page.evaluate(async (p) => {
    try { await globalThis.__editorApi.call("viewport.setCamera", p); } catch {}
  }, pose);
const sampleLum = () =>
  page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 240, height: 160 });
    const img = new Image();
    img.src = `data:image/png;base64,${r.__image.base64}`;
    await img.decode();
    const c = (globalThis.__lumCanvas ??= document.createElement("canvas"));
    c.width = 240; c.height = 160;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(60, 40, 120, 80).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  });
const count = (re) => lines.filter((l) => re.test(l)).length;

await setCam(START);
await wait(15000); // light-settle after the pose jump
await page.screenshot({ path: `${OUT}/1-start.png` });

// ── phase 1: parked ───────────────────────────────────────────────────────
const slidesBeforePark = count(/\[gi\] follow: slide/);
await wait(PARK_MS);
const parkSlides = count(/\[gi\] follow: slide/) - slidesBeforePark;
console.log(`parked ${PARK_MS / 1000}s: ${parkSlides} follow slides`);

// ── phase 2: dolly ────────────────────────────────────────────────────────
const slidesBeforeDolly = count(/\[gi\] follow: slide/);
const builtBeforeDolly = built;
// The BOOT compile wave (materials warming) can still be draining through
// the park on a cold cache — only a wave that STARTS during the dolly can
// be the slides' fault. Count from here.
const linesAtDollyStart = lines.length;
const stepMs = 200;
const stepM = SPEED * (stepMs / 1000);
const lums = [];
let travelled = 0;
let lastLumAt = 0;
while (travelled < DOLLY_M) {
  travelled += stepM;
  const dx = DIR.x * travelled;
  const dz = DIR.z * travelled;
  await setCam({
    position: [START.position[0] + dx, START.position[1], START.position[2] + dz],
    target: [START.target[0] + dx, START.target[1], START.target[2] + dz],
  });
  const t = Date.now();
  if (t - lastLumAt >= 2000) {
    lastLumAt = t;
    try { lums.push(await sampleLum()); } catch {}
  }
  if (Math.abs(travelled - DOLLY_M / 2) < stepM) await page.screenshot({ path: `${OUT}/2-mid.png` });
  await wait(stepMs);
}
await wait(4000); // let the last throttled slide land
await page.screenshot({ path: `${OUT}/3-end.png` });
const dollySlides = count(/\[gi\] follow: slide/) - slidesBeforeDolly;
const rebuilds = built - builtBeforeDolly;
const refusals = count(/follow: refit refused/);
const compileWaves = lines.slice(linesAtDollyStart).filter((l) => /compile wave started/.test(l)).length;

const sorted = [...lums].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
const lo = Math.min(...lums);
const hi = Math.max(...lums);
console.log(`dolly: ${dollySlides} slides, luminance median ${median.toFixed(1)} ` +
  `range [${lo.toFixed(1)}, ${hi.toFixed(1)}] over ${lums.length} samples`);
console.log(`  series: ${lums.map((v) => v.toFixed(0)).join(" ")}`);

const gates = [
  [`parked: zero follow slides (${parkSlides})`, parkSlides === 0],
  [`dolly: slides fired (${dollySlides}, expect ~8-15 for 42m of x at 4m band)`, dollySlides >= 3],
  [`dolly: no rebuild (${rebuilds}), no compile wave (${compileWaves}), no refusal (${refusals})`, rebuilds === 0 && compileWaves === 0 && refusals === 0],
  [`luminance: no trailing darkness (min ${lo.toFixed(1)} >= 0.5x median ${median.toFixed(1)})`, lums.length >= 5 && median > 1 && lo >= median * 0.5],
  [`luminance: no flash (max ${hi.toFixed(1)} <= 2x median)`, hi <= median * 2],
];
let pass = true;
for (const [name, ok] of gates) { console.log(`GATE ${ok ? "ok  " : "FAIL"} ${name}`); pass &&= ok; }
for (const l of lines.filter((x) => /follow:|refit in place|detail volume armed|built \(voxel-free\)|compile wave|auto-fit:/.test(x)).slice(0, 30)) console.log(`  log: ${l}`);
console.log(`shots in ${OUT}/`);
await browser.close();
process.exit(pass ? 0 : 1);
