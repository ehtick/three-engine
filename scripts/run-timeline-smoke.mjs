// The Timeline panel — the dope sheet, scrubbing, and the preview's promise to
// give the scene back — driven through the REAL editor.
//
// `npm run test:timeline` proves the runtime evaluates correctly. It cannot
// prove that the panel writes a timeline the runtime can read, that dragging a
// keyframe moves it in time rather than in the React state only, or — the one
// that actually matters — that previewing a cutscene and then stopping leaves
// the scene exactly as it was found. That last one is invisible in a unit test
// (nothing there has a scene to destroy) and catastrophic in practice: a
// preview that permanently rewrites light intensities and transforms destroys
// the author's work by the act of looking at it.
//
//   npx vite --port 5212
//   node scripts/run-timeline-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
//
// START THE DEV SERVER FRESH — see the note in run-editor-ui-smoke.mjs about
// Vite's `?t=` module twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5212/";
const ROOT = path.join(os.tmpdir(), "timeline-ui-smoke").replaceAll("\\", "/");
const TL = `${ROOT}/timelines/Gate.timeline`;

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
const readTimeline = () => JSON.parse(fs.readFileSync(TL, "utf8"));

/* -------------------------------------------------------------------------- */
/* scratch project: a lamp to animate, a gate to move, and a director           */
/* -------------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "timelines"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "TimelineSmoke", version: 1, lastScene: "scenes/Cut.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  TL,
  JSON.stringify(
    {
      version: 1,
      duration: 4,
      frameRate: 30,
      tracks: [
        {
          id: "track-lamp",
          kind: "property",
          target: "lamp",
          component: "light",
          property: "intensity",
          valueType: "number",
          keys: [
            { id: "k1", t: 0, v: 0, interp: "linear" },
            { id: "k2", t: 4, v: 8, interp: "linear" },
          ],
        },
      ],
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Cut.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Cut",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [
        {
          id: "lamp",
          name: "Lamp",
          position: [0, 2, 0],
          components: [{ type: "light", props: { type: "point", intensity: 3, color: "#ffddaa" } }],
        },
        { id: "gate", name: "Gate", position: [1, 0, 0], components: [] },
        {
          id: "director",
          name: "Director",
          components: [
            { type: "timeline", props: { asset: TL, playOnStart: true, wrapMode: "hold" } },
          ],
        },
      ],
    },
    null,
    2,
  ),
);

/* -------------------------------------------------------------------------- */

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
    await openScenePath(`${ROOT}/scenes/Cut.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(3500);

await page.evaluate(
  async ({ TL }) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().selectAsset(TL);
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("timeline");
  },
  { TL },
);
await page.waitForSelector(".timeline-panel", { timeout: 30000 });
await settle(1200);

/* -------------------------------------------------------------------------- */

const lampIntensity = () =>
  page.evaluate(() => globalThis.__engine.getEntity("lamp").getComponent("light").props.intensity);
const gatePosition = () =>
  page.evaluate(() => globalThis.__engine.getEntity("gate").object3D.position.toArray());
const laneBox = (trackId) =>
  page.evaluate((id) => {
    const lane = document.querySelector(`.timeline-lane[data-track-id="${id}"]`);
    if (!lane) return null;
    const r = lane.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, trackId);
const clickText = async (selector, needle) => {
  const ok = await page.evaluate(
    (sel, n) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(n));
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    needle,
  );
  await settle(250);
  return ok;
};
/** A real double-click. `page.mouse.click(x, y, { clickCount: 2 })` sends ONE
 *  down/up pair and Chrome never synthesises `dblclick` from it — the handler
 *  looks broken when it is the harness that is. */
const doubleClick = async (x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(350);
};
/** The "key it now" diamond inside a SPECIFIC track's row — there is one per
 *  property track, and clicking the first one keys the wrong track. */
const keyTrack = async (index) => {
  const ok = await page.evaluate((i) => {
    const row = document.querySelectorAll(".timeline-track-row")[i];
    const btn = row?.querySelector('button[title^="Key the current value"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, index);
  await settle(350);
  return ok;
};
const clickTitled = async (title) => {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button[title]")].find((b) => b.title.startsWith(t));
    if (!el) return false;
    el.click();
    return true;
  }, title);
  await settle(250);
  return ok;
};

console.log("\nopening");

const trackRows = await page.$$(".timeline-track-row");
check("the panel opens the selected .timeline asset", trackRows.length === 1, `${trackRows.length} track(s)`);
const trackTitle = await page.$eval(".timeline-track-title", (e) => e.textContent.trim());
check("a property track labels itself from what it drives", trackTitle === "light.intensity", trackTitle);
check("the lamp still reads its authored value before any preview", (await lampIntensity()) === 3);

/* -------------------------------------------------------------------------- */

console.log("\nscrubbing previews the scene");

// Drag the ruler to the middle of the 4s timeline.
const ruler = await page.evaluate(() => {
  const r = document.querySelector(".timeline-ruler").getBoundingClientRect();
  return { x: r.x, y: r.y + r.height / 2, w: r.width };
});
const lane = await laneBox("track-lamp");
const pxPerSec = await page.evaluate(() => {
  // Two ruler ticks tell us the scale without reaching into React state.
  const ticks = [...document.querySelectorAll(".timeline-tick")];
  if (ticks.length < 2) return 120;
  return parseFloat(ticks[1].style.left) - parseFloat(ticks[0].style.left);
});
await page.mouse.move(ruler.x + 2 * pxPerSec, ruler.y);
await page.mouse.down();
await page.mouse.move(ruler.x + 2 * pxPerSec, ruler.y);
await page.mouse.up();
await settle(400);

const midValue = await lampIntensity();
check("scrubbing to the middle writes the interpolated value onto the light", Math.abs(midValue - 4) < 0.3, `${midValue}`);
const timeText = await page.$eval('[data-testid="timeline-time"]', (e) => e.textContent.trim());
check("...and the readout follows the playhead", timeText.startsWith("0:02"), timeText);
check("a Preview badge says the scene is being posed", !!(await page.$(".timeline-preview-badge")));

// Scrub backwards: the value must land where forward playback put it, not on
// some path-dependent accumulation.
await page.mouse.click(ruler.x + 1 * pxPerSec, ruler.y);
await settle(300);
const backValue = await lampIntensity();
await page.mouse.click(ruler.x + 2 * pxPerSec, ruler.y);
await settle(300);
const againValue = await lampIntensity();
check("scrubbing is path-independent", Math.abs(againValue - midValue) < 1e-6, `${backValue} → ${againValue}`);

/* -------------------------------------------------------------------------- */

console.log("\nstop restores the scene");

check("stop is offered while previewing", await clickTitled("Stop preview"));
await settle(400);
check("stopping the preview puts the authored value back", (await lampIntensity()) === 3, `${await lampIntensity()}`);
check("...and the badge goes away", !(await page.$(".timeline-preview-badge")));

/* -------------------------------------------------------------------------- */

console.log("\nediting");

// Drag the last key one second earlier.
const keyBoxes = await page.$$eval(".timeline-lane[data-track-id='track-lamp'] .timeline-key", (els) =>
  els.map((e) => {
    const r = e.getBoundingClientRect();
    return { id: e.dataset.itemId, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }),
);
check("both keys are on the lane", keyBoxes.length === 2, `${keyBoxes.length}`);
const lastKey = keyBoxes[keyBoxes.length - 1];
await page.mouse.move(lastKey.x, lastKey.y);
await page.mouse.down();
await page.mouse.move(lastKey.x - pxPerSec, lastKey.y, { steps: 8 });
await page.mouse.up();
await settle(400);

let json = await page.evaluate(async () => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  return useSelectionStore.getState().assetPath; // keeps the import graph warm
});
await clickText(".timeline-panel .panel-toolbar .toolbar-btn", "Save");
await settle(600);
json = readTimeline();
const movedKey = json.tracks[0].keys.find((k) => k.id === "k2");
check("dragging a key moves it in time, and the move survives a save", Math.abs(movedKey.t - 3) < 0.1, `t=${movedKey.t}`);
check("...and the drag snapped to the frame grid", Math.abs(movedKey.t * 30 - Math.round(movedKey.t * 30)) < 1e-6, `t=${movedKey.t}`);

// Double-clicking an empty lane keys the CURRENT live value at that time.
const lane2 = await laneBox("track-lamp");
await doubleClick(lane2.x + 0.5 * pxPerSec, lane2.y + lane2.h / 2);
await clickText(".timeline-panel .panel-toolbar .toolbar-btn", "Save");
await settle(600);
json = readTimeline();
check("double-clicking an empty lane adds a key there", json.tracks[0].keys.length === 3, `${json.tracks[0].keys.length} keys`);

// The item inspector edits the selected key.
const selected = await page.$(".timeline-inspector .number-field");
check("selecting a key opens its inspector", !!selected);

/* -------------------------------------------------------------------------- */

console.log("\nadding a track");

check("the Track button opens the add popover", await clickText(".timeline-toolbar .toolbar-btn", "Track"));
await settle(300);
const setPopSelect = (label, value) =>
  page.evaluate(
    (l, v) => {
      const row = [...document.querySelectorAll(".timeline-add-row")].find(
        (r) => r.querySelector("span")?.textContent.trim() === l,
      );
      const select = row?.querySelector("select");
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, v);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    label,
    value,
  );
check("the popover offers the entities in the scene", await setPopSelect("Target", "gate"));
await settle(250);
check("...the components on the chosen one", await setPopSelect("Component", ""));
await settle(250);
check("...and their animatable properties", await setPopSelect("Property", "position"));
await settle(200);
// A REAL mouse click, not `el.click()`: the popover renders alongside a
// full-screen dismiss overlay, and a z-index that puts it UNDER that overlay
// leaves it perfectly visible and completely inert. Only hit-testing catches it.
const addBtn = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".timeline-add-actions .toolbar-btn")].find((b) =>
    b.textContent.includes("Add Track"),
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
check("the popover is reachable by a real click, not just programmatically", !!addBtn);
if (addBtn) await page.mouse.click(addBtn.x, addBtn.y);
await settle(400);
check("Add Track commits it", (await page.$$(".timeline-track-row")).length === 2);
check("the popover closes after committing", !(await page.$(".timeline-add-popover")));

// Key the gate's transform at 0, move it, then key it at 2s — the doors-and-
// elevators workflow the whole feature exists for.
const gateTrackId = await page.evaluate(
  () => document.querySelectorAll(".timeline-lane")[1]?.dataset.trackId ?? null,
);
check("the new lane is addressable", !!gateTrackId, String(gateTrackId));

await page.mouse.click(ruler.x + 0, ruler.y);
await settle(250);
check("keying at the playhead captures the live transform", await keyTrack(1));
await settle(300);

// Then the second key through RECORD mode, which is the workflow the feature
// exists for: park the playhead, move the object, and let the panel write the
// key. Note the order — scrubbing re-poses the object from its own curve, so
// moving it first and scrubbing afterwards would (correctly) throw the move
// away before it could be captured.
await page.mouse.click(ruler.x + 2 * pxPerSec, ruler.y);
await settle(250);
check("record arms", await clickTitled("Record"));
await page.evaluate(() => {
  globalThis.__engine.getEntity("gate").object3D.position.set(1, 5, 0);
});
await settle(600);
check("moving a tracked object while recording writes a key", true);
await clickTitled("Recording");
await settle(250);
await clickText(".timeline-panel .panel-toolbar .toolbar-btn", "Save");
await settle(700);

json = readTimeline();
const gateTrack = json.tracks.find((t) => t.target === "gate");
check("the transform track saved two keys", gateTrack?.keys?.length === 2, JSON.stringify(gateTrack?.keys?.map((k) => k.t)));
check("...and record captured the pose the object was moved to", gateTrack?.keys?.[1]?.v?.[1] === 5, JSON.stringify(gateTrack?.keys?.[1]?.v));

// And the payoff: scrubbing between them moves the gate.
await page.mouse.click(ruler.x + 1 * pxPerSec, ruler.y);
await settle(350);
const midGate = await gatePosition();
check("scrubbing between the two keys moves the gate", midGate[1] > 1 && midGate[1] < 4.5, JSON.stringify(midGate));
await clickTitled("Stop preview");
await settle(400);
check("stopping restores the gate too", (await gatePosition())[1] === 0, JSON.stringify(await gatePosition()));

/* -------------------------------------------------------------------------- */

console.log("\nthe runtime agrees with the file");

const runtimeReport = await page.evaluate(
  async ({ TL }) => {
    const { TimelineRuntime } = await globalThis.__importLive("/src/engine/timeline/TimelineRuntime.js");
    const raw = JSON.parse(await window.__TAURI_INTERNALS__.invoke("read_text_file", { path: TL }));
    const engine = globalThis.__engine;
    const runtime = new TimelineRuntime(engine, raw, { name: "smoke" });
    runtime.bind();
    runtime.sample(1.5);
    const posed = engine.getEntity("lamp").getComponent("light").props.intensity;
    runtime.unbind();
    return {
      posed,
      restored: engine.getEntity("lamp").getComponent("light").props.intensity,
      duration: runtime.duration,
      tracks: runtime.tracks.length,
    };
  },
  { TL },
);
check(
  "the runtime loads the saved file and poses the scene from it",
  runtimeReport.tracks === 2 && runtimeReport.posed !== 3,
  JSON.stringify(runtimeReport),
);
check("...and unbinding restores it", runtimeReport.restored === 3, `${runtimeReport.restored}`);

/* -------------------------------------------------------------------------- */

console.log("\nthe director picks it up");

const playReport = await page.evaluate(async () => {
  const engine = globalThis.__engine;
  const director = engine.getEntity("director").getComponent("timeline");
  // The panel's save re-applies the asset to every director pointed at it, so
  // this must already be the edited version, not the one on disk at load.
  const before = engine.getEntity("lamp").getComponent("light").props.intensity;
  director.play(0);
  director.setTime(1.5);
  const posed = engine.getEntity("lamp").getComponent("light").props.intensity;
  director.stop();
  return { before, posed, after: engine.getEntity("lamp").getComponent("light").props.intensity, duration: director.duration };
});
check("the director in the scene plays the edited timeline", playReport.posed !== playReport.before, JSON.stringify(playReport));
check("...and stopping it reverts the scene", playReport.after === playReport.before, JSON.stringify(playReport));

/* -------------------------------------------------------------------------- */

console.log("\nswitching away ends the preview");

// The dangerous case: dockview DETACHES an inactive tab's element without
// unmounting its React component, so no cleanup runs — and the "Preview" badge
// that would have warned you is off screen along with the panel. A preview left
// bound gets its posed values saved into the scene as if they were authored.
await page.mouse.click(ruler.x + 2 * pxPerSec, ruler.y);
await settle(400);
check("scrubbing poses the lamp again", (await lampIntensity()) !== 3, `${await lampIntensity()}`);
await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("assets");
});
await settle(1200);
check(
  "switching to another tab unbinds the preview and restores the scene",
  (await lampIntensity()) === 3,
  `${await lampIntensity()}`,
);

/* -------------------------------------------------------------------------- */

const realErrors = pageErrors.filter((e) => !/ResizeObserver|WebGPU|GPUAdapter|Unknown component/i.test(e));
check("no uncaught errors while driving the panel", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
