import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { findEdge, flipFace, validateMesh } from "../src/editor/mesh/bmesh.js";
import { assetFromMesh, meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { geometryFromAsset } from "../src/engine/geometryAsset.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import { extrudeFaceRegion, insetFaces } from "../src/editor/mesh/ops/extrude.js";
import { bevelEdges, loopCut, subdivideFaces } from "../src/editor/mesh/ops/topology.js";
import { deleteSelection, makeEdgeFace, mergeByDistance } from "../src/editor/mesh/ops/edit.js";
import { meshStatistics, recalculateNormals, triangulateFaces, trisToQuads } from "../src/editor/mesh/ops/cleanup.js";
import { tessellate } from "../src/editor/mesh/tessellate.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const stats = (mesh) => meshStatistics(mesh);

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

/** The exact path the editor takes: save the mesh, then reopen the asset. */
const roundTrip = (mesh) => meshFromBufferGeometry(geometryFromAsset(JSON.parse(JSON.stringify(assetFromMesh(mesh)))));

/* -------------------------------------------------------------------------- */
/* Opening the primitives the editor actually ships                            */
/* -------------------------------------------------------------------------- */

test("a THREE box primitive opens as six quads, not twelve triangles", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  clean(mesh);
  const summary = stats(mesh);
  assert.equal(summary.faces, 6, "the editor should see the cube's six quads");
  assert.equal(summary.quads, 6);
  assert.equal(summary.verts, 8, "the 24 render vertices weld into 8 edit vertices");
  assert.equal(summary.edges, 12);
  assert.equal(summary.boundary, 0, "the cube is closed");
  assert.equal(summary.nonManifold, 0);
});

test("a segmented box opens as a quad grid on every side", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
  clean(mesh);
  const summary = stats(mesh);
  assert.equal(summary.faces, 24, "6 sides x 4 quads");
  assert.equal(summary.quads, 24);
  assert.equal(summary.ngons, 0);
  assert.equal(summary.boundary, 0);
});

test("a plane primitive opens as a quad with a boundary", () => {
  const mesh = meshFromBufferGeometry(new THREE.PlaneGeometry(2, 2));
  clean(mesh);
  assert.equal(stats(mesh).faces, 1);
  assert.equal(stats(mesh).boundary, 4);
});

test("a sphere primitive opens without non-manifold geometry", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 12, 8));
  clean(mesh);
  const summary = stats(mesh);
  assert.equal(summary.nonManifold, 0, "no edge is shared by more than two faces");
  assert.ok(summary.quads > 0, "the quad bands are recovered, not left as triangles");
  assert.ok(summary.faces < 12 * 8 * 2, "fewer faces than the raw triangle count");
});

test("a cylinder primitive opens with recoverable side quads", () => {
  const mesh = meshFromBufferGeometry(new THREE.CylinderGeometry(1, 1, 2, 12));
  clean(mesh);
  const summary = stats(mesh);
  assert.equal(summary.nonManifold, 0);
  assert.ok(summary.quads >= 12, `expected the 12 side quads, got ${summary.quads}`);
});

/* -------------------------------------------------------------------------- */
/* Edit, save, reopen                                                          */
/* -------------------------------------------------------------------------- */

test("a box survives save and reopen unchanged", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  const reopened = roundTrip(mesh);
  clean(reopened);
  assert.deepEqual(stats(reopened), stats(mesh));
});

test("an extruded face survives save and reopen", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const face = [...mesh.faces][0];
  setSelection(mesh, "face", [face]);
  const result = extrudeFaceRegion(mesh);
  for (const vert of result.verts) vert.co = [vert.co[0], vert.co[1], vert.co[2] + 1];
  clean(mesh);

  const before = stats(mesh);
  const reopened = roundTrip(mesh);
  clean(reopened);
  assert.deepEqual(stats(reopened), before, "topology is identical after a save/load cycle");
  assert.equal(stats(reopened).ngons, 0, "the extrusion produced only quads");
});

test("a loop cut survives save and reopen", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const verts = [...mesh.verts];
  const seed = [...mesh.edges][0];
  const result = loopCut(mesh, seed, { cuts: 2 });
  assert.ok(!result.error, result.error);
  clean(mesh);
  const before = stats(mesh);
  const reopened = roundTrip(mesh);
  clean(reopened);
  assert.deepEqual(stats(reopened), before);
  void verts;
});

test("an inset survives save and reopen and keeps its n-gon-free topology", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = insetFaces(mesh);
  for (const vert of result.verts) {
    const offset = result.perVertexOffsets.get(vert);
    vert.co = [vert.co[0] + offset[0] * 0.3, vert.co[1] + offset[1] * 0.3, vert.co[2] + offset[2] * 0.3];
  }
  clean(mesh);
  const before = stats(mesh);
  assert.equal(before.ngons, 0);
  assert.deepEqual(stats(roundTrip(mesh)), before);
});

test("a bevel survives save and reopen", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const edge = [...mesh.edges][0];
  setSelection(mesh, "edge", [edge]);
  const result = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.25, segments: 2 });
  assert.ok(!result.error, result.error);
  clean(mesh);
  assert.deepEqual(stats(roundTrip(mesh)), stats(mesh));
});

test("an n-gon created by dissolving survives save and reopen", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
  // Delete an interior face, then fill the square hole with a single n-gon.
  const target = [...mesh.faces].find((face) => face.loops.every((loop) => loop.e.loops.length === 2));
  setSelection(mesh, "face", [target]);
  const ring = target.loops.map((loop) => loop.v);
  deleteSelection(mesh, "face", "onlyFaces");
  setSelection(mesh, "vert", ring);
  const filled = makeEdgeFace(mesh, "vert");
  assert.ok(!filled.error, filled.error);
  clean(mesh);
  const reopened = roundTrip(mesh);
  clean(reopened);
  assert.deepEqual(stats(reopened), stats(mesh));
});

/* -------------------------------------------------------------------------- */
/* A realistic editing session                                                 */
/* -------------------------------------------------------------------------- */

test("a multi-step edit keeps the mesh valid, closed and correctly wound", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  assert.ok(signedVolume(mesh) > 0, "the primitive starts wound outward");

  // 1. Subdivide the whole thing.
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);

  // 2. Extrude one face outward.
  const face = [...mesh.faces][0];
  setSelection(mesh, "face", [face]);
  const extruded = extrudeFaceRegion(mesh);
  const normal = extruded.normal;
  for (const vert of extruded.verts) {
    vert.co = [vert.co[0] + normal[0] * 0.5, vert.co[1] + normal[1] * 0.5, vert.co[2] + normal[2] * 0.5];
  }
  clean(mesh);

  // 3. Loop cut somewhere else.
  const seed = [...mesh.edges].find((edge) => edge.loops.length === 2 && !edge.v1.select && !edge.v2.select);
  loopCut(mesh, seed, { cuts: 1 });
  clean(mesh);

  const summary = stats(mesh);
  assert.equal(summary.boundary, 0, "the solid is still closed");
  assert.equal(summary.nonManifold, 0, "and still manifold");
  assert.ok(signedVolume(mesh) > 0, "and still wound outward");

  // 4. The whole thing saves and reopens byte-stably.
  const reopened = roundTrip(mesh);
  clean(reopened);
  assert.deepEqual(stats(reopened), summary);
});

test("triangulate then tris-to-quads restores a segmented box", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
  const before = stats(mesh);
  selectAll(mesh, "face");
  triangulateFaces(mesh, selected(mesh, "face"));
  assert.equal(stats(mesh).triangles, before.quads * 2);
  selectAll(mesh, "face");
  trisToQuads(mesh, { faces: selected(mesh, "face") });
  clean(mesh);
  assert.equal(stats(mesh).quads, before.quads, "every quad came back");
  assert.equal(stats(mesh).triangles, 0);
});

test("recalculate normals fixes an imported mesh with mixed winding", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  // Invert a couple of faces, as a badly exported import would arrive.
  for (const face of [...mesh.faces].slice(0, 2)) flipFace(mesh, face);
  recalculateNormals(mesh);
  clean(mesh);
  assert.ok(signedVolume(mesh) > 0, "winding was made consistent and outward");
});

/** Two planes side by side, the right one offset along X by `gap`. */
function twoPlanes(gap) {
  const left = new THREE.PlaneGeometry(1, 1).translate(-0.5, 0, 0);
  const right = new THREE.PlaneGeometry(1, 1).translate(0.5 + gap, 0, 0);
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute([
    ...left.getAttribute("position").array,
    ...right.getAttribute("position").array,
  ], 3));
  const offset = left.getAttribute("position").count;
  merged.setIndex([
    ...Array.from(left.index.array),
    ...Array.from(right.index.array).map((value) => value + offset),
  ]);
  return merged;
}

test("exactly coincident import vertices are welded at load time", () => {
  // Two planes meeting edge to edge. Loading welds render vertices by position,
  // so the seam is already stitched before any operator runs — which is the
  // same "logical vertex" rule the editor has always used for picking.
  const mesh = meshFromBufferGeometry(twoPlanes(0));
  clean(mesh);
  assert.equal(stats(mesh).faces, 2);
  assert.equal(stats(mesh).verts, 6, "the two shared corners welded");
  assert.equal(stats(mesh).boundary, 6, "only the outer rim is open");
  const seam = [...mesh.verts].filter((vert) => Math.abs(vert.co[0]) < 1e-6);
  assert.equal(seam.length, 2);
  assert.equal(findEdge(seam[0], seam[1])?.loops.length, 2, "the seam edge is manifold");
});

test("merge by distance closes a seam that is near but not coincident", () => {
  // A 0.01 gap survives load-time welding, which is exactly the case Merge by
  // Distance exists for.
  const mesh = meshFromBufferGeometry(twoPlanes(0.01));
  clean(mesh);
  assert.equal(stats(mesh).verts, 8, "the halves arrive unwelded");
  assert.equal(stats(mesh).boundary, 8, "and fully open");

  selectAll(mesh, "vert");
  assert.equal(mergeByDistance(mesh, 0.05), 2, "the two near pairs merged");
  clean(mesh);
  assert.equal(stats(mesh).verts, 6);
  assert.equal(stats(mesh).boundary, 6, "the seam stitched together");
  assert.equal(stats(mesh).faces, 2, "both faces survived the weld");
});

test("merge by distance leaves a genuinely separate seam alone", () => {
  const mesh = meshFromBufferGeometry(twoPlanes(0.5));
  selectAll(mesh, "vert");
  assert.equal(mergeByDistance(mesh, 0.05), 0, "a 0.5 gap is well past the threshold");
  clean(mesh);
  assert.equal(stats(mesh).verts, 8);
});

/* -------------------------------------------------------------------------- */
/* Render buffers                                                              */
/* -------------------------------------------------------------------------- */

test("tessellation covers every face and stays in sync with the picking map", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 10, 6));
  const result = tessellate(mesh);
  assert.equal(result.triFaces.length, result.indices.length / 3);
  for (const face of mesh.faces) {
    const range = result.faceTriRange.get(face);
    assert.ok(range, `face ${face.id} has no triangles`);
    assert.equal(range.count, face.loops.length - 2, "an n-gon yields n-2 triangles");
    for (let offset = 0; offset < range.count; offset++) {
      assert.equal(result.triFaces[range.start + offset], face, "picking maps back to the right face");
    }
  }
  const covered = result.groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(covered, result.indices.length);
});

test("every index in the tessellation is inside the vertex buffer", () => {
  const mesh = meshFromBufferGeometry(new THREE.CylinderGeometry(1, 0.5, 2, 8));
  const result = tessellate(mesh);
  const vertexCount = result.positions.length / 3;
  for (const index of result.indices) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < vertexCount, `index ${index} is out of range`);
  }
});
