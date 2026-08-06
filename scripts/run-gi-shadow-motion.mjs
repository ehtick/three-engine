// GI SHADOW QUALITY UNDER A MOVING LIGHT — the user's design case ("we never
// meant to do those lights static"), measured on the shadow CHANNEL itself.
//
// Reproduces the game setup: a script-driven sun rotating continuously, gi
// traced shadows, fixed camera. Reads back the lightShadow texture (what
// materials sample) over consecutive frames and reports:
//   · FLICKER: mean |frame_t − frame_t−1| over penumbra pixels — the
//     "jumpy" number;
//   · GRAIN: mean |4-neighbour Laplacian| within the penumbra — the
//     "grainy" number;
//   · penumbra coverage, so arms are comparing the same signal.
// Arms (env ARM): "analytic" = the SHIPPING DEFAULT (deterministic
// analytic-width, docs/GI_SHADOWS_PLAN.md §5 — its bar is flicker AND grain
// at the static noise floor WHILE the sun rotates); the three stochastic-path
// arms pin __giShadowAnalyticWidth=false: "on" = sun-disc + temporal,
// "off" = temporal also off (raw dither baseline), "still" = temporal on +
// static light (the convergence ceiling). ROT=deg/sec overrides rotation.
//
//   node scripts/run-gi-shadow-motion.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const arm = process.env.ARM ?? "on";
const rotDegPerSec = Number(process.env.ROT ?? 8);
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] (light shadows|built)|GI-MOTION/.test(t)) console.log(`  ${t.slice(0, 220)}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async ({ arm, rotDegPerSec }) => {
  globalThis.__editorKeepRendering = true;
  // Build-time hatches — set BEFORE the GI entity below triggers the build.
  // Analytic-width is the default; the stochastic arms pin it off.
  if (arm === "off" || arm === "on" || arm === "still") globalThis.__giShadowAnalyticWidth = false;
  if (arm === "off") globalThis.__giShadowTemporal = false;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");

  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) {
    if (child.isMesh) engine.scene.remove(child);
  }

  const anon = (g) => { const n = g.toNonIndexed(); n.parameters = undefined; n.type = "BufferGeometry"; return n; };
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(24, 0.3, 24)), mat);
  floor.position.y = -0.15;
  // A tall occluder so a 10-15° source angle produces a WIDE penumbra band
  // on the floor several meters from the base.
  const wall = new THREE.Mesh(anon(new THREE.BoxGeometry(0.4, 5, 8)), mat);
  wall.position.set(-3, 2.5, 0);
  engine.scene.add(floor, wall);

  const sunEnt = engine.createEntity({ name: "Motion Sun" });
  sunEnt.addComponent("light", {
    type: "directional", color: "#ffffff", intensity: 3,
    castShadow: true, shadowMode: "gi", sourceAngle: 12,
  });
  sunEnt.object3D.position.set(6, 8, 2);
  sunEnt.object3D.lookAt(0, 0, 0);

  const gi = engine.createEntity({ name: "GI Motion Test" });
  gi.addComponent("global-illumination", { autoFit: true, quality: "high" });

  const system = engine.modules.get("gi").system;
  const deadline = performance.now() + 90_000;
  let screen = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    screen = system.state?.screen ?? null;
    if (screen?.lightShadowPass && (system.state?.volume?.occupancyField?.stats?.dispatches ?? 0) > 3) break;
  }
  if (!screen) return { fail: "GI never built a screen bundle" };
  // Quiesce the boot re-arm loop before measuring.
  {
    const end = performance.now() + 60_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 5) {
      await new Promise((r) => setTimeout(r, 200));
      const d = system.state?.volume?.occupancyField?.debugIncremental;
      quiet = globalThis.__giPendingComputePipelines?.size === 0 && d && !d.dirty && !d.staticDirty ? quiet + 1 : 0;
    }
  }

  // Script-driven sun, matching the game: rewrite the transform every frame.
  const rotate = arm !== "still";
  const t0 = performance.now();
  const orbit = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const a = (rotate ? t * rotDegPerSec : 0) * (Math.PI / 180);
    sunEnt.object3D.position.set(6 * Math.cos(a) - 2 * Math.sin(a), 8, 6 * Math.sin(a) + 2 * Math.cos(a));
    sunEnt.object3D.lookAt(0, 0, 0);
  }, 16);
  // Let the accumulation reach steady state under motion.
  await new Promise((r) => setTimeout(r, 2500));

  const W = screen.shadowWidth, H = screen.shadowHeight;
  // WEBGPU READBACK PADDING: copyTextureToBuffer returns rows aligned to 256
  // BYTES and does NOT repack — tight indexing scrambles every row whose
  // width×4 isn't 256-aligned (303×4=1212→1280), which silently invalidates
  // every spatial metric. Index through the padded stride.
  const strideBytes = Math.ceil((W * 4) / 256) * 256;
  const grab = async (tex) => {
    const data = await engine.renderer.backend.copyTextureToBuffer(tex, 0, 0, W, H);
    // rgba8 → channel 0 (slot 0) normalized.
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * strideBytes;
      for (let x = 0; x < W; x++) out[y * W + x] = data[row + x * 4] / 255;
    }
    return out;
  };

  const FRAMES = 14;
  const frames = [];
  const rawFingerprints = [];
  const phases = [];
  const slotVecs = [];
  const slot0 = screen.lightShadow?.slots?.[0];
  for (let i = 0; i < FRAMES; i++) {
    frames.push(await grab(screen.targets.lightShadow));
    const raw = await grab(screen.targets.lightShadowRaw);
    let sum = 0;
    for (let k = 0; k < raw.length; k += 7) sum += raw[k];
    rawFingerprints.push(Math.round(sum));
    phases.push(system._giShadowFrameU?.value ?? -1);
    const v = slot0?.vector?.value;
    slotVecs.push(v ? `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}` : "?");
    await new Promise((r) => setTimeout(r, 90));
  }
  clearInterval(orbit);

  // Penumbra mask per frame pair: pixels neither fully lit nor fully dark.
  const inPen = (v) => v > 0.08 && v < 0.92;
  let flickerSum = 0, flickerN = 0;
  for (let f = 1; f < FRAMES; f++) {
    const a = frames[f - 1], b = frames[f];
    for (let i = 0; i < a.length; i++) {
      if (inPen(a[i]) || inPen(b[i])) {
        flickerSum += Math.abs(b[i] - a[i]);
        flickerN++;
      }
    }
  }
  const grainOf = (img) => {
    let sum = 0, n = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!inPen(img[i])) continue;
        const lap = img[i] * 4 - img[i - 1] - img[i + 1] - img[i - W] - img[i + W];
        sum += Math.abs(lap);
        n++;
      }
    }
    return { grain: n ? sum / n : 0, n };
  };
  const last = frames[FRAMES - 1];
  // Same-instant stage comparison (the shadow moves fast — grabbing stages
  // seconds apart made the post-filter look like it ADDED noise).
  const rawLast = await grab(screen.targets.lightShadowRaw);
  // The analytic-width arm has no accum stage (trace → one filter → final);
  // its accum texture exists but is never written, and copyTextureToBuffer
  // throws on a GPU texture no pass ever touched. Read final in its place so
  // the stage table stays shaped.
  const accumLast = screen.lightShadowHistoryPass
    ? await grab(screen.targets.lightShadowAccum)
    : await grab(screen.targets.lightShadow);
  const finalLast = await grab(screen.targets.lightShadow);
  const rawG = grainOf(rawLast);
  const accumG = grainOf(accumLast);
  const finalG = grainOf(finalLast);
  const grainSum = finalG.grain, penCount = finalG.n, grainN = finalG.n ? 1 : 0;
  // Is the queue's post entry the CURRENT pass? And what does a manual
  // dispatch of the current post pass produce?
  const q = system.state.queue ?? [];
  const queueHas = {
    trace: q.includes(screen.lightShadowPass?.compute),
    filter: q.includes(screen.lightShadowFilterPass?.compute),
    history: q.includes(screen.lightShadowHistoryPass?.compute),
    post: q.includes(screen.lightShadowPostPass?.compute),
  };
  let manualPostGrain = -1;
  if (screen.lightShadowPostPass) {
    engine.renderer.compute(screen.lightShadowPostPass.compute);
    await new Promise((r) => setTimeout(r, 120));
    manualPostGrain = grainOf(await grab(screen.targets.lightShadow)).grain;
  }
  // Is post ≈ identity? Mean |final − accum| near zero would mean the post's
  // source is effectively its own target, not the accum texture.
  let accumFinalDiff = 0;
  for (let i = 0; i < finalLast.length; i++) accumFinalDiff += Math.abs(finalLast[i] - accumLast[i]);
  accumFinalDiff /= finalLast.length;
  return {
    arm, rotDegPerSec: rotate ? rotDegPerSec : 0,
    shadowRes: `${W}x${H}`,
    penumbraPx: penCount,
    flicker: flickerN ? flickerSum / flickerN : 0,
    grain: grainN ? grainSum / grainN : 0,
    grainRaw: rawG.grain,
    grainAccum: accumG.grain,
    manualPostGrain,
    accumFinalDiff,
    stageN: { raw: rawG.n, accum: accumG.n, final: finalG.n },
    queueHas,
    histWeight: system._giShadowHistWeightU?.value ?? null,
    lastMotion: system._giShadowLastMotion ?? null,
    rawFingerprints,
    phases,
    slotVecs: [slotVecs[0], slotVecs[Math.floor(FRAMES / 2)], slotVecs[FRAMES - 1]],
  };
}, { arm, rotDegPerSec });

if (result.fail) {
  console.log(`FAIL: ${result.fail}`);
  await browser.close();
  process.exit(1);
}
console.log(
  `GI-MOTION arm=${result.arm} rot=${result.rotDegPerSec}°/s res=${result.shadowRes} penumbraPx=${result.penumbraPx} ` +
  `flicker=${result.flicker.toFixed(4)} grain=${result.grain.toFixed(4)} (raw=${result.grainRaw.toFixed(4)} accum=${result.grainAccum.toFixed(4)}) histWeight=${result.histWeight} lastMotion=${result.lastMotion}\n` +
  `  rawFp=[${result.rawFingerprints}]\n  phases=[${result.phases}]\n  slot0=[${result.slotVecs.join(" | ")}]\n` +
  `  manualPostGrain=${result.manualPostGrain.toFixed(4)} accumFinalDiff=${result.accumFinalDiff.toFixed(4)} ` +
  `stageN=${JSON.stringify(result.stageN)} queueHas=${JSON.stringify(result.queueHas)}`,
);
await browser.close();
