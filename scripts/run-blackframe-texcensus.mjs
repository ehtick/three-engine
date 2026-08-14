// ONE-OFF (2026-08-14, §12.66): the sun's shadow SAMPLE is hard-zero
// (bias-independent; shadow.intensity=0.5 → exactly half-lit) while the
// shadow map's CONTENT is verified good — so the frame samples a DIFFERENT,
// never-rendered depth texture than the one the shadow pass writes. This
// boot wraps device.createTexture at document start and censuses every
// depth-format texture: sizes, usage, and the JS stack that created it.
// Two 4096² depth textures = double-creation confirmed, and the stacks name
// both creators. Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
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
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__depthTexCensus = [];
  const patch = () => {
    if (!globalThis.GPUDevice?.prototype?.createTexture || GPUDevice.prototype.__dtPatched) return;
    GPUDevice.prototype.__dtPatched = true;
    const orig = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (desc) {
      try {
        if (typeof desc?.format === "string" && desc.format.startsWith("depth")) {
          globalThis.__depthTexCensus.push({
            t: performance.now(),
            label: String(desc.label ?? ""),
            format: desc.format,
            size: Array.isArray(desc.size) ? desc.size.slice(0, 2) : [desc.size?.width, desc.size?.height],
            usage: desc.usage,
            stack: new Error().stack?.split("\n").slice(2, 9).join(" | "),
          });
        }
      } catch {}
      return orig.call(this, desc);
    };
  };
  patch();
}, PROJECT);
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

const census = await page.evaluate(() => globalThis.__depthTexCensus ?? []);
console.log(`${census.length} depth textures created:`);
for (const c of census) {
  console.log(`  t=${(c.t / 1000).toFixed(1)}s ${c.size?.[0]}x${c.size?.[1]} ${c.format} usage=${c.usage} label="${c.label}"`);
  console.log(`    ${c.stack}`);
}
await browser.close();
