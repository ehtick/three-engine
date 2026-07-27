/**
 * Turns a BMesh into the triangle buffers the renderer needs.
 *
 * The triangle mesh is a *derived* product here, which is the whole point of
 * the kernel: nothing downstream has to guess which triangles used to be a
 * quad, because the polygon topology is still on the mesh.
 *
 * One render vertex is emitted per loop rather than per vertex. That costs a
 * few more vertices (a cube becomes 24, exactly like `THREE.BoxGeometry`) and
 * buys correct per-corner UVs, correct flat shading, and hard edges — none of
 * which are expressible when a render vertex is shared between faces.
 */

import { faceArea, faceNormal } from "./bmesh.js";

const EPSILON = 1e-12;

/**
 * The normal for one corner of a smooth face.
 *
 * Averaging every face touching the vertex — which is what a plain vertex
 * normal does — is only correct when the whole fan is one smooth surface. A
 * cylinder's rim vertex is shared by the smooth side wall and the flat cap, so
 * averaging tilts the wall's normal into the cap and puts a bright ring around
 * the ends; the same thing happens at any hard edge a modeller marked.
 *
 * So the fan is walked outwards from this corner's own face and stops at
 * anything that is not the same smooth surface: a sharp edge, a boundary or
 * non-manifold edge, or a neighbour that is flat shaded. That is what a
 * smoothing group is, and it is what lets one mesh hold both.
 */
function smoothCornerNormal(loop, cache) {
  const vert = loop.v;
  let groups = cache.get(vert);
  if (!groups) cache.set(vert, (groups = []));
  for (const group of groups) {
    if (group.faces.has(loop.f)) return group.normal;
  }

  const faces = new Set([loop.f]);
  const queue = [loop.f];
  while (queue.length) {
    const face = queue.pop();
    for (const edge of vert.edges) {
      if (edge.sharp || edge.loops.length !== 2) continue;
      const first = edge.loops[0].f;
      const second = edge.loops[1].f;
      if (first !== face && second !== face) continue;
      const other = first === face ? second : first;
      if (!other.smooth || faces.has(other)) continue;
      faces.add(other);
      queue.push(other);
    }
  }

  const normal = [0, 0, 0];
  for (const face of faces) {
    const value = faceNormal(face);
    const weight = faceArea(face);
    normal[0] += value[0] * weight;
    normal[1] += value[1] * weight;
    normal[2] += value[2] * weight;
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  const unit = length < EPSILON ? faceNormal(loop.f) : [normal[0] / length, normal[1] / length, normal[2] / length];
  groups.push({ faces, normal: unit });
  return unit;
}

/** An orthonormal basis whose Z is `normal`, used to flatten a face for ear clipping. */
function planeBasis(normal) {
  const up = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = [
    up[1] * normal[2] - up[2] * normal[1],
    up[2] * normal[0] - up[0] * normal[2],
    up[0] * normal[1] - up[1] * normal[0],
  ];
  const length = Math.hypot(x[0], x[1], x[2]) || 1;
  x[0] /= length;
  x[1] /= length;
  x[2] /= length;
  const y = [
    normal[1] * x[2] - normal[2] * x[1],
    normal[2] * x[0] - normal[0] * x[2],
    normal[0] * x[1] - normal[1] * x[0],
  ];
  return { x, y };
}

const cross2 = (ax, ay, bx, by) => ax * by - ay * bx;

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = cross2(bx - ax, by - ay, px - ax, py - ay);
  const d2 = cross2(cx - bx, cy - by, px - bx, py - by);
  const d3 = cross2(ax - cx, ay - cy, px - cx, py - cy);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/**
 * Ear-clips a polygon given as flattened 2D coordinates, returning triangles as
 * triples of ring positions. Handles concave rings; a ring that cannot be
 * clipped further (self-intersecting input) falls back to a fan so the face
 * still renders instead of vanishing.
 */
function earClip(points) {
  const count = points.length / 2;
  if (count < 3) return [];
  if (count === 3) return [[0, 1, 2]];

  let area = 0;
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    area += points[index * 2] * points[next * 2 + 1] - points[next * 2] * points[index * 2 + 1];
  }
  const clockwise = area < 0;

  const ring = Array.from({ length: count }, (_, index) => index);
  const triangles = [];
  let guard = count * count;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let position = 0; position < ring.length; position++) {
      const previous = ring[(position + ring.length - 1) % ring.length];
      const current = ring[position];
      const next = ring[(position + 1) % ring.length];
      const ax = points[previous * 2];
      const ay = points[previous * 2 + 1];
      const bx = points[current * 2];
      const by = points[current * 2 + 1];
      const cx = points[next * 2];
      const cy = points[next * 2 + 1];
      let turn = cross2(bx - ax, by - ay, cx - bx, cy - by);
      if (clockwise) turn = -turn;
      if (turn <= EPSILON) continue;
      let contains = false;
      for (const candidate of ring) {
        if (candidate === previous || candidate === current || candidate === next) continue;
        if (pointInTriangle(points[candidate * 2], points[candidate * 2 + 1], ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      triangles.push(clockwise ? [previous, next, current] : [previous, current, next]);
      ring.splice(position, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (ring.length === 3) {
    triangles.push(clockwise ? [ring[0], ring[2], ring[1]] : [ring[0], ring[1], ring[2]]);
  } else {
    for (let index = 1; index + 1 < ring.length; index++) triangles.push([ring[0], ring[index], ring[index + 1]]);
  }
  return triangles;
}

/**
 * Triangle fan positions for one face, as indices into its loop ring.
 *
 * A quad picks the shorter diagonal, which is what keeps a bent quad from
 * showing a visible crease along the wrong axis.
 */
export function faceTriangles(face) {
  const count = face.loops.length;
  if (count === 3) return [[0, 1, 2]];
  if (count === 4) {
    const [a, b, c, d] = face.loops.map((loop) => loop.v.co);
    const diagonalAC = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
    const diagonalBD = (b[0] - d[0]) ** 2 + (b[1] - d[1]) ** 2 + (b[2] - d[2]) ** 2;
    return diagonalAC <= diagonalBD ? [[0, 1, 2], [0, 2, 3]] : [[1, 2, 3], [1, 3, 0]];
  }
  const normal = faceNormal(face);
  const { x, y } = planeBasis(normal);
  const points = new Float64Array(count * 2);
  face.loops.forEach((loop, index) => {
    const co = loop.v.co;
    points[index * 2] = co[0] * x[0] + co[1] * x[1] + co[2] * x[2];
    points[index * 2 + 1] = co[0] * y[0] + co[1] * y[1] + co[2] * y[2];
  });
  return earClip(points);
}

/**
 * Builds render buffers plus the maps the editor needs to go from a raycast
 * hit back to the polygon that was actually clicked.
 *
 * Faces are visited in material order so the `groups` array stays contiguous
 * without a second pass.
 */
export function tessellate(mesh) {
  const faces = [...mesh.faces].sort((a, b) => a.material - b.material || a.id - b.id);
  const loopCount = faces.reduce((sum, face) => sum + face.loops.length, 0);
  const positions = new Float32Array(loopCount * 3);
  const uvs = new Float32Array(loopCount * 2);
  const normals = new Float32Array(loopCount * 3);
  const indices = [];
  const groups = [];
  const triFaces = [];
  const loopIndex = new Map();
  const faceTriRange = new Map();

  // vert -> [{ faces, normal }], one entry per smoothing group meeting there.
  const smoothNormals = new Map();

  let vertexCursor = 0;
  let currentMaterial = null;
  let groupStart = 0;
  for (const face of faces) {
    if (currentMaterial === null) currentMaterial = face.material;
    else if (face.material !== currentMaterial) {
      groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex: currentMaterial });
      groupStart = indices.length;
      currentMaterial = face.material;
    }
    const flat = faceNormal(face);
    const base = vertexCursor;
    for (const loop of face.loops) {
      const normal = face.smooth ? smoothCornerNormal(loop, smoothNormals) : flat;
      positions[vertexCursor * 3] = loop.v.co[0];
      positions[vertexCursor * 3 + 1] = loop.v.co[1];
      positions[vertexCursor * 3 + 2] = loop.v.co[2];
      uvs[vertexCursor * 2] = loop.uv[0];
      uvs[vertexCursor * 2 + 1] = loop.uv[1];
      normals[vertexCursor * 3] = normal[0];
      normals[vertexCursor * 3 + 1] = normal[1];
      normals[vertexCursor * 3 + 2] = normal[2];
      loopIndex.set(loop, vertexCursor);
      vertexCursor++;
    }
    const triangleStart = indices.length / 3;
    for (const [a, b, c] of faceTriangles(face)) {
      indices.push(base + a, base + b, base + c);
      triFaces.push(face);
    }
    faceTriRange.set(face, { start: triangleStart, count: indices.length / 3 - triangleStart });
  }
  if (currentMaterial !== null) {
    groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex: currentMaterial });
  }
  return { positions, uvs, normals, indices, groups, triFaces, loopIndex, faceTriRange, faces };
}

/**
 * Line-segment endpoints for the wireframe: one segment per *polygon* edge.
 * Triangulation diagonals are not edges and simply never appear here, which is
 * the entire reason the hidden-diagonal bookkeeping could be deleted.
 */
export function wireSegments(mesh) {
  const positions = new Float32Array(mesh.edges.size * 6);
  const edges = [];
  let cursor = 0;
  for (const edge of mesh.edges) {
    positions[cursor++] = edge.v1.co[0];
    positions[cursor++] = edge.v1.co[1];
    positions[cursor++] = edge.v1.co[2];
    positions[cursor++] = edge.v2.co[0];
    positions[cursor++] = edge.v2.co[1];
    positions[cursor++] = edge.v2.co[2];
    edges.push(edge);
  }
  return { positions, edges };
}
