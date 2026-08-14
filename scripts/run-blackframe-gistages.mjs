// ONE-OFF (2026-08-14, §12.66): giresolve probe showed all GI screen passes
// DISPATCH in the black state, field shading live (24k hits), yet the screen
// irradiance target is ~black (mean 0.0027). This boot reads each stage
// boundary: gbuffer coverage/content, emitter seat power (_emitterInfos),
// full srcProbes cascade stats, and the emitter-shadow target. Delete with
// the fix.
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

// helper: sample an RGBA texture via primed compute
const readTex = (path, comp = "xyz") => page.evaluate(async (texPath, c) => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  let tex = sys;
  for (const k of texPath.split(".")) { tex = tex?.[k]; if (!tex) break; }
  if (!tex || !tex.isTexture) return { error: `no texture at ${texPath}`, type: tex?.constructor?.name };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const W = tex.image?.width ?? 0, H = tex.image?.height ?? 0;
  if (!W) return { error: "no size" };
  const N = 48;
  const buf = instancedArray(new Float32Array(N * N * 4), "vec4");
  const node = texture(tex);
  const sx = Math.max(1, Math.floor(W / N)), sy = Math.max(1, Math.floor(H / N));
  const kernel = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(sx));
    const py = instanceIndex.div(uint(N)).mul(uint(sy));
    buf.element(instanceIndex).assign(vec4(node.load(ivec2(px.toInt(), py.toInt()))));
  })().compute(N * N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  engine.renderer.compute(kernel);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  engine.renderer.compute(kernel);
  const a = new Float32Array(await engine.renderer.getArrayBufferAsync(buf.value));
  let sum = 0, mx = -Infinity, mn = Infinity, wSum = 0, wNZ = 0;
  const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
    if (Number.isFinite(l)) { sum += l; if (l > mx) mx = l; if (l < mn) mn = l; }
    wSum += a[i + 3];
    if (a[i + 3] > 0.5) wNZ++;
  }
  return { size: [W, H], mean: +(sum / count).toFixed(4), min: +mn.toFixed(3), max: +mx.toFixed(3), wMean: +(wSum / count).toFixed(3), wCoverage: +(wNZ / count).toFixed(3) };
}, path, comp);

// 1. emitter seats
const seats = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  return (sys?._emitterInfos ?? []).map((e) => e ? {
    mesh: e.mesh ? (e.mesh.name || e.mesh.parent?.name || "?") : null,
    provider: !!e.provider,
    r: e.r != null ? +e.r.toFixed(2) : null, g: e.g != null ? +e.g.toFixed(2) : null, b: e.b != null ? +e.b.toFixed(2) : null,
    pos: e.mesh?.getWorldPosition?.(new (Object.getPrototypeOf(e.mesh.position).constructor)())?.toArray?.().map((v) => +v.toFixed(2)) ?? null,
  } : null);
});
console.log(`emitterSeats ${JSON.stringify(seats)}`);

// 2. gbuffer targets — find them
const gbufKeys = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const found = [];
  const scan = (obj, prefix, depth) => {
    if (!obj || depth > 2) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v || typeof v !== "object") continue;
      if (/gbuf|Gbuf|GBuffer/i.test(k)) found.push(prefix + k + `(${v.constructor?.name})`);
    }
  };
  scan(sys, "", 0);
  scan(sys._giScreen ?? {}, "_giScreen.", 1);
  const screen = sys?._giScreen ?? sys?.screen ?? null;
  return { found, screenKeys: screen ? Object.keys(screen).slice(0, 30) : null, sysGbufKeys: Object.keys(sys ?? {}).filter((k) => /screen|gbuf/i.test(k)) };
});
console.log(`gbufKeys ${JSON.stringify(gbufKeys)}`);

// try common paths
for (const p of ["_giGbuffer.position", "_giGbuffer.normal", "_giTargets.irradiance", "_giTargets.emitterShadow", "_giTargets.shadow"]) {
  console.log(`tex[${p}] ${JSON.stringify(await readTex(p))}`);
}

// 3. full srcProbes profile (cascade live counts in THIS boot)
const prof = await page.evaluate(async () => {
  try {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 8 });
    return { cascades: r.srcProbes?.cascades, shadedHits: r.srcProbes?.shadedHitsPerFrame, reanchors: r.srcProbes?.reanchors, spacing0: r.srcProbes?.spacing0 };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; }
});
console.log(`srcProbes ${JSON.stringify(prof)}`);
await browser.close();
