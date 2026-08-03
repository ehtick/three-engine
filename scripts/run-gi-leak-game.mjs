// WHERE IS THE LEAK, IN THE REAL SCENE? — opens the user's actual project
// read-only, holds ONE camera pose, and screenshots the same frame at two GI
// quality tiers. The difference image localises every pixel that is brighter
// on the low tier than on the high one, which is what "light leaks on low and
// medium but not high" means as a measurement.
//
// This exists because every synthetic rig I built sealed. A constructed
// splitroom reproduces a leak I invented; only the real scene reproduces the
// real one, and until it is LOCALISED (which wall, which light) any fix is a
// guess. Read-only: writableRoot is never passed, nothing is saved.
//
//   npx vite --port 5234 --strictPort
//   node scripts/run-gi-leak-game.mjs [url]
//
// Env: TIERS=low,high (default) · HEADED=1 to watch · CAM="x,y,z,tx,ty,tz"
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5234/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const scenePath = path.join(PROJECT, "scenes/Main.scene").replace(/\\/g, "/");
const TIERS = (process.env.TIERS ?? "low,high").split(",").map((s) => s.trim());
const CAM = (process.env.CAM ?? "").split(",").map(Number);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
// Vite stamps module URLs with `?t=<mtime>`; a cached index.html from an
// earlier run references timestamps this server no longer serves, and the app
// dies on "504 Outdated Optimize Dep" before any of our code runs.
await page.setCacheEnabled(false);
await installTauriShim(page, {});
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t) || m.type() === "error") console.log(`  ${m.type()}: ${t.slice(0, 260)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

console.log(`Opening ${scenePath} ...`);
const opened = await page.evaluate(async ({ PROJECT, scenePath }) => {
  try {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(PROJECT);
    const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
    await syncProjectModules();
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(scenePath);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    return { ok: true, entities: engine.entities.size, name: engine.sceneName };
  } catch (err) {
    return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
  }
}, { PROJECT, scenePath });
if (!opened.ok) { console.log(`FATAL: ${opened.error}`); await browser.close(); process.exit(1); }
console.log(`  opened "${opened.name}": ${opened.entities} entities`);

// `globalThis.__engine` does not survive a re-navigation during scene load, and
// a stale-global crash mid-measurement wastes a whole 3-minute run. Every
// evaluate below re-resolves through ensureEngine(), which is idempotent.
const ENGINE = `(globalThis.__engine ??= await (await globalThis.__importLive("/src/editor/engineInstance.js")).ensureEngine())`;

const settle = async (label, budget = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await wait(1500);
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t0 > 8000) break;
  }
  console.log(`  settled (${label}) ${(Date.now() - t0) / 1000}s`);
};
await settle("load");
await wait(8000);

// One fixed camera pose for every tier — the whole measurement is a per-pixel
// comparison, so the pose must not move by even a subpixel between arms.
const pose = await page.evaluate(async (CAM) => {
  const engine = await globalThis.__resolveEngine();
  const cam = engine.camera;
  if (CAM.length === 6 && CAM.every(Number.isFinite)) {
    cam.position.set(CAM[0], CAM[1], CAM[2]);
    cam.lookAt(CAM[3], CAM[4], CAM[5]);
  }
  cam.updateMatrixWorld(true);
  return { p: cam.position.toArray(), q: cam.quaternion.toArray() };
}, CAM);
console.log(`  camera ${pose.p.map((v) => v.toFixed(2)).join(", ")}`);

const shots = [];
for (const tier of TIERS) {
  const set = await page.evaluate(async (tier) => {
    const engine = globalThis.__engine;
    for (const entity of engine.entities.values()) {
      const gi = entity.getComponent?.("global-illumination");
      if (gi) { gi.setProp("quality", tier); return { ok: true, props: { ...gi.props } }; }
    }
    return { ok: false };
  }, tier);
  if (!set.ok) { console.log("FATAL: no global-illumination component in the scene"); break; }
  console.log(`\n--- tier ${tier} (exactReflections=${set.props.exactReflections}, backend=${set.props.backend}) ---`);
  await settle(`tier ${tier}`);
  await wait(6000);
  // Re-assert the pose: a rebuild can nudge the editor camera.
  await page.evaluate((pose) => {
    const cam = globalThis.__engine.camera;
    cam.position.fromArray(pose.p);
    cam.quaternion.fromArray(pose.q);
    cam.updateMatrixWorld(true);
  }, pose);
  await wait(2500);
  const png = await page.screenshot();
  const out = `scripts/gi-leak-game-${tier}.png`;
  await sharp(png).toFile(out);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  shots.push({ tier, data, info });
  console.log(`  shot ${out}`);
}
await browser.close();

if (shots.length < 2) process.exit(1);
const [a, b] = shots;
const { info } = a;
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
// Coarse cells so the report names REGIONS, not pixels — a leak is an area.
const CELL = 40;
const cols = Math.ceil(info.width / CELL);
const rows = Math.ceil(info.height / CELL);
const cells = [];
for (let cy = 0; cy < rows; cy++) {
  for (let cx = 0; cx < cols; cx++) {
    let sum = 0, n = 0, base = 0;
    for (let y = cy * CELL; y < Math.min((cy + 1) * CELL, info.height); y++) {
      for (let x = cx * CELL; x < Math.min((cx + 1) * CELL, info.width); x++) {
        const i = (y * info.width + x) * info.channels;
        sum += lum(a.data, i) - lum(b.data, i);
        base += lum(b.data, i);
        n++;
      }
    }
    cells.push({ cx, cy, delta: sum / n, base: base / n });
  }
}
cells.sort((p, q) => q.delta - p.delta);
const meanDelta = cells.reduce((s, c) => s + c.delta, 0) / cells.length;
console.log(`\n${a.tier} minus ${b.tier}: mean ${meanDelta.toFixed(2)} lum over the frame`);
console.log(`Brightest-on-${a.tier} regions (px centre, delta, ${b.tier} base):`);
for (const c of cells.slice(0, 12)) {
  console.log(`  (${c.cx * CELL + CELL / 2}, ${c.cy * CELL + CELL / 2})  +${c.delta.toFixed(1)}  base ${c.base.toFixed(1)}`);
}
// Heatmap: red where the low tier is brighter, over the high-tier frame.
const heat = Buffer.alloc(info.width * info.height * 3);
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    const o = (y * info.width + x) * 3;
    const d = Math.max(0, Math.min(255, (lum(a.data, i) - lum(b.data, i)) * 6));
    const g = lum(b.data, i) * 0.35;
    heat[o] = Math.min(255, g + d); heat[o + 1] = g; heat[o + 2] = g;
  }
}
await sharp(heat, { raw: { width: info.width, height: info.height, channels: 3 } })
  .toFile("scripts/gi-leak-game-heat.png");
console.log("heatmap scripts/gi-leak-game-heat.png (red = brighter on the low tier)");
process.exit(0);
