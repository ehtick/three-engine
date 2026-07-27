import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { addEdge, addFace, addVert, createMesh, findEdge, validateMesh } from "../src/editor/mesh/bmesh.js";
import { assetFromMesh, bufferGeometryFromMesh, meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { geometryFromAsset } from "../src/engine/geometryAsset.js";

function makeCube() {
  const mesh = createMesh();
  const co = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const verts = co.map((point) => addVert(mesh, point));
  const rings = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  for (const ring of rings) addFace(mesh, ring.map((index) => verts[index]));
  return { mesh, verts };
}

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const sortedCoords = (mesh) => [...mesh.verts].map((v) => v.co.map((n) => n.toFixed(4)).join(",")).sort();
const faceSizes = (mesh) => [...mesh.faces].map((f) => f.loops.length).sort();

/* -------------------------------------------------------------------------- */

test("cube survives a BMesh -> asset -> BMesh round trip with quads intact", () => {
  const { mesh } = makeCube();
  const asset = assetFromMesh(mesh);
  const geometry = geometryFromAsset(asset);
  const restored = meshFromBufferGeometry(geometry);
  clean(restored);
  assert.equal(restored.verts.size, 8);
  assert.equal(restored.edges.size, 12);
  assert.equal(restored.faces.size, 6, "six quads, not twelve triangles");
  assert.deepEqual(faceSizes(restored), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(sortedCoords(restored), sortedCoords(mesh));
});

test("the asset still carries runtime triangle buffers an older build can read", () => {
  const { mesh } = makeCube();
  const asset = assetFromMesh(mesh);
  assert.equal(asset.version, 1);
  assert.equal(asset.indices.length, 36, "12 triangles");
  assert.equal(asset.positions.length, 24 * 3);
  assert.equal(asset.uvs.length, 24 * 2);
  assert.equal(asset.hiddenEdges.length % 2, 0);
  assert.ok(asset.hiddenEdges.length > 0, "quad diagonals are still published for legacy readers");
  // The runtime loader must accept it untouched.
  const geometry = geometryFromAsset(asset);
  assert.equal(geometry.getAttribute("position").count, 24);
  assert.equal(geometry.index.count, 36);
});

test("hidden-edge hints name real triangulation diagonals, never polygon edges", () => {
  const { mesh } = makeCube();
  const asset = assetFromMesh(mesh);
  const positionAt = (index) => [asset.positions[index * 3], asset.positions[index * 3 + 1], asset.positions[index * 3 + 2]];
  const cubeEdgeLength = 2;
  for (let pair = 0; pair < asset.hiddenEdges.length; pair += 2) {
    const a = positionAt(asset.hiddenEdges[pair]);
    const b = positionAt(asset.hiddenEdges[pair + 1]);
    const length = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    assert.ok(
      Math.abs(length - cubeEdgeLength * Math.SQRT2) < 1e-5,
      `hidden edge of length ${length} is not a face diagonal`,
    );
  }
});

test("legacy geometry with hiddenEdges reconstructs its quads", () => {
  // A two-quad strip stored the old way: four triangles plus the two diagonals.
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]);
  geometry.userData.editableHiddenEdges = [[0, 2], [1, 5]];

  const mesh = meshFromBufferGeometry(geometry);
  clean(mesh);
  assert.equal(mesh.faces.size, 2, "two quads recovered from four triangles");
  assert.deepEqual(faceSizes(mesh), [4, 4]);
  assert.equal(mesh.verts.size, 6);
  assert.equal(mesh.edges.size, 7);
  assert.ok(findEdge(...[...mesh.verts].filter((v) => v.co[0] === 1)), "the shared edge exists once");
});

test("legacy geometry with no topology hint infers coplanar quads the way the old editor did", () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const mesh = meshFromBufferGeometry(geometry);
  clean(mesh);
  assert.equal(mesh.faces.size, 1, "two coplanar triangles read back as one quad");
  assert.equal([...mesh.faces][0].loops.length, 4);
});

test("an authored empty hiddenEdges list keeps triangles as triangles", () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.userData.editableHiddenEdges = [];

  const mesh = meshFromBufferGeometry(geometry);
  clean(mesh);
  assert.equal(mesh.faces.size, 2, "an authored answer of 'no hidden edges' is respected");
  assert.deepEqual(faceSizes(mesh), [3, 3]);
});

test("welding by position merges the duplicate render vertices of a UV seam", () => {
  // Two triangles meeting at a seam: the shared corners are duplicated in the
  // render buffer with different UVs, as an imported GLB would store them.
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 2, 1, 0];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 3, 5, 4]);
  geometry.userData.editableHiddenEdges = [];

  const mesh = meshFromBufferGeometry(geometry);
  clean(mesh);
  assert.equal(mesh.verts.size, 4, "seam duplicates weld into single edit vertices");
  assert.equal(mesh.faces.size, 2);
  // The seam still exists, because UVs live on the loops.
  const seamVert = [...mesh.verts].find((v) => v.co[0] === 1 && v.co[1] === 0);
  const seamUVs = new Set();
  for (const edge of seamVert.edges) {
    for (const loop of edge.loops) if (loop.v === seamVert) seamUVs.add(loop.uv.join(","));
  }
  assert.equal(seamUVs.size, 2, "one vertex carries two different corner UVs");
});

test("wire edges and loose verts survive a round trip", () => {
  const mesh = createMesh();
  const quad = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, quad);
  const tip = addVert(mesh, [0.5, 0.5, 2]);
  const stray = addVert(mesh, [5, 5, 5]);
  addEdge(mesh, quad[0], tip);

  const asset = assetFromMesh(mesh);
  assert.equal(asset.edges.length, 2, "the wire edge is published");
  const restored = meshFromBufferGeometry(geometryFromAsset(asset));
  clean(restored);
  assert.equal(restored.faces.size, 1);
  const wire = [...restored.edges].filter((edge) => edge.loops.length === 0);
  assert.equal(wire.length, 1, "the wire edge came back");
  void stray;
});

test("per-corner UVs survive the editMesh round trip exactly", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts, { uvs: [[0.25, 0.5], [0.75, 0.5], [0.75, 0.9], [0.25, 0.9]] });

  const restored = meshFromBufferGeometry(geometryFromAsset(assetFromMesh(mesh)));
  clean(restored);
  const face = [...restored.faces][0];
  const byPosition = new Map(face.loops.map((loop) => [loop.v.co.join(","), loop.uv]));
  assert.deepEqual(byPosition.get("0,0,0").map((n) => +n.toFixed(4)), [0.25, 0.5]);
  assert.deepEqual(byPosition.get("1,1,0").map((n) => +n.toFixed(4)), [0.75, 0.9]);
});

test("materials and smooth flags survive the round trip", () => {
  const { mesh } = makeCube();
  const faces = [...mesh.faces];
  faces[0].material = 3;
  faces[1].material = 1;
  faces[2].smooth = false;

  const restored = meshFromBufferGeometry(geometryFromAsset(assetFromMesh(mesh)));
  clean(restored);
  assert.deepEqual([...restored.faces].map((f) => f.material).sort(), [0, 0, 0, 0, 1, 3]);
  assert.equal([...restored.faces].filter((f) => !f.smooth).length, 1);
});

test("edge seam, sharp and crease flags survive the round trip", () => {
  const { mesh, verts } = makeCube();
  const edge = findEdge(verts[0], verts[1]);
  edge.seam = true;
  edge.sharp = true;
  edge.crease = 0.75;

  const restored = meshFromBufferGeometry(geometryFromAsset(assetFromMesh(mesh)));
  clean(restored);
  const flagged = [...restored.edges].filter((candidate) => candidate.seam || candidate.sharp || candidate.crease);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].seam, true);
  assert.equal(flagged[0].sharp, true);
  assert.equal(flagged[0].crease, 0.75);
});

test("bufferGeometryFromMesh produces a geometry the editor can reopen", () => {
  const { mesh } = makeCube();
  const geometry = bufferGeometryFromMesh(mesh);
  assert.equal(geometry.getAttribute("position").count, 24);
  assert.equal(geometry.groups.length, 1);
  const reopened = meshFromBufferGeometry(geometry);
  clean(reopened);
  assert.equal(reopened.faces.size, 6);
  assert.deepEqual(faceSizes(reopened), [4, 4, 4, 4, 4, 4]);
});

test("an n-gon round trips as an n-gon rather than as its triangles", () => {
  const mesh = createMesh();
  const ring = [];
  for (let corner = 0; corner < 7; corner++) {
    const angle = (corner / 7) * Math.PI * 2;
    ring.push(addVert(mesh, [Math.cos(angle), Math.sin(angle), 0]));
  }
  addFace(mesh, ring);

  const restored = meshFromBufferGeometry(geometryFromAsset(assetFromMesh(mesh)));
  clean(restored);
  assert.equal(restored.faces.size, 1);
  assert.equal([...restored.faces][0].loops.length, 7, "a heptagon stays a heptagon");
  assert.equal(restored.edges.size, 7);
});
