// HOW BIG ARE THE BLOCKS, AND WHOSE LATTICE ARE THEY?
//
// The user's complaint (2026-08-07): indirect light is "blocky and flickery" —
// colour bleed from a box and light from emissive meshes, the same way. Two
// lattices are candidates: the VOXEL/field cell and the PROBE grid. The
// artifact has a LENGTH, so the discriminator is: sweep each dial on its own
// and see which one the length follows.
//
// WHY THIS RIG AND NOT AN EXISTING ONE — the trap that voided the previous
// attempt at this question: **`autoFit: true` makes `voxelSize` and
// `probeSpacing` INERT.** GISystem #rebuild's autoFit branch derives both from
// QUALITY_BUDGETS and overwrites the props ("the manual size/voxel/probe fields
// are ignored"). Every GI rig in scripts/lib ships autoFit ON, and so does the
// user's own Cornell scene, so a sweep of either prop there compares identical
// builds. (Under autoFit there IS one way voxelSize appears to work: the
// Inspector flips `quality` to "custom" when an advanced field is edited, and
// qualityTierOf maps "custom" → "high" — so editing it in a scene saved at
// "ultra" drops the whole preset a tier and coarsens BOTH lattices at once.)
// makeBlockRig.mjs therefore runs autoFit OFF with explicit bounds, and every
// arm below reads the BUILT resolution back and refuses to report an arm whose
// dial did not move the build.
//
// THE METRIC. A patch of open floor lit only by the panel carries a smooth
// falloff plus whatever structure the machinery adds. Subtract a fitted degree-3
// surface (a polynomial has no length scale of its own, unlike the blur a
// high-pass would need) and what is left is the artifact. Its size is the
// AUTOCORRELATION half-width of that residual: a piecewise-constant field of
// block size b has a triangular ACF, 1 − k/b, so ACF = 0.5 at k = b/2 and
//
//     blockSize = 2 × (lag where the ACF crosses one half)
//
// measured separately along world x and world z, in metres via the projected
// pixel scale. Reported next to the arm's own voxel size and probe spacing, so
// "the blocks ARE the cells" is a number and not an impression.
//
// FLICKER COMES FREE. Three frames of an identical settled scene, differenced:
// the RMS is how much it flickers and the ACF of the difference is the size of
// what flickers. A settled static scene should be deterministic — anything left
// is the sampling cadence (traceParity / feedbackParity / the checker), which is
// the "dithered" half of the report.
//
// CORRECTION, 2026-08-07 — this used to read "with the field EMA and the probe
// EMA both off (rig sets temporalBlend 1, probeSmoothing 1)". BOTH CLAIMS WERE
// FALSE and every number this rig has printed was taken with the EMAs running:
// `temporalBlend` is the staging→base ingest lerp, the FIELD EMA is
// `__giFieldSmoothing` (default 0.95, no component prop exists), and at
// `probeSmoothing: 1` the adaptive mix still pins any probe moving less than 15%
// per frame at alpha ≤ 0.25. See makeBlockRig.mjs for the full derivation. The
// props are UNCHANGED (a frozen rig's arms have to stay comparable); `QUIET_EMA=1`
// is the opt-in arm that genuinely silences all three integrators.
//
// …AND SPIN MAKES IT MEAN SOMETHING. A settled static scene answers "is a frame
// reproducible", and the answer is yes (rms ~0). The user's complaint is about a
// ROTATING box, so SPIN advances the panel's yaw BETWEEN the per-arm frames and
// the same difference now answers "does a mover's rotation make the bleed jump,
// and at what size". Frame 0 is still shot at yaw 0 in every arm, so the block
// size, the modulation and the arm-vs-arm differential are measured on exactly
// the pose the non-SPIN sweep measures — only `flicker%` and `flick size`
// change meaning. (The panel is reset to yaw 0 at the top of each arm; letting
// it accumulate across arms would make the arm ÷ finest-arm differential a
// comparison of two ORIENTATIONS instead of two lattices.)
//
// A rotated panel also changes the floor's TRUE irradiance, so `flicker%` under
// SPIN is mostly the panel honestly turning. The report therefore grows a
// `detr` pair: the same frame difference with a per-line cubic fitted out, which
// the smooth relighting goes into and a lattice pop does not. Believe `detr
// size` over `flick size` whenever SPIN is on.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-block-size.mjs
//
// Env:
//   GEN_ROOT=<dir>     generated project location
//   SWEEP=voxel,probe  which dials to sweep (default both)
//   VOXELS=a,b,c       voxel sizes    (default 0.1,0.15,0.225,0.34,0.5)
//   PROBES=a,b,c       probe spacings (default 0.25,0.375,0.55,0.8)
//   BASE_VOXEL / BASE_PROBE   the value the OTHER dial is pinned at
//   MODE=emissive|albedo      panel emits, or a sun lights a green panel
//   MOVER=1            pin the panel `giMobility: "dynamic"` (exact mover,
//                      no voxels of its own — the user's rotating-box case)
//   SPIN=<deg/s>       yaw the panel about Y between the per-arm frames, in
//                      DEGREES PER SECOND of the FRAME_GAP (700 ms) between
//                      them. Unset/0 = the old still-panel behaviour, byte for
//                      byte. SPIN=1 is an ALIAS for the default 20 deg/s (14° of
//                      yaw per frame gap, 28° across the default 3 frames) — a
//                      literal one degree per second is therefore unreachable;
//                      ask for 1.001 if you want it. The alias exists so that
//                      `SPIN=1` keeps meaning "spin the mover" the way it
//                      already does in run-gi-real-shadow-probe.mjs and
//                      run-gi-shadow-perf-probe.mjs, which both read it as a
//                      plain boolean and then spin at a hardcoded 0.6 rad/s
//                      (~34 deg/s) on TWO axes. This rig is single-axis, in
//                      degrees, and slower — see the clearance budget below.
//                      SPIN implies MOVER=1: a rotating panel that still owns
//                      voxels measures re-voxelization, not the mover path.
//                      20 and not something brisker because the panel is 2m WIDE
//                      and only 0.2m thick: yawing it swings its footprint from
//                      x=0 towards the patch, which starts at x=0.6. It arrives
//                      at ~38° of total yaw, so a sweep past that has the panel
//                      standing in its own measurement. The harness computes the
//                      swept footprint for the actual SPIN×FRAMES and refuses to
//                      start when it crosses the patch edge.
//   FRAMES=3           frames captured per arm for the flicker metric
//   SETTLE=12000       ms after each rebuild
//   SHOT=<dir>         frame dumps
//   GLOBALS=a=1,b=0    live GI knobs set before any module runs
//   PROPS=k=v,k=v      GlobalIlluminationComponent props, applied ONCE after
//                      load and before any arm — the control-arm dial. Same
//                      coercion as GLOBALS. `PROPS=aoStrength=0` is the AO
//                      control arm: AO multiplies the gather output directly
//                      (giScreen's obscurance ladder) and its radius is 0.6
//                      FIXED METRES, which makes it a fixed-metre suspect in
//                      exactly the way the material-side bilateral is.
//   QUIET_EMA=1        actually silence the three temporal integrators
//                      (__giFieldSmoothing=0, __giProbeNoise=0, __giDepthAlpha=1
//                      — see QUIET_EMA_GLOBALS in lib/makeBlockRig.mjs). OFF by
//                      default: it changes what the default arm measures, and
//                      QUIET_EMA arms are not comparable with plain ones.
//   RESHOOT=3          attempts before an un-capturable arm is marked FAILED
//   RESHOOT_WAIT=1500  ms between those attempts
//   BLACK_PATCH / BLACK_FRAME   liveness thresholds for the capture guard
//   HEADED=1
//
// EXIT CODE: non-zero if any arm failed to capture. A black frame is reported as
// FAILED, never as `modulation 0.00%` — see the capture guard.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeBlockRigProject, BLOCK_RIG, QUIET_EMA_GLOBALS } from "./lib/makeBlockRig.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-block-size")).replaceAll("\\", "/");
const SWEEP = (process.env.SWEEP ?? "voxel,probe").split(",").map((s) => s.trim()).filter(Boolean);
const nums = (env, dflt) => (env ?? dflt).split(",").map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
const VOXELS = nums(process.env.VOXELS, "0.1,0.15,0.225,0.34,0.5");
const PROBES = nums(process.env.PROBES, "0.25,0.375,0.55,0.8");
const BASE_VOXEL = Number(process.env.BASE_VOXEL ?? 0.15);
const BASE_PROBE = Number(process.env.BASE_PROBE ?? 0.375);
const MODE = process.env.MODE ?? "emissive";
// SPIN, in degrees per second. `SPIN=1` is the alias for the default (see the
// header) — everything else is taken literally, including a negative value,
// which spins the other way. Unset, empty or unparseable is 0 = off.
const SPIN_DEFAULT = 20;
const SPIN_RAW = Number(process.env.SPIN ?? 0);
const SPIN = !Number.isFinite(SPIN_RAW) ? 0 : SPIN_RAW === 1 ? SPIN_DEFAULT : SPIN_RAW;
// A spinning panel that is NOT on the exact-mover path re-voxelizes every frame,
// so the difference between two frames would be the voxelizer's own churn rather
// than the mover's. Force it rather than measure the wrong thing quietly.
// DRIFT — a TRANSLATING mover, which SPIN cannot produce and which is a
// different regime, not a variation. A yaw keeps the object's AABB
// near-stationary, so dynamicObjects' translation-scaled history cut stays at
// retain ~1 and the probe lattice sees a slowly-changing occluder. A TRANSLATION
// sweeps new cells every frame, cuts field history to 0.35, and — the part that
// matters for flicker — makes the probe EMA's `boost` term pin to 1 at every
// probe the object passes, which at probeSmoothing 1 disables probe integration
// exactly where the object is (see cascadeGather's snap-arm ceiling note).
//
// The motion is the user's own repro: "moving the sphere by Y and Z in a circle
// (sin)". DRIFT is the orbit RADIUS in metres; DRIFT_DEG is how far around that
// circle each captured frame advances.
const DRIFT = Number(process.env.DRIFT ?? 0) || 0;
const DRIFT_DEG = Number(process.env.DRIFT_DEG ?? 25) || 25;
const MOVER = process.env.MOVER === "1" || SPIN !== 0 || DRIFT !== 0;
const FRAMES = Number(process.env.FRAMES ?? 3);
const SETTLE = Number(process.env.SETTLE ?? 12000);
const SHOT = process.env.SHOT ?? ".gi-shots/block-size";
// The gap between the per-arm frames, and — under SPIN — the interval the
// angular speed is integrated over.
const FRAME_GAP = 700;
const SPIN_STEP_DEG = SPIN * (FRAME_GAP / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Clamp warnings BEFORE the run rather than a puzzling flat curve after it:
// res clamps at MAX_AXIS_RES=128 and c0Grid at MAX_PROBE_AXIS=48, so a value
// past either end measures the clamp.
const tooFine = VOXELS.filter((v) => v < BLOCK_RIG.minVoxel);
const tooDense = PROBES.filter((v) => v < BLOCK_RIG.minProbe);
if (tooFine.length) console.log(`  !! voxel sizes below ${BLOCK_RIG.minVoxel.toFixed(3)} clamp at MAX_AXIS_RES: ${tooFine.join(", ")}`);
if (tooDense.length) console.log(`  !! probe spacings below ${BLOCK_RIG.minProbe.toFixed(3)} clamp at MAX_PROBE_AXIS: ${tooDense.join(", ")}`);

// SPIN's own clamp, and the same kind of failure: the panel is a 2m x 0.2m box
// centred at x = -panelT/2, so yawing it swings the wide face's corners towards
// +x at (panelT/2)|cos| + (panelW/2)|sin|. The measured patch starts at x0 =
// 0.6, and the footprint reaches it at ~38 deg. Past that the "flicker" is the
// panel itself entering frame — the largest possible signal, and not a GI one.
// (The panel's TOP corners lean the other way, to a ground-equivalent x of
// -0.58 at rest, so the footprint is always the binding edge.)
const sweptMaxX = (deg) => {
  const t = (deg * Math.PI) / 180;
  return -BLOCK_RIG.panelT / 2
    + Math.abs((BLOCK_RIG.panelT / 2) * Math.cos(t))
    + Math.abs((BLOCK_RIG.panelW / 2) * Math.sin(t));
};
if (SPIN) {
  const yaws = Array.from({ length: Math.max(FRAMES, 1) }, (_, i) => Math.abs(i * SPIN_STEP_DEG));
  const worst = Math.max(...yaws.map(sweptMaxX));
  if (worst >= BLOCK_RIG.patch.x0) {
    // Largest whole-degree step that still clears the patch, converted back to
    // deg/s over the frame gap, so the operator gets a value and not a puzzle.
    let maxStep = 0;
    for (let d = 1; d <= 90; d++) {
      if (sweptMaxX(d * (FRAMES - 1)) >= BLOCK_RIG.patch.x0) break;
      maxStep = d;
    }
    console.log(
      `FATAL: SPIN=${SPIN} deg/s over ${FRAMES} frames yaws the panel to ${Math.max(...yaws).toFixed(1)}°, ` +
        `whose footprint reaches x=${worst.toFixed(3)} — the patch starts at x=${BLOCK_RIG.patch.x0}. ` +
        `The panel would stand inside its own measurement.\n` +
        `       Use SPIN<=${((maxStep * 1000) / FRAME_GAP).toFixed(1)} at FRAMES=${FRAMES}, or fewer FRAMES.`,
    );
    process.exit(1);
  }
  console.log(`  spin clearance: worst-frame footprint reaches x=${worst.toFixed(3)}, patch starts at x=${BLOCK_RIG.patch.x0} — clear by ${(BLOCK_RIG.patch.x0 - worst).toFixed(3)}m`);
}

await makeBlockRigProject(GEN_ROOT, { voxelSize: BASE_VOXEL, probeSpacing: BASE_PROBE, mover: MOVER });
console.log(`  generated block rig at ${GEN_ROOT}`);
console.log(`  mode ${MODE}${MOVER ? " (panel pinned as an EXACT MOVER)" : ""}   sweeps: ${SWEEP.join(", ")}`);
if (SPIN) {
  if (process.env.MOVER !== "1") console.log(`  SPIN forced MOVER=1 — a spinning panel has to be on the exact-mover path`);
  console.log(
    `  spin ${SPIN} deg/s${SPIN_RAW === 1 ? " (SPIN=1 → the default)" : ""}: the panel yaws ` +
      `${SPIN_STEP_DEG.toFixed(2)}° between frames, ${(SPIN_STEP_DEG * (FRAMES - 1)).toFixed(2)}° across an arm. ` +
      `Frame 0 is still yaw 0, so only the flicker columns change meaning.`,
  );
  if (FRAMES < 2) console.log(`  !! FRAMES=${FRAMES}: with fewer than 2 frames there is no difference to spin, and no flicker metric at all`);
}
await mkdir(SHOT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1150, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) { built++; console.log(`  ${t.slice(0, 200)}`); }
  else if (/occupancy backend|dynamic-objects/i.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.message ?? String(e)).slice(0, 200)}`));

// QUIET_EMA=1 — actually quiet the temporal integrators, which the rig's
// component props DO NOT do (see the long note on `temporalBlend`/
// `probeSmoothing` in makeBlockRig.mjs: `temporalBlend` is the staging→base
// ingest lerp, not the field EMA, and the field EMA has no prop at all; and
// `probeSmoothing: 1` still pins sub-15%-delta probes at alpha ≤ 0.25).
//
// OFF BY DEFAULT ON PURPOSE. Turning it on changes what the default arm
// measures, and every number this rig has produced so far was taken with the
// EMAs running — so this ships as a separate arm rather than as a silent
// correction. QUIET_EMA arms are NOT comparable with non-QUIET_EMA arms.
// The globals go FIRST so an explicit `GLOBALS=` entry still overrides them.
const QUIET_EMA = process.env.QUIET_EMA === "1";
const GLOBALS = [
  ...(QUIET_EMA ? Object.entries(QUIET_EMA_GLOBALS).map(([k, v]) => `${k}=${v}`) : []),
  ...(process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];
if (QUIET_EMA) {
  console.log(`  QUIET_EMA: field EMA off, probe EMA a true passthrough, visibility integrators off —`);
  console.log(`             ${Object.entries(QUIET_EMA_GLOBALS).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`             (this arm is NOT comparable with a run without QUIET_EMA)`);
}
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);
await page.evaluateOnNewDocument((project, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  // THE EDITOR STOPS THE ENGINE LOOP FOR AN UNFOCUSED VIEWPORT
  // (src/editor/editorFramePacing.js — its own comment: "headless suites are
  // never focused, so without it every probe reads a sleeping engine"). Ten
  // other GI probes set this; this rig did NOT until 2026-08-07, and that is
  // the best explanation for the black arms it was silently reporting as
  // `modulation 0.00%` (a `__giMergeVisTol` sweep returned a black arm at 1.55
  // with BOTH neighbours identical to baseline to four decimals — no monotonic
  // dial does that, and the arm's `[gi] built` line was present and healthy, so
  // the build succeeded and the CAPTURE did not). Set here, in the same
  // pre-document block as GLOBALS, so it lands before any module runs.
  //
  // It is a PIN, not a fix for a broken frame — the capture guard below
  // (`shootChecked`) is what makes a lost frame loud instead of a zero.
  globalThis.__editorKeepRendering = true;
  globalThis.__giDynObjectsDebug = true;
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, GEN_ROOT, GLOBALS);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

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
const byName = (name) => entities.find((e) => e.name === name);
const giEntity = entities.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
const panel = byName("Panel");
const sun = byName("Sun");
if (!giEntity || !panel || !sun) {
  console.log("FATAL: rig entities missing");
  await browser.close();
  process.exit(1);
}
for (let i = 0; i < 120 && built === 0; i++) await wait(1000);
await wait(6000);

// The screenshot resolution must equal the CANVAS resolution: the GI resolve is
// sized from the drawing buffer, so a bigger screenshot only upsamples GI data
// that was computed at canvas size. Block size is a world quantity either way,
// but matching keeps the pixel noise floor honest.
const canvasSize = await page.evaluate(() => {
  const c = globalThis.__viewport?.canvas ?? document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
const W = Math.min(2048, Math.max(320, canvasSize?.w ?? 1400));
const H = Math.min(2048, Math.max(240, canvasSize?.h ?? 900));
console.log(`  canvas ${canvasSize?.w}x${canvasSize?.h} → screenshots at ${W}x${H}`);

// Narrow fov: see BLOCK_RIG.fov. viewport.screenshot overrides only the ASPECT,
// so a fov set here is the fov the capture uses.
await page.evaluate((fov) => {
  const cam = globalThis.__viewport?.camera;
  if (cam) { cam.fov = fov; cam.updateProjectionMatrix(); }
}, BLOCK_RIG.fov);
await must("viewport.setCamera", { position: BLOCK_RIG.eye, target: BLOCK_RIG.target });
await wait(2500);

/** Exact world→pixel through the LIVE camera (never rebuild the basis here). */
async function projectPoints(worldPoints) {
  return page.evaluate(({ pts, w, h }) => {
    const cam = globalThis.__viewport?.camera;
    if (!cam) throw new Error("no viewport camera");
    const prevAspect = cam.aspect;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const v = cam.matrixWorldInverse.elements;
    const p = cam.projectionMatrix.elements;
    const mul = (m, x, y, z, ww) => [
      m[0] * x + m[4] * y + m[8] * z + m[12] * ww,
      m[1] * x + m[5] * y + m[9] * z + m[13] * ww,
      m[2] * x + m[6] * y + m[10] * z + m[14] * ww,
      m[3] * x + m[7] * y + m[11] * z + m[15] * ww,
    ];
    const out = pts.map(([x, y, z]) => {
      const e = mul(v, x, y, z, 1);
      const c = mul(p, e[0], e[1], e[2], e[3]);
      if (!(Math.abs(c[3]) > 1e-9)) return null;
      return { x: (c[0] / c[3] * 0.5 + 0.5) * w, y: (0.5 - c[1] / c[3] * 0.5) * h };
    });
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    return out;
  }, { pts: worldPoints, w: W, h: H });
}

// ---- the patch, in pixels, plus the px/m scale on each world axis ----------
const { x0, x1, z0, z1 } = BLOCK_RIG.patch;
const cornersW = [[x0, 0, z0], [x1, 0, z0], [x0, 0, z1], [x1, 0, z1]];
const cpx = await projectPoints(cornersW);
if (cpx.some((p) => !p)) { console.log("FATAL: patch corners do not project"); await browser.close(); process.exit(1); }
const rect = {
  x: Math.round(Math.min(...cpx.map((p) => p.x))),
  y: Math.round(Math.min(...cpx.map((p) => p.y))),
  w: Math.round(Math.max(...cpx.map((p) => p.x)) - Math.min(...cpx.map((p) => p.x))),
  h: Math.round(Math.max(...cpx.map((p) => p.y)) - Math.min(...cpx.map((p) => p.y))),
};
// Which IMAGE axis each WORLD axis runs along, and how many px per metre. A
// steep camera keeps them aligned; assert it rather than assume it, because a
// 20° tilt would silently mix an x-lag with a z-lag.
const [pA, pB, pC] = await projectPoints([[x0, 0, 0], [x0 + 1, 0, 0], [x0, 0, 1]]);
const dX = { x: pB.x - pA.x, y: pB.y - pA.y };
const dZ = { x: pC.x - pA.x, y: pC.y - pA.y };
const pxPerMx = Math.hypot(dX.x, dX.y);
const pxPerMz = Math.hypot(dZ.x, dZ.y);
const skewX = (Math.atan2(Math.abs(dX.y), Math.abs(dX.x)) * 180) / Math.PI;
const skewZ = (Math.atan2(Math.abs(dZ.x), Math.abs(dZ.y)) * 180) / Math.PI;
console.log(
  `  patch ${x0}…${x1}m × ${z0}…${z1}m → px rect ${rect.w}x${rect.h} at (${rect.x},${rect.y}); ` +
    `${pxPerMx.toFixed(1)} px/m along world x, ${pxPerMz.toFixed(1)} along world z ` +
    `(image-axis skew ${skewX.toFixed(1)}°/${skewZ.toFixed(1)}° — >8° would mix the two lags)`,
);
if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > W || rect.y + rect.h > H) {
  console.log("FATAL: the patch does not fit in the frame");
  await browser.close();
  process.exit(1);
}

/**
 * The whole measurement, run in-page on the decoded PNGs of one arm.
 *
 * frames[0] is the STATIC image (block size of the artifact itself); the
 * pairwise differences are the FLICKER (how much, and at what size).
 */
async function analyze(frameB64s) {
  return page.evaluate(async ({ urls, rect, pxPerMx, pxPerMz, mode }) => {
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const { x, y, w, h } = rect;

    /** One frame → the scalar field the measurement is about. */
    async function fieldOf(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(x, y, w, h).data;
      const out = new Float64Array(w * h);
      let clipped = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = toLinear(d[i] / 255), gg = toLinear(d[i + 1] / 255), b = toLinear(d[i + 2] / 255);
        if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) clipped++;
        // ALBEDO mode measures the panel's HUE arriving on a floor the sun also
        // lights white; EMISSIVE mode has no white term at all, so luminance IS
        // the transport.
        out[p] = mode === "albedo"
          ? (r + b > 1e-6 ? (2 * gg) / (r + b) : 0)
          : 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      }
      return { field: out, clipped: clipped / (w * h) };
    }

    /** Solve a small symmetric system in place (Gauss + partial pivot). */
    function solve(A, b) {
      const T = b.length;
      const M = A.map((row, a) => [...row, b[a]]);
      for (let col = 0; col < T; col++) {
        let piv = col;
        for (let r = col + 1; r < T; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        [M[col], M[piv]] = [M[piv], M[col]];
        if (Math.abs(M[col][col]) < 1e-18) return null;
        for (let r = 0; r < T; r++) {
          if (r === col) continue;
          const f = M[r][col] / M[col][col];
          for (let c = col; c <= T; c++) M[r][c] -= f * M[col][c];
        }
      }
      return M.map((row, a) => row[T] / row[a]);
    }

    /**
     * Relative residual, detrended PER LINE along the axis being measured: each
     * line parallel to that axis gets its own cubic removed and is divided by
     * its own mean.
     *
     * PER LINE, not one 2D surface fit, and normalised by a line MEAN, not by
     * the fit's local value. Both were learned from the first run of this rig:
     * a 2D cubic could not follow a 1/d²-ish falloff across the patch, so a
     * large-scale trend survived into the residual and pushed the ACF to 0.99
     * at every lag ("blocks" of 1.4m that were just the falloff); and dividing
     * by a fit that passes near zero in the dark far field reported residuals
     * 39× the signal. A 1D cubic along the measurement direction has no such
     * trouble, and a scalar per-line mean cannot blow up.
     *
     * The price is an upper limit: structure larger than roughly a third of the
     * patch is absorbed by the cubic. The patch span is printed so that ceiling
     * is visible next to any number this produces.
     */
    // `denomFixed > 0` overrides the per-line mean with a constant, which is
    // what the FLICKER path needs: a frame difference is already a fraction of
    // the level and its per-line mean is ~0, so dividing by that mean would
    // explode. Omitted (the default) reproduces the original behaviour exactly.
    function lineResidual(field, axis, denomFixed = 0) {
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const get = (o, i) => (axis === "x" ? field[o * w + i] : field[i * w + o]);
      const resid = new Float64Array(w * h);
      const T = 4;
      let meanAcc = 0, dark = 0, lines = 0;
      for (let o = 0; o < outer; o++) {
        const A = Array.from({ length: T }, () => new Float64Array(T));
        const bv = new Float64Array(T);
        let sum = 0;
        for (let i = 0; i < inner; i++) {
          const t = (2 * i) / (inner - 1) - 1;
          const B = [1, t, t * t, t * t * t];
          const val = get(o, i);
          sum += val;
          for (let a = 0; a < T; a++) {
            bv[a] += B[a] * val;
            for (let c = 0; c < T; c++) A[a][c] += B[a] * B[c];
          }
        }
        const mean = sum / inner;
        meanAcc += mean;
        lines++;
        if (mean < 2e-3) dark++;
        const coef = solve(A, bv);
        const denom = denomFixed > 0 ? denomFixed : Math.max(mean, 1e-6);
        for (let i = 0; i < inner; i++) {
          const t = (2 * i) / (inner - 1) - 1;
          const fit = coef ? coef[0] + coef[1] * t + coef[2] * t * t + coef[3] * t * t * t : mean;
          const v = (get(o, i) - fit) / denom;
          if (axis === "x") resid[o * w + i] = v; else resid[i * w + o] = v;
        }
      }
      return { resid, mean: meanAcc / Math.max(lines, 1), darkFrac: dark / Math.max(lines, 1) };
    }

    /**
     * Unbiased autocorrelation of `resid` along one image axis, and the block
     * size it implies. A piecewise-constant field of block b has ACF 1 − k/b,
     * so the half-crossing is at b/2. Reported two ways because 8-bit
     * quantisation is a delta at lag 0 that deflates every other lag:
     *   half  — crossing of 0.5 with ACF(0) = 1 (biased small by that noise)
     *   halfC — crossing of half an ACF(0) EXTRAPOLATED from lags 1..5, which
     *           is what the signal alone would have had
     */
    function acf(resid, axis, maxLag) {
      const num = new Float64Array(maxLag + 1);
      const cnt = new Float64Array(maxLag + 1);
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const at = (o, i) => (axis === "x" ? resid[o * w + i] : resid[i * w + o]);
      for (let o = 0; o < outer; o++) {
        for (let k = 0; k <= maxLag && k < inner; k++) {
          let s = 0;
          for (let i = 0; i + k < inner; i++) s += at(o, i) * at(o, i + k);
          num[k] += s;
          cnt[k] += inner - k;
        }
      }
      const a = new Float64Array(maxLag + 1);
      for (let k = 0; k <= maxLag; k++) a[k] = num[k] / Math.max(cnt[k], 1);
      const var0 = a[0] || 1e-30;
      const norm = Array.from(a, (v) => v / var0);
      const cross = (level) => {
        for (let k = 1; k <= maxLag; k++) {
          if (norm[k] <= level) {
            const prev = norm[k - 1];
            return k - 1 + (prev - level) / Math.max(prev - norm[k], 1e-12);
          }
        }
        return NaN;
      };
      // Extrapolate ACF(0) from lags 1..5 (least squares line) — the noise
      // delta lives only at lag 0.
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = 1; k <= Math.min(5, maxLag); k++) { n++; sx += k; sy += norm[k]; sxx += k * k; sxy += k * norm[k]; }
      const slope = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-12);
      const a0 = sy / n - slope * (sx / n);
      return {
        half: cross(0.5),
        halfC: cross(Math.max(a0, 1e-6) / 2),
        zero: cross(0),
        a0extrap: a0,
        curve: Array.from(norm.slice(0, Math.min(norm.length, 40)), (v) => +v.toFixed(3)),
        rms: Math.sqrt(Math.max(var0, 0)),
      };
    }

    const frames = [];
    for (const u of urls) frames.push(await fieldOf(u));
    // A third of the patch — past that the per-line cubic has eaten the signal
    // and the ACF tail is meaningless.
    const maxLagX = Math.max(4, Math.floor(w / 3));
    const maxLagZ = Math.max(4, Math.floor(h / 3));
    const rx = lineResidual(frames[0].field, "x");
    const rz = lineResidual(frames[0].field, "z");
    const ax = acf(rx.resid, "x", maxLagX);
    const az = acf(rz.resid, "z", maxLagZ);

    // FLICKER: last frame vs first, as a fraction of the patch level. The ACF of
    // that difference says how big the flickering patches are. No detrend — a
    // difference of two frames of the same static scene has no trend to remove.
    let flick = null;
    if (frames.length > 1) {
      const diff = new Float64Array(w * h);
      const lvl = Math.max(rx.mean, 1e-6);
      let acc = 0;
      for (let p = 0; p < w * h; p++) {
        diff[p] = (frames[frames.length - 1].field[p] - frames[0].field[p]) / lvl;
        acc += diff[p] * diff[p];
      }
      const rms = Math.sqrt(acc / (w * h));
      // Below ~one quantisation step the "flicker" is the PNG, not the field,
      // and its ACF is a delta whose half-width is meaningless.
      const real = rms > 3e-3;
      const dx = real ? acf(diff, "x", maxLagX) : null;
      const dz = real ? acf(diff, "z", maxLagZ) : null;
      // DETRENDED FLICKER — only ever non-null under SPIN, because a still
      // scene's difference never clears `real`.
      //
      // A panel that has ROTATED between the two frames changes the floor's
      // TRUE irradiance as well as whatever the machinery adds: the emitting
      // face turns, its projected solid angle shrinks, the cosine term slides.
      // All of that is smooth and patch-sized, it dominates `rms`, and it drags
      // the raw ACF's half-width up towards the patch — so the raw pair alone
      // cannot tell "the mover popped" from "the mover legitimately dimmed".
      // Removing the same per-line cubic the single-frame residual removes (but
      // NOT re-normalising — `diff` is already a fraction of the level) leaves
      // only structure too small to be relighting. THAT is the pop.
      const dtx = real ? lineResidual(diff, "x", 1) : null;
      const dtz = real ? lineResidual(diff, "z", 1) : null;
      const dxd = dtx ? acf(dtx.resid, "x", maxLagX) : null;
      const dzd = dtz ? acf(dtz.resid, "z", maxLagZ) : null;
      flick = {
        rms, halfX: dx?.halfC ?? NaN, halfZ: dz?.halfC ?? NaN, curveX: dx?.curve.slice(0, 16) ?? null,
        detrended: dxd
          ? { rms: dxd.rms, halfX: dxd.halfC, halfZ: dzd?.halfC ?? NaN, curveX: dxd.curve.slice(0, 16) }
          : null,
      };
    }

    return {
      mean: rx.mean,
      darkFrac: Math.max(rx.darkFrac, rz.darkFrac),
      clipped: frames[0].clipped,
      residRms: ax.rms,
      residRmsZ: az.rms,
      x: { half: ax.half, halfC: ax.halfC, zero: ax.zero, a0: ax.a0extrap, curve: ax.curve },
      z: { half: az.half, halfC: az.halfC, zero: az.zero, a0: az.a0extrap, curve: az.curve },
      flick,
      maxLagX, maxLagZ,
    };
  }, { urls: frameB64s.map((b) => `data:image/png;base64,${b}`), rect, pxPerMx, pxPerMz, mode: MODE });
}

/**
 * THE DIFFERENTIAL METRIC, and the one to believe.
 *
 * `arm ÷ reference − 1`, per pixel, against the FINEST arm of the same sweep.
 * The scene's true irradiance is identical in both, so it cancels exactly —
 * no polynomial, no blur, and therefore no length scale imposed by the
 * instrument. What survives is precisely "what this dial did to the picture",
 * and the ACF of it is the size of what it did.
 *
 * The detrended single-frame numbers above cannot do this: a per-line cubic
 * cannot follow the panel's falloff exactly, and its misfit is a fixed ~0.3-0.5m
 * shape that lands in the residual of EVERY arm — which is how the first sweep
 * reported a ~0.50m block in z for all nine arms including ones that differed
 * by 5x.
 */
async function compare(refB64, armB64) {
  return page.evaluate(async ({ refUrl, armUrl, rect, mode }) => {
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const { x, y, w, h } = rect;
    async function fieldOf(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(x, y, w, h).data;
      const out = new Float64Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = toLinear(d[i] / 255), gg = toLinear(d[i + 1] / 255), b = toLinear(d[i + 2] / 255);
        out[p] = mode === "albedo" ? (r + b > 1e-6 ? (2 * gg) / (r + b) : 0) : 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      }
      return out;
    }
    const A = await fieldOf(armUrl);
    const R = await fieldOf(refUrl);
    const diff = new Float64Array(w * h);
    let acc = 0, n = 0;
    for (let p = 0; p < w * h; p++) {
      if (R[p] < 1e-4) { diff[p] = 0; continue; }
      diff[p] = A[p] / R[p] - 1;
      acc += diff[p] * diff[p]; n++;
    }
    const rms = Math.sqrt(acc / Math.max(n, 1));
    // Same unbiased ACF as the single-frame metric, inlined so this call does
    // not depend on the other evaluate's scope.
    const acf = (axis, maxLag) => {
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const at = (o, i) => (axis === "x" ? diff[o * w + i] : diff[i * w + o]);
      const num = new Float64Array(maxLag + 1), cnt = new Float64Array(maxLag + 1);
      for (let o = 0; o < outer; o++) {
        for (let k = 0; k <= maxLag && k < inner; k++) {
          let s = 0;
          for (let i = 0; i + k < inner; i++) s += at(o, i) * at(o, i + k);
          num[k] += s; cnt[k] += inner - k;
        }
      }
      // Mean-removed: a uniform brightness shift between arms (a real thing —
      // a coarser lattice loses energy) is a DC term that would otherwise read
      // as infinite correlation length.
      let mean = 0;
      for (let p = 0; p < w * h; p++) mean += diff[p];
      mean /= w * h;
      const a = new Float64Array(maxLag + 1);
      for (let k = 0; k <= maxLag; k++) a[k] = num[k] / Math.max(cnt[k], 1) - mean * mean;
      const norm = Array.from(a, (v) => v / (a[0] || 1e-30));
      let cross = NaN;
      for (let k = 1; k <= maxLag; k++) {
        if (norm[k] <= 0.5) { cross = k - 1 + (norm[k - 1] - 0.5) / Math.max(norm[k - 1] - norm[k], 1e-12); break; }
      }
      return { half: cross, curve: Array.from(norm.slice(0, 30), (v) => +v.toFixed(3)), dc: mean };
    };
    const maxLagX = Math.max(4, Math.floor(w / 2));
    const maxLagZ = Math.max(4, Math.floor(h / 2));
    const ax = acf("x", maxLagX), az = acf("z", maxLagZ);
    return { rms, dc: ax.dc, halfX: ax.half, halfZ: az.half, curveX: ax.curve, curveZ: az.curve };
  }, { refUrl: `data:image/png;base64,${refB64}`, armUrl: `data:image/png;base64,${armB64}`, rect, mode: MODE });
}

/** What the build ACTUALLY used — the guard against an inert dial. */
const builtState = () =>
  page.evaluate(async () => {
    let sys = null;
    const list = await globalThis.__editorApi.call("entity.list", {});
    for (const e of list ?? []) {
      const s = globalThis.__editorApi.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
      if (s) { sys = s; break; }
    }
    const st = sys?.state;
    if (!st) return { error: "no gi system" };
    const cell = st.volume?.cell?.value ?? st.volume?.cell ?? null;
    return {
      res: st.volume?.res ? { x: st.volume.res.x, y: st.volume.res.y, z: st.volume.res.z } : null,
      cell: cell ? { x: +cell.x.toFixed(4), y: +cell.y.toFixed(4), z: +cell.z.toFixed(4) } : null,
      c0Grid: st.c0Grid ? { x: st.c0Grid.x, y: st.c0Grid.y, z: st.c0Grid.z } : null,
      probeSpacing: st.probeSpacing,
      autoFit: st.autoFit,
      size: st.buildSize ? [+st.buildSize.x.toFixed(2), +st.buildSize.y.toFixed(2), +st.buildSize.z.toFixed(2)] : null,
      adopted: sys._dynSet?.count?.() ?? 0,
    };
  });

async function shoot(tag) {
  const shot = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  await writeFile(path.join(SHOT, `block-${tag}.png`), Buffer.from(shot.__image.base64, "base64"));
  return shot.__image.base64;
}

// ---- THE CAPTURE GUARD -------------------------------------------------------
//
// A LOST CAPTURE AND A PERFECT RESULT LOOK IDENTICAL IN THIS TABLE, and that is
// the worst failure an instrument can have. Measured 2026-08-07: a
// `__giMergeVisTol` ablation returned
//
//   (baseline)              modulation x 9.39%  z 19.51%  level 0.2345
//   __giMergeVisTol=1.7     modulation x 9.39%  z 19.51%  level 0.2345
//   __giMergeVisTol=1.55    modulation x 0.00%  z  0.00%  level 0.0000  <- BLACK
//   __giMergeVisTol=1.4     modulation x 9.39%  z 19.51%  level 0.2345
//
// — a black arm between two arms identical to baseline to four decimals. No
// monotonic dial does that, the arm's `[gi] built` line was present and healthy,
// and the rig printed the failure as `0.00%`, i.e. as an EXTRAORDINARILY GOOD
// result. An earlier coarse sweep lost three arms the same way. Suspected cause:
// no `__editorKeepRendering` (now set above), which is opt-in wake/sleep and so
// fails intermittently rather than constantly — exactly this signature.
//
// WHY BOTH A FRAME TEST AND A PATCH TEST. The panel is emissive (strength 4) and
// sits inside this camera's frustum by construction — the patch starts at x=0.6
// specifically to CLEAR the panel's silhouette, so the panel is in shot — and in
// albedo mode a sun lights the whole floor. So:
//   · frameMax ≈ 0  → nothing rendered at all. A lost capture, full stop.
//   · patch black but the frame is lit → the floor genuinely received nothing.
//     Also not a measurement of "0% modulation" (the residual of a constant is
//     0/0), but it is a different diagnosis, so it is reported as a different
//     message and still fails the arm.
// Thresholds are two decades below one 8-bit step, so nothing that rendered can
// trip them; override via BLACK_PATCH / BLACK_FRAME if a legitimately dark arm
// ever needs measuring.
const BLACK_PATCH = Number(process.env.BLACK_PATCH ?? 1e-5);
const BLACK_FRAME = Number(process.env.BLACK_FRAME ?? 2 / 255);
const RESHOOT_ATTEMPTS = Math.max(1, Number(process.env.RESHOOT ?? 3));
const RESHOOT_WAIT = Number(process.env.RESHOOT_WAIT ?? 1500);

/** Liveness of one capture: whole-frame peak + patch level. */
async function frameLevel(b64) {
  return page.evaluate(async ({ url, rect: r }) => {
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    // Whole frame, every 4th pixel — this is a liveness check, not a metric.
    const full = g.getImageData(0, 0, img.width, img.height).data;
    let frameMax = 0;
    for (let i = 0; i < full.length; i += 16) {
      const m = Math.max(full[i], full[i + 1], full[i + 2]);
      if (m > frameMax) frameMax = m;
    }
    const d = g.getImageData(r.x, r.y, r.w, r.h).data;
    let sum = 0, lit = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.2126 * toLinear(d[i] / 255) + 0.7152 * toLinear(d[i + 1] / 255) + 0.0722 * toLinear(d[i + 2] / 255);
      if (Math.max(d[i], d[i + 1], d[i + 2]) > 1) lit++;
      n++;
    }
    return { patchMean: sum / Math.max(n, 1), patchLitFrac: lit / Math.max(n, 1), frameMax: frameMax / 255 };
  }, { url: `data:image/png;base64,${b64}`, rect });
}

/**
 * `shoot` + the guard: re-take a black frame up to RESHOOT_ATTEMPTS times, then
 * give up LOUDLY. Returns `{ b64, ok, why }` — callers must propagate `ok`, and
 * a run with any `ok: false` exits non-zero. NEVER returns zeros-as-data.
 */
async function shootChecked(tag) {
  let last = null;
  for (let a = 0; a < RESHOOT_ATTEMPTS; a++) {
    const b64 = await shoot(a === 0 ? tag : `${tag}-retry${a}`);
    const lv = await frameLevel(b64);
    last = { b64, lv };
    const frameDead = lv.frameMax <= BLACK_FRAME;
    const patchDead = lv.patchMean <= BLACK_PATCH;
    if (!frameDead && !patchDead) return { b64, ok: true, why: null, lv, attempts: a + 1 };
    const why = frameDead
      ? `LOST CAPTURE — the whole frame is black (peak ${(lv.frameMax * 255).toFixed(1)}/255); the engine was not rendering`
      : `patch is black (mean ${lv.patchMean.toExponential(2)}, ${(lv.patchLitFrac * 100).toFixed(1)}% lit px) while the frame is lit — the floor received nothing`;
    console.log(`    !! ${tag}: ${why} — attempt ${a + 1}/${RESHOOT_ATTEMPTS}`);
    // Re-assert the pin and give the loop a beat; if the engine was asleep this
    // is what wakes it, and if it was not, the retry costs one screenshot.
    await page.evaluate(() => { globalThis.__editorKeepRendering = true; });
    await wait(RESHOOT_WAIT);
  }
  const lv = last.lv;
  const why = lv.frameMax <= BLACK_FRAME
    ? `black frame after ${RESHOOT_ATTEMPTS} attempts (frame peak ${(lv.frameMax * 255).toFixed(1)}/255)`
    : `black patch after ${RESHOOT_ATTEMPTS} attempts (patch mean ${lv.patchMean.toExponential(2)})`;
  console.log(`    !! ${tag}: FAILED — ${why}. This arm produced NO measurement; it is not a zero.`);
  return { b64: last.b64, ok: false, why, lv, attempts: RESHOOT_ATTEMPTS };
}

// Every arm that could not be captured, so the process can exit non-zero and the
// operator cannot mistake a hole in the table for a result.
const failures = [];

/**
 * Absolute yaw, in degrees, about the panel's own centre (its local origin IS
 * its centre — the box mesh is placed by `position`, not by an offset pivot),
 * so a spin sweeps the emitting face past the patch without translating it.
 *
 * ABSOLUTE, not incremental: `entity.setTransform` is undoable and goes through
 * the command bus, so an increment read back from a stale `panel.transform`
 * would drift. The x and z channels are carried over from the rig's authored
 * rotation instead of being zeroed, which keeps this correct if the rig ever
 * ships a tilted panel.
 *
 * STEPPED, and deliberately not the rAF loop run-gi-real-shadow-probe.mjs uses.
 * That probe wants CONTINUOUS motion because it is timing frames and watching
 * the adoption lifecycle; this one measures the SIZE of structure in a settled
 * image, and a continuously-spinning capture smears the thing being sized. So
 * the panel jumps one step, holds for the whole FRAME_GAP, and is photographed
 * at rest. The risk that buys — a mover demoted back to the voxel path while it
 * sits still — is what the `movers N→N` readback per arm is there to catch, and
 * an explicit `giMobility: "dynamic"` pin is supposed to hold through rest
 * (gi-gpu-smoke's dynobj=7 arm asserts exactly that).
 */
const panelBaseRot = panel.transform?.rotation ?? [0, 0, 0];
async function setPanelYawDeg(deg) {
  await must("entity.setTransform", {
    id: panel.id,
    rotation: [panelBaseRot[0], panelBaseRot[1] + (deg * Math.PI) / 180, panelBaseRot[2]],
  });
}

/**
 * Absolute orbit position for frame `i` — a circle in the Y/Z plane of radius
 * DRIFT, centred so that frame 0 sits exactly on the authored pose (offset
 * starts at zero). Same ABSOLUTE-not-incremental discipline as the yaw above:
 * setTransform goes through the command bus, so accumulating from a read-back
 * transform would drift.
 *
 * Y AND Z, matching the report. Y alone would change only the object's height
 * above the floor patch (a smooth falloff); Z alone would slide it along. The
 * circle does both, so the patch sees the occluder approach, pass and recede
 * while its distance to the floor also varies — which is what makes every probe
 * near the path register a large per-frame delta.
 */
const panelBasePos = panel.transform?.position ?? [0, 0, 0];
async function setPanelOrbit(i) {
  const phi = (i * DRIFT_DEG * Math.PI) / 180;
  await must("entity.setTransform", {
    id: panel.id,
    position: [
      panelBasePos[0],
      panelBasePos[1] + DRIFT * Math.sin(phi),
      panelBasePos[2] + DRIFT * (Math.cos(phi) - 1),
    ],
  });
}

// ---- albedo mode needs the sun on --------------------------------------------
if (MODE === "albedo") {
  await must("component.setProp", { id: panel.id, type: "mesh", key: "material", value: `${GEN_ROOT}/materials/PanelGreen.mat` });
  await must("component.setProp", { id: sun.id, type: "light", key: "intensity", value: BLOCK_RIG.sunIntensity });
  await wait(4000);
}

// ---- PROPS: arbitrary GI component props, applied once before any arm --------
// The sweep only ever drives voxelSize/probeSpacing, and GLOBALS only reaches
// the `__gi*` build-time hatches — every DECLARED prop was out of reach, which
// made a control arm like `aoStrength=0` impossible without hand-editing the
// generated project between runs. Applied ONCE here, so every arm of a run
// shares the same component state and the sweep still measures only its dial.
//
// Coercion is GLOBALS' exactly (that parser lives inside evaluateOnNewDocument
// and cannot be shared across the page boundary, so it is mirrored, not
// factored): "true"/"false" → boolean, anything Number-parseable → Number,
// everything else stays a string — so `debugProbes=occupancy` works too.
const PROPS = (process.env.PROPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (PROPS.length) {
  const before = built;
  const applied = [];
  let propVoxel = null;
  for (const spec of PROPS) {
    const eq = spec.indexOf("=");
    if (eq < 0) {
      console.log(`  !! PROPS entry "${spec}" has no '=' — skipped`);
      continue;
    }
    const key = spec.slice(0, eq).trim();
    const raw = spec.slice(eq + 1).trim();
    const value = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    await must("component.setProp", { id: giEntity.id, type: "global-illumination", key, value });
    if (key === "voxelSize" && typeof value === "number") propVoxel = value;
    applied.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  console.log(`  props: ${applied.join(" ")} → global-illumination`);
  // THE STRUCTURAL-PROP GUARD. GISystem's onComponentProp routes a fixed key
  // list to #applyLiveProps and sends everything else to a structural-signature
  // comparison, so a prop that IS structural needs the signature to actually
  // move before it means anything. Since PROPS takes arbitrary keys, force the
  // rebuild rather than assume: give the writes a beat to rebuild on their own,
  // and if they did not, nudge voxelSize by 1e-4 — a real value change (so the
  // signature moves and #rebuild re-enters), but small enough that
  // `round(size/0.1501) == round(size/0.15)` leaves the built grid identical.
  // A rebuild also re-runs GICascadeLightNode.setup, which is where the
  // material-side __gi* hatches are read — so a PROPS run and an ABLATE run
  // land their settings by the same mechanism.
  //
  // BELT AND BRACES for AO specifically, not load-bearing: `aoStrength` and
  // `aoRadius` used to be in NEITHER route (live uniforms that nothing ever
  // wrote — the Inspector slider was dead too), which is what this nudge was
  // originally written to work around. Fixed in GISystem 2026-08-07; they now
  // reach #applyLiveProps directly and land the next frame. The nudge stays
  // because it is still correct for genuinely structural keys.
  await wait(1500);
  if (built === before) {
    const nudged = (propVoxel ?? BASE_VOXEL) + 1e-4;
    console.log(`    no rebuild followed — nudging voxelSize to ${nudged} so the props actually take effect`);
    await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "voxelSize", value: nudged });
    for (let k = 0; k < 60 && built === before; k++) await wait(500);
  }
  await wait(SETTLE);
}

const f = (v, w = 7, p = 3) => (Number.isFinite(v) ? v.toFixed(p) : "-").padStart(w);

// ---- ABLATION MODE ----------------------------------------------------------
// Every suspect term in the cascade/merge chain already has a live hatch. They
// are read at BUILD time, so setting one only takes effect on the next rebuild —
// which is why each group nudges voxelSize by 1e-4 (a value change large enough
// to re-enter #rebuild, small enough that `round(12/0.1501) == round(12/0.15)`
// leaves the built grid bit-identical). Without that nudge the globals are set
// and nothing happens, which is exactly the "I tried it and saw no difference"
// failure the cascadeTrace comment warns about.
if (process.env.ABLATE) {
  const groups = process.env.ABLATE.split("|").map((s) => s.trim());
  const all = ["", ...groups];
  const shots = [];
  for (let i = 0; i < all.length; i++) {
    const spec = all[i];
    const kv = spec ? spec.split(",").map((s) => s.split("=")) : [];
    await page.evaluate(({ pairs, clear }) => {
      for (const k of clear) delete globalThis[k];
      for (const [k, v] of pairs) {
        globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
      }
    }, {
      pairs: kv,
      clear: groups.flatMap((g) => g.split(",").map((s) => s.split("=")[0])),
    });
    const before = built;
    await must("component.setProp", {
      id: giEntity.id, type: "global-illumination", key: "voxelSize", value: BASE_VOXEL + i * 1e-4,
    });
    for (let k = 0; k < 60 && built === before; k++) await wait(500);
    await wait(SETTLE);
    const tag = spec ? spec.replaceAll(/[^\w.=-]/g, "_") : "baseline";
    const cap = await shootChecked(`ablate-${i}-${tag}`);
    const label = spec || "(baseline)";
    if (!cap.ok) {
      // NOT `modulation 0.00%`. A hole, named as a hole.
      failures.push({ arm: `ablate ${label}`, why: cap.why });
      shots.push({ spec: label, b64: cap.b64, m: null, error: cap.why });
      console.log(`  ablate ${label.padEnd(34)} FAILED — ${cap.why}`);
      continue;
    }
    const m = await analyze([cap.b64]);
    shots.push({ spec: label, b64: cap.b64, m });
    console.log(`  ablate ${label.padEnd(34)} modulation x ${(m.residRms * 100).toFixed(2)}%  z ${(m.residRmsZ * 100).toFixed(2)}%  level ${m.mean.toFixed(4)}`);
  }
  console.log(`\n=== ABLATION — which term carries the artifact? (vs baseline) ===`);
  console.log(`  hatch                              | mod x%  Δmod   | change rms  mean shift | change size x`);
  const base = shots[0];
  for (const s of shots.slice(1)) {
    // A failed arm has no picture to compare against, and the baseline itself
    // failing voids every row — say so instead of differencing black.
    if (!s.m || !base?.m) {
      console.log(`  ${s.spec.padEnd(34)} | ${(s.m ? "baseline FAILED" : "FAILED").padStart(13)} — ${s.error ?? base?.error ?? "no capture"}`);
      continue;
    }
    const d = await compare(base.b64, s.b64);
    console.log(
      `  ${s.spec.padEnd(34)} | ${f(s.m.residRms * 100, 6, 2)} ${f((s.m.residRms - base.m.residRms) * 100, 6, 2)} | ` +
        `${f(d.rms * 100, 10, 2)}%  ${f(d.dc * 100, 9, 2)}% | ${f((d.halfX * 2) / pxPerMx, 12)}m`,
    );
  }
  console.log(`\n  frames: ${SHOT}`);
  if (failures.length) {
    console.log(`\n  !! ${failures.length} ABLATION ARM(S) FAILED TO CAPTURE — exiting non-zero:`);
    for (const fl of failures) console.log(`     ${fl.arm}: ${fl.why}`);
  }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

// ---- the arms ----------------------------------------------------------------
const arms = [];
// `spin`/`spinStepDeg`/`mover` ride along on every arm so a JSON dump is
// self-describing — a still sweep and a spinning one are the same shape.
const armMeta = { mode: MODE, mover: MOVER, spin: SPIN, spinStepDeg: SPIN_STEP_DEG, frames: FRAMES, frameGapMs: FRAME_GAP };
if (SWEEP.includes("voxel")) for (const v of VOXELS) arms.push({ dial: "voxel", voxelSize: v, probeSpacing: BASE_PROBE, ...armMeta });
if (SWEEP.includes("probe")) for (const p of PROBES) arms.push({ dial: "probe", voxelSize: BASE_VOXEL, probeSpacing: p, ...armMeta });

const results = [];
for (const arm of arms) {
  const tag = `${arm.dial}-v${arm.voxelSize}-p${arm.probeSpacing}`;
  const before = built;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "voxelSize", value: arm.voxelSize });
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "probeSpacing", value: arm.probeSpacing });
  for (let i = 0; i < 60 && built === before; i++) await wait(500);
  // Back to yaw 0 BEFORE the settle, so the arm settles on the pose frame 0 is
  // shot at and the block-size/differential columns stay comparable across arms.
  if (SPIN) await setPanelYawDeg(0);
  // Same reason as the yaw reset: settle on the pose frame 0 is shot at, so the
  // still columns stay comparable across arms and only the flicker columns
  // carry the motion.
  if (DRIFT) await setPanelOrbit(0);
  await wait(SETTLE);
  const state = await builtState();
  const shots = [];
  // EVERY FRAME IS GUARDED, not just frame 0. A single black frame among FRAMES
  // does NOT zero the flicker columns — it makes them plausible and wrong
  // (`diff` becomes "the whole patch went dark", a smooth patch-sized change
  // that the per-line cubic partly absorbs), which is strictly harder to spot
  // than the zeroed single-frame case. So one bad frame voids the arm.
  let armError = null;
  for (let f = 0; f < FRAMES; f++) {
    // Same cadence as the still sweep — shoot, gap, shoot — with the yaw
    // advanced at the top of each gap so the panel has the whole FRAME_GAP to
    // re-adopt, re-trace and settle before the shutter opens.
    if (f > 0) {
      if (SPIN) await setPanelYawDeg(f * SPIN_STEP_DEG);
      if (DRIFT) await setPanelOrbit(f);
      await wait(FRAME_GAP);
    }
    const cap = await shootChecked(f === 0 ? tag : `${tag}-f${f}`);
    shots.push(cap.b64);
    if (!cap.ok) { armError = `frame ${f}: ${cap.why}`; break; }
  }
  const m = armError ? null : await analyze(shots);
  // Under SPIN the only thing that can silently void the arm is the mover
  // falling off the exact path mid-spin, so read the adoption count back after
  // the frames as well as before them.
  const stateAfter = SPIN && !armError ? await builtState() : null;
  results.push({
    arm, state, ...(stateAfter ? { stateAfter } : {}), m, shot: shots[0],
    ...(armError ? { error: armError } : {}),
  });
  if (armError) failures.push({ arm: tag, why: armError });
  const cell = state.cell?.x ?? NaN;
  console.log(
    `  ${tag.padEnd(26)} built cell ${cell?.toFixed?.(3) ?? "?"}m res ${state.res ? `${state.res.x}x${state.res.y}x${state.res.z}` : "?"} | ` +
      `probe ${state.probeSpacing?.toFixed?.(3)}m c0 ${state.c0Grid ? `${state.c0Grid.x}x${state.c0Grid.y}x${state.c0Grid.z}` : "?"}` +
      (SPIN && !armError ? ` | movers ${state.adopted}→${stateAfter?.adopted}` : "") +
      (armError ? `  !! ARM FAILED: ${armError}` : m?.error ? `  !! ${m.error}` : ""),
  );
  if (SPIN && !armError && !(state.adopted > 0 && stateAfter?.adopted > 0)) {
    console.log(`    !! the panel is not on the exact-mover path for this arm — its flicker is re-voxelization, not a mover`);
  }
}

// ---- report ------------------------------------------------------------------
// `r.m` is NULL for an arm whose capture failed — optional-chain everything, so
// a hole prints as "-" and never as a number.
const blockX = (r) => (r.m?.x?.halfC * 2) / pxPerMx;
const blockZ = (r) => (r.m?.z?.halfC * 2) / pxPerMz;
// THE DETRENDED FLICKER SIZES. Only ever finite under SPIN: `analyze` computes
// the detrended pair only when the raw frame difference clears its noise gate,
// and a still scene's difference never does.
const detrX = (r) => (r.m?.flick?.detrended?.halfX * 2) / pxPerMx;
const detrZ = (r) => (r.m?.flick?.detrended?.halfZ * 2) / pxPerMz;

/** Least-squares slope of ys on xs, plus r² and both spans. */
function regress(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return {
    n,
    slope: sxy / Math.max(sxx, 1e-12),
    r2: (sxy * sxy) / Math.max(sxx * syy, 1e-12),
    dialSpan: Math.max(...xs) / Math.min(...xs),
    valSpan: Math.max(...ys) / Math.min(...ys),
  };
}
/** The dial value the BUILD actually used — never the request. */
const builtDial = (r, dial) => (dial === "voxel" ? r.state.cell?.x : r.state.probeSpacing) ?? NaN;
const verdict = (g) =>
  g.valSpan < 1.25 ? "→ IGNORES this dial" : g.slope > 0.4 ? "→ SCALES WITH THIS DIAL" : "→ partial / mixed";

console.log(`\n=== BLOCK SIZE ON THE FLOOR (ACF half-width × 2, metres) ===`);
console.log(`  patch spans ${(BLOCK_RIG.patch.x1 - BLOCK_RIG.patch.x0).toFixed(1)}m in x, ` +
  `${(BLOCK_RIG.patch.z1 - BLOCK_RIG.patch.z0).toFixed(1)}m in z — structure above ~1/3 of that is absorbed by the detrend.`);
if (SPIN) {
  console.log(`  flicker = frame ${FRAMES - 1} (panel yawed ${(SPIN_STEP_DEG * (FRAMES - 1)).toFixed(1)}°) vs frame 0 (yaw 0) — ` +
    `how much a ${SPIN} deg/s mover moves the floor, and at what size. Block/mod/level are still frame 0 and still comparable to a SPIN-less run.`);
  console.log(`  detr = that same difference with a per-line cubic fitted out: the panel turning is a SMOOTH change of aspect and lands in the fit, ` +
    `so what survives is the part that cannot be honest relighting. Believe detr size over flick size.`);
}
console.log(`  dial   requested   built cell   built probe |  block x   block z |  mod x%  mod z% |  level  flicker%  flick size` +
  (SPIN ? ` | detr%  detr size x  detr size z` : ""));
for (const r of results) {
  const req = r.arm.dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing;
  if (!r.m) {
    // A FAILED arm gets a row that cannot be read as data. Never zeros.
    console.log(
      `  ${r.arm.dial.padEnd(6)} ${f(req, 9)}   ${f(r.state.cell?.x, 10)}   ${f(r.state.probeSpacing, 11)} | ` +
        `  FAILED — ${r.error}`,
    );
    continue;
  }
  const dt = r.m.flick?.detrended;
  console.log(
    `  ${r.arm.dial.padEnd(6)} ${f(req, 9)}   ${f(r.state.cell?.x, 10)}   ${f(r.state.probeSpacing, 11)} | ` +
      `${f(blockX(r), 8)}  ${f(blockZ(r), 8)} | ${f(r.m.residRms * 100, 6, 2)}  ${f(r.m.residRmsZ * 100, 6, 2)} | ` +
      `${f(r.m.mean, 6, 4)}  ${f((r.m.flick?.rms ?? 0) * 100, 8, 3)}  ${f((r.m.flick?.halfX * 2) / pxPerMx, 10)}` +
      // Under SPIN the raw flicker pair is mostly the panel's honest change of
      // aspect; these two are what is left after that smooth part is removed.
      (SPIN ? ` | ${f((dt?.rms ?? 0) * 100, 5, 2)}  ${f((dt?.halfX * 2) / pxPerMx, 11)}  ${f((dt?.halfZ * 2) / pxPerMz, 11)}` : "") +
      ((r.m.darkFrac ?? 0) > 0.1 ? `  !! ${((r.m.darkFrac ?? 0) * 100).toFixed(0)}% of lines are near-black` : ""),
  );
}

// THE DISCRIMINATOR. If the block size tracks a dial, the ratio block/dial is
// flat across that sweep and the slope of block vs dial is ~1. A dial the
// artifact does not belong to shows a flat BLOCK column instead.
console.log(`\n=== WHICH LATTICE? (slope of block size vs the dial, over each sweep) ===`);
for (const dial of ["voxel", "probe"]) for (const axis of ["x", "z"]) {
  const metric = axis === "x" ? blockX : blockZ;
  const rows = results.filter((r) => r.arm.dial === dial && Number.isFinite(metric(r)));
  if (rows.length < 2) continue;
  // Regress block size on the value the build ACTUALLY used, not the request.
  const g = regress(rows.map((r) => builtDial(r, dial)), rows.map(metric));
  console.log(
    `  ${dial.padEnd(6)} block-${axis}: dial spans ${g.dialSpan.toFixed(1)}x → block spans ${g.valSpan.toFixed(2)}x   ` +
      `slope ${f(g.slope, 6, 2)}  r² ${f(g.r2, 5, 2)}  ` +
      (g.valSpan < 1.25
        ? "→ the artifact IGNORES this dial"
        : g.slope > 0.4
          ? "→ THE ARTIFACT SCALES WITH THIS DIAL"
          : "→ partial / mixed"),
  );
}

// ---- THE SAME QUESTION, ASKED OF THE FLICKER RESIDUAL (SPIN only) -----------
//
// The section above regresses the STATIC block size (`blockX`/`blockZ`, frame 0)
// and NOTHING regressed the columns that only exist under SPIN — `detr size x` /
// `detr size z`, the size of what is left of a mover's frame-to-frame change
// after the smooth relighting is fitted out. Those are the columns that answer
// the user's actual complaint (a ROTATING box's bleed is "blocky and flickery"),
// and until 2026-08-07 reading them meant dividing by hand.
//
// WHY THE Z AXIS IS THE CLEAN READ, and x is not. The emitting panel is a plane
// running along z (2 m in z, 0.2 m in x), so to first order the floor's
// irradiance is a function of x ALONE — it is flat along z. Any lattice
// quantization therefore shows up as BANDS PARALLEL TO Z, i.e. as structure in
// the z-lag with no honest signal underneath it to confuse. A measured run:
//
//     detr size z = 0.377 m against probeSpacing 0.375 m   (0.5% off)
//     detr size x = 0.174 m against a 0.150 m field cell   (16% off)
//
// The z number lands on the probe lattice; the x number sits between the two
// dials because the true irradiance gradient runs along x and the per-line cubic
// only partly removes it. So: read `detr-z` first, and treat `detr-x` as
// corroboration only.
//
// The per-arm ratio columns are the point — a flat `÷cell` column means the
// residual IS a field cell wide at every arm, a flat `÷probe` column means it is
// a probe spacing wide, and the regression below turns that impression into a
// slope.
if (SPIN) {
  const spun = results.filter((r) => r.m && (Number.isFinite(detrX(r)) || Number.isFinite(detrZ(r))));
  if (spun.length === 0) {
    console.log(`\n=== FLICKER RESIDUAL SIZE (SPIN) === no arm produced a detrended flicker measurement.`);
  } else {
    console.log(`\n=== FLICKER RESIDUAL SIZE — WHOSE LATTICE IS THE MOVER'S POP? (SPIN) ===`);
    console.log(`  believe detr-z: the panel is a plane along z, so the floor's true irradiance varies in x only`);
    console.log(`  dial   built cell  built probe |  detr x   ÷cell  ÷probe |  detr z   ÷cell  ÷probe`);
    for (const r of spun) {
      const cell = r.state.cell?.x ?? NaN;
      const probe = r.state.probeSpacing ?? NaN;
      const dx = detrX(r), dz = detrZ(r);
      console.log(
        `  ${r.arm.dial.padEnd(6)} ${f(cell, 10)}  ${f(probe, 11)} | ` +
          `${f(dx, 7)}  ${f(dx / cell, 6, 2)}  ${f(dx / probe, 6, 2)} | ` +
          `${f(dz, 7)}  ${f(dz / cell, 6, 2)}  ${f(dz / probe, 6, 2)}`,
      );
    }
    // BOTH detr axes against BOTH dials — four regressions, the same shape as
    // the block-size discriminator above, on the value the build actually used.
    console.log(`\n  slope of the flicker residual's size vs the dial, over each sweep:`);
    for (const dial of ["voxel", "probe"]) for (const axis of ["x", "z"]) {
      const metric = axis === "x" ? detrX : detrZ;
      const rows = results.filter((r) => r.arm.dial === dial && r.m && Number.isFinite(metric(r)) && Number.isFinite(builtDial(r, dial)));
      if (rows.length < 2) {
        console.log(`  ${dial.padEnd(6)} detr-${axis}: only ${rows.length} usable arm(s) — no slope`);
        continue;
      }
      const g = regress(rows.map((r) => builtDial(r, dial)), rows.map(metric));
      console.log(
        `  ${dial.padEnd(6)} detr-${axis}:  dial spans ${g.dialSpan.toFixed(1)}x → size spans ${g.valSpan.toFixed(2)}x   ` +
          `slope ${f(g.slope, 6, 2)}  r² ${f(g.r2, 5, 2)}  ${verdict(g)}` +
          (axis === "z" ? "  [the clean axis]" : ""),
      );
    }
  }
}

// ---- the differential: every arm against the FINEST arm of its own sweep ----
console.log(`\n=== WHAT THE DIAL ACTUALLY CHANGED (arm ÷ finest arm of the same sweep) ===`);
console.log(`  dial   value    built |  change rms  mean shift |  change size x   change size z`);
for (const dial of ["voxel", "probe"]) {
  // FAILED arms carry a black picture; differencing against one would report the
  // whole scene as "what the dial changed". Drop them from both sides.
  const rows = results.filter((r) => r.arm.dial === dial && r.m);
  if (rows.length < 2) continue;
  const ref = rows[0];
  for (const r of rows.slice(1)) {
    const d = await compare(ref.shot, r.shot);
    r.diff = d;
    const built = dial === "voxel" ? r.state.cell?.x : r.state.probeSpacing;
    const refBuilt = dial === "voxel" ? ref.state.cell?.x : ref.state.probeSpacing;
    console.log(
      `  ${dial.padEnd(6)} ${f(dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing, 6)}  ${f(built, 7)} | ` +
        `${f(d.rms * 100, 10, 2)}%  ${f(d.dc * 100, 9, 2)}% | ${f((d.halfX * 2) / pxPerMx, 13)}m  ${f((d.halfZ * 2) / pxPerMz, 13)}m` +
        `   (vs ${refBuilt?.toFixed?.(3)})`,
    );
  }
}

console.log(`\n=== ACF CURVES (lag in px; ${pxPerMx.toFixed(0)} px/m along x) ===`);
for (const r of results) {
  const req = r.arm.dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing;
  console.log(`  ${r.arm.dial}=${req}  x: ${r.m ? (r.m.x?.curve ?? []).slice(0, 24).join(" ") : `FAILED (${r.error})`}`);
}

const anyClipped = results.filter((r) => (r.m?.clipped ?? 0) > 0.001);
if (anyClipped.length) console.log(`\n  !! ${anyClipped.length} arms have clipped pixels in the patch — those residuals under-report.`);
const inert = results.filter((r, i) => i > 0 && results[i - 1].arm.dial === r.arm.dial &&
  results[i - 1].state.cell?.x === r.state.cell?.x && results[i - 1].state.probeSpacing === r.state.probeSpacing);
if (inert.length) console.log(`  !! ${inert.length} arms built IDENTICALLY to the arm before them — that dial did not move the build.`);
console.log(`\n  frames: ${SHOT}`);

await writeFile(
  path.join(SHOT, "block-size.json"),
  // `shot` is a whole base64 PNG per arm — the frames are already on disk.
  // A failed arm serialises as `m: null` + `error`, NOT as zeros: a consumer
  // that averages this file must be able to tell a hole from a measurement.
  JSON.stringify({
    mode: MODE, mover: MOVER, spin: SPIN, spinStepDeg: SPIN_STEP_DEG, frames: FRAMES, frameGapMs: FRAME_GAP,
    quietEma: QUIET_EMA, keepRendering: true,
    failures,
    pxPerMx, pxPerMz, rect, results: results.map(({ shot, ...rest }) => rest),
  }, null, 1),
);
if (failures.length) {
  console.log(`\n  !! ${failures.length} of ${results.length} ARMS FAILED TO CAPTURE — this run is INCOMPLETE:`);
  for (const fl of failures) console.log(`     ${fl.arm}: ${fl.why}`);
  console.log(`     A black frame is not a measurement of zero. Re-run before drawing any conclusion.`);
}
await browser.close();
process.exit(failures.length ? 1 : 0);
