// Authoring-ops smoke: materials, scene look, prefabs, model import, modules.
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-authoring-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// These ops all need a real project on disk (they write .mat files, read the
// prefab folder, patch project modules), which is why they live here behind the
// Tauri shim rather than in run-editor-api-smoke — that harness deliberately
// skips the project hub so it can test the API with nothing open.
//
// Runs headless: nothing here needs a renderer. The one op group that does —
// viewport.screenshot — is covered in run-editor-api-smoke, which runs headed
// for exactly that reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- a scratch project the shim may write to ---------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-author-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Authoring", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "models"), { recursive: true });
// Not a real glTF — asset.import only needs the path to exist and to have a
// model extension; loading is the model component's problem, and a fake file
// keeps this harness from depending on a binary fixture.
fs.writeFileSync(path.join(root, "models", "Barrel.glb"), "glTF-placeholder");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click(),
);
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

const out = await page.evaluate(async (projectRoot) => {
  const Editor = globalThis.__editorApi;
  if (!Editor) return { fatal: "the editor API was never installed" };
  const report = {};

  // === materials ===========================================================
  const created = await Editor.materials.create("Brick", { color: "#b5482f", roughness: 0.85 });
  report.material = {
    path: created.path,
    inMaterialsFolder: /\/materials\/Brick\.mat$/.test(created.path),
    // Unspecified fields must come from MATERIAL_DEFAULTS, not be absent — a
    // half-written .mat is what makes a material behave differently from one
    // the inspector produced.
    hasDefaults: created.definition.metalness === 0 && "map" in created.definition,
    colorApplied: created.definition.color === "#b5482f",
  };

  const read = await Editor.materials.get(created.path);
  report.materialRoundTrip = read.definition.roughness === 0.85;

  await Editor.materials.set(created.path, { roughness: 0.1, opacity: 0.5 });
  const patched = await Editor.materials.get(created.path);
  report.materialPatch = {
    changed: patched.definition.roughness === 0.1,
    preserved: patched.definition.color === "#b5482f",
    // Opacity below 1 without `transparent` renders fully opaque, which reads
    // as "the tool ignored my opacity" — the op derives the flag.
    derivedTransparent: patched.definition.transparent === true,
  };

  const escaped = await Editor.callTool("material_get", { path: "C:/Windows/win.ini" });
  report.materialContained = escaped.ok === false && /outside the open project/.test(escaped.error ?? "");

  // BUG-11: `roughness: 5`, `metalness: -2`, `color: "banana"` and `opacity: 42`
  // were all accepted verbatim and written to the user's .mat, only failing
  // later inside three.js ("THREE.Color: Unknown color banana") — by which time
  // the invalid data is on disk rather than in the call that produced it.
  const badPatch = await Editor.callTool("material_set", {
    path: created.path,
    patch: { roughness: 5, color: "banana" },
  });
  const badCreate = await Editor.callTool("material_create", { name: "QaBad", opacity: 42 });
  const afterBad = await Editor.materials.get(created.path);
  report.materialValidation = {
    rangeRefused: badPatch.ok === false && /between 0 and 1/.test(badPatch.error ?? ""),
    createRefused: badCreate.ok === false && /between 0 and 1/.test(badCreate.error ?? ""),
    // Refused means UNCHANGED — a validation that rejects after writing is no
    // validation at all.
    assetUntouched: afterBad.definition.roughness === 0.1 && afterBad.definition.color === "#b5482f",
  };
  const badColour = await Editor.callTool("material_set", { path: created.path, patch: { color: "banana" } });
  report.materialColourRefused =
    badColour.ok === false && /hex colour/.test(badColour.error ?? "");

  // BUG-10: containment compared the RAW path string against the project root,
  // so prefixing the root with enough `..` segments satisfied the prefix test
  // while pointing anywhere on the disk. The absolute form was refused
  // correctly, which is exactly what made the hole look closed.
  const readAbsolute = await Editor.callTool("asset_read", { path: "C:/Windows/win.ini" });
  const readTraversal = await Editor.callTool("asset_read", {
    path: `${projectRoot}/../../../Windows/win.ini`,
  });
  const writeTraversal = await Editor.callTool("asset_write", {
    path: `${projectRoot}/../qa-escape.txt`,
    contents: "should never be written",
  });
  const deleteTraversal = await Editor.callTool("asset_delete", {
    paths: [`${projectRoot}/../qa-escape.txt`],
  });
  report.traversal = {
    absoluteReadRefused: readAbsolute.ok === false && /outside the open project/.test(readAbsolute.error ?? ""),
    dotDotReadRefused: readTraversal.ok === false && /outside the open project/.test(readTraversal.error ?? ""),
    // The write ops share the check, and a traversing write is arbitrary file
    // write while a traversing delete is not undoable — they were never probed
    // in the QA pass and are audited here with the read.
    dotDotWriteRefused: writeTraversal.ok === false && /outside the open project/.test(writeTraversal.error ?? ""),
    dotDotDeleteRefused: deleteTraversal.ok === false && /outside the open project/.test(deleteTraversal.error ?? ""),
    // A `..` that stays INSIDE the project is a legal way to spell a path and
    // must still work, or the fix is a different bug.
    innocentDotDotAllowed: (await Editor.callTool("asset_read", {
      path: `${projectRoot}/materials/../materials/Brick.mat`,
    })).ok === true,
  };

  // A material is only useful if a mesh can actually take it.
  const mesh = Editor.entities.create({
    name: "BrickWall",
    components: [{ type: "mesh", props: { geometry: "box", material: created.path } }],
  });
  report.materialAssignable =
    Editor.entities.get(mesh.id).components.find((c) => c.type === "mesh")?.props.material === created.path;

  // === scene look ==========================================================
  const settingsBefore = Editor.call ? await Editor.call("scene.getSettings") : null;
  report.sceneSettingsShape = {
    hasFog: !!settingsBefore?.settings?.fog,
    hasEnvironment: !!settingsBefore?.settings?.environment,
    listsToneMappings: Array.isArray(settingsBefore?.toneMappings) && settingsBefore.toneMappings.length > 2,
  };

  await Editor.call("scene.setSettings", {
    patch: { fog: { type: "exp2", color: "#101018", density: 0.04 }, toneMapping: "agx" },
    label: "Dusk look",
  });
  const afterLook = await Editor.call("scene.getSettings");
  report.sceneSettings = {
    fogApplied: afterLook.settings.fog.type === "exp2" && afterLook.settings.fog.density === 0.04,
    toneApplied: afterLook.settings.toneMapping === "agx",
    // Merged, not replaced: untouched sections must survive.
    envPreserved: !!afterLook.settings.environment,
    undoable: Editor.history.get().undoLabel === "Dusk look",
  };
  Editor.history.undo();
  const reverted = await Editor.call("scene.getSettings");
  report.sceneSettingsUndo = reverted.settings.toneMapping !== "agx";

  // === prefabs =============================================================
  const prefabSource = Editor.entities.create({
    name: "Crate",
    components: [{ type: "mesh", props: { geometry: "box" } }],
  });
  const prefab = await Editor.prefabs.createFrom(prefabSource.id);
  report.prefabCreated = typeof prefab.path === "string" && /\.prefab$/i.test(prefab.path);

  const listed = await Editor.prefabs.list();
  // Exact string equality on purpose: both sides must already be normalised to
  // forward slashes, or a caller comparing a listed path against one it holds
  // would silently never match on Windows.
  report.prefabListed = listed.some((entry) => entry.path === prefab.path);
  report.prefabPathsNormalised = listed.every((entry) => !entry.path.includes(String.fromCharCode(92)));

  const instance = await Editor.prefabs.instantiate(prefab.path, { position: [3, 0, 0] });
  report.prefabInstantiated = {
    named: typeof instance.name === "string",
    positioned: JSON.stringify(instance.transform.position) === "[3,0,0]",
    hasMesh: instance.components.some((c) => c.type === "mesh"),
  };

  // === import ==============================================================
  const imported = await Editor.call("asset.import", {
    path: `${projectRoot}/models/Barrel.glb`,
    position: [0, 0, 5],
  });
  report.import = {
    named: imported.name === "Barrel",
    hasModel: imported.components.some((c) => c.type === "model"),
    positioned: JSON.stringify(imported.transform.position) === "[0,0,5]",
  };
  const badImport = await Editor.callTool("asset_import", { path: `${projectRoot}/project.json` });
  report.importRejectsNonModels = badImport.ok === false && /not a model file/.test(badImport.error ?? "");

  // === modules =============================================================
  const modules = await Editor.modules.list();
  report.modules = {
    isArray: Array.isArray(modules),
    shaped: modules.every((m) => typeof m.id === "string" && typeof m.enabled === "boolean"),
    count: modules.length,
  };

  return report;
}, root.replaceAll("\\", "/"));

if (out.fatal) {
  console.log(` FAIL  ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

// --- materials ---------------------------------------------------------------
check("material.create writes into <project>/materials", out.material.inMaterialsFolder, out.material.path);
check("…filling unspecified fields from the engine defaults", out.material.hasDefaults);
check("…and applying what was passed", out.material.colorApplied);
check("material.get reads it back", out.materialRoundTrip === true);
check("material.set patches only the named fields", out.materialPatch.changed && out.materialPatch.preserved, JSON.stringify(out.materialPatch));
check("…and derives `transparent` from opacity", out.materialPatch.derivedTransparent === true);
check("material paths are confined to the project", out.materialContained === true);
check("material.set refuses an out-of-range scalar", out.materialValidation.rangeRefused === true);
check("material.create refuses one too", out.materialValidation.createRefused === true);
check("…and refuses a colour that is not a colour", out.materialColourRefused === true);
check("…leaving the .mat on disk untouched", out.materialValidation.assetUntouched === true);
check("asset.read refuses an absolute path outside the project", out.traversal.absoluteReadRefused === true);
check("…and one that escapes the project with `..`", out.traversal.dotDotReadRefused === true);
check("asset.write cannot escape with `..` either", out.traversal.dotDotWriteRefused === true);
check("…nor can asset.delete", out.traversal.dotDotDeleteRefused === true);
check("…while a `..` that stays inside the project still resolves", out.traversal.innocentDotDotAllowed === true);
check("the material assigns to a mesh component", out.materialAssignable === true);
const matOnDisk = fs.existsSync(path.join(root, "materials", "Brick.mat"));
check("the .mat really exists on disk", matOnDisk, path.join(root, "materials", "Brick.mat"));

// --- scene look ---------------------------------------------------------------
check("scene.getSettings exposes the look sections", out.sceneSettingsShape.hasFog && out.sceneSettingsShape.hasEnvironment, JSON.stringify(out.sceneSettingsShape));
check("…and the valid tone-mapping names", out.sceneSettingsShape.listsToneMappings === true);
check("scene.setSettings applies fog and tone mapping", out.sceneSettings.fogApplied && out.sceneSettings.toneApplied, JSON.stringify(out.sceneSettings));
check("…merging rather than replacing", out.sceneSettings.envPreserved === true);
check("…under the caller's undo label", out.sceneSettings.undoable === true);
check("…and it is undoable", out.sceneSettingsUndo === true);

// --- prefabs ------------------------------------------------------------------
check("prefab.createFromEntity writes a .prefab", out.prefabCreated === true);
check("prefab.list finds it", out.prefabListed === true);
check("…returning forward-slash paths that compare equal", out.prefabPathsNormalised === true);
check("prefab.instantiate places an instance", out.prefabInstantiated.positioned, JSON.stringify(out.prefabInstantiated));
check("…carrying the source's components", out.prefabInstantiated.hasMesh === true);

// --- import -------------------------------------------------------------------
check("asset.import names the entity after the file", out.import.named === true);
check("…with a model component", out.import.hasModel === true);
check("…at the requested position", out.import.positioned === true);
check("…and refuses non-model files", out.importRejectsNonModels === true);

// --- modules ------------------------------------------------------------------
check("module.list returns shaped entries", out.modules.isArray && out.modules.shaped, `${out.modules.count} modules`);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|Barrel\.glb|glTF/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\nAUTHORING-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
