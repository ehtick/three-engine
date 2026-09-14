// SPLIT RADIANCE CASCADES — [H] THE IRRADIANCE TILES.
//
// Per c0 probe, bake the Lambertian rendering-equation integral into a 6×6
// octahedral tile with a 1-texel border, packed into one atlas texture. Pixels
// then take ≤8 FILTERED samples of these tiles in the normal direction, which
// is the entire reason this pass exists: a raw per-pixel gather over 32
// directions × 8 probes is 256 unfiltered reads, and the paper calls that out
// as prohibitive.
//
// ══ WHY ONLY CASCADE 0 ═════════════════════════════════════════════════════
//
// Because [G] has already happened. A merged c0 bin carries the radiance and
// transmittance of the WHOLE cascade chain above it, so cascade 0 is not "the
// near field" any more — it is the complete answer, at the finest spatial
// resolution the hierarchy has. Baking tiles for cascades 1-3 would bake the
// same light at coarser spacing and nothing would ever read them.
//
// ══ THE NORMALIZATION IS LOAD-BEARING (R4) ═════════════════════════════════
//
//     E(n̂) = π · Σ L_bin·W(bin, n̂) / Σ W(bin, n̂)
//
// NOT `Δω · Σ L·cos`. The two agree in the limit, but the normalized form is
// EXACT for uniform radiance at ANY bin count — feed it L = 1 everywhere and it
// returns exactly π, so ρ/π·E is exactly ρ. That makes the furnace test a
// statement about the ESTIMATOR rather than about discretization error, and it
// is what bounds Phase 5's multibounce loop gain below 1 by construction. It is
// also the same analytic π `srcGather.js` had to be corrected to (§12.17.2,
// where the discrete form invented 1% of the energy).
//
// ══ THE KERNEL HAS NO OCTAHEDRAL MATH IN IT, AND THAT IS THE DESIGN ════════
//
// Two facts collapse into one uploaded table:
//
//   1. `W(bin, n̂)` depends only on (w, interior, sub) — never on the scene — so
//      it is computed once on the CPU by `binCosineWeights`, the SAME function
//      the mirror uses. There is no twin to keep in sync because there is no
//      second implementation.
//   2. A BORDER texel's value is by definition the interior integral at its
//      wrapped texel (`octahedralBorderMap`). So instead of copying values
//      after the fact, the border texel's table row IS its wrapped interior
//      row — and the thread that owns it simply computes that integral.
//
// `tileCosineWeights` folds both into a `[texel · nBins + bin]` array covering
// all 64 texels of the bordered tile. What is left in WGSL is a loop over bins
// multiplying two numbers. No fold, no wrap, no second copy pass, and — the
// part that actually mattered — **no read-after-write on the atlas**, which a
// separate border-copy pass would have needed and which WebGPU does not allow
// for a texture bound writable in the same dispatch.
//
// ══ THE BORDER IS A CORRECTNESS REQUIREMENT, NOT A LAYOUT DETAIL ═══════════
//
// The octahedral square's centre is +Z and all four CORNERS are −Z, so the
// exact −Z direction sits precisely where bilinear filtering has nothing to
// interpolate toward. Without a border, all four taps collapse onto the single
// interior corner texel, whose own direction at 6×6 is 19.4° off axis — a
// systematic, ORIENTATION-DEPENDENT error measured at **+32% on a −Z-facing
// receiver** (§12.2). It is invisible to every test that does not vary surface
// orientation and it does not shrink with probe spacing, ray count or angular
// resolution.
//
// ══ THE TAPS CANNOT LEAVE THEIR OWN TILE, WHICH IS WHY AN ATLAS IS SAFE ════
//
// `sampleTile`'s interior-space coordinate is `(f·0.5 + 0.5)·interior − 0.5 +
// border`, and `f ∈ [−1, 1]`, so it spans `[0.5, interior + 0.5]` — the four
// bilinear taps therefore land in `[0, interior + 1]`, exactly the tile's own
// `interior + 2` texels. No tap can reach a neighbouring tile in the atlas, at
// any normal, for any probe. That is what makes hardware bilinear over a packed
// atlas correct rather than merely cheap, and the gate asserts it directly.
//
// ══ WHAT READS THIS TODAY: NOTHING ═════════════════════════════════════════
//
// [I] (`srcScreenGather.js`) reads them: one filtered tap per trilinear
// corner, in the shading point's normal direction. They were built and gated
// one unit AHEAD of that consumer, which is the same decomposition Phase 1 used
// for the probes: build the thing, prove it against the mirror, then connect it.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 [H], §12.18.7 unit 4, §12.2.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicMax,
  atomicMin,
  atomicStore,
  cos,
  equirectUV,
  float,
  instanceIndex,
  instancedArray,
  ivec2,
  select,
  sin,
  texture,
  textureStore,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  IRRADIANCE_TILE_BORDER,
  IRRADIANCE_TILE_INTERIOR,
  W0,
  binGridWidth,
  centroidArmed,
  confidenceArmed,
} from "./srcConfig.js";
import { binCentroidTable, binDirTable, tileCosineWeights, tileDirTable } from "./srcMath.js";
import { decodeCentroidOffset } from "./srcMathTsl.js";
import { octahedralUV } from "./srcOctahedral.js";
import { readPayload } from "./srcDeposit.js";
import { binPartitionUniforms, blockChainUniforms, capAt } from "./srcCapacityUniforms.js";

/** Sub-samples per bin axis in the cosine quadrature. §12.2's bias fix. */
export const COSINE_SUB = 4;

/** Bake telemetry. One atomic buffer. */
export const TS_TEXELS = 0;   // texels that found at least one known bin
export const TS_EMPTY = 1;    // ...and those that found none — see the note below
export const TS_KNOWN = 2;    // Σ known bins over all texels
export const TS_SUM = 3;      // Σ luminance, fixed point
export const TS_MIN = 4;
export const TS_MAX = 5;
export const TS_WORDS = 8;
const LUM_FIXED = 4096;

/** Round up to a power of two — the atlas strides are shifts, not divides. */
function pow2(n) {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

/**
 * Lay `blocks` tiles out in an atlas.
 *
 * A power-of-two tile stride so `block → (column, row)` is a shift and a mask
 * in the kernel, and roughly square so neither dimension approaches
 * `maxTextureDimension2D`. At the engine default (10,937 c0 blocks, 8×8 tiles)
 * this is 128 tiles per row: a 1024 × 688 texture, 5.6 MB at RGBA16F.
 */
export function tileAtlasLayout(blocks, tileSize, maxDimension = 8192) {
  const maxPerRow = Math.max(1, Math.floor(maxDimension / tileSize));
  const perRow = Math.min(pow2(Math.max(1, Math.ceil(Math.sqrt(Math.max(1, blocks))))), maxPerRow);
  const rows = Math.ceil(Math.max(1, blocks) / perRow);
  return {
    perRow,
    rows,
    width: perRow * tileSize,
    height: rows * tileSize,
  };
}

/**
 * Bake the c0 irradiance tile atlas.
 *
 * Runs AFTER the merge — it consumes merged c0 bins, and running it on raw
 * resolved bins would bake the one-metre answer the merge exists to replace.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {Node} [options.sky]  vec3 — composited against a bin's RESIDUAL
 *   transmittance. Zero for a merged bin (the merge already consumed it at the
 *   top), so this only ever fires for the orphans. See the bake loop.
 */
export function createSrcTileAtlas(store, bins, {
  w0 = W0,
  // §10.7 (2026-09-03): WHICH CASCADE THIS ATLAS BAKES. c0 is the shipped
  // one and the only one the resolve reads directly; a c1 atlas exists so
  // the screen gather has somewhere to fall when the c0 lattice is STARVED
  // (dropped inserts / blockless probes — see srcScreenGather's `coarse`).
  cascade = 0,
  interior = IRRADIANCE_TILE_INTERIOR,
  border = IRRADIANCE_TILE_BORDER,
  sub = COSINE_SUB,
  maxDimension = 8192,
  sky = null,
  frameStamp = null,
  // §16 S1 — the DIRECTIONAL sky bundle ({ node, intensity, rotY }); when
  // present the orphan/residual `T·sky` term samples the environment at the
  // bin's own direction instead of the flat mean. Absent (every gate
  // fixture) the flat path compiles bit-identically.
  skyEnv = null,
} = {}) {
  const info = bins.cascades[cascade];
  const nBins = info.bins;
  const blocks = info.blockCapacity;
  const tileSize = interior + 2 * border;
  const texels = tileSize * tileSize;
  const layout = tileAtlasLayout(blocks, tileSize, maxDimension);

  const atlas = new THREE.StorageTexture(layout.width, layout.height);
  // HALF FLOAT, and the choice is forced rather than free: `rgba32float` is a
  // storage format but is NOT filterable without an optional feature, and
  // filtering is the whole reason the tiles are octahedral. Half float is
  // filterable everywhere and carries ~3 decimal digits, which is well inside
  // what an irradiance estimate built from 0.78 rays per bin means.
  atlas.type = THREE.HalfFloatType;
  atlas.name = "giSrcIrradianceTiles";
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.wrapS = THREE.ClampToEdgeWrapping;
  atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.generateMipmaps = false;
  // Same forced version as every other target in this module: three only
  // rebinds when `texture.version` changes, and a brand-new StorageTexture is
  // version 0, so a resize swap would be invisible to already-compiled
  // materials.
  atlas.version = (globalThis.__giSrcTargetVersion = (globalThis.__giSrcTargetVersion ?? 0) + 1);
  const atlasNode = texture(atlas);

  const w = binGridWidth(cascade, w0);
  const table = tileCosineWeights(w, interior, sub, border);
  const cosTable = instancedArray(table, "float");
  /**
   * ⭐⭐ THE HONEST DENOMINATOR FOR `meanKnownBins` (§12.87c, 2026-08-24).
   *
   * `known` is incremented INSIDE `If(cw.greaterThan(0))`, so its domain is not
   * `nBins` — it is the bins whose patch actually crosses this texel's horizon.
   * Reporting it as `x/32` made a healthy field look two-thirds starved and
   * sent a whole session hunting a phantom: on the user's Level the reading was
   * `11.1/32` (35%), and the true figure is `11.1/20.1` = **55%**.
   *
   * Computed on the CPU from the very table the kernel reads — no GPU counter,
   * no atomic, no frame cost. At the shipping w0=4/interior=6/border=1 it is
   * 20.125 (histogram {16:4, 20:36, 21:24} over the 64 bordered texels), and it
   * is a pure function of (w, interior, sub, border), so it cannot drift from
   * what the kernel does.
   *
   * ⚠ The CEILING is 20.125 and it is reached only by a probe fed from every
   * direction. A probe fed by ONE flat surface is bounded far lower — the ray
   * fold (`srcMathTsl` rayDirection: every ray is folded into the firing
   * pixel's own hemisphere) means a probe against a wall can never receive
   * evidence in the half-sphere behind it. So a mid-teens reading on a blockout
   * interior is not starvation; it is geometry.
   */
  const lobeBins = (() => {
    const texelsAll = (interior + 2 * border) ** 2;
    let sum = 0;
    for (let t = 0; t < texelsAll; t++) {
      for (let m = 0; m < nBins; m++) if (table[t * nBins + m] > 0) sum++;
    }
    return sum / texelsAll;
  })();
  const stats = instancedArray(new Uint32Array(TS_WORDS), "uint").toAtomic();
  const { payload } = bins;
  const skyNode = sky ? vec3(sky) : vec3(0);
  // §16 S1 — c0's bin-direction LUT for the directional orphan composite
  // (Morton order — binDirTable's header). Bound only when armed.
  // §11.28: also the bake's own bin-centre LUT — the direction a bin's
  // cosine is spent at when it carries no centroid — and the direction of
  // every bordered texel, so the correction can take `n̂ · û`.
  const cenOn = centroidArmed();
  const skyDirTable = skyEnv ? instancedArray(binDirTable(w), "vec4") : null;
  // §11.52 — the per-bin integrated sky for the orphan composite; see
  // srcMerge [G.2] and srcSkyBins.js. Same fallback rule: `ready` selects.
  const skyBinTable = skyEnv?.tables ? skyEnv.tables.tableFor(w) : null;
  const cenTable = cenOn ? instancedArray(binCentroidTable(w), "vec4") : null;
  const texDirTable = cenOn ? instancedArray(tileDirTable(interior, border), "vec4") : null;
  /**
   * §11.28 INSTRUMENT: the correction's live strength (1 = on, 0 = the
   * previous bake, on the SAME field). A uniform so a rig can read a point
   * both ways on one converged field; not a quality property.
   */
  const cenStrength = uniform(1);

  // ── §16 D3 — PROBE MATURITY (2026-08-24) ──────────────────────────────────
  //
  // A block claimed R frames ago carries ~R frames of accumulated evidence; a
  // block claimed THIS frame carries one noisy sample (or a §12.59.2 seed),
  // and until now it voted in the gather at the same weight as a converged
  // neighbour — which is exactly the cell-sized rectangle popping bright/dim
  // in view that camera motion produces at every walk frontier. Scaling
  // `cover` by m = clamp(claimAge/RAMP, FLOOR, 1) makes a young corner defer
  // to converged neighbours and FADE IN as it earns evidence:
  //   · per-corner mean invariant — rgb is stored E·cover, so both channels
  //     carry m and tap.rgb/tap.a is untouched;
  //   · R1-safe — a lone young corner still renormalizes to its own mean
  //     (never dark), and uniformly-young regions cancel m entirely;
  //   · steady state BIT-IDENTICAL to the pre-D3 build (m = 1 everywhere) —
  //     unlike every vetoed weight-shaping attempt, this term exists only
  //     during transients.
  // The claim stamp is the one `createCompactPass` already writes (and the
  // age pass re-stamps on release — a released block bakes a black tile via
  // wsum == 0, so the release value is never read). No new storage.
  // `__giSrcMaturity = false` removes it at build; `__giSrcMaturityRamp` /
  // `__giSrcMaturityFloor` override the constants.
  const maturityOn = globalThis.__giSrcMaturity !== false
    && frameStamp != null
    && store?.freeStack != null
    && store?.blockStampBase != null
    && store?.cascades?.[cascade]?.blockBase != null;
  const maturityRamp = Number(globalThis.__giSrcMaturityRamp) > 0
    ? Number(globalThis.__giSrcMaturityRamp)
    : 30;
  const maturityFloor = Number.isFinite(Number(globalThis.__giSrcMaturityFloor))
    ? Number(globalThis.__giSrcMaturityFloor)
    : 0.2;
  const stampBase = maturityOn ? store.blockStampBase + store.cascades[cascade].blockBase : 0;
  const stampStack = maturityOn ? store.freeStack : null;
  // The live-block guard needs the same stamp array plus the live words.
  const liveOn = frameStamp != null && store?.freeStack != null
    && Number.isInteger(store?.blockLiveBase) && Number.isInteger(store?.blockStampBase)
    && store?.cascades?.[cascade]?.blockBase != null;
  const liveBase = liveOn ? store.blockLiveBase + store.cascades[cascade].blockBase : 0;
  const liveStampBase = liveOn ? store.blockStampBase + store.cascades[cascade].blockBase : 0;
  const liveStack = liveOn ? store.freeStack : null;

  // The pool's sizes flow in as UNIFORMS, not literals (srcCapacityUniforms.js
  // — a pool change must not change this kernel's text, or the driver's
  // compiled-shader cache goes cold for it). The atlas strides ride one vec4:
  // (1/width, 1/height, perRow, ·). The atlas itself RE-CREATES on a pool
  // change (a new StorageTexture), but the kernels that sample it through
  // `sampleTileRGBA` — the screen-gather family — must keep their TEXT when
  // it does.
  const cap = {
    ...binPartitionUniforms(bins),
    ...blockChainUniforms(store, bins, {
      live: liveOn,
      stamp: maturityOn || liveOn,
    }),
  };
  const atlasU = uniform(new THREE.Vector4(1 / layout.width, 1 / layout.height, layout.perRow, 0));

  const passes = [];

  // `TS_MIN` starts at u32 max so the first `atomicMin` wins; every other word
  // starts at zero. `atomicStore`, never `.assign` — WGSL will not implicitly
  // convert `u32` to `atomic<u32>` and the module fails to compile, which
  // §12.20.8 records arriving as a validation error rather than as wrong
  // numbers (and looking correct for exactly one frame).
  passes.push(Fn(() => {
    for (let w = 0; w < TS_WORDS; w++) {
      atomicStore(stats.element(uint(w)), uint(w === TS_MIN ? 0xffffffff : 0));
    }
  })().compute(1));

  // ── the bake: one thread per (tile, texel) ────────────────────────────────
  //
  // Over EVERY block in the pool, claimed or not. An unclaimed block's bins are
  // all UNKNOWN (the deposit clears every frame and [F] writes unknown into
  // anything untouched), so it falls out with `wsum == 0` and writes a black
  // tile — which is what an atlas slot nobody owns should contain. Same
  // argument `srcMerge.js` runs on, and it is why this kernel needs no probe
  // table and no block→probe map.
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    const block = i.div(uint(texels)).toVar();
    const t = i.mod(uint(texels)).toVar();
    // Dead block (srcProbes' live word): nobody reads its tile — skip the
    // 32-bin walk. A block released this frame still bakes (to black).
    if (liveOn) {
      const live = liveStack.element(uint(capAt(cap.liveBase, cascade)).add(block)).toVar();
      If(liveStack.element(uint(capAt(cap.stampBase, cascade)).add(block)).equal(frameStamp), () => { live.assign(uint(1)); });
      If(live.equal(uint(0)), () => { Return(); });
    }

    const base = uint(capAt(cap.binBase, cascade)).add(block.mul(uint(nBins))).toVar();
    const row = t.mul(uint(nBins)).toVar();
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    /** Σ cosine weight over the WHOLE lobe — see `cover` below. */
    const wsumAll = float(0).toVar();
    const known = uint(0).toVar();
    const nrm = cenOn ? vec3(texDirTable.element(t).xyz).toVar() : null;

    // A dynamic loop rather than a JS unroll: `nBins` is 32 at the shipping w₀
    // and 128 on the ultra tier, and 128 unrolled call sites is a compile-time
    // cost for no gain — every iteration reads the same two buffers with no
    // divergence worth flattening.
    Loop({ start: 0, end: nBins, type: "uint", name: "m" }, ({ m }) => {
      const cw = cosTable.element(row.add(m)).toVar();
      // ⭐ THE DENOMINATOR OF HONEST COVERAGE — the whole cosine lobe, known or
      // not. See `cover` below for why the flag it replaces was the block
      // generator. Accumulated outside the `T >= 0` gate on purpose: this is
      // "how much of this texel's lobe EXISTS", against which `wsum` is "how
      // much of it we have actually sampled".
      wsumAll.addAssign(cw);
      If(cw.greaterThan(0), () => {
        // ZERO-COUNT BINS ARE UNKNOWN, NOT ZERO. Excluded from the average, and
        // the rest renormalize over what was found — feeding one in as black is
        // a hard cliff at the edge of every sparsely-sampled region, and at 0.78
        // rays per bin (§12.13.4) that edge is everywhere rather than exotic.
        const bin = readPayload(payload, base.add(m));
        const T = bin.T;
        If(T.greaterThanEqual(0), () => {
          // ── L + T·sky, CORRECT IN BOTH CASES IT CAN MEET ────────────────
          //
          // The merge composites the sky ONCE at the top and multiplies its
          // transmittance down, so a bin that merged arrives with T = 0 and
          // this reduces to `L` — no double count. A bin whose parent chain
          // BROKE keeps its own T, and `L + T·sky` is exactly the answer the
          // c0-only gather gave it.
          //
          // Without this an orphaned bin contributes zero where it used to
          // contribute `T·sky`, and §12.21.9 measured 17.9% orphans on the
          // smoke scene. Same expression, same reasoning, same place in both
          // twins (`bakeProbeIrradiance`).
          //
          // §16 S1 — when the directional sky is armed, the residual term
          // samples the environment at THIS bin's direction (srcMerge [G.2]
          // carries the full argument); the flat mean stays the unarmed
          // path, bit-identical for every fixture.
          const SB = vec3(skyNode).toVar();
          if (skyEnv) {
            const d = vec3(skyDirTable.element(m).xyz).toVar();
            const crS = cos(skyEnv.rotY).toVar();
            const srS = sin(skyEnv.rotY).toVar();
            const rdS = vec3(
              d.x.mul(crS).add(d.z.mul(srS)),
              d.y,
              d.z.mul(crS).sub(d.x.mul(srS)),
            ).toVar();
            const tapS = vec3(skyEnv.node.sample(equirectUV(rdS)).level(0).xyz).toVar();
            if (skyBinTable) {
              tapS.assign(select(
                skyBinTable.ready.greaterThan(0.5),
                vec3(skyBinTable.node.element(m).xyz),
                tapS,
              ));
            }
            SB.assign(tapS.mul(skyEnv.intensity));
          }
          // §11.25: each bin votes by `cw · c` — its cosine weight times its
          // confidence — so a freshly-hit bin FADES into the lobe average as
          // its evidence accumulates instead of flipping the texel to a
          // one-ray radiance the frame it crosses the membership threshold.
          // `cover` below is `Σ cw·c / Σ cw`: the confidence-weighted fraction
          // of the lobe, which is what "how much does this texel know" means.
          const cc = confidenceArmed() ? bin.c.max(0) : float(1);
          // ── §11.28: THE COSINE IS SPENT WHERE THE RADIANCE IS ──────────
          //
          // `cw` is the bin's MEAN clamped cosine over its (equal-area) solid
          // angle — `binCosineWeights`, 0..1, the same units in both twins.
          // The bin's radiance is not spread over the bin: the merge carried
          // the OFFSET `o` of its luminance centroid from the bin's area
          // centroid, and cosine is linear in direction, so for a bin inside
          // the hemisphere the exact weight is `cw + n̂·o` — NO solid-angle
          // factor (the first cut multiplied by Ω = 4π/32 and delivered 40 %
          // of the correction; the in-situ A/B and the mirror's re-bake of a
          // dumped probe agreed on 0.95 where 0.8 was due). The identity for
          // a bin carrying no offset (a uniform field, the resolve's own
          // bins); fades out on a grazing bin (`centroidBlend`'s rule, one
          // definition for both twins) where the linear form is no longer
          // exact. The denominator keeps `cw` — coverage is unchanged.
          let wL = cw;
          if (cenOn) {
            const o = decodeCentroidOffset(bin.cen, vec3(cenTable.element(m).xyz));
            const s = cw.div(0.25).clamp(0, 1).toVar();
            wL = cw.add(nrm.dot(o).mul(s).mul(cenStrength)).max(0).toVar();
          }
          acc.addAssign(bin.L.add(SB.mul(T)).mul(wL.mul(cc)));
          wsum.addAssign(cw.mul(cc));
          known.addAssign(uint(1));
        });
      });
    });

    const E = vec3(0).toVar();
    const cover = float(0).toVar();
    If(wsum.greaterThan(0), () => {
      // π · Σ(L·W) / Σ(W) — exact for uniform L at any bin count, whichever
      // bins happened to be sampled. See the header on why the π is analytic.
      E.assign(acc.mul(float(Math.PI).div(wsum)));
      // ── ⭐⭐ COVERAGE IS A FRACTION, NOT A FLAG (§12.87, 2026-08-24) ──────
      //
      // This was `cover.assign(1)`: ANY known bin in the lobe ⇒ full
      // confidence. Combined with the renormalised `E` above — a mean over the
      // KNOWN bins, which is an EXTRAPOLATION of them across the whole lobe —
      // a texel backed by ONE bin of sixteen claimed to know its hemisphere as
      // well as a fully-sampled one.
      //
      // ⚠ IT IS NOT A CONTRACT VIOLATION, AND THE FIRST WRITE-UP OF THIS SAID
      // IT WAS. `srcScreenGather.js`'s header reads "the atlas's alpha is 1
      // where a texel found a known bin and 0 where it did not … FILTERED, it
      // is `Σ w_tap` over the covered taps": the fraction is meant to come from
      // the hardware bilinear tap STRADDLING covered and uncovered TEXELS, not
      // from partial bin coverage inside one texel. The flag was the designed
      // behaviour and `test:gi-src-tiles`' COVERAGE arm defended it explicitly.
      // So this is a DESIGN CHANGE, and it shipped OPT-IN pending a
      // measurement.
      //
      // What it cost, measured on the user's Level (2026-08-23/24): probes read
      // `knownBins 11.1/32`, so one-bin extrapolation is the COMMON case, not
      // the tail. Whichever corner won a 0.45 m cell handed that whole cell its
      // single-bin constant, and which corner wins churns as probes are
      // re-minted — cell-scale blocks that rearrange when the camera moves,
      // worst where the base is near zero (this scene has Sky Light 0) and at
      // distance (influx per probe scales with screen footprint, so coverage
      // degrades as 1/d²). That is the user's report in one line of code.
      //
      // The fix is the honest fraction. A 1-of-16 texel now votes at 1/16 and
      // the gather's EXISTING coverage renormalisation lets better-sampled
      // neighbours carry the cell. `E` is renormalised over the KNOWN bins,
      // which is unbiased only if those bins are a random subset of the lobe;
      // they are not — they are the bins rays happened to reach — so a 4-of-16
      // texel is a BIASED extrapolation, and a flag gave it a full vote. It
      // cannot darken anything: `acc` and `wsum` in the gather carry the same
      // factor, so a uniformly-downweighted point renormalises back to the
      // same mean and only the RATIO between corners moves, which is exactly
      // what "in proportion to what it knows" means.
      //
      // ══ DEFAULT ON (2026-08-26). THE MEASUREMENT THAT EARNED IT ═══════════
      //
      // The A/B the block above asked for, run in the user's own editor at
      // ultra on the Level this text already describes, against the report
      // "when camera moves and sees a new surface, there are usually patches
      // that gradually turn to smooth lighting … patches look like a
      // checkerboard, some darker, some brighter":
      //
      //     arm                          patches            fps
      //     __giSrcProbeRayCap = 0       still present      60 → 45
      //     __giTileCoverFraction        ALMOST GONE        60 → 60
      //
      // ⚠ THAT TABLE IS A LIVE OBSERVATION AND IT IS THE ONLY EVIDENCE THERE
      // IS. `probe:gi-walk` was run twice at ultra with the `nocoverfrac`
      // control and came back NULL — its same-arm run-to-run spread (29% on
      // `checker`, 33% on `crease`) is several times the between-arm gap and
      // the sign flips between runs, so it cannot resolve an effect this size.
      // Do not cite the probe for or against this line; see §D1c in
      // docs/GI_SPATIAL_REBUILD_PLAN.md for the full ledger and the two
      // instrument defects that have to be fixed before it can.
      //
      // So the honest fraction is the fix and the ray budget was not: lifting
      // the per-probe cap spends 25% of the frame to treat the same artifact
      // less well, because a starved probe's problem is not that it has too
      // few rays — it is that it VOTES AS IF IT HAD ENOUGH. The cap arm is
      // kept as a diagnostic and its headroom is spent selectively instead
      // (see `srcRays.js` [D1']); this line is what actually closes the
      // report.
      //
      // ⚠ THE FLAG IS NOT COSMETIC TO THE GATES, and that is the cost of the
      // flip. The GPU stores `E·c` (premultiplied — see the ⛔⛔ note at the
      // `textureStore` below, which is why it MUST) while the mirror keeps `E`
      // and a separate coverage tile that `gatherPixel` multiplies in. Both
      // twins therefore compute `Σ w·c·E / Σ w·c` and agree at the GATHER,
      // but their ATLAS CONTENTS differ by `c` — so `test:gi-src-tiles`
      // compares its interior arm against `mirror·cover` and its coverage arm
      // against `cover` rather than against 1. With `c ≡ 1` both reduce to the
      // old assertions exactly, which is what keeps `false` a real opt-out.
      //
      // `__giTileCoverFraction = false` restores the flag. Both twins read the
      // one hatch, so `test:gi-src-gather` compares like with like either way.
      cover.assign(globalThis.__giTileCoverFraction === false
        ? float(1)
        : wsum.div(wsumAll.max(1e-6)).clamp(0, 1));
      // §16 D3 — the maturity factor (header above). u32 subtraction is safe:
      // any live block's stamp is a past frame of this session's monotonic
      // counter, so `frame − stamp` never underflows.
      //
      // ⚠ THIS COMPOUNDS WITH THE FRACTION ABOVE, AND THAT IS INTENDED. Since
      // §12.87 went default-on the two multiply — `cover = sampledFraction ×
      // maturity` — so a newborn block on a walk frontier is discounted TWICE:
      // once for the part of its lobe it has not sampled, once for the frames
      // of evidence it has not yet had. They are different ignorances (WHICH
      // directions are unknown vs HOW MUCH any of them is worth), so a product
      // is the right composition and not a double penalty.
      //
      // It cannot over-darken, for the reason the fraction cannot: the gather's
      // `acc` and `wsum` both carry `cover`, so a uniformly discounted probe
      // renormalises to the same mean and only its RATIO against better-known
      // neighbours moves. The floor is what keeps a cell from having no vote at
      // all when every corner is new.
      if (maturityOn) {
        const stamp = stampStack.element(uint(capAt(cap.stampBase, cascade)).add(block)).toVar();
        const m = float(uint(frameStamp).sub(stamp))
          .div(maturityRamp)
          .clamp(maturityFloor, 1)
          .toVar();
        cover.mulAssign(m);
      }
      atomicAdd(stats.element(uint(TS_TEXELS)), uint(1));
    }).Else(() => {
      // NOT A FAULT BY ITSELF, AND ON A REAL SCENE IT IS COMMON. A texel whose
      // whole cosine lobe sits in directions this probe has no sampled bin for
      // legitimately has no information — probes are POSITION-only, so a probe
      // fed by pixels facing one way holds nothing about the other hemisphere.
      // `srcGather.js` counts the same effect from the other side (`GS_FACING`)
      // and the smoke measures roughly a third of tile texels landing here.
      //
      // It is counted rather than guarded because the SIZE of the effect is the
      // interesting number, and because an atlas that is MOSTLY empty means
      // something upstream (unclaimed blocks, a dead merge) rather than
      // something here.
      atomicAdd(stats.element(uint(TS_EMPTY)), uint(1));
    });
    atomicAdd(stats.element(uint(TS_KNOWN)), known);

    const lum = E.x.mul(0.2126).add(E.y.mul(0.7152)).add(E.z.mul(0.0722)).toVar();
    If(lum.greaterThan(0), () => {
      const fx = lum.mul(LUM_FIXED).toUint().toVar();
      atomicAdd(stats.element(uint(TS_SUM)), fx);
      atomicMin(stats.element(uint(TS_MIN)), fx);
      atomicMax(stats.element(uint(TS_MAX)), fx);
    });

    // Atlas position. Both strides are powers of two, so these are shifts.
    const bx = block.mod(uint(atlasU.z)).toVar();
    const by = block.div(uint(atlasU.z)).toVar();
    const coord = ivec2(
      bx.mul(uint(tileSize)).add(t.mod(uint(tileSize))).toInt(),
      by.mul(uint(tileSize)).add(t.div(uint(tileSize))).toInt(),
    );
    // ══ ALPHA IS COVERAGE, AND IT IS THERE FOR [I] ══════════════════════════
    //
    // 1 where this texel found at least one known bin, 0 where it found none.
    // The channel was otherwise wasted, and what it buys is R1 implemented in
    // the texture unit: bilinear over RGB gives `Σ w_i·E_i` (empty texels store
    // 0 and contribute nothing) and bilinear over alpha gives `Σ w_i` over the
    // SAME taps, so `rgb / a` is the renormalized average over the taps that
    // had information — exactly `sparseGather`'s rule, for free, at the filter
    // hardware's cost of nothing.
    //
    // NOTHING DIVIDES BY IT YET, deliberately. The RGB written here is
    // bit-for-bit what `bakeProbeIrradiance` produces, so [H] stays a
    // "make the GPU agree with the mirror" unit and the gate can diff it
    // exactly. Whether [I] renormalizes — and whether the mirror's
    // `sampleTile` grows a coverage channel to match — is unit 5's decision,
    // made with the measured empty-texel rate in hand rather than in advance.
    // ⛔⛔ E IS PREMULTIPLIED BY COVER, AND IT MUST BE (§12.87b, 2026-08-24).
    //
    // `srcScreenGather.js:422-424` accumulates `acc += tap.xyz·weight` and
    // `wsum += tap.w·weight`, then divides ONCE at `:439`. That computes
    // `Σ w·c·E / Σ w·c` — a coverage-weighted mean — ONLY if the stored rgb
    // already carries `c`. Storing bare `E` computes `Σ w·E / Σ w·c` instead,
    // which is the mean divided by mean coverage: a gain of 1/c̄.
    //
    // With the shipped flag (`cover ≡ 1`) the two are identical, which is why
    // this survived — and it is why this line is a PROVABLE NO-OP on the
    // default path. Under `__giTileCoverFraction = true` it was not: c̄ runs
    // 0.378 (+Z face) to 0.689 (floor+wall junction), i.e. a **1.45×-2.65×
    // brightening that varies with each probe's feeding orientation** — per
    // 0.45 m cell. The opt-in arm as first written would have MANUFACTURED
    // exactly the cell-scale blocks it was built to test a cure for.
    //
    // ⚠ The CPU mirror was right all along (`srcRef.js` gatherPixel:
    // `const w = weight * cov; acc.r += c[0]*w; acc.w += w`), so the two twins
    // implemented different estimators under the hatch and only the GPU was
    // wrong. `test:gi-src-gather` cannot see it while the flag is off.
    textureStore(atlas, coord, vec4(E.mul(cover), cover));
  })().compute(blocks * texels));

  /**
   * Filtered irradiance from a probe's tile, in a normal direction — the
   * closure [I] gathers with, and the reason the atlas is a texture at all.
   *
   * ONE hardware-bilinear tap. `.level(0)` is REQUIRED: a compute stage has no
   * derivatives to pick a mip with, and a bare `.sample()` fails to compile
   * there (`bvhScene.js` pays the same tax on its albedo atlas).
   *
   * Exactly mirrors `srcRef.js`'s `sampleTile`, reusing `octahedralUV` — the
   * TSL fold that `run-gi-gather-invariance-test.mjs` already arbitrates
   * against its CPU twin — rather than open-coding the lower-hemisphere fold a
   * second time.
   */
  const sampleTileRGBA = (block, normal) => {
    const b = uint(block).toVar();
    const uvIn = octahedralUV(vec3(normal).normalize(), interior);
    // Interior-space continuous coords → bordered-tile coords. Interior texel
    // (u, v) lives at (u+1, v+1), which is what makes a tap that walks off the
    // interior land on a BORDER texel carrying the correct wrapped value
    // instead of a clamped duplicate.
    const u = uvIn.u.sub(0.5).add(border).toVar();
    const v = uvIn.v.sub(0.5).add(border).toVar();
    const bx = float(b.mod(uint(atlasU.z))).toVar();
    const by = float(b.div(uint(atlasU.z))).toVar();
    // `+0.5` puts an integer coordinate on a texel CENTRE, which is what makes
    // an integer `u` sample that texel exactly rather than blending two. The
    // atlas dimensions are uniform components (multiply by the reciprocal), so
    // a resized atlas changes no kernel text — the audit's `srcAtlasRcp` row,
    // which is also a small speedup over the divide.
    const uv = vec2(
      bx.mul(tileSize).add(u).add(0.5).mul(atlasU.x),
      by.mul(tileSize).add(v).add(0.5).mul(atlasU.y),
    ).toVar();
    return atlasNode.sample(uv).level(0);
  };

  /**
   * The same tap, radiance only.
   *
   * `.w` is COVERAGE (§12.21.4) and [I] needs it, so the RGBA form is the
   * primary one and this is the convenience. Anything that drops the alpha is
   * choosing to let an uninformed probe vote black — legal for a diagnostic,
   * wrong for a gather.
   */
  const sampleTile = (block, normal) => vec3(sampleTileRGBA(block, normal));

  return {
    passes,
    atlas,
    node: atlasNode,
    sampleTile,
    sampleTileRGBA,
    cosTable,
    table,
    layout,
    tileSize,
    interior,
    border,
    blocks,
    nBins,
    stats,
    /** §11.28: the correction's live strength uniform (instrument; 1 = on). */
    centroidStrength: cenStrength,
    /**
     * The GPU buffers that die with this bake. Lookup tables (`cosTable`,
     * `skyDirTable`) are uploaded once and never rewritten, so they belong
     * here exactly like `stats` does; nothing outside a rebuild ever binds
     * them again. Walked by releaseCompute's `collectStateStorageAttributes`.
     */
    get storageAttributes() {
      return [cosTable, stats, skyDirTable, cenTable, texDirTable].map((n) => n?.value).filter(Boolean);
    },
    // Half float is 8 bytes a texel at RGBA.
    bytes: layout.width * layout.height * 8 + table.length * 4 + TS_WORDS * 4,

    /**
     * One frame's bake telemetry.
     *
     * `coverage` is the one to read: the share of atlas texels that found any
     * known bin. It is bounded above by the share of blocks a live probe holds,
     * so a low number is normally a population story rather than a bake one —
     * and `meanKnownBins` separates them, because a texel with a claimed block
     * and no known bin is a merge or deposit question, not a tile question.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, texels: 0, lit: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const lit = v[TS_TEXELS] >>> 0;
      const total = blocks * texels;
      // `atomicMin` only ever fires for a texel whose luminance is ABOVE zero,
      // and `lit` counts texels with a known BIN — two different populations.
      // With the sky off and hit shading absent every covered texel is
      // legitimately black, so `lit` is in the thousands while the min sentinel
      // was never touched, and reading it anyway printed 1,048,575.9998.
      const rawMin = v[TS_MIN] >>> 0;
      return {
        dispatched: true,
        tiles: blocks,
        texelsPerTile: texels,
        texels: total,
        lit,
        empty: v[TS_EMPTY] >>> 0,
        // Over the WHOLE POOL, so it is bounded by the share of blocks a live
        // probe holds and is small on any scene smaller than the pool. Divide
        // by `liveProbes · texelsPerTile` for the number that says whether the
        // BAKE is working — see `formatSrcTiles`.
        coverage: total > 0 ? lit / total : 0,
        meanKnownBins: lit > 0 ? (v[TS_KNOWN] >>> 0) / lit : 0,
        /**
         * ⚠ `totalBins` is NOT the denominator of `meanKnownBins` — see
         * `lobeBins`. It is kept because callers report the bin count, and
         * `lobeBins` is what the ratio is actually out of.
         */
        totalBins: nBins,
        lobeBins,
        knownFrac: lit > 0 && lobeBins > 0
          ? (v[TS_KNOWN] >>> 0) / lit / lobeBins : 0,
        meanLum: lit > 0 ? (v[TS_SUM] >>> 0) / lit / LUM_FIXED : 0,
        minLum: rawMin === 0xffffffff ? 0 : rawMin / LUM_FIXED,
        maxLum: (v[TS_MAX] >>> 0) / LUM_FIXED,
      };
    },

    dispose() {
      cosTable?.value?.dispose?.();
      stats?.value?.dispose?.();
      atlas.dispose?.();
    },
  };
}

/**
 * The per-frame tile line, for the telemetry log.
 *
 * `liveProbes` turns the raw coverage into the number that means something: a
 * probe holds one tile, so `lit / (live · texelsPerTile)` is the share of
 * texels the bake actually filled in tiles somebody OWNS. Raw coverage over the
 * whole pool is 1.6% on the smoke scene and 93% of claimed tiles, and only the
 * second number says anything about [H].
 */
export function formatSrcTiles(t, liveProbes = 0) {
  if (!t?.dispatched) return "";
  const owned = liveProbes * t.texelsPerTile;
  return `tiles ${t.lit}/${owned || t.texels} texels lit` +
    (owned ? ` (${(100 * t.lit / owned).toFixed(0)}% of claimed)` : "") +
    `, ${t.meanKnownBins.toFixed(1)}/${(t.lobeBins ?? t.totalBins).toFixed(1)} lobe bins ` +
    `(${((t.knownFrac ?? 0) * 100).toFixed(0)}%), ` +
    `E ${t.minLum.toFixed(3)}..${t.maxLum.toFixed(3)}`;
}
