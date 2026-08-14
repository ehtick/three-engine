// ONE-OFF (2026-08-14): the Sponza three-arm probe (run-gi-sponza-flicker)
// found the dominant flicker state is the POST-PAN RE-SETTLE — 2.45 rev/px/s
// vs 0.155 parked, with NOTHING armed: holds run at still-α AND the §12.61
// rest cadence's halved transport (its camera hold fades after ~1s, well
// before the re-settle finishes). This prices the three candidate causes with
// live hatches, all polled per frame, interleaved ×2 in ONE page:
//   base    — as shipped (replicates the 2.45)
//   norest  — __giSrcRestCadence=false        (full transport during holds)
//   alpha05 — __giSrcAlpha=0.05               (the pre-§12.60 still floor)
//   noseed  — __giSrcSeedRays=0               (fresh-probe seed disabled)
// Delete with the flicker investigation.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/sponza-panab";
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
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
const call = (op, args) => page.evaluate(
  async (o, a) => { try { return { ok: true, value: await globalThis.__editorApi.call(o, a) }; } catch (e) { return { ok: false, error: String(e) }; } },
  op, args,
);
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });
console.log("settling out the compile wave…");
await wait(30000);

// Same instrument as run-gi-sponza-flicker's measure(), pan-hold ×2 only.
// Flags are applied INSIDE, before warmup, and cleared by the caller after.
const SEG = Number(process.env.SEG) || 120;
const measure = (label, flags) => page.evaluate(async (lbl, f, segIn) => {
  const o = { seg: segIn };
  for (const [k, v] of Object.entries(f)) {
    if (v === null) delete globalThis[k]; else globalThis[k] = v;
  }
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const renderer = engine?.renderer;
  const targets = system?._giTargets;
  const size = system?._giTargetSize;
  if (!targets?.irradiance || !size) return { error: `no GI resolve targets (${lbl})` };
  const { width, height } = size;
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, If, float, instanceIndex, instancedArray, ivec2, select, texture, uniform, vec2, vec3, vec4 } = TSL;
  const stateBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const ampBuf = instancedArray(new Float32Array(width * height * 2), "vec2");
  const irrNode = texture(targets.irradiance);
  const widthU = uniform(width, "uint");
  const armed = uniform(0);
  const accumulator = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const prev = stateBuf.element(instanceIndex).toVar();
    const delta = lum.sub(prev.x).toVar();
    const threshold = float(0.002).max(prev.x.mul(0.01)).toVar();
    const moved = delta.abs().greaterThan(threshold).toVar();
    const outDelta = float(prev.y).toVar();
    const outRev = float(prev.z).toVar();
    const outChanged = float(prev.w).toVar();
    If(moved.and(armed.greaterThan(0.5)), () => {
      const flipped = delta.mul(prev.y).lessThan(0);
      outRev.assign(prev.z.add(select(flipped, float(1), float(0))));
      outDelta.assign(delta);
      outChanged.assign(prev.w.add(1));
      const amp = ampBuf.element(instanceIndex).toVar();
      ampBuf.element(instanceIndex).assign(vec2(amp.x.max(delta.abs()), amp.y.add(delta.abs())));
    });
    stateBuf.element(instanceIndex).assign(vec4(lum, outDelta, outRev, outChanged));
  })().compute(width * height);

  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const cam = await api.call("viewport.getCamera", {});
  const [tx, ty, tz] = cam.target;
  const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
  const setCam = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return api.call("viewport.setCamera", {
      position: [tx + dx * c - dz * s, cam.position[1], tz + dx * s + dz * c],
      target: [tx, ty, tz],
    });
  };
  let restMin = 1, restMax = 0, alphaMin = 1, alphaMax = 0;
  for (let i = 0; i < 30; i++) { await frame(); renderer.compute(accumulator); }
  const t0 = performance.now();
  const seg = o.seg ?? 120;
  for (let cyc = 0; cyc < 2; cyc++) {
    armed.value = 0;
    for (let i = 0; i < seg; i++) {
      await frame();
      await setCam(((cyc % 2 === 0 ? i + 1 : seg - 1 - i) / seg) * 0.35);
      renderer.compute(accumulator);
    }
    armed.value = 1;
    for (let i = 0; i < seg; i++) {
      await frame(); renderer.compute(accumulator);
      const r = globalThis.__giSrcRestFactorLive ?? 1;
      restMin = Math.min(restMin, r); restMax = Math.max(restMax, r);
      const a = globalThis.__giSrcAlphaLive ?? 0;
      alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a);
    }
  }
  await setCam(0);
  const seconds = (performance.now() - t0) / 1000;
  const state = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
  const amp = new Float32Array(await renderer.getArrayBufferAsync(ampBuf.value));
  let lit = 0, revSum = 0, changedSum = 0, changedPx = 0, ampTotSum = 0, hot = 0;
  for (let i = 0; i < width * height; i++) {
    const lum = state[i * 4];
    const rev = state[i * 4 + 2];
    const changed = state[i * 4 + 3];
    if (lum > 0.002) lit++;
    if (changed > 0) {
      changedPx++; changedSum += changed; revSum += rev;
      ampTotSum += amp[i * 2 + 1];
      if (rev / seconds > 5) hot++;
    }
  }
  const counted = seconds / 2;
  const seedStats = system.state?.screen?.srcProbes?.seed?.readStats
    ? await system.state.screen.srcProbes.seed.readStats(renderer) : null;
  return {
    label: lbl,
    revPerLitPxS: +(revSum / Math.max(1, lit) / Math.max(0.1, counted)).toFixed(3),
    churnPct: +((changedSum / Math.max(1, lit) / Math.max(0.1, counted * 60)) * 100).toFixed(2),
    hotPxPct: +((hot / Math.max(1, lit)) * 100).toFixed(2),
    meanStepAmp: +(ampTotSum / Math.max(1, changedSum)).toFixed(4),
    restHold: `${restMin.toFixed(2)}..${restMax.toFixed(2)}`,
    alphaHold: `${alphaMin.toFixed(3)}..${alphaMax.toFixed(3)}`,
    seed: seedStats ? `probes ${seedStats.SEED_PROBES ?? seedStats.probes ?? "?"} bins ${seedStats.SEED_BINS ?? seedStats.bins ?? "?"}` : "n/a",
  };
}, label, flags, SEG);

// §12.65 irradiance-temporal A/B: `filter` is the shipped default (motion-
// driven history weight), `nofilter` pins the weight to 0 — the pass still
// dispatches (same cost) but blends nothing, which isolates the EFFECT.
// (§12.63's settle-α arms live in git history; same file, same instrument.)
const ARMS = [
  ["filter", {}],
  ["nofilter", { __giIrrHistWeight: 0 }],
];
const CLEAR = { __giSrcRestCadence: null, __giSrcAlpha: null, __giSrcSeedRays: null, __giSrcCamSettleAlpha: null, __giIrrHistWeight: null };
const REPS = Number(process.env.REPS) || 3;
for (let rep = 0; rep < REPS; rep++) {
  for (const [name, flags] of ARMS) {
    const r = await measure(`${name}#${rep}`, { ...CLEAR, ...flags });
    console.log(JSON.stringify(r));
    await page.evaluate((c) => { for (const k of Object.keys(c)) delete globalThis[k]; }, CLEAR);
    await wait(1500); // settle between arms
  }
}
await browser.close();
