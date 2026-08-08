// Hierarchy folding smoke test: proves the collapse state survives an editor
// restart, and that a restored scene is ALREADY folded on the first frame it
// paints rather than opening flat and snapping shut.
//
// Both halves need a real browser. The persistence is localStorage written by
// a React effect, and "no flash" is a claim about the DOM between a store
// update and the next paint — a unit test can observe neither.
//
//   npx vite --port 5201
//   node scripts/run-hierarchy-fold-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs for why (`?t=`
// module duplication makes harness-created entities invisible to the UI).
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const SCENE = "FoldSmoke";
const STORAGE_KEY = "engine.hierarchy.collapsed.v1";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

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

/** The live-module importer — see run-editor-ui-smoke.mjs. */
const IMPORT_LIVE = `
const importLive = (path) => {
  const prefix = location.origin + path;
  const fetched = performance.getEntriesByType("resource").map((e) => e.name)
    .filter((n) => n === prefix || n.startsWith(prefix + "?"));
  const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
  return import(/* @vite-ignore */ live ?? path);
};`;

/**
 * Builds the same two-parent scene every time, with FIXED entity ids so the
 * second session's tree is the one the first session's collapse set describes
 * — which is exactly what a saved/reopened scene is.
 */
const BUILD_SCENE = `${IMPORT_LIVE}
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  engine.clear();
  engine.sceneName = ${JSON.stringify(SCENE)};
  const mk = (id, name, parent) => engine.createEntity({ id, name, parent });
  const alpha = mk("fold-alpha", "Alpha", null);
  mk("fold-alpha-1", "AlphaChild1", alpha);
  mk("fold-alpha-2", "AlphaChild2", alpha);
  const beta = mk("fold-beta", "Beta", null);
  mk("fold-beta-1", "BetaChild1", beta);
  useSceneStore.getState().refresh();
  return engine.entities.size;`;

/** Visible hierarchy rows, in order, as entity ids. */
const rowIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".hierarchy-panel .hierarchy-row")].map((r) => r.dataset.entityId),
  );

async function boot() {
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(6000);
}

// ---------------------------------------------------------------------------
// Session 1 — a fresh scene folds itself, and unfolding is remembered
// ---------------------------------------------------------------------------

await boot();
const built = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await wait(800);

check("the harness scene reached the editor's engine", built === 5, `${built} entities`);

const firstRows = await rowIds();
check(
  "a scene with no saved folding opens collapsed to its roots",
  firstRows.join(",") === "fold-alpha,fold-beta",
  firstRows.join(",") || "(no rows)",
);

// Unfold Alpha through its real chevron, the way a user does.
await page.evaluate(() => {
  document
    .querySelector('.hierarchy-panel .hierarchy-row[data-entity-id="fold-alpha"] .row-disclosure')
    ?.click();
});
await wait(400);
const unfolded = await rowIds();
check(
  "clicking the chevron unfolds that branch one level",
  unfolded.join(",") === "fold-alpha,fold-alpha-1,fold-alpha-2,fold-beta",
  unfolded.join(",") || "(no rows)",
);

const saved = await page.evaluate((key, scene) => {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw).scenes?.[scene] ?? null) : null;
}, STORAGE_KEY, SCENE);
check(
  "the collapse set is persisted for this scene, minus the unfolded branch",
  Array.isArray(saved) && saved.includes("fold-beta") && !saved.includes("fold-alpha"),
  JSON.stringify(saved),
);

// ---------------------------------------------------------------------------
// Session 2 — a restart restores it, folded before the first paint
// ---------------------------------------------------------------------------

await boot();

// Watch the tree from BEFORE the scene exists. The bug being guarded against
// is a frame in which every row is present because the collapse state had not
// been applied yet; if that frame ever commits, the observer sees it.
await page.evaluate(() => {
  globalThis.__foldFrames = [];
  const record = () => {
    const ids = [...document.querySelectorAll(".hierarchy-panel .hierarchy-row")].map((r) => r.dataset.entityId);
    if (ids.length) globalThis.__foldFrames.push(ids.join(","));
  };
  new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
});

const rebuilt = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await wait(1200);
check("the scene was rebuilt for the second session", rebuilt === 5, `${rebuilt} entities`);

const restored = await rowIds();
check(
  "the remembered folding comes back after a restart",
  restored.join(",") === "fold-alpha,fold-alpha-1,fold-alpha-2,fold-beta",
  restored.join(",") || "(no rows)",
);

const frames = await page.evaluate(() => globalThis.__foldFrames ?? []);
const flatFrames = frames.filter((f) => f.includes("fold-beta-1"));
check(
  "no frame ever showed the tree fully unfolded — it is collapsed before the first paint",
  flatFrames.length === 0,
  flatFrames.length ? `${flatFrames.length} flashed frame(s): ${flatFrames[0]}` : `${frames.length} frames observed`,
);

// A saved set whose scene has not loaded yet must not be overwritten with the
// empty one — the regression that lost people's folding on every startup.
const stillSaved = await page.evaluate((key, scene) => {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw).scenes?.[scene] ?? null) : null;
}, STORAGE_KEY, SCENE);
check(
  "the saved set survived the restart intact",
  Array.isArray(stillSaved) && stillSaved.includes("fold-beta") && !stillSaved.includes("fold-alpha"),
  JSON.stringify(stillSaved),
);

// ---------------------------------------------------------------------------

await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

const passed = results.filter((r) => r.ok).length;
const realErrors = errors.filter((e) => !/save_scene|Failed to load resource/.test(e));
if (realErrors.length) {
  console.log(`\n${realErrors.length} console error(s):`);
  for (const e of realErrors.slice(0, 8)) console.log(`  ${e.slice(0, 300)}`);
}
console.log(
  `\n${passed === results.length && !realErrors.length ? "HIERARCHY-FOLD PASS" : "HIERARCHY-FOLD FAIL"} — ` +
    `${passed}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
process.exit(passed === results.length && !realErrors.length ? 0 : 1);
