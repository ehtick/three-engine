/**
 * Selection for edit mode.
 *
 * Selection state lives on the elements (`vert.select`, `edge.select`,
 * `face.select`) exactly as it does in Blender, rather than in three parallel
 * Sets keyed by stringified positions. That removes a whole class of bug where
 * the three sets disagreed after an operator rebuilt the topology, and it makes
 * "flushing" — the rule that selecting both ends of an edge selects the edge —
 * a single well-defined pass instead of ad-hoc conversions at every call site.
 *
 * The *active* element is tracked separately. Blender distinguishes "selected"
 * from "active" (the last thing you clicked), and operators such as Merge At
 * Last, Select Next Active, and Bridge's pairing all depend on it.
 */

import {
  edgeFaceAngle,
  edgeFaces,
  edgeLength,
  edgeOther,
  faceArea,
  faceCenter,
  faceLoopOnEdge,
  faceNeighbours,
  faceNormal,
  faceVerts,
  isBoundaryEdge,
  isManifoldEdge,
  isWireEdge,
  vertFaces,
  vertNormal,
} from "./bmesh.js";

export const MODES = ["vert", "edge", "face"];

export const elementsOf = (mesh, mode) => (mode === "vert" ? mesh.verts : mode === "edge" ? mesh.edges : mesh.faces);

export function selected(mesh, mode) {
  const result = [];
  for (const element of elementsOf(mesh, mode)) if (element.select && !element.hide) result.push(element);
  return result;
}

export function selectionCount(mesh, mode) {
  let count = 0;
  for (const element of elementsOf(mesh, mode)) if (element.select && !element.hide) count++;
  return count;
}

export function clearSelection(mesh) {
  for (const vert of mesh.verts) vert.select = false;
  for (const edge of mesh.edges) edge.select = false;
  for (const face of mesh.faces) face.select = false;
}

export function selectAll(mesh, mode) {
  for (const element of elementsOf(mesh, mode)) if (!element.hide) element.select = true;
  flushSelection(mesh, mode);
}

export function invertSelection(mesh, mode) {
  for (const element of elementsOf(mesh, mode)) if (!element.hide) element.select = !element.select;
  flushSelection(mesh, mode);
}

export function setSelection(mesh, mode, elements, { add = false, remove = false } = {}) {
  if (!add && !remove) clearSelection(mesh);
  for (const element of elements) {
    if (!element || element.hide) continue;
    element.select = !remove;
  }
  flushSelection(mesh, mode);
}

/**
 * Propagates selection between element types the way Blender does.
 *
 * The driving mode is authoritative: in vertex mode an edge is selected when
 * both its verts are, and a face when all of its verts are. In edge or face
 * mode selection flows the other way first — the elements you picked select
 * their verts — and then back up, so a face selection also lights its edges.
 */
export function flushSelection(mesh, mode) {
  if (mode === "edge") {
    for (const vert of mesh.verts) vert.select = false;
    for (const edge of mesh.edges) {
      if (!edge.select) continue;
      edge.v1.select = true;
      edge.v2.select = true;
    }
  } else if (mode === "face") {
    for (const vert of mesh.verts) vert.select = false;
    for (const edge of mesh.edges) edge.select = false;
    for (const face of mesh.faces) {
      if (!face.select) continue;
      for (const loop of face.loops) {
        loop.v.select = true;
        loop.e.select = true;
      }
    }
    return;
  }
  if (mode !== "edge") {
    for (const edge of mesh.edges) edge.select = edge.v1.select && edge.v2.select;
  }
  for (const face of mesh.faces) face.select = face.loops.every((loop) => loop.v.select);
}

/* -------------------------------------------------------------------------- */
/* Loops, rings and links                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The next edge of an edge loop, leaving `edge` through `vert`.
 *
 * Three rules, in priority order, which between them reproduce what Alt+Click
 * does in Blender:
 *
 *  1. Along an open boundary, follow the boundary. This is what walks the rim
 *     of a plane or an unclosed surface.
 *  2. Through a 4-valence vertex, take the one edge sharing no face with the
 *     current edge. This is the dominant case — grids, cylinders, anything
 *     subdivided — and it is the rule the manual describes.
 *  3. Otherwise continue around the border of `face`, if that face is a quad.
 *
 * Rule 3 exists because rule 2 alone stops dead on a cube, whose vertices are
 * all valence 3: from a top edge, the other top edge and the vertical edge each
 * share a face with the current edge, so "the edge sharing no face" does not
 * exist. Blender disambiguates using the face under the cursor — its walker
 * starts from a loop (a face corner), not a bare edge — which is why clicking a
 * cube's top edge selects the top square. Restricting rule 3 to quads is what
 * keeps a triangle fan's spoke from selecting the triangle's border instead of
 * correctly stopping at the pole.
 */
function nextLoopEdge(edge, vert, face) {
  if (isBoundaryEdge(edge)) {
    const candidates = [...vert.edges].filter((candidate) => candidate !== edge && isBoundaryEdge(candidate));
    return candidates.length === 1 ? { edge: candidates[0], face } : null;
  }
  if (vert.edges.size === 4) {
    const touching = new Set(edgeFaces(edge));
    const candidates = [...vert.edges].filter(
      (candidate) => candidate !== edge && !edgeFaces(candidate).some((other) => touching.has(other)),
    );
    if (candidates.length !== 1) return null;
    const next = candidates[0];
    // Carry a face along so a later ambiguous vertex still has a reference.
    const carried = edgeFaces(next).find((candidate) => edgeFaces(edge).includes(candidate)) ?? edgeFaces(next)[0];
    return { edge: next, face: carried };
  }
  if (!face || face.loops.length !== 4 || !face.loops.some((loop) => loop.e === edge)) return null;
  const candidates = face.loops.filter((loop) => loop.e !== edge && (loop.e.v1 === vert || loop.e.v2 === vert));
  if (candidates.length !== 1) return null;
  // Stay on this face. Stepping to the edge's far face instead would spiral
  // around the solid — on a cube that produces an eight-edge seam rather than
  // the four edges bounding the face the user clicked.
  return { edge: candidates[0].e, face };
}

/**
 * Every edge in the loop containing `start`, including `start`.
 *
 * `preferredFace` is the face under the cursor when the user Alt+Clicked. It
 * only matters where the topology is ambiguous (see `nextLoopEdge`), and
 * defaults to whichever face the edge lists first.
 */
export function edgeLoop(start, preferredFace = null) {
  const loop = new Set([start]);
  const seedFace = preferredFace && edgeFaces(start).includes(preferredFace) ? preferredFace : edgeFaces(start)[0] ?? null;
  for (const origin of [start.v1, start.v2]) {
    let edge = start;
    let vert = origin;
    let face = seedFace;
    for (let step = 0; step < 100000; step++) {
      const next = nextLoopEdge(edge, vert, face);
      if (!next || loop.has(next.edge)) break;
      loop.add(next.edge);
      vert = edgeOther(next.edge, vert);
      edge = next.edge;
      face = next.face;
    }
  }
  return loop;
}

/** The edge opposite `edge` across a quad, or null when the face is not a quad. */
function oppositeEdgeInQuad(face, edge) {
  if (face.loops.length !== 4) return null;
  const loop = faceLoopOnEdge(face, edge);
  return loop ? face.loops[(loop.index + 2) % 4].e : null;
}

/**
 * Every edge in the ring containing `start`: the parallel edges reached by
 * stepping across quads. This is Ctrl+Alt+Click, and it is also the skeleton a
 * loop cut inserts its new edge along.
 */
export function edgeRing(start) {
  const ring = new Set([start]);
  const faces = new Set();
  for (const seedFace of edgeFaces(start)) {
    let edge = start;
    let face = seedFace;
    for (let step = 0; step < 100000; step++) {
      const next = oppositeEdgeInQuad(face, edge);
      if (!next || ring.has(next)) break;
      ring.add(next);
      faces.add(face);
      const onward = edgeFaces(next).find((candidate) => candidate !== face);
      if (!onward) break;
      edge = next;
      face = onward;
    }
  }
  return ring;
}

/** The faces a ring passes through — Blender's face loop. */
export function faceLoop(start, edge) {
  const faces = new Set([start]);
  let current = start;
  let currentEdge = edge;
  for (let side = 0; side < 2; side++) {
    current = start;
    currentEdge = side === 0 ? edge : oppositeEdgeInQuad(start, edge);
    if (!currentEdge) continue;
    for (let step = 0; step < 100000; step++) {
      const next = edgeFaces(currentEdge).find((candidate) => candidate !== current);
      if (!next || faces.has(next)) break;
      faces.add(next);
      const onward = oppositeEdgeInQuad(next, currentEdge);
      if (!onward) break;
      current = next;
      currentEdge = onward;
    }
  }
  return faces;
}

/** Every element connected to `seed` through shared geometry (Blender's L). */
export function linkedElements(mesh, seed, mode, { seams = false } = {}) {
  const startFaces = mode === "face" ? [seed] : mode === "edge" ? edgeFaces(seed) : vertFaces(seed);
  const faces = new Set(startFaces);
  const queue = [...startFaces];
  while (queue.length) {
    const face = queue.pop();
    for (const loop of face.loops) {
      if (seams && loop.e.seam) continue;
      for (const other of loop.e.loops) {
        if (faces.has(other.f)) continue;
        faces.add(other.f);
        queue.push(other.f);
      }
    }
  }
  if (mode === "face") return faces;
  const result = new Set();
  for (const face of faces) {
    for (const loop of face.loops) result.add(mode === "vert" ? loop.v : loop.e);
  }
  // Wire geometry has no faces to flood through, so walk the edge graph too.
  if (mode !== "face") {
    const verts = new Set(mode === "vert" ? [seed] : [seed.v1, seed.v2]);
    for (const element of result) {
      if (mode === "vert") verts.add(element);
      else {
        verts.add(element.v1);
        verts.add(element.v2);
      }
    }
    const pending = [...verts];
    while (pending.length) {
      const vert = pending.pop();
      for (const edge of vert.edges) {
        if (seams && edge.seam) continue;
        if (mode === "edge") result.add(edge);
        const other = edgeOther(edge, vert);
        if (verts.has(other)) continue;
        verts.add(other);
        if (mode === "vert") result.add(other);
        pending.push(other);
      }
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Grow, shrink, path                                                          */
/* -------------------------------------------------------------------------- */

export function growSelection(mesh, mode) {
  if (mode === "vert") {
    const grown = new Set();
    for (const vert of mesh.verts) {
      if (!vert.select) continue;
      for (const edge of vert.edges) grown.add(edgeOther(edge, vert));
    }
    for (const vert of grown) if (!vert.hide) vert.select = true;
  } else if (mode === "edge") {
    const verts = new Set();
    for (const edge of mesh.edges) {
      if (!edge.select) continue;
      verts.add(edge.v1);
      verts.add(edge.v2);
    }
    for (const vert of verts) for (const edge of vert.edges) if (!edge.hide) edge.select = true;
  } else {
    const grown = new Set();
    for (const face of mesh.faces) {
      if (!face.select) continue;
      for (const loop of face.loops) for (const other of vertFaces(loop.v)) grown.add(other);
    }
    for (const face of grown) if (!face.hide) face.select = true;
  }
  flushSelection(mesh, mode);
}

export function shrinkSelection(mesh, mode) {
  const doomed = new Set();
  if (mode === "vert") {
    for (const vert of mesh.verts) {
      if (!vert.select) continue;
      for (const edge of vert.edges) if (!edgeOther(edge, vert).select) doomed.add(vert);
    }
  } else if (mode === "edge") {
    for (const edge of mesh.edges) {
      if (!edge.select) continue;
      for (const vert of [edge.v1, edge.v2]) {
        if ([...vert.edges].some((other) => !other.select)) doomed.add(edge);
      }
    }
  } else {
    for (const face of mesh.faces) {
      if (!face.select) continue;
      if (faceNeighbours(face).some((other) => !other.select)) doomed.add(face);
      if (face.loops.some((loop) => isBoundaryEdge(loop.e))) doomed.add(face);
    }
  }
  for (const element of doomed) element.select = false;
  flushSelection(mesh, mode);
}

/**
 * Breadth-first path from the current selection to `goal`, walking whichever
 * adjacency the active mode implies. Ctrl+Click in Blender.
 */
export function shortestPath(mesh, mode, goal) {
  const neighbours = (element) => {
    if (mode === "vert") return [...element.edges].map((edge) => edgeOther(edge, element));
    if (mode === "edge") {
      const result = new Set();
      for (const vert of [element.v1, element.v2]) for (const edge of vert.edges) if (edge !== element) result.add(edge);
      return [...result];
    }
    return faceNeighbours(element);
  };
  const starts = selected(mesh, mode).filter((element) => element !== goal);
  if (!starts.length) return new Set([goal]);
  const previous = new Map(starts.map((element) => [element, null]));
  const queue = [...starts];
  for (let head = 0; head < queue.length && !previous.has(goal); head++) {
    for (const next of neighbours(queue[head])) {
      if (next.hide || previous.has(next)) continue;
      previous.set(next, queue[head]);
      queue.push(next);
    }
  }
  if (!previous.has(goal)) return new Set([goal]);
  const path = new Set();
  for (let current = goal; current; current = previous.get(current)) path.add(current);
  return path;
}

/* -------------------------------------------------------------------------- */
/* Select similar / by trait                                                   */
/* -------------------------------------------------------------------------- */

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Blender's Shift+G. `type` depends on the mode; see SIMILAR_TYPES below. */
export function selectSimilar(mesh, mode, type, threshold = 0.01) {
  const sources = selected(mesh, mode);
  if (!sources.length) return 0;
  let matches = 0;
  const near = (a, b) => Math.abs(a - b) <= threshold * Math.max(1, Math.abs(a), Math.abs(b));

  if (mode === "face") {
    const areas = sources.map(faceArea);
    const sides = new Set(sources.map((face) => face.loops.length));
    const materials = new Set(sources.map((face) => face.material));
    const normals = sources.map(faceNormal);
    const perimeters = sources.map((face) => face.loops.reduce((sum, loop) => sum + edgeLength(loop.e), 0));
    for (const face of mesh.faces) {
      if (face.select || face.hide) continue;
      let hit = false;
      if (type === "area") hit = areas.some((value) => near(value, faceArea(face)));
      else if (type === "sides") hit = sides.has(face.loops.length);
      else if (type === "material") hit = materials.has(face.material);
      else if (type === "perimeter") hit = perimeters.some((value) => near(value, face.loops.reduce((sum, loop) => sum + edgeLength(loop.e), 0)));
      else if (type === "normal") hit = normals.some((value) => dot3(value, faceNormal(face)) >= 1 - threshold);
      else if (type === "coplanar") {
        const normal = faceNormal(face);
        const center = faceCenter(face);
        hit = sources.some((source) => {
          const sourceNormal = faceNormal(source);
          if (dot3(sourceNormal, normal) < 1 - threshold) return false;
          const sourceCenter = faceCenter(source);
          const delta = [center[0] - sourceCenter[0], center[1] - sourceCenter[1], center[2] - sourceCenter[2]];
          return Math.abs(dot3(delta, sourceNormal)) <= threshold * 10;
        });
      }
      if (hit) {
        face.select = true;
        matches++;
      }
    }
  } else if (mode === "edge") {
    const lengths = sources.map(edgeLength);
    const angles = sources.map(edgeFaceAngle);
    const valences = new Set(sources.map((edge) => edge.loops.length));
    const directions = sources.map((edge) => {
      const delta = [edge.v2.co[0] - edge.v1.co[0], edge.v2.co[1] - edge.v1.co[1], edge.v2.co[2] - edge.v1.co[2]];
      const size = Math.hypot(...delta) || 1;
      return delta.map((value) => value / size);
    });
    for (const edge of mesh.edges) {
      if (edge.select || edge.hide) continue;
      let hit = false;
      if (type === "length") hit = lengths.some((value) => near(value, edgeLength(edge)));
      else if (type === "faceAngle") hit = angles.some((value) => Math.abs(value - edgeFaceAngle(edge)) <= threshold * Math.PI);
      else if (type === "faces") hit = valences.has(edge.loops.length);
      else if (type === "seam") hit = sources.some((source) => source.seam === edge.seam) && edge.seam;
      else if (type === "sharp") hit = sources.some((source) => source.sharp === edge.sharp) && edge.sharp;
      else if (type === "crease") hit = sources.some((source) => near(source.crease, edge.crease));
      else if (type === "direction") {
        const delta = [edge.v2.co[0] - edge.v1.co[0], edge.v2.co[1] - edge.v1.co[1], edge.v2.co[2] - edge.v1.co[2]];
        const size = Math.hypot(...delta) || 1;
        const unit = delta.map((value) => value / size);
        hit = directions.some((value) => Math.abs(dot3(value, unit)) >= 1 - threshold);
      }
      if (hit) {
        edge.select = true;
        matches++;
      }
    }
  } else {
    const valences = new Set(sources.map((vert) => vert.edges.size));
    const normals = sources.map(vertNormal);
    for (const vert of mesh.verts) {
      if (vert.select || vert.hide) continue;
      let hit = false;
      if (type === "valence") hit = valences.has(vert.edges.size);
      else if (type === "normal") hit = normals.some((value) => dot3(value, vertNormal(vert)) >= 1 - threshold);
      if (hit) {
        vert.select = true;
        matches++;
      }
    }
  }
  flushSelection(mesh, mode);
  return matches;
}

export const SIMILAR_TYPES = {
  vert: [
    { id: "valence", label: "Amount of Connecting Edges" },
    { id: "normal", label: "Normal" },
  ],
  edge: [
    { id: "length", label: "Length" },
    { id: "direction", label: "Direction" },
    { id: "faces", label: "Amount of Faces Around an Edge" },
    { id: "faceAngle", label: "Face Angles" },
    { id: "crease", label: "Crease" },
    { id: "seam", label: "Seam" },
    { id: "sharp", label: "Sharpness" },
  ],
  face: [
    { id: "material", label: "Material" },
    { id: "area", label: "Area" },
    { id: "sides", label: "Polygon Sides" },
    { id: "perimeter", label: "Perimeter" },
    { id: "normal", label: "Normal" },
    { id: "coplanar", label: "Coplanar" },
  ],
};

/** Blender's Select All by Trait, plus the sharp-edge and boundary entries. */
export function selectByTrait(mesh, mode, trait, options = {}) {
  const chosen = [];
  if (trait === "nonManifold") {
    for (const edge of mesh.edges) {
      if (edge.loops.length !== 2) chosen.push(edge);
    }
    for (const vert of mesh.verts) {
      if (vert.edges.size === 0) chosen.push(vert);
      else if ([...vert.edges].some((edge) => edge.loops.length > 2)) chosen.push(vert);
    }
  } else if (trait === "loose") {
    for (const vert of mesh.verts) if (!vert.edges.size) chosen.push(vert);
    for (const edge of mesh.edges) if (isWireEdge(edge)) chosen.push(edge);
  } else if (trait === "interior") {
    for (const face of mesh.faces) {
      if (face.loops.every((loop) => loop.e.loops.length > 2)) chosen.push(face);
    }
  } else if (trait === "boundary") {
    for (const edge of mesh.edges) if (isBoundaryEdge(edge)) chosen.push(edge);
  } else if (trait === "sharp") {
    const limit = options.angle ?? Math.PI / 6;
    for (const edge of mesh.edges) if (isManifoldEdge(edge) && edgeFaceAngle(edge) >= limit) chosen.push(edge);
  } else if (trait === "sides") {
    const sides = options.sides ?? 4;
    const comparison = options.comparison ?? "equal";
    for (const face of mesh.faces) {
      const count = face.loops.length;
      const hit = comparison === "greater" ? count > sides : comparison === "less" ? count < sides : count === sides;
      if (hit) chosen.push(face);
    }
  } else if (trait === "ungrouped") {
    for (const face of mesh.faces) if (!face.material) chosen.push(face);
  }
  const applicable = chosen.filter((element) => {
    if (element.hide) return false;
    if (mode === "vert") return mesh.verts.has(element);
    if (mode === "edge") return mesh.edges.has(element) || mesh.verts.has(element);
    return mesh.faces.has(element) || mesh.edges.has(element) || mesh.verts.has(element);
  });
  for (const element of applicable) element.select = true;
  flushSelection(mesh, mode);
  return applicable.length;
}

/* -------------------------------------------------------------------------- */
/* Checker / random                                                            */
/* -------------------------------------------------------------------------- */

export function checkerDeselect(mesh, mode, { selectedRun = 1, deselectedRun = 1, offset = 0 } = {}) {
  const list = selected(mesh, mode);
  const period = Math.max(1, selectedRun + deselectedRun);
  list.forEach((element, index) => {
    const phase = (index + offset) % period;
    if (phase >= selectedRun) element.select = false;
  });
  flushSelection(mesh, mode);
  return list.length;
}

/**
 * Randomly selects a proportion of the mesh. `random` is injectable so tests
 * and the undo system get a deterministic result.
 */
export function selectRandom(mesh, mode, ratio = 0.5, random = Math.random) {
  let count = 0;
  for (const element of elementsOf(mesh, mode)) {
    if (element.hide) continue;
    if (random() < ratio) {
      element.select = true;
      count++;
    }
  }
  flushSelection(mesh, mode);
  return count;
}

/* -------------------------------------------------------------------------- */
/* Mode switching                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Converts a selection when the user presses 1/2/3.
 *
 * Blender's rule, which surprises people who expect the permissive version: an
 * edge is selected only when *both* its verts were, and a face only when *all*
 * of its verts were. Going the other way is lossless, so it just flushes.
 */
export function convertSelection(mesh, fromMode, toMode) {
  if (fromMode === toMode) return;
  const verts = new Set();
  if (fromMode === "vert") {
    for (const vert of mesh.verts) if (vert.select) verts.add(vert);
  } else if (fromMode === "edge") {
    for (const edge of mesh.edges) {
      if (!edge.select) continue;
      verts.add(edge.v1);
      verts.add(edge.v2);
    }
  } else {
    for (const face of mesh.faces) {
      if (!face.select) continue;
      for (const vert of faceVerts(face)) verts.add(vert);
    }
  }
  clearSelection(mesh);
  for (const vert of verts) vert.select = true;
  if (toMode === "edge") {
    for (const edge of mesh.edges) edge.select = edge.v1.select && edge.v2.select;
  } else if (toMode === "face") {
    for (const face of mesh.faces) face.select = face.loops.every((loop) => loop.v.select);
    for (const edge of mesh.edges) edge.select = edge.v1.select && edge.v2.select;
  }
}

/** Distinct vertices affected by the current selection, for transforms. */
export function selectedVerts(mesh, mode) {
  const verts = new Set();
  if (mode === "face") {
    for (const face of mesh.faces) if (face.select) for (const vert of faceVerts(face)) verts.add(vert);
  } else if (mode === "edge") {
    for (const edge of mesh.edges) {
      if (!edge.select) continue;
      verts.add(edge.v1);
      verts.add(edge.v2);
    }
  } else {
    for (const vert of mesh.verts) if (vert.select) verts.add(vert);
  }
  return [...verts];
}
