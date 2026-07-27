import test from "node:test";
import assert from "node:assert/strict";

import {
  addFace,
  addVert,
  createMesh,
  faceArea,
  faceVerts,
  findEdge,
  validateMesh,
} from "../src/editor/mesh/bmesh.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import { bevelEdges, knifeCut, loopCut, offsetEdgeLoop, subdivideFaces } from "../src/editor/mesh/ops/topology.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const faceSizes = (mesh) => [...mesh.faces].map((f) => f.loops.length).sort((a, b) => a - b);
const totalArea = (mesh) => [...mesh.faces].reduce((sum, face) => sum + faceArea(face), 0);

function makeCube() {
  const mesh = createMesh();
  const co = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const verts = co.map((point) => addVert(mesh, point));
  const rings = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const faces = rings.map((ring) => addFace(mesh, ring.map((index) => verts[index])));
  return { mesh, verts, faces };
}

function makeGrid(columns = 3, rows = 3) {
  const mesh = createMesh();
  const verts = [];
  for (let x = 0; x <= columns; x++) {
    verts[x] = [];
    for (let y = 0; y <= rows; y++) verts[x][y] = addVert(mesh, [x, y, 0]);
  }
  const faces = [];
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < rows; y++) {
      faces.push(addFace(mesh, [verts[x][y], verts[x + 1][y], verts[x + 1][y + 1], verts[x][y + 1]]));
    }
  }
  return { mesh, verts, faces };
}

/* -------------------------------------------------------------------------- */
/* Subdivide                                                                   */
/* -------------------------------------------------------------------------- */

test("subdividing a quad once gives four quads", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 4);
  assert.deepEqual(faceSizes(mesh), [4, 4, 4, 4]);
  assert.equal(mesh.verts.size, 9);
});

test("subdividing a quad with two cuts gives a 3x3 grid", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  subdivideFaces(mesh, selected(mesh, "face"), 2);
  clean(mesh);
  assert.equal(mesh.faces.size, 9, "n cuts gives (n+1)^2 faces, not 4^n");
  assert.equal(mesh.verts.size, 16);
});

test("subdivide preserves total area", () => {
  const { mesh, faces } = makeGrid(1, 1);
  const before = totalArea(mesh);
  setSelection(mesh, "face", [faces[0]]);
  subdivideFaces(mesh, selected(mesh, "face"), 3);
  clean(mesh);
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
});

test("subdivide conforms the neighbour instead of leaving a T-junction", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", [faces[0]]);
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  // The untouched neighbour must have gained the split vertex on the shared edge.
  const neighbour = [...mesh.faces].find((face) => face.loops.length === 5);
  assert.ok(neighbour, "the neighbour became a pentagon rather than keeping a T-junction");
  for (const edge of mesh.edges) {
    assert.ok(edge.loops.length <= 2, "no edge ended up non-manifold");
  }
});

test("subdividing a triangle once gives four triangles", () => {
  const mesh = createMesh();
  const face = addFace(mesh, [[0, 0, 0], [2, 0, 0], [0, 2, 0]].map((co) => addVert(mesh, co)));
  setSelection(mesh, "face", [face]);
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 4);
  assert.deepEqual(faceSizes(mesh), [3, 3, 3, 3]);
  assert.equal(mesh.verts.size, 6);
});

test("subdividing a triangle twice gives nine triangles", () => {
  const mesh = createMesh();
  const face = addFace(mesh, [[0, 0, 0], [3, 0, 0], [0, 3, 0]].map((co) => addVert(mesh, co)));
  const before = totalArea(mesh);
  setSelection(mesh, "face", [face]);
  subdivideFaces(mesh, selected(mesh, "face"), 2);
  clean(mesh);
  assert.equal(mesh.faces.size, 9);
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
});

test("subdividing an n-gon fans it into quads around a centre", () => {
  const mesh = createMesh();
  const ring = [];
  for (let corner = 0; corner < 5; corner++) {
    const angle = (corner / 5) * Math.PI * 2;
    ring.push(addVert(mesh, [Math.cos(angle), Math.sin(angle), 0]));
  }
  const face = addFace(mesh, ring);
  setSelection(mesh, "face", [face]);
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 5, "a pentagon becomes five faces around a centre vert");
});

test("subdividing the whole cube keeps it closed", () => {
  const { mesh } = makeCube();
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 24);
  assert.equal(mesh.verts.size, 26, "8 corners + 12 edge midpoints + 6 face centres");
  for (const edge of mesh.edges) assert.equal(edge.loops.length, 2, "still watertight");
});

/* -------------------------------------------------------------------------- */
/* Loop cut                                                                    */
/* -------------------------------------------------------------------------- */

test("loop cut inserts one ring through a strip", () => {
  const { mesh, verts } = makeGrid(3, 1);
  const seed = findEdge(verts[0][0], verts[0][1]);
  const result = loopCut(mesh, seed, { cuts: 1 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 6, "three quads became six");
  assert.deepEqual(faceSizes(mesh), Array(6).fill(4));
});

test("loop cut around a cube adds a full ring and keeps it closed", () => {
  const { mesh, verts } = makeCube();
  const seed = findEdge(verts[0], verts[4]);
  const result = loopCut(mesh, seed, { cuts: 1 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 10, "four side quads split, two caps become hexagons");
  for (const edge of mesh.edges) assert.equal(edge.loops.length, 2, "the cube is still watertight");
});

test("loop cut preserves total area", () => {
  const { mesh, verts } = makeGrid(3, 1);
  const before = totalArea(mesh);
  loopCut(mesh, findEdge(verts[0][0], verts[0][1]), { cuts: 1 });
  clean(mesh);
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
});

test("loop cut with three cuts inserts three parallel rings", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const result = loopCut(mesh, findEdge(verts[0][0], verts[0][1]), { cuts: 3 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 8, "two quads each split into four");
  assert.deepEqual(faceSizes(mesh), Array(8).fill(4));
});

test("a loop cut follows the topology, where a plane cut would tilt", () => {
  // A tapered strip: the left side spans y 0..2, the right side only y 0..1.
  // The cut must land at the midpoint of *each* side, so its two endpoints sit
  // at different heights. A plane cut perpendicular to the seed edge would
  // instead put both endpoints at the same y and shear across the taper.
  const mesh = createMesh();
  const a = addVert(mesh, [0, 0, 0]);
  const b = addVert(mesh, [0, 2, 0]);
  const c = addVert(mesh, [4, 1, 0]);
  const d = addVert(mesh, [4, 0, 0]);
  addFace(mesh, [a, d, c, b]);
  const result = loopCut(mesh, findEdge(a, b), { cuts: 1 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  const heights = [result.edges[0].v1, result.edges[0].v2]
    .sort((first, second) => first.co[0] - second.co[0])
    .map((vert) => vert.co[1]);
  assert.ok(Math.abs(heights[0] - 1) < 1e-6, `left endpoint y = ${heights[0]}, expected the midpoint 1`);
  assert.ok(Math.abs(heights[1] - 0.5) < 1e-6, `right endpoint y = ${heights[1]}, expected the midpoint 0.5`);
});

test("loop cut slide moves the new loop perpendicular to itself", () => {
  const { mesh, verts } = makeGrid(1, 1);
  // The seed is the left side, so the loop runs across in X and slides in Y.
  // Slide is measured along the seed edge from v1 towards v2, so the expected
  // position is derived from the seed rather than hard-coded: which endpoint is
  // v1 depends on the order the face happened to create the edge in.
  const seed = findEdge(verts[0][0], verts[0][1]);
  const expected = seed.v1.co[1] + (seed.v2.co[1] - seed.v1.co[1]) * 0.75;
  const result = loopCut(mesh, seed, { cuts: 1, slide: 0.5 });
  clean(mesh);
  const y = result.edges[0].v1.co[1];
  assert.ok(Math.abs(y - expected) < 1e-6, `slid cut should sit at y=${expected}, got y=${y}`);
  assert.ok(Math.abs(y - 0.5) > 0.2, "and clearly off centre");
});

test("loop cut refuses a seed that is not in a quad ring", () => {
  const mesh = createMesh();
  const face = addFace(mesh, [[0, 0, 0], [1, 0, 0], [0, 1, 0]].map((co) => addVert(mesh, co)));
  const seed = face.loops[0].e;
  assert.ok(loopCut(mesh, seed, { cuts: 1 }).error);
});

test("offsetEdgeLoop adds a loop either side of the seed", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const result = offsetEdgeLoop(mesh, findEdge(verts[1][0], verts[1][1]), { factor: 0.5 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  // Two loops, each crossing both quads, so four new edges in total.
  assert.equal(result.edges.length, 4, "two loops, two edges each");
  assert.equal(mesh.faces.size, 6, "each of the two quads gained two cuts");
  const heights = result.edges.map((edge) => edge.v1.co[1]).sort((a, b) => a - b);
  assert.ok(heights[0] < 0.5, `a loop below centre, got ${heights}`);
  assert.ok(heights[heights.length - 1] > 0.5, `a loop above centre, got ${heights}`);
});

/* -------------------------------------------------------------------------- */
/* Bevel                                                                       */
/* -------------------------------------------------------------------------- */

test("bevelling one cube edge replaces it with a quad", () => {
  const { mesh, verts } = makeCube();
  const edge = findEdge(verts[0], verts[1]);
  setSelection(mesh, "edge", [edge]);
  const result = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.ok(mesh.faces.size > 6, "the bevel added at least the strip face");
  assert.equal(findEdge(verts[0], verts[1]) === null, true, "the original sharp edge is gone");
});

test("bevel shrinks the adjacent faces rather than growing the mesh", () => {
  const { mesh, verts } = makeCube();
  const before = totalArea(mesh);
  setSelection(mesh, "edge", [findEdge(verts[0], verts[1])]);
  bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  clean(mesh);
  const after = totalArea(mesh);
  assert.ok(after < before * 1.05, `bevel should not balloon the surface: ${before} -> ${after}`);
  assert.ok(after > before * 0.8);
});

test("bevel with segments rounds the profile into several strips", () => {
  const { mesh, verts } = makeCube();
  setSelection(mesh, "edge", [findEdge(verts[0], verts[1])]);
  const single = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });

  const second = makeCube();
  setSelection(second.mesh, "edge", [findEdge(second.verts[0], second.verts[1])]);
  const rounded = bevelEdges(second.mesh, selected(second.mesh, "edge"), { width: 0.2, segments: 4 });
  clean(second.mesh);
  assert.ok(rounded.faces.length > single.faces.length, "more segments means more strip faces");
});

test("bevelling a whole cube corner caps the vertex", () => {
  const { mesh, verts } = makeCube();
  const corner = verts[0];
  const edges = [...corner.edges];
  setSelection(mesh, "edge", edges);
  const result = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  clean(mesh);
  assert.ok(!result.error, result.error);
  // The corner is replaced by a triangular cap plus three strips.
  assert.ok(result.faces.some((face) => face.loops.length === 3), "a cap face was created at the corner");
  assert.equal(mesh.verts.has(corner), false, "the original corner vertex is consumed");
});

test("bevel refuses a boundary edge selection", () => {
  const { mesh, verts } = makeGrid(1, 1);
  setSelection(mesh, "edge", [findEdge(verts[0][0], verts[1][0])]);
  assert.ok(bevelEdges(mesh, selected(mesh, "edge"), { width: 0.1 }).error);
});

/* -------------------------------------------------------------------------- */
/* Knife                                                                       */
/* -------------------------------------------------------------------------- */

test("knife cuts straight across a single quad", () => {
  const { mesh, faces } = makeGrid(1, 1);
  const result = knifeCut(mesh, [[0.5, -0.2, 0], [0.5, 1.2, 0]]);
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 2, "the quad was cut in two");
  assert.deepEqual(faceSizes(mesh), [4, 4]);
  void faces;
});

test("knife preserves area and creates a selected edge", () => {
  const { mesh } = makeGrid(1, 1);
  const before = totalArea(mesh);
  const result = knifeCut(mesh, [[0.3, -0.2, 0], [0.3, 1.2, 0]]);
  clean(mesh);
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
  assert.equal(result.edges.length, 1);
  assert.equal(selected(mesh, "edge").length >= 1, true);
});

test("knife cuts across several faces of a grid", () => {
  const { mesh } = makeGrid(3, 1);
  const result = knifeCut(mesh, [[1.5, -0.2, 0], [1.5, 1.2, 0]]);
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 4, "one of the three quads was split");
});

test("knife polyline makes a multi-segment cut", () => {
  const { mesh } = makeGrid(2, 2);
  const result = knifeCut(mesh, [[0.5, -0.2, 0], [0.5, 1.5, 0], [1.8, 1.5, 0]]);
  clean(mesh);
  assert.ok(result.edges.length >= 2, `expected several cut edges, got ${result.edges.length}`);
  for (const edge of mesh.edges) assert.ok(edge.loops.length <= 2);
});

test("knife needs at least two points", () => {
  const { mesh } = makeGrid(1, 1);
  assert.ok(knifeCut(mesh, [[0, 0, 0]]).error);
});

test("knife leaves faces it does not cross alone", () => {
  const { mesh, faces } = makeGrid(3, 1);
  const untouched = faces[2];
  knifeCut(mesh, [[0.5, -0.2, 0], [0.5, 1.2, 0]]);
  clean(mesh);
  assert.ok(mesh.faces.has(untouched), "the far quad was not disturbed");
  assert.equal(faceVerts(untouched).length, 4);
});
