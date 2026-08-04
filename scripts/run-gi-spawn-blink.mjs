// SPAWN-BLINK INSTRUMENT — "the whole GI blinks black when a mesh spawns".
//
// Per-frame MEAN LUMINANCE of the GI resolve target (fixed-point atomic sum
// over a pixel stride, one slot per frame, single readback at the end), with
// an entity.create fired mid-run. Alongside each frame it records the signals
// a diagnosis needs: renderSuspended, renderer.info.compute.calls delta, and
// the IDENTITY of the resolve target (a rebuild that swaps targets re-binds
// the accumulator to the new texture and logs the frame — a swap gap is one
// candidate mechanism for the blink; a zeroed radiance field is the other).
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-spawn-blink.mjs
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   FRAMES=720       total measured frames (spawn fires at SPAWN_AT)
//   SPAWN_AT=180     frame index of the entity.create
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const FRAMES = Number(process.env.FRAMES ?? 720);
const SPAWN_AT = Number(process.env.SPAWN_AT ?? 180);
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
  if (/\[gi\] built|\[gi\] occupancy backend|\[gi\] ray-hit|compile wave/.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 250)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 300)}`);
});

await page.evaluateOnNewDocument((PROJECT) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

// The editor's React tree remounts unpredictably after boot/rebuild waves
// (double-createRoot → removeChild → __editorApi gone for a stretch) — every
// api touch waits it out and retries, same armor run-gi-perf.mjs wears.
const call = async (op, args = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
    try {
      return await page.evaluate(async ({ op, args }) => {
        try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
        catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
      }, { op, args });
    } catch (err) {
      if (attempt === 2) return { ok: false, error: err?.message ?? String(err) };
      await wait(4000);
    }
  }
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
if (!giEntity) { console.log("FATAL: gi entity missing"); await browser.close(); process.exit(1); }

// Converge fully before measuring: built + the editor settle + the camera pose
// the other instruments verified.
for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(12000);
const cam = await call("viewport.setCamera", { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] });
if (!cam.ok) console.log(`  viewport.setCamera failed (${cam.error}) — measuring whatever pose is live`);
await wait(3000);

// The measurement itself gets one remount-race retry too: a dead __editorApi
// inside the evaluate throws out of the page, and losing a whole boot to that
// beat costs 4 minutes.
let result = null;
for (let attempt = 0; attempt < 2 && !result; attempt++) {
  await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
  try {
    result = await runMeasurement();
  } catch (err) {
    if (attempt === 1) throw err;
    console.log(`  measurement attempt died (${String(err.message).slice(0, 80)}) — waiting out the remount`);
    await wait(8000);
  }
}
async function runMeasurement() {
  return page.evaluate(async ({ anchorId, frames, spawnAt }) => {
  const eng = globalThis.__editorApi.entities.live(anchorId)?.engine;
  if (!eng?.renderer) throw new Error("no live engine");
  const renderer = eng.renderer;
  const giSystem = eng.modules.get("gi")?.system;
  if (!giSystem?._giTargets?.irradiance) throw new Error("no GI resolve targets");

  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uniform, uint, vec3, atomicAdd } = TSL;

  // One u32 sum slot per frame; luminance in 1/256 fixed point over a 4-pixel
  // stride. Rebinding on target swap keeps the accumulator honest across a
  // rebuild — the swap frame itself is part of the diagnosis.
  const sums = instancedArray(new Uint32Array(frames), "uint").toAtomic();
  // Second probe, one stage upstream: the radiance FIELD buffer itself (what
  // feedback writes and the cascade traces read). If the field stays lit while
  // the resolve goes black, the bug is probe/cascade/resolve-side; if the
  // field goes black too, it is composite/feedback-side.
  const fieldSums = instancedArray(new Uint32Array(frames), "uint").toAtomic();
  const frameU = uniform(0, "uint");
  const volume = giSystem.state?.volume;
  const fieldBuf = volume?.radianceBuffer;
  const fieldCells = fieldBuf ? fieldBuf.value.count : 0;
  const FIELD_STRIDE = Math.max(1, Math.floor(fieldCells / 8192));
  const fieldKernel = fieldBuf
    ? Fn(() => {
        const cell = instanceIndex.mul(uint(FIELD_STRIDE));
        const texel = fieldBuf.element(cell);
        const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722));
        atomicAdd(fieldSums.element(frameU), lum.mul(256).min(2e6).toUint());
      })().compute(Math.floor(fieldCells / FIELD_STRIDE))
    : null;
  const makeAccumulator = (targets, size) => {
    const { width, height } = size;
    const sx = Math.max(1, Math.floor(width / 128));
    const sy = Math.max(1, Math.floor(height / 96));
    const nx = Math.floor(width / sx);
    const ny = Math.floor(height / sy);
    const irrNode = texture(targets.irradiance);
    const nxU = uniform(nx, "uint");
    const kernel = Fn(() => {
      const px = instanceIndex.mod(nxU).mul(uint(sx));
      const py = instanceIndex.div(nxU).mul(uint(sy));
      const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
      const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722));
      atomicAdd(sums.element(frameU), lum.mul(256).min(2e6).toUint());
    })().compute(nx * ny);
    return { kernel, samples: nx * ny };
  };
  let targetsRef = giSystem._giTargets;
  let acc = makeAccumulator(targetsRef, giSystem._giTargetSize);

  const perFrame = [];
  let lastComputeCalls = renderer.info?.compute?.calls ?? 0;
  let spawnResult = null;
  let spawnFrame = -1;
  let rebindFrame = -1;
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (i === spawnAt) {
      spawnFrame = i;
      // Fire-and-record: the create itself is fast; the rebuild it triggers
      // lands over the following frames, which is what we're here to watch.
      globalThis.__editorApi.call("entity.create", {
        name: "__blink_probe",
        transform: { position: [5.0, 1.0, 0.0] },
        components: [{ type: "mesh", props: { geometry: "box" } }],
      }).then((v) => { spawnResult = { ok: true, value: v?.id ?? v }; })
        .catch((e) => { spawnResult = { ok: false, error: e?.message ?? String(e) }; });
    }
    const t = giSystem._giTargets;
    if (t !== targetsRef && t?.irradiance) {
      targetsRef = t;
      acc = makeAccumulator(t, giSystem._giTargetSize);
      rebindFrame = i;
    }
    frameU.value = i;
    renderer.compute(acc.kernel);
    if (fieldKernel) renderer.compute(fieldKernel);
    const calls = renderer.info?.compute?.calls ?? 0;
    perFrame.push({
      t: performance.now(),
      suspended: eng.renderSuspended === true ? 1 : 0,
      computeDelta: calls - lastComputeCalls,
    });
    lastComputeCalls = calls;
  }

  const raw = new Uint32Array(await renderer.getArrayBufferAsync(sums.value));
  const luma = Array.from(raw, (v) => v / 256 / acc.samples);
  const fieldRaw = fieldKernel
    ? new Uint32Array(await renderer.getArrayBufferAsync(fieldSums.value))
    : null;
  const fieldLuma = fieldRaw
    ? Array.from(fieldRaw, (v) => v / 256 / Math.floor(fieldCells / FIELD_STRIDE))
    : null;
  return { luma, fieldLuma, perFrame, spawnFrame, rebindFrame, spawnResult, samples: acc.samples };
  }, { anchorId: giEntity.id, frames: FRAMES, spawnAt: SPAWN_AT });
}

const { luma, perFrame, spawnFrame, rebindFrame, spawnResult } = result;
const baselineWindow = luma.slice(Math.floor(SPAWN_AT * 0.25), SPAWN_AT - 5);
const baseline = [...baselineWindow].sort((a, b) => a - b)[Math.floor(baselineWindow.length / 2)] ?? 0;
let dipMin = Infinity;
let dipMinFrame = -1;
let blinkFrames = 0;
let firstBlink = -1;
let recovered = -1;
for (let i = SPAWN_AT; i < luma.length; i++) {
  if (luma[i] < dipMin) { dipMin = luma[i]; dipMinFrame = i; }
  if (luma[i] < baseline * 0.5) {
    blinkFrames++;
    if (firstBlink < 0) firstBlink = i;
  } else if (firstBlink >= 0 && recovered < 0 && luma[i] >= baseline * 0.9) {
    recovered = i;
  }
}
const ms = (a, b) => (perFrame[b] && perFrame[a] ? (perFrame[b].t - perFrame[a].t).toFixed(0) : "?");
const suspendedFrames = perFrame.filter((f) => f.suspended).length;
const idleComputeFrames = perFrame.slice(SPAWN_AT).filter((f) => f.computeDelta === 0).length;

console.log(`\n=== SPAWN BLINK (${FRAMES} frames, spawn at ${spawnFrame}) ===`);
console.log(`  spawn result: ${JSON.stringify(spawnResult)}`);
console.log(`  baseline mean luma      ${baseline.toFixed(4)}   (median pre-spawn)`);
console.log(`  post-spawn minimum      ${dipMin.toFixed(4)} at frame ${dipMinFrame} (+${ms(spawnFrame, dipMinFrame)}ms after spawn)`);
console.log(`  blink frames (<50% baseline)  ${blinkFrames}${firstBlink >= 0 ? ` starting at ${firstBlink} (+${ms(spawnFrame, firstBlink)}ms)` : ""}`);
console.log(`  recovered to 90%        ${recovered >= 0 ? `frame ${recovered} (+${ms(spawnFrame, recovered)}ms after spawn)` : blinkFrames ? "NEVER within the window" : "no blink"}`);
console.log(`  resolve-target swap     ${rebindFrame >= 0 ? `frame ${rebindFrame} (+${ms(spawnFrame, rebindFrame)}ms)` : "none"}`);
console.log(`  renderSuspended frames  ${suspendedFrames}`);
console.log(`  post-spawn frames with ZERO gi computes  ${idleComputeFrames}`);
const stripOf = (arr, ref, from, to) => arr.slice(from, to).map((v) => (ref > 0 ? Math.min(9, Math.round((v / ref) * 5)) : 0)).join("");
const sFrom = Math.max(0, spawnFrame - 30);
const sTo = Math.min(luma.length, spawnFrame + 300);
console.log(`  resolve luma strip (5=100% of baseline), frames ${sFrom}..${sTo}:`);
console.log(`  ${stripOf(luma, baseline, sFrom, sTo)}`);
if (result.fieldLuma) {
  const fw = result.fieldLuma.slice(Math.floor(SPAWN_AT * 0.25), SPAWN_AT - 5);
  const fieldBaseline = [...fw].sort((a, b) => a - b)[Math.floor(fw.length / 2)] ?? 0;
  console.log(`  radiance FIELD strip (baseline ${fieldBaseline.toFixed(4)}) — black here = feedback side, lit here = resolve side:`);
  console.log(`  ${stripOf(result.fieldLuma, fieldBaseline, sFrom, sTo)}`);
}
console.log(blinkFrames > 0 ? "\nSPAWN-BLINK REPRODUCED" : "\nSPAWN-BLINK NOT REPRODUCED");

await browser.close();
process.exit(0);
