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
  Break, Fn, If, Loop, atomicLoad, atomicOr, atomicStore, bitAnd, bitOr, float, floor, instanceIndex,
  instancedArray, int, mod, select, shiftLeft, shiftRight, uint, uniform, uniformArray, vec3, vec4,
} from "three/tsl";

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
  // built by createSdfScene AFTER this field exists, so borrowing it would have
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
   * One thread per WORK ITEM = (slot, triangle, chunk). Rebuilt whenever the
   * geometry buffers change, because the body closes over them and the
   * dispatch size is the work-item count.
   */
  const buildVoxelizeCompute = () => Fn(() => {
    const slot = pairSlot.element(instanceIndex).toVar();
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
  const traceOccupancy = (origin, dir, tMin, tMax, opts = {}) => {
    const steps = Math.max(16, opts.steps ?? traceSteps);
    const topLevel = Math.min(OCC_LEVELS - 1, Math.max(0, opts.topLevel ?? OCC_LEVELS - 1));

    const inv = vec3(voxelInv).toVar();
    const q0 = vec3(origin).sub(vec3(gridOrigin)).mul(inv).toVar();
    const dq = vec3(dir).mul(inv).toVar();
    // Reciprocals once, with a SIGNED floor so an axis-parallel ray produces a
    // huge (never NaN, never negative) crossing distance on its degenerate axis
    // instead of poisoning the per-axis min.
    const safe = (c) => select(c.abs().lessThan(1e-8), select(c.lessThan(0), float(-1e-8), float(1e-8)), c);
    const rd = vec3(float(1).div(safe(dq.x)), float(1).div(safe(dq.y)), float(1).div(safe(dq.z))).toVar();
    const stepSign = vec3(dq.x.sign(), dq.y.sign(), dq.z.sign()).toVar();
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
    const hitVoxel = vec3(0).toVar();

    Loop({ start: 0, end: steps, name: "occDda" }, () => {
      If(t.greaterThanEqual(tMax), () => {
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
          Break();
        },
      );

      const scale = levelSelect(level, (l) => l.scale).toVar();
      const v = q.div(scale).floor().toVar();

      If(occupiedAt(v, level).greaterThan(0.5), () => {
        If(level.lessThanEqual(int(0)), () => {
          hit.assign(1);
          hitT.assign(t);
          hitVoxel.assign(q.floor());
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

    // Face normal from the last crossed axis, pointing back along the ray.
    // Before any crossing (a hit in the very first voxel) fall back to the
    // ray's own direction — the caller is inside geometry there anyway.
    const normal = select(
      axis.lessThan(0),
      vec3(dir).negate().normalize(),
      vec3(
        select(axis.equal(0), stepSign.x.negate(), float(0)),
        select(axis.equal(1), stepSign.y.negate(), float(0)),
        select(axis.equal(2), stepSign.z.negate(), float(0)),
      ),
    ).toVar();

    return { hit, t: hitT, normal, voxel: hitVoxel };
  };

  /**
   * Point test: is world point `p` inside occupied geometry at `level`? Used by
   * the composite to force its coarse occupied/distance flags from the fine
   * truth — the coarse SDF has already lost the columns by the time it runs.
   */
  const occupiedAtWorld = (p, level = 0) => {
    const q = vec3(p).sub(vec3(gridOrigin)).mul(vec3(voxelInv)).toVar();
    return occupiedAt(q.div(float(1 << level)).floor(), int(level));
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
    dirty = true;
  };

  /** Updates one slot's local→world matrix. Cheap — this is the drag path. */
  const setSlotMatrix = (slot, matrix) => {
    if (slot < 0 || slot >= slotCapacity) return;
    localToWorld.array[slot].copy(matrix);
    dirty = true;
  };

  let computes = null;
  let computesRevision = -1;

  return {
    levels,
    res: res0,
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
      dirty = true;
    },

    setGeometry,
    setSlotMatrix,

    /** Re-derives world voxel size after an in-place volume refit. */
    refit() {
      syncVoxel();
      syncStats();
      dirty = true;
    },

    /**
     * The dispatch chain, in order: clear → voxelize → copy → downsample×4.
     * Returns null when there is no geometry, so an empty scene costs nothing
     * and cannot dispatch the voxelizer against a placeholder work item.
     */
    passes() {
      dirty = false;
      if (pairCount === 0) return null;
      if (computesRevision !== geometryRevision) {
        computes = [clearCompute, buildVoxelizeCompute(), copyCompute, ...downsampleComputes];
        computesRevision = geometryRevision;
      }
      stats.dispatches++;
      return computes;
    },

    traceOccupancy,
    occupiedAtWorld,
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
