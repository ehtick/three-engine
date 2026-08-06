// CONSERVATIVE OCCUPANCY PYRAMID + HIERARCHICAL DDA — the tracing backend that
// replaces the composited mesh-SDF as the thing GI rays intersect.
// Implements docs/rc-gi-implementation-spec.md phases 1 and 4.
//
// ══ WHY, AND WHY THIS SHAPE RATHER THAN THE SPEC'S ══════════════════════════
//
// THE MEASUREMENT (scripts/run-gi-sdf-coverage.mjs, on the user's real scene):
// the per-mesh SDF bakes are fine — median 12 cells across the thinnest
// dimension. What everything actually traces is the COMPOSITED field, 128³
// over a 42m volume = 0.33m cells. A 0.5m Sponza column is one and a half
// cells wide there, so the field cannot keep its two faces apart and light
// walks through it. Every previous attempt (finer dense field, sparse fp16
// bricks) RESAMPLED that same source, and upsampling a blurred function
// recovers nothing. The only fix is to stop resampling and go to the
// triangles — which is exactly what the spec says.
//
// TWO DELIBERATE DEVIATIONS FROM THE SPEC, both because occupancy is ONE BIT:
//
//  * NO SPARSE BRICKMAP, NO CAMERA-FOLLOWING CLIPMAP (spec §1.1). Those exist
//    to bound memory at 0.125m. A field CELL in this module costs 104 B (six
//    rgba32f storage buffers) — that is what made dense impossible. A voxel
//    here costs 1 BIT. The user's 42.3×18.9×26.1m volume at 0.125m is
//    352×160×224 = 12.6M voxels = 1.6 MB, and the whole 5-level pyramid is
//    1.8 MB. There is no memory problem to solve, so there is no brick table,
//    no pool, no allocator, and no second coordinate system fighting the
//    existing scene-fit / auto-fit-refit volume.
//  * NO EXACT EDT (spec §2). Its only job is empty-space skipping, and the
//    pyramid already does that EXACTLY and conservatively by construction:
//    an OR-downsampled parent is empty only if all 8 children are, so skipping
//    its full extent can never skip geometry. That is strictly stronger than a
//    distance bound (no SAFETY subtraction, no overestimate risk — the spec's
//    whole objection to JFA) and costs 0 bytes on top of the pyramid.
//
// EVERYTHING ELSE IS THE SPEC AS WRITTEN — and its hard rules are kept:
//   · Conservative voxelization is the Akenine-Möller SEPARATING AXIS TEST
//     (13 axes) against the voxel AABB, not a point sample and not a
//     centre-distance test. Every voxel a triangle touches is set.
//   · HITS COME ONLY FROM OCCUPANCY BITS. There is no `sdf < epsilon`
//     anywhere in this file. The pyramid decides where to *look*; a level-0
//     bit decides whether a ray *stopped*.
//
// ══ LAYOUT ══════════════════════════════════════════════════════════════════
//
//   level 0   352×160×224   0.125m   ← the hit test
//   level 1   176× 80×112   0.25m    ┐
//   level 2    88× 40× 56   0.5m     │ OR-downsampled: empty ⇒ all children
//   level 3    44× 20× 28   1.0m     │ empty ⇒ safe to skip the whole extent
//   level 4    22× 10× 14   2.0m     ┘
//
// Bits pack 32-per-u32 ALONG X, so a downsample thread reads 8 contiguous
// child words and folds them with a branchless even-bit compaction. Level-0
// resolution is rounded up to a multiple of 16 so every level halves exactly.
//
// ══ ONE BUFFER, NOT FIVE ════════════════════════════════════════════════════
//
// All five levels live in ONE storage buffer at JS-computed word offsets. The
// shadow trace runs in FRAGMENT shaders on every GI-lit material, where storage
// buffers are the scarce per-stage resource (the ReSTIR 8-buffer note). Five
// bindings for a 1.8 MB pyramid would have been a real cost.
//
// And there are TWO buffers, not one: the voxelizer needs `atomic<u32>`, but
// WGSL only permits atomic access through the atomic intrinsics, and a
// read_write storage binding in a fragment shader is a portability question
// this module does not need to answer. So voxelization writes an atomic
// level-0 scratch and a copy pass lands it in the plain pyramid everything
// else reads. 1.6 MB for zero risk.
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, atomicAdd, atomicLoad, atomicMax, atomicOr, atomicStore, bitAnd, bitOr,
  countOneBits, exp2, float, floatBitsToUint, floor, instanceIndex, instancedArray, int, log2, mix, mod,
  packSnorm2x16, select, shiftLeft, shiftRight, smoothstep, uint, uintBitsToFloat, uniform, uniformArray,
  unpackSnorm2x16, vec2, vec3, vec4,
} from "three/tsl";
import { sharedFn } from "./giFn.js";
import { createRayHitDebugBuffer } from "./rayHit/RayHitDebug.js";
import { octDecodeTSL, octEncodeTSL } from "./rayHit/rayHitTSL.js";
import {
  BRICK_DYNAMIC_OFFSET_WORD,
  BRICK_HEADER_WORDS,
  BRICK_OCCUPANCY_HIGH_WORD,
  BRICK_OCCUPANCY_LOW_WORD,
  BRICK_RESOLUTION,
  BRICK_SURFACE_OFFSET_WORD,
  CELL_LOCAL_PLANE_OFFSET_RANGE,
  COMPLEX_RANGE_COUNT_MASK,
  COMPLEX_RANGE_COUNT_SHIFT,
  COMPLEX_RANGE_OFFSET_MASK,
  COMPLEX_TRIANGLE_WORDS,
  COVERAGE_FLAGS_SHIFT,
  COVERAGE_VALID_SHIFT,
  INVALID_RAY_HIT_INDEX,
  MACRO_CELL_BRICK_INDEX_WORD,
  MACRO_CELL_COVERAGE_SHIFT,
  MACRO_CELL_METADATA_WORD,
  MACRO_CELL_TYPE_MASK,
  MACRO_CELL_TYPE_SHIFT,
  MACRO_CELL_WORDS,
  MAX_BRICK_STEPS,
  MAX_COMPLEX_TRIANGLES,
  MAX_MACRO_STEPS,
  MacroCellType,
  PLANE_HIT_INTERVAL_EPSILON,
  RAY_HIT_DDA_EPSILON,
  RECORD_AWARE_PLANE_SLACK,
  RAY_HIT_DIRECTION_EPSILON,
  SELF_PLANE_EXCLUSION_SLACK,
  SIMPLE_MAX_PLANE_SIGMA,
  SIMPLE_MAX_TRIANGLES,
  SIMPLE_MIN_COHERENCE,
  SIMPLE_PLANE_IN_CELL_EPSILON,
  SURFACE_FIT_SCALE,
  SURFACE_FLAG_COMPLEX,
  SURFACE_FLAG_SIMPLE,
  SURFACE_MAX_WEIGHT,
  SURFACE_MIN_WEIGHT,
  SURFACE_RECORD_WORDS,
  SURFACE_SCRATCH_WORDS,
  packMacroCellMetadata,
  planHybridBrickLayout,
} from "./rayHit/RayHitPacking.js";

/** Pyramid depth. Level L voxels are 2^L × the level-0 voxel. */
export const OCC_LEVELS = 5;
/** Level-0 resolution is rounded up to a multiple of this so every level halves exactly. */
const RES_QUANTUM = 1 << (OCC_LEVELS - 1);
/**
 * Voxel tests one voxelizer thread performs. The CPU splits every triangle's
 * conservative voxel span into chunks of this size, so a 40m floor triangle
 * (≈100k voxels) becomes ~200 threads instead of one thread that stalls its
 * whole workgroup. That is this module's answer to the spec's two-pass
 * triangle-binning chain — same load balance, no atomic append, no prefix sum,
 * and no overflow flag that can silently drop geometry.
 */
const CHUNK_VOXELS = 512;
/** Loop iterations the hierarchical DDA is allowed. Descents count. */
const DEFAULT_TRACE_STEPS = 96;
/**
 * RECORD-AWARE SHADOW DISTANCE slack, in LEVEL-0 VOXEL UNITS (the same unit the
 * record's plane offset is quantized in — see CELL_LOCAL_PLANE_OFFSET_RANGE).
 *
 * A record's fitted plane is not the geometry, it is a least-squares fit whose
 * residual the classifier already bounds by `SIMPLE_MAX_PLANE_SIGMA`; the extra
 * margin covers the snorm16 quantization of the offset and the octahedral
 * normal. Subtracting it before the distance is used keeps the oracle
 * CONSERVATIVE — the whole reason a shadow trace is allowed to sphere-step on
 * this number. ONE definition, in RayHitPacking next to the sigma it rides on:
 * the CPU property suite measured the true requirement at 0.0948 against this
 * 0.12 — 1.27x headroom, all of it from the sigma ceiling, so the two must
 * move together or the conservativeness proof breaks.
 */
const RECORD_PLANE_SLACK = RECORD_AWARE_PLANE_SLACK;

// ───────────────────────────────────────────────────────────── level geometry

/**
 * Level dimensions, word packing and buffer offsets. Pure JS — every value here
 * is a BUILD constant (resolution never changes without a rebuild), which is
 * why the shaders can `select()` between them instead of indexing a uniform
 * array. World-space cell size is NOT here: it derives from the shared
 * `gridOrigin`/`voxelInv` uniforms so an in-place refit rescales the pyramid
 * with zero shader recompiles, exactly like the SDF field it replaces.
 */
function planLevels(res0) {
  const levels = [];
  let offset = 0;
  for (let L = 0; L < OCC_LEVELS; L++) {
    const res = {
      x: Math.max(1, res0.x >> L),
      y: Math.max(1, res0.y >> L),
      z: Math.max(1, res0.z >> L),
    };
    const wordsPerRow = Math.ceil(res.x / 32);
    const words = wordsPerRow * res.y * res.z;
    levels.push({ level: L, res, wordsPerRow, words, offset, scale: 1 << L });
    offset += words;
  }
  return { levels, totalWords: offset };
}

/**
 * DENSITY PYRAMID layout — the cone trace's medium. One u8 per coarse cell
 * (levels 1..4, packed 4-per-word) holding the FRACTION of the cell's level-0
 * descendants whose occupancy bit is set, scaled to 0..255.
 *
 * WHY IT EXISTS: the OR-downsampled bits answer "is ANYTHING here" — perfect
 * for empty-space skipping, catastrophic as a cone-trace density (one twig in
 * an 8³-voxel cell reads fully solid, so every wide-cone shadow over-darkens
 * to a black blob; that failure mode is most of why classic voxel cone tracing
 * looks muddy). The fraction is the honest per-cell coverage the cone
 * accumulator wants, it downsamples exactly (a parent's fraction is the mean
 * of its 8 children's), and at Sponza-ultra scale the whole thing is ~0.7 MB
 * appended inside the SAME `bits` buffer — zero new bindings at the
 * 8-storage-buffer wall, the module's standing allocation rule.
 *
 * Offsets here are RELATIVE to the density region base; level 0 has no entry
 * (its "fraction" is the bit itself).
 */
function planDensityLevels(levels) {
  const densityLevels = [];
  let offset = 0;
  for (let L = 1; L < OCC_LEVELS; L++) {
    const res = levels[L].res;
    const cells = res.x * res.y * res.z;
    const words = Math.ceil(cells / 4);
    densityLevels.push({ level: L, res, cells, words, offset });
    offset += words;
  }
  return { densityLevels, totalWords: offset };
}

/** Rounds a wanted level-0 resolution up so all OCC_LEVELS halve exactly. */
export function quantizeOccupancyRes(want) {
  const q = (v) => Math.max(RES_QUANTUM, Math.ceil(v / RES_QUANTUM) * RES_QUANTUM);
  return { x: q(want.x), y: q(want.y), z: q(want.z) };
}

// ───────────────────────────────────────────────────────────────── the module

/**
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds world AABB — the SAME OBJECT the SDF
 *   volume holds, so `setBounds` mutating it in place is what an in-place refit means here too
 * @param {{x,y,z}} res0 level-0 resolution — pass through `quantizeOccupancyRes` first
 * @param {{slotCapacity?: number, traceSteps?: number, enableProfiling?: boolean,
 *   countLegacyFallbacks?: boolean, enableHybridBrick?: boolean,
 *   enableSurfaceRecords?: boolean, surfaceRecordCapacity?: number,
 *   enableComplexTriangles?: boolean, complexTriangleCapacity?: number,
 *   rayHitCoarseSkip?: boolean}} [options]
 */
export function createOccupancyField(bounds, res0, options = {}) {
  const { levels, totalWords } = planLevels(res0);
  const level0 = levels[0];
  const slotCapacity = Math.max(1, options.slotCapacity ?? 512);
  const traceSteps = Math.max(16, options.traceSteps ?? DEFAULT_TRACE_STEPS);
  const hybridLayout = planHybridBrickLayout(res0);
  // Phase 2/3 imply the Phase-1 hierarchy: surface records are addressed by a
  // voxel's rank inside its brick mask, so the plane path cannot exist without
  // the macrocell/brick tail.
  const hybridEnabled = options.enableHybridBrick === true || options.enableSurfaceRecords === true;
  const surfaceEnabled = hybridEnabled && options.enableSurfaceRecords === true;
  // Compact CAPPED pool (never dense): surfaces are ~2D, so occupied level-0
  // voxels are a few percent of the grid. /12 with a 1<<21 cap: MEASURED on
  // Sponza-ultra (432×192×272) the true demand is 1.24M records, so the old
  // /16 ask (1.41M) was right but its 1<<20 cap silently denied ~190k records
  // across 10,117 bricks — a CONTIGUOUS macro-order slab of the scene whose
  // every shadow and gather hit degraded to occupied-box (full-voxel square
  // silhouettes with `marcher records` truthfully in the boot log). /12 gives
  // ×1.5 headroom at ultra and ×1.36 at high. Overflow still degrades bricks
  // to box fallback and increments the diagnostic — it can never become a
  // miss — and GISystem now logs the pool state after the first full chain.
  const level0VoxelCount = res0.x * res0.y * res0.z;
  const surfaceCapacity = surfaceEnabled
    ? Math.min(1 << 21, Math.max(1 << 14, options.surfaceRecordCapacity ?? Math.ceil(level0VoxelCount / 12)))
    : 0;
  // Phase 4: complex cells keep their SHORT exact triangle list instead of
  // degrading to an occupied box. The pool is capped for the same reason the
  // record pool is — overflow leaves the record zero (box fallback) and counts
  // a diagnostic, never a miss. 2 triangles per record is the measured
  // Sponza-class ratio for cells that fail the simple fit; each costs 36 B.
  const complexEnabled = surfaceEnabled && options.enableComplexTriangles === true;
  const complexTriangleCapacity = complexEnabled
    ? Math.min(1 << 21, Math.max(1 << 12, options.complexTriangleCapacity ?? surfaceCapacity * 2))
    : 0;
  // DYNAMIC RECORD REFIT: a reserved TAIL of the record pool, re-fitted for
  // the DynamicBrick set on EVERY chain (fast ones included) so movers keep
  // exact fitted-plane silhouettes instead of degrading to occupied-box hits
  // for as long as they move ("shadows must be smooth and follow silhouettes
  // exactly" is the standing product requirement — a moving character is
  // permanently dynamic, so the records-off window was not an edge case).
  // Dynamic records live ONE dispatch: the tail cursor resets each chain and
  // every DynamicBrick re-allocates, so there is no invalidation problem to
  // solve. Sized for mover SURFACE voxels, which are a tiny fraction of the
  // static scene's; overflow degrades that brick to box fallback and counts
  // a diagnostic — never a miss (same contract as the static pool).
  const dynamicSurfaceCapacity = surfaceEnabled
    ? Math.min(1 << 16, Math.max(1 << 12,
        options.dynamicSurfaceRecordCapacity ?? Math.ceil(surfaceCapacity / 16)))
    : 0;
  const totalSurfaceCapacity = surfaceCapacity + dynamicSurfaceCapacity;
  // The dynamic tail's own slice of the triangle pool, refit per chain like
  // the records. A mover's SILHOUETTE cells (as seen from a light) contain
  // its EDGES — two faces per cell, which fail the simple-plane fit — so
  // without exact triangles every rotated mover's shadow quantizes to full
  // voxels along precisely the cells that define its outline. Same one-
  // dispatch lifetime and overflow-degrades-to-box contract as the records.
  const dynamicComplexTriangleCapacity = complexEnabled
    ? Math.min(1 << 17, Math.max(1 << 10,
        options.dynamicComplexTriangleCapacity ?? dynamicSurfaceCapacity * 2))
    : 0;
  const totalComplexTriangleCapacity = complexTriangleCapacity + dynamicComplexTriangleCapacity;
  // Phase 5: the conservative pyramid ride (levels 3-4) has been ALWAYS-ON
  // since Phase 1, so its cost/benefit was never isolable. This is the A/B
  // kill switch, default on: disabled the traces start at level 2 and the
  // coarse branch is not emitted at all, so the two arms differ in WGSL, not
  // just in a runtime predicate.
  const coarseSkipEnabled = options.rayHitCoarseSkip !== false;
  // Opt-in so ordinary rendering keeps the exact pre-Phase-0 graph and cost.
  // When enabled this is the ONE extra storage binding used by all ray-hit
  // counters; do not split counters into per-cascade/per-kind buffers.
  const rayHitDebug = options.enableProfiling
    ? createRayHitDebugBuffer({ countLegacyFallbacks: options.countLegacyFallbacks === true })
    : null;

  // Origin and level-0 voxel size as uniforms, OWNED HERE rather than borrowed
  // from the SDF volume's `world` bundle. They describe the same box, but they
  // must be independently re-derivable from `bounds`: the volume's bundle is
  // built by createGiField AFTER this field exists, so borrowing it would have
  // left the pyramid pointing at a uniform nobody updates on a refit — the
  // whole field silently offset from the geometry it was rasterized from.
  //
  // Voxel size is also the unit the DDA works in: rays are reparameterized into
  // level-0 voxel space, so a level-L voxel is a cube of side 2^L there and NO
  // per-level world constants are needed.
  const gridOrigin = uniform(bounds.min.clone());
  const voxel = uniform(new THREE.Vector3(1, 1, 1));
  const voxelInv = uniform(new THREE.Vector3(1, 1, 1));
  const syncVoxel = () => {
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    gridOrigin.value.copy(bounds.min);
    voxel.value.set(size.x / res0.x, size.y / res0.y, size.z / res0.z);
    voxelInv.value.set(res0.x / size.x, res0.y / size.y, res0.z / size.z);
  };
  syncVoxel();

  // ────────────────────────────────────────────────────────────── the bitsets
  const hybridWordOffset = totalWords;
  const surfaceWordOffset = totalWords + (hybridEnabled ? hybridLayout.totalWords : 0);
  // The record region carries the static pool followed by the dynamic tail —
  // dynamic record ids are plain pool indices >= surfaceCapacity, so every
  // consumer's `surfaceWordOffset + record * SURFACE_RECORD_WORDS` arithmetic
  // covers both without a second base.
  const trianglePoolWordOffset = surfaceWordOffset + totalSurfaceCapacity * SURFACE_RECORD_WORDS;
  // Cone-trace density region (see planDensityLevels) — appended last so every
  // existing offset stays byte-identical.
  const densityPlan = planDensityLevels(levels);
  const densityWordOffset = trianglePoolWordOffset + totalComplexTriangleCapacity * COMPLEX_TRIANGLE_WORDS;
  const bits = instancedArray(new Uint32Array(
    densityWordOffset + densityPlan.totalWords,
  ), "uint");
  const atomicBits = instancedArray(new Uint32Array(level0.words), "uint").toAtomic();
  // Phase-1 macrocell/brick records, the Phase-2 surface-record pool and the
  // Phase-4 triangle pool are appended to this same allocation, never exposed
  // as a second storage binding: the composed cascade kernel already sits at
  // the portable eight-storage-buffer stage limit. Legacy offsets remain
  // unchanged and legacy-only builds allocate no tail at all.
  // Build-only scratch for the surface fit (fixed-point atomic accumulators)
  // and the pool allocator [recordNext, overflowBricks, triangleNext,
  // complexOverflowCells, dynRecordNext, dynOverflowBricks, spare, spare].
  // Bound exclusively in build kernels, which sit far below the binding wall.
  // The scratch covers the dynamic tail too — dynamic records reuse the same
  // fixed-point fit, just cleared and refilled every chain.
  const surfScratch = surfaceEnabled
    ? instancedArray(new Int32Array(totalSurfaceCapacity * SURFACE_SCRATCH_WORDS), "int").toAtomic()
    : null;
  const surfAlloc = surfaceEnabled
    ? instancedArray(new Uint32Array(8), "uint").toAtomic()
    : null;

  // ── STATIC/DYNAMIC SPLIT ──────────────────────────────────────────────────
  //
  // THE MEASUREMENT THIS EXISTS FOR (run-gi-perf.mjs, user's Sponza,
  // 2026-08-03): one animated 1m sphere cost +3.3ms (high) / +5.2ms (ultra)
  // of GPU compute PER FRAME, because any transform change re-voxelized the
  // ENTIRE scene — 6.25M (slot, tri, chunk) SAT work items at ultra for a
  // mover that owns ~2k of them. In a game something always moves, so that
  // was the steady-state cost, not a transient.
  //
  // The split: slots are STATIC by default; GISystem promotes a slot to
  // DYNAMIC when its matrix changes and demotes it after a quiet period.
  // Static slots voxelize ONCE into a level-0 snapshot (`staticBits`, plus
  // `staticAttr` for the attribution grid); a frame where only dynamic slots
  // moved replays the snapshot (2 buffer copies) and voxelizes ONLY the
  // dynamic slots on top. Bit-identical to the full pass by construction:
  // OR is commutative and the attribution uses atomicMax (deterministic
  // winner), so static ∪ dynamic in two passes is the same set of bits as
  // one pass over everything.
  //
  // A slot CHANGING SETS (static↔dynamic) marks `staticDirty`, which forces
  // one full re-voxelize with a fresh snapshot — the snapshot must never
  // contain a dynamic slot's footprint, or restoring it would leave the
  // mover's stale geometry behind (`setSlotMatrix` also self-defends: a
  // matrix write on a slot still flagged static forces the full pass).
  // `__giNoStaticSplit = true` (live, checked per dispatch) restores the
  // old full-re-voxelize-every-frame behaviour as the A/B arm.
  const staticBits = instancedArray(new Uint32Array(level0.words), "uint");
  // slotCapacity + 1 entries: index slotCapacity is a permanent DISABLED
  // sentinel (2). Every pair-iterating kernel gates with `notEqual(want)`
  // where want is 0 or 1, so both a slot VALUE of 2 and a pair entry whose
  // pairSlot points at the sentinel are skipped by every variant with no
  // kernel change — that is what makes despawn a uniform write and a
  // tombstoned pair range one array fill.
  const slotDynamic = uniformArray(
    Array.from({ length: slotCapacity + 1 }, (_, i) => (i === slotCapacity ? 2 : 0)),
    "float",
  );
  let dynamicCount = 0;
  let staticDirty = true;
  const setSlotDynamic = (slot, dyn) => {
    if (slot < 0 || slot >= slotCapacity) return;
    const v = dyn ? 1 : 0;
    const prev = slotDynamic.array[slot];
    // Disabled slots (2) change state only through setSlotEnabled — the
    // promote/demote cadence must not resurrect a despawned mover.
    if (prev === v || prev === 2) return;
    slotDynamic.array[slot] = v;
    dynamicCount += v ? 1 : -1;
    staticDirty = true;
    dirty = true;
  };
  /**
   * Spawn/despawn without a full re-voxelize. A DISABLED slot (2) is skipped
   * by both sides of the static/dynamic split, so parking a pooled mover is a
   * uniform write; re-enabling restores the slot as DYNAMIC (spawned things
   * move — the quiet-frames demotion settles them to static later).
   * `staticDirty` fires only when a STATIC slot is disabled: its bits/attr
   * live in the snapshot and must be re-voxelized away. A dynamic slot's
   * stamps simply stop being replayed on the next fast chain.
   */
  const setSlotEnabled = (slot, enabled) => {
    if (slot < 0 || slot >= slotCapacity) return;
    const prev = slotDynamic.array[slot];
    if (enabled) {
      if (prev !== 2) return;
      slotDynamic.array[slot] = 1;
      dynamicCount += 1;
    } else {
      if (prev === 2) return;
      if (prev === 1) dynamicCount -= 1;
      else staticDirty = true;
      slotDynamic.array[slot] = 2;
    }
    dirty = true;
  };

  // ─────────────────────────────────────────── COARSE-CELL SURFACE ATTRIBUTES
  //
  // WHY THIS EXISTS: to delete the mesh-SDF atlas. The composite does not use
  // the per-mesh SDFs for their DISTANCE alone — it uses them to answer "which
  // slot owns this cell" (so it can read that slot's mean albedo/emissive) and
  // "which way does the surface face". Those two answers are the atlas's real
  // job in the lighting path, and this pass produces both without a bake:
  // the voxelizer already visits every (slot, triangle, voxel), so it knows the
  // owning slot and the exact face normal at the moment it sets a bit.
  //
  // AT THE COARSE CELL RESOLUTION, not level-0. The composite is per coarse
  // cell, and per-level-0 attributes would cost more than the atlas they
  // replace (12.6M voxels × 8 B = 100 MB). A coarse grid is a few MB.
  //
  // LAST WRITE WINS, deliberately, with no atomics. Several triangles land in
  // one coarse cell and any of them is a correct answer: albedo/emissive are
  // per-slot MEAN colours (the atlas's own approximation, unchanged), and the
  // normal only has to be representative — the cascades sample it to orient a
  // cell's radiance, not to shade a silhouette. Racing stores cost nothing and
  // an atomic would serialise the hot loop of the whole voxelizer.
  //
  // `cellAttr`: ATLAS slot + 1 per coarse cell (the slotAtlas remap is applied
  // at write time; 0 = "no surface" or unseated slot). ATOMIC u32, written
  // with atomicMax so the winner in a shared cell is DETERMINISTIC (highest
  // atlas slot): the old last-write-wins vec4 re-rolled the winner by GPU
  // scheduling on EVERY dispatch, and a moving object re-voxelizes every
  // frame — so all multi-mesh seam cells re-rolled their colour per frame,
  // which the bounce amplified into visible flicker. (The vec4's yzw face
  // normal was never read by anything — deleted with the conversion.)
  let coarseRes = { x: 1, y: 1, z: 1 };
  let cellAttr = instancedArray(new Uint32Array(1), "uint").toAtomic();
  const coarseResU = uniform(new THREE.Vector3(1, 1, 1));
  /**
   * Points the attribute grid at the composite's cell resolution. Called by
   * createGiField, which owns that resolution — the pyramid's own level-0 res
   * is chosen for tracing and is deliberately finer.
   */
  const setCoarseRes = (res) => {
    coarseRes = { x: res.x, y: res.y, z: res.z };
    coarseResU.value.set(res.x, res.y, res.z);
    cellAttr = instancedArray(new Uint32Array(res.x * res.y * res.z), "uint").toAtomic();
    staticAttr = instancedArray(new Uint32Array(res.x * res.y * res.z), "uint");
    computesRevision = -1; // the voxelize kernel closes over this buffer
    staticDirty = true;
    dirty = true;
  };

  // Occupancy slot → ATLAS slot bridge, uploaded by GISystem. The two
  // numberings are independent (placements by mesh-walk order, atlas slots by
  // #syncSlots priority), which is the crossed-numbering bug that got
  // cellAttr's colours disabled in the composite. -1 = no atlas slot
  // (unseated/overflow) — writes as cellAttr.x = 0, "no surface", so the
  // composite keeps its nearest-slot answer there.
  //
  // THE REMAP IS APPLIED HERE, IN THE VOXELIZER — NOT READ IN THE COMPOSITE.
  // Binding this array in the composite kernel was one uniform buffer too
  // many: that kernel already sits at the user GPU's 12-uniform-buffer
  // per-stage limit, and buffer 13 fails CreateBindGroupLayout, which drops
  // the WHOLE compute batch (the documented over-limit failure shape). The
  // voxelizer binds ~3, so the remap rides here for free; a remap change
  // marks the field dirty so the attribution re-bakes on the next dispatch.
  const slotAtlas = uniformArray(Array.from({ length: slotCapacity }, () => -1), "float");
  const setSlotAtlas = (slot, atlasSlot) => {
    if (slot < 0 || slot >= slotCapacity) return;
    if (slotAtlas.array[slot] === atlasSlot) return;
    slotAtlas.array[slot] = atlasSlot;
    // Attribution numbering changed. Only a STATIC slot's attr lives in the
    // snapshot; dynamic (and disabled) slots re-stamp every dispatch, so
    // their remap is a plain uniform write — this is what keeps pooled
    // spawn/despawn (which reseats atlas slots) off the full re-voxelize.
    if (slotDynamic.array[slot] === 0) staticDirty = true;
    dirty = true;
  };

  // ───────────────────────────────────────────────────────── geometry buffers
  // Triangle soup for every UNIQUE geometry, concatenated, in LOCAL space —
  // which is what makes instancing free: 200 crates share one vertex range and
  // differ only by a matrix. Vertices are vec4 (w unused) because a storage
  // array of vec3 is padded to 16 B in WGSL anyway; taking the padding
  // explicitly keeps the indexing honest.
  let vertexBuffer = instancedArray(new Float32Array(4), "vec4");
  let indexBuffer = instancedArray(new Uint32Array(3), "uint");
  // One entry per (slot, triangle, chunk) work item — see `setGeometry`.
  let pairSlot = instancedArray(new Uint32Array(1), "uint");
  let pairTri = instancedArray(new Uint32Array(1), "uint");
  let pairChunk = instancedArray(new Uint32Array(1), "uint");
  let pairCount = 0;
  let geometryRevision = 0;
  // ── Incremental bookkeeping (see setGeometry). The buffers above are
  // allocated with HEADROOM on a full rebuild; afterwards a changed mesh set
  // is, whenever it fits, an append into the existing arrays + partial GPU
  // upload + a dispatch-count bump — no new buffer nodes, no compute-graph
  // rebuild, no geometryRevision bump (which would force a whole-volume
  // composite), and no staticDirty when only movers changed. That is the
  // difference between "spawning a ball freezes the game" and a uniform write.
  let geoRanges = new Map(); // key -> {vertexStart, triStart, triCount, verts}
  let extentsCache = new Map(); // key -> Float32Array longest-local-axis per tri
  let slotPairInfo = new Map(); // slot -> {start, count, key, chunkDensity}
  let enabledSlots = new Set(); // slots present in the last placements list
  let vertexUsed = 0, triUsed = 0, vertexCap = 0, triCap = 0, pairCap = 0;
  let vdataArr = null, idataArr = null, pairSlotArr = null, pairTriArr = null, pairChunkArr = null;
  let pairComputes = []; // every compute dispatched over the pair list

  // Local→world per instance slot. The atlas carries the INVERSE (it samples
  // slot SDFs by pushing world points into local space); voxelization pushes
  // local triangles out into world space, so it needs the forward matrix.
  const localToWorld = uniformArray(Array.from({ length: slotCapacity }, () => new THREE.Matrix4()));

  const stats = {
    res: res0,
    levels: levels.map((l) => ({ ...l.res })),
    voxelSize: 0,
    totalWords,
    bytes: (
      totalWords + level0.words + (hybridEnabled ? hybridLayout.totalWords : 0) +
      totalSurfaceCapacity * (SURFACE_RECORD_WORDS + SURFACE_SCRATCH_WORDS) +
      totalComplexTriangleCapacity * COMPLEX_TRIANGLE_WORDS +
      densityPlan.totalWords
    ) * 4,
    surfaceCapacity,
    dynamicSurfaceCapacity,
    complexTriangleCapacity,
    triangles: 0,
    pairs: 0,
    slots: 0,
    occupiedVoxels: -1,
    buildMs: 0,
    dispatches: 0,
  };
  const syncStats = () => {
    stats.voxelSize = Math.min(voxel.value.x, voxel.value.y, voxel.value.z);
  };
  syncStats();

  let dirty = true;

  // ══════════════════════════════════════════════════════ SHADER: bit access
  /**
   * Runtime `level` → a JS-constant-per-level value, as a select chain. Levels
   * are a build constant, so this compiles to 4 selects and no memory traffic —
   * cheaper and simpler than a uniform array, and it cannot go stale.
   */
  const levelSelect = (level, pick) => {
    let node = float(pick(levels[OCC_LEVELS - 1]));
    for (let L = OCC_LEVELS - 2; L >= 0; L--) {
      node = select(level.equal(int(L)), float(pick(levels[L])), node);
    }
    return node;
  };

  /**
   * Occupancy bit at integer voxel coords `v` on `level`, as a float 0/1.
   * Out-of-range reads 0 — a ray leaving the volume must not wrap into a
   * neighbouring row's bits and stop on them.
   *
   * Consumed as PURE DATAFLOW (a `select`, not an `If` around the fetch). An
   * `If()` gate around a `.toVar()`ed buffer read is the idiom that rendered
   * the BVH mirror pass black — see giLight's note.
   */
  const occupiedAt = (v, level) => {
    const rx = levelSelect(level, (l) => l.res.x).toVar();
    const ry = levelSelect(level, (l) => l.res.y).toVar();
    const rz = levelSelect(level, (l) => l.res.z).toVar();
    const wpr = levelSelect(level, (l) => l.wordsPerRow).toVar();
    const off = levelSelect(level, (l) => l.offset).toVar();

    const inside = v.x.greaterThanEqual(0).and(v.y.greaterThanEqual(0)).and(v.z.greaterThanEqual(0))
      .and(v.x.lessThan(rx)).and(v.y.lessThan(ry)).and(v.z.lessThan(rz));

    const xi = v.x.max(0).min(rx.sub(1)).toUint().toVar();
    const yi = v.y.max(0).min(ry.sub(1)).toUint().toVar();
    const zi = v.z.max(0).min(rz.sub(1)).toUint().toVar();
    const word = off.toUint()
      .add(zi.mul(ry.toUint()).add(yi).mul(wpr.toUint()))
      .add(shiftRight(xi, uint(5)));
    const raw = bitAnd(shiftRight(bits.element(word), bitAnd(xi, uint(31))), uint(1)).toFloat();
    return select(inside, raw, float(0));
  };

  /**
   * `occupiedAt` specialised to level 0, with every dimension a JS constant.
   *
   * Worth its own copy because the distance oracle's near field calls it 27
   * times per sample: the general version resolves five `levelSelect` chains
   * (one per level dimension) against a runtime `level`, and paying that 27
   * times for a level that is known at compile time is the difference between
   * an affordable oracle and an unaffordable one.
   */
  const occupiedAtLevel0 = (v) => {
    const l0 = levels[0];
    const inside = v.x.greaterThanEqual(0).and(v.y.greaterThanEqual(0)).and(v.z.greaterThanEqual(0))
      .and(v.x.lessThan(l0.res.x)).and(v.y.lessThan(l0.res.y)).and(v.z.lessThan(l0.res.z));
    const xi = v.x.max(0).min(l0.res.x - 1).toUint().toVar();
    const yi = v.y.max(0).min(l0.res.y - 1).toUint().toVar();
    const zi = v.z.max(0).min(l0.res.z - 1).toUint().toVar();
    const word = uint(l0.offset)
      .add(zi.mul(uint(l0.res.y)).add(yi).mul(uint(l0.wordsPerRow)))
      .add(shiftRight(xi, uint(5)));
    const raw = bitAnd(shiftRight(bits.element(word), bitAnd(xi, uint(31))), uint(1)).toFloat();
    return select(inside, raw, float(0));
  };

  // ═════════════════════════════════════════════════════ SHADER: voxelization
  /**
   * Akenine-Möller triangle/AABB separating axis test, in LEVEL-0 VOXEL SPACE
   * so the box is a unit cube (half extent 0.5) and every axis test is a bare
   * dot product. Working in voxel space also makes non-cubic voxels free: the
   * anisotropy is absorbed by the space, not by the test.
   *
   * 13 axes: 9 edge×boxAxis cross products, 3 box face normals, 1 triangle
   * plane. Anything less is not conservative, and a voxel a triangle merely
   * grazes is exactly the voxel a sub-voxel column needs in order to exist.
   *
   * Emitted inline rather than as a laid-out `Fn`: there is exactly one call
   * site, so a real WGSL function would save nothing and would put a
   * code-cached Fn instance in play for no reason (see giFn.js's trap note).
   *
   * Returns a float 1 = overlap, 0 = separated.
   */
  const triBoxOverlap = (c, h, a0, a1, a2) => {
    const v0 = a0.sub(c).toVar();
    const v1 = a1.sub(c).toVar();
    const v2 = a2.sub(c).toVar();
    const e0 = v1.sub(v0).toVar();
    const e1 = v2.sub(v1).toVar();
    const e2 = v0.sub(v2).toVar();
    const ok = float(1).toVar();

    // Projection interval of the triangle onto a separating axis vs the box's
    // radius on that axis. `pa`/`pb` are the two projections that can be
    // extremal (the third is always the shared vertex, which projects to 0).
    const span = (pa, pb, rad) => {
      ok.assign(select(pa.min(pb).greaterThan(rad).or(pa.max(pb).lessThan(rad.negate())), float(0), ok));
    };

    // --- 9 cross-product axes, with Akenine-Möller's exact vertex pairings.
    const f0 = e0.abs().toVar();
    const f1 = e1.abs().toVar();
    const f2 = e2.abs().toVar();
    // e × X → uses (y, z). X01 pairs v0/v2; X2 pairs v0/v1.
    const testX = (e, f, pa, pb) =>
      span(e.z.mul(pa.y).sub(e.y.mul(pa.z)), e.z.mul(pb.y).sub(e.y.mul(pb.z)), f.z.mul(h.y).add(f.y.mul(h.z)));
    // e × Y → uses (x, z). Y02 pairs v0/v2; Y1 pairs v0/v1.
    const testY = (e, f, pa, pb) =>
      span(e.z.mul(pa.x).negate().add(e.x.mul(pa.z)), e.z.mul(pb.x).negate().add(e.x.mul(pb.z)), f.z.mul(h.x).add(f.x.mul(h.z)));
    // e × Z → uses (x, y). Z12 pairs v1/v2; Z0 pairs v0/v1.
    const testZ = (e, f, pa, pb) =>
      span(e.y.mul(pa.x).sub(e.x.mul(pa.y)), e.y.mul(pb.x).sub(e.x.mul(pb.y)), f.y.mul(h.x).add(f.x.mul(h.y)));

    testX(e0, f0, v0, v2); testY(e0, f0, v0, v2); testZ(e0, f0, v1, v2);
    testX(e1, f1, v0, v2); testY(e1, f1, v0, v2); testZ(e1, f1, v0, v1);
    testX(e2, f2, v0, v1); testY(e2, f2, v0, v1); testZ(e2, f2, v1, v2);

    // --- 3 box face normals: the triangle's AABB must overlap the voxel's.
    const tmin = v0.min(v1).min(v2).toVar();
    const tmax = v0.max(v1).max(v2).toVar();
    ok.assign(select(tmin.x.greaterThan(h.x).or(tmax.x.lessThan(h.x.negate())), float(0), ok));
    ok.assign(select(tmin.y.greaterThan(h.y).or(tmax.y.lessThan(h.y.negate())), float(0), ok));
    ok.assign(select(tmin.z.greaterThan(h.z).or(tmax.z.lessThan(h.z.negate())), float(0), ok));

    // --- 1 triangle plane vs the box. With the box centred at the origin this
    // is |dot(n, v0)| ≤ h · |n|.
    const n = e0.cross(e1).toVar();
    const rad = h.x.mul(n.x.abs()).add(h.y.mul(n.y.abs())).add(h.z.mul(n.z.abs()));
    ok.assign(select(n.dot(v0).abs().greaterThan(rad), float(0), ok));

    return ok;
  };

  /**
   * Zeroes the atomic level-0 scratch. One thread per word. A BUILDER, and
   * that is load-bearing for the SPAWN-BLINK GUARD (GISystem #tick): the
   * clear is the one DESTRUCTIVE stable node in the full chain, and a
   * geometry change rebuilds the voxelize nodes — if the clear kept its
   * old compiled pipeline it would EXECUTE in the same dispatch where the
   * fresh voxelize nodes are skipped (async pipeline compiles), leaving an
   * empty pyramid for every trace until the pipelines land. Rebuilding the
   * clear WITH the voxelize nodes makes the whole trigger dispatch
   * uncompiled-together, so the skip mechanism itself keeps the chain
   * atomic: nothing of it runs until all of it can.
   */
  const buildClearCompute = () => Fn(() => {
    atomicStore(atomicBits.element(instanceIndex), uint(0));
  })().compute(level0.words);

  /**
   * Zeroes the surface-attribution grid. Without this a mesh that moved or
   * left keeps colouring its old cells forever — nothing overwrites a cell no
   * triangle touches any more. A BUILDER (like buildVoxelizeCompute): it
   * closes over the current `cellAttr` allocation, which `setCoarseRes`
   * replaces, and the dispatch size is that allocation's cell count.
   */
  const buildClearAttrCompute = () => Fn(() => {
    atomicStore(cellAttr.element(instanceIndex), uint(0));
  })().compute(Math.max(1, coarseRes.x * coarseRes.y * coarseRes.z));

  /**
   * One thread per WORK ITEM = (slot, triangle, chunk). Rebuilt whenever the
   * geometry buffers change, because the body closes over them and the
   * dispatch size is the work-item count.
   *
   * `filter` ("static" | "dynamic" | null) makes the pass cover only one
   * side of the static/dynamic split. Both variants still DISPATCH the full
   * work-item count — a thread whose slot is on the other side exits after
   * two reads. That trade is deliberate: per-slot work-item ranges would
   * need a CPU work-list rebuild every time the dynamic SET changes, while
   * the exit-only threads cost well under 0.1ms even at ultra's 6.25M items
   * and the set membership is a uniform write.
   */
  const buildVoxelizeCompute = (filter = null) => Fn(() => {
    const slot = pairSlot.element(instanceIndex).toVar();
    if (filter) {
      const want = filter === "dynamic" ? 1 : 0;
      If(slotDynamic.element(slot.toInt()).notEqual(float(want)), () => {
        Return();
      });
    }
    const tri = pairTri.element(instanceIndex).toVar();
    const chunk = pairChunk.element(instanceIndex).toVar();

    const base = tri.mul(uint(3)).toVar();
    const i0 = indexBuffer.element(base).toVar();
    const i1 = indexBuffer.element(base.add(uint(1))).toVar();
    const i2 = indexBuffer.element(base.add(uint(2))).toVar();
    const m = localToWorld.element(slot.toInt()).toVar();
    // Local → world → level-0 voxel space. `voxelInv` carries the refit.
    const toVox = (i) => m.mul(vec4(vertexBuffer.element(i).xyz, 1)).xyz
      .sub(vec3(gridOrigin)).mul(vec3(voxelInv));
    const p0 = toVox(i0).toVar();
    const p1 = toVox(i1).toVar();
    const p2 = toVox(i2).toVar();

    // Conservative voxel span: the triangle's voxel AABB grown half a voxel
    // each way, clamped to the grid. Anything outside is out of the volume —
    // the field is scene-fit, not infinite.
    const lo = p0.min(p1).min(p2).sub(0.5).floor().max(vec3(0)).toVar();
    const hi = p0.max(p1).max(p2).add(0.5).floor()
      .min(vec3(level0.res.x - 1, level0.res.y - 1, level0.res.z - 1)).toVar();

    // Whole-body guard rather than an early Break: `break` outside a loop is
    // not valid WGSL, and a fully-clipped triangle is common at the volume
    // boundary, not exceptional.
    If(hi.x.greaterThanEqual(lo.x).and(hi.y.greaterThanEqual(lo.y)).and(hi.z.greaterThanEqual(lo.z)), () => {
      const nx = hi.x.sub(lo.x).add(1).toVar();
      const ny = hi.y.sub(lo.y).add(1).toVar();
      const nz = hi.z.sub(lo.z).add(1).toVar();
      const total = nx.mul(ny).mul(nz).toVar();
      const start = chunk.toFloat().mul(CHUNK_VOXELS).toVar();
      // `h` carries the spec's conservativeEps: half a voxel plus a hair, so a
      // triangle lying exactly on a voxel face is counted rather than lost to
      // a float tie.
      const h = vec3(0.5 + 1e-4).toVar();

      Loop({ start: 0, end: CHUNK_VOXELS, name: "voxTest" }, ({ voxTest }) => {
        const k = start.add(voxTest.toFloat()).toVar();
        If(k.greaterThanEqual(total), () => {
          Break();
        });
        const vx = lo.x.add(mod(k, nx)).toVar();
        const vy = lo.y.add(mod(floor(k.div(nx)), ny)).toVar();
        const vz = lo.z.add(floor(k.div(nx.mul(ny)))).toVar();

        If(triBoxOverlap(vec3(vx.add(0.5), vy.add(0.5), vz.add(0.5)), h, p0, p1, p2).greaterThan(0.5), () => {
          const xi = vx.toUint().toVar();
          const word = vz.toUint().mul(uint(level0.res.y)).add(vy.toUint()).mul(uint(level0.wordsPerRow))
            .add(shiftRight(xi, uint(5)));
          atomicOr(atomicBits.element(word), shiftLeft(uint(1), bitAnd(xi, uint(31))));
          // Surface attribution for the composite (see cellAttr's comment).
          // The level-0 voxel maps into the coarse grid by ratio, which needs
          // no extra state: both grids span the same world box.
          const cx = vx.add(0.5).mul(coarseResU.x).div(float(level0.res.x)).floor().clamp(0, coarseResU.x.sub(1));
          const cy = vy.add(0.5).mul(coarseResU.y).div(float(level0.res.y)).floor().clamp(0, coarseResU.y.sub(1));
          const cz = vz.add(0.5).mul(coarseResU.z).div(float(level0.res.z)).floor().clamp(0, coarseResU.z.sub(1));
          const cell = cz.mul(coarseResU.y).add(cy).mul(coarseResU.x).add(cx).toUint();
          // ATLAS slot + 1, not occupancy slot + 1: slotAtlas applies the
          // numbering bridge right here so the composite can read the value
          // with no extra binding (it has none to spare — see slotAtlas's
          // comment). An unseated slot (-1) writes 0 = "no surface".
          // atomicMax = deterministic winner in shared cells (see cellAttr's
          // comment; last-write-wins re-rolled per dispatch = motion flicker).
          atomicMax(cellAttr.element(cell), slotAtlas.element(slot.toInt()).add(1).toUint());
        });
      });
    });
  })().compute(Math.max(1, pairCount));

  /**
   * Copies the atomic level-0 scratch into the pyramid's level-0 region.
   *
   * `atomicLoad`, not a bare read: WGSL will not implicitly convert
   * `atomic<u32>` to `u32`, and the parse error it raises ("cannot assign
   * 'atomic<u32>' to 'u32'") invalidates the pipeline — which surfaces as the
   * WHOLE compute batch being dropped, i.e. as "the field allocated nothing",
   * with nothing naming this line. Same shape as the `atomicStore` trap the
   * sparse field hit.
   */
  const copyCompute = Fn(() => {
    bits.element(instanceIndex.add(uint(level0.offset))).assign(atomicLoad(atomicBits.element(instanceIndex)));
  })().compute(level0.words);

  // Static/dynamic split (see staticBits above): snapshot the level-0 scratch
  // right after the STATIC-only voxelize pass, and replay it in place of
  // clear+static-voxelize on frames where only dynamic slots moved. The attr
  // pair are BUILDERS like buildClearAttrCompute — they close over the
  // current cellAttr/staticAttr allocations, which setCoarseRes replaces.
  const snapStaticBitsCompute = Fn(() => {
    staticBits.element(instanceIndex).assign(atomicLoad(atomicBits.element(instanceIndex)));
  })().compute(level0.words);
  const restoreStaticBitsCompute = Fn(() => {
    atomicStore(atomicBits.element(instanceIndex), staticBits.element(instanceIndex));
  })().compute(level0.words);
  let staticAttr = instancedArray(new Uint32Array(1), "uint");
  const buildSnapStaticAttrCompute = () => Fn(() => {
    staticAttr.element(instanceIndex).assign(atomicLoad(cellAttr.element(instanceIndex)));
  })().compute(Math.max(1, coarseRes.x * coarseRes.y * coarseRes.z));
  const buildRestoreStaticAttrCompute = () => Fn(() => {
    atomicStore(cellAttr.element(instanceIndex), staticAttr.element(instanceIndex));
  })().compute(Math.max(1, coarseRes.x * coarseRes.y * coarseRes.z));

  // ══════════════════════════════════════════════════════ SHADER: downsample
  // One thread per PARENT WORD. A parent word is 32 voxels along x, whose
  // children are 64 child voxels = 2 child words, for each of 2 y and 2 z —
  // 8 contiguous word reads, no atomics, no read-modify-write race.
  //
  // Folding 64 child bits into 32 parent bits is branchless: OR each bit with
  // its odd neighbour, then compact the even bits with the standard 5-step
  // shift/mask cascade (a software PEXT of 0x55555555).
  const compactEven = (w) => {
    const a = bitAnd(w, uint(0x55555555)).toVar();
    a.assign(bitAnd(bitOr(a, shiftRight(a, uint(1))), uint(0x33333333)));
    a.assign(bitAnd(bitOr(a, shiftRight(a, uint(2))), uint(0x0f0f0f0f)));
    a.assign(bitAnd(bitOr(a, shiftRight(a, uint(4))), uint(0x00ff00ff)));
    a.assign(bitAnd(bitOr(a, shiftRight(a, uint(8))), uint(0x0000ffff)));
    return a;
  };

  const downsampleComputes = [];
  for (let L = 1; L < OCC_LEVELS; L++) {
    const parent = levels[L];
    const child = levels[L - 1];
    downsampleComputes.push(
      Fn(() => {
        const w = instanceIndex.toVar();
        const wx = w.mod(uint(parent.wordsPerRow)).toVar();
        const wy = w.div(uint(parent.wordsPerRow)).mod(uint(parent.res.y)).toVar();
        const wz = w.div(uint(parent.wordsPerRow * parent.res.y)).toVar();
        const acc = uint(0).toVar();

        // The x guard is real: child.wordsPerRow is ceil(childResX/32), so
        // 2*parentWordsPerRow can exceed it by one at a row's tail. Reading
        // past it folds the NEXT row's voxels into this one — geometry
        // appearing where it is not, the hardest class of bug in this module
        // to see. The y/z guards only matter for tiny volumes, where the
        // max(1, …) resolution clamp stops levels halving exactly.
        const childWord = (cx, cy, cz) =>
          select(
            cx.lessThan(uint(child.wordsPerRow)),
            bits.element(
              uint(child.offset)
                .add(cz.min(uint(child.res.z - 1)).mul(uint(child.res.y)).add(cy.min(uint(child.res.y - 1))).mul(uint(child.wordsPerRow)))
                .add(cx.min(uint(child.wordsPerRow - 1))),
            ),
            uint(0),
          );

        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            const cy = wy.mul(uint(2)).add(uint(dy)).toVar();
            const cz = wz.mul(uint(2)).add(uint(dz)).toVar();
            const inRange = cy.lessThan(uint(child.res.y)).and(cz.lessThan(uint(child.res.z)));
            const c0 = childWord(wx.mul(uint(2)), cy, cz).toVar();
            const c1 = childWord(wx.mul(uint(2)).add(uint(1)), cy, cz).toVar();
            const folded = bitOr(
              compactEven(bitOr(c0, shiftRight(c0, uint(1)))),
              shiftLeft(compactEven(bitOr(c1, shiftRight(c1, uint(1)))), uint(16)),
            ).toVar();
            acc.assign(bitOr(acc, select(inRange, folded, uint(0))));
          }
        }
        bits.element(w.add(uint(parent.offset))).assign(acc);
      })().compute(parent.words),
    );
  }

  // ══════════════════════════════════════════════ SHADER: density downsample
  // Fraction-of-occupied-descendants per coarse cell (see planDensityLevels).
  // Level 1 counts its 8 level-0 BITS directly; levels 2-4 average their 8
  // child BYTES — the mean of means is exact because every cell has the same
  // descendant count. One thread per OUTPUT WORD (4 cells), like the bit
  // downsample. No range guards on child coords: quantizeOccupancyRes makes
  // every level halve exactly, so a child cell always exists. The only guard
  // is the tail word's cell index against the cell count.
  const densityComputes = [];
  {
    const d = densityPlan.densityLevels[0];
    const l0 = levels[0];
    densityComputes.push(
      Fn(() => {
        const w = instanceIndex.toVar();
        const packed = uint(0).toVar();
        for (let k = 0; k < 4; k++) {
          const idx = w.mul(uint(4)).add(uint(k)).toVar();
          const cx = idx.mod(uint(d.res.x)).toVar();
          const cy = idx.div(uint(d.res.x)).mod(uint(d.res.y)).toVar();
          const cz = idx.div(uint(d.res.x * d.res.y)).toVar();
          const count = uint(0).toVar();
          for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
              const vy = cy.mul(uint(2)).add(uint(dy)).toVar();
              const vz = cz.mul(uint(2)).add(uint(dz)).toVar();
              const vx = cx.mul(uint(2)).toVar();
              // 2x is even, so both x-bits live in one word — one fetch per
              // (dy, dz) pair, 4 per cell.
              const word = uint(l0.offset)
                .add(vz.mul(uint(l0.res.y)).add(vy).mul(uint(l0.wordsPerRow)))
                .add(shiftRight(vx, uint(5)));
              const pair = bitAnd(shiftRight(bits.element(word), bitAnd(vx, uint(31))), uint(3));
              count.addAssign(countOneBits(pair));
            }
          }
          // Round-to-nearest 0..8 → 0..255 so a fully solid cell is exactly 255.
          const byte = count.mul(uint(255)).add(uint(4)).div(uint(8)).toVar();
          packed.assign(bitOr(packed, shiftLeft(select(idx.lessThan(uint(d.cells)), byte, uint(0)), uint(k * 8))));
        }
        bits.element(w.add(uint(densityWordOffset + d.offset))).assign(packed);
      })().compute(d.words),
    );
  }
  for (let i = 1; i < densityPlan.densityLevels.length; i++) {
    const d = densityPlan.densityLevels[i];
    const c = densityPlan.densityLevels[i - 1];
    densityComputes.push(
      Fn(() => {
        const w = instanceIndex.toVar();
        const packed = uint(0).toVar();
        for (let k = 0; k < 4; k++) {
          const idx = w.mul(uint(4)).add(uint(k)).toVar();
          const cx = idx.mod(uint(d.res.x)).toVar();
          const cy = idx.div(uint(d.res.x)).mod(uint(d.res.y)).toVar();
          const cz = idx.div(uint(d.res.x * d.res.y)).toVar();
          const sum = uint(0).toVar();
          for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const ccx = cx.mul(uint(2)).add(uint(dx)).toVar();
                const ccy = cy.mul(uint(2)).add(uint(dy)).toVar();
                const ccz = cz.mul(uint(2)).add(uint(dz)).toVar();
                const cIdx = ccz.mul(uint(c.res.y)).add(ccy).mul(uint(c.res.x)).add(ccx).toVar();
                const cw = bits.element(uint(densityWordOffset + c.offset).add(shiftRight(cIdx, uint(2))));
                sum.addAssign(bitAnd(shiftRight(cw, shiftLeft(bitAnd(cIdx, uint(3)), uint(3))), uint(255)));
              }
            }
          }
          const byte = sum.add(uint(4)).div(uint(8)).toVar();
          packed.assign(bitOr(packed, shiftLeft(select(idx.lessThan(uint(d.cells)), byte, uint(0)), uint(k * 8))));
        }
        bits.element(w.add(uint(densityWordOffset + d.offset))).assign(packed);
      })().compute(d.words),
    );
  }

  // ══════════════════════════════════════════════════ SHADER: hierarchical DDA
  /**
   * The tracer. Every GI ray in the module goes through this.
   *
   * Reparameterized into LEVEL-0 VOXEL SPACE — `q(t) = (origin−min)/voxel +
   * t·(dir/voxel)` — so `t` stays a WORLD distance (callers' tMin/tMax and the
   * returned hit distance are all metres) while a level-L voxel is a cube of
   * side 2^L. That is what removes per-level world constants entirely.
   *
   * Each iteration either DESCENDS one level (an occupied parent means look
   * closer — no advance) or ADVANCES past at least one level-L voxel, so the
   * loop is bounded and every advance is a genuine skip. An empty parent is
   * empty in all 8 children by construction, so skipping its full extent can
   * never step over geometry — the exact empty-space skip the spec wanted an
   * EDT for, without the EDT's overestimate risk.
   *
   * Returns `{ hit, t, normal, voxel }`:
   *   hit    1 on a level-0 occupancy bit, 0 on volume exit / budget / miss
   *   t      world distance to the hit (−1 on miss)
   *   normal the crossed voxel FACE normal — free from the DDA and exact,
   *          which is better than the SDF-gradient normals it replaces
   *   voxel  level-0 integer voxel coords of the hit (for radiance lookups)
   */
  // Phase-1 build pass: one invocation per 4^3 macrocell. It mirrors the
  // current level-0 occupancy bits exactly into a dense 64-bit brick mask.
  // Dense brick indices make rebuilds deterministic and eliminate allocation,
  // atomics, and invalidation hazards; empty macrocells still carry an invalid
  // brick reference and no leaf surface records.
  //
  // With surface records enabled the pass changes in exactly two ways:
  //  · it never touches the surface/complex offset words — the allocator pass
  //    owns them, and this kernel re-runs on every FAST (dynamic-only) chain,
  //    where clobbering them would erase the static allocation;
  //  · a brick whose mask contains any bit ABSENT from the static snapshot is
  //    typed DynamicBrick. The plane path ignores the STATIC records in such
  //    bricks (they were fitted and rank-addressed against the static mask)
  //    and reads the per-chain DYNAMIC record tail instead, which the refit
  //    passes at the end of every chain rank against the merged masks this
  //    kernel just wrote.
  const hybridBuildCompute = hybridEnabled
    ? Fn(() => {
        const macroIndex = instanceIndex.toVar();
        const mx = macroIndex.mod(uint(hybridLayout.macroResolution.x)).toVar();
        const my = macroIndex.div(uint(hybridLayout.macroResolution.x))
          .mod(uint(hybridLayout.macroResolution.y)).toVar();
        const mz = macroIndex.div(uint(
          hybridLayout.macroResolution.x * hybridLayout.macroResolution.y,
        )).toVar();
        const low = uint(0).toVar();
        const high = uint(0).toVar();
        const occupiedCount = uint(0).toVar();
        const dynamicCount = surfaceEnabled ? uint(0).toVar() : null;

        // Same bounds-checked layout as occupiedAtLevel0, over the static
        // level-0 snapshot (whose word layout mirrors the pyramid's level 0).
        const staticOccupiedAtLevel0 = (v) => {
          const l0 = levels[0];
          const inside = v.x.greaterThanEqual(0).and(v.y.greaterThanEqual(0)).and(v.z.greaterThanEqual(0))
            .and(v.x.lessThan(l0.res.x)).and(v.y.lessThan(l0.res.y)).and(v.z.lessThan(l0.res.z));
          const xi = v.x.max(0).min(l0.res.x - 1).toUint().toVar();
          const yi = v.y.max(0).min(l0.res.y - 1).toUint().toVar();
          const zi = v.z.max(0).min(l0.res.z - 1).toUint().toVar();
          const word = zi.mul(uint(l0.res.y)).add(yi).mul(uint(l0.wordsPerRow))
            .add(shiftRight(xi, uint(5)));
          const raw = bitAnd(shiftRight(staticBits.element(word), bitAnd(xi, uint(31))), uint(1)).toFloat();
          return select(inside, raw, float(0));
        };

        for (let z = 0; z < BRICK_RESOLUTION; z++) {
          for (let y = 0; y < BRICK_RESOLUTION; y++) {
            for (let x = 0; x < BRICK_RESOLUTION; x++) {
              const gx = mx.mul(uint(BRICK_RESOLUTION)).add(uint(x));
              const gy = my.mul(uint(BRICK_RESOLUTION)).add(uint(y));
              const gz = mz.mul(uint(BRICK_RESOLUTION)).add(uint(z));
              const occupied = occupiedAtLevel0(vec3(gx, gy, gz)).greaterThan(0.5);
              const bit = x + y * BRICK_RESOLUTION + z * BRICK_RESOLUTION * BRICK_RESOLUTION;
              if (bit < 32) {
                low.assign(bitOr(low, select(occupied, shiftLeft(uint(1), uint(bit)), uint(0))));
              } else {
                high.assign(bitOr(high, select(occupied, shiftLeft(uint(1), uint(bit - 32)), uint(0))));
              }
              occupiedCount.addAssign(select(occupied, uint(1), uint(0)));
              if (surfaceEnabled) {
                const isStatic = staticOccupiedAtLevel0(vec3(gx, gy, gz)).greaterThan(0.5);
                dynamicCount.addAssign(select(occupied.and(isStatic.not()), uint(1), uint(0)));
              }
            }
          }
        }

        const hasBrick = occupiedCount.greaterThan(uint(0));
        const macroBase = macroIndex.mul(uint(MACRO_CELL_WORDS));
        const brickBase = uint(hybridLayout.brickHeaderOffset)
          .add(macroIndex.mul(uint(BRICK_HEADER_WORDS)));
        bits.element(uint(hybridWordOffset).add(macroBase).add(uint(MACRO_CELL_BRICK_INDEX_WORD))).assign(
          select(hasBrick, macroIndex, uint(INVALID_RAY_HIT_INDEX)),
        );
        const coverage = occupiedCount.mul(uint(255)).div(uint(64)).min(uint(255));
        const emptyMetadata = uint(packMacroCellMetadata({
          type: MacroCellType.Empty,
          generation: 1,
        }));
        let brickMetadata = bitOr(
          uint(packMacroCellMetadata({ type: MacroCellType.Brick, generation: 1 })),
          shiftLeft(coverage, uint(MACRO_CELL_COVERAGE_SHIFT)),
        );
        if (surfaceEnabled) {
          const dynamicMetadata = bitOr(
            uint(packMacroCellMetadata({ type: MacroCellType.DynamicBrick, generation: 1 })),
            shiftLeft(coverage, uint(MACRO_CELL_COVERAGE_SHIFT)),
          );
          brickMetadata = select(dynamicCount.greaterThan(uint(0)), dynamicMetadata, brickMetadata);
        }
        bits.element(uint(hybridWordOffset).add(macroBase).add(uint(MACRO_CELL_METADATA_WORD))).assign(
          select(hasBrick, brickMetadata, emptyMetadata),
        );
        bits.element(uint(hybridWordOffset).add(brickBase).add(uint(BRICK_OCCUPANCY_LOW_WORD))).assign(low);
        bits.element(uint(hybridWordOffset).add(brickBase).add(uint(BRICK_OCCUPANCY_HIGH_WORD))).assign(high);
        if (!surfaceEnabled) {
          bits.element(uint(hybridWordOffset).add(brickBase).add(uint(BRICK_SURFACE_OFFSET_WORD))).assign(uint(INVALID_RAY_HIT_INDEX));
          bits.element(uint(hybridWordOffset).add(brickBase).add(uint(BRICK_DYNAMIC_OFFSET_WORD))).assign(uint(INVALID_RAY_HIT_INDEX));
        }
      })().compute(hybridLayout.macroCellCount)
    : null;

  // ══════════════════════════════════ SHADER: Phase-2 surface-record build
  // Three passes. The STATIC side runs on FULL chains only, against the
  // STATIC-ONLY level-0 state (they sit between the static-stage hybridBuild
  // and the dynamic voxelize in passes()). Records are therefore fitted and
  // rank-addressed against the static brick masks, which is what makes them
  // remain valid on every FAST chain: static bits never change between full
  // rebuilds. Bricks that gain dynamic bits are typed DynamicBrick — the
  // tracer ignores the STATIC records there and consults the per-chain
  // DYNAMIC record tail instead (see the dynamic-tail refit passes below).

  /** Zero the fit scratch and the pool allocator. */
  const surfClearCompute = surfaceEnabled
    ? Fn(() => {
        atomicStore(surfScratch.element(instanceIndex), int(0));
        If(instanceIndex.lessThan(uint(4)), () => {
          atomicStore(surfAlloc.element(instanceIndex), uint(0));
        });
      })().compute(surfaceCapacity * SURFACE_SCRATCH_WORDS)
    : null;

  /**
   * One record per occupied voxel, per brick, addressed by the voxel's rank in
   * the brick mask. Pool overflow leaves the brick INVALID (box fallback) and
   * counts it in surfAlloc[1] — never a miss. Runs while the brick headers
   * hold the STATIC masks.
   */
  const surfAllocCompute = surfaceEnabled
    ? Fn(() => {
        const macroIndex = instanceIndex.toVar();
        const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
          .add(macroIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
        const low = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD))).toVar();
        const high = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD))).toVar();
        const count = countOneBits(low).add(countOneBits(high)).toVar();
        const offset = uint(INVALID_RAY_HIT_INDEX).toVar();
        If(count.greaterThan(uint(0)), () => {
          const base = atomicAdd(surfAlloc.element(0), count).toVar();
          If(base.add(count).lessThanEqual(uint(surfaceCapacity)), () => {
            offset.assign(base);
          }).Else(() => {
            atomicAdd(surfAlloc.element(1), uint(1));
          });
        });
        bits.element(brickBase.add(uint(BRICK_SURFACE_OFFSET_WORD))).assign(offset);
        bits.element(brickBase.add(uint(BRICK_DYNAMIC_OFFSET_WORD))).assign(uint(INVALID_RAY_HIT_INDEX));
      })().compute(hybridLayout.macroCellCount)
    : null;

  /**
   * Accumulation: the voxelizer's own (slot, triangle, chunk) work list and
   * SAT test, one side of the static/dynamic split at a time. Every
   * conservative triangle/voxel overlap adds fixed-point area-weighted plane
   * terms and three dominant-axis coverage projections to the voxel's record
   * scratch. Integer atomics make the result order-independent, i.e.
   * deterministic across dispatches.
   * A BUILDER like buildVoxelizeCompute: closes over the geometry buffers.
   *
   * `filter` mirrors buildVoxelizeCompute's: "static" (full chain, records
   * rank-addressed via the STATIC offset word against static masks) or
   * "dynamic" (every chain, records rank-addressed via the DYNAMIC offset
   * word against the final MERGED masks — the fit runs after the last
   * hybridBuild, so the masks it ranks against are the ones the tracer
   * reads). Threads on the other side of the split exit after two reads,
   * same deliberate trade as the voxelizer's.
   */
  const buildSurfAccumCompute = surfaceEnabled
    ? (filter = "static") => Fn(() => {
        const slot = pairSlot.element(instanceIndex).toVar();
        const want = filter === "dynamic" ? 1 : 0;
        If(slotDynamic.element(slot.toInt()).notEqual(float(want)), () => {
          Return();
        });
        const tri = pairTri.element(instanceIndex).toVar();
        const chunk = pairChunk.element(instanceIndex).toVar();

        const base = tri.mul(uint(3)).toVar();
        const i0 = indexBuffer.element(base).toVar();
        const i1 = indexBuffer.element(base.add(uint(1))).toVar();
        const i2 = indexBuffer.element(base.add(uint(2))).toVar();
        const m = localToWorld.element(slot.toInt()).toVar();
        const toVox = (i) => m.mul(vec4(vertexBuffer.element(i).xyz, 1)).xyz
          .sub(vec3(gridOrigin)).mul(vec3(voxelInv));
        const p0 = toVox(i0).toVar();
        const p1 = toVox(i1).toVar();
        const p2 = toVox(i2).toVar();

        // Triangle plane data in level-0 voxel space, once per work item. A
        // degenerate triangle carries no plane information; its occupancy bit
        // (set by the voxelizer) then finalizes as complex → box fallback.
        const nRaw = p1.sub(p0).cross(p2.sub(p0)).toVar();
        const nLen = nRaw.length().toVar();
        If(nLen.lessThanEqual(1e-12), () => {
          Return();
        });
        const nHat = nRaw.div(nLen).toVar();
        const wTri = nLen.mul(0.5).clamp(SURFACE_MIN_WEIGHT, SURFACE_MAX_WEIGHT).toVar();
        const centroid = p0.add(p1).add(p2).div(3).toVar();
        const fx = (value) => value.mul(SURFACE_FIT_SCALE).round().toInt();

        const lo = p0.min(p1).min(p2).sub(0.5).floor().max(vec3(0)).toVar();
        const hi = p0.max(p1).max(p2).add(0.5).floor()
          .min(vec3(level0.res.x - 1, level0.res.y - 1, level0.res.z - 1)).toVar();

        If(hi.x.greaterThanEqual(lo.x).and(hi.y.greaterThanEqual(lo.y)).and(hi.z.greaterThanEqual(lo.z)), () => {
          const nx = hi.x.sub(lo.x).add(1).toVar();
          const ny = hi.y.sub(lo.y).add(1).toVar();
          const nz = hi.z.sub(lo.z).add(1).toVar();
          const total = nx.mul(ny).mul(nz).toVar();
          const start = chunk.toFloat().mul(CHUNK_VOXELS).toVar();
          const h = vec3(0.5 + 1e-4).toVar();

          Loop({ start: 0, end: CHUNK_VOXELS, name: "surfVox" }, ({ surfVox }) => {
            const k = start.add(surfVox.toFloat()).toVar();
            If(k.greaterThanEqual(total), () => {
              Break();
            });
            const vx = lo.x.add(mod(k, nx)).toVar();
            const vy = lo.y.add(mod(floor(k.div(nx)), ny)).toVar();
            const vz = lo.z.add(floor(k.div(nx.mul(ny)))).toVar();

            If(triBoxOverlap(vec3(vx.add(0.5), vy.add(0.5), vz.add(0.5)), h, p0, p1, p2).greaterThan(0.5), () => {
              const mxq = vx.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const myq = vy.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const mzq = vz.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const macroIndex = mzq.mul(uint(hybridLayout.macroResolution.y)).add(myq)
                .mul(uint(hybridLayout.macroResolution.x)).add(mxq).toVar();
              const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                .add(macroIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
              // The dynamic variant reads its own offset word — INVALID on
              // every brick the dynamic allocator did not claim, so the gate
              // below scopes it to DynamicBrick bricks for free.
              const offsetWord = filter === "dynamic"
                ? BRICK_DYNAMIC_OFFSET_WORD
                : BRICK_SURFACE_OFFSET_WORD;
              const surfOffset = bits.element(brickBase.add(uint(offsetWord))).toVar();
              If(surfOffset.notEqual(uint(INVALID_RAY_HIT_INDEX)), () => {
                const low = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD))).toVar();
                const high = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD))).toVar();
                const lx = vx.toUint().bitAnd(uint(3));
                const ly = vy.toUint().bitAnd(uint(3));
                const lz = vz.toUint().bitAnd(uint(3));
                const bitIdx = lz.mul(uint(16)).add(ly.mul(uint(4))).add(lx).toVar();
                const inLow = bitIdx.lessThan(uint(32));
                const word = select(inLow, low, high).toVar();
                const bitSet = bitAnd(shiftRight(word, bitAnd(bitIdx, uint(31))), uint(1));
                // Defensive: the voxelizer set this bit from the same SAT.
                If(bitSet.notEqual(uint(0)), () => {
                  const belowLow = select(inLow, shiftLeft(uint(1), bitAnd(bitIdx, uint(31))).sub(uint(1)), uint(0xffffffff));
                  const belowHigh = select(inLow, uint(0), shiftLeft(uint(1), bitAnd(bitIdx, uint(31))).sub(uint(1)));
                  const rank = countOneBits(bitAnd(low, belowLow)).add(countOneBits(bitAnd(high, belowHigh)));
                  const record = surfOffset.add(rank).toVar();
                  If(record.lessThan(uint(totalSurfaceCapacity)), () => {
                    const sBase = record.mul(uint(SURFACE_SCRATCH_WORDS)).toVar();
                    const cellOrigin = vec3(vx, vy, vz).toVar();
                    const dLocal = nHat.dot(centroid.sub(cellOrigin)).toVar();
                    atomicAdd(surfScratch.element(sBase), fx(nHat.x.mul(wTri)));
                    atomicAdd(surfScratch.element(sBase.add(uint(1))), fx(nHat.y.mul(wTri)));
                    atomicAdd(surfScratch.element(sBase.add(uint(2))), fx(nHat.z.mul(wTri)));
                    atomicAdd(surfScratch.element(sBase.add(uint(3))), fx(wTri));
                    atomicAdd(surfScratch.element(sBase.add(uint(4))), fx(dLocal.mul(wTri)));
                    atomicAdd(surfScratch.element(sBase.add(uint(5))), fx(dLocal.mul(dLocal).mul(wTri)));
                    atomicAdd(surfScratch.element(sBase.add(uint(6))), int(1));
                    // Conservative 4x4 coverage in all three dominant-axis
                    // projections (16 bits each) — the finalize pass picks one
                    // after the normal is known, so one geometry pass suffices.
                    const la = p0.sub(cellOrigin).toVar();
                    const lb = p1.sub(cellOrigin).toVar();
                    const lc = p2.sub(cellOrigin).toVar();
                    const proj = (p, axis) => axis === 0 ? vec2(p.y, p.z) : axis === 1 ? vec2(p.x, p.z) : vec2(p.x, p.y);
                    for (let axis = 0; axis < 3; axis++) {
                      const pa = proj(la, axis).toVar();
                      const pb = proj(lb, axis).toVar();
                      const pc = proj(lc, axis).toVar();
                      // Edge functions offset by the texel's Minkowski radius:
                      // exact-conservative rect/triangle overlap for convex
                      // shapes; a degenerate (edge-on) projection falls back
                      // to its AABB texels — over-covering, the safe side.
                      const mask = uint(0).toVar();
                      const area2 = pb.x.sub(pa.x).mul(pc.y.sub(pa.y))
                        .sub(pb.y.sub(pa.y).mul(pc.x.sub(pa.x))).toVar();
                      const orient = select(area2.lessThan(0), float(-1), float(1)).toVar();
                      const degenerate = area2.abs().lessThan(1e-9).toVar();
                      const texelHalf = float(1 / 8);
                      const loU = pa.x.min(pb.x).min(pc.x).toVar();
                      const loV = pa.y.min(pb.y).min(pc.y).toVar();
                      const hiU = pa.x.max(pb.x).max(pc.x).toVar();
                      const hiV = pa.y.max(pb.y).max(pc.y).toVar();
                      Loop({ start: 0, end: 16, name: "covTexel" }, ({ covTexel }) => {
                        const cx = covTexel.mod(int(4)).toFloat().add(0.5).mul(0.25).toVar();
                        const cy = covTexel.div(int(4)).toFloat().add(0.5).mul(0.25).toVar();
                        const inAabb = cx.greaterThanEqual(loU.sub(texelHalf)).and(cx.lessThanEqual(hiU.add(texelHalf)))
                          .and(cy.greaterThanEqual(loV.sub(texelHalf))).and(cy.lessThanEqual(hiV.add(texelHalf)));
                        const edge = (p, q) => {
                          const ex = q.x.sub(p.x).toVar();
                          const ey = q.y.sub(p.y).toVar();
                          const value = ex.mul(cy.sub(p.y)).sub(ey.mul(cx.sub(p.x))).mul(orient);
                          const offset = ex.abs().add(ey.abs()).mul(texelHalf);
                          return value.greaterThanEqual(offset.negate());
                        };
                        const insideEdges = edge(pa, pb).and(edge(pb, pc)).and(edge(pc, pa));
                        const covered = inAabb.and(degenerate.or(insideEdges));
                        mask.assign(bitOr(mask, select(covered, shiftLeft(uint(1), covTexel.toUint()), uint(0))));
                      });
                      atomicOr(surfScratch.element(sBase.add(uint(7 + axis))), mask.toInt());
                    }
                  });
                });
              });
            });
          });
        });
      })().compute(Math.max(1, pairCount))
    : null;

  /**
   * Finalize: classify each record simple vs complex and pack the four-word
   * SurfaceRecord into the bits tail. Unallocated records stay all-zero — the
   * tracer reads a missing SIMPLE/COMPLEX flag as occupied-box fallback, so
   * classification can never turn into a miss.
   *
   * With Phase 4 on, a record that failed the simple fit reserves a triangle
   * range in the same allocation (word 2 = packComplexRange, flags = COMPLEX,
   * coverage-valid 0) and the write pass below fills it. The outer gate is
   * `weight > 0` ALONE: a cell whose face normals cancel (opposing faces, the
   * thin-wall case Phase 4 exists for) has `sumLen ≈ 0`, so gating the whole
   * body on the normal would have hidden exactly those cells from the complex
   * path.
   */
  // `complex` targets one slice of the triangle pool: null disables complex
  // reservation entirely; otherwise {cursor, overflow} name the surfAlloc
  // words and {poolBase, poolCapacity} the slice — the static finalize claims
  // [0, complexTriangleCapacity), the dynamic one the tail after it, and the
  // packed range carries the ABSOLUTE pool offset so the write pass and the
  // tracer need no per-slice arithmetic.
  const makeSurfFinalizeCompute = (baseRecord, recordCount, complex) => Fn(() => {
        const record = baseRecord === 0
          ? instanceIndex.toVar()
          : instanceIndex.add(uint(baseRecord)).toVar();
        const sBase = record.mul(uint(SURFACE_SCRATCH_WORDS)).toVar();
        const rBase = uint(surfaceWordOffset).add(record.mul(uint(SURFACE_RECORD_WORDS))).toVar();
        const inv = float(1 / SURFACE_FIT_SCALE);
        const sumX = atomicLoad(surfScratch.element(sBase)).toFloat().mul(inv).toVar();
        const sumY = atomicLoad(surfScratch.element(sBase.add(uint(1)))).toFloat().mul(inv).toVar();
        const sumZ = atomicLoad(surfScratch.element(sBase.add(uint(2)))).toFloat().mul(inv).toVar();
        const weight = atomicLoad(surfScratch.element(sBase.add(uint(3)))).toFloat().mul(inv).toVar();
        const sumD = atomicLoad(surfScratch.element(sBase.add(uint(4)))).toFloat().mul(inv).toVar();
        const sumD2 = atomicLoad(surfScratch.element(sBase.add(uint(5)))).toFloat().mul(inv).toVar();
        const count = atomicLoad(surfScratch.element(sBase.add(uint(6)))).toVar();
        const covX = atomicLoad(surfScratch.element(sBase.add(uint(7)))).toVar();
        const covY = atomicLoad(surfScratch.element(sBase.add(uint(8)))).toVar();
        const covZ = atomicLoad(surfScratch.element(sBase.add(uint(9)))).toVar();

        const packedNormal = uint(0).toVar();
        const packedPlane = uint(0).toVar();
        const packedMaterial = uint(0).toVar();
        const packedFlags = uint(0).toVar();
        const simpleTaken = float(0).toVar();
        const sumLen = vec3(sumX, sumY, sumZ).length().toVar();
        If(weight.greaterThan(0), () => {
          If(sumLen.greaterThan(1e-6), () => {
            const nHat = vec3(sumX, sumY, sumZ).div(sumLen).toVar();
            const coherence = sumLen.div(weight).toVar();
            const dHat = sumD.div(weight).toVar();
            const sigma = sumD2.div(weight).sub(dHat.mul(dHat)).max(0).sqrt().toVar();
            const cornerRadius = nHat.abs().dot(vec3(0.5));
            const centerProjection = nHat.dot(vec3(0.5));
            const planeInCell = dHat.sub(centerProjection).abs()
              .lessThanEqual(cornerRadius.add(SIMPLE_PLANE_IN_CELL_EPSILON));
            const simple = count.lessThanEqual(int(SIMPLE_MAX_TRIANGLES))
              .and(coherence.greaterThanEqual(SIMPLE_MIN_COHERENCE))
              .and(sigma.lessThanEqual(SIMPLE_MAX_PLANE_SIGMA))
              .and(planeInCell);
            If(simple, () => {
              const ax = nHat.x.abs().toVar();
              const ay = nHat.y.abs().toVar();
              const az = nHat.z.abs().toVar();
              // Same tie-break as RayHitPacking.dominantAxis: X, then Y.
              const axis = select(
                ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az)),
                uint(0),
                select(ay.greaterThanEqual(az), uint(1), uint(2)),
              ).toVar();
              const raw = bitAnd(
                select(axis.equal(uint(0)), covX, select(axis.equal(uint(1)), covY, covZ)).toUint(),
                uint(0xffff),
              ).toVar();
              // The RAW mask is what gets PACKED. Dilation moved to TEST time:
              // the gather still tests the one-texel-dilated mask (a false
              // miss there CONTINUES the march = a light leak through the
              // wall, so it must stay conservative), but the SHADOW variant
              // tests the raw mask — a fit-time-dilated mask is full or
              // near-full for most boundary cells (conservative rasterization
              // already fattens by the Minkowski radius), which made every
              // plane accept span its whole cell and quantized shadow
              // silhouettes to FULL VOXELS (the kind-map-proven class).
              packedNormal.assign(packSnorm2x16(octEncodeTSL(nHat)));
              const offset16 = bitAnd(
                packSnorm2x16(vec2(dHat.div(CELL_LOCAL_PLANE_OFFSET_RANGE).clamp(-1, 1), 0)),
                uint(0xffff),
              );
              const coverageByte = countOneBits(raw).mul(uint(255)).div(uint(16)).min(uint(255));
              const confidenceByte = coherence.mul(255).clamp(0, 255).toUint();
              packedPlane.assign(bitOr(offset16, bitOr(
                shiftLeft(coverageByte, uint(16)),
                shiftLeft(confidenceByte, uint(24)),
              )));
              packedFlags.assign(bitOr(raw, bitOr(
                shiftLeft(axis, uint(16)),
                bitOr(
                  shiftLeft(uint(1), uint(COVERAGE_VALID_SHIFT)),
                  shiftLeft(uint(SURFACE_FLAG_SIMPLE), uint(COVERAGE_FLAGS_SHIFT)),
                ),
              )));
              simpleTaken.assign(1);
            });
          });
          if (complex) {
            // Reserve, never write: the pool cursor is claimed here so the
            // range is known before the geometry pass runs, and word 6 (the
            // overlap count this thread just read) is reset to 0 so that pass
            // can reuse it as this record's write cursor. Same thread, so the
            // load/store pair cannot race its own reset.
            If(simpleTaken.lessThan(0.5).and(count.greaterThan(int(0))), () => {
              If(count.lessThanEqual(int(MAX_COMPLEX_TRIANGLES)), () => {
                const triCount = count.toUint().toVar();
                const base = atomicAdd(surfAlloc.element(complex.cursor), triCount).toVar();
                If(base.add(triCount).lessThanEqual(uint(complex.poolCapacity)), () => {
                  packedMaterial.assign(bitOr(
                    bitAnd(uint(complex.poolBase).add(base), uint(COMPLEX_RANGE_OFFSET_MASK)),
                    shiftLeft(triCount, uint(COMPLEX_RANGE_COUNT_SHIFT)),
                  ));
                  packedFlags.assign(shiftLeft(uint(SURFACE_FLAG_COMPLEX), uint(COVERAGE_FLAGS_SHIFT)));
                  atomicStore(surfScratch.element(sBase.add(uint(6))), int(0));
                }).Else(() => {
                  // Pool exhausted → the record stays zero, i.e. occupied box.
                  atomicAdd(surfAlloc.element(complex.overflow), uint(1));
                });
              }).Else(() => {
                // More triangles than the packed count field can address —
                // counted as an overflow cell like the CPU mirror does, so the
                // two report the same "how many cells fell back" number.
                atomicAdd(surfAlloc.element(complex.overflow), uint(1));
              });
            });
          }
        });
        bits.element(rBase).assign(packedNormal);
        bits.element(rBase.add(uint(1))).assign(packedPlane);
        bits.element(rBase.add(uint(2))).assign(packedMaterial);
        bits.element(rBase.add(uint(3))).assign(packedFlags);
      })().compute(recordCount);
  const surfFinalizeCompute = surfaceEnabled
    ? makeSurfFinalizeCompute(0, surfaceCapacity, complexEnabled
        ? { cursor: 2, overflow: 3, poolBase: 0, poolCapacity: complexTriangleCapacity }
        : null)
    : null;
  // Dynamic-tail finalize: same classification. In exact mode a dynamic
  // record that fails the simple fit reserves a range in the DYNAMIC slice of
  // the triangle pool (per-chain cursor, same one-dispatch lifetime as the
  // records) — a mover's silhouette cells are edge cells, so without this
  // every rotated mover's shadow outline stayed voxel-box. Without a pool
  // (plane modes) the failed fit stays zero = box.
  const dynSurfFinalizeCompute = surfaceEnabled
    ? makeSurfFinalizeCompute(surfaceCapacity, dynamicSurfaceCapacity, complexEnabled
        ? { cursor: 6, overflow: 7, poolBase: complexTriangleCapacity, poolCapacity: dynamicComplexTriangleCapacity }
        : null)
    : null;

  /**
   * Phase-4 geometry pass: fills every reserved triangle range with the
   * CELL-LOCAL vertices of the triangles that overlap that cell, f32-bitcast,
   * 9 words each. Structurally the accumulate pass — same slot filter, same
   * degenerate-triangle rejection, same SAT and chunk loop — because the
   * two must agree EXACTLY on which (triangle, cell) pairs exist: finalize
   * sized the range from the accumulate pass's overlap count, so a pair that
   * only one pass admits would either overrun the range or leave a stale
   * triangle in it, and a short list reads as an exact MISS (the ray keeps
   * marching) rather than a conservative hit.
   *
   * `filter` mirrors buildSurfAccumCompute's: the "dynamic" variant fills the
   * dynamic tail's ranges each chain (ranges carry ABSOLUTE pool offsets, so
   * the write arithmetic is identical — only the slot gate, the offset word
   * and the record bound differ).
   *
   * A BUILDER like buildSurfAccumCompute: it closes over the geometry buffers.
   */
  const buildComplexWriteCompute = complexEnabled
    ? (filter = "static") => Fn(() => {
        const slot = pairSlot.element(instanceIndex).toVar();
        const want = filter === "dynamic" ? 1 : 0;
        If(slotDynamic.element(slot.toInt()).notEqual(float(want)), () => {
          Return();
        });
        const tri = pairTri.element(instanceIndex).toVar();
        const chunk = pairChunk.element(instanceIndex).toVar();

        const base = tri.mul(uint(3)).toVar();
        const i0 = indexBuffer.element(base).toVar();
        const i1 = indexBuffer.element(base.add(uint(1))).toVar();
        const i2 = indexBuffer.element(base.add(uint(2))).toVar();
        const m = localToWorld.element(slot.toInt()).toVar();
        const toVox = (i) => m.mul(vec4(vertexBuffer.element(i).xyz, 1)).xyz
          .sub(vec3(gridOrigin)).mul(vec3(voxelInv));
        const p0 = toVox(i0).toVar();
        const p1 = toVox(i1).toVar();
        const p2 = toVox(i2).toVar();

        // The accumulate pass drops degenerates before counting, so this one
        // must drop them before claiming a cursor.
        const nRaw = p1.sub(p0).cross(p2.sub(p0)).toVar();
        If(nRaw.length().lessThanEqual(1e-12), () => {
          Return();
        });

        const lo = p0.min(p1).min(p2).sub(0.5).floor().max(vec3(0)).toVar();
        const hi = p0.max(p1).max(p2).add(0.5).floor()
          .min(vec3(level0.res.x - 1, level0.res.y - 1, level0.res.z - 1)).toVar();

        If(hi.x.greaterThanEqual(lo.x).and(hi.y.greaterThanEqual(lo.y)).and(hi.z.greaterThanEqual(lo.z)), () => {
          const nx = hi.x.sub(lo.x).add(1).toVar();
          const ny = hi.y.sub(lo.y).add(1).toVar();
          const nz = hi.z.sub(lo.z).add(1).toVar();
          const total = nx.mul(ny).mul(nz).toVar();
          const start = chunk.toFloat().mul(CHUNK_VOXELS).toVar();
          const h = vec3(0.5 + 1e-4).toVar();

          Loop({ start: 0, end: CHUNK_VOXELS, name: "cplxVox" }, ({ cplxVox }) => {
            const k = start.add(cplxVox.toFloat()).toVar();
            If(k.greaterThanEqual(total), () => {
              Break();
            });
            const vx = lo.x.add(mod(k, nx)).toVar();
            const vy = lo.y.add(mod(floor(k.div(nx)), ny)).toVar();
            const vz = lo.z.add(floor(k.div(nx.mul(ny)))).toVar();

            If(triBoxOverlap(vec3(vx.add(0.5), vy.add(0.5), vz.add(0.5)), h, p0, p1, p2).greaterThan(0.5), () => {
              const mxq = vx.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const myq = vy.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const mzq = vz.div(BRICK_RESOLUTION).floor().toUint().toVar();
              const macroIndex = mzq.mul(uint(hybridLayout.macroResolution.y)).add(myq)
                .mul(uint(hybridLayout.macroResolution.x)).add(mxq).toVar();
              const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                .add(macroIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
              const offsetWord = filter === "dynamic"
                ? BRICK_DYNAMIC_OFFSET_WORD
                : BRICK_SURFACE_OFFSET_WORD;
              const surfOffset = bits.element(brickBase.add(uint(offsetWord))).toVar();
              If(surfOffset.notEqual(uint(INVALID_RAY_HIT_INDEX)), () => {
                const low = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD))).toVar();
                const high = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD))).toVar();
                const lx = vx.toUint().bitAnd(uint(3));
                const ly = vy.toUint().bitAnd(uint(3));
                const lz = vz.toUint().bitAnd(uint(3));
                const bitIdx = lz.mul(uint(16)).add(ly.mul(uint(4))).add(lx).toVar();
                const inLow = bitIdx.lessThan(uint(32));
                const word = select(inLow, low, high).toVar();
                const bitSet = bitAnd(shiftRight(word, bitAnd(bitIdx, uint(31))), uint(1));
                If(bitSet.notEqual(uint(0)), () => {
                  const belowLow = select(inLow, shiftLeft(uint(1), bitAnd(bitIdx, uint(31))).sub(uint(1)), uint(0xffffffff));
                  const belowHigh = select(inLow, uint(0), shiftLeft(uint(1), bitAnd(bitIdx, uint(31))).sub(uint(1)));
                  const rank = countOneBits(bitAnd(low, belowLow)).add(countOneBits(bitAnd(high, belowHigh)));
                  const record = surfOffset.add(rank).toVar();
                  If(record.lessThan(uint(totalSurfaceCapacity)), () => {
                    const rBase = uint(surfaceWordOffset)
                      .add(record.mul(uint(SURFACE_RECORD_WORDS))).toVar();
                    const flagsWord = bits.element(rBase.add(uint(3))).toVar();
                    const isComplex = bitAnd(
                      shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                      uint(SURFACE_FLAG_COMPLEX),
                    );
                    If(isComplex.notEqual(uint(0)), () => {
                      const sBase = record.mul(uint(SURFACE_SCRATCH_WORDS)).toVar();
                      // .toVar() DIRECTLY on the atomic, then convert. A
                      // ConvertNode as the atomic's only consumer does not
                      // register as a value parent, so three emits the atomic
                      // as a bare statement and substitutes a DEFAULT 0 for
                      // the read ("TSL: Invalid generated code, expected an
                      // int") — every triangle then wrote pool slot 0 and the
                      // rest of each list read as exact misses, i.e. leaks.
                      const cursorRaw = atomicAdd(
                        surfScratch.element(sBase.add(uint(6))), int(1),
                      ).toVar();
                      const cursor = cursorRaw.toUint().toVar();
                      const range = bits.element(rBase.add(uint(2))).toVar();
                      const poolOffset = bitAnd(range, uint(COMPLEX_RANGE_OFFSET_MASK)).toVar();
                      const triCount = bitAnd(
                        shiftRight(range, uint(COMPLEX_RANGE_COUNT_SHIFT)),
                        uint(COMPLEX_RANGE_COUNT_MASK),
                      ).toVar();
                      // The only bound needed: finalize refused any range whose
                      // end passed the pool capacity, so cursor < count keeps
                      // every word below the allocation.
                      If(cursor.lessThan(triCount), () => {
                        const cellOrigin = vec3(vx, vy, vz).toVar();
                        const w = uint(trianglePoolWordOffset).add(
                          poolOffset.add(cursor).mul(uint(COMPLEX_TRIANGLE_WORDS)),
                        ).toVar();
                        const a = p0.sub(cellOrigin).toVar();
                        const b = p1.sub(cellOrigin).toVar();
                        const c = p2.sub(cellOrigin).toVar();
                        bits.element(w).assign(floatBitsToUint(a.x));
                        bits.element(w.add(uint(1))).assign(floatBitsToUint(a.y));
                        bits.element(w.add(uint(2))).assign(floatBitsToUint(a.z));
                        bits.element(w.add(uint(3))).assign(floatBitsToUint(b.x));
                        bits.element(w.add(uint(4))).assign(floatBitsToUint(b.y));
                        bits.element(w.add(uint(5))).assign(floatBitsToUint(b.z));
                        bits.element(w.add(uint(6))).assign(floatBitsToUint(c.x));
                        bits.element(w.add(uint(7))).assign(floatBitsToUint(c.y));
                        bits.element(w.add(uint(8))).assign(floatBitsToUint(c.z));
                      });
                    });
                  });
                });
              });
            });
          });
        });
      })().compute(Math.max(1, pairCount))
    : null;

  // ═══════════════════════ SHADER: dynamic-tail record refit (EVERY chain)
  // Movers get fitted-plane records too. These passes run at the END of both
  // chains, after the final hybridBuild has landed the MERGED masks and the
  // DynamicBrick typing they allocate and rank against. The tail cursor
  // resets every dispatch — dynamic records live exactly one chain, so a
  // mover's records are refit at its new pose every frame it moves and there
  // is no staleness to invalidate. Cost scales with the DynamicBrick set
  // (the mover's own footprint), not the scene.

  /** Zero the dynamic tail's fit scratch and its allocator words
   *  [dynRecordNext, dynOverflowBricks, dynTriangleNext, dynComplexOverflow]. */
  const dynSurfClearCompute = surfaceEnabled
    ? Fn(() => {
        atomicStore(
          surfScratch.element(instanceIndex.add(uint(surfaceCapacity * SURFACE_SCRATCH_WORDS))),
          int(0),
        );
        If(instanceIndex.lessThan(uint(4)), () => {
          atomicStore(surfAlloc.element(instanceIndex.add(uint(4))), uint(0));
        });
      })().compute(dynamicSurfaceCapacity * SURFACE_SCRATCH_WORDS)
    : null;

  /**
   * One dynamic record per occupied voxel of every DynamicBrick, addressed by
   * the voxel's rank in the MERGED brick mask (static bits included: the
   * tracer ranks against the same merged mask, and a brick's static cells
   * simply finalize as unfitted → box fallback, never a miss). Writes the
   * brick's tail offset — or INVALID — into BRICK_DYNAMIC_OFFSET_WORD, which
   * every chain rewrites for every brick, so a brick that stopped being
   * dynamic can never serve a stale offset.
   */
  const dynSurfAllocCompute = surfaceEnabled
    ? Fn(() => {
        const macroIndex = instanceIndex.toVar();
        const metadata = bits.element(
          uint(hybridWordOffset).add(macroIndex.mul(uint(MACRO_CELL_WORDS))).add(uint(MACRO_CELL_METADATA_WORD)),
        ).toVar();
        const cellType = bitAnd(
          shiftRight(metadata, uint(MACRO_CELL_TYPE_SHIFT)),
          uint(MACRO_CELL_TYPE_MASK),
        ).toVar();
        const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
          .add(macroIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
        const offset = uint(INVALID_RAY_HIT_INDEX).toVar();
        If(cellType.equal(uint(MacroCellType.DynamicBrick)), () => {
          const low = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD))).toVar();
          const high = bits.element(brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD))).toVar();
          const count = countOneBits(low).add(countOneBits(high)).toVar();
          If(count.greaterThan(uint(0)), () => {
            const base = atomicAdd(surfAlloc.element(4), count).toVar();
            If(base.add(count).lessThanEqual(uint(dynamicSurfaceCapacity)), () => {
              offset.assign(uint(surfaceCapacity).add(base));
            }).Else(() => {
              atomicAdd(surfAlloc.element(5), uint(1));
            });
          });
        });
        bits.element(brickBase.add(uint(BRICK_DYNAMIC_OFFSET_WORD))).assign(offset);
      })().compute(hybridLayout.macroCellCount)
    : null;

  const traceBody = (origin, dir, tMin, tMax, steps, topLevel, penK = null, profile = false, penWidth = null) => {
    const inv = vec3(voxelInv).toVar();
    const q0 = vec3(origin).sub(vec3(gridOrigin)).mul(inv).toVar();
    const dq = vec3(dir).mul(inv).toVar();
    // Reciprocals once, with a SIGNED floor so an axis-parallel ray produces a
    // huge (never NaN, never negative) crossing distance on its degenerate axis
    // instead of poisoning the per-axis min.
    const safe = (c) => select(c.abs().lessThan(1e-8), select(c.lessThan(0), float(-1e-8), float(1e-8)), c);
    const rd = vec3(float(1).div(safe(dq.x)), float(1).div(safe(dq.y)), float(1).div(safe(dq.z))).toVar();
    // Which face of a voxel the ray leaves through, as 0/1 per axis.
    const face = vec3(
      select(dq.x.greaterThanEqual(0), float(1), float(0)),
      select(dq.y.greaterThanEqual(0), float(1), float(0)),
      select(dq.z.greaterThanEqual(0), float(1), float(0)),
    ).toVar();

    const t = float(tMin).toVar();
    const level = int(topLevel).toVar();
    const hit = float(0).toVar();
    const hitT = float(-1).toVar();
    const axis = float(-1).toVar(); // last crossed axis: 0/1/2, −1 = none yet
    // See the fail-closed clamp after the loop: set only where we KNOW why the
    // march stopped (reached tMax, left the volume, or hit a level-0 voxel).
    const resolved = float(0).toVar();
    const usedSteps = uint(0).toVar();
    // ── ANALYTIC PENUMBRA (opt-in, `penK`) ──────────────────────────────────
    // A binary hit/miss verdict makes light through an opening a coin flip
    // for every grazing ray — under a moving light that is the flicker, and
    // no temporal filter fixes a square wave. This accumulates the classic
    // cone-occlusion factor min(k · clearance / t) DURING the march: inside
    // an EMPTY level-L voxel, the ray's lateral clearance to the voxel's own
    // faces is a conservative lower bound on the distance to any geometry
    // (a triangle inside the voxel would have set its bit — the same proof
    // freeRadiusAtWorld rests on). It is continuous in both the ray origin
    // and direction, so a grazing ray fades smoothly toward 0 BEFORE the
    // binary hit flips — the flip itself then costs nothing visually.
    // Ignored near the origin (t < ~2 voxels): the march starts beside its
    // own surface, and the surface's neighbouring voxels would clamp every
    // ray at birth (the sphere-trace estimator's own-plane problem).
    const pen = float(1).toVar();
    const penGate = penK
      ? vec3(voxel).x.max(vec3(voxel).y).max(vec3(voxel).z).mul(2).toVar()
      : null;

    Loop({ start: 0, end: steps, name: "occDda" }, () => {
      usedSteps.addAssign(uint(1));
      If(t.greaterThanEqual(tMax), () => {
        resolved.assign(1);
        Break();
      });
      const q = q0.add(dq.mul(t)).toVar();
      // Volume exit, in level-0 voxel units — one comparison whatever the
      // current level is.
      If(
        q.x.lessThan(0).or(q.y.lessThan(0)).or(q.z.lessThan(0))
          .or(q.x.greaterThanEqual(level0.res.x))
          .or(q.y.greaterThanEqual(level0.res.y))
          .or(q.z.greaterThanEqual(level0.res.z)),
        () => {
          resolved.assign(1);
          Break();
        },
      );

      const scale = levelSelect(level, (l) => l.scale).toVar();
      const v = q.div(scale).floor().toVar();

      If(occupiedAt(v, level).greaterThan(0.5), () => {
        If(level.lessThanEqual(int(0)), () => {
          hit.assign(1);
          hitT.assign(t);
          resolved.assign(1);
          Break();
        });
        // Occupied parent → look closer. Deliberately no advance: the finer
        // voxel under this exact point is what the next iteration tests.
        level.assign(level.sub(int(1)));
      }).Else(() => {
        // Empty at this level → skip its whole extent. The boundary in level-0
        // units is (v + face) · 2^level.
        const bound = v.add(face).mul(scale).toVar();
        const tx = bound.x.sub(q.x).mul(rd.x).toVar();
        const ty = bound.y.sub(q.y).mul(rd.y).toVar();
        const tz = bound.z.sub(q.z).mul(rd.z).toVar();
        const tNext = tx.min(ty).min(tz).toVar();
        if (penK) {
          // Sampled at the SEGMENT MIDPOINT — never at `q`: the DDA lands
          // each step epsilon past the face it just crossed, so any
          // clearance measured AT `q` reads ~0 on the crossed axis for every
          // step of every ray, which zeroed the whole field's direct light
          // ("indirect gone completely black"). And the distance comes from
          // the NEAR-FIELD ORACLE, not this voxel's own faces: a face
          // between two EMPTY voxels bounds nothing, and counting it would
          // falsely dim every ray that runs near a grid plane in open space.
          // `freeRadiusAtWorld`'s 3×3×3 block is continuous by construction
          // and measures distance to actual set bits.
          // Only while the march is DESCENDED (level ≤ 1): those are the
          // steps that graze geometry — open-space strides at high levels
          // contribute ~1 anyway and would pay 27 fetches each for it.
          If(level.lessThanEqual(int(1)), () => {
            const tm = t.add(tNext.max(0).mul(0.5)).toVar();
            const qm = q0.add(dq.mul(tm));
            const pWorld = qm.mul(vec3(voxel)).add(vec3(gridOrigin));
            const d = freeRadiusAtWorld(pWorld, 0, true, null);
            // PENUMBRA RADIUS r(t) = max(t/k, penWidth) — the optional
            // `penWidth` (world units) BAND-LIMITS the cone: without it the
            // penumbra grows linearly with sample distance, so a near-razor
            // sun traced 10-60m through architecture reads centimeter
            // clearances at aperture edges and multiplies whole regions to
            // ~0 (the field's "GI collapses when the sun shines through the
            // roof slit", measured 2026-08-06: lit-strip cells 0.002 vs
            // 0.18 with shadows off while the CPU DDA proved the paths
            // CLEAR). With the floor, a razor sun (k→∞) degrades to a
            // fixed penWidth-wide antialias band around silhouettes —
            // full energy through any aperture wider than the band — and
            // an authored wide sun keeps its cone wherever t/k exceeds the
            // band. null (the default and every screen caller) compiles the
            // historical cone exactly.
            const rPen = penWidth == null
              ? tm.max(1e-4).div(float(penK))
              : tm.max(1e-4).div(float(penK)).max(float(penWidth));
            const cand = d.div(rPen).clamp(0, 1);
            // Gated: not before ~2 voxels of travel (the surface's own
            // neighbourhood must not clamp rays at birth) and not past tMax
            // (geometry behind a point light must not darken it).
            pen.assign(pen.min(select(tm.greaterThan(penGate).and(tm.lessThan(tMax)), cand, float(1))));
          });
        }
        axis.assign(select(tNext.equal(tx), float(0), select(tNext.equal(ty), float(1), float(2))));
        // A hair past the plane. Too small and the ray re-tests the voxel it
        // just left (the budget drains and the trace reads as a hole in the
        // geometry); too large and it can clear a level-0 voxel it should have
        // entered (a leak). 1e-4 voxel units is ~12µm at 0.125m voxels.
        t.addAssign(tNext.max(0).add(1e-4));
        // Climb one level and re-test. Safe unconditionally: a coarser voxel
        // is the OR of its children, so if it reads empty the fine ones are
        // too. This is what keeps open space at ~2m strides.
        level.assign(level.add(int(1)).min(int(topLevel)));
      });
    });

    // FAIL CLOSED ON STEP EXHAUSTION — BUT ONLY FROM DOWN IN THE FINE LEVELS.
    //
    // Falling out of the loop leaves `hit = 0 / t = -1`, which every caller
    // reads as "nothing blocked this ray", so a transport ray that merely ran
    // out of iterations becomes a hole in the geometry. Which rays run out is a
    // function of how much geometry they graze, so it leaks worst exactly where
    // the DDA descends most — a light raking along a floor or wall.
    //
    // BUT AN UNCONDITIONAL CLAMP IS WORSE THAN THE LEAK. A ray can also run out
    // because the volume is simply longer than `budget × stride`, and those
    // rays exhaust in OPEN SPACE where "blocked" is the wrong answer. Calling
    // them hits walls the whole field off from its own light.
    //
    // The DDA's own `level` is the discriminator, for free: a ray crossing open
    // space sits at the top level taking 2 m strides, while one threading
    // geometry has descended. Exhausting at a fine level means the march was
    // inside detail and probably blocked; exhausting at a coarse level means it
    // simply ran out of road.
    // `level <= 0`, not `<= 1`: this is a BINARY per-ray verdict, so every ray
    // it catches is a potential flickering pixel under a moving light. Level 0
    // is the narrowest honest reading of "the march was inside detail when it
    // gave up" and it fires on far fewer rays than level 1 did.
    // `__giNoFailClosed` disables BOTH this and the shadow trace's clamp, so a
    // single flag answers "is the flicker something I introduced?" in one test.
    if (!globalThis.__giNoFailClosed) {
      const ranOutInDetail = resolved.lessThan(0.5).and(level.lessThanEqual(int(0)));
      hit.assign(select(ranOutInDetail, float(1), hit));
      hitT.assign(select(ranOutInDetail, t, hitT));
    }

    if (rayHitDebug && profile) {
      // WGSL NaN test without another helper/binding: NaN is the only float
      // that is not equal to itself. Count it before it can reach lighting.
      const invalid = t.notEqual(t).or(hitT.notEqual(hitT));
      rayHitDebug.recordTrace({ hit, resolved, steps: usedSteps, invalid });
    }

    return vec4(hit, hitT, axis, pen);
  };

  // ONE WGSL FUNCTION PER SHADER PER (steps, topLevel) VARIANT. The DDA body
  // is several kB of WGSL per expansion and the feedback kernel stamps it once
  // per analytic light slot — see freeRadiusAtWorld's note for why these
  // helpers are laid-out functions now. The struct return can't cross a
  // layout boundary, so the fn returns vec4(hit, t, axis, 0) and this wrapper
  // reconstructs what callers actually consume:
  //   normal — the crossed voxel FACE normal, from `axis` + the ray's per-axis
  //            sign (exactly the DDA's own formula, hoisted out of the body);
  //            axis < 0 (a hit in the very first voxel) falls back to −dir —
  //            the caller is inside geometry there anyway.
  //   voxel  — level-0 integer coords of the hit: floor(q0 + dq·t), the same
  //            expression the body used to store at the hit.
  const traceVariants = new Map();
  const traceOccupancy = (origin, dir, tMin, tMax, opts = {}) => {
    const steps = Math.max(16, opts.steps ?? traceSteps);
    const topLevel = Math.min(OCC_LEVELS - 1, Math.max(0, opts.topLevel ?? OCC_LEVELS - 1));
    // `penumbraK` (a float node, usually uniform-derived): enables the
    // analytic cone-occlusion accumulator (see traceBody's penumbra note) and
    // returns it as `.pen` — 1 = clear, →0 as the ray grazes geometry.
    const penumbra = opts.penumbraK != null;
    // Optional band-limit width (world units, may be a node — see traceBody's
    // rPen note). A variant key + extra input, so screen callers keep their
    // exact historical WGSL.
    const penWidth = penumbra && opts.penWidth != null ? opts.penWidth : null;
    // Profiling is a graph variant: only cascade transport rays bind the
    // counter buffer. Shadow/AO callers must not inherit an otherwise-unused
    // storage binding into already dense composed kernels.
    const profile = rayHitDebug != null && opts.profile === true;
    const key = `${steps}|${topLevel}|${penumbra ? 1 : 0}|${profile ? 1 : 0}|${penWidth != null ? 1 : 0}`;
    let fn = traceVariants.get(key);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giOccTrace${steps}_${topLevel}${penumbra ? "p" : ""}${penWidth != null ? "w" : ""}`,
        type: "vec4",
        inputs: [
          { name: "origin", type: "vec3" },
          { name: "dir", type: "vec3" },
          { name: "tMin", type: "float" },
          { name: "tMax", type: "float" },
          ...(penumbra ? [{ name: "penK", type: "float" }] : []),
          ...(penWidth != null ? [{ name: "penW", type: "float" }] : []),
        ],
        body: penWidth != null
          ? (o, d, t0, t1, k, w) => traceBody(o, d, t0, t1, steps, topLevel, k, profile, w)
          : penumbra
            ? (o, d, t0, t1, k) => traceBody(o, d, t0, t1, steps, topLevel, k, profile)
            : (o, d, t0, t1) => traceBody(o, d, t0, t1, steps, topLevel, null, profile),
      });
      traceVariants.set(key, fn);
    }
    const packed = penWidth != null
      ? fn(vec3(origin), vec3(dir), float(tMin), float(tMax), float(opts.penumbraK), float(penWidth)).toVar()
      : penumbra
        ? fn(vec3(origin), vec3(dir), float(tMin), float(tMax), float(opts.penumbraK)).toVar()
        : fn(vec3(origin), vec3(dir), float(tMin), float(tMax)).toVar();
    const hit = packed.x;
    const hitT = packed.y;
    const axis = packed.z;
    const dq = vec3(dir).mul(vec3(voxelInv)).toVar();
    const stepSign = vec3(dq.x.sign(), dq.y.sign(), dq.z.sign());
    const normal = select(
      axis.lessThan(0),
      vec3(dir).negate().normalize(),
      vec3(
        select(axis.equal(0), stepSign.x.negate(), float(0)),
        select(axis.equal(1), stepSign.y.negate(), float(0)),
        select(axis.equal(2), stepSign.z.negate(), float(0)),
      ),
    ).toVar();
    const q0 = vec3(origin).sub(vec3(gridOrigin)).mul(vec3(voxelInv));
    const voxelAtHit = q0.add(dq.mul(hitT)).floor();
    return { hit, t: hitT, normal, voxel: voxelAtHit, pen: packed.w };
  };

  // ═══════════════════════════════════════════════════ SHADER: cone density
  /** `levelSelect` for the density region (levels 1..4 only). */
  const densityLevelSelect = (level, pick) => {
    const dl = densityPlan.densityLevels;
    let node = float(pick(dl[dl.length - 1]));
    for (let i = dl.length - 2; i >= 0; i--) {
      node = select(level.equal(int(dl[i].level)), float(pick(dl[i])), node);
    }
    return node;
  };

  /**
   * Occupancy FRACTION (0..1) of the cell at integer coords `v` on `level`.
   * Level 0 is the bit itself; levels 1..4 read the density pyramid's byte.
   * Out-of-range reads 0, like `occupiedAt`. Laid out as one WGSL function:
   * the cone marcher's trilinear sampler calls it 8× per step.
   */
  const densityCellAt = sharedFn({
    name: "giOccDensityCell",
    type: "float",
    inputs: [
      { name: "v", type: "vec3" },
      { name: "levelF", type: "float" },
    ],
    body: (v, levelF) => {
      const level = levelF.round().toInt().toVar();
      const rx = densityLevelSelect(level, (l) => l.res.x).toVar();
      const ry = densityLevelSelect(level, (l) => l.res.y).toVar();
      const rz = densityLevelSelect(level, (l) => l.res.z).toVar();
      const off = densityLevelSelect(level, (l) => l.offset).toVar();
      const inside = v.x.greaterThanEqual(0).and(v.y.greaterThanEqual(0)).and(v.z.greaterThanEqual(0))
        .and(v.x.lessThan(rx)).and(v.y.lessThan(ry)).and(v.z.lessThan(rz));
      const xi = v.x.max(0).min(rx.sub(1)).toUint().toVar();
      const yi = v.y.max(0).min(ry.sub(1)).toUint().toVar();
      const zi = v.z.max(0).min(rz.sub(1)).toUint().toVar();
      const cIdx = zi.mul(ry.toUint()).add(yi).mul(rx.toUint()).add(xi).toVar();
      const word = uint(densityWordOffset).add(off.toUint()).add(shiftRight(cIdx, uint(2)));
      const byte = bitAnd(shiftRight(bits.element(word), shiftLeft(bitAnd(cIdx, uint(3)), uint(3))), uint(255));
      const frac = select(inside, byte.toFloat().div(255), float(0));
      return select(level.lessThanEqual(int(0)), occupiedAtLevel0(v), frac);
    },
  });

  /**
   * Trilinear occupancy fraction at LEVEL-0-space point `q`, sampled on
   * `level`'s cell lattice. Continuity is load-bearing: the cone marcher's
   * per-step opacity comes from here, and nearest-cell sampling would put the
   * cell lattice back into the penumbra as visible onion rings.
   */
  const densityTrilinear = sharedFn({
    name: "giOccDensityTri",
    type: "float",
    inputs: [
      { name: "q", type: "vec3" },
      { name: "levelF", type: "float" },
    ],
    body: (q, levelF) => {
      const scale = exp2(levelF.round()).toVar();
      const c = q.div(scale).sub(0.5).toVar();
      const b = c.floor().toVar();
      const f = c.sub(b).toVar();
      const corner = (dx, dy, dz) => densityCellAt(b.add(vec3(dx, dy, dz)), levelF);
      const d00 = mix(corner(0, 0, 0), corner(1, 0, 0), f.x).toVar();
      const d10 = mix(corner(0, 1, 0), corner(1, 1, 0), f.x).toVar();
      const d01 = mix(corner(0, 0, 1), corner(1, 0, 1), f.x).toVar();
      const d11 = mix(corner(0, 1, 1), corner(1, 1, 1), f.x).toVar();
      return mix(mix(d00, d10, f.y), mix(d01, d11, f.y), f.z);
    },
  });

  // ══════════════════════════════════════════════════ SHADER: cone-DDA trace
  /**
   * SOFT SHADOW CONE MARCH — area-light visibility computed IN the trace, not
   * faked after it. The screen-space PCSS pass this replaces blurred a
   * single-ray binary verdict, and no filter can recover partial-sun
   * visibility that was never computed — at Blender-style wide sun angles
   * (a 90° authored angle = 45° half-angle) the penumbra spans meters and the
   * blur read as ghosted blobs (user-rejected, twice).
   *
   * Structure = the hierarchical DDA (`traceBody`) with two changes:
   *   · the LEAF level follows the cone footprint — at distance t the cone's
   *     radius is tanHalf·t, and the march never descends below the level
   *     whose cells that radius spans. Empty space above the leaf skips
   *     hierarchically exactly as before, so the step budget stays bounded
   *     at ANY angle (the wider the cone, the coarser and CHEAPER the march).
   *   · an occupied LEAF cell accumulates fractional opacity from the density
   *     pyramid instead of returning a binary hit — transmittance falls
   *     smoothly, which IS the penumbra. Softness costs nothing downstream.
   *
   * `boost` compensates the volume-fraction/projected-coverage gap for thin
   * occluders (a wall spanning a coarse cell blocks every ray through it but
   * fills ~1/8 of its volume). 0° degenerates cleanly: the caller's tSwitch
   * goes past tMax and this trace never runs a step.
   *
   * Returns transmittance 0..1 (0 = fully blocked). Step exhaustion fails
   * SOFT (returns what accumulated) — this channel is never a binary verdict,
   * so the fail-closed discriminator the binary DDA needs has nothing to
   * protect here.
   */
  const coneTraceVariants = new Map();
  const traceOccupancyCone = (origin, dir, tMin, tMax, opts = {}) => {
    const steps = Math.max(16, opts.steps ?? 96);
    let fn = coneTraceVariants.get(steps);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giOccConeTrace${steps}`,
        type: "float",
        inputs: [
          { name: "origin", type: "vec3" },
          { name: "dir", type: "vec3" },
          { name: "tMin", type: "float" },
          { name: "tMax", type: "float" },
          { name: "tanHalf", type: "float" },
          { name: "boost", type: "float" },
          { name: "recvP", type: "vec3" },
          { name: "recvN", type: "vec3" },
          { name: "jitter", type: "float" },
          { name: "jitter2", type: "float" },
        ],
        body: (o, d, t0, t1, tanH, boost, recvP, recvN, jitter, jitter2) => {
          const inv = vec3(voxelInv).toVar();
          const q0 = vec3(o).sub(vec3(gridOrigin)).mul(inv).toVar();
          const dq = vec3(d).mul(inv).toVar();
          const safe = (c) => select(c.abs().lessThan(1e-8), select(c.lessThan(0), float(-1e-8), float(1e-8)), c);
          const rd = vec3(float(1).div(safe(dq.x)), float(1).div(safe(dq.y)), float(1).div(safe(dq.z))).toVar();
          const face = vec3(
            select(dq.x.greaterThanEqual(0), float(1), float(0)),
            select(dq.y.greaterThanEqual(0), float(1), float(0)),
            select(dq.z.greaterThanEqual(0), float(1), float(0)),
          ).toVar();
          const voxMinW = vec3(voxel).x.min(vec3(voxel).y).min(vec3(voxel).z).toVar();
          // PER-PIXEL SUN-DISC DIRECTION SAMPLE — the lattice decorrelator,
          // v2. v1 offset the ray ORIGIN laterally by ±0.35 voxel, which (a)
          // pushed grazing origins into the receiver's own bulged surface
          // voxels — the IGN pattern printed straight onto LIT faces as a
          // diagonal crosshatch (user's cube screenshot) — and (b) was far
          // too small to decorrelate the level-3/4 cells that actually
          // stripe at wide angles. Jittering the DIRECTION inside the sun's
          // disc fixes both: the origin never moves, the offset grows with
          // distance exactly as the footprint does (so it decorrelates at
          // EVERY level), and it is physically the ground truth — each pixel
          // samples one point on the sun, the ensemble across neighbouring
          // pixels integrates the disc, and the bilateral upsample is the
          // averager. Each ray then carries HALF the cone footprint (the
          // ensemble covers the rest), which sharpens per-ray detail.
          // 0° degenerates exactly: rr = 0, jd = d.
          const upRef = select(d.y.abs().lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
          const s1 = vec3(d).cross(upRef).normalize().toVar();
          const s2 = vec3(d).cross(s1).toVar();
          const ang = jitter.mul(Math.PI * 2).toVar();
          const rr = jitter2.sqrt().mul(tanH).toVar();
          const jd = vec3(d).add(s1.mul(ang.cos()).add(s2.mul(ang.sin())).mul(rr)).normalize().toVar();
          dq.assign(jd.mul(inv));
          const rdj = vec3(float(1).div(safe(dq.x)), float(1).div(safe(dq.y)), float(1).div(safe(dq.z))).toVar();
          rd.assign(rdj);
          face.assign(vec3(
            select(dq.x.greaterThanEqual(0), float(1), float(0)),
            select(dq.y.greaterThanEqual(0), float(1), float(0)),
            select(dq.z.greaterThanEqual(0), float(1), float(0)),
          ));
          const effTan = tanH.mul(0.5).toVar();
          const t = float(t0).max(0).add(jitter.mul(voxMinW.mul(0.5))).toVar();
          const alpha = float(0).toVar();
          const level = int(OCC_LEVELS - 1).toVar();
          // See the fail-dark clamp after the loop.
          const resolved = float(0).toVar();
          const lastLeaf = int(0).toVar();

          Loop({ start: 0, end: steps, name: "coneDda" }, () => {
            If(t.greaterThanEqual(t1).or(alpha.greaterThanEqual(0.98)), () => {
              resolved.assign(1);
              Break();
            });
            const q = q0.add(dq.mul(t)).toVar();
            If(
              q.x.lessThan(0).or(q.y.lessThan(0)).or(q.z.lessThan(0))
                .or(q.x.greaterThanEqual(level0.res.x))
                .or(q.y.greaterThanEqual(level0.res.y))
                .or(q.z.greaterThanEqual(level0.res.z)),
              () => {
                resolved.assign(1);
                Break();
              },
            );
            // Footprint leaf: the level whose cells the cone's diameter spans.
            // `leafC` stays CONTINUOUS — the density sample blends the two
            // straddling levels by its fraction, so the blur width grows
            // smoothly along the ray instead of doubling at each level
            // boundary (discrete jumps read as onion rings in the penumbra).
            const leafC = log2(effTan.mul(t).mul(2).div(voxMinW).max(1)).clamp(0, OCC_LEVELS - 1).toVar();
            const leaf = leafC.floor().toInt().toVar();
            lastLeaf.assign(leaf);
            const lvl = level.max(leaf).toVar();
            const scale = levelSelect(lvl, (l) => l.scale).toVar();
            const v = q.div(scale).floor().toVar();
            const occ = occupiedAt(v, lvl).toVar();
            If(occ.greaterThan(0.5).and(lvl.greaterThan(leaf)), () => {
              // Occupied parent above the leaf → look closer, no advance.
              level.assign(lvl.sub(int(1)));
            }).Else(() => {
              const bound = v.add(face).mul(scale).toVar();
              const tx = bound.x.sub(q.x).mul(rd.x).toVar();
              const ty = bound.y.sub(q.y).mul(rd.y).toVar();
              const tz = bound.z.sub(q.z).mul(rd.z).toVar();
              const tNext = tx.min(ty).min(tz).max(0).toVar();
              If(occ.greaterThan(0.5), () => {
                // Occupied AT the leaf: integrate this cell's density over the
                // segment. Midpoint-sampled for the same reason the analytic
                // penumbra is — at the entry point the crossed-face coordinate
                // is degenerate for every step of every ray. Segment/cell
                // ratio scales a corner graze down; the buffer read inside an
                // If follows the penK precedent in traceBody.
                const tm = t.add(tNext.mul(0.5)).toVar();
                const qm = q0.add(dq.mul(tm)).toVar();
                const lNext = leaf.add(int(1)).min(int(OCC_LEVELS - 1)).toVar();
                const dens = mix(
                  densityTrilinear(qm, leaf.toFloat()),
                  densityTrilinear(qm, lNext.toFloat()),
                  leafC.sub(leafC.floor()),
                ).toVar();
                // Thin-occluder boost, COARSE LEVELS ONLY: a wall spanning a
                // coarse cell blocks every ray through it while filling ~1/8
                // of its volume, so coarse fractions under-block — but fine-
                // level fractions are already honest, and boosting them
                // saturated every partially-covered voxel into a hard blob
                // (the user's blotchy-floor screenshot).
                const boostEff = mix(float(1), boost, lvl.toFloat().div(OCC_LEVELS - 1)).toVar();
                // RECEIVER-PLANE EXCLUSION, the cone form of the exact arm's
                // origin-plane exclusion — the fix for cone self-shadowing
                // ("quite bad most of the time": blotchy floors, shadow-side
                // walls gone black). A plane cannot shadow itself, and under
                // a grazing sun the ray runs just above the receiver's OWN
                // surface slab for meters.
                //
                // HARD exclusion inside ~one sampled cell of the plane, not
                // the half-space-fraction soft factor tried first: the honest
                // "half the footprint is above the plane" still counted the
                // plane's own slab at half weight, and over a long grazing
                // run that residue compounded — modulated by the cell
                // lattice, projected along the sun azimuth — into long
                // light-aligned streak shadows that rotated with the light
                // (the user's second screenshot). A sample whose center sits
                // within a cell of the plane is plane-dominated by
                // construction (the plane's slab is the only geometry that
                // close); a real wall still blocks through its HIGHER cells,
                // whose distance to the plane is many cell widths. Cost of
                // the trade: sub-cell-tall clutter loses its long grazing
                // shadow at range, where it is penumbra-blurred anyway.
                // The denominator is the SAMPLED CELL's width — the trilinear
                // support that actually reaches down into the surface row —
                // not the cone radius.
                const pw = qm.mul(vec3(voxel)).add(vec3(gridOrigin)).toVar();
                const cellW = voxMinW.mul(exp2(lvl.toFloat())).toVar();
                const planeD = recvN.dot(pw.sub(recvP)).toVar();
                const above = smoothstep(cellW.mul(0.25), cellW, planeD).toVar();
                const op = dens.mul(boostEff).mul(above).mul(tNext.div(cellW).clamp(0, 1)).clamp(0, 1);
                alpha.assign(alpha.add(alpha.oneMinus().mul(op)));
              });
              t.addAssign(tNext.add(1e-4));
              level.assign(lvl.add(int(1)).min(int(OCC_LEVELS - 1)));
            });
          });
          // FAIL DARK FROM DOWN AT THE LEAF — the exact march's exhaustion
          // clamp, ported, with the discriminator RELATIVE TO THE CONE. The
          // first port compared against absolute level ≤ 1, which a wide
          // cone never revisits (its leaf is 2-4 within meters), so
          // wide-angle rays that burned their budget threading coarse
          // occupied cells still failed OPEN — the surviving white speckles
          // in the user's dark-side screenshot. "In detail" for a cone
          // means AT OR NEAR ITS OWN LEAF; open-road climbs sit levels
          // above it.
          If(resolved.lessThan(0.5).and(level.lessThanEqual(lastLeaf.add(int(1)))), () => {
            alpha.assign(1);
          });
          return alpha.oneMinus().clamp(0, 1);
        },
      });
      coneTraceVariants.set(steps, fn);
    }
    return fn(
      vec3(origin), vec3(dir), float(tMin), float(tMax),
      float(opts.tanHalf ?? 0), float(opts.boost ?? 3),
      vec3(opts.receiverP ?? origin), vec3(opts.receiverN ?? vec3(0, 0, 0)),
      float(opts.jitter ?? 0), float(opts.jitter2 ?? 0.5),
    );
  };

  /**
   * Phase-1 macrocell + 4^3 brick traversal. The only leaf predicate is the
   * level-0 occupancy bit copied into the brick mask, so hits retain legacy
   * occupied-cell-box semantics. Both loops have compile-time hard limits.
   */
  const hybridTraceVariants = new Map();
  const traceHybridBrick = hybridEnabled
    ? (origin, dir, tMin, tMax, opts = {}) => {
        const macroStepLimit = Math.min(
          MAX_MACRO_STEPS,
          Math.max(1, opts.macroSteps ?? MAX_MACRO_STEPS),
        );
        const profile = rayHitDebug != null && opts.profile === true;
        const key = `${macroStepLimit}|${profile ? 1 : 0}|${coarseSkipEnabled ? 1 : 0}`;
        let fn = hybridTraceVariants.get(key);
        if (fn === undefined) {
          fn = sharedFn({
            // Suffixed ONLY when the skip is off: the default arm has to keep
            // the exact WGSL function names it has always emitted, so an A/B
            // run is the only thing that ever renames a trace function.
            name: `giHybridBrickTrace${macroStepLimit}${coarseSkipEnabled ? "" : "s0"}`,
            type: "vec4",
            inputs: [
              { name: "origin", type: "vec3" },
              { name: "dir", type: "vec3" },
              { name: "tMin", type: "float" },
              { name: "tMax", type: "float" },
            ],
            body: (o, d, t0, t1) => {
              const inv = vec3(voxelInv).toVar();
              const q0 = vec3(o).sub(vec3(gridOrigin)).mul(inv).toVar();
              const dq = vec3(d).mul(inv).toVar();
              const safe = (c) => select(
                c.abs().lessThan(RAY_HIT_DIRECTION_EPSILON),
                select(c.lessThan(0), float(-RAY_HIT_DIRECTION_EPSILON), float(RAY_HIT_DIRECTION_EPSILON)),
                c,
              );
              const rd = vec3(
                float(1).div(safe(dq.x)),
                float(1).div(safe(dq.y)),
                float(1).div(safe(dq.z)),
              ).toVar();
              const face = vec3(
                select(dq.x.greaterThanEqual(0), float(1), float(0)),
                select(dq.y.greaterThanEqual(0), float(1), float(0)),
                select(dq.z.greaterThanEqual(0), float(1), float(0)),
              ).toVar();

              const t = float(t0).toVar();
              const hit = float(0).toVar();
              const hitT = float(-1).toVar();
              const axis = float(-1).toVar();
              const resolved = float(0).toVar();
              const invalidRef = float(0).toVar();
              const brickLimit = float(0).toVar();
              // Detail discriminator for the exhaustion clamp below: 1 while
              // the last processed macro cell carried a brick.
              const lastBrick = float(0).toVar();
              // Skip off starts AT the macro level, so the ride is not merely
              // predicated away — levels 3-4 are never read.
              const level = int(coarseSkipEnabled ? OCC_LEVELS - 1 : 2).toVar();
              const usedMacroSteps = uint(0).toVar();
              const usedBrickSteps = uint(0).toVar();
              // Phase-5 skip instrumentation, declared only in the enabled
              // variant so the A/B arm's WGSL stays free of coarse traffic.
              const usedCoarseSteps = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseSkipsL3 = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseSkipsL4 = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseDescends = coarseSkipEnabled ? uint(0).toVar() : null;

              Loop({ start: 0, end: macroStepLimit, name: "hybridMacroDda" }, () => {
                usedMacroSteps.addAssign(uint(1));
                If(t.greaterThanEqual(t1), () => {
                  resolved.assign(1);
                  Break();
                });

                const q = q0.add(dq.mul(t)).toVar();
                If(
                  q.x.lessThan(0).or(q.y.lessThan(0)).or(q.z.lessThan(0))
                    .or(q.x.greaterThanEqual(level0.res.x))
                    .or(q.y.greaterThanEqual(level0.res.y))
                    .or(q.z.greaterThanEqual(level0.res.z)),
                  () => {
                    resolved.assign(1);
                    Break();
                  },
                );

                // The macro+brick body is a JS closure so the coarse ride can
                // be compiled OUT rather than predicated away: an A/B arm that
                // still emits the level-3/4 reads measures the wrong thing.
                const macroBody = () => {
                const macro = q.div(float(BRICK_RESOLUTION)).floor().toVar();
                const mx = macro.x.toUint().toVar();
                const my = macro.y.toUint().toVar();
                const mz = macro.z.toUint().toVar();
                const macroIndex = mz.mul(uint(hybridLayout.macroResolution.y)).add(my)
                  .mul(uint(hybridLayout.macroResolution.x)).add(mx).toVar();
                const macroBase = uint(hybridWordOffset).add(
                  macroIndex.mul(uint(MACRO_CELL_WORDS)),
                ).toVar();
                const brickIndex = bits.element(
                  macroBase.add(uint(MACRO_CELL_BRICK_INDEX_WORD)),
                ).toVar();
                const metadata = bits.element(
                  macroBase.add(uint(MACRO_CELL_METADATA_WORD)),
                ).toVar();
                const cellType = bitAnd(
                  shiftRight(metadata, uint(MACRO_CELL_TYPE_SHIFT)),
                  uint(MACRO_CELL_TYPE_MASK),
                ).toVar();

                const macroBound = macro.add(face).mul(float(BRICK_RESOLUTION)).toVar();
                const tx = macroBound.x.sub(q.x).mul(rd.x).toVar();
                const ty = macroBound.y.sub(q.y).mul(rd.y).toVar();
                const tz = macroBound.z.sub(q.z).mul(rd.z).toVar();
                const macroDelta = tx.min(ty).min(tz).max(0).toVar();
                const macroExit = t.add(macroDelta).toVar();
                const macroAxis = select(
                  macroDelta.equal(tx),
                  float(0),
                  select(macroDelta.equal(ty), float(1), float(2)),
                ).toVar();

                If(cellType.equal(uint(MacroCellType.Brick)), () => {
                  lastBrick.assign(1);
                  const validBrick = brickIndex.lessThan(uint(hybridLayout.brickCount))
                    .and(brickIndex.notEqual(uint(INVALID_RAY_HIT_INDEX)));
                  If(validBrick.not(), () => {
                    invalidRef.assign(1);
                    Break();
                  });

                  const safeBrick = brickIndex.min(uint(hybridLayout.brickCount - 1));
                  const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                    .add(safeBrick.mul(uint(BRICK_HEADER_WORDS))).toVar();
                  const occupancyLow = bits.element(
                    brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD)),
                  ).toVar();
                  const occupancyHigh = bits.element(
                    brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD)),
                  ).toVar();
                  const localT = t.toVar();
                  const localResolved = float(0).toVar();
                  const localAxis = axis.toVar();
                  const segmentEnd = macroExit.min(t1).toVar();

                  Loop({ start: 0, end: MAX_BRICK_STEPS, name: "hybridBrickDda" }, () => {
                    If(localT.greaterThanEqual(segmentEnd.add(RAY_HIT_DDA_EPSILON)), () => {
                      localResolved.assign(1);
                      Break();
                    });
                    usedBrickSteps.addAssign(uint(1));
                    const localQ = q0.add(dq.mul(localT)).toVar();
                    const cell = localQ.floor().toVar();
                    const localCell = cell.sub(macro.mul(float(BRICK_RESOLUTION)))
                      .clamp(vec3(0), vec3(BRICK_RESOLUTION - 1)).toVar();
                    const cellIndex = localCell.z.toUint().mul(uint(16))
                      .add(localCell.y.toUint().mul(uint(4)))
                      .add(localCell.x.toUint()).toVar();
                    const occupancyWord = select(
                      cellIndex.lessThan(uint(32)),
                      occupancyLow,
                      occupancyHigh,
                    ).toVar();
                    const occupancyBit = bitAnd(
                      shiftRight(occupancyWord, bitAnd(cellIndex, uint(31))),
                      uint(1),
                    );
                    If(occupancyBit.notEqual(uint(0)), () => {
                      hit.assign(1);
                      hitT.assign(localT);
                      axis.assign(localAxis);
                      resolved.assign(1);
                      localResolved.assign(1);
                      Break();
                    });

                    const cellBound = cell.add(face).toVar();
                    const cx = cellBound.x.sub(localQ.x).mul(rd.x).toVar();
                    const cy = cellBound.y.sub(localQ.y).mul(rd.y).toVar();
                    const cz = cellBound.z.sub(localQ.z).mul(rd.z).toVar();
                    const cellDelta = cx.min(cy).min(cz).max(0).toVar();
                    localAxis.assign(select(
                      cellDelta.equal(cx),
                      float(0),
                      select(cellDelta.equal(cy), float(1), float(2)),
                    ));
                    localT.addAssign(cellDelta.add(RAY_HIT_DDA_EPSILON));
                  });

                  If(hit.greaterThan(0.5), () => {
                    Break();
                  });
                  If(localResolved.lessThan(0.5), () => {
                    brickLimit.assign(1);
                    Break();
                  });
                  axis.assign(localAxis);
                  t.assign(macroExit.add(RAY_HIT_DDA_EPSILON));
                  // The re-ascend only exists when the ride does; with the skip
                  // off `level` must stay pinned at the macro level forever.
                  if (coarseSkipEnabled) level.assign(int(3));
                }).Else(() => {
                  lastBrick.assign(0);
                  axis.assign(macroAxis);
                  t.assign(macroExit.add(RAY_HIT_DDA_EPSILON));
                  if (coarseSkipEnabled) level.assign(int(3));
                });
                };

                // Reuse the existing conservative pyramid above level 2.
                // Level 2 is exactly one 4^3 macrocell, so levels 3-4 provide
                // broad empty-space skips without changing Phase-1 leaf data.
                //
                // FUSED DESCEND: a descend spends no distance, so one that
                // lands AT the macro level runs macroBody in this SAME
                // iteration (the flag below). The old shape burned a whole
                // iteration per descend, so a ray hugging occupied geometry
                // paid TWO iterations per macro cell — grazing sun rays
                // exhausted the macro budget at half distance and failed open:
                // the white-dot class the skip-off A/B exposed.
                if (coarseSkipEnabled) {
                  const rideAdvanced = float(0).toVar();
                  If(level.greaterThan(int(2)), () => {
                    usedCoarseSteps.addAssign(uint(1));
                    const scale = levelSelect(level, (l) => l.scale).toVar();
                    const coarse = q.div(scale).floor().toVar();
                    If(occupiedAt(coarse, level).greaterThan(0.5), () => {
                      coarseDescends.addAssign(uint(1));
                      level.assign(level.sub(int(1)));
                    }).Else(() => {
                      const coarseBound = coarse.add(face).mul(scale).toVar();
                      const hx = coarseBound.x.sub(q.x).mul(rd.x).toVar();
                      const hy = coarseBound.y.sub(q.y).mul(rd.y).toVar();
                      const hz = coarseBound.z.sub(q.z).mul(rd.z).toVar();
                      const coarseDelta = hx.min(hy).min(hz).max(0).toVar();
                      axis.assign(select(
                        coarseDelta.equal(hx),
                        float(0),
                        select(coarseDelta.equal(hy), float(1), float(2)),
                      ));
                      t.addAssign(coarseDelta.add(RAY_HIT_DDA_EPSILON));
                      // Attributed BEFORE the re-ascend: the empty span belongs
                      // to the level that was empty, not the one climbed to.
                      coarseSkipsL3.addAssign(select(level.equal(int(3)), uint(1), uint(0)));
                      coarseSkipsL4.addAssign(select(level.greaterThan(int(3)), uint(1), uint(0)));
                      level.assign(level.add(int(1)).min(int(OCC_LEVELS - 1)));
                      rideAdvanced.assign(1);
                    });
                  });
                  If(rideAdvanced.lessThan(0.5).and(level.lessThanEqual(int(2))), macroBody);
                } else {
                  macroBody();
                }
              });

              // FAIL CLOSED ON EXHAUSTION FROM DETAIL — hybrid parity with the
              // legacy traceBody clamp (see its block comment). Both exhaustion
              // exits (macro budget, brick budget) used to leave hit = 0, which
              // callers read as "nothing blocked this ray"; when the march died
              // inside a brick that verdict is a hole in the geometry — at
              // grazing incidence, a white dot. `lastBrick` keeps genuinely
              // long OPEN-space rays failing open. Applied before recordTrace,
              // which still logs `resolved` raw, so limit counters stay honest.
              if (!globalThis.__giNoFailClosed) {
                If(resolved.lessThan(0.5).and(lastBrick.greaterThan(0.5)), () => {
                  hit.assign(1);
                  hitT.assign(t);
                });
              }

              if (rayHitDebug && profile) {
                const invalid = t.notEqual(t).or(hitT.notEqual(hitT)).or(invalidRef.greaterThan(0.5));
                const macroLimit = resolved.lessThan(0.5).and(brickLimit.lessThan(0.5));
                rayHitDebug.recordTrace({
                  hit,
                  resolved,
                  steps: usedMacroSteps,
                  brickSteps: usedBrickSteps,
                  macroLimit,
                  brickLimit,
                  invalid,
                  coarseSteps: usedCoarseSteps,
                  coarseSkipsL3,
                  coarseSkipsL4,
                  coarseDescends,
                });
              }

              // W keeps diagnostic counts without another buffer/output: the
              // integer part is macro steps and the fractional part is total
              // local-cell visits / 4096.
              return vec4(
                hit,
                hitT,
                axis,
                usedMacroSteps.toFloat().add(usedBrickSteps.toFloat().div(4096)),
              );
            },
          });
          hybridTraceVariants.set(key, fn);
        }

        const packed = fn(vec3(origin), vec3(dir), float(tMin), float(tMax)).toVar();
        const hit = packed.x;
        const hitT = packed.y;
        const axis = packed.z;
        const dq = vec3(dir).mul(vec3(voxelInv)).toVar();
        const stepSign = vec3(dq.x.sign(), dq.y.sign(), dq.z.sign());
        const normal = select(
          axis.lessThan(0),
          vec3(dir).negate().normalize(),
          vec3(
            select(axis.equal(0), stepSign.x.negate(), float(0)),
            select(axis.equal(1), stepSign.y.negate(), float(0)),
            select(axis.equal(2), stepSign.z.negate(), float(0)),
          ),
        ).toVar();
        const q0 = vec3(origin).sub(vec3(gridOrigin)).mul(vec3(voxelInv));
        const voxelAtHit = q0.add(dq.mul(hitT)).floor();
        return {
          hit,
          t: hitT,
          normal,
          voxel: voxelAtHit,
          macroSteps: floor(packed.w),
          brickSteps: mod(packed.w, 1).mul(4096).round(),
        };
      }
    : null;

  /**
   * Phase-2/3 traversal (HybridPlane / HybridPlaneCoverage): the Phase-1
   * macrocell + brick DDA, but an occupied voxel holding a usable SIMPLE
   * record resolves through a bounded ray-plane intersection — optionally
   * clipped by the Phase-3 4x4 coverage mask — and a REJECTED plane lets the
   * ray keep marching. That continuation is the accuracy improvement over
   * occupied-box hits (a grazing ray no longer stops at a voxel face the
   * surface never crosses). Any cell without a usable record — complex fit,
   * pool overflow, not yet fitted — keeps the exact legacy occupied-box
   * semantics, so classification can tighten accuracy but can never widen a
   * leak beyond the bounded plane acceptance itself. DynamicBrick cells read
   * the per-chain DYNAMIC record tail (refit at the mover's current pose
   * every dispatch), falling back to the same box semantics wherever the
   * tail has no usable record.
   *
   * `opts.exact` (Phase 4, HybridExactComplex) adds one more branch, between
   * the plane test and that box fallback: a cell marked COMPLEX carries its
   * whole (≤ MAX_COMPLEX_TRIANGLES) triangle list in the pool, so the ray runs
   * a bounded Möller-Trumbore sweep over it and a genuinely empty result lets
   * the DDA continue. It is the ONE case where a cell can be left without a
   * hit on exact evidence rather than conservative evidence.
   *
   * The packed return differs from Phase-1: zw carry the OCT-ENCODED
   * voxel-space hit normal (a fitted plane's normal no longer fits the axis
   * convention). The wrapper decodes and maps it to world space with the
   * covariant transform for the diagonal voxel scale (n_world ∝ n_vox ·
   * voxelInv), which leaves axis-aligned face normals untouched.
   */
  const hybridPlaneVariants = new Map();
  const traceHybridPlane = surfaceEnabled
    ? (origin, dir, tMin, tMax, opts = {}) => {
        const macroStepLimit = Math.min(
          MAX_MACRO_STEPS,
          Math.max(1, opts.macroSteps ?? MAX_MACRO_STEPS),
        );
        const coverage = opts.coverage === true;
        // Gated on the BUILD flag too: with no triangle pool allocated no
        // record can carry the COMPLEX marker, so an exact request there is
        // exactly the Phase-3 variant and must compile as one.
        const exact = complexEnabled && opts.exact === true;
        // `penumbraK` turns this into the SHADOW variant: the packed return
        // carries an analytic cone-occlusion estimate in z INSTEAD of the oct
        // normal (shadow callers don't consume normals), and every rejected
        // plane contributes its perpendicular miss distance — the distance to
        // the actual RECORDED surface, which is what makes the penumbra
        // geometry-true instead of voxel-hull-true.
        const penumbra = opts.penumbraK != null;
        // ORIGIN-PLANE EXCLUSION (shadow variant only): the caller passes the
        // RECEIVING surface point, and any accept or cone contribution whose
        // plane CONTAINS that point is skipped — a plane cannot shadow
        // itself, but the receiver's own SAT-bulged voxel staircase re-fits
        // that same plane in cell after cell along a tilted surface, and each
        // tooth used to stamp a soft self-shadow phantom (the teardrop grid
        // on rotated faces). Unsigned test, so flipped normals don't matter;
        // cells fitting a DIFFERENT plane (real contact occluders, the
        // cube's own other face) still block. Sound at any t: a ray leaving a
        // point on plane P can only re-cross P at t≈0, so far cells of the
        // same plane never produced legitimate accepts anyway.
        const exclude = penumbra && opts.excludePoint != null;
        // Band-limit width (world units) — see traceBody's rPen note. A
        // variant + trailing input so every existing caller keeps its exact
        // historical WGSL.
        const penWidth = penumbra && opts.penWidth != null ? opts.penWidth : null;
        const profile = rayHitDebug != null && opts.profile === true;
        const key = `${macroStepLimit}|${coverage ? 1 : 0}|${exact ? 1 : 0}|${profile ? 1 : 0}` +
          `|${coarseSkipEnabled ? 1 : 0}|${penumbra ? 1 : 0}|${exclude ? 1 : 0}|${penWidth != null ? 1 : 0}`;
        let fn = hybridPlaneVariants.get(key);
        if (fn === undefined) {
          fn = sharedFn({
            // "s0" is appended ONLY when the skip is off, so the default arm
            // keeps the exact function names it has always emitted.
            name: `giHybridPlaneTrace${macroStepLimit}${coverage ? "c" : ""}${exact ? "x" : ""}` +
              `${penumbra ? "p" : ""}${exclude ? "e" : ""}${penWidth != null ? "w" : ""}${coarseSkipEnabled ? "" : "s0"}`,
            type: "vec4",
            inputs: [
              { name: "origin", type: "vec3" },
              { name: "dir", type: "vec3" },
              { name: "tMin", type: "float" },
              { name: "tMax", type: "float" },
              ...(penumbra ? [{ name: "penK", type: "float" }] : []),
              ...(exclude ? [{ name: "excl", type: "vec3" }] : []),
              ...(penWidth != null ? [{ name: "penW", type: "float" }] : []),
            ],
            // Trailing-optional positional mapping: penW rides after excl
            // when both exist, in excl's seat when exclude is off.
            body: (o, d, t0, t1, a5, a6, a7) => {
              const penKIn = penumbra ? a5 : undefined;
              const exclIn = exclude ? a6 : undefined;
              const penWIn = penWidth != null ? (exclude ? a7 : a6) : undefined;
              const inv = vec3(voxelInv).toVar();
              const q0 = vec3(o).sub(vec3(gridOrigin)).mul(inv).toVar();
              const dq = vec3(d).mul(inv).toVar();
              const safe = (c) => select(
                c.abs().lessThan(RAY_HIT_DIRECTION_EPSILON),
                select(c.lessThan(0), float(-RAY_HIT_DIRECTION_EPSILON), float(RAY_HIT_DIRECTION_EPSILON)),
                c,
              );
              const rd = vec3(
                float(1).div(safe(dq.x)),
                float(1).div(safe(dq.y)),
                float(1).div(safe(dq.z)),
              ).toVar();
              const face = vec3(
                select(dq.x.greaterThanEqual(0), float(1), float(0)),
                select(dq.y.greaterThanEqual(0), float(1), float(0)),
                select(dq.z.greaterThanEqual(0), float(1), float(0)),
              ).toVar();

              const t = float(t0).toVar();
              const hit = float(0).toVar();
              const hitT = float(-1).toVar();
              // Voxel-space hit normal; face normals and fitted plane normals
              // share this one channel.
              const hitNormal = vec3(0, 0, 1).toVar();
              const axis = float(-1).toVar();
              const resolved = float(0).toVar();
              const invalidRef = float(0).toVar();
              const brickLimit = float(0).toVar();
              // Detail discriminator for the exhaustion clamp below: 1 while
              // the last processed macro cell carried a brick.
              const lastBrick = float(0).toVar();
              // Skip off starts AT the macro level, so the ride is not merely
              // predicated away — levels 3-4 are never read.
              const level = int(coarseSkipEnabled ? OCC_LEVELS - 1 : 2).toVar();
              const usedMacroSteps = uint(0).toVar();
              const usedBrickSteps = uint(0).toVar();
              // Phase-5 skip instrumentation, declared only in the enabled
              // variant so the A/B arm's WGSL stays free of coarse traffic.
              const usedCoarseSteps = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseSkipsL3 = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseSkipsL4 = coarseSkipEnabled ? uint(0).toVar() : null;
              const coarseDescends = coarseSkipEnabled ? uint(0).toVar() : null;
              const planeTests = uint(0).toVar();
              const planeAccepts = uint(0).toVar();
              const planeRejects = uint(0).toVar();
              const surfaceFallbacks = uint(0).toVar();
              // Analytic cone occlusion for the shadow variant: min over every
              // rejected plane of k·d/t, where d is the ray's perpendicular
              // miss distance to the FITTED SURFACE (world units) — the
              // geometry-true analogue of the legacy DDA's voxel free-radius
              // estimator. 1 = clear cone, →0 as the ray grazes real surface.
              const pen = penumbra ? float(1).toVar() : null;
              // Verdict-kind channel (w of the packed return, shadow variant
              // only): 0 none/miss, 1 plane accept, 2 exact triangle, 3 box
              // fallback, 4 fail-closed clamp. Costs one register; lets a
              // debug view paint WHICH acceptance class decided each pixel —
              // the instrument that ends silhouette-attribution guesswork.
              const hitKind = penumbra ? float(0).toVar() : null;
              const voxNode = penumbra ? vec3(voxel).toVar() : null;
              const voxMinW = penumbra ? voxNode.x.min(voxNode.y).min(voxNode.z).toVar() : null;
              // No contribution before ~2 voxels of travel (the receiver's own
              // surface must not clamp rays at birth) — same gate the legacy
              // estimator applies.
              const penGate = penumbra ? float(t0).add(voxMinW.mul(2)).toVar() : null;
              // Receiver point in level-0 voxel space, for the origin-plane
              // exclusion tests below.
              const qx = exclude
                ? vec3(exclIn).sub(vec3(gridOrigin)).mul(inv).toVar()
                : null;
              // Declared only in the exact variant so the Phase-2/3 variants
              // emit byte-identical WGSL to before Phase 4.
              const complexTests = exact ? uint(0).toVar() : null;
              const triangleTests = exact ? uint(0).toVar() : null;
              const complexAccepts = exact ? uint(0).toVar() : null;
              const complexMisses = exact ? uint(0).toVar() : null;

              const faceNormalFrom = (axisNode) => select(
                axisNode.lessThan(0),
                dq.negate().normalize(),
                vec3(
                  select(axisNode.equal(0), dq.x.sign().negate(), float(0)),
                  select(axisNode.equal(1), dq.y.sign().negate(), float(0)),
                  select(axisNode.equal(2), dq.z.sign().negate(), float(0)),
                ),
              );

              Loop({ start: 0, end: macroStepLimit, name: "planeMacroDda" }, () => {
                usedMacroSteps.addAssign(uint(1));
                If(t.greaterThanEqual(t1), () => {
                  resolved.assign(1);
                  Break();
                });

                const q = q0.add(dq.mul(t)).toVar();
                If(
                  q.x.lessThan(0).or(q.y.lessThan(0)).or(q.z.lessThan(0))
                    .or(q.x.greaterThanEqual(level0.res.x))
                    .or(q.y.greaterThanEqual(level0.res.y))
                    .or(q.z.greaterThanEqual(level0.res.z)),
                  () => {
                    resolved.assign(1);
                    Break();
                  },
                );

                // The macro+brick body is a JS closure so the coarse ride can
                // be compiled OUT rather than predicated away: an A/B arm that
                // still emits the level-3/4 reads measures the wrong thing.
                const macroBody = () => {
                const macro = q.div(float(BRICK_RESOLUTION)).floor().toVar();
                const mx = macro.x.toUint().toVar();
                const my = macro.y.toUint().toVar();
                const mz = macro.z.toUint().toVar();
                const macroIndex = mz.mul(uint(hybridLayout.macroResolution.y)).add(my)
                  .mul(uint(hybridLayout.macroResolution.x)).add(mx).toVar();
                const macroBase = uint(hybridWordOffset).add(
                  macroIndex.mul(uint(MACRO_CELL_WORDS)),
                ).toVar();
                const brickIndex = bits.element(
                  macroBase.add(uint(MACRO_CELL_BRICK_INDEX_WORD)),
                ).toVar();
                const metadata = bits.element(
                  macroBase.add(uint(MACRO_CELL_METADATA_WORD)),
                ).toVar();
                const cellType = bitAnd(
                  shiftRight(metadata, uint(MACRO_CELL_TYPE_SHIFT)),
                  uint(MACRO_CELL_TYPE_MASK),
                ).toVar();

                const macroBound = macro.add(face).mul(float(BRICK_RESOLUTION)).toVar();
                const tx = macroBound.x.sub(q.x).mul(rd.x).toVar();
                const ty = macroBound.y.sub(q.y).mul(rd.y).toVar();
                const tz = macroBound.z.sub(q.z).mul(rd.z).toVar();
                const macroDelta = tx.min(ty).min(tz).max(0).toVar();
                const macroExit = t.add(macroDelta).toVar();
                const macroAxis = select(
                  macroDelta.equal(tx),
                  float(0),
                  select(macroDelta.equal(ty), float(1), float(2)),
                ).toVar();

                // DynamicBrick bricks resolve through the per-chain DYNAMIC
                // record tail: their offset word was rewritten by this very
                // dispatch's refit, ranked against the same merged masks read
                // below. INVALID there (refit off, tail overflow, demoted
                // mid-frame) keeps the occupied-box semantics — never a miss.
                const isStaticBrick = cellType.equal(uint(MacroCellType.Brick)).toVar();
                If(isStaticBrick.or(cellType.equal(uint(MacroCellType.DynamicBrick))), () => {
                  lastBrick.assign(1);
                  const validBrick = brickIndex.lessThan(uint(hybridLayout.brickCount))
                    .and(brickIndex.notEqual(uint(INVALID_RAY_HIT_INDEX)));
                  If(validBrick.not(), () => {
                    invalidRef.assign(1);
                    // Sub-kind 6: Brick-typed macro cell with a broken brick
                    // index. Consumers treat every kind > 3.5 as one
                    // fail-closed class; the distinct value serves the
                    // kind-map instrument (attribution, not behaviour).
                    if (penumbra) hitKind.assign(6);
                    Break();
                  });

                  const safeBrick = brickIndex.min(uint(hybridLayout.brickCount - 1));
                  const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                    .add(safeBrick.mul(uint(BRICK_HEADER_WORDS))).toVar();
                  const occupancyLow = bits.element(
                    brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD)),
                  ).toVar();
                  const occupancyHigh = bits.element(
                    brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD)),
                  ).toVar();
                  const surfOffset = select(
                    isStaticBrick,
                    bits.element(brickBase.add(uint(BRICK_SURFACE_OFFSET_WORD))),
                    bits.element(brickBase.add(uint(BRICK_DYNAMIC_OFFSET_WORD))),
                  ).toVar();
                  const useRecords = surfOffset
                    .notEqual(uint(INVALID_RAY_HIT_INDEX)).toVar();
                  const localT = t.toVar();
                  const localResolved = float(0).toVar();
                  const localAxis = axis.toVar();
                  const segmentEnd = macroExit.min(t1).toVar();

                  Loop({ start: 0, end: MAX_BRICK_STEPS, name: "planeBrickDda" }, () => {
                    If(localT.greaterThanEqual(segmentEnd.add(RAY_HIT_DDA_EPSILON)), () => {
                      localResolved.assign(1);
                      Break();
                    });
                    usedBrickSteps.addAssign(uint(1));
                    const localQ = q0.add(dq.mul(localT)).toVar();
                    const cell = localQ.floor().toVar();
                    // The epsilon advance can land a hair past the brick; the
                    // mask and every rank below belong to THIS brick, so hand
                    // such a ray back to the macro loop (mirrors the CPU).
                    const cellMacro = cell.div(float(BRICK_RESOLUTION)).floor().toVar();
                    If(
                      cellMacro.x.notEqual(macro.x)
                        .or(cellMacro.y.notEqual(macro.y))
                        .or(cellMacro.z.notEqual(macro.z)),
                      () => {
                        localResolved.assign(1);
                        Break();
                      },
                    );
                    const localCell = cell.sub(macro.mul(float(BRICK_RESOLUTION)))
                      .clamp(vec3(0), vec3(BRICK_RESOLUTION - 1)).toVar();
                    const cellIndex = localCell.z.toUint().mul(uint(16))
                      .add(localCell.y.toUint().mul(uint(4)))
                      .add(localCell.x.toUint()).toVar();

                    // Cell exit before the hit test: the plane acceptance is
                    // bounded by this cell's [entry, exit] ray interval.
                    const cellBound = cell.add(face).toVar();
                    const cx = cellBound.x.sub(localQ.x).mul(rd.x).toVar();
                    const cy = cellBound.y.sub(localQ.y).mul(rd.y).toVar();
                    const cz = cellBound.z.sub(localQ.z).mul(rd.z).toVar();
                    const cellDelta = cx.min(cy).min(cz).max(0).toVar();
                    const cellExit = localT.add(cellDelta).toVar();
                    const nextAxis = select(
                      cellDelta.equal(cx),
                      float(0),
                      select(cellDelta.equal(cy), float(1), float(2)),
                    ).toVar();

                    const occupancyWord = select(
                      cellIndex.lessThan(uint(32)),
                      occupancyLow,
                      occupancyHigh,
                    ).toVar();
                    const occupancyBit = bitAnd(
                      shiftRight(occupancyWord, bitAnd(cellIndex, uint(31))),
                      uint(1),
                    );
                    If(occupancyBit.notEqual(uint(0)), () => {
                      // 0 = untouched (→ box fallback), 1 = hit taken,
                      // 2 = plane rejected (→ keep marching).
                      const cellVerdict = float(0).toVar();
                      If(useRecords, () => {
                        const inLow = cellIndex.lessThan(uint(32));
                        const belowLow = select(
                          inLow,
                          shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                          uint(0xffffffff),
                        );
                        const belowHigh = select(
                          inLow,
                          uint(0),
                          shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                        );
                        const rank = countOneBits(bitAnd(occupancyLow, belowLow))
                          .add(countOneBits(bitAnd(occupancyHigh, belowHigh)));
                        const record = surfOffset.add(rank).toVar();
                        If(record.lessThan(uint(totalSurfaceCapacity)), () => {
                          const rBase = uint(surfaceWordOffset)
                            .add(record.mul(uint(SURFACE_RECORD_WORDS))).toVar();
                          const flagsWord = bits.element(rBase.add(uint(3))).toVar();
                          const simple = bitAnd(
                            shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                            uint(SURFACE_FLAG_SIMPLE),
                          );
                          If(simple.notEqual(uint(0)), () => {
                            planeTests.addAssign(uint(1));
                            const n = octDecodeTSL(unpackSnorm2x16(bits.element(rBase))).toVar();
                            const dPlane = unpackSnorm2x16(bits.element(rBase.add(uint(1)))).x
                              .mul(CELL_LOCAL_PLANE_OFFSET_RANGE).toVar();
                            // Unsigned plane-membership of the RECEIVER: true
                            // means this cell's fitted plane is the receiving
                            // surface itself (same-plane cells fit within
                            // quantization of each other), so it must neither
                            // accept nor darken the cone.
                            const selfPlane = exclude
                              ? dPlane.add(n.dot(cell)).sub(n.dot(qx)).abs()
                                  .lessThan(SELF_PLANE_EXCLUSION_SLACK).toVar()
                              : null;
                            const denom = n.dot(dq).toVar();
                            const accepted = float(0).toVar();
                            const denomIf = If(denom.abs().greaterThan(1e-7), () => {
                              const tP = dPlane.add(n.dot(cell)).sub(n.dot(q0)).div(denom).toVar();
                              const okInterval = tP.greaterThanEqual(localT.sub(PLANE_HIT_INTERVAL_EPSILON))
                                .and(tP.lessThanEqual(cellExit.min(segmentEnd).add(PLANE_HIT_INTERVAL_EPSILON)));
                              If(okInterval, () => {
                                const covOk = float(1).toVar();
                                if (coverage) {
                                  const covValid = bitAnd(shiftRight(flagsWord, uint(COVERAGE_VALID_SHIFT)), uint(1));
                                  If(covValid.notEqual(uint(0)), () => {
                                    const local = q0.add(dq.mul(tP)).sub(cell)
                                      .clamp(vec3(0), vec3(1)).toVar();
                                    const axisSel = bitAnd(shiftRight(flagsWord, uint(16)), uint(3)).toVar();
                                    const u = select(axisSel.equal(uint(0)), local.y, local.x);
                                    const v = select(axisSel.equal(uint(2)), local.y, local.z);
                                    const texU = u.mul(4).floor().clamp(0, 3).toUint();
                                    const texV = v.mul(4).floor().clamp(0, 3).toUint();
                                    // The packed mask is RAW. Gather rays test
                                    // it one-texel DILATED (leak-conservative:
                                    // a false miss continues the march through
                                    // a wall); shadow rays test it raw — the
                                    // silhouette lever.
                                    let testMask = bitAnd(flagsWord, uint(0xffff)).toVar();
                                    if (!penumbra) {
                                      const hM = bitAnd(bitOr(testMask, bitOr(
                                        bitAnd(shiftLeft(testMask, uint(1)), uint(0xeeee)),
                                        bitAnd(shiftRight(testMask, uint(1)), uint(0x7777)),
                                      )), uint(0xffff)).toVar();
                                      testMask = bitAnd(bitOr(hM, bitOr(
                                        shiftLeft(hM, uint(4)),
                                        shiftRight(hM, uint(4)),
                                      )), uint(0xffff)).toVar();
                                    }
                                    const covBit = bitAnd(
                                      shiftRight(testMask, texV.mul(uint(4)).add(texU)),
                                      uint(1),
                                    );
                                    covOk.assign(covBit.toFloat());
                                  });
                                }
                                If(exclude ? covOk.greaterThan(0.5).and(selfPlane.not()) : covOk.greaterThan(0.5), () => {
                                  accepted.assign(1);
                                  hit.assign(1);
                                  hitT.assign(tP.max(t0));
                                  // Face the side the ray sees — the sampler
                                  // picks the radiance shell by this normal.
                                  hitNormal.assign(select(denom.greaterThan(0), n.negate(), n));
                                  resolved.assign(1);
                                  localResolved.assign(1);
                                  cellVerdict.assign(1);
                                  planeAccepts.addAssign(uint(1));
                                  if (penumbra) hitKind.assign(1);
                                });
                              });
                              if (penumbra) {
                                // Cone contribution from MISSED-SEGMENT rejects
                                // only: F(t) = n·q(t) − plane is linear with
                                // slope `denom`, so the closest approach inside
                                // [entry, exit] is |denom|·min|t − tP| at the
                                // nearer endpoint. In-interval COVERAGE rejects
                                // are excluded on purpose — there the ray
                                // crosses the plane's extension where the
                                // surface genuinely is not (a real silhouette
                                // edge), and their perpendicular distance of 0
                                // would black the cone out.
                                If(
                                  exclude
                                    ? accepted.lessThan(0.5).and(okInterval.not()).and(selfPlane.not())
                                    : accepted.lessThan(0.5).and(okInterval.not()),
                                  () => {
                                  const tEnd = cellExit.min(segmentEnd).toVar();
                                  const dVox = denom.abs().mul(
                                    localT.sub(tP).abs().min(tEnd.sub(tP).abs()),
                                  ).toVar();
                                  const rPen1 = penWidth != null
                                    ? localT.max(1e-4).div(float(penKIn)).max(float(penWIn))
                                    : localT.max(1e-4).div(float(penKIn));
                                  const cand = dVox.mul(voxMinW).div(rPen1).clamp(0, 1);
                                  pen.assign(pen.min(select(
                                    localT.greaterThan(penGate).and(localT.lessThan(t1)),
                                    cand,
                                    float(1),
                                  )));
                                });
                              }
                            });
                            if (penumbra) {
                              denomIf.Else(() => {
                                // Parallel ray: the perpendicular distance to
                                // the fitted plane is constant along the whole
                                // segment — the exact analytic-cone case (a ray
                                // sliding just above a floor's surface). With
                                // exclusion on, a ray sliding above its OWN
                                // tilted surface's staircase contributes
                                // nothing (that was the teardrop smudge).
                                const dVox = dPlane.add(n.dot(cell)).sub(n.dot(localQ)).abs().toVar();
                                const rPen2 = penWidth != null
                                  ? localT.max(1e-4).div(float(penKIn)).max(float(penWIn))
                                  : localT.max(1e-4).div(float(penKIn));
                                const cand = dVox.mul(voxMinW).div(rPen2).clamp(0, 1);
                                const penApply = exclude
                                  ? localT.greaterThan(penGate).and(localT.lessThan(t1)).and(selfPlane.not())
                                  : localT.greaterThan(penGate).and(localT.lessThan(t1));
                                pen.assign(pen.min(select(
                                  penApply,
                                  cand,
                                  float(1),
                                )));
                              });
                            }
                            If(accepted.lessThan(0.5), () => {
                              planeRejects.addAssign(uint(1));
                              cellVerdict.assign(2);
                            });
                          });
                          if (exact) {
                            // EXACT COMPLEX CELL. The record's reserved range
                            // holds every triangle that overlaps this cell, so
                            // an empty result is a real miss and the DDA is
                            // allowed to continue (verdict 2) — the whole
                            // point of Phase 4 over the occupied-box fallback.
                            // Pool vertices are CELL-LOCAL, so `cell` puts them
                            // back in the voxel space q0/dq already live in and
                            // `t` comes out in the DDA's own world units.
                            const complex = bitAnd(
                              shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                              uint(SURFACE_FLAG_COMPLEX),
                            );
                            If(complex.notEqual(uint(0)), () => {
                              complexTests.addAssign(uint(1));
                              const range = bits.element(rBase.add(uint(2))).toVar();
                              const poolOffset = bitAnd(range, uint(COMPLEX_RANGE_OFFSET_MASK)).toVar();
                              const triCount = bitAnd(
                                shiftRight(range, uint(COMPLEX_RANGE_COUNT_SHIFT)),
                                uint(COMPLEX_RANGE_COUNT_MASK),
                              ).toVar();
                              const tLo = localT.sub(PLANE_HIT_INTERVAL_EPSILON).toVar();
                              const tHi = cellExit.min(segmentEnd).add(PLANE_HIT_INTERVAL_EPSILON).toVar();
                              const nearest = float(1e30).toVar();
                              const found = float(0).toVar();
                              const nearestNormal = vec3(0, 0, 1).toVar();
                              Loop({ start: 0, end: MAX_COMPLEX_TRIANGLES, name: "exactTri" }, ({ exactTri }) => {
                                If(exactTri.toUint().greaterThanEqual(triCount), () => {
                                  Break();
                                });
                                triangleTests.addAssign(uint(1));
                                const w = uint(trianglePoolWordOffset).add(
                                  poolOffset.add(exactTri.toUint()).mul(uint(COMPLEX_TRIANGLE_WORDS)),
                                ).toVar();
                                const a = vec3(
                                  uintBitsToFloat(bits.element(w)),
                                  uintBitsToFloat(bits.element(w.add(uint(1)))),
                                  uintBitsToFloat(bits.element(w.add(uint(2)))),
                                ).add(cell).toVar();
                                const b = vec3(
                                  uintBitsToFloat(bits.element(w.add(uint(3)))),
                                  uintBitsToFloat(bits.element(w.add(uint(4)))),
                                  uintBitsToFloat(bits.element(w.add(uint(5)))),
                                ).add(cell).toVar();
                                const c = vec3(
                                  uintBitsToFloat(bits.element(w.add(uint(6)))),
                                  uintBitsToFloat(bits.element(w.add(uint(7)))),
                                  uintBitsToFloat(bits.element(w.add(uint(8)))),
                                ).add(cell).toVar();
                                // Möller-Trumbore, DOUBLE-SIDED: a back-facing
                                // triangle still stops light, and complex cells
                                // are exactly where both faces meet.
                                const e1 = b.sub(a).toVar();
                                const e2 = c.sub(a).toVar();
                                const pv = dq.cross(e2).toVar();
                                const det = e1.dot(pv).toVar();
                                If(det.abs().greaterThan(1e-9), () => {
                                  const invDet = float(1).div(det).toVar();
                                  const tv = q0.sub(a).toVar();
                                  const u = tv.dot(pv).mul(invDet).toVar();
                                  // The barycentric slack is WATERTIGHTNESS, not
                                  // tolerance: two triangles sharing an edge
                                  // compute that edge from independent f32 cross
                                  // products, so a hard [0,1] boundary lets a ray
                                  // through the seam — and an exact miss here
                                  // CONTINUES the march, i.e. leaks. 1e-6 of a
                                  // barycentric is sub-micron on a 0.125m cell.
                                  If(u.greaterThanEqual(-1e-6).and(u.lessThanEqual(1 + 1e-6)), () => {
                                    const qv = tv.cross(e1).toVar();
                                    const vBary = dq.dot(qv).mul(invDet).toVar();
                                    If(vBary.greaterThanEqual(-1e-6).and(u.add(vBary).lessThanEqual(1 + 1e-6)), () => {
                                      const tTri = e2.dot(qv).mul(invDet).toVar();
                                      // Origin-plane exclusion, triangle form:
                                      // skip a triangle whose plane contains
                                      // the receiver (the receiving face's own
                                      // geometry re-listed in a bulged cell).
                                      const triCond = exclude
                                        ? (() => {
                                            const nT = e1.cross(e2).toVar();
                                            const selfTri = nT.dot(qx.sub(a)).abs()
                                              .lessThan(nT.length().mul(SELF_PLANE_EXCLUSION_SLACK));
                                            return tTri.greaterThanEqual(tLo)
                                              .and(tTri.lessThanEqual(tHi))
                                              .and(tTri.lessThan(nearest))
                                              .and(selfTri.not());
                                          })()
                                        : tTri.greaterThanEqual(tLo)
                                            .and(tTri.lessThanEqual(tHi))
                                            .and(tTri.lessThan(nearest));
                                      If(triCond, () => {
                                        nearest.assign(tTri);
                                        found.assign(1);
                                        const gn = e1.cross(e2).normalize().toVar();
                                        nearestNormal.assign(select(gn.dot(dq).greaterThan(0), gn.negate(), gn));
                                      });
                                    });
                                  });
                                });
                              });
                              If(found.greaterThan(0.5), () => {
                                hit.assign(1);
                                hitT.assign(nearest.max(t0));
                                hitNormal.assign(nearestNormal);
                                resolved.assign(1);
                                localResolved.assign(1);
                                cellVerdict.assign(1);
                                complexAccepts.addAssign(uint(1));
                                if (penumbra) hitKind.assign(2);
                              }).Else(() => {
                                cellVerdict.assign(2);
                                complexMisses.addAssign(uint(1));
                              });
                            });
                          }
                        });
                      });
                      If(cellVerdict.lessThan(0.5), () => {
                        surfaceFallbacks.addAssign(uint(1));
                        hit.assign(1);
                        hitT.assign(localT);
                        hitNormal.assign(faceNormalFrom(localAxis));
                        resolved.assign(1);
                        localResolved.assign(1);
                        if (penumbra) hitKind.assign(3);
                      });
                      If(hit.greaterThan(0.5), () => {
                        Break();
                      });
                    });

                    localAxis.assign(nextAxis);
                    localT.assign(cellExit.add(RAY_HIT_DDA_EPSILON));
                  });

                  If(hit.greaterThan(0.5), () => {
                    Break();
                  });
                  If(localResolved.lessThan(0.5), () => {
                    brickLimit.assign(1);
                    // Sub-kind 5: the INNER brick loop spent MAX_BRICK_STEPS
                    // without reaching the segment end — fail-closed from the
                    // brick, not the macro budget. Same > 3.5 class for
                    // consumers; distinct for the kind-map instrument.
                    if (penumbra) hitKind.assign(5);
                    Break();
                  });
                  axis.assign(localAxis);
                  t.assign(macroExit.add(RAY_HIT_DDA_EPSILON));
                  // The re-ascend only exists when the ride does; with the skip
                  // off `level` must stay pinned at the macro level forever.
                  if (coarseSkipEnabled) level.assign(int(3));
                }).Else(() => {
                  lastBrick.assign(0);
                  axis.assign(macroAxis);
                  t.assign(macroExit.add(RAY_HIT_DDA_EPSILON));
                  if (coarseSkipEnabled) level.assign(int(3));
                });
                };

                // Reuse the existing conservative pyramid above level 2.
                // Level 2 is exactly one 4^3 macrocell, so levels 3-4 provide
                // broad empty-space skips without changing the leaf data.
                //
                // FUSED DESCEND — see the Phase-1 tracer's note: a descend that
                // lands at the macro level runs macroBody in this SAME
                // iteration, so hugging rays pay one iteration per macro cell,
                // not two.
                if (coarseSkipEnabled) {
                  const rideAdvanced = float(0).toVar();
                  If(level.greaterThan(int(2)), () => {
                    usedCoarseSteps.addAssign(uint(1));
                    const scale = levelSelect(level, (l) => l.scale).toVar();
                    const coarse = q.div(scale).floor().toVar();
                    If(occupiedAt(coarse, level).greaterThan(0.5), () => {
                      coarseDescends.addAssign(uint(1));
                      level.assign(level.sub(int(1)));
                    }).Else(() => {
                      const coarseBound = coarse.add(face).mul(scale).toVar();
                      const hx = coarseBound.x.sub(q.x).mul(rd.x).toVar();
                      const hy = coarseBound.y.sub(q.y).mul(rd.y).toVar();
                      const hz = coarseBound.z.sub(q.z).mul(rd.z).toVar();
                      const coarseDelta = hx.min(hy).min(hz).max(0).toVar();
                      axis.assign(select(
                        coarseDelta.equal(hx),
                        float(0),
                        select(coarseDelta.equal(hy), float(1), float(2)),
                      ));
                      t.addAssign(coarseDelta.add(RAY_HIT_DDA_EPSILON));
                      // Attributed BEFORE the re-ascend: the empty span belongs
                      // to the level that was empty, not the one climbed to.
                      coarseSkipsL3.addAssign(select(level.equal(int(3)), uint(1), uint(0)));
                      coarseSkipsL4.addAssign(select(level.greaterThan(int(3)), uint(1), uint(0)));
                      level.assign(level.add(int(1)).min(int(OCC_LEVELS - 1)));
                      rideAdvanced.assign(1);
                    });
                  });
                  If(rideAdvanced.lessThan(0.5).and(level.lessThanEqual(int(2))), macroBody);
                } else {
                  macroBody();
                }
              });

              // FAIL CLOSED ON EXHAUSTION FROM DETAIL — same clamp as the
              // Phase-1 tracer above (and the legacy traceBody); see its note.
              if (!globalThis.__giNoFailClosed) {
                If(resolved.lessThan(0.5).and(lastBrick.greaterThan(0.5)), () => {
                  hit.assign(1);
                  hitT.assign(t);
                  hitNormal.assign(faceNormalFrom(axis));
                  // Kind 4 = macro-budget exhaustion. Break paths already
                  // stamped 5 (brick limit) / 6 (invalid brick ref) — keep
                  // them; every consumer tests > 3.5, one class.
                  if (penumbra) {
                    If(hitKind.lessThan(3.5), () => {
                      hitKind.assign(4);
                    });
                  }
                });
              }

              if (rayHitDebug && profile) {
                const invalid = t.notEqual(t).or(hitT.notEqual(hitT)).or(invalidRef.greaterThan(0.5));
                const macroLimit = resolved.lessThan(0.5).and(brickLimit.lessThan(0.5));
                rayHitDebug.recordTrace({
                  hit,
                  resolved,
                  steps: usedMacroSteps,
                  brickSteps: usedBrickSteps,
                  macroLimit,
                  brickLimit,
                  invalid,
                  planeTests,
                  planeAccepts,
                  planeRejects,
                  surfaceFallbacks,
                  complexTests,
                  triangleTests,
                  complexAccepts,
                  complexMisses,
                  coarseSteps: usedCoarseSteps,
                  coarseSkipsL3,
                  coarseSkipsL4,
                  coarseDescends,
                });
              }

              if (penumbra) {
                // Shadow variant: z carries the cone estimate, w the verdict
                // kind; the normal is not decoded (shadow callers never
                // consume it).
                return vec4(hit, hitT, pen, hitKind);
              }
              const oct = octEncodeTSL(hitNormal).toVar();
              return vec4(hit, hitT, oct.x, oct.y);
            },
          });
          hybridPlaneVariants.set(key, fn);
        }

        const callArgs = [vec3(origin), vec3(dir), float(tMin), float(tMax)];
        if (penumbra) callArgs.push(float(opts.penumbraK));
        if (exclude) callArgs.push(vec3(opts.excludePoint));
        if (penWidth != null) callArgs.push(float(penWidth));
        const packed = fn(...callArgs).toVar();
        const hit = packed.x;
        const hitT = packed.y;
        const dq = vec3(dir).mul(vec3(voxelInv)).toVar();
        const q0 = vec3(origin).sub(vec3(gridOrigin)).mul(vec3(voxelInv));
        const voxelAtHit = q0.add(dq.mul(hitT)).floor();
        if (penumbra) {
          return { hit, t: hitT, pen: packed.z, kind: packed.w, voxel: voxelAtHit };
        }
        const normal = octDecodeTSL(vec2(packed.z, packed.w)).mul(vec3(voxelInv)).normalize().toVar();
        return { hit, t: hitT, normal, voxel: voxelAtHit };
      }
    : null;

  /**
   * Point test: is world point `p` inside occupied geometry at `level`? Used by
   * the composite to force its coarse occupied/distance flags from the fine
   * truth — the coarse SDF has already lost the columns by the time it runs.
   */
  // ONE WGSL FUNCTION PER SHADER PER LEVEL (sharedFn), not inline: the bit
  // fetch expands to ~20 lines of index math, and callers stamp this several
  // times per kernel. `level` is always a JS constant, so it is a variant key
  // rather than a parameter.
  const occupiedAtWorldVariants = new Map();
  const occupiedAtWorld = (p, level = 0) => {
    let fn = occupiedAtWorldVariants.get(level);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giOccupiedL${level}`,
        type: "float",
        inputs: [{ name: "p", type: "vec3" }],
        body: (pp) => {
          const q = vec3(pp).sub(vec3(gridOrigin)).mul(vec3(voxelInv)).toVar();
          return occupiedAt(q.div(float(1 << level)).floor(), int(level));
        },
      });
      occupiedAtWorldVariants.set(level, fn);
    }
    return fn(p);
  };

  /**
   * RECORD-TRUE NORMAL AT A POINT (GI_MOTION_PERF_PLAN §5.2). The field's
   * injection normal is the gradient of the binary-forced distance field, so
   * it SNAPS between quantized directions as a mover's rasterization
   * staircase re-phases — lurching `ndotl` and the shadow-ray origin for
   * cells that stay occupied. This returns the fitted-plane record normal of
   * the occupied level-0 voxel NEAREST `p` (DynamicBrick cells read the
   * per-chain dynamic tail, so a mover's normal rotates continuously with
   * the mesh), for the injection site to substitute where a simple record
   * exists. vec4(worldNormal, flag) — flag 0 means "no record" (empty
   * neighbourhood, unallocated brick, complex cell) and the caller keeps its
   * gradient fallback. Reads only the already-bound `bits` buffer.
   */
  const recordNormalAt = surfaceEnabled && hybridEnabled
    ? (p) => {
        const fn = sharedFn({
          name: "giRecordNormalAt",
          type: "vec4",
          inputs: [{ name: "p", type: "vec3" }],
          body: (pp) => {
            const q0 = vec3(pp).sub(vec3(gridOrigin)).mul(vec3(voxelInv)).toVar();
            const cell = q0.floor().toVar();
            const voxelWorld = vec3(voxel).toVar();
            const bestD = float(1e9).toVar();
            const bestV = vec3(0).toVar();
            // Same 3×3×3 argmin walk as the oracle's near field (see
            // freeRadiusBody's loop notes — runtime Loop, not a JS unroll).
            Loop({ start: 0, end: 27, name: "rn" }, ({ rn }) => {
              const dx = rn.mod(int(3)).sub(int(1)).toFloat();
              const dy = rn.div(int(3)).mod(int(3)).sub(int(1)).toFloat();
              const dz = rn.div(int(9)).sub(int(1)).toFloat();
              const v = cell.add(vec3(dx, dy, dz)).toVar();
              const occ = occupiedAtLevel0(v).toVar();
              const gap = v.sub(q0).max(q0.sub(v.add(1))).max(vec3(0)).mul(voxelWorld).toVar();
              const d = gap.length();
              If(occ.greaterThan(0.5).and(d.lessThan(bestD)), () => {
                bestD.assign(d);
                bestV.assign(v);
              });
            });
            const outN = vec4(0, 0, 0, 0).toVar();
            If(bestD.lessThan(1e8), () => {
              // Macro → brick → record walk, identical to the oracle's
              // record-aware near field (rank-addressed in the merged mask;
              // static bricks read the static pool offset, DynamicBrick the
              // per-chain tail).
              const macro = bestV.div(float(BRICK_RESOLUTION)).floor().toVar();
              const mx = macro.x.max(0).min(hybridLayout.macroResolution.x - 1).toUint().toVar();
              const my = macro.y.max(0).min(hybridLayout.macroResolution.y - 1).toUint().toVar();
              const mz = macro.z.max(0).min(hybridLayout.macroResolution.z - 1).toUint().toVar();
              const macroIndex = mz.mul(uint(hybridLayout.macroResolution.y)).add(my)
                .mul(uint(hybridLayout.macroResolution.x)).add(mx).toVar();
              const macroBase = uint(hybridWordOffset).add(
                macroIndex.mul(uint(MACRO_CELL_WORDS)),
              ).toVar();
              const metadata = bits.element(
                macroBase.add(uint(MACRO_CELL_METADATA_WORD)),
              ).toVar();
              const cellType = bitAnd(
                shiftRight(metadata, uint(MACRO_CELL_TYPE_SHIFT)),
                uint(MACRO_CELL_TYPE_MASK),
              ).toVar();
              const isStaticBrick = cellType.equal(uint(MacroCellType.Brick)).toVar();
              If(isStaticBrick.or(cellType.equal(uint(MacroCellType.DynamicBrick))), () => {
                const brickIndex = bits.element(
                  macroBase.add(uint(MACRO_CELL_BRICK_INDEX_WORD)),
                ).toVar();
                If(
                  brickIndex.lessThan(uint(hybridLayout.brickCount))
                    .and(brickIndex.notEqual(uint(INVALID_RAY_HIT_INDEX))),
                  () => {
                    const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                      .add(brickIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
                    const surfOffset = select(
                      isStaticBrick,
                      bits.element(brickBase.add(uint(BRICK_SURFACE_OFFSET_WORD))),
                      bits.element(brickBase.add(uint(BRICK_DYNAMIC_OFFSET_WORD))),
                    ).toVar();
                    If(surfOffset.notEqual(uint(INVALID_RAY_HIT_INDEX)), () => {
                      const localCell = bestV.sub(macro.mul(float(BRICK_RESOLUTION)))
                        .clamp(vec3(0), vec3(BRICK_RESOLUTION - 1)).toVar();
                      const cellIndex = localCell.z.toUint().mul(uint(16))
                        .add(localCell.y.toUint().mul(uint(4)))
                        .add(localCell.x.toUint()).toVar();
                      const occupancyLow = bits.element(
                        brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD)),
                      ).toVar();
                      const occupancyHigh = bits.element(
                        brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD)),
                      ).toVar();
                      const inLow = cellIndex.lessThan(uint(32));
                      const belowLow = select(
                        inLow,
                        shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                        uint(0xffffffff),
                      );
                      const belowHigh = select(
                        inLow,
                        uint(0),
                        shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                      );
                      const rank = countOneBits(bitAnd(occupancyLow, belowLow))
                        .add(countOneBits(bitAnd(occupancyHigh, belowHigh)));
                      const record = surfOffset.add(rank).toVar();
                      If(record.lessThan(uint(totalSurfaceCapacity)), () => {
                        const rBase = uint(surfaceWordOffset)
                          .add(record.mul(uint(SURFACE_RECORD_WORDS))).toVar();
                        const flagsWord = bits.element(rBase.add(uint(3))).toVar();
                        const simple = bitAnd(
                          shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                          uint(SURFACE_FLAG_SIMPLE),
                        );
                        If(simple.notEqual(uint(0)), () => {
                          // Same decode + world transform as the gather
                          // trace's normal return (voxel-space oct → world
                          // via the inverse scale).
                          const nHat = octDecodeTSL(unpackSnorm2x16(bits.element(rBase))).toVar();
                          outN.assign(vec4(nHat.mul(vec3(voxelInv)).normalize(), 1));
                        });
                      });
                    });
                  },
                );
              });
            });
            return outN;
          },
        });
        return fn(p);
      }
    : null;

  /**
   * THE PYRAMID AS A DISTANCE ORACLE — a conservative lower bound on the
   * distance from world point `p` to the nearest occupied geometry.
   *
   * This is what lets the mesh-SDF atlas be deleted. Soft shadows need a
   * CONTINUOUS distance (the penumbra estimator is `min(k·d/t)`), and a bitset
   * appears to have none — which is why the 40 MB per-mesh atlas survived every
   * other round of SDF removal. But the pyramid already carries one for free:
   * a level-L voxel is `2^L` voxels wide and an OR-downsampled parent is empty
   * only if ALL its children are, so an empty level-L neighbourhood is a proof
   * of emptiness over its whole extent.
   *
   * Concretely, per level: take the 2×2×2 block of level-L voxels nearest `p`
   * (the 8 whose corners bracket it). If every one is empty, nothing occupied
   * lies inside a box that extends at least half a level-L voxel from `p` in
   * every direction, so the true distance is at least `p`'s distance to that
   * box's boundary. The coarsest level that passes gives the largest bound.
   *
   * IT IS CONTINUOUS, which is the property that matters and the one a naive
   * bitset lookup lacks: the returned value is a distance to a BOX FACE, so it
   * varies smoothly as `p` moves, rather than snapping between powers of two.
   * The bound itself is a step function of the level, but the value within a
   * level is not, and the penumbra estimator only ever sees the value.
   *
   * PURE DATAFLOW, no `If` around the fetches, no early exit — the idiom that
   * rendered the BVH mirror pass black (see `occupiedAt`'s note). Occupancy is
   * monotone across levels (coarse-empty implies fine-empty), so `max` over all
   * levels is exactly "the coarsest level that passed" anyway.
   *
   * @param {*} p world position
   * @param {number} maxLevel highest pyramid level to consult. Each level costs
   *   8 buffer reads, and the bound saturates at `2^maxLevel · voxel`, so a
   *   caller that only needs to sharpen a coarse distance near surfaces (the
   *   traces) passes a small number and lets its existing far-field distance
   *   cover the rest. The composite, which HAS no other source, passes them all.
   */
  const freeRadiusBody = (p, top, nearField, cap, recordAware = false) => {
    const q0 = vec3(p).sub(vec3(gridOrigin)).mul(vec3(voxelInv)).toVar();
    const voxelWorld = vec3(voxel).toVar();
    const best = float(0).toVar();

    // ── NEAR FIELD: a real distance, not a block flag ────────────────────────
    //
    // THE MISTAKE THIS REPLACES, because it is an easy one to make again: the
    // first version used the same 2×2×2 all-empty test at level 0 as at every
    // other level, so it returned **0** for any point within a voxel of
    // geometry (a block counts as occupied if ANY of its 8 voxels is). Sphere
    // tracing on that inflates every occluder by a voxel — it sealed the leak
    // beautifully and made the whole scene visibly darker, which is exactly
    // what was reported.
    //
    // The fix is to measure instead of test. For each occupied voxel in the
    // 3×3×3 neighbourhood, the distance from `p` to that voxel's AABB is a
    // conservative lower bound on the distance to whatever triangle set the
    // bit (the triangle is somewhere inside the box, so it can only be
    // farther). Geometry OUTSIDE the neighbourhood is at least as far as the
    // block's boundary. So the smaller of those two is a valid bound, and —
    // unlike a block flag — it varies smoothly from 0 at the surface.
    // RUNTIME LOOPS, NOT JS UNROLLS, in both blocks below — and that is a
    // DRIVER-TIME decision, not a GPU-time one. Unrolled, this body is a
    // 27-fetch + 8×levels straight-line fetch storm; DXC's optimizer scales
    // superlinearly on that shape, and the kernels carrying it took tens of
    // seconds EACH to compile (the startup hang). As `Loop()`s the WGSL is a
    // few hundred bytes per block, the fetch count is identical, and the
    // extra loop arithmetic is noise next to the memory latency it interleaves.
    if (nearField) {
      const cell = q0.floor().toVar();
      const nearest = float(1e9).toVar();
      // RECORD-AWARE SHARPENING (Phase 5). The voxel-AABB bound this loop
      // computes is what paints stair-stepped shadow silhouettes: its
      // isosurface is a rounded BOX, so a light sweeping past a flat wall
      // crosses a staircase of them and the penumbra steps in voxel-sized
      // blocks ("squarish light changes"). Where the occupied
      // neighbour carries a SIMPLE surface record — a plane already fitted to
      // exactly the triangles that set the bit, living in the SAME `bits`
      // buffer this oracle already reads — the true distance to that geometry
      // is the plane distance, which is a hair larger than the box gap and
      // whose isosurface is FLAT. Taking the max of the two is still a valid
      // lower bound (both bound the same triangles), so this only ever
      // SHARPENS; the box gap remains the floor for every case the record
      // cannot speak for: dynamic bricks (records were fitted and rank-
      // addressed against the STATIC mask), unallocated bricks, and complex
      // cells whose geometry is not one plane.
      //
      // MIN of the world voxel dimensions, taken GPU-side off the live
      // `voxel` uniform rather than baked as a JS literal, so an in-place
      // refit rescales it with everything else in this file. Converting a
      // voxel-space distance with the SMALLEST axis is the conservative
      // choice on a non-cubic grid.
      const minVoxelWorld = recordAware
        ? voxelWorld.x.min(voxelWorld.y).min(voxelWorld.z).toVar()
        : null;
      // NOTE `name:` is the WGSL iterator's NAME (LoopNode.getProperties), not
      // a label — the callback destructures by it, and nested loops need
      // distinct names so the inner counter can't shadow the outer.
      Loop({ start: 0, end: 27, name: "nf" }, ({ nf }) => {
        const dx = nf.mod(int(3)).sub(int(1)).toFloat();
        const dy = nf.div(int(3)).mod(int(3)).sub(int(1)).toFloat();
        const dz = nf.div(int(9)).sub(int(1)).toFloat();
        const v = cell.add(vec3(dx, dy, dz)).toVar();
        const occ = occupiedAtLevel0(v).toVar();
        // Componentwise gap between `q0` and the voxel box [v, v+1]; zero
        // on an axis where `q0` is already inside the slab.
        const gap = v.sub(q0).max(q0.sub(v.add(1))).max(vec3(0)).mul(voxelWorld).toVar();
        const d = gap.length();
        if (!recordAware) {
          nearest.assign(nearest.min(select(occ.greaterThan(0.5), d, float(1e9))));
        } else {
          const contribution = d.toVar();
          // The whole record chain is gated on the bit, unlike the fetches
          // above: an EMPTY neighbour is the common case and it has no record
          // to look up, so predicating this would pay four dependent buffer
          // reads 27 times per sample for nothing. (Safe here in a way the
          // pyramid fetches are not — nothing downstream needs the value the
          // untaken branch would have produced; `contribution` already holds
          // the conservative answer.)
          If(occ.greaterThan(0.5), () => {
            // Phase-1 macro → brick header walk, identical to the plane
            // trace's. `v` is occupied, so it is inside level 0 by
            // construction and its macrocell exists (level-0 resolution is a
            // multiple of RES_QUANTUM ≥ BRICK_RESOLUTION); the clamps only
            // keep the indices provably in range for the compiler.
            const macro = v.div(float(BRICK_RESOLUTION)).floor().toVar();
            const mx = macro.x.max(0).min(hybridLayout.macroResolution.x - 1).toUint().toVar();
            const my = macro.y.max(0).min(hybridLayout.macroResolution.y - 1).toUint().toVar();
            const mz = macro.z.max(0).min(hybridLayout.macroResolution.z - 1).toUint().toVar();
            const macroIndex = mz.mul(uint(hybridLayout.macroResolution.y)).add(my)
              .mul(uint(hybridLayout.macroResolution.x)).add(mx).toVar();
            const macroBase = uint(hybridWordOffset).add(
              macroIndex.mul(uint(MACRO_CELL_WORDS)),
            ).toVar();
            const metadata = bits.element(
              macroBase.add(uint(MACRO_CELL_METADATA_WORD)),
            ).toVar();
            const cellType = bitAnd(
              shiftRight(metadata, uint(MACRO_CELL_TYPE_SHIFT)),
              uint(MACRO_CELL_TYPE_MASK),
            ).toVar();
            // DynamicBrick cells read the per-chain DYNAMIC record tail, like
            // the plane trace: an axis-aligned voxel staircase ALWAYS
            // protrudes above a rotated surface (user-diagnosed), so a mover
            // face's lifted shadow origins sit inside their own bulged voxel
            // AABBs — a record-blind oracle read ~0 free space there and the
            // BURIAL GATE forced one dark blob per staircase tooth (the
            // teardrop rows on rotating faces, angle-independent, upstream of
            // the trace's own exclusion). The fitted plane is the unbiased
            // surface, so measuring against it gives the true clearance.
            const isStaticBrick = cellType.equal(uint(MacroCellType.Brick)).toVar();
            If(isStaticBrick.or(cellType.equal(uint(MacroCellType.DynamicBrick))), () => {
              const brickIndex = bits.element(
                macroBase.add(uint(MACRO_CELL_BRICK_INDEX_WORD)),
              ).toVar();
              If(
                brickIndex.lessThan(uint(hybridLayout.brickCount))
                  .and(brickIndex.notEqual(uint(INVALID_RAY_HIT_INDEX))),
                () => {
                  const brickBase = uint(hybridWordOffset + hybridLayout.brickHeaderOffset)
                    .add(brickIndex.mul(uint(BRICK_HEADER_WORDS))).toVar();
                  const surfOffset = select(
                    isStaticBrick,
                    bits.element(brickBase.add(uint(BRICK_SURFACE_OFFSET_WORD))),
                    bits.element(brickBase.add(uint(BRICK_DYNAMIC_OFFSET_WORD))),
                  ).toVar();
                  If(surfOffset.notEqual(uint(INVALID_RAY_HIT_INDEX)), () => {
                    const localCell = v.sub(macro.mul(float(BRICK_RESOLUTION)))
                      .clamp(vec3(0), vec3(BRICK_RESOLUTION - 1)).toVar();
                    const cellIndex = localCell.z.toUint().mul(uint(16))
                      .add(localCell.y.toUint().mul(uint(4)))
                      .add(localCell.x.toUint()).toVar();
                    const occupancyLow = bits.element(
                      brickBase.add(uint(BRICK_OCCUPANCY_LOW_WORD)),
                    ).toVar();
                    const occupancyHigh = bits.element(
                      brickBase.add(uint(BRICK_OCCUPANCY_HIGH_WORD)),
                    ).toVar();
                    // Records are RANK-addressed inside the brick mask — the
                    // same popcount the trace uses, so the two read the same
                    // record for the same voxel by construction.
                    const inLow = cellIndex.lessThan(uint(32));
                    const belowLow = select(
                      inLow,
                      shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                      uint(0xffffffff),
                    );
                    const belowHigh = select(
                      inLow,
                      uint(0),
                      shiftLeft(uint(1), bitAnd(cellIndex, uint(31))).sub(uint(1)),
                    );
                    const rank = countOneBits(bitAnd(occupancyLow, belowLow))
                      .add(countOneBits(bitAnd(occupancyHigh, belowHigh)));
                    const record = surfOffset.add(rank).toVar();
                    If(record.lessThan(uint(totalSurfaceCapacity)), () => {
                      const rBase = uint(surfaceWordOffset)
                        .add(record.mul(uint(SURFACE_RECORD_WORDS))).toVar();
                      const flagsWord = bits.element(rBase.add(uint(3))).toVar();
                      const simple = bitAnd(
                        shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                        uint(SURFACE_FLAG_SIMPLE),
                      );
                      If(simple.notEqual(uint(0)), () => {
                        // Same decode as traceHybridPlane's: word 0 is the
                        // octahedral voxel-space normal, word 1's low 16 bits
                        // the CELL-LOCAL plane offset in snorm16 units of
                        // CELL_LOCAL_PLANE_OFFSET_RANGE.
                        const nHat = octDecodeTSL(unpackSnorm2x16(bits.element(rBase))).toVar();
                        const dPlane = unpackSnorm2x16(bits.element(rBase.add(uint(1)))).x
                          .mul(CELL_LOCAL_PLANE_OFFSET_RANGE).toVar();
                        const planeVox = nHat.dot(q0.sub(v)).sub(dPlane).abs().toVar();
                        const planeWorld = planeVox.sub(float(RECORD_PLANE_SLACK))
                          .max(0).mul(minVoxelWorld).toVar();
                        contribution.assign(contribution.max(planeWorld));
                      });
                      if (complexEnabled) {
                        // COMPLEX cells (a caster's EDGES — two faces per
                        // cell) were the oracle's remaining blind spot: no
                        // simple plane meant the AABB gap again, which buried
                        // every lifted origin near an edge (the user's "only
                        // near edge artifacts left"). Sharpen with EXACT
                        // point-triangle distance over the cell's list —
                        // cheaper bounds are not enough here: pool triangles
                        // are UNCLIPPED, so a rotated side-face's AABB can
                        // contain the origin while its plane passes near the
                        // edge; only the true distance (closest point is the
                        // edge itself) reports the full lift clearance.
                        // Ericson region classification, mirroring
                        // closestPointOnTriangleCpu branch for branch.
                        const complexFlag = bitAnd(
                          shiftRight(flagsWord, uint(COVERAGE_FLAGS_SHIFT)),
                          uint(SURFACE_FLAG_COMPLEX),
                        );
                        If(complexFlag.notEqual(uint(0)), () => {
                          const range = bits.element(rBase.add(uint(2))).toVar();
                          const poolOffset = bitAnd(range, uint(COMPLEX_RANGE_OFFSET_MASK)).toVar();
                          const triCount = bitAnd(
                            shiftRight(range, uint(COMPLEX_RANGE_COUNT_SHIFT)),
                            uint(COMPLEX_RANGE_COUNT_MASK),
                          ).toVar();
                          const triDist = float(1e9).toVar();
                          Loop({ start: 0, end: MAX_COMPLEX_TRIANGLES, name: "nfTri" }, ({ nfTri }) => {
                            If(nfTri.toUint().greaterThanEqual(triCount), () => {
                              Break();
                            });
                            const w = uint(trianglePoolWordOffset).add(
                              poolOffset.add(nfTri.toUint()).mul(uint(COMPLEX_TRIANGLE_WORDS)),
                            ).toVar();
                            const a = vec3(
                              uintBitsToFloat(bits.element(w)),
                              uintBitsToFloat(bits.element(w.add(uint(1)))),
                              uintBitsToFloat(bits.element(w.add(uint(2)))),
                            ).add(v).toVar();
                            const b = vec3(
                              uintBitsToFloat(bits.element(w.add(uint(3)))),
                              uintBitsToFloat(bits.element(w.add(uint(4)))),
                              uintBitsToFloat(bits.element(w.add(uint(5)))),
                            ).add(v).toVar();
                            const c = vec3(
                              uintBitsToFloat(bits.element(w.add(uint(6)))),
                              uintBitsToFloat(bits.element(w.add(uint(7)))),
                              uintBitsToFloat(bits.element(w.add(uint(8)))),
                            ).add(v).toVar();
                            const ab = b.sub(a).toVar();
                            const ac = c.sub(a).toVar();
                            const ap = q0.sub(a).toVar();
                            const d1 = ab.dot(ap).toVar();
                            const d2 = ac.dot(ap).toVar();
                            const cq = vec3(a).toVar(); // vertex-A default
                            const cqDone = float(0).toVar();
                            If(d1.lessThanEqual(0).and(d2.lessThanEqual(0)), () => {
                              cqDone.assign(1);
                            });
                            const bp = q0.sub(b).toVar();
                            const d3 = ab.dot(bp).toVar();
                            const d4 = ac.dot(bp).toVar();
                            If(cqDone.lessThan(0.5).and(d3.greaterThanEqual(0)).and(d4.lessThanEqual(d3)), () => {
                              cq.assign(b);
                              cqDone.assign(1);
                            });
                            const vcT = d1.mul(d4).sub(d3.mul(d2)).toVar();
                            If(cqDone.lessThan(0.5).and(vcT.lessThanEqual(0)).and(d1.greaterThanEqual(0)).and(d3.lessThanEqual(0)), () => {
                              const t = d1.div(d1.sub(d3).max(1e-20));
                              cq.assign(a.add(ab.mul(t)));
                              cqDone.assign(1);
                            });
                            const cp = q0.sub(c).toVar();
                            const d5 = ab.dot(cp).toVar();
                            const d6 = ac.dot(cp).toVar();
                            If(cqDone.lessThan(0.5).and(d6.greaterThanEqual(0)).and(d5.lessThanEqual(d6)), () => {
                              cq.assign(c);
                              cqDone.assign(1);
                            });
                            const vbT = d5.mul(d2).sub(d1.mul(d6)).toVar();
                            If(cqDone.lessThan(0.5).and(vbT.lessThanEqual(0)).and(d2.greaterThanEqual(0)).and(d6.lessThanEqual(0)), () => {
                              const t = d2.div(d2.sub(d6).max(1e-20));
                              cq.assign(a.add(ac.mul(t)));
                              cqDone.assign(1);
                            });
                            const vaT = d3.mul(d6).sub(d5.mul(d4)).toVar();
                            If(
                              cqDone.lessThan(0.5).and(vaT.lessThanEqual(0))
                                .and(d4.sub(d3).greaterThanEqual(0))
                                .and(d5.sub(d6).greaterThanEqual(0)),
                              () => {
                                const t = d4.sub(d3).div(d4.sub(d3).add(d5.sub(d6)).max(1e-20));
                                cq.assign(b.add(c.sub(b).mul(t)));
                                cqDone.assign(1);
                              },
                            );
                            If(cqDone.lessThan(0.5), () => {
                              const sum = vaT.add(vbT).add(vcT).toVar();
                              // Degenerate (sum <= 0) keeps the vertex-A
                              // default, matching the CPU helper.
                              If(sum.greaterThan(0), () => {
                                const inv = float(1).div(sum);
                                cq.assign(a.add(ab.mul(vbT.mul(inv))).add(ac.mul(vcT.mul(inv))));
                              });
                            });
                            triDist.assign(triDist.min(q0.sub(cq).length()));
                          });
                          If(triCount.greaterThan(uint(0)), () => {
                            const triWorld = triDist.sub(float(RECORD_PLANE_SLACK))
                              .max(0).mul(minVoxelWorld).toVar();
                            contribution.assign(contribution.max(triWorld));
                          });
                        });
                      }
                    });
                  });
                },
              );
            });
          });
          nearest.assign(nearest.min(select(occ.greaterThan(0.5), contribution, float(1e9))));
        }
      });
      // Distance from `q0` to the boundary of the 3×3×3 block, per axis:
      // `q0 - cell` is in [0, 1), so this is at least one voxel.
      const local = q0.sub(cell).toVar();
      const inset = local.add(1).min(vec3(2).sub(local)).mul(voxelWorld).toVar();
      best.assign(nearest.min(inset.x.min(inset.y).min(inset.z)));
    }

    // ── FAR FIELD: the level ladder ──────────────────────────────────────────
    // Only useful above whatever the near field already proved, so it starts at
    // level 1 — and it is skipped entirely when the near field found geometry
    // (every coarser level containing that voxel reads occupied anyway).
    // `maxLevel`/`nearField` still pick a VARIANT (they bound the loop), but
    // within the variant the level is a runtime value resolved through the
    // same levelSelect chains the DDA uses.
    const topEmpty = float(0).toVar();
    const startLevel = nearField ? 1 : 0;
    if (top >= startLevel) {
      Loop({ start: startLevel, end: top + 1, name: "lv" }, ({ lv: L }) => {
        const scale = levelSelect(L, (l) => l.scale).toVar();
        const q = q0.div(scale).toVar();
        // Low corner of the 2×2×2 block whose centre `q` sits in.
        const base = q.sub(0.5).floor().toVar();
        const occupied = float(0).toVar();
        Loop({ start: 0, end: 8, name: "cr" }, ({ cr }) => {
          const cx = bitAnd(cr, int(1)).toFloat();
          const cy = bitAnd(shiftRight(cr, int(1)), int(1)).toFloat();
          const cz = bitAnd(shiftRight(cr, int(2)), int(1)).toFloat();
          occupied.addAssign(occupiedAt(base.add(vec3(cx, cy, cz)), L));
        });
        // `q - base` lands in [0.5, 1.5), so this lands in [0.5, 1] level-L voxels.
        const local = q.sub(base).toVar();
        const inset = local.min(vec3(2).sub(local)).mul(voxelWorld).mul(scale).toVar();
        const bound = inset.x.min(inset.y).min(inset.z);
        best.assign(select(occupied.lessThan(0.5), best.max(bound), best));
        If(L.equal(int(top)), () => {
          topEmpty.assign(select(occupied.lessThan(0.5), float(1), float(0)));
        });
      });
    }

    // SATURATE LIKE A DISTANCE FIELD DOES, and this is not cosmetic.
    //
    // The oracle's ceiling is its own geometry: `voxel · 2^(levels-1)`, about
    // 2 m. A baked SDF's ceiling is `capWorld = 16 · minCell`, about 5.6 m. Both
    // mean "far away", but consumers do not read them that way — the shadow
    // trace's `isRealOccluder` has an explicit `d < capCut` (0.85·capWorld) test
    // whose whole job is to recognise a CAP-SATURATED sample as open space and
    // refuse to treat it as an occluder. A distance that tops out at 2 m never
    // reaches a 4.76 m cut, so that test silently inverted: every open-space
    // sample past a couple of metres counted as a real occluder, `min(k·d/t)`
    // drove the penumbra down everywhere, and the direct light injected into
    // the field came out several times too dim. The symptom is a scene that
    // looks correct in shape but needs GI intensity ~10 to read at all.
    //
    // An empty 2×2×2 at the COARSEST level is a proof of emptiness over ~4 m,
    // which is what "cap" has always meant here. Reporting `capWorld` there is
    // the same overestimate the SDF makes, bounded by the same `stepMax` clamp
    // and backstopped by the same occupancy hard block.
    if (cap != null) {
      return select(topEmpty.greaterThan(0.5), float(cap), best);
    }
    return best;
  };

  // ONE WGSL FUNCTION PER SHADER PER VARIANT (sharedFn — see giFn.js). The
  // body above expands to 27 near-field bit fetches plus 8 per ladder level,
  // and the composite alone used to stamp it SEVEN times (once for the
  // distance, six for the normal gradient) — the single biggest reason its
  // kernel reached 782kB of WGSL, which the driver took ~27 SECONDS to
  // compile while every other pipeline queued behind it (harness-measured
  // 2026-08-02; that queue WAS the "materials preparation" startup hang).
  // `maxLevel`/`nearField` change the UNROLLING, so they select a variant;
  // only `p` and the saturation cap are runtime parameters.
  //
  // `recordAware` is the fourth variant dimension and a BUILD-TIME boolean for
  // the same reason: it adds a record chain to the near-field loop that must be
  // COMPILED OUT of every other consumer, not predicated away. The A/B arm's
  // WGSL is then byte-identical to before Phase 5 — the composite, the AO taps
  // and the probe-burial ramp all keep the exact function they had.
  const freeRadiusVariants = new Map();
  /**
   * @param {*} p world position
   * @param {number} [maxLevel] highest pyramid level to consult
   * @param {boolean} [nearField] run the 27-voxel near field
   * @param {*} [saturateValue] value reported when the coarsest level is empty
   * @param {boolean} [recordAware] sharpen occupied near-field neighbours with
   *   their fitted SIMPLE plane record. Silently ignored when this field was
   *   built without surface records — there is nothing to read.
   */
  const freeRadiusAtWorld = (p, maxLevel = OCC_LEVELS - 1, nearField = true, saturateValue = null, recordAware = false) => {
    const top = Math.max(0, Math.min(OCC_LEVELS - 1, maxLevel));
    const sat = saturateValue != null;
    const rec = recordAware === true && surfaceEnabled && nearField;
    const key = `${top}|${nearField ? 1 : 0}|${sat ? 1 : 0}|${rec ? 1 : 0}`;
    let fn = freeRadiusVariants.get(key);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giFreeRadius${top}${nearField ? "n" : ""}${sat ? "s" : ""}${rec ? "r1" : ""}`,
        type: "float",
        inputs: sat
          ? [{ name: "p", type: "vec3" }, { name: "cap", type: "float" }]
          : [{ name: "p", type: "vec3" }],
        body: sat
          ? (pp, cap) => freeRadiusBody(pp, top, nearField, cap, rec)
          : (pp) => freeRadiusBody(pp, top, nearField, null, rec),
      });
      freeRadiusVariants.set(key, fn);
    }
    return sat ? fn(p, saturateValue) : fn(p);
  };

  /**
   * COVERAGE ORACLE (coverage-weighted injection — GI_MOTION_PERF_PLAN §5.1).
   * Fraction of a world-space box (a radiance-FIELD cell, 2-3 occupancy
   * voxels per axis at every preset) covered by level-0 bits, normalized so
   * a flat surface crossing the box reads ≈ 1: occupied-voxel count over the
   * box's largest cross-section in voxels (an axis-aligned plane sets exactly
   * that many; oblique planes set more and clamp at 1).
   *
   * WHY: the field's injection was BINARY per cell — a 5%-covered edge voxel
   * of a mover injected like a solid wall cell, so a rotating object's bounce
   * light lurched in whole field-cell quanta (and every past-MAX_EMITTERS
   * emissive, whose light lives ONLY in the field, flickered blockily).
   * Surface AREA is the frame-to-frame invariant of a rigid mover; weighting
   * injection by this count restores that conservation, so motion
   * redistributes energy between cells instead of popping it.
   *
   * Bounded 4 voxels/axis (64 taps, early-skip beyond the span — headroom,
   * not truncation, at shipped presets). A zero count means the composite's
   * occupancy came from something this window cannot see (coarse-level OR,
   * slot SDF) — report the NEUTRAL 1, never a kill: this oracle only ever
   * DIMS partially-covered cells, exactly like the record-aware free radius
   * only ever sharpens.
   */
  const coverageInBoxFn = sharedFn({
    name: "giCoverageInBox",
    type: "float",
    inputs: [
      { name: "center", type: "vec3" },
      { name: "half", type: "vec3" },
    ],
    body: (center, half) => {
      const inv = vec3(voxelInv).toVar();
      const lo = vec3(center).sub(vec3(half)).sub(vec3(gridOrigin)).mul(inv).floor().toVar();
      const span = vec3(half).mul(2).mul(inv).ceil().clamp(vec3(1), vec3(4)).toVar();
      const count = float(0).toVar();
      Loop({ start: 0, end: 64, name: "cvi" }, ({ cvi }) => {
        const cx = cvi.mod(int(4)).toFloat();
        const cy = cvi.div(int(4)).mod(int(4)).toFloat();
        const cz = cvi.div(int(16)).toFloat();
        If(cx.lessThan(span.x).and(cy.lessThan(span.y)).and(cz.lessThan(span.z)), () => {
          count.addAssign(occupiedAtLevel0(lo.add(vec3(cx, cy, cz))));
        });
      });
      const K = span.x.mul(span.y).max(span.y.mul(span.z)).max(span.x.mul(span.z));
      return select(count.lessThan(0.5), float(1), count.div(K).clamp(0, 1));
    },
  });
  const coverageInBox = (center, half) => coverageInBoxFn(center, half);

  // ═══════════════════════════════════════════════════════════ CPU: geometry
  /**
   * Uploads the scene's unique geometries and the (slot, triangle, chunk) work
   * list. Call when the SLOT SET or any slot's SCALE changes — NOT when
   * something merely moves or rotates: chunk counts come from a
   * ROTATION-INVARIANT bound (the triangle's local extent × the matrix's
   * largest column length), so a drag is a matrix-uniform update plus a
   * redispatch, with no CPU walk and no reupload. That is the same property the
   * slot-uniform SDF path has, and losing it would make every drag cost a full
   * triangle pass.
   *
   * @param {{key: string, positions: Float32Array, index: ArrayLike<number>|null}[]} geometries unique, deduped by key
   * @param {{slot: number, geometryKey: string, matrix: THREE.Matrix4}[]} placements one per instance slot
   */
  // Longest local axis per triangle — rotation-invariant chunk sizing.
  // Computed from the SOURCE record (not the concatenated arrays) so it can
  // run before an incremental commit and be cached purely by content key.
  const computeExtents = (g) => {
    const verts = Math.floor(g.positions.length / 3);
    const triCount = Math.floor((g.index ? g.index.length : verts) / 3);
    const ext = new Float32Array(triCount);
    for (let ti = 0; ti < triCount; ti++) {
      const a = (g.index ? g.index[ti * 3 + 0] : ti * 3 + 0) * 3;
      const b = (g.index ? g.index[ti * 3 + 1] : ti * 3 + 1) * 3;
      const c = (g.index ? g.index[ti * 3 + 2] : ti * 3 + 2) * 3;
      let longest = 0;
      for (let axis = 0; axis < 3; axis++) {
        const va = g.positions[a + axis], vb = g.positions[b + axis], vc = g.positions[c + axis];
        longest = Math.max(longest, Math.max(va, vb, vc) - Math.min(va, vb, vc));
      }
      ext[ti] = longest;
    }
    return ext;
  };

  const matrixMaxScale = (matrix) => {
    const e = matrix.elements;
    return Math.max(
      Math.hypot(e[0], e[1], e[2]),
      Math.hypot(e[4], e[5], e[6]),
      Math.hypot(e[8], e[9], e[10]),
    );
  };

  // Chunk counts for one (placement, geometry) pair. A triangle spanning `n`
  // voxels on its longest axis can touch at most (n+2)³ voxels; chunking on
  // that bound over-allocates for thin triangles, and an empty chunk costs one
  // comparison in the shader (`k >= total` on the first iteration). Over-
  // allocating is the SAFE direction — an under-allocated chunk count silently
  // drops voxels, which is a leak, which is the entire bug this module exists
  // to fix. `density` = worldScale / minVoxel, recorded per slot so a scale-up
  // (or a refit that shrinks voxels) re-appends instead of under-chunking.
  const countPairsFor = (ext, density) => {
    let n = 0;
    for (let ti = 0; ti < ext.length; ti++) {
      const span = Math.ceil(ext[ti] * density) + 2;
      n += Math.max(1, Math.ceil((span * span * span) / CHUNK_VOXELS));
    }
    return n;
  };

  const writePairsFor = (slot, range, ext, density, at) => {
    let cursor = at;
    for (let ti = 0; ti < ext.length; ti++) {
      const span = Math.ceil(ext[ti] * density) + 2;
      const n = Math.max(1, Math.ceil((span * span * span) / CHUNK_VOXELS));
      for (let c = 0; c < n; c++) {
        pairSlotArr[cursor] = slot;
        pairTriArr[cursor] = range.triStart + ti;
        pairChunkArr[cursor] = c;
        cursor++;
      }
    }
    return cursor - at;
  };

  // Writes one geometry into the concatenated arrays at the current cursors.
  const appendGeometryData = (g) => {
    const verts = Math.floor(g.positions.length / 3);
    const triCount = Math.floor((g.index ? g.index.length : verts) / 3);
    const r = { vertexStart: vertexUsed, triStart: triUsed, triCount, verts };
    for (let i = 0; i < verts; i++) {
      vdataArr[(r.vertexStart + i) * 4 + 0] = g.positions[i * 3 + 0];
      vdataArr[(r.vertexStart + i) * 4 + 1] = g.positions[i * 3 + 1];
      vdataArr[(r.vertexStart + i) * 4 + 2] = g.positions[i * 3 + 2];
    }
    const base = r.triStart * 3;
    const corners = r.triCount * 3;
    if (g.index) {
      for (let i = 0; i < corners; i++) idataArr[base + i] = r.vertexStart + g.index[i];
    } else {
      for (let i = 0; i < corners; i++) idataArr[base + i] = r.vertexStart + i;
    }
    vertexUsed += verts;
    triUsed += triCount;
    geoRanges.set(g.key, r);
    if (!extentsCache.has(g.key)) extentsCache.set(g.key, computeExtents(g));
    return r;
  };

  /**
   * FULL rebuild: fresh arrays WITH HEADROOM, fresh buffer nodes, compute
   * chain rebuild (geometryRevision), full re-voxelize. Runs on the first
   * build and whenever the incremental path can't absorb the change.
   */
  const rebuildGeometryBuffers = (geometries, placements) => {
    geoRanges = new Map();
    let vertexTotal = 0, triTotal = 0;
    for (const g of geometries) {
      const verts = Math.floor(g.positions.length / 3);
      vertexTotal += verts;
      triTotal += Math.floor((g.index ? g.index.length : verts) / 3);
    }
    vertexCap = Math.ceil(vertexTotal * 1.3) + 1024;
    triCap = Math.ceil(triTotal * 1.3) + 1024;
    vdataArr = new Float32Array(vertexCap * 4);
    idataArr = new Uint32Array(triCap * 3);
    vertexUsed = 0;
    triUsed = 0;
    for (const g of geometries) appendGeometryData(g);

    const minVoxel = Math.min(voxel.value.x, voxel.value.y, voxel.value.z);
    let pairTotal = 0;
    const perPlacement = [];
    for (const p of placements) {
      const r = geoRanges.get(p.geometryKey);
      if (!r) continue;
      const ext = extentsCache.get(p.geometryKey);
      const density = matrixMaxScale(p.matrix) / minVoxel;
      perPlacement.push({ p, r, ext, density });
      pairTotal += countPairsFor(ext, density);
    }
    pairCap = Math.ceil(pairTotal * 1.4) + 4096;
    pairSlotArr = new Uint32Array(pairCap);
    pairTriArr = new Uint32Array(pairCap);
    pairChunkArr = new Uint32Array(pairCap);
    // Unwritten tail entries read slot 0 — harmless, the dispatch count never
    // reaches them; the sentinel is only needed for TOMBSTONED live ranges.
    slotPairInfo = new Map();
    enabledSlots = new Set();
    pairCount = 0;
    for (const { p, r, ext, density } of perPlacement) {
      const count = writePairsFor(p.slot, r, ext, density, pairCount);
      slotPairInfo.set(p.slot, { start: pairCount, count, key: p.geometryKey, chunkDensity: density });
      enabledSlots.add(p.slot);
      pairCount += count;
    }

    vertexBuffer = instancedArray(vdataArr, "vec4");
    indexBuffer = instancedArray(idataArr, "uint");
    pairSlot = instancedArray(pairSlotArr, "uint");
    pairTri = instancedArray(pairTriArr, "uint");
    pairChunk = instancedArray(pairChunkArr, "uint");
    pairComputes = [];
    geometryRevision++;

    stats.triangles = triTotal;
    stats.pairs = pairCount;
    stats.slots = placements.length;
    staticDirty = true;
    dirty = true;
  };

  /**
   * INCREMENTAL path — the spawn/despawn fast lane. Absorbs a changed mesh
   * set into the existing allocations when everything fits:
   *   · new geometry keys append into the vertex/index headroom (partial
   *     GPU upload via updateRanges);
   *   · new placements (and placements whose geometry/scale changed) append
   *     pair ranges at the tail and bump the live dispatch count on the
   *     cached compute nodes (ComputeNode.count is read per dispatch and its
   *     bounds guard is a uniform — no recompile);
   *   · vanished placements are DISABLED (slotDynamic = 2), tombstoning
   *     nothing; a replaced range rewrites its pairSlot entries to the
   *     sentinel slot so both voxelize variants skip it;
   *   · brand-new slots are flagged DYNAMIC directly (no staticDirty — they
   *     have no bits in the snapshot), so a spawned mover rides the FAST
   *     chain the same frame instead of forcing a full re-voxelize.
   * Returns false when something doesn't fit — caller falls back to the full
   * rebuild above.
   */
  const tryIncrementalSetGeometry = (geometries, placements) => {
    if (!vdataArr || geometryRevision === 0) return false;
    const geomByKey = new Map(geometries.map((g) => [g.key, g]));

    // Validate geometry appends against the headroom.
    let nv = 0, nt = 0;
    for (const g of geometries) {
      if (geoRanges.has(g.key)) continue;
      const verts = Math.floor(g.positions.length / 3);
      nv += verts;
      nt += Math.floor((g.index ? g.index.length : verts) / 3);
    }
    if (vertexUsed + nv > vertexCap || triUsed + nt > triCap) return false;

    // Classify placements; count the pair appends before mutating anything.
    const minVoxel = Math.min(voxel.value.x, voxel.value.y, voxel.value.z);
    const appends = [];
    let newPairs = 0;
    for (const p of placements) {
      if (p.slot < 0 || p.slot >= slotCapacity) return false;
      const info = slotPairInfo.get(p.slot);
      const density = matrixMaxScale(p.matrix) / minVoxel;
      if (info && info.key === p.geometryKey && density <= info.chunkDensity * 1.02) continue;
      const g = geomByKey.get(p.geometryKey);
      if (!g && !geoRanges.has(p.geometryKey)) continue; // mirror of the old `if (!r) continue`
      const ext = extentsCache.get(p.geometryKey) ?? computeExtents(g);
      if (!extentsCache.has(p.geometryKey)) extentsCache.set(p.geometryKey, ext);
      appends.push({ p, ext, density, old: info ?? null });
      newPairs += countPairsFor(ext, density);
    }
    if (pairCount + newPairs > pairCap) return false;

    // ── Commit.
    let geoDirty = false;
    for (const g of geometries) {
      if (geoRanges.has(g.key)) continue;
      const before = { v: vertexUsed, t: triUsed };
      const r = appendGeometryData(g);
      vertexBuffer.value.addUpdateRange(before.v * 4, r.verts * 4);
      indexBuffer.value.addUpdateRange(before.t * 3, r.triCount * 3);
      geoDirty = true;
    }
    if (geoDirty) {
      vertexBuffer.value.needsUpdate = true;
      indexBuffer.value.needsUpdate = true;
    }

    let pairsDirty = false;
    for (const { p, ext, density, old } of appends) {
      if (old) {
        // Replaced range: point its entries at the sentinel slot so every
        // variant skips them. A STATIC slot whose geometry/scale changed has
        // stale bits in the snapshot — that one genuinely needs a full pass.
        pairSlotArr.fill(slotCapacity, old.start, old.start + old.count);
        pairSlot.value.addUpdateRange(old.start, old.count);
        pairsDirty = true;
        if (slotDynamic.array[p.slot] === 0) staticDirty = true;
      }
      const range = geoRanges.get(p.geometryKey);
      const count = writePairsFor(p.slot, range, ext, density, pairCount);
      pairSlot.value.addUpdateRange(pairCount, count);
      pairTri.value.addUpdateRange(pairCount, count);
      pairChunk.value.addUpdateRange(pairCount, count);
      slotPairInfo.set(p.slot, { start: pairCount, count, key: p.geometryKey, chunkDensity: density });
      pairCount += count;
      pairsDirty = true;
      // Brand-new slot: spawn it on the DYNAMIC side directly — it has no
      // footprint in the static snapshot, so no staticDirty. GISystem's
      // quiet-frames demotion settles it to static if it stops moving.
      if (!old && slotDynamic.array[p.slot] === 0) {
        slotDynamic.array[p.slot] = 1;
        dynamicCount += 1;
      }
    }
    if (pairsDirty) {
      pairSlot.value.needsUpdate = true;
      pairTri.value.needsUpdate = true;
      pairChunk.value.needsUpdate = true;
      for (const c of pairComputes) c.count = Math.max(1, pairCount);
    }

    // Presence diff: despawned slots disable, returning slots re-enable.
    const current = new Set();
    for (const p of placements) current.add(p.slot);
    for (const slot of enabledSlots) if (!current.has(slot)) setSlotEnabled(slot, false);
    for (const slot of current) if (!enabledSlots.has(slot)) setSlotEnabled(slot, true);
    enabledSlots = current;

    stats.pairs = pairCount;
    stats.slots = placements.length;
    stats.triangles = triUsed;
    stats.incrementalUpdates = (stats.incrementalUpdates ?? 0) + 1;
    dirty = true;
    return true;
  };

  const setGeometry = (geometries, placements) => {
    const t0 = performance.now();
    if (!tryIncrementalSetGeometry(geometries, placements)) {
      rebuildGeometryBuffers(geometries, placements);
    }
    stats.buildMs = performance.now() - t0;
  };

  /** Updates one slot's local→world matrix. Cheap — this is the drag path. */
  const setSlotMatrix = (slot, matrix) => {
    if (slot < 0 || slot >= slotCapacity) return;
    // No-op writes are common (every fingerprint scan re-sends every matrix)
    // and must not invalidate the static snapshot below.
    if (localToWorld.array[slot].equals(matrix)) return;
    localToWorld.array[slot].copy(matrix);
    // Self-defence for the split: a matrix write on a slot still flagged
    // STATIC invalidates the snapshot (its baked footprint moved). GISystem
    // flags movers dynamic before writing, so this fires only on the first
    // frame of an unannounced move — one full pass, then fast ones.
    if (slotDynamic.array[slot] === 0) staticDirty = true;
    dirty = true;
  };

  let computes = null;
  let computesRevision = -1;
  let jitterFrame = 0;

  return {
    levels,
    res: res0,
    // Surface attribution for the composite — see `cellAttr`'s comment. The
    // getter matters: `setCoarseRes` REPLACES the buffer, so a consumer that
    // captured the property at module scope would hold the 1-element
    // placeholder forever.
    get cellAttr() {
      return cellAttr;
    },
    slotAtlas,
    setSlotAtlas,
    setCoarseRes,
    bits,
    stats,
    voxel,
    voxelInv,
    localToWorld,

    /** True when the pyramid needs re-running (geometry or a transform changed). */
    get isDirty() {
      return dirty;
    },
    invalidate() {
      // Conservative by design: invalidate is the async-pipeline retry path
      // (GISystem re-arms after skipped dispatches), and a skipped FULL chain
      // may have skipped the snapshot writes — a fast replay of that
      // snapshot would restore garbage. Forcing the full chain costs one
      // extra full voxelize during pipeline warmup only.
      staticDirty = true;
      dirty = true;
    },

    setGeometry,
    setSlotMatrix,
    setSlotEnabled,
    /** Harness diagnostics for the incremental path (run-gi-spawn-test). */
    get debugIncremental() {
      return {
        pairCount, pairCap, vertexUsed, vertexCap, triUsed, triCap,
        geometryRevision, dynamicCount, staticDirty, dirty,
        pairComputeCounts: pairComputes.map((c) => c.count),
        enabledSlots: [...enabledSlots],
        slotDynamic: slotDynamic.array.slice(0, 12),
        slotPairInfo: [...slotPairInfo.entries()].map(([slot, i]) => ({ slot, ...i })),
      };
    },
    debugPairBuffers: () => ({ pairSlot, pairTri, pairChunk, vertexBuffer, indexBuffer }),
    setSlotDynamic,
    slotCapacity,
    /**
     * Bumped by `setGeometry` only — NOT by `setSlotMatrix`. Consumers use it
     * to answer "has the pyramid's CONTENT changed", which a per-frame
     * transform update has not. GISystem drives the composite off it, because
     * with no mesh-SDF bakes arriving there is nothing else to signal that the
     * field the composite reads has just been repopulated.
     */
    get geometryRevision() {
      return geometryRevision;
    },

    /** Re-derives world voxel size after an in-place volume refit. */
    refit() {
      syncVoxel();
      syncStats();
      staticDirty = true; // a refit re-scales voxel space — every baked bit moved
      dirty = true;
    },

    /**
     * The dispatch chain, in order: clear → clearAttr → voxelize → copy → downsample×4.
     * Returns null when there is no geometry, so an empty scene costs nothing
     * and cannot dispatch the voxelizer against a placeholder work item.
     */
    passes() {
      dirty = false;
      if (pairCount === 0) return null;
      // TEMPORAL ANTI-ALIASING OF THE FOOTPRINT (opt-in, `__giVoxelJitter` =
      // amplitude in voxels, sensible range 0.25–0.5, 0/off = today). A
      // moving object re-voxelizes every frame and its footprint SNAPS in
      // whole voxels — the root of the object-motion flicker (every shadow
      // ray, DDA hit and probe interval downstream pulses in lockstep with
      // those snaps). Offsetting the WHOLE grid by a sub-voxel R3 sequence
      // per re-dispatch dithers the snap; the probe EMA then integrates the
      // dither into fractional coverage. Every consumer (voxelizer, DDA,
      // oracle, CPU stats) reads the same `gridOrigin` uniform, so the shift
      // is globally consistent — and when nothing moves, passes() stops
      // running, the origin freezes, and the static image stays bit-stable
      // (the 15c zero-flicker-when-static rule holds).
      const jitterAmp = globalThis.__giVoxelJitter ?? 0;
      if (jitterAmp > 0) {
        // The static snapshot was voxelized at a specific grid origin — a
        // jittered origin invalidates it every dispatch, so the split and the
        // (default-off, do-not-enable) grid jitter are mutually exclusive.
        staticDirty = true;
        jitterFrame = (jitterFrame + 1) % 4096;
        // R3 low-discrepancy offsets in [-0.5, 0.5).
        const jx = ((jitterFrame * 0.8191725133961645) % 1) - 0.5;
        const jy = ((jitterFrame * 0.6710436067037893) % 1) - 0.5;
        const jz = ((jitterFrame * 0.5497004779019703) % 1) - 0.5;
        gridOrigin.value.set(
          bounds.min.x + jx * jitterAmp * voxel.value.x,
          bounds.min.y + jy * jitterAmp * voxel.value.y,
          bounds.min.z + jz * jitterAmp * voxel.value.z,
        );
      }
      if (computesRevision !== geometryRevision) {
        // Two chains, both cached until the geometry buffers change:
        //   FULL — clear, voxelize the static side, snapshot it, then add the
        //          dynamic side. With no dynamic slots the static pass covers
        //          everything and the snapshot is simply the whole scene.
        //   FAST — replay the snapshot (2 copies) + dynamic side only. Runs
        //          on every frame where only dynamic transforms changed —
        //          the game steady state this split exists for.
        //
        // The Phase-2 surface build (and the Phase-4 triangle pool that hangs
        // off it) rides the FULL chain only, wedged between the static
        // voxelize and the dynamic one: an extra copy+hybridBuild lands the
        // STATIC-ONLY state in the pyramid/brick tail, the surface passes
        // allocate and fit against those static masks, and only then does the
        // dynamic side stack on top. Fast chains never touch the STATIC
        // records or their pool — static bits cannot have changed.
        //
        // The DYNAMIC record tail is the opposite: it rides EVERY chain, after
        // the final hybridBuild, so bricks typed DynamicBrick get fresh
        // fitted-plane records ranked against the merged masks that same
        // dispatch. That is what keeps a mover's shadow silhouette exact
        // while it moves — before this, DynamicBrick meant box semantics for
        // the whole promote window.
        const voxStatic = buildVoxelizeCompute("static");
        const voxDynamic = buildVoxelizeCompute("dynamic");
        const surfAccumStatic = surfaceEnabled ? buildSurfAccumCompute() : null;
        const surfAccumDynamic = surfaceEnabled ? buildSurfAccumCompute("dynamic") : null;
        const complexStatic = surfaceEnabled && buildComplexWriteCompute ? buildComplexWriteCompute() : null;
        const complexDynamic = surfaceEnabled && buildComplexWriteCompute ? buildComplexWriteCompute("dynamic") : null;
        // Every compute dispatched over the pair work-list, so the incremental
        // setGeometry path can bump their live dispatch count (ComputeNode
        // .count is read per dispatch; its bounds guard is a uniform).
        pairComputes = [voxStatic, voxDynamic, surfAccumStatic, surfAccumDynamic, complexStatic, complexDynamic]
          .filter(Boolean);
        const surfaceChain = surfaceEnabled
          ? [
              copyCompute, hybridBuildCompute,
              surfClearCompute, surfAllocCompute,
              surfAccumStatic, surfFinalizeCompute,
              // Phase 4 rides the same FULL chain: finalize reserves the
              // triangle ranges, this fills them.
              ...(complexStatic ? [complexStatic] : []),
            ]
          : [];
        const dynamicSurfaceChain = surfaceEnabled
          ? [
              dynSurfClearCompute, dynSurfAllocCompute,
              surfAccumDynamic, dynSurfFinalizeCompute,
              // Exact mode: the dynamic finalize reserved tail triangle
              // ranges; this fills them — mover edge cells resolve to real
              // triangles instead of boxes.
              ...(complexDynamic ? [complexDynamic] : []),
            ]
          : [];
        computes = {
          full: [
            // Fresh clear per geometry change — see buildClearCompute's note:
            // a stale compiled clear executing ahead of skipped fresh
            // voxelize nodes is the spawn-blink's empty-pyramid window.
            buildClearCompute(), buildClearAttrCompute(),
            voxStatic, snapStaticBitsCompute, buildSnapStaticAttrCompute(),
            ...surfaceChain,
            voxDynamic, copyCompute, ...downsampleComputes, ...densityComputes,
            ...(hybridBuildCompute ? [hybridBuildCompute] : []),
            ...dynamicSurfaceChain,
          ],
          fast: [
            restoreStaticBitsCompute, buildRestoreStaticAttrCompute(),
            voxDynamic, copyCompute, ...downsampleComputes, ...densityComputes,
            ...(hybridBuildCompute ? [hybridBuildCompute] : []),
            ...dynamicSurfaceChain,
          ],
        };
        computesRevision = geometryRevision;
        staticDirty = true; // fresh kernels → fresh snapshot before any fast replay
      }
      stats.dispatches++;
      const canFast =
        !staticDirty && dynamicCount > 0 && globalThis.__giNoStaticSplit !== true;
      if (canFast) {
        stats.fastDispatches = (stats.fastDispatches ?? 0) + 1;
        return computes.fast;
      }
      staticDirty = false;
      return computes.full;
    },

    traceOccupancy,
    traceOccupancyCone,
    traceHybridBrick,
    traceHybridPlane,
    coverageInBox,
    /** Density-region layout, for tests/diagnostics (offsets inside `bits`). */
    densityLayout: { wordOffset: densityWordOffset, levels: densityPlan.densityLevels },
    hybridLayout: hybridEnabled ? hybridLayout : null,
    /**
     * True when the `bits` tail carries SurfaceRecords, i.e. the active ray-hit
     * mode is a plane-family one. The signal consumers use to decide whether
     * `freeRadiusAtWorld`'s `recordAware` argument can do anything — `rayHitMode`
     * itself is not in scope where the traces are built.
     */
    hasSurfaceRecords: surfaceEnabled,
    surfaceCapacity,
    dynamicSurfaceCapacity,
    rayHitDebug,
    /**
     * Pool allocator readback [recordNext, overflowBricks, triangleNext,
     * complexOverflowCells, dynRecordNext, dynOverflowBricks, dynTriangleNext,
     * dynComplexOverflowCells] — diagnostics only. The dynamic quads describe
     * the LAST chain (the tail cursors reset every dispatch), so with a mover
     * live they are that frame's refit demand.
     */
    async readbackSurfaceAlloc(renderer) {
      if (!surfAlloc) return null;
      const data = new Uint32Array(await renderer.getArrayBufferAsync(surfAlloc.value));
      return {
        allocated: data[0] ?? 0,
        overflowBricks: data[1] ?? 0,
        capacity: surfaceCapacity,
        triangles: data[2] ?? 0,
        complexOverflowCells: data[3] ?? 0,
        triangleCapacity: complexTriangleCapacity,
        dynamicAllocated: data[4] ?? 0,
        dynamicOverflowBricks: data[5] ?? 0,
        dynamicCapacity: dynamicSurfaceCapacity,
        dynamicTriangles: data[6] ?? 0,
        dynamicComplexOverflowCells: data[7] ?? 0,
        dynamicTriangleCapacity: dynamicComplexTriangleCapacity,
      };
    },
    occupiedAtWorld,
    freeRadiusAtWorld,
    recordNormalAt,
    occupiedAt,

    /**
     * GPU→CPU pyramid download. DIAGNOSTIC ONLY — it stalls the pipeline.
     *
     * Returns a reader over the REAL bits the traces read, which is what makes
     * the harness able to decide the spec's acceptance criteria on the CPU: a
     * closed-box leak is "does every ray out of the room cross a set bit", and
     * the pyramid's correctness is "is every occupied voxel's parent occupied".
     * Both are exact questions about this array, so neither needs a screenshot.
     */
    async readbackBits(renderer) {
      const data = new Uint32Array(await renderer.getArrayBufferAsync(bits.value));
      let count = 0;
      for (let i = 0; i < level0.words; i++) {
        let w = data[level0.offset + i];
        while (w) { w &= w - 1; count++; }
      }
      stats.occupiedVoxels = count;
      const get = (x, y, z, L = 0) => {
        const l = levels[L];
        if (x < 0 || y < 0 || z < 0 || x >= l.res.x || y >= l.res.y || z >= l.res.z) return 0;
        const word = l.offset + (z * l.res.y + y) * l.wordsPerRow + (x >> 5);
        return (data[word] >>> (x & 31)) & 1;
      };
      // Density byte (0..255) of the level-L cell — the cone trace's medium.
      // Level 0 returns bit×255 so callers can treat all levels uniformly.
      const getDensity = (x, y, z, L = 1) => {
        if (L <= 0) return get(x, y, z, 0) * 255;
        const d = densityPlan.densityLevels[L - 1];
        if (!d || x < 0 || y < 0 || z < 0 || x >= d.res.x || y >= d.res.y || z >= d.res.z) return 0;
        const cIdx = (z * d.res.y + y) * d.res.x + x;
        return (data[densityWordOffset + d.offset + (cIdx >> 2)] >>> ((cIdx & 3) * 8)) & 255;
      };
      return {
        get,
        getDensity,
        levels,
        stats,
        origin: gridOrigin.value.clone(),
        voxel: voxel.value.clone(),
        /** World point → level-L integer voxel coords. */
        voxelOf(p, L = 0) {
          const s = 1 << L;
          return {
            x: Math.floor(((p.x - gridOrigin.value.x) * voxelInv.value.x) / s),
            y: Math.floor(((p.y - gridOrigin.value.y) * voxelInv.value.y) / s),
            z: Math.floor(((p.z - gridOrigin.value.z) * voxelInv.value.z) / s),
          };
        },
        /**
         * World direction → level-0 VOXEL-space direction. Voxels are only
         * cubic when the volume's aspect happens to match its resolution's, so
         * a DDA that steps in index space has to use this — otherwise a
         * diagonal ray walks a different path than the shader's and the two
         * disagree about what is sealed.
         */
        dirToVoxel(d) {
          return { x: d.x * voxelInv.value.x, y: d.y * voxelInv.value.y, z: d.z * voxelInv.value.z };
        },
      };
    },

    /** Occupied-voxel count only. */
    async readbackStats(renderer) {
      await this.readbackBits(renderer);
      return stats;
    },

    dispose() {},
  };
}

/** One-line summary for the build log. */
export function describeOccupancyField(field) {
  const s = field.stats;
  const l0 = s.levels[0];
  return (
    `${l0.x}x${l0.y}x${l0.z} @ ${s.voxelSize.toFixed(3)}m, ${OCC_LEVELS} levels, ` +
    `${(s.bytes / (1024 * 1024)).toFixed(2)}MB — ${s.triangles} tris in ${s.slots} slots ` +
    `→ ${s.pairs} work items (${s.buildMs.toFixed(0)}ms CPU)` +
    (s.occupiedVoxels >= 0 ? `, ${s.occupiedVoxels} occupied voxels` : "")
  );
}
