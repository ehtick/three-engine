// Live-update guard: does anything stateful still assume it is evaluated once?
//
//   node scripts/run-live-update-test.mjs
//
// No browser, no dev server — this is a source scan, and it runs in a second.
//
// ## The bug class it guards
//
// A module-level `const store = create(...)` or `const cache = new Map()` is a
// singleton only while the module is evaluated once, and in this app that is not
// guaranteed: Vite rewrites `import()` specifiers for a changed module to a
// `?t=<mtime>` URL, and a fresh URL is a fresh module instance while the old one
// stays live in React's tree. The same file is also reachable as `/src/…` and
// `/@fs/C:/…`.
//
// When that happens to something stateful the editor splits in half, silently:
// MCP-driven edits push into one command bus while the mounted panels subscribe
// to the other; an asset invalidation clears one cache while the renderer reads
// the other. Nothing throws, the engine really is mutated, and everything
// autosaves — so the change "only appears after a restart", which reads as the
// feature being broken.
//
// `vmSingleton` (editor) and `vmState` (engine) are the fix. The point of this
// test is that the list of things that need them cannot quietly grow again:
// every new zustand store is checked automatically, and the caches and
// registries that were wrapped by hand stay wrapped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const sources = walk("src");

// --- 1. every zustand store is VM-wide ---------------------------------------
//
// Automatic rather than a list: a store added next month is covered without
// anyone remembering this file exists. That is the whole point — the previous
// version of this rule was a "still unwrapped" list in a project note, and
// three of the entries on it went on to cause the exact bug it described.

const storeDeclarations = [];
for (const rel of sources) {
  const src = read(rel);
  // `create(` is also three's node-material factory and a few local helpers;
  // only files importing zustand are making a store.
  if (!/from "zustand"/.test(src)) continue;
  const lines = src.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /(?:export\s+)?const\s+(\w+)\s*=\s*(.*\bcreate\()/.exec(line);
    if (!match) return;
    // Wrapped either inline (`= vmSingleton("x", () => create(…))`) or some
    // lines up, when the store is built inside a larger singleton factory —
    // `toasts.js` keeps its id counter and timers in there with it, and
    // `gitStore.js` documents its runtime record for 11 lines before the
    // store expression appears.
    const context = lines.slice(Math.max(0, index - 16), index + 1).join("\n");
    storeDeclarations.push({ rel, name: match[1], wrapped: /vmSingleton\(/.test(context) });
  });
}

check("found the editor's zustand stores to check", storeDeclarations.length >= 12, `${storeDeclarations.length} stores`);
const unwrappedStores = storeDeclarations.filter((s) => !s.wrapped);
check(
  "every zustand store is created through vmSingleton",
  unwrappedStores.length === 0,
  unwrappedStores.map((s) => `${s.name} (${s.rel})`).join(", "),
);

// --- 2. the hand-wrapped caches and registries stay wrapped -------------------
//
// These are not detectable by shape — a `new Map()` is usually fine — so they
// are listed. Each entry is a cache or registry that two live copies of would
// break a specific live-update path, named here so a revert is a test failure
// rather than a bug report six weeks later.

const MUST_BE_VM_WIDE = [
  ["src/editor/engineInstance.js", "the Engine instance itself — two engines means edits land in one and the viewport draws the other"],
  ["src/editor/assetLoader.js", "the path -> blob URL cache and its invalidation listeners"],
  ["src/editor/commands/CommandBus.js", "the command bus and history store"],
  ["src/editor/store/sceneStore.js", "the scene mirror the Hierarchy renders"],
  ["src/editor/store/selectionStore.js", "the selection every panel reads"],
  ["src/editor/store/projectStore.js", "the project listing the Assets panel renders"],
  ["src/editor/playMode.js", "the Play snapshot — losing it means Stop cannot restore the scene"],
  ["src/editor/sceneIO.js", "which file Ctrl+S writes"],
  ["src/editor/prefab.js", "the scene parked while a prefab is open"],
  ["src/editor/projectSettings.js", "the applied-settings listeners"],
  ["src/editor/api/index.js", "the install guard — a second install starts a second gizmo pass"],
  ["src/engine/components/registry.js", "the component class registry"],
  ["src/engine/materialAsset.js", "the material cache and its subscribers"],
  ["src/engine/geometryAsset.js", "the decoded geometry cache"],
  ["src/engine/textureAsset.js", null],
  ["src/engine/audio/AudioAsset.js", "the decoded audio cache and its subscribers"],
  ["src/engine/cubemapAsset.js", "the cubemap cache"],
  ["src/engine/sprite/atlasAsset.js", "the atlas cache"],
  ["src/engine/shaderGraph.js", "the shader-graph texture cache"],
  ["src/engine/tslGraph.js", "the TSL texture cache"],
  ["src/engine/editorBridge.js", "the editor API slot and the script menu registry"],
];

for (const [rel, why] of MUST_BE_VM_WIDE) {
  if (why === null) continue; // listed for the reader; nothing wrapped there yet
  const src = read(rel);
  check(`${rel} keeps its state VM-wide`, /vmSingleton\(|vmState\(|vmRecord\(|Symbol\.for\(|globalThis\.__/.test(src), why);
}

// --- 3. the duplicate-module guard is installed ------------------------------

const viteConfig = read("vite.config.js");
check("the dev server injects the duplicate-module guard", /duplicateModuleGuard\(\)/.test(viteConfig));
const guard = read("vite/duplicateModuleGuard.js");
check("…only while serving, never in a production bundle", /apply:\s*"serve"/.test(guard));
check("…and reports through globalThis.__duplicateModules", /__duplicateModules/.test(guard));

// --- 4. external file changes have a path into the editor --------------------

const watcher = read("src-tauri/src/watcher.rs");
check("the project folder is watched natively", /fn watch_project/.test(watcher));
check("…and the editor's own writes are filtered out", /fn note_self_write/.test(watcher) && /was_self_write/.test(watcher));
const lib = read("src-tauri/src/lib.rs");
for (const command of ["save_scene", "write_binary_file", "delete_path", "create_dir"]) {
  const body = lib.slice(lib.indexOf(`fn ${command}(`), lib.indexOf(`fn ${command}(`) + 700);
  check(`${command} marks its write so the watcher ignores it`, /note_self_write/.test(body));
}

const js = read("src/editor/projectWatcher.js");
check("a changed asset is re-read from disk", /export async function refreshAssetFromDisk/.test(js));
check("…and a changed scene never discards unsaved work", /dirty/.test(js) && /pushToast/.test(js));

const assetOps = read("src/editor/api/ops/assets.js");
check("asset.write invalidates the caches it just wrote past", /refreshAssetFromDisk\(full\)/.test(assetOps));
check("agents can force a re-read after writing files themselves", /name: "asset\.refresh"/.test(assetOps));
check("…and can ask whether the watcher is running", /name: "asset\.watchStatus"/.test(assetOps));

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\nLIVE-UPDATE-TEST ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
