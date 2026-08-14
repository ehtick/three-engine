// ONE-OFF (2026-08-13): reproduce "viewport breaks when I select an object
// while the postprocess (SSR) chain is active" on the REAL GAME project.
// page.screenshot captures the INTERACTIVE canvas — the path the MCP
// viewport_screenshot bypasses (it renders its own clean frame), which is why
// the breakage never showed there. Delete when the bug is closed.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/outline-repro";
await mkdir(OUT, { recursive: true });
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 1600)}`);
  // Puppeteer reports console.warn as "warn" (older versions said "warning") —
  // matching one exact string silently ate every warn line for three runs.
  if (m.type().startsWith("warn") && /overlay|helper|Post-process|postprocess|\[pp\]/i.test(t)) console.log(`  console.warn: ${t.slice(0, 400)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 260)}`));
await page.evaluateOnNewDocument((project, ppDebug) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (ppDebug) globalThis.__ppOverlayDebug = ppDebug;
}, PROJECT, process.env.PP_DEBUG ?? "");

console.log(`opening ${PROJECT} …`);
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
const call = (op, args) => page.evaluate(
  async (o, a) => { try { return { ok: true, value: await globalThis.__editorApi.call(o, a) }; } catch (e) { return { ok: false, error: String(e) }; } },
  op, args,
);
await call("viewport.setCamera", { position: [6.2, 2.09, -0.37], target: [-6, 2, 0] });

// SHOW=1 (2026-08-13 evening): the user's new report — "no gizmos appear and
// selection still freezes" — is the PP-OWNS-THE-EDITOR-FRAME path
// (showInEditor: true), which every earlier verification left OFF (direct
// frames). Flip it here so the pipeline, not renderer.render, owns the frame.
if (process.env.SHOW === "1") {
  const r = await call("component.setProp", {
    id: "KT0sShKBX-", type: "postprocess", key: "showInEditor", value: true,
  });
  console.log(`showInEditor=true → ${r.ok ? "ok" : r.error}`);
}
console.log("settling out the compile wave…");
await wait(30000);
// Overlay-pass state probe: is the editor helper pass built and wired?
const dbg = await page.evaluate(() => {
  const api = globalThis.__editorApi;
  const ent = api.entities.live("KT0sShKBX-");
  const comp = ent?.getComponent?.("postprocess");
  const engine = ent?.engine;
  return {
    overlayNodeRegistered: typeof engine?.viewportOverlayNode,
    hasPipeline: !!comp?.pipeline,
    hasScenePass: !!comp?.scenePass,
    hasEditorOverlayPass: !!comp?.editorOverlayPass,
    renderCameraIsEngineCamera: comp?.renderCamera === engine?.camera,
    owns: !!comp?.ownsCamera?.(engine),
    overlayTicks: globalThis.__ppOverlayTicks ?? 0,
  };
});
console.log(`overlay state: ${JSON.stringify(dbg)}`);
const t2 = await page.evaluate(() => globalThis.__ppOverlayTicks ?? 0);
await new Promise((r) => setTimeout(r, 1000));
const t3 = await page.evaluate(() => globalThis.__ppOverlayTicks ?? 0);
console.log(`overlay ticks: ${t2} → ${t3} over 1s (${t3 - t2}/s ≈ pass renders per second)`);
await page.screenshot({ path: `${OUT}/1-before-selection.png` });

// Select a SEQUENCE of different objects — the user's "whenever I select
// another object". Watch the canvas across the next seconds after each: the
// report is that the viewport breaks and STAYS broken.
const list = await call("entity.list", {});
const byName = (n) => (list.value ?? []).find((e) => e.name === n)?.id;
const targets = [
  ["Physics Playground", "uE6zxZlqQr"],
  ["Mesh", byName("Mesh")],
  ["sponza_12", byName("sponza_12")],
].filter(([, id]) => id);
let step = 2;
for (const [name, id] of targets) {
  const sel = await call("selection.set", { ids: [id] });
  console.log(`select ${name} → ${sel.ok ? "ok" : sel.error}`);
  await wait(2500);
  await page.screenshot({ path: `${OUT}/${step}-selected-${name.replaceAll(" ", "_")}.png` });
  step++;
}
await call("selection.set", { ids: [] });
await wait(3000);
await page.screenshot({ path: `${OUT}/${step}-deselected.png` });
step++;
// Discriminator: the SAME selection on a DIRECT frame. If the gizmo/grid
// appear here but not on PP frames, helpers exist and the in-pipeline
// composite is at fault; if they are missing here too, the harness itself
// never attaches/shows them and PP shots prove nothing about the overlay.
if (process.env.SHOW === "1") {
  await call("component.setProp", {
    id: "KT0sShKBX-", type: "postprocess", key: "showInEditor", value: false,
  });
  await wait(2000);
  const meshId = byName("Mesh");
  if (meshId) await call("selection.set", { ids: [meshId] });
  await wait(2500);
  await page.screenshot({ path: `${OUT}/${step}-direct-selected.png` });
}
console.log(`shots → ${OUT}`);
await browser.close();
