// Live-update smoke: does an edit — from anywhere — reach the screen without a restart?
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-live-update-smoke.mjs [url]
//
// HEADED=1 to watch it run. START THE DEV SERVER FRESH (see run-editor-ui-smoke).
//
// ## What this is for
//
// "Changes only show up after I restart the editor" was reported three times
// across as many months, with a different underlying cause each time, and every
// existing test passed through all three. They pass because they read the model:
// the engine really was mutated, the file really was written. What was broken
// was the wiring between that and the pixels — a second copy of a store that no
// mounted component subscribed to, a cache nobody invalidated, a file nobody was
// watching.
//
// So this harness only ever asserts on what a person would see: rows in the
// Assets panel, rows in the Hierarchy, the URL the renderer would actually
// fetch. And it makes the failure modes happen on purpose — it duplicates the
// module graph the way Vite does, and it changes files behind the editor's back
// the way an agent's own file tools do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a throwaway project with something in it --------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-live-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "LiveUpdate", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "materials"), { recursive: true });
fs.writeFileSync(path.join(root, "materials", "Wall.mat"), JSON.stringify({ color: "#ff0000", roughness: 0.5 }, null, 2));

let watchedRoot = null;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    // The native watcher lives in Rust; what is under test on this side is
    // whether the editor asks for it and what it does with the events.
    watch_project: ({ path: watched }) => {
      watchedRoot = watched;
      return true;
    },
    unwatch_project: () => {
      watchedRoot = null;
      return null;
    },
  },
});

const errors = [];
const warnings = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
  // Puppeteer has spelled this both ways across versions; accept either rather
  // than have the assertion below depend on which one is installed.
  if (m.type() === "warning" || m.type() === "warn") warnings.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore
    .getState()
    .openProject(projectRoot)
    .then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
check("the scratch project opens", await page.evaluate(() => globalThis.__openDone === true));

// The other half of "only when an assistant connects" — no bridge here, so the
// project folder must stay clean. Someone who has never attached an assistant
// should not find a file about them in their game.
check(
  "no assistant connected, so no AGENTS.md in the project",
  !fs.existsSync(path.join(root, "AGENTS.md")) && !fs.existsSync(path.join(root, "CLAUDE.md")),
);

// --- the guard: a clean boot must not have duplicated anything ---------------

const bootDuplicates = await page.evaluate(() => [...(globalThis.__duplicateModules ?? [])]);
check(
  "a freshly loaded editor has ONE copy of every module",
  bootDuplicates.length === 0,
  bootDuplicates.slice(0, 5).join(", "),
);

// --- duplicate the module graph the way Vite does ----------------------------
//
// `?dup=1` reproduces the real mechanism (Vite's own `?t=<mtime>`), not a model
// of it. Everything below has to survive it, because in a dev session where
// anything edits source while the editor is open, it WILL happen.

const identity = await page.evaluate(async () => {
  const dup = (p) => import(/* @vite-ignore */ `${location.origin}${p}?dup=1`);
  const live = globalThis.__importLive;
  const same = {};

  const [engineA, engineB] = [await live("/src/editor/engineInstance.js"), await dup("/src/editor/engineInstance.js")];
  same.engine = (await engineA.ensureEngine()) === (await engineB.ensureEngine());

  const pairs = [
    ["projectStore", "/src/editor/store/projectStore.js", "useProjectStore"],
    ["playStore", "/src/editor/store/playStore.js", "usePlayStore"],
    ["prefabStore", "/src/editor/store/prefabStore.js", "usePrefabStore"],
    ["consoleStore", "/src/editor/store/consoleStore.js", "useConsoleStore"],
    ["modulesStore", "/src/editor/modules.js", "useModulesStore"],
    ["assetFlagsStore", "/src/editor/assetFlags.js", "useAssetFlagsStore"],
    ["geometryEditStore", "/src/editor/store/geometryEditStore.js", "useGeometryEditStore"],
    ["inputStore", "/src/editor/store/inputStore.js", "useInputStore"],
  ];
  for (const [key, p, name] of pairs) {
    const [a, b] = [await live(p), await dup(p)];
    same[key] = a[name] === b[name];
  }

  // The engine half of the seam. A second component registry means a scene
  // deserializes against a table half its components are missing from.
  const [regA, regB] = [await live("/src/engine/components/registry.js"), await dup("/src/engine/components/registry.js")];
  same.componentRegistry = regA.getComponentClass("mesh") === regB.getComponentClass("mesh");

  // The material cache: two of these is "the material edit shows after a restart".
  const [matA, matB] = [await live("/src/engine/materialAsset.js"), await dup("/src/engine/materialAsset.js")];
  same.materialCache = matA.getDefaultMaterial() === matB.getDefaultMaterial();

  // The asset invalidation bus: a listener registered through one copy has to
  // hear an invalidation raised through the other, or nothing reloads.
  const [loadA, loadB] = [await live("/src/editor/assetLoader.js"), await dup("/src/editor/assetLoader.js")];
  let heard = false;
  const off = loadA.onAssetInvalidated(() => (heard = true));
  loadB.invalidateBlobUrl("materials/Wall.mat");
  off();
  same.invalidationBus = heard;

  return same;
});

check("a duplicated engineInstance still resolves to the ONE engine", identity.engine);
check("…one project store (the Assets panel's)", identity.projectStore);
check("…one play store", identity.playStore);
check("…one prefab store", identity.prefabStore);
check("…one console store", identity.consoleStore);
check("…one modules store", identity.modulesStore);
check("…one asset-flags store", identity.assetFlagsStore);
check("…one geometry-edit store", identity.geometryEditStore);
check("…one input store", identity.inputStore);
check("…one component registry", identity.componentRegistry);
check("…one material cache", identity.materialCache);
check("…and an invalidation raised through either copy reaches listeners on the other", identity.invalidationBus);

// The guard should have NOTICED all that duplication — that is its whole job.
const seenDuplicates = await page.evaluate(() => [...(globalThis.__duplicateModules ?? [])]);
check(
  "the dev guard names the duplicated modules instead of letting them pass silently",
  seenDuplicates.length >= 8,
  `${seenDuplicates.length} reported`,
);
check(
  "…in the console, where someone debugging this would look",
  warnings.some((w) => w.includes("[duplicate module]")),
);

// --- an MCP tool call through the DUPLICATE must still reach the UI ----------

const hierarchyBefore = await page.evaluate(
  () => document.querySelectorAll(".hierarchy-panel [data-entity-id], .hierarchy-panel .tree-row").length,
);
const toolOutcome = await page.evaluate(async () => {
  const dup = (p) => import(/* @vite-ignore */ `${location.origin}${p}?dup=2`);
  const { callTool } = await dup("/src/editor/api/registry.js");
  return callTool("entity_create", { name: "LiveProbe" });
});
await wait(900);
const hierarchyAfter = await page.evaluate(() => ({
  rows: document.querySelectorAll(".hierarchy-panel [data-entity-id], .hierarchy-panel .tree-row").length,
  named: document.body.innerText.includes("LiveProbe"),
}));
check("an MCP tool call succeeds through a duplicated registry", toolOutcome?.ok === true, JSON.stringify(toolOutcome?.error ?? ""));
check(
  "…and the Hierarchy shows the entity it created",
  hierarchyAfter.rows === hierarchyBefore + 1 && hierarchyAfter.named,
  `${hierarchyBefore} -> ${hierarchyAfter.rows} rows, named=${hierarchyAfter.named}`,
);

// --- files changed BEHIND the editor's back ----------------------------------
//
// This is the half nothing covered: an agent writing project files with its own
// tools, an artist re-exporting a texture, a `git checkout`. The editor never
// asked for those writes, so nothing in it invalidates anything.

check("the editor asked to watch the open project", watchedRoot === root.replaceAll("\\", "/"), String(watchedRoot));

// Something the editor has definitely already cached, changed on disk by
// someone else entirely.
const matPath = `${root.replaceAll("\\", "/")}/materials/Wall.mat`;
const urlBefore = await page.evaluate(async (p) => {
  const { toBlobUrl } = await globalThis.__importLive("/src/editor/assetLoader.js");
  return toBlobUrl(p);
}, matPath);

fs.writeFileSync(path.join(root, "materials", "Wall.mat"), JSON.stringify({ color: "#00ff00", roughness: 0.1 }, null, 2));
fs.writeFileSync(path.join(root, "NewFromOutside.txt"), "written by something that is not the editor");

await page.evaluate((changed) => {
  window.__tauriShimEmit("project-files-changed", changed.map((p) => ({ path: p, kind: "modify" })));
}, [matPath, `${root.replaceAll("\\", "/")}/NewFromOutside.txt`]);
await wait(1500);

const urlAfter = await page.evaluate(async (p) => {
  const { toBlobUrl } = await globalThis.__importLive("/src/editor/assetLoader.js");
  return toBlobUrl(p);
}, matPath);
check(
  "a file changed on disk drops the cached copy the renderer would have used",
  !!urlBefore && !!urlAfter && urlBefore !== urlAfter,
  `${String(urlBefore).slice(-12)} -> ${String(urlAfter).slice(-12)}`,
);

const listedOutside = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  return useProjectStore.getState().entries.map((e) => e.name);
});
check(
  "…and a file created on disk appears in the Assets panel with nothing clicked",
  listedOutside.includes("NewFromOutside.txt"),
  listedOutside.join(", "),
);

// --- asset.write: the tool an agent uses to author a file --------------------

const writeProbe = await page.evaluate(async (dir) => {
  const { callTool } = await globalThis.__importLive("/src/editor/api/registry.js");
  const { toBlobUrl } = await globalThis.__importLive("/src/editor/assetLoader.js");
  const p = `${dir}/materials/Tool.mat`;
  await callTool("asset_write", { path: p, contents: JSON.stringify({ color: "#0000ff" }) });
  const first = await toBlobUrl(p);
  const outcome = await callTool("asset_write", { path: p, contents: JSON.stringify({ color: "#ffffff" }) });
  const second = await toBlobUrl(p);
  return { ok: outcome.ok, changed: first !== second };
}, root.replaceAll("\\", "/"));
check("asset.write succeeds", writeProbe.ok === true);
check("…and re-writing a file the editor had cached invalidates that cache", writeProbe.changed);

const refreshOp = await page.evaluate(async () => {
  const { callTool } = await globalThis.__importLive("/src/editor/api/registry.js");
  const status = await callTool("asset_watchStatus", {});
  const refreshed = await callTool("asset_refresh", {});
  return { status: status.result, refreshOk: refreshed.ok };
});
check("an agent can ask whether the editor is watching for outside changes", refreshOp.status?.watching === true, JSON.stringify(refreshOp.status));
check("…and can force a re-read after writing files itself", refreshOp.refreshOk === true);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|WebSocket/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\nLIVE-UPDATE-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
