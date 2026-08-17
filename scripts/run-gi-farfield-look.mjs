// §13 F3 polish LOOK CHECK — one boot at quality HIGH (the user's tier),
// camera at the user's exact street pose (captured live 2026-08-16), one
// screenshot. No gates — this is the eyeball rig for the desaturated/damped
// constant and the 4-cell feather.
//
// Usage:  node scripts/run-gi-farfield-look.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-14.08, 6.73, -1.95], target: [10.04, 4.55, 0.90] };
const OUT = ".gi-shots/farfield";
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
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality: "high" };
}, PROJECT);
console.log(`opening ${PROJECT} … (quality=high, user's street pose)`);
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
// Long settle: EMA + light-settle + the transcode tail coloring the bounce.
await wait(45000);
await page.screenshot({ path: `${OUT}/street-polished.png` });
for (const l of lines.filter((x) => /emitter ledger|SPARSE|NEE: light tree|built \(voxel-free\)|detail volume/.test(x)).slice(0, 10)) console.log(`  log: ${l}`);
console.log(`shot in ${OUT}/street-polished.png`);
await browser.close();
