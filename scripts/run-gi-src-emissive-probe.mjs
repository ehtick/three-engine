// EMISSIVES UNDER SRC, WITH PURE DEFAULTS — the end-to-end gate for the
// 2026-08-11 pair of default flips (`__giSrcProbes` on unless opted out;
// `emissiveShadows: true` in giConfig's CONSTANT).
//
// The chain this proves, which no unit gate covers end to end:
//   emissive mesh → GISystem promotion (brightest → MAX_EMITTERS uniform slots)
//   → the slots reach SRC's lighting socket (srcSystem `lighting.emitters`)
//   → NEE at hits + analytic receiver direct → light on the walls
// with NOT ONE console flag set — the arm is what a user boots.
//
// Scene: the generated Cornell project (makeCornellProject) — an emissive cube
// in a closed box with NO other light source, so every lit pixel is the cube's.
//
// Arms:
//   defaults   nothing set. Slots exist (shading.emitters = 4), the cube
//              PROMOTES (≥1 slot radius > 0), walls are lit.
//   optout     `__giConfigOverride = { emissiveShadows: false }`. Slots absent
//              (shading.emitters = 0) — the pre-flip shipped state. The cube
//              still lights the room SOFTLY through the ray path (unpromoted
//              emissive stays in the surface palette and shadeHit adds it), so
//              this arm asserts a DIFFERENT light model, not darkness.
//
// MECHANISM BEFORE PIXELS (gi-harness-viewport-traps): each arm first reads
// the socket and the slot uniforms through the engine object, and only then
// measures the frame. A wall reading of 0.000 with a healthy mechanism is a
// harness fault, not a feature verdict.
//
//   node scripts/run-gi-src-emissive-probe.mjs [url]
// Env: EMIT=<strength, default 4>, SHOT=<dir, default scripts>, HEADED=1
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-src")).replaceAll("\\", "/");
// 4: bright enough that a wall patch clears the 8-bit floor by a wide margin
// at one bounce; the rig's default 1 sat at 2-4/255 on the far wall, which is
// inside the tonemapper's toe and made every threshold a coin flip.
await makeCornellProject(GEN_ROOT, { emitStrength: Number(process.env.EMIT ?? 4) });
const SHOT = process.env.SHOT ?? "scripts";
const W = 1100, H = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PATCHES = [
  { name: "ceiling", x: 0.37, y: 0.02, w: 0.26, h: 0.10 },
  { name: "redwall", x: 0.23, y: 0.30, w: 0.10, h: 0.35 },
  { name: "greenwall", x: 0.68, y: 0.30, w: 0.10, h: 0.35 },
  { name: "floor", x: 0.37, y: 0.74, w: 0.26, h: 0.16 },
];

async function patchMeans(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = {};
  for (const p of PATCHES) {
    const x0 = Math.round(p.x * info.width), y0 = Math.round(p.y * info.height);
    const x1 = Math.round((p.x + p.w) * info.width), y1 = Math.round((p.y + p.h) * info.height);
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * 3;
        sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        n++;
      }
    }
    out[p.name] = sum / Math.max(1, n);
  }
  return out;
}

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(name, initFlags) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  const lines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\]/.test(t)) lines.push(t);
    if (/\[gi\] (src probes|built|diffuse indirect)/.test(t)) console.log(`  ${t.slice(0, 190)}`);
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 190)}`);
  });
  await page.evaluateOnNewDocument((P, flags) => {
    localStorage.setItem("engine.projectRoot.v1", P);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
    globalThis.__editorKeepRendering = true;
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, GEN_ROOT, initFlags);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, GEN_ROOT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

  // The field-ready line is the harness contract the emitter-shadow probe
  // established — readback before it measures an unvoxelized box.
  await page.waitForFunction(
    () => globalThis.__giFieldReadyProbe === true,
    { timeout: 180000, polling: 1000 },
  ).catch(() => {});
  // No exported hook for that line — watch our own console capture instead.
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && !lines.some((l) => /\[gi\] field ready/.test(l))) await wait(1000);
  if (!lines.some((l) => /\[gi\] field ready/.test(l))) throw new Error(`${name}: no "[gi] field ready" within 180s`);

  // ── MECHANISM READOUT ────────────────────────────────────────────────────
  const readMechanism = () =>
    page.evaluate(async () => {
      const { ensureEngine } = await import("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      const system = engine.modules.get("gi")?.system;
      const state = system?.state;
      const slots = state?.emitterSlots ?? null;
      return {
        srcBuilt: !!state?.screen?.srcProbes,
        shading: state?.screen?.srcProbes?.shading ?? null,
        slotCount: slots ? slots.length : 0,
        promoted: slots ? slots.filter((s) => (s?.radius?.value ?? 0) > 0.001).length : 0,
      };
    });

  // Promotion is a per-frame refresh — poll it rather than reading one frame.
  let mech = await readMechanism();
  const t1 = Date.now();
  while (Date.now() - t1 < 30000 && mech.slotCount > 0 && mech.promoted === 0) {
    await wait(1000);
    mech = await readMechanism();
  }
  console.log(`  mechanism: srcBuilt=${mech.srcBuilt} shading=${JSON.stringify(mech.shading)} slots=${mech.slotCount} promoted=${mech.promoted}`);

  // ── PIXELS ───────────────────────────────────────────────────────────────
  await page.evaluate(() => globalThis.__editorApi.call("viewport.freezeWhenUnfocused", { enabled: false })).catch(() => {});
  await page.evaluate(() =>
    globalThis.__editorApi.call("viewport.setCamera", { position: [0.0, 2.6, 6.0], target: [0.0, 2.5, -1.0] }));
  // Settle by MEASUREMENT, not by a fixed wait: SRC accumulates temporally, so
  // sample until 3 consecutive frame means agree within 5% (or 60s).
  let last = -1, stable = 0, shotBuf = null, means = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 60000 && stable < 3) {
    await wait(2500);
    const s = await page.evaluate(() =>
      globalThis.__editorApi.call("viewport.screenshot", { width: 1100, height: 700, includeGizmos: false }));
    shotBuf = Buffer.from(s.__image.base64, "base64");
    means = await patchMeans(shotBuf);
    const frame = (means.ceiling + means.redwall + means.greenwall + means.floor) / 4;
    stable = last > 0 && Math.abs(frame - last) / Math.max(1e-6, last) < 0.05 ? stable + 1 : 0;
    last = frame;
  }
  await writeFile(path.join(SHOT, `gi-src-emissive-${name}.png`), shotBuf);
  console.log(`  patches: ${PATCHES.map((p) => `${p.name} ${means[p.name].toFixed(4)}`).join("  ")}`);
  await page.close();
  return { mech, means };
}

console.log("== ARM defaults (no flags — what a user boots)");
const on = await runArm("defaults", {});
console.log("== ARM optout (__giConfigOverride emissiveShadows:false — the pre-flip state)");
const off = await runArm("optout", { __giConfigOverride: { emissiveShadows: false } });

let failed = 0;
const check = (ok, label) => { console.log(` ${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failed++; };

check(on.mech.srcBuilt, "defaults: SRC built with no flags set (default-on)");
check(on.mech.shading?.emitters === 4, `defaults: all 4 emitter slots reached SRC's lighting socket (got ${on.mech.shading?.emitters})`);
check(on.mech.promoted >= 1, `defaults: the emissive cube PROMOTED into a slot (got ${on.mech.promoted})`);
const onWalls = (on.means.redwall + on.means.greenwall + on.means.floor) / 3;
check(onWalls > 0.02, `defaults: walls are lit by the cube alone (mean ${onWalls.toFixed(4)})`);
check(off.mech.srcBuilt && off.mech.shading?.emitters === 0,
  `optout: the override still flows (SRC built, 0 emitter slots — got ${off.mech.shading?.emitters})`);
const offWalls = (off.means.redwall + off.means.greenwall + off.means.floor) / 3;
// The two arms are two REPRESENTATIONS OF ONE LIGHT — promoted (analytic
// direct + NEE, emission zeroed at hits) vs unpromoted (emission on the ray
// path) — and R5's handoff was calibrated so their ENERGY agrees (§12.26.7,
// 1.45% worst at a shading point; the whole-image bound is looser because the
// soft path leaks one-sided bright at coarse probe spacing, §12.26.9). The
// first version of this check asserted they DIFFER by >10%, which is
// asserting R5 is broken. The model SWITCH is proven by the mechanism
// readouts above (slots 4 vs 0, promoted 1 vs 0); what the pixels owe us is
// agreement.
check(Math.abs(onWalls - offWalls) / Math.max(1e-6, offWalls) < 0.25,
  `R5 handoff live: the two representations agree on wall energy ` +
  `(defaults ${onWalls.toFixed(4)} vs optout ${offWalls.toFixed(4)}, ` +
  `${(100 * Math.abs(onWalls - offWalls) / Math.max(1e-6, offWalls)).toFixed(1)}%)`);

console.log(failed ? `\ngi-src-emissive: ${failed} FAILED` : "\ngi-src-emissive: all PASS");
await browser.close();
process.exit(failed ? 1 : 0);
