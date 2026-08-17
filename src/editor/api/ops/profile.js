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
    frames: {
      type: "number",
      default: 60,
      description:
        "Frames to average over. One tick is not a measurement on a scene with GC pauses. Max 600.",
    },
  },
  async run({ frames = 60 }) {
    const stats = engine?.stats;
    if (!stats) throw new Error("No engine.");
    const want = Math.max(1, Math.min(600, Math.round(frames)));
    stats.beginPhaseCapture(want);
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
