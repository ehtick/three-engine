import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { createMesh, validateMesh } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { meshStatistics } from "../src/editor/mesh/ops/cleanup.js";
import { remeshMesh, weldedGeometry } from "../src/editor/mesh/ops/remesh.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);

function boundsOf(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const vert of mesh.verts) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], vert.co[axis]);
      max[axis] = Math.max(max[axis], vert.co[axis]);
    }
  }
  return { min, max };
}

/* -------------------------------------------------------------------------- */
/* The welded export                                                           */
/* -------------------------------------------------------------------------- */

test("weldedGeometry emits one vertex per edit vertex, indexed", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  const geometry = weldedGeometry(mesh, THREE);
  assert.equal(geometry.getAttribute("position").count, mesh.verts.size, "welded, not one per corner");
  assert.equal(geometry.getAttribute("position").count, 8, "a cube welds to eight");
  assert.ok(geometry.getIndex(), "the remesher requires an indexed geometry");
  assert.equal(geometry.getIndex().count / 3, 12, "six quads triangulate to twelve");
});

test("the welded export is manifold — every edge is shared by exactly two triangles", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 12, 8));
  const geometry = weldedGeometry(mesh, THREE);
  const array = geometry.getIndex().array;
  const counts = new Map();
  for (let at = 0; at + 2 < array.length; at += 3) {
    const ring = [array[at], array[at + 1], array[at + 2]];
    for (let corner = 0; corner < 3; corner++) {
      const a = ring[corner];
      const b = ring[(corner + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const bad = [...counts.values()].filter((value) => value !== 2).length;
  assert.equal(bad, 0, "an unwelded export is what made the remesher throw 'Vertex not found'");
});

test("weldedGeometry carries no UVs, because the remesher discards them anyway", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  assert.equal(weldedGeometry(mesh, THREE).getAttribute("uv"), undefined);
});

/* -------------------------------------------------------------------------- */
/* Remeshing                                                                   */
/* -------------------------------------------------------------------------- */

test("remeshing a sphere returns a valid, denser mesh at a small target", async () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 16, 12));
  const before = meshStatistics(mesh);
  const result = await remeshMesh(mesh, { targetEdgeLength: 0.2, iterations: 3 });
  assert.ok(!result.error, result.error);
  clean(result.mesh);
  const after = meshStatistics(result.mesh);
  assert.ok(after.faces > before.faces, `expected more faces: ${before.faces} -> ${after.faces}`);
  assert.equal(after.quads + after.ngons, 0, "a remesh returns triangles");
});

test("a larger target edge length gives a coarser mesh than a smaller one", async () => {
  const source = () => meshFromBufferGeometry(new THREE.SphereGeometry(1, 16, 12));
  const coarse = await remeshMesh(source(), { targetEdgeLength: 0.5, iterations: 3 });
  const fine = await remeshMesh(source(), { targetEdgeLength: 0.15, iterations: 3 });
  assert.ok(!coarse.error, coarse.error);
  assert.ok(!fine.error, fine.error);
  assert.ok(fine.faces > coarse.faces, `fine ${fine.faces} should exceed coarse ${coarse.faces}`);
});

test("remeshing keeps the shape in roughly the same place", async () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 16, 12));
  const before = boundsOf(mesh);
  const result = await remeshMesh(mesh, { targetEdgeLength: 0.25, iterations: 3 });
  assert.ok(!result.error, result.error);
  const after = boundsOf(result.mesh);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(after.min[axis] - before.min[axis]) < 0.2, `min drifted on axis ${axis}`);
    assert.ok(Math.abs(after.max[axis] - before.max[axis]) < 0.2, `max drifted on axis ${axis}`);
  }
});

test("remeshing works on a box and on a cylinder, not just a sphere", async () => {
  for (const [name, geometry] of [
    ["box", new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)],
    ["cylinder", new THREE.CylinderGeometry(1, 1, 2, 16)],
  ]) {
    const result = await remeshMesh(meshFromBufferGeometry(geometry), { targetEdgeLength: 0.3, iterations: 2 });
    assert.ok(!result.error, `${name}: ${result.error}`);
    clean(result.mesh);
    assert.ok(result.mesh.faces.size > 0, `${name} produced no faces`);
  }
});

test("the result reports that UVs were lost, so the caller can say so", async () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
  const result = await remeshMesh(mesh, { targetEdgeLength: 0.3 });
  assert.ok(!result.error, result.error);
  assert.equal(result.uvsLost, true);
});

test("omitting the target rebuilds at roughly the current density", async () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 16, 12));
  const before = meshStatistics(mesh);
  const result = await remeshMesh(mesh, { iterations: 2 });
  assert.ok(!result.error, result.error);
  assert.ok(result.targetEdgeLength > 0, "a target was derived from the average edge length");
  // Same ballpark, not an explosion or a collapse.
  assert.ok(result.faces > before.faces * 0.2 && result.faces < before.faces * 5,
    `density should stay comparable: ${before.faces} -> ${result.faces}`);
});

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

test("an empty mesh is reported, not thrown", async () => {
  const result = await remeshMesh(createMesh());
  assert.equal(result.error, "Nothing to remesh");
});

test("a failure inside the remesher is reported rather than corrupting the mesh", async () => {
  // A single unclosed triangle is not the manifold input the library wants.
  const mesh = meshFromBufferGeometry(new THREE.PlaneGeometry(1, 1, 1, 1));
  const before = meshStatistics(mesh);
  const result = await remeshMesh(mesh, { targetEdgeLength: 0.05, iterations: 2 });
  // Either it copes or it reports — what it must never do is throw, or leave
  // the caller's mesh half-rebuilt.
  if (result.error) assert.ok(typeof result.error === "string" && result.error.length > 0);
  else clean(result.mesh);
  assert.deepEqual(meshStatistics(mesh), before, "the source mesh is never mutated");
});

test("remeshing never mutates its input", async () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 12, 8));
  const before = meshStatistics(mesh);
  const result = await remeshMesh(mesh, { targetEdgeLength: 0.3 });
  assert.ok(!result.error, result.error);
  assert.deepEqual(meshStatistics(mesh), before, "the caller keeps its mesh for undo");
  assert.notEqual(result.mesh, mesh);
});
