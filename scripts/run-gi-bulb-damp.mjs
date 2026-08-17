// §13.7 GATE — the sub-cell emitter damp kills the color wash without
// killing the bulbs.
//
// TWO BOOTS at quality HIGH, the user's exact street pose (captured live
// 2026-08-16, the frame they called "too many weird color bleeds"):
//   ON  — default (damp armed by srcSystem at 0.5 x spacing0)
//   OFF — `__giSubCellEmitterDamp = false`
//
// The instrument is CHROMA, not luminance: the complaint is coloured
// patches on surfaces that should be near-neutral, and a luminance mean
// cannot see a hue at constant brightness. Per pixel, chroma = (max-min)/
// max of RGB (HSV saturation), which is 0 for any grey regardless of
// exposure. Gates:
//   (a) washFrac (chroma > 0.35, i.e. visibly coloured) drops >= 25%
//       relative — the wash is what the user is seeing;
//   (b) the scene does NOT go dark: ON mean luminance >= 0.9x OFF (the
//       damp must move colour, not energy — bulbs keep their direct light);
//   (c) the bulbs THEMSELVES stay hot: the count of near-saturated bright
//       pixels (lum > 200) holds within 25% (the emissive pools and their
//       crisp local light are screen-side and must be untouched).
// Screenshots to .gi-shots/bulb-damp/{on,off}.png.
//
// Usage:  node scripts/run-gi-bulb-damp.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
const OUT = ".gi-shots/bulb-damp";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(label, dampOff) {
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
  await page.evaluateOnNewDocument((project, off) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giConfigOverride = { quality: "high" };
    if (off) globalThis.__giSubCellEmitterDamp = false;
  }, PROJECT, dampOff);
  console.log(`[${label}] opening … (quality=high${dampOff ? ", __giSubCellEmitterDamp=false" : ", damp DEFAULT-ON"})`);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  for (let i = 0; i < 360 && !built; i++) await wait(1000);
  if (!built) { console.log(`[${label}] FATAL: never built`); await browser.close(); return null; }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await wait(8000);
  await page.evaluate(async (pose) => {
    try { await globalThis.__editorApi.call("viewport.setCamera", pose); } catch {}
  }, POSE);
  await wait(45000); // light-settle + EMA + the transcode tail colouring bounce
  const stats = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 640, height: 400 });
    const img = new Image();
    img.src = `data:image/png;base64,${r.__image.base64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 640; c.height = 400;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 640, 400).data;
    let lumSum = 0, chromaSum = 0, wash = 0, hot = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const chroma = mx > 8 ? (mx - mn) / mx : 0;
      lumSum += lum;
      chromaSum += chroma;
      if (chroma > 0.35) wash++;
      if (lum > 200) hot++;
    }
    return { mean: lumSum / n, chroma: chromaSum / n, washFrac: wash / n, hotFrac: hot / n };
  });
  await page.screenshot({ path: `${OUT}/${label}.png` });
  console.log(`[${label}] mean ${stats.mean.toFixed(1)}, chroma ${stats.chroma.toFixed(3)}, wash ${(stats.washFrac * 100).toFixed(1)}%, hot ${(stats.hotFrac * 100).toFixed(2)}%`);
  const nee = lines.find((l) => /src \[J\] NEE/.test(l));
  if (nee) console.log(`  ${nee}`);
  await browser.close();
  return stats;
}

const on = await boot("on", false);
const off = await boot("off", true);
if (!on || !off) process.exit(1);

const drop = (off.washFrac - on.washFrac) / Math.max(off.washFrac, 1e-6);
const gates = [
  [`wash drops >=25% relative (${(off.washFrac * 100).toFixed(1)}% -> ${(on.washFrac * 100).toFixed(1)}%, ${(drop * 100).toFixed(0)}%)`, drop >= 0.25],
  [`scene not darkened: mean ${on.mean.toFixed(1)} >= 0.9x ${off.mean.toFixed(1)}`, on.mean >= off.mean * 0.9],
  [`bulbs stay hot: hotFrac ${(on.hotFrac * 100).toFixed(2)}% within 25% of ${(off.hotFrac * 100).toFixed(2)}%`,
    Math.abs(on.hotFrac - off.hotFrac) <= Math.max(off.hotFrac * 0.25, 0.0005)],
];
let pass = true;
for (const [name, ok] of gates) { console.log(`GATE ${ok ? "ok  " : "FAIL"} ${name}`); pass &&= ok; }
console.log(`shots in ${OUT}/`);
process.exit(pass ? 0 : 1);
