// ONE-OFF (2026-08-14, §12.66): the black boot is the sun's shadow map —
// castShadow off lit the frame (meanLum 0.0003 → 0.8883). The map's writer
// dies with `struct OutputType` empty (a depth-only fragment built with zero
// outputs). This boot captures the ACTUAL failing WGSL: patch
// GPUDevice.createShaderModule at document start, stash any module whose code
// carries an empty OutputType struct, dump label + source. Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/blackframe-bisect";
mkdirSync(OUT, { recursive: true });
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
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
await page.evaluateOnNewDocument((project, ppOff) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (ppOff) globalThis.__ppForceDisabled = true;
  // Document-start patch — runs before three loads (probe:gi-boot pattern).
  globalThis.__emptyStructWGSL = [];
  const patch = () => {
    if (!globalThis.GPUDevice?.prototype?.createShaderModule || GPUDevice.prototype.__esPatched) return;
    GPUDevice.prototype.__esPatched = true;
    const orig = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
      try {
        if (typeof desc?.code === "string" && /struct\s+OutputType\s*\{\s*\}/.test(desc.code)) {
          globalThis.__emptyStructWGSL.push({
            label: String(desc.label ?? ""),
            code: desc.code,
            // The whole point: WHICH pass is building this module.
            stack: new Error().stack,
          });
        }
      } catch {}
      return orig.call(this, desc);
    };
  };
  patch();
}, PROJECT, process.env.PPOFF === "1");
console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await wait(20000);

const captured = await page.evaluate(() => (globalThis.__emptyStructWGSL ?? []).map((e, i) => ({
  i, label: e.label, bytes: e.code.length,
})));
console.log(`captured ${captured.length} empty-struct module(s):`);
for (const c of captured) console.log(`  [${c.i}] label="${c.label}" ${c.bytes}B`);
const full = await page.evaluate(() => globalThis.__emptyStructWGSL ?? []);
const tag = process.env.PPOFF === "1" ? "ppoff-" : "";
full.forEach((e, i) => writeFileSync(`${OUT}/${tag}empty-struct-${i}.wgsl`, `// label: ${e.label}\n// STACK:\n${(e.stack ?? "").split("\n").map((l) => `//   ${l}`).join("\n")}\n${e.code}`));
console.log(`sources → ${OUT}/empty-struct-*.wgsl`);
await browser.close();
