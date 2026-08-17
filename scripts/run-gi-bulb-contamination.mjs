// §13.7c GATE — the string lights stop tinting the street.
//
// The user CONFIRMED the source: "those light contamination comes from string
// lights". The mechanism is `#buildEntries` excluding InstancedMesh from the
// emitter candidate set, so ~95 instanced bulbs are delivered by the BAKED
// FIELD alone — no light tree, no NEE, no R5 zeroing, and out of reach of
// §13.7's tree-eval damp. §13.7c damps that path: chroma hard (the 1 m
// lattice cannot represent a 5 cm bulb's hue), energy gently (the light is
// real).
//
// TWO PRE-BOOT ARMS — the palette is baked at build, and a live hatch flip is
// NOT assumed to re-tint (an earlier live sweep read a flat line and could
// not be told apart from "no effect"; pre-boot arms cannot lie that way):
//   ON  — default
//   OFF — `__giSubCellEmissiveDamp = false`
//
// ⚠ THE INSTRUMENT IS A PATCH, NOT THE FRAME. Whole-frame chroma is dominated
// by the scene's own albedo (red awnings, green cafe, blue shopfront) and is
// blind to this: it read 0.159 vs 0.158 across a 4-arm sweep that should have
// moved it. So measure the COBBLESTONE, which ought to be neutral grey, and
// report p95 as well as the mean — a blotch is a tail, not a mean.
//
// Usage:  node scripts/run-gi-bulb-contamination.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
// Lower-centre of the 640x400 scene render: the cobbled pavement.
const PATCH = { x0: 150, x1: 500, y0: 300, y1: 396 };
const OUT = ".gi-shots/bulb-contamination";
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
  page.on("pageerror", (e) => console.log(`  [${label}] pageerror: ${String(e.message ?? e).slice(0, 220)}`));
  await page.evaluateOnNewDocument((project, off) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giConfigOverride = { quality: "high" };
    if (off) globalThis.__giSubCellEmissiveDamp = false;
  }, PROJECT, dampOff);
  console.log(`[${label}] opening … (quality=high${dampOff ? ", damp OFF" : ", damp DEFAULT-ON"})`);
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
  await wait(45000);
  const st = await page.evaluate(async (patch) => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 640, height: 400 });
    const img = new Image();
    img.src = `data:image/png;base64,${r.__image.base64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 640; c.height = 400;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
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
      lum: lum / chromas.length,
      chroma: chromas.reduce((a, b) => a + b, 0) / chromas.length,
      p95: chromas[Math.floor(chromas.length * 0.95)],
      png: r.__image.base64,
    };
  }, PATCH);
  await writeFile(`${OUT}/${label}-scene.png`, Buffer.from(st.png, "base64"));
  await page.screenshot({ path: `${OUT}/${label}.png` });
  const fieldOnly = lines.find((l) => /delivered by the FIELD ONLY/.test(l));
  console.log(`[${label}] patch chroma ${st.chroma.toFixed(3)} (p95 ${st.p95.toFixed(3)}), patch lum ${st.lum.toFixed(1)}`);
  if (fieldOnly) console.log(`  ${fieldOnly}`);
  await browser.close();
  return st;
}

const on = await boot("on", false);
const off = await boot("off", true);
if (!on || !off) process.exit(1);

const dMean = (off.chroma - on.chroma) / Math.max(off.chroma, 1e-6);
const dP95 = (off.p95 - on.p95) / Math.max(off.p95, 1e-6);
const dLum = (on.lum - off.lum) / Math.max(off.lum, 1e-6);
console.log("");
console.log(`patch chroma  OFF ${off.chroma.toFixed(3)} -> ON ${on.chroma.toFixed(3)}  (${(dMean * 100).toFixed(0)}% lower)`);
console.log(`patch p95     OFF ${off.p95.toFixed(3)} -> ON ${on.p95.toFixed(3)}  (${(dP95 * 100).toFixed(0)}% lower)`);
console.log(`patch lum     OFF ${off.lum.toFixed(1)} -> ON ${on.lum.toFixed(1)}  (${(dLum * 100).toFixed(0)}%)`);
const gates = [
  [`blotch tail drops >=20% (p95 ${(dP95 * 100).toFixed(0)}%)`, dP95 >= 0.2],
  [`mean patch chroma drops >=10% (${(dMean * 100).toFixed(0)}%)`, dMean >= 0.1],
  [`street not darkened >10% (lum ${(dLum * 100).toFixed(0)}%)`, dLum >= -0.1],
];
let pass = true;
for (const [name, ok] of gates) { console.log(`GATE ${ok ? "ok  " : "FAIL"} ${name}`); pass &&= ok; }
console.log(`shots in ${OUT}/ (both the window and the measured 640x400 scene render)`);
process.exit(pass ? 0 : 1);
