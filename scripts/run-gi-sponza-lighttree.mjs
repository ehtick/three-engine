// §12.70 — THE SPONZA-SCALE LEDGER FOR THE LIGHT TREE HATCHES.
//
// Everything the tree has been measured on so far is the emissive storm: a
// generated box, a dozen spheres, one material. The last gate before the
// defaults flip is the same A/B on the user's REAL scene, at its own
// resolution and quality preset, because the two things the storm cannot
// price are the ones that decide this:
//
//   · the emitter chain's cost scales with the EMITTER-SHADOW RESOLUTION,
//     which tracks the viewport — the storm runs a fraction of the pixels;
//   · the per-pixel cut's O(N) scan and the record-based march run against a
//     real tree over real geometry, not twelve spheres in a box.
//
// Read-only: the tauri shim opens the project without a write path, nothing
// here calls scene.save, and no entity is created. What it changes is two dev
// globals, per arm, before the page loads.
//
//   node scripts/run-gi-sponza-lighttree.mjs        (vite on :5201)
//   PROJECT=... SETTLE=30000 ROUNDS=2               (dials)
//
// ⚠ Absolute ms on this machine are not portable: the editor's WebGPU adapter
// and the laptop's power profile both move them (see the dual-GPU note in the
// project memory). The A/B is within one process, arms interleaved, which is
// what makes the DIFFERENCE readable even when the level is not.
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME";
const SETTLE = Number(process.env.SETTLE ?? 30000);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
// INJECT=N lamps, STRENGTH=emissiveIntensity. See the inject block below for
// why this exists at all (the scene has no emitters of its own).
const INJECT = Number(process.env.INJECT ?? 12);
const STRENGTH = Number(process.env.STRENGTH ?? 100);
const OUT = ".gi-shots/sponza-lighttree";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // A Sponza rebuild plus its settle outruns CDP's 3-minute default, and the
  // timeout surfaces as a ProtocolError that looks like a page crash.
  protocolTimeout: 600000,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(treeOn, round) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  const lines = { bright: "", tree: "", cut: "", nee: "" };
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/bright emitters/i.test(t)) lines.bright = t;
    if (/\[gi\] light tree: /.test(t)) lines.tree = t;
    if (/\[gi\] emitter tile cut/.test(t)) lines.cut = t;
    if (/\[gi\] src \[J\] NEE/.test(t)) lines.nee = t;
  });
  let errs = 0;
  page.on("pageerror", (e) => {
    const msg = String(e.message ?? e);
    // Capped: a per-frame throw prints thousands of identical lines and buries
    // the run (see the material-clone note in the inject block).
    if (!/save_scene/.test(msg) && errs++ < 5) console.log(`  pageerror: ${msg.slice(0, 180)}`);
  });
  await page.evaluateOnNewDocument((project, on) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // The two hatches flip TOGETHER — §12.70 W5b. The cut alone leaves the
    // un-seated emitters delivering screen direct AND field emission. Set
    // EXPLICITLY on both arms: they default ON, so the slots arm has to say
    // `false` or it is a second tree arm.
    globalThis.__giSrcLightTree = on === true;
    globalThis.__giEmitterTileCut = on === true;
  }, PROJECT, treeOn);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  for (let i = 0; i < 300 && !built; i++) await wait(1000);
  if (!built) throw new Error("never built");
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  // A KNOWN POSE (§12.66): every number below is pose-dependent, and the
  // scene's saved camera is whatever the user last left it at.
  await page.evaluate(async () => {
    await globalThis.__editorApi.call("viewport.setCamera", {
      position: [6.2, 2.09, -0.37], target: [-6, 2, 0],
    });
  });
  // ── INJECTED LAMPS ────────────────────────────────────────────────────────
  // The user's Sponza carries ZERO emissive meshes (probed 2026-08-15: 130
  // meshes, 0 emissive, 0 lights on GI shadow source — the emitter chain is
  // "NOT dispatched, 0 emitters" end to end). There is nothing there for the
  // tree to hold, so the scene as saved cannot price it at all.
  //
  // So the ledger MAKES emitters, in memory only: N existing meshes spread
  // through the scene get a CLONED material (Sponza shares one material across
  // many meshes — editing in place would light half the atrium) with a
  // strength-`STRENGTH` white emissive. Nothing is written: the tauri shim has
  // no write path, scene.save is never called, and the clone dies with the
  // page. What this measures is the real medium — 792k occupied voxels, 262k
  // triangles, the scene's own resolution — carrying a real emitter set.
  let injected = null;
  if (INJECT > 0) {
    injected = await page.evaluate(async (n, strength) => {
      const api = globalThis.__editorApi;
      const list = await api.call("entity.list", {});
      const rows = list.value ?? list;
      const engine = api.entities.live(rows?.[0]?.id)?.engine;
      if (!engine) return { fail: "no engine" };
      // FROM GI'S OWN ENTRY LIST, not from a scene traverse. The traverse
      // reaches UI meshes, and `Material.clone()` deep-copies `userData`
      // THROUGH JSON — which turns a UiImage's uniform NODES into plain
      // objects and throws `u.size.value.set is not a function` once per
      // frame forever (found the hard way; it wedged the page hard enough to
      // time out CDP). GI's entries are exactly the meshes that voxelize.
      const gi0 = engine.modules?.get?.("gi")?.system;
      const meshes = [];
      for (const entry of gi0?.state?.entries ?? []) {
        const mesh = entry?.mesh;
        if (mesh?.isMesh && mesh.visible !== false && !mesh.isInstancedMesh) meshes.push(mesh);
      }
      meshes.sort((a, b) => a.id - b.id);
      if (!meshes.length) return { fail: "no GI entry meshes" };
      const step = Math.max(1, Math.floor(meshes.length / n));
      const chosen = [];
      for (let i = 0; i < meshes.length && chosen.length < n; i += step) chosen.push(meshes[i]);
      // SELF-HEALING, because the editor owns these materials. A one-shot
      // clone survived exactly one GI rebuild: the first one saw 15 bright
      // emitters and built a 15-emitter tree, and by the time the ledger
      // measured, `_emitterCands` was back to 0 and the tree region null —
      // the editor had re-applied the material from its asset underneath.
      // A watcher re-applies to any chosen mesh that has lost the mark, and
      // clones only when it must (re-cloning every tick would churn material
      // compiles and measure the churn instead of the tree).
      const apply = () => {
        let repaired = 0;
        for (const mesh of chosen) {
          const current = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (current?.userData?.__ledgerLamp) continue;
          if (!current?.clone) continue;
          const clone = current.clone();
          clone.userData = { ...(clone.userData ?? {}), __ledgerLamp: true };
          clone.emissive?.setRGB(1, 1, 1);
          clone.emissiveIntensity = strength;
          if (Array.isArray(mesh.material)) mesh.material[0] = clone;
          else mesh.material = clone;
          repaired++;
        }
        return repaired;
      };
      const first = apply();
      globalThis.__ledgerLampRepairs = 0;
      clearInterval(globalThis.__ledgerLampTimer);
      globalThis.__ledgerLampTimer = setInterval(() => {
        const n = apply();
        if (n > 0) {
          globalThis.__ledgerLampRepairs += n;
          engine.modules?.get?.("gi")?.system?.requestRebuild?.();
        }
      }, 1000);
      // The sanctioned way to make GI re-read the scene: the same request a
      // quality change or a bounds edit makes.
      const gi = engine.modules?.get?.("gi")?.system;
      gi?.requestRebuild?.();
      return { names: chosen.slice(0, first).map((m) => m.name || `#${m.id}`), applied: first, of: meshes.length };
    }, INJECT, STRENGTH);
    if (injected.fail) throw new Error(`inject: ${injected.fail}`);
    console.log(`   injected ${injected.names.length} lamps (of ${injected.of} meshes) @ strength ${STRENGTH}: ${injected.names.slice(0, 6).join(", ")}…`);
    // WAIT FOR THE REBUILD TO LAND, don't guess at it. A Sponza rebuild is
    // seconds and `requestRebuild` can fire more than once (a material change
    // also moves the fingerprint), so a fixed sleep measured a system that was
    // mid-rebuild — `_lightTreeRegion` is nulled at the top of the tree block
    // and only reassigned on success, which is exactly the "tree emitters -1
    // even though the build line printed" reading the first run produced.
    // Poll the SYSTEM, not the globals.
    const settled = await page.evaluate(async (limitMs) => {
      const api = globalThis.__editorApi;
      const list = await api.call("entity.list", {});
      const rows = list.value ?? list;
      const engine = api.entities.live(rows?.[0]?.id)?.engine;
      const gi = engine?.modules?.get?.("gi")?.system;
      const t0 = performance.now();
      let stableFor = 0, lastKey = "";
      while (performance.now() - t0 < limitMs) {
        await new Promise((r) => setTimeout(r, 1000));
        const key = `${!!gi?._lightTreeRegion}:${gi?._lightTreeRegion?.emitterCount ?? -1}:${gi?._emitterCands?.length ?? -1}`;
        stableFor = key === lastKey ? stableFor + 1 : 0;
        lastKey = key;
        if (gi?._lightTreeRegion && stableFor >= 6) break;
      }
      return {
        waitedMs: Math.round(performance.now() - t0),
        cands: gi?._emitterCands?.length ?? -1,
        treeEmitters: gi?._lightTreeRegion?.emitterCount ?? -1,
        capacity: gi?._lightTreeRegion?.capacityWords ?? -1,
        repairs: globalThis.__ledgerLampRepairs ?? 0,
      };
    }, 150000);
    console.log(`   rebuild settled after ${(settled.waitedMs / 1000).toFixed(0)}s — candidates ${settled.cands}, tree ${settled.treeEmitters} emitters (cap ${settled.capacity} words), lamp repairs ${settled.repairs}`);
  }
  await wait(SETTLE);

  const prof = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 60 });
    return r?.value ?? r;
  });
  // WHOLE-FRAME cost, not just the GI chain. The GI chain can read 0.03 ms on
  // a scene with no emitters while the frame is 40 ms — a ledger that only
  // prints its own subsystem cannot answer "did this make the editor slower".
  // ⚠ the param is `settleMs`, not `samples` — the op registry refuses unknown
  // keys, and the refusal came back as an empty object rather than a throw.
  const frame = await page.evaluate(async () => {
    try {
      const r = await globalThis.__editorApi.call("profile.frameStats", { settleMs: 1500 });
      return r?.value ?? r;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  });
  const shot = await page.evaluate(async () => {
    const api = globalThis.__editorApi;
    const ids = await api.call("entity.list", {});
    const anyId = (ids.value ?? ids)?.[0]?.id;
    const engine = api.entities.live(anyId)?.engine;
    // A BLACK FRAME IS NOT A MEASUREMENT. One arm read meanLum 0.000 while its
    // ms were entirely normal — a frame captured mid-rebuild. Skip the first
    // frames and reject an all-black crop up to a few times before believing
    // it (§12.66's black-boot class: black is a state the frame passes
    // through, and averaging it in is how a rebuild becomes an "energy loss").
    const grab = () => new Promise((resolve) => {
      let n = 0;
      const off = engine.onPostRender(() => {
        if (++n < 4) return;
        off();
        const src = engine.renderer.domElement;
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        c.getContext("2d").drawImage(src, 0, 0);
        const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
        const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
        const d = c.getContext("2d").getImageData(x0, y0, w, h).data;
        let lum = 0;
        for (let i = 0; i < d.length; i += 4) lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        resolve({
          meanLum: +(lum / (d.length / 4) / 255).toFixed(4),
          canvas: `${c.width}×${c.height}`,
          // The editor's viewport panel does not always come back the same
          // size across boots (392 vs 620 rows observed in one run), and every
          // GI pass here is per-pixel — so the ledger reports ms/Mpix beside
          // raw ms and says when the arms are not the same size.
          mpix: +((c.width * c.height) / 1e6).toFixed(4),
          palette: globalThis.__giSurfacePaletteLive
            ? {
                emitters: globalThis.__giSurfacePaletteLive.emitters,
                orphans: globalThis.__giSurfacePaletteLive.emissiveOrphans,
              }
            : null,
          treeEmitters: globalThis.__giLightTreeLive?.emitterCount ?? -1,
          tileSize: globalThis.__giTileCutLive?.tileSize ?? null,
        });
      });
    });
    let out = await grab();
    for (let attempt = 0; attempt < 4 && out.meanLum <= 0.001; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      out = await grab();
      out.retries = attempt + 1;
    }
    return out;
  });
  await page.screenshot({ path: `${OUT}/sponza-${treeOn ? "tree" : "slots"}-${round}.png` });
  await page.close();

  const passes = { ...(prof?.screenPassesMs ?? {}), ...(prof?.queueMs ?? {}) };
  const num = (v) => (typeof v === "number" ? v : v?.ms ?? v?.avg ?? null);
  const pick = (re) => {
    for (const [k, v] of Object.entries(passes)) if (re.test(k)) return num(v);
    return null;
  };
  return {
    treeOn, round,
    fps: frame?.fps ?? null,
    frameMs: frame?.cpuMs ?? null,
    gpuMs: frame?.gpuMs ?? null,
    drawCalls: frame?.drawCalls ?? null,
    triangles: frame?.triangles ?? null,
    frameRaw: frame,
    total: prof?.screenTotalMs ?? null,
    emitterShadow: pick(/emitterShadowPass/i),
    emitterChain: Object.entries(passes)
      .filter(([k]) => /emitter/i.test(k))
      .reduce((a, [, v]) => a + (num(v) ?? 0), 0),
    resolve: pick(/^resolve$|giResolve/i),
    deposit: pick(/deposit/i),
    ...shot,
    lines,
    table: Object.entries(passes)
      .map(([k, v]) => [k, num(v)])
      .filter(([, v]) => typeof v === "number" && v >= 0.02)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(" · "),
  };
}

console.log(`§12.70 SPONZA LEDGER — ${PROJECT}`);
const rows = [];
for (let round = 0; round < ROUNDS; round++) {
  // ABBA within the pair so boot-order drift lands on both arms equally
  // (§12.62's slot-round-spread lesson: adjacent arms track, distant ones do
  // not).
  const order = round % 2 === 0 ? [false, true] : [true, false];
  for (const treeOn of order) {
    console.log(`── round ${round} arm ${treeOn ? "TREE+CUT" : "slots"}`);
    const r = await runArm(treeOn, round);
    rows.push(r);
    console.log(`   canvas ${r.canvas} · FRAME fps ${r.fps} gpu ${r.gpuMs} cpu ${r.frameMs} · GI total ${r.total} ms · emitter chain ${r.emitterChain.toFixed(2)} ms ` +
      `(shadow ${r.emitterShadow}) · resolve ${r.resolve} · meanLum ${r.meanLum}`);
    console.log(`   frame: draws ${r.drawCalls} tris ${r.triangles} renderScale ${r.frameRaw?.renderScale} — ${r.frameRaw?.note ?? r.frameRaw?.error ?? ""}`);
    console.log(`   passes: ${r.table}`);
    if (r.lines.bright) console.log(`   ${r.lines.bright.slice(0, 150)}`);
    if (r.lines.tree) console.log(`   ${r.lines.tree.slice(0, 170)}`);
    if (r.lines.cut) console.log(`   ${r.lines.cut.slice(0, 170)}`);
    if (r.lines.nee) console.log(`   ${r.lines.nee.slice(0, 150)}`);
    console.log(`   tree emitters ${r.treeEmitters} · tileSize ${r.tileSize ?? "n/a"} · palette ${JSON.stringify(r.palette)}`);
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const of = (on, key) => mean(rows.filter((r) => r.treeOn === on).map((r) => r[key]).filter((v) => typeof v === "number"));
console.log("\n== LEDGER (means over rounds) ==");
const mpixA = of(false, "mpix"), mpixB = of(true, "mpix");
const sameSize = Math.abs(mpixA - mpixB) < 1e-3;
for (const key of ["total", "emitterChain", "emitterShadow", "resolve", "deposit", "meanLum"]) {
  const a = of(false, key), b = of(true, key);
  const d = b - a;
  const perPix = key === "meanLum" || !Number.isFinite(a) || !Number.isFinite(b)
    ? ""
    : `   [per Mpix: ${(a / mpixA).toFixed(3)} → ${(b / mpixB).toFixed(3)}, Δ ${((b / mpixB) - (a / mpixA)) >= 0 ? "+" : ""}${((b / mpixB) - (a / mpixA)).toFixed(3)}]`;
  console.log(`  ${key.padEnd(14)} slots ${a.toFixed(3).padEnd(9)} tree+cut ${b.toFixed(3).padEnd(9)} Δ ${d >= 0 ? "+" : ""}${d.toFixed(3)}${perPix}`);
}
console.log(`  canvas: slots ${mpixA.toFixed(3)} Mpix · tree+cut ${mpixB.toFixed(3)} Mpix — ${sameSize ? "same size, raw ms comparable" : "⚠ DIFFERENT SIZE: compare the per-Mpix column, and meanLum is NOT comparable"}`);
const armed = rows.filter((r) => r.treeOn).every((r) => r.lines.cut && r.lines.nee);
console.log(`  both arms armed (cut boot line + [J] NEE line on every tree round): ${armed ? "yes" : "NO — the tree round did not arm"}`);
const orphans = rows.map((r) => r.palette?.orphans ?? 0);
console.log(`  R5 orphans across all rounds: ${orphans.join(",")} (want all 0)`);
console.log(`  shots: ${OUT}/sponza-*.png`);
writeFileSync(`${OUT}/ledger.json`, JSON.stringify(rows, null, 2));
await browser.close();
process.exit(armed ? 0 : 1);
