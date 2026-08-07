// SURFACE RADIANCE CACHE — THE LIGHTING PASS (docs/GI_NEXT_ARCHITECTURE.md §6.6).
//
// `surfaceCache.js` plans and packs the cards, `surfaceCacheGpu.js` owns the
// atlas and the trace-side lookup, and THIS file is the only thing that ever
// writes the three planes. One compute dispatch, over ALLOCATED ATLAS TEXELS,
// never over the atlas and never over volume cells.
//
// ══ WHY IT IS ITS OWN DISPATCH AND MUST STAY ONE ════════════════════════════
//
// STORAGE TEXTURES have a WebGPU baseline of 4, and `GISystem.js:1912-1919`
// records that the resolve already writes irradiance + emitterShadow + radiance
// plus a BVH target when exact reflections are on. This pass writes 3
// (`atlas.lightingTargets()`). Folded into the resolve that is 6 or 7 — over
// the limit the pipeline is INVALID and every compute submitted with it is
// silently dropped, which takes ALL of GI with it, not just the cache. §6.9
// carries the fold as a kill criterion for exactly that reason.
//
// ══ THE BINDING COUNT, AND HOW IT WAS COUNTED ═══════════════════════════════
//
// Uniform buffers are not "one per uniform". In three's WGSLNodeBuilder
// (`getUniformFromNode`) a plain `uniform()` joins the ONE `NodeUniformsGroup`
// named by its group node — every `uniform()` in this file, every light slot and
// every emitter slot land in the same buffer — while a `uniformArray()` (a
// BufferNode) becomes its OWN `NodeUniformBuffer` binding, and `instancedArray`
// becomes a storage buffer. So the count is:
//
//     uniform buffers = 1 (the shared 'object' group) + one per uniformArray
//
// which is what makes `giScreen.js:1195-1199`'s measured 16 arithmetic rather
// than mysterious: `bvhScene` alone declares 7 uniformArrays and the slot
// registry + instance grid another 12.
//
// THIS PASS: 1 (object group: world, light slots, emitter slots, the pass's own
// scalars) + 1 (`cardWork`) = 2 uniform buffers, against a baseline of 12. The
// occupancy trace, the dynamic-object header and the card table declare ZERO
// uniformArrays between them — they all ride the `bits` STORAGE buffer, which is
// the whole reason §6.3 put the card table there.
//
// Storage buffers: `bits` (the trace + every dyn header read + the card table),
// `cardAccum` (the EMA history), and whatever the optional `bounce` gather
// brings (the probe irradiance + depth-moment buffers) — 4 against the portable
// limit of 8. Sampled textures: 0 — this pass WRITES the atlas, it never
// samples it.
//
// ══ WHY THE EMA LIVES IN A STORAGE BUFFER AND NOT IN THE ATLAS ══════════════
//
// §6.6 says "accumulate into srcRadiance". A texel cannot be read and written by
// the same dispatch: WebGPU forbids a subresource being both writable storage
// and readable in one pass, and `read_write` storage-texture access exists only
// for r32uint/r32sint/r32float — never for the rgba16float §6.3 specifies. The
// alternatives are a ping-pong pair (a second 100 MB plane, and a `.value` swap
// every frame on a texture every trace kernel has already compiled against —
// the exact bind-group invalidation `createGiTargets` warns about) or a small
// side buffer. This is the side buffer: 16 bytes per ALLOCATED texel, capped,
// indexed by the card's own `accumBase` so it costs nothing for atlas texels no
// card owns.
//
// ══ WHAT §6.6 GETS WRONG ABOUT THE REAL CODE ════════════════════════════════
//
//  A. "reconstruct world P and N from the card rect + srcGeometry" assumes
//     `srcGeometry` is already populated. NOTHING POPULATES IT — this is the
//     pass that would, so the reconstruction is circular. P and N come from a
//     RAY instead: the card's own orthographic ray, fired through the SAME
//     `dyn.trace` every transport ray uses, which returns the exact world hit
//     point and the exact world normal for all five shape classes (OBB, BVH
//     mesh, sphere, capsule, frustum) with no new WGSL. `srcGeometry` is then an
//     OUTPUT of this pass (oct normal + normalized card depth + emissive
//     luminance), which is what the channel list in §6.3 actually describes.
//
//  B. Building that ray needs the FORWARD object matrix, and the header carries
//     only M⁻¹ (words 0..15) — the same hole note H in `surfaceCacheGpu.js`
//     found on the normal side. There is no spare object-block word to publish
//     M in (0..39 are all claimed, +23 by the card table itself), so
//     `dynamicObjects.cardWorldAt` inverts the 3×3 on the GPU: ~30 ALU, once per
//     texel, against a per-texel cost that already contains a trace and a light
//     loop.
//
//  C. "emissive from resolveMaterialSurface" is a CPU function
//     (voxelizeOnce.js) and cannot be called from a kernel. It is already run
//     for every adopted mover — `dynamicObjects`' `writeSurface` calls exactly
//     it and publishes the result into header words 34..39 — so this pass reads
//     those words through `surfaceAt`. That satisfies the requirement in the
//     strongest possible form: it is not the same convention as the voxel path,
//     it is literally the same bytes.
//
//  D. §6.6 does not say what a texel OUTSIDE the object's silhouette gets. A
//     card rect is fitted to the OBB projection, so a sphere misses ~21% of its
//     own rect and a mesh far more; writing black there puts a dark rim under
//     every bilinear tap near a silhouette. Missed texels are shaded at the
//     card's NEAR PLANE with the card's own outward axis normal instead — a
//     free dilate, one branchless select, and `srcMaterial.a` still records
//     coverage 0 so a later pass can tell the difference.
import * as THREE from "three/webgpu";
import {
  Fn, If, float, instanceIndex, instancedArray, ivec2, mix, select, step,
  textureStore, uniform, uniformArray, vec3, vec4,
} from "three/tsl";
import { CARD_EPS, CARD_AXIS_ROT } from "./surfaceCacheGpu.js";
import { emitterSlotFactor, emitterSurfaceT } from "./giLight.js";
import { octEncodeTSL } from "./rayHit/rayHitTSL.js";
import { MAX_MACRO_STEPS } from "./rayHit/RayHitPacking.js";

/** Cards the work list can carry in one frame. POWER OF TWO — the thread→card
 *  search below is a compile-time-unrolled binary search over exactly this. */
export const CARD_WORK_CAPACITY = 128;
/** Default per-frame texel budget (the dispatch size, a build constant). */
export const DEFAULT_TEXEL_BUDGET = 65536;
/** Default EMA history capacity, in texels (16 B each → 4 MB). */
export const DEFAULT_ACCUM_TEXELS = 262144;
/** Age is stored in an fp16 channel: integers are exact up to 2048. */
const AGE_MAX = 2048;

/**
 * @param {object} o
 * @param {any}      o.atlas          `createSurfaceCacheAtlas` result
 * @param {any}      o.dyn            the dynamic-object set (header + trace)
 * @param {Function} o.trace          `volume.createOccTrace()` — the dynamics-composed marcher
 * @param {any}      o.world          giField's world uniform bundle
 * @param {any[]}    o.lightSlots     the analytic light slots (uniforms)
 * @param {any[]}   [o.emitterSlots]  promoted emissive meshes (uniforms)
 * @param {Function}[o.bounce]        `(P, N, viewDir) => vec3` cascade irradiance, or null
 * @param {number}  [o.steps]         trace steps for the visibility rays
 * @param {number}  [o.budgetTexels]  HARD per-frame texel budget = the dispatch size
 * @param {number}  [o.accumTexels]   EMA history capacity in texels
 * @param {number}  [o.smoothing]     EMA retain weight before the swept scale
 */
export function createSurfaceCacheLightPass({
  atlas, dyn, trace, world, lightSlots, emitterSlots = null, bounce = null,
  steps = 48, budgetTexels = DEFAULT_TEXEL_BUDGET, accumTexels = DEFAULT_ACCUM_TEXELS,
  smoothing = 0.8,
}) {
  const budget = Math.max(1024, Math.trunc(budgetTexels));
  const accumCap = Math.max(4096, Math.trunc(accumTexels));
  const targets = atlas.lightingTargets();

  // ── the per-frame work list ───────────────────────────────────────────────
  // TWO vec4s per card, so one uniformArray carries everything a thread needs
  // and the card table in `bits` is not re-read per texel:
  //   even  (objIndex, cardSlot, dispatchStart, texelCount)
  //   odd   (rectX, rectY, resU, accumBase)          — rect in TEXELS, not uv
  // `dispatchStart` is a prefix sum, which is what makes the thread→card map a
  // search rather than a scan.
  const cardWork = uniformArray(
    Array.from({ length: CARD_WORK_CAPACITY * 2 }, () => new THREE.Vector4()),
    "vec4",
  );
  const workCount = uniform(0);
  const activeTexels = uniform(0);
  const smoothingU = uniform(Math.min(0.98, Math.max(0, smoothing)));

  // EMA history: rgb = last accumulated radiance, w = age in frames.
  const cardAccum = instancedArray(new Float32Array(accumCap * 4), "vec4");

  const compute = Fn(() => {
    // Built INSIDE the Fn: a node expression shared across builder scopes is
    // the `sharedFn`/giFn hazard this module keeps running into.
    const lift = float(world.minCell).mul(0.75).toVar();
    const farT = vec3(world.size).length().toVar();
    const tIdx = instanceIndex.toFloat().toVar();
    // Everything past the packed work is a no-op thread. The dispatch size is a
    // BUILD constant (a compute node's count is baked at construction), so the
    // budget is enforced by the CPU packing fewer texels, not by a smaller grid.
    If(tIdx.lessThan(activeTexels), () => {
      // ── thread → card: branchless binary search for the largest k with
      // start[k] <= tIdx. start[0] is always 0, so k = 0 is always a valid
      // answer and the search never needs a not-found branch.
      const k = float(0).toVar();
      for (let stride = CARD_WORK_CAPACITY >> 1; stride >= 1; stride >>= 1) {
        const cand = k.add(float(stride)).toVar();
        const ok = cand.lessThan(workCount)
          .and(cardWork.element(cand.mul(2).toInt()).z.lessThanEqual(tIdx));
        k.assign(select(ok, cand, k));
      }
      const w0 = cardWork.element(k.mul(2).toInt()).toVar();
      const w1 = cardWork.element(k.mul(2).add(1).toInt()).toVar();
      const local = tIdx.sub(w0.z).toVar();
      If(local.lessThan(w0.w), () => {
        const objIndex = w0.x.toVar();
        const slot = w0.y.toVar();
        const resU = w1.z.max(1).toVar();
        const resV = w0.w.div(resU).max(1).toVar();
        const j = local.div(resU).floor().toVar();
        const i = local.sub(j.mul(resU)).toVar();
        // Texel CENTRES — the same convention `snapToTexel`/`rasterizeCard` use
        // on the CPU, so a GPU texel and its CPU raster mean the same point.
        const s = i.add(0.5).div(resU).toVar();
        const t = j.add(0.5).div(resV).toVar();

        // ── the card's orthographic ray, in object space ────────────────────
        // `cardFrameAt` is called with the origin because only its half extents
        // are wanted here; its `pLocal` (which is the matrix's translation
        // column at P = 0) is deliberately unused. It is also the ONE reader of
        // object-block word +23 in the tree, and this pass must not become a
        // second one — the card rect arrives through `cardWork` instead.
        const frame = dyn.cardFrameAt(objIndex, vec3(0));
        const M = dyn.cardWorldAt(objIndex);
        const he = frame.halfExtents.abs().max(vec3(CARD_EPS)).toVar();
        // Composed per component rather than by swizzle assignment: WGSL has no
        // dynamic component index, and (ia, ib, axis) is a compile-time table.
        const px = float(0).toVar(), py = float(0).toVar(), pz = float(0).toVar();
        const dx = float(0).toVar(), dy = float(0).toVar(), dz = float(0).toVar();
        const hd = float(1).toVar();
        const originC = [px, py, pz];
        const dirC = [dx, dy, dz];
        const H = [he.x, he.y, he.z];
        for (let axis = 0; axis < 3; axis++) {
          const isAxis = slot.greaterThanEqual(float(axis * 2))
            .and(slot.lessThan(float(axis * 2 + 2)));
          If(isAxis, () => {
            // signBit = slot & 1, exactly `packCardWords`'s bit 2 of word +4.
            const sgn = select(slot.sub(float(axis * 2)).greaterThan(0.5), float(-1), float(1)).toVar();
            const r = CARD_AXIS_ROT[axis];
            const hu = H[r[0]], hv = H[r[1]], ha = H[r[2]];
            // `cardUnproject` at depth 0 — the card's NEAR plane. The s axis is
            // sign-mirrored and t is not, which is `cardProject` inverted, not
            // a new convention (see surfaceCacheGpu's note B).
            originC[r[0]].assign(s.mul(2).sub(1).mul(hu).mul(sgn));
            originC[r[1]].assign(t.mul(2).sub(1).mul(hv));
            // A thousandth of a half extent of standoff: the origin otherwise
            // sits exactly ON the slab face and the entry test is a coin flip.
            originC[r[2]].assign(ha.mul(sgn).mul(1.001));
            dirC[r[2]].assign(sgn.negate());
            hd.assign(ha);
          });
        }
        const pad = hd.mul(1e-3).toVar();
        const roL = vec3(px, py, pz).toVar();
        const dL = vec3(dx, dy, dz).toVar();
        // local → world. `dir` is NOT normalized by the matrix, so its length is
        // the world scale along the card axis — which is what converts the
        // card's local depth span into a world ray parameter.
        const roW = M.point(roL).toVar();
        const dW = M.dir(dL).toVar();
        const dLen = dW.length().max(1e-9).toVar();
        const dir = dW.div(dLen).toVar();
        const tMax = hd.mul(2).add(pad).mul(dLen).toVar();

        // ── the card G-buffer, by ray ──────────────────────────────────────
        // `dyn.trace` (not the composed field trace): the card must see its OWN
        // object's exact surface, not the static voxel field, and the packed
        // winner tells us whether another mover got in the way.
        const hit = dyn.trace(roW, dir, float(0), tMax, { objId: true, meshes: true });
        const who = dyn.splitObj(hit.obj);
        // `sub().abs() < 0.5` rather than `equal`: both sides are small exact
        // integers in f32, but an equality on a float that came out of a
        // `floor(x/8)` is the kind of thing that survives review and then fails
        // on one driver.
        const good = hit.hit.greaterThan(0.5)
          .and(who.index.sub(objIndex).abs().lessThan(0.5))
          .and(M.ok.greaterThan(0.5))
          .toVar();
        // §6.6's silhouette gap (note D): a missed texel is shaded at the near
        // plane with the card's own outward normal instead of left black.
        const hitP = roW.add(dir.mul(hit.t)).toVar();
        const p = select(good, hitP, roW).toVar();
        const n = select(good, vec3(hit.normal), dir.negate()).toVar();
        const coverage = select(good, float(1), float(0)).toVar();
        const depth = select(good, hit.t.div(dLen).sub(pad).div(hd.mul(2)).clamp(0, 1), float(0)).toVar();

        // ── direct light, ONE visibility ray per slot, PER TEXEL ────────────
        // Strictly fewer evaluations than the per-hit version this replaces:
        // that one ran the whole loop for every transport ray that landed on
        // the mover, this one runs it once per cached texel per frame.
        const surf = dyn.surfaceAt(objIndex);
        const irr = vec3(0).toVar();
        /** Binary visibility, through the SAME marcher the transport rays use.
         *  `dynamics: false` for the same reason giField's copy does it: a
         *  mover must not shadow itself. */
        const visibility = (L, maxT) => {
          const v = float(1).toVar();
          const sh = trace(p.add(n.mul(lift)), L, lift, maxT, {
            steps,
            macroSteps: MAX_MACRO_STEPS,
            dynamics: false,
          });
          v.assign(select(float(sh.hit).greaterThan(0.5), float(0), float(1)));
          return v;
        };
        for (const ls of lightSlots ?? []) {
          If(float(ls.active).greaterThan(0.5), () => {
            // `vector` is a world position for a point light and the normalized
            // direction TOWARD a directional one — the field gather's own
            // convention, mirrored here so the two agree.
            const isDir = float(ls.kind).toVar();
            const rel = vec3(ls.vector).sub(p).toVar();
            const pointDist = rel.length().max(1e-4).toVar();
            const L = mix(rel.div(pointDist), vec3(ls.vector), isDir).toVar();
            let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
            if (ls.range) {
              const range = float(ls.range);
              const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
              const r2 = ratio.mul(ratio);
              const win = r2.mul(r2).oneMinus().clamp(0, 1);
              atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
            }
            const ndotl = L.dot(n).max(0).toVar();
            If(ndotl.greaterThan(1e-4), () => {
              const vis = visibility(L, mix(pointDist.sub(lift).max(0), farT, isDir).toVar());
              // Lambert /π — cascadeGather's `direct` term EXACTLY, and the same
              // constant giField:1676 already calls out. A different
              // normalisation here is not a tuning difference: it makes every
              // cached object read brighter or darker than the geometry beside
              // it, which is a bug this module has already shipped once.
              irr.addAssign(vec3(ls.color).mul(atten.mul(ndotl).mul(vis).mul(1 / Math.PI)));
            });
          });
        }
        for (const es of emitterSlots ?? []) {
          If(float(es.radius).greaterThan(0.001), () => {
            const rel = vec3(es.center).sub(p).toVar();
            const dist = rel.length().max(1e-4).toVar();
            const L = rel.div(dist).toVar();
            const cosTheta = L.dot(n).toVar();
            const sinR = float(es.radius).div(dist).clamp(0, 1).toVar();
            const factor = emitterSlotFactor(es, p, n, cosTheta, sinR).toVar();
            If(factor.greaterThan(1e-6), () => {
              // Stop at the lamp's SURFACE or every ray ends inside the lamp
              // body and reports itself occluded.
              const maxT = emitterSurfaceT(es, p, L, dist).sub(lift).max(0).toVar();
              irr.addAssign(vec3(es.color).mul(factor).mul(visibility(L, maxT)).mul(1 / Math.PI));
            });
          });
        }
        // ONE BOUNCE from the cascade field at P. Not the trilinear voxel
        // radiance: an adopted mover's own cells are EMPTY (adoption parks its
        // occupancy slot), so that read is the "square patches" artifact the
        // ambient proxy was retired for. The probe gather is the cascade answer
        // and is continuous across the mover's surface.
        if (bounce) irr.addAssign(vec3(bounce(p, n, vec3(0))));
        const lit = surf.emissive.add(surf.albedo.mul(irr)).toVar();

        // ── the EMA, keyed on the age channel ──────────────────────────────
        // The retain factor is `sweptFactorAt` (header words 24..30 + 27): 1
        // outside every swept region, and inside one it is already
        // TRANSLATION-SCALED — ~1 for a box rotating in place (whose cached
        // texels are genuinely stable) and ~0.35 for one translating fast
        // (whose lighting must not ghost). That is the invalidation §6.6 asks
        // for, and it costs no new bindings: `bits` is right here.
        const accumIdx = w1.w.add(local).toUint().toVar();
        const prev = cardAccum.element(accumIdx).toVar();
        const age = prev.w.toVar();
        const retain = smoothingU.mul(dyn.sweptFactorAt(p)).clamp(0, 0.98).toVar();
        const out = mix(lit, prev.xyz, select(age.lessThan(0.5), float(0), retain)).toVar();
        const newAge = age.add(1).min(float(AGE_MAX)).toVar();
        cardAccum.element(accumIdx).assign(vec4(out, newAge));

        // ── the three planes ───────────────────────────────────────────────
        const coord = ivec2(w1.x.add(i).toInt(), w1.y.add(j).toInt());
        // THE one the traces sample: outgoing radiance + age.
        textureStore(targets.srcRadiance, coord, vec4(out, newAge));
        // Mean albedo (the same header words the voxel path shades from) +
        // coverage. Per-texel albedo would need the mesh's maps bound in a
        // compute pass, which is the cost the whole card scheme exists to
        // avoid; the gap being closed here is wrong-vs-right, not
        // right-vs-detailed.
        textureStore(targets.srcMaterial, coord, vec4(surf.albedo, coverage));
        // Oct normal + normalized card depth + emissive luminance.
        const oct = octEncodeTSL(n).mul(0.5).add(0.5).toVar();
        const emisLum = surf.emissive.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
        textureStore(targets.srcGeometry, coord, vec4(oct.x, oct.y, depth, emisLum));
      });
    });
  })().compute(budget);

  const state = {
    compute,
    budgetTexels: budget,
    accumTexels: accumCap,
    workCapacity: CARD_WORK_CAPACITY,
    smoothing: smoothingU,
    /** Diagnostics for the `profile.giSurfaceCache` op. */
    stats: {
      budgetTexels: budget,
      accumTexels: accumCap,
      workCapacity: CARD_WORK_CAPACITY,
      cardsThisFrame: 0,
      texelsThisFrame: 0,
      cardsDropped: 0,
      texelsDropped: 0,
      accumOverflow: 0,
      dispatches: 0,
      uniformBuffers: 2,
      storageTextures: 3,
    },

    /**
     * Packs this frame's chosen cards. `items` are already priority-ordered and
     * already inside the budget — the scheduler (GISystem) owns the choice; this
     * only lays them out. Returns the texel total actually packed.
     *
     * @param {{objIndex:number, slot:number, rectX:number, rectY:number,
     *          resU:number, resV:number, accumBase:number}[]} items
     */
    setWork(items) {
      let start = 0;
      let n = 0;
      for (const c of items) {
        if (n >= CARD_WORK_CAPACITY) break;
        const count = c.resU * c.resV;
        if (count <= 0) continue;
        if (start + count > budget) break;
        if (c.accumBase + count > accumCap) { state.stats.accumOverflow++; continue; }
        cardWork.array[n * 2].set(c.objIndex, c.slot, start, count);
        cardWork.array[n * 2 + 1].set(c.rectX, c.rectY, c.resU, c.accumBase);
        start += count;
        n++;
      }
      // Tail entries must not be reachable: the binary search is bounded by
      // `workCount`, but a stale `dispatchStart` from a previous frame inside
      // the searched range would still be compared. Zeroing the next entry's
      // start keeps the invariant "start[] is non-decreasing" intact.
      if (n * 2 + 1 < cardWork.array.length) {
        cardWork.array[n * 2].set(0, 0, 0, 0);
        cardWork.array[n * 2 + 1].set(0, 0, 1, 0);
      }
      workCount.value = n;
      activeTexels.value = start;
      state.stats.cardsThisFrame = n;
      state.stats.texelsThisFrame = start;
      return start;
    },

    /** True when there is anything for the dispatch to do this frame. */
    hasWork() {
      return activeTexels.value > 0;
    },
  };
  return state;
}
