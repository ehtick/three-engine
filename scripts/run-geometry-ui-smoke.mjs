// The geometry editor's header and transform modes, driven through the REAL
// editor.
//
// These are the things the kernel tests cannot see. "Does the Mesh menu open
// under the Mesh button" is a question about a `backdrop-filter` on an ancestor
// creating a containing block for a fixed-position child; "does the magnet
// snap" is a question about whether a screen-space search finds an element a
// full unit away. Both had shipped broken, and both are invisible to anything
// that does not open the panel and click.
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5199/";
const ROOT = path.join(os.tmpdir(), "geo-ui-smoke").replaceAll("\\", "/");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

/* -------------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "project.json"), JSON.stringify({ name: "GeoUiSmoke", version: 1, lastScene: "scenes/Geo.scene", modules: [] }, null, 2));
const meshEntity = (id, name, position) => ({
  id, name, position, rotation: [0, 0, 0], scale: [1, 1, 1],
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{ type: "mesh", props: { enabled: true, geometry: "box", geometryAsset: "", material: "", castShadow: true, receiveShadow: true } }],
  children: [],
});
fs.writeFileSync(path.join(ROOT, "scenes", "Geo.scene"), JSON.stringify({
  version: 1, name: "Geo",
  settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
  // A second mesh so the Modifier menu's boolean target has a candidate.
  entities: [meshEntity("boxA", "Box", [0, 0, 0]), meshEntity("boxB", "Cutter", [0.6, 0.6, 0])],
}, null, 2));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) console.log(`  console error: ${m.text()}`);
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(async ({ ROOT }) => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  await useProjectStore.getState().openProject(ROOT);
  const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
  await openScenePath(`${ROOT}/scenes/Geo.scene`);
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
}, { ROOT });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(3500);

await page.evaluate(() => {
  globalThis.__enter = { done: false, error: null };
  (async () => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select(["boxA"]);
    const { ensureGeometryAsset } = await globalThis.__importLive("/src/editor/geometryEditing.js");
    const { useGeometryEditStore } = await globalThis.__importLive("/src/editor/store/geometryEditStore.js");
    await ensureGeometryAsset("boxA");
    useGeometryEditStore.getState().enter("boxA");
    globalThis.__enter.done = true;
  })().catch((e) => { globalThis.__enter.error = String(e); });
});
await page.waitForFunction(() => globalThis.__enter.done || globalThis.__enter.error, { timeout: 60000 });
const enterError = await page.evaluate(() => globalThis.__enter.error);
if (enterError) throw new Error(`entering edit mode failed: ${enterError}`);
await page.waitForFunction(() => !!globalThis.__geometrySession, { timeout: 30000 });
await settle(2500);

const canvas = await page.$(".geometry-editor-canvas");
const box = await canvas.boundingBox();
const centre = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
await page.mouse.click(centre.x, centre.y);   // focus, so the panel keymap receives keys
await settle(400);

/* -------------------------------------------------------------------------- */
/* Header menus                                                                */
/* -------------------------------------------------------------------------- */

console.log("\nheader menus");

const menuNames = await page.evaluate(() =>
  [...document.querySelectorAll(".geometry-toolbar-menu-summary")].map((s) => s.textContent.trim()));
check("every Blender header menu is present", ["Select", "Add", "Mesh", "Vertex", "Edge", "Face", "UV", "Modifier", "View"].every((n) => menuNames.includes(n)), menuNames.join(", "));

const menuButton = (name) => page.evaluateHandle((n) =>
  [...document.querySelectorAll(".geometry-toolbar-menu-summary")].find((s) => s.textContent.trim() === n), name);

/** Named, not indexed: the header's menu list changes with the select mode
 *  (Material exists only in face mode), so an index goes stale mid-run. */
const clickMenu = async (name) => {
  const handle = await menuButton(name);
  await handle.click();
  await settle(220);
};

/** Anchoring: the popover's top-left must track its own button. */
let worstDrift = 0;
for (const name of ["Select", "Add", "Transform", "Mesh", "Vertex", "Edge", "Face", "UV"]) {
  await clickMenu(name);
  const geometry = await page.evaluate((n) => {
    const summary = [...document.querySelectorAll(".geometry-toolbar-menu-summary")].find((s) => s.textContent.trim() === n).getBoundingClientRect();
    const popover = document.querySelector(".geometry-toolbar-popover")?.getBoundingClientRect();
    return popover && {
      dx: popover.left - summary.left,
      dy: popover.top - summary.bottom,
      open: document.querySelectorAll(".geometry-toolbar-popover").length,
      onScreen: popover.right <= window.innerWidth + 1 && popover.bottom <= window.innerHeight + 1 && popover.left >= -1,
    };
  }, name);
  if (!geometry) { check(`${name} opens`, false); continue; }
  worstDrift = Math.max(worstDrift, Math.abs(geometry.dx), Math.abs(geometry.dy - 6));
  check(`${name} popover is anchored to its button and only one is open`,
    Math.abs(geometry.dx) <= 1 && Math.abs(geometry.dy - 6) <= 1 && geometry.open === 1 && geometry.onScreen,
    `offset (${geometry.dx.toFixed(0)}, ${geometry.dy.toFixed(0)}) · ${geometry.open} open · ${geometry.onScreen ? "on screen" : "OFF SCREEN"}`);
}
check("no popover drifted from its button", worstDrift <= 1, `worst ${worstDrift.toFixed(1)}px`);

// Blender's menu bar: sliding across the header moves the open menu along.
await clickMenu("Select");
{
  const handle = await menuButton("Mesh");
  const spot = await handle.boundingBox();
  await page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2, { steps: 6 });
}
await settle(250);
const hovered = await page.evaluate(() => ({
  open: [...document.querySelectorAll(".geometry-toolbar-menu.open > .geometry-toolbar-menu-summary")].map((s) => s.textContent.trim()),
  popovers: document.querySelectorAll(".geometry-toolbar-popover").length,
}));
check("hovering a sibling while open switches to it",
  hovered.open.length === 1 && hovered.open[0] === "Mesh" && hovered.popovers === 1, hovered.open.join(","));

// Clicking away closes.
await page.mouse.click(centre.x, centre.y);
await settle(250);
check("clicking the viewport closes the open menu",
  await page.evaluate(() => document.querySelectorAll(".geometry-toolbar-popover").length === 0));

/* -------------------------------------------------------------------------- */
/* Shift+A: add primitives                                                     */
/* -------------------------------------------------------------------------- */

console.log("\nadd primitives (Shift+A)");

const topology = () => page.evaluate(() => {
  const s = globalThis.__geometrySession;
  return { verts: s.mesh.verts.size, edges: s.mesh.edges.size, faces: s.mesh.faces.size, mode: s.mode };
});

const beforeAdd = await topology();
await page.mouse.move(centre.x, centre.y);
await page.keyboard.down("Shift");
await page.keyboard.press("a");
await page.keyboard.up("Shift");
await settle(300);
const addMenu = await page.evaluate(() => {
  const menu = document.querySelector(".geometry-add-menu");
  if (!menu) return null;
  const rect = menu.getBoundingClientRect();
  return { entries: [...menu.querySelectorAll("button")].map((b) => b.textContent.trim()), x: rect.left, y: rect.top };
});
check("Shift+A opens a primitive menu at the mouse", !!addMenu
  && Math.abs(addMenu.x - centre.x) < 200 && Math.abs(addMenu.y - centre.y) < 200,
  addMenu ? `${addMenu.entries.length} entries at (${addMenu.x.toFixed(0)}, ${addMenu.y.toFixed(0)}) vs mouse (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)})` : "no menu");
check("it offers Blender's primitives", !!addMenu
  && ["Plane", "Cube", "Circle", "UV Sphere", "Ico Sphere", "Cylinder", "Cone", "Torus", "Grid"].every((n) => addMenu.entries.includes(n)),
  addMenu?.entries.join(", "));

// Add a UV Sphere and confirm it arrived, selected, without disturbing the cube.
await page.evaluate(() => {
  const menu = document.querySelector(".geometry-add-menu");
  [...menu.querySelectorAll("button")].find((b) => b.textContent.trim() === "UV Sphere").click();
});
await settle(700);
const afterAdd = await page.evaluate(() => {
  const s = globalThis.__geometrySession;
  let selectedFaces = 0;
  for (const face of s.mesh.faces) if (face.select) selectedFaces++;
  return { verts: s.mesh.verts.size, faces: s.mesh.faces.size, selectedFaces, mode: s.mode };
});
check("UV Sphere is added to the mesh", afterAdd.verts > beforeAdd.verts + 100 && afterAdd.faces > beforeAdd.faces + 100,
  `${beforeAdd.verts}v/${beforeAdd.faces}f -> ${afterAdd.verts}v/${afterAdd.faces}f`);
check("only the new geometry is selected", afterAdd.selectedFaces === afterAdd.faces - beforeAdd.faces,
  `${afterAdd.selectedFaces} of ${afterAdd.faces - beforeAdd.faces} new faces`);

// Undo must take the whole primitive back out in one step.
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
await settle(600);
const afterUndo = await topology();
check("one undo removes the whole primitive", afterUndo.verts === beforeAdd.verts && afterUndo.faces === beforeAdd.faces,
  `${afterUndo.verts}v/${afterUndo.faces}f`);

/* -------------------------------------------------------------------------- */
/* Snapping                                                                    */
/* -------------------------------------------------------------------------- */

console.log("\nsnapping");

const screenOf = (co) => page.evaluate((co) => {
  const session = globalThis.__geometrySession;
  const rect = session.canvas.getBoundingClientRect();
  const point = session.camera.position.clone().set(co[0], co[1], co[2]);
  point.applyMatrix4(session.meshObject.matrixWorld).project(session.camera);
  return { x: (point.x + 1) * rect.width * 0.5 + rect.left, y: (-point.y + 1) * rect.height * 0.5 + rect.top };
}, co);

const selectVertNear = (co) => page.evaluate(async (co) => {
  const session = globalThis.__geometrySession;
  const { clearSelection, flushSelection } = await globalThis.__importLive("/src/editor/mesh/select.js");
  clearSelection(session.mesh);
  let best = null;
  for (const vert of session.mesh.verts) {
    const distance = Math.hypot(vert.co[0] - co[0], vert.co[1] - co[1], vert.co[2] - co[2]);
    if (!best || distance < best.distance) best = { vert, distance };
  }
  best.vert.select = true;
  session.mode = "vert";
  flushSelection(session.mesh, "vert");
  session.active = best.vert;
  session.rebuild();
  return { id: best.vert.id, co: [...best.vert.co] };
}, co);

const CORNER = [0.5, 0.5, 0.5];
const TARGET = [-0.5, 0.5, 0.5];

for (const mode of ["vertex", "edge", "face"]) {
  const picked = await selectVertNear(CORNER);
  await page.evaluate((m) => {
    const session = globalThis.__geometrySession;
    session.snapEnabled = true;
    session.snapMode = m;
    session.snapAbsolute = false;
  }, mode);
  const from = await screenOf(picked.co);
  const to = await screenOf(TARGET);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.press("g");
  await settle(150);
  // Stopped short on purpose: only a real snap can close the remaining gap.
  await page.mouse.move(to.x - 6, to.y + 5, { steps: 12 });
  await settle(250);
  await page.mouse.down();
  await page.mouse.up();
  await settle(350);
  const after = await page.evaluate((id) => [...globalThis.__geometrySession.mesh.verts].find((v) => v.id === id)?.co, picked.id);
  const gap = Math.hypot(after[0] - TARGET[0], after[1] - TARGET[1], after[2] - TARGET[2]);
  // Vertex and edge snapping land exactly on the corner. Face snapping lands
  // somewhere on the face under the mouse, so it is judged by being ON the
  // plane of one of the two faces meeting at that corner.
  const onPlane = Math.min(Math.abs(Math.abs(after[0]) - 0.5), Math.abs(Math.abs(after[1]) - 0.5), Math.abs(Math.abs(after[2]) - 0.5));
  check(`${mode} snap catches a target a full unit away`,
    mode === "face" ? onPlane < 1e-6 : gap < 1e-6,
    `landed at ${after.map((n) => n.toFixed(3))} · gap ${gap.toFixed(4)}`);
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await settle(400);
}

// Increment snapping rounds the DISTANCE TRAVELLED, as Blender's does.
{
  const picked = await selectVertNear(CORNER);
  await page.evaluate(() => {
    const session = globalThis.__geometrySession;
    session.snapEnabled = true;
    session.snapMode = "increment";
    session.snapIncrement = 0.25;
    session.snapAbsolute = false;
  });
  const from = await screenOf(picked.co);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.press("g");
  await settle(150);
  await page.mouse.move(from.x + 117, from.y - 43, { steps: 12 });
  await settle(250);
  await page.mouse.down();
  await page.mouse.up();
  await settle(350);
  const after = await page.evaluate((id) => [...globalThis.__geometrySession.mesh.verts].find((v) => v.id === id)?.co, picked.id);
  const delta = after.map((value, axis) => value - picked.co[axis]);
  const onGrid = delta.every((value) => Math.abs(value / 0.25 - Math.round(value / 0.25)) < 1e-6);
  check("increment snap quantises the distance travelled", onGrid && delta.some((v) => Math.abs(v) > 1e-6),
    `moved by ${delta.map((n) => n.toFixed(3))}`);
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await settle(400);
  await page.evaluate(() => { globalThis.__geometrySession.snapEnabled = false; });
}

/* -------------------------------------------------------------------------- */
/* Proportional editing                                                        */
/* -------------------------------------------------------------------------- */

console.log("\nproportional editing");

// A denser mesh, so a falloff has intermediate rings to grade across.
await page.evaluate(async () => {
  const session = globalThis.__geometrySession;
  const { subdivideFaces } = await globalThis.__importLive("/src/editor/mesh/ops/topology.js");
  const { selectAll } = await globalThis.__importLive("/src/editor/mesh/select.js");
  selectAll(session.mesh, "face");
  subdivideFaces(session.mesh, [...session.mesh.faces], 4);
  session.rebuild();
});
await settle(500);

const positions = () => page.evaluate(() =>
  [...globalThis.__geometrySession.mesh.verts].map((v) => ({ id: v.id, co: [...v.co] })));

/** Drags the picked vertex and reports how each vertex moved. */
async function proportionalDrag({ enabled, size }) {
  const picked = await selectVertNear([0.5, 0.5, 0.5]);
  await page.evaluate(({ enabled, size }) => {
    const session = globalThis.__geometrySession;
    session.proportional = enabled;
    session.proportionalConnected = true;
    session.falloff = "smooth";
    session.proportionalSize = size;
  }, { enabled, size });
  const before = await positions();
  const from = await screenOf(picked.co);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.press("g");
  await settle(150);
  await page.mouse.move(from.x + 90, from.y - 90, { steps: 12 });
  await settle(250);
  const live = await page.evaluate(() => {
    const macro = globalThis.__geometrySession.macro;
    return macro && { proportional: macro.proportional, radius: macro.radius, influenced: macro.origins.size };
  });
  await page.mouse.down();
  await page.mouse.up();
  await settle(350);
  const after = await positions();
  const deltas = after.map((entry) => {
    const start = before.find((b) => b.id === entry.id);
    return start ? Math.hypot(...entry.co.map((v, i) => v - start.co[i])) : 0;
  }).filter((d) => d > 1e-6).sort((a, b) => b - a);
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await settle(450);
  return { deltas, live, picked };
}

const off = await proportionalDrag({ enabled: false, size: 0.8 });
check("with proportional editing off, only the picked vertex moves", off.deltas.length === 1,
  `${off.deltas.length} verts moved`);

const on = await proportionalDrag({ enabled: true, size: 0.8 });
check("proportional editing pulls the neighbourhood along", on.deltas.length > 5,
  `${on.deltas.length} verts moved, radius ${on.live?.radius}`);
// A falloff is a falloff only if the influence *grades*: the furthest vertex
// that moved must have moved much less than the one under the mouse.
check("the influence falls off with distance", on.deltas.length > 5
  && on.deltas[on.deltas.length - 1] < on.deltas[0] * 0.35
  && new Set(on.deltas.map((d) => d.toFixed(4))).size > 3,
  `max ${on.deltas[0]?.toFixed(3)} → min ${on.deltas[on.deltas.length - 1]?.toFixed(3)}, ${new Set(on.deltas.map((d) => d.toFixed(4))).size} distinct`);

const small = await proportionalDrag({ enabled: true, size: 0.25 });
check("a smaller proportional size influences fewer vertices", small.deltas.length < on.deltas.length && small.deltas.length > 1,
  `${small.deltas.length} at r=0.25 vs ${on.deltas.length} at r=0.8`);

// Blender's O during a transform, and the influence circle that goes with it.
{
  const picked = await selectVertNear([0.5, 0.5, 0.5]);
  await page.evaluate(() => {
    const session = globalThis.__geometrySession;
    session.proportional = false;
    session.proportionalSize = 0.8;
  });
  const from = await screenOf(picked.co);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.press("g");
  await settle(150);
  await page.mouse.move(from.x + 60, from.y - 60, { steps: 8 });
  await settle(200);
  const beforeToggle = await page.evaluate(() => globalThis.__geometrySession.macro.origins.size);
  await page.keyboard.press("o");
  await settle(300);
  const afterToggle = await page.evaluate(() => ({
    origins: globalThis.__geometrySession.macro.origins.size,
    proportional: globalThis.__geometrySession.macro.proportional,
    circle: !!document.querySelector(".geometry-proportional-circle"),
  }));
  check("O during a transform turns proportional editing on", afterToggle.proportional && afterToggle.origins > beforeToggle,
    `${beforeToggle} -> ${afterToggle.origins} influenced`);
  check("the influence circle is drawn", afterToggle.circle);
  await page.keyboard.press("o");
  await settle(300);
  const backOff = await page.evaluate(() => {
    const session = globalThis.__geometrySession;
    let moved = 0;
    for (const [vert, origin] of session.macro.origins) {
      if (Math.hypot(...vert.co.map((v, i) => v - origin[i])) > 1e-6) moved++;
    }
    return { proportional: session.macro.proportional, moved, circle: !!document.querySelector(".geometry-proportional-circle") };
  });
  check("O again turns it back off mid-transform", !backOff.proportional && backOff.moved === 1 && !backOff.circle,
    `${backOff.moved} verts displaced`);
  await page.keyboard.press("Escape");
  await settle(300);
}

/* -------------------------------------------------------------------------- */
/* Modifier stack                                                              */
/* -------------------------------------------------------------------------- */

console.log("\nmodifier stack");

await clickMenu("Modifier");
const emptyStack = await page.evaluate(() =>
  [...document.querySelectorAll(".geometry-toolbar-popover button")].map((b) => b.textContent.trim()));
check("the Modifier menu offers to create a stack", emptyStack.some((t) => /Add Modifier Stack/.test(t)), emptyStack.join(" | "));

await page.evaluate(() => {
  [...document.querySelectorAll(".geometry-toolbar-popover button")].find((b) => /Add Modifier Stack/.test(b.textContent)).click();
});
await settle(700);
check("the geometryModifiers component is attached",
  await page.evaluate(() => !!globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers")));

await clickMenu("Modifier");
const stackFields = await page.evaluate(() => ({
  modifiers: globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers,
  options: [...document.querySelector(".geometry-toolbar-popover select").options].map((option) => option.textContent.trim()),
  cards: document.querySelectorAll(".geometry-toolbar-popover .geometry-modifier-panel").length,
}));
check("a new modifier stack is empty", stackFields.modifiers.length === 0 && stackFields.cards === 0);
check("Add Modifier offers the complete portable modifier set",
  [
    "Mirror", "Subdivision Surface", "Array", "Boolean", "Solidify", "Smooth",
    "Simple Deform", "Cast", "Displace", "Wave", "Decimate", "Weld",
    "Edge Split", "Weighted Normal", "Geometry Nodes", "Bevel", "Build", "Mask", "Multiresolution",
    "Remesh", "Screw", "Skin", "Triangulate", "Wireframe", "Mesh to Volume",
    "Volume to Mesh", "Curve", "Hook", "Laplacian Deform", "Lattice", "Mesh Deform",
    "Shrinkwrap", "Corrective Smooth", "Laplacian Smooth", "Surface Deform",
    "Volume Displace", "Warp", "Armature", "Normal Edit", "Smooth by Angle",
  ].every((name) => stackFields.options.includes(name)), stackFields.options.join(", "));

await page.evaluate(() => {
  const select = document.querySelector(".geometry-toolbar-popover select");
  select.value = "array";
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await settle(700);
const addedModifier = await page.evaluate(() => ({
  stack: globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers,
  panels: [...document.querySelectorAll(".geometry-modifier-panel")].map((panel) => panel.textContent.trim()),
  inspectorCards: [...document.querySelectorAll(".modifier-card")].map((panel) => panel.textContent.trim()),
  previewVisible: globalThis.__geometrySession.modifierPreviewObject?.visible,
  previewVertices: globalThis.__geometrySession.modifierPreviewObject?.geometry?.getAttribute("position")?.count ?? 0,
  cageVertices: globalThis.__geometrySession.meshObject.geometry.getAttribute("position").count,
}));
check("adding Array creates one separate modifier panel",
  addedModifier.stack.length === 1 && addedModifier.stack[0].type === "array" && addedModifier.panels.some((text) => text.includes("Array")));
check("the Inspector renders the modifier as its own card",
  addedModifier.inspectorCards.some((text) => text.includes("Array") && text.includes("Apply")));
check("Array exposes its Blender-style offset, merge, fit, and UV controls",
  ["Fit Type", "Relative Offset", "Constant Offset", "Merge", "UV Offset"].every((label) =>
    addedModifier.inspectorCards.some((text) => text.includes("Array") && text.includes(label))));
check("Edit Mode draws the evaluated modifier result separately from the editable cage",
  addedModifier.previewVisible && addedModifier.previewVertices > addedModifier.cageVertices,
  `${addedModifier.previewVertices} evaluated / ${addedModifier.cageVertices} cage vertices`);

await page.evaluate(() => {
  const select = document.querySelector(".geometry-toolbar-popover select");
  select.value = "smooth";
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await settle(300);
await page.evaluate(() => {
  const select = document.querySelector(".geometry-toolbar-popover select");
  select.value = "weightedNormal";
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await settle(500);
const beforeMiddleApply = await page.evaluate(() =>
  globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers.map((entry) => entry.type));
check("multiple modifiers retain their explicit stack order", beforeMiddleApply.join(",") === "array,smooth,weightedNormal", beforeMiddleApply.join(","));
const applyButtons = await page.$$('.geometry-modifier-actions button[title="Apply"]');
check("each modifier panel exposes Apply", applyButtons.length === 3, `${applyButtons.length} buttons`);
await applyButtons[1]?.click();
await page.waitForFunction(() => {
  const remaining = globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers.length === 1;
  const status = document.querySelector(".geometry-editor-status")?.textContent ?? "";
  return remaining || /failed|error|could not|unsupported|unhandled/i.test(status);
}, { timeout: 30000 });
const appliedModifier = await page.evaluate(() => ({
  count: globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers.length,
  types: globalThis.__engine.getEntity("boxA").getComponent("geometryModifiers").props.modifiers.map((entry) => entry.type),
  asset: globalThis.__engine.getEntity("boxA").getComponent("mesh").props.geometryAsset,
  status: document.querySelector(".geometry-editor-status")?.textContent ?? "",
}));
check("applying a middle modifier bakes the stack through it and retains only later panels",
  appliedModifier.count === 1 && appliedModifier.types[0] === "weightedNormal" && /\.geom$/i.test(appliedModifier.asset),
  `${appliedModifier.types.join(",")} · ${appliedModifier.asset} · ${appliedModifier.status}`);

/* -------------------------------------------------------------------------- */
/* Assets-panel .geom thumbnails                                               */
/* -------------------------------------------------------------------------- */

console.log("\ngeometry asset thumbs");

const thumb = await page.evaluate(async () => {
  const path = globalThis.__engine.getEntity("boxA")?.getComponent("mesh")?.props?.geometryAsset;
  if (!path) return { path: null };
  const { requestGeometryThumb } = await globalThis.__importLive("/src/editor/geometryThumb.js");
  const url = await requestGeometryThumb(path);
  return {
    path,
    ok: typeof url === "string" && url.startsWith("data:image/png"),
    bytes: url?.length ?? 0,
  };
});
check(
  "requestGeometryThumb returns a PNG data URL for the edited .geom",
  !!thumb.ok,
  thumb.path ? `${thumb.path} · ${thumb.bytes} chars` : "no geometryAsset on boxA",
);

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("assets");
  const path = globalThis.__engine.getEntity("boxA")?.getComponent("mesh")?.props?.geometryAsset;
  if (!path) return;
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  await useProjectStore.getState().navigate(dir);
});
await settle(600);
await page.evaluate(() => {
  [...document.querySelectorAll(".assets-panel .toolbar-btn, .panel-toolbar .toolbar-btn")]
    .find((b) => (b.getAttribute("title") || "") === "Large icons")
    ?.click();
});
await settle(2500);
const uiThumb = await page.evaluate(() => ({
  geomThumbs: document.querySelectorAll(".asset-thumb.geom-thumb").length,
  geomTiles: [...document.querySelectorAll(".asset-tile .asset-name")].map((n) => n.textContent.trim()),
}));
check(
  "the Assets panel shows a rendered .geom thumbnail in large view",
  uiThumb.geomThumbs >= 1,
  `${uiThumb.geomThumbs} thumbs · tiles=${JSON.stringify(uiThumb.geomTiles)}`,
);

/* -------------------------------------------------------------------------- */

await page.screenshot({ path: "scripts/geo-ui-smoke.png" });
console.log(`\n${passed} passed, ${failed} failed  ·  screenshot: scripts/geo-ui-smoke.png`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
