/**
 * Conversion between the BMesh kernel, `THREE.BufferGeometry`, and the on-disk
 * `.geom` asset.
 *
 * The asset format stays at version 1 and keeps its triangle buffers exactly as
 * the runtime loader expects. Editor topology rides along in an extra
 * `editMesh` block which the runtime ignores, so nothing in `player.html` or in
 * an exported game has to change, older `.geom` files still open, and files
 * written by this editor still load in an older build.
 *
 * When `editMesh` is absent — an imported GLB, or a file written before the
 * kernel landed — polygons are reconstructed once from the triangle buffer and
 * the legacy `hiddenEdges` hint. That reconstruction is a load-time step, not
 * something any operator has to redo.
 */

import * as THREE from "three/webgpu";
import { GEOMETRY_ASSET_VERSION } from "../../engine/geometryAsset.js";
import { addEdge, addFace, addVert, createMesh, faceVerts } from "./bmesh.js";
import { faceTriangles, tessellate } from "./tessellate.js";

const EDIT_MESH_VERSION = 1;
const QUANTUM = 1e5;
const positionKey = (x, y, z) => `${Math.round(x * QUANTUM)},${Math.round(y * QUANTUM)},${Math.round(z * QUANTUM)}`;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Two render vertices at the same position may carry different UVs — that is
 * what a UV seam *is*, and reconstruction welds them into one kernel vertex.
 * Corners on either side of such an edge belong to different islands, so the
 * triangles they belong to must not be fused. Tight, because UVs that came
 * from the same source vertex are bit-identical.
 */
const UV_EPSILON = 1e-6;

/** The UV this triangle gives the corner sitting at `key`, or null. */
function uvAtPosition(triangle, key, vertKeys) {
  if (!triangle.uvs) return null;
  for (let corner = 0; corner < 3; corner++) {
    if (vertKeys[triangle.corners[corner]] === key) return triangle.uvs[corner];
  }
  return null;
}

/**
 * Whether two triangles agree about the UVs at the edge they share.
 *
 * They disagree exactly when that edge is a UV seam. Fusing across it would
 * build one polygon out of two islands, and since a face keeps one UV per
 * corner, one island's coordinates are simply dropped — the faces that used
 * them jump to wherever the surviving island maps them. Nothing downstream can
 * detect that afterwards: the polygon still has a complete, non-degenerate,
 * plausible mapping. It is just the wrong one.
 *
 * A mesh with no UVs at all has nothing to disagree about, so this says yes and
 * the pairing behaves exactly as it did before.
 */
function sharedEdgeUVsAgree(first, second, keyA, keyB, vertKeys) {
  if (!first.uvs || !second.uvs) return true;
  for (const key of [keyA, keyB]) {
    const a = uvAtPosition(first, key, vertKeys);
    const b = uvAtPosition(second, key, vertKeys);
    if (!a || !b) continue;
    if (Math.abs(a[0] - b[0]) > UV_EPSILON || Math.abs(a[1] - b[1]) > UV_EPSILON) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Legacy reconstruction                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Recovers quads from a bare triangle soup.
 *
 * Flood filling across every coplanar edge is wrong here: on a flat surface
 * *all* the interior edges are coplanar, so a 2x2-segmented box side collapses
 * into one big n-gon instead of the four quads it was modelled as. Pairing
 * triangles instead recovers the grid.
 *
 * A pair is scored on two signals. A quad's diagonal is longer than its sides,
 * so a shared edge that is the longest edge of both triangles is very likely
 * the triangulation diagonal; and the merged quad's corners should be close to
 * square. Best pairs are consumed first, and whatever is left stays a triangle.
 */
function pairTrianglesIntoQuads(triangles, vertKeys) {
  const edgeTriangles = new Map();
  triangles.forEach((triangle, index) => {
    for (let corner = 0; corner < 3; corner++) {
      const key = pairKey(vertKeys[triangle.corners[corner]], vertKeys[triangle.corners[(corner + 1) % 3]]);
      if (!edgeTriangles.has(key)) edgeTriangles.set(key, []);
      edgeTriangles.get(key).push({ index, corner });
    }
  });

  // Position by render index, resolved once. This used to be a linear scan of
  // every triangle per lookup, and it is called ~10 times per candidate edge:
  // a 57k-triangle mesh spent nearly two minutes here before Edit Mode opened.
  const positionByIndex = new Map();
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner++) {
      if (!positionByIndex.has(triangle.corners[corner])) {
        positionByIndex.set(triangle.corners[corner], triangle.positions[corner]);
      }
    }
  }
  const positionAt = (vertex) => positionByIndex.get(vertex) ?? null;

  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const candidates = [];
  for (const [, users] of edgeTriangles) {
    if (users.length !== 2) continue;
    const [first, second] = users;
    if (triangles[first.index].material !== triangles[second.index].material) continue;
    const normalA = triangleNormal(triangles[first.index]);
    const normalB = triangleNormal(triangles[second.index]);
    if (normalA[0] * normalB[0] + normalA[1] * normalB[1] + normalA[2] * normalB[2] < 0.9999) continue;
    // Coplanar and same material is not enough: a texture atlas puts an island
    // boundary right down the middle of a flat wall, and those two triangles
    // look like a perfect quad from every angle except the one that matters.
    const sharedA = vertKeys[triangles[first.index].corners[first.corner]];
    const sharedB = vertKeys[triangles[first.index].corners[(first.corner + 1) % 3]];
    if (!sharedEdgeUVsAgree(triangles[first.index], triangles[second.index], sharedA, sharedB, vertKeys)) continue;

    // Ring: walk the first triangle from just past the shared edge, then take
    // the second triangle's opposite corner.
    const ring = [];
    for (let step = 1; step <= 3; step++) ring.push(triangles[first.index].corners[(first.corner + step) % 3]);
    ring.push(triangles[second.index].corners[(second.corner + 2) % 3]);
    if (new Set(ring.map((vertex) => vertKeys[vertex])).size !== 4) continue;

    const points = ring.map(positionAt);
    if (points.some((point) => !point)) continue;
    // The ring is [s1, x, s0, other], so the shared edge joins ring positions 0
    // and 2 — opposite corners, i.e. the candidate quad's diagonal.
    const sharedLength = distance(points[0], points[2]);
    const longestA = Math.max(...[0, 1, 2].map((corner) => distance(
      triangles[first.index].positions[corner],
      triangles[first.index].positions[(corner + 1) % 3],
    )));
    const longestB = Math.max(...[0, 1, 2].map((corner) => distance(
      triangles[second.index].positions[corner],
      triangles[second.index].positions[(corner + 1) % 3],
    )));
    // 0 when the shared edge is the longest edge of both triangles.
    const diagonalPenalty = (longestA - sharedLength) / (longestA || 1) + (longestB - sharedLength) / (longestB || 1);

    let worstCorner = 0;
    for (let index = 0; index < 4; index++) {
      const previous = points[(index + 3) % 4];
      const current = points[index];
      const next = points[(index + 1) % 4];
      const toPrevious = [previous[0] - current[0], previous[1] - current[1], previous[2] - current[2]];
      const toNext = [next[0] - current[0], next[1] - current[1], next[2] - current[2]];
      const lengths = Math.hypot(...toPrevious) * Math.hypot(...toNext) || 1;
      const cosine = (toPrevious[0] * toNext[0] + toPrevious[1] * toNext[1] + toPrevious[2] * toNext[2]) / lengths;
      worstCorner = Math.max(worstCorner, Math.abs(cosine));
    }
    candidates.push({ first: first.index, second: second.index, ring, score: diagonalPenalty * 2 + worstCorner });
  }

  candidates.sort((a, b) => a.score - b.score);
  const consumed = new Set();
  const polygons = [];
  for (const candidate of candidates) {
    if (consumed.has(candidate.first) || consumed.has(candidate.second)) continue;
    consumed.add(candidate.first);
    consumed.add(candidate.second);
    polygons.push({ corners: candidate.ring, material: triangles[candidate.first].material });
  }
  triangles.forEach((triangle, index) => {
    if (!consumed.has(index)) polygons.push({ corners: triangle.corners, material: triangle.material });
  });
  return polygons;
}

/**
 * Whether a polygon was flat shaded in the geometry it came from.
 *
 * `addFace` defaults every face to smooth, and a mesh reconstructed from
 * triangles took that default — so opening a CUBE handed back a cube whose
 * corner normals were the average of the three faces meeting there, 54.7° from
 * where they started. It renders as a soft, inflated, wrongly lit blob the
 * instant you enter Edit Mode, and it is then saved that way.
 *
 * The source already says which it was: a flat-shaded face gives every corner
 * the face's own normal, a smooth one gives each corner something else. So ask
 * it, rather than guessing. Meshes with no normals at all keep the old
 * assumption, which is the right one for a curved surface.
 */
function polygonIsSmooth(corners, positions, normal, tolerance = 0.999) {
  if (!normal) return true;
  const flat = newellNormal(positions);
  if (!flat) return true;
  for (const corner of corners) {
    const dot = normal.getX(corner) * flat[0] + normal.getY(corner) * flat[1] + normal.getZ(corner) * flat[2];
    if (dot < tolerance) return true;
  }
  return false;
}

/** Newell normal of a ring of points; null when the ring has no area. */
function newellNormal(points) {
  const normal = [0, 0, 0];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return length < 1e-12 ? null : [normal[0] / length, normal[1] / length, normal[2] / length];
}

function triangleNormal(triangle) {
  const [a, b, c] = triangle.positions;
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const normal = [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/**
 * Groups triangles into polygons by flood filling across hidden diagonals, then
 * walks each group's boundary into an ordered ring.
 *
 * A group whose boundary does not close into a single cycle is non-manifold or
 * self-touching; those fall back to their individual triangles so the mesh
 * still loads rather than losing faces.
 */
function polygonsFromTriangles(triangles, hidden, vertKeys) {
  const edgeTriangles = new Map();
  triangles.forEach((triangle, index) => {
    for (let corner = 0; corner < 3; corner++) {
      const key = pairKey(vertKeys[triangle.corners[corner]], vertKeys[triangle.corners[(corner + 1) % 3]]);
      if (!edgeTriangles.has(key)) edgeTriangles.set(key, []);
      edgeTriangles.get(key).push(index);
    }
  });

  const groupOf = new Array(triangles.length).fill(-1);
  const groups = [];
  triangles.forEach((_, seed) => {
    if (groupOf[seed] >= 0) return;
    const id = groups.length;
    const members = [];
    const queue = [seed];
    groupOf[seed] = id;
    while (queue.length) {
      const current = queue.pop();
      members.push(current);
      const triangle = triangles[current];
      for (let corner = 0; corner < 3; corner++) {
        const from = vertKeys[triangle.corners[corner]];
        const to = vertKeys[triangle.corners[(corner + 1) % 3]];
        const key = pairKey(from, to);
        if (!hidden.has(key)) continue;
        // Only fuse across a diagonal shared by exactly two triangles. A
        // "hidden" key touching three triangles is ambiguous, and merging there
        // is what used to swallow whole coplanar strips into one polygon.
        const neighbours = edgeTriangles.get(key) ?? [];
        if (neighbours.length !== 2) continue;
        for (const neighbour of neighbours) {
          if (groupOf[neighbour] >= 0) continue;
          // A polygon holds one UV per corner, so a group that spans a UV seam
          // can only keep one side of it. Refusing to cross leaves the two
          // triangles as separate faces, which is the truth about them.
          if (!sharedEdgeUVsAgree(triangle, triangles[neighbour], from, to, vertKeys)) continue;
          groupOf[neighbour] = id;
          queue.push(neighbour);
        }
      }
    }
    groups.push(members);
  });

  const polygons = [];
  for (const members of groups) {
    if (members.length === 1) {
      polygons.push(members[0] === undefined ? null : { corners: triangles[members[0]].corners, material: triangles[members[0]].material });
      continue;
    }
    const inside = new Set(members);
    const boundary = [];
    for (const index of members) {
      const triangle = triangles[index];
      for (let corner = 0; corner < 3; corner++) {
        const from = triangle.corners[corner];
        const to = triangle.corners[(corner + 1) % 3];
        const key = pairKey(vertKeys[from], vertKeys[to]);
        const shared = (edgeTriangles.get(key) ?? []).some((other) => other !== index && inside.has(other));
        if (!shared) boundary.push([from, to]);
      }
    }
    const ring = orderBoundary(boundary, vertKeys);
    if (ring && ring.length >= 3) {
      polygons.push({ corners: ring, material: triangles[members[0]].material });
    } else {
      for (const index of members) polygons.push({ corners: triangles[index].corners, material: triangles[index].material });
    }
  }
  return polygons.filter(Boolean);
}

/** Chains directed boundary edges into a single closed ring, or null. */
function orderBoundary(boundary, vertKeys) {
  if (!boundary.length) return null;
  const bySource = new Map();
  for (const [from, to] of boundary) {
    const key = vertKeys[from];
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push([from, to]);
  }
  const ring = [boundary[0][0]];
  let current = boundary[0][1];
  const used = new Set([`${boundary[0][0]}>${boundary[0][1]}`]);
  for (let step = 0; step < boundary.length; step++) {
    if (vertKeys[current] === vertKeys[ring[0]]) break;
    const candidates = (bySource.get(vertKeys[current]) ?? []).filter(([from, to]) => !used.has(`${from}>${to}`));
    if (!candidates.length) return null;
    const [from, to] = candidates[0];
    used.add(`${from}>${to}`);
    ring.push(current);
    current = to;
  }
  return used.size === boundary.length && vertKeys[current] === vertKeys[ring[0]] ? ring : null;
}

/* -------------------------------------------------------------------------- */
/* BufferGeometry -> BMesh                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds an editable mesh from a render geometry.
 *
 * `geometry.userData.editMesh` is authoritative when present. Otherwise render
 * vertices are welded by position — the same "logical vertex" rule the previous
 * editor used — and polygons are reconstructed from the triangle buffer.
 */
export function meshFromBufferGeometry(geometry) {
  if (geometry.userData?.editMesh) {
    const mesh = meshFromEditMesh(geometry.userData.editMesh);
    if (mesh) return mesh;
  }
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const index = geometry.index;
  const count = position ? position.count : 0;
  const corners = index ? Array.from(index.array) : Array.from({ length: count }, (_, i) => i);

  const materialOf = new Array(corners.length / 3).fill(0);
  for (const group of geometry.groups ?? []) {
    const first = Math.floor(group.start / 3);
    const last = Math.min(materialOf.length, Math.ceil((group.start + group.count) / 3));
    for (let triangle = first; triangle < last; triangle++) materialOf[triangle] = group.materialIndex ?? 0;
  }

  const vertKeys = new Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    vertKeys[vertex] = positionKey(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
  }

  const triangles = [];
  for (let triangle = 0; triangle * 3 < corners.length; triangle++) {
    const ring = [corners[triangle * 3], corners[triangle * 3 + 1], corners[triangle * 3 + 2]];
    if (new Set(ring.map((vertex) => vertKeys[vertex])).size < 3) continue;
    triangles.push({
      corners: ring,
      material: materialOf[triangle] ?? 0,
      positions: ring.map((vertex) => [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]),
      // Carried so reconstruction can refuse to fuse across a UV seam; see
      // `sharedEdgeUVsAgree`. Null for a mesh with no UVs at all.
      uvs: uv ? ring.map((vertex) => [uv.getX(vertex), uv.getY(vertex)]) : null,
    });
  }

  const declared = geometry.userData?.editableHiddenEdges;
  let hidden = null;
  if (Array.isArray(declared)) {
    // The legacy flag is per index pair; a spatial edge only counted as hidden
    // when every index pair representing it was hidden.
    const declaredPairs = new Set(declared.map(([a, b]) => pairKey(a, b)));
    const perSpatial = new Map();
    for (const triangle of triangles) {
      for (let corner = 0; corner < 3; corner++) {
        const a = triangle.corners[corner];
        const b = triangle.corners[(corner + 1) % 3];
        const key = pairKey(vertKeys[a], vertKeys[b]);
        const isHidden = declaredPairs.has(pairKey(a, b));
        perSpatial.set(key, (perSpatial.get(key) ?? true) && isHidden);
      }
    }
    hidden = new Set([...perSpatial].filter(([, value]) => value).map(([key]) => key));
  }

  // With an authored answer, the flood fill across declared diagonals is
  // authoritative. Without one, quads are recovered by pairing triangles.
  const polygons = hidden
    ? polygonsFromTriangles(triangles, hidden, vertKeys)
    : pairTrianglesIntoQuads(triangles, vertKeys);

  const mesh = createMesh();
  const verts = new Map();
  const vertFor = (renderIndex) => {
    const key = vertKeys[renderIndex];
    let vert = verts.get(key);
    if (!vert) {
      vert = addVert(mesh, [position.getX(renderIndex), position.getY(renderIndex), position.getZ(renderIndex)]);
      verts.set(key, vert);
    }
    return vert;
  };
  const normal = geometry.getAttribute("normal");
  for (const polygon of polygons) {
    const ring = polygon.corners.map(vertFor);
    const uvs = uv ? polygon.corners.map((renderIndex) => [uv.getX(renderIndex), uv.getY(renderIndex)]) : null;
    const points = polygon.corners.map((renderIndex) => [
      position.getX(renderIndex), position.getY(renderIndex), position.getZ(renderIndex),
    ]);
    addFace(mesh, ring, {
      material: polygon.material,
      uvs,
      smooth: polygonIsSmooth(polygon.corners, points, normal),
    });
  }
  for (const [a, b] of geometry.userData?.editableEdges ?? []) {
    if (a < count && b < count) addEdge(mesh, vertFor(a), vertFor(b));
  }
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* editMesh block                                                              */
/* -------------------------------------------------------------------------- */

function meshFromEditMesh(block) {
  if (!block || block.version !== EDIT_MESH_VERSION) return null;
  const coordinates = block.verts ?? [];
  if (!Array.isArray(coordinates) || coordinates.length % 3 !== 0) return null;
  const mesh = createMesh();
  const verts = [];
  for (let index = 0; index < coordinates.length; index += 3) {
    verts.push(addVert(mesh, [coordinates[index], coordinates[index + 1], coordinates[index + 2]]));
  }
  const polygons = block.polygons ?? [];
  const loopUVs = block.loopUVs ?? [];
  let cursor = 0;
  let polygonIndex = 0;
  let uvCursor = 0;
  while (cursor < polygons.length) {
    const size = polygons[cursor++];
    if (!Number.isInteger(size) || size < 3 || cursor + size > polygons.length) return null;
    const ring = [];
    for (let corner = 0; corner < size; corner++) {
      const vertex = verts[polygons[cursor++]];
      if (!vertex) return null;
      ring.push(vertex);
    }
    const uvs = [];
    for (let corner = 0; corner < size; corner++) {
      uvs.push([loopUVs[uvCursor] ?? 0, loopUVs[uvCursor + 1] ?? 0]);
      uvCursor += 2;
    }
    addFace(mesh, ring, {
      material: block.polygonMaterials?.[polygonIndex] ?? 0,
      smooth: block.polygonSmooth ? !!block.polygonSmooth[polygonIndex] : true,
      uvs: loopUVs.length ? uvs : null,
    });
    polygonIndex++;
  }
  const wire = block.wireEdges ?? [];
  for (let index = 0; index + 1 < wire.length; index += 2) {
    if (verts[wire[index]] && verts[wire[index + 1]]) addEdge(mesh, verts[wire[index]], verts[wire[index + 1]]);
  }
  const flags = block.edgeFlags ?? [];
  const vertIndex = new Map(verts.map((vert, index) => [vert, index]));
  const byPair = new Map();
  for (const edge of mesh.edges) byPair.set(pairKey(vertIndex.get(edge.v1), vertIndex.get(edge.v2)), edge);
  for (let index = 0; index + 4 < flags.length; index += 5) {
    const edge = byPair.get(pairKey(flags[index], flags[index + 1]));
    if (!edge) continue;
    edge.seam = !!flags[index + 2];
    edge.sharp = !!flags[index + 3];
    edge.crease = flags[index + 4];
  }
  return mesh;
}

function editMeshFromMesh(mesh) {
  const verts = [...mesh.verts];
  const vertIndex = new Map(verts.map((vert, index) => [vert, index]));
  const polygons = [];
  const polygonMaterials = [];
  const polygonSmooth = [];
  const loopUVs = [];
  let anyUV = false;
  for (const face of mesh.faces) {
    polygons.push(face.loops.length);
    for (const loop of face.loops) polygons.push(vertIndex.get(loop.v));
    for (const loop of face.loops) {
      loopUVs.push(loop.uv[0], loop.uv[1]);
      if (loop.uv[0] !== 0 || loop.uv[1] !== 0) anyUV = true;
    }
    polygonMaterials.push(face.material);
    polygonSmooth.push(face.smooth ? 1 : 0);
  }
  const wireEdges = [];
  const edgeFlags = [];
  for (const edge of mesh.edges) {
    if (!edge.loops.length) wireEdges.push(vertIndex.get(edge.v1), vertIndex.get(edge.v2));
    if (edge.seam || edge.sharp || edge.crease) {
      edgeFlags.push(vertIndex.get(edge.v1), vertIndex.get(edge.v2), edge.seam ? 1 : 0, edge.sharp ? 1 : 0, edge.crease);
    }
  }
  return {
    version: EDIT_MESH_VERSION,
    verts: verts.flatMap((vert) => vert.co),
    polygons,
    polygonMaterials,
    polygonSmooth,
    loopUVs: anyUV ? loopUVs : [],
    wireEdges,
    edgeFlags,
  };
}

/* -------------------------------------------------------------------------- */
/* BMesh -> BufferGeometry / asset                                             */
/* -------------------------------------------------------------------------- */

export function bufferGeometryFromMesh(mesh, tessellation = tessellate(mesh)) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(tessellation.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(tessellation.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(tessellation.uvs, 2));
  geometry.setIndex(tessellation.indices);
  for (const group of tessellation.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.userData.editMesh = editMeshFromMesh(mesh);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Serialises to the `.geom` asset shape.
 *
 * The triangle buffers and the legacy `hiddenEdges` list are written so an
 * older build (and the runtime loader, which never learned about polygons) sees
 * exactly what it saw before; `editMesh` carries the exact topology forward.
 */
export function assetFromMesh(mesh) {
  const tessellation = tessellate(mesh);
  const hiddenEdges = [];
  for (const face of tessellation.faces) {
    if (face.loops.length < 4) continue;
    const polygonEdges = new Set(face.loops.map((loop) => pairKey(loop.v.id, face.loops[(loop.index + 1) % face.loops.length].v.id)));
    const renderIndex = face.loops.map((loop) => tessellation.loopIndex.get(loop));
    for (const [a, b, c] of faceTriangles(face)) {
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const key = pairKey(face.loops[from].v.id, face.loops[to].v.id);
        if (polygonEdges.has(key)) continue;
        hiddenEdges.push([renderIndex[from], renderIndex[to]]);
      }
    }
  }
  const wireEdges = [];
  const anyLoopOf = new Map();
  for (const [loop, index] of tessellation.loopIndex) {
    if (!anyLoopOf.has(loop.v)) anyLoopOf.set(loop.v, index);
  }
  const positions = Array.from(tessellation.positions);
  const uvs = Array.from(tessellation.uvs);
  const normals = Array.from(tessellation.normals);
  const appendLoose = (vert) => {
    let index = anyLoopOf.get(vert);
    if (index !== undefined) return index;
    index = positions.length / 3;
    positions.push(...vert.co);
    uvs.push(0, 0);
    normals.push(0, 1, 0);
    anyLoopOf.set(vert, index);
    return index;
  };
  for (const edge of mesh.edges) {
    if (edge.loops.length) continue;
    wireEdges.push(appendLoose(edge.v1), appendLoose(edge.v2));
  }
  for (const vert of mesh.verts) if (!vert.edges.size) appendLoose(vert);

  // Refuse to serialise a broken mesh rather than writing it out.
  //
  // `JSON.stringify` turns NaN into `null`, and the two halves of the file then
  // fail differently: `geometryFromAsset` rejects a null in `positions`, so the
  // asset will not open at all, while `editMesh`'s reader treats a null UV as
  // (0, 0) — so a single bad frame silently flattens the whole UV layout, and
  // the next save writes that flattened layout back as the truth. A mesh whose
  // UVs are "just gone" is what that leaves behind, with nothing in between to
  // say when it happened. Fail loudly at the boundary instead; the caller shows
  // the message and the file on disk stays whatever it last was.
  const bad = positions.findIndex((value) => !Number.isFinite(value));
  if (bad >= 0) throw new Error(`Geometry has a non-finite vertex position (vertex ${Math.floor(bad / 3)}) and was not saved`);
  if (uvs.some((value) => !Number.isFinite(value))) throw new Error("Geometry has a non-finite UV and was not saved");

  return {
    version: GEOMETRY_ASSET_VERSION,
    positions,
    indices: tessellation.indices,
    uvs,
    normals,
    groups: tessellation.groups,
    edges: wireEdges,
    hiddenEdges: hiddenEdges.flat(),
    editMesh: editMeshFromMesh(mesh),
  };
}

/** Convenience for callers that want a plain positions array of every vert. */
export function meshVertPositions(mesh) {
  return [...mesh.verts].map((vert) => vert.co);
}

export { faceVerts };
