// The Animator panel's layers, blend trees and avatar masks, driven through the
// REAL editor.
//
// `npm run test:anim` proves the runtime blends correctly. It cannot prove that
// the panel writes a controller the runtime can read — and that round trip is
// where a graph editor actually breaks: a layer switch that loses the canvas, a
// v1 file that upgrades to a v2 file with no states in it, a mask whose
// checkboxes never reach the saved JSON. All of those produce a file that
// parses fine and animates nothing.
//
// So this opens a scratch project, edits a controller through the UI, saves,
// and reads the file back off disk.
//
//   npx vite --port 5202
//   node scripts/run-animator-ui-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
//
// START THE DEV SERVER FRESH — see the note in run-editor-ui-smoke.mjs about
// Vite's `?t=` module twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5202/";
const ROOT = path.join(os.tmpdir(), "animator-ui-smoke").replaceAll("\\", "/");
const ANIM = `${ROOT}/anim/Locomotion.anim`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const readAnim = () => JSON.parse(fs.readFileSync(ANIM, "utf8"));

/* -------------------------------------------------------------------------- */
/* scratch project — a deliberately VERSION 1 controller, so the load path      */
/* under test is the migration one                                              */
/* -------------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "anim"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "AnimUiSmoke", version: 1, lastScene: "scenes/Anim.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  ANIM,
  JSON.stringify(
    {
      version: 1,
      parameters: [
        { name: "speed", type: "number", default: 0 },
        { name: "jump", type: "trigger" },
      ],
      states: [
        { id: "idle", name: "Idle", clip: "Idle", speed: 1, loop: true, x: 240, y: 120 },
        { id: "move", name: "Move", clip: "Walk", speed: 1, loop: true, x: 460, y: 120 },
      ],
      startTransitions: [{ id: "st1", to: "idle", conditions: [] }],
      transitions: [
        { id: "t1", from: "idle", to: "move", duration: 0.2, exitTime: null, conditions: [{ param: "speed", op: ">", value: 0.1 }] },
      ],
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Anim.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Anim",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [],
    },
    null,
    2,
  ),
);

/* -------------------------------------------------------------------------- */

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });

const pageErrors = [];
// Stack, not just message: "Cannot read properties of null" names no file, and
// chasing one of those through a React tree without a frame is a bad afternoon.
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) pageErrors.push(m.text());
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(
  async ({ ROOT }) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(ROOT);
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(`${ROOT}/scenes/Anim.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(3500);

// Open the Animator on the controller by selecting it as an asset — the same
// path a double-click in the asset browser takes.
await page.evaluate(
  async ({ ANIM }) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().selectAsset(ANIM);
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("animator");
  },
  { ANIM },
);
await page.waitForSelector(".animator-panel", { timeout: 30000 });
await settle(1500);

/* -------------------------------------------------------------------------- */

const text = (selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));
const clickText = async (selector, needle) => {
  const ok = await page.evaluate(
    (sel, n) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(n));
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    needle,
  );
  await settle(250);
  return ok;
};
const save = async () => {
  await clickText(".animator-panel .panel-toolbar .toolbar-btn", "Save");
  await settle(600);
};

console.log("\nv1 → v2 migration");

const layerNames = await page.$$eval(".anim-layer-row .text-field", (els) => els.map((e) => e.value));
check("a v1 controller opens with one Base Layer", layerNames.length === 1 && layerNames[0] === "Base Layer", layerNames.join(", "));
const stateLabels = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("its states are on the canvas", stateLabels.includes("Idle") && stateLabels.includes("Move"), stateLabels.join(", "));

// Migration happens on the first SAVE, not on open — the Save button stays
// disabled until something is actually edited. Opening a v1 file to look at it
// must not rewrite it, or every controller in a project churns the moment
// someone browses the folder.
await save();
check("merely opening a v1 controller does not rewrite it", readAnim().version === 1, `version ${readAnim().version}`);

/* -------------------------------------------------------------------------- */

console.log("\nblend trees");

// Select the Move state and turn it into a 1D blend tree.
//
// A REAL mouse click, not a synthesized MouseEvent: React Flow selects through
// d3-drag, which reads `event.view.document` off the event it is handed and
// throws on a constructed one. (The throw is silent as far as selection goes —
// the node just never selects — so this is worth spelling out.)
const moveBox = await page.evaluate(() => {
  const node = [...document.querySelectorAll(".react-flow__node")].find((n) => n.textContent.includes("Move"));
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!moveBox) throw new Error("the Move node never rendered");
await page.mouse.click(moveBox.x, moveBox.y);
await settle(500);
const stateSectionOpen = await page.$(".animator-sidebar .inspector-section");
check("selecting a state opens its section", !!stateSectionOpen);

const setSelect = (label, value) =>
  page.evaluate(
    (l, v) => {
      const row = [...document.querySelectorAll(".animator-sidebar .field-row")].find(
        (r) => r.querySelector(".field-label")?.textContent.trim() === l,
      );
      const select = row?.querySelector("select");
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, v);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    label,
    value,
  );

check("the State section offers a Type switch", await setSelect("Type", "blend1d"));
await settle(400);
check("switching to a blend tree seeds it from the clip the state had", (await page.$$(".anim-tree-child")).length === 1);
check("...and offers a blend parameter", await setSelect("Parameter", "speed"));
await settle(300);
await clickText(".animator-sidebar .toolbar-btn", "Clip");
await settle(400);
check("a second clip can be added", (await page.$$(".anim-tree-child")).length === 2);

await save();
let saved = readAnim();
check("the first real save upgrades the file to version 2", saved.version === 2 && Array.isArray(saved.layers), `version ${saved.version}`);
check("...with the v1 states folded into a base layer", saved.layers?.[0]?.states?.length === 2, `${saved.layers?.[0]?.states?.length} states`);
check("...keeping its transition", saved.layers?.[0]?.transitions?.length === 1);
check("...and the parameters at the top level", saved.parameters?.length === 2);
const move = saved.layers[0].states.find((s) => s.name === "Move");
check("the saved state is a blend tree", move?.kind === "blend1d", move?.kind);
check("...bound to the parameter", move?.blendParam === "speed", move?.blendParam);
check("...with both children and distinct thresholds", move?.children?.length === 2 && move.children[0].threshold !== move.children[1].threshold, JSON.stringify(move?.children?.map((c) => c.threshold)));

/* -------------------------------------------------------------------------- */

console.log("\nlayers");

await clickText(".animator-sidebar .section-header", "Layers"); // no-op click; keeps focus in the sidebar
await page.evaluate(() => {
  const header = [...document.querySelectorAll(".animator-sidebar .section-header")].find((h) =>
    h.textContent.includes("Layers"),
  );
  header?.querySelector("button")?.click();
});
await settle(600);

const names2 = await page.$$eval(".anim-layer-row .text-field", (els) => els.map((e) => e.value));
check("adding a layer appends it below the base layer", names2.length === 2 && names2[0] === "Base Layer", names2.join(", "));
const activeIndex = await page.evaluate(() =>
  [...document.querySelectorAll(".anim-layer-row")].findIndex((r) => r.classList.contains("active")),
);
check("the new layer becomes the active one", activeIndex === 1, `index ${activeIndex}`);
const emptyCanvas = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("...and the canvas shows ITS states, not the base layer's", emptyCanvas.length === 0, emptyCanvas.join(", "));

// Add a state to the new layer, then switch back and forth.
await clickText(".animator-panel .panel-toolbar .toolbar-btn", "State");
await settle(500);
const upperStates = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("a state can be added to the upper layer", upperStates.length === 1, upperStates.join(", "));

await page.evaluate(() => document.querySelectorAll(".anim-layer-row")[0]?.click());
await settle(600);
const backToBase = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("switching back restores the base layer's canvas", backToBase.includes("Idle") && backToBase.includes("Move"), backToBase.join(", "));

await page.evaluate(() => document.querySelectorAll(".anim-layer-row")[1]?.click());
await settle(600);
const backToUpper = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("...and the upper layer's edits survived the round trip", backToUpper.length === 1, backToUpper.join(", "));

// Blend mode + weight live on the non-base layer only.
await page.evaluate(() => {
  const row = document.querySelectorAll(".anim-layer-row")[1];
  const select = row?.querySelector(".anim-layer-controls select");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  setter.call(select, "additive");
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await settle(300);
check(
  "the base layer has no weight/blend controls",
  (await page.$$(".anim-layer-row")).length === 2 &&
    (await page.$$eval(".anim-layer-row", (rows) => !rows[0].querySelector(".anim-layer-controls"))),
);

// The mask editor opens off the layer row. With no rigged model in the scene
// it must say so rather than render an empty checklist that looks like a rig
// with no bones.
await page.evaluate(() => {
  const row = document.querySelectorAll(".anim-layer-row")[1];
  [...row.querySelectorAll(".anim-layer-controls .toolbar-btn")]
    .find((b) => b.textContent.trim().startsWith("Mask"))
    ?.click();
});
await settle(400);
const maskOpen = await page.$(".anim-mask-editor");
check("the Mask button opens the avatar-mask editor", !!maskOpen);
const maskBody = await page.$eval(".anim-mask-editor", (el) => el.textContent);
check(
  "...and explains itself when there's no skeleton to list",
  /No skeleton in the scene/.test(maskBody),
  maskBody.slice(0, 60),
);
await page.evaluate(() => document.querySelector(".anim-mask-editor .section-header button")?.click());
await settle(300);
check("...and closes again", !(await page.$(".anim-mask-editor")));

await save();
saved = readAnim();
check("both layers are saved", saved.layers?.length === 2, `${saved.layers?.length} layers`);
check("the upper layer kept its blend mode", saved.layers?.[1]?.blend === "additive", saved.layers?.[1]?.blend);
check("the base layer still has its states", saved.layers?.[0]?.states?.length === 2);
check("the upper layer has its own state", saved.layers?.[1]?.states?.length === 1);

/* -------------------------------------------------------------------------- */

console.log("\nreload");

// Re-open the panel from scratch: the strongest statement about the file is
// that the editor itself can read back what it just wrote.
await page.evaluate(async () => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().selectAsset("");
});
await settle(500);
await page.evaluate(
  async ({ ANIM }) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().selectAsset(ANIM);
  },
  { ANIM },
);
await settle(1500);

const reloaded = await page.$$eval(".anim-layer-row .text-field", (els) => els.map((e) => e.value));
check("a saved v2 controller reopens with both layers", reloaded.length === 2, reloaded.join(", "));
const reloadedStates = await text(".animator-panel .shader-node.cat-anim .shader-node-label");
check("...showing the base layer's states", reloadedStates.includes("Idle") && reloadedStates.includes("Move"), reloadedStates.join(", "));

/* -------------------------------------------------------------------------- */

console.log("\nruntime agreement");

// The last question: does the RUNTIME accept the file the panel wrote? Building
// an AnimatorRuntime over it is what a Play press would do.
const runtimeReport = await page.evaluate(
  async ({ ANIM }) => {
    const { AnimatorRuntime, normalizeGraph } = await globalThis.__importLive("/src/engine/animGraph.js");
    const raw = JSON.parse(await window.__TAURI_INTERNALS__.invoke("read_text_file", { path: ANIM }));
    const graph = normalizeGraph(raw);
    return {
      layers: graph.layers.length,
      kinds: graph.layers[0].states.map((s) => s.kind),
      blendParam: graph.layers[0].states.find((s) => s.name === "Move")?.blendParam ?? null,
      hasRuntime: typeof AnimatorRuntime === "function",
    };
  },
  { ANIM },
);
check("the runtime's own loader accepts the saved file", runtimeReport.layers === 2 && runtimeReport.hasRuntime, JSON.stringify(runtimeReport));
check("...and sees the blend tree the panel authored", runtimeReport.kinds.includes("blend1d") && runtimeReport.blendParam === "speed", JSON.stringify(runtimeReport.kinds));

/* -------------------------------------------------------------------------- */

const realErrors = pageErrors.filter((e) => !/ResizeObserver|WebGPU|GPUAdapter|Unknown component/i.test(e));
check("no uncaught errors while driving the panel", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
