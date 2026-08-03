// IS IT GI AT ALL? — the discriminator for two symptoms that survived six
// rounds of GI fixes: "floor glows when the sun is underneath" and "indirect
// flickers as the light moves".
//
// Both are measured with the GI component ENABLED and DISABLED at an otherwise
// identical camera pose and light orientation. If a symptom is still there with
// GI off, GI is not producing it and the whole search has been in the wrong
// subsystem (post stack / IBL / three's own direct lighting).
//
//   npx vite --port 5240 --strictPort
//   node scripts/run-gi-glow-game.mjs [url]
//
// Env: HEADED=1 · FRAMES=8 (flicker burst length)
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5240/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const scenePath = path.join(PROJECT, "scenes/Main.scene").replace(/\\/g, "/");
const FRAMES = Number(process.env.FRAMES ?? 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
await page.setCacheEnabled(false);
await installTauriShim(page, {});
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t) || m.type() === "error") console.log(`  ${m.type()}: ${t.slice(0, 180)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  // THE EDITOR API, NOT A MODULE IMPORT. `__importLive` can only find a module
  // the app has already fetched; anything else resolves to a SECOND copy of the
  // graph with its own Engine, so `openScenePath` loaded a scene into an engine
  // this harness could not see (`openScenePath -> true`, 0 entities). The op
  // registry is a `Symbol.for` singleton published on `globalThis`, so it is
  // immune to that whole class.
  globalThis.__api = () => {
    const api = globalThis.__editorApi;
    if (!api) throw new Error("__editorApi not installed yet");
    return api;
  };
  globalThis.__resolveEngine = async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    return ensureEngine();
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log(`Opening ${scenePath} ...`);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
const opened = await page.evaluate(async ({ PROJECT, scenePath }) => {
  try {
    const api = globalThis.__api();
    await api.call("project.open", { path: PROJECT });
    await api.call("scene.open", { path: scenePath });
    const scene = api.call("scene.get", {});
    return { ok: true, name: scene.name, roots: (scene.rootEntityIds ?? scene.roots ?? []).length };
  } catch (err) {
    return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
  }
}, { PROJECT, scenePath });
if (!opened.ok) { console.log(`FATAL: ${opened.error}`); await browser.close(); process.exit(1); }
console.log(`  opened "${opened.name}": ${opened.roots} root entities`);

const settle = async (label, budget = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await wait(1500);
    const busy = await page.evaluate(async () => (await globalThis.__resolveEngine()).renderSuspended === true);
    if (!busy && Date.now() - t0 > 8000) break;
  }
  console.log(`  settled (${label}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};
await settle("load");
await wait(8000);

// Find the directional light + the GI component, and park the camera looking
// down the nave at the floor.
const setup = await page.evaluate(async () => {
  const engine = await globalThis.__resolveEngine();
  let sun = null;
  let gi = null;
  for (const entity of engine.entities.values()) {
    const light = entity.getComponent?.("light");
    if (light && !sun && (light.props?.type ?? "directional") === "directional") sun = entity;
    const g = entity.getComponent?.("global-illumination");
    if (g) gi = g;
  }
  globalThis.__sunId = sun?.id ?? null;
  globalThis.__giC = gi;
  return {
    sun: sun ? { name: sun.name, rot: [sun.rotation.x, sun.rotation.y, sun.rotation.z] } : null,
    gi: gi ? { quality: gi.props.quality, killSdf: gi.props.killSdf, backend: gi.props.backend } : null,
  };
});
console.log(`  sun: ${JSON.stringify(setup.sun)}`);
console.log(`  gi:  ${JSON.stringify(setup.gi)}`);
if (!setup.sun || !setup.gi) { console.log("FATAL: need a directional light and a GI component"); await browser.close(); process.exit(1); }

const setSunPitch = (pitch) => page.evaluate(async (p) => {
  const engine = await globalThis.__resolveEngine();
  const e = engine.getEntity(globalThis.__sunId);
  if (e) e.rotation = [p, e.rotation.y, e.rotation.z];
}, pitch);

const setGi = (on) => page.evaluate(async (v) => {
  const engine = await globalThis.__resolveEngine();
  for (const entity of engine.entities.values()) {
    const g = entity.getComponent?.("global-illumination");
    if (g) g.enabled = v;
  }
}, on);

// Floor sample: lower-left of the viewport, deliberately away from the centre
// where the transform gizmo and the grid axis line live.
async function sampleFloor() {
  const png = await page.screenshot();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const x0 = Math.floor(info.width * 0.12), x1 = Math.floor(info.width * 0.38);
  const y0 = Math.floor(info.height * 0.74), y1 = Math.floor(info.height * 0.94);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
    }
  }
  return { lum: sum / n, png };
}

// ── PART 1: the glow. Sweep the sun from above the horizon to below it, with
// GI on and off. A GI-produced glow shows as a gap that OPENS as the sun goes
// under; a glow present with GI off is not GI's.
console.log("\n=== GLOW: floor luminance vs sun pitch ===");
console.log("  pitch     GI on    GI off    delta");
const pitches = [-1.2, -0.6, -0.2, 0.2, 0.6, 1.2];
for (const pitch of pitches) {
  await setGi(true);
  await setSunPitch(pitch);
  await wait(2500);
  const on = await sampleFloor();
  await setGi(false);
  await wait(2000);
  const off = await sampleFloor();
  console.log(
    `  ${String(pitch).padStart(5)}   ${on.lum.toFixed(2).padStart(7)}   ${off.lum.toFixed(2).padStart(7)}   ${(on.lum - off.lum).toFixed(2).padStart(7)}`,
  );
}

// ── PART 2: the flicker. Rotate the sun continuously and measure frame-to-frame
// luminance change, GI on vs off. A converging field drifts one way; a
// flickering one reverses sign repeatedly.
async function flickerBurst(label) {
  const lums = [];
  for (let f = 0; f < FRAMES; f++) {
    await page.evaluate(async () => {
      const engine = await globalThis.__resolveEngine();
      const e = engine.getEntity(globalThis.__sunId);
      if (e) e.rotation = [e.rotation.x + 0.04, e.rotation.y + 0.04, e.rotation.z];
    });
    await wait(500);
    lums.push((await sampleFloor()).lum);
  }
  const deltas = [];
  for (let i = 1; i < lums.length; i++) deltas.push(Math.abs(lums[i] - lums[i - 1]));
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  let reversals = 0;
  for (let i = 2; i < lums.length; i++) {
    const a = lums[i - 1] - lums[i - 2], b = lums[i] - lums[i - 1];
    if (a * b < 0 && Math.abs(a) > 0.05 && Math.abs(b) > 0.05) reversals++;
  }
  console.log(`  ${label}: mean |Δlum| ${mean.toFixed(3)}  reversals ${reversals}/${Math.max(0, lums.length - 2)}`);
  console.log(`    ${lums.map((l) => l.toFixed(1)).join(" ")}`);
  return { mean, reversals };
}

console.log("\n=== FLICKER: frame-to-frame floor luminance while the sun rotates ===");
await setSunPitch(-0.3);
await wait(2500);
await setGi(true);
await wait(2500);
const flickOn = await flickerBurst("GI on ");
await setGi(false);
await wait(2500);
const flickOff = await flickerBurst("GI off");

console.log("\n--- verdict ---");
console.log(`flicker  GI on ${flickOn.mean.toFixed(3)} (${flickOn.reversals} rev)  vs  GI off ${flickOff.mean.toFixed(3)} (${flickOff.reversals} rev)`);
console.log("A glow/flicker that survives GI off is NOT produced by the GI module.");
await browser.close();
process.exit(0);
