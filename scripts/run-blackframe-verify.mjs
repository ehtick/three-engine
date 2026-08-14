// ONE-OFF (2026-08-14, §12.66 RESOLVED): the "black fresh boot" is the
// correct render of the saved scene from the harness's DEFAULT camera pose —
// the user's healthy live editor renders the same near-black at that pose
// (MCP viewport A/B, 2026-08-14). Verification therefore checks what §12.66
// actually needs: a FRESH boot at the user's WORKING pose renders LIT with
// castShadow on and GI live, and the emitter seats. Delete with the dossier.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const POSE = { position: [-5.6912, 2.7603, -0.5013], target: [0.4232, 3.4681, -1.0221] };
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
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
await page.evaluateOnNewDocument((project, ppOff) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (ppOff) globalThis.__ppForceDisabled = true;
}, PROJECT, process.env.PPOFF === "1");
console.log(`opening ${PROJECT} … (PPOFF=${process.env.PPOFF === "1"})`);
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
await wait(8000);

const setPose = await page.evaluate(async (pose) => {
  try {
    await globalThis.__editorApi.call("viewport.setCamera", pose);
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).slice(0, 150) }; }
}, POSE);
console.log(`setCamera ${JSON.stringify(setPose)}`);
await wait(15000); // GI convergence window at the lit pose

const read = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const frame = await new Promise((resolve) => {
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
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  return {
    frame,
    castShadow: light?.castShadow ?? null,
    emitterSeats: (sys?._emitterInfos ?? []).filter(Boolean).length,
  };
});
const pass = read.frame.blackFrac < 0.03 && read.castShadow === true;
console.log(`${JSON.stringify(read)}`);
console.log(`VERDICT: ${pass ? "PASS" : "FAIL"} (blackFrac ${read.frame.blackFrac} < 0.03: ${read.frame.blackFrac < 0.03}, castShadow on: ${read.castShadow === true}, emitter seats: ${read.emitterSeats})`);
await browser.close();
process.exit(pass ? 0 : 1);
