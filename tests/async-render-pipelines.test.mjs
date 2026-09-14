/**
 * NO PIPELINE IS CREATED SYNCHRONOUSLY INSIDE THE MAIN RENDER — AND A RE-MINT
 * KEEPS DRAWING WHAT IT DREW BEFORE.
 *
 * `installAsyncRenderPipelines` routes pipelines through
 * `createRenderPipelineAsync` so the driver compiles them off the GPU
 * process's command thread. three skips the draw entirely while
 * `_pipelines.isReady()` is false, and `isReady` reads the render object's
 * CURRENT pipeline — so the async path alone replaces a ready pipeline with a
 * compiling one, and the object disappears until the driver is done.
 *
 * ⛔ THE FIRST REPORT (2026-09-07): *"every mesh I select disappears for a
 * moment, and then gets back"*. The fix then was "never defer a re-mint":
 * compile it synchronously, accept the hitch.
 * ⛔ THE SECOND REPORT (2026-09-09): that hitch measured **21 528 ms** in one
 * block on the user's Foliage scene — ten synchronous re-mints of a 70 kB
 * program parking the GPU process, with the page's main thread blocked behind
 * it. So a re-mint is now deferred too, and the object keeps drawing its
 * PREVIOUS program meanwhile: the previous pipeline when three keeps the render
 * object (a render-state change), the previous render object whole when three
 * re-creates it (a cache-key change — lights, environment, fog, shadow map, a
 * material slot).
 *
 * These drive the real installer against fakes shaped like three's `Pipelines`,
 * `RenderObjects` and backend — including the part that made the FIRST version
 * of the 2026-09-07 fix useless: `getForRender` RELEASES the previous pipeline
 * before it reaches `_getRenderPipeline`, so a check made there finds no
 * evidence the object was ever drawing. The fakes reproduce the release, and
 * the dispose-then-recreate shape of `RenderObjects.get`, for that reason.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installAsyncRenderPipelines, PARKED_TTL_MS } from "../src/engine/asyncRenderPipelines.js";
import { freeze } from "../src/engine/freezeLedger.js";

/** Burn wall-clock, the way a node-graph build does. */
function busy(ms) {
  const end = performance.now() + ms;
  // eslint-disable-next-line no-empty
  while (performance.now() < end) {}
}

/** WGSL long enough to clear the size gate the installer applies. */
const BIG = { code: "x".repeat(300_000) };
const SMALL = { code: "x".repeat(16) };

/** Which stage size a given render object should report. */
const stageSizes = new Map();
const stageFor = (renderObject) => stageSizes.get(renderObject) ?? BIG;

/**
 * A stand-in for three's `Pipelines` + backend. `ready` names the render
 * objects whose existing pipeline has finished compiling.
 */
function makePipelines({ ready = new Set() } = {}) {
  const backendData = new Map();
  const objectData = new Map();
  const calls = [];
  const pipelines = {
    backend: { get: (pipeline) => backendData.get(pipeline) ?? {} },
    get: (renderObject) => objectData.get(renderObject) ?? {},
    _getRenderPipeline(renderObject, stageVertex, stageFragment, cacheKey, promises) {
      // `promises == null` is three's own signal for "compile synchronously".
      calls.push({ renderObject, deferred: promises != null });
      return { id: cacheKey };
    },
    /**
     * three's real shape, and the part that made the FIRST version of this fix
     * useless: `getForRender` RELEASES the previous pipeline before reaching
     * `_getRenderPipeline`, so an inner check finds nothing. The readiness has
     * to be captured on the way in, and only a fake that reproduces the
     * release can prove it is.
     */
    getForRender(renderObject, promises = null) {
      const previous = objectData.get(renderObject)?.pipeline;
      if (previous) { backendData.delete(previous); objectData.delete(renderObject); }
      return this._getRenderPipeline(renderObject, SMALL, stageFor(renderObject), "cache", promises);
    },
    // Test helpers.
    __calls: calls,
    __give(renderObject, { compiled }) {
      const pipeline = { tag: renderObject };
      objectData.set(renderObject, { pipeline });
      backendData.set(pipeline, { pipeline: compiled ? {} : null });
    },
  };
  for (const renderObject of ready) pipelines.__give(renderObject, { compiled: true });
  return pipelines;
}

function install(pipelines) {
  const state = installAsyncRenderPipelines({ _pipelines: pipelines });
  state.active = true;
  return state;
}

test("a FIRST compile of a big pipeline is deferred", () => {
  const pipelines = makePipelines();
  const state = install(pipelines);

  pipelines.getForRender("newObject", null);

  assert.equal(pipelines.__calls[0].deferred, true, "nothing is on screen yet, so the driver can take its time");
  assert.equal(state.deferred, 1);
});

/**
 * ⭐ 09-14, Complex scene: a matHalf wave re-minted 48 `ShadowMaterial`
 * variants as SYNC pipelines inside the shadow pass (29 in 0.4 s) behind a busy
 * driver, then 10-25 s stalls. Inside a shadow map that nothing caches, the
 * busy gate defers them like canvas draws; a map that CAN be cached, or any
 * other offscreen target, stays synchronous.
 */
const SHADOW_TARGET = { texture: { name: "ShadowMap" }, depthTexture: { name: "ShadowDepthTexture" } };

function shadowPassFixture({ target, redrawnEveryFrame = true }) {
  const pipelines = makePipelines();
  const renderer = { _pipelines: pipelines, getRenderTarget: () => target, __shadowMapsRedrawnEveryFrame: redrawnEveryFrame };
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  return { pipelines, state };
}

function withBusyDriver(run) {
  const ticket = { bytes: 50_000 };
  freeze.asyncInFlight.set(ticket, ticket);
  try { return run(); } finally { freeze.asyncInFlight.delete(ticket); }
}

test("⭐ busy driver: a small first compile inside an uncached shadow map is deferred", () => {
  withBusyDriver(() => {
    const { pipelines, state } = shadowPassFixture({ target: SHADOW_TARGET });
    stageSizes.set("shadowCaster", SMALL);
    pipelines.getForRender("shadowCaster", null);
    assert.equal(pipelines.__calls[0].deferred, true, "a caster skipped this frame is drawn into next frame's map");
    assert.equal(state.deferredShadowWhileBusy, 1);
  });
});

test("⛔ a shadow map that may be CACHED stays synchronous, and so does any other offscreen target", () => {
  withBusyDriver(() => {
    for (const [label, options] of [
      ["shadowFreeze may freeze this map", { target: SHADOW_TARGET, redrawnEveryFrame: false }],
      ["a clipmap static cache", { target: { texture: { name: "ClipmapStaticColor0" }, depthTexture: { name: "ClipmapStaticDepth0" } } }],
      ["an impostor bake / picking target", { target: { texture: { name: "" } } }],
    ]) {
      const { pipelines } = shadowPassFixture(options);
      const object = `caster:${label}`;
      stageSizes.set(object, SMALL);
      pipelines.getForRender(object, null);
      assert.equal(pipelines.__calls[0].deferred, false, `${label}: must compile synchronously`);
    }
  });
});

/**
 * ⛔ 09-14, Complex scene: every shadow rendered pitch black because PMREM's
 * blur/GGX mips — drawn once, inside the presenting render, into a
 * `PMREM.cubeUv` target — were deferred and never redrawn, so diffuse sky
 * light was zero for the session (environment ×40 changed nothing).
 */
test("⛔ a big first compile inside a PMREM target is never deferred", () => {
  withBusyDriver(() => {
    const { pipelines, state } = shadowPassFixture({ target: { texture: { name: "PMREM.cubeUv", isPMREMTexture: true } } });
    pipelines.getForRender("pmremBlur", null);
    assert.equal(pipelines.__calls[0].deferred, false, "a skipped PMREM mip is black forever");
    assert.equal(state.deferred, 0);
  });
});

test("`__asyncRenderPipelinesShadowBusyGate = false` restores the synchronous shadow pass", () => {
  globalThis.__asyncRenderPipelinesShadowBusyGate = false;
  try {
    withBusyDriver(() => {
      const { pipelines } = shadowPassFixture({ target: SHADOW_TARGET });
      stageSizes.set("hatchCaster", SMALL);
      pipelines.getForRender("hatchCaster", null);
      assert.equal(pipelines.__calls[0].deferred, false);
    });
  } finally {
    delete globalThis.__asyncRenderPipelinesShadowBusyGate;
  }
});

test("a RE-MINT with nothing to stand in for it is NOT deferred", () => {
  // This object already has a compiled pipeline on screen, but the fake's
  // pipelines carry no programs, so the previous one cannot stand in for the
  // new one. Handing the replacement to the async path would make the object
  // vanish — so it compiles synchronously, the 2026-09-07 rule.
  const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
  const state = install(pipelines);

  pipelines.getForRender("visibleObject", null);

  assert.equal(
    pipelines.__calls[0].deferred, false,
    "a visible object must not be traded for an invisible one while its new program compiles",
  );
  assert.equal(state.deferred, 0, "and it is not counted as a deferral either");
});

test("an object whose existing pipeline is STILL COMPILING is treated as a first compile", () => {
  // It is not on screen — there is nothing to protect — so the async path is
  // still the right trade. This is the case a naive "has a pipeline object"
  // check would get wrong.
  const pipelines = makePipelines();
  pipelines.__give("pendingObject", { compiled: false });
  install(pipelines);

  pipelines.getForRender("pendingObject", null);
  assert.equal(pipelines.__calls[0].deferred, true);
});

test("small pipelines are never deferred on a first compile", () => {
  const pipelines = makePipelines();
  install(pipelines);
  stageSizes.set("tinyObject", SMALL);
  pipelines.getForRender("tinyObject", null);
  assert.equal(pipelines.__calls[0].deferred, false, "the size gate still comes first");
});

test("the hatch restores deferring every pipeline", () => {
  globalThis.__asyncRenderPipelinesRemint = true;
  try {
    const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
    install(pipelines);
    pipelines.getForRender("visibleObject", null);
    assert.equal(pipelines.__calls[0].deferred, true, "the A/B arm for measuring what the hitch costs");
  } finally {
    delete globalThis.__asyncRenderPipelinesRemint;
  }
});

test("a caller that already passed a promises array is left alone", () => {
  // That is the compile wave collecting its own promises. Overriding it there
  // would serialise the wave against itself.
  const pipelines = makePipelines();
  install(pipelines);
  const collected = [];
  pipelines.getForRender("waveObject", collected);
  assert.equal(pipelines.__calls[0].deferred, true, "the caller's own array is passed through");
});

test("internals that do not match three's shape fall back to deferring", () => {
  // A three upgrade that renames `backend.get` must not silently make EVERY
  // pipeline synchronous — that would turn a compile wave back into the 30 s
  // freeze the async path exists to prevent.
  const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
  pipelines.get = () => { throw new Error("three moved this"); };
  const state = install(pipelines);

  pipelines.getForRender("visibleObject", null);
  assert.equal(pipelines.__calls[0].deferred, true);
  assert.equal(state.deferred, 1);
});

// ═══ THE STAND-IN: same render object, new pipeline, same programs ══════════

/**
 * A `Pipelines` fake whose pipelines carry programs, like three's — a
 * render-state change mints a NEW pipeline object from the SAME two
 * `ProgrammableStage`s, which is what makes the previous one a valid stand-in.
 * `__land(pipeline)` is the driver finishing an async compile.
 */
function makeProgramPipelines() {
  const backendData = new Map();
  const objectData = new Map();
  const V = { code: "v".repeat(20_000), name: "vertex" };
  const F = { code: "f".repeat(60_000), name: "fragment" };
  const calls = [];
  let nextId = 1;
  const pipelines = {
    backend: {
      get: (pipeline) => backendData.get(pipeline) ?? {},
    },
    get(renderObject) {
      let data = objectData.get(renderObject);
      if (!data) { data = {}; objectData.set(renderObject, data); }
      return data;
    },
    _getRenderPipeline(renderObject, stageVertex, stageFragment, cacheKey, promises) {
      const pipeline = { id: nextId++, vertexProgram: stageVertex, fragmentProgram: stageFragment, usedTimes: 0 };
      calls.push({ renderObject, pipeline, deferred: promises != null });
      // Sync creation is ready at once; async lands when the test says so.
      backendData.set(pipeline, { pipeline: promises == null ? {} : null });
      renderObject.pipeline = pipeline;
      return pipeline;
    },
    getForRender(renderObject, promises = null) {
      const data = this.get(renderObject);
      if (renderObject.needsRenderUpdate || data.pipeline === undefined) {
        renderObject.needsRenderUpdate = false;
        const previous = data.pipeline;
        if (previous) previous.usedTimes--;
        const stages = renderObject.programs ?? [V, F];
        const pipeline = this._getRenderPipeline(renderObject, stages[0], stages[1], `k${nextId}`, promises);
        pipeline.usedTimes++;
        data.pipeline = pipeline;
      }
      return data.pipeline;
    },
    isReady(renderObject) {
      const pipeline = this.get(renderObject).pipeline;
      if (pipeline === undefined) return false;
      const data = backendData.get(pipeline);
      return data?.pipeline !== undefined && data?.pipeline !== null;
    },
    __calls: calls,
    __land(pipeline) { backendData.set(pipeline, { pipeline: {} }); },
    __programs: [V, F],
  };
  return pipelines;
}

test("a same-object re-mint is deferred and the previous pipeline stands in until the new one lands", () => {
  const pipelines = makeProgramPipelines();
  const state = install(pipelines);
  const ro = { name: "wall" };

  // First compile: async, absent until it lands — then drawing.
  const first = pipelines.getForRender(ro);
  assert.equal(pipelines.__calls[0].deferred, true);
  assert.equal(pipelines.isReady(ro), false, "a first compile has nothing to stand in");
  pipelines.__land(first);
  assert.equal(pipelines.isReady(ro), true);

  // A render-state change (side / blending): three mints a new pipeline from
  // the same programs. It must go async, and the object must keep drawing.
  ro.needsRenderUpdate = true;
  const second = pipelines.getForRender(ro);
  assert.notEqual(second, first);
  assert.equal(pipelines.__calls[1].deferred, true, "the re-mint compiles on the driver's threads");
  assert.equal(pipelines.isReady(ro), true, "isReady says draw — with the stand-in");
  assert.equal(ro.pipeline, first, "backend.draw reads renderObject.pipeline, which is the PREVIOUS pipeline");
  assert.equal(state.standIns, 1);

  // Another frame, still compiling: still the stand-in.
  pipelines.getForRender(ro);
  assert.equal(pipelines.isReady(ro), true);
  assert.equal(ro.pipeline, first);

  // The driver lands the new one: the object switches over that frame.
  pipelines.__land(second);
  assert.equal(pipelines.isReady(ro), true);
  assert.equal(ro.pipeline, second, "the new pipeline replaces the stand-in the frame it is ready");
});

test("a same-object re-mint with DIFFERENT programs still compiles synchronously", () => {
  // The previous pipeline's bind group layout no longer matches: nothing can
  // stand in, so the 2026-09-07 rule holds (one hitch beats a hole).
  const pipelines = makeProgramPipelines();
  install(pipelines);
  const ro = { name: "glass" };
  const first = pipelines.getForRender(ro);
  pipelines.__land(first);
  ro.needsRenderUpdate = true;
  ro.programs = [{ code: "v2".repeat(10_000) }, { code: "f2".repeat(30_000) }];
  pipelines.getForRender(ro);
  assert.equal(pipelines.__calls[1].deferred, false);
  assert.equal(pipelines.isReady(ro), true, "compiled synchronously, so it is ready at once");
});

test("a same-object re-mint OUTSIDE the main render stays synchronous", () => {
  // A one-shot pass (a bake, the outline mask) wants its new render state now;
  // drawing the previous state into it would be a wrong result, not a stall.
  const pipelines = makeProgramPipelines();
  const state = install(pipelines);
  const ro = { name: "bakeTarget" };
  const first = pipelines.getForRender(ro);
  pipelines.__land(first);
  state.active = false;
  ro.needsRenderUpdate = true;
  pipelines.getForRender(ro);
  assert.equal(pipelines.__calls[1].deferred, false);
});

test("`__asyncRenderPipelinesStandIn = false` restores the synchronous re-mint", () => {
  globalThis.__asyncRenderPipelinesStandIn = false;
  try {
    const pipelines = makeProgramPipelines();
    install(pipelines);
    const ro = { name: "wall" };
    const first = pipelines.getForRender(ro);
    pipelines.__land(first);
    ro.needsRenderUpdate = true;
    pipelines.getForRender(ro);
    assert.equal(pipelines.__calls[1].deferred, false, "the 2026-09-07 arm");
  } finally {
    delete globalThis.__asyncRenderPipelinesStandIn;
  }
});

// ═══ PARKING: new render object, the previous one drawn until it lands ═══════

/**
 * A renderer fake with the pieces the parking path touches: `_objects`
 * (three's RenderObjects: `get` DISPOSES a render object whose cache key moved
 * and recreates it through `createRenderObject`), `_pipelines` with programs,
 * `_nodes` / `_bindings` / `_geometries` update hooks, and a backend whose
 * `draw` records what was drawn. Resource deletes are recorded so the test can
 * see WHEN the parked object was retired.
 */
function makeRenderer() {
  const pipelines = makeProgramPipelines();
  const deleted = { pipelines: [], bindings: [], nodes: [] };
  const draws = [];
  const updates = [];
  const backendTextures = new Set();
  const backendAttributes = new Set();
  const pipelineBackend = pipelines.backend;
  const backend = {
    has: (resource) => backendTextures.has(resource) || backendAttributes.has(resource),
    get: (resource) => {
      if (backendTextures.has(resource)) return { texture: {} };
      if (backendAttributes.has(resource)) return { buffer: {} };
      return pipelineBackend.get(resource);
    },
    draw: (renderObject) => draws.push(renderObject),
  };
  pipelines.backend = backend;
  pipelines.delete = (ro) => deleted.pipelines.push(ro);
  const nodes = {
    delete: (ro) => deleted.nodes.push(ro),
    updateForRender: (ro) => updates.push(["nodes", ro]),
    nodeBuilderCache: new Map(),
  };
  // three's `Bindings` is a `DataMap`, and the flag that matters here is
  // `initialized`: `getForRender` raises it the first time it CREATES this
  // object's bind groups (incrementing `usedTimes` on each, including the
  // SHARED `render` group every object in the context binds), and it is the
  // only evidence a later `deleteForRender` has that there is anything to
  // decrement. The fake carries it so a delete for an object that never drew
  // is visible as the unbalanced decrement it would be against three.
  const bindingsData = new Map();
  const bindings = {
    has: (object) => bindingsData.has(object),
    get(object) {
      let data = bindingsData.get(object);
      if (data === undefined) { data = {}; bindingsData.set(object, data); }
      return data;
    },
    delete: (object) => bindingsData.delete(object),
    deleteForRender(ro) { deleted.bindings.push(ro); bindingsData.delete(ro); },
    updateForRender(ro) { updates.push(["bindings", ro]); this.get(ro).initialized = true; },
  };
  const geometries = { updateForRender: (ro) => updates.push(["geometries", ro]) };

  class ChainMap {
    constructor() { this.map = new Map(); }
    key(keys) { return keys.map((k) => (k == null ? "null" : (k.id ?? k.name ?? String(k)))).join("|"); }
    get(keys) { return this.map.get(this.key(keys)); }
    set(keys, value) { this.map.set(this.key(keys), value); }
    delete(keys) { return this.map.delete(this.key(keys)); }
  }
  let roId = 1;
  const objects = {
    pipelines, bindings, nodes,
    chainMaps: {},
    getChainMap(passId = "default") { return this.chainMaps[passId] || (this.chainMaps[passId] = new ChainMap()); },
    createRenderObject(nodesArg, geometriesArg, rendererArg, object, material, scene, camera, lightsNode, renderContext, clippingContext, passId) {
      const chainMap = this.getChainMap(passId);
      const ro = {
        id: roId++,
        isRenderObject: true,
        object, material, scene, camera, lightsNode, context: renderContext,
        geometry: object.geometry,
        pipeline: null, drawRange: null, group: null,
        cacheKey: material.cacheKey,
        initialCacheKey: `${material.cacheKey}|${object.name}|${renderContext?.name ?? ""}`,
        _nodeBuilderState: null,
        programs: material.programs,
        bindings: material.bindings ?? [],
        getChainArray() { return [this.object, this.material, this.context, this.lightsNode]; },
        getBindings() { return this.bindings; },
        dispose() { this.onDispose(); },
      };
      ro.onDispose = () => {
        this.pipelines.delete(ro);
        this.bindings.deleteForRender(ro);
        this.nodes.delete(ro);
        chainMap.delete(ro.getChainArray());
      };
      return ro;
    },
    get(object, material, scene, camera, lightsNode, renderContext, clippingContext, passId) {
      const chainMap = this.getChainMap(passId);
      const keys = [object, material, renderContext, lightsNode];
      let ro = chainMap.get(keys);
      if (ro === undefined) {
        ro = this.createRenderObject(nodes, geometries, renderer, object, material, scene, camera, lightsNode, renderContext, clippingContext, passId);
        chainMap.set(keys, ro);
      } else {
        ro.camera = camera;
        if (ro.cacheKey !== material.cacheKey) {
          // three: the cache key moved → dispose and recreate.
          ro.dispose();
          ro = this.get(object, material, scene, camera, lightsNode, renderContext, clippingContext, passId);
        }
      }
      return ro;
    },
  };
  const builds = [];
  const renderer = {
    _pipelines: pipelines, _objects: objects, _nodes: nodes, _bindings: bindings, _geometries: geometries,
    backend, info: {}, _currentRenderBundle: null, _currentRenderContext: null,
    __deleted: deleted, __draws: draws, __updates: updates, __builds: builds,
    __textures: backendTextures, __attributes: backendAttributes,
    /** three's `_renderObjectDirect`, with the node-graph build it implies. */
    _renderObjectDirect(object, material, scene, camera, lightsNode, group, clippingContext, passId) {
      const ro = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
      ro.drawRange = object.geometry?.drawRange ?? null;
      ro.group = group;
      if (ro._nodeBuilderState == null) {
        let built = nodes.nodeBuilderCache.get(ro.initialCacheKey);
        if (!built) {
          busy(material.buildMs ?? 0);
          built = { key: ro.initialCacheKey };
          nodes.nodeBuilderCache.set(ro.initialCacheKey, built);
          builds.push(ro);
        }
        ro._nodeBuilderState = built;
      }
      // three's order: the bind groups are created (and refcounted) BEFORE the
      // pipeline, which reads their layouts. An object the budget defers never
      // reaches this line.
      this._bindings.updateForRender(ro);
      this._pipelines.getForRender(ro);
      if (this._pipelines.isReady(ro)) this.backend.draw(ro, this.info);
    },
  };
  return renderer;
}

/** One `_renderObjectDirect` as three does it: get → pipeline → isReady → draw. */
function renderOnce(renderer, chain) {
  const { object, material, scene, camera, lightsNode, context } = chain;
  const ro = renderer._objects.get(object, material, scene, camera, lightsNode, context, null, undefined);
  renderer._bindings.updateForRender(ro);
  renderer._pipelines.getForRender(ro);
  const ready = renderer._pipelines.isReady(ro);
  if (ready) renderer.backend.draw(ro, renderer.info);
  return { ro, ready };
}

function makeChain(renderer, { bindings = [] } = {}) {
  const texture = { name: "albedo" };
  renderer.__textures.add(texture);
  return {
    object: { name: "obj", geometry: { name: "geom", addEventListener() {}, removeEventListener() {} } },
    material: {
      name: "mat", cacheKey: "A",
      bindings: [{ bindings: [{ isSampledTexture: true, texture }, ...bindings] }],
      addEventListener() {}, removeEventListener() {},
    },
    scene: { name: "scene" }, camera: { name: "cam" }, lightsNode: { name: "lights" }, context: { name: "ctx" },
    texture,
  };
}

test("a re-created render object draws its parked predecessor until its pipeline lands, then releases it", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);

  // Boot: first compile, absent, then landed and drawing.
  const a = renderOnce(renderer, chain);
  assert.equal(a.ready, false);
  renderer._pipelines.__land(a.ro.pipeline);
  assert.equal(renderOnce(renderer, chain).ready, true);
  const A = a.ro;

  // A lights wave: the material cache key moves, three disposes A and
  // creates B. Nothing is deleted yet; B's pipeline goes async; A draws.
  chain.material.cacheKey = "B";
  const b = renderOnce(renderer, chain);
  const B = b.ro;
  assert.notEqual(B, A, "three re-created the render object");
  assert.equal(renderer._pipelines.__calls.at(-1).deferred, true, "the replacement compiles on the driver's threads");
  assert.equal(b.ready, false, "the replacement is reported not ready");
  assert.deepEqual(renderer.__draws.at(-1), A, "…and the PARKED predecessor was drawn in its place");
  assert.equal(renderer.__deleted.pipelines.length, 0, "A's resources are still alive");
  assert.equal(state.parked, 1);
  assert.equal(state.parkedLive, 1);
  assert.equal(state.parkedDraws, 1);
  // The tail, not the whole list: A's own live frames refreshed its bindings
  // too (that is what raised `initialized` on it). These last three are the
  // PARKED draw's refresh.
  const updated = renderer.__updates.filter(([, ro]) => ro === A).map(([what]) => what);
  assert.deepEqual(updated.slice(-3), ["geometries", "nodes", "bindings"], "the parked object's uniforms and bindings are refreshed before the draw");

  // Next frame, still compiling: A again.
  const drawsBefore = renderer.__draws.length;
  assert.equal(renderOnce(renderer, chain).ready, false);
  assert.equal(renderer.__draws.length, drawsBefore + 1);
  assert.equal(renderer.__draws.at(-1), A);

  // The driver lands B: B draws, A is released exactly once.
  renderer._pipelines.__land(B.pipeline);
  const landed = renderOnce(renderer, chain);
  assert.equal(landed.ready, true);
  assert.equal(renderer.__draws.at(-1), B);
  assert.deepEqual(renderer.__deleted.pipelines, [A]);
  assert.deepEqual(renderer.__deleted.bindings, [A]);
  assert.deepEqual(renderer.__deleted.nodes, [A]);
  assert.equal(state.parkedLive, 0);
  renderOnce(renderer, chain);
  assert.deepEqual(renderer.__deleted.pipelines, [A], "released once, not once per frame");
});

test("a parked predecessor whose texture is gone is dropped, not drawn", () => {
  // The old light's disposed shadow map is this case: the parked graph binds
  // a texture the backend no longer has. Drawing it would be a validation
  // error that drops the whole submit, so the object is absent for the
  // compile instead — exactly what the async path did before parking.
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  const A = renderOnce(renderer, chain).ro;
  renderer._pipelines.__land(A.pipeline);
  renderOnce(renderer, chain);

  chain.material.cacheKey = "B";
  renderer.__textures.delete(chain.texture);
  const drawsBefore = renderer.__draws.length;
  const b = renderOnce(renderer, chain);
  assert.equal(b.ready, false);
  assert.equal(renderer.__draws.length, drawsBefore, "nothing was drawn");
  assert.equal(state.parkedDropped, 1);
  assert.deepEqual(renderer.__deleted.pipelines, [A], "and the parked object was retired at once");
});

test("a chain of re-mints hands the parked predecessor down to the newest replacement", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  const A = renderOnce(renderer, chain).ro;
  renderer._pipelines.__land(A.pipeline);
  renderOnce(renderer, chain);

  chain.material.cacheKey = "B";
  const B = renderOnce(renderer, chain).ro;
  chain.material.cacheKey = "C";   // before B ever landed
  const c = renderOnce(renderer, chain);
  const C = c.ro;
  assert.notEqual(C, B);
  assert.equal(c.ready, false);
  assert.equal(renderer.__draws.at(-1), A, "A still stands in — for C now");
  assert.deepEqual(renderer.__deleted.pipelines, [B], "B, which never drew, was deleted outright");
  assert.equal(state.parkedLive, 1);

  renderer._pipelines.__land(C.pipeline);
  renderOnce(renderer, chain);
  assert.deepEqual(renderer.__deleted.pipelines, [B, A]);
});

test("a replacement with a parked predecessor is deferred even below the size gate", () => {
  // There is no absence to trade, so even a small program (a shadow-depth
  // material, an unlit one) goes async rather than parking the GPU process.
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  chain.material.programs = [{ code: "v" }, { code: "f" }];
  const A = renderOnce(renderer, chain).ro;
  assert.equal(renderer._pipelines.__calls.at(-1).deferred, false, "a small FIRST compile is synchronous");
  renderOnce(renderer, chain);
  assert.ok(A.pipeline);

  chain.material.cacheKey = "B";
  const b = renderOnce(renderer, chain);
  assert.equal(renderer._pipelines.__calls.at(-1).deferred, true, "the small RE-MINT is not");
  assert.equal(b.ready, false);
  assert.equal(renderer.__draws.at(-1), A);
});

test("outside the main render only a BIG replacement is deferred onto its parked predecessor", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  const A = renderOnce(renderer, chain).ro;
  renderer._pipelines.__land(A.pipeline);
  renderOnce(renderer, chain);

  state.active = false;
  chain.material.cacheKey = "B";
  renderOnce(renderer, chain);
  assert.equal(renderer._pipelines.__calls.at(-1).deferred, true, "a 60 kB program would park the GPU process: async");

  const renderer2 = makeRenderer();
  const state2 = installAsyncRenderPipelines(renderer2);
  state2.active = true;
  const chain2 = makeChain(renderer2);
  chain2.material.programs = [{ code: "v" }, { code: "f" }];
  renderOnce(renderer2, chain2);
  renderOnce(renderer2, chain2);
  state2.active = false;
  chain2.material.cacheKey = "B";
  renderOnce(renderer2, chain2);
  assert.equal(renderer2._pipelines.__calls.at(-1).deferred, false, "a tiny one in a one-shot pass stays synchronous");
});

test("a parked predecessor older than the TTL is released by the per-frame sweep", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  const A = renderOnce(renderer, chain).ro;
  renderer._pipelines.__land(A.pipeline);
  renderOnce(renderer, chain);
  chain.material.cacheKey = "B";
  const B = renderOnce(renderer, chain).ro;
  assert.equal(state.parkedLive, 1);

  // The object is culled: nobody draws B again, its pipeline never lands.
  B.__previousDraw.at -= PARKED_TTL_MS + 1;
  state.sweepIntervalMs = 0;
  installAsyncRenderPipelines(renderer);   // the per-frame call
  assert.equal(state.parkedLive, 0);
  assert.deepEqual(renderer.__deleted.pipelines, [A]);
});

test("disposing the parked object's material retires it", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);
  const listeners = [];
  chain.material.addEventListener = (type, fn) => listeners.push([type, fn]);
  chain.material.removeEventListener = (type, fn) => {
    const i = listeners.findIndex(([t, f]) => t === type && f === fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  const A = renderOnce(renderer, chain).ro;
  renderer._pipelines.__land(A.pipeline);
  renderOnce(renderer, chain);
  chain.material.cacheKey = "B";
  renderOnce(renderer, chain);
  assert.equal(listeners.length, 1, "the parked object listens for its material's dispose");

  listeners[0][1]();   // material.dispose()
  assert.equal(state.parkedLive, 0);
  assert.deepEqual(renderer.__deleted.pipelines, [A]);
  assert.equal(listeners.length, 0, "and unhooked itself");
  const drawsBefore = renderer.__draws.length;
  renderOnce(renderer, chain);
  assert.equal(renderer.__draws.length, drawsBefore, "never drawn again");
});

test("`__asyncRenderPipelinesStandIn = false` disables parking too", () => {
  globalThis.__asyncRenderPipelinesStandIn = false;
  try {
    const renderer = makeRenderer();
    const state = installAsyncRenderPipelines(renderer);
    state.active = true;
    const chain = makeChain(renderer);
    const A = renderOnce(renderer, chain).ro;
    renderer._pipelines.__land(A.pipeline);
    renderOnce(renderer, chain);
    chain.material.cacheKey = "B";
    const drawsBefore = renderer.__draws.length;
    const b = renderOnce(renderer, chain);
    assert.deepEqual(renderer.__deleted.pipelines, [A], "three's own dispose ran at once");
    assert.equal(state.parked, 0);
    // …and the replacement is a plain first compile again: deferred, and the
    // object is ABSENT while it compiles — the hole this unit exists to close.
    assert.equal(b.ready, false);
    assert.equal(renderer.__draws.length, drawsBefore, "nothing stood in");
  } finally {
    delete globalThis.__asyncRenderPipelinesStandIn;
  }
});

// ═══ THE BUILD BUDGET: a wave of graph builds spread over frames ═════════════

/** One frame as the engine runs it: the per-frame install call, then the draws. */
function renderFrame(renderer, chains) {
  installAsyncRenderPipelines(renderer);
  for (const chain of chains) {
    const { object, material, scene, camera, lightsNode } = chain;
    renderer._renderObjectDirect(object, material, scene, camera, lightsNode, null, null, undefined);
  }
}

function makeWave(renderer, count, { buildMs = 3 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const chain = makeChain(renderer);
    chain.object.name = `obj${i}`;
    chain.material.buildMs = buildMs;
    return chain;
  });
}

test("a wave of graph builds is spread over frames, at least one per frame", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  state.buildBudgetMs = 1;               // smaller than one build, so exactly one build lands per frame
  const wave = makeWave(renderer, 4, { buildMs: 3 });

  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 1, "the first object built (a frame always builds at least one)");
  assert.equal(state.buildsDeferred, 3, "the other three waited");

  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 2);
  renderFrame(renderer, wave);
  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 4, "…and each later frame took one more");
  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 4, "nothing left to build");
  assert.equal(state.builds, 4);
});

test("a deferred object keeps drawing its parked predecessor while it waits its turn", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  state.buildBudgetMs = 1;
  const wave = makeWave(renderer, 2, { buildMs: 3 });

  // Both on screen.
  renderFrame(renderer, wave);
  renderFrame(renderer, wave);
  for (const chain of wave) {
    const ro = renderer._objects.get(chain.object, chain.material, chain.scene, chain.camera, chain.lightsNode, null, null, undefined);
    renderer._pipelines.__land(ro.pipeline);
  }
  renderFrame(renderer, wave);
  const before = renderer.__builds.slice();
  assert.equal(before.length, 2);

  // A lights wave: both re-minted in the same frame. The first rebuilds; the
  // second is over budget and draws its parked predecessor instead.
  for (const chain of wave) chain.material.cacheKey = "B";
  const drawsBefore = renderer.__draws.length;
  const deferredBefore = state.buildsDeferred;
  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 3, "one rebuild this frame");
  assert.equal(state.buildsDeferred - deferredBefore, 1);
  const drawn = renderer.__draws.slice(drawsBefore);
  assert.ok(drawn.includes(before[1]), "the second object's PARKED predecessor was drawn");
  assert.equal(state.parkedDraws >= 1, true);

  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 4, "the second rebuilt the next frame");
});

test("an object whose program another object already built is not a build and is never deferred", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  state.buildBudgetMs = 1;
  const wave = makeWave(renderer, 3, { buildMs: 3 });
  // Same material, same context, same object name → the same program key.
  for (const chain of wave) { chain.object.name = "twin"; chain.material = wave[0].material; }
  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 1, "one graph serves all three");
  assert.equal(state.buildsDeferred, 0, "the cache hits were not deferred");
});

test("outside the main render, and with the budget hatch at 0, nothing is deferred", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.buildBudgetMs = 1;
  const wave = makeWave(renderer, 3, { buildMs: 3 });
  state.active = false;
  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 3, "a one-shot pass builds everything it draws");
  assert.equal(state.buildsDeferred, 0);

  const renderer2 = makeRenderer();
  const state2 = installAsyncRenderPipelines(renderer2);
  state2.active = true;
  state2.buildBudgetMs = 1;
  globalThis.__asyncRenderPipelinesBuildBudgetMs = 0;
  try {
    renderFrame(renderer2, makeWave(renderer2, 3, { buildMs: 3 }));
    assert.equal(renderer2.__builds.length, 3, "the hatch restores one-frame waves");
  } finally {
    delete globalThis.__asyncRenderPipelinesBuildBudgetMs;
  }
});

// ═══ THE BIND-GROUP REFCOUNT: destroy only what was created ══════════════════

/**
 * ⛔ THE BOOT ERROR PAIR (2026-09-10, the user's Sponza, every boot):
 *
 *   Uncaught TypeError: Failed to execute 'writeBuffer' on 'GPUQueue':
 *     parameter 1 is not of type 'GPUBuffer'   (Bindings.updateForRender)
 *   [Buffer "bindingBuffer72_render_(vertex,fragment,compute)"] used in submit
 *     while destroyed.
 *
 * `Bindings._destroyBindings` decrements `usedTimes` on every bind group of a
 * disposed render object and, at zero, DESTROYS its uniform buffers. A SHARED
 * group (`render`, `frame`) is one `BindGroup` instance for every render
 * object in the context, so its count is the whole scene — and
 * `deleteForRender` decrements it whether or not this object ever incremented
 * it. The build budget creates render objects it does not draw; re-key one
 * before its build lands and its dispose spends a count nobody added. Enough
 * of those and the scene's shared uniform buffer is destroyed underneath it.
 */
test("a render object the budget deferred does not spend a bind-group count it never took", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  state.buildBudgetMs = 1;                       // smaller than one build
  const wave = makeWave(renderer, 2, { buildMs: 3 });

  renderFrame(renderer, wave);
  assert.equal(renderer.__builds.length, 1, "the first built");
  assert.equal(state.buildsDeferred, 1, "the second was deferred, so it never created its bind groups");

  const deferred = renderer._objects.get(
    wave[1].object, wave[1].material, wave[1].scene, wave[1].camera, wave[1].lightsNode, null, null, undefined,
  );
  assert.equal(renderer._bindings.get(deferred).initialized, undefined, "…and three never initialized it");

  // A lights wave (or any dynamic-key move) re-keys it before it ever drew.
  wave[1].material.cacheKey = "B";
  renderFrame(renderer, wave);

  assert.deepEqual(renderer.__deleted.bindings, [], "no decrement for an increment that never happened");
  assert.equal(state.unbuiltBindingDeletes, 1, "…and the skip is counted, not silent");
  assert.equal(renderer._bindings.has(deferred), false, "the DataMap entry is still dropped");
});

test("a render object that DID draw is still deleted normally", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  const chain = makeChain(renderer);

  const A = renderOnce(renderer, chain).ro;
  assert.equal(renderer._bindings.get(A).initialized, true);

  // Re-key it while its pipeline is still compiling: nothing to park, so
  // three's delete runs whole — the count A took is the count A gives back.
  chain.material.cacheKey = "B";
  renderOnce(renderer, chain);

  assert.deepEqual(renderer.__deleted.bindings, [A]);
  assert.equal(state.unbuiltBindingDeletes, 0);
});

test("the hatch restores three's unconditional decrement", () => {
  const renderer = makeRenderer();
  const state = installAsyncRenderPipelines(renderer);
  state.active = true;
  state.buildBudgetMs = 1;
  const wave = makeWave(renderer, 2, { buildMs: 3 });

  globalThis.__balancedBindingDeletes = false;
  try {
    renderFrame(renderer, wave);
    wave[1].material.cacheKey = "B";
    renderFrame(renderer, wave);
    assert.equal(renderer.__deleted.bindings.length, 1, "the A/B arm: the unbalanced decrement is back");
    assert.equal(state.unbuiltBindingDeletes, 0);
  } finally {
    delete globalThis.__balancedBindingDeletes;
  }
});
