// GI PERFORMANCE INSTRUMENT — where do the milliseconds go, on the REAL scene.
//
// Boots the user's actual project through the editor's own path (same recipe
// as run-gi-flicker.mjs / run-gi-sponza.mjs — the synthetic hub-page pattern
// is dead, see gi-module memory) and measures, per quality preset:
//
//   arm "off"        GI component disabled — the non-GI baseline
//   arm "rest"       GI on, nothing moving — the converged steady state
//   arm "moving"     GI on, the scene's test sphere animated every frame via
//                    engine-side rAF (the GAME steady state: any animated
//                    object re-voxelizes the pyramid per frame)
//   freeze bisect    __giFreeze = all / transport / field / off at rest —
//                    attributes compute cost to resolve / cascades+merge+probe
//                    / feedback+voxelize stages by subtraction
//
// Metrics per arm: rAF frame delta avg/p95 (the number the user's FPS counter
// shows) plus the engine's real GPU timestamps (renderer.info render+compute,
// resolved via engine's own #resolveGpuTimestamps — StatsSystem exposes the
// smoothed value; we read renderer.info directly per frame and average).
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-perf.mjs
//
// Env:
//   PROJECT=<path>     default C:/Users/Khudiiash/Documents/GAME
//   QUALITIES=high,ultra  presets to sweep (scene's saved preset is restored at the end)
//   MEASURE_MS=4000    per-arm measurement window
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const QUALITIES = (process.env.QUALITIES ?? "high,ultra").split(",").map((s) => s.trim()).filter(Boolean);
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 4000);
// FAST=1: only the four arms that answer "what does waking GI cost" — for
// sweeping several quality presets without paying for the whole bisect.
const FAST = !!process.env.FAST;
// AB=1: INTERLEAVED A/B only. Absolute numbers on this box drift up to 2x
// between runs and even within one (the pure-render baseline was measured at
// 3.17ms and 1.37ms on the same scene minutes apart — other GPU clients plus
// clock boost). So never compare a variant to a baseline taken in another
// run, or even ten arms earlier: measure baseline, variant, baseline again,
// and judge the variant against the MEAN OF ITS NEIGHBOURS.
const AB = !!process.env.AB;
// CAM=1: the camera-motion question — see the CAM block below.
const CAM = !!process.env.CAM;
// SPLIT=1: the peak-split A/B — see the SPLIT block below.
const SPLIT = !!process.env.SPLIT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // MANDATORY (gi-module Round 15): occluded/headless windows get ~1/s timer
  // throttling without these and every wall-time is fiction.
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    // NOVSYNC=1: rAF is otherwise vsync-locked, so on a 120Hz panel every arm
    // reads ~8.3ms and GI's cost is invisible until it crosses the refresh
    // budget — at which point FPS halves in one step (that cliff IS the user's
    // "2x drop"). OFF BY DEFAULT: uncapping reliably races the editor's React
    // mount (double-createRoot → removeChild DOMException → dead __editorApi,
    // two runs lost). The GPU-timestamp columns are the sound metric; use this
    // only to confirm a wall-clock story, and expect flakiness.
    ...(process.env.NOVSYNC ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  // "per 120 frames" is the __giLogComposite line — it says whether a moving
  // LIGHT is triggering geometry composites, i.e. work that is pure waste.
  if (/\[gi\] built|\[gi\] occupancy backend|webgpu adapter ok|per 120 frames/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon/.test(t)) console.log(`  console.error: ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.stack ?? e.message).slice(0, 400)}`));

// A/B hatches, injected BEFORE any module runs — several GI switches are read
// at shader BUILD time, so setting them after load tests nothing (the
// createBounceFeedback comment records that exact mistake).
//   GLOBALS='__giNoFeedbackChecker=true,__giFieldSmoothing=0'
const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
await page.evaluateOnNewDocument((PROJECT, globals) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, PROJECT, GLOBALS);
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);

console.log(`Opening ${PROJECT} …`);
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
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
// Disabled-Cornell trap (gi-module memory): filter to the ENABLED gi component.
const giCandidates = entities.filter((e) => componentOf(e, "global-illumination"));
const giEntity = giCandidates.find((e) => componentOf(e, "global-illumination")?.props?.enabled !== false) ?? giCandidates[0];
let sphere =
  entities.find((e) => componentOf(e, "mesh")?.props?.geometry === "sphere") ??
  entities.find((e) => componentOf(e, "mesh") && /sphere|ball|test/i.test(e.name ?? ""));
// The "lighting changes" arm: a directional light rotating every frame wakes
// the field WITHOUT re-voxelizing anything (light slots are per-frame
// uniforms) — that separates the user's two reported cases cleanly.
const sun = entities.find((e) => componentOf(e, "light")?.props?.kind === "directional");
if (!giEntity) { console.log("FATAL: no global-illumination component"); await browser.close(); process.exit(1); }
const gi = componentOf(giEntity, "global-illumination");
const savedQuality = gi.props?.quality ?? "high";
const spherePose = sphere ? (await must("entity.get", { id: sphere.id })).transform : null;
console.log(`  GI on "${giEntity.name}" (enabled ${gi.props?.enabled}, saved quality ${savedQuality})`);
console.log(`  gi props: ${JSON.stringify(gi.props)}`);
if (sphere) console.log(`  mover: "${sphere.name}" (${sphere.id}) at [${spherePose.position.map((v) => (+v).toFixed(2))}]`);
else console.log(`  !! no mesh mover found — the object-motion arm will be SKIPPED`);
if (sun) console.log(`  sun: "${sun.name}" (${sun.id})`);
else console.log(`  !! no directional light — the light-change arm will be SKIPPED`);

// No authored mover in the scene (the Sponza scene is one prefab of static
// masonry): CREATE one. A brand-new mesh is exactly the game case — one
// dynamic occupancy slot among a static set — and it is what exercises the
// static/dynamic voxelize split. In-memory only; the read-only tauri shim
// refuses the autosave that would follow.
if (!sphere) {
  const made = await call("entity.create", {
    name: "__perf_mover",
    transform: { position: [-1.5, 1.2, 0] },
    components: [{ type: "mesh", props: { geometry: "sphere" } }],
  });
  const id = made.ok ? (made.value?.id ?? made.value) : null;
  if (id) {
    sphere = { id, name: "__perf_mover", components: [{ type: "mesh" }] };
    console.log(`  created mover "__perf_mover" (${id}) — a rebuild follows`);
    built = false;
    await wait(3000);
  } else {
    console.log(`  !! entity.create failed (${made.error}) — object-motion arm SKIPPED`);
  }
}

for (let i = 0; i < 90 && !built; i++) await wait(1000);
await wait(8000);
if (gi.props?.enabled === false) {
  built = false;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
  for (let i = 0; i < 240 && !built; i++) await wait(500);
  await wait(8000);
}

// Verified nave pose (run-gi-sponza.mjs).
await must("viewport.setCamera", { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] });
// LET THE EDITOR FINISH SETTLING before the first arm. Its React tree
// remounts once some seconds after the GI build lands, and if that happens
// mid-measurement it destroys __editorApi and the arm dies. Runs that spent
// this time waiting on a quality rebuild never saw it; the no-rebuild path
// walked straight into it twice.
await wait(15000);
await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});

const waitForWave = async (extraMs = 2000) => {
  for (let i = 0; i < 120; i++) {
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!suspended) break;
    await wait(1000);
  }
  await wait(extraMs);
};

// Engine-side measurement loop: rAF deltas + per-frame renderer.info GPU
// timestamps, with an optional in-page mover (no editor-API round trips per
// frame — those would serialize against React and measure the wrong thing).
async function measure(tag, { ms, mover, freeze, spin, cam, set }) {
  // The editor's React tree occasionally remounts mid-run (the known
  // double-createRoot race, see gi-module memory) and takes __editorApi with
  // it for a beat. Wait it out rather than losing the whole sweep.
  await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 60000 }).catch(() => {});
  const stats = await page.evaluate(async ({ ms, mover, freeze, spin, cam, set, anchorId }) => {
    // THE ONLY twin-proof engine accessor: a live Entity's `.engine`.
    // `import("/src/editor/engineInstance.js")` from this context is a MODULE
    // TWIN — its `engine` getter throws "accessed before ensureEngine" (run
    // 3) or, worse, ensureEngine() CREATES a second dead engine whose
    // renderer.info reads 0.00 forever and whose entity map is empty, so the
    // mover silently never moves (run 2). entities.live() goes through the
    // editor API singleton, which is Symbol.for-anchored.
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    if (!eng?.renderer) throw new Error("no live engine via entities.live");
    globalThis.__giFreeze = freeze ?? undefined;
    // Per-arm LIVE globals (e.g. __giFeedbackChecker) — the only A/B this
    // module trusts is one taken inside a single run, same build, same pose.
    const restoreSet = [];
    for (const [k, v] of Object.entries(set ?? {})) {
      restoreSet.push([k, globalThis[k]]);
      globalThis[k] = v;
    }
    let obj = null;
    let base = null;
    if (mover) {
      // entities.live() is the API's own live-Entity accessor — unambiguous.
      obj = globalThis.__editorApi.entities.live(mover.id)?.object3D ?? null;
      if (!obj) throw new Error(`mover entity ${mover.id} not live`);
      base = obj.position.clone();
    }
    // Light arm: rotate the sun a fraction of a degree per frame. No geometry
    // changes ⇒ no re-voxelize, no composite — this is purely "the field's
    // input changed, wake up".
    let sunObj = null;
    let sunBase = null;
    if (spin) {
      sunObj = globalThis.__editorApi.entities.live(spin.id)?.object3D ?? null;
      if (!sunObj) throw new Error(`light entity ${spin.id} not live`);
      sunBase = sunObj.rotation.clone();
    }
    // CAMERA arm (the user's second report: "FPS halves whenever the camera
    // moves, even with GI settled"). Nothing about a camera should wake the
    // FIELD — the resolve is the only camera-dependent GI stage — so this arm
    // exists to prove or kill that. Orbits the EDITOR camera around its orbit
    // target: position AND orientation change every frame, which is what a
    // real look-around does. `__viewport` is the DEV handle ViewportPanel
    // publishes; OrbitControls re-aims the camera at `orbit.target` on its own
    // update(), so writing position alone is enough and cannot fight it.
    let camObj = null;
    let camBase = null;
    let camPivot = null;
    let camR = 0;
    let camTheta = 0;
    let camY = 0;
    if (cam) {
      const vp = globalThis.__viewport;
      camObj = vp?.camera ?? eng.camera;
      if (!camObj) throw new Error("no viewport camera");
      camBase = camObj.position.clone();
      camPivot = vp?.orbit?.target?.clone() ?? null;
      if (camPivot) {
        const dx = camBase.x - camPivot.x;
        const dz = camBase.z - camPivot.z;
        camR = Math.hypot(dx, dz);
        camTheta = Math.atan2(dx, dz);
        camY = camBase.y - camPivot.y;
      }
    }
    const renderer = eng.renderer;
    // READING renderer.info.*.timestamp WAS THE BUG. Two runs of this harness
    // disagreed 5x on the same arms (rest compute 1.80 vs 0.37) because that
    // field is written by the ENGINE's own async resolve on its own cadence,
    // and three's pool returns `lastValue` — the PREVIOUS arm's number —
    // whenever a pool is empty. So: block the engine's resolver for the
    // duration and drive resolveTimestampsAsync ourselves, once per frame.
    // Each call returns the total duration of the last frame in that pool, so
    // one call per frame == one honest per-frame sample.
    const engineResolverBlock = new Promise(() => {});
    const savedInFlight = eng._gpuTimestampInFlight;
    eng._gpuTimestampInFlight = engineResolverBlock;
    // Settle: a freshly-set freeze/global or a just-reset mover needs a beat
    // to reach steady state, and the pools still hold the previous arm's tail.
    await new Promise((r) => setTimeout(r, 1200));
    const deltas = [];
    const gpuRender = [];
    const gpuCompute = [];
    const computeCalls = [];
    let sampling = false;
    const sampleGpu = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const calls0 = renderer.info?.compute?.calls ?? 0;
        const [rt, ct] = await Promise.all([
          renderer.resolveTimestampsAsync("render"),
          renderer.resolveTimestampsAsync("compute"),
        ]);
        const calls1 = renderer.info?.compute?.calls ?? 0;
        if (typeof rt === "number" && rt > 0) gpuRender.push(rt);
        // An empty compute pool returns the stale lastValue. `calls` not
        // advancing across the await means no compute ran — record a true 0
        // rather than the previous arm's number.
        if (typeof ct === "number") {
          const ran = calls1 > calls0;
          gpuCompute.push(ran ? ct : 0);
          computeCalls.push(calls1 - calls0);
        }
      } catch { /* device loss / pool contention — drop the sample */ }
      sampling = false;
    };
    const start = performance.now();
    let last = start;
    const result = await new Promise((resolve) => {
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        sampleGpu();
        if (obj && base) {
          const t = (now - start) / 1000;
          obj.position.x = base.x + Math.sin(2 * Math.PI * 0.5 * t) * 1.0;
          obj.updateMatrixWorld(true);
        }
        if (sunObj && sunBase) {
          const t = (now - start) / 1000;
          sunObj.rotation.x = sunBase.x + Math.sin(2 * Math.PI * 0.2 * t) * 0.15;
          sunObj.updateMatrixWorld(true);
        }
        if (camObj && camBase) {
          const t = (now - start) / 1000;
          if (camPivot && camR > 0.01) {
            // ±20° sweep about the orbit target — continuous motion every
            // frame, and it stays in the nave instead of drifting into a wall.
            const th = camTheta + Math.sin(2 * Math.PI * 0.15 * t) * 0.35;
            camObj.position.set(
              camPivot.x + Math.sin(th) * camR,
              camPivot.y + camY + Math.sin(2 * Math.PI * 0.1 * t) * 0.2,
              camPivot.z + Math.cos(th) * camR,
            );
          } else {
            camObj.position.set(camBase.x + Math.sin(2 * Math.PI * 0.15 * t) * 1.5, camBase.y, camBase.z);
          }
          camObj.updateMatrixWorld(true);
        }
        if (now - start < ms) requestAnimationFrame(step);
        else {
          if (obj && base) { obj.position.copy(base); obj.updateMatrixWorld(true); }
          if (sunObj && sunBase) { sunObj.rotation.copy(sunBase); sunObj.updateMatrixWorld(true); }
          if (camObj && camBase) { camObj.position.copy(camBase); camObj.updateMatrixWorld(true); }
          deltas.shift();
          const sorted = [...deltas].sort((a, b) => a - b);
          const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
          // MEDIAN, not mean: a few compile/readback outliers per arm skew a
          // 400-sample mean by more than the effect being measured.
          const med = (a) => {
            if (!a.length) return 0;
            const s = [...a].sort((x, y) => x - y);
            return s[Math.floor(s.length / 2)];
          };
          const pct = (a, p) => {
            if (!a.length) return 0;
            const s = [...a].sort((x, y) => x - y);
            return s[Math.min(s.length - 1, Math.floor(s.length * p))];
          };
          resolve({
            frames: deltas.length,
            avg: avg(deltas),
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            worst: sorted[sorted.length - 1] ?? 0,
            gpuRender: med(gpuRender),
            gpuCompute: med(gpuCompute),
            gpuComputeP90: pct(gpuCompute, 0.9),
            gpuTotal: med(gpuRender) + med(gpuCompute),
            computeCalls: med(computeCalls),
            gpuSamples: gpuCompute.length,
          });
        }
      };
      requestAnimationFrame(step);
    });
    // POSITIVE CONTROL for the `set` mechanism. A live global that never
    // reached the uniform would produce exactly the same "no measurable
    // effect" as a change that genuinely costs nothing — read the uniforms
    // back BEFORE restoring, so a null result can be told apart from a
    // no-op switch. -1 = checker off, 0/1 = a parity is actually being written.
    const giSystem = eng.modules?.get?.("gi")?.system ?? null;
    result.parityFeedback = giSystem?.state?.feedbackParity?.value ?? null;
    result.parityTrace = giSystem?.state?.traceParity?.value ?? null;
    // THE DIRECT ANSWER for the camera arm: `_fieldQuietFrames` is the
    // converged-idle counter (#tick). Past GI_IDLE_AFTER_FRAMES=180 the field
    // pipeline is ASLEEP and only the resolve runs. If this reads ~0 while the
    // camera orbits, something camera-derived is bumping a field input and the
    // sleep never engages — which would be the bug.
    result.quietFrames = giSystem?._fieldQuietFrames ?? null;
    result.drawCalls = eng.renderer?.info?.render?.drawCalls ?? null;
    globalThis.__giFreeze = undefined;
    for (const [k, v] of restoreSet) globalThis[k] = v;
    eng._gpuTimestampInFlight = eng._gpuTimestampInFlight === engineResolverBlock ? savedInFlight ?? null : eng._gpuTimestampInFlight;
    return result;
  }, { ms, mover, freeze, spin, cam, set, anchorId: giEntity.id });
  const fps = stats.avg > 0 ? 1000 / stats.avg : 0;
  console.log(
    `  ${tag.padEnd(26)} GPU total ${stats.gpuTotal.toFixed(2)}ms ` +
    `(render ${stats.gpuRender.toFixed(2)} + compute ${stats.gpuCompute.toFixed(2)}, p90 ${stats.gpuComputeP90.toFixed(2)})  ` +
    `rAF ${stats.avg.toFixed(2)}ms/${fps.toFixed(0)}fps  ` +
    `computes ${stats.computeCalls}  quiet ${stats.quietFrames}  draws ${stats.drawCalls}  (${stats.frames} frames, ${stats.gpuSamples} gpu)`,
  );
  return stats;
}

const report = {};
let currentQuality = savedQuality;
for (const quality of QUALITIES) {
  console.log(`\n=== QUALITY ${quality} ===`);
  // Only rebuild when the preset actually differs. A no-op setProp still
  // forces a full GI rebuild, and that rebuild is what races the editor's
  // React mount (double-createRoot → removeChild → __editorApi gone for
  // good, three runs lost to it). Skipping it when the scene is already at
  // the requested preset removes the race from the common single-preset run.
  if (quality !== currentQuality) {
    if ((await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: quality })).ok) {
      built = false;
      for (let i = 0; i < 180 && !built; i++) await wait(500);
      await waitForWave(3000);
    }
    currentQuality = quality;
  } else {
    console.log(`  (already at ${quality} — no rebuild)`);
  }
  const r = {};
  // One flaky arm must not cost the sweep (see measure()'s remount note).
  // One flaky arm must not cost the sweep. The editor's React tree remounts
  // unpredictably a while after boot (double-createRoot → removeChild →
  // __editorApi gone), and it used to take every subsequent arm with it — so
  // retry once after waiting for the API to come back.
  const arm = async (key, tag, opts) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { r[key] = await measure(tag, opts); return; }
      catch (err) {
        const last = attempt === 1;
        console.log(`  ${tag.padEnd(26)} ${last ? "FAILED" : "retrying"}: ${String(err.message).slice(0, 120)}`);
        if (last) return;
        await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
        await wait(5000);
      }
    }
  };
  if (AB) {
    // INTERLEAVED A/B (see the AB note at the top). Each variant sits between
    // two baselines; its score is the variant's compute over the mean of its
    // neighbours, so drift that happens over minutes cancels out.
    const variants = [
      ["feedbackChecker", { __giFeedbackChecker: true }],
      ["traceChecker", { __giTraceChecker: true }],
      ["bothCheckers", { __giFeedbackChecker: true, __giTraceChecker: true }],
    ];
    const driver = sun ? { spin: { id: sun.id } } : { mover: { id: sphere.id } };
    const series = [];
    await arm("base0", "baseline", { ms: MEASURE_MS, ...driver });
    series.push(["base", r.base0]);
    for (let i = 0; i < variants.length; i++) {
      const [name, set] = variants[i];
      await arm(name, name, { ms: MEASURE_MS, ...driver, set });
      series.push([name, r[name]]);
      await arm(`base${i + 1}`, "baseline", { ms: MEASURE_MS, ...driver });
      series.push(["base", r[`base${i + 1}`]]);
    }
    console.log(`\n  INTERLEAVED A/B — GPU compute ms (${sun ? "light changing" : "object moving"}):`);
    for (let i = 0; i < series.length; i++) {
      const [name, a] = series[i];
      if (!a) continue;
      if (name === "base") { console.log(`    baseline               ${a.gpuCompute.toFixed(2)}`); continue; }
      const prev = series[i - 1]?.[1]?.gpuCompute;
      const next = series[i + 1]?.[1]?.gpuCompute;
      const neighbours = [prev, next].filter((v) => Number.isFinite(v));
      const ref = neighbours.reduce((x, y) => x + y, 0) / Math.max(1, neighbours.length);
      const pct = ref > 0 ? ((a.gpuCompute / ref - 1) * 100).toFixed(0) : "?";
      console.log(`    ${name.padEnd(22)} ${a.gpuCompute.toFixed(2)}   vs neighbours ${ref.toFixed(2)}  →  ${pct}%`);
    }
    report[quality] = r;
    continue;
  }
  if (SPLIT) {
    // PEAK SPLIT A/B (2026-08-04). The fix under test alternates the feedback
    // half and the transport half by frame parity, so the awake cost should
    // roughly halve. Interleaved against its own control (`__giPeakSplit
    // = false` restores every-frame dispatch AND the un-squared field EMA)
    // because absolutes drift on this box — judge each variant against the
    // mean of its neighbours.
    const driver = sun ? { spin: { id: sun.id } } : { mover: { id: sphere.id } };
    await arm("split0", "light + SPLIT (default)", { ms: MEASURE_MS, ...driver });
    await arm("noSplit0", "light + no split (old)", { ms: MEASURE_MS, ...driver, set: { __giPeakSplit: false } });
    await arm("split1", "light + SPLIT (repeat)", { ms: MEASURE_MS, ...driver });
    await arm("noSplit1", "light + no split (repeat)", { ms: MEASURE_MS, ...driver, set: { __giPeakSplit: false } });
    if (sphere) {
      await arm("objSplit", "object + SPLIT", { ms: MEASURE_MS, mover: { id: sphere.id } });
      await arm("objNoSplit", "object + no split", { ms: MEASURE_MS, mover: { id: sphere.id }, set: { __giPeakSplit: false } });
    }
    await arm("rest", "rest / asleep", { ms: MEASURE_MS });
    const mean = (...v) => v.filter(Number.isFinite).reduce((a, b) => a + b, 0) / v.filter(Number.isFinite).length;
    const cOf = (k) => r[k]?.gpuCompute;
    const splitC = mean(cOf("split0"), cOf("split1"));
    const noSplitC = mean(cOf("noSplit0"), cOf("noSplit1"));
    console.log(`\n  PEAK-SPLIT A/B (${quality}) — GPU compute ms while the light moves:`);
    console.log(`    every frame (old): ${noSplitC.toFixed(2)}   split: ${splitC.toFixed(2)}   → ${((splitC / noSplitC - 1) * 100).toFixed(0)}%`);
    if (r.objSplit && r.objNoSplit) {
      console.log(`    object moving — old ${r.objNoSplit.gpuCompute.toFixed(2)}  split ${r.objSplit.gpuCompute.toFixed(2)}   ` +
        `→ ${((r.objSplit.gpuCompute / r.objNoSplit.gpuCompute - 1) * 100).toFixed(0)}%`);
    }
    console.log(`    asleep ${r.rest?.gpuCompute?.toFixed(2)} (unchanged by this fix)`);
    report[quality] = r;
    continue;
  }
  if (CAM) {
    // CAMERA MODE — "GI is settled, I only MOVE THE CAMERA, and the FPS
    // halves". Every arm here is paired so the question is answerable without
    // trusting absolutes: rest vs cam says what camera motion costs with GI
    // on; off vs offCam says what it costs with GI off. If the two deltas
    // match, GI is innocent and the cost is the renderer's. `camFreezeAll`
    // holds every GI compute still while the camera moves — the remainder is
    // the gbuffer prepass plus three's own render.
    await arm("rest", "rest / asleep (GI on)", { ms: MEASURE_MS });
    await arm("cam", "camera moving (GI on)", { ms: MEASURE_MS, cam: true });
    await arm("restRepeat", "rest (repeat)", { ms: MEASURE_MS });
    await arm("camRepeat", "camera moving (repeat)", { ms: MEASURE_MS, cam: true });
    await arm("camFreezeAll", "camera + freeze all GI", { ms: MEASURE_MS, cam: true, freeze: "all" });
    if (sun) await arm("light", "light changing", { ms: MEASURE_MS, spin: { id: sun.id } });
    if (sun) await arm("lightCam", "light + camera moving", { ms: MEASURE_MS, spin: { id: sun.id }, cam: true });
    await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: false });
    await wait(3000);
    await arm("off", "GI disabled, rest", { ms: MEASURE_MS });
    await arm("offCam", "GI disabled, camera moving", { ms: MEASURE_MS, cam: true });
    await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
    built = false;
    for (let i = 0; i < 180 && !built; i++) await wait(500);
    await waitForWave(2000);
    console.log(`\n  CAMERA-MOTION VERDICT (${quality}) — GPU ms, and did GI stay asleep?`);
    const row = (k, label) => {
      const a = r[k];
      if (!a) return;
      console.log(
        `    ${label.padEnd(24)} total ${a.gpuTotal.toFixed(2)} = render ${a.gpuRender.toFixed(2)} + compute ${a.gpuCompute.toFixed(2)}  ` +
        `computes/frame ${a.computeCalls}  quietFrames ${a.quietFrames}  rAF ${a.avg.toFixed(2)}`,
      );
    };
    row("rest", "GI on, still");
    row("cam", "GI on, camera moving");
    row("restRepeat", "GI on, still (repeat)");
    row("camRepeat", "GI on, camera (repeat)");
    row("camFreezeAll", "camera, GI frozen");
    row("light", "GI on, light moving");
    row("lightCam", "light + camera");
    row("off", "GI off, still");
    row("offCam", "GI off, camera moving");
    const dd = (a, b) => (r[a] && r[b] ? (r[b].gpuTotal - r[a].gpuTotal).toFixed(2) + "ms" : "-");
    console.log(`    camera surcharge WITH GI: ${dd("rest", "cam")}   WITHOUT GI: ${dd("off", "offCam")}`);
    report[quality] = r;
    continue;
  }
  // THE USER'S COMPLAINT, as three arms: asleep (converged idle) vs the two
  // things that wake the field. `light` changes only per-frame uniforms;
  // `moving` additionally re-voxelizes and re-composites.
  await arm("rest", "rest / asleep (GI on)", { ms: MEASURE_MS });
  if (sun) await arm("light", "light changing", { ms: MEASURE_MS, spin: { id: sun.id } });
  // REPEAT of the headline arm — if these two disagree the instrument is not
  // measuring what it claims and no A/B below is worth reading.
  if (sun) await arm("lightRepeat", "light changing (repeat)", { ms: MEASURE_MS, spin: { id: sun.id } });
  if (sphere) await arm("moving", "object moving", { ms: MEASURE_MS, mover: { id: sphere.id } });
  // Awake-cost attribution by subtraction. `light + freeze field` runs the
  // transport half only; `light + freeze transport` runs the resolve only.
  if (!FAST) {
  if (sun) await arm("lightFreezeField", "light + freeze field", { ms: MEASURE_MS, spin: { id: sun.id }, freeze: "field" });
  if (sun) await arm("lightFreezeTransport", "light + freeze transport", { ms: MEASURE_MS, spin: { id: sun.id }, freeze: "transport" });
  // Transport split: traces → +merges → +probe integration.
  if (sun) await arm("lightTraces", "light + freeze after traces", { ms: MEASURE_MS, spin: { id: sun.id }, freeze: "traces" });
  if (sun) await arm("lightMerges", "light + freeze after merges", { ms: MEASURE_MS, spin: { id: sun.id }, freeze: "merges" });
  if (sphere) await arm("movingFreezeField", "object + freeze field", { ms: MEASURE_MS, mover: { id: sphere.id }, freeze: "field" });
  if (sphere) await arm("movingFreezeAll", "object + freeze all", { ms: MEASURE_MS, mover: { id: sphere.id }, freeze: "all" });
  // Freeze bisect at rest: cost attribution by subtraction.
  await arm("freezeAll", "rest + freeze all", { ms: MEASURE_MS, freeze: "all" });
  // THE FIX UNDER TEST: feedback checkerboard (half the field cells per frame,
  // alternating) at high/ultra, where it is currently off. Measured against
  // the identical arm above, same build, same pose, minutes apart.
  if (sun) await arm("lightChecker", "light + feedback checker", { ms: MEASURE_MS, spin: { id: sun.id }, set: { __giFeedbackChecker: true } });
  if (sphere) await arm("movingChecker", "object + feedback checker", { ms: MEASURE_MS, mover: { id: sphere.id }, set: { __giFeedbackChecker: true } });
  if (sun) await arm("lightTraceChecker", "light + trace checker", { ms: MEASURE_MS, spin: { id: sun.id }, set: { __giTraceChecker: true } });
  if (sun) await arm("lightBothCheckers", "light + BOTH checkers", { ms: MEASURE_MS, spin: { id: sun.id }, set: { __giFeedbackChecker: true, __giTraceChecker: true } });
  if (sphere) await arm("movingBothCheckers", "object + BOTH checkers", { ms: MEASURE_MS, mover: { id: sphere.id }, set: { __giFeedbackChecker: true, __giTraceChecker: true } });
  // The object-motion surcharge: what does the per-composite-frame inter-probe
  // visibility pass cost? (It re-traces every child→parent probe pair for the
  // WHOLE lattice on every frame anything moves.)
  if (sphere) await arm("movingNoVis", "object + no vis update", { ms: MEASURE_MS, mover: { id: sphere.id }, set: { __giNoVisUpdate: true } });
  if (sphere) await arm("movingAllNoVis", "object + freeze all + no vis", { ms: MEASURE_MS, mover: { id: sphere.id }, freeze: "all", set: { __giNoVisUpdate: true } });
  }
  // GI fully off — the render baseline.
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: false });
  await wait(2500);
  await arm("off", "GI disabled", { ms: MEASURE_MS });
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
  built = false;
  for (let i = 0; i < 180 && !built; i++) await wait(500);
  await waitForWave(2000);
  report[quality] = r;
}

// Restore the scene's saved preset (read-only project shim — belt+braces).
await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: savedQuality });

console.log(`\n=== SUMMARY — the user's question: how much does WAKING GI cost? ===`);
const f = (v, w) => (Number.isFinite(v) ? v.toFixed(2) : "  -  ").padStart(w);
for (const q of Object.keys(report)) {
  const r = report[q];
  const fps = (a) => (a?.avg > 0 ? 1000 / a.avg : NaN);
  console.log(`\n--- ${q} ---`);
  console.log(`  arm                       GPU total  = render  + compute   (rAF ms)`);
  for (const [name, a] of Object.entries(r)) {
    if (!a) continue;
    console.log(
      `  ${name.padEnd(24)} ${f(a.gpuTotal, 8)}   ${f(a.gpuRender, 8)}  ${f(a.gpuCompute, 8)}   ${f(a.avg, 8)}`,
    );
  }
  const d = (a, b) => (a && b ? (b.gpuTotal - a.gpuTotal).toFixed(2) + "ms" : "-");
  console.log(`\n  WAKE COST (GPU total over asleep):  light-change ${d(r.rest, r.light)}   object-move ${d(r.rest, r.moving)}`);
  console.log(`  reproducibility (light vs repeat):  ${f(r.light?.gpuTotal, 1)} vs ${f(r.lightRepeat?.gpuTotal, 1)}`);
  console.log(`  awake split: resolve ${f((r.lightFreezeTransport?.gpuTotal ?? 0) - (r.freezeAll?.gpuTotal ?? 0), 1)}ms  ` +
    `transport ${f((r.lightFreezeField?.gpuTotal ?? 0) - (r.lightFreezeTransport?.gpuTotal ?? 0), 1)}ms  ` +
    `feedback ${f((r.light?.gpuTotal ?? 0) - (r.lightFreezeField?.gpuTotal ?? 0), 1)}ms`);
  console.log(`  transport split: traces ${f((r.lightTraces?.gpuTotal ?? 0) - (r.lightFreezeTransport?.gpuTotal ?? 0), 1)}ms  ` +
    `merges ${f((r.lightMerges?.gpuTotal ?? 0) - (r.lightTraces?.gpuTotal ?? 0), 1)}ms  ` +
    `probes ${f((r.lightFreezeField?.gpuTotal ?? 0) - (r.lightMerges?.gpuTotal ?? 0), 1)}ms`);
  console.log(`  object surcharge (voxelize+vis+composite): ${f((r.movingFreezeAll?.gpuTotal ?? 0) - (r.freezeAll?.gpuTotal ?? 0), 1)}ms, ` +
    `of which inter-probe visibility ${f((r.movingFreezeAll?.gpuTotal ?? 0) - (r.movingAllNoVis?.gpuTotal ?? 0), 1)}ms`);
  // Compute-column only: every one of these arms runs GI compute, so they
  // share a clock state — the render column does not (it falls as compute
  // rises, GPU boost), which makes gpuTotal deltas unusable for an A/B.
  const c = (a) => (a ? a.gpuCompute : NaN);
  console.log(`\n  CHECKER A/B (GPU compute ms — the awake GI cost):`);
  console.log(`    light:  baseline ${f(c(r.light), 1)} | feedback ${f(c(r.lightChecker), 1)} | trace ${f(c(r.lightTraceChecker), 1)} | BOTH ${f(c(r.lightBothCheckers), 1)}`);
  console.log(`    object: baseline ${f(c(r.moving), 1)} | feedback ${f(c(r.movingChecker), 1)} | BOTH ${f(c(r.movingBothCheckers), 1)}`);
  console.log(`  NO-VIS-UPDATE A/B:     object ${f(c(r.moving), 1)} → ${f(c(r.movingNoVis), 1)}`);
}

await browser.close();
process.exit(0);
