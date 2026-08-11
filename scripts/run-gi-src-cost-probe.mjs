// WHAT DOES THE SRC DEPOSIT COST, AND WHAT DRIVES IT?
//
// The user's editor renders their Sponza at 3 fps on "ultra". `profile.giPasses`
// against that live editor says where it goes, and it is not spread around:
//
//     SRC chain           260.343 ms over 44 dispatches
//       deposit (trace + shade)  249.048 ms   3 dispatches   ← 95.7%
//       everything else           11.295 ms  41 dispatches
//     screen resolve        5.661 ms
//
// So one group is the frame. The open question this probe answers is WHY, and
// the candidate is the transport's DOMAIN: SRC populates one probe per gbuffer
// pixel and fires `raysPerPixel` rays at each, so its cost is anchored to the
// screen. `srcConfig.js` says so in as many words — "`raysPerPixel` counts
// full-length rays per HALF-RES gbuffer pixel" — but `giConfig.js`'s tier table
// gives ultra `resolveScale: 1`, i.e. FULL res, and the editor confirms it
// (`resolve: [1656, 950]` == `drawingBuffer`). That is 1,573,200 pixels and, at
// 2 rays/px, 3.15M rays per frame to service 5,692 live probes.
//
// ── WHY A SWEEP AND NOT ARITHMETIC ──────────────────────────────────────────
//
// Two points already exist — 78,988 px → 6.230 ms in the harness and 1,573,200
// px → 249.048 ms in the editor — and dividing them is exactly the mistake this
// module keeps paying for. Those arms differ in pixels (19.92×) AND in tier
// (high s₀=0.45 w₀=4 vs ultra s₀=0.35 w₀=8), and the times differ by 39.97×.
// Attributing all of that to pixels would be reading a two-variable change as
// one. The ratio that is NOT explained by pixels is 2.0×, which is the size of
// the thing I would be about to claim, so the confound is not a rounding
// detail — it is the whole answer.
//
// One variable moves here: `resolveScale`, forced through `__giConfigOverride`.
// Everything else — scene, tier, s₀, w₀, camera, viewport — is held.
//
// ── WHAT A RESULT MEANS ─────────────────────────────────────────────────────
//
//   deposit ms scales ~linearly with pixels  → the domain is the cost, and
//        giving SRC its own resolution independent of `resolveScale` is worth
//        the ratio directly (4× from ultra's full-res transport alone).
//   deposit ms flat, or sub-linear           → the driver is per-ray work
//        (step count through the 0.096 m occupancy field, or NEE's 4 shadow
//        rays), and the pixel count is a red herring. Go to lightTree.js.
//
// The screen mean/lit are captured at each scale for the OTHER half of the
// decision: a cheaper transport is only worth having if the image survives it.
// ⚠ `resolveScale` also sizes the screen resolve (AO) and the GI light-shadow
// passes, so the image column is NOT a clean read of "coarser transport" alone.
// It is a sanity check, not the quality verdict; the quality verdict is a
// person looking at the PNGs. (In this scene no light uses Shadow Source "gi",
// so those passes are built and never dispatched — that part of the confound
// is inert here, and the probe prints the fact rather than assuming it.)
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const URL_BASE = process.env.URL ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const OUT = process.env.OUT ?? "C:/Users/KHUDII~1/AppData/Local/Temp/claude/c--Users-Khudiiash-Documents-JS-engine/9c1503b1-2b83-4449-b77a-707e5760c11e/scratchpad";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The tier is pinned, not inherited from the saved scene — see the override
// below for the run this cost. "ultra" because that is the tier the user
// reports at 3 fps; `QUALITY=low` re-runs the same sweep at the other end.
const QUALITY = process.env.QUALITY ?? "ultra";

// The verified nave pose. OrbitControls owns the camera, so this goes through
// `viewport.setCamera` — a transform write is silently overwritten.
const POSE = { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] };

// A discarded warm-up first: on a cold process the first arm has not converged
// when a fixed timer expires, and twice that has been read as an effect of
// whatever configuration happened to run first. Same defence as the eye check.
// ── TWO SWEEPS, AND THEY ANSWER DIFFERENT QUESTIONS ─────────────────────────
//
// `SWEEP=scale` (default) moves `resolveScale`: it prices the COST of the
// transport's domain, which is what found that rays are 94% of the deposit.
// What it cannot do is price the LOOK, because `resolveScale` also sizes the
// screen resolve and the AO — a 202x155 resolve reads BRIGHTER (0.15589) than a
// 806x392 one (0.12733) on the same transport, purely from upsampling a blurrier
// occlusion term. Reading the ceiling's visual cost off that column would credit
// the stride with a change the resolve made.
//
// `SWEEP=ceiling` holds `resolveScale` at 1 and moves ONLY
// `__giSrcTransportRays`, so every arm renders at the same resolution with the
// same AO and differs in exactly one thing: how many rays the transport fired.
// That is the arm that says whether a ceiling is affordable to look at.
const SWEEP = process.env.SWEEP ?? "scale";
const SCALE_ARMS = [
  { name: "warmup", scale: 0.5, warmup: true },
  { name: "scale 1.00", scale: 1 },
  { name: "scale 0.50", scale: 0.5 },
  { name: "scale 0.25", scale: 0.25 },
];
// `ceiling: null` means "do not set the hatch" — the tier's own number. The
// unlimited arm is the REFERENCE the others are judged against, and it is a
// huge finite number rather than Infinity because the hatch takes a count.
const CEILING_ARMS = [
  { name: "warmup", scale: 1, ceiling: 1e9, warmup: true },
  { name: "unlimited", scale: 1, ceiling: 1e9 },
  { name: "ceiling 262144", scale: 1, ceiling: 262144 },
  { name: "ceiling 65536", scale: 1, ceiling: 65536 },
  { name: "ceiling 16384", scale: 1, ceiling: 16384 },
];
const ALL = SWEEP === "ceiling" ? CEILING_ARMS : SCALE_ARMS;
const only = process.env.SCALE;
const arms = only ? ALL.filter((a) => String(a.scale) === only) : ALL;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});

const results = [];
for (const arm of arms) {
  // A fresh page per arm. `resolveScale` is read when the GI system is built,
  // and rebuilding in place would also re-run the compile wave inside the
  // measurement window — the editor log shows two GI systems compiling
  // concurrently when that happens, which is its own confound.
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  const gi = [];
  let waveDone = false;
  const errors = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\]/.test(t)) gi.push(t);
    if (/compile wave: materials \d+ms, computes/.test(t)) waveDone = true;
  });
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.evaluateOnNewDocument((project, scale, qualityTier, ceiling) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giLogSrcProbes = true;
    globalThis.__giSrcProbes = true;
    globalThis.__giSrcShade = true;
    // THE ONE VARIABLE. `resolveScale` is a `giConfig` field, so the documented
    // measurement hatch reaches it without a code change and without adding a
    // knob — which is the whole point of there being exactly one hatch.
    //
    // ── AND THE TIER IS PINNED, WHICH THE FIRST RUN OF THIS FILE WAS NOT ────
    //
    // `resolveGiConfig` computes `BY_TIER[quality]` BEFORE applying the
    // override, so forcing `quality` here selects the SRC tier (s₀, w₀,
    // rays/px, secondary cache) while `resolveScale` stays whatever this arm
    // asked for. That separation is what makes a pixel sweep possible at all.
    //
    // ⚠ WITHOUT THIS the probe measures whatever tier the scene was last saved
    // at. Run 1 did exactly that: it reported a confident "NOT a clean per-ray
    // cost, ns/ray spreads 7.62×" — measured entirely at tier LOW, where the
    // deposit has a ~1.6 ms floor that swamps the ray term (316k px and 79k px
    // both read ~1.6 ms). The question was about ULTRA at 249 ms, where no such
    // floor can be within two orders of magnitude of the signal. The verdict
    // was not wrong about its own numbers; it was drawn from a different
    // experiment than the one the header describes.
    globalThis.__giConfigOverride = { quality: qualityTier, resolveScale: scale };
    if (ceiling) globalThis.__giSrcTransportRays = ceiling;
  }, PROJECT, arm.scale, QUALITY, arm.ceiling ?? null);
  await page.goto(URL_BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  try {
    await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
    const call = (op, args = {}) =>
      page.evaluate(async ({ op, args }) => {
        try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
        catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
      }, { op, args });
    // The compile wave is minutes on this project. Waiting it out is not
    // politeness — a pass timed while the driver is still compiling measures
    // the compiler.
    for (let i = 0; i < 300 && !waveDone; i++) await wait(1000);
    if (!waveDone) console.log(`  ${arm.name}: compile wave never logged — measuring anyway`);
    await call("viewport.setCamera", POSE);

    // Converge on the published signal rather than a timer.
    const shadedOf = () => {
      const f = gi.filter((t) => /src probes —/.test(t)).at(-1) ?? "";
      const m = /shaded (\d+)/.exec(f);
      return m ? Number(m[1]) : null;
    };
    let stable = 0;
    let prev = null;
    for (let i = 0; i < 40 && stable < 3; i++) {
      await wait(2000);
      const now = shadedOf();
      stable = now != null && now === prev ? stable + 1 : 0;
      prev = now;
    }
    if (prev != null) console.log(`      · settled at ${prev} hits shaded after ${stable * 2}s stable`);
    else await wait(9000);

    const boot = gi.find((t) => /src probes:/.test(t)) ?? "";
    const px = Number(/src probes: (\d+) gbuffer pixels/.exec(boot)?.[1]) || null;
    const rpp = Number(/(\d+) rays\/px/.exec(boot)?.[1]) || null;
    const s0 = /s0=([\d.]+)/.exec(boot)?.[1] ?? "?";
    const built = gi.find((t) => /built \(voxel/.test(t)) ?? "";
    const tier = /auto-fit (\w+)/.exec(built)?.[1] ?? "?";
    // ── THE STARTUP LINES, ECHOED VERBATIM ──────────────────────────────────
    //
    // `probe:gi-boot` parses a known set of log lines into its report and drops
    // everything else, so an engine log line added after it was written is
    // invisible there — which is how a measurement built specifically to test
    // that probe's "98% is TSL node-graph build" attribution produced no output
    // twice. This probe keeps every `[gi]` line, so it is the cheaper place to
    // read one. Echo verbatim rather than parse: the point is to see a number
    // nobody has seen yet, and a parser can only find what it already expects.
    for (const l of gi.filter((t) => /node-graph build|compiled concurrently|compute kernels:|compile wave:/.test(t))) {
      console.log(`      · ${l.slice(0, 190)}`);
    }

    // ── THE COST ────────────────────────────────────────────────────────────
    // `samples` is deliberately small. At 249 ms a dispatch, the default 40
    // would freeze the page for well over a minute per group and measure
    // thermal throttling as well as the kernel.
    const p = await call("profile.giPasses", { samples: 6 });
    const src = p.value?.srcProbes;
    const groups = src?.groupMs ?? {};
    const deposit = groups["deposit (trace + shade)"]?.ms ?? null;
    const live = (src?.cascades ?? []).reduce((n, c) => n + c.live, 0) || null;
    const resolvePx = (p.value?.pixels?.resolve ?? []).join("x");
    if (!src) console.log(`      · profile.giPasses returned no srcProbes — ${p.error ?? "(no error)"}`);

    // ── THE PICTURE ─────────────────────────────────────────────────────────
    const shot = await call("viewport.screenshot", { width: 700, height: 460, includeGizmos: false });
    let mean = null; let lit = null;
    if (shot.ok && shot.value?.__image?.base64) {
      const png = Buffer.from(shot.value.__image.base64, "base64");
      await sharp(png).toFile(`${OUT}/src-cost-${QUALITY}-${arm.name.replace(/[^\w]+/g, "_")}.png`);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const n = data.length / info.channels;
      let sum = 0; let count = 0;
      for (let i = 0; i < n; i++) {
        const j = i * info.channels;
        const v = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
        sum += v; if (v > 12) count++;
      }
      mean = sum / n / 255;
      lit = count / n;
    } else console.log(`      · screenshot FAILED — ${shot.error ?? "no image"}`);

    // TRACED rays, not `px × raysPerPixel`. Since the ray ceiling landed those
    // are different numbers, and dividing a deposit time by the pre-ceiling
    // count would report a per-ray cost that fell by exactly the stride — an
    // instrument that makes the fix look like it improved the kernel rather
    // than reduced the work. The boot line publishes both; parse the real one
    // and fall back only for a build that predates it.
    const traced = Number(/(\d+) rays\/frame/.exec(boot)?.[1]) || null;
    const stride = Number(/stride (\d+) of/.exec(boot)?.[1]) || 1;
    const rays = traced ?? (px && rpp ? px * rpp : null);
    const row = {
      arm: arm.name, scale: arm.scale, px, rpp, rays, stride, s0, tier, live,
      deposit, total: src?.totalMs ?? null, resolvePx, mean, lit,
      nsPerRay: deposit && rays ? (deposit * 1e6) / rays : null,
    };
    if (!arm.warmup) results.push(row);
    console.log(
      `  ${(arm.warmup ? arm.name + " (discarded)" : arm.name).padEnd(20)}` +
      ` ${String(px ?? "?").padStart(9)} px  ${String(rays ?? "?").padStart(9)} rays  ` +
      `deposit ${String(deposit ?? "?").padStart(8)}ms  chain ${String(src?.totalMs ?? "?").padStart(8)}ms  ` +
      `| mean ${mean == null ? " n/a " : mean.toFixed(5)}  lit ${lit == null ? "n/a" : (lit * 100).toFixed(1) + "%"}` +
      (errors.length ? `  ERRORS ${errors.length}` : ""),
    );
    console.log(`      · tier ${tier}, s0=${s0}, ${rpp} rays/px, ${live} live probes, resolve ${resolvePx}`);
    for (const e of errors.slice(0, 3)) console.log(`      pageerror: ${e}`);
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 160);
    console.log(`  ${arm.name.padEnd(12)} ARM FAILED — ${msg}`);
    if (/detached Frame/.test(msg)) {
      console.log("      (a live reload landed mid-arm — R15 applies to the OTHER session's edits too)");
    }
    results.push({ arm: arm.name, failed: msg });
  }
  await page.close().catch(() => {});
}
await browser.close();

console.log("\n── VERDICT ─────────────────────────────────────────────────────");
const ok = results.filter((r) => r.deposit && r.rays);
if (ok.length < 2) {
  console.log("  Not enough arms produced a deposit time. VERDICT WITHHELD.");
  process.exit(1);
}
// Every arm must have measured the SAME scene at the SAME tier, or the sweep is
// two experiments. s₀ and the tier come from the boot line, not from what this
// script asked for, so a scene edited between arms is caught rather than
// averaged.
const tiers = [...new Set(ok.map((r) => `${r.tier}/${r.s0}/${r.rpp}`))];
if (tiers.length > 1) {
  console.log(`  ✗ ARMS ARE NOT COMPARABLE — tier/s₀/rays-per-pixel moved between them: ${tiers.join("  vs  ")}`);
  console.log("    Only `resolveScale` was supposed to change. VERDICT WITHHELD.");
  process.exit(1);
}
console.log(`  (all arms at tier ${ok[0].tier}, s₀=${ok[0].s0}, ${ok[0].rpp} rays/px — only resolveScale moved)`);
console.log("");
console.log("  arm              transport px   traced rays  stride  deposit ms   ns/ray   screen mean   lit");
for (const r of ok) {
  console.log(
    `  ${r.arm.padEnd(16)} ${String(r.px).padStart(11)} ${String(r.rays).padStart(13)} ` +
    `${String(r.stride).padStart(7)} ${r.deposit.toFixed(3).padStart(11)} ${r.nsPerRay.toFixed(1).padStart(8)} ` +
    `${r.mean == null ? "     n/a" : r.mean.toFixed(5).padStart(13)} ${r.lit == null ? " n/a" : (r.lit * 100).toFixed(1) + "%"}`,
  );
}
// ── THE CEILING SWEEP'S OWN VERDICT: WHAT DID THE LOOK COST? ────────────────
//
// Only meaningful here, where every arm rendered at the same resolution — which
// is the entire reason this sweep exists separately from the scale one.
if (SWEEP === "ceiling") {
  const ref = ok.find((r) => r.arm === "unlimited");
  const pxSet = [...new Set(ok.map((r) => r.px))];
  console.log("");
  if (!ref) {
    console.log("  No `unlimited` reference arm — nothing to judge the ceilings against.");
  } else if (pxSet.length > 1) {
    console.log(`  ✗ arms rendered at different transport pixel counts (${pxSet.join(", ")}) —`);
    console.log("    the resolve moved under the sweep, so the look column is not a ceiling effect.");
  } else {
    console.log(`  vs the unlimited arm (${ref.rays} rays, ${ref.deposit}ms, mean ${ref.mean?.toFixed(5)}):`);
    for (const r of ok) {
      if (r === ref) continue;
      const dLook = ref.mean ? ((r.mean - ref.mean) / ref.mean) * 100 : NaN;
      const speed = r.deposit ? ref.deposit / r.deposit : NaN;
      console.log(
        `    ${r.arm.padEnd(16)} ${speed.toFixed(2)}× faster deposit  for  ` +
        `${dLook >= 0 ? "+" : ""}${dLook.toFixed(1)}% screen mean`,
      );
    }
    console.log("  A ceiling is affordable when the deposit ratio is large and the look moves a few %.");
  }
}
console.log("");
// ── FIT A FLOOR AND A SLOPE, DO NOT THRESHOLD A RATIO ───────────────────────
//
// The first version of this block divided max(ns/ray) by min(ns/ray) and called
// a spread above 1.35 "not a per-ray cost". That is the wrong model. The deposit
// is `floor + slope·rays`: a fixed per-frame part (the clear, the stats, the
// dispatch itself) plus the rays. When the floor is comparable to the ray term —
// which it is at tier low, where the whole thing is 1.6 ms — ns/ray *must*
// climb as rays fall, on a perfectly linear cost. The ratio measured the floor
// and reported it as a refutation.
//
// Least squares on (rays, ms) gives both terms, and the SLOPE is what prices the
// fix: cutting rays can never buy back the floor.
const n = ok.length;
const sx = ok.reduce((a, r) => a + r.rays, 0);
const sy = ok.reduce((a, r) => a + r.deposit, 0);
const sxx = ok.reduce((a, r) => a + r.rays * r.rays, 0);
const sxy = ok.reduce((a, r) => a + r.rays * r.deposit, 0);
const denom = n * sxx - sx * sx;
const slope = denom ? (n * sxy - sx * sy) / denom : 0;   // ms per ray
const floor = denom ? (sy - slope * sx) / n : sy / n;    // ms, ray-independent
const big = ok[0];
console.log(`  least-squares fit:  deposit ms ≈ ${floor.toFixed(3)} + ${(slope * 1e6).toFixed(1)} ns × rays`);
const rayPart = slope * big.rays;
const share = rayPart / (rayPart + floor);
console.log(`  at the top arm (${big.rays} rays): ${rayPart.toFixed(1)}ms of rays + ${floor.toFixed(1)}ms floor` +
  `  → rays are ${(share * 100).toFixed(0)}% of the deposit`);
if (share > 0.8) {
  console.log("  ⇒ RAY COUNT IS THE LEVER. Cutting the transport's ray budget by K cuts the");
  console.log(`     deposit by very nearly K, down to the ${floor.toFixed(1)}ms floor.`);
} else if (share > 0.4) {
  console.log("  ⇒ MIXED. Rays are worth cutting but the floor caps the win — price it off");
  console.log(`     the slope (${(slope * 1e6).toFixed(1)} ns/ray), never off the pixel ratio.`);
} else {
  console.log("  ⇒ THE FLOOR DOMINATES at this tier. Cutting rays buys almost nothing here;");
  console.log("     find the fixed per-frame work instead. (Re-check at the tier that is slow.)");
}
console.log(`  shots in ${OUT}/src-cost-*.png`);
