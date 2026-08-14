// ONE-OFF (2026-08-14, §12.66): the resolve writes ~black while emitter seat
// (rgb=10) and emitter-shadow (~1.0 = clear) are healthy — every resolve term
// sits inside `If(gbuffer.position.w > 0.5)`. This boot reads the ACTUAL
// gbuffer (state.screen.gbuffer) coverage and the SRC screenGather texture —
// the two remaining stage boundaries. Delete with the fix.
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

const readTexExpr = (label, expr) => page.evaluate(async (lbl, exprSrc) => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  let tex = null;
  try { tex = new Function("sys", "engine", `return (${exprSrc})`)(sys, engine); } catch (e) { return { label: lbl, error: String(e).slice(0, 120) }; }
  if (!tex?.isTexture) return { label: lbl, error: "not a texture", type: tex?.constructor?.name ?? String(tex) };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const W = tex.image?.width ?? 0, H = tex.image?.height ?? 0;
  if (!W) return { label: lbl, error: "no size" };
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
  let sum = 0, mx = -Infinity, wNZ = 0, wSum = 0;
  const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
    if (Number.isFinite(l)) { sum += l; if (l > mx) mx = l; }
    wSum += a[i + 3];
    if (a[i + 3] > 0.5) wNZ++;
  }
  return { label: lbl, size: [W, H], rgbMean: +(sum / count).toFixed(4), rgbMax: +mx.toFixed(3), wMean: +(wSum / count).toFixed(3), wCoverage: +(wNZ / count).toFixed(3) };
}, label, expr);

console.log(JSON.stringify(await readTexExpr("gbuffer.position", "sys.state.screen.gbuffer.position")));
console.log(JSON.stringify(await readTexExpr("gbuffer.normal", "sys.state.screen.gbuffer.normal")));
console.log(JSON.stringify(await readTexExpr("screenGather", "sys.state.screen.srcProbes?.gather?.node?.value ?? sys.state.screen.screenGather?.value")));
console.log(JSON.stringify(await readTexExpr("irradiance", "sys.state.screen.targets.irradiance")));

// extra state
const misc = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const s = sys.state;
  return {
    hasScreen: !!s.screen,
    resolveIntensity: s.screen?.resolveIntensity ?? sys.config?.intensity ?? null,
    configIntensity: sys.config?.intensity ?? null,
    gatherNodeSet: !!s.screen?.srcProbes?.gather?.node,
    screenGatherWired: !!s.screen?.screenGather,
    srcProbesAlive: !!s.screen?.srcProbes,
  };
});
console.log(`misc ${JSON.stringify(misc)}`);
await browser.close();
