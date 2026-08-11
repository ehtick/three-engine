// PER-FRAME GI FLICKER INSTRUMENT — sees what the eye sees.
//
// The screenshot-based run-gi-flicker.mjs captures every ~17 rendered frames
// (viewport.screenshot RTT), so per-frame churn that settles within a few
// frames is INVISIBLE to it — and that per-frame churn is exactly the
// "flicker gets crazy when objects move" report. This harness instead runs a
// tiny GPU accumulator over the GI RESOLVE TEXTURE on every rendered frame:
// per half-res pixel it tracks luminance, counts DIRECTION REVERSALS of the
// per-frame delta (the popping signature), and the mover advances a
// SUB-VOXEL step per frame (a realistic ~1m/s object at 120fps), all
// in-page at full frame rate. One readback at the end.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-flicker-frame.mjs
//
// Env:
//   PROJECT=<path>      default C:/Users/Khudiiash/Documents/GAME
//   QUALITY=ultra       GI preset override
//   FRAMES=240          measured frames (after 30 warmup frames)
//   AMP=0.5             sphere sinusoid amplitude (m); one period per run
//   PRESET_GLOBALS='{"__giNoChebyshev":true,"__giDepthAlpha":1}'  A/B arm
//   SRC=1               turn Split Radiance Cascades on (`__giSrcProbes`) AND
//                       give the scene a sky, because with hit shading still
//                       Phase 5 the sky is the ONLY radiance SRC has — without
//                       it the resolve is uniformly zero and this instrument
//                       reports a flawless absence of flicker.
//   ALPHA_AB=1          second moving arm at alpha=1 (single-frame), IN THE
//                       SAME PAGE. The whole point of the still control below
//                       is that this harness's absolute numbers do not survive
//                       a process boundary; a temporal A/B across two runs
//                       would be exactly the invalid comparison it warns about.
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const QUALITY = process.env.QUALITY ?? "ultra";
const FRAMES = Number(process.env.FRAMES ?? 240);
const AMP = Number(process.env.AMP ?? 0.5);
// ROTATE=1 — the ROTATING-CUBE arm (GI_MOTION_PERF_PLAN §7.1): a box mover
// spun on TWO axes at 0.6 rad/s (the user's MeshScript verbatim) instead of
// the translation sinusoid — rotation re-phases every face's rasterization
// staircase per frame, the worst case by construction. Adds the plan's
// STEP-AMPLITUDE metric (p95 per-pixel max |Δlum|): popping is a step, not
// an oscillation, so reversals alone under-report it.
const ROTATE = process.env.ROTATE === "1";
const SRC = process.env.SRC === "1";
const ALPHA_AB = process.env.ALPHA_AB === "1";
const CEILING_AB = process.env.CEILING_AB === "1";
// Low enough to force a LARGE stride at this harness's resolution — the regime
// the user's editor is in (stride 7) and the one the per-frame decay had to be
// corrected for. The tier default here produces stride 2, which barely
// exercises it.
const TIGHT_CEILING = Number(process.env.TIGHT_CEILING ?? 16384);
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
  // ⚠ `src probes` is in this filter because leaving it out cost a whole run.
  // It is the line that carries pixelCount and the built stride, and without it
  // the ceiling A/B could only INFER what it had changed. A console filter that
  // excludes the line the run exists to read is the recurring failure here.
  if (/\[gi\] built|\[gi\] occupancy backend|\[gi\] src probes/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 250)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 300)}`);
});

await page.evaluateOnNewDocument((PROJECT, PRESET) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  // KEEP THE ENGINE TICKING. A headless page is never focused, and the editor's
  // frame pacing can pause an unfocused viewport — at which point this harness
  // runs its per-frame accumulator over a texture nothing is rewriting and
  // reports PERFECT STABILITY. Measured before this line existed: 240 frames,
  // "mean changed frames/px 0.0 of 240", every histogram bucket zero. That is
  // not a quiet scene, it is a stopped one, and it reads exactly like "no
  // flicker" — the most dangerous possible failure for a flicker instrument.
  // Same hatch the bleed and block rigs already set for the same reason.
  globalThis.__editorKeepRendering = true;
  for (const [k, v] of Object.entries(PRESET)) globalThis[k] = v;
}, PROJECT, {
  ...JSON.parse(process.env.PRESET_GLOBALS ?? "{}"),
  // Must be set before the GI module builds. SRC is ON by default since
  // Phase 5, but this rig PINS it off unless SRC=1: the SRC=1 arm also sets
  // the sky environment this instrument needs (§12.23 — without a sky the
  // resolve is uniformly black and the rig reports a flawless absence of
  // flicker), so "SRC by default without the sky" would be exactly that trap.
  __giSrcProbes: process.env.SRC === "1",
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
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
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
const giCandidates = entities.filter((e) => componentOf(e, "global-illumination"));
const giEntity = giCandidates.find((e) => componentOf(e, "global-illumination")?.props?.enabled !== false) ?? giCandidates[0];
let sphere = ROTATE ? null : entities.find((e) => componentOf(e, "mesh")?.props?.geometry === "sphere");
if (!giEntity) { console.log("FATAL: gi entity missing"); await browser.close(); process.exit(1); }
// NO AUTHORED MOVER ANY MORE (same trap run-gi-perf.mjs hit): the scene is one
// prefab of static masonry, so create the mover — a fresh mesh is exactly the
// game case, one dynamic occupancy slot among a static set. `transform:
// {position}` is the shape entity.create wants; a top-level `position` fails.
if (!sphere) {
  // POSE MATTERS AS MUCH AS EXISTENCE. The first attempt put it at [-1.5,
  // 1.2, 0] — 13m down the nave, where a 0.5m sphere's GI footprint moved
  // nothing the metric could see: 0.002 rev/px, 0.0 changed frames, and
  // "excluded 0" (the mover-footprint outlier test found no footprint at all),
  // i.e. a clean-looking result from an instrument measuring NOTHING. This
  // sits ~4m along the verified camera's view ray, just above the floor, so
  // both the sphere and the light it bounces onto the floor are on screen.
  const made = await call("entity.create", {
    name: "__flicker_mover",
    transform: { position: [7.9, 1.4, 0.2] },
    // ROTATE arm: a box — rotation is a no-op on a sphere's occupancy.
    components: [{ type: "mesh", props: { geometry: ROTATE ? "box" : "sphere" } }],
  });
  const id = made.ok ? (made.value?.id ?? made.value) : null;
  if (!id) { console.log(`FATAL: no mover and entity.create failed (${made.error})`); await browser.close(); process.exit(1); }
  sphere = { id, name: "__flicker_mover" };
  console.log(`  created mover "__flicker_mover" (${id}) — a rebuild follows`);
  built = false;
  await wait(3000);
}
const gi = componentOf(giEntity, "global-illumination");
console.log(`  GI "${giEntity.name}" quality ${gi.props?.quality} probeSmoothing ${gi.props?.probeSmoothing}; mover "${sphere.name}"`);

if (QUALITY) await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: QUALITY });
// INTENSITY env — the user's scene saves intensity 0 (2026-08-06), which
// makes every GI metric read a perfect zero; force a live value for A/Bs.
if (process.env.INTENSITY) {
  await must("component.setProp", {
    id: giEntity.id, type: "global-illumination",
    key: "intensity", value: Number(process.env.INTENSITY),
  });
}
// PROBE_SMOOTHING=0.02 — arm override of the scene's saved Light Smoothing
// (a live uniform, no rebuild).
if (process.env.PROBE_SMOOTHING) {
  await must("component.setProp", {
    id: giEntity.id, type: "global-illumination",
    key: "probeSmoothing", value: Number(process.env.PROBE_SMOOTHING),
  });
  console.log(`  probeSmoothing forced to ${process.env.PROBE_SMOOTHING}`);
}
for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(10000);

await must("viewport.setCamera", { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] });
await wait(1500);

// ── THE SKY, WHICH SRC CANNOT BE MEASURED WITHOUT ───────────────────────────
// `sceneSkyRadiance` (giConfig.js) is `scene.environment ? environmentIntensity
// : 0`, and it does NOT sample the texture — the sky's chroma is deliberately
// unread until Phase 5. So any truthy environment gives the right radiometry
// here, and a 1x1 equirect costs nothing and needs no HDRI in the project.
//
// It has to exist at all, though: with hit shading still Phase 5 every
// deposited radiance is zero, so the sky is the only light SRC transports. A
// run without it measures a uniformly black resolve texture and reports a
// flawless absence of flicker — the same shape of lie the `__editorKeepRendering`
// note above documents, and just as convincing.
if (SRC) {
  const skyInfo = await page.evaluate(async (anchorId) => {
    const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
    if (!eng?.scene) return { ok: false, why: "no live engine" };
    if (!eng.scene.environment) {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.needsUpdate = true;
      eng.scene.environment = tex;
    }
    eng.scene.environmentIntensity = 1;
    return { ok: true, intensity: eng.scene.environmentIntensity };
  }, giEntity.id);
  console.log(`  sky: ${skyInfo.ok ? `environment set, intensity ${skyInfo.intensity}` : `FAILED (${skyInfo.why})`}`);
  if (!skyInfo.ok) { await browser.close(); process.exit(1); }
  await wait(2000);
}

const body = async ({ anchorId, moverId, frames, amp, rotate }) => {
  const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
  if (!eng?.renderer) throw new Error("no live engine");
  const obj = globalThis.__editorApi.entities.live(moverId)?.object3D;
  if (!obj) throw new Error("mover not live");
  const renderer = eng.renderer;
  const system = eng.modules.get("gi")?.system;
  const targets = system?._giTargets;
  const size = system?._giTargetSize;
  if (!targets?.irradiance || !size) throw new Error("no GI resolve targets");
  const { width, height } = size;

  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, If, float, instanceIndex, instancedArray, ivec2, select, texture, uniform, vec2, vec3, vec4 } = TSL;

  // Per-pixel state: x prevLum, y prev significant delta, z reversal count,
  // w changed-frame count (for excluding the mover's own footprint).
  const stateBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  // Step-amplitude state (ROTATE arm's headline metric, cheap enough to keep
  // always): x = max |Δlum| seen, y = Σ|Δlum| over significant frames.
  const ampBuf = instancedArray(new Float32Array(width * height * 2), "vec2");
  const irrNode = texture(targets.irradiance);
  const widthU = uniform(width, "uint");
  const armed = uniform(0); // 0 = seed only (warmup), 1 = count
  const accumulator = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const prev = stateBuf.element(instanceIndex).toVar();
    const delta = lum.sub(prev.x).toVar();
    const threshold = float(0.002).max(prev.x.mul(0.01)).toVar();
    const moved = delta.abs().greaterThan(threshold).toVar();
    // Separate float vars — TSL can't assign INTO a vec4 var's components
    // (same constraint giScreen's shadowVars note documents).
    const outDelta = float(prev.y).toVar();
    const outRev = float(prev.z).toVar();
    const outChanged = float(prev.w).toVar();
    If(moved.and(armed.greaterThan(0.5)), () => {
      const flipped = delta.mul(prev.y).lessThan(0);
      outRev.assign(prev.z.add(select(flipped, float(1), float(0))));
      outDelta.assign(delta);
      outChanged.assign(prev.w.add(1));
      const amp = ampBuf.element(instanceIndex).toVar();
      ampBuf.element(instanceIndex).assign(
        vec2(amp.x.max(delta.abs()), amp.y.add(delta.abs())),
      );
    });
    stateBuf.element(instanceIndex).assign(vec4(lum, outDelta, outRev, outChanged));
  })().compute(width * height);

  const base = obj.position.clone();
  // Warmup: seed prevLum at rest (armed=0 → no counting).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    renderer.compute(accumulator);
  }
  armed.value = 1;
  // Measured run. Translation arm: one full sinusoid period over `frames`
  // frames — max step amp·2π/frames (~13mm at defaults: sub-voxel, a
  // realistic slow mover). ROTATE arm: the user's MeshScript verbatim —
  // rotation.x/y += dt·0.6, per rendered frame.
  let lastT = performance.now();
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (rotate) {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      obj.rotation.x += dt * 0.6;
      obj.rotation.y += dt * 0.6;
    } else {
      obj.position.x = base.x + amp * Math.sin((2 * Math.PI * i) / frames);
    }
    obj.updateMatrixWorld(true);
    renderer.compute(accumulator);
  }
  obj.position.copy(base);
  obj.updateMatrixWorld(true);

  const data = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
  const ampData = new Float32Array(await renderer.getArrayBufferAsync(ampBuf.value));
  // CPU analysis. Exclude pixels that changed on most frames (the mover's own
  // silhouette + its immediate ground shading, which legitimately track it).
  let kept = 0, excluded = 0, revSum = 0, popped = 0, changedSum = 0;
  const revHist = [0, 0, 0, 0, 0]; // 0, 1-2, 3-5, 6-10, >10
  const maxSteps = [];
  let ampSum = 0;
  for (let i = 0; i < width * height; i++) {
    const rev = data[i * 4 + 2];
    const changed = data[i * 4 + 3];
    if (changed > frames * 0.5) { excluded++; continue; }
    kept++;
    revSum += rev;
    changedSum += changed;
    if (rev >= 3) popped++;
    revHist[rev === 0 ? 0 : rev <= 2 ? 1 : rev <= 5 ? 2 : rev <= 10 ? 3 : 4]++;
    if (changed > 0) { maxSteps.push(ampData[i * 2]); ampSum += ampData[i * 2 + 1]; }
  }
  maxSteps.sort((a, b) => a - b);
  return {
    width, height, frames, kept, excluded,
    meanReversals: revSum / Math.max(1, kept),
    poppedPct: (popped / Math.max(1, kept)) * 100,
    meanChangedFrames: changedSum / Math.max(1, kept),
    revHist,
    // Step amplitude over pixels that changed at least once (plan §7.1):
    // p95/max of the per-pixel MAX step, and the mean total |Δ| walked.
    changedPx: maxSteps.length,
    stepP95: maxSteps.length ? maxSteps[Math.floor(maxSteps.length * 0.95)] : 0,
    stepMax: maxSteps.length ? maxSteps[maxSteps.length - 1] : 0,
    meanWalk: maxSteps.length ? ampSum / maxSteps.length : 0,
  };
};


// ── IN-RUN STILL CONTROL — the reason any of this is quotable ────────────────
// THE ABSOLUTE NUMBERS FROM THIS HARNESS ARE NOT COMPARABLE ACROSS PROCESSES.
// Measured 2026-08-07: the SAME baseline config read 1.404 reversals/px in one
// run and 5.194 in another — a 3.7x spread, larger than any effect anyone has
// tried to measure with it. It is rAF-driven, so machine load changes how far GI
// converges between accumulator samples and the reversal count moves with it.
// Two conclusions had already been drawn and REPORTED from cross-process
// comparisons before this was noticed; both had to be withdrawn.
//
// So the harness measures its own control, in the SAME page, renderer and load:
// an identical run with the mover held STILL (amp 0, no rotation). The page
// persists between evaluate() calls, so this costs one extra pass and nothing
// else. The ratio moving/still is the reportable quantity; a raw reversal count
// from this instrument means nothing alone and must never be quoted alone.
const measure = (amp, rotate) => page.evaluate(body, {
  anchorId: giEntity.id, moverId: sphere.id, frames: FRAMES, amp, rotate,
});
// ORDER MATTERS AND IS CONTROLLED. The FIRST arm absorbs post-build settling
// churn, so a still control run first is biased HIGH and would flatter any fix
// measured against it. Moving runs first, still second — and a warmup arm runs
// before both so neither carries the build transient.
// α IS LIVE (`srcSystem.js`'s `readAlpha`, polled in `syncCamera`), which is
// what makes a temporal A/B expressible here at all. `body()`'s own 30-frame
// warmup covers the transition in both directions: going to α=1 clears the
// accumulators on the first decay pass, and coming back needs ~1/α = 10 frames
// to re-accumulate.
const setAlpha = (a) => page.evaluate((v) => { globalThis.__giSrcAlpha = v; }, a);
// ── THE RAY CEILING, LIVE, FOR THE SAME REASON α IS ─────────────────────────
//
// `srcTransportRays` is polled per frame (srcSystem's `readCeiling`), so the
// stride can be changed without a rebuild — which is the only way to A/B it,
// because this instrument's own header records the same config reading 1.404
// and 5.194 reversals/px in two different processes. A before/after across runs
// would be exactly the invalid comparison it warns about.
//
// Why this arm exists: the ceiling makes a probe receive rays every S-th frame
// while the decay pass still runs every frame, and if the decay is not slowed
// to match, a bin loses most of its evidence between refreshes, drops under
// MIN_WEIGHT, retires and returns — which is bin-level MEMBERSHIP churn, the
// thing §12.24 identified as the step floor. `keep = (1-α)^(1/S)` is meant to
// remove it. This measures whether it does.
const setCeiling = (v) => page.evaluate((x) => { globalThis.__giSrcTransportRays = x; }, v);

await measure(0, false);            // discarded warmup arm
const result = await measure(AMP, ROTATE);
const still = await measure(0, false);
// ── THE TEMPORAL A/B, INTERLEAVED AND REPEATED ────────────────────────────
// Running α=1 after α=0.1 once would confound the comparison with whatever
// drifts over a five-minute page — which, on an instrument whose own header
// records a 3.7x spread between processes, is not a hypothetical. Two rounds
// alternating the two α values makes that drift VISIBLE: if round 1 and round 2
// disagree by more than the effect, there is no effect to report.
const rounds = [];
if (ALPHA_AB) {
  for (let r = 0; r < 2; r++) {
    await setAlpha(1);
    await wait(300);
    const oneMove = await measure(AMP, ROTATE);
    const oneStill = await measure(0, false);
    await setAlpha(undefined);
    await wait(300);
    const dfltMove = await measure(AMP, ROTATE);
    const dfltStill = await measure(0, false);
    rounds.push({ oneMove, oneStill, dfltMove, dfltStill });
  }
}
// ── THE RAY-CEILING A/B, SAME DISCIPLINE ───────────────────────────────────
// Interleaved and repeated for the reason the α block above spells out: one
// pass would confound the comparison with whatever drifts over a five-minute
// page. Two rounds make that drift visible — if the rounds disagree by more
// than the effect, there is no effect.
//
// STILL arms only. The still control is already the worse number here (11.257
// against the moving arm's 10.110), so whatever this is, it is not motion
// churn, and adding a mover would only add variance to the thing being read.
const ceilRounds = [];
// Read the stride the engine actually derived, rather than re-deriving it from
// an assumed pixelCount. See `publishTransport` in srcSystem.js — the boot line
// reports the BUILT stride and the runtime hatch moves it silently afterwards.
const readTransport = () => page.evaluate(() => globalThis.__giSrcTransport ?? null);
if (CEILING_AB) {
  for (let r = 0; r < 2; r++) {
    await setCeiling(TIGHT_CEILING);
    await wait(300);
    const tightT = await readTransport();
    const tight = await measure(0, false);
    await setCeiling(undefined);
    await wait(300);
    const dfltT = await readTransport();
    const dflt = await measure(0, false);
    ceilRounds.push({ tight, dflt, tightT, dfltT });
  }
}


console.log(`\n=== PER-FRAME FLICKER (${result.width}x${result.height}, ${result.frames} frames, ${ROTATE ? "ROTATING box 2-axis 0.6rad/s" : "sub-voxel mover"}) ===`);
console.log(`  kept ${result.kept} px, excluded ${result.excluded} (mover footprint)`);
console.log(`  mean reversals/px       ${result.meanReversals.toFixed(3)}   <- THE FLICKER METRIC`);
console.log(`  popped px (>=3 rev)     ${result.poppedPct.toFixed(1)}%`);
console.log(`  mean changed frames/px  ${result.meanChangedFrames.toFixed(1)} of ${result.frames}`);
console.log(`  histogram [0, 1-2, 3-5, 6-10, >10] = ${result.revHist.join(", ")}`);
console.log(`  step amplitude: changedPx=${result.changedPx} p95=${result.stepP95.toFixed(4)} max=${result.stepMax.toFixed(4)} meanWalk=${result.meanWalk.toFixed(3)}   <- THE POPPING METRIC`);
console.log(`
=== STILL CONTROL (same page, same load) ===`);
console.log(`  still reversals/px      ${still.meanReversals.toFixed(3)}   step p95 ${still.stepP95.toFixed(4)}`);
const ex = (m, s2) => (s2 > 1e-9 ? ((m - s2) / s2) * 100 : NaN);
console.log(`
  MOTION-INDUCED EXCESS OVER THE STILL CONTROL — the only quotable figure:`);
console.log(`    reversals  ${still.meanReversals.toFixed(3)} -> ${result.meanReversals.toFixed(3)}   +${ex(result.meanReversals, still.meanReversals).toFixed(0)}%`);
console.log(`    step p95   ${still.stepP95.toFixed(4)} -> ${result.stepP95.toFixed(4)}   +${ex(result.stepP95, still.stepP95).toFixed(0)}%`);

if (rounds.length) {
  // ══ AND THE MOTION-EXCESS RATIO IS THE WRONG STATISTIC FOR THIS A/B ══════
  //
  // "Excess over the still control" is the right figure for comparing two
  // BUILDS at one α, which is what it was written for: the control cancels the
  // page's load. It falls apart across α, because temporal accumulation moves
  // the CONTROL — at α=1 every pixel churns every frame from the R2 jitter
  // alone, so the still floor saturates and the moving arm has nothing to rise
  // above (measured: still 6.919, moving 6.815, i.e. MINUS 2%). Dividing the
  // two excesses then yields whatever the noise near zero happens to give;
  // the first version of this block printed -15.6 and meant nothing by it.
  //
  // Within ONE page the raw counts are comparable — that is exactly the
  // condition the still-control note above establishes — so the A/B reports
  // them directly, at both α, moving AND still, over two interleaved rounds.
  console.log(`
=== TEMPORAL A/B (alpha 1 = single-frame vs the shipping default) ===`);
  console.log("  round  arm       reversals mv/still   stepP95 mv/still   walk mv/still");
  const row = (i, name, mv, st) => console.log(
    `  ${i}      ${name.padEnd(9)} ${mv.meanReversals.toFixed(3)} / ${st.meanReversals.toFixed(3)}` +
    `        ${mv.stepP95.toFixed(4)} / ${st.stepP95.toFixed(4)}` +
    `     ${mv.meanWalk.toFixed(3)} / ${st.meanWalk.toFixed(3)}`);
  for (const [i, r] of rounds.entries()) {
    row(i + 1, "alpha 1", r.oneMove, r.oneStill);
    row(i + 1, "default", r.dfltMove, r.dfltStill);
  }
  const mean = (f) => rounds.reduce((a, r) => a + f(r), 0) / rounds.length;
  const revRatio = mean((r) => r.oneMove.meanReversals) / Math.max(1e-9, mean((r) => r.dfltMove.meanReversals));
  const stillRatio = mean((r) => r.oneStill.meanReversals) / Math.max(1e-9, mean((r) => r.dfltStill.meanReversals));
  const stepRatio = mean((r) => r.oneMove.stepP95) / Math.max(1e-9, mean((r) => r.dfltMove.stepP95));
  const walkRatio = mean((r) => r.oneMove.meanWalk) / Math.max(1e-9, mean((r) => r.dfltMove.meanWalk));
  const spread = (f) => {
    const v = rounds.map(f);
    return Math.abs(v[0] - v[1]) / Math.max(1e-9, (v[0] + v[1]) / 2) * 100;
  };
  console.log(`
  round-to-round spread: ${spread((r) => r.oneMove.meanReversals).toFixed(0)}% (alpha 1), ` +
    `${spread((r) => r.dfltMove.meanReversals).toFixed(0)}% (default) — the effect must clear this`);
  console.log(`  ACCUMULATION DIVIDES per-frame reversals by ${revRatio.toFixed(2)}x moving, ${stillRatio.toFixed(2)}x still`);
  console.log(`  step p95 x${stepRatio.toFixed(2)} moving   mean walk x${walkRatio.toFixed(2)} moving`);
  // ══ THE STEP METRIC IS A SIGNAL DETECTOR, NOT A NOISE ONE ═══════════════
  // If the worst per-pixel step were value noise, α would cut it and the STILL
  // arm would show it too. The 2x2 below is what separates the two readings:
  // a step amplitude that barely moves with α but collapses when the mover
  // stops is REAL geometric change — a rotating box genuinely alters what a
  // probe sees — and smoothing it would be smoothing the signal.
  const stillStep1 = mean((r) => r.oneStill.stepP95);
  const stillStepD = mean((r) => r.dfltStill.stepP95);
  const moveStep1 = mean((r) => r.oneMove.stepP95);
  const moveStepD = mean((r) => r.dfltMove.stepP95);
  console.log(`  step p95 2x2:  alpha1 ${moveStep1.toFixed(4)} moving / ${stillStep1.toFixed(4)} still ` +
    `(x${(moveStep1 / Math.max(1e-9, stillStep1)).toFixed(1)})   ` +
    `default ${moveStepD.toFixed(4)} / ${stillStepD.toFixed(4)} (x${(moveStepD / Math.max(1e-9, stillStepD)).toFixed(1)})`);
}

// ── THE RAY-CEILING VERDICT ─────────────────────────────────────────────────
//
// Reported as RAW still-arm counts per round, never as a ratio of excesses:
// §12.24 recorded that the motion-excess statistic BREAKS across a temporal
// change (it moves the control as well as the arm, and printed −15.6 once).
// Here both arms are still, so the raw number is the comparable one.
if (ceilRounds.length) {
  console.log(`
=== RAY CEILING A/B (still arms, interleaved x${ceilRounds.length}) ===`);
  for (const [i, r] of ceilRounds.entries()) {
    console.log(
      `  round ${i + 1}:  tight(${TIGHT_CEILING}) ${r.tight.meanReversals.toFixed(3)} rev/px ` +
      `(popped ${r.tight.poppedPct.toFixed(1)}%, step p95 ${r.tight.stepP95.toFixed(4)})` +
      `   vs   default ${r.dflt.meanReversals.toFixed(3)} rev/px ` +
      `(popped ${r.dflt.poppedPct.toFixed(1)}%, step p95 ${r.dflt.stepP95.toFixed(4)})`,
    );
  }
  const tightMean = ceilRounds.reduce((s, r) => s + r.tight.meanReversals, 0) / ceilRounds.length;
  const dfltMean = ceilRounds.reduce((s, r) => s + r.dflt.meanReversals, 0) / ceilRounds.length;
  // ⚠ THE RAW REVERSAL COUNT IS CONFOUNDED BY THE THING BEING TESTED.
  // A pixel can only reverse on a frame where its value CHANGED, and a stride-S
  // transport refreshes each pixel once every S frames. So the count falls with
  // S for a purely mechanical reason — "refreshed less often" and "more stable"
  // are the same number here. Dividing by the refresh count separates them, and
  // THAT is the statistic the decay correction makes a claim about: `keep =
  // (1-alpha)^(1/S)` says a refresh should land the same step at any S, not
  // that there should be fewer of them.
  const strideOf = (t) => (t && t.stride > 0 ? t.stride : NaN);
  const tightStride = strideOf(ceilRounds[0].tightT);
  const dfltStride = strideOf(ceilRounds[0].dfltT);
  // The arm's OWN frame count, not the FRAMES env var — `measure` is free to
  // return fewer, and a normalisation divided by a number the run did not use
  // is the same class of error as the confound it is correcting.
  const perRefresh = (arm, stride) => (arm.meanReversals * stride) / arm.frames;
  const tightPR = ceilRounds.reduce((s, r) => s + perRefresh(r.tight, tightStride), 0) / ceilRounds.length;
  const dfltPR = ceilRounds.reduce((s, r) => s + perRefresh(r.dflt, dfltStride), 0) / ceilRounds.length;
  const tightP95 = ceilRounds.reduce((s, r) => s + r.tight.stepP95, 0) / ceilRounds.length;
  const dfltP95 = ceilRounds.reduce((s, r) => s + r.dflt.stepP95, 0) / ceilRounds.length;
  // Round-to-round spread on the SAME configuration is the noise floor. An
  // effect smaller than it is not an effect, and saying so here is cheaper than
  // rediscovering it from a table later.
  const spread = ceilRounds.length > 1
    ? Math.abs(ceilRounds[0].dflt.meanReversals - ceilRounds[1].dflt.meanReversals)
    : NaN;
  console.log(`  strides: tight ${tightStride} (ceiling ${ceilRounds[0].tightT?.ceiling}), ` +
    `default ${dfltStride} (ceiling ${ceilRounds[0].dfltT?.ceiling}), ` +
    `pixelCount ${ceilRounds[0].dfltT?.pixelCount}, threads ${ceilRounds[0].dfltT?.threads}`);
  console.log(`  raw reversals/px: tight ${tightMean.toFixed(3)}  vs  default ${dfltMean.toFixed(3)}   ` +
    `(${((tightMean / dfltMean - 1) * 100).toFixed(0)}%)  <- CONFOUNDED, see above`);
  console.log(`  round-to-round spread on the DEFAULT arm: ${spread.toFixed(3)} — the noise floor`);
  console.log(`  reversals per REFRESH: tight ${tightPR.toFixed(4)}  vs  default ${dfltPR.toFixed(4)}   ` +
    `(${((tightPR / dfltPR - 1) * 100).toFixed(0)}%)  <- THE UNCONFOUNDED ONE`);
  console.log(`  step p95 (magnitude of a change, already per-change): ` +
    `tight ${tightP95.toFixed(4)}  vs  default ${dfltP95.toFixed(4)}   ` +
    `(${((tightP95 / dfltP95 - 1) * 100).toFixed(0)}%)`);
  // Both surviving statistics must agree before this says the correction holds.
  // Per-refresh reversal RATE and per-change step MAGNITUDE fail differently: an
  // under-corrected decay inflates the magnitude (a bin loses more evidence
  // between refreshes, so the refresh lands a bigger jump) without necessarily
  // changing how often the sign flips.
  const prExcess = tightPR / dfltPR - 1;
  const p95Excess = tightP95 / dfltP95 - 1;
  const TOL = 0.25;
  if (prExcess > TOL || p95Excess > TOL) {
    console.log("  ⇒ A LARGER STRIDE STILL FLICKERS MORE PER REFRESH. The per-frame decay");
    console.log("     correction is not sufficient — look at MIN_WEIGHT retirement, not at alpha.");
  } else {
    console.log("  ⇒ PER-REFRESH FLICKER IS STRIDE-INVARIANT, which is exactly what");
    console.log("     `keep = (1-alpha)^(1/stride)` claims to buy. The stride is NOT the flicker");
    console.log(`     source; the residual ${dfltPR.toFixed(3)} reversals and ${dfltP95.toFixed(4)} step per refresh are`);
    console.log("     what a refresh costs at this sample count, i.e. MONTE CARLO NOISE.");
  }
}

await browser.close();
process.exit(0);
