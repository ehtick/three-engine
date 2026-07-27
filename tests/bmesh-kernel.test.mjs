import test from "node:test";
import assert from "node:assert/strict";

import {
  addEdge,
  addFace,
  addVert,
  copyMesh,
  createMesh,
  dissolveEdge,
  dissolveVertEdgeChain,
  edgeFaceAngle,
  faceArea,
  faceCenter,
  faceNormal,
  faceVerts,
  findEdge,
  flipFace,
  isBoundaryEdge,
  isManifoldEdge,
  killFace,
  killVert,
  killWireEdges,
  splitEdge,
  splitFace,
  validateMesh,
  weldVerts,
} from "../src/editor/mesh/bmesh.js";
import { faceTriangles, tessellate, wireSegments } from "../src/editor/mesh/tessellate.js";

/** Unit quad in the XY plane, wound counter-clockwise about +Z. */
function makeQuad() {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  const face = addFace(mesh, verts, { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  return { mesh, verts, face };
}

/** Unit cube centred on the origin, six quads, outward normals. */
function makeCube() {
  const mesh = createMesh();
  const co = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const verts = co.map((point) => addVert(mesh, point));
  const rings = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5], // +X
  ];
  for (const ring of rings) addFace(mesh, ring.map((index) => verts[index]));
  return { mesh, verts };
}

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);

/* -------------------------------------------------------------------------- */

test("addFace builds a closed loop ring with reused edges", () => {
  const { mesh, verts, face } = makeQuad();
  clean(mesh);
  assert.equal(mesh.verts.size, 4);
  assert.equal(mesh.edges.size, 4);
  assert.equal(face.loops.length, 4);
  assert.deepEqual(faceVerts(face), verts);
  for (const edge of mesh.edges) assert.ok(isBoundaryEdge(edge), "a lone quad has only boundary edges");
});

test("addFace rejects degenerate rings instead of corrupting the mesh", () => {
  const mesh = createMesh();
  const a = addVert(mesh, [0, 0, 0]);
  const b = addVert(mesh, [1, 0, 0]);
  assert.equal(addFace(mesh, [a, b]), null, "two corners is not a face");
  assert.equal(addFace(mesh, [a, b, a]), null, "a repeated corner is not a face");
  assert.equal(mesh.faces.size, 0);
});

test("two faces sharing an edge make it manifold, and the edge is shared not duplicated", () => {
  const mesh = createMesh();
  const co = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0]];
  const verts = co.map((point) => addVert(mesh, point));
  addFace(mesh, [verts[0], verts[1], verts[2], verts[3]]);
  addFace(mesh, [verts[1], verts[4], verts[5], verts[2]]);
  clean(mesh);
  assert.equal(mesh.edges.size, 7, "the shared edge is created once");
  const shared = findEdge(verts[1], verts[2]);
  assert.ok(isManifoldEdge(shared));
});

test("cube is valid, closed, and every edge is manifold", () => {
  const { mesh } = makeCube();
  clean(mesh);
  assert.equal(mesh.verts.size, 8);
  assert.equal(mesh.edges.size, 12);
  assert.equal(mesh.faces.size, 6);
  for (const edge of mesh.edges) assert.ok(isManifoldEdge(edge));
});

test("cube face normals point outward", () => {
  const { mesh } = makeCube();
  for (const face of mesh.faces) {
    const normal = faceNormal(face);
    const center = faceCenter(face);
    const dot = normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2];
    assert.ok(dot > 0, `face ${face.id} normal ${normal} faces inward at ${center}`);
  }
});

test("Newell normal survives a non-planar quad where a corner cross product would not", () => {
  const mesh = createMesh();
  // Saddle: opposite corners lifted in opposite directions.
  const verts = [[0, 0, 0.5], [1, 0, -0.5], [1, 1, 0.5], [0, 1, -0.5]].map((co) => addVert(mesh, co));
  const face = addFace(mesh, verts);
  const normal = faceNormal(face);
  assert.ok(Math.abs(normal[2]) > 0.7, `expected a mostly +Z normal, got ${normal}`);
  assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-9, "normal is unit length");
});

test("faceArea matches a known quad and triangle", () => {
  const { face } = makeQuad();
  assert.ok(Math.abs(faceArea(face) - 1) < 1e-9);
  const mesh = createMesh();
  const triangle = addFace(mesh, [[0, 0, 0], [2, 0, 0], [0, 2, 0]].map((co) => addVert(mesh, co)));
  assert.ok(Math.abs(faceArea(triangle) - 2) < 1e-9);
});

/* -------------------------------------------------------------------------- */

test("splitEdge inserts a vert into every adjacent face and interpolates UVs", () => {
  const { mesh, verts, face } = makeQuad();
  const edge = findEdge(verts[0], verts[1]);
  const middle = splitEdge(mesh, edge, 0.5);
  clean(mesh);
  assert.deepEqual(middle.co, [0.5, 0, 0]);
  assert.equal(mesh.faces.size, 1, "splitting an edge does not add faces");
  const rebuilt = [...mesh.faces][0];
  assert.equal(rebuilt.loops.length, 5, "the quad became a pentagon");
  const inserted = rebuilt.loops.find((loop) => loop.v === middle);
  assert.deepEqual(inserted.uv, [0.5, 0], "UV interpolated along the split edge");
  assert.equal(mesh.edges.size, 5);
  void face;
});

test("splitEdge on a shared edge splits both faces and keeps them stitched", () => {
  const mesh = createMesh();
  const co = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0]];
  const verts = co.map((point) => addVert(mesh, point));
  addFace(mesh, [verts[0], verts[1], verts[2], verts[3]]);
  addFace(mesh, [verts[1], verts[4], verts[5], verts[2]]);
  const middle = splitEdge(mesh, findEdge(verts[1], verts[2]), 0.25);
  clean(mesh);
  assert.equal(mesh.faces.size, 2);
  for (const face of mesh.faces) assert.equal(face.loops.length, 5);
  assert.ok(Math.abs(middle.co[1] - 0.25) < 1e-9);
  assert.equal(findEdge(verts[1], middle).loops.length, 2, "both halves stay manifold");
});

test("splitEdge carries edge flags onto both halves", () => {
  const { mesh, verts } = makeQuad();
  const edge = findEdge(verts[0], verts[1]);
  edge.seam = true;
  edge.crease = 0.5;
  const middle = splitEdge(mesh, edge, 0.5);
  for (const half of [findEdge(verts[0], middle), findEdge(middle, verts[1])]) {
    assert.equal(half.seam, true);
    assert.equal(half.crease, 0.5);
  }
});

test("splitFace cuts a quad into two triangles and refuses adjacent corners", () => {
  const { mesh, face } = makeQuad();
  assert.equal(splitFace(mesh, face, 0, 1), null, "adjacent corners would be a sliver");
  const halves = splitFace(mesh, face, 0, 2);
  clean(mesh);
  assert.equal(halves.length, 2);
  assert.equal(mesh.faces.size, 2);
  for (const half of halves) assert.equal(half.loops.length, 3);
  assert.equal(mesh.edges.size, 5, "one new diagonal edge");
});

test("dissolveEdge merges two triangles back into a quad", () => {
  const { mesh, face } = makeQuad();
  splitFace(mesh, face, 0, 2);
  const diagonal = [...mesh.edges].find((edge) => isManifoldEdge(edge));
  const merged = dissolveEdge(mesh, diagonal);
  clean(mesh);
  assert.ok(merged);
  assert.equal(mesh.faces.size, 1);
  assert.equal(merged.loops.length, 4);
  assert.equal(mesh.edges.size, 4);
});

test("dissolveEdge round-trips a cube face split without changing its normal", () => {
  const { mesh } = makeCube();
  const face = [...mesh.faces][0];
  const before = faceNormal(face);
  const [first, second] = splitFace(mesh, face, 0, 2);
  const diagonal = first.loops.map((loop) => loop.e).find((edge) => edge.loops.some((loop) => loop.f === second));
  const merged = dissolveEdge(mesh, diagonal);
  clean(mesh);
  assert.ok(merged);
  const after = faceNormal(merged);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(before[axis] - after[axis]) < 1e-9);
});

test("dissolveEdge refuses a non-manifold edge", () => {
  const { mesh, verts } = makeQuad();
  assert.equal(dissolveEdge(mesh, findEdge(verts[0], verts[1])), null, "boundary edge has one face");
});

test("dissolveVertEdgeChain removes a vert left in the middle of an edge", () => {
  const { mesh, verts } = makeQuad();
  const middle = splitEdge(mesh, findEdge(verts[0], verts[1]), 0.5);
  assert.equal([...mesh.faces][0].loops.length, 5);
  assert.ok(dissolveVertEdgeChain(mesh, middle));
  clean(mesh);
  assert.equal(mesh.verts.size, 4);
  assert.equal([...mesh.faces][0].loops.length, 4);
});

test("weldVerts collapses a quad edge into a triangle", () => {
  const { mesh, verts } = makeQuad();
  weldVerts(mesh, verts[1], verts[0]);
  clean(mesh);
  assert.equal(mesh.verts.size, 3);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 3);
});

test("weldVerts drops a face that collapses below three corners", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts);
  weldVerts(mesh, verts[1], verts[0]);
  clean(mesh);
  assert.equal(mesh.faces.size, 0, "a degenerate triangle is removed, not kept as a sliver");
});

test("flipFace reverses the normal and keeps UVs on their corners", () => {
  const { mesh, face } = makeQuad();
  const before = faceNormal(face);
  const uvBefore = new Map(face.loops.map((loop) => [loop.v, [...loop.uv]]));
  const flipped = flipFace(mesh, face);
  clean(mesh);
  const after = faceNormal(flipped);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(before[axis] + after[axis]) < 1e-9);
  for (const loop of flipped.loops) assert.deepEqual(loop.uv, uvBefore.get(loop.v));
});

test("edgeFaceAngle is zero across a flat pair and 90 degrees on a cube", () => {
  const mesh = createMesh();
  const co = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0]];
  const verts = co.map((point) => addVert(mesh, point));
  addFace(mesh, [verts[0], verts[1], verts[2], verts[3]]);
  addFace(mesh, [verts[1], verts[4], verts[5], verts[2]]);
  assert.ok(edgeFaceAngle(findEdge(verts[1], verts[2])) < 1e-6);

  const cube = makeCube();
  for (const edge of cube.mesh.edges) {
    assert.ok(Math.abs(edgeFaceAngle(edge) - Math.PI / 2) < 1e-6);
  }
});

/* -------------------------------------------------------------------------- */

test("killFace leaves edges behind as wire, killWireEdges cleans them", () => {
  const { mesh, face } = makeQuad();
  killFace(mesh, face);
  clean(mesh);
  assert.equal(mesh.faces.size, 0);
  assert.equal(mesh.edges.size, 4);
  assert.equal(killWireEdges(mesh), 4);
  assert.equal(mesh.edges.size, 0);
  assert.equal(mesh.verts.size, 4, "verts survive their edges");
});

test("killVert removes every edge and face that touched it", () => {
  const { mesh, verts } = makeCube();
  killVert(mesh, verts[0]);
  clean(mesh);
  assert.equal(mesh.verts.size, 7);
  assert.equal(mesh.faces.size, 3, "the three faces at that corner are gone");
  assert.equal(mesh.edges.size, 9);
});

test("copyMesh is a deep copy that shares no element identity", () => {
  const { mesh } = makeCube();
  const { mesh: copy, vertMap, faceMap } = copyMesh(mesh);
  clean(copy);
  assert.equal(copy.verts.size, mesh.verts.size);
  assert.equal(copy.edges.size, mesh.edges.size);
  assert.equal(copy.faces.size, mesh.faces.size);
  for (const vert of mesh.verts) {
    const copied = vertMap.get(vert);
    assert.notEqual(copied, vert);
    assert.deepEqual(copied.co, vert.co);
    assert.notEqual(copied.co, vert.co, "coordinates are not aliased");
  }
  for (const face of mesh.faces) {
    assert.deepEqual(faceVerts(faceMap.get(face)).map((v) => v.co), faceVerts(face).map((v) => v.co));
  }
  // Mutating the copy must not disturb the original.
  killVert(copy, [...copy.verts][0]);
  clean(mesh);
  assert.equal(mesh.faces.size, 6);
});

test("validateMesh reports a corrupted loop index", () => {
  const { mesh, face } = makeQuad();
  face.loops[2].index = 9;
  assert.ok(validateMesh(mesh).some((problem) => problem.includes("stale index")));
});

/* -------------------------------------------------------------------------- */

test("faceTriangles picks the shorter quad diagonal", () => {
  const mesh = createMesh();
  // Corners 0 and 2 are far apart; 1 and 3 are close. Expect the 1-3 split.
  const verts = [[0, 0, 0], [1, 0.4, 0], [3, 0, 0], [1, -0.4, 0]].map((co) => addVert(mesh, co));
  const face = addFace(mesh, verts);
  const triangles = faceTriangles(face);
  assert.equal(triangles.length, 2);
  const usesShortDiagonal = triangles.every((triangle) => triangle.includes(1) || triangle.includes(3));
  assert.ok(usesShortDiagonal);
  assert.ok(triangles.every((triangle) => triangle.includes(1)) || triangles.every((triangle) => triangle.includes(3)));
});

test("faceTriangles ear-clips a concave pentagon without spilling outside it", () => {
  const mesh = createMesh();
  // Arrow head: corner 2 is pushed inward, making the ring concave there.
  const ring = [[0, 0, 0], [2, 0, 0], [1, 1, 0], [2, 2, 0], [0, 2, 0]];
  const face = addFace(mesh, ring.map((co) => addVert(mesh, co)));
  const triangles = faceTriangles(face);
  assert.equal(triangles.length, 3, "an n-gon yields n-2 triangles");
  const total = triangles.reduce((sum, [a, b, c]) => {
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const [cx, cy] = ring[c];
    return sum + Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }, 0);
  // Shoelace area of the concave ring.
  let shoelace = 0;
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    shoelace += ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
  }
  assert.ok(Math.abs(total - Math.abs(shoelace) / 2) < 1e-9, `triangles cover ${total}, polygon is ${Math.abs(shoelace) / 2}`);
});

test("tessellate emits one render vertex per loop and maps triangles back to faces", () => {
  const { mesh } = makeCube();
  const result = tessellate(mesh);
  assert.equal(result.positions.length / 3, 24, "6 quads x 4 corners");
  assert.equal(result.indices.length / 3, 12, "6 quads x 2 triangles");
  assert.equal(result.triFaces.length, 12);
  for (const face of mesh.faces) {
    const range = result.faceTriRange.get(face);
    assert.equal(range.count, 2);
    for (let offset = 0; offset < range.count; offset++) {
      assert.equal(result.triFaces[range.start + offset], face);
    }
  }
});

test("tessellate keeps material groups contiguous", () => {
  const { mesh } = makeCube();
  const faces = [...mesh.faces];
  faces[0].material = 2;
  faces[1].material = 1;
  faces[2].material = 2;
  const result = tessellate(mesh);
  const materials = result.groups.map((group) => group.materialIndex);
  assert.deepEqual(materials, [...materials].sort((a, b) => a - b), "groups are ordered");
  assert.equal(new Set(materials).size, materials.length, "each material appears in exactly one group");
  const covered = result.groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(covered, result.indices.length, "groups cover every index");
});

test("tessellate uses face normals for flat faces and averaged ones for smooth", () => {
  const { mesh } = makeCube();
  for (const face of mesh.faces) face.smooth = false;
  const flat = tessellate(mesh);
  // A flat cube corner has three distinct normals, one per face.
  const flatNormals = new Set();
  for (let vertex = 0; vertex < flat.positions.length / 3; vertex++) {
    flatNormals.add(`${flat.normals[vertex * 3].toFixed(3)},${flat.normals[vertex * 3 + 1].toFixed(3)},${flat.normals[vertex * 3 + 2].toFixed(3)}`);
  }
  assert.equal(flatNormals.size, 6, "one normal per cube face");

  for (const face of mesh.faces) face.smooth = true;
  const smooth = tessellate(mesh);
  const smoothNormals = new Set();
  for (let vertex = 0; vertex < smooth.positions.length / 3; vertex++) {
    smoothNormals.add(`${smooth.normals[vertex * 3].toFixed(3)},${smooth.normals[vertex * 3 + 1].toFixed(3)},${smooth.normals[vertex * 3 + 2].toFixed(3)}`);
  }
  assert.equal(smoothNormals.size, 8, "one averaged normal per cube corner");
});

test("wireSegments emits polygon edges only, never triangulation diagonals", () => {
  const { mesh } = makeCube();
  const wire = wireSegments(mesh);
  assert.equal(wire.edges.length, 12, "a cube has twelve edges, not eighteen");
  assert.equal(wire.positions.length, 12 * 6);
});

test("adding a wire edge does not disturb the faces around it", () => {
  const { mesh, verts } = makeQuad();
  const loose = addVert(mesh, [0.5, 0.5, 1]);
  addEdge(mesh, verts[0], loose);
  clean(mesh);
  assert.equal(mesh.edges.size, 5);
  assert.equal(wireSegments(mesh).edges.length, 5);
  assert.equal(mesh.faces.size, 1);
});
