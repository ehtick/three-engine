// BOOT SMOKE: does the editor open the real project and does GI build, at all?
// The 30-second answer to "did that refactor break the load path" — no
// measurements, no A/B, just boot → [gi] built → one screenshot → exit code.
// Recipe per tauri-shim-harness memory (hub click, __editorApi only).
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-boot.mjs
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // An occluded harness window gets ~1/s timer throttling, which fakes
    // multi-second waits all over GI startup (see run-gi-wave.mjs).
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
let failed = null;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 250)}`);
});
page.on("pageerror", (e) => {
  failed = e.message;
  console.log(`  PAGEERROR: ${(e.stack ?? e.message).slice(0, 400)}`);
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate(() => document.querySelector(".hub-recent-open-btn")?.click());
console.log(`opening ${PROJECT} …`);

for (let i = 0; i < 180 && !built && !failed; i++) await wait(1000);
await wait(5000);

// One screenshot after the wave settles — SHOT= names the file. GI correctness
// after a kernel refactor is a picture question, not a log question.
if (process.env.SHOT) {
  // Give the wave + composite retries time to land the field.
  for (let i = 0; i < 60; i++) await wait(1000);
  await page.screenshot({ path: process.env.SHOT });
  console.log(`screenshot: ${process.env.SHOT}`);
}

const verdict = failed ? `FAIL (pageerror: ${failed})` : built ? "PASS — GI built" : "FAIL — no [gi] built within 180s";
console.log(`\nBOOT SMOKE: ${verdict}`);
await browser.close();
process.exit(failed || !built ? 1 : 0);
