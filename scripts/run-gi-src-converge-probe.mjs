// FIELD CONVERGENCE AFTER A LIGHT STEP — what "temporal is too slow" measures.
//
// `probe:gi-src-alpha` gates the α RAMP (it is exact); this gates what the
// user actually sees: how long the RESOLVED FIELD takes to reach its new
// steady state after a light's intensity steps. The two diverge for three
// suspects, each an arm here, all in ONE page (in-page A/B discipline):
//
//   default   tier cap (16 on high) + α compensation, stride 1 — the shipped
//             config at this probe's resolution
//   comp-off  `__giSrcAlphaComp = false` — isolates §12.42's compensation
//             tail (the α spike from a step is ~one frame of delta; most of
//             the convergence happens after the ramp falls back to the still
//             floor, where compensation re-engages on capped blocks)
//   cap-off   `__giSrcProbeRayCap = 0` — isolates the cap itself
//   strided   default config with `__giSrcTransportRays` forced so stride≈12
//             — THE USER'S REGIME at ultra/fullscreen, where the decay's
//             stride root multiplies the convergence time constant by S:
//             even at the moving α, t90 ≈ 2.3·S/α frames. This arm is the
//             hypothesis for the standing complaint.
//
// Metric: mean resolve-texture luminance (every-4th-pixel reduce, in-page,
// per rAF), baseline B = mean of the last 20 pre-step samples, final F =
// mean of the 12–15 s window, t90 = first wall-clock time the mean crosses
// B + 0.9·(F−B) and stays for 3 samples. Reported in seconds — wall-clock is
// the axis the complaint lives on.
//
//   node scripts/run-gi-src-converge-probe.mjs [url]
// Env: HEADED=1, STEP_TO=6 (intensity after the step; base is 2)
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-src")).replaceAll("\\", "/");
await makeCornellProject(GEN_ROOT, { emitStrength: Number(process.env.EMIT ?? 4) });
const STEP_TO = Number(process.env.STEP_TO ?? 6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] (src probes|built|field ready)/.test(t)) {
    giLines.push(t);
    console.log(`  ${t.slice(0, 150)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 180)}`);
});
await page.evaluateOnNewDocument((P) => {
  localStorage.setItem("engine.projectRoot.v1", P);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
  globalThis.__editorKeepRendering = true;
}, GEN_ROOT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });
const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

{
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (giLines.some((l) => /\[gi\] field ready/.test(l))) break;
    await wait(1000);
  }
  if (!giLines.some((l) => /\[gi\] field ready/.test(l))) {
    console.log("FAIL no \"[gi] field ready\" within 180s — instrument fault");
    await browser.close();
    process.exit(1);
  }
}
await page.evaluate(() => globalThis.__editorApi.call("viewport.freezeWhenUnfocused", { enabled: false })).catch(() => {});

// The probe-owned light — the only punctual light in the scene, so the step
// is unambiguous (same setup as probe:gi-src-alpha).
const lightEntity = await must("entity.create", { name: "__converge_probe_light" });
const lid = lightEntity?.id ?? lightEntity;
await must("component.add", { id: lid, type: "light" });
await must("component.setProp", { id: lid, type: "light", key: "intensity", value: 2 });
await must("entity.setTransform", { id: lid, position: [0, 4.5, 0] });
await wait(4000);

// The in-page mean sampler over the GI resolve texture, built ONCE. Fixed
// point (lum × 1024) into one atomic word; every 4th pixel on both axes.
// ⚠ re-acquire nothing per sample: quality never changes here, so the
// targets are stable (the §12.24 harness trap only bites across tier flips).
await page.evaluate(async (anchorId) => {
  const engine = globalThis.__editorApi.entities.live(anchorId)?.engine;
  if (!engine?.renderer) throw new Error("no live engine");
  const system = engine.modules.get("gi")?.system;
  const targets = system?._giTargets;
  const size = system?._giTargetSize;
  if (!targets?.irradiance || !size) throw new Error("no GI resolve targets");
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, If, atomicAdd, atomicStore, instanceIndex, instancedArray, ivec2, texture, uint, uniform, vec3 } = TSL;
  const { width, height } = size;
  const w4 = Math.floor(width / 4);
  const h4 = Math.floor(height / 4);
  const sumBuf = instancedArray(new Uint32Array(2), "uint").toAtomic();
  const irrNode = texture(targets.irradiance);
  const w4U = uniform(w4, "uint");
  const clearPass = Fn(() => {
    atomicStore(sumBuf.element(instanceIndex), uint(0));
  })().compute(2);
  const reduce = Fn(() => {
    const px = instanceIndex.mod(w4U).mul(uint(4));
    const py = instanceIndex.div(w4U).mul(uint(4));
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722));
    atomicAdd(sumBuf.element(uint(0)), uint(lum.mul(1024).add(0.5)));
    atomicAdd(sumBuf.element(uint(1)), uint(1));
  })().compute(w4 * h4);
  globalThis.__convergeSample = async () => {
    engine.renderer.compute(clearPass);
    engine.renderer.compute(reduce);
    const words = new Uint32Array(await engine.renderer.getArrayBufferAsync(sumBuf.value));
    return { t: performance.now(), mean: words[1] ? words[0] / 1024 / words[1] : 0 };
  };
}, lid);

const setGlobals = (obj) => page.evaluate((o) => { Object.assign(globalThis, o); }, obj);
const setIntensity = (v) => must("component.setProp", { id: lid, type: "light", key: "intensity", value: v });

/** Sample the field mean for `ms`, one sample per rAF-ish. */
const record = (ms) =>
  page.evaluate(async (dur) => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < dur) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(await globalThis.__convergeSample());
    }
    return out;
  }, ms);

const t90Of = (pre, post) => {
  const B = pre.slice(-20).reduce((s, x) => s + x.mean, 0) / Math.min(20, pre.length);
  const tail = post.filter((x) => x.t - post[0].t > 12000);
  const F = tail.reduce((s, x) => s + x.mean, 0) / Math.max(1, tail.length);
  const target = B + 0.9 * (F - B);
  const rising = F > B;
  let t90 = null;
  for (let i = 0; i < post.length - 2; i++) {
    const ok = (x) => (rising ? x.mean >= target : x.mean <= target);
    if (ok(post[i]) && ok(post[i + 1]) && ok(post[i + 2])) {
      t90 = (post[i].t - post[0].t) / 1000;
      break;
    }
  }
  return { B, F, t90, samples: post.length };
};

const arms = [
  { name: "default (cap 16 + comp, stride 1)", globals: { __giSrcAlphaComp: undefined, __giSrcProbeRayCap: undefined, __giSrcTransportRays: undefined } },
  { name: "comp-off", globals: { __giSrcAlphaComp: false, __giSrcProbeRayCap: undefined, __giSrcTransportRays: undefined } },
  { name: "cap-off", globals: { __giSrcAlphaComp: undefined, __giSrcProbeRayCap: 0, __giSrcTransportRays: undefined } },
  // pixels×rays / 12 — reproduces the ultra/fullscreen stride at this probe's
  // resolution. Derived in-page from the published transport.
  { name: "strided ~12 (the user's ultra regime)", globals: { __giSrcAlphaComp: undefined, __giSrcProbeRayCap: undefined }, stride12: true },
];

console.log(`\n  step: intensity 2 -> ${STEP_TO}; t90 = seconds to 90% of the step, field mean\n`);
const results = [];
for (const arm of arms) {
  await setGlobals(arm.globals);
  if (arm.stride12) {
    const nat = await page.evaluate(() => globalThis.__giSrcTransport?.naturalRays ?? 0);
    if (!nat) { console.log("  FAIL no published transport for the strided arm"); continue; }
    await setGlobals({ __giSrcTransportRays: Math.ceil(nat / 12) });
  }
  await setIntensity(2);
  await wait(20000);                       // full re-settle at this config
  const pre = await record(3000);
  await Promise.all([                      // step mid-recording is unnecessary:
    setIntensity(STEP_TO),                 // post starts AT the step
  ]);
  const post = await record(16000);
  const r = t90Of(pre, post);
  const stride = await page.evaluate(() => globalThis.__giSrcTransport?.stride ?? 1);
  const lift = await page.evaluate(() => globalThis.__giSrcCompLiftLive ?? null);
  results.push({ arm: arm.name, ...r, stride });
  console.log(`  ${arm.name.padEnd(40)} B ${r.B.toFixed(4)} -> F ${r.F.toFixed(4)}  ` +
    `t90 ${r.t90 == null ? ">16s (NEVER within window)" : r.t90.toFixed(2) + "s"}  ` +
    `(stride ${stride}, ${r.samples} samples, lift now ${lift?.toFixed?.(2) ?? lift})`);
}
await setGlobals({ __giSrcAlphaComp: undefined, __giSrcProbeRayCap: undefined, __giSrcTransportRays: undefined });

// The verdict is diagnostic, not pass/fail: which suspect owns the slowness.
const by = Object.fromEntries(results.map((r) => [r.arm.split(" ")[0], r.t90 ?? 99]));
console.log("");
if (by["strided"] > 2 * Math.max(0.1, by["default"])) {
  console.log("  => THE STRIDE ROOT dominates: at stride S the decay's S-th root multiplies the");
  console.log("     convergence time constant by S. The fix is a tracking window after a seen");
  console.log("     luminance step: hold the moving alpha AND skip the stride root while it runs.");
}
if (by["comp-off"] < 0.7 * Math.max(0.1, by["default"])) {
  console.log("  => THE COMPENSATION TAIL contributes: convergence past the one-frame alpha spike");
  console.log("     happens at the still floor with comp re-engaged. Same fix: the tracking window");
  console.log("     holds lift at 1 for its duration.");
}
console.log("\ngi-src-converge: measured (diagnostic probe — numbers above are the deliverable)");
await browser.close();
process.exit(0);
