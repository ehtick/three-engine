// VIEW-TRANSFORM A/B ON THE REAL SCENE — the control that has to run BEFORE
// any "our GI looks different from Blender" comparison is worth reading.
//
// A render is `transform(radiance)`. Blender 4.x defaults its View Transform to
// AgX, which desaturates as values approach white and rolls highlights off; the
// user's Sponza scene has been saving "aces" and "linear". Comparing an ACES or
// linear frame against an AgX frame says almost nothing about the underlying
// light transport — saturation and shadow depth are exactly the two things the
// transform changes most, and they are exactly the two things being compared.
//
// So: same scene, same camera, same GI, ONE frame per transform. Whatever
// difference survives matching the transform is a real transport difference and
// is worth chasing; whatever doesn't, isn't.
//
// Also prints, per frame, the mean luminance of a SHADOWED patch and a SUNLIT
// patch plus a chroma measure, so "more saturated / less white fill" becomes a
// number instead of an impression.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-tonemap.mjs
//
// Env:
//   PROJECT=<path>       default C:/Users/Khudiiash/Documents/GAME
//   TRANSFORMS=agx,aces,neutral,linear
//   OUT=<dir>            default .gi-shots/tonemap
//   POS=x,y,z TARGET=x,y,z   camera override
//   HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const TRANSFORMS = (process.env.TRANSFORMS ?? "agx,aces,neutral,linear").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT ?? ".gi-shots/tonemap";
const parseVec = (s, fallback) => (s ? s.split(",").map(Number) : fallback);
const POS = parseVec(process.env.POS, [11.8, 2.2, 0.73]);
const TARGET = parseVec(process.env.TARGET, [-3.2, 1.0, -1.47]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
// READ-ONLY: the shim refuses every write, so flipping the scene's tone mapping
// here cannot reach the project on disk. The autosave failures in the console
// are that guard working.
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|\[gi\] occupancy backend/.test(t)) console.log(`  ${t.slice(0, 150)}`);
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

console.log(`Opening ${PROJECT} …`);
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

for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) break;
  await wait(1000);
}
for (let i = 0; i < 120 && !built; i++) await wait(1000);
// GI needs its quiet frames before the field is converged — a frame grabbed
// mid-convergence is a measurement of the EMA, not of the lighting.
await wait(12000);

const before = await must("scene.getSettings", {});
const savedTone = before.settings?.toneMapping ?? "neutral";
console.log(`  scene tone mapping (saved): ${savedTone}   exposure ${before.settings?.exposure ?? 1}`);
console.log(`  available: ${(before.toneMappings ?? []).join(", ")}`);

await must("viewport.setCamera", { position: POS, target: TARGET });
await wait(2000);

// Two patches, chosen to separate the user's two observations:
//   shadow — arcade floor out of direct sun: this is PURE indirect, so its
//            level is "how much white fill does the bounce deliver".
//   sun    — a directly lit floor patch: the reference the eye normalises to.
// Chroma = mean |channel - luminance| / luminance over the patch: how far the
// indirect has been tinted away from neutral.
const patchStats = async (png) =>
  page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const patch = (x0, y0, x1, y1) => {
      const w = Math.max(1, Math.round((x1 - x0) * img.width));
      const h = Math.max(1, Math.round((y1 - y0) * img.height));
      const d = g.getImageData(Math.round(x0 * img.width), Math.round(y0 * img.height), w, h).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      r /= n * 255; gg /= n * 255; b /= n * 255;
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const chroma = lum > 1e-4 ? (Math.abs(r - lum) + Math.abs(gg - lum) + Math.abs(b - lum)) / (3 * lum) : 0;
      return { lum, chroma, rgb: [r, gg, b] };
    };
    return {
      // Left arcade, in shadow — indirect only.
      shadow: patch(0.06, 0.55, 0.20, 0.75),
      // Centre floor down the nave — mixed, and where "the far end goes black".
      far: patch(0.44, 0.62, 0.56, 0.72),
      // Bright floor slab catching the sun.
      sun: patch(0.30, 0.80, 0.45, 0.92),
    };
  }, png);

const rows = [];
for (const tone of TRANSFORMS) {
  await must("scene.setSettings", { patch: { toneMapping: tone } });
  await wait(1800);
  const shot = await must("viewport.screenshot", { width: 1400, height: 900, includeGizmos: false });
  const b64 = shot.__image.base64;
  const file = path.join(OUT, `sponza-${tone}.png`);
  await writeFile(file, Buffer.from(b64, "base64"));
  const s = await patchStats(`data:image/png;base64,${b64}`);
  rows.push({ tone, ...s });
  console.log(
    `  ${tone.padEnd(8)} shadow lum ${s.shadow.lum.toFixed(4)} chroma ${s.shadow.chroma.toFixed(3)}  ` +
    `far lum ${s.far.lum.toFixed(4)} chroma ${s.far.chroma.toFixed(3)}  ` +
    `sun lum ${s.sun.lum.toFixed(4)}  → ${file}`,
  );
}

// Restore whatever the scene had (in-memory only — the shim blocks the save).
await call("scene.setSettings", { patch: { toneMapping: savedTone } });

console.log(`\n=== VIEW TRANSFORM A/B (same radiance, same pose, ${rows.length} transforms) ===`);
console.log(`  transform  shadow-lum  shadow-chroma  far-lum  sun-lum   shadow/sun`);
for (const r of rows) {
  console.log(
    `  ${r.tone.padEnd(10)} ${r.shadow.lum.toFixed(4).padStart(9)} ${r.shadow.chroma.toFixed(3).padStart(13)} ` +
    `${r.far.lum.toFixed(4).padStart(8)} ${r.sun.lum.toFixed(4).padStart(8)} ` +
    `${(r.sun.lum > 0 ? r.shadow.lum / r.sun.lum : 0).toFixed(3).padStart(11)}`,
  );
}
console.log(`\n  shadow/sun is the "how much white fill" ratio the Blender comparison is really about.`);
console.log(`  shots: ${OUT}`);

await browser.close();
process.exit(0);
