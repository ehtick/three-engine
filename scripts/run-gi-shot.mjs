// VISUAL VERDICT SHOT: boot the real project, frame Sponza with the editor's
// own focus (the run-gi-sponza recipe — focus then dolly to 18% along the
// view ray), wait out the compile wave, screenshot. The one-command answer to
// "does GI still light the scene after that kernel refactor".
//
//   node scripts/run-gi-shot.mjs            → scratch/gi-shot.png (SHOT= to name)
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SHOT = process.env.SHOT ?? "scripts/out/gi-shot.png";
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
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
let waveDone = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] (built|compile wave|composited)/.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (/compile wave: materials \d+ms, computes/.test(t)) waveDone = true;
});
page.on("pageerror", (e) => console.log(`  PAGEERROR: ${(e.message ?? "").slice(0, 200)}`));

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate(() => document.querySelector(".hub-recent-open-btn")?.click());
console.log(`opening ${PROJECT} …`);

await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try {
      return { ok: true, value: await globalThis.__editorApi.call(op, args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, { op, args });

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const sponza = entities.find((e) => /sponza/i.test(e.name ?? "")) ?? entities[0];
console.log(`  ${entities.length} entities; framing "${sponza?.name}"`);

for (let i = 0; i < 200 && !waveDone; i++) await wait(1000);
await wait(4000);

await call("viewport.focus", { id: sponza.id });
await wait(1200);
const framed = await call("viewport.getCamera", {});
if (framed.ok && framed.value?.position && framed.value?.target) {
  const t0 = framed.value.target;
  // Stand INSIDE the nave: the focus target is the model's center, so drop
  // near floor level there and look down the long (x) axis. The 18%-dolly
  // recipe frames fine when focus starts inside, but from a roof-top framing
  // it never enters the building.
  const eye = [t0[0], t0[1] - 7.2, t0[2]];
  const look = [t0[0] + 12, t0[1] - 6.4, t0[2]];
  await call("viewport.setCamera", { position: eye, target: look });
}
await wait(6000);
await page.screenshot({ path: SHOT });
console.log(`screenshot: ${SHOT}`);
await browser.close();
