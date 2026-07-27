/**
 * Voxel remesh — Blender's Remesh, the operation people actually mean by the
 * word.
 *
 * The editor previously wrapped `remesh-threejs`, which is an *incremental*
 * remesher: it splits and collapses the edges of the mesh you already have.
 * That is a different operation wearing the same name. It cannot change the
 * topology's structure, it inherits every defect in the input, and — capped at
 * a few iterations — it converges long before it reaches a small target edge
 * length, so asking for finer detail returned the same mesh twice and the
 * button looked like it did nothing. On a cube, a target of 0.1 and a target of
 * 0.05 both produced 60 faces.
 *
 * A voxel remesh instead throws the input topology away and rebuilds the
 * surface from scratch:
 *
 *   1. sample the mesh into a signed distance field on a regular grid,
 *   2. extract the zero isosurface from that grid.
 *
 * The result has completely uniform density, is closed and manifold whatever
 * the input looked like, and is controlled by a single parameter with an
 * obvious meaning — the voxel size, in world units, exactly as Blender's is.
 *
 * The extraction is Surface Nets (dual contouring without the QEF): one vertex
 * per cell that straddles the surface, placed at the mean of the crossings on
 * the cell's edges. It is chosen over marching cubes because it emits *quads*,
 * which is what makes a voxel remesh a usable base for further modelling and
 * what Blender's output looks like.
 *
 * UVs do not survive, which is inherent — the output shares no vertices, edges
 * or faces with the input, so there is nothing to carry them on. Blender's
 * voxel remesh discards them too.
 */

import { addFace, addVert, createMesh } from "../bmesh.js";
import { faceTriangles } from "../tessellate.js";

/** Beyond this the grid stops being something to do on the main thread. */
const MAX_CELLS = 6_000_000;

export const VOXEL_REMESH_DEFAULTS = {
  adaptivity: 0,
  smoothIterations: 1,
};

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Squared distance from a point to a triangle, by Ericson's region test. */
function pointTriangleDistanceSquared(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx;
    const qy = apy - v * aby;
    const qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx;
    const qy = apy - w * acy;
    const qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx + w * (cpx - bpx);
    const qy = bpy + w * (cpy - bpy);
    const qz = bpz + w * (cpz - bpz);
    return qx * qx + qy * qy + qz * qz;
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  const qx = apx - (v * abx + w * acx);
  const qy = apy - (v * aby + w * acy);
  const qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

/** Flat triangle soup from the kernel: positions only, which is all this needs. */
function trianglesOf(mesh) {
  const positions = [];
  for (const face of mesh.faces) {
    const ring = face.loops.map((loop) => loop.v.co);
    for (const [a, b, c] of faceTriangles(face)) {
      positions.push(
        ring[a][0], ring[a][1], ring[a][2],
        ring[b][0], ring[b][1], ring[b][2],
        ring[c][0], ring[c][1], ring[c][2],
      );
    }
  }
  return new Float64Array(positions);
}

/* -------------------------------------------------------------------------- */
/* Field construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Unsigned distance in a narrow band around the surface.
 *
 * Only cells near a triangle are visited — the whole grid is far too much work
 * and the isosurface only cares about the band. Everything else keeps its
 * initial "far away" value and gets its sign from the parity pass.
 */
function buildDistanceField(triangles, grid) {
  const { dims, origin, voxel } = grid;
  const [nx, ny, nz] = dims;
  const distances = new Float32Array(nx * ny * nz).fill(Infinity);
  const band = voxel * 2.5;

  for (let at = 0; at < triangles.length; at += 9) {
    const ax = triangles[at], ay = triangles[at + 1], az = triangles[at + 2];
    const bx = triangles[at + 3], by = triangles[at + 4], bz = triangles[at + 5];
    const cx = triangles[at + 6], cy = triangles[at + 7], cz = triangles[at + 8];

    const lowX = Math.max(0, Math.floor((Math.min(ax, bx, cx) - band - origin[0]) / voxel));
    const highX = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) + band - origin[0]) / voxel));
    const lowY = Math.max(0, Math.floor((Math.min(ay, by, cy) - band - origin[1]) / voxel));
    const highY = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) + band - origin[1]) / voxel));
    const lowZ = Math.max(0, Math.floor((Math.min(az, bz, cz) - band - origin[2]) / voxel));
    const highZ = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) + band - origin[2]) / voxel));

    for (let k = lowZ; k <= highZ; k++) {
      const pz = origin[2] + k * voxel;
      for (let j = lowY; j <= highY; j++) {
        const py = origin[1] + j * voxel;
        const rowBase = (k * ny + j) * nx;
        for (let i = lowX; i <= highX; i++) {
          const px = origin[0] + i * voxel;
          const squared = pointTriangleDistanceSquared(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
          const index = rowBase + i;
          if (squared < distances[index] * distances[index]) distances[index] = Math.sqrt(squared);
        }
      }
    }
  }
  return distances;
}

/**
 * Inside/outside per grid point, by ray parity along X.
 *
 * Signing from the closest triangle's normal needs the angle-weighted
 * pseudonormal to be correct at edges and corners, and is fragile exactly where
 * a remesh is most useful — on messy input. Counting crossings along a ray is
 * exact for any closed surface however badly it is put together.
 *
 * The rays are nudged off the lattice by an irrational fraction of a voxel so
 * they do not run along an edge or through a vertex, where a crossing could be
 * counted twice or not at all.
 */
function buildInsideMask(triangles, grid) {
  const { dims, origin, voxel } = grid;
  const [nx, ny, nz] = dims;
  const inside = new Uint8Array(nx * ny * nz);
  // Two *different* nudges. Using one value for both axes puts every ray whose
  // row and column indices happen to match exactly on the plane y = z — which
  // is precisely where a quad's triangulation diagonal runs on a symmetric box.
  // Hitting a shared edge counts the crossing twice or not at all, so the
  // parity flipped along that whole diagonal and left a sheet of spurious
  // surface buried inside the model.
  const jitterY = voxel * 0.0013;
  const jitterZ = voxel * 0.0071;

  // Triangles bucketed by the (y, z) rows their bounds touch, so each ray only
  // tests the triangles that could possibly be in its way.
  const buckets = new Map();
  const key = (j, k) => k * ny + j;
  for (let at = 0; at < triangles.length; at += 9) {
    const y0 = Math.min(triangles[at + 1], triangles[at + 4], triangles[at + 7]);
    const y1 = Math.max(triangles[at + 1], triangles[at + 4], triangles[at + 7]);
    const z0 = Math.min(triangles[at + 2], triangles[at + 5], triangles[at + 8]);
    const z1 = Math.max(triangles[at + 2], triangles[at + 5], triangles[at + 8]);
    const lowY = Math.max(0, Math.floor((y0 - origin[1]) / voxel));
    const highY = Math.min(ny - 1, Math.ceil((y1 - origin[1]) / voxel));
    const lowZ = Math.max(0, Math.floor((z0 - origin[2]) / voxel));
    const highZ = Math.min(nz - 1, Math.ceil((z1 - origin[2]) / voxel));
    for (let k = lowZ; k <= highZ; k++) {
      for (let j = lowY; j <= highY; j++) {
        const id = key(j, k);
        let list = buckets.get(id);
        if (!list) buckets.set(id, (list = []));
        list.push(at);
      }
    }
  }

  const crossings = [];
  for (let k = 0; k < nz; k++) {
    const pz = origin[2] + k * voxel + jitterZ;
    for (let j = 0; j < ny; j++) {
      const list = buckets.get(key(j, k));
      if (!list?.length) continue;
      const py = origin[1] + j * voxel + jitterY;
      crossings.length = 0;

      for (const at of list) {
        // Möller–Trumbore against the +X ray through (py, pz).
        const ax = triangles[at], ay = triangles[at + 1], az = triangles[at + 2];
        const e1y = triangles[at + 4] - ay;
        const e1z = triangles[at + 5] - az;
        const e1x = triangles[at + 3] - ax;
        const e2x = triangles[at + 6] - ax;
        const e2y = triangles[at + 7] - ay;
        const e2z = triangles[at + 8] - az;
        // direction = (1, 0, 0), so cross(direction, e2) = (0, e2z, -e2y).
        const determinant = e1y * e2z - e1z * e2y;
        if (Math.abs(determinant) < 1e-18) continue;
        const inverse = 1 / determinant;
        const ty = py - ay;
        const tz = pz - az;
        const u = (ty * e2z - tz * e2y) * inverse;
        if (u < 0 || u > 1) continue;
        // cross(t, e1) . direction, with direction = (1, 0, 0)
        const v = (ty * e1z - tz * e1y) * -inverse;
        if (v < 0 || u + v > 1) continue;
        crossings.push(ax + u * e1x + v * e2x);
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);

      // Between an odd and the next even crossing is the interior.
      const rowBase = (k * ny + j) * nx;
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const from = Math.max(0, Math.ceil((crossings[pair] - origin[0]) / voxel));
        const to = Math.min(nx - 1, Math.floor((crossings[pair + 1] - origin[0]) / voxel));
        for (let i = from; i <= to; i++) inside[rowBase + i] = 1;
      }
    }
  }
  return inside;
}

/**
 * The signed field the isosurface is extracted from.
 *
 * The unsigned distances are signed by the parity mask, clamped to the band
 * (everything further away is just "far", and an unbounded value cannot be
 * filtered), and then lightly smoothed.
 *
 * The smoothing is not cosmetic. Surface Nets puts exactly one vertex in each
 * cell, so where a surface turns through a sharp angle inside a single cell,
 * two sheets are forced through one vertex and the edges along that feature end
 * up with four faces on them instead of two. A cube came out with every one of
 * its twelve edges non-manifold. Rounding the field over about a voxel — which
 * is what a narrow-band SDF looks like in Blender, and no finer than the voxel
 * size claims to resolve anyway — separates those sheets.
 */
function buildSignedField(distances, inside, grid, passes) {
  const { dims, voxel } = grid;
  const [nx, ny, nz] = dims;
  const limit = voxel * 2.5;
  let field = new Float32Array(distances.length);
  for (let index = 0; index < field.length; index++) {
    const magnitude = Math.min(distances[index], limit);
    field[index] = inside[index] ? -magnitude : magnitude;
  }

  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(field.length);
    const at = (i, j, k) => (k * ny + j) * nx + i;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const index = at(i, j, k);
          // A 7-point stencil weighted towards the centre: enough to round a
          // one-cell crease, not enough to move a flat surface.
          let sum = field[index] * 2;
          let weight = 2;
          if (i > 0) { sum += field[index - 1]; weight++; }
          if (i + 1 < nx) { sum += field[index + 1]; weight++; }
          if (j > 0) { sum += field[index - nx]; weight++; }
          if (j + 1 < ny) { sum += field[index + nx]; weight++; }
          if (k > 0) { sum += field[index - nx * ny]; weight++; }
          if (k + 1 < nz) { sum += field[index + nx * ny]; weight++; }
          next[index] = sum / weight;
        }
      }
    }
    field = next;
  }
  return field;
}

/* -------------------------------------------------------------------------- */
/* Surface Nets                                                                */
/* -------------------------------------------------------------------------- */

// Corner c sits at (c & 1, (c >> 1) & 1, (c >> 2) & 1).
const CELL_CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
// The twelve edges of a cell, as pairs of corner indices. Ordered so that an
// X edge is `y + 2z`, a Y edge is `4 + x + 2z` and a Z edge is `8 + x + 2y` —
// which is what lets a grid edge be looked up directly in each of the four
// cells that share it.
const CELL_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
// The six faces of a cell as corner cycles, with the edge joining each corner
// to the next. Used to work out which crossings belong to the same sheet.
const CELL_FACES = [
  { corners: [0, 2, 6, 4], edges: [4, 10, 6, 8] }, // x = 0
  { corners: [1, 3, 7, 5], edges: [5, 11, 7, 9] }, // x = 1
  { corners: [0, 1, 5, 4], edges: [0, 9, 2, 8] }, // y = 0
  { corners: [2, 3, 7, 6], edges: [1, 11, 3, 10] }, // y = 1
  { corners: [0, 1, 3, 2], edges: [0, 5, 1, 4] }, // z = 0
  { corners: [4, 5, 7, 6], edges: [2, 7, 3, 6] }, // z = 1
];

/**
 * Extracts the zero isosurface as a quad mesh.
 *
 * Every cell with corners on both sides of the surface contributes exactly one
 * vertex, placed where the crossings on its edges average out; a quad is then
 * emitted around each grid edge that changes sign, joining the four cells that
 * share it. Quads rather than triangles is the whole reason for choosing this
 * over marching cubes.
 */
function surfaceNets(field, grid) {
  const { dims, origin, voxel } = grid;
  const [nx, ny, nz] = dims;
  const at = (i, j, k) => (k * ny + j) * nx + i;
  const valueAt = (index) => field[index];

  // One vertex per *sheet* per cell, not one per cell.
  //
  // Plain Surface Nets emits a single vertex wherever a cell straddles the
  // surface. Where the surface turns sharply enough to enter and leave the same
  // cell twice, that forces two separate pieces of surface through one point,
  // and the edges along the crease come out with four faces on them. Every one
  // of a cube's twelve edges was non-manifold that way.
  //
  // Grouping the cell's edge crossings into connected components first — two
  // crossings belong together when a face of the cell joins them — and emitting
  // a vertex per component is the standard repair, and is what makes the output
  // safe to keep modelling on.
  const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
  const cellIndex = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  // Vertex id per (cell, local edge). -1 where that edge has no crossing.
  const edgeVertex = new Int32Array(cellCount * 12).fill(-1);
  const positions = [];

  const parent = new Int32Array(12);
  const find = (node) => {
    while (parent[node] !== node) node = parent[node] = parent[parent[node]];
    return node;
  };
  const corners = new Float64Array(8);
  const crossings = new Float64Array(12 * 3);
  const hasCrossing = new Uint8Array(12);

  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        let mask = 0;
        for (let corner = 0; corner < 8; corner++) {
          const [dx, dy, dz] = CELL_CORNERS[corner];
          const value = valueAt(at(i + dx, j + dy, k + dz));
          corners[corner] = value;
          if (value < 0) mask |= 1 << corner;
        }
        if (mask === 0 || mask === 255) continue; // wholly in or wholly out

        hasCrossing.fill(0);
        for (let edge = 0; edge < 12; edge++) {
          parent[edge] = edge;
          const [from, to] = CELL_EDGES[edge];
          const a = corners[from];
          const b = corners[to];
          if ((a < 0) === (b < 0)) continue;
          // Where along the edge the field passes through zero.
          const t = a !== b ? a / (a - b) : 0.5;
          const [ax, ay, az] = CELL_CORNERS[from];
          const [bx, by, bz] = CELL_CORNERS[to];
          crossings[edge * 3] = ax + (bx - ax) * t;
          crossings[edge * 3 + 1] = ay + (by - ay) * t;
          crossings[edge * 3 + 2] = az + (bz - az) * t;
          hasCrossing[edge] = 1;
        }

        // Join crossings that meet on a face of the cell.
        for (const face of CELL_FACES) {
          const present = [];
          for (let side = 0; side < 4; side++) {
            if (hasCrossing[face.edges[side]]) present.push(side);
          }
          if (present.length === 2) {
            const a = find(face.edges[present[0]]);
            const b = find(face.edges[present[1]]);
            if (a !== b) parent[a] = b;
          } else if (present.length === 4) {
            // All four corners alternate in sign, so the face could be joined
            // two ways. The average of the corners decides which pair of
            // regions is really connected across the middle — the classic
            // asymptotic decider, and picking arbitrarily here is what leaves
            // a hole or a spurious bridge on a saddle.
            const average = (corners[face.corners[0]] + corners[face.corners[1]]
              + corners[face.corners[2]] + corners[face.corners[3]]) / 4;
            const pairing = (average < 0) === (corners[face.corners[0]] < 0)
              ? [[0, 1], [2, 3]]
              : [[1, 2], [3, 0]];
            for (const [first, second] of pairing) {
              const a = find(face.edges[first]);
              const b = find(face.edges[second]);
              if (a !== b) parent[a] = b;
            }
          }
        }

        // A vertex per component, at the mean of that component's crossings.
        const sums = new Map();
        for (let edge = 0; edge < 12; edge++) {
          if (!hasCrossing[edge]) continue;
          const root = find(edge);
          let entry = sums.get(root);
          if (!entry) sums.set(root, (entry = { x: 0, y: 0, z: 0, count: 0 }));
          entry.x += crossings[edge * 3];
          entry.y += crossings[edge * 3 + 1];
          entry.z += crossings[edge * 3 + 2];
          entry.count++;
        }
        const idOf = new Map();
        for (const [root, entry] of sums) {
          idOf.set(root, positions.length / 3);
          positions.push(
            origin[0] + (i + entry.x / entry.count) * voxel,
            origin[1] + (j + entry.y / entry.count) * voxel,
            origin[2] + (k + entry.z / entry.count) * voxel,
          );
        }
        const base = cellIndex(i, j, k) * 12;
        for (let edge = 0; edge < 12; edge++) {
          if (hasCrossing[edge]) edgeVertex[base + edge] = idOf.get(find(edge));
        }
      }
    }
  }

  // One quad per sign-changing grid edge, spanning the four cells around it.
  //
  // A quad is only emitted when all four of those cells exist *and* produced a
  // vertex. The bounds have to be checked on both sides: a cell index is only
  // valid up to dim-2, and reading past it silently returns nothing, which
  // drops the quad and leaves a hole along that face of the model.
  const quads = [];
  // The vertex a given cell contributes *for this particular grid edge* — which
  // is the whole point of splitting: two sheets in one cell must not be joined
  // to each other by picking the same vertex for both.
  const cellAt = (i, j, k, localEdge) => (
    i >= 0 && j >= 0 && k >= 0 && i < nx - 1 && j < ny - 1 && k < nz - 1
      ? edgeVertex[cellIndex(i, j, k) * 12 + localEdge]
      : -1
  );
  // `flip` is true when the inside is on the near side of the edge, which is
  // when the ring below runs clockwise as seen from outside and has to be
  // reversed so the face points out of the solid.
  const emit = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    quads.push(flip ? [a, b, c, d] : [d, c, b, a]);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const here = valueAt(at(i, j, k)) < 0;
        // +X edge: the four cells around it vary in J and K. Within a cell
        // offset by (dj, dk) the same grid edge is local X edge `-dj + 2*-dk`.
        if (i + 1 < nx && here !== (valueAt(at(i + 1, j, k)) < 0)) {
          emit(
            cellAt(i, j - 1, k - 1, 1 + 2),
            cellAt(i, j, k - 1, 0 + 2),
            cellAt(i, j, k, 0),
            cellAt(i, j - 1, k, 1),
            here,
          );
        }
        // +Y edge: local Y edge `4 + -di + 2*-dk`.
        if (j + 1 < ny && here !== (valueAt(at(i, j + 1, k)) < 0)) {
          emit(
            cellAt(i - 1, j, k - 1, 4 + 1 + 2),
            cellAt(i - 1, j, k, 4 + 1),
            cellAt(i, j, k, 4),
            cellAt(i, j, k - 1, 4 + 2),
            here,
          );
        }
        // +Z edge: local Z edge `8 + -di + 2*-dj`.
        if (k + 1 < nz && here !== (valueAt(at(i, j, k + 1)) < 0)) {
          emit(
            cellAt(i - 1, j - 1, k, 8 + 1 + 2),
            cellAt(i, j - 1, k, 8 + 2),
            cellAt(i, j, k, 8),
            cellAt(i - 1, j, k, 8 + 1),
            here,
          );
        }
      }
    }
  }
  return { positions, quads };
}

/**
 * Laplacian relaxation over the extracted surface.
 *
 * Surface Nets leaves a faint staircase where the surface runs nearly parallel
 * to a grid plane. A couple of passes of averaging removes it without moving
 * anything far enough to matter, which is what Blender's own post-smoothing on
 * a voxel remesh is doing.
 */
function relax(positions, quads, iterations) {
  if (iterations <= 0) return positions;
  const count = positions.length / 3;
  const neighbours = Array.from({ length: count }, () => new Set());
  for (const quad of quads) {
    for (let index = 0; index < quad.length; index++) {
      const next = quad[(index + 1) % quad.length];
      neighbours[quad[index]].add(next);
      neighbours[next].add(quad[index]);
    }
  }
  let current = positions;
  for (let pass = 0; pass < iterations; pass++) {
    const next = current.slice();
    for (let vertex = 0; vertex < count; vertex++) {
      const ring = neighbours[vertex];
      if (ring.size < 2) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const other of ring) {
        x += current[other * 3];
        y += current[other * 3 + 1];
        z += current[other * 3 + 2];
      }
      // Half way to the average: full replacement shrinks the volume visibly.
      next[vertex * 3] = current[vertex * 3] * 0.5 + (x / ring.size) * 0.5;
      next[vertex * 3 + 1] = current[vertex * 3 + 1] * 0.5 + (y / ring.size) * 0.5;
      next[vertex * 3 + 2] = current[vertex * 3 + 2] * 0.5 + (z / ring.size) * 0.5;
    }
    current = next;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The voxel size that reproduces roughly the input's current density, used as
 * the default so the button does something sensible before anything is typed.
 */
export function suggestedVoxelSize(mesh) {
  let total = 0;
  let count = 0;
  for (const edge of mesh.edges) {
    total += Math.hypot(
      edge.v2.co[0] - edge.v1.co[0],
      edge.v2.co[1] - edge.v1.co[1],
      edge.v2.co[2] - edge.v1.co[2],
    );
    count++;
  }
  const average = count ? total / count : 1;
  // Bounded against the model's own size so a single huge quad (a ground plane,
  // say) does not propose a voxel bigger than the thing being remeshed.
  const bounds = meshBounds(mesh);
  if (!bounds) return Math.max(average, 1e-4);
  const span = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return Math.max(Math.min(average, span / 8), span / 400, 1e-4);
}

function meshBounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const vert of mesh.verts) {
    any = true;
    for (let axis = 0; axis < 3; axis++) {
      if (vert.co[axis] < min[axis]) min[axis] = vert.co[axis];
      if (vert.co[axis] > max[axis]) max[axis] = vert.co[axis];
    }
  }
  return any ? { min, max } : null;
}

/**
 * Rebuilds the surface on a regular grid.
 *
 * `voxelSize` is in local units, exactly like Blender's Voxel Size: halve it and
 * you get four times the faces. Returns `{ mesh, ... }` or `{ error }`.
 */
export function voxelRemesh(mesh, options = {}) {
  if (!mesh.faces.size) return { error: "Nothing to remesh" };
  const bounds = meshBounds(mesh);
  if (!bounds) return { error: "Nothing to remesh" };

  const voxel = Math.max(options.voxelSize || suggestedVoxelSize(mesh), 1e-5);
  const smoothIterations = options.smoothIterations ?? VOXEL_REMESH_DEFAULTS.smoothIterations;

  // Three voxels of padding so the surface never touches the grid boundary,
  // where there would be no outside cell to change sign against and the mesh
  // would come out with a hole clipped in it.
  //
  // The extra irrational fraction of a voxel keeps the lattice off round
  // coordinates. Models are full of axis-aligned faces on whole numbers, and a
  // grid point landing exactly on one gives it a distance of exactly zero —
  // neither inside nor outside. Surface Nets then runs two sheets of surface
  // through the same cell and shares one vertex between them, producing edges
  // with four faces on them. A cube came out with a tenth of its edges
  // non-manifold that way; skewed off the lattice, it is clean.
  const pad = voxel * 3;
  const skew = voxel * 0.3183098861837907; // 1/pi: never a round fraction
  const origin = bounds.min.map((value) => value - pad + skew);
  const dims = [0, 1, 2].map((axis) => Math.ceil((bounds.max[axis] - bounds.min[axis] + pad * 2) / voxel) + 1);
  const cells = dims[0] * dims[1] * dims[2];
  if (!Number.isFinite(cells) || cells > MAX_CELLS) {
    const affordable = Math.cbrt(cells / MAX_CELLS) * voxel;
    return {
      error: `That voxel size needs ${(cells / 1e6).toFixed(0)}M cells. Try ${affordable.toPrecision(2)} or larger.`,
    };
  }

  const grid = { dims, origin, voxel };
  const triangles = trianglesOf(mesh);
  const distances = buildDistanceField(triangles, grid);
  const inside = buildInsideMask(triangles, grid);
  const field = buildSignedField(distances, inside, grid, options.fieldSmoothing ?? 1);
  const extracted = surfaceNets(field, grid);
  if (!extracted.quads.length) {
    return { error: "Nothing came out of the remesh — try a smaller voxel size" };
  }

  const positions = relax(extracted.positions, extracted.quads, smoothIterations);

  const rebuilt = createMesh();
  const verts = [];
  for (let at = 0; at < positions.length; at += 3) {
    verts.push(addVert(rebuilt, [positions[at], positions[at + 1], positions[at + 2]]));
  }
  let faces = 0;
  for (const quad of extracted.quads) {
    // Surface Nets can fold a quad onto three distinct corners where the
    // surface pinches; `addFace` rejects a repeated vertex, so those become
    // triangles rather than being lost.
    const ring = quad.map((index) => verts[index]);
    const unique = ring.filter((vert, index) => ring.indexOf(vert) === index);
    if (unique.length < 3) continue;
    if (addFace(rebuilt, unique)) faces++;
  }
  if (!faces) return { error: "Nothing came out of the remesh — try a smaller voxel size" };

  // Verts the extraction never used would otherwise linger as loose points.
  for (const vert of [...rebuilt.verts]) if (!vert.edges.size) rebuilt.verts.delete(vert);

  return {
    mesh: rebuilt,
    voxelSize: voxel,
    faces: rebuilt.faces.size,
    verts: rebuilt.verts.size,
    grid: dims,
    uvsLost: true,
  };
}
