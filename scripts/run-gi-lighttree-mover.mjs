// §12.70 W5a — DOES THE LIGHT TREE FOLLOW A LAMP THAT MOVES?
//
// The tree's emitter records are packed WORDS, frozen when the block is built;
// the promoted slots opposite them are uniforms refreshed every frame. So
// every record reader — [J]'s NEE descent (§12.62 W3) and the whole screen
// emitter chain under the §12.70 W4b tile cut — lit a moving lamp from its
// BAKE POSE until the next full GI rebuild. That was a documented W5 gap, and
// it is the one that would have shipped as "the light lags the lamp".
//
// The gate moves one lamp through the editor API and reads the tree back out
// of the occupancy bits, twice:
//
//   ARM refresh-on  — the moved lamp's emitter record must MOVE by the same
//                     delta, its neighbours must not, and no GI REBUILD may
//                     have happened (a rebuild repacks the tree anyway and
//                     would make the whole measurement vacuous).
//   ARM refresh-off — `__giLightTreeRefresh = false`, same move: the record
//                     must NOT move. This is the control that proves the
//                     assertion is sensitive to the mechanism under test and
//                     not to some other thing that repacks trees.
//
//   node scripts/run-gi-lighttree-mover.mjs      (vite on :5201)
//   LAMPS=12 SETTLE=14000 DELTA=2.5              (dials)
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";
import { readLightTree } from "../src/modules/gi/lightTree.js";

const url = process.argv[2] ?? "http://localhost:5201/";
const LAMPS = Number(process.env.LAMPS ?? 12);
const SETTLE = Number(process.env.SETTLE ?? 14000);
// The move. Big enough that no pose-cache epsilon or f32 packing rounding can
// swallow it, small enough to stay inside the room (the §12.66 pose rule
// applies to what we MOVE too — a lamp shoved through the wall stops emitting
// into the room and the luminance half of the story becomes unreadable).
const DELTA = Number(process.env.DELTA ?? 2.5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

/** Reads the packed tree block straight out of the occupancy bits buffer. */
const READ_TREE = async () => {
  const live = globalThis.__giLightTreeLive;
  if (!live) return { fail: "no __giLightTreeLive" };
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  const gi = engine?.modules?.get?.("gi")?.system;
  const bits = gi?.state?.volume?.occupancyField?.bitsBuffer;
  const renderer = engine?.renderer;
  if (!bits || !renderer) return { fail: "no bits buffer / renderer" };
  // Whole-buffer read + slice: the W1 gate's duplicate-three trap says an
  // in-page TSL copy kernel renders zeros here.
  const all = new Uint32Array(await renderer.getArrayBufferAsync(bits.value));
  const abs = live.abs >>> 0;
  return {
    abs,
    words: Array.from(all.subarray(abs, abs + live.words)),
    emitterCount: live.emitterCount,
    capacityWords: live.capacityWords ?? null,
  };
};

async function runArm(refreshOn) {
  const genRoot = path.resolve(`scripts/.gi-lighttree-mover-${LAMPS}`).replaceAll("\\", "/");
  await makeEmissiveStormProject(genRoot, {
    lampCount: LAMPS, lampMobility: "static", emitStrength: 8, enclosed: true, gi: { quality: "high" },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let treeLines = 0;
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    // The tree BUILD line (not the refresh — the refresh is silent by design).
    // A second one after the move means a full GI rebuild repacked the tree
    // and the measurement below proves nothing about #refreshLightTree.
    if (/\[gi\] light tree: /.test(t)) treeLines++;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, refresh) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giSrcLightTree = true;
    globalThis.__giEmitterTileCut = true;
    if (!refresh) globalThis.__giLightTreeRefresh = false;
  }, genRoot, refreshOn);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, genRoot);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error("never built");
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await page.evaluate(async () => {
    await globalThis.__editorApi.call("viewport.setCamera", {
      position: [0, 1.9, 6.2], target: [0, 0.8, -2],
    });
  });
  await wait(SETTLE);

  const before = await page.evaluate(READ_TREE);
  const treeLinesBefore = treeLines;

  // The move: Lamp0, straight up in +Y by DELTA, through the editor's own op
  // (never by touching the scene file — the editor already has it loaded).
  const moved = await page.evaluate(async (delta) => {
    const api = globalThis.__editorApi;
    const list = await api.call("entity.list", {});
    const rows = list.value ?? list;
    const lamp = rows.find((e) => e.name === "Lamp0");
    if (!lamp) return { fail: `no Lamp0 among ${rows.length} entities` };
    const got = await api.call("entity.get", { id: lamp.id });
    const e = got.value ?? got;
    const p = e.transform?.position ?? e.position ?? [0, 0, 0];
    const next = [p[0], p[1] + delta, p[2]];
    await api.call("entity.setTransform", { id: lamp.id, position: next });
    return { id: lamp.id, from: p, to: next };
  }, DELTA);
  if (moved.fail) throw new Error(moved.fail);
  // Several frames: the refresh runs in the GI tick and its upload rides the
  // dyn-set dispatcher, which retries across a skipped-pipeline frame.
  await wait(3000);

  const after = await page.evaluate(READ_TREE);
  const treeLinesAfter = treeLines;
  await page.close();
  return { before, after, moved, rebuilt: treeLinesAfter > treeLinesBefore, treeLines: treeLinesAfter };
}

/**
 * Emitter centres KEYED BY MESH, not by emitter id.
 *
 * Ids are the collection order, and the collection walks `_emitterCands`,
 * which `#chooseEmitterSeats` re-sorts by camera-apparent power — so a repack
 * legitimately renumbers every record. An id-keyed diff reads that permutation
 * as motion (it reported two records jumping 8.5 units on a 2.5 unit move).
 * The packed record carries `meshId`/`instanceId` precisely so a reader can
 * ask about a LAMP instead of a slot.
 */
function centresByMesh(read) {
  if (!read || read.fail) return null;
  const view = readLightTree(Uint32Array.from(read.words), 0);
  const out = new Map();
  for (let i = 0; i < view.emitterCount; i++) {
    const e = view.emitter(i);
    out.set(`${e.meshId}:${e.instanceId}`, { id: i, centre: e.centre });
  }
  return out;
}

const results = [];
for (const refreshOn of [true, false]) {
  const label = refreshOn ? "refresh ON" : "refresh OFF (control)";
  console.log(`── arm ${label}`);
  const r = await runArm(refreshOn);
  const cBefore = centresByMesh(r.before), cAfter = centresByMesh(r.after);
  if (!cBefore || !cAfter) {
    console.log(`  FAIL — tree unreadable (before ${r.before?.fail ?? "ok"}, after ${r.after?.fail ?? "ok"})`);
    results.push({ label, pass: false });
    continue;
  }
  const delta = r.moved.to.map((v, k) => v - r.moved.from[k]);
  const dist = Math.hypot(...delta);
  const moves = [];
  for (const [key, a] of cAfter) {
    const b = cBefore.get(key);
    if (!b) { moves.push({ key, d: Infinity, note: "new record" }); continue; }
    moves.push({ key, d: Math.hypot(...a.centre.map((v, k) => v - b.centre[k])), from: b.id, to: a.id });
  }
  const movedRecords = moves.filter((m) => m.d > 0.05);
  const tracking = moves.filter((m) => Math.abs(m.d - dist) <= 0.05 * dist + 0.02);
  const worstStill = Math.max(0, ...moves.filter((m) => !tracking.includes(m)).map((m) => m.d));
  const renumbered = moves.filter((m) => m.from !== m.to).length;
  console.log(
    `  Lamp0 ${r.moved.from.map((v) => v.toFixed(2)).join(",")} → ${r.moved.to.map((v) => v.toFixed(2)).join(",")} ` +
    `(|Δ| ${dist.toFixed(3)}) · ${cBefore.size} records · GI rebuild during the move: ${r.rebuilt ? "YES" : "no"}` +
    ` · records renumbered by the repack: ${renumbered}`,
  );
  console.log(
    `  records that moved: ${movedRecords.length} [${movedRecords.map((m) => `${m.key}:${m.d.toFixed(3)}`).join(" ")}] ` +
    `· tracking the delta: ${tracking.length} · worst non-tracking drift ${worstStill.toFixed(4)}`,
  );
  let pass;
  if (refreshOn) {
    // Exactly one record follows the lamp, nobody else stirs, and the tree was
    // NOT rebuilt from scratch underneath us.
    pass = !r.rebuilt && tracking.length === 1 && movedRecords.length === 1;
    console.log(`  ${pass ? "PASS" : "FAIL"} — expected exactly 1 tracking record, no rebuild`);
  } else {
    // The control: with the refresh hatched off the record must stay put.
    // (A rebuild here would repack the tree and move it anyway, so a rebuild
    // makes the control uninformative rather than failed — say so.)
    pass = !r.rebuilt && movedRecords.length === 0;
    console.log(
      `  ${pass ? "PASS" : "FAIL"} — expected 0 moved records with the refresh hatched off` +
      (r.rebuilt ? " (a GI rebuild fired: control uninformative)" : ""),
    );
  }
  results.push({ label, pass });
}

const allPass = results.every((r) => r.pass);
console.log(`\n§12.70 W5a MOVER GATE: ${allPass ? "PASS — the tree follows the lamp, and only when armed" : "FAIL"}`);
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.label}`);
await browser.close();
process.exit(allPass ? 0 : 1);
