// EMITTER-SHADOW PROBE — the "waffle grid" instrument (2026-08-06 —
// a big emissive panel's shadow channel etches a regular lattice across the
// floor). Big volume → coarse field cells, panel emitter + crate occluder;
// reads back the emitterShadow texture (channel 0 = slot 0, what materials
// sample) and PNGs it, plus a viewport screenshot for context.
// Env HATCH: none | noselfcut (__giNoOccSelfCut) | norecords
// (__giRayHitShadowRecords=false) | sphere (__giSphereEmitters).
// Arms: none (record-march default) | spherearm (__giEmitterRecordShadows=false,
// the legacy sphere trace) | noprobe (__giShadowAnalyticWidth=false — march+pen
// only) | kind (verdict-kind map) | tap (width-probe argmin-tap map) |
// noselfcut | norecords | sphere. STEPS=n overrides the macro budget.
//   HATCH=none node scripts/run-gi-emitter-shadow-probe.mjs <url>
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5335/";
const hatch = process.env.HATCH ?? "none";
const quality = process.env.QUALITY ?? "high";
const steps = Number(process.env.STEPS ?? 0);
// SLAB=1 — the LEAK arm: a thin (0.08m) wall between the panel and the
// floor, tall/wide enough that the floor strip behind it is geometrically
// FULLY occluded; the mean shadow value over that strip is the leak metric
// (0 = sealed). The thin-wall case is the width probe's known weak spot
// (log-spaced taps can straddle thin geometry), so this is the standing
// guard on the exhaustion→probe fallback.
const slab = process.env.SLAB === "1";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => { const t = m.text(); if (/\[gi\] (built|light shadows|emitters|composited)|PROBE/.test(t)) console.log(`  ${t.slice(0, 200)}`); });
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async ({ hatch, quality, steps, slab }) => {
  globalThis.__editorKeepRendering = true;
  if (hatch === "noselfcut") globalThis.__giNoOccSelfCut = true;
  if (hatch === "norecords") globalThis.__giRayHitShadowRecords = false;
  if (hatch === "sphere") globalThis.__giSphereEmitters = true;
  if (hatch === "spherearm") globalThis.__giEmitterRecordShadows = false;
  if (steps) globalThis.__giDirectShadowSteps = steps;
  if (hatch === "kind") globalThis.__giEmitterShadowKindDebug = true;
  if (hatch === "noprobe") globalThis.__giShadowAnalyticWidth = false;
  if (hatch === "tap") globalThis.__giWidthProbeDebugTap = true;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) if (child.isMesh) engine.scene.remove(child);
  const anon = (g) => { const n = g.toNonIndexed(); n.parameters = undefined; n.type = "BufferGeometry"; return n; };
  const grey = new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(30, 0.3, 30)), grey);
  floor.position.y = -0.15;
  const crate = new THREE.Mesh(anon(new THREE.BoxGeometry(1.2, 1.2, 1.2)), grey);
  crate.position.set(0, 0.6, 0);
  // The panel: a tall emissive slab standing behind the crate, like the
  // user's screenshot.
  const glowMat = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
  glowMat.emissive = new THREE.Color(1, 1, 1);
  glowMat.emissiveIntensity = 8;
  const panel = new THREE.Mesh(anon(new THREE.BoxGeometry(5, 4, 0.3)), glowMat);
  panel.position.set(0, 2, -6);
  engine.scene.add(floor, crate, panel);
  if (slab) {
    const wall = new THREE.Mesh(anon(new THREE.BoxGeometry(6, 3, 0.08)), grey);
    wall.position.set(0, 1.5, -3);
    engine.scene.add(wall);
  }
  const cam = engine.camera;
  cam?.position?.set(7, 7, 9);
  cam?.lookAt?.(0, 0, 0);

  const gi = engine.createEntity({ name: "GI Emissive Probe" });
  gi.addComponent("global-illumination", { autoFit: true, quality, emissiveShadows: true });
  const system = engine.modules.get("gi").system;
  const deadline = performance.now() + 90_000;
  let screen = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    screen = system.state?.screen ?? null;
    if (screen && (system.state?.volume?.occupancyField?.stats?.dispatches ?? 0) > 3) break;
  }
  if (!screen) return { fail: "GI never built a screen bundle" };
  {
    const end = performance.now() + 60_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 5) {
      await new Promise((r) => setTimeout(r, 200));
      const d = system.state?.volume?.occupancyField?.debugIncremental;
      quiet = globalThis.__giPendingComputePipelines?.size === 0 && d && !d.dirty && !d.staticDirty ? quiet + 1 : 0;
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  const emitters = system.state?.emitterSlots?.length ?? 0;
  // The emitter shadow texture lives at the SHADOW-channel resolution since
  // the pass split (2026-08-06).
  const W = screen.emitterShadowWidth ?? screen.shadowWidth ?? screen.width, H = screen.emitterShadowHeight ?? screen.shadowHeight ?? screen.height;
  const strideBytes = Math.ceil((W * 4) / 256) * 256;
  const data = await engine.renderer.backend.copyTextureToBuffer(screen.targets.emitterShadow, 0, 0, W, H);
  const img = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * strideBytes;
    for (let x = 0; x < W; x++) img[y * W + x] = data[row + x * 4] / 255;
  }
  const inPen = (v) => v > 0.08 && v < 0.92;
  let sum = 0, n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!inPen(img[i])) continue;
    sum += Math.abs(img[i] * 4 - img[i - 1] - img[i + 1] - img[i - W] - img[i + W]); n++;
  }
  const toPng = (im) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, Math.min(255, Math.round(im[i] * 255)));
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
  };
  // Leak metric (SLAB arm): project floor points in the fully-occluded
  // strip behind the slab and read the shadow channel there.
  let leak = null;
  if (slab && engine.camera) {
    const camM = engine.camera;
    camM.updateMatrixWorld(true);
    const vp = new THREE.Matrix4().multiplyMatrices(camM.projectionMatrix, camM.matrixWorldInverse);
    let lSum = 0, lN = 0;
    for (let zi = 0; zi <= 6; zi++) for (let xi = 0; xi <= 8; xi++) {
      const wx = -2 + xi * 0.5, wz = -2.5 + zi * 0.25;
      const pr = new THREE.Vector4(wx, 0.01, wz, 1).applyMatrix4(vp);
      if (pr.w <= 0) continue;
      const sx2 = Math.round((pr.x / pr.w * 0.5 + 0.5) * W);
      const sy2 = Math.round((0.5 - pr.y / pr.w * 0.5) * H);
      if (sx2 < 0 || sx2 >= W || sy2 < 0 || sy2 >= H) continue;
      lSum += img[sy2 * W + sx2]; lN++;
    }
    leak = lN ? lSum / lN : -1;
  }
  return { W, H, emitters, grain: n ? sum / n : 0, penPx: n, leak, shadowPng: toPng(img) };
}, { hatch, quality, steps, slab });

if (result.fail) { console.log(`FAIL: ${result.fail}`); await browser.close(); process.exit(1); }
writeFileSync(`scripts/gi-diag-emissive-grid-${hatch}${slab ? "-slab" : ""}${steps ? `-s${steps}` : ""}.png`, Buffer.from(result.shadowPng.split(",")[1], "base64"));
await page.screenshot({ path: `scripts/gi-diag-emissive-grid-${hatch}-view.png` });
console.log(`PROBE hatch=${hatch}${slab ? "+slab" : ""} q=${quality} ${result.W}x${result.H} emitters=${result.emitters} penumbraPx=${result.penPx} grain=${result.grain.toFixed(4)} leak=${result.leak == null ? "n/a" : result.leak.toFixed(4)}`);
await browser.close();
