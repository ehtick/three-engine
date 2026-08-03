// SPARSE BRICK DISTANCE FIELD — the fine level under the composited field.
//
// WHY. Measured on the user's Sponza (`scripts/run-gi-sdf-coverage.mjs`): the
// per-mesh SDF bakes are FINE — median 12 cells across the thinnest dimension,
// most meshes baked at 0.02–0.15m. What is coarse is the thing everything
// actually traces: the composited global field, 128³ over a 42m volume =
// **0.33m cells**. A 0.5m Sponza column is one and a half cells wide there. The
// field cannot keep its two faces apart, so light walks through it, and the
// SDF debug view shows the melted blobs that started this.
//
// WHY NOT JUST A FINER DENSE FIELD. The field is not only the distance
// texture: `giField.js` also carries six per-cell rgba32f storage buffers
// (staging, base, radiance, surface, normal, indirect) at 16 B each, so a cell
// costs **104 B**. 128³ is already 218 MB; 256³ would be 1.75 GB. Dense is
// finished as a strategy. But only DISTANCE needs to be fine — radiance and
// surface data are fine at probe scale — and distance is only interesting
// within a couple of cells of a surface. That is a sparse problem.
//
// STRUCTURE (two levels, the same shape as the rest of this module):
//
//   coarse cell (0.33m, existing distanceTexture) ── empty space, big steps
//        │  page table: brick index, or 0 for "no brick here"
//        ▼
//   brick (BRICK_AXIS³ fp16 texels covering ONE coarse cell) ── fine distance
//
// Bricks are allocated only for coarse cells a surface passes near, so the
// cost tracks surface AREA rather than volume. Sponza needs ~150k bricks; at
// BRICK_AXIS 6 that is ~65 MB for a 0.066m effective cell — 5× finer than the
// dense field it sits under, for a third of what the dense field already costs.
//
// THREE DELIBERATE NON-CHOICES, each of which would have added a failure mode:
//
//  * NO GPU ALLOCATION. Brick indices are assigned on the CPU by rasterizing
//    each slot's TIGHT world AABB into the coarse grid — the same pass the
//    instance grid already does, one radius smaller. That needs no atomics, no
//    compaction pass, and it is inspectable from JS, which matters in a module
//    where "the field has a hole in it" is the recurring bug.
//  * NO INDIRECT DISPATCH. The fill pass dispatches ONE THREAD PER COARSE
//    CELL — the same shape as the existing composite — and each thread either
//    exits on a zero page entry or fills its whole brick in a loop. So the
//    dispatch size is a build constant and the brick→cell mapping is implicit
//    in the thread index; nothing has to be uploaded to describe it.
//  * NO APRON. A brick's texels span its coarse cell corner to corner, so
//    neighbouring bricks recompute the shared boundary plane identically and
//    hardware trilinear is seamless across it without border texels. That is
//    why the usable resolution is BRICK_AXIS-1 intervals, not BRICK_AXIS.
import * as THREE from "three/webgpu";
import { Fn, If, Loop, atomicAdd, atomicStore, float, floor, instanceIndex, instancedArray, ivec3, mod, texture3D, textureStore, uint, uniform, vec3, vec4 } from "three/tsl";
import { loopCandidates } from "./instanceGrid.js";

/** Texels per brick axis. Usable fine intervals per coarse cell = axis - 1. */
export const BRICK_AXIS_BY_QUALITY = { low: 4, medium: 4, high: 6, ultra: 8 };
/** Bricks per pool axis in X and Y; Z grows to reach the brick budget. */
const POOL_BRICKS_XY = 32;
/** WebGPU's guaranteed maximum 3D texture dimension. */
const MAX_TEXTURE_3D = 2048;

/**
 * @param {{res: {x,y,z}, distanceTexture: THREE.Storage3DTexture, world: any, cell: THREE.Vector3}} volume
 * @param {import("./slotRegistry.js").SlotRegistry} atlas
 * @param {{brickAxis?: number, maxBricks?: number}} [options]
 */
export function createSparseField(volume, atlas, options = {}) {
  const { res, distanceTexture } = volume;
  const brickAxis = Math.max(2, Math.min(8, options.brickAxis ?? 6));
  const coarseCells = res.x * res.y * res.z;

  // Pool sizing. Z is capped by the 3D texture limit, which is the real
  // ceiling on how many bricks can exist at a given brick size.
  const maxPoolZ = Math.floor(MAX_TEXTURE_3D / brickAxis);
  const wantBricks = Math.max(1, options.maxBricks ?? 150_000);
  const poolZ = Math.max(1, Math.min(maxPoolZ, Math.ceil(wantBricks / (POOL_BRICKS_XY * POOL_BRICKS_XY))));
  const poolBricks = { x: POOL_BRICKS_XY, y: POOL_BRICKS_XY, z: poolZ };
  const maxBricks = poolBricks.x * poolBricks.y * poolBricks.z;
  const poolSize = {
    x: poolBricks.x * brickAxis,
    y: poolBricks.y * brickAxis,
    z: poolBricks.z * brickAxis,
  };
  const poolBytes = poolSize.x * poolSize.y * poolSize.z * 2;

  // ------------------------------------------------------------ page table
  // One entry per COARSE cell: brick index + 1, or 0 for "no brick".
  //
  // GPU-WRITTEN, and it has to be. The first version allocated on the CPU by
  // rasterizing each slot's world AABB, which measured 800k wanted bricks on a
  // 576k-cell Sponza — because an AABB is a SOLID BOX and 25 large overlapping
  // meshes tile the entire volume with them. Bricks are only wanted where a
  // SURFACE is, and the only thing that knows where the surfaces are is the
  // composited field itself. So allocation reads that field.
  //
  // rgba16float, NOT r32float or r32uint: it is the one storage format this
  // pipeline already writes with `textureStore` and reads back with
  // `texture3D` (`distanceTexture` does exactly that), so it needs no new
  // format-capability assumptions. fp16 only holds integers exactly up to
  // 2048, so the index is SPLIT across two channels — 2048² = 4M bricks
  // addressable, far past any pool that fits in memory. Aliasing two bricks
  // onto one index would show up as geometry appearing where it is not, so
  // this is deliberately exact rather than approximate.
  const PAGE_RADIX = 2048;
  const pageTexture = new THREE.Storage3DTexture(res.x, res.y, res.z);
  pageTexture.format = THREE.RGBAFormat;
  pageTexture.type = THREE.HalfFloatType;
  // NEAREST: a page entry is an index, and interpolating two indices produces
  // a third, unrelated brick.
  pageTexture.minFilter = THREE.NearestFilter;
  pageTexture.magFilter = THREE.NearestFilter;

  // Bump allocator for brick indices. Four slots rather than one purely for
  // alignment comfort; only [0] is used.
  const counter = instancedArray(new Uint32Array(4), "uint").toAtomic();

  // ------------------------------------------------------------- brick pool
  const pool = new THREE.Storage3DTexture(poolSize.x, poolSize.y, poolSize.z);
  pool.format = THREE.RedFormat;
  pool.type = THREE.HalfFloatType;
  // LINEAR: this is the whole point — hardware trilinear inside a brick, and
  // seamless across bricks because they share their boundary plane exactly.
  pool.minFilter = THREE.LinearFilter;
  pool.magFilter = THREE.LinearFilter;

  // Uniforms so a refit rescales the fine level without recompiling anything,
  // exactly like `volume.world`.
  const params = {
    // Distance below which a trace should consult the fine level at all.
    // Beyond it the coarse field is both correct and cheaper.
    band: uniform(volume.cell.x * 1.5),
    // Live brick count — also the "is the fine level usable" gate.
    bricks: uniform(0),
  };

  const stats = { bricks: 0, maxBricks, poolBytes, brickAxis, fineCell: 0, allocations: 0, overflow: 0 };

  let dirty = true;

  // ------------------------------------------------------------- allocation
  // Pass 0: zero the bump allocator. A one-thread dispatch — cheaper and far
  // simpler than clearing a buffer from the CPU between frames.
  // `atomicStore`, not `.assign()`: an atomic<u32> in WGSL can only be touched
  // through the atomic intrinsics, and a plain assignment emits code the
  // shader compiler rejects — which takes the WHOLE compute batch down with
  // it, so it presents as "the sparse field allocated nothing" rather than as
  // an error about this line.
  const resetCompute = Fn(() => {
    atomicStore(counter.element(0), uint(0));
  })().compute(1);

  // Pass 1: one thread per coarse cell. Cells whose composited distance puts
  // them within `band` of a surface claim a brick; everything else writes 0.
  //
  // `band` is a little over one coarse cell, not zero: hardware trilinear
  // inside a brick reads its neighbours, and a ray decelerating toward a
  // surface needs the fine value BEFORE it arrives, not on contact.
  const allocCompute = Fn(() => {
    const idx = instanceIndex.toFloat();
    const ix = mod(idx, res.x).toVar();
    const iy = mod(floor(idx.div(res.x)), res.y).toVar();
    const iz = floor(idx.div(res.x * res.y)).toVar();
    const uvw = vec3(ix.add(0.5).div(res.x), iy.add(0.5).div(res.y), iz.add(0.5).div(res.z));
    const d = texture3D(distanceTexture, uvw).level(0).r.mul(volume.world.capWorld).toVar();
    const page = vec4(0, 0, 0, 1).toVar();
    If(d.lessThan(params.band), () => {
      // atomicAdd returns the PREVIOUS value, so this thread owns `slot`.
      const slot = atomicAdd(counter.element(0), uint(1)).toVar();
      If(slot.lessThan(uint(maxBricks)), () => {
        const index = slot.add(1).toFloat().toVar(); // +1: 0 means "no brick"
        page.assign(vec4(mod(index, PAGE_RADIX), floor(index.div(PAGE_RADIX)), 0, 1));
      });
      // Over budget: the entry stays 0 and this cell keeps using the coarse
      // field. Degraded, never wrong.
    });
    textureStore(pageTexture, ivec3(ix.toInt(), iy.toInt(), iz.toInt()), page);
  })().compute(coarseCells);

  /** Decodes a page texel back to a brick index (0 = none). */
  const decodePage = (texel) => texel.r.add(texel.g.mul(PAGE_RADIX));

  /**
   * Marks the CPU-side bookkeeping. The page table itself is rebuilt on the
   * GPU every time the composite runs, so this only tracks whether the stats
   * are stale and keeps the derived world numbers current.
   */
  const allocate = () => {
    if (!dirty) return false;
    dirty = false;
    stats.allocations++;
    stats.fineCell = Math.min(volume.cell.x, volume.cell.y, volume.cell.z) / (brickAxis - 1);
    params.band.value = Math.max(volume.cell.x, volume.cell.y, volume.cell.z) * 1.25;
    return true;
  };

  /**
   * Reads the allocated brick count back from the GPU. DIAGNOSTIC ONLY — it
   * stalls the pipeline, so it is never on the frame path; the shaders
   * themselves need no count, because an over-budget cell simply wrote 0.
   */
  const readbackBricks = async (renderer) => {
    const data = new Uint32Array(await renderer.getArrayBufferAsync(counter.value));
    stats.bricks = Math.min(data[0], maxBricks);
    stats.overflow = Math.max(0, data[0] - maxBricks);
    return stats.bricks;
  };

  // ------------------------------------------------------------- fill pass
  // ONE THREAD PER COARSE CELL. Threads whose cell has no brick exit on the
  // first branch, so the sparsity shows up as idle threads rather than as a
  // dispatch the CPU has to size. Each surviving thread writes the whole brick.
  const fillCompute = Fn(() => {
    const idx = instanceIndex.toFloat();
    const ix = mod(idx, res.x).toVar();
    const iy = mod(floor(idx.div(res.x)), res.y).toVar();
    const iz = floor(idx.div(res.x * res.y)).toVar();

    const page = decodePage(
      texture3D(
        pageTexture,
        vec3(ix.add(0.5).div(res.x), iy.add(0.5).div(res.y), iz.add(0.5).div(res.z)),
      ).level(0),
    ).toVar();

    If(page.greaterThan(0.5), () => {
      const brick = page.sub(1).toVar();
      // Brick index → its (x, y, z) slot in the pool atlas.
      const bx = mod(brick, poolBricks.x).toVar();
      const by = mod(floor(brick.div(poolBricks.x)), poolBricks.y).toVar();
      const bz = floor(brick.div(poolBricks.x * poolBricks.y)).toVar();
      // World position of the coarse cell's MIN corner — texel 0 sits exactly
      // there, and texel (axis-1) exactly on the max corner, so the shared
      // face between two bricks is computed identically by both.
      const originX = ix.mul(volume.world.cell.x).add(volume.world.min.x).toVar();
      const originY = iy.mul(volume.world.cell.y).add(volume.world.min.y).toVar();
      const originZ = iz.mul(volume.world.cell.z).add(volume.world.min.z).toVar();
      const step = float(1 / (brickAxis - 1));

      Loop({ start: 0, end: brickAxis * brickAxis * brickAxis, name: "brickCell" }, ({ brickCell }) => {
        const tx = mod(brickCell.toFloat(), brickAxis).toVar();
        const ty = mod(floor(brickCell.toFloat().div(brickAxis)), brickAxis).toVar();
        const tz = floor(brickCell.toFloat().div(brickAxis * brickAxis)).toVar();
        const p = vec3(
          originX.add(tx.mul(step).mul(volume.world.cell.x)),
          originY.add(ty.mul(step).mul(volume.world.cell.y)),
          originZ.add(tz.mul(step).mul(volume.world.cell.z)),
        ).toVar();

        // EXACTLY the composite's distance, at a sixth of its cell size: the
        // same candidate list, the same per-slot SDF. Nothing here is a new
        // approximation — the fine level is the same function, sampled where
        // it matters.
        const d = float(volume.world.capWorld).toVar();
        loopCandidates(atlas.grid, atlas.capacity, p, (slot) => {
          const bmin = atlas.aabbMin.element(slot).toVar();
          If(bmin.w.greaterThan(0.5), () => {
            const bmax = atlas.aabbMax.element(slot);
            const inside = p.x.greaterThan(bmin.x)
              .and(p.y.greaterThan(bmin.y))
              .and(p.z.greaterThan(bmin.z))
              .and(p.x.lessThan(bmax.x))
              .and(p.y.lessThan(bmax.y))
              .and(p.z.lessThan(bmax.z));
            If(inside, () => {
              d.assign(d.min(atlas.sampleSlot(slot, p)));
            });
          });
        });

        textureStore(
          pool,
          ivec3(
            bx.mul(brickAxis).add(tx).toInt(),
            by.mul(brickAxis).add(ty).toInt(),
            bz.mul(brickAxis).add(tz).toInt(),
          ),
          vec4(d.div(volume.world.capWorld).clamp(0, 1), 0, 0, 1),
        );
      });
    });
  })().compute(coarseCells);

  return {
    brickAxis,
    pageTexture,
    pool,
    params,
    stats,
    maxBricks,
    readbackBricks,
    // Dispatched in order, right after the coarse composite: zero the
    // allocator, page the surface cells, fill their bricks.
    computes: [resetCompute, allocCompute, fillCompute],

    /** Marks the page table stale — any slot move/add/remove changes it. */
    invalidate() {
      dirty = true;
    },
    get isDirty() {
      return dirty;
    },
    allocate,

    /**
     * World distance at `p` from the FINE level, and whether it is valid.
     *
     * Returns `{ d, valid }` where `valid` is 0 when `p`'s coarse cell has no
     * brick — callers must keep the coarse value there, because "no brick"
     * means "far from everything", not "empty".
     */
    sample(p) {
      const rel = vec3(p).sub(volume.world.min).div(volume.world.cell).toVar();
      const cellI = rel.floor().clamp(vec3(0), vec3(res.x - 1, res.y - 1, res.z - 1)).toVar();
      const page = decodePage(
        texture3D(
          pageTexture,
          vec3(
            cellI.x.add(0.5).div(res.x),
            cellI.y.add(0.5).div(res.y),
            cellI.z.add(0.5).div(res.z),
          ),
        ).level(0),
      ).toVar();
      const valid = page.greaterThan(0.5).toVar();
      const brick = page.sub(1).max(0).toVar();
      const bx = mod(brick, poolBricks.x).toVar();
      const by = mod(floor(brick.div(poolBricks.x)), poolBricks.y).toVar();
      const bz = floor(brick.div(poolBricks.x * poolBricks.y)).toVar();
      // Position inside the cell in [0,1], mapped onto the brick's texel
      // CENTRES: texel 0's centre is at 0.5 texels, and the usable span is
      // (axis-1) intervals, which is what makes corner-to-corner exact.
      const t = rel.sub(cellI).clamp(0, 1).toVar();
      const uvw = vec3(
        bx.mul(brickAxis).add(t.x.mul(brickAxis - 1)).add(0.5).div(poolSize.x),
        by.mul(brickAxis).add(t.y.mul(brickAxis - 1)).add(0.5).div(poolSize.y),
        bz.mul(brickAxis).add(t.z.mul(brickAxis - 1)).add(0.5).div(poolSize.z),
      );
      const d = texture3D(pool, uvw).level(0).r.mul(volume.world.capWorld);
      return { d, valid };
    },

    dispose() {
      pageTexture.dispose();
      pool.dispose();
    },
  };
}

/** Human-readable one-liner for the build log. */
export function describeSparseField(field) {
  const s = field.stats;
  const mb = (s.bricks * s.brickAxis ** 3 * 2) / (1024 * 1024);
  return (
    `${s.brickAxis}³ bricks, ${s.bricks}/${s.maxBricks} allocated (${mb.toFixed(1)}MB of ` +
    `${(s.poolBytes / (1024 * 1024)).toFixed(0)}MB pool), fine cell ${s.fineCell.toFixed(3)}m` +
    (s.overflow ? `, ${s.overflow} cells OVER BUDGET (coarse there)` : "")
  );
}
