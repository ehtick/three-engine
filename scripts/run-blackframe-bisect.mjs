// ONE-OFF (2026-08-14, §12.66 black-boot hunt): fresh boots of the user's
// Sponza render BLACK while drawing all 92 calls / 786k tris; GI healthy; PP
// removal, occlusion-off, SSR-composite fix all changed nothing. The frame
// behaves like shaded-output × ~0.001 with only emissive ghosts surviving.
// This boot bisects the OUTPUT side in-page, four steps, one read each:
//   0. dump renderer output state (toneMapping/exposure/colorSpace/scene env)
//   1. toneMapping = None, exposure = 1  → tonemap exonerated or convicted
//   2. spawn an UNLIT white MeshBasicNodeMaterial cube in front of the camera
//      → if IT is black too, the target/output chain is guilty; if lit,
//        the blackness is lighting/shadow/material-level
//   3. hide the sponza root → does anything else light up
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/blackframe-bisect";
mkdirSync(OUT, { recursive: true });
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
page.on("pageerror", (e) => console.log(`  PAGEERROR: ${(e.stack ?? e.message ?? String(e)).slice(0, 300)}`));
await page.evaluateOnNewDocument((project, ppOff) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  // PPOFF=1: PP inert from frame zero (§12.66 hatch) — the only valid PP
  // bisect for a boot-compile poisoning.
  if (ppOff) globalThis.__ppForceDisabled = true;
}, PROJECT, process.env.PPOFF === "1");
if (process.env.NOWAVE === "1") {
  await page.evaluateOnNewDocument(() => { globalThis.__giNoCompileWave = true; });
}
if (process.env.GIOFF === "1") {
  await page.evaluateOnNewDocument(() => { globalThis.__giOff = true; });
}
if (process.env.NOGUARD === "1") {
  await page.evaluateOnNewDocument(() => { globalThis.__giGbufShadowGuard = false; });
}
console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
// Under GIOFF=1 the "[gi] built" line never logs — settle on time instead.
if (process.env.GIOFF === "1") {
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 120000 });
  await wait(30000);
} else {
  for (let i = 0; i < 240 && !built; i++) await wait(1000);
  if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await wait(20000);
}

const readFrame = () => page.evaluate(async () => {
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
      let black = 0, lumSum = 0, maxLum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += lum;
        if (lum > maxLum) maxLum = lum;
      }
      resolve({
        blackFrac: +(black / (d.length / 4)).toFixed(4),
        meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4),
        maxLum: +(maxLum / 255).toFixed(3),
      });
    });
  });
});

// STEP 0: renderer/scene output state.
const state0 = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const r = engine.renderer;
  const s = engine.scene;
  return {
    toneMapping: r.toneMapping,
    exposure: r.toneMappingExposure,
    outputColorSpace: r.outputColorSpace,
    sceneBackground: s.background?.isColor ? `#${s.background.getHexString()}` : String(s.background),
    sceneEnv: s.environment ? "set" : "null",
    sceneEnvNode: s.environmentNode ? "set" : "null",
    sceneBackgroundNode: s.backgroundNode ? "set" : "null",
    envIntensity: s.environmentIntensity,
    backgroundIntensity: s.backgroundIntensity,
  };
});
console.log(`state ${JSON.stringify(state0)}`);
const base = await readFrame();
await page.screenshot({ path: `${OUT}/0-base.png` });
console.log(`0-base ${JSON.stringify(base)}`);

// STEP 1: tonemap off.
await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  engine.renderer.toneMapping = THREE.NoToneMapping;
  engine.renderer.toneMappingExposure = 1;
});
await wait(1500);
const noTm = await readFrame();
await page.screenshot({ path: `${OUT}/1-no-tonemap.png` });
console.log(`1-no-tonemap ${JSON.stringify(noTm)}`);

// STEP 2: unlit white cube 3m in front of the camera.
await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  const cam = engine.camera;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicNodeMaterial({ color: 0xffffff }),
  );
  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  mesh.position.copy(cam.getWorldPosition(new THREE.Vector3())).addScaledVector(fwd, 3);
  mesh.name = "__blackframe_probe_cube";
  engine.scene.add(mesh);
});
await wait(1500);
const cube = await readFrame();
await page.screenshot({ path: `${OUT}/2-unlit-cube.png` });
console.log(`2-unlit-cube ${JSON.stringify(cube)} — ${cube.maxLum > 0.9 ? "CUBE VISIBLE: output chain fine, blackness is lighting/material-level" : "CUBE BLACK TOO: output chain guilty"}`);

// STEP 3: the sun. Read its live state, then kill castShadow — an
// uninitialized shadow map (its depth-only writer pipeline failing with the
// empty-struct error) reads depth 0 = everything in shadow = exactly a
// black-but-drawn frame with emissive/GI ghosts.
const sun = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  if (!light) return { error: "no directional light" };
  const dir = light.getWorldDirection ? null : null;
  return {
    intensity: light.intensity,
    visible: light.visible,
    castShadow: light.castShadow,
    autoUpdate: light.shadow?.autoUpdate,
    hasMap: !!light.shadow?.map,
    mapSize: light.shadow?.mapSize?.toArray?.() ?? null,
  };
});
console.log(`sun ${JSON.stringify(sun)}`);
await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  engine.scene.traverse((o) => { if (o.isDirectionalLight) o.castShadow = false; });
});
await wait(2500);
const noShadow = await readFrame();
await page.screenshot({ path: `${OUT}/3-castshadow-off.png` });
console.log(`3-castshadow-off ${JSON.stringify(noShadow)} — ${noShadow.meanLum > 0.05 ? "SHADOW MAP IS THE KILLER (frame lit without it)" : "still dark — shadow exonerated"}`);

// STEP 4: castShadow back ON. If the frame stays LIT (with shadow pools, not
// black), the shadow path WORKS when set up post-boot — the boot-time setup
// left a dead binding (e.g. materials bound to a never-rendered clone map).
// If it goes BLACK again, the breakage re-arms with the flag: the fault rides
// the shadow node itself, not boot order.
await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  engine.scene.traverse((o) => { if (o.isDirectionalLight) o.castShadow = true; });
});
await wait(4000);
const reShadow = await readFrame();
await page.screenshot({ path: `${OUT}/4-castshadow-back-on.png` });
console.log(`4-castshadow-back-on ${JSON.stringify(reShadow)} — ${reShadow.meanLum > 0.05 ? "LIT: boot-order/binding fault (shadow works when rebuilt live)" : "BLACK again: fault is in the shadow node itself"}`);

// STEP 5: the light's saved shadow props — the 14:17 save carries
// shadowMapType "BasicShadowMap". Swap to PCFSoft through the sanctioned
// component op (which reconfigures the shadow) and re-read.
const swap = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  try {
    await api.call("component.setProp", { id: "Gql8TsY-b9", type: "light", key: "shadowMapType", value: "PCFSoftShadowMap" });
    return { set: true };
  } catch (e) { return { set: false, err: String(e?.message ?? e).slice(0, 150) }; }
});
console.log(`shadowMapType→PCFSoft ${JSON.stringify(swap)}`);
await wait(4000);
const pcf = await readFrame();
await page.screenshot({ path: `${OUT}/5-pcfsoft.png` });
console.log(`5-pcfsoft ${JSON.stringify(pcf)} — ${pcf.meanLum > 0.05 ? "LIT: BasicShadowMap path is the breakage" : "still black — shadowMapType exonerated"}`);
await browser.close();
