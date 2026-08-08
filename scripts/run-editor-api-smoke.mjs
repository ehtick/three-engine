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

  // === 8. sight: screenshot, camera, bounds, console =======================
  //
  // The renderer is live here (this harness runs headed on purpose), so these
  // exercise the real capture path rather than a stub.
  const probe = Editor.entities.create({
    name: "SightProbe",
    transform: { position: [0, 0, 0], scale: [2, 2, 2] },
    components: [{ type: "mesh", props: { geometry: "box" } }],
  });
  await settle(600);

  const resolvedBounds = await Editor.call("entity.getBounds", { id: probe.id });
  report.bounds = {
    empty: resolvedBounds?.empty,
    // A unit box scaled 2x spans roughly -1..1 per axis; assert the order of
    // magnitude, not an exact number, since the extent depends on the geometry
    // the mesh component builds.
    plausibleSize: Array.isArray(resolvedBounds?.size) && resolvedBounds.size.every((v) => v > 0.5 && v < 12),
    hasCenter: Array.isArray(resolvedBounds?.center),
  };

  const camBefore = Editor.viewport.getCamera();
  await Editor.call("viewport.focus", { id: probe.id });
  const framed = Editor.viewport.getCamera();
  report.focus = {
    moved: JSON.stringify(camBefore.position) !== JSON.stringify(framed.position),
    targetsProbe: framed.target.every((v) => Math.abs(v) < 0.5),
  };

  await Editor.call("viewport.setCamera", { position: [6, 5, 6], target: [0, 0, 0] });
  const aimed = Editor.viewport.getCamera();
  report.setCamera = { applied: aimed.position.map((v) => Math.round(v)).join(",") === "6,5,6" };

  // An agent watching something run unattended needs to be able to stop the
  // viewport pausing itself — nothing is ever "focused" in a headless session,
  // and pausing is now the default. Assert the round trip rather than a
  // starting value: the setting is a persisted per-machine preference, so
  // whatever it happens to be when the harness attaches is not a bug.
  const freezeBefore = Editor.viewport.freezeWhenUnfocused().enabled;
  const freezeOff = Editor.viewport.freezeWhenUnfocused(false);
  const freezeReadBack = Editor.viewport.freezeWhenUnfocused().enabled;
  const freezeOn = Editor.viewport.freezeWhenUnfocused(true);
  report.freeze = {
    turnsOff: freezeOff.enabled === false,
    turnsOn: freezeOn.enabled === true,
    // Reading without an argument must not change it.
    readOnly: freezeReadBack === false,
  };
  // Leave the user's preference as it was found.
  Editor.viewport.freezeWhenUnfocused(freezeBefore);

  const shot = await Editor.viewport.screenshot({ width: 200, height: 120 });
  const decoded = shot.__image?.base64 ? atob(shot.__image.base64) : "";
  report.screenshot = {
    hasImage: !!shot.__image?.base64,
    mime: shot.__image?.mimeType,
    size: `${shot.width}x${shot.height}`,
    // A PNG opens with a fixed 8-byte signature; anything else means we
    // captured something that is not an image.
    isPng: decoded.slice(1, 4) === "PNG",
    bytes: decoded.length,
  };

  /** Decodes a PNG data URL back to raw pixels so we can inspect the frame. */
  const decodePng = async (base64) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
  };

  /** How many distinct colours a row contains — 1 means a clean flat band. */
  const rowColours = ({ w, data }, y) => {
    const seen = new Set();
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return seen.size;
  };

  const frame = await decodePng(shot.__image.base64);
  const allColours = new Set();
  for (let i = 0; i < frame.data.length; i += 4) {
    allColours.add(`${frame.data[i]},${frame.data[i + 1]},${frame.data[i + 2]}`);
    if (allColours.size > 8) break;
  }
  // A lit box in front of the camera must not render as one flat colour —
  // that is what an empty or failed capture looks like.
  report.screenshotHasContent = allColours.size;

  // WebGPU pads each readback row to a 256-byte boundary. If that padding is
  // not stripped, the image is still a valid PNG of the right size with plenty
  // of colours — it is just progressively sheared, and the error grows with
  // each row. So check the LAST row: at 200px wide the padding is 224 bytes per
  // row, and by row 119 a tight read would be ~26k bytes adrift, dragging the
  // box into a band that should be pure background.
  //
  // 200 is chosen deliberately: 200*4 = 800 bytes, which pads to 1024. A width
  // that happened to be a multiple of 64 would need no padding and the test
  // would prove nothing.
  report.screenshotBands = {
    width: frame.w,
    padded: (frame.w * 4) % 256 !== 0,
    firstRowColours: rowColours(frame, 0),
    lastRowColours: rowColours(frame, frame.h - 1),
    midRowColours: rowColours(frame, Math.floor(frame.h / 2)),
  };

  globalThis.console.error("api-smoke console probe");
  await settle(200);
  const logs = Editor.console.read({ level: "error", limit: 30 });
  report.consoleRead = {
    isArray: Array.isArray(logs),
    sawProbe: logs.some((entry) => /api-smoke console probe/.test(entry.message ?? "")),
    shaped: logs.every((entry) => typeof entry.level === "string" && typeof entry.time === "string"),
  };

  Editor.entities.delete(probe.id);

  // === 9. batch: many ops, one undo step ===================================
  const undoBefore = Editor.history.get();
  const batch = await Editor.batch("Build test rig", [
    { op: "entity.create", args: { name: "BatchRoot" } },
    { op: "entity.create", args: { name: "BatchChild", parentId: "$0" } },
    { op: "component.add", args: { id: "$0", type: "mesh", props: { geometry: "box" } } },
  ]);
  const rootId = batch.results[0]?.id;
  report.batch = {
    ran: batch.ran,
    noFailure: batch.failure === null,
    collapsed: batch.undoSteps,
    // "$0" must resolve to the id step 0 created, and the child must really be
    // parented to it — that reference is the whole point of the op.
    refResolved: Editor.entities.get(batch.results[1]?.id)?.parentId === rootId,
    componentAttached: Editor.entities.get(rootId)?.components.some((c) => c.type === "mesh"),
    label: Editor.history.get().undoLabel,
  };

  Editor.history.undo();
  report.batchUndo = {
    rootGone: !Editor.entities.live(rootId),
    childGone: !Editor.entities.live(batch.results[1]?.id),
    backToStart: Editor.history.get().undoLabel === undoBefore.undoLabel,
  };

  const failing = await Editor.batch("Half-broken", [
    { op: "entity.create", args: { name: "BatchOk" } },
    { op: "entity.create", args: { name: "BatchBad", parentId: "nope-not-an-id" } },
    { op: "entity.create", args: { name: "BatchNeverRuns" } },
  ]);
  report.batchFailure = {
    reported: failing.failure?.step === 1,
    stopped: failing.ran === 2,
    namesTheOp: failing.failure?.op === "entity.create",
  };
  Editor.history.undo();
  report.batchPartialUndone = Editor.entities.all({ nameContains: "BatchOk" }).length === 0;


  // === 7. scene / project / play read-only ops =============================
  report.readers = {
    scene: typeof Editor.scene.get().name === "string",
    project: "rootPath" in Editor.project.get(),
    play: Editor.play.isPlaying === false,
    historyShape: typeof Editor.history.get().canUndo === "boolean",
  };

  // === 8. audio ops ========================================================
  // Only the parts that need no filesystem. This smoke runs plain Chrome with
  // no Tauri, so the file-writing audio ops (edit/addTrack/setTrack/…) cannot
  // run here — their behavioural coverage lives in `npm run smoke:audio`,
  // which boots the same editor behind the Tauri shim and a real scratch
  // project. What's checked here is the half that is genuinely this smoke's
  // business: that the ops are registered and that their module gate refuses
  // rather than half-working.
  const audioOps = ops.filter((op) => op.name.startsWith("audio."));
  let gateError = null;
  await Editor.audio.search("footstep").catch((err) => { gateError = err.message; });
  const modulesStore = await importLive("/src/editor/modules.js");
  report.audio = {
    registered: audioOps.length,
    coversLibraryAndEditor:
      audioOps.some((op) => op.name.startsWith("audio.library.")) &&
      ["audio.info", "audio.tracks", "audio.edit", "audio.addTrack", "audio.setTrack", "audio.removeTrack"]
        .every((name) => audioOps.some((op) => op.name === name)),
    readsAreFlaggedReadOnly:
      audioOps.filter((op) => op.readOnly).length >= 4 && audioOps.some((op) => !op.readOnly),
    statusReadable: typeof (await Editor.audio.status()).moduleEnabled === "boolean",
    searchRefusedWhileOff:
      modulesStore.useModulesStore.getState().enabled.includes("audio-library") || /not enabled/i.test(gateError ?? ""),
  };

  return report;
});

if (out.fatal) {
  console.log(` FAIL  ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

// --- registry / MCP shape ----------------------------------------------------
// --- audio ops (registration + gating; behaviour lives in smoke:audio) -------
check("audio ops are registered", out.audio.registered >= 10, `${out.audio.registered} ops`);
check("…covering both the library and the editor", out.audio.coversLibraryAndEditor === true);
check("…with reads flagged readOnly and writes not", out.audio.readsAreFlaggedReadOnly === true);
check("audio.library.status is readable", out.audio.statusReadable === true);
check("searching through a disabled library module is refused", out.audio.searchRefusedWhileOff === true);

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

// --- sight -------------------------------------------------------------------
check("entity.getBounds returns real extents", out.bounds.empty === false && out.bounds.plausibleSize && out.bounds.hasCenter, JSON.stringify(out.bounds));
check("viewport.focus moves the camera", out.focus.moved === true);
check("…and centres on the entity", out.focus.targetsProbe === true);
check("viewport.setCamera applies exactly", out.setCamera.applied === true);
check("an agent can turn viewport freezing off and back on", out.freeze.turnsOff === true && out.freeze.turnsOn === true, JSON.stringify(out.freeze));
check("…while reading it alone changes nothing", out.freeze.readOnly === true);
check("viewport.screenshot returns an image", out.screenshot.hasImage === true, `${out.screenshot.mime} ${out.screenshot.size}`);
check("…that is really a PNG", out.screenshot.isPng === true, `${out.screenshot.bytes} bytes`);
check("…at the requested size", out.screenshot.size === "200x120");
check("…with scene content, not a flat fill", out.screenshotHasContent >= 2, `${out.screenshotHasContent} distinct colours (background + the probe box)`);
check(
  "…at a width whose rows DO need unpadding (or the next check is vacuous)",
  out.screenshotBands.padded === true,
  `${out.screenshotBands.width}px`,
);
check(
  "…and is not sheared by WebGPU row padding",
  // Top and bottom bands are empty background; the middle holds the box.
  out.screenshotBands.firstRowColours <= 2 &&
    out.screenshotBands.lastRowColours <= 2 &&
    out.screenshotBands.midRowColours >= 2,
  JSON.stringify(out.screenshotBands),
);
check("console.read returns shaped entries", out.consoleRead.isArray && out.consoleRead.shaped);
check("…including errors the editor just logged", out.consoleRead.sawProbe === true);

// --- batch -------------------------------------------------------------------
check("batch runs every step", out.batch.ran === 3 && out.batch.noFailure, JSON.stringify(out.batch));
check("…collapsing them into ONE undo entry", out.batch.collapsed === 3);
check("…labelled for the user", out.batch.label === "Build test rig", out.batch.label);
check("$N references resolve to earlier steps' ids", out.batch.refResolved === true);
check("…so components land on the referenced entity", out.batch.componentAttached === true);
check("one undo removes the whole batch", out.batchUndo.rootGone && out.batchUndo.childGone, JSON.stringify(out.batchUndo));
check("…leaving history where it started", out.batchUndo.backToStart === true);
check("a failing step is reported with its index", out.batchFailure.reported === true);
check("…stops the rest by default", out.batchFailure.stopped === true);
check("…and names the op that failed", out.batchFailure.namesTheOp === true);
check("a partial batch is still undone in one step", out.batchPartialUndone === true);

// --- read-only ops -----------------------------------------------------------
check("scene.get reads the open scene", out.readers.scene === true);
check("project.get reads the open project", out.readers.project === true);
check("play.get reports stopped", out.readers.play === true);
check("history.get reports availability", out.readers.historyShape === true);

// ---------------------------------------------------------------------------
// "api-smoke console probe" is logged BY this harness, on purpose, to prove
// console.read sees editor errors. Counting our own bait as a failure would
// make the suite permanently red.
const hard = errors.filter(
  (e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource|api-smoke console probe/i.test(e),
);
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
