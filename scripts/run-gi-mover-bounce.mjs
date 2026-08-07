// DOES AN EXACT-DYNAMIC MOVER STILL LIGHT THE ROOM?
//
// The user's report (2026-08-07): "indirect light from dynamic meshes still
// comes from voxels, resulting in bad indirect lighting." The mechanism this
// harness exists to confirm or refute is narrower and has a yes/no answer:
//
//   · GISystem #tryAdoptDynamic parks an adopted mover's occupancy slot AND
//     clears its atlas slot — the mesh leaves the voxel field completely.
//   · giField.js createSceneTrace still resolves EVERY cascade-ray hit by
//     sampling the voxel radianceBuffer trilinearly at the hit point.
//   · So a ray that hits the mover's exact triangles reads the radiance of
//     whatever voxels surround it. The mover contributes nothing of its own.
//
// If that is right, an adopted RED box bounces no red — and the fix (mean
// albedo/emissive in the object header, evaluated at the dynamic hit) has a
// measurable target rather than a plausible story.
//
// THE METRIC IS A COLOUR RATIO, NOT A BRIGHTNESS. The two representations
// shadow the floor differently (exact triangles vs a conservative voxel shell)
// and their contact darkening differs with them; white light attenuates r, g
// and b together, so hue survives all of it. The box is the only red thing in
// the scene.
//
//   redExcess = 2r / (g + b)     1.0 = neutral, > 1 = the box's colour arrived
//
// Paired white/red arms per representation cancel any hue the rig itself
// carries. The far samples (4.5m, 5.5m) are the zero check: the bounce must be
// gone there in every arm, or the metric is reading something that is not the
// box.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-mover-bounce.mjs
//
// Env:
//   GEN_ROOT=<dir>   generated project location
//   ARMS=...         subset of static-white,static-red,dynamic-white,dynamic-red
//   TRACE=bvh|obb    how the dynamic arms trace the mover
//   EMISSIVE=1       sun off, mover EMISSIVE — the same question of the
//                    emission path, with no direct term to dilute it
//   SETTLE=15000     ms to let the field/probes settle per arm
//   SHOT=<dir>       frame dumps
//   HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeMoverBounceProject, MOVER_RIG } from "./lib/makeMoverBounceProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-mover-bounce")).replaceAll("\\", "/");
const TRACE = process.env.TRACE ?? "bvh";
const EMISSIVE = process.env.EMISSIVE === "1";
const SETTLE = Number(process.env.SETTLE ?? 15000);
const COST = process.env.COST !== "0";
const SHOT = process.env.SHOT ?? ".gi-shots/mover-bounce";
const ALL_ARMS = ["static-white", "static-red", "dynamic-white", "dynamic-red"];
const ARMS = (process.env.ARMS ?? ALL_ARMS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const W = 1200, H = 800;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// High and slightly toward the sun side, centred between the box and the far
// samples: the box keeps its own square of screen and every floor sample stays
// unoccluded (the silhouette self-check below enforces that rather than
// trusting it). Not straight down — a view direction parallel to `up` makes
// lookAt degenerate.
// STEEP, not oblique. At 67° the box's +x face stayed visible and its bright
// silhouette fringe landed on the 1.1m sample — the only near sample outside
// the contact-suppression zone, i.e. the one carrying the signal. Near-vertical
// shrinks the box to roughly its top face and clears the floor line. Not
// exactly vertical: a view direction parallel to `up` makes lookAt degenerate.
const EYE = [2.5, 9.5, 1.4];
const TARGET = [2.5, 0, 0];

await makeMoverBounceProject(GEN_ROOT, {});
console.log(`  generated mover-bounce rig at ${GEN_ROOT}`);
console.log(`  arms: ${ARMS.join(", ")}   trace: ${TRACE}   ${EMISSIVE ? "EMISSIVE (sun off)" : "albedo bounce (sun on)"}`);
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
  if (/\[gi\] built|dynamic-objects|static shadow bvh|occupancy backend/i.test(t)) console.log(`  ${t.slice(0, 180)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.message ?? String(e)).slice(0, 200)}`));

// GLOBALS='__giDynShadeAmbient=0' — live/build-time GI knobs, set before any
// module runs because several are read at shader BUILD time.
const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);
await page.evaluateOnNewDocument((project, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  // Adopt/release logging — the arms assert on adoption state, and a silent
  // release mid-arm is exactly the kind of thing that turns a measurement into
  // a story.
  globalThis.__giDynObjectsDebug = true;
  for (const g of globals) {
    const [k, v] = g.split("=");
    globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
}, GEN_ROOT, GLOBALS);

console.log(`Opening ${GEN_ROOT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

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
const byName = (name) => entities.find((e) => e.name === name);
const giEntity = entities.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
const mover = byName("Mover");
const sun = byName("Sun");
if (!giEntity || !mover || !sun) {
  console.log("FATAL: rig entities missing");
  await browser.close();
  process.exit(1);
}
for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(8000);

await must("viewport.setCamera", { position: EYE, target: TARGET });
await wait(2500);

// ---- exact world→pixel (see run-gi-bleed's note: never rebuild the basis in
// node — the camera the screenshot uses is the only authority) ---------------
async function projectPoints(worldPoints) {
  return page.evaluate(({ pts, w, h }) => {
    const cam = globalThis.__viewport?.camera;
    if (!cam) throw new Error("no viewport camera");
    const prevAspect = cam.aspect;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const v = cam.matrixWorldInverse.elements;
    const p = cam.projectionMatrix.elements;
    const mul = (m, x, y, z, ww) => [
      m[0] * x + m[4] * y + m[8] * z + m[12] * ww,
      m[1] * x + m[5] * y + m[9] * z + m[13] * ww,
      m[2] * x + m[6] * y + m[10] * z + m[14] * ww,
      m[3] * x + m[7] * y + m[11] * z + m[15] * ww,
    ];
    const out = pts.map(([x, y, z]) => {
      const e = mul(v, x, y, z, 1);
      const c = mul(p, e[0], e[1], e[2], e[3]);
      if (!(Math.abs(c[3]) > 1e-9)) return null;
      return { x: (c[0] / c[3] * 0.5 + 0.5) * w, y: (0.5 - c[1] / c[3] * 0.5) * h };
    });
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    return out;
  }, { pts: worldPoints, w: W, h: H });
}

async function samplePng(b64, points) {
  return page.evaluate(async ({ dataUrl, points, w, h }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const R = 5;
    // The screenshot target is sRGB-encoded (viewport.js). A hue ratio taken
    // on gamma-encoded values is not the hue ratio of the light.
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return points.map((p) => {
      if (!p) return null;
      const x0 = Math.max(0, Math.min(w - 1, Math.round(p.x) - R));
      const y0 = Math.max(0, Math.min(h - 1, Math.round(p.y) - R));
      const d = g.getImageData(x0, y0, Math.min(2 * R + 1, w - x0), Math.min(2 * R + 1, h - y0)).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += toLinear(d[i] / 255); gg += toLinear(d[i + 1] / 255); b += toLinear(d[i + 2] / 255); n++;
      }
      r /= n; gg /= n; b /= n;
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      return { r, g: gg, b, lum, redExcess: (gg + b) > 1e-6 ? (2 * r) / (gg + b) : 0 };
    });
  }, { dataUrl: `data:image/png;base64,${b64}`, points, w: W, h: H });
}

const DIST = MOVER_RIG.samples;
const points = await projectPoints(DIST.map((d) => [d, 0, 0]));

// ---- instrument self-checks ------------------------------------------------
// THE SUN ACTUALLY AIMS WHERE THE RIG THINKS. The first run of this harness
// measured a black scene for four arms because a directional light takes its
// direction from the entity's -Z forward, not from its position: the rig asked
// for a 40°-elevation sun and got one shining horizontally along -Z. Read the
// direction back off the live light and compare.
const sunCheck = await page.evaluate(async () => {
  let engine = null;
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const e of list ?? []) {
    const live = globalThis.__editorApi.entities.live(e.id);
    if (live?.engine) { engine = live.engine; break; }
  }
  let out = null;
  engine?.scene?.traverse?.((o) => {
    if (out || !o.isDirectionalLight) return;
    const V = o.position.constructor;
    const p = o.getWorldPosition(new V());
    const t = o.target ? o.target.getWorldPosition(new V()) : new V();
    const d = [t.x - p.x, t.y - p.y, t.z - p.z];
    const n = Math.hypot(...d) || 1;
    out = { dir: d.map((v) => v / n), intensity: o.intensity, castShadow: o.castShadow };
  });
  return out;
});
{
  const want = MOVER_RIG.sunDir;
  const wn = Math.hypot(...want);
  const unit = want.map((v) => v / wn);
  const dot = sunCheck ? sunCheck.dir.reduce((a, v, i) => a + v * unit[i], 0) : 0;
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  console.log(
    `  sun: dir [${(sunCheck?.dir ?? []).map((v) => v.toFixed(3)).join(", ")}] intensity ${sunCheck?.intensity} ` +
      `— ${deg.toFixed(1)}° off the rig's aim${deg > 5 ? "  !! THE RIG IS NOT LIT THE WAY IT CLAIMS" : ""}`,
  );
}

// NO SAMPLE MAY LAND ON THE BOX. Project all eight corners and reject any
// sample inside their screen AABB — the near samples carry the most signal and
// are the ones a silhouette would swallow.
const hb = MOVER_RIG.boxSize / 2;
const corners = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
  corners.push([sx * hb, MOVER_RIG.boxY + sy * hb, sz * hb]);
}
const cpx = (await projectPoints(corners)).filter(Boolean);
const boxBox = {
  x0: Math.min(...cpx.map((p) => p.x)), x1: Math.max(...cpx.map((p) => p.x)),
  y0: Math.min(...cpx.map((p) => p.y)), y1: Math.max(...cpx.map((p) => p.y)),
};
const [floorEdge] = await projectPoints([[MOVER_RIG.floorSize / 2, 0, 0]]);
console.log(`  box silhouette x∈[${boxBox.x0.toFixed(0)},${boxBox.x1.toFixed(0)}] y∈[${boxBox.y0.toFixed(0)},${boxBox.y1.toFixed(0)}]px, floor edge x=${floorEdge?.x.toFixed(0)}px`);
console.log(`  samples: ${points.map((p, i) => `${DIST[i]}m→${p ? `${Math.round(p.x)},${Math.round(p.y)}` : "off"}`).join(" ")}`);
const onBox = points
  .map((p, i) => (p && p.x >= boxBox.x0 - 6 && p.x <= boxBox.x1 + 6 && p.y >= boxBox.y0 - 6 && p.y <= boxBox.y1 + 6 ? DIST[i] : null))
  .filter(Boolean);
const offFrame = points
  .map((p, i) => (!p || p.x < 0 || p.x >= W || p.y < 0 || p.y >= H || p.x > (floorEdge?.x ?? W) ? DIST[i] : null))
  .filter(Boolean);
if (onBox.length) console.log(`  !! samples on the box silhouette: ${onBox.join(", ")}m — those read the mover, not the receiver`);
if (offFrame.length) console.log(`  !! samples off the floor/frame: ${offFrame.join(", ")}m`);

/** GI-side truth for an arm: is the mover adopted, and did the field lose it? */
const giState = () =>
  page.evaluate(async () => {
    let sys = null;
    const list = await globalThis.__editorApi.call("entity.list", {});
    for (const e of list ?? []) {
      const s = globalThis.__editorApi.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
      if (s) { sys = s; break; }
    }
    if (!sys) return { error: "no gi system" };
    const round = (a) => (a ?? []).map((v) => +Number(v).toFixed(3));
    const entries = [];
    sys._dynSet?.forEachEntry?.((e) => {
      entries.push(
        `${e.type}(${e.mesh?.userData?.giMobility ?? "?"}/${e.mesh?.userData?.giTrace ?? "?"}) ` +
          `albedo=[${round(e.surface?.albedo)}] emissive=[${round(e.surface?.emissive)}]`,
      );
    });
    return {
      adopted: sys._dynSet?.count?.() ?? 0,
      adoptedKeys: sys._dynAdoptedKeys?.size ?? 0,
      entries,
    };
  });

async function shoot(tag) {
  const shot = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  await writeFile(path.join(SHOT, `mover-${tag}.png`), Buffer.from(shot.__image.base64, "base64"));
  return samplePng(shot.__image.base64, points);
}

const MAT = (name) => `${GEN_ROOT}/materials/${name}.mat`;
const MATS = EMISSIVE
  ? { white: MAT("EmitWhite"), red: MAT("EmitRed") }
  : { white: MAT("MoverWhite"), red: MAT("MoverRed") };

if (EMISSIVE) {
  await must("component.setProp", { id: sun.id, type: "light", key: "intensity", value: 0 });
  await wait(3000);
}

// CONTROL FIRST. With GI off, the floor carries direct sun only — no bounce
// path exists, so every arm's red excess must collapse to the same neutral
// value. If it does not, something other than GI is tinting the samples and
// every arm below is measuring that instead.
await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: false });
await wait(5000);
const giOff = await shoot("gi-off");
console.log(
  `  CONTROL — GI off: ${DIST.map((d, i) => `${d}m lum ${(giOff[i]?.lum ?? 0).toFixed(4)}/hue ${(giOff[i]?.redExcess ?? 0).toFixed(3)}`).join("  ")}`,
);
// A DARK CONTROL IS A DEAD RIG, not a result. Direct sunlight on a white floor
// is the one thing here that does not depend on GI at all — if it is missing,
// the arms below are four measurements of black.
{
  const litSamples = giOff.filter((s) => (s?.lum ?? 0) > 0.02).length;
  const hues = giOff.filter((s) => (s?.lum ?? 0) > 0.02).map((s) => s.redExcess);
  const hueSpread = hues.length ? Math.max(...hues) / Math.min(...hues) : NaN;
  // In the EMISSIVE arm the sun is off and the box IS the only source, so the
  // whole scene reaching the floor is GI — a black control is the expected
  // result there, and a LIT one would mean something else is lighting it.
  if (EMISSIVE) {
    console.log(
      litSamples === 0
        ? "  CONTROL ok: GI off leaves the floor black — the emissive box is the only source"
        : `  !! ${litSamples} samples are lit with GI off and the sun at 0 — something else lights this rig`,
    );
  } else if (litSamples < DIST.length - 1) {
    console.log(`  !! FATAL: only ${litSamples}/${DIST.length} samples are lit with GI off — the sun is not reaching the floor.`);
    await browser.close();
    process.exit(1);
  }
  console.log(
    `  CONTROL ok: ${litSamples}/${DIST.length} samples lit, direct-only hue spread ${hueSpread.toFixed(3)}x ` +
      `(this is the metric's noise floor — a bounce smaller than it is not measurable)`,
  );
}
await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
built = false;
for (let i = 0; i < 60 && !built; i++) await wait(500);
await wait(8000);

const results = {};
for (const arm of ARMS) {
  const [mobility, colour] = arm.split("-");
  if (!MATS[colour]) { console.log(`  (skipping unknown arm ${arm})`); continue; }
  await must("component.setProp", { id: mover.id, type: "mesh", key: "material", value: MATS[colour] });
  await must("component.setProp", { id: mover.id, type: "mesh", key: "giTrace", value: mobility === "dynamic" ? TRACE : "auto" });
  // Mobility LAST: "dynamic" is the eager pin (GISystem #refreshOccupancyTransforms
  // adopts a never-moved mesh on the tag alone) and a pinned mover never
  // rest-demotes, so the pose stays still for the whole arm.
  await must("component.setProp", { id: mover.id, type: "mesh", key: "giMobility", value: mobility });
  await wait(SETTLE);
  const state = await giState();
  const samples = await shoot(arm);
  // COST OF THE SAME SCENE UNDER BOTH REPRESENTATIONS. The dynamic arms run
  // the new shading branch (a light loop + one shadow traversal per active
  // light, per ray that hits the mover) inside the cascade trace — the queue's
  // most expensive pass. Measuring it on the user's real project says nothing:
  // that scene has no adopted movers, so the branch never executes there.
  const cost = COST ? await call("profile.giPasses", { samples: 24 }) : null;
  results[arm] = { samples, state, cost: cost?.ok ? cost.value : null };
  const wantAdopted = mobility === "dynamic" ? 1 : 0;
  const ok = (state.adopted ?? 0) === wantAdopted;
  console.log(
    `  arm ${arm.padEnd(14)} adopted=${state.adopted} ${(state.entries ?? []).join(" | ") || "(voxel path)"}` +
      `${ok ? "" : `  !! expected adopted=${wantAdopted} — THIS ARM DID NOT MEASURE WHAT IT CLAIMS`}`,
  );
}

// ---- report ----------------------------------------------------------------
const fmt = (v, w = 8, p = 4) => (Number.isFinite(v) ? v.toFixed(p) : "-").padStart(w);
const present = ARMS.filter((a) => results[a]);

console.log(`\n=== RED EXCESS ON THE FLOOR (2r/(g+b); 1.0 = neutral) ===`);
console.log(`  d(m)  ` + present.map((a) => a.padStart(14)).join(""));
for (let i = 0; i < DIST.length; i++) {
  console.log(`  ${DIST[i].toFixed(2).padStart(5)} ` + present.map((a) => fmt(results[a].samples[i]?.redExcess, 14)).join(""));
}

console.log(`\n=== LUMINANCE (context only — the metric above is hue) ===`);
console.log(`  d(m)  ` + present.map((a) => a.padStart(14)).join(""));
for (let i = 0; i < DIST.length; i++) {
  console.log(`  ${DIST[i].toFixed(2).padStart(5)} ` + present.map((a) => fmt(results[a].samples[i]?.lum, 14, 5)).join(""));
}

// ---- the valid measurement band --------------------------------------------
// THE NEAR FIELD OF THIS RIG IS NOT PHYSICS. A bounce from a box at the origin
// must fall monotonically with distance, and both representations instead
// crater inside ~0.9m and peak around 1.1m — the same contact suppression
// run-gi-bleed flags ("peak not at the panel"). So the band is derived, not
// chosen: it starts after the REFERENCE arm's peak (everything before is
// suppressed) and ends where the signal reaches the noise floor. Picking a
// window by hand until the arms agreed would be fitting the answer.
const refArm = results["static-white"] ? "static-white" : present[0];
const refLum = DIST.map((_, i) => results[refArm]?.samples[i]?.lum ?? 0);
const refCtl = DIST.map((_, i) => giOff[i]?.lum ?? 0);
const refGain = refLum.map((v, i) => Math.max(0, v - refCtl[i]));
let peak = 0;
for (let i = 1; i < refGain.length; i++) if (refGain[i] > refGain[peak]) peak = i;
const NOISE = 0.004;
const band = DIST.map((_, i) => i).filter((i) => i > peak && refGain[i] > NOISE);
console.log(
  `\n  measurement band: ${band.length ? `${DIST[band[0]]}–${DIST[band.at(-1)]}m` : "(none)"} ` +
    `(${refArm} peaks at ${DIST[peak]}m — everything at or inside that is contact-suppressed and excluded; ` +
    `signal floor ${NOISE})`,
);
const clipped = present.flatMap((a) => DIST.filter((_, i) => (results[a].samples[i]?.lum ?? 0) > 0.99).map((d) => `${a}@${d}m`));
if (clipped.length) console.log(`  !! saturated samples (unusable, excluded from any ratio): ${clipped.join(", ")}`);

const meanBand = (arm, key) => {
  const s = results[arm]?.samples;
  if (!s || !band.length) return NaN;
  const vals = band
    .filter((i) => (s[i]?.lum ?? 0) <= 0.99)
    .map((i) => (key === "gain" ? Math.max(0, (s[i]?.lum ?? 0) - refCtl[i]) : s[i]?.[key]))
    .filter((v) => Number.isFinite(v) && v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
};

// ── 1. PRESENCE: does the mover's COLOUR reach the receiver at all? ──────────
// Red arm's hue over the same representation's white arm, so any hue the rig
// itself carries cancels. Degenerate under EMISSIVE (the box is the only
// source, so g and b are ~0 and the ratio explodes) — reported anyway, judged
// only in the albedo mode it means something in.
if (!EMISSIVE) {
  console.log(`\n=== 1. COLOUR TRANSFER — does the mover's hue arrive? ===`);
  const t = {};
  for (const rep of ["static", "dynamic"]) {
    const red = `${rep}-red`, white = `${rep}-white`;
    if (!results[red] || !results[white]) continue;
    t[rep] = meanBand(red, "redExcess") / meanBand(white, "redExcess");
    console.log(`  ${rep.padEnd(8)} transfer ${fmt(t[rep], 7, 4)} → ${((t[rep] - 1) * 100).toFixed(1)}% of the receiver's hue comes from the mover`);
  }
  if (Number.isFinite(t.static) && Number.isFinite(t.dynamic)) {
    const kept = (t.dynamic - 1) / (t.static - 1);
    console.log(`  → an adopted mover delivers ${(kept * 100).toFixed(0)}% of the colour its voxel self delivers.`);
    console.log(
      kept < 0.25
        ? "    CONFIRMED: exact-dynamic adoption drops the mover's indirect contribution."
        : "    The adopted mover transfers its colour.",
    );
  }
}

// ── 2. SCALE: does it arrive at the right STRENGTH? ─────────────────────────
// Same mover, same pose, same lighting — only the representation differs, so
// the per-colour luminance ratio is a direct read on whether the exact path's
// shading is calibrated against the voxel path it replaces. This is the check
// the hue ratio cannot make: a mover could deliver perfectly red light twice
// as bright as it should.
console.log(`\n=== 2. DELIVERY SCALE — dynamic ÷ static, over the band ===`);
for (const colour of ["white", "red"]) {
  const s = meanBand(`static-${colour}`, "gain");
  const d = meanBand(`dynamic-${colour}`, "gain");
  if (!Number.isFinite(s) || !Number.isFinite(d)) continue;
  const ratio = d / s;
  console.log(
    `  ${colour.padEnd(6)} static ${fmt(s, 8, 5)}  dynamic ${fmt(d, 8, 5)}  ratio ${fmt(ratio, 6, 3)}` +
      (Math.abs(ratio - 1) < 0.15 ? "  (calibrated)" : ratio > 1 ? "  !! the exact path is HOTTER" : "  !! the exact path is DIMMER"),
  );
}
// ── 3. COST ─────────────────────────────────────────────────────────────────
// The cascade TRACE (queue entry 0) is where an exact dynamic hit is now
// shaded. Same scene, same mover, one representation swap — so the delta is
// the shading branch and nothing else.
if (present.some((a) => results[a].cost)) {
  console.log(`\n=== 3. GPU COST (queue entry 0 = the cascade trace, where the shading branch lives) ===`);
  for (const arm of present) {
    const c = results[arm].cost;
    if (!c) continue;
    console.log(
      `  ${arm.padEnd(14)} trace ${fmt(c.queueMs?.["trace c0"], 7, 3)}ms  queue ${fmt(c.queueTotalMs, 7, 3)}ms  ` +
        `resolve ${fmt(c.screenPassesMs?.resolve, 6, 3)}ms  (movers ${c.adoptedMovers})`,
    );
  }
}
console.log(`\n  frames: ${SHOT}`);

await browser.close();
process.exit(0);
