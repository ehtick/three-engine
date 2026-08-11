// THE α MOTION SIGNAL'S INTENSITY TERM — §12.38.3's blind spot, gated (§12.41).
//
// The motion-adaptive α (§12.38) reads light MATRICES, emitter retains and
// mover displacement — so a lamp toggling in a still scene changed none of
// them and converged at the STILL floor (~0.05, ≈1 s). The user hit it in as
// many words: "temporal is way too slow, making light too slow to change."
// The fix tracks each light's emitted luminance (intensity × color luma)
// beside its matrix and feeds the RELATIVE per-frame delta into the same
// saturation constant as the matrix terms.
//
// This probe asserts the ramp END TO END through `__giSrcAlphaLive` (the α
// the frame actually used, published per frame by srcSystem.syncCamera —
// before it existed the ramp was unobservable from a page and §12.38 was
// verified only through its downstream flicker statistics):
//
//   still     α sits at the STILL floor (±ε) once the scene settles
//   toggle    one `component.setProp` halving the light's intensity sends
//             α to the MOVING value within a few frames
//   recover   α returns to the floor once the change stops
//
//   node scripts/run-gi-src-alpha-signal-probe.mjs [url]
// Env: HEADED=1
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-src")).replaceAll("\\", "/");
await makeCornellProject(GEN_ROOT, { emitStrength: Number(process.env.EMIT ?? 4) });
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

// Field-ready first — the probe contract. Measuring α during the compile
// wave reads whatever the boot left in the global, which is the
// instrument-not-looking family every recent gate has paid for once.
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

// A punctual light the probe owns. The Cornell project is emissive-lit, so
// this is the only light in `_lightObjects` and the signal is unambiguous.
const lightEntity = await must("entity.create", { name: "__alpha_probe_light" });
const lid = lightEntity?.id ?? lightEntity;
await must("component.add", { id: lid, type: "light" });
await must("component.setProp", { id: lid, type: "light", key: "intensity", value: 2 });
await must("entity.setTransform", { id: lid, position: [0, 4.5, 0] });

/** α over N frames, sampled at ~30 Hz. */
const sampleAlpha = (n) =>
  page.evaluate(async (count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const a = globalThis.__giSrcAlphaLive;
      if (typeof a === "number") out.push(a);
    }
    return out;
  }, n);

let failed = 0;
const check = (ok, label) => { console.log(` ${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failed++; };

// ── still: the floor ────────────────────────────────────────────────────────
// Creating the light IS a luminance step (0 → 2), so discard 3 s first.
await wait(3000);
const still = await sampleAlpha(60);
const stillMax = Math.max(...still);
check(still.length > 30 && stillMax <= 0.062,
  `still scene sits at the floor: max α ${stillMax.toFixed(4)} over ${still.length} frames (floor 0.05)`);

// ── toggle: the ramp ────────────────────────────────────────────────────────
// Sample FIRST, setProp mid-window: the spike is transient (one frame of
// delta, then the α ramp decays with the motion retains), so a sample loop
// started after the await could miss it.
const [toggled] = await Promise.all([
  sampleAlpha(40),
  (async () => { await wait(200); await must("component.setProp", { id: lid, type: "light", key: "intensity", value: 0.5 }); })(),
]);
const toggleMax = Math.max(...toggled);
check(toggleMax >= 0.09,
  `an intensity toggle rides α up: max α ${toggleMax.toFixed(4)} in the toggle window (moving value 0.10)`);

// ── recover: back to the floor ──────────────────────────────────────────────
await wait(3000);
const after = await sampleAlpha(60);
const afterMax = Math.max(...after);
check(afterMax <= 0.062,
  `and it recovers: max α ${afterMax.toFixed(4)} three seconds later`);

console.log(failed ? `\ngi-src-alpha-signal: ${failed} FAILED` : "\ngi-src-alpha-signal: all PASS");
await browser.close();
process.exit(failed ? 1 : 0);
