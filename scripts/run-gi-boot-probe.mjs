// GI BOOT PROBE — R18's instrument. Plan §13.5.
//
// The requirement is "GI initialization ≤ 1 second to first correct frame".
// §13.2 measured the current figure at 45-90 s on the user's Sponza and found
// ~98% of it in the WGSL compiler — but with ONE number for the whole compile
// wave, so "which kernel costs the 40 seconds" was unanswerable. This answers
// it, and separates the question everything else is conditional on: COLD vs
// WARM.
//
// ══ HOW IT MEASURES, AND WHY IT TOUCHES NO ENGINE CODE ══════════════════════
//
// It patches `GPUDevice.prototype` in the page before any script runs
// (`evaluateOnNewDocument`), recording every shader module's WGSL size and every
// pipeline creation's wall time. That is a pure observer: no GISystem edit, no
// instrumentation to leave behind, and it sees BOTH backends and every pipeline
// regardless of which list the engine keeps it in — `[gi] compute kernels` only
// counts `state.queue`, which is why its 5 kernels do not explain a 3-pipeline
// 86-second wave.
//
// GISystem's own `installAsyncComputePipelines` patches the device INSTANCE and
// calls `device.createComputePipelineAsync(...)`, which resolves to this
// prototype patch — so the interception composes rather than fighting.
//
// ══ COLD VS WARM ════════════════════════════════════════════════════════════
//
// Chrome's compiled-shader disk cache lives in the browser profile. COLD wipes
// the profile directory; WARM relaunches against the same one. §13.4 makes this
// item 1 because it decides which lever matters at all: if WARM is already
// sub-second, this is a developer-iteration problem needing a shipped cache, not
// a kernel diet.
//
// Both arms run the SAME project and scene as `run-gi-game-perf-probe`, so
// startup and steady-state numbers are comparable within one session (R15).
//
// Run:  node scripts/run-gi-boot-probe.mjs [baseUrl]
// Env:  PROJECT=<path>   ARMS=cold,warm   HEADED=1   TIMEOUT=<seconds>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const ARMS = (process.env.ARMS ?? "cold,warm").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = (Number(process.env.TIMEOUT) || 300) * 1000;
/** R18's budget, in ms. Not a pass bar for this script — a reference line. */
const BUDGET_MS = 1000;

const PROFILE_DIR = path.join(os.tmpdir(), "gi-boot-probe-profile");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (v) => `${Math.round(v)}ms`;

/**
 * Installed before any page script. Patches the PROTOTYPE, so it is in place
 * before a device exists — there is no ordering race with the renderer.
 */
function pageHook() {
  // A page without WebGPU has no `GPUDevice`, and a ReferenceError at document
  // start would take the whole editor down rather than skipping the probe.
  if (typeof GPUDevice === "undefined") return;
  const rec = { pipelines: [], t0: performance.now() };
  const bytesOf = new WeakMap();
  globalThis.__giBootProbe = rec;

  const rawModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = rawModule.call(this, desc);
    try {
      const code = desc?.code ?? "";
      // Every GI pipeline label is `computePipeline_compute`, so the WGSL
      // itself is the only way to NAME the kernel that costs the time. Entry
      // points and struct names live in the first few hundred characters.
      bytesOf.set(mod, {
        bytes: code.length,
        label: desc?.label ?? "",
        head: code.slice(0, 220).replace(/\s+/g, " "),
        fns: (code.match(/fn\s+([A-Za-z0-9_]+)/g) ?? []).slice(0, 8).join(","),
        loops: code.split("loop {").length - 1,
        branches: code.split("if (").length - 1,
        // The SOURCE, kept so the slow kernel can be lifted out of the editor
        // and compiled on its own. A cold boot costs 2-5 minutes and the same
        // kernel has measured 47s, 109s, 132s, 182s and 238s depending on what
        // else the machine was doing — that is not an instrument you can bisect
        // a compiler pathology with. One WGSL string in a bare page is.
        code,
      });
    } catch { /* frozen */ }
    return mod;
  };

  const moduleOf = (kind, desc) => (kind === "ComputePipeline" ? desc?.compute?.module : desc?.vertex?.module);
  for (const kind of ["ComputePipeline", "RenderPipeline"]) {
    for (const suffix of ["", "Async"]) {
      const name = `create${kind}${suffix}`;
      const raw = GPUDevice.prototype[name];
      if (typeof raw !== "function") continue;
      GPUDevice.prototype[name] = function (desc) {
        const start = performance.now();
        const info = bytesOf.get(moduleOf(kind, desc));
        const entry = {
          kind: kind === "ComputePipeline" ? "compute" : "render",
          async: suffix === "Async",
          // A pipeline label is often empty; the shader module's is not.
          label: desc?.label || info?.label || "(unlabelled)",
          bytes: info?.bytes ?? 0,
          head: info?.head ?? "",
          fns: info?.fns ?? "",
          loops: info?.loops ?? 0,
          branches: info?.branches ?? 0,
          at: start - rec.t0,
          ms: 0,
        };
        // Held on the record, NOT on the entry: `rec.pipelines` is serialised
        // back to node in one go, and 75 kernels of source would make every
        // read of the summary move megabytes. The dump fetches one by id.
        //
        // ⚠ Keyed by a COUNTER, not by `rec.pipelines.length`. Entries are
        // pushed on COMPLETION and async compiles finish out of order, so the
        // array length at creation time is not this entry's final index — it
        // would hand back another kernel's source, which is the worst possible
        // failure for an instrument whose whole job is naming the right one.
        rec.sources ??= new Map();
        entry.id = rec.nextId = (rec.nextId ?? 0) + 1;
        rec.sources.set(entry.id, info?.code ?? "");
        if (suffix !== "Async") {
          const out = raw.call(this, desc);
          entry.ms = performance.now() - start;
          rec.pipelines.push(entry);
          return out;
        }
        return raw.call(this, desc).then(
          (v) => { entry.ms = performance.now() - start; rec.pipelines.push(entry); return v; },
          (e) => { entry.ms = performance.now() - start; entry.error = String(e?.message ?? e); rec.pipelines.push(entry); throw e; },
        );
      };
    }
  }
}

/** Numbers the engine already prints, harvested rather than re-derived. */
const STAGE_PATTERNS = [
  ["voxelize (CPU)", /occupancy backend:.*?\((\d+)ms CPU\)/],
  ["static shadow BVH", /static shadow bvh:.*?built in (\d+)ms/],
  ["GI setup (bounds/slots/lights)", /\[gi\] built.*?setup (\d+)ms/],
  ["material compile wave", /compile wave: materials (?:warmed safely in )?(\d+)ms/],
  ["compute pipeline compile", /compile wave: materials \d+ms, computes (\d+)ms/],
  ["first frame after wave", /first frame after compile wave took (\d+)ms/],
];

async function runArm(arm) {
  const cold = arm === "cold";
  if (cold) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    userDataDir: PROFILE_DIR,
    args: [
      "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await installTauriShim(page, {});

  const lines = [];
  const marks = {};
  let waveDone = false;
  let firstFrame = false;
  page.on("console", (m) => {
    const t = m.text();
    if (!/\[gi\]/.test(t)) return;
    const at = Date.now();
    lines.push({ at, t });
    if (/compile wave started/.test(t)) marks.waveStart = at;
    if (/compile wave: materials \d+ms, computes \d+ms/.test(t)) { marks.waveDone = at; waveDone = true; }
    if (/first frame after compile wave/.test(t)) { marks.firstFrame = at; firstFrame = true; }
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) lines.push({ at: Date.now(), t: `pageerror: ${msg.slice(0, 160)}` });
  });

  await page.evaluateOnNewDocument(pageHook);
  // SRC must be set before the GI module builds, and it changes what this probe
  // is measuring: the user's editor boots with SRC ON and 44 of its 45 kernels
  // are SRC's, so a probe run without it is measuring a different program than
  // the one whose startup is being complained about.
  // FLAGS is a JSON object of page globals set before any engine code runs, so
  // a startup A/B can turn a feature off WITHOUT a code change (R12). The whole
  // startup hunt has been "which object costs the two minutes", and every
  // answer so far has been a kernel compiled for a feature the scene does not
  // use — that hypothesis is only testable if arbitrary gates can be flipped
  // from outside.
  let FLAGS = {};
  try {
    FLAGS = process.env.FLAGS ? JSON.parse(process.env.FLAGS) : {};
  } catch (e) {
    console.log(`  FLAGS is not valid JSON, ignoring: ${e.message}`);
  }
  await page.evaluateOnNewDocument((project, src, flags) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (src) globalThis.__giSrcProbes = true;
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, PROJECT, process.env.SRC === "1", FLAGS);
  if (Object.keys(FLAGS).length) console.log(`  flags: ${JSON.stringify(FLAGS)}`);

  const tOpen = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  marks.projectOpen = Date.now();
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !waveDone) await wait(500);
  // The resume recompile lands a frame or so after the wave; give it room but
  // do not hang the probe if it never fires.
  const frameDeadline = Date.now() + 20000;
  while (Date.now() < frameDeadline && !firstFrame) await wait(250);
  // Let any straggling async pipeline resolve into the record.
  await wait(2000);

  const pipelines = await page.evaluate(() => globalThis.__giBootProbe?.pipelines ?? []);
  // ── LIFT THE SLOW KERNEL OUT OF THE EDITOR ────────────────────────────────
  //
  // Fetched by id BEFORE the browser closes, and only the one asked for. With
  // the WGSL on disk, `probe:wgsl-compile` can time this exact shader in a bare
  // page in seconds — which is the difference between bisecting a compiler
  // pathology and guessing at it, given the same kernel has measured anywhere
  // from 47s to 238s depending on machine load.
  if (process.env.DUMP) {
    const worst = pipelines.reduce((a, p) => (p.ms > (a?.ms ?? -1) ? p : a), null);
    if (worst?.id != null) {
      const code = await page.evaluate((id) => globalThis.__giBootProbe?.sources?.get(id) ?? "", worst.id);
      if (code) {
        const out = path.resolve(process.env.DUMP);
        fs.writeFileSync(out, code, "utf8");
        console.log(`\n  dumped slowest kernel (${Math.round(code.length / 1024)}kB) → ${out}`);
      } else {
        console.log(`\n  DUMP: no source recorded for pipeline id ${worst.id}`);
      }
    }
  }
  await browser.close();

  const stages = {};
  for (const [name, re] of STAGE_PATTERNS) {
    for (const { t } of lines) {
      const m = t.match(re);
      if (m) stages[name] = Number(m[1]);
    }
  }
  const end = marks.firstFrame ?? marks.waveDone ?? Date.now();

  // ══ THE START OF GI INIT IS THE START OF ITS BURST, NOT THE FIRST `[gi]`
  //    LINE ANYWHERE ═══════════════════════════════════════════════════════
  //
  // The first version anchored t0 on the first `[gi]` console line of the whole
  // session and read ~50 s even on a run where every pipeline compiled in under
  // 550 ms. It was measuring dead time: opening a project emits an unrelated GI
  // line early (a browser-preview build's BVH rebuild), and the editor then
  // spends tens of seconds on assets and the scene before GI starts at all.
  //
  // So anchor on `compile wave started` and walk BACKWARDS through contiguous
  // `[gi]` lines — the voxelize, the BVH and the setup that genuinely belong to
  // this initialization — stopping at the first gap longer than GAP_MS. A burst
  // is what a person perceives as "GI is starting up".
  const GAP_MS = 5000;
  const anchor = lines.findIndex((l) => /compile wave started/.test(l.t));
  let startIdx = anchor < 0 ? 0 : anchor;
  while (startIdx > 0 && lines[startIdx].at - lines[startIdx - 1].at < GAP_MS) startIdx--;
  const burstStart = lines[startIdx]?.at ?? null;

  return {
    arm,
    timedOut: !waveDone,
    pipelines,
    stages,
    lines,
    ttff: burstStart != null ? end - burstStart : null,
    // Kept so a contaminated reading is recognizable rather than invisible.
    sessionSpan: lines.length ? end - lines[0].at : null,
    openToEnd: end - tOpen,
  };
}

function report(r) {
  const compute = r.pipelines.filter((p) => p.kind === "compute");
  const render = r.pipelines.filter((p) => p.kind === "render");
  const sum = (a) => a.reduce((s, p) => s + p.ms, 0);
  console.log(`\n${"═".repeat(78)}\n  ARM: ${r.arm.toUpperCase()}${r.timedOut ? "  ⚠ TIMED OUT before the compile wave finished" : ""}\n${"═".repeat(78)}`);

  console.log("\n  ── STAGES, as the engine reports them ──");
  for (const [name] of STAGE_PATTERNS) {
    const v = r.stages[name];
    console.log(`    ${name.padEnd(34)} ${v == null ? "(not reported)" : ms(v).padStart(9)}`);
  }
  console.log(`    ${"TIME TO FIRST CORRECT FRAME".padEnd(34)} ${(r.ttff == null ? "?" : ms(r.ttff)).padStart(9)}` +
    `   ${r.ttff == null ? "" : r.ttff <= BUDGET_MS ? "✓ within R18's 1s" : `✗ ${(r.ttff / BUDGET_MS).toFixed(1)}× over R18's 1s budget`}`);
  console.log(`    ${"(whole session's [gi] span)".padEnd(34)} ${(r.sessionSpan == null ? "?" : ms(r.sessionSpan)).padStart(9)}` +
    `   ${r.sessionSpan && r.ttff && r.sessionSpan > r.ttff * 1.5 ? "← includes pre-GI dead time; NOT the budget" : ""}`);

  console.log(`\n  ── PIPELINES: ${compute.length} compute (${ms(sum(compute))}), ${render.length} render (${ms(sum(render))}) ──`);
  const top = [...r.pipelines].sort((a, b) => b.ms - a.ms).slice(0, 14);
  console.log(`    ${"ms".padStart(8)} ${"WGSL".padStart(8)}  ${"kind".padEnd(8)} label`);
  for (const p of top) {
    console.log(`    ${Math.round(p.ms).toString().padStart(8)} ${(p.bytes ? `${Math.round(p.bytes / 1024)}kB` : "?").padStart(8)}  ` +
      `${(p.async ? `${p.kind}*` : p.kind).padEnd(8)} ${String(p.label).slice(0, 44)}${p.error ? `  ERROR ${p.error.slice(0, 40)}` : ""}`);
  }
  if (r.pipelines.length > top.length) console.log(`    … ${r.pipelines.length - top.length} more`);

  // ⚠ THE SUM IS NOT WALL TIME. These compiles are async and overlap, so their
  // sum EXCEEDS TTFF — which is itself the proof that they run concurrently.
  // The number that bounds startup is the SLOWEST SINGLE pipeline; reporting
  // the sum as a budget is how "149% of TTFF" gets read as a real cost.
  const compileTotal = sum(r.pipelines);
  const slowest = r.pipelines.reduce((a, p) => (p.ms > (a?.ms ?? -1) ? p : a), null);
  const cpu = (r.stages["voxelize (CPU)"] ?? 0) + (r.stages["static shadow BVH"] ?? 0)
    + (r.stages["GI setup (bounds/slots/lights)"] ?? 0);
  if (r.ttff) {
    console.log(`\n  ── THE SPLIT (compiles OVERLAP — the sum is not wall time) ──`);
    console.log(`    slowest SINGLE pipeline ${ms(slowest?.ms ?? 0).padStart(9)}  ` +
      `${((slowest?.ms ?? 0) / r.ttff * 100).toFixed(1)}% of TTFF  ← the wall-clock floor`);
    console.log(`    all pipelines, summed   ${ms(compileTotal).padStart(9)}  ` +
      `${(compileTotal / r.ttff * 100).toFixed(0)}% of TTFF  (>100% ⇒ concurrent)`);
    console.log(`    GI CPU work             ${ms(cpu).padStart(9)}  ${(cpu / r.ttff * 100).toFixed(1)}% of TTFF`);
  }
  // ══ WHERE THE WALL CLOCK ACTUALLY GOES ═══════════════════════════════════
  //
  // The decisive instrument, and the one whose absence let "~98% is the WGSL
  // compiler" stand on an aggregate log line. If every pipeline is created at
  // roughly the same moment and the wave is long, the cost is DRIVER COMPILE.
  // If creations are spread thinly across the wave, the cost is whatever runs
  // BETWEEN them — TSL node-graph building and WGSL text generation, which is
  // JS, happens every run, and no shader cache can touch.
  if (r.pipelines.length > 1) {
    const byStart = [...r.pipelines].sort((a, b) => a.at - b.at);
    const first = byStart[0].at;
    const last = Math.max(...byStart.map((p) => p.at + p.ms));
    let biggestGap = 0;
    let gapAt = 0;
    for (let i = 1; i < byStart.length; i++) {
      const gap = byStart[i].at - byStart[i - 1].at;
      if (gap > biggestGap) { biggestGap = gap; gapAt = byStart[i - 1].at; }
    }
    // Union of the intervals each pipeline was actually compiling for.
    const merged = [];
    for (const p of byStart) {
      const seg = [p.at, p.at + p.ms];
      const tail = merged[merged.length - 1];
      if (tail && seg[0] <= tail[1]) tail[1] = Math.max(tail[1], seg[1]);
      else merged.push(seg);
    }
    const busy = merged.reduce((s, [a, b]) => s + (b - a), 0);
    const span = last - first;
    console.log(`\n  ── THE TIMELINE (is the wall clock IN the compiler, or between compiles?) ──`);
    console.log(`    first creation → last completion  ${ms(span).padStart(9)}`);
    console.log(`    of which SOME pipeline was busy   ${ms(busy).padStart(9)}  ${(busy / Math.max(span, 1) * 100).toFixed(0)}%`);
    console.log(`    idle between compiles             ${ms(span - busy).padStart(9)}  ${((span - busy) / Math.max(span, 1) * 100).toFixed(0)}%` +
      `   ← TSL node-graph build + WGSL generation (JS; no shader cache touches it)`);
    console.log(`    largest single gap                ${ms(biggestGap).padStart(9)}  at t+${ms(gapAt)}`);
  }
  if (slowest) {
    console.log(`\n  ── SLOWEST SINGLE PIPELINE ──`);
    console.log(`    ${ms(slowest.ms)}, ${Math.round(slowest.bytes / 1024)}kB WGSL, ` +
      `${slowest.loops} loops, ${slowest.branches} ifs`);
    console.log(`    fns:  ${slowest.fns}`);
    console.log(`    head: ${String(slowest.head).slice(0, 200)}`);
    // Size is NOT the explanation if a BIGGER kernel compiles faster — and on
    // this scene one does, by a factor that rules the hypothesis out entirely.
    const bigger = r.pipelines.filter((p) => p.bytes > slowest.bytes).sort((a, b) => b.bytes - a.bytes)[0];
    if (bigger) {
      console.log(`\n    ⚠ A BIGGER KERNEL COMPILES FASTER: ${Math.round(bigger.bytes / 1024)}kB in ${ms(bigger.ms)} ` +
        `— ${(slowest.ms / bigger.ms).toFixed(0)}× faster at ${(bigger.bytes / slowest.bytes).toFixed(1)}× the size.`);
      console.log(`      So this is a COMPILER PATHOLOGY in ONE kernel, not "too much code".`);
      console.log(`      loops/ifs: slowest ${slowest.loops}/${slowest.branches}, bigger ${bigger.loops}/${bigger.branches}.`);
    }
  }
  return { compute, render, compileTotal, cpu, slowest };
}

console.log(`gi-boot-probe: ${ARMS.join(" then ")} on ${PROJECT}`);
console.log(`  R18 budget ${BUDGET_MS}ms to first correct frame — plan §13`);
const results = [];
for (const arm of ARMS) {
  try {
    const r = await runArm(arm);
    results.push({ ...r, summary: report(r) });
  } catch (err) {
    console.error(`\ngi-boot-probe: arm "${arm}" FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}

if (results.length === 2) {
  const [a, b] = results;
  console.log(`\n${"═".repeat(78)}\n  THE ANSWER §13.4 ITEM 1 ASKS FOR: COLD vs WARM\n${"═".repeat(78)}`);
  const fmt = (r) => `${r.arm.padEnd(5)} TTFF ${(r.ttff == null ? "?" : ms(r.ttff)).padStart(9)}   slowest pipeline ${ms(r.summary.slowest?.ms ?? 0).padStart(9)}`;
  console.log(`    ${fmt(a)}\n    ${fmt(b)}`);
  if (a.ttff && b.ttff) {
    const speedup = a.ttff / b.ttff;
    console.log(`\n    warm is ${speedup.toFixed(1)}× faster.`);
    const pipeGain = (a.summary.slowest?.ms ?? 0) / Math.max(b.summary.slowest?.ms ?? 1, 1);
    console.log(`    the slowest pipeline itself got ${pipeGain.toFixed(0)}× faster warm.`);
    if (b.ttff <= BUDGET_MS) {
      console.log(`    → WARM ALREADY MEETS R18. The lever is a SHIPPED/PRESERVED shader cache.`);
    } else if (pipeGain > 5 && speedup < 1.5) {
      // The case this probe actually found, and the one an aggregate log hides.
      console.log(`    → ⚠ THE CACHE WORKS AND IT DOES NOT MATTER. Pipeline compilation collapsed`);
      console.log(`      ${pipeGain.toFixed(0)}× while TTFF moved ${((speedup - 1) * 100).toFixed(0)}% — so pipeline compilation is NOT what`);
      console.log(`      startup is made of. See the TIMELINE section: the wall clock is the`);
      console.log(`      idle BETWEEN compiles (TSL node-graph build + WGSL generation, in JS,`);
      console.log(`      every run). Neither a shader cache nor a kernel diet addresses that.`);
    } else if (speedup < 1.5) {
      console.log(`    → The cache is not the lever and pipelines did not speed up either —`);
      console.log(`      the cost is elsewhere. Read the TIMELINE section before choosing a fix.`);
    } else {
      console.log(`    → The cache helps but does not close the budget. Both levers are live.`);
    }
  }
}
console.log("");
