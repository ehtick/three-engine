// §13 F3 follow-up — IS THE FAR-FIELD CONSTANT FLATTENING THE IMAGE?
//
// User, after the F3 polish: "far more sane now, but still quite off, too
// bright in the areas under the red covers, should be darker there, overall
// ours look too flat, lacking contrast".
//
// The far-field term replaces indirect with a hemispherical CONSTANT beyond
// the detail box. At street level the box's 20 m half-extent means most of
// the frame is far field, and a constant has no occlusion variation by
// construction — so it is the prime suspect for "flat". This measures it:
//
//   ON  — default
//   OFF — `__giFarField = false`
//
// Contrast instruments (the complaint is DYNAMIC RANGE, not colour):
//   std   — luminance standard deviation over the frame; flatness IS low std
//   p5    — the darkest 5%. A constant added to unoccluded indirect LIFTS
//           the darks, and lifted darks are exactly "washed out / no contrast"
//   under — mean luminance of a patch under the red awnings (should be dark)
//
// Usage:  node scripts/run-gi-contrast.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
const UNDER = { x0: 200, x1: 380, y0: 262, y1: 300 }; // beneath the awnings
const OUT = ".gi-shots/contrast";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(label, farOff) {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    args: ["--enable-unsafe-webgpu","--enable-features=WebGPU","--no-sandbox","--disable-dev-shm-usage",
      "--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
  await page.evaluateOnNewDocument((project, off) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giConfigOverride = { quality: "high" };
    if (off) globalThis.__giFarField = false;
  }, PROJECT, farOff);
  console.log(`[${label}] opening … (${farOff ? "__giFarField=false" : "far field DEFAULT-ON"})`);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\","/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  for (let i = 0; i < 360 && !built; i++) await wait(1000);
  if (!built) { console.log(`[${label}] FATAL: never built`); await browser.close(); return null; }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await wait(8000);
  await page.evaluate(async (p) => { try { await globalThis.__editorApi.call("viewport.setCamera", p); } catch {} }, POSE);
  await wait(45000);
  const st = await page.evaluate(async (under) => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", { width: 640, height: 400 });
    const img = new Image(); img.src = `data:image/png;base64,${r.__image.base64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = 640; c.height = 400;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 640, 400).data;
    const lums = [];
    for (let i = 0; i < d.length; i += 4) lums.push(0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]);
    const mean = lums.reduce((a,b)=>a+b,0)/lums.length;
    const std = Math.sqrt(lums.reduce((a,b)=>a+(b-mean)**2,0)/lums.length);
    const sorted = [...lums].sort((a,b)=>a-b);
    const u = ctx.getImageData(under.x0, under.y0, under.x1-under.x0, under.y1-under.y0).data;
    let us = 0; for (let i = 0; i < u.length; i += 4) us += 0.2126*u[i] + 0.7152*u[i+1] + 0.0722*u[i+2];
    return { mean, std, p5: sorted[Math.floor(sorted.length*0.05)], p95: sorted[Math.floor(sorted.length*0.95)],
             under: us/(u.length/4), png: r.__image.base64 };
  }, UNDER);
  await writeFile(`${OUT}/${label}-scene.png`, Buffer.from(st.png, "base64"));
  console.log(`[${label}] mean ${st.mean.toFixed(1)} std ${st.std.toFixed(1)} p5 ${st.p5.toFixed(1)} p95 ${st.p95.toFixed(1)} under-awning ${st.under.toFixed(1)}`);
  await browser.close();
  return st;
}

const on = await boot("on", false);
const off = await boot("off", true);
if (!on || !off) process.exit(1);
console.log("");
console.log(`contrast (std)   far-field ON ${on.std.toFixed(1)}  vs OFF ${off.std.toFixed(1)}   (${(((on.std-off.std)/off.std)*100).toFixed(0)}%)`);
console.log(`darks    (p5)    far-field ON ${on.p5.toFixed(1)}  vs OFF ${off.p5.toFixed(1)}   (lifted ${(on.p5-off.p5).toFixed(1)})`);
console.log(`under awnings    far-field ON ${on.under.toFixed(1)}  vs OFF ${off.under.toFixed(1)}`);
console.log(`shots in ${OUT}/`);
