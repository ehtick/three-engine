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
  Break, Fn, If, Loop, Return, atomicLoad, atomicMax, atomicOr, atomicStore, bitAnd, bitOr, float, floor,
  instanceIndex, instancedArray, int, mod, select, shiftLeft, shiftRight, uint, uniform, uniformArray, vec3, vec4,
} from "three/tsl";
import { sharedFn } from "./giFn.js";

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
 * @param {{slotCapacity?: number, traceSteps?: number}} [options]
 */
export function createOccupancyField(bounds, res0, options = {}) {
  const { levels, totalWords } = planLevels(res0);
  const level0 = levels[0];
  const slotCapacity = Math.max(1, options.slotCapacity ?? 512);
  const traceSteps = Math.max(16, options.traceSteps ?? DEFAULT_TRACE_STEPS);

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
  const bits = instancedArray(new Uint32Array(totalWords), "uint");
  const atomicBits = instancedArray(new Uint32Array(level0.words), "uint").toAtomic();

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
  const slotDynamic = uniformArray(Array.from({ length: slotCapacity }, () => 0), "float");
  let dynamicCount = 0;
  let staticDirty = true;
  const setSlotDynamic = (slot, dyn) => {
    if (slot < 0 || slot >= slotCapacity) return;
    const v = dyn ? 1 : 0;
    if (slotDynamic.array[slot] === v) return;
    slotDynamic.array[slot] = v;
    dynamicCount += v ? 1 : -1;
    staticDirty = true;
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
    staticDirty = true; // attribution numbering changed → the snapshot's attr is stale
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

  // Local→world per instance slot. The atlas carries the INVERSE (it samples
  // slot SDFs by pushing world points into local space); voxelization pushes
  // local triangles out into world space, so it needs the forward matrix.
  const localToWorld = uniformArray(Array.from({ length: slotCapacity }, () => new THREE.Matrix4()));

  const stats = {
    res: res0,
    levels: levels.map((l) => ({ ...l.res })),
    voxelSize: 0,
    totalWords,
    bytes: (totalWords + level0.words) * 4,
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

  /** Zeroes the atomic level-0 scratch. One thread per word. */
  const clearCompute = Fn(() => {
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
  const traceBody = (origin, dir, tMin, tMax, steps, topLevel, penK = null) => {
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
            const cand = float(penK).mul(d).div(tm.max(1e-4)).clamp(0, 1);
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
    const key = `${steps}|${topLevel}|${penumbra ? 1 : 0}`;
    let fn = traceVariants.get(key);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giOccTrace${steps}_${topLevel}${penumbra ? "p" : ""}`,
        type: "vec4",
        inputs: [
          { name: "origin", type: "vec3" },
          { name: "dir", type: "vec3" },
          { name: "tMin", type: "float" },
          { name: "tMax", type: "float" },
          ...(penumbra ? [{ name: "penK", type: "float" }] : []),
        ],
        body: penumbra
          ? (o, d, t0, t1, k) => traceBody(o, d, t0, t1, steps, topLevel, k)
          : (o, d, t0, t1) => traceBody(o, d, t0, t1, steps, topLevel),
      });
      traceVariants.set(key, fn);
    }
    const packed = penumbra
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
  const freeRadiusBody = (p, top, nearField, cap) => {
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
        nearest.assign(nearest.min(select(occ.greaterThan(0.5), d, float(1e9))));
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
  const freeRadiusVariants = new Map();
  const freeRadiusAtWorld = (p, maxLevel = OCC_LEVELS - 1, nearField = true, saturateValue = null) => {
    const top = Math.max(0, Math.min(OCC_LEVELS - 1, maxLevel));
    const sat = saturateValue != null;
    const key = `${top}|${nearField ? 1 : 0}|${sat ? 1 : 0}`;
    let fn = freeRadiusVariants.get(key);
    if (fn === undefined) {
      fn = sharedFn({
        name: `giFreeRadius${top}${nearField ? "n" : ""}${sat ? "s" : ""}`,
        type: "float",
        inputs: sat
          ? [{ name: "p", type: "vec3" }, { name: "cap", type: "float" }]
          : [{ name: "p", type: "vec3" }],
        body: sat
          ? (pp, cap) => freeRadiusBody(pp, top, nearField, cap)
          : (pp) => freeRadiusBody(pp, top, nearField, null),
      });
      freeRadiusVariants.set(key, fn);
    }
    return sat ? fn(p, saturateValue) : fn(p);
  };

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
  const setGeometry = (geometries, placements) => {
    const t0 = performance.now();

    // --- concatenate vertices + a GLOBAL index buffer (absolute vertex ids).
    const ranges = new Map();
    let vertexTotal = 0;
    let triTotal = 0;
    for (const g of geometries) {
      const verts = Math.floor(g.positions.length / 3);
      const tris = Math.floor((g.index ? g.index.length : verts) / 3);
      ranges.set(g.key, { vertexStart: vertexTotal, triStart: triTotal, triCount: tris, verts });
      vertexTotal += verts;
      triTotal += tris;
    }

    const vdata = new Float32Array(Math.max(1, vertexTotal) * 4);
    const idata = new Uint32Array(Math.max(3, triTotal * 3));
    for (const g of geometries) {
      const r = ranges.get(g.key);
      for (let i = 0; i < r.verts; i++) {
        vdata[(r.vertexStart + i) * 4 + 0] = g.positions[i * 3 + 0];
        vdata[(r.vertexStart + i) * 4 + 1] = g.positions[i * 3 + 1];
        vdata[(r.vertexStart + i) * 4 + 2] = g.positions[i * 3 + 2];
      }
      const base = r.triStart * 3;
      const corners = r.triCount * 3;
      if (g.index) {
        for (let i = 0; i < corners; i++) idata[base + i] = r.vertexStart + g.index[i];
      } else {
        for (let i = 0; i < corners; i++) idata[base + i] = r.vertexStart + i;
      }
    }

    // --- per-triangle LOCAL extent, for rotation-invariant chunking.
    const extents = new Map();
    for (const g of geometries) {
      const r = ranges.get(g.key);
      const ext = new Float32Array(r.triCount);
      for (let ti = 0; ti < r.triCount; ti++) {
        const a = idata[(r.triStart + ti) * 3 + 0] * 4;
        const b = idata[(r.triStart + ti) * 3 + 1] * 4;
        const c = idata[(r.triStart + ti) * 3 + 2] * 4;
        let longest = 0;
        for (let axis = 0; axis < 3; axis++) {
          const va = vdata[a + axis], vb = vdata[b + axis], vc = vdata[c + axis];
          longest = Math.max(longest, Math.max(va, vb, vc) - Math.min(va, vb, vc));
        }
        ext[ti] = longest;
      }
      extents.set(g.key, ext);
    }

    // --- the work list. A triangle spanning `n` voxels on its longest axis can
    // touch at most (n+2)³ voxels; chunking on that bound over-allocates for
    // thin triangles, and an empty chunk costs one comparison in the shader
    // (`k >= total` on the first iteration). Over-allocating is the SAFE
    // direction — an under-allocated chunk count silently drops voxels, which
    // is a leak, which is the entire bug this module exists to fix.
    const slots = [];
    const tris = [];
    const chunks = [];
    const minVoxel = Math.min(voxel.value.x, voxel.value.y, voxel.value.z);
    for (const p of placements) {
      const r = ranges.get(p.geometryKey);
      if (!r) continue;
      const ext = extents.get(p.geometryKey);
      const e = p.matrix.elements;
      const scale = Math.max(
        Math.hypot(e[0], e[1], e[2]),
        Math.hypot(e[4], e[5], e[6]),
        Math.hypot(e[8], e[9], e[10]),
      );
      for (let ti = 0; ti < r.triCount; ti++) {
        const span = Math.ceil((ext[ti] * scale) / minVoxel) + 2;
        const n = Math.max(1, Math.ceil((span * span * span) / CHUNK_VOXELS));
        for (let c = 0; c < n; c++) {
          slots.push(p.slot);
          tris.push(r.triStart + ti);
          chunks.push(c);
        }
      }
    }

    vertexBuffer = instancedArray(vdata, "vec4");
    indexBuffer = instancedArray(idata, "uint");
    pairSlot = instancedArray(slots.length ? Uint32Array.from(slots) : new Uint32Array(1), "uint");
    pairTri = instancedArray(tris.length ? Uint32Array.from(tris) : new Uint32Array(1), "uint");
    pairChunk = instancedArray(chunks.length ? Uint32Array.from(chunks) : new Uint32Array(1), "uint");
    pairCount = slots.length;
    geometryRevision++;

    stats.triangles = triTotal;
    stats.pairs = pairCount;
    stats.slots = placements.length;
    stats.buildMs = performance.now() - t0;
    staticDirty = true;
    dirty = true;
  };

  /** Updates one slot's local→world matrix. Cheap — this is the drag path. */
  const setSlotMatrix = (slot, matrix) => {
    if (slot < 0 || slot >= slotCapacity) return;
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
        const voxStatic = buildVoxelizeCompute("static");
        const voxDynamic = buildVoxelizeCompute("dynamic");
        computes = {
          full: [
            clearCompute, buildClearAttrCompute(),
            voxStatic, snapStaticBitsCompute, buildSnapStaticAttrCompute(),
            voxDynamic, copyCompute, ...downsampleComputes,
          ],
          fast: [
            restoreStaticBitsCompute, buildRestoreStaticAttrCompute(),
            voxDynamic, copyCompute, ...downsampleComputes,
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
    occupiedAtWorld,
    freeRadiusAtWorld,
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
      return {
        get,
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
