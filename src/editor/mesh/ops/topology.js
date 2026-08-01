/**
 * Operators that add topology: subdivide, loop cut, bevel and knife.
 *
 * All of them lean on one property of the kernel that the old triangle model
 * could not offer: `splitEdge` splits *every* face using that edge. Conforming
 * subdivision — the rule that a neighbour of a subdivided face gains the new
 * vertex rather than being left with a T-junction — therefore comes for free
 * instead of needing the special-case passes the previous implementation had.
 */

import {
  addFace,
  addVert,
  edgeFaces,
  edgeOther,
  faceCenter,
  faceLoopOnEdge,
  faceNormal,
  faceVerts,
  findEdge,
  killEdge,
  killFace,
  splitEdge,
  splitFace,
  vertFaces,
} from "../bmesh.js";
import { clearSelection, edgeRing, flushSelection, selected } from "../select.js";
import { setSideBaseUV, updateSideUVs } from "./extrude.js";
import { affineUVSampler, planarRingUVs, ringUVsFromNeighbour } from "./uv.js";

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale2 = (v, s) => [v[0] * s, v[1] * s];
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Per-corner UVs of a face, keyed by vertex. Each vert appears once in a ring. */
const faceUVMap = (face) => new Map(face.loops.map((loop) => [loop.v, [...loop.uv]]));
const uvAt = (map, vert) => map.get(vert) ?? [0, 0];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
function normalize3(v) {
  const size = length3(v);
  return size < 1e-12 ? [0, 0, 0] : [v[0] / size, v[1] / size, v[2] / size];
}

let tagCounter = 0;
/** Tags faces so they can be found again after `splitEdge` rebuilds them. */
function tagFaces(faces) {
  const tags = new Map();
  for (const face of faces) {
    face.tag = ++tagCounter;
    tags.set(face.tag, { corners: faceVerts(face), material: face.material, smooth: face.smooth, select: face.select });
  }
  return tags;
}

function facesByTag(mesh, tags) {
  const found = new Map();
  for (const face of mesh.faces) if (tags.has(face.tag)) found.set(face.tag, face);
  return found;
}

const clearTags = (mesh) => {
  for (const face of mesh.faces) face.tag = 0;
};

/**
 * Inserts `count` evenly spaced vertices along `edge`, returning them ordered
 * from `edge.v1` to `edge.v2`.
 *
 * Each split shortens the remaining segment, so the parameter is recomputed
 * against what is left rather than against the original edge.
 */
function splitEdgeEvenly(mesh, edge, count) {
  const created = [];
  let from = edge.v1;
  const to = edge.v2;
  let current = edge;
  for (let index = 0; index < count; index++) {
    const remaining = count - index + 1;
    const middle = splitEdge(mesh, current, 1 / remaining);
    created.push(middle);
    const next = findEdge(middle, to) ?? [...middle.edges].find((candidate) => edgeOther(candidate, middle) !== from);
    from = middle;
    current = next;
    if (!current) break;
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* Subdivide                                                                   */
/* -------------------------------------------------------------------------- */

/** Ordered ring positions of `corners` within `face`, or null if any is absent. */
function cornerPositions(face, corners) {
  const positions = corners.map((vert) => face.loops.findIndex((loop) => loop.v === vert));
  return positions.some((position) => position < 0) ? null : positions;
}

/** The verts of `face` from ring position `from` to `to`, inclusive. */
function sideBetween(face, from, to) {
  const side = [];
  const count = face.loops.length;
  for (let at = from; ; at = (at + 1) % count) {
    side.push(face.loops[at].v);
    if (at === to) break;
  }
  return side;
}

/**
 * Replaces a subdivided quad with an (n+1) x (n+1) grid.
 *
 * Interior points come from a Coons patch over the four already-subdivided
 * sides, so a subdivided curved quad follows the curve of its own boundary
 * instead of collapsing onto the flat bilinear surface between its corners.
 */
function rebuildQuadGrid(mesh, face, corners, cuts) {
  const positions = cornerPositions(face, corners);
  if (!positions) return false;
  // Captured before the face is killed. Without this the grid was rebuilt with
  // no UVs at all, so subdividing silently flattened the whole texture layout.
  const sourceUV = faceUVMap(face);
  const sides = [
    sideBetween(face, positions[0], positions[1]),
    sideBetween(face, positions[1], positions[2]),
    sideBetween(face, positions[2], positions[3]),
    sideBetween(face, positions[3], positions[0]),
  ];
  const span = cuts + 1;
  if (sides.some((side) => side.length !== span + 1)) return false;

  const top = sides[0];
  const right = sides[1];
  const bottom = [...sides[2]].reverse();
  const left = [...sides[3]].reverse();
  const grid = Array.from({ length: span + 1 }, () => new Array(span + 1));
  for (let column = 0; column <= span; column++) {
    grid[0][column] = top[column];
    grid[span][column] = bottom[column];
  }
  for (let row = 0; row <= span; row++) {
    grid[row][0] = left[row];
    grid[row][span] = right[row];
  }
  const corner00 = grid[0][0].co;
  const corner10 = grid[0][span].co;
  const corner01 = grid[span][0].co;
  const corner11 = grid[span][span].co;
  // UVs get the same Coons treatment as positions, so a subdivided quad keeps
  // its texture layout even where the boundary UVs are unevenly spaced.
  const gridUV = Array.from({ length: span + 1 }, () => new Array(span + 1));
  for (let column = 0; column <= span; column++) {
    gridUV[0][column] = uvAt(sourceUV, top[column]);
    gridUV[span][column] = uvAt(sourceUV, bottom[column]);
  }
  for (let row = 0; row <= span; row++) {
    gridUV[row][0] = uvAt(sourceUV, left[row]);
    gridUV[row][span] = uvAt(sourceUV, right[row]);
  }
  const uv00 = gridUV[0][0];
  const uv10 = gridUV[0][span];
  const uv01 = gridUV[span][0];
  const uv11 = gridUV[span][span];

  for (let row = 1; row < span; row++) {
    const v = row / span;
    for (let column = 1; column < span; column++) {
      const u = column / span;
      const co = add3(
        add3(scale3(grid[0][column].co, 1 - v), scale3(grid[span][column].co, v)),
        add3(scale3(grid[row][0].co, 1 - u), scale3(grid[row][span].co, u)),
      );
      const bilinear = add3(
        add3(scale3(corner00, (1 - u) * (1 - v)), scale3(corner10, u * (1 - v))),
        add3(scale3(corner01, (1 - u) * v), scale3(corner11, u * v)),
      );
      grid[row][column] = addVert(mesh, sub3(co, bilinear));
      const edgeUV = add2(
        add2(scale2(gridUV[0][column], 1 - v), scale2(gridUV[span][column], v)),
        add2(scale2(gridUV[row][0], 1 - u), scale2(gridUV[row][span], u)),
      );
      const bilinearUV = add2(
        add2(scale2(uv00, (1 - u) * (1 - v)), scale2(uv10, u * (1 - v))),
        add2(scale2(uv01, (1 - u) * v), scale2(uv11, u * v)),
      );
      gridUV[row][column] = sub2(edgeUV, bilinearUV);
    }
  }
  const { material, smooth, select } = face;
  killFace(mesh, face);
  for (let row = 0; row < span; row++) {
    for (let column = 0; column < span; column++) {
      const cell = addFace(mesh, [grid[row][column], grid[row][column + 1], grid[row + 1][column + 1], grid[row + 1][column]], {
        material,
        smooth,
        uvs: [gridUV[row][column], gridUV[row][column + 1], gridUV[row + 1][column + 1], gridUV[row + 1][column]],
      });
      if (cell) cell.select = select;
    }
  }
  return true;
}

/** Replaces a subdivided triangle with a barycentric grid of triangles. */
function rebuildTriangleGrid(mesh, face, corners, cuts) {
  const positions = cornerPositions(face, corners);
  if (!positions) return false;
  const sourceUV = faceUVMap(face);
  const sides = [
    sideBetween(face, positions[0], positions[1]),
    sideBetween(face, positions[1], positions[2]),
    sideBetween(face, positions[2], positions[0]),
  ];
  const span = cuts + 1;
  if (sides.some((side) => side.length !== span + 1)) return false;
  // Rows run from corner 0 towards the opposite side; row r has r+1 vertices,
  // starting on side C->A and ending on side A->B. Only the interior of each
  // row is new — the ends are the vertices the edge splits already created.
  //
  // The final row is the third side itself, so it must be taken rather than
  // built; generating it and overwriting would strand a row of orphan verts.
  const rows = [[sides[0][0]]];
  const rowUV = [[uvAt(sourceUV, sides[0][0])]];
  for (let row = 1; row < span; row++) {
    const start = sides[2][span - row];
    const end = sides[0][row];
    const startUV = uvAt(sourceUV, start);
    const endUV = uvAt(sourceUV, end);
    const entries = [start];
    const uvs = [startUV];
    for (let column = 1; column < row; column++) {
      const t = column / row;
      entries.push(addVert(mesh, lerp3(start.co, end.co, t)));
      uvs.push(lerp2(startUV, endUV, t));
    }
    entries.push(end);
    uvs.push(endUV);
    rows.push(entries);
    rowUV.push(uvs);
  }
  const lastRow = [...sides[1]].reverse();
  rows.push(lastRow);
  rowUV.push(lastRow.map((vert) => uvAt(sourceUV, vert)));

  const { material, smooth, select } = face;
  killFace(mesh, face);
  for (let row = 0; row < span; row++) {
    for (let column = 0; column < row + 1; column++) {
      const upward = addFace(mesh, [rows[row][column], rows[row + 1][column], rows[row + 1][column + 1]], {
        material,
        smooth,
        uvs: [rowUV[row][column], rowUV[row + 1][column], rowUV[row + 1][column + 1]],
      });
      if (upward) upward.select = select;
      if (column < row) {
        const downward = addFace(mesh, [rows[row][column], rows[row + 1][column + 1], rows[row][column + 1]], {
          material,
          smooth,
          uvs: [rowUV[row][column], rowUV[row + 1][column + 1], rowUV[row][column + 1]],
        });
        if (downward) downward.select = select;
      }
    }
  }
  return true;
}

/**
 * Replaces a subdivided n-gon with a fan of quads around a new centre vertex,
 * which is what Blender does for anything that is not a triangle or a quad.
 */
function rebuildNgonFan(mesh, face, corners) {
  const positions = cornerPositions(face, corners);
  if (!positions || positions.length < 3) return false;
  const ring = face.loops.map((loop) => loop.v);
  const sourceUV = faceUVMap(face);
  const centerUV = face.loops.reduce(
    (sum, loop) => [sum[0] + loop.uv[0] / face.loops.length, sum[1] + loop.uv[1] / face.loops.length],
    [0, 0],
  );
  const center = addVert(mesh, faceCenter(face));
  const { material, smooth, select } = face;
  // Split each side at its midpoint index so every quad spans corner-to-corner
  // through the two neighbouring side midpoints.
  const sides = positions.map((position, index) => sideBetween(face, position, positions[(index + 1) % positions.length]));
  const midpoints = sides.map((side) => side[Math.floor(side.length / 2)]);
  killFace(mesh, face);
  for (let index = 0; index < positions.length; index++) {
    const side = sides[index];
    const previousSide = sides[(index + positions.length - 1) % positions.length];
    const from = previousSide.indexOf(midpoints[(index + positions.length - 1) % positions.length]);
    const cell = [
      ...previousSide.slice(from),
      ...side.slice(1, side.indexOf(midpoints[index]) + 1),
      center,
    ];
    const unique = cell.filter((vert, at) => cell.indexOf(vert) === at);
    const built = addFace(mesh, unique, {
      material,
      smooth,
      uvs: unique.map((vert) => (vert === center ? centerUV : uvAt(sourceUV, vert))),
    });
    if (built) built.select = select;
  }
  void ring;
  return true;
}

/**
 * Subdivide (W > Subdivide). Splits every edge of the selected faces into
 * `cuts + 1` segments and re-partitions the faces.
 *
 * Neighbours of the selection keep the new vertices on their shared edges and
 * simply become n-gons, matching Blender's default of not triangulating the
 * surrounding area.
 */
export function subdivideFaces(mesh, faces = selected(mesh, "face"), cuts = 1) {
  const target = faces.length ? faces : [...mesh.faces];
  if (!target.length) return { error: "Nothing to subdivide" };
  const passes = Math.max(1, Math.min(Math.round(cuts) || 1, 10));
  const tags = tagFaces(target);
  const edges = new Set();
  for (const face of target) for (const loop of face.loops) edges.add(loop.e);
  for (const edge of [...edges]) splitEdgeEvenly(mesh, edge, passes);

  const rebuilt = facesByTag(mesh, tags);
  let count = 0;
  for (const [tag, face] of rebuilt) {
    const { corners } = tags.get(tag);
    const sides = corners.length;
    const done = sides === 4
      ? rebuildQuadGrid(mesh, face, corners, passes)
      : sides === 3
        ? rebuildTriangleGrid(mesh, face, corners, passes)
        : rebuildNgonFan(mesh, face, corners);
    if (done) count++;
  }
  clearTags(mesh);
  flushSelection(mesh, "face");
  return { faces: count, cuts: passes };
}

/* -------------------------------------------------------------------------- */
/* Loop cut                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Walks the quad ring containing `seed`, recording for every ring edge which of
 * its endpoints the cut parameter is measured from.
 *
 * Keeping the orientation is what makes a loop cut on a cone or any tapered
 * surface stay parallel to the ring, instead of tilting the way a plane cut
 * through the same seed would.
 */
function orientedRing(seed) {
  const oriented = new Map([[seed, seed.v1]]);
  const faces = new Set();
  for (const startFace of edgeFaces(seed)) {
    let edge = seed;
    let from = seed.v1;
    let face = startFace;
    for (let step = 0; step < 100000; step++) {
      if (face.loops.length !== 4) break;
      const loop = faceLoopOnEdge(face, edge);
      if (!loop) break;
      const opposite = face.loops[(loop.index + 2) % 4];
      const next = opposite.e;
      if (oriented.has(next)) {
        faces.add(face);
        break;
      }
      // `loop` runs from loop.v to the next corner. The parallel point on the
      // opposite edge is measured from *its* far end, so the cut stays square
      // to the ring rather than shearing across the quad.
      const measuredFrom = loop.v === from ? opposite.f.loops[(opposite.index + 1) % 4].v : opposite.v;
      oriented.set(next, measuredFrom);
      faces.add(face);
      const onward = edgeFaces(next).find((candidate) => candidate !== face);
      if (!onward) break;
      edge = next;
      from = measuredFrom;
      face = onward;
    }
  }
  return { oriented, faces };
}

/**
 * Loop Cut (Ctrl+R). Inserts `cuts` parallel loops through the ring containing
 * `seed`, offset by `slide` (-1..1) for Blender's edge slide.
 *
 * The new loops run *across* the ring, so sliding moves them along the ring
 * edges — perpendicular to themselves, which is what dragging after Ctrl+R
 * does. Slide is measured from `seed.v1` towards `seed.v2`; which of the two is
 * v1 depends on the order the edge happened to be created in, so the editor
 * resolves the sign by projecting the drag onto that axis rather than assuming
 * a direction.
 *
 * `factors` overrides the placement with explicit 0..1 parameters, which is how
 * `offsetEdgeLoop` puts two loops at chosen positions in a single pass.
 */
export function loopCut(mesh, seed, { cuts = 1, slide = 0, factors: explicit = null } = {}) {
  if (!seed) return { error: "No edge under the cursor" };
  const ring = edgeRing(seed);
  if (ring.size < 2) return { error: "That edge is not part of a quad ring" };
  const { oriented, faces } = orientedRing(seed);
  if (!faces.size) return { error: "Loop cut needs a ring of quads" };

  // Cuts are placed by parameter *along the ring edges*, so sliding moves the
  // new loop perpendicular to itself, which is what Ctrl+R then mouse does.
  const clamp = (value) => Math.max(0.001, Math.min(0.999, value));
  const requested = Math.max(1, Math.min(Math.round(cuts) || 1, 64));
  const factors = explicit
    ? [...explicit].map(clamp).sort((a, b) => a - b)
    : Array.from({ length: requested }, (_, index) => clamp((index + 1) / (requested + 1) + slide * 0.5));
  const count = factors.length;

  const tags = tagFaces([...faces]);
  // Split every ring edge at the same parameters, measured from the endpoint
  // the orientation walk recorded.
  const inserted = new Map();
  for (const [edge, from] of oriented) {
    if (!mesh.edges.has(edge)) continue;
    const forward = edge.v1 === from;
    const verts = [];
    let current = edge;
    let remaining = [...factors];
    if (!forward) remaining = remaining.map((value) => 1 - value).reverse();
    let consumed = 0;
    // `remaining` is always ascending from `edge.v1`, so the splits march
    // towards `edge.v2` regardless of which end the orientation walk measured
    // from. Walking towards v1 here left the later cuts stacked on the first.
    const far = edge.v2;
    for (const factor of remaining) {
      const local = (factor - consumed) / (1 - consumed);
      const middle = splitEdge(mesh, current, Math.max(0.001, Math.min(0.999, local)));
      verts.push(middle);
      current = findEdge(middle, far) ?? [...middle.edges].find((candidate) => candidate !== current);
      consumed = factor;
      if (!current) break;
    }
    inserted.set(edge, forward ? verts : verts.reverse());
  }

  // Each ring face now carries 2*count extra corners. Chord them together.
  const rebuilt = facesByTag(mesh, tags);
  const newEdges = [];
  for (const face of rebuilt.values()) {
    let current = face;
    for (let index = 0; index < count; index++) {
      const ringVerts = current.loops.map((loop) => loop.v);
      const onCut = ringVerts.filter((vert) => [...inserted.values()].some((list) => list[index] === vert));
      if (onCut.length !== 2) break;
      const a = current.loops.findIndex((loop) => loop.v === onCut[0]);
      const b = current.loops.findIndex((loop) => loop.v === onCut[1]);
      const halves = splitFace(mesh, current, a, b);
      if (!halves) break;
      const shared = findEdge(onCut[0], onCut[1]);
      if (shared) newEdges.push(shared);
      // Continue cutting inside whichever half still holds the remaining points.
      current = halves.find((half) => half.loops.some((loop) => [...inserted.values()].some((list) => list[index + 1] === loop.v))) ?? halves[1];
    }
  }
  clearTags(mesh);
  clearSelection(mesh);
  for (const edge of newEdges) edge.select = true;
  flushSelection(mesh, "edge");
  return { edges: newEdges, cuts: count };
}

/* -------------------------------------------------------------------------- */
/* Bevel                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bevel (Ctrl+B).
 *
 * Each face is shrunk away from the selected edges bordering it, and the gap
 * that opens up is filled: a quad along every selected edge, and an n-gon at
 * every vertex where selected edges meet. `segments` rounds the profile by
 * subdividing the bevel quads and pushing them onto the arc.
 */
export function bevelEdges(mesh, edges = selected(mesh, "edge"), { width = 0.1, segments = 1 } = {}) {
  const chosen = new Set(edges.filter((edge) => edge.loops.length === 2));
  if (!chosen.size) return { error: "Select manifold edges to bevel" };
  const amount = Math.max(width, 1e-5);

  const affected = new Set();
  for (const edge of chosen) {
    affected.add(edge.v1);
    affected.add(edge.v2);
  }

  // Everything the rebuild needs is captured up front. Killing a face empties
  // its loops and unlinks it from its edges' radials, so any adjacency read
  // afterwards -- which side of an edge a face was on, which faces surrounded a
  // vertex -- is already gone by the time it is wanted.
  const edgeSides = new Map();
  for (const edge of chosen) {
    const [first, second] = edge.loops;
    edgeSides.set(edge, {
      a: { face: first.f, start: first.v, end: edgeOther(edge, first.v) },
      b: { face: second.f, start: second.v, end: edgeOther(edge, second.v) },
    });
  }
  const vertNormals = new Map();
  for (const vert of affected) {
    vertNormals.set(vert, normalize3(vertFaces(vert).reduce((sum, face) => add3(sum, faceNormal(face)), [0, 0, 0])));
  }

  // For every (face, corner) pair touching a selected edge, where that corner
  // moves to once the face is shrunk away from the bevel.
  const moved = new Map();
  const movedUV = new Map();
  const cornerKey = (face, vert) => `${face.id}:${vert.id}`;
  // New corners are welded per original vertex by where they land.
  //
  // Two faces that both slide their corner along the *same* unbeveled edge end
  // up at the same point, and giving each its own vertex leaves two coincident
  // copies with a zero-width crack between them. Nothing looks wrong in the
  // viewport until you notice the corner never closes: the chains around the
  // vertex no longer share endpoints, so the corner patch cannot be stitched
  // and the bevel ends in a hole. Beveling the four edges of one cube face hit
  // this at every corner.
  const cornersAt = new Map();
  const cornerFor = (vert, position) => {
    let byPosition = cornersAt.get(vert);
    if (!byPosition) cornersAt.set(vert, (byPosition = new Map()));
    const key = `${Math.round(position[0] * 1e5)},${Math.round(position[1] * 1e5)},${Math.round(position[2] * 1e5)}`;
    let existing = byPosition.get(key);
    if (!existing) byPosition.set(key, (existing = addVert(mesh, position)));
    return existing;
  };
  const rebuilds = [];
  for (const face of mesh.faces) {
    if (!face.loops.some((loop) => chosen.has(loop.e))) continue;
    // This face is about to be shrunk away from the chamfer. Its corners must
    // pick up the UV its own mapping gives their NEW positions: keeping the old
    // corner UV would leave the same slice of texture covering a smaller face,
    // so the image visibly slides and stretches wherever a bevel passes.
    const uvAt = affineUVSampler(face);
    const ring = [];
    for (const loop of face.loops) {
      const previous = face.loops[(loop.index + face.loops.length - 1) % face.loops.length];
      const incomingSelected = chosen.has(previous.e);
      const outgoingSelected = chosen.has(loop.e);
      if (!incomingSelected && !outgoingSelected) {
        ring.push({ vert: loop.v, uv: [...loop.uv] });
        continue;
      }
      const next = face.loops[(loop.index + 1) % face.loops.length];
      const toNext = normalize3(sub3(next.v.co, loop.v.co));
      const toPrevious = normalize3(sub3(previous.v.co, loop.v.co));
      let offset;
      if (incomingSelected && outgoingSelected) {
        // Both sides bevel: travel along the bisector far enough that the new
        // corner still sits `amount` away from each of the two edges.
        const bisector = normalize3(add3(toNext, toPrevious));
        const sine = Math.max(Math.sqrt(Math.max(1 - dot3(bisector, toNext) ** 2, 1e-6)), 0.1);
        offset = scale3(bisector, amount / sine);
      } else {
        // One side bevels: slide along the edge that is STAYING PUT, which is
        // the other one. Sliding along the selected edge instead just shortens
        // it — the corner walks up the edge being beveled rather than away from
        // it, so the operation looks like a scale and cuts no chamfer at all.
        offset = scale3(incomingSelected ? toNext : toPrevious, amount);
      }
      const position = add3(loop.v.co, offset);
      const fresh = cornerFor(loop.v, position);
      const uv = uvAt(position) ?? [...loop.uv];
      moved.set(cornerKey(face, loop.v), fresh);
      // Keyed per (face, corner), not per vertex: `cornerFor` welds two faces
      // that slid to the same point into one vertex, and those two faces are
      // usually in different UV islands.
      movedUV.set(cornerKey(face, loop.v), uv);
      ring.push({ vert: fresh, uv: [...uv] });
    }
    rebuilds.push({ face, ring, material: face.material, smooth: face.smooth });
  }
  if (!rebuilds.length) return { error: "Could not bevel that selection" };

  // The strips are built before anything is killed, because the faces that only
  // touch the bevel at a corner need to know the shape of the profile to follow
  // it, and the old faces have to still be linked up for "which face is across
  // this edge" to be answerable.
  const created = [];
  // The chain of vertices each strip leaves along each of its two ends. With
  // one segment that is just the pair of shrunken corners, but a rounded bevel
  // puts the whole arc there, and both the corner cap and the neighbouring
  // faces have to run around *those* or they leave a hole the size of the
  // rounding.
  const cornerChains = new Map();
  const recordChain = (vert, chain) => {
    if (!cornerChains.has(vert)) cornerChains.set(vert, []);
    cornerChains.get(vert).push(chain);
  };
  for (const [, sides] of edgeSides) {
    const aStart = moved.get(cornerKey(sides.a.face, sides.a.start));
    const aEnd = moved.get(cornerKey(sides.a.face, sides.a.end));
    const bStart = moved.get(cornerKey(sides.b.face, sides.b.start));
    const bEnd = moved.get(cornerKey(sides.b.face, sides.b.end));
    if (!aStart || !aEnd || !bStart || !bEnd) continue;
    // Two consistently wound faces cross the shared edge in opposite
    // directions, so the strip runs against face A to stay wound with it:
    // [aEnd, aStart, bEnd, bStart]. `sides.a.start` and `sides.b.end` are the
    // same original vertex, which is what pairs the corners up.
    const strip = buildBevelStrip(mesh, [aStart, bEnd], [aEnd, bStart], sides.a.start, sides.a.end, segments);
    // Continue face A's UVs across the chamfer so the texel density matches the
    // surface it was cut from.
    //
    // A rounded bevel is several strips deep, and each one must start where the
    // previous one ended. Handing every segment the *same* base — face A's edge
    // — mapped them all onto the same band of the texture, so a four-segment
    // bevel drew the same stripe four times instead of a continuous rounding.
    let baseA = movedUV.get(cornerKey(sides.a.face, sides.a.end));
    let baseB = movedUV.get(cornerKey(sides.a.face, sides.a.start));
    for (const face of strip.faces) {
      if (baseA && baseB) setSideBaseUV(face, baseA, baseB);
      updateSideUVs([face]);
      // Corner order is [base0, base1, far1, far0]; the far pair is the next
      // segment's base.
      if (face.loops.length === 4) {
        baseA = [...face.loops[3].uv];
        baseB = [...face.loops[2].uv];
      }
    }
    created.push(...strip.faces);
    recordChain(sides.a.start, strip.startChain);
    recordChain(sides.a.end, strip.endChain);
  }

  // Faces that touch a beveled *vertex* without touching a beveled *edge* have
  // to be re-stitched too. Their neighbours have just pulled back from the
  // shared corner, and a face left sitting on the original vertex no longer
  // meets them — beveling a single edge of a cube left twelve open edges that
  // way, the mesh gaping along the ends of the chamfer.
  //
  // The neighbour's new corner slid along the edge these two faces share, so it
  // already lies on this face's boundary: inserting it in place of the corner
  // turns the face into the n-gon Blender produces, with no shape change beyond
  // the corner being cut off.
  const rebuiltFaces = new Set(rebuilds.map((entry) => entry.face));
  const movedAcross = (edge, face, vert) => {
    const other = edge.loops.find((loop) => loop.f !== face)?.f;
    return other ? moved.get(cornerKey(other, vert)) : undefined;
  };
  /** The profile chain running between two of this vertex's new corners, if any. */
  const chainBetween = (vert, from, to) => {
    for (const chain of cornerChains.get(vert) ?? []) {
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (head === from && tail === to) return chain;
      if (head === to && tail === from) return [...chain].reverse();
    }
    return null;
  };
  for (const face of mesh.faces) {
    if (rebuiltFaces.has(face)) continue;
    if (!face.loops.some((loop) => affected.has(loop.v))) continue;
    // The face's own UV mapping, so the vertices being spliced in get the
    // coordinate this face would have given that position all along.
    const uvAt = affineUVSampler(face);
    const ring = [];
    let changed = false;
    for (const loop of face.loops) {
      if (!affected.has(loop.v)) {
        ring.push({ vert: loop.v, uv: [...loop.uv] });
        continue;
      }
      const previous = face.loops[(loop.index + face.loops.length - 1) % face.loops.length];
      const next = face.loops[(loop.index + 1) % face.loops.length];
      const before = movedAcross(previous.e, face, loop.v);
      const after = movedAcross(loop.e, face, loop.v);
      if (before && after) {
        // Follow the whole profile, not just its ends: with more than one
        // segment the arc bulges between them, and chording across it leaves a
        // sliver of hole per segment along the end of the chamfer.
        const profile = chainBetween(loop.v, before, after);
        // No profile between these two means this face is not alongside a
        // chamfer but *bridging between* two of them — the case where the
        // vertex has an unbeveled edge on either side of it. The straight span
        // it contributes is part of the corner's boundary, so the corner patch
        // has to be told about it or it cannot close the ring.
        if (!profile) recordChain(loop.v, [before, after]);
        for (const vert of profile ?? [before, after]) {
          ring.push({ vert, uv: uvAt(vert.co) ?? [...loop.uv] });
        }
        changed = true;
      } else if (before) {
        ring.push({ vert: before, uv: uvAt(before.co) ?? edgeUV(loop, previous, before) });
        ring.push({ vert: loop.v, uv: [...loop.uv] });
        changed = true;
      } else if (after) {
        ring.push({ vert: loop.v, uv: [...loop.uv] });
        ring.push({ vert: after, uv: uvAt(after.co) ?? edgeUV(loop, next, after) });
        changed = true;
      } else {
        ring.push({ vert: loop.v, uv: [...loop.uv] });
      }
    }
    if (changed && ring.length >= 3) {
      rebuilds.push({ face, ring, material: face.material, smooth: face.smooth });
    }
  }

  // `killFace` deliberately leaves edges behind, so the edges the shrunken
  // faces no longer use — the beveled edges themselves above all — have to be
  // swept explicitly. Left in place they linger as wire edges: invisible in the
  // solid view, but still drawn in the wireframe and still found by `findEdge`.
  const touchedEdges = new Set();
  for (const rebuild of rebuilds) for (const loop of rebuild.face.loops) touchedEdges.add(loop.e);

  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);
  for (const rebuild of rebuilds) {
    addFace(mesh, rebuild.ring.map((entry) => entry.vert), {
      material: rebuild.material,
      smooth: rebuild.smooth,
      uvs: rebuild.ring.map((entry) => entry.uv),
    });
  }
  for (const edge of touchedEdges) {
    if (mesh.edges.has(edge) && !edge.loops.length) killEdge(mesh, edge);
  }

  // Where the bevel detached a vertex completely, cap the hole it left.
  for (const vert of affected) {
    if (vert.edges.size) continue;
    const ring = cornerRing(cornerChains.get(vert) ?? []);
    if (ring && ring.length >= 3) {
      // Wound to face outward: the corner replaces a convex vertex, so the cap
      // must turn the same way the vertex used to face. A cap wound the other
      // way is invisible from outside and reads as a hole straight through the
      // model — which, with the rounding arcs left uncapped, is exactly what a
      // multi-segment bevel used to look like.
      const oriented = ringFacesAlong(ring, vertNormals.get(vert)) ? ring : [...ring].reverse();
      // A chamfer's corner really is flat, so one n-gon is right for it. A
      // rounded bevel's is not: capping the arcs with a single flat polygon
      // leaves a visible facet cutting the corner off exactly where the whole
      // point was to round it. Past one segment the corner is domed onto the
      // same sphere the arcs follow. Three-edge corners use a triangular grid
      // so the segment loops continue through the intersection without a
      // high-valence fan pole; unusual valences retain the generic fallback.
      // The patch continues the mapping of the strips around it. A fresh 0..1
      // tile (what `planarRingUVs` gives) puts the whole texture on a corner a
      // few millimetres across — tens of times the density of the surface it
      // sits in, and the most visible part of "bevel ruins the UVs".
      const cornerUVs = ringUVsFromNeighbour(oriented);
      const caps = segments > 1
        ? gridDomedCorner(mesh, oriented, vert, cornerUVs, segments)
        : [addFace(mesh, oriented, { uvs: cornerUVs ?? planarRingUVs(oriented) })];
      for (const cap of caps) if (cap) created.push(cap);
    }
    mesh.verts.delete(vert);
  }

  clearSelection(mesh);
  for (const face of created) if (mesh.faces.has(face)) face.select = true;
  flushSelection(mesh, "face");
  return { faces: created, width: amount, segments };
}

/**
 * Fills the common three-edge bevel corner as a uniformly subdivided spherical
 * triangle. The boundary contains three chains of `segments` edges created by
 * the adjacent bevel strips. Reusing those vertices makes every strip loop
 * continue into the cap, while the barycentric interior avoids the single
 * many-spoked hub produced by the old fan.
 */
function gridDomedCorner(mesh, ring, vert, inheritedUVs, segments) {
  const steps = Math.max(1, Math.min(Math.round(segments) || 1, 16));
  if (ring.length !== steps * 3) return fanDomedCorner(mesh, ring, vert, inheritedUVs);

  // Blender's special three-edge M_ADJ pattern uses three m×m quad patches
  // when the profile has 2m segments. This is the topology visible on a
  // normally beveled cube: profile loops enter the corner, turn onto one of
  // three radial seams, and meet at a low-valence shared center.
  if (steps % 2 === 0) return quadDomedTriCorner(mesh, ring, vert, inheritedUVs, steps);

  const points = ring.map((corner) => corner.co);
  const sphere = fitSphere(points) ?? {
    center: vert.co,
    radius: points.reduce((sum, point) => sum + length3(sub3(point, vert.co)), 0) / points.length,
  };
  const corners = [ring[0], ring[steps], ring[steps * 2]];
  const directions = corners.map((corner) => normalize3(sub3(corner.co, sphere.center)));
  const ringUVs = inheritedUVs ?? projectRingUVs(points, normalize3(sub3(
    points.reduce((sum, point) => add3(sum, point), [0, 0, 0]).map((value) => value / points.length),
    sphere.center,
  ))) ?? planarRingUVs(ring);
  const cornerUVs = [ringUVs[0], ringUVs[steps], ringUVs[steps * 2]];
  const vertices = new Map();
  const uvs = new Map();
  const key = (a, b) => `${a}:${b}`;

  const boundaryIndex = (a, b, c) => {
    if (c === 0) return b; // A -> B
    if (a === 0) return steps + c; // B -> C
    if (b === 0) return (steps * 2 + a) % ring.length; // C -> A
    return -1;
  };
  for (let a = 0; a <= steps; a++) for (let b = 0; b <= steps - a; b++) {
    const c = steps - a - b;
    const boundary = boundaryIndex(a, b, c);
    let point;
    let uv;
    if (boundary >= 0) {
      point = ring[boundary];
      uv = ringUVs[boundary];
    } else {
      const direction = normalize3(add3(add3(scale3(directions[0], a), scale3(directions[1], b)), scale3(directions[2], c)));
      point = addVert(mesh, add3(sphere.center, scale3(direction, sphere.radius)));
      uv = [
        (cornerUVs[0][0] * a + cornerUVs[1][0] * b + cornerUVs[2][0] * c) / steps,
        (cornerUVs[0][1] * a + cornerUVs[1][1] * b + cornerUVs[2][1] * c) / steps,
      ];
    }
    vertices.set(key(a, b), point);
    uvs.set(key(a, b), uv);
  }

  const faces = [];
  const addTriangle = (coordinates) => {
    const triangle = coordinates.map(([a, b]) => vertices.get(key(a, b)));
    const triangleUVs = coordinates.map(([a, b]) => uvs.get(key(a, b)));
    const face = addFace(mesh, triangle, { uvs: triangleUVs });
    if (face) faces.push(face);
  };
  for (let a = 0; a < steps; a++) for (let b = 0; b < steps - a; b++) {
    addTriangle([[a + 1, b], [a, b + 1], [a, b]]);
    if (a + b < steps - 1) addTriangle([[a + 1, b], [a + 1, b + 1], [a, b + 1]]);
  }
  return faces;
}

function quadDomedTriCorner(mesh, ring, vert, inheritedUVs, steps) {
  const half = steps / 2;
  const points = ring.map((corner) => corner.co);
  const sphere = fitSphere(points) ?? {
    center: vert.co,
    radius: points.reduce((sum, point) => sum + length3(sub3(point, vert.co)), 0) / points.length,
  };
  const outward = normalize3(sub3(
    points.reduce((sum, point) => add3(sum, point), [0, 0, 0]).map((value) => value / points.length),
    sphere.center,
  ));
  const center = addVert(mesh, add3(sphere.center, scale3(outward, sphere.radius)));
  const ringUVs = inheritedUVs ?? projectRingUVs(points, outward) ?? planarRingUVs(ring);
  const centerUV = ringUVs.reduce(
    (sum, uv) => [sum[0] + uv[0] / ringUVs.length, sum[1] + uv[1] / ringUVs.length],
    [0, 0],
  );

  // One radial seam per profile arc midpoint. Adjacent patches reuse these
  // exact vertices, which is the essential difference from three unrelated
  // face insets or a triangle fan.
  const seams = Array.from({ length: 3 }, (_, side) => {
    const midpointIndex = side * steps + half;
    const midpoint = ring[midpointIndex];
    const midpointDirection = normalize3(sub3(midpoint.co, sphere.center));
    return Array.from({ length: half + 1 }, (_, index) => {
      if (index === 0) return midpoint;
      if (index === half) return center;
      const t = index / half;
      const direction = normalize3(lerp3(midpointDirection, outward, t));
      return addVert(mesh, add3(sphere.center, scale3(direction, sphere.radius)));
    });
  });

  const seamUVs = Array.from({ length: 3 }, (_, side) => {
    const midpointUV = ringUVs[side * steps + half];
    return Array.from({ length: half + 1 }, (_, index) => lerp2(midpointUV, centerUV, index / half));
  });
  const faces = [];
  const wrap = (index) => (index % ring.length + ring.length) % ring.length;

  for (let side = 0; side < 3; side++) {
    const previous = (side + 2) % 3;
    const patch = Array.from({ length: half + 1 }, () => Array(half + 1));
    const patchUV = Array.from({ length: half + 1 }, () => Array(half + 1));

    // Patch boundary: original corner -> forward midpoint, original corner ->
    // backward midpoint, and the two shared midpoint-to-center seams.
    for (let u = 0; u <= half; u++) {
      patch[u][0] = ring[side * steps + u];
      patchUV[u][0] = ringUVs[side * steps + u];
      patch[u][half] = seams[previous][u];
      patchUV[u][half] = seamUVs[previous][u];
    }
    for (let v = 0; v <= half; v++) {
      patch[0][v] = ring[wrap(side * steps - v)];
      patchUV[0][v] = ringUVs[wrap(side * steps - v)];
      patch[half][v] = seams[side][v];
      patchUV[half][v] = seamUVs[side][v];
    }

    // Coons interpolation respects all four curved boundaries. Interior points
    // are projected back onto the fitted corner sphere to continue the round
    // bevel profile rather than flattening each quad patch.
    const p00 = patch[0][0].co;
    const p10 = patch[half][0].co;
    const p01 = patch[0][half].co;
    const p11 = patch[half][half].co;
    for (let u = 1; u < half; u++) for (let v = 1; v < half; v++) {
      const fu = u / half;
      const fv = v / half;
      const horizontal = lerp3(patch[0][v].co, patch[half][v].co, fu);
      const vertical = lerp3(patch[u][0].co, patch[u][half].co, fv);
      const bilinear = add3(
        add3(scale3(p00, (1 - fu) * (1 - fv)), scale3(p10, fu * (1 - fv))),
        add3(scale3(p01, (1 - fu) * fv), scale3(p11, fu * fv)),
      );
      const coons = sub3(add3(horizontal, vertical), bilinear);
      const direction = normalize3(sub3(coons, sphere.center));
      patch[u][v] = addVert(mesh, add3(sphere.center, scale3(direction, sphere.radius)));
      patchUV[u][v] = lerp2(lerp2(patchUV[0][v], patchUV[half][v], fu), lerp2(patchUV[u][0], patchUV[u][half], fv), 0.5);
    }

    for (let u = 0; u < half; u++) for (let v = 0; v < half; v++) {
      const corners = [patch[u][v], patch[u + 1][v], patch[u + 1][v + 1], patch[u][v + 1]];
      const uvs = [patchUV[u][v], patchUV[u + 1][v], patchUV[u + 1][v + 1], patchUV[u][v + 1]];
      const face = addFace(mesh, corners, { uvs });
      if (face) faces.push(face);
    }
  }
  return faces;
}

/**
 * Bridges the two sides of a beveled edge.
 *
 * `atStart` and `atEnd` each hold the pair of corners sitting at one end of the
 * original edge, [face A's copy, face B's copy]. With one segment that is a
 * single quad; with more, the intermediate rings are placed on the circular arc
 * between the two offset directions, which is what gives a rounded profile
 * rather than a flat chamfer cut into steps.
 */
function buildBevelStrip(mesh, atStart, atEnd, pivotStart, pivotEnd, segments) {
  const steps = Math.max(1, Math.min(Math.round(segments) || 1, 16));
  const faces = [];
  const edgeDirection = normalize3(sub3(pivotEnd.co, pivotStart.co));
  // The profile circle is centred on the *offset* corner, not on the original
  // vertex. Sweeping around the vertex looks superficially right — it passes
  // through both endpoints — but it is the wrong circle: on a right-angled edge
  // it dips to 0.71w below the surface where a true round bevel only reaches
  // 0.29w, so the chamfer visibly scoops into the solid instead of rounding it.
  //
  // Offsetting the pivot by both in-face displacements (the parallelogram rule)
  // lands on the point that is the bevel width from each of the two faces,
  // which is the centre a bevel is defined about and is exact wherever the two
  // faces meet at a right angle.
  const arcPoint = (from, to, pivot, t) => {
    // `from` and `to` both include the same displacement along the original
    // edge (the neighbouring selected edges shortened this end of the strip).
    // The parallelogram sum includes that component twice, so remove one copy.
    // Without this correction every profile arc at a fully beveled corner has
    // a different centre and the cap pinches/balloons instead of lying on one
    // common corner sphere.
    const fromEdgeOffset = dot3(sub3(from.co, pivot.co), edgeDirection);
    const toEdgeOffset = dot3(sub3(to.co, pivot.co), edgeDirection);
    const sharedEdgeOffset = (fromEdgeOffset + toEdgeOffset) * 0.5;
    const center = sub3(
      sub3(add3(from.co, to.co), pivot.co),
      scale3(edgeDirection, sharedEdgeOffset),
    );
    const fromDirection = sub3(from.co, center);
    const toDirection = sub3(to.co, center);
    const blended = normalize3(lerp3(normalize3(fromDirection), normalize3(toDirection), t));
    if (length3(blended) < 1e-9) return addVert(mesh, lerp3(from.co, to.co, t));
    const radius = length3(fromDirection) + (length3(toDirection) - length3(fromDirection)) * t;
    return addVert(mesh, add3(center, scale3(blended, radius)));
  };
  // Both ends are kept as ordered chains, because the corner cap is stitched
  // out of them and needs the intermediate arc vertices, not just the corners.
  const startChain = [atStart[0]];
  const endChain = [atEnd[0]];
  let previous = [atStart[0], atEnd[0]];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const nextStart = step === steps ? atStart[1] : arcPoint(atStart[0], atStart[1], pivotStart, t);
    const nextEnd = step === steps ? atEnd[1] : arcPoint(atEnd[0], atEnd[1], pivotEnd, t);
    const face = addFace(mesh, [previous[1], previous[0], nextStart, nextEnd]);
    if (face) faces.push(face);
    startChain.push(nextStart);
    endChain.push(nextEnd);
    previous = [nextStart, nextEnd];
  }
  return { faces, startChain, endChain };
}

/**
 * UV for a point that slid along the edge from `corner` towards `towards`,
 * interpolated by how far along it actually landed.
 */
function edgeUV(corner, towards, vert) {
  const span = length3(sub3(towards.v.co, corner.v.co));
  if (span < 1e-12) return [...corner.uv];
  const travelled = Math.min(length3(sub3(vert.co, corner.v.co)) / span, 1);
  return [
    corner.uv[0] + (towards.uv[0] - corner.uv[0]) * travelled,
    corner.uv[1] + (towards.uv[1] - corner.uv[1]) * travelled,
  ];
}

/**
 * Stitches the arcs meeting at one beveled vertex into a single closed ring.
 *
 * Every strip that ran into this vertex left a chain there, and consecutive
 * chains share the shrunken face corner between them. Walking chain to chain
 * through those shared ends gives the boundary of the hole in order — including
 * the intermediate arc vertices, which is the part a one-segment bevel let us
 * get away with ignoring.
 */
function cornerRing(chains) {
  // Two is enough: a vertex with exactly two beveled edges still leaves a
  // lens-shaped hole between the two profiles, which has to be capped.
  if (chains.length < 2) return null;
  const remaining = chains.map((chain) => [...chain]);
  const first = remaining.shift();
  const ring = [...first];
  let guard = remaining.length + 1;
  while (remaining.length && guard-- > 0) {
    const tail = ring[ring.length - 1];
    const at = remaining.findIndex((chain) => chain[0] === tail || chain[chain.length - 1] === tail);
    if (at < 0) return null; // not a single closed fan; leave it uncapped
    const [chain] = remaining.splice(at, 1);
    const ordered = chain[0] === tail ? chain : [...chain].reverse();
    // The shared endpoint is already on the ring.
    ring.push(...ordered.slice(1));
  }
  if (remaining.length) return null;
  // The walk ends back where it started; drop the repeat.
  if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  return new Set(ring).size === ring.length ? ring : null;
}

/**
 * Caps a rounded bevel's corner with a dome rather than a flat polygon.
 *
 * The ring already sits on a sphere around the original vertex — that is what
 * the strips' arcs put it on — so a hub placed at the same radius along the
 * ring's mean direction continues the curvature instead of slicing across it.
 */
function fanDomedCorner(mesh, ring, vert, inheritedUVs = null) {
  const points = ring.map((corner) => corner.co);
  // The arcs meeting here are all centred on the same corner sphere, so fitting
  // one to the ring recovers that sphere exactly rather than approximating it.
  const sphere = fitSphere(points) ?? {
    center: vert.co,
    radius: points.reduce((sum, point) => sum + length3(sub3(point, vert.co)), 0) / points.length,
  };
  const outward = normalize3(sub3(
    points.reduce((sum, point) => add3(sum, point), [0, 0, 0]).map((value) => value / points.length),
    sphere.center,
  ));
  if (length3(outward) < 1e-9) return [addFace(mesh, ring, { uvs: inheritedUVs ?? planarRingUVs(ring) })];
  const hub = addVert(mesh, add3(sphere.center, scale3(outward, sphere.radius)));

  // A planar unwrap of the whole ring, reused per triangle so the corner keeps
  // one continuous mapping instead of one island per fan triangle.
  //
  // `planarRingUVs` derives its plane from the ring's Newell normal, which is
  // near zero for the lens-shaped ring a two-edge corner produces — two arcs
  // running between the same pair of points almost cancel. That collapses the
  // mapping to a point. Projecting against the dome's own axis instead is
  // always well conditioned, so it is the primary and Newell the fallback.
  const ringUVs = inheritedUVs ?? projectRingUVs(ring.map((corner) => corner.co), outward) ?? planarRingUVs(ring);
  const hubUV = ringUVs.reduce((sum, uv) => [sum[0] + uv[0] / ringUVs.length, sum[1] + uv[1] / ringUVs.length], [0, 0]);
  const faces = [];
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    faces.push(addFace(mesh, [ring[index], ring[next], hub], {
      uvs: [ringUVs[index], ringUVs[next], hubUV],
    }));
  }
  return faces;
}

/** 0..1 UVs for a ring flattened against a given plane normal, or null. */
function projectRingUVs(points, normal) {
  if (length3(normal) < 1e-9) return null;
  const reference = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const axisU = normalize3(cross3(reference, normal));
  if (length3(axisU) < 1e-9) return null;
  const axisV = cross3(normal, axisU);
  const flat = points.map((point) => [dot3(point, axisU), dot3(point, axisV)]);
  const minU = Math.min(...flat.map((entry) => entry[0]));
  const maxU = Math.max(...flat.map((entry) => entry[0]));
  const minV = Math.min(...flat.map((entry) => entry[1]));
  const maxV = Math.max(...flat.map((entry) => entry[1]));
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  if (spanU < 1e-12 && spanV < 1e-12) return null;
  const scale = Math.max(spanU, spanV);
  return flat.map((entry) => [(entry[0] - minU) / scale, (entry[1] - minV) / scale]);
}

/**
 * Least-squares sphere through a point set, or null if they are too flat to
 * determine one. Solving |p|^2 - 2 p.c = k is linear in (c, k), so this is a
 * 3x3 normal equation once k is eliminated against the centroid.
 */
function fitSphere(points) {
  if (points.length < 4) return null;
  const mean = points.reduce((sum, point) => add3(sum, point), [0, 0, 0]).map((value) => value / points.length);
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (const point of points) {
    const d = sub3(point, mean);
    const lengthSquared = dot3(d, d);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) matrix[row][column] += 2 * d[row] * d[column];
      rhs[row] += d[row] * lengthSquared;
    }
  }
  const determinant =
    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) -
    matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0]) +
    matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
  if (Math.abs(determinant) < 1e-12) return null; // coplanar ring: no sphere
  const solve = (column) => {
    const copy = matrix.map((row) => [...row]);
    for (let row = 0; row < 3; row++) copy[row][column] = rhs[row];
    return (
      copy[0][0] * (copy[1][1] * copy[2][2] - copy[1][2] * copy[2][1]) -
      copy[0][1] * (copy[1][0] * copy[2][2] - copy[1][2] * copy[2][0]) +
      copy[0][2] * (copy[1][0] * copy[2][1] - copy[1][1] * copy[2][0])
    ) / determinant;
  };
  const center = add3(mean, [solve(0), solve(1), solve(2)]);
  const radius = points.reduce((sum, point) => sum + length3(sub3(point, center)), 0) / points.length;
  return Number.isFinite(radius) && radius > 1e-9 ? { center, radius } : null;
}

/** Whether a ring's own winding normal points the same way as `normal`. */
function ringFacesAlong(ring, normal) {
  if (!normal) return true;
  // Newell normal, which is well defined for a non-planar ring too.
  const accumulated = [0, 0, 0];
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index].co;
    const next = ring[(index + 1) % ring.length].co;
    accumulated[0] += (current[1] - next[1]) * (current[2] + next[2]);
    accumulated[1] += (current[2] - next[2]) * (current[0] + next[0]);
    accumulated[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return dot3(accumulated, normal) >= 0;
}

/**
 * Sorts the bevel corners that replaced `vert` into a ring, by angle in the
 * plane the vertex used to face. The normal is passed in because the vertex is
 * already detached from its faces by the time the cap is built.
 */
function orderAroundVert(corners, vert, normal) {
  const reference = normalize3(sub3(corners[0].co, vert.co));
  const side = cross3(normal, reference);
  return [...corners].sort((a, b) => {
    const angle = (corner) => {
      const delta = sub3(corner.co, vert.co);
      return Math.atan2(dot3(delta, side), dot3(delta, reference));
    };
    return angle(a) - angle(b);
  });
}

/* -------------------------------------------------------------------------- */
/* Knife                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Knife (K): cuts the mesh along a polyline projected through it.
 *
 * `points` are world-space positions already snapped to the surface by the
 * caller (the editor raycasts each click). Each segment is walked across the
 * faces it crosses, splitting the entry and exit edges and chording the face
 * between them.
 */
export function knifeCut(mesh, points, { throughAll = false } = {}) {
  if (!Array.isArray(points) || points.length < 2) return { error: "The knife needs at least two points" };
  const createdEdges = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const segment = cutSegment(mesh, points[index], points[index + 1], throughAll);
    createdEdges.push(...segment);
  }
  clearSelection(mesh);
  for (const edge of createdEdges) if (mesh.edges.has(edge)) edge.select = true;
  flushSelection(mesh, "edge");
  return { edges: createdEdges };
}

/**
 * Cuts one straight segment. The cut plane contains the segment and the face
 * normal, so the cut runs straight across the surface rather than following the
 * shortest path over it.
 */
function cutSegment(mesh, from, to, throughAll) {
  const direction = sub3(to, from);
  if (length3(direction) < 1e-9) return [];
  const candidates = [...mesh.faces].filter((face) => {
    if (throughAll) return true;
    // Restrict to faces the segment actually passes over, tested in the face plane.
    const normal = faceNormal(face);
    const center = faceCenter(face);
    const height = dot3(sub3(from, center), normal);
    const otherHeight = dot3(sub3(to, center), normal);
    return Math.abs(height) < 1e-3 || Math.abs(otherHeight) < 1e-3 || height * otherHeight < 0;
  });
  const created = [];
  for (const face of candidates) {
    if (!mesh.faces.has(face)) continue;
    const normal = faceNormal(face);
    // Plane through the segment, perpendicular to the face.
    const planeNormal = normalize3(cross3(direction, normal));
    if (length3(planeNormal) < 1e-9) continue;
    const distanceOf = (co) => dot3(sub3(co, from), planeNormal);
    const hits = [];
    for (const loop of face.loops) {
      const next = face.loops[(loop.index + 1) % face.loops.length];
      const a = distanceOf(loop.v.co);
      const b = distanceOf(next.v.co);
      if (Math.abs(a) < 1e-7) {
        hits.push({ vert: loop.v, edge: null });
        continue;
      }
      if (a * b < 0) hits.push({ vert: null, edge: loop.e, t: a / (a - b), from: loop.v });
    }
    const unique = hits.filter((hit, at) => hits.findIndex((other) => other.vert && other.vert === hit.vert) === at || !hit.vert);
    if (unique.length !== 2) continue;
    // Only cut between points that lie within the drawn segment.
    const along = (hit) => {
      const co = hit.vert ? hit.vert.co : lerp3(hit.from.co, edgeOther(hit.edge, hit.from).co, hit.t);
      return dot3(sub3(co, from), direction) / dot3(direction, direction);
    };
    if (!throughAll && unique.every((hit) => along(hit) < 0 || along(hit) > 1)) continue;

    const verts = unique.map((hit) => {
      if (hit.vert) return hit.vert;
      const parameter = hit.edge.v1 === hit.from ? hit.t : 1 - hit.t;
      return splitEdge(mesh, hit.edge, Math.max(0.0001, Math.min(0.9999, parameter)));
    });
    // splitEdge rebuilt the face; find the replacement holding both points.
    const rebuilt = [...mesh.faces].find((candidate) => verts.every((vert) => candidate.loops.some((loop) => loop.v === vert)));
    if (!rebuilt) continue;
    const a = rebuilt.loops.findIndex((loop) => loop.v === verts[0]);
    const b = rebuilt.loops.findIndex((loop) => loop.v === verts[1]);
    if (splitFace(mesh, rebuilt, a, b)) {
      const edge = findEdge(verts[0], verts[1]);
      if (edge) created.push(edge);
    }
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/* Offset edge loop                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ctrl+Shift+R: a pair of loops straddling the selected one.
 *
 * Both go in as a single loop cut. Running two separate cuts would fail: the
 * first one splits the seed edge, so the second would be handed a dead edge.
 */
export function offsetEdgeLoop(mesh, seed, { factor = 0.5 } = {}) {
  const spread = Math.max(0.01, Math.min(factor, 0.99)) * 0.5;
  return loopCut(mesh, seed, { factors: [0.5 - spread, 0.5 + spread] });
}
