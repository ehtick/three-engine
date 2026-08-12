// STATIC SURFACE ATTRIBUTION ACROSS A LIVE QUALITY SWITCH — plan §12.52.1 (1).
//
// The report: a fresh boot reads `unattributedRate` ~2-3%; flipping the GI
// component's `quality` in a RUNNING editor takes it to 63-96%, and a reload
// heals it. At that rate almost every static hit shades at the palette MEAN
// albedo instead of its own, which is the "weird lighting" the user sees.
//
// ══ WHAT THIS SEPARATES, AND WHY THE RATE ALONE CANNOT ══════════════════════
//
// `attributed = stamp > 0 AND palette.live > 0.5` (srcSurface.js). Exactly two
// halves can go stale and the rate is IDENTICAL for both, so the probe reads
// each half directly, on the GPU, out of the same `bits` buffer the deposit
// reads:
//
//   stampedRecords   surface records whose attribution word is non-zero — the
//                    VOXELIZER's half. Zero ⇒ the field was re-voxelized
//                    without the stamp pass, or never re-voxelized at all.
//   stampedAndLive   of those, how many address a palette slot whose LIVE word
//                    is set — the PALETTE's half. Much smaller than
//                    `stampedRecords` ⇒ the stamps survived and the palette did
//                    not (or they disagree about the numbering).
//   paletteLiveGpu   live entries in the palette region of `bits`.
//   paletteLiveCpu   live entries in `paletteUniform.array`, i.e. what
//                    `srcSurface.sync()` last computed. GPU ≪ CPU ⇒ the palette
//                    pass has not run against this field.
//
// ARMS
//   switch      boot at the scene's own tier, read, then flip quality LIVE
//               (down and back up), reading after each — the reproduction.
//   fresh-high  a separate boot pinned to "high" via `__giConfigOverride`, no
//               flip. THE CONTROL that separates "the switch went stale" from
//               "the lower tier is simply worse at attribution" — without it a
//               tier-dependent record-pool shortfall is indistinguishable from
//               staleness, and the two need opposite fixes.
//
//   node scripts/run-gi-attribution-probe.mjs [url]
// Env: PROJECT=<path>  ARMS=switch,fresh-high  TIERS=high,ultra  HEADED=1
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
// CORNELL=1 generates and uses the same synthetic room every other SRC probe
// runs against — the scene the 63.23% reading was taken on. The real project is
// the default because the report is a report about the user's editor.
let PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
if (process.env.CORNELL) {
  const { makeCornellProject } = await import("./lib/makeCornellProject.mjs");
  PROJECT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-attr")).replaceAll("\\", "/");
  await makeCornellProject(PROJECT, { emitStrength: Number(process.env.EMIT ?? 4) });
}
const ARMS = (process.env.ARMS ?? "switch").split(",").map((s) => s.trim()).filter(Boolean);
/** The live flips, in order, after the fresh read. */
const TIERS = (process.env.TIERS ?? "high,ultra").split(",").map((s) => s.trim()).filter(Boolean);
/** Seconds AFTER the rebuild's `[gi] built` at which each post-switch read is taken. */
const DELAYS = (process.env.DELAYS ?? "0,10,30").split(",").map(Number).filter((n) => Number.isFinite(n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parsePct = (s) => (typeof s === "string" && s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : null);

/**
 * In-page reader. Returns BOTH halves of the attribution predicate plus the
 * deposit's own per-frame tallies.
 *
 * ⚠ The GPU scan is rebuilt on every call, keyed on nothing — a quality change
 * builds a NEW occupancy field with new region offsets, and a cached compute
 * would keep scanning the dead one. That is exactly the class of bug being
 * hunted; the instrument must not have it too.
 */
const READER = async () => {
  const api = globalThis.__editorApi;
  let engine = null;
  const list = await api.call("entity.list", {});
  for (const e of list ?? []) {
    const live = api.entities.live(e.id);
    if (live?.engine?.renderer) { engine = live.engine; break; }
  }
  if (!engine) return { error: "no engine" };
  const sys = engine.modules?.get("gi")?.system;
  const st = sys?.state;
  const src = st?.screen?.srcProbes;
  const field = st?.volume?.occupancyField;
  const attr = field?.surfaceAttribution ?? null;

  const pal = attr?.paletteUniform?.array ?? null;
  let paletteLiveCpu = 0;
  if (pal) for (let i = 1; i < pal.length; i += 2) if (pal[i].w > 0.5) paletteLiveCpu++;

  const assignments = st?.atlas?.assignments ?? [];
  const out = {
    quality: sys?.component?.props?.quality ?? null,
    tier: sys?.config?.quality ?? null,
    hasAttr: !!attr,
    attributed: src?.shading?.attributed ?? null,
    palettePassCount: (src?.passGroups ?? []).find((g) => /surfaces/.test(g.label))?.count ?? 0,
    attrWordOffset: attr?.attrWordOffset ?? null,
    paletteWordOffset: attr?.paletteWordOffset ?? null,
    recordCapacity: attr?.recordCapacity ?? null,
    staticRecordCapacity: attr?.staticRecordCapacity ?? null,
    paletteSlots: attr?.paletteSlots ?? null,
    paletteLiveCpu,
    placements: field?.placements?.length ?? -1,
    seatedSurfaces: assignments.filter((a) => a && a.surface).length,
    atlasRevision: st?.atlas?.revision ?? null,
    atlasSurfaceRevision: st?.atlas?.surfaceRevision ?? null,
    fieldDirty: field?.isDirty ?? null,
    voxelizeDispatches: field?.stats?.dispatches ?? null,
    occupiedVoxels: field?.stats?.occupiedVoxels ?? null,
  };

  // The ENGINE's own pool audit, not a re-derivation: `overflowBricks` is the
  // voxelizer's count of bricks whose record claim was denied, and a denied
  // brick has no records, so no stamp, so every hit in it is unattributed. This
  // is the number that says the pool is the cause rather than the palette.
  try {
    const alloc = await field?.readbackSurfaceAlloc?.(engine.renderer);
    if (alloc) {
      out.recordsClaimed = alloc.allocated;
      out.recordsCapacity = alloc.capacity;
      out.overflowBricks = alloc.overflowBricks;
      out.complexOverflowCells = alloc.complexOverflowCells;
    }
  } catch (e) {
    out.allocError = String(e?.message ?? e).slice(0, 160);
  }

  try {
    const stats = await src?.readStats?.(engine.renderer);
    out.shaded = stats?.rays?.shaded ?? null;
    out.hits = stats?.rays?.hits ?? null;
    out.rays = stats?.rays?.rays ?? null;
    out.unattributed = stats?.rays?.unattributed ?? null;
    out.unattributedRate = stats?.rays?.unattributedRate ?? null;
  } catch (e) {
    out.statsError = String(e?.message ?? e).slice(0, 160);
  }

  if (attr) {
    try {
      const TSL = await import("/node_modules/three/build/three.tsl.js");
      const { Fn, If, atomicAdd, atomicStore, instanceIndex, instancedArray, uint } = TSL;
      const counters = instancedArray(new Uint32Array(4), "uint").toAtomic();
      const N = attr.recordCapacity;
      const P = attr.paletteSlots;
      const clear = Fn(() => { atomicStore(counters.element(instanceIndex), uint(0)); })().compute(4);
      // Guarded on N: `compute(N)` rounds up to the workgroup size, and the
      // overshoot threads would otherwise read (and count) words past the
      // attribution region — i.e. the palette itself.
      const scan = Fn(() => {
        If(instanceIndex.lessThan(uint(N)), () => {
          const stamp = attr.bits.element(uint(attr.attrWordOffset).add(instanceIndex)).toVar();
          If(stamp.greaterThan(uint(0)), () => {
            atomicAdd(counters.element(uint(0)), uint(1));
            const base = uint(attr.paletteWordOffset)
              .add(stamp.sub(uint(1)).mul(uint(attr.paletteWords))).toVar();
            If(attr.bits.element(base.add(uint(7))).greaterThan(uint(0)), () => {
              atomicAdd(counters.element(uint(1)), uint(1));
            });
          });
        });
      })().compute(N);
      const palScan = Fn(() => {
        If(instanceIndex.lessThan(uint(P)), () => {
          const base = uint(attr.paletteWordOffset)
            .add(instanceIndex.mul(uint(attr.paletteWords))).toVar();
          If(attr.bits.element(base.add(uint(7))).greaterThan(uint(0)), () => {
            atomicAdd(counters.element(uint(2)), uint(1));
          });
        });
      })().compute(P);
      // ⚠ THE FIRST DISPATCH OF A FRESH NODE IS SKIPPED, NOT RUN. GISystem
      // installs an async compute-pipeline patch on the DEVICE, so any node
      // whose pipeline is still compiling is silently dropped — and this scan's
      // three nodes are minted per call. The first run of this probe therefore
      // reported `stamps 0, paletteLive 0` on a frame whose own counter said
      // 0.00% unattributed, i.e. the instrument disagreed with itself. Redispatch
      // across frames until the counters move (or the attempts run out) and
      // REPORT the attempt count, so a genuine zero stays distinguishable from a
      // skipped dispatch.
      let w = new Uint32Array(4);
      let attempts = 0;
      for (; attempts < 8; attempts++) {
        engine.renderer.compute(clear);
        engine.renderer.compute(scan);
        engine.renderer.compute(palScan);
        w = new Uint32Array(await engine.renderer.getArrayBufferAsync(counters.value));
        // BOTH, not either: `scan` and `palScan` are separate nodes with
        // separate pipelines, and breaking on the first one to land reported
        // `paletteLive gpu 0` on a frame whose `stamp&live` proved the palette
        // was live. An instrument that stops at the first non-zero answer is
        // reporting whichever pipeline compiled first.
        if (w[0] > 0 && w[2] > 0) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      out.scanAttempts = attempts + 1;
      out.stampedRecords = w[0];
      out.stampedAndLive = w[1];
      out.paletteLiveGpu = w[2];
    } catch (e) {
      out.scanError = String(e?.message ?? e).slice(0, 200);
    }
  }
  return out;
};

const fmtPct = (v) => (v == null ? "  ?  " : `${(v * 100).toFixed(2)}%`);
function line(label, r) {
  if (r?.error) return console.log(`  ${label.padEnd(26)} ERROR ${r.error}`);
  console.log(
    `  ${label.padEnd(26)} unattributed ${fmtPct(r.unattributedRate).padStart(7)}` +
    `  (${r.unattributed}/${r.shaded} shaded)` +
    `   tier ${String(r.tier).padEnd(6)}`,
  );
  console.log(
    `  ${"".padEnd(26)} stamps ${String(r.stampedRecords).padStart(8)}` +
    `  stamp&live ${String(r.stampedAndLive).padStart(8)}` +
    `  paletteLive gpu ${String(r.paletteLiveGpu).padStart(4)} / cpu ${String(r.paletteLiveCpu).padStart(4)}` +
    `  placements ${r.placements}  seated ${r.seatedSurfaces}`,
  );
  console.log(
    `  ${"".padEnd(26)} RECORD POOL ${r.recordsClaimed}/${r.recordsCapacity} claimed,` +
    ` ${r.overflowBricks} bricks DENIED` +
    `  (occupied voxels ${r.occupiedVoxels})`,
  );
  console.log(
    `  ${"".padEnd(26)} recordCap ${r.recordCapacity} (static ${r.staticRecordCapacity})` +
    `  attrWord ${r.attrWordOffset}  palWord ${r.paletteWordOffset}` +
    `  palettePasses ${r.palettePassCount}` +
    (r.scanError ? `  SCAN ERROR ${r.scanError}` : "") +
    (r.statsError ? `  STATS ERROR ${r.statsError}` : ""),
  );
}

async function boot({ globals = {} } = {}) {
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
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  const marks = { built: 0, wave: 0 };
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) marks.built++;
    if (/compile wave: materials \d+ms/.test(t)) marks.wave++;
    if (/\[gi\] (built|field ready|field first pass|src probes|SHADING|surface records)/.test(t)) {
      console.log(`    ${t.slice(0, 165)}`);
    }
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`    pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((P, G) => {
    localStorage.setItem("engine.projectRoot.v1", P);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
    globalThis.__editorKeepRendering = true;
    for (const [k, v] of Object.entries(G)) globalThis[k] = v;
  }, PROJECT, globals);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 240000 });
  return { browser, page, marks };
}

/**
 * Read once the frame is actually producing shaded hits. A read taken during a
 * compile wave sees skipped dispatches and reports zeros, which is
 * indistinguishable from a real failure — so poll for `shaded > 0` first and
 * take the LAST of three consecutive reads.
 */
async function settledRead(page, label, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let r = null;
  while (Date.now() < deadline) {
    r = await page.evaluate(READER);
    if (r && !r.error && (r.shaded ?? 0) > 0) break;
    await wait(2000);
  }
  await wait(3000);
  r = await page.evaluate(READER);
  line(label, r);
  return r;
}

async function armSwitch() {
  console.log("\n══ ARM switch — boot at the scene's own tier, then flip quality LIVE ══");
  const { browser, page, marks } = await boot();
  const results = [];
  // The compile wave, then a real settle — the field's first frames are cold.
  for (let i = 0; i < 200 && marks.wave === 0; i++) await wait(1000);
  await wait(12000);
  await page.evaluate(() => globalThis.__editorApi.call("viewport.freezeWhenUnfocused", { enabled: false })).catch(() => {});

  const first = await settledRead(page, "fresh boot");
  results.push({ step: `fresh (${first.tier})`, ...first });

  const giId = await page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const list = await api.call("entity.list", {});
    for (const e of list ?? []) {
      const live = api.entities.live(e.id);
      if (live?.components?.has?.("global-illumination")) return e.id;
    }
    return null;
  });
  if (!giId) {
    console.log("  FAIL: no entity carries a global-illumination component");
    await browser.close();
    return results;
  }

  for (const tier of TIERS) {
    const before = marks.built;
    console.log(`\n  ── live switch → "${tier}" ──`);
    await page.evaluate(async ({ id, value }) => {
      await globalThis.__editorApi.call("component.setProp", {
        id, type: "global-illumination", key: "quality", value,
      });
    }, { id: giId, value: tier });
    // The rebuild is queued and runs when the compile wave allows it.
    for (let i = 0; i < 240 && marks.built === before; i++) await wait(1000);
    if (marks.built === before) console.log("    (no new \"[gi] built\" — the switch did not rebuild)");
    // ── A TIME COURSE, NOT ONE SETTLED READ ─────────────────────────────────
    //
    // "A reload heals it" is a claim about a state that PERSISTS; a cold window
    // right after the rebuild would look identical in a single late read and
    // needs the opposite fix. Sampling the same counters at four delays is what
    // separates "never recovers" from "recovers in N seconds", and the first
    // version of this probe read only at +15s and reported a clean 0.00%.
    const tBuilt = Date.now();
    for (const delay of DELAYS) {
      while (Date.now() - tBuilt < delay * 1000) await wait(500);
      const at = Math.round((Date.now() - tBuilt) / 1000);
      const r = await settledRead(page, `switch→${tier} +${at}s`, { timeoutMs: 45000 });
      results.push({ step: `switch→${tier} +${at}s`, ...r });
    }
    // The op the finding was originally read through — it dispatches the chain
    // ITSELF (rep-major, 8 reps) rather than reading the frame loop's last
    // tallies, so it can disagree with the reads above. If it does, the
    // instrument is the finding.
    const op = await page.evaluate(() => globalThis.__editorApi.call("profile.giPasses", { samples: 8 }))
      .catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
    console.log(`    profile.giPasses → unattributedRate ${op?.srcProbes?.unattributedRate ?? op?.error ?? "?"}` +
      `  shaded ${op?.srcProbes?.shadedHitsPerFrame ?? "?"}`);
    results.push({ step: `switch→${tier} giPasses`, unattributedRate: parsePct(op?.srcProbes?.unattributedRate) });
  }
  await browser.close();
  return results;
}

async function armFresh(tier) {
  console.log(`\n══ ARM fresh-${tier} — a separate boot pinned to "${tier}", no flip (THE CONTROL) ══`);
  // FLAGS is the R12 hatch, verbatim from `probe:gi-boot`: page globals set
  // before any engine code runs, so a gate can be flipped WITHOUT a code change
  // (e.g. `FLAGS={"__giRayHitMode":"hybrid-plane"}` isolates the exact-complex
  // trace's contribution to the unattributed rate).
  let flags = {};
  try { flags = process.env.FLAGS ? JSON.parse(process.env.FLAGS) : {}; } catch { /* not JSON */ }
  if (Object.keys(flags).length) console.log(`  flags: ${JSON.stringify(flags)}`);
  const { browser, page, marks } = await boot({
    globals: { __giConfigOverride: { quality: tier }, ...flags },
  });
  for (let i = 0; i < 200 && marks.wave === 0; i++) await wait(1000);
  await wait(12000);
  await page.evaluate(() => globalThis.__editorApi.call("viewport.freezeWhenUnfocused", { enabled: false })).catch(() => {});
  const r = await settledRead(page, `fresh boot @ ${tier}`);
  await browser.close();
  return [{ step: `fresh-${tier}`, ...r }];
}

const all = [];
for (const arm of ARMS) {
  if (arm === "switch") all.push(...(await armSwitch()));
  else if (arm.startsWith("fresh-")) all.push(...(await armFresh(arm.slice(6))));
  else console.log(`  unknown arm "${arm}"`);
}

console.log(`\n${"═".repeat(76)}\n  SUMMARY\n${"═".repeat(76)}`);
console.log(`  ${"step".padEnd(20)} ${"unattr".padStart(8)} ${"stamps".padStart(10)} ${"stamp&live".padStart(11)} ${"palGpu".padStart(7)} ${"palCpu".padStart(7)}`);
for (const r of all) {
  console.log(
    `  ${String(r.step).padEnd(20)} ${fmtPct(r.unattributedRate).padStart(8)} ` +
    `${String(r.stampedRecords ?? "?").padStart(10)} ${String(r.stampedAndLive ?? "?").padStart(11)} ` +
    `${String(r.paletteLiveGpu ?? "?").padStart(7)} ${String(r.paletteLiveCpu ?? "?").padStart(7)}`,
  );
}
console.log("\ngi-attribution: measured (diagnostic probe — the table above is the deliverable)");
process.exit(0);
