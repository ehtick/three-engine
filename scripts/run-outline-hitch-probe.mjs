// ONE-OFF (2026-08-13): measure the per-selection hitch. Selects a sequence of
// DIFFERENT entities on the real project and reports the worst rAF frame delta
// in the 2s window after each selection. With the mask-pipeline pre-warm
// working, every window's worst delta should sit near the steady frame time;
// a first-selection compile hitch reads as a 100ms+ spike in window 1 of an
// object's first selection. Delete with the outline-postfx repro when closed.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 300)}`);
});
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
const call = (op, args) => page.evaluate(
  async (o, a) => { try { return { ok: true, value: await globalThis.__editorApi.call(o, a) }; } catch (e) { return { ok: false, error: String(e) }; } },
  op, args,
);
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });
console.log("built — settling 30s (compile wave + mask pre-warm)…");
await wait(30000);

// rAF delta recorder.
await page.evaluate(() => {
  const s = (globalThis.__hitch = { last: performance.now(), max: 0 });
  const tick = () => {
    const now = performance.now();
    s.max = Math.max(s.max, now - s.last);
    s.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const window2s = async (label) => {
  await page.evaluate(() => { globalThis.__hitch.max = 0; globalThis.__hitch.last = performance.now(); });
  await wait(2000);
  const max = await page.evaluate(() => globalThis.__hitch.max);
  console.log(`  ${label.padEnd(34)} worst frame ${max.toFixed(0)}ms`);
};

await window2s("baseline (no selection)");
const seq = [
  ["Physics Playground", "uE6zxZlqQr"],
  ["Mesh (black cube)", "IoDHtGwlZW"],
  ["Mesh 2", "aEqKklIUbq"],
  ["Physics Playground again", "uE6zxZlqQr"],
];
for (const [label, id] of seq) {
  const r = await call("selection.set", { ids: [id] });
  if (!r.ok) { console.log(`  selection.set ${label} failed: ${r.error}`); continue; }
  await window2s(`select ${label}`);
}
await call("selection.set", { ids: [] });
await window2s("deselected");
await browser.close();
