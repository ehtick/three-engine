// The camera-rig components as the INSPECTOR sees them.
//
// `npm run test:camera` proves the rig maths. What it cannot see is whether the
// two inspector sections these components added actually render — and a throw
// inside one of them doesn't break "the vcam section", it blanks the entire
// Inspector panel for every entity in the project. That failure is one React
// render away and invisible to every headless test, so it gets a browser.
//
//   npx vite --port 5211
//   node scripts/run-camera-rig-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite `?t=` twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";
const ROOT = path.join(os.tmpdir(), "camera-rig-smoke").replaceAll("\\", "/");

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

const entity = (id, name, components = []) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components,
  children: [],
});

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "CamRigSmoke", version: 1, lastScene: "scenes/Rig.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Rig.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Rig",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [
        entity("player", "Player"),
        entity("maincam", "Main Camera", [{ type: "camera", props: {} }]),
        // Authored in the scene file, not added through the UI: this also
        // proves the components deserialize, which an add-through-the-menu
        // test would skip entirely.
        entity("shot", "Follow Shot", [
          { type: "vcam", props: { priority: 10, follow: "player", body: "orbital", distance: 5 } },
        ]),
        entity("boom", "Explosion", [{ type: "impulsesource", props: { magnitude: 0.5, radius: 12 } }]),
      ],
    },
    null,
    2,
  ),
);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });

const pageErrors = [];
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
    await openScenePath(`${ROOT}/scenes/Rig.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(3500);

const select = async (id) => {
  await page.evaluate(async (entityId) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select([entityId]);
  }, id);
  await settle(700);
};
const inspectorText = () => page.$eval(".inspector-panel, .inspector", (el) => el.textContent).catch(() => "");
const actionLabels = () =>
  page.$$eval(".editor-action-label", (els) => els.map((e) => e.textContent.trim())).catch(() => []);

console.log("\nvirtual camera");

await select("shot");
let text = await inspectorText();
check("the vcam component deserialized and shows its section", /Virtual Camera/.test(text), text.slice(0, 80));
check("...with the body-mode fields for an orbital rig", /Arm Length/.test(text) && /Avoid Walls/.test(text));
check("...and hides transposer-only fields", !/Offset Space/.test(text));
let actions = await actionLabels();
check("Solo is offered", actions.includes("Solo"), actions.join(", "));

await page.evaluate(() => {
  [...document.querySelectorAll(".editor-action")]
    .find((b) => b.textContent.includes("Solo"))
    ?.click();
});
await settle(500);
actions = await actionLabels();
check("clicking it soloes the shot", actions.includes("Unsolo"), actions.join(", "));
const soloed = await page.evaluate(
  () => [...globalThis.__engine.virtualCameras].filter((v) => v.solo).length,
);
check("...and exactly one camera is soloed", soloed === 1, `${soloed}`);

// Switching body mode must swap which fields are shown — the schema's showIf
// predicates are the only thing keeping this component readable.
await page.evaluate(async () => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { SetComponentPropCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  commandBus.execute(new SetComponentPropCommand("shot", "vcam", "body", "transposer"));
});
await settle(600);
text = await inspectorText();
check("switching to a transposer reveals its offset space", /Offset Space/.test(text));
check("...and hides the boom-arm fields", !/Arm Length/.test(text));

console.log("\nimpulse source");

await select("boom");
text = await inspectorText();
check("the impulse source shows its section", /Impulse Source/.test(text), text.slice(0, 80));
check("...with the directional vector hidden until it's directional", !/Direction\b/.test(text.replace(/Directional/g, "")));
actions = await actionLabels();
check("Fire is offered", actions.includes("Fire"), actions.join(", "));

await page.evaluate(() => {
  [...document.querySelectorAll(".editor-action")].find((b) => b.textContent.includes("Fire"))?.click();
});
await settle(300);
const live = await page.evaluate(() => globalThis.__engine.cameraImpulse.count);
check("clicking it emits a live impulse", live === 1, `${live} live`);

const cleared = await page.evaluate(() => {
  globalThis.__engine.cameraImpulse.clear();
  return globalThis.__engine.cameraImpulse.count;
});
check("...which can be cleared", cleared === 0);

console.log("\ncamera brain");

await select("maincam");
text = await inspectorText();
check("the Camera component exposes the brain's blend controls", /Blend \(s\)/.test(text) && /Preview Rig/.test(text));

// The editor must not have moved the camera: the rig only drives the transform
// while playing, or while Preview Rig is explicitly on.
const cameraMoved = await page.evaluate(() => {
  const cam = globalThis.__engine.getEntity("maincam");
  return cam.object3D.position.lengthSq();
});
check("the rig left the authored camera transform alone in the editor", cameraMoved === 0, `${cameraMoved}`);

const realErrors = pageErrors.filter((e) => !/ResizeObserver|WebGPU|GPUAdapter|Unknown component/i.test(e));
check("no uncaught errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
