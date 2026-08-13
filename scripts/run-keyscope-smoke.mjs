// Keyboard-ownership smoke test.
//
// Two things are gated here:
//
//   1. Every context owns its own keys. `src/editor/keyScope.js` resolves ONE
//      owner per keystroke — the code editor, a text field, or a panel — and
//      the global scene shortcuts stand down for it. The regression this
//      replaces: typing in the Code panel, where Ctrl+S saved the scene as well
//      as the file and Ctrl+F could never open Monaco's find widget because the
//      quick-search overlay took it in the capture phase.
//
//   2. Escape no longer un-maximizes a panel. Maximize is a tab-bar gesture
//      both ways — double-click in, double-click out — because inside a
//      maximized panel Escape means "cancel this transform / close this
//      popover", and it was throwing the layout away as a side effect.
//
//   npx vite --port 5217
//   node scripts/run-keyscope-smoke.mjs [url]
//
// HEADED=1 to watch it run, VERBOSE=1 for step tracing.
//
// START THE DEV SERVER FRESH — see the note in run-editor-ui-smoke.mjs about
// Vite's `?t=` rewriting duplicating the Engine singleton.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5217/";

// --- a throwaway project with one script to open in the code editor ---------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-keyscope-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "KeyScope", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(root, "scripts", "Spin.js"),
  "export default class Spin {\n  onUpdate(dt) {\n    this.entity.rotation.y += dt;\n  }\n}\n",
);
const scriptPath = path.join(root, "scripts", "Spin.js").replaceAll("\\", "/");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

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
const step = (name) => process.env.VERBOSE && console.log(`  [step] ${name}`);

step("goto");
await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

// Opening the project is kicked off WITHOUT awaiting it from Node — a
// long-lived page promise gets collected out from under puppeteer. Poll instead.
await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore
    .getState()
    .openProject(projectRoot)
    .then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
step("project open");

// --- open the script in the Code panel and wait for Monaco ------------------

await page.evaluate(async (file) => {
  const { openCodeFile } = await globalThis.__importLive("/src/editor/codeStore.js");
  openCodeFile(file);
}, scriptPath);

let monacoReady = false;
for (let i = 0; i < 60; i++) {
  monacoReady = await page.evaluate(() => !!document.querySelector(".monaco-editor textarea"));
  if (monacoReady) break;
  await wait(500);
}
check("code editor mounts", monacoReady);
if (!monacoReady) {
  console.log(errors.slice(0, 10).join("\n"));
  await browser.close();
  process.exit(1);
}
await wait(800);

// --- 1. ownership resolution, against the real DOM --------------------------
//
// Dispatched on real elements so `event.target` is genuine — the same input the
// live handlers see. A window listener asks `keyScope` the same question they
// ask, in the same phase.

step("probe ownership");
const owners = await page.evaluate(async () => {
  const { activeKeyScope, keyScopeOwns } = await globalThis.__importLive("/src/editor/keyScope.js");
  const seen = [];
  // Capture phase + `stopImmediatePropagation`: this section measures what
  // `keyScope` decides, and nothing else. Without it the probe's own Ctrl+B
  // would reach the real handler and open the build dialog. The end-to-end
  // section below dispatches for real.
  const probe = (e) => {
    seen.push({ scope: activeKeyScope(e)?.id ?? null, owns: keyScopeOwns(e) });
    e.stopImmediatePropagation();
  };
  window.addEventListener("keydown", probe, true);

  const fire = (el, init) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    return seen[seen.length - 1];
  };

  const monaco = document.querySelector(".monaco-editor textarea");
  monaco.focus();
  const out = {
    codeSave: fire(monaco, { key: "s", ctrlKey: true }),
    codeFind: fire(monaco, { key: "f", ctrlKey: true }),
    codeDelete: fire(monaco, { key: "Delete" }),
    codeUndo: fire(monaco, { key: "z", ctrlKey: true }),
    codePlay: fire(monaco, { key: "p", ctrlKey: true }),
    codeBuild: fire(monaco, { key: "b", ctrlKey: true }),
  };

  // A plain text field: it owns typing and the editing chords, but has no save
  // or find of its own, so those keep reaching the app.
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  out.fieldUndo = fire(field, { key: "z", ctrlKey: true });
  out.fieldDelete = fire(field, { key: "Delete" });
  out.fieldSave = fire(field, { key: "s", ctrlKey: true });
  out.fieldFind = fire(field, { key: "f", ctrlKey: true });
  field.remove();

  // Nothing focused and the pointer parked at (-1,-1): the editor at large.
  document.body.focus();
  out.globalSave = fire(document.body, { key: "s", ctrlKey: true });
  out.globalDelete = fire(document.body, { key: "Delete" });

  window.removeEventListener("keydown", probe, true);
  return out;
});

check("code editor owns Ctrl+S", owners.codeSave.scope === "code" && owners.codeSave.owns === true,
  JSON.stringify(owners.codeSave));
check("code editor owns Ctrl+F", owners.codeFind.owns === true, JSON.stringify(owners.codeFind));
check("code editor owns Delete", owners.codeDelete.owns === true, JSON.stringify(owners.codeDelete));
check("code editor owns Ctrl+Z", owners.codeUndo.owns === true, JSON.stringify(owners.codeUndo));
check("Ctrl+P still reaches the app from the code editor", owners.codePlay.owns === false,
  JSON.stringify(owners.codePlay));
check("Ctrl+B still reaches the app from the code editor", owners.codeBuild.owns === false,
  JSON.stringify(owners.codeBuild));
check("text field owns Ctrl+Z", owners.fieldUndo.scope === "text" && owners.fieldUndo.owns === true,
  JSON.stringify(owners.fieldUndo));
check("text field owns Delete", owners.fieldDelete.owns === true, JSON.stringify(owners.fieldDelete));
check("Ctrl+S still saves the scene from a text field", owners.fieldSave.owns === false,
  JSON.stringify(owners.fieldSave));
check("Ctrl+F still opens quick search from a text field", owners.fieldFind.owns === false,
  JSON.stringify(owners.fieldFind));
check("nothing owns keys outside a scope", owners.globalSave.scope === null && owners.globalSave.owns === false,
  JSON.stringify(owners.globalSave));
check("Delete reaches the scene outside a scope", owners.globalDelete.owns === false,
  JSON.stringify(owners.globalDelete));

// --- 2. the fix end to end: quick search must not steal Ctrl+F from Monaco --

step("quick search vs monaco");
const quickSearch = await page.evaluate(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const press = (el, init) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const isOpen = () => !!document.querySelector(".quick-search");
  const close = async () => {
    // The overlay's own input is focused while it is open, so Escape has to be
    // aimed there — that is also the press a real user makes.
    for (let i = 0; i < 5 && isOpen(); i++) {
      press(document.querySelector(".quick-search input") ?? document.body, { key: "Escape" });
      await settle();
    }
    return !isOpen();
  };

  // The ownership probe above dispatched a Ctrl+F from a text field, which is
  // supposed to open this overlay. Start from closed either way.
  await close();

  const monaco = document.querySelector(".monaco-editor textarea");
  monaco.focus();
  press(monaco, { key: "f", ctrlKey: true });
  await settle();
  const fromCode = isOpen();
  await close();

  // Blur explicitly: the code editor keeps focus after the press above, and
  // ownership follows focus, not the element a synthetic event names as its
  // target. Leaving it focused would be asking the same question twice.
  monaco.blur();
  document.activeElement?.blur?.();
  press(document.body, { key: "f", ctrlKey: true });
  await settle();
  const fromEditor = isOpen();
  const closed = await close();
  return { fromCode, fromEditor, closed };
});
check("Ctrl+F in the code editor does NOT open quick search", quickSearch.fromCode === false);
check("Ctrl+F elsewhere still opens quick search", quickSearch.fromEditor === true);
check("quick search still closes on Escape", quickSearch.closed === true);

// --- 3. maximize is a double-click gesture, and Escape leaves it alone ------

step("maximize gestures");
const maximize = await page.evaluate(async () => {
  const container = document.querySelector(".dock-container");
  const tab = document.querySelector(".dv-tab");
  const settle = () => new Promise((r) => setTimeout(r, 350));
  const isMax = () => !!globalThis.__dockApi?.hasMaximizedGroup?.();
  const dbl = () => tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

  if (!container || !tab || !globalThis.__dockApi) return { error: "dock not ready" };
  if (isMax()) globalThis.__dockApi.exitMaximizedGroup();
  await settle();

  dbl();
  await settle();
  const afterDouble = isMax();

  // Escape from the panel body — the exact press that used to throw the layout
  // away while cancelling a transform or closing a popover. Dispatched on a
  // real element (never on `window`) so `event.target` is what a browser would
  // actually deliver.
  const body = document.querySelector(".dv-groupview .dv-content-container") ?? document.body;
  body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  const afterEscape = isMax();

  dbl();
  await settle();
  const afterSecondDouble = isMax();

  return { afterDouble, afterEscape, afterSecondDouble };
});
check("double-click on a tab maximizes", maximize.afterDouble === true, maximize.error ?? "");
check("Escape does NOT un-maximize", maximize.afterEscape === true, maximize.error ?? "");
check("double-click again restores", maximize.afterSecondDouble === false, maximize.error ?? "");

// --- report -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
if (errors.length) {
  console.log("\nConsole errors:");
  for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
