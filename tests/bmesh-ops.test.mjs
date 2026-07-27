import test from "node:test";
import assert from "node:assert/strict";

import {
  addEdge,
  addFace,
  addVert,
  createMesh,
  faceArea,
  faceNormal,
  faceVerts,
  findEdge,
  isBoundaryEdge,
  splitEdge,
  validateMesh,
} from "../src/editor/mesh/bmesh.js";
import {
  checkerDeselect,
  clearSelection,
  convertSelection,
  edgeLoop,
  edgeRing,
  faceLoop,
  flushSelection,
  growSelection,
  linkedElements,
  selectAll,
  selectByTrait,
  selectSimilar,
  selected,
  selectedVerts,
  setSelection,
  shortestPath,
  shrinkSelection,
} from "../src/editor/mesh/select.js";
import {
  connectVertPath,
  deleteSelection,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  duplicateSelection,
  limitedDissolve,
  makeEdgeFace,
  mergeByDistance,
  mergeSelection,
  ripVerts,
  separateSelection,
  splitSelection,
} from "../src/editor/mesh/ops/edit.js";
import {
  extrudeAlongNormals,
  extrudeEdges,
  extrudeFaceRegion,
  extrudeFacesIndividual,
  extrudeVerts,
  insetFaces,
} from "../src/editor/mesh/ops/extrude.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const faceSizes = (mesh) => [...mesh.faces].map((f) => f.loops.length).sort((a, b) => a - b);

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

/** `columns` x `rows` quad grid in the XY plane, verts addressable by [x][y]. */
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
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

test("flushSelection selects an edge only when both its verts are", () => {
  const { mesh, verts } = makeGrid(2, 1);
  verts[0][0].select = true;
  verts[1][0].select = true;
  flushSelection(mesh, "vert");
  assert.equal(findEdge(verts[0][0], verts[1][0]).select, true);
  assert.equal(findEdge(verts[1][0], verts[1][1]).select, false);
});

test("face mode selection lights the face's own edges and verts", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", [faces[0]]);
  assert.equal(selected(mesh, "edge").length, 4);
  assert.equal(selectedVerts(mesh, "face").length, 4);
});

test("convertSelection to face mode keeps only fully covered faces", () => {
  const { mesh, verts, faces } = makeGrid(2, 2);
  // Select the four corners of exactly one quad.
  for (const vert of faceVerts(faces[0])) vert.select = true;
  verts[2][2].select = true; // a stray corner that completes no face
  convertSelection(mesh, "vert", "face");
  assert.equal(selected(mesh, "face").length, 1);
  assert.equal(selected(mesh, "face")[0], faces[0]);
});

test("edgeLoop walks a full ring around a cube", () => {
  const { mesh, verts } = makeCube();
  const loop = edgeLoop(findEdge(verts[0], verts[1]));
  assert.equal(loop.size, 4, "a cube edge loop is four edges");
  clean(mesh);
});

test("edgeLoop stops at a pole instead of running away", () => {
  const mesh = createMesh();
  // Triangle fan around a centre vert: every spoke ends at a high-valence pole.
  const center = addVert(mesh, [0, 0, 0]);
  const rim = [];
  for (let index = 0; index < 6; index++) {
    const angle = (index / 6) * Math.PI * 2;
    rim.push(addVert(mesh, [Math.cos(angle), Math.sin(angle), 0]));
  }
  for (let index = 0; index < 6; index++) addFace(mesh, [center, rim[index], rim[(index + 1) % 6]]);
  const loop = edgeLoop(findEdge(center, rim[0]));
  assert.ok(loop.size < 6, `expected the loop to terminate at the pole, got ${loop.size} edges`);
});

test("edgeLoop follows the boundary of an open grid", () => {
  const { mesh, verts } = makeGrid(3, 3);
  const loop = edgeLoop(findEdge(verts[0][0], verts[1][0]));
  assert.ok([...loop].every((edge) => isBoundaryEdge(edge)), "a boundary loop stays on the boundary");
  assert.equal(loop.size, 12, "the rim of a 3x3 grid is twelve edges");
  clean(mesh);
});

test("edgeRing crosses quads to the parallel edges", () => {
  const { mesh, verts } = makeGrid(3, 1);
  const ring = edgeRing(findEdge(verts[0][0], verts[0][1]));
  assert.equal(ring.size, 4, "four parallel rungs across a 3-wide strip");
  for (const edge of ring) {
    assert.equal(edge.v1.co[1] !== edge.v2.co[1], true, "every ring member runs along Y");
  }
  clean(mesh);
});

test("faceLoop returns the faces a ring passes through", () => {
  const { mesh, verts, faces } = makeGrid(3, 1);
  const loop = faceLoop(faces[0], findEdge(verts[0][0], verts[0][1]));
  assert.equal(loop.size, 3, "the strip is three quads long");
  clean(mesh);
});

test("linkedElements finds one island and ignores the other", () => {
  const { mesh, faces } = makeGrid(2, 1);
  const island = createMesh();
  void island;
  const far = [[10, 0, 0], [11, 0, 0], [11, 1, 0]].map((co) => addVert(mesh, co));
  const detached = addFace(mesh, far);
  const linked = linkedElements(mesh, faces[0], "face");
  assert.equal(linked.has(detached), false, "the far triangle is a separate island");
  assert.equal(linked.size, 2);
});

test("grow and shrink are inverse on the interior of a grid", () => {
  const { mesh, faces } = makeGrid(4, 4);
  setSelection(mesh, "face", [faces[5]]);
  growSelection(mesh, "face");
  const grown = selected(mesh, "face").length;
  assert.ok(grown > 1);
  shrinkSelection(mesh, "face");
  assert.deepEqual(selected(mesh, "face"), [faces[5]]);
});

test("shortestPath walks between two selected verts", () => {
  const { mesh, verts } = makeGrid(3, 3);
  setSelection(mesh, "vert", [verts[0][0]]);
  const path = shortestPath(mesh, "vert", verts[3][0]);
  assert.equal(path.size, 4, "four verts along the bottom edge");
  assert.ok(path.has(verts[0][0]) && path.has(verts[3][0]));
});

test("selectSimilar by polygon sides finds the other quads", () => {
  const { mesh, faces } = makeGrid(2, 1);
  addFace(mesh, [[5, 0, 0], [6, 0, 0], [6, 1, 0]].map((co) => addVert(mesh, co)));
  setSelection(mesh, "face", [faces[0]]);
  const matches = selectSimilar(mesh, "face", "sides");
  assert.equal(matches, 1, "the second quad matches, the triangle does not");
  assert.equal(selected(mesh, "face").length, 2);
});

test("selectSimilar by material ignores geometry", () => {
  const { mesh, faces } = makeCube();
  faces[0].material = 2;
  faces[3].material = 2;
  setSelection(mesh, "face", [faces[0]]);
  selectSimilar(mesh, "face", "material");
  assert.deepEqual(selected(mesh, "face").sort((a, b) => a.id - b.id), [faces[0], faces[3]].sort((a, b) => a.id - b.id));
});

test("selectByTrait finds boundary edges and non-manifold geometry", () => {
  const { mesh } = makeGrid(2, 2);
  assert.equal(selectByTrait(mesh, "edge", "boundary"), 8, "the rim of a 2x2 grid");
  clearSelection(mesh);
  const closed = makeCube();
  assert.equal(selectByTrait(closed.mesh, "edge", "boundary"), 0, "a closed cube has no boundary");
});

test("selectByTrait finds loose verts and wire edges", () => {
  const { mesh, verts } = makeGrid(1, 1);
  const stray = addVert(mesh, [9, 9, 9]);
  const tip = addVert(mesh, [0, 0, 5]);
  addEdge(mesh, verts[0][0], tip);
  const found = selectByTrait(mesh, "vert", "loose");
  assert.ok(found >= 1);
  assert.equal(stray.select, true);
});

test("selectByTrait by face sides distinguishes triangles from quads", () => {
  const { mesh } = makeGrid(1, 1);
  addFace(mesh, [[5, 0, 0], [6, 0, 0], [6, 1, 0]].map((co) => addVert(mesh, co)));
  assert.equal(selectByTrait(mesh, "face", "sides", { sides: 3 }), 1);
});

test("checkerDeselect drops every other element", () => {
  const { mesh } = makeGrid(4, 1);
  selectAll(mesh, "face");
  assert.equal(selected(mesh, "face").length, 4);
  checkerDeselect(mesh, "face");
  assert.equal(selected(mesh, "face").length, 2);
});

/* -------------------------------------------------------------------------- */
/* Make edge / face                                                            */
/* -------------------------------------------------------------------------- */

test("F joins two loose verts with an edge", () => {
  const mesh = createMesh();
  const a = addVert(mesh, [0, 0, 0]);
  const b = addVert(mesh, [1, 0, 0]);
  setSelection(mesh, "vert", [a, b]);
  const result = makeEdgeFace(mesh, "vert");
  assert.equal(result.created, "edge");
  assert.equal(mesh.edges.size, 1);
  clean(mesh);
});

test("F builds a quad from four selected verts", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  setSelection(mesh, "vert", verts);
  const result = makeEdgeFace(mesh, "vert");
  assert.equal(result.created, "face");
  assert.equal(result.face.loops.length, 4);
  clean(mesh);
});

test("F fills a hole with matching winding", () => {
  const { mesh, faces } = makeCube();
  // Remove one face, then rebuild it from its boundary.
  const ring = faceVerts(faces[0]);
  const expected = faceNormal(faces[0]);
  setSelection(mesh, "face", [faces[0]]);
  deleteSelection(mesh, "face", "onlyFaces");
  setSelection(mesh, "vert", ring);
  const result = makeEdgeFace(mesh, "vert");
  clean(mesh);
  assert.equal(result.created, "face");
  const actual = faceNormal(result.face);
  const dot = actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2];
  assert.ok(dot > 0.99, `refilled face points the wrong way (dot ${dot})`);
});

test("F refuses when a face already spans the selection", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "vert", faceVerts(faces[0]));
  assert.ok(makeEdgeFace(mesh, "vert").error);
});

/* -------------------------------------------------------------------------- */
/* Delete and dissolve                                                         */
/* -------------------------------------------------------------------------- */

test("delete faces removes the geometry those faces exclusively owned", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", [faces[0]]);
  deleteSelection(mesh, "face", "faces");
  clean(mesh);
  assert.equal(mesh.faces.size, 1);
  assert.equal(mesh.verts.size, 4, "the two verts shared with the survivor stay");
});

test("delete only-faces keeps the whole wireframe", () => {
  const { mesh } = makeCube();
  selectAll(mesh, "face");
  deleteSelection(mesh, "face", "onlyFaces");
  clean(mesh);
  assert.equal(mesh.faces.size, 0);
  assert.equal(mesh.edges.size, 12, "edges survive as wire");
  assert.equal(mesh.verts.size, 8);
});

test("delete verts takes their faces with them", () => {
  const { mesh, verts } = makeCube();
  setSelection(mesh, "vert", [verts[0]]);
  deleteSelection(mesh, "vert", "verts");
  clean(mesh);
  assert.equal(mesh.verts.size, 7);
  assert.equal(mesh.faces.size, 3);
});

test("dissolveEdges merges two quads into one", () => {
  const { mesh, verts } = makeGrid(2, 1);
  setSelection(mesh, "edge", [findEdge(verts[1][0], verts[1][1])]);
  assert.equal(dissolveEdges(mesh), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 4, "the redundant mid-edge verts go too");
});

test("dissolveFaces turns a selected region into one n-gon", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", faces);
  assert.equal(dissolveFaces(mesh), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 8, "the border of a 2x2 grid is eight verts");
});

test("dissolveVerts removes an interior vert and merges its fan", () => {
  const { mesh, verts } = makeGrid(2, 2);
  setSelection(mesh, "vert", [verts[1][1]]);
  assert.equal(dissolveVerts(mesh), 1);
  clean(mesh);
  assert.equal(mesh.verts.size, 8);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 8);
});

test("dissolveVerts on a mid-edge vert straightens the edge without losing the face", () => {
  const { mesh, verts, faces } = makeGrid(1, 1);
  const middle = splitEdge(mesh, findEdge(verts[0][0], verts[1][0]), 0.5);
  assert.equal([...mesh.faces][0].loops.length, 5);
  setSelection(mesh, "vert", [middle]);
  dissolveVerts(mesh);
  clean(mesh);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 4);
  void faces;
});

test("limitedDissolve flattens a coplanar triangulation back into a quad", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, [verts[0], verts[1], verts[2]]);
  addFace(mesh, [verts[0], verts[2], verts[3]]);
  selectAll(mesh, "edge");
  assert.equal(limitedDissolve(mesh), 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 1);
  assert.equal([...mesh.faces][0].loops.length, 4);
});

test("limitedDissolve leaves a sharp cube corner alone", () => {
  const { mesh } = makeCube();
  selectAll(mesh, "edge");
  assert.equal(limitedDissolve(mesh), 0, "90 degree edges are past the angle limit");
  assert.equal(mesh.faces.size, 6);
});

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

test("merge at center collapses a quad to one vert", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  mergeSelection(mesh, "face", "center");
  clean(mesh);
  assert.equal(mesh.verts.size, 1);
  assert.equal(mesh.faces.size, 0, "the collapsed face is discarded");
  assert.deepEqual([...mesh.verts][0].co.map((n) => +n.toFixed(4)), [0.5, 0.5, 0]);
});

test("merge at last uses the active vertex position", () => {
  const { mesh, verts } = makeGrid(1, 1);
  const active = verts[1][1];
  setSelection(mesh, "vert", [verts[0][0], active]);
  mergeSelection(mesh, "vert", "last", { active });
  clean(mesh);
  const survivor = [...mesh.verts].find((vert) => vert.select);
  assert.deepEqual(survivor.co, [1, 1, 0]);
});

test("merge collapse handles two islands independently", () => {
  const { mesh, faces } = makeGrid(1, 1);
  const far = [[10, 0, 0], [11, 0, 0], [11, 1, 0], [10, 1, 0]].map((co) => addVert(mesh, co));
  const second = addFace(mesh, far);
  setSelection(mesh, "face", [faces[0], second]);
  const result = mergeSelection(mesh, "face", "collapse");
  clean(mesh);
  assert.equal(result.islands, 2);
  assert.equal(mesh.verts.size, 2, "each island collapsed to its own point");
});

test("mergeByDistance welds coincident verts and rebuilds the shared edge", () => {
  const mesh = createMesh();
  const left = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  const right = [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, left);
  addFace(mesh, right);
  assert.equal(mesh.verts.size, 8, "the two quads start disconnected");
  selectAll(mesh, "vert");
  assert.equal(mergeByDistance(mesh, 0.001), 2);
  clean(mesh);
  assert.equal(mesh.verts.size, 6);
  assert.equal(mesh.faces.size, 2);
  assert.equal(findEdge(...[...mesh.verts].filter((v) => v.co[0] === 1)).loops.length, 2, "the seam is now manifold");
});

/* -------------------------------------------------------------------------- */
/* Rip, split, separate, duplicate                                             */
/* -------------------------------------------------------------------------- */

test("ripVerts tears a shared vertex in two", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const shared = verts[1][0];
  const created = ripVerts(mesh, [shared], [1, 0, 0]);
  clean(mesh);
  assert.equal(created.length, 1);
  assert.equal(mesh.verts.size, 7, "one new vertex");
  assert.equal(mesh.faces.size, 2, "both quads survive, now detached at that corner");
});

test("splitSelection detaches a face without moving it", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", [faces[0]]);
  const before = faceArea(faces[0]);
  splitSelection(mesh, "face");
  clean(mesh);
  assert.equal(mesh.faces.size, 2);
  assert.equal(mesh.verts.size, 8, "the two shared corners were duplicated");
  const split = selected(mesh, "face")[0];
  assert.ok(Math.abs(faceArea(split) - before) < 1e-9, "geometry is unchanged");
});

test("separateSelection moves faces into a fresh mesh", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", [faces[0]]);
  const result = separateSelection(mesh, createMesh);
  clean(mesh);
  clean(result.mesh);
  assert.equal(result.faces, 1);
  assert.equal(mesh.faces.size, 1, "the source keeps the rest");
  assert.equal(result.mesh.faces.size, 1);
  assert.equal(result.mesh.verts.size, 4);
});

test("separateSelection refuses to empty the source mesh", () => {
  const { mesh } = makeGrid(1, 1);
  selectAll(mesh, "face");
  assert.ok(separateSelection(mesh, createMesh).error);
});

test("duplicateSelection copies faces in place and selects the copy", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  const result = duplicateSelection(mesh, "face");
  clean(mesh);
  assert.equal(mesh.faces.size, 2);
  assert.equal(mesh.verts.size, 8);
  assert.equal(selected(mesh, "face").length, 1);
  assert.equal(selected(mesh, "face")[0], result.faces[0]);
});

test("connectVertPath cuts a quad between two opposite corners", () => {
  const { mesh, verts } = makeGrid(1, 1);
  setSelection(mesh, "vert", [verts[0][0], verts[1][1]]);
  assert.equal(connectVertPath(mesh).cuts, 1);
  clean(mesh);
  assert.equal(mesh.faces.size, 2);
  assert.deepEqual(faceSizes(mesh), [3, 3]);
});

/* -------------------------------------------------------------------------- */
/* Extrude and inset                                                           */
/* -------------------------------------------------------------------------- */

test("extruding one cube face makes a box, not a fan of loose quads", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", [faces[1]]);
  const result = extrudeFaceRegion(mesh);
  clean(mesh);
  assert.equal(result.verts.length, 4);
  assert.equal(mesh.faces.size, 10, "6 original - 1 lifted + 1 cap + 4 walls");
  assert.deepEqual(faceSizes(mesh), Array(10).fill(4));
  for (const edge of mesh.edges) assert.equal(edge.loops.length, 2, "the result stays closed");
});

test("extruded region normal points away from the surface", () => {
  const { mesh, faces } = makeCube();
  const expected = faceNormal(faces[1]);
  setSelection(mesh, "face", [faces[1]]);
  const result = extrudeFaceRegion(mesh);
  const dot = result.normal[0] * expected[0] + result.normal[1] * expected[1] + result.normal[2] * expected[2];
  assert.ok(dot > 0.99, `extrude normal ${result.normal} should match the face normal ${expected}`);
});

test("extruding a region shares its interior vertices", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", faces);
  const result = extrudeFaceRegion(mesh);
  clean(mesh);
  assert.equal(result.verts.length, 9, "a 2x2 patch has nine verts, each duplicated once");
  assert.equal(result.faces.length, 4, "the cap is still four connected quads");
  assert.equal(result.walls.length, 8, "the border of the patch is eight edges");
});

test("extruded walls face outward, giving a positive volume box", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", [faces[1]]);
  const result = extrudeFaceRegion(mesh);
  for (const vert of result.verts) vert.co[2] += 1;
  // Signed volume via the divergence theorem: positive means outward normals.
  let volume = 0;
  for (const face of mesh.faces) {
    const ring = faceVerts(face);
    for (let index = 1; index + 1 < ring.length; index++) {
      const [a, b, c] = [ring[0].co, ring[index].co, ring[index + 1].co];
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  assert.ok(volume > 0, `expected outward-facing walls, got signed volume ${volume}`);
});

test("extrudeFacesIndividual gives every face its own cap", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", faces);
  const result = extrudeFacesIndividual(mesh);
  clean(mesh);
  assert.equal(result.faces.length, 6);
  assert.equal(result.verts.length, 24, "each face gets four private verts");
  assert.equal(mesh.faces.size, 30, "6 caps + 24 walls");
});

test("extrudeAlongNormals gives each vertex its own direction", () => {
  const { mesh, faces } = makeCube();
  setSelection(mesh, "face", faces);
  const result = extrudeAlongNormals(mesh);
  clean(mesh);
  assert.equal(result.perVertexOffsets.size, result.verts.length);
  const directions = new Set([...result.perVertexOffsets.values()].map((v) => v.map((n) => n.toFixed(2)).join(",")));
  assert.ok(directions.size > 1, "a closed cube's corners point in different directions");
});

test("extrudeEdges builds a ribbon sharing its interior verts", () => {
  const { mesh, verts } = makeGrid(2, 1);
  setSelection(mesh, "edge", [findEdge(verts[0][1], verts[1][1]), findEdge(verts[1][1], verts[2][1])]);
  const result = extrudeEdges(mesh);
  clean(mesh);
  assert.equal(result.faces.length, 2);
  assert.equal(result.verts.length, 3, "the shared endpoint is duplicated once");
});

test("extrudeVerts creates connected wire edges", () => {
  const mesh = createMesh();
  const start = addVert(mesh, [0, 0, 0]);
  setSelection(mesh, "vert", [start]);
  const result = extrudeVerts(mesh);
  clean(mesh);
  assert.equal(result.verts.length, 1);
  assert.equal(mesh.edges.size, 1);
  assert.equal(findEdge(start, result.verts[0]).loops.length, 0, "a wire edge");
});

test("inset creates an inner face and a ring of border quads", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  const result = insetFaces(mesh);
  clean(mesh);
  assert.equal(result.faces.length, 1);
  assert.equal(mesh.faces.size, 5, "one cap plus four border quads");
  assert.equal(result.verts.length, 4);
});

test("inset offsets travel inward, and applying them shrinks the face", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  const result = insetFaces(mesh);
  const cap = result.faces[0];
  const before = faceArea(cap);
  for (const vert of result.verts) {
    const offset = result.perVertexOffsets.get(vert);
    vert.co = [vert.co[0] + offset[0] * 0.2, vert.co[1] + offset[1] * 0.2, vert.co[2] + offset[2] * 0.2];
  }
  assert.ok(faceArea(cap) < before, "the cap shrank");
  assert.ok(Math.abs(faceArea(cap) - 0.36) < 0.02, `expected roughly 0.6^2, got ${faceArea(cap)}`);
  clean(mesh);
});

test("inset of a region insets the border, not every interior edge", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", faces);
  const result = insetFaces(mesh);
  clean(mesh);
  assert.equal(result.faces.length, 4, "the region keeps its interior subdivision");
  assert.equal(result.verts.length, 8, "only the eight border verts moved inward");
});

test("individual inset insets each face separately", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", faces);
  const result = insetFaces(mesh, faces, { individual: true });
  clean(mesh);
  assert.equal(result.faces.length, 2);
  assert.equal(result.verts.length, 8, "each quad gets its own four inner verts");
});
