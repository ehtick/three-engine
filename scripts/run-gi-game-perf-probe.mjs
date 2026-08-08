// GAME-SCENE PERF PROBE (session 38) — where the frame goes when the user's
// micro game (Sponza + crate pyramid + BallLauncher) drops from 25 to 10-15
// fps under emissive cannonballs. Three phases, one run per arm:
//
//   A  editor idle          — the settled baseline (queue may sleep)
//   B  play + firing        — puppeteer clicks the canvas every 250ms; up to
//                             24 emissive rigidbody balls churn (the user's
//                             reported regime)
//   C  ceasefire            — 17s after the last shot (lifetime 15s) so every
//                             ball has despawned; does the frame recover?
//
// Each phase samples frame/render/compute medians + hitch tails, reads the GI
// module's own counters (emitters, adopted movers, shadow-oracle build state,
// occluder count, quiet-frames), and phases A/B also run `profile.giPasses`
// for the per-pass GPU breakdown. Console MeshBVH-deprecation lines are
// counted per phase — each one is an oracle BVH build on the main thread.
//
// Arms (ARM=):
//   default    everything as shipped
//   nooracle   __giMoverDirectShadow=false  (no CPU shadow rays, no BVH builds)
//   noskip     __giDiffuseSkipMovers=false  (no occluder loop in the gather,
//                                            which also starves the oracle)
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const ARM = process.env.ARM ?? "default";
const FRAMES = Number(process.env.FRAMES) || 300;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = {
  default: {},
  nooracle: { __giMoverDirectShadow: false },
  noskip: { __giDiffuseSkipMovers: false },
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
let waveDone = false;
let bvhBuilds = 0; // MeshBVH deprecation warnings = oracle builds
page.on("console", (m) => {
  const t = m.text();
  if (/maxLeafTris/.test(t)) bvhBuilds++;
  if (/\[gi\] built|compile wave: materials|bright emitters|Holding slots|first frame after compile/.test(t)) {
    console.log(`  ${t.slice(0, 170)}`);
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
}, PROJECT, { ...(ARMS[ARM] ?? {}), ...JSON.parse(process.env.PRESET_GLOBALS ?? "{}") });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 120 && !built; i++) await wait(1000);
for (let i = 0; i < 200 && !waveDone; i++) await wait(1000);
await wait(10000);

/** In-page: sample N frames of wall/render/compute + read GI counters. */
const samplePhase = (frames) => page.evaluate(async (FRAMES) => {
  let engine = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    if (live?.engine?.renderer) { engine = live.engine; break; }
  }
  if (!engine) return { error: "no engine" };
  const r = engine.renderer;
  const sys = engine.modules?.get("gi")?.system;
  const samples = { render: [], compute: [], frame: [] };
  let last = performance.now();
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const now = performance.now();
      samples.frame.push(now - last);
      last = now;
      samples.render.push(r.info.render.timestamp ?? 0);
      samples.compute.push(r.info.compute.timestamp ?? 0);
      if (++n >= FRAMES) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const med = (a) => {
    const s = a.slice(Math.floor(a.length / 4)).filter((v) => v > 0).sort((x, y) => x - y);
    return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0;
  };
  const tail = samples.frame.slice(Math.floor(samples.frame.length / 4)).sort((a, b) => a - b);
  const at = (q) => (tail.length ? +tail[Math.min(tail.length - 1, Math.floor(tail.length * q))].toFixed(1) : 0);
  const o = sys?._moverShadowOracle;
  return {
    frameMsMedian: med(samples.frame),
    fps: med(samples.frame) ? +(1000 / med(samples.frame)).toFixed(1) : 0,
    renderMsMedian: med(samples.render),
    computeMsMedian: med(samples.compute),
    frameMsP95: at(0.95),
    frameMsP99: at(0.99),
    frameMsMax: at(1),
    emitters: sys?._emitterInfos?.length ?? 0,
    adoptedMovers: sys?._dynSet?.count?.() ?? -1,
    occluderSlots: sys?._moverOccluders?.count?.value ?? 0,
    oracle: o ? { ready: o.ready?.length ?? 0, pending: o.queue?.length ?? 0 } : null,
    quietFrames: sys?._fieldQuietFrames ?? -1,
  };
}, frames);

const giPasses = async () => {
  try {
    return await page.evaluate(() => globalThis.__editorApi.call("profile.giPasses", { samples: 24 }));
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
};

// ---- phase A: editor idle ---------------------------------------------------
const bvhA = bvhBuilds;
const idle = await samplePhase(FRAMES);
const idlePasses = await giPasses();
console.log(`\n== ARM=${ARM} phase A (editor idle) — oracle builds so far: ${bvhA} ==`);
console.log(JSON.stringify(idle, null, 2));

// ---- phase B: play + sustained fire ----------------------------------------
await page.evaluate(() => globalThis.__editorApi.call("play.set", { playing: true }));
await wait(8000); // play-entry recompiles settle

// The canvas rect, for clicks that land inside the render surface.
const rect = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")].sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0];
  const r = c?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
});
if (!rect) {
  console.log("no canvas rect — cannot fire");
  await browser.close();
  process.exit(1);
}
let firing = true;
const clickLoop = (async () => {
  let i = 0;
  while (firing) {
    // Spread shots across the middle of the view so balls scatter through the
    // crate region instead of stacking on one spot.
    const fx = rect.x + rect.w * (0.35 + 0.3 * ((i * 0.37) % 1));
    const fy = rect.y + rect.h * (0.45 + 0.2 * ((i * 0.53) % 1));
    try { await page.mouse.click(fx, fy); } catch { /* page busy */ }
    i++;
    await wait(250);
  }
})();
await wait(7000); // build up toward the 24-ball cap before sampling
const bvhBeforeB = bvhBuilds;
const fire = await samplePhase(FRAMES);
const firePasses = await giPasses();
firing = false;
await clickLoop;
console.log(`\n== ARM=${ARM} phase B (play, sustained fire) — oracle builds during: ${bvhBuilds - bvhBeforeB} ==`);
console.log(JSON.stringify(fire, null, 2));

// ---- phase C: ceasefire ------------------------------------------------------
await wait(17000); // lifetime 15s — every ball despawns
const calm = await samplePhase(FRAMES);
console.log(`\n== ARM=${ARM} phase C (ceasefire, balls despawned) ==`);
console.log(JSON.stringify(calm, null, 2));

console.log(`\n== ARM=${ARM} giPasses (A idle) ==`);
console.log(JSON.stringify(idlePasses, null, 2));
console.log(`\n== ARM=${ARM} giPasses (B fire) ==`);
console.log(JSON.stringify(firePasses, null, 2));
console.log(`\ntotal oracle BVH builds: ${bvhBuilds}`);
await browser.close();
