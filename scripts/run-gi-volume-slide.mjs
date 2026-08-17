// §13 F0 — WHAT DOES A VOLUME SLIDE COST, AND WHAT DO OUT-OF-VOLUME PIXELS DO?
//
// One boot of the REAL project at the §13 overview pose, then one 40 m slide
// east via the `__giVolumeSlide` hatch (GISystem #debugSlide — snapped to the
// probe lattice, `#applyBounds` timed). The three questions this answers:
//
//   1. Slide cost: the `[gi] slide: <ms>` line (CPU) and whether the image
//      settles without a flash (mean-luminance track, a mean not an extremum).
//   2. THE GATE: no `compile wave started` and no `[gi] built` may follow the
//      slide. Either one means a bounds change still reaches a rebuild path,
//      which is a §13.8 invariant violation and blocks F2.
//   3. Out-of-volume shading: after sliding 40 m east, the west half of the
//      scene is outside the box — the after-slide screenshot IS the answer to
//      "what does the composite do beyond bounds" (§13.2's open question).
//
// The auto-fit watcher notices the content/volume mismatch and slides back on
// its own cadence; the `auto-fit: refit in place` line and the third
// screenshot are that return trip, measured for free.
//
// Usage:  node scripts/run-gi-volume-slide.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-40, 28, -40], target: [5, -2, 10] };
const SLIDE = [40, 0]; // metres east — pushes the west half out of the box
const OUT = ".gi-shots/volume-slide";
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
  if (/\[gi\]|\[merging\]/.test(t)) lines.push({ t: Date.now(), line: t.slice(0, 300) });
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "medium" };
}, PROJECT);

console.log(`opening ${PROJECT} … (quality=medium, slide [${SLIDE}])`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);

// The transcode tail alone runs ~3 min on this scene now that GI waits for it.
for (let i = 0; i < 360 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(8000);

const setPose = await page.evaluate(async (pose) => {
  try { await globalThis.__editorApi.call("viewport.setCamera", pose); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e?.message ?? e).slice(0, 150) }; }
}, POSE);
console.log(`setCamera ${JSON.stringify(setPose)}`);
await wait(20000); // settle at the pose before the baseline

const luminance = () => page.evaluate(() => {
  const src = document.querySelector("canvas");
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, count = 0, black = 0;
  // West-half vs east-half split: after the slide the WEST half is the
  // out-of-volume side, so the two halves answer the fallback question
  // numerically as well as visually.
  let west = 0, westN = 0, east = 0, eastN = 0;
  for (let y = 0; y < c.height; y += 3) {
    for (let x = 0; x < c.width; x += 3) {
      const i = (y * c.width + x) * 4;
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += lum; count++;
      if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
      if (x < c.width / 2) { west += lum; westN++; } else { east += lum; eastN++; }
    }
  }
  return {
    mean: +(sum / count).toFixed(4), blackFrac: +(black / count).toFixed(4),
    west: +(west / westN).toFixed(4), east: +(east / eastN).toFixed(4),
  };
});

const before = await luminance();
await page.screenshot({ path: `${OUT}/1-before.png` });
console.log(`before: ${JSON.stringify(before)}`);

const armT = Date.now();
await page.evaluate((step) => { globalThis.__giVolumeSlide = step; }, SLIDE);
await wait(2500);
const during = await luminance();
await page.screenshot({ path: `${OUT}/2-after-slide.png` });
console.log(`after-slide (+2.5s): ${JSON.stringify(during)}`);

await wait(15000); // give the auto-fit watcher time for the return trip
const after = await luminance();
await page.screenshot({ path: `${OUT}/3-after-return.png` });
console.log(`after-return (+17.5s): ${JSON.stringify(after)}`);

// ── verdicts from the log stream ──────────────────────────────────────────
const since = lines.filter((l) => l.t >= armT);
const slideLine = since.find((l) => /\[gi\] slide:/.test(l.line));
const returnLine = since.find((l) => /auto-fit: refit in place/.test(l.line));
const waveAfter = since.find((l) => /compile wave started/.test(l.line));
const rebuiltAfter = since.find((l) => /\[gi\] built/.test(l.line));
console.log("");
console.log(`slide line:   ${slideLine ? slideLine.line : "MISSING — hatch never fired"}`);
console.log(`return trip:  ${returnLine ? returnLine.line : "not seen in the window"}`);
console.log(`GATE compile wave after slide: ${waveAfter ? `FAILED — ${waveAfter.line}` : "ok (none)"}`);
console.log(`GATE rebuild after slide:      ${rebuiltAfter ? `FAILED — ${rebuiltAfter.line}` : "ok (none)"}`);
for (const l of since.slice(0, 25)) console.log(`  log: ${l.line}`);
console.log(`shots in ${OUT}/`);
await browser.close();
process.exit(slideLine && !waveAfter && !rebuiltAfter ? 0 : 1);
