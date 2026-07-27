// Why does leaving Play mode freeze the editor for seconds when entering it is
// instant? Entering only serializes the scene to JSON; leaving destroys every
// entity and rebuilds the whole scene from that snapshot (playMode.doStop →
// deserializeScene).
//
// This opens the USER'S REAL PROJECT through the editor's own code path (via
// the read-only Tauri shim), then times play → stop and attributes the stop
// with the CDP sampling profiler. It also reports the time until the viewport
// is animating smoothly again, because the freeze the user sees includes the
// first render after the rebuild, not just deserializeScene's own runtime.
//
// Env: PROJECT=<dir>, SCENE=<name.scene>, HEADED=1. URL as argv[2].
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/Test").replace(/\\/g, "/");
const SCENE = process.env.SCENE ?? "Untitled.scene";
const scenePath = path.join(PROJECT, "scenes", SCENE).replace(/\\/g, "/");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { verbose: !!process.env.VERBOSE });
page.on("console", (m) => {
  const t = m.text();
  if (/PS-/.test(t)) console.log(t);
  else if (m.type() === "error" && !/404|Failed to load resource/.test(t)) console.log(`error: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

// Vite rewrites imports of files edited since the server started to
// `…?t=<mtime>`. A bare `import("/src/…")` from the harness loads a SECOND
// copy with its own Engine singleton — the harness would then drive an empty
// engine and report a fake 15ms stop. Read back the URL the browser actually
// fetched. (Same helper as run-editor-ui-smoke.mjs.)
await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (path) => {
    const prefix = location.origin + path;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? path);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

// ---- open the project + scene the way the editor does
const opened = await page.evaluate(
  async ({ PROJECT, scenePath }) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(PROJECT);
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(scenePath);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    return { entities: engine.entities.size, name: engine.sceneName };
  },
  { PROJECT, scenePath },
);
console.log(`opened ${scenePath}`);
console.log(`  scene "${opened.name}": ${opened.entities} entities`);

// Let async asset loads, GI bakes and pipeline compiles settle before timing.
const settle = async (label, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    await new Promise((r) => setTimeout(r, 1000));
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t > 6000) break;
  }
  console.log(`  settled (${label}) after ${((Date.now() - t) / 1000).toFixed(1)}s`);
};
await settle("initial load");

const componentCensus = await page.evaluate(() => {
  const counts = {};
  for (const entity of globalThis.__engine.entities.values()) {
    for (const c of entity.components.keys()) counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
});
console.log(`  components: ${Object.entries(componentCensus).map(([k, v]) => `${k}×${v}`).join(", ") || "(none)"}`);
console.log(`  modules: ${(await page.evaluate(() => [...(globalThis.__engine.modules?.keys?.() ?? [])])).join(", ") || "(none)"}`);

// ---- STRIP=<type,type>: drop whole component classes before timing, so the
// 2s stall can be attributed to a subsystem instead of guessed at.
if (process.env.STRIP) {
  const removed = await page.evaluate(async (types) => {
    const engine = globalThis.__engine;
    let n = 0;
    for (const entity of [...engine.entities.values()]) {
      for (const type of types) {
        if (entity.components.has(type)) {
          entity.removeComponent(type);
          n++;
        }
      }
    }
    engine.emit("hierarchy-changed");
    return n;
  }, process.env.STRIP.split(",").map((s) => s.trim()));
  console.log(`  STRIPPED ${removed} component(s): ${process.env.STRIP}`);
  await settle("post-strip");
}

// ---- frame-gap recorder: the freeze the user actually feels
await page.evaluate(() => {
  globalThis.__frames = [];
  const step = (now) => {
    globalThis.__frames.push(now);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  globalThis.__hierCount = 0;
  globalThis.__engine.on("hierarchy-changed", () => globalThis.__hierCount++);
});

const cdp = await page.createCDPSession();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });

const timed = async (label, fn) => {
  await page.evaluate(() => {
    globalThis.__frames.length = 0;
    globalThis.__hierCount = 0;
  });
  await cdp.send("Profiler.start");
  const ms = await page.evaluate(fn);
  // Keep sampling past the awaited call: the rebuild's real cost includes the
  // first render after it, where every recreated material compiles.
  await new Promise((r) => setTimeout(r, 4000));
  const { profile } = await cdp.send("Profiler.stop");
  const stats = await page.evaluate(() => {
    const f = globalThis.__frames;
    let worst = 0;
    for (let i = 1; i < f.length; i++) worst = Math.max(worst, f[i] - f[i - 1]);
    return { worst, frames: f.length, hier: globalThis.__hierCount };
  });

  const self = new Map();
  for (const node of profile.nodes) {
    const f = node.callFrame;
    const file = (f.url || "").split("/").slice(-1)[0].split("?")[0];
    const where = `${f.functionName || "(anonymous)"}  ${file}:${f.lineNumber + 1}`;
    self.set(where, (self.get(where) ?? 0) + (node.hitCount ?? 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  console.log("");
  console.log(`--- ${label} ---`);
  console.log(`  awaited call: ${ms.toFixed(0)} ms`);
  console.log(`  longest single frame gap in the window: ${stats.worst.toFixed(0)} ms  (${stats.frames} frames)`);
  console.log(`  hierarchy-changed emissions: ${stats.hier}`);
  console.log(`  CPU self-time (100µs sampling, includes the 4s after the call):`);
  [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([where, hits]) => console.log(`    ${((hits / total) * 100).toFixed(1).padStart(5)}%  ${where}`));
  return ms;
};

await timed("PLAY", async () => {
  const { play } = await globalThis.__importLive("/src/editor/playMode.js");
  const t = performance.now();
  await play();
  return performance.now() - t;
});
await new Promise((r) => setTimeout(r, 3000));

await timed("STOP", async () => {
  const { stop } = await globalThis.__importLive("/src/editor/playMode.js");
  const t = performance.now();
  await stop();
  return performance.now() - t;
});

console.log("");
console.log(`entities after stop: ${await page.evaluate(() => globalThis.__engine.entities.size)}`);

// ---- PHASES=1: split the stop into teardown vs rebuild vs first-render.
// "deserializeScene took 80ms" and "the editor froze for 2s" are both true —
// the awaited call returns before the recreated materials have been compiled,
// which happens inside the next render(). Time each separately.
if (process.env.PHASES) {
  await new Promise((r) => setTimeout(r, 3000));
  const phases = await page.evaluate(async () => {
    const engine = globalThis.__engine;
    const { serializeScene, deserializeScene } = await globalThis.__importLive("/src/engine/index.js");
    const snapshot = serializeScene(engine);
    const t0 = performance.now();
    engine.clear({ resetSettings: false });
    const cleared = performance.now() - t0;
    const t1 = performance.now();
    await deserializeScene(engine, snapshot);
    const rebuilt = performance.now() - t1;
    // The freeze includes the first frame that draws the rebuilt scene: three
    // compiles a pipeline per material the first time it renders it.
    const t2 = performance.now();
    engine.renderer.render(engine.scene, engine.camera);
    const firstRender = performance.now() - t2;
    const t3 = performance.now();
    engine.renderer.render(engine.scene, engine.camera);
    const secondRender = performance.now() - t3;
    return { cleared, rebuilt, firstRender, secondRender };
  });
  console.log("");
  console.log("--- stop phases (ms) ---");
  console.log(`  engine.clear (teardown):   ${phases.cleared.toFixed(0)}`);
  console.log(`  deserializeScene (rebuild):${phases.rebuilt.toFixed(0)}`);
  console.log(`  first render after rebuild:${phases.firstRender.toFixed(0)}`);
  console.log(`  second render (steady):    ${phases.secondRender.toFixed(0)}`);
}
await browser.close();
process.exit(0);
