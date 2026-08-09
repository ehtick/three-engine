// SPLIT RADIANCE CASCADES — the c0-only resolve. THE SCREEN STOPS BEING DARK.
//
// Plan §7 Phase 2 and the companion guide's §8.3: shade straight from raw
// cascade 0 with the merge DISABLED. It is the single-level sanity check, and
// it is also the first thing in this rebuild a person can look at and judge.
//
// ══ WHAT IT ACTUALLY COMPUTES, AND WHY THAT IS AMBIENT OCCLUSION ═══════════
//
// A c0 bin holds `(L, T)` — the radiance the ray found in cascade 0's interval,
// and whether it got through. With no hit shading yet (Phase 5) every `L` is
// zero, so the only surviving term is
//
//     E  =  π · Σ T_i·sky·max(0, d_i·n̂)  /  Σ max(0, d_i·n̂)
//
// which is exactly "how much of the hemisphere can see out", i.e. ambient
// occlusion at cascade 0's range. That is the look §7 promises, and it is the
// real algorithm with one term still zero rather than a stand-in for it.
//
// **The sky is the scene's own `skyIntensity`/`skyColor`, which default to
// zero.** So a project that has never touched them still renders exactly as it
// did — and the eye check needs the Sky Light slider turned up, which is an
// authored control rather than a constant invented here.
//
// ══ THE MERGE IS ABSENT, NOT DISABLED ══════════════════════════════════════
//
// Cascades 1-3 are populated, budgeted and deposited into every frame, and this
// pass reads NONE of it. That is the point of a single-level check: if the
// picture is wrong here, the merge cannot be why. Phase 3 replaces this whole
// file with [G]/[H]/[I].
//
// ══ WHY IT IS ITS OWN PASS AND NOT A CLOSURE INSIDE THE RESOLVE ════════════
//
// `createGiResolve` takes a `gather(point, normal, viewDir)` closure and inlines
// it. Doing that here would drag the probe table, the payload buffer and the
// hash into the fattest kernel in the module, which already carries the gbuffer,
// the emitter slots, the occupancy pyramid for AO and the BVH — and the portable
// limit is EIGHT storage buffers per stage. So this runs separately, writes a
// half-res texture, and the resolve SAMPLES it. A texture binding does not count
// against that limit.
//
// The consequence is stated rather than hidden: this gather is SCREEN-SPACE. It
// answers for the pixel, not for an arbitrary world point, so it is wired to the
// resolve's primary diffuse term only and the BVH reflection path keeps its
// existing `gather == null` behaviour (direct terms alone at a reflected hit).
// Phase 3's probe gather, which looks up by position, is what fixes that.
//
// docs/GI_SRC_REBUILD_PLAN.md §7 Phase 2, §12.13.5 unit 4.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicMax,
  atomicMin,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  ivec2,
  texture,
  textureStore,
  uint,
  vec3,
  vec4,
} from "three/tsl";
import { W0, binCount, binGridWidth } from "./srcConfig.js";
import { binDir, mortonToBin } from "./srcMathTsl.js";
import { PAYLOAD_UNKNOWN, PAYLOAD_WORDS } from "./srcDeposit.js";
import { SLOT_EMPTY } from "./srcProbes.js";

// EQUAL-AREA BINS ARE WHY THIS IS A PLAIN WEIGHTED AVERAGE. `encodeDir` maps
// azimuth to x and `(z+1)/2` to y — the Lambert cylindrical equal-area
// projection — so every one of the `2w²` bins subtends exactly the same solid
// angle and no per-texel Δω table is needed. §12.10.1 records the OLD gather as
// violating exactly this: its texels varied 2.73× in solid angle with Δω never
// written anywhere. Δω itself never appears below, because the normalization is
// analytic (see the E assignment).

/**
 * Per-frame telemetry, and the ONLY way an automated gate can see this pass.
 *
 * The output is a StorageTexture, and reading one back headlessly is the rig
 * problem [[gi-harness-viewport-traps]] records — so the numbers a gate needs
 * are written to a buffer alongside the pixels rather than recovered from them.
 * These five are chosen to distinguish the failures that look alike on screen:
 * "no probe" (population), "every bin unknown" (deposit), "lit but flat" (the
 * occlusion term is doing nothing) and "lit and varying" (working).
 */
const GS_PIXELS = 0;    // pixels with a c0 probe
const GS_UNKNOWN = 1;   // ...of those, pixels whose probe holds NO sampled bin
const GS_LIT = 2;       // ...of those, pixels that came out above zero
const GS_SUM = 3;       // Σ luminance, fixed point
const GS_MIN = 4;       // min/max luminance over LIT pixels — the AO contrast
const GS_MAX = 5;
const GS_SAMPLED = 6;   // Σ sampled bins over all pixels — see `sampled` below
// Pixels whose probe HAS sampled bins, but none of them in this pixel's
// hemisphere. Structural, not a fault — see the note where it is incremented.
const GS_FACING = 7;
const GS_BADN = 8;      // pixels whose gbuffer normal is degenerate
const GS_WORDS = 12;
const LUM_FIXED = 4096;

/**
 * The c0-only irradiance pass.
 *
 * @param {object} bins  from `createSrcBinStore`
 * @param {object} options
 * @param {object} options.pixelProbe  per-pixel c0 probe index
 * @param {(i) => object} options.readNormal  world normal at the pixel
 * @param {object} options.sky  vec3 uniform — the scene's sky radiance
 * @param {number} options.width  gbuffer width
 * @param {number} options.height
 */
export function createSrcGatherPass(store, bins, {
  pixelProbe,
  readNormal,
  sky,
  width,
  height,
  w0 = W0,
} = {}) {
  const info = bins.cascades[0];
  const nBins = binCount(0, w0);
  const gridW = binGridWidth(0, w0);

  const target = new THREE.StorageTexture(width, height);
  target.type = THREE.HalfFloatType;
  target.name = "giSrcIrradiance";
  // Same forced version as `createGiTargets` — three only rebinds when
  // `texture.version` changes, and a brand-new StorageTexture is version 0, so
  // a resize swap would be invisible to every already-compiled material.
  target.version = (globalThis.__giSrcTargetVersion = (globalThis.__giSrcTargetVersion ?? 0) + 1);

  const widthU = width;
  const payload = bins.payload;
  const stats = instancedArray(new Uint32Array(GS_WORDS), "uint").toAtomic();

  // `GS_MIN` starts at u32 max so the first `atomicMin` wins; every other word
  // starts at zero. Its own dispatch for the same reason every other clear in
  // this module is — there is no device-wide barrier inside one.
  const reset = Fn(() => {
    for (let w = 0; w < GS_WORDS; w++) {
      atomicStore(stats.element(uint(w)), uint(w === GS_MIN ? 0xffffffff : 0));
    }
  })().compute(1);

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const coord = ivec2(i.mod(uint(widthU)).toInt(), i.div(uint(widthU)).toInt());
    const E = vec3(0).toVar();
    const probe = pixelProbe.element(i).toVar();
    If(probe.notEqual(uint(SLOT_EMPTY)), () => {
      atomicAdd(stats.element(uint(GS_PIXELS)), uint(1));
      // Already faced toward the camera by srcSystem's `readPixel` — the same
      // vector the deposit filled this probe's bins along.
      const rawRead = vec3(readNormal(i)).toVar();
      // A DEGENERATE NORMAL POISONS EVERY WEIGHT. `normalize` of a zero vector
      // is NaN, `d.dot(NaN)` is NaN, and `NaN > 0` is false — so every bin is
      // skipped and the pixel reports "no information" for a reason that has
      // nothing to do with the bins. Counted rather than guarded, because a
      // guard would hide it and this is a gbuffer question, not a GI one.
      const rawLen = rawRead.length().toVar();
      If(rawLen.lessThan(0.5), () => {
        atomicAdd(stats.element(uint(GS_BADN)), uint(1));
      });
      const n = rawRead.normalize().toVar();
      const block = uint(info.binBase)
        .add(probe.sub(uint(info.probeBase)).mul(uint(info.bins)))
        .toVar();
      // `known` accumulates the sampled bins' cosine-weighted radiance and
      // `wKnown` the cosine weight they carry. Dividing one by the other is the
      // renormalization R1 asks for — unknown bins are excluded from the
      // average rather than voting black.
      const known = vec3(0).toVar();
      const wKnown = float(0).toVar();
      // Sampled bins in the WHOLE sphere, unweighted. It exists to separate the
      // two ways `wKnown` reaches zero, which look identical downstream: the
      // probe's bins are empty (an addressing or deposit fault) versus the
      // probe's bins are full but all of them sit in the other hemisphere (a
      // real consequence of probes being position-only and shared by surfaces
      // whose normals oppose). Without this the first would be indistinguishable
      // from the second, and only one of them is a bug.
      const sampled = uint(0).toVar();
      Loop({ start: 0, end: nBins, type: "uint", name: "m" }, ({ m }) => {
        // Bins are stored in MORTON order, so the direction has to come back
        // through `mortonToBin` — reading `m` as a raster index would rotate
        // every probe's hemisphere by a Z-curve, which looks like a plausible
        // but wrong lighting direction rather than like a bug.
        const ij = mortonToBin(m).toVar();
        const d = binDir(ij.x, ij.y, gridW).toVar();
        const cosT = d.dot(n).max(0).toVar();
        const o = block.add(m).mul(PAYLOAD_WORDS).toVar();
        const T = payload.element(o.add(uint(3))).toVar();
        // ZERO-COUNT BINS ARE UNKNOWN, NOT ZERO (srcMath's `resolveBin`). An
        // unsampled bin is excluded from the average and the rest renormalize
        // over what was found — feeding it in as black is a hard cliff at the
        // edge of every sparsely-sampled region, and at 0.78 rays per bin
        // (§12.13.4) that edge is everywhere rather than exotic.
        If(T.greaterThanEqual(0), () => {
          sampled.addAssign(uint(1));
          const L = vec3(
            payload.element(o),
            payload.element(o.add(uint(1))),
            payload.element(o.add(uint(2))),
          ).toVar();
          // THE MERGE, COLLAPSED TO ONE LEVEL: cascade 0's parent is the sky.
          // `L + T·L_sky` is `mergeBin` with the parent term replaced by the
          // sky composite that normally happens once at the top (srcMath's
          // `mergeBin`, and `splitDeposits`' note on why the sky is not
          // deposited per cascade).
          known.addAssign(L.add(vec3(sky).mul(T)).mul(cosT));
          wKnown.addAssign(cosT);
        });
      });
      // ══ E = π · (cosine-weighted mean radiance over the SAMPLED bins) ═════
      //
      // `context.irradiance` in three's lighting model is E, and the Lambert
      // BRDF divides by π — so a fully open hemisphere under uniform sky
      // radiance L must return exactly π·L.
      //
      // The π is ANALYTIC, not `Σ max(0,cos)·Δω` over the bins. Both are the
      // same integral, but the discrete form carries a quadrature error that
      // does not cancel: the first version of this file multiplied the sampled
      // mean by `wAll·Δω` and measured a peak of **3.173 against π = 3.1416**,
      // 1% of energy invented out of 32-bin discretization. Dividing by the
      // sampled weight and multiplying by the exact π makes uniform radiance
      // return π·L identically, whatever the bin count and whichever bins
      // happened to be sampled — which is also what makes the smoke's
      // `peak ≤ π·sky` assertion a real ceiling instead of a tolerance.
      If(wKnown.greaterThan(0), () => {
        E.assign(known.div(wKnown).mul(Math.PI));
      }).Else(() => {
        // TWO DIFFERENT THINGS, AND ONLY ONE IS A BUG.
        //
        // `sampled == 0` means the probe's bins are empty — an addressing fault
        // between the deposit and here, or a probe nothing deposited into.
        //
        // `sampled > 0` means the probe HAS data and none of it is in this
        // pixel's hemisphere. That is structural: an SRC probe is POSITION-ONLY,
        // so its bins are populated only in the directions its contributing
        // pixels' hemispheres covered, and a receiver on a surface facing the
        // other way legitimately has no information. R1 says an absence is an
        // absence, never a dark vote — so the pixel gets nothing rather than
        // black, and it is counted here so the size of the effect is visible
        // instead of being read off the screen as "GI is patchy".
        If(sampled.equal(uint(0)), () => {
          atomicAdd(stats.element(uint(GS_UNKNOWN)), uint(1));
        }).Else(() => {
          atomicAdd(stats.element(uint(GS_FACING)), uint(1));
        });
      });
      atomicAdd(stats.element(uint(GS_SAMPLED)), sampled);
      // Rec. 709 luminance, in fixed point because WGSL has no float atomics —
      // the same constraint the deposit lives under, at a coarser scale because
      // this is telemetry and not an accumulator.
      const lum = E.x.mul(0.2126).add(E.y.mul(0.7152)).add(E.z.mul(0.0722)).toVar();
      If(lum.greaterThan(0), () => {
        const fx = lum.mul(LUM_FIXED).toUint().toVar();
        atomicAdd(stats.element(uint(GS_LIT)), uint(1));
        atomicAdd(stats.element(uint(GS_SUM)), fx);
        atomicMin(stats.element(uint(GS_MIN)), fx);
        atomicMax(stats.element(uint(GS_MAX)), fx);
      });
    });
    textureStore(target, coord, vec4(E, 1));
  })().compute(width * height);

  return {
    reset,
    compute,
    target,
    stats,
    /** The resolve's `gather`: one texture load, no storage bindings. */
    node: texture(target),
    width,
    height,

    /**
     * One frame's irradiance telemetry. `contrast` is the arm that matters: a
     * c0-only resolve with no hit shading IS ambient occlusion, so a frame where
     * every lit pixel has the same value has no occlusion in it at all — which
     * looks like flat ambient on screen and passes every other check.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, pixels: 0, lit: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const lit = v[GS_LIT] >>> 0;
      const min = lit > 0 ? (v[GS_MIN] >>> 0) / LUM_FIXED : 0;
      const max = (v[GS_MAX] >>> 0) / LUM_FIXED;
      return {
        dispatched: true,
        pixels: v[GS_PIXELS] >>> 0,
        // Mean SAMPLED bins per pixel, out of the cascade's total. Near the
        // total means the bins are full and `unknown` is a hemisphere story;
        // near zero means the deposit and the gather disagree about addresses.
        meanSampledBins: (v[GS_PIXELS] >>> 0) > 0 ? (v[GS_SAMPLED] >>> 0) / (v[GS_PIXELS] >>> 0) : 0,
        totalBins: nBins,
        unknown: v[GS_UNKNOWN] >>> 0,
        facing: v[GS_FACING] >>> 0,
        badNormals: v[GS_BADN] >>> 0,
        lit,
        meanLum: lit > 0 ? (v[GS_SUM] >>> 0) / lit / LUM_FIXED : 0,
        minLum: min,
        maxLum: max,
        contrast: max > 0 ? 1 - min / max : 0,
      };
    },

    dispose() {
      stats?.value?.dispose?.();
      target.dispose?.();
    },
  };
}
