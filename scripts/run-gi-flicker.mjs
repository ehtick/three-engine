// GI OBJECT-MOTION FLICKER INSTRUMENT (docs/GI_FLICKER_PLAN.md Phase 0).
//
// Screenshots cannot see flicker — this drives the user's REAL Sponza scene
// (same boot recipe as run-gi-sponza.mjs: seed localStorage, let the editor
// open the project through its own code path, drive it via the
// `globalThis.__editorApi` Symbol.for singleton) and captures a burst of
// consecutive frames while a real mesh in the scene moves, then measures
// per-pixel temporal noise on the FLOOR/WALLS AROUND it — not the mover
// itself, which legitimately changes every frame by design.
//
// GEOMETRY THIS RUN MEASURES: the scene's test sphere (entity "Mesh",
// id -qj2MSCdtC, base position ~[6.87, 1.44, -0.22], geometry "sphere") is
// translated along world X by ±AMP metres at FREQ Hz — mostly a DEPTH move
// relative to the fixed nave camera (pos [11.8,2.2,0.73] → look
// [-3.2,1.0,-1.47], nearly -X view axis), so the sphere stays roughly
// centred on screen rather than sweeping laterally. Tiles are excluded from
// the flicker metric by an OUTLIER test (temporal stddev far above the
// tile-population median) rather than a hardcoded screen region, so the
// exact set self-reports below instead of being guessed at write time.
//
// Because probeSmoothing and the new fieldSmoothing hatch are both LIVE
// (no rebuild), every combination in FIELD_SMOOTHING × PROBE_SMOOTHING runs
// inside ONE page load — no repeated multi-minute boot/compile waves.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-flicker.mjs
//
// Env:
//   PROJECT=<path>        default C:/Users/Khudiiash/Documents/GAME
//   QUALITY=low            override the GI quality preset
//   FIELD_SMOOTHING=0,0.5,0.8   __giFieldSmoothing values to A/B (default "0")
//   PROBE_SMOOTHING=0.02,0.35   component probeSmoothing values to A/B
//                               (default: the scene's saved value only)
//   FRAMES=30 DT_MS=100 AMP=1 FREQ=0.5
//   SKIP_STATIC=1          skip the no-motion bit-stability arm
//   SHOT=<dir>             dump every captured frame
//   HEADED=1
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const QUALITY = process.env.QUALITY ?? "";
const FIELD_SMOOTHING = (process.env.FIELD_SMOOTHING ?? "0").split(",").map((s) => Number(s.trim()));
const PROBE_SMOOTHING = (process.env.PROBE_SMOOTHING ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const FRAMES = Number(process.env.FRAMES ?? 30);
const DT_MS = Number(process.env.DT_MS ?? 100);
const AMP = Number(process.env.AMP ?? 1);
const FREQ = Number(process.env.FREQ ?? 0.5);
const SKIP_STATIC = process.env.SKIP_STATIC === "1";
const SHOT = process.env.SHOT ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // MANDATORY (gi-module Round 15): without these an occluded/headless window
  // gets ~1/s timer throttling and the GI field never populates.
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy backend|\[gi\] auto-fit bounds/.test(t)) console.log(`  ${t.slice(0, 220)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error") console.log(`  console.error: ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.stack ?? e.message).slice(0, 400)}`));

await page.evaluateOnNewDocument((PROJECT, DEBUG_FS) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  if (DEBUG_FS) globalThis.__giFieldSmoothingDebug = true;
}, PROJECT, !!process.env.DEBUG_FS);

console.log(`Opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });

await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
const clicked = await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  const btn = row?.querySelector(".hub-recent-open-btn");
  if (!btn) return null;
  btn.click();
  return row.getAttribute("title");
}, PROJECT);
if (!clicked) { console.log("FATAL: no recent-project row to open"); await browser.close(); process.exit(1); }
console.log(`  clicked recent: ${clicked}`);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try {
      return { ok: true, value: await globalThis.__editorApi.call(op, args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, { op, args });
const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
if (!entities.length) { console.log("FATAL: scene never populated"); await browser.close(); process.exit(1); }
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
// THE SCENE NOW HAS A SECOND, DISABLED GI COMPONENT: a leftover "Cornell"
// test-room root entity (enabledInEditor/Game false, backend "sdf-legacy",
// probeSmoothing 0.35) added since the last verified run-gi-sponza.mjs
// session, and it sorts FIRST in entity.list (it's the first root in
// Main.scene) — a naive `.find()` silently measures the wrong, disabled
// volume and never mentions Sponza again. Filter to an ENABLED gi component;
// describeEntity doesn't expose enabledInEditor/Game, but the component's
// OWN `enabled` prop is false on Cornell and true on Sponza's override, so
// it is the reliable discriminator.
const giCandidates = entities.filter((e) => componentOf(e, "global-illumination"));
const giEntity = giCandidates.find((e) => componentOf(e, "global-illumination")?.props?.enabled !== false) ?? giCandidates[0];
const sponza = entities.find((e) => /sponza/i.test(e.name ?? "")) ?? giEntity;
// The scene's test sphere: a "mesh" component with geometry "sphere" — not
// name-matched, the entity is just called "Mesh" (see GI_FLICKER_PLAN.md /
// gi-module memory for how this was found).
const sphere = entities.find((e) => componentOf(e, "mesh")?.props?.geometry === "sphere");
if (!giEntity) { console.log("FATAL: no global-illumination component in the scene"); await browser.close(); process.exit(1); }
if (!sphere) { console.log("FATAL: no sphere mesh entity found to animate"); await browser.close(); process.exit(1); }
const gi = componentOf(giEntity, "global-illumination");
// entity.get returns { transform: { position, rotation, scale }, ... } — NOT
// top-level position/rotation (a shape the run-gi-sponza.mjs sun-rotation
// read gets wrong too, silently masked there by its `?? fallback`).
const spherePose = (await must("entity.get", { id: sphere.id })).transform;
console.log(`  sphere "${sphere.name}" (${sphere.id}) base position [${spherePose.position.map((v) => (+v).toFixed(2))}]`);
console.log(`  GI on "${giEntity.name}" (enabled ${gi.props?.enabled}, quality ${gi.props?.quality}, probeSmoothing ${gi.props?.probeSmoothing})`);

if (QUALITY) {
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: QUALITY });
  console.log(`  quality forced to ${QUALITY}`);
}
for (let i = 0; i < 90 && !built; i++) await wait(1000);
await wait(12000);
if (gi.props?.enabled === false) {
  built = false;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
  for (let i = 0; i < 240 && !built; i++) await wait(500);
  await wait(10000);
}

// Same verified nave pose as run-gi-sponza.mjs.
await must("viewport.focus", { id: sponza.id });
await wait(1200);
const pos = [11.8, 2.2, 0.73];
const look = [-3.2, 1.0, -1.47];
await must("viewport.setCamera", { position: pos, target: look });
console.log(`  camera ${pos.map((v) => v.toFixed(1))} → ${look.map((v) => v.toFixed(1))} (inside nave, -x)`);

const TX = 12, TY = 8;
async function captureTileFrame(label) {
  const shot = await must("viewport.screenshot", { width: 900, height: 600, includeGizmos: false });
  const png = Buffer.from(shot.__image.base64, "base64");
  if (SHOT) await writeFile(path.join(SHOT, `flicker-${label}.png`), png);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const tiles = new Array(TX * TY).fill(0);
  const tileN = new Array(TX * TY).fill(0);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const lin = [data[i], data[i + 1], data[i + 2]].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      const t = Math.min(TY - 1, Math.floor((y / info.height) * TY)) * TX
        + Math.min(TX - 1, Math.floor((x / info.width) * TX));
      tiles[t] += 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      tileN[t]++;
    }
  }
  for (let t = 0; t < tiles.length; t++) tiles[t] /= Math.max(1, tileN[t]);
  return tiles;
}

function stddev(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
// FLICKER ("popping"), not mere temporal variance — a smooth physically-
// correct brightness ramp (a moving object legitimately darkening a nearby
// floor tile as it passes) has HIGH stddev but is monotonic in each
// direction; true flicker reverses direction repeatedly. Ported from
// run-gi-sponza.mjs's sweep() reversal counter (proven there against the
// sun sweep) rather than reinvented — same threshold (rev >= 2 ⇒ "popping").
function poppingReversals(series) {
  const d = series.slice(1).map((v, i) => v - series[i]);
  const scale = d.reduce((a, b) => a + Math.abs(b), 0) / d.length || 1e-9;
  let rev = 0;
  for (let i = 1; i < d.length; i++) {
    if (d[i] * d[i - 1] < 0 && Math.abs(d[i]) > scale * 0.5) rev++;
  }
  return rev;
}

// Runs FRAMES captures at DT_MS cadence. `moveFn(i)` (if given) is called
// before each capture to move the sphere — NO settle wait after it: the
// reported artifact is a TRANSIENT while the light/geometry is still
// changing, not a converged state (see run-gi-sponza.mjs's sweep note).
async function burst(label, moveFn) {
  const perTile = [];
  for (let i = 0; i < FRAMES; i++) {
    if (moveFn) await moveFn(i);
    // A short settle (NOT a converge-wait — the reported artifact is a
    // transient, see the note above) cuts a React re-render race in the
    // editor's own panels observed under zero-wait rapid-fire
    // entity.setTransform + viewport.screenshot: without it, the page has
    // intermittently navigated mid-burst (ReactDOMClient.createRoot called
    // twice → execution context destroyed), unrelated to GI.
    await wait(40);
    perTile.push(await captureTileFrame(`${label}${i}`));
  }
  const nTiles = TX * TY;
  const tileSeries = Array.from({ length: nTiles }, (_, t) => perTile.map((f) => f[t]));
  const tileStd = tileSeries.map(stddev);
  return { tileSeries, tileStd };
}

async function setFieldSmoothing(v) {
  await page.evaluate((v) => { globalThis.__giFieldSmoothing = v; }, v);
}
async function setProbeSmoothing(v) {
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "probeSmoothing", value: v });
}
async function resetSphere() {
  await must("entity.setTransform", { id: sphere.id, position: spherePose.position });
}

async function runArm(fs, ps) {
  await setFieldSmoothing(fs);
  if (ps != null) await setProbeSmoothing(ps);
  await wait(600); // let the live uniforms land before capturing
  const results = { fs, ps: ps ?? gi.props?.probeSmoothing };

  if (!SKIP_STATIC) {
    const still = await burst(`fs${fs}-ps${ps}-static`, null);
    results.staticMeanStd = still.tileStd.reduce((a, b) => a + b, 0) / still.tileStd.length;
    results.staticMaxStd = Math.max(...still.tileStd);
  }

  const dt = DT_MS / 1000;
  const baseX = spherePose.position[0];
  const moving = await burst(`fs${fs}-ps${ps}-moving`, async (i) => {
    const t = i * dt;
    const x = baseX + AMP * Math.sin(2 * Math.PI * FREQ * t);
    await must("entity.setTransform", { id: sphere.id, position: [x, spherePose.position[1], spherePose.position[2]] });
  });
  await resetSphere();

  // Outlier exclusion: a tile whose temporal stddev is far above the
  // population median is registering the MOVER's own silhouette/size change,
  // not ambient flicker. Threshold is data-driven, not a guessed screen
  // region — the excluded set is reported below.
  const med = median(moving.tileStd) || 1e-6;
  const excluded = [];
  const kept = [];
  moving.tileStd.forEach((s, t) => {
    if (s > med * 8 && s > 0.002) excluded.push(t); else kept.push(s);
  });
  results.excludedTiles = excluded.map((t) => ({ x: t % TX, y: Math.floor(t / TX), std: moving.tileStd[t].toFixed(5) }));
  results.flickerScore = kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : NaN;
  results.flickerMaxKept = kept.length ? Math.max(...kept) : NaN;
  // POPPING (see poppingReversals) over the same kept tiles — the metric
  // that actually distinguishes flicker from a smooth, expected brightness
  // ramp as the mover passes.
  const revCounts = [];
  let poppedTiles = 0;
  moving.tileStd.forEach((s, t) => {
    if (excluded.includes(t)) return;
    const rev = poppingReversals(moving.tileSeries[t]);
    revCounts.push(rev);
    if (rev >= 2) poppedTiles++;
  });
  results.poppedTiles = poppedTiles;
  results.poppedPct = revCounts.length ? (poppedTiles / revCounts.length) * 100 : NaN;
  results.meanReversals = revCounts.length ? revCounts.reduce((a, b) => a + b, 0) / revCounts.length : NaN;
  // RAW SERIES for the single kept tile with the highest stddev — lets a
  // human (or a follow-up eyeball) see whether the waveform is actually
  // getting smoother, not just whether one aggregate number moved.
  let watchIdx = -1, watchStd = -1;
  moving.tileStd.forEach((s, t) => {
    if (!excluded.includes(t) && s > watchStd) { watchStd = s; watchIdx = t; }
  });
  if (watchIdx >= 0) {
    results.watchTile = { x: watchIdx % TX, y: Math.floor(watchIdx / TX), series: moving.tileSeries[watchIdx].map((v) => +v.toFixed(5)) };
  }
  return results;
}

console.log(`\nFRAMES=${FRAMES} DT_MS=${DT_MS} AMP=${AMP}m FREQ=${FREQ}Hz  TILES=${TX}x${TY}`);
const probeArms = PROBE_SMOOTHING.length ? PROBE_SMOOTHING : [null];
const report = [];
combos: for (const fs of FIELD_SMOOTHING) {
  for (const ps of probeArms) {
    console.log(`\n=== fieldSmoothing=${fs}  probeSmoothing=${ps ?? "(scene default)"} ===`);
    let r;
    try {
      r = await runArm(fs, ps);
    } catch (err) {
      // The editor's own React tree has an unrelated flake under rapid
      // entity.setTransform + screenshot (page navigates mid-burst) — don't
      // lose every combo already measured over it, report what we have.
      console.log(`  ABORTED this combo: ${err?.message ?? err}`);
      break combos;
    }
    if (r.staticMeanStd != null) {
      console.log(`  static-arm  tile stddev  mean ${r.staticMeanStd.toFixed(6)}  max ${r.staticMaxStd.toFixed(6)}  (bit-stability check — should be ~0)`);
    }
    console.log(`  moving-arm  excluded ${r.excludedTiles.length}/${TX * TY} tiles (mover's own footprint): ${JSON.stringify(r.excludedTiles)}`);
    console.log(`  moving-arm  amplitude (mean stddev, kept tiles) = ${r.flickerScore.toFixed(6)}   max-kept ${r.flickerMaxKept.toFixed(6)}`);
    console.log(`  moving-arm  POPPING: ${r.poppedTiles} tiles reversing ≥2x (${r.poppedPct.toFixed(0)}%)   mean reversals/tile ${r.meanReversals.toFixed(2)}   <- THE FLICKER METRIC`);
    if (r.watchTile) console.log(`  watch tile (${r.watchTile.x},${r.watchTile.y}) series: ${r.watchTile.series.join(" ")}`);
    report.push(r);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`fieldSmoothing  probeSmoothing  static-mean  popped%  meanRev  amplitude`);
for (const r of report) {
  console.log(
    `${String(r.fs).padEnd(14)} ${String(r.ps).padEnd(15)} ${(r.staticMeanStd ?? NaN).toFixed(6).padEnd(11)}  ${r.poppedPct.toFixed(0).padEnd(7)}  ${r.meanReversals.toFixed(2).padEnd(7)}  ${r.flickerScore.toFixed(6)}`,
  );
}

try { await setFieldSmoothing(0); } catch { /* page may already be gone */ }
await browser.close();
process.exit(0);
