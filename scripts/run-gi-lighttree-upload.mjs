// LIGHT TREE §12.62 W1 GATE — did the block reach the GPU intact?
//
// Boots the emissive storm rig (same one the mask bisect uses), waits for the
// `[gi] light tree:` publish, then copies the uploaded region back out of the
// occupancy `bits` buffer through a small compute (never a whole-buffer
// readback — `bits` is hundreds of MB on real scenes) and validates it with
// `readLightTree`: header magic/version/counts must round-trip and must match
// what the build published. This is deliberately a STRUCTURE check, not a
// bit-diff against an in-page rebuild — the rebuild's candidate set could
// differ by a frame of scene state and a false FAIL from that would cost more
// than the diff buys (`test:gi-lighttree` already bit-gates pack/read).
//
//   node scripts/run-gi-lighttree-upload.mjs
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-emissive-cost").replaceAll("\\", "/");
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
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
let treeLine = "";
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\] light tree:/.test(t)) { treeLine = t; console.log(`  ${t.slice(0, 160)}`); }
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, GEN_ROOT);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
for (let i = 0; i < 150 && !built; i++) await wait(1000);
console.log(`built=${built}`);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
// The upload compute is queued behind the field build's pending list — give
// the frame loop a few seconds to flush it before reading.
await wait(8000);

const result = await page.evaluate(async () => {
  const live = globalThis.__giLightTreeLive;
  if (!live) return { fail: "no __giLightTreeLive — the W1 build never ran or found no emitters" };
  const ids = await globalThis.__editorApi.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const eng = anyId ? globalThis.__editorApi.entities.live(anyId)?.engine : null;
  const gi = eng?.modules?.get?.("gi")?.system;
  const renderer = eng?.renderer;
  const bits = gi?.state?.volume?.occupancyField?.bitsBuffer;
  if (!bits || !renderer) return { fail: "no bits buffer / renderer handle" };

  // Whole-buffer readback, then slice. NO in-page TSL kernel: the first
  // version imported a SECOND three.tsl and embedded the app's `bits` node in
  // a foreign-built Fn — the duplicate-three trap, which renders ZEROS with
  // no error (both the tree region AND the known-good static-BVH header read
  // 0, which is what indicted the read path). ~20 MB on the storm rig; a
  // harness can afford it once.
  const field = gi.state.volume.occupancyField;
  const staticBase = (field.staticBvhWordOffset ?? 0) >>> 0;
  const all = new Uint32Array(await renderer.getArrayBufferAsync(bits.value));
  const abs = live.abs >>> 0;
  const words = all.subarray(abs, abs + live.words);
  const staticHeader = Array.from(all.subarray(staticBase, staticBase + 16));

  const lt = await import("/src/modules/gi/lightTree.js");
  let view = null;
  let readError = null;
  try {
    view = lt.readLightTree(words, 0);
  } catch (err) {
    readError = String(err?.message ?? err);
  }
  return {
    live,
    readError,
    // readLightTree THROWS on a bad version word, so `readError === null`
    // already certifies the version — no separate field needed.
    view: view
      ? {
          emitterCount: view.emitterCount,
          nodeCount: view.nodeCount,
          arity: view.arity,
          totalWords: view.totalWords,
          totalPower: view.totalPower,
          maxDepth: view.maxDepth,
        }
      : null,
    nonZeroWords: words.reduce((n, w) => n + (w !== 0 ? 1 : 0), 0),
    staticBase,
    staticHeaderNonZero: staticHeader.filter((w) => w !== 0).length,
    bufferWords: all.length,
  };
});

console.log(JSON.stringify(result, null, 2));
let pass = false;
if (result.view && !result.readError) {
  const v = result.view;
  const l = result.live;
  pass = v.emitterCount === l.emitterCount
    && v.nodeCount === l.nodeCount
    && v.totalWords === l.words
    && result.nonZeroWords > 16;
  if (Number.isFinite(v.totalPower) && Number.isFinite(l.totalPower)) {
    pass = pass && Math.abs(v.totalPower - l.totalPower) < Math.max(1e-3, l.totalPower * 1e-4);
  }
}
console.log(pass
  ? "\nW1 GATE: PASS — the light-tree block round-trips off the GPU intact"
  : "\nW1 GATE: FAIL — see the dump above");
await browser.close();
process.exit(pass ? 0 : 1);
