// ONE-OFF (2026-08-14): user report on the post-§12.64 Sponza — "there are
// some weird places where light never appears, though visually it should
// reach it" (the upper-arcade interiors read near-black while surrounded by
// bright bounce). This interrogates WHY a specific dark pixel is dark:
//   pixel → gbuffer world pos → pixelProbe index → probe row (flags/block/
//   parent) → its c0 accumulator + merged payload bins (known/unknown, mean
//   L, mean T) → the parent ladder — against a BRIGHT control pixel.
// All buffer reads are whole-buffer getArrayBufferAsync + slice (the honest
// path, gi-harness-viewport-traps trap 0). Dark pixels are found by VALUE in
// the resolve (largest near-black cluster with valid gbuffer), so the camera
// pose only needs to roughly frame the arcade. Delete with the fix.
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const OUT = ".gi-shots/darkpocket";
await mkdir(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 500)}`);
  if (m.type().startsWith("warn") && /\[gi\]/.test(t)) console.log(`  console.warn: ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);

console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
// Frame the upper arcade like the user's screenshot: low in the corridor,
// looking toward the lion wall with pitch up enough to see the second floor.
await page.evaluate(() => globalThis.__editorApi.call("viewport.setCamera", {
  position: [7.5, 1.6, -0.3], target: [-8, 4.0, 0],
}));
console.log("settling…");
await wait(30000);

const report = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const engine = api.entities.live("KT0sShKBX-")?.engine;
  const system = engine?.modules?.get("gi")?.system;
  const renderer = engine?.renderer;
  const src = system?.state?.screen?.srcProbes;
  if (!src) return { error: "no srcProbes" };
  const { width, height } = system._giTargetSize;
  const targets = system._giTargets;
  const gb = system.state.screen?.gbuffer;
  if (!gb?.position) return { error: "no gbuffer", screenKeys: Object.keys(system.state.screen ?? {}) };
  // Introspection FIRST — every later read is guessed layout, and a wrong
  // guess must still return these.
  const describe = (o) => o && typeof o === "object"
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
        v?.isNode || v?.value ? "node" : Array.isArray(v) ? `array(${v.length})` : typeof v === "object" && v ? "obj" : typeof v === "number" ? v : typeof v]))
    : String(o);
  const shapes = {
    store: describe(src.store),
    storeCascade0: describe(src.store?.cascades?.[0]),
    binStore: describe(src.binStore),
    binCascade0: describe(src.binStore?.cascades?.[0]),
  };

  // ── resolve + gbuffer position, read via an in-page kernel over RAW
  // texture objects (the allowed wrap) into fresh page-built buffers.
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uniform, vec3, vec4 } = TSL;
  const irrBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const rawBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const gatBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const posBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  const irrNode = texture(targets.irradiance);
  const rawNode = targets.irradianceRaw ? texture(targets.irradianceRaw) : null;
  // The gather's own output texture — introspected: srcScreenGather writes a
  // texture the resolve samples as `screenGather`.
  const gatherTex = src.gather?.target ?? src.gather?.texture ?? src.gather?.node?.value ?? null;
  const gatNode = gatherTex?.isTexture ? texture(gatherTex) : null;
  const posNode = texture(gb.position);
  const widthU = uniform(width, "uint");
  const copy = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const c = ivec2(px.toInt(), py.toInt());
    irrBuf.element(instanceIndex).assign(vec4(irrNode.load(c)));
    if (rawNode) rawBuf.element(instanceIndex).assign(vec4(rawNode.load(c)));
    if (gatNode) gatBuf.element(instanceIndex).assign(vec4(gatNode.load(c)));
    posBuf.element(instanceIndex).assign(vec4(posNode.load(c)));
  })().compute(width * height);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  await frame(); renderer.compute(copy); await frame();
  const irr = new Float32Array(await renderer.getArrayBufferAsync(irrBuf.value));
  const raw = rawNode ? new Float32Array(await renderer.getArrayBufferAsync(rawBuf.value)) : null;
  const gat = gatNode ? new Float32Array(await renderer.getArrayBufferAsync(gatBuf.value)) : null;
  const gpos = new Float32Array(await renderer.getArrayBufferAsync(posBuf.value));

  // ── find the darkest valid cluster in the central band + a bright control.
  const lum = (i) => 0.2126 * irr[i * 4] + 0.7152 * irr[i * 4 + 1] + 0.0722 * irr[i * 4 + 2];
  const valid = (i) => gpos[i * 4 + 3] > 0.5;
  const candidates = { dark: [], bright: [] };
  let zeroValid = 0;
  for (let y = Math.floor(height * 0.15); y < height * 0.75; y++) {
    for (let x = Math.floor(width * 0.25); x < width * 0.75; x++) {
      const i = y * width + x;
      if (!valid(i)) continue;
      const L = lum(i);
      if (L === 0) { zeroValid++; candidates.dark.push(i); }
      else if (L > 0.5) candidates.bright.push(i);
    }
  }
  if (!candidates.dark.length) return { error: "no exact-zero valid pixels in band", brightCount: candidates.bright.length };
  const pickDark = candidates.dark[Math.floor(candidates.dark.length / 2)];
  const pickBright = candidates.bright.length
    ? candidates.bright[Math.floor(candidates.bright.length / 2)]
    : null;

  // ── probe-table + payload readbacks (whole buffer + slice), all guarded:
  // a missing field returns the shapes instead of throwing.
  let P;
  try { P = await import("/src/modules/gi/srcProbes.js"); } catch (e) { return { shapes, error: `import srcProbes: ${e}` }; }
  const { PROBE_WORDS, PROBE_AGE, PROBE_FLAGS, PROBE_PARENT, PROBE_BLOCK, SLOT_EMPTY } = P;
  const store = src.store;
  const bins = src.binStore;
  const grab = async (node) => node?.value ? new Uint32Array(await renderer.getArrayBufferAsync(node.value)) : null;
  const pixelProbe = await grab(store?.pixelProbe ?? src.pixelProbe ?? src.frame?.pixelProbe);
  if (!pixelProbe) return { shapes, frameKeys: describe(src.frame), error: "no pixelProbe buffer found" };
  const cascades = store?.cascades ?? [];
  const tables = [];
  for (const c of cascades) {
    const t = await grab(c.probeTable ?? c.table ?? store.probeTable);
    if (!t) return { shapes, error: "no probeTable on cascade", cascadeKeys: describe(c) };
    tables.push(t);
  }
  const binCasc = bins?.cascades ?? [];
  // payload is a FLOAT buffer, PAYLOAD_WORDS=4 per bin: [R,G,B,T], T<0 =
  // UNKNOWN (srcMerge writes floats; the first run read it as u32 pairs and
  // manufactured "known black" out of stride garbage).
  const payload = bins?.payload?.value ? new Float32Array(await renderer.getArrayBufferAsync(bins.payload.value)) : null;

  const inspect = (i) => {
    const out = {
      pixel: [i % width, Math.floor(i / width)],
      lum: +lum(i).toFixed(4),
      rgb: [irr[i * 4], irr[i * 4 + 1], irr[i * 4 + 2]].map((v) => +v.toFixed(3)),
      rawRgb: raw ? [raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2]].map((v) => +v.toFixed(4)) : "no raw target",
      gatherRgb: gat ? [gat[i * 4], gat[i * 4 + 1], gat[i * 4 + 2]].map((v) => +v.toFixed(4)) : `no gather tex (${Object.keys(src.gather ?? {}).join(",").slice(0, 120)})`,
      g0w: +gpos[i * 4 + 3].toFixed(2),
      world: [gpos[i * 4], gpos[i * 4 + 1], gpos[i * 4 + 2]].map((v) => +v.toFixed(2)),
    };
    let probe = pixelProbe?.[i];
    out.ladder = [];
    for (let c = 0; c < cascades.length && probe !== undefined && probe !== SLOT_EMPTY; c++) {
      const t = tables[c];
      const w = probe * PROBE_WORDS;
      const flags = t[w + PROBE_FLAGS];
      const block = t[w + PROBE_BLOCK];
      const entry = { c, probe, flags, block: block === SLOT_EMPTY ? "EMPTY" : block, age: t[w + PROBE_AGE] };
      // Bin stats for this probe's block from the merged payload (the
      // full-range answer) if the layout offers what we need.
      const info = binCasc[c];
      if (payload && info && block !== SLOT_EMPTY && Number.isFinite(info.binBase) && Number.isFinite(info.bins)) {
        let known = 0, sumT = 0, sumL = 0, maxL = 0;
        for (let b = 0; b < info.bins; b++) {
          const o = (info.binBase + block * info.bins + b) * 4;
          const T = payload[o + 3];
          if (T >= 0) {
            known++;
            sumT += T;
            const L = (payload[o] + payload[o + 1] + payload[o + 2]) / 3;
            sumL += L;
            maxL = Math.max(maxL, L);
          }
        }
        entry.payloadBins = {
          known, of: info.bins,
          meanT: known ? +(sumT / known).toFixed(3) : null,
          meanL: known ? +(sumL / known).toFixed(4) : null,
          maxL: +maxL.toFixed(4),
        };
      }
      out.ladder.push(entry);
      probe = t[w + PROBE_PARENT];
    }
    return out;
  };

  // The gather's own accounting at THIS camera — `empty` is the "no probes
  // at any corner → absent → zero" population, the discriminator between a
  // coverage hole and genuinely black bins.
  let stats = null;
  try { stats = await src.readStats(renderer); } catch (e) { stats = String(e).slice(0, 120); }
  // Is the filter actually in the dispatch queues, and is anything skipped?
  const screen = system.state.screen;
  const q = system.state.queue ?? [];
  const queueState = {
    irrInQueue: !!screen.irrTemporalPass && q.includes(screen.irrTemporalPass.compute),
    irrHistInQueue: !!screen.irrHistoryPass && q.includes(screen.irrHistoryPass.compute),
    resolveInQueue: !!screen.resolve && q.includes(screen.resolve.compute),
    queueLen: q.length,
    irrWeight: system._giIrrHistWeightU?.value,
    hasRawTarget: !!targets.irradianceRaw,
    irradianceIsRawAlias: targets.irradiance === targets.irradianceRaw,
    matNodeIsCurrent: system._giIrradianceNode?.value === targets.irradiance,
  };
  return {
    width, height,
    zeroValidCount: zeroValid,
    brightCount: candidates.bright.length,
    queueState,
    gather: stats?.gather ?? stats,
    dark: inspect(pickDark),
    dark2: candidates.dark.length > 10 ? inspect(candidates.dark[Math.floor(candidates.dark.length * 0.25)]) : null,
    bright: pickBright != null ? inspect(pickBright) : null,
  };
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: `${OUT}/view.png` });
console.log(`shot → ${OUT}/view.png`);
await browser.close();
