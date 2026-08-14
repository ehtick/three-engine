// ONE-OFF (2026-08-14, §12.66): compare-census proved the shadow SAMPLING is
// healthy (GreaterEqual/Always flips light the frame) and the map's DEPTH
// VALUES are stale — rendered under an early-boot camera state (far ≈ 85 by
// back-computation) while shadow.matrix carries the final far=50 state; an
// explicit needsUpdate never re-renders the map. Suspect: NodeFrame.frameId
// only advances in three's INTERNAL rAF Animation loop; if that loop starves,
// ShadowNode.updateBefore's `_cameraFrameId[camera] === frameId` gate swallows
// EVERY shadow update after the first. This boot measures:
//   frameId advance rate, renderer._animation state, page rAF rate,
//   shadow-map render-pass rate, updateMatrices call rate + camera far,
//   and whether shadow.needsUpdate=true produces a shadow pass.
// Delete with the fix.
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
  const C = globalThis.__fidCensus = { texSerial: 0, shadowPasses: 0, lastShadowPassT: 0 };
  const patch = () => {
    if (!globalThis.GPUDevice?.prototype?.createTexture || GPUDevice.prototype.__fidPatched) return;
    GPUDevice.prototype.__fidPatched = true;
    const origTex = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (desc) {
      const tex = origTex.call(this, desc);
      try {
        const size = Array.isArray(desc?.size) ? desc.size : [desc?.size?.width, desc?.size?.height];
        if (String(desc?.format ?? "").startsWith("depth") && size?.[0] === 4096) tex.__fidShadow = true;
      } catch {}
      return tex;
    };
    const origView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (desc) {
      const view = origView.call(this, desc);
      try { if (this.__fidShadow) view.__fidShadow = true; } catch {}
      return view;
    };
    const origPass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
      try {
        if (desc?.depthStencilAttachment?.view?.__fidShadow) { C.shadowPasses++; C.lastShadowPassT = performance.now(); }
      } catch {}
      return origPass.call(this, desc);
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
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(20000);

const report = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const r = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light.shadow;
  const C = globalThis.__fidCensus;

  // instrument updateMatrices + updateProjectionMatrix on the live objects
  const calls = { updateMatrices: 0, farsAtCall: new Set(), updateProj: 0 };
  const origUM = s.updateMatrices.bind(s);
  s.updateMatrices = (...a) => { calls.updateMatrices++; calls.farsAtCall.add(s.camera.far); return origUM(...a); };

  const nodeFrame = r._nodes?.nodeFrame ?? null;
  const f0 = nodeFrame?.frameId ?? null;
  const sp0 = C.shadowPasses;
  let rafCount = 0;
  const rafTick = () => { rafCount++; requestAnimationFrame(rafTick); };
  requestAnimationFrame(rafTick);
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, 2000));
  const dt = (performance.now() - t0) / 1000;
  const f1 = nodeFrame?.frameId ?? null;
  const sp1 = C.shadowPasses;
  const um1 = calls.updateMatrices;

  // now force a shadow update and watch for a shadow pass
  s.needsUpdate = true;
  await new Promise((res) => setTimeout(res, 1500));
  const sp2 = C.shadowPasses;
  const stillNeeds = s.needsUpdate;

  return {
    frameId0: f0, frameId1: f1, frameIdRate: +((f1 - f0) / dt).toFixed(1),
    infoFrame: r.info?.frame ?? null,
    animRequestId: r._animation?._requestId ?? "n/a",
    rafPerSec: +(rafCount / (dt + 1.5)).toFixed(1),
    shadowPassesTotal0: sp0, perSec: +((sp1 - sp0) / dt).toFixed(2),
    lastShadowPassT: +(C.lastShadowPassT / 1000).toFixed(1),
    updateMatricesPerSec: +(um1 / dt).toFixed(1), farsAtCall: [...calls.farsAtCall],
    afterForcedNeedsUpdate: { newShadowPasses: sp2 - sp1, stillNeedsUpdate: stillNeeds },
    camFarNow: s.camera.far,
  };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
