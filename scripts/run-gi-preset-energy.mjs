// ONE-OFF (2026-08-14, §12.68 PRESET ENERGY): user report — medium preset is
// "too dark in most places" on Sponza (deep arches near-black, sun-lit areas
// fine), "low has the same problem doubled"; ultra/high look correct. GI-only
// regions getting systematically DARKER at lower presets is an energy bug.
// One boot per preset at the §12.66 known-good working pose (copied from
// run-blackframe-verify.mjs). Captures: (a) page screenshot, (b) beauty-frame
// luminance percentiles + an 8×6 region grid via onPostRender canvas readback,
// (c) _giTargets.irradiance mean/percentiles via a PRIMED compute readback
// (first dispatch of a fresh kernel is silently skipped — prime, wait
// __giPendingComputePipelines quiet, re-dispatch, then read), (d) the resolved
// GI config + every [gi] boot line. Delete with the §12.68 dossier.
//
// Usage: node scripts/run-gi-preset-energy.mjs <low|medium|high|ultra> [url]
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const TIER = process.argv[2];
if (!["low", "medium", "high", "ultra"].includes(TIER)) {
  console.log("FATAL: pass a tier: low | medium | high | ultra");
  process.exit(1);
}
const url = process.argv[3] ?? "http://localhost:5201/";
// Extra pre-boot globals for single-knob A/B arms, e.g.
//   ABGLOBALS='{"__giRayHitMode":"hybrid-exact-complex"}' ABLABEL=medium-exact
const AB = process.env.ABGLOBALS ? JSON.parse(process.env.ABGLOBALS) : null;
const LABEL = process.env.ABLABEL ?? TIER;
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
// The §12.66 RESOLVED working pose — a pose-less fresh boot frames a dark
// corner and reads black legitimately. Same numbers as run-blackframe-verify.
const POSE = { position: [-5.6912, 2.7603, -0.5013], target: [0.4232, 3.4681, -1.0221] };
const OUT = ".gi-shots/preset-energy";
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
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) giLines.push(t.slice(0, 400));
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404|structures must have at least one member|selectionOutlineMask|previous error|Invalid ShaderModule/.test(t)) {
    console.log(`  console.error: ${t.slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));
// The preset is forced through the ONE measurement hatch, set before boot.
// `quality` steers every tier-keyed table (qualityTierOf / srcQualityTier read
// config.quality); resolveScale/exactReflections are BY_TIER values that the
// settled object would otherwise carry from the SAVED scene's tier, so they
// are forced alongside to match giConfig.js's BY_TIER exactly.
await page.evaluateOnNewDocument((project, tier, ab) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = {
    quality: tier,
    resolveScale: tier === "ultra" ? 1 : 0.5,
    exactReflections: tier === "ultra",
  };
  if (ab) Object.assign(globalThis, ab);
}, PROJECT, TIER, AB);
console.log(`opening ${PROJECT} … (forced quality=${TIER}${AB ? `, AB ${JSON.stringify(AB)}` : ""})`);
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
await wait(8000);

const setPose = await page.evaluate(async (pose) => {
  try {
    await globalThis.__editorApi.call("viewport.setCamera", pose);
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).slice(0, 150) }; }
}, POSE);
console.log(`setCamera ${JSON.stringify(setPose)}`);
// GI convergence window at the lit pose. Longer than verify's 15 s: the low
// tier's 32k-ray ceiling refreshes the field ~8× slower than ultra's.
await wait(30000);

// ── (d) the resolved config, live ─────────────────────────────────────────
const cfg = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const c = sys?.config ?? {};
  const irr = sys?._giTargets?.irradiance;
  return {
    quality: c.quality, resolveScale: c.resolveScale, exactReflections: c.exactReflections,
    intensity: c.intensity, emissiveShadows: c.emissiveShadows,
    transport: globalThis.__giSrcTransport ?? null,
    irradianceSize: irr ? [irr.image?.width ?? irr.width, irr.image?.height ?? irr.height] : null,
    envSet: !!engine.scene.environment,
    envIntensity: engine.scene.environmentIntensity ?? null,
  };
});
console.log(`config ${JSON.stringify(cfg)}`);

// ── (b) beauty-frame luminance: percentiles + 8×6 grid, 5-frame average ───
const frameStats = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const GX = 8, GY = 6, N = 5;
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
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const grid = new Float64Array(GX * GY);
      const gridN = new Float64Array(GX * GY);
      const samples = [];
      let sum = 0, count = 0, black = 0;
      // stride 2 px in each axis → ~157k samples
      for (let y = 0; y < c.height; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          const i = (y * c.width + x) * 4;
          const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          sum += lum; count++;
          if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
          if (((x >> 1) & 3) === 0 && ((y >> 1) & 3) === 0) samples.push(lum);
          const g = Math.min(GY - 1, (y * GY / c.height) | 0) * GX + Math.min(GX - 1, (x * GX / c.width) | 0);
          grid[g] += lum; gridN[g]++;
        }
      }
      samples.sort((a, b) => a - b);
      const pct = (p) => samples[Math.min(samples.length - 1, (p * samples.length) | 0)];
      resolve({
        mean: sum / count,
        blackFrac: black / count,
        p05: pct(0.05), p10: pct(0.10), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p95: pct(0.95),
        grid: [...grid].map((v, i) => v / Math.max(1, gridN[i])),
      });
    });
  });
  const acc = null;
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await one());
  const avg = { mean: 0, blackFrac: 0, p05: 0, p10: 0, p25: 0, p50: 0, p75: 0, p95: 0, grid: new Array(GX * GY).fill(0) };
  for (const r of runs) {
    for (const k of ["mean", "blackFrac", "p05", "p10", "p25", "p50", "p75", "p95"]) avg[k] += r[k] / N;
    r.grid.forEach((v, i) => { avg.grid[i] += v / N; });
  }
  for (const k of ["mean", "blackFrac", "p05", "p10", "p25", "p50", "p75", "p95"]) avg[k] = +avg[k].toFixed(4);
  avg.grid = avg.grid.map((v) => +v.toFixed(4));
  return avg;
});
console.log(`frame ${JSON.stringify(frameStats)}`);

// ── (c) irradiance texture stats via PRIMED compute readback ──────────────
const irrStats = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const renderer = engine.renderer;
  const sys = engine.modules?.get?.("gi")?.system;
  const tex = sys?._giTargets?.irradiance;
  if (!tex) return { error: "no irradiance target" };
  const W = tex.image?.width ?? tex.width, H = tex.image?.height ?? tex.height;
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint, vec3, dot } = TSL;
  const N = 96;
  const buf = instancedArray(new Float32Array(N * N), "float");
  const node = texture(tex);
  const sx = Math.max(1, Math.floor(W / N)), sy = Math.max(1, Math.floor(H / N));
  const copy = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(sx));
    const py = instanceIndex.div(uint(N)).mul(uint(sy));
    const texel = node.load(ivec2(px.toInt(), py.toInt()));
    buf.element(instanceIndex).assign(dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722)));
  })().compute(N * N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // Primed-read discipline (§12.65.1 instrument artifact): dispatch, wait
  // quiet, dispatch again, then read.
  renderer.compute(copy);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  renderer.compute(copy);
  const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value));
  const vals = [...a].sort((x, y) => x - y);
  let sum = 0, dark = 0;
  for (const v of a) { sum += v; if (v < 0.01) dark++; }
  const pct = (p) => vals[Math.min(vals.length - 1, (p * vals.length) | 0)];
  return {
    size: [W, H],
    mean: +(sum / a.length).toFixed(5),
    darkFrac001: +(dark / a.length).toFixed(4),
    p05: +pct(0.05).toFixed(5), p10: +pct(0.10).toFixed(5), p25: +pct(0.25).toFixed(5),
    p50: +pct(0.50).toFixed(5), p75: +pct(0.75).toFixed(5), p95: +pct(0.95).toFixed(5),
    max: +vals[vals.length - 1].toFixed(4),
  };
});
console.log(`irradiance ${JSON.stringify(irrStats)}`);

// ── SRC transport stats: hit rate, meanT, attribution — the mode's fingerprint
const srcStats = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const src = sys?.state?.screen?.srcProbes;
  if (!src?.readStats) return { error: "no srcProbes.readStats" };
  const s = await src.readStats(engine.renderer);
  const r = s.rays ?? {};
  return {
    totalRays: s.totalRays ?? null,
    rays: r.rays, hits: r.hits, hitRate: +(r.hitRate ?? 0).toFixed(4),
    perRay: +(r.perRay ?? 0).toFixed(3),
    meanT: +(r.meanT ?? 0).toFixed(4), maxT: +(r.maxT ?? 0).toFixed(3),
    shaded: r.shaded, unattributed: r.unattributed,
    unattributedRate: +(r.unattributedRate ?? 0).toFixed(4),
    shadowRays: r.shadowRays, emissiveHits: r.emissiveHits,
    deposits: r.deposits, clamped: r.clamped, noBlock: r.noBlock,
    secondaryHits: r.secondaryHits,
    merge: s.merge ? {
      resolvedRate: +(s.merge.resolvedRate ?? 0).toFixed(3),
      orphanRate: +(s.merge.orphanRate ?? 0).toFixed(3),
      meanCorners: +(s.merge.meanCorners ?? 0).toFixed(2),
    } : null,
    gather: s.gather ? {
      lit: s.gather.lit, pixels: s.gather.pixels, empty: s.gather.empty,
      meanLum: +(s.gather.meanLum ?? 0).toFixed(4),
    } : null,
  };
});
console.log(`srcStats ${JSON.stringify(srcStats)}`);

// ── (a) the page screenshot ───────────────────────────────────────────────
await page.screenshot({ path: `${OUT}/${LABEL}.png` });
await writeFile(`${OUT}/${LABEL}.json`, JSON.stringify({ tier: TIER, label: LABEL, ab: AB, cfg, frameStats, irrStats, srcStats, giLines }, null, 1));
console.log(`[gi] boot lines:\n  ${giLines.join("\n  ")}`);
console.log(`DONE ${LABEL} → ${OUT}/${LABEL}.png + ${OUT}/${LABEL}.json`);
await browser.close();
process.exit(0);
