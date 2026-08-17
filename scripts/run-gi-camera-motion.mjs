// WHY DOES MOVING THE CAMERA COST 3x THE FRAME? — per-frame, one boot, four arms.
//
// The complaint: "70 fps on high, but the moment I move the camera the CPU
// blows up and fps falls to 15-30." Every instrument in the repo reports a MEAN
// over a settled window, which is exactly the wrong shape for this: a mean over
// 60 frames hides the two 40 ms frames that are the whole user experience, and
// a camera JUMP (`viewport.setCamera`) is not a camera DRAG — it pays each
// transient once instead of every frame.
//
// So this harness (a) drives a REAL MOUSE DRAG on the viewport canvas, which is
// the literal thing the user does and the only way OrbitControls' per-frame
// update, the shadow camera's recentring and GI's follow all arm together, and
// (b) reports a DISTRIBUTION (p50/p95/max) of per-frame wall time, not a mean.
//
// ══ THE ARMS, and why each one is here ═════════════════════════════════════
//
//   park            camera untouched — the 70 fps the user reports
//   drag            continuous drag — the 15-30 fps the user reports
//   drag+pinned     drag with `shadowCamSnap` raised so the directional shadow
//                   camera never leaves its snap cell. ShadowFreeze therefore
//                   stays engaged for the whole drag. If the drag cost collapses
//                   here, the cost IS the shadow map being redrawn on motion.
//   drag+nofreeze   drag with ShadowFreeze disabled outright — the shadow map
//                   redraws EVERY frame. This is the POSITIVE CONTROL: it prices
//                   one shadow redraw per frame directly, so `drag` can be
//                   located between the two bounds instead of merely differing
//                   from one.
//
// The middle two are what make this a measurement rather than an anecdote. A
// `drag` that lands on `drag+nofreeze` says the shadow pass is redrawing every
// frame; a `drag` that lands on `drag+pinned` says shadows are already frozen
// and the cost is somewhere else entirely (GI follow, merging, encode volume).
//
// ⚠ ALL FOUR ARMS RUN IN ONE BOOT. Cross-boot absolute comparison on this
// project is known-weak — two identical control boots have read 24% apart
// (memory: gi-frame-budget) — because pool floors, viewport height and the
// compile wave all differ per load. Within one boot the only thing changing is
// the arm.
//
//   node scripts/run-gi-camera-motion.mjs            (vite on :5201)
//   QUALITY=high FRAMES=180 node scripts/run-gi-camera-motion.mjs
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME";
const QUALITY = process.env.QUALITY ?? "high";
const FRAMES = Number(process.env.FRAMES ?? 180);
const SETTLE = Number(process.env.SETTLE ?? 25000);
const OUT = ".gi-shots/camera-motion";
await mkdir(OUT, { recursive: true });
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
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) giLines.push(t.slice(0, 300));
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));

await page.evaluateOnNewDocument((project, tier) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  // GI has ONE property (standing rule) — the harness forces the tier through
  // the config override rather than by writing the component's props.
  globalThis.__giConfigOverride = { quality: tier };
  if (globalThis.__abGlobals) Object.assign(globalThis, globalThis.__abGlobals);
}, PROJECT, QUALITY);
if (process.env.ABGLOBALS) {
  const ab = JSON.parse(process.env.ABGLOBALS);
  await page.evaluateOnNewDocument((ab) => Object.assign(globalThis, ab), ab);
  console.log(`AB globals ${JSON.stringify(ab)}`);
}

console.log(`opening ${PROJECT} at quality=${QUALITY} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
console.log(`built — settling ${SETTLE} ms (GI convergence + the §12.61 rest cadence)`);
await wait(SETTLE);

// ── engine handle: the ops module keeps `engine` module-private, so reach it
// through any live entity the way every other probe in this repo does.
await page.evaluate(async () => {
  const scene = await globalThis.__editorApi.call("scene.get");
  const id = scene.rootIds?.[0];
  globalThis.__eng = globalThis.__editorApi.entities.live(id)?.engine;
  if (!globalThis.__eng) throw new Error("no engine handle");
  globalThis.__dirLights = () => {
    const out = [];
    for (const e of globalThis.__eng.entities.values()) {
      // `entity.components` is a Map(type -> component): iterate its VALUES.
      // Spreading the Map yields [key, value] pairs and silently finds nothing.
      for (const c of e.components.values()) {
        if (c?.props && "shadowCamSnap" in c.props && c.props.kind === "directional" && c.props.castShadow) out.push(c);
      }
    }
    return out;
  };
});

// ── TREATMENTS. Applied HERE — after the project is open but BEFORE the settle
// — because writing a light prop rebuilds GI's light and dynamic-object state,
// and that rebuild must be absorbed by the settle rather than priced inside an
// arm. Doing it between arms is what voided the first run: `gi.dynamicObjects`
// went 0.005 → 40 ms/frame and the heap climbed 1.5 GB mid-experiment.
//
// ⚠ Each treatment is its own BOOT, so quote the DRAG/PARK RATIO and the drag
// fps within a boot. Cross-boot absolutes on this project are known-weak
// (two identical controls have read 24% apart).
const TREAT = process.env.TREAT ?? "none";
if (TREAT !== "none") {
  const applied = await page.evaluate((treat) => {
    const out = [];
    for (const lc of globalThis.__dirLights()) {
      if (treat === "snap8") { out.push({ was: lc.props.shadowCamSnap }); lc.setProp("shadowCamSnap", 8); }
      // Shadow Source "gi" deletes the ShadowMap pass outright — GI traces the
      // sun's occlusion against the occupancy pyramid it already maintains, so
      // no scene re-rasterisation happens at all.
      if (treat === "gishadow") { out.push({ was: lc.props.shadowMode }); lc.setProp("shadowMode", "gi"); }
      // `shadowCamSize` is the ortho HALF-extent, so 60 covers 120x120 m for a
      // ~42 m scene: nine times the area it needs. That costs twice — every
      // distant mesh survives the shadow frustum cull (579 draws, MORE than the
      // main pass's 336), and the 2048 map spreads over 120 m at 5.9 cm/texel.
      // Tightening it is the rare change that is cheaper AND sharper.
      if (treat === "camsize25") { out.push({ was: lc.props.shadowCamSize }); lc.setProp("shadowCamSize", 25); }
    }
    return out;
  }, TREAT);
  console.log(`treatment ${TREAT} applied to ${applied.length} light(s): ${JSON.stringify(applied)}`);
  // Long re-settle: switching shadow mode compiles the light-shadow chain
  // (4 pipelines the boot deliberately skipped), and pricing an arm during a
  // compile wave measures the wave.
  console.log(`re-settling ${SETTLE} ms after the treatment …`);
  await wait(SETTLE);
}

// ── the per-frame recorder. rAF (not onPostRender) ON PURPOSE: a frame the
// engine skipped, or a GC pause landing between ticks, still blocks rAF and so
// still shows up as a long interval. Recording only presented frames would
// report exactly the frames that were cheap enough to present.
await page.evaluate(() => {
  globalThis.__mo = { on: false, dt: [], draws: [], tris: [], heap: [] };
  let prev = performance.now();
  const loop = () => {
    const now = performance.now();
    const m = globalThis.__mo;
    if (m.on) {
      m.dt.push(now - prev);
      const r = globalThis.__eng?.stats?.readout;
      if (r) { m.draws.push(r.drawCalls ?? 0); m.tris.push(r.triangles ?? 0); }
      if (performance.memory) m.heap.push(performance.memory.usedJSHeapSize / 1048576);
    }
    prev = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const canvasRect = await page.evaluate(() => {
  const c = globalThis.__eng.renderer.domElement;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log(`canvas ${JSON.stringify(canvasRect)}`);

const cx = canvasRect.x + canvasRect.w / 2;
const cy = canvasRect.y + canvasRect.h / 2;

/** Start/stop the per-frame recorder and return the collected distribution. */
async function record(label, driveDrag) {
  await page.evaluate(() => {
    const m = globalThis.__mo;
    m.dt = []; m.draws = []; m.tris = []; m.heap = []; m.on = true;
    globalThis.__eng.stats.beginPhaseCapture(1e9); // long capture; read the accumulated mean
  });
  if (driveDrag) {
    // A REAL DRAG. OrbitControls rotates on left-button drag, so this is the
    // exact input path the user's complaint comes from — not a setCamera jump,
    // which pays every motion-armed transient once instead of per frame.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const R = Math.min(canvasRect.w, canvasRect.h) * 0.22;
    for (let i = 0; i < FRAMES; i++) {
      // ~0.9 deg of orbit per frame: a slow, deliberate look-around, not a flick.
      const a = (i / FRAMES) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.35);
      await wait(16);
    }
    await page.mouse.up();
  } else {
    await wait(FRAMES * 16);
  }
  // Per-PASS attribution, captured while the arm is still in its state. Total
  // draw count alone says "three times as much geometry got submitted" without
  // saying which passes appeared, and the whole question here is which passes a
  // parked camera skips.
  const passes = await page.evaluate(async () => {
    try {
      const r = await globalThis.__editorApi.call("profile.drawCalls", { frames: 1 });
      return (r.passes ?? []).map((p) => ({ pass: p.pass, draws: p.draws, tris: p.triangles, floor: p.floorIfMerged }));
    } catch (e) { return [{ pass: `ERR ${String(e?.message ?? e).slice(0, 80)}` }]; }
  });
  const out = await page.evaluate((label) => {
    const m = globalThis.__mo;
    m.on = false;
    const cap = globalThis.__eng.stats.readPhaseCapture();
    const dt = [...m.dt].sort((a, b) => a - b);
    const pct = (p) => +(dt[Math.min(dt.length - 1, Math.floor(p * dt.length))] ?? 0).toFixed(2);
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    return {
      label,
      frames: dt.length,
      fps: +(1000 / Math.max(1e-6, mean(m.dt))).toFixed(1),
      dtP50: pct(0.5), dtP95: pct(0.95), dtMax: +(dt[dt.length - 1] ?? 0).toFixed(2),
      over33ms: dt.filter((v) => v > 33).length,
      draws: Math.round(mean(m.draws)), tris: Math.round(mean(m.tris)),
      heapStart: +(m.heap[0] ?? 0).toFixed(0), heapEnd: +(m.heap[m.heap.length - 1] ?? 0).toFixed(0),
      phases: cap.phases.filter((p) => p.ms >= 0.05),
      subPhases: cap.subPhases.filter((p) => p.ms >= 0.05).slice(0, 8),
      capturedFrames: cap.frames, capturedTotalMs: cap.totalMs,
    };
  }, label);
  out.passes = passes;
  return out;
}

/**
 * WHY are the material cache keys recomputed every frame?
 *
 * three only calls the expensive `getMaterialCacheKey()` (which walks every own
 * property of the material AND recursively hashes the node graph via
 * `customProgramCacheKey`) when `renderObject.version !== material.version ||
 * renderObject.needsUpdate` — RenderObjects.get(). So ~21% of frame CPU sitting
 * in that call means one of those two is true every frame, and they have
 * completely different fixes: a churning `material.version` is OUR bug (someone
 * sets `needsUpdate = true` in a per-frame path), whereas a churning
 * `needsUpdate` is three's dynamic key and has to be attacked with fewer draws.
 * Sampling the versions distinguishes them in one read.
 */
async function versionChurn(frames = 60) {
  return page.evaluate(async (frames) => {
    const mats = new Map();
    const scan = () => {
      globalThis.__eng.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mats.set(mm.uuid, mm);
      });
    };
    scan();
    const before = new Map([...mats].map(([k, m]) => [k, m.version]));
    await new Promise((r) => {
      let n = 0;
      const tick = () => (++n >= frames ? r() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    let changed = 0, total = 0;
    for (const [k, m] of mats) { total++; if (before.get(k) !== m.version) changed++; }
    return { materials: total, versionChanged: changed, frames };
  }, frames);
}

// ── WHY DOES ONE DRAW COST 24 µs? ──────────────────────────────────────────
// Every pass in this frame prices out the same: the main pass 8.25 ms / 326
// draws, the GI prepass 7.70 / 325, the shadow map ~14 / 579. That similarity
// is the finding — nothing is special about any one pass, the renderer simply
// costs ~24 µs of CPU per submission, which caps the whole engine at ~690
// draws in a 60 fps frame. So sample the JS stack during a drag and let the
// profiler name the function instead of guessing at it.
const profiler = process.env.PROFILE ? await page.target().createCDPSession() : null;
async function withProfile(fn) {
  if (!profiler) return fn();
  await profiler.send("Profiler.enable");
  await profiler.send("Profiler.setSamplingInterval", { interval: 100 });
  await profiler.send("Profiler.start");
  const out = await fn();
  const { profile } = await profiler.send("Profiler.stop");
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    if (!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"}  ${(f.url || "").split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + 1);
  }
  const total = profile.samples.length || 1;
  console.log(`\n   ── JS self-time during this arm (${total} samples) ──`);
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
    console.log(`   ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
  }
  return out;
}

// ── THE PICTURE. A change to WHEN something draws is not settled by a frame
// time: the snap floor buys its speed by letting the shadow map's covered box
// sit up to snap/2 off the camera, and the only way that goes wrong is
// VISIBLE — shadows clipping early at the edge of coverage. So park at a fixed
// pose and save the frame, once per arm.
const SHOT_POSE = { position: [-24.5, 7.2, 14.8], target: [-1.4, 4.1, -1.6] };
async function shot(name) {
  await page.evaluate(async (pose) => globalThis.__editorApi.call("viewport.setCamera", pose), SHOT_POSE);
  await wait(6000);
  // The op returns `{ __image: { base64 } }`, not a data URL.
  const base64 = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("viewport.screenshot", {});
    return r?.__image?.base64 ?? null;
  });
  if (!base64) { console.log(`   (no screenshot for ${name})`); return; }
  await writeFile(`${OUT}/${name}.png`, Buffer.from(base64, "base64"));
  console.log(`   wrote ${OUT}/${name}.png`);
}

const results = [];
const say = (r) => {
  console.log(`\n── ${r.label} — ${r.fps} fps  (p50 ${r.dtP50} / p95 ${r.dtP95} / max ${r.dtMax} ms; ${r.over33ms}/${r.frames} frames over 33 ms)`);
  console.log(`   draws ${r.draws}  tris ${r.tris}  heap ${r.heapStart}→${r.heapEnd} MB  cpuTotal ${r.capturedTotalMs} ms`);
  console.log(`   ${r.phases.map((p) => `${p.name} ${p.ms}`).join("  ")}`);
  if (r.subPhases.length) console.log(`   sub: ${r.subPhases.map((p) => `${p.name} ${p.ms}`).join("  ")}`);
  for (const p of r.passes ?? []) console.log(`   pass ${p.pass} — ${p.draws} draws, ${p.tris} tris, floorIfMerged ${p.floor}`);
  results.push(r);
};

// ── ARM 1+2: the complaint itself, both halves.
if (process.env.SHOT) await shot(process.env.SHOT);
say(await record("park", false));
say(await withProfile(() => record("drag", true)));

// ⚠ THE SHADOW ARMS ARE OFF BY DEFAULT AND THAT IS A MEASUREMENT DECISION, not
// tidiness. On the first run they pushed the JS heap 3.3 → 5.1 GB inside one
// boot (setProp on a light re-registers GI's dynamic objects: `gi.dynamicObjects`
// went 0.005 → 40.2 ms/frame and one frame took 7.4 s), so every arm after them
// was priced under major-GC pressure rather than under its own treatment. Run
// them with ARMS=shadow, read them as their own experiment, and never quote them
// beside park/drag from the same boot.
if (process.env.ARMS === "shadow") {
// ── ARM 3: pin the shadow camera inside one snap cell for the whole drag.
// `shadowCamSnap` is what decides how far the view camera may travel before the
// directional shadow camera recentres; raising it hugely means it never does,
// so ShadowFreeze's key stops changing and the map stays frozen through motion.
const pinned = await page.evaluate(() => {
  // `entity.components` is a Map(type -> component), so iterate its VALUES —
  // spreading the Map yields [key, value] pairs and silently finds nothing.
  const touched = [];
  for (const e of globalThis.__eng.entities.values()) {
    for (const lc of e.components.values()) {
      if (!lc?.props || !("shadowCamSnap" in lc.props)) continue;
      if (lc.props.kind !== "directional" || !lc.props.castShadow) continue;
      touched.push({ entity: e.name, was: lc.props.shadowCamSnap, mode: lc.props.shadowMode });
      lc.setProp("shadowCamSnap", 1e6);
    }
  }
  return touched;
});
console.log(`\npinned shadow snap on ${pinned.length} directional light(s): ${JSON.stringify(pinned)}`);
await wait(1500);
say(await record("drag+pinned", true));

// ── ARM 4: positive control — redraw the shadow map every single frame.
await page.evaluate((snaps) => {
  let i = 0;
  for (const e of globalThis.__eng.entities.values()) {
    for (const lc of e.components.values()) {
      if (!lc?.props || !("shadowCamSnap" in lc.props)) continue;
      if (lc.props.kind !== "directional" || !lc.props.castShadow) continue;
      lc.setProp("shadowCamSnap", snaps[i++]?.was ?? 0.5);
    }
  }
  globalThis.__eng.shadowFreeze.enabled = false;
}, pinned);
await wait(1500);
say(await record("drag+nofreeze", true));
say(await record("park+nofreeze", false));
}

await writeFile(`${OUT}/results.json`, JSON.stringify({ project: PROJECT, quality: QUALITY, results, giLines: giLines.slice(-40) }, null, 2));
console.log(`\nwrote ${OUT}/results.json`);
await browser.close();
