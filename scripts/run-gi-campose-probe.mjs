// ONE-OFF PROBE (dev scratch): boot the real project exactly as run-gi-sponza
// does, then WITHOUT touching the camera report what the editor restored
// (viewport.getCamera) plus the sponza entity's reported bounds, and dump a
// screenshot of that restored view. Answers "what pose should the harness
// hardcode" with data instead of heuristics.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const OUT = process.env.OUT ?? path.join(process.env.TEMP ?? "/tmp", "gi-campose.png");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] auto-fit bounds/.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (/\[gi\] built/.test(t)) built = true;
});
await page.evaluateOnNewDocument(({ PROJECT }) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, { PROJECT });
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
    try {
      return { ok: true, value: await globalThis.__editorApi.call(op, args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, { op, args });

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
console.log(`  ${entities.length} entities`);
for (let i = 0; i < 60 && !built; i++) await wait(1000);
await wait(8000);

// Lit sun first — the saved scene's own sun angle can leave the interior
// black, and a black probe frame answers nothing.
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
const sun = entities.find((e) => {
  const l = componentOf(e, "light");
  return l && (l.props?.kind ?? "directional") === "directional";
});
if (sun) await call("entity.setTransform", { id: sun.id, rotation: [(55 * Math.PI) / 180, 0.35, 0] });
await wait(3000);

// Pose derived from the test sphere (root "Mesh" with the smallest radius —
// the sphere is r≈0.66 vs the Cornell group's 4.3): stand 5m east of it at
// eye height, look west down the nave past it at the curtain colonnade.
// Then try several sun pitches from that one pose — the LIT config must
// actually light the atrium interior, which pitch 55 barely does.
const meshes = entities.filter((e) => /^mesh$/i.test(e.name ?? "") && componentOf(e, "mesh"));
let sphere = null, sphereB = null;
for (const m of meshes) {
  const b = await call("entity.getBounds", { id: m.id });
  if (b.ok && (!sphereB || b.value.radius < sphereB.radius)) { sphere = m; sphereB = b.value; }
}
if (!sphere) { console.log("no sphere candidate"); await browser.close(); process.exit(1); }
const s = sphereB.center;
console.log("sphere:", JSON.stringify(s), "r", sphereB.radius.toFixed(2));
const pos = [s[0] + 5, 2.2, s[2] + 1.2];
const look = [s[0] - 10, 1.0, s[2] - 1.0];
await call("viewport.setCamera", { position: pos, target: look });
console.log("pose:", JSON.stringify({ pos, look }));
for (const pitch of [55, 75, 88, 105]) {
  await call("entity.setTransform", { id: sun.id, rotation: [(pitch * Math.PI) / 180, 0.35, 0] });
  await wait(2500);
  const shot = await call("viewport.screenshot", { width: 900, height: 600, includeGizmos: false });
  if (shot.ok && shot.value?.__image?.base64) {
    const file = OUT.replace(/\.png$/, `-p${pitch}.png`);
    await writeFile(file, Buffer.from(shot.value.__image.base64, "base64"));
    console.log(`pitch ${pitch} ->`, file);
  }
}
await browser.close();
