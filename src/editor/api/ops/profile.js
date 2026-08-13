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
import { engine } from "../../engineInstance.js";
import { auditDrawCalls } from "../../../engine/drawCallAudit.js";

/** Named screen-chain passes, in the order they run. */
const SCREEN_PASSES = [
  "lightShadowPass",
  "lightShadowFilterPass",
  "lightShadowWidePass",
  "lightShadowWidePass2",
  "lightShadowHistoryPass",
  "lightShadowPostPass",
  "emitterShadowPass",
  "emitterShadowFilterPass",
];

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
      const skipReason = (name) => {
        if (name.startsWith("emitter") && !emittersLive) return "0 emitters";
        if (name.startsWith("lightShadow") && !giShadowLive) return "no light uses Shadow Source \"gi\"";
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
        // Duplicate labels (one merge per cascade level) keep their index.
        queueMs[queueMs[e.pass] === undefined ? e.pass : `${e.pass} #${queueEntries.indexOf(e)}`] = e.ms;
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
        srcProbes = {
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
          // The transport's fired count, kernel-tallied. Under the per-probe
          // ray cap this is the REAL total — the boot line's `rays/frame` is an
          // upper bound there, and dividing a deposit time by the bound would
          // overstate the kernel by exactly the cap's savings.
          raysPerFrame: stats.rays?.rays ?? 0,
          probeRayCap: screen.srcProbes.probeRayCap ?? null,
          unattributedRate: stats.rays?.unattributedRate != null
            ? +(stats.rays.unattributedRate * 100).toFixed(2) + "%"
            : null,
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

defineOp({
  name: "profile.frameStats",
  readOnly: true,
  description:
    "Live frame-rate and renderer counters — the same numbers the viewport's Stats overlay shows. `fps` counts frames the renderer actually PRESENTED over a one-second window; ticks that ran but skipped the draw (a GI compile wave, a renderer resize) are reported separately as `skippedFps`, and an idle viewport the editor has suspended reports 0 for both. Use this to check whether a change actually made the editor faster. `culling` reports what the occlusion and LOD systems are doing: `occlusion.occluders` is 0 when no object in the scene is large enough to be worth rendering into the occluder depth pass, in which case nothing can ever be culled.",
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
    return {
      fps: Math.round(r.fps),
      skippedFps: Math.round(r.skippedFps),
      cpuMs: +(r.workMs || r.frameMs).toFixed(2),
      gpuMs: +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2),
      gpuMsIsReal: r.gpuMs > 0,
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
        occlusion: engine.occlusion?.stats ?? null,
        lodHidden: [...engine.entities.values()].filter((e) => e._lodHidden === true).length,
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
