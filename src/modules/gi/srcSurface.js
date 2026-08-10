// SPLIT RADIANCE CASCADES — static surface attribution. The GPU path from a
// ray hit to the material it landed on.
//
//     surfaceAt(voxel, worldPos, normal) → { albedo, emissive, emitter, valid }
//
// `srcShade.js` calls this once per shaded hit and asks nothing else about
// provenance: movers read the same shape out of `moverSurfaceAt`, statics read
// it here, and the hit shader never learns which it got. Plan §4.4, §12.26.10
// item 3 — the one item on that handoff list that is not a shader change.
//
// ══ WHY THIS EXISTS AT ALL, AND WHAT IT REPLACES ════════════════════════════
//
// The dense backend answered "what colour is this hit" by sampling the radiance
// field at the hit point, and the field carried a per-cell surface colour that
// a COARSE ATTRIBUTION GRID (`cellAttr`/`staticAttr`/`slotAtlas`) had written at
// voxelize time. §12.9 deleted all of it with the field. SRC has probes rather
// than a field, so nothing was left: `SURFACE_MATERIAL_ID_WORD` had long since
// been repurposed as the complex-cell triangle range (`packComplexRange`), and
// `occupancyField.js` exposed no `surfaceAt`. A static hit had no path to its
// material at all, and `srcShade.js` shaded every one of them grey.
//
// ══ THE THREE DECISIONS, AND WHAT EACH ONE COSTS ════════════════════════════
//
// **1. KEYED ON THE SURFACE RECORD, NOT ON A CELL.** The epitaph in
// `occupancyField.js` records why the deleted grid was COARSE: per-level-0
// attributes cost 12.6M voxels × 8 B = 100 MB, so it settled for the composite
// cell and accepted that a 0.5 m cell shared by a column and a floor gets one
// colour. Records dodge the trade entirely — they already exist per OCCUPIED
// level-0 voxel (`surfaceCapacity = level0VoxelCount / 12`, because surfaces
// are ~2D), so one u32 per record is level-0 precision at surface-manifold
// cost. It is also the resolution the intersection was computed at, which is
// R2 applied to attribution rather than to a bias.
//
// **2. IT RIDES THE `bits` BUFFER.** Both the stamp and the palette are tail
// regions of the occupancy allocation, so a consumer that already traces reads
// them through a binding it already holds: **zero new storage buffers and zero
// new uniform buffers on the deposit kernel** (R7). That is not tidiness. The
// deposit binds the pyramid, the probe table, the bins and the per-pixel
// buffers against a portable limit of eight, and §12.9 records that the LAST
// attribution grid had its slot remap applied in the voxelizer rather than read
// in the consumer *because that kernel had run out of uniform slots*. A design
// that needs a binding here does not get to be correct later.
//
// **3. THE STAMP IS A SLOT ID, THE COLOUR IS A PALETTE.** The deleted grid held
// colours, so the only way to change one was to re-run the voxelizer that wrote
// it — a material recolour re-rasterized the scene. Here the stamp is an
// occupancy slot and colour lives in a 512-entry palette, so a recolour is a
// uniform write plus a 512-thread dispatch. `SlotRegistry` grew a separate
// `surfaceRevision` for exactly this; `revision` (the re-voxelize signal) no
// longer moves for a colour.
//
// ══ THE TWO BUGS §12.9 PAID FOR, ANSWERED ═══════════════════════════════════
//
// **CROSSED NUMBERING** — two independent slot numberings fed the composite a
// different mesh's colour. Both numberings are still live today:
// `GISystem#occupancyContentOf` hands out occupancy slots from a stable
// monotonic map (`GISystem.js:6270`) while `SlotRegistry.allocateSlot` pops a
// free stack (`slotRegistry.js:98`), and they are different numbers for the
// same mesh. So the remap is not fixed here, it is DELETED: the GPU sees one
// numbering (the occupancy slot, which is what the voxelizer stamps and what
// indexes the palette), and the registry is reached by KEY —
// `slotKeyOf(mesh, instanceId)` — never by index. There is nothing left to get
// backwards. `crossNumbering` in the options is the deliberate-failure arm that
// proves the gate can see it.
//
// **THE DETERMINISTIC WINNER** — last-write-wins re-rolled every seam cell's
// colour per dispatch and the bounce amplified it into visible flicker. The
// stamp is written with `atomicMax`, so a level-0 voxel shared by several
// meshes picks the highest occupancy slot every dispatch, whatever order the
// threads arrive in. Bit-identical across reruns is a gate arm, not a claim.
//
// ══ WHAT AN UNATTRIBUTED HIT RETURNS, AND WHY IT IS NOT BLACK ═══════════════
//
// R1: a cell with no attribution must not be a hard cliff, and silent black is
// the failure mode this whole rebuild keeps re-finding. Three things produce
// one — a hit whose voxel has no surface record (a macro cell that is not a
// brick, a brick the record pool could not seat), a record no triangle stamped,
// and an occupancy placement whose mesh never seated an atlas slot. All three
// return the palette's MEAN albedo with zero emission and `emitter = -1`, and
// all three set `valid = 0`. The mean keeps the bounce's MAGNITUDE right and
// loses only its hue; black would remove the energy and look like geometry.
// `valid` is what makes it countable — `srcShade.js` feeds it to
// `STAT_UNATTRIBUTED`, which is the only number that says how much of a frame
// this is.
//
// ══ THE EMITTER FLAG, AND WHY IT DOES NOT DO THE ZEROING ════════════════════
//
// `emitter` is the index into the NEE emitter set when the hit surface IS one
// of the sampled lights, and −1 otherwise. R5 says one representation per light
// per path: an emitter both sampled by NEE and emissive on contact delivers its
// energy twice, measured in the mirror at **2.60×** on mean floor irradiance
// (§12.26.7) and invisible to any check that does not compare the two paths.
//
// **BUT THE ZEROING ALREADY HAPPENS, ON THE CPU, AND IT STAYS THERE.**
// `GISystem.#slotSurface` publishes zero emissive for a promoted entry, and
// `dynamicObjects.writeSurface` does the same for movers (`:1168`) — the latter
// with a comment recording the exact double-count bug it was written for. The
// promotion set IS the NEE set, so the bake already zeroes precisely what the
// sampler delivers. Shipping raw emissive here and zeroing on the GPU would put
// R5 in a THIRD place and make the flag and the promotion set two sources of
// truth for one fact, which is the crossed-numbering shape again. So this
// palette carries `#slotSurface`'s output verbatim, and `emitter` is a flag the
// consumer can ASSERT against rather than a mechanism it depends on.
//
// What that leaves is a failure mode with no counter: a surface whose material
// emits, whose palette emissive is zero, and whose emitter id is −1 — light
// deleted from BOTH paths. That one is invisible to a GPU counter precisely
// because nothing carries emission to notice, so it is checked here on the CPU
// and reported as `stats.emissiveOrphans`. Zero is the healthy reading.
//
// ══ THE ONE PRECISION HAZARD, NAMED ═════════════════════════════════════════
//
// `createSrcSceneTrace` hands over `voxel` rather than letting a consumer
// re-derive it, because the returned `position` is lifted half a coarse cell
// and floors to the SHELL cell. That fixes the lift, not the face:
// `voxelAtHit` is `floor(q0 + dq·t)` and a hit landing exactly ON a cell face
// floors either side of it. The marcher's own record index would settle it, but
// `traceHybridPlane`'s inner `sharedFn` returns a `vec4` with all four
// components spoken for (hit, t, oct.x, oct.y), so surfacing it is a return-type
// change to the most-measured code in the module rather than the one line it
// looks like.
//
// So instead: ask at `voxel` first — the marcher's own answer, right for every
// hit strictly inside its cell — and when that has no stamp, ask once more a
// quarter voxel along −n, which is inside the surface cell whichever side the
// floor fell. Not a heuristic and not a search: the hit is ON the surface and
// the normal points out of it. Both outcomes are counted (`retried`), so the
// rate is a measurement rather than an assumption.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.4, §12.9, §12.26.10, §12.29.

import * as THREE from "three/webgpu";
import { If, float, select, uint, uintBitsToFloat, uniform, vec3 } from "three/tsl";
import { slotKeyOf } from "./slotRegistry.js";
import { resolveMaterialSurface } from "./voxelizeOnce.js";

/** Below this a resolved emissive counts as "this material does not emit". */
const EMISSIVE_EPSILON = 1e-4;

/**
 * Static surface attribution for SRC's hit shading.
 *
 * @param {object} occField  the occupancy field, built with
 *   `enableSurfaceAttribution: true`. Pre-`composeFieldDynamics`: this reads the
 *   STATIC medium's records, and mover hits are `moverSurfaceAt`'s job.
 * @param {object} world  `{ minCell, min, size, cell, ... }` UNIFORM nodes, so a
 *   refit moves the medium without a recompile (R11).
 * @param {object} slots  the `SlotRegistry`. Read for its surfaces and its
 *   `surfaceRevision`; never for its slot NUMBERS — see the header.
 * @param {object} [options]
 * @param {() => Array<object|null>} [options.emitterMeshes] the NEE emitter set,
 *   as meshes, index-aligned with the `emitters` array `createSrcHitShader`
 *   gets. Interior nulls are expected (`_emitterInfos` parks seats).
 * @param {{retried?: (n) => void, missed?: (n) => void}} [options.count]
 * @param {boolean} [options.crossNumbering] TEST ONLY. Writes the palette under
 *   the registry's numbering instead of the occupancy field's, reproducing
 *   §12.9's crossed-numbering bug on purpose so the gate can prove it fails.
 */
export function createSrcSurfaceAttribution(occField, world, slots, options = {}) {
  const attr = occField?.surfaceAttribution ?? null;
  if (!attr) {
    throw new Error(
      "createSrcSurfaceAttribution: the occupancy field has no attribution region — " +
      "build it with `enableSurfaceAttribution: true`. Returning a null surface here " +
      "would shade every static hit grey and say nothing about it, which is the " +
      "failure mode §12.9's epitaph exists to prevent",
    );
  }
  if (world?.minCell == null) {
    throw new Error(
      "createSrcSurfaceAttribution: world.minCell is required — the face-retry step is " +
      "derived from the DDA medium's quantization (R2) and there is no default worth having",
    );
  }
  const { emitterMeshes = () => [], count = null, crossNumbering = false } = options;
  const {
    bits, recordIndexAt, palettePass, paletteUniform, paletteSlots,
    paletteWordOffset, paletteWords, attrWordOffset, gridOrigin, voxelInv,
  } = attr;

  // The colour an unattributed hit shades at: the mean albedo over live slots,
  // refreshed by `sync`. A UNIFORM and not a baked constant, for both of R11's
  // reasons — the right grey is a property of the scene (a dark scene's
  // fallback must be dark, or the unattributed fraction reads as bright
  // patches), and it must be able to move without recompiling the graph.
  const fallbackAlbedo = uniform(new THREE.Vector3(0.5, 0.5, 0.5));

  const stats = {
    /** Palette entries with a resolved surface. */
    live: 0,
    /** Occupancy placements with no atlas assignment — they shade at the mean. */
    unassigned: 0,
    /** Placements whose occupancy slot is past the palette (see below). */
    slotOverflow: 0,
    /**
     * Surfaces whose material emits, whose published emissive is zero, and
     * which are NOT in the NEE set: light deleted from both paths. Zero is the
     * healthy reading; nonzero is a promotion-bookkeeping bug, caught before it
     * reaches the image. See the header — a GPU counter structurally cannot see
     * this one, because nothing carries emission to notice.
     */
    emissiveOrphans: 0,
    /** NEE-flagged palette entries. Should equal the live emitter seat count. */
    emitters: 0,
    syncs: 0,
  };

  // Change detection. `revision` moves on a seat/clear/drag, `surfaceRevision`
  // on a recolour, the placements array identity on a content rebuild, and the
  // emitter stamp when a seat turns over — a recolour therefore costs one
  // palette upload and touches nothing else, which is decision 3 in the header.
  let seenRevision = -1;
  let seenSurfaceRevision = -1;
  let seenPlacements = null;
  let seenPlacementCount = -1;
  let seenEmitterStamp = "";
  // Material → resolved surface, keyed the way `dynamicObjects.writeSurface`
  // keys its own: a shader-graph walk per slot per sync would be paid on every
  // seat change for an answer that only moves when the material does.
  const materialCache = new Map(); // "id:version" -> resolveMaterialSurface result

  const resolveCached = (mesh) => {
    const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
    const key = `${material?.id ?? -1}:${material?.version ?? 0}`;
    let hit = materialCache.get(key);
    if (!hit) {
      hit = resolveMaterialSurface(mesh?.material, mesh?.name);
      materialCache.set(key, hit);
    }
    return hit;
  };

  /**
   * @param {boolean} [force] rewrite even when nothing changed. Only a gate
   *   needs this — it is how an arm that deliberately corrupted the palette
   *   puts the real one back, and without it the early-out below would leave
   *   the corruption in place for every arm after it.
   */
  function sync(force = false) {
    const placements = occField.placements ?? [];
    const emitters = emitterMeshes() ?? [];
    let emitterStamp = "";
    for (let i = 0; i < emitters.length; i++) emitterStamp += `${emitters[i]?.uuid ?? "-"},`;
    if (
      !force &&
      slots.revision === seenRevision &&
      slots.surfaceRevision === seenSurfaceRevision &&
      placements === seenPlacements &&
      placements.length === seenPlacementCount &&
      emitterStamp === seenEmitterStamp
    ) {
      return;
    }
    seenRevision = slots.revision;
    seenSurfaceRevision = slots.surfaceRevision;
    seenPlacements = placements;
    seenPlacementCount = placements.length;
    seenEmitterStamp = emitterStamp;
    stats.syncs++;

    // THE BRIDGE, AND IT IS BY KEY. `assignments[j]` is the registry's own
    // numbering and has nothing to do with `placement.slot`; the only thing the
    // two share is the placement identity. Matching on that identity is what
    // makes a remap unnecessary rather than merely correct.
    const byKey = new Map();
    for (const assignment of slots.assignments) {
      if (assignment) byKey.set(assignment.key, assignment);
    }
    const emitterOf = new Map();
    for (let i = 0; i < emitters.length; i++) {
      if (emitters[i]) emitterOf.set(emitters[i], i);
    }

    const array = paletteUniform.array;
    for (let i = 0; i < array.length; i++) array[i].set(0, 0, 0, 0);
    stats.live = 0;
    stats.unassigned = 0;
    stats.slotOverflow = 0;
    stats.emissiveOrphans = 0;
    stats.emitters = 0;
    let sumR = 0, sumG = 0, sumB = 0;

    for (const placement of placements) {
      // `_occSlotNext` is monotonic and never reused, so a long session of
      // spawns and despawns can hand out a slot past the palette. It lands as
      // UNATTRIBUTED (counted) rather than as another mesh's colour, which is
      // the correct direction for an aliasing failure. Logged in §12.29.
      if (!(placement.slot >= 0 && placement.slot < paletteSlots)) {
        stats.slotOverflow++;
        continue;
      }
      const assignment = byKey.get(slotKeyOf(placement.mesh, placement.instanceId));
      if (!assignment?.surface) {
        stats.unassigned++;
        continue;
      }
      // THE DELIBERATE-FAILURE ARM. Writing the entry under the REGISTRY's
      // index instead of the occupancy slot is §12.9's crossed-numbering bug,
      // reproduced exactly: both numbers exist, both look like slot ids, and
      // the picture is simply somebody else's colour.
      const index = crossNumbering ? slots.assignments.indexOf(assignment) : placement.slot;
      if (!(index >= 0 && index < paletteSlots)) continue;
      const { color, emissive } = assignment.surface;
      const emitterIndex = emitterOf.has(placement.mesh) ? emitterOf.get(placement.mesh) : -1;
      if (emitterIndex >= 0) stats.emitters++;

      // The both-zero check. `assignment.surface.emissive` is `#slotSurface`'s
      // output, already zeroed for a promoted entry; if it is zero, the mesh's
      // material emits, and no NEE seat claims it, then this surface's light
      // exists on neither path.
      const publishedDark =
        Math.abs(emissive.r) < EMISSIVE_EPSILON &&
        Math.abs(emissive.g) < EMISSIVE_EPSILON &&
        Math.abs(emissive.b) < EMISSIVE_EPSILON;
      if (publishedDark && emitterIndex < 0) {
        const raw = resolveCached(placement.mesh);
        const k = raw.emissiveIntensity ?? 1;
        const emits =
          (raw.emissive?.r ?? 0) * k > EMISSIVE_EPSILON ||
          (raw.emissive?.g ?? 0) * k > EMISSIVE_EPSILON ||
          (raw.emissive?.b ?? 0) * k > EMISSIVE_EPSILON;
        if (emits) stats.emissiveOrphans++;
      }

      array[index * 2].set(color.r, color.g, color.b, emitterIndex + 1);
      array[index * 2 + 1].set(emissive.r, emissive.g, emissive.b, 1);
      stats.live++;
      sumR += color.r;
      sumG += color.g;
      sumB += color.b;
    }

    // The fallback is the scene's own mean, not a constant grey. With no live
    // slot at all the palette is empty and nothing can read it, so the 0.5 is
    // unreachable rather than a tuned default.
    if (stats.live > 0) {
      fallbackAlbedo.value.set(sumR / stats.live, sumG / stats.live, sumB / stats.live);
    }
  }

  // ── the read ──────────────────────────────────────────────────────────────

  /** Palette words for slot index `s` (a u32 node), unpacked. */
  const paletteAt = (s) => {
    const base = uint(paletteWordOffset).add(s.mul(uint(paletteWords))).toVar();
    return {
      albedo: vec3(
        uintBitsToFloat(bits.element(base)),
        uintBitsToFloat(bits.element(base.add(uint(1)))),
        uintBitsToFloat(bits.element(base.add(uint(2)))),
      ).toVar(),
      emitter: float(bits.element(base.add(uint(3)))).sub(1).toVar(),
      /** Diagnostic only: the raw word 0, numerically. See `debugProbe`. */
      rawWord0: float(bits.element(base)).toVar(),
      base,
      emissive: vec3(
        uintBitsToFloat(bits.element(base.add(uint(4)))),
        uintBitsToFloat(bits.element(base.add(uint(5)))),
        uintBitsToFloat(bits.element(base.add(uint(6)))),
      ).toVar(),
      live: float(bits.element(base.add(uint(7)))).toVar(),
    };
  };

  /** The stamp at level-0 voxel `v`, or 0 when the voxel carries no record. */
  const stampAt = (v) => {
    const out = uint(0).toVar();
    const rec = recordIndexAt(v).toVar();
    If(rec.greaterThanEqual(0), () => {
      out.assign(bits.element(uint(attrWordOffset).add(rec.toUint())));
    });
    return out;
  };

  /**
   * @param {Node} voxel    level-0 voxel coords at the hit, from the trace.
   * @param {Node} worldPos the UNLIFTED hit point (`exactPosition`).
   * @param {Node} normal   the hit normal, pointing out of the surface.
   */
  const surfaceAt = (voxel, worldPos, normal) => {
    const v = vec3(voxel).floor().toVar();
    const stamp = stampAt(v).toVar();
    // THE FACE RETRY. See the header: `floor()` at a hit lying exactly on a
    // cell face lands either side of it, and the surface cell is the one the
    // normal points OUT of. A quarter voxel is the same fraction of the medium
    // the trace's own self-bias uses (R2), and it is inside the cell for any
    // wall at least one voxel thick.
    If(stamp.equal(uint(0)), () => {
      const inward = vec3(worldPos).sub(vec3(normal).mul(float(world.minCell).mul(0.25))).toVar();
      const q = inward.sub(vec3(gridOrigin)).mul(vec3(voxelInv)).floor().toVar();
      // Only when it actually moved us — otherwise this is a second identical
      // lookup, and an arm measuring the retry rate would read it as a retry
      // that found nothing rather than as a retry that never happened.
      const moved = q.sub(v).abs().x.add(q.sub(v).abs().y).add(q.sub(v).abs().z).greaterThan(0.5);
      If(moved, () => {
        const second = stampAt(q).toVar();
        if (count?.retried) count.retried(1);
        stamp.assign(second);
      });
    });

    const slotIndex = stamp.max(uint(1)).sub(uint(1)).toVar();
    const p = paletteAt(slotIndex);
    // Both halves have to hold: a stamp with no live palette entry is an
    // occupancy placement that never seated an atlas slot, and its zeroed
    // entry would otherwise read as a black surface.
    const attributed = stamp.greaterThan(uint(0)).and(p.live.greaterThan(0.5)).toVar();
    const valid = float(attributed).toVar();
    if (count?.missed) count.missed(float(1).sub(valid));
    return {
      // ⚠ `select`, NOT `a.mix(b, t)`. The method form does NOT mean
      // `mix(a, b, t)` in this TSL — measured, on the gate, with the palette
      // read proven correct one lane earlier: `vec3(fallback).mix(albedo,
      // valid)` emitted `fallback·(1−albedo) + valid·albedo`, i.e. it used the
      // ALBEDO as the interpolant and `valid` as the far endpoint. It reproduced
      // to three decimals on both boxes (A [0.820,0.110,0.090] came back
      // [0.893,0.451,0.408]), and the reason it cost a debugging round is that
      // the result is a plausible wash of the right two quantities in the wrong
      // roles — every surface tinted toward the fallback, which reads as "the
      // attribution is partly missing" rather than as an operator bug.
      // `valid` is exactly 0 or 1 here, so there is nothing to interpolate
      // anyway and `select` says what is meant.
      albedo: select(attributed, p.albedo, vec3(fallbackAlbedo)).toVar(),
      emissive: p.emissive.mul(valid).toVar(),
      // −1 whenever the hit is not attributed: an unattributed surface cannot
      // be claimed to be a NEE light, and `srcShade.js` reads `< 0` as "this is
      // not one of the sampled emitters".
      emitter: float(-1).add(p.emitter.add(1).mul(valid)).toVar(),
      valid,
      /**
       * Diagnostic lanes, for the gate only — three things can be wrong here
       * and they are indistinguishable from a shaded ray: the stamp, the
       * palette address, and the decode. §12.17.4's rule is to add the
       * instrument that SEPARATES them rather than testing them in order.
       */
      debug: {
        stamp: float(stamp), slot: float(slotIndex), rawWord0: p.rawWord0, base: float(p.base),
        paletteAlbedo: p.albedo,
      },
    };
  };

  sync();

  return {
    // One pass, 512 threads, and it is the whole cost of a recolour.
    passes: palettePass ? [palettePass] : [],
    bytes: attr.bytes,
    surfaceAt,
    sync,
    stats,
    /** Diagnostics for the gate — never read by the frame path. */
    debug: {
      paletteSlots,
      recordCapacity: attr.recordCapacity,
      staticRecordCapacity: attr.staticRecordCapacity,
      get fallbackAlbedo() {
        return [fallbackAlbedo.value.x, fallbackAlbedo.value.y, fallbackAlbedo.value.z];
      },
      paletteEntry(slot) {
        const a = paletteUniform.array[slot * 2];
        const e = paletteUniform.array[slot * 2 + 1];
        return {
          albedo: [a.x, a.y, a.z],
          emitter: a.w - 1,
          emissive: [e.x, e.y, e.z],
          live: e.w,
        };
      },
    },
    dispose() {
      materialCache.clear();
      seenPlacements = null;
    },
  };
}
