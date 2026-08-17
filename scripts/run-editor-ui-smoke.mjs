// Editor UI polish smoke test: mounts the real editor and exercises the
// inspector controls added in the UI/UX pass — material slots, the scale
// proportion lock, drag-to-scrub number fields, the icon Add Component menu,
// the Particles preset in the Add Object menu, and entity tags.
//
// These only exist once React has rendered against real DOM and real pointer
// events have gone through the browser's capture path, so a unit test can't
// reach them.
//
//   npx vite --port 5201
//   node scripts/run-editor-ui-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH. Vite rewrites imports of files edited since the
// server started to `…?t=<mtime>`, so the app loads engineInstance.js under a
// versioned URL while this harness's `import("/src/…")` gets the bare one —
// two module graphs, two Engine singletons. The symptom is that entities the
// harness creates are invisible to the UI. Restart vite after editing src/.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));
// A bare "Failed to load resource" console line names no URL; record the
// request itself so a 404 points at the file that is actually missing.
const failedRequests = [];
page.on("response", (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

// --- a mesh entity to inspect ----------------------------------------------

const setup = await page.evaluate(async () => {
/**
 * Imports the module instance the APP is using, not a fresh copy.
 *
 * Vite rewrites imports of files edited since the server started to
 * `…?t=<mtime>`. A bare `import("/src/…")` from the harness therefore loads a
 * SECOND copy with its own Engine singleton, and every entity this harness
 * creates becomes invisible to the UI. Reading back the URL the browser
 * actually fetched sidesteps that without needing a server restart.
 */
const importLive = (path) => {
  const prefix = location.origin + path;
  const fetched = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
  const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
  return import(/* @vite-ignore */ live ?? path);
};

  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await importLive("/src/editor/commands/entityCommands.js");

  const create = new CreateEntityCommand({
    name: "SmokeMesh",
    components: [{ type: "mesh", props: { geometry: "box" } }],
  });
  commandBus.execute(create);
  useSceneStore.getState().refresh();
  useSelectionStore.getState().select(create.entityId);
  globalThis.__smokeId = create.entityId;
  globalThis.__engine = engine;
  globalThis.__importLive = importLive;
  return { id: String(create.entityId), wired: !!engine.getEntity(create.entityId)?.getComponent("mesh") };
});
if (!setup.wired) {
  console.log("UI-SMOKE FAIL — engine module duplicated; restart `npx vite` and re-run");
  await browser.close();
  process.exit(1);
}
await wait(800);

/** Every inspector field-row whose label matches, as {label, box}. */
const rowBox = (label) =>
  page.evaluate((text) => {
    const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
      (r) => r.querySelector(".field-label")?.textContent?.trim() === text,
    );
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, label);

// --- material slots ---------------------------------------------------------

const slotState = await page.evaluate(() => {
  const labels = [...document.querySelectorAll(".inspector-panel .field-label")].map((n) => n.textContent.trim());
  return {
    materialRows: labels.filter((l) => /^Material( \d)?$/.test(l)),
    hasAddButton: [...document.querySelectorAll(".inspector-panel button")].some((b) =>
      b.textContent?.includes("Add Material Slot"),
    ),
  };
});
check(
  "a fresh mesh shows exactly one material slot",
  slotState.materialRows.length === 1 && slotState.materialRows[0] === "Material",
  JSON.stringify(slotState.materialRows),
);
check("the Add Material Slot button is offered", slotState.hasAddButton);

await page.evaluate(() => {
  [...document.querySelectorAll(".inspector-panel button")]
    .find((b) => b.textContent?.includes("Add Material Slot"))
    ?.click();
});
await wait(300);
const afterAdd = await page.evaluate(() =>
  [...document.querySelectorAll(".inspector-panel .field-label")]
    .map((n) => n.textContent.trim())
    .filter((l) => /^Material( \d)?$/.test(l)),
);
check(
  "adding a slot renumbers to Material 1 / Material 2",
  afterAdd.length === 2 && afterAdd[0] === "Material 1" && afterAdd[1] === "Material 2",
  JSON.stringify(afterAdd),
);

// --- editor action row replaced the stacked buttons -------------------------

const actions = await page.evaluate(() =>
  [...document.querySelectorAll(".inspector-panel .editor-action")].map((b) =>
    b.querySelector(".editor-action-label")?.textContent?.trim(),
  ),
);
check(
  "mesh actions render as an icon row, not stacked full-width buttons",
  actions.includes("Edit Geometry") && actions.includes("Shader Graph"),
  JSON.stringify(actions),
);

// --- drag-to-scrub a number field ------------------------------------------

const posRow = await rowBox("Position");
if (!posRow) {
  check("Position row is present", false);
} else {
  const before = await page.evaluate(() => globalThis.__engine.getEntity(globalThis.__smokeId).position.x);
  // Grab the X field (first axis cell of the Position row) and drag right.
  const field = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
      (r) => r.querySelector(".field-label")?.textContent?.trim() === "Position",
    );
    const input = row?.querySelector(".axis-field .number-field");
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!field) {
    check("Position X renders as an axis-tagged number field", false);
  } else {
    await page.mouse.move(field.x, field.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(field.x + i * 4, field.y);
    await page.mouse.up();
    await wait(300);
    const after = await page.evaluate(() => globalThis.__engine.getEntity(globalThis.__smokeId).position.x);
    check(
      "dragging a number field to the right raises its value",
      after > before + 0.5,
      `${before.toFixed(3)} -> ${after.toFixed(3)}`,
    );
  }
}

// --- uniform scale lock -----------------------------------------------------

await page.evaluate(() => {
  const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
    (r) => r.querySelector(".field-label")?.textContent?.trim() === "Scale",
  );
  row?.querySelector(".lock-btn")?.click();
});
await wait(200);

const scaled = await page.evaluate(async () => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { SetTransformCommand } = await globalThis.__importLive("/src/editor/commands/transformCommands.js");
  const engine = globalThis.__engine;
  const id = globalThis.__smokeId;
  // Start from a non-uniform scale so a ratio-preserving edit is detectable.
  const before = engine.getEntity(id).getTransform();
  commandBus.execute(new SetTransformCommand(id, { ...before, scale: [1, 2, 4] }));
  return true;
});
await wait(300);

if (scaled) {
  // Type a new X into the scale row and commit; the lock should carry Y and Z.
  const applied = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector-panel .field-row")].find(
      (r) => r.querySelector(".field-label")?.textContent?.trim() === "Scale",
    );
    const input = row?.querySelector(".axis-field .number-field");
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, "2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    return true;
  });
  await wait(400);
  const scale = await page.evaluate(() => globalThis.__engine.getEntity(globalThis.__smokeId).scale.toArray());
  check(
    "with proportions locked, editing Scale X scales Y and Z by the same ratio",
    applied && Math.abs(scale[0] - 2) < 1e-3 && Math.abs(scale[1] - 4) < 1e-3 && Math.abs(scale[2] - 8) < 1e-3,
    JSON.stringify(scale.map((n) => +n.toFixed(3))),
  );
}

// --- Add Component menu: icons, groups, search ------------------------------

await page.evaluate(() => {
  [...document.querySelectorAll(".inspector-panel button")]
    .find((b) => b.textContent?.trim().startsWith("Add Component"))
    ?.click();
});
await wait(400);
const menu = await page.evaluate(() => {
  const el = document.querySelector(".component-menu");
  if (!el) return null;
  return {
    hasSearch: !!el.querySelector(".component-menu-search input"),
    groups: [...el.querySelectorAll(".dropdown-section-label")].map((n) => n.textContent.trim()),
    icons: el.querySelectorAll(".component-item-icon").length,
    items: el.querySelectorAll(".component-item").length,
  };
});
check("Add Component opens the grouped, icon-led menu", !!menu, menu ? "" : "no .component-menu");
if (menu) {
  check("every entry carries an icon", menu.icons === menu.items && menu.items > 0, `${menu.icons}/${menu.items}`);
  check("entries are grouped by area", menu.groups.length >= 3, menu.groups.join(", "));
  check("the menu has a search field", menu.hasSearch);

  // "light" rather than a module-provided type: the physics/terrain modules are
  // off in a default session, so anything they register would match nothing and
  // the test would be asserting the module list, not the search.
  await page.type(".component-menu-search input", "light");
  await wait(300);
  const filtered = await page.evaluate(() => ({
    labels: [...document.querySelectorAll(".component-menu .component-item-label")].map((n) => n.textContent.trim()),
    groupHeaders: document.querySelectorAll(".component-menu .dropdown-section-label").length,
  }));
  check(
    "typing filters the component list",
    filtered.labels.length > 0 && filtered.labels.every((l) => /light/i.test(l)),
    JSON.stringify(filtered.labels),
  );
  check(
    "a search collapses the group headers into one flat list",
    filtered.groupHeaders === 0,
    String(filtered.groupHeaders),
  );
  await page.keyboard.press("Escape");
  await wait(200);
}

// --- entity tags ------------------------------------------------------------

const tagRow = await rowBox("Tags");
check("the inspector has a Tags row", !!tagRow);
if (tagRow) {
  await page.evaluate(() => document.querySelector(".inspector-panel .tag-input")?.focus());
  await page.type(".inspector-panel .tag-input", "enemy");
  await page.keyboard.press("Enter");
  await wait(400);
  const tagged = await page.evaluate(() => ({
    engineTags: globalThis.__engine.getEntity(globalThis.__smokeId).tags,
    chips: [...document.querySelectorAll(".inspector-panel .tag-chip")].map((n) => n.textContent.trim()),
    found: globalThis.__engine.findByTag("enemy").length,
  }));
  check("typing a tag adds it to the entity", tagged.engineTags.includes("enemy"), JSON.stringify(tagged.engineTags));
  check("the tag renders as a chip", tagged.chips.some((c) => c.startsWith("enemy")), JSON.stringify(tagged.chips));
  check("engine.findByTag finds the tagged entity", tagged.found === 1, String(tagged.found));

  // Undo must take the tag back off — tags go through the command bus.
  await page.evaluate(async () => {
    const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
    commandBus.undo();
  });
  await wait(300);
  const afterUndo = await page.evaluate(() => globalThis.__engine.getEntity(globalThis.__smokeId).tags);
  check("undo removes the tag", !afterUndo.includes("enemy"), JSON.stringify(afterUndo));
}

// --- Add Object menu: Particles preset + icons ------------------------------

await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".hierarchy-panel .panel-toolbar .toolbar-btn")][0];
  btn?.click();
});
await wait(400);
const addMenu = await page.evaluate(() => {
  const el = document.querySelector(".hierarchy-panel .dropdown-menu");
  if (!el) return null;
  return {
    labels: [...el.querySelectorAll(".component-item-label")].map((n) => n.textContent.trim()),
    icons: el.querySelectorAll(".component-item-icon").length,
  };
});
check("the Add Object menu offers Particles", !!addMenu?.labels.includes("Particles"), JSON.stringify(addMenu?.labels));
check("Add Object entries carry icons", (addMenu?.icons ?? 0) > 0, String(addMenu?.icons));

if (addMenu?.labels.includes("Particles")) {
  await page.evaluate(() => {
    [...document.querySelectorAll(".hierarchy-panel .dropdown-item")]
      .find((b) => b.textContent?.trim() === "Particles")
      ?.click();
  });
  await wait(900);
  const made = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const hit = [...engine.entities.values()].find((e) => e.name === "Particles");
    return { exists: !!hit, hasComponent: !!hit?.getComponent("particles") };
  });
  check(
    "picking Particles creates an entity with a particles component",
    made.exists && made.hasComponent,
    JSON.stringify(made),
  );
}

// --- Assets panel: filters, search, badges ---------------------------------

// The panel normally lists a folder over Tauri, which doesn't exist in a
// browser. Seeding the project store with a fabricated listing exercises
// everything above the filesystem — the filter bar, the type filter, search,
// and the flag badges — without needing a real project on disk.
const seeded = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const { useAssetFlagsStore } = await globalThis.__importLive("/src/editor/assetFlags.js");
  const root = "C:/FakeProject";
  const file = (name, ext, extra = {}) => ({
    name,
    path: `${root}/${name}`,
    ext,
    is_dir: false,
    size: 1024,
    modified: 1_700_000_000,
    ...extra,
  });
  const entries = [
    file("Rock.glb", "glb"),
    file("Rock.png", "png"),
    file("RockCliff.mat", "mat"),
    file("Player.ts", "ts"),
    file("Level.scene", "scene"),
    { name: "Props", path: `${root}/Props`, ext: "", is_dir: true, size: 0, modified: 0 },
  ];
  // Autosave off for the fixture. A root path plus a dirty scene is all the
  // editor's 10s autosave needs, and here it would write "C:/FakeProject" over
  // a Tauri bridge that does not exist in a browser — a pageerror this smoke
  // treats as a failure, arriving purely as a function of how long the run
  // takes rather than of anything it tested.
  useProjectStore.setState({
    rootPath: root,
    currentPath: root,
    entries,
    loading: false,
    error: null,
    projectMeta: { settings: { editor: { autosaveSeconds: 0 } } },
  });
  globalThis.__fakeRoot = root;
  return true;
});
await wait(900);

// Flags go in AFTER the listing settles: the panel loads flags from the
// listing on every `entries` change, and a fabricated listing has no `.meta`
// siblings, so seeding them first would be overwritten with defaults.
await page.evaluate(async () => {
  const { useAssetFlagsStore } = await globalThis.__importLive("/src/editor/assetFlags.js");
  const root = globalThis.__fakeRoot;
  useAssetFlagsStore.getState().merge({
    [`${root}/Rock.png`]: { preload: true, exclude: false, tags: ["terrain"] },
    [`${root}/Player.ts`]: { preload: false, exclude: true, tags: [] },
  });
});
await wait(500);

if (seeded) {
  const bar = await page.evaluate(() => ({
    hasFilterBar: !!document.querySelector(".assets-filterbar"),
    hasSearch: !!document.querySelector(".assets-search-input"),
    hasTypeFilter: !!document.querySelector(".assets-filterbar .filter-btn"),
    tiles: [...document.querySelectorAll(".asset-tile .asset-name")].map((n) => n.textContent.trim()),
    preloadBadges: document.querySelectorAll(".asset-flag-badge.preload").length,
    excludeBadges: document.querySelectorAll(".asset-flag-badge.exclude").length,
    dimmed: document.querySelectorAll(".asset-tile.excluded").length,
  }));
  check("the Assets panel renders a filter bar", bar.hasFilterBar && bar.hasSearch && bar.hasTypeFilter);
  check("the seeded folder lists its assets", bar.tiles.length === 6, JSON.stringify(bar.tiles));
  check("a preloaded asset shows its badge", bar.preloadBadges === 1, String(bar.preloadBadges));
  check(
    "an excluded asset shows its badge and dims",
    bar.excludeBadges === 1 && bar.dimmed === 1,
    `${bar.excludeBadges} badge / ${bar.dimmed} dimmed`,
  );

  await page.type(".assets-search-input", "rock");
  await wait(600);
  const searched = await page.evaluate(() =>
    [...document.querySelectorAll(".asset-tile .asset-name, .asset-row-label")].map((n) => n.textContent.trim()),
  );
  check(
    "search narrows the grid by name",
    searched.length === 3 && searched.every((n) => /rock/i.test(n)),
    JSON.stringify(searched),
  );

  // Type filter stacks with the search rather than replacing it.
  await page.evaluate(() => document.querySelector(".assets-filterbar .filter-btn")?.click());
  await wait(300);
  await page.evaluate(() => {
    [...document.querySelectorAll(".assets-filterbar .component-item-label")]
      .find((n) => n.textContent.trim() === "Textures")
      ?.closest("button")
      ?.click();
  });
  await wait(600);
  const combined = await page.evaluate(() => ({
    names: [...document.querySelectorAll(".asset-tile .asset-name, .asset-row-label")].map((n) =>
      n.textContent.trim(),
    ),
    label: document.querySelector(".filter-btn-label")?.textContent?.trim(),
  }));
  check(
    "the type filter stacks with the search instead of replacing it",
    combined.names.length === 1 && combined.names[0] === "Rock.png",
    `${combined.label}: ${JSON.stringify(combined.names)}`,
  );

  // tag: qualifier — matches the flag store, not the filename.
  await page.evaluate(() => {
    const input = document.querySelector(".assets-search-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "tag:terrain");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(600);
  const byTag = await page.evaluate(() =>
    [...document.querySelectorAll(".asset-tile .asset-name, .asset-row-label")].map((n) => n.textContent.trim()),
  );
  check("a tag: query matches asset tags", byTag.length === 1 && byTag[0] === "Rock.png", JSON.stringify(byTag));
}

// --- the Inspector follows the selection ------------------------------------

// Closing the panel outright is the strongest form of "not active": if the
// follower brings it back from closed, it certainly brings it forward from
// behind another tab, and `isPanelVisible` is the same predicate the follower
// itself uses (existing + on screen + the group's active tab + big enough).
const follow = await page.evaluate(async () => {
  const shell = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  useSelectionStore.getState().clear();
  shell.closePanel("inspector");
  await settle(300);
  const closed = !shell.isPanelVisible("inspector");

  useSelectionStore.getState().select(globalThis.__smokeId);
  await settle(600);
  const afterEntity = shell.isPanelVisible("inspector");

  // …and a cleared selection must not reopen it: there is nothing to inspect,
  // and a panel that reappears when you click empty space is a panel that
  // cannot be closed.
  shell.closePanel("inspector");
  await settle(300);
  useSelectionStore.getState().clear();
  await settle(400);
  const stayedClosed = !shell.isPanelVisible("inspector");

  let afterAsset = null;
  if (globalThis.__fakeRoot) {
    useSelectionStore.getState().selectAsset(`${globalThis.__fakeRoot}/Rock.png`);
    await settle(600);
    afterAsset = shell.isPanelVisible("inspector");
  }
  return { closed, afterEntity, stayedClosed, afterAsset };
});
check("selecting an entity opens the Inspector when it isn't showing", follow.closed && follow.afterEntity, JSON.stringify(follow));
check("clearing the selection does not reopen it", follow.stayedClosed, JSON.stringify(follow));
check("selecting an asset opens it too", follow.afterAsset !== false, JSON.stringify(follow));

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);

// The browser's own /favicon.ico probe 404s in dev and logs a console error
// that names no URL ("Failed to load resource: … 404"). Correlate the console
// line with the recorded responses so a *real* 404 still fails the run while
// the favicon does not — filtering the console text alone can't tell them
// apart, and blanket-ignoring "Failed to load resource" would hide a genuinely
// missing module.
// --- Build Settings panel ----------------------------------------------------
//
// A throw anywhere in this panel blanks the whole thing (React unmounts the
// subtree), and the panel is the only place several build decisions can be
// made — so "it renders and its controls act" is worth a check that no
// headless test can make. The seeded project root above is what makes it
// render at all; without one it is a placeholder.
await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("build");
});
await wait(1500);
const buildPanel = await page.evaluate(() => {
  const headers = [...document.querySelectorAll(".scene-settings-panel .section-header")].map((h) =>
    h.textContent.trim(),
  );
  const panel = [...document.querySelectorAll(".scene-settings-panel")].find((p) =>
    [...p.querySelectorAll(".section-header")].some((h) => h.textContent.trim() === "Target"),
  );
  if (!panel) return { headers, found: false };
  const selects = [...panel.querySelectorAll("select")];
  return {
    found: true,
    headers: [...panel.querySelectorAll(".section-header")].map((h) => h.textContent.trim()),
    targets: [...(selects[0]?.options ?? [])].map((o) => o.value),
    qualityOptions: [...(selects.find((s) => [...s.options].some((o) => o.value === "ultra"))?.options ?? [])].map(
      (o) => o.value,
    ),
    buttons: [...panel.querySelectorAll(".panel-toolbar button")].map((b) => b.textContent.trim()),
    colorFields: panel.querySelectorAll('input[type="color"]').length,
    // Compression toggles are disabled while their module is off — the
    // alternative (an enabled checkbox that silently does nothing) is the bug
    // this asserts against.
    disabledToggles: panel.querySelectorAll('input[type="checkbox"]:disabled').length,
  };
});
check("the Build panel renders", buildPanel.found, JSON.stringify(buildPanel.headers));
if (buildPanel.found) {
  check(
    "it has every section",
    ["Target", "Scenes", "Quality", "Presentation", "Compression"].every((h) => buildPanel.headers.includes(h)),
    buildPanel.headers.join(", "),
  );
  check(
    "all three targets are offered",
    ["web", "zip", "desktop"].every((t) => buildPanel.targets.includes(t)),
    buildPanel.targets.join(","),
  );
  check(
    "the quality presets are offered",
    buildPanel.qualityOptions.includes("low") && buildPanel.qualityOptions.includes("ultra"),
    buildPanel.qualityOptions.join(","),
  );
  check(
    "Build and Build & Run are both reachable",
    buildPanel.buttons.some((b) => /^Build/.test(b)) && buildPanel.buttons.some((b) => /Run/.test(b)),
    buildPanel.buttons.join(" | "),
  );
  check("the loading screen has its colour pickers", buildPanel.colorFields === 2, String(buildPanel.colorFields));
  check(
    "compression toggles are disabled while their modules are off",
    buildPanel.disabledToggles === 2,
    String(buildPanel.disabledToggles),
  );

  // Changing the target must not throw — each one takes a different branch in
  // the report/preview wiring.
  const switched = await page.evaluate(async () => {
    const panel = [...document.querySelectorAll(".scene-settings-panel")].find((p) =>
      [...p.querySelectorAll(".section-header")].some((h) => h.textContent.trim() === "Target"),
    );
    const select = panel.querySelector("select");
    for (const value of ["zip", "desktop", "web"]) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    }
    return !!panel.querySelector("select");
  });
  check("switching between targets keeps the panel alive", switched === true);
}

// --- Post Process panel: the .post document toolbar --------------------------
//
// The graph moved out of the component and into a `.post` file, which means
// the panel grew a document toolbar — which graph, Save, Save As. The op smoke
// covers the file half; what it cannot cover is that the toolbar RENDERS, and
// a React throw in this panel blanks the whole subtree silently.
await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("postprocess");
});
await wait(1500);
const post = await page.evaluate(() => {
  const panel = document.querySelector(".postprocess-panel");
  if (!panel) return null;
  return {
    // The Graph slot is an AssetField; with nothing assigned it reads "Embedded".
    slot: panel.querySelector(".asset-field .asset-field-name")?.textContent?.trim() ?? null,
    buttons: [...panel.querySelectorAll(".toolbar-btn")].map((b) => b.textContent.trim()).filter(Boolean),
    // No camera in this fixture, so the editor half is the empty state — which
    // must still explain both ways in, not just the camera one.
    empty: panel.querySelector(".postprocess-empty h3")?.textContent?.trim() ?? null,
  };
});
check("the Post Process panel renders", !!post, post ? "" : "no .postprocess-panel");
if (post) {
  check("…with a Graph slot for picking a .post", post.slot === "Embedded", String(post.slot));
  check(
    "…and the empty state names the graph route, not only the camera one",
    /graph/i.test(post.empty ?? ""),
    String(post.empty),
  );
}

// --- opening panels must work from ANY copy of EditorShell -------------------
//
// Regression for a bug that presented as "clicking View -> <panel> does
// nothing, for any panel, with no error". `dockApi` was a module-scope `let`,
// so when Vite evaluated EditorShell twice (an HMR update, or its `?t=<mtime>`
// URL twin) the MenuBar could hold a copy whose handle was still null.
// `openPanel` then took its "Dockview isn't ready yet" branch, parked the
// request in a queue that would never flush, and returned silently.
//
// Forcing the second evaluation with `?dup=1` reproduces exactly that, and the
// assertion is behavioural: a panel opened through the DUPLICATE module must
// actually appear.
const dupOpen = await page.evaluate(async () => {
  const live = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  const dup = await import(/* @vite-ignore */ `${location.origin}/src/editor/EditorShell.jsx?dup=1`);
  const count = () => document.querySelectorAll(".mcp-panel").length;
  const before = count();
  dup.openPanel("mcp");
  await new Promise((r) => setTimeout(r, 1500));
  return { distinctModules: live.openPanel !== dup.openPanel, before, after: count() };
});
check(
  "a duplicated EditorShell really is a separate module",
  dupOpen.distinctModules === true,
  "if this ever goes false the test below proves nothing",
);
check(
  "openPanel works through a duplicated module",
  dupOpen.before === 0 && dupOpen.after === 1,
  `${dupOpen.before} -> ${dupOpen.after}`,
);

const badRequests = failedRequests.filter((r) => !/\/favicon\.ico$/.test(r));
const realErrors = errors.filter((e) => {
  if (/WebGPU|GPUAdapter|Deprecation/i.test(e)) return false;
  // The seeded Assets-panel listing points at files that do not exist; the
  // thumbnail readers failing on them is the fixture, not a defect.
  if (/FakeProject/.test(e)) return false;
  if (/Failed to load resource/i.test(e)) return badRequests.length > 0;
  return true;
});
// React key/prop warnings surface here too — they'd be invisible otherwise.
if (realErrors.length) {
  console.log("\nConsole errors:");
  for (const e of realErrors.slice(0, 12)) console.log(`  ${e}`);
}
if (badRequests.length) {
  console.log("\nFailed requests:");
  for (const r of badRequests.slice(0, 12)) console.log(`  ${r}`);
}
const bad = failed.length || realErrors.length || badRequests.length;
console.log(
  `\nUI-SMOKE ${bad ? "FAIL" : "PASS"} — ` +
    `${results.length - failed.length}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
process.exit(bad ? 1 : 0);
