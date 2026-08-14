// LIGHT TREE §12.62 W3 GATE — the [J] NEE swap, priced on a live scene.
//
// Two arms, SAME rig, ABBA-interleaved in one invocation (the §12-standing
// same-machine-minutes-apart discipline): the shipped slot NEE vs
// `__giSrcLightTree = true` (the tree descent + record evaluation replacing
// the 4-slot pick in [J]).
//
// The rig is the enclosed emissive-storm room with 4 STATIC lamps — exactly
// MAX_EMITTERS, so the tree's emitter set and the promoted set COINCIDE and
// the two estimators integrate the same lights: this is the parity arm, where
// §12.26.7's discipline applies (an energy claim wants an energy statistic —
// the mean over a region, not a sample of it). Lamps are static so the tree's
// build-pose records are the truth for the whole run.
//
// What each arm measures, after settle, at the §12.66 rule's KNOWN pose:
//   · energy  — mean luminance of the center crop, averaged over N frames
//   · noise   — the per-frame std of that mean (the canvas-level stand-in for
//               the still floor; §12.26.5 prices a bounds-based pdf at up to
//               3.00× the exact ranking's standard error — measured here,
//               not asserted, and the flicker rig stays the referee once the
//               hatch ever default-ons)
//
// Verdict: PASS iff every tree/slot pair agrees on energy within 5% and the
// tree arms actually compiled the tree path (the srcSystem boot line).
//
//   node scripts/run-gi-lighttree-nee.mjs        (vite on :5201)
//   ARMS=slot,tree SETTLE=20000 SAMPLES=30       (dials)
import path from "node:path";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-lighttree-nee").replaceAll("\\", "/");
const ARMS = (process.env.ARMS ?? "slot,tree,tree,slot").split(",").map((s) => s.trim());
const SETTLE = Number(process.env.SETTLE ?? 25000);
const SAMPLES = Number(process.env.SAMPLES ?? 36);
const OUT = ".gi-shots/lighttree-nee";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: "static", emitStrength: 8, enclosed: true, gi: { quality: "high" },
});
console.log(`rig at ${GEN_ROOT} — 4 static lamps, enclosed, quality high`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm, round) {
  const tree = arm === "tree";
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let treeLine = "";
  let neeLine = "";
  const errCounts = new Map();
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/\[gi\] light tree:/.test(t)) treeLine = t;
    if (/\[gi\] src \[J\] NEE/.test(t)) neeLine = t;
    if (m.type() === "error") {
      const key = t.slice(0, 140);
      errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
    }
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, treeOn) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (treeOn) globalThis.__giSrcLightTree = true;
  }, GEN_ROOT, tree);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, GEN_ROOT);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`${arm}#${round}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  // §12.66 RULE: set the pose before judging any frame. The emissive-cost
  // harness's own interior pose — lamps, crates and the floor pools in frame.
  await page.evaluate(async () => {
    await globalThis.__editorApi.call("viewport.setCamera", {
      position: [0, 1.9, 6.2], target: [0, 0.8, -2],
    });
  });
  await wait(SETTLE);

  // One sample = the center-crop mean luminance of a composited frame, read
  // through a 2D canvas — NO WebGPU calls (the only artifact-free frame
  // instrument this module has; §12.65's whole postmortem).
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
        const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
        const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let lum = 0;
        for (let i = 0; i < d.length; i += 4) lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        resolve({ meanLum: lum / (d.length / 4) / 255, giFrame: engine.modules?.get?.("gi")?.system?._frame ?? -1 });
      });
    });
  });

  const lums = [];
  let f0 = -1, f1 = -1;
  for (let i = 0; i < SAMPLES; i++) {
    const s = await readFrame();
    lums.push(s.meanLum);
    if (i === 0) f0 = s.giFrame;
    f1 = s.giFrame;
    await wait(250);
  }
  await page.screenshot({ path: `${OUT}/${arm}-r${round}.png` });
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const std = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  const live = await page.evaluate(() => globalThis.__giLightTreeLive ?? null);
  await page.close();
  const errs = [...errCounts.entries()].filter(([k]) => !/favicon|404/.test(k));
  return {
    arm, round, mean, std, ticking: f1 > f0 + 30,
    treeBuilt: !!treeLine, neeLine: neeLine.slice(0, 120),
    emitterCount: live?.emitterCount ?? -1,
    errs: errs.slice(0, 4).map(([k, n]) => `${n}× ${k}`),
  };
}

const results = [];
for (let i = 0; i < ARMS.length; i++) {
  console.log(`── arm ${i + 1}/${ARMS.length}: ${ARMS[i]}`);
  const r = await runArm(ARMS[i], i);
  results.push(r);
  console.log(`  ${r.arm}#${r.round}  mean ${r.mean.toFixed(4)}  std ${r.std.toFixed(5)}  ticking=${r.ticking}  emitters=${r.emitterCount}  ${r.neeLine || "(no [J] NEE line)"}`);
  if (r.errs.length) for (const e of r.errs) console.log(`    err ${e}`);
}

const slot = results.filter((r) => r.arm === "slot");
const treeArms = results.filter((r) => r.arm === "tree");
const avg = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
const mSlot = avg(slot, (r) => r.mean), mTree = avg(treeArms, (r) => r.mean);
const sSlot = avg(slot, (r) => r.std), sTree = avg(treeArms, (r) => r.std);
const ratio = mTree / mSlot;
const spreadSlot = Math.max(...slot.map((r) => r.mean)) - Math.min(...slot.map((r) => r.mean));
console.log(`\n== W3 NEE A/B (storm rig, 4 static lamps == MAX_EMITTERS — parity scene) ==`);
console.log(`  energy  slot ${mSlot.toFixed(4)}  tree ${mTree.toFixed(4)}  ratio ${ratio.toFixed(3)}  (slot round spread ${spreadSlot.toFixed(4)})`);
console.log(`  noise   slot ${sSlot.toFixed(5)}  tree ${sTree.toFixed(5)}  ratio ${(sTree / sSlot).toFixed(2)}  (§12.26.5 ceiling: 3.00× SE for a bounds-based pdf)`);
const armed = treeArms.every((r) => r.neeLine);
const ticking = results.every((r) => r.ticking);
const pass = armed && ticking && Math.abs(ratio - 1) <= 0.05;
console.log(`\nW3 GATE: ${pass ? "PASS" : "FAIL"} — ${armed ? "tree path compiled" : "TREE PATH NEVER ARMED"}, ${ticking ? "loops ticking" : "A LOOP STALLED"}, energy ${Math.abs(ratio - 1) <= 0.05 ? "within 5%" : `off by ${((ratio - 1) * 100).toFixed(1)}%`}`);
await browser.close();
process.exit(pass ? 0 : 1);
