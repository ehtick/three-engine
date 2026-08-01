// GI Inspector panel smoke test: the Global Illumination component's
// inspector must show ONLY Quality + Intensity by default, with every other
// field tucked behind a collapsed "Advanced" toggle. Editing an advanced
// field (Voxel Size) must flip Quality to "custom" in the SAME edit; picking
// a quality PRESET afterwards must never rewrite an advanced value (or
// Intensity) back.
//
//   npx vite --port 5273
//   node scripts/run-gi-panel-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// START THE DEV SERVER FRESH. Vite rewrites imports of files edited since
// the server started to `…?t=<mtime>`, so the app loads its modules under a
// versioned URL while a harness's bare `import("/src/…")` gets the
// un-versioned one — two module graphs, two Engine singletons. This harness
// uses `importLive` (reads back the URL the browser actually fetched) to
// dodge that, same as run-editor-ui-smoke.mjs — but a fresh server (this
// file's edits already landed before you start it) is still the rule.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5273/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`console error: ${m.text()}`);
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
for (let i = 0; i < 40; i++) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"));
    btn?.click();
    return !!btn;
  });
  if (clicked) break;
  await wait(500);
}
await wait(6000);

// --- a GI entity to inspect --------------------------------------------

const setup = await page.evaluate(async () => {
  /**
   * Imports the module instance the APP is using, not a fresh copy — see
   * this file's header comment.
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

  const { THREE } = await importLive("/src/engine/index.js");
  await importLive("/src/modules/index.js");
  const { enableEngineModule } = await importLive("/src/engine/modules.js");
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await importLive("/src/editor/commands/entityCommands.js");

  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");

  // A GI component's class default is `autoFit: true`, which fits a volume
  // around the scene's meshes — an empty scene takes a separate null-fit
  // code path this panel-UI smoke test isn't exercising, so give it one
  // simple mesh to fit around (same as run-gi-sdf-hires.mjs's floor).
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.2, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0x808080, roughness: 0.9 }),
  );
  floor.position.set(0, -0.1, 0);
  engine.scene.add(floor);

  const create = new CreateEntityCommand({
    name: "GIPanelSmoke",
    components: [{ type: "global-illumination" }],
  });
  commandBus.execute(create);
  useSceneStore.getState().refresh();
  useSelectionStore.getState().select(create.entityId);
  globalThis.__smokeId = create.entityId;
  globalThis.__engine = engine;
  return {
    id: String(create.entityId),
    wired: !!engine.getEntity(create.entityId)?.getComponent("global-illumination"),
  };
});
if (!setup.wired) {
  console.log("GI-PANEL FAIL — engine module duplicated; restart `npx vite` and re-run");
  await browser.close();
  process.exit(1);
}
await wait(1200);

// --- helpers --------------------------------------------------------------

/** The GI component's own .inspector-section info, or null if not found. */
const giSectionInfo = () =>
  page.evaluate(() => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((sec) =>
      sec.querySelector(".section-header")?.textContent?.includes("Global Illumination"),
    );
    if (!section) return null;
    return {
      labels: [...section.querySelectorAll(".field-row")]
        .map((row) => row.querySelector(".field-label")?.textContent?.trim())
        .filter(Boolean),
      hasAdvancedToggle: !!section.querySelector(".advanced-fields-toggle"),
    };
  });

const qualitySelectValue = () =>
  page.evaluate(() => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((sec) =>
      sec.querySelector(".section-header")?.textContent?.includes("Global Illumination"),
    );
    const row = [...(section?.querySelectorAll(".field-row") ?? [])].find(
      (r) => r.querySelector(".field-label")?.textContent?.trim() === "Quality",
    );
    return row?.querySelector("select.select-field")?.value ?? null;
  });

const engineProps = () =>
  page.evaluate((id) => {
    const c = globalThis.__engine.getEntity(id)?.getComponent("global-illumination");
    return { voxelSize: c?.props.voxelSize, intensity: c?.props.intensity, quality: c?.props.quality };
  }, setup.id);

// --- (a) Quality + Intensity render by default, nothing else --------------

const initial = await giSectionInfo();
check("the GI inspector section is present", !!initial, initial ? "" : "no .inspector-section for Global Illumination");
check(
  "Quality and Intensity render by default",
  !!initial && initial.labels.includes("Quality") && initial.labels.includes("Intensity"),
  initial ? initial.labels.join(", ") : "",
);

// --- (b) advanced fields are absent until the toggle is expanded ----------

check(
  'advanced fields (e.g. "Voxel Size") are NOT visible before expanding',
  !!initial && !initial.labels.some((l) => l.startsWith("Voxel Size")),
  initial ? initial.labels.join(", ") : "",
);
check("an Advanced toggle is offered", !!initial?.hasAdvancedToggle);

await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((sec) =>
    sec.querySelector(".section-header")?.textContent?.includes("Global Illumination"),
  );
  section?.querySelector(".advanced-fields-toggle")?.click();
});
await wait(300);

const expanded = await giSectionInfo();
check(
  "Voxel Size appears once Advanced is expanded",
  !!expanded && expanded.labels.some((l) => l.startsWith("Voxel Size")),
  expanded ? expanded.labels.join(", ") : "",
);

const qualityBefore = await qualitySelectValue();
check(
  'quality starts on a real preset, not "custom"',
  qualityBefore != null && qualityBefore !== "custom",
  String(qualityBefore),
);

// --- (c) editing an advanced field flips Quality to "custom" --------------

const edited = await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((sec) =>
    sec.querySelector(".section-header")?.textContent?.includes("Global Illumination"),
  );
  const row = [...(section?.querySelectorAll(".field-row") ?? [])].find((r) =>
    r.querySelector(".field-label")?.textContent?.trim()?.startsWith("Voxel Size"),
  );
  const input = row?.querySelector("input.number-field");
  if (!input) return false;
  // Real input, real events — a plain `input.value = …` is silently eaten by
  // React's value tracking on <input>, see NumberField's scale-row smoke in
  // run-editor-ui-smoke.mjs for the same trick.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, "0.5");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
  return true;
});
check("the Voxel Size input was found and edited", edited);
await wait(500);

const afterEdit = await engineProps();
check(
  "the edit actually landed on voxelSize (0.35 -> 0.5)",
  Math.abs((afterEdit.voxelSize ?? 0) - 0.5) < 1e-6,
  String(afterEdit.voxelSize),
);

const qualityAfter = await qualitySelectValue();
check(
  'editing an advanced field flips the Quality SELECT to "custom"',
  qualityAfter === "custom",
  `select reads "${qualityAfter}"`,
);
check('the engine prop agrees ("custom")', afterEdit.quality === "custom", String(afterEdit.quality));
check("Intensity is untouched by the flip (stays at its default, 1)", Math.abs((afterEdit.intensity ?? 0) - 1) < 1e-6, String(afterEdit.intensity));

// --- (5) picking a preset afterwards must not rewrite the advanced value --

await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find((sec) =>
    sec.querySelector(".section-header")?.textContent?.includes("Global Illumination"),
  );
  const row = [...(section?.querySelectorAll(".field-row") ?? [])].find(
    (r) => r.querySelector(".field-label")?.textContent?.trim() === "Quality",
  );
  const select = row?.querySelector("select.select-field");
  select.value = "low";
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
await wait(500);

const afterPreset = await engineProps();
check('selecting the "low" preset applies it', afterPreset.quality === "low", String(afterPreset.quality));
check(
  "…without rewriting the advanced voxelSize the user just set",
  Math.abs((afterPreset.voxelSize ?? 0) - 0.5) < 1e-6,
  String(afterPreset.voxelSize),
);
check("…and without touching Intensity", Math.abs((afterPreset.intensity ?? 0) - 1) < 1e-6, String(afterPreset.intensity));

// --- summary ----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
