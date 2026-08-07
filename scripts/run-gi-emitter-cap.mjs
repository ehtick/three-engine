// WHAT HAPPENS TO EMISSIVE OBJECT NUMBER FIVE?
//
// MAX_EMITTERS is 4. The user (2026-08-07) is spawning emissive projectiles
// and their console already says `[gi] 5 bright emitters; analytic slots cover
// the brightest 4`. Before designing a clustered light system, the cap has to
// be characterised rather than assumed, because "capped" could mean three very
// different things and they call for three different fixes:
//
//   A. past-cap lamps light the room through a cheaper path (voxel field
//      emissive injection, or — for an adopted exact mover — the cascade
//      transport reading its header emissive). Then the cap is only a cap on
//      SHARP SHADOWED lamps, and the work is quality, not capacity.
//   B. past-cap lamps deliver a fraction. Then the fix is calibration.
//   C. past-cap lamps go BLACK. That is the real cliff, and it would be an
//      interaction bug rather than a budget: an adopted mover leaves the voxel
//      field entirely (its occupancy slot is parked, its atlas slot cleared),
//      so an emissive mover that also loses the promotion race has neither an
//      analytic slot NOR a field presence.
//
// THE MEASUREMENT: N identical white lamps on a ring, each with its own patch
// of floor, everything else dark. For each lamp, the mean LINEAR luminance of
// an annulus of floor around its ground point, minus the far-field background.
// Identical lamps at identical heights over identical floor means the only
// thing that can differ between lamp 1 and lamp 7 is which path lit it.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-emitter-cap.mjs
//
// Env: LAMPS=8  EMIT=8  MOBILITY=dynamic  SETTLE=14000  GLOBALS=  HEADED=1
import path from "node:path";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject, lampRing } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-emitter-cap")).replaceAll("\\", "/");
const LAMPS = Number(process.env.LAMPS ?? 8);
const EMIT = Number(process.env.EMIT ?? 8);
const MOBILITY = process.env.MOBILITY ?? "dynamic";
const SETTLE = Number(process.env.SETTLE ?? 14000);
const SHOT = process.env.SHOT ?? ".gi-shots/emitter-cap";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: MOBILITY, emitStrength: EMIT, lampCount: LAMPS,
  strengthRamp: Number(process.env.RAMP ?? 0),
  lampRadius: Number(process.env.RADIUS ?? 0.4),
  // No crates: an occluder between a lamp and its own annulus would be a
  // confound that differs per lamp.
  //
  // EMISSIVE_SHADOWS=0 turns promotion OFF for the whole scene (GISystem
  // gates the promotion block on this prop), which is the cleanest possible
  // A/B of the two emissive paths: ONE lamp, same mesh, same material, same
  // place — analytic slot in one arm, transport-only in the other. No ring,
  // no ranking, nothing to confound.
  gi: {
    intensity: Number(process.env.INTENSITY ?? 1.5),
    ...(process.env.EMISSIVE_SHADOWS === "0" ? { emissiveShadows: false } : {}),
  },
});
console.log(
  `  ${LAMPS} lamps (MAX_EMITTERS is 4), strength ${EMIT}, giMobility=${MOBILITY}, ` +
    `intensity ${process.env.INTENSITY ?? 1.5}, promotion ${process.env.EMISSIVE_SHADOWS === "0" ? "OFF" : "on"}`,
);
await mkdir(SHOT, { recursive: true });

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
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built|bright emitters|dynamic-objects: (adopted|exact|evict)|emitter shadows/i.test(t)) {
    console.log(`  ${t.slice(0, 170)}`);
  }
  if (/\[gi\] built/.test(t)) built = true;
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 160)}`);
});

const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
await page.evaluateOnNewDocument((project, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__giDynObjectsDebug = true;
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, GEN_ROOT, GLOBALS);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  (rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0])
    ?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
for (let i = 0; i < 240 && !built; i++) await wait(1000);

const call = (op, args = {}) =>
  page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args });

// Straight down: every lamp's annulus is then the same shape and the same
// number of pixels, and no lamp occludes another's floor.
await call("viewport.setCamera", { position: [0, 15.5, 0.9], target: [0, 0, 0] });
await wait(SETTLE);

const homes = LAMPS === 4
  ? [[-3.2, 1.6, -3.2], [3.2, 1.6, -3.2], [3.2, 1.6, 3.2], [-3.2, 1.6, 3.2]]
  : lampRing(LAMPS);

// Which lamps got analytic slots, and where each one's ground point lands on
// screen. Projection happens in-page against the LIVE viewport camera — a
// re-derived projection matrix is a second source of truth and drifts.
const info = await page.evaluate(async ({ homes, tag }) => {
  const api = globalThis.__editorApi;
  let sys = null;
  for (const e of (await api.call("entity.list", {})) ?? []) {
    const s = api.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
    if (s) { sys = s; break; }
  }
  if (!sys) return { error: "no gi system" };
  const scene = sys.engine?.scene;
  const V = scene.position.constructor;
  const lamps = [];
  scene.traverse((o) => {
    if (o.isMesh && /Sphere/i.test(o.geometry?.type ?? "") && o.userData?.giMobility === tag) lamps.push(o);
  });
  const promoted = new Set((sys._emitterInfos ?? []).map((i) => i.mesh));
  // The viewport camera lives behind a vmSingleton, not on globalThis, so the
  // projection is done in node from `viewport.getCamera` instead of here.
  const canvas = sys.engine?.renderer?.domElement;
  const near = (o, h) => {
    const w = o.getWorldPosition(new V());
    return Math.hypot(w.x - h[0], w.z - h[2]);
  };
  const rows = homes.map((h, i) => {
    const lamp = lamps.find((o) => near(o, h) < 0.9) ?? null;
    return {
      i, home: h,
      promoted: lamp ? promoted.has(lamp) : false,
    };
  });
  return {
    rows,
    emitters: sys._emitterInfos?.length ?? 0,
    adopted: sys._dynSet?.count?.() ?? 0,
    lampsFound: lamps.length,
    // THE CANVAS RECT, NOT JUST ITS SIZE. page.screenshot() captures the whole
    // PAGE — editor chrome included — and the viewport canvas is a sub-
    // rectangle of it. Scaling canvas coords by width/canvasWidth without
    // adding the rect's origin lands every sample at a fixed offset from
    // where it belongs; half of them landed on side panels, which is why they
    // read IDENTICAL to five decimals across runs with different lamp
    // strengths. Constant pixels are the signature of sampling the UI.
    canvasRect: canvas
      ? (() => { const r = canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()
      : null,
  };
}, { homes, tag: MOBILITY });

if (info.error) { console.log(`FATAL: ${info.error}`); await browser.close(); process.exit(1); }
console.log(`\n  lamps found ${info.lampsFound}/${LAMPS}   promoted ${info.emitters}/4   adopted movers ${info.adopted}`);
// WORLD -> SCREEN, from the live camera's own reported pose. three's camera
// looks down -Z, so `zc` (the component along forward) is positive in front.
const camR = await call("viewport.getCamera", {});
if (!camR.ok || !info.canvasRect) {
  console.log(`FATAL: no viewport camera (${camR.error ?? "no canvas"})`);
  await browser.close();
  process.exit(1);
}
const cam = camR.value;
const [CX, CY, CW, CH] = info.canvasRect;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fwd = norm(sub(cam.target, cam.position));
const right = norm(cross(fwd, [0, 1, 0]));
const upv = cross(right, fwd);
const tanH = Math.tan(((cam.fov ?? 50) * Math.PI) / 360);
const aspect = CW / CH;
const project = (p) => {
  const v = sub(p, cam.position);
  const zc = dot(v, fwd);
  if (zc <= 1e-4) return null;
  const ndcX = dot(v, right) / zc / (tanH * aspect);
  const ndcY = dot(v, upv) / zc / tanH;
  // PAGE coordinates: canvas-local NDC mapped into the canvas rect's origin.
  return [CX + (ndcX * 0.5 + 0.5) * CW, CY + (-ndcY * 0.5 + 0.5) * CH];
};
for (const r of info.rows) r.ground = project([r.home[0], 0, r.home[2]]);
info.center = project([0, 0, 0]);
if (!info.rows.every((r) => r.ground) || !info.center) {
  console.log("FATAL: lamp ground points fall outside the view — move the camera back");
  await browser.close();
  process.exit(1);
}
// EVERY SAMPLE MUST LAND ON THE CANVAS, annulus included. The failure this
// guards against does not look like a failure: sampling editor chrome returns
// perfectly stable numbers that simply are not the scene.
const R0 = 34, R1 = 74;
const onCanvas = (pt) =>
  pt[0] - R1 >= CX && pt[0] + R1 <= CX + CW && pt[1] - R1 >= CY && pt[1] + R1 <= CY + CH;
const strays = info.rows.filter((r) => !onCanvas(r.ground)).map((r) => r.i);
if (strays.length || !onCanvas(info.center)) {
  console.log(
    `FATAL: sample annuli fall outside the viewport canvas (${CX},${CY} ${CW}x${CH}) — ` +
      `lamps [${strays.join(",")}]${onCanvas(info.center) ? "" : " and the background point"}. ` +
      "Pull the camera back or shrink the annulus.",
  );
  await browser.close();
  process.exit(1);
}

const file = path.join(SHOT, `lamps${LAMPS}.png`);
await page.screenshot({ path: file });
const img = await sharp(file).raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = img.info;
const sx = width / (info.canvas?.[0] ?? width);
const sy = height / (info.canvas?.[1] ?? height);

// sRGB -> linear before averaging: a photometric comparison of encoded bytes
// is not a comparison of light.
const toLinear = (b) => {
  const v = b / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
/** Mean linear luminance of an annulus (in device px) around a screen point. */
const annulus = (pt, r0, r1) => {
  const cx = pt[0] * sx, cy = pt[1] * sy;
  let sum = 0, n = 0;
  for (let y = Math.max(0, Math.floor(cy - r1)); y < Math.min(height, cy + r1); y++) {
    for (let x = Math.max(0, Math.floor(cx - r1)); x < Math.min(width, cx + r1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      const o = (y * width + x) * channels;
      sum += 0.2126 * toLinear(img.data[o]) + 0.7152 * toLinear(img.data[o + 1]) + 0.0722 * toLinear(img.data[o + 2]);
      n++;
    }
  }
  return n ? sum / n : null;
};

// r0 clears the lamp's own bright sphere; r1 stays inside its pool.
const background = annulus(info.center, 0, 26) ?? 0;
console.log(`\n=== FLOOR DELIVERED PER LAMP (mean linear luminance of an annulus ${R0}-${R1}px, background ${background.toFixed(5)}) ===`);
const rows = info.rows.map((r) => {
  const lum = annulus(r.ground, R0, R1) ?? 0;
  return { ...r, lum, excess: lum - background };
});
const promotedRows = rows.filter((r) => r.promoted);
const cappedRows = rows.filter((r) => !r.promoted);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const promMean = mean(promotedRows.map((r) => r.excess));
for (const r of rows) {
  const share = promMean > 1e-9 ? (100 * r.excess) / promMean : 0;
  console.log(
    `  lamp${r.i} ${(r.promoted ? "ANALYTIC SLOT" : "past the cap ").padEnd(14)} ` +
      `floor ${r.lum.toFixed(5)}  excess ${r.excess.toFixed(5)}  ${share.toFixed(0)}% of a promoted lamp`,
  );
}
if (cappedRows.length) {
  const capMean = mean(cappedRows.map((r) => r.excess));
  const ratio = promMean > 1e-9 ? capMean / promMean : 0;
  console.log(
    `\n  promoted mean excess ${promMean.toFixed(5)}   past-cap mean excess ${capMean.toFixed(5)}   ` +
      `=> a past-cap emissive delivers ${(100 * ratio).toFixed(0)}% of a promoted one`,
  );
  console.log(
    ratio < 0.05
      ? "  VERDICT C: past-cap emissives are DARK — the cap is a cliff, not a budget."
      : ratio < 0.6
        ? "  VERDICT B: past-cap emissives deliver a FRACTION — calibration, not capacity."
        : "  VERDICT A: past-cap emissives light the room through the cheaper path — the cap only limits SHARP SHADOWED lamps.",
  );
} else {
  console.log("\n  (no lamps past the cap — raise LAMPS)");
}
console.log(`\n  frame → ${file}`);
await browser.close();
process.exit(0);
