// WHICH MESHES IN THE REAL PROJECT ARE ACTUALLY EXACT MOVERS?
//
// The user's report (2026-08-07): "large square patches of colour bleed from
// the green cube randomly appear and disappear fast" and "it still looks like
// large voxels revoxelizing from a rotating cube". SQUARE PATCHES ARE THE VOXEL
// SIGNATURE. An adopted mover has no voxels at all — so either that cube was
// never adopted, or it was adopted and something still re-voxelizes it.
//
// Guessing which costs a session. This census reads the live GI system and
// prints, per placement: its two tags, whether it is in the exact set, whether
// it is moving, and whether its voxel slot is still being written. Plus the
// dynamic set's cap and stats, and any cap/eligibility warnings the module
// logged — the cliff that made 16 of 30 movers exact and left the rest
// re-voxelizing every frame is silent unless you go looking.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-mover-census.mjs
//
// Env:
//   PROJECT=<dir>   defaults to the user's real project
//   PLAY=1          enter play mode first (scripts that rotate things only
//                   run there — in edit mode nothing moves and nothing adopts)
//   WATCH=8000      ms to watch for churn after the census
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const PLAY = process.env.PLAY === "1";
const WATCH = Number(process.env.WATCH ?? 8000);
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
const notes = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]/.test(t)) {
    if (/built|dynamic-objects|static shadow bvh|occupancy backend/.test(t)) console.log(`  ${t.slice(0, 190)}`);
    if (/cap reached|stays voxelized|pool full|released|not eligible|downgrad/i.test(t)) notes.push(t);
  }
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 180)}`);
});
await page.evaluateOnNewDocument((p) => {
  localStorage.setItem("engine.projectRoot.v1", p);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([p]));
  globalThis.__giDynObjectsDebug = true;
}, PROJECT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((p) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  (rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === p) ?? rows[0])
    ?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 150 && !built; i++) await wait(1000);
await wait(8000);

if (PLAY) {
  console.log("\n  entering play mode (scripts only move things there) …");
  const r = await page.evaluate(async () => {
    try { return { ok: true, v: await globalThis.__editorApi.call("play.set", { playing: true }) }; }
    catch (e) { return { ok: false, e: e?.message ?? String(e) }; }
  });
  if (!r.ok) console.log(`  !! play.set failed: ${r.e} — the census below is EDIT MODE, where nothing moves`);
  await wait(6000);
}

const census = await page.evaluate(async (watchMs) => {
  let sys = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const s = globalThis.__editorApi.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
    if (s) { sys = s; break; }
  }
  if (!sys) return { error: "no gi system" };
  const field = sys.state?.volume?.occupancyField;
  const dyn = sys._dynSet;

  // BOTH SETS, or the census lies. An ADOPTED mesh is REMOVED from
  // `field.placements` — that is what adoption means — so enumerating
  // placements alone reports every exact mover as "not adopted" and every
  // rotating cube as "not moving", which is exactly backwards.
  const subjects = [];
  dyn?.forEachEntry?.((e) =>
    subjects.push({ mesh: e.mesh, adopted: true, type: e.type, surface: e.surface ?? null, slot: null }),
  );
  for (const p of field?.placements ?? []) {
    subjects.push({ mesh: p.mesh, adopted: false, type: "voxel", surface: null, slot: p.slot, frozen: p._giAnalytic === true });
  }

  // Two samples of every subject's world matrix, WATCH ms apart: "is it
  // moving" is a fact about frames, not about tags.
  const snap = () => subjects.map((s) => [...(s.mesh?.matrixWorld?.elements ?? [])]);
  const before = snap();
  await new Promise((r) => setTimeout(r, watchMs));
  const after = snap();
  const rows = subjects.map((s, i) => ({
    name: s.mesh?.name || "(unnamed)",
    mobility: s.mesh?.userData?.giMobility ?? s.mesh?.userData?.giDynamic ?? "auto",
    trace: s.mesh?.userData?.giTrace ?? "auto",
    adopted: s.adopted,
    type: s.type,
    frozen: s.frozen === true,
    moving: before[i].some((v, j) => Math.abs(v - (after[i][j] ?? 0)) > 1e-6),
    slot: s.slot,
    tris: (s.mesh?.geometry?.index?.count ?? s.mesh?.geometry?.attributes?.position?.count ?? 0) / 3,
    surface: s.surface,
  }));
  const movedKeys = { size: rows.filter((r) => r.moving).length };
  const entries = rows.filter((r) => r.adopted).map((r) => ({ name: r.name, type: r.type, surface: r.surface }));
  return {
    placements: rows.length,
    subjects: rows.length,
    movingCount: movedKeys.size,
    dyn: dyn
      ? { enabled: dyn.enabled, count: dyn.count(), cap: dyn.maxObjects, stats: dyn.stats }
      : null,
    entries,
    emitters: sys._emitterInfos?.length ?? 0,
    // Did the code with the 2026-08-07 dynamic shading actually load?
    hasSurfaceAt: typeof dyn?.surfaceAt === "function",
    playing: sys.engine?.playing === true,
    rows,
  };
}, WATCH);

if (census.error) { console.log(`FATAL: ${census.error}`); await browser.close(); process.exit(1); }

console.log(`\n=== MOVER CENSUS (${census.playing ? "PLAY" : "EDIT"} mode) ===`);
console.log(
  `  placements ${census.placements}  moving ${census.movingCount}  emitters ${census.emitters}  ` +
    `exact set ${census.dyn?.count}/${census.dyn?.cap}  ` +
    `(dynamic shading code loaded: ${census.hasSurfaceAt ? "YES" : "NO — this editor is running an OLD build"})`,
);
if (census.dyn?.stats) console.log(`  dyn stats: ${JSON.stringify(census.dyn.stats)}`);
for (const e of census.entries) {
  console.log(`  exact: ${e.name} (${e.type})${e.surface ? ` albedo=[${e.surface.albedo.map((v) => v.toFixed(3))}] emissive=[${e.surface.emissive.map((v) => v.toFixed(3))}]` : ""}`);
}

// THE ROWS THAT MATTER: anything MOVING that is NOT adopted re-voxelizes every
// frame, and that is the square-patch flicker.
const bad = census.rows.filter((r) => r.moving && !r.adopted);
console.log(`\n  MOVING BUT STILL VOXELIZED: ${bad.length}`);
for (const r of bad) {
  console.log(`    ${r.name.padEnd(28)} mobility=${String(r.mobility).padEnd(8)} trace=${String(r.trace).padEnd(6)} tris=${Math.round(r.tris)} slot=${r.slot}`);
}
const movingAdopted = census.rows.filter((r) => r.moving && r.adopted);
console.log(`  MOVING AND EXACT: ${movingAdopted.length}${movingAdopted.length ? ` — ${movingAdopted.map((r) => r.name).join(", ")}` : ""}`);
const pinnedStill = census.rows.filter((r) => !r.moving && r.adopted);
if (pinnedStill.length) {
  console.log(`  EXACT BUT NOT MOVING (each one costs EVERY ray): ${pinnedStill.length} — ${pinnedStill.map((r) => r.name).join(", ")}`);
}
if (notes.length) {
  console.log(`\n  module warnings:`);
  for (const n of [...new Set(notes)]) console.log(`    ${n.slice(0, 200)}`);
}

await browser.close();
process.exit(0);
