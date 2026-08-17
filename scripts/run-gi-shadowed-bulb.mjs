// PHASE E GATE — DOES A SMALL, POWERFUL, UNSEEN EMITTER DELIVER ANY LIGHT?
//
// Plan Part 1, E4's new gate ("the gate that would have caught R5-over-dead-
// delivery the day it shipped") and E0's discriminator in the same run.
//
// Four arms, ABBA-free because the statistic is a RATIO AGAINST A DARK ARM
// rather than an arm-to-arm energy comparison — the emitter-off room is black,
// so drift between rounds cannot manufacture a pass:
//
//   on-tree    bulb lit,  __giSrcLightTree = true,  __giEmitterTileCut = true
//   off-tree   bulb dark, same hatches                        (the noise floor)
//   on-field   bulb lit,  BOTH hatches false        (R5 zeroing disarmed)
//   off-field  bulb dark, both hatches false
//
// ⚠ BOTH HATCHES ARE SET EXPLICITLY ON EVERY ARM. They default ON since
// §12.70's flip, so `if (fieldArm) set false` leaves the "tree" arms reading
// whatever the build shipped, and W5b's coupling warning fires if the cut is
// armed alone. Every rig in this module has made this mistake once.
//
// VERDICTS
//   · tree arm lit and field arm lit    → delivery works on both paths.
//   · tree arm DARK and field arm lit   → E0 confirmed: R5 zeroes field
//                                         emission over a delivery path that
//                                         does not deliver. Phase E is a
//                                         delivery hunt.
//   · both dark                         → the bug is upstream of delivery
//                                         (go to E1: the intensity fold).
//
//   node scripts/run-gi-shadowed-bulb.mjs         (vite on :5201)
//   STRENGTH=2000 BULBS=1 SETTLE=25000 SAMPLES=24 QUALITY=high
//   BULBS=6   — past MAX_EMITTERS, so the measured bulb is UN-SEATED
//   MERGE=1   — auto-batching on, the E3/E6 arm
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeShadowedBulbProject, BULB_POSE } from "./lib/makeShadowedBulbProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const STRENGTH = Number(process.env.STRENGTH ?? 2000);
const BULBS = Number(process.env.BULBS ?? 1);
const SETTLE = Number(process.env.SETTLE ?? 25000);
const SAMPLES = Number(process.env.SAMPLES ?? 24);
const QUALITY = process.env.QUALITY ?? "high";
const MERGE = process.env.MERGE === "1";
// DECOYS=4 puts four brighter, nearer lamps in the room so they take every
// analytic seat and the measured bulb is delivered by the tree/tile-cut path
// ALONE. They are present in BOTH arms — see the rig's `decoyCount` note.
const DECOYS = Number(process.env.DECOYS ?? 0);
// Decoys must out-SCORE the measured bulb for a seat, not out-LIGHT it: the
// seat score is `L·r²/(1+d²_cam)`, and at r=0.15 against the bulb's 0.05 and a
// third of the camera distance the decoys carry a ~22x geometric advantage, so
// a tenth of the bulb's authored strength still wins every seat by 2.3x. At
// full strength they wash the crop to 0.93 mean and the measurement dies in the
// tone curve — the first run of this rig did exactly that.
const DECOY_STRENGTH = Number(process.env.DECOY_STRENGTH ?? 200);
// FILLERS=90 makes the light tree the size of the user's scene (95 emitters).
// The per-tile cut keeps FOUR, so emitter COUNT is the one structural variable
// that can sever an un-seated emitter's screen-direct term while a five-lamp
// rig stays healthy. Present in BOTH arms — see the rig's `fillerCount` note.
const FILLERS = Number(process.env.FILLERS ?? 0);
// Which arms to run. The default four are E0's full answer; a delivery hunt
// re-runs one pair at a time.
const ARMS = (process.env.ARMS ?? "on-tree,off-tree,on-field,off-field").split(",").map((s) => s.trim());
// EXTRA='{"__giSrcWorldKeys":true}' — dev globals set on EVERY arm before the
// page loads. Both arms get them, so the lit-minus-dark delta stays the
// statistic and the flag under test cannot be confounded with the emitter.
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : null;
const OUT = ".gi-shots/shadowed-bulb";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// One project root per (lit/dark) arm — see the rig's header for why the dark
// arm is a real project rather than a runtime toggle.
const roots = {};
for (const lit of [true, false]) {
  const root = path.resolve(`scripts/.gi-shadowed-bulb-${lit ? "on" : "off"}`).replaceAll("\\", "/");
  await makeShadowedBulbProject(root, {
    quality: QUALITY, emitStrength: lit ? STRENGTH : 0, bulbCount: BULBS, mergeable: MERGE,
    decoyCount: DECOYS, decoyStrength: DECOY_STRENGTH, fillerCount: FILLERS,
  });
  roots[lit ? "on" : "off"] = root;
}
console.log(
  `rig: enclosed 6x3x6 room, NO sun, NO environment; ${BULBS} bulb(s) r=0.05m ` +
  `strength ${STRENGTH}, hidden behind a shade, wall patch 0.5m away; quality ${QUALITY}` +
  (DECOYS ? `; ${DECOYS} DECOYS at strength ${DECOY_STRENGTH} holding every analytic seat (measured bulb is UN-SEATED)` : "") +
  (FILLERS ? `; ${FILLERS} FILLERS (tree ~${FILLERS + DECOYS + BULBS} emitters)` : "") +
  (MERGE ? "; AUTO-BATCHING ON (E3/E6 arm)" : ""),
);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const lit = arm.startsWith("on");
  const treeOn = arm.endsWith("tree");
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  const lines = { ledger: "", seats: "", sparse: "", src: "", nee: "", zeroed: "", scale: "" };
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/emitter ledger/.test(t)) lines.ledger = t;
    if (/emitter SCALE hint/.test(t)) lines.scale = t;
    if (/bright emitters; analytic slots/.test(t)) lines.seats = t;
    if (/emitters are SPARSE/.test(t)) lines.sparse = t;
    if (/\[gi\] src probes:/.test(t)) lines.src = t;
    if (/\[gi\] src \[J\] NEE/.test(t)) lines.nee = t;
    if (/R5-ZEROED/.test(t)) lines.zeroed = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, tree, extra) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // BOTH, EXPLICITLY, ON EVERY ARM — see the header.
    globalThis.__giSrcLightTree = tree;
    globalThis.__giEmitterTileCut = tree;
    if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
  }, roots[lit ? "on" : "off"], treeOn, EXTRA);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, roots[lit ? "on" : "off"]);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`${arm}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await page.evaluate(async (pose) => {
    await globalThis.__editorApi.call("viewport.setCamera", pose);
  }, BULB_POSE);
  await wait(SETTLE);

  // The statistic: mean luminance of the WALL CROP — the centre 44% of the
  // frame, which at this pose is back wall and the shade's silhouette and
  // nothing else. Read through a 2D canvas, never a WebGPU call (§12.65).
  const readFrame = () => page.evaluate(async () => {
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
        const x0 = Math.floor(c.width * 0.28), y0 = Math.floor(c.height * 0.28);
        const w = Math.floor(c.width * 0.44), h = Math.floor(c.height * 0.44);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let lum = 0;
        let peak = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          lum += l;
          if (l > peak) peak = l;
        }
        resolve({
          meanLum: lum / (d.length / 4) / 255,
          peakLum: peak / 255,
          giFrame: engine.modules?.get?.("gi")?.system?._frame ?? -1,
        });
      });
    });
  });

  const lums = [];
  let peak = 0;
  let f0 = -1, f1 = -1;
  for (let i = 0; i < SAMPLES; i++) {
    const s = await readFrame();
    lums.push(s.meanLum);
    if (s.peakLum > peak) peak = s.peakLum;
    if (i === 0) f0 = s.giFrame;
    f1 = s.giFrame;
    await wait(220);
  }
  await page.screenshot({ path: `${OUT}/${arm}.png` });
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const std = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  const live = await page.evaluate(() => globalThis.__giLightTreeLive ?? null);
  // WHICH meshes hold the four analytic seats. With decoys this is the one
  // reading that says the measured bulb is genuinely un-seated — "past
  // MAX_EMITTERS" is an argument, this is the observation.
  const seats = await page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    const sys = engine?.modules?.get?.("gi")?.system;
    return (sys?._promotedEmitterMeshes ?? []).map((m) => m?.name ?? m?.parent?.name ?? null);
  }).catch(() => []);
  await page.close();
  return { arm, lit, treeOn, mean, std, peak, ticking: f1 > f0 + 20, lines, seats, emitterCount: live?.emitterCount ?? -1 };
}

const results = [];
for (const arm of ARMS) {
  console.log(`── arm ${arm}`);
  const r = await runArm(arm);
  results.push(r);
  console.log(`  mean ${r.mean.toFixed(5)}  peak ${r.peak.toFixed(4)}  std ${r.std.toFixed(6)}  ticking=${r.ticking}  treeEmitters=${r.emitterCount}`);
  console.log(`  seats: [${(r.seats ?? []).join(", ")}]`);
  if (r.lines.ledger) console.log(`  ${r.lines.ledger.slice(0, 220)}`);
  if (r.lines.scale) console.log(`  ${r.lines.scale}`);
  if (r.lines.seats) console.log(`  ${r.lines.seats.slice(0, 180)}`);
}

const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
// Signal = lit mean minus dark mean, in units of the dark arm's frame-to-frame
// std. A delivered pool is orders of magnitude over it; a severed path is zero
// by construction, not "small".
function verdict(onName, offName) {
  const on = byArm[onName], off = byArm[offName];
  if (!on || !off) return null;
  const noise = Math.max(off.std, 1e-6);
  return { on, off, delta: on.mean - off.mean, snr: (on.mean - off.mean) / noise, lit: on.mean - off.mean > Math.max(20 * noise, 0.002) };
}
const tree = verdict("on-tree", "off-tree");
const field = verdict("on-field", "off-field");

console.log(`\n== SHADOWED BULB (${BULBS} bulb(s), strength ${STRENGTH}, r=0.05m, hidden) ==`);
for (const [name, v] of [["tree/tile-cut armed (DEFAULT)", tree], ["field emission (both hatches off)", field]]) {
  if (!v) continue;
  console.log(
    `  ${name.padEnd(36)} lit ${v.on.mean.toFixed(5)}  dark ${v.off.mean.toFixed(5)}  ` +
    `delta ${v.delta.toExponential(2)}  snr ${v.snr.toFixed(1)}  → ${v.lit ? "DELIVERS" : "DELIVERS NOTHING"}`,
  );
}
if (tree && field) {
  console.log(
    `\n  E0 VERDICT: ` +
    (tree.lit && field.lit ? "both paths deliver — the emitter reaches the wall either way."
      : !tree.lit && field.lit ? "SEVERED — field emission lights the wall, the armed tree/tile-cut path does NOT. "
        + "R5 zeroes 95 emitters over a delivery path that delivers nothing. Phase E is a delivery hunt (E2)."
      : !tree.lit && !field.lit ? "BOTH DARK — the bug is upstream of delivery; go to E1 (the intensity fold) first."
      : "tree delivers, field does not — inverted from the report; re-read the rig before trusting it."),
  );
}
writeFileSync(`${OUT}/result.json`, JSON.stringify({ results, strength: STRENGTH, bulbs: BULBS, quality: QUALITY }, null, 2));

const ticking = results.every((r) => r.ticking);
const pass = ticking && !!tree?.lit && !!field?.lit;
console.log(`\nPHASE E GATE: ${pass ? "PASS" : "FAIL"} — ${ticking ? "loops ticking" : "A LOOP STALLED"}` +
  `${tree ? `, tree path ${tree.lit ? "delivers" : "DEAD"}` : ""}${field ? `, field path ${field.lit ? "delivers" : "DEAD"}` : ""}`);
await browser.close();
process.exit(pass ? 0 : 1);
