// ASYNC RENDER PIPELINES FOR THE MAIN SCENE RENDER — the freeze class named
// by `probe:gi-boot-frames` and `probe:camera-motion` on 2026-09-02, and the
// 21.5-SECOND block the freeze ledger recorded on 2026-09-09.
//
// The ledger is imported for ONE reading: `freeze.asyncInFlight.size`, the
// driver queue's own depth, which the busy gate below needs. `freezeLedger`
// imports only `wgslStable`, so this adds no cycle.
//
// three creates a render pipeline SYNCHRONOUSLY the first time an object with
// a new (material, geometry layout, render context) is drawn:
// `Pipelines.getForRender(renderObject)` → `_getRenderPipeline(…, promises =
// null)` → `device.createRenderPipeline(desc)`. In Chrome the call returns at
// once, but the GPU process executes it IN ORDER on its command thread, so a
// 170 kB GI-injected material shader parks that thread for its whole compile
// and every later command from this page — including the flow-control ack the
// renderer's main thread is waiting on — queues behind it. The page's main
// thread then blocks for the length of the compile, inside a task the ledger
// reports as `(unattributed)` with no engine span and no wrapped WebGPU call
// in it. Measured on the user's Level: 28 sync pipelines at first paint =
// 1.1–1.2 s frozen; 29 at the first lit frame = 2.4 s; NINE on a camera drag
// (7 of them lit-material variants first seen when the camera turned) =
// 1.19 s — the "heavy freezes on launch and after I move the camera" report.
// And on 2026-09-09, on the user's Foliage scene: ten synchronous re-mints of
// a 70 kB foliage program (a `lights` wave after a light edit, then the
// environment latch, then the ambient-glow context) parked the GPU process for
// **21 528 ms** in one block, `(unattributed) 21528`, `gpu: null`.
//
// three already owns the fix and uses it in `compileAsync`: hand the backend a
// promises array and `createRenderPipelineAsync` compiles on the driver's
// worker threads while `Renderer._renderObjectDirect` SKIPS the draw
// (`Pipelines.isReady` is false until the promise lands). Nothing blocks; the
// object appears the frame its pipeline is ready. This module turns that path
// on for the ENGINE'S MAIN RENDER, and adds the one thing three's path lacks —
// a re-minted object keeps drawing what it drew before until its replacement
// is ready — so that NO pipeline has to be created synchronously inside the
// frame, first compile or re-mint.
//
//   · scope — `active` is raised by Engine around the one call that presents
//     the frame (the scene render, or the postprocess override's). A one-shot
//     render outside it (an atlas tile blit, an impostor bake, a texture
//     average readback, the editor's picking/outline passes) keeps the sync
//     path for a FIRST compile, because a skipped draw there is a black result
//     nobody re-renders — the exact failure class of
//     gi-atlas-blit-cleared-itself.
//   · size — a FIRST compile goes async only when the LARGER of the two
//     programs is at least `minFragmentBytes` of WGSL. Shadow-depth materials
//     (~1 kB), the GI gbuffer overrides (~1.5 kB), unlit materials (~4 kB)
//     compile in a few ms and are not worth a frame of absence; lit materials
//     without GI are ~27 kB, with GI 170–250 kB, and those are the stalls.
//     A RE-MINT that has something to draw meanwhile ignores the gate: there
//     is no absence to trade, so even a small program goes async.
//
//     ⛔ AND DO NOT ADD A "NESTED RENDERS STAY SYNC" RULE ON RENDER DEPTH.
//     It is the obvious guard and it is wrong here: with a Postprocess
//     component the SCENE render is nested by construction (RenderPipeline →
//     QuadMesh.render → PassNode.updateBefore → renderer.render), so a depth
//     rule would send exactly the heavy lit materials back down the blocking
//     path on the scenes that need this most. The one-shot renders the scope
//     rule protects — atlas blits, impostor bakes, picking, the outline mask —
//     run from preRender/postRender where `active` is already false. A nested
//     pass that DOES ride inside the main render (a planar reflection, a water
//     mirror) re-renders every frame, so a deferred pipeline costs it one
//     frame, not a permanent black.
//
//     ⚠ IT USED TO READ THE FRAGMENT ALONE, and the freeze ledger caught what
//     that misses (2026-09-07, the user's Pool scene): `[freeze] 175 ms —
//     (unattributed) 175 [sync gpu: 17r/0c/2m, 78kB WGSL]` — seventeen render
//     pipelines built synchronously from two ~39 kB programs. A displaced
//     water surface, a skinned mesh and every vertex-animated material carry
//     their weight in the VERTEX stage, where the old gate read a fragment of
//     a few kB and sent them all down the blocking path. The driver compiles
//     both stages either way, so both have to be looked at.
//
// ══ THE RE-MINT: "DRAW THE PREVIOUS PROGRAM UNTIL THE NEW ONE LANDS" ═════════
//
// 2026-09-07 the rule was "defer a FIRST compile, never a RE-MINT": deferring
// an object that is on screen swaps it for a hole ("every mesh I select
// disappears for a moment"), so re-mints were compiled synchronously and the
// hitch was accepted. 2026-09-09 the ledger priced that hitch at 21.5 s on a
// scene with ten re-minted foliage programs, and the standing rule of this
// project is NO FREEZE. So the trade is now refused on both sides: a re-mint
// is compiled asynchronously AND the object keeps drawing what it drew before.
// three re-mints in two different shapes and each needs its own stand-in:
//
//   · SAME render object, new pipeline — `WebGPUBackend.needsRenderUpdate`
//     fires on a render-state change (side, blending, depth, alphaToCoverage,
//     the target's sample count) and `Pipelines.getForRender` mints a new
//     pipeline from the SAME two programs. Same programs means the same bind
//     group layout, so the previous pipeline is still valid against this
//     object's bindings: `renderObject.pipeline` is pointed back at it (that is
//     the field `backend.draw` reads) until the new one is ready. This is the
//     case the 2026-09-07 note rejected with "bind groups are rebuilt for the
//     new pipeline's layout" — which is true only of the OTHER shape.
//   · NEW render object — a material cache-key change or a scene-wide input
//     to three's dynamic key (`lights`, `environment`, `fog`, `shadowMap`, the
//     context node) makes `RenderObjects.get` DISPOSE the render object and
//     build a fresh one: new node graph, new bindings, new pipeline. The old
//     one's pipeline, bindings and graph are consistent WITH EACH OTHER, so the
//     whole object is PARKED instead of deleted (its chain-map entry is
//     removed, which is what lets `get` create the replacement; the three
//     resource deletes are deferred), and while the replacement's pipeline is
//     compiling `Pipelines.isReady` draws the parked object in its place —
//     uniforms refreshed, bindings updated, `backend.draw` — and reports the
//     new one as not ready. The first frame the new pipeline is ready the
//     parked object is released.
//
//     What a parked object does NOT get is `Nodes.updateBefore`: that is where
//     a `ShadowNode` re-renders its shadow map, and the parked graph may hold
//     the OLD light's shadow node. Skinning and instancing survive without it
//     because the bone texture and instance buffer are shared with the live
//     object, whose own `updateBefore` still runs.
//
//     A parked object is drawn only while every texture and storage buffer it
//     binds still exists on the backend (`parkedDrawable`) — the old light's
//     disposed shadow map is the case — and while its material and geometry
//     are alive; otherwise it is dropped and the object is absent for the
//     compile, which is exactly what the async path did before. A chain of
//     quick re-mints hands the parked object down to the newest replacement,
//     and a parked object older than `PARKED_TTL_MS` is released on the next
//     install call (once per frame) so a culled object cannot pin one forever.
//
// What changes for the user: the first frame of a scene shows objects filling
// in over the driver's compile time instead of the whole editor freezing for
// it; turning the camera onto a never-seen material costs a few frames of
// that object being absent instead of a >1 s hitch; a light or material edit
// re-mints every affected program on the driver's threads while the old
// picture stays up, and the new one replaces it the frame it lands.
//
// `globalThis.__asyncRenderPipelines = false` restores the sync path whole
// (the A/B arm); `__asyncRenderPipelinesMinBytes` moves the size gate;
// `__asyncRenderPipelinesStandIn = false` restores the 2026-09-07 rule (a
// re-mint compiles synchronously, no stand-in, no parking) and
// `__asyncRenderPipelinesRemint = true` the 2026-09-02 one (defer everything,
// holes and all) — the two arms for pricing what each trade costs.

import { freeze } from "./freezeLedger.js";

export const ASYNC_RENDER_PIPELINE_MIN_BYTES = 16 * 1024;

/**
 * How much node-graph BUILD time one frame of the main render may spend
 * before the remaining unbuilt objects wait for the next frame.
 *
 * ══ THE BUILD BUDGET ═════════════════════════════════════════════════════════
 *
 * With the driver compile off the main thread, what is left of a re-mint
 * wave is three's `nodeBuilder.build()` — the TSL graph walk and WGSL codegen,
 * 20-60 ms per lit material on the user's machine and 250-400 ms per wave of
 * nine (`[freeze] 362 ms — material:nodeBuild Foliage · living surface 255
 * … [rebuilt: lights x9]`, 2026-09-09). It runs synchronously inside
 * `renderer.render`, the first time an object with a new program is drawn, so
 * a wave is one block. The plan's unit 2.2 asks for "≤ 8 ms of build per
 * frame while the user interacts", and parking makes that possible without a
 * hole: an object whose graph is not built yet keeps drawing its PARKED
 * predecessor, exactly as one whose pipeline is still compiling does. So the
 * main render builds graphs until the frame's budget is spent and defers the
 * rest — a nine-material wave becomes ~9 frames of one build each instead of
 * one 360 ms frame. At least one build always goes through per frame, so the
 * wave never stalls; a first compile with nothing parked is simply absent
 * for those frames, which it was anyway while its pipeline compiled.
 *
 * Only the main render is budgeted (`state.active`): a one-shot pass wants its
 * objects now. An object whose program another object already built
 * (`nodeBuilderCache` hit) is not a build and is never deferred.
 * `__asyncRenderPipelinesBuildBudgetMs` moves it; `0` disables the budget.
 */
export const BUILD_BUDGET_MS = 8;

/** A parked render object is released after this long whether or not its
 * replacement ever landed — a culled object must not pin its old graph. */
export const PARKED_TTL_MS = 30_000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Is this pipeline object compiled and usable?
 */
function pipelineIsReady(pipelines, pipeline) {
  try {
    if (pipeline === undefined || pipeline === null) return false;
    const data = pipelines.backend?.get?.(pipeline);
    return data?.pipeline !== undefined && data?.pipeline !== null;
  } catch {
    // An internals shape three changed: fall back to the old behaviour rather
    // than making every pipeline synchronous by accident.
    return false;
  }
}

/** Two pipelines built from the same two programs share a bind group layout. */
function programsMatch(pipeline, stageVertex, stageFragment) {
  return !!pipeline
    && pipeline.vertexProgram !== undefined
    && pipeline.vertexProgram === stageVertex
    && pipeline.fragmentProgram === stageFragment;
}

function sameChain(a, b) {
  return !!a && !!b
    && a.object === b.object
    && a.material === b.material
    && a.context === b.context
    && a.lightsNode === b.lightsNode;
}

let warnedDrawFailure = false;

/**
 * Install the interception once per renderer and return its state object.
 * Idempotent; safe (and intended) to call every frame — the call also sweeps
 * parked objects that outlived their TTL.
 *
 * @param {import("three/webgpu").WebGPURenderer} renderer
 * @return {{active: boolean, deferred: number, minFragmentBytes: number}|null}
 */
export function installAsyncRenderPipelines(renderer) {
  const pipelines = renderer?._pipelines;
  if (!pipelines || typeof pipelines._getRenderPipeline !== "function") return null;
  if (pipelines.__asyncRenderPipelines) {
    pipelines.__asyncRenderPipelines.beginFrame?.();
    return pipelines.__asyncRenderPipelines;
  }

  const state = {
    active: false,
    /** pipelines that went through the async path (the ledger's receipt) */
    deferred: 0,
    minFragmentBytes: ASYNC_RENDER_PIPELINE_MIN_BYTES,
    /** same-object re-mints drawn with their previous pipeline meanwhile */
    standIns: 0,
    /** render objects parked so their replacement could compile async */
    parked: 0,
    /** frames in which a parked object was drawn in place of its replacement */
    parkedDraws: 0,
    /** parked objects dropped because a bound resource had gone away */
    parkedDropped: 0,
    /** parked objects currently held */
    parkedLive: 0,
    /** how often the per-frame install call sweeps parked objects for the TTL */
    sweepIntervalMs: 1000,
    sweep: null,
    /** node-graph builds the main render may spend per frame, in ms */
    buildBudgetMs: BUILD_BUDGET_MS,
    /** build ms spent in the current frame */
    frameBuildMs: 0,
    /** graphs built inside the main render this session */
    builds: 0,
    /** draws pushed to a later frame because the budget was spent */
    buildsDeferred: 0,
    /** small first compiles deferred only because the driver was busy */
    deferredWhileBusy: 0,
    /** ...of which inside a shadow map nothing caches (see the busy gate) */
    deferredShadowWhileBusy: 0,
    /** disposes of render objects that had never created their bind groups —
     * three would have decremented the SHARED groups for them (see below) */
    unbuiltBindingDeletes: 0,
    beginFrame: null,
  };
  const standInsEnabled = () => globalThis.__asyncRenderPipelinesStandIn !== false
    && globalThis.__asyncRenderPipelinesRemint !== true;
  const inBundle = () => renderer?._currentRenderBundle != null;
  /** Async pipelines the driver has not settled yet — the queue's own depth. */
  const driverBusy = () => (freeze.asyncInFlight?.size ?? 0) > 0;
  /** True only for the render that presents the frame: see the busy gate below. */
  const presentingToCanvas = () => {
    try { return renderer.getRenderTarget?.() == null; } catch { return false; }
  };
  /**
   * A plain three shadow map (`ShadowNode` names its targets) rendered while
   * `shadowFreeze` has published that NOTHING caches shadow content this frame
   * — see the busy gate below. Clipmap static caches name their own targets
   * (`ClipmapStatic*`) and never match.
   */
  /**
   * ⛔ PMREM GENERATION MUST NEVER DEFER (09-14). three builds the environment's
   * prefiltered mips INSIDE the presenting render (`PMREMNode.updateBefore` →
   * `PMREMGenerator`, one blur/GGX draw per mip into a `PMREM.cubeUv` target)
   * exactly once per environment, then records the PMREM as done. A draw this
   * layer skips there is never redrawn: the blurred mips stay black, so every
   * lit material loses its diffuse sky light for the whole session. Complex
   * scene receipt: every shadow pitch black, environment intensity 5 → 200 only
   * added a faint specular sheen; with deferral off and a fresh PMREM the same
   * pose lit normally at intensity 5.
   */
  const renderingPMREM = () => {
    try {
      const texture = renderer.getRenderTarget?.()?.texture;
      return texture?.isPMREMTexture === true || texture?.name === "PMREM.cubeUv";
    } catch { return false; }
  };
  const renderingUncachedShadowMap = () => {
    if (renderer?.__shadowMapsRedrawnEveryFrame !== true || globalThis.__asyncRenderPipelinesShadowBusyGate === false) return false;
    try {
      const target = renderer.getRenderTarget?.();
      return target?.depthTexture?.name === "ShadowDepthTexture" || target?.texture?.name === "ShadowMap";
    } catch { return false; }
  };

  // The backend pushes one promise per pipeline into this. Nobody awaits it
  // (three sets `pipelineData.pipeline` from inside the promise itself), so
  // a sink that keeps nothing is the whole array this path needs — an
  // ever-growing real array would pin every pipeline promise for the session.
  const sink = { push() {} };

  // ── same-object re-mint: the stand-in ────────────────────────────────────
  //
  // Set by the `getForRender` wrapper for the duration of ONE synchronous
  // call. `_getRenderPipeline` runs inside it with no await in between, so a
  // single slot is enough and a WeakMap would only add churn per draw.
  //
  // ⛔ CHECKING THE PREVIOUS PIPELINE INSIDE `_getRenderPipeline` DOES NOT
  // WORK, and measuring is the only reason we know. `Pipelines.getForRender`
  // runs `if (previousPipeline && previousPipeline.usedTimes === 0)
  // this._releasePipeline(previousPipeline)` FIRST — so by the time the inner
  // hook is reached, the evidence that this object was drawing has already
  // been destroyed. The first version of the 2026-09-07 fix did exactly that,
  // passed its unit tests, and changed nothing live. The readiness has to be
  // captured on the way IN, which is what the `getForRender` wrapper does.
  let drawingBeforeUpdate = false;
  let previousPipelineSlot = null;
  const originalGetForRender = pipelines.getForRender;
  if (typeof originalGetForRender === "function") {
    pipelines.getForRender = function (renderObject, promises) {
      const outerDrawing = drawingBeforeUpdate;
      const outerPrevious = previousPipelineSlot;
      let data = null;
      let standIn = null;
      try {
        data = this.get(renderObject);
        const previous = data?.pipeline;
        if (pipelineIsReady(this, previous)) standIn = previous;
        else if (pipelineIsReady(this, data?.__standIn)) standIn = data.__standIn;
      } catch {
        data = null;
        standIn = null;
      }
      drawingBeforeUpdate = standIn !== null;
      previousPipelineSlot = standIn;
      let result;
      try {
        result = originalGetForRender.call(this, renderObject, promises);
      } finally {
        drawingBeforeUpdate = outerDrawing;
        previousPipelineSlot = outerPrevious;
      }
      // The program was replaced while the object was drawing, the
      // replacement is still compiling, and the previous pipeline was built
      // from the same programs: keep drawing with it. `renderObject.pipeline`
      // is the field `backend.draw` reads; `data.pipeline` is what `isReady`
      // reads, and it keeps pointing at the compiling one.
      if (
        standIn !== null
        && standInsEnabled()
        && data
        && result
        && result !== standIn
        && !pipelineIsReady(this, result)
        && programsMatch(standIn, result.vertexProgram, result.fragmentProgram)
      ) {
        try {
          if (data.__standIn !== standIn) state.standIns++;
          data.__standIn = standIn;
          renderObject.pipeline = standIn;
        } catch {
          /* a frozen render object: no stand-in, the object is absent */
        }
      }
      return result;
    };
  }

  const original = pipelines._getRenderPipeline;
  pipelines._getRenderPipeline = function (renderObject, stageVertex, stageFragment, cacheKey, promises) {
    let defer = false;
    if (promises == null && globalThis.__asyncRenderPipelines !== false && !renderingPMREM()) {
      const bytes = Math.max(stageFragment?.code?.length ?? 0, stageVertex?.code?.length ?? 0);
      const overGate = bytes >= (Number(globalThis.__asyncRenderPipelinesMinBytes) || state.minFragmentBytes);
      const parked = renderObject?.__previousDraw != null && renderObject.__previousDraw.released !== true;
      if (globalThis.__asyncRenderPipelinesRemint === true) {
        // The 2026-09-02 arm: defer everything big, holes included.
        defer = state.active && overGate;
      } else if (drawingBeforeUpdate) {
        // A same-object re-mint. Async only when the previous pipeline can
        // stand in (same programs), and only inside the main render — a
        // one-shot pass wants its new render state now.
        defer = state.active && standInsEnabled()
          && programsMatch(previousPipelineSlot, stageVertex, stageFragment);
      } else if (parked && standInsEnabled()) {
        // A replacement object with its predecessor parked: nothing is absent
        // while this compiles, so the size gate does not apply. Outside the
        // main render only a big program is worth the parked draw.
        defer = state.active || overGate;
      } else {
        // A first compile: nothing on screen to protect, defer the big ones.
        defer = state.active && overGate;
        // ── AND THE SMALL ONES TOO, WHEN THE DRIVER IS ALREADY BUSY ────────
        //
        // The size gate above asks "is this program big?" when the question
        // that decides the stall is "is the GPU PROCESS busy?". A synchronous
        // `createRenderPipeline` returns in 0.1 ms, but the GPU process
        // executes it IN ORDER on its command thread, so a 1 kB shadow-depth
        // program queued behind a 50 kB foliage fragment costs the whole
        // foliage compile — and the main thread blocks on the wire waiting for
        // it. "Compiles in a few ms" is true only of an IDLE driver.
        //
        // Measured 2026-09-12, GI OFF, on the user's Complex scene: 43 sync
        // pipelines totalling 336 kB, and **18 536 of 20 720 blocked ms were
        // `waitingOnGpuMs`, spread over 79 separate waits**. Those 43 are not
        // 18 s of compiling — they are 43 BARRIERS at which the main thread
        // has to wait for everything already queued. Removing the barriers
        // does not remove the work; it stops the editor waiting in lockstep
        // for it, which is the difference between "done" and "usable".
        //
        // ⛔ CANVAS-PRESENTING RENDER ONLY — this is the guard that makes it
        // safe, and it is NARROWER than `state.active`. `state.active` spans
        // the whole presenting render, and three renders SHADOW MAPS inside
        // it: deferring there would let a pending pipeline leave a caster out
        // of a shadow map that `shadowFreeze` then CACHES as complete, which
        // AGENTS.md forbids in as many words ("pending pipelines and parked
        // stand-ins cannot certify new shadow content"). A null render target
        // means we are drawing the frame the user is about to see, where a
        // skipped draw is simply re-drawn next frame. It also excludes atlas
        // blits, impostor bakes and picking — the one-shot renders whose
        // skipped draw is a black result nobody re-renders.
        //
        // Self-limiting: with an idle driver `driverBusy()` is false and the
        // behaviour is exactly what it was. `__asyncRenderPipelinesBusyGate
        // = false` reverts.
        //
        // ⭐ AND INSIDE A SHADOW MAP NOTHING CACHES (09-14, Complex scene). The
        // canvas-only rule left every shadow-pass pipeline synchronous, and a
        // matHalf wave re-minted 48 `ShadowMaterial` variants at once — 29 sync
        // pipelines in 0.4 s, then 10-25 s unattributed stalls behind the async
        // queue. When `shadowFreeze` publishes
        // `renderer.__shadowMapsRedrawnEveryFrame` (a deforming caster forces
        // every map to re-render each frame and every freeze is released), a
        // caster skipped this frame is drawn into next frame's map: the same
        // argument as the canvas. `__asyncRenderPipelinesShadowBusyGate = false`
        // reverts this half.
        if (
          !defer && state.active && !overGate
          && globalThis.__asyncRenderPipelinesBusyGate !== false
          && driverBusy()
        ) {
          if (presentingToCanvas()) {
            defer = true;
            state.deferredWhileBusy += 1;
          } else if (renderingUncachedShadowMap()) {
            defer = true;
            state.deferredWhileBusy += 1;
            state.deferredShadowWhileBusy += 1;
          }
        }
      }
    }
    if (defer) {
      state.deferred += 1;
      return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, sink);
    }
    return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, promises);
  };

  // ── the unbalanced bind-group refcount ────────────────────────────────────
  //
  // 2026-09-10, the user's Sponza, at every boot:
  //
  //   Uncaught TypeError: Failed to execute 'writeBuffer' on 'GPUQueue':
  //     parameter 1 is not of type 'GPUBuffer'
  //       at WebGPUBindingUtils.updateBinding … Bindings.updateForRender
  //   THREE.WebGPURenderer: [Buffer "bindingBuffer72_render_(vertex,fragment,
  //     compute)"] used in submit while destroyed.
  //
  // `Bindings` refcounts every bind group in `usedTimes`: `_createBindings`
  // increments (once per render object, from its first `updateForRender`), and
  // `_destroyBindings` decrements from `deleteForRender` on dispose — at zero
  // the group's uniform buffers are DESTROYED and their CPU arrays released.
  // Most groups are cloned per render object, but a SHARED one is not:
  // `NodeBuilderState.createBindings` hands every render object in a render
  // context the SAME `render`/`frame` BindGroup, so its `usedTimes` is "how
  // many render objects exist in this context" — buffer 72 above is that
  // shared `render` group, bound by the whole scene.
  //
  // `deleteForRender` decrements UNCONDITIONALLY: three assumes a disposed
  // render object was drawn at least once. The build budget below breaks that
  // assumption — it calls `_objects.get()`, which CREATES and registers the
  // render object, and then returns without drawing it, so the object never
  // reaches `Bindings.getForRender` and increments nothing. Re-key it before
  // its deferred build lands (on a scene whose dynamic cache key moves every
  // frame, that is every frame) and its dispose decrements the shared group
  // for an increment that never happened. A few hundred of those and
  // `usedTimes` hits zero while the entire scene is still drawing with it:
  // `destroyUniformBuffer` runs, and the next frame is the pair above.
  //
  // The guard is the invariant three's own code states and only assumes:
  // destroy exactly what was created. An uninitialized render object drops its
  // DataMap entry and nothing else. It also saves the node build the delete
  // would otherwise force — `deleteForRender` reaches `renderObject
  // .getBindings()`, which builds the very graph the budget deferred, inside
  // dispose. `globalThis.__balancedBindingDeletes = false` restores three's
  // unconditional decrement (the A/B arm; expect the errors back).
  //
  // ⭐ THIS IS THE RENDER-SIDE TWIN OF A FIX THIS PROJECT ALREADY SHIPPED ON
  // THE COMPUTE SIDE: `src/modules/gi/releaseCompute.js` guards
  // `Bindings.deleteForCompute` against a never-dispatched compute node for
  // the same reason, and recorded the same two errors (down to the buffer's
  // `_render_(vertex,fragment,compute)` name) as its receipt. Read its header
  // for the second half of the story — the `nodes.getForCompute` fallback that
  // rebuilds the graph inside the delete. Receipt here: two consecutive Sponza
  // boots through the live editor caught 43 and 41 unbuilt deletes
  // (`profile.flag __asyncRenderPipelinesUnbuiltDeletes`), all of them inside
  // the boot wave, and left an EMPTY error console where every boot had
  // printed the pair.
  const bindings = renderer?._bindings;
  if (typeof bindings?.deleteForRender === "function" && !bindings.__balancedDeleteForRender) {
    bindings.__balancedDeleteForRender = true;
    const originalDeleteForRender = bindings.deleteForRender;
    bindings.deleteForRender = function (renderObject) {
      if (globalThis.__balancedBindingDeletes !== false) {
        // `initialized` is the flag `Bindings.getForRender` raises the first
        // time it creates this object's bind groups. Default TRUE: an
        // internals shape three moved (no `DataMap.has`) falls back to three's
        // own behaviour rather than silently leaking every bind group.
        let initialized = true;
        try {
          if (typeof this.has === "function") {
            initialized = this.has(renderObject) ? this.get(renderObject).initialized === true : false;
          }
        } catch { initialized = true; }
        if (!initialized) {
          state.unbuiltBindingDeletes++;
          globalThis.__asyncRenderPipelinesUnbuiltDeletes = state.unbuiltBindingDeletes;
          try { this.delete(renderObject); } catch { /* never had an entry */ }
          return;
        }
      }
      return originalDeleteForRender.call(this, renderObject);
    };
  }

  // ── new-object re-mint: parking ───────────────────────────────────────────
  const objects = renderer?._objects;
  const parkedHolders = new Set();
  let inObjectsGet = 0;
  let parkedCandidate = null;
  let lastSweep = now();
  const canPark = !!objects
    && typeof objects.get === "function"
    && typeof objects.createRenderObject === "function"
    && typeof objects.getChainMap === "function"
    && !!renderer?._nodes && !!renderer?._bindings && !!renderer?._geometries && !!renderer?.backend;

  /** The parked object is retired: its three resource deletes finally run. */
  const releaseRecord = (record) => {
    if (!record || record.released) return;
    record.released = true;
    record.unhook?.();
    state.parkedLive = Math.max(0, state.parkedLive - 1);
    try { record.release(); } catch { /* the renderer may already be gone */ }
  };
  const releaseParked = (holder) => {
    const record = holder?.__previousDraw;
    if (!record) return;
    holder.__previousDraw = null;
    parkedHolders.delete(holder);
    releaseRecord(record);
  };

  /** Every texture and storage buffer the parked object binds still exists. */
  const parkedDrawable = (previous) => {
    const backend = renderer.backend;
    try {
      if (!pipelineIsReady(pipelines, previous.pipeline)) return false;
      if (!previous.geometry || previous.geometry !== previous.object?.geometry) return false;
      for (const group of previous.getBindings()) {
        // The bind group itself must still be created — a group whose GPU
        // object went away with a refcount reaching zero elsewhere would be
        // re-created by three for a live object, never for a parked one.
        if (backend.has?.(group) && !backend.get(group)?.group) return false;
        for (const binding of group.bindings ?? []) {
          if (binding.isSampledTexture) {
            const texture = binding.texture;
            if (!texture || !backend.has?.(texture) || !backend.get(texture)?.texture) return false;
          } else if (binding.isStorageBuffer) {
            const attribute = binding.attribute;
            if (!attribute || !backend.has?.(attribute) || !backend.get(attribute)?.buffer) return false;
          } else if (binding.isUniformBuffer) {
            // `Bindings._update` writes the uniform through `backend.get(binding)
            // .buffer`; a destroyed one is a TypeError inside three's own path,
            // not a validation error we could catch.
            if (!backend.has?.(binding) || !backend.get(binding)?.buffer) return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  /** Draw the parked predecessor in the replacement's place for this frame. */
  const drawParked = (holder, record) => {
    if (record.released || record.dropped) { releaseParked(holder); return false; }
    const previous = record.renderObject;
    if (inBundle() || !parkedDrawable(previous)) {
      state.parkedDropped++;
      releaseParked(holder);
      return false;
    }
    previous.camera = holder.camera;
    previous.drawRange = holder.drawRange;
    previous.group = holder.group;
    try {
      renderer._geometries.updateForRender(previous);
      renderer._nodes.updateForRender(previous);
      renderer._bindings.updateForRender(previous);
      renderer.backend.draw(previous, renderer.info);
      state.parkedDraws++;
      return true;
    } catch (error) {
      if (!warnedDrawFailure) {
        warnedDrawFailure = true;
        console.warn("[asyncRenderPipelines] drawing a parked render object failed; it was dropped", error);
      }
      state.parkedDropped++;
      releaseParked(holder);
      return false;
    }
  };

  const originalIsReady = pipelines.isReady;
  if (typeof originalIsReady === "function") {
    pipelines.isReady = function (renderObject) {
      let ready = false;
      try { ready = originalIsReady.call(this, renderObject); } catch { ready = false; }
      const record = renderObject?.__previousDraw;
      if (record) {
        if (ready) { releaseParked(renderObject); return true; }
        if (!standInsEnabled()) { releaseParked(renderObject); return false; }
        drawParked(renderObject, record);
        return false;
      }
      let data = null;
      try { data = this.get(renderObject); } catch { return ready; }
      const standIn = data?.__standIn;
      if (standIn === undefined || standIn === null) return ready;
      if (ready) {
        delete data.__standIn;
        renderObject.pipeline = data.pipeline;
        return true;
      }
      if (standInsEnabled() && !inBundle() && pipelineIsReady(this, standIn)) {
        renderObject.pipeline = standIn;
        return true;
      }
      delete data.__standIn;
      renderObject.pipeline = data.pipeline;
      return false;
    };
  }

  if (canPark) {
    const originalObjectsGet = objects.get;
    objects.get = function (...args) {
      inObjectsGet++;
      try {
        return originalObjectsGet.apply(this, args);
      } finally {
        inObjectsGet--;
        if (inObjectsGet === 0 && parkedCandidate) {
          // Disposed inside `get` but no replacement adopted it (a different
          // chain, or three's shape moved): retire it now, exactly as three
          // would have.
          const orphan = parkedCandidate;
          parkedCandidate = null;
          releaseRecord(orphan);
        }
      }
    };

    const originalCreate = objects.createRenderObject;
    objects.createRenderObject = function (...args) {
      const renderObject = originalCreate.apply(this, args);
      const passId = args[10];
      const chainMap = this.getChainMap(passId);
      const registry = this;
      const fullDelete = () => {
        try { registry.pipelines.delete(renderObject); } catch { /* already gone */ }
        try { registry.bindings.deleteForRender(renderObject); } catch { /* already gone */ }
        try { registry.nodes.delete(renderObject); } catch { /* already gone */ }
      };
      renderObject.onDispose = () => {
        try { chainMap.delete(renderObject.getChainArray()); } catch { /* three's shape moved */ }
        const inherited = renderObject.__previousDraw;
        renderObject.__previousDraw = null;
        parkedHolders.delete(renderObject);
        if (inObjectsGet > 0 && standInsEnabled()) {
          // Disposed by `RenderObjects.get` because its cache key moved — a
          // re-mint. If it was drawing, park it for the replacement that `get`
          // is about to create; if it was itself still compiling but held a
          // parked predecessor, hand that predecessor down instead.
          let drawing = false;
          try {
            const data = pipelines.get(renderObject);
            drawing = pipelineIsReady(pipelines, data?.pipeline) || pipelineIsReady(pipelines, data?.__standIn);
          } catch { drawing = false; }
          if (drawing) {
            if (inherited) releaseRecord(inherited);
            const record = {
              renderObject,
              release: fullDelete,
              at: now(),
              released: false,
              dropped: false,
              holder: null,
              unhook: null,
            };
            // The parked object's own dispose listeners were removed by
            // `RenderObject.dispose()`; a material or geometry disposed while
            // it is parked must retire it, not leave it drawing freed buffers.
            const onGone = () => {
              record.dropped = true;
              const holder = record.holder;
              if (holder && holder.__previousDraw === record) releaseParked(holder);
              else releaseRecord(record);
            };
            try {
              renderObject.material?.addEventListener?.("dispose", onGone);
              renderObject.geometry?.addEventListener?.("dispose", onGone);
              record.unhook = () => {
                renderObject.material?.removeEventListener?.("dispose", onGone);
                renderObject.geometry?.removeEventListener?.("dispose", onGone);
              };
            } catch { record.unhook = null; }
            if (parkedCandidate) releaseRecord(parkedCandidate);
            parkedCandidate = record;
            state.parkedLive++;
            return;
          }
          if (inherited) {
            if (parkedCandidate) releaseRecord(parkedCandidate);
            parkedCandidate = inherited;
            fullDelete();
            return;
          }
        }
        if (inherited) releaseRecord(inherited);
        fullDelete();
      };
      if (parkedCandidate && sameChain(parkedCandidate.renderObject, renderObject)) {
        const record = parkedCandidate;
        parkedCandidate = null;
        record.holder = renderObject;
        renderObject.__previousDraw = record;
        parkedHolders.add(renderObject);
        state.parked++;
      }
      return renderObject;
    };

    state.sweep = () => {
      const t = now();
      if (t - lastSweep < state.sweepIntervalMs) return;
      lastSweep = t;
      for (const holder of parkedHolders) {
        const record = holder.__previousDraw;
        if (!record || record.released || t - record.at > PARKED_TTL_MS) releaseParked(holder);
      }
    };

    // ── the build budget ────────────────────────────────────────────────────
    const originalDirect = renderer._renderObjectDirect;
    const nodes = renderer._nodes;
    if (typeof originalDirect === "function" && nodes?.nodeBuilderCache instanceof Map) {
      renderer._renderObjectDirect = function (object, material, scene, camera, lightsNode, group, clippingContext, passId) {
        const budget = globalThis.__asyncRenderPipelinesBuildBudgetMs === undefined
          ? state.buildBudgetMs
          : Number(globalThis.__asyncRenderPipelinesBuildBudgetMs) || 0;
        if (!state.active || budget <= 0 || !standInsEnabled() || this._currentRenderBundle != null || renderingPMREM()) {
          return originalDirect.apply(this, arguments);
        }
        let renderObject = null;
        try {
          renderObject = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
        } catch {
          renderObject = null;
        }
        const needsBuild = !!renderObject
          && renderObject._nodeBuilderState == null
          && !nodes.nodeBuilderCache.has(renderObject.initialCacheKey);
        if (!needsBuild) return originalDirect.apply(this, arguments);
        if (state.frameBuildMs > 0 && state.frameBuildMs >= budget) {
          // The frame has built its share: this object waits. Its parked
          // predecessor, if any, holds the picture meanwhile.
          state.buildsDeferred++;
          const record = renderObject.__previousDraw;
          if (record) {
            renderObject.drawRange = object.geometry?.drawRange ?? renderObject.drawRange;
            renderObject.group = group;
            drawParked(renderObject, record);
          }
          return;
        }
        const t0 = now();
        try {
          return originalDirect.apply(this, arguments);
        } finally {
          state.frameBuildMs += now() - t0;
          state.builds++;
        }
      };
    }
  }

  state.beginFrame = () => {
    state.frameBuildMs = 0;
    state.sweep?.();
  };

  pipelines.__asyncRenderPipelines = state;
  return state;
}
