// INSPECTION ONLY, read-only against the real GAME project — dumps ground
// truth on the BVH albedo atlas (pendingGpuTiles / texturedCount / per-mesh
// map.isCompressedTexture) independent of any camera-framing heuristics.
// Mirrors run-gi-diagnose-game.mjs's proven open-project pattern exactly.
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5280/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const SCENE = "scenes/Main.scene";
const scenePath = path.join(PROJECT, SCENE).replace(/\\/g, "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { verbose: !!process.env.VERBOSE });

page.on("console", (m) => {
  const text = m.text();
  if (/\[gi\]/.test(text) || m.type() === "error") console.log(`  page ${m.type()}: ${text.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

console.log(`Opening project ${PROJECT}, scene ${scenePath} ...`);
const opened = await page.evaluate(
  async ({ PROJECT, scenePath }) => {
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
      return { ok: true, entities: engine.entities.size };
    } catch (err) {
      return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
    }
  },
  { PROJECT, scenePath },
);
if (!opened.ok) {
  console.log(`FATAL: ${opened.error}`);
  await browser.close();
  process.exit(1);
}
console.log(`  opened: ${opened.entities} entities`);

// Settle: wait for renderSuspended to clear + entity count to stabilize,
// same budgets as run-gi-diagnose-game.mjs.
const settle = async (budgetMs) => {
  const t = Date.now();
  while (Date.now() - t < budgetMs) {
    await wait(1000);
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t > 6000) break;
  }
};
await settle(60000);
await wait(3000);
let n1 = await page.evaluate(() => globalThis.__engine.entities.size);
await wait(8000);
let n2 = await page.evaluate(() => globalThis.__engine.entities.size);
if (n1 !== n2) {
  console.log(`  entity count still growing (${n1} -> ${n2}), settling more...`);
  await settle(30000);
}
console.log("  settled.");

// Let a few more ticks run so blitBvhAtlasTiles has every chance to fire.
await wait(4000);

const dump = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const gi = engine.modules.get("gi");
  const state = gi?.system?.state;
  const bvhScene = state?.bvhScene;
  if (!bvhScene) return { ok: false, error: "no state.bvhScene (GI disabled, or exactReflections off, or no screen resolve yet)" };

  const meshInfo = bvhScene.meshes.map((mesh) => {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const map = material?.map ?? null;
    return {
      name: mesh.name || "(unnamed)",
      hasMap: !!map,
      mapName: map?.name ?? null,
      mapSourceUrl: map?.source?.data?.currentSrc ?? map?.image?.currentSrc ?? map?.userData?.src ?? null,
      isCompressedTexture: !!map?.isCompressedTexture,
      mapFormat: map?.format ?? null,
      mapConstructor: map?.constructor?.name ?? null,
      hasCpuImage: !!(map?.image ?? map?.source?.data),
      imageIsDrawable: (() => {
        const img = map?.image ?? map?.source?.data;
        if (!img) return false;
        return typeof HTMLImageElement !== "undefined" && (img instanceof HTMLImageElement || img instanceof ImageBitmap || img instanceof HTMLCanvasElement || img instanceof OffscreenCanvas);
      })(),
      materialColor: material?.color ? `#${material.color.getHexString()}` : null,
    };
  });

  return {
    ok: true,
    meshCount: bvhScene.meshCount,
    triCount: bvhScene.triCount,
    texturedCount: bvhScene.texturedCount,
    pendingGpuTilesLength: bvhScene.pendingGpuTiles.length,
    pendingGpuTiles: bvhScene.pendingGpuTiles.map((t) => ({ tileIndex: t.tileIndex, mapName: t.map?.name, isCompressedTexture: !!t.map?.isCompressedTexture })),
    hasBlitTarget: !!bvhScene.blitTarget,
    atlasTextureNodeValueIsBlitTarget: bvhScene.blitTarget ? bvhScene.atlasTextureNode.value === bvhScene.blitTarget.texture : null,
    meshInfo,
  };
});

console.log("\n=== BVH ATLAS GROUND TRUTH ===");
console.log(JSON.stringify(dump, null, 2));

await browser.close();
process.exit(0);
