/**
 * A BMesh-style polygon mesh kernel, modelled on Blender's own edit-mode
 * structure.
 *
 * The editor used to represent edit topology as a triangle soup plus a
 * remembered set of "hidden" diagonals which stood in for quads. Every
 * polygon-level operation then had to *guess* which triangle pairs had once
 * been a quad, and the guesses disagreed with each other. Here a quad is a
 * quad: faces hold an ordered ring of loops, and the triangle buffer the
 * renderer needs is a derived product (see `tessellate.js`).
 *
 * Element model
 * -------------
 *   BMVert  position + the edges using it. Purely geometric.
 *   BMEdge  two verts + a radial list of the loops running along it.
 *   BMLoop  one corner of one face: (vert, edge, face) plus per-corner data
 *           such as UVs. Per-corner UVs are why vertices no longer have to be
 *           duplicated at a UV seam — the seam lives on the loops, so moving a
 *           vertex moves *one* thing and welding heuristics disappear.
 *   BMFace  an ordered loop ring. Any length >= 3, so n-gons are first class.
 *
 * Faces store their loops in a plain array rather than a doubly linked cycle.
 * It is the same information, is far harder to corrupt from JavaScript, and
 * `loop.index` keeps O(1) access to the ring neighbours.
 *
 * Element identity is a monotonically increasing per-mesh `id`. Sets preserve
 * insertion order in JS, so iteration is deterministic and serialisation is
 * stable between sessions.
 */

const EPSILON = 1e-9;

export function createMesh() {
  return { verts: new Set(), edges: new Set(), faces: new Set(), nextId: 1 };
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export function addVert(mesh, co) {
  const vert = {
    id: mesh.nextId++,
    co: [co[0], co[1], co[2]],
    edges: new Set(),
    select: false,
    hide: false,
    tag: 0,
  };
  mesh.verts.add(vert);
  return vert;
}

/** The edge joining two verts, or null. Scans the smaller of the two rings. */
export function findEdge(a, b) {
  const [small, other] = a.edges.size <= b.edges.size ? [a, b] : [b, a];
  for (const edge of small.edges) {
    if (edge.v1 === other || edge.v2 === other) return edge;
  }
  return null;
}

export function addEdge(mesh, a, b) {
  if (a === b) return null;
  const existing = findEdge(a, b);
  if (existing) return existing;
  const edge = {
    id: mesh.nextId++,
    v1: a,
    v2: b,
    loops: [],
    seam: false,
    sharp: false,
    crease: 0,
    bevelWeight: 0,
    select: false,
    hide: false,
    tag: 0,
  };
  a.edges.add(edge);
  b.edges.add(edge);
  mesh.edges.add(edge);
  return edge;
}

/**
 * Creates a face from an ordered vertex ring, reusing existing edges.
 *
 * `uvs` is an optional per-corner array aligned with `verts`. Duplicate or
 * fewer than three vertices produce no face — callers routinely hand in
 * degenerate rings after a collapse and expect a null rather than a throw.
 */
export function addFace(mesh, verts, options = {}) {
  if (!Array.isArray(verts) || verts.length < 3) return null;
  if (new Set(verts).size !== verts.length) return null;
  const face = {
    id: mesh.nextId++,
    loops: [],
    material: options.material ?? 0,
    smooth: options.smooth ?? true,
    select: false,
    hide: false,
    tag: 0,
  };
  for (let index = 0; index < verts.length; index++) {
    const vert = verts[index];
    const edge = addEdge(mesh, vert, verts[(index + 1) % verts.length]);
    const loop = {
      v: vert,
      e: edge,
      f: face,
      index,
      uv: options.uvs?.[index] ? [options.uvs[index][0], options.uvs[index][1]] : [0, 0],
    };
    face.loops.push(loop);
    edge.loops.push(loop);
  }
  mesh.faces.add(face);
  return face;
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                     */
/* -------------------------------------------------------------------------- */

/** Removes a face, leaving its edges and verts in place (possibly as wire). */
export function killFace(mesh, face) {
  if (!mesh.faces.delete(face)) return;
  for (const loop of face.loops) {
    const radial = loop.e.loops;
    const at = radial.indexOf(loop);
    if (at >= 0) radial.splice(at, 1);
  }
  face.loops = [];
}

/** Removes an edge and every face that used it. */
export function killEdge(mesh, edge) {
  for (const loop of [...edge.loops]) killFace(mesh, loop.f);
  if (!mesh.edges.delete(edge)) return;
  edge.v1.edges.delete(edge);
  edge.v2.edges.delete(edge);
}

/** Removes a vert together with every edge and face touching it. */
export function killVert(mesh, vert) {
  for (const edge of [...vert.edges]) killEdge(mesh, edge);
  mesh.verts.delete(vert);
}

/** Drops verts that no edge references. Returns how many were removed. */
export function killLooseVerts(mesh) {
  let removed = 0;
  for (const vert of [...mesh.verts]) {
    if (vert.edges.size === 0) {
      mesh.verts.delete(vert);
      removed++;
    }
  }
  return removed;
}

/** Drops edges that no face references. Returns how many were removed. */
export function killWireEdges(mesh) {
  let removed = 0;
  for (const edge of [...mesh.edges]) {
    if (edge.loops.length === 0) {
      killEdge(mesh, edge);
      removed++;
    }
  }
  return removed;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export const faceVerts = (face) => face.loops.map((loop) => loop.v);
export const faceEdges = (face) => face.loops.map((loop) => loop.e);
export const edgeFaces = (edge) => edge.loops.map((loop) => loop.f);
export const edgeOther = (edge, vert) => (edge.v1 === vert ? edge.v2 : edge.v1);
export const isWireEdge = (edge) => edge.loops.length === 0;
export const isBoundaryEdge = (edge) => edge.loops.length === 1;
export const isManifoldEdge = (edge) => edge.loops.length === 2;
export const loopNext = (loop) => loop.f.loops[(loop.index + 1) % loop.f.loops.length];
export const loopPrev = (loop) => loop.f.loops[(loop.index + loop.f.loops.length - 1) % loop.f.loops.length];

export function vertFaces(vert) {
  const faces = new Set();
  for (const edge of vert.edges) for (const loop of edge.loops) faces.add(loop.f);
  return [...faces];
}

/** True when `vert` is used by exactly one closed fan of faces. */
export function isManifoldVert(vert) {
  if (vert.edges.size === 0) return false;
  for (const edge of vert.edges) if (edge.loops.length > 2) return false;
  return true;
}

/** Faces sharing an edge with `face`. */
export function faceNeighbours(face) {
  const neighbours = new Set();
  for (const loop of face.loops) {
    for (const other of loop.e.loops) if (other.f !== face) neighbours.add(other.f);
  }
  return [...neighbours];
}

/**
 * A UV for `vert` borrowed from a face already using it.
 *
 * New faces built from existing vertices — a filled hole, a grid fill, a face
 * made with F — have no UVs of their own, and defaulting them to (0,0) collapses
 * the whole face to a single texel. Inheriting from a neighbour keeps the new
 * face inside the same UV island as the surface it joins.
 *
 * Call before adding the new face, or pass it as `skip`, so the face's own
 * empty corners are not what gets found.
 */
export function inheritedUV(vert, skip = null) {
  for (const edge of vert.edges) {
    for (const loop of edge.loops) {
      if (loop.v === vert && loop.f !== skip) return [...loop.uv];
    }
  }
  return [0, 0];
}

/** The loop of `face` that runs along `edge`, or null. */
export function faceLoopOnEdge(face, edge) {
  return face.loops.find((loop) => loop.e === edge) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export function edgeLength(edge) {
  const a = edge.v1.co;
  const b = edge.v2.co;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

export function edgeCenter(edge) {
  const a = edge.v1.co;
  const b = edge.v2.co;
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

export function faceCenter(face) {
  const center = [0, 0, 0];
  for (const loop of face.loops) {
    center[0] += loop.v.co[0];
    center[1] += loop.v.co[1];
    center[2] += loop.v.co[2];
  }
  const inverse = 1 / face.loops.length;
  return [center[0] * inverse, center[1] * inverse, center[2] * inverse];
}

/**
 * Newell's normal. A cross product of the first three corners is wrong for a
 * concave or non-planar n-gon — Newell integrates over the whole ring and
 * yields the least-squares plane normal, which is what every polygon operator
 * here (inset, extrude, triangulation) actually wants.
 */
export function faceNormal(face) {
  const normal = [0, 0, 0];
  const loops = face.loops;
  for (let index = 0; index < loops.length; index++) {
    const current = loops[index].v.co;
    const next = loops[(index + 1) % loops.length].v.co;
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length < EPSILON) return [0, 0, 1];
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

export function faceArea(face) {
  const normal = [0, 0, 0];
  const loops = face.loops;
  for (let index = 0; index < loops.length; index++) {
    const current = loops[index].v.co;
    const next = loops[(index + 1) % loops.length].v.co;
    normal[0] += current[1] * next[2] - current[2] * next[1];
    normal[1] += current[2] * next[0] - current[0] * next[2];
    normal[2] += current[0] * next[1] - current[1] * next[0];
  }
  return Math.hypot(normal[0], normal[1], normal[2]) * 0.5;
}

/** Area-weighted vertex normal, matching what smooth shading displays. */
export function vertNormal(vert) {
  const normal = [0, 0, 0];
  for (const face of vertFaces(vert)) {
    const faceN = faceNormal(face);
    const weight = faceArea(face);
    normal[0] += faceN[0] * weight;
    normal[1] += faceN[1] * weight;
    normal[2] += faceN[2] * weight;
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length < EPSILON) return [0, 1, 0];
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/** Angle in radians between the two faces of a manifold edge; 0 when flat. */
export function edgeFaceAngle(edge) {
  if (edge.loops.length !== 2) return 0;
  const a = faceNormal(edge.loops[0].f);
  const b = faceNormal(edge.loops[1].f);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot);
}

/**
 * True when the two faces of `edge` form a convex ridge, i.e. the dihedral
 * bends away from the surface. Bevel and select-sharp need the sign, not just
 * the magnitude, of the crease.
 */
export function isConvexEdge(edge) {
  if (edge.loops.length !== 2) return false;
  const [first, second] = edge.loops;
  const normal = faceNormal(first.f);
  const otherCenter = faceCenter(second.f);
  const here = first.v.co;
  const delta = [otherCenter[0] - here[0], otherCenter[1] - here[1], otherCenter[2] - here[2]];
  return delta[0] * normal[0] + delta[1] * normal[1] + delta[2] * normal[2] < 0;
}

/* -------------------------------------------------------------------------- */
/* Topological operators                                                       */
/* -------------------------------------------------------------------------- */

/** Rebuilds `face` on a new vertex ring, preserving its attributes. */
export function replaceFace(mesh, face, verts, uvs) {
  const options = { material: face.material, smooth: face.smooth, uvs };
  const wasSelected = face.select;
  const wasTagged = face.tag;
  killFace(mesh, face);
  const next = addFace(mesh, verts, options);
  if (next) {
    next.select = wasSelected;
    next.tag = wasTagged;
  }
  return next;
}

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Inserts a vertex at parameter `t` along `edge`, splitting every face that
 * uses it. Returns the new vertex.
 *
 * Implemented by rebuilding the adjacent faces rather than by radial surgery.
 * `addFace` reuses existing edges, so edge flags (seam, sharp, crease) on the
 * *other* edges of those faces survive untouched, and the two halves inherit
 * the flags of the edge they replace.
 */
export function splitEdge(mesh, edge, t = 0.5) {
  const { v1, v2 } = edge;
  const middle = addVert(mesh, lerp3(v1.co, v2.co, t));
  const rebuilds = edge.loops.map((loop) => ({
    face: loop.f,
    verts: faceVerts(loop.f),
    uvs: loop.f.loops.map((entry) => [...entry.uv]),
  }));
  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);

  const flags = { seam: edge.seam, sharp: edge.sharp, crease: edge.crease, bevelWeight: edge.bevelWeight, select: edge.select };
  killEdge(mesh, edge);
  for (const [a, b] of [[v1, middle], [middle, v2]]) Object.assign(addEdge(mesh, a, b), flags);

  for (const rebuild of rebuilds) {
    const verts = [];
    const uvs = [];
    for (let index = 0; index < rebuild.verts.length; index++) {
      const current = rebuild.verts[index];
      const next = rebuild.verts[(index + 1) % rebuild.verts.length];
      verts.push(current);
      uvs.push(rebuild.uvs[index]);
      const forward = current === v1 && next === v2;
      const backward = current === v2 && next === v1;
      if (!forward && !backward) continue;
      verts.push(middle);
      const nextUV = rebuild.uvs[(index + 1) % rebuild.verts.length];
      uvs.push(lerp2(rebuild.uvs[index], nextUV, forward ? t : 1 - t));
    }
    const face = addFace(mesh, verts, { material: rebuild.face.material, smooth: rebuild.face.smooth, uvs });
    if (face) {
      face.select = rebuild.face.select;
      face.tag = rebuild.face.tag;
    }
  }
  return middle;
}

/**
 * Cuts `face` in two along the chord between the loops at ring positions `a`
 * and `b`. Returns the two new faces, or null when the cut is degenerate
 * (adjacent corners, which would produce a zero-area sliver).
 */
export function splitFace(mesh, face, a, b) {
  const count = face.loops.length;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (to - from < 2 || (from === 0 && to === count - 1)) return null;
  const verts = faceVerts(face);
  const uvs = face.loops.map((loop) => [...loop.uv]);
  const options = { material: face.material, smooth: face.smooth };
  const wasSelected = face.select;

  const firstRange = [];
  const firstUVs = [];
  for (let index = from; index <= to; index++) {
    firstRange.push(verts[index]);
    firstUVs.push(uvs[index]);
  }
  const secondRange = [];
  const secondUVs = [];
  for (let index = to; index !== from; index = (index + 1) % count) {
    secondRange.push(verts[index]);
    secondUVs.push(uvs[index]);
  }
  secondRange.push(verts[from]);
  secondUVs.push(uvs[from]);

  killFace(mesh, face);
  const first = addFace(mesh, firstRange, { ...options, uvs: firstUVs });
  const second = addFace(mesh, secondRange, { ...options, uvs: secondUVs });
  for (const half of [first, second]) {
    if (!half) continue;
    half.select = wasSelected;
    half.tag = face.tag;
  }
  return first && second ? [first, second] : null;
}

/**
 * Merges the two faces sharing `edge` into one, removing the edge. Returns the
 * merged face, or null when the edge is not manifold or the merge would create
 * a face that visits a vertex twice (which happens where the two faces share
 * more than one edge).
 */
export function dissolveEdge(mesh, edge) {
  if (edge.loops.length !== 2) return null;
  const [loopA, loopB] = edge.loops;
  const faceA = loopA.f;
  const faceB = loopB.f;
  if (faceA === faceB) return null;

  const ring = [];
  const uvs = [];
  const push = (loop) => {
    ring.push(loop.v);
    uvs.push([...loop.uv]);
  };
  // Both faces traverse the shared edge, in opposite directions. Walk all of A
  // starting just past that edge, so the ring ends on A's copy of the edge's
  // far endpoint; then splice in B's corners *strictly between* its own two
  // copies of the shared endpoints.
  const countA = faceA.loops.length;
  const countB = faceB.loops.length;
  for (let step = 0; step < countA; step++) push(faceA.loops[(loopA.index + 1 + step) % countA]);
  for (let step = 0; step <= countB - 3; step++) push(faceB.loops[(loopB.index + 2 + step) % countB]);

  if (new Set(ring).size !== ring.length) return null;
  const material = faceA.material;
  const smooth = faceA.smooth;
  const selected = faceA.select || faceB.select;
  killFace(mesh, faceA);
  killFace(mesh, faceB);
  killEdge(mesh, edge);
  const merged = addFace(mesh, ring, { material, smooth, uvs });
  if (merged) merged.select = selected;
  return merged;
}

/**
 * Removes a valence-2 vertex by fusing its two edges, the way Blender's
 * Dissolve Vertices treats a vertex in the middle of an edge. Returns true when
 * the vertex was dissolved.
 */
export function dissolveVertEdgeChain(mesh, vert) {
  if (vert.edges.size !== 2) return false;
  const [first, second] = [...vert.edges];
  const a = edgeOther(first, vert);
  const b = edgeOther(second, vert);
  if (a === b || findEdge(a, b)) return false;
  const rebuilds = vertFaces(vert).map((face) => ({
    face,
    verts: faceVerts(face).filter((entry) => entry !== vert),
    uvs: face.loops.filter((loop) => loop.v !== vert).map((loop) => [...loop.uv]),
    material: face.material,
    smooth: face.smooth,
    select: face.select,
  }));
  if (rebuilds.some((rebuild) => rebuild.verts.length < 3)) return false;
  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);
  killVert(mesh, vert);
  if (!rebuilds.length) addEdge(mesh, a, b);
  for (const rebuild of rebuilds) {
    const face = addFace(mesh, rebuild.verts, { material: rebuild.material, smooth: rebuild.smooth, uvs: rebuild.uvs });
    if (face) face.select = rebuild.select;
  }
  return true;
}

/**
 * Fuses `from` into `into`: every face and edge referencing `from` is rebuilt
 * against `into`, and faces that collapse to fewer than three distinct corners
 * are dropped. This is the primitive behind every Merge variant.
 */
export function weldVerts(mesh, from, into) {
  if (from === into) return;
  const rebuilds = vertFaces(from).map((face) => ({
    verts: faceVerts(face).map((vert) => (vert === from ? into : vert)),
    uvs: face.loops.map((loop) => [...loop.uv]),
    material: face.material,
    smooth: face.smooth,
    select: face.select,
    face,
  }));
  const wireNeighbours = [...from.edges]
    .filter((edge) => edge.loops.length === 0)
    .map((edge) => edgeOther(edge, from));
  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);
  killVert(mesh, from);
  for (const neighbour of wireNeighbours) if (neighbour !== into) addEdge(mesh, neighbour, into);
  for (const rebuild of rebuilds) {
    // Collapse duplicated corners in ring order so a quad folding onto itself
    // becomes a triangle rather than a face that visits a vertex twice.
    const verts = [];
    const uvs = [];
    for (let index = 0; index < rebuild.verts.length; index++) {
      const vert = rebuild.verts[index];
      if (verts.length && verts[verts.length - 1] === vert) continue;
      verts.push(vert);
      uvs.push(rebuild.uvs[index]);
    }
    if (verts.length > 1 && verts[0] === verts[verts.length - 1]) {
      verts.pop();
      uvs.pop();
    }
    if (verts.length < 3 || new Set(verts).size !== verts.length) continue;
    const face = addFace(mesh, verts, { material: rebuild.material, smooth: rebuild.smooth, uvs });
    if (face) face.select = rebuild.select;
  }
}

/** Reverses a face's winding, flipping its normal. UVs follow their corner. */
export function flipFace(mesh, face) {
  const verts = faceVerts(face).reverse();
  const uvs = face.loops.map((loop) => [...loop.uv]).reverse();
  // Rotate so the ring still starts at the original first corner; this keeps
  // face-loop indices stable for callers holding on to a corner position.
  verts.unshift(verts.pop());
  uvs.unshift(uvs.pop());
  return replaceFace(mesh, face, verts, uvs);
}

/* -------------------------------------------------------------------------- */
/* Whole-mesh helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Deep copy. Returns the clone plus maps from source elements to their copies. */
export function copyMesh(mesh) {
  const copy = createMesh();
  copy.nextId = mesh.nextId;
  const vertMap = new Map();
  const edgeMap = new Map();
  const faceMap = new Map();
  for (const vert of mesh.verts) {
    const next = { id: vert.id, co: [...vert.co], edges: new Set(), select: vert.select, hide: vert.hide, tag: vert.tag };
    copy.verts.add(next);
    vertMap.set(vert, next);
  }
  for (const edge of mesh.edges) {
    const next = {
      id: edge.id,
      v1: vertMap.get(edge.v1),
      v2: vertMap.get(edge.v2),
      loops: [],
      seam: edge.seam,
      sharp: edge.sharp,
      crease: edge.crease,
      bevelWeight: edge.bevelWeight,
      select: edge.select,
      hide: edge.hide,
      tag: edge.tag,
    };
    next.v1.edges.add(next);
    next.v2.edges.add(next);
    copy.edges.add(next);
    edgeMap.set(edge, next);
  }
  for (const face of mesh.faces) {
    const next = {
      id: face.id,
      loops: [],
      material: face.material,
      smooth: face.smooth,
      select: face.select,
      hide: face.hide,
      tag: face.tag,
    };
    face.loops.forEach((loop, index) => {
      const copiedLoop = { v: vertMap.get(loop.v), e: edgeMap.get(loop.e), f: next, index, uv: [...loop.uv] };
      next.loops.push(copiedLoop);
      copiedLoop.e.loops.push(copiedLoop);
    });
    copy.faces.add(next);
    faceMap.set(face, next);
  }
  return { mesh: copy, vertMap, edgeMap, faceMap };
}

/**
 * Structural self-check used by the tests and by the debug overlay. Returns an
 * array of human-readable problems; an empty array means the mesh is sane.
 */
export function validateMesh(mesh) {
  const problems = [];
  for (const edge of mesh.edges) {
    if (!mesh.verts.has(edge.v1) || !mesh.verts.has(edge.v2)) problems.push(`edge ${edge.id} references a dead vert`);
    if (!edge.v1.edges.has(edge) || !edge.v2.edges.has(edge)) problems.push(`edge ${edge.id} missing from a vert ring`);
    if (edge.v1 === edge.v2) problems.push(`edge ${edge.id} is a self-loop`);
  }
  for (const vert of mesh.verts) {
    for (const edge of vert.edges) {
      if (!mesh.edges.has(edge)) problems.push(`vert ${vert.id} references a dead edge`);
    }
  }
  for (const face of mesh.faces) {
    if (face.loops.length < 3) problems.push(`face ${face.id} has ${face.loops.length} corners`);
    if (new Set(faceVerts(face)).size !== face.loops.length) problems.push(`face ${face.id} visits a vert twice`);
    face.loops.forEach((loop, index) => {
      if (loop.index !== index) problems.push(`face ${face.id} loop ${index} has stale index ${loop.index}`);
      if (loop.f !== face) problems.push(`face ${face.id} loop ${index} points at another face`);
      if (!mesh.edges.has(loop.e)) problems.push(`face ${face.id} loop ${index} references a dead edge`);
      else if (!loop.e.loops.includes(loop)) problems.push(`face ${face.id} loop ${index} missing from its radial`);
      const next = face.loops[(index + 1) % face.loops.length];
      const matches = (loop.e.v1 === loop.v && loop.e.v2 === next.v) || (loop.e.v2 === loop.v && loop.e.v1 === next.v);
      if (!matches) problems.push(`face ${face.id} loop ${index} edge does not span its corner`);
    });
  }
  return problems;
}
