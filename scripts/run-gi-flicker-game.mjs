// FLICKER REPRO — opens the user's REAL project read-only, moves a light, and
// measures FRAME-TO-FRAME luminance change from a fixed camera.
//
// "Light flickers all over the screen when lighting changes" is, as a
// measurement, high variance between CONSECUTIVE frames at a still camera. A
// converging GI field changes monotonically and settles; a flickering one
// oscillates. So this captures a burst of frames while a light moves, then a
// burst after it stops, and prints the per-frame delta for each.
//
// It exists because four hypotheses in a row were wrong from code reading
// alone. Nothing gets changed until this reproduces the symptom.
//
//   npx vite --port 5234 --strictPort
//   node scripts/run-gi-flicker-game.mjs [url]
//
// Env: FRAMES=12 · QUALITY=<tier to force> · HEADED=1 · NOMOVE=1 (control arm:
// capture the same burst with the light held still — flicker that shows up
// there too is not about the light moving at all).
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5234/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const scenePath = path.join(PROJECT, "scenes/Main.scene").replace(/\\/g, "/");
const FRAMES = Number(process.env.FRAMES ?? 12);
const QUALITY = process.env.QUALITY ?? "";
const NOMOVE = process.env.NOMOVE === "1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
// Vite stamps module URLs with `?t=<mtime>`; a cached index.html from an
// earlier run references timestamps this server no longer serves, and the app
// dies on "504 Outdated Optimize Dep" before any of our code runs.
await page.setCacheEnabled(false);
await installTauriShim(page, {});
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t) || m.type() === "error") console.log(`  ${m.type()}: ${t.slice(0, 200)}`);
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
  // Re-resolving beats caching: a global set inside an evaluate does not
  // survive the re-navigation that scene loading can trigger.
  globalThis.__resolveEngine = async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    return ensureEngine();
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

console.log(`Opening ${scenePath} ...`);
const opened = await page.evaluate(async ({ PROJECT, scenePath }) => {
  try {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(PROJECT);
    const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
    await syncProjectModules();
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(scenePath);
    const engine = await globalThis.__resolveEngine();
    return { ok: true, entities: engine.entities.size, name: engine.sceneName };
  } catch (err) {
    return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
  }
}, { PROJECT, scenePath });
if (!opened.ok) { console.log(`FATAL: ${opened.error}`); await browser.close(); process.exit(1); }
console.log(`  opened "${opened.name}": ${opened.entities} entities`);

const settle = async (label, budget = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await wait(1500);
    const busy = await page.evaluate(async () => (await globalThis.__resolveEngine()).renderSuspended === true);
    if (!busy && Date.now() - t0 > 8000) break;
  }
  console.log(`  settled (${label}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};
await settle("load");
await wait(6000);

const setup = await page.evaluate(async (QUALITY) => {
  const engine = await globalThis.__resolveEngine();
  const lights = [];
  let gi = null;
  for (const entity of engine.entities.values()) {
    if (entity.getComponent?.("light")) lights.push({ id: entity.id, name: entity.name });
    const g = entity.getComponent?.("global-illumination");
    if (g) gi = g;
  }
  if (QUALITY && gi) gi.setProp("quality", QUALITY);
  globalThis.__lightId = lights[0]?.id ?? null;
  return {
    lights: lights.map((l) => l.name),
    gi: gi ? { quality: gi.props.quality, exact: gi.props.exactReflections, backend: gi.props.backend } : null,
  };
}, QUALITY);
console.log(`  lights: ${setup.lights.join(", ") || "(none)"}`);
console.log(`  gi: ${JSON.stringify(setup.gi)}`);
if (QUALITY) await settle(`quality ${QUALITY}`);

const lum = (d, info) => {
  let s = 0;
  for (let i = 0; i < d.length; i += info.channels) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return s / (d.length / info.channels);
};

async function burst(label, move) {
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    if (move) {
      await page.evaluate(async () => {
        const engine = await globalThis.__resolveEngine();
        const e = globalThis.__lightId ? engine.getEntity(globalThis.__lightId) : null;
        if (!e) return;
        // ROTATE, do not translate. The scene's light is DIRECTIONAL, and a
        // directional light's position is meaningless — three derives its
        // direction from the object's orientation. Translating it (the first
        // version of this) changed nothing at all, which is exactly what the
        // measurement showed: the "moving" arm was quieter than the still one.
        //
        // A slow, smooth sweep: GI should track it continuously, so a field
        // that oscillates between frames under a monotone input is the bug.
        // `entity.rotation` is a THREE.Euler (radians), not an array.
        const r = e.rotation;
        e.rotation = [r.x, r.y + 0.05, r.z];
      });
    }
    await wait(450);
    const png = await page.screenshot();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    frames.push({ l: lum(data, info), data, info });
  }
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(Math.abs(frames[i].l - frames[i - 1].l));
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const max = Math.max(...deltas);
  // Direction reversals: a converging field drifts one way, a flickering one
  // changes sign repeatedly. This is the discriminator, not raw magnitude.
  let reversals = 0;
  for (let i = 2; i < frames.length; i++) {
    const a = frames[i - 1].l - frames[i - 2].l;
    const b = frames[i].l - frames[i - 1].l;
    if (a * b < 0 && Math.abs(a) > 0.05 && Math.abs(b) > 0.05) reversals++;
  }
  console.log(`\n[${label}] mean |Δlum| ${mean.toFixed(3)}  max ${max.toFixed(3)}  reversals ${reversals}/${frames.length - 2}`);
  console.log(`  frames: ${frames.map((f) => f.l.toFixed(2)).join(" ")}`);
  await sharp(frames.at(-1).data, { raw: { width: frames.at(-1).info.width, height: frames.at(-1).info.height, channels: frames.at(-1).info.channels } })
    .toFile(`scripts/gi-flicker-${label}.png`);
  return { mean, max, reversals };
}

const still = await burst("still", false);
const moving = NOMOVE ? null : await burst("moving", true);
await browser.close();

console.log("\n--- verdict ---");
console.log(`still:  mean ${still.mean.toFixed(3)} reversals ${still.reversals}`);
if (moving) console.log(`moving: mean ${moving.mean.toFixed(3)} reversals ${moving.reversals}`);
console.log("A converging field drifts one direction and settles (few reversals).");
console.log("Repeated sign changes at a fixed camera ARE the flicker.");
process.exit(0);
