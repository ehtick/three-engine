/**
 * Virtual geometry preprocessing + selection — the Nanite-style core.
 *
 * buildClusterDAG() turns an indexed triangle mesh into a hierarchy of
 * ~128-triangle clusters:
 *
 *   level 0: the original triangles, partitioned into clusters (meshopt's
 *            buildMeshlets).
 *   level N+1: clusters of level N are grouped by spatial proximity (~4 per
 *            group), each group's triangles are merged and simplified to ~50%
 *            with the group's *boundary vertices locked* (so neighbouring
 *            groups always keep a bit-identical shared edge), and the
 *            simplified result is re-split into new clusters. Repeats until
 *            one cluster (or simplification stalls).
 *
 * Every cluster stores two error bounds, both as (sphere, error) pairs in
 * mesh-local units:
 *   self   — the error already committed by the simplification that PRODUCED
 *            this cluster (0 for level 0).
 *   parent — the error of the coarser clusters that REPLACE this one
 *            (Infinity when nothing coarser exists).
 *
 * selectClusters() then picks the cut through the DAG with a single flat,
 * order-independent test per cluster: draw iff
 *
 *   projected(self) <= tau  &&  projected(parent) > tau
 *
 * Because every cluster in a group shares the exact same (sphere, error)
 * pair for a given boundary, adjacent clusters always agree on which side of
 * tau that boundary falls — the cut is consistent and crack-free, with no
 * tree traversal and no per-frame allocation.
 *
 * This file is deliberately three.js-free (plain typed arrays only) so the
 * whole pipeline can be unit-tested headlessly in Node.
 */

// meshopt requires max_vertices <= 255 and max_triangles <= 512 (mult. of 4).
const MAX_VERTICES = 128;
const MAX_TRIANGLES = 128;
// Clusters merged per group before simplification. Larger groups have
// proportionally less locked boundary, so simplification stalls less and the
// hierarchy converges to a coarser top (important since dropping `Prune` —
// see below); the cost is chunkier LOD granularity per switch.
const GROUP_SIZE = 8;
const SIMPLIFY_TARGET = 0.5;
// A group that keeps more than this fraction of its triangles is "stalled"
// (locked borders left nothing to collapse) — its children stay as leaves of
// the hierarchy rather than looping forever.
const STALL_RATIO = 0.9;
// Generous: hitting the cap leaves the coarsest LOD denser than it could be
// (the level loop already stops on its own when no group makes progress).
const MAX_LEVELS = 40;

/** Floats per cluster in `clusterMeta`:
 *  [0..3] tight sphere x,y,z,r      — frustum culling
 *  [4..7] self LOD sphere x,y,z,r   — error projection
 *  [8]    self error
 *  [9..12] parent LOD sphere x,y,z,r
 *  [13]   parent error (Infinity at the roots) */
export const CLUSTER_STRIDE = 14;

let _meshopt = null;
async function loadMeshopt() {
  if (!_meshopt) {
    const m = await import("meshoptimizer");
    await Promise.all([m.MeshoptSimplifier.ready, m.MeshoptClusterizer.ready]);
    _meshopt = { simplifier: m.MeshoptSimplifier, clusterizer: m.MeshoptClusterizer };
  }
  return _meshopt;
}

/** Time-sliced yield so multi-second builds don't freeze the editor UI. */
function makeYielder(budgetMs = 12) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budgetMs) return;
    await new Promise((r) => setTimeout(r, 0));
    last = performance.now();
  };
}

/** 30-bit Morton code from 10-bit-quantized xyz. */
function part1by2(n) {
  n &= 0x3ff;
  n = (n | (n << 16)) & 0x30000ff;
  n = (n | (n << 8)) & 0x300f00f;
  n = (n | (n << 4)) & 0x30c30c3;
  n = (n | (n << 2)) & 0x9249249;
  return n;
}

/**
 * Epsilon-tolerant position weld: remap[v] = canonical vertex id for every
 * vertex within `eps` of it. Real assets (photogrammetry, seam-heavy
 * exports, quantization round-trips) routinely carry UV-seam duplicates
 * whose positions differ by a float ULP — an EXACT weld (meshopt's
 * generatePositionRemap) misses those, the group-boundary lock then sees the
 * two copies as different positions, one side goes unlocked, and the
 * simplifier opens a crack along the seam. Over-welding is the safe
 * direction here: the remap only feeds lock detection, so a false merge just
 * locks a vertex that could have moved.
 */
function weldPositions(positions, vertexCount, eps) {
  const eps2 = eps * eps;
  const g = eps * 4; // cell size; a vertex's eps-ball spans ≤2 cells per axis
  const buckets = new Map(); // cell hash -> canonical vertex ids (collisions ok — distance-checked)
  const remap = new Uint32Array(vertexCount);
  const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const x0 = Math.floor((x - eps) / g), x1 = Math.floor((x + eps) / g);
    const y0 = Math.floor((y - eps) / g), y1 = Math.floor((y + eps) / g);
    const z0 = Math.floor((z - eps) / g), z1 = Math.floor((z + eps) / g);
    let found = -1;
    for (let xi = x0; xi <= x1 && found < 0; xi++) {
      for (let yi = y0; yi <= y1 && found < 0; yi++) {
        for (let zi = z0; zi <= z1 && found < 0; zi++) {
          const arr = buckets.get(hash(xi, yi, zi));
          if (!arr) continue;
          for (const c of arr) {
            const dx = positions[c * 3] - x, dy = positions[c * 3 + 1] - y, dz = positions[c * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= eps2) { found = c; break; }
          }
        }
      }
    }
    if (found >= 0) {
      remap[v] = found;
    } else {
      remap[v] = v;
      const key = hash(Math.floor(x / g), Math.floor(y / g), Math.floor(z / g));
      const arr = buckets.get(key);
      if (arr) arr.push(v);
      else buckets.set(key, [v]);
    }
  }
  return remap;
}

/** Grows sphere `a` (in place, [x,y,z,r]) to enclose sphere `b`. */
function encloseSphere(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d + b[3] <= a[3]) return; // b already inside a
  if (d + a[3] <= b[3]) {
    a[0] = b[0]; a[1] = b[1]; a[2] = b[2]; a[3] = b[3];
    return;
  }
  const r = (d + a[3] + b[3]) * 0.5;
  const t = (r - a[3]) / d;
  a[0] += dx * t; a[1] += dy * t; a[2] += dz * t; a[3] = r;
}

/**
 * Groups a level's clusters by chunking a Morton-ordered sort of their tight
 * sphere centers. Cruder than Nanite's graph partitioning, but adjacency in
 * Morton order is a decent proxy for mesh adjacency at cluster granularity.
 * The quantization grid is offset a little each level so group boundaries
 * (whose vertices get locked and thus survive simplification) don't pile up
 * on the same seams level after level.
 */
function groupClusters(level, levelIndex) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of level) {
    minX = Math.min(minX, c.tight[0]); maxX = Math.max(maxX, c.tight[0]);
    minY = Math.min(minY, c.tight[1]); maxY = Math.max(maxY, c.tight[1]);
    minZ = Math.min(minZ, c.tight[2]); maxZ = Math.max(maxZ, c.tight[2]);
  }
  const sx = 1023 / Math.max(1e-20, maxX - minX);
  const sy = 1023 / Math.max(1e-20, maxY - minY);
  const sz = 1023 / Math.max(1e-20, maxZ - minZ);
  const jitter = (levelIndex % 3) * 0.33; // de-correlate seams across levels
  const order = level.map((c, i) => {
    const qx = Math.min(1023, Math.max(0, (c.tight[0] - minX) * sx + jitter)) | 0;
    const qy = Math.min(1023, Math.max(0, (c.tight[1] - minY) * sy + jitter)) | 0;
    const qz = Math.min(1023, Math.max(0, (c.tight[2] - minZ) * sz + jitter)) | 0;
    return { i, key: part1by2(qx) | (part1by2(qy) << 1) | (part1by2(qz) << 2) };
  });
  order.sort((a, b) => a.key - b.key);
  const groups = [];
  for (let i = 0; i < order.length; i += GROUP_SIZE) {
    groups.push(order.slice(i, i + GROUP_SIZE).map((o) => o.i));
  }
  return groups;
}

/**
 * Marks the vertices that must not move during this level's simplification:
 * any vertex whose *welded position* is used by clusters in two different
 * groups. Interior vertices (even ones shared between clusters of the SAME
 * group) stay free — collapsing those is the entire point of grouping.
 */
function computeGroupBoundaryLocks(level, groupOf, remap, scratch) {
  const { posGroup, lock } = scratch;
  posGroup.fill(-1);
  lock.fill(0);
  for (let ci = 0; ci < level.length; ci++) {
    const g = groupOf[ci];
    const idx = level[ci].indices;
    for (let j = 0; j < idx.length; j++) {
      const p = remap[idx[j]];
      if (posGroup[p] === -1) posGroup[p] = g;
      else if (posGroup[p] !== g) posGroup[p] = -2; // shared across groups
    }
  }
  for (let v = 0; v < lock.length; v++) {
    if (posGroup[remap[v]] === -2) lock[v] = 1;
  }
  return lock;
}

/** Splits an index list into ≤MAX_TRIANGLES clusters; returns cluster objects. */
function splitIntoClusters(clusterizer, indices, positions, selfSphere, selfError, levelIndex) {
  const buffers = clusterizer.buildMeshlets(indices, positions, 3, MAX_VERTICES, MAX_TRIANGLES);
  const out = [];
  for (let m = 0; m < buffers.meshletCount; m++) {
    const meshlet = clusterizer.extractMeshlet(buffers, m);
    const triCount = (meshlet.triangles.length / 3) | 0;
    const glob = new Uint32Array(triCount * 3);
    for (let j = 0; j < glob.length; j++) glob[j] = meshlet.vertices[meshlet.triangles[j]];
    const b = clusterizer.computeClusterBounds(glob, positions, 3);
    const tight = [b.centerX, b.centerY, b.centerZ, b.radius];
    out.push({
      indices: glob,
      tight,
      // Level-0 clusters have zero committed error, so their LOD sphere is
      // never projected — reuse the tight sphere. Coarser clusters inherit
      // the (sphere, error) of the group that produced them, shared exactly
      // with the group's children's `parent` fields — that equality is what
      // makes the flat cut crack-free.
      self: selfSphere ? [...selfSphere, selfError] : [...tight, 0],
      parent: null, // null = no coarser version (packed as Infinity)
      level: levelIndex,
    });
  }
  return out;
}

/**
 * Builds the full cluster DAG for one mesh.
 *
 * @param {Object} mesh — plain typed arrays (three.js-free):
 *   positions Float32Array (xyz), normals Float32Array (xyz),
 *   uvs Float32Array|null (xy), indices Uint32Array
 * @returns {Promise<Object>} dag — packed, selection-ready:
 *   indexData Uint32Array     all clusters' triangle indices, concatenated
 *   clusterRanges Uint32Array [offset, count] per cluster into indexData
 *   clusterMeta Float32Array  CLUSTER_STRIDE floats per cluster (see above)
 *   clusterCount, levelCount, lod0IndexCount (worst-case cut size),
 *   bounds [x,y,z,r] whole-mesh sphere, triangleCounts per level
 */
export async function buildClusterDAG({ positions, normals, uvs, indices }) {
  const { simplifier, clusterizer } = await loadMeshopt();
  const maybeYield = makeYielder();
  const vertexCount = (positions.length / 3) | 0;

  const scale = simplifier.getScale(positions, 3);

  // Welded-position ids: two vertices split by a UV/normal seam share a
  // position id, so seams don't read as "mesh boundary" when computing locks.
  // Epsilon-tolerant (see weldPositions) — exact welding cracks real assets.
  const remap = weldPositions(positions, vertexCount, Math.max(scale * 1e-5, 1e-12));

  // Snap welded duplicates bitwise onto their canonical position in a
  // BUILD-SPACE copy. meshopt's internal seam handling (collapsing both
  // wedges of a UV seam together) also keys on exact position equality, so
  // near-equal seam copies would otherwise be treated as two independent
  // open borders and simplified apart — cracks along every interior seam.
  // Rendering still uses the original vertex buffer: the snap (≤ eps) is far
  // below the seam gap the asset already ships with.
  let buildPositions = positions;
  for (let v = 0; v < vertexCount; v++) {
    const c = remap[v];
    if (c === v) continue;
    if (buildPositions === positions) buildPositions = positions.slice();
    buildPositions[v * 3] = buildPositions[c * 3];
    buildPositions[v * 3 + 1] = buildPositions[c * 3 + 1];
    buildPositions[v * 3 + 2] = buildPositions[c * 3 + 2];
  }

  // Attribute buffer for simplifyWithAttributes: normals (+ uvs). Weights are
  // in absolute distance units (we simplify with ErrorAbsolute), scaled to a
  // small fraction of the mesh extent so attributes steer collapse choices
  // without dominating the geometric error.
  const hasUv = !!(uvs && uvs.length >= vertexCount * 2);
  const attrStride = hasUv ? 5 : 3;
  const attrs = new Float32Array(vertexCount * attrStride);
  for (let v = 0; v < vertexCount; v++) {
    attrs[v * attrStride] = normals[v * 3];
    attrs[v * attrStride + 1] = normals[v * 3 + 1];
    attrs[v * attrStride + 2] = normals[v * 3 + 2];
    if (hasUv) {
      attrs[v * attrStride + 3] = uvs[v * 2];
      attrs[v * attrStride + 4] = uvs[v * 2 + 1];
    }
  }
  const nw = 0.01 * scale;
  const uw = 0.02 * scale;
  const weights = hasUv ? [nw, nw, nw, uw, uw] : [nw, nw, nw];
  // No `Prune`: pruning deletes small disconnected components wholesale, and
  // locked border vertices don't protect a component's interior — a Morton
  // group containing a tiny island would lose it while the neighbouring
  // group keeps the shared boundary, leaving a permanent crack that grows
  // through every coarser level.
  const simplifyFlags = ["ErrorAbsolute", "Sparse"];

  const lockScratch = { posGroup: new Int32Array(vertexCount), lock: new Uint8Array(vertexCount) };

  let level = splitIntoClusters(clusterizer, indices, buildPositions, null, 0, 0);
  const all = [...level];
  const triangleCounts = [(indices.length / 3) | 0];
  let levelCount = 1;

  while (level.length > 1 && levelCount < MAX_LEVELS) {
    const groups = groupClusters(level, levelCount);
    const groupOf = new Int32Array(level.length);
    groups.forEach((g, gi) => g.forEach((ci) => (groupOf[ci] = gi)));
    const lock = computeGroupBoundaryLocks(level, groupOf, remap, lockScratch);

    const next = [];
    let levelTris = 0;
    for (const g of groups) {
      await maybeYield();
      let total = 0;
      for (const ci of g) total += level[ci].indices.length;
      const merged = new Uint32Array(total);
      for (let ci = 0, off = 0; ci < g.length; ci++) {
        merged.set(level[g[ci]].indices, off);
        off += level[g[ci]].indices.length;
      }

      const target = Math.max(3, Math.floor((total * SIMPLIFY_TARGET) / 3) * 3);
      const [simplified, error] =
        g.length > 1
          ? simplifier.simplifyWithAttributes(
              merged, buildPositions, 3, attrs, attrStride, weights, lock, target, 1e30, simplifyFlags,
            )
          : [merged, 0]; // singleton group: nothing to merge, just carry over
      if (g.length === 1 || !simplified.length || simplified.length >= total * STALL_RATIO) {
        // Stalled (locked borders left nothing to collapse) or singleton:
        // carry the clusters into the next level unchanged so they can
        // regroup with different neighbours — freezing them here would leave
        // permanently-dense islands at any distance. The `next.length >=
        // level.length` guard below terminates when NO group makes progress.
        for (const ci of g) {
          next.push(level[ci]);
          levelTris += level[ci].indices.length / 3;
        }
        continue;
      }

      // Shared (sphere, error) for this group: sphere encloses every child's
      // LOD sphere; error is monotonic (>= every child's self error).
      const sphere = [...level[g[0]].self.slice(0, 4)];
      let childErr = 0;
      for (const ci of g) {
        encloseSphere(sphere, level[ci].self);
        childErr = Math.max(childErr, level[ci].self[4]);
      }
      const groupError = childErr + error;
      for (const ci of g) level[ci].parent = [...sphere, groupError];

      const children = splitIntoClusters(clusterizer, simplified, buildPositions, sphere, groupError, levelCount);
      next.push(...children);
      all.push(...children); // carried-over clusters are already in `all`
      levelTris += simplified.length / 3;
    }

    if (!next.length || next.length >= level.length) break; // no progress
    triangleCounts.push(levelTris | 0);
    levelCount++;
    level = next;
  }

  // Pack everything into flat typed arrays for allocation-free selection.
  let totalIndices = 0;
  for (const c of all) totalIndices += c.indices.length;
  const indexData = new Uint32Array(totalIndices);
  const clusterRanges = new Uint32Array(all.length * 2);
  const clusterMeta = new Float32Array(all.length * CLUSTER_STRIDE);
  const clusterLevels = new Uint16Array(all.length);
  let cursor = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    clusterLevels[i] = c.level;
    indexData.set(c.indices, cursor);
    clusterRanges[i * 2] = cursor;
    clusterRanges[i * 2 + 1] = c.indices.length;
    cursor += c.indices.length;
    const o = i * CLUSTER_STRIDE;
    clusterMeta[o] = c.tight[0]; clusterMeta[o + 1] = c.tight[1];
    clusterMeta[o + 2] = c.tight[2]; clusterMeta[o + 3] = c.tight[3];
    clusterMeta[o + 4] = c.self[0]; clusterMeta[o + 5] = c.self[1];
    clusterMeta[o + 6] = c.self[2]; clusterMeta[o + 7] = c.self[3];
    clusterMeta[o + 8] = c.self[4];
    if (c.parent) {
      clusterMeta[o + 9] = c.parent[0]; clusterMeta[o + 10] = c.parent[1];
      clusterMeta[o + 11] = c.parent[2]; clusterMeta[o + 12] = c.parent[3];
      clusterMeta[o + 13] = c.parent[4];
    } else {
      clusterMeta[o + 13] = Infinity;
    }
  }

  // Whole-mesh bounding sphere (from the position bbox — a loose fit is fine,
  // it only feeds three.js frustum culling and viewOnly gating).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const dx = maxX - cx, dy = maxY - cy, dz = maxZ - cz;

  return {
    indexData,
    clusterRanges,
    clusterMeta,
    clusterLevels,
    clusterCount: all.length,
    levelCount,
    lod0IndexCount: indices.length,
    bounds: [cx, cy, cz, Math.sqrt(dx * dx + dy * dy + dz * dz)],
    triangleCounts,
  };
}

/**
 * Returns the coarsest complete cut through a cluster DAG. Roots are the
 * clusters with no parent error (Infinity); together they still cover the
 * whole mesh, including regions whose simplification stalled.
 */
export function getCoarsestClusterIndices(dag) {
  const roots = [];
  let total = 0;
  for (let cluster = 0; cluster < dag.clusterCount; cluster++) {
    const metaOffset = cluster * CLUSTER_STRIDE;
    if (dag.clusterMeta[metaOffset + 13] !== Infinity) continue;
    roots.push(cluster);
    total += dag.clusterRanges[cluster * 2 + 1];
  }
  const indices = new Uint32Array(total);
  let cursor = 0;
  for (const cluster of roots) {
    const offset = dag.clusterRanges[cluster * 2];
    const count = dag.clusterRanges[cluster * 2 + 1];
    indices.set(dag.indexData.subarray(offset, offset + count), cursor);
    cursor += count;
  }
  return indices;
}

/**
 * Picks the LOD cut and writes the selected clusters' indices into
 * `outIndices` (must hold dag.lod0IndexCount — a cut can never exceed the
 * full-detail triangle count). Returns the number of indices written.
 * Allocation-free; everything is in MESH-LOCAL space:
 *
 * @param {number} camX/Y/Z  camera position in mesh-local space
 * @param {number} k         perspective: screenHeightPx / (2·tan(fovY/2));
 *                           orthographic: pixels per local unit
 * @param {boolean} isOrtho  orthographic projection (no distance falloff)
 * @param {number} tau       screen-space error threshold in pixels
 * @param {Float32Array|null} planes  6 frustum planes in local space, packed
 *                           [nx,ny,nz,constant]×6 (null = skip culling)
 * @param {Uint32Array|null} outClusters  selected cluster ids (for debug viz)
 * @param {Object|null} stats  gets .drawnClusters / .testedClusters
 *
 * Note on scale: for a uniformly scaled mesh the world scale cancels out of
 * error/distance, so local-space math is exact. Non-uniform scale makes the
 * threshold approximate (never a crack — both sides of the cut use the same
 * approximation — just a slightly early/late LOD switch along one axis).
 */
export function selectClusters(dag, camX, camY, camZ, k, isOrtho, tau, planes, outIndices, outClusters = null, stats = null) {
  const meta = dag.clusterMeta;
  const ranges = dag.clusterRanges;
  const src = dag.indexData;
  const n = dag.clusterCount;
  let cursor = 0;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const o = i * CLUSTER_STRIDE;

    // Projected self error must be within tolerance…
    const selfErr = meta[o + 8];
    if (selfErr > 0) {
      let px;
      if (isOrtho) {
        px = selfErr * k;
      } else {
        const dx = meta[o + 4] - camX, dy = meta[o + 5] - camY, dz = meta[o + 6] - camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - meta[o + 7];
        px = d > 0 ? (selfErr * k) / d : Infinity; // camera inside sphere
      }
      if (px > tau) continue;
    }

    // …while the parent's must NOT be (otherwise the coarser version covers us).
    const parentErr = meta[o + 13];
    if (parentErr !== Infinity) {
      let px;
      if (isOrtho) {
        px = parentErr * k;
      } else {
        const dx = meta[o + 9] - camX, dy = meta[o + 10] - camY, dz = meta[o + 11] - camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - meta[o + 12];
        px = d > 0 ? (parentErr * k) / d : Infinity;
      }
      if (px <= tau) continue;
    }

    // In the cut — frustum-cull with the tight sphere.
    if (planes) {
      const cx = meta[o], cy = meta[o + 1], cz = meta[o + 2], r = meta[o + 3];
      let out = false;
      for (let p = 0; p < 24; p += 4) {
        if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) {
          out = true;
          break;
        }
      }
      if (out) continue;
    }

    const off = ranges[i * 2], cnt = ranges[i * 2 + 1];
    outIndices.set(src.subarray(off, off + cnt), cursor);
    cursor += cnt;
    if (outClusters) outClusters[drawn] = i;
    drawn++;
  }
  if (stats) {
    stats.drawnClusters = drawn;
    stats.testedClusters = n;
  }
  return cursor;
}

/**
 * The selection test WITHOUT the index gather: writes the ids of the clusters
 * that belong in the cut into `outClusters` and returns how many. Same flat,
 * order-independent test as selectClusters (see that function's docstring) —
 * split out so the runtime can compare the selected SET against last frame's
 * and skip the (comparatively expensive) index buffer rebuild + GPU re-upload
 * whenever the cut didn't actually change. Allocation-free; MESH-LOCAL space.
 */
export function selectClusterIds(dag, camX, camY, camZ, k, isOrtho, tau, outClusters, stats = null) {
  const meta = dag.clusterMeta;
  const n = dag.clusterCount;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const o = i * CLUSTER_STRIDE;

    const selfErr = meta[o + 8];
    if (selfErr > 0) {
      let px;
      if (isOrtho) {
        px = selfErr * k;
      } else {
        const dx = meta[o + 4] - camX, dy = meta[o + 5] - camY, dz = meta[o + 6] - camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - meta[o + 7];
        px = d > 0 ? (selfErr * k) / d : Infinity;
      }
      if (px > tau) continue;
    }

    const parentErr = meta[o + 13];
    if (parentErr !== Infinity) {
      let px;
      if (isOrtho) {
        px = parentErr * k;
      } else {
        const dx = meta[o + 9] - camX, dy = meta[o + 10] - camY, dz = meta[o + 11] - camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - meta[o + 12];
        px = d > 0 ? (parentErr * k) / d : Infinity;
      }
      if (px <= tau) continue;
    }

    outClusters[drawn++] = i;
  }
  if (stats) {
    stats.drawnClusters = drawn;
    stats.testedClusters = n;
  }
  return drawn;
}

/**
 * Gathers the triangle indices of an already-selected cluster set (produced by
 * selectClusterIds) into `outIndices` (must hold dag.lod0IndexCount). Returns
 * the number of indices written. This is the O(drawn triangles) memcpy that
 * feeds the dynamic index buffer, so the runtime only calls it when the set
 * changed.
 */
export function gatherClusterIndices(dag, clusterIds, clusterCount, outIndices) {
  const ranges = dag.clusterRanges;
  const src = dag.indexData;
  let cursor = 0;
  for (let s = 0; s < clusterCount; s++) {
    const i = clusterIds[s];
    const off = ranges[i * 2], cnt = ranges[i * 2 + 1];
    outIndices.set(src.subarray(off, off + cnt), cursor);
    cursor += cnt;
  }
  return cursor;
}
