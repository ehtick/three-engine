// ONE-OFF PROBE: does `component.setProp intensity` actually change the
// rendered frame in the harness context? Boots like run-gi-sponza, sets the
// verified nave pose, screenshots at intensity 1 → 0 → 1 and prints the mean
// luminance of each.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\]|material|pipeline|wave|compile|error|WebGPU|WebGL|backend|adapter|device/i.test(t)) console.log("  ::", t.slice(0, 220));
});
page.on("pageerror", (e) => console.log("  pageerror:", (e.stack ?? e.message).slice(0, 300)));
await page.evaluateOnNewDocument(({ PROJECT }) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  globalThis.__giLogComposite = true;
}, { PROJECT });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });
let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const componentOf = (e, t) => (e.components ?? []).find((c) => c.type === t);
const giEntity = entities.find((e) => componentOf(e, "global-illumination"));
const gi = componentOf(giEntity, "global-illumination");
console.log("gi props:", JSON.stringify({ enabled: gi.props?.enabled, intensity: gi.props?.intensity, quality: gi.props?.quality }));
if (gi.props?.enabled === false) {
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
  for (let i = 0; i < 240 && !built; i++) await wait(500);
  await wait(10000);
} else {
  for (let i = 0; i < 90 && !built; i++) await wait(1000);
  await wait(10000);
}
await call("viewport.setCamera", { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] });
await wait(1500);

const lum = async () => {
  const shot = await call("viewport.screenshot", { width: 700, height: 460, includeGizmos: false });
  const png = Buffer.from(shot.value.__image.base64, "base64");
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return sum / (data.length / info.channels) / 255;
};
// STALE-BOOT-FIELD REPRO ("gi looks dark until I move the sponza model"):
// measure, nudge sponza 1cm, measure again. A jump = the boot composite ran
// against an unpopulated pyramid and nothing re-armed it.
const sponza = entities.find((e) => /sponza/i.test(e.name ?? ""));
if (!sponza) { console.log("no sponza entity"); await browser.close(); process.exit(1); }
// LONG settle: 60s separates "pipeline latency, would self-heal" (bright by
// now) from "consumed gate, dark forever" (still dark).
console.log("lum @ 15s:", (await lum()).toFixed(5));
await wait(45000);
const a = await lum();
console.log("lum @ 60s settled:   ", a.toFixed(5));
const cur = await call("entity.get", { id: sponza.id });
const pos = cur.value?.position ?? [0, 0, 0];
await call("entity.setTransform", { id: sponza.id, position: [pos[0] + 0.01, pos[1], pos[2]] });
await wait(8000);
const b = await lum();
console.log("lum @ after 1cm nudge:", b.toFixed(5), ` (jump ${(((b - a) / Math.max(a, 1e-6)) * 100).toFixed(1)}%)`);
await browser.close();
