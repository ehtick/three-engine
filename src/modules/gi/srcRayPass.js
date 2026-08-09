// SPLIT RADIANCE CASCADES — the first traced rays, and nothing more.
//
// This is Phase 2 unit 1 (plan §12.13.5): the commit that gives `srcTrace.js` a
// CALLER. It is deliberately a scaffold and it is deliberately its own file, so
// that units 2-4 can delete it in one line rather than unpick it from a kernel
// that grew around it.
//
// ══ WHAT IT IS FOR, WHICH IS NOT LIGHT ═════════════════════════════════════
//
// Nothing here deposits, merges or shades. One ray per gbuffer pixel that owns a
// c0 probe, traced against the occupancy medium, and the only things written are
// counters. That sounds like a test, and it is — but it is a test that can only
// exist in the engine, because the thing being proved is that the SRC ray class
// and the shipping ray classes traverse the SAME medium with the SAME budgets:
//
//   · `profile: true` in `createSrcSceneTrace` is the module's ONLY profiled
//     trace since the dense transport died (§12.8). With no caller, the ray-hit
//     counters are structurally unfed — `RayHitDebug.readback` reports
//     `dispatched: false` — and `smoke:gi-gpu`'s entire step/plane/triangle
//     assertion block has been SKIPPED, not passed, ever since. This pass is
//     what turns that block back on (§12.12.4's interregnum, closed).
//   · SRC's rays are LONGER than the interval rays the dense backend traced, so
//     the step-budget assertions (`stepLimitExits === 0`, macro/brick limits at
//     zero) are measuring something new the moment they come back. That is the
//     point: the budget was tuned against a ray class that no longer exists.
//
// ══ WHY THE SINK IS ATOMIC AND WHY THERE IS ONE AT ALL ═════════════════════
//
// A trace whose result nothing reads is a trace a compiler may delete, and the
// deletion would be invisible: the pass still dispatches, still costs nothing,
// and still reports zero rays. Sixteen bytes of atomics make the trace's result
// an observable side effect, and they buy a readback that says something a
// counter of rays cannot — the HIT RATE and the hit-distance distribution, which
// is the measurement §12.13.4 says has to happen before `Lmax` can be decided.
//
// ══ THE RAY THIS FIRES, AND THE THREE RULES IT ALREADY OBEYS ═══════════════
//
//   · ORIGIN IS THE PIXEL. Not the probe position — the probe is only consulted
//     for "does this pixel participate". §12.13.6, and srcMathTsl's own header:
//     offsetting the origin along the normal to fix a self-occlusion artifact IS
//     the artifact. The self-bias lives in the marcher, off the VOXEL size.
//   · LENGTH IS c0's INTERVAL, read from `intervalBoundary(0, lod, s₀)` rather
//     than re-derived — one definition of where cascade 0 stops. This is the
//     ray unit 4's c0-only resolve will shade, so the budget measured here is
//     the budget that matters.
//   · DIRECTION IS R2 IN FIXED POINT via `rayDirection`, never a re-derived
//     float form (§12.11.1: the float one has eight distinct values at the ray
//     counts this phase runs at, and the f64 mirror cannot see it).
//
// docs/GI_SRC_REBUILD_PLAN.md §12.13.5 unit 1.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicMax,
  atomicStore,
  float,
  floor,
  instanceIndex,
  instancedArray,
  select,
  uint,
  vec3,
} from "three/tsl";
import { MAX_LODS } from "./srcConfig.js";
import { intervalBoundary, lodAtDistance, chebyshev, rayDirection } from "./srcMathTsl.js";
import { SLOT_EMPTY } from "./srcProbes.js";

/** Sink layout — four atomic words, one binding. */
const SINK_RAYS = 0;
const SINK_HITS = 1;
const SINK_TSUM = 2;
const SINK_TMAX = 3;
const SINK_WORDS = 4;

/**
 * Hit distance is accumulated in fixed point because WGSL has no float atomics
 * — the same constraint that shapes the real deposit (§12.13.4). 1/1024 m is
 * about a millimetre, and a 4 km ray is still four million counts short of
 * overflowing a single sample.
 *
 * ══ WHY THE SINK IS RESET EVERY FRAME, MEASURED ════════════════════════════
 *
 * The first version accumulated since boot, exactly as `RayHitDebug` does, and
 * the smoke's boot window reported **136,012,800 rays** with a mean hit distance
 * of 0.027 m — under the trace's own `tMin` self-bias, which is arithmetically
 * impossible. The sum had wrapped a u32 twenty-odd times. It is worth writing
 * down because the number that survived the wrap looked plausible: an
 * implausibly SMALL mean reads as "the rays are hitting their own origin voxel",
 * which is a real failure mode this pass exists to detect, and the sink was
 * quietly reporting it for the wrong reason.
 *
 * A per-frame reset costs one 1-thread dispatch, keeps the sum four orders of
 * magnitude clear of the ceiling, and makes every number here mean something a
 * reader can check by hand — `rays` should be about the count of participating
 * pixels, not a boot-length integral of it.
 */
const T_FIXED = 1024;

/**
 * One profiled ray per participating pixel.
 *
 * @param {object} options
 * @param {object} options.pixelProbe  the frame's per-pixel c0 probe index;
 *   SLOT_EMPTY means the pixel had no geometry or its insert failed. Read
 *   rather than the gbuffer's own validity bit ON PURPOSE — "this pixel has a
 *   probe" is the condition every later phase gates on, so it is the condition
 *   the budget should be measured under.
 * @param {number} options.pixelCount
 * @param {(o, d, tMax) => object} options.trace  from `createSrcSceneTrace`
 * @param {(i) => {position, valid}} options.readPixel
 * @param {(i) => object} options.readNormal  world normal at the pixel
 * @param {object} options.camera  vec3 node — the LOD metric's other end
 * @param {number} options.spacing0
 * @param {object} options.jitterX  u32 uniform — R2 phase, advanced per frame
 * @param {object} options.jitterY
 */
export function createSrcRayPass({
  pixelProbe,
  pixelCount,
  trace,
  readPixel,
  readNormal,
  camera,
  spacing0,
  jitterX,
  jitterY,
  maxLods = MAX_LODS,
}) {
  const sink = instancedArray(new Uint32Array(SINK_WORDS), "uint").toAtomic();

  /** Its own dispatch, because there is no device-wide barrier inside one. */
  const reset = Fn(() => {
    for (let w = 0; w < SINK_WORDS; w++) atomicStore(sink.element(uint(w)), uint(0));
  })().compute(1);

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    If(pixelProbe.element(i).equal(uint(SLOT_EMPTY)), () => {
      Return();
    });
    const px = readPixel(i);
    const P = vec3(px.position).toVar();
    // The gbuffer stores geometric normals unnormalized-ish through a half-float
    // target; normalize here rather than trusting it, because `rayDirection`
    // flips the hemisphere on `d · n̂` and a short normal only shrinks that dot
    // — it never changes its SIGN, so this is hygiene rather than a fix.
    const N = vec3(readNormal(i)).normalize().toVar();
    // Same LOD the population used for this pixel's key ([B]'s `latticeAt`),
    // recomputed rather than read out of the probe table: the table costs a
    // second storage binding in a kernel that already carries the occupancy
    // pyramid, and this module has died on the portable 8-buffer limit often
    // enough that AGENTS.md leads with it. The two agree by construction —
    // same camera uniform, same `lodAtDistance`, same `floor`.
    const lod = floor(lodAtDistance(chebyshev(P, camera), spacing0, maxLods)).toVar();
    const reach = intervalBoundary(0, lod, spacing0).toVar();
    // The R2 index is the PIXEL index here. Alg. 3's global ray numbering is
    // unit 2's job (`srcRays.js`), and using it before it exists would mean
    // writing a second, throwaway assignment scheme whose only consumer is a
    // pass that is itself throwaway.
    const dir = rayDirection(i, N, jitterX, jitterY).toVar();
    const r = trace(P, dir, reach);

    const hit = r.hit.greaterThan(0.5).toVar();
    const tfx = select(hit, r.t.max(0).mul(T_FIXED), float(0)).toUint().toVar();
    atomicAdd(sink.element(uint(SINK_RAYS)), uint(1));
    atomicAdd(sink.element(uint(SINK_HITS)), select(hit, uint(1), uint(0)));
    atomicAdd(sink.element(uint(SINK_TSUM)), tfx);
    atomicMax(sink.element(uint(SINK_TMAX)), tfx);
  })().compute(pixelCount);

  return {
    reset,
    compute,
    sink,

    /**
     * ONE FRAME's worth — the sink is cleared at the head of every dispatch (see
     * `T_FIXED`). Read it with the loop stopped, as the smoke does, and it is
     * the last complete frame; read it live and it is whichever frame the copy
     * landed in. Both are a frame, which is the point.
     */
    async readback(renderer) {
      const allocated = !!renderer?.backend?.get?.(sink.value)?.buffer;
      if (!allocated) return { dispatched: false, rays: 0, hits: 0, hitRate: 0, meanT: 0, maxT: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(sink.value));
      const rays = v[SINK_RAYS] >>> 0;
      const hits = v[SINK_HITS] >>> 0;
      return {
        dispatched: true,
        rays,
        hits,
        hitRate: rays > 0 ? hits / rays : 0,
        meanT: hits > 0 ? (v[SINK_TSUM] >>> 0) / hits / T_FIXED : 0,
        maxT: (v[SINK_TMAX] >>> 0) / T_FIXED,
      };
    },

    dispose() {
      sink?.value?.dispose?.();
    },
  };
}
