// STATIC-SHADOW-BVH COST INSTRUMENT (session 33) — how much of the user's
// 35ms GPU frame the exact-triangle shadow arm actually costs, from the
// engine's REAL WebGPU timestamp queries (renderer.info.{render,compute}
// .timestamp), not from a pop count or a guess.
//
// Runs the real project and samples steady-state per-frame GPU time. Arms:
//   ARM=bvh     static BVH8 shadow rays (shipped)
//   ARM=voxel   __giShadowStaticBvh=false — the records/DDA marcher
//   ARM=noshadow  __giLightShadow=false-ish baseline (gi shadows off)
// Run both and diff. Extra globals via PRESET_GLOBALS='{"__x":true}'.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const ARM = process.env.ARM ?? "bvh";
const FRAMES = Number(process.env.FRAMES) || 240;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = {
  bvh: {},
  voxel: { __giShadowStaticBvh: false },
  sah: { __giStaticBvhStrategy: "sah" },
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|static shadow bvh|light shadows|compile wave: materials/.test(t)) console.log(`  ${t.slice(0, 190)}`);
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
  // The viewport must keep rendering while unfocused or every sample is a
  // paused frame — the unfocused pause is on by default and headless is never
  // focused.
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
// Headless cold-cache compile waves run 30-100s (session-15 trap) — sampling
// inside one measures the compiler, not the frame.
for (let i = 0; i < 200 && !waveDone; i++) await wait(1000);
await wait(10000);

const stats = await page.evaluate(async (FRAMES, SPIN) => {
  let engine = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    if (live?.engine?.renderer) { engine = live.engine; break; }
  }
  if (!engine) return { error: "no engine" };
  // SPIN — the user's rotating cube, harness-driven (the scene's own script
  // may not be attached). Adoption/demotion churn is what makes the static
  // shadow BVH go stale, and its rebuild is the hitch suspect.
  if (SPIN) {
    const mover = (list ?? []).find((e) =>
      (e.components ?? []).some((c) => c.type === "mesh") && (e.components ?? []).some((c) => c.type === "script"));
    const o = mover ? globalThis.__editorApi.entities.live(mover.id)?.object3D : null;
    if (o) {
      let lastT = performance.now();
      const spin = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastT) / 1000);
        lastT = now;
        o.rotation.y += 0.6 * dt;
        o.rotation.x += 0.6 * dt;
        o.updateMatrixWorld(true);
        requestAnimationFrame(spin);
      };
      requestAnimationFrame(spin);
    }
  }
  const r = engine.renderer;
  const sys = engine.modules?.get("gi")?.system;
  const screen = sys?.state?.screen;
  const marcher = screen?.lightShadow?.marcher ?? null;
  const shadowRes = screen ? [screen.shadowWidth, screen.shadowHeight, screen.width, screen.height] : null;
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
  // Drop the first quarter (warm-up / pending uploads) and use the MEDIAN —
  // timestamp readbacks land asynchronously and a mean is hostage to zeros.
  const med = (a) => {
    const s = a.slice(Math.floor(a.length / 4)).filter((v) => v > 0).sort((x, y) => x - y);
    return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0;
  };
  const p90 = (a) => {
    const s = a.slice(Math.floor(a.length / 4)).filter((v) => v > 0).sort((x, y) => x - y);
    return s.length ? +s[Math.floor(s.length * 0.9)].toFixed(2) : 0;
  };
  const tail = samples.frame.slice(Math.floor(samples.frame.length / 4)).sort((a, b) => a - b);
  const at = (q) => (tail.length ? +tail[Math.min(tail.length - 1, Math.floor(tail.length * q))].toFixed(1) : 0);
  return {
    marcher,
    shadowRes,
    frames: samples.frame.length,
    renderMsMedian: med(samples.render),
    computeMsMedian: med(samples.compute),
    computeMsP90: p90(samples.compute),
    frameMsMedian: med(samples.frame),
    // HITCH TAIL — a 200-600ms synchronous BVH rebuild hides completely in a
    // median (and in the fps counter) but owns the p99.
    frameMsP95: at(0.95),
    frameMsP99: at(0.99),
    frameMsMax: at(1),
    framesOver100ms: tail.filter((v) => v > 100).length,
    staticBvhRebuilds: sys?._staticBvhRebuilds ?? 0,
    adoptedMovers: sys?._dynSet?.count?.() ?? -1,
    gpuMsMedian: +(med(samples.render) + med(samples.compute)).toFixed(2),
  };
}, FRAMES, process.env.SPIN === "1");

console.log(`\n  ARM=${ARM}`);
console.log(JSON.stringify(stats, null, 2));

// RETAG=1 — the second half of the A/B the user actually needs: flip every
// mesh to GI Mobility "static" through the real editor op (which is also an
// end-to-end test of the new prop), let the movers demote and the static
// shadow BVH rebuild, then re-measure. The delta is what the mobility/trace
// split buys a scene whose architecture was tagged as movers.
if (process.env.RETAG === "1") {
  const retagged = await page.evaluate(async () => {
    const list = await globalThis.__editorApi.call("entity.list", {});
    let n = 0;
    for (const e of list ?? []) {
      if (!(e.components ?? []).some((c) => c.type === "mesh")) continue;
      try {
        await globalThis.__editorApi.call("component.setProp", {
          id: e.id, type: "mesh", key: "giMobility", value: "static",
        });
        n++;
      } catch { /* entity without a live mesh yet */ }
    }
    return n;
  });
  console.log(`\n  retagged ${retagged} meshes to giMobility=static — settling`);
  await wait(20000);
  const after = await page.evaluate(async (FRAMES) => {
    let engine = null;
    const list = await globalThis.__editorApi.call("entity.list", {});
    for (const e of list ?? []) {
      const live = globalThis.__editorApi.entities.live(e.id);
      if (live?.engine?.renderer) { engine = live.engine; break; }
    }
    const r = engine.renderer;
    const sys = engine.modules?.get("gi")?.system;
    const frame = [], compute = [];
    let last = performance.now();
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        const now = performance.now();
        frame.push(now - last);
        last = now;
        compute.push(r.info.compute.timestamp ?? 0);
        if (++n >= FRAMES) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const med = (a) => {
      const s = a.slice(Math.floor(a.length / 4)).filter((v) => v > 0).sort((x, y) => x - y);
      return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0;
    };
    return {
      adoptedMovers: sys?._dynSet?.count?.() ?? -1,
      staticBvhRebuilds: sys?._staticBvhRebuilds ?? 0,
      computeMsMedian: med(compute),
      frameMsMedian: med(frame),
    };
  }, FRAMES);
  console.log("  after retag:");
  console.log(JSON.stringify(after, null, 2));
}
await browser.close();
