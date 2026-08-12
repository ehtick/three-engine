// [J] THE SECONDARY BOUNCE, ON THE GPU — R4's divergence gate (§12.39).
//
// The multibounce is a temporal fixed-point iteration: shadeHit samples the
// PRIMARY tile atlas (last frame's bake) at every hit, so tile energy feeds
// tile energy with in-loop gain bounded by `clampLoopAlbedo` (R4,
// MAX_LOOP_ALBEDO = 0.9). The CPU mirror measured the contraction at exactly
// 0.9000 and the claim is ASYMPTOTIC — §12.26 recorded "every increment
// ratio < 1" FAILING at 1.2494 on the second increment, because a power
// iteration overshoots early. So this gate asserts the TAIL, not the head.
//
// Scene: the generated Cornell project — a CLOSED box (the worst case for a
// feedback loop: nothing escapes) whose only light is an emissive cube.
//
// Arms, in ONE page (a temporal A/B across processes is the comparison the
// flicker rig's header forbids). [J] IS NOW A PASS OF ITS OWN
// (`srcSecondary.js`) and therefore DEFAULT ON from the tier — the opt-in
// existed only while the bounce was inlined into the hit shader, where it cost
// 48 seconds of pipeline compile per boot (§12.39). So the arms swap roles: the
// BOUNCE arm is the plain build, and the SINGLE arm is the one carrying a flag.
//   multibounce  the shipping default. Settle, then measure wall patches over
//                K rounds: the round increments must CONTRACT at the tail, and
//                the fixed point must sit ABOVE the single-bounce arm (in a
//                closed box the series 1 + ρ̄ + ρ̄² … is worth +10% at the very
//                least) and BELOW R4's hard ceiling (×10 at ρ = 0.9 — in
//                practice ~×2; past it the loop is not contracting).
//   single       `__giSrcSecondary = false` + a quality toggle to force the
//                rebuild (the eyecheck's runtime arm measured toggle ≡ reload
//                at 1.018×), then the same settle + measure.
//
// ⚠ THE IMAGE ARMS ALONE CANNOT PASS THIS. A [J] whose pipeline silently fails
// to create dispatches nothing and renders a frame that looks single-bounce,
// and two arms of temporal noise can clear a +8% bar by themselves. So the
// COUNTERS are asserted too: `secondaryHits > 0` says the pass ran, and
// `secondaryOverflow === 0` says the hit list held every hit it was handed.
//
//   node scripts/run-gi-src-secondary-probe.mjs [url]
// Env: EMIT (default 4), SHOT (default scripts), HEADED=1
import path from "node:path";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-src")).replaceAll("\\", "/");
await makeCornellProject(GEN_ROOT, { emitStrength: Number(process.env.EMIT ?? 4) });
const SHOT = process.env.SHOT ?? "scripts";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PATCHES = [
  { name: "redwall", x: 0.23, y: 0.30, w: 0.10, h: 0.35 },
  { name: "greenwall", x: 0.68, y: 0.30, w: 0.10, h: 0.35 },
  { name: "floor", x: 0.37, y: 0.74, w: 0.26, h: 0.16 },
];

async function wallMean(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, n = 0;
  for (const p of PATCHES) {
    const x0 = Math.round(p.x * info.width), y0 = Math.round(p.y * info.height);
    const x1 = Math.round((p.x + p.w) * info.width), y1 = Math.round((p.y + p.h) * info.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * 3;
        sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        n++;
      }
    }
  }
  return sum / Math.max(1, n);
}

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
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  // `field ready` is in this filter because leaving it out cost a run: the
  // first version measured its 8 rounds INSIDE the bounce arm's 48 s pipeline
  // compile (nothing had deposited yet), read 0.0000 everywhere, and reported
  // the loop as failing to add energy — an instrument measuring a build that
  // was not looking yet.
  if (/\[gi\] (src probes|built|diffuse indirect|field ready)/.test(t)) {
    giLines.push(t);
    console.log(`  ${t.slice(0, 170)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 190)}`);
});
await page.evaluateOnNewDocument((P) => {
  localStorage.setItem("engine.projectRoot.v1", P);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
  globalThis.__editorKeepRendering = true;
  // Redundant since [J] became a pass and the gate flipped to default-on, and
  // kept deliberately: it pins the ARM rather than inheriting it, so this run
  // still means "multibounce" if the default ever moves again.
  globalThis.__giSrcSecondary = true;
}, GEN_ROOT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
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

const waitBuilt = async (label) => {
  const before = giLines.length;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (giLines.slice(before).some((l) => /\[gi\] src probes/.test(l))) return;
    await wait(1000);
  }
  throw new Error(`${label}: no "[gi] src probes" line within 180s`);
};
await waitBuilt("boot");
// The GI entity, for the rebuild toggle.
let gi = null;
for (let i = 0; i < 60 && !gi; i++) {
  const r = await call("entity.list", {});
  if (r.ok) gi = (r.value ?? []).find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
  if (!gi) await wait(1000);
}
if (!gi) throw new Error("no GI entity");
await page.evaluate(() => globalThis.__editorApi.call("viewport.freezeWhenUnfocused", { enabled: false })).catch(() => {});
await must("viewport.setCamera", { position: [0.0, 2.6, 6.0], target: [0.0, 2.5, -1.0] });

/** Wait for a NEW "[gi] field ready" after `mark` — the voxelize gate every
 *  probe here inherits from the emitter-shadow probe's contract. */
const waitReady = async (label, mark) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (giLines.slice(mark).some((l) => /\[gi\] field ready/.test(l))) return;
    await wait(1000);
  }
  throw new Error(`${label}: no "[gi] field ready" within 180s`);
};

/** Rounds until the tail stabilizes (last 3 within 2%) — minimum 8, ceiling
 *  ~150 s, which covers the bounce arm's 48 s pipeline compile with margin. */
const rounds = async (label) => {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await wait(2500);
    const s = await page.evaluate(() =>
      globalThis.__editorApi.call("viewport.screenshot", { width: 1100, height: 700, includeGizmos: false }));
    const buf = Buffer.from(s.__image.base64, "base64");
    out.push({ mean: await wallMean(buf), buf });
    const n = out.length;
    if (n >= 8) {
      const [a, b, c] = [out[n - 3].mean, out[n - 2].mean, out[n - 1].mean];
      const mid = Math.max(1e-6, (a + b + c) / 3);
      if (c > 0.005 && Math.abs(a - mid) / mid < 0.02 && Math.abs(c - mid) / mid < 0.02) break;
    }
  }
  console.log(`  ${label} rounds (${out.length}): ${out.map((r) => r.mean.toFixed(4)).join("  ")}`);
  return out;
};

/**
 * [J]'s counters, off the built system — the half of this gate no screenshot
 * can supply. `secondaryHits` is written by the secondary kernel itself, so it
 * is zero exactly when the pass did not run (missing from `passes`, a pipeline
 * that failed to create, an empty hit list), and a build in that state produces
 * the same image as a scene whose second bounce is genuinely faint.
 */
const readSecondary = () =>
  page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const sp = engine.modules.get("gi")?.system?.state?.screen?.srcProbes;
    if (!sp) return { built: false };
    const s = await sp.readStats(engine.renderer);
    return {
      built: true,
      pass: !!sp.secondary,
      passes: sp.passes?.length ?? 0,
      groups: (sp.passGroups ?? []).reduce((n, g) => n + g.count, 0),
      capacity: sp.secondary?.capacity ?? 0,
      hits: s.rays?.secondaryHits ?? 0,
      clamped: s.rays?.secondaryClamped ?? 0,
      overflow: s.rays?.secondaryOverflow ?? 0,
      shadedHits: s.rays?.shaded ?? 0,
    };
  });

console.log("== ARM multibounce (the shipping default)");
await waitReady("multibounce", 0);
const A = await rounds("multibounce");
const secA = await readSecondary();
console.log(`  [J] multibounce: ${JSON.stringify(secA)}`);
await writeFile(path.join(SHOT, "gi-src-secondary-multibounce.png"), A[A.length - 1].buf);

console.log("== ARM single (opted out, rebuild via quality toggle)");
// `= false` and not `undefined`: under the default-on gate an unset flag IS
// multibounce, so clearing it would compare the loop to itself.
await page.evaluate(() => { globalThis.__giSrcSecondary = false; });
const toggleMark = giLines.length;
await must("component.setProp", { id: gi.id, type: "global-illumination", key: "quality", value: "medium" });
await waitBuilt("toggle-out");
await must("component.setProp", { id: gi.id, type: "global-illumination", key: "quality", value: "high" });
await waitBuilt("toggle-back");
await waitReady("single", toggleMark);
const B = await rounds("single");
const secB = await readSecondary();
console.log(`  [J] single: ${JSON.stringify(secB)}`);
await writeFile(path.join(SHOT, "gi-src-secondary-single.png"), B[B.length - 1].buf);

let failed = 0;
const check = (ok, label) => { console.log(` ${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failed++; };

const mA = A[A.length - 1].mean, mB = B[B.length - 1].mean;
// A rig fault is not a verdict: an emissive cube in a closed box cannot
// legitimately read black on BOTH arms — that is the instrument not looking
// (compile still in flight, field unvoxelized, frozen canvas), and reporting
// it as "the loop adds no energy" is the §12.30 lie shape.
if (mA < 0.005 && mB < 0.005) {
  console.log(" FAIL both arms read black — instrument fault (see the field-ready/compile guards), not a loop verdict");
  await browser.close();
  process.exit(1);
}
// Tail contraction: the LAST increment must not exceed the one before it by
// more than noise. §12.26's lesson verbatim — the head of a power iteration
// overshoots, so only the tail is a contraction claim. Guard the ratio against
// a near-zero denominator (converged = increments inside noise = pass).
const inc = (r) => r.slice(1).map((x, i) => Math.abs(x.mean - r[i].mean));
const iA = inc(A);
const noise = Math.max(0.002, mA * 0.02);
const tailContracts = iA[iA.length - 1] <= Math.max(noise, iA[iA.length - 2] * 1.0);
check(tailContracts,
  `multibounce converges: tail increments ${iA.slice(-3).map((x) => x.toFixed(4)).join(" → ")} (noise floor ${noise.toFixed(4)})`);
check(mA > mB * 1.08,
  `the loop adds energy in a closed box: multibounce ${mA.toFixed(4)} vs single ${mB.toFixed(4)} (+${((mA / mB - 1) * 100).toFixed(1)}%)`);
check(mA < mB * 10,
  `and R4 bounds it: ${(mA / mB).toFixed(2)}x is inside the 1/(1-0.9) = 10x hard ceiling`);
// ── THE PASS RAN, AND IT IS NOT AN IMAGE CLAIM ─────────────────────────────
//
// Asserted before the boot lines below because a flag and a log line agree
// with each other whether or not a kernel dispatched; this counter is written
// by the kernel itself.
check(secA.pass === true, `the multibounce arm BUILT [J] (${secA.passes} passes)`);
// `profile.giPasses` asserts this sum and WITHHOLDS every per-group number when
// it fails, so a drifted group list costs the whole cost breakdown rather than
// mislabelling one row — worth catching here, where inserting [J] is exactly
// the edit that can drift it.
check(secA.groups === secA.passes,
  `passGroups still accounts for every dispatch: ${secA.groups} of ${secA.passes}`);
check(secA.hits > 0,
  `[J] actually dispatched: ${secA.hits} secondary deposits of ${secA.capacity} capacity ` +
  `(${secA.shadedHits} shaded hits that frame)`);
check(secA.overflow === 0,
  `the hit list held every hit — overflow ${secA.overflow} (capacity is transportThreads x raysPerPixel, an exact bound)`);
check(secB.pass === false, `and the opted-out arm built no [J] pass (${secB.passes} passes)`);
const lineA = giLines.find((l) => /MULTIBOUNCE via the tile atlas/.test(l));
const lineB = giLines.slice().reverse().find((l) => /single bounce/.test(l));
check(!!lineA, "the boot line names the multibounce (built-state telemetry, not flags)");
check(!!lineB, "and the opted-out rebuild names single bounce");

console.log(failed ? `\ngi-src-secondary: ${failed} FAILED` : "\ngi-src-secondary: all PASS");
await browser.close();
process.exit(failed ? 1 : 0);
