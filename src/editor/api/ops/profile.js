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
      const timeOne = async (compute) => {
        if (!compute) return null;
        // Warm first: the very first dispatch pays pipeline + bind-group setup,
        // which is not what "cost per frame" means.
        renderer.compute(compute);
        await renderer.resolveTimestampsAsync("compute");
        const before = renderer.info.compute.timestamp ?? 0;
        for (let i = 0; i < K; i++) renderer.compute(compute);
        await renderer.resolveTimestampsAsync("compute");
        const after = renderer.info.compute.timestamp ?? 0;
        return +((after - before) / K).toFixed(4);
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
      // SRC probe population (opt-in via `__giSrcProbes`). Timed as ONE number
      // rather than per-pass: the fourteen dispatches are a fixed chain whose
      // boundaries are barriers, so the interesting question is what the chain
      // costs, not which of two clears is slower. Its telemetry rides along
      // because "3.1ms" and "3.1ms at load 0.94 with 900 dropped inserts" call
      // for completely different responses.
      let srcProbes = null;
      if (screen.srcProbes) {
        let srcMs = 0;
        for (const pass of screen.srcProbes.passes) {
          const ms = await timeOne(pass);
          if (typeof ms === "number") srcMs += ms;
        }
        const stats = await screen.srcProbes.readStats(renderer);
        srcProbes = {
          totalMs: +srcMs.toFixed(3),
          dispatches: screen.srcProbes.passes.length,
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
          note: "Produces no light yet — Phase 1 populates probes, Phase 2/3 make them shade.",
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
