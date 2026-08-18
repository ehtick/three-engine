// WHY DOES WALKING COST FRAME TIME? — play mode, per-frame, one boot, N arms.
//
// The complaint: "120 fps in play mode, 90 the moment we move the character."
// Parked, the editor reports a frame that is doing almost nothing — 1.4 ms CPU,
// 0.34 ms GPU, 26 draws — so whatever walking costs is several times the entire
// resting frame, which makes it worth naming rather than guessing at.
//
// This is `run-gi-camera-motion.mjs` pointed at a different input. The camera
// probe drives a real mouse DRAG in edit mode; this one enters PLAY and holds
// the movement key, because the two are not the same experiment: walking moves
// the camera's POSITION without touching its rotation, and it also runs a
// kinematic character through Rapier every fixed step. Either half could own
// the cost, and a mouse drag exercises neither.
//
// Same two methodological rules as the camera probe, for the same reasons:
//
//  - Report a DISTRIBUTION (p50/p95/max) of per-frame wall time, not a mean.
//    The complaint is about the frames that miss, and a mean over 200 frames
//    hides them.
//  - Record on rAF rather than on a render callback, so a frame the engine
//    skipped or a GC pause landing between ticks still counts. Recording only
//    presented frames reports exactly the frames that were cheap enough.
//
// ══ THE ARMS ═══════════════════════════════════════════════════════════════
//
//   park          play mode, no input at all
//   walk          play mode, the Move key held for the whole window
//   walk+frozen   walk with the directional light's shadow camera snapped so
//                 far that ShadowFreeze can never disengage. If walking costs
//                 collapse here, the cost IS the shadow map redrawing because
//                 the camera translated (see memory: camera-motion-perf, where
//                 exactly that was the whole of a 23 → 33 fps edit-mode fix).
//   walk+noshadow walk with castShadow off outright — the positive control that
//                 prices one shadow redraw per frame directly, so `walk` can be
//                 located BETWEEN two bounds instead of merely differing from
//                 one.
//
//   node scripts/run-character-motion-perf.mjs           (vite on :5201)
//   ARMS=park,walk FRAMES=240 node scripts/run-character-motion-perf.mjs
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME";
const FRAMES = Number(process.env.FRAMES ?? 240);
const SETTLE = Number(process.env.SETTLE ?? 9000);
const ARMS = (process.env.ARMS ?? "park,walk,walk+frozen,walk+noshadow").split(",");
const MOVE_KEY = process.env.MOVE_KEY ?? "KeyW";
const TURN_DEG_PER_SEC = Number(process.env.TURN ?? 90);
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
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);

console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
// This scene has no GI, so there is no `[gi] built` line to wait on — wait for
// the scene itself to carry entities instead.
await page.waitForFunction(
  async () => ((await globalThis.__editorApi.call("scene.get"))?.entityCount ?? 0) > 0,
  { timeout: 60000 },
);

await page.evaluate(async () => {
  const scene = await globalThis.__editorApi.call("scene.get");
  globalThis.__eng = globalThis.__editorApi.entities.live(scene.rootIds?.[0])?.engine;
  if (!globalThis.__eng) throw new Error("no engine handle");
  globalThis.__player = () => {
    for (const e of globalThis.__eng.entities.values()) {
      if (e.components?.get?.("charactercontroller")) return e;
    }
    return null;
  };
  globalThis.__dirLights = () => {
    const out = [];
    for (const e of globalThis.__eng.entities.values()) {
      // `entity.components` is a Map(type -> component): iterate its VALUES.
      for (const c of e.components.values()) {
        if (c?.props && "shadowCamSnap" in c.props && c.props.kind === "directional") out.push(c);
      }
    }
    return out;
  };
});

const scene = await page.evaluate(() => globalThis.__editorApi.call("scene.get"));
console.log(`scene "${scene.name}" — ${scene.entityCount} entities`);
console.log(`settling ${SETTLE} ms (material compile wave)`);
await wait(SETTLE);

// ── the per-frame recorder, on rAF. See the header.
await page.evaluate(() => {
  globalThis.__mo = { on: false, dt: [], draws: [], tris: [] };
  let prev = performance.now();
  const loop = () => {
    const now = performance.now();
    const m = globalThis.__mo;
    if (m.on) {
      m.dt.push(now - prev);
      const r = globalThis.__eng?.stats?.readout;
      if (r) { m.draws.push(r.drawCalls ?? 0); m.tris.push(r.triangles ?? 0); }
    }
    prev = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

// ── the yaw driver. The camera script OWNS `yaw` and the mouse only ever adds
// to it, so writing it here is the same input by a steadier hand. It also beats
// a synthetic pointer: CDP mouse moves arrive without `movementX`, MouseDevice
// falls back to an NDC difference, and 240 of them turned the camera 2.9° — an
// arm that reads as `park` while looking like it drove something.
await page.evaluate(() => {
  globalThis.__spinRate = 0;
  let prev = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = (now - prev) / 1000;
    prev = now;
    if (globalThis.__spinRate) {
      const cam = globalThis.__player()?.getScript?.("CharacterCamera");
      if (cam) cam.yaw += ((globalThis.__spinRate * Math.PI) / 180) * dt;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

// ── the mouse flood. Under pointer lock Chromium delivers raw mouse moves
// rather than one coalesced move per frame, so a 1000 Hz mouse puts ~8 events
// in every 120 fps frame — and MouseDevice calls getBoundingClientRect() in the
// handler, which is a forced synchronous layout of the whole editor DOM. That
// is the one input path neither `walk` nor the yaw driver exercises, and it is
// the only one that scales with how fast the user is moving the mouse.
//
// Dispatching the events from inside the page rather than through CDP is
// deliberate: the browser coalesces real pointermoves before they reach JS, so
// a CDP flood would price the coalescer, not the handler.
await page.evaluate(() => {
  globalThis.__mouseRate = 0;
  const canvas = globalThis.__eng.renderer.domElement;
  let n = 0;
  const loop = () => {
    for (let i = 0; i < globalThis.__mouseRate; i++) {
      n++;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: r.left + r.width / 2 + Math.sin(n * 0.3) * 30,
        clientY: r.top + r.height / 2 + Math.cos(n * 0.3) * 30,
      }));
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

// The control for the flood: freeze the canvas rect so the handler's
// getBoundingClientRect() stops forcing layout. Everything else about the
// event path is unchanged, so a difference between the two arms is that call
// and nothing else.
await page.evaluate(() => {
  globalThis.__cacheRect = (on) => {
    const canvas = globalThis.__eng.renderer.domElement;
    if (!on) {
      delete canvas.getBoundingClientRect;
      return;
    }
    const r = Object.getPrototypeOf(canvas).getBoundingClientRect.call(canvas);
    const frozen = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, x: r.x, y: r.y };
    canvas.getBoundingClientRect = () => frozen;
  };
});

const canvasRect = await page.evaluate(() => {
  const r = globalThis.__eng.renderer.domElement.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

/**
 * Runs one arm and returns its distribution, phase capture and pass breakdown.
 *
 * `walking` holds the movement key for the whole window. The key goes to
 * `window` (KeyboardDevice binds there), so no click is needed — and no click
 * is WANTED: clicking the canvas in play mode asks for pointer lock, which
 * headless Chrome answers differently than the editor does and which would put
 * mouse-look into an arm that is meant to isolate translation.
 */
async function record(label, walking, looking, mousePerFrame = 0) {
  await page.evaluate(() => {
    const m = globalThis.__mo;
    m.dt = []; m.draws = []; m.tris = []; m.on = true;
    globalThis.__eng.stats.beginPhaseCapture(1e9);
    const p = globalThis.__player();
    globalThis.__from = p ? p.object3D.position.toArray().map((v) => +v.toFixed(2)) : null;
    globalThis.__yawFrom = p?.getScript?.("CharacterCamera")?.yaw ?? null;
  });
  // Walk in a CIRCLE, not a straight line. The first version held W down the
  // corridor, hit a wall after 2.5 m and spent the rest of its window pressed
  // against it — a "walking" arm in which the camera did not move at all. At
  // 4.5 m/s and 90 deg/s the character loops in a ~2.9 m circle, so the camera
  // translates and rotates for every frame of the window and stays inside the
  // level it is meant to be looking at.
  if (looking) await page.evaluate((deg) => (globalThis.__spinRate = deg), TURN_DEG_PER_SEC);
  if (mousePerFrame) await page.evaluate((n) => (globalThis.__mouseRate = n), mousePerFrame);
  if (walking) await page.keyboard.down(MOVE_KEY);
  await wait(FRAMES * 16);
  if (walking) await page.keyboard.up(MOVE_KEY);
  if (looking) await page.evaluate(() => (globalThis.__spinRate = 0));
  if (mousePerFrame) await page.evaluate(() => (globalThis.__mouseRate = 0));

  const passes = await page.evaluate(async () => {
    try {
      const r = await globalThis.__editorApi.call("profile.drawCalls", { frames: 1 });
      return (r.passes ?? []).map((p) => ({ pass: p.pass, draws: p.draws, tris: p.triangles }));
    } catch (e) { return [{ pass: `ERR ${String(e?.message ?? e).slice(0, 80)}` }]; }
  });

  const out = await page.evaluate((label) => {
    const m = globalThis.__mo;
    m.on = false;
    const cap = globalThis.__eng.stats.readPhaseCapture();
    const dt = [...m.dt].sort((a, b) => a - b);
    const pct = (p) => +(dt[Math.min(dt.length - 1, Math.floor(p * dt.length))] ?? 0).toFixed(2);
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const p = globalThis.__player();
    const to = p ? p.object3D.position.toArray().map((v) => +v.toFixed(2)) : null;
    const from = globalThis.__from;
    const yawTo = p?.getScript?.("CharacterCamera")?.yaw ?? null;
    return {
      label,
      frames: dt.length,
      fps: +(1000 / Math.max(1e-6, mean(m.dt))).toFixed(1),
      dtP50: pct(0.5), dtP95: pct(0.95), dtMax: +(dt[dt.length - 1] ?? 0).toFixed(2),
      draws: Math.round(mean(m.draws)), tris: Math.round(mean(m.tris)),
      // Proof the arm did what it says. A "walk" that never moved is the
      // failure mode this whole harness is most likely to have.
      moved: from && to ? +Math.hypot(to[0] - from[0], to[2] - from[2]).toFixed(2) : null,
      // Same proof for the look half: a `look` arm whose synthetic pointer
      // never produced a `movementX` would report 0 and quietly measure `park`.
      turnedDeg: yawTo != null && globalThis.__yawFrom != null
        ? +(((yawTo - globalThis.__yawFrom) * 180) / Math.PI).toFixed(1) : null,
      from, to,
      phases: cap.phases.filter((ph) => ph.ms >= 0.02),
      subPhases: cap.subPhases.filter((ph) => ph.ms >= 0.02).slice(0, 10),
      capturedFrames: cap.frames,
      capturedTotalMs: +cap.totalMs.toFixed(3),
    };
  }, label);
  out.passes = passes;
  return out;
}

/** Puts the character back where it started, so every arm walks the same floor. */
async function respawn(home) {
  await page.evaluate((home) => {
    const p = globalThis.__player();
    p?.components.get("charactercontroller")?.teleport(home);
  }, home);
  await wait(300);
}

await page.evaluate(() => globalThis.__editorApi.call("play.set", { playing: true }));
await wait(2500); // scripts' onStart, the physics world build, the first steps
const home = await page.evaluate(() => {
  const p = globalThis.__player();
  return p ? p.object3D.position.toArray() : [0, 0, 0];
});
console.log(`play mode — player at ${home.map((v) => +v.toFixed(2)).join(", ")}\n`);

// ── PROFILE=<arm substring>: sample the JS stack during that arm and let the
// profiler name the function. The phase capture only marks work inside
// Engine.#tick, so anything the EDITOR does between frames — React re-rendering
// an Inspector bound to a transform that changes 120 times a second, an outline
// pass, a gizmo — is invisible to it and shows up only as wall clock the engine
// cannot account for. That is exactly the gap the selected arm sits in.
const profiler = process.env.PROFILE ? await page.target().createCDPSession() : null;
if (profiler) {
  await profiler.send("Profiler.enable");
  await profiler.send("Profiler.setSamplingInterval", { interval: 100 });
}
function topSelfTime(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  // `parent` isn't in the raw node list (only children are) — build it from
  // the children arrays so a sample's stack can be walked upward.
  const parentOf = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const nameOf = (f) => `${f.functionName || "(anonymous)"} ${(f.url || "").split("/").slice(-1)[0]}:${f.lineNumber + 1}`;

  const self = new Map();
  const roots = new Map(); // the outermost non-(program)/(idle) frame per sample
  const total = profile.samples.length || 1;
  for (const id of profile.samples) {
    const node = byId.get(id);
    if (!node) continue;
    self.set(nameOf(node.callFrame), (self.get(nameOf(node.callFrame)) ?? 0) + 1);

    // Walk to the top of this sample's stack, skipping the two synthetic
    // frames V8 inserts for "compiling/GC" and "nothing running" — neither
    // says who scheduled the work.
    let cur = id;
    let top = null;
    for (let hops = 0; hops < 200; hops++) {
      const n = byId.get(cur);
      if (!n) break;
      const name = n.callFrame.functionName;
      if (name && name !== "(root)" && name !== "(program)" && name !== "(idle)") top = nameOf(n.callFrame);
      const parent = parentOf.get(cur);
      if (parent === undefined) break;
      cur = parent;
    }
    if (top) roots.set(top, (roots.get(top) ?? 0) + 1);
  }
  const fmt = (m) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([k, v]) => `    ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
      .join("\n");
  return `  self time:\n${fmt(self)}\n  stack ROOTS (who ultimately scheduled the work):\n${fmt(roots)}`;
}

const results = [];
for (const arm of ARMS) {
  if (arm.includes("frozen")) {
    // shadowCamSnap far beyond the walk distance: the shadow camera can never
    // leave its snap cell, so ShadowFreeze stays engaged for the whole arm.
    await page.evaluate(() => {
      globalThis.__snapWas = globalThis.__dirLights().map((l) => l.props.shadowCamSnap);
      for (const l of globalThis.__dirLights()) l.setProp("shadowCamSnap", 1000);
    });
    await wait(1500);
  }
  if (arm.includes("noshadow")) {
    await page.evaluate(() => {
      for (const l of globalThis.__dirLights()) l.setProp("castShadow", false);
    });
    // A long re-settle: dropping the shadow chain retires pipelines, and
    // pricing an arm during a compile wave measures the wave.
    await wait(3000);
  }
  // Selecting the moving entity is the one thing the harness does NOT do by
  // default and the user's editor always does: an Inspector bound to a
  // transform that changes every frame, plus the selection outline and the
  // gizmo, are editor work that a shipped build never pays.
  await page.evaluate(async (selected) => {
    const p = globalThis.__player();
    await globalThis.__editorApi.call("selection.set", { ids: selected && p ? [p.id] : [] });
  }, arm.includes("selected"));
  await respawn(home);
  await page.evaluate((on) => globalThis.__cacheRect(on), arm.includes("cachedrect"));
  const mouse = /mouse(\d+)/.exec(arm);
  const profiling = !!profiler && arm.includes(process.env.PROFILE);
  if (profiling) await profiler.send("Profiler.start");
  const out = await record(
    arm,
    arm.startsWith("walk"),
    arm.includes("look") || arm.includes("turn"),
    mouse ? Number(mouse[1]) : 0,
  );
  if (profiling) out.profile = topSelfTime((await profiler.send("Profiler.stop")).profile);
  results.push(out);
  console.log(
    `${out.label.padEnd(14)} ${String(out.fps).padStart(6)} fps   ` +
    `p50 ${String(out.dtP50).padStart(6)}  p95 ${String(out.dtP95).padStart(6)}  max ${String(out.dtMax).padStart(7)} ms   ` +
    `${String(out.draws).padStart(4)} draws  moved ${out.moved} m  turned ${out.turnedDeg}°`,
  );
  console.log(`  cpu ${out.capturedTotalMs} ms over ${out.capturedFrames} frames`);
  for (const ph of out.phases) console.log(`    ${ph.name.padEnd(18)} ${String(ph.ms).padStart(7)} ms  ${ph.pct}%`);
  if (out.subPhases.length) {
    console.log(`  sub-phases:`);
    for (const ph of out.subPhases) console.log(`    ${ph.name.padEnd(28)} ${String(ph.ms).padStart(7)} ms`);
  }
  console.log(`  passes: ${out.passes.map((p) => `${p.pass} ${p.draws}/${p.tris}`).join("  |  ")}\n`);
  if (out.profile) console.log(`  top self time:
${out.profile}
`);
}

await page.evaluate(() => globalThis.__editorApi.call("play.set", { playing: false }));

const park = results.find((r) => r.label === "park");
if (park) {
  console.log("── ratios against park ─────────────────────────────────────────");
  for (const r of results) {
    if (r === park) continue;
    console.log(
      `${r.label.padEnd(14)} p50 ×${(r.dtP50 / Math.max(1e-6, park.dtP50)).toFixed(2)}   ` +
      `cpu ×${(r.capturedTotalMs / Math.max(1e-6, park.capturedTotalMs)).toFixed(2)}   ` +
      `${park.fps} → ${r.fps} fps`,
    );
  }
}
if (errors.length) console.log(`\n${errors.length} console error(s), first: ${errors[0]}`);
await browser.close();
