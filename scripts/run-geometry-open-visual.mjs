// What happens to a mesh's UVs when you do nothing but OPEN it?
//
// `run-geometry-edit-visual.mjs` drives operators; this one deliberately drives
// none. It enters Edit Mode on several meshes, leaves again, and reports the UV
// statistics and the bytes on disk at each step. Entering is not read-only —
// `ensureGeometryAsset` makes a primitive single-user by round-tripping it
// through the kernel and writing a `.geom` — so "I only opened it" is a real
// write, and this is where a silent loss would land.
//
// Covers the shapes the reporter's own scene uses (box, sphere, plane) plus any
// real `.geom` handed in, copied into the scratch project so nothing here can
// touch the original.
//
// Env: HEADED=1, KEEP=1. URL as argv[2], extra .geom paths after that.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5199/";
const extraGeoms = process.argv.slice(3);
const ROOT = path.join(os.tmpdir(), "geo-open-visual").replaceAll("\\", "/");

/* -------------------------------------------------------------------------- */
/* Scratch project                                                             */
/* -------------------------------------------------------------------------- */

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

/** A checker with tinted quadrants, so a flipped or shifted island is obvious. */
function checkerPng(size = 256, cells = 8) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor((x / size) * cells) + Math.floor((y / size) * cells)) % 2 === 0;
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
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const subjects = [
  { id: "boxA", name: "Box", geometry: "box", asset: "" },
  { id: "sphereA", name: "Sphere", geometry: "sphere", asset: "" },
  { id: "planeA", name: "Plane", geometry: "plane", asset: "" },
  { id: "cylinderA", name: "Cylinder", geometry: "cylinder", asset: "" },
];

function writeProject() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "geometries"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "checker.png"), checkerPng());
  // MODULES=virtual-geometry,gi reproduces a project whose modules rewrite
  // `mesh.geometry` out from under the editor.
  fs.writeFileSync(path.join(ROOT, "project.json"), JSON.stringify({
    name: "GeoOpenVisual", version: 1, lastScene: "scenes/Geo.scene",
    modules: process.env.MODULES ? process.env.MODULES.split(",") : [],
  }, null, 2));
  fs.writeFileSync(path.join(ROOT, "Checker.mat"), JSON.stringify({
    color: "#ffffff", roughness: 0.75, metalness: 0, map: `${ROOT}/checker.png`, shaderGraph: null, pipeline: null,
  }, null, 2));

  extraGeoms.forEach((source, index) => {
    const base = path.basename(source);
    fs.copyFileSync(source, path.join(ROOT, "geometries", base));
    // The sidecar comes too: `virtualGeometry.enabled` lives there, and it is
    // the whole reason a mesh can be rendering something other than its asset.
    if (fs.existsSync(`${source}.meta`)) fs.copyFileSync(`${source}.meta`, path.join(ROOT, "geometries", `${base}.meta`));
    subjects.push({ id: `asset${index}`, name: base, geometry: "box", asset: `${ROOT}/geometries/${base}` });
  });

  const entity = (subject, position) => ({
    id: subject.id, name: subject.name, position, rotation: [0, 0, 0], scale: [1, 1, 1],
    viewOnly: false, enabledInEditor: true, enabledInGame: true,
    components: [{
      type: "mesh",
      props: {
        enabled: true, geometry: subject.geometry, geometryAsset: subject.asset,
        material: `${ROOT}/Checker.mat`, castShadow: true, receiveShadow: true,
      },
    }],
    children: [],
  });
  fs.writeFileSync(path.join(ROOT, "scenes", "Geo.scene"), JSON.stringify({
    version: 1,
    name: "Geo",
    settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
    entities: [
      ...subjects.map((subject, index) => entity(subject, [index * 3 - 4, 0, 0])),
      {
        id: "lightA", name: "Sun", position: [3, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "light", props: { enabled: true, type: "directional", intensity: 2, color: "#ffffff" } }],
        children: [],
      },
    ],
  }, null, 2));
}

const digest = (file) => (fs.existsSync(file) ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 10) : "-");

/** Triangles in the `.geom` on disk — the ground truth Edit Mode owes us. */
function assetTriangleCount(file) {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.byteLength >= 12 && buffer.readUInt32LE(0) === 0x4d4f4547) {
      const header = JSON.parse(buffer.slice(12, 12 + buffer.readUInt32LE(8)).toString("utf8"));
      return header.buffers?.indices ? header.buffers.indices.length / 3 : null;
    }
    return JSON.parse(buffer.toString("utf8")).indices.length / 3;
  } catch {
    return null;
  }
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
  if (m.type() === "error" && !/404|Failed to load resource/.test(t)) console.log(`  error: ${t}`);
  else if (m.type() === "warning" && /NaN|uv|UV|geometry/.test(t)) console.log(`  warn: ${t}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("  ** page navigated/reloaded **"); });

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  /**
   * A fingerprint of the mapping, not just of its validity.
   *
   * `pairs` is the set of distinct (position, uv) corners. A UV seam is two
   * pairs at one position; lose one and every face that used it silently
   * adopts the other island's mapping while every per-face sanity check still
   * passes. Comparing the set before and after is what catches that.
   */
  globalThis.__uvStats = (geometry) => {
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    if (!position || !uv) return { error: "no uv attribute" };
    const index = geometry.index;
    const count = index ? index.count / 3 : position.count / 3;
    const densities = [];
    let degenerate = 0;
    let nonFinite = 0;
    for (let i = 0; i < position.count; i++) {
      if (![position.getX(i), position.getY(i), position.getZ(i), uv.getX(i), uv.getY(i)].every(Number.isFinite)) nonFinite++;
    }
    const Q = 1e5;
    const pairs = new Set();
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
      for (const i of [a, b, c]) {
        pairs.add(`${Math.round(position.getX(i) * Q)},${Math.round(position.getY(i) * Q)},${Math.round(position.getZ(i) * Q)}`
          + `#${Math.round(uv.getX(i) * Q)},${Math.round(uv.getY(i) * Q)}`);
      }
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
      pairs: [...pairs],
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
console.log(`opened scratch project: ${opened.entities} entities\n`);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(4000);

/**
 * Runs an async step in the page WITHOUT holding a CDP promise across it.
 *
 * Anything that touches the project store ends up awaiting a `refresh()`, and
 * that routinely outlives the `page.evaluate` call that started it — puppeteer
 * then rejects with "Promise was collected" and the run dies for a reason that
 * has nothing to do with what is being measured. Kicking the work off, parking
 * the result on the page and polling for it sidesteps that entirely.
 */
async function probe(body, arg) {
  await page.evaluate((source, value) => {
    globalThis.__probe = { done: false, error: null, value: null };
    // eslint-disable-next-line no-new-func
    Promise.resolve(new Function(`return (${source})`)()(value))
      .then((result) => { globalThis.__probe.value = result; globalThis.__probe.done = true; })
      .catch((error) => { globalThis.__probe.error = String(error?.stack ?? error); globalThis.__probe.done = true; });
  }, body.toString(), arg ?? null);
  await page.waitForFunction(() => globalThis.__probe?.done, { timeout: 90000, polling: 200 });
  const { value, error } = await page.evaluate(() => ({ value: globalThis.__probe.value, error: globalThis.__probe.error }));
  if (error) throw new Error(error);
  return value;
}

const format = (s) => (s?.error
  ? s.error
  : `tris=${s.tris} NaN=${s.nonFinite} degen=${s.degenerate} pairs=${s.pairs.length}`
    + ` density ${s.min.toFixed(4)}..${s.max.toFixed(4)} (median ${s.median.toFixed(4)})`);

let failures = 0;
// ONLY=plane,cylinder narrows a re-run to the subjects still under suspicion.
const only = process.env.ONLY ? process.env.ONLY.toLowerCase().split(",") : null;
for (const subject of subjects.filter((s) => !only || only.some((n) => s.name.toLowerCase().includes(n)))) {
  console.log(`=== ${subject.name} ${subject.asset ? `(asset ${path.basename(subject.asset)})` : "(primitive)"}`);

  const before = await probe(async (id) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select([id]);
    if (!globalThis.__engine) {
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      globalThis.__engine = await ensureEngine();
    }
    const mesh = globalThis.__engine.getEntity(id)?.getComponent("mesh")?.mesh;
    return mesh ? globalThis.__uvStats(mesh.geometry) : { error: "no mesh" };
  }, subject.id);
  console.log(`    object mode : ${format(before)}`);
  const assetBefore = subject.asset ? digest(subject.asset) : "-";
  const trianglesBefore = subject.asset ? assetTriangleCount(subject.asset) : null;

  await page.evaluate((id) => {
    globalThis.__enter = { done: false, error: null };
    (async () => {
      const { ensureGeometryAsset } = await globalThis.__importLive("/src/editor/geometryEditing.js");
      const { useGeometryEditStore } = await globalThis.__importLive("/src/editor/store/geometryEditStore.js");
      await ensureGeometryAsset(id);
      useGeometryEditStore.getState().enter(id);
      globalThis.__enter.done = true;
    })().catch((error) => { globalThis.__enter.error = String(error); });
  }, subject.id);
  await page.waitForFunction(() => globalThis.__enter.done || globalThis.__enter.error, { timeout: 60000 });
  const enterError = await page.evaluate(() => globalThis.__enter.error);
  if (enterError) {
    console.log(`    ENTER FAILED: ${enterError}\n`);
    failures++;
    continue;
  }
  await page.waitForFunction(() => !!globalThis.__geometrySession, { timeout: 30000 });
  await settle(2000);

  const inside = await probe(async (id) => {
    const session = globalThis.__geometrySession;
    if (!session) return { fatal: "the geometry session never appeared" };
    if (!globalThis.__engine) {
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      globalThis.__engine = await ensureEngine();
    }
    const entity = globalThis.__engine.getEntity(id);
    if (!entity) return { fatal: `entity ${id} is gone` };
    return {
      edit: globalThis.__uvStats(session.meshObject.geometry),
      scene: globalThis.__uvStats(entity.getComponent("mesh").mesh.geometry),
      faces: session.mesh.faces.size,
      verts: session.mesh.verts.size,
      assetPath: entity.getComponent("mesh").props.geometryAsset,
    };
  }, subject.id);
  if (inside.fatal) {
    console.log(`    EDIT MODE FATAL: ${inside.fatal}
`);
    failures++;
    continue;
  }
  console.log(`    edit mode   : ${format(inside.edit)}   [${inside.verts} verts / ${inside.faces} faces]`);

  // ---- The header must stay ONE row and scroll, at any width, with its menus
  // still reachable. Squeezed deliberately: at 1280 it fits and proves nothing.
  await page.setViewport({ width: 900, height: 820, deviceScaleFactor: 1 });
  await settle(700);
  const header = await page.evaluate(() => {
    const bar = document.querySelector(".geometry-editor-toolbar");
    const scroll = document.querySelector(".geometry-editor-toolbar-scroll");
    if (!bar || !scroll) return { error: "no toolbar" };
    // Rows by vertical CENTRE with a tolerance, not by `top`: the children are
    // a mix of divs, spans and <details> whose heights differ by a pixel or
    // two, so distinct `top` values do not mean distinct rows.
    const items = [...scroll.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    const bands = [];
    for (const rect of items) {
      const centre = rect.top + rect.height / 2;
      if (!bands.some((band) => Math.abs(band - centre) < 8)) bands.push(centre);
    }
    return {
      rows: bands.length,
      height: Math.round(bar.getBoundingClientRect().height),
      overflow: scroll.scrollWidth - scroll.clientWidth,
      pinnedVisible: !!document.querySelector(".geometry-editor-toolbar-pinned .geometry-topology-count"),
    };
  });
  // A dropdown inside a scrolling box gets clipped unless it is positioned as
  // fixed; open one and confirm it is whole and on screen.
  const menu = await page.evaluate(() => {
    const details = document.querySelector(".geometry-toolbar-menu");
    if (!details) return { error: "no menu" };
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const popover = details.querySelector(".geometry-toolbar-popover");
    const rect = popover.getBoundingClientRect();
    const summary = details.querySelector("summary").getBoundingClientRect();
    details.open = false;
    return {
      height: Math.round(rect.height),
      onScreen: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      belowButton: rect.top >= summary.bottom - 1,
    };
  });
  if (process.env.SHOTS) {
    // Scrolled and CLICKED, not toggled from script: the point is that a menu
    // opened by hand out of a scrolled header lands somewhere usable.
    await page.evaluate(() => { document.querySelector(".geometry-editor-toolbar-scroll").scrollLeft = 220; });
    await settle(500);
    const summary = await page.evaluate(() => {
      const scroll = document.querySelector(".geometry-editor-toolbar-scroll").getBoundingClientRect();
      for (const details of document.querySelectorAll(".geometry-toolbar-menu")) {
        const rect = details.querySelector("summary").getBoundingClientRect();
        if (rect.left >= scroll.left && rect.right <= scroll.right) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: details.querySelector("summary").textContent };
        }
      }
      return null;
    });
    if (summary) {
      await page.mouse.click(summary.x, summary.y);
      await settle(600);
      await page.screenshot({ path: `scripts/geo-header-${subject.id}.png` });
      console.log(`    menu shot   : clicked "${summary.label}" in the scrolled header`);
      await page.mouse.click(summary.x, summary.y);
      await settle(300);
    }
  }
  const headerOk = !header.error && header.rows === 1 && header.pinnedVisible
    && !menu.error && menu.height > 20 && menu.onScreen && menu.belowButton;
  if (!headerOk) failures++;
  console.log(`    header      : ${header.rows} row(s), ${header.height}px tall, ${header.overflow}px scrollable,`
    + ` pinned=${header.pinnedVisible} | menu ${menu.height}px onScreen=${menu.onScreen} below=${menu.belowButton}`
    + ` ${headerOk ? "" : "  <-- BROKEN"}`);
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
  await settle(600);

  // ---- Orbiting has to turn the model, not swing it. The pivot must sit on
  // the geometry, whatever the viewport's own orbit target happened to be.
  const orbit = await probe(() => {
    const session = globalThis.__geometrySession;
    const geometry = session.meshObject.geometry;
    geometry.computeBoundingSphere();
    const centre = geometry.boundingSphere.center.clone().applyMatrix4(session.meshObject.matrixWorld);
    return {
      offset: centre.distanceTo(session.controls.target),
      radius: geometry.boundingSphere.radius,
    };
  });
  const orbitOk = orbit.offset <= Math.max(orbit.radius * 0.25, 1e-3);
  if (!orbitOk) failures++;
  console.log(`    orbit pivot : ${orbit.offset.toFixed(4)} from the mesh centre (radius ${orbit.radius.toFixed(3)})`
    + ` ${orbitOk ? "" : "  <-- NOT ON THE GEOMETRY"}`);

  // Material Preview so the screenshot shows the checker rather than clay.
  const canvas = await page.$(".geometry-editor-canvas");
  if (canvas) {
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    for (let step = 0; step < 4; step++) {
      if (await page.evaluate(() => globalThis.__geometrySession?.shading) === "material") break;
      await page.keyboard.press("z");
      await settle(400);
    }
    await page.keyboard.press("Home");
    await settle(1000);
    await page.screenshot({ path: `scripts/geo-open-${subject.id}.png` });
  }

  // EDIT=1 additionally runs one real operator, which is what triggers the
  // panel's autosave. That is the other half of the virtual-geometry story: the
  // cluster DAG cached for this asset indexes the triangles being replaced, so
  // saving has to drop it or the mesh goes back to rendering a LOD of the mesh
  // it used to be.
  if (process.env.EDIT && canvas) {
    await probe(async () => {
      const session = globalThis.__geometrySession;
      const { clearSelection, flushSelection } = await globalThis.__importLive("/src/editor/mesh/select.js");
      clearSelection(session.mesh);
      for (const face of [...session.mesh.faces].slice(0, 3)) face.select = true;
      flushSelection(session.mesh, "face");
      session.mode = "face";
      session.rebuild();
      return true;
    });
    await page.keyboard.press("i");
    await settle(300);
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.5 + 60, box.y + box.height * 0.5 - 40, { steps: 10 });
    await settle(300);
    await page.mouse.down();
    await page.mouse.up();
    await settle(3500);
    const edited = await probe(() => {
      const session = globalThis.__geometrySession;
      return { faces: session?.mesh?.faces?.size ?? 0, edit: globalThis.__uvStats(session.meshObject.geometry) };
    });
    console.log(`    after inset : ${format(edited.edit)}   [${edited.faces} faces]`);
    console.log(`    asset now   : ${digest(subject.asset)} (${assetTriangleCount(subject.asset)} tris)`);
  }

  await probe(async () => {
    const { useGeometryEditStore } = await globalThis.__importLive("/src/editor/store/geometryEditStore.js");
    useGeometryEditStore.getState().exit();
    return true;
  });
  await settle(2500);

  const after = await probe(async (id) => {
    if (!globalThis.__engine) {
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      globalThis.__engine = await ensureEngine();
    }
    const entity = globalThis.__engine.getEntity(id);
    const mesh = entity?.getComponent("mesh")?.mesh;
    return mesh ? globalThis.__uvStats(mesh.geometry) : { error: "no mesh" };
  }, subject.id);
  console.log(`    back out    : ${format(after)}`);

  const assetPath = inside.assetPath;
  if (assetPath) console.log(`    asset       : ${path.basename(assetPath)} ${assetBefore} -> ${digest(assetPath)}`);

  // Triangle count against the ASSET ON DISK, not against what the mesh was
  // rendering. A module may have swapped a derived geometry onto the mesh —
  // virtual geometry replaces the index buffer with the current LOD cut — and
  // comparing edit mode against that would call the derivation correct.
  if (subject.asset) {
    // `trianglesBefore`, not the count now: with EDIT=1 an operator has since
    // rewritten the file, and comparing against that would pass no matter what.
    const got = inside.edit.tris;
    const matches = trianglesBefore === null || trianglesBefore === got;
    if (!matches) failures++;
    console.log(`    ${matches ? "" : "WRONG MESH — "}asset had ${trianglesBefore} tris, edit mode opened ${got}`);
  }

  // The verdict. Opening is supposed to be a no-op: every (position, uv) pair
  // the mesh had must still be there, in Edit Mode and back in Object Mode.
  const baseline = new Set(before.pairs ?? []);
  const missingInEdit = (before.pairs ?? []).filter((pair) => !new Set(inside.edit.pairs ?? []).has(pair));
  const missingAfter = (before.pairs ?? []).filter((pair) => !new Set(after.pairs ?? []).has(pair));
  const ok = missingInEdit.length === 0 && missingAfter.length === 0
    && !inside.edit.nonFinite && !after.nonFinite;
  if (!ok) failures++;
  console.log(`    ${ok ? "OK" : "BROKEN"}: ${missingInEdit.length}/${baseline.size} pairs lost entering`
    + `, ${missingAfter.length}/${baseline.size} lost after leaving\n`);
}

console.log(failures ? `${failures} subject(s) BROKEN` : "opening left every mesh alone");
console.log("screenshots: scripts/geo-open-*.png");
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
