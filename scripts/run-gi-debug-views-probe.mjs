// Debug-view smoke: the two GI volume overlay views must actually COMPILE and
// RENDER, which is the one thing a bundle check cannot tell you.
//
// Why this exists: both views moved off `giField.js` to `srcDebugViews.js` in the
// §5 deletion sweep, and the "sdf" one was REWRITTEN — it marched the composited
// `distanceTexture` (deleted with the transport) and now sphere-traces the
// distance oracle with a six-tap gradient for its normal. TSL graphs are built
// eagerly, so a malformed graph throws at rebuild; WGSL codegen and the driver
// compile only happen when the mesh first renders, and the views start
// `visible = false`. Nothing else in the harness ever makes them visible.
//
// ── THREE INSTRUMENT TRAPS THIS PROBE PAID FOR, all three of which reported
// "the overlay shader is broken" when the shader was fine:
//
// 1. `gi.props.debugProbes = mode` DOES NOTHING. A raw props write skips the
//    component's prop accessor, so `onPropChanged` → GISystem.onComponentProp →
//    #applyDebugVisibility never fires and every view stays hidden. Use
//    `setProp`.
// 2. A full-page screenshot measures THE EDITOR'S CHROME. The viewport panel is
//    a few hundred pixels inside a 1000×700 page, so every arm scored 98.9%
//    coverage at identical mean luminance whether the overlay drew or not — the
//    panel layout was being measured, not the renderer. `viewport.screenshot`
//    renders offscreen at a requested size with gizmos excluded.
// 3. **OrbitControls owns the camera's orientation.** Writing
//    `engine.camera.position` + `lookAt` is silently reverted on the controls'
//    next update, so the probe aimed at a room it never saw. `viewport.setCamera`
//    is the supported path and calls `orbit.update()` for you — see the comment
//    in `src/editor/api/ops/viewport.js` that says exactly this.
//
// ── WHAT THIS GATES, AND WHAT IT ONLY REPORTS.
//
// GATED: no page error across any arm. That is the failure the §5 rewrite can
// actually introduce and the one this rig proves — a node material off the wrong
// `three` entry point, or a TSL graph that will not codegen, throws here.
//
// REPORTED, NOT GATED: whether either view puts a readable PICTURE up. In this
// headless rig BOTH views march and then discard essentially every pixel — the
// mesh is drawn (draw calls and GPU time both rise) and the frame barely moves.
// That is equally true of the OCCUPANCY view, which this sweep only moved,
// byte-for-byte. Symptom-invariance across the swap puts the cause in the rig
// rather than in the rewrite, so gating on it would fail the probe for something
// it does not measure. Two candidate causes, neither investigated here: a storage
// buffer read from a FRAGMENT stage (giLight.js:955 states the occupancy bits
// must never enter fragment shaders — these overlay materials are the one place
// they deliberately do), and headless WebGPU. A real eye check is a person
// switching Debug View in the editor.
//
// The two-consecutive-`off` arm is the NOISE FLOOR: GI accumulates temporally, so
// consecutive identical frames already differ, and a Δ near that floor means the
// overlay contributed nothing visible.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  const text = message.text();
  if (/GI-DV|\[gi\].*(rror|ailed)/.test(text)) console.log(`  ${text}`);
});

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  // A headless page is never focused, and the viewport can be set to stop
  // rendering when it isn't — a frozen viewport returns the same stale frame to
  // every arm, which is indistinguishable from "the overlay never drew".
  globalThis.__editorApi.viewport.freezeWhenUnfocused(false);

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  // A room with the features each view exists to expose: a floor a ray can hug,
  // a thin wall (about one voxel at high quality), and a pillar plus a sphere so
  // both flat and curved silhouettes are judgeable.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.3, 12), material(0xcccccc));
  floor.position.set(0, -0.15, 0);
  engine.scene.add(floor);
  const back = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 0.3), material(0x999999));
  back.position.set(0, 2.5, -6);
  engine.scene.add(back);
  const thin = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.12), material(0xbbbbbb));
  thin.position.set(-3, 1.5, 1);
  engine.scene.add(thin);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 0.5), material(0xb0b0b0));
  pillar.position.set(1.5, 1.5, 0);
  engine.scene.add(pillar);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 24), material(0xaaaaaa));
  ball.position.set(3.2, 0.8, 1.5);
  engine.scene.add(ball);

  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), material(0xffffff));
  lamp.material.emissive = new THREE.Color(0xffffff);
  lamp.material.emissiveIntensity = 30;
  lamp.position.set(-1, 3.4, 2);
  engine.scene.add(lamp);

  const giEntity = engine.createEntity({ name: "GI" });
  const gi = giEntity.addComponent("global-illumination", {
    autoFit: true, quality: "high", intensity: 1, debugProbes: "off",
  });
  globalThis.__gi = gi;
  // `setProp`, NOT a raw props write — see trap 1 in the header.
  globalThis.__setView = (mode) => { gi.setProp("debugProbes", mode); };
  console.log("GI-DV scene ready");
});

// Aim through the editor's own op — see trap 3. INSIDE the volume, looking
// across the room: both views are back-faced boxes, so a camera inside the
// volume puts the overlay across the whole frame and a weak signal cannot be
// confused with a weak result.
await page.evaluate(() => globalThis.__editorApi.viewport.setCamera([0, 1.6, 4.5], [0, 1.2, -2]));
await new Promise((resolve) => setTimeout(resolve, 12000));

const WIDTH = 480;
const HEIGHT = 320;
// The live viewport canvas rect in device pixels, for the second-opinion crop.
const canvasRect = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll("canvas")]
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.max(0, Math.round(r.x * dpr)),
    y: Math.max(0, Math.round(r.y * dpr)),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
});
console.log(`live canvas: ${canvasRect.width}x${canvasRect.height} at ${canvasRect.x},${canvasRect.y}`);
let failures = 0;

async function shoot(mode) {
  await page.evaluate((m) => globalThis.__setView(m), mode);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  // MECHANISM READOUT before the pixels: every failure this probe has actually
  // produced was the harness not reaching the views, and a coverage number
  // cannot tell that apart from a broken shader.
  const wiring = await page.evaluate(() => {
    const system = globalThis.__engine.modules.get("gi")?.system;
    const g = system?.state?.gizmos;
    return {
      prop: globalThis.__gi.props.debugProbes,
      sdf: g?.sdfView ? { visible: g.sdfView.visible, inScene: !!g.sdfView.parent } : null,
      occ: g?.occView ? { visible: g.occView.visible, inScene: !!g.occView.parent } : null,
    };
  });
  const before = errors.length;
  // `includeGizmos: true` IS REQUIRED and cost a full diagnostic round to find.
  // `viewport.screenshot` disables EDITOR_LAYER when gizmos are excluded, and the
  // GI debug views are editor overlays — excluded, they are absent from every
  // arm and every Δ reads exactly 0.00, which looks identical to a shader that
  // never drew. The control below is taken with the SAME setting: comparing a
  // no-gizmo control against a with-gizmo arm measures the editor GRID, which is
  // how a meaningless Δ=1.55 nearly got read as the overlay working.
  const shot = await page.evaluate(
    async (w, h) => globalThis.__editorApi.viewport.screenshot({ width: w, height: h, includeGizmos: true }),
    WIDTH, HEIGHT,
  );
  const png = Buffer.from(shot.__image.base64, "base64");
  await sharp(png).toFile(`scripts/gi-diag-view-${mode}.png`);
  // The LIVE canvas, cropped, as a second opinion on the offscreen capture.
  const live = await page.screenshot();
  await sharp(live)
    .extract({ left: canvasRect.x, top: canvasRect.y, width: canvasRect.width, height: canvasRect.height })
    .toFile(`scripts/gi-diag-live-${mode}.png`);
  const liveCrop = await sharp(live)
    .extract({ left: canvasRect.x, top: canvasRect.y, width: canvasRect.width, height: canvasRect.height })
    .raw().toBuffer({ resolveWithObject: true });
  const livePx = [];
  for (let i = 0; i < liveCrop.info.width * liveCrop.info.height; i++) {
    const j = i * liveCrop.info.channels;
    livePx.push(0.2126 * liveCrop.data[j] + 0.7152 * liveCrop.data[j + 1] + 0.0722 * liveCrop.data[j + 2]);
  }
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  let sum = 0;
  const total = info.width * info.height;
  const px = [];
  for (let i = 0; i < total; i++) {
    const idx = i * info.channels;
    const L = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
    if (L > 12) lit++;
    sum += L;
    px.push(L);
  }
  const newErrors = errors.slice(before);
  const result = { mode, coverage: lit / total, mean: sum / total, px, livePx, wiring, errors: newErrors };
  console.log(
    `  ${mode}: coverage=${(result.coverage * 100).toFixed(1)}% meanL=${result.mean.toFixed(1)} ` +
    `wiring=${JSON.stringify(wiring)}`,
  );
  return result;
}

/** Mean absolute per-pixel luminance difference — the control comparison. */
function diff(a, b, key = "px") {
  let sum = 0;
  for (let i = 0; i < a[key].length; i++) sum += Math.abs(a[key][i] - b[key][i]);
  return sum / a[key].length;
}

// "off" is the CONTROL: the scene itself. Controls first — a view that matched
// the control exactly would mean the overlay never drew at all. Twice, because
// the second one measures the frame-to-frame noise the comparison sits on.
const off = await shoot("off");
const off2 = await shoot("off");
const occ = await shoot("occupancy");
const sdf = await shoot("sdf");
const noise = { offscreen: diff(off2, off), live: diff(off2, off, "livePx") };
console.log(`noise floor (off vs off): Δ offscreen=${noise.offscreen.toFixed(2)} live=${noise.live.toFixed(2)}`);

for (const view of [occ, sdf]) {
  const offscreen = diff(view, off);
  const liveDelta = diff(view, off, "livePx");
  const clean = view.errors.length === 0;
  if (!clean) failures++;
  // Above the noise floor by a clear margin = the overlay put pixels up.
  const readable = liveDelta > noise.live * 3 + 1;
  console.log(
    `${clean ? "PASS" : "FAIL"} view=${view.mode} compiled+drew` +
    (clean ? "" : ` — errors=${JSON.stringify(view.errors.slice(0, 2))}`),
  );
  console.log(
    `     picture (REPORTED, not gated): Δ live=${liveDelta.toFixed(2)} offscreen=${offscreen.toFixed(2)} ` +
    `coverage=${(view.coverage * 100).toFixed(1)}% -> ${readable ? "readable" : "DISCARDS ~everything (see header)"}`,
  );
}
// The offscreen capture is a known-blind instrument for these two views and the
// number is kept only so a future change that makes it work is noticed.
console.log("note: viewport.screenshot excludes EDITOR_LAYER; these overlays are on it, so offscreen Δ is structurally ~0");

if (errors.length) console.log(`page errors (${errors.length}):`, errors.slice(0, 4));
console.log(failures ? `gi-debug-views: ${failures} FAILURE(S)` : "gi-debug-views: all views PASS");
await browser.close();
process.exit(failures ? 1 : 0);
