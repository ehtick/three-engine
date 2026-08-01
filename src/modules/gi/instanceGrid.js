// TOP-LEVEL acceleration structure over the atlas's instance slots — the
// "hierarchical" half of hierarchical instanced SDFs.
//
// WHAT IT REPLACES. Two places used to consider EVERY slot:
//
//   * `sdfScene.js`'s composite pass — one thread per field cell, each
//     looping the full slot capacity and AABB-testing its way out. That is
//     `cells × capacity` AABB tests per composite (~1M × 32 today), and it
//     is why raising the object budget was never just a matter of making the
//     uniform arrays longer: at 512 slots the composite would have cost 16×
//     what it does at 32.
//   * `meshSdfAtlas.js`'s `refineDetail` — the per-STEP refinement inside
//     shadow and mirror traces. Every trace step pays for it, so it can only
//     afford a handful of slots, and those were picked GLOBALLY: one ranked
//     list of ~12 for the whole scene. A wall-heavy room spent the entire
//     budget on walls and left the character unrefined ("12 more candidates
//     over budget (raise Quality)"), and a ray on the far side of the level
//     paid to test walls it could not possibly be near.
//
// Both become "look up the cell you are standing in, walk its candidates".
// The refine budget stops being a scene-wide competition and becomes a LOCAL
// one, which is the fix for the over-budget message: 12 candidates near the
// ray is a completely different (and much larger) amount of refinement than
// the 12 most important candidates in the level.
//
// WHY UNIFORM ARRAYS AND NOT A STORAGE BUFFER. `refineDetail` runs in
// FRAGMENT shaders — every GI-lit material in the scene. Storage buffers are
// a scarce, per-stage binding resource there (see the ReSTIR notes: eight is
// the guaranteed floor and this pipeline already spends most of them), while
// uniform arrays are what the whole atlas already streams per render. The
// cost is WebGPU's guaranteed 64KB `maxUniformBufferBindingSize`, which is
// what sets the numbers below.
//
// LAYOUT. Fixed stride, no prefix sum: cell c owns entries
// `[c*CELL_STRIDE, (c+1)*CELL_STRIDE)`, packed four slot indices per vec4 so
// the padding rule for uniform arrays (every element is padded to 16 bytes —
// a float array would waste 4× here) works for us instead of against us.
// `cellGroups[c]` says how many vec4 GROUPS to read, so the shader loop is
// dynamic in groups and statically unrolled in lanes — the same shape the
// old fixed-12 refine loop compiled to, which keeps WGSL size flat.
//
//   8³ cells × 24 ids = 3072 vec4 = 48KB, and 8³ is not arbitrary: slot AABBs
//   are expanded by the field's cap reach (`SDF_CAP` = 16 cells) before they
//   are inserted, so a grid much finer than that reach only duplicates the
//   same slot into more cells without shortening any list.
import * as THREE from "three/webgpu";
import { If, Loop, int, select, uniform, uniformArray, vec3 } from "three/tsl";

export const GRID_AXIS = 8;
export const GRID_CELLS = GRID_AXIS * GRID_AXIS * GRID_AXIS;
/** Slot indices a cell can list before it falls back to a full scan. */
export const CELL_STRIDE = 24;
export const CELL_GROUPS = CELL_STRIDE / 4; // vec4s per cell

/** Sentinel in `cellGroups`: this cell overflowed — consider every slot. */
const SCAN_ALL = -1;

/**
 * @param {import("./meshSdfAtlas.js").MeshSdfAtlas} atlas
 */
export function createInstanceGrid(atlas) {
  // World → grid parameterization, uniforms for the same reason the volume's
  // are: an auto-fit refit must not recompile anything.
  const gridMin = uniform(new THREE.Vector3());
  const gridInvCell = uniform(new THREE.Vector3(1, 1, 1));

  // cellGroups[c] — vec4 groups to read for cell c, or SCAN_ALL.
  const cellGroups = uniformArray(Array.from({ length: GRID_CELLS }, () => 0), "float");
  // cellItems[c*CELL_GROUPS + g] — four slot indices; -1 pads the tail.
  const cellItems = uniformArray(
    Array.from({ length: GRID_CELLS * CELL_GROUPS }, () => new THREE.Vector4(-1, -1, -1, -1)),
  );

  // CPU build state. `counts` is the live length of each cell's list;
  // `overflowed` records cells that wanted more than CELL_STRIDE.
  const counts = new Int32Array(GRID_CELLS);
  const overflowed = new Uint8Array(GRID_CELLS);
  const scratchLane = ["x", "y", "z", "w"];

  let dirty = true;
  let lastBounds = null;
  const stats = { cells: GRID_CELLS, listed: 0, overflowCells: 0, maxList: 0, builds: 0 };

  const setEntry = (cell, rank, slot) => {
    const v = cellItems.array[cell * CELL_GROUPS + (rank >> 2)];
    v[scratchLane[rank & 3]] = slot;
  };

  const grid = {
    GRID_AXIS,
    CELL_STRIDE,
    gridMin,
    gridInvCell,
    cellGroups,
    cellItems,
    stats,

    /** Marks the structure stale; the next `update()` rebuilds it. */
    invalidate() {
      dirty = true;
    },

    get isDirty() {
      return dirty;
    },

    /**
     * Rebuilds the lists from the atlas's live slot AABBs if anything moved.
     * Cheap enough to call every frame — a no-op unless a slot changed, and
     * a full rebuild is one pass over the slots (a few thousand pushes at
     * the 512-slot ceiling).
     *
     * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds volume bounds
     * @returns {boolean} true when the lists changed
     */
    update(bounds) {
      const moved =
        !lastBounds ||
        !lastBounds.min.equals(bounds.min) ||
        !lastBounds.max.equals(bounds.max);
      if (!dirty && !moved) return false;
      dirty = false;
      lastBounds = { min: bounds.min.clone(), max: bounds.max.clone() };

      const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
      // A degenerate axis would divide by zero and put every slot in cell 0.
      const cellX = Math.max(1e-6, size.x / GRID_AXIS);
      const cellY = Math.max(1e-6, size.y / GRID_AXIS);
      const cellZ = Math.max(1e-6, size.z / GRID_AXIS);
      gridMin.value.copy(bounds.min);
      gridInvCell.value.set(1 / cellX, 1 / cellY, 1 / cellZ);

      counts.fill(0);
      overflowed.fill(0);
      for (const v of cellItems.array) v.set(-1, -1, -1, -1);

      // PRIORITY ORDER. A cell keeps the first CELL_STRIDE slots offered to
      // it, and the trace refine reads only the first few of those, so the
      // insertion order IS the quality policy — the same one the global
      // detail list used, now applied per cell: sub-cell geometry (thin
      // walls, hollow room shells, analytic primitives) first, because those
      // are the ones the composited field physically cannot represent and
      // that leak light when a trace steps over them; then the densest baked
      // meshes, whose silhouettes carry the shadows people actually look at.
      const order = [];
      for (let i = 0; i < atlas.assignments.length; i++) {
        if (!atlas.assignments[i]) continue;
        if (atlas.aabbMin.array[i].w < 0.5) continue; // inactive
        order.push(i);
      }
      const priority = atlas.slotPriority;
      if (priority) order.sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0));

      let listed = 0;
      let maxList = 0;
      for (const slot of order) {
        const bmin = atlas.aabbMin.array[slot];
        const bmax = atlas.aabbMax.array[slot];
        // Grid range of the slot's EXPANDED world box, clamped to the grid.
        const x0 = clampCell((bmin.x - bounds.min.x) / cellX);
        const y0 = clampCell((bmin.y - bounds.min.y) / cellY);
        const z0 = clampCell((bmin.z - bounds.min.z) / cellZ);
        const x1 = clampCell((bmax.x - bounds.min.x) / cellX);
        const y1 = clampCell((bmax.y - bounds.min.y) / cellY);
        const z1 = clampCell((bmax.z - bounds.min.z) / cellZ);
        for (let z = z0; z <= z1; z++) {
          for (let y = y0; y <= y1; y++) {
            const rowBase = (z * GRID_AXIS + y) * GRID_AXIS;
            for (let x = x0; x <= x1; x++) {
              const cell = rowBase + x;
              const n = counts[cell];
              if (n >= CELL_STRIDE) {
                overflowed[cell] = 1;
                continue;
              }
              setEntry(cell, n, slot);
              counts[cell] = n + 1;
              listed++;
              if (n + 1 > maxList) maxList = n + 1;
            }
          }
        }
      }

      let overflowCells = 0;
      for (let c = 0; c < GRID_CELLS; c++) {
        if (overflowed[c]) {
          overflowCells++;
          // Correctness over speed: a cell that could not list everything
          // near it makes the composite scan all slots, exactly as it did
          // before this file existed. Never drop geometry from the field —
          // a missing slot is a hole light pours through.
          cellGroups.array[c] = SCAN_ALL;
        } else {
          cellGroups.array[c] = Math.ceil(counts[c] / 4);
        }
      }

      stats.listed = listed;
      stats.overflowCells = overflowCells;
      stats.maxList = maxList;
      stats.builds++;
      return true;
    },

    /** Slot indices listed for a world point — CPU mirror, for tests. */
    candidatesAt(point, bounds) {
      const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
      const x = clampCell(((point.x - bounds.min.x) / size.x) * GRID_AXIS);
      const y = clampCell(((point.y - bounds.min.y) / size.y) * GRID_AXIS);
      const z = clampCell(((point.z - bounds.min.z) / size.z) * GRID_AXIS);
      const cell = (z * GRID_AXIS + y) * GRID_AXIS + x;
      if (cellGroups.array[cell] === SCAN_ALL) return null; // "all of them"
      const out = [];
      for (let r = 0; r < counts[cell]; r++) {
        const v = cellItems.array[cell * CELL_GROUPS + (r >> 2)];
        out.push(v[scratchLane[r & 3]]);
      }
      return out;
    },

    // ------------------------------------------------------------ TSL side

    /**
     * Flat cell index for a world point, as an int node. Points outside the
     * volume clamp into the boundary cell — whose list covers the geometry
     * near that face, which is what a ray leaving the volume needs.
     */
    cellIndex(p) {
      const g = vec3(p).sub(gridMin).mul(gridInvCell).floor().clamp(0, GRID_AXIS - 1).toVar();
      return g.z.mul(GRID_AXIS * GRID_AXIS).add(g.y.mul(GRID_AXIS)).add(g.x).toInt();
    },

    /** vec4-group count for a cell (negative = caller must scan all slots). */
    groupsAt(cell) {
      return cellGroups.element(int(cell));
    },

    /** The `g`-th packed vec4 of cell `cell`. */
    groupAt(cell, g) {
      return cellItems.element(int(cell).mul(CELL_GROUPS).add(int(g)));
    },

    dispose() {
      lastBounds = null;
      dirty = true;
    },
  };

  return grid;
}

const clampCell = (v) => {
  const i = Math.floor(v);
  return i < 0 ? 0 : i > GRID_AXIS - 1 ? GRID_AXIS - 1 : i;
};

/** Shared with the composite: how many candidate groups a full scan needs. */
export const scanAllSentinel = SCAN_ALL;

/**
 * Emits the loop over "slots worth testing at world point `p`" — the
 * BOTTOM-level traversal. `visit(slotIntNode)` builds the body; it is
 * emitted ONCE, so this costs no more shader code than the flat loop it
 * replaces.
 *
 * With no grid (or a null one) it degenerates to exactly the old
 * `Loop(0, capacity)`, which is what makes the grid a drop-in A/B.
 *
 * The overflow sentinel is handled INSIDE the loop rather than by branching
 * around two copies of the body: `count` becomes the full capacity and the
 * index passes straight through as the slot number. That keeps a cell that
 * could not list all its neighbours exactly as correct as the flat scan —
 * the composite is the field itself, and a slot silently dropped from it is
 * a hole that light pours through.
 *
 * @param {ReturnType<typeof createInstanceGrid>|null} grid
 * @param {number} capacity instance-slot capacity (the full-scan bound)
 * @param {*} p world position node
 * @param {(slot: *) => void} visit
 */
export function loopCandidates(grid, capacity, p, visit) {
  if (!grid) {
    Loop({ start: 0, end: capacity, name: "slot" }, ({ slot }) => visit(slot));
    return;
  }
  const cell = grid.cellIndex(p).toVar();
  const groups = grid.groupsAt(cell).toVar();
  const scanAll = groups.lessThan(0).toVar();
  const count = select(scanAll, int(capacity), groups.mul(4).toInt()).toVar();
  Loop({ start: 0, end: count, name: "cand" }, ({ cand }) => {
    // Clamped so the scan-all path (cand up to `capacity`) can never index
    // past this cell's own groups — the value is discarded by the select
    // below, but an out-of-range uniform-array read is not worth relying on.
    const packed = grid.groupAt(cell, cand.div(4).min(CELL_GROUPS - 1)).toVar();
    const lane = cand.mod(4).toVar();
    const listed = select(
      lane.equal(0),
      packed.x,
      select(lane.equal(1), packed.y, select(lane.equal(2), packed.z, packed.w)),
    ).toVar();
    const slot = select(scanAll, cand.toFloat(), listed).toVar();
    If(slot.greaterThanEqual(0), () => visit(slot.toInt()));
  });
}

/** Debug helper — one line describing the current occupancy. */
export function describeGrid(grid) {
  const s = grid.stats;
  return (
    `${GRID_AXIS}³ cells, ${s.listed} listings, max ${s.maxList}/${CELL_STRIDE} per cell` +
    (s.overflowCells ? `, ${s.overflowCells} overflowed → full scan` : "")
  );
}
