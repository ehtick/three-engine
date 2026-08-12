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
// CAP_AB=1 — the PER-PROBE RAY CAP's flicker arm (§12.32.1 option 1): tier
// cap vs cap off, still arms, interleaved ×2 in one page. The cap leaves the
// stride (refresh cadence) untouched and cuts the EVIDENCE RATE at capped
// probes — at CAP_VALUE=16 a capped probe runs 0.5 rays/bin/frame where the
// fattest ran ~50 — so the risk it measures is variance flicker returning on
// exactly the near-field walls §12.38 just calmed. Raw counts compare
// directly (same stride both arms), the α-sweep's discipline.
const CAP_AB = process.env.CAP_AB === "1";
const CAP_VALUE = Number(process.env.CAP_VALUE ?? 16);
// TRACK_AB=1 — §12.43's tracking window: MOVING arms, tracking on vs
// `__giSrcMotionTrack = false`, interleaved in one page. The risk it prices
// is the root relaxing during continuous motion (keep = 1−α instead of the
// stride root): faster tracking of a moving light field, bought with per-
// frame variance while things move. Still arms ride along as the control —
// the sub-threshold path is supposed to be untouched.
const TRACK_AB = process.env.TRACK_AB === "1";
// CAMERA_AB=1 — the 2026-08-12 report: "glints settle when the camera does
// not move, as it starts moving lights are moving all over again". Still
// scene, tier cap vs cap FORCED off, pan–hold cycles per arm (see body():
// a during-pan count would be 100% reprojection, so the holds are counted).
// The priced claim: the cap starves FRESH probes — the ones a pan reveals —
// and the post-pan settle churn shows it where a parked still cannot.
const CAMERA_AB = process.env.CAMERA_AB === "1";
const CAM_ANGLE = (Number(process.env.CAM_ANGLE ?? 25) * Math.PI) / 180;
// CAMERA_VERIFY=1 — §12.45.2's fix A/B: the TIER cap stays UNPINNED in both
// arms (a pinned cap never lifts, so CAMERA_AB's pinned arms cannot see the
// fix) and only `__giSrcCamCapLift` differs. Expected: lift-on pan-excess
// lands near the off arm's 1.66, lift-off near the capped arm's 6.66.
const CAMERA_VERIFY = process.env.CAMERA_VERIFY === "1";
// LIGHT_STEP=1 — the same report's other half: "anytime light updates, it
// starts flickering". A REAL intensity step lands mid-arm through the
// editor's own prop path (GISystem's light events fire exactly as live, the
// §12.43 tracking window arms), and three configs separate the suspects:
// shipped / cap forced off (what LIFTING the cap inside the window would
// buy — the queued fix, priced before it is built) / window off (the
// window's own noise cost, as a reference).
const LIGHT_STEP = process.env.LIGHT_STEP === "1";
const STEP_AT = Number(process.env.STEP_AT ?? 60);
// LIGHT_ROT=1 — the CONTINUOUS-SUN arm (the user's day cycle: LightScript.ts
// ping-pongs sun elevation over 140° at up to ~1°/frame, so dirDelta sits at
// 1.8–6× ALPHA_MOTION_SAT EVERY frame, mLight saturates ≥ the 0.5 threshold,
// and under LEVEL-triggered arming the §12.43 window's 1200 ms hold RE-ARMED
// each frame — it never closed while the sun moved (§12.46 fixed the arming
// to rising edges; the pre-fix pin is reproducible via the level-arm config).
// Four configs: shipped (rising edge — steady rotation at tier cost),
// level-arm (the §12.43–45 behavior: pinned window, permanent cap lift),
// no-lift (pinned window + tier cap — decomposes the cap-lift's share from
// the fast-decay share), window-off (`__giSrcMotionTrack=false` — no window
// at all, the sustained-regime reference). Rotation is driven
// in-page on the light object — GISystem's light loop polls matrixWorld
// deltas, so matrix motion needs no editor prop path (unlike LIGHT_STEP's
// intensity, which rides the prop path to fire light events).
const LIGHT_ROT = process.env.LIGHT_ROT === "1";
// rad/frame. Default = the user's editor mid-swing at 30 fps (~0.28°/frame).
const ROT_RATE = Number(process.env.ROT_RATE ?? 0.005);
// ROT_ALPHA="0.1,0.05,0.02" (with LIGHT_ROT) — §12.46.1's residual: churn
// during the swing is ~4.7 rev/px in EVERY window config, and all of them run
// at αmean 0.100 because `m` saturates for the whole cycle. This sweep asks
// whether sustained SMOOTH motion needs the fast α at all. It pairs churn
// with a LAG statistic (body()'s `settleFrames`), because §12.38's lesson is
// that a slower α passes every calm metric while eating real signal — under
// sustained motion the signal at risk is the field trailing the sun, and that
// is exactly what the post-stop net displacement measures.
const ROT_ALPHA = (process.env.ROT_ALPHA ?? "")
  .split(",").map(Number).filter((x) => x > 0 && x <= 1);
const SETTLE_FRAMES = Number(process.env.SETTLE_FRAMES ?? 90);
// ALPHA_SWEEP="0.1,0.05,0.02" — interleaved arms at several α values, both
// still and moving, in ONE page. Exists to answer the mechanism question the
// CEILING_AB left open (§12.32): the still-scene instability is nearly
// stride-independent, and Phase 5's hit shading multiplied per-ray variance
// (binary shadow-visibility flips at <1 ray/bin/frame) after §12.23 tuned
// α=0.1 against transmittance-only deposits. If still-arm flicker falls with
// α while the moving arm's step p95 holds (real geometric signal), the base
// flicker is VARIANCE and α is the lever; if it doesn't fall, the churn is
// structural (bin membership) and α is not the lever.
const ALPHA_SWEEP = (process.env.ALPHA_SWEEP ?? "")
  .split(",").map(Number).filter((x) => x > 0 && x <= 1);
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

// ── THE STEP LIGHT (LIGHT_STEP arms only) ───────────────────────────────────
// Probe-owned, the converge probe's pattern: the scene's own sun saves
// intensity 0 (2026-08-06), so the step must be a light this rig owns.
// Placed above the mover, inside the verified camera's view, so the stepped
// illumination lands on floor the metric reads.
let stepLightId = null;
let lightNow = 2;
if (LIGHT_STEP || LIGHT_ROT) {
  const le = await call("entity.create", {
    name: "__flicker_step_light", transform: { position: [7.5, 3.5, 0] },
  });
  stepLightId = le.ok ? (le.value?.id ?? le.value) : null;
  if (!stepLightId) { console.log(`FATAL: step light create failed (${le.error})`); await browser.close(); process.exit(1); }
  await must("component.add", { id: stepLightId, type: "light" });
  await must("component.setProp", { id: stepLightId, type: "light", key: "intensity", value: 2 });
  console.log(`  step light created (${stepLightId}), intensity 2 (kind defaults to directional)`);
  await wait(8000);
}

const body = async ({ anchorId, moverId, frames, amp, rotate, pan = null, light = null, rotLight = null, settleFrames = 0 }) => {
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
  // Camera pan support (CAMERA_AB): rotate the eye about the orbit target on
  // Y between the verified base pose and base+angle. Uses the viewport OPS
  // rather than writing camera.position — OrbitControls owns the camera (the
  // gi-harness-viewport-traps lesson) and viewport.setCamera is the path that
  // calls orbit.update(); a raw position write "moves" nothing.
  let setCam = null;
  if (pan) {
    const cam = await globalThis.__editorApi.call("viewport.getCamera", {});
    const [tx, ty, tz] = cam.target;
    const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
    setCam = (theta) => {
      const c = Math.cos(theta), s = Math.sin(theta);
      return globalThis.__editorApi.call("viewport.setCamera", {
        position: [tx + dx * c - dz * s, cam.position[1], tz + dx * s + dz * c],
        target: [tx, ty, tz],
      });
    };
  }
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
  if (pan) {
    // PAN–HOLD CYCLES, COUNTING THE HOLDS ONLY. During a pan the resolve is
    // screen-space and every pixel changes every frame for the mechanical
    // reason that the scene slides across it — a during-motion count would be
    // 100% reprojection and 0% GI. What the glints report describes is the
    // field being WRONG (cold, noisy probes) where the camera newly looks,
    // and that is measurable the moment the camera stops: sweep (armed=0,
    // accumulator still seeding prevLum every frame), then park and COUNT the
    // re-settle churn (armed=1). The first counted frame therefore sees GI
    // evolution only, never the pan's own reprojection step. Two cycles per
    // arm; even cycle pans out, odd pans home, so the arm ends at base.
    const seg = Math.floor(frames / (pan.cycles * 2));
    // Sample the LIVE cap every frame (`__giSrcTransport.probeRayCap` — the
    // §12.45.2 lift publishes through publishTransport): `panLift`/`holdLift`
    // count frames where the cap read lifted (> 100k ⇒ PROBE_RAY_CAP_OFF).
    // A verify arm that never saw a lifted frame measured a fix that never
    // ran — the §12.42 lift-snapshot lesson, promoted to a per-frame count.
    let panLift = 0, holdLift = 0, panN = 0, holdN = 0;
    const capNow = () => (globalThis.__giSrcTransport?.probeRayCap ?? 0) > 100000;
    // WHICH term holds the §12.43 window open is readable straight off the
    // GISystem instance — sample maxima per segment kind so the verdict can
    // name the owner instead of guessing (tr = the window itself; sh/em/lum =
    // its three arming terms).
    const mot = { panTr: 0, holdTr: 0, sh: 0, em: 0, lum: 0, holdSh: 0, holdEm: 0, holdLum: 0 };
    const sampleMotion = (hold) => {
      const tr = system._giTrackMotion ?? 0;
      if (hold) {
        mot.holdTr = Math.max(mot.holdTr, tr);
        mot.holdSh = Math.max(mot.holdSh, system._giShadowLastMotion ?? 0);
        mot.holdEm = Math.max(mot.holdEm, system._giEmitterLastMotion ?? 0);
        mot.holdLum = Math.max(mot.holdLum, system._giLightLumMotion ?? 0);
      } else {
        mot.panTr = Math.max(mot.panTr, tr);
        mot.sh = Math.max(mot.sh, system._giShadowLastMotion ?? 0);
        mot.em = Math.max(mot.em, system._giEmitterLastMotion ?? 0);
        mot.lum = Math.max(mot.lum, system._giLightLumMotion ?? 0);
      }
    };
    for (let cyc = 0; cyc < pan.cycles; cyc++) {
      armed.value = 0;
      for (let i = 0; i < seg; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        await setCam(((cyc % 2 === 0 ? i + 1 : seg - 1 - i) / seg) * pan.angle);
        renderer.compute(accumulator);
        panN++; if (capNow()) panLift++;
        sampleMotion(false);
      }
      armed.value = 1;
      for (let i = 0; i < seg; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        renderer.compute(accumulator);
        holdN++; if (capNow()) holdLift++;
        sampleMotion(true);
      }
    }
    await setCam(0);
    globalThis.__flickerCapLift = { panLift, panN, holdLift, holdN, ...mot };
  } else {
    // LIGHT_ROT: per-frame cap/window/α sampling, the pan path's discipline —
    // a verify arm that never observed the state it claims to measure is the
    // §12.42 lift-snapshot lesson, and the whole point of this arm is to
    // catch the window being PINNED OPEN (trMax 1.0, cap lifted ~100%).
    const rotStats = rotLight
      ? { n: 0, lifted: 0, trMax: 0, shMax: 0, lumMax: 0, alphaSum: 0 }
      : null;
    const lobj = rotLight ? globalThis.__editorApi.entities.live(rotLight.id)?.object3D : null;
    if (rotLight && !lobj) throw new Error("rot light not live");
    // Triangle ping-pong whose phase starts AT the base elevation, so the
    // first measured frame moves by exactly radPerFrame — an absolute ramp
    // that began at base−A would land a hidden STEP inside the measured arm.
    // |Δ| per frame is radPerFrame everywhere except the two turn frames,
    // which is the user's LightScript regime (eased ping-pong, saturated
    // mid-swing, brief sub-threshold dwell at the extremes).
    const half = Math.max(2, Math.floor(frames / 2));
    const rotAngle = (i) => {
      const p = (i + Math.floor(half / 2)) % (2 * half);
      const steps = p < half ? p : 2 * half - p;
      return rotLight.base + (steps - Math.floor(half / 2)) * rotLight.radPerFrame;
    };
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      // LIGHT_STEP: the step lands mid-window through the editor's own prop
      // path, so the light events GISystem listens for fire exactly as live.
      if (light && i === light.at) {
        await globalThis.__editorApi.call("component.setProp", {
          id: light.id, type: "light", key: "intensity", value: light.to,
        });
      }
      if (rotLight) {
        // Matrix motion needs no prop path — GISystem's light loop polls
        // matrixWorld deltas (dirDelta), exactly how the user's day-cycle
        // script drives the sun.
        lobj.rotation.x = rotAngle(i);
        lobj.updateMatrixWorld(true);
      }
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
      if (rotStats) {
        rotStats.n++;
        if ((globalThis.__giSrcTransport?.probeRayCap ?? 0) > 100000) rotStats.lifted++;
        rotStats.trMax = Math.max(rotStats.trMax, system._giTrackMotion ?? 0);
        rotStats.shMax = Math.max(rotStats.shMax, system._giShadowLastMotion ?? 0);
        rotStats.lumMax = Math.max(rotStats.lumMax, system._giLightLumMotion ?? 0);
        rotStats.alphaSum += globalThis.__giSrcAlphaLive ?? 0;
      }
    }
    if (rotLight) {
      lobj.rotation.x = rotLight.base;
      lobj.updateMatrixWorld(true);
      globalThis.__flickerCapLift = {
        rotN: rotStats.n, rotLift: rotStats.lifted, trMax: rotStats.trMax,
        shMax: rotStats.shMax, lumMax: rotStats.lumMax,
        alphaMean: rotStats.alphaSum / Math.max(1, rotStats.n),
      };
    }
  }
  obj.position.copy(base);
  obj.updateMatrixWorld(true);

  // ── THE LAG STATISTIC (α-under-rotation sweep) ────────────────────────────
  // Churn alone cannot judge a smoothing change: §12.38's lesson is that a
  // slower α passes every calm metric while quietly eating real signal. Under
  // SUSTAINED motion the signal α trades away is LAG — the field trailing the
  // true lighting by some angle — and lag is directly observable the moment
  // the light stops: a lagging field SLIDES monotonically into place, while
  // per-frame variance is zero-mean and cancels over the same window. So the
  // statistic is NET displacement |lum_after − lum_at_stop|, not the walked
  // distance (walk sums both and would let the two effects hide each other).
  // Counting stays disarmed here, so the arm's own churn numbers are the
  // rotation's alone; `stateBuf.x` tracks luminance regardless of `armed`.
  let netSettle = null;
  if (settleFrames > 0) {
    const before = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
    armed.value = 0;
    for (let i = 0; i < settleFrames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      renderer.compute(accumulator);
    }
    const after = new Float32Array(await renderer.getArrayBufferAsync(stateBuf.value));
    const disp = [];
    let sum = 0;
    for (let i = 0; i < width * height; i++) {
      if (after[i * 4 + 3] > frames * 0.5) continue;
      const d = Math.abs(after[i * 4] - before[i * 4]);
      disp.push(d);
      sum += d;
    }
    disp.sort((a, b) => a - b);
    netSettle = {
      frames: settleFrames,
      mean: disp.length ? sum / disp.length : 0,
      p95: disp.length ? disp[Math.floor(disp.length * 0.95)] : 0,
      px: disp.length,
    };
  }

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
const measure = (amp, rotate, extra = {}) => page.evaluate(body, {
  anchorId: giEntity.id, moverId: sphere.id, frames: FRAMES, amp, rotate, ...extra,
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
// ── THE PER-PROBE CAP A/B ───────────────────────────────────────────────────
// Still arms only (the ceiling A/B's reasoning: the still control is the worse
// number, and a mover would add variance to the thing being read). A FULL
// discarded arm after every switch, the α-sweep's lesson verbatim: a capped
// probe's accumulators re-equilibrate to the lower evidence rate over ~1/α
// refreshes, and measuring that transient reports equilibration as flicker.
// `0` disables the cap (srcProbeRayCap's contract); `undefined` restores the
// tier default at exit.
const setCap = (v) => page.evaluate((x) => { globalThis.__giSrcProbeRayCap = x; }, v);
// The α compensation's state, recorded per arm rather than assumed (§12.40.4:
// a derived number nothing prints is a number probes will guess). Lift 0 =
// full compensation (still floor), 1 = suspended — a cap arm measured at
// lift 1 is measuring the UNCOMPENSATED cap and its verdict says nothing
// about the shipped configuration.
const readComp = () => page.evaluate(() => ({
  lift: globalThis.__giSrcCompLiftLive ?? null,
  alpha: globalThis.__giSrcAlphaLive ?? null,
}));
const capRounds = [];
if (CAP_AB) {
  for (let r = 0; r < 2; r++) {
    await setCap(CAP_VALUE);
    await wait(300);
    const capT = await readTransport();
    await measure(0, false);
    const capped = await measure(0, false);
    const capComp = await readComp();
    await setCap(0);
    await wait(300);
    const offT = await readTransport();
    await measure(0, false);
    const off = await measure(0, false);
    capRounds.push({ capped, off, capT, offT, capComp });
  }
  await setCap(undefined);
}
// ── THE TRACKING-WINDOW A/B (§12.43) ────────────────────────────────────────
// Moving arms, because that is where the root now relaxes; a full discarded
// arm after every switch (the accumulators re-equilibrate at the new keep),
// and a still control per config so an accidental sub-threshold change
// cannot hide.
const setTrack = (v) => page.evaluate((x) => { globalThis.__giSrcMotionTrack = x; }, v);
const trackRounds = [];
if (TRACK_AB) {
  for (let r = 0; r < 2; r++) {
    await setTrack(undefined);
    await wait(300);
    await measure(AMP, ROTATE);
    const on = await measure(AMP, ROTATE);
    await measure(0, false);
    const onStill = await measure(0, false);
    await setTrack(false);
    await wait(300);
    await measure(AMP, ROTATE);
    const off = await measure(AMP, ROTATE);
    await measure(0, false);
    const offStill = await measure(0, false);
    trackRounds.push({ on, off, onStill, offStill });
  }
  await setTrack(undefined);
}
// ── THE CAMERA-PAN A/B ──────────────────────────────────────────────────────
// Cap CAP_VALUE vs FORCED off, interleaved ×2, a full discarded arm after
// every switch (the α-sweep's re-equilibration lesson). The quotable figure
// is each config's PAN EXCESS over its OWN parked still, because §12.42
// already moved the still floor between capped and off — a raw pan-to-pan
// comparison would re-litigate the cap A/B, not the pan.
const camRounds = [];
if (CAMERA_AB) {
  for (let r = 0; r < 2; r++) {
    await setCap(CAP_VALUE);
    await wait(300);
    await measure(0, false);
    const cappedPan = await measure(0, false, { pan: { angle: CAM_ANGLE, cycles: 2 } });
    const cappedStill = await measure(0, false);
    // A SECOND still, because the first run's stills read 3.2× the page's clean
    // pre-pan floor — the pan's churn OUTLIVED a whole 270-frame arm and
    // contaminated the "own still" baseline. still2 separates a convergence
    // TAIL (decays toward the floor ⇒ cold blocks re-converging) from a
    // LATCHED state (stays elevated ⇒ something keeps re-invalidating).
    const cappedStill2 = await measure(0, false);
    const capComp = await readComp();
    await setCap(0);
    await wait(300);
    await measure(0, false);
    const offPan = await measure(0, false, { pan: { angle: CAM_ANGLE, cycles: 2 } });
    const offStill = await measure(0, false);
    const offStill2 = await measure(0, false);
    camRounds.push({ cappedPan, cappedStill, cappedStill2, offPan, offStill, offStill2, capComp });
  }
  await setCap(undefined);
}
// ── THE CAMERA-LIFT VERIFY (§12.45.2) ───────────────────────────────────────
const setCamLift = (v) => page.evaluate((x) => { globalThis.__giSrcCamCapLift = x; }, v);
const camVerifyRounds = [];
if (CAMERA_VERIFY) {
  await setCap(undefined); // tier cap, UNPINNED — the lift can act
  for (let r = 0; r < 2; r++) {
    await setCamLift(undefined);
    await wait(300);
    await measure(0, false);
    const liftPan = await measure(0, false, { pan: { angle: CAM_ANGLE, cycles: 2 } });
    const liftPanCap = await page.evaluate(() => globalThis.__flickerCapLift ?? null);
    const liftStill = await measure(0, false);
    await setCamLift(false);
    await wait(300);
    await measure(0, false);
    const noPan = await measure(0, false, { pan: { angle: CAM_ANGLE, cycles: 2 } });
    const noPanCap = await page.evaluate(() => globalThis.__flickerCapLift ?? null);
    const noStill = await measure(0, false);
    camVerifyRounds.push({ liftPan, liftStill, noPan, noStill, liftPanCap, noPanCap });
  }
  await setCamLift(undefined);
}
// ── THE LIGHT-STEP A/B ──────────────────────────────────────────────────────
// Direction alternates 2↔6 arm to arm, so over 2 rounds every config sees one
// rising and one falling step and the per-config means are balanced. A
// discarded settle arm precedes each measured one — it doubles as the
// re-settle from the PREVIOUS arm's step (§12.43's t90 at stride 1 is well
// inside 240 frames + body's warmup).
const stepRounds = [];
// The three arms moved once §12.45 landed: `shipped` is now the TIER cap
// (unset — a pinned cap deliberately never lifts) WITH the window lift;
// `no-lift` is the same config with `__giSrcCapWindowLift = false`, i.e. the
// pre-§12.45 behavior (it measured 24.1 rev/px; cap-off measured 15.3 — the
// lift's ceiling — and window-off 3.7, in the 2026-08-12 pre-fix run).
const setLift = (v) => page.evaluate((x) => { globalThis.__giSrcCapWindowLift = x; }, v);
const STEP_NAMES = ["shipped", "no-lift", "window-off"];
if (LIGHT_STEP) {
  const stepConfigs = [
    { name: "shipped", track: undefined, cap: undefined, lift: undefined },
    { name: "no-lift", track: undefined, cap: undefined, lift: false },
    { name: "window-off", track: false, cap: undefined, lift: undefined },
  ];
  for (let r = 0; r < 2; r++) {
    const round = {};
    for (const cfg of stepConfigs) {
      await setTrack(cfg.track);
      await setCap(cfg.cap);
      await setLift(cfg.lift);
      await wait(300);
      await measure(0, false);
      const to = lightNow === 2 ? 6 : 2;
      const arm = await measure(0, false, { light: { id: stepLightId, at: STEP_AT, to } });
      round[cfg.name] = { arm, dir: `${lightNow}->${to}` };
      lightNow = to;
    }
    stepRounds.push(round);
  }
  await setTrack(undefined);
  await setCap(undefined);
  await setLift(undefined);
  await must("component.setProp", { id: stepLightId, type: "light", key: "intensity", value: 2 });
}
// ── THE CONTINUOUS-ROTATION A/B (the day-cycle regime) ──────────────────────
// A discarded settle arm (also rotating) precedes each measured arm, so the
// measured arm samples the ROTATION's steady state, not its onset — the onset
// (one legitimate rising-edge window) lands entirely inside the discard. The
// still that follows each measured arm reads the settle tail after the sun
// parks: their ping-pong's endpoint dwell, and where §12.43's 1.2 s close is
// visible as churn decaying instead of latching.
const rotRounds = [];
// Post-§12.46 arms: `shipped` is RISING-EDGE arming (the rotation onset lands
// in the discarded settle arm, so the measured arm should read capLift ~0 and
// the window-off arm's churn); `level-arm` is `__giSrcTrackLevelArm = true` —
// the pre-fix behavior, which the 2026-08-12 pre-fix run measured at 4.62
// rev/px with capLift 100% (window pinned open, §12.42's fps win cancelled).
// no-lift (30.9 pre-fix) and window-off (5.07) keep their §12.45 meanings.
const ROT_NAMES = ["shipped", "level-arm", "no-lift", "window-off"];
const setLevelArm = (v) => page.evaluate((x) => { globalThis.__giSrcTrackLevelArm = x; }, v);
if (LIGHT_ROT) {
  const rotConfigs = [
    { name: "shipped", track: undefined, lift: undefined, level: undefined },
    { name: "level-arm", track: undefined, lift: undefined, level: true },
    { name: "no-lift", track: undefined, lift: false, level: true },
    { name: "window-off", track: false, lift: undefined, level: undefined },
  ];
  // Base elevation ~57° (−1 rad): sun-like over the verified camera's floor.
  const rotOpts = { rotLight: { id: stepLightId, radPerFrame: ROT_RATE, base: -1.0 } };
  for (let r = 0; r < 2; r++) {
    const round = {};
    for (const cfg of rotConfigs) {
      await setTrack(cfg.track);
      await setLift(cfg.lift);
      await setLevelArm(cfg.level);
      await wait(300);
      await measure(0, false, rotOpts);
      const arm = await measure(0, false, rotOpts);
      const caps = await page.evaluate(() => globalThis.__flickerCapLift ?? null);
      const still = await measure(0, false);
      round[cfg.name] = { arm, caps, still };
    }
    rotRounds.push(round);
  }
  await setTrack(undefined);
  await setLift(undefined);
  await setLevelArm(undefined);
}
// ── α UNDER SUSTAINED ROTATION, WITH A LAG COLUMN ───────────────────────────
// Everything else is the SHIPPING config (rising-edge arming ⇒ window closed,
// tier cap engaged), so this isolates α alone: `__giSrcAlpha` outranks the
// ramp, and with the window shut the root and the cap are identical in every
// arm. A full discarded rotating arm precedes each measured one — the
// accumulators re-equilibrate over ~1/α refreshes and §12.38 already measured
// that transient once as if it were flicker.
const rotAlphaRounds = [];
if (LIGHT_ROT && ROT_ALPHA.length) {
  const rotOpts = { rotLight: { id: stepLightId, radPerFrame: ROT_RATE, base: -1.0 } };
  for (let r = 0; r < 2; r++) {
    const order = r % 2 === 0 ? ROT_ALPHA : [...ROT_ALPHA].reverse();
    const round = {};
    for (const a of order) {
      await setAlpha(a);
      await wait(300);
      await measure(0, false, rotOpts);
      round[a] = await measure(0, false, { ...rotOpts, settleFrames: SETTLE_FRAMES });
    }
    rotAlphaRounds.push(round);
  }
  await setAlpha(undefined);
}
// ── THE α SWEEP, SAME DISCIPLINE ────────────────────────────────────────────
// Round 2 walks the α list in REVERSE so a slow page drift loads each α at
// both ends of the run — the same cancellation the interleave buys the two-arm
// A/Bs above. The stride is CONSTANT across these arms (the ceiling is not
// touched), so refresh rates are identical and the raw counts compare
// directly — none of the per-refresh normalization the ceiling A/B needs.
const alphaRounds = [];
if (ALPHA_SWEEP.length) {
  for (let r = 0; r < 2; r++) {
    const order = r % 2 === 0 ? ALPHA_SWEEP : [...ALPHA_SWEEP].reverse();
    const round = {};
    for (const a of order) {
      await setAlpha(a);
      await wait(300);
      // ⚠ A FULL DISCARDED ARM AFTER EVERY α SWITCH, not just body()'s 30-frame
      // warmup. The accumulator re-equilibrates over ~1/α REFRESHES — at
      // α=0.02 and stride 3 that is ~150 frames, 5× the warmup — and the first
      // sweep measured the transient as flicker: the α=0.02 row read a step
      // p95 of 26 LUMINANCE UNITS with a 7.7× round-to-round spread, which is
      // an equilibration wave, not instability. The α=0.05 rows agreed at 6%
      // BECAUSE 1/α was inside the warmup there. 240 discarded frames cover
      // 3× the slowest time constant this sweep reaches.
      await measure(0, false);
      round[a] = { moving: await measure(AMP, ROTATE), still: await measure(0, false) };
    }
    alphaRounds.push(round);
  }
  await setAlpha(undefined);
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

// ── THE CAP A/B VERDICT ─────────────────────────────────────────────────────
// Same stride both arms, so raw counts compare directly. The claim under test
// is §12.38's calm SURVIVING the cap: still reversals and step p95 within the
// rig's own round-to-round noise. A capped arm clearly above it says the tier
// value is buying its deposit ms with the flicker the user just reported.
if (capRounds.length) {
  console.log(`
=== PER-PROBE CAP A/B (still arms, cap ${CAP_VALUE} vs off, interleaved x${capRounds.length}) ===`);
  const capMean = capRounds.reduce((s, r) => s + r.capped.meanReversals, 0) / capRounds.length;
  const offMean = capRounds.reduce((s, r) => s + r.off.meanReversals, 0) / capRounds.length;
  const capP95 = capRounds.reduce((s, r) => s + r.capped.stepP95, 0) / capRounds.length;
  const offP95 = capRounds.reduce((s, r) => s + r.off.stepP95, 0) / capRounds.length;
  const spread = capRounds.length > 1
    ? Math.abs(capRounds[0].off.meanReversals - capRounds[1].off.meanReversals)
    : NaN;
  console.log(`  published cap: ${capRounds[0].capT?.probeRayCap} vs ${capRounds[0].offT?.probeRayCap} ` +
    `(stride ${capRounds[0].capT?.stride} both arms — the cap must not move it)`);
  const lifts = capRounds.map((r) => r.capComp?.lift);
  console.log(`  compensation lift during capped stills: ${lifts.map((l) => l?.toFixed?.(3) ?? l).join(", ")} ` +
    `(0 = fully compensated; ~1 means the arm measured the UNCOMPENSATED cap)`);
  console.log(`  still reversals/px: capped ${capMean.toFixed(3)}  vs  off ${offMean.toFixed(3)}   ` +
    `(${((capMean / offMean - 1) * 100).toFixed(0)}%)`);
  console.log(`  still step p95:     capped ${capP95.toFixed(4)}  vs  off ${offP95.toFixed(4)}   ` +
    `(${((capP95 / offP95 - 1) * 100).toFixed(0)}%)`);
  console.log(`  round-to-round spread on the OFF arm: ${spread.toFixed(3)} — the noise floor`);
  const excess = capMean - offMean;
  if (excess > Math.max(spread * 1.5, offMean * 0.15)) {
    console.log("  ⇒ THE CAP COSTS FLICKER at this value. Raise the tier's probeRayCap (or lower");
    console.log("     the still α floor) before shipping it — the deposit win is real either way.");
  } else {
    console.log("  ⇒ §12.38's calm SURVIVES the cap: the excess is inside the rig's own noise.");
  }
}

// ── THE TRACKING-WINDOW VERDICT ─────────────────────────────────────────────
if (trackRounds.length) {
  console.log(`
=== TRACKING WINDOW A/B (moving arms, tracking on vs off, interleaved x${trackRounds.length}) ===`);
  const mean = (k, field) => trackRounds.reduce((s, r) => s + r[k][field], 0) / trackRounds.length;
  console.log(`  moving reversals/px: on ${mean("on", "meanReversals").toFixed(3)}  vs  off ${mean("off", "meanReversals").toFixed(3)}   ` +
    `(${((mean("on", "meanReversals") / mean("off", "meanReversals") - 1) * 100).toFixed(0)}%)`);
  console.log(`  moving step p95:     on ${mean("on", "stepP95").toFixed(4)}  vs  off ${mean("off", "stepP95").toFixed(4)}   ` +
    `(${((mean("on", "stepP95") / mean("off", "stepP95") - 1) * 100).toFixed(0)}%)`);
  console.log(`  still control:       on ${mean("onStill", "meanReversals").toFixed(3)}  vs  off ${mean("offStill", "meanReversals").toFixed(3)} rev/px ` +
    `(sub-threshold path — these must agree within round spread)`);
  const spread = trackRounds.length > 1
    ? Math.abs(trackRounds[0].off.meanReversals - trackRounds[1].off.meanReversals)
    : NaN;
  console.log(`  round-to-round spread on the moving OFF arm: ${spread.toFixed(3)}`);
}

// ── THE CAMERA-PAN VERDICT ──────────────────────────────────────────────────
if (camRounds.length) {
  console.log(`
=== CAMERA PAN A/B (±${((CAM_ANGLE * 180) / Math.PI).toFixed(0)}° pan–hold ×2, holds counted; cap ${CAP_VALUE} vs off, interleaved x${camRounds.length}) ===`);
  console.log("  round  arm      pan rev/px   still rev/px   still2 rev/px   pan p95   still p95");
  const row = (i, name, p, s, s2) => console.log(
    `  ${i}      ${name.padEnd(8)} ${p.meanReversals.toFixed(3).padEnd(12)} ${s.meanReversals.toFixed(3).padEnd(14)} ` +
    `${(s2 ? s2.meanReversals.toFixed(3) : "-").padEnd(15)} ${p.stepP95.toFixed(4).padEnd(9)} ${s.stepP95.toFixed(4)}`);
  for (const [i, r] of camRounds.entries()) {
    row(i + 1, "capped", r.cappedPan, r.cappedStill, r.cappedStill2);
    row(i + 1, "off", r.offPan, r.offStill, r.offStill2);
  }
  const mean = (k, f) => camRounds.reduce((s, r) => s + r[k][f], 0) / camRounds.length;
  const exCap = mean("cappedPan", "meanReversals") - mean("cappedStill", "meanReversals");
  const exOff = mean("offPan", "meanReversals") - mean("offStill", "meanReversals");
  const p95Cap = mean("cappedPan", "stepP95") - mean("cappedStill", "stepP95");
  const p95Off = mean("offPan", "stepP95") - mean("offStill", "stepP95");
  const spread = camRounds.length > 1
    ? Math.abs(camRounds[0].offPan.meanReversals - camRounds[1].offPan.meanReversals)
    : NaN;
  const lifts = camRounds.map((r) => r.capComp?.lift);
  console.log(`  lift after capped arms: ${lifts.map((l) => l?.toFixed?.(3) ?? l).join(", ")} (post-measure snapshot — §12.42's caveat)`);
  console.log(`  the page's CLEAN pre-pan still (tier cap): ${still.meanReversals.toFixed(3)} rev/px — post-pan stills read against THIS floor`);
  console.log(`  PAN EXCESS over own still — reversals: capped ${exCap.toFixed(3)}  vs  off ${exOff.toFixed(3)}` +
    `   (x${(exCap / Math.max(1e-9, exOff)).toFixed(2)})`);
  console.log(`  PAN EXCESS — step p95:               capped ${p95Cap.toFixed(4)}  vs  off ${p95Off.toFixed(4)}`);
  console.log(`  round-to-round spread on the OFF pan arm: ${spread.toFixed(3)} — the noise floor`);
  if (exCap - exOff > Math.max(spread * 1.5, Math.abs(exOff) * 0.25)) {
    console.log("  ⇒ THE CAP MULTIPLIES POST-PAN SETTLE CHURN: fresh/newly-visible probes are");
    console.log("     evidence-starved at the cap. The queued fix (a warm-up exemption in [D1'] —");
    console.log("     fresh blocks skip the clamp until converged) has a priced target.");
  } else {
    console.log("  ⇒ pan settle churn is CAP-INVARIANT at this pose — the glints are not the");
    console.log("     cap's starvation; look at fresh-probe seeding/α, not the ray budget.");
  }
}

// ── THE CAMERA-LIFT VERIFY VERDICT ──────────────────────────────────────────
if (camVerifyRounds.length) {
  console.log(`
=== CAMERA LIFT VERIFY (tier cap unpinned; __giSrcCamCapLift on vs off, x${camVerifyRounds.length}) ===`);
  console.log("  round  arm       pan rev/px   still rev/px   lifted frames (pan / hold)");
  const capStr = (c) => (c
    ? `${c.panLift}/${c.panN} pan, ${c.holdLift}/${c.holdN} hold` +
      `  tr ${c.panTr?.toFixed(2)}/${c.holdTr?.toFixed(2)} sh ${c.sh?.toFixed(3)}/${c.holdSh?.toFixed(3)}` +
      ` em ${c.em?.toFixed(2)}/${c.holdEm?.toFixed(2)} lum ${c.lum?.toFixed(3)}/${c.holdLum?.toFixed(3)}`
    : "-");
  for (const [i, r] of camVerifyRounds.entries()) {
    console.log(`  ${i + 1}      lift-on   ${r.liftPan.meanReversals.toFixed(3).padEnd(12)} ${r.liftStill.meanReversals.toFixed(3).padEnd(14)} ${capStr(r.liftPanCap)}`);
    console.log(`  ${i + 1}      lift-off  ${r.noPan.meanReversals.toFixed(3).padEnd(12)} ${r.noStill.meanReversals.toFixed(3).padEnd(14)} ${capStr(r.noPanCap)}`);
  }
  const mean = (k, f) => camVerifyRounds.reduce((s, r) => s + r[k][f], 0) / camVerifyRounds.length;
  const exOn = mean("liftPan", "meanReversals") - mean("liftStill", "meanReversals");
  const exOff = mean("noPan", "meanReversals") - mean("noStill", "meanReversals");
  const spread = camVerifyRounds.length > 1
    ? Math.abs(camVerifyRounds[0].noPan.meanReversals - camVerifyRounds[1].noPan.meanReversals)
    : NaN;
  console.log(`  PAN EXCESS over own still: lift-on ${exOn.toFixed(3)}  vs  lift-off ${exOff.toFixed(3)}` +
    `   (spread on lift-off pan: ${spread.toFixed(3)})`);
  if (exOff - exOn > Math.max(spread * 1.5, Math.abs(exOn) * 0.25)) {
    console.log("  ⇒ THE CAMERA LIFT HOLDS: pans burst-fill cold probes at natural rate.");
  } else {
    console.log("  ⇒ NO MEASURABLE EFFECT — check the lift armed at all (per-frame deltas vs");
    console.log("     CAM_LIFT_POS/ROT thresholds; a too-slow scripted pan can sit under them).");
  }
}

// ── THE LIGHT-STEP VERDICT ──────────────────────────────────────────────────
if (stepRounds.length) {
  console.log(`
=== LIGHT STEP A/B (intensity toggles at frame ${STEP_AT}; shipped(lift) vs no-lift vs window-off, x${stepRounds.length}) ===`);
  console.log("  round  config      dir     rev/px    p95      meanWalk");
  for (const [i, r] of stepRounds.entries()) {
    for (const name of STEP_NAMES) {
      const a = r[name];
      console.log(`  ${i + 1}      ${name.padEnd(11)} ${a.dir.padEnd(7)} ${a.arm.meanReversals.toFixed(3).padEnd(9)} ` +
        `${a.arm.stepP95.toFixed(4).padEnd(8)} ${a.arm.meanWalk.toFixed(3)}`);
    }
  }
  const mean = (name, f) => stepRounds.reduce((s, r) => s + r[name].arm[f], 0) / stepRounds.length;
  const spread = stepRounds.length > 1
    ? Math.abs(stepRounds[0].shipped.arm.meanReversals - stepRounds[1].shipped.arm.meanReversals)
    : NaN;
  console.log(`  means — shipped ${mean("shipped", "meanReversals").toFixed(3)}, no-lift ${mean("no-lift", "meanReversals").toFixed(3)}, ` +
    `window-off ${mean("window-off", "meanReversals").toFixed(3)} rev/px (shipped round spread ${spread.toFixed(3)})`);
  const liftWin = mean("no-lift", "meanReversals") - mean("shipped", "meanReversals");
  console.log(`  what the window cap lift bought: ${liftWin.toFixed(3)} rev/px (no-lift − shipped;`);
  console.log("     the pre-fix run priced the ceiling at 8.76 — cap-off read 15.3 vs shipped-then 24.1)");
  console.log("     (window-off is the slow-convergence reference, not a target — §12.43's t90)");
  if (liftWin > Math.max(spread * 1.5, mean("shipped", "meanReversals") * 0.15)) {
    console.log("  ⇒ THE WINDOW CAP LIFT HOLDS: shipped now converges at uncapped evidence rate");
    console.log("     during the tracking window and re-caps after.");
  } else {
    console.log("  ⇒ NO MEASURABLE LIFT EFFECT — check `__giSrcTransport.probeRayCap` flips during");
    console.log("     the window (a pinned cap never lifts; is the arm accidentally pinning?).");
  }
}

// ── THE CONTINUOUS-ROTATION VERDICT ─────────────────────────────────────────
if (rotRounds.length) {
  console.log(`
=== LIGHT ROT A/B (continuous sun ping-pong, ${ROT_RATE} rad/frame; shipped vs no-lift vs window-off, x${rotRounds.length}) ===`);
  console.log("  round  config      rev/px    p95      capLift%  trMax  αmean   still-after rev/px");
  for (const [i, r] of rotRounds.entries()) {
    for (const name of ROT_NAMES) {
      const a = r[name];
      const liftPct = a.caps ? ((a.caps.rotLift / Math.max(1, a.caps.rotN)) * 100).toFixed(0) : "?";
      console.log(`  ${i + 1}      ${name.padEnd(11)} ${a.arm.meanReversals.toFixed(3).padEnd(9)} ` +
        `${a.arm.stepP95.toFixed(4).padEnd(8)} ${String(liftPct).padEnd(9)} ` +
        `${(a.caps?.trMax ?? NaN).toFixed(2).padEnd(6)} ${(a.caps?.alphaMean ?? NaN).toFixed(3).padEnd(7)} ` +
        `${a.still.meanReversals.toFixed(3)}`);
    }
  }
  const mean = (name, f) => rotRounds.reduce((s, r) => s + r[name].arm[f], 0) / rotRounds.length;
  const liftOf = (name) => rotRounds.reduce((s, r) => s + (r[name].caps ? r[name].caps.rotLift / Math.max(1, r[name].caps.rotN) : 0), 0) / rotRounds.length;
  const spread = rotRounds.length > 1
    ? Math.abs(rotRounds[0].shipped.arm.meanReversals - rotRounds[1].shipped.arm.meanReversals)
    : NaN;
  console.log(`  means — shipped ${mean("shipped", "meanReversals").toFixed(3)}, level-arm ${mean("level-arm", "meanReversals").toFixed(3)}, ` +
    `no-lift ${mean("no-lift", "meanReversals").toFixed(3)}, window-off ${mean("window-off", "meanReversals").toFixed(3)} rev/px ` +
    `(shipped round spread ${spread.toFixed(3)})`);
  // §12.46 FIX VERIFY: rising-edge shipped must run steady rotation with the
  // window CLOSED (cap at tier) at churn comparable to window-off, while
  // level-arm reproduces the pre-fix pin (capLift ~100%). Pre-fix reference
  // run (2026-08-12): level 4.62 @ 100% lift / no-lift 30.88 / window-off 5.07.
  const sLift = liftOf("shipped"), lLift = liftOf("level-arm");
  const churnOk = mean("shipped", "meanReversals") <=
    mean("window-off", "meanReversals") + Math.max(spread * 1.5, mean("window-off", "meanReversals") * 0.25);
  if (sLift < 0.1 && lLift > 0.9 && churnOk) {
    console.log("  ⇒ §12.46 HOLDS: rising-edge arming runs the day cycle at tier cost (capLift " +
      `${(sLift * 100).toFixed(0)}%) with window-off churn; level-arm still pins (${(lLift * 100).toFixed(0)}%).`);
  } else {
    console.log(`  ⇒ CHECK: shipped capLift ${(sLift * 100).toFixed(0)}% (want <10), level-arm ` +
      `${(lLift * 100).toFixed(0)}% (want >90), shipped churn ${churnOk ? "ok" : "ABOVE window-off band"}.`);
    console.log("     A shipped arm that still lifts means an edge is firing repeatedly — check the");
    console.log("     REARM dwell against this rotation's sub-threshold dwell pattern.");
  }
}

// ── α UNDER ROTATION: THE CHURN/LAG TRADE ───────────────────────────────────
if (rotAlphaRounds.length) {
  console.log(`
=== ROT ALPHA SWEEP (continuous sun, shipping window/cap config, x${rotAlphaRounds.length}, round 2 reversed) ===`);
  console.log(`  settle = NET |Δlum| over ${SETTLE_FRAMES} frames after the sun stops = the LAG`);
  console.log("  α        churn rev/px (r1/r2)   step p95 (r1/r2)      LAG mean (r1/r2)      LAG p95");
  for (const a of ROT_ALPHA) {
    const r = rotAlphaRounds.map((round) => round[a]);
    console.log(
      `  ${String(a).padEnd(7)} ${r.map((x) => x.meanReversals.toFixed(3)).join(" / ").padEnd(21)} ` +
      `${r.map((x) => x.stepP95.toFixed(4)).join(" / ").padEnd(21)} ` +
      `${r.map((x) => (x.netSettle?.mean ?? NaN).toFixed(5)).join(" / ").padEnd(21)} ` +
      `${r.map((x) => (x.netSettle?.p95 ?? NaN).toFixed(4)).join(" / ")}`);
  }
  const meanOf = (a, f) => rotAlphaRounds.reduce((s, round) => s + f(round[a]), 0) / rotAlphaRounds.length;
  const hi = ROT_ALPHA[0], lo = ROT_ALPHA[ROT_ALPHA.length - 1];
  const churnGain = meanOf(hi, (x) => x.meanReversals) / Math.max(1e-9, meanOf(lo, (x) => x.meanReversals));
  const lagCost = meanOf(lo, (x) => x.netSettle?.mean ?? 0) / Math.max(1e-9, meanOf(hi, (x) => x.netSettle?.mean ?? 0));
  console.log(`  α ${hi} → ${lo}: churn ×${(1 / churnGain).toFixed(2)} (lower is calmer), lag ×${lagCost.toFixed(2)} (lower is truer)`);
  if (churnGain > 1.5 && lagCost < 1.5) {
    console.log("  ⇒ SUSTAINED MOTION DOES NOT NEED THE FAST α: churn falls faster than lag rises,");
    console.log("     so the §12.38 ramp is mispriced for smooth motion (it was tuned on STEPS).");
  } else if (lagCost >= 1.5) {
    console.log(`  ⇒ A REAL TRADE: the slower α trails the sun ${lagCost.toFixed(2)}× further. Any change here`);
    console.log("     needs a rate-aware α (innovation per frame), not a flat reduction.");
  } else {
    console.log("  ⇒ α IS NOT THE LEVER HERE — churn barely moves with it, so the rotating churn is");
    console.log("     structural (bin membership, §12.24) rather than variance.");
  }
}

// ── THE α SWEEP VERDICT ─────────────────────────────────────────────────────
// Stride is constant across these arms, so raw counts compare directly. What
// each column means: still reversals = the base instability (variance if it
// falls with α, structural churn if it does not); moving step p95 = the real
// geometric signal (if α eats IT, smoothing is trading ghosting for calm).
if (alphaRounds.length) {
  console.log(`
=== ALPHA SWEEP (still + moving per α, interleaved x${alphaRounds.length}, round 2 reversed) ===`);
  console.log("  α        still rev/px (r1/r2)   still p95 (r1/r2)     moving rev/px   moving p95 (r1/r2)");
  for (const a of ALPHA_SWEEP) {
    const r = alphaRounds.map((round) => round[a]);
    console.log(
      `  ${String(a).padEnd(7)} ${r.map((x) => x.still.meanReversals.toFixed(3)).join(" / ").padEnd(21)} ` +
      `${r.map((x) => x.still.stepP95.toFixed(4)).join(" / ").padEnd(21)} ` +
      `${r.map((x) => x.moving.meanReversals.toFixed(3)).join(" / ").padEnd(15)} ` +
      `${r.map((x) => x.moving.stepP95.toFixed(4)).join(" / ")}`);
  }
  const meanOf = (a, f) => alphaRounds.reduce((s, round) => s + f(round[a]), 0) / alphaRounds.length;
  const hi = ALPHA_SWEEP[0], lo = ALPHA_SWEEP[ALPHA_SWEEP.length - 1];
  const stillFall = meanOf(hi, (x) => x.still.meanReversals) / Math.max(1e-9, meanOf(lo, (x) => x.still.meanReversals));
  const signalHold = meanOf(lo, (x) => x.moving.stepP95) / Math.max(1e-9, meanOf(hi, (x) => x.moving.stepP95));
  console.log(`
  still reversals fall ${stillFall.toFixed(2)}x from α=${hi} to α=${lo}; ` +
    `moving step p95 at α=${lo} is ${(signalHold * 100).toFixed(0)}% of α=${hi}'s`);
  console.log("  (fall >> 1 with p95 held ⇒ variance-driven flicker, α is the lever;");
  console.log("   fall ≈ 1 ⇒ structural churn — look at MIN_WEIGHT membership, not α)");
}

await browser.close();
process.exit(0);
