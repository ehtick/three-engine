// SPLIT RADIANCE CASCADES — [I] THE SCREEN GATHER. THE BLOCKS GO AWAY.
//
// Per shading point: the ≤8 nearest c0 probes, sparse-trilinear-renormalized,
// each contributing ONE filtered tile sample in the point's normal direction,
// blended across the LOD overlap band. `srcRef.js`'s `gatherPixel` is the
// mirror and `test:gi-src-gather` diffs the two.
//
// This replaces `srcGather.js`, which assigned ONE probe per pixel with NO
// interpolation — the reason every frame since §12.17 has been ~0.6 m
// rectangles. Those rectangles were the probe cells at the correct spacing, so
// no amount of probe density was ever going to remove them; interpolation is.
//
// ══ IT IS A CLOSURE FIRST AND A PASS SECOND, AND THAT IS THE POINT ═════════
//
// `gatherAt(position, normal)` answers for an ARBITRARY WORLD POINT. Three call
// sites want that and they are not the same shape:
//
//   • the primary diffuse term, once per gbuffer pixel — which runs here, in
//     its own compute pass, and hands `createGiResolve` a texture;
//   • the EXACT-REFLECTION HIT, at a world point no screen texture can answer
//     for. That call site has been on `gather == null` since the transport died
//     (§12.17.3) and this is the unit that brings it back;
//   • [J]'s SECOND BOUNCE (`srcSecondary.js`), once per entry of the deposit's
//     hit list — a set of world points with no screen grid at all, which is why
//     omitting `readPixel` here builds the closure and nothing else.
//
// One definition, three call sites. The alternative — a screen pass plus a
// separate closure for reflections — is two implementations of the same
// integral, and the one nobody looks at drifts.
//
// ══ WHY THE PRIMARY TERM STILL GOES THROUGH A TEXTURE ══════════════════════
//
// The resolve kernel already carries the gbuffer, the emitter slots, the
// occupancy pyramid and the BVH against a PORTABLE limit of EIGHT storage
// buffers per stage. `gatherAt` costs two of them (see the lookup below), which
// is affordable ONCE — for the reflection path, which is a single call — and
// not per-pixel on top of everything else the resolve wants. So the primary
// term is computed here, at half res, and sampled as a texture; a texture
// binding is free of that limit.
//
// ══ TWO STORAGE BUFFERS, NOT THREE, AND `hashBlock` IS WHY ═════════════════
//
// The natural corner lookup is three fetches: `hashKeys` → hash slot,
// `hashSlot` → probe index, `probeTable[probe].block` → the tile. Three storage
// buffers in a kernel that has none to spare.
//
// So the frame publishes `hashBlock`, one word per c0 hash slot holding that
// slot's BIN BLOCK directly. It is written by a pass over the hash region that
// already ran everything it needs, it costs 128 KB at the engine default, and
// it collapses the lookup to `hashKeys` + `hashBlock`. The probe INDEX is never
// needed here — only its tile — so carrying it was pure indirection.
//
// ══ COVERAGE IS FOLDED INTO THE WEIGHT, AND IT IS R1 APPLIED TWICE ═════════
//
// The atlas's alpha is 1 where a texel found a known bin and 0 where it did not
// (§12.21.4). Filtered, it is `Σ w_tap` over the covered taps, exactly as the
// filtered rgb is `Σ w_tap · E`. So each corner contributes
//
//     numerator   += rgb · w_corner        (already Σ w_tap·E inside)
//     denominator += a   · w_corner        (already Σ w_tap   inside)
//
// and ONE division at the end is the coverage-weighted mean over every
// contributing texel of every contributing probe. Consequences, both wanted:
//
//   • a probe that knows NOTHING about this direction (a = 0) drops out of the
//     interpolation and the others renormalize — the same treatment
//     `sparseGather` gives a probe that does not exist;
//   • a probe whose tap STRADDLES the edge of what it knows contributes in
//     proportion to what it knows.
//
// Dividing per tap instead would give every probe an equal vote regardless of
// how much of its tap was real. §12.21.4 measured 6.7% of claimed-tile texels
// carrying no information, so this is not a corner case.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 [I], §12.18.7 unit 5, §12.10.1.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  atomicAdd,
  atomicMax,
  atomicMin,
  atomicStore,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  ivec3,
  texture,
  textureStore,
  uint,
  vec3,
  vec4,
} from "three/tsl";
import { MAX_LODS, W0 } from "./srcConfig.js";
import {
  chebyshev,
  latticeOrigin,
  lodAtDistance,
  lodBlend,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";
import { SLOT_EMPTY } from "./srcProbes.js";

/** Gather telemetry — the same five failures `srcGather.js` learned to separate. */
export const GG_PIXELS = 0;   // pixels with a valid gbuffer sample
export const GG_LIT = 1;      // ...that came out above zero
export const GG_EMPTY = 2;    // ...that found no probe with coverage at all
export const GG_SUM = 3;
export const GG_MIN = 4;
export const GG_MAX = 5;
export const GG_CORNERS = 6;  // Σ corners that contributed, over lit pixels
export const GG_WORDS = 8;
const LUM_FIXED = 4096;

/**
 * The trilinear corner offsets, in `srcMath.js`'s `trilinearCorners` order:
 * corner k is `(k&1, (k>>1)&1, k>>2)`. Same ordering as `srcMerge.js` uses, for
 * the same reason — a gate compares corner k against corner k.
 */
const CORNERS = Array.from({ length: 8 }, (_, k) => [k & 1, (k >> 1) & 1, (k >> 2) & 1]);

/**
 * Build the position-indexed probe gather.
 *
 * @param {object} store   from `createSrcProbeStore`
 * @param {object} tiles   from `createSrcTileAtlas`
 * @param {object} options
 * @param {object} options.lookup  `createSrcHashBlockLookup`'s closure —
 *   key → bin block, or SLOT_EMPTY
 * @param {Node|number} options.spacing0
 * @param {Node} options.camera  world camera position; the LOD metric's centre
 * @param {Node} options.anchor  the SAME lattice anchor the population used
 * @param {Node} [options.lodBias]  added to the fractional LOD before the shell
 *   split — [J]'s dial for reading the field COARSER than the shading point's
 *   own LOD (srcConfig's `SECONDARY_LOD_OFFSET`). ABSENT on the screen pass,
 *   deliberately: no node is added and the graph is byte-identical to the one
 *   every pre-[J] gate measured.
 * @param {(i) => object} [options.readPixel]  the gbuffer, as a closure. Omit
 *   it (with `width`/`height`) to build the CLOSURE ONLY — `gatherAt` and
 *   nothing else. `srcSecondary.js` wants the integral at a hit list, not at a
 *   screen grid, and building the pass anyway would allocate a storage texture
 *   nothing ever samples and a dispatch nothing ever runs.
 * @param {number} [options.width]  gbuffer width
 * @param {number} [options.height]
 */
export function createSrcScreenGather(store, tiles, {
  lookup,
  spacing0,
  camera,
  anchor,
  readPixel = null,
  width = 0,
  height = 0,
  lodBias = null,
  maxLods = MAX_LODS,
  w0 = W0,
} = {}) {
  void store;
  void w0;

  /**
   * THE GATHER. One world point, one normal, one irradiance.
   *
   * Inlined at both call sites — the screen pass below and
   * `createGiResolve`'s exact-reflection hit — so there is one integral, not
   * two that happen to agree today.
   */
  const gatherAt = (position, normal) => {
    const P = vec3(position).toVar();
    const N = vec3(normal).normalize().toVar();
    const lodF = lodAtDistance(chebyshev(P, camera), spacing0, maxLods).toVar();
    // The bias is RE-CLAMPED to the same window `lodAtDistance` returns. A
    // negative bias would otherwise select a lattice finer than any the
    // population inserts at (every corner misses, silently) and a positive one
    // past the last shell would index a LOD the 4-bit key cannot hold.
    if (lodBias) lodF.assign(lodF.add(float(lodBias)).clamp(0, maxLods - 1));
    // `lodShells` on the CPU returns one or two shells; a GPU kernel cannot
    // branch on a list length, so both are written out and the second is
    // guarded by its own weight. `min(maxLods - 1)` matches the mirror's clamp
    // exactly — a point past the last shell samples the last shell rather than
    // an empty one.
    const base = floor(lodF).min(maxLods - 1).toVar();
    const blend = lodBlend(lodF).toVar();

    const out = vec3(0).toVar();
    const shellTotal = float(0).toVar();
    const cornersHit = uint(0).toVar();

    /** One LOD shell's sparse-trilinear, coverage-weighted gather. */
    const shell = (lod, shellWeight) => {
      const s = probeSpacing(0, lod, spacing0).toVar();
      const origin = latticeOrigin(anchor, s).toVar();
      const f = P.sub(origin).div(s).toVar();
      const cell0 = floor(f).toVar();
      const t = f.sub(cell0).toVar();
      const baseCell = ivec3(int(cell0.x), int(cell0.y), int(cell0.z)).toVar();

      const acc = vec3(0).toVar();
      const wsum = float(0).toVar();
      for (let k = 0; k < 8; k++) {
        const [dx, dy, dz] = CORNERS[k];
        const weight = (dx ? t.x : float(1).sub(t.x))
          .mul(dy ? t.y : float(1).sub(t.y))
          .mul(dz ? t.z : float(1).sub(t.z))
          .toVar();
        If(weight.greaterThan(0), () => {
          // `secondary` is 0: the multibounce cache is Phase 5's caller, not a
          // parameter here. Out-of-window cells pack to KEY_EMPTY and the WGSL
          // find answers "absent" for key 0 by its first line, so an
          // unrepresentable corner is a missing corner with no extra guard.
          const block = lookup(
            packProbeKey(int(lod), uint(0), baseCell.add(ivec3(dx, dy, dz))),
          ).toVar();
          If(block.notEqual(uint(SLOT_EMPTY)), () => {
            // ONE hardware-bilinear tap. rgb is `Σ w_tap·E` over the covered
            // taps and a is `Σ w_tap` over the same ones — see the header on
            // why both ride the accumulation instead of dividing here.
            const tap = tiles.sampleTileRGBA(block, N).toVar();
            acc.addAssign(tap.xyz.mul(weight));
            wsum.addAssign(tap.w.mul(weight));
            cornersHit.addAssign(uint(1));
          });
        });
      }
      // `wsum` is COVERAGE, not corner count. A shell whose every probe exists
      // and knows nothing about this direction has corners but no coverage, and
      // dividing by the corner weight would hand the pixel a black vote from a
      // probe that never claimed to know (the mirror makes the same
      // distinction, and it is the whole of R1).
      If(wsum.greaterThan(0), () => {
        out.addAssign(acc.div(wsum).mul(shellWeight));
        shellTotal.addAssign(shellWeight);
      });
    };

    shell(base, float(1).sub(blend));
    // The overlap band is the top 10% of each LOD's span, so most points take
    // this branch uniformly false and pay nothing. Guarded on the WEIGHT rather
    // than unconditionally, because the second shell is eight more hash lookups
    // and eight more taps.
    If(blend.greaterThan(0).and(base.add(1).lessThan(float(maxLods))), () => {
      shell(base.add(1), blend);
    });

    // A SHELL WITH NO PROBES MUST NOT DARKEN THE POINT — the shell that did
    // find some carries full weight. Same renormalize-don't-zero rule, one
    // level up from the corners.
    If(shellTotal.greaterThan(0), () => { out.assign(out.div(shellTotal)); });
    return { irradiance: out, corners: cornersHit };
  };

  // CLOSURE-ONLY, and the header's first section is the whole argument for it:
  // this module is a gather that HAPPENS to own a screen pass, not a screen
  // pass that exposes a gather. [J] wants the integral over a hit list, so it
  // takes the closure and stops here — no storage texture, no dispatch, and
  // (importantly) no `__giSrcTargetVersion` bump, which would make the
  // resolve's texture look re-created to a build that never asked for one.
  if (!readPixel) {
    return { gatherAt, width: 0, height: 0, dispose() {} };
  }

  // ── the screen pass ───────────────────────────────────────────────────────
  const target = new THREE.StorageTexture(width, height);
  target.type = THREE.HalfFloatType;
  target.name = "giSrcGather";
  target.version = (globalThis.__giSrcTargetVersion = (globalThis.__giSrcTargetVersion ?? 0) + 1);

  const stats = instancedArray(new Uint32Array(GG_WORDS), "uint").toAtomic();
  const widthU = width;

  const reset = Fn(() => {
    for (let w = 0; w < GG_WORDS; w++) {
      atomicStore(stats.element(uint(w)), uint(w === GG_MIN ? 0xffffffff : 0));
    }
  })().compute(1);

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const coord = ivec2(i.mod(uint(widthU)).toInt(), i.div(uint(widthU)).toInt());
    const E = vec3(0).toVar();
    const px = readPixel(i);
    If(px.valid, () => {
      atomicAdd(stats.element(uint(GG_PIXELS)), uint(1));
      // The normal arrives ALREADY faced toward the camera (srcSystem's
      // `readPixel`) — the same vector the deposit filled these probes' bins
      // along, so the hemisphere this reads is the hemisphere that was filled.
      const g = gatherAt(px.position, px.normal);
      E.assign(g.irradiance);
      atomicAdd(stats.element(uint(GG_CORNERS)), g.corners);
      If(g.corners.equal(uint(0)), () => {
        atomicAdd(stats.element(uint(GG_EMPTY)), uint(1));
      });
      const lum = E.x.mul(0.2126).add(E.y.mul(0.7152)).add(E.z.mul(0.0722)).toVar();
      If(lum.greaterThan(0), () => {
        const fx = lum.mul(LUM_FIXED).toUint().toVar();
        atomicAdd(stats.element(uint(GG_LIT)), uint(1));
        atomicAdd(stats.element(uint(GG_SUM)), fx);
        atomicMin(stats.element(uint(GG_MIN)), fx);
        atomicMax(stats.element(uint(GG_MAX)), fx);
      });
    });
    textureStore(target, coord, vec4(E, 1));
  })().compute(width * height);

  return {
    /** The shared integral. `createGiResolve` inlines this for reflection hits. */
    gatherAt,
    reset,
    compute,
    target,
    stats,
    /** The resolve's primary-diffuse input: one texture load, no storage bindings. */
    node: texture(target),
    width,
    height,

    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, pixels: 0, lit: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const lit = v[GG_LIT] >>> 0;
      const pixels = v[GG_PIXELS] >>> 0;
      const rawMin = v[GG_MIN] >>> 0;
      const min = rawMin === 0xffffffff ? 0 : rawMin / LUM_FIXED;
      const max = (v[GG_MAX] >>> 0) / LUM_FIXED;
      return {
        dispatched: true,
        pixels,
        lit,
        // Pixels that found no probe with coverage anywhere in their stencil.
        // Distinct from "lit == 0": this one is about the POPULATION, and it is
        // the number that separates "GI is dark here" from "GI has nothing here".
        empty: v[GG_EMPTY] >>> 0,
        // Mean contributing corners per pixel, out of 8 (or 16 across the
        // overlap band). Below ~4 means the c0 population is thinner than the
        // trilinear stencil wants and the renormalization is carrying the
        // result — which is legal, and worth seeing.
        meanCorners: pixels > 0 ? (v[GG_CORNERS] >>> 0) / pixels : 0,
        meanLum: lit > 0 ? (v[GG_SUM] >>> 0) / lit / LUM_FIXED : 0,
        minLum: min,
        maxLum: max,
        // A gather with no interpolation is FLAT across a probe cell; a smooth
        // one is not. Contrast alone cannot tell them apart — that is what the
        // gate's gradient arm is for — but a zero here means no variation at
        // all, which is the one reading that is unambiguous.
        contrast: max > 0 ? 1 - min / max : 0,
      };
    },

    dispose() {
      stats?.value?.dispose?.();
      target.dispose?.();
    },
  };
}

/** The per-frame gather line, for the telemetry log. */
export function formatSrcGather(g) {
  if (!g?.dispatched) return "";
  return `gather ${g.lit}/${g.pixels} lit (${g.meanCorners.toFixed(1)} corners` +
    (g.empty ? `, ${g.empty} EMPTY` : "") +
    `), E ${g.minLum.toFixed(3)}..${g.maxLum.toFixed(3)} mean ${g.meanLum.toFixed(3)}`;
}
