// GROUND-TRUTH SHADER-COMPILE BENCH: how long does THIS machine's driver
// actually take on each dumped kernel, alone, on an idle page? The wave
// profiler's per-pipeline durations include GPU-process queueing and
// callback-delivery starvation — this removes both. Compiles sequentially,
// awaiting each createComputePipelineAsync before the next.
//
//   node scripts/run-wgsl-bench.mjs <dir-with-.wgsl-files>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/run-wgsl-bench.mjs <dir>");
  process.exit(2);
}
const files = readdirSync(dir).filter((f) => f.endsWith(".wgsl")).sort();
const kernels = files.map((f) => ({ name: f, code: readFileSync(join(dir, f), "utf8") }));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
// about:blank is not a secure context — navigator.gpu is absent there. Any
// localhost URL (the running vite server's 404 page included) is.
await page.goto(process.env.BENCH_URL ?? "http://localhost:5201/__wgsl_bench_blank__");

const results = await page.evaluate(async (kernels) => {
  const adapter = await navigator.gpu.requestAdapter();
  // The dumped kernels carry `enable subgroups;` etc. — request everything
  // the adapter has so module validation matches the editor's device.
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const info = adapter.info ?? {};
  const out = { adapter: `${info.vendor ?? "?"} ${info.architecture ?? ""} ${info.description ?? ""}`.trim(), rows: [] };
  for (const { name, code } of kernels) {
    const t0 = performance.now();
    let error = null;
    try {
      const module = device.createShaderModule({ code });
      const tModule = performance.now();
      await device.createComputePipelineAsync({ layout: "auto", compute: { module } });
      out.rows.push({ name, moduleMs: tModule - t0, pipelineMs: performance.now() - tModule });
    } catch (e) {
      error = e?.message ?? String(e);
      out.rows.push({ name, error });
    }
  }
  return out;
}, kernels);

console.log(`adapter: ${results.adapter}`);
console.log(`${"kernel".padEnd(28)} ${"module".padStart(9)} ${"pipeline".padStart(10)}`);
let total = 0;
for (const r of results.rows) {
  if (r.error) {
    console.log(`${r.name.padEnd(28)}  ERROR: ${r.error.slice(0, 90)}`);
    continue;
  }
  total += r.pipelineMs;
  console.log(`${r.name.padEnd(28)} ${r.moduleMs.toFixed(0).padStart(7)}ms ${r.pipelineMs.toFixed(0).padStart(8)}ms`);
}
console.log(`total pipeline compile: ${(total / 1000).toFixed(1)}s over ${results.rows.length} kernels (sequential, idle page)`);
await browser.close();
