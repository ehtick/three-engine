// WGSL COMPILE PROBE — time one shader, on its own, in a bare page.
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
//
// GI startup is now ONE object: a 77 kB compute kernel (4 loops, 204 ifs,
// `giStaticBvh8`/`giDynBvh8`/`giFreeRadius…`) that is 92-96% of time-to-first-
// frame (plan §13.14). Every remaining question about it is "does <change> make
// it compile faster", and `probe:gi-boot` answers that badly:
//
//   * a cold boot costs 2-5 minutes,
//   * the SAME kernel has measured 47s / 109s / 132s / 182s / 238s across runs,
//   * and in the 238s run EVERY other pipeline read ~15.5s against ~1.8s in the
//     109s run — the driver serializes (§13.3), so one slow compile inflates
//     every other number in the same process and the two runs cannot be
//     compared at all.
//
// A 9x-noise, 5-minute instrument cannot bisect a compiler pathology. This one
// loads a WGSL file into an empty page, compiles it N times, and reports the
// distribution — seconds per arm, and the only thing in the process is the
// shader under test.
//
// ⚠ WHAT IT DOES *NOT* MEASURE. A pipeline here has no bind group layout from
// the engine and no other work competing, so the absolute number is not the
// editor's number. It is for RATIOS between variants of the same shader, which
// is the only comparison the fix needs.
//
// Run:   node scripts/run-wgsl-compile-probe.mjs <file.wgsl> [more.wgsl ...]
// Env:   REPS=3   HEADED=1   ENTRY=<name>   TIMEOUT=<seconds>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";

const FILES = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const REPS = Number(process.env.REPS ?? 3);
const TIMEOUT_MS = (Number(process.env.TIMEOUT) || 600) * 1000;

if (!FILES.length) {
  console.log("usage: node scripts/run-wgsl-compile-probe.mjs <file.wgsl> [more.wgsl ...]");
  console.log("       REPS=3  compile each file this many times");
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ms = (v) => `${Math.round(v)}ms`;

const sources = [];
for (const f of FILES) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.log(`  missing: ${p}`); process.exit(1); }
  const code = fs.readFileSync(p, "utf8");
  sources.push({
    name: path.basename(p),
    code,
    kb: Math.round(code.length / 1024),
    loops: code.split("loop {").length - 1,
    ifs: code.split("if (").length - 1,
  });
}

console.log(`wgsl-compile-probe: ${sources.length} shader(s), ${REPS} rep(s) each`);
for (const s of sources) console.log(`  ${s.name.padEnd(34)} ${String(s.kb).padStart(4)}kB  ${s.loops} loops  ${s.ifs} ifs`);

// ⚠ WebGPU NEEDS A SECURE CONTEXT, AND `about:blank` IS NOT ONE.
// The first version pointed at about:blank and got `no navigator.gpu` — which
// reads as "this machine has no WebGPU" rather than "this page is not allowed
// to have it". `http://127.0.0.1` is treated as secure, so a four-line server
// buys a page that is still completely empty of engine code.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>wgsl-compile-probe</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADED === "1" ? false : "new",
  args: [
    // Same set the boot probe uses — a different flag set is a different
    // compiler configuration, and this probe exists to be comparable to it.
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // A fresh profile each run, so nothing is answered out of Chrome's
    // compiled-shader disk cache. §13.5 measured that cache at 72x — leaving it
    // on would make the second arm of any A/B win for the wrong reason.
    `--user-data-dir=${path.join(process.env.TEMP ?? "/tmp", `wgsl-probe-${process.pid}`)}`,
  ],
});

try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`  page: ${m.text().slice(0, 200)}`); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

  const results = await page.evaluate(async (shaders, reps) => {
    if (!navigator.gpu) return { error: "no navigator.gpu" };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: "no adapter" };
    // Ask for the same limits the engine asks for, because a shader that
    // exceeds a default limit fails to compile and a failure is not a fast
    // compile — it would read as a spectacular win.
    // ⚠ `enable subgroups;` IS IN THE ENGINE'S WGSL, and a device that did not
    // request the feature rejects the shader at parse — which this probe would
    // otherwise report as an ERROR row and, worse, a very fast one. Request
    // every feature the shader's `enable` directives name and the adapter has.
    const wanted = new Set();
    for (const s of shaders) {
      for (const m of s.code.matchAll(/enable\s+([A-Za-z0-9_,\s]+);/g)) {
        for (const f of m[1].split(",")) {
          const name = f.trim();
          if (name && adapter.features.has(name)) wanted.add(name);
        }
      }
    }
    const device = await adapter.requestDevice({
      requiredFeatures: [...wanted],
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(1073741824, adapter.limits.maxStorageBufferBindingSize),
        maxStorageTexturesPerShaderStage: Math.min(8, adapter.limits.maxStorageTexturesPerShaderStage),
      },
    });
    const out = [];
    for (const s of shaders) {
      const runs = [];
      let error = null;
      let entry = "";
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now();
        try {
          // ⚠ EVERY REP NEEDS UNIQUE TEXT. The first version compiled the same
          // string N times and read 28,087ms then 13ms — the device answers a
          // byte-identical module out of its in-process cache, so reps 2..N
          // measure the cache, not the compiler, and the median of
          // [28087, 13] is meaningless. A trailing comment changes the source
          // without changing one instruction of the compiled result.
          const module = device.createShaderModule({ code: `${s.code}\n// rep ${r}\n` });
          // Compilation info first: a shader with errors never reaches the
          // pipeline stage, and reporting its (fast) failure as a compile time
          // is the single most misleading thing this probe could do.
          const info = await module.getCompilationInfo();
          const errs = info.messages.filter((m) => m.type === "error");
          if (errs.length) { error = errs[0].message.slice(0, 200); break; }
          // The entry point is whatever the WGSL declares — three names them
          // inconsistently and a wrong guess is a validation error, not a
          // measurement.
          entry = entry || (s.code.match(/@compute[\s\S]{0,120}?fn\s+([A-Za-z0-9_]+)/)?.[1] ?? "main");
          await device.createComputePipelineAsync({
            layout: "auto",
            compute: { module, entryPoint: entry },
          });
          runs.push(performance.now() - t0);
        } catch (e) {
          error = String(e?.message ?? e).slice(0, 300);
          break;
        }
      }
      out.push({ name: s.name, kb: s.kb, loops: s.loops, ifs: s.ifs, runs, error, entry });
    }
    return { out };
  }, sources, REPS);

  if (results.error) {
    console.log(`\n  FAILED: ${results.error}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ── COMPILE TIME ──`);
    for (const r of results.out) {
      if (r.error) { console.log(`    ${r.name.padEnd(34)} ERROR: ${r.error}`); continue; }
      const sorted = [...r.runs].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
      console.log(`    ${r.name.padEnd(34)} median ${ms(med).padStart(9)}   ` +
        `runs ${r.runs.map((v) => ms(v)).join(", ")}   entry ${r.entry}`);
    }
    // The point of more than one file is the ratio between them, so print it
    // rather than leaving it to be done by eye against a wrong baseline.
    const ok = results.out.filter((r) => !r.error && r.runs.length);
    if (ok.length > 1) {
      const medOf = (r) => [...r.runs].sort((a, b) => a - b)[Math.floor(r.runs.length / 2)];
      const base = ok[0];
      console.log(`\n  ── RATIO TO ${base.name} ──`);
      for (const r of ok.slice(1)) {
        const f = medOf(r) / Math.max(medOf(base), 1e-9);
        console.log(`    ${r.name.padEnd(34)} ${f < 1 ? `${(1 / f).toFixed(1)}x FASTER` : `${f.toFixed(1)}x slower`}` +
          `   (${r.kb}kB vs ${base.kb}kB, ${r.loops} loops vs ${base.loops})`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
