import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { addFace, addVert, createMesh, validateMesh } from "../src/editor/mesh/bmesh.js";
import { assetFromMesh, meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { geometryFromAsset } from "../src/engine/geometryAsset.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import {
  extrudeEdges,
  extrudeFaceRegion,
  extrudeFacesIndividual,
  insetFaces,
  updateSideUVs,
} from "../src/editor/mesh/ops/extrude.js";
import { subdivideFaces } from "../src/editor/mesh/ops/topology.js";
import { unwrapBox } from "../src/editor/mesh/ops/uv.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);

/** Signed UV area of a face; zero means the texture collapses to one texel. */
function uvArea(face) {
  let total = 0;
  const loops = face.loops;
  for (let index = 0; index < loops.length; index++) {
    const a = loops[index].uv;
    const b = loops[(index + 1) % loops.length].uv;
    total += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(total) / 2;
}

const degenerateFaces = (mesh) => [...mesh.faces].filter((face) => uvArea(face) < 1e-9).length;
const totalUVArea = (mesh) => [...mesh.faces].reduce((sum, face) => sum + uvArea(face), 0);

const box = () => meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));

/* -------------------------------------------------------------------------- */
/* Load and save                                                               */
/* -------------------------------------------------------------------------- */

test("a box primitive arrives with its UVs intact", () => {
  const mesh = box();
  assert.equal(degenerateFaces(mesh), 0);
  // Each of the six faces maps the full 0..1 tile.
  assert.ok(Math.abs(totalUVArea(mesh) - 6) < 1e-6, `expected 6, got ${totalUVArea(mesh)}`);
});

test("UVs survive a save and reopen", () => {
  const mesh = box();
  const before = totalUVArea(mesh);
  const reopened = meshFromBufferGeometry(geometryFromAsset(JSON.parse(JSON.stringify(assetFromMesh(mesh)))));
  clean(reopened);
  assert.equal(degenerateFaces(reopened), 0);
  assert.ok(Math.abs(totalUVArea(reopened) - before) < 1e-6);
});

/* -------------------------------------------------------------------------- */
/* Subdivide                                                                   */
/* -------------------------------------------------------------------------- */

test("subdividing a quad preserves the UV layout exactly", () => {
  for (const cuts of [1, 2, 3]) {
    const mesh = box();
    const before = totalUVArea(mesh);
    selectAll(mesh, "face");
    subdivideFaces(mesh, selected(mesh, "face"), cuts);
    clean(mesh);
    assert.equal(degenerateFaces(mesh), 0, `cuts=${cuts} left flattened UVs`);
    assert.ok(
      Math.abs(totalUVArea(mesh) - before) < 1e-6,
      `cuts=${cuts}: UV area changed ${before} -> ${totalUVArea(mesh)}`,
    );
  }
});

test("subdividing a triangle preserves its UV area", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [2, 0, 0], [0, 2, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts, { uvs: [[0, 0], [1, 0], [0, 1]] });
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 2);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
  assert.ok(Math.abs(totalUVArea(mesh) - 0.5) < 1e-9, `expected 0.5, got ${totalUVArea(mesh)}`);
});

test("subdividing an n-gon preserves its UV area", () => {
  const mesh = createMesh();
  const ring = [];
  const uvs = [];
  for (let corner = 0; corner < 6; corner++) {
    const angle = (corner / 6) * Math.PI * 2;
    ring.push(addVert(mesh, [Math.cos(angle), Math.sin(angle), 0]));
    uvs.push([0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5]);
  }
  addFace(mesh, ring, { uvs });
  const before = totalUVArea(mesh);
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
  assert.ok(Math.abs(totalUVArea(mesh) - before) < 1e-6);
});

test("a subdivided quad's interior UV lands where the geometry does", () => {
  // A single quad with a known UV mapping: the centre vertex of a one-cut
  // subdivision must sit at the centre of the UV tile too.
  const mesh = createMesh();
  const verts = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts, { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  const centre = [...mesh.verts].find((vert) => Math.abs(vert.co[0] - 1) < 1e-9 && Math.abs(vert.co[1] - 1) < 1e-9);
  assert.ok(centre, "the centre vertex exists");
  const corner = [...mesh.faces].flatMap((face) => face.loops).find((loop) => loop.v === centre);
  assert.ok(Math.abs(corner.uv[0] - 0.5) < 1e-9 && Math.abs(corner.uv[1] - 0.5) < 1e-9,
    `centre UV should be 0.5,0.5 — got ${corner.uv}`);
});

/* -------------------------------------------------------------------------- */
/* Extrude and inset sides                                                     */
/* -------------------------------------------------------------------------- */

test("extruded walls get a real UV layout rather than a collapsed one", () => {
  const mesh = box();
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = extrudeFaceRegion(mesh);
  // Along the region normal, which is the only direction that gives every wall
  // real area — an arbitrary axis shears some of them flat.
  const [nx, ny, nz] = result.normal;
  for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.5, vert.co[1] + ny * 0.5, vert.co[2] + nz * 0.5];
  updateSideUVs(result.sides);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0, "no wall collapsed to a single texel");
  for (const wall of result.sides) {
    assert.ok(uvArea(wall) > 1e-6, `wall UV area ${uvArea(wall)} should be non-zero`);
  }
});

test("wall UVs track the extrusion as it grows", () => {
  const mesh = box();
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = extrudeFaceRegion(mesh);
  const wall = result.sides[0];
  const [nx, ny, nz] = result.normal;

  for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.25, vert.co[1] + ny * 0.25, vert.co[2] + nz * 0.25];
  updateSideUVs(result.sides);
  const shallow = uvArea(wall);

  for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.25, vert.co[1] + ny * 0.25, vert.co[2] + nz * 0.25];
  updateSideUVs(result.sides);
  const deep = uvArea(wall);

  assert.ok(Math.abs(deep - shallow * 2) < 1e-6, `doubling the depth should double the UV area: ${shallow} -> ${deep}`);
});

test("inset border quads are not degenerate", () => {
  const mesh = box();
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = insetFaces(mesh);
  for (const vert of result.verts) {
    const offset = result.perVertexOffsets.get(vert);
    vert.co = [vert.co[0] + offset[0] * 0.2, vert.co[1] + offset[1] * 0.2, vert.co[2] + offset[2] * 0.2];
  }
  updateSideUVs(result.sides);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
  assert.equal(result.sides.length, 4, "a quad inset has four border quads");
});

test("individually extruded faces get side UVs too", () => {
  const mesh = box();
  selectAll(mesh, "face");
  const result = extrudeFacesIndividual(mesh);
  // Each cap has its own normal; a shared axis would flatten most of the sides.
  for (const vert of result.verts) {
    const normal = result.individualNormals.get(vert) ?? [0, 1, 0];
    vert.co = [vert.co[0] + normal[0] * 0.2, vert.co[1] + normal[1] * 0.2, vert.co[2] + normal[2] * 0.2];
  }
  updateSideUVs(result.sides);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
  assert.equal(result.sides.length, 24, "6 faces x 4 sides");
});

test("edge extrusion produces mapped quads, not blank ones", () => {
  const mesh = meshFromBufferGeometry(new THREE.PlaneGeometry(2, 2, 1, 1));
  selectAll(mesh, "edge");
  const boundary = selected(mesh, "edge").slice(0, 1);
  setSelection(mesh, "edge", boundary);
  const result = extrudeEdges(mesh, boundary);
  for (const vert of result.verts) vert.co = [vert.co[0], vert.co[1], vert.co[2] + 1];
  updateSideUVs(result.sides);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
});

/* -------------------------------------------------------------------------- */
/* Unwrap                                                                      */
/* -------------------------------------------------------------------------- */

test("box unwrap gives every face a non-degenerate mapping", () => {
  const mesh = box();
  unwrapBox(mesh);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0);
  for (const face of mesh.faces) {
    for (const loop of face.loops) {
      assert.ok(loop.uv[0] >= -1e-9 && loop.uv[0] <= 1 + 1e-9, `u out of range: ${loop.uv[0]}`);
      assert.ok(loop.uv[1] >= -1e-9 && loop.uv[1] <= 1 + 1e-9, `v out of range: ${loop.uv[1]}`);
    }
  }
});

test("unwrap survives the save and reopen path", () => {
  const mesh = box();
  unwrapBox(mesh);
  const before = totalUVArea(mesh);
  const reopened = meshFromBufferGeometry(geometryFromAsset(JSON.parse(JSON.stringify(assetFromMesh(mesh)))));
  clean(reopened);
  assert.ok(Math.abs(totalUVArea(reopened) - before) < 1e-6);
  assert.equal(degenerateFaces(reopened), 0);
});

/* -------------------------------------------------------------------------- */
/* A whole editing session                                                     */
/* -------------------------------------------------------------------------- */

test("UVs stay sane across subdivide, extrude and save", () => {
  const mesh = box();
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0, "after subdivide");

  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = extrudeFaceRegion(mesh);
  const [nx, ny, nz] = result.normal;
  for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.3, vert.co[1] + ny * 0.3, vert.co[2] + nz * 0.3];
  updateSideUVs(result.sides);
  clean(mesh);
  assert.equal(degenerateFaces(mesh), 0, "after extrude");

  const reopened = meshFromBufferGeometry(geometryFromAsset(JSON.parse(JSON.stringify(assetFromMesh(mesh)))));
  clean(reopened);
  assert.equal(degenerateFaces(reopened), 0, "after save and reopen");
});
