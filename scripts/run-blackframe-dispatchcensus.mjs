// ONE-OFF (2026-08-14, §12.66): emitter+light shadow chains' textures are
// ALL-ZERO including raw, though the passes sit in state.queue and the skip
// census reads clean. This boot (1) wraps renderer.compute for 60 frames and
// counts WHICH compute nodes the GI tick actually dispatches, and (2)
// manually primes+dispatches the emitter chain then the resolve, reading
// each texture — kernel-broken vs dispatch-dropped. Delete with the fix.
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

// 1. dispatch census over 60 frames
const census = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const s = sys.state.screen;
  const known = new Map();
  const tag = (node, name) => { if (node) known.set(node, name); };
  tag(s.emitterShadowPass?.compute, "emitterShadowPass");
  tag(s.emitterShadowFilterPass?.compute, "emitterFilter");
  tag(s.emitterShadowWidePass?.compute, "emitterWide");
  tag(s.emitterShadowWidePass2?.compute, "emitterWide2");
  tag(s.lightShadowPass?.compute, "lightShadowPass");
  tag(s.resolve?.compute, "resolve");
  const counts = {};
  let frames = 0, otherComputes = 0;
  const renderer = engine.renderer;
  const orig = renderer.compute.bind(renderer);
  renderer.compute = (nodes, ...rest) => {
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    for (const n of arr) {
      const name = known.get(n);
      if (name) counts[name] = (counts[name] ?? 0) + 1;
      else otherComputes++;
    }
    return orig(nodes, ...rest);
  };
  await new Promise((resolve) => {
    const off = engine.onPostRender(() => { if (++frames >= 60) { off(); resolve(); } });
  });
  renderer.compute = orig;
  return { frames, counts, otherComputes, emitterInfosLen: sys._emitterInfos?.length ?? null };
});
console.log(`dispatch census ${JSON.stringify(census)}`);

// 2. manual chain drive + reads
const manual = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const s = sys.state.screen;
  const renderer = engine.renderer;
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec4 } = TSL;
  const readTex = async (tex) => {
    const W = tex.image.width, H = tex.image.height;
    const N = 32;
    const buf = instancedArray(new Float32Array(N * N * 4), "vec4");
    const node = texture(tex);
    const sx = Math.max(1, Math.floor(W / N)), sy = Math.max(1, Math.floor(H / N));
    const kernel = Fn(() => {
      const px = instanceIndex.mod(uint(N)).mul(uint(sx));
      const py = instanceIndex.div(uint(N)).mul(uint(sy));
      buf.element(instanceIndex).assign(vec4(node.load(ivec2(px.toInt(), py.toInt()))));
    })().compute(N * N);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    renderer.compute(kernel);
    for (let i = 0; i < 200; i++) {
      if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
      await frame();
    }
    await frame();
    renderer.compute(kernel);
    const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value));
    let xs = 0, xmx = -Infinity;
    const count = a.length / 4;
    for (let i = 0; i < a.length; i += 4) { xs += a[i]; if (a[i] > xmx) xmx = a[i]; }
    return { xMean: +(xs / count).toFixed(4), xMax: +xmx.toFixed(3) };
  };
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const drive = async (node) => {
    renderer.compute(node);
    for (let i = 0; i < 300; i++) {
      if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
      await frame();
    }
    await frame();
    renderer.compute(node);
    await frame();
  };
  const out = {};
  await drive(s.emitterShadowPass.compute);
  out.rawAfterManualPass = await readTex(sys.state.screen.targets.emitterShadowRaw);
  await drive(s.emitterShadowFilterPass.compute);
  if (s.emitterShadowWidePass) { await drive(s.emitterShadowWidePass.compute); await drive(s.emitterShadowWidePass2.compute); }
  out.finalAfterManualChain = await readTex(sys.state.screen.targets.emitterShadow);
  await drive(s.resolve.compute);
  out.irradianceAfterManualResolve = await readTex(sys.state.screen.targets.irradiance);
  return out;
});
console.log(`manual ${JSON.stringify(manual)}`);

const frameAfter = await page.evaluate(async () => {
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
      let black = 0, lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve({ blackFrac: +(black / (d.length / 4)).toFixed(4), meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4) });
    });
  });
});
console.log(`frame after manual drive ${JSON.stringify(frameAfter)}`);
await browser.close();
