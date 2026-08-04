// UI VISUAL CHECK — is UI in the RIGHT PLACE after the single-pass rework?
//
// The smoke's pixel probe reads one centre pixel, which a wrong screen-space
// mapping can still satisfy. This shoots the real viewport in both modes and
// writes PNGs to look at:
//
//   ui-visual-edit.png   editing — a screen-space canvas drawn as a world plane
//   ui-visual-play.png   Play    — the same canvas as a HUD overlay
//
// The probe screen deliberately anchors panels to two OPPOSITE CORNERS, because
// that is what a bad NDC map gets wrong in an obvious way — centred content
// survives a sign flip, a corner does not.
//
// Anchors are y-DOWN here: [0,0] is top-left and [1,1] is bottom-right (see
// computeElementRect in engine/ui/layout.js). Getting that backwards makes a
// correct render look mirrored, which cost a round of head-scratching.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-ui-visual.mjs
//
// Env: PROJECT, OUT=<dir>, HEADED=1
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const OUT = process.env.OUT ?? "scratch";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

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
page.on("pageerror", (e) => {
  const t = (e.stack ?? e.message).slice(0, 200);
  if (!/save_scene/.test(t)) console.log(`  pageerror: ${t}`); // autosave vs read-only shim: expected
});

await page.evaluateOnNewDocument((PROJECT) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
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

for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) break;
  await wait(1000);
}
await wait(15000);
for (let i = 0; i < 120; i++) {
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  await wait(1000);
}
await wait(4000);

const root = await must("entity.create", {
  name: "Visual Screen",
  components: [{ type: "uiscreen", props: { renderMode: "screen" } }],
});
const panel = await must("entity.create", {
  name: "Visual Panel",
  parentId: root.id,
  components: [
    { type: "uielement", props: { anchorMin: [0, 0], anchorMax: [0, 0], pivot: [0, 0], pos: [24, 24], size: [280, 64] } },
    { type: "uiimage", props: { color: "#12d17a", opacity: 0.95, cornerRadius: 10, borderWidth: 2, borderColor: "#ffffff" } },
  ],
});
await must("entity.create", {
  name: "Visual Label",
  parentId: panel.id,
  components: [
    { type: "uielement", props: { anchorMin: [0, 0], anchorMax: [1, 1], pos: [0, 0], size: [0, 0] } },
    { type: "uitext", props: { text: "TOP LEFT", fontSize: 28, color: "#00131f", outlineWidth: 0 } },
  ],
});
// Bottom-right too: one corner proves the sign, two prove the scale.
const panel2 = await must("entity.create", {
  name: "Visual Panel BR",
  parentId: root.id,
  components: [
    { type: "uielement", props: { anchorMin: [1, 1], anchorMax: [1, 1], pivot: [1, 1], pos: [-24, -24], size: [280, 64] } },
    { type: "uiimage", props: { color: "#ff4d6d", opacity: 0.95, cornerRadius: 10 } },
  ],
});
await must("entity.create", {
  name: "Visual Label BR",
  parentId: panel2.id,
  components: [
    { type: "uielement", props: { anchorMin: [0, 0], anchorMax: [1, 1], pos: [0, 0], size: [0, 0] } },
    { type: "uitext", props: { text: "BOTTOM RIGHT", fontSize: 24, color: "#ffffff" } },
  ],
});
await wait(3000);

const shoot = async (name) => {
  const shot = await call("viewport.screenshot", {});
  const data = shot.value?.data ?? shot.value?.base64 ?? shot.value;
  if (!shot.ok || typeof data !== "string") {
    console.log(`  ${name}: screenshot op failed (${shot.error ?? typeof shot.value}) — falling back to page.screenshot`);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  }
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data.replace(/^data:image\/\w+;base64,/, ""), "base64"));
  return file;
};

console.log(`  edit mode → ${await shoot("ui-visual-edit")}`);

const play = await call("play.set", { playing: true });
if (play.ok) {
  await wait(6000);
  console.log(`  play mode → ${await shoot("ui-visual-play")}`);
  await call("play.set", { playing: false });
  await wait(2000);
} else {
  console.log(`  play.set failed: ${play.error}`);
}

for (const id of [root.id]) await call("entity.delete", { id });
await browser.close();
process.exit(0);
