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
