// §12.77 UNIT A — IS THE SRC CHAIN'S COST PROPORTIONAL TO THE POOL OR TO THE
// LIVE PROBES? One fresh boot of the REAL project per arm at the §12.66 working
// pose, reading (a) `profile.giPasses` per-pass GPU timestamps, (b) the store's
// own layout (per-cascade capacity vs live, megabytes), (c) the STARVATION
// counters — `noBlock`, `failedInserts`, `clamped` — which are what a too-small
// pool says instead of producing an unexplained dark patch, and (d) a beauty
// luminance gate, because "cheaper" is only interesting if the image is the same.
//
// The passes under test are RESOLUTION-INDEPENDENT by construction (they are
// sized from probeCapacity / hashCapacity / blockCapacity / binTotal), which is
// what makes a cross-boot comparison legitimate here even though the editor's
// viewport panel settles to different heights across loads — the resolve dims
// are printed so a reader can check that the per-pixel passes moved and the
// capacity passes did not.
//
// Usage:
//   node scripts/run-gi-poolsize.mjs <low|medium|high|ultra> [url]
//   ABGLOBALS='{"__giSrcBinBudget":175000}' ABLABEL=ultra-bin175k node scripts/run-gi-poolsize.mjs ultra
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const TIER = process.argv[2] ?? "ultra";
if (!["low", "medium", "high", "ultra"].includes(TIER)) {
  console.log("FATAL: pass a tier: low | medium | high | ultra");
  process.exit(1);
}
const url = process.argv[3] ?? "http://localhost:5201/";
const AB = process.env.ABGLOBALS ? JSON.parse(process.env.ABGLOBALS) : null;
const LABEL = process.env.ABLABEL ?? `${TIER}-control`;
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-5.6912, 2.7603, -0.5013], target: [0.4232, 3.4681, -1.0221] };
const OUT = ".gi-shots/poolsize";
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
console.log(`opening ${PROJECT} … (quality=${TIER}${AB ? `, AB ${JSON.stringify(AB)}` : ""})`);
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
  try { await globalThis.__editorApi.call("viewport.setCamera", pose); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e?.message ?? e).slice(0, 150) }; }
}, POSE);
console.log(`setCamera ${JSON.stringify(setPose)}`);
// Convergence at the lit pose, then a REST window: the §12.61 rest cadence
// halves the transport ceiling after ~600 ms of camera stillness, so measuring
// before it engages prices a state the user never sits in.
await wait(30000);

// ── the store's own layout, and how much of it is live ────────────────────
const layout = await page.evaluate(() => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const c = sys?.config ?? {};
  return {
    quality: c.quality, resolveScale: c.resolveScale, exactReflections: c.exactReflections,
    binBudgetHatch: globalThis.__giSrcBinBudget ?? null,
    c0ProbesHatch: globalThis.__giSrcC0Probes ?? null,
  };
});
console.log(`config ${JSON.stringify(layout)}`);

// ── beauty luminance: the IMAGE gate. Cheaper only counts if it looks the same.
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
      const grid = new Float64Array(GX * GY), gridN = new Float64Array(GX * GY);
      const samples = [];
      let sum = 0, count = 0, black = 0;
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
        mean: sum / count, blackFrac: black / count,
        p05: pct(0.05), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p95: pct(0.95),
        grid: [...grid].map((v, i) => v / Math.max(1, gridN[i])),
      });
    });
  });
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await one());
  const avg = { mean: 0, blackFrac: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, grid: new Array(GX * GY).fill(0) };
  for (const r of runs) {
    for (const k of ["mean", "blackFrac", "p05", "p25", "p50", "p75", "p95"]) avg[k] += r[k] / N;
    r.grid.forEach((v, i) => { avg.grid[i] += v / N; });
  }
  for (const k of ["mean", "blackFrac", "p05", "p25", "p50", "p75", "p95"]) avg[k] = +avg[k].toFixed(4);
  avg.grid = avg.grid.map((v) => +v.toFixed(4));
  return avg;
});
console.log(`frame ${JSON.stringify({ ...frameStats, grid: undefined })}`);

// ── THE STARVATION GATE. A pool too small says so here, not in the picture. ──
const srcStats = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const src = engine.modules?.get?.("gi")?.system?.state?.screen?.srcProbes;
  if (!src?.readStats) return { error: "no srcProbes.readStats" };
  const s = await src.readStats(engine.renderer);
  const r = s.rays ?? {};
  return {
    rays: r.rays, hits: r.hits, hitRate: +(r.hitRate ?? 0).toFixed(4),
    meanT: +(r.meanT ?? 0).toFixed(4),
    shaded: r.shaded, unattributedRate: +(r.unattributedRate ?? 0).toFixed(4),
    deposits: r.deposits, clamped: r.clamped, noBlock: r.noBlock,
    secondaryHits: r.secondaryHits,
    merge: s.merge ? { resolvedRate: +(s.merge.resolvedRate ?? 0).toFixed(3), orphanRate: +(s.merge.orphanRate ?? 0).toFixed(3) } : null,
    gather: s.gather ? { lit: s.gather.lit, pixels: s.gather.pixels, empty: s.gather.empty, meanLum: +(s.gather.meanLum ?? 0).toFixed(4) } : null,
  };
});
console.log(`srcStats ${JSON.stringify(srcStats)}`);

// ── the screenshot BEFORE giPasses: it suspends rendering to measure ──────
await page.screenshot({ path: `${OUT}/${LABEL}.png` });

// ── (a) per-pass GPU timestamps. Twice; the second is the warm one. ───────
let passes = null;
for (let i = 0; i < 2; i++) {
  passes = await page.evaluate(async () => {
    try { return await globalThis.__editorApi.call("profile.giPasses", { samples: 60 }); }
    catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; }
  });
  if (i === 0) await wait(4000);
}
const g = passes?.srcProbes?.groupMs ?? {};
// The split this whole section turns on: which passes are sized from the LIVE
// set and which from the ALLOCATION.
const CAPACITY_GROUPS = ["deposit (decay)", "populate", "tiles", "deposit (resolve)", "merge", "rays", "seed (fresh-probe prior)", "hashBlock"];
const LIVE_GROUPS = ["gather", "deposit (trace + attribute)", "shade + bounce [J]", "surfaces (attribution palette)"];
const sumOf = (keys) => +keys.reduce((a, k) => a + (g[k]?.ms ?? 0), 0).toFixed(3);
const capacityMs = sumOf(CAPACITY_GROUPS);
const liveMs = sumOf(LIVE_GROUPS);
// GI total counts `resolve` ONCE — it is printed in screenPassesMs AND queueMs.
const queue = passes?.queueMs ?? {};
const num = (v) => (typeof v === "number" ? v : 0);
const giTotal = +((passes?.srcProbes?.totalMs ?? 0) + num(queue.resolve) + num(queue.irrTemporalPass) + num(queue.irrHistoryPass)).toFixed(3);

const summary = {
  label: LABEL, tier: TIER, ab: AB,
  resolvePx: passes?.pixels?.resolve, drawingBuffer: passes?.pixels?.drawingBuffer,
  megabytes: passes?.srcProbes?.megabytes,
  cascades: (passes?.srcProbes?.cascades ?? []).map((c) => ({
    c: c.cascade, live: c.live, cap: c.capacity, load: c.loadFactor, failedInserts: c.failedInserts,
  })),
  srcProbesTotalMs: passes?.srcProbes?.totalMs,
  capacityMs, liveMs, giTotal,
  groups: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.ms])),
  raysPerFrame: passes?.srcProbes?.raysPerFrame,
  noBlock: srcStats.noBlock, clamped: srcStats.clamped,
  meanLum: srcStats.gather?.meanLum, frameMean: frameStats.mean, blackFrac: frameStats.blackFrac,
};
console.log("\n──────── ARM SUMMARY ────────");
console.log(JSON.stringify(summary, null, 1));
console.log(`\nSTARVATION: noBlock=${srcStats.noBlock} clamped=${srcStats.clamped} failedInserts=${JSON.stringify(summary.cascades.map((c) => c.failedInserts))}`);
console.log(`CAPACITY-proportional ${capacityMs} ms | LIVE-proportional ${liveMs} ms | GI total ${giTotal} ms`);

await writeFile(`${OUT}/${LABEL}.json`, JSON.stringify({ summary, layout, frameStats, srcStats, passes, giLines }, null, 1));
console.log(`DONE ${LABEL} → ${OUT}/${LABEL}.png + ${OUT}/${LABEL}.json`);
await browser.close();
process.exit(0);
