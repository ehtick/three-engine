/**
 * The blockout tools in a REAL viewport.
 *
 * `npm run test:level` proves the geometry and the gesture solver headlessly,
 * and it cannot prove the one thing that decides whether the feature exists:
 * that a press-drag-release over the canvas creates a wall. Everything between
 * the pointer and the piece — the armed-tool gate, the capture-phase handler
 * that has to beat the selection picker to the event, the ray against the draw
 * plane, the level and storey created on first use — only runs here.
 *
 * Run against a FRESH dev server (see run-editor-ui-smoke.mjs for why a stale
 * one makes the harness's imports a second copy of the app):
 *
 *   npx vite --port 5201 --strictPort
 *   node scripts/run-level-tool-smoke.mjs
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

/** Imports the module instance the APP is using, not a fresh copy. */
const IMPORT_LIVE = `
const importLive = (path) => {
  const prefix = location.origin + path;
  const fetched = performance.getEntriesByType("resource").map((e) => e.name)
    .filter((n) => n === prefix || n.startsWith(prefix + "?"));
  const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
  return import(/* @vite-ignore */ live ?? path);
};
`;

// ---- enable the module, the way the Modules panel does ---------------------

const enabled = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { setModuleEnabled } = await importLive("/src/editor/modules.js");
  await setModuleEnabled("level-design", true);
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  return [...engine.modules.keys()];
}, IMPORT_LIVE);

check("the level-design module enables on the live engine", enabled.includes("level-design"), enabled.join(","));
await wait(800);

check("the viewport offers the blockout palette", await page.evaluate(() => {
  return !!document.querySelector('.viewport-toolbar button[title^="Level blockout"]');
}));

// ---- arm the Wall tool through its own store ------------------------------
//
// Clicking the toolbar button would arm "floor"; the point of this smoke is the
// drag, so the tool is set directly and the BUTTON's state is checked instead.

await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const levelTool = await importLive("/src/editor/levelTool.js");
  levelTool.armLevelTool("wall");
  levelTool.setLevelToolSetting("grid", 1);
  levelTool.setDrawElevation(0);
}, IMPORT_LIVE);
await wait(500);

check("arming a tool shows the palette", await page.evaluate(() => !!document.querySelector(".level-toolbar")));
check(
  "the armed tool is marked in the palette",
  await page.evaluate(() => {
    const active = [...document.querySelectorAll(".level-toolbar .toolbar-btn.active")];
    return active.some((b) => (b.getAttribute("title") ?? "").startsWith("Wall"));
  }),
);

// ---- drag a wall across the viewport --------------------------------------

const canvasBox = await page.evaluate(() => {
  const canvas = document.querySelector(".viewport-canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
check("the viewport canvas is on screen", !!canvasBox);

async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await wait(400);
}

// Below the horizon so the ray meets the ground plane; the exact world
// coordinates don't matter, only that a piece of the right shape appears.
const cx = canvasBox.x + canvasBox.width / 2;
const cy = canvasBox.y + canvasBox.height * 0.68;
await drag({ x: cx - 220, y: cy }, { x: cx + 220, y: cy });

const afterWall = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const pieces = [];
  let level = null;
  let floor = null;
  for (const root of engine.rootEntities) {
    root.traverse((entity) => {
      if (entity.getComponent("level")) level = entity.name;
      if (entity.getComponent("levelfloor")) floor = entity.name;
      const piece = entity.getComponent("blockout");
      if (piece) {
        pieces.push({
          name: entity.name,
          shape: piece.props.shape,
          size: piece.props.size,
          hasMesh: !!entity.getComponent("mesh")?.mesh,
          vertices: entity.getComponent("mesh")?.mesh?.geometry?.getAttribute("position")?.count ?? 0,
          parent: entity.parent?.name ?? null,
        });
      }
    });
  }
  return { level, floor, pieces };
}, IMPORT_LIVE);

check("the first drag created a Level and a storey", !!afterWall.level && !!afterWall.floor,
  `${afterWall.level} / ${afterWall.floor}`);
check("a wall was drawn", afterWall.pieces.length === 1 && afterWall.pieces[0].shape === "wall",
  JSON.stringify(afterWall.pieces));
check("the wall has a length, not a point", (afterWall.pieces[0]?.size?.[0] ?? 0) > 0.5,
  `length ${afterWall.pieces[0]?.size?.[0]}`);
check("the wall draws through a real Mesh component", !!afterWall.pieces[0]?.hasMesh &&
  afterWall.pieces[0].vertices > 0, `${afterWall.pieces[0]?.vertices} verts`);
check("the wall was parented to the storey", afterWall.pieces[0]?.parent === afterWall.floor,
  `${afterWall.pieces[0]?.parent}`);

// The greybox material is assigned during the piece's own onAttach, and the
// Mesh component finishes its async material pass a MICROTASK later — which
// used to reset every piece to the default white with no event to say so. A
// level drawn entirely in white, no grid texture, nothing in the console.
const material = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  let found = null;
  for (const root of engine.rootEntities) {
    root.traverse((entity) => {
      if (!entity.getComponent("blockout") || found) return;
      const mesh = entity.getComponent("mesh")?.mesh;
      found = {
        name: mesh?.material?.name ?? null,
        color: mesh?.material?.color?.getHexString?.() ?? null,
        hasGrid: !!mesh?.material?.map,
        owner: mesh?.userData?.materialOwner ?? null,
      };
    });
  }
  return found;
}, IMPORT_LIVE);
check("the piece keeps its greybox material", (material?.name ?? "").startsWith("Blockout "), JSON.stringify(material));
check("…tinted by shape, with the metre grid on it", material?.color === "f5c542" && material?.hasGrid,
  JSON.stringify(material));

// ---- a floor, into the SAME level ------------------------------------------

await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  (await importLive("/src/editor/levelTool.js")).armLevelTool("floor");
}, IMPORT_LIVE);
await wait(300);
await drag({ x: cx - 200, y: cy - 60 }, { x: cx + 200, y: cy + 60 });

const afterFloor = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const shapes = [];
  let levels = 0;
  for (const root of engine.rootEntities) {
    root.traverse((entity) => {
      if (entity.getComponent("level")) levels++;
      const piece = entity.getComponent("blockout");
      if (piece) shapes.push(piece.props.shape);
    });
  }
  return { shapes, levels };
}, IMPORT_LIVE);

check("a second piece joins the level that already exists", afterFloor.levels === 1, `${afterFloor.levels} levels`);
check("the floor tool drew a slab", afterFloor.shapes.includes("floor"), afterFloor.shapes.join(","));

// ---- Alt-drag orbits instead of drawing ------------------------------------
//
// The left button is OrbitControls' ROTATE, and an armed tool takes it. Without
// an escape the camera cannot be turned at all while drawing — reported as
// "we can't move the camera". Alt hands the button back.

const cameraQuaternion = () =>
  page.evaluate(() => {
    const q = globalThis.__viewport?.camera?.quaternion;
    return q ? [q.x, q.y, q.z, q.w] : null;
  });

const beforeOrbit = await cameraQuaternion();
const piecesBeforeOrbit = (await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  let pieces = 0;
  for (const root of engine.rootEntities) root.traverse((e) => { if (e.getComponent("blockout")) pieces++; });
  return pieces;
}, IMPORT_LIVE));

await page.keyboard.down("Alt");
await drag({ x: cx - 100, y: cy - 40 }, { x: cx + 60, y: cy - 90 });
await page.keyboard.up("Alt");
await wait(400);

const afterOrbit = await cameraQuaternion();
const piecesAfterOrbit = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  let pieces = 0;
  for (const root of engine.rootEntities) root.traverse((e) => { if (e.getComponent("blockout")) pieces++; });
  return pieces;
}, IMPORT_LIVE);

const turned = beforeOrbit && afterOrbit
  ? beforeOrbit.some((v, i) => Math.abs(v - afterOrbit[i]) > 1e-4)
  : false;
check("Alt-drag orbits the camera", turned, JSON.stringify({ beforeOrbit, afterOrbit }));
check("…and draws nothing while it does", piecesAfterOrbit === piecesBeforeOrbit,
  `${piecesBeforeOrbit} → ${piecesAfterOrbit}`);
check(
  "middle-drag is remapped to rotate while a tool is armed",
  await page.evaluate(() => globalThis.__viewport?.orbit?.mouseButtons?.MIDDLE === 0),
);

// ---- Ctrl+Z / Ctrl+Shift+Z, pressed for real -------------------------------
//
// Through the keyboard, not `commandBus.undo()`: the chord has to survive
// keyScope (a focused toolbar field would eat it), the level tool's own key
// dispatcher, and EditorChrome's handler before it reaches the bus. Driving the
// bus directly would pass while every one of those was broken.

const chord = async (shift = false) => {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await wait(350);
};

const countScene = () =>
  page.evaluate(async (importLiveSrc) => {
    const importLive = new Function(`${importLiveSrc} return importLive;`)();
    const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    let pieces = 0;
    let levels = 0;
    for (const root of engine.rootEntities) {
      root.traverse((e) => {
        if (e.getComponent("blockout")) pieces++;
        if (e.getComponent("level")) levels++;
      });
    }
    return { pieces, levels };
  }, IMPORT_LIVE);

await chord();
const undo1 = await countScene();
check("Ctrl+Z takes back the last piece", undo1.pieces === 1 && undo1.levels === 1, JSON.stringify(undo1));

await chord();
const undo2 = await countScene();
// The first drag created the Level, the storey AND the wall. One gesture is
// one Ctrl+Z, so this must clear all three rather than leaving an empty Level.
check("undoing the first piece takes its Level with it", undo2.pieces === 0 && undo2.levels === 0,
  JSON.stringify(undo2));

await chord(true);
const redo1 = await countScene();
check("Ctrl+Shift+Z puts it back", redo1.pieces === 1 && redo1.levels === 1, JSON.stringify(redo1));

await chord(true);
const redo2 = await countScene();
check("redo restores the second piece too", redo2.pieces === 2, JSON.stringify(redo2));

// The tool must still be aimed at the level that came back, or the next click
// silently starts a second one.
const retargeted = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const levelTool = await importLive("/src/editor/levelTool.js");
  return { levelId: levelTool.getActiveLevelId(), floorId: levelTool.getActiveFloorId() };
}, IMPORT_LIVE);
check("the tool re-adopts the level redo restored", !!retargeted.levelId && !!retargeted.floorId,
  JSON.stringify(retargeted));

// ---- a level setting is undoable too --------------------------------------

const gridUndo = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const levelTool = await importLive("/src/editor/levelTool.js");
  const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const before = levelTool.getLevelToolSettings().grid;
  levelTool.setLevelToolSetting("grid", before === 2 ? 4 : 2);
  const changed = levelTool.getLevelToolSettings().grid;
  commandBus.undo();
  await new Promise((r) => setTimeout(r, 50));
  const level = engine.getEntity(levelTool.getActiveLevelId())?.getComponent("level");
  return { before, changed, afterUndo: levelTool.getLevelToolSettings().grid, onComponent: level?.props.grid };
}, IMPORT_LIVE);
check("changing the grid is undoable", gridUndo.changed !== gridUndo.before, JSON.stringify(gridUndo));
check(
  "…and the toolbar follows the undo instead of lying about it",
  gridUndo.afterUndo === gridUndo.before && gridUndo.onComponent === gridUndo.before,
  JSON.stringify(gridUndo),
);

// ---- disarming releases the viewport --------------------------------------

const disarmed = await page.evaluate(async (importLiveSrc) => {
  const importLive = new Function(`${importLiveSrc} return importLive;`)();
  const levelTool = await importLive("/src/editor/levelTool.js");
  levelTool.disarmLevelTool();
  await new Promise((r) => setTimeout(r, 200));
  return { tool: levelTool.getLevelTool(), palette: !!document.querySelector(".level-toolbar") };
}, IMPORT_LIVE);
check("Esc-style disarm hides the palette", disarmed.tool === null && !disarmed.palette, JSON.stringify(disarmed));

// ---------------------------------------------------------------------------

// A picture of the palette, for looking at rather than asserting on. The
// layout is a judgement call; the file is what makes it reviewable.
if (process.env.SHOT) {
  await page.evaluate(async (importLiveSrc) => {
    const importLive = new Function(`${importLiveSrc} return importLive;`)();
    (await importLive("/src/editor/levelTool.js")).armLevelTool("wall");
  }, IMPORT_LIVE);
  await wait(400);
  await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 800, height: 220 } });
  console.log(`  wrote ${process.env.SHOT}`);
}

const ignorable = (text) =>
  text.includes("WebGPU") || text.includes("Failed to load resource") || text.includes("favicon");
const real = errors.filter((e) => !ignorable(e));
for (const error of real) console.log(`  console error: ${error}`);

const failed = results.filter((r) => !r.ok).length;
console.log(
  `\nLEVEL-TOOL ${failed || real.length ? "FAIL" : "PASS"} — ${results.length - failed}/${results.length} checks, ` +
    `${real.length} console errors`,
);
await browser.close();
process.exit(failed || real.length ? 1 : 0);
