// SRC HIT SHADING — THE EYE CHECK, ON PIXELS.
//
// Every SRC gate so far measures a kernel against a CPU mirror, and both units
// passed while the seam between them was wrong (§12.28). This one measures the
// only thing the user can see: the mean luminance of the rendered viewport,
// across arms that differ by one flag.
//
// ── WHY THIS EXISTS AS A SEPARATE INSTRUMENT ────────────────────────────────
//
// The predecessor of this file printed `NO SCREENSHOT` on every run — its
// capture block was a stub returning null — while I read its `maxL` line and
// called it an eye check. `maxL` is the brightest radiance ANY HIT produced.
// It is computed in the deposit kernel, five stages upstream of a pixel. A
// nonzero `maxL` and a black screen are perfectly consistent, and for two
// sessions that gap is exactly where the bug lived.
//
// So: `viewport.screenshot`, `includeGizmos: false` (GI is scene content, not
// an editor overlay — the opposite of run-gi-debug-views-probe's requirement,
// and the reason that probe's comment says the setting cost it a round).
//
// ── ARMS ────────────────────────────────────────────────────────────────────
//
//   probes-only  ONE flag, the way a person reaches for SRC. Must match
//                shade-on: §12.30.1's footgun was that it used to match
//                shade-off, i.e. render black.
//   shade-off    SRC probes with shading explicitly off — sky-only radiance.
//                Structurally a black scene, and kept as an arm precisely so
//                that stays measured rather than rediscovered.
//   shade-on     Phase 5's coloured bounce.
//   noshadow     visibility dropped entirely — the ceiling, so "dark" and
//                "occluded" stop looking alike.
//
// A pass is: probes-only ≈ shade-on, both ~5× shade-off, and noshadow above
// both. The one number that matters most is `lit` — shade-off sits at 4%.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const URL_BASE = process.env.URL ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const OUT = process.env.OUT ?? "C:/Users/KHUDII~1/AppData/Local/Temp/claude/c--Users-Khudiiash-Documents-JS-engine/9c1503b1-2b83-4449-b77a-707e5760c11e/scratchpad";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The verified nave pose from run-gi-intensity-probe. OrbitControls owns the
// camera, so this goes through `viewport.setCamera` and not a transform write.
const POSE = { position: [11.8, 2.2, 0.73], target: [-3.2, 1.0, -1.47] };

const ARMS = [
  // ── A DISCARDED WARM-UP BOOT, AND IT IS NOT OPTIONAL ────────────────────
  //
  // The first page in a fresh browser does not merely converge slower — it
  // BUILDS A DIFFERENT SYSTEM. Its mechanism readout says `78988 gbuffer
  // pixels, c0 32768/65536` where a later arm says `58653, c0 16384/32768`, so
  // no amount of waiting makes arm 1 comparable and the convergence poll below
  // cannot rescue it. Measured: `shade-on` reads 0.11213/157,976 in position 1
  // and 0.14721/249,860 in position 3 — the same flags, the same scene.
  //
  // Two wrong conclusions came out of that gap (§12.30.4), both because the arm
  // that happened to run first was also the one under suspicion. One throwaway
  // boot removes the whole class.
  { name: "warmup", shade: true, warmup: true },
  // THE FOOTGUN ARM. Sets ONE flag — `__giSrcProbes` — and nothing else, which
  // is what a person reaching for SRC actually types. Before §12.30.1 this
  // rendered at 4% lit (a black scene) because probes REPLACE the legacy diffuse
  // term and, without shading, carry sky only. It must now match `bias-0.25`.
  { name: "probes-only", probesOnly: true },
  { name: "shade-off", shade: false },
  { name: "shade-on", shade: true },
  { name: "noshadow", shade: true, noShadow: true },
  // ── THE USER'S ARM ──────────────────────────────────────────────────────
  //
  // Every arm above sets the globals in `evaluateOnNewDocument`, i.e. before a
  // single module is imported. A person cannot do that: they open the editor,
  // type the flags into the console, and toggle the GI component to rebuild.
  // That is a DIFFERENT code path and this arm is the only one that walks it.
  //
  // It exists because the four arms above all render (mean ~0.148) while the
  // user's editor is black on the same project, the same scene and the same
  // working tree — so the difference is not in the shading at all, and no
  // amount of measuring the shading was ever going to find it.
  { name: "runtime", shade: true, atRuntime: true },
];
const only = process.env.ARM;
const arms = only ? ARMS.filter((a) => a.name === only) : ARMS;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});

const results = [];
for (const arm of arms) {
  // A FRESH PAGE PER ARM IS REQUIRED, not tidiness: `SHADOW_SELF_BIAS_CELLS`
  // is a module-level const read at import, so flipping the global on a live
  // page changes nothing and every arm would silently measure the first one.
  //
  // ⚠ AND THE ARM MUST SURVIVE A RELOAD IT DID NOT CAUSE. The first run of
  // this file died with "Attempted to use detached Frame" 240s into arm 1:
  // the dev server is live, a second session edits `src/modules/gi`, Vite
  // pushes a full reload, and every `page.evaluate` after it throws from
  // puppeteer — OUTSIDE the try/catch inside the evaluate, so the usual
  // guard does nothing. Each arm is therefore its own try/catch and a failed
  // arm is REPORTED AS FAILED rather than taking the other three with it.
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
  await page.evaluateOnNewDocument((project, a) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__giLogSrcProbes = true;
    // The `runtime` arm deliberately boots with the flags OFF.
    if (a.probesOnly) {
      globalThis.__giSrcProbes = true;
    } else if (!a.atRuntime) {
      globalThis.__giSrcProbes = true;
      globalThis.__giSrcShade = a.shade;
      if (a.noShadow) globalThis.__giSrcNoShadow = true;
    }
  }, PROJECT, arm);
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
    for (let i = 0; i < 180 && !waveDone; i++) await wait(1000);
    if (!waveDone) console.log(`  ${arm.name}: compile wave never logged — measuring anyway`);
    if (arm.atRuntime) {
      // Exactly what a person does: type the flags, then toggle the component
      // so GI rebuilds. `enabled` is not one of the component's declared props
      // (GI has ONE property, `quality`), so the rebuild is driven by touching
      // `quality` — the same rebuild the Inspector triggers.
      await page.evaluate(() => {
        globalThis.__giSrcProbes = true;
        globalThis.__giSrcShade = true;
      });
      const ents = await call("entity.list", {});
      const owner = (ents.value ?? []).find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
      if (!owner) {
        console.log("  runtime: NO global-illumination component in the scene — that alone would explain a black frame");
      } else {
        const comp = owner.components.find((c) => c.type === "global-illumination");
        const q = comp.props?.quality;
        console.log(`  runtime: toggling quality on "${owner.name ?? owner.id}" (currently ${JSON.stringify(q)})`);
        const other = q === "high" ? "medium" : "high";
        const a1 = await call("component.setProp", { id: owner.id, type: "global-illumination", key: "quality", value: other });
        if (!a1.ok) console.log(`  runtime: setProp failed — ${a1.error}`);
        await wait(20000);
        const a2 = await call("component.setProp", { id: owner.id, type: "global-illumination", key: "quality", value: q });
        if (!a2.ok) console.log(`  runtime: setProp back failed — ${a2.error}`);
        await wait(30000);
      }
    }
    await call("viewport.setCamera", POSE);
    // ── WAIT FOR CONVERGENCE, NOT FOR A TIMER ───────────────────────────────
    //
    // This was `await wait(15000)` and it produced TWO WRONG CONCLUSIONS. On a
    // cold process the first arm has not settled at 15s: it reports ~157,976
    // hits shaded and a visibly dark frame, where the SAME configuration in
    // position ≥2 reports 249,860 and the correct one. Both times, the arm that
    // happened to run first was also the one whose configuration was in
    // question — a perfect confound, and it read as "one flag still renders
    // black" and then as "a component toggle is not equivalent to a reload".
    // Neither was true.
    //
    // The frame line already publishes the hit count, so settle on the SIGNAL:
    // capture once it stops moving. Cheap for a warm arm (~2 polls), and the
    // cold one now takes the time it actually needs instead of the time arm 2
    // needed.
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
      // Unchanged AND nonzero. A `shade-off` arm never shades anything, so its
      // null/zero would otherwise read as "converged" on the first poll — which
      // is harmless there but would hide a genuinely stalled shaded arm.
      stable = now != null && now === prev ? stable + 1 : 0;
      prev = now;
    }
    if (prev != null) console.log(`      · settled at ${prev} hits shaded after ${stable * 2}s stable`);
    else await wait(9000); // shade-off has no hit count to settle on.

    const shot = await call("viewport.screenshot", { width: 700, height: 460, includeGizmos: false });
    let mean = null; let lit = null; let p99 = null;
    if (shot.ok && shot.value?.__image?.base64) {
      const png = Buffer.from(shot.value.__image.base64, "base64");
      await sharp(png).toFile(`${OUT}/src-eyecheck-${arm.name}.png`);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const n = data.length / info.channels;
      const L = new Float64Array(n);
      let sum = 0; let count = 0;
      for (let i = 0; i < n; i++) {
        const j = i * info.channels;
        const v = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
        L[i] = v; sum += v; if (v > 12) count++;
      }
      mean = sum / n / 255;
      lit = count / n;
      L.sort();
      p99 = L[Math.floor(n * 0.99)] / 255;
    } else {
      console.log(`  ${arm.name}: screenshot FAILED — ${shot.error ?? "no image"}`);
    }
    // MECHANISM READOUT BEFORE THE PIXELS. `probes-only` and `shade-on` should
    // build the SAME system and did not obviously do so (157,976 vs 249,860
    // hits shaded), which is unanswerable from a mean. `describeSrcProbeSystem`
    // prints the ray budget, the cascade capacities and whether shading is on;
    // an arm that silently built a different system now says so.
    for (const l of gi.filter((t) => /src probes:|built \(voxel/.test(t))) {
      console.log(`      · ${l.slice(0, 200)}`);
    }
    const frames = gi.filter((t) => /src probes —/.test(t));
    const last = frames.at(-1) ?? "";
    const maxL = /maxL ([\d.]+)/.exec(last)?.[1] ?? "n/a";
    const shaded = /shaded (\d+)/.exec(last)?.[1] ?? "0";
    const unatt = /([\d.]+)% UNATTRIBUTED/.exec(last)?.[1] ?? "0.0";
    // A warm-up arm is measured and PRINTED — silently dropping it would hide
    // the very effect it exists for — but never enters the verdict.
    if (!arm.warmup) results.push({ arm: arm.name, mean, lit, p99, maxL, shaded, unatt, errors: errors.slice(0, 3) });
    console.log(
      `  ${(arm.warmup ? arm.name + " (discarded)" : arm.name).padEnd(20)} screen mean ${mean == null ? "  n/a " : mean.toFixed(5)}  ` +
      `lit ${lit == null ? " n/a " : (lit * 100).toFixed(1) + "%"}  p99 ${p99 == null ? "n/a" : p99.toFixed(4)}  ` +
      `|  maxL ${maxL}  shaded ${shaded}  unatt ${unatt}%` +
      (errors.length ? `  ERRORS ${errors.length}` : ""),
    );
    for (const e of errors.slice(0, 3)) console.log(`      pageerror: ${e}`);
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 160);
    console.log(`  ${arm.name.padEnd(10)} ARM FAILED — ${msg}`);
    if (/detached Frame/.test(msg)) {
      console.log("      (a live reload landed mid-arm; if a second session is editing src/modules/gi, R15 applies to it too)");
    }
    results.push({ arm: arm.name, failed: msg });
  }
  await page.close().catch(() => {});
}
await browser.close();

console.log("\n── VERDICT ─────────────────────────────────────────────────────");
const by = Object.fromEntries(results.map((r) => [r.arm, r]));
const rel = (a, b) => (by[a]?.mean && by[b]?.mean ? (by[a].mean / by[b].mean).toFixed(3) + "×" : "n/a (arm missing)");
console.log(`  shading gain   (shade-on vs sky-only):     ${rel("shade-on", "shade-off")}`);
console.log(`  shadow cost    (shade-on vs no shadow):    ${rel("shade-on", "noshadow")}`);
console.log(`  THE FOOTGUN    (probes-only vs shade-on):  ${rel("probes-only", "shade-on")}   ← must be ~1.000×; ~0.20× means one flag still renders black`);
console.log(`  the toggle path (runtime vs shade-on):     ${rel("runtime", "shade-on")}   ← ~1.000× means a component rebuild equals a reload`);
if (by["probes-only"]?.lit != null && by["probes-only"].lit < 0.2) {
  console.log("  ✗ FAIL: `__giSrcProbes` alone is back to a black scene (see plan §12.30.1)");
}
console.log(`  shots in ${OUT}/src-eyecheck-*.png`);
