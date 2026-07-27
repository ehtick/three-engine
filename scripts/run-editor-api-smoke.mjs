// Editor API smoke test: proves the `"editor"` scripting surface and the op
// registry behind it actually work against a live editor.
//
//   npx vite --port 5204
//   node scripts/run-editor-api-smoke.mjs [url]
//
// HEADLESS=1 to hide the window (see the caveat below).
//
// What it covers, and why each part is here rather than a unit test:
//
//   - Registry shape + validation. Cheap to check, and it is the contract a
//     future MCP server reads: dot-free tool names, JSON Schemas, and errors
//     that name the bad parameter instead of throwing from three layers down.
//   - Ops actually mutating the editor THROUGH the command bus. The failure
//     this catches is an op that pokes `engine.*` directly: the scene changes,
//     everything looks right, and Ctrl+Z does nothing. Only an end-to-end
//     undo assertion catches it.
//   - `@executeInEditMode` running while STOPPED, and `onUpdate` NOT running.
//     The whole feature is about which hooks fire in which play state, so it
//     can only be tested against a real ScriptComponent on a real engine.
//   - `@menuItem` reaching the menu registry, including hot-reload dedup.
//   - `onDrawGizmos` filling the batched line buffer.
//
// RUNS HEADED by default, for the same reason as run-multiscript-smoke.mjs:
// headless Chrome exposes no WebGPU adapter here, so `engine.init()` produces
// no renderer and `Engine.start()` never drives the frame loop — every
// tick-based assertion would fail while onStart-based ones passed, which reads
// exactly like a product bug and is not one.
//
// START THE DEV SERVER FRESH — see the `?t=` trap in run-nodegraph-smoke.mjs.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5204/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADLESS ? "new" : false,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error" && !/Script "/.test(text)) errors.push(text);
  if (/API-SMOKE/.test(text)) console.log(text);
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

const out = await page.evaluate(async () => {
  /** Imports the module instance the APP is using — see run-multiscript-smoke. */
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
  if (!engine.renderer) {
    return { fatal: "engine has no renderer — the editor never initialized the viewport" };
  }

  const Editor = globalThis.__editorApi;
  if (!Editor) return { fatal: "installEditorApi() never ran — globalThis.__editorApi is missing" };

  const { setScriptLoader } = await importLive("/src/engine/assetResolver.js");
  const { linkEngineImports, resolveRuntimeUrls } = await importLive("/src/engine/scriptRuntime.js");
  const { transpileScript } = await importLive("/src/editor/assetLoader.js");
  const bridge = await importLive("/src/engine/editorBridge.js");

  const settle = (ms = 260) => new Promise((r) => setTimeout(r, ms));
  const report = {};

  // === 1. registry shape ===================================================
  const ops = Editor.ops();
  report.registry = {
    count: ops.length,
    allDescribed: ops.every((op) => typeof op.description === "string" && op.description.length > 10),
    hasEntityCreate: ops.some((op) => op.name === "entity.create"),
    hasReadOnlyFlags: ops.some((op) => op.readOnly) && ops.some((op) => !op.readOnly),
  };

  const tools = Editor.tools();
  const readOnlyTools = Editor.tools({ readOnly: true });
  report.tools = {
    count: tools.length,
    // MCP tool names may not contain dots.
    noDots: tools.every((tool) => !tool.name.includes(".")),
    schemaShape: tools.every(
      (tool) => tool.inputSchema?.type === "object" && typeof tool.inputSchema.properties === "object",
    ),
    requiredDeclared:
      tools.find((t) => t.name === "entity.get".replaceAll(".", "_"))?.inputSchema?.required?.includes("id") === true,
    readOnlySubsetSmaller: readOnlyTools.length > 0 && readOnlyTools.length < tools.length,
    roundTripsToOpName: Editor.resolveToolName("entity_create") === "entity.create",
  };

  // === 2. argument validation ==============================================
  const failure = async (fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return String(err.message ?? err);
    }
  };
  report.validation = {
    unknownParam: await failure(() => Editor.call("entity.get", { nope: 1 })),
    missingRequired: await failure(() => Editor.call("entity.get", {})),
    wrongType: await failure(() => Editor.call("entity.rename", { id: "x", name: 42 })),
    unknownOp: await failure(() => Editor.call("nope.nope", {})),
  };
  // callTool must RESOLVE with an error rather than throw — a transport needs
  // a value it can serialize, and an editor that keeps running.
  const toolError = await Editor.callTool("entity_get", {});
  report.callToolShape = { ok: toolError.ok, hasError: typeof toolError.error === "string" };

  // === 3. entities + components, through the command bus ===================
  const created = Editor.entities.create({ name: "ApiProbe", transform: { position: [1, 2, 3] } });
  report.create = {
    named: created.name === "ApiProbe",
    positioned: JSON.stringify(created.transform.position) === "[1,2,3]",
    listed: Editor.entities.all({ nameContains: "apiprobe" }).length === 1,
    liveEntityExists: !!Editor.entities.live(created.id),
  };

  Editor.components.add(created.id, "mesh", { geometry: "box" });
  const withMesh = Editor.entities.get(created.id);
  Editor.components.setProp(created.id, "mesh", "geometry", "sphere");
  const afterProp = Editor.entities.get(created.id);
  report.components = {
    added: withMesh.components.some((c) => c.type === "mesh"),
    propSet: afterProp.components.find((c) => c.type === "mesh")?.props.geometry === "sphere",
    typesListed: Editor.components.types().length > 5,
    duplicateRejected: await failure(() => Editor.call("component.add", { id: created.id, type: "mesh" })),
    unknownTypeRejected: await failure(() =>
      Editor.call("component.add", { id: created.id, type: "not-a-thing" }),
    ),
  };

  // The load-bearing assertion: an op-driven edit must be undoable, which it
  // only is if the op went through the command bus.
  Editor.history.undo(); // undo the setProp
  const undoneProp = Editor.entities.get(created.id).components.find((c) => c.type === "mesh")?.props.geometry;
  Editor.history.undo(); // undo the component.add
  const undoneAdd = Editor.entities.get(created.id).components.some((c) => c.type === "mesh");
  Editor.history.undo(); // undo the entity.create
  report.undo = {
    propReverted: undoneProp === "box",
    componentReverted: undoneAdd === false,
    entityGone: !Editor.entities.live(created.id),
    labelsExposed: typeof Editor.history.get().redoLabel === "string",
  };
  Editor.history.redo();
  report.redoRestores = !!Editor.entities.live(created.id);
  Editor.entities.delete(created.id);

  // === 4. selection ========================================================
  const a = Editor.entities.create({ name: "SelA" });
  const b = Editor.entities.create({ name: "SelB" });
  Editor.selection.set([a.id, b.id]);
  report.selection = {
    ids: Editor.selection.ids.length === 2,
    liveEntities: Editor.selection.entities.every((entity) => typeof entity.object3D === "object"),
    // A stale id must be dropped, not stored.
    filtersStale: (Editor.selection.set([a.id, "does-not-exist"]), Editor.selection.ids.length === 1),
  };
  Editor.selection.clear();

  // === 5. the "editor" specifier resolves for scripts ======================
  const runtimeUrls = await resolveRuntimeUrls();
  report.specifierResolves = typeof runtimeUrls.editor === "string" && runtimeUrls.editor.length > 0;
  const linked = await linkEngineImports(`import { Editor } from "editor";\n`);
  report.specifierRewritten = !linked.includes('"editor"') && linked.includes(runtimeUrls.editor ?? "###");

  // === 6. edit-mode scripts, menu items, gizmos ============================
  globalThis.__TRACE__ = [];
  const FILES = {
    "EditTool.ts": `
      import { Script } from "engine";
      import { executeInEditMode, menuItem, Editor } from "editor";
      @executeInEditMode
      export default class EditTool extends Script {
        onStart() { globalThis.__TRACE__.push("EditTool:start"); }
        onEditorUpdate(dt) { globalThis.__TRACE__.push("EditTool:editorUpdate"); }
        onUpdate(dt) { globalThis.__TRACE__.push("EditTool:update"); }
        onDrawGizmos(g) {
          globalThis.__TRACE__.push("EditTool:gizmos");
          g.color("#ff0000").sphere(this.entity.position, 1);
        }
        @menuItem("Tools/Api Smoke Probe")
        probe() { globalThis.__TRACE__.push("EditTool:menu:" + Editor.version); }
      }`,
    "PlayOnly.ts": `
      import { Script } from "engine";
      export default class PlayOnly extends Script {
        onStart() { globalThis.__TRACE__.push("PlayOnly:start"); }
        onEditorUpdate() { globalThis.__TRACE__.push("PlayOnly:editorUpdate"); }
      }`,
  };
  // `version` is bumped per load so the component's mtime check re-imports —
  // that is how the hot-reload dedup assertion below gets a second load.
  let version = 1;
  const load = async (path) => {
    const source = FILES[path];
    if (!source) throw new Error(`no such fake script: ${path}`);
    const code = await linkEngineImports(await transpileScript(source));
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      return { version: version, default: mod.default ?? null };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  };
  setScriptLoader(load);
  // Prime esbuild-wasm before anything asserts on timing.
  await load("EditTool.ts");

  const trace = () => globalThis.__TRACE__.splice(0);
  const host = engine.createEntity({ name: "ApiToolHost" });
  host.addComponent("script", {
    scripts: [
      { path: "EditTool.ts", enabled: true, attributes: {} },
      { path: "PlayOnly.ts", enabled: true, attributes: {} },
    ],
  });
  await settle(700);
  const editTrace = trace();
  report.editMode = {
    // Engine is STOPPED here.
    playing: !!engine.playing,
    started: editTrace.includes("EditTool:start"),
    editorTicks: editTrace.filter((t) => t === "EditTool:editorUpdate").length,
    // The negative half: a normal script must stay completely inert.
    plainScriptInert:
      !editTrace.includes("PlayOnly:start") && !editTrace.includes("PlayOnly:editorUpdate"),
    // onUpdate must NOT fire in edit mode even for an edit-mode script.
    noGameplayUpdate: !editTrace.includes("EditTool:update"),
  };

  // Menu registration, and the hot-reload dedup that keeps Tools from growing
  // an entry every 0.75-second poll.
  const menuBefore = bridge.listMenuItems().filter((m) => m.label === "Api Smoke Probe");
  version = 2; // force a reload on the next poll
  await settle(1400);
  const menuAfter = bridge.listMenuItems().filter((m) => m.label === "Api Smoke Probe");
  trace();
  menuAfter[0]?.run?.();
  report.menu = {
    registered: menuBefore.length === 1,
    underTools: menuBefore[0]?.menu === "Tools",
    noDuplicatesAfterReload: menuAfter.length === 1,
    invokesMethod: trace().some((t) => t.startsWith("EditTool:menu:")),
    apiAddWorks: (() => {
      const off = Editor.menu.add("Tools/Ad Hoc", () => {});
      const present = bridge.listMenuItems().some((m) => m.label === "Ad Hoc");
      off();
      return present && !bridge.listMenuItems().some((m) => m.label === "Ad Hoc");
    })(),
  };

  // Gizmos: the pass runs on preRender, so a settle is enough.
  trace();
  await settle(400);
  const gizmoMesh = engine.scene.getObjectByName("__scriptGizmos");
  report.gizmos = {
    hookCalled: trace().includes("EditTool:gizmos"),
    meshExists: !!gizmoMesh,
    // Three great circles at 32 segments = 192 vertices.
    verticesDrawn: gizmoMesh?.geometry?.drawRange?.count ?? 0,
    onEditorLayer: gizmoMesh?.layers?.mask !== undefined,
  };

  // Detaching must retire the script's menu entries.
  host.removeComponent("script");
  await settle();
  report.menuCleanedUp = !bridge.listMenuItems().some((m) => m.label === "Api Smoke Probe");
  engine.destroyEntity(host);
  for (const id of [a.id, b.id]) {
    const entity = engine.getEntity(id);
    if (entity) engine.destroyEntity(entity);
  }

  // === 7. scene / project / play read-only ops =============================
  report.readers = {
    scene: typeof Editor.scene.get().name === "string",
    project: "rootPath" in Editor.project.get(),
    play: Editor.play.isPlaying === false,
    historyShape: typeof Editor.history.get().canUndo === "boolean",
  };

  return report;
});

if (out.fatal) {
  console.log(` FAIL  ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

// --- registry / MCP shape ----------------------------------------------------
check("ops are registered", out.registry.count > 15, `${out.registry.count} ops`);
check("every op carries a real description", out.registry.allDescribed === true);
check("entity.create is registered", out.registry.hasEntityCreate === true);
check("ops declare readOnly", out.registry.hasReadOnlyFlags === true);
check("tool manifest is produced", out.tools.count === out.registry.count);
check("MCP tool names contain no dots", out.tools.noDots === true);
check("tools carry JSON Schema input schemas", out.tools.schemaShape === true);
check("required params are declared in the schema", out.tools.requiredDeclared === true);
check("readOnly filter yields a smaller subset", out.tools.readOnlySubsetSmaller === true);
check("tool names resolve back to op names", out.tools.roundTripsToOpName === true);

// --- validation --------------------------------------------------------------
check("an unknown parameter is rejected", /unknown parameter/i.test(out.validation.unknownParam ?? ""), out.validation.unknownParam);
check("a missing required parameter is rejected", /required/i.test(out.validation.missingRequired ?? ""), out.validation.missingRequired);
check("a wrong-typed parameter is rejected", /must be a string/i.test(out.validation.wrongType ?? ""), out.validation.wrongType);
check("an unknown op names the registered ones", /Registered:/.test(out.validation.unknownOp ?? ""), out.validation.unknownOp);
check("callTool resolves with an error instead of throwing", out.callToolShape.ok === false && out.callToolShape.hasError);

// --- entities / components ---------------------------------------------------
check("entity.create names the entity", out.create.named === true);
check("entity.create applies the transform", out.create.positioned === true);
check("entity.list finds it by name", out.create.listed === true);
check("entities.live returns the runtime Entity", out.create.liveEntityExists === true);
check("component.add attaches", out.components.added === true);
check("component.setProp writes", out.components.propSet === true);
check("component.types enumerates the registry", out.components.typesListed === true);
check("adding a duplicate component is rejected", /already has/i.test(out.components.duplicateRejected ?? ""), out.components.duplicateRejected);
check("an unknown component type is rejected", /Unknown component type/i.test(out.components.unknownTypeRejected ?? ""), out.components.unknownTypeRejected);

// --- undo (proves ops go through the command bus) ----------------------------
check("undo reverts an op-driven prop change", out.undo.propReverted === true);
check("undo reverts an op-driven component add", out.undo.componentReverted === true);
check("undo reverts an op-driven entity create", out.undo.entityGone === true);
check("history exposes its labels", out.undo.labelsExposed === true);
check("redo restores it", out.redoRestores === true);

// --- selection ---------------------------------------------------------------
check("selection.set / .ids round-trip", out.selection.ids === true);
check("selection.entities returns live entities", out.selection.liveEntities === true);
check("selection drops ids that no longer exist", out.selection.filtersStale === true);

// --- the "editor" specifier --------------------------------------------------
check('scripts can resolve the "editor" specifier', out.specifierResolves === true);
check('"editor" is rewritten to the proxy URL', out.specifierRewritten === true);

// --- edit mode ---------------------------------------------------------------
check("the engine is stopped for the edit-mode checks", out.editMode.playing === false);
check("@executeInEditMode gets onStart while stopped", out.editMode.started === true);
check("...and onEditorUpdate ticks", out.editMode.editorTicks > 0, `${out.editMode.editorTicks} ticks`);
check("...but NOT onUpdate", out.editMode.noGameplayUpdate === true);
check("a plain script stays inert while stopped", out.editMode.plainScriptInert === true);

// --- menu items --------------------------------------------------------------
check("@menuItem registers an entry", out.menu.registered === true);
check("...under the Tools menu", out.menu.underTools === true);
check("a hot reload does not duplicate it", out.menu.noDuplicatesAfterReload === true);
check("running the entry calls the method", out.menu.invokesMethod === true);
check("Editor.menu.add / unregister works", out.menu.apiAddWorks === true);
check("detaching the component retires its entries", out.menuCleanedUp === true);

// --- gizmos ------------------------------------------------------------------
check("onDrawGizmos is called while stopped", out.gizmos.hookCalled === true);
check("the batched gizmo mesh exists", out.gizmos.meshExists === true);
check("gizmo vertices reach the buffer", out.gizmos.verticesDrawn >= 192, `${out.gizmos.verticesDrawn} vertices`);

// --- read-only ops -----------------------------------------------------------
check("scene.get reads the open scene", out.readers.scene === true);
check("project.get reads the open project", out.readers.project === true);
check("play.get reports stopped", out.readers.play === true);
check("history.get reports availability", out.readers.historyShape === true);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nAPI-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
