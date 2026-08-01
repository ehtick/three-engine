// Voxel-free GI medium: the global scene field is COMPOSITED ON THE GPU
// from per-mesh SDFs (meshSdfAtlas.js) — there is no CPU voxelizer, no bake
// worker for scene changes, and no incremental region math. Moving a mesh
// updates its slot uniforms and re-runs one compute pass (~1-2ms for the
// whole grid); the cascade transport on top is unchanged.
//
// Cell payload (same contract the cascades already consume):
//   stagingBuffer  — rgb residual emissive, w occupancy (composite output)
//   baseBuffer     — temporally blended copy (bounce feedback ingests staging)
//   radianceBuffer — live traced field (base + per-frame direct + bounce)
//   surfaceBuffer  — rgb albedo, w reliability (1 where occupied)
//   normalBuffer   — SDF-gradient normal of the nearest mesh
//   distanceTexture — Storage3DTexture rgba8: r = distance / capWorld,
//                     gba = normal·0.5+0.5; written by the composite pass,
//                     sampled with HARDWARE TRILINEAR by the traces.
import * as THREE from "three/webgpu";
import { Break, Discard, Fn, If, Loop, cameraPosition, float, floor, instanceIndex, instancedArray, ivec3, mod, positionWorld, select, step, texture3D, textureStore, uniform, vec3, vec4 } from "three/tsl";
import { SDF_CAP, bakeMeshSdf } from "./bakeCore.js";
import { sharedFn } from "./giFn.js";
import { createInstanceGrid, loopCandidates } from "./instanceGrid.js";
import { createSparseField } from "./sparseField.js";
import { createTrilinearRadianceSampler } from "./voxelizeOnce.js";


/**
 * Session-lifetime mesh-SDF baker: a dedicated worker (a dense mesh bake
 * can run seconds; nothing shares this worker so it can't stall anything).
 * OWNED BY THE SYSTEM, not the per-build medium — volume rebuilds (auto-fit
 * refits, structural prop edits) must never kill in-flight bakes, or their
 * cache entries would stay "pending" forever and the meshes would silently
 * never enter the GI field.
 */
export function createSdfBaker() {
  let worker = null;
  let workerBroken = false;
  let requestId = 0;
  const requests = new Map(); // requestId → { resolve, reject }

  const ensureWorker = () => {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker(new URL("./bakeWorker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type !== "meshSdf") return;
        const request = requests.get(message.requestId);
        requests.delete(message.requestId);
        if (request) {
          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.sdf);
        }
      };
      worker.onerror = (error) => {
        console.warn("[gi] SDF worker failed, mesh SDFs will bake on the main thread:", error.message ?? error);
        for (const request of requests.values()) request.reject(new Error("SDF worker died"));
        requests.clear();
        workerBroken = true;
        worker?.terminate();
        worker = null;
      };
    } catch {
      workerBroken = true;
    }
    return worker;
  };

  return {
    request(record, maxAxisRes = undefined) {
      if (!ensureWorker()) {
        return Promise.resolve(bakeMeshSdf(record.positions, record.index, maxAxisRes || undefined));
      }
      return new Promise((resolve, reject) => {
        requestId++;
        requests.set(requestId, { resolve, reject });
        worker.postMessage({
          type: "meshSdf",
          requestId,
          maxAxisRes: maxAxisRes || 0,
          geometryKey: record.geometryKey ?? `sdf:${requestId}`,
          geometry: { positions: record.positions, index: record.index },
        });
      });
    },
    dispose() {
      for (const request of requests.values()) request.reject(new Error("SDF baker disposed"));
      requests.clear();
      worker?.terminate();
      worker = null;
    },
  };
}

/**
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds world AABB
 * @param {{x,y,z}} res global grid cells per axis
 * @param {import("./meshSdfAtlas.js").MeshSdfAtlas} atlas
 */
export function createSdfScene(bounds, res, atlas, options = {}) {
  const cellCount = res.x * res.y * res.z;
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  const cell = new THREE.Vector3(size.x / res.x, size.y / res.y, size.z / res.z);
  const minCell = Math.min(cell.x, cell.y, cell.z);
  // Global field reach — everything beyond reads "far". The atlas expands
  // slot AABBs by this so AABB-rejected cells are legitimately far.
  const capWorld = SDF_CAP * minCell;
  atlas.aabbExpand = capWorld;

  // TOP-LEVEL traversal structure. Attached to the atlas so its TSL helpers
  // (`refineDetail`) can reach it, and consulted by every pass that used to
  // sweep the whole slot list. `__giNoInstanceGrid` restores the flat scans
  // for A/B — the two paths must produce the SAME field, so any difference
  // between them is a bug in here, not a quality setting.
  const grid = globalThis.__giNoInstanceGrid ? null : createInstanceGrid(atlas);
  atlas.grid = grid;

  // WORLD PARAMETERIZATION AS UNIFORMS. Every world-space constant the GI
  // shaders need (volume origin/size, cell size, distance cap) lives in
  // this bundle instead of being baked into WGSL — so an auto-fit REFIT is
  // a uniform update plus one recomposite, with ZERO shader recompiles.
  // Before this, any bounds change forced a full rebuild whose material
  // compile wave froze the viewport for 10-20s — and since scenes commonly
  // live under the GI component's entity, MOVING ANY OBJECT beyond the
  // refit tolerance triggered that wave a few seconds after the drag (the
  // "10s freeze after I release" report). Grid RESOLUTION stays a build
  // constant (dispatch sizes, buffer lengths); a refit keeps the cell
  // COUNT and rescales the cells' world size.
  const world = {
    min: uniform(bounds.min.clone()),
    size: uniform(size.clone()),
    cell: uniform(cell.clone()),
    minCell: uniform(minCell),
    cellMax: uniform(Math.max(cell.x, cell.y, cell.z)),
    capWorld: uniform(capWorld),
    // Composite dirty-brick bounds — permissive defaults mean any composite
    // that doesn't set them recomputes everything (always correct, never
    // stale).
    dirtyMin: uniform(new THREE.Vector3(-1e9, -1e9, -1e9)),
    dirtyMax: uniform(new THREE.Vector3(1e9, 1e9, 1e9)),
  };
  // Occupancy: cell centers within ~half a cell diagonal of a surface. Too
  // tight → thin slabs get single-sided shells (their one cell carries the
  // WRONG side's lighting for half the viewers) and diagonal walls get
  // DDA-tunnelable holes; too fat → shells self-shadow. 0.87 ≈ half the
  // cell diagonal keeps a shell layer on BOTH sides of thin geometry for
  // nearly all slab placements (the direction-aware DDA handles the rest).
  const occThreshold = world.minCell.mul(0.87);

  const stagingBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const radianceBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const baseBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const surfaceBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const normalBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  // Indirect-only field (emissive + bounce, NO analytic/emitter direct):
  // reflection hits re-evaluate direct light PER PIXEL at the exact hit
  // point (crisp), then add this for the diffuse remainder — sampling the
  // full radiance field there instead would double-count the direct term.
  const indirectBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");

  const distanceTexture = new THREE.Storage3DTexture(res.x, res.y, res.z);
  distanceTexture.format = THREE.RGBAFormat;
  // HALF FLOAT, not u8: the shadow trace turns distance error into penumbra
  // error amplified by k/t, so 8-bit distance (capWorld/255 ≈ millimetres)
  // painted visible marble/terrace bands into every soft shadow ("dirty
  // shadows"). fp16 is densest near zero — exactly where the shadow math
  // lives — and rgba16float is base-WebGPU storage-capable AND filterable.
  // ~2× texture memory (a few MB) for quantization-free traces.
  distanceTexture.type = THREE.HalfFloatType;
  distanceTexture.minFilter = THREE.LinearFilter;
  distanceTexture.magFilter = THREE.LinearFilter;

  // ------------------------------------------------ FINE level (sparse bricks)
  // The coarse field above is ~0.33m on a real scene, which is wider than the
  // columns and walls it is supposed to occlude — measured, see sparseField.js.
  // The sparse level puts a fp16 brick in every coarse cell a surface passes
  // through, so a transport ray pays ONE extra texture fetch (not a per-slot
  // loop) to get sub-decimetre occlusion. Off by default until it is proven on
  // the user's own scene: `__giSparseField = true`, or the component prop.
  const sparse = options.sparseField
    ? createSparseField(
        { res, world, cell, distanceTexture },
        atlas,
        { brickAxis: options.brickAxis, maxBricks: options.maxBricks },
      )
    : null;
  // Registered so slot edits invalidate the page table through the same path
  // that invalidates the grid — the atlas is the only thing that knows when a
  // slot moved, and it must not have to know what a brick is.
  atlas.sparse = sparse;

  // Conservative triangle occupancy, supplied by GISystem at build time (it
  // owns the mesh list). Null until then, and null forever when disabled.
  let occupancy = options.occupancy ?? null;

  // ─────────────────────────────────────── OCCUPANCY BACKEND (spec phases 1+4)
  // The conservative triangle-occupancy pyramid (occupancyField.js). When
  // present it becomes the HIT TEST for diffuse transport and the hard block
  // for shadow rays; the composited SDF above stays as the RADIANCE/albedo
  // carrier and as the distance source for the tuned soft-shadow penumbra
  // estimator, which needs a continuous distance that a bitset cannot provide.
  //
  // See createSceneTrace's note for exactly which rays moved and which did not.
  const occField = options.occupancyField ?? null;
  // Pyramid level whose voxel is at least one coarse cell across. The composite
  // uses it to force `occupied` where triangles pass, so sub-cell geometry gets
  // a radiance/albedo shell instead of vanishing. CONSERVATIVE on purpose (a
  // level finer than the coarse cell would test only the cell's middle and miss
  // exactly the thin features this exists for) — and it is a genuine build
  // constant, because a refit rescales both grids from the same bounds and
  // leaves their RATIO untouched.
  const coarseLevel = occField
    ? Math.max(0, Math.min(
        occField.levels.length - 1,
        Math.ceil(Math.log2(Math.max(1, occField.res.x / res.x))),
      ))
    : 0;

  // ------------------------------------------------------------- composite
  // One thread per global cell: min all slot SDFs → distance + nearest-slot
  // surface. Runs only when atlas.revision changed (move/edit/SDF arrival).
  const compositeCompute = Fn(() => {
    const idx = instanceIndex.toFloat();
    const ix = mod(idx, res.x);
    const iy = mod(floor(idx.div(res.x)), res.y);
    const iz = floor(idx.div(res.x * res.y));
    const p = vec3(
      ix.add(0.5).mul(world.cell.x).add(world.min.x),
      iy.add(0.5).mul(world.cell.y).add(world.min.y),
      iz.add(0.5).mul(world.cell.z).add(world.min.z),
    ).toVar();

    const inDirty = p.x.greaterThanEqual(world.dirtyMin.x)
      .and(p.y.greaterThanEqual(world.dirtyMin.y))
      .and(p.z.greaterThanEqual(world.dirtyMin.z))
      .and(p.x.lessThanEqual(world.dirtyMax.x))
      .and(p.y.lessThanEqual(world.dirtyMax.y))
      .and(p.z.lessThanEqual(world.dirtyMax.z));

    If(inDirty, () => {
      const minD = float(world.capWorld).toVar();
      const best = float(-1).toVar();
      // Only the slots the grid lists for this cell — the AABB test below
      // still runs, so a conservative list costs nothing but time.
      loopCandidates(grid, atlas.capacity, p, (slot) => {
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
            const d = atlas.sampleSlot(slot, p).toVar();
            If(d.lessThan(minD), () => {
              minD.assign(d);
              best.assign(slot.toFloat());
            });
          });
        });
      });

      // CONSERVATIVE TRIANGLE OCCUPANCY (occupancyGrid.js). The slot SDFs
      // above are per-mesh grids whose cells are 0.4–0.6m on a real building,
      // so anything smaller than that — a column, a curtain, a moulding — is
      // already gone from `minD` before this line. The occupancy bitset is
      // rasterized straight from triangles, so it still has them.
      //
      // Where it says "solid", the distance is FORCED to zero. That cannot
      // make the field leak more (zero is the smallest a distance can be, so
      // every sphere-traced step gets shorter, never longer) and it puts back
      // exactly the geometry the resampling chain dropped.
      if (occupancy) {
        const occ = texture3D(
          occupancy.texture,
          vec3(ix.add(0.5).div(res.x), iy.add(0.5).div(res.y), iz.add(0.5).div(res.z)),
        ).level(0).r;
        minD.assign(select(occ.greaterThan(0.5), float(0), minD));
      }
      // Same clamp, from the SAT-conservative pyramid rather than the CPU
      // prototype's point-sampled grid. This is what gives a sub-cell column a
      // radiance/albedo shell in the coarse field: without it the column would
      // BLOCK light (the DDA sees it) while emitting nothing and reading black.
      if (occField) {
        minD.assign(select(occField.occupiedAtWorld(p, coarseLevel).greaterThan(0.5), float(0), minD));
      }
      const occupied = step(minD, occThreshold).toVar();
      const albedo = vec3(0).toVar();
      const emissive = vec3(0).toVar();
      const normal = vec3(0, 1, 0).toVar();
      If(best.greaterThanEqual(0), () => {
        const s = best.toInt();
        albedo.assign(atlas.albedo.element(s).xyz);
        emissive.assign(atlas.emissive.element(s).xyz);
        // SDF-gradient normal of the winning slot (6 taps) — only where the
        // cell is occupied; empty cells never feed the bounce gather.
        If(occupied.greaterThan(0.5), () => {
          const h = world.minCell.mul(0.5);
          const gx = atlas.sampleSlot(s, p.add(vec3(h, 0, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(h, 0, 0))));
          const gy = atlas.sampleSlot(s, p.add(vec3(0, h, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(0, h, 0))));
          const gz = atlas.sampleSlot(s, p.add(vec3(0, 0, h))).sub(atlas.sampleSlot(s, p.sub(vec3(0, 0, h))));
          const g = vec3(gx, gy, gz).toVar();
          If(g.length().greaterThan(1e-5), () => {
            normal.assign(g.normalize());
          });
        });
      });

      stagingBuffer.element(instanceIndex).assign(vec4(emissive.mul(occupied), occupied));
      surfaceBuffer.element(instanceIndex).assign(vec4(albedo, occupied));
      normalBuffer.element(instanceIndex).assign(vec4(normal, 0));
      textureStore(
        distanceTexture,
        ivec3(ix.toInt(), iy.toInt(), iz.toInt()),
        vec4(minD.div(world.capWorld).clamp(0, 1), normal.mul(0.5).add(0.5)),
      );
    });
  })().compute(cellCount);

  return {
    res,
    bounds,
    cell,
    minCell,
    capWorld,
    world,
    atlas,
    grid,
    sparse,
    occupancy,
    occupancyField: occField,
    coarseLevel,

    /**
     * Re-pages the fine level if any slot moved. Returns true when the page
     * table changed, which is the caller's signal that `sparse.fillCompute`
     * has to run before anything traces.
     */
    updateSparse() {
      return sparse ? sparse.allocate() : false;
    },

    /**
     * Refreshes the top-level candidate lists if any slot moved. MUST run
     * before the composite dispatch — the composite reads the lists to decide
     * what it is allowed to skip, so a stale list is a stale field.
     * Returns true when the lists actually changed.
     */
    updateGrid() {
      return grid ? grid.update(bounds) : false;
    },

    /**
     * In-place volume refit: rescales the SAME cell grid to new world
     * bounds via the uniform bundle — no shader touches, no recompiles.
     * The caller must force a recomposite afterwards (atlas.refreshAllSlots
     * — slot AABBs embed the old aabbExpand and unmoved meshes would
     * otherwise keep it).
     */
    setBounds(next) {
      bounds.min.copy(next.min);
      bounds.max.copy(next.max);
      size.subVectors(bounds.max, bounds.min);
      cell.set(size.x / res.x, size.y / res.y, size.z / res.z);
      this.minCell = Math.min(cell.x, cell.y, cell.z);
      this.capWorld = SDF_CAP * this.minCell;
      atlas.aabbExpand = this.capWorld;
      world.min.value.copy(bounds.min);
      world.size.value.copy(size);
      world.cell.value.copy(cell);
      world.minCell.value = this.minCell;
      world.cellMax.value = Math.max(cell.x, cell.y, cell.z);
      world.capWorld.value = this.capWorld;
      // Every cell of the top-level grid just changed world size, and the
      // slot AABBs are about to be re-expanded by the new cap.
      grid?.invalidate();
      // Same for the fine level: its bricks are indexed BY COARSE CELL, and
      // every coarse cell just moved and resized.
      sparse?.invalidate();
      if (sparse) sparse.params.band.value = this.minCell * 1.5;
      // The occupancy pyramid shares `world.min`/`world.size`, so its shaders
      // need no touching — but its voxel SIZE is derived, not uniform-shared,
      // and every bit in it was rasterized against the old bounds.
      occField?.refit();
    },
    stats: { occupiedCells: -1, emissiveCells: -1, cellCount },
    stagingBuffer,
    baseBuffer,
    radianceBuffer,
    surfaceBuffer,
    normalBuffer,
    indirectBuffer,
    distanceTexture,
    compositeCompute,

    /** GPU→CPU occupancy count (diagnostics/harness only — one readback). */
    async readbackStats(renderer) {
      const data = new Float32Array(await renderer.getArrayBufferAsync(stagingBuffer.value));
      let occupiedCells = 0;
      let emissiveCells = 0;
      for (let i = 0; i < cellCount; i++) {
        if (data[i * 4 + 3] > 0.5) {
          occupiedCells++;
          if (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] > 1e-4) emissiveCells++;
        }
      }
      Object.assign(this.stats, { occupiedCells, emissiveCells });
      return this.stats;
    },

    dispose() {
      distanceTexture.dispose();
      atlas.texture.dispose();
      sparse?.dispose();
      occupancy?.dispose();
    },

    // TRANSPORT RAYS — the ones the leak lives on.
    //
    // With the occupancy backend these are a HIERARCHICAL DDA over conservative
    // triangle occupancy: hits come from a level-0 bit and nothing else, so a
    // 0.5m column in a 0.33m field is present instead of melted, and the
    // 0.125m voxel resolves the two faces of a 0.2m wall. This is the path that
    // deliberately did NO detail refinement (6 extra SDF fetches per step
    // quadrupled the frame, 8.3 → 33ms), which is precisely why diffuse GI saw
    // only the coarse blobs while shadows and mirrors saw sub-cell geometry.
    //
    // Without it, the legacy sphere trace of the composited SDF (+ sparse
    // bricks) — unchanged.
    createSceneTrace: () => {
      const sampler = createTrilinearRadianceSampler(
        radianceBuffer, { min: world.min }, res, world.cell, normalBuffer,
      );
      return occField
        ? createOccupancySceneTrace(occField, world, sampler)
        : createSdfSceneTrace(distanceTexture, world, res, atlas, sampler, sparse);
    },
    createRadianceSampler: () => createTrilinearRadianceSampler(radianceBuffer, { min: world.min }, res, world.cell),
    createIndirectSampler: () => createTrilinearRadianceSampler(indirectBuffer, { min: world.min }, res, world.cell),
    // `name` only labels the emitted WGSL function (readability in dumps) —
    // every instance gets a layout now, per shader (giFn.js).
    // SHADOW RAYS keep the distance-based penumbra estimator — min(k·d/t) with
    // closest-approach interpolation needs a CONTINUOUS distance, and a bitset
    // has none. What the occupancy field replaces here is only the HARD BLOCK:
    // the safety net for walls thinner than a coarse cell, which used to test
    // the coarse `stagingBuffer` occupancy (same 0.33m cells that lost the wall
    // in the first place) and now tests a 0.125m conservative voxel.
    createSoftShadowTrace: (lift, steps, name = undefined) =>
      createShadowTrace(distanceTexture, world, res, lift, atlas, steps, stagingBuffer, name, sparse, occField),
    // MIRROR RAYS stay on the sphere trace deliberately. They were a voxel DDA
    // once and moved OFF it because binary cells give stair-stepped hit
    // silhouettes where continuous distance gives smooth ones — and the spec's
    // own non-goals exclude sharp reflections through the voxel field.
    createMirrorTrace: (steps) => createMirrorTrace(distanceTexture, world, res, atlas, steps, sparse),
    createHitSurfaceFn: () => createHitSurfaceFn(atlas, world.minCell),
  };
}

/**
 * Resolves the mesh surface under a reflection-ray HIT point: nearest slot
 * by SDF (world-AABB pre-reject), its constant albedo, and a crisp normal
 * from the slot SDF's gradient. `valid` = 0 when no slot covers the point
 * (SDF still baking) — callers fall back to the field sample. Runs per
 * MIRROR PIXEL only, after the trace — not per step.
 */
function createHitSurfaceFn(atlas, minCellNode) {
  return (p) => {
    const bestD = float(1e5).toVar();
    const best = float(-1).toVar();
    loopCandidates(atlas.grid, atlas.capacity, p, (hitSlot) => {
      const bmin = atlas.aabbMin.element(hitSlot).toVar();
      If(bmin.w.greaterThan(0.5), () => {
        const bmax = atlas.aabbMax.element(hitSlot);
        const inside = p.x.greaterThan(bmin.x)
          .and(p.y.greaterThan(bmin.y))
          .and(p.z.greaterThan(bmin.z))
          .and(p.x.lessThan(bmax.x))
          .and(p.y.lessThan(bmax.y))
          .and(p.z.lessThan(bmax.z));
        If(inside, () => {
          const d = atlas.sampleSlot(hitSlot, p).toVar();
          If(d.lessThan(bestD), () => {
            bestD.assign(d);
            best.assign(hitSlot.toFloat());
          });
        });
      });
    });
    const albedo = vec3(0.5).toVar();
    const normal = vec3(0, 1, 0).toVar();
    const valid = float(0).toVar();
    If(best.greaterThanEqual(0), () => {
      const s = best.toInt();
      albedo.assign(atlas.albedo.element(s).xyz);
      const h = float(minCellNode).mul(0.5);
      const gx = atlas.sampleSlot(s, p.add(vec3(h, 0, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(h, 0, 0))));
      const gy = atlas.sampleSlot(s, p.add(vec3(0, h, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(0, h, 0))));
      const gz = atlas.sampleSlot(s, p.add(vec3(0, 0, h))).sub(atlas.sampleSlot(s, p.sub(vec3(0, 0, h))));
      const g = vec3(gx, gy, gz).toVar();
      If(g.length().greaterThan(1e-5), () => {
        normal.assign(g.normalize());
        valid.assign(1);
      });
    });
    return { albedo, normal, valid };
  };
}

/**
 * SDF sphere-traced soft shadow over the COMPOSITED global field +
 * per-step DETAIL-slot refinement: (origin, dir, maxT, k, cosRayNormal) →
 * penumbra in [0, 1] via min(k·d/t). Same estimator battle-tested on the
 * CPU-baked field (plane-aware self-exclusion, small contact cut, stepping
 * safety factor) — only the field source changed.
 */
function createShadowTrace(distanceTexture, world, res, lift, atlas, steps = 56, occupancy = null, name = "giShadowTrace", sparse = null, occField = null) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;
  // `lift` may be a plain number or a TSL node (GISystem passes uniform-
  // derived nodes so a refit rescales the lift with the cells).
  const liftWorld = lift == null ? minCell.mul(2) : float(lift);

  // ONE WGSL function per trace config PER SHADER (sharedFn — see giFn.js).
  // Materials call this up to 8 times (4 emitter slots + 4 mirror-hit slots);
  // inlining the ~56-step loop body — each with its own inlined detail-slot
  // refinement — at every call site made every material's shader enormous,
  // the dominant cost of the seconds-long compile waves on init/rebuild.
  // excludeRadius < 0 disables the light-source self-exclusion (the length
  // test is then trivially true).
  // excludeHalf.x >= 0 switches the exclusion region from the sphere to an
  // ORIENTED BOX (the lamp's OBB dilated by excludeRadius). A big panel
  // lamp's bounding SPHERE swallowed every wall within ~1.5× its radius —
  // those walls stopped occluding, pouring a circular spot of light through
  // ceilings into the room above, and the sphere's boundary painted a
  // visible ring into the lamp's own pool ("dirty shadows").
  const traceFn = sharedFn({
    name,
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "maxT", type: "float" },
      { name: "k", type: "float" },
      { name: "cosRayNormal", type: "float" },
      { name: "excludeCenter", type: "vec3" },
      { name: "excludeRadius", type: "float" },
      { name: "excludeHalf", type: "vec3" },
      { name: "excludeBx", type: "vec3" },
      { name: "excludeBy", type: "vec3" },
      { name: "excludeBz", type: "vec3" },
    ],
    body: (origin, dir, maxT, k, cosRayNormal, excludeCenter, excludeRadius, excludeHalf, excludeBx, excludeBy, excludeBz) => {
      // HOIST all uniform-derived scalars into locals BEFORE the loop. The
      // D3D shader compiler is drastically slower optimizing a long sphere-
      // trace loop whose operands are uniform-buffer loads than one reading
      // function-local values (measured: 3 pipelines 6.5s+2.2s+1.8s vs ~1s
      // total with baked constants) — a `var` copy up front restores nearly
      // all of it while keeping the values refit-live.
      const minCellV = float(minCell).toVar();
      const capWorldV = float(capWorld).toVar();
      const minV = vec3(world.min).toVar();
      const sizeInvV = vec3(1).div(world.size).toVar();
      const cellV = vec3(world.cell).toVar();
      const liftV = float(liftWorld).toVar();
      const contactCut = minCellV.mul(0.25).toVar();
      const planeCut = minCellV.mul(0.75).toVar();
      const capCut = capWorldV.mul(0.85).toVar();
      const occCut = minCellV.mul(0.3).toVar();
      const stepMin = minCellV.mul(0.35).toVar();
      const stepMax = minCellV.mul(8).toVar();
      const penumbra = float(1).toVar();
      // Volume slab entry/exit: a receiver OUTSIDE the fitted volume (auto-fit
      // keeps the volume tight around the scene) must march INTO the field,
      // not give up — the old first-sample out-of-bounds Break() left every
      // outside receiver with penumbra 1, i.e. full UNSHADOWED analytic light
      // past a hard line at the volume face (the "light cutoff" report: lit
      // sharp-edged pools on otherwise dark floors). Entry math mirrors the
      // debug-view raymarcher.
      const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
      const bmax = minV.add(vec3(world.size)).toVar();
      const t1x = minV.x.sub(origin.x).div(invEps(dir.x));
      const t2x = bmax.x.sub(origin.x).div(invEps(dir.x));
      const t1y = minV.y.sub(origin.y).div(invEps(dir.y));
      const t2y = bmax.y.sub(origin.y).div(invEps(dir.y));
      const t1z = minV.z.sub(origin.z).div(invEps(dir.z));
      const t2z = bmax.z.sub(origin.z).div(invEps(dir.z));
      const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z)).toVar();
      const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z)).toVar();
      const t = minCellV.mul(2).max(tEnter.add(minCellV.mul(0.5))).toVar();
      const tEnd = tExit.sub(contactCut).toVar();
      // Previous-sample distance for the IMPROVED penumbra estimator (iq):
      // two consecutive sphere-trace samples bound a closest-approach point
      // BETWEEN them — estimating the occluder distance there instead of at
      // the samples removes the banding/raggedness the plain min(k·d/t)
      // estimator paints when step size ≈ feature size (the "rough shadows"
      // report; the u8-quantized field makes plain-estimator bands worse).
      const prevD = float(1e10).toVar();

      Loop({ start: 0, end: steps, name: "sdfShadow" }, () => {
        If(t.greaterThanEqual(maxT).or(t.greaterThan(tEnd)), () => {
          Break();
        });
        const p = origin.add(dir.mul(t)).toVar();
        const uvw = p.sub(minV).mul(sizeInvV).toVar();
        If(
          uvw.x.lessThan(0)
            .or(uvw.y.lessThan(0))
            .or(uvw.z.lessThan(0))
            .or(uvw.x.greaterThan(1))
            .or(uvw.y.greaterThan(1))
            .or(uvw.z.greaterThan(1)),
          () => {
            Break();
          },
        );
        // Hardware trilinear over the composited field; explicit level —
        // implicit-derivative sampling inside loops is illegal WGSL.
        const dRaw = texture3D(distanceTexture, uvw).level(0).r.mul(capWorldV).toVar();
        // Fine level first (one fetch, whole-scene coverage), then the detail
        // slots on top. They are not redundant: the bricks resample the same
        // per-mesh SDFs onto a fixed lattice, so they carry every mesh but at
        // brick resolution, while refineDetail reads a handful of per-mesh
        // SDFs at their own NATIVE resolution (0.02–0.15m — finer than any
        // brick). Sparse fixes coverage; detail slots keep the sharpest edges.
        if (sparse) {
          const fine = sparse.sample(p);
          dRaw.assign(select(fine.valid.and(dRaw.lessThan(sparse.params.band)), fine.d, dRaw));
        }
        // Detail slots: crisp local fields min()ed in near dense/important
        // meshes — sub-scene-cell silhouettes (thin wings, fine props).
        dRaw.assign(atlas.refineDetail(dRaw, p));
        // LIGHT-SOURCE SELF-EXCLUSION: a ray aimed AT the light must not be
        // occluded by the light's own body/field shell. Without this, rays
        // skimming the emitter's SDF near arrival painted its bounding-box
        // shadow onto every receiver ("+"-shaped dark bands under disc
        // lamps).
        // SPHERE lamps: legacy region test — samples within excludeRadius
        // (1.5R + margin) never occlude; the 0.5R shell left outside keeps
        // min(k·d/t) ≥ ~1 for the lamp's own field, so it can't self-shadow.
        // (excludeRadius < 0 → always true: no exclusion.)
        // BOX lamps (excludeHalf.x ≥ 0): COMPARATIVE test — the sample may
        // occlude only when the field reads DECISIVELY closer than the
        // lamp's own analytic SDF explains. A region the size of a big
        // panel's bounding sphere swallowed nearby ceilings (light poured
        // through into the room above as a circle) and its boundary ringed
        // the pool with dirt; a small fixed region instead lets the lamp's
        // own shell darken its light (min(k·d/t) with d capped at the
        // dilation ≈ heavy false self-shadow on any large lamp). Comparing
        // against the exact lamp SDF excludes exactly the lamp, at any
        // size — a wall two cells from the face still seals.
        const relEx = p.sub(excludeCenter).toVar();
        const localEx = vec3(relEx.dot(excludeBx), relEx.dot(excludeBy), relEx.dot(excludeBz));
        const lampDist = localEx.abs().sub(excludeHalf).max(vec3(0)).length().toVar();
        const slack = minCellV.mul(1.5).max(lampDist.mul(0.25));
        const outsideLight = select(
          excludeHalf.x.greaterThanEqual(0),
          dRaw.lessThan(lampDist.sub(slack)),
          relEx.length().greaterThan(excludeRadius),
        );
        const planeHeight = liftV.add(t.mul(cosRayNormal));
        // A sample only counts as an occluder if it is BOTH under the
        // receiver-plane exclusion threshold AND not SATURATED at the field
        // cap. dRaw clamps at capWorld while `lift + t·cos` grows unbounded —
        // without the cap check, every open-space sample beyond
        // t ≈ k·capWorld "occludes", carving a hard light sphere of radius
        // k·capWorld around every lamp (the user's cutoff disc; the radius
        // SHRANK at higher quality because finer cells mean smaller capWorld).
        const isRealOccluder = dRaw
          .lessThan(planeHeight.sub(planeCut))
          .and(dRaw.lessThan(capCut))
          .and(outsideLight)
          .toVar();
        If(isRealOccluder.and(dRaw.lessThan(contactCut)), () => {
          penumbra.assign(0);
          Break();
        });
        // OCCUPANCY HARD BLOCK: a wall thinner than a field cell keeps its
        // trilinear distance above the contact cut (the surface sits between
        // cell centers), so a distance-only march can step across it — light
        // through walls. Marching THROUGH an occupied cell is unambiguous
        // occlusion regardless of what the interpolated distance claims. The
        // plane-exclusion gate keeps the receiver's own shell from
        // self-shadowing.
        // Gated on the refined distance ALSO being VERY small: the old
        // 0.6·cell gate zeroed every near-silhouette ray, bottom-clipping the
        // penumbra ramp — large emitters cast HARD-edged shadows ("no soft
        // shadows from the emissive"). Thin walls are now detail-refined to
        // EXACT distances (analytic + baked local SDFs), so rays truly
        // crossing them converge under the contact cut on their own; this
        // block is only the safety net for thin walls beyond the detail
        // budget, and 0.3·cell catches those while leaving the soft band
        // (est ≥ 0.3·cell) untouched.
        //
        // The occupancy FIELD supersedes the coarse cell test when present:
        // same net, at 0.125m conservative voxels instead of the 0.33m cells
        // that lost the wall to begin with. Its gate is the CONTACT cut rather
        // than `occCut`, because a level-0 bit is unambiguous — the reason the
        // old gate had to be conservative (0.3·cell) was that a coarse
        // "occupied" cell could be half empty space, and zeroing on it
        // bottom-clipped the penumbra ramp into hard-edged shadows.
        if (occField) {
          If(isRealOccluder.and(dRaw.lessThan(contactCut.mul(2))), () => {
            If(occField.occupiedAtWorld(p, 0).greaterThan(0.5), () => {
              penumbra.assign(0);
              Break();
            });
          });
        } else if (occupancy) {
          If(isRealOccluder.and(dRaw.lessThan(occCut)), () => {
            const cx = p.x.sub(minV.x).div(cellV.x).floor().clamp(0, res.x - 1);
            const cy = p.y.sub(minV.y).div(cellV.y).floor().clamp(0, res.y - 1);
            const cz = p.z.sub(minV.z).div(cellV.z).floor().clamp(0, res.z - 1);
            const cellIdx = cz.mul(res.y).add(cy).mul(res.x).add(cx);
            If(occupancy.element(cellIdx.toInt()).w.greaterThan(0.5), () => {
              penumbra.assign(0);
              Break();
            });
          });
        }
        If(isRealOccluder, () => {
          // Closest-approach interpolation: y = where between the previous
          // and current sample the ray passed nearest the occluder, est = the
          // interpolated distance there. Exact for a straight silhouette,
          // and MUCH smoother than min(k·d/t) at coarse step counts.
          const y = dRaw.mul(dRaw).div(prevD.mul(2)).min(dRaw).toVar();
          const est = dRaw.mul(dRaw).sub(y.mul(y)).max(0).sqrt();
          penumbra.assign(penumbra.min(est.mul(k).div(t.sub(y).max(1e-4))));
          prevD.assign(dRaw);
        }).Else(() => {
          // Non-occluder samples (own plane, cap-saturated, lamp body) must
          // not feed the interpolation — their distances describe excluded
          // geometry, and pairing them with a real sample fabricates a
          // closest approach that never existed.
          prevD.assign(1e10);
        });
        t.addAssign(dRaw.mul(0.85).clamp(stepMin, stepMax));
      });

      return penumbra.clamp(0, 1);
    },
  });

  return (origin, dir, maxT, k, cosRayNormal, excludeCenter = null, excludeRadius = null, excludeBox = null) =>
    traceFn(
      vec3(origin),
      vec3(dir),
      float(maxT),
      float(k),
      float(cosRayNormal),
      excludeCenter ? vec3(excludeCenter) : vec3(0, 0, 0),
      excludeRadius ? float(excludeRadius) : float(-1),
      // excludeBox = { half, bx, by, bz } node bundle; x < 0 → sphere mode.
      excludeBox ? vec3(excludeBox.half) : vec3(-1, -1, -1),
      excludeBox ? vec3(excludeBox.bx) : vec3(1, 0, 0),
      excludeBox ? vec3(excludeBox.by) : vec3(0, 1, 0),
      excludeBox ? vec3(excludeBox.bz) : vec3(0, 0, 1),
    );
}

/**
 * Debug material for the "SDF" view: raymarches the composited distance
 * field (+ detail slots — the ACTUAL per-mesh SDFs) from the camera and
 * shades hits with the field's own gradient normals plus distance-band
 * rings, so a broken/missing/misplaced mesh SDF is immediately visible.
 * Applied to a camera-facing volume box rendered from the inside.
 */
export function createSdfDebugMaterial(volume) {
  const { world, distanceTexture, atlas, sparse } = volume;
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  // Overlay: the raymarch replaces the scene view entirely — scene depth
  // would otherwise occlude the box's backfaces and hide the debug.
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    // Uniform-derived values hoisted before the loop (driver compile cost).
    const minCellV = float(minCell).toVar();
    const capWorldV = float(capWorld).toVar();
    const minV = vec3(world.min).toVar();
    const sizeV = vec3(world.size).toVar();
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    // Slab entry so an outside camera starts marching AT the volume.
    const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
    const bmax = minV.add(sizeV).toVar();
    const t1x = minV.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t2x = bmax.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t1y = minV.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t2y = bmax.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t1z = minV.z.sub(cameraPosition.z).div(invEps(dir.z));
    const t2z = bmax.z.sub(cameraPosition.z).div(invEps(dir.z));
    const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z));
    const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z));

    const t = tEnter.max(0).add(minCellV.mul(0.25)).toVar();
    const out = vec4(0, 0, 0, 0).toVar();
    Loop({ start: 0, end: 128, name: "sdfDebug" }, () => {
      If(t.greaterThan(tExit), () => {
        Break();
      });
      const p = cameraPosition.add(dir.mul(t)).toVar();
      const uvw = p.sub(minV).div(sizeV).clamp(0, 1).toVar();
      const sample = texture3D(distanceTexture, uvw).level(0).toVar();
      const d = sample.r.mul(capWorldV).toVar();
      // The debug view must march the SAME field the traces do, fine level
      // included — otherwise it keeps showing the coarse blobs while the GI
      // has stopped using them, and the one instrument for "is my SDF any
      // good" lies about the thing it exists to show.
      if (sparse) {
        const fine = sparse.sample(p);
        d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
      }
      d.assign(atlas.refineDetail(d, p));
      // HIT CUT AND STEP FLOOR AND ITERATION BUDGET ARE A TRIPLE, not a pair.
      // Scaling the cut down to the fine cell (÷ brickAxis-1) and the floor
      // with it left the 128-step budget untouched, so every grazing ray ran
      // out of iterations before reaching its surface: the colonnade rendered
      // as vertical shreds with the floor intact, which reads as "the sparse
      // field is broken" when the field was fine and the MARCHER was starved.
      // Held identical to the coarse path on purpose — then any difference in
      // this view is the field's accuracy, which is the thing being judged.
      // Sharpening the contact is a separate change with its own budget.
      const hitCut = minCellV.mul(0.4);
      If(d.lessThan(hitCut), () => {
        const n = sample.gba.mul(2).sub(1).toVar();
        // Normal-colored surface with a headlight lambert — a missing,
        // misplaced, or garbage mesh SDF is immediately visible.
        const lambert = n.dot(dir.negate()).abs().mul(0.6).add(0.4);
        out.assign(vec4(n.mul(0.5).add(0.5).mul(lambert), 1));
        Break();
      });
      // Floor stays paired with the cut above (a ray whose distance lands
      // between them steps clean over the hit band and punches a hole).
      t.addAssign(d.mul(0.9).clamp(minCellV.mul(0.3), capWorldV));
    });
    If(out.w.lessThan(0.5), () => {
      Discard();
    });
    return out;
  })();
  return material;
}

/**
 * SDF sphere-traced CASCADE ray: (origin, dir, tMaxWorld) → { rad, t },
 * t < 0 = miss. Replaces the voxel DDA the transport used to march —
 * steps scale with distance-to-geometry (fast in open space), silhouettes
 * are continuous, and the hit shades from the trilinear radiance field.
 * Back-side hits block but emit nothing (the composite's per-side gradient
 * normal decides), matching the DDA's convention.
 */
function createSdfSceneTrace(distanceTexture, world, res, atlas, radianceSampler, sparse) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  return (origin, dir, tMaxWorld) => {
    // Uniform-derived values hoisted to locals before the loop — see the
    // shadow trace's note (driver pipeline-compile cost).
    const minCellV = float(minCell).toVar();
    const capWorldV = float(capWorld).toVar();
    const minV = vec3(world.min).toVar();
    const sizeInvV = vec3(1).div(world.size).toVar();
    const hitCut = minCellV.mul(0.45).toVar();
    const stepMin = minCellV.mul(0.5).toVar();
    const rad = vec3(0).toVar();
    const hitT = float(-1).toVar();
    const t = float(0).toVar();
    Loop({ start: 0, end: 48, name: "sdfRay" }, () => {
      If(t.greaterThan(tMaxWorld), () => {
        Break();
      });
      const p = origin.add(dir.mul(t)).toVar();
      const uvw = p.sub(minV).mul(sizeInvV).toVar();
      If(
        uvw.x.lessThan(0)
          .or(uvw.y.lessThan(0))
          .or(uvw.z.lessThan(0))
          .or(uvw.x.greaterThan(1))
          .or(uvw.y.greaterThan(1))
          .or(uvw.z.greaterThan(1)),
        () => {
          Break();
        },
      );
      const sample = texture3D(distanceTexture, uvw).level(0).toVar();
      const d = sample.r.mul(capWorldV).toVar();
      // NO detail-slot refinement here on purpose: transport rays number in
      // the hundreds of thousands per frame — 6 extra SDF fetches per step
      // quadrupled the whole frame (harness-measured 8.3 → 33ms). Shadows
      // and mirrors keep sub-cell detail; diffuse transport doesn't need it.
      //
      // THE SPARSE LEVEL IS WHAT LETS THAT CHANGE. It costs ONE page fetch
      // plus one brick fetch — a constant, not a loop over slots — so the
      // rays that decide GI occlusion finally see sub-cell geometry. This is
      // the path the leak lives on: at 0.33m cells a 0.5m column is one and a
      // half cells wide and transport walks straight through it.
      //
      // Consumed as PURE DATAFLOW (nested select, no If gate around the
      // fetch). An `If()` around a `.toVar()`ed texture read is the idiom
      // that rendered the BVH mirror pass black — see giLight's note.
      if (sparse) {
        const fine = sparse.sample(p);
        d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
      }
      If(d.lessThan(hitCut), () => {
        const n = sample.gba.mul(2).sub(1).toVar();
        // Side-aware sample: only cells facing the hit side contribute.
        const shaded = radianceSampler(p, n);
        // Front-side hits carry the field radiance; back sides only block.
        rad.assign(vec3(shaded.rad).mul(step(dir.dot(n), 0)));
        hitT.assign(t.max(1e-4));
        Break();
      });
      t.addAssign(d.mul(0.9).clamp(stepMin, capWorldV));
    });
    return { rad, t: hitT };
  };
}

/**
 * OCCUPANCY transport ray: (origin, dir, tMaxWorld) → { rad, t }, t < 0 = miss.
 * The spec's `traceInterval`, phase 4 — hierarchical DDA over the conservative
 * occupancy pyramid, with the hit shaded from the existing coarse radiance
 * field.
 *
 * WHY THE RADIANCE STAYS COARSE (spec phase 3 is not this change). The leak is
 * an OCCLUSION failure, not a radiance one: a 0.5m column melted out of a 0.33m
 * distance field lets light through, and no amount of radiance resolution fixes
 * that. Occlusion is now 0.125m and conservative; radiance is still probe-scale,
 * which is where diffuse GI wants it anyway. Per-voxel radiance is the separate,
 * later upgrade.
 *
 * TWO DETAILS THAT ARE NOT ARBITRARY:
 *  · The hit is pushed OUT along the voxel face normal by half a coarse cell
 *    before sampling radiance. The DDA stops exactly ON the surface, which in
 *    coarse-cell terms is inside the wall; the shell cell carrying that face's
 *    lighting is half a cell outside it.
 *  · No `step(dot(dir, n), 0)` front-face gate, unlike the SDF trace. That gate
 *    existed because an SDF-gradient normal is the SURFACE's outward normal, so
 *    a back-side hit had to be detected and silenced. A DDA face normal always
 *    points back along the ray, i.e. at the side the ray can actually see, and
 *    feeding it to the SIDE-AWARE sampler already selects that side's shell —
 *    a wall's dark face returns dark because its cells are dark, not because a
 *    gate zeroed it.
 */
function createOccupancySceneTrace(occField, world, radianceSampler, steps = 64) {
  return (origin, dir, tMaxWorld) => {
    const o = vec3(origin).toVar();
    const d = vec3(dir).toVar();
    // Self-bias (spec §5.3): start a quarter of a coarse cell out so a probe
    // sitting on a surface does not instantly hit the voxel it lives in.
    const tMin = float(world.minCell).mul(0.25).toVar();
    const r = occField.traceOccupancy(o, d, tMin, float(tMaxWorld), { steps });
    const p = o.add(d.mul(r.t)).add(r.normal.mul(float(world.minCell).mul(0.5))).toVar();
    const shaded = radianceSampler(p, r.normal);
    const rad = vec3(shaded.rad).mul(r.hit).toVar();
    const hitT = select(r.hit.greaterThan(0.5), r.t.max(1e-4), float(-1)).toVar();
    return { rad, t: hitT };
  };
}

/**
 * Debug material for the "Occupancy" view: hierarchical-DDA the pyramid from
 * the camera and shade hits by voxel face normal, tinted by which pyramid level
 * the ray was on when it descended. This is the instrument for "is a column
 * actually in the field" — the one question every leak in this module has come
 * down to — and it marches EXACTLY what the transport rays march, because a
 * debug view that renders a different field than the traces lies about the
 * thing it exists to show.
 */
export function createOccupancyDebugMaterial(volume) {
  const occField = volume.occupancyField;
  const { world } = volume;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const minV = vec3(world.min).toVar();
    const sizeV = vec3(world.size).toVar();
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    // Slab entry so an outside camera starts marching AT the volume.
    const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
    const bmax = minV.add(sizeV).toVar();
    const t1x = minV.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t2x = bmax.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t1y = minV.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t2y = bmax.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t1z = minV.z.sub(cameraPosition.z).div(invEps(dir.z));
    const t2z = bmax.z.sub(cameraPosition.z).div(invEps(dir.z));
    const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z));
    const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z));

    // A generous budget: this view exists to show what IS there, so it must not
    // report a hole the transport rays would not see just because it ran out of
    // iterations (the failure that made the sparse field look broken when the
    // MARCHER was starved).
    const r = occField.traceOccupancy(
      cameraPosition, dir, tEnter.max(0), tExit.max(0), { steps: 256 },
    );
    If(r.hit.lessThan(0.5), () => {
      Discard();
    });
    // Normal-coloured with a headlight lambert — a missing, misplaced or
    // one-voxel-thin piece of geometry is immediately readable.
    const lambert = r.normal.dot(dir.negate()).abs().mul(0.6).add(0.4);
    return vec4(r.normal.mul(0.5).add(0.5).mul(lambert), 1);
  })();
  return material;
}

/**
 * Mirror ray: sphere trace of the composited field (+ detail slots) —
 * (origin, dir, maxTWorld) → { t } with t < 0 = miss. Much smoother hit
 * silhouettes than the old occupancy DDA (continuous distances vs binary
 * cells), and cheaper in open space (steps grow with distance from
 * geometry). The caller shades the hit via the trilinear radiance sampler.
 */
function createMirrorTrace(distanceTexture, world, res, atlas, steps = 64, sparse = null) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  // One WGSL function per shader (see createShadowTrace's note on compile
  // cost, and giFn.js on why the instance must be per-builder).
  const traceFn = sharedFn({
    name: "giMirrorTrace",
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "maxTWorld", type: "float" },
    ],
    body: (origin, dir, maxTWorld) => {
      // Uniform-derived values hoisted to locals before the loop — see the
      // shadow trace's note (driver pipeline-compile cost).
      const minCellV = float(minCell).toVar();
      const capWorldV = float(capWorld).toVar();
      const minV = vec3(world.min).toVar();
      const sizeInvV = vec3(1).div(world.size).toVar();
      const hitCut = minCellV.mul(0.45).toVar();
      const stepMin = minCellV.mul(0.4).toVar();
      const hitT = float(-1).toVar();
      // Skip the receiver's own surface: start past the origin cell.
      const t = float(minCellV.mul(1.5)).toVar();
      Loop({ start: 0, end: steps, name: "mirror" }, () => {
        If(t.greaterThanEqual(maxTWorld), () => {
          Break();
        });
        const p = origin.add(dir.mul(t)).toVar();
        const uvw = p.sub(minV).mul(sizeInvV).toVar();
        If(
          uvw.x.lessThan(0)
            .or(uvw.y.lessThan(0))
            .or(uvw.z.lessThan(0))
            .or(uvw.x.greaterThan(1))
            .or(uvw.y.greaterThan(1))
            .or(uvw.z.greaterThan(1)),
          () => {
            Break();
          },
        );
        const d = texture3D(distanceTexture, uvw).level(0).r.mul(capWorldV).toVar();
        if (sparse) {
          const fine = sparse.sample(p);
          d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
        }
        d.assign(atlas.refineDetail(d, p));
        If(d.lessThan(hitCut), () => {
          hitT.assign(t);
          Break();
        });
        t.addAssign(d.mul(0.9).clamp(stepMin, capWorldV));
      });
      return hitT;
    },
  });

  return (origin, dir, maxTWorld) => ({ t: traceFn(vec3(origin), vec3(dir), float(maxTWorld)) });
}
