// §13.7b — HOW MUCH BOUNCE CHROMA IS THE APPROXIMATION'S FAULT?
//
// ONE boot, FOUR arms, no rebuilds: `__giBounceSaturation` feeds
// `resolveMaterialSurface`, whose colour the fingerprint hashes — so setting
// it re-tints the whole palette on the next fingerprint scan (~1-3 s) with no
// compile wave. That is what makes a live sweep possible at all.
//
// Camera is the user's own street pose (captured live 2026-08-16 — the frame
// they called "still same dirty colors"). Quality high, no other hatches.
//
// Instrument is CHROMA, because the complaint is colour, not brightness:
// per pixel (max-min)/max of RGB (HSV saturation, 0 for any grey at any
// exposure), reported as a mean and as `washFrac` = the share of pixels above
// 0.35 (visibly coloured). Luminance mean rides along to prove the dial moves
// COLOUR and not ENERGY — if mean luminance falls with saturation, the dial is
// darkening the scene and that is a different (worse) change.
//
// Usage:  node scripts/run-gi-bounce-saturation.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
const ARMS = [1, 0.65, 0.4, 0.15];
const OUT = ".gi-shots/bounce-sat";
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
  if (/\[gi\]/.test(t)) lines.push(t.slice(0, 300));
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 240)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "high" };
}, PROJECT);

console.log(`opening ${PROJECT} … (quality=high, user's street pose, arms ${ARMS.join(" / ")})`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 360 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(8000);
await page.evaluate(async (pose) => {
  try { await globalThis.__editorApi.call("viewport.setCamera", pose); } catch {}
}, POSE);
await wait(45000); // first settle: light-settle ramp + the transcode tail

// ⚠ THE FIRST VERSION OF THIS RIG MEASURED WHOLE-FRAME CHROMA AND READ A
// FLAT LINE ACROSS THE WHOLE SWEEP — because a street frame's chroma is
// dominated by the scene's OWN albedo (red awnings, green cafe, blue
// shopfront), which no bounce term can move. The metric has to look where
// the ARTIFACT is: a patch of cobblestone that ought to be neutral grey.
// Reported as the patch mean AND its p95 — the complaint is blotches, and a
// blotch is a tail, not a mean.
const PATCH = { x0: 150, x1: 500, y0: 300, y1: 396 };
const measure = () =>
  page.evaluate(async (patch) => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 640, height: 400 });
    const img = new Image();
    img.src = `data:image/png;base64,${r.__image.base64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 640; c.height = 400;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const full = ctx.getImageData(0, 0, 640, 400).data;
    let lumSum = 0;
    for (let i = 0; i < full.length; i += 4) {
      lumSum += 0.2126 * full[i] + 0.7152 * full[i + 1] + 0.0722 * full[i + 2];
    }
    const w = patch.x1 - patch.x0, h = patch.y1 - patch.y0;
    const d = ctx.getImageData(patch.x0, patch.y0, w, h).data;
    const chromas = [];
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      lum += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      chromas.push(mx > 8 ? (mx - mn) / mx : 0);
    }
    chromas.sort((a, b) => a - b);
    return {
      mean: lumSum / (full.length / 4),
      patchLum: lum / chromas.length,
      chroma: chromas.reduce((a, b) => a + b, 0) / chromas.length,
      p95: chromas[Math.floor(chromas.length * 0.95)],
      png: r.__image.base64,
    };
  }, PATCH);

const results = [];
for (const sat of ARMS) {
  await page.evaluate((s) => { globalThis.__giBounceSaturation = s; }, sat);
  // The fingerprint scan is on a cadence (its own time floor), then the field
  // has to re-accumulate the new palette through the temporal filter.
  await wait(sat === ARMS[0] ? 4000 : 26000);
  const st = await measure();
  const tag = String(sat).replace(".", "p");
  await page.screenshot({ path: `${OUT}/sat-${tag}.png` });
  results.push({ sat, ...st });
  console.log(`sat ${sat.toFixed(2)}: chroma ${st.chroma.toFixed(3)}, wash ${(st.washFrac * 100).toFixed(1)}%, lum ${st.mean.toFixed(1)}`);
}

const base = results[0];
console.log("");
console.log("arm     chroma   wash%   lum    (vs sat 1.00)");
for (const r of results) {
  const dc = ((r.chroma - base.chroma) / base.chroma) * 100;
  const dl = ((r.mean - base.mean) / base.mean) * 100;
  console.log(
    `${r.sat.toFixed(2)}    ${r.chroma.toFixed(3)}   ${(r.washFrac * 100).toFixed(1).padStart(5)}   ${r.mean.toFixed(1).padStart(5)}   ` +
      `chroma ${dc >= 0 ? "+" : ""}${dc.toFixed(0)}%, lum ${dl >= 0 ? "+" : ""}${dl.toFixed(0)}%`,
  );
}
// The dial must move COLOUR, not ENERGY — that is the whole claim.
const worst = results.slice(1).reduce((a, r) => Math.max(a, Math.abs((r.mean - base.mean) / base.mean)), 0);
console.log(`\nGATE ${worst <= 0.15 ? "ok  " : "FAIL"} luminance holds within 15% across the sweep (worst ${(worst * 100).toFixed(0)}%)`);
console.log(`shots in ${OUT}/`);
await browser.close();
