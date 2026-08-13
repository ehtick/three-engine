// Editor UI/UX polish smoke test (2026-07-27 pass). Covers the things that
// only exist once React has rendered against real DOM and real layout has run:
//
//   1. Asset dropdowns are portalled — opening one must not grow the
//      inspector's horizontal scroll extent (the "opening a dropdown pushes
//      the page sideways" bug) and must stay inside the window.
//   2. Component header buttons travel as one right-aligned cluster.
//   3. Clicking a filled asset slot reveals that file in the Assets panel.
//   4. The Scripts component can create + attach a script without leaving it.
//   5. The 3D-cursor HUD is a compact chip, not a wide pill.
//   6. Editing the Default material forks it to a real .mat WITHOUT remounting
//      the graph — the edit that triggered the fork survives.
//
//   npx vite --port 5201
//   node scripts/run-editor-polish-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH — see the note in run-editor-ui-smoke.mjs about
// Vite's `?t=` rewriting duplicating the Engine singleton.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";

// --- a throwaway project on disk the shim is allowed to write to ------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-polish-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Polish", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "materials"), { recursive: true });
fs.writeFileSync(
  path.join(root, "materials", "RockCliff.mat"),
  JSON.stringify({ color: "#cc8844", roughness: 0.8, metalness: 0 }, null, 2),
);
const matPath = path.join(root, "materials", "RockCliff.mat").replaceAll("\\", "/");

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
// A reload mid-run destroys the execution context and every pending evaluate
// fails with an opaque "Promise was collected" — log it so the cause is visible.
page.on("framenavigated", (f) => {
  if (f === page.mainFrame() && process.env.VERBOSE) console.log(`  [nav] ${f.url()}`);
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const step = (name) => process.env.VERBOSE && console.log(`  [step] ${name}`);

step("goto");
await page.goto(url, { waitUntil: "load", timeout: 45000 });
step("skip hub");
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);
step("setup");

// --- open the scratch project + a mesh to inspect ---------------------------

// Opening the project is kicked off WITHOUT awaiting it from Node. It resets
// the editor scene and scaffolds typings, and a page promise that long-lived
// gets collected out from under puppeteer ("Promise was collected") — the
// harness polls the store instead.
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

const setup = await page.evaluate(async () => {
  const importLive = globalThis.__importLive;
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await importLive("/src/editor/commands/entityCommands.js");

  const create = new CreateEntityCommand({
    name: "PolishMesh",
    components: [{ type: "mesh", props: { geometry: "box" } }],
  });
  commandBus.execute(create);
  useSceneStore.getState().refresh();
  useSelectionStore.getState().select(create.entityId);
  globalThis.__polishId = create.entityId;
  return {
    id: String(create.entityId),
    wired: !!globalThis.__engine.getEntity(create.entityId)?.getComponent("mesh"),
    rootPath: useProjectStore.getState().rootPath,
  };
});

if (!setup.wired) {
  console.log("POLISH-SMOKE FAIL — engine module duplicated; restart `npx vite` and re-run");
  await browser.close();
  process.exit(1);
}
await wait(1200);

// --- 2. component header buttons are one right-aligned cluster --------------

const header = await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((s) =>
    s.querySelector(".section-title")?.textContent?.trim().toLowerCase().includes("mesh"),
  );
  if (!section) return null;
  const head = section.querySelector(".section-header");
  const actions = head?.querySelector(".section-actions");
  if (!actions) return { grouped: false };
  const headBox = head.getBoundingClientRect();
  const box = actions.getBoundingClientRect();
  const buttons = [...actions.querySelectorAll("button")];
  return {
    grouped: true,
    buttons: buttons.length,
    // Distance from the cluster's right edge to the header's right edge.
    rightGap: headBox.right - box.right,
    clusterWidth: box.width,
    headerWidth: headBox.width,
  };
});
check(
  "component header buttons are grouped, not spread across the header",
  !!header?.grouped && header.buttons === 3 && header.clusterWidth < header.headerWidth * 0.45,
  header ? `${header.buttons} buttons, cluster ${Math.round(header.clusterWidth)}px of ${Math.round(header.headerWidth)}px` : "no mesh section",
);
check(
  "the cluster sits in the header's top-right corner",
  !!header?.grouped && header.rightGap <= 2,
  header?.grouped ? `${Math.round(header.rightGap)}px from the right edge` : "",
);

// --- 1. the asset picker is portalled and doesn't shove the layout ----------

const before = await page.evaluate(() => {
  const panel = document.querySelector(".inspector-panel");
  return { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, scrollLeft: panel.scrollLeft };
});

await page.evaluate(() => {
  const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
    (r) => r.querySelector(".settings-label")?.textContent?.trim() === "Material",
  );
  row?.querySelector(".asset-field")?.click();
});
await wait(700);

const opened = await page.evaluate(() => {
  const panel = document.querySelector(".inspector-panel");
  const menu = document.querySelector(".dropdown-menu.asset-options");
  const box = menu?.getBoundingClientRect();
  return {
    hasMenu: !!menu,
    inBody: menu?.parentElement === document.body || menu?.closest(".inspector-panel") === null,
    scrollWidth: panel.scrollWidth,
    clientWidth: panel.clientWidth,
    menu: box && { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
  };
});

check("the asset picker opens", opened.hasMenu);
check("the picker renders outside the scrolling panel", opened.hasMenu && opened.inBody);
check(
  "opening it does not grow the inspector's horizontal scroll extent",
  opened.scrollWidth <= opened.clientWidth + 1 && opened.scrollWidth <= before.scrollWidth + 1,
  `panel scrollWidth ${before.scrollWidth} -> ${opened.scrollWidth}, client ${opened.clientWidth}`,
);
check(
  "opening it does not push the document sideways",
  opened.docScrollWidth <= opened.docClientWidth + 1,
  `doc ${opened.docScrollWidth} vs ${opened.docClientWidth}`,
);
check(
  "the menu stays inside the window",
  !!opened.menu && opened.menu.left >= 0 && opened.menu.right <= 1600 && opened.menu.bottom <= 1000,
  opened.menu
    ? `l${Math.round(opened.menu.left)} r${Math.round(opened.menu.right)} b${Math.round(opened.menu.bottom)}`
    : "",
);

// Close it again.
await page.evaluate(() => document.querySelector(".dropdown-overlay")?.dispatchEvent(
  new PointerEvent("pointerdown", { bubbles: true }),
));
await wait(300);

// --- 3. clicking a filled slot reveals the asset in the Assets panel --------

await page.evaluate(async (mat) => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { SetComponentPropCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  commandBus.execute(new SetComponentPropCommand(globalThis.__polishId, "mesh", "material", mat));
}, matPath);
await wait(900);

await page.evaluate(() => {
  const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
    (r) => r.querySelector(".settings-label")?.textContent?.trim() === "Material",
  );
  row?.querySelector(".asset-field")?.click();
});
await wait(1400);

const revealed = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  const tiles = [...document.querySelectorAll(".asset-tile, .asset-row")];
  return {
    currentPath: useProjectStore.getState().currentPath,
    revealedNames: tiles
      .filter((t) => t.classList.contains("revealed"))
      .map((t) => t.getAttribute("data-asset-path")?.split(/[\\/]/).pop()),
    // The entity must still be the selection — revealing is not selecting.
    entityStillSelected: useSelectionStore.getState().ids.length === 1,
  };
});
check(
  "clicking a filled material slot browses to its folder",
  /materials$/i.test(revealed.currentPath ?? ""),
  revealed.currentPath ?? "",
);
check(
  "the referenced asset is highlighted in the Assets panel",
  revealed.revealedNames.length === 1 && revealed.revealedNames[0] === "RockCliff.mat",
  JSON.stringify(revealed.revealedNames),
);
check("revealing does not steal the entity selection", revealed.entityStillSelected);

await page.evaluate(() => document.querySelector(".dropdown-overlay")?.dispatchEvent(
  new PointerEvent("pointerdown", { bubbles: true }),
));
await wait(300);

// --- 4. create + attach a script from the Scripts component -----------------

await page.evaluate(async () => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { AddComponentCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  commandBus.execute(new AddComponentCommand(globalThis.__polishId, "script"));
});
await wait(800);

await page.evaluate(() => {
  [...document.querySelectorAll(".inspector-panel button")]
    .find((b) => b.textContent?.trim() === "Add Script" || b.textContent?.includes("Add Script"))
    ?.click();
});
await wait(500);

const slotButtons = await page.evaluate(() => {
  const slot = document.querySelector(".inspector-panel .script-slot");
  return {
    hasSlot: !!slot,
    hasNewButton: !!slot?.querySelector('button[title*="new script" i]'),
    hasAddRowNew: [...document.querySelectorAll(".script-add-row button")].some(
      (b) => b.textContent?.trim() === "New",
    ),
  };
});
check("a script slot offers an inline create button", slotButtons.hasSlot && slotButtons.hasNewButton);
check("the add row offers a one-click New script", slotButtons.hasAddRowNew);

await page.evaluate(() => {
  document.querySelector('.inspector-panel .script-slot button[title*="new script" i]')?.click();
});
await wait(300);
await page.type(".script-name-input", "Spinner");
await page.keyboard.press("Enter");
await wait(1600);

const created = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const slots = engine.getEntity(globalThis.__polishId)?.getComponent("script")?.props?.scripts ?? [];
  return slots.map((s) => s.path);
});
const onDisk = fs.existsSync(path.join(root, "scripts", "Spinner.ts"));
check("the new script is written to scripts/", onDisk, path.join(root, "scripts", "Spinner.ts"));
check(
  "the new script is attached to the slot it was created from",
  created.some((p) => /Spinner\.ts$/i.test(p ?? "")),
  JSON.stringify(created),
);
if (onDisk) {
  const source = fs.readFileSync(path.join(root, "scripts", "Spinner.ts"), "utf8");
  check("its class name follows the filename", /class Spinner extends Script/.test(source));
}

// A script slot is a file field plus six actions. Narrow the panel to the width
// a docked inspector actually gets and the name must still be readable — it used
// to ellipsize down to "B..", which makes two slots indistinguishable.
const narrow = await page.evaluate(async () => {
  const panel = document.querySelector(".inspector-panel");
  const previous = panel.style.width;
  panel.style.width = "300px";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const name = panel.querySelector(".script-slot .asset-field-name");
  const field = panel.querySelector(".script-slot .asset-field-wrap");
  const actions = panel.querySelector(".script-slot .script-slot-actions");
  const out = {
    text: name?.textContent ?? "",
    fieldWidth: Math.round(field?.getBoundingClientRect().width ?? 0),
    clipped: (name?.scrollWidth ?? 0) > (name?.clientWidth ?? 0) + 1,
    // When they no longer fit beside the field the actions drop to their own
    // line rather than squeezing it.
    actionsWrapped:
      !!actions && !!field &&
      actions.getBoundingClientRect().top > field.getBoundingClientRect().bottom - 2,
  };
  panel.style.width = previous;
  await new Promise((r) => requestAnimationFrame(r));
  return out;
});
check(
  "a script slot keeps its filename readable in a narrow inspector",
  narrow.fieldWidth >= 160 && !narrow.clipped,
  `"${narrow.text}" in ${narrow.fieldWidth}px${narrow.clipped ? " (clipped)" : ""}`,
);
check("…by wrapping the action buttons instead of squeezing the name", narrow.actionsWrapped);

// --- 4b. the Asset Inspector scrolls past its embedded code editor ----------
//
// Monaco consumes the wheel by default. Embedded in a scrolling column that
// meant the pointer was always over the editor, every tick went into the code,
// and whatever sat below the tile could not be reached at all.
await page.evaluate(async (file) => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().selectAssets([file]);
}, path.join(root, "scripts", "Spinner.ts").replaceAll("\\", "/"));
await wait(3000);

const codeScroll = await page.evaluate(async () => {
  const panel = document.querySelector(".inspector-panel");
  const host = panel?.querySelector(".asset-code .code-editor-host");
  if (!panel || !host) return { mounted: false };
  panel.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 200));
  const r = host.getBoundingClientRect();
  return {
    mounted: true,
    maxScroll: panel.scrollHeight - panel.clientHeight,
    point: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
  };
});
if (!codeScroll.mounted) {
  check("the Asset Inspector embeds a code editor for a script", false);
} else if (codeScroll.maxScroll < 40) {
  check("the Asset Inspector embeds a code editor for a script", true, "panel too short to scroll — skipped");
} else {
  await page.mouse.move(codeScroll.point.x, codeScroll.point.y);
  for (let i = 0; i < 40; i++) await page.mouse.wheel({ deltaY: 220 });
  await wait(600);
  const scrolled = await page.evaluate(() => {
    const panel = document.querySelector(".inspector-panel");
    return {
      top: Math.round(panel.scrollTop),
      max: panel.scrollHeight - panel.clientHeight,
    };
  });
  check(
    "the wheel over the embedded code editor still scrolls the inspector",
    scrolled.top >= scrolled.max - 4,
    `${scrolled.top}/${scrolled.max}px`,
  );
}

// Selecting an asset swaps the Inspector over to the Asset Inspector. Every
// check below this point reads the ENTITY inspector, so put the selection back
// before moving on.
await page.evaluate(async (id) => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().select([id]);
}, await page.evaluate(() => globalThis.__polishId));
await wait(1200);

// --- 5. the 3D cursor HUD is a compact chip ---------------------------------

const hud = await page.evaluate(() => {
  const el = document.querySelector(".cursor-hud");
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { width: box.width, height: box.height, text: el.textContent.trim() };
});
check(
  "the 3D cursor HUD is a compact chip",
  !!hud && hud.height <= 26 && hud.width <= 190,
  hud ? `${Math.round(hud.width)}x${Math.round(hud.height)} "${hud.text}"` : "not rendered",
);

// --- 6. right-click menus replace the browser's ------------------------------

step("context menus");

/**
 * Fires a real contextmenu on `selector` and reports whether it was swallowed.
 * `selector` may be prefixed with `row:<Label>|` to scope it to the inspector
 * field-row carrying that label — the inspector has many `.asset-field`s and
 * `querySelector` would otherwise hit whichever comes first.
 */
const rightClick = (selector, offset = { x: 8, y: 8 }) =>
  page.evaluate(
    (sel, off) => {
      let scope = document;
      if (sel.startsWith("row:")) {
        const [, label, rest] = sel.match(/^row:([^|]+)\|(.*)$/);
        scope = [...document.querySelectorAll(".inspector-panel .field-row")].find(
          (r) => r.querySelector(".settings-label")?.textContent?.trim() === label,
        );
        sel = rest;
        if (!scope) return { found: false };
      }
      const el = scope.querySelector(sel);
      if (!el) return { found: false };
      const box = el.getBoundingClientRect();
      const x = Math.round(box.left + off.x);
      const y = Math.round(box.top + off.y);
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
      el.dispatchEvent(event);
      return { found: true, prevented: event.defaultPrevented };
    },
    selector,
    offset,
  );

const menuLabels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".dropdown-menu.context-menu .dropdown-item")].map((b) =>
      b.textContent.trim(),
    ),
  );

const dismissMenu = async () => {
  await page.keyboard.press("Escape");
  await wait(200);
};

// Clear the highlight left by the earlier click-reveal, so the menu action
// below is proved to have done the revealing itself.
await page.evaluate(async () => {
  const { useAssetRevealStore } = await globalThis.__importLive("/src/editor/assetReveal.js");
  useAssetRevealStore.getState().clear();
});

// (a) an asset slot in the component panel
const matField = await rightClick("row:Material|.asset-field");
await wait(300);
const matMenu = await menuLabels();
check(
  "right-clicking an asset slot swallows the browser menu",
  matField.found && matField.prevented,
  JSON.stringify(matField),
);
check(
  "the asset slot menu can show the asset in the Assets panel",
  matMenu.some((l) => /Show in Assets Panel/i.test(l)),
  JSON.stringify(matMenu),
);

// Use it: the whole point is reaching the file without the picker covering it.
await page.evaluate(() => {
  [...document.querySelectorAll(".dropdown-menu.context-menu .dropdown-item")]
    .find((b) => /Show in Assets Panel/i.test(b.textContent))
    ?.click();
});
await wait(1500);
const shown = await page.evaluate(() => ({
  pickerOpen: !!document.querySelector(".dropdown-menu.asset-options"),
  revealed: [...document.querySelectorAll(".asset-tile.revealed, .asset-row.revealed")].map((t) =>
    t.getAttribute("data-asset-path")?.split(/[\\/]/).pop(),
  ),
}));
check(
  "…and does so without opening the picker over it",
  !shown.pickerOpen && shown.revealed.includes("RockCliff.mat"),
  JSON.stringify(shown),
);

// (b) a component section — scoped to the Mesh one, since the entity header
// and Transform are also `.inspector-section`s with their own menus.
const sectionHit = await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((s) =>
    /mesh/i.test(s.querySelector(".section-title")?.textContent ?? ""),
  );
  const header = section?.querySelector(".section-header");
  if (!header) return { found: false };
  const box = header.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: Math.round(box.left + 8),
    clientY: Math.round(box.top + 8),
  });
  header.dispatchEvent(event);
  return { found: true, prevented: event.defaultPrevented };
});
await wait(300);
const sectionMenu = await menuLabels();
check(
  "right-clicking a component offers component actions",
  sectionHit.prevented &&
    sectionMenu.some((l) => /Remove Component/i.test(l)) &&
    sectionMenu.some((l) => /Copy Component Values/i.test(l)),
  JSON.stringify(sectionMenu),
);
await dismissMenu();

// (b2) the Transform section
const transformHit = await rightClick(".inspector-panel .inspector-section .section-header", { x: 8, y: 8 });
await wait(300);
const transformMenu = await menuLabels();
check(
  "right-clicking Transform offers reset / copy transform",
  transformHit.prevented &&
    transformMenu.some((l) => /Reset Transform/i.test(l)) &&
    transformMenu.some((l) => /Copy Transform/i.test(l)),
  JSON.stringify(transformMenu),
);
await dismissMenu();

// (c) a text field gets edit commands, not the panel's menu
const inputHit = await rightClick(".inspector-panel input[type='text'], .inspector-panel .number-field");
await wait(300);
const inputMenu = await menuLabels();
check(
  "right-clicking a text field offers edit commands",
  inputHit.prevented &&
    inputMenu.some((l) => /^Paste/.test(l)) &&
    inputMenu.some((l) => /Select All/i.test(l)),
  JSON.stringify(inputMenu),
);
await dismissMenu();

// (d) anywhere else still never shows the browser menu
const genericHit = await rightClick(".panel-toolbar", { x: 4, y: 4 });
await wait(300);
const genericMenu = await menuLabels();
check(
  "right-clicking chrome falls back to a generic editor menu",
  genericHit.prevented && genericMenu.some((l) => /Undo/.test(l)),
  JSON.stringify(genericMenu),
);
await dismissMenu();

// (e) a menu opened hard against the bottom-right corner stays on screen
const clamped = await page.evaluate(() => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: window.innerWidth - 4,
    clientY: window.innerHeight - 4,
  });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
});
await wait(300);
const clampBox = await page.evaluate(() => {
  const menu = document.querySelector(".dropdown-menu.context-menu");
  if (!menu) return null;
  const box = menu.getBoundingClientRect();
  return { right: box.right, bottom: box.bottom, w: window.innerWidth, h: window.innerHeight };
});
check(
  "a menu opened at the screen corner is clamped into view",
  clamped && !!clampBox && clampBox.right <= clampBox.w && clampBox.bottom <= clampBox.h,
  clampBox ? `r${Math.round(clampBox.right)}/${clampBox.w} b${Math.round(clampBox.bottom)}/${clampBox.h}` : "no menu",
);
await dismissMenu();

// --- 7. editing the Default material forks it without remounting the graph --

const forkSetup = await page.evaluate(async () => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { SetComponentPropCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  // Back to the Default material so the fork path is the one under test.
  commandBus.execute(new SetComponentPropCommand(globalThis.__polishId, "mesh", "material", ""));
  openPanel("shaderGraph");
  return true;
});
await wait(4000);

const graphReady = await page.evaluate(() => {
  const canvas = document.querySelector(".shader-graph-canvas");
  if (canvas) canvas.dataset.polishMark = "kept"; // survives re-render, not remount
  const inputs = [...document.querySelectorAll(".shader-node .gf-number-input")];
  return {
    mounted: !!canvas,
    label: document.querySelector(".shader-graph-panel .asset-path")?.textContent?.trim(),
    numberInputs: inputs.length,
  };
});

if (!graphReady.mounted || !graphReady.numberInputs) {
  check("the Shader Graph opens on the Default material", false, JSON.stringify(graphReady));
} else {
  check(
    "the Shader Graph opens on the Default material",
    graphReady.label === "Default",
    graphReady.label ?? "",
  );

  // One edit: type a new value into the first inline number field. It has to go
  // through a real focus + keypress — the field only commits on Enter/blur, so
  // poking `.value` from script would leave the graph untouched and the fork
  // would never be triggered.
  await page.click(".shader-node .gf-number-input");
  // Replace, don't append: the field commits with parseFloat, so leaving the
  // old text in place makes "0.50.375" parse back to the old value.
  await page.evaluate(() => document.querySelector(".shader-node .gf-number-input")?.select());
  await page.keyboard.type("0.375");
  await page.keyboard.press("Enter");
  // 600ms autosave debounce + the fork write + the project refresh.
  await wait(4000);

  const afterFork = await page.evaluate(() => {
    const canvas = document.querySelector(".shader-graph-canvas");
    const input = document.querySelector(".shader-node .gf-number-input");
    return {
      material: globalThis.__engine.getEntity(globalThis.__polishId)?.getComponent("mesh")?.props?.material ?? "",
      sameCanvas: canvas?.dataset.polishMark === "kept",
      label: document.querySelector(".shader-graph-panel .asset-path")?.textContent?.trim(),
      value: input?.value,
    };
  });

  check(
    "the first edit forks the Default material into a real .mat",
    /\.mat$/i.test(afterFork.material),
    afterFork.material || "(still Default)",
  );
  check(
    "the graph is NOT remounted by the fork",
    afterFork.sameCanvas,
    afterFork.sameCanvas ? "same DOM node" : "canvas was recreated",
  );
  check(
    "the edit that triggered the fork survives it",
    afterFork.value === "0.375",
    `field reads "${afterFork.value}"`,
  );
  check(
    "the toolbar switches to the new material",
    !!afterFork.label && afterFork.label !== "Default" && /\.mat$/i.test(afterFork.label),
    afterFork.label ?? "",
  );

  // --- 8. node-graph right-click menus ---------------------------------------

  const nodeHit = await rightClick(".shader-node .shader-node-header", { x: 20, y: 6 });
  await wait(300);
  const nodeMenu = await menuLabels();
  check(
    "right-clicking a graph node offers node actions",
    nodeHit.prevented &&
      nodeMenu.some((l) => /Duplicate/i.test(l)) &&
      nodeMenu.some((l) => /^Delete/.test(l)),
    JSON.stringify(nodeMenu),
  );
  await dismissMenu();

  // The pane keeps its own menu (the node palette), not the generic fallback.
  const paneHit = await rightClick(".shader-graph-canvas .react-flow__pane", { x: 40, y: 40 });
  await wait(400);
  const paneMenu = await page.evaluate(() => ({
    palette: !!document.querySelector(".node-palette"),
    generic: [...document.querySelectorAll(".dropdown-menu.context-menu .dropdown-item")].map((b) =>
      b.textContent.trim(),
    ),
  }));
  check(
    "right-clicking the graph canvas still opens the node palette",
    paneHit.prevented && paneMenu.palette && !paneMenu.generic.some((l) => /Reset Panel Layout/.test(l)),
    JSON.stringify(paneMenu),
  );
  await dismissMenu();

  const forkFile = afterFork.material.replaceAll("/", path.sep);
  if (fs.existsSync(forkFile)) {
    const def = JSON.parse(fs.readFileSync(forkFile, "utf8"));
    if (process.env.VERBOSE) {
      console.log("  [debug] saved node props:", JSON.stringify(def.shaderGraph?.nodes?.map((n) => n.props)));
    }
    check("the forked .mat carries the edited graph", !!def.shaderGraph?.nodes?.length);
  } else {
    check("the forked .mat exists on disk", false, afterFork.material);
  }
}

// --- 9. the unfocused-viewport pause lives in Project Settings ---------------

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("projectSettings");
});
await wait(1500);

const freezeRow = await page.evaluate(async () => {
  const { isViewportFreezeEnabled } = await globalThis.__importLive("/src/editor/viewportFreeze.js");
  const row = [...document.querySelectorAll(".project-settings-panel .settings-row")].find(
    (r) => /freeze/i.test(r.querySelector(".settings-label")?.textContent ?? ""),
  );
  const box = row?.querySelector('input[type="checkbox"]');
  return {
    found: !!box,
    label: row?.querySelector(".settings-label")?.textContent?.trim() ?? "",
    checkedOnOpen: box?.checked ?? null,
    prefOnOpen: isViewportFreezeEnabled(),
    // The old home: a snowflake button in the viewport toolbar.
    snowflakes: document.querySelectorAll(".viewport-panel .toolbar-btn .lucide-snowflake").length,
  };
});
check("Project Settings carries the freeze-unfocused row", freezeRow.found, freezeRow.label);
check(
  "…checked by default — pausing an unwatched viewport is the default now",
  freezeRow.checkedOnOpen === true && freezeRow.prefOnOpen === true,
  JSON.stringify(freezeRow),
);
check("…and it is gone from the viewport toolbar", freezeRow.snowflakes === 0, `${freezeRow.snowflakes} snowflake buttons`);

const freezeToggled = await page.evaluate(async () => {
  const { isViewportFreezeEnabled, setViewportFreezeEnabled } = await globalThis.__importLive(
    "/src/editor/viewportFreeze.js",
  );
  const box = [...document.querySelectorAll(".project-settings-panel .settings-row")]
    .find((r) => /freeze/i.test(r.querySelector(".settings-label")?.textContent ?? ""))
    ?.querySelector('input[type="checkbox"]');
  box?.click();
  const afterClick = { pref: isViewportFreezeEnabled(), stored: localStorage.getItem("engine.viewport.freezeWhenUnfocused") };
  // Changing it from elsewhere has to reach the checkbox too — it is a shared
  // preference, not this panel's private state.
  setViewportFreezeEnabled(true);
  return { afterClick, boxAfterExternalSet: box?.checked };
});
await wait(200);
check(
  "unticking it applies immediately and persists",
  freezeToggled.afterClick.pref === false && freezeToggled.afterClick.stored === "0",
  JSON.stringify(freezeToggled.afterClick),
);
check(
  "the checkbox follows the preference when something else changes it",
  (await page.evaluate(
    () =>
      [...document.querySelectorAll(".project-settings-panel .settings-row")]
        .find((r) => /freeze/i.test(r.querySelector(".settings-label")?.textContent ?? ""))
        ?.querySelector('input[type="checkbox"]')?.checked === true,
  )),
);

// --- 10. hot reload is a Project Settings switch -----------------------------
//
// Watching the project folder used to be unconditional, which is wrong on a
// network share and wrong when a build step churns thousands of files under the
// root. The switch is only worth anything if flipping it actually stops the
// watcher, so the check follows it all the way down to `watchedProjectRoot()`
// rather than stopping at "the checkbox went grey".

const hotReload = await page.evaluate(async () => {
  const rowFor = (re) =>
    [...document.querySelectorAll(".project-settings-panel .settings-row")].find((r) =>
      re.test(r.querySelector(".settings-label")?.textContent ?? ""),
    );
  const watchRow = rowFor(/watch project files/i);
  const scriptRow = rowFor(/reload scripts/i);
  const pollRow = rowFor(/poll interval/i);
  const { getProjectSettings } = await globalThis.__importLive("/src/editor/projectSettings.js");
  return {
    hasWatch: !!watchRow?.querySelector('input[type="checkbox"]'),
    hasScripts: !!scriptRow?.querySelector('input[type="checkbox"]'),
    hasPoll: !!pollRow?.querySelector('input[type="number"]'),
    watchDefault: getProjectSettings().editor.watchProject !== false,
  };
});
check(
  "Project Settings has a Hot Reload group with all three controls",
  hotReload.hasWatch && hotReload.hasScripts && hotReload.hasPoll,
  JSON.stringify(hotReload),
);
check("…and watching the project folder is on by default", hotReload.watchDefault === true);

// The watcher itself is a Tauri process — a browser harness can never start it,
// so "watchedProjectRoot() is null" would pass here no matter what the switch
// did. What IS testable in a browser is the gate the switch feeds: the store
// flag, and the status an agent reads before deciding whether it must call
// asset.refresh by hand.
const watchOff = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const { callOp } = await globalThis.__importLive("/src/editor/api/registry.js");
  const meta = useProjectStore.getState().projectMeta ?? {};
  const settings = meta.settings ?? {};
  const withFlag = async (watchProject) => {
    useProjectStore.setState({
      projectMeta: {
        ...meta,
        settings: { ...settings, editor: { ...(settings.editor ?? {}), watchProject } },
      },
    });
    return (await callOp("asset.watchStatus", {})).enabled;
  };
  const off = await withFlag(false);
  const on = await withFlag(true);
  useProjectStore.setState({ projectMeta: meta });
  return { off, on };
});
check(
  "asset.watchStatus reports the switch, so an agent knows to refresh by hand",
  watchOff.off === false && watchOff.on === true,
  JSON.stringify(watchOff),
);

// Flipping the checkbox has to arm Save — an unsaved preference that looks
// applied is worse than no switch at all.
const watchDirty = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".project-settings-panel .settings-row")].find((r) =>
    /watch project files/i.test(r.querySelector(".settings-label")?.textContent ?? ""),
  );
  const box = row?.querySelector('input[type="checkbox"]');
  const before = box?.checked;
  box?.click();
  return { before, after: box?.checked };
});
await wait(150);
check(
  "flipping it ticks through and arms Save",
  watchDirty.before === true &&
    watchDirty.after === false &&
    (await page.evaluate(
      () =>
        ![...document.querySelectorAll(".project-settings-panel .panel-toolbar .toolbar-btn")].some(
          (b) => /save/i.test(b.textContent ?? "") && b.disabled,
        ),
    )),
  JSON.stringify(watchDirty),
);

// --- 11. Scene Settings speaks the same layout language ----------------------
//
// Both settings panels share settingsUi.jsx. The risk of that sharing is silent
// drift: a section renamed or a row that stops rendering shows up as an empty
// panel, and nothing else in the suite opens this one.

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("sceneSettings");
});
await wait(1200);

const scene = await page.evaluate(() => {
  const panel = document.querySelector(".scene-settings-panel.settings-panel");
  if (!panel) return { found: false };
  const labelsIn = (title) => {
    const section = [...panel.querySelectorAll(".settings-section")].find(
      (s) => s.querySelector(".section-header")?.textContent.trim() === title,
    );
    return [...(section?.querySelectorAll(".settings-label") ?? [])].map(
      (n) => n.textContent.trim(),
    );
  };
  return {
    found: true,
    sections: [...panel.querySelectorAll(".settings-section .section-header")].map((h) =>
      h.textContent.trim(),
    ),
    rendering: labelsIn("Rendering"),
    // Collapsed by default: it rebuilds the renderer, so it is not a knob you
    // want under the cursor while tuning fog.
    rendererClosed: ![...panel.querySelectorAll(".settings-section")].some(
      (s) =>
        s.querySelector(".section-header")?.textContent.trim() === "Renderer" &&
        s.classList.contains("open"),
    ),
    prose: [...panel.querySelectorAll(".settings-note")].map((n) => n.textContent.trim().length),
  };
});
check(
  "Scene Settings renders in the shared settings layout",
  scene.found && ["Environment", "Fog", "Rendering", "Performance", "Renderer"].every((s) => scene.sections?.includes(s)),
  JSON.stringify(scene.sections),
);
check(
  "…with the shadow knobs folded under the switch that gates them",
  ["Shadows", "Map type", "Auto update", "Force update"].every((l) => scene.rendering?.includes(l)),
  JSON.stringify(scene.rendering),
);
check("…and the renderer rebuild section collapsed by default", scene.rendererClosed === true);
// The panel used to carry four explanatory paragraphs. They are tooltips now,
// and a regression here is someone quietly putting the walls of text back.
check(
  "…and no wall of text left in it",
  (scene.prose ?? []).every((n) => n <= 120),
  JSON.stringify(scene.prose),
);

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const realErrors = errors.filter((e) => {
  if (/WebGPU|GPUAdapter|Deprecation/i.test(e)) return false;
  if (/favicon/i.test(e)) return false;
  if (/Failed to load resource/i.test(e)) return false;
  return true;
});
if (realErrors.length) {
  console.log("\nConsole errors:");
  for (const e of realErrors.slice(0, 12)) console.log(`  ${e}`);
}
console.log(
  `\nPOLISH-SMOKE ${failed.length || realErrors.length ? "FAIL" : "PASS"} — ` +
    `${results.length - failed.length}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length || realErrors.length ? 1 : 0);
