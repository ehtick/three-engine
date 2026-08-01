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
page.on("console", (m) => { if (/error/i.test(m.type())) console.log("page error:", m.text().slice(0,200)); });
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
  const { THREE } = await globalThis.__importLive("/src/engine/index.js");
  globalThis.__THREE = THREE;
  return { ok: true, entities: engine.entities.size };
}, { PROJECT, scenePath });
console.log("opened:", JSON.stringify(opened));
const settle = async (budgetMs) => { const t = Date.now(); while (Date.now()-t<budgetMs){ await wait(1000); const busy = await page.evaluate(()=>globalThis.__engine?.renderSuspended===true); if(!busy && Date.now()-t>6000) break; } };
await settle(60000);
await wait(10000);

const bounds = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const THREE = globalThis.__THREE;
  const out = [];
  for (const entity of engine.entities.values()) {
    if (!["Box","Ceiling","Floor","Partition","Green","Red","Group","Main","Light"].includes(entity.name)) continue;
    const box = new THREE.Box3().setFromObject(entity.object3D);
    if (box.isEmpty()) { out.push({ name: entity.name, empty: true }); continue; }
    out.push({ name: entity.name, min: box.min.toArray().map(v=>+v.toFixed(2)), max: box.max.toArray().map(v=>+v.toFixed(2)) });
  }
  // also world position of the actual Box entity directly
  const boxEnt = [...engine.entities.values()].find(e => e.name === "Box");
  const boxWorldPos = boxEnt ? boxEnt.object3D.getWorldPosition(new THREE.Vector3()).toArray() : null;
  return { out, boxWorldPos };
});
console.log(JSON.stringify(bounds, null, 2));
await browser.close();
process.exit(0);
