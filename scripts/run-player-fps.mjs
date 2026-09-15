// Frame-rate probe for an EXPORTED PLAYER (the live preview server or any
// build URL), in headless Chrome on the high-performance GPU, at an explicit
// physical canvas size. Reports presented fps, the CPU/GPU split, the GI
// world-chain cadence and which GI passes a frame really dispatched — the
// numbers the editor's `profile.frameStats` gives, taken from a build.
//
//   node scripts/run-player-fps.mjs <url> [--w 2872] [--h 1532] [--seconds 10]
//        [--settle 15] [--label name] [--gi off] [--dpr 1]
//
// ⚠ Pause the editor first (`profile.gpuIsolation`) — the harness and the
// editor share the adapter, and a live editor doubles every number here.
import puppeteer from "puppeteer-core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith("--")) {
  console.error("usage: node scripts/run-player-fps.mjs <url> [--w N] [--h N] [--seconds N] [--settle N] [--label s] [--gi off]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const width = Number(opt("w", 2872));
const height = Number(opt("h", 1532));
const dpr = Number(opt("dpr", 1));
const seconds = Number(opt("seconds", 10));
const settleMs = Number(opt("settle", 15)) * 1000;
const label = opt("label", `${width}x${height}`);
const giMode = opt("gi", "on");
const outDir = opt("out", ".gi-shots/player-fps");
// `--passes N`: after the fps capture, a per-pass GPU ledger over N seconds —
// three records one timestamp pair per compute dispatch and per render pass
// (`trackTimestamp`), and keeps each resolved duration under a
// `<type>:<contextId>:f<frame>` key; this maps the ids to GI pass names and
// render-target labels and accumulates ms per frame. Pair it with
// `--flags '{"__giComputeGroups":false}'` so every kernel is its own pass.
const passSeconds = Number(opt("passes", 0));
// `--hud`: load the build with `?hud=1` (the player's on-device readout) and
// print the overlay's text after the settle — checks the instrument a phone
// will show, on the same build.
const wantHud = process.argv.includes("--hud");
// `--eval '<js expression>'`: evaluated in the page after the settle, printed as JSON.
const evalExpr = opt("eval", null);
// `--mobile`: an iPhone user agent (+ touch points) so the build takes every
// portable-device branch — GI device tier, platform variants, DRS budget —
// on the desktop GPU, where the ledger can name what the phone only prices.
const wantMobile = process.argv.includes("--mobile");
mkdirSync(outDir, { recursive: true });

const start = Date.now();
const say = (v) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${v}`);
const gpuTelemetry = () => {
  try {
    return execFileSync("nvidia-smi", ["--query-gpu=clocks.sm,temperature.gpu,utilization.gpu,power.draw,clocks_event_reasons.sw_thermal_slowdown", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true }).trim();
  } catch { return null; }
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "engine-player-fps-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", `--window-size=${width},${height}`],
});
const logs = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Math.round(width / dpr), height: Math.round(height / dpr), deviceScaleFactor: dpr });
  page.on("console", (m) => {
    const line = m.text();
    logs.push(line);
    if (/validation|exceeds the maximum|invalid.*pipeline|DEVICE LOST/i.test(line)) errors.push(line);
  });
  page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
  // `--flags '{"__giSrcWorldHz":1}'` — GI dev globals, set BEFORE the module
  // loads so build-time hatches take effect on the first build (an A/B arm).
  const flags = opt("flags", null);
  if (flags) {
    const parsed = JSON.parse(flags);
    await page.evaluateOnNewDocument((f) => Object.assign(globalThis, f), parsed);
    say(`flags ${JSON.stringify(parsed)}`);
  }
  if (wantMobile) {
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
    await page.evaluateOnNewDocument(() => { try { Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }); } catch {} });
    say("mobile: iPhone user agent");
  }
  // `timestamps=1`: the player resolves GPU timestamps only when asked, and
  // every gpu reading (and the readiness wait below) needs them.
  const withParam = (u, p) => `${u}${u.includes("?") ? "&" : "?"}${p}`;
  const pageUrl = withParam(wantHud ? withParam(url, "hud=1") : url, "timestamps=1");
  say(`load ${pageUrl} at ${width}x${height} (dpr ${dpr}) label=${label} gi=${giMode}`);
  await page.goto(pageUrl, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => {
    const e = globalThis.__engine;
    return e?.playing && !e.renderSuspended && e.stats?.readout && e.renderer?.backend?.device;
  }, { timeout: 120000 });
  if (giMode === "off") {
    await page.evaluate(() => {
      const e = globalThis.__engine;
      const gi = e.modules.get("gi");
      // Disable the GI component so the build runs the plain raster frame.
      let found = 0;
      for (const ent of e.entities?.values?.() ?? []) {
        const c = ent.getComponent?.("global-illumination");
        if (!c) continue;
        found++;
        if (typeof c.setProp === "function") c.setProp("enabled", false);
        else if (c.props) { c.props.enabled = false; c.onPropChanged?.("enabled", false); }
      }
      console.log(`[probe] gi off: ${found} component(s)`);
    }).catch((err) => say(`gi off failed: ${err.message}`));
  } else {
    await page.waitForFunction(() => {
      const e = globalThis.__engine, s = e?.modules?.get("gi")?.system;
      // With timestamp queries disabled (`__engineTrackTimestamp = false`)
      // gpuComputeMs stays 0 for the whole run; the transport's presence
      // is then the readiness signal.
      return s?.state?.screen?.srcProbes &&
        (e.stats.readout.gpuComputeMs > 0 || globalThis.__engineTrackTimestamp === false);
    }, { timeout: 180000 });
  }
  if (passSeconds > 0) {
    await page.evaluate(() => {
      const e = globalThis.__engine, r = e.renderer, backend = r.backend;
      const names = new Map();      // compute context id -> pass name
      const renderLabels = new Map(); // render context id -> label
      const rawCompute = r.compute.bind(r);
      let anonymousSeq = 0;
      r.compute = (nodes, size) => {
        const list = Array.isArray(nodes) ? nodes : [nodes];
        // Anonymous arrays get an id so their chains are rows (see engine/passLedger.js).
        if (Array.isArray(nodes) && nodes.id == null) nodes.id = 0x50000000 + (anonymousSeq++ % 0x0fffffff);
        const id = Array.isArray(nodes) ? nodes.id : nodes?.id;
        const parts = list.map((n) => n?.__giPassName || n?.name || "?");
        const uniq = [...new Set(parts)];
        const label = uniq.length === 1 && parts.length > 1 ? `${uniq[0]} ×${parts.length}` : parts.join("+").slice(0, 60);
        if (id != null && !names.has(String(id))) names.set(String(id), label);
        return rawCompute(nodes, size);
      };
      const rawBegin = backend.beginRender.bind(backend);
      backend.beginRender = (ctx) => {
        if (ctx && !renderLabels.has(String(ctx.id))) {
          const rt = ctx.renderTarget;
          const tex = rt?.texture ?? rt?.textures?.[0];
          // Unnamed targets by shape + camera (a minified class name reads "Xi") — same as engine/passLedger.js.
          const shape = rt ? `rt${rt.textures?.length ?? 1}${rt.samples > 1 ? `x${rt.samples}` : ""}${rt.depthTexture ? "+D" : ""}:${tex?.format ?? "?"}/${tex?.type ?? "?"}` : "canvas";
          const base = rt ? (tex?.name || rt.depthTexture?.name || shape) : "canvas";
          const cam = (ctx.camera?.name || (ctx.camera?.isOrthographicCamera ? "ortho" : "")) + (ctx.scene?.name ? `/${ctx.scene.name}` : "");
          renderLabels.set(String(ctx.id), `${base}${cam ? `@${cam}` : ""}:${ctx.width ?? "?"}x${ctx.height ?? "?"}`);
        }
        return rawBegin(ctx);
      };
      globalThis.__passLedger = { names, renderLabels };
    });
    say("pass ledger armed");
  }
  say(`engine up; settling ${settleMs / 1000}s`);
  await new Promise((r) => setTimeout(r, settleMs));
  const meta = await page.evaluate(() => {
    const e = globalThis.__engine, r = e.renderer, s = e.modules.get("gi")?.system;
    const sc = s?.state?.screen;
    return {
      dpr: devicePixelRatio, css: [innerWidth, innerHeight],
      canvas: [r.domElement.width, r.domElement.height],
      resolve: sc ? [sc.width, sc.height] : null,
      emitter: sc ? [sc.emitterShadowWidth, sc.emitterShadowHeight] : null,
      adapter: r.backend.adapter?.info ? { vendor: r.backend.adapter.info.vendor, arch: r.backend.adapter.info.architecture, desc: r.backend.adapter.info.description } : null,
      giConfig: s?.config ?? null,
      quality: e.config?.quality ?? null,
      output: { toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace, direct: !!r.__directOutput, contextNode: !!r.contextNode, directConfig: e.config?.directOutput ?? null },
      performance: e.settings?.performance ?? null,
      camera: e.camera ? { position: e.camera.position.toArray(), fov: e.camera.fov } : null,
    };
  });
  say(`ready canvas=${meta.canvas} resolve=${meta.resolve} quality=${meta.quality}`);
  if (evalExpr) {
    const out = await page.evaluate((src) => { try { return JSON.stringify(eval(src)); } catch (e) { return "ERR " + (e?.message ?? e); } }, evalExpr);
    say(`EVAL ${out}`);
  }
  if (wantHud) {
    const hud = await page.evaluate(() => document.getElementById("player-hud")?.textContent ?? null);
    say(hud ? `HUD:
${hud}` : "HUD: not found");
  }
  const gpuBefore = gpuTelemetry();
  const capture = await page.evaluate(async (seconds) => {
    const e = globalThis.__engine, s = e.modules.get("gi")?.system;
    const sums = {}; let n = 0; const dts = []; let last = performance.now();
    const chains0 = s?._srcWorldChains ?? 0;
    const dispatchByName = {}; let dispatchFrames = 0;
    const detach = e.onPreRender(() => {
      const now = performance.now(); dts.push(now - last); last = now; n++;
      const ro = e.stats.readout;
      for (const k in ro) { const v = ro[k]; if (typeof v === "number" && Number.isFinite(v)) sums[k] = (sums[k] ?? 0) + v; }
      const d = s?._giDispatchedLastFrame;
      if (Array.isArray(d)) { dispatchFrames++; for (const name of d) dispatchByName[name] = (dispatchByName[name] ?? 0) + 1; }
    });
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const elapsed = (performance.now() - t0) / 1000;
    detach?.();
    const means = {}; for (const k in sums) means[k] = sums[k] / n;
    dts.sort((a, b) => a - b);
    const q = (p) => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
    const perFrame = {}; for (const k in dispatchByName) perFrame[k] = +(dispatchByName[k] / Math.max(1, dispatchFrames)).toFixed(2);
    return {
      framesCounted: n, elapsedS: +elapsed.toFixed(2), fpsCounted: +(n / elapsed).toFixed(1),
      frameMsP50: +q(0.5).toFixed(2), frameMsP95: +q(0.95).toFixed(2), frameMsMax: +Math.max(...dts).toFixed(1),
      means: Object.fromEntries(Object.entries(means).map(([k, v]) => [k, +v.toFixed(3)])),
      gi: s ? {
        worldChainsPerSec: +(((s._srcWorldChains ?? 0) - chains0) / elapsed).toFixed(2),
        worldHz: s._srcWorldHzLive, worldRested: s._srcWorldRested, motionRest: s._srcWorldMotionRest,
        restTerms: globalThis.__giSrcRestTermsLive ?? null,
        gbufHeldFrames: s._gbufStaticHeldFrames ?? null, moverOnlyFrames: s._moverOnlyFrames ?? null,
        halfRate: s._moverCadenceHalfRate ?? null,
        dispatchesPerFrame: perFrame,
      } : null,
    };
  }, seconds);
  let passes = null;
  if (passSeconds > 0) {
    say(`pass ledger: ${passSeconds}s`);
    passes = await page.evaluate(async (seconds) => {
      const e = globalThis.__engine, backend = e.renderer.backend;
      const { names, renderLabels } = globalThis.__passLedger;
      const seen = new Set();
      const acc = new Map(); // label -> { ms, calls }
      const frames = new Set();
      // The pools RETAIN ~8 batches of resolved entries (gpuTimestampRetention);
      // everything already there belongs to frames before the window, so it
      // is marked seen without being counted — the first draft counted that
      // backlog into a 12 s window and read the main pass at 3× per frame.
      for (const type of ["compute", "render"]) {
        const pool = backend.timestampQueryPool?.[type];
        if (pool?.timestamps) for (const uid of pool.timestamps.keys()) seen.add(uid);
      }
      const scan = () => {
        for (const type of ["compute", "render"]) {
          const pool = backend.timestampQueryPool?.[type];
          if (!pool?.timestamps) continue;
          for (const [uid, ms] of pool.timestamps) {
            if (seen.has(uid)) continue;
            seen.add(uid);
            // three: `c:<computeFrameCalls>:<node.id>:f<frame>` / `r:<renderFrameCalls>:<ctx.id>:f<frame>`
            const m = /^([rc]):(\d+):(.+):f(\d+)$/.exec(uid);
            if (!m) continue;
            frames.add(m[4]);
            // Label by POOL: three stamps array dispatches `r:` (see engine/passLedger.js).
            const label = type === "compute"
              ? `c:${names.get(m[3]) ?? `(id ${m[3]})`}`
              : `r:${renderLabels.get(m[3]) ?? `(ctx ${m[3]})`}`;
            const row = acc.get(label) ?? { ms: 0, calls: 0 };
            row.ms += ms; row.calls += 1;
            acc.set(label, row);
          }
        }
      };
      // Normalise by PRESENTED frames (elapsed × the readout's counted fps),
      // not by three's frame ids — those advance per render call (shadow map,
      // prepass, main), so an id count is ~3× the frames the player showed.
      let presented = 0;
      let fpsSamples = 0, fpsSum = 0;
      const tick = () => { presented++; scan(); const f = e.stats.readout.fps; if (f > 0) { fpsSum += f; fpsSamples++; } };
      const detach = e.onPostRender ? e.onPostRender(tick) : null;
      const timer = detach ? null : setInterval(scan, 8);
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      await new Promise((r) => setTimeout(r, 120)); // let the last resolve land
      scan();
      detach?.(); if (timer) clearInterval(timer);
      const elapsedS = (performance.now() - t0) / 1000;
      const meanFps = fpsSamples ? fpsSum / fpsSamples : 0;
      const nFrames = Math.max(1, presented || Math.round(elapsedS * meanFps));
      const rows = [...acc].map(([label, v]) => ({ label, msPerFrame: +(v.ms / nFrames).toFixed(3), callsPerFrame: +(v.calls / nFrames).toFixed(2) }))
        .sort((a, b) => b.msPerFrame - a.msPerFrame);
      const total = rows.reduce((t, r) => t + r.msPerFrame, 0);
      return { frames: nFrames, frameIds: frames.size, meanFps: +meanFps.toFixed(1), elapsedS: +elapsedS.toFixed(2), totalMsPerFrame: +total.toFixed(3), rows };
    }, passSeconds);
    say(`PASSES ${label}: ${passes.frames} presented frames (${passes.frameIds} render ids, ${passes.meanFps} fps), ${passes.totalMsPerFrame} ms/frame attributed`);
    for (const r of passes.rows.slice(0, 40)) say(`  ${r.msPerFrame.toFixed(3).padStart(7)} ms  x${String(r.callsPerFrame).padStart(5)}  ${r.label}`);
  }
  const gpuAfter = gpuTelemetry();
  const result = { label, url, width, height, dpr, meta, capture, passes, gpuBefore, gpuAfter, errors: errors.slice(0, 20) };
  const file = join(outDir, `${label.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  writeFileSync(file.replace(/\.json$/, ".log"), logs.join("\n"));
  const m = capture.means;
  say(`RESULT ${label}: fps ${capture.fpsCounted} (stats ${m.fps?.toFixed?.(0)}) | cpu work ${m.workMs} ms | gpu ${m.gpuMs} (render ${m.gpuRenderMs ?? "?"} / compute ${m.gpuComputeMs ?? "?"}) | draws ${m.drawCalls} | p95 ${capture.frameMsP95} ms | world ${capture.gi?.worldChainsPerSec}/s @${capture.gi?.worldHz}Hz`);
  console.log(JSON.stringify(result, null, 2));
  say(`saved ${file}; console errors: ${errors.length}`);
} finally {
  await browser.close().catch(() => {});
}
