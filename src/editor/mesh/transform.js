/**
 * Transform support for edit mode: orientations, snapping, and the slide
 * operators.
 *
 * Deliberately free of any `three` or DOM dependency — everything here is plain
 * arrays and pure functions, so the geometry that decides where a vertex lands
 * can be unit tested without standing up a renderer. The panel supplies the
 * camera basis and pointer positions; this module never looks them up.
 */

import { edgeOther, faceNormal, faceVerts, vertNormal } from "./bmesh.js";
import { selected, selectedVerts } from "./select.js";
import { falloffWeight } from "../brush.js";

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function normalize3(v) {
  const size = length3(v);
  return size < 1e-12 ? [0, 0, 0] : [v[0] / size, v[1] / size, v[2] / size];
}

/* -------------------------------------------------------------------------- */
/* Orientations                                                                */
/* -------------------------------------------------------------------------- */

export const ORIENTATIONS = [
  { id: "global", label: "Global" },
  { id: "local", label: "Local" },
  { id: "normal", label: "Normal" },
  { id: "view", label: "View" },
];

const IDENTITY_BASIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Completes a right-handed basis from a primary Z and a hint for X. */
function basisFromNormal(normal, hint) {
  const z = normalize3(normal);
  if (!length3(z)) return IDENTITY_BASIS;
  let x = sub3(hint, scale3(z, dot3(hint, z)));
  if (length3(x) < 1e-6) {
    const fallback = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    x = sub3(fallback, scale3(z, dot3(fallback, z)));
  }
  x = normalize3(x);
  return [x, cross3(z, x), z];
}

/**
 * The transform basis for the current selection.
 *
 * "Normal" is the interesting one and the reason this exists: Blender aligns Z
 * with the selection's normal, so extruding or moving along Z follows the
 * surface rather than a world axis. Its secondary axis depends on what is
 * selected — an edge's own direction, or a face's first edge — which is what
 * makes rotating a selected edge about Y behave predictably.
 *
 * `objectBasis` is the entity's world rotation; supply it for "global" so the
 * axes stay world-aligned even when the object is rotated. Edit mode works in
 * local space, so "local" is the identity.
 */
export function orientationBasis(mesh, mode, orientation, { viewBasis = null, objectBasis = null } = {}) {
  if (orientation === "view") return viewBasis ?? IDENTITY_BASIS;
  if (orientation === "global") return objectBasis ? transposeBasis(objectBasis) : IDENTITY_BASIS;
  if (orientation !== "normal") return IDENTITY_BASIS;

  if (mode === "face") {
    const faces = selected(mesh, "face");
    if (!faces.length) return IDENTITY_BASIS;
    const normal = normalize3(faces.reduce((sum, face) => add3(sum, faceNormal(face)), [0, 0, 0]));
    const ring = faceVerts(faces[0]);
    const hint = ring.length >= 2 ? sub3(ring[1].co, ring[0].co) : [1, 0, 0];
    return basisFromNormal(normal, hint);
  }
  if (mode === "edge") {
    const edges = selected(mesh, "edge");
    if (!edges.length) return IDENTITY_BASIS;
    // Blender aligns Y with the edge and Z with the surface it sits in.
    const along = normalize3(edges.reduce((sum, edge) => {
      const direction = sub3(edge.v2.co, edge.v1.co);
      // Flip anti-parallel members so a loop's directions do not cancel out.
      return add3(sum, dot3(sum, direction) < 0 ? scale3(direction, -1) : direction);
    }, sub3(edges[0].v2.co, edges[0].v1.co)));
    const normal = normalize3(edges.reduce((sum, edge) => {
      const faces = edge.loops.map((loop) => faceNormal(loop.f));
      return faces.reduce(add3, sum);
    }, [0, 0, 0]));
    if (!length3(normal)) return basisFromNormal(along, [0, 0, 1]);
    const z = normalize3(normal);
    const y = normalize3(sub3(along, scale3(z, dot3(along, z))));
    if (!length3(y)) return basisFromNormal(z, along);
    return [cross3(y, z), y, z];
  }
  const verts = selectedVerts(mesh, "vert");
  if (!verts.length) return IDENTITY_BASIS;
  const normal = normalize3(verts.reduce((sum, vert) => add3(sum, vertNormal(vert)), [0, 0, 0]));
  return basisFromNormal(normal, [0, 0, 1]);
}

const transposeBasis = (basis) => [
  [basis[0][0], basis[1][0], basis[2][0]],
  [basis[0][1], basis[1][1], basis[2][1]],
  [basis[0][2], basis[1][2], basis[2][2]],
];

/**
 * Resolves a transform constraint into the world-space directions a drag may
 * move along.
 *
 * `axes` is a string such as "x", "xy" or "" (unconstrained). Blender's
 * Shift+X is "every axis except X", which the caller expresses as "yz".
 */
export function constraintAxes(basis, axes) {
  if (!axes) return null;
  const wanted = [];
  if (axes.includes("x")) wanted.push(basis[0]);
  if (axes.includes("y")) wanted.push(basis[1]);
  if (axes.includes("z")) wanted.push(basis[2]);
  return wanted.length ? wanted : null;
}

/** Projects a free translation onto the allowed axes. */
export function constrainTranslation(translation, directions) {
  if (!directions) return translation;
  return directions.reduce((sum, axis) => add3(sum, scale3(axis, dot3(translation, axis))), [0, 0, 0]);
}

/* -------------------------------------------------------------------------- */
/* Pivots                                                                      */
/* -------------------------------------------------------------------------- */

export const PIVOTS = [
  { id: "median", label: "Median Point" },
  { id: "cursor", label: "3D Cursor" },
  { id: "individual", label: "Individual Origins" },
  { id: "active", label: "Active Element" },
  { id: "bounds", label: "Bounding Box Center" },
];

/** The single pivot a transform rotates or scales about. */
export function transformPivot(mesh, mode, pivot, { cursor = [0, 0, 0], active = null } = {}) {
  const verts = selectedVerts(mesh, mode);
  if (!verts.length) return [0, 0, 0];
  if (pivot === "cursor") return [...cursor];
  if (pivot === "active" && active) {
    if (active.co) return [...active.co];
    if (active.loops) return faceVerts(active).reduce((sum, vert) => add3(sum, vert.co), [0, 0, 0]).map((value) => value / active.loops.length);
    if (active.v1) return lerp3(active.v1.co, active.v2.co, 0.5);
  }
  if (pivot === "bounds") {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const vert of verts) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vert.co[axis]);
        max[axis] = Math.max(max[axis], vert.co[axis]);
      }
    }
    return [0, 1, 2].map((axis) => (min[axis] + max[axis]) * 0.5);
  }
  return verts.reduce((sum, vert) => add3(sum, vert.co), [0, 0, 0]).map((value) => value / verts.length);
}

/**
 * Per-vertex pivots for "Individual Origins": every selected face (or edge)
 * scales and rotates about its own centre rather than the shared median.
 */
export function individualPivots(mesh, mode) {
  const pivots = new Map();
  if (mode === "face") {
    for (const face of selected(mesh, "face")) {
      const ring = faceVerts(face);
      const center = ring.reduce((sum, vert) => add3(sum, vert.co), [0, 0, 0]).map((value) => value / ring.length);
      for (const vert of ring) {
        const entry = pivots.get(vert) ?? { sum: [0, 0, 0], count: 0 };
        entry.sum = add3(entry.sum, center);
        entry.count++;
        pivots.set(vert, entry);
      }
    }
  } else if (mode === "edge") {
    for (const edge of selected(mesh, "edge")) {
      const center = lerp3(edge.v1.co, edge.v2.co, 0.5);
      for (const vert of [edge.v1, edge.v2]) {
        const entry = pivots.get(vert) ?? { sum: [0, 0, 0], count: 0 };
        entry.sum = add3(entry.sum, center);
        entry.count++;
        pivots.set(vert, entry);
      }
    }
  } else {
    for (const vert of selectedVerts(mesh, "vert")) pivots.set(vert, { sum: [...vert.co], count: 1 });
  }
  const resolved = new Map();
  for (const [vert, entry] of pivots) resolved.set(vert, scale3(entry.sum, 1 / entry.count));
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Snapping                                                                    */
/* -------------------------------------------------------------------------- */

export const SNAP_MODES = [
  { id: "increment", label: "Increment" },
  { id: "vertex", label: "Vertex" },
  { id: "edge", label: "Edge" },
  { id: "face", label: "Face" },
  { id: "edgeCenter", label: "Edge Center" },
];

/** The point on segment ab closest to p. */
function closestOnSegment(p, a, b) {
  const along = sub3(b, a);
  const lengthSquared = dot3(along, along);
  if (lengthSquared < 1e-18) return [...a];
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), along) / lengthSquared));
  return add3(a, scale3(along, t));
}

/**
 * Finds the nearest snap target to `point`.
 *
 * `moving` is the set of vertices currently being dragged; they are excluded so
 * a selection never snaps to itself. Returns null when nothing is within
 * `radius`, which lets the caller fall back to the free position.
 */
export function snapTarget(mesh, point, { mode = "vertex", radius = 0.25, increment = 0.25, moving = null } = {}) {
  if (mode === "increment") {
    const step = Math.max(increment, 1e-6);
    return { point: point.map((value) => Math.round(value / step) * step), kind: "increment" };
  }
  const skip = moving instanceof Set ? moving : new Set(moving ?? []);
  let best = null;
  const consider = (candidate, kind, element) => {
    const distance = length3(sub3(candidate, point));
    if (distance > radius) return;
    if (!best || distance < best.distance) best = { point: candidate, distance, kind, element };
  };
  if (mode === "vertex") {
    for (const vert of mesh.verts) {
      if (skip.has(vert) || vert.hide) continue;
      consider([...vert.co], "vertex", vert);
    }
  } else if (mode === "edge" || mode === "edgeCenter") {
    for (const edge of mesh.edges) {
      if (edge.hide || skip.has(edge.v1) || skip.has(edge.v2)) continue;
      consider(
        mode === "edgeCenter" ? lerp3(edge.v1.co, edge.v2.co, 0.5) : closestOnSegment(point, edge.v1.co, edge.v2.co),
        mode,
        edge,
      );
    }
  } else if (mode === "face") {
    for (const face of mesh.faces) {
      if (face.hide) continue;
      const ring = faceVerts(face);
      if (ring.some((vert) => skip.has(vert))) continue;
      // Project onto the face plane, then clamp to the polygon by falling back
      // to the nearest boundary point when the projection lands outside it.
      const normal = faceNormal(face);
      const center = ring.reduce((sum, vert) => add3(sum, vert.co), [0, 0, 0]).map((value) => value / ring.length);
      const projected = sub3(point, scale3(normal, dot3(sub3(point, center), normal)));
      let candidate = projected;
      if (!pointInsidePolygon(projected, ring, normal)) {
        let nearest = null;
        for (let index = 0; index < ring.length; index++) {
          const onEdge = closestOnSegment(projected, ring[index].co, ring[(index + 1) % ring.length].co);
          const distance = length3(sub3(onEdge, projected));
          if (!nearest || distance < nearest.distance) nearest = { point: onEdge, distance };
        }
        candidate = nearest.point;
      }
      consider(candidate, "face", face);
    }
  }
  return best;
}

/** Winding test in the face plane. */
function pointInsidePolygon(point, ring, normal) {
  let sign = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index].co;
    const next = ring[(index + 1) % ring.length].co;
    const side = dot3(cross3(sub3(next, current), sub3(point, current)), normal);
    if (Math.abs(side) < 1e-12) continue;
    const current_sign = side > 0 ? 1 : -1;
    if (sign === 0) sign = current_sign;
    else if (sign !== current_sign) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Slide                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Rails for an edge slide: for each vertex of the selected loop, the two
 * neighbouring vertices the loop can slide towards.
 *
 * A rail is an edge at that vertex which is *not* part of the loop but shares a
 * face with it — geometrically, the direction the loop travels when it slides
 * across the surface.
 */
export function edgeSlideRails(mesh, edges = selected(mesh, "edge")) {
  const loop = new Set(edges);
  if (!loop.size) return { error: "Select edges to slide" };
  const verts = new Set();
  for (const edge of loop) {
    verts.add(edge.v1);
    verts.add(edge.v2);
  }
  const rails = new Map();
  for (const vert of verts) {
    const loopEdgesHere = [...vert.edges].filter((edge) => loop.has(edge));
    const facesHere = new Set(loopEdgesHere.flatMap((edge) => edge.loops.map((entry) => entry.f)));
    const candidates = [...vert.edges].filter(
      (edge) => !loop.has(edge) && edge.loops.some((entry) => facesHere.has(entry.f)),
    );
    if (candidates.length < 1) continue;
    const a = edgeOther(candidates[0], vert);
    const b = candidates.length > 1 ? edgeOther(candidates[1], vert) : null;
    rails.set(vert, { origin: [...vert.co], a: [...a.co], b: b ? [...b.co] : [...vert.co] });
  }
  if (!rails.size) return { error: "That selection has nowhere to slide" };
  return { rails };
}

/**
 * Applies a slide. `factor` runs -1..1, moving each vertex from its "a" rail
 * neighbour, through its original position at 0, to its "b" rail neighbour.
 */
export function applySlide(rails, factor) {
  const clamped = Math.max(-1, Math.min(1, factor));
  for (const [vert, rail] of rails) {
    const target = clamped < 0 ? rail.a : rail.b;
    vert.co = lerp3(rail.origin, target, Math.abs(clamped));
  }
  return rails.size;
}

/**
 * Rails for a vertex slide (G G with a single vertex): each connected edge is a
 * direction the vertex can travel along. The caller picks whichever is closest
 * to the pointer.
 */
export function vertSlideRails(vert) {
  const rails = [...vert.edges].map((edge) => ({ edge, target: [...edgeOther(edge, vert).co] }));
  return rails.length ? { origin: [...vert.co], rails } : { error: "That vertex has no edges to slide along" };
}

/** Picks the rail whose screen direction best matches the pointer drag. */
export function pickRail(rails, origin, drag, project) {
  let best = null;
  for (const rail of rails) {
    const screen = sub3(project(rail.target), project(origin));
    const size = Math.hypot(screen[0], screen[1]) || 1;
    const score = (screen[0] * drag[0] + screen[1] * drag[1]) / size;
    if (!best || score > best.score) best = { ...rail, score };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Proportional editing                                                        */
/* -------------------------------------------------------------------------- */

// Proportional editing and the sculpt brushes are the same falloff, so it lives
// in the shared brush core alongside the terrain tools' copy.
export { FALLOFF_CURVES as FALLOFFS, falloffWeight } from "../brush.js";

/**
 * Distance from the selection to every other vertex, for proportional editing.
 *
 * `connected` walks the edge graph (Blender's O-then-Alt, which stops influence
 * leaking to a nearby but topologically distant part of the mesh); otherwise it
 * is plain Euclidean distance. The connected walk is Dijkstra over a binary
 * heap so a dense import does not stall the drag.
 */
export function proportionalDistances(mesh, seeds, { connected = true } = {}) {
  const distances = new Map();
  if (!connected) {
    for (const vert of mesh.verts) {
      let best = Infinity;
      for (const seed of seeds) best = Math.min(best, length3(sub3(vert.co, seed.co)));
      distances.set(vert, best);
    }
    return distances;
  }
  const heap = [];
  const push = (entry) => {
    heap.push(entry);
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (heap[parent][0] <= heap[index][0]) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
        if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return top;
  };
  for (const seed of seeds) {
    distances.set(seed, 0);
    push([0, seed]);
  }
  while (heap.length) {
    const [distance, vert] = pop();
    if (distance > (distances.get(vert) ?? Infinity)) continue;
    for (const edge of vert.edges) {
      const next = edgeOther(edge, vert);
      const candidate = distance + length3(sub3(next.co, vert.co));
      if (candidate >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, candidate);
      push([candidate, next]);
    }
  }
  return distances;
}
