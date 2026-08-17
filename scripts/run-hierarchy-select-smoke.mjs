// Hierarchy multi-selection smoke test.
//
// The scenario this exists for: search a scene down to hundreds of meshes, then
// select all of them and change one property. Every step of that is a gesture
// with no other test — and the two failure modes are both silent. A range that
// sweeps in collapsed children selects more than the user can see; a "select
// all" that runs over the unfiltered tree selects the wrong set entirely. Both
// return a plausible-looking selection, so only counting ids catches them.
//
//   npx vite --port 5218
//   node scripts/run-hierarchy-select-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs for why (`?t=`
// module duplication makes harness-created entities invisible to the UI).
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5218/";
const SCENE = "SelectSmoke";
const STORAGE_KEY = "engine.hierarchy.collapsed.v1";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
// Stay on the project hub. Without this the editor reopens the last project it
// remembers, and that reload collects whatever evaluate is in flight — the
// harness dies on a protocol error before the first check runs.
await page.evaluateOnNewDocument(() => {
  globalThis.__editorNoAutoOpen = true;
});

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
 * 40 crates parented under one folder, plus 3 lights at the root.
 *
 * The crates live UNDER a parent on purpose: the folder starts collapsed, so
 * "select all" in tree mode must see 4 rows while the search must see all 40.
 * A range gesture that ignores folding would report 40+ where 4 is correct.
 */
const BUILD_SCENE = `${IMPORT_LIVE}
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  engine.clear();
  engine.sceneName = ${JSON.stringify(SCENE)};
  const folder = engine.createEntity({ id: "sel-folder", name: "Props", parent: null });
  for (let i = 0; i < 40; i++) {
    const e = engine.createEntity({ id: "sel-crate-" + i, name: "Crate" + i, parent: folder });
    e.addComponent("mesh", { geometry: "box" });
  }
  for (let i = 0; i < 3; i++) {
    const e = engine.createEntity({ id: "sel-lamp-" + i, name: "Lamp" + i, parent: null });
    e.addComponent("light", { kind: "point" });
  }
  useSceneStore.getState().refresh();
  return engine.entities.size;`;

/** Visible hierarchy rows, in order, as entity ids. */
const rowIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".hierarchy-panel .hierarchy-row")].map((r) => r.dataset.entityId),
  );

const selectedIds = () =>
  page.evaluate(`(async () => {${IMPORT_LIVE}
    const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
    return [...useSelectionStore.getState().ids];
  })()`);

/** Clicks a row with modifiers, the way the browser delivers a real click. */
const clickRow = (id, modifiers = {}) =>
  page.evaluate(
    (rowId, mods) => {
      const row = document.querySelector(`.hierarchy-panel .hierarchy-row[data-entity-id="${rowId}"]`);
      if (!row) throw new Error(`no row for ${rowId}`);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
    },
    id,
    modifiers,
  );

/** Puts the pointer over the tree, then sends a chord — the hierarchy keymap is
 *  hover-owned, exactly like the paint canvas and the node graphs. */
async function chordOverTree(key, { ctrlKey = false, shiftKey = false, altKey = false } = {}) {
  const box = await page.evaluate(() => {
    // Focus beats hover in keyScope, by design — with the caret still in the
    // filter box Ctrl+A belongs to the text field. A real click on a row blurs
    // it; synthetic clicks don't, so drop focus explicitly.
    document.activeElement?.blur?.();
    const el = document.querySelector(".hierarchy-panel .hierarchy-tree");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 20 };
  });
  await page.mouse.move(box.x, box.y);
  await page.evaluate(
    (k, mods) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
    },
    key,
    { ctrlKey, shiftKey, altKey },
  );
  await wait(200);
}

async function boot() {
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(6000);
}

async function setQuery(text) {
  await page.evaluate((value) => {
    const input = document.querySelector(".hierarchy-search-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await wait(400);
}

// ---------------------------------------------------------------------------

await boot();
const built = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await wait(900);
check("the harness scene reached the editor's engine", built === 44, `${built} entities`);

// --- tree mode: ranges and select-all respect folding -----------------------

const foldedRows = await rowIds();
check(
  "the tree opens folded, so only the roots are on screen",
  foldedRows.length === 4 && foldedRows[0] === "sel-folder",
  `${foldedRows.length} rows: ${foldedRows.join(",")}`,
);

await clickRow("sel-folder");
await clickRow("sel-lamp-2", { shiftKey: true });
const rangeFolded = await selectedIds();
check(
  "a shift-range over a collapsed branch selects only the rows you can see",
  rangeFolded.length === 4 && !rangeFolded.includes("sel-crate-0"),
  `${rangeFolded.length} selected: ${rangeFolded.join(",")}`,
);

await chordOverTree("a", { ctrlKey: true });
const allFolded = await selectedIds();
check(
  "Ctrl+A over the tree selects the visible rows, not the hidden children",
  allFolded.length === 4,
  `${allFolded.length} selected`,
);

// The hierarchy claims keys by allowlist, and getting that inverted would be
// invisible here while quietly killing Delete / Ctrl+D / Ctrl+Z for anyone whose
// pointer is resting on a row — which is where it rests while they work.
const ownership = await page.evaluate(`(async () => {${IMPORT_LIVE}
  const { keyScopeOwns, activeKeyScope } = await importLive("/src/editor/keyScope.js");
  const tree = document.querySelector(".hierarchy-panel .hierarchy-tree");
  const at = (init) => new KeyboardEvent("keydown", { target: tree, ...init });
  const probe = (init) => {
    const e = at(init);
    Object.defineProperty(e, "target", { value: tree });
    return { scope: activeKeyScope(e)?.id ?? null, owns: keyScopeOwns(e) };
  };
  return {
    selectAll: probe({ key: "a", ctrlKey: true }),
    del: probe({ key: "Delete" }),
    duplicate: probe({ key: "d", ctrlKey: true }),
    undo: probe({ key: "z", ctrlKey: true }),
  };
})()`);
check(
  "the hierarchy claims Ctrl+A…",
  ownership.selectAll.scope === "hierarchy" && ownership.selectAll.owns === true,
  JSON.stringify(ownership.selectAll),
);
check(
  "…and lets Delete / Ctrl+D / Ctrl+Z straight through to the scene",
  !ownership.del.owns && !ownership.duplicate.owns && !ownership.undo.owns,
  JSON.stringify(ownership),
);

// --- search mode: the whole point -------------------------------------------

await setQuery("crate");
const matchRows = await rowIds();
check(
  "searching flattens the tree to its matches, collapsed or not",
  matchRows.length === 40,
  `${matchRows.length} rows`,
);

// A click used to EXIT the search — which made selecting a filtered set
// impossible. It must now just select, leaving the results on screen.
await clickRow("sel-crate-3");
const afterClick = await selectedIds();
const stillFiltered = await rowIds();
check(
  "clicking a result selects it and keeps the results on screen",
  afterClick.length === 1 && afterClick[0] === "sel-crate-3" && stillFiltered.length === 40,
  `${afterClick.join(",")} / ${stillFiltered.length} rows`,
);

await chordOverTree("a", { ctrlKey: true });
const allMatches = await selectedIds();
check(
  "Ctrl+A selects every search result — all 40, none of the lamps",
  allMatches.length === 40 && allMatches.every((id) => id.startsWith("sel-crate-")),
  `${allMatches.length} selected`,
);

// Ranges run over the order the results are DISPLAYED in (tier, then name), not
// over creation order or the tree — "Crate9" sorts after "Crate10". Read the
// rows back rather than assuming, or the test asserts the wrong ten rows.
const order = await rowIds();
await clickRow(order[5]);
await clickRow(order[14], { shiftKey: true });
const searchRange = await selectedIds();
check(
  "shift-click ranges over the filtered list, in the order it is displayed",
  searchRange.length === 10 && searchRange.join(",") === order.slice(5, 15).join(","),
  `${searchRange.length} selected: ${searchRange.join(",")}`,
);

const outsider = order[30];
await clickRow(outsider, { ctrlKey: true });
const afterToggle = await selectedIds();
check(
  "ctrl-click adds one result without dropping the range",
  afterToggle.length === 11 && afterToggle.includes(outsider),
  `${afterToggle.length} selected`,
);

await chordOverTree("i", { ctrlKey: true });
const inverted = await selectedIds();
check(
  "Ctrl+I inverts within the filtered list",
  inverted.length === 29 && !inverted.includes(outsider),
  `${inverted.length} selected`,
);

await chordOverTree("a", { altKey: true });
const cleared = await selectedIds();
check("Alt+A deselects everything", cleared.length === 0, `${cleared.length} selected`);

// The search box's own chord, since Ctrl+A there belongs to the text field.
await page.evaluate(() => document.querySelector(".hierarchy-search-input").focus());
await page.evaluate(() => {
  document
    .querySelector(".hierarchy-search-input")
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
});
await wait(300);
const fromBox = await selectedIds();
check(
  "Ctrl+Shift+A in the filter box selects every result without leaving it",
  fromBox.length === 40,
  `${fromBox.length} selected`,
);

// --- reveal: double-click leaves search AND scrolls the row into view -------

await page.evaluate(() => {
  const tree = document.querySelector(".hierarchy-panel .hierarchy-tree");
  tree.scrollTop = 0;
});
await page.evaluate(() => {
  document
    .querySelector('.hierarchy-panel .hierarchy-row[data-entity-id="sel-crate-37"]')
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
});
await wait(700);

const revealed = await page.evaluate(() => {
  const tree = document.querySelector(".hierarchy-panel .hierarchy-tree");
  const row = document.querySelector('.hierarchy-panel .hierarchy-row[data-entity-id="sel-crate-37"]');
  const treeBox = tree.getBoundingClientRect();
  const rowBox = row?.getBoundingClientRect();
  return {
    query: document.querySelector(".hierarchy-search-input").value,
    rows: document.querySelectorAll(".hierarchy-panel .hierarchy-row").length,
    exists: !!row,
    inView: !!rowBox && rowBox.top >= treeBox.top - 1 && rowBox.bottom <= treeBox.bottom + 1,
    scrollTop: Math.round(tree.scrollTop),
  };
});
check("double-clicking a result leaves the search", revealed.query === "" && revealed.rows > 4, JSON.stringify(revealed));
check(
  "the revealed entity's branch is unfolded and SCROLLED INTO VIEW",
  revealed.exists && revealed.inView && revealed.scrollTop > 0,
  JSON.stringify(revealed),
);
const revealSel = await selectedIds();
check("reveal selects the entity it landed on", revealSel.join(",") === "sel-crate-37", revealSel.join(","));

// --- the MCP path selects the same set --------------------------------------

const viaOp = await page.evaluate(`(async () => {${IMPORT_LIVE}
  const { callOp } = await importLive("/src/editor/api/registry.js");
  const mesh = await callOp("selection.selectMatching", { query: "crate" });
  const lights = await callOp("selection.selectMatching", { query: "light", mode: "add" });
  const capped = await callOp("selection.selectMatching", { query: "crate", limit: 5 });
  return { mesh: mesh.matched, meshIds: mesh.entityIds.length, added: lights.entityIds.length, capped };
})()`);
check(
  "selection.selectMatching selects the same 40 the panel's search does",
  viaOp.mesh === 40 && viaOp.meshIds === 40,
  JSON.stringify(viaOp),
);
check(
  "mode:add unions rather than replaces — 40 crates plus 3 lights",
  viaOp.added === 43,
  JSON.stringify(viaOp),
);
check(
  "limit keeps the best-ranked matches and says it truncated",
  viaOp.capped.entityIds.length === 5 && viaOp.capped.matched === 40 && viaOp.capped.truncated === true,
  JSON.stringify(viaOp.capped),
);

// --- scale: more results than fit on screen ---------------------------------
//
// The gestures above are worthless if the panel cannot carry the list they run
// over. Unwindowed, 1500 matches cost 1.2 SECONDS of re-render per character
// typed. These checks pin the two halves of the fix: only a window is rendered,
// and every gesture still addresses the whole match list.

await page.evaluate(`(async () => {${IMPORT_LIVE}
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  engine.clear();
  engine.sceneName = "SelectSmokeScale";
  const folder = engine.createEntity({ id: "big-folder", name: "Props", parent: null });
  for (let i = 0; i < 400; i++) {
    const e = engine.createEntity({ id: "big-" + i, name: "Widget" + String(i).padStart(3, "0"), parent: folder });
    e.addComponent("mesh", { geometry: "box" });
  }
  useSceneStore.getState().refresh();
})()`);
await wait(900);
await setQuery("widget");

const windowed = await page.evaluate(() => ({
  rendered: document.querySelectorAll(".hierarchy-panel .hierarchy-row").length,
  pill: document.querySelector(".hierarchy-search-count")?.textContent,
  scrollHeight: document.querySelector(".hierarchy-panel .hierarchy-tree").scrollHeight,
}));
check(
  "400 matches render as a window, not 400 rows",
  windowed.rendered > 10 && windowed.rendered < 120 && windowed.pill === "400",
  JSON.stringify(windowed),
);
check(
  "the scrollbar still describes the whole match list",
  windowed.scrollHeight > 400 * 20,
  `scrollHeight ${windowed.scrollHeight}`,
);

await chordOverTree("a", { ctrlKey: true });
const allBig = await selectedIds();
check(
  "Ctrl+A selects all 400 matches, not just the rendered window",
  allBig.length === 400,
  `${allBig.length} selected`,
);

// End has to reach a row that does not exist in the DOM yet.
await page.evaluate(() => {
  document.querySelector(".hierarchy-panel .hierarchy-tree").scrollTop = 0;
});
await chordOverTree("End");
const atEnd = await page.evaluate(`(async () => {${IMPORT_LIVE}
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const tree = document.querySelector(".hierarchy-panel .hierarchy-tree");
  const id = useSelectionStore.getState().ids[0];
  const row = document.querySelector('.hierarchy-panel .hierarchy-row[data-entity-id="' + id + '"]');
  const tb = tree.getBoundingClientRect();
  const rb = row?.getBoundingClientRect();
  return {
    id,
    count: useSelectionStore.getState().ids.length,
    inView: !!rb && rb.top >= tb.top - 1 && rb.bottom <= tb.bottom + 1,
  };
})()`);
check(
  "End jumps to the last match, renders it and scrolls it into view",
  atEnd.id === "big-399" && atEnd.count === 1 && atEnd.inView,
  JSON.stringify(atEnd),
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
  `\n${passed === results.length && !realErrors.length ? "HIERARCHY-SELECT PASS" : "HIERARCHY-SELECT FAIL"} — ` +
    `${passed}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
process.exit(passed === results.length && !realErrors.length ? 0 : 1);
