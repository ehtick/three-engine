// MEASUREMENT ONLY — why the SDF debug view of the user's real Sponza shows
// inflated blobs with whole regions missing, while the geometry is fine.
//
// The hypothesis under test: per-mesh SDFs are baked into ONE 64³ grid whose
// cell size is derived from that mesh's OWN LONGEST AXIS
// (`bakeCore.bakeMeshSdf`: `cellLen = maxSpan / (maxAxisRes - 4)`). For a
// scene authored as a few big merged meshes, the longest axis is the whole
// building — so the cells are decimetres, every feature thinner than a cell
// either vanishes or inflates to one cell thick, and the field can no longer
// keep a wall's two faces apart. That is a leak by construction, and no
// amount of probe density or cascade work can fix it.
//
// So the number that matters per mesh is NOT its triangle count, it is
//     thinnest world dimension ÷ world bake cell size
// (call it "cells across"). Below ~2 the field cannot represent the surface
// as a separator. This prints that ratio for every GI mesh in the scene,
// plus the global field's own cell size, plus what actually seated.
//
//   npx vite --port 5234 --strictPort
//   node scripts/run-gi-sdf-coverage.mjs [url]
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5234/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME";
const SCENE = process.env.SCENE ?? "scenes/Main.scene";
const scenePath = path.join(PROJECT, SCENE).replace(/\\/g, "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { verbose: !!process.env.VERBOSE }); // read-only

page.on("console", (m) => {
  const t = m.text();
  // Errors too: a WGSL compile failure in one compute pass takes the whole
  // batch down and shows up only as "nothing was allocated" otherwise.
  if (/\[gi\]/.test(t) || m.type() === "error") console.log(`  page ${m.type()}: ${t.slice(0, 500)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(({ sparse, noOcc }) => {
  if (sparse) globalThis.__giSparseField = true;
  if (noOcc) globalThis.__giNoOccupancy = true;
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
}, { sparse: !!process.env.SPARSE, noOcc: !!process.env.NOOCC });

const fatal = async (message) => {
  console.log(`\nFATAL: ${message}`);
  await browser.close().catch(() => {});
  process.exit(1);
};

await page.goto(url, { waitUntil: "load", timeout: 60000 }).catch((e) => fatal(`page load: ${e.message}`));

console.log(`Opening ${PROJECT} / ${SCENE} ...`);
const opened = await page.evaluate(
  async ({ PROJECT, scenePath }) => {
    try {
      const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
      await useProjectStore.getState().openProject(PROJECT);
      const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
      await syncProjectModules();
      const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
      await openScenePath(scenePath);
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      globalThis.__engine = engine;
      const { THREE } = await globalThis.__importLive("/src/engine/index.js");
      globalThis.__THREE = THREE;
      return { ok: true, entities: engine.entities.size, name: engine.sceneName };
    } catch (err) {
      return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
    }
  },
  { PROJECT, scenePath },
);
if (!opened.ok) await fatal(`open failed:\n${opened.error}`);
console.log(`  opened "${opened.name}": ${opened.entities} entities`);

// Let the GI build + every SDF bake finish.
for (let i = 0; i < 90; i++) {
  await wait(1000);
  const ready = await page.evaluate(() => {
    const s = globalThis.__engine?.modules?.get("gi")?.system;
    if (!s?.state?.atlas) return false;
    return s.state.entries.length > 0 && s.state.atlas.assignments.filter(Boolean).length >= s.state.entries.length;
  });
  if (ready) break;
}

const report = await page.evaluate(async () => {
  const THREE = globalThis.__THREE;
  const engine = globalThis.__engine;
  const system = engine?.modules?.get("gi")?.system;
  if (!system?.state) return { error: "no GI state" };
  const { atlas, volume, entries, bounds } = system.state;

  // The bake's own resolution rule, mirrored (bakeCore.bakeMeshSdf).
  const MAX_AXIS = 64;
  const bakeCellOf = (geometry, maxAxisRes) => {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const span = new THREE.Vector3().subVectors(bb.max, bb.min);
    const maxSpan = Math.max(span.x, span.y, span.z, 1e-4);
    return { cellLen: maxSpan / (maxAxisRes - 4), span };
  };

  const slotOf = new Map();
  for (let i = 0; i < atlas.assignments.length; i++) {
    const a = atlas.assignments[i];
    if (a) slotOf.set(a.key, i);
  }

  const scale = new THREE.Vector3();
  const meshes = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.mesh)) continue;
    seen.add(entry.mesh);
    const mesh = entry.mesh;
    mesh.getWorldScale(scale);
    const hiRes = system._hiResMeshes?.has(mesh) === true;
    const { cellLen, span } = bakeCellOf(mesh.geometry, hiRes ? MAX_AXIS * 2 : MAX_AXIS);
    const s = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    const worldCell = cellLen * s;
    const worldSpan = new THREE.Vector3(
      span.x * Math.abs(scale.x),
      span.y * Math.abs(scale.y),
      span.z * Math.abs(scale.z),
    );
    const thinnest = Math.min(worldSpan.x, worldSpan.y, worldSpan.z);
    meshes.push({
      name: mesh.name || "mesh",
      analytic: !!entry.analytic,
      hiRes,
      tris: Math.round(entry.tris),
      worldSpan: [+worldSpan.x.toFixed(2), +worldSpan.y.toFixed(2), +worldSpan.z.toFixed(2)],
      bakeCell: +worldCell.toFixed(3),
      // THE NUMBER: how many bake cells span the mesh's thinnest dimension.
      cellsAcross: +(thinnest / Math.max(worldCell, 1e-6)).toFixed(2),
      seated: slotOf.has(entry.key),
    });
  }
  meshes.sort((a, b) => a.cellsAcross - b.cellsAcross);

  // Brick occupancy lives on the GPU (the allocator is a compute pass), so it
  // takes a readback to see it. Diagnostic only — never on the frame path.
  if (volume.sparse) await volume.sparse.readbackBricks(engine.renderer);

  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  return {
    volume: {
      size: [+size.x.toFixed(1), +size.y.toFixed(1), +size.z.toFixed(1)],
      res: [volume.res.x, volume.res.y, volume.res.z],
      fieldCell: [+volume.cell.x.toFixed(3), +volume.cell.y.toFixed(3), +volume.cell.z.toFixed(3)],
      capWorld: +volume.capWorld.toFixed(2),
      quality: system.component?.props?.quality ?? "?",
    },
    atlas: {
      instanceCapacity: atlas.capacity,
      tileCapacity: atlas.tileCapacity,
      uniqueTiles: atlas._tiles.size,
      seated: atlas.assignments.filter(Boolean).length,
      analytic: atlas.assignments.filter((a) => a?.analytic).length,
      entries: entries.length,
      detailBudget: atlas.detailBudget,
    },
    grid: volume.grid ? { ...volume.grid.stats } : null,
    sparse: volume.sparse ? { ...volume.sparse.stats } : null,
    sparseMax: volume.sparse?.maxBricks ?? 0,
    occupancy: volume.occupancy ? { ...volume.occupancy.stats } : null,
    // Composited occupancy AFTER the triangle clamp — the field the cascades
    // actually trace. The gap between this and the raw triangle count is how
    // much geometry the per-mesh SDF chain was losing.
    fieldOccupied: (await volume.readbackStats(engine.renderer)).occupiedCells,
    meshes,
  };
});

if (report.error) await fatal(report.error);

console.log(`\n=== VOLUME ===`);
console.log(
  `  ${report.volume.size.join(" x ")}m at "${report.volume.quality}" → ${report.volume.res.join("x")} cells` +
    `, field cell ${report.volume.fieldCell.join(" / ")}m, cap reach ${report.volume.capWorld}m`,
);
console.log(`=== ATLAS ===`);
console.log(
  `  ${report.atlas.seated}/${report.atlas.entries} seated (${report.atlas.analytic} analytic), ` +
    `${report.atlas.uniqueTiles} unique tiles of ${report.atlas.tileCapacity}, ` +
    `${report.atlas.instanceCapacity} instance slots, detail budget ${report.atlas.detailBudget}`,
);
if (report.grid) console.log(`  grid: ${report.grid.listed} listings, max ${report.grid.maxList}, overflow ${report.grid.overflowCells}`);
if (report.occupancy) {
  const o = report.occupancy;
  console.log(
    `  occupancy: ${o.triangles} tris → ${o.occupiedCells} cells (+${o.dilatedCells - o.occupiedCells} dilated)` +
      ` of ${o.cellCount} in ${o.ms.toFixed(0)}ms`,
  );
}
console.log(`  composited field occupied: ${report.fieldOccupied}`);
if (report.sparse) {
  const s = report.sparse;
  console.log(
    `  sparse: ${s.bricks}/${s.maxBricks} bricks of ${s.brickAxis}³, fine cell ${s.fineCell.toFixed(3)}m` +
      `, ${((s.bricks * s.brickAxis ** 3 * 2) / 1048576).toFixed(1)}MB used` +
      (s.overflow ? `, ${s.overflow} OVER BUDGET` : ""),
  );
}

console.log(`\n=== PER-MESH BAKE RESOLUTION (sorted worst first) ===`);
console.log(`  ${"mesh".padEnd(26)} ${"tris".padStart(7)} ${"world span".padStart(20)} ${"bakeCell".padStart(9)} ${"across".padStart(7)}  seated`);
for (const m of report.meshes) {
  console.log(
    `  ${m.name.slice(0, 26).padEnd(26)} ${String(m.tris).padStart(7)} ` +
      `${m.worldSpan.join("x").padStart(20)} ${String(m.bakeCell).padStart(9)} ${String(m.cellsAcross).padStart(7)}` +
      `  ${m.seated ? "yes" : "NO"}${m.analytic ? " (analytic)" : ""}${m.hiRes ? " *128" : ""}`,
  );
}

// A mesh needs ~2 bake cells across its thinnest dimension for the field to
// separate its two faces. Below that it is a leak source no matter what the
// cascades do.
const baked = report.meshes.filter((m) => !m.analytic);
const under2 = baked.filter((m) => m.cellsAcross < 2);
const under1 = baked.filter((m) => m.cellsAcross < 1);
console.log(`\n=== VERDICT ===`);
console.log(`  baked meshes: ${baked.length}`);
console.log(`  under 2 cells across (cannot separate faces → LEAKS): ${under2.length}`);
console.log(`  under 1 cell across (surface not representable at all):  ${under1.length}`);
const worstCell = Math.max(...baked.map((m) => m.bakeCell), 0);
console.log(`  coarsest per-mesh bake cell: ${worstCell.toFixed(3)}m  (global field cell ${report.volume.fieldCell[0]}m)`);

await browser.close();
