// IS THE PROBE LATTICE SPENDING ITS BUDGET WHERE THE LIGHT VARIES?
//
//   npx vite --port 5201        (in another terminal)
//   node scripts/run-gi-probe-density.mjs
//   PROJECT=C:/path/to/project SETTLE=30000 node scripts/run-gi-probe-density.mjs
//
// ══ THE QUESTION ════════════════════════════════════════════════════════════
//
// Every placement decision in SRC today is GEOMETRIC. `lodAtDistance` sets a
// probe's spacing from its distance to the camera, deliberately producing a
// constant ~0.9° angular lattice; the cascade ladder sets the ray interval.
// Nothing anywhere asks whether the light is actually CHANGING at that probe.
//
// If that is a real inefficiency, it is worth an allocator. If it is not, an
// allocator is a rewrite of the most delicate part of the module for nothing.
// This rig is here to decide that BEFORE the work, and it is deliberately
// cheap: one readback of a settled frame, all the arithmetic in Node.
//
// ══ THE MEASUREMENT: A DECIMATION TEST ══════════════════════════════════════
//
// Halve the lattice and ask what it cost. Within one (cascade, LOD, secondary)
// group the probes sit on a uniform integer lattice, so:
//
//   · probes whose cell coordinates are ALL EVEN are the survivors of a 2×
//     coarser lattice;
//   · every other probe is a deletion candidate, and the coarse lattice would
//     have had to reconstruct it by interpolating its even neighbours.
//
// So for each candidate, interpolate the 2/4/8 even corners that bracket it and
// compare against what the probe actually holds. A small error means that probe
// carries no information its neighbours did not already have — it is budget
// spent on a number that was predictable. A large error means the lattice is at
// the right density there and the probe is earning its slot.
//
// ⚠ TWO CONTROLS, AND WITHOUT THEM THE HEADLINE NUMBER IS MEANINGLESS.
//
//   1. THE SHUFFLE CONTROL. "62% of probes are predictable within 10%" says
//      nothing on its own — it could just mean this scene's irradiance is
//      uniform everywhere, in which case interpolating from ANY probe would
//      score the same. So every candidate is also scored against a RANDOM
//      other probe from its own group. The gap between the two is the actual
//      spatial redundancy; if decimation ≈ shuffle, neighbours tell you nothing
//      and the lattice cannot be thinned no matter what the first number says.
//
//   2. THE BRIGHT SUBSET. Most probes in an outdoor scene are dim and flat, and
//      a dim probe next to dim probes is trivially predictable — averaging them
//      in makes any lattice look wasteful. The headline is therefore restricted
//      to probes above their group's MEDIAN irradiance, which is where the
//      indirect light people notice actually lives.
//
// Reported in BOTH luminance and CHROMATICITY, because the symptom that started
// this is colour bleed: a grey wall beside a red awning has a modest luminance
// gradient and a large chromatic one, so a luma-only metric would call that
// boundary boring and an allocator built on it would never put probes there.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 30000);
const OUT = ".gi-shots/probe-density";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// The pose the question was asked about — the cafe corner, read off the live
// editor viewport. A density statistic is only meaningful for a specific view,
// because the LOD ladder is anchored to the camera.
const POSE = {
  position: [-12.180572876603646, 2.377470686992635, -0.8876293701536424],
  target: [5.121504134069502, 1.85371217060508, -1.7807895055111131],
};

// mulberry32 — the shuffle control compares distributions, so a generator with
// serial correlation would show up as a bias in exactly the number that decides
// whether this whole idea is worth building.
let rngState = 0x9e3779b9 >>> 0;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
// No `writableRoot` — the shim refuses every write command, so this opens the
// user's real project strictly read-only. Autosave cannot reach disk.
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
  if (!/save_scene|refusing write/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

await page.evaluateOnNewDocument((project, quality) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  // ⚠ PIN THE TIER. The first run of this rig booted at s₀ = 0.35 (ultra) while
  // the editor whose screenshot prompted the question was running s₀ = 0.6 —
  // the tier is chosen partly from the pixel count, and a harness viewport is
  // not the user's viewport. Probe spacing differing by 1.7× is the entire
  // subject of this measurement, so it cannot be left to be inferred.
  // Quality-only override, per the standing GI rule.
  if (quality) globalThis.__giConfigOverride = { quality };
}, PROJECT, process.env.QUALITY ?? "medium");

console.log(`opening ${PROJECT} (read-only)`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);

for (let i = 0; i < 300 && !built; i++) {
  await wait(1000);
  if (i % 20 === 19) console.log(`  waiting for the GI build… ${i + 1}s`);
}
if (!built) throw new Error("the GI build never completed");
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
console.log(`built. ${bootLine.slice(0, 180)}`);

await page.evaluate(async (p) => {
  await globalThis.__editorApi.call("viewport.setCamera", p);
}, POSE);
console.log(`settling ${(SETTLE / 1000).toFixed(0)}s at the cafe pose…`);
await wait(SETTLE);

// ── THE READBACK ───────────────────────────────────────────────────────────
//
// Per-probe irradiance is summed IN THE PAGE and only the summary crosses the
// bridge. The payload buffer is ~45 MB of floats at this scene's bin budget and
// serializing it through puppeteer would dominate the run; the analysis only
// needs one RGB per probe.
const probes = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const src = sys?.state?.screen?.srcProbes;
  if (!src?.store || !src?.binStore) return { error: "no live SRC probe store" };

  const store = src.store;
  const binStore = src.binStore;
  const table = new Uint32Array(await engine.renderer.getArrayBufferAsync(store.probeTable.value));
  const payload = new Float32Array(await engine.renderer.getArrayBufferAsync(binStore.payload.value));

  const PROBE_WORDS = 8, PROBE_KEY = 0, PROBE_FLAGS = 2, PROBE_BLOCK = 7;
  const FLAG_ALIVE = 1;
  const SLOT_EMPTY = 0xffffffff;
  const out = [];
  for (const c of store.cascades) {
    const bc = binStore.cascades.find((b) => b.cascade === c.cascade);
    if (!bc) continue;
    for (let i = 0; i < c.probeCapacity; i++) {
      const base = (c.probeBase + i) * PROBE_WORDS;
      if (!(table[base + PROBE_FLAGS] & FLAG_ALIVE)) continue;
      const key = table[base + PROBE_KEY];
      if (key === 0) continue;
      const block = table[base + PROBE_BLOCK];
      if (block === SLOT_EMPTY || block >= bc.blockCapacity) continue;
      // A bin's slot is `binBase + block·bins + morton`, and the payload is
      // rgb + T with T < 0 meaning UNKNOWN (never sampled). Averaging over the
      // KNOWN bins only — folding unknowns in as black would make a
      // partially-traced probe look like a dark one, which is the §12.65 trap.
      let r = 0, g = 0, b = 0, n = 0;
      const binBase = bc.binBase + block * bc.bins;
      for (let d = 0; d < bc.bins; d++) {
        const w = (binBase + d) * 4;
        if (!(payload[w + 3] >= 0)) continue;
        r += payload[w]; g += payload[w + 1]; b += payload[w + 2]; n++;
      }
      if (n === 0) continue;
      out.push([c.cascade, key, r / n, g / n, b / n, n / bc.bins]);
    }
  }
  return {
    probes: out,
    spacing0: src.spacing0 ?? null,
    cascades: store.cascades.map((c) => ({ cascade: c.cascade, probeCapacity: c.probeCapacity })),
  };
});

if (probes.error) throw new Error(probes.error);
await browser.close();

// ── THE ANALYSIS ───────────────────────────────────────────────────────────

const KEY_AXIS_BITS = 9;
const KEY_AXIS_MASK = (1 << KEY_AXIS_BITS) - 1;
const unpack = (key) => ({
  lod: ((key >>> 28) & 0xf) - 1,
  secondary: (key >>> 27) & 1,
  cx: (key >>> 18) & KEY_AXIS_MASK,
  cy: (key >>> 9) & KEY_AXIS_MASK,
  cz: key & KEY_AXIS_MASK,
});

const luma = (p) => 0.2126 * p[2] + 0.7152 * p[3] + 0.0722 * p[4];
/** Chromaticity as r/(r+g+b), g/(r+g+b) — luminance divided out. */
const chroma = (p) => {
  const s = p[2] + p[3] + p[4];
  return s > 1e-9 ? [p[2] / s, p[3] / s] : [1 / 3, 1 / 3];
};

// Group by (cascade, lod, secondary): each is one uniform lattice, and mixing
// two of them would compare probes at different spacings.
const groups = new Map();
for (const p of probes.probes) {
  const k = unpack(p[1]);
  const gid = `${p[0]}/${k.lod}/${k.secondary}`;
  let g = groups.get(gid);
  if (!g) { g = { gid, cascade: p[0], lod: k.lod, secondary: k.secondary, byCell: new Map(), all: [] }; groups.set(gid, g); }
  g.byCell.set(`${k.cx},${k.cy},${k.cz}`, p);
  g.all.push(p);
}

// ⚠⚠ THREE DEFECTS IN THE FIRST VERSION OF THIS ANALYSIS, ALL FOUND ON THE
// FIRST RUN AGAINST THE REAL SCENE, AND ALL WORTH KEEPING WRITTEN DOWN BECAUSE
// EACH ONE PRODUCED A CONFIDENT WRONG ANSWER RATHER THAN AN ERROR:
//
//  1. THE CONTROL WAS NOT MATCHED TO THE SUBSET. The decimation histogram was
//     restricted to BRIGHT probes while the shuffle control ran over ALL
//     evaluated candidates. Most probes in this scene are near-black, so
//     random-vs-random scored 100% "predictable" and the run reported
//     "REDUNDANCY = -100 points", i.e. a random probe beating a neighbour —
//     which is impossible, and is the shape of a broken instrument rather than
//     a surprising result. A control must be drawn from the same population as
//     the thing it controls.
//
//  2. STRICT DECIMATION HAS NO COVERAGE. Requiring all 2/4/8 even corners to
//     exist evaluated **77 of 4710 candidates (1.6%)**. Probes live on a 2-D
//     manifold inside a 3-D lattice, so a complete axis-aligned stencil is the
//     exception, not the rule. A statistic over 1.6% of the population is not a
//     measurement of the population.
//
//  3. THE QUALITY TIER WAS NOT PINNED. The rig booted at s₀ = 0.35 (ultra)
//     while the editor being asked about was running s₀ = 0.6 — probe spacing
//     differs by 1.7×, which is the entire subject of the measurement.
//
// So the primary estimator is now NEIGHBOUR DISAGREEMENT, which has near-full
// coverage and is also a closer model of what a gradient-driven allocator would
// actually key on: predict each probe from whichever immediate neighbours exist
// and ask how wrong that is. Relaxed decimation is kept as a second opinion.

/** p-th percentile of a sorted array. */
const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const frac = (arr, t) => (arr.length ? (100 * arr.filter((v) => v < t).length) / arr.length : 0);

const report = [];
for (const g of [...groups.values()].sort((a, b) => a.cascade - b.cascade || a.lod - b.lod)) {
  if (g.all.length < 64) continue;
  const lumas = g.all.map(luma).sort((a, b) => a - b);
  // BRIGHT = above the median AND not a rounding error next to the group's own
  // peak. A group where almost everything is black would otherwise define
  // "bright" as "very slightly less black", and every statistic below would be
  // measuring the noise floor.
  const p99 = pctile(lumas, 0.99);
  const brightCut = Math.max(pctile(lumas, 0.5), 0.05 * p99);
  const isBright = (p) => luma(p) > brightCut;
  const brightPool = g.all.filter(isBright);

  const err = (a, pred) => {
    const la = luma(a), lp = luma(pred);
    const ca = chroma(a), cp = chroma(pred);
    return {
      l: Math.abs(la - lp) / Math.max(la, lp, 1e-6),
      c: Math.hypot(ca[0] - cp[0], ca[1] - cp[1]),
    };
  };
  const mean = (list) => {
    let r = 0, gg = 0, b = 0;
    for (const q of list) { r += q[2]; gg += q[3]; b += q[4]; }
    const n = list.length;
    return [0, 0, r / n, gg / n, b / n, 1];
  };

  const nbrL = [], nbrC = [], ctlL = [], ctlC = [], decL = [], decC = [];
  let neighbourCoverage = 0, decCoverage = 0, decCandidates = 0;

  for (const [cellKey, p] of g.byCell) {
    if (!isBright(p)) continue;
    const [cx, cy, cz] = cellKey.split(",").map(Number);

    // ── ESTIMATOR 1: leave-one-out from the 6 axis neighbours that exist.
    const nbrs = [];
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const q = g.byCell.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (q) nbrs.push(q);
    }
    if (nbrs.length >= 2) {
      neighbourCoverage++;
      const e = err(p, mean(nbrs));
      nbrL.push(e.l); nbrC.push(e.c);
      // THE MATCHED CONTROL: same probe, same metric, a random probe from the
      // SAME bright pool standing in for its neighbourhood.
      const q = brightPool[Math.floor(rand() * brightPool.length)];
      const ec = err(p, q);
      ctlL.push(ec.l); ctlC.push(ec.c);
    }

    // ── ESTIMATOR 2: relaxed decimation — the even corners that exist.
    const odd = [cx & 1, cy & 1, cz & 1];
    if (odd[0] || odd[1] || odd[2]) {
      decCandidates++;
      const corners = [];
      for (let m = 0; m < 8; m++) {
        if ((odd[0] === 0 && (m & 1)) || (odd[1] === 0 && (m & 2)) || (odd[2] === 0 && (m & 4))) continue;
        const q = g.byCell.get(
          `${cx + (odd[0] ? ((m & 1) ? 1 : -1) : 0)},${cy + (odd[1] ? ((m & 2) ? 1 : -1) : 0)},${cz + (odd[2] ? ((m & 4) ? 1 : -1) : 0)}`,
        );
        if (q) corners.push(q);
      }
      if (corners.length >= 2) {
        decCoverage++;
        const e = err(p, mean(corners));
        decL.push(e.l); decC.push(e.c);
      }
    }
  }

  const sort = (a) => a.slice().sort((x, y) => x - y);
  report.push({
    gid: g.gid, cascade: g.cascade, lod: g.lod, secondary: g.secondary,
    live: g.all.length, bright: brightPool.length, brightCut, p99,
    neighbourCoverage, decCoverage, decCandidates,
    nbr: { l: sort(nbrL), c: sort(nbrC) },
    ctl: { l: sort(ctlL), c: sort(ctlC) },
    dec: { l: sort(decL), c: sort(decC) },
  });
}

console.log(`\nspacing0 ${probes.spacing0}  ·  ${probes.probes.length} live probes with resolved bins\n`);
console.log("group      live  bright  eval | NEIGHBOUR luma err        | CONTROL (random probe)    | chroma err");
console.log("c/lod/sec                     |  p10    p50    p90  <10%  |  p50    <10%              |  p50   <.05");
for (const s of report) {
  const n = s.nbr.l, c = s.ctl.l;
  console.log(
    `  ${s.gid.padEnd(9)}${String(s.live).padStart(5)}${String(s.bright).padStart(8)}${String(s.neighbourCoverage).padStart(6)} | ` +
    `${pctile(n, 0.1).toFixed(3)} ${pctile(n, 0.5).toFixed(3)} ${pctile(n, 0.9).toFixed(3)} ${frac(n, 0.1).toFixed(0).padStart(4)}% | ` +
    `${pctile(c, 0.5).toFixed(3)} ${frac(c, 0.1).toFixed(0).padStart(6)}%              | ` +
    `${pctile(s.nbr.c, 0.5).toFixed(3)} ${frac(s.nbr.c, 0.05).toFixed(0).padStart(4)}%`,
  );
}

// The verdict, on the group holding the most evaluated probes — that is where
// the budget actually is.
const main = report.slice().sort((a, b) => b.neighbourCoverage - a.neighbourCoverage)[0];
if (main) {
  const dec = frac(main.nbr.l, 0.1);
  const shuf = frac(main.ctl.l, 0.1);
  const decCh = frac(main.nbr.c, 0.05);
  const shufCh = frac(main.ctl.c, 0.05);
  console.log(`\nbiggest group ${main.gid} — ${main.neighbourCoverage} bright probes with >=2 neighbours, of ${main.bright} bright / ${main.live} live`);
  console.log(`  relaxed-decimation coverage (second opinion)             : ${main.decCoverage} of ${main.decCandidates} candidates`);
  console.log(`  BRIGHT probes predictable from their neighbours within 10% luma : ${dec.toFixed(1)}%`);
  console.log(`  the same probes predicted from a RANDOM BRIGHT probe            : ${shuf.toFixed(1)}%   <-- matched control`);
  console.log(`  chroma within 0.05                                             : ${decCh.toFixed(1)}%  (control ${shufCh.toFixed(1)}%)`);
  if (main.decCoverage >= 50) {
    console.log(`  relaxed decimation within 10% luma                             : ${frac(main.dec.l, 0.1).toFixed(1)}%`);
  }
  const gap = dec - shuf;
  console.log(
    `\nREDUNDANCY = ${gap.toFixed(1)} points of spatial predictability above chance` +
    ` (neighbour ${dec.toFixed(0)}% vs control ${shuf.toFixed(0)}%).\n` +
    (gap < 10
      ? "  VERDICT: NOT redundant. Neighbours barely beat a random probe, so the lattice is\n" +
        "  already near the density this scene needs and a gradient-driven allocator has little\n" +
        "  to harvest. Spend the effort on TARGETED placement (emitter-anchored probes) and on\n" +
        "  the surface-record side instead.\n"
      : `  VERDICT: REDUNDANT. ${dec.toFixed(0)}% of bright probes carry irradiance their own\n` +
        "  neighbours already predict within 10%, well above the chance rate. Those slots can\n" +
        "  fund finer probes where the error is large — a gradient-driven LOD bias is worth\n" +
        "  building, and this gap is roughly what it can redistribute.\n"),
  );
  if (frac(main.nbr.c, 0.05) < dec - 10) {
    console.log(
      "  ⚠ CHROMA IS HARDER THAN LUMA HERE. Fewer probes are chromatically predictable than\n" +
      "  photometrically, so an error metric built on luminance would rank exactly the\n" +
      "  colour-bleed boundaries as boring. Whatever drives the allocator must be chromatic.\n",
    );
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(OUT, `probe-density-${stamp}.json`);
writeFileSync(file, JSON.stringify({ pose: POSE, bootLine, spacing0: probes.spacing0, report }, null, 2));
console.log(`wrote ${file}`);
