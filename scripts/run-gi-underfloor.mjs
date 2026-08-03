// ⚠️ NOT WORKING YET — DO NOT TRUST ITS NUMBERS. The scene builds and GI
// builds (the `[gi] built` line is correct: 16x14x16, volume 4 m under the
// floor, 1 light collected), but the VIEWPORT never shades it: every sample
// comes back byte-identical across GI on/off, across sun elevations, and
// across separate browser launches. A dumped frame (SHOT=<dir>) shows the
// boxes as flat dark silhouettes with white outlines and the stats overlay
// reading "Draw calls 0 / Triangles 0" — i.e. what is on screen is the editor
// OVERLAY over a stale frame, not a render of this scene. Fix that before
// reading anything else here. Things already ruled out: the sample rectangle
// (it is on the floor), page-vs-canvas coordinates (it screenshots the canvas
// now), `kind: "directional"` (that IS the LightComponent's prop name), and
// poking object3D instead of the entity transform (both behave the same).
//
// THE USER'S TOPOLOGY, WHICH NO EXISTING HARNESS HAS: a THIN floor with OPEN
// AIR ON BOTH SIDES, inside a GI volume that deliberately extends BELOW it,
// lit by a sun that is UNDER the floor.
//
// Why the existing tests cannot see this bug:
//   · run-gi-sun-leak     — SEALED box. "Below the floor" is outside the box,
//                           and auto-fit ends the volume at the box, so there
//                           are no probes in lit air under the floor. Passes
//                           at ELEVATION=-60 with a leak of exactly 0.
//   · run-gi-rc-splitroom — the slab is THICK (the field resolves both faces)
//                           and the lamp is above it. Insensitive: the numbers
//                           are identical with and without every cut added so
//                           far.
// Both of those are still worth keeping — they are the regression net. This one
// is the reproduction.
//
// The measurement is a subtraction, so no reference renderer is needed:
//   sun BELOW the floor → GI must add ~nothing to the floor's TOP face
//                         (nothing above the floor is lit, so there is no
//                          indirect for it to carry)
//   sun ABOVE the floor → GI must add a clearly positive amount
//                         (this is the control: it proves the cuts under test
//                          did not simply switch GI off)
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-underfloor.mjs
//
// Env: HEADED=1 · QUALITY=low · BELOW_VOLUME=4 (metres of volume under the
// floor — the ingredient that matters) · HATCH="__giNoParentVis" to A/B a cut.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const QUALITY = process.env.QUALITY ?? "low";
const BELOW_VOLUME = Number(process.env.BELOW_VOLUME ?? 4);
const HATCH = process.env.HATCH ?? "";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy|GI-UF|warn/.test(t)) console.log(`  ${t}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));

if (HATCH) await page.evaluateOnNewDocument((h) => { globalThis[h] = true; }, HATCH);

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

await page.evaluate(async ({ QUALITY, BELOW_VOLUME }) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  const mat = (r, g, b) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    m.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    return m;
  };
  const box = (size, position, material, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.scene.add(mesh);
    return mesh;
  };

  // THIN floor — 0.2 m, the Sponza number. Open above AND below.
  box([14, 0.2, 14], [0, -0.1, 0], mat(0.6, 0.58, 0.54), "floor");
  // A colonnade down each side: enough geometry to make an interior, with the
  // ends and the sky left open (Sponza's nave, in miniature).
  for (let i = -2; i <= 2; i++) {
    box([0.7, 5, 0.7], [-3.5, 2.5, i * 3], mat(0.6, 0.58, 0.54), `col-l${i}`);
    box([0.7, 5, 0.7], [3.5, 2.5, i * 3], mat(0.6, 0.58, 0.54), `col-r${i}`);
  }
  box([0.5, 3.2, 14], [-4.6, 3.6, 0], mat(0.55, 0.12, 0.1), "curtain-l");
  box([0.5, 3.2, 14], [4.6, 3.6, 0], mat(0.1, 0.45, 0.14), "curtain-r");

  const lightEntity = engine.createEntity({ name: "Sun" });
  lightEntity.addComponent("light", { kind: "directional", intensity: 3, color: "#ffffff", castShadow: true });
  globalThis.__sun = lightEntity;

  // AUTO-FIT OFF and the box pushed DOWN, so there is genuinely lit open air
  // under the floor with probes in it. This is the whole point of the test.
  const giEntity = engine.createEntity({ name: "GI" });
  const sizeY = 10 + BELOW_VOLUME;
  giEntity.object3D.position.set(0, 5 - BELOW_VOLUME / 2, 0);
  giEntity.addComponent("global-illumination", {
    autoFit: false,
    sizeX: 16,
    sizeY,
    sizeZ: 16,
    quality: QUALITY,
    intensity: 1,
    enabled: true,
  });
  globalThis.__gi = giEntity;

  // Looking down the nave at the floor, camera above it.
  engine.camera.position.set(0, 1.9, 6.5);
  engine.camera.lookAt(0, 0.2, -2);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-UF scene ready");
}, { QUALITY, BELOW_VOLUME });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.waitForFunction(
  () => [...document.querySelectorAll("canvas")].some((c) => c.width > 300 && c.height > 200),
  { timeout: 45000 },
);
await page.evaluate(() => {
  globalThis.__engine.scene.traverse((o) => {
    if (o.isGridHelper || o.isLineSegments || o.type === "AxesHelper") o.visible = false;
  });
});

// Set the ENTITY transform, not object3D directly: the Engine writes entity →
// object3D every frame, so poking object3D is overwritten on the next tick.
const setSun = (elevationDeg) =>
  page.evaluate((deg) => {
    const el = (deg * Math.PI) / 180;
    globalThis.__sun.position = [Math.cos(el) * 20, Math.sin(el) * 20, 5];
  }, elevationDeg);
const setGi = (on) =>
  page.evaluate((v) => { globalThis.__gi.getComponent("global-illumination").enabled = v; }, on);

// Screenshot the CANVAS, not the page: sampling page coordinates makes every
// region fraction depend on editor chrome, which is how a harness ends up
// measuring a toolbar and reporting it as scene luminance.
async function canvasHandle() {
  const handles = await page.$$("canvas");
  let best = null;
  let bestArea = 0;
  for (const h of handles) {
    const box = await h.boundingBox();
    const area = box ? box.width * box.height : 0;
    if (area > bestArea) { bestArea = area; best = h; }
  }
  if (!best) throw new Error("no canvas");
  return best;
}

// Floor strip, low in frame and off-centre — clear of the transform gizmo and
// the grid's axis line (both have burned this module's harnesses before).
let shotSeq = 0;
async function floorLuminance(label = "") {
  const png = await (await canvasHandle()).screenshot();
  if (process.env.SHOT) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${process.env.SHOT}/uf-${shotSeq++}-${label}.png`, png);
  }
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  if (process.env.SHOT) console.log(`  shot ${label}: ${info.width}x${info.height}x${info.channels}`);
  const x0 = Math.floor(info.width * 0.15), x1 = Math.floor(info.width * 0.42);
  const y0 = Math.floor(info.height * 0.72), y1 = Math.floor(info.height * 0.95);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      const srgb = [data[i], data[i + 1], data[i + 2]].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      sum += 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
      n++;
    }
  }
  return sum / n;
}

async function sample(elevationDeg) {
  await setSun(elevationDeg);
  await setGi(true);
  await settle(9000);
  const on = await floorLuminance(`e${elevationDeg}-on`);
  await setGi(false);
  await settle(4000);
  const off = await floorLuminance(`e${elevationDeg}-off`);
  return { on, off, added: on - off };
}

console.log(`\n=== thin floor, open above and below, ${BELOW_VOLUME}m of GI volume UNDER it ===`);
console.log(`quality ${QUALITY}${HATCH ? `, hatch ${HATCH}=true` : ""}`);
const below = await sample(-50);
const above = await sample(50);
console.log(`  sun BELOW (-50deg)  GI on ${below.on.toFixed(5)}  off ${below.off.toFixed(5)}  ADDED ${below.added.toFixed(5)}`);
console.log(`  sun ABOVE (+50deg)  GI on ${above.on.toFixed(5)}  off ${above.off.toFixed(5)}  ADDED ${above.added.toFixed(5)}`);
const ratio = above.added > 1e-6 ? below.added / above.added : Infinity;
console.log(`\n  leak fraction = below.added / above.added = ${(ratio * 100).toFixed(1)}%`);
console.log(`  (0% = no under-floor light reaches the top face; the control above must stay positive)`);
if (above.added <= 0.0005) console.log("  !! CONTROL FAILED: GI adds nothing even with the sun ABOVE — a cut has switched GI off, not fixed it.");
await browser.close();
process.exit(0);
