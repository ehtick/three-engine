// COLOUR-BLEED FALLOFF vs ANALYTIC GROUND TRUTH.
//
// The claim under test (user, 2026-08-04): "our colour bleed is too strong and
// reaches too far; in Blender it fades out quickly, while the overall white
// indirect light is stronger."
//
// Sponza cannot answer that — no ground truth, only another renderer's
// screenshot. So: one emitting rectangle, one empty floor (makeBleedProject),
// where the irradiance profile E(d) is exactly integrable. Sample the floor
// along the axis, normalise both curves at a reference distance, and the ratio
// IS the answer:
//
//   ratio ≈ 1 everywhere              transport is correct, the Sponza
//                                     impression is about the mix, not falloff
//   ratio RISES with d                bleed reaches too far  ← the user's claim
//   ratio FALLS with d                bleed dies too fast
//
// Two arms — a RED panel and a WHITE panel at the same emission strength —
// because "colour reaches too far but white fill is weak" is only a colour
// problem if the two profiles DIFFER. If red and white fall off identically,
// the transport is colour-blind and the Sponza impression is about the balance
// of sources, which is a different fix.
//
// Pixel→world is computed exactly (view+projection built from the camera the
// editor reports), never assumed: a top-down perspective frame is NOT linear in
// world x, and eyeballing sample positions is how a profile measurement lies.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-bleed.mjs
//
// Env:
//   GEN_ROOT=<dir>     generated project location
//   EMIT=5             panel emission strength
//   QUALITY=high       GI preset
//   ARMS=red,white     which panels to measure
//   SHOT=<dir>         dump the frames it samples
//   HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeBleedProject, analyticIrradiance, BLEED_RIG } from "./lib/makeBleedProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-bleed")).replaceAll("\\", "/");
const EMIT = Number(process.env.EMIT ?? 5);
const QUALITY = process.env.QUALITY ?? "high";
const ARMS = (process.env.ARMS ?? "red,white").split(",").map((s) => s.trim()).filter(Boolean);
const SHOT = process.env.SHOT ?? ".gi-shots/bleed";
const W = 1200, H = 800;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Sample distances from the panel plane. Panel is 2x2, so d < 2 is near field
// (profile is flat there by geometry, in ANY correct renderer) and d > 3 is
// where a 1/d² tail should have taken over — that is where the claim lives.
// DENSE, not a dozen hand-picked points. The sparse version reported a profile
// that PEAKED at 2.5m — physically impossible for this geometry (it must fall
// monotonically from the panel) and impossible to diagnose from 13 samples.
// A dense sweep shows the whole shape, so an artifact near the panel cannot be
// mistaken for the falloff.
const DISTANCES = Array.from({ length: 69 }, (_, i) => +(0.2 + i * 0.2).toFixed(1));
// Normalise both curves here: far enough out of the near field that the shape
// comparison is about the tail, close enough to be bright and low-noise.
const REF_D = Number(process.env.REF_D ?? 3.0);
// Fit window for the far-field exponent. Bounded at BOTH ends on purpose: below
// FIT_LO the panel is not point-like and the profile is legitimately flat, and
// above FIT_HI the signal is at the 8-bit noise floor even in the boosted
// exposure (the first run's tail "rose" from 11m out, which is quantization,
// not light).
const FIT_LO = Number(process.env.FIT_LO ?? 3.0);
const FIT_HI = Number(process.env.FIT_HI ?? 10.0);
// (dense sweep includes 1.8 exactly — keep in step with DISTANCES)

// VOXEL / PROBE: vary the field cell size and the probe spacing INDEPENDENTLY.
// A quality preset moves both at once, so it cannot say which one drives the
// falloff — and that is the whole question: radiance smeared across oversized
// CELLS makes the emitter effectively larger (flat, far-reaching profile),
// whereas a coarse PROBE lattice would blame the gather instead.
const VOXEL = process.env.VOXEL ? Number(process.env.VOXEL) : null;
const PROBE = process.env.PROBE ? Number(process.env.PROBE) : null;
const giOverrides = { quality: QUALITY };
// BOUNCE=0 isolates SINGLE-bounce transport. On this rig the true multi-bounce
// contribution is ~zero — the only surfaces are one emitter and one FLAT floor,
// and coplanar surfaces have zero form factor between them, so a flat floor
// cannot light itself at all. Any large change when the feedback loop is
// switched off is therefore not physics: it is the field's finite CELL
// THICKNESS letting a cell centred above the floor plane see its neighbours,
// i.e. light diffusing along the surface.
if (process.env.BOUNCE !== undefined) giOverrides.bounce = Number(process.env.BOUNCE);
// C0DIR / CASCADES: the ANGULAR resolution of the cascade hierarchy. If the
// over-reach comes from a distant source filling a whole angular bin, halving
// the base direction count must make it measurably WORSE and nothing else in
// the rig changes. This is the discriminator between an angular-sampling cause
// and a merge-weighting one.
if (process.env.C0DIR) giOverrides.c0DirRes = Number(process.env.C0DIR);
if (process.env.CASCADES) giOverrides.cascadeCount = Number(process.env.CASCADES);
if (VOXEL || PROBE) {
  giOverrides.quality = "custom";
  if (VOXEL) giOverrides.voxelSize = VOXEL;
  if (PROBE) giOverrides.probeSpacing = PROBE;
}
await makeBleedProject(GEN_ROOT, { emitStrength: EMIT, gi: giOverrides });
if (VOXEL || PROBE) console.log(`  field: voxel ${VOXEL ?? "preset"}, probes ${PROBE ?? "preset"} (quality custom)`);
console.log(`  generated bleed rig at ${GEN_ROOT} (panel ${BLEED_RIG.panelW}x${BLEED_RIG.panelH}m, emit ${EMIT}, quality ${QUALITY})`);
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
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy backend|storage|downgrad/i.test(t)) console.log(`  ${t.slice(0, 170)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 220)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.message ?? String(e)).slice(0, 220)}`));

// HATCH=a,b — globals set to true BEFORE any module runs. Several GI switches
// are read at shader BUILD time, so setting them after load tests nothing.
const HATCH = (process.env.HATCH ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// GLOBALS='__giGatherViewBias=0' — numeric live knobs, which HATCH (true only)
// cannot express. Set before load because several are read at shader build time.
const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
await page.evaluateOnNewDocument((project, hatch, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  for (const h of hatch) globalThis[h] = true;
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, GEN_ROOT, HATCH, GLOBALS);
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);
if (HATCH.length) console.log(`  hatches: ${HATCH.join(" ")}`);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
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
const byName = (name) => entities.find((e) => e.name === name);
const giEntity = entities.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
const panel = byName("Panel");
if (!giEntity || !panel) { console.log("FATAL: rig entities missing"); await browser.close(); process.exit(1); }

for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(10000);

// Straight down the floor from above and slightly to +z, so the camera looks
// OVER the panel and nothing occludes the near samples.
const EYE = [7, 13, 0.5];
const TARGET = [7, 0, 0];
await must("viewport.setCamera", { position: EYE, target: TARGET });
await wait(2500);
const camInfo = await must("viewport.getCamera", {});
const FOV = camInfo.fov ?? 60;
console.log(`  camera fov ${FOV}, eye [${EYE}] → target [${TARGET}]`);

// ---- exact world→pixel -----------------------------------------------------
// PROJECT WITH THE CAMERA'S OWN MATRICES, in the page. The first version of
// this rebuilt the lookAt basis in node from the position/target it had ASKED
// for — and was ~50px off, which silently put the two nearest samples in the
// BLACK SURROUND beyond the floor's edge, where they read 0.0000 for every arm
// and looked like data (session 20 lost time to the identical trap). The
// camera the screenshot actually uses is the only authority on where a world
// point lands, and `capture()` sets `camera.aspect = width/height` before
// rendering, so the projection has to be taken under that same aspect.
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
    // column-major 4x4 multiply, then the perspective divide
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
      const ndcX = c[0] / c[3], ndcY = c[1] / c[3];
      return { x: (ndcX * 0.5 + 0.5) * w, y: (0.5 - ndcY * 0.5) * h };
    });
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    return out;
  }, { pts: worldPoints, w: W, h: H });
}

// ---- sampling --------------------------------------------------------------
async function samplePng(b64, points) {
  return page.evaluate(async ({ dataUrl, points, w, h }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const R = 4; // half-size of the averaging patch, in pixels
    return points.map((p) => {
      if (!p) return null;
      const x0 = Math.max(0, Math.min(w - 1, Math.round(p.x) - R));
      const y0 = Math.max(0, Math.min(h - 1, Math.round(p.y) - R));
      const ww = Math.min(2 * R + 1, w - x0);
      const hh = Math.min(2 * R + 1, h - y0);
      const d = g.getImageData(x0, y0, ww, hh).data;
      // THE SCREENSHOT IS sRGB-ENCODED — viewport.js builds its render target
      // with `colorSpace: THREE.SRGBColorSpace`, so three applies the output
      // encoding on the way in. Fitting a falloff exponent to gamma-encoded
      // values would report ~1/2.2 of the real slope and make ANY renderer look
      // like it has too-slow falloff. Decode per channel, before averaging.
      const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += toLinear(d[i] / 255); gg += toLinear(d[i + 1] / 255); b += toLinear(d[i + 2] / 255); n++;
      }
      r /= n; gg /= n; b /= n;
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      return { r, g: gg, b, lum, sat: lum > 1e-5 ? (Math.max(r, gg, b) - Math.min(r, gg, b)) / lum : 0 };
    });
  }, { dataUrl: `data:image/png;base64,${b64}`, points, w: W, h: H });
}

const points = await projectPoints(DISTANCES.map((d) => [d, 0, 0]));
// SELF-CHECK, because a projection that is merely plausible is how the first
// run of this harness produced a confident wrong answer: the floor's own edges
// are known world points, so every sample must land strictly between them.
const [nearEdge, farEdge, panelBase] = await projectPoints([[-1, 0, 0], [BLEED_RIG.floorLength - 1, 0, 0], [0, 0, 0]]);
console.log(`  floor edges project to x=${nearEdge?.x.toFixed(0)} … ${farEdge?.x.toFixed(0)} px, panel base at x=${panelBase?.x.toFixed(0)}`);
console.log(`  sample pixels: ${points.map((p, i) => `${DISTANCES[i]}m→${p ? Math.round(p.x) : "off"}`).join(" ")}`);
const offFloor = points.filter((p, i) => !p || p.x <= (nearEdge?.x ?? 0) || p.x >= (farEdge?.x ?? W) || p.y < 0 || p.y >= H);
if (offFloor.length) {
  console.log(`  !! ${offFloor.length} sample(s) fall OUTSIDE the floor — those read the black surround, not the scene`);
}

async function shoot(tag) {
  const shot = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  const b64 = shot.__image.base64;
  await writeFile(path.join(SHOT, `bleed-${tag}.png`), Buffer.from(b64, "base64"));
  return samplePng(b64, points);
}

const MATS = {
  red: `${GEN_ROOT}/materials/EmitRed.mat`,
  white: `${GEN_ROOT}/materials/EmitWhite.mat`,
};

const results = {};
// CONTROL FIRST (session 20's rule): with GI disabled and no lights in the
// scene, the floor must be BLACK. If it is not, something else is lighting it
// and every profile below is measuring that instead.
await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: false });
await wait(4000);
results.giOff = await shoot("gi-off");
const offMax = Math.max(...results.giOff.map((s) => s?.lum ?? 0));
console.log(`  CONTROL — GI off, brightest floor sample ${offMax.toFixed(5)} ${offMax < 0.01 ? "(black, good)" : "!! NOT BLACK — something else lights the floor"}`);
await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
built = false;
for (let i = 0; i < 120 && !built; i++) await wait(500);
await wait(8000);

// EXPOSURE BRACKET. The floor spans ~500:1 between 0.4m and 12m, and an 8-bit
// sRGB screenshot resolves about 200:1 before quantization takes over — the
// first run returned IDENTICAL values at 10m and 12m because both landed on
// the same 8-bit code, and that flat tail is what produced its (wrong)
// "falloff is far too slow" headline. So shoot each arm twice, at GI intensity
// 1 and at HIGH_EXPOSURE, and stitch: the low shot owns the near field, the
// high shot owns the tail. The measured ratio between them over the samples
// where BOTH are in range is a built-in check that the knob is linear — if it
// is not constant, the stitch is invalid and the run says so.
const HIGH_EXPOSURE = Number(process.env.HIGH_EXPOSURE ?? 24);
const IN_RANGE_LO = 0.0025;   // ~9/255 in sRGB — above quantization mush
const IN_RANGE_HI = 0.85;     // below the clip
const setExposure = async (v) => {
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "intensity", value: v });
  await wait(3500);
};

for (const arm of ARMS) {
  if (!MATS[arm]) continue;
  await must("component.setProp", { id: panel.id, type: "mesh", key: "material", value: MATS[arm] });
  // The emissive change has to reach the field: material swap → re-bake of the
  // cell radiance → feedback → probes. Generous, this is not a timing test.
  await wait(12000);
  await setExposure(1);
  const low = await shoot(`${arm}-e1`);
  await setExposure(HIGH_EXPOSURE);
  const high = await shoot(`${arm}-e${HIGH_EXPOSURE}`);
  await setExposure(1);

  const ratios = [];
  for (let i = 0; i < DISTANCES.length; i++) {
    const l = low[i]?.lum ?? 0, h = high[i]?.lum ?? 0;
    if (l > IN_RANGE_LO && l < IN_RANGE_HI && h > IN_RANGE_LO && h < IN_RANGE_HI) ratios.push(h / l);
  }
  ratios.sort((a, b) => a - b);
  const gain = ratios.length ? ratios[Math.floor(ratios.length / 2)] : HIGH_EXPOSURE;
  const spread = ratios.length > 1 ? ratios[ratios.length - 1] / ratios[0] : NaN;
  console.log(
    `  arm ${arm}: exposure gain measured ${gain.toFixed(2)} (asked ${HIGH_EXPOSURE}, ${ratios.length} overlapping samples, spread ${Number.isFinite(spread) ? spread.toFixed(2) : "-"}x)` +
    `${Number.isFinite(spread) && spread > 1.35 ? "  !! not linear — stitch unreliable" : ""}`,
  );
  results[arm] = DISTANCES.map((_, i) => {
    const l = low[i], h = high[i];
    const lowOk = (l?.lum ?? 0) > IN_RANGE_LO && (l?.lum ?? 1) < IN_RANGE_HI;
    if (lowOk) return { ...l, from: "low" };
    const highOk = (h?.lum ?? 0) > IN_RANGE_LO && (h?.lum ?? 1) < IN_RANGE_HI;
    if (highOk) return { r: h.r / gain, g: h.g / gain, b: h.b / gain, lum: h.lum / gain, sat: h.sat, from: "high" };
    return { ...(l ?? { r: 0, g: 0, b: 0, lum: 0, sat: 0 }), from: "none" };
  });
  console.log(`    stitched from: ${results[arm].map((s, i) => `${DISTANCES[i]}:${s.from}`).join(" ")}`);
}

// ---- second-camera control -------------------------------------------------
// THE DISCRIMINATOR. The near-field blackout is either in the LIGHTING (a
// world-space fact about the GI field) or in the SCREEN RESOLVE (a fact about
// this camera). Re-measure the SAME world points from a different pose: if the
// dark band sits at the same world distances, it is the GI; if it moves with
// the camera, it is the resolve. Nothing else distinguishes those two, and they
// have completely different fixes.
if (process.env.CAM2 !== "0") {
  await must("component.setProp", { id: panel.id, type: "mesh", key: "material", value: MATS.white });
  await wait(9000);
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "intensity", value: 6 });
  await must("viewport.setCamera", { position: [4, 7, 4.5], target: [4, 0, 0] });
  await wait(3000);
  const pts2 = await projectPoints(DISTANCES.map((d) => [d, 0, 0]));
  const shot2 = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  await writeFile(path.join(SHOT, "cam2.png"), Buffer.from(shot2.__image.base64, "base64"));
  const s2 = await samplePng(shot2.__image.base64, pts2);
  // And the first camera again at the same exposure, so the two are comparable.
  await must("viewport.setCamera", { position: EYE, target: TARGET });
  await wait(3000);
  const pts1 = await projectPoints(DISTANCES.map((d) => [d, 0, 0]));
  const shot1 = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  const s1 = await samplePng(shot1.__image.base64, pts1);
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "intensity", value: 1 });
  console.log(`\n  SECOND-CAMERA CONTROL — same world points, two poses (GI intensity 6)`);
  console.log(`    d(m)   cam1(top-down)  cam2(oblique)   ratio`);
  for (let i = 0; i < DISTANCES.length; i++) {
    if (DISTANCES[i] > 4 && i % 5 !== 0) continue;
    if (DISTANCES[i] > 8) continue;
    const a = s1[i]?.lum ?? 0, b = s2[i]?.lum ?? 0;
    console.log(`    ${DISTANCES[i].toFixed(1).padStart(5)}  ${a.toFixed(5).padStart(13)}  ${b.toFixed(5).padStart(12)}  ${(a > 1e-6 ? b / a : 0).toFixed(2).padStart(7)}`);
  }
}

// ---- diagnostic views ------------------------------------------------------
// DEBUG_VIEWS=1: stop inferring the mechanism from a profile and LOOK at it.
// An oblique frame shows whether the dark contact band is real; the probe views
// show whether it is already dark in the PROBE field (a transport/gather
// problem) or only on screen (a resolve problem); occupancy shows whether the
// panel and floor voxelize where we think they do.
if (process.env.DEBUG_VIEWS) {
  await must("component.setProp", { id: panel.id, type: "mesh", key: "material", value: MATS.white });
  await wait(9000);
  const OBLIQUE = { position: [5.5, 2.4, 6.5], target: [1.5, 0.4, 0] };
  await must("viewport.setCamera", OBLIQUE);
  await wait(2500);
  for (const mode of ["off", "merged", "raw", "occupancy"]) {
    await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "debugProbes", value: mode });
    await wait(mode === "off" ? 3000 : 6000);
    const shot = await must("viewport.screenshot", { width: 1100, height: 700, includeGizmos: false });
    await writeFile(path.join(SHOT, `diag-${mode}.png`), Buffer.from(shot.__image.base64, "base64"));
    console.log(`  diagnostic view "${mode}" → ${path.join(SHOT, `diag-${mode}.png`)}`);
  }
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "debugProbes", value: "off" });
}

// ---- report ----------------------------------------------------------------
const analytic = DISTANCES.map((d) => analyticIrradiance(d));
const refIdx = DISTANCES.indexOf(REF_D);
const aRef = analytic[refIdx];

// Where does each arm actually peak? For this geometry the maximum must be at
// the smallest sampled distance; anything else is an artifact at the contact
// region (probe cage blocked by the panel's own voxels, normal-offset lift,
// AO) and it invalidates any normalisation taken inside it.
for (const arm of ARMS) {
  const s = results[arm];
  if (!s) continue;
  let best = 0;
  for (let i = 1; i < s.length; i++) if ((s[i]?.lum ?? 0) > (s[best]?.lum ?? 0)) best = i;
  console.log(`\n  ${arm}: peak at ${DISTANCES[best]}m (lum ${(s[best]?.lum ?? 0).toFixed(5)})` +
    `${DISTANCES[best] > 0.6 ? "  !! not at the panel — the near field is being suppressed" : ""}`);
}

console.log(`\n=== BLEED FALLOFF vs ANALYTIC (panel ${BLEED_RIG.panelW}x${BLEED_RIG.panelH}m, normalised at ${REF_D}m) ===`);
const head = `  d(m)   analytic  ` + ARMS.map((a) => `${a}-lum   ${a}/ana`).join("  ");
console.log(head);
for (let i = 0; i < DISTANCES.length; i++) {
  if (DISTANCES[i] > 3 && i % 3 !== 0) continue;   // dense near, sparse far
  const aN = analytic[i] / aRef;
  let line = `  ${DISTANCES[i].toFixed(1).padStart(5)} ${aN.toFixed(4).padStart(10)}  `;
  for (const arm of ARMS) {
    const s = results[arm];
    if (!s) { line += "     -        -    "; continue; }
    const mN = (s[i]?.lum ?? 0) / (s[refIdx]?.lum || 1);
    line += `${mN.toFixed(4).padStart(8)} ${(aN > 1e-6 ? mN / aN : 0).toFixed(3).padStart(8)}  `;
  }
  console.log(line);
}

// Effective falloff exponent in the far field: fit log(L) vs log(d) over the
// samples past the panel's own size, where a point-like source must approach -2.
const fitExponent = (vals, flags = null) => {
  const pts = [];
  for (let i = 0; i < DISTANCES.length; i++) {
    if (DISTANCES[i] < FIT_LO || DISTANCES[i] > FIT_HI) continue;
    // Samples the exposure bracket could not place in range are noise-floor or
    // clipped — including them is how the first run's tail bent upward.
    if (flags && flags[i] === "none") continue;
    const v = vals[i];
    if (!(v > 1e-6)) continue;
    pts.push([Math.log(DISTANCES[i]), Math.log(v)]);
  }
  if (pts.length < 3) return NaN;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
};
// NOTE the expected value is ≈ -3, not the -2 of a bare inverse square: the
// receiver is a HORIZONTAL floor and the emitter is VERTICAL, so the receiver's
// own cosine (y/r) falls off with distance too and adds a power. The analytic
// fit below is the reference — the measured arms are judged against it, not
// against a remembered rule of thumb.
console.log(`\n  FAR-FIELD FALLOFF EXPONENT (d ≥ ${(BLEED_RIG.panelH * 1.5).toFixed(1)}m; this geometry → ≈ -3)`);
console.log(`    analytic ${fitExponent(analytic).toFixed(2)}`);
for (const arm of ARMS) {
  if (!results[arm]) continue;
  console.log(`    ${arm.padEnd(8)} ${fitExponent(results[arm].map((s) => s?.lum ?? 0), results[arm].map((s) => s?.from)).toFixed(2)}`);
}

if (results.red && results.white) {
  console.log(`\n  COLOUR vs WHITE — do they fall off the same? (saturation of the red arm)`);
  for (let i = 0; i < DISTANCES.length; i++) {
    const rl = results.red[i]?.lum ?? 0, wl = results.white[i]?.lum ?? 0;
    console.log(
      `    ${DISTANCES[i].toFixed(1).padStart(5)}m  red ${rl.toFixed(5)}  white ${wl.toFixed(5)}  red/white ${(wl > 1e-6 ? rl / wl : 0).toFixed(3)}  sat ${(results.red[i]?.sat ?? 0).toFixed(3)}`,
    );
  }
}
console.log(`\n  frames: ${SHOT}`);

await browser.close();
process.exit(0);
