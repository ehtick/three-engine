// SURFACE RADIANCE CACHE — THE GPU HALF (docs/GI_NEXT_ARCHITECTURE.md §6.3/§6.4).
//
// `surfaceCache.js` is the CPU builder and THE AUTHORITY on the packed layout;
// this file is its GPU mirror. Two things live here and nothing else:
//
//   1. the three atlas textures §6.3 specifies (`srcMaterial`, `srcGeometry`,
//      `srcRadiance`, rgba16f), sized off surfaceCache's own tier constants;
//   2. the §6.4 hot-path lookup as a TSL function, written to read EXACTLY what
//      `packCardWords` writes — same argmax, same axis order, same sign
//      mirroring, same EPS guards. Where §6.4's prose and the real packer
//      disagree, THE PACKER WINS; every such case is listed below.
//
// The §6.6 lighting pass is NOT here, and nothing is wired into GISystem — see
// the INTEGRATION POINTS block at the bottom of this file.
//
// ══ BINDING BUDGET (§6.5, audited 2026-08-07) ═══════════════════════════════
//
// SAMPLED textures: `srcRadiance` is ONE, against a WebGPU baseline of 16 and a
// current worst case of 3 in this module. That is the whole reason the hot path
// may read a texture at all. `srcMaterial`/`srcGeometry` are LIGHTING-PASS ONLY
// and must never be bound into a trace kernel — `hotBindings()` exists so a
// caller can say which is which without reaching for the wrong field.
//
// STORAGE textures: baseline 4, and `GISystem.js:1889-1895` records the resolve
// already writing irradiance + emitterShadow + radiance (+ a BVH target with
// exact reflections on). All three atlases are storage-writable, so §6.6's
// dispatch writing them costs 3 — fine ALONE, fatal folded into the resolve.
// `createSurfaceCacheAtlas` therefore returns them as a separate group and says
// so; §6.9 carries the fold as a kill criterion.
//
// STORAGE buffers: zero new ones. The card table rides the occupancy `bits`
// tail that every consumer already binds (§6.3), reached through the object
// block's word +23.
//
// ══ WHAT §6.4 GETS WRONG ABOUT THE REAL PACKER ══════════════════════════════
//
// §6.4 reads:
//     pLocal  = invWorld · P
//     axis    = argmax |dot(nLocal, ±e_k)|
//     (s, t)  = the two pLocal coords ⊥ axis, / halfExtents  →  [0,1]²
//     uv      = cardRect.xy + (s, t) · cardRect.zw
//     rad     = textureSampleLevel(srcRadiance, linearSampler, uv, 0).rgb
//
// Against `cardProject`/`packCardWords`, seven things are wrong or missing:
//
//  A. `/halfExtents` yields [-1, 1], NOT [0, 1]². The packer's affine remap is
//     `(x/h + 1) * 0.5`. Missing it halves the card and mirrors half of it.
//  B. The s axis is SIGN-MIRRORED: `s = ((p[ia]·sign)/hu + 1)·0.5`. The three
//     negative-sign cards are handed images of their positive twins, because
//     that is what an orthographic view from the other side sees. Dropping the
//     factor is invisible on a symmetric test object and catastrophic on a real
//     one — it flips left/right in exactly half the cards.
//  C. "the two ⊥ coords" is ORDERED: s comes from ia = (axis+1)%3, t from
//     ib = (axis+2)%3. Swapping them transposes the card.
//  D. `argmax |dot(nLocal, ±e_k)|` names 3 states; the table has 6 SLOTS. The
//     sign of n along the winning axis picks between them:
//     `slot = axis*2 + (n[axis] < 0)`, plus `layer*6` for the depth peel that
//     `__giSrcCards` turns on. §6.4's formula as written cannot address the
//     table at all.
//  E. The lookup OMITS THE TABLE FETCH. Before any of the "~15 ALU" there are
//     five storage loads: word +23 (bitcast f32 → u32, relative to `baseWord`
//     exactly like words +20/+21), then u0/v0/du/dv at
//     `cardTableRel + slot*8` (bitcast f32) and the raw-u32 flags word at +7.
//  F. There is no fallback in §6.4. Word +23 == 0 (demoted object, §6.7) and
//     flags bit 0 clear (inactive slot — a plane allocates 2 of its 6) are the
//     SAME failure and take the SAME branch back to the header mean albedo.
//     One flag, one select; see `sampleOrFallback`.
//  G. `halfExtents` needs the packer's `max(h, 1e-9)` guard. A PlaneGeometry
//     has a genuinely zero half extent and `cardProject` divides by it; without
//     the guard the GPU produces inf/NaN where the CPU produces 0.5.
//
// And one that is not an error but a hole:
//
//  H. §6.4 assumes `nLocal` is in hand at the hit. IT IS NOT. `trace({objId:
//     true})` returns an oct-packed WORLD normal, and the header carries only
//     invWorld = M⁻¹; recovering the object-space geometric normal needs Mᵀ,
//     which is nowhere. `M⁻¹·nWorld` ranks the same as `Mᵀ·nWorld` ONLY under
//     uniform scale. The exactly-correct normal is free INSIDE `traceDynBody`
//     (dynamicObjects.js) — it is `nL` before the covariant transform and
//     before the double-sided flip — so the recommended wiring computes the
//     slot there and hands it out; `sampleAtSlot` is that entry point, and
//     `sample` is §6.4's literal form for callers who really do have nLocal.
//
// ══ WHY BILINEAR NEEDS A CLAMP §6.4 DOES NOT MENTION ════════════════════════
//
// "Bilinear filtering across the card is free (hardware)" is true of the card
// INTERIOR. At the rect border a bilinear tap reaches half a texel outside, into
// `createCardAtlas`'s 1-texel gutter, which no card owns and §6.6 does not write
// — a dark rim on every card silhouette. The lookup therefore clamps uv into the
// rect inset by half a texel, which costs 2 ALU and makes the edge texel read
// itself instead of the void. It stays correct (and free) if §6.6 later dilates
// content into the gutter.
import * as THREE from "three/webgpu";
import { If, bitAnd, float, select, texture, uint, uintBitsToFloat, vec2, vec3, vec4 } from "three/tsl";
import { sharedFn } from "./giFn.js";
import {
  CARD_FLAG, CARD_SLOTS, CARD_WORDS, SRC_ATLAS_SIZE, SRC_ATLAS_TIERS,
  atlasBytes, atlasTierForBudget,
} from "./surfaceCache.js";

/**
 * The half-extent guard. MUST equal `surfaceCache.js`'s private `EPS` — a plane
 * divides by a zero half extent and the two halves have to agree about what
 * happens then. `run-gi-card-lookup-test.mjs` exercises it on PlaneGeometry.
 */
export const CARD_EPS = 1e-9;

/**
 * Per-axis component order as (u, v, depth) — `ia = (axis+1)%3`,
 * `ib = (axis+2)%3`, then the axis itself, which is `cardProject`'s convention.
 * DERIVED, never typed out: the TSL swizzles and the JS mirror below both read
 * this table, so they cannot drift from each other.
 */
export const CARD_AXIS_ROT = [0, 1, 2].map((a) => [(a + 1) % 3, (a + 2) % 3, a]);

const COMP = ["x", "y", "z"];

// ════════════════════════════════════════════════════════════ atlas textures

// Same forced-version trap `createGiTargets` documents: three invalidates a
// cached bind group only when `binding.generation !== textureData.generation`,
// and a freshly constructed texture has version 0 — so swapping one brand-new
// texture for another is INVISIBLE and every material keeps the destroyed one.
let atlasGeneration = 0;

/** Snaps a requested edge to the nearest legal tier at or below it. */
export function snapAtlasTier(size) {
  for (const tier of SRC_ATLAS_TIERS) if (size >= tier) return tier;
  return SRC_ATLAS_TIERS[SRC_ATLAS_TIERS.length - 1];
}

/**
 * Allocates §6.3's three atlases.
 *
 * Sizing comes from `surfaceCache.js`'s tier ladder, not from a number here:
 * pass `size` for an explicit tier or `budgetBytes` to take the largest tier
 * whose THREE rgba16f planes fit (`atlasBytes` — 100.7 MB at 2048², which is 4×
 * what §6.3's prose claims; the prose quotes the 1024² figure).
 *
 * @param {object} [o]
 * @param {number} [o.size]         explicit atlas edge, snapped to a tier
 * @param {number} [o.budgetBytes]  byte budget for all three planes
 * @param {string} [o.name]         name prefix for the textures (diagnostics)
 */
export function createSurfaceCacheAtlas({ size, budgetBytes, name = "giSrc" } = {}) {
  const edge = size != null
    ? snapAtlasTier(size)
    : budgetBytes != null
      ? atlasTierForBudget(budgetBytes)
      : SRC_ATLAS_SIZE;
  const version = ++atlasGeneration;
  const make = (label, filter) => {
    const t = new THREE.StorageTexture(edge, edge);
    t.format = THREE.RGBAFormat;
    // rgba16float: storage-capable AND filterable on base WebGPU — the same
    // reason `distanceTexture` is half float rather than u8 (giField.js:104).
    t.type = THREE.HalfFloatType;
    t.minFilter = filter;
    t.magFilter = filter;
    t.generateMipmaps = false;
    t.name = `${name}${label}`;
    t.version = version;
    return t;
  };
  // albedo.rgb + coverage.a. Lighting pass only; read per texel, never filtered.
  const srcMaterial = make("Material", THREE.NearestFilter);
  // oct normal.rg + object-space depth.b + emissive luminance.a. Same.
  const srcGeometry = make("Geometry", THREE.NearestFilter);
  // outgoing radiance.rgb + age.a — THE ONE the trace kernels sample, and the
  // ONLY one that is filtered. Bilinear across the card is the entire point of
  // §6.4: it is what makes the result continuous where the trilinear voxel read
  // was not.
  const srcRadiance = make("Radiance", THREE.LinearFilter);

  return {
    size: edge,
    texel: 1 / edge,
    srcMaterial,
    srcGeometry,
    srcRadiance,
    /**
     * What a TRACE kernel may bind: one sampled texture, nothing else. The
     * other two are lighting-pass inputs and binding them in a trace would
     * spend sampled-texture headroom on data the hot path cannot use.
     */
    hotBindings() {
      return { srcRadiance };
    },
    /**
     * What §6.6's dispatch writes: 3 storage textures against a baseline of 4.
     * Enumerated rather than described because §6.9's kill criterion is a
     * count — and because folding any of it into the resolve reaches a 5th.
     */
    lightingTargets() {
      return { srcMaterial, srcGeometry, srcRadiance };
    },
    get stats() {
      return {
        size: edge,
        tier: SRC_ATLAS_TIERS.indexOf(edge),
        bytes: atlasBytes(edge),
        planes: 3,
        sampledInHotPath: 1,
        storageTexturesWhenLit: 3,
      };
    },
    dispose() {
      srcMaterial.dispose();
      srcGeometry.dispose();
      srcRadiance.dispose();
    },
  };
}

// ══════════════════════════════════════════════════ the lookup, as plain JS
//
// The JS below is the LINE-BY-LINE MIRROR of the TSL further down: same table,
// same order, same guards. It exists because the shader cannot be run in a node
// test, and `scripts/run-gi-card-lookup-test.mjs` asserts it against
// `surfaceCache.js`'s `cardProject`/`cardUnproject` ground truth — so a drift
// between this and the packer is a red test rather than a silent wrong colour.
// Keep the two in step: every edit here needs the same edit in `lookupFn`.

/**
 * §6.4's card choice, in the BRANCHLESS form the shader uses.
 * `surfaceCache.cardSlotFor` is the same decision written with if/else-if; the
 * test pins the two against each other over a dense set of normals, so this is
 * an independent route to the same answer rather than a copy of it.
 *
 * @returns {{axis: number, sign: number, signBit: number, slot: number}}
 */
export function cardArgmaxSlot(nx, ny, nz, layer = 0) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const useY = ay > ax && ay >= az;
  const useZ = !useY && az > ax && az > ay;
  const axis = useY ? 1 : useZ ? 2 : 0;
  const n = useY ? ny : useZ ? nz : nx;
  const signBit = n < 0 ? 1 : 0;
  return { axis, sign: signBit ? -1 : 1, signBit, slot: layer * CARD_SLOTS + axis * 2 + signBit };
}

/**
 * Card-space (s, t) — and the depth `srcGeometry.b` carries — for a point in
 * the object's OBB-centred local space. `cardProject` without the atlas rect.
 *
 * The TSL hot path computes s and t only: the radiance read does not need
 * depth, §6.6's write does. It is computed here so the test can compare all
 * three against `cardProject` in one pass.
 */
export function cardStFromLocal(axis, sign, p, he) {
  const r = CARD_AXIS_ROT[axis];
  const pu = p[r[0]], pv = p[r[1]], pd = p[r[2]];
  const hu = Math.max(he[r[0]], CARD_EPS);
  const hv = Math.max(he[r[1]], CARD_EPS);
  const hd = Math.max(he[r[2]], CARD_EPS);
  return {
    s: ((pu * sign) / hu + 1) * 0.5,
    t: (pv / hv + 1) * 0.5,
    depth: (hd - pd * sign) / (2 * hd),
  };
}

/**
 * Card-space → atlas uv, with the half-texel inset that keeps a bilinear tap
 * inside the card's own rect (see the header note about the gutter).
 * `clamped` reports whether the inset actually moved the sample — the test uses
 * it to prove the clamp is load-bearing at silhouettes and inert elsewhere.
 */
export function cardUvFromSt(rect, s, t, atlasSize = SRC_ATLAS_SIZE) {
  const half = 0.5 / atlasSize;
  const rawU = rect.u0 + s * rect.du;
  const rawV = rect.v0 + t * rect.dv;
  const loU = rect.u0 + half, loV = rect.v0 + half;
  const hiU = Math.max(loU, rect.u0 + rect.du - half);
  const hiV = Math.max(loV, rect.v0 + rect.dv - half);
  const u = Math.min(hiU, Math.max(loU, rawU));
  const v = Math.min(hiV, Math.max(loV, rawV));
  return { u, v, rawU, rawV, clamped: u !== rawU || v !== rawV };
}

/**
 * The five storage words the lookup reads out of one card record, in the shader's
 * own encoding: u0/v0/du/dv are f32 bitcast into u32 words (`packCardWords`'s
 * convention), flags is raw u32.
 *
 * @param {Uint32Array} words   the card-word region (a `buildSurfaceCache` result)
 * @param {number} cardTableRel object block word +23 — base RELATIVE to the region
 * @param {number} slot         `layer*6 + axis*2 + signBit`
 */
export function cardRectWords(words, cardTableRel, slot) {
  const at = cardTableRel + slot * CARD_WORDS;
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  return {
    u0: f32[at], v0: f32[at + 1], du: f32[at + 2], dv: f32[at + 3],
    flags: words[at + 7] >>> 0,
    active: (words[at + 7] & CARD_FLAG.active) !== 0,
  };
}

/**
 * The whole §6.4 lookup in JS, including both fallback gates. Mirrors
 * `lookupFn` exactly; returns everything the shader computes plus the pieces
 * the shader deliberately drops (depth, the pre-clamp uv).
 *
 * `valid === false` is the ONE fallback flag: word +23 was 0 (demoted object,
 * §6.7) or the argmax landed in an inactive slot. Callers take the header mean
 * albedo / mean emissive in both cases, through the same branch.
 */
export function cardLookupMirror({
  words, cardTableRel, pLocal, nLocal, halfExtents, atlasSize = SRC_ATLAS_SIZE, layer = 0, slot = null,
}) {
  const pick = slot != null
    ? { slot, axis: ((slot % CARD_SLOTS) / 2) | 0, sign: slot % 2 === 0 ? 1 : -1 }
    : cardArgmaxSlot(nLocal[0], nLocal[1], nLocal[2], layer);
  const out = { ...pick, valid: false, u: 0, v: 0, s: 0, t: 0, depth: 0, rect: null, clamped: false };
  if (!(cardTableRel > 0)) return out;
  const rect = cardRectWords(words, cardTableRel, pick.slot);
  out.rect = rect;
  const st = cardStFromLocal(pick.axis, pick.sign, pLocal, halfExtents);
  out.s = st.s; out.t = st.t; out.depth = st.depth;
  if (!rect.active) return out;
  const uv = cardUvFromSt(rect, st.s, st.t, atlasSize);
  out.u = uv.u; out.v = uv.v; out.rawU = uv.rawU; out.rawV = uv.rawV;
  out.clamped = uv.clamped;
  out.valid = true;
  return out;
}

// ═══════════════════════════════════════════════════ the lookup, as TSL/WGSL

/**
 * §6.4's card radiance lookup.
 *
 * ONE WGSL function per shader (`sharedFn` — the per-builder Fn contract in
 * giFn.js), reading the card table straight out of the occupancy `bits` buffer
 * the caller already binds and sampling exactly one texture.
 *
 * @param {object} o
 * @param {any}    o.srcRadiance  the atlas plane from `createSurfaceCacheAtlas`
 * @param {any}    o.bits         the occupancy bits storage buffer
 * @param {number} o.baseWord     `occupancyField.dynamicObjectWordOffset`
 * @param {number} [o.atlasSize]  atlas edge in texels (for the half-texel inset)
 * @param {number} [o.layer]      depth-peel layer, 0..3 (§6.2's `__giSrcCards`)
 * @param {string} [o.name]       WGSL function name prefix
 */
export function createCardRadianceSampler({
  srcRadiance, bits, baseWord, atlasSize = SRC_ATLAS_SIZE, layer = 0, name = "giCardRadiance",
}) {
  const halfTexel = 0.5 / atlasSize;
  const layerBase = Math.max(0, Math.trunc(layer)) * CARD_SLOTS;

  /** Rotate a vec3 into (u, v, depth) order for a COMPILE-TIME axis. */
  const rot = (v, axis) => {
    const r = CARD_AXIS_ROT[axis];
    return vec3(v[COMP[r[0]]], v[COMP[r[1]]], v[COMP[r[2]]]);
  };

  /**
   * §6.4's `argmax |dot(nLocal, ±e_k)|` + the sign that picks between the two
   * slots of that axis. ~10 ALU, no branch. Inline (not its own WGSL function):
   * the recommended wiring computes the slot inside `traceDynBody`, where the
   * exact object-space normal already exists, and never calls this at all.
   */
  const slotFromNormal = (nLocal) => {
    const n = vec3(nLocal).toVar();
    const a = n.abs().toVar();
    const useY = a.y.greaterThan(a.x).and(a.y.greaterThanEqual(a.z)).toVar();
    const useZ = useY.not().and(a.z.greaterThan(a.x)).and(a.z.greaterThan(a.y)).toVar();
    const axisN = select(useY, n.y, select(useZ, n.z, n.x)).toVar();
    const axis = select(useY, float(1), select(useZ, float(2), float(0)));
    const signBit = select(axisN.lessThan(0), float(1), float(0));
    return axis.mul(2).add(signBit).add(float(layerBase)).toVar();
  };

  // The lookup body. Takes the SLOT, not the normal: the slot is the only thing
  // the card table can be indexed by, and computing it from a world normal is a
  // problem the consumer solves once (see note H in the header).
  const lookupFn = sharedFn({
    name,
    type: "vec4",
    inputs: [
      { name: "cardTableRel", type: "float" },
      { name: "slot", type: "float" },
      { name: "pLocal", type: "vec3" },
      { name: "halfExtents", type: "vec3" },
    ],
    body: (cardTableRel, slot, pLocal, halfExtents) => {
      // rgb = card radiance, a = the ONE fallback flag (0 ⇒ caller takes the
      // header mean albedo — demoted object AND inactive slot, same branch).
      const out = vec4(0, 0, 0, 0).toVar();
      // Word +23 == 0 is `buildSurfaceCache`'s "no cards" sentinel, and word 0
      // of the region is the object-count word so it can never be a legal table
      // start. Gated rather than clamped: with no table there is nothing safe to
      // read, and a garbage flags word could otherwise fake an active card.
      If(cardTableRel.greaterThan(0.5), () => {
        const s = float(0).toVar();
        const t = float(0).toVar();
        const localSlot = slot.sub(float(layerBase)).toVar();
        // Which axis this slot names. Three compile-time branches rather than a
        // dynamic vec3 index — WGSL has no dynamic swizzle, and the packer's
        // (ia, ib, axis) order is a compile-time table anyway (CARD_AXIS_ROT).
        for (let axis = 0; axis < 3; axis++) {
          const isAxis = localSlot.greaterThanEqual(float(axis * 2))
            .and(localSlot.lessThan(float(axis * 2 + 2)));
          If(isAxis, () => {
            // signBit = slot & 1 → sign −1 on the odd slot, exactly
            // `packCardWords`'s bit 2 of the axis|sign word.
            const sgn = select(localSlot.sub(float(axis * 2)).greaterThan(0.5), float(-1), float(1)).toVar();
            // (u, v, depth) order — `ia = (axis+1)%3`, `ib = (axis+2)%3`.
            const p = rot(pLocal, axis).toVar();
            // The packer's `max(h, EPS)`: a PlaneGeometry really does have a
            // zero half extent and `cardProject` divides by it.
            const h = rot(halfExtents, axis).max(vec3(CARD_EPS)).toVar();
            // s is SIGN-MIRRORED, t is not — the negative card is the handed
            // image of its positive twin. `cardProject`, verbatim.
            s.assign(p.x.mul(sgn).div(h.x).add(1).mul(0.5));
            t.assign(p.y.div(h.y).add(1).mul(0.5));
            // depth = (hd − p[axis]·sgn) / 2hd is `srcGeometry.b`'s channel and
            // §6.6's business; the radiance read does not need it, so it is not
            // emitted here. `cardStFromLocal` computes it for the test.
          });
        }
        // ── the table fetch §6.4 leaves out: 8 words per card, u0/v0/du/dv
        // bitcast f32, flags raw u32. Base is RELATIVE to `baseWord`, exactly
        // like the BVH bases in words +20/+21.
        const at = uint(baseWord)
          .add(cardTableRel.toUint())
          .add(slot.toUint().mul(uint(CARD_WORDS)))
          .toVar();
        const rf = (w) => uintBitsToFloat(bits.element(at.add(uint(w))));
        const rect = vec4(rf(0), rf(1), rf(2), rf(3)).toVar();
        const flags = bits.element(at.add(uint(7))).toVar();
        // A plane leaves 4 of its 6 slots all-zero; hitting one is the SAME
        // fallback a demoted object takes.
        If(bitAnd(flags, uint(CARD_FLAG.active)).notEqual(uint(0)), () => {
          // Half-texel inset so the bilinear tap cannot reach into the atlas
          // gutter (`createCardAtlas`'s padding), which no card owns.
          const lo = rect.xy.add(vec2(halfTexel)).toVar();
          const hi = rect.xy.add(rect.zw).sub(vec2(halfTexel)).max(lo).toVar();
          const uv = rect.xy.add(vec2(s, t).mul(rect.zw)).clamp(lo, hi).toVar();
          // Explicit level: implicit-derivative sampling is illegal WGSL in a
          // compute kernel (the same rule the width probe follows).
          out.assign(vec4(texture(srcRadiance, uv).level(0).xyz, 1));
        });
      });
      return out;
    },
  });

  return {
    layer,
    slotsPerObject: CARD_SLOTS,
    atlasSize,
    /** The slot §6.4's argmax picks, as a float node. */
    slotFromNormal,
    /**
     * The lookup, given the slot the trace already knows.
     * @returns {{radiance: any, valid: any}} `valid` is 1/0 — ONE flag for
     *          "demoted object" and "inactive slot" both.
     */
    sampleAtSlot({ cardTableRel, slot, pLocal, halfExtents }) {
      const r = lookupFn(float(cardTableRel), float(slot), vec3(pLocal), vec3(halfExtents)).toVar();
      return { radiance: r.xyz.toVar(), valid: r.w.toVar() };
    },
    /** §6.4's literal form, for a caller that genuinely holds an object-space normal. */
    sample({ cardTableRel, pLocal, nLocal, halfExtents }) {
      return this.sampleAtSlot({
        cardTableRel, slot: slotFromNormal(nLocal), pLocal, halfExtents,
      });
    },
    /**
     * THE fallback path — the only one. `fallback` is the header mean albedo
     * (words 34..36) or mean emissive (37..39) from `dyn.surfaceAt(idx)`.
     * Provided as a method so no caller has to re-derive the select, and so
     * "inactive slot" and "demoted object" cannot drift into two behaviours.
     */
    sampleOrFallback({ cardTableRel, slot, pLocal, nLocal, halfExtents, fallback }) {
      const r = slot != null
        ? this.sampleAtSlot({ cardTableRel, slot, pLocal, halfExtents })
        : this.sample({ cardTableRel, pLocal, nLocal, halfExtents });
      return select(r.valid.greaterThan(0.5), r.radiance, vec3(fallback)).toVar();
    },
  };
}

// ═══════════════════════════════════════════════════════ INTEGRATION POINTS
//
// NOTHING here is wired in. What GISystem (and one giField site) would have to
// touch, named exactly:
//
// 1. `GISystem.js` — the dynamic-region sizing block (`#buildGiField`, around
//    the `dynWords = dynHeaderWords() + dynPoolWords` line, GISystem.js:6134):
//    the card table needs `entries * CARD_SLOTS * CARD_WORDS` words on top of
//    the BVH pool, or `buildSurfaceCache` will report `pool-full` demotions.
//
// 2. `GISystem.js` — beside `createGiTargets`: `createSurfaceCacheAtlas(...)`,
//    kept across rebuilds like the screen targets are, disposed in the same
//    teardown. Only `atlas.hotBindings().srcRadiance` may reach a trace.
//
// 3. `GISystem.js` — after adoption settles, per field build:
//      const built = buildSurfaceCache({ objects, poolBaseWord: <from alloc>, … });
//      const region = dyn.allocPoolWords(built.poolWords);   // bump allocator
//      dyn.queueRegionUpload(region.abs, built.words);       // one-shot copy
//      for (const e of built.entries) dyn.setCardTable(e.key, e.cardTableRel);
//    `buildSurfaceCache`'s `poolBaseWord` must be `region.rel` so the packed
//    `cardTableRel` values are relative to `baseWord`, like words +20/+21.
//    Re-run on adoption churn and on a large eye-distance change (§6.2's
//    resolution is screen-projected).
//
// 4. `dynamicObjects.js` `traceDynBody` — the three places that set `bestObj`
//    (the OBB branch, the BVH branch, the analytic branch): pack the CARD SLOT
//    alongside the object index, `bestObj = i*8 + slot`. Exact in f32 (≤ 512)
//    and it is the only place the object-space normal exists (note H). The OBB
//    branch already has axis + sign in hand; the other two have `nL` before the
//    covariant transform and before the double-sided flip — use the UNFLIPPED
//    one, the packer's cards face outward.
//
// 5. `giField.js:1559-1561` (`createOccupancySceneTrace`) — the consumer. Today:
//      const surf = dyn.surfaceAt(r.dynObj);
//    becomes: split `r.dynObj` into index and slot, `dyn.cardFrameAt(idx, hp)`
//    for the card-table base + local point + half extents, then
//    `sampler.sampleOrFallback({ …, fallback: surf.albedo })`. `surfaceAt` STAYS
//    — it is the fallback, and §6.7 demotions depend on it.
//
// 6. `GISystem.js` profile/MCP — §6.8's `profile.giSurfaceCache` op reads
//    `atlas.stats` plus `buildSurfaceCache`'s `stats`/`demoted`.
//
// NOT here, and deliberately: §6.6's lighting pass. It is its own dispatch
// (never folded into the resolve — §6.5's storage-texture wall), it writes the
// three planes `lightingTargets()` returns, and it has to be counted against the
// 12-uniform wall while it is threaded (§6.6).
