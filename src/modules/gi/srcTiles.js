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
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  IRRADIANCE_TILE_BORDER,
  IRRADIANCE_TILE_INTERIOR,
  W0,
  binGridWidth,
} from "./srcConfig.js";
import { tileCosineWeights } from "./srcMath.js";
import { octahedralUV } from "./srcOctahedral.js";
import { PAYLOAD_WORDS } from "./srcDeposit.js";

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
  interior = IRRADIANCE_TILE_INTERIOR,
  border = IRRADIANCE_TILE_BORDER,
  sub = COSINE_SUB,
  maxDimension = 8192,
  sky = null,
} = {}) {
  const info = bins.cascades[0];
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

  const w = binGridWidth(0, w0);
  const table = tileCosineWeights(w, interior, sub, border);
  const cosTable = instancedArray(table, "float");
  const stats = instancedArray(new Uint32Array(TS_WORDS), "uint").toAtomic();
  const { payload } = bins;
  const skyNode = sky ? vec3(sky) : vec3(0);

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

    const base = uint(info.binBase).add(block.mul(uint(nBins))).toVar();
    const row = t.mul(uint(nBins)).toVar();
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    const known = uint(0).toVar();

    // A dynamic loop rather than a JS unroll: `nBins` is 32 at the shipping w₀
    // and 128 on the ultra tier, and 128 unrolled call sites is a compile-time
    // cost for no gain — every iteration reads the same two buffers with no
    // divergence worth flattening.
    Loop({ start: 0, end: nBins, type: "uint", name: "m" }, ({ m }) => {
      const cw = cosTable.element(row.add(m)).toVar();
      If(cw.greaterThan(0), () => {
        const o = base.add(m).mul(uint(PAYLOAD_WORDS)).toVar();
        // ZERO-COUNT BINS ARE UNKNOWN, NOT ZERO. Excluded from the average, and
        // the rest renormalize over what was found — feeding one in as black is
        // a hard cliff at the edge of every sparsely-sampled region, and at 0.78
        // rays per bin (§12.13.4) that edge is everywhere rather than exotic.
        const T = payload.element(o.add(uint(3))).toVar();
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
          acc.addAssign(vec3(
            payload.element(o),
            payload.element(o.add(uint(1))),
            payload.element(o.add(uint(2))),
          ).add(skyNode.mul(T)).mul(cw));
          wsum.addAssign(cw);
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
      cover.assign(1);
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
    const bx = block.mod(uint(layout.perRow)).toVar();
    const by = block.div(uint(layout.perRow)).toVar();
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
    textureStore(atlas, coord, vec4(E, cover));
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
    const bx = float(b.mod(uint(layout.perRow))).toVar();
    const by = float(b.div(uint(layout.perRow))).toVar();
    // `+0.5` puts an integer coordinate on a texel CENTRE, which is what makes
    // an integer `u` sample that texel exactly rather than blending two.
    const uv = vec2(
      bx.mul(tileSize).add(u).add(0.5).div(layout.width),
      by.mul(tileSize).add(v).add(0.5).div(layout.height),
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
        totalBins: nBins,
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
    `, ${t.meanKnownBins.toFixed(1)}/${t.totalBins} bins, ` +
    `E ${t.minLum.toFixed(3)}..${t.maxLum.toFixed(3)}`;
}
