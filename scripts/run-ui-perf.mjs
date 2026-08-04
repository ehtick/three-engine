// UI PERFORMANCE INSTRUMENT + REGRESSION GUARD — what does one UI screen cost?
//
// It used to cost a doubled frame. `UiSystem.render()` issued a SECOND full
// `renderer.render(scene, camera)` per screen group — a whole extra scene
// traversal, render list, offscreen target and tone-mapping blit — no matter
// how few UI quads existed. Measured on Sponza at 1600x1000 dpr2: 3.70ms
// without UI, 8.13ms with one 150x36 panel. 2.20x.
//
// UI now draws inside the main scene pass (see engine/ui/UiSystem.js), so the
// headline number this harness defends is `render() calls/frame`: it must NOT
// change when a screen is added. If it does, the second pass is back.
//
// Boots the user's REAL project through the editor's own path (same recipe as
// run-gi-perf.mjs), CREATES a minimal screen (root uiscreen + one 150x36
// uiimage child — the "tiny UI component" of the original report), and
// measures three arms:
//
//   arm "ui-on"      as shipped
//   arm "no-layout"  UiSystem.update patched off (quads still draw)
//   arm "ui-hidden"  layout off AND the screen roots forced invisible — the
//                    genuinely UI-free baseline
//
//   A - C  = everything UI costs
//   B - C  = what drawing the quads costs
//   A - B  = what the per-frame layout walk costs
//
// THINGS THIS HARNESS LEARNED THE HARD WAY:
//   * rAF is vsync-locked without --disable-gpu-vsync/--disable-frame-rate-limit,
//     so every arm reads back ~16.6ms and the deltas are pure noise.
//   * The scene's own FPS Screen is saved with enabledInEditor/enabledInGame
//     false (the user switched it off — that WAS the bug report). Measuring it
//     measures nothing, hence the freshly created probe screen.
//   * renderer.info.render.frameCalls is NOT a reliable pass count here. The
//     harness wraps renderer.render itself and counts calls per frame.
//   * A time-boxed rAF loop can exit after ONE frame if the page is mid-stall
//     (GI build wave). Windows are frame-count-boxed and preceded by a
//     renderSuspended wait.
//   * "ui-hidden" forces `visible = false` EVERY frame rather than once: the
//     engine owns that flag and reconciles it, so a single write does not hold.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-ui-perf.mjs
//
// Env:
//   PROJECT=<path>     default C:/Users/Khudiiash/Documents/GAME
//   FRAMES=400         per-arm measurement window, in frames
//   REPEATS=3          interleaved passes (arms alternate to cancel drift)
//   DPR=2              deviceScaleFactor — the extra pass is fill-bound, so
//                      this is the knob that decides how bad it looks
//   VIEW=1600x1000     browser viewport
//   SCREENS=1          how many separate uiscreen roots to create (overlays
//                      each get their OWN pass, so 3 screens = 3 extra passes)
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const FRAMES = Number(process.env.FRAMES ?? 400);
const REPEATS = Number(process.env.REPEATS ?? 3);
const DPR = Number(process.env.DPR ?? 2);
const SCREENS = Number(process.env.SCREENS ?? 1);
const [VW, VH] = (process.env.VIEW ?? "1600x1000").split("x").map(Number);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-gpu-vsync", "--disable-frame-rate-limit",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: DPR });
await installTauriShim(page, {});

page.on("pageerror", (e) => console.log(`  pageerror: ${(e.stack ?? e.message).slice(0, 400)}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/favicon/.test(t)) console.log(`  console.error: ${t.slice(0, 300)}`);
});

await page.evaluateOnNewDocument((PROJECT) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT);

console.log(`Opening ${PROJECT} at ${VW}x${VH} dpr ${DPR} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
const clicked = await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  const btn = row?.querySelector(".hub-recent-open-btn");
  if (!btn) return null;
  btn.click();
  return row.getAttribute("title");
}, PROJECT);
if (!clicked) { console.log("FATAL: no recent-project row"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });
const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
if (!entities.length) { console.log("FATAL: scene never populated"); await browser.close(); process.exit(1); }
console.log(`  ${entities.length} entities`);

// A vite HMR full-reload (or any editor remount) drops __editorApi and every
// subsequent evaluate fails with "Cannot read properties of undefined". Guard
// each phase rather than losing a 5-minute run to it.
const ready = () => page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 120000 });

const settle = async (extraMs = 4000) => {
  await ready();
  for (let i = 0; i < 180; i++) {
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!suspended) break;
    await wait(1000);
  }
  await wait(extraMs);
};
await wait(15000);
await settle(4000);

// The "tiny UI component" of the bug report: a screen root and one small
// rounded panel. Created rather than reused because the scene's own FPS Screen
// is saved disabled.
const created = [];
for (let i = 0; i < SCREENS; i++) {
  const root = await must("entity.create", {
    name: `PerfProbe Screen ${i}`,
    components: [{ type: "uiscreen", props: { renderMode: "screen" } }],
  });
  await must("entity.create", {
    name: `PerfProbe Panel ${i}`,
    parentId: root.id,
    components: [
      { type: "uielement", props: { anchorMin: [0, 1], anchorMax: [0, 1], pivot: [0, 1], size: [150, 36] } },
      { type: "uiimage", props: { color: "#0b0d10", opacity: 0.65, cornerRadius: 8 } },
    ],
  });
  created.push(root.id);
}
console.log(`  created ${created.length} probe screen(s): ${created.join(", ")}`);
await settle(3000);

const probe = await page.evaluate((anchorId) => {
  // THE ONLY twin-proof engine accessor: a live Entity's `.engine`.
  const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
  const ui = eng?.uiSystem;
  const screens = [...(ui?.screens ?? [])];
  return {
    hasUi: !!ui,
    screens: screens.length,
    modes: screens.map((s) => s.mode),
    visible: screens.map((s) => s.entity?.object3D?.visible),
    playing: !!eng?.playing,
    dpr: eng?.renderer?.getPixelRatio?.() ?? null,
    canvas: eng?.renderer?.domElement ? [eng.renderer.domElement.width, eng.renderer.domElement.height] : null,
    toneMapping: eng?.renderer?.toneMapping ?? null,
  };
}, created[0]);
console.log(`  probe: ${JSON.stringify(probe)}`);

/**
 * One measurement arm. `mode` selects how much of the UI is alive:
 *   "on"        untouched
 *   "no-layout" update() no-op'd — the quads still draw
 *   "ui-hidden" layout off and the screen roots forced invisible each frame
 *
 * renderer.render is wrapped for the duration so `renderCalls` is a hard
 * measurement of pass count, not an inference from renderer.info.
 */
async function measure(tag, mode, frames) {
  await ready();
  const stats = await page.evaluate(async ({ frames, mode, anchorId }) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    if (!eng?.renderer) throw new Error("no live engine via entities.live");
    const ui = eng.uiSystem;
    if (!ui) throw new Error("no uiSystem on engine");

    delete ui.update;
    if (mode !== "on") ui.update = () => {};
    const hide = mode === "ui-hidden";
    const roots = [...ui.screens].map((s) => s.entity?.object3D).filter(Boolean);

    const renderer = eng.renderer;
    const realRender = renderer.render.bind(renderer);
    let calls = 0;
    renderer.render = (scene, camera) => { calls++; return realRender(scene, camera); };

    await new Promise((r) => setTimeout(r, 800));
    if (renderer.info?.render) renderer.info.render.timestamp = 0;

    const deltas = [];
    const gpuRender = [];
    const perFrameCalls = [];
    let last = performance.now();
    calls = 0;
    // WARMUP frames are discarded: the first frames after a patch include the
    // pipeline/state churn caused by the patch itself.
    const WARMUP = 30;
    const result = await new Promise((resolve) => {
      let n = 0;
      const step = (now) => {
        n++;
        // Re-asserted every frame: the engine owns object3D.visible and
        // reconciles it, so writing it once before the loop does not hold.
        if (hide) for (const root of roots) root.visible = false;
        if (n > WARMUP) {
          deltas.push(now - last);
          perFrameCalls.push(calls);
          const rt = renderer?.info?.render?.timestamp ?? 0;
          if (rt > 0) gpuRender.push(rt);
        }
        last = now;
        calls = 0;
        if (n < frames + WARMUP) requestAnimationFrame(step);
        else {
          const sorted = [...deltas].sort((a, b) => a - b);
          const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
          resolve({
            frames: deltas.length,
            avg: avg(deltas),
            median: sorted[Math.floor(sorted.length / 2)] ?? 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            gpuRender: avg(gpuRender),
            renderCalls: avg(perFrameCalls),
          });
        }
      };
      requestAnimationFrame(step);
    });
    renderer.render = realRender;
    delete ui.update;
    if (hide) for (const root of roots) root.visible = true;
    return result;
  }, { frames, mode, anchorId: created[0] });

  const fps = stats.median > 0 ? 1000 / stats.median : 0;
  console.log(
    `  ${tag.padEnd(24)} median ${stats.median.toFixed(2)}ms (${fps.toFixed(0)} fps)  avg ${stats.avg.toFixed(2)}  p95 ${stats.p95.toFixed(1)}  ` +
    `GPU ${stats.gpuRender.toFixed(2)}ms  render() calls/frame ${stats.renderCalls.toFixed(2)}`,
  );
  return stats;
}

async function runArms(label) {
  console.log(`\n=== ${label} (${FRAMES} frames/arm, ${REPEATS} interleaved passes) ===`);
  const runs = { on: [], "no-layout": [], "ui-hidden": [] };
  for (let r = 0; r < REPEATS; r++) {
    console.log(` pass ${r + 1}:`);
    runs.on.push(await measure("ui-on (shipped)", "on", FRAMES));
    runs["no-layout"].push(await measure("no-layout (quads only)", "no-layout", FRAMES));
    runs["ui-hidden"].push(await measure("ui-hidden (baseline)", "ui-hidden", FRAMES));
  }
  const mean = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
  const A = mean(runs.on, "median");
  const B = mean(runs["no-layout"], "median");
  const C = mean(runs["ui-hidden"], "median");
  const callsA = mean(runs.on, "renderCalls");
  const callsC = mean(runs["ui-hidden"], "renderCalls");
  console.log(`\n  ${label} SUMMARY (mean of ${REPEATS} passes, median frame time)`);
  console.log(`   ui-on       ${A.toFixed(2)}ms (${(1000 / A).toFixed(0)} fps)  render() calls ${callsA.toFixed(2)}  GPU ${mean(runs.on, "gpuRender").toFixed(2)}ms`);
  console.log(`   no-layout   ${B.toFixed(2)}ms (${(1000 / B).toFixed(0)} fps)  render() calls ${mean(runs["no-layout"], "renderCalls").toFixed(2)}  GPU ${mean(runs["no-layout"], "gpuRender").toFixed(2)}ms`);
  console.log(`   ui-hidden   ${C.toFixed(2)}ms (${(1000 / C).toFixed(0)} fps)  render() calls ${callsC.toFixed(2)}  GPU ${mean(runs["ui-hidden"], "gpuRender").toFixed(2)}ms`);
  // REGRESSION GUARD — the point of the whole rework. UI draws inside the main
  // scene pass, so a visible screen must not add a renderer.render() call. If
  // it ever does, someone reintroduced a UI pass and the ~2x frame cost with it.
  const extraPasses = callsA - callsC;
  if (extraPasses > 0.05) {
    console.log(`   !! REGRESSION: UI adds ${extraPasses.toFixed(2)} renderer.render call(s)/frame (${callsC.toFixed(2)} → ${callsA.toFixed(2)})`);
  } else {
    console.log(`   ok: UI adds no render pass (${callsA.toFixed(2)} calls/frame with and without)`);
  }
  console.log(`   layout walk  ${(A - B).toFixed(2)}ms/frame`);
  console.log(`   drawing UI   ${(B - C).toFixed(2)}ms/frame`);
  console.log(`   UI total     ${(A - C).toFixed(2)}ms/frame  → ${(A / C).toFixed(2)}× frame time`);
  return { A, B, C };
}

const edit = await runArms("EDIT MODE (screens drawn as world planes)");

const play = await call("play.set", { playing: true });
let playRes = null;
if (play.ok) {
  await settle(6000);
  playRes = await runArms("PLAY MODE (screen-space overlay)");
  await call("play.set", { playing: false });
  await wait(3000);
} else {
  console.log(`\n  (play.set failed: ${play.error})`);
}

// Leave the project as we found it — the tauri shim is read-only, but the
// in-memory scene is not, and an autosave would persist the probe screens.
for (const id of created) await call("entity.delete", { id });
console.log(`\n  removed ${created.length} probe screen(s)`);

console.log(`\n=== VERDICT ===`);
const fmt = (r) => `${(r.A - r.C).toFixed(2)}ms/frame, ${(r.A / r.C).toFixed(2)}× frame time`;
console.log(`  edit mode: ${fmt(edit)}`);
if (playRes) console.log(`  play mode: ${fmt(playRes)}`);

await browser.close();
process.exit(0);
