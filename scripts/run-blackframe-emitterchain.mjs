// ONE-OFF (2026-08-14, §12.66): the FINAL emitter-shadow texture is all-zero
// (fully occluded) in the settled black state — that alone kills the cube's
// screen pool; the at-hit NEE likely shares the cause. This boot reads every
// intermediate of the emitter chain clean (no profiler): raw, accum, mid,
// wide, dist, final — the first all-zero stage names the break. Delete with
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

const readTex = (label) => page.evaluate(async (lbl) => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const tex = sys?.state?.screen?.targets?.[lbl];
  if (!tex?.isTexture) return { label: lbl, missing: true };
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const W = tex.image.width, H = tex.image.height;
  const N = 40;
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
  const count = a.length / 4;
  let xs = 0, xmn = Infinity, xmx = -Infinity, ys = 0;
  for (let i = 0; i < a.length; i += 4) {
    xs += a[i]; if (a[i] < xmn) xmn = a[i]; if (a[i] > xmx) xmx = a[i];
    ys += a[i + 1];
  }
  return { label: lbl, size: [W, H], xMean: +(xs / count).toFixed(4), xMin: +xmn.toFixed(3), xMax: +xmx.toFixed(3), yMean: +(ys / count).toFixed(4) };
}, label);

const names = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const t = sys?.state?.screen?.targets ?? {};
  return Object.keys(t).filter((k) => typeof t[k] === "object" && t[k]?.isTexture);
});
console.log(`target textures: ${names.join(", ")}`);
for (const n of names.filter((n) => /emitter|lightShadow/i.test(n))) {
  console.log(JSON.stringify(await readTex(n)));
}
const passes = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const s = sys?.state?.screen ?? {};
  return {
    hasPass: !!s.emitterShadowPass, hasFilter: !!s.emitterShadowFilterPass,
    hasHistory: !!s.emitterShadowHistoryPass, hasPost: !!s.emitterShadowPostPass,
    hasWide: !!s.emitterShadowWidePass, hasWide2: !!s.emitterShadowWidePass2,
    inQueue: {
      pass: s.emitterShadowPass ? sys.state.queue.includes(s.emitterShadowPass.compute) : null,
      filter: s.emitterShadowFilterPass ? sys.state.queue.includes(s.emitterShadowFilterPass.compute) : null,
      wide: s.emitterShadowWidePass ? sys.state.queue.includes(s.emitterShadowWidePass.compute) : null,
      wide2: s.emitterShadowWidePass2 ? sys.state.queue.includes(s.emitterShadowWidePass2.compute) : null,
      post: s.emitterShadowPostPass ? sys.state.queue.includes(s.emitterShadowPostPass.compute) : null,
      history: s.emitterShadowHistoryPass ? sys.state.queue.includes(s.emitterShadowHistoryPass.compute) : null,
    },
    queueLen: sys.state.queue.length,
  };
});
console.log(`chain ${JSON.stringify(passes)}`);
await browser.close();
