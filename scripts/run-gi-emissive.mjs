// EMISSIVE-MESH LIGHTING under the occupancy backend — the "Emissive Shadows
// makes it terrible" repro (user report 2026-08-03).
//
// Drives the user's REAL project (scenes/Main.scene is now a 5m Cornell box
// with an emissive CUBE at (-0.28, 2.21, 1.29), side 1.225). The GI component
// prop `emissiveShadows` switches emissive meshes between two completely
// different light models, which is why it is not just "shadows on/off":
//   false → the mesh stays a FIELD emissive source (voxel radiance, bounce only)
//   true  → the mesh is STRIPPED from the field and re-injected as an analytic
//           box AREA LIGHT with a sphere-traced penumbra, on BOTH the field
//           side (cascadeGather feedback) and the receiver side (giScreen
//           resolve). User: ON looks terrible, OFF looks perfectly fine.
//
// Arms bisect which half of the ON path is at fault:
//   off            baseline (user: fine)
//   on             the reported break
//   on-nofieldshad ON + __giNoFieldShadows=1 (live uniform) — field-side
//                  emitter/analytic shadows forced open. Artifact persists
//                  ⇒ it is born in the RECEIVER-side resolve trace.
//   on-noao        ON + aoStrength 0 (live) — rules out session 19's AO.
//
// Metrics per arm, over wall/floor/ceiling patches that EXCLUDE the emitter
// and the block: mean luminance, and `blotch` = mean |lum - blur(lum)| / mean,
// the high-frequency energy that a grid-aligned voxel artifact shows up in.
//
//   node scripts/run-gi-emissive.mjs
// Env: PROJECT, SHOT=scripts, HEADED=1, ARMS=off,on,...
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
// Default to a GENERATED, frozen project. Pointing at the user's own GAME
// project measures a scene they are actively editing (autosave rewrote the GI
// props three times inside one run) and it carries a directional light at
// intensity 50 that blows the room out through the open front.
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell")).replaceAll("\\", "/");
if (!process.env.PROJECT) {
  await makeCornellProject(GEN_ROOT, {
    wallThickness: Number(process.env.WALL_T ?? 0.1),
    emitStrength: Number(process.env.EMIT ?? 1),
  });
  console.log(`  generated repro project at ${GEN_ROOT}`);
}
const PROJECT = (process.env.PROJECT ?? GEN_ROOT).replaceAll("\\", "/");
const SHOT = process.env.SHOT ?? "scripts";
const W = 1100, H = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    // Round-15 rule: an occluded window gets ~1/s timer throttling and every
    // wall-time (and every settle wait) becomes fiction.
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built++;
  // Permissive on purpose: the first run's narrow filter hid the storage-limit
  // downgrade warning AND the backend-coercion warning, and the run read as
  // "GI built fine" while contributing zero light.
  if (/\[gi\]|\[engine\]|webgpu|adapter|limit|storage/i.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});
await page.evaluateOnNewDocument((P) => {
  localStorage.setItem("engine.projectRoot.v1", P);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
}, PROJECT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });
const must = async (op, args) => {
  const r = await call(op, args);
  if (!r.ok) throw new Error(`${op} failed: ${r.error}`);
  return r.value;
};

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
// Session-18 trap: never take the FIRST entity carrying a gi component —
// filter on the component's own enabled flag.
const giCands = entities.filter((e) => componentOf(e, "global-illumination"));
const gi = giCands.find((e) => componentOf(e, "global-illumination")?.props?.enabled !== false) ?? giCands[0];
if (!gi) { console.log("FATAL: no GI entity"); await browser.close(); process.exit(1); }
const p0 = componentOf(gi, "global-illumination").props ?? {};
console.log(`  gi "${gi.name}": backend=${p0.backend} quality=${p0.quality} voxel=${p0.voxelSize} ` +
            `emissiveShadows=${p0.emissiveShadows} ao=${p0.ao}/${p0.aoStrength} resolveScale=${p0.resolveScale}`);

const setGi = (key, value) => must("component.setProp", { id: gi.id, type: "global-illumination", key, value });
const setFlag = (name, value) => page.evaluate(({ n, v }) => { globalThis[n] = v; }, { n: name, v: value });
// Readback — a set that silently no-ops makes every downstream arm a lie
// (first run: `off` and `on` were byte-identical because nothing changed).
const giProps = async () => {
  const list = await must("entity.list", {});
  const e = list.find((x) => x.id === gi.id);
  return (e.components ?? []).find((c) => c.type === "global-illumination")?.props ?? {};
};

for (let i = 0; i < 90 && built === 0; i++) await wait(1000);
await wait(8000);

// The generated project has no light at all. When driving the user's OWN
// project instead, their directional light (intensity 50) blows the room out.
const sun = entities.find((e) => componentOf(e, "light"));
if (sun && process.env.KEEPSUN !== "1") {
  await must("entity.setEnabled", { id: sun.id, enabled: false });
  console.log(`  sun "${sun.name}" disabled (KEEPSUN=1 to keep)`);
}

// Room x∈[-2.5,2.5] y∈[0,5] z∈[-2.5,2.5], open toward +z. Stand just outside
// the opening looking down -z (their own saved camera pose). Distance tuned so
// the box FILLS the frame — the first pose (z=8.6) left it at 70% height and
// every wall patch sampled the black surround, reporting mean 0.000 both arms.
await must("viewport.setCamera", { position: [0.0, 2.6, 6.0], target: [0.0, 2.5, -1.0] });
await wait(1500);

if (process.env.DIAG === "1") {
  console.log("\n== DIAG");
  console.log(`   props: ${JSON.stringify(await giProps())}`);
  // The run-gi-sponza CONTROL: `intensity` is a LIVE uniform, so 0 vs 1
  // isolates GI's own contribution without a rebuild. Identical frames here
  // mean the field is empty and every later number is meaningless.
  for (const iv of [1, 0]) {
    await setGi("intensity", iv);
    await wait(2500);
    const s = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
    const buf = Buffer.from(s.__image.base64, "base64");
    await writeFile(path.join(SHOT, `gi-emissive-diag-int${iv}.png`), buf);
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      sum += (0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2]) / 255;
    }
    console.log(`   intensity ${iv}: frame mean lum ${(sum / (info.width * info.height)).toFixed(5)}`);
  }
  await setGi("intensity", p0.intensity ?? 1);
  await wait(2000);
}

// Patches in SCREENSHOT pixel space, chosen to miss the emissive cube (left of
// centre, upper-mid) and the tall block (right of centre). Verified against the
// arm-1 frame — LOOK at the dumped shots before trusting any number.
const PATCHES = [
  { name: "ceiling", x: 0.37, y: 0.02, w: 0.26, h: 0.10 },
  { name: "redwall", x: 0.23, y: 0.30, w: 0.10, h: 0.35 },
  { name: "greenwall", x: 0.68, y: 0.30, w: 0.10, h: 0.35 },
  { name: "floor", x: 0.37, y: 0.74, w: 0.26, h: 0.16 },
];

async function measure(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = new Float64Array(info.width * info.height);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2]) / 255;
  }
  // 9x9 box blur, then |lum - blur| = the high-frequency energy a grid-aligned
  // voxel artifact lives in (a smooth gradient scores ~0 no matter how dark).
  const R = 4;
  const out = [];
  for (const patch of PATCHES) {
    const x0 = Math.round(patch.x * info.width), y0 = Math.round(patch.y * info.height);
    const x1 = Math.round((patch.x + patch.w) * info.width), y1 = Math.round((patch.y + patch.h) * info.height);
    let sum = 0, hf = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let bs = 0, bn = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const sx = x + dx, sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) continue;
            bs += lum[sy * info.width + sx]; bn++;
          }
        }
        const v = lum[y * info.width + x];
        sum += v; hf += Math.abs(v - bs / bn); n++;
      }
    }
    const mean = sum / n;
    out.push({ name: patch.name, mean, blotch: hf / n / Math.max(mean, 1e-4) });
  }
  return out;
}

const results = [];
async function arm(name, setup, settle = 16000) {
  console.log(`\n== arm ${name}`);
  const before = built;
  await setup();
  await wait(settle);
  const pr = await giProps();
  console.log(`   emissiveShadows=${pr.emissiveShadows} aoStrength=${pr.aoStrength} ` +
              `rebuilds=${built - before} noFieldShadows=${await page.evaluate(() => globalThis.__giNoFieldShadows === true)}`);
  const s = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  const buf = Buffer.from(s.__image.base64, "base64");
  await writeFile(path.join(SHOT, `gi-emissive-${name}.png`), buf);
  const m = await measure(buf);
  results.push({ name, m });
  for (const r of m) {
    console.log(`   ${r.name.padEnd(10)} mean ${r.mean.toFixed(4)}  blotch ${r.blotch.toFixed(4)}`);
  }
}

const ARMS = (process.env.ARMS ?? "off,on,on-nofieldshad,on-noao").split(",");
const run = {
  // emissiveShadows is STRUCTURAL (in #structuralSignature) — each toggle is a
  // full GI rebuild plus a material compile wave, hence the long settle.
  "off": () => arm("off", async () => {
    await setFlag("__giNoFieldShadows", false);
    await setGi("emissiveShadows", false);
  }, 20000),
  "on": () => arm("on", async () => {
    await setFlag("__giNoFieldShadows", false);
    await setGi("emissiveShadows", true);
  }, 20000),
  "on-nofieldshad": () => arm("on-nofieldshad", async () => {
    await setFlag("__giNoFieldShadows", true);
  }, 8000),
  "on-noao": () => arm("on-noao", async () => {
    await setFlag("__giNoFieldShadows", false);
    await setGi("aoStrength", 0);
  }, 8000),
  // Receiver-side emitter shadow forced open (live uniform).
  "on-norecvshad": () => arm("on-norecvshad", async () => {
    await setFlag("__giNoFieldShadows", false);
    await setFlag("__giNoEmitterShadows", true);
  }, 8000),
  // BOTH emitter shadow terms open. Whatever mottling survives THIS is not a
  // shadow-trace artifact at all — it is the emitter's geometric/normal term.
  "on-noshad": () => arm("on-noshad", async () => {
    await setFlag("__giNoFieldShadows", true);
    await setFlag("__giNoEmitterShadows", true);
  }, 8000),
};
for (const a of ARMS) {
  if (!run[a]) { console.log(`  (unknown arm ${a})`); continue; }
  try { await run[a](); } catch (e) { console.log(`  arm ${a} FAILED: ${e.message}`); }
}
// Restore the user's saved values so the harness never edits their scene state.
await setGi("aoStrength", p0.aoStrength ?? 0.6);
await setGi("emissiveShadows", p0.emissiveShadows !== false);

console.log("\n== summary (blotch = high-freq energy / mean)");
const base = results.find((r) => r.name === "off");
for (const r of results) {
  const parts = r.m.map((x, i) => {
    const b = base?.m[i];
    const dm = b ? ` (${((x.mean / Math.max(b.mean, 1e-6) - 1) * 100).toFixed(0)}%)` : "";
    return `${x.name} ${x.mean.toFixed(3)}${dm}/${x.blotch.toFixed(3)}`;
  });
  console.log(`  ${r.name.padEnd(16)} ${parts.join("  ")}`);
}
await browser.close();
process.exit(0);
