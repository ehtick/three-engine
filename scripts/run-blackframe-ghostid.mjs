// ONE-OFF (2026-08-14, §12.66): ghostcaster boot CONFIRMED a ghost occluder in
// the shadow map: CPU sun-rays show the view points should be SUNLIT (first
// real caster at depth 0.62+), the map stores a flat ~0.31 blob ≈ the top of
// sponza_5's bbox. This boot IDENTIFIES the ghost: castShadow off per parent
// entity/mesh, one at a time + group bisect, reading frame lum after each;
// then dumps the guilty mesh's full state. Delete with the fix.
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
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(20000);

const readLum = () => page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lumSum = 0;
      for (let i = 0; i < d.length; i += 4) lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      resolve(+(lumSum / (d.length / 4) / 255).toFixed(4));
    });
  });
});
console.log(`0-base lum ${await readLum()}`);

// Index all casters by parentName_i once.
const index = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const list = [];
  globalThis.__ghostList = [];
  engine.scene.traverse((o) => {
    if ((o.isMesh || o.isBatchedMesh || o.isInstancedMesh) && o.castShadow && o.visible) {
      globalThis.__ghostList.push(o);
      list.push(`${o.name || o.parent?.name || "?"}#${list.length}`);
    }
  });
  return list;
});
console.log(`${index.length} casters: ${index.join(", ")}`);

const killSet = async (indices) => {
  await page.evaluate((idx) => {
    const L = globalThis.__ghostList;
    globalThis.__killed = idx.map((i) => L[i]);
    for (const o of globalThis.__killed) o.castShadow = false;
  }, indices);
  await wait(1600);
  const lum = await readLum();
  await page.evaluate(() => {
    for (const o of globalThis.__killed ?? []) o.castShadow = true;
    globalThis.__killed = [];
  });
  await wait(800);
  return lum;
};

// Group bisect: sponza vs the rest.
const sponzaIdx = index.map((n, i) => [n, i]).filter(([n]) => /sponza/i.test(n)).map(([, i]) => i);
const otherIdx = index.map((n, i) => [n, i]).filter(([n]) => !/sponza/i.test(n)).map(([, i]) => i);
console.log(`kill[all sponza_* (${sponzaIdx.length})] lum ${await killSet(sponzaIdx)}`);
console.log(`kill[all non-sponza (${otherIdx.length})] lum ${await killSet(otherIdx)}`);

// Binary search within sponza set (assuming sponza group is the guilty one;
// if not, log shows it and we bisect the other side next boot).
let pool = sponzaIdx;
while (pool.length > 1) {
  const half = pool.slice(0, Math.ceil(pool.length / 2));
  const lum = await killSet(half);
  console.log(`  bisect kill[${half.map((i) => index[i]).join(",")}] lum ${lum}`);
  if (lum > 0.05) pool = half;
  else pool = pool.slice(half.length);
  if (pool.length === 1) break;
}
console.log(`GHOST: ${pool.map((i) => index[i]).join(", ")}`);
const single = await killSet(pool);
console.log(`confirm single-kill lum ${single}`);

// Dump the ghost mesh's full state.
const dump = await page.evaluate((idx) => {
  const o = globalThis.__ghostList[idx];
  const g = o.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const posAttr = g.attributes.position;
  return {
    name: o.name || o.parent?.name, uuid: o.uuid.slice(0, 8),
    matrixWorld: o.matrixWorld.elements.map((v) => +v.toFixed(3)),
    matrixAutoUpdate: o.matrixAutoUpdate,
    frustumCulled: o.frustumCulled,
    renderOrder: o.renderOrder,
    layers: o.layers.mask,
    materialType: o.material?.constructor?.name,
    materialName: o.material?.name,
    customDepthMaterial: !!o.customDepthMaterial,
    morphs: !!g.morphAttributes?.position?.length,
    skinned: !!o.isSkinnedMesh,
    geometry: {
      uuid: g.uuid.slice(0, 8),
      bbox: { min: g.boundingBox.min.toArray().map((v) => +v.toFixed(2)), max: g.boundingBox.max.toArray().map((v) => +v.toFixed(2)) },
      drawRangeStart: g.drawRange.start, drawRangeCount: g.drawRange.count,
      posCount: posAttr?.count, posItemSize: posAttr?.itemSize,
      posArrayType: posAttr?.array?.constructor?.name,
      indexCount: g.index?.count ?? null,
      groups: g.groups?.length ?? 0,
      attrs: Object.keys(g.attributes),
    },
    userDataKeys: Object.keys(o.userData ?? {}),
    parentChain: (() => { const c = []; let p = o; while (p) { c.push(p.name || p.type); p = p.parent; } return c; })(),
    onBeforeRenderCustom: o.onBeforeRender !== Object.getPrototypeOf(o).onBeforeRender && String(o.onBeforeRender).slice(0, 200),
  };
}, pool[0]);
console.log(JSON.stringify(dump, null, 1));
await browser.close();
