// GISystem — engine runtime for the Radiance Cascades GI module.
//
// VOXEL-FREE ARCHITECTURE: per-mesh SDFs are the sole authored scene
// representation. Every GI-relevant mesh gets a local 64³ distance field —
// baked ONCE in a worker (seconds for dense meshes, ms for props) and
// persisted under `<project>/Library/gi-sdf/` keyed by geometry content hash,
// so subsequent loads are instant and the Assets panel never sees bake
// caches next to authored `.geom` files. A GPU composite pass (giField.js)
// min()s all mesh SDFs into the global distance + surface field the cascades
// trace; moving a mesh only updates its slot uniforms and re-runs that one
// pass. There is no CPU voxelizer, no scene-bake worker, and no incremental
// rebake machinery — scene edits cost ~1-2ms of GPU, never a main-thread hitch.
//
// On top of that field: per-frame analytic lights + promoted emissive emitters
// (uniform slots, zero rebakes), the screen-space resolve chain (direct + GI
// shadows, emitter shadows, reflections) and the GICascadeLight material
// injection.
//
// THE DIFFUSE TRANSPORT IS ABSENT, DELIBERATELY, AND THIS IS THE INTERREGNUM.
// The dense radiance cascades (cascadeTrace/cascadeMerge/cascadeGather + the
// bounce feedback) were deleted with the SRC rebuild's §12.8 unit; Split
// Radiance Cascades replaces them in Phase 1-3 of
// `docs/GI_SRC_REBUILD_PLAN.md`. Until then this module contributes DIRECT
// light, its shadows and its reflections, and NO diffuse indirect — a scene lit
// only by bounce reads black, and that is the expected state, not a bug. The
// authored transport props (bounce, bleed saturation, temporal/probe/field
// smoothing, sky) are still live uniforms with no consumer; see the PARKED
// block in #build for why they were kept rather than deleted and re-added.
import * as THREE from "three/webgpu";
import { Fn, If, cameraPosition, cos, float, fract, mix, normalWorld, positionWorld, renderGroup, screenCoordinate, screenUV, select, sin, smoothstep, texture, uniform, uniformArray, vec2, vec3, vec4 } from "three/tsl";
import { GI_BOOT_AMBIENT_MAX_TICKS, bootAmbientStep } from "./bootAmbient.js";
import { giDebugView, resolveGiConfig, sceneSkyRadiance } from "./giConfig.js";
import { blitBvhAtlasTiles, createGiBvhReflect, createGiBvhTarget, createGiEmitterShadowPass, createGiGBuffer, createGiLightShadowFilterPass, createGiLightShadowHistoryPass, createGiLightShadowPass, createGiLightShadowWidePass, createGiResolve, createGiTargets, renderGiGBuffer } from "./giScreen.js";
import { resolveMaterialSurface, serializeMeshForBake } from "./voxelizeOnce.js";
import { createSrcVolume } from "./srcVolume.js";
import { createSrcDistanceView, createSrcOccupancyView } from "./srcDebugViews.js";
import { createSrcProbeSystem, describeSrcProbeSystem, formatSrcProbeFrame, srcProbesEnabled, srcShadeEnabled } from "./srcSystem.js";
import { ALPHA_MOTION_SAT, ALPHA_TRACK_HOLD_MS, ALPHA_TRACK_THRESHOLD } from "./srcConfig.js";
import { createSrcSurfaceAttribution } from "./srcSurface.js";
import { createOccupancyField, describeOccupancyField, quantizeOccupancyRes } from "./occupancyField.js";
import { BVH_STRATEGY, buildStaticSceneBvhWords, classifyDynamicShape, composeFieldDynamics, createDynamicObjectSet, dynHeaderWords, giMobilityOf, giTraceOf } from "./dynamicObjects.js";
import { fitPrimitive } from "./primitiveFit.js";
import { fitEmitterShape } from "./emitterShapes.js";
import { MeshBVH } from "three-mesh-bvh";
import { UI_LAYER } from "../../engine/editorLayers.js";
import { GICascadeLight, MAX_EMITTERS, giRoughnessBucketOf, registerGILight } from "./giLight.js";
import { buildBvhScene } from "./bvh/bvhScene.js";
import { RayHitMode, rayHitModeName, resolveRayHitConfig } from "./rayHit/RayHitConfig.js";
import {
  MAX_INSTANCE_SLOTS,
  SlotRegistry,
  instanceCapacityFor,
  slotKeyOf,
} from "./slotRegistry.js";
const FINGERPRINT_INTERVAL_FRAMES = 5;
// Hard floor between scene-sync scans. Editor drags emit change events every
// frame, and each poke used to force a full scan (mesh traverse + material
// resolve + hash) per frame — the "CPU spikes while moving" report. Moving
// needs NO scan at all (transforms are the per-frame uniform path); scans
// only exist for add/remove/material/geometry changes.
const FINGERPRINT_MIN_INTERVAL_MS = 250;
// MeshComponents attach with placeholder boxes and swap authored assets in
// asynchronously. Wait for the final completion burst to stay quiet before
// compiling GI, otherwise auto-fit measures placeholders and immediately
// triggers a second full compile wave when the real geometry lands.
const ASSET_LOAD_STABLE_MS = 250;
const ASSET_LOAD_TIMEOUT_MS = 30_000;
// Frames a resize's outgoing resolve targets stay alive before being destroyed
// (see #retireTargets). Two would do — the third is slack for a frame that is
// dropped or re-encoded.
const RETIRED_TARGET_FRAMES = 3;
/**
 * Frames a mover's occupancy slot stays DYNAMIC after its last transform
 * change before demoting back to STATIC (see occupancyField's split note).
 * Each promotion/demotion costs one full re-voxelize (the snapshot must be
 * retaken), so this is hysteresis against stop-start animations — ~1.5s at
 * 60fps. While dynamic-but-still the slot costs nothing (no dirty marks →
 * passes() doesn't run).
 */
const OCC_DYNAMIC_QUIET_FRAMES = 90;
/**
 * CONVERGED-IDLE SLEEP (run-gi-perf.mjs, 2026-08-03: the full pipeline at
 * rest is ~2.3ms GPU at ultra — feedback ~1.4, transport ~0.8 — recomputing
 * a field that converged long ago). When every FIELD input has been
 * bit-identical for GI_IDLE_AFTER_FRAMES (no composite, no light/emitter/sky
 * change — see #fieldInputHash), the per-frame queue drops to the RESOLVE
 * alone (which is camera-dependent and stays live, ~0.07ms). Any input
 * change wakes the full queue the SAME tick — zero added latency — and a
 * 1-in-GI_IDLE_HEARTBEAT_FRAMES full run backstops changes the hash cannot
 * see (e.g. an animated emissive texture's content). 180 frames ≈ well past
 * probe-EMA convergence at the default smoothing, so nothing visible moves
 * at the moment sleep begins. `__giNoIdleSleep = true` disables (A/B).
 */
const GI_IDLE_AFTER_FRAMES = 180;
const GI_IDLE_HEARTBEAT_FRAMES = 30;
/**
 * GI PROXY FIT — a mover's `giProxy` choice turned into occluder spheres.
 *
 * The gather evaluates ONLY spheres, because the sphere is the one shape whose
 * cosine-weighted occlusion has a cheap exact closed form (Quilez), and a closed
 * form is the entire point: it is continuous in the transform, so a rotating
 * proxy is analytically a no-op and cannot flicker. So a richer proxy is spent
 * as MORE SPHERES rather than as new shader math — no branching, no per-shape
 * kernels, and a capsule costs three iterations of a loop that already exists.
 *
 * The modes and why they are the right set: nearly every mover in a game is
 * either an analytic primitive (crate, ball, barrel) or a GLB whose silhouette a
 * capsule describes well (a character). "auto" separates those two by aspect
 * ratio, which is the same rule a person would apply by eye.
 *
 * @param {*} mesh   the mover's render mesh (carries `userData.giProxy`)
 * @param {*} bounds its CURRENT world bounds
 * @param {number} budget slots left in the uniform array
 * @returns {Array<[number, number, number, number]>} world spheres (x, y, z, r)
 */
export function giProxySpheres(mesh, bounds, budget, shapeKind = null) {
  if (budget <= 0) return [];
  const mode = mesh?.userData?.giProxy ?? "auto";
  if (mode === "none") return [];
  const cx = (bounds.min.x + bounds.max.x) * 0.5;
  const cy = (bounds.min.y + bounds.max.y) * 0.5;
  const cz = (bounds.min.z + bounds.max.z) * 0.5;
  const h = [
    (bounds.max.x - bounds.min.x) * 0.5,
    (bounds.max.y - bounds.min.y) * 0.5,
    (bounds.max.z - bounds.min.z) * 0.5,
  ];
  const rBound = Math.hypot(h[0], h[1], h[2]);
  if (!(rBound > 1e-4)) return [];

  // ── AN ACTUAL SPHERE GETS ITS ACTUAL RADIUS ────────────────────────────────
  // The AABB's bounding sphere is sqrt(3) ≈ 1.73x a sphere's true radius, so
  // fitting one to a ball mover casts a shadow 73% too wide. Measured: the
  // step-amplitude excess over the still control ran +256% with the bounding
  // sphere against +14% without any analytic term — not oscillation (reversals
  // went DOWN over the same runs) but a much larger dark region sweeping the
  // floor. An over-large shadow is a correctness error even when it is a
  // perfectly smooth one.
  //
  // `shapeKind` is the classification the dynamic set ALREADY made from the
  // geometry (dynamicObjects' classifyDynamicShape: SphereGeometry → "sphere"),
  // so this costs a string compare and is exact rather than fitted. A sphere's
  // AABB is a cube, so the true radius is any half-extent.
  if (shapeKind === "sphere") {
    const r = Math.min(h[0], h[1], h[2]);
    if (r > 1e-5) return [[cx, cy, cz, r]];
  }
  if (mode === "sphere") return [[cx, cy, cz, rBound]];

  // ── ONE CONTINUOUS FORMULA, NO MODE SWITCH ─────────────────────────────────
  // An earlier version branched on aspect ratio ("elongated → capsule, else
  // sphere") and the fit test caught a 0.18m step in the union radius right at
  // the threshold — 10% of the object, appearing and disappearing as its
  // proportions crossed a line. That is precisely the discontinuity this whole
  // feature exists to remove, reintroduced one layer up, and a character's AABB
  // crosses such a line constantly as its limbs move. So there is no threshold:
  //
  //   rCross = the cross-section corner distance from the long axis
  //   o      = max(0, hAxis − rCross)          end-sphere offset from centre
  //   r      = hypot(hAxis − o, rCross)        radius that covers the end corners
  //
  // As the shape becomes compact, hAxis → rCross, so o → 0 and r → the exact
  // BOUNDING SPHERE — the sphere case falls out of the capsule case as a limit
  // rather than being selected by a branch. `auto` and `capsule` are therefore
  // the same code, and differ only in that `capsule` is the author saying "I
  // know this is a character, keep it tight even when the pose is compact".
  let axis = 0;
  if (h[1] > h[axis]) axis = 1;
  if (h[2] > h[axis]) axis = 2;
  const cross = [0, 1, 2].filter((i) => i !== axis);
  const rCross = Math.hypot(h[cross[0]], h[cross[1]]);
  if (!(rCross > 1e-6)) return [[cx, cy, cz, rBound]];
  const o = Math.max(0, h[axis] - rCross);
  const rBase = Math.hypot(h[axis] - o, rCross);
  if (o <= 1e-6) return [[cx, cy, cz, rBase]];

  // COUNT scales with how far the end spheres sit apart; the RADIUS then
  // absorbs whatever the budget could not buy. Coverage is the invariant —
  // tightness is best-effort — because an uncovered waist is a hole light
  // leaks through, while a slightly fat proxy is only a slightly soft shadow.
  const MAX_SPHERES = 5;
  const want = Math.max(1, Math.min(MAX_SPHERES, budget, 2 * Math.ceil(o / rBase) + 1));
  if (want <= 1) return [[cx, cy, cz, Math.hypot(h[0], h[1], h[2])]];
  const spacing = (2 * o) / (want - 1);
  const r = Math.max(rBase, spacing * 0.5);
  const out = [];
  const c = [cx, cy, cz];
  for (let i = 0; i < want; i++) {
    const p = [c[0], c[1], c[2]];
    p[axis] += -o + i * spacing;
    out.push([p[0], p[1], p[2], r]);
  }
  return out;
}

// ── ASYNC COMPUTE PIPELINES — the computes' missing `isReady` ────────────────
// three creates every compute pipeline with the SYNC device call, and Chrome's
// GPU process serves creates and submits on ONE wire thread — so a single big
// kernel stalls every submit and every in-flight async material compile behind
// it. Harness-measured 2026-08-02: the 782kB composite kernel cost ~27s of DXC
// on the wire, and the whole "materials preparation" startup hang was
// everything else queueing behind it. The render path already has the answer
// (Pipelines.isReady → skip the draw until the async compile lands); this
// installs the same semantics for computes:
//   · creation is redirected to createComputePipelineAsync (driver threads);
//   · a dispatch whose pipeline hasn't resolved is SKIPPED, not crashed into;
//   · skipped GI dispatches are re-run in order by GISystem (`giCompute`
//     marks them — the composite chain is order-dependent, so GISystem
//     re-queues the WHOLE batch via its dirty flags);
//   · skipped non-GI dispatches (a particles INIT pass is a one-shot — losing
//     it breaks the sim) are replayed per node when their pipeline resolves.
let giDispatchDepth = 0;
const giSkippedComputes = new Set();
const giPendingComputePipelines = new Set();
// Every GPUShaderModule this process has built a pipeline from. three keys its
// ProgrammableStage cache on WGSL SOURCE, so a repeat module means byte-identical
// source — and therefore a pipeline compile that a content-keyed cache could
// have skipped. See the counting site in `installAsyncComputePipelines`.
const giSeenShaderModules = new WeakSet();
let giPipelineReuseHits = 0;
// One entry per compute pipeline created this process, in creation order — the
// same order the prewarm collects `kernelSizes`, so the two can be zipped and
// the slow kernel named with its size. Exists because `N pipelines compiled
// concurrently in Xms` is a DRAIN total and cannot say which one owned it, and
// on the user's editor that total is 62,046 ms for a single pipeline.
const giPipelineTimings = [];
if (import.meta.env?.DEV) {
  // Harness diagnostics (run-gi-spawn-test and friends): lets a probe see
  // whether the dispatch loop is stuck waiting on pipelines / skipping.
  globalThis.__giPendingComputePipelines = giPendingComputePipelines;
  globalThis.__giSkippedComputesSet = giSkippedComputes;
}

/**
 * Split strategy for the STATIC-SCENE shadow BVH (`__giStaticBvhStrategy`:
 * "sah" | "average" | "center"). A scene-scale soup mixes metre-wide floor
 * quads with millimetre ornament triangles, and a median/centroid split puts
 * both in one leaf whose box spans the room — every ray then descends into it.
 * Object-local mover BVHs keep the default (their triangles are size-uniform
 * and the build has to stay interactive).
 */
function staticBvhStrategy() {
  const name = String(globalThis.__giStaticBvhStrategy ?? "sah").toLowerCase();
  return BVH_STRATEGY[name] ?? BVH_STRATEGY.sah;
}

/** The node whose dispatch is currently on the stack. Pipeline creation happens
 *  synchronously inside `renderer.compute(node)` on the node's FIRST dispatch,
 *  so this is readable from the `device.createComputePipeline` wrapper — which
 *  is how a pipeline learns which PASS it belongs to. §13.14.8: five sessions
 *  of "which kernel is the slow one" failed because the shadow-estimator family
 *  shares one WGSL fingerprint (light-shadow, emitter-shadow, feedback — all
 *  descend the same BVH with the same width probe). Names end that permanently. */
let giCurrentComputeNode = null;

/** Dispatch wrapper for GISystem's own renderer.compute calls — marks skips
 *  as GI-owned so they take the ordered-retry path, not the replay path. */
function giCompute(renderer, nodes) {
  giDispatchDepth++;
  try {
    if (Array.isArray(nodes)) {
      // One at a time, so the current-node tracker stays truthful for the
      // pipeline each dispatch creates. three accepts arrays, but an array
      // dispatch would leave every pipeline in it attributed to the ARRAY.
      for (const node of nodes) {
        giCurrentComputeNode = node;
        try {
          renderer.compute(node);
        } finally {
          giCurrentComputeNode = null;
        }
      }
      return;
    }
    giCurrentComputeNode = nodes;
    try {
      renderer.compute(nodes);
    } finally {
      giCurrentComputeNode = null;
    }
  } finally {
    giDispatchDepth--;
  }
}

function installAsyncComputePipelines(renderer) {
  const backend = renderer?.backend;
  const device = backend?.device;
  if (!backend || typeof device?.createComputePipelineAsync !== "function") return;
  if (backend.__giAsyncComputePipelines) return;
  backend.__giAsyncComputePipelines = true;
  // ── THE SOURCE OF THE SLOW ONE, NOT ITS INDEX ──────────────────────────────
  //
  // `SLOWEST PIPELINE: #47 took 181.6s (?kB WGSL)` — the `?` is the whole
  // problem. Sizes are collected only inside the prewarm loop, so any pipeline
  // created outside it (which is exactly the slow one, every time) has no size,
  // no name and no source, and three's label for it is the generic
  // `computePipeline_compute`. An index into a list it is not a member of
  // cannot identify a shader.
  //
  // The module carries the source. three builds every GPUShaderModule from a
  // WGSL string, so recording that string against the module object makes the
  // pipeline descriptor self-describing: `descriptor.compute.module` → code.
  // A WeakMap so nothing here retains a module the renderer has dropped.
  if (typeof device.createShaderModule === "function" && !device.__giShaderSource) {
    const rawShaderModule = device.createShaderModule.bind(device);
    device.__giShaderSource = new WeakMap();
    device.createShaderModule = (desc) => {
      const module = rawShaderModule(desc);
      if (module && typeof desc?.code === "string") device.__giShaderSource.set(module, desc.code);
      return module;
    };
  }
  const rawCreate = backend.createComputePipeline;
  const rawCompute = backend.compute;
  backend.createComputePipeline = function (computePipeline, bindings) {
    // three's pipeline-utils body does all the descriptor/layout work and ends
    // in `device.createComputePipeline(desc)` — intercept just that call.
    const rawDeviceCreate = device.createComputePipeline;
    device.createComputePipeline = (descriptor) => {
      // ── IS THIS A SHADER WE HAVE ALREADY COMPILED? ────────────────────────
      //
      // three caches ProgrammableStages by WGSL SOURCE (`programs.compute` is
      // keyed on the string), so an identical kernel reuses its GPUShaderModule
      // object. But the PIPELINE cache key is `computeNode.id + ',' +
      // stageCompute.id` (three.webgpu.js `_getComputeCacheKey`), and a GI
      // rebuild constructs fresh compute nodes — new ids. So a rebuild whose
      // WGSL has not changed by one byte still misses the pipeline cache and
      // pays `createComputePipelineAsync` again, on a serializing driver, for
      // every kernel.
      //
      // That is a hypothesis about why the user saw three compile waves in five
      // minutes (62,926 / 134,891 / 68,250 ms). Counting module REUSE tests it
      // without building anything: a module we have seen before can only have
      // come from identical source, so `reused` is exactly the number of
      // recompiles that a content-keyed cache could have avoided. If it comes
      // back zero on a rebuild the hypothesis is dead and no cache gets written.
      const mod = descriptor?.compute?.module;
      if (mod) {
        if (giSeenShaderModules.has(mod)) giPipelineReuseHits++;
        else giSeenShaderModules.add(mod);
      }
      // ── WHICH KERNEL IS THE SLOW ONE? ────────────────────────────────────
      //
      // The user's editor, SRC off, five kernels: `1 compute pipelines compiled
      // concurrently in 62046ms`. ONE pipeline, 62 seconds — that is now the
      // whole of startup, with the prewarm loop at 1 ms, TSL at 1 ms and
      // materials at 5.7 s. §13.4 already showed size does not predict this (a
      // 154 kB kernel compiled 4× faster than a 2 kB one), so it is a compiler
      // pathology in ONE shader and the only useful question is which.
      //
      // The aggregate line cannot answer it: it reports the drain, summed. Each
      // pipeline is therefore timed individually and tagged with its creation
      // ORDER, which is the same order `kernelSizes` is collected in during the
      // prewarm — so the slow one can be named against its size and its place
      // in the chain rather than guessed at from a total.
      const order = giPipelineTimings.length;
      const tCreate = performance.now();
      const wgsl = mod ? device.__giShaderSource?.get(mod) : null;
      giPipelineTimings.push({
        order,
        ms: null,
        label: descriptor?.label ?? "",
        // The PASS, from the dispatch that is synchronously on the stack right
        // now (see giCurrentComputeNode). "gi:unnamed" = dispatched through
        // giCompute by a site that never stamped a name; "non-gi" = a dispatch
        // that bypassed giCompute entirely — both localize a kernel harder
        // than any fingerprint has managed.
        pass: giCurrentComputeNode?.__giPassName
          ?? (giDispatchDepth > 0 ? "gi:unnamed" : "non-gi"),
        // Kept as a fingerprint, never as the source: a 77 kB string per
        // pipeline held for the life of the page is a leak, and the three
        // numbers below are what actually distinguishes one kernel from
        // another when the compiler pathology is loops-and-branches (§13.4
        // showed byte size alone does not predict compile time).
        kb: typeof wgsl === "string" ? Math.round(wgsl.length / 1024) : null,
        entry: descriptor?.compute?.entryPoint ?? "",
        loops: typeof wgsl === "string" ? (wgsl.match(/\bloop\s*\{/g) ?? []).length : null,
        ifs: typeof wgsl === "string" ? (wgsl.match(/\bif\s*\(/g) ?? []).length : null,
        // The first storage binding a kernel declares names it better than any
        // index does — `srcBins`, `surfaceRecords`, `bvhNodes` are all distinct.
        binds: typeof wgsl === "string"
          ? (wgsl.match(/var<storage[^>]*>\s*(\w+)/g) ?? []).slice(0, 4).map((s) => s.split(/\s+/).pop()).join(",")
          : "",
      });
      const record = () => { giPipelineTimings[order].ms = performance.now() - tCreate; };
      const promise = device.createComputePipelineAsync(descriptor).then(
        (pipelineGPU) => {
          record();
          const data = backend.get(computePipeline);
          data.pipeline = pipelineGPU;
          const replay = data.giReplayNodes;
          if (replay?.size) {
            data.giReplayNodes = null;
            for (const node of replay) renderer.compute(node);
          }
        },
        (error) => {
          record();
          console.warn(
            `[gi] compute pipeline "${descriptor?.label ?? ""}" failed to compile:`,
            error?.message ?? error,
          );
        },
      );
      const tracked = promise.finally(() => giPendingComputePipelines.delete(tracked));
      giPendingComputePipelines.add(tracked);
      return null; // not ready — the dispatch guard below skips it meanwhile
    };
    try {
      rawCreate.call(this, computePipeline, bindings);
    } finally {
      device.createComputePipeline = rawDeviceCreate;
    }
  };
  backend.compute = function (computeGroup, computeNode, bindings, pipeline, dispatchSize) {
    const data = this.get(pipeline);
    if (!data.pipeline) {
      if (giDispatchDepth > 0) giSkippedComputes.add(computeNode);
      else (data.giReplayNodes ??= new Set()).add(computeNode);
      return;
    }
    return rawCompute.call(this, computeGroup, computeNode, bindings, pipeline, dispatchSize);
  };
}

/**
 * Exact-SDF shapes for primitive geometries. Boxes/planes/spheres get
 * ANALYTIC slots: no bake, no file, instantly present at launch, exact at
 * any size (a 30m ground plane as a 64³ grid was ~0.5m/cell — its wobble
 * painted contour swirls into every shadow), and SOLID — walls seal at any
 * thinness. This mirrors the reference demo's analytic geometry path.
 */
function analyticShapeOf(geometry, material) {
  const type = geometry?.type;
  const params = geometry?.parameters;
  // ROOM DETECTION applies to fitted primitives too — see the note below.
  const hollowOf = () => geometryNormalsInverted(geometry) !== (material?.side === THREE.BackSide);
  if (!params) {
    // IMPORTED geometry has no construction parameters, so everything from a
    // GLB used to fall back to a baked grid — including the flat walls and
    // banners that the grid cannot represent at all (see primitiveFit.js).
    // Recover the shape from the vertices instead; a hit here is exact at any
    // volume size, which is the whole point.
    const fitted = fitPrimitive(geometry);
    return fitted ? { ...fitted, hollow: hollowOf() } : null;
  }
  // ROOM DETECTION: a primitive whose rendered faces point INWARD (flipped
  // normals, or BackSide material) is a room/enclosure, not a solid prop.
  // Treating it as a SOLID SDF makes its entire interior read distance 0 —
  // every shadow/cascade ray inside is instantly "occluded" and light only
  // survives within the emitter's self-exclusion sphere (the user's "light
  // has a hard radius" bug). Inverted primitives get HOLLOW SHELL distance
  // (|signed|) instead: walls still seal, the interior is open space.
  const hollow = hollowOf();
  if (type === "SphereGeometry") {
    const full =
      (params.phiLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3 &&
      (params.thetaLength ?? Math.PI) > Math.PI - 1e-3;
    if (!full) return null;
    const r = params.radius ?? 1;
    return { type: "sphere", hollow, center: [0, 0, 0], half: [r, r, r] };
  }
  if (type !== "BoxGeometry" && type !== "PlaneGeometry") return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) return null;
  return {
    type: "box",
    hollow,
    center: [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2],
    // TRUE local half-extents (a plane's are zero on one axis). The minimum
    // thickness that makes a zero-thickness plane a solid the traces can
    // block against is applied per-frame in WORLD units by the atlas — it
    // used to be a fixed 0.015 baked in here, which the mesh's scale then
    // multiplied: a 1×1 plane scaled 20× became a 0.6m-thick slab whose SDF
    // surface stood 0.3m in front of the wall you can see.
    half: [
      (bb.max.x - bb.min.x) / 2,
      (bb.max.y - bb.min.y) / 2,
      (bb.max.z - bb.min.z) / 2,
    ],
  };
}

/** True when a primitive's vertex normals point toward its own center. */
function geometryNormalsInverted(geometry) {
  const normal = geometry?.attributes?.normal;
  const position = geometry?.attributes?.position;
  if (!normal || !position) return false;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) return false;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  let inward = 0;
  let outward = 0;
  const stride = Math.max(1, Math.floor(position.count / 48));
  for (let i = 0; i < position.count; i += stride) {
    const d =
      (position.getX(i) - cx) * normal.getX(i) +
      (position.getY(i) - cy) * normal.getY(i) +
      (position.getZ(i) - cz) * normal.getZ(i);
    if (d < -1e-6) inward++;
    else if (d > 1e-6) outward++;
  }
  return inward > outward;
}
/**
 * Effective (inherited) visibility — `object.visible` AND every ancestor's.
 *
 * three's renderer stops descending at the first invisible object, so a light
 * parented under a disabled entity is simply never collected into the render
 * lights. `Object3D.traverse` does NOT stop there: it walks the whole subtree,
 * and the light's own `.visible` is still `true` (the engine hides an entity by
 * clearing the flag on the ENTITY's object3D — see Engine.js's per-frame
 * enabledInEditor/enabledInGame resolve; LightComponent only touches
 * `light.visible` for its own component-level toggle).
 *
 * Reading the flag alone therefore let a light the user had switched off keep
 * injecting its full analytic direct term into the GI field every frame: three
 * drew nothing, but the cascades still bounced a sun nobody could see. That is
 * the "even with the directional light disabled the corners stay lit" report —
 * only the indirect term survived, which is exactly why it looked like a leak
 * (dim, and tinted by whatever the bounce came off).
 *
 * `#collectMeshes` already prunes correctly (it recurses by hand and returns
 * early on an invisible node, skipping the subtree); this is the light path
 * catching up.
 */
function isRenderVisible(object) {
  for (let node = object; node; node = node.parent) {
    if (node.visible === false) return false;
  }
  return true;
}

/**
 * World AABB of a mesh, INCLUDING every instance of an InstancedMesh.
 *
 * `geometry.boundingBox` describes one instance sitting at the origin of the
 * mesh's local space, so using it for an InstancedMesh measures the prototype
 * rather than the scatter — a forest would fit a volume around one tree.
 * three keeps the instance-aware box on the mesh itself (`mesh.boundingBox`,
 * still local space), which is what this reaches for first.
 *
 * Writes into `target` and returns it, or null when there is nothing to
 * measure.
 */
function meshWorldBox(mesh, target = new THREE.Box3()) {
  if (mesh.isInstancedMesh) {
    if (!mesh.boundingBox) mesh.computeBoundingBox();
    if (!mesh.boundingBox || mesh.boundingBox.isEmpty()) return null;
    return target.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
  }
  if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox();
  const box = mesh.geometry?.boundingBox;
  if (!box || box.isEmpty()) return null;
  return target.copy(box).applyMatrix4(mesh.matrixWorld);
}

/**
 * Instances of ONE InstancedMesh that may claim atlas slots.
 *
 * The cap is per mesh, not per scene, so one 20k-instance grass field cannot
 * eat the whole instance budget and starve the building it grows around. Over
 * the cap the first N instances seat and the rest are reported — dropped from
 * the FIELD only; they still render, and they still receive GI, because
 * receiving is a per-pixel lookup that needs no slot.
 */
const MAX_INSTANCES_PER_MESH = 256;

// SDF bakes sample the surface, not every triangle cell — but a multi-
// million-tri mesh still costs seconds of worker time on first bake.
const MAX_TRIS_PER_MESH = 500_000;
const MAX_AXIS_RES = 128;
const MAX_PROBE_AXIS = 48;
// Analytic lights the per-frame GPU direct pass supports (uniform slots —
// a fixed count keeps light add/remove/move recompile- and rebake-free).
const MAX_GI_LIGHTS = 4;
// Auto-fit quality presets: total voxel budget, total PROBE budget, and a
// per-axis probe cap. The whole point is "enable + pick quality, done" — no
// voxel/probe hand-tuning.
//
// `probes` is a TOTAL, not a per-axis count: spacing = cbrt(volume/probes).
// A per-axis divisor spends the budget as if every volume were a cube, so a
// wide flat room (40×5×40) got the same coarse spacing on its short axis as
// on its long ones and wasted most of its probes on empty vertical space.
// `probeAxis` remains as a hard per-axis cap (dispatch sizes).
const QUALITY_BUDGETS = {
  low: { cells: 300_000, probes: 8_000, probeAxis: 20 },
  medium: { cells: 700_000, probes: 21_952, probeAxis: 28 },
  high: { cells: 1_400_000, probes: 64_000, probeAxis: 40 },
  ultra: { cells: 2_800_000, probes: 110_592, probeAxis: 48 },
};
const QUALITY_TIERS = new Set(["low", "medium", "high", "ultra"]);

/**
 * The volume used when auto-fit finds no geometry to fit — an empty scene.
 *
 * Not a setting: the old `sizeX/sizeY/sizeZ` properties are gone and auto-fit
 * is unconditional, so nothing else in the module needs a world size. It exists
 * so that a GI component added before any geometry builds something coherent
 * instead of a NaN box, and it is replaced the moment a mesh appears.
 */
const FALLBACK_VOLUME = { x: 40, y: 12, z: 40 };

// Per-probe temporal EMA toward each frame's freshly integrated irradiance
// (createProbeIrradiance). 1 = off. Geometry is static and only light moves, so
// this changes NOTHING about a settled image — it only stops the probe lattice
// from popping in blocks while a light sweeps, which is the "flickers like a
// bulb shorting out" report. Lag at 0.35 is ~5 frames.
const DEFAULT_PROBE_SMOOTHING = 0.35;
const clampProbeSmoothing = (value) =>
  Math.min(1, Math.max(0.02, Number.isFinite(value) ? value : DEFAULT_PROBE_SMOOTHING));

/**
 * The TIER a quality preset selects for — every lookup keyed by preset name
 * (budget tables, trace-step budgets, the mesh-SDF detail-slot budget, the
 * exact-reflections default gate) reads through this, never `props.quality`
 * directly. "custom" (set by the Inspector when an advanced GI field is
 * edited directly — see InspectorPanel's `flipsToCustom`) means "the preset
 * name no longer implies values", not "no tier": every one of those lookups
 * still needs SOME tier to key off of, and "high" is the least surprising
 * choice — it's also this component's own zero-setup default. An unset or
 * unrecognized value (old scene data, a future typo) falls back the same
 * way. Numeric props already read directly off `props` (voxelSize,
 * probeSpacing, cascadeCount, c0DirRes, …) are untouched by this — "custom"
 * only changes what the PRESET NAME implies, not values authored explicitly.
 */
function qualityTierOf(props) {
  const quality = props?.quality;
  return QUALITY_TIERS.has(quality) ? quality : "high";
}

// PROBE SPACING LADDER. Auto-fit spacing is quantized onto this ladder and
// the volume is then snapped to a multiple of it, so the probe lattice sits
// at FIXED world positions instead of being re-derived from whatever the
// content AABB happens to be this second. Without quantization every edit
// that nudged the fitted bounds — moving a prop, scaling a wall — changed
// the spacing slightly, which moved every probe, which visibly re-shuffled
// the whole indirect-light pattern ("GI changes a lot when I transform
// things"). With it, small edits produce bit-identical bounds and the field
// does not move at all.
// The rungs are deliberately FINE (5cm below a metre, 10cm above): the
// ladder exists to make the spacing stable across edits, not to coarsen it,
// and a sparse ladder throws away up to a third of the probe budget on the
// round-up. Values are exact in binary-ish decimal terms only to the extent
// that floats allow — everything downstream compares with an epsilon.
const PROBE_SPACING_LADDER = [
  0.02, 0.025, 0.03, 0.04,
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85,
  0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5,
];
const quantizeSpacing = (value) =>
  PROBE_SPACING_LADDER.find((step) => value <= step * 1.0001) ??
  PROBE_SPACING_LADDER[PROBE_SPACING_LADDER.length - 1];

/**
 * The per-frame analytic direct-light slots: fixed uniforms every consumer
 * reads (field gather, screen resolve, and the transport rays' exact-dynamic
 * shading). Light moves/edits update uniforms only — never a rebuild.
 */
// ── MOVER DIRECT-LIGHT SHADOW ORACLE (CPU) ─────────────────────────────────
// One ray per (mover × analytic light) per frame against the STATIC meshes,
// via three-mesh-bvh — the answer to "is this mover actually lit by that
// light", which the analytic mover bounce needs and no GPU path can deliver
// to a UNIFORM without a frame-path readback. Scratches shared, no per-frame
// allocation; the smoothing lives on the ENTRY (entry._giLightVis) so slot
// reshuffles cannot smear one mover's ramp onto another.
const _msoOrigin = new THREE.Vector3();
const _msoDir = new THREE.Vector3();
const _msoLocalRay = new THREE.Ray();
const _msoWorldRay = new THREE.Ray();
const _msoHit = new THREE.Vector3();
const _msoBoundsC = new THREE.Vector3();
const _msoBoundsS = new THREE.Vector3();
const _mocCamera = new THREE.Vector3();
const _mocCenter = new THREE.Vector3();
// Geometry → MeshBVH, shared across oracle re-keys. The oracle rebuilds its
// mesh list whenever the occupancy field object is replaced (any structural
// rebuild), and the first shipped version rebuilt every BVH with it — the
// cannonball probe counted 121 main-thread builds in one session because a
// mid-game rebuild re-keyed it. Geometries survive rebuilds; the BVH is a
// pure function of the geometry; cache it for the session.
const moverOracleBvhCache = new WeakMap();
function moverLightVisTarget(oracle, center, boundR, slot) {
  if (!(slot.active.value > 0.5)) return 1;
  const isDir = slot.kind.value >= 0.5;
  let maxT;
  if (isDir) {
    // `vector` holds the normalized direction TOWARD the light.
    _msoDir.copy(slot.vector.value).normalize();
    maxT = 64;
  } else {
    _msoDir.copy(slot.vector.value).sub(center);
    const d = _msoDir.length();
    if (d < 1e-4) return 1;
    _msoDir.divideScalar(d);
    maxT = d - 1e-3;
  }
  // Start outside the mover's own body — it must not shadow itself here
  // (the bounce term's ndotl already carries its self-shadowing).
  const lift = boundR * 1.05;
  _msoOrigin.copy(center).addScaledVector(_msoDir, lift);
  maxT -= lift;
  if (maxT <= 0) return 1;
  _msoWorldRay.origin.copy(_msoOrigin);
  _msoWorldRay.direction.copy(_msoDir);
  for (const e of oracle.ready) {
    // World-AABB slab test before the transform + BVH descent: a Sponza
    // sun ray misses most of the 55 meshes' boxes outright, and this loop
    // runs per (mover × light) per frame. `skip` = currently adopted as an
    // exact mover (stale pose here would ghost-shadow).
    if (e.skip) continue;
    if (e.worldBox && !_msoWorldRay.intersectsBox(e.worldBox)) continue;
    _msoLocalRay.origin.copy(_msoOrigin).applyMatrix4(e.inv);
    _msoLocalRay.direction.copy(_msoDir).transformDirection(e.inv);
    const hit = e.bvh.raycastFirst(_msoLocalRay, THREE.DoubleSide);
    if (hit) {
      _msoHit.copy(hit.point).applyMatrix4(e.mesh.matrixWorld);
      if (_msoHit.distanceTo(_msoOrigin) <= maxT) return 0;
    }
  }
  return 1;
}

// Oriented-box occluder record for #syncMoverOccluders — fills the shared
// scratch record below (center/half/radius) + moverObbQuat with the mover's
// world OBB from its LOCAL bounding box through matrixWorld, the same recipe
// (and the same shear-out-of-scope caveat) as the emitter fitter's OBB
// fallback. Returns false when the mover should keep its sphere-chain proxy:
// exact spheres, user-pinned sphere/capsule proxies, instanced movers, or
// `__giMoverObbOcclusion === false` (the A/B hatch back to bounding spheres).
const moverObbQuat = new THREE.Quaternion();
const _obbPos = new THREE.Vector3();
const _obbScale = new THREE.Vector3();
function moverObbRecord(entry, out) {
  if (globalThis.__giMoverObbOcclusion === false) return false;
  const mesh = entry.mesh;
  if (!mesh || mesh.isInstancedMesh) return false;
  const mode = mesh.userData?.giProxy ?? "auto";
  if (mode === "sphere" || mode === "capsule" || mode === "none") return false;
  if (entry.type === "sphere") return false;
  const g = mesh.geometry;
  if (!g) return false;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb || bb.isEmpty()) return false;
  mesh.matrixWorld.decompose(_obbPos, moverObbQuat, _obbScale);
  out.center
    .set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
    .applyMatrix4(mesh.matrixWorld);
  out.half.set(
    Math.max(((bb.max.x - bb.min.x) / 2) * Math.abs(_obbScale.x), 0.005),
    Math.max(((bb.max.y - bb.min.y) / 2) * Math.abs(_obbScale.y), 0.005),
    Math.max(((bb.max.z - bb.min.z) / 2) * Math.abs(_obbScale.z), 0.005),
  );
  out.radius = Math.hypot(out.half.x, out.half.y, out.half.z);
  return out.radius > 1e-4;
}

// Reused by #refreshEmitterSlots every frame — fitEmitterShape fills it
// in place so the per-slot refresh allocates nothing.
const emitterFitScratch = {
  kind: 0,
  center: new THREE.Vector3(),
  bx: new THREE.Vector3(),
  by: new THREE.Vector3(),
  bz: new THREE.Vector3(),
  half: new THREE.Vector3(),
  radius: 0,
  reff: 0,
  exHalf: new THREE.Vector3(),
};

function makeLightSlots() {
  return Array.from({ length: MAX_GI_LIGHTS }, () => ({
    active: uniform(0),
    kind: uniform(0),
    vector: uniform(new THREE.Vector3()),
    color: uniform(new THREE.Color(0, 0, 0)),
    // three PointLight `distance` cutoff (0 = infinite) — GI must die
    // where the renderer's own direct light does, or the mismatch reads
    // as light being "cut" at a circle.
    range: uniform(0),
    // ── GI-TRACED DIRECT SHADOWS (LightComponent's `shadowMode: "gi"`) ──
    // `soft` = the light's own angular RADIUS in radians (a sun's authored
    // "Angle", halved by LightComponent). `srcRadius` = a point/spot source's
    // world-space radius, whose angular size is radius/distance and therefore
    // has to be resolved per pixel rather than stored as an angle. Exactly
    // one of the two is meaningful per slot, chosen by `kind`.
    //
    // BOTH ARE 0 UNLESS THE LIGHT IS GI-FLAGGED, and that is deliberate: 0
    // means "unset", which every consumer falls back from to the global sun
    // angle. So a scene that never opts into gi shadows keeps byte-identical
    // field behaviour, and the feature can only change lights that asked for
    // it (see #updateLightUniforms and cascadeGather's per-slot k).
    soft: uniform(0),
    srcRadius: uniform(0),
    // 1 only while the screen resolve should trace this slot's shadow cone:
    // the light asked for gi shadows AND the device/binding gate passed AND
    // the slot is live. A uniform rather than a build-time switch because
    // flipping a light's Shadow Source must not need a GI rebuild.
    giShadow: uniform(0),
  }));
}

export class GISystem {
  constructor(engine) {
    this.engine = engine;
    this.component = null;
    this.state = null; // { volume, cascades, queue, light, gizmos, bounds, ... }
    this._frame = 0;
    this._fingerprint = "";
    this._rebuildQueued = false;
    this._lightsRefreshTicks = 0;
    // Baked mesh SDFs by CONTENT key (asset path or geometry hash) — shared
    // across mesh instances and across rebuilds. Session-lifetime, as is the
    // bake worker (a rebuild must never kill an in-flight bake).
    // material → compile-time roughness bucket (see #refreshMirrorBucket).
    this._mirrorBuckets = new WeakMap();
    // Resolve targets replaced by a resize, awaiting a safe disposal frame.
    this._retiredTargets = [];
    this._unsubs = [
      engine.onPreRender(() => this.#tick()),
      engine.on?.("hierarchy-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("component-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("model-loaded", () => this.#queueRebakeCheck()) ?? (() => {}),
    ];
  }

  /**
   * THE SETTLED CONFIGURATION — what every consumer in this file reads instead
   * of `component.props`.
   *
   * The component declares one property (`quality`); `resolveGiConfig` turns it
   * into the props-shaped object the rest of this file was already written
   * against, so the collapse changed WHICH object is read and not what anybody
   * does with it. See `giConfig.js` for why there is only one knob.
   *
   * Cached on the quality string rather than rebuilt per access: this is read
   * from `#tick` and `#applyLiveProps`, i.e. every frame, and the object is
   * frozen so a cached reference cannot be scribbled on.
   */
  get config() {
    const quality = this.component?.props?.quality;
    if (this._cfg === undefined || this._cfgKey !== quality) {
      this._cfgKey = quality;
      this._cfg = resolveGiConfig(this.component?.props);
    }
    return this._cfg;
  }

  /** One active component at a time (Environment convention: last wins). */
  attach(component) {
    if (this.component === component) return;
    this.component = component;
    this._cfg = undefined;
    this.requestRebuild();
  }

  detach(component) {
    if (this.component !== component) return;
    this.component = null;
    this.#dispose();
  }

  /**
   * A property changed. There is exactly ONE that can — `quality` — plus the
   * component's own `enabled`.
   *
   * This method used to route 27 keys into four buckets (live uniforms, the
   * debug view, read-on-the-fly, and a structural rebuild) and carried a note
   * saying "if you add a prop, it belongs to exactly one of those four places".
   * The collapse to a single quality preset (`giConfig.js`) is what removed the
   * bucketing problem rather than solving it again: a preset change is
   * structural by definition — it moves cell budgets, probe budgets, trace step
   * ladders and the ray-hit mode, all of which are baked into compiled graphs
   * as constants — so it rebuilds.
   *
   * The rebuild is still gated on the SIGNATURE actually changing, because
   * editor autosave rewrites props with unchanged values and a no-op write must
   * not rebuild the module.
   */
  onComponentProp(component, key) {
    if (this.component !== component) return;
    // Drop the memoized config first: everything below reads `this.config`, and
    // a stale cache here would make a preset change apply to nothing.
    this._cfg = undefined;
    if (key === "enabled") {
      this.#applyLiveProps();
      return;
    }
    const signature = this.#structuralSignature(component);
    if (signature !== this._structuralSig) {
      this._structuralSig = signature;
      this.requestRebuild();
    }
  }


  #structuralSignature(component) {
    // READS THE SETTLED CONFIG, NOT THE COMPONENT. With one authored property
    // the signature is a function of `quality` alone — but it is still written
    // out field by field rather than shortened to `[cfg.quality]`, because the
    // fields are what the compiled graphs actually bake in, and the day a tier
    // starts varying one of them the signature has to notice by itself.
    // (`sizeX/Y/Z`, `voxelSize`, `probeSpacing`, `cascadeCount`, `c0DirRes`,
    // `hitLighting` and `backend` used to sit here; the first five are derived
    // from the quality budget now that auto-fit is unconditional, and the last
    // two were never declared properties at all.)
    void component;
    const p = this.config;
    return JSON.stringify([
      p.reflections,
      p.emissiveShadows,
      p.autoFit,
      p.quality,
      // `exactReflections` decides whether `light.bvhReflectTexture` /
      // `bvhReflectColorTexture` are set, and giLight compiles a DIFFERENT
      // mirror path depending on that — so it can only change on a REBUILD.
      // Leaving a structural prop out of this signature is a real shipped bug:
      // the Inspector toggle flipped the prop, nothing rebuilt, and the switch
      // silently did nothing until some unrelated edit forced a rebuild — which
      // also made every A/B of exact reflections untrustworthy. (`sparseField`
      // sat beside it for the same reason and is gone with its file.)
      p.exactReflections,
      // The backend decides which trace graph every GI shader compiles, so it
      // cannot change without a rebuild. (`killSdf` used to sit beside it — the
      // prop went in 2026-08-02, the flag itself in the SRC rebuild: there has
      // been exactly one distance source since the bake pipeline was deleted.)
      p.backend,
      p.rayHitMode,
      p.rayHitProfiling === true,
      // The Phase-5 coarse-skip A/B compiles different trace variants, so
      // flipping it without a rebuild would silently do nothing (the
      // exactReflections lesson above).
      p.rayHitSkipDistance !== false,
      // AO compiles the resolve's obscurance block (and its pyramid binding)
      // in or out — structural for the same reason exactReflections is.
      p.ao !== false,
    ]);
  }

  /**
   * World AABB of the GI-relevant meshes, or null when the scene is empty.
   * Dominant FLAT outliers (a 60m ground plane under a 5m room) are trimmed
   * when removing them collapses the fit substantially — otherwise they drag
   * the auto-fit budget into covering mostly-empty air and the whole volume
   * goes low-res. Room walls survive the test: removing one barely shrinks
   * the union, so they stay.
   */
  #sceneAabb(meshes) {
    if (!meshes.length) return null;
    const boxes = [];
    for (const mesh of meshes) {
      // Instance-aware: an InstancedMesh's world box has to span the whole
      // scatter, not the prototype sitting at its local origin.
      const box = meshWorldBox(mesh, new THREE.Box3());
      if (box && !box.isEmpty()) boxes.push(box);
    }
    if (!boxes.length) return null;
    const unionOf = (list) => {
      const out = new THREE.Box3();
      for (const box of list) out.union(box);
      return out;
    };
    const volumeOf = (box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      return Math.max(s.x, 1e-3) * Math.max(s.y, 1e-3) * Math.max(s.z, 1e-3);
    };
    let kept = boxes;
    let union = unionOf(kept);
    const fullSpan = new THREE.Vector3();
    union.getSize(fullSpan);
    const maxFullSpan = Math.max(fullSpan.x, fullSpan.y, fullSpan.z);
    // Candidates: near-flat meshes spanning most of the scene on some axis.
    const flatBig = kept.filter((box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      const spans = [s.x, s.y, s.z].sort((a, b) => a - b);
      return spans[0] < Math.max(0.5, spans[2] * 0.08) && spans[2] >= maxFullSpan * 0.5;
    });
    const spanOf = (box) => {
      const s = new THREE.Vector3();
      box.getSize(s);
      return Math.max(s.x, s.y, s.z);
    };
    const trimmed = [];
    for (const candidate of flatBig.sort((a, b) => volumeOf(b) - volumeOf(a))) {
      if (kept.length <= 1) break;
      const without = kept.filter((box) => box !== candidate);
      const shrunk = unionOf(without);
      // Trim ONLY a true outlier: the candidate must DWARF the rest of the
      // scene (≥ 2× its span), not merely be flat. Room walls and floors
      // are flat AND scene-sized — trimming them used to collapse the
      // volume down to the props, leaving whole room halves outside the
      // field: no probes there (black ambient) and, worse, receivers past
      // the volume face whose shadow rays bailed instantly → hard-edged
      // unshadowed light pools ("light cutoff").
      if (
        !shrunk.isEmpty() &&
        volumeOf(shrunk) < volumeOf(union) * 0.6 &&
        spanOf(candidate) >= spanOf(shrunk) * 2
      ) {
        kept = without;
        union = shrunk;
        trimmed.push(candidate);
      }
    }
    // A trimmed flat outlier (typically the GROUND PLANE) must not vanish
    // from the volume entirely: the part directly under/around the kept
    // scene still LIGHTS it (receives pools, bounces, occludes). Dropping
    // it left the floor with no probes and no field cells — "no probes
    // know about the floor". Re-add each trimmed box CLIPPED to the kept
    // union's footprint (with modest slack), so the floor slab under the
    // room stays in-volume without the 30m plane blowing the budget.
    if (!union.isEmpty()) {
      for (const candidate of trimmed) {
        const slack = new THREE.Vector3();
        union.getSize(slack).multiplyScalar(0.35);
        const clipRegion = union.clone();
        clipRegion.min.sub(slack);
        clipRegion.max.add(slack);
        const clipped = candidate.clone().intersect(clipRegion);
        if (!clipped.isEmpty()) union.union(clipped);
      }
    }
    return union.isEmpty() ? null : union;
  }

  requestRebuild() {
    this._rebuildQueued = true;
  }

  /**
   * USER-AUTHORED auto-fit bounds: the volume is defined by the component's
   * OWN entity — a mesh entity contributes its world AABB; an empty entity
   * (organizer node) contributes the union of its subtree's mesh AABBs; an
   * empty childless entity falls back to its PARENT's subtree. The result
   * is scaled ×1.05 in #fitBoundsFor so probes sit just behind the walls.
   *
   * Predictable and stable by construction: moving OTHER scene objects can
   * never change the volume. The old scene-wide AABB + flat-outlier-trim
   * heuristics guessed wrong on real scenes AND made every prop drag a
   * potential refit — each refit being a full rebuild with a material
   * recompile wave, i.e. the "editor hangs 20-30s every time I move
   * something" report.
   */
  #autoFitAabb() {
    const object = this.component?.entity?.object3D;
    if (!object) return null;
    // Fresh meshes may not have rendered yet — stale identity matrixWorlds
    // measure rotated walls un-rotated → garbage fit → corrective refit 3s
    // later → a SECOND full compile wave. Update the whole scene once here
    // (covers the entity path AND the whole-scene fallback).
    this.engine.scene?.updateMatrixWorld(true);
    const union = new THREE.Box3();
    const scratch = new THREE.Box3();
    const gather = (root) => {
      // Freshly added meshes may not have rendered yet — a stale identity
      // matrixWorld here produced a garbage first fit (rotated wall planes
      // measured un-rotated), followed 3s later by a corrective refit, i.e.
      // TWO full material-recompile waves at startup instead of one.
      root.updateWorldMatrix(true, true);
      // MANUAL RECURSION, not `traverse` — the visibility test has to PRUNE.
      // `Object3D.traverse` walks the whole subtree and a `return` in its
      // callback only skips that one node, so a hidden GROUP's meshes were
      // still measured: every disabled entity in the scene kept inflating the
      // auto-fit box. That is not cosmetic — the quality presets are fixed
      // voxel/probe BUDGETS, so a box stretched around geometry nobody can
      // see makes the cells coarser everywhere, and once cells exceed half a
      // wall's thickness the field stops being able to keep that wall's two
      // faces apart and indirect light passes straight through it. Same
      // traverse-doesn't-prune bug as `#collectLightObjects` had; the mesh
      // collector in `#collectMeshes` always recursed by hand and was right.
      const visit = (child) => {
        // A mesh folded into an automatic batch is hidden but still renders (as
        // an instance of a scene-root proxy GI deliberately skips), so its own
        // `visible` flag must not exclude it here — see engine/batching.js.
        // Same camera-independence rule as #collectMeshes: auto-fit bounds
        // must not breathe as LOD/occlusion hide things off-screen.
        if (child.visible === false && !child.userData.batchedInto && !child.userData.cameraHidden) return;
        const skip =
          !child.isMesh ||
          child.userData.__giDebug ||
          ((child.layers.mask >>> 0) & 0x80000000) !== 0 || // editor-only helpers
          child.layers.isEnabled(UI_LAYER) || // HUD quads are not world geometry
          !child.geometry?.attributes?.position;
        if (!skip && meshWorldBox(child, scratch)) union.union(scratch);
        for (const grandchild of child.children) visit(grandchild);
      };
      visit(root);
    };
    gather(object);
    this._boundsSource = `entity "${this.component.entity.name ?? "?"}"`;
    if (union.isEmpty() && object.parent) {
      // Empty childless entity → parent subtree. When the parent IS the
      // scene root, a plain union swallows scene-sized ground planes and
      // the whole quality budget goes to empty air (0.5m cells → blocky
      // shadows, probe-lattice checkerboards, leaks through sub-cell
      // walls). Use the trim heuristic for that case — a component parked
      // on a bare root entity should behave like the old scene fit, not
      // worse.
      if (object.parent === this.engine.scene || !object.parent.parent) {
        this._boundsSource = "whole scene (component on a bare root entity — attach it to the room for exact bounds)";
        return this.#sceneAabb(this.#collectMeshes());
      }
      gather(object.parent);
      this._boundsSource = `parent of "${this.component.entity.name ?? "?"}"`;
    }
    return union.isEmpty() ? null : union;
  }

  /**
   * The auto-fit volume for a scene AABB — the SINGLE source of truth used
   * by both #rebuild and the refit check (comparing anything other than
   * "what a rebuild would actually produce" invites refit oscillation).
   *
   * The result is LATTICE-SNAPPED: the probe spacing is quantized onto
   * PROBE_SPACING_LADDER and both faces of the box land on multiples of it.
   * The volume therefore changes only in whole probe cells, and probes keep
   * fixed world positions while the scene is edited.
   *
   * The ×1.05 content pad plus ONE PROBE LAYER of margin per face is load
   * bearing: a bare 1.05 (2.5% per side) is thinner than a probe spacing on
   * any normal room, so surfaces facing OUT of the volume (wall backs, the
   * ceiling TOP) had no probes on their side of the geometry — the gather
   * then interpolated room-interior probes through the thin shell, and the
   * trilinear tent × backface-rejection weights painted a dark-diamond
   * checkerboard across the outside faces. A real (dark) probe layer out
   * there makes outside surfaces honestly, uniformly dark instead.
   */
  #fitBoundsFor(aabb) {
    const center = new THREE.Vector3();
    aabb.getCenter(center);
    const span = new THREE.Vector3();
    aabb.getSize(span);
    const budget = QUALITY_BUDGETS[qualityTierOf(this.config)];
    // Spacing and margin depend on each other, so solve it: pick a spacing
    // from the content, snap the box onto that lattice, and step the spacing
    // up a rung if the snapped box would exceed the per-axis cap.
    const contentX = Math.max(4, span.x * 1.05);
    const contentY = Math.max(2, span.y * 1.05);
    const contentZ = Math.max(4, span.z * 1.05);
    let spacing = quantizeSpacing(
      Math.max(
        0.05,
        Math.cbrt((contentX * contentY * contentZ) / budget.probes),
        Math.max(contentX, contentY, contentZ) / budget.probeAxis,
      ),
    );
    // Grow the box by ONE probe spacing per face, then snap BOTH faces
    // outward to the global lattice (multiples of `spacing` in world space).
    // Snapping is what makes the fit stable: the box only ever changes in
    // whole probe cells, and probes keep the same world coordinates across
    // edits. It also contributes up to another full spacing of margin, so
    // the effective margin is 1-2 spacings — the outside-facing probe layer
    // the old fixed 1.5 was there to guarantee is still guaranteed, without
    // spending an extra 0.5 spacing of volume (and hence of density) on it.
    const laid = (step) => {
      const margin = step;
      const min = new THREE.Vector3(
        Math.floor((center.x - contentX / 2 - margin) / step) * step,
        Math.floor((center.y - contentY / 2 - margin) / step) * step,
        Math.floor((center.z - contentZ / 2 - margin) / step) * step,
      );
      const max = new THREE.Vector3(
        Math.ceil((center.x + contentX / 2 + margin) / step) * step,
        Math.ceil((center.y + contentY / 2 + margin) / step) * step,
        Math.ceil((center.z + contentZ / 2 + margin) / step) * step,
      );
      return { min, max, counts: max.clone().sub(min).divideScalar(step).round() };
    };
    let box = laid(spacing);
    for (let guard = 0; guard < PROBE_SPACING_LADDER.length; guard++) {
      const worst = Math.max(box.counts.x, box.counts.y, box.counts.z);
      if (worst <= budget.probeAxis && worst <= MAX_PROBE_AXIS) break;
      const next = PROBE_SPACING_LADDER.find((step) => step > spacing * 1.0001);
      if (!next) break;
      spacing = next;
      box = laid(spacing);
    }
    const fitCenter = box.min.clone().add(box.max).multiplyScalar(0.5);
    return {
      center: fitCenter,
      sizeX: box.max.x - box.min.x,
      sizeY: box.max.y - box.min.y,
      sizeZ: box.max.z - box.min.z,
      min: box.min,
      max: box.max,
      probeSpacing: spacing,
      probeCounts: box.counts,
    };
  }

  dispose() {
    for (const unsub of this._unsubs) unsub?.();
    this._unsubs = [];
    this.#dispose();
    this.component = null;
  }

  /** Explicit diagnostic readback; never called from the frame path. */
  async readRayHitStats(renderer = this.engine.renderer) {
    const debug = this.state?.volume?.occupancyField?.rayHitDebug;
    return debug && renderer ? debug.readback(renderer) : null;
  }

  // -------------------------------------------------------------------------

  #tick() {
    const component = this.component;
    if (!component || !component.enabled) return;
    const renderer = this.engine.renderer;
    if (!renderer) return;
    registerGILight(renderer);
    // Must be live before the FIRST build's dispatches — the build happens
    // inside this tick, and its kernels are the big ones.
    installAsyncComputePipelines(renderer);
    // Runs before every early-out below: a retired target must be freed even
    // while a compile wave holds the rest of this tick.
    this.#drainRetiredTargets();

    // BOOT AMBIENT — the answer to "black screen for 30 seconds until GI
    // appears". In a GI-lit scene GI IS the ambient: an interior renders
    // pitch black until the field's first composite, however long assets +
    // the compile wave take (probe screenshot: draw calls live, one sunlit
    // floor strip, everything else black — physics, not a bug). A neutral
    // hemisphere carries the frame from the first tick until the field's
    // first composite lands (`statsLogged`), then leaves — so startup shows
    // a flat-lit scene that GI then deepens, instead of a void that GI
    // eventually replaces. Cold boot only: rebuilds keep the previous
    // field's light on screen and never re-enter here.
    // FADES to zero and STAYS in the scene: removing a light changes three's
    // lights hash, which forces a second full material-recompile wave — the
    // exact freeze this feature exists to paper over. A zero-intensity
    // hemisphere is a few dead uniforms per material.
    //
    // DEFAULT OFF as of 2026-08-07, and it took a user report to earn that.
    // This shipped default-on and silently ADDS A LIGHT THE SCENE DOES NOT
    // HAVE: it is a raw three.js object, not an entity, so it has no outliner
    // row, no Inspector control and no log line. The report was "there is some
    // weird ambient to the GI, even before the light itself loaded in ... yet
    // scene does not have any ambient" — which is an exactly correct reading of
    // the scene graph, and the renderer was the thing lying. A module may not
    // put light in a scene the author cannot see or switch off, so this is now
    // the `bootAmbient` prop and it starts off.
    //
    // WHY IT NEVER LEFT (the actual bug, independent of the default): the fade
    // was gated on `state.statsLogged`, which is not a rendering predicate at
    // all — it is the one-shot flag for the occupancy STATS LOG, and
    // #maybeLogStats returns early unless `state.entries.length` is non-zero
    // AND every entry is resident in the atlas. So a scene that composites GI
    // perfectly well but has an empty entry list, or one entry that never lands
    // in the atlas, keeps a 0.6 blue-grey hemisphere over it forever. The real
    // "GI is on screen now" signal is `_fieldReadyOnce`, which is what
    // #maybeLogStats is itself gated on one level up (see its call site).
    // Gate on that, and — because no predicate is worth trusting alone here —
    // cap the whole thing in wall-clock ticks so "never fades" is not a
    // reachable state no matter what the field does.
    // ── THE SKY, RE-READ EVERY FRAME ─────────────────────────────────────
    // It comes from `scene.environment` + `environmentIntensity` now, and
    // NOTHING NOTIFIES GI when those change: the scene owns them, Scene
    // Settings and the HDRI Environment component write them directly, and
    // there is no property change to hook. So it is polled — two field reads
    // and a colour write, next to the boot-ambient poll that is here for the
    // same reason. Without this the sky is only sampled at build time, which
    // reads on screen as "the environment slider does nothing".
    if (this.state?.skyRadiance) {
      sceneSkyRadiance(this.engine?.scene, this.state.skyRadiance.value);
    }
    const bootStep = bootAmbientStep({
      enabled: this.config.bootAmbient === true
        && globalThis.__giNoBootAmbient !== true,
      hasState: !!this.state,
      hasLight: !!this._bootAmbient,
      composited: !!this._fieldReadyOnce,
      everComposited: !!this._everComposited,
      ticks: this._bootAmbientTicks ?? 0,
      intensity: this._bootAmbient?.intensity ?? 0,
    });
    if (bootStep.action === "create") {
      this._bootAmbient = new THREE.HemisphereLight(0xcfd8e6, 0x4a4238, bootStep.intensity);
      this._bootAmbient.name = "gi-boot-ambient";
      this._bootAmbientTicks = 0;
      this.engine.scene.add(this._bootAmbient);
    } else if (bootStep.action !== "none") {
      this._bootAmbientTicks = bootStep.ticks;
      this._bootAmbient.intensity = bootStep.intensity;
      if (bootStep.expired && !this._bootAmbientWarned) {
        this._bootAmbientWarned = true;
        console.warn(
          `[gi] boot ambient hit its ${GI_BOOT_AMBIENT_MAX_TICKS}-tick cap without GI `
          + "compositing — fading it out anyway. The scene will be dark until the field "
          + "lands; that is the real GI result, not a bug in this light.",
        );
      }
      if (bootStep.action === "release") {
        this._everComposited = true;
        this._bootAmbient = null;
      }
    }

    // While a compile wave runs, do NOTHING here: dispatching computes
    // would sync-compile pipelines inside this frame, and processing a
    // queued rebuild would swap state under the running wave and stack a
    // second wave on top (the repeated viewport-freeze episodes report).
    // _rebuildQueued persists — the rebuild runs when the wave ends.
    if (this.engine.renderSuspended) return;
    if (this._rebuildQueued && this.#readyToRebuild()) {
      this._rebuildQueued = false;
      this.#rebuild();
    }
    const state = this.state;
    if (!state) return;

    // Belt-and-braces for the lights-hash memo bug (#purgeLightsHashMemo):
    // purge once more a few frames after every build, when async pipeline
    // compiles have settled. A purge is nearly free (one small map) and,
    // unlike the old light-instance swap, does NOT force a second full
    // material-recompile wave — that swap was half of the user's
    // multi-second freezes on rebuilds.
    if (this._lightsRefreshTicks > 0 && state.light) {
      this._lightsRefreshTicks--;
      if (this._lightsRefreshTicks === 0) this.#purgeLightsHashMemo();
    }

    // Analytic lights AND promoted emissive emitters are per-frame uniforms
    // — moving either re-lights the field this same frame, no bake involved.
    this.#updateLightUniforms();
    // Live lift A/B for the wall-leak question (`__giShadowLift`, voxels;
    // default 1.5 = shipped behaviour). Outside the temporal block below
    // because the analytic-width arm builds no temporal uniforms yet still
    // owns a lift.
    if (state.screen?.lightShadow?.liftFactor) {
      state.screen.lightShadow.liftFactor.value = globalThis.__giShadowLift ?? 1.5;
    }
    if (state.screen?.lightShadow?.exactBiasFactor) {
      state.screen.lightShadow.exactBiasFactor.value = Number(globalThis.__giShadowExactBias) || 0.02;
    }
    // Wide-penumbra pass camera (viewDist for the world→texel radius map).
    if (this._giShadowWideCamU && this.engine.camera) {
      this.engine.camera.getWorldPosition(this._giShadowWideCamU.value);
    }
    // Shadow-channel temporal accumulation inputs (see the filter pass):
    // the animated sun-disc jitter frame, the PREVIOUS camera view-projection
    // for reprojection, and the history weight — zeroed while any light is
    // moving (a rotating sun makes every pixel's history semantically stale;
    // position validation can't see that, so the system flushes instead —
    // grain during rotation, converges the moment it stops).
    // VELOCITY-SCALED MEMORY. Moving lights are the DESIGN CASE here, not
    // an edge case — the user's sun is script-driven ("we never meant to
    // do those lights static"). Two earlier designs failed it: a flush on
    // any transform change turned a per-frame script write into a
    // PERMANENT flush (accumulation never engaged — the "grainy, dirty,
    // hard dithered edge" trio is the un-accumulated estimator), and a
    // binary moved/still split would still gut the memory for a slow day
    // cycle whose shadow edge moves sub-pixel per frame. A moving light
    // only makes history STALE, never wrong-surface, so the memory depth
    // follows the measured angular velocity: imperceptible motion keeps
    // ~32 effective sun samples (0.94), a fast gizmo drag drops to ~7
    // (0.86 → a few frames of trailing softness on the sweeping edge,
    // the standard real-time-shadows trade). Intensity changes are
    // deliberately ignored — the shadow factor is pure visibility.
    //
    // HOISTED out of the shadow-pass gate below (§12.38): SRC's motion-
    // adaptive α reads the same measurement, in scenes where no light asks
    // for gi shadows at all. ONE computation on purpose — the WeakMap prev is
    // CONSUMED by the delta (each read overwrites it), so a second loop
    // "for SRC" would read zeros forever and the two memories would disagree
    // about whether the scene is moving.
    {
      let motion = 0;
      let lumMotion = 0;
      this._giShadowLightPrev ??= new WeakMap();
      for (const light of this._lightObjects ?? []) {
        const e = light.matrixWorld.elements;
        let prev = this._giShadowLightPrev.get(light);
        if (!prev) {
          prev = { dir: new THREE.Vector3(), pos: new THREE.Vector3(), lum: 0, seeded: false };
          this._giShadowLightPrev.set(light, prev);
        }
        // Emitted luminance, tracked beside the matrix. §12.38.3 named the
        // blind spot and the user then hit it in as many words ("temporal is
        // way too slow, making light too slow to change"): the matrix terms
        // cannot see a lamp toggling or a color fade, so those converge at
        // the STILL floor. The delta is RELATIVE (a toggle reads 1.0 whatever
        // the absolute intensity), which drops it into the same saturation
        // constant as the matrix terms: a one-frame toggle saturates the α
        // ramp outright, a fade holds it up for its own duration, sub-0.1%
        // per-frame flicker stays under the floor.
        const c = light.color;
        const lum = (light.intensity ?? 0) *
          (c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 1);
        if (prev.seeded) {
          // z-column delta ≈ radians for small rotations; translation folds
          // in at 5cm ≈ 1° so dollying a point light shortens memory too.
          const dirDelta = Math.hypot(e[8] - prev.dir.x, e[9] - prev.dir.y, e[10] - prev.dir.z);
          const posDelta = Math.hypot(e[12] - prev.pos.x, e[13] - prev.pos.y, e[14] - prev.pos.z);
          motion = Math.max(motion, dirDelta + posDelta * 0.05);
          lumMotion = Math.max(lumMotion,
            Math.abs(lum - prev.lum) / Math.max(prev.lum, lum, 1e-3));
        }
        prev.dir.set(e[8], e[9], e[10]);
        prev.pos.set(e[12], e[13], e[14]);
        prev.lum = lum;
        prev.seeded = true;
      }
      this._giShadowLastMotion = motion;
      // SEPARATE track, deliberately: `_giShadowLastMotion` also drives the
      // GI shadow pass's temporal weights, and the shadow factor is PURE
      // VISIBILITY — an intensity fade must not shorten shadow memory, only
      // SRC's radiance memory (the sceneMotion closure below is its one
      // consumer).
      this._giLightLumMotion = lumMotion;
    }
    // (Analytic-width arm: `_giShadowFrameU` is never created, the whole
    // block compiles out of the frame — no phase, no history weights.)
    if (state.screen?.lightShadowPass && this._giShadowFrameU) {
      const camera = this.engine.camera;
      if (camera) {
        if (this._giPrevVPStore) this._giShadowPrevVPU.value.copy(this._giPrevVPStore);
        (this._giPrevVPStore ??= new THREE.Matrix4()).multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        );
      }
      const motion = this._giShadowLastMotion ?? 0;
      const temporalOn = globalThis.__giShadowTemporal !== false;
      // DEDICATED phase counter — NOT `this._frame`, which is a scan-cadence
      // counter that #queueRebakeCheck RESETS to -1 on every change event. A
      // scene with any per-frame transform write (the user's script-driven
      // sun, any animated prop) pinned `_frame` near zero, the "animated"
      // jitter oscillated between two phases, and the accumulation converged
      // to a frozen two-sample stipple — measured by run-gi-shadow-motion as
      // flicker 0.0000 with grain 0.2262: temporally rock-solid, spatially
      // filthy, exactly the user's "still grainy" verdict.
      this._giShadowPhase = ((this._giShadowPhase ?? 0) + 1) % 4096;
      this._giShadowFrameU.value = temporalOn ? this._giShadowPhase : 0;
      this._giShadowHistWeightU.value = temporalOn
        ? Math.min(0.94, Math.max(0.86, 0.94 - motion * 30))
        : 0;
      // The emitter channel gets the SAME motion-adaptive weight — it is the
      // same camera, the same reprojection, and the same class of stochastic
      // estimator, so there is no principled reason for the two to disagree. It
      // is a separate uniform purely so the arms can be A/B'd independently
      // (`__giEmitterHistWeight` pins it; `__giNoEmitterTemporal` removes the
      // chain at build time).
      //
      // Null-guarded: the uniform only exists on builds where the emitter
      // temporal chain was actually constructed — `emissiveShadows` off, or the
      // hatch set, and there is no emitter pass at all.
      if (this._giEmitterHistWeightU) {
        const pin = Number(globalThis.__giEmitterHistWeight);
        this._giEmitterHistWeightU.value = !temporalOn
          ? 0
          : Number.isFinite(pin)
            ? Math.min(0.99, Math.max(0, pin))
            : Math.min(0.94, Math.max(0.86, 0.94 - motion * 30));
      }
    }
    // (THE TRANSPORT'S PER-FRAME UNIFORM WRITES LIVED HERE — the gather's
    // surface/view bias, the probe-snap and depth-moment alphas, the field
    // radiance EMA, and the feedback/trace checkerboard parities. All of them
    // addressed kernels that §12.8 deleted; the presets and their live
    // `__gi*` overrides are recorded in the plan so Phase 1-3 can re-tune
    // rather than re-derive them.)
    this.#refreshEmitterSlots();
    // Slot transforms track live matrices — dragging a mesh updates its
    // uniforms here, which bumps the atlas revision and re-runs the
    // composite below. That IS the whole cost of moving scene geometry.
    state.atlas.refreshTransforms();
    // Same contract for the exact-reflection BVH scene (GI Phase 3 v1): a
    // moving mesh is a per-mesh uniform update, never a buffer rebuild.
    state.bvhScene?.refreshTransforms();
    // And for the occupancy pyramid: matrices only. Its triangle buffers and
    // work list are rotation/translation invariant by construction, so a drag
    // never touches them — see #buildOccupancyField.
    this.#refreshOccupancyTransforms(state.volume.occupancyField);
    // AFTER the transform refresh, so the bounds this reads are this frame's.
    // Reading them before would publish the previous pose's occluder spheres and
    // give every mover shadow a one-frame lag against its own geometry.
    this.#syncMoverOccluders();
    // Exact dynamic objects: live transforms into the header region, queued
    // geometry uploads, deferred voxel-slot parking. Before the gbuffer/
    // compute work so this frame's rays see this frame's pose.
    this.#refreshDynamicObjects(renderer, state);
    // The deferred resolve reads THIS frame's gbuffer, so the prepass renders
    // before any compute is dispatched. It is a nested render (one override
    // material, editor layers excluded) that restores renderer state.
    if (state.screen) {
      this.#syncScreenResolveSize(state);
      // UNCONDITIONAL where it used to be gated on the cascade radiance bundle
      // existing: the resolve's back-face flip, its view bias and the emitter
      // shadow pass all read this, and none of them is about reflections
      // (see #buildScreenResolve's note on `_giResolveCamU`).
      if (this._giResolveCamU) this.engine.camera.getWorldPosition(this._giResolveCamU.value);
      // The mirror-mask second pass is only worth its projection walk when
      // something will actually read the mask — i.e. when the sparse exact
      // prepass is about to run. Without exact reflections the gbuffer's
      // normal.w stays 0 everywhere, exactly as before this existed.
      const wantsMirrorMask = !!state.screen.bvhReflect && this.#bvhReflectionsEnabled() && this.#bvhMaskEnabled();
      renderGiGBuffer(renderer, this.engine.scene, this.engine.camera, state.screen.gbuffer, {
        mirrorMask: wantsMirrorMask,
      });
      // [A] → [B]: probe population reads the gbuffer that was just rendered,
      // so it goes here and nowhere else. Ahead of every other compute for the
      // same reason the gbuffer is ahead of the resolve — this is the frame's
      // first consumer of this frame's geometry.
      //
      // NOT in `state.queue`: that queue is rate-gated, idle-skipped and
      // freeze-bisected, and every one of those would be wrong here. Skipping
      // population on an idle frame ages every probe toward retirement while
      // the camera sits still, which is the opposite of what idle means.
      if (state.screen.srcProbes) {
        const reanchored = state.screen.srcProbes.syncCamera(this.engine.camera);
        if (reanchored && state.screen.srcProbes.reanchorCount > 1) {
          console.log(
            `[gi] src probes: re-anchored (#${state.screen.srcProbes.reanchorCount}) — ` +
            "every probe re-keys, which retires it; positions are unchanged",
          );
        }
        giCompute(renderer, state.screen.srcProbes.passes);
        this.#maybeLogSrcProbeStats(renderer, state);
      }
      // BVH exact-reflection prepass: dispatched right after the gbuffer,
      // EVERY frame it's enabled — independent of the atlas-revision
      // composite gating above/below (that gating is about the SDF field
      // re-converging; this pass just re-traces the current gbuffer against
      // the current BVH transforms, which are already live-updated). The
      // `__giNoBvhReflections` hatch is re-checked here too (not just at
      // build time) so flipping it live stops the GPU cost immediately,
      // even though the material-side compile-time switch only takes full
      // effect on the next rebuild/sync (see `#syncBvhScene`).
      if (state.screen.bvhReflect && this.#bvhReflectionsEnabled()) {
        this.engine.camera.getWorldPosition(this._bvhCameraPosition.value);
        giCompute(renderer, state.screen.bvhReflect.compute);
      }
      // GPU atlas blit for tiles the CPU canvas path in bvhScene.js could
      // never draw (KTX2/Basis-compressed material maps — see
      // buildAlbedoAtlas's own comment): deferred to here rather than run
      // inside #syncBvhScene itself, because that can fire off the render
      // loop (a mesh add/remove triggers it synchronously) and this needs a
      // live renderer mid-frame, exactly like renderGiGBuffer's own nested
      // render just above. Self-guarding (see blitBvhAtlasTiles's own
      // comment) — cheap to call every tick, only does real work once per
      // bvhScene build.
      if (state.bvhScene?.pendingGpuTiles?.length) {
        const blitted = blitBvhAtlasTiles(renderer, state.bvhScene);
        if (blitted > 0) {
          console.log(`[gi] bvh: atlas gpu-blit: ${blitted} compressed tiles`);
        }
      }
    }
    // THE FEEDBACK RATE, THE PEAK SPLIT AND THE STAGE-FREEZE BISECT ALL WENT
    // WITH THE TRANSPORT (§12.8), and the bisect is the one worth a word. Its
    // prefixes — "field", "transport", "traces", "merges" — named the feedback
    // pass, the cascade traces, the merges and the probe integral. With none of
    // those in the queue every cut would have silently degraded to "run the
    // whole thing", i.e. a knob that reports success and does nothing, which is
    // a failure mode this module has already paid for twice (the coerced
    // `c0DirRes` string and the stale `backend` value). So they are GONE rather
    // than left to lie. `__giFreeze = "all"` survives because it still means
    // exactly what it says: recompute nothing, and look at whether the picture
    // still moves.
    //
    // The QUEUE TRIPLET survives, with identical contents, on purpose: every
    // screen pass is hot-swapped BY INDEX into all three arrays on resize
    // (#syncScreenResolveSize, ~25 sites), and Phase 1-3 gives them different
    // contents again. Collapsing them here means rewriting that path twice.
    const freeze = globalThis.__giFreeze;
    // ── THE FRAME SKIP SET, HOISTED ABOVE EVERY DISPATCH SITE (§13.14.8) ────
    //
    // It used to be built just before the MAIN dispatch (the block further
    // down), which left the occupancy-wait path dispatching `state.queue` RAW
    // — and every boot takes that path while pipelines are pending. So the
    // light-shadow chain, "skipped at warm-up, never dispatched", had its
    // pipeline created by the first occ-wait frame anyway: 44-133 s of
    // compile for a chain no light uses, which the naming instrument finally
    // pinned as `#47 [lightShadowPass]` after five fingerprint-based
    // misattributions. One skip set, computed once, applied to EVERY dispatch
    // of the queue — a second dispatch site must never re-derive it.
    const frameSkip = new Set();
    // 1. No emitters: the trace early-outs at 0.018ms but its bilateral
    // FILTER still blurred a whole 695x227 texture for 0.119ms — 6x the
    // trace it was filtering — on a scene logging "0 emitters".
    if (!(this._emitterInfos?.length > 0) && state.screen?.emitterShadowPass) {
      frameSkip.add(state.screen.emitterShadowPass.compute);
      frameSkip.add(state.screen.emitterShadowFilterPass?.compute);
      // The temporal pair is the same dead weight with zero emitters — and
      // more of it, since it is two more full-texture passes.
      frameSkip.add(state.screen.emitterShadowHistoryPass?.compute);
      frameSkip.add(state.screen.emitterShadowPostPass?.compute);
    }
    // 2. No light asks for GI-traced direct shadows (the user's measured
    // finding, 2026-08-07: a directional light on three's shadow map runs
    // 2.6ms vs 5.4ms and looks better, so `map` is the normal case now).
    // `giShadow` is cleared per frame for every off/hidden/map-mode light,
    // which makes it an exact live signal — and when every slot reads 0 the
    // trace writes the inert 1 into a texture only gi-mode lights sample.
    // Flipping a light's Shadow Source stays a UNIFORM WRITE: the pass is
    // still there, dispatch resumes next frame, and its pipeline compiles
    // async on first use while frames keep flowing.
    const anyGiShadowLive = (state.lightSlots ?? []).some((s) => (s?.giShadow?.value ?? 0) > 0);
    if (!anyGiShadowLive && state.screen?.lightShadowPass) {
      for (const name of [
        "lightShadowPass", "lightShadowFilterPass", "lightShadowWidePass",
        "lightShadowWidePass2", "lightShadowHistoryPass", "lightShadowPostPass",
      ]) frameSkip.add(state.screen[name]?.compute);
    }
    frameSkip.delete(undefined);
    const rateQueue = freeze === "all"
      ? []
      : (frameSkip.size ? state.queue.filter((node) => !frameSkip.has(node)) : state.queue);
    let frameQueue = rateQueue;
    // Converged-idle sleep (see GI_IDLE_AFTER_FRAMES): count frames of
    // bit-identical field input. The composite branch below resets the count
    // — any geometry/atlas change is by definition not quiet.
    const inputHash = this.#fieldInputHash();
    if (inputHash !== this._fieldInputSeen) {
      this._fieldInputSeen = inputHash;
      this._fieldQuietFrames = 0;
    } else {
      this._fieldQuietFrames = (this._fieldQuietFrames ?? 0) + 1;
    }
    // WHAT MAKES THE FIELD STALE — three signals, not one.
    //
    // The atlas revision alone was enough only while every scene change also
    // produced a mesh-SDF arrival. It does not cover:
    //   · the occupancy pyramid being re-voxelized (a changed MESH SET — see
    //     #refreshOccupancyContent; `geometryRevision` deliberately ignores
    //     per-frame transform updates, which the revision path already covers);
    //   · the very first frame after a build, when SDF-free means no bake will
    //     ever arrive to bump anything. That case is the reported "relaunch
    //     with SDF-free and there is no GI at all, just black": the composite
    //     never ran, so no cell was ever marked occupied, so nothing bounced.
    const occGeometryRevision = state.volume.occupancyField?.geometryRevision ?? 0;
    if (
      this._atlasRevisionSeen !== state.atlas.revision ||
      this._occGeometrySeen !== occGeometryRevision ||
      !this._fieldReadyOnce
    ) {
      // FLICKER DIAGNOSTIC (`__giLogComposite`). A refresh is supposed to be
      // RARE — it runs when geometry changed, and it has a one-frame window where
      // the pyramid is stale, which the module's own comment describes as reading
      // like flicker. If this reports a steady non-zero rate on a scene where only
      // a LIGHT moves, something is bumping a revision it shouldn't and that
      // cadence IS the flicker. Also records WHICH trigger fired.
      // (Kept under its old name: the pass it counted WAS this branch, and it
      // still answers the same question.)
      if (globalThis.__giLogComposite) {
        this._compositeCount = (this._compositeCount ?? 0) + 1;
        this._compositeWhy = this._compositeWhy ?? { atlas: 0, occ: 0, first: 0 };
        if (this._atlasRevisionSeen !== state.atlas.revision) this._compositeWhy.atlas++;
        else if (this._occGeometrySeen !== occGeometryRevision) this._compositeWhy.occ++;
        else this._compositeWhy.first++;
      }
      // A refresh frame is never quiet — geometry or the atlas moved.
      this._fieldQuietFrames = 0;
      this._atlasRevisionSeen = state.atlas.revision;
      this._occGeometrySeen = occGeometryRevision;
      this._fieldReadyOnce = true;
      // THE DIRTY-BRICK PATH WENT WITH THE COMPOSITE IT NARROWED. It
      // recomposited only the union AABB of changed slots (`consumeDirtyBounds` →
      // `world.dirtyMin/Max`), preceded by the instance-grid and sparse-page-table
      // rebuilds the composite read to decide which slots a cell could skip. With
      // no composite there is no per-cell pass to narrow — the pyramid's own
      // voxelize is already incremental over the slots that moved.
      //
      // Its hard-won lesson is in plan §12.9 and is no longer learnable from this
      // code: a narrowed recomposite could PERMANENTLY MISS THE PYRAMID ARRIVING.
      // The first composite ran whole-volume against a pyramid whose dispatches
      // were still compiling, and every later one was atlas-bumped with a small
      // AABB — so the rest of the volume kept the empty boot result forever, and
      // nudging the building 1cm "fixed" it (0.021 lum settled boot → 0.105).
      // Anything incremental added over the SRC field has to answer that first.
      const occPasses = state.volume.occupancyField?.isDirty
        ? state.volume.occupancyField.passes()
        : null;
      // Freshly minted nodes each rebuild (see the spawn-blink comment below),
      // so the stamp has to happen at use, not at some one-time build site.
      occPasses?.forEach((n, i) => { if (n && typeof n === "object") n.__giPassName ??= `occupancy#${i}`; });
      const skippedBefore = giSkippedComputes.size;
      // THE SPAWN-BLINK GUARD (2026-08-04, run-gi-spawn-blink measured it), and
      // it OUTLIVES the composite it was written for. A geometry change rebuilds
      // the voxelizer's pair tables, so passes() mints FRESH compute nodes whose
      // pipelines compile async for a few frames. Dispatching the ordered chain
      // then executes the old, already-compiled CLEAR and skips the new voxelize,
      // leaving a half-built pyramid that reads "empty everywhere". That used to
      // blink the whole field black for ~6 frames through the feedback's
      // empty-clear; now it is every shadow ray and every AO tap passing straight
      // through geometry for those frames — the same bug in different clothes.
      // Two rules fix it: while ANY compute pipeline is still compiling, do not
      // dispatch the pyramid chain at all (its half-execution IS the damage); and
      // if a dispatch DID skip (the first tick is what triggers compilation, so it
      // cannot know in advance), bail out before anything consumes the pyramid.
      // Bail frames keep last-good occupancy.
      const occWait = occPasses !== null && giPendingComputePipelines.size > 0;
      let occSkipped = false;
      if (occPasses && !occWait) {
        giCompute(renderer, occPasses);
        occSkipped = giSkippedComputes.size > skippedBefore;
      }
      if (occWait || occSkipped) {
        // Same re-arm the post-batch retry always used — but BEFORE anything
        // consumed the pyramid, which is the whole fix. Skipped dispatches
        // are near-free, so retrying until the pipelines land costs nothing.
        this._fieldReadyOnce = false;
        state.volume.occupancyField?.invalidate();
        giCompute(renderer, rateQueue);
      } else {
        // `rateQueue`, not `state.queue`, so `__giFreeze = "all"` still holds on a
        // refresh frame — otherwise the bisect silently leaks the very stage it is
        // meant to hold still.
        giCompute(renderer, rateQueue);
        if (giSkippedComputes.size > skippedBefore) {
          // Pipelines can still be compiling on the very first builds — same
          // re-arm, and the next tick retries the whole chain.
          this._fieldReadyOnce = false;
          state.volume.occupancyField?.invalidate();
        }
      }
      // Only after a tick whose chain actually ran to completion: on bail/re-arm
      // ticks (`_fieldReadyOnce` false) the buffers may never have been
      // dispatched, and reading them back throws from deep inside the frame loop
      // (the user-reported "reading 'size'" uncaught promise).
      if (this._fieldReadyOnce) this.#maybeLogStats(renderer);
    } else {
      // IDLE SLEEP: with the field input quiet past the threshold, only the
      // camera-dependent passes run. The heartbeat frame runs the full queue.
      // Not while a freeze bisect is active — that owns the queue for
      // diagnostic purposes.
      //
      // DURING THE INTERREGNUM THIS SAVES NOTHING, and it is kept anyway: with
      // no transport in the queue, every pass left IS camera-dependent, so the
      // idle list and the full queue hold the same computes. Phase 1-3 puts the
      // field work back in front of them and the distinction is load-bearing
      // again — the alternative is deleting a branch that already knows the
      // exact ordering constraint (emitter chain before the resolve that
      // samples it) and rediscovering it later.
      const idle =
        !freeze &&
        globalThis.__giNoIdleSleep !== true &&
        (this._fieldQuietFrames ?? 0) > GI_IDLE_AFTER_FRAMES &&
        this._frame % GI_IDLE_HEARTBEAT_FRAMES !== 0;
      if (idle) {
        frameQueue = state.screen?.resolve?.compute
          ? [
              // Emitter shadows are camera-dependent too (screen-space
              // texture) and the resolve consumes them — before it.
              ...(state.screen.emitterShadowPass
                ? [
                    state.screen.emitterShadowPass.compute,
                    state.screen.emitterShadowFilterPass.compute,
                    // The temporal pair rides the idle path too: skipping it
                    // would freeze the history at the last awake frame and then
                    // reproject a stale accumulation against a moving camera.
                    ...(state.screen.emitterShadowHistoryPass ? [state.screen.emitterShadowHistoryPass.compute] : []),
                    ...(state.screen.emitterShadowPostPass ? [state.screen.emitterShadowPostPass.compute] : []),
                  ]
                : []),
              state.screen.resolve.compute,
              // The shadow pass is camera-dependent like the resolve — an
              // idle-frozen shadow texture would lag every camera move.
              ...(state.screen.lightShadowPass ? [state.screen.lightShadowPass.compute] : []),
              ...(state.screen.lightShadowFilterPass ? [state.screen.lightShadowFilterPass.compute] : []),
              ...(state.screen.lightShadowWidePass
                ? [state.screen.lightShadowWidePass.compute, state.screen.lightShadowWidePass2.compute]
                : []),
              ...(state.screen.lightShadowHistoryPass ? [state.screen.lightShadowHistoryPass.compute] : []),
              ...(state.screen.lightShadowPostPass ? [state.screen.lightShadowPostPass.compute] : []),
            ]
          : [];
      }
      // NO EMITTERS, NO EMITTER PASSES. The emitter shadow trace and its
      // bilateral filter are built whenever `emissiveShadows` is on — that is
      // a CAPABILITY (MAX_EMITTERS uniform slots), not a statement that the
      // scene contains an emissive mesh. With zero emitters the trace early-
      // outs cheaply but the FILTER still blurs a whole texture for nothing:
      // measured 0.119ms per frame at a 695x227 emitter target on the user's
      // Sponza (which logs "0 emitters"), against 0.019ms for the trace it is
      // filtering. Emitter infos refresh every frame, so this is a live check
      // and a promoted emissive mesh brings both passes straight back.
      // ── CAPABILITY IS NOT USE (both skips below) ────────────────────────
      // The GI screen chain is built from FIXED-SIZE slot arrays — MAX_EMITTERS
      // emitter slots, MAX_GI_LIGHTS light slots — so the passes exist as soon
      // as the feature is compiled in, whether or not the scene has a single
      // emissive mesh or a single light flagged Shadow Source "gi". Skipping
      // them here rather than at build time keeps the contract those bundles
      // document: flipping a light's Shadow Source stays a UNIFORM WRITE, never
      // a GI rebuild. The pass is still there; it just stops being dispatched
      // on frames where nothing reads it.
      // The skip set is FRAMESKIP now, hoisted above rateQueue's construction
      // (see the §13.14.8 comment there) so the occupancy-wait path cannot
      // dispatch what this path skips. rateQueue is already filtered; this
      // second filter only matters when frameQueue was rebuilt from another
      // source above (idle lists), and re-applying a Set is cheaper than
      // proving it never is.
      if (frameSkip.size) frameQueue = frameQueue.filter((node) => !frameSkip.has(node));
      // Guard the empty case: `__giFreeze = "all"` produces no computes, and
      // three's renderer.compute([]) throws "expects a ComputeNode".
      if (frameQueue.length) giCompute(renderer, frameQueue);
    }
    giSkippedComputes.clear();

    this._frame++;
    if (globalThis.__giLogComposite && this._frame % 120 === 0) {
      const why = this._compositeWhy ?? { atlas: 0, occ: 0, first: 0 };
      console.log(
        `[gi] per 120 frames — composites ${this._compositeCount ?? 0} ` +
          `(atlas ${why.atlas}, occupancy ${why.occ}, other ${why.first}), ` +
          `resolve resizes ${this._resolveResizes ?? 0} — both should be 0 when only a light moves`,
      );
      this._compositeCount = 0;
      this._resolveResizes = 0;
      this._compositeWhy = { atlas: 0, occ: 0, first: 0 };
    }
    // NOT gated by autoRebake anymore: there are no bakes to re-run — this
    // scan is what brings LATE-LOADING meshes (GLB models finish after the
    // first build) into the field at all. Gating it made a freshly opened
    // scene render with almost no GI until a settings change forced a
    // rebuild.
    if (this._frame % FINGERPRINT_INTERVAL_FRAMES === 0) {
      this.#checkFingerprint();
    }
  }

  /**
   * Holds a queued rebuild while model or mesh assets are still streaming in.
   * Building before authored geometry lands measures wrong auto-fit bounds, and the corrective
   * refit a few seconds later fires a SECOND full material-compile wave —
   * the user's ~40s startups were two back-to-back 20s waves. Waiting a few
   * frames for the loads costs nothing (there is no GI to lose yet) and
   * collapses startup to ONE wave. A timeout keeps a broken model file from
   * deferring GI forever.
   */
  #readyToRebuild() {
    let pendingModels = 0;
    let pendingMeshes = 0;
    for (const entity of this.engine.entities.values()) {
      const model = entity.getComponent?.("model");
      if (model?.props?.path && !model.root) {
        pendingModels++;
      }
      const mesh = entity.getComponent?.("mesh");
      if (mesh?.assetLoadsPending) pendingMeshes++;
    }
    const pending = pendingModels + pendingMeshes;
    const now = performance.now();
    if (!pending) {
      this._assetWaitStart = null;
      if (this._assetsReadySince == null) {
        this._assetsReadySince = now;
        return false;
      }
      if (now - this._assetsReadySince < ASSET_LOAD_STABLE_MS) return false;
      this._assetsReadySince = null;
      return true;
    }
    this._assetsReadySince = null;
    if (!this._assetWaitStart) {
      this._assetWaitStart = now;
      console.log(
        `[gi] build deferred — waiting for scene assets ` +
        `(${pendingMeshes} mesh, ${pendingModels} model; avoids a double compile wave)`,
      );
    }
    if (now - this._assetWaitStart < ASSET_LOAD_TIMEOUT_MS) return false;
    console.warn(
      `[gi] building despite unfinished scene assets after ${ASSET_LOAD_TIMEOUT_MS / 1000}s ` +
      `(${pendingMeshes} mesh, ${pendingModels} model) — a refit may follow`,
    );
    this._assetWaitStart = null;
    return true;
  }

  /**
   * ROOT CAUSE of the "GI light silently inert" class of bugs (harness-
   * proven): three's `Nodes.getCacheKey(scene, lightsNode)` memoizes the
   * lights hash per [scene, lightsNode] and only recomputes when
   * `renderer.info.calls` DIFFERS from the memoized call id — but
   * `info.calls` resets every frame and lands on the SAME value at the same
   * point of a static frame, so the memo never invalidates. Materials that
   * compiled before the GI light existed then never see the lights-hash
   * change, `needsUpdate` stays false, and the light contributes nothing —
   * on some scenes forever (whether it worked depended on draw-call-count
   * coincidences). Dropping the memo forces a fresh hash next frame, which
   * flags every stale pipeline for a rebuild against the current lights.
   */
  #purgeLightsHashMemo() {
    const nodes = this.engine.renderer?._nodes;
    if (nodes?.callHashCache?.constructor) {
      nodes.callHashCache = new nodes.callHashCache.constructor();
    }
  }

  /**
   * Non-blocking material compile wave after a (re)build: the scene render
   * is suspended (viewport holds its last frame, app stays interactive)
   * while `renderer.compileAsync` builds node graphs with main-thread
   * yields and creates pipelines via `createRenderPipelineAsync` (driver
   * threads). Rendering resumes as soon as the cache is warm — the render
   * loop then finds every pipeline ready instead of blocking for the whole
   * wave inside one frame.
   */
  /**
   * If a render override (PostprocessComponent) owns the active camera, its
   * PassNode renders the scene — warm THAT pipeline context (PassNode's own
   * compileAsync binds its render target + MRT around a scene compile).
   * Returns true when an override pass was warmed. Idempotent per pass
   * instance so the wave's start-and-end calls don't compile twice.
   */
  async #warmOverridePass(renderer) {
    const engine = this.engine;
    let override = null;
    for (const o of engine.renderOverrides ?? []) {
      if (o.ownsCamera?.(engine)) {
        override = o;
        break;
      }
    }
    const pass = override?.scenePass;
    if (!pass?.compileAsync) return false;
    if (this._warmedScenePass === pass) return true;
    await pass.compileAsync(renderer);
    this._warmedScenePass = pass;
    return true;
  }

  async #compileWave() {
    const engine = this.engine;
    const renderer = engine.renderer;
    if (!renderer?.compileAsync || !engine.camera || !engine.scene) return;
    const token = (this._compileToken = {});
    const state = this.state;
    const pendingLight = state?.light?.parent !== engine.scene ? state?.light : null;
    const overrideOwnsCamera = [...(engine.renderOverrides ?? [])].some((override) => override.ownsCamera?.(engine));
    // The normal editor render path can stay fully live while the expensive
    // GI variants compile. Three's supported third compileAsync argument lets
    // the REAL scene provide render objects/cache identity while this tiny
    // target scene contributes the not-yet-live GI light and environment.
    // A postprocess-owned camera needs its real PassNode target/context and
    // therefore keeps the suspended fallback below.
    const backgroundCompile = !!pendingLight && !overrideOwnsCamera;
    const compileObjects = [];
    const compileTarget = backgroundCompile ? new THREE.Scene() : null;
    if (compileTarget) {
      compileTarget.background = engine.scene.background;
      compileTarget.environment = engine.scene.environment;
      compileTarget.environmentIntensity = engine.scene.environmentIntensity;
      compileTarget.environmentRotation.copy(engine.scene.environmentRotation);
      compileTarget.fog = engine.scene.fog;
      engine.scene.updateMatrixWorld(true);
      engine.scene.traverseVisible((object) => {
        if (object.isLight) {
          // A clone keeps the live light's bind groups owned by the live
          // render objects. Only the light TYPE/state matters to the shader
          // and pipeline cache warmed here.
          compileTarget.add(object.clone());
          return;
        }
        if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
        // compileAsync accepts an individual object plus a target scene. Keep
        // the imported object in its real hierarchy (some custom subclasses
        // cannot be shallow-cloned), while compileTarget gives its RenderObject
        // a separate scene/cache identity and therefore separate bind groups.
        compileObjects.push(object);
      });
    }
    if (pendingLight) {
      if (backgroundCompile) compileTarget.add(pendingLight);
      else engine.scene.add(pendingLight);
    }
    // Re-warm from scratch each wave — a wave exists because pipelines were
    // invalidated (new GI light state), so a previously warmed pass is stale.
    this._warmedScenePass = null;
    engine.renderSuspended = !backgroundCompile;
    // three's yieldToMain prefers scheduler.yield(), whose continuations
    // OUTRANK rendering in Chrome — the whole wave still starved rAF (a
    // single 12s frame gap, harness-measured). A macrotask yield lets the
    // browser interleave frames/input between compile chunks.
    const scheduler = globalThis.scheduler;
    const originalYield = scheduler?.yield;
    // TIME-BUDGETED YIELD — the whole wave cost lived here (harness-measured
    // 2026-08-02): three yields after every crumb of build work (per shader
    // stage per object), and every real macrotask yield waits out a full
    // frame of whatever else startup is doing (asset decodes, the chunked
    // field composite). 262 yields × ~230ms startup frames = 60s of a 62s
    // wave WAITING, on ~2s of actual JS build work. So: run the build in
    // ~40ms uninterrupted slices and only take a real macrotask yield
    // between slices — frames/input still interleave, but the wave stops
    // queueing behind itself a couple hundred times.
    const yieldStats = { count: 0, waited: 0, skipped: 0 };
    let lastRealYield = performance.now();
    if (originalYield)
      scheduler.yield = () => {
        if (performance.now() - lastRealYield < 40) {
          yieldStats.skipped++;
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          const tY = performance.now();
          setTimeout(() => {
            yieldStats.count++;
            yieldStats.waited += performance.now() - tY;
            lastRealYield = performance.now();
            resolve();
          }, 0);
        });
      };
    // PIPELINE COMPILES RUN CONCURRENTLY, not one at a time. three's
    // compileAsync walks render objects sequentially and awaits each
    // `createRenderPipelineAsync` before starting the next ("process
    // compilation work items sequentially to avoid freezing") — but that
    // await is idle main-thread time while the DRIVER compiles on its own
    // threads, so N materials cost the SUM of their compile times. With GI
    // injected, each material's fragment shader is 180-250kB of WGSL and
    // takes the driver 3-18s: harness-measured 42.4s summed for a 14-material
    // scene whose worst single pipeline was 18.5s. Intercepting the promise
    // hand-off (three gets an empty array and never awaits; we collect and
    // await them together) overlaps every compile.
    const pipelines = renderer._pipelines;
    const originalGetForRender = pipelines?.getForRender;
    const inflight = [];
    // BACKGROUND MODE TOO (2026-08-02, was suspended-only). Without the
    // interception, background mode awaited each object's pipeline promise
    // PER OBJECT — and those promises can only resolve when the GPU
    // process's completions get main-thread time, so the wave serialized
    // against its own busyness (harness-measured: a 42s wave whose driver
    // work overlapped into the last seconds). It is safe live because the
    // pipelines created here belong to the compile-target variants (GI
    // lights hash → different cache keys than anything the live scene
    // draws), and a live draw that DOES land on a still-compiling cache
    // entry is skipped by Pipelines.isReady — the same semantics as any
    // async compile. Only the compile path passes a promises array, so the
    // wrapper is inert for normal rendering.
    if (originalGetForRender) {
      pipelines.getForRender = function (renderObject, promises) {
        if (promises == null) return originalGetForRender.call(this, renderObject, promises);
        const collected = [];
        const result = originalGetForRender.call(this, renderObject, collected);
        inflight.push(...collected);
        return result;
      };
    }
    const t0 = performance.now();
    let compileSucceeded = false;
    try {
      console.log("[gi] compile wave started");
      // Compile against the render path that will actually draw at resume.
      // With a postprocess override active, the scene renders through the
      // override's PassNode target + MRT — a DIFFERENT pipeline-cache
      // context than the default framebuffer, and structurally different
      // shaders (MRT adds attachments to every material). Warming only the
      // default context then left every material to sync-recompile on the
      // first resumed frame — user-confirmed as ~HALF their startup freeze
      // (disabling the Post Processing module halved startup).
      const objTimings = [];
      if (!(await this.#warmOverridePass(renderer))) {
        if (backgroundCompile) {
          for (const object of compileObjects) {
            const tObj = performance.now();
            await renderer.compileAsync(object, engine.camera, compileTarget);
            objTimings.push({
              name: object.material?.name || object.material?.type || object.name || "?",
              ms: performance.now() - tObj,
            });
          }
        } else {
          await renderer.compileAsync(engine.scene, engine.camera);
        }
      }
      const tQueued = performance.now();
      // Every pipeline is now in flight on the driver's threads — this is the
      // only wait, and it costs the LONGEST compile, not their sum.
      const queued = inflight.length;
      if (queued > 0) await Promise.all(inflight);
      const t1 = performance.now();
      console.log(
        backgroundCompile
          ? `[gi] compile wave: materials warmed safely in ${(t1 - t0).toFixed(0)}ms while viewport remained live`
          : `[gi] compile wave: materials done in ${(t1 - t0).toFixed(0)}ms ` +
            `(node builds ${(tQueued - t0).toFixed(0)}ms, ${queued} pipelines compiled concurrently in ${(t1 - tQueued).toFixed(0)}ms)`,
      );
      // Prewarm every GI kernel. Creation is ASYNC (installAsyncComputePipelines
      // — driver threads, wire never stalls, frames keep flowing) and a
      // dispatch whose pipeline hasn't landed is skipped, so this loop's job
      // is to force creation early, wait out the compiles, then dispatch for
      // real so the first resumed frame finds everything warm AND the field
      // composited.
      if (state && this.state === state) {
        const computeNodes = [...state.queue];
        // ══ SRC'S PASSES BELONG IN THE WAVE, AND WERE NOT IN IT ═══════════
        //
        // `state.queue` is the SCREEN chain and nothing else — resolve, the
        // light-shadow passes, the emitter chain: five nodes on the user's
        // Sponza. SRC is dispatched separately (`giCompute(renderer,
        // state.screen.srcProbes.passes)` in the frame callback) and its
        // passes were therefore never prewarmed, never awaited, and never
        // counted. `profile.giPasses` says how many that is: **44**.
        //
        // The consequence is not "startup is a bit slower". A dispatch whose
        // pipeline has not landed is SKIPPED (see `installAsyncComputePipelines`),
        // and since [I] made SRC's screen gather the PRIMARY diffuse term,
        // skipping it means the scene has no indirect light at all. So the wave
        // printed `computes 68312ms` and declared itself done, the first frame
        // after it kicked off 44 more pipeline creations, the driver serialized
        // them (§13.3 — the per-pipeline number is latency, not compile time),
        // and GI stayed absent for the whole of that second, uncounted wave.
        // That is the user's "the GI appears after like 3-4 minutes of wait".
        //
        // This does not make the compiling faster. It makes it HAPPEN INSIDE
        // the window that is designed for it — the one the wave holds, that
        // `bootAmbient` exists to bridge, and that the log reports honestly.
        // Cutting the 44 is §13.9's other half and is a separate measurement.
        const srcPasses = state.screen?.srcProbes?.passes ?? [];
        // ══ DO NOT COMPILE THE SHADOW CHAIN NOBODY DISPATCHES ═════════════
        //
        // The frame loop already skips these six passes when no light is set to
        // Shadow Source "gi" (`anyGiShadow`, ~1,660 lines down) — it has done
        // for a while, and it saves ~0.4 ms a frame. What nothing skipped was
        // COMPILING them, and that turns out to be the whole of startup.
        //
        // Measured, user's Sponza, `probe:gi-boot` cold, SRC off:
        //
        //   TIME TO FIRST CORRECT FRAME   141,107 ms
        //   slowest SINGLE pipeline       132,803 ms   94.1% of TTFF
        //     77 kB WGSL, 4 loops, 204 ifs
        //     fns: giStaticBvh8, giDynBvh8, giDynShapeHit, giFreeRadius…
        //
        // Those function names are the GI-traced light shadow marcher, and
        // `profile.giPasses` on the same editor says of it, in as many words:
        // `lightShadowPass: NOT dispatched — no light uses Shadow Source "gi"`.
        // **The most expensive object in the entire boot is a kernel that never
        // runs.** Their editor logs the same shape at 62,046 ms for one pipeline.
        //
        // §13.4's rule holds and is worth restating, because it is why nobody
        // found this by looking at code: a 154 kB kernel compiles in 4.5 s here
        // while this 77 kB one takes 132 s. Size does not predict it. The
        // difference in the fingerprint is LOOPS — 4 against 0 — which is the
        // BVH descent, and a shader compiler unrolling four nested loops over
        // 204 branches is where the two minutes go.
        //
        // ⚠ THIS IS A RAMP, NOT A REMOVAL (R1). The passes still exist and are
        // still built; they are only left out of the PREWARM. Flag a light with
        // Shadow Source "gi" and the pipeline is created on first dispatch —
        // async, frames keep flowing, and the dispatch is skipped until it
        // lands, which is the same graceful path every GI pipeline already
        // takes. The cost moves from "every boot of every scene" to "the first
        // frames after you ask for it".
        const anyGiShadow = (state.lightSlots ?? []).some((s) => (s?.giShadow?.value ?? 0) > 0);
        const coldShadow = new Set();
        if (!anyGiShadow) {
          for (const name of [
            "lightShadowPass", "lightShadowFilterPass", "lightShadowWidePass",
            "lightShadowWidePass2", "lightShadowHistoryPass", "lightShadowPostPass",
          ]) {
            const node = state.screen?.[name]?.compute;
            if (node) coldShadow.add(node);
          }
        }
        // ── AND THE EMITTER CHAIN, WHICH IS THE SAME DISEASE ONE TWIN OVER ──
        //
        // §13.14.8: the frame loop dispatch-skips the emitter shadow chain
        // whenever the scene has 0 emitters (the `skip` set above, ~line 1688)
        // — but the chain sits in `state.queue`, so THIS warm-up compiled it
        // anyway. Its trace kernel is the light-shadow marcher's twin (same
        // estimator family, 4 slots × a full BVH8 any-hit descent + width
        // probe, two 4-scalar stores), it fingerprints at 77 kB / 4 loops /
        // 204 ifs, and it measured 47-133 s across boots — THE dominant term
        // of the user's "GI takes minutes" wave, compiled for a pass the very
        // next frame refuses to dispatch on a "0 emitters" scene.
        //
        // Same remedy as the light chain, and the ramp is already built: when
        // an emitter appears, the runtime skip lifts, the first dispatch
        // creates the pipeline asynchronously, and frames keep flowing while
        // it compiles (installAsyncComputePipelines' skip-until-ready path).
        // Nothing here needs a rebuild.
        if (!(this._emitterInfos?.length > 0)) {
          for (const name of [
            "emitterShadowPass", "emitterShadowFilterPass",
            "emitterShadowHistoryPass", "emitterShadowPostPass",
          ]) {
            const node = state.screen?.[name]?.compute;
            if (node) coldShadow.add(node);
          }
        }
        // Filtered out of BOTH loops. The re-dispatch below would otherwise
        // trigger the very creation this skipped, which is the kind of fix that
        // measures as no change and reads as a mystery.
        const queueWarm = computeNodes.filter((n) => !coldShadow.has(n));
        // ── AND THE BVH REFLECTION PREPASS, WHICH IS ALSO OUTSIDE THE QUEUE ──
        //
        // Same shape as SRC's 44 (§13.9): dispatched from the frame callback
        // rather than from `state.queue`, so it was never prewarmed, never
        // awaited, and invisible to the kernel count. With the shadow chain no
        // longer compiled, the per-pipeline timer named what was left —
        // `SLOWEST PIPELINE: #48 took 51.1s`, an index PAST the 45 warmed
        // kernels, which is how a pipeline says "nobody warmed me".
        //
        // It is `giStaticBvh8`/`giDynBvh8`/`giFreeRadius…` — the same function
        // set as the shadow marcher, because both descend the same BVH — and
        // unlike the shadow chain this one IS dispatched every frame that
        // exact reflections are on. So it cannot be skipped, only warmed
        // honestly: inside the wave, where `bootAmbient` covers it and the log
        // counts it, instead of stalling the first frames after the wave says
        // it is finished.
        const reflectNode = this.#bvhReflectionsEnabled() ? state.screen?.bvhReflect?.compute : null;
        if (reflectNode) queueWarm.push(reflectNode);
        const warmNodes = [...queueWarm, ...srcPasses];
        if (coldShadow.size) {
          // Named per chain, because "which optional chains did this boot
          // compile" is the gate-state question §13.14.6 made mandatory.
          const emitterSkipped = !(this._emitterInfos?.length > 0);
          console.log(
            `[gi] skipping ${coldShadow.size} pipelines at warm-up — ` +
              (anyGiShadow ? "" : 'light-shadow chain (no light uses Shadow Source "gi")') +
              (!anyGiShadow && emitterSkipped ? " + " : "") +
              (emitterSkipped ? "emitter-shadow chain (0 emitters)" : "") +
              ". Never dispatched while unused; they compile on first use.",
          );
        }
        const kernelSizes = [];
        // ── HOW MUCH OF THE WAVE IS JS, NOT THE DRIVER? ───────────────────
        //
        // `probe:gi-boot` now reports 98% of the boot span as "idle between
        // compiles" and labels it TSL node-graph build + WGSL generation. The
        // cold/warm arm makes the first half of that credible on its own — the
        // slowest pipeline fell 44,157ms → 611ms warm (72×) while TTFF moved
        // −6%, so pipeline compilation cannot be what startup is made of. But
        // "idle" is measured by ELIMINATION, and naming a stage from a
        // leftover is the §13.8 mistake that put four wrong claims in this
        // plan. So: time the synchronous part of the dispatch, which IS the
        // graph build and the codegen (three does both inside `renderer.
        // compute` before handing anything to the device), and report it next
        // to the pipeline number it is being compared against.
        let buildMs = 0;
        let worstBuild = { ms: 0, i: -1 };
        // The loop's WALL time, against the sum of its `giCompute` calls. The
        // gap between them is the yields — one macrotask per kernel, which lets
        // the browser run a whole frame each time. That is the feature ("frames
        // kept flowing"), but it prices the wave at `kernels × frameTime`, and
        // §13.9 just took the kernel count from 5 to 49.
        const tLoop = performance.now();
        // ══ YIELD ON A BUDGET, NOT ONCE PER KERNEL ════════════════════════
        //
        // This used to `await setTimeout(0)` before EVERY kernel, so the loop
        // cost `kernels × frameTime` rather than the work it actually does.
        // Measured: 49 kernels, **10 ms** of node-graph build and codegen,
        // **24,468 ms of yielding** — 499 ms per kernel, because a macrotask
        // lets the browser run a whole frame and a frame is not cheap while the
        // scene is still warming. 99.96% of the loop was waiting.
        //
        // §13.9's fix made that ten times worse by construction: putting SRC's
        // 44 passes in the warm set took the kernel count from 5 to 49, and the
        // yield count with it. Correct fix, wrong cost, and the cost was
        // invisible until the loop was timed against its own work.
        //
        // The budget is the same shape the MATERIAL wave already uses in this
        // file ("270 skipped by the 40ms budget"): keep the viewport alive by
        // yielding when we have actually held the thread a while, not on a
        // fixed cadence. At 10 ms of total work this yields about once — the
        // viewport loses one frame instead of forty-nine.
        const YIELD_BUDGET_MS = 8;
        let sinceYield = performance.now();
        for (const node of warmNodes) {
          if (performance.now() - sinceYield >= YIELD_BUDGET_MS) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            sinceYield = performance.now();
          }
          if (this.state !== state) break;
          const tBuild = performance.now();
          giCompute(renderer, node);
          const dt = performance.now() - tBuild;
          buildMs += dt;
          if (dt > worstBuild.ms) worstBuild = { ms: dt, i: kernelSizes.length };
          try {
            const wgsl = renderer._nodes?.getForCompute?.(node)?.computeShader;
            if (wgsl) kernelSizes.push(Math.round(wgsl.length / 1024));
          } catch {
            /* diagnostics only */
          }
        }
        // UNCONDITIONAL. The first version gated this on `> 250ms`, which meant
        // a SMALL number printed nothing — indistinguishable from the block not
        // running at all, and that is the exact ambiguity the measurement
        // exists to remove. A cheap graph build is the more interesting result
        // here, because it refutes the label `probe:gi-boot` puts on its 98%.
        const loopMs = performance.now() - tLoop;
        console.log(
          `[gi] prewarm loop ${loopMs.toFixed(0)}ms over ${warmNodes.length} kernels = ` +
            `${buildMs.toFixed(0)}ms node-graph build + WGSL codegen (worst ${worstBuild.ms.toFixed(0)}ms ` +
            `at #${worstBuild.i}) + ${(loopMs - buildMs).toFixed(0)}ms YIELDING ` +
            `(${((loopMs - buildMs) / Math.max(1, warmNodes.length)).toFixed(0)}ms per kernel — ` +
            "one macrotask each, so one rendered frame each).",
        );
        // Ticks may have started compiles before this loop did — wait for the
        // whole in-flight set, including anything that joins meanwhile.
        if (giPendingComputePipelines.size) {
          const tPipe = performance.now();
          const reuseBefore = giPipelineReuseHits;
          let waited = 0;
          while (giPendingComputePipelines.size) {
            waited += giPendingComputePipelines.size;
            await Promise.all([...giPendingComputePipelines]);
          }
          // `recompiled` is the count of pipelines built from a shader module
          // this process had ALREADY built one from — i.e. byte-identical WGSL
          // recompiled because three's pipeline cache key carries the compute
          // NODE's id and a rebuild makes new nodes. On a first boot it is 0 by
          // construction; on a rebuild it is the size of the win a content-keyed
          // cache would buy, stated before anyone builds one.
          const recompiled = giPipelineReuseHits - reuseBefore;
          console.log(
            `[gi] ${waited} compute pipelines compiled concurrently in ` +
              `${(performance.now() - tPipe).toFixed(0)}ms (frames kept flowing)` +
              (recompiled > 0
                ? ` — ${recompiled} of them recompiled UNCHANGED WGSL (three keys its pipeline ` +
                  "cache on the compute node's id, and a rebuild makes new nodes)"
                : ""),
          );
        }
        // The guarded dispatches above did no field work where a pipeline was
        // still compiling — dispatch each node for real now that every
        // pipeline resolved (all cache hits, no creates).
        //
        // `computeNodes`, NOT `warmNodes`: SRC's chain is ordered and its
        // geometry comes from uniforms `syncCamera` writes at the top of each
        // frame. Running it here would populate one frame's probes against an
        // unset anchor. Harmless in fact (they age out and re-populate
        // immediately) but it is a frame of work with no reader, and the point
        // of adding SRC above was to compile its pipelines, not to run it early
        // — the real dispatch is the frame callback, one tick later, in order.
        if (this.state === state) {
          for (const node of queueWarm) giCompute(renderer, node);
        }
        // ── NAME THE SLOW KERNEL ─────────────────────────────────────────
        //
        // Zipped against `kernelSizes` by creation order. This is the line that
        // turns "62 seconds of compiling" into "62 seconds in kernel #1, 77 kB"
        // — and §13.4 says the size will probably NOT explain it, which is
        // exactly why the index matters more than the byte count.
        const timed = giPipelineTimings.filter((p) => typeof p.ms === "number");
        if (timed.length) {
          const slowest = timed.reduce((a, b) => (b.ms > a.ms ? b : a));
          const total = timed.reduce((s, p) => s + p.ms, 0);
          if (slowest.ms > 1000) {
            // `kb` comes from the module the pipeline was actually built from,
            // so it is present for kernels created OUTSIDE the prewarm too —
            // which is where the slow one has been every single time. The
            // `kernelSizes` zip stays only as a fallback for the warmed range.
            const kb = slowest.kb ?? kernelSizes[slowest.order] ?? "?";
            console.log(
              `[gi] SLOWEST PIPELINE: #${slowest.order}` +
                `${slowest.pass ? ` [${slowest.pass}]` : ""} took ${(slowest.ms / 1000).toFixed(1)}s ` +
                `(${kb}kB WGSL${slowest.label ? `, "${slowest.label}"` : ""}` +
                `${slowest.entry ? `, entry ${slowest.entry}` : ""}` +
                `${slowest.loops != null ? `, ${slowest.loops} loops / ${slowest.ifs} ifs` : ""}` +
                `${slowest.binds ? `, binds ${slowest.binds}` : ""}) ` +
                `of ${(total / 1000).toFixed(1)}s summed over ${timed.length} pipelines. ` +
                "The [pass] tag is the dispatch site's own name — trust it over any fingerprint.",
            );
            // The runner-up matters as much as the winner: "one pathological
            // kernel" and "every kernel of this shape is slow" are different
            // problems with different fixes, and the top line alone cannot
            // tell them apart.
            const rest = timed.filter((p) => p !== slowest).sort((a, b) => b.ms - a.ms).slice(0, 3);
            if (rest.length) {
              console.log(
                `[gi] next slowest: ${rest.map((p) => `#${p.order}${p.pass ? ` [${p.pass}]` : ""} ${(p.ms / 1000).toFixed(1)}s` +
                  `${p.kb != null ? ` (${p.kb}kB${p.binds ? `, ${p.binds.split(",")[0]}` : ""})` : ""}`).join(", ")}`,
              );
            }
          }
        }
        if (kernelSizes.length) {
          console.log(
            `[gi] compute kernels: ${kernelSizes.length} totaling ${kernelSizes.reduce((s, n) => s + n, 0)}kB WGSL ` +
              `(${queueWarm.length} screen chain${coldShadow.size ? ` of ${computeNodes.length}` : ""} ` +
              `+ ${srcPasses.length} SRC; ` +
              // The sizes list is capped: 49 numbers is not a log line anyone
              // reads, and the tail was always the uninformative half.
              `sizes ${kernelSizes.slice(0, 8).join("/")}${kernelSizes.length > 8 ? "/…" : ""}kB — ` +
              "[0] composite, then sparse, then the frame queue, then SRC)",
          );
        }
      }
      // The postprocess pipeline builds asynchronously (addon imports + graph
      // compile) and often becomes active DURING this wave. A PassNode always
      // compiles its bound real scene, so the temporary compile scene cannot
      // supply its GI light. Move the light to the real scene first and pause
      // only viewport rendering for this final async phase. The editor/event
      // loop remains live while Three yields between materials, and the first
      // resumed frame sees the exact pass+MRT variants that were warmed.
      const lateOverride = [...(engine.renderOverrides ?? [])].find((override) => override.ownsCamera?.(engine));
      if (backgroundCompile && pendingLight && lateOverride?.scenePass?.compileAsync) {
        engine.renderSuspended = true;
        engine.scene.add(pendingLight);
      }
      // The other unmeasured half of `computes`. Already suspected once — the
      // engine logs "first frame after compile wave took 655ms — pipelines
      // recompiled at resume (likely the postprocess render path)" — and it is
      // inside this window, so it has been silently included in every "compute
      // pipeline compile" number this plan has quoted.
      const tWarmPass = performance.now();
      await this.#warmOverridePass(renderer);
      const warmPassMs = performance.now() - tWarmPass;
      if (warmPassMs > 100) {
        console.log(`[gi] postprocess pass warm: ${warmPassMs.toFixed(0)}ms (inside "computes")`);
      }
      console.log(
        `[gi] compile wave: materials ${(t1 - t0).toFixed(0)}ms, computes ${(performance.now() - t1).toFixed(0)}ms ` +
          `(${backgroundCompile ? "viewport remained live" : "render suspended, app interactive"})`,
      );
      // A slow wave earns a breakdown in the log: how much was real JS work
      // vs waiting on the macrotask yields, and which objects paid the most.
      if (t1 - t0 > 3000) {
        console.log(
          `[gi] wave breakdown: ${yieldStats.count} real yields waited ${yieldStats.waited.toFixed(0)}ms ` +
            `(${yieldStats.skipped} skipped by the 40ms budget); ` +
            `slowest objects: ${objTimings
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 6)
              .map((o) => `${o.name} ${o.ms.toFixed(0)}ms`)
              .join(", ") || "(single scene compile)"}`,
        );
      }
      compileSucceeded = true;
    } catch (error) {
      console.warn("[gi] async compile wave failed; GI was not committed:", error?.stack ?? error?.message ?? error);
    } finally {
      if (originalYield) scheduler.yield = originalYield;
      if (originalGetForRender) pipelines.getForRender = originalGetForRender;
      if (this._compileToken === token) {
        // Moving the already-compiled light from the temporary scene to the
        // live scene is the commit point. The next render observes the new
        // lights hash and finds its material pipelines warm.
        if (compileSucceeded && pendingLight && pendingLight.parent !== engine.scene) engine.scene.add(pendingLight);
        engine.renderSuspended = false;
        // DIAGNOSTIC: if the first REAL frame after the wave still stalls,
        // the wave compiled for the wrong render path (a postprocess
        // override renders through PassNode targets whose cache context
        // differs) — the number tells us instantly.
        const tResume = performance.now();
        if (compileSucceeded) requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const dt = performance.now() - tResume;
            if (dt > 400) {
              console.warn(
                `[gi] first frame after compile wave took ${dt.toFixed(0)}ms — pipelines recompiled at resume (likely the postprocess render path; report this)`,
              );
            }
          }),
        );
      }
    }
  }

  /**
   * GI-TRACED DIRECT SHADOWS — the resolve-side bundle, or null when this
   * build cannot afford them. Everything about the feature that needs the
   * volume (the trace, its lift, its reach) is decided here, once.
   *
   * THE STEP BUDGET IS PER TIER, and this is not a tuning preference — it is
   * the bug the lost implementation's smoke caught. A shadow ray from a
   * receiver to the sun crosses the WHOLE volume, and the hierarchical march
   * takes its smallest steps exactly where it hugs geometry, so a ray threading
   * a building's interior burns its budget mid-wall. Running out is not
   * "slightly wrong": the trace's fail-closed clamp only fires where the last
   * sample was still near a surface, so an exhausted ray in a room reports
   * NOTHING BLOCKED ME and the interior renders blown white. 64 steps did that;
   * these budgets do not. (`__giDirectShadowSteps` overrides for an A/B.)
   *
   * TWO GATES, both about bindings rather than taste:
   *
   *  · STORAGE TEXTURES. The resolve already writes irradiance + emitterShadow
   *    + radiance, plus the BVH radiance target when exact reflections are on.
   *    This makes one more, which is the 4th or the 5th against a WebGPU
   *    BASELINE OF 4. The engine asks the adapter for 8 (see
   *    resolveRendererLimits), but the ask is adapter-clamped, so a
   *    baseline-only device really does land at 4 and must simply not get the
   *    feature — over the limit the pipeline is INVALID and every compute
   *    submitted with it is silently dropped, taking all of GI with it.
   *
   *  · STORAGE BUFFERS. The trace reads the occupancy pyramid, the composited
   *    distance texture and the atlas — the resolve is at the portable
   *    8-storage-buffer baseline and cannot take new ones. It is only provably
   *    free when the pass ALREADY carries a trace of the same family, i.e. when
   *    emitter shadows built `light.shadowTraceFn`: same resources, so the bind
   *    group is unchanged and only a second WGSL function appears. With
   *    `emissiveShadows` off there is no such trace and this one would add its
   *    own bindings to a pass whose real count we cannot measure without a GPU,
   *    so the honest answer is to decline. `__giLightShadowIgnoreBudget` forces
   *    it for a measurement run.
   */
  #buildLightShadow({ volume, lightSlots, quality, hasEmitterTrace, span }) {
    if (globalThis.__giNoLightShadows === true) return null;
    const occ = volume.occupancyField;
    // No pyramid, no feature: the lift is sized in occupancy voxels and the
    // trace's thin-wall block is the pyramid's. The SDF-only arm would leak
    // through anything thinner than a field cell, which for a sun shadow is
    // every floor in the scene.
    if (!occ?.voxel) return null;
    // The emitter-trace requirement is a SPHERE-ARM rule: that marcher reads
    // distanceTexture + atlas + staging + sparse and is only provably free
    // when the emitter trace already bound the same family. The DDA arm
    // reads ONLY the occupancy bits buffer — +1 storage buffer worst case,
    // +0 whenever AO or the emitter oracle already binds it — so it stands
    // alone. If a pathological config still over-commits the pass, the
    // failure is loud in the harness (the irradiance CONTROL collapses when
    // a batch drops) and `__giNoLightShadows` is the hatch.
    const sphereArm = globalThis.__giLightShadowSphere === true;
    if (!hasEmitterTrace && sphereArm && globalThis.__giLightShadowIgnoreBudget !== true) {
      if (!this._warnedLightShadowBudget) {
        this._warnedLightShadowBudget = true;
        console.warn(
          "[gi] gi-traced light shadows are off: the sphere arm needs the emitter trace's bindings " +
            "(Emissive Shadows is disabled). Re-enable it, drop __giLightShadowSphere, or set " +
            "__giLightShadowIgnoreBudget to measure anyway.",
        );
      }
      return null;
    }
    const limit = this.engine.renderer?.backend?.device?.limits?.maxStorageTexturesPerShaderStage ?? 0;
    const used = 3 + (this.#bvhReflectionsEnabled() ? 1 : 0);
    if (limit < used + 1) {
      if (!this._warnedLightShadowLimit) {
        this._warnedLightShadowLimit = true;
        console.warn(
          `[gi] gi-traced light shadows are off: this device allows ${limit} storage textures per stage and the ` +
            `resolve already writes ${used}. Lights with Shadow Source "gi" fall back to shadow maps.`,
        );
      }
      return null;
    }
    // PCSS blocker-distance channel — DEFAULT ON since the analytic-width
    // arm became the default (2026-08-06; plan §5 named it the default-on
    // candidate "once its input stops boiling"). The min-ratio width term
    // only softens the MISS side of a silhouette: the central-ray hit
    // boundary stays binary, which reads as a hard edge INSIDE the smoothed
    // penumbra at large source angles (user screenshot, sourceAngle ~30°).
    // The disc reconstructs width symmetrically from the trace's blocker
    // distance — deterministic width at the sampling end, i.e. the same
    // move as the width probe — and its historical rejection was about the
    // stochastic arm's boiling input, not the disc. `__giPcssDisc = false`
    // disables (build-time); devices without storage-texture headroom for
    // the dist target skip it exactly as before.
    const pcss = globalThis.__giPcssDisc !== false && limit >= used + 2;
    const steps =
      Number(globalThis.__giDirectShadowSteps) ||
      ({ low: 96, medium: 128, high: 160, ultra: 192 }[quality] ?? 160);
    // THE MARCHER DECISION, hoisted so the boot log can print it: "I set
    // Shadow Source to gi and the silhouettes are still voxel" is unreadable
    // without knowing which arm compiled. A mode change is structural, so
    // deciding here (build time) equals deciding inside the trace closure.
    const shadowMode = volume.rayHitMode ?? RayHitMode.OccupancyLegacy;
    const recordMarch =
      occ.traceHybridPlane &&
      occ.hasSurfaceRecords === true &&
      shadowMode >= RayHitMode.HybridPlane &&
      shadowMode <= RayHitMode.HybridExactComplex &&
      globalThis.__giLightShadowLegacyDda !== true;
    // ANALYTIC-WIDTH ARM (docs/GI_SHADOWS_PLAN.md §5) — THE DEFAULT since
    // 2026-08-06 (user call): the deterministic soft-shadow estimator.
    // Admission stays with the march (records/DDA, unchanged); softness
    // comes from multiplying in the mid-field width probe — min k·D/t over
    // ~12 trilinear distanceTexture taps (see giField createWidthProbeFn) —
    // instead of from the stochastic sun-disc jitter + temporal repair
    // chain. Downstream, this arm traces the CENTRAL ray only (no disc
    // sample), and #buildScreenResolve skips the whole temporal machinery:
    // each frame is already the converged answer, which is what makes the
    // shadow track a dragged sun at full sharpness with zero grain.
    // `__giShadowAnalyticWidth = false` (build-time) restores the stochastic
    // sun-disc + temporal arm for A/B — it remains the reference instrument
    // (256-frame static accumulation is unbiased ground truth).
    const analyticWidth = globalThis.__giShadowAnalyticWidth !== false;
    const widthProbe = analyticWidth ? volume.createWidthProbe?.() : null;
    // 1.5 OCCUPANCY VOXELS of ray lift — a node, not a number, so an in-place
    // refit rescales it with the pyramid. See the resolve's own comment for
    // why the gather's normalOffset is the wrong scale here. The factor is a
    // LIVE uniform (`__giShadowLift`, synced per tick): the lift dead zone is
    // the prime wall-leak suspect and this is the in-editor A/B for it.
    const vox = vec3(occ.voxel);
    const voxMax = vox.x.max(vox.y).max(vox.z);
    const liftFactor = uniform(1.5);
    const lift = voxMax.mul(liftFactor);
    // EXACT-ARM BIAS, in voxels — the static-BVH arm's own, ~75x smaller than
    // the voxel lift (see its use in traceDda for the measurement that sized
    // it). Live uniform `__giShadowExactBias` for the same in-editor A/B.
    const exactBiasFactor = uniform(0.02);
    const exactArm = !!(this._dynSet?.staticBvh && globalThis.__giShadowStaticBvh !== false);
    return {
      liftFactor,
      exactBiasFactor,
      exactArm,
      analyticWidth,
      marcher: globalThis.__giLightShadowSphere === true
        ? "sphere"
        : (this._dynSet?.staticBvh && globalThis.__giShadowStaticBvh !== false
            ? "static-bvh8 + exact-dynamics"
            : recordMarch ? `records (${rayHitModeName(shadowMode)})` : "voxel-dda") +
          (analyticWidth
            ? " + analytic-width"
            : globalThis.__giConeShadowDensity === true ? " + density-cone" : " + sun-disc"),
      slots: lightSlots,
      lift,
      voxMax,
      span,
      pcss,
      steps,
      // BURIAL GATE INPUT (see the resolve's use). RECORD-AWARE is the load-
      // bearing word: the plain AABB oracle reads ~0 at every lifted origin
      // (the receiver's own surface voxels bulge up to a voxel above the true
      // surface), which would dim every floor in the scene — the record-aware
      // near field returns the TRUE distance to the fitted surface plane, so
      // an open-ground origin measures ≈ the full lift and stays untouched.
      // That is also why the gate only exists when records do: without them
      // (brick-box / legacy modes) it is null and the resolve compiles it out.
      // OFF UNDER THE EXACT ARM. The gate is a VOXEL oracle whose whole job is
      // covering for a VOXEL marcher: the DDA starts 1.5 voxels up and cannot
      // see a canopy it has already skipped past, so the gate asks the field
      // "is this point buried?" separately. An exact triangle ray starts ~2 mm
      // off the surface and intersects that canopy itself — the gate adds no
      // information and does add its own documented disease, the lattice-phase
      // alternation that etches the voxel grid back onto lit floors (see the
      // resolve's burial note: recordless shell columns read gap 0 and force
      // open ground BLACK). Stamping that pattern back over exact silhouettes
      // is the speckle/dash population in the user's 2026-08-06 screenshots.
      // `__giShadowBurialGate = true` forces it back on for A/B.
      freeRadius:
        occ.hasSurfaceRecords === true && occ.freeRadiusAtWorld &&
        (globalThis.__giShadowBurialGate === true ||
          !(this._dynSet?.staticBvh && globalThis.__giShadowStaticBvh !== false))
          ? (p) => occ.freeRadiusAtWorld(p, 1, true, null, true)
          : null,
      // THE MARCHER IS THE TRANSPORT DDA, NOT THE SPHERE TRACE. This is the
      // same retreat the FIELD's sun shadows already made (see the field
      // `lightShadow` closure): sphere-tracing the blurred field tunnels
      // through thin geometry and its occluder-admission thresholds flip
      // with voxel-lattice phase (rings, speckles, black states — three
      // rounds of threshold tuning moved the artifacts without removing
      // them), while the hierarchical DDA marches the SAME bits transport
      // rays march — it cannot tunnel, has no admission thresholds at all,
      // and its analytic cone accumulator (`pen`) fades a grazing ray
      // continuously before the binary hit flips. 64 steps with coarse-skip
      // crosses the volume; per-pixel cost beats 160 sphere steps.
      // `__giLightShadowSphere = true` restores the sphere arm (build-time).
      traceDda:
        globalThis.__giLightShadowSphere === true
          ? null
          : (origin, dir, maxT, k, receiverP = null, tanHalf = null, jitter = null, jitter2 = null, cosRayNormal = null) => {
              // tMin one voxel: the lifted origin can still clip its own
              // surface's SAT-bulged voxel on curved geometry, and a DDA
              // first-voxel hit is a hard black dot. One voxel along the ray
              // (on top of the 1.5-voxel normal lift) clears it; anything
              // thinner than that near the receiver is below the medium's
              // resolving power anyway.
              const vox = vec3(occ.voxel);
              const tMin = vox.x.max(vox.y).max(vox.z);
              // ── STOCHASTIC SUN-DISC SOFT SHADOWS (the soft arm of record).
              // Each pixel traces the EXACT march along one jittered
              // direction inside the sun's disc; the penumbra is the pixel
              // ENSEMBLE (IGN dither, averaged by the material bilateral),
              // not a per-ray estimate. This replaced the density-cone arm
              // after the user's 15° screenshots showed both of that model's
              // congenital diseases at once: a thin solid roof in a coarse
              // cell reads fraction ~1/8 → dappled LIGHT LEAKS, while dense
              // clusters + the fail-dark clamp collapse to BLACK — and
              // tuning boost only trades one for the other. Binary exact
              // occlusion per ray has neither disease, keeps sub-voxel
              // record silhouettes at EVERY angle, costs the same march the
              // user-validated 0° path always ran, and a jittered ray that
              // dips below the receiver's horizon correctly reads its own
              // ground as the occluder (that part of the disc IS set).
              // 0° degenerates exactly (disc radius 0 → jd = dir).
              // `__giConeShadowDensity = true` restores the density-cone
              // two-phase arm for A/B (build-time, like every hatch here).
              const soft = tanHalf != null && jitter != null;
              const legacyCone =
                globalThis.__giConeShadowDensity === true &&
                !analyticWidth &&
                soft &&
                occ.traceOccupancyCone;
              const voxMin = vox.x.min(vox.y).min(vox.z);
              // The analytic-width arm traces the CENTRAL ray only — a
              // deterministic ray cannot wander into the origin dead zone
              // and needs no ensemble to average; softness is the width
              // probe's job (multiplied in below).
              let dirEff = dir;
              if (soft && !legacyCone && !analyticWidth) {
                const d = vec3(dir);
                const upRef = select(d.y.abs().lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
                const s1 = d.cross(upRef).normalize().toVar();
                const s2 = d.cross(s1).toVar();
                const ang = float(jitter).mul(Math.PI * 2).toVar();
                const rr = float(jitter2 ?? 0.5).sqrt().mul(float(tanHalf)).toVar();
                dirEff = d.add(s1.mul(ang.cos()).add(s2.mul(ang.sin())).mul(rr)).normalize().toVar();
              }
              const exactEnd = legacyCone
                ? voxMin.mul(0.5).div(float(tanHalf).max(1e-5)).min(maxT).toVar()
                : maxT;
              const coneSteps =
                Number(globalThis.__giConeShadowSteps) ||
                ({ low: 48, medium: 64, high: 80, ultra: 96 }[quality] ?? 80);
              const coneT = legacyCone
                ? occ.traceOccupancyCone(origin, dir, exactEnd.max(tMin), maxT, {
                    tanHalf,
                    steps: coneSteps,
                    boost: Number(globalThis.__giConeDensityBoost) || 3,
                    // Receiver plane for the cone's self-shadow exclusion.
                    // The light-facing normal is recoverable from the lifted
                    // origin — origin = P + n·lift by construction.
                    receiverP,
                    receiverN: receiverP ? vec3(origin).sub(receiverP).normalize() : null,
                    jitter,
                    jitter2,
                  })
                : null;
              // THE MID-FIELD WIDTH TERM (analytic-width arm only): the
              // penumbra reach the near-field pen terms are starved of.
              // Evaluated on the CENTRAL ray, gated the same ~3 voxels the
              // marchers' own penGate uses so the receiver's neighbourhood
              // never clamps a ray at birth. cosRayNormal comes from the
              // resolve (the receiver's geometric N·L); a missing value
              // degrades to 1, which only ever makes the own-plane test
              // stricter about calling a sample an occluder.
              // LAZY — the probe only runs where the central ray MISSED:
              // in the umbra the verdict is already 0 and multiplying a
              // width into it changes nothing, so the umbra (often the
              // largest shadowed region on screen) skips all 12 taps.
              const evalMidW = widthProbe
                ? (gateNode) => {
                    const w = float(1).toVar();
                    If(gateNode, () => {
                      w.assign(widthProbe(
                        origin, dir, tMin.mul(3), maxT, k,
                        cosRayNormal != null ? float(cosRayNormal) : float(1),
                        lift,
                      ));
                    });
                    return w;
                  }
                : null;
              // STATIC-BVH ARM ("light by voxels, shadows by BVH", user
              // directive 2026-08-06): the shadow ray intersects EXACT world
              // triangles — the masked static-scene BVH8 merged with the
              // exact dynamic set — and never touches voxels. Admission is
              // exact geometry; softness stays the analytic width probe
              // (width, never admission). Radiance/bounce remain voxel.
              // `__giShadowStaticBvh = false` restores the records marcher.
              if (this._dynSet?.staticBvh && globalThis.__giShadowStaticBvh !== false) {
                // EXACT GEOMETRY NEEDS AN EXACT-GEOMETRY BIAS — this arm
                // inherited the VOXEL one and that is the measured cause of
                // the "holes in the shadows". `origin` arrives lifted 1.5
                // occupancy voxels off the surface and `tMin` skips a whole
                // voxel more; both exist because the conservative voxel shell
                // bulges the receiver's own surface up to a voxel above its
                // true plane. Against real triangles there is no shell and
                // nothing to escape, so the pair is pure loss: 0.25 m of
                // blind band on the user's Sponza (voxel 0.098 m), measured
                // as 10.8% of surface points with their NEAREST occluder
                // inside it and 2.6% losing their shadow outright
                // (run-gi-static-bvh-probe.mjs). It is worst on walls, whose
                // light-facing normal shoves the origin 0.15 m out of the
                // arcade — past the very column that should shadow them.
                // The lift direction is recoverable: origin = P + n·lift by
                // construction, and cosRayNormal > 0.05 at every call site
                // keeps that difference non-degenerate.
                let exactOrigin = origin;
                let exactMin = tMin;
                if (receiverP != null) {
                  const nHat = vec3(origin).sub(vec3(receiverP)).normalize().toVar();
                  // Slope-scaled: a grazing ray is where the interpolated
                  // shading normal and the true face diverge most, so the
                  // offset has to grow with 1/cos to stay off its own surface.
                  const bias = voxMax
                    .mul(exactBiasFactor)
                    .div(float(cosRayNormal ?? 1).max(0.25))
                    .toVar();
                  exactOrigin = vec3(receiverP).add(nHat.mul(bias)).toVar();
                  exactMin = bias;
                }
                const s = this._dynSet.traceStaticBvh(exactOrigin, dirEff, exactMin, exactEnd);
                const dr = this._dynSet.trace(exactOrigin, dirEff, exactMin, exactEnd, {});
                const sHit = s.x.greaterThanEqual(0).toVar();
                const hit = sHit.or(dr.hit.greaterThan(0.5)).toVar();
                const tBest = select(
                  sHit.and(dr.hit.greaterThan(0.5)), s.x.min(dr.t),
                  select(sHit, s.x, dr.t),
                ).toVar();
                let exactVis;
                if (evalMidW) {
                  exactVis = select(hit, float(0), evalMidW(hit.not()));
                } else {
                  exactVis = select(hit, float(0), float(1));
                }
                return vec2(
                  coneT ? exactVis.mul(coneT) : exactVis,
                  tBest.max(0).div(float(span)).clamp(0, 1),
                );
              }
              // THE RECORD MARCH — the non-voxel shadow arm. When the active
              // ray-hit mode carries surface records, shadow rays resolve hits
              // through the SAME fitted planes (+ coverage clips, + exact
              // triangles on ultra) the gather uses: silhouettes follow the
              // recorded geometry at sub-voxel precision instead of the voxel
              // hull, and the cone estimate comes from perpendicular miss
              // distances to those planes rather than voxel free-radius.
              // `__giLightShadowLegacyDda = true` restores the binary-voxel
              // arm for an A/B (build-time, like every hatch here).
              // DynamicBrick cells resolve through the per-chain DYNAMIC
              // record tail (refit at the mover's pose every dispatch), so
              // movers keep fitted-plane silhouettes while moving. KNOWN
              // LIMITS (why a silhouette can still read voxel-true): static
              // cells sharing a mover's brick refit unfitted (box) until the
              // demote's full rebuild, tail overflow degrades that brick to
              // box, and COMPLEX-classified cells (curved stone, thin
              // double-face walls) only resolve to real triangles in
              // exact-complex mode.
              if (recordMarch) {
                // Tiered macro budget like the legacy arm — the cap only binds
                // on long grazing rays (the frames where shadow cost spikes),
                // and with the fail-closed clamp a capped ray goes DARK, never
                // a leak. `__giDirectShadowSteps` overrides here too.
                const macroSteps =
                  Number(globalThis.__giDirectShadowSteps) ||
                  ({ low: 96, medium: 128, high: 160, ultra: 192 }[quality] ?? 160);
                const r = occ.traceHybridPlane(origin, dirEff, tMin, exactEnd, {
                  coverage: shadowMode >= RayHitMode.HybridPlaneCoverage,
                  exact: shadowMode === RayHitMode.HybridExactComplex,
                  penumbraK: k,
                  macroSteps,
                  // DIAGNOSTIC (build-time): fold the SHADOW rays into the
                  // rayHitDebug counters. The gather rays are profiled by
                  // default and read 0 limit exits on healthy scenes, so any
                  // macro/brick/invalid counts that appear under this hatch
                  // are the shadow arm's — the fail-closed attribution the
                  // texture-side kind map exists for, without the texture.
                  profile: globalThis.__giShadowProfile === true,
                  // ORIGIN-PLANE EXCLUSION: the receiving surface point. The
                  // march skips accepts/cone contributions whose plane
                  // contains it — the receiver's own SAT-bulged staircase
                  // cells re-fit exactly that plane, and each tooth used to
                  // stamp a teardrop self-shadow phantom on tilted receivers.
                  // `__giNoSelfPlaneExclusion = true` restores the old arm
                  // (build-time A/B like every hatch here).
                  excludePoint: globalThis.__giNoSelfPlaneExclusion === true ? null : receiverP,
                });
                if (globalThis.__giShadowKindDebug === true) {
                  // VERDICT-KIND MAP instead of a shadow: the channel paints
                  // WHICH acceptance class decided each pixel. miss=white,
                  // plane=0.75, exact-triangle=0.5, box=0.25, clamp=black.
                  return vec2(float(1).sub(r.kind.mul(0.25)), 0);
                }
                if (globalThis.__giShadowKindDebug === "sub") {
                  // SUB-KIND MAP: kind·0.125 puts every class at a distinct
                  // byte — miss=0, plane=32, tri=64, box=96, macro-exhaust=128,
                  // brick-limit=159, invalid-brick=191 (and 255 = no geometry,
                  // the pass default). This is the fail-closed ATTRIBUTION
                  // instrument: 4/5/6 render identically in production.
                  return vec2(r.kind.mul(0.125), 0);
                }
                // x = exact-arm visibility × cone transmittance (the two
                // phases partition the ray, so the product is the ray's
                // visibility). y = blocker distance for the PCSS/wide-pass
                // chain; misses carry t = -1, hence the max(0).
                // EXHAUSTION (kind 4) → THE PROBE'S VERDICT, exactly like
                // the emitter arm. The 90° kind map measured 16.8k of 51.8k
                // pixels CLAMPED — the fail-closed black was most of the
                // "umbra", with a bogus ~0.3m blocker distance that also
                // collapsed the wide-pass radius. The probe's openness
                // reading gives those rays the physically-shaped gradient
                // (dark at the caster's base, washing out with distance —
                // the Blender 90° look) instead of a hard black blob, and
                // it is what makes LOWERING march budgets safe: an
                // exhausted ray now degrades to "approximately right" not
                // "black".
                let exactVis;
                if (evalMidW) {
                  const exhausted = float(r.kind).greaterThan(3.5).toVar();
                  const w = evalMidW(float(r.hit).lessThan(0.5).or(exhausted));
                  exactVis = select(exhausted, r.pen.mul(w), r.hit.oneMinus().mul(r.pen).mul(w));
                } else {
                  exactVis = r.hit.oneMinus().mul(r.pen);
                }
                return vec2(
                  coneT ? exactVis.mul(coneT) : exactVis,
                  r.t.max(0).div(float(span)).clamp(0, 1),
                );
              }
              // Tiered like every other march in this module — the DDA's
              // hierarchical coarse-skip means these budgets cross the whole
              // volume at every tier; the tiers trade tail-end reach in
              // pathological threading rays for per-pixel cost.
              // (`__giDirectShadowSteps` overrides both arms for an A/B.)
              const ddaSteps =
                Number(globalThis.__giDirectShadowSteps) ||
                ({ low: 40, medium: 56, high: 64, ultra: 80 }[quality] ?? 64);
              const r = occ.traceOccupancy(origin, dirEff, tMin, exactEnd, { steps: ddaSteps, penumbraK: k });
              let legacyVis = r.hit.oneMinus().mul(r.pen);
              if (evalMidW) legacyVis = legacyVis.mul(evalMidW(float(r.hit).lessThan(0.5)));
              return vec2(
                coneT ? legacyVis.mul(coneT) : legacyVis,
                r.t.max(0).div(float(span)).clamp(0, 1),
              );
            },
      // STABLE estimator, deliberately (the sharp one was tried first): the
      // sharp arm's occluder admission is binary, and against a ~12cm-voxel
      // medium those verdicts flip with lattice phase — white-speckle
      // dithering along every silhouette and lit/black tearing that NO
      // penumbra width smooths (the user's "no matter what the sun angle"
      // report is the fingerprint: k-insensitive artifacts are admission
      // artifacts). Stable turns the admissions into ramps; its leak-seal
      // contact Break stays, reached smoothly.
      trace: volume.createSoftShadowTrace(lift, steps, "giLightShadowTrace", true),
    };
  }

  /**
   * RECORD-MARCH EMITTER SHADOWS (plan §6 — the emitter arm and the light
   * arm converge on one estimator family). Returns the closure the RESOLVE
   * pass's emitter bundle carries as `recordShadowTrace`, or null when the
   * scene's ray-hit mode has no records (the sphere arm stays the fallback,
   * and it remains the only arm the in-material path ever compiles — the
   * occupancy bits buffer must never enter fragment shaders).
   *
   * Why this replaces the sphere trace where records exist: the sphere
   * arm's admissions are THRESHOLDS over a voxel-quantized distance field
   * (own-plane cut, cap cut, contact cut), and every one of them flips with
   * lattice phase somewhere — the big-panel "waffle grid" screenshot is
   * that class, and the probe ladder showed no tuning hatch moved it. The
   * record march's admission is exact geometry (planes/coverage/triangles,
   * fail-closed), and softness is the same analytic width term the direct
   * arm uses — deterministic, no thresholds, unified with the light arm.
   * `__giEmitterRecordShadows = false` restores the sphere arm (build-time).
   */
  #buildEmitterRecordTrace(volume, quality) {
    if (globalThis.__giEmitterRecordShadows === false) return null;
    const occ = volume.occupancyField;
    if (!occ?.voxel || !occ.traceHybridPlane || occ.hasSurfaceRecords !== true) return null;
    const shadowMode = volume.rayHitMode ?? RayHitMode.OccupancyLegacy;
    if (shadowMode < RayHitMode.HybridPlane || shadowMode > RayHitMode.HybridExactComplex) return null;
    const widthProbe =
      globalThis.__giShadowAnalyticWidth !== false ? volume.createWidthProbe?.() ?? null : null;
    // HALF the direct arm's tier ("even one emissive is -10 fps"): emitter
    // shadows are soft area-light shadows, and with the exhaustion→probe
    // fallback a capped ray degrades to "approximately right", never black —
    // so the budget is a pure cost knob now, not a correctness one.
    const macroSteps =
      Number(globalThis.__giDirectShadowSteps) ||
      ({ low: 48, medium: 64, high: 80, ultra: 96 }[quality] ?? 80);
    return (P, N, dir, maxT, k, cosRayNormal) => {
      const vox = vec3(occ.voxel);
      const voxMax = vox.x.max(vox.y).max(vox.z).toVar();
      // Same 1.5-voxel light-side lift as the direct arm — the emitter gate
      // (cosθ > 0.05 in emitterDirectAt) guarantees N faces the lamp.
      const lift = voxMax.mul(1.5).toVar();
      const origin = vec3(P).add(vec3(N).mul(lift)).toVar();
      // maxT already stops at the lamp's surface minus shadowMargin
      // (≥ 2 field cells); one extra voxel keeps grazing rays out of the
      // lamp's own conservatively-bulged shell.
      const tEnd = float(maxT).sub(voxMax).max(0).toVar();
      // STATIC-BVH ARM (see the direct arm's note): exact triangles for the
      // emitter's occlusion too. The tEnd trim above already excludes the
      // lamp's own surface; the width probe supplies area-light softness.
      if (this._dynSet?.staticBvh && globalThis.__giShadowStaticBvh !== false) {
        // Exact-geometry bias, same reasoning as the direct arm's (see there):
        // the voxel lift + one-voxel tMin is a quarter-metre blind band that
        // exact triangles have no shell to justify. P and N arrive directly
        // here, so the tight origin needs no reconstruction.
        const bias = voxMax
          .mul(Number(globalThis.__giShadowExactBias) || 0.02)
          .div(float(cosRayNormal ?? 1).max(0.25))
          .toVar();
        const exactOrigin = vec3(P).add(vec3(N).mul(bias)).toVar();
        const s = this._dynSet.traceStaticBvh(exactOrigin, dir, bias, tEnd);
        const dr = this._dynSet.trace(exactOrigin, dir, bias, tEnd, {});
        const hit = s.x.greaterThanEqual(0).or(dr.hit.greaterThan(0.5)).toVar();
        if (widthProbe) {
          const w = float(1).toVar();
          If(hit.not(), () => {
            w.assign(widthProbe(
              origin, dir, voxMax.mul(3), tEnd, k,
              cosRayNormal != null ? float(cosRayNormal) : float(1),
              lift,
            ));
          });
          return select(hit, float(0), w);
        }
        return select(hit, float(0), float(1));
      }
      const r = occ.traceHybridPlane(origin, dir, voxMax, tEnd, {
        coverage: shadowMode >= RayHitMode.HybridPlaneCoverage,
        exact: shadowMode === RayHitMode.HybridExactComplex,
        penumbraK: k,
        macroSteps,
        excludePoint: globalThis.__giNoSelfPlaneExclusion === true ? null : P,
      });
      if (globalThis.__giEmitterShadowKindDebug === true) {
        // Verdict-kind map instead of a shadow (the light arm's
        // __giShadowKindDebug, for the emitter channel): miss=white,
        // plane=0.75, exact-triangle=0.5, box=0.25, clamp=black.
        return float(1).sub(float(r.kind).mul(0.25));
      }
      if (widthProbe) {
        // EXHAUSTION → THE PROBE'S VERDICT, not the fail-closed black.
        // Emitter geometry makes GRAZING rays the common case, not the
        // pathological one: a floor pixel's ray to a low panel hugs its own
        // surface for metres, the DDA descends at every voxel column along
        // it, and the macro budget (160 at high) burns before the lamp —
        // measured as the probe rig's ENTIRE floor reading occluded with
        // lattice-phase speckle (the sphere arm died of the same disease as
        // black wedges). The march reports exhaustion as verdict kind 4,
        // and the width probe has full reach at FIXED cost: an exhausted
        // ray takes `pen × probe` — open floors read open, rays threading
        // real geometry still read dark (taps inside walls give k·D/t ≈ 0).
        // Resolved rays keep exact admission; the probe runs lazily for
        // misses and exhaustions only (the true umbra still skips it).
        const exhausted = float(r.kind).greaterThan(3.5).toVar();
        const w = float(1).toVar();
        // LAMP EXCLUSION, width-probe form. The emissive mesh IS occupancy
        // geometry, so D → 0 as taps approach the lamp face — without a
        // pullback the LAST taps of every ray read k·d/t ≈ 0 and the whole
        // receiver plane went near-black (the probe rig's waffle floor;
        // neither the plane gate nor step budget moved it — the darkening
        // samples were lamp-proximal, not floor-proximal). The lamp's
        // D-footprint along the ray is its own effective radius, which is
        // exactly maxT/k (emitter k = dist/reff) — so the probe's reach
        // ends at maxT·(1 − 1/k) minus a voxel of bulge. The march still
        // owns admission over the FULL ray, so an occluder hugging the
        // lamp keeps its (hard) shadow; only its extra width is forgone.
        // Analytic gi lights need no such pullback: they have no body in
        // the field (the direct arm passes maxT unchanged).
        const tProbe = tEnd.mul(float(1).sub(float(1).div(float(k).max(1.05)))).sub(voxMax).max(0).toVar();
        If(float(r.hit).lessThan(0.5).or(exhausted), () => {
          w.assign(widthProbe(origin, dir, voxMax.mul(3), tProbe, float(k), float(cosRayNormal), lift));
        });
        return select(exhausted, r.pen.mul(w), r.hit.oneMinus().mul(r.pen).mul(w));
      }
      return r.hit.oneMinus().mul(r.pen);
    };
  }

  /**
   * Builds the deferred resolve for this GI state: a half-resolution gbuffer
   * plus the compute that turns it into the irradiance / emitter-shadow
   * textures materials sample.
   *
   * The TEXTURE NODES are created once per GISystem and reused across every
   * rebuild — that is the point of the whole design. A material's GI code is
   * "sample these two textures", so it is byte-identical before and after a
   * rebuild, its shader stays in the pipeline cache, and a quality change or
   * an auto-fit refit no longer triggers a material recompile wave.
   */
  #buildScreenResolve({ gather, light, emitterSlots, radianceLookup = null, lightSlots = null, ao = null, lightShadow = null, emitterRecordTrace = null, emitterCutoff = null, volume = null, skyRadiance = null, atlas = null }) {
    const renderer = this.engine.renderer;
    if (!renderer?.backend?.device) return null;
    const { width, height } = this.#screenResolveSize();
    const { width: shadowW, height: shadowH } = this.#lightShadowSize({ width, height });
    try {
      const gbuffer = createGiGBuffer(width, height);
      // Emitter shadows at HALF the direct arm's pixel budget (1/sqrt2 per
      // axis): soft area-light shadows survive the lower res behind the
      // bilateral + UV upsample, and per-slot cost was the user's fps cliff.
      const emitterW = Math.max(64, Math.round(shadowW * 0.7071));
      const emitterH = Math.max(64, Math.round(shadowH * 0.7071));
      if (!this._giTargets) {
        this._giTargets = createGiTargets(width, height, shadowW, shadowH, { emitterWidth: emitterW, emitterHeight: emitterH });
        this._giTargetSize = { width, height };
        this._giIrradianceNode = texture(this._giTargets.irradiance);
        this._giEmitterShadowNode = texture(this._giTargets.emitterShadow);
        this._giRadianceNode = texture(this._giTargets.radiance);
      }
      const targets = this._giTargets;
      // PERSISTENT, created once per system and repointed on resize — exactly
      // like its siblings above, and here it is not merely an optimisation:
      // every gi light's `shadow.shadowNode` samples THIS node forever, and a
      // node swap would mean rebuilding (and recompiling) that shadow branch
      // in every material each time the viewport changes size.
      if (lightShadow && !this._giLightShadowNode) {
        this._giLightShadowNode = texture(targets.lightShadow);
      }
      // PCSS blocker-distance channel, same persistence contract as the
      // shadow node above (every gi light's shadow branch samples it).
      // GATED ON pcss: the node's mere existence is what compiles the
      // 16-tap disc into every gi light's material shadow branch (see
      // #acquireLightShadowNode) — with the cone march carrying softness,
      // building the disc against a never-written texture would burn the
      // fetches for a guaranteed no-op.
      if (lightShadow?.pcss && !this._giLightShadowDistNode) {
        this._giLightShadowDistNode = texture(targets.lightShadowDist);
      }
      // The shadowNode's tap offsets are SHADOW-CHANNEL texels (its own
      // resolution since the pass split); runs on every build (and
      // #syncScreenResolveSize covers the resize path).
      (this._giLightShadowTexel ??= uniform(new THREE.Vector2())).value.set(1 / shadowW, 1 / shadowH);
      // The gbuffer POSITION feeds the shadowNode's tap validity (see
      // #acquireLightShadowNode). The gbuffer is per-build, so the persistent
      // node re-points here every time; a resize reuses the same render
      // target object (setSize), so no hook is needed there.
      // Unconditional: giLight's irradiance bilateral needs it even when the
      // light-shadow bundle declined (the smear it guards is a property of
      // EVERY screen-space GI term, not of the shadow feature).
      if (!this._giShadowPosNode) this._giShadowPosNode = texture(gbuffer.position);
      else this._giShadowPosNode.value = gbuffer.position;
      const emitter = emitterSlots
        ? {
            emitterSlots,
            shadowTraceFn: light.shadowTraceFn,
            // Resolve-only record-march arm (see #buildEmitterRecordTrace) —
            // deliberately NOT on `light`, so the in-material fallback path
            // (emitterDirectAt with the light as params) can never compile
            // the bits buffer into fragment shaders.
            recordShadowTrace: emitterRecordTrace,
            shadowMargin: light.shadowMargin,
            shadowRange: light.shadowRange,
            // PER-PRESET EMITTER REACH — the single biggest dial on the screen
            // emitter shadow pass (see giLight's emitterCutoff). Passed as a
            // plain number rather than read off `light`, because
            // `light.shadowRange` is assigned AFTER this bundle is built and
            // a second field with that ordering hazard would be a trap.
            emitterCutoff,
          }
        : null;
      const inputs = { gather, normalOffset: light.normalOffset, intensity: light.intensityUniform, emitter, ao };
      // The bundle arrives target-less (the targets are created just above, and
      // only the system knows when) — bind it here and keep the completed
      // bundle on `screen` so the resize path can re-point it.
      inputs.lightShadow = lightShadow
        ? {
            ...lightShadow,
            target: targets.lightShadow,
            // The trace writes RAW; the spatial filter pass averages it into
            // `target`, which is what every material's shadow branch samples.
            rawTarget: targets.lightShadowRaw,
            distTarget: lightShadow.pcss ? targets.lightShadowDist : null,
          }
        : null;
      // THE RESOLVE'S CAMERA, owned by the system and persistent across
      // rebuilds — like `_giShadowFrameU` and friends, and for the same reason:
      // the tick writes it every frame and a rebuild must not orphan that ref.
      //
      // It used to be a field of the `radiance` bundle, created per build. That
      // coupled the back-face `facing` flip of THREE passes (resolve diffuse,
      // reflection-hit shading, emitter shadow) to whether cascade reflections
      // existed — a build without them silently took the emitter pass's
      // `cameraPosition = null` fallback and stopped flipping. Nothing shipped
      // with radiance off, so nothing shipped broken; the SRC deletion is what
      // makes `radiance` null for real (§12.8).
      this._giResolveCamU ??= uniform(new THREE.Vector3());
      inputs.cameraPosition = this._giResolveCamU;
      const radiance = radianceLookup ? { lookup: radianceLookup } : null;
      inputs.radiance = radiance;
      // Exact-reflection hit shading rides along in this pass (see
      // createGiResolve's `bvhShade`). The BVH targets are created HERE, ahead
      // of `#syncBvhScene`, because the resolve has to bind them at build time
      // while the BVH scene itself only arrives once the mesh list is walked —
      // they are system-lifetime anyway (same reasoning as `_giTargets`), so
      // creating them early costs one half-res texture set and nothing else.
      inputs.bvhShade = this.#bvhReflectionsEnabled()
        ? {
            ...this.#ensureBvhTargets(width, height),
            lightSlots,
          }
        : null;
      // ── SRC (plan §7 Phase 1-2) ───────────────────────────────────────────
      //
      // ON by default since Phase 5 (`__giSrcProbes = false` is the opt-out —
      // see srcSystem.js's header for why the Phase 1–4 rationale died).
      // Built HERE, ahead of the resolve, because since unit 4 it has something
      // the resolve wants: a c0-only irradiance texture. It hangs off the SCREEN
      // bundle rather than off `state` because it is a pure function of the
      // gbuffer — same lifetime, same resize, same dispose.
      let srcProbes = null;
      if (srcProbesEnabled()) {
        try {
          // ── PHASE 5: LIGHTING + STATIC SURFACE (plan §12.28) ───────────
          //
          // Two arguments and not one switch — `srcSystem` refuses to shade
          // without BOTH, because lighting alone would light the whole static
          // world at one default albedo: plausible, wrong everywhere, and read
          // as a shader bug rather than a missing input.
          //
          // The attribution throws if the field was built without its region,
          // so it is gated on the same `srcShadeEnabled()` the field build reads
          // — one function, two call sites, separated by a full rebuild.
          let surfaces = null;
          if (srcShadeEnabled() && volume?.occupancyField && atlas) {
            try {
              surfaces = createSrcSurfaceAttribution(volume.occupancyField, volume.world, atlas);
            } catch (error) {
              console.warn("[gi] src surface attribution unavailable:", error?.message ?? error);
            }
          }
          srcProbes = createSrcProbeSystem({
            gbuffer, width, height, props: this.config, volume, sky: skyRadiance,
            surfaces,
            // ── MOTION-ADAPTIVE α's SIGNAL (§12.38) ─────────────────────
            //
            // Normalized [0,1]; 1 = "fully moving", where α sits at the
            // TEMPORAL_ALPHA every §12 measurement used. Three sources, all
            // computed once per frame by machinery that already existed:
            // the light-motion loop (hoisted from the shadow chain — radians,
            // normalized by the same saturation its hist-weight uses), the
            // emitter slots' own decayed retains (already [0,1]), and the
            // mover set's largest translation+corner displacement (metres,
            // through the light loop's own 5 cm ≈ 1° folding). The CAMERA is
            // deliberately absent: probe evidence is world-anchored, so a
            // camera move stales nothing and must not cost the still scene
            // its calm.
            sceneMotion: () => {
              // ── THE TRACKING WINDOW ARMS ON LIGHT EVENTS ONLY (§12.43) ──
              // A LIGHT change (matrix, luminance, emitter) invalidates the
              // whole field — every probe's history is evidence about a world
              // that no longer exists. A moving OBJECT invalidates locally:
              // the sources are unchanged and most of the field stays true.
              // So light-side peaks arm the hold below and drive the root
              // relaxation; mover displacement keeps §12.38's shipped
              // behaviour exactly. TRACK_AB forced this split: the first
              // draft held on ANY motion peak, and the rig's still controls
              // read 21.2 vs 0.92 rev/px — the mover term spikes spuriously
              // on a parked ultra scene (the §12.42 lift snapshots saw 0.944
              // on a still arm before any tracking code existed), and a hold
              // amplifies every spike from one frame of α to a 1.2 s burst
              // of relaxed-root fast decay.
              const mLight = Math.min(1, Math.max(
                (this._giShadowLastMotion ?? 0) / ALPHA_MOTION_SAT,
                this._giEmitterLastMotion ?? 0,
                // Relative light-luminance delta (see the hoisted light
                // loop): same saturation constant as the other terms, so a
                // lamp toggle rides α at 0.1 instead of crawling in at the
                // 0.05 still floor — §12.38.3's blind spot, closed.
                (this._giLightLumMotion ?? 0) / ALPHA_MOTION_SAT,
              ));
              const m = Math.max(
                mLight,
                Math.min(1, ((this._dynSet?.lastMotion ?? 0) * 0.05) / ALPHA_MOTION_SAT),
              );
              if (globalThis.__giSrcMotionTrack === false) {
                this._giTrackMotion = 0;
                return m;
              }
              const now = performance.now();
              if (mLight >= ALPHA_TRACK_THRESHOLD) {
                this._giMotionHeld = Math.max(
                  mLight,
                  now < (this._giMotionHoldUntil ?? 0) ? (this._giMotionHeld ?? 0) : 0,
                );
                this._giMotionHoldUntil = now + ALPHA_TRACK_HOLD_MS;
              }
              const windowOpen = now < (this._giMotionHoldUntil ?? 0);
              // What srcSystem's root relaxation reads (`trackMotion`): the
              // held LIGHT peak while the window is open, zero otherwise —
              // sub-threshold jitter and mover churn never reach the root.
              this._giTrackMotion = windowOpen ? (this._giMotionHeld ?? 0) : 0;
              return windowOpen ? Math.max(m, this._giMotionHeld ?? 0) : m;
            },
            trackMotion: () => this._giTrackMotion ?? 0,
            lighting: surfaces
              ? {
                  // The engine's punctual lights, straight through — same slots
                  // the screen chain's `analyticDirectAt` reads, so a hit and a
                  // pixel cannot disagree about what a light is.
                  lights: lightSlots ?? [],
                  emitters: emitterSlots ?? [],
                  // A directional slot's shadow ray runs the whole medium, and
                  // `kind` is a uniform, so the bound cannot be a build-time
                  // choice. The volume diagonal is the finite stand-in.
                  maxRay: volume.world.size.value.length(),
                }
              : null,
          });
          console.log(describeSrcProbeSystem(srcProbes));
        } catch (error) {
          // Never take the shipping chain down for an experimental branch.
          console.warn("[gi] src probes unavailable:", error?.message ?? error);
          srcProbes = null;
        }
      }
      // ── TWO INPUTS, ONE INTEGRAL (plan §12.18.7 unit 5) ─────────────────
      //
      // `screenGather` is the PRIMARY diffuse term: computed once per gbuffer
      // pixel in SRC's own pass and handed over as a texture, because the
      // resolve kernel is already near the portable eight-storage-buffer limit
      // and cannot afford the gather's bindings per pixel on top of the
      // gbuffer, the emitter slots, the occupancy pyramid and the BVH.
      //
      // `gather` is the SAME closure, inlined once for the exact-reflection
      // HIT — an arbitrary world point no screen texture can answer for. That
      // call site has been on `gather == null` since the transport died
      // (§12.17.3); [I] is what brings it back, and it is affordable exactly
      // once because `createSrcHashBlockFrame` collapsed the corner lookup from
      // three storage buffers to two.
      inputs.screenGather = srcProbes?.gather?.node ?? null;
      inputs.gather = srcProbes?.gather
        ? (point, normal) => srcProbes.gather.gatherAt(point, normal).irradiance
        : null;
      const resolve = createGiResolve({ gbuffer, targets, width, height, ...inputs });
      // The shadow trace as its own pass at its own budget — see
      // createGiLightShadowPass for why it left the resolve kernel.
      // Temporal-accumulation uniforms, persistent across rebuilds/resizes
      // (the tick updates them; a rebuild must not orphan the tick's refs).
      // THE ANALYTIC-WIDTH ARM NEEDS NO TEMPORAL ANYTHING (docs/
      // GI_SHADOWS_PLAN.md §5): the trace is deterministic, so each frame
      // is already the converged answer — no jitter animation, no
      // reprojection, no history, and the single filter pass below writes
      // straight into the sampled target as banding insurance (rgba16
      // quantization of D and record-plane seams are the residual risks).
      const analyticWidth = inputs.lightShadow?.analyticWidth === true;
      if (inputs.lightShadow && !analyticWidth) {
        // Stochastic arm: materialize the accumulate/history textures (lazy
        // since the analytic default — see createGiTargets).
        targets.ensureShadowTemporal?.();
        // renderGroup + onRenderUpdate — three's canonical per-frame-uniform
        // pattern (what time uniforms use). The default object group's
        // buffer does NOT re-upload on a quiet scene: the phase uniform's
        // CPU value climbed every tick while the GPU kernel kept the boot
        // value — the animated jitter was compiled in yet never animated
        // (probe signature: two same-state raw readbacks differing by ~1
        // pixel while the phase climbs). The same treatment goes to the
        // reprojection matrix and history weight — all three are per-frame
        // temporal inputs with no other upload trigger on a still scene.
        this._giShadowFrameU ??= uniform(0).setGroup(renderGroup).onRenderUpdate(() => this._giShadowPhase ?? 0);
        this._giShadowPrevVPU ??= uniform(new THREE.Matrix4()).setGroup(renderGroup);
        this._giShadowHistWeightU ??= uniform(0.9).setGroup(renderGroup);
      }
      const lightShadowPass = inputs.lightShadow
        ? createGiLightShadowPass({
            gbuffer,
            lightShadow: inputs.lightShadow,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
            frame: analyticWidth ? null : this._giShadowFrameU,
          })
        : null;
      // Edge-aware average of the stochastic trace — see the pass's comment
      // for why penumbra smoothing lives here and not in materials. planeEps
      // rides the occupancy voxel (a node, so refits rescale it). `history`
      // adds the reprojected temporal blend (see the pass's comment).
      // WIDE PENUMBRA PASS (analytic + PCSS only): the bilateral writes MID,
      // the wide pass reconstructs blocker-distance-driven penumbra width
      // into the sampled target (see createGiLightShadowWidePass — the 90°
      // hard-inner-edge fix). Without PCSS (no dist channel) the bilateral
      // writes the target directly, exactly as before.
      const wideOn = analyticWidth && inputs.lightShadow?.pcss && globalThis.__giShadowWidePass !== false;
      if (wideOn) this._giShadowWideCamU ??= uniform(new THREE.Vector3());
      const lightShadowFilterPass = lightShadowPass
        ? createGiLightShadowFilterPass({
            gbuffer,
            source: targets.lightShadowRaw,
            // Analytic arm: ONE bilateral, straight into the sampled target
            // (the accumulate→history→post chain never exists).
            target: analyticWidth ? (wideOn ? targets.lightShadowMid : targets.lightShadow) : targets.lightShadowAccum,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
            planeEps: inputs.lightShadow.voxMax ?? 0.1,
            // Angle-adaptive σ (see the filter's note) — synced per tick
            // from the sharpest claimed light in #syncLightShadowNodes.
            softness: (this._giShadowSoftnessU ??= uniform(1)),
            history: analyticWidth ? null : {
              histShadow: targets.lightShadowHist,
              histPos: targets.lightShadowHistPos,
              prevViewProj: this._giShadowPrevVPU,
              weight: this._giShadowHistWeightU,
              validEps: inputs.lightShadow.voxMax ?? 0.15,
            },
          })
        : null;
      // Two chained instances — small radius first, large radius over the
      // pre-blurred result: compounding is what reaches the whole-shadow
      // footprints a 90° source needs (core lift, not just edge blur).
      const lightShadowWidePass = wideOn && lightShadowFilterPass
        ? createGiLightShadowWidePass({
            gbuffer,
            source: targets.lightShadowMid,
            dist: targets.lightShadowDist,
            target: targets.lightShadowWide,
            slots: inputs.lightShadow.slots,
            span: inputs.lightShadow.span,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
            cameraPosition: this._giShadowWideCamU,
            capFrac: 0.08,
          })
        : null;
      const lightShadowWidePass2 = lightShadowWidePass
        ? createGiLightShadowWidePass({
            gbuffer,
            source: targets.lightShadowWide,
            dist: targets.lightShadowDist,
            target: targets.lightShadow,
            slots: inputs.lightShadow.slots,
            span: inputs.lightShadow.span,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
            cameraPosition: this._giShadowWideCamU,
            capFrac: 0.25,
          })
        : null;
      const lightShadowHistoryPass = lightShadowFilterPass && !analyticWidth
        ? createGiLightShadowHistoryPass({
            gbuffer,
            source: targets.lightShadowAccum,
            histShadow: targets.lightShadowHist,
            histPos: targets.lightShadowHistPos,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
          })
        : null;
      // PRESENTATION FILTER — the same edge-aware kernel, history-free,
      // cleaning the ACCUMULATED signal into the texture materials sample.
      // Outside the feedback loop on purpose: history stores the un-post-
      // filtered accumulation, so the extra blur never compounds frame over
      // frame (that would flatten every penumbra), it only removes the
      // residual filter-scale mottle the EMA leaves behind ("still very
      // grainy and dirty").
      const lightShadowPostPass = lightShadowFilterPass && !analyticWidth
        ? createGiLightShadowFilterPass({
            gbuffer,
            source: targets.lightShadowAccum,
            target: targets.lightShadow,
            width: shadowW,
            height: shadowH,
            resolveWidth: width,
            resolveHeight: height,
            planeEps: inputs.lightShadow.voxMax ?? 0.1,
          })
        : null;
      // EMITTER SHADOW PASS + FILTER (see createGiEmitterShadowPass in
      // giScreen) — queued BEFORE the resolve each frame: the resolve
      // samples the filtered texture instead of tracing per resolve pixel.
      const emitterShadowPass = inputs.emitter
        ? createGiEmitterShadowPass({
            gbuffer,
            emitter: inputs.emitter,
            normalOffset: inputs.normalOffset,
            target: targets.emitterShadowRaw,
            width: emitterW,
            height: emitterH,
            resolveWidth: width,
            resolveHeight: height,
            cameraPosition: this._giResolveCamU,
          })
        : null;
      // EMITTER TEMPORAL ACCUMULATION (2026-08-07). This channel had the
      // spatial bilateral and nothing else — see `ensureEmitterTemporal` for why
      // that is the "emissive still has dither" report. It now mirrors the
      // analytic-light stochastic arm exactly: raw -> filter(+history) -> accum
      // -> history snapshot -> a second, history-free filter into the sampled
      // target. The split matters and is not cosmetic: post-filtering the
      // fed-back signal would convolve it once per frame and wash every penumbra
      // to flat grey, so presentation blur stays OUTSIDE the accumulation loop.
      //
      // The camera reprojection matrix is SHARED with the light channel — same
      // camera, same frame — but the history weight is its own uniform so the
      // two channels can be tuned (and A/B'd) independently.
      // OFF BY DEFAULT, AND THE REASON IS THE INSTRUMENT, NOT THE CODE.
      //
      // The chain is complete and correct as far as anything here can tell: it
      // builds, it survives resize, it type-checks, and it ran ~6 bleed-rig
      // captures with no error. What does NOT exist is evidence that it improves
      // anything, because the bleed rig cannot currently measure it.
      //
      // Eight runs of `EMISSIVE_SHADOWS=1 ARMS=white EMIT=5` land in exactly two
      // clusters of mean linear luminance:
      //     ~0.0810   et-on, et-f16, et-default(chain OFF), et-on2(chain ON)
      //     ~0.0844   et-off(OFF), et-w0(ON, weight 0), et-final(ON)
      // Cluster membership does NOT follow the hatch — the chain being on or off
      // appears on both sides — and the two clusters differ by 4% of the mean and
      // 20% of pixels, which is far larger than the effect under test. Same GI
      // build line, same exposure gain (23.92 vs 23.90), same stitch decisions,
      // so it is not the volume fit or the bracket. The rig is deterministic
      // WITHIN a state (two consecutive identical configs read 0.00% apart) and
      // bistable ACROSS runs.
      //
      // Two conclusions were drawn from this rig before that was noticed, and
      // BOTH are withdrawn: that the chain halves emitter indirect (-49%), and
      // that it is energy-neutral (0.0%). Each compared runs that happened to sit
      // in different clusters. The -49% was especially convincing because its
      // dark-hit/bright-spared shape is a textbook 8-bit EMA ratchet — a whole
      // hypothesis, and the HalfFloatType change in giScreen, were built on it.
      //
      // So this stays off until the rig's bistability is found and fixed. That is
      // the next item: an instrument that produces a 4% swing unrelated to the
      // variable under test cannot certify a change of this size in either
      // direction, and shipping on the strength of a reading it produced would be
      // guessing with extra steps.
      //
      // `__giEmitterTemporal = true` opts in (build-time — set it, then touch a
      // structural prop to force a rebuild). `__giEmitterHistWeight` pins the
      // blend; at 0 the chain is a no-op to within 0.1%, which is the one thing
      // measured here that both clusters agree on.
      const emitterTemporal = emitterShadowPass && globalThis.__giEmitterTemporal === true;
      if (emitterTemporal) {
        targets.ensureEmitterTemporal?.();
        this._giEmitterHistWeightU ??= uniform(0.9).setGroup(renderGroup);
        this._giShadowPrevVPU ??= uniform(new THREE.Matrix4()).setGroup(renderGroup);
      }
      const emitterShadowFilterPass = emitterShadowPass
        ? createGiLightShadowFilterPass({
            gbuffer,
            source: targets.emitterShadowRaw,
            target: emitterTemporal ? targets.emitterShadowAccum : targets.emitterShadow,
            width: emitterW,
            height: emitterH,
            resolveWidth: width,
            resolveHeight: height,
            planeEps: inputs.lightShadow?.voxMax ?? 0.1,
            history: emitterTemporal ? {
              histShadow: targets.emitterShadowHist,
              histPos: targets.emitterShadowHistPos,
              prevViewProj: this._giShadowPrevVPU,
              weight: this._giEmitterHistWeightU,
              validEps: inputs.lightShadow?.voxMax ?? 0.15,
            } : null,
          })
        : null;
      const emitterShadowHistoryPass = emitterTemporal && emitterShadowFilterPass
        ? createGiLightShadowHistoryPass({
            gbuffer,
            source: targets.emitterShadowAccum,
            histShadow: targets.emitterShadowHist,
            histPos: targets.emitterShadowHistPos,
            width: emitterW,
            height: emitterH,
            resolveWidth: width,
            resolveHeight: height,
          })
        : null;
      const emitterShadowPostPass = emitterTemporal && emitterShadowFilterPass
        ? createGiLightShadowFilterPass({
            gbuffer,
            source: targets.emitterShadowAccum,
            target: targets.emitterShadow,
            width: emitterW,
            height: emitterH,
            resolveWidth: width,
            resolveHeight: height,
            planeEps: inputs.lightShadow?.voxMax ?? 0.1,
          })
        : null;
      light.giIrradianceNode = this._giIrradianceNode;
      light.giEmitterShadowNode = emitterSlots ? this._giEmitterShadowNode : null;
      light.giRadianceNode = radianceLookup ? this._giRadianceNode : null;
      // Silhouette-validity inputs for giLight's bilateral screen sampling
      // (same machinery as the shadowNode's — see #acquireLightShadowNode):
      // the half-res gbuffer POSITION says which surface each texel's GI was
      // resolved FOR, which is what stops a bright texel's irradiance from
      // smearing white dots across the dark silhouette in front of it.
      light.giPositionNode = this._giShadowPosNode;
      light.giScreenTexel = this._giLightShadowTexel;
      if (srcProbes) {
        // The gizmos go in the scene rather than on `state.gizmos`, because
        // they belong to the SCREEN bundle's lifetime (they read its probe
        // table) and `state.gizmos` is disposed on a different schedule.
        // `__giDebug` on each mesh keeps them out of the gbuffer prepass, the
        // voxelizer and the light tree — a gizmo that voxelized would occlude
        // the field it is drawing.
        this.engine.scene.add(srcProbes.gizmos.group);
        srcProbes.gizmos.setVisible(giDebugView() === "src-probes");
      }
      return { gbuffer, srcProbes, resolve, lightShadowPass, lightShadowFilterPass, lightShadowWidePass, lightShadowWidePass2, lightShadowHistoryPass, lightShadowPostPass, emitterShadowPass, emitterShadowFilterPass, emitterShadowHistoryPass, emitterShadowPostPass, targets, width, height, shadowWidth: shadowW, shadowHeight: shadowH, emitterShadowWidth: emitterW, emitterShadowHeight: emitterH, ...inputs };
    } catch (error) {
      // Falling back to the in-material path keeps GI working (slowly) rather
      // than rendering an unlit scene.
      console.warn("[gi] deferred resolve unavailable — falling back to per-material GI:", error?.message ?? error);
      return null;
    }
  }

  /**
   * Keeps the resolve buffers matched to the viewport. A resize swaps the
   * texture objects behind the PERSISTENT texture nodes (a uniform rebind),
   * and rebuilds only the resolve compute — whose WGSL is size-independent
   * (the dimensions are uniforms), so three's node cache and the driver's
   * pipeline cache both hit and no material is touched.
   */
  #syncScreenResolveSize(state) {
    const screen = state.screen;
    const { width, height } = this.#screenResolveSize();
    // The SHADOW size is part of the comparison, not just a consequence of it.
    // `lightShadowMaxPixels` can move while the resolve size does not (it is a
    // budget on a channel derived from the resolve), and a resolve-only test
    // would early-return — leaving a declared, Inspector-visible knob that
    // does nothing until the window is resized. That is the `exactReflections`
    // failure this file already warns about twice. `shadowWidth`/`shadowHeight`
    // are set at build (see #buildScreenResolve's return), so this never
    // reports a spurious resize on the first frame.
    const { width: shadowW, height: shadowH } = this.#lightShadowSize({ width, height });
    if (
      width === screen.width &&
      height === screen.height &&
      shadowW === screen.shadowWidth &&
      shadowH === screen.shadowHeight
    ) {
      return;
    }
    // A RESIZE IS SUPPOSED TO BE RARE. It recreates every GI target, retires
    // the old ones 3 frames later, and REBUILDS + sync-compiles the resolve
    // pipeline. If this fires repeatedly on a static viewport (a size that
    // oscillates by a pixel, a render scale that chases frame time), the GI
    // texture is being torn down and rebuilt while the scene renders — which
    // is GI-only, independent of every lighting term, and looks exactly like a
    // global flicker. Counted under `__giLogComposite`.
    if (globalThis.__giLogComposite) {
      this._resolveResizes = (this._resolveResizes ?? 0) + 1;
      console.log(`[gi] resolve target resized to ${width}x${height} (was ${screen.width}x${screen.height})`);
    }
    screen.width = width;
    screen.height = height;
    screen.shadowWidth = shadowW;
    screen.shadowHeight = shadowH;
    screen.gbuffer.setSize(width, height);
    // The probe population is one thread per gbuffer pixel and its dispatch
    // counts are baked into the compute nodes, so a resize rebuilds it. Returns
    // a NEW system and disposes the old one — the assignment is the point.
    if (screen.srcProbes) screen.srcProbes = screen.srcProbes.setSize(width, height);
    // New targets at the new size; the persistent nodes are re-pointed at
    // them, which is a binding refresh rather than a shader rebuild (every
    // observed material has hasNode = true, so its bindings refresh per frame
    // — see #markObservedMaterial).
    const previousTargets = screen.targets;
    const emitterW = Math.max(64, Math.round(shadowW * 0.7071));
    const emitterH = Math.max(64, Math.round(shadowH * 0.7071));
    screen.targets = createGiTargets(width, height, shadowW, shadowH, { emitterWidth: emitterW, emitterHeight: emitterH });
    screen.emitterShadowWidth = emitterW;
    screen.emitterShadowHeight = emitterH;
    // The stochastic arm's accumulate/history textures are lazy now — a
    // resize on that arm must re-materialize them before the pass rebuilds
    // below bind them (the history pass's existence records the arm).
    if (screen.lightShadowHistoryPass) screen.targets.ensureShadowTemporal?.();
    this._giTargets = screen.targets;
    this._giTargetSize = { width, height };
    this._giIrradianceNode.value = screen.targets.irradiance;
    this._giEmitterShadowNode.value = screen.targets.emitterShadow;
    this._giRadianceNode.value = screen.targets.radiance;
    // The shadowNode's tap offsets are SHADOW-CHANNEL texels — this path
    // skips #buildScreenResolve, so the uniform must follow the size here too.
    this._giLightShadowTexel?.value.set(1 / shadowW, 1 / shadowH);
    // Same swap for the gi light-shadow channel pack. The node is what every
    // gi light's compiled shadow branch holds, so re-pointing it (rather than
    // rebuilding it) is what keeps a viewport resize free of material
    // recompiles — and the bundle has to carry the NEW texture into the
    // resolve rebuild below, or the pass would write into the target that is
    // about to be retired.
    if (this._giLightShadowNode) this._giLightShadowNode.value = screen.targets.lightShadow;
    if (this._giLightShadowDistNode) this._giLightShadowDistNode.value = screen.targets.lightShadowDist;
    if (screen.lightShadow) {
      screen.lightShadow = {
        ...screen.lightShadow,
        target: screen.targets.lightShadow,
        rawTarget: screen.targets.lightShadowRaw,
        distTarget: screen.lightShadow.pcss ? screen.targets.lightShadowDist : null,
      };
    }
    // THE BVH TARGETS ARE REPLACED BEFORE THE RESOLVE IS REBUILT, not after.
    // The resolve now BINDS them (it shades the reflection hits — see
    // createGiResolve's `bvhShade`), so rebuilding it against the old,
    // about-to-be-retired textures would hand it dead bindings and the pass
    // would start failing a few frames later, when the retire timer fires.
    let previousBvhTarget = null;
    if (screen.bvhShade) {
      previousBvhTarget = this._giBvhTarget;
      this._giBvhTarget = createGiBvhTarget(width, height);
      this._giBvhTargetSize = { width, height };
      this._giBvhReflectNode.value = this._giBvhTarget.bvhReflect;
      this._giBvhColorNode.value = this._giBvhTarget.bvhColor;
      this._giBvhRadianceNode.value = this._giBvhTarget.bvhRadiance;
      screen.bvhShade = {
        ...screen.bvhShade,
        hit: this._giBvhTarget.bvhReflect,
        albedo: this._giBvhTarget.bvhColor,
        target: this._giBvhTarget.bvhRadiance,
      };
    }
    const index = state.queue.indexOf(screen.resolve.compute);
    const indexNoFeedback = state.queueNoFeedback.indexOf(screen.resolve.compute);
    const indexFeedbackOnly = state.queueFeedbackOnly?.indexOf(screen.resolve.compute) ?? -1;
    screen.resolve = createGiResolve({
      gbuffer: screen.gbuffer,
      targets: screen.targets,
      width,
      height,
      gather: screen.gather,
      // Same system-owned uniform the first build bound — the tick holds the
      // only reference that matters, so a resize must not mint a new one.
      cameraPosition: this._giResolveCamU,
      normalOffset: screen.normalOffset,
      intensity: screen.intensity,
      emitter: screen.emitter,
      radiance: screen.radiance,
      bvhShade: screen.bvhShade,
      ao: screen.ao,
    });
    if (index >= 0) state.queue[index] = screen.resolve.compute;
    if (indexNoFeedback >= 0) state.queueNoFeedback[indexNoFeedback] = screen.resolve.compute;
    if (indexFeedbackOnly >= 0) state.queueFeedbackOnly[indexFeedbackOnly] = screen.resolve.compute;
    // Emitter shadow pass + filter follow the same rebuild+splice contract
    // (fresh targets at the new sizes; queue positions preserved so they
    // stay AHEAD of the resolve that samples them).
    if (screen.emitterShadowPass) {
      const oldEmitter = screen.emitterShadowPass.compute;
      const emitterIndexes = [
        state.queue.indexOf(oldEmitter),
        state.queueNoFeedback.indexOf(oldEmitter),
        state.queueFeedbackOnly?.indexOf(oldEmitter) ?? -1,
      ];
      screen.emitterShadowPass = createGiEmitterShadowPass({
        gbuffer: screen.gbuffer,
        emitter: screen.emitter,
        normalOffset: screen.normalOffset,
        target: screen.targets.emitterShadowRaw,
        width: emitterW,
        height: emitterH,
        resolveWidth: width,
        resolveHeight: height,
        cameraPosition: this._giResolveCamU,
      });
      if (emitterIndexes[0] >= 0) state.queue[emitterIndexes[0]] = screen.emitterShadowPass.compute;
      if (emitterIndexes[1] >= 0) state.queueNoFeedback[emitterIndexes[1]] = screen.emitterShadowPass.compute;
      if (emitterIndexes[2] >= 0) state.queueFeedbackOnly[emitterIndexes[2]] = screen.emitterShadowPass.compute;
    }
    // The emitter temporal trio is sized to the EMITTER target, so a resize has
    // to re-make it before the passes below bind it — same lazy contract the
    // analytic arm gets a few dozen lines down.
    const emitterTemporal = !!screen.emitterShadowHistoryPass;
    if (emitterTemporal) screen.targets.ensureEmitterTemporal?.();
    if (screen.emitterShadowFilterPass) {
      const oldEmitterFilter = screen.emitterShadowFilterPass.compute;
      const emitterFilterIndexes = [
        state.queue.indexOf(oldEmitterFilter),
        state.queueNoFeedback.indexOf(oldEmitterFilter),
        state.queueFeedbackOnly?.indexOf(oldEmitterFilter) ?? -1,
      ];
      screen.emitterShadowFilterPass = createGiLightShadowFilterPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.emitterShadowRaw,
        // Must match the BUILD's choice or the chain silently breaks: writing
        // straight to `emitterShadow` while the history/post passes still read
        // `emitterShadowAccum` leaves the post pass filtering a stale buffer.
        target: emitterTemporal ? screen.targets.emitterShadowAccum : screen.targets.emitterShadow,
        width: emitterW,
        height: emitterH,
        resolveWidth: width,
        resolveHeight: height,
        planeEps: screen.lightShadow?.voxMax ?? 0.1,
        history: emitterTemporal ? {
          histShadow: screen.targets.emitterShadowHist,
          histPos: screen.targets.emitterShadowHistPos,
          prevViewProj: this._giShadowPrevVPU,
          weight: this._giEmitterHistWeightU,
          validEps: screen.lightShadow?.voxMax ?? 0.15,
        } : null,
      });
      if (emitterFilterIndexes[0] >= 0) state.queue[emitterFilterIndexes[0]] = screen.emitterShadowFilterPass.compute;
      if (emitterFilterIndexes[1] >= 0) state.queueNoFeedback[emitterFilterIndexes[1]] = screen.emitterShadowFilterPass.compute;
      if (emitterFilterIndexes[2] >= 0) state.queueFeedbackOnly[emitterFilterIndexes[2]] = screen.emitterShadowFilterPass.compute;
    }
    if (screen.emitterShadowHistoryPass) {
      const oldEmitterHist = screen.emitterShadowHistoryPass.compute;
      const idx = [
        state.queue.indexOf(oldEmitterHist),
        state.queueNoFeedback.indexOf(oldEmitterHist),
        state.queueFeedbackOnly?.indexOf(oldEmitterHist) ?? -1,
      ];
      screen.emitterShadowHistoryPass = createGiLightShadowHistoryPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.emitterShadowAccum,
        histShadow: screen.targets.emitterShadowHist,
        histPos: screen.targets.emitterShadowHistPos,
        width: emitterW,
        height: emitterH,
        resolveWidth: width,
        resolveHeight: height,
      });
      if (idx[0] >= 0) state.queue[idx[0]] = screen.emitterShadowHistoryPass.compute;
      if (idx[1] >= 0) state.queueNoFeedback[idx[1]] = screen.emitterShadowHistoryPass.compute;
      if (idx[2] >= 0) state.queueFeedbackOnly[idx[2]] = screen.emitterShadowHistoryPass.compute;
    }
    if (screen.emitterShadowPostPass) {
      const oldEmitterPost = screen.emitterShadowPostPass.compute;
      const idx = [
        state.queue.indexOf(oldEmitterPost),
        state.queueNoFeedback.indexOf(oldEmitterPost),
        state.queueFeedbackOnly?.indexOf(oldEmitterPost) ?? -1,
      ];
      screen.emitterShadowPostPass = createGiLightShadowFilterPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.emitterShadowAccum,
        target: screen.targets.emitterShadow,
        width: emitterW,
        height: emitterH,
        resolveWidth: width,
        resolveHeight: height,
        planeEps: screen.lightShadow?.voxMax ?? 0.1,
      });
      if (idx[0] >= 0) state.queue[idx[0]] = screen.emitterShadowPostPass.compute;
      if (idx[1] >= 0) state.queueNoFeedback[idx[1]] = screen.emitterShadowPostPass.compute;
      if (idx[2] >= 0) state.queueFeedbackOnly[idx[2]] = screen.emitterShadowPostPass.compute;
    }
    // Same rebuild + splice for the shadow pass (its own size, its own
    // compute-count, the fresh targets).
    if (screen.lightShadowPass) {
      const oldPass = screen.lightShadowPass.compute;
      const passIndexes = [
        state.queue.indexOf(oldPass),
        state.queueNoFeedback.indexOf(oldPass),
        state.queueFeedbackOnly?.indexOf(oldPass) ?? -1,
      ];
      screen.lightShadowPass = createGiLightShadowPass({
        gbuffer: screen.gbuffer,
        lightShadow: screen.lightShadow,
        width: shadowW,
        height: shadowH,
        resolveWidth: width,
        resolveHeight: height,
        // MUST match the build path's inputs. This splice originally omitted
        // `frame`, which silently replaced the animated-jitter kernel with
        // the static one on the FIRST viewport resize — the editor always
        // resizes once at layout-settle, so every editor session ran frozen
        // dither while the (never-resizing) smoke page validated the
        // animated path. Probe signature: two same-state readbacks of the
        // raw texture differing by ~1 pixel while the phase uniform climbs.
        // (The analytic-width arm builds with frame null — same rule.)
        frame: screen.lightShadow?.analyticWidth ? null : this._giShadowFrameU,
      });
      if (passIndexes[0] >= 0) state.queue[passIndexes[0]] = screen.lightShadowPass.compute;
      if (passIndexes[1] >= 0) state.queueNoFeedback[passIndexes[1]] = screen.lightShadowPass.compute;
      if (passIndexes[2] >= 0) state.queueFeedbackOnly[passIndexes[2]] = screen.lightShadowPass.compute;
    }
    // And the filter pass riding behind it (same fresh targets, same splice).
    if (screen.lightShadowFilterPass) {
      const oldFilter = screen.lightShadowFilterPass.compute;
      const filterIndexes = [
        state.queue.indexOf(oldFilter),
        state.queueNoFeedback.indexOf(oldFilter),
        state.queueFeedbackOnly?.indexOf(oldFilter) ?? -1,
      ];
      // The history pass's existence is the durable record of which chain
      // the build chose (temporal vs analytic-width single-filter) — derive
      // target/history from it so a resize can never silently flip arms.
      const temporalChain = !!screen.lightShadowHistoryPass;
      screen.lightShadowFilterPass = createGiLightShadowFilterPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.lightShadowRaw,
        target: temporalChain
          ? screen.targets.lightShadowAccum
          : screen.lightShadowWidePass ? screen.targets.lightShadowMid : screen.targets.lightShadow,
        width: shadowW,
        height: shadowH,
        resolveWidth: width,
        resolveHeight: height,
        planeEps: screen.lightShadow?.voxMax ?? 0.1,
        history: temporalChain ? {
          histShadow: screen.targets.lightShadowHist,
          histPos: screen.targets.lightShadowHistPos,
          prevViewProj: this._giShadowPrevVPU,
          weight: this._giShadowHistWeightU,
          validEps: screen.lightShadow?.voxMax ?? 0.15,
        } : null,
      });
      if (filterIndexes[0] >= 0) state.queue[filterIndexes[0]] = screen.lightShadowFilterPass.compute;
      if (filterIndexes[1] >= 0) state.queueNoFeedback[filterIndexes[1]] = screen.lightShadowFilterPass.compute;
      if (filterIndexes[2] >= 0) state.queueFeedbackOnly[filterIndexes[2]] = screen.lightShadowFilterPass.compute;
    }
    if (screen.lightShadowWidePass) {
      const wideSpecs = [
        { key: "lightShadowWidePass", source: screen.targets.lightShadowMid, target: screen.targets.lightShadowWide, capFrac: 0.08 },
        { key: "lightShadowWidePass2", source: screen.targets.lightShadowWide, target: screen.targets.lightShadow, capFrac: 0.25 },
      ];
      for (const spec of wideSpecs) {
        const oldWide = screen[spec.key].compute;
        const wideIndexes = [
          state.queue.indexOf(oldWide),
          state.queueNoFeedback.indexOf(oldWide),
          state.queueFeedbackOnly?.indexOf(oldWide) ?? -1,
        ];
        screen[spec.key] = createGiLightShadowWidePass({
          gbuffer: screen.gbuffer,
          source: spec.source,
          dist: screen.targets.lightShadowDist,
          target: spec.target,
          slots: screen.lightShadow.slots,
          span: screen.lightShadow.span,
          width: shadowW,
          height: shadowH,
          resolveWidth: width,
          resolveHeight: height,
          cameraPosition: this._giShadowWideCamU,
          capFrac: spec.capFrac,
        });
        if (wideIndexes[0] >= 0) state.queue[wideIndexes[0]] = screen[spec.key].compute;
        if (wideIndexes[1] >= 0) state.queueNoFeedback[wideIndexes[1]] = screen[spec.key].compute;
        if (wideIndexes[2] >= 0) state.queueFeedbackOnly[wideIndexes[2]] = screen[spec.key].compute;
      }
    }
    if (screen.lightShadowHistoryPass) {
      const oldHistory = screen.lightShadowHistoryPass.compute;
      const historyIndexes = [
        state.queue.indexOf(oldHistory),
        state.queueNoFeedback.indexOf(oldHistory),
        state.queueFeedbackOnly?.indexOf(oldHistory) ?? -1,
      ];
      screen.lightShadowHistoryPass = createGiLightShadowHistoryPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.lightShadowAccum,
        histShadow: screen.targets.lightShadowHist,
        histPos: screen.targets.lightShadowHistPos,
        width: shadowW,
        height: shadowH,
        resolveWidth: width,
        resolveHeight: height,
      });
      if (historyIndexes[0] >= 0) state.queue[historyIndexes[0]] = screen.lightShadowHistoryPass.compute;
      if (historyIndexes[1] >= 0) state.queueNoFeedback[historyIndexes[1]] = screen.lightShadowHistoryPass.compute;
      if (historyIndexes[2] >= 0) state.queueFeedbackOnly[historyIndexes[2]] = screen.lightShadowHistoryPass.compute;
    }
    if (screen.lightShadowPostPass) {
      const oldPost = screen.lightShadowPostPass.compute;
      const postIndexes = [
        state.queue.indexOf(oldPost),
        state.queueNoFeedback.indexOf(oldPost),
        state.queueFeedbackOnly?.indexOf(oldPost) ?? -1,
      ];
      screen.lightShadowPostPass = createGiLightShadowFilterPass({
        gbuffer: screen.gbuffer,
        source: screen.targets.lightShadowAccum,
        target: screen.targets.lightShadow,
        width: shadowW,
        height: shadowH,
        resolveWidth: width,
        resolveHeight: height,
        planeEps: screen.lightShadow?.voxMax ?? 0.1,
      });
      if (postIndexes[0] >= 0) state.queue[postIndexes[0]] = screen.lightShadowPostPass.compute;
      if (postIndexes[1] >= 0) state.queueNoFeedback[postIndexes[1]] = screen.lightShadowPostPass.compute;
      if (postIndexes[2] >= 0) state.queueFeedbackOnly[postIndexes[2]] = screen.lightShadowPostPass.compute;
    }
    this.#retireTargets(previousTargets);
    // Same follow-up for the BVH reflect compute (GI Phase 3 v1) — it is NOT
    // part of state.queue/queueNoFeedback (see #tick's dispatch comment), so
    // there is no index-splice step for it.
    if (screen.bvhReflect) {
      if (!previousBvhTarget) {
        // Exact reflections without the shading bundle (an unshaded build):
        // the targets were not swapped above, so do it here.
        previousBvhTarget = this._giBvhTarget;
        this._giBvhTarget = createGiBvhTarget(width, height);
        this._giBvhTargetSize = { width, height };
        this._giBvhReflectNode.value = this._giBvhTarget.bvhReflect;
        this._giBvhColorNode.value = this._giBvhTarget.bvhColor;
        this._giBvhRadianceNode.value = this._giBvhTarget.bvhRadiance;
      }
      const { compute } = createGiBvhReflect({
        gbuffer: screen.gbuffer,
        target: this._giBvhTarget.bvhReflect,
        colorTarget: this._giBvhTarget.bvhColor,
        width,
        height,
        bvhScene: screen.bvhReflect.bvhScene,
        cameraPosition: this._bvhCameraPosition,
        normalOffset: state.light.normalOffset,
        maxDistance: state.light.mirrorRange ?? 24,
        mask: this.#bvhMaskEnabled(),
      });
      screen.bvhReflect = { compute, bvhScene: screen.bvhReflect.bvhScene };
    }
    this.#retireTargets(previousBvhTarget);
  }

  /**
   * Whether exact (BVH) reflections should be active right now: the whole
   * mirror system must be on, the component explicitly opts in, and the
   * dev/harness A-B hatch must not be set. Read
   * fresh at both build/sync time (compiles the material-side switch) and
   * dispatch time (`#tick`, stops the GPU cost immediately if the hatch is
   * flipped live) — see `bvhReflectTexture`'s doc comment in giLight.js.
   */
  #bvhReflectionsEnabled() {
    if (!this.component) return false;
    const props = this.config;
    if (props.reflections === false) return false;
    if (globalThis.__giNoBvhReflections === true) return false;
    // Exact BVH is a high/ultra feature. Presets are an actual performance
    // contract: a stale advanced flag stored by a previous high-quality edit
    // must not silently turn a Medium scene into a 100-200ms/frame workload.
    // `custom` intentionally follows the high tier via qualityTierOf().
    const quality = qualityTierOf(props);
    if (quality !== "high" && quality !== "ultra") return false;
    if (props.exactReflections !== true) return false;
    // ── AND SOMETHING IN THE SCENE MUST ACTUALLY READ IT ────────────────────
    //
    // §13.14.6: the user's Sponza logs `bvh: exact reflections ON — DENSE
    // (full-screen), hit-shaded` next to `material GI buckets: 0 mirror, 0
    // specular, 27 diffuse-only, 0 dynamic-roughness`, and their slowest
    // pipeline — 82.1 s of a 136.8 s total, index #48, OUTSIDE the 46 warmed
    // kernels — is that prepass. **A full-screen exact-reflection BVH trace,
    // compiled for a scene in which nothing consumes reflections.**
    //
    // Exactly the shape §13.13 found for the light-shadow chain, and the same
    // fix: gate on a consumer, not on the tier. `exactReflections` derives from
    // `quality` alone, so high/ultra turned this on for every scene regardless
    // of content.
    //
    // ⚠ A RAMP, NOT A REMOVAL (R1). Buckets 0 (mirror) and 3
    // (dynamic-roughness) are the shaders that read `bvhShade`; give any
    // material a low enough roughness and `#refreshMirrorBucket` moves it into
    // one, which flips this back on and rebuilds. The feature is not gone, it
    // is deferred to the scene that asks for it.
    return this.#hasReflectionConsumer();
  }

  /**
   * Is any material in the scene in a bucket that reads the exact-reflection
   * target? Buckets 0 and 3 are "mirror" and "dynamic-roughness" — the two the
   * bucket log already calls "the expensive shaders".
   *
   * ⚠ UNKNOWN MEANS YES. `_bucketTally` is filled by the mesh walk, and a build
   * that somehow reaches here before the walk must not silently ship a scene
   * without its reflections — a missing feature reads as a rendering bug, while
   * a slow first build reads as the slow first build it already is.
   */
  #hasReflectionConsumer() {
    if (globalThis.__giReflectConsumerGate === false) return true;
    const bt = this._bucketTally;
    if (!bt) return true;
    return bt[0] + bt[3] > 0;
  }

  /**
   * The exact-reflection screen targets + the persistent texture nodes over
   * them, created on first use and kept for the SYSTEM's lifetime — never per
   * build. Materials and the resolve compile against these NODES and hold them
   * across rebuilds, so a node may only ever have its `.value` re-pointed (see
   * createGiTargets' comment; this is the same contract).
   *
   * Returns the plain textures the resolve binds: `hit`/`albedo` are what the
   * BVH prepass writes, `target` is where the shaded radiance goes.
   */
  #ensureBvhTargets(width, height) {
    if (!this._giBvhTarget) {
      this._giBvhTarget = createGiBvhTarget(width, height);
      this._giBvhTargetSize = { width, height };
      this._giBvhReflectNode = texture(this._giBvhTarget.bvhReflect);
      this._giBvhColorNode = texture(this._giBvhTarget.bvhColor);
      this._giBvhRadianceNode = texture(this._giBvhTarget.bvhRadiance);
    }
    return {
      hit: this._giBvhTarget.bvhReflect,
      albedo: this._giBvhTarget.bvhColor,
      target: this._giBvhTarget.bvhRadiance,
    };
  }

  /**
   * (Re)builds the exact-reflection BVH scene from the SAME mesh list the
   * mesh-SDF atlas entries cover (baked + analytic — walls are just box
   * tris, so including them gives the BVH the whole static scene, not only
   * "real" meshes) and wires its output into `state.light.bvhReflectTexture`.
   *
   * Called both from a full `#rebuild()` (state.screen freshly built) and
   * from the incremental fingerprint-sync path (`#checkFingerprint`, mesh
   * add/remove without a full rebuild) — same logic either way, since BVH
   * rebuilds are compute-only (no material recompile), unlike the mesh-SDF
   * atlas capacity change that DOES sometimes force one. Needs
   * `state.screen` (the deferred resolve's gbuffer) to exist; exact
   * reflections are simply unavailable without it (matches the legacy
   * per-material GI fallback in `#buildScreenResolve`).
   */
  #syncBvhScene(entries) {
    const state = this.state;
    if (!state?.screen) return;
    const light = state.light;
    if (!this.#bvhReflectionsEnabled()) {
      // Retired, not disposed on the spot (see #retireTargets' own comment):
      // the albedo atlas (GI Phase 3 v2) is a real CanvasTexture that this
      // frame's already-dispatched BVH-reflect compute may still be reading
      // on the GPU — the SAME "Destroyed texture used in a submit" class the
      // resize path guards against. Before the atlas existed, `.dispose()`
      // here was JS-only (an array truncation) and synchronous disposal was
      // harmless; it no longer is.
      this.#retireTargets(state.bvhScene);
      state.bvhScene = null;
      state.screen.bvhReflect = null;
      if (light) {
        light.bvhReflectTexture = null;
        light.bvhReflectColorTexture = null;
        light.bvhReflectShaded = false;
      }
      return;
    }
    // Same retire-not-dispose reasoning as the branch above: this path
    // (mesh add/remove/material change with reflections staying enabled)
    // replaces `state.bvhScene` wholesale on the fingerprint-sync cadence,
    // without going through the disabled branch.
    this.#retireTargets(state.bvhScene);
    // DEDUPED: entries are per-placement now, so an InstancedMesh appears
    // once per instance. The BVH builder wants distinct meshes — feeding it
    // the same one 200 times would build 200 identical BLASes.
    const meshes = [...new Set(entries.map((entry) => entry.mesh))];
    const bvhScene = buildBvhScene(meshes);
    state.bvhScene = bvhScene;
    const { width, height } = state.screen;
    // Usually already created by #buildScreenResolve (the resolve has to bind
    // these to shade hits); this covers the incremental-sync path reaching
    // here first. Lazy + SYSTEM-lifetime either way — see #ensureBvhTargets.
    this.#ensureBvhTargets(width, height);
    if (!this._bvhCameraPosition) this._bvhCameraPosition = uniform(new THREE.Vector3());
    const { compute } = createGiBvhReflect({
      gbuffer: state.screen.gbuffer,
      target: this._giBvhTarget.bvhReflect,
      colorTarget: this._giBvhTarget.bvhColor,
      width,
      height,
      bvhScene,
      cameraPosition: this._bvhCameraPosition,
      normalOffset: light.normalOffset,
      maxDistance: light.mirrorRange ?? 24,
      mask: this.#bvhMaskEnabled(),
    });
    state.screen.bvhReflect = { compute, bvhScene };
    // The resolve pass shades hits when it was built with a `bvhShade` bundle
    // (see #buildScreenResolve) — that is the single source of truth for which
    // texture carries the value materials should read.
    const shaded = !!state.screen.bvhShade;
    if (light) {
      light.bvhReflectTexture = this._giBvhReflectNode;
      // WHICH texture the material samples for reflection colour, and what it
      // means, move together. Shaded: the resolve's radiance target, consumed
      // as-is. Unshaded: the prepass's raw albedo, which the consumer then has
      // to light with the wrong thing (its own irradiance — see giLight's use
      // site). Both are compile-time, and both are safe to switch here because
      // the flag is derived from the screen resolve, which only ever changes
      // on a rebuild.
      light.bvhReflectColorTexture = shaded ? this._giBvhRadianceNode : this._giBvhColorNode;
      light.bvhReflectShaded = shaded;
    }
    // Affirmative ground truth for users/harnesses: absence of this line
    // means exact reflections are NOT running, whatever else seems true
    // (quality gate, stale dev server, hatch) — added after a debugging
    // round where "is it even on?" was unanswerable from the console.
    console.log(
      `[gi] bvh: exact reflections ON — ${bvhScene.meshCount} meshes, ${bvhScene.triCount} tris` +
        (bvhScene.meshes.length < (state.entries?.length ?? 0) ? " (some meshes SDF-only via coverage flag)" : "") +
        (bvhScene.texturedCount > 0 ? ", textured atlas" : "") +
        (this.#bvhMaskEnabled() ? ", sparse (mirror-masked)" : ", DENSE (full-screen)") +
        (shaded ? ", hit-shaded" : ", albedo-only"),
    );
  }

  /**
   * Whether the exact-reflection prepass restricts itself to mirror pixels.
   * On by default — the dense arm exists only as the A/B for the harness and
   * as an escape hatch if a scene's mirror tagging ever proves wrong (the
   * failure mode would be a reflective surface whose material bucket the
   * collect walk didn't classify: it loses its exact reflection and falls
   * back to the cascade lookup, rather than rendering wrong).
   */
  #bvhMaskEnabled() {
    return globalThis.__giBvhMask === true;
  }

  /**
   * Old targets are destroyed a few frames LATE, never on the spot. A material
   * re-points at the new textures when its bind group is next refreshed, which
   * happens while the following frame is encoded — destroy the old pair before
   * that and the submit fails validation ("Destroyed texture used in a submit")
   * and GI blanks out. A few MB held for three frames is the cheap side of that
   * trade.
   */
  #retireTargets(targets) {
    if (targets) this._retiredTargets.push({ targets, ttl: RETIRED_TARGET_FRAMES });
  }

  #drainRetiredTargets() {
    if (this._retiredTargets.length === 0) return;
    const keep = [];
    for (const entry of this._retiredTargets) {
      if (--entry.ttl > 0 || globalThis.__giKeepRetiredTargets) keep.push(entry);
      else entry.targets.dispose();
    }
    this._retiredTargets = keep;
  }

  /** Resolve resolution: half the drawing buffer, clamped to a PIXEL budget. */
  #screenResolveSize() {
    const renderer = this.engine.renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const scale = this.config.resolveScale ?? 0.5;
    let width = Math.max(16, Math.round(size.x * scale));
    let height = Math.max(16, Math.round(size.y * scale));
    // TOTAL-PIXEL budget, not a per-axis clamp. Every screen-space GI pass
    // (gather resolve, the per-light shadow traces, AO) is per-RESOLVE-pixel
    // work, so cost rides the DRAWING BUFFER — canvas CSS size × monitor
    // devicePixelRatio — and a maximized 4K/150% viewport quietly quadruples
    // it (probe-measured: 9ms → 22ms GPU for 4× pixels; the user's "larger
    // screen - more ms, up to 70ms" panel readings are this line). The
    // position-validated bilateral upsample already reconstructs full-res
    // edges from the half-res channel, so capping the traced pixel count
    // trades penumbra/GI detail nobody resolves at 4K for a flat cost
    // ceiling. `resolveMaxPixels` prop / `__giResolveMaxPixels` override.
    const budget =
      Number(globalThis.__giResolveMaxPixels) ||
      this.config.resolveMaxPixels ||
      1_600_000;
    const px = width * height;
    if (px > budget) {
      const s = Math.sqrt(budget / px);
      width = Math.max(16, Math.round(width * s));
      height = Math.max(16, Math.round(height * s));
    }
    return { width: Math.min(4096, width), height: Math.min(4096, height) };
  }

  /**
   * The shadow channel's own resolution, derived from (and never exceeding)
   * the resolve's. Its trace is the most expensive per-pixel work in the
   * module (~5-7ns/px measured), and the material-side bilateral validates
   * every tap against the full-res gbuffer position — so its pixel count is
   * a nearly-free cost knob. The shipped budget is 1.9M px (a 1440p viewport
   * never reaches it; big monitors stop paying quadratically for penumbras).
   * `lightShadowMaxPixels` prop — declared on the component since 2026-08-07,
   * before which this fallback was the only value it could ever have — or
   * `__giShadowResolvePixels` to override it without touching the scene.
   */
  #lightShadowSize(resolve) {
    const budget =
      Number(globalThis.__giShadowResolvePixels) ||
      this.config.lightShadowMaxPixels ||
      1_900_000;
    let { width, height } = resolve;
    const px = width * height;
    if (px > budget) {
      const s = Math.sqrt(budget / px);
      width = Math.max(16, Math.round(width * s));
      height = Math.max(16, Math.round(height * s));
    }
    return { width, height };
  }

  /**
   * Tracks each material's COMPILE-TIME roughness bucket (mirror path /
   * directional path / diffuse-only — see giLight's gate constants). A
   * static-roughness edit that crosses a gate needs that one material
   * recompiled, or e.g. a wall dialed down to roughness 0.1 would never
   * show mirror reflections.
   */
  #refreshMirrorBucket(material) {
    if (!material) return;
    const bucket = giRoughnessBucketOf(material);
    const previous = this._mirrorBuckets.get(material);
    if (previous !== undefined && previous !== bucket) {
      material.needsUpdate = true;
      // ── THE OTHER HALF OF `#hasReflectionConsumer`'s RAMP ──────────────────
      //
      // A material moving INTO bucket 0/3 is the moment a scene starts wanting
      // exact reflections. The gate is evaluated at BUILD time, so noticing the
      // change here and doing nothing would leave reflections off until some
      // unrelated edit happened to trigger a rebuild — "I made it a mirror and
      // nothing happened", which is worse than the compile it is avoiding.
      //
      // Only 0→consumer flips it. Leaving the bucket needs no rebuild: the
      // prepass is already built and simply stops having a reader, which costs
      // one dispatch and no correctness.
      const nowConsumer = bucket === 0 || bucket === 3;
      const wasConsumer = previous === 0 || previous === 3;
      if (nowConsumer && !wasConsumer && !this.#hasReflectionConsumer()) {
        this._reflectionConsumerAppeared = true;
      }
    }
    this._mirrorBuckets.set(material, bucket);
  }

  /**
   * One-shot occupancy readback once the field's geometry has actually landed on
   * the GPU (log + harness signal).
   *
   * The count now comes from the OCCUPANCY PYRAMID rather than from the deleted
   * composite's stats buffer, and it is a voxel count rather than a cell count —
   * the pyramid is the only geometry representation left, so this is the same
   * question asked of the thing that answers it. The emissive-cell count is gone
   * with the composite that produced it (nothing injects radiance into a field
   * during the interregnum).
   *
   * THE LINE ITSELF IS A HARNESS CONTRACT, not just a log: probes gate their
   * measurement on having seen it, because a readback taken before the pyramid is
   * filled reports a plausible wrong number rather than failing (measured 1 run in
   * 4 — see run-gi-emitter-shadow-probe.mjs). Renaming it means updating them.
   */
  /**
   * SRC probe telemetry (plan §8: ships with Phase 1 and is permanent).
   *
   * Rate-limited and NON-BLOCKING: `readSrcProbeStats` is a buffer readback, so
   * awaiting it inside the frame loop would stall the submit it is measuring.
   * The in-flight guard matters more than the frame interval — without it a
   * readback that takes longer than the interval queues another every frame and
   * the telemetry becomes the cost it is reporting.
   *
   * The numbers land on `this._srcProbeStats` for `profile.giPasses` and the
   * MCP surface to read (R17), and on the console under `__giLogSrcProbes` for
   * a person watching a scene change.
   */
  #maybeLogSrcProbeStats(renderer, state) {
    const src = state.screen?.srcProbes;
    if (!src || this._srcStatsPending) return;
    const every = Number(globalThis.__giSrcProbeStatsEvery) || 60;
    if (this._frame % every !== 0) return;
    this._srcStatsPending = true;
    src.readStats(renderer).then((stats) => {
      this._srcStatsPending = false;
      // A rebuild between the request and its resolution retires these numbers.
      if (this.state !== state || state.screen?.srcProbes !== src) return;
      this._srcProbeStats = stats;
      if (globalThis.__giLogSrcProbes) console.log(formatSrcProbeFrame(stats));
      // UNCONDITIONAL WARNINGS, because these are the two failures that are
      // silent on screen. A dropped insert is a probe that does not exist —
      // a dark patch that moves with the camera — and a load factor past 0.7
      // is linear probing on the way to dropping them.
      for (const c of stats.cascades) {
        if (c.failed > 0) {
          console.warn(
            `[gi] src probes: cascade ${c.cascade} dropped ${c.failed} inserts ` +
            `(${c.live}/${c.probeCapacity} probes, load ${c.loadFactor.toFixed(2)}) — ` +
            "raise the probe capacity or s0; those probes simply do not exist",
          );
        } else if (c.loadFactor > 0.7 && !this._srcLoadWarned) {
          this._srcLoadWarned = true;
          console.warn(
            `[gi] src probes: cascade ${c.cascade} hash load ${c.loadFactor.toFixed(2)} ` +
            `(mean probe length ${c.meanProbeSteps.toFixed(1)}) — open addressing ` +
            "degrades sharply past here, and drops follow",
          );
        }
      }
    }, (error) => {
      this._srcStatsPending = false;
      console.warn("[gi] src probe stats readback failed:", error?.message ?? error);
    });
  }

  #maybeLogStats(renderer) {
    const state = this.state;
    if (!state || state.statsLogged || !state.entries.length) return;
    const resident = state.atlas.assignments.filter(Boolean).length;
    if (resident < Math.min(state.entries.length, state.atlas.capacity)) return;
    const occ = state.volume.occupancyField;
    if (!occ?.readbackStats) return;
    state.statsLogged = true;
    occ.readbackStats(renderer).then((stats) => {
      if (this.state === state) {
        console.log(`[gi] field ready: ${stats.occupiedVoxels} occupied voxels`);
      }
    });
    // SURFACE-RECORD POOL AUDIT — starvation here is otherwise invisible: the
    // boot log says `marcher records` while a contiguous macro-order slab of
    // the scene silently degrades to occupied-box hits and full-voxel square
    // silhouettes (the Sponza-ultra bug: demand 1.24M vs the old 1M cap).
    const occField = state.volume.occupancyField;
    if (occField?.hasSurfaceRecords && occField.readbackSurfaceAlloc) {
      occField.readbackSurfaceAlloc(renderer).then((alloc) => {
        if (this.state !== state || !alloc) return;
        const line = `[gi] surface records: ${alloc.allocated}/${alloc.capacity} claimed` +
          `, triangles ${alloc.triangles}/${alloc.triangleCapacity}` +
          `, dynamic tail ${alloc.dynamicAllocated}/${alloc.dynamicCapacity}`;
        // TWO DIFFERENT degradations, two different remedies — do not conflate:
        // pool starvation (claims denied → whole bricks boxed; the capacity is
        // wrong) vs the per-cell exact-triangle cap (a dense cell exceeds
        // MAX_COMPLEX_TRIANGLES and is boxed by design; capacity is fine).
        if (alloc.overflowBricks > 0) {
          console.warn(
            `${line} — POOL STARVED: ${alloc.overflowBricks} bricks degraded to voxel-box ` +
              `hits (square silhouettes there). The record pool is undersized for this scene.`,
          );
        } else if (alloc.complexOverflowCells > 0) {
          console.log(
            `${line} — ${alloc.complexOverflowCells} dense cells exceed the per-cell ` +
              `exact-triangle limit and keep voxel-box hits (localized square silhouettes ` +
              `on dense trim/foliage).`,
          );
        } else {
          console.log(line);
        }
        // The dynamic tail describes the LAST chain only (its cursor resets
        // every dispatch), so at boot this is usually 0/0 — the warn matters
        // when a large mover was live during the audited frame.
        if (alloc.dynamicOverflowBricks > 0) {
          console.warn(
            `[gi] dynamic record tail STARVED: ${alloc.dynamicOverflowBricks} mover bricks ` +
              `degraded to voxel-box hits this chain (${alloc.dynamicAllocated}/` +
              `${alloc.dynamicCapacity} claimed). Raise dynamicSurfaceRecordCapacity.`,
          );
        }
      });
    }
  }

  #rebuild() {
    this.#dispose();
    const component = this.component;
    const engine = this.engine;
    if (!component || !engine.scene) return;

    const props = this.config;
    const rayHitConfig = resolveRayHitConfig(props);
    const meshes = this.#collectMeshes();

    // Volume placement: manual (entity-centered, size props) or AUTO-FIT —
    // bounds wrap the GI-relevant scene content with headroom, and voxel/
    // probe densities are derived from fixed budgets so any world size stays
    // performant (bigger world → coarser field, same cost).
    const center = new THREE.Vector3();
    // THE DEGENERATE FALLBACK, and it is now the only reason a size literal
    // exists in this module. Auto-fit is unconditional (giConfig's CONSTANT
    // block), so `sceneAabb` is null only when there is no GI-relevant geometry
    // at all — an empty scene, or one whose every mesh is excluded. The manual
    // `sizeX/sizeY/sizeZ` properties that used to supply these are gone; left
    // undefined they would make `half` NaN and the bounds with it, which is a
    // silent way to build a volume that contains nothing.
    // `??`, not a bare constant: the manual-volume path is unreachable from a
    // scene (auto-fit is a constant `true`) but stays reachable from the
    // measurement hatch, which `run-gi-bvh-reflect` needs — it sizes an 8x7x8
    // volume by hand to guarantee the lamp is inside it.
    let sizeX = props.sizeX ?? FALLBACK_VOLUME.x;
    let sizeY = props.sizeY ?? FALLBACK_VOLUME.y;
    let sizeZ = props.sizeZ ?? FALLBACK_VOLUME.z;
    const autoFit = props.autoFit === true;
    // Entity-authored bounds first; whole-scene AABB only as a fallback for
    // a component sitting on a bare entity in an unstructured scene.
    const sceneAabb = autoFit ? (this.#autoFitAabb() ?? this.#sceneAabb(meshes)) : null;
    let fit = null;
    if (sceneAabb) {
      fit = this.#fitBoundsFor(sceneAabb);
      center.copy(fit.center);
      sizeX = fit.sizeX;
      sizeY = fit.sizeY;
      sizeZ = fit.sizeZ;
    } else {
      component.entity.object3D.getWorldPosition(center);
    }
    // Lattice-snapped fits carry their exact faces — recomputing them from
    // centre ± size/2 would reintroduce float drift into the snap.
    const half = new THREE.Vector3(sizeX / 2, sizeY / 2, sizeZ / 2);
    const bounds = fit
      ? { min: fit.min.clone(), max: fit.max.clone() }
      : { min: center.clone().sub(half), max: center.clone().add(half) };

    // Both are overwritten from the quality budget in the auto-fit branch
    // below; these are the same degenerate-scene fallbacks the old
    // `voxelSize`/`probeSpacing` properties used to default to.
    let voxelSize = Math.max(0.05, props.voxelSize || 0.3);
    let probeSpacing = Math.max(0.25, props.probeSpacing || 1.25);
    let c0Grid;
    let res;
    if (autoFit) {
      // ZERO-SETUP MODE: quality preset → budgets; voxel/probe density is
      // fully derived from the fitted volume (the manual size/voxel/probe
      // fields are ignored). Bigger world at the same preset = coarser
      // field, same cost.
      const budget = QUALITY_BUDGETS[qualityTierOf(props)];
      const maxAxis = Math.max(sizeX, sizeY, sizeZ);
      const volumeSize = sizeX * sizeY * sizeZ;
      // The fit already chose (and snapped the bounds to) the probe spacing.
      probeSpacing = fit.probeSpacing;
      c0Grid = {
        x: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.x)),
        y: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.y)),
        z: Math.min(MAX_PROBE_AXIS, Math.max(2, fit.probeCounts.z)),
      };
      // The occupancy grid keeps its own budget-derived cell size. Making it
      // an integer subdivision of the probe spacing was tried and reverted:
      // it bought no stability (a refit recomposites the whole field from
      // the slot SDFs anyway) and the rounding threw away up to a fifth of
      // the voxel budget.
      voxelSize = Math.min(
        1.5,
        Math.max(0.05, maxAxis / MAX_AXIS_RES, Math.cbrt(volumeSize / budget.cells)),
      );
      res = {
        x: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeX / voxelSize))),
        y: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeY / voxelSize))),
        z: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeZ / voxelSize))),
      };
    } else {
      res = {
        x: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeX / voxelSize))),
        y: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeY / voxelSize))),
        z: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(sizeZ / voxelSize))),
      };
      c0Grid = {
        x: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeX / probeSpacing))),
        y: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeY / probeSpacing))),
        z: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(sizeZ / probeSpacing))),
      };
    }

    if (res.x * res.y * res.z > 1_500_000) {
      console.warn(
        `[gi] ${res.x}x${res.y}x${res.z} cells is heavy (ray-march steps scale with 1/voxelSize). ` +
          `For a ${sizeX.toFixed(0)}m volume, voxelSize ~${(sizeX / 100).toFixed(2)} is usually plenty.`,
      );
    }
    const t0 = performance.now();
    // Per-quality trace budgets — the fixed 56/64-step traces at every
    // preset were why "medium" still cost ~20ms GPU at editor resolutions.
    // (`feedback`, `feedbackEmitter` and `feedbackEmitterMacro` went with the
    // bounce feedback pass and its per-emitter march; their measured ladders are
    // in plan §12.9 because the emitter one cost 0.73ms per live emitter and is
    // the number Phase 1-3 has to budget against.)
    const quality = qualityTierOf(props);
    // `mirror` was already dead before this cut — the material-side mirror trace
    // has been null since reflections became deferred — so only the emitter
    // shadow trace's budget is left here.
    const traceBudget =
      { low: { shadow: 24 }, medium: { shadow: 32 }, high: { shadow: 44 }, ultra: { shadow: 56 } }[quality]
      ?? { shadow: 44 };

    // ONE SLOT PER WORLD PLACEMENT, and that is the whole sizing calculation
    // now. The TILE half is gone: there is no atlas texture, so there are no
    // 64³ tiles to pack, no 2x2x2 hi-res blocks to keep an aligned region free
    // for, no per-quality detail budget, and no tile-vs-instance capacity to
    // reconcile. (That packing arithmetic existed for a real bug — singles
    // allocated from the tail fragmented every block-aligned region, so a
    // hi-res grant could never seat, and the editor spun seat → overflow →
    // rebuild → identical packing forever. Nothing can reproduce it without a
    // texture to pack.)
    let placements = 0;
    for (const mesh of meshes) placements += this.#placementsOf(mesh).length;
    const atlas = new SlotRegistry(instanceCapacityFor(placements));
    // (The CPU point-sampled occupancy PROTOTYPE that used to be buildable
    // here — `triangleOcclusion` opt-in, occupancyGrid.js — was deleted
    // 2026-08-02 with the bake pipeline it depended on. The SAT-conservative
    // pyramid below is its successor and the only occupancy. giField carried a
    // vestigial `occupancy: null` argument for it right up to its own deletion.)
    // THE OCCUPANCY BACKEND (spec phases 1+4) — since 2026-08-02 the ONLY
    // transport backend; the `backend` prop and the legacy SDF sphere trace it
    // selected are gone. Built here for the same reason the prototype above is
    // (this is where the mesh list lives) and BEFORE the volume, because the
    // composite graph and every trace close over it. Null only means the
    // explicit diagnostic backend hatch disabled occupancy.
    const occField = this.#buildOccupancyField(
      props, meshes, bounds, { sizeX, sizeY, sizeZ }, quality, rayHitConfig,
    );
    if (!occField) {
      console.warn("[gi] occupancy was disabled by the diagnostic backend hatch; GI has no geometry transport");
    }
    // THE VOLUME IS NOW `srcVolume`, and `giField.js` is gone with it (§12.8.2).
    // What changed underneath this one line: the composited fp16 distance texture,
    // the six per-cell radiance/surface buffers, the instance grid, the sparse
    // brick page table and the composite pass that filled them all. What did NOT
    // change is the answer any survivor gets — §12.6 established that the
    // composited `distanceTexture` WAS `freeRadiusAtWorld` resampled onto the
    // coarse lattice and quantized, so both shadow factories have been reading the
    // oracle directly (through giField's own delegation) since 2026-08-09. This
    // removes the resample, not the source.
    //
    // `res` is passed, not `res: null`: the two lattices measure 3.61x apart at the
    // shipping presets, every tuned constant in the shadow estimators is expressed
    // in coarse-cell units, and switching lattice and producer in one commit would
    // make an eye-check unattributable. `res: null` is a separate A/B (§12.6.5).
    const volume = createSrcVolume({
      occField,
      bounds,
      res,
      rayHitMode: rayHitConfig.activeMode,
    });
    // Entries + slot assignment + emitter promotion + SDF load-or-bake.
    const entries = this.#buildEntries(meshes);

    // Per-frame analytic direct light: fixed uniform slots. Light moves/edits
    // update uniforms only, so no kernel gains a binding and nothing rebuilds.
    // Read by the screen resolve, the GI-traced light shadows and the mover
    // occluder set; the transport's own readers went with it.
    const lightSlots = makeLightSlots();
    // Emitter slots (promoted emissive meshes) are shared by the material light
    // node (receiver direct + shadows + mirror glow) and the screen-side emitter
    // shadow pass, and refreshed EVERY FRAME.
    const emitterSlots =
      props.emissiveShadows !== false
        ? Array.from({ length: MAX_EMITTERS }, () => ({
            center: uniform(new THREE.Vector3()),
            radius: uniform(0),
            color: uniform(new THREE.Color(0, 0, 0)),
            // Slot SHAPE (see giLight emitterSlotFactor): kind 0 = sphere,
            // 1 = oriented box, 2 = capsule, 3 = cylinder, 4 = frustum/cone,
            // 5 = disc/ring, 6 = torus (fitted per frame by
            // emitterShapes.js fitEmitterShape — `half` semantics per kind
            // documented there; `by` is every shaped kind's symmetry axis).
            // reff = mean-projected-area-equivalent radius (angular size for
            // penumbra k and glow energy). radius stays the bounding
            // sphere — trace self-exclusion and the active gate. exHalf =
            // the conservative OBB the sphere-arm marchers exclude (a
            // torus's spans ring+tube; a disc's is its thin plate).
            kind: uniform(0),
            half: uniform(new THREE.Vector3(0.1, 0.1, 0.1)),
            bx: uniform(new THREE.Vector3(1, 0, 0)),
            by: uniform(new THREE.Vector3(0, 1, 0)),
            bz: uniform(new THREE.Vector3(0, 0, 1)),
            reff: uniform(0),
            exHalf: uniform(new THREE.Vector3(0.1, 0.1, 0.1)),
            // 1 while this emitter is MOVING (translating or turning), decaying
            // over a few frames at rest. The feedback pass cuts its history
            // retain per cell by the moving emitters' share of that cell's
            // light — a moving lamp's pool follows it instead of trailing a
            // ~20-frame EMA wake, while statically-lit cells keep full
            // smoothing (see createBounceFeedback's emitter-motion cut).
            moved: uniform(0),
          }))
        : null;
    // ══ THE DIFFUSE TRANSPORT USED TO BE BUILT HERE ═══════════════════════════
    //
    // createRadianceCascades → createCascadeMerge → createProbeIrradiance +
    // createProbeDepthMoments → createIrradianceGather → createBounceFeedback:
    // ~420 lines of construction, deleted with the SRC rebuild's §12.8 unit
    // (`docs/GI_SRC_REBUILD_PLAN.md`). Split Radiance Cascades replaces it in
    // Phase 1-3. Every tuned constant, preset ladder and `__gi*` A/B hatch that
    // lived in those lines is transcribed into plan §12.9 — they were measured,
    // several of them against user-reported artifacts, and re-deriving them is
    // strictly more expensive than reading them.
    //
    // ── THE PARKED UNIFORMS ──────────────────────────────────────────────────
    // These six survived the cut with NO consumer, and the rule they follow is
    // "authored props stay, mechanism goes". Each one is written by
    // #applyLiveProps from an Inspector prop that is saved into the user's
    // scene, and each is mixed into #fieldInputHash; deleting them means
    // deleting those writes, the schema entries and the serialized values, then
    // restoring all three in Phase 1-3 against an authored default that has
    // meanwhile drifted. The transport's MECHANISM uniforms went the other way
    // and are gone outright: `normalLift`, `fieldShadowOff`, `shadowJitter`,
    // `dynShadeAmbient`, `feedbackParity`, `traceParity`, `intervals` and the
    // field width probe all addressed one deleted kernel each and had no
    // authored surface to preserve.
    //
    // A parked uniform is inert, not lying: with the whole diffuse term absent
    // there is no reading of "Bounce Energy 0.5" that these could satisfy and
    // do not.
    const skyRadiance = uniform(new THREE.Color(0, 0, 0));
    const probeSmoothing = uniform(clampProbeSmoothing(props.probeSmoothing));
    const bounceGain = uniform(Math.min(1, Math.max(0, props.bounce ?? 1)));
    const bleedSaturation = uniform(Math.min(1, Math.max(0, props.bleedSaturation ?? 1)));
    const temporalBlend = uniform(Math.min(1, Math.max(0.02, props.temporalBlend ?? 0.25)));
    const fieldSmoothing = uniform(globalThis.__giFieldSmoothing ?? 0.95);
    // NOT parked — `diagU` is the volume diagonal every SURVIVING world-scale
    // reach is derived from (mirror range, emitter shadow range, the GI-traced
    // light shadow span) and the refit rescales it. A uniform, not a number,
    // for exactly that reason: a baked one pins part of the old volume.
    const diagU = uniform(Math.hypot(sizeX, sizeY, sizeZ));
    // THE GATHER IS NULL, and the screen chain is built to survive that
    // (§12.8.1): giLight's deferred path keys off `giIrradianceNode` rather than
    // `gatherFn`, and `createGiResolve` compiles its diffuse term — and the AO
    // ladder that modulates it — out entirely instead of multiplying by zero.
    const gather = null;

    // THE FRAME QUEUE. Three arrays with IDENTICAL contents during the
    // interregnum, and the reason they are not one array is #syncScreenResolveSize:
    // a resolve-scale change or a viewport resize rebuilds each screen compute
    // and swaps the new node into all three queues BY INDEX, at roughly 25 call
    // sites. Collapsing the triplet here means rewriting that path now and
    // rewriting it back when Phase 1-3 gives the three queues different contents
    // (the feedback/transport ping-pong is what they exist to express).
    //
    // The transport pushed a feedback compute, one trace per cascade, the merge
    // chain, the probe integral and the depth moments in front of the screen
    // chain, plus the `queueMarks` the `__giFreeze` bisect cut on and the
    // per-probe average computes the probe gizmos read. All of it is gone; the
    // screen passes are appended below, in an order the resolve depends on.
    const queue = [];
    const queueNoFeedback = [];
    const queueFeedbackOnly = [];
    const feedbackEveryFrame = true;

    // LIGHT REUSE — this is what makes rebuilds cheap.
    //
    // Historically a FRESH light instance was created per rebuild on purpose:
    // materials evaluated the gather themselves, so they had to be recompiled
    // against the new cascade buffers, and the lights-hash change is what
    // forced that. With the deferred resolve, a material's GI code is "sample
    // these two persistent textures" — nothing in it depends on the rebuilt
    // buffers — so reusing the light keeps the lights hash stable and NO
    // material is invalidated. A quality change or an auto-fit refit then
    // costs one compute rebuild instead of a full material recompile wave.
    //
    // Reflections are deferred as well: materials only sample persistent
    // screen textures and never capture cascade/SDF/BVH buffers directly.
    // A fresh light is still required for the first-build lights-hash commit;
    // subsequent in-place refits retain the existing instance.
    const light = new GICascadeLight();
    light.gatherFn = gather;
    // World-scale light params are uniform-derived NODES (giLight composes
    // them into node math either way) so an in-place refit rescales them.
    // NORMAL OFFSET — how far every gather/trace origin is lifted off the
    // shading surface, along the normal, so a probe/ray does not immediately
    // hit the surface it started on. `cellMax·1.2` rides the voxel lattice, but
    // the `.max(0.1)` FLOOR does not: below a 0.083m cell the lift is a fixed
    // 0.1m regardless of either lattice, and it displaces the gather point of
    // EVERY pixel by that constant. Hatched 2026-08-07 for the ~0.196m
    // block-size hunt (measured: 0.196 + 0.14·probeSpacing in x, with the
    // voxelSize dial inert) — a fixed-metre displacement of the sample point is
    // the other way a fixed-width footprint gets into the picture.
    // `__giNormalOffsetFloor` (0.1, metres) and `__giNormalOffsetScale` (1.2,
    // × the largest world cell) are read at BUILD time and default to exactly
    // the shipped expression. Zero is the interesting ablation for both, so
    // they go through Number.isFinite instead of `Number(...) || DEFAULT`.
    const rawOffsetScale = Number(globalThis.__giNormalOffsetScale);
    const offsetScale = Number.isFinite(rawOffsetScale) ? rawOffsetScale : 1.2;
    const rawOffsetFloor = Number(globalThis.__giNormalOffsetFloor);
    const offsetFloor = Number.isFinite(rawOffsetFloor) ? rawOffsetFloor : 0.1;
    light.normalOffset = volume.world.cellMax.mul(offsetScale).max(offsetFloor);
    // THE DIRECTIONAL RADIANCE LOOKUP WAS A CASCADE READER (createRadianceLookup,
    // cascade 2's rays resampled per screen pixel) and went with them. So GI
    // reflections keep only their EXACT arm: a BVH hit shaded from the shared
    // colour texture, which is what a mirror actually shows. Rough/glossy
    // surfaces lose their blurred environment term until Phase 1-3, i.e. they
    // fall back to the same "no diffuse indirect" the rest of the module is in —
    // NOT to the old "flat irradiance" approximation, which is also gone.
    let deferredRadianceLookup = null;
    if (props.reflections !== false) {
      light.approximateReflections = false;
      light.radianceFn = null;
      light.radianceSharpFn = null;
      light.radianceRoughFn = null;
      // Exact hits are now shaded from the shared BVH color texture in
      // GICascadeLightNode. Do not inject an SDF trace or hit reconstruction
      // into mirror materials: that was a 39s compile wave on the 262k-tri
      // Sponza scene and duplicated work already done by the screen pass.
      light.mirrorTraceFn = null;
      light.hitLighting = false;
      light.mirrorSampleFn = null;
      light.hitSurfaceFn = null;
      light.mirrorShadowFn = null;
      light.lightSlots = null;
      // Ray reach scales with the volume (clamped: step cap bounds cost).
      light.mirrorRange = diagU.clamp(8, 48);
    }
    if (emitterSlots) {
      // Pass the exact ray-origin lift — the trace's self-plane exclusion
      // compares field distances against lift + t·cos and needs the real value.
      // Used only by the resolve compute (four call sites, one per emitter
      // slot) — a layout collapses those four inlined 56-step loops into one
      // function, which is what keeps this SYNCHRONOUSLY compiled compute
      // pipeline small enough not to freeze a frame on rebuild.
      // Stable estimator here too (same reasoning as the gi-light trace in
      // #buildLightShadow): the emitter cones' binary admissions painted
      // lattice-phase moiré across floors the moment Emissive Shadows was
      // re-enabled on a real scene.
      light.shadowTraceFn = volume.createSoftShadowTrace(light.normalOffset, traceBudget.shadow, "giResolveShadowTrace", true);
      light.shadowMargin = volume.world.cellMax.mul(2.5).max(0.2);
      // Shadow reach must cover the whole volume: any receiver inside the
      // cap-but-unshadowed band takes emitter light THROUGH walls.
      light.shadowRange = diagU.clamp(12, 64);
      light.emitterSlots = emitterSlots;
    }
    // Indirect-light ambient occlusion (giScreen's obscurance ladder). The
    // uniforms are live (aoStrength/aoRadius edit without a rebuild); the
    // `ao` prop itself is structural — off compiles the block out entirely.
    const ao =
      props.ao !== false && volume.occupancyField
        ? {
            occupancy: volume.occupancyField,
            strength: uniform(Math.min(1, Math.max(0, props.aoStrength ?? 0.6))),
            radius: uniform(Math.min(3, Math.max(0.1, props.aoRadius ?? 0.6))),
          }
        : null;
    // DEFERRED RESOLVE: evaluate the gather + emitter shadows once per screen
    // pixel instead of inside every material (see giScreen.js). This is what
    // keeps material shaders small — the driver compile of a 200kB+ GI
    // fragment shader, once per material, was the whole startup cost.
    // GI-traced direct shadows for lights flagged `shadowMode: "gi"` (see
    // #buildLightShadow for the two binding gates). NOT structural: the bundle
    // compiles the per-slot cone unconditionally and each slot's `giShadow`
    // uniform decides per frame whether it marches, so flipping a light's
    // Shadow Source is a uniform write, never a GI rebuild.
    const lightShadow = this.#buildLightShadow({
      volume,
      lightSlots,
      quality,
      hasEmitterTrace: !!light.shadowTraceFn,
      span: diagU,
    });
    const screen = this.#buildScreenResolve({
      gather, light, emitterSlots, radianceLookup: deferredRadianceLookup, ao, lightShadow,
      // The punctual light slots. `#buildScreenResolve` has always destructured
      // them (`lightSlots = null`) and the caller never passed them, so SRC's hit
      // shading came up with `0 lights` on a scene the field log calls "1 lights
      // (GPU)" — and `bvhShade.lightSlots`, in the same function, has been
      // reading the same null.
      lightSlots,
      // The SlotRegistry, for SRC's surface-attribution palette (§12.28). It is
      // the SAME registry the voxelizer seated, which is what makes the palette
      // indexable by occupancy slot with no remap — §12.9's crossed-numbering
      // bug was exactly a second numbering being introduced here.
      atlas,
      // SRC traces against the SAME medium every other ray class in this build
      // uses — that is the whole reason `srcTrace.js` is an extraction of the
      // occupancy marcher rather than a second one.
      volume,
      // The scene's authored Sky Light, which lost its consumer when the dense
      // transport died (§12.8) and gets one back in unit 4: SRC's c0-only resolve
      // composites it where a bin's transmittance survived. Default intensity is
      // 0, so a project that never touched it still renders exactly as it did.
      skyRadiance,
      emitterRecordTrace: emitterSlots ? this.#buildEmitterRecordTrace(volume, quality) : null,
      // EMITTER REACH PER PRESET. Falloff is 1/d², so the pixels that pay for
      // an emitter's shadow march scale as 1/cutoff — this is the dominant
      // dial on a pass the user measured at 77% of all per-frame GI screen
      // work. Measured on the heavy rig (3 emitters, 570x277, 90k tris):
      // 0.0015 -> 0.868ms, 0.006 -> 0.434ms (max pixel deviation 8/255,
      // brightness -0.04%), 0.02 -> 0.183ms (max 17/255 on 0.09% of
      // subpixels, brightness -0.13%). High takes the 2x that costs nothing
      // visible; low/medium trade a fading pool fringe for another 2.4x;
      // ultra keeps essentially the old reach.
      emitterCutoff:
        { low: 0.02, medium: 0.012, high: 0.006, ultra: 0.002 }[quality] ?? 0.006,
    });
    if (screen) {
      // ── NAME EVERY PASS'S COMPUTE NODE (§13.14.8) ────────────────────────
      //
      // The pipeline timing reads these via giCurrentComputeNode, which is how
      // `[gi] SLOWEST PIPELINE` finally says WHICH pass instead of an index.
      // Five sessions failed to attribute one kernel because the shadow
      // estimator family shares a WGSL fingerprint; a name at the dispatch
      // site is immune to that.
      for (const [key, bundle] of Object.entries(screen)) {
        if (bundle?.compute?.isNode ?? bundle?.compute) bundle.compute.__giPassName = key;
      }
      screen.srcProbes?.passes?.forEach((p, i) => {
        if (p && typeof p === "object") p.__giPassName ??= `src#${i}`;
      });
      // Emitter shadow trace + filter FIRST — the resolve samples their
      // output texture in the same frame.
      if (screen.emitterShadowPass) {
        // trace -> filter(+history) -> [history snapshot -> post], the same
        // order the analytic arm uses below. History snapshots the ACCUMULATED
        // signal before the post filter reads it; both read accum, so the pair
        // is order-independent, but keeping the two arms identical is worth more
        // than the freedom.
        const emitterChain = [screen.emitterShadowPass.compute, screen.emitterShadowFilterPass.compute];
        if (screen.emitterShadowHistoryPass) emitterChain.push(screen.emitterShadowHistoryPass.compute);
        if (screen.emitterShadowPostPass) emitterChain.push(screen.emitterShadowPostPass.compute);
        queue.push(...emitterChain);
        queueNoFeedback.push(...emitterChain);
        queueFeedbackOnly.push(...emitterChain);
      }
      queue.push(screen.resolve.compute);
      queueNoFeedback.push(screen.resolve.compute);
      // The resolve is camera-dependent, so it runs on BOTH halves of the
      // split — it is 0.1ms and skipping it would stall GI against camera
      // motion, which is the one thing measurement says is currently free.
      queueFeedbackOnly.push(screen.resolve.compute);
      // The shadow pass is camera-dependent the same way (it reads the
      // per-frame gbuffer), so it rides every half too.
      if (screen.lightShadowPass) {
        queue.push(screen.lightShadowPass.compute);
        queueNoFeedback.push(screen.lightShadowPass.compute);
        queueFeedbackOnly.push(screen.lightShadowPass.compute);
      }
      if (screen.lightShadowFilterPass) {
        queue.push(screen.lightShadowFilterPass.compute);
        queueNoFeedback.push(screen.lightShadowFilterPass.compute);
        queueFeedbackOnly.push(screen.lightShadowFilterPass.compute);
      }
      if (screen.lightShadowWidePass) {
        queue.push(screen.lightShadowWidePass.compute, screen.lightShadowWidePass2.compute);
        queueNoFeedback.push(screen.lightShadowWidePass.compute, screen.lightShadowWidePass2.compute);
        queueFeedbackOnly.push(screen.lightShadowWidePass.compute, screen.lightShadowWidePass2.compute);
      }
      if (screen.lightShadowHistoryPass) {
        queue.push(screen.lightShadowHistoryPass.compute);
        queueNoFeedback.push(screen.lightShadowHistoryPass.compute);
        queueFeedbackOnly.push(screen.lightShadowHistoryPass.compute);
      }
      if (screen.lightShadowPostPass) {
        queue.push(screen.lightShadowPostPass.compute);
        queueNoFeedback.push(screen.lightShadowPostPass.compute);
        queueFeedbackOnly.push(screen.lightShadowPostPass.compute);
      }
    }
    // Purge three's lights-hash memo — without this the FIRST build of a
    // session renders with the GI light silently inert (see #purgeLightsHashMemo).
    this.#purgeLightsHashMemo();
    // NOTE: the old delayed second purge (10 ticks post-build) is GONE — it
    // re-keyed every material AFTER the compile wave finished and triggered
    // a second, SYNCHRONOUS compile wave (harness-measured +8s freeze). The
    // purge-at-add above plus the wave (which compiles against the fresh
    // hash) covers the lights-hash memo bug on their own.
    this._lightsRefreshTicks = 0;

    // NAMES FOR THE QUEUE. `profile.giPasses` reports each entry's GPU cost,
    // and an unlabelled array of 20 numbers cannot answer "which pass owns the
    // frame" — which is the only question anyone profiles this module to ask.
    // Built by identity after assembly rather than at each push site, so the
    // ordering logic above stays one concern.
    const queueLabel = new Map();
    for (const [name, entry] of Object.entries(screen ?? {})) {
      if (entry?.compute) queueLabel.set(entry.compute, name);
    }
    const queueLabels = queue.map((node, i) => queueLabel.get(node) ?? `queue[${i}]`);

    // The two SURVIVING debug views. `raw`/`merged` — instanced spheres at every
    // c0 probe, coloured by that probe's average radiance — went with the probes
    // they read (#buildGizmos is gone, and so are the `debugProbes` options that
    // selected them; see the component schema).
    const gizmos = { all: [] };
    gizmos.sdfView = this.#buildSdfView(volume, bounds, center);
    if (gizmos.sdfView) gizmos.all.push(gizmos.sdfView);
    gizmos.occView = this.#buildOccupancyView(volume, bounds, center);
    if (gizmos.occView) gizmos.all.push(gizmos.occView);
    for (const mesh of gizmos.all) engine.scene.add(mesh);

    this.state = {
      volume,
      // The scene's authored Sky Light, which lost its consumer when the dense
      // transport died (§12.8) and gets one back in unit 4: SRC's c0-only resolve
      // composites it where a bin's transmittance survived. Default intensity is
      // 0, so a project that never touched it still renders exactly as it did.
      skyRadiance,
      atlas,
      diagU,
      queue,
      queueLabels,
      queueNoFeedback,
      queueFeedbackOnly,
      feedbackEveryFrame,
      light,
      gizmos,
      entries,
      bounds,
      center,
      // Size the grid resolution was derived from. An in-place refit KEEPS
      // this size (it only slides the volume), so it is also the live size —
      // a rebuild is what changes it.
      screen,
      // Exact-reflection BVH scene (GI Phase 3 v1) — populated just below by
      // `#syncBvhScene(entries)`, null until then / when disabled.
      bvhScene: null,
      buildSize: new THREE.Vector3(sizeX, sizeY, sizeZ),
      // The probe-spacing rung this build was laid out on — the lattice an
      // in-place slide snaps to. A stretch rescales it.
      probeSpacing,
      c0Grid,
      bounceGain,
      bleedSaturation,
      temporalBlend,
      probeSmoothing,
      fieldSmoothing,
      skyRadiance,
      autoFit,
      lightSlots,
      emitterSlots,
      statsLogged: false,
      rayHitConfig,
    };
    this._atlasRevisionSeen = -1; // force a first composite
    this._occGeometrySeen = -1;
    this._fieldReadyOnce = false;
    this._pendingFit = null; // refit debounce restarts against fresh bounds
    this.#syncSlots(entries);
    this.#syncBvhScene(entries);
    this._lightObjects = this.#collectLightObjects();
    this.#updateLightUniforms();
    this._structuralSig = this.#structuralSignature(component);
    this._fingerprint = this.#computeFingerprint(meshes);
    this.#applyLiveProps();
    this.#applyDebugVisibility();
    // Fill the pipeline cache ASYNCHRONOUSLY before the render loop touches
    // the new lights state: without this, the next render() sync-compiled
    // every material's pipeline in one frame — a 20-30s hard freeze on real
    // scenes (the init / config-change / refit hang reports). Must run
    // AFTER this.state is assigned (the wave prewarms the compute queue).
    this.#compileWave();
    const resident = atlas.assignments.filter(Boolean).length;
    const analyticCount = atlas.assignments.filter((a) => a?.analytic).length;
    if (autoFit && this._boundsSource) {
      console.log(
        `[gi] auto-fit bounds from ${this._boundsSource} (${analyticCount} analytic / ${resident - analyticCount} baked slots)`,
      );
    }
    console.log(
      `[gi] built (voxel-free): ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m` +
        `${autoFit ? ` (auto-fit ${props.quality ?? "high"}, voxel ${voxelSize.toFixed(2)}, probes ${probeSpacing.toFixed(2)})` : ""}, ` +
        `${res.x}x${res.y}x${res.z} cells, c0 ${c0Grid.x}x${c0Grid.y}x${c0Grid.z} (probe lattice, NOT traced), ` +
        `${meshes.length} meshes / ${entries.length} placements → ` +
        `${atlas.capacity} slots (${resident} resident, ${entries.length - resident} pending), ` +
        `${this._lightObjects.length} lights (GPU), ${this._emitterInfos?.length ?? 0} emitters, ` +
        `setup ${(performance.now() - t0).toFixed(0)}ms`,
    );
    if (volume.occupancyField) {
      console.log(`[gi] occupancy backend: ${describeOccupancyField(volume.occupancyField)}`);
    }
    // AFFIRMATIVE GROUND TRUTH FOR THE DIFFUSE TERM, and it is the most
    // important line this build prints. Without it the interregnum is
    // indistinguishable from every failure mode this module has ever had — a
    // stale `backend` value, an empty field, a light that never registered — all
    // of which present as "GI builds, logs happily, contributes no bounce".
    //
    // IT USED TO SAY "ABSENT" UNCONDITIONALLY, which quietly cost it that job:
    // once SRC's transport landed (Phases 1-4) the line went on reporting that
    // "bounce, sky and every other diffuse term read ZERO" whether or not the
    // transport was running, so the one instrument for "is this expected?"
    // could no longer tell the two states apart. There are THREE now, and only
    // the last of them is a picture with light in it.
    // ⚠ AND IT WENT STALE AGAIN THE MOMENT PHASE 5 LANDED. Both of the
    // transport-on branches below were written when `shadeHit` was null and
    // both assert, in so many words, that GI produces no light — one of them
    // calls a lit diffuse term "correctly black". The user read that line
    // while looking at a frame the eye check measures at 3.879× the sky-only
    // one. **A diagnostic that describes a state the code has left is worse
    // than no diagnostic**, because it is trusted: it is the thing you consult
    // to decide whether what you are seeing is expected. The shading branch is
    // now the FIRST test, so the message tracks the build instead of the plan.
    const sky = skyRadiance.value;
    const skyLit = Math.max(sky.r, sky.g, sky.b) > 0;
    // ⚠ CONSULT THE BUILT SYSTEM, NOT THE FLAGS. `srcShadeEnabled()` says what
    // was ASKED FOR; `screen.srcProbes.shading` says what was BUILT — and they
    // part ways whenever the socket declines (no surface records at this
    // ray-hit mode, attribution threw, no lighting bundle). The first version
    // of this branch read the flags and printed "LIVE AND SHADED" over a
    // sky-only transport — a diagnostic describing a state the code had left,
    // found by the smoke's tile assertion reading E 0..0 underneath it.
    const builtShading = screen?.srcProbes?.shading ?? null;
    if (srcProbesEnabled() && builtShading) {
      console.log(
        "[gi] diffuse indirect: LIVE AND SHADED — SRC transport is running with Phase 5 hit " +
          `shading, so hits carry albedo, sun, lights and emission. Sky Light is ` +
          `${skyLit ? `${sky.r.toFixed(2)}/${sky.g.toFixed(2)}/${sky.b.toFixed(2)}` : "0"}` +
          (skyLit
            ? "."
            : " — the scene has NO environment, so every photon here comes from a lamp and " +
              "ONE bounce. That is a legal but very dark setup: shadowed regions have no fill " +
              "at all, which reads as crushed blacks next to a blown sunlit strip. Give the " +
              "scene an environment (Scene → Environment) to get sky fill."),
      );
    } else if (srcProbesEnabled() && srcShadeEnabled() && screen?.srcProbes) {
      console.log(
        "[gi] diffuse indirect: LIVE, SHADING UNAVAILABLE — SRC transport is running but the " +
          "hit-shading socket was not built: static attribution needs SURFACE RECORDS, which " +
          "this ray-hit mode does not create (hybrid-plane and above do), or the attribution/" +
          "lighting bundle failed above (a warning names it). Radiance is sky-only" +
          (skyLit ? "." : ", and Sky Light is 0 — so the diffuse term is correctly black."),
      );
    } else if (!srcProbesEnabled()) {
      console.log(
        "[gi] diffuse indirect: ABSENT — this build is OPTED OUT of Split Radiance Cascades " +
          "(`__giSrcProbes = false`; it is ON by default since Phase 5). Direct light, " +
          "GI/emitter shadows, AO and exact reflections are live; bounce, sky and every other " +
          "diffuse term read ZERO. Expected under the opt-out, not a broken field — remove the " +
          "flag before the GI module builds to get the transport back.",
      );
    } else if (!skyLit) {
      console.log(
        "[gi] diffuse indirect: LIVE BUT UNLIT — SRC transport is running, hit shading is OFF " +
          "(`__giSrcShade = false`), and the only radiance left is the scene's Sky Light, which " +
          "is 0. So the diffuse term is correctly black. Turn hit shading back on, or raise Sky " +
          "Light above zero. ⚠ Note that probes-without-shading REPLACES the diffuse term with a " +
          "sky-only one (plan §12.30.1) — at Sky Light 0 that is a BLACK SCENE, measured at 4% of " +
          "pixels lit against 68% with shading on.",
      );
    } else {
      console.log(
        "[gi] diffuse indirect: SKY VISIBILITY ONLY — SRC transport is running against Sky Light " +
          `${sky.r.toFixed(2)}/${sky.g.toFixed(2)}/${sky.b.toFixed(2)}, with hit shading OFF ` +
          "(`__giSrcShade = false`). Every deposited radiance is zero, so what you are seeing is " +
          "how much sky each point can see over the whole cascade reach — long-range, AO-shaped " +
          "darkening with NO bounce colour. A Cornell box with no red on the white block is the " +
          "correct picture for this arm.",
      );
    }
    // Affirmative ground truth for the gi-shadow feature, same discipline as
    // the ray-hit and SDF-free lines below: "I set Shadow Source to gi and
    // nothing changed" is unreadable without knowing whether the resolve even
    // built the trace, and at what step budget.
    console.log(
      screen?.lightShadow
        ? `[gi] light shadows: gi-traced ON, marcher ${screen.lightShadow.marcher} (${quality}), ` +
            // BUILD MARKER (2026-08-06 session 31c): "adaptive-σ" printed =
            // the angle-adaptive filter build is what's actually running.
            // Three rounds of "absolutely nothing changed" were spent unable
            // to tell the user's live editor apart from the disk code — this
            // token settles it from their own console.
            // BUILD MARKER, session 33: same discipline as "adaptive-σ" above.
            // Three separate rounds were lost to not knowing whether the live
            // editor ran the disk code, so every arm that changes what a
            // shadow ray DOES prints a token here.
            (screen.lightShadow.exactArm
              ? `exact-bias ${screen.lightShadow.exactBiasFactor?.value ?? "?"}vox, ` +
                `${globalThis.__giShadowAnyHit === false ? "nearest-hit" : "any-hit"}, ` +
                `${screen.lightShadow.freeRadius ? "burial-gate ON" : "no burial gate"}, `
              : "") +
            `filter adaptive-σ, up to ${MAX_GI_LIGHTS} lights — flag a light with Shadow Source "gi"`
        : "[gi] light shadows: gi-traced OFF — every light renders its own shadow map",
    );
    if (screen?.emitter) {
      console.log(
        `[gi] emitter shadows: ${screen.emitter.recordShadowTrace ? "record-march + analytic-width" : "sphere-trace"} (resolve side)`,
      );
    }
    console.log(
      `[gi] ray-hit: requested ${rayHitConfig.autoMode ? `auto→${rayHitModeName(rayHitConfig.requestedMode)}` : rayHitModeName(rayHitConfig.requestedMode)}, ` +
        `active ${rayHitModeName(rayHitConfig.activeMode)}, profiling ${rayHitConfig.enableProfiling ? "ON" : "off"}` +
        // Printed for the same reason the branch factor is: "I set the A/B
        // global and nothing changed" is unreadable without the ground truth.
        `, skip ${rayHitConfig.enableSkipDistance !== false ? "ON" : "off"}` +
        (rayHitConfig.fallbackToLegacy ? " (requested phase not implemented; legacy fallback)" : ""),
    );
    if (!volume.occupancyField) {
      console.warn("[gi] no occupancy field — nothing supplies distance, so GI has no geometry at all");
    }
    // WATERTIGHTNESS CHECK. The composited field gives thin geometry ONE
    // occupancy shell per side so a wall's lit face and its shadowed face
    // never mix (see cascadeGather's ONE-SIDED notes). That needs at least
    // ~2 cells across the wall. Thinner than that and the two faces collapse
    // into the SAME cell: the sunlit outside and the dark inside become one
    // value, and the interior lights up as if the wall were not there. It
    // reads exactly like "light leaks through walls" — dim, tinted by each
    // surface's own albedo, and completely unresponsive to probe density,
    // because it is a CELL SIZE problem, not a probe problem.
    //
    // Sponza at a 42.9x19.8x27.5m auto-fit gets 0.34m cells, and most of its
    // enclosure is thinner than 0.68m — the whole building is transparent to
    // GI and nothing in the logs said so. Say it, with the number to change.
    // The LARGEST cell axis: an axis clamped by MAX_AXIS_RES has coarser
    // cells than `voxelSize` asked for, and the coarsest axis is the one that
    // decides whether a wall survives.
    const cellSize = Math.max(sizeX / res.x, sizeY / res.y, sizeZ / res.z, 1e-6);
    const thinNames = [];
    let thinCount = 0;
    const thinBox = new THREE.Box3();
    const thinSize = new THREE.Vector3();
    for (const mesh of meshes) {
      if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox?.();
      if (!mesh.geometry?.boundingBox) continue;
      thinBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      thinBox.getSize(thinSize);
      // Thinnest axis of the world-space box — a wall/curtain/panel's depth.
      if (Math.min(thinSize.x, thinSize.y, thinSize.z) < cellSize * 2) {
        thinCount++;
        if (thinNames.length < 6) thinNames.push(mesh.name || "mesh");
      }
    }
    if (thinCount > 0) {
      console.warn(
        `[gi] ${thinCount} of ${meshes.length} meshes are thinner than 2 GI cells (${(cellSize * 2).toFixed(2)}m at voxel ${cellSize.toFixed(2)}m)` +
          `${thinNames.length ? ` — e.g. ${thinNames.join(", ")}` : ""}. ` +
          `The field cannot keep their two faces apart, so they do NOT block light: expect indirect to pass straight through them ` +
          `(a lit exterior wall will light the room behind it). Fix by shrinking the GI volume (currently ` +
          `${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m — smaller volume, same budget, finer cells), raising Quality, ` +
          `or turning Auto Fit off and setting a tighter size around the room that actually needs GI.`,
      );
    }
    // COVERAGE CHECK. Everything outside the volume is invisible to GI:
    // receivers out there get no probes (dark floors), and mirror rays leave
    // the field within a step or two and MISS, so reflective materials fall
    // back to the blurry cascade average and read as flat washed-out white.
    // Both look like "GI is broken" rather than "the volume is too small",
    // so say it plainly with the numbers.
    const sceneBox = this.#sceneAabb(meshes);
    if (sceneBox) {
      const sceneSize = new THREE.Vector3().subVectors(sceneBox.max, sceneBox.min);
      const sceneVolume = Math.max(1e-6, sceneSize.x * sceneSize.y * sceneSize.z);
      const covered = sizeX * sizeY * sizeZ;
      if (covered < sceneVolume * 0.35) {
        console.warn(
          `[gi] volume covers only ${((covered / sceneVolume) * 100).toFixed(0)}% of the scene content ` +
            `(GI ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m vs content ` +
            `${sceneSize.x.toFixed(1)}x${sceneSize.y.toFixed(1)}x${sceneSize.z.toFixed(1)}m). ` +
            `Geometry outside it receives NO GI and reflections there miss (metals read flat white). ` +
            `Move the Global Illumination component onto the entity that contains the room, or turn Auto Fit off and set the size manually.`,
        );
      }
    }
    // PROBE DENSITY. The quality presets are total probe BUDGETS, so the
    // world-space spacing follows the volume's size: a room modelled at 10×
    // scale gets 10× coarser probes for the same preset. Indirect light is
    // interpolated between them, so a coarse lattice reads as concentric
    // rings around bright emissives.
    if (autoFit && probeSpacing > 0.5) {
      console.info(
        `[gi] probe spacing is ${probeSpacing.toFixed(2)}m (volume ${sizeX.toFixed(1)}x${sizeY.toFixed(1)}x${sizeZ.toFixed(1)}m at "${props.quality ?? "high"}") — ` +
          `indirect light is interpolated between probes this far apart, which shows as concentric rings/bands around bright emissives. ` +
          `Raise Quality, or build the scene at a smaller world scale (a 20m room needs 4x the probes of a 5m one for the same look).`,
      );
    }
    // Compile-cost breakdown: buckets 3 + 0 are the expensive shader variants.
    const bt = this._bucketTally ?? [0, 0, 0, 0];
    console.log(
      `[gi] material GI buckets: ${bt[0]} mirror, ${bt[1]} specular, ${bt[2]} diffuse-only, ${bt[3]} dynamic-roughness` +
        ` (mirror + dynamic = the expensive shaders; ${bt[0] + bt[3]}/${bt[0] + bt[1] + bt[2] + bt[3]})`,
    );
  }

  /**
   * Copies the scene's analytic lights into the feedback pass's uniform
   * slots — runs EVERY frame, so moving/re-colored lights update the field
   * with zero rebakes (matching the reference's per-frame sun evaluation).
   * The light LIST is refreshed at fingerprint cadence; positions/colors
   * are read live off the cached objects here.
   */
  /**
   * Order-sensitive numeric digest of every FIELD input that can change
   * without a composite: analytic light slots, emitter slots, sky radiance,
   * and the live field knobs. Bit-identical hash across frames ⇒ the
   * feedback/trace/merge/probe passes would recompute exactly what they
   * already hold ⇒ safe to idle (see GI_IDLE_AFTER_FRAMES). Runs AFTER
   * #updateLightUniforms/#refreshEmitterSlots each tick, so it digests what
   * the GPU is actually about to read. Cheap: ~100 muls on plain numbers.
   */
  #fieldInputHash() {
    const state = this.state;
    if (!state) return 0;
    let h = 0;
    let k = 1;
    const mix = (v) => {
      // Golden-ratio spread keeps permuted values from cancelling.
      k = (k * 1.6180339887) % 1024;
      h += v * (k + 1);
    };
    for (const slot of state.lightSlots ?? []) {
      mix(slot.active.value);
      if (slot.active.value < 0.5) continue;
      mix(slot.kind.value);
      const v = slot.vector.value;
      mix(v.x); mix(v.y); mix(v.z);
      const c = slot.color.value;
      mix(c.r); mix(c.g); mix(c.b);
      mix(slot.range.value);
      // The field's own shadow k is derived from this (cascadeGather's
      // per-slot angle), so dragging a sun's Angle slider has to WAKE the
      // pipeline — otherwise the change lands only after something else
      // happens to disturb the scene. `srcRadius`/`giShadow` are deliberately
      // absent: they steer only the screen resolve, which runs every frame
      // regardless of whether the field is asleep.
      mix(slot.soft.value);
    }
    for (const slot of state.emitterSlots ?? []) {
      mix(slot.radius.value);
      if (slot.radius.value <= 0.001) continue;
      const p = slot.center.value;
      mix(p.x); mix(p.y); mix(p.z);
      const c = slot.color.value;
      mix(c.r); mix(c.g); mix(c.b);
      mix(slot.kind.value);
      const half = slot.half.value;
      mix(half.x); mix(half.y); mix(half.z);
      // Axes too: a shaped lamp (kind ≥ 2) that spins in place keeps center
      // AND half constant — the axes are the only signal its light moved.
      // (The box panel woke the field by accident: a rotating OBB's world
      // extents change. A cylinder's don't.)
      const bx = slot.bx.value, by = slot.by.value;
      mix(bx.x); mix(bx.y); mix(bx.z);
      mix(by.x); mix(by.y); mix(by.z);
    }
    const sky = state.skyRadiance?.value;
    if (sky) { mix(sky.r); mix(sky.g); mix(sky.b); }
    mix(state.bounceGain?.value ?? 0);
    // Exact dynamic objects: their transforms are invisible to every other
    // signal here (no atlas bump, no occupancy revision — that is the whole
    // point), so their version keeps the pipeline awake while one rotates
    // and lets it sleep when they rest.
    mix(this._dynSet?.version ?? 0);
    mix(state.temporalBlend?.value ?? 0);
    mix(state.probeSmoothing?.value ?? 0);
    mix(state.fieldSmoothing?.value ?? 0);
    // (The transport's module-level uniforms were mixed here too — the gather
    // biases, the probe-snap and depth-moment alphas, the field shadow hatch and
    // the sun-jitter cone. They are gone; the parked props above stay in the
    // digest so that editing one still WAKES the pipeline, which is what makes
    // the idle heuristic's shape survive Phase 1-3 unchanged.)
    return h;
  }

  #updateLightUniforms() {
    const state = this.state;
    if (!state?.lightSlots) return;
    // `__giFreezeLightInput` — the bisect that separates the only two things
    // left once every lighting TERM has been ruled out (bounce 0, shadows
    // forced open, probe smoothing off, zero composites, zero resizes):
    //   · GI's INPUT jitters — the light direction it reads differs frame to
    //     frame from the one three renders with, so a perfectly smooth GI
    //     oscillates because its argument does.
    //   · GI is NONDETERMINISTIC — same input, different output, i.e. a
    //     read/write hazard between the compute dispatches (the feedback pass
    //     writes `radianceBuffer` while the cascade traces read it, all inside
    //     one submit).
    // Freezing these uniforms holds GI's input EXACTLY constant while three's
    // own direct lighting keeps following the light. GI's contribution then
    // stops responding to the light — expected, ignore it. If it still
    // flickers, the input is innocent and it is a hazard.
    if (globalThis.__giFreezeLightInput && this._lightInputFrozen) return;
    this._lightInputFrozen = !!globalThis.__giFreezeLightInput;
    const lights = this._lightObjects ?? [];
    if (lights.length > MAX_GI_LIGHTS && !this._warnedLightBudget) {
      this._warnedLightBudget = true;
      console.warn(`[gi] ${lights.length} analytic lights; GPU direct covers the first ${MAX_GI_LIGHTS}`);
    }
    for (let i = 0; i < state.lightSlots.length; i++) {
      const slot = state.lightSlots[i];
      const light = lights[i];
      // Checked LIVE (not just at collect cadence) so switching a light off
      // darkens the field the same frame — and via isRenderVisible, so
      // disabling the light's ENTITY counts as off too (see its comment).
      if (!light || !isRenderVisible(light) || light.intensity <= 0) {
        slot.active.value = 0;
        // Cleared alongside, so an off/hidden light stops paying for a
        // whole-screen shadow march the moment it goes dark rather than on
        // the next light-list scan. Its channel then writes the inert 1.
        slot.giShadow.value = 0;
        continue;
      }
      slot.active.value = 1;
      if (light.isDirectionalLight) {
        slot.kind.value = 1;
        light.updateWorldMatrix(true, false);
        light.target.updateWorldMatrix(true, false);
        const from = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
        const direction = to.sub(from);
        if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0);
        // Stored TOWARD the light (the shader marches shadow rays that way).
        slot.vector.value.copy(direction.normalize().negate());
      } else {
        slot.kind.value = 0;
        light.getWorldPosition(slot.vector.value);
      }
      slot.range.value = light.isPointLight ? Math.max(0, light.distance || 0) : 0;
      slot.color.value.copy(light.color).multiplyScalar(light.intensity);
      // ── THE GI SHADOW CONTRACT (LightComponent's userData, nothing else) ──
      // Read fresh every frame: the contract is republished on every relevant
      // prop change and this module deliberately never imports LightComponent,
      // so the userData IS the handshake. Absent flags simply read as "map".
      const wantsGi = light.userData?.giShadowMode === "gi" && !!state.screen?.lightShadow;
      slot.giShadow.value = wantsGi ? 1 : 0;
      // ONLY GI-FLAGGED LIGHTS PUBLISH THEIR SIZE. `soft`/`srcRadius` at 0
      // mean "unset", and every consumer falls back to the global sun angle
      // there — which is how a scene that never opted in keeps byte-identical
      // field shadows (see cascadeGather's per-slot k). Angles arrive as a
      // half-angle in radians already (LightComponent halves the authored
      // diameter); 0.0046 rad ≈ the real sun's 0.53° disc, the default a
      // flagged light gets if the contract ever omits the field.
      // FLOORED AT THE REAL SUN (0.0046 rad ≈ 0.53°), not at 0: an authored
      // angle of 0 reaches the resolve as its 0.0005 clamp floor → k = 2000 —
      // a razor ray through a ~12cm-voxel medium, whose verdict flips per
      // voxel-lattice phase and paints white-speckle dithering along every
      // silhouette (harness caught the scene's sun publishing exactly 0).
      // No physical sun is sharper than the real one, so the floor is honest.
      slot.soft.value = wantsGi && light.isDirectionalLight
        ? Math.max(0.0046, light.userData.giSourceAngle ?? 0.0046)
        : 0;
      slot.srcRadius.value = wantsGi && !light.isDirectionalLight
        ? Math.max(0, light.userData.giSourceRadius ?? 0)
        : 0;
    }
    this.#syncLightShadowNodes(lights);
    this.#logLightInput();
  }

  /**
   * Hands every gi-flagged light a persistent `shadow.shadowNode` that samples
   * its channel of the resolve's `lightShadow` texture. three's
   * AnalyticLightNode multiplies the light by whatever sits in that slot AND
   * renders no shadow map for it — the same hook LightComponent's CSM uses, so
   * a gi light costs zero map passes.
   *
   * THREE INVARIANTS, each of them a bug that was paid for once:
   *
   *  · THE NODE IS BUILT ONCE PER LIGHT AND ASSIGNED ONLY WHEN IT CHANGES.
   *    Re-assigning churns the light's shadow branch, and a changed shadow
   *    branch means a material recompile wave — the exact cost this whole
   *    deferred architecture exists to avoid.
   *  · IT IS INERT AT 1, NEVER AT 0. GI absent, disabled, mid-rebuild, slot
   *    dark — all of them must leave the light fully lit. A shadow term that
   *    fails to black is a scene that goes black.
   *  · THE CHANNEL IS A UNIFORM MASK, NOT A BAKED SWIZZLE. Slot indices follow
   *    the collected light list, which reshuffles whenever a light is added,
   *    hidden or dimmed; baking `.x`/`.y` into the node would mean rebuilding
   *    (and recompiling) it on every reshuffle. A dot against a vec4 mask makes
   *    the same change a uniform write.
   */
  #syncLightShadowNodes(lights) {
    const state = this.state;
    const nodes = (this._lightShadowNodes ??= new Map());
    const live = !!state?.screen?.lightShadow && !!this._giLightShadowNode;
    // PCSS inputs, refreshed per frame: the shadow span (world → normalized
    // blocker distances), and the projection scale that turns a world-space
    // penumbra width into a screenUV radius (1 / (2·tan(fov/2))).
    if (live) {
      // `span` is the bundle's diagU — a per-build UNIFORM NODE, not a
      // number. The persistent sampler uniform must copy its NUMERIC value:
      // assigning the node itself makes getNodeUniform choke on type "node"
      // in every material's shadow branch compile.
      const span = state.screen.lightShadow.span;
      if (this._giShadowSpanU) {
        this._giShadowSpanU.value = typeof span === "number" ? span : span?.value ?? 1;
      }
      const cam = this.engine.camera;
      if (this._giShadowFovScaleU && cam?.isPerspectiveCamera) {
        this._giShadowFovScaleU.value = 1 / (2 * Math.tan((cam.fov * Math.PI) / 360));
      }
    }
    // Slot index === channel index === index into the collected light list, by
    // construction — the resolve writes channel i from lightSlots[i], and
    // lightSlots[i] is fed by lights[i] in the loop above.
    const claimed = new Set();
    // Sharpest claimed angle drives the filter's spatial σ (see the
    // angle-adaptive note in createGiLightShadowFilterPass). 5° half-angle
    // and up = the full historical kernel.
    let maxClaimedAngle = 0;
    // Hard-capped at the target's four channels. A slot past the 4th would get
    // an all-zero mask, and an all-zero mask dots to 0 — i.e. a fully BLACK
    // light rather than an unshadowed one. Bounding the loop is the guard.
    const channels = Math.min(4, state?.lightSlots?.length ?? 0);
    for (let i = 0; live && i < channels; i++) {
      const light = lights[i];
      if (!light?.shadow || light.userData?.giShadowMode !== "gi") continue;
      claimed.add(light);
      maxClaimedAngle = Math.max(maxClaimedAngle, light.userData?.giSourceAngle ?? 0);
      const entry = this.#acquireLightShadowNode(light);
      entry.mask.value.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0);
      // PCSS blur strength = tan of the source HALF-angle (giSourceAngle is
      // already the half-angle in radians). Directional-only for now — a
      // point light's penumbra scales by srcRadius/dist per pixel, a later
      // refinement. Capped at 60°-half so tan stays sane; NOT the cone
      // estimator's 0.35 clamp — softness beyond it comes from this blur.
      if (entry.blurTan) {
        entry.blurTan.value = light.isDirectionalLight
          ? Math.tan(Math.min(light.userData.giSourceAngle ?? 0.0046, Math.PI / 3))
          : 0;
      }
      // Inert unless the slot is genuinely being traced this frame: a hidden
      // or zero-intensity light keeps its (unwritten) channel, and reading it
      // would shadow with whatever the last live light left there.
      entry.active.value = state.lightSlots[i].giShadow.value > 0.5 ? 1 : 0;
    }
    // Everything else this system ever claimed: either it lost gi mode, or it
    // left the scene. Both hand the light back to three's own shadow maps.
    // A light that is merely HIDDEN or DIMMED is deliberately not in here —
    // it keeps its node at active 0, so toggling visibility costs a uniform
    // write instead of two shadow-branch rebuilds.
    for (const [light, entry] of nodes) {
      if (claimed.has(light)) continue;
      const gone = light.parent === null || light.userData?.giShadowMode !== "gi";
      if (!gone && live) {
        entry.active.value = 0;
        continue;
      }
      this.#releaseLightShadowNode(light, entry);
      nodes.delete(light);
    }
    // Filter σ from the sharpest claimed light (0 = razor → despeckle-only;
    // ≥5° half-angle → the historical σ1.6). No claimed lights → leave the
    // uniform wherever it is; nothing samples the channel then.
    if (this._giShadowSoftnessU && claimed.size) {
      this._giShadowSoftnessU.value = Math.min(1, maxClaimedAngle / 0.0873);
    }
    // Counted over the WHOLE collected list, not the channels above: the point
    // of the warning is precisely the lights that fell off the end.
    const asked = live ? lights.filter((l) => l?.userData?.giShadowMode === "gi").length : 0;
    if (asked > channels && !this._warnedLightShadowCount) {
      this._warnedLightShadowCount = true;
      console.warn(
        `[gi] ${asked} lights ask for gi-traced shadows; only the first ${channels} light slots carry a shadow ` +
          "channel — the rest keep their shadow maps.",
      );
    }
  }

  #acquireLightShadowNode(light) {
    const existing = this._lightShadowNodes.get(light);
    if (existing) return existing;
    const active = uniform(0);
    const mask = uniform(new THREE.Vector4(1, 0, 0, 0));
    // POSITION-VALIDATED BILATERAL UPSAMPLE. The resolve runs at HALF RES,
    // and a silhouette texel's gbuffer P/N belong to whichever surface won
    // the half-res rasterization — its traced value is right for THAT
    // surface and garbage for the neighbor a plain bilinear upsample smears
    // it onto. For a SUN shadow that error is a bright dotted rim on every
    // dark silhouette (the user's "white artifacts"). v1 was a blind min
    // over the 4 taps — right direction (a multiplicative shadow term must
    // err DARK), but dots survived wherever ALL four taps traced a
    // different surface. v2 checks each tap against the gbuffer POSITION at
    // that texel: taps whose world position disagrees with the receiving
    // pixel's own `positionWorld` by more than ~2 half-res texels' world
    // footprint (2% of view distance, floored at 15cm) are REJECTED; the
    // valid taps blend distance-weighted (that is the bilateral), and a
    // pixel whose whole 2×2 neighborhood belongs to other surfaces — a
    // sub-texel-thin banner edge — falls back to the MIN of the taps, dark
    // by policy. The position texture is NearestFilter, so tap validity is
    // per-texel exact, never interpolated across the very edges it guards.
    const texel = (this._giLightShadowTexel ??= uniform(new THREE.Vector2(1 / 512, 1 / 512)));
    const viewDist = positionWorld.sub(cameraPosition).length().toVar();
    const threshold = viewDist.mul(0.02).max(0.15);
    // ── SHARP BASE: the position-validated bilateral upsample (unchanged) ──
    const innerTaps = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([dx, dy]) => {
      const uv = screenUV.add(vec2(texel).mul(vec2(dx, dy)));
      const s = this._giLightShadowNode.sample(uv).dot(vec4(mask));
      const g = this._giShadowPosNode.sample(uv);
      const d = g.xyz.sub(positionWorld).length();
      const w = select(g.w.greaterThan(0.5).and(d.lessThan(threshold)), float(1).div(d.add(0.02)), float(0));
      return { s, w };
    });
    const wSum = innerTaps.reduce((acc, t) => acc.add(t.w), float(0));
    const sBlend = innerTaps.reduce((acc, t) => acc.add(t.s.mul(t.w)), float(0)).div(wSum.max(1e-4));
    // NO-VALID-TAP FALLBACK IS ZERO, not min-of-taps. When every tap belongs
    // to some OTHER surface (thin features, object silhouettes — a spinning
    // prop in front of a shadowed arch), min-of-foreign is only dark if the
    // foreign surface happens to be dark: a SUNLIT foreground painted its
    // full-lit values as a white fringe onto every shadowed silhouette
    // behind it (user screenshot, the exact "still there" dots). A shadow
    // term with no information must fail DARK; the cost is a half-res-thin
    // darkened halo where lit meets lit, which reads as contact shading.
    const sharp = select(wSum.greaterThan(1e-4), sBlend, float(0)).toVar();
    // ── PCSS SOFT DISC (v2 — v1's artifacts were both kernel bugs) ──────
    // Blender sun semantics: penumbra width = tan(source half-angle) ×
    // blocker distance, which the resolve wrote per pixel (the march's own
    // occluder distance — no blocker search estimate needed). v1 ghosted
    // the occluder into 8 shifted copies (an UNROTATED sparse disc is a
    // multi-exposure, not a blur) and mottled on floors (its euclidean tap
    // validation rejects same-plane taps, whose lateral distance is ~the
    // radius by definition). v2: a per-pixel IGN-rotated 12-tap golden
    // spiral — rotation turns undersampling into noise, which reads as
    // softness — with validity measured as distance from the RECEIVER'S
    // PLANE (in-plane taps pass at any radius; cross-silhouette taps fail),
    // plus a small 4-tap max blocker search so the penumbra extends OUTSIDE
    // the geometric shadow instead of clipping at its edge.
    const spanU = (this._giShadowSpanU ??= uniform(1));
    const fovScaleU = (this._giShadowFovScaleU ??= uniform(1.2));
    const blurTan = uniform(0);
    let shadow = sharp;
    if (this._giLightShadowDistNode) {
      // INSIDE A Fn(), NON-NEGOTIABLY (2026-08-06, user's console caught it):
      // this assembly runs at NODE-BUILD time from #rebuild — there is no
      // active TSL stack here, so the accumulator `addAssign`es below emitted
      // "No stack defined for assign operation" and were ORPHANED: softW
      // stayed 0, the select always fell back to `sharp`, and the whole PCSS
      // disc was dead code from the day it shipped (the "still a hard edge
      // at 90°" reports were partly this). Fn() gives the statements a stack;
      // the closure is built lazily inside the material's own shader build.
      shadow = Fn(() => {
        const distAt = (uv) => this._giLightShadowDistNode.sample(uv).dot(vec4(mask));
        const t3 = vec2(texel).mul(3).toVar();
        const blockerNorm = distAt(screenUV)
          .max(distAt(screenUV.add(vec2(t3.x, 0))))
          .max(distAt(screenUV.sub(vec2(t3.x, 0))))
          .max(distAt(screenUV.add(vec2(0, t3.y))))
          .max(distAt(screenUV.sub(vec2(0, t3.y))))
          .toVar();
        const penumbraW = blockerNorm.mul(spanU).mul(blurTan).toVar();
        // World width → screenUV fraction: w·fovScale/viewDist, capped at 24
        // half-res texels so a 90° sun cannot blur across the whole frame.
        const radiusUv = penumbraW.mul(fovScaleU).div(viewDist.max(0.05))
          .min(vec2(texel).y.mul(24)).toVar();
        // Interleaved gradient noise → per-pixel spiral rotation.
        const rotA = fract(
          fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715)))
            .mul(52.9829189),
        ).mul(Math.PI * 2).toVar();
        const softW = float(0).toVar();
        const softSum = float(0).toVar();
        const N = normalWorld.toVar();
        for (let k = 0; k < 12; k++) {
          const r = radiusUv.mul(Math.sqrt((k + 0.5) / 12));
          const a = rotA.add(k * 2.399963);
          const uv = screenUV.add(vec2(cos(a), sin(a)).mul(r));
          const s = this._giLightShadowNode.sample(uv).dot(vec4(mask));
          const g = this._giShadowPosNode.sample(uv);
          const rel = g.xyz.sub(positionWorld);
          // Plane-distance validity: |N·rel| small keeps same-surface taps at
          // any lateral distance; the lateral-scaled slack tolerates curvature.
          const planeD = N.dot(rel).abs();
          const lateral = rel.length();
          const ok = g.w.greaterThan(0.5).and(planeD.lessThan(lateral.mul(0.2).add(0.15)));
          softW.addAssign(select(ok, float(1), float(0)));
          softSum.addAssign(select(ok, s, float(0)));
        }
        const soft = select(softW.greaterThan(0.5), softSum.div(softW.max(1)), sharp);
        // Sub-texel radii keep the sharp bilateral bit-exact; the disc fades
        // in as the penumbra grows past a couple of half-res texels.
        const softness = smoothstep(
          vec2(texel).y.mul(0.75),
          vec2(texel).y.mul(3),
          radiusUv,
        );
        return mix(sharp, soft, softness);
      })();
    }
    const entry = {
      active,
      mask,
      blurTan,
      node: mix(float(1), shadow, active),
    };
    this._lightShadowNodes.set(light, entry);
    light.shadow.shadowNode = entry.node;
    light.shadow.needsUpdate = true;
    // AnalyticLightNode CACHES the composed shadow branch (`shadowColorNode`)
    // on the light node and only rebuilds it when the light dispatches
    // 'dispose' — its hash is just the light's uuid, so neither a new
    // shadowNode nor a lights-hash purge would ever be noticed. This is the
    // same call LightComponent makes when it swaps a CSM node for the same
    // reason. Fires once per light per transition, not per frame.
    light.dispose?.();
    return entry;
  }

  /** Hands a light back to three's own shadow maps (see #syncLightShadowNodes). */
  #releaseLightShadowNode(light, entry) {
    entry.active.value = 0;
    // `undefined`, not null: three tests `shadow.shadowNode !== undefined` to
    // decide whether a custom node overrides the map lookup, so null would
    // leave the light with a shadow branch of literal null.
    //
    // EXCEPT for a light still FLAGGED gi (system disposed under it): its
    // component froze `shadow.autoUpdate` with a never-rendered map, and a
    // castShadow light with neither map nor custom node crashes three's
    // `updateShadow` (`shadow.map.depthTexture` on null). Hand it the same
    // inert 1 LightComponent boots gi lights with; leaving gi mode rebuilds
    // the light anyway, which restores real maps.
    if (light.shadow && light.shadow.shadowNode === entry.node) {
      light.shadow.shadowNode = light.userData?.giShadowMode === "gi" ? float(1) : undefined;
      light.shadow.needsUpdate = true;
      light.dispose?.();
    }
  }

  /**
   * `__giLogLight` — per-FRAME record of the light direction GI actually used,
   * with nothing frozen. This is the test that survives the mistake made twice
   * above: GI's only light-dependent input is this uniform, so any hatch that
   * holds it still also freezes GI's output, and "no flicker" becomes trivially
   * true. Measuring it instead of freezing it keeps the whole pipeline live.
   *
   * With `bounce` 0, shadows forced open, zero composites and zero target
   * resizes, GI's output is a SMOOTH function of this direction — so if the
   * per-frame angular steps are smooth and monotonic, GI cannot be producing a
   * flicker from them and the artifact is downstream of everything measured so
   * far. Steps that jitter in size, or REVERSE sign while the light turns one
   * way, mean GI is being fed a direction that disagrees with the one three
   * renders with, and the smooth function is simply reporting a jittery input.
   */
  #logLightInput() {
    if (!globalThis.__giLogLight) return;
    const slot = this.state?.lightSlots?.find((s) => s.active.value > 0.5);
    if (!slot) return;
    const v = slot.vector.value;
    const prev = this._lightLogPrev;
    this._lightLogPrev = { x: v.x, y: v.y, z: v.z };
    if (!prev) { this._lightLogSteps = []; return; }
    const dot = Math.min(1, Math.max(-1, prev.x * v.x + prev.y * v.y + prev.z * v.z));
    const step = (Math.acos(dot) * 180) / Math.PI;
    // Signed by the turn direction about the dominant rotation axis, so a
    // genuine reversal is distinguishable from ordinary magnitude noise.
    const cross = prev.y * v.z - prev.z * v.y;
    (this._lightLogSteps ??= []).push(cross >= 0 ? step : -step);
    if (this._lightLogSteps.length < 120) return;
    const s = this._lightLogSteps;
    this._lightLogSteps = [];
    const mag = s.map(Math.abs);
    const mean = mag.reduce((a, b) => a + b, 0) / mag.length;
    let reversals = 0;
    for (let i = 1; i < s.length; i++) if (s[i] * s[i - 1] < 0 && mag[i] > mean * 0.1) reversals++;
    const still = mag.filter((m) => m < mean * 0.05).length;
    console.log(
      `[gi] light step over 120 frames: mean ${mean.toFixed(4)}deg, ` +
        `min ${Math.min(...mag).toFixed(4)}, max ${Math.max(...mag).toFixed(4)}, ` +
        `reversals ${reversals}, near-zero steps ${still} — ` +
        `a smoothly turning light gives a steady mean, 0 reversals and 0 near-zero steps`,
    );
  }

  #dispose() {
    const state = this.state;
    if (!state) return;
    this.state = null;
    // GI-traced shadows die WITH the system, and this cannot wait for the next
    // light sync: that sync runs off `this.state`, which is now null, so a
    // light left holding our shadowNode would sample a texture nothing writes
    // any more — and would never be handed back to its own shadow map.
    for (const [light, entry] of this._lightShadowNodes ?? []) {
      this.#releaseLightShadowNode(light, entry);
    }
    this._lightShadowNodes?.clear();
    state.volume?.dispose?.();
    state.bvhScene?.dispose?.();
    // The gbuffer is per-build; the resolve TARGETS are not (see
    // createGiTargets) — disposing them here would strand every material that
    // is still bound to them. Same rule for the BVH reflect target
    // (`_giBvhTarget`, see `#syncBvhScene`) — it is not touched here either.
    state.screen?.gbuffer?.dispose?.();
    // Per-build like the gbuffer it reads, and unlike the resolve targets: no
    // material is bound to a probe buffer, so nothing is stranded by this.
    state.screen?.srcProbes?.dispose?.();
    state.light?.removeFromParent();
    for (const mesh of state.gizmos?.all ?? []) {
      mesh.removeFromParent();
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    // Compute nodes / storage buffers are released with GC once nothing
    // references them; three's storage attributes hold no scene-graph refs.
  }

  #applyLiveProps() {
    const state = this.state;
    if (!state) return;
    const cfg = this.config;
    state.light.intensityUniform.value = cfg.intensity ?? 1;
    // Hard-clamped to [0,1]: bounce is "how much secondary energy survives
    // each pass", and any in-loop gain above 1 makes the feedback series
    // diverge (white-out) in enclosed scenes — old saved props may still
    // carry values up to 4 from the earlier schema. Artistic exaggeration
    // belongs to `intensity`, which sits OUTSIDE the loop.
    state.bounceGain.value = Math.min(1, Math.max(0, cfg.bounce ?? 1));
    if (state.bleedSaturation) {
      state.bleedSaturation.value = Math.min(1, Math.max(0, cfg.bleedSaturation ?? 1));
    }
    state.temporalBlend.value = Math.min(1, Math.max(0.02, cfg.temporalBlend ?? 0.25));
    state.probeSmoothing.value = clampProbeSmoothing(cfg.probeSmoothing);
    // SKY RADIANCE COMES FROM THE SCENE, NOT FROM GI. `scene.environment` +
    // `environmentIntensity` — three's own image-based light, which Scene
    // Settings and the HDRI Environment component already write. GI used to own
    // a second, competing pair of properties (`skyColor`/`skyIntensity`); it
    // reads the scene's instead, which is how it got to one authored property.
    //
    // No environment means exactly zero, which is what `skyIntensity: 0`
    // defaulted to — so no existing scene changes brightness across this.
    // Re-read every frame, so dragging the environment intensity is live.
    if (state.skyRadiance) {
      sceneSkyRadiance(this.engine?.scene, state.skyRadiance.value);
    }
    // Indirect-AO knobs (giScreen's obscurance ladder) — live uniforms; the
    // resolve runs every frame (even in idle sleep), so edits land next frame.
    if (state.screen?.ao) {
      state.screen.ao.strength.value = Math.min(1, Math.max(0, cfg.aoStrength ?? 0.6));
      state.screen.ao.radius.value = Math.min(3, Math.max(0.1, cfg.aoRadius ?? 0.6));
    }
  }

  #applyDebugVisibility() {
    const state = this.state;
    if (!state) return;
    const mode = giDebugView();
    if (state.gizmos.sdfView) state.gizmos.sdfView.visible = mode === "sdf";
    if (state.gizmos.occView) state.gizmos.occView.visible = mode === "occupancy";
    // "src-probes" is selectable whether or not `__giSrcProbes` is on; with the
    // population off there is simply nothing to show. Saying so beats a silent
    // no-op, because "I picked the probe view and nothing happened" is
    // otherwise indistinguishable from "the probe view is broken".
    if (mode === "src-probes" && !state.screen?.srcProbes && !this._srcGizmoHintShown) {
      this._srcGizmoHintShown = true;
      console.log(
        "[gi] Debug View \"src-probes\": the SRC probe population is off. " +
        "It is ON by default since Phase 5 — this build was opted out " +
        "(`__giSrcProbes = false`, or the build predates the flip). Remove the " +
        "flag and rebuild GI to get probes back.",
      );
    }
    state.screen?.srcProbes?.gizmos?.setVisible(mode === "src-probes");
  }

  // -------------------------------------------------------------------------
  // Entries: one per GI mesh, carrying the bake-resolved surface + content
  // identity. Promotion: the brightest emissive meshes become analytic
  // sphere area lights — their emissive leaves the composited field (the
  // geometry stays, as occluder/albedo) and per-frame uniform slots carry
  // their light instead, so a moving lamp stays smooth and bake-free.


  /**
   * Placements a mesh contributes: `[null]` for a plain mesh (itself), or one
   * instance index per live InstancedMesh instance. `mesh.count` is the
   * DRAWN count, which is what the field should match — instances parked
   * beyond it are not on screen and must not cast.
   */
  #placementsOf(mesh) {
    if (!mesh.isInstancedMesh) return [null];
    const count = Math.min(mesh.count ?? 0, MAX_INSTANCES_PER_MESH);
    if ((mesh.count ?? 0) > MAX_INSTANCES_PER_MESH && !this._warnedInstanceCap?.has(mesh)) {
      (this._warnedInstanceCap ??= new WeakSet()).add(mesh);
      console.warn(
        `[gi] "${mesh.name || "InstancedMesh"}" has ${mesh.count} instances; ` +
          `the first ${MAX_INSTANCES_PER_MESH} occupy SDF slots, the rest receive GI but do not cast`,
      );
    }
    return Array.from({ length: count }, (_, i) => i);
  }

  #buildEntries(meshes) {
    const entries = [];
    // Sub-voxel physics props (#analyticOnlyMover): no atlas entry — nothing
    // to bake, composite, or promote to the voxel field — but the BRIGHT ones
    // remain emitter-promotion candidates below, so a glowing projectile can
    // still win an analytic slot and cast sharp light.
    const analyticEmitterCands = [];
    for (const mesh of meshes) {
      const placements = this.#placementsOf(mesh);
      if (!placements.length) continue;
      const surface = resolveMaterialSurface(mesh.material, mesh.name);
      const r = surface.emissive.r * surface.emissiveIntensity;
      const g = surface.emissive.g * surface.emissiveIntensity;
      const b = surface.emissive.b * surface.emissiveIntensity;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (this.#analyticOnlyMover(mesh)) {
        const peak = Math.max(r, g, b);
        if (peak >= 0.5) {
          analyticEmitterCands.push({ mesh, surface, r, g, b, luminance, peak, promoted: false });
        }
        continue;
      }
      // PEAK radiance, the emitter-promotion QUALIFIER (2026-08-07). Luminance
      // is a perceptual weighting — green counts 10x more than blue — so it is
      // the right way to RANK lamps by power but the wrong way to decide
      // whether something is a lamp at all. Measured on the four-lamp rig:
      // at emission strength 1, a full-intensity green mesh scores 0.72 and
      // promotes while an equally bright saturated RED scores 0.23 and a BLUE
      // 0.14, so both fall under the 0.5 gate and get no analytic slot at all.
      // A mesh with no slot lights the scene only through the voxel field —
      // blocky, and with no exact-silhouette shadow — which is exactly the
      // reported "emissive shadows are still voxelized a lot" and "sometimes
      // dynamic objects don't even cast shadows from emissive objects at all",
      // on lamps whose only sin was being a saturated colour.
      const peak = Math.max(r, g, b);
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const tris = (geometry.index?.count ?? position.count) / 3;
      let analytic = analyticShapeOf(
        geometry,
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      );
      // EVERY MESH STILL NEEDS A SLOT. A slot used to become ACTIVE only on
      // receiving a baked grid or an analytic shape, and with no bake pipeline
      // an ordinary mesh ended up with none — which cost far more than a
      // distance field, because an inactive slot gave the composite no AABB to
      // attribute a cell to and no mean albedo. **Indirect light is albedo**, so
      // the bounce term went to zero: the reported "almost pitch black, no
      // indirect". The synthesized bounding box below is the stand-in, and its
      // DISTANCE was never the point — it was never sampled even then.
      //
      // It survives the atlas's deletion because #syncSlots still classifies by
      // shape and the pyramid still needs a placement per mesh.
      if (!analytic) {
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        if (bb) {
          analytic = {
            type: "box",
            center: [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2],
            half: [
              Math.max((bb.max.x - bb.min.x) / 2, 1e-4),
              Math.max((bb.max.y - bb.min.y) / 2, 1e-4),
              Math.max((bb.max.z - bb.min.z) / 2, 1e-4),
            ],
          };
        }
      }
      if (analytic) {
        for (const instanceId of placements) {
          entries.push({
            mesh, instanceId, key: slotKeyOf(mesh, instanceId),
            surface, tris, luminance, peak, r, g, b, analytic,
            promoted: false,
          });
        }
        continue;
      }
      // UNREACHABLE IN ANY BUILD WITH AN OCCUPANCY FIELD, which is every build
      // (`killSdf` is unconditional). The synthesized bounding box above means
      // a mesh always leaves with an analytic shape; this exists so a
      // no-occupancy device still produces entries — for the emitter promotion
      // and the BVH, which do not need a slot shape.
      for (const instanceId of placements) {
        entries.push({
          mesh, instanceId, key: slotKeyOf(mesh, instanceId),
          surface, tris, luminance, peak, r, g, b, promoted: false,
        });
      }
    }

    // Emitter promotion: qualify by PEAK radiance ≥ 0.5 (see the `peak` note
    // in #buildEntries — luminance rejected saturated red/blue lamps that are
    // every bit as bright as the white ones it accepted), rank by emitted
    // POWER (luminance · world radius²) — a large dim panel outshines a tiny
    // bright trinket, and the slots should go to the lamps that actually
    // light the scene.
    this._emitterInfos = [];
    if (this.config.emissiveShadows !== false) {
      const scratch = new THREE.Vector3();
      const powerOf = (entry) => {
        const geometry = entry.mesh.geometry;
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        entry.mesh.getWorldScale(scratch);
        const radius =
          (geometry.boundingSphere?.radius ?? 0.1) *
          Math.max(Math.abs(scratch.x), Math.abs(scratch.y), Math.abs(scratch.z));
        return entry.luminance * Math.max(radius * radius, 1e-4);
      };
      // ONE emitter per MESH. An emitter slot is described by its mesh's own
      // world transform (`#refreshEmitterSlots` reads `mesh.matrixWorld`), so
      // an InstancedMesh's instances would all promote to the same box at the
      // prototype's position — MAX_EMITTERS duplicates of one lamp, and the
      // real lamps in the scene pushed out of the budget by them. Instanced
      // emissive geometry still emits through the FIELD (its emissive is
      // composited per instance); it just does not get an analytic slot.
      const seenEmitterMesh = new Set();
      const bright = [];
      for (const entry of entries) {
        if (entry.peak < 0.5 || entry.mesh.isInstancedMesh || seenEmitterMesh.has(entry.mesh)) continue;
        seenEmitterMesh.add(entry.mesh);
        bright.push(entry);
      }
      for (const cand of analyticEmitterCands) {
        if (seenEmitterMesh.has(cand.mesh)) continue;
        seenEmitterMesh.add(cand.mesh);
        bright.push(cand);
      }
      bright.sort((a, b) => powerOf(b) - powerOf(a));
      if (bright.length > MAX_EMITTERS && !this._warnedEmitterBudget) {
        this._warnedEmitterBudget = true;
        console.warn(`[gi] ${bright.length} bright emitters; analytic slots cover the brightest ${MAX_EMITTERS}`);
      }
      // ── STICKY SEATS (2026-08-08, the cannonball scene). Slots are
      // POSITIONAL (#refreshEmitterSlots maps infos[i] → slot i), and the
      // seat list used to be rebuilt from the power ranking on every
      // fingerprint scan. With 24 identical strength-100 projectiles the
      // ranking is a 24-way tie, so which four won — and in which order —
      // changed per scan: every flip re-surfaced an atlas slot (a composite),
      // re-posed a slot (moved = 1 → an EMA history cut where its light
      // lands), and re-aimed the emitter-shadow channel. An incumbent now
      // keeps its seat AND its index until it dims, despawns, or a
      // challenger out-powers it by 1.5× — so identical lamps turn over at
      // despawn cadence, never at scan cadence.
      const byMesh = new Map();
      for (const cand of bright) byMesh.set(cand.mesh, cand);
      const prevSeats = this._promotedEmitterMeshes ?? [];
      const chosen = new Array(MAX_EMITTERS).fill(null);
      const taken = new Set();
      for (let i = 0; i < MAX_EMITTERS; i++) {
        const cand = prevSeats[i] ? byMesh.get(prevSeats[i]) : null;
        if (cand && !taken.has(cand.mesh)) {
          chosen[i] = cand;
          taken.add(cand.mesh);
        }
      }
      for (const cand of bright) {
        if (taken.has(cand.mesh)) continue;
        const hole = chosen.indexOf(null);
        if (hole !== -1) {
          chosen[hole] = cand;
          taken.add(cand.mesh);
          continue;
        }
        let weakestAt = -1;
        let weakestPower = Infinity;
        for (let i = 0; i < MAX_EMITTERS; i++) {
          const p = powerOf(chosen[i]);
          if (p < weakestPower) {
            weakestPower = p;
            weakestAt = i;
          }
        }
        if (weakestAt !== -1 && powerOf(cand) > weakestPower * 1.5) {
          taken.delete(chosen[weakestAt].mesh);
          chosen[weakestAt] = cand;
          taken.add(cand.mesh);
        }
      }
      this._promotedEmitterMeshes = chosen.map((cand) => cand?.mesh ?? null);
      for (const cand of chosen) {
        if (cand) cand.promoted = true;
      }
      this._emitterInfos = chosen.map((cand) =>
        cand ? { mesh: cand.mesh, r: cand.r, g: cand.g, b: cand.b } : null,
      );
      // DYNAMIC emitters (particle systems) claim whatever seats the emissive
      // meshes left — HOLES included, since the array is positional. They have
      // no mesh — `#refreshEmitterSlots` reads their shape from a provider
      // callback each frame instead. Meshes get priority because they are the
      // scene's fixed lamps; a particle effect that wants a guaranteed slot
      // has to out-rank them on power, which is a deliberately conservative
      // default.
      const providers = [...(this.engine.giEmitters ?? [])];
      for (let i = 0; i < MAX_EMITTERS && providers.length; i++) {
        if (!this._emitterInfos[i]) this._emitterInfos[i] = { provider: providers.shift() };
      }
      // Trailing holes are trimmed so every `length > 0` liveness check
      // (emitter-pass dispatch, the profile op) still reads "no emitters"
      // as an empty array; interior holes park their slot at radius 0.
      while (this._emitterInfos.length && !this._emitterInfos[this._emitterInfos.length - 1]) {
        this._emitterInfos.pop();
      }
    }
    return entries;
  }

  /** Slot surface for an entry: promoted emitters composite ZERO emissive. */
  #slotSurface(entry) {
    return {
      color: entry.surface.color,
      emissive: entry.promoted
        ? { r: 0, g: 0, b: 0 }
        : {
            r: entry.surface.emissive.r * entry.surface.emissiveIntensity,
            g: entry.surface.emissive.g * entry.surface.emissiveIntensity,
            b: entry.surface.emissive.b * entry.surface.emissiveIntensity,
          },
    };
  }

  /**
   * Reconciles atlas slots with the current entry list: clears slots whose
   * mesh left the scene, seats cached SDFs into free slots, refreshes slot
   * surfaces (live color/emissive edits), picks detail slots, and kicks
   * load-or-bake for entries without a cached SDF. Pure uniform/texture
   * state — no shader recompiles, no CPU field math.
   */
  #syncSlots(entries) {
    const state = this.state;
    if (!state) return;
    const atlas = state.atlas;
    // Exact-dynamic adoptees leave the composite too: their atlas slot is
    // cleared (below, via the byKey miss) and their motion stops bumping the
    // atlas revision — a rotating adopted mover costs ZERO per-frame
    // composites. Their occlusion/width lives entirely in the exact
    // ray-query path (dynamicObjects.js); an adopted EMISSIVE mover keeps
    // its analytic emitter slot (promotion reads the entry list upstream).
    if (this._dynAdoptedKeys?.size) {
      entries = entries.filter((entry) => !this._dynAdoptedKeys.has(entry.key));
    }
    // Keyed by PLACEMENT (mesh, or mesh+instance index), and a Map rather
    // than the old findIndex-per-entry: that scan was O(entries × capacity),
    // which was invisible at 128 slots and is not at 512 with instancing.
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const slotOfKey = new Map();
    for (let i = 0; i < atlas.assignments.length; i++) {
      const assignment = atlas.assignments[i];
      if (!assignment) continue;
      if (byKey.has(assignment.key)) slotOfKey.set(assignment.key, i);
      else atlas.clearSlot(i);
    }
    let overflow = 0;
    for (const entry of entries) {
      const existing = slotOfKey.get(entry.key);
      if (existing !== undefined) {
        atlas.setSlotSurface(existing, this.#slotSurface(entry));
        continue;
      }
      // EVERY entry is analytic now: #buildEntries synthesizes a bounding box
      // for anything `fitPrimitive` could not name, so a placement either seats
      // or overflows the slot count. (The alternative used to be seating a
      // baked 64³ grid into a texture tile, which could overflow independently
      // of the instance count; both the grid and the tile pool are gone.)
      if (!entry.analytic) continue;
      const free = atlas.allocateSlot();
      if (free < 0) {
        overflow++;
        continue;
      }
      atlas.setAnalyticSlot(free, entry.mesh, entry.analytic, this.#slotSurface(entry), entry.instanceId);
      slotOfKey.set(entry.key, free);
    }
    if (overflow > 0) {
      // ONE rebuild attempt per (entry count, capacity) situation. An
      // unconditional request looped forever when the rebuilt atlas
      // reproduced the exact same packing failure — build, overflow,
      // build, overflow, at ~3s per compile wave.
      const overflowSig = `${entries.length}:${atlas.capacity}`;
      // Retry only while a bigger tier could actually help — asking for a
      // rebuild that must fail the same way is the loop this guards against.
      const canGrow = atlas.capacity < MAX_INSTANCE_SLOTS;
      if (canGrow && this._overflowRebuildSig !== overflowSig) {
        this._overflowRebuildSig = overflowSig;
        this.requestRebuild();
      } else if (!this._warnedSlotBudget) {
        this._warnedSlotBudget = true;
        console.warn(
          `[gi] ${overflow} of ${entries.length} placements could not seat ` +
            `(slots ${atlas.capacity}) — they are invisible to GI`,
        );
      }
    } else {
      this._overflowRebuildSig = null;
      this._warnedSlotBudget = false;
    }
    // THE DETAIL-SLOT RANKING WENT WITH THE TRACES THAT SPENT IT. Shadow and
    // mirror rays used to min() a per-quality budget of 4-12 "detail" slots at
    // every step, on top of the composited field, so that sub-cell geometry a
    // 0.33m field cannot represent still occluded — a 0.1m partition is
    // steppable-over otherwise, which was the "light through the wall" leak.
    // This block chose which slots got that budget (thin analytic walls and
    // hollow room shells first, then the densest baked meshes, with two slots
    // reserved so a wall-heavy room could not starve a character's hi-res SDF)
    // and published the same ranking per-slot for the instance grid to spend
    // per cell.
    //
    // NONE OF THAT PROBLEM EXISTS NOW: the occupancy pyramid rasterizes at
    // 0.10-0.25m voxels and marches them hierarchically, so sub-cell geometry
    // is IN the medium rather than refined against on the side. The whole
    // ranking was an artifact of the coarse composited field.
  }

  /**
   * Refreshes emitter-slot uniforms from the promoted meshes' LIVE world
   * transforms — every frame, so a dragged lamp re-aims its light and
   * shadows continuously.
   */
  #refreshEmitterSlots() {
    const state = this.state;
    if (!state?.emitterSlots) return;
    const infos = this._emitterInfos ?? [];
    const scratchScale = new THREE.Vector3();
    const scratchPos = new THREE.Vector3();
    const scratchQuat = new THREE.Quaternion();
    const col = new THREE.Vector3();
    const prevCenter = new THREE.Vector3();
    const prevAxis = new THREE.Vector3();
    // Motion → 1 within ~a tenth of the slot's own size per frame; decay 0.6
    // per frame at rest so a stop settles the retain back over ~4 frames
    // instead of on a hard edge. Distances are scaled by the slot's reff so
    // "moving" means the same thing for a desk lamp and a two-metre panel.
    const motionOf = (slot, dCenter, dAxis) => {
      const scale = Math.max(slot.reff.value, 0.05);
      const target = Math.min(1, (dCenter / (0.1 * scale) + dAxis * 6) * 1);
      return Math.max(target, slot.moved.value * 0.6);
    };
    for (let i = 0; i < state.emitterSlots.length; i++) {
      const slot = state.emitterSlots[i];
      const info = infos[i];
      // Last frame's pose, captured BEFORE any writer below touches it.
      prevCenter.copy(slot.center.value);
      prevAxis.copy(slot.by.value);
      const hadRadius = slot.radius.value > 0.001;
      if (!info) {
        slot.radius.value = 0;
        slot.moved.value = 0;
        continue;
      }
      // Dynamic emitter (particle system): no mesh, no bounding sphere — the
      // provider reports this frame's centre/radius/colour directly. Returning
      // null parks the slot at radius 0, which is how a system with no live
      // particles (or a readback still in flight) contributes nothing.
      if (info.provider) {
        const shape = info.provider();
        if (!shape || !(shape.radius > 0)) {
          slot.radius.value = 0;
          slot.moved.value = 0;
          continue;
        }
        slot.center.value.copy(shape.center);
        slot.radius.value = shape.radius;
        slot.color.value.setRGB(shape.r, shape.g, shape.b);
        slot.kind.value = 0;
        slot.reff.value = shape.radius;
        slot.exHalf.value.setScalar(shape.radius);
        slot.moved.value = hadRadius
          ? motionOf(slot, prevCenter.distanceTo(slot.center.value), 0)
          : 1;
        continue;
      }
      // `!parent` = despawned between fingerprint scans (destroyEntity removes
      // the object; the seat list refreshes at scan cadence) — park the slot
      // now, not up to 250ms later at the ghost's last pose.
      if (!info.mesh.visible || !info.mesh.parent) {
        slot.radius.value = 0;
        slot.moved.value = 0;
        continue;
      }
      const geometry = info.mesh.geometry;
      slot.color.value.setRGB(info.r, info.g, info.b);
      // SHAPE. fitEmitterShape (emitterShapes.js) maps every default three
      // geometry to its analytic kind — sphere, capsule, cylinder, frustum/
      // cone, disc/ring, torus, equal-area spheres for the polyhedra — from
      // the LIVE world matrix, so a moving or rotating lamp re-poses its
      // analytic light every frame with no voxels anywhere in the loop.
      // Everything it declines (partial arcs, radially non-uniform scale,
      // unrecognised imports) takes the oriented-box fallback below —
      // strictly closer than a bounding sphere for any non-spherical lamp.
      if (fitEmitterShape(geometry, info.mesh.matrixWorld, emitterFitScratch)) {
        slot.kind.value = emitterFitScratch.kind;
        slot.center.value.copy(emitterFitScratch.center);
        slot.radius.value = emitterFitScratch.radius;
        slot.half.value.copy(emitterFitScratch.half);
        slot.bx.value.copy(emitterFitScratch.bx);
        slot.by.value.copy(emitterFitScratch.by);
        slot.bz.value.copy(emitterFitScratch.bz);
        slot.reff.value = emitterFitScratch.reff;
        slot.exHalf.value.copy(emitterFitScratch.exHalf);
        slot.moved.value = hadRadius
          ? motionOf(
              slot,
              prevCenter.distanceTo(slot.center.value),
              1 - Math.abs(prevAxis.dot(slot.by.value)),
            )
          : 1;
        continue;
      }
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      slot.center.value.copy(geometry.boundingSphere.center).applyMatrix4(info.mesh.matrixWorld);
      info.mesh.matrixWorld.decompose(scratchPos, scratchQuat, scratchScale);
      slot.radius.value =
        geometry.boundingSphere.radius * Math.max(scratchScale.x, scratchScale.y, scratchScale.z);
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      slot.kind.value = 1;
      slot.center.value
        .set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
        .applyMatrix4(info.mesh.matrixWorld);
      // World OBB: matrixWorld columns are the local axes scaled — axis =
      // column/|column|, world half-extent = localHalf·|column|. Exact for
      // any TRS (nested shear is out of scope). Tiny floor so a plane's
      // zero axis stays numerically safe in the slab/SDF math.
      const e = info.mesh.matrixWorld.elements;
      const axes = [slot.bx.value, slot.by.value, slot.bz.value];
      const halfLocal = [
        (bb.max.x - bb.min.x) / 2,
        (bb.max.y - bb.min.y) / 2,
        (bb.max.z - bb.min.z) / 2,
      ];
      const halfWorld = [0.005, 0.005, 0.005];
      for (let a = 0; a < 3; a++) {
        col.set(e[a * 4], e[a * 4 + 1], e[a * 4 + 2]);
        const len = col.length();
        if (len > 1e-8) axes[a].copy(col).divideScalar(len);
        else axes[a].set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
        halfWorld[a] = Math.max(halfLocal[a] * len, 0.005);
      }
      slot.half.value.set(halfWorld[0], halfWorld[1], halfWorld[2]);
      slot.exHalf.value.set(halfWorld[0], halfWorld[1], halfWorld[2]);
      // Mean projected area of a convex body is surface/4 (Cauchy) — the
      // disc-equivalent radius drives penumbra k and glow energy.
      const [hx, hy, hz] = halfWorld;
      slot.reff.value = Math.sqrt(((hx * hy + hy * hz + hz * hx) * 2) / Math.PI);
      slot.moved.value = hadRadius
        ? motionOf(
            slot,
            prevCenter.distanceTo(slot.center.value),
            1 - Math.abs(prevAxis.dot(slot.by.value)),
          )
        : 1;
    }
    // SRC's motion-adaptive α (§12.38) reads the emitter half of "is the
    // scene moving" from the same per-slot retains the emitter history uses —
    // one definition of emitter motion, two consumers. Already [0,1] and
    // already decayed (0.6/frame at rest), so it needs no normalization.
    let emitterMotion = 0;
    for (const slot of state.emitterSlots) {
      emitterMotion = Math.max(emitterMotion, slot.moved.value ?? 0);
    }
    this._giEmitterLastMotion = emitterMotion;
  }

  // -------------------------------------------------------------------------
  // Scene collection

  #collectMeshes() {
    const meshes = [];
    // Per-bucket material tally (see giRoughnessBucketOf): logged at build so
    // a slow scene reports WHY — bucket 3/0 materials compile and run the
    // mirror + hit-lighting path, buckets 1/2 are a fraction of that cost.
    const seenMaterials = new Set();
    const tally = [0, 0, 0, 0];
    const visit = (object) => {
      // Batched members are hidden yet still drawn (engine/batching.js).
      // `cameraHidden` = hidden by LOD/occlusion only (see Engine's visibility
      // resolve): the mesh is still part of the world, so it must stay in the
      // field or the GI mesh set becomes a function of the camera.
      if (object.visible === false && !object.userData.batchedInto && !object.userData.cameraHidden) return;
      // InstancedMesh IS collected now — it contributes one atlas instance
      // slot per live instance, all sharing a single baked tile (see
      // #buildEntries). It used to be skipped outright, which meant every
      // instanced prop in a scene was simply absent from the GI field: no
      // shadow, no bounce, no reflection, and a hole in the occupancy the
      // cascades happily traced light through.
      if (object.isMesh && !object.userData.__giDebug) {
        const position = object.geometry?.attributes?.position;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const triCount = (object.geometry?.index?.count ?? position?.count ?? 0) / 3;
        // Editor-only helpers live on layer 31 (mask compared unsigned —
        // 1<<31 is negative in JS int32). UI quads are excluded for the same
        // reason: they are screen furniture, and a screen-space one sits at
        // the world origin at pixel scale, so voxelizing it would blow the
        // field's bounds out to hundreds of metres of empty air.
        const editorOnly =
          (((object.layers.mask >>> 0) & 0x80000000) !== 0 && (object.layers.mask >>> 0) === 0x80000000) ||
          object.layers.isEnabled(UI_LAYER);
        // EVERY lit material must be visible to three's NodeMaterialObserver
        // as "node-driven" — see #markObservedMaterial. GI light receivers
        // include meshes the FIELD skips (transparent etc.), so mark all.
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of mats) {
          // Volume materials shade through a scattering model with no
          // irradiance slot (see GICascadeLightNode.setup) — marking them
          // would only add a per-frame uniform refresh for a material that
          // cannot receive GI anyway.
          if (m?.isVolumeNodeMaterial || m?.userData?.isVolumeMaterial) continue;
          this.#markObservedMaterial(m);
          this.#refreshMirrorBucket(m);
          const bucket = m ? giRoughnessBucketOf(m) : 2;
          if (m && !seenMaterials.has(m)) {
            seenMaterials.add(m);
            tally[bucket]++;
          }
        }
        // A volume's bounding box is a participating medium, not a surface —
        // baking it into the SDF field would make a fog box shadow the room
        // like a solid crate.
        const isVolume = material?.isVolumeNodeMaterial || material?.userData?.isVolumeMaterial;
        if (position && material && !material.transparent && !isVolume && !editorOnly && triCount <= MAX_TRIS_PER_MESH) {
          meshes.push(object);
        } else if (triCount > MAX_TRIS_PER_MESH) {
          console.warn(`[gi] skipping "${object.name || "mesh"}" (${Math.round(triCount)} tris > cap)`);
        }
      }
      for (const child of object.children) visit(child);
    };
    if (this.engine.scene) visit(this.engine.scene);
    this._bucketTally = tally;
    return meshes;
  }

  /**
   * Marks a material so three's NodeMaterialObserver treats it as
   * node-driven (`hasNode` true → uniforms refreshed EVERY frame).
   * Without this, plain materials only refresh their uniform buffers when
   * something the observer monitors changes (own matrix, material props,
   * known light data) — our GI uniforms (emitter centers/colors, intensity,
   * light slots) are invisible to it, so on a STATIC receiver they freeze
   * at compile-time values: a moved lamp kept lighting its old position
   * (harness-proven: move ≈ no image change, rebuild at the same spot ≈
   * 95k-pixel change). The marker is an inert extra property — builders
   * ignore unknown props; `containsNode` only checks `.isNode`.
   */
  #markObservedMaterial(material) {
    if (!material || material.giMonitorNode?.isNode) return;
    // ONE SHARED marker instance for every material (§13.15.2). The observer
    // only needs SOME own property with `.isNode`; but `customProgramCacheKey`
    // walks own node properties and hashes each node's IDENTITY
    // (Node.customCacheKey() → this.id), so a fresh `float(0)` per material
    // put a unique id into every key and silently defeated the sharing this
    // very override promises below — the entire material compile wave stayed
    // one codegen per material (26× for Sponza) even after the stock-PBR
    // expression removed the per-material graph nodes. A shared instance
    // contributes the SAME id to every key, so same-bucket materials collide
    // and share one build, which is the documented intent.
    // A/B hatch (R12): __noSharedGiMarker restores the per-material marker.
    material.giMonitorNode = globalThis.__noSharedGiMarker
      ? float(0)
      : (GISystem._giMonitorMarker ??= float(0));
    // CACHE-KEY OVERRIDE: three's material cache key reduces numeric
    // properties to on/off, so same-structure materials with different
    // static roughness hash IDENTICALLY — and since the GI light node
    // generates different code per roughness bucket, they would steal each
    // other's shared node builds (harness-proven: a mirror material
    // rendering with the diffuse-only build → "reflections absent").
    // Appending the LIVE-derived bucket keys each variant separately while
    // still letting same-bucket materials share one build.
    const original = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => original() + "|gi" + giRoughnessBucketOf(material);
    // Recompile so the observer is rebuilt with hasNode = true.
    material.needsUpdate = true;
  }

  #collectLightObjects() {
    const lights = [];
    this.engine.scene?.traverse((object) => {
      if ((object.isDirectionalLight || object.isPointLight) && isRenderVisible(object) && object.intensity > 0) {
        lights.push(object);
      }
    });
    return lights;
  }

  // -------------------------------------------------------------------------
  // Change detection: transforms are handled PER FRAME by the atlas (uniform
  // epsilon-diff → recomposite). The fingerprint cadence only handles the
  // slower changes: mesh add/remove, geometry edits, material color edits,
  // light-list churn, and auto-fit drift.

  #queueRebakeCheck() {
    this._frame = -1; // forces the next tick's modulo to hit
  }

  #checkFingerprint() {
    const state = this.state;
    const component = this.component;
    if (!state || !component) return;
    // Time floor: editor drags poke the check every frame via change
    // events — collapse bursts to one scan per interval (transforms don't
    // need scans; they're handled per frame by the atlas uniforms).
    const nowMs = performance.now();
    if (nowMs - (this._lastScanAt ?? 0) < FINGERPRINT_MIN_INTERVAL_MS) return;
    this._lastScanAt = nowMs;

    // A material became a mirror while reflections were gated off for want of
    // one (`#hasReflectionConsumer`). Rebuild so the prepass exists — this is
    // the deferred half of that gate's ramp, and it is checked here rather than
    // acted on inside `#refreshMirrorBucket` because that runs inside the mesh
    // walk, and rebuilding from inside the walk that a rebuild will re-run is
    // how you get a loop.
    if (this._reflectionConsumerAppeared) {
      this._reflectionConsumerAppeared = false;
      console.log("[gi] a material became reflective — rebuilding to bring exact reflections online");
      this.#rebuild();
      return;
    }

    if (state.autoFit) {
      // Refit ONLY when the live volume has stopped covering the content.
      // Bounds are authored by the component's entity (#autoFitAabb) —
      // moving other scene objects cannot change them, so this fires only
      // when the user edits the bounds source itself, and then usually
      // resolves to a lattice slide rather than a rebuild.
      const now = performance.now();
      // Entity-authored bounds only move when the user edits the bounds
      // source → refit checks are cheap and can be responsive (3s).
      // WHOLE-SCENE fallback bounds shift whenever anything big moves —
      // keep the old 10s cadence there or a dragged prop can trigger a
      // rebuild (and its compile wave) mid-drag.
      const sceneWide = (this._boundsSource ?? "").startsWith("whole scene");
      if (now - (this._lastRefitAt ?? 0) > (sceneWide ? 10000 : 3000)) {
        const aabb = this.#autoFitAabb() ?? this.#sceneAabb(this.#collectMeshes());
        if (aabb) {
          const fit = this.#fitBoundsFor(aabb);
          // THE VOLUME IS ONLY WRONG WHEN IT NO LONGER COVERS THE CONTENT.
          // The old test compared the freshly fitted BOX against the live
          // one and refitted whenever they differed by more than a
          // tolerance — but the live volume is deliberately not the tight
          // fit (an in-place refit keeps the build-time size and only
          // slides), so that test could never settle. Ask the question that
          // actually matters instead: is the content still inside, at the
          // same probe-spacing rung, without the volume having grown
          // absurdly larger than the content?
          const slack = 1e-4;
          const covered =
            fit.min.x >= state.bounds.min.x - slack &&
            fit.min.y >= state.bounds.min.y - slack &&
            fit.min.z >= state.bounds.min.z - slack &&
            fit.max.x <= state.bounds.max.x + slack &&
            fit.max.y <= state.bounds.max.y + slack &&
            fit.max.z <= state.bounds.max.z + slack;
          const base = state.buildSize;
          const oversized =
            fit.sizeX < base.x * 0.55 && fit.sizeY < base.y * 0.55 && fit.sizeZ < base.z * 0.55;
          if (!covered || oversized) {
            // Debounce: require the SAME new answer on two consecutive
            // scans before refitting — a one-scan flicker (mid-drag, a
            // trim threshold crossing) must not trigger a refit. Fits are
            // lattice-snapped, so "the same answer" is now exact equality
            // rather than a tolerance.
            const same = (a, b) =>
              a.min.distanceToSquared(b.min) < 1e-8 && a.max.distanceToSquared(b.max) < 1e-8;
            if (this._pendingFit && same(fit, this._pendingFit)) {
              this._pendingFit = null;
              this._lastRefitAt = now;
              // IN PLACE first: uniform update + one recomposite, ZERO
              // shader recompiles. Falls back to a full rebuild (compile
              // wave) only when the volume drifted so far from the
              // build-time size that the fixed grid would go badly
              // non-cubic or under-resolved.
              if (!this.#refitInPlace(fit)) {
                console.log("[gi] auto-fit: bounds drifted beyond the in-place window — full rebuild");
                this.requestRebuild();
              }
              return;
            }
            this._pendingFit = { min: fit.min.clone(), max: fit.max.clone() };
          } else {
            this._pendingFit = null;
          }
        }
      }
    } else {
      const center = new THREE.Vector3();
      component.entity.object3D.getWorldPosition(center);
      // `autoFit` is a constant `true` now, so this branch is unreachable —
      // kept because it is the whole manual-volume path and deleting it would
      // be a second change riding along with the property collapse. The spacing
      // it compares against is the fitted lattice's, read off the built state
      // rather than off a property that no longer exists.
      if (center.distanceTo(state.center) > Math.max(0.5, (state.probeSpacing || 1.25) * 0.5)) {
        this.requestRebuild();
        return;
      }
    }

    const meshes = this.#collectMeshes();
    // Refresh the light LIST here (cadence); uniforms read live per frame.
    this._lightObjects = this.#collectLightObjects();
    const fingerprint = this.#computeFingerprint(meshes);
    if (fingerprint === this._fingerprint) return;
    this._fingerprint = fingerprint;
    // Mesh set / material / geometry change: rebuild the entry list and
    // reconcile slots. Cheap (no geometry copies unless a bake is needed),
    // and any real change bumps the atlas revision → one composite pass.
    const entries = this.#buildEntries(meshes);
    state.entries = entries;
    this.#syncSlots(entries);
    this.#syncBvhScene(entries);
    // And the occupancy pyramid, which is what transport rays actually
    // intersect — see #refreshOccupancyContent for why this was missing.
    this.#refreshOccupancyContent(meshes);
  }

  /**
   * Applies new auto-fit bounds WITHOUT a rebuild: every world-space shader
   * input is a uniform (see createGiField's world bundle), so a refit is a
   * uniform update + a full-slot AABB refresh + one recomposite — the
   * viewport never freezes. This is what makes MOVING OBJECTS safe in
   * scenes that live under the GI entity: before, any move that shifted the
   * fitted bounds beyond tolerance triggered a full rebuild whose material
   * compile wave held the viewport for 10-20s right after the drag.
   *
   * The grid RESOLUTION stays fixed (dispatch sizes / buffer lengths are
   * build constants), and so does the volume SIZE: a refit is a pure
   * TRANSLATION along the probe lattice. That is what keeps the light stable
   * while the scene is edited — cell and probe spacing never change, every
   * probe that stays inside the volume keeps its exact world position, and
   * the field slides by a whole number of cells instead of resampling. The
   * old refit rescaled the volume to hug the content, so any edit that moved
   * the bounds moved every probe and visibly re-shuffled the indirect light
   * ("GI changes a lot when I move/scale things").
   *
   * TWO TIERS, cheapest first:
   *   SLIDE   — the content still fits in the current box: translate on the
   *             lattice. Nothing resamples, no probe moves, no recompile.
   *   STRETCH — the content outgrew the box: rescale the fixed grid to the
   *             new bounds (cells and probes get coarser/finer, so the light
   *             does visibly shift). Still uniform-only — the alternative is
   *             a full rebuild whose compile wave freezes the viewport, which
   *             is exactly the "10s hang after I move something" report.
   *
   * Returns false — caller falls back to a full rebuild — only when even a
   * stretch would leave the fixed grid badly proportioned (per-axis ratio
   * vs the BUILD size outside [0.55, 1.9]; measured from the build size so
   * repeated stretches cannot walk the grid arbitrarily far).
   */
  #refitInPlace(fit) {
    const state = this.state;
    if (!state?.autoFit || !state.volume?.setBounds) return false;
    const live = new THREE.Vector3().subVectors(state.bounds.max, state.bounds.min);
    const spacing = state.probeSpacing;
    const have = [live.x, live.y, live.z];
    const need = [fit.sizeX, fit.sizeY, fit.sizeZ];
    const fits = spacing > 0 && need.every((n, i) => n <= have[i] + 1e-4);

    if (fits) {
      // Centre the current box on the content, snap onto the lattice, then
      // clamp so the content stays covered. Both fit faces are already
      // lattice-aligned, so the clamps are exact and cannot conflict (the
      // size check guarantees fit.min ≥ fit.max − have).
      const min = new THREE.Vector3();
      for (const [i, axis] of ["x", "y", "z"].entries()) {
        const centre = (fit.min[axis] + fit.max[axis]) / 2;
        let m = Math.round((centre - have[i] / 2) / spacing) * spacing;
        m = Math.min(m, Math.floor((fit.min[axis] + 1e-6) / spacing) * spacing);
        m = Math.max(m, Math.ceil((fit.max[axis] - have[i] - 1e-6) / spacing) * spacing);
        min[axis] = m;
      }
      const next = { min, max: min.clone().add(live) };
      if (
        next.min.distanceToSquared(state.bounds.min) < 1e-8 &&
        next.max.distanceToSquared(state.bounds.max) < 1e-8
      ) {
        return true; // already where it needs to be
      }
      this.#applyBounds(next, live);
      const centre = state.center;
      console.log(
        `[gi] auto-fit: refit in place (slide, nothing resampled) — volume centred at ` +
          `${centre.x.toFixed(1)},${centre.y.toFixed(1)},${centre.z.toFixed(1)}, ` +
          `${live.x.toFixed(1)}x${live.y.toFixed(1)}x${live.z.toFixed(1)}m, probes ${spacing.toFixed(2)}m`,
      );
      return true;
    }

    // The content grew past the box — stretch the fixed grid onto it.
    const base = state.buildSize;
    const ratios = [fit.sizeX / base.x, fit.sizeY / base.y, fit.sizeZ / base.z];
    if (ratios.some((r) => !(r > 0.55 && r < 1.9))) return false;
    const size = new THREE.Vector3(fit.sizeX, fit.sizeY, fit.sizeZ);
    this.#applyBounds({ min: fit.min, max: fit.max }, size);
    // Reach follows the same formula the build uses. (The cascade INTERVALS —
    // `t0` = probe spacing, `farT` = 2× the longest axis — were rescaled here
    // too; Phase 1-3 has to restore that pair, because a stretch that moves the
    // lattice without moving the ray lengths silently changes what each cascade
    // level covers.)
    state.diagU.value = Math.hypot(fit.sizeX, fit.sizeY, fit.sizeZ);
    // Probes rescaled with the box: record the live spacing so the next
    // slide snaps onto the lattice the field ACTUALLY has.
    const grid = state.c0Grid;
    if (grid) state.probeSpacing = Math.min(fit.sizeX / grid.x, fit.sizeY / grid.y, fit.sizeZ / grid.z);
    console.log(
      `[gi] auto-fit: refit in place (stretch, no recompile) — ` +
        `${fit.sizeX.toFixed(1)}x${fit.sizeY.toFixed(1)}x${fit.sizeZ.toFixed(1)}m, ` +
        `cell ${state.volume.minCell.toFixed(3)}`,
    );
    return true;
  }

  /** setBounds + everything that has to follow it (shared by both tiers). */
  #applyBounds(next, size) {
    const state = this.state;
    state.volume.setBounds(next); // mutates state.bounds + the world uniforms
    state.center.copy(next.min).add(next.max).multiplyScalar(0.5);
    // Bump the slot revision so the next tick re-voxelizes the pyramid against
    // the moved bounds. (This used to also re-derive every slot's world AABB,
    // which embedded the volume's old cap reach, and re-pick the thin-wall
    // detail slots from the new cell size — both went with the composite.)
    state.atlas.refreshAllSlots();
    this.#syncSlots(state.entries);
    // The SDF debug box is a build-size BoxGeometry — reposition/rescale it.
    const occView = state.gizmos?.occView;
    if (occView) {
      occView.position.copy(state.center);
      occView.scale.set(size.x / state.buildSize.x, size.y / state.buildSize.y, size.z / state.buildSize.z);
    }
    const sdfView = state.gizmos?.sdfView;
    if (sdfView) {
      sdfView.position.copy(state.center);
      sdfView.scale.set(size.x / state.buildSize.x, size.y / state.buildSize.y, size.z / state.buildSize.z);
    }
  }

  #computeFingerprint(meshes) {
    let hash = 0x811c9dc5;
    const mix = (value) => {
      hash ^= value & 0xffffffff;
      hash = Math.imul(hash, 0x01000193);
    };
    const mixFloat = (f) => mix(Math.round(f * 1000));
    for (const mesh of meshes) {
      mix(mesh.id);
      // Resolve through colorNode/emissiveNode (same path the slot surfaces
      // use) so shader-graph/material-asset color edits fingerprint.
      const surface = resolveMaterialSurface(mesh.material);
      mixFloat(surface.color.r);
      mixFloat(surface.color.g);
      mixFloat(surface.color.b);
      mixFloat(surface.emissive.r * surface.emissiveIntensity);
      mixFloat(surface.emissive.g * surface.emissiveIntensity);
      mixFloat(surface.emissive.b * surface.emissiveIntensity);
      mix(mesh.geometry?.id ?? 0);
      mix(mesh.geometry?.attributes?.position?.version ?? 0);
      // Instance count and matrix version: adding, removing or re-scattering
      // instances changes which slots exist, and nothing else here would
      // notice (the mesh id, geometry and material are all unchanged).
      // Per-instance MOVEMENT is picked up by refreshTransforms every frame;
      // this is only about the set of placements.
      if (mesh.isInstancedMesh) {
        mix(mesh.count ?? 0);
        mix(mesh.instanceMatrix?.version ?? 0);
      }
    }
    return (hash >>> 0).toString(16);
  }

  // -------------------------------------------------------------------------

  /**
   * The conservative occupancy pyramid, or null when the legacy SDF backend is
   * selected. Independent of the atlas on purpose: it needs only geometry and
   * world matrices, never a baked SDF, so it is READY ON FRAME ONE while mesh
   * SDF bakes are still streaming in asynchronously.
   *
   * VOXEL SIZE is budgeted, not fixed at the spec's 0.125m: a bitset is cheap
   * (a 42m Sponza at 0.125m is 1.6 MB) but not free, and a 400m terrain at
   * 0.125m would be 1.4 GB. The quality tier picks a TARGET and the budget is a
   * ceiling, so a bigger world degrades to coarser voxels instead of failing to
   * allocate — the same contract the SDF field's own auto-fit densities use.
   */
  #buildOccupancyField(props, meshes, bounds, size, quality, rayHitConfig) {
    // A SAVED `backend` OTHER THAN "occupancy" IS COERCED, NOT HONOURED. The
    // sdf-legacy transport backend was deleted (session 15b) but scenes saved
    // before that still carry `backend: "sdf-legacy"` — and honouring it
    // means returning null here, which with the bake pipeline also deleted
    // leaves NO transport at all: GI builds, logs happily, and contributes
    // exactly zero light. That state shipped — the user's own Sponza scene
    // had the stale value saved, and every harness measurement against it
    // quietly measured an empty field ("intensity 100 changes nothing", the
    // failed-CONTROL signature). Same trap as the exactReflections
    // structural-signature fix: a stored value under a changed control is a
    // behaviour change. `__giBackend` stays only as a diagnostic kill switch
    // ("none" disables the field explicitly and owns the consequences).
    const backend = globalThis.__giBackend ?? props.backend ?? "occupancy";
    if (backend !== "occupancy") {
      if (globalThis.__giBackend !== undefined && backend !== "occupancy") {
        console.warn(`[gi] __giBackend="${backend}" — occupancy field disabled by hatch, GI transport will be EMPTY`);
        return null;
      }
      console.warn(
        `[gi] saved backend "${backend}" no longer exists (sdf-legacy was removed) — using occupancy. ` +
          "Re-save the scene to clear this.",
      );
    }

    // Portable WebGPU baseline only. The fully composed cascade graph is
    // runtime-smoked at maxStorageBuffersPerShaderStage=8; never disable this
    // path or request a larger device limit to hide a binding regression.

    // Spec §1.1: 0.10–0.15m, "not 0.35 — sub-voxel sheets were the root cause
    // of the blob/leak artifacts". Low/medium relax it for cost.
    const target = { low: 0.25, medium: 0.175, high: 0.125, ultra: 0.1 }[quality] ?? 0.125;
    const budget = { low: 16e6, medium: 32e6, high: 64e6, ultra: 128e6 }[quality] ?? 64e6;
    const volume = size.sizeX * size.sizeY * size.sizeZ;
    const voxelSize = Math.max(target, Math.cbrt(volume / budget));
    const res = quantizeOccupancyRes({
      x: Math.max(16, Math.round(size.sizeX / voxelSize)),
      y: Math.max(16, Math.round(size.sizeY / voxelSize)),
      z: Math.max(16, Math.round(size.sizeZ / voxelSize)),
    });

    // Fresh field → fresh slot numbering: compact IDs at build time, then
    // stable for the field's life (see #occupancyContentOf).
    this._occSlotMap = new Map();
    this._occSlotNext = 0;
    const { geometries, placements } = this.#occupancyContentOf(meshes);

    // `bounds` is the SAME object createGiField will hold and mutate in
    // `setBounds`, which is what makes `field.refit()` able to re-derive the
    // pyramid's origin and voxel size from it after an in-place refit.
    //
    // HEADROOM ON THE SLOT CAPACITY, because the mesh set GROWS after this
    // runs: GLB models finish loading seconds later and arrive through the
    // fingerprint scan, and `#refreshOccupancyContent` re-uploads them into
    // this same field. Sizing the capacity exactly to the meshes present at
    // build time would leave every late arrival with nowhere to go.
    // EXACT DYNAMIC OBJECTS (docs/dynamic_gi_exact_dynamic_objects.md):
    // reserved words in the bits allocation for the per-object header + the
    // object-local BVH4 pool. Header is always needed when the feature is on;
    // the pool tier bounds how much unique mover geometry can go exact
    // (overflow keeps the voxel path — never a hole).
    const dynObjectsOn = globalThis.__giDynamicObjects !== false;
    const dynPoolWords = Number(globalThis.__giDynMeshWords) ||
      ({ low: 262144, medium: 393216, high: 786432, ultra: 1572864 }[quality] ?? 786432);
    const dynWords = dynObjectsOn ? dynHeaderWords() + dynPoolWords : 0;

    // STATIC-SCENE SHADOW BVH ("light by voxels, shadows by BVH"): one
    // world-space BVH8 over every static placement — the screen shadow
    // channels trace exact triangles while injection/bounce stay voxel.
    // `__giShadowStaticBvh = false` restores the records/DDA marcher.
    let staticBvhPacked = null;
    if (dynObjectsOn && globalThis.__giShadowStaticBvh !== false) {
      const t0 = performance.now();
      const geomByKey = new Map(geometries.map((g) => [g.key, g]));
      const items = placements
        .map((p) => {
          const g = geomByKey.get(p.geometryKey);
          return g ? { positions: g.positions, index: g.index, matrix: p.matrix, slot: p.slot } : null;
        })
        .filter(Boolean);
      staticBvhPacked = items.length ? buildStaticSceneBvhWords(items, staticBvhStrategy()) : null;
      // Diagnostics handle: the CPU traversal mirror in the static-BVH probe
      // reads the SAME words the GPU traverses (the bits upload is a compute
      // copy from staging — the CPU bits array never holds them).
      this._staticBvhPacked = staticBvhPacked;
      if (staticBvhPacked) {
        console.log(
          `[gi] static shadow bvh: ${staticBvhPacked.triCount} tris, ` +
            `${(staticBvhPacked.words.length * 4 / (1024 * 1024)).toFixed(1)}MB, built in ${(performance.now() - t0).toFixed(0)}ms` +
            ` (${globalThis.__giStaticBvhStrategy ?? "sah"} splits)`,
        );
      }
    }
    // 1.5× headroom so content refreshes (late GLBs) and demote rebuilds fit
    // without a full field rebuild.
    const staticBvhWords = staticBvhPacked ? Math.ceil(staticBvhPacked.words.length * 1.5) : 0;

    const makeField = (dynW, statW) => createOccupancyField(bounds, res, {
      slotCapacity: Math.min(MAX_INSTANCE_SLOTS, Math.max(64, placements.length * 2)),
      traceSteps: { low: 48, medium: 64, high: 96, ultra: 128 }[quality] ?? 96,
      dynamicObjectWords: dynW,
      staticBvhWords: statW,
      enableProfiling: rayHitConfig?.enableProfiling === true,
      countLegacyFallbacks: rayHitConfig?.fallbackToLegacy === true,
      enableHybridBrick: (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) >= RayHitMode.HybridBrickBox &&
        (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) <= RayHitMode.HybridExactComplex,
      // Phase 2/3: fitted simple-plane records (+ coverage masks) appended to
      // the occupancy allocation. All plane-family modes build the same
      // records; the coverage clip and the exact-triangle fallback are
      // trace-time variants.
      enableSurfaceRecords: (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) >= RayHitMode.HybridPlane &&
        (rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy) <= RayHitMode.HybridExactComplex,
      // ── SRC HIT SHADING NEEDS A STATIC SURFACE (plan §12.28, Phase 5) ─────
      //
      // One u32 per surface record plus a 512-entry palette, both riding the
      // `bits` tail. Allocated HERE because a region cannot be added to a built
      // field, and gated on the shading flag because it is bytes a scene that
      // never turns SRC shading on should not pay: 0.71MB on the gate field,
      // ~14.8MB projected to Sponza-ultra.
      enableSurfaceAttribution: srcShadeEnabled(),
      // Phase 4: complex cells store short exact triangle lists in the same
      // allocation instead of degrading to occupied-box hits.
      enableComplexTriangles: rayHitConfig?.activeMode === RayHitMode.HybridExactComplex,
      // Phase 5: the conservative pyramid ride is the DEFAULT, so `!== false`
      // (not `=== true`) — a caller with no rayHitConfig at all still gets the
      // skip; only an explicit opt-out compiles the no-skip A/B arm.
      rayHitCoarseSkip: rayHitConfig?.enableSkipDistance !== false,
    });
    // BINDING-SIZE DEGRADE LADDER: the bits buffer is ONE binding, and a big
    // ultra scene already sits near 128MB before the optional tails — a real
    // project hit 144MB and every bind group using the buffer failed (GI
    // dark, console full of CreateBindGroup errors). The engine now asks the
    // adapter for a higher maxStorageBufferBindingSize, but on devices that
    // only offer the baseline the optional regions must shrink to fit:
    // static shadow BVH first (shadows fall back to the records marcher),
    // then the exact-dynamic pool.
    const deviceLimit =
      this.engine?.renderer?.backend?.device?.limits?.maxStorageBufferBindingSize ?? 134217728;
    let field = makeField(dynWords, staticBvhWords);
    if (field.bitsBuffer.value.array.byteLength > deviceLimit && staticBvhWords > 0) {
      console.warn(
        `[gi] bits buffer ${(field.bitsBuffer.value.array.byteLength / 1048576).toFixed(0)}MB exceeds the device's ` +
          `${(deviceLimit / 1048576).toFixed(0)}MB storage binding limit — dropping the static shadow BVH (records marcher fallback)`,
      );
      staticBvhPacked = null;
      field = makeField(dynWords, 0);
    }
    if (field.bitsBuffer.value.array.byteLength > deviceLimit && dynWords > 0) {
      console.warn("[gi] bits buffer still over the storage binding limit — disabling exact dynamic objects");
      field = makeField(0, 0);
    }
    for (const p of placements) field.setSlotMatrix(p.slot, p.matrix);
    field.setGeometry(geometries, placements);
    field.placements = placements;

    // Fresh per-build dynamic-object set (GPU state is per-field: region
    // offsets move with the allocation). Adoption KEYS persist across builds
    // in `_dynAdoptedKeys`, so a previously-adopted mover re-enters exact
    // representation immediately — it was excluded from `placements` above
    // and must never voxelize again.
    this._dynSet = null;
    if (dynObjectsOn && field.dynamicObjectWords > 0) {
      this._dynAdoptedKeys ??= new Set();
      this._dynIneligibleKeys?.clear();
      this._dynSet = createDynamicObjectSet({
        bits: field.bitsBuffer,
        baseWord: field.dynamicObjectWordOffset,
        capacityWords: field.dynamicObjectWords,
        // Live, not a snapshot: `_emitterInfos` is rebuilt by #buildEntries on
        // every rescan, and an adopted mover's header is re-published whenever
        // this predicate's answer changes (it is part of the surface stamp). See
        // writeSurface — without this the exact path double-counts a promoted
        // emitter's own emissive, which #slotSurface has always zeroed on the
        // voxel path.
        isPromotedEmitter: (mesh) => this._emitterInfos?.some((e) => e?.mesh === mesh) === true,
      });
      composeFieldDynamics(field, this._dynSet);
      if (staticBvhPacked && field.staticBvhWords > 0) {
        this._dynSet.queueRegionUpload(field.staticBvhWordOffset, staticBvhPacked.words);
        this._dynSet.attachStaticBvh({
          nodeBase: field.staticBvhWordOffset,
          triBase: field.staticBvhWordOffset + staticBvhPacked.nodeWords,
        });
        this._staticBvhCapacity = field.staticBvhWords;
        this._staticBvhStale = null;
      }
      if (this._dynAdoptedKeys.size > 0) this.#readoptDynamicObjects(meshes);
      // Boot marker (the "is my build live" pattern): one line that settles
      // which representation movers get in a running editor.
      console.log(
        `[gi] dynamic-objects: exact movers ON (obb + bvh) — max ${this._dynSet.maxObjects} objects, ` +
          `${(field.dynamicObjectWords * 4 / (1024 * 1024)).toFixed(1)}MB pool, ${this._dynAdoptedKeys.size} adopted` +
          (this._dynSet.staticBvh ? `, static shadow bvh ${(field.staticBvhWords * 4 / (1024 * 1024)).toFixed(1)}MB` : ""),
      );
    }
    return field;
  }

  /**
   * Keeps the exact-dynamic set consistent with the scanned mesh set:
   * a despawned adoptee releases its object slot (its key persists, so a
   * pooled respawn re-adopts instead of re-voxelizing); a respawned adoptee
   * whose entry was released re-enters the set here.
   */
  #reconcileDynamicAdoptions(meshes) {
    const dyn = this._dynSet;
    if (!dyn?.enabled || !this._dynAdoptedKeys?.size) return;
    const present = new Map();
    for (const mesh of meshes) {
      for (const instanceId of this.#placementsOf(mesh)) {
        const key = slotKeyOf(mesh, instanceId);
        if (this._dynAdoptedKeys.has(key)) present.set(key, { mesh, instanceId });
      }
    }
    for (const key of this._dynAdoptedKeys) {
      const here = present.get(key);
      if (!here && dyn.has(key)) {
        dyn.release(key);
      } else if (here && !dyn.has(key)) {
        const shape = this.#classifyForAdoption(key, here.mesh);
        if (shape) dyn.adopt(key, here.mesh, here.instanceId, shape);
        else this._dynAdoptedKeys.delete(key);
      }
    }
  }

  /** classifyDynamicShape with a per-key negative cache (skinned/huge meshes
   *  would otherwise re-classify every motion frame). Tag-aware: a
   *  `userData.giTrace`/`giMobility` tag bypasses and clears the cache so
   *  flipping the Mesh component's GI dropdowns takes effect without a
   *  rebuild — and tag-based rejections ("voxel") are never cached, so
   *  flipping BACK to auto works too. */
  #classifyForAdoption(key, mesh) {
    this._dynIneligibleKeys ??= new Set();
    const tag = mesh?.userData?.giTrace ?? mesh?.userData?.giMobility ?? mesh?.userData?.giDynamic;
    if (tag) this._dynIneligibleKeys.delete(key);
    if (this._dynIneligibleKeys.has(key)) return null;
    const shape = classifyDynamicShape(mesh);
    if (!shape && !tag) this._dynIneligibleKeys.add(key);
    return shape;
  }

  /** Re-adopts persisted keys into a freshly built set (full rebuild path). */
  #readoptDynamicObjects(meshes) {
    for (const mesh of meshes) {
      for (const instanceId of this.#placementsOf(mesh)) {
        const key = slotKeyOf(mesh, instanceId);
        if (!this._dynAdoptedKeys.has(key)) continue;
        const shape = this.#classifyForAdoption(key, mesh);
        if (shape) this._dynSet.adopt(key, mesh, instanceId, shape);
        else this._dynAdoptedKeys.delete(key); // geometry changed under the key
      }
    }
  }

  /**
   * Unique geometries (deduped by content identity, so 200 crates ship one
   * triangle range) + one placement per world instance.
   */
  #occupancyContentOf(meshes) {
    const geometries = [];
    const seen = new Set();
    const placements = [];
    const scratch = new THREE.Matrix4();
    // STABLE slot assignment: a mesh keeps its occupancy slot for the life of
    // the field (map reset in #buildOccupancyField). This is what lets the
    // field's incremental setGeometry treat a spawn as an append and a
    // despawn as a disable — with index-order slots, removing one mesh
    // renumbered every slot after it, which invalidated the static snapshot
    // and the whole per-slot bookkeeping on every scene change.
    const slotMap = (this._occSlotMap ??= new Map());
    // Sub-voxel physics props (see #analyticOnlyMover): no placement, no slot
    // ID, no voxels — they exist as analytic spheres in the mover-occluder
    // bundle. Rebuilt every content scan so despawns fall out with the sweep;
    // the surface is resolved here (scan cadence) because the per-frame
    // bundle sync must not walk a shader-graph material 24 times a frame.
    const analyticOnly = (this._analyticOnlyMovers = []);
    for (const mesh of meshes) {
      if (this.#analyticOnlyMover(mesh)) {
        analyticOnly.push({ mesh, surface: resolveMaterialSurface(mesh.material, mesh.name) });
        continue;
      }
      const record = serializeMeshForBake(mesh);
      if (!record) continue;
      if (!seen.has(record.geometryKey)) {
        seen.add(record.geometryKey);
        geometries.push({ key: record.geometryKey, positions: record.positions, index: record.index });
      }
      for (const instanceId of this.#placementsOf(mesh)) {
        if (placements.length >= MAX_INSTANCE_SLOTS) break;
        const matrix = new THREE.Matrix4();
        if (instanceId == null || !mesh.isInstancedMesh) {
          matrix.copy(mesh.matrixWorld);
        } else {
          mesh.getMatrixAt(instanceId, scratch);
          matrix.copy(scratch).premultiply(mesh.matrixWorld);
        }
        const key = slotKeyOf(mesh, instanceId);
        // Exact-dynamic adoptees never voxelize: no placement, no slot, no
        // bits — their geometry is intersected analytically (dynamicObjects.js).
        if (this._dynAdoptedKeys?.has(key)) continue;
        let slot = slotMap.get(key);
        if (slot == null) {
          slot = this._occSlotNext ?? 0;
          this._occSlotNext = slot + 1;
          slotMap.set(key, slot);
        }
        placements.push({ slot, geometryKey: record.geometryKey, matrix, mesh, instanceId });
      }
    }
    return { geometries, placements };
  }

  /**
   * Re-voxelizes the pyramid for a CHANGED MESH SET (not a changed transform —
   * that is `#refreshOccupancyTransforms`).
   *
   * WITHOUT THIS, LATE-LOADING MESHES NEVER ENTER THE TRANSPORT FIELD AT ALL.
   * Occupancy geometry was uploaded once, inside `#buildOccupancyField`, i.e.
   * only on a full rebuild — while the mesh-SDF path picks up new meshes every
   * fingerprint scan. So a GLB that finished loading after the build was in the
   * SDF atlas and absent from the pyramid, which is the thing every transport
   * ray actually intersects.
   *
   * It was survivable while the composited SDF still carried a distance. In
   * SDF-free mode the pyramid is the ONLY source of both distance and
   * occupancy, so the same gap presents as **no GI at all on a fresh launch** —
   * the field is empty, so nothing is occupied, so nothing bounces.
   */
  #refreshOccupancyContent(meshes) {
    const field = this.state?.volume?.occupancyField;
    if (!field) return;
    this.#reconcileDynamicAdoptions(meshes);
    const { geometries, placements } = this.#occupancyContentOf(meshes);
    // Slots are stable-for-life now, so the binding constraint is the highest
    // slot ID, not the placement count — a long spawn/despawn history can
    // exhaust IDs even with few meshes alive. Capacity is a buffer size fixed
    // at creation; growing past it genuinely needs the rebuild (which resets
    // the slot map and re-derives capacity with headroom).
    const maxSlot = placements.reduce((m, p) => Math.max(m, p.slot), -1);
    if (maxSlot >= field.slotCapacity) {
      console.log(`[gi] occupancy: slot ${maxSlot} exceeds capacity ${field.slotCapacity} — rebuilding`);
      this.requestRebuild();
      return;
    }
    // Placement objects are rebuilt every scan — carry the mover bookkeeping
    // over by slot, and seed BRAND-NEW placements as freshly-moved so the
    // quiet-frames demotion applies to them (the field spawns them on the
    // dynamic side; this is the timer that settles a resting spawn back to
    // static).
    const prevBySlot = new Map((field.placements ?? []).map((p) => [p.slot, p]));
    for (const p of placements) {
      const prev = prevBySlot.get(p.slot);
      p._lastMovedFrame = prev ? prev._lastMovedFrame : this._frame;
    }
    // GEOMETRY FIRST, matrices second — deliberately reversed from the build
    // path. The incremental setGeometry flags a brand-new slot DYNAMIC; only
    // then is its first matrix write a dynamic-slot write. The other order
    // hits setSlotMatrix while the slot still reads static and forces the
    // full re-voxelize this whole path exists to avoid. (Chunk sizing does
    // not depend on the order: setGeometry reads p.matrix, not the uniform.)
    // Did the placement SET actually change? Analytic-only movers
    // (#analyticOnlyMover) churn the MESH set at spawn cadence without ever
    // touching placements — re-arming the static-BVH rebuild for them queued
    // a pointless full rebake 3s after every projectile volley.
    const placementSetChanged =
      placements.length !== (field.placements?.length ?? -1) ||
      placements.some((p) => !prevBySlot.has(p.slot));
    field.setGeometry(geometries, placements);
    for (const p of placements) field.setSlotMatrix(p.slot, p.matrix);
    field.placements = placements;
    // The static shadow BVH bakes world-space triangles — a changed mesh SET
    // means it no longer matches the scene.
    if (placementSetChanged && this._dynSet?.staticBvh) this._staticBvhStale = this._frame;
  }

  /**
   * Re-reads live world matrices into the pyramid's slot uniforms. This is the
   * drag path, and it is deliberately a uniform update + redispatch rather than
   * a geometry reupload: chunk counts were computed rotation-invariantly, so
   * nothing on the CPU has to be rebuilt when something moves.
   */
  /**
   * The mover-occluder uniform bundle the gather applies analytically, created
   * once and refreshed in place by #syncMoverOccluders every frame.
   *
   * Returns null (and the gather compiles WITHOUT the occlusion loop at all)
   * unless `__giDiffuseSkipMovers` is on — the two halves are one change and
   * shipping half of it is strictly worse than shipping neither: rays skipping
   * movers with no analytic term back means movers stop casting indirect
   * shadows entirely, and the analytic term with rays still hitting them means
   * every mover shadow is applied twice.
   */
  #moverOccluders(lightSlots) {
    // PARKED, NOT DEAD — and nothing calls this right now. Its one consumer was
    // the cascade gather (`createIrradianceGather`'s analytic occlusion loop),
    // deleted with the transport, so the bundle is never created and
    // #syncMoverOccluders early-returns every frame at zero cost. It is kept
    // because Phase 1-3 needs exactly this the moment diffuse rays start
    // skipping movers again: the two halves of `__giDiffuseSkipMovers` are ONE
    // change, and shipping either alone is strictly worse than shipping neither
    // (rays skipping movers with no analytic term back = movers cast no indirect
    // shadow; the analytic term with rays still hitting them = every mover
    // shadow applied twice). `giProxySpheres` and run-gi-proxy-fit-test hang off
    // it and stay green meanwhile.
    // DEFAULT ON since 2026-08-08 (both halves flip together — see the
    // transport half's measurement note in giField's createOccupancySceneTrace).
    if (globalThis.__giDiffuseSkipMovers === false) return null;
    const max = 2 * Math.min(64, Math.max(4, Number(globalThis.__giMaxDynamicObjects) || 16));
    this._moverOccluders ??= {
      max,
      count: uniform(0),
      // 2x the mover cap: a capsule proxy spends up to 4 slots on ONE mover, so
      // sizing this to the mover count would silently drop occluders as soon as
      // a couple of characters were on screen.
      //
      // SLOT ENCODING: w > 0 → sphere of radius w (the original record).
      // w < 0 → ORIENTED BOX with bounding radius |w| (the gate), half
      // extents in `halfs` and world rotation in `quats`. Boxes exist because
      // the bounding-sphere proxy painted a smooth normal-dependent gradient
      // across a big box mover's OWN faces (its surface is deep inside its
      // bounding sphere — the user's rotating-cube screenshots, 2026-08-08);
      // the box contour integral is exact for boxes, C¹ under rotation, and
      // IDENTICALLY ZERO for a receiver on the box's own outward surface or
      // inside it, so the self-artifact cannot exist by construction.
      spheres: uniformArray(Array.from({ length: max }, () => new THREE.Vector4()), "vec4"),
      halfs: uniformArray(Array.from({ length: max }, () => new THREE.Vector4()), "vec4"),
      quats: uniformArray(Array.from({ length: max }, () => new THREE.Vector4(0, 0, 0, 1)), "vec4"),
      // Per-occluder DIRECT-LIGHT VISIBILITY, one component per analytic
      // light slot (x = slot 0 …). The analytic bounce used to give a mover
      // its direct term UNSHADOWED ("external shadowing not modelled") —
      // acceptable as a smooth over-estimate until a white cube stood in a
      // dark nave and re-radiated the full sun ("the cube does not consider
      // direct light occluders around it", user screenshot 2026-08-08).
      // Filled by #syncMoverOccluders from ONE CPU shadow ray per
      // (mover × light) per frame against the static-mesh BVH oracle,
      // temporally smoothed so a mover crossing a shadow edge ramps over
      // ~8 frames instead of popping — the only error class this term is
      // allowed to add.
      lightVis: uniformArray(Array.from({ length: max }, () => new THREE.Vector4(1, 1, 1, 1)), "vec4"),
      // Mean albedo / emissive per mover — the same two the dynamic-object
      // header carries at words 34..39 and that giField shades an exact hit
      // with, so both paths agree about a mover's colour.
      albedo: uniformArray(Array.from({ length: max }, () => new THREE.Vector4(1, 1, 1, 0)), "vec4"),
      emissive: uniformArray(Array.from({ length: max }, () => new THREE.Vector4()), "vec4"),
      // The SAME slot objects giField's dynamic shading loops over — shared
      // uniforms, not a copy, so a light edit reaches both paths in one write.
      lightSlots,
    };
    return this._moverOccluders;
  }

  /**
   * World bounding sphere per adopted mover, straight from the bounds the
   * dynamic set already maintains. CURRENT bounds, never the SWEPT ones: the
   * swept box is prev ∪ curr and would make a moving occluder's shadow smear
   * along its path and then snap when the retain factor resets — reintroducing,
   * in the analytic term, exactly the discontinuity this whole change removes.
   *
   * A bounding sphere is EXACT for the sphere movers (the reported repro) and
   * conservative for boxes — a rotating box's shadow will be slightly too round
   * and, notably, will not change as it spins. That is the correct trade for
   * now: a smooth, slightly-wrong shadow beats a sharp, randomly-flickering
   * one, and multi-sphere fitting for elongated shapes is the follow-up.
   */
  /**
   * Lazy, incrementally-built CPU BVH set over the STATIC meshes, for the
   * mover direct-light shadow rays (moverLightVisTarget). One MeshBVH per
   * frame so a Sponza-scale scene amortizes the build over ~a second with no
   * rebuild hitch; until a mesh is in, rays pass through it — i.e. the term
   * converges FROM the old unshadowed behavior, never past it. Keyed on the
   * field object: any structural rebuild (which is what moves static meshes)
   * starts a fresh set. Dynamic-mobility meshes are excluded — they move
   * after the snapshot and a stale pose here would be a ghost occluder.
   * `__giMoverDirectShadow = false` disables the whole term.
   */
  /**
   * A PHYSICS-DRIVEN PROP SMALLER THAN ~A VOXEL never enters the voxel
   * pipeline at all — no occupancy placement, no slot ID, no atlas entry. It
   * exists to the GI as a pure analytic sphere in the mover-occluder bundle
   * (occlusion + albedo/emissive bounce) and as an emitter-promotion
   * candidate.
   *
   * WHY (cannonball probe, 2026-08-08): a 0.36m ball against a 0.34m cell is
   * sub-voxel — voxelizing it ever produced a 1–2 cell blob (the "blocky
   * flicker" class). Worse than useless, it was ruinous: each spawned ball
   * consumed a stable-for-life occupancy slot ID, so a launcher recycling 24
   * balls every 15s exhausted slot capacity in minutes and triggered a FULL
   * GI REBUILD (17s materials + 22s computes measured) mid-game; balls that
   * lost the 16-mover adoption race re-voxelized every frame; the ones that
   * fought for seats forced whole-volume composites through cap-pressure
   * eviction (1 per 90 frames). None of that machinery buys anything a
   * closed-form sphere doesn't do better at this size.
   *
   * Rule: world diameter < minCell × 1.4 (`__giAnalyticMoverMaxCells`
   * overrides the multiplier), not pinned giMobility "static", not
   * instanced, and either carrying a non-fixed rigidbody or pinned
   * giMobility "dynamic". Static small decor keeps the voxel path — it
   * costs nothing per frame and contributes contact darkening.
   * `__giAnalyticSmallMovers = false` disables the class entirely (A/B).
   */
  #analyticOnlyMover(mesh) {
    if (globalThis.__giAnalyticSmallMovers === false) return false;
    const cell = this.state?.volume?.minCell ?? 0;
    if (!(cell > 0)) return false;
    if (!mesh || mesh.isInstancedMesh) return false;
    const mobility = mesh.userData?.giMobility ?? "auto";
    if (mobility === "static") return false;
    const g = mesh.geometry;
    if (!g?.attributes?.position) return false;
    if (!g.boundingSphere) g.computeBoundingSphere();
    mesh.getWorldScale(_obbScale);
    const diameter =
      2 * (g.boundingSphere?.radius ?? 0) *
      Math.max(Math.abs(_obbScale.x), Math.abs(_obbScale.y), Math.abs(_obbScale.z));
    const maxCells = Number(globalThis.__giAnalyticMoverMaxCells) || 1.4;
    if (!(diameter > 0) || diameter >= cell * maxCells) return false;
    if (mobility === "dynamic") return true;
    const entity = this.engine?.entities?.get?.(mesh.userData?.entityId);
    const body = entity?.getComponent?.("rigidbody");
    if (!body) return false;
    const bodyType = body.bodyType ?? body.props?.bodyType;
    return bodyType === "dynamic" || bodyType === "kinematic";
  }

  #moverShadowOracle() {
    if (globalThis.__giMoverDirectShadow === false) return null;
    const field = this.state?.volume?.occupancyField;
    const placements = field?.placements;
    if (!placements) return null;
    let o = this._moverShadowOracle;
    if (!o || o.key !== field) {
      const seen = new Set();
      const queue = [];
      for (const p of placements) {
        const mesh = p.mesh;
        if (!mesh || mesh.isInstancedMesh || seen.has(mesh)) continue;
        seen.add(mesh);
        if ((mesh.userData?.giMobility ?? "auto") === "dynamic") continue;
        if (!mesh.geometry?.attributes?.position) continue;
        queue.push(mesh);
      }
      o = this._moverShadowOracle = { key: field, queue, ready: [] };
    }
    if (o.queue.length) {
      const mesh = o.queue.shift();
      try {
        // Session-cached per geometry (see moverOracleBvhCache) — a re-key
        // after a structural rebuild costs matrix inverts, not BVH builds.
        let bvh = moverOracleBvhCache.get(mesh.geometry);
        if (!bvh) {
          bvh = new MeshBVH(mesh.geometry);
          moverOracleBvhCache.set(mesh.geometry, bvh);
        }
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        o.ready.push({
          bvh,
          mesh,
          inv: new THREE.Matrix4().copy(mesh.matrixWorld).invert(),
          // For the per-ray slab pre-reject. Static meshes by construction
          // (dynamic-mobility ones are excluded above), so a snapshot is safe.
          worldBox: new THREE.Box3().copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld),
        });
      } catch {
        // A geometry MeshBVH cannot digest simply stays un-shadowing.
      }
    }
    // A mesh ADOPTED as an exact mover after this snapshot still sits here at
    // its build pose — a ghost occluder (a knocked-away crate would keep
    // shadowing its old corner). Skip-flag, refreshed per frame, instead of a
    // re-key: adoption churn is play-mode-normal and the flag is ~55 Set
    // lookups.
    for (const e of o.ready) {
      e.skip = this._dynAdoptedKeys?.has(slotKeyOf(e.mesh, null)) === true;
    }
    return o;
  }

  #syncMoverOccluders() {
    const bundle = this._moverOccluders;
    if (!bundle) return;
    const dyn = this._dynSet;
    const oracle = this.#moverShadowOracle();
    // ── CANDIDATES, TWO SOURCES, SEATED BY VISUAL WEIGHT ────────────────────
    // The gather loop runs per resolve PIXEL, so every seat here is paid at
    // screen resolution — and the first shipped version seated first-come
    // until the array filled. With 15 crates + 24 cannonballs the cap became
    // an arbitrary lottery AND the pixel loop ran full-length. Candidates are
    // now ranked by projected size at the camera (boundR / distance) and only
    // the top `__giMaxAnalyticOccluders` (default 16) are seated; the tail is
    // exactly the movers whose occlusion the projected-size fade in the
    // gather would have erased anyway.
    const cand = (this._moverOccCand ??= []);
    cand.length = 0;
    const cam = this.engine?.camera;
    if (cam?.getWorldPosition) cam.getWorldPosition(_mocCamera);
    else _mocCamera.set(0, 0, 0);
    const prioOf = (cx, cy, cz, r) => {
      const dx = cx - _mocCamera.x;
      const dy = cy - _mocCamera.y;
      const dz = cz - _mocCamera.z;
      return r / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.5);
    };
    if (dyn?.enabled && dyn.forEachEntry) {
      dyn.forEachEntry((entry) => {
        if (!entry?.boundsValid || entry.active === false) return;
        const b = entry.currBounds;
        if (!b || b.isEmpty?.()) return;
        _msoBoundsC.copy(b.min).add(b.max).multiplyScalar(0.5);
        const rB = _msoBoundsS.copy(b.max).sub(b.min).length() * 0.5;
        if (!(rB > 1e-4)) return;
        cand.push({
          entry,
          mesh: null,
          surface: null,
          cx: _msoBoundsC.x, cy: _msoBoundsC.y, cz: _msoBoundsC.z,
          r: rB,
          prio: prioOf(_msoBoundsC.x, _msoBoundsC.y, _msoBoundsC.z, rB),
        });
      });
    }
    // Sub-voxel analytic-only movers (#analyticOnlyMover): never voxelized,
    // never adopted — this bundle is their ENTIRE existence to the GI.
    for (const rec of this._analyticOnlyMovers ?? []) {
      const mesh = rec.mesh;
      if (!mesh || !mesh.parent || mesh.visible === false) continue;
      const bs = mesh.geometry?.boundingSphere;
      if (!bs) continue;
      _mocCenter.copy(bs.center).applyMatrix4(mesh.matrixWorld);
      mesh.getWorldScale(_obbScale);
      const rW =
        bs.radius * Math.max(Math.abs(_obbScale.x), Math.abs(_obbScale.y), Math.abs(_obbScale.z));
      if (!(rW > 1e-4)) continue;
      cand.push({
        entry: null,
        mesh,
        surface: rec.surface,
        cx: _mocCenter.x, cy: _mocCenter.y, cz: _mocCenter.z,
        r: rW,
        prio: prioOf(_mocCenter.x, _mocCenter.y, _mocCenter.z, rW),
      });
    }
    cand.sort((a, b) => b.prio - a.prio);
    const seatCap = Math.min(
      bundle.max,
      Math.max(1, Number(globalThis.__giMaxAnalyticOccluders) || 16),
    );
    const slots = bundle.lightSlots ?? [];
    const lightCount = Math.min(4, slots.length);
    const frame = this._frame ?? 0;
    // Direct-light visibility rays are STAGGERED: each seated mover re-asks
    // the oracle every 4th frame (stable per-mover phase), smoothed at 0.45
    // per update ≈ the old 0.2-per-frame ramp. The rays were the sync loop's
    // whole CPU cost — movers × lights × every static BVH, every frame.
    const visFor = (holder, boundR) => {
      const vis = (holder._giLightVis ??= [1, 1, 1, 1]);
      if (!oracle) return vis;
      const phase = (holder._giVisPhase ??= (this._moverVisPhase = ((this._moverVisPhase ?? 0) + 1) & 3));
      if ((frame & 3) === phase) {
        for (let li = 0; li < lightCount; li++) {
          const target = moverLightVisTarget(oracle, _msoBoundsC, boundR, slots[li]);
          vis[li] += (target - vis[li]) * 0.45;
        }
      }
      return vis;
    };
    let n = 0;
    const promoted = this._promotedEmitterMeshes;
    for (const c of cand) {
      if (n >= seatCap) break;
      _msoBoundsC.set(c.cx, c.cy, c.cz);
      if (c.entry) {
        const entry = c.entry;
        const vis = visFor(entry, c.r);
        // ORIENTED-BOX record where the shape allows it (see the bundle's
        // slot-encoding note): exact for box movers, tight for arbitrary
        // meshes, and free of the bounding-sphere proxy's on-body gradient.
        // Spheres keep their exact sphere; user-pinned sphere/capsule proxies
        // are respected; instanced movers keep the AABB chain (their world
        // matrix is per instance and not worth the decompose here).
        if (moverObbRecord(entry, emitterFitScratch)) {
          const r = emitterFitScratch;
          const a2 = entry.surface?.albedo;
          const e2 = entry.surface?.emissive;
          bundle.spheres.array[n].set(r.center.x, r.center.y, r.center.z, -r.radius);
          bundle.halfs.array[n].set(r.half.x, r.half.y, r.half.z, 0);
          bundle.quats.array[n].copy(moverObbQuat);
          bundle.albedo.array[n].set(a2?.[0] ?? 1, a2?.[1] ?? 1, a2?.[2] ?? 1, 0);
          bundle.emissive.array[n].set(e2?.[0] ?? 0, e2?.[1] ?? 0, e2?.[2] ?? 0, 0);
          bundle.lightVis.array[n].set(vis[0], vis[1], vis[2], vis[3]);
          n++;
          continue;
        }
        const spheres = giProxySpheres(entry.mesh, entry.currBounds, seatCap - n, entry.type);
        if (!spheres.length) continue;
        // Colour, so the mover's BOUNCE comes back with it. `entry.surface` is
        // the diagnostics mirror writeSurface keeps of exactly the words the
        // header carries, so this cannot drift from what the exact-hit path
        // shades with. A promoted emitter's emissive is already zeroed there
        // (isPromotedEmitter), which keeps the analytic emitter slot from being
        // double-counted here too.
        const a = entry.surface?.albedo;
        const e = entry.surface?.emissive;
        // ONE mover can occupy SEVERAL slots (a capsule is spheres along a
        // segment), and every one of them carries that mover's colour — the
        // shader has no notion of "these three belong together", it just sums
        // spheres.
        for (const s of spheres) {
          bundle.spheres.array[n].set(s[0], s[1], s[2], s[3]);
          bundle.albedo.array[n].set(a?.[0] ?? 1, a?.[1] ?? 1, a?.[2] ?? 1, 0);
          bundle.emissive.array[n].set(e?.[0] ?? 0, e?.[1] ?? 0, e?.[2] ?? 0, 0);
          bundle.lightVis.array[n].set(vis[0], vis[1], vis[2], vis[3]);
          n++;
        }
        continue;
      }
      // Analytic-only: one exact sphere. Emissive comes from the scan-time
      // surface — ZEROED while the mesh holds an emitter seat, or its light
      // would arrive twice (once analytic-direct, once as bounce).
      const holder = (this._analyticOnlyState ??= new WeakMap());
      let st = holder.get(c.mesh);
      if (!st) holder.set(c.mesh, (st = {}));
      const vis = visFor(st, c.r);
      const surf = c.surface;
      const isSeatedEmitter = promoted ? promoted.indexOf(c.mesh) !== -1 : false;
      const ei = surf?.emissiveIntensity ?? 1;
      bundle.spheres.array[n].set(c.cx, c.cy, c.cz, c.r);
      bundle.albedo.array[n].set(surf?.color?.r ?? 1, surf?.color?.g ?? 1, surf?.color?.b ?? 1, 0);
      bundle.emissive.array[n].set(
        isSeatedEmitter ? 0 : (surf?.emissive?.r ?? 0) * ei,
        isSeatedEmitter ? 0 : (surf?.emissive?.g ?? 0) * ei,
        isSeatedEmitter ? 0 : (surf?.emissive?.b ?? 0) * ei,
        0,
      );
      bundle.lightVis.array[n].set(vis[0], vis[1], vis[2], vis[3]);
      n++;
    }
    // Zero the tail: a stale radius in an unused slot is a shadow cast by an
    // object that no longer exists, and the loop's count gate is the only
    // thing standing between that and the screen.
    for (let i = n; i < bundle.max; i++) bundle.spheres.array[i].set(0, 0, 0, 0);
    bundle.albedo.needsUpdate = true;
    bundle.emissive.needsUpdate = true;
    bundle.count.value = n;
    bundle.spheres.needsUpdate = true;
    bundle.halfs.needsUpdate = true;
    bundle.quats.needsUpdate = true;
    bundle.lightVis.needsUpdate = true;
  }

  #refreshOccupancyTransforms(field) {
    if (!field?.placements) return;
    const scratch = new THREE.Matrix4();
    for (const p of field.placements) {
      const { mesh, instanceId } = p;
      // Exact-dynamic adoptees: the slot is parked (or parking — see the
      // deferred disable in #refreshDynamicObjects) and the object's live
      // transform is the dynamic set's job. Touching the voxel path again
      // would re-create exactly the per-frame rebuild this exists to remove.
      if (p._giAnalytic) continue;
      // MOBILITY, not representation (the two-axis split). "dynamic" adopts
      // WITHOUT waiting for motion, so the purge re-voxelize lands at load
      // instead of on the first gameplay frame that moves the object.
      // "static" never adopts: it keeps the voxel field for radiance AND its
      // triangles in the world static shadow BVH, which is where exact
      // silhouettes come from for free. "auto" keeps the motion trigger below.
      // Choosing a TRACE representation no longer drags an object in here —
      // that conflation is what put 30 static Sponza meshes (the user's
      // 2026-08-06 scene) into the per-ray mover loop, 16 of them adopted at
      // the cap, and cost every shadow ray 16 object BVHs instead of one.
      // "static" MEANS "NEVER ADOPT AS AN EXACT MOVER" — IT DOES NOT MEAN
      // "IGNORE THE TRANSFORM". Until 2026-08-07 this read
      //     if (mobility === "static") continue;
      // which skipped the whole block INCLUDING the matrix comparison, so a
      // static-mobility mesh that actually moved never updated its occupancy
      // footprint at all. It stayed frozen at its last-baked pose until some
      // UNRELATED change (another mesh's material, an add/remove, a scene load)
      // happened to run #refreshOccupancyContent, which re-reads every
      // placement's matrixWorld and re-voxelizes the whole static side in one
      // step — so the object's bounced light sat wrong for an arbitrary time and
      // then teleported. That is the user's "indirect light still jumps from
      // revoxelization when moving a standard object", and every mesh in their
      // Sponza carries giMobility "static".
      //
      // It also cannot be smoothed away: occupancy transitions deliberately
      // bypass every temporal EMA in the module (cascadeGather's `wasEmpty` ->
      // alpha 0, and the bake ingest's occupancy-flip snap), because geometry
      // presence is binary and blending it would make a mover's leading edge
      // fade up from black.
      //
      // The perf reason the skip existed is real but narrower than the skip:
      // adopting ~30 static Sponza meshes as exact movers cost every shadow ray
      // 16 object BVHs instead of one. That argues against ADOPTION, which is
      // what is now skipped. A moved static mesh takes the voxel static/dynamic
      // split below instead — bounded cost, re-voxelizes only its own slot per
      // frame of motion, and demotes back to the static snapshot after
      // OCC_DYNAMIC_QUIET_FRAMES.
      const mobility = giMobilityOf(p.mesh);
      if (mobility === "dynamic" && this.#tryAdoptDynamic(p, false)) continue;
      let changed = false;
      if (instanceId == null || !mesh.isInstancedMesh) {
        changed = !p.matrix.equals(mesh.matrixWorld);
        if (changed) p.matrix.copy(mesh.matrixWorld);
      } else {
        mesh.getMatrixAt(instanceId, scratch);
        scratch.premultiply(mesh.matrixWorld);
        changed = !p.matrix.equals(scratch);
        if (changed) p.matrix.copy(scratch);
      }
      if (changed) {
        // FIRST MOTION = ADOPTION POINT for exact dynamic objects: a mover
        // that classifies (box → analytic OBB, other rigid mesh → BVH4)
        // leaves the voxel path here, permanently — its silhouette stops
        // being a per-frame voxel-membership function, which was the
        // measured popping mechanism (sessions 31/31d). Ineligible movers
        // (skinned, over-budget, set full) keep the voxel split below — as does
        // anything the author pinned "static", which is the entire meaning of
        // that setting (see the note above; it used to skip the transform too).
        if (mobility !== "static" && this.#tryAdoptDynamic(p, true)) continue;
        // Static/dynamic split (occupancyField.staticBits): flag the mover
        // DYNAMIC *before* the matrix write — the flag flip re-snapshots the
        // static side once, and every further frame of this motion replays
        // that snapshot + re-voxelizes only this slot (the measured
        // +3.3/+5.2ms-per-frame full-scene pass gone). Demotion below has a
        // quiet-period hysteresis so a stop-start animation doesn't thrash
        // full re-voxelizes.
        field.setSlotDynamic?.(p.slot, true);
        field.setSlotMatrix(p.slot, p.matrix);
        p._lastMovedFrame = this._frame;
      } else if (
        p._lastMovedFrame != null &&
        this._frame - p._lastMovedFrame > OCC_DYNAMIC_QUIET_FRAMES
      ) {
        field.setSlotDynamic?.(p.slot, false);
        p._lastMovedFrame = null;
      }
    }
  }

  /**
   * Per-frame exact-dynamic upkeep: transform sync into the header mirror,
   * header/geometry compute dispatch (with skipped-pipeline retry — the same
   * async-compile reality the spawn-blink guard documents), and the deferred
   * voxel-slot parking that makes adoption a one-frame voxel→exact swap.
   */
  #refreshDynamicObjects(renderer, state) {
    const dyn = this._dynSet;
    if (!dyn?.enabled) return;
    // LIVE TAG FLIPS (the Mesh component's "GI Dynamic" dropdown → the mesh's
    // userData): an adopted mover whose tag no longer matches its
    // representation releases its exact slot. "voxel" returns it to the voxel
    // path (the forced rescan below re-voxelizes it); a class change
    // ("bvh"/"obb") re-adopts under the new classification on its next
    // motion frame. ≤16 entries, one string compare each — per-frame is free.
    if (dyn.count() > 0) {
      // REST DEMOTION (edit mode only): an "auto"-adopted mover that has sat
      // still long enough returns to the voxel path — layout drags must not
      // permanently consume dynamic slots or cost the static-path AO. Play
      // mode keeps adoptions sticky: gameplay movers move again, and a
      // periodic mover (an elevator pausing between trips) must not thrash
      // adopt/demote re-voxelizes mid-game. Pinned tags never demote.
      const demoteAfter = Number(globalThis.__giDynDemoteFrames) || 1800;
      const canDemote = !this.engine?.playing;
      let released = false;
      dyn.forEachEntry((entry) => {
        // Two axes, two release reasons: MOBILITY flipped to static (or the
        // mover rested out of an "auto" adoption), or the TRACE representation
        // no longer matches what the entry was adopted as.
        const mobility = giMobilityOf(entry.mesh);
        const trace = giTraceOf(entry.mesh);
        const pinned = mobility === "dynamic";
        const mismatch =
          mobility === "static" || trace === "voxel" ||
          (trace === "bvh" && entry.type !== "mesh") ||
          (trace === "obb" && entry.type !== "obb");
        const resting = canDemote && !pinned && (entry.restFrames ?? 0) > demoteAfter;
        if (!mismatch && !resting) return;
        if (globalThis.__giDynObjectsDebug) {
          console.log(
            `[gi] dynamic-objects: released "${entry.mesh?.name}" ` +
              (mismatch
                ? `(mobility "${mobility}" / trace "${trace}" vs ${entry.type})`
                : `(rested ${entry.restFrames} frames)`),
          );
        }
        if (this.#releaseAdoptee(entry.key)) released = true;
      });
      if (released) {
        // Force the next fingerprint scan to run its content pass — the
        // un-adopted mesh needs its placement + bits back, and nothing else
        // signals that (userData is not in the fingerprint) — and re-arm the
        // refresh branch, which is the only place the pyramid chain DISPATCHES
        // (the same trigger the park path needs).
        this._fingerprint = null;
        this._fieldReadyOnce = false;
        // The released mesh's static-BVH triangles are at the BUILD pose —
        // stale if it moved. Rebuild the static BVH at current poses
        // (debounced; edit-mode only, where demotions happen).
        if (dyn.staticBvh) this._staticBvhStale = this._frame;
        if (globalThis.__giDynObjectsDebug) {
          const f = state.volume?.occupancyField;
          console.log(`[gi] dynamic-objects: revive state — dispatches=${f?.stats?.dispatches} isDirty=${f?.isDirty} dynSlots=${f?.placements?.length}`);
        }
      }
    }
    this.#maybeRebuildStaticBvh(state);
    const world = state.volume?.world;
    const cellRaw = world?.cellMax;
    const cell = typeof cellRaw === "number" ? cellRaw : (typeof cellRaw?.value === "number" ? cellRaw.value : 0.35);
    dyn.sync(cell * 1.5);
    const pending = dyn.pendingDispatch();
    if (pending.length > 0) giCompute(renderer, pending);
    const live = dyn.confirmDispatch(giSkippedComputes);
    // Park the adoptees' voxel slots only once the exact side is actually
    // live on the GPU — until then the frozen bits stand in.
    if (live && this._dynPendingDisable?.length) {
      const field = state.volume?.occupancyField;
      for (const slot of this._dynPendingDisable) field?.setSlotEnabled?.(slot, false);
      this._dynPendingDisable.length = 0;
      // The pyramid chain only DISPATCHES inside the refresh branch, and an
      // adopted mover no longer bumps the atlas — without this the disable marks
      // the field dirty and nothing ever consumes it, leaving the mover's stale
      // bits in the world forever (measured: the dynobj=2 smoke arm's occupancy
      // never dropped). One forced refresh purges the bits.
      this._fieldReadyOnce = false;
    }
    // SURFACE RADIANCE CACHE, after the header sync AND gated on it: the
    // lighting pass fires a ray per texel through the object header, so on a
    // frame where the header has not landed every card would come back a miss
    // and get lit as flat near-plane geometry. `live` is the same signal the
    // voxel-slot parking waits for, and for the same reason.
  }

  /**
   * Debounced static-shadow-BVH rebuild at CURRENT poses — after demotions
   * (whose static triangles went stale the moment the mesh first moved) and
   * content changes. Excludes adopted placements; the mask resets to empty
   * because the fresh soup simply omits them.
   */
  #maybeRebuildStaticBvh(state) {
    const dyn = this._dynSet;
    if (this._staticBvhStale == null || !dyn?.staticBvh) return;
    if (this._frame - this._staticBvhStale < 180) return;
    this._staticBvhStale = null;
    const field = state.volume?.occupancyField;
    if (!field?.placements) return;
    const t0 = performance.now();
    const items = [];
    for (const p of field.placements) {
      if (p._giAnalytic) continue;
      if (this._dynAdoptedKeys?.has(slotKeyOf(p.mesh, p.instanceId))) continue;
      const record = serializeMeshForBake(p.mesh);
      if (!record) continue;
      items.push({ positions: record.positions, index: record.index, matrix: p.matrix, slot: p.slot });
    }
    const packed = items.length ? buildStaticSceneBvhWords(items, staticBvhStrategy()) : null;
    if (!packed) return;
    this._staticBvhPacked = packed;
    if (packed.words.length > (this._staticBvhCapacity ?? 0)) {
      console.warn(
        `[gi] static shadow bvh: rebuild needs ${packed.words.length} words > ${this._staticBvhCapacity} capacity — ` +
          "keeping the stale BVH (new content shadows arrive on the next full GI rebuild)",
      );
      return;
    }
    dyn.queueRegionUpload(field.staticBvhWordOffset, packed.words);
    dyn.attachStaticBvh({
      nodeBase: field.staticBvhWordOffset,
      triBase: field.staticBvhWordOffset + packed.nodeWords,
    });
    dyn.resetStaticMask([]);
    // ALWAYS LOGGED, not behind the debug flag: this is a SYNCHRONOUS
    // main-thread stall of hundreds of milliseconds (262k tris ≈ 200ms center
    // / 600ms SAH on the user's Sponza). A rebuild that fires on a timer is
    // indistinguishable from "the editor is lagging", and the only way to tell
    // a one-off from a loop is to see them in the console.
    this._staticBvhRebuilds = (this._staticBvhRebuilds ?? 0) + 1;
    console.log(
      `[gi] static shadow bvh: rebuild #${this._staticBvhRebuilds} — ` +
        `${packed.triCount} tris in ${(performance.now() - t0).toFixed(0)}ms`,
    );
  }

  /**
   * Adopts a moving placement into the exact-dynamic set. The occupancy slot
   * is NOT parked yet — the header/geometry kernels compile async, and until
   * they have actually dispatched the object would have no representation at
   * all. The placement freezes at its pre-motion pose (marked _giAnalytic so
   * the voxel path stops updating it) and #refreshDynamicObjects swaps the
   * frozen bits for the live exact shape the moment the GPU side is ready —
   * a one-frame voxel→exact swap instead of a blink.
   */
  #tryAdoptDynamic(p, moving = false) {
    const dyn = this._dynSet;
    if (!dyn?.enabled) return false;
    const key = slotKeyOf(p.mesh, p.instanceId);
    if (this._dynAdoptedKeys.has(key)) return true; // already ours
    // Post-demotion cooldown: a just-demoted mesh needs its voxel bits back
    // through a few normal mover frames before it may re-adopt, or a single
    // stray motion frame right after demotion ping-pongs the representations.
    const cooldownUntil = this._dynCooldown?.get(key);
    if (cooldownUntil != null) {
      if (this._frame < cooldownUntil) return false;
      this._dynCooldown.delete(key);
    }
    const shape = this.#classifyForAdoption(key, p.mesh);
    if (!shape) return false;
    if (!dyn.adopt(key, p.mesh, p.instanceId, shape)) {
      // CAP PRESSURE EVICTION. Before declaring defeat, take a slot back from
      // something that is not using it. The two rest-demotion guards below
      // (#refreshDynamicObjects) are deliberately conservative — a pinned
      // "dynamic" tag never demotes, and nothing demotes in play mode — and
      // both are right when there is room. Under a FULL cap they are exactly
      // wrong: they hold the cliff shut against the objects that actually
      // move. The user's real scene is the case — 15 stationary crates pinned
      // "dynamic" holding 15 of 16 slots in PLAY MODE while spawned balls,
      // the only things moving, lost every race and re-voxelized per frame.
      //
      // Only ever evicts a mover that has been still for `restNeeded` frames,
      // longest-resting first, and only to seat one that is moving right now,
      // so an uncontended scene reaches none of this. `evictCooldown` bounds
      // the churn: a release forces a whole-volume composite, so a thrashing
      // evict/re-adopt loop would cost more than the cap ever did.
      // ONLY FOR A MESH THAT MOVED THIS FRAME. The two call sites are already
      // the distinction that matters: the eager-pin path adopts on the tag
      // alone, while this one fires inside `if (changed)`. Evicting for a
      // pinned-but-stationary mesh turns the cap into a CAROUSEL — measured
      // on a rig with 20 stationary pinned meshes and 16 slots: an eviction
      // every cooldown window, forever, each forcing a whole-volume
      // composite. A slot is only worth taking from a resting mover to give
      // to one that is actually in motion.
      const evicted = moving && this.#evictRestingMover(key);
      if (evicted && dyn.adopt(key, p.mesh, p.instanceId, shape)) {
        this._dynAdoptedKeys.add(key);
        p._giAnalytic = true;
        p._lastMovedFrame = null;
        (this._dynPendingDisable ??= []).push(p.slot);
        dyn.setStaticMaskBit(p.slot, true);
        return true;
      }
      // THE CAP IS A CLIFF, AND IT USED TO BE SILENT. Every adopted mover is
      // tested by EVERY shadow/GI ray (the set is a linear loop of OBB tests
      // + per-object BVH descents), so a scene that pins its architecture as
      // movers pays for it on every ray — while the meshes that lost the race
      // also lost their static-BVH triangles. This was the user's 2026-08-06
      // "lagging as hell": 30 meshes tagged mobility=dynamic, 16 adopted.
      if (!this._dynCapWarned) {
        this._dynCapWarned = true;
        // NAME THE FREELOADERS. A bare "cap reached" sends the user hunting
        // through the hierarchy; the meshes actually worth retagging are the
        // ones holding a slot while never having moved, and the set knows
        // exactly which those are. (Measured on the user's real project
        // 2026-08-07: 15 of 16 slots held by stationary crates pinned
        // "dynamic", with one genuinely rotating cube — and `p.mesh` here is
        // the one that lost the race.)
        const idle = [];
        dyn.forEachEntry((e) => {
          if ((e.movedFrames ?? 0) === 0 && !e.boundsValid) idle.push(e.mesh?.name || "(unnamed)");
        });
        console.warn(
          `[gi] dynamic-objects: mover cap reached (${dyn.maxObjects}) — "${p.mesh?.name || "a mesh"}" ` +
            "lost the race and stays voxelized (it will re-voxelize every frame it moves, which reads as " +
            "blocky flickering light). Every mover costs EVERY ray, so set GI Mobility to \"static\" " +
            "(or \"auto\") on anything that does not actually move. Static geometry already gets exact " +
            "triangle shadows from the world static BVH; GI Trace \"bvh\" does NOT require Mobility " +
            "\"dynamic\"." +
            (idle.length
              ? ` Holding slots without ever having moved: ${idle.slice(0, 20).join(", ")}${idle.length > 20 ? ` (+${idle.length - 20} more)` : ""}.`
              : ""),
        );
      }
      return false;
    }
    this._dynAdoptedKeys.add(key);
    p._giAnalytic = true;
    p._lastMovedFrame = null;
    (this._dynPendingDisable ??= []).push(p.slot);
    // Mask its triangles out of the static shadow BVH the same frame — the
    // exact dynamic object takes over; the static copy would ghost at its
    // build pose otherwise.
    dyn.setStaticMaskBit(p.slot, true);
    // Leave the composite immediately too (the #syncSlots filter only runs on
    // fingerprint scans): clearing the atlas slot purges the mover from the
    // distance field in one composite and stops its rotation from bumping the
    // atlas revision every frame thereafter.
    const atlas = this.state?.atlas;
    if (atlas?.assignments) {
      for (let i = 0; i < atlas.assignments.length; i++) {
        if (atlas.assignments[i]?.key === key) { atlas.clearSlot(i); break; }
      }
    }
    return true;
  }

  /**
   * Releases ONE adoptee back to the voxel path: drops its exact slot, arms a
   * re-adoption cooldown, and revives its placement in place at the CURRENT
   * pose. Shared by rest demotion and cap-pressure eviction — the two paths
   * used to be one inline block, and a second copy of the pose-sync below is
   * exactly the kind of divergence that produces a demote→re-adopt ping-pong.
   *
   * The caller owns the post-release invalidation (fingerprint / composite /
   * static-BVH staleness), because rest demotion batches it across a whole
   * sweep while eviction releases exactly one.
   */
  #releaseAdoptee(key) {
    const dyn = this._dynSet;
    if (!dyn?.enabled) return false;
    dyn.release(key);
    this._dynAdoptedKeys.delete(key);
    (this._dynCooldown ??= new Map()).set(key, this._frame + 300);
    // If the placement survived (no content refresh ran since adoption),
    // revive it in place: back on the voxel path as a dynamic slot (the
    // quiet-frames demotion settles it static later). A removed placement
    // is re-created by the caller's forced rescan instead.
    const field = this.state?.volume?.occupancyField;
    const placement = field?.placements?.find(
      (pl) => slotKeyOf(pl.mesh, pl.instanceId) === key,
    );
    if (placement) {
      placement._giAnalytic = false;
      placement._lastMovedFrame = this._frame;
      // Sync the frozen placement matrix (and the slot uniform, which still
      // holds the pre-adoption pose) to the CURRENT pose — without this the
      // next transforms tick reads a phantom "changed" and re-adopts the
      // resting mesh before it ever re-voxelizes (measured: the dynobj=8 arm
      // ping-ponged demote→re-adopt and the bits never returned).
      if (placement.instanceId == null || !placement.mesh.isInstancedMesh) {
        placement.matrix.copy(placement.mesh.matrixWorld);
      } else {
        placement.mesh.getMatrixAt(placement.instanceId, placement.matrix);
        placement.matrix.premultiply(placement.mesh.matrixWorld);
      }
      field.setSlotEnabled?.(placement.slot, true);
      field.setSlotMatrix?.(placement.slot, placement.matrix);
    }
    return true;
  }

  /**
   * Frees one exact-mover slot by releasing the LONGEST-RESTING adoptee, so a
   * mesh that is moving right now can take it. Returns true if a slot was
   * freed. See the call site in #tryAdoptDynamic for why this overrides the
   * normal demotion guards.
   *
   * `restFrames` is the set's own per-entry counter — the same one the
   * edit-mode rest demotion reads — so "not using its slot" is measured from
   * frames, not from the mesh's tag.
   */
  #evictRestingMover(wantKey) {
    const dyn = this._dynSet;
    if (!dyn?.enabled) return false;
    // One eviction per cooldown window. A release forces a whole-volume
    // composite (see the release path), which is far too expensive to run on
    // every refused adoption in a scene that is simply over budget.
    const cooldown = Number(globalThis.__giDynEvictCooldown) || 90;
    if (this._dynLastEvictFrame != null && this._frame - this._dynLastEvictFrame < cooldown) return false;
    // Long enough that a mover pausing mid-trip (an elevator at a floor, a
    // ball at the top of its arc) is never evicted out from under itself.
    const restNeeded = Number(globalThis.__giDynEvictRestFrames) || 240;
    let victim = null;
    dyn.forEachEntry((entry) => {
      if (entry.key === wantKey) return;
      const rest = entry.restFrames ?? 0;
      if (rest < restNeeded) return;
      if (!victim || rest > victim.restFrames) victim = entry;
    });
    if (!victim) return false;
    if (globalThis.__giDynObjectsDebug) {
      console.log(
        `[gi] dynamic-objects: evicting "${victim.mesh?.name || "(unnamed)"}" ` +
          `(rested ${victim.restFrames} frames) to seat a mover that is actually moving`,
      );
    }
    this.#releaseAdoptee(victim.key);
    // Same post-release invalidation the rest-demotion sweep runs: the evicted
    // mesh needs its placement + bits back, and the pyramid chain only
    // DISPATCHES inside the refresh branch.
    this._fingerprint = null;
    this._fieldReadyOnce = false;
    if (dyn.staticBvh) this._staticBvhStale = this._frame;
    this._dynLastEvictFrame = this._frame;
    return true;
  }

  /** Debug "Occupancy" view: a volume box hierarchical-DDA-ing the pyramid. */
  #buildOccupancyView(volume, bounds, center) {
    if (!volume.occupancyField) return null;
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      createSrcOccupancyView(volume),
    );
    mesh.position.copy(center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9999;
    mesh.userData.__giDebug = true;
    return mesh;
  }

  /**
   * Debug "SDF" view: a volume box sphere-tracing the DISTANCE ORACLE (§12.6 —
   * it marched the composited texture, which was only this oracle low-passed
   * onto the radiance lattice, and died with the transport). Returns null
   * without an occupancy field, which is the only state with no distance at all.
   */
  #buildSdfView(volume, bounds, center) {
    if (!volume.distance) return null;
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      createSrcDistanceView(volume),
    );
    mesh.position.copy(center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9999;
    mesh.userData.__giDebug = true;
    return mesh;
  }
}
