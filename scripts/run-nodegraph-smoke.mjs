// Node-graph editor smoke test: mounts the real editor, opens the Particles and
// Shader Graph panels, and drives the toolkit's interactions (palette search,
// add node, wire, undo/redo, copy/paste, reroute, collapse, scrub a number
// field) asserting the graph JSON actually changes as it should.
//
// A unit test can't catch these: the toolkit's behaviour only exists once React
// Flow has measured real DOM nodes and React Flow's own handlers are wired up.
//
//   npx vite --port 5201
//   node scripts/run-nodegraph-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH. Vite rewrites imports of files edited since the
// server started to `…?t=<mtime>`, so the app loads (say) engineInstance.js
// under a versioned URL while this harness's `import("/src/…")` gets the bare
// one — TWO module instances, TWO Engine singletons. The symptom is bizarre:
// `engine.entities` is empty right after a command that demonstrably created an
// entity, and every component lookup returns undefined. Restart vite after
// editing src/ and before running this.
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
  const text = m.text();
  if (m.type() === "error") errors.push(text);
  if (/NG-SMOKE/.test(text)) console.log(text);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 6000));

// --- set up an entity with particles, and open the Particles panel ----------

const setup = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;

  const { useSelectionStore } = await import("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await import("/src/editor/store/sceneStore.js");
  const { commandBus } = await import("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await import("/src/editor/commands/entityCommands.js");
  const { AddComponentCommand } = await import("/src/editor/commands/componentCommands.js");

  const create = new CreateEntityCommand({ name: "SmokeParticles" });
  commandBus.execute(create);
  const id = create.entityId;
  commandBus.execute(new AddComponentCommand(id, "particles"));
  useSceneStore.getState().refresh();
  useSelectionStore.getState().select(id);
  globalThis.__smokeEntity = id;
  // If this is false the harness is talking to a duplicated module graph —
  // restart vite (see the note at the top) rather than debugging the editor.
  return { id: String(id), wired: !!engine.getEntity(id)?.getComponent("particles") };
});
console.log(`NG-SMOKE entity ${setup.id}`);
if (!setup.wired) {
  console.log("NG-SMOKE FAIL — engine module duplicated; restart `npx vite` and re-run");
  await browser.close();
  process.exit(1);
}

/** Opens a dock panel by clicking its Window-menu entry. */
async function openPanel(label) {
  await page.evaluate((name) => {
    const hit = [...document.querySelectorAll("button, [role='menuitem'], .dropdown-item")].find(
      (b) => b.textContent?.trim() === name,
    );
    hit?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 400));
}

/** Both graph panels dock into the same (Assets) group, so opening one makes
 *  the other inactive — click the tab to bring a specific one forward. */
async function activateTab(name) {
  // A real mouse click on the tab's box. Dockview activates on pointerdown
  // against the tab element itself; `element.click()` from script does not
  // reach that handler, so it silently leaves the old tab in front.
  const box = await page.evaluate((label) => {
    const tab = [...document.querySelectorAll(".dv-tab, .tab, [role='tab']")].find((t) =>
      t.textContent?.trim().startsWith(label),
    );
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  if (box) await page.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 1200));
}

// The Window menu holds the panel list; open it then pick the panel.
for (const panel of ["Shader Graph", "Particles"]) {
  await page.evaluate(() => {
    [...document.querySelectorAll("button, .menu-bar-item")].find((b) => b.textContent?.trim() === "Window")?.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await openPanel(panel);
}
await activateTab("Particles");
await new Promise((r) => setTimeout(r, 1200));

const mounted = await page.evaluate(() => document.querySelectorAll(".shader-graph-canvas").length);
check("graph panels mount", mounted > 0, `${mounted} canvas(es)`);

/**
 * Framing check. The reported bug: opening a graph panel rendered the whole
 * graph as a postage stamp in the top-left corner, because React Flow's
 * `fitView` prop fits once against whatever the container measured at init —
 * and inside dockview that is routinely a near-zero box.
 *
 * Assert the nodes actually fill a sane share of the viewport and are not all
 * crammed into one corner.
 */
const framing = await page.evaluate(() => {
  const pane = document.querySelector(".react-flow__viewport");
  const wrap = document.querySelector(".shader-graph-canvas");
  const nodes = [...document.querySelectorAll(".react-flow__node")];
  if (!pane || !wrap || !nodes.length) return null;
  const w = wrap.getBoundingClientRect();
  const boxes = nodes.map((n) => n.getBoundingClientRect());
  const minX = Math.min(...boxes.map((b) => b.left));
  const maxX = Math.max(...boxes.map((b) => b.right));
  const minY = Math.min(...boxes.map((b) => b.top));
  const maxY = Math.max(...boxes.map((b) => b.bottom));
  const transform = getComputedStyle(pane).transform;
  const zoom = transform === "none" ? 1 : parseFloat(transform.split("(")[1]);
  return {
    fillX: (maxX - minX) / w.width,
    fillY: (maxY - minY) / w.height,
    zoom,
    inside: minX >= w.left - 2 && maxX <= w.right + 2 && minY >= w.top - 2 && maxY <= w.bottom + 2,
  };
});
check(
  "graph is framed to fill the panel on open",
  framing && (framing.fillX > 0.5 || framing.fillY > 0.5),
  framing ? `fill ${framing.fillX.toFixed(2)}x${framing.fillY.toFixed(2)}, zoom ${framing.zoom.toFixed(3)}` : "no nodes",
);
check("framed graph sits inside the panel", !!framing?.inside);

// (The "press F to re-frame" check runs at the very end — it deliberately
//  wrecks the viewport transform, which would break every later interaction.)

/** Reads the live committed particle graph off the component. */
const committedGraph = () =>
  page.evaluate(() => {
    const e = globalThis.__engine.getEntity(globalThis.__smokeEntity);
    return e?.getComponent("particles")?.props?.graph ?? null;
  });

// --- the particle canvas ----------------------------------------------------

const canvas = await page.$(".shader-graph-canvas");
check("particle graph canvas present", !!canvas);

const nodeCount = () => page.evaluate(() => document.querySelectorAll(".graph-node, .shader-node").length);
const before = await nodeCount();
check("default graph renders nodes", before > 0, `${before} nodes`);

// --- palette: right-click the canvas, fuzzy-search, add a node -------------

// Right-click the PANE, not the canvas wrapper — the wrapper's edges are
// covered by the Controls/minimap and the panel can be a narrow column.
const pane = await page.$(".react-flow__pane");
const box = await pane.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8, { button: "right" });
await new Promise((r) => setTimeout(r, 350));
const paletteOpen = await page.evaluate(() => !!document.querySelector(".node-palette-search"));
check("right-click opens the node palette", paletteOpen);

if (paletteOpen) {
  // "fno" must fuzzy-match "Fractal Noise" — a plain substring filter cannot.
  await page.type(".node-palette-search", "fno");
  await new Promise((r) => setTimeout(r, 250));
  const top = await page.evaluate(() => document.querySelector(".node-palette-item")?.textContent?.trim() ?? "");
  check("fuzzy search finds Fractal Noise from 'fno'", /fractal/i.test(top), `top hit: "${top}"`);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 400));
}

const afterAdd = await nodeCount();
check("palette pick adds a node", afterAdd === before + 1, `${before} → ${afterAdd}`);

// --- toolbar dropdowns must be VISIBLE, not merely present ------------------
// Regression: the Presets and Node menus opened but were painted underneath the
// React Flow canvas (its `.react-flow__connectionline` is z-index 1001 and the
// canvas established no stacking context), and were separately clipped by an
// `overflow` on the toolbar. Both failure modes leave the element in the DOM
// with a real bounding box, so presence checks pass while the user sees nothing
// — this asserts the menu is actually the top-most element at its own centre.

/** Opens a toolbar dropdown and reports whether it is genuinely on screen. */
async function checkToolbarDropdown(label, selector) {
  await page.evaluate((text) => {
    [...document.querySelectorAll(".panel-toolbar button")]
      .find((b) => (b.textContent ?? "").includes(text))
      ?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 400));
  const state = await page.evaluate((sel) => {
    const menu = document.querySelector(sel);
    if (!menu) return { open: false };
    const r = menu.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return { open: true, box: [r.width, r.height], onTop: false };
    // Hit-test the menu's own centre: whatever is painted there must be the
    // menu (or a descendant of it).
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 40));
    // Clipping check: an ancestor with overflow would cut the menu short.
    const wrap = menu.closest(".dropdown-wrap");
    const toolbar = wrap?.closest(".panel-toolbar");
    const tb = toolbar?.getBoundingClientRect();
    return {
      open: true,
      box: [Math.round(r.width), Math.round(r.height)],
      onTop: !!hit && (menu === hit || menu.contains(hit)),
      extendsBelowToolbar: tb ? r.bottom > tb.bottom + 4 : true,
      topEl: hit?.className?.toString?.().slice(0, 60) ?? null,
    };
  }, selector);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector(".dropdown-overlay")?.click());
  await new Promise((r) => setTimeout(r, 250));
  return state;
}

const presets = await checkToolbarDropdown("Presets", ".dropdown-menu");
check(
  "Presets dropdown renders above the graph canvas",
  presets.open && presets.onTop && presets.extendsBelowToolbar,
  JSON.stringify(presets),
);

const nodeMenu = await checkToolbarDropdown("Node", ".node-palette");
check(
  "toolbar Node palette renders above the graph canvas",
  nodeMenu.open && nodeMenu.onTop && nodeMenu.extendsBelowToolbar,
  JSON.stringify(nodeMenu),
);

// Exactly ONE scrollbar in the palette. Both `.node-palette` and
// `.node-palette-list` used to be scroll containers, so the search box and
// category chips pushed the inner list past the outer box and two scrollbars
// appeared side by side.
await page.evaluate(() => {
  [...document.querySelectorAll(".panel-toolbar button")].find((b) => /Node/.test(b.textContent ?? ""))?.click();
});
await new Promise((r) => setTimeout(r, 400));
const scrollers = await page.evaluate(() => {
  const palette = document.querySelector(".node-palette");
  if (!palette) return null;
  const found = [];
  for (const el of [palette, ...palette.querySelectorAll("*")]) {
    const style = getComputedStyle(el);
    const scrollsY = /(auto|scroll)/.test(style.overflowY);
    // A container only shows a scrollbar when it actually overflows.
    if (scrollsY && el.scrollHeight > el.clientHeight + 1) found.push(el.className.toString().trim().slice(0, 40));
  }
  return found;
});
await page.evaluate(() => document.querySelector(".dropdown-overlay")?.click());
await new Promise((r) => setTimeout(r, 250));
check(
  "node palette has exactly one scrollbar",
  scrollers !== null && scrollers.length <= 1,
  scrollers ? `scrolling: ${JSON.stringify(scrollers)}` : "palette not found",
);

// --- undo / redo ------------------------------------------------------------

await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
// NOTE: this runs immediately after the dropdown checks ON PURPOSE. A dropdown
// mounts a full-screen overlay that fires `mouseleave` on the graph canvas, and
// closing it does not re-fire `mouseenter` under a stationary pointer — which
// used to leave the "a graph owns this keypress" flag stale, so Ctrl+Z fell
// through to the GLOBAL handler and undid the last scene command (removing the
// Particles component) instead of the last graph edit.
await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await new Promise((r) => setTimeout(r, 400));
const afterUndo = await nodeCount();
const componentSurvived = await page.evaluate(
  () => !!globalThis.__engine.getEntity(globalThis.__smokeEntity)?.getComponent("particles"),
);
check("undo after a dropdown does not undo a scene command", componentSurvived);
check("Ctrl+Z removes the added node", afterUndo === before, `${afterAdd} → ${afterUndo}`);

await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await new Promise((r) => setTimeout(r, 400));
const afterRedo = await nodeCount();
check("Ctrl+Shift+Z restores it", afterRedo === afterAdd, `${afterUndo} → ${afterRedo}`);

// --- copy / paste -----------------------------------------------------------

// Select the last-added node with a real click on its header. A synthetic
// MouseEvent without coordinates crashes React Flow's drag handler.
const lastNode = (await page.$$(".react-flow__node")).at(-1);
const nb = await lastNode.boundingBox();
// Aim at the header, but clamp for a zoomed-out graph where the whole node may
// be only a few pixels tall.
await page.mouse.click(nb.x + nb.width / 2, nb.y + Math.min(8, nb.height / 2));
await new Promise((r) => setTimeout(r, 250));
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (const key of ["KeyC", "KeyV"]) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 350));
}
const afterPaste = await nodeCount();
check("Ctrl+C / Ctrl+V duplicates the selection", afterPaste === afterRedo + 1, `${afterRedo} → ${afterPaste}`);

// --- collapse toggle --------------------------------------------------------

const collapsed = await page.evaluate(() => {
  const btn = document.querySelector(".graph-node-collapse");
  if (!btn) return null;
  btn.click();
  return true;
});
await new Promise((r) => setTimeout(r, 300));
const isCollapsed = await page.evaluate(() => !!document.querySelector(".shader-node.collapsed"));
check("collapse button folds a node", collapsed === true && isCollapsed);

// --- scrubbable number field ------------------------------------------------

const scrub = await page.evaluate(() => !!document.querySelector(".gf-number-grip"));
check("nodes render scrubbable number fields", scrub);

if (scrub) {
  const grip = await page.$(".gf-number-grip");
  const g = await grip.boundingBox();
  const readValue = () => page.evaluate(() => document.querySelector(".gf-number-input")?.value ?? null);
  const v0 = await readValue();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(g.x + g.width / 2 + i * 4, g.y + g.height / 2);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const v1 = await readValue();
  check("dragging the grip scrubs the value", v0 !== v1, `${v0} → ${v1}`);
}

// --- reroute via double-click on a wire ------------------------------------

const reroute = await page.evaluate(() => {
  const edge = document.querySelector(".react-flow__edge-interaction, .react-flow__edge-path");
  if (!edge) return "no-edge";
  const r = edge.getBoundingClientRect();
  const opts = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  edge.dispatchEvent(new MouseEvent("dblclick", opts));
  return "sent";
});
await new Promise((r) => setTimeout(r, 400));
const rerouteCount = await page.evaluate(() => document.querySelectorAll(".graph-reroute").length);
check("double-clicking a wire inserts a reroute pin", rerouteCount > 0, `${reroute}, ${rerouteCount} pin(s)`);

// --- committed graph still compiles ----------------------------------------

await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => /Apply/.test(b.textContent ?? ""))?.click();
});
await new Promise((r) => setTimeout(r, 1200));

const graph = await committedGraph();
check("Apply commits a graph to the component", !!graph?.nodes?.length, `${graph?.nodes?.length ?? 0} nodes`);

const compiles = await page.evaluate(async () => {
  const { compileParticleGraph } = await import("/src/engine/particleGraph.js");
  const { stripHelpers } = await import("/src/editor/nodegraph/graphUtils.js");
  const e = globalThis.__engine.getEntity(globalThis.__smokeEntity);
  const g = e?.getComponent("particles")?.props?.graph;
  try {
    const out = await compileParticleGraph(stripHelpers(g));
    return { ok: true, systems: out.systems.length };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
});
check("committed graph (helpers stripped) compiles", compiles.ok, compiles.ok ? `${compiles.systems} system(s)` : compiles.error);

// The helper nodes must SURVIVE in the saved graph — that is what preserves the
// user's comments and reroutes across a reload.
const savedHelpers = (graph?.nodes ?? []).filter((n) => n.type === "__reroute" || n.type === "__frame").length;
check("helper nodes persist in the saved graph", savedHelpers > 0, `${savedHelpers} helper node(s)`);

// --- particles actually simulate -------------------------------------------

const sim = await page.evaluate(() => {
  const e = globalThis.__engine.getEntity(globalThis.__smokeEntity);
  const c = e?.getComponent("particles");
  return { subsystems: c?.subsystems?.length ?? 0 };
});
check("particle component built its subsystems", sim.subsystems > 0, `${sim.subsystems}`);

// --- the shader graph on the same toolkit -----------------------------------
// Dockview stacks the two graph panels as tabs, so only the focused one is
// mounted; select a mesh entity and switch to the Shader Graph tab.

const shader = await page.evaluate(async () => {
  const { useSelectionStore } = await import("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await import("/src/editor/store/sceneStore.js");
  const { commandBus } = await import("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await import("/src/editor/commands/entityCommands.js");
  const { AddComponentCommand } = await import("/src/editor/commands/componentCommands.js");
  const create = new CreateEntityCommand({ name: "SmokeMesh" });
  commandBus.execute(create);
  commandBus.execute(new AddComponentCommand(create.entityId, "mesh"));
  useSceneStore.getState().refresh();
  useSelectionStore.getState().select(create.entityId);
  return { id: String(create.entityId) };
});

await activateTab("Shader Graph");
await new Promise((r) => setTimeout(r, 2000));

const shaderState = await page.evaluate(() => ({
  panelText: (document.querySelector(".shader-graph-panel")?.textContent ?? "").slice(0, 120),
  tabs: [...document.querySelectorAll(".dv-tab, .tab, [role='tab']")].map((t) => t.textContent?.trim()).slice(0, 8),
  nodes: document.querySelectorAll(".graph-node").length,
  preview: !!document.querySelector(".shader-preview canvas"),
  bsdf: [...document.querySelectorAll(".shader-node-label")].some((l) => /Principled/i.test(l.textContent ?? "")),
  // The toolkit's own chrome must be present here too — that is the whole
  // point of both panels sharing one editor.
  undo: !!document.querySelector('[title^="Undo"]'),
  scrub: !!document.querySelector(".gf-number-grip"),
}));
check(
  "shader graph mounts on the shared toolkit",
  shaderState.nodes > 0,
  `${shaderState.nodes} nodes, entity ${shader.id}; tabs=${JSON.stringify(shaderState.tabs)}; panel="${shaderState.panelText}"`,
);
check("shader graph shows the Principled BSDF default", shaderState.bsdf);
check("shader graph keeps its live material preview", shaderState.preview);
check("shader graph gets the toolkit's undo + scrub fields", shaderState.undo && shaderState.scrub);

// --- pressing F re-frames ---------------------------------------------------
// Runs last: it zooms the graph out to a corner on purpose, which would break
// any later hit-testing. Uses REAL wheel events rather than writing
// `style.transform` — React Flow owns that transform, so a hand-written value
// leaves its store untouched and the subsequent fitView is a silent no-op
// (which is exactly what made an earlier version of this check lie).

// Re-select the particle entity: the shader-graph section above selected a mesh
// entity, and the Particles panel renders an "add the component" prompt (with
// no graph canvas at all) for anything that lacks one.
await page.evaluate(async () => {
  const { useSelectionStore } = await import("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().select(globalThis.__smokeEntity);
});
await activateTab("Particles");
const zoomPane = await page.$(".react-flow__pane");
const zb = await zoomPane.boundingBox();
// Click empty canvas first: earlier steps leave focus in a node's text input,
// and the shortcut handler deliberately ignores keys while a field has focus
// (typing "f" into a value box must not re-frame the graph).
await page.mouse.click(zb.x + zb.width / 2, zb.y + zb.height - 12);
await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2);
for (let i = 0; i < 8; i++) await page.mouse.wheel({ deltaY: 120 });
await new Promise((r) => setTimeout(r, 400));

const readZoom = () =>
  page.evaluate(() => {
    const t = getComputedStyle(document.querySelector(".react-flow__viewport")).transform;
    return t === "none" ? 1 : parseFloat(t.split("(")[1]);
  });
const zoomedOut = await readZoom();
await page.keyboard.press("KeyF");
await new Promise((r) => setTimeout(r, 500));
const refit = await readZoom();
check(
  "pressing F re-frames the graph",
  refit > zoomedOut * 1.25,
  `zoom ${zoomedOut.toFixed(3)} → ${refit.toFixed(3)}`,
);

// --- opening a panel always actually shows it -------------------------------
// The reported bug: "I press Open Particle Editor and nothing happens, no
// errors". Activating a panel is a legal no-op whenever the panel cannot be
// painted, so each of those states is reproduced here and must still resolve
// to a visible panel.

/**
 * Opens a panel exactly the way the user does — Window menu → entry. NEVER by
 * importing EditorShell.jsx: that module holds `dockApi` in module scope, and a
 * fresh dynamic import gets a second copy whose `dockApi` is null, so
 * `openPanel` would silently queue instead of opening anything.
 */
async function openPanelViaMenu(label) {
  await page.evaluate(() => {
    [...document.querySelectorAll("button, .menu-bar-item")].find((b) => b.textContent?.trim() === "Window")?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate((name) => {
    [...document.querySelectorAll("button, .dropdown-item")].find((b) => b.textContent?.trim() === name)?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 1000));
}

const panelState = (id) =>
  page.evaluate((panelId) => {
    const panel = globalThis.__dockApi?.getPanel(panelId);
    if (!panel) return { found: false };
    const box = panel.group?.api?.boundingBox;
    return {
      found: true,
      active: !!panel.api.isActive,
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
      maximizedElsewhere: !!globalThis.__dockApi?.hasMaximizedGroup(),
    };
  }, id);

const hasDock = await page.evaluate(() => !!globalThis.__dockApi);
check("dock api exposed for layout diagnostics", hasDock);

if (hasDock) {
  // (1) Close the panel, then reopen it from the menu.
  await page.evaluate(() => globalThis.__dockApi.getPanel("particles")?.api.close());
  await new Promise((r) => setTimeout(r, 500));
  await openPanelViaMenu("Particles");
  const reopened = await panelState("particles");
  check("a closed panel reopens from the Window menu", reopened.found && reopened.active, JSON.stringify(reopened));

  // (2) Maximize a DIFFERENT group first. Dockview hides every other group
  //     while one is maximized, so plain `setActive()` leaves the panel active
  //     but unpainted — precisely the reported "nothing happens, no errors".
  await page.evaluate(() => {
    const api = globalThis.__dockApi;
    const viewport = api.getPanel("viewport");
    if (viewport) api.maximizeGroup(viewport);
  });
  await new Promise((r) => setTimeout(r, 600));
  const wasMaximized = await page.evaluate(() => !!globalThis.__dockApi.hasMaximizedGroup());
  await openPanelViaMenu("Particles");
  const afterMax = await panelState("particles");
  check(
    "opening a panel escapes another group's maximized state",
    wasMaximized && !afterMax.maximizedElsewhere && afterMax.width > 40 && afterMax.height > 40,
    `maximized before=${wasMaximized}; after=${JSON.stringify(afterMax)}`,
  );

  // (3) Shrink the group as far as dockview allows (a splitter dragged shut,
  //     or a saved layout restored that way), then open the panel. Dockview
  //     clamps to its own minimum, so this cannot always reach a true zero —
  //     the assertion is simply that opening leaves a usable panel either way.
  await page.evaluate(() => {
    globalThis.__dockApi.getPanel("particles")?.group?.api?.setSize({ height: 0 });
  });
  await new Promise((r) => setTimeout(r, 500));
  const squashed = await panelState("particles");
  await openPanelViaMenu("Particles");
  const afterSquash = await panelState("particles");
  check(
    "opening a shrunken panel leaves it usable",
    afterSquash.height > 40 && afterSquash.width > 40,
    `${squashed.width}x${squashed.height} → ${afterSquash.width}x${afterSquash.height}`,
  );
}

// --- report -----------------------------------------------------------------

const gpuErrors = errors.filter((e) => /storage buffers|validation|WebGPU|exceeds the maximum/i.test(e));
check("no WebGPU validation errors", gpuErrors.length === 0, gpuErrors[0] ?? "");

const failed = results.filter((r) => !r.ok);
console.log(`\nNG-SMOKE ${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length}`);
if (errors.length) {
  console.log("\nconsole errors:");
  for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
}

await browser.close();
process.exit(failed.length ? 1 : 0);
