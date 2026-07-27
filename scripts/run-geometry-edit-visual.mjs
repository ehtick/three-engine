// What actually happens when you press Tab on a textured mesh?
//
// The kernel tests can only answer "did a face come back with a valid UV". They
// cannot answer "does the texture look the same before and after", which is the
// form every UV report arrives in. This drives the REAL editor — real project,
// real Tab, real operators — through the Tauri shim, and reports the two things
// area tests keep missing:
//
//   * where the camera ended up, versus where it was in Object Mode
//   * the per-face UV density of the mesh the editor is actually holding,
//     before and after entering edit mode and after each operator
//
// plus screenshots in Material Preview so a checker can be looked at.
//
// A scratch project is built from scratch each run (the shim only permits
// writes inside it), so nothing here can touch the user's own files.
//
// Env: HEADED=1, KEEP=1 (leave the scratch project behind). URL as argv[2].
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5199/";
const ROOT = path.join(os.tmpdir(), "geo-edit-visual").replaceAll("\\", "/");

/* -------------------------------------------------------------------------- */
/* Scratch project                                                             */
/* -------------------------------------------------------------------------- */

/** Minimal PNG encoder — a checker with a differently coloured quadrant. */
function checkerPng(size = 256, cells = 8) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor((x / size) * cells) + Math.floor((y / size) * cells)) % 2 === 0;
      // Quadrants are tinted so a mirrored or rotated mapping is obvious.
      const right = x > size / 2;
      const bottom = y > size / 2;
      const tint = right ? (bottom ? [255, 90, 90] : [90, 255, 120]) : (bottom ? [110, 150, 255] : [245, 245, 245]);
      raw[at++] = dark ? tint[0] : 24;
      raw[at++] = dark ? tint[1] : 24;
      raw[at++] = dark ? tint[2] : 24;
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeInt32BE(crc(Buffer.concat([Buffer.from(type, "ascii"), data])), data.length + 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0;
}

function writeProject() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "checker.png"), checkerPng());
  fs.writeFileSync(path.join(ROOT, "project.json"), JSON.stringify({ name: "GeoEditVisual", version: 1, lastScene: "scenes/Geo.scene", modules: [] }, null, 2));
  fs.writeFileSync(path.join(ROOT, "Checker.mat"), JSON.stringify({
    color: "#ffffff", roughness: 0.75, metalness: 0, map: `${ROOT}/checker.png`, shaderGraph: null, pipeline: null,
  }, null, 2));
  const entity = (id, name, geometry, position) => ({
    id, name, position, rotation: [0, 0, 0], scale: [1, 1, 1],
    viewOnly: false, enabledInEditor: true, enabledInGame: true,
    components: [{ type: "mesh", props: { enabled: true, geometry, geometryAsset: "", material: `${ROOT}/Checker.mat`, castShadow: true, receiveShadow: true } }],
    children: [],
  });
  fs.writeFileSync(path.join(ROOT, "scenes", "Geo.scene"), JSON.stringify({
    version: 1,
    name: "Geo",
    settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
    entities: [
      entity("boxA", "Box", "box", [0, 0, 0]),
      { ...entity("lightA", "Sun", "box", [3, 5, 4]), components: [{ type: "light", props: { enabled: true, type: "directional", intensity: 2, color: "#ffffff" } }] },
    ],
  }, null, 2));
}

/* -------------------------------------------------------------------------- */

writeProject();
const scenePath = `${ROOT}/scenes/Geo.scene`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT, verbose: !!process.env.VERBOSE });
page.on("console", (m) => {
  const t = m.text();
  if (/GEO-/.test(t)) console.log(t);
  else if (m.type() === "error" && !/404|Failed to load resource|Computed radius is NaN/.test(t)) console.log(`  error: ${t}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  // Density statistics for the geometry a mesh is really rendering.
  globalThis.__uvStats = (geometry) => {
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    if (!position || !uv) return { error: "no uv attribute" };
    const index = geometry.index;
    const count = index ? index.count / 3 : position.count / 3;
    const densities = [];
    let degenerate = 0;
    // Counted explicitly: a NaN fails every comparison, so a triangle full of
    // them slips past both the degenerate test and the density list and the
    // summary comes back looking perfect.
    let nonFinite = 0;
    for (let i = 0; i < position.count; i++) {
      if (![position.getX(i), position.getY(i), position.getZ(i), uv.getX(i), uv.getY(i)].every(Number.isFinite)) nonFinite++;
    }
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
      const uvArea = Math.abs(
        (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a)),
      ) / 2;
      const p = [a, b, c].map((i) => [position.getX(i), position.getY(i), position.getZ(i)]);
      const ab = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const ac = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const world = Math.hypot(
        ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0],
      ) / 2;
      if (uvArea < 1e-12) degenerate++;
      if (world > 1e-12) densities.push(uvArea / world);
    }
    densities.sort((x, y) => x - y);
    return {
      tris: count,
      nonFinite,
      degenerate,
      min: densities[0] ?? 0,
      median: densities[Math.floor(densities.length / 2)] ?? 0,
      max: densities[densities.length - 1] ?? 0,
    };
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

const opened = await page.evaluate(async ({ ROOT, scenePath }) => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  await useProjectStore.getState().openProject(ROOT);
  const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
  await openScenePath(scenePath);
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  return { entities: globalThis.__engine.entities.size };
}, { ROOT, scenePath });
console.log(`opened scratch project: ${opened.entities} entities`);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(4000);

const format = (s) => (s?.error
  ? s.error
  : `tris=${s.tris} NaN-verts=${s.nonFinite} degenerate=${s.degenerate} density ${s.min.toFixed(4)}..${s.max.toFixed(4)} (median ${s.median.toFixed(4)})`);

// ---- Object Mode baseline
const before = await page.evaluate(async () => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().select(["boxA"]);
  // A pose nothing would pick by accident, so "held" cannot be a coincidence:
  // far out, off to one side, and orbiting a target that is not the object.
  globalThis.__viewport.camera.position.set(-4.5, 11.25, 2.75);
  globalThis.__viewport.orbit.target.set(1.5, -0.75, -0.5);
  globalThis.__viewport.orbit.update();
  const entity = globalThis.__engine.getEntity("boxA");
  const viewport = globalThis.__viewport;
  return {
    uv: globalThis.__uvStats(entity.getComponent("mesh").mesh.geometry),
    camera: viewport?.camera?.position?.toArray(),
    target: viewport?.orbit?.target?.toArray(),
  };
});
console.log(`\nOBJECT MODE  uv: ${format(before.uv)}`);
console.log(`             camera ${before.camera?.map((v) => v.toFixed(3))} -> target ${before.target?.map((v) => v.toFixed(3))}`);
await page.screenshot({ path: "scripts/geo-visual-0-object.png" });

// ---- Tab into edit mode, exactly as the viewport shortcut does
// Kicked off without awaiting the evaluate: the asset write goes through the
// project store's refresh, which can outlive the CDP call and leave puppeteer
// holding a promise the page has already collected.
await page.evaluate(() => {
  globalThis.__enter = { done: false, error: null };
  (async () => {
    const { ensureGeometryAsset } = await globalThis.__importLive("/src/editor/geometryEditing.js");
    const { useGeometryEditStore } = await globalThis.__importLive("/src/editor/store/geometryEditStore.js");
    await ensureGeometryAsset("boxA");
    useGeometryEditStore.getState().enter("boxA");
    globalThis.__enter.done = true;
  })().catch((error) => { globalThis.__enter.error = String(error); });
});
await page.waitForFunction(() => globalThis.__enter.done || globalThis.__enter.error, { timeout: 60000 });
const enterError = await page.evaluate(() => globalThis.__enter.error);
if (enterError) throw new Error(`entering edit mode failed: ${enterError}`);
await page.waitForFunction(() => !!globalThis.__geometrySession, { timeout: 30000 });
await settle(2500);

const entered = await page.evaluate(() => {
  const session = globalThis.__geometrySession;
  const entity = globalThis.__engine.getEntity("boxA");
  return {
    editUV: globalThis.__uvStats(session.meshObject.geometry),
    sceneUV: globalThis.__uvStats(entity.getComponent("mesh").mesh.geometry),
    camera: session.camera.position.toArray(),
    target: session.controls.target.toArray(),
    faces: session.mesh.faces.size,
  };
});
const drift = Math.hypot(...entered.camera.map((v, i) => v - before.camera[i]));
console.log(`\nEDIT MODE    faces=${entered.faces}`);
console.log(`             edit mesh  uv: ${format(entered.editUV)}`);
console.log(`             scene mesh uv: ${format(entered.sceneUV)}`);
console.log(`             camera ${entered.camera.map((v) => v.toFixed(3))} -> target ${entered.target.map((v) => v.toFixed(3))}`);
console.log(`             CAMERA DRIFT ${drift.toFixed(4)} ${drift < 1e-3 ? "(held)" : "(MOVED)"}`);

// Material Preview, so the screenshots show the checker rather than clay.
const canvas = await page.$(".geometry-editor-canvas");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
for (let step = 0; step < 4; step++) {
  const shading = await page.evaluate(() => globalThis.__geometrySession?.shading);
  if (shading === "material") break;
  await page.keyboard.press("z");
  await settle(400);
}
await settle(1200);
await page.screenshot({ path: "scripts/geo-visual-1-edit.png" });
// Only now that the camera has been checked: frame the mesh so the operator
// screenshots below are actually big enough to read a checker off.
await page.keyboard.press("Home");
await settle(900);
console.log(`             shading=${await page.evaluate(() => globalThis.__geometrySession?.shading)}`);

/** Runs one operator through the panel's own keyboard path and reports it. */
async function operator(label, keys, drag) {
  await page.evaluate(() => {
    const session = globalThis.__geometrySession;
    // Whole-mesh selection in the mode the operator needs is set below.
    return session;
  });
  for (const key of keys) {
    if (key.includes("+")) {
      const [modifier, main] = key.split("+");
      await page.keyboard.down(modifier);
      await page.keyboard.press(main);
      await page.keyboard.up(modifier);
    } else await page.keyboard.press(key);
  }
  await settle(300);
  if (drag) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.5 + drag[0], box.y + box.height * 0.5 + drag[1], { steps: 12 });
    await settle(300);
    await page.mouse.down();
    await page.mouse.up();
  }
  await settle(900);
  const stats = await page.evaluate(() => globalThis.__uvStats(globalThis.__geometrySession.meshObject.geometry));
  console.log(`\n${label.padEnd(12)} uv: ${format(stats)}`);
  await page.screenshot({ path: `scripts/geo-visual-${label.toLowerCase()}.png` });
  return stats;
}

// Select one face and inset it.
await page.evaluate(async () => {
  const session = globalThis.__geometrySession;
  const { clearSelection, flushSelection } = await globalThis.__importLive("/src/editor/mesh/select.js");
  const { faceCenter } = await globalThis.__importLive("/src/editor/mesh/bmesh.js");
  clearSelection(session.mesh);
  const top = [...session.mesh.faces].find((f) => faceCenter(f)[1] > 0.4);
  top.select = true;
  flushSelection(session.mesh, "face");
  session.mode = "face";
  session.rebuild();
});
await operator("2-inset", ["i"], [90, -60]);

// Undo, then bevel every edge.
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await settle(600);
await page.evaluate(async () => {
  const session = globalThis.__geometrySession;
  const { flushSelection } = await globalThis.__importLive("/src/editor/mesh/select.js");
  for (const edge of session.mesh.edges) edge.select = true;
  flushSelection(session.mesh, "edge");
  session.mode = "edge";
  session.rebuild();
});
await operator("3-bevel", ["Control+b"], [60, -40]);

console.log("\nscreenshots: scripts/geo-visual-*.png");
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
