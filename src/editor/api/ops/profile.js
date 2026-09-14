/**
 * GPU frame profiling — where the milliseconds actually go.
 *
 * The performance panel reports one aggregate GPU number, which is enough to
 * know a frame is slow and useless for knowing WHY. Every attempt to answer
 * "why" from outside the editor runs into the same wall: a headless probe's
 * viewport is a fraction of a real one, and screen-space GI cost is per-pixel,
 * so its numbers do not extrapolate. The measurement has to happen in the
 * editor that is actually slow.
 *
 * `profile.giPasses` dispatches each GI pass on its own, K times, with the
 * WebGPU timestamp queries resolved around it — so every pass reports its own
 * cost at the resolution the user is really running. It suspends the render
 * loop for the duration (otherwise the editor's own dispatches land inside the
 * measurement window) and restores it afterwards.
 */
import { defineOp } from "../registry.js";
import { isViewportFreezeEnabled } from "../../viewportFreeze.js";
import { getEditorFramePacingState } from "../../editorFramePacing.js";
import { readTexturePixelsGPU } from "../../../modules/gi/giScreen.js";
import { engine } from "../../engineInstance.js";
import { getViewportHandle } from "../../viewportHandle.js";
import { constantColorOf, textureValueOf } from "../../../modules/gi/materialNodeBindings.js";
import { auditDrawCalls } from "../../../engine/drawCallAudit.js";
import { collectViewCullingStats } from "../../../engine/culling/viewCullingStats.js";
import { freeze } from "../../../engine/freezeLedger.js";

/**
 * Named screen-chain passes, in the order they run.
 *
 * ⚠ `bvhReflect` was MISSING from this list until 2026-08-16, and it is the
 * most expensive thing GI dispatches on a high/ultra scene: a full-screen,
 * hit-shaded exact-reflection BVH trace, run EVERY frame it is enabled
 * (`GISystem.#tick`, right after the gbuffer). Its absence is what made this op
 * report ~7 ms for a module that moves 18 ms between the `low` and `ultra`
 * presets, and it sent two sessions of frame-rate work at the raster side of
 * the frame looking for a cost that was sitting in GI all along. An
 * instrument's omissions read as zeros, and zeros read as innocence — anything
 * `giCompute` dispatches belongs here.
 */
const SCREEN_PASSES = [
  "lightShadowPass",
  "lightShadowFilterPass",
  "lightShadowWidePass",
  "lightShadowWidePass2",
  "lightShadowHistoryPass",
  "lightShadowPostPass",
  "emitterShadowPass",
  "emitterShadowFilterPass",
  "bvhReflect",
];

let gpuIsolationTimer = null;
let gpuIsolationRestart = false;
function releaseGpuIsolation() {
  if (gpuIsolationTimer === null) return;
  clearTimeout(gpuIsolationTimer);
  gpuIsolationTimer = null;
  engine.resumeSimulation("profile-gpu-isolation");
  if (gpuIsolationRestart && !engine.loopActive) engine.start();
  gpuIsolationRestart = false;
}
defineOp({
  name: "profile.giGlossyStats",
  readOnly: true,
  description: "Luminance statistics of the GI screen targets a material reads for its reflection term versus its diffuse term: the glossy gather (the lattice along the reflected direction, per resolve pixel) against the irradiance target. Mean, p50, p95, max and the fraction of pixels above a luma threshold, from a 64×64 downsample. The receipt behind 'reflective surfaces look too bright': when p95 of the glossy target is many times the irradiance's, the reflection lobe is reading a small bright region the diffuse average does not.",
  params: {
    threshold: { type: "number", default: 1, description: "Luma above which a pixel counts as 'bright'." },
  },
  async run({ threshold = 1 } = {}) {
    const system = engine.modules?.get?.("gi")?.system;
    const screen = system?.state?.screen;
    const glossy = screen?.srcProbes?.glossy?.target ?? null;
    const irradiance = screen?.targets?.irradiance ?? null;
    if (!glossy || !irradiance) throw new Error("GI screen targets are not live (glossy gather or irradiance missing).");
    const { readTexturePixelsGPU } = await import("../../../modules/gi/giScreen.js");
    const stats = async (tex) => {
      const px = await readTexturePixelsGPU(engine.renderer, tex, 64);
      if (!px?.length) return null;
      const lum = [];
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        lum.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
      }
      if (!lum.length) return null;
      lum.sort((a, b) => a - b);
      const q = (f) => lum[Math.min(lum.length - 1, Math.floor(f * lum.length))];
      const mean = lum.reduce((t, v) => t + v, 0) / lum.length;
      return {
        pixels: lum.length,
        mean: +mean.toFixed(4),
        p50: +q(0.5).toFixed(4),
        p95: +q(0.95).toFixed(4),
        max: +lum[lum.length - 1].toFixed(4),
        aboveThreshold: +(lum.filter((v) => v > threshold).length / lum.length).toFixed(4),
      };
    };
    const g = await stats(glossy);
    const e = await stats(irradiance);
    // The reflection-probe textures a metal reads inside a probe box: the
    // blurred atlas (what materials sample), the raw capture scratch and the
    // EMA history — each summarized over the WHOLE texture (8 probe rows,
    // unused rows are black) so the numbers compare 1:1 with the player HUD's
    // `atlas(8-bit)` line, plus per-probe capture counters. The receipt for
    // "probes carry the glow on the phone but read black on the desktop".
    const gpu = system?._reflProbeGpu ?? null;
    const recs = [...(system?._reflProbes?.values?.() ?? []), ...(system?._autoReflProbes ?? [])].map((rec) => ({
      slot: rec.slot ?? null, rounds: rec.rounds ?? 0, dirty: !!rec.dirty,
      capturedAgoFrames: rec.capturedAt >= 0 ? Math.max(0, (system?._frame ?? 0) - rec.capturedAt) : null,
      center: rec.center ? [+rec.center.x.toFixed(2), +rec.center.y.toFixed(2), +rec.center.z.toFixed(2)] : null,
    }));
    const probes = gpu ? {
      armed: !!screen?.reflProbes,
      pinnedOff: globalThis.__giReflectionProbes === false,
      shadowsPinnedOff: globalThis.__giProbeShadows === false,
      atlas: await stats(gpu.atlas).catch((err) => `readback failed: ${err?.message ?? err}`),
      scratch: gpu.scratch ? await stats(gpu.scratch).catch((err) => `readback failed: ${err?.message ?? err}`) : null,
      history: gpu.history ? await stats(gpu.history).catch((err) => `readback failed: ${err?.message ?? err}`) : null,
      recs,
    } : null;
    return {
      threshold,
      glossy: g,
      irradiance: e,
      probes,
      ratio: g && e ? { mean: +(g.mean / Math.max(e.mean, 1e-6)).toFixed(2), p95: +(g.p95 / Math.max(e.p95, 1e-6)).toFixed(2) } : null,
      glossyCap: screen?.srcProbes?.glossy?.cap?.value ?? null,
      rayOffset: screen?.srcProbes?.glossy?.rayOffset?.value ?? null,
      note: "glossy = radiance the material mixes in for reflections (already /π); irradiance = the diffuse target (E, not /π). Compare glossy against irradiance/π for like units.",
    };
  },
});

defineOp({
  name: "profile.giAoParity",
  readOnly: true,
  description: "Verify the live cached GTAO texture against fresh executions at identical inputs, byte for byte at native half-float resolution. Also changes AO strength temporarily to prove the fixture responds, then restores the exact original output. Pauses simulation during readback.",
  params: {},
  async run() {
    const screen = engine.modules?.get("gi")?.system?.state?.screen;
    const pass = screen?.vxaoPass;
    const nodes = [...(screen?.aoComputes ?? [])];
    if (!pass?.reusableGtao || !nodes.length) throw new Error("No reusable GTAO chain is active.");
    const renderer = engine.renderer;
    const backend = renderer.backend;
    const width = pass.width, height = pass.height;
    const format = backend.get(pass.target).textureDescriptorGPU?.format;
    if (format !== "rgba16float") throw new Error(`Unexpected AO format: ${format}`);
    const read = async () => {
      const values = await backend.copyTextureToBuffer(pass.target, 0, 0, width, height, 0);
      const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      const pitch = Math.ceil(width * 8 / 256) * 256;
      const tight = new Uint8Array(width * height * 8);
      for (let y = 0; y < height; y++) tight.set(bytes.subarray(y * pitch, y * pitch + width * 8), y * width * 8);
      return tight;
    };
    const differences = (a, b) => a.reduce((n, value, i) => n + (value !== b[i] ? 1 : 0), 0);
    const run = () => { for (const node of nodes) renderer.compute(node); };
    const restart = engine.loopActive;
    engine.stop();
    const release = engine.suspendSimulation("profile-gi-ao-parity");
    const strength = screen.vxao.strength.value;
    try {
      const held = await read();
      run();
      const fresh = await read();
      run();
      const repeated = await read();
      screen.vxao.strength.value = strength > 0 ? strength * 0.5 : 1;
      run();
      const changed = await read();
      screen.vxao.strength.value = strength;
      run();
      const restored = await read();
      const report = {
        width, height, bytes: held.length,
        heldVsFresh: differences(held, fresh),
        freshVsRepeated: differences(fresh, repeated),
        strengthChangedBytes: differences(fresh, changed),
        restoredBytes: differences(fresh, restored),
      };
      return { ...report, pass: report.heldVsFresh === 0 && report.freshVsRepeated === 0 && report.restoredBytes === 0 && report.strengthChangedBytes > 0 };
    } finally {
      screen.vxao.strength.value = strength;
      try { run(); } finally {
        release();
        if (restart && !engine.loopActive) engine.start();
      }
    }
  },
});

defineOp({
  name: "profile.gpuIsolation",
  description: "Temporarily pause this editor's simulation and drawing while an external GPU regression runs on the same adapter. Automatically resumes after seconds; active=false resumes immediately. Does not edit the scene.",
  params: {
    active: { type: "boolean", default: true },
    seconds: { type: "number", default: 180, description: "Safety timeout, 1–600 seconds." },
  },
  run({ active = true, seconds = 180 }) {
    releaseGpuIsolation();
    if (active) {
      gpuIsolationRestart = engine.loopActive;
      engine.stop();
      engine.suspendSimulation("profile-gpu-isolation");
      gpuIsolationTimer = setTimeout(releaseGpuIsolation,
        Math.max(1, Math.min(600, Number(seconds) || 180)) * 1000);
    }
    return { isolated: gpuIsolationTimer !== null, simulationSuspended: engine.simulationSuspended, loopActive: engine.loopActive };
  },
});

defineOp({
  name: "profile.giFlag",
  description:
    "DEV: set one GI build-time hatch (a `__gi…` global), persist it in localStorage (`gi.devFlags.v1`, applied when the GI module loads) and queue a GI rebuild. Hatches read at SCREEN-CHAIN creation (e.g. `__giIrrTemporal`) need an editor.reload to take effect; the flag survives it. Drive an A/B from an agent session — e.g. `__giIrrTemporal` false to bypass the irradiance temporal filter, `__giMergeLos` false, `__giGatherNormalWeight` false, `__giBvhSimplify` false. Read-back: the value now set and whether a rebuild was queued. Only names starting with `__gi` are accepted; pass value null to delete the flag (restores the default).",
  params: {
    name: { type: "string", description: "The global's name, must start with `__gi`. OMIT it to LIST every flag currently persisted, changing nothing." },
    value: { description: "true / false / number / string, or null to delete." },
    rebuild: { type: "boolean", default: true, description: "Queue a GI rebuild so build-time hatches take effect (default true)." },
  },
  async run({ name, value = null, rebuild = true }) {
    // ── LISTING IS THE DEFAULT WHEN NO NAME IS GIVEN ────────────────────────
    //
    // These flags PERSIST in localStorage across reloads and across sessions,
    // and nothing but a boot line ever showed them. An A/B arm set weeks ago
    // therefore reads as engine behaviour: `__giWorldIdle = false` was found
    // live on the user's editor (2026-09-09) still disabling the converged
    // world-idle sleep that has been default-on since 2026-09-02, with no way
    // to see it short of scrolling to the first second of the console. A
    // switch that can silently change what every measurement means has to be
    // readable without changing anything.
    if (name === undefined || name === null || name === "") {
      let store = {};
      try { store = JSON.parse(localStorage.getItem("gi.devFlags.v1") || "{}"); } catch { /* storage unavailable */ }
      // The LIVE value too: a flag set from the console this session is not in
      // the store, and one in the store that the module never applied is not
      // live. Reporting only one of them is how a stale arm stays invisible.
      //
      // ⚠ SCALARS ONLY for the live half. The `__gi` namespace is shared with
      // live DIAGNOSTIC channels — `__giPipelineTimings` is an array of every
      // pipeline compiled this session, `__giLightTreeLive` a whole tree
      // snapshot — and serialising those turned a flag listing into a 4 MB
      // reply. A hatch is a switch; anything that is not a scalar is not one,
      // and a persisted entry is listed whatever its shape because the store
      // is the thing this op exists to expose.
      const scalar = (v) => v === null || ["boolean", "number", "string"].includes(typeof v);
      const names = new Set([
        ...Object.keys(store),
        ...Object.keys(globalThis).filter(
          (key) => /^__gi[A-Za-z0-9_]*$/.test(key) && scalar(globalThis[key]),
        ),
      ]);
      const flags = [...names].sort().map((key) => {
        const live = globalThis[key];
        return {
          name: key,
          persisted: key in store ? store[key] : null,
          live: live === undefined ? null : (scalar(live) ? live : `<${typeof live}>`),
          onlyLive: !(key in store),
        };
      });
      return {
        flags,
        count: flags.length,
        note: flags.length
          ? "Every one of these overrides a shipped default. `persisted` survives reloads (localStorage `gi.devFlags.v1`); pass the name with value null to clear it."
          : "No GI dev flags are set — the module is running its shipped defaults.",
      };
    }
    if (typeof name !== "string" || !/^__gi[A-Za-z0-9_]*$/.test(name)) {
      throw new Error("profile.giFlag: `name` must be a `__gi…` global");
    }
    const before = globalThis[name];
    if (value === null || value === undefined) delete globalThis[name];
    else globalThis[name] = value;
    // Persist across reloads (build-time hatches are read once, and a
    // rebuild keeps the screen chain): GISystem applies `gi.devFlags.v1` at
    // import. Deleting a flag removes it from the store too.
    try {
      const key = "gi.devFlags.v1";
      const store = JSON.parse(localStorage.getItem(key) || "{}");
      if (value === null || value === undefined) delete store[name];
      else store[name] = value;
      if (Object.keys(store).length) localStorage.setItem(key, JSON.stringify(store));
      else localStorage.removeItem(key);
    } catch { /* storage unavailable: the in-page value still applies */ }
    const system = engine.modules?.get?.("gi")?.system ?? null;
    let queued = false;
    if (rebuild && system?.requestRebuild) {
      system.requestRebuild(`dev-flag:${name}`);
      queued = true;
    }
    return { name, before: before === undefined ? null : before, now: globalThis[name] === undefined ? null : globalThis[name], rebuildQueued: queued };
  },
});

defineOp({
  name: "profile.giPasses",
  readOnly: true,
  description:
    "Per-pass GPU cost of the GI module, measured with real WebGPU timestamp queries at the CURRENT viewport resolution. Use this instead of guessing which pass owns a slow frame — it reports the shadow trace, each filter/wide pass, the resolve, and every pass in the GI frame queue separately, plus the resolve/shadow pixel counts that drive all of them. Suspends rendering for a few hundred milliseconds while it measures.",
  params: {
    samples: {
      type: "number",
      default: 40,
      description: "Dispatches per pass (higher = steadier numbers, longer freeze). Max 200.",
    },
  },
  async run({ samples = 40 }) {
    const K = Math.max(4, Math.min(200, Math.round(samples)));
    const renderer = engine?.renderer;
    const sys = engine?.modules?.get("gi")?.system;
    if (!renderer) throw new Error("No renderer.");
    if (!sys?.state?.screen) throw new Error("The GI module is not active in this scene.");
    if (!renderer.backend?.trackTimestamp) {
      throw new Error(
        "This adapter has no timestamp-query support, so GPU pass timings are unavailable. " +
          "Enable timestamp queries in scene settings, or read the aggregate GPU number in the performance panel.",
      );
    }
    const screen = sys.state.screen;

    const wasSuspended = engine.renderSuspended;
    engine.renderSuspended = true;
    await new Promise((r) => setTimeout(r, 250));
    try {
      // ⚠ `info.compute.timestamp` is ASSIGNED per resolve, not accumulated —
      // `Backend.resolveTimestampsAsync` does `info[type].timestamp =
      // duration` where `duration` is the batch it just resolved. So the
      // before/after subtraction this op used to do computed `thisBatch −
      // prevBatch`: for K same-pass dispatches after a 1-dispatch warm batch
      // that is K·d − d, a −1/K bias that read as clean numbers for a whole
      // phase, and for the rep-major chain below it was the DIFFERENCE
      // between successive passes — negative chain totals on a live frame.
      // The resolve's RETURN VALUE is the batch duration; use it directly.
      const timeOne = async (compute) => {
        if (!compute) return null;
        // Warm first: the very first dispatch pays pipeline + bind-group setup,
        // which is not what "cost per frame" means. The resolve flushes it out
        // of the next batch.
        renderer.compute(compute);
        await renderer.resolveTimestampsAsync("compute");
        for (let i = 0; i < K; i++) renderer.compute(compute);
        const dur = await renderer.resolveTimestampsAsync("compute");
        return +(((dur ?? 0)) / K).toFixed(4);
      };

      // A pass that EXISTS is not necessarily a pass that RUNS: the emitter
      // trace + filter are skipped per frame while the scene has no emissive
      // meshes. Timing them anyway is useful (it says what promoting one
      // would cost) but reporting the number bare would inflate the frame.
      // filter(Boolean): the seat array is positional and may carry interior
      // holes (sticky promotion) — count occupants, not slots.
      const emittersLive = (sys._emitterInfos?.filter(Boolean).length ?? 0) > 0;
      const giShadowLive = (sys.state?.lightSlots ?? []).some((s) => (s?.giShadow?.value ?? 0) > 0);
      // Exact reflections need high/ultra AND `exactReflections` AND a material
      // in bucket 0/3 to consume them (`GISystem.#bvhReflectionsEnabled`, which
      // is private). Mirror its OBSERVABLE half here: the bucket tally is the
      // consumer test, and `__giNoBvhReflections` is the live hatch. Getting
      // this wrong only mislabels a number, never hides one.
      const reflectionsLive =
        !!screen.bvhReflect &&
        globalThis.__giNoBvhReflections !== true &&
        ((sys._bucketTally?.[0] ?? 0) + (sys._bucketTally?.[3] ?? 0) > 0);
      const skipReason = (name) => {
        if (name.startsWith("emitter") && !emittersLive) return "0 emitters";
        if (name.startsWith("lightShadow") && !giShadowLive) return "no light uses Shadow Source \"gi\"";
        if (name === "bvhReflect" && !reflectionsLive) return "exact reflections off (tier, hatch, or no bucket 0/3 material)";
        return null;
      };
      const passes = {};
      let liveTotal = 0;
      for (const name of SCREEN_PASSES) {
        const compute = screen[name]?.compute;
        if (!compute) continue;
        const ms = await timeOne(compute);
        const why = skipReason(name);
        passes[name] = why ? `${ms} (NOT dispatched — ${why})` : ms;
        if (!why && typeof ms === "number") liveTotal += ms;
      }
      const resolveCompute = screen.resolve?.compute ?? screen.resolve;
      if (resolveCompute) {
        passes.resolve = await timeOne(resolveCompute);
        if (typeof passes.resolve === "number") liveTotal += passes.resolve;
      }
      // §11.40: the emitter marcher's HELD cost — what a movers-only frame
      // pays once the static visibility cache is full (stride S: one pixel
      // in S re-marches the static world, the rest read the cache and
      // re-test only the movers). The frame loop sets that stride only on
      // movers-only frames, and the cache is invalid whenever the static
      // key moved (it does, all through a boot), so this arm sets the
      // stride, fills the cache through the write -> read snapshot, times
      // the pair (the snapshot is ~0.02 ms) and restores the uniform. The
      // bare `emitterShadowPass` above is the stride-1 cost: every pixel
      // marches and stores.
      const snapCompute = screen.emitterStaticSnapshotPass?.compute;
      const emitterCompute = screen.emitterShadowPass?.compute;
      const strideU = sys._giEmitterStaticStrideU;
      if (snapCompute && emitterCompute && strideU && emittersLive) {
        const prevStride = strideU.value;
        const stride = sys.emitterStaticStride ?? 4;
        strideU.value = stride;
        try {
          for (let i = 0; i < 2 * stride + 2; i++) {
            renderer.compute(emitterCompute);
            renderer.compute(snapCompute);
          }
          await renderer.resolveTimestampsAsync("compute");
          for (let i = 0; i < K; i++) {
            renderer.compute(emitterCompute);
            renderer.compute(snapCompute);
          }
          const dur = await renderer.resolveTimestampsAsync("compute");
          passes[`emitterShadowPass (movers-only: static cache, stride ${stride})`] = +((dur ?? 0) / K).toFixed(4);
        } finally {
          strideU.value = prevStride;
        }
      }

      // Named, and sorted most-expensive-first: the point of this op is to
      // find the pass that owns the frame, and a positional array of twenty
      // numbers hides it.
      const queue = sys.state.queue ?? [];
      const labels = sys.state.queueLabels ?? [];
      const queueEntries = [];
      for (let i = 0; i < queue.length; i++) {
        queueEntries.push({ pass: labels[i] ?? `queue[${i}]`, ms: await timeOne(queue[i]) });
      }
      const queueMs = {};
      for (const e of [...queueEntries].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))) {
        // The frame loop dispatch-skips the shadow chains (GISystem's
        // `frameSkip`), but this op times raw queue nodes — so a skipped
        // pass shows its WOULD-BE cost. Annotate it the way screenPassesMs
        // does, or the number reads as live frame cost (it misread as a
        // 1.9ms/frame leak once already).
        const why = skipReason(e.pass);
        const value = why && typeof e.ms === "number" ? `${e.ms} (NOT dispatched — ${why})` : e.ms;
        // Duplicate labels (one merge per cascade level) keep their index.
        queueMs[queueMs[e.pass] === undefined ? e.pass : `${e.pass} #${queueEntries.indexOf(e)}`] = value;
      }
      // SRC probe population (opt-in via `__giSrcProbes`), timed PER GROUP.
      //
      // It used to be one number, on the stated grounds that "the interesting
      // question is what the chain costs, not which of two clears is slower".
      // That held while this was fourteen tiny dispatches. It stopped holding at
      // 44 dispatches and 91ms on the user's Sponza — ~50x the entire screen
      // total — at which point "what does the chain cost" has an obvious answer
      // and the only useful question is which group owns it. Its telemetry still
      // rides along because "3.1ms" and "3.1ms at load 0.94 with 900 dropped
      // inserts" call for completely different responses.
      let srcProbes = null;
      if (screen.srcProbes) {
        // ══ REP-MAJOR, NOT PASS-MAJOR — THE CHAIN'S STATE IS PART OF ITS COST ═
        //
        // `timeOne` dispatches one pass K times in isolation, and the SRC chain
        // is a per-frame ALGORITHM: [D1] accumulates counts a clear pass resets,
        // [D3] partitions a cursor it expects zeroed, [D5] hands out slices of
        // exactly what [D1] counted. K isolated reps of each violate all of
        // that — counts inflate K×, the partition marches K× past the buffer,
        // and [D5] hands the deposit garbage offsets. The old numbers survived
        // by luck: a deposit tracing from garbage offsets COSTS the same as one
        // tracing from real ones, so the timing held while the state lied.
        //
        // The per-probe ray cap ended the luck. Its [D5] DENIES claims outside
        // the probe's segment, and against K×-inflated state that is every
        // claim — so the deposit timed an empty dispatch: `0.68 ms, 0 rays
        // fired` on a frame whose live telemetry says 21,520 shaded hits.
        // An instrument that breaks when the code gets safer is mis-built.
        //
        // So the chain is timed REP-MAJOR: each rep dispatches every pass in
        // frame order, per-pass timestamps accumulate across reps. Every rep is
        // a legal frame (uniforms don't advance, so it is the SAME frame
        // re-run), the per-group attribution is unchanged, and the stats
        // buffer afterwards holds a real frame's tallies — which is what
        // `readStats` below relays. Reps are capped at 8: one rep already
        // times 44 dispatches, and a timestamp resolve per dispatch makes
        // reps linearly expensive wall-clock.
        const chain = screen.srcProbes.passes;
        for (const pass of chain) renderer.compute(pass);
        await renderer.resolveTimestampsAsync("compute");
        const reps = Math.min(K, 8);
        const perPass = new Array(chain.length).fill(0);
        for (let rep = 0; rep < reps; rep++) {
          for (let i = 0; i < chain.length; i++) {
            renderer.compute(chain[i]);
            perPass[i] += (await renderer.resolveTimestampsAsync("compute")) ?? 0;
          }
        }
        let srcMs = 0;
        for (let i = 0; i < perPass.length; i++) {
          perPass[i] = +(perPass[i] / reps).toFixed(4);
          srcMs += perPass[i];
        }
        // Group boundaries come from srcSystem in `passes` order. Asserted
        // rather than trusted: a group list that has drifted from the pass list
        // would silently attribute cost to the wrong stage, which is worse than
        // the single sum this replaced.
        const groups = screen.srcProbes.passGroups ?? [];
        const groupTotal = groups.reduce((n, g) => n + g.count, 0);
        const groupMs = {};
        if (groups.length && groupTotal === perPass.length) {
          let at = 0;
          for (const g of groups) {
            const slice = perPass.slice(at, at + g.count);
            at += g.count;
            groupMs[g.label] = {
              ms: +slice.reduce((a, b) => a + b, 0).toFixed(3),
              dispatches: g.count,
              worstPassMs: +Math.max(0, ...slice).toFixed(3),
            };
          }
        } else if (groups.length) {
          groupMs.ERROR = `passGroups sum ${groupTotal} != ${perPass.length} passes — ` +
            "srcSystem's group list has drifted from its pass list; per-group numbers withheld.";
        } else {
          // AND SAY SO. This branch used to fall through silently, so a missing
          // `passGroups` produced `{}` — indistinguishable from "every group
          // measured 0ms", and it cost three runs to tell those apart. An
          // absent input is a louder failure than a wrong one, not a quieter.
          groupMs.ERROR = "srcProbes.passGroups is absent — the per-group breakdown cannot be " +
            "computed. Either srcSystem did not publish it, or this editor is running a stale " +
            `module. Object has ${perPass.length} passes totalling ${srcMs.toFixed(3)}ms.`;
        }
        const stats = await screen.srcProbes.readStats(renderer);
        // The far-field mean's alpha carries the dark share of gather-covered
        // geometry (giScreen createGiFarFieldAvgPass): the "black patches"
        // gauge. 8-bit through the readback: 1/255 resolution.
        let farField = null;
        try {
          const tex = engine.modules?.get?.("gi")?.system?._giFarFieldTex ?? null;
          if (tex) {
            // 4x1 texture read as 4x4: texel (1,0) is px[4..7], x = dark share;
            // texel (2,0) is px[8..11], the RAW mean the seed reads (§11.16).
            const px = await readTexturePixelsGPU(renderer, tex, 4);
            if (px?.length >= 12) {
              farField = {
                rgb8: [px[0], px[1], px[2]],
                rawRgb8: [px[8], px[9], px[10]],
                primed: px[11] > 127,
                darkFrac: +(px[4] / 255).toFixed(3),
                coveredK: Math.round(px[5] / 255 * 1000),
                // Share of geometry pixels whose gather had no coverage and took
                // the fallback fill — the "patches with no data" gauge.
                fillFrac: +(px[6] / 255).toFixed(3),
              };
            }
          }
        } catch (error) {
          farField = { error: error?.message ?? String(error) };
        }
        srcProbes = {
          farField,
          totalMs: +srcMs.toFixed(3),
          dispatches: screen.srcProbes.passes.length,
          // Sorted most-expensive-first, same discipline as `queueMs`: the
          // point of this op is to find what owns the frame, and an unsorted
          // map of eight entries hides it.
          groupMs: Object.fromEntries(
            Object.entries(groupMs).sort((a, b) => (b[1]?.ms ?? 0) - (a[1]?.ms ?? 0)),
          ),
          spacing0: stats.spacing0,
          megabytes: +(stats.bytes / 1048576).toFixed(2),
          reanchors: stats.reanchors,
          cascades: stats.cascades.map((c) => ({
            cascade: c.cascade,
            live: c.live,
            capacity: c.probeCapacity,
            loadFactor: +c.loadFactor.toFixed(3),
            meanProbeSteps: +c.meanProbeSteps.toFixed(2),
            failedInserts: c.failed,
            // §11.17: c0 probes lifted by the starvation floor this frame.
            starved: c.starved ?? null,
          })),
          // Read from the RUN, not from the phase plan. This note said
          // "Produces no light yet" for as long as that was true and then for a
          // while after it stopped being true, which is the failure mode that
          // matters: it is consulted precisely when someone is deciding whether
          // a dark frame is expected. `shaded` is the deposit kernel's own
          // per-frame tally, so the note now reports what the GPU did.
          //
          // ⚠ THE TALLIES LIVE UNDER `stats.rays`, NOT ON `stats`. This op read
          // `stats.shaded` for a whole phase and reported `shadedHitsPerFrame:
          // 0` against frames that were visibly shading — §12.39.3 logged it as
          // a suspend-race in the counters, and it was never a race at all: an
          // `undefined ?? 0` wearing the same costume as an empty readback. The
          // deposit's `readStats` is the one place these words are decoded;
          // this op only relays it.
          shadedHitsPerFrame: stats.rays?.shaded ?? 0,
          // §11.44: tree-sample visibilities the per-probe cache answered vs marched.
          visCachedPerFrame: stats.rays?.visCached ?? 0,
          visMarchedPerFrame: stats.rays?.shadowRays ?? 0,
          visNoBlockPerFrame: stats.rays?.visNoBlock ?? 0,
          visNoRowPerFrame: stats.rays?.visNoRow ?? 0,
          visFillingPerFrame: stats.rays?.visFilling ?? 0,
          visFullPerFrame: stats.rays?.visFull ?? 0,
          visCacheTable: stats.visCache ?? null,
          visCacheShare: ((stats.rays?.visCached ?? 0) + (stats.rays?.shadowRays ?? 0)) > 0
            ? +((stats.rays?.visCached ?? 0) / ((stats.rays?.visCached ?? 0) + (stats.rays?.shadowRays ?? 0))).toFixed(3)
            : null,
          // The transport's fired count, kernel-tallied. Under the per-probe
          // ray cap this is the REAL total — the boot line's `rays/frame` is an
          // upper bound there, and dividing a deposit time by the bound would
          // overstate the kernel by exactly the cap's savings.
          raysPerFrame: stats.rays?.rays ?? 0,
          probeRayCap: screen.srcProbes.probeRayCap ?? null,
          // §11.50's cap loop: what it fired, against what budget, how
          // complete the field was, and which branch it took. Reading the cap
          // alone cannot tell "converged, giving rays back" from "pinned at
          // CAP_MAX and still short".
          capLoop: globalThis.__giSrcTransport?.capLoop ?? null,
          // The bounce albedo the transport actually uses: the slot palette's
          // live mean (what an unattributed hit shades at, and the scale of
          // every attributed one), and the reflection atlas census — a
          // textured scene reading 0 textured is shading its bounces at
          // the flat tint, which is the whole-frame brightness bug class.
          paletteMeanAlbedo: globalThis.__giSurfacePaletteDebug?.fallbackAlbedo
            ? globalThis.__giSurfacePaletteDebug.fallbackAlbedo.map((v) => +Number(v).toFixed(3))
            : null,
          slotAtlas: engine.modules?.get?.("gi")?.system?._slotAtlas
            ? { materials: engine.modules.get("gi").system._slotAtlas.materialCount ?? null, textured: engine.modules.get("gi").system._slotAtlas.texturedCount ?? null }
            : null,
          // §11.14: the second-bounce pass's own tallies — `clamped` is the loop's
          // saturation counter (bounce term alone at the Lmax ceiling).
          secondary: stats.secondary ?? null,
          unattributedRate: stats.rays?.unattributedRate != null
            ? +(stats.rays.unattributedRate * 100).toFixed(2) + "%"
            : null,
          // §11.13: the share of rays that traced their far intervals this
          // frame (100% = no far duty).
          farRayRate: stats.rays?.farRate != null
            ? +(stats.rays.farRate * 100).toFixed(1) + "%"
            : null,
          // ...of which the NEED FLOOR forced beyond the duty's stratum.
          farNeedRate: stats.rays?.farNeedRate != null
            ? +(stats.rays.farNeedRate * 100).toFixed(1) + "%"
            : null,
          farDutyLive: globalThis.__giSrcFarDutyLive ?? null,
          // §11.15: rays that started inside a mover and were dropped.
          insideMoverRays: stats.rays?.insideMoverRays ?? null,
          moverHits: stats.rays?.moverHits ?? null,
          // §11.17: rays per c0 probe by LOD (opt-in `__giProfileProbeRays`).
          probeRays: stats.probeRays ?? null,
          moverRecords: stats.rays?.moverRecords ?? null,
          // §11.13: opt-in bin-count histogram (`__giProfileBinHistogram = true`).
          ...(stats.binHistogram ? { binHistogram: stats.binHistogram } : {}),
          // The transport's live temporal dials (the decay's keep and the α it came from).
          keepLive: globalThis.__giSrcKeepLive ?? null,
          alphaLive: globalThis.__giSrcAlphaLive ?? null,
          // §15 front 5 ("smooth light no matter where we go"): the ladder's
          // health decides whether bins carry the full-range answer or a
          // patchy partial one. orphanRate is the number to watch — healthy
          // ~0.01; the user-visible "patches updating" state reads 0.3+.
          // Relayed verbatim from the merge/seed/tiles readbacks so an
          // agent can watch it over MCP without a custom page.
          merge: stats.merge ?? null,
          seed: stats.seed ?? null,
          tiles: stats.tiles ?? null,
          note: stats.rays?.shaded
            ? `Hit shading is LIVE — ${stats.rays.shaded} hits shaded last frame. Radiance carries ` +
              "albedo, sun, lights and emission."
            : "Populating probes but shading NO hits — every deposited radiance is zero, so the " +
              "diffuse term is sky-visibility only. Check `__giSrcShade`.",
        };
      }
      // The canvas backing store IS the drawing buffer, and reading it avoids
      // both a three import and getDrawingBufferSize's Vector2 contract.
      const canvas = renderer.domElement;
      return {
        marcher: screen.lightShadow?.marcher ?? "(gi shadows off)",
        adoptedMovers: sys._dynSet?.count?.() ?? 0,
        pixels: {
          drawingBuffer: canvas ? [canvas.width, canvas.height] : null,
          resolve: [screen.width, screen.height],
          shadow: [screen.shadowWidth, screen.shadowHeight],
          emitterShadow: [screen.emitterShadowWidth, screen.emitterShadowHeight],
        },
        emitters: sys._emitterInfos?.filter(Boolean).length ?? 0,
        screenPassesMs: passes,
        // What the frame ACTUALLY pays — passes marked "NOT dispatched" are
        // timed for reference (what enabling them would cost) but excluded.
        screenTotalMs: +liveTotal.toFixed(3),
        srcProbes,
        queueMs,
        queueTotalMs: +queueEntries
          .filter((e) => !skipReason(e.pass))
          .map((e) => e.ms)
          .filter((v) => typeof v === "number")
          .reduce((a, b) => a + b, 0)
          .toFixed(3),
        note:
          "Every screen pass is per-resolve-pixel work — halving the GI Resolve Scale quarters all of them. " +
          "Queue entries are the cascade/occupancy chain (volume-sized, mostly resolution-independent).",
      };
    } finally {
      engine.renderSuspended = wasSuspended;
    }
  },
});

/**
 * The other half of the frame, and the half nobody could see.
 *
 * `profile.giPasses` measures COMPUTE dispatches. Everything else in the frame
 * — the scene draw and every postprocess effect — is a RENDER pass, and for two
 * sessions the only way to attribute it was subtraction: total minus GI minus a
 * postprocess-off A/B run by hand. That arithmetic said the scene draw costs
 * ~16 ms for 262 k triangles on a 4070, which is absurd per-triangle and
 * therefore per-PIXEL, and left ~26 ms of a 33 ms frame unattributed across
 * SSR + 5 blurs, GTAO, 11 Bloom passes and Godrays. Guessing which of those
 * owns the frame is exactly what this op exists to stop.
 *
 * HOW: post effects declare their work in `updateBefore` — the hook the node
 * system calls to render an effect's own passes before the quad that samples
 * them. Calling it directly, K times, with `resolveTimestampsAsync("render")`
 * around the batch gives that effect's real GPU cost at the real resolution.
 * The scene draw comes along for free: `PassNode` is a node in the same graph
 * and its `updateBefore` IS `renderer.render(scene, camera)`.
 *
 * ⚠ FILTER ON `updateBeforeType`, NOT ON THE METHOD. The base `Node` class
 * defines an empty `updateBefore`, so `typeof node.updateBefore === "function"`
 * matches every node in the graph and would report hundreds of 0.00 ms rows.
 * `updateBeforeType` is `'none'` unless a node actually opts in.
 */
defineOp({
  name: "profile.renderPasses",
  readOnly: true,
  description:
    "Per-pass GPU cost of the RENDER side of the frame — the scene draw and each postprocess effect — measured with real WebGPU timestamp queries at the current viewport resolution. The companion to profile.giPasses, which only sees compute dispatches: use both and the frame adds up instead of leaving a large unattributed remainder. Reports each effect separately (SSR, GTAO, every Bloom mip, Godrays) plus the whole-pipeline total, so the residual between them is visible rather than assumed. Suspends rendering while it measures.",
  params: {
    samples: {
      type: "number",
      default: 20,
      description: "Renders per pass (higher = steadier numbers, longer freeze). Max 200.",
    },
  },
  async run({ samples = 20 }) {
    const K = Math.max(4, Math.min(200, Math.round(samples)));
    const renderer = engine?.renderer;
    if (!renderer) throw new Error("No renderer.");
    if (!renderer.backend?.trackTimestamp) {
      throw new Error(
        "This adapter has no timestamp-query support, so GPU pass timings are unavailable. " +
          "Enable timestamp queries in scene settings, or read the aggregate GPU number in the performance panel.",
      );
    }
    const nodeFrame = renderer._nodes?.nodeFrame;
    if (!nodeFrame) throw new Error("The renderer has no node frame yet — render at least one frame first.");

    // The postprocess component that owns the camera currently being drawn.
    // Without one there is no output graph, and the only render pass in the
    // frame is the scene draw itself — still worth timing, so we fall through.
    let post = null;
    for (const ent of engine.entities?.values?.() ?? []) {
      const component = ent.getComponent?.("postprocess");
      if (component?.pipeline && component.outputNode) {
        post = component;
        break;
      }
    }

    const wasSuspended = engine.renderSuspended;
    engine.renderSuspended = true;
    await new Promise((r) => setTimeout(r, 250));
    const previousFrameRenderer = nodeFrame.renderer;
    try {
      nodeFrame.renderer = renderer;

      // ⚠ RESOLVE AFTER EVERY CALL, NEVER ONCE AFTER K OF THEM.
      //
      // `profile.giPasses` batches K dispatches and resolves once, and that is
      // safe for compute because a GI pass is ONE dispatch. A render is not: a
      // full `pipeline.render()` opens ~20 render passes, and three's WebGPU
      // timestamp pool holds **256 queries** (`WebGPUTimestampQueryPool`,
      // `maxQueries = 256` = 128 pass pairs). K=24 full renders overflows it
      // after the fifth, every later `allocateQueriesForContext` returns null,
      // and the resolve then reports a fraction of the truth as if it were the
      // whole — the first build of this op read 0.53 ms for a 32 ms frame.
      //
      // There is a second reason: `_resolveQueries` returns
      // `framesDuration[frames.at(-1)]` — the total of the LAST FRAME ONLY,
      // grouped by `renderer.info.frame`. One resolve per call keeps exactly
      // one frame group in flight, so the number is unambiguous.
      const timeRender = async (run) => {
        try {
          run(); // warm: the first call pays pipeline + bind-group setup
        } catch (error) {
          return { ms: null, error: error?.message ?? String(error) };
        }
        await renderer.resolveTimestampsAsync("render");
        let total = 0;
        for (let i = 0; i < K; i++) {
          run();
          total += (await renderer.resolveTimestampsAsync("render")) ?? 0;
        }
        return { ms: +(total / K).toFixed(4) };
      };

      // Establish sane renderer state (current target, MRT, bind groups) before
      // driving any node by hand: an effect's updateBefore inherits whatever
      // target is bound, and a half-configured renderer is the documented way
      // to get an empty fragment output struct and a dropped command encoder.
      // ⚠ ADVANCE THE NODE FRAME BETWEEN PIPELINE RENDERS, or the total is not
      // a frame. `PassNode.updateBefore` is `NodeUpdateType.FRAME`, and the
      // node system runs a FRAME-typed update ONCE per `renderer.info.frame` —
      // so K back-to-back `pipeline.render()` calls render the scene on the
      // first one only and post-only on the other K−1, reporting a "frame"
      // total with no scene in it. This is exactly what `Renderer._renderScene`
      // does per real frame.
      const advanceFrame = () => {
        renderer._nodes.nodeFrame.update();
        renderer.info.frame = renderer._nodes.nodeFrame.frameId;
      };
      let frameTotalMs = null;
      if (post) {
        post.pipeline.outputNode = post.outputNode;
        const total = await timeRender(() => {
          advanceFrame();
          post.pipeline.render();
        });
        frameTotalMs = total.ms;
      }

      // THE SCENE DRAW, from a direct reference rather than the graph walk.
      // `PostprocessComponent.scenePass` is the `pass(scene, camera)` node the
      // component owns, and `PassNode.updateBefore` IS
      // `renderer.render(scene, camera)` into its MRT — main opaque, depth,
      // normal/matParams attachments, the lot. It is reported separately from
      // the walk because it is the single number this op exists for, and it
      // must not depend on the walk finding anything.
      const scenePass = post?.scenePass ?? null;
      const sceneDraw = scenePass ? await timeRender(() => scenePass.updateBefore(nodeFrame)) : null;

      // ⚠ THE EFFECT LIST COMES FROM THE COMPILER, NOT FROM A GRAPH WALK.
      //
      // The first build of this op walked `outputNode` for nodes with a
      // non-`none` `updateBeforeType` and found THREE nodes, all `none` — every
      // effect was invisible, because addons return a PassTextureNode over the
      // effect rather than the effect itself, and the hop is not a node child.
      // `compilePostGraph` now records them as it builds (`compiled.effects`),
      // which additionally labels each one with the USER'S graph node type, so
      // the profile reads "bloom" rather than "UnrealBloomNode #3".
      const collected = (post?.compiled?.effects ?? [])
        .filter((entry) => entry?.node && entry.node !== scenePass)
        .map((entry) => ({ label: entry.label ?? "effect", node: entry.node }));

      const used = new Map();
      const label = (base) => {
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        return n === 1 ? base : `${base} #${n}`;
      };

      const rows = [];
      for (const { label: base, node } of collected) {
        const { ms, error } = await timeRender(() => node.updateBefore(nodeFrame));
        rows.push({
          pass: label(base),
          node: node.constructor?.name ?? "Node",
          updateBeforeType: node.updateBeforeType,
          ms,
          ...(error ? { error } : {}),
        });
      }
      rows.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));

      const attributed =
        (sceneDraw?.ms ?? 0) + rows.reduce((a, r) => a + (typeof r.ms === "number" ? r.ms : 0), 0);
      const canvas = renderer.domElement;
      return {
        pixels: canvas ? [canvas.width, canvas.height] : null,
        postprocess: post ? post.entity?.name ?? "(postprocess)" : null,
        // THE HEADLINE: the scene draw, measured rather than derived by
        // subtracting GI and a postprocess-off A/B from the frame total.
        sceneDrawMs: sceneDraw?.ms ?? null,
        ...(sceneDraw?.error ? { sceneDrawError: sceneDraw.error } : {}),
        // The whole pipeline for one frame — scene draw, every effect, the
        // output transform. Compare against `attributedMs`: a large residual
        // means real cost lives somewhere this walk did not reach.
        frameTotalMs,
        attributedMs: +attributed.toFixed(3),
        unattributedMs: frameTotalMs != null ? +(frameTotalMs - attributed).toFixed(3) : null,
        passes: rows,
        // Kept in the output on purpose: an empty `passes` list is otherwise
        // indistinguishable from "the frame has no effects", and this says
        // immediately whether the compiler handed over any effects at all.
        effectsFound: collected.length,
        note:
          "`sceneDrawMs` is the main scene render (PassNode) — on a GI scene it is the frame's biggest " +
          "item because the GI irradiance gather is compiled INTO every lit material's fragment shader, " +
          "which no compute profiler can see. Each row in `passes` is one effect's `updateBefore` at the " +
          "real viewport size. Add this to profile.giPasses for the whole frame.",
      };
    } finally {
      nodeFrame.renderer = previousFrameRenderer;
      engine.renderSuspended = wasSuspended;
    }
  },
});

defineOp({
  name: "profile.frameStats",
  readOnly: true,
  description:
    "Live frame-rate and renderer counters — the same numbers the viewport's Stats overlay shows. `fps` counts frames the renderer actually PRESENTED over a one-second window; ticks that ran but skipped the draw (a GI compile wave, a renderer resize) are reported separately as `skippedFps`, and an idle viewport the editor has suspended reports 0 for both. `frameMs` is the interval between frames and `idleMs` the part of it the loop spent waiting (vsync, the browser's frame callback, the editor's frame limiter), so cpuMs + idleMs ≈ frameMs and a frame far longer than its work reads as paced rather than slow. Three fields SPLIT that wait, and the first suspect is `viewportFreezeWhenUnfocused`: with it on, an editor whose focus is in another panel stops drawing entirely, which reads as a huge idle and is power saved rather than time lost — measured on Sponza, 34 fps / 70% idle frozen against 65 fps / 19% idle with it off, at identical work. `frameLimitFps` names an explicit cap when the editor has set one. `callbackFps` counts callbacks that reached the tick, before the limiter could turn one away — but note it CANNOT see a stopped loop, since a frozen viewport receives no callbacks at all, so a low `callbackFps` means 'we were not running', not 'the browser was not asking'. Only once all three are ruled out is the wait the display's, the compositor's, or an occluded window's. Use this to check whether a change actually made the editor faster. `culling.view` is the overlay's de-duplicated frustum + occlusion total and retains both breakdowns; `culling.occlusion.occluders` is 0 when no object in the scene is large enough to be an occluder.",
  params: {
    settleMs: {
      type: "number",
      default: 1100,
      description:
        "How long to let the frame window fill before reading, in ms. The window is one second, so anything below ~1000 reports a partial count. 0 reads immediately. Max 10000.",
    },
  },
  async run({ settleMs = 1100 }) {
    const stats = engine?.stats;
    if (!stats) throw new Error("No engine.");
    const wait = Math.max(0, Math.min(10_000, Math.round(settleMs)));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // sample() recounts against the clock. Reading `readout` directly would
    // report whatever the last tick left behind — which for a suspended
    // viewport is a stale frame rate for a canvas that is not drawing.
    const r = stats.sample();
    const drawing = r.fps > 0;
    const viewCulling = collectViewCullingStats(engine);
    return {
      fps: Math.round(r.fps),
      skippedFps: Math.round(r.skippedFps),
      // Offered vs drawn. See the description: this is the one number that
      // says whether the idle is the app's choice or the browser's.
      callbackFps: Math.round(r.callbackFps || 0),
      frameLimitFps: engine.frameRateLimit || 0,
      // The first thing to check against a big idleMs: an unfocused viewport
      // that has been told to stop drawing is the commonest cause by far.
      viewportFreezeWhenUnfocused: isViewportFreezeEnabled(),
      // The pacer's last decision and inputs — which of them kept an
      // unfocused viewport drawing (a hold, a pin, a settling change).
      viewportPacing: getEditorFramePacingState(),
      cpuMs: +(r.workMs || r.frameMs).toFixed(2),
      // The whole frame interval and the part of it the loop did NOT execute
      // (vsync, the browser's frame callback, the editor's frame limiter).
      // `cpuMs` alone cannot answer "why is the frame 29 ms when the work is
      // 9 ms" — idleMs is that answer, and a high one means paced or
      // presentation-bound, not CPU-bound.
      frameMs: +(r.frameMs || 0).toFixed(2),
      idleMs: +Math.max((r.frameMs || 0) - (r.workMs || r.frameMs || 0), 0).toFixed(2),
      gpuMs: +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2),
      gpuMsIsReal: r.gpuMs > 0,
      // §18: the frame's GPU time split — render (scene draw, GI prepass,
      // shadows, post) vs compute (every GI chain). Read these DURING camera
      // motion: the per-pass profiler cannot see a moving frame's dispatch set.
      gpuRenderMs: +(r.gpuRenderMs ?? 0).toFixed(2),
      gpuComputeMs: +(r.gpuComputeMs ?? 0).toFixed(2),
      renderScale: +r.renderScale.toFixed(3),
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      textureMemMB: +(r.textureMem / 1048576).toFixed(1),
      jsHeapMB: r.jsHeapBytes == null ? null : +(r.jsHeapBytes / 1048576).toFixed(1),
      playing: !!engine.playing,
      // The three view-culling systems, because "occluded 0" and "occluded 0 of
      // 0" are completely different reports and the Stats overlay shows neither
      // when the count is zero. `occluders` is the one that actually diagnoses
      // it: a scene with occlusion on and ZERO occluders never even runs the
      // depth pass, so nothing downstream can cull anything.
      culling: {
        // The overlay's "Occluded" value: an identity union of frustum and
        // occlusion decisions. Keep the breakdown and overlap so the union is
        // auditable instead of hiding double counting in one aggregate.
        view: viewCulling,
        occlusion: engine.occlusion?.stats ?? null,
        lodHidden: [...engine.entities.values()].filter((e) => e._lodHidden === true).length,
      },
      // §18 W3 — the frame-rate floor's own state. Without this, a scene that
      // is holding 60 fps and a scene that is holding 60 fps BY SPENDING GI
      // RESOLUTION look identical from the outside, which is the one thing this
      // controller must never be allowed to hide. `scale` 1 means it has not
      // spent anything; `lastReason` says what it reacted to.
      governor: engine.frameGovernor?.stats ?? null,
      // Shadow freezing is routinely the single biggest draw-call lever in the
      // frame (a shadow map is a full extra submission of every caster, and it
      // is NOT reduced by view frustum culling), and it had no receipt at all
      // until a CSM scene was found re-rendering 842 of its 1144 draws every
      // frame on a parked camera. `managed` 0 on a shadowed scene means the
      // system cannot see the maps; `frozen` 0 while `managed` > 0 on a still
      // scene means it sees them and something keeps invalidating them.
      // The two GPU passes that dominate a GI frame (bvhReflect ~26 ms +
      // bvhHitShade ~26 ms of ~52 ms on Bistro at ultra). Both are HELD while
      // the g-buffer key is unchanged — the trace exactly, the shade on a
      // cadence. A non-zero count here is the only way to tell "the view is
      // held and the GPU is idle" from "the gate never engaged".
      giHold: {
        gtaoHeld: engine.modules?.get?.("gi")?.system?._gtaoHeld ?? false,
        gtaoHeldFrames: engine.modules?.get?.("gi")?.system?._gtaoHeldFrames ?? 0,
        computeSubmissions: engine.renderer?.backend?.__giComputeSubmitStats ?? null,
        // §11.56: renderer.compute() CALLS vs nodes — built kernels go to
        // three as one array (one pass, one timestamp pair) so `nodes/calls`
        // is the pass-boundary saving; `singles` are unbuilt/pending nodes.
        computeGroups: globalThis.__giComputeGroupStats ?? null,
        reflectHeldFrames: engine.modules?.get?.("gi")?.system?._bvhReflectHeldFrames ?? null,
        hitShadeHeldFrames: engine.modules?.get?.("gi")?.system?._bvhHitShadeHeldFrames ?? null,
        // §17 R7c's reflection history weight. ~0.9 means the reflection is a
        // ~10-frame exponential smear = "a stale image lagging behind"; near 0
        // means it is passing raw and R7c is doing its job. `atMotion` is
        // peak-held from a frame the camera was ACTUALLY moving, because the
        // motion EMA decays long before any reader can sample it.
        hitHistWeight: engine.modules?.get?.("gi")?.system?._giBvhHitHistWeightU?.value ?? null,
        hitHistWeightAtMotion: engine.modules?.get?.("gi")?.system?._giHitWeightAtMotion ?? null,
        camMotionEma: engine.modules?.get?.("gi")?.system?._giCamMotionEma ?? null,
        // Which field-hash section changed, counted over the last 120 frames:
        // a non-zero `fieldQuietFrames` needs none of these to be ticking.
        quietBreakers: engine.modules?.get?.("gi")?.system?._quietBreakers ?? null,
        gbufferHeldFrames: engine.modules?.get?.("gi")?.system?._gbufferHeldFrames ?? null,
        staticHeldFrames: engine.modules?.get?.("gi")?.system?._gbufStaticHeldFrames ?? null,
        moverOnlyFrames: engine.modules?.get?.("gi")?.system?._moverOnlyFrames ?? null,
        worldHz: engine.modules?.get?.("gi")?.system?._srcWorldHzLive ?? null,
        worldRested: engine.modules?.get?.("gi")?.system?._srcWorldRested ?? null,
        // §11.34 converged idle: the world chain is asleep (zero dispatch)
        // while `worldIdle` is true; `worldIdleReason` names the condition
        // holding it awake otherwise ("2 of 3 lights movable", "not rested",
        // "resting 1.2 s of 3", "inputs changed").
        worldIdle: engine.modules?.get?.("gi")?.system?._worldIdle ?? null,
        worldIdleFrames: engine.modules?.get?.("gi")?.system?._worldIdleFrames ?? null,
        worldIdleReason: engine.modules?.get?.("gi")?.system?._worldIdleReason ?? null,
        // §11.36: true on frames where the camera is moving but the world
        // chain stayed at the rest cadence because every light is static.
        worldMotionRest: engine.modules?.get?.("gi")?.system?._srcWorldMotionRest ?? null,
        worldStaggered: engine.modules?.get?.("gi")?.system?._srcWorldStaggerCount ?? null,
        // §11.45: true while the world chain dispatches in two halves — then
        // a "world dispatch" is a SEGMENT, and two of them are one chain.
        worldSplit: engine.modules?.get?.("gi")?.system?._srcWorldSplitOn ?? null,
        // §11.44: what the per-frame light-tree refresh saw change (cumulative) and how often it invalidated the visibility cache.
        lightTreeChanges: engine.modules?.get?.("gi")?.system?._lightTreeChangeTally ?? null,
        // §11.36: the compute passes the previous frame actually dispatched,
        // counted by name — multiply by profile.giPasses' per-pass ms for the
        // moving frame's composition.
        dispatchedLastFrame: (() => {
          const log = engine.modules?.get?.("gi")?.system?._giDispatchedLastFrame;
          if (!Array.isArray(log)) return null;
          const byName = {};
          for (const name of log) byName[name] = (byName[name] ?? 0) + 1;
          return { count: log.length, byName };
        })(),
        // The transport's rest-drive terms (max of these is the drive; < 0.05
        // rests): light motion α, the tracking window, the camera term, the
        // boot hold, the light-surprise term. Rounded to 2 decimals.
        restTerms: (() => {
          const t = globalThis.__giSrcRestTermsLive;
          if (!t) return null;
          const out = {};
          for (const [k, v] of Object.entries(t)) out[k] = Number.isFinite(v) ? +v.toFixed(2) : v;
          return out;
        })(),
        // 1 = the emitter shadow pass marches a checkerboard this frame (half
        // the pixels), 0 = full-pixel (movers-only frames), null = no chain.
        emitterChecker: engine.modules?.get?.("gi")?.system?._giEmitterCheckerU?.value ?? null,
        // ⚠ THE TWO ABOVE DESCRIBE DECISIONS; THESE DESCRIBE DISPATCHES.
        // `hitShadeHeldFrames` counts only the frames the HELD-VIEW cadence
        // chose to skip — it reported 0 ("healthy") on every frame the idle
        // sleep had already dropped the pass from the queue entirely, which is
        // how a reflection re-shading once every 30 frames went unnoticed for
        // sessions. `hitShadeGapFrames` asks the submitted queue instead, and
        // `hitShadeGapMax` is the WORST gap seen — deliberately a maximum, not
        // the peak-held best case that misled the same investigation twice.
        hitShadeGapFrames: engine.modules?.get?.("gi")?.system?._bvhHitShadeGapFrames ?? null,
        hitShadeGapMax: engine.modules?.get?.("gi")?.system?._bvhHitShadeGapMax ?? null,
        // The idle gate's inputs. `#fieldInputHash` has NO camera term, so
        // `fieldQuietFrames` climbs straight through a camera orbit; past
        // GI_IDLE_AFTER_FRAMES (180) the queue is replaced by a reduced list.
        // A high count here WITH the camera moving is the signature to watch.
        fieldQuietFrames: engine.modules?.get?.("gi")?.system?._fieldQuietFramesSeen ?? null,
      },
      // §18 THE LADDER's live census (GISystem.reflectTierCensus). Counted at
      // READ time, not build time, because the per-channel roughness floors it
      // reads land asynchronously off the GPU — the build-time tally reported
      // "0 sharp" for a scene full of mirrors purely because it asked too
      // early. `pendingMaterials` is how much of the medium column is still
      // "ask again later"; `coarseTriangleShare` is the budget a per-tier trace
      // stride can reclaim at zero visual cost (those materials' roughness
      // floor is above 0.45, where the exact reflection's weight is 0).
      giTiers: engine.modules?.get?.("gi")?.system?.reflectTierCensus?.() ?? null,
      // §18's masked-mode gate (armed by `__giMaskCoverageProbe`). `pct` is the
      // share of gbuffer texels carrying geometry; it must be IDENTICAL with
      // the mask on and off. Reported here as well as logged because a console
      // line can scroll past and a null result must be distinguishable from a
      // result of zero — this is the rig that decides whether a four-times-
      // reverted feature ships.
      giMaskCoverage: engine.modules?.get?.("gi")?.system?._maskCoverage ?? null,
      // §18.13 colour probe. `wait` climbing proves the tick reaches the probe
      // at all — distinguishing "the readback failed" from "the code never
      // ran", which a silent console cannot.
      // §18.15 — WHICH FOUR EMITTERS THE ANALYTIC PATH IS USING. The exact-
      // reflection hit shading lights the WHOLE scene from the four global
      // emitter seats (a hit is a different world point than the pixel, so it
      // cannot use the per-pixel tile cut), and on a 116-emitter scene nothing
      // said which four those are. The term probe measured the reflected
      // radiance as x2.99 green with an emitted-power aggregate of only x1.42,
      // so the seats' own chroma is the question — and `radius` answers the
      // other half: a seat fitted to a whole mesh of scattered bulbs is a
      // metres-wide sphere whose solid angle is orders of magnitude too large.
      giEmitterSeats: (() => {
        const slots = engine.modules?.get?.("gi")?.system?.state?.emitterSlots;
        if (!Array.isArray(slots)) return null;
        return slots.map((s, i) => {
          const c = s.color?.value;
          const r = c?.r ?? 0, g = c?.g ?? 0, b = c?.b ?? 0;
          return {
            slot: i,
            rgb: [Number(r.toFixed(3)), Number(g.toFixed(3)), Number(b.toFixed(3))],
            green: Number((g / Math.max(1e-6, (r + b) / 2)).toFixed(2)),
            radius: Number((s.radius?.value ?? 0).toFixed(3)),
            reff: Number((s.reff?.value ?? 0).toFixed(3)),
          };
        });
      })(),
      // Who asked for each GI rebuild and when — the answer to "gi reloads
      // for no reason". `asks` counts requests (several can coalesce into one
      // run), `runs` counts executions, and the log names the last twelve with
      // their age. A `resolve-resize` entry carries giCostScale, so a governor
      // rung change is distinguishable from a window resize at a glance.
      giRebuilds: (() => {
        const system = engine.modules?.get?.("gi")?.system;
        if (!system) return null;
        const now = performance.now();
        return {
          runs: system.rebuilds ?? 0,
          asks: system.rebuildAsks ?? 0,
          log: (system.rebuildLog ?? []).map((e) => ({
            reason: e.reason,
            secondsAgo: Math.round((now - e.at) / 1000),
          })),
        };
      })(),
      giColourProbe: {
        wait: engine.modules?.get?.("gi")?.system?._colourProbeWait ?? null,
        done: engine.modules?.get?.("gi")?.system?._colourProbeDone ?? null,
        result: engine.modules?.get?.("gi")?.system?._colourProbeResult ?? null,
      },
      // Why the main pass still submits what it does. `undersizedAfterSplit` is
      // the locality split dicing groups below MIN_GROUP_SIZE; `rejects` names
      // the gate that ate the rest. Without this the answer lives only in a
      // change-gated console line from whenever the last rebuild happened.
      merging: engine.merging?.lastReport ?? null,
      shadows: {
        managed: engine.shadowFreeze?.managedLights ?? 0,
        frozen: engine.shadowFreeze?.frozenLights ?? 0,
        // `frozen: 0` has at least four different causes and used to look the
        // same for all of them. This names the one in force.
        freezeReason: engine.shadowFreeze?.reason ?? null,
        // Depth-only merging of the casters themselves (shadowMerge.js).
        // `replaced` is the number of individual meshes the cascades no longer
        // submit; `proxies` is what they submit instead. A `frozen` cascade
        // costs nothing either way — these are the numbers that matter once the
        // camera MOVES and the maps correctly redraw.
        mergedProxies: engine.shadowMerge?.stats?.proxies ?? 0,
        mergedReplaced: engine.shadowMerge?.stats?.replaced ?? 0,
        // How many times the merge has been thrown away and rebuilt this
        // session, and what asked for the last one. On a settled scene this
        // should stop moving; if it keeps climbing, every shadow map is being
        // un-frozen with it (the proxies' object ids are in the freeze's
        // fingerprint) and every rebuild re-copies the merged vertices.
        mergedRebuilds: engine.shadowMerge?.rebuilds ?? 0,
        mergedRebuiltBy: engine.shadowMerge?.lastRebuildReason ?? null,
        // ⭐ TRIANGLES AS BAKED, BEFORE ANY FRUSTUM CULL. The per-pass triangle
        // count in `profile.drawCalls` is post-culling, so it moves with proxy
        // GRANULARITY as well as with content — which makes it useless for
        // answering "did the merge capture the whole scene". This one does not
        // move with the camera, so a cold-boot value below the settled value is
        // the merge having baked less than the scene contains.
        mergedTriangles: engine.shadowMerge?.stats?.triangles ?? 0,
        // The same sum taken from the members' CURRENT geometry, not the bake.
        // `mergedTriangles` is what the proxies froze at build time; this is
        // what they would contain if rebuilt right now. Divergence = a missed
        // invalidation (the watcher has a gap); equal-but-low = the members
        // themselves were coarse at build time and the deficit is upstream.
        mergedMemberTrianglesNow: (() => {
          let t = 0;
          for (const g of engine.shadowMerge?.groups ?? []) {
            for (const m of g.members ?? []) {
              const geo = m.geometry;
              t += (geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0) / 3;
            }
          }
          return Math.round(t);
        })(),
        // Member composition: shadowMerge's caster set includes merging.js's
        // COLOUR proxies, and those carry most of the scene's triangles. If the
        // boot-final member set holds fewer of them than a later rebuild does,
        // the deficit is an ordering problem between the two merges, not a
        // geometry-staleness problem.
        mergedBatchProxyMembers: (() => {
          let count = 0;
          let tris = 0;
          for (const g of engine.shadowMerge?.groups ?? []) {
            for (const m of g.members ?? []) {
              if (!/^Merged\(/.test(m?.name ?? "")) continue;
              count++;
              const geo = m.geometry;
              tris += (geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0) / 3;
            }
          }
          return { count, tris: Math.round(tris) };
        })(),
        // §18 G1 — the same proxies standing in for GI's g-buffer prepass. A
        // healthy `mergedProxies` beside a zero here means the merge is working
        // and the prepass is getting none of it (geometry without normals),
        // which is otherwise invisible.
        gbufferProxies: engine.shadowMerge?.stats?.gbufferProxies ?? 0,
        gbufferReplaced: engine.shadowMerge?.stats?.gbufferReplaced ?? 0,
        // What the prepass DID with them last frame. `used: 0` beside a healthy
        // `gbufferProxies` means every group was refused, and the two `parked*`
        // counters say by which rule.
        gbufferSwap: engine.modules?.get?.("gi")?.system?._gbufProxyStats ?? null,
        // Clipmap suns: whether each level HELD its raster or redrew it, and how
        // the shared cache classified casters. `movingCasters` counts what every
        // level redraws on every frame the level renders at all.
        clipmap: [...(engine.clipmapShadowNodes ?? [])].map((node) => ({
          levels: node.levels,
          cache: { ...node.cache?.stats },
          perLevel: (node._shadowNodes ?? []).map((level) => ({ ...level.stats })),
        })),
      },
      note: drawing
        ? r.skippedFps > 0
          ? `Drawing ${Math.round(r.fps)} frames/s and skipping ${Math.round(r.skippedFps)} — something is suspending the render mid-wave.`
          : "Rendering normally."
        : r.skippedFps > 0
          ? "The loop is running and presenting NOTHING — rendering is suspended (a GI compile wave or a renderer resize). The viewport is frozen on its last image."
          : "The render loop is stopped: the editor suspends an unfocused viewport, so this is expected unless the viewport is the focused panel.",
    };
  },
});

defineOp({
  name: "profile.drawCalls",
  readOnly: true,
  description:
    "Draw-call breakdown: every submission of one real frame, attributed to its render pass, its object and its material. Use this instead of guessing why a scene submits too much — it separates the main opaque pass from shadow cascades, depth prepasses and post-render overlays, names the material behind each draw, and reports the floor each pass would reach if every draw sharing a pipeline state were merged. Its total is legitimately higher than the stats overlay's, which stops counting before the post-render passes.",
  params: {
    frames: {
      type: "number",
      default: 1,
      description: "Frames to capture. More than one distinguishes a steady frame from a one-off bake. Max 10.",
    },
  },
  async run({ frames = 1 }) {
    if (!engine) throw new Error("No engine.");
    return auditDrawCalls(engine, { frames });
  },
});

defineOp({
  name: "profile.textures",
  readOnly: true,
  description:
    "Every texture the renderer is holding, with its real byte size, sorted biggest first — the breakdown behind the Stats overlay's single 'Textures' number. Use it when texture memory is higher than the scene seems to justify: it separates SOURCE art (a mesh's colour/normal/ORM maps) from RENDER TARGETS (GI buffers, post chain, shadow maps), reports which source maps are still uncompressed, and flags textures the renderer still holds that no material in the open scene references any more — the signature of an asset cache retaining GPU memory after its models were deleted.",
  params: {
    limit: {
      type: "number",
      default: 20,
      description: "How many of the largest textures to list individually. Max 200.",
    },
  },
  async run({ limit = 20 }) {
    if (!engine?.renderer) throw new Error("No engine.");
    const info = engine.renderer.info;
    // three tracks byte size per texture in `info.memoryMap` (Info.createTexture
    // / destroyTexture). It is a real Map, so the aggregate the overlay shows
    // can be itemised rather than guessed at — which is the whole point here:
    // "textures are 543 MB" and "543 MB of WHAT" are different questions and
    // only the second one is actionable.
    const map = info.memoryMap;
    if (!map || typeof map.entries !== "function") {
      return { error: "This three build does not expose info.memoryMap; upgrade or read info.memory only." };
    }

    // What the OPEN SCENE actually references. Anything tracked but absent from
    // this set is memory the renderer is holding for nobody.
    const referenced = new Set();
    const TEX_KEYS = [
      "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap",
      "bumpMap", "displacementMap", "lightMap", "envMap", "specularMap", "clearcoatMap",
      "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap",
      "transmissionMap", "thicknessMap", "iridescenceMap", "anisotropyMap", "specularColorMap",
      "specularIntensityMap",
    ];
    const noteMaterial = (m) => {
      if (!m) return;
      for (const k of TEX_KEYS) if (m[k]) referenced.add(m[k]);
      // Node materials hang textures off arbitrary node properties, so the
      // fixed key list above under-counts them. Catch the common ones.
      for (const v of Object.values(m)) {
        if (v && v.isTexture) referenced.add(v);
        else if (v && v.isNode && v.value?.isTexture) referenced.add(v.value);
      }
    };
    engine.scene?.traverse?.((o) => {
      const m = o.material;
      if (Array.isArray(m)) m.forEach(noteMaterial);
      else noteMaterial(m);
    });
    if (engine.scene?.background?.isTexture) referenced.add(engine.scene.background);
    if (engine.scene?.environment?.isTexture) referenced.add(engine.scene.environment);

    // ⚠⚠ THREE COUNTS A COMPRESSED TEXTURE AS **ONE BYTE**.
    // `Info._getTextureMemorySize`: `if (texture.isCompressedTexture) return 1;`
    // — "fallback estimate since exact format decompressed isn't readily
    // available without format maps". So `info.memory.texturesSize`, and the
    // Stats overlay's Textures figure with it, does not merely undercount
    // compressed art: it counts it as nothing. Compressing a project therefore
    // makes that number fall by the FULL uncompressed size, which looks like a
    // bigger win than it is, while the same number can never show what the
    // compressed set actually costs. This op estimates it properly instead.
    const BYTES_PER_PIXEL = {
      33776: 0.5, 33777: 0.5,          // S3TC DXT1 (BC1)
      33778: 1, 33779: 1,              // S3TC DXT3/DXT5 (BC2/BC3)
      36196: 0.5, 37492: 0.5,          // ETC1 / ETC2 RGB
      37496: 1,                        // ETC2 EAC RGBA
      36492: 1, 36495: 1,              // BPTC (BC7) — what UASTC transcodes to on desktop
      37808: 1,                        // ASTC 4x4
    };
    const compressedBytes = (tex) => {
      const w = tex.image?.width ?? tex.mipmaps?.[0]?.width ?? 0;
      const h = tex.image?.height ?? tex.mipmaps?.[0]?.height ?? 0;
      if (!w || !h) return 0;
      // Default 1 B/px: BC7 is what our UASTC path lands on, and over-reporting
      // a BC1 map by 2× is a smaller lie than three's 1 byte.
      const bpp = BYTES_PER_PIXEL[tex.format] ?? 1;
      // A full mip chain adds a third; `generateMipmaps` is irrelevant here
      // because KTX2 carries its own levels.
      const mips = (tex.mipmaps?.length ?? 0) > 1 ? 4 / 3 : 1;
      return w * h * bpp * mips;
    };

    const rows = [];
    let total = 0;
    let threeReported = 0;
    const bucket = { renderTarget: 0, compressed: 0, uncompressed: 0, unreferenced: 0 };
    const count = { renderTarget: 0, compressed: 0, uncompressed: 0, unreferenced: 0 };
    for (const [tex, size] of map.entries()) {
      // memoryMap ALSO holds BufferAttributes, whose value is `{size, type}`
      // rather than a number. Filtering on isTexture is what keeps geometry out
      // of a texture report — without it the row count runs an order of
      // magnitude high and every extra row carries a null size.
      if (!tex?.isTexture) continue;
      const reported = typeof size === "number" ? size : 0;
      threeReported += reported;
      const bytes = tex.isCompressedTexture ? compressedBytes(tex) : reported;
      total += bytes;
      const isTarget = !!(tex.isRenderTargetTexture || tex.isDepthTexture || tex.__isRenderTarget);
      const isCompressed = !!tex.isCompressedTexture;
      const kind = isTarget ? "renderTarget" : isCompressed ? "compressed" : "uncompressed";
      bucket[kind] += bytes;
      count[kind]++;
      // A render target is never "referenced by a material" and must not be
      // reported as a leak — only source art can be orphaned this way.
      const orphan = !isTarget && !referenced.has(tex);
      if (orphan) { bucket.unreferenced += bytes; count.unreferenced++; }
      rows.push({
        name: tex.name || tex.userData?.path || tex.source?.data?.src?.slice?.(-60) || "(unnamed)",
        kind,
        mb: +(bytes / 1048576).toFixed(2),
        size: tex.image ? `${tex.image.width ?? "?"}x${tex.image.height ?? "?"}` : "?",
        orphan: orphan || undefined,
      });
    }
    rows.sort((a, b) => b.mb - a.mb);
    const mb = (b) => +(b / 1048576).toFixed(1);
    return {
      trackedTextures: count.renderTarget + count.compressed + count.uncompressed,
      trueTotalMB: mb(total),
      statsOverlayMB: mb(threeReported),
      byKind: {
        renderTargets: { count: count.renderTarget, mb: mb(bucket.renderTarget) },
        compressedSource: { count: count.compressed, mb: mb(bucket.compressed) },
        uncompressedSource: { count: count.uncompressed, mb: mb(bucket.uncompressed) },
      },
      notReferencedByOpenScene: { count: count.unreferenced, mb: mb(bucket.unreferenced) },
      largest: rows.slice(0, Math.max(1, Math.min(200, Math.round(limit)))),
      note:
        "`statsOverlayMB` is what the Stats overlay shows and it counts every COMPRESSED texture as 1 byte " +
        "(three's own fallback), so it understates a compressed project badly; `trueTotalMB` estimates the real cost. " +
        "`uncompressedSource` is what compression can still take — expect 4x from it (RGBA8 -> BC7) or 8x (-> BC1), " +
        "set by FORMAT, never by how much the file shrank on disk. `renderTargets` is what compression can never take.",
    };
  },
});

defineOp({
  name: "profile.cpuFrame",
  readOnly: true,
  description:
    "Where the CPU half of the frame goes, broken down by engine-tick phase and measured with real wall-clock marks inside Engine.#tick. The counterpart to profile.giPasses and profile.renderPasses, which only see GPU work: when `profile.frameStats` reports cpuMs well above gpuMs the frame is CPU-bound and NO renderer setting can fix it, so use this to find which phase owns the time before touching a shader, a quality preset or a draw count. Reports the mean ms per frame over a multi-frame capture, plus the same frame's gpuMs and draw count so the two halves can be compared directly. `renderEncode` is WebGPU command encoding — high there means too many draw submissions, not expensive pixels.",
  params: {
    attribute: {
      type: "boolean",
      default: true,
      description:
        "Also charge every per-frame callback to its owner — the component (with its entity), the module, or the script file — and return them as `owners`, mean ms per frame, costliest first. This is the 'which component / script costs what' answer; the phases say which engine stage. ⚠ AND READ `dispatches` BESIDE `ms`: a component that hands the GPU work costs almost no main-thread time, so milliseconds alone call it free. A cloth solver measures 0.008 ms of CPU and then issues three hundred compute dispatches a frame; the frame waits for those, and the wait shows up as idle with no owner. `dispatchesUnowned` counts compute issued with no per-frame callback on the stack.",
    },
    frames: {
      type: "number",
      default: 60,
      description:
        "Frames to average over. One tick is not a measurement on a scene with GC pauses. Max 600.",
    },
  },
  async run({ frames = 60, attribute = true }) {
    const stats = engine?.stats;
    if (!stats) throw new Error("No engine.");
    const want = Math.max(1, Math.min(600, Math.round(frames)));
    stats.beginPhaseCapture(want, { attribute });
    // Wait for the capture to fill rather than for a fixed duration: on a 10
    // fps scene a 1 s wait would collect six frames and report the mean of a
    // sample too small to separate a GC pause from a phase. Capped so a
    // suspended viewport (which ticks but may not reach every phase) cannot
    // hang the call.
    const deadline = Date.now() + 20_000;
    while (!stats.phaseCaptureComplete() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const capture = stats.readPhaseCapture();
    const r = stats.sample();
    const cpuMs = +(r.workMs || r.frameMs).toFixed(2);
    const gpuMs = +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2);
    const top = capture.phases[0];
    return {
      ...capture,
      // The comparison that decides whether any of this matters. A frame with
      // cpuMs >> gpuMs cannot be fixed by lowering quality, and that is the
      // single most expensive misdiagnosis available on this engine.
      cpuMs,
      gpuMs,
      gpuMsIsReal: r.gpuMs > 0,
      bound: cpuMs > gpuMs * 1.25 ? "cpu" : gpuMs > cpuMs * 1.25 ? "gpu" : "balanced",
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      jsHeapMB: r.jsHeapBytes == null ? null : +(r.jsHeapBytes / 1048576).toFixed(1),
      note:
        (capture.complete
          ? `Averaged ${capture.frames} frames. `
          : `INCOMPLETE — only ${capture.frames} frames in 20 s; the loop is stalled or suspended, and the means below are over what was collected. `) +
        (top ? `Costliest phase: ${top.name} at ${top.ms} ms (${top.pct}%). ` : "") +
        (capture.subPhases?.length
          ? `\`subPhases\` breaks a module's work out INSIDE its phase (gi.* sits inside preRender); it sums to less than its parent, and the shortfall is real unmarked time, not zero. Costliest: ${capture.subPhases[0].name} at ${capture.subPhases[0].ms} ms. `
          : "") +
        "`totalMs` is the sum of the phases and should track frameStats' cpuMs; a large gap means time is " +
        "going somewhere #tick does not mark (host-side work, or a GC pause landing between phases).",
    };
  },
});

defineOp({
  name: "profile.lightResponse",
  readOnly: true,
  description:
    "Measure how fast the GI FOLLOWS A LIGHT CHANGE: steps the scene's single directional light by `stepDeg` (about its parent's x, the way a day-cycle script does), records the GI irradiance as a 16x9 tile grid every frame, and reports how long the picture took to reach its new settled state (t50/t90, in frames and ms), whether the approach was monotone, and how big the change was. The sun is restored afterwards. THIS IS THE GATE THAT A STABILITY NUMBER CANNOT FAKE: a field that has stopped tracking the sun reads 0 flicker and never reaches t90. `changeOfBaseline` near 0 means the step did not reach the picture at all (blind); `fps` far below the viewport's means the GI tick was held and the field could not have advanced. Run profile.flicker and this together, always.",
  params: {
    stepDeg: { type: "number", default: 25, description: "How far to rotate the sun, in degrees (about its parent's x). 25 moves every shadow in a Sponza-class scene without turning the sun off." },
    seconds: { type: "number", default: 8, description: "How long to record after arming (max 20). The step lands after `warmupFrames`." },
    warmupFrames: { type: "number", default: 30, description: "Frames of baseline recorded before the step." },
  },
  async run({ stepDeg = 25, seconds = 8, warmupFrames = 30 }) {
    const sys = engine?.modules?.get?.("gi")?.system;
    if (!sys?.beginLightResponse) throw new Error("No GI system, or this build predates the light-response gate.");
    const secs = Math.max(1, Math.min(20, Number(seconds) || 8));
    const armed = sys.beginLightResponse({ stepDeg: Number(stepDeg) || 25, seconds: secs, warmupFrames: Math.max(1, Math.min(120, Math.round(warmupFrames))) });
    const deadline = Date.now() + secs * 1000 + 4000;
    while (!sys.lightResponseComplete() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const w = await sys.readLightResponse();
    if (w.targetSwapped) return { ...armed, ...w };
    return {
      ...armed,
      ...w,
      note:
        (w.changeOfBaseline < 0.02
          ? "WARNING: THE STEP DID NOT REACH THE PICTURE (settled vs baseline differ by <2%). Either the light did not move, or the GI does not carry it - t50/t90 mean nothing here. "
          : `The step changed the settled picture by ${(w.changeOfBaseline * 100).toFixed(0)}%. `) +
        (w.t90Frames < 0
          ? `WARNING: NEVER REACHED 90% of the way to settled within ${w.frames - w.stepAt} frames (final error ${(w.errFinal * 100).toFixed(1)}% vs err0 ${(w.err0 * 100).toFixed(1)}%). This is what "lighting does not update" looks like. `
          : `t50 ${w.t50Ms} ms, t90 ${w.t90Ms} ms after the step; ${(w.monotoneShare * 100).toFixed(0)}% of frames moved toward settled (100% = a clean ramp, <70% = an oscillating approach). `) +
        `${w.frames} frames at ${w.fps} fps - compare against profile.frameStats; a much lower number means the GI tick was held. ` +
        "`curve` is the distance from settled over the window, 24 points.",
    };
  },
});

defineOp({
  name: "profile.flicker",
  readOnly: true,
  description:
    "Measure GI FLICKER in the live session: arms a per-pixel accumulator over the GI irradiance target and, for a few seconds, counts how often each pixel's frame-to-frame luminance delta REVERSES SIGN, how big its biggest one-frame step was, and where on screen the churn is — with the field's own dials (alpha, stride root, screen history weight, camera-motion EMA, light-motion term, world update Hz) sampled on the same frames. Run it, then DO THE THING while it watches: walk, swing the camera into a new room, let the sun rotate. Reversals are the discriminator no magnitude statistic can replace — real light arriving, a sun setting or a wall being revealed all move a pixel MONOTONELY; only an estimator reverses. `stepP95OfMean` is the number to hold against the 'no pixel changes more than a few % per frame' bar. WARNING: absolute values are only comparable WITHIN one session (the same config has read a 3.7x spread across processes) — always compare two windows here, never one of these numbers against one in a document.",
  params: {
    seconds: {
      type: "number",
      default: 10,
      description: "How long to watch, in seconds (max 60). The call returns when the window closes.",
    },
    warmupFrames: {
      type: "number",
      default: 30,
      description:
        "Frames spent seeding each pixel's previous luminance before counting starts. Counting from frame zero scores the seed itself as one huge delta on every pixel. Rarely worth changing.",
    },
    stillOnly: {
      type: "boolean",
      default: true,
      description:
        "Count only frames where the CAMERA DID NOT MOVE (it still seeds through motion). This counter is screen-space, so while the camera moves a pixel sweeps across unrelated surfaces and reverses from PARALLAX — measured: an orbit puts 100% of pixels over the churn threshold on a field that is behaving. Leaving this on measures the thing people actually report: arrive somewhere, hold still, and watch how long the field keeps rearranging. Set it false to count every frame when comparing two builds under the SAME motion.",
    },
  },
  async run({ seconds = 10, warmupFrames = 30, stillOnly = true }) {
    const sys = engine?.modules?.get?.("gi")?.system;
    if (!sys?.beginFlickerWatch) {
      throw new Error("No GI system, or this build predates the flicker watch.");
    }
    const secs = Math.max(1, Math.min(60, Number(seconds) || 10));
    const armed = sys.beginFlickerWatch({
      seconds: secs,
      warmupFrames: Math.max(0, Math.min(120, Math.round(warmupFrames))),
      stillOnly: stillOnly !== false,
    });
    const deadline = Date.now() + secs * 1000 + 4000;
    while (!sys.flickerWatchComplete() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const watch = await sys.readFlickerWatch();
    if (watch.targetSwapped || watch.pipelinePending) return { ...armed, ...watch };
    const g = watch.signals ?? {};
    const dial = (name, v) => (v ? `${name} ${v.min}..${v.max}` : null);
    return {
      ...armed,
      ...watch,
      note:
        (watch.frames === 0
          ? (watch.movingFramesSkipped > 0
            ? "NO STILL FRAMES — the camera moved for the ENTIRE window, and stillOnly counts only frames where it did not. Hold still for part of the window, or pass stillOnly:false. "
            : "NO FRAMES COUNTED — the viewport was suspended for the whole window (unfocused with 'Freeze unfocused viewport' on, or a compile wave held the tick). Nothing here is a measurement. ")
          : `${watch.frames} counted frames of ${watch.fps} fps over ${watch.resolution}` +
            (watch.stillOnly ? ` (${watch.movingFramesSkipped} moving frames skipped — see stillOnly). ` : ". ") +
            `${(watch.movedShare * 100).toFixed(0)}% of pixels moved at all; ` +
            `${(watch.churnShare * 100).toFixed(1)}% reversed 3+ times (that share IS the boiling). ` +
            `Reversals per pixel per frame ${watch.reversalsPerFrame}. ` +
            `Biggest one-frame step ${watch.stepMaxOfMean}x the image mean, p95 ${watch.stepP95OfMean}x. `) +
        (watch.frames && watch.movedShare === 0
          ? "⚠ NOT ONE PIXEL MOVED. Either the scene really is frozen, or the accumulator's compute " +
            "pipeline never landed (an async compute that has not compiled is a silent no-op) — run it " +
            "again; the second window reuses nothing but the pipeline is warm by then. "
          : "") +
        "`tileReversalsPerFrame` is a 16x9 grid over the viewport (row 0 = top): it says WHERE. " +
        (watch.frames
          ? "Dials while it watched: " +
            [dial("alpha", g.alpha), dial("root", g.root), dial("histWeight", g.histWeight),
              dial("camMotion", g.cameraMotion), dial("lightMotion", g.lightMotion),
              dial("worldHz", g.worldHz)].filter(Boolean).join(", ") +
            ". `lightMotion` is in the light-track window's own threshold units (it arms at 0.5). "
          : "") +
        "COMPARE WINDOWS, NOT DOCUMENTS: this instrument's absolute scale does not survive a page reload.",
    };
  },
});

defineOp({
  name: "profile.spikeWatch",
  readOnly: true,
  description:
    "Watch for FRAME SPIKES for a few seconds and report the worst frames with their own phase breakdown — the instrument for 'it freezes / stutters while I do X', where a mean cannot help. Run it, then do the thing (drag an object, orbit, enter a room) while it watches: it returns the frames that crossed `thresholdMs`, each with the engine-tick phases and module sub-phases THAT frame spent its time in, plus how many frames it saw in total. profile.cpuFrame averages a capture, so a drag at 90 fps with one 300 ms hitch a second reports a healthy ~14 ms; this reports the hitch. `atSeconds` is the offset into the watch, so a spike can be matched to what you were doing when it happened.",
  params: {
    seconds: {
      type: "number",
      default: 8,
      description: "How long to watch, in seconds (max 30). The call returns when the window closes.",
    },
    thresholdMs: {
      type: "number",
      default: 40,
      description:
        "A frame at or above this many ms is kept whole. 40 ms = below 25 fps, the point a drag stops feeling continuous; lower it to ~25 to catch a scene that should be at 60.",
    },
    keep: {
      type: "number",
      default: 12,
      description: "How many of the worst frames to return (max 40).",
    },
  },
  async run({ seconds = 8, thresholdMs = 40, keep = 12 }) {
    const stats = engine?.stats;
    if (!stats?.beginSpikeWatch) throw new Error("No engine, or this build predates the spike watch.");
    const secs = Math.max(0.5, Math.min(30, Number(seconds) || 8));
    stats.beginSpikeWatch({
      seconds: secs,
      thresholdMs: Math.max(5, Number(thresholdMs) || 40),
      keep: Math.max(1, Math.min(40, Math.round(keep))),
    });
    const deadline = Date.now() + secs * 1000 + 2000;
    while (!stats.spikeWatchComplete() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const watch = stats.readSpikeWatch();
    const r = stats.sample();
    const worst = watch.spikes[0];
    return {
      ...watch,
      seconds: secs,
      fpsNow: Math.round(r.fps),
      note:
        (watch.frames === 0
          ? "NO FRAMES SEEN — the viewport was suspended for the whole window (unfocused with 'Freeze unfocused viewport' on, or a compile wave). Nothing here is a measurement. "
          : `${watch.spikeCount} of ${watch.frames} frames were at or above ${watch.thresholdMs} ms; the worst was ${watch.worstMs} ms. `) +
        (worst
          ? `Worst frame: ${worst.phases.map((p) => `${p.name} ${p.ms}ms`).slice(0, 3).join(", ")}` +
            (worst.subPhases?.length ? ` (inside it: ${worst.subPhases.slice(0, 3).map((p) => `${p.name} ${p.ms}ms`).join(", ")})` : "") + ". "
          : "No frame crossed the threshold — whatever the stutter is, it did not happen during this window, or it is not CPU-side. ") +
        "Phases that cost under 0.5 ms in a frame are omitted from that frame; sub-phases sum to LESS than their parent phase and the shortfall is unmarked time, not zero.",
    };
  },
});

/**
 * §11.36 — THE ORBIT: the one instrument that reads a MOVING frame on the
 * user's own scene. An MCP-driven orbit is a burst of jumps with the read
 * landing after the stop (the two arms of the first Bistro A/B orbited
 * different street segments and read nothing comparable). This spins the
 * editor camera from INSIDE the page, every frame, for `seconds`, and reads
 * the frame stats at the END of steady motion — with the world chain's real
 * dispatch rate counted over the window, which is the receipt the rest and
 * converged-motion cadences (§11.34, §11.36) need and `worldHz` (a target,
 * not a count) cannot give.
 */
defineOp({
  name: "profile.orbit",
  readOnly: true,
  description:
    "Orbit the editor camera around its target for a few seconds FROM INSIDE THE PAGE (every frame, not a burst of jumps) and read the frame during steady motion: fps, the GPU render/compute split, how many WORLD-chain dispatches per second actually happened, how many frames the converged-motion cadence held, and the transport's rest-drive terms. The camera is restored afterwards. Use it for every under-motion A/B on a real scene; a parked read cannot see a moving frame and an MCP-driven orbit cannot read one steadily.",
  params: {
    seconds: { type: "number", default: 6, description: "How long to orbit (max 20)." },
    degPerSec: { type: "number", default: 20, description: "Orbit rate about the target's vertical axis, degrees per second." },
    phases: {
      type: "boolean",
      default: false,
      description:
        "Also capture the CPU phase breakdown (profile.cpuFrame's `phases`/`subPhases`) OVER THE MOVING FRAMES, as `cpuPhases`. A parked cpuFrame cannot see what motion adds.",
    },
    spikes: {
      type: "boolean",
      default: false,
      description:
        "Also run profile.spikeWatch OVER THE MOVING FRAMES (threshold `spikeThresholdMs`), as `spikes` — the frames that froze while the camera moved, each with its phase breakdown. Implies `phases`.",
    },
    spikeThresholdMs: { type: "number", default: 40, description: "Spike threshold for `spikes`, in ms." },
  },
  async run({ seconds = 6, degPerSec = 20, phases = false, spikes = false, spikeThresholdMs = 40 }) {
    const viewport = getViewportHandle();
    if (!viewport?.camera) throw new Error("No viewport is open.");
    const stats = engine?.stats;
    if (!stats?.sample) throw new Error("No engine stats.");
    const sys = engine.modules?.get?.("gi")?.system ?? null;
    const secs = Math.max(1, Math.min(20, Number(seconds) || 6));
    const rate = Number(degPerSec) || 20;
    const cam = viewport.camera;
    const target = viewport.orbit?.target?.clone() ?? cam.position.clone().add(cam.getWorldDirection(new cam.position.constructor()).multiplyScalar(10));
    const start = cam.position.clone();
    const rel = start.clone().sub(target);
    let frames = 0;
    let worldDispatches = 0;
    let motionRestFrames = 0;
    let lastWorld = sys?._srcWorldLastDispatchFrame ?? null;
    const chains0 = sys?._srcWorldChains ?? 0;
    // Which GI passes actually dispatch while moving, per second — the
    // moving GPU budget is these rates times profile.giPasses' per-dispatch
    // ms, and a parked giPasses cannot see the cadence (held chains, the
    // reflection stride, the world rate) that motion sets.
    let lastLog = null;
    const tally = new Map();
    const groupOf = (name) => String(name).replace(/^src:/, "").replace(/#\d+$/, "");
    const t0 = performance.now();
    let cpuPhases = null;
    await new Promise((resolve) => {
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        // Arm the phase capture once the motion is steady (the first half
        // second is the EMA settling and the first world wake), and stop it
        // with the orbit so the means are over moving frames only.
        if ((phases || spikes) && cpuPhases === null && t >= 0.5 && stats.beginPhaseCapture) {
          // The spike watch IS a phase capture with a per-frame ledger on top,
          // so with `spikes` it serves both reads; its window closes with
          // the orbit.
          if (spikes && stats.beginSpikeWatch) {
            stats.beginSpikeWatch({ seconds: Math.max(0.5, secs - 0.5), thresholdMs: Math.max(5, Number(spikeThresholdMs) || 40), keep: 30 });
          } else {
            stats.beginPhaseCapture(100_000);
          }
          cpuPhases = false;
        }
        if (t >= secs) return resolve();
        const a = (rate * Math.PI / 180) * t;
        const c = Math.cos(a), s = Math.sin(a);
        cam.position.set(target.x + rel.x * c - rel.z * s, start.y, target.z + rel.x * s + rel.z * c);
        if (viewport.orbit) { viewport.orbit.target.copy(target); viewport.orbit.update(); }
        else cam.lookAt(target);
        frames++;
        const w = sys?._srcWorldLastDispatchFrame ?? null;
        if (w != null && w !== lastWorld) { worldDispatches++; lastWorld = w; }
        const log = sys?._giDispatchedLastFrame ?? null;
        if (Array.isArray(log) && log !== lastLog) {
          lastLog = log;
          for (const n of log) { const g = groupOf(n); tally.set(g, (tally.get(g) ?? 0) + 1); }
        }
        if (sys?._srcWorldMotionRest === true) motionRestFrames++;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const r = stats.sample();
    let spikeWatch = null;
    if (cpuPhases === false && stats.endPhaseCapture) {
      stats.endPhaseCapture();
      cpuPhases = stats.readPhaseCapture();
      if (spikes && stats.readSpikeWatch) spikeWatch = stats.readSpikeWatch();
    }
    const hold = sys ? {
      worldHz: sys._srcWorldHzLive ?? null,
      worldRested: sys._srcWorldRested ?? null,
      worldMotionRest: sys._srcWorldMotionRest ?? null,
      worldStaggered: sys._srcWorldStaggerCount ?? null,
      worldSplit: sys._srcWorldSplitOn ?? null,
      worldChainsPerSec: sys._srcWorldChains != null ? +(((sys._srcWorldChains - (chains0 ?? 0)) / secs).toFixed(1)) : null,
      restTerms: globalThis.__giSrcRestTermsLive ?? null,
    } : null;
    // Restore the view.
    cam.position.copy(start);
    if (viewport.orbit) { viewport.orbit.target.copy(target); viewport.orbit.update(); }
    else cam.lookAt(target);
    return {
      seconds: secs,
      degPerSec: rate,
      frames,
      fps: +(frames / secs).toFixed(1),
      fpsStats: Math.round(r.fps),
      gpuMs: +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2),
      gpuRenderMs: +(r.gpuRenderMs ?? 0).toFixed(2),
      gpuComputeMs: +(r.gpuComputeMs ?? 0).toFixed(2),
      cpuMs: +(r.workMs || r.frameMs).toFixed(2),
      worldDispatches,
      worldDispatchesPerSec: +(worldDispatches / secs).toFixed(1),
      motionRestFrames,
      ...hold,
      dispatchesPerSec: Object.fromEntries([...tally].sort((a, b) => b[1] - a[1]).map(([g, n]) => [g, +(n / secs).toFixed(1)])),
      ...(cpuPhases ? { cpuPhases } : {}),
      ...(spikeWatch ? { spikes: spikeWatch } : {}),
      note:
        "Read during steady motion (the EMA settles in ~0.5 s). `worldDispatchesPerSec` is the world chain's REAL rate over the window — 30 = every frame at 30 fps, ~15 = the rest cadence held under motion. `gpuComputeMs` is the GI chains; `gpuRenderMs` the raster.",
    };
  },
});

/**
 * §11.39 — WHICH SURFACES ARE WHITE, AND WHY. A reflection hit is coloured by
 * the per-slot palette (`resolveMaterialSurface`: constant colour × the map's
 * mean, the map found on `.map` or inside `colorNode`) unless the slot has an
 * atlas tile. A slot whose palette colour is near white is a white object in
 * every reflection that lands on it. This lists them with the material facts
 * that decide the colour, so "some meshes appear white in the reflections"
 * becomes a list of names and one cause each.
 */
defineOp({
  name: "profile.giSurfaces",
  readOnly: true,
  description:
    "List the GI surface slots whose palette colour (what a reflection hit and a bounce read for that mesh) is near WHITE, with the material facts behind each: map present, map compressed (its mean comes from the GPU averager and is white until it lands), colour node present and whether a constant colour or a texture could be read out of it. Also the palette's luma histogram. Use it for 'some meshes appear white in the reflections'.",
  params: {
    minLuma: { type: "number", default: 0.85, description: "Report slots whose palette colour luma is at or above this (linear)." },
    limit: { type: "number", default: 60, description: "Max rows." },
  },
  run({ minLuma = 0.85, limit = 60 } = {}) {
    const sys = engine.modules?.get?.("gi")?.system ?? null;
    const entries = sys?.state?.entries;
    if (!Array.isArray(entries)) throw new Error("No GI state entries (GI not built yet).");
    const hist = { "<0.2": 0, "0.2-0.5": 0, "0.5-0.85": 0, ">=0.85": 0 };
    const rows = [];
    const byMaterial = new Map();
    for (const e of entries) {
      const c = e?.surface?.color;
      if (!c) continue;
      const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      hist[luma < 0.2 ? "<0.2" : luma < 0.5 ? "0.2-0.5" : luma < 0.85 ? "0.5-0.85" : ">=0.85"]++;
      if (luma < minLuma) continue;
      const mesh = e.mesh;
      const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
      const map = material?.map ?? null;
      const graphTex = material?.colorNode ? textureValueOf(material.colorNode) : null;
      const tex = map ?? graphTex;
      const key = material?.uuid ?? "?";
      const row = byMaterial.get(key);
      if (row) { row.meshes++; continue; }
      byMaterial.set(key, {
        mesh: mesh?.name ?? "?",
        meshes: 1,
        material: material?.name || material?.type || "?",
        materialType: material?.type ?? "?",
        palette: { r: +c.r.toFixed(3), g: +c.g.toFixed(3), b: +c.b.toFixed(3), luma: +luma.toFixed(3) },
        classicColor: material?.color ? { r: +material.color.r.toFixed(3), g: +material.color.g.toFixed(3), b: +material.color.b.toFixed(3) } : null,
        hasMap: !!map,
        graphTexture: !!graphTex,
        textureName: tex?.name || tex?.source?.data?.src?.split?.("/")?.pop?.() || null,
        textureCompressed: !!tex?.isCompressedTexture,
        textureLoaded: !!(tex?.image && (tex.image.width > 0 || tex.isCompressedTexture)),
        colorNode: material?.colorNode ? (material.colorNode.nodeType ?? material.colorNode.constructor?.name ?? "node") : null,
        colorNodeConstant: material?.colorNode ? constantColorOf(material.colorNode) : null,
        emissive: e.surface?.emissive ? +(0.2126 * e.surface.emissive.r + 0.7152 * e.surface.emissive.g + 0.0722 * e.surface.emissive.b).toFixed(3) : 0,
        promoted: !!e.promoted,
      });
    }
    for (const row of byMaterial.values()) rows.push(row);
    rows.sort((a, b) => b.meshes - a.meshes);
    return {
      entries: entries.length,
      lumaHistogram: hist,
      whiteMaterials: rows.length,
      rows: rows.slice(0, Math.max(1, Math.min(200, Math.round(limit)))),
      note:
        "A row is one MATERIAL (meshes = how many entries share it). `palette` is what reflections/bounce read. Likely causes: a compressed map whose GPU mean never landed (textureCompressed true, palette white), a colour node whose texture/constant could not be read (colorNode set, graphTexture false, colorNodeConstant null), or a genuinely white material.",
    };
  },
});

// ---------------------------------------------------------------------------
// THE FREEZE LEDGER (docs/ZERO_FREEZE_PLAN.md, Stage 0)
//
// Every op above measures a FRAME. None of them can see the thing the user
// actually reports — the editor stopping dead for seconds while a shader
// compiles, a scene parses or a rebuild runs, because during a freeze there
// are no frames to profile. These three read the always-on ledger instead.
// ---------------------------------------------------------------------------

defineOp({
  name: "profile.freezes",
  readOnly: true,
  description:
    "Every main-thread BLOCK the editor has suffered this session, with an owner — the instrument for 'it freezes'. A freeze is a browser long task (the main thread stopped for 50 ms+), and the engine records what it was doing at the time, so each block reads as a name (`gi:rebuild/staticBvh`, `gpu:shaderModule`, `event:hierarchy-changed`, `scene:instantiate`) rather than a mystery. Unlike profile.spikeWatch this needs no window and no timing: the block that froze the editor a minute ago is still here. `byOwner` ranks the whole session; `worst` and `recent` are individual blocks with their attribution, the node-build `causes` that fired INSIDE that block, and any synchronous GPU-object creation in it. Read a block's own `causes` before the session-wide `nodeBuildCauses` — the largest cause of the session is often not the cause of the freeze the user felt. `nodeBuilds` counts every TSL graph build, and `nodeBuildCauses` says WHY each one happened — `first compile` is the unavoidable one-per-material build, `material key` is that material's own key forking, and `fog`, `lights`, `environment`, `shadowMap` or `context` mean a scene-wide input to three's cache key moved and RE-MINTED materials that were already compiled.",
  params: {
    limit: { type: "number", default: 20, description: "Rows per section (max 100)." },
    sinceMs: { type: "number", default: 0, description: "Only blocks this many ms after page load. 0 = the whole session." },
    clear: { type: "boolean", default: false, description: "Empty the ledger after reading, so the next read measures one action." },
  },
  run({ limit = 20, sinceMs = 0, clear = false }) {
    // `stalls` and each block's `gpuLoad`: a block with no engine span and no
    // GPU call in it is the main thread waiting on the GPU process, whose
    // command thread executes a SYNCHRONOUS pipeline creation in order — the
    // 21.5 s block of 2026-09-09. `wgsl`: whether the shader text this boot
    // created is byte-stable against the last boot (the disk cache's key).
    const report = freeze.read({
      limit: Math.max(1, Math.min(100, Math.round(limit))),
      sinceMs: Math.max(0, Number(sinceMs) || 0),
    });
    if (clear) freeze.clear();
    return {
      ...report,
      note: report.observing
        ? "`owners` are SELF time — a nested span's ms are not also charged to its parent. `(unattributed)` is real time in code nothing marks yet; a large one is a missing mark, not an absence of work. ⚠ `gpu` is NOT the block's own work — nothing resets those counters at the start of an ordinary task, so they cover everything SINCE THE PREVIOUS LONG TASK. `gpu.windowMs` is how long that was: DIVIDE BY IT before believing `writeBytes`/`writes`. A 60 ms block reading 484 MB in 123 097 write(s) was seven seconds of ordinary 60 fps rendering (~293 writes and ~1.15 MB a frame), not a catastrophic upload. The pipeline and shader-module counts carry the same caveat, but they are small numbers and a compile anywhere in the window is still what made the GPU process busy — which is what they are read for. That work never appears in a JS profile because the driver parses WGSL on the calling thread. In `nodeBuildCauses`, `first compile` and `material key` are work that had to happen; a named input (`lights`, `fog`, `environment`, `shadowMap`, `context`) is a WAVE — three keys its node-builder cache partly on that scene-wide state, so one of them moving re-mints every material in the scene at once."
        : "The long-task observer is NOT running (no PerformanceObserver, or `longtask` is unsupported here). Spans are still recorded, so profile.boot works, but nothing is attributing blocks.",
    };
  },
});

defineOp({
  name: "profile.flag",
  description:
    "DEV: set or read one engine A/B hatch — a `globalThis.__…` boolean/number/string such as `__asyncRenderPipelinesStandIn`, `__asyncRenderPipelinesBuildBudgetMs`, `__wgslCanonical`, `__ambientGlowFrameCopy`, `__lightCastShadowInPlace`, `__giBvhWorker`. Session-only (not persisted; profile.giFlag persists the `__gi…` ones). Omit `value` to read. Most hatches are read at the moment the work happens, so a flag set now governs the next edit/render; a few are read once at install (the header of the module that owns the hatch says which).",
  params: {
    name: { type: "string", required: true, description: "The global's name; must start with `__`." },
    value: { type: ["boolean", "number", "string", "null"], description: "The value to set; null deletes the flag; omit to read." },
  },
  run({ name, value }) {
    if (typeof name !== "string" || !name.startsWith("__")) throw new Error("profile.flag: `name` must be a `__…` global");
    if (value !== undefined) {
      if (value === null) delete globalThis[name];
      else globalThis[name] = value;
    }
    return { name, value: globalThis[name] ?? null };
  },
});

defineOp({
  name: "profile.wgsl",
  readOnly: true,
  description:
    "The shader text this boot handed the driver, module by module, scored against the PREVIOUS boot — the receipt for whether the browser's compiled-shader disk cache can serve a boot at all. Chromium keys that cache on the WGSL text, and three names unnamed storage buffers after a process-wide node id (`NodeBuffer_55143`), so the same graph produced different text every boot and the 80-second GI kernels compiled from scratch each time. The engine now canonicalises those names before `createShaderModule` (`__wgslCanonical = false` reverts). Without arguments: the module table (label, kB, raw/canonical hash, whether the last boot had the same text raw / canonically). With `index`: that module's canonical text, for diffing two boots when a module is still `stillUnstable` in profile.freezes.wgsl — pipe it to a file through the CLI bridge, it is tens of kB.",
  params: {
    index: { type: "number", description: "Return this module's text instead of the table." },
    limit: { type: "number", default: 200, description: "Rows of the table (max 1000)." },
  },
  run({ index, limit = 200 }) {
    const registry = freeze.wgsl;
    if (!registry) return { modules: 0, note: "No shader module has been created yet, or the GPU ledger is not installed on this renderer." };
    if (index !== undefined && index !== null) {
      const m = registry.module(Math.max(0, Math.round(Number(index))));
      if (!m) throw new Error(`profile.wgsl: no module at index ${index} (${registry.modules.length} recorded)`);
      return m.code === null ? { ...m, note: "text not kept — the session's kept-text budget was spent; hashes only" } : m;
    }
    return {
      summary: registry.summary(),
      modules: registry.list().slice(-Math.max(1, Math.min(1000, Math.round(limit)))),
      note: "`rawSeenLastBoot` is what the disk cache would have hit WITHOUT the rename, `canonSeenLastBoot` with it. A module unseen either way is text that still moves between boots: dump it with `index` on two boots and diff.",
    };
  },
});

defineOp({
  name: "profile.boot",
  readOnly: true,
  description:
    "Where this session's startup time went, stage by stage: project open, engine import, renderer init, scene parse, asset load, entity instantiation, the GI build and its sub-stages, the material compile wave. Also reports how much of it the main thread spent BLOCKED (from profile.freezes), which is the difference between a boot that is slow and a boot that is frozen. Read it after any change that claims to make startup faster.",
  params: {},
  run() {
    const boot = freeze.readBoot();
    return {
      ...boot,
      note: "`ms` is WALL time per stage (stages overlap with GPU work on purpose, so they do not sum to sinceLoadMs). `blocked` is the main-thread total from the freeze ledger — a stage that is slow but not blocked is the app waiting, which the user can live with; a blocked one is the app frozen.",
    };
  },
});

defineOp({
  name: "profile.edit",
  readOnly: true,
  description:
    "What ONE editor edit costs, listener by listener. Arms a capture, runs the action you name (or waits `seconds` while you do it by hand), then reports every engine event that fired and how many ms each of its listeners took. This is how to see that changing a light's intensity re-ran the scene mirror, the merge system and GI's fingerprint walk — the fan-out `hierarchy-changed` produces. Pair it with profile.freezes when the edit blocks rather than merely costs.",
  params: {
    seconds: { type: "number", default: 3, description: "How long to capture while you perform the edit (max 30)." },
  },
  async run({ seconds = 3 }) {
    if (!engine?.beginEventCapture) throw new Error("No engine, or this build predates the event capture.");
    const secs = Math.max(0.2, Math.min(30, Number(seconds) || 3));
    const before = freeze.tasks.length;
    engine.beginEventCapture();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const rows = engine.endEventCapture();
    const total = rows.reduce((sum, r) => sum + r.ms, 0);
    const byEvent = new Map();
    for (const row of rows) {
      const e = byEvent.get(row.event) ?? { event: row.event, ms: 0, listeners: 0, emits: 0 };
      e.ms += row.ms;
      e.listeners++;
      e.emits = Math.max(e.emits, row.calls);
      byEvent.set(row.event, e);
    }
    return {
      seconds: secs,
      totalListenerMs: +total.toFixed(1),
      byEvent: [...byEvent.values()].map((e) => ({ ...e, ms: +e.ms.toFixed(1) })).sort((a, b) => b.ms - a.ms),
      listeners: rows.slice(0, 40),
      blocksDuringCapture: freeze.tasks.slice(before),
      note: "`emits` is how many times that event fired during the window — a NumberField drag fires one per pointer event. A listener with a high `calls` and a small `ms` each is still a storm: the cost is that everything else in the fan-out ran too.",
    };
  },
});

// ---------------------------------------------------------------------------
// ⭐⭐⭐ IS THE IDLE REAL? The performance panel computes idle as a RESIDUAL
// (`frameMs - workMs`), so every millisecond the engine does not mark is
// displayed as rest — React, the DOM's style/layout/paint, GC, WebGPU
// submission after the tick returns. This op measures the thread from outside
// instead, with a heartbeat that can only run when the thread is free.
// ---------------------------------------------------------------------------

defineOp({
  name: "profile.frameCensus",
  description:
    "What each component, module and system ACTUALLY costs this frame, measured by taking it away. " +
    "⭐ USE THIS WHEN THE FRAME IS LONGER THAN ANYTHING ACCOUNTS FOR. Every other profiler here reads a clock " +
    "inside the page, and a component that hands work to the GPU is invisible to all of them: a cloth solver " +
    "measures 0.008 ms of main thread and about 2 ms of GPU pass time and still costs 26 ms of frame, because the " +
    "cost is in ISSUING three hundred dispatches, which happens where no clock in this page can see it. The frame " +
    "WITH it and the frame WITHOUT it can be seen, and that difference is what this reports — the same comparison a " +
    "person makes by unticking something and watching the counter, run for every owner in turn. " +
    "Skips each owner's per-frame callbacks for a window and compares; the scene is NOT modified, nothing is " +
    "undoable, and the callbacks are restored afterwards even if it fails. Costs about a second per row, so it is a " +
    "deliberate action rather than a readout. `costMs` is how much shorter the frame gets when that owner stops.",
  params: {
    windowMs: {
      type: "number",
      description:
        "How long to watch each arm, in ms. The frame-rate window is one second, so below ~1000 the reading is partial. Default 1200, max 4000.",
    },
    by: {
      type: "string",
      description:
        "'type' (default) prices all ten cloths together, which is how people think about a component; 'instance' prices each separately and takes ten times as long.",
    },
  },
  async run({ windowMs = 1200, by = "type" } = {}) {
    // The measurement itself lives in editor/frameCensus.js so the profiler
    // panel's button and this op are the same instrument rather than two
    // implementations that can disagree about what a component costs.
    const { runFrameCensus } = await import("../../frameCensus.js");
    const report = await runFrameCensus(engine, { windowMs, by });
    const top = report.rows[0];
    return {
      ...report,
      note:
        "Each row is the frame with that owner's per-frame callbacks skipped. costMs = the baseline frame (" +
        report.baseline.frameMs +
        " ms) minus the frame without it, so a large positive number is the thing to look at" +
        (top && top.costMs > 0 ? ": " + top.label + " at " + top.costMs + " ms" : "") +
        ". Compare `restored` against `baseline`: if they disagree the scene drifted during the census (an asset " +
        "finished loading, GI rebuilt) and the rows are only as trustworthy as that agreement.",
    };
  },
});

defineOp({
  name: "profile.clothFlag",
  readOnly: false,
  description: "DEV: set a `__cloth...` global on the editor page (bisecting the cloth solver), then report it. Needs an editor.reload for anything read when a simulation is built.",
  params: {
    name: { type: "string", description: "The global's name, must start with `__cloth`." },
    value: { type: ["string", "number", "boolean", "object", "array", "null"], description: "The value, or null to delete." },
  },
  run({ name, value = null }) {
    if (!name?.startsWith("__cloth")) throw new Error("Only `__cloth...` globals are accepted.");
    if (value === null) delete globalThis[name]; else globalThis[name] = value;
    try {
      const store = JSON.parse(localStorage.getItem("cloth.devFlags.v1") ?? "{}");
      if (value === null) delete store[name]; else store[name] = value;
      localStorage.setItem("cloth.devFlags.v1", JSON.stringify(store));
    } catch { /* private mode: the flag still applies to this session */ }
    return { name, value: globalThis[name] ?? null, note: "Reload the editor for flags read while a simulation is built." };
  },
});

defineOp({
  name: "profile.frameAudit",
  readOnly: true,
  description:
    "Whether the frame's 'idle' is really idle. profile.frameStats reports idle as frameMs minus the work the engine marks, so anything OUTSIDE the engine tick — React re-rendering the editor, the browser's style/layout/paint, a GC pause, WebGPU submission after the tick returns — is counted as rest and the frame looks like it is waiting when the main thread is flat out. This op runs a MessageChannel heartbeat, which can only execute when the thread is free: every gap between beats is a contiguous busy block, measured from outside with no cooperation from the code being measured. Blocks containing an engine update stamp are the engine's own tick (render included); the rest are `other`, and a large `other` is the answer to 'the fps is low but every engine number is small'. `idle` is what is left, and only that part is really the display's vsync wait. Read `hostFps` first: it counts the browser's raw frame offers, so a low one means the window is throttled (unfocused, or the editor's own limiter) and no other number in the report is about your machine's speed. `frame` is the whole thing ITEMISED — one row per instrumented callback (engine tick, each rAF, each timer), one for the browser's own style/layout/paint/GC, one for the thread parked — each charged to whoever was INNERMOST, so nested spans are never billed twice and the rows sum to `hostFramePeriodMs`. `unbilledMs` is what that sum still misses and should be near zero; a large one means work is arriving through a door this does not wrap. `timers` names the setTimeout/setInterval callbacks, which is where non-frame work in this editor lives — but only those SCHEDULED DURING the window, since a repeating interval registered earlier still runs through its original callback and is billed to `Browser and untagged tasks` instead.",
  params: {
    ms: { type: "number", default: 2000, description: "Window length in ms (200-20000)." },
  },
  async run({ ms = 2000 }) {
    const { auditFrames } = await import("../../../engine/frameAudit.js");
    const report = await auditFrames(engine, { ms });
    // ⚠ A LOW hostFps IS NOT AUTOMATICALLY A THROTTLED WINDOW. It is only that
    // if the engine is ALSO missing frames the browser offered; when the engine
    // ticks on every single offer, the browser is pacing us to a whole number
    // of vsync intervals because the frame does not fit in one.
    const busyPerFrame = report.engine.perFrameMs + report.other.perFrameMs;
    const missed = report.hostFrames - report.engineTicks;
    const verdict = missed > report.hostFrames * 0.1
      ? `The engine skipped ${missed} of ${report.hostFrames} frames the browser offered — a frame limiter or a suspended viewport, not a speed problem.`
      : report.other.perFrameMs > busyPerFrame * 0.35
        ? "The thread is BUSY outside the engine tick — `other` is real work the profiler has been calling idle. `loaf` names it when a block exceeds 50 ms."
        : `The main thread is free ${report.idle.pct}% of the time and the engine ticks on every frame offered, so the pacing is VSYNC: ${busyPerFrame.toFixed(1)} ms of main-thread work plus present does not fit one refresh interval, and the browser rounds the frame up to the next whole one. The lever is total main-thread ms per frame, not the idle.`;
    return {
      ...report,
      verdict,
      note: "`engine` is the marked tick, `other` is every other contiguous busy block, `idle` is the thread genuinely parked. perFrameMs divides by the browser's frame offers, so the three perFrameMs values sum to one frame's period. The heartbeat keeps the thread hot and can itself suppress idle behaviour: run a window, read it, and do not leave it on.",
    };
  },
});

defineOp({
  name: "profile.foliageState",
  readOnly: true,
  description:
    "Per-foliage-component internal state: chunk tier/level/mask histograms, per-render-mesh visibility and committed counts, impostor atlas and arrival-ramp state, and the resumable commit jobs. This is the view the draw-call audit cannot give — WHY a tier is (not) drawing, not just what was submitted.",
  params: {},
  async run() {
    if (!engine) throw new Error("No engine.");
    const components = [];
    for (const entity of engine.entities?.values?.() ?? []) {
      const c = entity.getComponent?.("foliage");
      if (!c) continue;
      const chunks = c.chunks ?? [];
      const levels = {};
      const tierMasks = {};
      const commitMasks = {};
      for (const ch of chunks) {
        levels[ch.level] = (levels[ch.level] ?? 0) + 1;
        const t = ch.tierMask ?? -1;
        const k = ch.commitMask ?? -1;
        tierMasks[t] = (tierMasks[t] ?? 0) + 1;
        commitMasks[k] = (commitMasks[k] ?? 0) + 1;
      }
      const jobs = (c._orderSpread ?? []).map((job, lod) => job ? {
        lod,
        cursor: job.cursor ?? null,
        count: job.count ?? null,
        done: !!job.done,
        chunksMatch: job.chunks === chunks,
      } : { lod, empty: true });
      components.push({
        entity: entity.id,
        name: entity.name,
        species: c.props?.species ?? null,
        lodNear: c.props?.lodNear, lodFar: c.props?.lodFar,
        maxDistance: c.props?.maxDistance, shadowFar: c.props?.shadowFar,
        status: c._stats?.status ?? null,
        chunks: chunks.length,
        // Why a tier-2 commit might stage nothing: its per-chunk SOURCE meshes
        // (chunk.meshes[2], written by _buildImpostors) are what every commit
        // path copies from. A missing source is skipped SILENTLY.
        impostorSources: chunks.filter((ch) => ch.meshes?.[2]).length,
        impostorSourceInstances: chunks.reduce((sum, ch) => sum + (ch.meshes?.[2]?.geometry?.instanceCount ?? 0), 0),
        totalInstances: c.instances?.length ?? null,
        levels,
        tierMasks,
        commitMasks,
        atlasReady: !!c._atlasEntry?.atlas,
        atlasError: c._atlasEntry?.error ?? null,
        impostorRamp: c._impostorRamp ?? null,
        batchDirty: !!c._batchDirty,
        batchVersion: c._batchVersion ?? null,
        commitVersion: c._batchCommitVersion ?? null,
        tierEverCommitted: c._tierEverCommitted ?? null,
        jobs,
        renderMeshes: (c.renderMeshes ?? []).map((m, lod) => ({
          lod,
          visible: !!m?.visible,
          // InstancedMesh draws `count` instances; a plain Mesh with an
          // InstancedBufferGeometry (the impostor tier) reports its
          // geometry's instanceCount. ⚠ `Mesh.count` EXISTS in three r185+
          // (initialised to 1) and must never be read for a plain Mesh —
          // that fallback is exactly how the impostor tier once looked
          // "wedged at one instance" while carrying hundreds.
          count: m?.isInstancedMesh ? m.count : m?.geometry?.instanceCount ?? null,
          castShadow: !!m?.castShadow,
        })),
        stats: c._stats ? { ...c._stats } : null,
      });
    }
    return { components };
  },
});
