// §13.7d — DOES AO FIX "TOO BRIGHT UNDER THE RED COVERS"?
//
// User, against the Lumberyard reference: "too bright in the areas under the
// red covers, should be darker there, overall ours look too flat, lacking
// contrast". The gather has NO visibility test (corner weight is pure
// trilinear x coverage, srcScreenGather.js:205) so a probe on the far side of
// an awning contributes at full weight, and at 1 m probes an awning cavity
// holds about one probe. The resolve's obscurance ladder is the only thing
// that can darken sub-probe-scale cavities — and `ao` DEFAULTS TO FALSE
// (giConfig.js:140), with no tier turning it on. So it has never been tried.
//
// ONE boot (ao:true is structural), FOUR arms via the live uniforms
// (`__giAoOverride`) — strength 0 IS the AO-off baseline, in the same boot,
// which removes boot-to-boot variance from the comparison entirely.
//
// ⚠ radius below ~1.75 m does nothing here: the ladder's reach is
// `max(radius, allowance * 2.5)` and allowance is 2 voxels = 0.70 m at this
// scene's 0.35 m cell, so the default 0.6 m radius is already floored. The
// wide arms are what actually reach an awning cavity.
//
// Usage:  node scripts/run-gi-ao-sweep.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
const UNDER = { x0: 200, x1: 380, y0: 262, y1: 300 }; // beneath the red awnings
const ARMS = [
  { tag: "off",         strength: 0,   radius: 0.6 },
  { tag: "default",     strength: 0.6, radius: 0.6 },
  { tag: "strong",      strength: 1.0, radius: 0.6 },
  { tag: "strong-wide", strength: 1.0, radius: 2.5 },
];
const OUT = ".gi-shots/ao-sweep";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
const lines = [];
page.on("console", (m) => { const t = m.text(); if (/\[gi\]/.test(t)) lines.push(t.slice(0,240)); if (/\[gi\] built/.test(t)) built = true; });
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0,200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "high", ao: true };
}, PROJECT);
console.log(`opening ${PROJECT} … (quality=high, ao:true, ${ARMS.length} live arms)`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\","/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 600 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); for (const l of lines.slice(-12)) console.log(`  ${l}`); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(8000);
await page.evaluate(async (p) => { try { await globalThis.__editorApi.call("viewport.setCamera", p); } catch {} }, POSE);
await wait(45000);

const measure = () => page.evaluate(async (under) => {
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
  return { mean, std, p5: sorted[Math.floor(sorted.length*0.05)], under: us/(u.length/4), png: r.__image.base64 };
}, UNDER);

const results = [];
for (const arm of ARMS) {
  await page.evaluate((a) => { globalThis.__giAoOverride = { strength: a.strength, radius: a.radius }; }, arm);
  await wait(6000); // uniforms are live; let the temporal filter re-settle
  const st = await measure();
  await writeFile(`${OUT}/${arm.tag}.png`, Buffer.from(st.png, "base64"));
  results.push({ ...arm, ...st });
  console.log(`${arm.tag.padEnd(12)} under-awning ${st.under.toFixed(1)}  mean ${st.mean.toFixed(1)}  std ${st.std.toFixed(1)}  p5 ${st.p5.toFixed(1)}`);
}
const base = results[0];
console.log("");
console.log("arm           under-awning     contrast(std)   darks(p5)    frame mean");
for (const r of results) {
  const du = ((r.under - base.under) / base.under) * 100;
  const ds = ((r.std - base.std) / base.std) * 100;
  console.log(`${r.tag.padEnd(12)}  ${r.under.toFixed(1).padStart(6)} (${du >= 0 ? "+" : ""}${du.toFixed(0)}%)   ` +
    `${r.std.toFixed(1).padStart(5)} (${ds >= 0 ? "+" : ""}${ds.toFixed(0)}%)   ${r.p5.toFixed(1).padStart(5)}       ${r.mean.toFixed(1)}`);
}
console.log(`\nWANTED: under-awning DOWN (cavities darken) with std UP (contrast) and the frame mean not collapsing.`);
console.log(`shots in ${OUT}/`);
await browser.close();
