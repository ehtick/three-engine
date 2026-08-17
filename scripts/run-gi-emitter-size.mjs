// "SMALL EMISSIVE OBJECTS DON'T EMIT LIGHT" — THE TWO SWEEPS THAT SEPARATE
// A BUG FROM PHYSICS.
//
// User report (2026-08-17), after `test:gi-shadowed-bulb` proved delivery works:
// "emissive objects still don't emit any light when small".
//
// ══ WHY THE EXISTING GATE CANNOT ANSWER THIS ═══════════════════════════════
//
// `test:gi-shadowed-bulb` measures a wall patch **0.5 m** from the bulb, chosen
// to be close so the pool is bright and unambiguous. That makes it blind to the
// two things this report could mean:
//
//   · a REACH CUTOFF derived from the emitter's geometric radius would cap a
//     5 cm bulb at a few centimetres and still sail through a 0.5 m measurement;
//   · "small emits less" is also just TRUE — power = pi · area · radiance, so a
//     5 cm sphere (0.0314 m²) at radiance L emits ~1/50th of a 0.4 m sphere
//     (2.01 m²) at the same L. An artist authoring `strength: 10` on a bulb and
//     on a wall panel is asking for two lights 50x apart.
//
// The two have OPPOSITE fixes — one is a bug in the falloff, the other is an
// authoring affordance — and they are indistinguishable from "it looks dark".
//
// ══ THE DISCRIMINATORS ═════════════════════════════════════════════════════
//
//   SWEEP A — RADIUS AT MATCHED TOTAL POWER. Vary radius, scale radiance by
//     (r0/r)² so `pi · A · L` is CONSTANT. Physics says every arm delivers the
//     same irradiance at a distance well past the radius. If the small arms come
//     back dimmer, that is a bug and its size is measured here.
//
//   SWEEP B — DISTANCE AT FIXED SMALL RADIUS. Physics says E ∝ 1/d². If the
//     measured falloff is steeper than inverse-square, something is cutting the
//     emitter's reach short — the plan's E2 suspect, named directly.
//
// ══ TWO INSTRUMENT DECISIONS THAT DECIDE WHETHER THE NUMBERS MEAN ANYTHING ═
//
//  1. TONE MAPPING OFF, AND THE READBACK LINEARIZED. AgX at a 0.65 mean sits deep
//     in its shoulder; it would compress a true 1/d² falloff into something much
//     flatter and the rig would report a "reach cutoff" that is a tone curve. The
//     rig builds with `toneMapping: "none"` and the sampler undoes sRGB
//     (v^2.2) before averaging, so the mean is proportional to linear radiance.
//  2. STRENGTHS SIZED TO STAY OFF THE CEILING. A saturated patch reads 1.0 for
//     every arm and every ratio becomes 1.00. `POWER` is tuned so the brightest
//     arm lands well under clipping; the rig reports peak so a clipped run is
//     visible rather than silently flat.
//
// The dark arm is not re-run per sweep point: this room has no other light and
// `test:gi-shadowed-bulb` measured its floor at 3.5e-4 with the bulb off. That
// constant is subtracted and named below.
//
//   node scripts/run-gi-emitter-size.mjs        (vite on :5201)
//   SWEEP=radius|distance|both  POWER=200  QUALITY=high
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeShadowedBulbProject, BULB_POSE, BULB } from "./lib/makeShadowedBulbProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const SWEEP = process.env.SWEEP ?? "both";
const QUALITY = process.env.QUALITY ?? "high";
const SETTLE = Number(process.env.SETTLE ?? 20000);
const SAMPLES = Number(process.env.SAMPLES ?? 10);
// Reference point: r = 0.2 m at this strength. Every radius arm matches its
// TOTAL POWER by scaling radiance by (r0/r)².
const REF_RADIUS = 0.2;
const REF_STRENGTH = Number(process.env.POWER ?? 60);
// Measured with the bulb off, tone-mapped; re-measured linearly it is smaller
// still. Subtracted from every arm so a floor cannot look like delivery.
const DARK_FLOOR = 2e-5;
const OUT = ".gi-shots/emitter-size";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const RADII = [0.4, 0.2, 0.1, 0.05, 0.025];
const GAPS = [0.4, 0.8, 1.6];

const arms = [];
if (SWEEP === "radius" || SWEEP === "both") {
  for (const r of RADII) {
    // Matched power: P = pi · 4·pi·r² · L, so L ∝ 1/r².
    const strength = REF_STRENGTH * (REF_RADIUS / r) ** 2;
    arms.push({ kind: "radius", label: `r=${r}`, radius: r, strength, gap: 0.5 });
  }
}
if (SWEEP === "distance" || SWEEP === "both") {
  for (const g of GAPS) {
    arms.push({ kind: "distance", label: `d=${g}`, radius: 0.05, strength: REF_STRENGTH * (REF_RADIUS / 0.05) ** 2, gap: g });
  }
}

console.log(
  `sweeps: ${arms.map((a) => a.label).join(", ")}\n` +
  `matched total power P = pi·A·L with r0=${REF_RADIUS} L0=${REF_STRENGTH}; tone mapping OFF, readback linearized`,
);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm, i) {
  const root = path.resolve(`scripts/.gi-emitter-size-${i}`).replaceAll("\\", "/");
  await makeShadowedBulbProject(root, {
    quality: QUALITY, emitStrength: arm.strength, bulbRadius: arm.radius,
    bulbWallGap: arm.gap, toneMapping: "none",
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 750, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let ledger = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/emitter ledger/.test(t)) ledger = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 160)}`);
  });
  await page.evaluateOnNewDocument((project) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // Full delivery, explicitly, on every arm.
    globalThis.__giSrcLightTree = true;
    globalThis.__giEmitterTileCut = true;
  }, root);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, root);
  for (let n = 0; n < 180 && !built; n++) await wait(1000);
  if (!built) throw new Error(`${arm.label}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await page.evaluate(async (pose) => {
    await globalThis.__editorApi.call("viewport.setCamera", pose);
  }, BULB_POSE);
  await wait(SETTLE);

  const read = () => page.evaluate(async () => {
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
        // LINEARIZE before averaging — the canvas is sRGB-encoded and a mean of
        // encoded values is not proportional to radiance, so ratios taken on it
        // would understate every falloff.
        let lin = 0;
        let peak = 0;
        const px = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          lin += Math.pow(l, 2.2);
          if (l > peak) peak = l;
        }
        resolve({ lin: lin / px, peak });
      });
    });
  });

  const vals = [];
  let peak = 0;
  for (let n = 0; n < SAMPLES; n++) {
    const s = await read();
    vals.push(s.lin);
    if (s.peak > peak) peak = s.peak;
    await wait(200);
  }
  await page.screenshot({ path: `${OUT}/${arm.kind}-${arm.label.replace("=", "")}.png` });
  await page.close();
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  // The ledger's own view of this emitter — the CPU's power, for cross-checking
  // that "matched power" really was matched before blaming the transport.
  const P = /P=([0-9.e+-]+)/.exec(ledger)?.[1] ?? "?";
  const area = /area=([0-9.e+-]+)/.exec(ledger)?.[1] ?? "?";
  const fill = /fill=([0-9.]+)/.exec(ledger)?.[1] ?? "?";
  return { ...arm, mean: Math.max(mean - DARK_FLOOR, 0), peak, P, area, fill };
}

const results = [];
for (let i = 0; i < arms.length; i++) {
  const r = await runArm(arms[i], i);
  results.push(r);
  console.log(
    `  ${r.kind.padEnd(8)} ${r.label.padEnd(9)} strength ${String(Math.round(r.strength)).padStart(6)}  ` +
    `linear mean ${r.mean.toExponential(3)}  peak ${r.peak.toFixed(3)}  ledger P=${r.P} area=${r.area} fill=${r.fill}`,
  );
}
writeFileSync(`${OUT}/result.json`, JSON.stringify({ results, REF_RADIUS, REF_STRENGTH, QUALITY }, null, 2));

let pass = true;
const say = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};
const clipped = results.some((r) => r.peak > 0.98);

console.log(`\n== SWEEP A: RADIUS AT MATCHED TOTAL POWER ==`);
const rad = results.filter((r) => r.kind === "radius");
if (rad.length) {
  const ref = rad.find((r) => r.radius === REF_RADIUS) ?? rad[0];
  for (const r of rad) {
    const ratio = r.mean / Math.max(ref.mean, 1e-12);
    console.log(
      `  ${r.label.padEnd(9)} delivered ${r.mean.toExponential(3)}  ` +
      `= ${ratio.toFixed(3)}x the r=${REF_RADIUS} arm  ${ratio < 0.5 ? "← UNDER-DELIVERS" : ratio > 2 ? "← OVER-DELIVERS" : ""}`,
    );
  }
  const small = rad.reduce((a, r) => (r.radius < a.radius ? r : a), rad[0]);
  const ratio = small.mean / Math.max(ref.mean, 1e-12);
  say(
    `equal power delivers equal light regardless of size (${small.label} vs r=${REF_RADIUS})`,
    ratio >= 0.5 && ratio <= 2,
    `${ratio.toFixed(3)}x — below 0.5x means SMALL EMITTERS ARE UNDER-DELIVERED BY THE TRANSPORT (a bug); ` +
    `near 1.0x means "small looks dark" is power = pi·area·radiance (physics, and an AUTHORING problem)`,
  );
}

console.log(`\n== SWEEP B: FALLOFF vs INVERSE SQUARE (r=0.05) ==`);
const dist = results.filter((r) => r.kind === "distance");
if (dist.length >= 2) {
  // ⚠ 1/d² IS THE WRONG PREDICTION FOR THIS CROP, AND ONLY ONE DIRECTION OF THE
  // COMPARISON IS MEANINGFUL. The room is enclosed and white, and the crop covers
  // a wide patch of wall — so moving the bulb back both dims the direct term AND
  // SPREADS the pool over more of the measured area, while multi-bounce from the
  // enclosure barely changes. The measured falloff is therefore SHALLOWER than
  // inverse-square by construction, and a ratio above 1 says nothing about the
  // physics being wrong. What the number can still do is catch a falloff that is
  // STEEPER than 1/d² — which is what a radius-derived reach cutoff looks like,
  // and is the only thing this sweep is gated on.
  const base = dist[0];
  for (const r of dist) {
    const predicted = base.mean * (base.gap / r.gap) ** 2;
    const rel = r.mean / Math.max(predicted, 1e-12);
    console.log(
      `  d=${String(r.gap).padEnd(5)} delivered ${r.mean.toExponential(3)}  ` +
      `inverse-square predicts ${predicted.toExponential(3)}  ratio ${rel.toFixed(3)}` +
      `${rel < 0.5 ? "  ← FALLS OFF FASTER THAN PHYSICS (reach cutoff)" : ""}`,
    );
  }
  const far = dist[dist.length - 1];
  const predicted = base.mean * (base.gap / far.gap) ** 2;
  const rel = far.mean / Math.max(predicted, 1e-12);
  say(
    `a 5 cm emitter's falloff is not steeper than inverse-square out to ${far.gap} m`,
    rel >= 0.5,
    `${rel.toFixed(3)} of the naive 1/d² prediction. ONLY the low side is a verdict: an enclosed room with a wide ` +
    `crop is shallower than 1/d² by construction, so >1 is expected; <0.5 would indict a radius-derived cutoff (plan E2)`,
  );
}
if (clipped) console.log(`\n  ⚠ at least one arm peaked > 0.98 — reduce POWER and re-run; a clipped patch flattens every ratio`);
console.log(`\nEMITTER SIZE GATE: ${pass ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(pass ? 0 : 1);
