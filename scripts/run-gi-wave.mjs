// COMPILE-WAVE PROFILER: where do the GI "materials preparation" seconds go?
// Boots the real project (same recipe as run-gi-boot.mjs), but first wraps the
// WebGPU device's pipeline/shader-module creation at document start so every
// driver compile is timed and labeled. Prints a phase timeline from the [gi]
// logs plus a per-kind cost breakdown and the top offenders.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-wave.mjs
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // The harness window sits BEHIND whatever the user is doing, and Chrome
    // throttles occluded windows' timers to ~1/s — which turned every
    // wave-yield and async-pipeline delivery into seconds of fake wait and
    // poisoned three profiling sessions before the long-task census caught
    // it (submits 122ms total while "yields waited 61s"). The user's real
    // editor is foreground; these flags model that.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // DXC=1 forces Dawn's modern shader compiler (vs FXC) — A/B hatch.
    ...(process.env.DXC ? ["--enable-dawn-features=use_dxc"] : []),
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});

// ── page-level GPU instrumentation, installed before any script runs ──
await page.evaluateOnNewDocument(() => {
  const prof = (globalThis.__pipeProf = []);
  const mark = (globalThis.__pipeMark = []);
  const wrapAsync = (proto, fn, kind) => {
    const orig = proto[fn];
    if (!orig) return;
    proto[fn] = function (desc) {
      // three reuses one module-level descriptor object and mutates its
      // label per call — capture it NOW, not at promise resolution.
      const label = desc?.label ?? "";
      const start = performance.now();
      const p = orig.call(this, desc);
      p.then(
        () => prof.push({ kind, label, start, ms: performance.now() - start, async: 1 }),
        () => prof.push({ kind, label: label + " (REJECTED)", start, ms: performance.now() - start, async: 1 }),
      );
      return p;
    };
  };
  const wrapSync = (proto, fn, kind, sizeOf) => {
    const orig = proto[fn];
    if (!orig) return;
    proto[fn] = function (desc) {
      const start = performance.now();
      const r = orig.call(this, desc);
      prof.push({ kind, label: desc?.label ?? "", start, ms: performance.now() - start, async: 0, size: sizeOf?.(desc) });
      return r;
    };
  };
  // Main-thread stall census: long tasks + synchronous time inside
  // queue.submit (GPU-process backpressure shows up HERE as a blocking call).
  globalThis.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= 200) globalThis.__longTasks.push({ start: e.startTime, ms: e.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  globalThis.__submitProf = { count: 0, sum: 0, max: 0, slow: [] };
  const patchSubmit = () => {
    if (!globalThis.GPUQueue) return;
    const origSubmit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (buffers) {
      const t0 = performance.now();
      const r = origSubmit.call(this, buffers);
      const ms = performance.now() - t0;
      const p = globalThis.__submitProf;
      p.count++;
      p.sum += ms;
      if (ms > p.max) p.max = ms;
      if (ms > 100) p.slow.push({ start: t0, ms });
      return r;
    };
  };
  patchSubmit();
  if (globalThis.GPUDevice) {
    wrapAsync(GPUDevice.prototype, "createRenderPipelineAsync", "renderAsync");
    wrapAsync(GPUDevice.prototype, "createComputePipelineAsync", "computeAsync");
    wrapSync(GPUDevice.prototype, "createRenderPipeline", "renderSync");
    wrapSync(GPUDevice.prototype, "createComputePipeline", "computeSync");
    wrapSync(GPUDevice.prototype, "createShaderModule", "module", (d) => d?.code?.length ?? 0);
    // Big modules keep an identity trail: their WGSL variable names reveal
    // which system built them (uniform/texture names survive TSL codegen).
    const origModule = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
      if (desc?.code?.length > 100_000) {
        const names = [...new Set(desc.code.match(/[A-Za-z_]*(?:gi|GI|ssgi|SSGI|ssr|bloom|Bloom|cascade|occup|probe|radiance|particle|Particle)[A-Za-z_]*/g) ?? [])].slice(0, 12);
        (globalThis.__bigModules ??= []).push({ size: desc.code.length, at: performance.now(), names, head: desc.code.slice(0, 160) });
      }
      // Ground-truth corpus: keep every compute kernel's full WGSL so a
      // standalone bench can time its compile on an idle device.
      if (desc?.code?.length > 5_000 && /@compute/.test(desc.code)) {
        (globalThis.__wgslDump ??= []).push(desc.code);
      }
      return origModule.call(this, desc);
    };
  }
});

let waveDone = false;
let built = false;
let failed = null;
const t0 = Date.now();
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) console.log(`  +${((Date.now() - t0) / 1000).toFixed(1)}s ${t.slice(0, 240)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (/compile wave: materials \d+ms, computes/.test(t)) waveDone = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 250)}`);
});
page.on("pageerror", (e) => {
  failed = e.message;
  console.log(`  PAGEERROR: ${(e.stack ?? e.message).slice(0, 400)}`);
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate(() => document.querySelector(".hub-recent-open-btn")?.click());
console.log(`opening ${PROJECT} …`);

for (let i = 0; i < 180 && !waveDone && !failed; i++) await wait(1000);
await wait(6000); // let the resume diagnostic + any post-wave compiles land

const dump = await page.evaluate(() => {
  const prof = globalThis.__pipeProf ?? [];
  const byKind = {};
  for (const e of prof) {
    const k = (byKind[e.kind] ??= { count: 0, sum: 0, max: 0 });
    k.count++;
    k.sum += e.ms;
    k.max = Math.max(k.max, e.ms);
  }
  const top = [...prof].sort((a, b) => b.ms - a.ms).slice(0, 20);
  // overlap check for async render compiles: wall window vs summed durations
  const ra = prof.filter((e) => e.kind === "renderAsync");
  const wall = ra.length ? Math.max(...ra.map((e) => e.start + e.ms)) - Math.min(...ra.map((e) => e.start)) : 0;
  const modBytes = prof.filter((e) => e.kind === "module").reduce((s, e) => s + (e.size ?? 0), 0);
  return { byKind, top, raSum: ra.reduce((s, e) => s + e.ms, 0), raWall: wall, modBytes, total: prof.length };
});

console.log(`\n── GPU compile profile (${dump.total} calls) ──`);
for (const [kind, s] of Object.entries(dump.byKind)) {
  console.log(`  ${kind.padEnd(13)} count ${String(s.count).padStart(4)}  sum ${s.sum.toFixed(0).padStart(7)}ms  max ${s.max.toFixed(0).padStart(6)}ms`);
}
console.log(`  renderAsync overlap: summed ${dump.raSum.toFixed(0)}ms inside a ${dump.raWall.toFixed(0)}ms wall window`);
console.log(`  shader-module source total: ${(dump.modBytes / 1024).toFixed(0)} kB`);
console.log(`\n── top 20 slowest GPU calls ──`);
for (const e of dump.top) {
  console.log(`  ${e.ms.toFixed(0).padStart(6)}ms  +${(e.start / 1000).toFixed(1)}s  ${e.kind.padEnd(12)} ${String(e.label).slice(0, 90)}${e.size ? ` (${(e.size / 1024).toFixed(0)}kB)` : ""}`);
}

const stalls = await page.evaluate(() => ({
  longTasks: (globalThis.__longTasks ?? []).sort((a, b) => b.ms - a.ms).slice(0, 12),
  submit: {
    ...globalThis.__submitProf,
    slow: (globalThis.__submitProf?.slow ?? []).sort((a, b) => b.ms - a.ms).slice(0, 12),
  },
}));
console.log(`\n── main-thread stalls ──`);
console.log(`  queue.submit: ${stalls.submit.count} calls, ${stalls.submit.sum?.toFixed(0)}ms total sync, max ${stalls.submit.max?.toFixed(0)}ms`);
for (const s of stalls.submit.slow) console.log(`    slow submit ${s.ms.toFixed(0)}ms at +${(s.start / 1000).toFixed(1)}s`);
console.log(`  long tasks ≥200ms: ${stalls.longTasks.length ? "" : "none"}`);
for (const t of stalls.longTasks) console.log(`    ${t.ms.toFixed(0)}ms at +${(t.start / 1000).toFixed(1)}s`);

const bigModules = await page.evaluate(() => globalThis.__bigModules ?? []);
console.log(`\n── modules over 100kB (${bigModules.length}) ──`);
for (const m of bigModules) {
  console.log(`  ${(m.size / 1024).toFixed(0)}kB at +${(m.at / 1000).toFixed(1)}s  names: ${m.names.join(", ") || "(none)"}`);
  console.log(`      head: ${m.head.replace(/\s+/g, " ").slice(0, 150)}`);
}

if (process.env.DUMP_WGSL) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = process.env.DUMP_WGSL;
  mkdirSync(dir, { recursive: true });
  const codes = await page.evaluate(() => globalThis.__wgslDump ?? []);
  const seen = new Set();
  let n = 0;
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    writeFileSync(`${dir}/kernel-${String(n++).padStart(2, "0")}-${(code.length / 1024).toFixed(0)}kB.wgsl`, code);
  }
  console.log(`dumped ${n} unique compute kernels to ${dir}`);
}

const verdict = failed ? `FAIL (pageerror: ${failed})` : waveDone ? "PASS — wave completed" : built ? "PARTIAL — GI built, wave log missing" : "FAIL — no [gi] built";
console.log(`\nWAVE PROFILE: ${verdict}`);
await browser.close();
process.exit(failed ? 1 : 0);
