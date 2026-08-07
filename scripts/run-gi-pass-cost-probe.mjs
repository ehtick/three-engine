// GI PER-PASS GPU COST (session 33b) — where the user's 41.6ms actually goes.
//
// Aggregate `renderer.info.compute.timestamp` cannot answer "which pass".
// This dispatches EACH named GI pass K times in isolation and resolves the
// WebGPU timestamp queries around it, so every pass reports its own ms. That
// is the only honest input to a "throw away what is too slow" decision — the
// alternative is one editor boot per ablation arm and a guess in between.
//
// Run: node scripts/run-gi-pass-cost-probe.mjs
//      PRESET_GLOBALS='{"__giShadowStaticBvh":false}' ... for arm A/Bs
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const K = Number(process.env.K) || 40;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--window-size=2560,1440",
  ],
});
const page = await browser.newPage();
// BIG ON PURPOSE: headless defaults gave a 503x221 GI resolve — 15x smaller
// than the user's viewport — and per-pixel costs from that do not extrapolate.
await page.setViewport({ width: 2560, height: 1400, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
let waveDone = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|static shadow bvh|light shadows|compile wave: materials \d+ms|dynamic-objects/.test(t)) {
    console.log(`  ${t.slice(0, 190)}`);
  }
  if (/\[gi\] built/.test(t)) built = true;
  if (/compile wave: materials \d+ms/.test(t)) waveDone = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((PROJECT, G) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const [k, v] of Object.entries(G)) globalThis[k] = v;
  globalThis.__editorKeepRendering = true;
}, PROJECT, JSON.parse(process.env.PRESET_GLOBALS ?? "{}"));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 120 && !built; i++) await wait(1000);
for (let i = 0; i < 220 && !waveDone; i++) await wait(1000);
await wait(10000);

// OP=1 — exercise the shipped `profile.giPasses` editor op instead of the
// probe's inline copy. Same measurement, but through the path an agent (or
// the user) actually has: the op registry, and therefore the MCP server.
if (process.env.OP === "1") {
  const out = await page.evaluate(async () => {
    try { return { ok: true, value: await globalThis.__editorApi.call("profile.giPasses", { samples: 30 }) }; }
    catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(out.ok ? 0 : 1);
}

const report = await page.evaluate(async (K) => {
  let engine = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    if (live?.engine?.renderer) { engine = live.engine; break; }
  }
  if (!engine) return { error: "no engine" };
  const r = engine.renderer;
  const sys = engine.modules?.get("gi")?.system;
  const screen = sys?.state?.screen;
  if (!screen) return { error: "no gi screen" };
  if (!r.backend?.trackTimestamp) return { error: "adapter has no timestamp-query support" };

  // Freeze the editor's own loop so its GI dispatches do not land inside a
  // measurement window (the whole point is per-pass attribution).
  globalThis.__editorKeepRendering = false;
  engine.renderSuspended = true;
  await new Promise((res) => setTimeout(res, 500));

  const timeOne = async (compute, k) => {
    if (!compute) return null;
    try {
      r.compute(compute); // warm: pipeline + bind groups
      await r.resolveTimestampsAsync("compute");
      const before = r.info.compute.timestamp ?? 0;
      for (let i = 0; i < k; i++) r.compute(compute);
      await r.resolveTimestampsAsync("compute");
      const after = r.info.compute.timestamp ?? 0;
      return +((after - before) / k).toFixed(4);
    } catch (err) {
      return `error: ${String(err?.message ?? err).slice(0, 90)}`;
    }
  };

  const named = [
    ["lightShadowPass", screen.lightShadowPass?.compute],
    ["lightShadowFilterPass", screen.lightShadowFilterPass?.compute],
    ["lightShadowWidePass", screen.lightShadowWidePass?.compute],
    ["lightShadowWidePass2", screen.lightShadowWidePass2?.compute],
    ["lightShadowHistoryPass", screen.lightShadowHistoryPass?.compute],
    ["lightShadowPostPass", screen.lightShadowPostPass?.compute],
    ["emitterShadowPass", screen.emitterShadowPass?.compute],
    ["emitterShadowFilterPass", screen.emitterShadowFilterPass?.compute],
    ["resolve", screen.resolve?.compute ?? screen.resolve],
  ];
  const passes = {};
  for (const [name, compute] of named) {
    if (!compute) { passes[name] = "absent"; continue; }
    passes[name] = await timeOne(compute, K);
  }

  // The rest of the GI frame queue (cascades, occupancy, composite) by index —
  // named passes above are the screen chain only.
  const queue = sys.state.queue ?? [];
  const queueMs = [];
  for (let i = 0; i < queue.length; i++) queueMs.push(await timeOne(queue[i], Math.max(8, K >> 2)));

  globalThis.__editorKeepRendering = true;
  engine.renderSuspended = false;
  const sum = Object.values(passes).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);
  return {
    resolveSize: [screen.width, screen.height],
    shadowSize: [screen.shadowWidth, screen.shadowHeight],
    emitterShadowSize: [screen.emitterShadowWidth, screen.emitterShadowHeight],
    marcher: screen.lightShadow?.marcher ?? null,
    adoptedMovers: sys._dynSet?.count?.() ?? -1,
    passes,
    screenChainTotalMs: +sum.toFixed(3),
    queueLength: queue.length,
    queueMs,
    queueTotalMs: +queueMs.filter((v) => typeof v === "number").reduce((a, b) => a + b, 0).toFixed(3),
  };
}, K);

console.log(JSON.stringify(report, null, 2));

// MOVERSWEEP=1 — the marginal cost of an adopted mover. Every mover is tested
// by EVERY ray in a linear loop (OBB slab test, then a per-object BVH8
// descent), so this measures the slope that decides whether the mover set
// needs a top-level BVH. Pins N meshes to GI Mobility "dynamic" through the
// real editor op and re-times the shadow trace at each step.
if (process.env.MOVERSWEEP === "1") {
  console.log("\n  mover sweep (lightShadowPass ms vs adopted movers):");
  const steps = [2, 4, 8, 16];
  let pinned = 0;
  for (const target of steps) {
    const res = await page.evaluate(async ({ target, pinned, K }) => {
      const list = await globalThis.__editorApi.call("entity.list", {});
      const meshEnts = (list ?? []).filter((e) => (e.components ?? []).some((c) => c.type === "mesh"));
      for (let i = pinned; i < Math.min(target, meshEnts.length); i++) {
        await globalThis.__editorApi.call("component.setProp", {
          id: meshEnts[i].id, type: "mesh", key: "giMobility", value: "dynamic",
        });
      }
      // Adoption runs on the GI tick; give it real frames, not a timer.
      await new Promise((res2) => setTimeout(res2, 9000));
      let engine = null;
      for (const e of list ?? []) {
        const live = globalThis.__editorApi.entities.live(e.id);
        if (live?.engine?.renderer) { engine = live.engine; break; }
      }
      const r = engine.renderer;
      const sys = engine.modules?.get("gi")?.system;
      const compute = sys?.state?.screen?.lightShadowPass?.compute;
      if (!compute) return { error: "no shadow pass" };
      globalThis.__editorKeepRendering = false;
      engine.renderSuspended = true;
      await new Promise((res2) => setTimeout(res2, 400));
      r.compute(compute);
      await r.resolveTimestampsAsync("compute");
      const before = r.info.compute.timestamp ?? 0;
      for (let i = 0; i < K; i++) r.compute(compute);
      await r.resolveTimestampsAsync("compute");
      const after = r.info.compute.timestamp ?? 0;
      globalThis.__editorKeepRendering = true;
      engine.renderSuspended = false;
      return {
        adopted: sys._dynSet?.count?.() ?? -1,
        poolWords: sys._dynSet?.stats?.poolWordsUsed ?? -1,
        overflow: sys._dynSet?.stats?.overflowRejected ?? -1,
        shadowMs: +((after - before) / K).toFixed(4),
      };
    }, { target, pinned, K });
    pinned = target;
    console.log(`    pinned=${target} → ${JSON.stringify(res)}`);
  }
}
await browser.close();
