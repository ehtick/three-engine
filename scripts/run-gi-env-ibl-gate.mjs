// ONE-OFF (2026-08-14): gate for §12.64 — with GI active, `scene.environment`
// must light the scene ONLY through GI's occluded sky, never as three's flat
// per-material IBL (user: "adding environment fills the whole sponza with
// ambient, which is not correct, as it must have very dark areas"). Boots the
// real Sponza read-only, sets a neutral environment IN-PAGE, then measures
// beauty-frame region luminance (onPostRender canvas readback — trap 8) in
// two arms: `__giKeepIBL=true` (three's IBL restored) vs default (suppressed).
// PASS = the dark corridor darkens strongly under suppression while the frame
// stays lit, and the "[gi] environment IBL suppressed" line fired.
// Delete when §12.64 is verified in the user's editor.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/env-ibl-gate";
await mkdir(OUT, { recursive: true });
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
let suppressLine = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/environment IBL suppressed/.test(t)) suppressLine = true;
  if (m.type() === "error" && !/favicon|404|structures must have at least one member|selectionOutlineMask|previous error|Invalid ShaderModule/.test(t)) {
    console.log(`  console.error: ${t.slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));
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
await page.evaluate(() => globalThis.__editorApi.call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] }));
console.log("settling out the compile wave…");
await wait(25000);

// Neutral white environment, set in-page — read-only shim means the user's
// scene file is never touched.
await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  // A second three instance is fine for a plain DataTexture — three
  // duck-types (`isTexture`) and the format constants are numeric. Only
  // TSL-kernels-over-app-nodes are the duplicate-three trap.
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  // 64×32, not 1×1 — the PMREM of a 1×1 texture came out ~black and the
  // first sun-off run measured GI sky in BOTH arms, never the IBL.
  const W = 64, H = 32;
  const tex = new THREE.DataTexture(new Float32Array(W * H * 4).fill(1), W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  engine.scene.environment = tex;
  engine.scene.environmentIntensity = 1;
});
// SUN OFF for the whole gate: at intensity 50 the sun tonemap-drowns a ±1
// environment to ~1% of the frame — the first two runs measured exactly
// nothing. (This is also when the USER sees the wash: their day-cycle sun
// spends much of play below the horizon.) Shim instance — nothing persists.
await page.evaluate(() => globalThis.__editorApi.call("component.setProp", {
  id: "Gql8TsY-b9", type: "light", key: "intensity", value: 0,
}));
console.log("environment set, sun zeroed; letting the recompile settle…");
await wait(15000);

// Force every scene material to re-key — the environmentNode swap SHOULD be
// caught by three's dynamic scene cache key, but this gate must separate
// "suppression doesn't work" from "the recompile didn't happen", so it
// sledgehammers the question after every toggle.
const forceMaterialUpdate = () => page.evaluate(() => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  let n = 0;
  engine.scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.needsUpdate = true; n++; }
  });
  return n;
});

// Beauty-frame region means via onPostRender canvas readback, N-frame average.
// Regions are in CANVAS fractions: dark corridor end (center-left of the
// parked view) and the whole frame.
const measure = (label) => page.evaluate(async (lbl) => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const gi = engine.modules.get("gi")?.system;
  const skyR = gi?.state?.skyRadiance?.value;
  const envNodeState = engine.scene.environmentNode == null
    ? "null"
    : engine.scene.environmentNode === gi?._envIblBlack ? "black(ours)" : "other";
  const envSet = !!engine.scene.environment;
  const one = () => new Promise((resolve) => {
    let frames = 0;
    const off = engine.onPostRender(() => {
      if (++frames < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const region = (fx0, fy0, fx1, fy1) => {
        const x0 = Math.floor(fx0 * c.width), y0 = Math.floor(fy0 * c.height);
        const x1 = Math.floor(fx1 * c.width), y1 = Math.floor(fy1 * c.height);
        const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4) / 255;
      };
      resolve({
        dark: region(0.44, 0.30, 0.57, 0.52),   // the deep arch at the corridor end
        full: region(0.02, 0.05, 0.98, 0.95),
      });
    });
  });
  const acc = { dark: 0, full: 0 };
  const N = 5;
  for (let i = 0; i < N; i++) { const r = await one(); acc.dark += r.dark / N; acc.full += r.full / N; }
  return {
    label: lbl, dark: +acc.dark.toFixed(4), full: +acc.full.toFixed(4),
    skyRadiance: skyR ? [+skyR.r.toFixed(2), +skyR.g.toFixed(2), +skyR.b.toFixed(2)] : null,
    envNode: envNodeState, envSet,
  };
}, label);

// ARM 0: no environment at all — the dark baseline the user's scene shipped with.
await page.evaluate(() => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  globalThis.__savedEnv = engine.scene.environment;
  engine.scene.environment = null;
});
console.log(`  forced material update on ${await forceMaterialUpdate()} materials`);
await wait(14000);
const noEnv = await measure("no-env");
console.log(JSON.stringify(noEnv));
await page.screenshot({ path: `${OUT}/0-no-env.png` });

// ARM 1: environment + IBL restored (old behaviour).
await page.evaluate(() => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  engine.scene.environment = globalThis.__savedEnv;
  globalThis.__giKeepIBL = true;
});
console.log(`  forced material update on ${await forceMaterialUpdate()} materials`);
await wait(14000);
const iblOn = await measure("ibl-on");
console.log(JSON.stringify(iblOn));
await page.screenshot({ path: `${OUT}/1-ibl-on.png` });

// ARM 2: environment + suppressed (§12.64 default).
await page.evaluate(() => { delete globalThis.__giKeepIBL; });
await wait(2000); // let #tick reinstall the black node BEFORE the sweep
console.log(`  forced material update on ${await forceMaterialUpdate()} materials`);
await wait(14000);
const suppressed = await measure("suppressed");
console.log(JSON.stringify(suppressed));
await page.screenshot({ path: `${OUT}/2-suppressed.png` });

const darkDrop = iblOn.dark > 0 ? suppressed.dark / iblOn.dark : 1;
console.log(`\nno-env baseline: dark ${noEnv.dark}  full ${noEnv.full}  (envNode ${noEnv.envNode})`);
console.log(`ibl-on:          dark ${iblOn.dark}  full ${iblOn.full}  (envNode ${iblOn.envNode})`);
console.log(`suppressed:      dark ${suppressed.dark}  full ${suppressed.full}  (envNode ${suppressed.envNode})`);
console.log(`suppress log line seen: ${suppressLine}`);
// PASS = the wash exists (ibl-on lifts the dark arch over the no-env
// baseline), suppression kills most of it there, and GI's occluded sky still
// lights the frame (the environment is rerouted, not deleted).
const pass = suppressLine
  && suppressed.envNode === "black(ours)" && iblOn.envNode === "null"
  && iblOn.dark > noEnv.dark + 0.03
  && darkDrop < 0.6
  && suppressed.full > noEnv.full + 0.003;
console.log(pass ? "\nGATE PASS — environment lights through GI only; the IBL wash is gone" : "\nGATE FAIL — see numbers above");
await browser.close();
process.exit(pass ? 0 : 1);
