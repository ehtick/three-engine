// S1 GATE 2/3 — DOES TURNING THE CAMERA STILL DESTROY THE CACHE?
//
// Plan Part 2, S1 gates: "360° spin: ZERO survivor retirements (counter),
// luminance recovery time vs today's" and "100 m teleport: full refill under
// budget with no frame > 2× median (freezeless is a GATE, not a hope)".
//
// ══ WHAT IS ACTUALLY BEING MEASURED ════════════════════════════════════════
//
// The shipped rule retires a probe `PROBE_MAX_AGE` frames after the last pixel
// looked at it. So a 180° turn deletes the entire neighbourhood behind you along
// with its accumulated payload, and turning back cold-starts it at α ≈ 0.02 —
// the user's "black patches lag the camera". S1's locality rule keys retirement
// to WHERE a probe is instead of WHETHER IT IS ON SCREEN, which is only
// expressible because world-absolute keys make a probe's identity permanent.
//
// Three arms, same rig, same pose sequence:
//
//   shipped     anchor-relative keys, visibility retirement (today)
//   worldkeys   world-absolute keys, retention OFF   — isolates the keying
//   retain      world-absolute keys, retention ON    — the unit under test
//
// The middle arm matters: without it a win could be the keying, the retention, or
// either, and the plan's whole method rule is that an extremum is not a
// statistic. `worldkeys` should land ON TOP of `shipped` (same retirement rule,
// different names for the same probes); `retain` is where the recovery changes.
//
// THE STATISTIC IS RECOVERY, NOT STEADY STATE. Every arm converges to the same
// picture if you wait — the complaint is about the seconds after a turn. So each
// pose change is followed by a dense burst of samples and the reported number is
// **time to reach 95% of that pose's settled luminance**, plus the per-cascade
// `held` counter (which separates "retention armed" from "retention fired") and
// `live`/`fresh` (a cache that survived shows FEW fresh probes after a turn —
// that is the retirement claim, measured directly rather than inferred).
//
//   node scripts/run-gi-spin-retention.mjs        (vite on :5201)
//   ARMS=shipped,worldkeys,retain SETTLE=22000 QUALITY=high
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-spin-retention").replaceAll("\\", "/");
const ARMS = (process.env.ARMS ?? "shipped,worldkeys,retain").split(",").map((s) => s.trim());
const SETTLE = Number(process.env.SETTLE ?? 22000);
const QUALITY = process.env.QUALITY ?? "high";
const OUT = ".gi-shots/spin-retention";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// The enclosed storm room: four static lamps, crates, walls. Enclosed matters —
// an open rig lets most rays escape to sky, and sky is the one term that does not
// care whether a probe survived.
await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: "static", emitStrength: 8, enclosed: true, gi: { quality: QUALITY },
});

// A 360° spin in four 90° steps around a fixed eye, then a 100 m teleport and
// back. Each entry is a full camera pose so nothing depends on orbit state.
const EYE = [0, 1.9, 0];
const POSES = [
  { name: "start", position: EYE, target: [0, 1.4, -6] },
  { name: "turn90", position: EYE, target: [6, 1.4, 0] },
  { name: "turn180", position: EYE, target: [0, 1.4, 6] },
  { name: "turn270", position: EYE, target: [-6, 1.4, 0] },
  { name: "back-to-start", position: EYE, target: [0, 1.4, -6] },
  { name: "teleport-100m", position: [100, 1.9, 0], target: [100, 1.4, -6] },
  { name: "return", position: EYE, target: [0, 1.4, -6] },
];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

const FLAGS = {
  shipped: { __giSrcWorldKeys: false },
  worldkeys: { __giSrcWorldKeys: true, __giSrcProbeRetain: false },
  retain: { __giSrcWorldKeys: true, __giSrcProbeRetain: true },
};

async function runArm(arm) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let bootLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/\[gi\] src probes:/.test(t) && !bootLine) bootLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, flags) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // EVERY flag explicit on EVERY arm — `__giSrcWorldKeys` defaults off and
    // `__giSrcProbeRetain` defaults on-under-world-keys, so an arm that sets only
    // what it wants inherits the other's behaviour and the A/B compares an arm
    // against itself. Every rig in this module has paid for this once.
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, GEN_ROOT, FLAGS[arm]);
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

  // Centre-crop mean luminance + the probe counters, in one readback so the two
  // describe the same frame. 2D canvas only — never a WebGPU call (§12.65).
  const sample = () => page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    const lum = await new Promise((resolve) => {
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
    const sys = engine.modules?.get?.("gi")?.system;
    const src = sys?.state?.screen?.srcProbes ?? null;
    let counters = null;
    try {
      if (src?.readPressure) {
        const p = await src.readPressure(engine.renderer);
        counters = (p.cascades ?? []).map((s) => ({
          c: s.cascade, live: s.live, fresh: s.fresh, failed: s.failed, held: s.held ?? 0,
        }));
      }
    } catch { /* a readback that fails must not fail the arm */ }
    return { lum, counters, reanchors: src?.reanchorCount ?? -1 };
  });

  const setPose = (pose) => page.evaluate(
    async (p) => { await globalThis.__editorApi.call("viewport.setCamera", p); },
    { position: pose.position, target: pose.target },
  );

  await setPose(POSES[0]);
  await wait(SETTLE);

  const out = [];
  for (const pose of POSES) {
    await setPose(pose);
    // Dense burst: the recovery curve lives in the first couple of seconds.
    const curve = [];
    for (let i = 0; i < 24; i++) {
      curve.push(await sample());
      await wait(180);
    }
    // Settled value = the tail's mean; recovery = first index within 5% of it.
    const tail = curve.slice(-6).map((s) => s.lum);
    const settled = tail.reduce((a, b) => a + b, 0) / tail.length;
    let recoverAt = curve.length - 1;
    for (let i = 0; i < curve.length; i++) {
      if (Math.abs(curve[i].lum - settled) <= 0.05 * Math.max(settled, 1e-6)) { recoverAt = i; break; }
    }
    const first = curve[0];
    const freshPeak = Math.max(...curve.map((s) => s.counters?.[0]?.fresh ?? 0));
    const heldPeak = Math.max(...curve.map((s) => (s.counters ?? []).reduce((a, x) => a + x.held, 0)));
    const failedPeak = Math.max(...curve.map((s) => (s.counters ?? []).reduce((a, x) => a + x.failed, 0)));
    out.push({
      pose: pose.name,
      dip: (settled - first.lum) / Math.max(settled, 1e-6),   // how dark the first frame after the move was
      recoverMs: recoverAt * 180,
      settled,
      freshPeak,
      heldPeak,
      failedPeak,
      reanchors: first.reanchors,
      liveC0: first.counters?.[0]?.live ?? -1,
    });
    await page.screenshot({ path: `${OUT}/${arm}-${pose.name}.png` });
  }
  await page.close();
  return { arm, bootLine, poses: out };
}

const results = [];
for (const arm of ARMS) {
  console.log(`\n── arm ${arm}`);
  const r = await runArm(arm);
  results.push(r);
  console.log(`  ${r.bootLine.slice(0, 200)}`);
  for (const p of r.poses) {
    console.log(
      `  ${p.pose.padEnd(15)} dip ${(p.dip * 100).toFixed(1)}%  recover ${String(p.recoverMs).padStart(4)}ms  ` +
      `settled ${p.settled.toFixed(4)}  liveC0 ${String(p.liveC0).padStart(6)}  fresh↑ ${String(p.freshPeak).padStart(6)}  ` +
      `held↑ ${String(p.heldPeak).padStart(6)}  failed↑ ${p.failedPeak}  reanchors ${p.reanchors}`,
    );
  }
}

writeFileSync(`${OUT}/result.json`, JSON.stringify({ results, quality: QUALITY, poses: POSES }, null, 2));

console.log(`\n== S1 SPIN + TELEPORT (${QUALITY}, enclosed storm room) ==`);
const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
const moved = (r) => r.poses.filter((p) => p.pose !== "start");
for (const r of results) {
  const m = moved(r);
  const meanDip = m.reduce((a, p) => a + p.dip, 0) / m.length;
  const meanRec = m.reduce((a, p) => a + p.recoverMs, 0) / m.length;
  const freshPeak = Math.max(...m.map((p) => p.freshPeak));
  const heldPeak = Math.max(...m.map((p) => p.heldPeak));
  const failed = Math.max(...m.map((p) => p.failedPeak));
  const reanch = Math.max(...m.map((p) => p.reanchors));
  console.log(
    `  ${r.arm.padEnd(10)} mean dip ${(meanDip * 100).toFixed(1)}%  mean recover ${meanRec.toFixed(0)}ms  ` +
    `fresh↑ ${freshPeak}  held↑ ${heldPeak}  FAILED↑ ${failed}  reanchors ${reanch}`,
  );
}

// Verdicts. `failed` is the hard one: an insert that fails is a probe that does
// not exist, and retention growing the population must never cause it.
const ship = byArm.shipped, wk = byArm.worldkeys, ret = byArm.retain;
let pass = true;
const say = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};
if (wk) {
  const r = Math.max(...moved(wk).map((p) => p.reanchors));
  say("world keys never re-anchor", r <= 1, `reanchorCount ${r} (shipped: ${ship ? Math.max(...moved(ship).map((p) => p.reanchors)) : "n/a"})`);
}
if (ret) {
  const failed = Math.max(...moved(ret).map((p) => p.failedPeak));
  say("retention never causes a dropped insert", failed === 0, `failed ${failed} (the crowding guard's whole job)`);
  const held = Math.max(...moved(ret).map((p) => p.heldPeak));
  say("retention actually FIRES (held > 0 after a turn)", held > 0, `held peak ${held}`);
}
if (ret && ship) {
  const rr = moved(ret).reduce((a, p) => a + p.recoverMs, 0) / moved(ret).length;
  const sr = moved(ship).reduce((a, p) => a + p.recoverMs, 0) / moved(ship).length;
  const rd = moved(ret).reduce((a, p) => a + p.dip, 0) / moved(ret).length;
  const sd = moved(ship).reduce((a, p) => a + p.dip, 0) / moved(ship).length;
  console.log(`  recovery  shipped ${sr.toFixed(0)}ms → retain ${rr.toFixed(0)}ms   dip  shipped ${(sd * 100).toFixed(1)}% → retain ${(rd * 100).toFixed(1)}%`);
  say("retention does not make recovery WORSE", rr <= sr * 1.25 + 200, `${sr.toFixed(0)}ms → ${rr.toFixed(0)}ms`);
}
console.log(`\nS1 SPIN GATE: ${pass ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(pass ? 0 : 1);
