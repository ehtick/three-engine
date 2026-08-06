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
  if (/\[gi\] built|\[gi\] occupancy backend/.test(t)) console.log(`  ${t.slice(0, 160)}`);
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
  for (const [k, v] of Object.entries(PRESET)) globalThis[k] = v;
}, PROJECT, JSON.parse(process.env.PRESET_GLOBALS ?? "{}"));

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

const result = await page.evaluate(async ({ anchorId, moverId, frames, amp, rotate }) => {
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
}, { anchorId: giEntity.id, moverId: sphere.id, frames: FRAMES, amp: AMP, rotate: ROTATE });

console.log(`\n=== PER-FRAME FLICKER (${result.width}x${result.height}, ${result.frames} frames, ${ROTATE ? "ROTATING box 2-axis 0.6rad/s" : "sub-voxel mover"}) ===`);
console.log(`  kept ${result.kept} px, excluded ${result.excluded} (mover footprint)`);
console.log(`  mean reversals/px       ${result.meanReversals.toFixed(3)}   <- THE FLICKER METRIC`);
console.log(`  popped px (>=3 rev)     ${result.poppedPct.toFixed(1)}%`);
console.log(`  mean changed frames/px  ${result.meanChangedFrames.toFixed(1)} of ${result.frames}`);
console.log(`  histogram [0, 1-2, 3-5, 6-10, >10] = ${result.revHist.join(", ")}`);
console.log(`  step amplitude: changedPx=${result.changedPx} p95=${result.stepP95.toFixed(4)} max=${result.stepMax.toFixed(4)} meanWalk=${result.meanWalk.toFixed(3)}   <- THE POPPING METRIC`);

await browser.close();
process.exit(0);
