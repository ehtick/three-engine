// Capture our renderer's frame at a fixed pose, to a PNG, for comparison
// against an external reference render.
//
//   npx vite --port 5201
//   node scripts/run-gi-capture-pose.mjs
//   WIDTH=2341 HEIGHT=1389 SETTLE=40000 QUALITY=medium node scripts/run-gi-capture-pose.mjs
//
// Split out from the comparison itself on purpose: booting the user's 1699-entity
// scene and settling GI costs about two minutes, and the patch coordinates in a
// cross-renderer comparison always need two or three iterations to land on the
// right materials. Capture once, compare as often as needed.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 40000);
const QUALITY = process.env.QUALITY ?? "medium";
// The reference is 2341x1389 (aspect 1.686). Matching the ASPECT matters — the
// vertical FOV is fixed, so a different aspect reframes horizontally and the
// patches stop corresponding.
const WIDTH = Number(process.env.WIDTH ?? 1404);
const HEIGHT = Number(process.env.HEIGHT ?? 833);
const OUT = process.env.OUT ?? ".gi-shots/compare";
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── THE REFERENCE CAMERA, CONVERTED ────────────────────────────────────────
//
// Blender is Z-UP and right-handed; three is Y-UP. The glTF convention maps
//   three.x = blender.x,  three.y = blender.z,  three.z = -blender.y
// and the same map applies to a direction vector.
//
// Blender camera: loc (-15, 0, 6), XYZ Euler (78, 0, -90), FOV 80 deg.
// A Blender camera looks down its LOCAL -Z, and "XYZ Euler" composes as
// R = Rz·Ry·Rx, so forward_blender = Rz(-90)·Ry(0)·Rx(78)·(0,0,-1)
//                                  = (0.97815, 0, -0.20791).
//
// ⚠ FOV IS HORIZONTAL IN BLENDER (sensor fit auto on a landscape frame) and
// VERTICAL in three. At the reference's 16:9 that is 80 deg -> 50.54 deg, and
// getting this backwards would reframe the whole comparison while still looking
// superficially plausible.
const REF_ASPECT = Number(process.env.REF_ASPECT ?? 1920 / 1080);
const HFOV_DEG = Number(process.env.HFOV ?? 80);
const VFOV_DEG = (2 * Math.atan(Math.tan((HFOV_DEG * Math.PI) / 360) / REF_ASPECT) * 180) / Math.PI;
const FORWARD = [0.97815, -0.20791, 0];
const POSE = {
  position: [-15, 6, 0],
  target: [-15 + FORWARD[0] * 15, 6 + FORWARD[1] * 15, 0 + FORWARD[2] * 15],
  fov: VFOV_DEG,
};
// Blender sun rotation (0,0,0) points straight DOWN; the same direction in this
// engine is (-90, 0, 0). The scene's own light sits at -80 deg, and the 10 deg
// matters more than it sounds: at exactly overhead a vertical facade receives
// ZERO direct sun and every bit of its colour is bounce, while at -80 it gets
// ~17% direct white light that dilutes the tint. Overridden in-page only — the
// tauri shim refuses writes, so the scene file cannot change.
const SUN_DEG = Number(process.env.SUN_DEG ?? -90);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene|refusing write|rapier/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 160)}`);
});
await page.evaluateOnNewDocument((project, quality) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (quality) globalThis.__giConfigOverride = { quality };
}, PROJECT, QUALITY);

console.log(`opening ${PROJECT} (read-only) at ${WIDTH}x${HEIGHT}, quality ${QUALITY}`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 300 && !built; i++) {
  await wait(1000);
  if (i % 20 === 19) console.log(`  waiting for the GI build… ${i + 1}s`);
}
if (!built) throw new Error("the GI build never completed");
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
const setup = await page.evaluate(async (p, sunDeg) => {
  const api = globalThis.__editorApi;
  // ⚠ `viewport.setCamera` takes POSITION AND TARGET ONLY — passing `fov` fails
  // schema validation outright (registry.js validateArgs). The vertical FOV has
  // to be written on the live camera, and `updateProjectionMatrix` is what makes
  // it take effect; without that call the frame renders at the old FOV and the
  // comparison silently compares two different fields of view.
  await api.call("viewport.setCamera", { position: p.position, target: p.target });
  // Match the reference's sun. Written on the entity's Object3D rather than
  // through an op, so nothing enters the undo stack or the dirty flag.
  const ids = await api.call("entity.list", {});
  const list = ids.value ?? ids;
  let engine = null;
  for (const row of list) { engine = api.entities.live(row.id)?.engine; if (engine) break; }
  if (engine?.camera && p.fov) {
    engine.camera.fov = p.fov;
    engine.camera.updateProjectionMatrix();
  }
  let found = null;
  for (const row of list) {
    const live = api.entities.live(row.id);
    const obj = live?.object3D;
    if (!obj) continue;
    let isSun = false;
    obj.traverse?.((o) => { if (o.isDirectionalLight) isSun = true; });
    if (!isSun) continue;
    obj.rotation.set((sunDeg * Math.PI) / 180, 0, 0);
    obj.updateMatrixWorld(true);
    found = { name: row.name ?? row.id, rotX: obj.rotation.x };
  }
  return { sun: found, fov: engine?.camera?.fov ?? null, aspect: engine?.camera?.aspect ?? null };
}, POSE, SUN_DEG);
console.log(`sun -> ${JSON.stringify(setup.sun)}   camera fov ${setup.fov} aspect ${setup.aspect}`);
console.log(`settling ${(SETTLE / 1000).toFixed(0)}s…`);
await wait(SETTLE);

// The renderer's own canvas, not a page screenshot: a page shot includes the
// editor chrome, and every patch coordinate would then be measured against a
// layout rather than against the frame.
const dataUrl = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const engine = api.entities.live((ids.value ?? ids)?.[0]?.id)?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      resolve(c.toDataURL("image/png"));
    });
  });
});
await browser.close();

const raw = path.join(OUT, "ours-raw.png");
writeFileSync(raw, Buffer.from(dataUrl.split(",")[1], "base64"));

// ── CROP TO THE REFERENCE'S ASPECT ─────────────────────────────────────────
//
// The editor's viewport is a DOCKED PANEL, so its aspect is whatever the layout
// gives (2.26 last time) and cannot be dialled to 16:9 directly. But three's
// `fov` is VERTICAL: setting it to the reference's vertical FOV makes the
// vertical extent already correct, and a centred horizontal crop to the
// reference's aspect then reproduces its horizontal extent exactly. Same camera,
// same field of view, same framing — which is what makes a per-pixel comparison
// meaningful instead of a patch-placement exercise.
const sharp = (await import("sharp")).default;
const meta = await sharp(raw).metadata();
const cropW = Math.min(meta.width, Math.round(meta.height * REF_ASPECT));
const cropH = Math.min(meta.height, Math.round(cropW / REF_ASPECT));
const left = Math.round((meta.width - cropW) / 2);
const top = Math.round((meta.height - cropH) / 2);
const file = path.join(OUT, "ours.png");
await sharp(raw).extract({ left, top, width: cropW, height: cropH }).png().toFile(file);
console.log(
  `captured ${meta.width}x${meta.height} (aspect ${(meta.width / meta.height).toFixed(3)}), ` +
  `vertical fov ${VFOV_DEG.toFixed(2)}deg -> cropped ${cropW}x${cropH} (aspect ${(cropW / cropH).toFixed(3)})`,
);
console.log(`wrote ${file}`);
