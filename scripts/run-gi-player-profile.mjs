// Profile an actual exported player at its physical canvas size. No editor,
// scene substitution, quality reduction, or concurrent GPU fixtures.
// node scripts/run-gi-player-profile.mjs <url> <receipt-prefix>
// MODES=rest,pointer-sweep,balls-after-sweep controls repeated phases.
// PASSES=1 freezes immediately after pointer-sweep (PASSES_AFTER overrides).
// Isolated pass replay changes GI history; subsequent phases are marked.
// UPLOADS=1 audits actual NodeUniformBuffer upload bytes during each phase.
// This exact comparison adds CPU overhead; leave it off for frame-rate claims.
import puppeteer from "puppeteer-core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/run-gi-player-profile.mjs <url> [receipt-prefix]");
  process.exit(2);
}
const prefix = process.argv[3] ?? ".gi-shots/optimization120/player";
mkdirSync(dirname(prefix), { recursive: true });
const width = Number(process.env.WIDTH ?? 2872);
const height = Number(process.env.HEIGHT ?? 1532);
const modes = process.env.MODES
  ? process.env.MODES.split(",").map(v => v.trim()).filter(Boolean)
  : process.env.SOAK ? ["rest", "pointer-sweep", ...Array(Number(process.env.SOAK)).fill("balls-after-sweep")]
    : ["rest", "pointer-sweep", "balls-after-sweep"];
const passMode = process.env.PASSES_AFTER ?? (modes.includes("pointer-sweep") ? "pointer-sweep" : modes.at(-1));
const logs = [];
const errors = [];
const start = Date.now();
const say = (value) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${value}`);
const gpuTelemetry = () => {
  try { return execFileSync("nvidia-smi", ["--query-gpu=timestamp,temperature.gpu,clocks.gr,clocks.mem,utilization.gpu,memory.used,power.draw,pstate", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return null; }
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: process.env.GPU_SMOKE_PROFILE ?? mkdtempSync(join(tmpdir(), "engine-gi-player-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"],
});
let page;
let primaryError = null;
try {
  page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    const line = message.text();
    logs.push(line);
    if (/validation|exceeds the maximum|invalid.*pipeline/i.test(line)) errors.push(line);
  });
  page.on("pageerror", (error) => errors.push(String(error.stack ?? error)));
  say(`load ${url}, physical ${width}x${height}`);
  // The player resolves GPU timestamps only when asked; this profile reads them.
  await page.goto(`${url}${url.includes("?") ? "&" : "?"}timestamps=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => {
    const e = globalThis.__engine, s = e?.modules?.get("gi")?.system;
    // _frame can reset on a geometry revision while physics is active; it
    // is not a monotonic boot timer. Require actual compute work instead.
    return e?.playing && !e.renderSuspended && s?.state?.screen?.srcProbes &&
      (e.renderer?.backend?.__giComputeSubmitStats?.requestedSubmits ?? 0) > 5000 &&
      e.stats.sample().gpuComputeMs > 0;
  }, { timeout: 180000 });
  await page.evaluate(() => {
    const e = globalThis.__engine;
    let installed = null, nextSourceId = 0;
    const receipts = { count: 0, recent: [], startedAt: performance.now() };
    const probe = globalThis.__giPlayerProfile = { receipts, phase: "settle", actualPasses: [], held: null };
    const instrument = () => {
      const s = e.modules.get("gi")?.system, src = s?.state?.screen?.srcProbes;
      if (!src || installed?.src === src || typeof src.readStats !== "function") return;
      // Do not let this instrument keep a retired probe store alive.
      if (installed && installed.src.readStats === installed.wrapped) installed.src.readStats = installed.original;
      const original = src.readStats;
      const sourceId = nextSourceId++;
      function wrapped(...args) {
        receipts.count++;
        receipts.recent.push({ atMs: performance.now() - receipts.startedAt,
          frame: s._frame, sourceId, phase: probe.phase });
        if (receipts.recent.length > 64) receipts.recent.shift();
        return original.apply(this, args);
      }
      src.readStats = wrapped;
      installed = { src, original, wrapped };
    };
    instrument();
    const detach = e.onPreRender(instrument);
    probe.restore = () => {
      probe.restoreUploads?.();
      detach?.();
      if (installed && installed.src.readStats === installed.wrapped) installed.src.readStats = installed.original;
      installed = null;
      if (probe.held) {
        const { release, wasRunning } = probe.held;
        probe.held = null;
        release();
        if (wasRunning) e.start();
      }
      delete globalThis.__giPlayerProfile;
    };
  });
  say("GI is active; settling before capture");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SETTLE_MS ?? 15000)));
  const metadata = await page.evaluate(() => {
    const e = globalThis.__engine, r = e.renderer, s = e.modules.get("gi").system;
    const sc = s.state.screen;
    return {
      url: location.href, dpr: devicePixelRatio, css: [innerWidth, innerHeight],
      canvas: [r.domElement.width, r.domElement.height], resolve: [sc.width, sc.height],
      ao: [sc.vxaoPass?.width, sc.vxaoPass?.height], emitter: [sc.emitterShadowWidth, sc.emitterShadowHeight],
      adapter: r.backend.adapter?.info ?? null, storageLimit: r.backend.device.limits.maxStorageBuffersPerShaderStage,
      settings: e.settings, giConfig: s.config,
      camera: { position: e.camera.position.toArray(), fov: e.camera.fov },
      submitStats: r.backend.__giComputeSubmitStats ?? null,
    };
  });
  say(`ready ${JSON.stringify({ canvas: metadata.canvas, resolve: metadata.resolve, ao: metadata.ao })}`);
  const phases = [];
  let passesMeasured = false;
  for (const mode of modes) {
    say(`capture ${mode}`);
    const measurePasses = !!process.env.PASSES && !passesMeasured && mode === passMode;
    const result = await page.evaluate(async ({ mode, seconds, measurePasses, uploads }) => {
      const e = globalThis.__engine, r = e.renderer, s = e.modules.get("gi").system;
      const probe = globalThis.__giPlayerProfile;
      // Installed Three's NodeUniformBuffer inherits Buffer.update() => true;
      // WebGPUBindingUtils.updateBinding uploads binding.buffer (or its element
      // updateRanges) to backend.get(binding).buffer. Observe THAT boundary,
      // never scalar UniformsGroup values or storage attributes. All uploads
      // still run; this instrument measures candidates, it does not skip them.
      const installUploadAudit = (backend) => {
        const original = backend.updateBinding;
        if (typeof original !== "function") throw new Error("WebGPU updateBinding is unavailable for UPLOADS=1");
        const snapshots = new WeakMap();
        const rows = new Map();
        const empty = () => ({ attempts: 0, bytes: 0, writeCalls: 0, unchanged: 0, unchangedBytes: 0,
          unchangedWriteCalls: 0, unchangedWriteBytes: 0, initialUploads: 0,
          gpuBufferChanges: 0, partialUploads: 0, failed: 0, unsupported: 0, writeBufferFlushes: 0 });
        const totals = empty();
        const statsSnapshot = () => {
          const stats = backend.__giComputeSubmitStats;
          if (!stats) return null;
          return { scopes: stats.scopes, requestedSubmits: stats.requestedSubmits,
            actualSubmits: stats.actualSubmits, savedSubmits: stats.savedSubmits,
            commandBuffers: stats.commandBuffers, writes: stats.writes, fences: stats.fences,
            flushErrors: stats.flushErrors, flushes: { ...stats.flushes } };
        };
        const submissionBefore = statsSnapshot();
        function auditedUpdate(binding, ...args) {
          if (binding?.isNodeUniformBuffer !== true) return original.call(this, binding, ...args);
          const name = binding.name || "(unnamed NodeUniformBuffer)";
          let row = rows.get(name);
          if (!row) {
            row = { name, ...empty(), bindings: 0, maxBufferBytes: 0, byPass: {} };
            rows.set(name, row);
          }
          const add = (key, amount = 1) => { totals[key] += amount; row[key] += amount; };
          add("attempts");
          const passName = globalThis.__giCurrentComputeName ?? "render/other";
          row.byPass[passName] = (row.byPass[passName] ?? 0) + 1;
          const array = binding.buffer;
          const gpuBuffer = this.get(binding).buffer;
          if (!ArrayBuffer.isView(array) || !Number.isInteger(array.BYTES_PER_ELEMENT) || !gpuBuffer) {
            add("unsupported");
            snapshots.delete(binding);
            return original.call(this, binding, ...args);
          }
          const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          const ranges = binding.updateRanges ?? [];
          // Same contiguous-range merging and element-to-byte conversion as
          // WebGPUBindingUtils. Nonuploaded bytes never seed the GPU snapshot.
          const writes = [];
          if (!ranges.length) writes.push([0, bytes.length]);
          else {
            let start = ranges[0].start;
            for (let index = 0; index < ranges.length; index++) {
              const range = ranges[index], next = ranges[index + 1];
              const end = range.start + range.count;
              if (next && next.start === end) continue;
              writes.push([start * array.BYTES_PER_ELEMENT, end * array.BYTES_PER_ELEMENT]);
              if (next) start = next.start;
            }
          }
          if (writes.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end) ||
              start < 0 || end < start || end > bytes.length)) {
            add("unsupported");
            snapshots.delete(binding);
            return original.call(this, binding, ...args);
          }
          let prior = snapshots.get(binding);
          if (!prior) row.bindings++;
          if (prior && prior.gpuBuffer !== gpuBuffer) add("gpuBufferChanges");
          if (!prior || prior.gpuBuffer !== gpuBuffer || prior.bytes.length !== bytes.length) {
            prior = { gpuBuffer, bytes: new Uint8Array(bytes.length), known: new Uint8Array(bytes.length) };
            snapshots.set(binding, prior);
            add("initialUploads");
          }
          row.maxBufferBytes = Math.max(row.maxBufferBytes, bytes.length);
          const attemptedBytes = writes.reduce((sum, [start, end]) => sum + end - start, 0);
          add("bytes", attemptedBytes);
          add("writeCalls", writes.length);
          if (ranges.length) add("partialUploads");
          let allUnchanged = true, unchangedWriteCalls = 0, unchangedWriteBytes = 0;
          for (const [start, end] of writes) {
            let unchanged = true;
            for (let offset = start; offset < end; offset++) {
              // Byte equality preserves signed zero and NaN payloads, unlike
              // float-value comparisons. Unknown bytes must count as changed.
              if (!prior.known[offset] || prior.bytes[offset] !== bytes[offset]) { unchanged = false; break; }
            }
            allUnchanged &&= unchanged;
            if (unchanged) { unchangedWriteCalls++; unchangedWriteBytes += end - start; }
          }
          const flushesBefore = backend.__giComputeSubmitStats?.flushes?.writeBuffer ?? 0;
          let result;
          try { result = original.call(this, binding, ...args); }
          catch (error) {
            add("failed");
            snapshots.delete(binding);
            throw error;
          } finally {
            add("writeBufferFlushes", (backend.__giComputeSubmitStats?.flushes?.writeBuffer ?? 0) - flushesBefore);
          }
          if (allUnchanged) { add("unchanged"); add("unchangedBytes", attemptedBytes); }
          add("unchangedWriteCalls", unchangedWriteCalls);
          add("unchangedWriteBytes", unchangedWriteBytes);
          for (const [start, end] of writes) {
            prior.bytes.set(bytes.subarray(start, end), start);
            prior.known.fill(1, start, end);
          }
          return result;
        }
        backend.updateBinding = auditedUpdate;
        const restore = () => { if (backend.updateBinding === auditedUpdate) backend.updateBinding = original; };
        return {
          restore,
          report: () => {
            const submissionAfter = statsSnapshot();
            let submissionDelta = null;
            if (submissionBefore && submissionAfter) {
              submissionDelta = {};
              for (const key of Object.keys(submissionBefore)) {
                if (key !== "flushes") submissionDelta[key] = submissionAfter[key] - submissionBefore[key];
              }
              submissionDelta.flushes = Object.fromEntries(
                [...new Set([...Object.keys(submissionBefore.flushes), ...Object.keys(submissionAfter.flushes)])]
                  .map((key) => [key, (submissionAfter.flushes[key] ?? 0) - (submissionBefore.flushes[key] ?? 0)]));
            }
            return { enabled: true, timingPerturbed: true, scope: "NodeUniformBuffer actual updateBinding uploads only",
              ...totals, submissionDelta,
              byBindingName: [...rows.values()].sort((a, b) => b.unchangedBytes - a.unchangedBytes || b.bytes - a.bytes) };
          },
        };
      };
      probe.phase = mode;
      const readStatsBefore = probe.receipts.count;
      const canvas = r.domElement, counts = {}, samples = [], observed = new Map();
      let frameNodes = [], latestWorldFrame = [];
      const compute = r.backend.compute;
      let observedSrc = s.state?.screen?.srcProbes;
      function observedCompute(group, node, ...args) {
        const result = compute.call(this, group, node, ...args);
        if (observedSrc !== s.state?.screen?.srcProbes) {
          observedSrc = s.state?.screen?.srcProbes;
          observed.clear();
          frameNodes = [];
          latestWorldFrame = [];
        }
        const name = node?.__giPassName ?? globalThis.__giCurrentComputeName ?? node?.name ?? `compute#${node?.id}`;
        counts[name] = (counts[name] ?? 0) + 1;
        const dispatchSize = Array.isArray(args[2]) ? args[2].slice() : args[2] ?? null;
        if (!observed.has(node)) observed.set(node, { node, name, dispatchSize });
        frameNodes.push({ node, dispatchSize });
        return result;
      }
      r.backend.compute = observedCompute;
      const detachFrame = e.onPostRender(() => {
        const srcPasses = s.state?.screen?.srcProbes?.passes ?? [];
        // Keep a complete actual frame containing the world chain. A screen-
        // only cadence frame would omit the population/deposit prerequisites.
        if (frameNodes.some(({ node }) => srcPasses.includes(node) && String(node.__giPassName).startsWith("src:populate"))) {
          latestWorldFrame = frameNodes;
        }
        frameNodes = [];
      });
      const freezeForPasses = () => {
        const wasRunning = e.loopActive;
        e.stop();
        probe.held = { wasRunning, release: e.suspendSimulation("player-gpu-profile") };
        const current = new Set([...(s.state?.screen?.srcProbes?.passes ?? []),
          ...(s.state?.queue ?? []), ...(s.state?.queueNoFeedback ?? []), ...(s.state?.queueFeedbackOnly ?? [])]);
        probe.actualPasses = [...observed.values()].filter(({ node }) =>
          // Screen kernels such as GTAO and emitterShadow are dispatched
          // directly, outside state.queue and src.passes. Keep those too.
          current.has(node) || !String(node.__giPassName ?? "").startsWith("src:"));
        probe.actualFrame = latestWorldFrame;
      };
      const lightBefore = { ...s._lightTreeChangeTally };
      e.stats.beginPhaseCapture(10000, { attribute: true });
      const t0 = performance.now();
      let last = t0;
      let uploadAudit = null;
      try {
        if (uploads) {
          uploadAudit = installUploadAudit(r.backend);
          probe.restoreUploads = uploadAudit.restore;
        }
        await new Promise((resolve) => {
          const tick = () => {
            const now = performance.now(), t = (now - t0) / 1000;
            if (mode === "pointer-sweep") {
              const box = canvas.getBoundingClientRect();
              canvas.dispatchEvent(new PointerEvent("pointermove", {
                pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true,
                clientX: box.left + box.width * (0.5 + 0.34 * Math.sin(t * 3.2)),
                clientY: box.top + box.height * (0.58 + 0.28 * Math.sin(t * 4.7)),
              }));
            }
            const st = e.stats.sample();
            samples.push({ dt: now - last, cpu: st.workMs, gpu: st.gpuMs,
              render: st.gpuRenderMs, compute: st.gpuComputeMs, fps: st.fps,
              worldHz: s._srcWorldHzLive, worldRested: s._srcWorldRested,
              sceneMotion: globalThis.__giSrcRestTermsLive?.mLightNoCam,
              restDriveNoCamera: globalThis.__giSrcRestDriveNoCamLive,
              draws: st.drawCalls, triangles: st.triangles });
            last = now;
            if (t >= seconds) {
              if (measurePasses) freezeForPasses();
              resolve();
            } else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      } finally {
        uploadAudit?.restore();
        delete probe.restoreUploads;
        if (r.backend.compute === observedCompute) r.backend.compute = compute;
        detachFrame?.();
        e.stats.endPhaseCapture();
      }
      const elapsed = (performance.now() - t0) / 1000;
      const sorted = samples.map(v => v.dt).sort((a, b) => a - b);
      const mean = (key) => samples.reduce((sum, v) => sum + (v[key] ?? 0), 0) / samples.length;
      return { mode, elapsed, rafFps: samples.length / elapsed,
        frameP50: sorted[Math.floor(sorted.length * .5)], frameP95: sorted[Math.floor(sorted.length * .95)],
        cpuMs: mean("cpu"), gpuMs: mean("gpu"), gpuRenderMs: mean("render"), gpuComputeMs: mean("compute"),
        presentedFpsMean: mean("fps"), counts, cpu: e.stats.readPhaseCapture(),
        uploads: uploadAudit?.report(),
        readStatsCalls: { duringPhase: probe.receipts.count - readStatsBefore,
          total: probe.receipts.count, recent: probe.receipts.recent.slice(-16) },
        state: { gbufferHeld: s._gbufHeld, gtaoHeld: s._gtaoHeld, worldHz: s._srcWorldHzLive,
          rest: globalThis.__giSrcRestTermsLive,
          restDriveNoCamera: globalThis.__giSrcRestDriveNoCamLive,
          lightBefore, lightAfter: s._lightTreeChangeTally }, samples };
    }, { mode, seconds: Number(process.env.SECONDS ?? 8), measurePasses, uploads: process.env.UPLOADS === "1" });
    result.afterIsolatedPassReplay = passesMeasured;
    result.atSeconds = (Date.now() - start) / 1000;
    result.gpuTelemetry = gpuTelemetry();
    result.population = await page.evaluate(async () => {
      const e = globalThis.__engine, s = e.modules.get("gi").system, src = s.state.screen.srcProbes;
      const pressure = await src.readPressure(e.renderer);
      const world = e.modules.get("physics-rapier")?.system?.world;
      const physics = world ? { dynamicBodies: 0, awake: 0, maxSpeed: 0, maxAngularSpeed: 0 } : null;
      world?.forEachRigidBody(body => {
        if (!body.isDynamic()) return;
        physics.dynamicBodies++;
        if (!body.isSleeping()) physics.awake++;
        const v = body.linvel(), w = body.angvel();
        physics.maxSpeed = Math.max(physics.maxSpeed, Math.hypot(v.x, v.y, v.z));
        physics.maxAngularSpeed = Math.max(physics.maxAngularSpeed, Math.hypot(w.x, w.y, w.z));
      });
      return { frame: s._frame, cascades: pressure.cascades, depositNoBlock: pressure.depositNoBlock,
        physics,
        pools: src.poolConfig, ceilings: src.poolCeilings?.(),
        retained: src.frame?.retain ? { maxAge: src.frame.retain.maxAge,
          highWater: src.frame.retain.highWater, worldKeys: src.frame.retain.worldKeys } : null,
        transport: { rayStride: src.rayStride, rayCeiling: src.rayCeiling,
          naturalRays: src.naturalRays, tracedRayBudget: src.tracedRays, probeRayCap: src.probeRayCap,
          live: globalThis.__giSrcTransportLive ?? globalThis.__giSrcTransport ?? null },
        heap: performance.memory?.usedJSHeapSize, srcPasses: src.passes.length,
        timestampEntries: Object.fromEntries(["render", "compute"].map(type => [type, {
          stored: e.renderer.backend.timestampQueryPool?.[type]?.timestamps?.size ?? 0,
          pending: e.renderer.backend.timestampQueryPool?.[type]?.queryOffsets?.size ?? 0,
          frames: e.renderer.backend.timestampQueryPool?.[type]?.frames ?? [],
        }])),
        pool: s._srcPoolProfile ?? null, memory: { ...e.renderer.info.memory },
        memoryRecords: e.renderer.info.memoryMap?.size ?? null };
    });
    phases.push(result);
    writeFileSync(`${prefix}.json`, JSON.stringify({ metadata, phases, errors }, null, 2));
    say(`${mode}: ${result.rafFps.toFixed(1)} callbacks/s, CPU ${result.cpuMs.toFixed(2)} ms, GPU ${result.gpuMs.toFixed(2)} ms`);
    if (phases.length < 4) await page.screenshot({ path: `${prefix}-${mode}.png` });
    if (!measurePasses) continue;
    passesMeasured = true;
    say(`measure actual GPU kernels at frozen ${mode} pose; these are isolated costs, not frame totals`);
    const passes = await page.evaluate(async () => {
      const e = globalThis.__engine, r = e.renderer, probe = globalThis.__giPlayerProfile;
      const { release, wasRunning } = probe.held;
      const selected = probe.actualPasses;
      const out = [];
      try {
        if (!selected.length || !probe.actualFrame.length) throw new Error("No complete world frame observed for GPU pass profiling");
        if (!r.backend.hasTimestamp) throw new Error("GPU timestamp queries are unavailable");
        if (e._gpuTimestampInFlight) await e._gpuTimestampInFlight;
        await r.backend.device.queue.onSubmittedWorkDone();
        await r.resolveTimestampsAsync("compute");
        for (let rep = 0; rep < 3; rep++) {
          // Replay one observed complete frame to refresh compute dependencies.
          // This preserves its actual dispatch order; no tick/physics advances.
          for (const { node, dispatchSize } of probe.actualFrame) r.compute(node, dispatchSize);
          await r.resolveTimestampsAsync("compute");
          for (let i = 0; i < selected.length; i++) {
            const { node, name, dispatchSize } = selected[i];
            r.compute(node, dispatchSize);
            const uid = r.backend.getTimestampUID(node);
            await r.resolveTimestampsAsync("compute");
            // Read this kernel's UID rather than the query pool's lastValue,
            // which can be a previous result when no fresh query landed.
            const ms = r.backend.timestampQueryPool.compute.timestamps.get(uid);
            if (!Number.isFinite(ms)) throw new Error(`No GPU timestamp for ${name}`);
            (out[i] ??= { name, nodeId: node.id, count: node.count, samples: [] }).samples.push(ms);
          }
        }
        return { phase: probe.phase, frozenSimulation: true, frameTotals: false,
          observedFrameDispatches: probe.actualFrame.length,
          kernels: out.map(v => ({ ...v, ms: v.samples.reduce((a,b)=>a+b,0)/v.samples.length })) };
      } finally {
        probe.held = null;
        release();
        if (wasRunning) e.start();
      }
    });
    writeFileSync(`${prefix}-passes.json`, JSON.stringify(passes, null, 2));
    say(`GPU passes: ${JSON.stringify(passes.kernels.toSorted((a,b)=>b.ms-a.ms).slice(0,8).map(p=>({name:p.name,ms:+p.ms.toFixed(3)})))}`);
  }
  if (errors.length) throw new Error(`${errors.length} browser/GPU errors; see receipt`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    if (page && !page.isClosed()) {
      await page.evaluate(() => globalThis.__giPlayerProfile?.restore?.());
    }
  } catch (error) {
    console.warn(`Player profile restore warning: ${error?.message ?? error}`);
  } finally {
    // Close even when a receipt is locked by PowerShell's stdout Tee. Browser
    // console logs use a separate path so `${prefix}.log` remains safe for Tee.
    try {
      await browser.close();
    } catch (error) {
      if (!primaryError) throw error;
      console.warn(`Player profile browser-close warning: ${error?.message ?? error}`);
    } finally {
      try { writeFileSync(`${prefix}-browser.log`, logs.join("\n")); }
      catch (error) { console.warn(`Player profile browser-log warning: ${error?.message ?? error}`); }
    }
  }
}
say("complete; independent player closed");
