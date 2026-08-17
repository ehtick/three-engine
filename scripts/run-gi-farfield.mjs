// §13 F3 GATE — the far field is deliberate, not an accident.
//
// TWO BOOTS of the REAL project, same pose, quality medium:
//   ON  — NO hatches at all. This also gates the §13 default flip: Bistro's
//         109×115 m span exceeds DETAIL_TRIGGER (60 m), so the detail box
//         must arm itself and the far-field fallback must arm with it.
//   OFF — `__giFarField = false`: the fallback's kill switch, which must
//         reproduce the F0 crushed-black far field (gate c — proves the term
//         is isolated).
//
// Instrument: full-frame luminance histogram via `viewport.screenshot`
// decoded IN PAGE (render-target readback — no canvas drawImage trap).
// Gates:
//   (a) ON boot: "detail volume armed" AND "far-field fallback armed" with
//       no hatch set;
//   (b) darkFrac(lum < 24/255) drops meaningfully ON vs OFF — the far field
//       is lit instead of black;
//   (c) the far field is not GLOWING: ON mean ≤ 1.8× OFF mean.
// Screenshots to .gi-shots/farfield/{on,off}.png for the eyeball record.
//
// Usage:  node scripts/run-gi-farfield.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-40, 28, -40], target: [5, -2, 10] };
const OUT = ".gi-shots/farfield";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootAndMeasure(label, fallbackOff) {
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
  page.on("pageerror", (e) => console.log(`  [${label}] pageerror: ${String(e.message ?? e).slice(0, 240)}`));
  await page.evaluateOnNewDocument((project, off) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giConfigOverride = { quality: "medium" };
    if (off) globalThis.__giFarField = false;
  }, PROJECT, fallbackOff);
  console.log(`[${label}] opening ${PROJECT} … (quality=medium${fallbackOff ? ", __giFarField=false" : ", NO hatches — default flip under test"})`);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  for (let i = 0; i < 360 && !built; i++) await wait(1000);
  if (!built) {
    console.log(`[${label}] FATAL: never built. Last [gi] lines:`);
    for (const l of lines.slice(-20)) console.log(`  ${l}`);
    await browser.close();
    return null;
  }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await wait(8000);
  await page.evaluate(async (pose) => {
    try { await globalThis.__editorApi.call("viewport.setCamera", pose); } catch {}
  }, POSE);
  // Long settle: the EMA needs ~2 s once lit, the field itself needs the
  // light-settle ramp, and the transcode tail colors the albedo it bounces.
  await wait(30000);
  const stats = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 480, height: 320 });
    const img = new Image();
    img.src = `data:image/png;base64,${r.__image.base64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 480; c.height = 320;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 480, 320).data;
    let sum = 0, dark = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += lum;
      if (lum < 24) dark++;
    }
    return { mean: sum / n, darkFrac: dark / n };
  });
  await page.screenshot({ path: `${OUT}/${label}.png` });
  const armed = lines.find((l) => /detail volume armed/.test(l)) ?? null;
  const farArmed = lines.find((l) => /far-field fallback armed/.test(l)) ?? null;
  console.log(`[${label}] mean ${stats.mean.toFixed(1)}, darkFrac ${(stats.darkFrac * 100).toFixed(1)}%`);
  if (armed) console.log(`  ${armed}`);
  if (farArmed) console.log(`  ${farArmed}`);
  await browser.close();
  return { ...stats, armed: !!armed, farArmed: !!farArmed };
}

const on = await bootAndMeasure("on", false);
const off = await bootAndMeasure("off", true);
if (!on || !off) process.exit(1);

const gates = [
  ["default flip: detail box armed with NO hatch", on.armed],
  ["far-field fallback armed with NO hatch", on.farArmed],
  ["kill switch: fallback NOT armed under __giFarField=false", !off.farArmed],
  [`far field lit: darkFrac ${(on.darkFrac * 100).toFixed(1)}% (ON) < ${(off.darkFrac * 100).toFixed(1)}% (OFF) - 2pts`, on.darkFrac < off.darkFrac - 0.02],
  [`not glowing: mean ${on.mean.toFixed(1)} (ON) <= 1.8x ${off.mean.toFixed(1)} (OFF)`, on.mean <= off.mean * 1.8],
];
let pass = true;
for (const [name, ok] of gates) { console.log(`GATE ${ok ? "ok  " : "FAIL"} ${name}`); pass &&= ok; }
console.log(`shots in ${OUT}/`);
process.exit(pass ? 0 : 1);
