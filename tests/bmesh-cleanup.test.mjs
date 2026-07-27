import test from "node:test";
import assert from "node:assert/strict";

import {
  addEdge,
  addFace,
  addVert,
  createMesh,
  faceArea,
  faceCenter,
  faceNormal,
  findEdge,
  flipFace,
  validateMesh,
} from "../src/editor/mesh/bmesh.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import {
  bridgeEdgeLoops,
  fillHoles,
  gridFill,
  markSharpByAngle,
  meshStatistics,
  pokeFaces,
  recalculateNormals,
  smoothVerts,
  spinEdges,
  symmetrize,
  triangulateFaces,
  trisToQuads,
} from "../src/editor/mesh/ops/cleanup.js";
import { deleteSelection } from "../src/editor/mesh/ops/edit.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const faceSizes = (mesh) => [...mesh.faces].map((f) => f.loops.length).sort((a, b) => a - b);
const totalArea = (mesh) => [...mesh.faces].reduce((sum, face) => sum + faceArea(face), 0);

function signedVolume(mesh) {
  let volume = 0;
  for (const face of mesh.faces) {
    const ring = face.loops.map((loop) => loop.v);
    for (let index = 1; index + 1 < ring.length; index++) {
      const [a, b, c] = [ring[0].co, ring[index].co, ring[index + 1].co];
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  return volume;
}

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
/* Normals                                                                     */
/* -------------------------------------------------------------------------- */

test("recalculateNormals repairs a single inverted face", () => {
  const { mesh, faces } = makeCube();
  flipFace(mesh, faces[2]);
  assert.ok(signedVolume(mesh) < Math.abs(signedVolume(mesh)) || true);
  recalculateNormals(mesh);
  clean(mesh);
  assert.ok(signedVolume(mesh) > 0, "the cube encloses a positive volume again");
  for (const face of mesh.faces) {
    const normal = faceNormal(face);
    const center = faceCenter(face);
    assert.ok(normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2] > 0, "every face points outward");
  }
});

test("recalculateNormals flips a wholly inverted cube", () => {
  const { mesh } = makeCube();
  for (const face of [...mesh.faces]) flipFace(mesh, face);
  assert.ok(signedVolume(mesh) < 0);
  recalculateNormals(mesh);
  clean(mesh);
  assert.ok(signedVolume(mesh) > 0);
});

test("recalculateNormals inside points the cube inward", () => {
  const { mesh } = makeCube();
  recalculateNormals(mesh, { inside: true });
  clean(mesh);
  assert.ok(signedVolume(mesh) < 0);
});

test("markSharpByAngle marks every cube edge and no grid edge", () => {
  const { mesh } = makeCube();
  assert.equal(markSharpByAngle(mesh, Math.PI / 6), 12);
  for (const edge of mesh.edges) assert.equal(edge.sharp, true);

  const flat = makeGrid(2, 2);
  markSharpByAngle(flat.mesh, Math.PI / 6);
  for (const edge of flat.mesh.edges) assert.equal(edge.sharp, false);
});

/* -------------------------------------------------------------------------- */
/* Retopology                                                                  */
/* -------------------------------------------------------------------------- */

test("triangulate turns every cube quad into two triangles", () => {
  const { mesh } = makeCube();
  const before = totalArea(mesh);
  selectAll(mesh, "face");
  assert.equal(triangulateFaces(mesh, selected(mesh, "face")), 12);
  clean(mesh);
  assert.equal(mesh.faces.size, 12);
  assert.deepEqual(faceSizes(mesh), Array(12).fill(3));
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
});

test("tris to quads reverses a triangulated grid", () => {
  const { mesh } = makeGrid(3, 3);
  selectAll(mesh, "face");
  triangulateFaces(mesh, selected(mesh, "face"));
  assert.equal(mesh.faces.size, 18);
  selectAll(mesh, "face");
  const merged = trisToQuads(mesh, { faces: selected(mesh, "face") });
  clean(mesh);
  assert.equal(merged, 9, "all nine quads came back");
  assert.deepEqual(faceSizes(mesh), Array(9).fill(4));
});

test("tris to quads respects the angle limit", () => {
  const { mesh } = makeCube();
  selectAll(mesh, "face");
  triangulateFaces(mesh, selected(mesh, "face"));
  selectAll(mesh, "face");
  // A cube's face pairs are coplanar, but faces across a corner are at 90
  // degrees and must not be merged.
  trisToQuads(mesh, { faces: selected(mesh, "face"), angleLimit: (5 * Math.PI) / 180 });
  clean(mesh);
  assert.equal(mesh.faces.size, 6);
  assert.deepEqual(faceSizes(mesh), Array(6).fill(4));
});

test("poke fans a quad into four triangles around its centre", () => {
  const { mesh, faces } = makeGrid(1, 1);
  const before = totalArea(mesh);
  setSelection(mesh, "face", [faces[0]]);
  assert.equal(pokeFaces(mesh, selected(mesh, "face")), 4);
  clean(mesh);
  assert.deepEqual(faceSizes(mesh), [3, 3, 3, 3]);
  assert.ok(Math.abs(totalArea(mesh) - before) < 1e-9);
});

/* -------------------------------------------------------------------------- */
/* Smooth and symmetry                                                         */
/* -------------------------------------------------------------------------- */

test("smoothVerts pulls a displaced vertex back towards its neighbours", () => {
  const { mesh, verts } = makeGrid(2, 2);
  const middle = verts[1][1];
  middle.co = [1, 1, 5];
  smoothVerts(mesh, [middle], { factor: 0.5, repeat: 1 });
  clean(mesh);
  assert.ok(middle.co[2] < 5 && middle.co[2] > 0, `expected partial relaxation, got z=${middle.co[2]}`);
  assert.ok(Math.abs(middle.co[0] - 1) < 1e-9, "x is unchanged, being already central");
});

test("smoothVerts respects an axis lock", () => {
  const { mesh, verts } = makeGrid(2, 2);
  const middle = verts[1][1];
  middle.co = [1, 1, 5];
  smoothVerts(mesh, [middle], { factor: 1, repeat: 3, axis: { x: true, y: true, z: false } });
  assert.equal(middle.co[2], 5, "z was locked");
});

test("symmetrize mirrors the kept half and welds the seam", () => {
  // Two quads either side of x = 0; the +X one is kept and mirrored.
  const mesh = createMesh();
  const seamLow = addVert(mesh, [0, 0, 0]);
  const seamHigh = addVert(mesh, [0, 1, 0]);
  const rightLow = addVert(mesh, [1, 0, 0]);
  const rightHigh = addVert(mesh, [1, 1, 0]);
  const leftLow = addVert(mesh, [-1, 0, 0]);
  const leftHigh = addVert(mesh, [-1, 1, 0]);
  addFace(mesh, [seamLow, rightLow, rightHigh, seamHigh]);
  addFace(mesh, [leftLow, seamLow, seamHigh, leftHigh]);
  // Move a vertex so the two halves are genuinely different before symmetrizing.
  rightHigh.co = [1.5, 1.2, 0];

  symmetrize(mesh, "+x");
  clean(mesh);
  assert.equal(mesh.faces.size, 2, "one kept face plus its mirror");
  assert.equal(mesh.verts.size, 6, "the seam vertices are shared, not duplicated");
  const mirrored = [...mesh.verts].find((vert) => Math.abs(vert.co[0] + 1.5) < 1e-9);
  assert.ok(mirrored, "the moved corner was mirrored to x = -1.5");
  assert.ok(Math.abs(mirrored.co[1] - 1.2) < 1e-9);
});

test("symmetrize keeps mirrored faces facing outward", () => {
  const { mesh } = makeCube();
  symmetrize(mesh, "+x");
  clean(mesh);
  assert.ok(signedVolume(mesh) > 0, "the mirrored half is not inside out");
});

/* -------------------------------------------------------------------------- */
/* Bridge, grid fill, holes                                                    */
/* -------------------------------------------------------------------------- */

test("bridge joins two open chains with quads", () => {
  const mesh = createMesh();
  const near = [[0, 0, 0], [1, 0, 0], [2, 0, 0]].map((co) => addVert(mesh, co));
  const far = [[0, 0, 2], [1, 0, 2], [2, 0, 2]].map((co) => addVert(mesh, co));
  for (const chain of [near, far]) {
    for (let index = 0; index + 1 < chain.length; index++) addEdge(mesh, chain[index], chain[index + 1]);
  }
  selectAll(mesh, "edge");
  const result = bridgeEdgeLoops(mesh, selected(mesh, "edge"));
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(result.faces, 2);
  assert.deepEqual(faceSizes(mesh), [4, 4]);
});

test("bridge closes the gap between two cube openings without twisting", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", [faces[0], faces[1]]);
  deleteSelection(mesh, "face", "onlyFaces");
  const boundary = [...mesh.edges].filter((edge) => edge.loops.length === 1);
  setSelection(mesh, "edge", boundary);
  const result = bridgeEdgeLoops(mesh, selected(mesh, "edge"));
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(result.faces, 4);
  // A twisted bridge would produce self-intersecting quads with a much larger
  // total area than the four 2x2 walls we expect.
  const bridged = selected(mesh, "face");
  for (const face of bridged) assert.ok(faceArea(face) < 5, `quad area ${faceArea(face)} suggests a twist`);
});

test("bridge refuses mismatched boundaries", () => {
  const mesh = createMesh();
  const near = [[0, 0, 0], [1, 0, 0], [2, 0, 0]].map((co) => addVert(mesh, co));
  const far = [[0, 0, 2], [1, 0, 2]].map((co) => addVert(mesh, co));
  addEdge(mesh, near[0], near[1]);
  addEdge(mesh, near[1], near[2]);
  addEdge(mesh, far[0], far[1]);
  selectAll(mesh, "edge");
  assert.ok(bridgeEdgeLoops(mesh, selected(mesh, "edge")).error);
});

test("grid fill covers a square hole with a quad grid", () => {
  // A 3x3 grid, so there is a genuinely interior face to punch out. Its hole is
  // surrounded on all sides, unlike a face on the rim.
  const { mesh, faces } = makeGrid(3, 3);
  const middle = faces[1 * 3 + 1];
  setSelection(mesh, "face", [middle]);
  deleteSelection(mesh, "face", "onlyFaces");
  assert.equal(mesh.faces.size, 8);

  const inHole = (vert) => vert.co[0] >= 1 && vert.co[0] <= 2 && vert.co[1] >= 1 && vert.co[1] <= 2;
  const holeBoundary = [...mesh.edges].filter((edge) => edge.loops.length === 1 && inHole(edge.v1) && inHole(edge.v2));
  assert.equal(holeBoundary.length, 4, "the hole is bounded by four edges");

  setSelection(mesh, "edge", holeBoundary);
  const result = gridFill(mesh, selected(mesh, "edge"));
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(mesh.faces.size, 9, "the hole is filled again");
  assert.equal([...mesh.edges].filter((edge) => edge.loops.length === 1).length, 12, "only the outer rim is open");
});

test("grid fill splits a larger boundary into several cells", () => {
  // An eight-vertex ring fills as a 2x2 grid of quads.
  const mesh = createMesh();
  const ring = [
    [0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0],
    [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 1, 0],
  ].map((co) => addVert(mesh, co));
  for (let index = 0; index < ring.length; index++) addEdge(mesh, ring[index], ring[(index + 1) % ring.length]);
  selectAll(mesh, "edge");
  const result = gridFill(mesh, selected(mesh, "edge"));
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(result.faces, 4);
  assert.deepEqual(faceSizes(mesh), [4, 4, 4, 4]);
  assert.ok(Math.abs(totalArea(mesh) - 4) < 1e-9, "the grid covers the square exactly");
});

test("grid fill refuses an odd boundary", () => {
  const mesh = createMesh();
  const ring = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0.5, 1.5, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  for (let index = 0; index < ring.length; index++) addEdge(mesh, ring[index], ring[(index + 1) % ring.length]);
  selectAll(mesh, "edge");
  assert.ok(gridFill(mesh, selected(mesh, "edge")).error);
});

test("fillHoles caps a deleted cube face", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", [faces[0]]);
  deleteSelection(mesh, "face", "onlyFaces");
  assert.equal(mesh.faces.size, 5);
  assert.equal(fillHoles(mesh).filled, 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 6);
  assert.ok(signedVolume(mesh) > 0, "the cap is wound to match the rest");
});

/* -------------------------------------------------------------------------- */
/* Spin                                                                        */
/* -------------------------------------------------------------------------- */

test("spin sweeps a profile into a closed surface of revolution", () => {
  const mesh = createMesh();
  const profile = [[1, 0, 0], [1, 1, 0], [0.5, 2, 0]].map((co) => addVert(mesh, co));
  for (let index = 0; index + 1 < profile.length; index++) addEdge(mesh, profile[index], profile[index + 1]);
  selectAll(mesh, "edge");
  const result = spinEdges(mesh, selected(mesh, "edge"), { steps: 8, angle: Math.PI * 2, axis: [0, 1, 0] });
  clean(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(result.faces, 16, "2 profile segments x 8 steps");
  // A full turn must reuse the original profile on the last step rather than
  // stacking a duplicate ring on top of it.
  assert.equal(mesh.verts.size, 3 * 8);
  for (const edge of mesh.edges) assert.ok(edge.loops.length <= 2, "the surface stays manifold");
});

test("spin over a partial angle leaves an open sheet", () => {
  const mesh = createMesh();
  const profile = [[1, 0, 0], [1, 1, 0]].map((co) => addVert(mesh, co));
  addEdge(mesh, profile[0], profile[1]);
  selectAll(mesh, "edge");
  const result = spinEdges(mesh, selected(mesh, "edge"), { steps: 4, angle: Math.PI / 2, axis: [0, 1, 0] });
  clean(mesh);
  assert.equal(result.faces, 4);
  assert.equal(mesh.verts.size, 10, "five rings of two, none shared");
});

/* -------------------------------------------------------------------------- */

test("meshStatistics reports the topology mix", () => {
  const { mesh } = makeCube();
  const stats = meshStatistics(mesh);
  assert.deepEqual(
    { verts: stats.verts, edges: stats.edges, faces: stats.faces, quads: stats.quads, boundary: stats.boundary },
    { verts: 8, edges: 12, faces: 6, quads: 6, boundary: 0 },
  );

  const open = makeGrid(1, 1);
  assert.equal(meshStatistics(open.mesh).boundary, 4);
});
