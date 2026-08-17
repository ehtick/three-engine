// Wheel navigation in the scene viewport.
//
// OrbitControls dollies by scaling the camera's distance to its pivot, so the
// step is a fraction of THAT distance no matter what you are actually flying
// at. Frame something small, then try to travel across the level and every
// notch moves a centimetre: the view crawls to a halt and never arrives. This
// proves the replacement in src/editor/viewportZoom.js — the step is measured
// against the surface under the cursor, the view never rotates, and neither
// end of the range (a distant wall, a wall you are pressed against) dead-ends.
//
// Real wheel events through the browser's capture path are the whole point:
// the handler has to beat OrbitControls' own listener on the same canvas, so a
// synthetic dispatch would prove nothing.
//
//   npx vite --port 5218
//   node scripts/run-viewport-zoom-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite `?t=` twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5218/";
const ROOT = path.join(os.tmpdir(), "viewport-zoom-smoke").replaceAll("\\", "/");

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

const entity = (id, name, position, scale, components = []) => ({
  id,
  name,
  position,
  rotation: [0, 0, 0],
  scale,
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components,
  children: [],
});

// A wall 60 units out and a trinket just off the view axis — the shape of the
// scene the bug shows up in. The trinket is what you framed; the wall is where
// you are trying to go.
const WALL_Z = -60;
const WALL_FACE = WALL_Z + 0.5; // box half-depth, unscaled on Z

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "ZoomSmoke", version: 1, lastScene: "scenes/Zoom.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Zoom.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Zoom",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [
        entity("wall", "Far Wall", [0, 0, WALL_Z], [80, 80, 1], [{ type: "mesh", props: { geometry: "box" } }]),
        entity("knob", "Trinket", [0, -1.4, 0], [0.2, 0.2, 0.2], [{ type: "mesh", props: { geometry: "box" } }]),
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
    await openScenePath(`${ROOT}/scenes/Zoom.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(3500);

const canvasBox = await page.$eval(".viewport-canvas", (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
check("the viewport canvas is on screen", canvasBox.width > 100 && canvasBox.height > 100,
  `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`);

/** Put the camera somewhere exact. OrbitControls re-aims at its target every
 *  update, so a pose is a position AND a pivot — setting one alone is how a
 *  harness ends up photographing empty space. */
const pose = (position, target) =>
  page.evaluate(
    ({ position, target }) => {
      const v = globalThis.__viewport;
      v.camera.position.set(...position);
      v.orbit.target.set(...target);
      v.orbit.update();
      v.camera.updateMatrixWorld(true);
    },
    { position, target },
  );

const readPose = () =>
  page.evaluate(() => {
    const v = globalThis.__viewport;
    return {
      position: v.camera.position.toArray(),
      quaternion: v.camera.quaternion.toArray(),
      target: v.orbit.target.toArray(),
    };
  });

/** `page.mouse.wheel` goes through CDP, so these are trusted wheel events
 *  landing on the canvas exactly like a user's. */
async function scroll(notches, { x = 0.5, y = 0.5 } = {}) {
  await page.mouse.move(canvasBox.x + canvasBox.width * x, canvasBox.y + canvasBox.height * y);
  const deltaY = notches > 0 ? -100 : 100;
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.wheel({ deltaY });
    await settle(30);
  }
  await settle(200);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

console.log("\nzooming at something far away, with the pivot on something near");

// The pivot sits 3 units out on the trinket's plane; the wall is 62.5 away.
// OrbitControls' dolly would move 3 - 3*0.95^10 = 0.6 units in ten notches.
await pose([0, 0, 3], [0, 0, 0]);
const before = await readPose();
await scroll(10);
const after = await readPose();

const gapBefore = before.position[2] - WALL_FACE;
const gapAfter = after.position[2] - WALL_FACE;
check("ten notches close most of the distance to the wall under the cursor",
  gapAfter < gapBefore * 0.4, `${gapBefore.toFixed(1)} → ${gapAfter.toFixed(1)} units`);
check("...instead of the fraction-of-the-pivot crawl", gapBefore - gapAfter > 20,
  `moved ${(gapBefore - gapAfter).toFixed(1)} units`);

const dot = Math.abs(
  before.quaternion.reduce((sum, q, i) => sum + q * after.quaternion[i], 0),
);
check("...without rotating the view", dot > 0.999999, `|dot| = ${dot.toFixed(8)}`);

check("the orbit pivot follows onto the surface you zoomed to",
  after.target[2] < WALL_FACE + 20 && after.target[2] > WALL_FACE - 1,
  `pivot z = ${after.target[2].toFixed(1)}, wall face ${WALL_FACE}`);

console.log("\nbacking out of a wall you flew into");

// Pressed up against the wall, the surface under the cursor is millimetres
// away — a purely proportional step strands you there forever.
await pose([0, 0, WALL_FACE + 0.1], [0, 0, WALL_FACE]);
await scroll(-20);
const out = await readPose();
const gapOut = out.position[2] - WALL_FACE;
check("twenty notches out actually get you clear", gapOut > 2, `${gapOut.toFixed(2)} units off the wall`);

console.log("\nnothing under the cursor");

// Facing away from everything: no surface to measure against, so the pivot
// distance is the fallback — the point is that it still moves, and finitely.
await pose([0, 0, 40], [0, 0, 43]);
const skyBefore = await readPose();
await scroll(-5);
const skyAfter = await readPose();
const moved = dist(skyBefore.position, skyAfter.position);
check("empty space still dollies", moved > 0.1, `${moved.toFixed(2)} units`);
check("...and stays finite", skyAfter.position.every(Number.isFinite), skyAfter.position.join(", "));

console.log("");
check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
