// Multi-script smoke test: proves an entity can carry several scripts and that
// they all actually run, in order, independently toggleable, with hooks reaching
// every one of them.
//
//   npx vite --port 5204
//   node scripts/run-multiscript-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// The harness installs its own `setScriptLoader`, so it needs no Tauri and no
// files on disk — script source is a string, compiled to a blob module. That
// keeps the test on the part that changed (ScriptComponent's slot list,
// dispatch, ordering, attributes, error containment, and the legacy props
// migration) rather than on the editor's file plumbing.
//
// The regression that motivated all of this: physics used to dispatch
// collisions via `getComponent("script")?.instance?.[hook]`, which silently
// delivered them to whichever script happened to be first. See the DISPATCH
// checks.
//
// RUNS HEADED, on purpose. Headless Chrome exposes no WebGPU adapter here, so
// `engine.init()` never produces a renderer — and `Engine.start()` drives the
// frame loop through `renderer.setAnimationLoop`, so with no renderer there are
// no `onUpdate` callbacks at all. Every tick-based assertion below would then
// fail while onStart-based ones passed, which reads exactly like a product bug
// and is not one. Verified: headless gives `renderer: null`, `ticks: 0`.
// HEADLESS=1 forces the old behaviour if you only care about the non-tick checks.
//
// START THE DEV SERVER FRESH — see run-nodegraph-smoke.mjs for the `?t=` trap.
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
  // Script throws are EXPECTED here (the containment checks cause them) and are
  // logged via console.error by design — don't count those as harness failures.
  if (m.type() === "error" && !/Script "/.test(text)) errors.push(text);
  if (/MULTI-SMOKE/.test(text)) console.log(text);
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
  /**
   * Imports the SAME module instance the app is using.
   *
   * Vite serves a module the app has touched since server start under
   * `…/foo.js?t=<mtime>`. A harness importing the bare `…/foo.js` then gets a
   * SECOND evaluation of that module — and for `engineInstance.js` that means a
   * second Engine singleton: `ensureEngine()` hands back a fresh engine with no
   * renderer, so `Engine.start()` was never called on it and NOTHING ticks.
   * The symptom is that `onStart` works (it rides a synchronous event) while
   * every `onUpdate` assertion fails, which reads exactly like a product bug.
   *
   * Restarting Vite usually hides this, but not reliably. Reading the URL the
   * browser actually fetched removes the whole failure mode.
   */
  const importLive = (path) => {
    const prefix = location.origin + path;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    // Prefer a query-suffixed URL — that's the one the app's graph resolved to.
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? path);
  };

  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!engine.renderer) {
    return { fatal: "engine has no renderer — the editor never initialized the viewport" };
  }
  const { setScriptLoader } = await importLive("/src/engine/assetResolver.js");
  const { linkEngineImports } = await importLive("/src/engine/scriptRuntime.js");
  const { transpileScript } = await importLive("/src/editor/assetLoader.js");

  // A trace every script appends to, so ordering and reach are observable.
  globalThis.__TRACE__ = [];

  // --- fake project: path -> source ----------------------------------------
  const FILES = {
    "Alpha.ts": `
      import { Script, attribute } from "engine";
      export default class Alpha extends Script {
        @attribute({ type: "number", default: 1 }) gain = 1;
        onStart() { globalThis.__TRACE__.push("Alpha:start"); }
        onUpdate() { globalThis.__TRACE__.push("Alpha:update:" + this.gain); }
        onCollisionEnter(other) { globalThis.__TRACE__.push("Alpha:hit:" + other.name); }
        onDestroy() { globalThis.__TRACE__.push("Alpha:destroy"); }
        greet() { return "alpha-" + this.gain; }
      }`,
    "Beta.ts": `
      import { Script, attribute } from "engine";
      export default class Beta extends Script {
        @attribute({ type: "text", default: "b" }) tag = "b";
        onStart() { globalThis.__TRACE__.push("Beta:start"); }
        onUpdate() { globalThis.__TRACE__.push("Beta:update:" + this.tag); }
        onCollisionEnter(other) { globalThis.__TRACE__.push("Beta:hit:" + other.name); }
        onDestroy() { globalThis.__TRACE__.push("Beta:destroy"); }
      }`,
    "Boom.ts": `
      import { Script } from "engine";
      export default class Boom extends Script {
        onUpdate() { globalThis.__TRACE__.push("Boom:update"); throw new Error("boom"); }
      }`,
  };

  const moduleCache = new Map();
  const load = async (path) => {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const source = FILES[path];
    if (!source) throw new Error(`no such fake script: ${path}`);
    const code = await linkEngineImports(await transpileScript(source));
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      const entry = { version: 1, default: mod.default ?? null };
      moduleCache.set(path, entry);
      return entry;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  };
  setScriptLoader(load);

  // Prime every module BEFORE any entity exists. The first transpileScript call
  // boots esbuild-wasm, which takes seconds — without priming, the assertions
  // near the top of this file run against slots whose import is still in
  // flight, and the whole harness reports false failures.
  await Promise.all(Object.keys(FILES).map((path) => load(path)));

  const slot = (path, extra = {}) => ({ path, enabled: true, attributes: {}, ...extra });
  const settle = () => new Promise((r) => setTimeout(r, 260));
  const trace = () => globalThis.__TRACE__.splice(0);
  const report = {};

  // === 1. legacy props migration ==========================================
  const legacy = engine.createEntity({ name: "Legacy" });
  const legacyComp = legacy.addComponent("script", { path: "Alpha.ts", attributes: { gain: 7 } });
  await settle();
  report.migration = {
    scripts: JSON.parse(JSON.stringify(legacyComp.props.scripts ?? null)),
    droppedLegacyKeys: !("path" in legacyComp.props) && !("attributes" in legacyComp.props),
    instanceGain: legacyComp.instance?.gain ?? null,
  };

  // Migration must not fabricate a slot for a component that never had a file.
  const bare = engine.createEntity({ name: "Bare" });
  const bareComp = bare.addComponent("script", {});
  report.emptyStaysEmpty = (bareComp.props.scripts ?? null)?.length === 0;

  // === 2. two scripts on one entity ========================================
  const host = engine.createEntity({ name: "Host" });
  const comp = host.addComponent("script", {
    scripts: [slot("Alpha.ts", { attributes: { gain: 3 } }), slot("Beta.ts", { attributes: { tag: "B1" } })],
  });
  await settle();
  report.loadedBoth = comp.instances.length === 2;
  report.classNames = comp.instances.map((i) => i.constructor.name);

  engine.setPlaying(true);
  await settle();
  const startTrace = trace();
  report.bothStarted =
    startTrace.includes("Alpha:start") && startTrace.includes("Beta:start");
  report.startOrder = startTrace.filter((t) => t.endsWith(":start"));

  // === 3. both tick, in array order, with their own attribute values =======
  await settle();
  const updates = trace().filter((t) => t.includes(":update:"));
  report.bothUpdated =
    updates.some((t) => t.startsWith("Alpha:update:")) && updates.some((t) => t.startsWith("Beta:update:"));
  report.attributesApplied = updates.includes("Alpha:update:3") && updates.includes("Beta:update:B1");
  // Within one frame Alpha must precede Beta.
  const firstAlpha = updates.indexOf("Alpha:update:3");
  const firstBeta = updates.indexOf("Beta:update:B1");
  report.orderRespected = firstAlpha >= 0 && firstBeta >= 0 && firstAlpha < firstBeta;

  // === 4. DISPATCH reaches every script (the old bug) ======================
  const other = engine.createEntity({ name: "Bullet" });
  trace();
  const handled = comp.dispatch("onCollisionEnter", other);
  const hits = globalThis.__TRACE__.filter((t) => t.includes(":hit:"));
  report.dispatch = { handled, hits: [...hits] };
  trace();
  // Entity-level convenience path.
  host.dispatch("onCollisionEnter", other);
  report.entityDispatchHits = globalThis.__TRACE__.filter((t) => t.includes(":hit:")).length;
  trace();

  // === 5. lookup by name ===================================================
  report.lookup = {
    byClassName: comp.getScript("Alpha")?.constructor?.name ?? null,
    caseInsensitive: comp.getScript("beta")?.constructor?.name ?? null,
    byPath: comp.getScript("Alpha.ts")?.constructor?.name ?? null,
    viaEntity: host.getScript("Beta")?.constructor?.name ?? null,
    missing: host.getScript("Nope"),
    method: host.getScript("Alpha")?.greet?.() ?? null,
  };

  // === 6. per-slot enable ==================================================
  const alphaInstanceBefore = comp.getScript("Alpha");
  comp.setProp("scripts", [
    slot("Alpha.ts", { enabled: false, attributes: { gain: 3 } }),
    slot("Beta.ts", { attributes: { tag: "B1" } }),
  ]);
  await settle();
  const afterDisable = trace();
  // Clear the window and watch a FRESH span: `afterDisable` necessarily
  // contains Alpha ticks from the frames before the disable landed, so it can
  // only be used to assert onDestroy fired, never that ticking stopped.
  await settle();
  const steadyState = trace();
  report.disable = {
    alphaDestroyed: afterDisable.includes("Alpha:destroy"),
    // Match on THIS entity's attribute value, not any Alpha tick: the trace is
    // global and the Legacy entity above is still running its own Alpha
    // (gain 7). Every entity in this harness uses a distinct value so traces
    // stay attributable.
    alphaStopped: !steadyState.includes("Alpha:update:3"),
    betaStillRunning: steadyState.includes("Beta:update:B1"),
    // A disabled script keeps its instance and its tuned values.
    instancePreserved: comp.getScript("Alpha") === alphaInstanceBefore,
  };

  // Re-enable and confirm it restarts.
  comp.setProp("scripts", [slot("Alpha.ts", { attributes: { gain: 3 } }), slot("Beta.ts", { attributes: { tag: "B1" } })]);
  await settle();
  report.reEnableRestarts = trace().includes("Alpha:start");

  // === 7. reorder must not reload modules ==================================
  const alphaBefore = comp.getScript("Alpha");
  const betaBefore = comp.getScript("Beta");
  comp.setProp("scripts", [slot("Beta.ts", { attributes: { tag: "B1" } }), slot("Alpha.ts", { attributes: { gain: 3 } })]);
  await settle();
  report.reorder = {
    sameInstances: comp.getScript("Alpha") === alphaBefore && comp.getScript("Beta") === betaBefore,
    newOrder: comp.instances.map((i) => i.constructor.name),
  };
  trace();
  await settle();
  const reordered = trace().filter((t) => t.includes(":update:"));
  const bIdx = reordered.indexOf("Beta:update:B1");
  const aIdx = reordered.indexOf("Alpha:update:3");
  report.reorderTakesEffect = bIdx >= 0 && aIdx >= 0 && bIdx < aIdx;

  // === 8. the same file twice, with independent attribute values ===========
  const twin = engine.createEntity({ name: "Twin" });
  const twinComp = twin.addComponent("script", {
    scripts: [slot("Alpha.ts", { attributes: { gain: 10 } }), slot("Alpha.ts", { attributes: { gain: 20 } })],
  });
  await settle();
  report.duplicateFile = {
    twoInstances: twinComp.instances.length === 2,
    distinctObjects: twinComp.instances[0] !== twinComp.instances[1],
    gains: twinComp.instances.map((i) => i.gain),
  };

  // === 9. error containment ================================================
  const risky = engine.createEntity({ name: "Risky" });
  const riskyComp = risky.addComponent("script", {
    scripts: [slot("Boom.ts"), slot("Beta.ts", { attributes: { tag: "survivor" } })],
  });
  await settle();
  trace();
  await settle();
  const riskyTrace = trace();
  report.containment = {
    // Beta must keep running even though Boom throws every frame before it.
    siblingSurvives: riskyTrace.some((t) => t === "Beta:update:survivor"),
    boomLatchedOff: riskyComp.slots?.[0]?.off === true,
  };
  trace();
  await settle();
  report.containment.stopsCallingAfterLatch = !trace().includes("Boom:update");

  // === 9b. attached DURING play must start ================================
  // The bullet case: a script (or a whole prefab) added while the game is
  // already running. The component subscribes to `play-changed`, but that
  // event has already fired by then, so it has to seed itself from
  // `engine.playing` at attach time.
  trace();
  const midPlay = engine.createEntity({ name: "MidPlay" });
  midPlay.addComponent("script", { scripts: [slot("Alpha.ts", { attributes: { gain: 99 } })] });
  await settle();
  const midPlayTrace = trace();
  report.midPlay = {
    started: midPlayTrace.includes("Alpha:start"),
    ticking: midPlayTrace.includes("Alpha:update:99"),
  };

  engine.setPlaying(false);
  await settle();

  // === 10. prefab diff must not see a migration as an override =============
  // Same module-identity requirement as above: `engine.instantiate` reads the
  // engine's own prefabRegistry, so the harness must register defs into that
  // exact instance, not a second copy of the module.
  const { diffInstance, createDefFromEntity } = await importLive("/src/engine/index.js");
  const { prefabRegistry } = await importLive("/src/engine/prefab/registry.js");

  // Build a prefab from a scripted entity, then rewrite its saved props to the
  // LEGACY shape to simulate a project saved before the migration.
  const src = engine.createEntity({ name: "PrefabSrc" });
  src.addComponent("script", { scripts: [slot("Alpha.ts", { attributes: { gain: 5 } })] });
  let legacyOverrides = null;
  let migratedOverrides = null;
  try {
    const def = createDefFromEntity(src, { name: "ScriptedPrefab" });
    const scriptComp = def.root.components.find((c) => c.type === "script");
    scriptComp.props = { path: "Alpha.ts", attributes: { gain: 5 }, enabled: true };
    prefabRegistry.register(def, "Prefabs/Scripted.prefab");
    const inst = engine.instantiate({ guid: def.guid });
    await settle();
    legacyOverrides = diffInstance(inst).map((o) => `${o.k}:${o.key ?? o.c ?? ""}`);

    // And the same def in the NEW shape must also diff clean.
    scriptComp.props = { scripts: [slot("Alpha.ts", { attributes: { gain: 5 } })], enabled: true };
    prefabRegistry.register(def, "Prefabs/Scripted.prefab");
    const inst2 = engine.instantiate({ guid: def.guid });
    await settle();
    migratedOverrides = diffInstance(inst2).map((o) => `${o.k}:${o.key ?? o.c ?? ""}`);
  } catch (err) {
    report.prefabError = String(err?.message ?? err);
  }
  report.prefab = { legacyOverrides, migratedOverrides };

  return report;
});

if (out.fatal) {
  console.log(` FAIL  ${out.fatal}`);
  await browser.close();
  process.exit(1);
}
if (out.prefabError) console.log(`  note  prefab stage error: ${out.prefabError}`);

// --- migration --------------------------------------------------------------
check(
  "legacy { path, attributes } migrates to a scripts list",
  out.migration.scripts?.length === 1 && out.migration.scripts[0].path === "Alpha.ts",
  JSON.stringify(out.migration.scripts),
);
check("migration carries attribute values over", out.migration.instanceGain === 7, `gain=${out.migration.instanceGain}`);
check("migration drops the legacy keys", out.migration.droppedLegacyKeys === true);
check("a component with no file gets no slot", out.emptyStaysEmpty === true);

// --- several scripts on one entity ------------------------------------------
check("both scripts load", out.loadedBoth === true, out.classNames?.join(", "));
check("both scripts get onStart", out.bothStarted === true, out.startOrder?.join(", "));
check("both scripts get onUpdate", out.bothUpdated === true);
check("each script gets its own attribute values", out.attributesApplied === true);
check("array order is execution order", out.orderRespected === true, out.startOrder?.join(" → "));

// --- dispatch (the regression) ----------------------------------------------
check(
  "dispatch reaches EVERY script, not just the first",
  out.dispatch.hits.length === 2 &&
    out.dispatch.hits.includes("Alpha:hit:Bullet") &&
    out.dispatch.hits.includes("Beta:hit:Bullet"),
  out.dispatch.hits.join(", ") || "no hooks fired",
);
check("dispatch reports handled", out.dispatch.handled === true);
check("entity.dispatch() reaches both too", out.entityDispatchHits === 2, `${out.entityDispatchHits} hooks`);

// --- lookup ------------------------------------------------------------------
check("getScript by class name", out.lookup.byClassName === "Alpha");
check("getScript is case-insensitive", out.lookup.caseInsensitive === "Beta");
check("getScript by asset path", out.lookup.byPath === "Alpha");
check("entity.getScript works", out.lookup.viaEntity === "Beta");
check("getScript returns null when absent", out.lookup.missing === null);
check("methods are callable on the returned instance", out.lookup.method === "alpha-3", `${out.lookup.method}`);

// --- per-slot enable ---------------------------------------------------------
check("disabling one script calls its onDestroy", out.disable.alphaDestroyed === true);
check("a disabled script stops ticking", out.disable.alphaStopped === true);
check("its siblings keep running", out.disable.betaStillRunning === true);
check("a disabled script keeps its instance", out.disable.instancePreserved === true);
check("re-enabling calls onStart again", out.reEnableRestarts === true);

// --- reorder -----------------------------------------------------------------
check("reordering does not reload modules", out.reorder.sameInstances === true, out.reorder.newOrder?.join(", "));
check("reordering changes execution order", out.reorderTakesEffect === true);

// --- same file twice ---------------------------------------------------------
check("one file can be attached twice", out.duplicateFile.twoInstances === true);
check("...as two distinct instances", out.duplicateFile.distinctObjects === true);
check("...with independent attribute values", JSON.stringify(out.duplicateFile.gains) === "[10,20]", JSON.stringify(out.duplicateFile.gains));

// --- attached mid-play (the runtime-spawn case) ------------------------------
check("a script attached during play starts immediately", out.midPlay.started === true);
check("...and ticks", out.midPlay.ticking === true);

// --- error containment -------------------------------------------------------
check("a throwing script does not stop its siblings", out.containment.siblingSurvives === true);
check("a repeatedly-throwing script is latched off", out.containment.boomLatchedOff === true);
check("a latched script stops being called", out.containment.stopsCallingAfterLatch === true);

// --- prefab overrides --------------------------------------------------------
check(
  "a legacy-shaped prefab def yields NO spurious overrides",
  Array.isArray(out.prefab.legacyOverrides) && out.prefab.legacyOverrides.length === 0,
  JSON.stringify(out.prefab.legacyOverrides),
);
check(
  "a migrated prefab def diffs clean too",
  Array.isArray(out.prefab.migratedOverrides) && out.prefab.migratedOverrides.length === 0,
  JSON.stringify(out.prefab.migratedOverrides),
);

// ---------------------------------------------------------------------------
const hard = errors.filter((e) => !/WebGPU|GPUAdapter|deprecat|Failed to load resource/i.test(e));
if (hard.length) {
  console.log("\nconsole errors:");
  for (const e of hard.slice(0, 10)) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nMULTI-SMOKE ${failed.length === 0 && hard.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
await browser.close();
process.exit(failed.length === 0 && hard.length === 0 ? 0 : 1);
