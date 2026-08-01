import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
const url = process.argv[2] ?? "http://localhost:5280/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const scenePath = path.join(PROJECT, "scenes/Main.scene").replace(/\\/g, "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const opened = await page.evaluate(async ({ PROJECT, scenePath }) => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  await useProjectStore.getState().openProject(PROJECT);
  const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
  await syncProjectModules();
  const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
  await openScenePath(scenePath);
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;
  return { ok: true, entities: engine.entities.size };
}, { PROJECT, scenePath });
console.log("opened:", JSON.stringify(opened));
const settle = async (budgetMs) => {
  const t = Date.now();
  while (Date.now() - t < budgetMs) {
    await wait(1000);
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t > 6000) break;
  }
};
await settle(60000);
await wait(10000);
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => !!globalThis.__viewport?.orbit && !!globalThis.__engine?.camera);
  if (ready) break;
  await wait(500);
}

const eye = [1.7, 3.5, 3.0];
const target = [1.7, 1.59, -0.96];

const immediate = await page.evaluate(
  ({ eye, target }) => {
    const viewport = globalThis.__viewport;
    const camera = globalThis.__engine.camera;
    camera.position.set(...eye);
    if (viewport?.orbit) {
      viewport.orbit.target.set(...target);
      viewport.orbit.update();
    } else {
      camera.lookAt(...target);
    }
    camera.updateMatrixWorld(true);
    return {
      orbitTarget: viewport?.orbit?.target?.toArray() ?? null,
      orbitMinDistance: viewport?.orbit?.minDistance ?? null,
      orbitMaxDistance: viewport?.orbit?.maxDistance ?? null,
      orbitEnabled: viewport?.orbit?.enabled ?? null,
      cameraPosAfterUpdate: camera.position.toArray(),
      cameraQuatAfterUpdate: camera.quaternion.toArray(),
    };
  },
  { eye, target },
);
console.log("IMMEDIATE after set+orbit.update():", JSON.stringify(immediate, null, 2));

await wait(1000);

const afterWait = await page.evaluate(() => {
  const viewport = globalThis.__viewport;
  const camera = globalThis.__engine.camera;
  return {
    orbitTarget: viewport?.orbit?.target?.toArray() ?? null,
    cameraPos: camera.position.toArray(),
    cameraQuat: camera.quaternion.toArray(),
  };
});
console.log("AFTER 1s wait (many onUpdate frames):", JSON.stringify(afterWait, null, 2));

const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")].map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});
await page.screenshot({ path: "scripts/_diag-camera-shot.png", clip: box });
console.log("SHOT scripts/_diag-camera-shot.png");

// Try a second, further-back pose too, in case 3m is simply too close /
// clipping into nearby geometry.
const eye2 = [1.7, 4.5, 6.0];
await page.evaluate(
  ({ eye2, target }) => {
    const viewport = globalThis.__viewport;
    const camera = globalThis.__engine.camera;
    camera.position.set(...eye2);
    viewport.orbit.target.set(...target);
    viewport.orbit.update();
    camera.updateMatrixWorld(true);
  },
  { eye2, target },
);
await wait(500);
await page.screenshot({ path: "scripts/_diag-camera-shot2.png", clip: box });
console.log("SHOT scripts/_diag-camera-shot2.png");

await browser.close();
process.exit(0);
