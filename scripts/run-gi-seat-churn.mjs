// S2 GATE — DOES SEAT RE-RANKING STILL TOUCH THE IMAGE WHEN THE CAMERA MOVES?
//
// Plan Part 2, S2: "retire the camera-ranked 4-seat promotion
// (`#chooseEmitterSeats` churn = the flicker) — seats become at most a cache,
// never the delivery path, and seat re-ranking stops touching the image."
//
// ══ THE MECHANISM UNDER TEST ═══════════════════════════════════════════════
//
// There are MAX_EMITTERS = 4 analytic emitter slots. Their occupants were ranked
// by APPARENT brightness (power / distance² to the camera), and `#checkFingerprint`
// re-asked that question on every scan because a camera move never touches the
// mesh fingerprint. Every flip rode the sanctioned path — slot re-surface → atlas
// revision → composite → `moved = 1` — and `moved = 1` CUTS THE EMA HISTORY where
// that light lands. Walk past a row of lamps and seats turn over continuously.
//
// ══ WHY BOTH ARMS MUST HAVE FULL DELIVERY ══════════════════════════════════
//
// The obvious A/B is "tile cut off vs on", and it is WRONG: the tile cut is what
// delivers the un-seated lamps, so turning it off changes the image's energy at
// the same time as the seat policy. A flicker delta would then be confounded with
// a brightness delta and neither number would mean anything.
//
// So `__giEmitterSeatsFollowCamera` exists purely for this rig. Both arms run the
// full delivery path; they differ in the seat policy and nothing else.
//
//   follow   seats ranked power/d² to the camera, re-ranked every scan (shipped)
//   anchored seats ranked by raw power — scene-anchored (S2)
//
// ══ THE STATISTICS ═════════════════════════════════════════════════════════
//
//   seatFlips  — how many times the occupant of any slot changed during the
//                orbit. This is the mechanism itself, counted directly, and it is
//                the number S2 claims to drive to zero.
//   jitter     — mean |Δlum| between two samples taken AT THE SAME POSE. This is
//                the user-visible consequence, and getting it right took two
//                attempts: the first version measured |Δlum| between consecutive
//                ORBIT STEPS and reported ratio 1.00, which reads as "S2 buys
//                nothing" and was actually the statistic failing. Moving the
//                camera changes what is inside the crop, and that content change
//                is ~60x any temporal effect. Holding the pose removes it, so the
//                only thing left that can move the luminance is GI's own temporal
//                state — which is what a seat flip disturbs.
//   moveDelta  — the confounded moving number, kept for the record, NEVER gated on.
//   energy     — mean luminance, to prove the two arms are the same picture. A
//                jitter win bought by dimming the scene is not a win.
//
//   node scripts/run-gi-seat-churn.mjs           (vite on :5201)
//   LAMPS=12 STEPS=48 SETTLE=20000 QUALITY=high
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-seat-churn").replaceAll("\\", "/");
const ARMS = (process.env.ARMS ?? "follow,anchored").split(",").map((s) => s.trim());
// Past MAX_EMITTERS on purpose — with 4 lamps every lamp holds a seat and the
// ranking cannot churn, so a 4-lamp rig would report zero flips on BOTH arms and
// look like a pass with the mechanism untested.
const LAMPS = Number(process.env.LAMPS ?? 12);
const STEPS = Number(process.env.STEPS ?? 48);
const SETTLE = Number(process.env.SETTLE ?? 20000);
const QUALITY = process.env.QUALITY ?? "high";
const OUT = ".gi-shots/seat-churn";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: "static", emitStrength: 8, enclosed: true, lampCount: LAMPS,
  gi: { quality: QUALITY },
});
console.log(`rig: enclosed storm room, ${LAMPS} static lamps on a ring (MAX_EMITTERS is 4), quality ${QUALITY}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const follow = arm === "follow";
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let seatLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/analytic slots/.test(t) && !seatLine) seatLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, followCam) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // FULL DELIVERY ON BOTH ARMS, EXPLICITLY — see the header for why the
    // tile-cut-off arm would be a confounded comparison rather than a control.
    globalThis.__giSrcLightTree = true;
    globalThis.__giEmitterTileCut = true;
    globalThis.__giEmitterSeatsFollowCamera = followCam;
  }, GEN_ROOT, follow);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, GEN_ROOT);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`${arm}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });

  // Seat occupants by mesh id — the identity that matters, since slots are
  // POSITIONAL and a permutation of the same four lamps is still a re-surface.
  const readSeats = () => page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    const sys = engine?.modules?.get?.("gi")?.system;
    return (sys?._promotedEmitterMeshes ?? []).map((m) => m?.id ?? -1);
  }).catch(() => []);

  const readLum = () => page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    return await new Promise((resolve) => {
      let n = 0;
      const off = engine.onPostRender(() => {
        if (++n < 2) return;
        off();
        const src = engine.renderer.domElement;
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(src, 0, 0);
        const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
        const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        resolve(s / (d.length / 4) / 255);
      });
    });
  });

  // Settle at the start of the orbit before judging anything (§12.66).
  const pose = (t) => {
    const a = t * Math.PI * 2;
    const r = 4.6;
    return { position: [Math.cos(a) * r, 1.8, Math.sin(a) * r], target: [0, 1.0, 0] };
  };
  await page.evaluate(async (p) => {
    await globalThis.__editorApi.call("viewport.setCamera", p);
  }, pose(0));
  await wait(SETTLE);

  // ORBIT. One full lap past every lamp — the interaction the flicker was
  // reported on ("light flickers on movement").
  let seatFlips = 0;
  let prevSeats = (await readSeats()).join(",");
  const lums = [];
  // ── SAME-POSE JITTER: THE ONLY UNCONFOUNDED FLICKER STATISTIC HERE ───────
  //
  // The first version of this rig measured |Δlum| between CONSECUTIVE ORBIT
  // STEPS and reported ratio 1.00 between the arms — which reads as "S2 buys no
  // flicker win" and is actually the statistic failing. Moving the camera changes
  // what is inside the crop, and that content change is an order of magnitude
  // larger than any temporal effect, so the number was measuring the orbit.
  //
  // So each step now HOLDS THE POSE and samples twice. With the view fixed, the
  // only thing that can move the luminance is GI's own temporal state — which is
  // exactly what a seat flip disturbs when it cuts the EMA history where that
  // light lands. `jitter` is the mean of those same-pose deltas; `moveDelta` is
  // kept but labelled as what it is.
  const jitters = [];
  const seatTrail = [prevSeats];
  for (let i = 1; i <= STEPS; i++) {
    await page.evaluate(async (p) => {
      await globalThis.__editorApi.call("viewport.setCamera", p);
    }, pose(i / STEPS));
    const a = await readLum();
    lums.push(a);
    const seats = (await readSeats()).join(",");
    if (seats !== prevSeats) { seatFlips++; seatTrail.push(seats); }
    prevSeats = seats;
    // Hold still, then re-read the SAME view.
    await wait(260);
    const b = await readLum();
    jitters.push(Math.abs(b - a));
  }
  await page.screenshot({ path: `${OUT}/${arm}.png` });
  await page.close();

  // Frame-to-frame instability WHILE MOVING — a cut history shows up as a step.
  let dsum = 0;
  for (let i = 1; i < lums.length; i++) dsum += Math.abs(lums[i] - lums[i - 1]);
  const energy = lums.reduce((a, b) => a + b, 0) / lums.length;
  const jitter = jitters.length ? jitters.reduce((a, b) => a + b, 0) / jitters.length : 0;
  return {
    arm, seatFlips, seatTrail: seatTrail.slice(0, 8),
    // CONFOUNDED BY THE ORBIT — reported for the record, never gated on.
    moveDelta: lums.length > 1 ? dsum / (lums.length - 1) : 0,
    jitter,
    jitterMax: jitters.length ? Math.max(...jitters) : 0,
    energy,
    seatLine,
  };
}

const results = [];
for (const arm of ARMS) {
  console.log(`\n── arm ${arm}`);
  const r = await runArm(arm);
  results.push(r);
  console.log(`  seat flips over the lap: ${r.seatFlips}/${STEPS}`);
  console.log(`  same-pose jitter (mean |Δlum| holding still): ${r.jitter.toExponential(3)}  max ${r.jitterMax.toExponential(3)}`);
  console.log(`  moving |Δlum| per step (CONFOUNDED by the orbit's own content change): ${r.moveDelta.toExponential(3)}`);
  console.log(`  energy (mean lum): ${r.energy.toFixed(5)}`);
  if (r.seatLine) console.log(`  ${r.seatLine.slice(0, 190)}`);
  if (r.seatFlips) console.log(`  seat trail: ${r.seatTrail.join("  ->  ")}`);
}

writeFileSync(`${OUT}/result.json`, JSON.stringify({ results, lamps: LAMPS, steps: STEPS, quality: QUALITY }, null, 2));

const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
const follow = byArm.follow, anchored = byArm.anchored;
console.log(`\n== S2 SEAT CHURN (${LAMPS} lamps, ${STEPS}-step orbit, full delivery on both arms) ==`);
let pass = true;
const say = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};
if (follow && anchored) {
  say("scene-anchored seats never flip on a camera orbit", anchored.seatFlips === 0,
    `follow ${follow.seatFlips} flips → anchored ${anchored.seatFlips}`);
  say("the churning arm actually churns (the mechanism is under test)", follow.seatFlips > 0,
    follow.seatFlips > 0 ? `${follow.seatFlips} flips` : "ZERO flips on the follow arm — the rig proved nothing");
  const er = anchored.energy / Math.max(follow.energy, 1e-9);
  say("same picture — energy within 5%", Math.abs(er - 1) <= 0.05,
    `follow ${follow.energy.toFixed(5)} vs anchored ${anchored.energy.toFixed(5)} (ratio ${er.toFixed(3)})`);
  const jr = anchored.jitter / Math.max(follow.jitter, 1e-12);
  console.log(`  same-pose jitter  follow ${follow.jitter.toExponential(3)} → anchored ${anchored.jitter.toExponential(3)}  (ratio ${jr.toFixed(2)})`);
  console.log(`  worst same-pose   follow ${follow.jitterMax.toExponential(3)} → anchored ${anchored.jitterMax.toExponential(3)}`);
  console.log(`  moving |Δlum|     follow ${follow.moveDelta.toExponential(3)} → anchored ${anchored.moveDelta.toExponential(3)}  (confounded — not a verdict)`);
  // Soft: the mechanism claim is the seat count above. This says whether removing
  // it is VISIBLE, and a null result here is a real finding about how much of the
  // reported flicker seats actually owned.
  say("scene-anchored seats do not make same-pose jitter worse", jr <= 1.3,
    `ratio ${jr.toFixed(2)}`);
}
console.log(`\nS2 GATE: ${pass ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(pass ? 0 : 1);
