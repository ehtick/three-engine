/**
 * Normals, retopology helpers and the shape operators: triangulate, tris to
 * quads, poke, smooth, symmetrize, bridge, grid fill and spin, plus the
 * per-element marks (smooth/flat shading, seams, sharp edges, creases).
 */

import {
  addFace,
  addVert,
  edgeFaceAngle,
  edgeOther,
  faceCenter,
  faceNormal,
  faceVerts,
  findEdge,
  flipFace,
  isBoundaryEdge,
  killFace,
  splitFace,
  vertFaces,
  weldVerts,
} from "../bmesh.js";
import { clearSelection, flushSelection, selected, selectedVerts } from "../select.js";
import { faceRegions } from "./edit.js";
import { faceTriangles } from "../tessellate.js";
import { updateSideUVs } from "./extrude.js";
import { planarRingUVs } from "./uv.js";

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const normalize3 = (v) => {
  const size = length3(v);
  return size < 1e-12 ? [0, 0, 0] : [v[0] / size, v[1] / size, v[2] / size];
};

/* -------------------------------------------------------------------------- */
/* Normals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Recalculate Normals (Shift+N).
 *
 * Winding is made consistent by flooding across shared edges: two correctly
 * wound neighbours traverse their shared edge in opposite directions, so any
 * neighbour that agrees with its parent is inside out. Each connected shell is
 * then flipped as a whole if it faces the wrong way, decided by the signed
 * volume — positive means outward — so `inside` simply inverts the test.
 */
export function recalculateNormals(mesh, { inside = false, faces = null } = {}) {
  const scope = faces?.length ? new Set(faces) : new Set(mesh.faces);
  const visited = new Set();
  let flipped = 0;
  for (const seed of scope) {
    if (visited.has(seed)) continue;
    const shell = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length) {
      let face = queue.pop();
      shell.push(face);
      for (const loop of [...face.loops]) {
        for (const other of [...loop.e.loops]) {
          if (other.f === face || visited.has(other.f) || !scope.has(other.f)) continue;
          visited.add(other.f);
          // Same direction along the shared edge means opposite winding.
          const neighbour = other.v === loop.v ? flipFace(mesh, other.f) : other.f;
          if (other.v === loop.v) flipped++;
          queue.push(neighbour ?? other.f);
          // `face` was not rebuilt, but its loop objects are still valid.
          void face;
        }
      }
    }
    let volume = 0;
    for (const face of shell) {
      if (!mesh.faces.has(face)) continue;
      const ring = faceVerts(face);
      for (let index = 1; index + 1 < ring.length; index++) {
        const [a, b, c] = [ring[0].co, ring[index].co, ring[index + 1].co];
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
    }
    const wantsFlip = inside ? volume > 0 : volume < 0;
    if (wantsFlip) {
      for (const face of shell) {
        if (mesh.faces.has(face)) {
          flipFace(mesh, face);
          flipped++;
        }
      }
    }
  }
  return flipped;
}

/** Flip Normals: reverses the winding of the selected faces. */
export function flipNormals(mesh, faces = selected(mesh, "face")) {
  let count = 0;
  for (const face of [...faces]) {
    if (!mesh.faces.has(face)) continue;
    flipFace(mesh, face);
    count++;
  }
  flushSelection(mesh, "face");
  return count;
}

/** Shade Smooth / Shade Flat. */
export function setShading(mesh, smooth, faces = selected(mesh, "face")) {
  const scope = faces.length ? faces : [...mesh.faces];
  for (const face of scope) face.smooth = smooth;
  return scope.length;
}

/* -------------------------------------------------------------------------- */
/* Edge marks                                                                  */
/* -------------------------------------------------------------------------- */

/** Mark/Clear Seam, Sharp, and Crease, from the Ctrl+E menu. */
export function markEdges(mesh, property, value, edges = selected(mesh, "edge")) {
  let count = 0;
  for (const edge of edges) {
    if (!mesh.edges.has(edge)) continue;
    edge[property] = value;
    count++;
  }
  return count;
}

/** Marks edges sharp wherever the dihedral exceeds `angle` (Edge Split's rule). */
export function markSharpByAngle(mesh, angle = Math.PI / 6) {
  let count = 0;
  for (const edge of mesh.edges) {
    const sharp = edge.loops.length === 2 && edgeFaceAngle(edge) >= angle;
    if (sharp !== edge.sharp) count++;
    edge.sharp = sharp;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Retopology                                                                  */
/* -------------------------------------------------------------------------- */

/** Triangulate Faces (Ctrl+T). */
export function triangulateFaces(mesh, faces = selected(mesh, "face")) {
  const scope = (faces.length ? faces : [...mesh.faces]).filter((face) => face.loops.length > 3);
  const created = [];
  for (const face of scope) {
    const ring = faceVerts(face);
    const uvs = face.loops.map((loop) => [...loop.uv]);
    const { material, smooth, select } = face;
    const triangles = faceTriangles(face);
    killFace(mesh, face);
    for (const [a, b, c] of triangles) {
      const built = addFace(mesh, [ring[a], ring[b], ring[c]], {
        material,
        smooth,
        uvs: [uvs[a], uvs[b], uvs[c]],
      });
      if (built) {
        built.select = select;
        created.push(built);
      }
    }
  }
  flushSelection(mesh, "face");
  return created.length;
}

/**
 * Tris to Quads (Alt+J): pairs adjacent triangles into quads, best pairs first.
 *
 * Candidates are scored on how close to coplanar and how close to rectangular
 * the merged quad would be, so a dense triangulation resolves into the quad
 * layout a modeller would have drawn rather than an arbitrary greedy one.
 */
export function trisToQuads(mesh, { faces = selected(mesh, "face"), angleLimit = (40 * Math.PI) / 180 } = {}) {
  const scope = new Set((faces.length ? faces : [...mesh.faces]).filter((face) => face.loops.length === 3));
  const candidates = [];
  for (const edge of mesh.edges) {
    if (edge.loops.length !== 2) continue;
    const [first, second] = edge.loops.map((loop) => loop.f);
    if (!scope.has(first) || !scope.has(second)) continue;
    const angle = edgeFaceAngle(edge);
    if (angle > angleLimit) continue;
    // Prefer merges whose new quad has corners nearest to square.
    const ring = mergedRing(edge);
    if (!ring) continue;
    let worst = 0;
    for (let index = 0; index < ring.length; index++) {
      const previous = ring[(index + ring.length - 1) % ring.length].co;
      const current = ring[index].co;
      const next = ring[(index + 1) % ring.length].co;
      const cosine = dot3(normalize3(sub3(previous, current)), normalize3(sub3(next, current)));
      worst = Math.max(worst, Math.abs(cosine));
    }
    candidates.push({ a: edge.v1, b: edge.v2, score: angle + worst });
  }
  candidates.sort((first, second) => first.score - second.score);
  let merged = 0;
  const consumed = new Set();
  for (const candidate of candidates) {
    if (!mesh.verts.has(candidate.a) || !mesh.verts.has(candidate.b)) continue;
    const edge = findEdge(candidate.a, candidate.b);
    if (!edge || edge.loops.length !== 2) continue;
    const [first, second] = edge.loops.map((loop) => loop.f);
    if (consumed.has(first) || consumed.has(second)) continue;
    const ring = mergedRing(edge);
    if (!ring) continue;
    const { material, smooth } = first;
    const select = first.select || second.select;
    // The source triangles' own corner UVs; captured before they are killed.
    const uvs = ring.uvs;
    consumed.add(first);
    consumed.add(second);
    killFace(mesh, first);
    killFace(mesh, second);
    const quad = addFace(mesh, ring, { material, smooth, uvs });
    if (quad) {
      quad.select = select;
      merged++;
    }
  }
  flushSelection(mesh, "face");
  return merged;
}

/**
 * The four-corner ring produced by removing a shared edge between triangles,
 * together with the UVs the two source triangles carried at those corners.
 *
 * Reading the UVs here rather than inheriting them afterwards matters: these
 * corners belong to the very triangles about to be killed, so their own values
 * are the exact answer, whereas a neighbouring face may be in a different UV
 * island entirely.
 */
function mergedRing(edge) {
  if (edge.loops.length !== 2) return null;
  const [loopA, loopB] = edge.loops;
  if (loopA.f.loops.length !== 3 || loopB.f.loops.length !== 3) return null;
  const ring = [];
  const uvs = [];
  for (let step = 0; step < 3; step++) {
    const loop = loopA.f.loops[(loopA.index + 1 + step) % 3];
    ring.push(loop.v);
    uvs.push([...loop.uv]);
  }
  const closing = loopB.f.loops[(loopB.index + 2) % 3];
  ring.push(closing.v);
  uvs.push([...closing.uv]);
  if (new Set(ring).size !== 4) return null;
  ring.uvs = uvs;
  return ring;
}

/** Poke Faces: fans each face out from a new centre vertex. */
export function pokeFaces(mesh, faces = selected(mesh, "face"), { offset = 0 } = {}) {
  const scope = faces.length ? faces : [...mesh.faces];
  const created = [];
  for (const face of scope) {
    if (!mesh.faces.has(face)) continue;
    const ring = faceVerts(face);
    const uvs = face.loops.map((loop) => [...loop.uv]);
    const { material, smooth, select } = face;
    const normal = faceNormal(face);
    const center = addVert(mesh, add3(faceCenter(face), scale3(normal, offset)));
    const centerUV = uvs.reduce((sum, uv) => [sum[0] + uv[0] / uvs.length, sum[1] + uv[1] / uvs.length], [0, 0]);
    killFace(mesh, face);
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const built = addFace(mesh, [ring[index], ring[next], center], {
        material,
        smooth,
        uvs: [uvs[index], uvs[next], centerUV],
      });
      if (built) {
        built.select = select;
        created.push(built);
      }
    }
  }
  flushSelection(mesh, "face");
  return created.length;
}

/* -------------------------------------------------------------------------- */
/* Smooth and symmetry                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Smooth Vertices: Laplacian relaxation towards the average of each vertex's
 * neighbours. All new positions are computed against the *original* geometry so
 * the result does not depend on iteration order.
 */
export function smoothVerts(mesh, verts = selectedVerts(mesh, "vert"), { factor = 0.5, repeat = 1, axis = { x: true, y: true, z: true } } = {}) {
  const scope = verts.length ? verts : [...mesh.verts];
  for (let pass = 0; pass < Math.max(1, Math.round(repeat)); pass++) {
    const targets = new Map();
    for (const vert of scope) {
      if (!vert.edges.size) continue;
      let sum = [0, 0, 0];
      for (const edge of vert.edges) sum = add3(sum, edgeOther(edge, vert).co);
      targets.set(vert, scale3(sum, 1 / vert.edges.size));
    }
    for (const [vert, target] of targets) {
      const blended = [
        axis.x ? vert.co[0] + (target[0] - vert.co[0]) * factor : vert.co[0],
        axis.y ? vert.co[1] + (target[1] - vert.co[1]) * factor : vert.co[1],
        axis.z ? vert.co[2] + (target[2] - vert.co[2]) * factor : vert.co[2],
      ];
      vert.co = blended;
    }
  }
  return scope.length;
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Symmetrize: mirrors one half of the mesh onto the other and welds the seam.
 *
 * `direction` names the half that is kept, e.g. "+x" copies +X onto -X.
 */
export function symmetrize(mesh, direction = "+x", { threshold = 1e-4 } = {}) {
  const axis = AXIS_INDEX[direction[1]] ?? 0;
  const keepPositive = direction[0] !== "-";
  const onKeptSide = (co) => (keepPositive ? co[axis] >= -threshold : co[axis] <= threshold);

  for (const face of [...mesh.faces]) {
    if (!faceVerts(face).every((vert) => onKeptSide(vert.co))) killFace(mesh, face);
  }
  for (const edge of [...mesh.edges]) if (!edge.loops.length) {
    if (!onKeptSide(edge.v1.co) || !onKeptSide(edge.v2.co)) {
      edge.v1.edges.delete(edge);
      edge.v2.edges.delete(edge);
      mesh.edges.delete(edge);
    }
  }
  for (const vert of [...mesh.verts]) if (!onKeptSide(vert.co) && !vert.edges.size) mesh.verts.delete(vert);

  const mirrorOf = new Map();
  const mirrorVert = (vert) => {
    if (Math.abs(vert.co[axis]) <= threshold) return vert; // on the seam
    if (!mirrorOf.has(vert)) {
      const co = [...vert.co];
      co[axis] = -co[axis];
      mirrorOf.set(vert, addVert(mesh, co));
    }
    return mirrorOf.get(vert);
  };
  for (const face of [...mesh.faces]) {
    // Mirroring reverses handedness, so the copy is wound backwards to keep
    // its normal pointing out of the surface rather than into it.
    const ring = faceVerts(face).map(mirrorVert).reverse();
    const uvs = face.loops.map((loop) => [...loop.uv]).reverse();
    if (new Set(ring).size !== ring.length) continue;
    addFace(mesh, ring, { material: face.material, smooth: face.smooth, uvs });
  }
  return mirrorOf.size;
}

/* -------------------------------------------------------------------------- */
/* Bridge and grid fill                                                        */
/* -------------------------------------------------------------------------- */

/** Orders a set of edges into closed loops or open chains. */
function edgeChains(edges) {
  const adjacency = new Map();
  const connect = (vert, edge) => {
    if (!adjacency.has(vert)) adjacency.set(vert, []);
    adjacency.get(vert).push(edge);
  };
  for (const edge of edges) {
    connect(edge.v1, edge);
    connect(edge.v2, edge);
  }
  if ([...adjacency.values()].some((list) => list.length > 2)) return { error: "Selected edges branch; a bridge needs simple loops" };
  const remaining = new Set(edges);
  const chains = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const verts = [seed.v1, seed.v2];
    // Walk both ways until the chain closes or runs out.
    for (const end of [1, 0]) {
      for (let step = 0; step < edges.length + 1; step++) {
        const tip = end ? verts[verts.length - 1] : verts[0];
        const next = (adjacency.get(tip) ?? []).find((edge) => remaining.has(edge));
        if (!next) break;
        remaining.delete(next);
        const far = edgeOther(next, tip);
        if (end) verts.push(far);
        else verts.unshift(far);
      }
    }
    const closed = verts.length > 2 && verts[0] === verts[verts.length - 1];
    if (closed) verts.pop();
    chains.push({ verts, closed });
  }
  return { chains };
}

/** Bridge Edge Loops: joins two equally sized boundaries with quads. */
export function bridgeEdgeLoops(mesh, edges = selected(mesh, "edge")) {
  const result = edgeChains(edges);
  if (result.error) return result;
  const chains = result.chains;
  if (chains.length !== 2) return { error: "Bridge needs exactly two edge loops" };
  const [first, second] = chains;
  if (first.closed !== second.closed) return { error: "Both boundaries must be open or both closed" };
  if (first.verts.length !== second.verts.length) return { error: "Both boundaries must have the same vertex count" };
  const count = first.verts.length;
  if (count < 2) return { error: "Those boundaries are too small to bridge" };

  // Choose the rotation and direction that minimises total edge length, so the
  // bridge does not twist through the middle of the shape.
  const distance = (a, b) => length3(sub3(a.co, b.co));
  let best = null;
  for (const candidate of [second.verts, [...second.verts].reverse()]) {
    const shifts = first.closed ? count : 1;
    for (let shift = 0; shift < shifts; shift++) {
      const aligned = candidate.map((_, index) => candidate[(index + shift) % count]);
      const score = aligned.reduce((sum, vert, index) => sum + distance(first.verts[index], vert), 0);
      if (!best || score < best.score) best = { score, verts: aligned };
    }
  }
  const created = [];
  const segments = first.closed ? count : count - 1;
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % count;
    const quad = addFace(mesh, [first.verts[index], first.verts[next], best.verts[next], best.verts[index]]);
    if (quad) created.push(quad);
  }
  if (!created.length) return { error: "Could not bridge those boundaries" };
  // Bridge quads span between two islands, so there is no neighbouring UV to
  // inherit; they get the same measured strip layout as an extrude wall.
  updateSideUVs(created);
  // Match the surrounding surface so the tube is not inside out.
  for (const face of created) {
    const reference = face.loops.find((loop) => loop.e.loops.length === 2);
    if (!reference) continue;
    const neighbour = reference.e.loops.find((loop) => loop.f !== face);
    if (neighbour && neighbour.v === reference.v) flipFace(mesh, face);
  }
  clearSelection(mesh);
  for (const face of created) if (mesh.faces.has(face)) face.select = true;
  flushSelection(mesh, "face");
  return { faces: created.length };
}

/** Grid Fill: fills a closed boundary of even length with a quad grid. */
export function gridFill(mesh, edges = selected(mesh, "edge"), { span = null } = {}) {
  const result = edgeChains(edges);
  if (result.error) return result;
  if (result.chains.length !== 1 || !result.chains[0].closed) return { error: "Grid Fill needs one closed boundary" };
  const ring = result.chains[0].verts;
  if (ring.length < 4 || ring.length % 2) return { error: "Grid Fill needs an even boundary of at least four vertices" };

  const half = ring.length / 2;
  const columns = span ? Math.max(1, Math.min(span, half - 1)) : Math.floor(half / 2);
  const rows = half - columns;
  if (columns < 1 || rows < 1) return { error: "That boundary cannot be split into a grid" };

  // Corners at 0, columns, half, half + columns split the ring into four sides.
  const sideAt = (start, length) => Array.from({ length: length + 1 }, (_, index) => ring[(start + index) % ring.length]);
  const top = sideAt(0, columns);
  const right = sideAt(columns, rows);
  const bottom = sideAt(columns + rows, columns).reverse();
  const left = sideAt(columns + rows + columns, rows).reverse();

  const grid = Array.from({ length: rows + 1 }, () => new Array(columns + 1));
  for (let column = 0; column <= columns; column++) {
    grid[0][column] = top[column];
    grid[rows][column] = bottom[column];
  }
  for (let row = 0; row <= rows; row++) {
    grid[row][0] = left[row];
    grid[row][columns] = right[row];
  }
  if (grid[0][0] !== left[0] || grid[rows][columns] !== right[rows]) return { error: "Could not match the boundary corners" };

  const corner00 = grid[0][0].co;
  const corner10 = grid[0][columns].co;
  const corner01 = grid[rows][0].co;
  const corner11 = grid[rows][columns].co;

  // One planar mapping across the whole patch, so neighbouring cells line up
  // with each other. The boundary ring drives it; interior points get the
  // matching bilinear coordinates below.
  const boundaryUV = planarRingUVs(ring);
  const uvOfBoundary = new Map(ring.map((vert, index) => [vert, boundaryUV[index]]));
  const gridUV = Array.from({ length: rows + 1 }, () => new Array(columns + 1));
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const vert = grid[row][column];
      if (vert && uvOfBoundary.has(vert)) gridUV[row][column] = uvOfBoundary.get(vert);
    }
  }
  const uv00 = gridUV[0][0];
  const uv10 = gridUV[0][columns];
  const uv01 = gridUV[rows][0];
  const uv11 = gridUV[rows][columns];

  for (let row = 1; row < rows; row++) {
    const v = row / rows;
    for (let column = 1; column < columns; column++) {
      const u = column / columns;
      const edgeBlend = add3(
        add3(scale3(grid[0][column].co, 1 - v), scale3(grid[rows][column].co, v)),
        add3(scale3(grid[row][0].co, 1 - u), scale3(grid[row][columns].co, u)),
      );
      const bilinear = add3(
        add3(scale3(corner00, (1 - u) * (1 - v)), scale3(corner10, u * (1 - v))),
        add3(scale3(corner01, (1 - u) * v), scale3(corner11, u * v)),
      );
      grid[row][column] = addVert(mesh, sub3(edgeBlend, bilinear));
      const edgeUV = [
        gridUV[0][column][0] * (1 - v) + gridUV[rows][column][0] * v + gridUV[row][0][0] * (1 - u) + gridUV[row][columns][0] * u,
        gridUV[0][column][1] * (1 - v) + gridUV[rows][column][1] * v + gridUV[row][0][1] * (1 - u) + gridUV[row][columns][1] * u,
      ];
      const bilinearUV = [
        uv00[0] * (1 - u) * (1 - v) + uv10[0] * u * (1 - v) + uv01[0] * (1 - u) * v + uv11[0] * u * v,
        uv00[1] * (1 - u) * (1 - v) + uv10[1] * u * (1 - v) + uv01[1] * (1 - u) * v + uv11[1] * u * v,
      ];
      gridUV[row][column] = [edgeUV[0] - bilinearUV[0], edgeUV[1] - bilinearUV[1]];
    }
  }
  const created = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const cell = addFace(mesh, [grid[row][column], grid[row][column + 1], grid[row + 1][column + 1], grid[row + 1][column]], {
        uvs: [gridUV[row][column], gridUV[row][column + 1], gridUV[row + 1][column + 1], gridUV[row + 1][column]],
      });
      if (cell) created.push(cell);
    }
  }
  if (!created.length) return { error: "Could not fill that boundary" };
  for (const face of created) {
    const reference = face.loops.find((loop) => loop.e.loops.length === 2);
    const neighbour = reference?.e.loops.find((loop) => loop.f !== face);
    if (neighbour && neighbour.v === reference.v) flipFace(mesh, face);
  }
  clearSelection(mesh);
  for (const face of created) if (mesh.faces.has(face)) face.select = true;
  flushSelection(mesh, "face");
  return { faces: created.length };
}

/**
 * Fill Holes: caps every boundary loop up to `maxSides` with a single n-gon.
 * Handy immediately after a delete, and after an import with missing faces.
 */
export function fillHoles(mesh, { maxSides = 64 } = {}) {
  const boundary = [...mesh.edges].filter(isBoundaryEdge);
  const result = edgeChains(boundary);
  if (result.error) return { filled: 0 };
  let filled = 0;
  for (const chain of result.chains) {
    if (!chain.closed || chain.verts.length < 3 || chain.verts.length > maxSides) continue;
    const face = addFace(mesh, chain.verts, { uvs: planarRingUVs(chain.verts) });
    if (!face) continue;
    const reference = face.loops.find((loop) => loop.e.loops.length === 2);
    const neighbour = reference?.e.loops.find((loop) => loop.f !== face);
    if (neighbour && neighbour.v === reference.v) flipFace(mesh, face);
    filled++;
  }
  return { filled };
}

/* -------------------------------------------------------------------------- */
/* Spin                                                                        */
/* -------------------------------------------------------------------------- */

function rotateAbout(co, center, axis, angle) {
  const unit = normalize3(axis);
  const relative = sub3(co, center);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const crossed = [
    unit[1] * relative[2] - unit[2] * relative[1],
    unit[2] * relative[0] - unit[0] * relative[2],
    unit[0] * relative[1] - unit[1] * relative[0],
  ];
  const projected = scale3(unit, dot3(unit, relative) * (1 - cosine));
  return add3(center, add3(add3(scale3(relative, cosine), scale3(crossed, sine)), projected));
}

/**
 * Spin: sweeps the selected edges around an axis, building a surface of
 * revolution. With `angle` a full turn and `steps` segments, this is Blender's
 * Screw for a profile drawn as an edge chain.
 */
export function spinEdges(mesh, edges = selected(mesh, "edge"), { steps = 12, angle = Math.PI * 2, axis = [0, 1, 0], center = [0, 0, 0] } = {}) {
  const chainResult = edgeChains(edges);
  if (chainResult.error) return chainResult;
  const profile = chainResult.chains.flatMap((chain) => chain.verts);
  if (profile.length < 2) return { error: "Select an edge chain to spin" };
  const segments = Math.max(1, Math.min(Math.round(steps), 256));
  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-6;

  const pairs = [];
  for (const chain of chainResult.chains) {
    for (let index = 0; index + 1 < chain.verts.length; index++) pairs.push([chain.verts[index], chain.verts[index + 1]]);
    if (chain.closed) pairs.push([chain.verts[chain.verts.length - 1], chain.verts[0]]);
  }
  let previous = new Map(profile.map((vert) => [vert, vert]));
  const created = [];
  for (let step = 1; step <= segments; step++) {
    const isLast = step === segments;
    const current = new Map();
    for (const vert of profile) {
      current.set(vert, full && isLast ? vert : addVert(mesh, rotateAbout(vert.co, center, axis, (angle * step) / segments)));
    }
    for (const [a, b] of pairs) {
      const quad = addFace(mesh, [previous.get(a), previous.get(b), current.get(b), current.get(a)]);
      if (quad) created.push(quad);
    }
    previous = current;
  }
  // A swept surface has no prior UVs to inherit either.
  updateSideUVs(created);
  clearSelection(mesh);
  for (const face of created) if (mesh.faces.has(face)) face.select = true;
  flushSelection(mesh, "face");
  return { faces: created.length };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/** Statistics for the header and for the Mesh > Clean Up feedback. */
export function meshStatistics(mesh) {
  let triangles = 0;
  let quads = 0;
  let ngons = 0;
  let boundary = 0;
  let nonManifold = 0;
  for (const face of mesh.faces) {
    if (face.loops.length === 3) triangles++;
    else if (face.loops.length === 4) quads++;
    else ngons++;
  }
  for (const edge of mesh.edges) {
    if (edge.loops.length === 1) boundary++;
    else if (edge.loops.length > 2) nonManifold++;
  }
  return {
    verts: mesh.verts.size,
    edges: mesh.edges.size,
    faces: mesh.faces.size,
    triangles,
    quads,
    ngons,
    boundary,
    nonManifold,
  };
}

export { faceRegions, vertFaces, weldVerts, splitFace };
