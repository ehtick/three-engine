/**
 * Dynamic topology: adds and removes detail under the brush as you sculpt.
 *
 * Without this, sculpting is limited by whatever resolution the model already
 * had — dragging on a cube face just moves four corners. Blender solves it by
 * retessellating the brush region every dab, and so does this: edges longer
 * than the detail size are split, edges much shorter are collapsed.
 *
 * Both passes are deliberately budgeted. A dab runs inside a pointer-move
 * handler, so an unbounded refine on a wide brush would stall the drag; the
 * caller gets told how much was done and can keep the budget small.
 */

import { edgeOther, faceNormal, faceVerts, findEdge, splitEdge, weldVerts } from "../bmesh.js";
import { triangulateFaces } from "./cleanup.js";

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const distance3 = (a, b) => length3(sub3(a, b));

/** Closest point to `p` on the segment ab. */
function closestOnSegment(p, a, b) {
  const along = sub3(b, a);
  const lengthSquared = dot3(along, along);
  if (lengthSquared < 1e-18) return [...a];
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), along) / lengthSquared));
  return [a[0] + along[0] * t, a[1] + along[1] * t, a[2] + along[2] * t];
}

/**
 * Whether an edge passes through the brush sphere. The whole segment is
 * tested, not just its endpoints.
 */
function edgeTouchesBrush(edge, center, radius) {
  return distance3(closestOnSegment(center, edge.v1.co, edge.v2.co), center) <= radius;
}

/**
 * Whether any part of a face lies inside the brush sphere.
 *
 * Testing edges alone is not enough: a brush parked in the middle of a large
 * face touches none of its edges, which is precisely the coarse case dyntopo
 * exists to fix. The centre is projected onto the face plane and, if that lands
 * outside the polygon, clamped to the nearest edge.
 */
function faceTouchesBrush(face, center, radius) {
  for (const loop of face.loops) {
    if (distance3(loop.v.co, center) <= radius) return true;
    const next = face.loops[(loop.index + 1) % face.loops.length];
    if (distance3(closestOnSegment(center, loop.v.co, next.v.co), center) <= radius) return true;
  }
  const normal = faceNormal(face);
  const height = dot3(sub3(center, face.loops[0].v.co), normal);
  if (Math.abs(height) > radius) return false;
  const projected = [center[0] - normal[0] * height, center[1] - normal[1] * height, center[2] - normal[2] * height];
  let sign = 0;
  for (const loop of face.loops) {
    const next = face.loops[(loop.index + 1) % face.loops.length];
    const along = sub3(next.v.co, loop.v.co);
    const toPoint = sub3(projected, loop.v.co);
    const side = dot3([
      along[1] * toPoint[2] - along[2] * toPoint[1],
      along[2] * toPoint[0] - along[0] * toPoint[2],
      along[0] * toPoint[1] - along[1] * toPoint[0],
    ], normal);
    if (Math.abs(side) < 1e-12) continue;
    const current = side > 0 ? 1 : -1;
    if (!sign) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/** Every edge belonging to a face under the brush, plus wire edges crossing it. */
function edgesUnderBrush(mesh, center, radius) {
  const edges = new Set();
  for (const face of mesh.faces) {
    if (!faceTouchesBrush(face, center, radius)) continue;
    for (const loop of face.loops) edges.add(loop.e);
  }
  for (const edge of mesh.edges) {
    if (!edge.loops.length && edgeTouchesBrush(edge, center, radius)) edges.add(edge);
  }
  return edges;
}

/**
 * Triangulates the faces under the brush.
 *
 * Dyntopo is a triangle-mesh technique, in Blender too: splitting the edges of
 * a quad only ever adds vertices to its border, so a wide flat face would gain
 * no interior detail no matter how long the stroke. Splitting a triangle's
 * longest edge puts a vertex *inside* the original face, which is what lets a
 * stroke build up geometry where it is actually painting.
 */
export function triangulateUnderBrush(mesh, center, radius) {
  const faces = [...mesh.faces].filter((face) => face.loops.length > 3 && faceTouchesBrush(face, center, radius));
  return faces.length ? triangulateFaces(mesh, faces) : 0;
}

/**
 * Splits edges under the brush that are longer than `detail`.
 *
 * Edges are processed longest first so one pass makes the most difference, and
 * a split edge's halves are not immediately re-split — the next dab picks them
 * up if they are still too long, which spreads the cost over the stroke.
 */
export function refineUnderBrush(mesh, center, radius, detail, { budget = 200 } = {}) {
  const target = Math.max(detail, 1e-5);
  const candidates = [];
  for (const edge of edgesUnderBrush(mesh, center, radius)) {
    const length = distance3(edge.v1.co, edge.v2.co);
    if (length > target) candidates.push({ a: edge.v1, b: edge.v2, length });
  }
  candidates.sort((first, second) => second.length - first.length);

  let split = 0;
  for (const candidate of candidates) {
    if (split >= budget) break;
    if (!mesh.verts.has(candidate.a) || !mesh.verts.has(candidate.b)) continue;
    // Re-find: an earlier split rebuilt the faces around this edge, replacing
    // the edge objects even where the endpoints survived.
    const edge = findEdge(candidate.a, candidate.b);
    if (!edge) continue;
    if (distance3(edge.v1.co, edge.v2.co) <= target) continue;
    splitEdge(mesh, edge, 0.5);
    split++;
  }
  return split;
}

/**
 * Collapses edges under the brush shorter than `detail * ratio`.
 *
 * A collapse is skipped when it would fold a face onto itself — welding two
 * vertices that already share two faces destroys the surface rather than
 * simplifying it.
 */
export function collapseUnderBrush(mesh, center, radius, detail, { ratio = 0.4, budget = 200 } = {}) {
  const target = Math.max(detail, 1e-5) * ratio;
  const candidates = [];
  for (const edge of edgesUnderBrush(mesh, center, radius)) {
    const length = distance3(edge.v1.co, edge.v2.co);
    if (length < target) candidates.push({ a: edge.v1, b: edge.v2, length });
  }
  candidates.sort((first, second) => first.length - second.length);

  let collapsed = 0;
  const consumed = new Set();
  for (const candidate of candidates) {
    if (collapsed >= budget) break;
    if (consumed.has(candidate.a) || consumed.has(candidate.b)) continue;
    if (!mesh.verts.has(candidate.a) || !mesh.verts.has(candidate.b)) continue;
    const edge = findEdge(candidate.a, candidate.b);
    if (!edge) continue;
    if (!isSafeCollapse(edge)) continue;
    const midpoint = [
      (edge.v1.co[0] + edge.v2.co[0]) * 0.5,
      (edge.v1.co[1] + edge.v2.co[1]) * 0.5,
      (edge.v1.co[2] + edge.v2.co[2]) * 0.5,
    ];
    const keep = edge.v1;
    consumed.add(edge.v1);
    consumed.add(edge.v2);
    weldVerts(mesh, edge.v2, keep);
    if (mesh.verts.has(keep)) keep.co = midpoint;
    collapsed++;
  }
  return collapsed;
}

/**
 * The link condition for a safe edge collapse.
 *
 * Welding the endpoints is safe exactly when every vertex they *both* touch is
 * already the third corner of a triangle on this edge; any other shared
 * neighbour would be folded onto itself and pinch the surface shut.
 *
 * Stating it in terms of triangle thirds rather than "two shared neighbours"
 * matters because the latter is the triangle-mesh special case: adjacent
 * vertices of a quad share no neighbour at all, so the narrow form rejected
 * every edge of a quad mesh and dyntopo could never simplify one.
 */
function isSafeCollapse(edge) {
  if (!edge.loops.length) return false;
  const neighboursOf = (vert) => new Set([...vert.edges].map((entry) => edgeOther(entry, vert)));
  const first = neighboursOf(edge.v1);
  const second = neighboursOf(edge.v2);
  const thirds = new Set();
  for (const loop of edge.loops) {
    if (loop.f.loops.length !== 3) continue;
    for (const vert of faceVerts(loop.f)) {
      if (vert !== edge.v1 && vert !== edge.v2) thirds.add(vert);
    }
  }
  for (const vert of first) {
    if (second.has(vert) && !thirds.has(vert)) return false;
  }
  return true;
}

/**
 * One dyntopo pass under the brush. `mode` follows Blender's dyntopo detailing
 * options: subdivide only, collapse only, or both.
 */
export function dyntopoStep(mesh, center, radius, detail, { mode = "both", budget = 200, triangulate = true } = {}) {
  // Triangulate first: see `triangulateUnderBrush` for why edge splitting alone
  // cannot add interior detail to a quad or an n-gon.
  const triangulated = triangulate ? triangulateUnderBrush(mesh, center, radius) : 0;
  let refined = 0;
  let collapsed = 0;
  if (mode === "subdivide" || mode === "both") refined = refineUnderBrush(mesh, center, radius, detail, { budget });
  if (mode === "collapse" || mode === "both") collapsed = collapseUnderBrush(mesh, center, radius, detail, { budget });
  return { triangulated, refined, collapsed, changed: triangulated + refined + collapsed > 0 };
}
