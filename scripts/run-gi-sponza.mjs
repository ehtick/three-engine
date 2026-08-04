// GI LEAK + FLICKER, MEASURED ON THE USER'S ACTUAL SPONZA SCENE.
//
// Every synthetic harness in this repo has failed to reproduce the reported
// under-floor leak, and each failure was structural, not a tuning miss:
//   · run-gi-sun-leak     — SEALED box. Auto-fit ends the volume at the box, so
//                           there are never probes in lit open air beneath a
//                           floor. Reports leak 0.00000 even at ELEVATION=-60.
//   · run-gi-rc-splitroom — THICK slab, lamp above it. Byte-identical numbers
//                           before and after every cut added to the module.
//   · run-gi-underfloor   — hand-built approximation; never even shaded.
// So stop approximating the scene and open the real one.
//
// HOW IT AVOIDS THE TWO TRAPS THAT KILLED THE PREVIOUS ATTEMPTS:
//   1. Vite module duplication. `import("/src/editor/...")` from a harness
//      resolves to a SECOND module graph with its own Engine, so the scene
//      loads into an engine the viewport never renders (the previous attempt's
//      `openScenePath -> true, 0 entities`). Fixed by not importing anything:
//      seed `engine.projectRoot.v1` in localStorage and let the EDITOR boot the
//      project through its own code path, then drive it exclusively through
//      `globalThis.__editorApi`, which is a `Symbol.for` singleton and immune.
//   2. Sampling the wrong pixels. `viewport.screenshot` renders the scene with
//      grid, gizmos and selection outlines EXCLUDED by default, so no sample
//      region can accidentally measure the transform gizmo or a grid axis line.
//
// READ-ONLY: tauriShim refuses every write command unless given a scratch root,
// so the project on disk cannot be modified. Editor autosave will fail in the
// console; that is the guard working, not a bug.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-sponza.mjs
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   HATCH=a,b        globalThis flags set to true before load, e.g.
//                    HATCH=__giNoParentVis or HATCH=__giNoBuriedProbeCut
//   QUALITY=low      override the GI quality preset
//   SHOT=<dir>       dump every frame it measures
//   HEADED=1
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const HATCHES = (process.env.HATCH ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const QUALITY = process.env.QUALITY ?? "";
const SHOT = process.env.SHOT ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // The three --disable-background* flags are MANDATORY (see gi-module Round
  // 15): an occluded/headless window gets ~1/s timer throttling, which
  // starves the async compute-pipeline compiles — the GI field never
  // populates and every GI toggle measures a frame whose indirect term is
  // zero (on == off byte-identical, the failed-CONTROL signature).
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy backend|\[gi\] auto-fit bounds/.test(t)) console.log(`  ${t.slice(0, 220)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error") console.log(`  console.error: ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.stack ?? e.message).slice(0, 400)}`));

await page.evaluateOnNewDocument(({ PROJECT, HATCHES, GLOBALS }) => {
  // The editor's own boot path reads these; nothing here imports editor code.
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const h of HATCHES) globalThis[h] = true;
  // GLOBALS='k=v' — numeric build-time knobs (e.g. __giCascadeBranch=4) that
  // HATCH (true only) cannot express.
  for (const g of GLOBALS) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, { PROJECT, HATCHES, GLOBALS });

console.log(`Opening ${PROJECT} …${HATCHES.length ? `  [hatches: ${HATCHES.join(", ")}]` : ""}`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });

// The app boots to the Project Hub with `rootPath: null` — seeding
// localStorage is NOT enough on its own (nothing calls restoreLastFolder at
// boot). Click the seeded recent entry instead, so the project opens through
// the editor's own store in the editor's own module graph. Reaching into
// `useProjectStore` from a harness import would resolve to a SECOND copy of
// that module and set rootPath on a store React never rendered.
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
const clicked = await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  const btn = row?.querySelector(".hub-recent-open-btn");
  if (!btn) return null;
  btn.click();
  return row.getAttribute("title");
}, PROJECT);
if (!clicked) { console.log("FATAL: no recent-project row to open"); await browser.close(); process.exit(1); }
console.log(`  clicked recent: ${clicked}`);
try {
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
} catch {
  // `installEditorApi()` runs inside ensureEngine() (engineInstance.js), so a
  // missing handle means that bootstrap threw somewhere after the engine was
  // created — report WHAT rather than just timing out.
  const diag = await page.evaluate(async () => {
    const out = { keys: Object.keys(globalThis).filter((k) => k.startsWith("__")), install: null };
    try {
      const mod = await import("/src/editor/api/index.js");
      out.install = typeof mod.installEditorApi;
      mod.installEditorApi();
      out.after = !!globalThis.__editorApi;
    } catch (err) { out.install = `import threw: ${err?.message ?? err}`; }
    return out;
  });
  console.log(`  no __editorApi. globals: ${diag.keys.join(",") || "(none)"} · installEditorApi: ${diag.install} · after manual install: ${diag.after}`);
  if (!diag.after) { await browser.close(); process.exit(1); }
  console.log("  recovered by installing the API manually");
}

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try {
      return { ok: true, value: await globalThis.__editorApi.call(op, args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, { op, args });

const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

// The project boots its own scene (project.json mainScene) — wait for entities.
// Polled from Node, NOT via waitForFunction: every op returns a PROMISE, so a
// sync predicate inside the page inspects the promise object and its
// `.rootEntityIds` is forever undefined (this cost a run).
let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
if (!entities.length) { console.log("FATAL: scene never populated"); await browser.close(); process.exit(1); }
const sceneInfo = await call("scene.get", {});
console.log(`  scene "${sceneInfo.ok ? sceneInfo.value?.name ?? "?" : "?"}" open — ${entities.length} entities`);
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
const sun = entities.find((e) => {
  const light = componentOf(e, "light");
  return light && (light.props?.kind ?? "directional") === "directional";
});
const giEntity = entities.find((e) => componentOf(e, "global-illumination"));
if (!sun) { console.log("FATAL: no directional light in the scene"); await browser.close(); process.exit(1); }
if (!giEntity) { console.log("FATAL: no global-illumination component in the scene"); await browser.close(); process.exit(1); }
const gi = componentOf(giEntity, "global-illumination");
console.log(`  sun: "${sun.name}"   GI on "${giEntity.name}" (enabled ${gi.props?.enabled}, quality ${gi.props?.quality}, killSdf ${gi.props?.killSdf}, intensity ${gi.props?.intensity})`);

const sponza = entities.find((e) => /sponza/i.test(e.name ?? "")) ?? giEntity;
if (QUALITY) {
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "quality", value: QUALITY });
  console.log(`  quality forced to ${QUALITY}`);
}

// Wait for the GI build + compile wave to finish before measuring anything.
for (let i = 0; i < 90 && !built; i++) await wait(1000);
await wait(12000);

// GI MUST ACTUALLY BE ON. The scene on disk can be saved with the component
// unchecked (it was — the user's last manual test disabled it), and then every
// A/B here reads 0.00000 and looks like "GI contributes nothing" when in fact
// GI was never running. Force it, and wait for the build.
if (gi.props?.enabled === false) {
  console.log("  GI was DISABLED in the saved scene — enabling it");
  built = false;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
  for (let i = 0; i < 240 && !built; i++) await wait(500);
  await wait(10000);
}

// Camera: FRAME THE MODEL WITH THE EDITOR'S OWN FOCUS, then dolly in along the
// same view ray until we are inside it. Deriving a pose from entity.getBounds
// put the camera at y = -11 (that call returned a 48.5m cube, not the nave), so
// the "scene" being measured was Sponza's underside.
await must("viewport.focus", { id: sponza.id });
await wait(1200);
const framed = await call("viewport.getCamera", {});
if (framed.ok && framed.value?.position && framed.value?.target) {
  const t0 = framed.value.target;
  // STAND INSIDE THE NAVE — run-gi-shot's verified pose. The old 18%-dolly
  // along the focus ray was "verified good" once, but `viewport.focus` on this
  // scene now lands on the ROOF (the documented run-gi-shot trap), so the
  // dolly parked the camera in the rafters staring at blown-out roof tiles —
  // and every chroma/leak number measured the roof: an attribution change
  // that visibly recoloured the atrium live measured BYTE-IDENTICAL here.
  // Focus target = model centre; drop near floor level and look down the
  // long (x) axis, straight at the curtain colonnade.
  // THE USER'S OWN GAME-CAMERA POSE, hardcoded from scenes/Main.scene: their
  // Camera entity stands at (10.59, 0.64, -0.35) at the nave's east end
  // looking down -x past the test sphere at (6.81, 1.49) — the exact view of
  // every screenshot they judge GI by (floor + curtain colonnade + sphere).
  // Every t0-derived heuristic failed here: `viewport.focus` targets the
  // COMBINED bounds centre (y=11.2 — mid-air), "-7.2" landed the eye inside
  // second-floor masonry (0.07 lum, 0/84 tiles), and the scene centre holds
  // the sphere itself (0.00 lum). If the user moves the building, re-derive
  // from their Camera entity, not from focus.
  // POSE FROM THE TEST SPHERE, verified by probe (run-gi-campose-probe):
  // 5m east of it at eye height looking west down the colonnade — interior,
  // curtains left and right, floor filling the lower frame. Every t0-derived
  // heuristic failed on this scene (focus targets the combined bounds centre
  // in mid-air; the scene centre holds the sphere; "-7.2" landed inside
  // second-floor masonry).
  const pos = [11.8, 2.2, 0.73];
  const look = [-3.2, 1.0, -1.47];
  await must("viewport.setCamera", { position: pos, target: look });
  console.log(`  camera ${pos.map((v) => v.toFixed(1))} → ${look.map((v) => v.toFixed(1))} (inside nave, -x)`);
}

// SUN ANGLES ARE DELTAS FROM THE SAVED ROTATION, NOT ABSOLUTE. The scene's
// sun is saved at rotation [-1.863, 0, 0.02] (intensity 50) and that is the
// lighting every user screenshot is judged under; the old absolute
// [pitch, 0.35, 0] family lit the ROOF nicely and left the interior almost
// black at every pitch tried (probe-verified), so interior chroma/leak
// numbers measured nothing. delta 0 = the user's lighting; delta 180 flips
// the sun to the opposite hemisphere for the leak's dark frame.
const sunRot0 = (await must("entity.get", { id: sun.id }))?.rotation ?? [-1.863, 0, 0.02];
console.log(`  sun saved rotation: [${sunRot0.map((v) => (+v).toFixed(3))}]`);
const setSunPitch = (deg) =>
  must("entity.setTransform", {
    id: sun.id,
    rotation: [sunRot0[0] + (deg * Math.PI) / 180, sunRot0[1], sunRot0[2]],
  });

// SOME PROPS REBUILD. Setting `enabled` (or `killSdf`, or `quality`) tears down
// and rebuilds the GI state, and the viewport is SUSPENDED through the compile
// wave — so a fixed sleep captures a black frame and the A/B reports GI as
// *darker* than no GI. Watch for the module's own "[gi] built" line instead.
async function setGiProp(key, value, { rebuilds = false } = {}) {
  built = false;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key, value });
  if (!rebuilds) { await wait(2500); return; }
  for (let i = 0; i < 180 && !built; i++) await wait(500);
  if (!built) console.log(`  (warning: no "[gi] built" after setting ${key}=${value})`);
  await wait(9000); // compile wave + a few frames for the field to converge
}
// GI ON/OFF VIA `intensity`, NOT `enabled`. `enabled` tears down and rebuilds
// the whole GI state and suspends the viewport through the compile wave, so the
// A/B captured black frames and reported GI as darker than no GI (twice). Both
// `intensity` and `bounce` are LIVE props — GISystem's #applyLiveProps just
// writes a uniform — so this is the same picture with the GI term scaled to
// zero, no rebuild, no suspension, no black frames.
const giIntensity = gi.props?.intensity ?? 1;
const setGi = (on) => setGiProp("intensity", on ? giIntensity : 0);

let seq = 0;
async function floorLuminance(label) {
  const shot = await must("viewport.screenshot", { width: 900, height: 600, includeGizmos: false });
  const png = Buffer.from(shot.__image.base64, "base64");
  if (SHOT) await writeFile(path.join(SHOT, `sponza-${seq++}-${label}.png`), png);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  // WHOLE FRAME, not a strip. Gizmos/grid/outlines are already excluded by the
  // screenshot op, and a whole-frame mean cannot land on a black corner the way
  // a hand-picked rectangle did. Colour bleed shows up in the channel spread
  // below, which a luminance-only metric would hide.
  const x0 = 0, x1 = info.width, y0 = 0, y1 = info.height;
  let sum = 0, n = 0;
  const chan = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      const lin = [data[i], data[i + 1], data[i + 2]].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      sum += 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      chan[0] += lin[0]; chan[1] += lin[1]; chan[2] += lin[2];
      n++;
    }
  }
  // PER-TILE luminance as well as the global mean. A whole-frame average is
  // blind to the artifact actually reported — probe-lattice-sized blocks
  // popping as the light sweeps — because one block brightening while another
  // darkens cancels exactly. Both backends scored 0/8 global reversals on a
  // sweep the user describes as visibly jumpy; this is the metric that can see
  // it.
  const TX = 12, TY = 8;
  const tiles = new Array(TX * TY).fill(0);
  const tileN = new Array(TX * TY).fill(0);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const lin = [data[i], data[i + 1], data[i + 2]].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      const t = Math.min(TY - 1, Math.floor((y / info.height) * TY)) * TX
        + Math.min(TX - 1, Math.floor((x / info.width) * TX));
      tiles[t] += 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      tileN[t]++;
    }
  }
  for (let t = 0; t < tiles.length; t++) tiles[t] /= Math.max(1, tileN[t]);
  const mean = [chan[0] / n, chan[1] / n, chan[2] / n];
  // Chroma = how far the frame's mean colour is from neutral grey. Colour bleed
  // IS chroma that GI adds, so this is the number that answers "does SDF-free
  // bleed colour" without me squinting at two screenshots.
  const avg = (mean[0] + mean[1] + mean[2]) / 3;
  const chroma = Math.max(...mean.map((c) => Math.abs(c - avg))) / Math.max(avg, 1e-6);
  return { lum: sum / n, chroma, mean, tiles };
}

// One GI-on/GI-off subtraction at a given sun pitch. Both toggles rebuild, and
// setGi waits for the rebuild, so the "on" frame is a real rendered frame.
async function sample(pitchDeg, label) {
  await setSunPitch(pitchDeg);
  await setGi(true);
  const on = await floorLuminance(`${label}-on`);
  await setGi(false);
  const off = await floorLuminance(`${label}-off`);
  await setGi(true);
  return { on, off, added: on.lum - off.lum, addedChroma: on.chroma - off.chroma };
}

async function report(modeLabel) {
  console.log(`\n=== ${modeLabel} ===`);
  // Pitch is the light entity's X rotation: positive pitches the sun down onto
  // the floor from above, negative puts it UNDER the floor shining up.
  // LABEL BY WHAT WAS MEASURED, NOT BY MY SIGN CONVENTION. The light entity's
  // +X rotation turned out to be the DARK direction, so the first run reported
  // the lit case as "sun below" and vice versa. Whichever pitch renders brighter
  // with GI off is the lit one, by definition — no convention to get wrong.
  // Delta 0 = the user's saved lighting (the lit case by construction);
  // delta 180 flips the sun to the opposite hemisphere (the leak's dark
  // frame). The brighter-off-frame auto-selection below stays as the guard.
  const s1 = await sample(0, `${modeLabel}-p0`);
  const s2 = await sample(180, `${modeLabel}-p180`);
  const lit = s1.off.lum >= s2.off.lum ? s1 : s2;
  const dark = lit === s1 ? s2 : s1;
  console.log(`  LIT  frame  GI on ${lit.on.lum.toFixed(5)}  off ${lit.off.lum.toFixed(5)}  ADDED ${lit.added.toFixed(5)}   chroma added ${lit.addedChroma.toFixed(4)}`);
  console.log(`  DARK frame  GI on ${dark.on.lum.toFixed(5)}  off ${dark.off.lum.toFixed(5)}  ADDED ${dark.added.toFixed(5)}   chroma added ${dark.addedChroma.toFixed(4)}`);
  // A frame with NO direct light has no legitimate indirect to receive from the
  // surfaces in it. Light GI puts there, relative to what it puts on a fully lit
  // frame, is the leak — and >100% means it lights the dark more than the lit.
  const leak = lit.added > 1e-5 ? (dark.added / lit.added) * 100 : Infinity;
  console.log(`  LEAK ${Number.isFinite(leak) ? `${leak.toFixed(0)}%` : "n/a"}  = indirect added to the UNLIT frame / indirect added to the lit frame`);
  if (lit.added <= 1e-5) console.log("  !! CONTROL: GI adds nothing even to the lit frame.");
  const above = lit, below = dark;

  // FLICKER: sweep the sun and watch frame-to-frame luminance. A converging
  // field drifts one way; a popping lattice reverses direction repeatedly.
  // Sweep through the LIT range — flicker is what the user sees in a lit scene,
  // and a sweep through the dark side measures only the leak's own wobble. (Two
  // earlier ranges swept the dark side and reported ~0.0003 black frames.)
  //
  // Swept TWICE: once with GI on, once with GI off. Direct light and shadow maps
  // vary smoothly with the sun, so whatever excess popping the GI-on pass shows
  // over the GI-off pass is GI's own — no absolute threshold to argue about.
  //
  // AND IT IS SAMPLED WHILE THE LIGHT IS STILL MOVING. The reported artifact is
  // "when the light MOVES, lighting flickers" — a TRANSIENT. Stepping the sun
  // 5° and then waiting 1.4 s samples only settled states, which is why the
  // first version scored 0/84 popping tiles in both backends and with GI both
  // on and off, contradicting what is plainly visible. Fine steps with NO
  // settle keep the field permanently chasing the light, which is the condition
  // being complained about.
  async function sweep(giOn) {
    await setGi(giOn);
    const frames = [];
    for (let i = 0; i < 24; i++) {
      await setSunPitch(-55 + i * 1.5);
      frames.push(await floorLuminance(`${modeLabel}-sweep${giOn ? "on" : "off"}${i}`));
    }
    const lums = frames.map((f) => f.lum);
    const nTiles = frames[0].tiles.length;
    let popping = 0;
    let popped = 0;
    // A low usable-tile count means the camera is looking at nothing — that has
    // silently invalidated three runs, so it is reported, not assumed.
    for (let t = 0; t < nTiles; t++) {
      const series = frames.map((f) => f.tiles[t]);
      if (Math.max(...series) < 0.002) continue; // a tile that is black throughout says nothing
      const d = series.slice(1).map((v, i) => v - series[i]);
      const scale = d.reduce((a, b) => a + Math.abs(b), 0) / d.length;
      let rev = 0;
      for (let i = 1; i < d.length; i++) {
        if (d[i] * d[i - 1] < 0 && Math.abs(d[i]) > scale * 0.5) rev++;
      }
      popping++;
      if (rev >= 2) popped++;
    }
    return { lums, popping, popped, pct: popping ? (popped / popping) * 100 : 0 };
  }
  const onSweep = await sweep(true);
  const offSweep = await sweep(false);
  console.log(`  sweep(GI on)  ${onSweep.lums.map((l) => l.toFixed(4)).join(" ")}`);
  console.log(`  tiles popping: GI on ${onSweep.popped}/${onSweep.popping} (${onSweep.pct.toFixed(0)}%)   GI off ${offSweep.popped}/${offSweep.popping} (${offSweep.pct.toFixed(0)}%)   EXCESS ${(onSweep.pct - offSweep.pct).toFixed(0)} pts`);
  await setGi(true);
  return { below, above, popExcess: onSweep.pct - offSweep.pct, onPct: onSweep.pct, offPct: offSweep.pct };
}

// A/B the two field backends in ONE run — that is the comparison the user made
// by eye ("sdf bleeds colour, sdf-free barely does"), now as numbers.
const startKillSdf = gi.props?.killSdf === true;
const a = await report(startKillSdf ? "SDF-FREE (killSdf on)" : "SDF (killSdf off)");
if (process.env.BOTH !== "0") {
  await setGiProp("killSdf", !startKillSdf, { rebuilds: true });
  const b = await report(!startKillSdf ? "SDF-FREE (killSdf on)" : "SDF (killSdf off)");
  console.log(`\n--- side by side ---`);
  console.log(`  indirect added (sun above): ${a.above.added.toFixed(5)}  vs  ${b.above.added.toFixed(5)}`);
  console.log(`  colour bleed (chroma):      ${a.above.addedChroma.toFixed(4)}  vs  ${b.above.addedChroma.toFixed(4)}`);
  console.log(`  leak (sun below):           ${a.below.added.toFixed(5)}  vs  ${b.below.added.toFixed(5)}`);
  console.log(`  flicker (excess popping):   ${a.popExcess.toFixed(0)} pts  vs  ${b.popExcess.toFixed(0)} pts`);
}

await browser.close();
process.exit(0);
