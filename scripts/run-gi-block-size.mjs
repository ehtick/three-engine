// HOW BIG ARE THE BLOCKS, AND WHOSE LATTICE ARE THEY?
//
// The user's complaint (2026-08-07): indirect light is "blocky and flickery" —
// colour bleed from a box and light from emissive meshes, the same way. Two
// lattices are candidates: the VOXEL/field cell and the PROBE grid. The
// artifact has a LENGTH, so the discriminator is: sweep each dial on its own
// and see which one the length follows.
//
// WHY THIS RIG AND NOT AN EXISTING ONE — the trap that voided the previous
// attempt at this question: **`autoFit: true` makes `voxelSize` and
// `probeSpacing` INERT.** GISystem #rebuild's autoFit branch derives both from
// QUALITY_BUDGETS and overwrites the props ("the manual size/voxel/probe fields
// are ignored"). Every GI rig in scripts/lib ships autoFit ON, and so does the
// user's own Cornell scene, so a sweep of either prop there compares identical
// builds. (Under autoFit there IS one way voxelSize appears to work: the
// Inspector flips `quality` to "custom" when an advanced field is edited, and
// qualityTierOf maps "custom" → "high" — so editing it in a scene saved at
// "ultra" drops the whole preset a tier and coarsens BOTH lattices at once.)
// makeBlockRig.mjs therefore runs autoFit OFF with explicit bounds, and every
// arm below reads the BUILT resolution back and refuses to report an arm whose
// dial did not move the build.
//
// THE METRIC. A patch of open floor lit only by the panel carries a smooth
// falloff plus whatever structure the machinery adds. Subtract a fitted degree-3
// surface (a polynomial has no length scale of its own, unlike the blur a
// high-pass would need) and what is left is the artifact. Its size is the
// AUTOCORRELATION half-width of that residual: a piecewise-constant field of
// block size b has a triangular ACF, 1 − k/b, so ACF = 0.5 at k = b/2 and
//
//     blockSize = 2 × (lag where the ACF crosses one half)
//
// measured separately along world x and world z, in metres via the projected
// pixel scale. Reported next to the arm's own voxel size and probe spacing, so
// "the blocks ARE the cells" is a number and not an impression.
//
// FLICKER COMES FREE. Three frames of an identical settled scene, differenced:
// the RMS is how much it flickers and the ACF of the difference is the size of
// what flickers. With the field EMA and the probe EMA both off (rig sets
// temporalBlend 1, probeSmoothing 1) a settled static scene should be
// deterministic — anything left is the sampling cadence (traceParity /
// feedbackParity / the checker), which is the "dithered" half of the report.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-block-size.mjs
//
// Env:
//   GEN_ROOT=<dir>     generated project location
//   SWEEP=voxel,probe  which dials to sweep (default both)
//   VOXELS=a,b,c       voxel sizes    (default 0.1,0.15,0.225,0.34,0.5)
//   PROBES=a,b,c       probe spacings (default 0.25,0.375,0.55,0.8)
//   BASE_VOXEL / BASE_PROBE   the value the OTHER dial is pinned at
//   MODE=emissive|albedo      panel emits, or a sun lights a green panel
//   MOVER=1            pin the panel `giMobility: "dynamic"` (exact mover,
//                      no voxels of its own — the user's rotating-box case)
//   FRAMES=3           frames captured per arm for the flicker metric
//   SETTLE=12000       ms after each rebuild
//   SHOT=<dir>         frame dumps
//   GLOBALS=a=1,b=0    live GI knobs set before any module runs
//   HEADED=1
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeBlockRigProject, BLOCK_RIG } from "./lib/makeBlockRig.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-block-size")).replaceAll("\\", "/");
const SWEEP = (process.env.SWEEP ?? "voxel,probe").split(",").map((s) => s.trim()).filter(Boolean);
const nums = (env, dflt) => (env ?? dflt).split(",").map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
const VOXELS = nums(process.env.VOXELS, "0.1,0.15,0.225,0.34,0.5");
const PROBES = nums(process.env.PROBES, "0.25,0.375,0.55,0.8");
const BASE_VOXEL = Number(process.env.BASE_VOXEL ?? 0.15);
const BASE_PROBE = Number(process.env.BASE_PROBE ?? 0.375);
const MODE = process.env.MODE ?? "emissive";
const MOVER = process.env.MOVER === "1";
const FRAMES = Number(process.env.FRAMES ?? 3);
const SETTLE = Number(process.env.SETTLE ?? 12000);
const SHOT = process.env.SHOT ?? ".gi-shots/block-size";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Clamp warnings BEFORE the run rather than a puzzling flat curve after it:
// res clamps at MAX_AXIS_RES=128 and c0Grid at MAX_PROBE_AXIS=48, so a value
// past either end measures the clamp.
const tooFine = VOXELS.filter((v) => v < BLOCK_RIG.minVoxel);
const tooDense = PROBES.filter((v) => v < BLOCK_RIG.minProbe);
if (tooFine.length) console.log(`  !! voxel sizes below ${BLOCK_RIG.minVoxel.toFixed(3)} clamp at MAX_AXIS_RES: ${tooFine.join(", ")}`);
if (tooDense.length) console.log(`  !! probe spacings below ${BLOCK_RIG.minProbe.toFixed(3)} clamp at MAX_PROBE_AXIS: ${tooDense.join(", ")}`);

await makeBlockRigProject(GEN_ROOT, { voxelSize: BASE_VOXEL, probeSpacing: BASE_PROBE, mover: MOVER });
console.log(`  generated block rig at ${GEN_ROOT}`);
console.log(`  mode ${MODE}${MOVER ? " (panel pinned as an EXACT MOVER)" : ""}   sweeps: ${SWEEP.join(", ")}`);
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
await page.setViewport({ width: 1800, height: 1150, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) { built++; console.log(`  ${t.slice(0, 200)}`); }
  else if (/occupancy backend|dynamic-objects/i.test(t)) console.log(`  ${t.slice(0, 160)}`);
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.message ?? String(e)).slice(0, 200)}`));

const GLOBALS = (process.env.GLOBALS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (GLOBALS.length) console.log(`  globals: ${GLOBALS.join(" ")}`);
await page.evaluateOnNewDocument((project, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
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
const panel = byName("Panel");
const sun = byName("Sun");
if (!giEntity || !panel || !sun) {
  console.log("FATAL: rig entities missing");
  await browser.close();
  process.exit(1);
}
for (let i = 0; i < 120 && built === 0; i++) await wait(1000);
await wait(6000);

// The screenshot resolution must equal the CANVAS resolution: the GI resolve is
// sized from the drawing buffer, so a bigger screenshot only upsamples GI data
// that was computed at canvas size. Block size is a world quantity either way,
// but matching keeps the pixel noise floor honest.
const canvasSize = await page.evaluate(() => {
  const c = globalThis.__viewport?.canvas ?? document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
const W = Math.min(2048, Math.max(320, canvasSize?.w ?? 1400));
const H = Math.min(2048, Math.max(240, canvasSize?.h ?? 900));
console.log(`  canvas ${canvasSize?.w}x${canvasSize?.h} → screenshots at ${W}x${H}`);

// Narrow fov: see BLOCK_RIG.fov. viewport.screenshot overrides only the ASPECT,
// so a fov set here is the fov the capture uses.
await page.evaluate((fov) => {
  const cam = globalThis.__viewport?.camera;
  if (cam) { cam.fov = fov; cam.updateProjectionMatrix(); }
}, BLOCK_RIG.fov);
await must("viewport.setCamera", { position: BLOCK_RIG.eye, target: BLOCK_RIG.target });
await wait(2500);

/** Exact world→pixel through the LIVE camera (never rebuild the basis here). */
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

// ---- the patch, in pixels, plus the px/m scale on each world axis ----------
const { x0, x1, z0, z1 } = BLOCK_RIG.patch;
const cornersW = [[x0, 0, z0], [x1, 0, z0], [x0, 0, z1], [x1, 0, z1]];
const cpx = await projectPoints(cornersW);
if (cpx.some((p) => !p)) { console.log("FATAL: patch corners do not project"); await browser.close(); process.exit(1); }
const rect = {
  x: Math.round(Math.min(...cpx.map((p) => p.x))),
  y: Math.round(Math.min(...cpx.map((p) => p.y))),
  w: Math.round(Math.max(...cpx.map((p) => p.x)) - Math.min(...cpx.map((p) => p.x))),
  h: Math.round(Math.max(...cpx.map((p) => p.y)) - Math.min(...cpx.map((p) => p.y))),
};
// Which IMAGE axis each WORLD axis runs along, and how many px per metre. A
// steep camera keeps them aligned; assert it rather than assume it, because a
// 20° tilt would silently mix an x-lag with a z-lag.
const [pA, pB, pC] = await projectPoints([[x0, 0, 0], [x0 + 1, 0, 0], [x0, 0, 1]]);
const dX = { x: pB.x - pA.x, y: pB.y - pA.y };
const dZ = { x: pC.x - pA.x, y: pC.y - pA.y };
const pxPerMx = Math.hypot(dX.x, dX.y);
const pxPerMz = Math.hypot(dZ.x, dZ.y);
const skewX = (Math.atan2(Math.abs(dX.y), Math.abs(dX.x)) * 180) / Math.PI;
const skewZ = (Math.atan2(Math.abs(dZ.x), Math.abs(dZ.y)) * 180) / Math.PI;
console.log(
  `  patch ${x0}…${x1}m × ${z0}…${z1}m → px rect ${rect.w}x${rect.h} at (${rect.x},${rect.y}); ` +
    `${pxPerMx.toFixed(1)} px/m along world x, ${pxPerMz.toFixed(1)} along world z ` +
    `(image-axis skew ${skewX.toFixed(1)}°/${skewZ.toFixed(1)}° — >8° would mix the two lags)`,
);
if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > W || rect.y + rect.h > H) {
  console.log("FATAL: the patch does not fit in the frame");
  await browser.close();
  process.exit(1);
}

/**
 * The whole measurement, run in-page on the decoded PNGs of one arm.
 *
 * frames[0] is the STATIC image (block size of the artifact itself); the
 * pairwise differences are the FLICKER (how much, and at what size).
 */
async function analyze(frameB64s) {
  return page.evaluate(async ({ urls, rect, pxPerMx, pxPerMz, mode }) => {
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const { x, y, w, h } = rect;

    /** One frame → the scalar field the measurement is about. */
    async function fieldOf(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(x, y, w, h).data;
      const out = new Float64Array(w * h);
      let clipped = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = toLinear(d[i] / 255), gg = toLinear(d[i + 1] / 255), b = toLinear(d[i + 2] / 255);
        if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) clipped++;
        // ALBEDO mode measures the panel's HUE arriving on a floor the sun also
        // lights white; EMISSIVE mode has no white term at all, so luminance IS
        // the transport.
        out[p] = mode === "albedo"
          ? (r + b > 1e-6 ? (2 * gg) / (r + b) : 0)
          : 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      }
      return { field: out, clipped: clipped / (w * h) };
    }

    /** Solve a small symmetric system in place (Gauss + partial pivot). */
    function solve(A, b) {
      const T = b.length;
      const M = A.map((row, a) => [...row, b[a]]);
      for (let col = 0; col < T; col++) {
        let piv = col;
        for (let r = col + 1; r < T; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        [M[col], M[piv]] = [M[piv], M[col]];
        if (Math.abs(M[col][col]) < 1e-18) return null;
        for (let r = 0; r < T; r++) {
          if (r === col) continue;
          const f = M[r][col] / M[col][col];
          for (let c = col; c <= T; c++) M[r][c] -= f * M[col][c];
        }
      }
      return M.map((row, a) => row[T] / row[a]);
    }

    /**
     * Relative residual, detrended PER LINE along the axis being measured: each
     * line parallel to that axis gets its own cubic removed and is divided by
     * its own mean.
     *
     * PER LINE, not one 2D surface fit, and normalised by a line MEAN, not by
     * the fit's local value. Both were learned from the first run of this rig:
     * a 2D cubic could not follow a 1/d²-ish falloff across the patch, so a
     * large-scale trend survived into the residual and pushed the ACF to 0.99
     * at every lag ("blocks" of 1.4m that were just the falloff); and dividing
     * by a fit that passes near zero in the dark far field reported residuals
     * 39× the signal. A 1D cubic along the measurement direction has no such
     * trouble, and a scalar per-line mean cannot blow up.
     *
     * The price is an upper limit: structure larger than roughly a third of the
     * patch is absorbed by the cubic. The patch span is printed so that ceiling
     * is visible next to any number this produces.
     */
    function lineResidual(field, axis) {
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const get = (o, i) => (axis === "x" ? field[o * w + i] : field[i * w + o]);
      const resid = new Float64Array(w * h);
      const T = 4;
      let meanAcc = 0, dark = 0, lines = 0;
      for (let o = 0; o < outer; o++) {
        const A = Array.from({ length: T }, () => new Float64Array(T));
        const bv = new Float64Array(T);
        let sum = 0;
        for (let i = 0; i < inner; i++) {
          const t = (2 * i) / (inner - 1) - 1;
          const B = [1, t, t * t, t * t * t];
          const val = get(o, i);
          sum += val;
          for (let a = 0; a < T; a++) {
            bv[a] += B[a] * val;
            for (let c = 0; c < T; c++) A[a][c] += B[a] * B[c];
          }
        }
        const mean = sum / inner;
        meanAcc += mean;
        lines++;
        if (mean < 2e-3) dark++;
        const coef = solve(A, bv);
        const denom = Math.max(mean, 1e-6);
        for (let i = 0; i < inner; i++) {
          const t = (2 * i) / (inner - 1) - 1;
          const fit = coef ? coef[0] + coef[1] * t + coef[2] * t * t + coef[3] * t * t * t : mean;
          const v = (get(o, i) - fit) / denom;
          if (axis === "x") resid[o * w + i] = v; else resid[i * w + o] = v;
        }
      }
      return { resid, mean: meanAcc / Math.max(lines, 1), darkFrac: dark / Math.max(lines, 1) };
    }

    /**
     * Unbiased autocorrelation of `resid` along one image axis, and the block
     * size it implies. A piecewise-constant field of block b has ACF 1 − k/b,
     * so the half-crossing is at b/2. Reported two ways because 8-bit
     * quantisation is a delta at lag 0 that deflates every other lag:
     *   half  — crossing of 0.5 with ACF(0) = 1 (biased small by that noise)
     *   halfC — crossing of half an ACF(0) EXTRAPOLATED from lags 1..5, which
     *           is what the signal alone would have had
     */
    function acf(resid, axis, maxLag) {
      const num = new Float64Array(maxLag + 1);
      const cnt = new Float64Array(maxLag + 1);
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const at = (o, i) => (axis === "x" ? resid[o * w + i] : resid[i * w + o]);
      for (let o = 0; o < outer; o++) {
        for (let k = 0; k <= maxLag && k < inner; k++) {
          let s = 0;
          for (let i = 0; i + k < inner; i++) s += at(o, i) * at(o, i + k);
          num[k] += s;
          cnt[k] += inner - k;
        }
      }
      const a = new Float64Array(maxLag + 1);
      for (let k = 0; k <= maxLag; k++) a[k] = num[k] / Math.max(cnt[k], 1);
      const var0 = a[0] || 1e-30;
      const norm = Array.from(a, (v) => v / var0);
      const cross = (level) => {
        for (let k = 1; k <= maxLag; k++) {
          if (norm[k] <= level) {
            const prev = norm[k - 1];
            return k - 1 + (prev - level) / Math.max(prev - norm[k], 1e-12);
          }
        }
        return NaN;
      };
      // Extrapolate ACF(0) from lags 1..5 (least squares line) — the noise
      // delta lives only at lag 0.
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = 1; k <= Math.min(5, maxLag); k++) { n++; sx += k; sy += norm[k]; sxx += k * k; sxy += k * norm[k]; }
      const slope = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-12);
      const a0 = sy / n - slope * (sx / n);
      return {
        half: cross(0.5),
        halfC: cross(Math.max(a0, 1e-6) / 2),
        zero: cross(0),
        a0extrap: a0,
        curve: Array.from(norm.slice(0, Math.min(norm.length, 40)), (v) => +v.toFixed(3)),
        rms: Math.sqrt(Math.max(var0, 0)),
      };
    }

    const frames = [];
    for (const u of urls) frames.push(await fieldOf(u));
    // A third of the patch — past that the per-line cubic has eaten the signal
    // and the ACF tail is meaningless.
    const maxLagX = Math.max(4, Math.floor(w / 3));
    const maxLagZ = Math.max(4, Math.floor(h / 3));
    const rx = lineResidual(frames[0].field, "x");
    const rz = lineResidual(frames[0].field, "z");
    const ax = acf(rx.resid, "x", maxLagX);
    const az = acf(rz.resid, "z", maxLagZ);

    // FLICKER: last frame vs first, as a fraction of the patch level. The ACF of
    // that difference says how big the flickering patches are. No detrend — a
    // difference of two frames of the same static scene has no trend to remove.
    let flick = null;
    if (frames.length > 1) {
      const diff = new Float64Array(w * h);
      const lvl = Math.max(rx.mean, 1e-6);
      let acc = 0;
      for (let p = 0; p < w * h; p++) {
        diff[p] = (frames[frames.length - 1].field[p] - frames[0].field[p]) / lvl;
        acc += diff[p] * diff[p];
      }
      const rms = Math.sqrt(acc / (w * h));
      // Below ~one quantisation step the "flicker" is the PNG, not the field,
      // and its ACF is a delta whose half-width is meaningless.
      const real = rms > 3e-3;
      const dx = real ? acf(diff, "x", maxLagX) : null;
      const dz = real ? acf(diff, "z", maxLagZ) : null;
      flick = { rms, halfX: dx?.halfC ?? NaN, halfZ: dz?.halfC ?? NaN, curveX: dx?.curve.slice(0, 16) ?? null };
    }

    return {
      mean: rx.mean,
      darkFrac: Math.max(rx.darkFrac, rz.darkFrac),
      clipped: frames[0].clipped,
      residRms: ax.rms,
      residRmsZ: az.rms,
      x: { half: ax.half, halfC: ax.halfC, zero: ax.zero, a0: ax.a0extrap, curve: ax.curve },
      z: { half: az.half, halfC: az.halfC, zero: az.zero, a0: az.a0extrap, curve: az.curve },
      flick,
      maxLagX, maxLagZ,
    };
  }, { urls: frameB64s.map((b) => `data:image/png;base64,${b}`), rect, pxPerMx, pxPerMz, mode: MODE });
}

/**
 * THE DIFFERENTIAL METRIC, and the one to believe.
 *
 * `arm ÷ reference − 1`, per pixel, against the FINEST arm of the same sweep.
 * The scene's true irradiance is identical in both, so it cancels exactly —
 * no polynomial, no blur, and therefore no length scale imposed by the
 * instrument. What survives is precisely "what this dial did to the picture",
 * and the ACF of it is the size of what it did.
 *
 * The detrended single-frame numbers above cannot do this: a per-line cubic
 * cannot follow the panel's falloff exactly, and its misfit is a fixed ~0.3-0.5m
 * shape that lands in the residual of EVERY arm — which is how the first sweep
 * reported a ~0.50m block in z for all nine arms including ones that differed
 * by 5x.
 */
async function compare(refB64, armB64) {
  return page.evaluate(async ({ refUrl, armUrl, rect, mode }) => {
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const { x, y, w, h } = rect;
    async function fieldOf(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(x, y, w, h).data;
      const out = new Float64Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = toLinear(d[i] / 255), gg = toLinear(d[i + 1] / 255), b = toLinear(d[i + 2] / 255);
        out[p] = mode === "albedo" ? (r + b > 1e-6 ? (2 * gg) / (r + b) : 0) : 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      }
      return out;
    }
    const A = await fieldOf(armUrl);
    const R = await fieldOf(refUrl);
    const diff = new Float64Array(w * h);
    let acc = 0, n = 0;
    for (let p = 0; p < w * h; p++) {
      if (R[p] < 1e-4) { diff[p] = 0; continue; }
      diff[p] = A[p] / R[p] - 1;
      acc += diff[p] * diff[p]; n++;
    }
    const rms = Math.sqrt(acc / Math.max(n, 1));
    // Same unbiased ACF as the single-frame metric, inlined so this call does
    // not depend on the other evaluate's scope.
    const acf = (axis, maxLag) => {
      const outer = axis === "x" ? h : w;
      const inner = axis === "x" ? w : h;
      const at = (o, i) => (axis === "x" ? diff[o * w + i] : diff[i * w + o]);
      const num = new Float64Array(maxLag + 1), cnt = new Float64Array(maxLag + 1);
      for (let o = 0; o < outer; o++) {
        for (let k = 0; k <= maxLag && k < inner; k++) {
          let s = 0;
          for (let i = 0; i + k < inner; i++) s += at(o, i) * at(o, i + k);
          num[k] += s; cnt[k] += inner - k;
        }
      }
      // Mean-removed: a uniform brightness shift between arms (a real thing —
      // a coarser lattice loses energy) is a DC term that would otherwise read
      // as infinite correlation length.
      let mean = 0;
      for (let p = 0; p < w * h; p++) mean += diff[p];
      mean /= w * h;
      const a = new Float64Array(maxLag + 1);
      for (let k = 0; k <= maxLag; k++) a[k] = num[k] / Math.max(cnt[k], 1) - mean * mean;
      const norm = Array.from(a, (v) => v / (a[0] || 1e-30));
      let cross = NaN;
      for (let k = 1; k <= maxLag; k++) {
        if (norm[k] <= 0.5) { cross = k - 1 + (norm[k - 1] - 0.5) / Math.max(norm[k - 1] - norm[k], 1e-12); break; }
      }
      return { half: cross, curve: Array.from(norm.slice(0, 30), (v) => +v.toFixed(3)), dc: mean };
    };
    const maxLagX = Math.max(4, Math.floor(w / 2));
    const maxLagZ = Math.max(4, Math.floor(h / 2));
    const ax = acf("x", maxLagX), az = acf("z", maxLagZ);
    return { rms, dc: ax.dc, halfX: ax.half, halfZ: az.half, curveX: ax.curve, curveZ: az.curve };
  }, { refUrl: `data:image/png;base64,${refB64}`, armUrl: `data:image/png;base64,${armB64}`, rect, mode: MODE });
}

/** What the build ACTUALLY used — the guard against an inert dial. */
const builtState = () =>
  page.evaluate(async () => {
    let sys = null;
    const list = await globalThis.__editorApi.call("entity.list", {});
    for (const e of list ?? []) {
      const s = globalThis.__editorApi.entities.live(e.id)?.engine?.modules?.get("gi")?.system;
      if (s) { sys = s; break; }
    }
    const st = sys?.state;
    if (!st) return { error: "no gi system" };
    const cell = st.volume?.cell?.value ?? st.volume?.cell ?? null;
    return {
      res: st.volume?.res ? { x: st.volume.res.x, y: st.volume.res.y, z: st.volume.res.z } : null,
      cell: cell ? { x: +cell.x.toFixed(4), y: +cell.y.toFixed(4), z: +cell.z.toFixed(4) } : null,
      c0Grid: st.c0Grid ? { x: st.c0Grid.x, y: st.c0Grid.y, z: st.c0Grid.z } : null,
      probeSpacing: st.probeSpacing,
      autoFit: st.autoFit,
      size: st.buildSize ? [+st.buildSize.x.toFixed(2), +st.buildSize.y.toFixed(2), +st.buildSize.z.toFixed(2)] : null,
      adopted: sys._dynSet?.count?.() ?? 0,
    };
  });

async function shoot(tag) {
  const shot = await must("viewport.screenshot", { width: W, height: H, includeGizmos: false });
  await writeFile(path.join(SHOT, `block-${tag}.png`), Buffer.from(shot.__image.base64, "base64"));
  return shot.__image.base64;
}

// ---- albedo mode needs the sun on --------------------------------------------
if (MODE === "albedo") {
  await must("component.setProp", { id: panel.id, type: "mesh", key: "material", value: `${GEN_ROOT}/materials/PanelGreen.mat` });
  await must("component.setProp", { id: sun.id, type: "light", key: "intensity", value: BLOCK_RIG.sunIntensity });
  await wait(4000);
}

const f = (v, w = 7, p = 3) => (Number.isFinite(v) ? v.toFixed(p) : "-").padStart(w);

// ---- ABLATION MODE ----------------------------------------------------------
// Every suspect term in the cascade/merge chain already has a live hatch. They
// are read at BUILD time, so setting one only takes effect on the next rebuild —
// which is why each group nudges voxelSize by 1e-4 (a value change large enough
// to re-enter #rebuild, small enough that `round(12/0.1501) == round(12/0.15)`
// leaves the built grid bit-identical). Without that nudge the globals are set
// and nothing happens, which is exactly the "I tried it and saw no difference"
// failure the cascadeTrace comment warns about.
if (process.env.ABLATE) {
  const groups = process.env.ABLATE.split("|").map((s) => s.trim());
  const all = ["", ...groups];
  const shots = [];
  for (let i = 0; i < all.length; i++) {
    const spec = all[i];
    const kv = spec ? spec.split(",").map((s) => s.split("=")) : [];
    await page.evaluate(({ pairs, clear }) => {
      for (const k of clear) delete globalThis[k];
      for (const [k, v] of pairs) {
        globalThis[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
      }
    }, {
      pairs: kv,
      clear: groups.flatMap((g) => g.split(",").map((s) => s.split("=")[0])),
    });
    const before = built;
    await must("component.setProp", {
      id: giEntity.id, type: "global-illumination", key: "voxelSize", value: BASE_VOXEL + i * 1e-4,
    });
    for (let k = 0; k < 60 && built === before; k++) await wait(500);
    await wait(SETTLE);
    const tag = spec ? spec.replaceAll(/[^\w.=-]/g, "_") : "baseline";
    const b64 = await shoot(`ablate-${i}-${tag}`);
    const m = await analyze([b64]);
    shots.push({ spec: spec || "(baseline)", b64, m });
    console.log(`  ablate ${(spec || "(baseline)").padEnd(34)} modulation x ${(m.residRms * 100).toFixed(2)}%  z ${(m.residRmsZ * 100).toFixed(2)}%  level ${m.mean.toFixed(4)}`);
  }
  console.log(`\n=== ABLATION — which term carries the artifact? (vs baseline) ===`);
  console.log(`  hatch                              | mod x%  Δmod   | change rms  mean shift | change size x`);
  const base = shots[0];
  for (const s of shots.slice(1)) {
    const d = await compare(base.b64, s.b64);
    console.log(
      `  ${s.spec.padEnd(34)} | ${f(s.m.residRms * 100, 6, 2)} ${f((s.m.residRms - base.m.residRms) * 100, 6, 2)} | ` +
        `${f(d.rms * 100, 10, 2)}%  ${f(d.dc * 100, 9, 2)}% | ${f((d.halfX * 2) / pxPerMx, 12)}m`,
    );
  }
  console.log(`\n  frames: ${SHOT}`);
  await browser.close();
  process.exit(0);
}

// ---- the arms ----------------------------------------------------------------
const arms = [];
if (SWEEP.includes("voxel")) for (const v of VOXELS) arms.push({ dial: "voxel", voxelSize: v, probeSpacing: BASE_PROBE });
if (SWEEP.includes("probe")) for (const p of PROBES) arms.push({ dial: "probe", voxelSize: BASE_VOXEL, probeSpacing: p });

const results = [];
for (const arm of arms) {
  const tag = `${arm.dial}-v${arm.voxelSize}-p${arm.probeSpacing}`;
  const before = built;
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "voxelSize", value: arm.voxelSize });
  await must("component.setProp", { id: giEntity.id, type: "global-illumination", key: "probeSpacing", value: arm.probeSpacing });
  for (let i = 0; i < 60 && built === before; i++) await wait(500);
  await wait(SETTLE);
  const state = await builtState();
  const shots = [];
  for (let f = 0; f < FRAMES; f++) {
    shots.push(await shoot(f === 0 ? tag : `${tag}-f${f}`));
    if (f < FRAMES - 1) await wait(700);
  }
  const m = await analyze(shots);
  results.push({ arm, state, m, shot: shots[0] });
  const cell = state.cell?.x ?? NaN;
  console.log(
    `  ${tag.padEnd(26)} built cell ${cell?.toFixed?.(3) ?? "?"}m res ${state.res ? `${state.res.x}x${state.res.y}x${state.res.z}` : "?"} | ` +
      `probe ${state.probeSpacing?.toFixed?.(3)}m c0 ${state.c0Grid ? `${state.c0Grid.x}x${state.c0Grid.y}x${state.c0Grid.z}` : "?"}` +
      (m.error ? `  !! ${m.error}` : ""),
  );
}

// ---- report ------------------------------------------------------------------
const blockX = (r) => (r.m.x?.halfC * 2) / pxPerMx;
const blockZ = (r) => (r.m.z?.halfC * 2) / pxPerMz;

console.log(`\n=== BLOCK SIZE ON THE FLOOR (ACF half-width × 2, metres) ===`);
console.log(`  patch spans ${(BLOCK_RIG.patch.x1 - BLOCK_RIG.patch.x0).toFixed(1)}m in x, ` +
  `${(BLOCK_RIG.patch.z1 - BLOCK_RIG.patch.z0).toFixed(1)}m in z — structure above ~1/3 of that is absorbed by the detrend.`);
console.log(`  dial   requested   built cell   built probe |  block x   block z |  mod x%  mod z% |  level  flicker%  flick size`);
for (const r of results) {
  const req = r.arm.dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing;
  console.log(
    `  ${r.arm.dial.padEnd(6)} ${f(req, 9)}   ${f(r.state.cell?.x, 10)}   ${f(r.state.probeSpacing, 11)} | ` +
      `${f(blockX(r), 8)}  ${f(blockZ(r), 8)} | ${f(r.m.residRms * 100, 6, 2)}  ${f(r.m.residRmsZ * 100, 6, 2)} | ` +
      `${f(r.m.mean, 6, 4)}  ${f((r.m.flick?.rms ?? 0) * 100, 8, 3)}  ${f((r.m.flick?.halfX * 2) / pxPerMx, 10)}` +
      ((r.m.darkFrac ?? 0) > 0.1 ? `  !! ${((r.m.darkFrac ?? 0) * 100).toFixed(0)}% of lines are near-black` : ""),
  );
}

// THE DISCRIMINATOR. If the block size tracks a dial, the ratio block/dial is
// flat across that sweep and the slope of block vs dial is ~1. A dial the
// artifact does not belong to shows a flat BLOCK column instead.
console.log(`\n=== WHICH LATTICE? (slope of block size vs the dial, over each sweep) ===`);
for (const dial of ["voxel", "probe"]) for (const axis of ["x", "z"]) {
  const metric = axis === "x" ? blockX : blockZ;
  const rows = results.filter((r) => r.arm.dial === dial && Number.isFinite(metric(r)));
  if (rows.length < 2) continue;
  // Regress block size on the value the build ACTUALLY used, not the request.
  const xs = rows.map((r) => (dial === "voxel" ? r.state.cell?.x : r.state.probeSpacing) ?? NaN);
  const ys = rows.map(metric);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxy / Math.max(sxx, 1e-12);
  const r2 = (sxy * sxy) / Math.max(sxx * syy, 1e-12);
  const span = Math.max(...xs) / Math.min(...xs);
  const blockSpan = Math.max(...ys) / Math.min(...ys);
  console.log(
    `  ${dial.padEnd(6)} block-${axis}: dial spans ${span.toFixed(1)}x → block spans ${blockSpan.toFixed(2)}x   ` +
      `slope ${f(slope, 6, 2)}  r² ${f(r2, 5, 2)}  ` +
      (blockSpan < 1.25
        ? "→ the artifact IGNORES this dial"
        : slope > 0.4
          ? "→ THE ARTIFACT SCALES WITH THIS DIAL"
          : "→ partial / mixed"),
  );
}

// ---- the differential: every arm against the FINEST arm of its own sweep ----
console.log(`\n=== WHAT THE DIAL ACTUALLY CHANGED (arm ÷ finest arm of the same sweep) ===`);
console.log(`  dial   value    built |  change rms  mean shift |  change size x   change size z`);
for (const dial of ["voxel", "probe"]) {
  const rows = results.filter((r) => r.arm.dial === dial);
  if (rows.length < 2) continue;
  const ref = rows[0];
  for (const r of rows.slice(1)) {
    const d = await compare(ref.shot, r.shot);
    r.diff = d;
    const built = dial === "voxel" ? r.state.cell?.x : r.state.probeSpacing;
    const refBuilt = dial === "voxel" ? ref.state.cell?.x : ref.state.probeSpacing;
    console.log(
      `  ${dial.padEnd(6)} ${f(dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing, 6)}  ${f(built, 7)} | ` +
        `${f(d.rms * 100, 10, 2)}%  ${f(d.dc * 100, 9, 2)}% | ${f((d.halfX * 2) / pxPerMx, 13)}m  ${f((d.halfZ * 2) / pxPerMz, 13)}m` +
        `   (vs ${refBuilt?.toFixed?.(3)})`,
    );
  }
}

console.log(`\n=== ACF CURVES (lag in px; ${pxPerMx.toFixed(0)} px/m along x) ===`);
for (const r of results) {
  const req = r.arm.dial === "voxel" ? r.arm.voxelSize : r.arm.probeSpacing;
  console.log(`  ${r.arm.dial}=${req}  x: ${(r.m.x?.curve ?? []).slice(0, 24).join(" ")}`);
}

const anyClipped = results.filter((r) => (r.m.clipped ?? 0) > 0.001);
if (anyClipped.length) console.log(`\n  !! ${anyClipped.length} arms have clipped pixels in the patch — those residuals under-report.`);
const inert = results.filter((r, i) => i > 0 && results[i - 1].arm.dial === r.arm.dial &&
  results[i - 1].state.cell?.x === r.state.cell?.x && results[i - 1].state.probeSpacing === r.state.probeSpacing);
if (inert.length) console.log(`  !! ${inert.length} arms built IDENTICALLY to the arm before them — that dial did not move the build.`);
console.log(`\n  frames: ${SHOT}`);

await writeFile(
  path.join(SHOT, "block-size.json"),
  // `shot` is a whole base64 PNG per arm — the frames are already on disk.
  JSON.stringify({ pxPerMx, pxPerMz, rect, results: results.map(({ shot, ...rest }) => rest) }, null, 1),
);
await browser.close();
process.exit(0);
