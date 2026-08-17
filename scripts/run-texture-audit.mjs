// WHAT IS THE TEXTURE MEMORY ACTUALLY MADE OF? (plan §12.78.3)
//
// The Stats overlay reports one number and every explanation of it so far has
// been arithmetic on assumptions. three tracks a real byte size PER TEXTURE in
// `renderer.info.memoryMap` (Info.createTexture / destroyTexture), so the
// aggregate can simply be itemised.
//
// This boots the REAL project fresh, which is also the control the user's
// question needs: a fresh boot has never loaded a deleted model, so anything
// still resident here is legitimately the open scene, not a cache leak.
//
// ⚠ The harness viewport is smaller than the editor's, so RENDER TARGET bytes
// here are NOT comparable to the editor's. Source-art bytes are.
//
// Usage: node scripts/run-texture-audit.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/texaudit";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
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
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(12000);

const audit = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const info = engine.renderer.info;
  const map = info.memoryMap;
  if (!map?.entries) return { error: "no info.memoryMap on this three build" };

  const referenced = new Set();
  const KEYS = ["map","normalMap","roughnessMap","metalnessMap","aoMap","emissiveMap","alphaMap","bumpMap",
    "displacementMap","lightMap","envMap","specularMap","clearcoatMap","clearcoatNormalMap",
    "clearcoatRoughnessMap","sheenColorMap","sheenRoughnessMap","transmissionMap","thicknessMap",
    "iridescenceMap","anisotropyMap","specularColorMap","specularIntensityMap"];
  const note = (m) => {
    if (!m) return;
    for (const k of KEYS) if (m[k]) referenced.add(m[k]);
    for (const v of Object.values(m)) {
      if (v && v.isTexture) referenced.add(v);
      else if (v && v.isNode && v.value?.isTexture) referenced.add(v.value);
    }
  };
  engine.scene?.traverse?.((o) => {
    const m = o.material;
    if (Array.isArray(m)) m.forEach(note); else note(m);
  });
  if (engine.scene?.background?.isTexture) referenced.add(engine.scene.background);
  if (engine.scene?.environment?.isTexture) referenced.add(engine.scene.environment);

  const rows = [];
  const b = { renderTarget: 0, compressed: 0, uncompressed: 0 };
  const c = { renderTarget: 0, compressed: 0, uncompressed: 0 };
  let orphanBytes = 0, orphanCount = 0, total = 0;
  for (const [tex, size] of map.entries()) {
    const bytes = size || 0; total += bytes;
    const isTarget = !!(tex.isRenderTargetTexture || tex.isDepthTexture);
    const kind = isTarget ? "renderTarget" : tex.isCompressedTexture ? "compressed" : "uncompressed";
    b[kind] += bytes; c[kind]++;
    const orphan = !isTarget && !referenced.has(tex);
    if (orphan) { orphanBytes += bytes; orphanCount++; }
    rows.push({
      name: tex.name || tex.userData?.path || (typeof tex.source?.data?.src === "string" ? tex.source.data.src.slice(-70) : "") || "(unnamed)",
      kind, mb: +(bytes / 1048576).toFixed(2),
      dim: tex.image ? `${tex.image.width ?? "?"}x${tex.image.height ?? "?"}` : "?",
      fmt: tex.format, orphan: orphan || undefined,
    });
  }
  rows.sort((x, y) => y.mb - x.mb);
  const MB = (v) => +(v / 1048576).toFixed(1);
  return {
    statsTextureMemMB: MB(info.memory.texturesSize),
    trackedCount: info.memory.textures,
    totalMB: MB(total),
    byKind: {
      renderTargets: { count: c.renderTarget, mb: MB(b.renderTarget) },
      compressedSource: { count: c.compressed, mb: MB(b.compressed) },
      uncompressedSource: { count: c.uncompressed, mb: MB(b.uncompressed) },
    },
    notReferencedByScene: { count: orphanCount, mb: MB(orphanBytes) },
    largest: rows.slice(0, 30),
  };
});
console.log(JSON.stringify(audit, null, 1));
await writeFile(`${OUT}/audit.json`, JSON.stringify(audit, null, 1));
await browser.close();
process.exit(0);
