// PLAY-MODE DARKNESS A/B (session 38 follow-up) — "performance got a lot
// better, but the scene got a lot darker" (user screenshot, settled crates in
// the sun patch). Theory: play-mode physics settle ADOPTS all 16 crates as
// exact movers, adopted movers leave the voxel field, and the analytic bounce
// exists only in the FINAL gather — so the crates' sunlight bounce never
// enters the MULTI-BOUNCE feedback. Edit mode never adopts them, which is why
// the editor looks right and play looks dark.
//
// Method: open the real project, play, let the crates settle+adopt, disable
// the sun's ping-pong script, pin the sun to a fixed angle, freeze game time,
// let GI converge, screenshot, report mean linear luminance (whole / top half
// = arcades+vault ambience / bottom half = floor+crates).
//
// Arms: ARM=default (shipped) | ARM=novox (__giDiffuseSkipMovers=false — the
// whole mover-analytic split off; crates stay in the voxel field) |
// ARM=nooracle (__giMoverDirectShadow=false — mover bounce un-shadowed).
// If novox is much brighter in the TOP half, the missing-field-bounce theory
// stands and the fix is play-mode rest demotion.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const ARM = process.env.ARM ?? "default";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = {
  default: {},
  novox: { __giDiffuseSkipMovers: false },
  nooracle: { __giMoverDirectShadow: false },
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
let waveDone = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/compile wave: materials \d+ms/.test(t)) waveDone = true;
});
await page.evaluateOnNewDocument((PROJECT, G) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  for (const [k, v] of Object.entries(G)) globalThis[k] = v;
  globalThis.__editorKeepRendering = true;
}, PROJECT, { ...(ARMS[ARM] ?? {}), ...JSON.parse(process.env.PRESET_GLOBALS ?? "{}") });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 120 && !built; i++) await wait(1000);
for (let i = 0; i < 200 && !waveDone; i++) await wait(1000);
await wait(8000);

await page.evaluate(() => globalThis.__editorApi.call("play.set", { playing: true }));
await wait(8000); // physics settle → crates adopt (in the default arm)

// Pin the world: sun script off, sun at a fixed angle, game time frozen.
const pinned = await page.evaluate(async () => {
  const list = await globalThis.__editorApi.call("entity.list", {});
  let engine = null;
  let lightEntity = null;
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    if (live?.engine?.renderer) engine = live.engine;
    const types = (e.components ?? []).map((c) => c.type);
    if (!lightEntity && types.includes("light") && types.includes("script")) lightEntity = e;
  }
  if (!engine) return { error: "no engine" };
  if (lightEntity) {
    try {
      await globalThis.__editorApi.call("component.setProp", {
        id: lightEntity.id, type: "script", key: "enabled", value: false,
      });
    } catch (err) {
      return { error: `script disable failed: ${String(err).slice(0, 120)}` };
    }
    const live = globalThis.__editorApi.entities.live(lightEntity.id);
    const o = live?.object3D;
    if (o) {
      o.rotation.set((-50 * Math.PI) / 180, 0, 0);
      o.updateMatrixWorld(true);
    }
  }
  engine.timeScale = 0;
  const sys = engine.modules?.get("gi")?.system;
  // RESTORE_GI: put the two LIVE (no-rebuild) dials back to their sane values
  // — the scene autosaved a perf experiment (intensity 0.5, bleedSaturation 0,
  // quality low, c0DirRes 2, resolveScale 0.25) and this measures how much of
  // the darkness those two alone own.
  let restored = null;
  if (globalThis.__PROBE_RESTORE_GI) {
    // Cornell-grade values: the scene autosaved a perf experiment (quality
    // low, intensity 0.5, c0DirRes 2, bleedSaturation 0, resolveScale 0.25).
    // quality/c0DirRes are build-time — this triggers a full rebuild; the
    // caller waits out the compile wave before the screenshot.
    const RESTORE = {
      quality: "high", intensity: 1, bleedSaturation: 1, c0DirRes: 4,
      resolveScale: 0.5, temporalBlend: 0.25, probeSmoothing: 0.35,
    };
    for (const e of list ?? []) {
      const gi = (e.components ?? []).find((c) => c.type === "global-illumination");
      if (!gi) continue;
      try {
        for (const [key, value] of Object.entries(RESTORE)) {
          await globalThis.__editorApi.call("component.setProp", {
            id: e.id, type: "global-illumination", key, value,
          });
        }
        restored = e.name || e.id;
      } catch (err) {
        restored = `failed: ${String(err).slice(0, 120)}`;
      }
      break;
    }
  }
  return {
    light: lightEntity?.name ?? "(none)",
    adoptedMovers: sys?._dynSet?.count?.() ?? -1,
    occluderSlots: sys?._moverOccluders?.count?.value ?? 0,
    restored,
  };
});
console.log(`ARM=${ARM} pinned:`, JSON.stringify(pinned));
// A RESTORE arm changed build-time props — sit out the rebuild's compile
// wave (headless waves run 1-3 min) before judging the image.
await wait(process.env.PRESET_GLOBALS?.includes("__PROBE_RESTORE_GI") ? 180000 : 6000);

const shot = await page.screenshot({ type: "png" });
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const stats = { whole: [0, 0], top: [0, 0], bottom: [0, 0] };
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    const lum =
      srgbToLin(data[i] / 255) * 0.2126 +
      srgbToLin(data[i + 1] / 255) * 0.7152 +
      srgbToLin(data[i + 2] / 255) * 0.0722;
    stats.whole[0] += lum; stats.whole[1]++;
    const half = y < info.height / 2 ? stats.top : stats.bottom;
    half[0] += lum; half[1]++;
  }
}
const out = Object.fromEntries(
  Object.entries(stats).map(([k, [s, n]]) => [k, +(s / n).toFixed(5)]),
);
console.log(`ARM=${ARM} luminance:`, JSON.stringify(out));
await sharp(shot).toFile(`.gi-shots/dark-${ARM}.png`);
await browser.close();
