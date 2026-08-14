// §12.56 RENDER-FREEZE CHARACTERIZATION GATE (2026-08-14, fourth life).
// What it now knows that its ancestors didn't:
//   · The §12.65 "wedged pipeline" theory is DEAD — on black boots the pair's
//     pipelines settle in ~1.7s, nothing pending, and the GI irradiance
//     texture is LIT. Every historical "texture reads zero" datum was the
//     copy-kernel first-dispatch artifact (a fresh TSL kernel's first
//     dispatch is SKIPPED by installAsyncComputePipelines — the read returns
//     the buffer's initial zeros).
//   · The REAL failure is the RENDERED FRAME: blackFrac 0.9957 on the canvas
//     at t=30s with GI healthy underneath — a render-side submit/present
//     failure in the §12.56 family (occluder-race cousin), correlated with
//     the filter flag only through boot timing.
// This gate characterizes it:
//   IRR=0|1 (default 1)  — control arm vs filter arm, same script.
//   Verdict: 2D-canvas reads (NO WebGPU calls) at t≈30s and t≈42s, plus the
//   GI frame counter between them (is the loop ticking while the screen is
//   black?). PNGs saved for eyes. Then phase B: the copy-kernel artifact
//   demo + honest texture read + a FINAL canvas read (does page-context GPU
//   work heal the screen — the old "rescue" legend, tested against the
//   screen instead of the texture).
// Run ≥3 boots per arm. Delete when the render-side race is closed.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const IRR = process.env.IRR !== "0";
const OUT = ".gi-shots/irrfilter-gate";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

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
// DUMPERR=1: print EVERY console error unfiltered (deduped, capped) — the
// inherited noise filter turned out to hide exactly the classes a broken
// material/PP compile spams, which is how a black-frame cause can hide.
const errCounts = new Map();
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error") {
    const key = t.slice(0, 160);
    errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
    if (process.env.DUMPERR) {
      if (errCounts.get(key) === 1) console.log(`  console.error[1st]: ${t.slice(0, 400)}`);
    } else if (!/favicon|404|structures must have at least one member|selectionOutlineMask|previous error|Invalid ShaderModule|MeshPhysicalNodeMaterial|MeshBasicNodeMaterial/.test(t)) {
      console.log(`  console.error: ${t.slice(0, 400)}`);
    }
  }
  if (/§12\.56 WATCHDOG/.test(t)) console.log(`  ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  PAGEERROR: ${(e.stack ?? e.message ?? String(e)).slice(0, 500)}`));
const printErrTally = () => {
  if (!errCounts.size) return;
  console.log("── console.error tally:");
  for (const [k, n] of [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}× ${k.replaceAll("\n", " ")}`);
};
await page.evaluateOnNewDocument((project, irr) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (irr) globalThis.__giIrrTemporal = true;
}, PROJECT, IRR);
console.log(`opening ${PROJECT} … (IRR=${IRR ? 1 : 0})`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
// §12.66 RULE: SET THE POSE before judging any frame — a pose-less fresh
// profile frames a legitimately dark corner and reads black (that artifact
// consumed half a day). Same working pose as run-blackframe-verify.mjs.
await page.evaluate(async () => {
  await globalThis.__editorApi.call("viewport.setCamera", {
    position: [-5.6912, 2.7603, -0.5013], target: [0.4232, 3.4681, -1.0221],
  });
});
await wait(30000);

// One no-WebGPU verdict read: composited canvas + GI frame counter + ledger.
const readFrame = () => page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const shot = await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let black = 0, lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve({ blackFrac: +(black / (d.length / 4)).toFixed(4), meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4) });
    });
  });
  return {
    ...shot,
    giFrame: system?._frame ?? -1,
    hasIrrPass: !!system?.state?.screen?.irrTemporalPass,
    pendingPromises: globalThis.__giPendingComputePipelines?.size ?? -1,
    ledger: (globalThis.__giPipelineTimings ?? [])
      .filter((p) => /irrTemporal|irrHistory/.test(p.pass ?? ""))
      .map(({ pass, ms, rerolled }) => ({ pass, ms: ms === null ? "PENDING" : +ms.toFixed(0), rerolled: rerolled ?? 0 })),
  };
});

const armTag = IRR ? "irr-on" : "irr-off";
const t30 = await readFrame();
await page.screenshot({ path: `${OUT}/${armTag}-t30.png` });
console.log(`t30 ${JSON.stringify(t30)}`);
await wait(12000);
const t42 = await readFrame();
await page.screenshot({ path: `${OUT}/${armTag}-t42.png` });
console.log(`t42 ${JSON.stringify(t42)}`);
// meanLum-based (§12.66 verify: lit ≈ 0.31, black ≈ 0.0004): PP-on frames
// legitimately carry ~3.8% deep-shadow black pixels at this pose, so a
// blackFrac gate false-fails with the PP graph active.
const healthy = t42.meanLum > 0.15;
const ticking = t42.giFrame > t30.giFrame + 60;
console.log(`VERDICT: ${healthy ? "PASS" : "FAIL"} — screen ${healthy ? "lit" : "BLACK"}, loop ${ticking ? "ticking" : "STALLED"} (${t30.giFrame} → ${t42.giFrame})`);

// Phase B: on a black screen, bisect the POSTPROCESS chain — the camera's
// saved PP graph (input→ssr→gtao→output) is the prime suspect: the clear
// color itself never reaches the canvas, which is downstream of the beauty
// pass, and GI/canvas/loop are all healthy underneath.
if (!healthy) {
  // BISECT 3 (PP already exonerated by component.remove on a prior boot):
  // force occlusion culling OFF on the camera. Theory: the batched scene's
  // occluder depth pipeline is the ONE failing pipeline (empty fragment
  // output struct = the depth-only variant), the occlusion depth stays
  // empty, and everything culls — the OPEN occluder race wearing a new
  // costume. If the frame lights up here, occlusion is the killer.
  const occOff = await page.evaluate(async () => {
    const api = globalThis.__editorApi;
    try {
      const r = await api.call("component.setProp", {
        id: "KT0sShKBX-", type: "camera", key: "occlusionCulling", value: "off",
      });
      return { set: true, r: r?.occlusionCulling ?? r };
    } catch (e) {
      return { set: false, err: String(e?.message ?? e).slice(0, 200) };
    }
  });
  console.log(`occlusion-off ${JSON.stringify(occOff)}`);
  await wait(5000);
  const afterOcc = await readFrame();
  await page.screenshot({ path: `${OUT}/${armTag}-occ-off.png` });
  console.log(`after-occ-off ${JSON.stringify(afterOcc)} — ${afterOcc.blackFrac < 0.03 ? "OCCLUSION WAS THE KILLER (lit with culling off)" : "still black — occlusion exonerated too"}`);
}
printErrTally();
await browser.close();
process.exit(healthy ? 0 : 1);
