// Clicking an entity in the viewport selects THAT entity.
//
// Batching and merging both hide their members (`visible = false`) and leave
// them in the scene graph, drawing them through a proxy that opts out of
// raycasting — the contract at the top of engine/batching.js is that picking
// keeps working against the real per-entity meshes because three's Raycaster
// tests `layers`, never `visible`. The editor's own visibility filter (added so
// an entity the user hid could not be clicked) did not know about that
// contract, so every batched or merged mesh became unclickable: the click
// resolved to nothing and cleared the selection instead.
//
// autoBatching is ON by default, so this is most of an imported scene.
//
//   npx vite --port 5219
//   node scripts/run-viewport-pick-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite `?t=` twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";
const ROOT = path.join(os.tmpdir(), "viewport-pick-smoke").replaceAll("\\", "/");

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

const box = (id, name, position, extra = {}) => ({
  id,
  name,
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components: [{ type: "mesh", props: { geometry: "box" } }],
  children: [],
  ...extra,
});

// Six boxes sharing the default material, close enough together to merge
// (MIN_GROUP_SIZE is 3). Primitives each build their own geometry, so instanced
// batching can't claim them — merging is the path that can, and both hide their
// members the same way. Locality splitting decides how many end up in a proxy,
// which is fine: the ones it leaves alone are the control group.
//
// Raised off the world origin so the 3D cursor sitting there isn't over any
// box's centre — it is a legitimate click target and would win the pick.
// Spacing matters: a merged proxy's bound may not exceed MAX_MERGE_RADIUS_RATIO
// times its members' mean radius, so a row spread too thin is diced back into
// singletons and nothing merges at all. Unit boxes 1.2 apart stay well inside
// it while still landing tens of pixels apart on screen.
const ROW = [-3, -1.8, -0.6, 0.6, 1.8, 3];
const ROW_Y = 2;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "PickSmoke", version: 1, lastScene: "scenes/Pick.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Pick.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Pick",
      settings: {
        background: "#202329",
        ambientColor: "#ffffff",
        ambientIntensity: 0.6,
        shadows: false,
        performance: { staticMerging: true },
      },
      entities: [
        ...ROW.map((x, i) => box(`box${i}`, `Box ${i}`, [x, ROW_Y, 0])),
        // Explicitly hidden by the author, and parked between the camera and
        // Box 2. Hiding something is how you click past it — that must keep
        // working, which is the whole reason the visibility filter exists.
        box("ghost", "Hidden Box", [ROW[2], ROW_Y, 6], { enabledInEditor: false }),
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
    await openScenePath(`${ROOT}/scenes/Pick.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(4000);

// Look straight down -Z at the row, far enough back that all of it is on screen.
await page.evaluate(
  ({ ROW_Y }) => {
    const v = globalThis.__viewport;
    v.camera.position.set(0, ROW_Y, 12);
    v.orbit.target.set(0, ROW_Y, 0);
    v.orbit.update();
    v.camera.updateMatrixWorld(true);
  },
  { ROW_Y },
);
await settle(1500);

const IDS = ROW.map((_, i) => `box${i}`);

console.log("\nthe scene is actually merged (otherwise this test proves nothing)");

const claimed = await page.evaluate(
  (ids) =>
    ids.map((id) => {
      const mesh = globalThis.__engine.getEntity(id)?.getComponent("mesh")?.mesh;
      return {
        id,
        hidden: mesh?.visible === false,
        proxied: !!(mesh?.userData.mergedInto || mesh?.userData.batchedInto),
      };
    }),
  IDS,
);
const proxied = claimed.filter((c) => c.proxied);
check("a proxy claimed some of the row", proxied.length >= 3,
  claimed.map((c) => `${c.id}:${c.proxied ? "proxy" : "own"}`).join(" "));
check("...and every claimed member is hidden in favour of it", proxied.every((c) => c.hidden),
  proxied.map((c) => `${c.id}:${c.hidden ? "hidden" : "visible"}`).join(" "));
check("...while the rest still draw themselves", claimed.filter((c) => !c.proxied).every((c) => !c.hidden),
  "the unclaimed boxes are the control group");

const screenOf = (id) =>
  page.evaluate((entityId) => {
    const v = globalThis.__viewport;
    const object = globalThis.__engine.getEntity(entityId).object3D;
    object.updateMatrixWorld(true);
    const p = object.position.clone().setFromMatrixPosition(object.matrixWorld).project(v.camera);
    const rect = v.canvas.getBoundingClientRect();
    return {
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    };
  }, id);

const selection = () =>
  page.evaluate(async () => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    return useSelectionStore.getState().ids;
  });

const clickEntity = async (id) => {
  await page.evaluate(async () => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().clear();
  });
  await settle(250);
  const at = await screenOf(id);
  await page.mouse.click(at.x, at.y);
  await settle(400);
  return selection();
};

console.log("\nclicking each box selects that box");

const wrong = [];
for (const id of IDS) {
  const got = await clickEntity(id);
  if (got.length !== 1 || got[0] !== id) wrong.push(`${id}→${got.join("+") || "nothing"}`);
}
check("every box in the row picks itself", wrong.length === 0, wrong.join(" "));
check("...including the ones drawn through a proxy",
  !wrong.some((w) => proxied.some((c) => w.startsWith(`${c.id}→`))),
  proxied.map((c) => c.id).join(", "));

console.log("\nhidden still means hidden");

// The hidden box sits directly between the camera and Box 2: if a click could
// land on it, the pick would come back "ghost".
const throughGhost = await clickEntity(IDS[2]);
check("a box the author hid does not swallow the click", throughGhost[0] === IDS[2],
  throughGhost.join(", ") || "nothing");

const ghostState = await page.evaluate(() => {
  const entity = globalThis.__engine.getEntity("ghost");
  const mesh = entity?.getComponent("mesh")?.mesh;
  return {
    visible: entity?.object3D.visible,
    proxied: !!(mesh?.userData.mergedInto || mesh?.userData.batchedInto),
  };
});
check("...and it is hidden on its own account, not by a proxy",
  ghostState.visible === false && !ghostState.proxied, JSON.stringify(ghostState));

console.log("\nempty space");

const empty = await page.evaluate(() => {
  const rect = globalThis.__viewport.canvas.getBoundingClientRect();
  return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.92 };
});
await page.mouse.click(empty.x, empty.y);
await settle(400);
const afterEmpty = await selection();
check("clicking nothing clears the selection", afterEmpty.length === 0, afterEmpty.join(", "));

console.log("");
check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
