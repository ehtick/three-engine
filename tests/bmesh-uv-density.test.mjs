import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { faceCenter, validateMesh } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import { extrudeFaceRegion, insetFaces, updateSideUVs } from "../src/editor/mesh/ops/extrude.js";
import { bevelEdges, subdivideFaces } from "../src/editor/mesh/ops/topology.js";
import { unwrapBox } from "../src/editor/mesh/ops/uv.js";

/**
 * Texels per world unit for a face: UV area over world area.
 *
 * This is the measurement that was missing. Every operator can hand back faces
 * with a perfectly valid, non-zero UV area and still look broken, because the
 * new faces are mapped at a different scale from the surface they join — a
 * checker comes out twice as fine on an extruded wall as on the face beside it.
 * Only comparing densities catches that.
 */
function uvDensity(face) {
  let uv = 0;
  let world = 0;
  const loops = face.loops;
  for (let index = 1; index + 1 < loops.length; index++) {
    const [a, b, c] = [loops[0], loops[index], loops[index + 1]];
    uv += Math.abs((b.uv[0] - a.uv[0]) * (c.uv[1] - a.uv[1]) - (c.uv[0] - a.uv[0]) * (b.uv[1] - a.uv[1])) / 2;
    const ab = [b.v.co[0] - a.v.co[0], b.v.co[1] - a.v.co[1], b.v.co[2] - a.v.co[2]];
    const ac = [c.v.co[0] - a.v.co[0], c.v.co[1] - a.v.co[1], c.v.co[2] - a.v.co[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    world += Math.hypot(...cross) / 2;
  }
  return world > 1e-12 ? uv / world : 0;
}

const box = () => meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

/** A 2-unit box face maps to the whole 0..1 tile: 1 / 4 = 0.25 texels per unit². */
const BOX_DENSITY = 0.25;

function assertDensity(faces, expected, tolerance, label) {
  for (const face of faces) {
    const density = uvDensity(face);
    assert.ok(
      Math.abs(density - expected) < tolerance,
      `${label}: UV density ${density.toFixed(4)} should be near ${expected} — the texture will render at the wrong scale here`,
    );
  }
}

test("a loaded box maps at a uniform density", () => {
  const mesh = box();
  assertDensity([...mesh.faces], BOX_DENSITY, 1e-6, "loaded box");
});

test("extruded walls match the density of the face they grew from", () => {
  const mesh = box();
  const top = [...mesh.faces].find((face) => faceCenter(face)[1] > 0.9);
  setSelection(mesh, "face", [top]);
  const result = extrudeFaceRegion(mesh);
  for (const vert of result.verts) vert.co = [vert.co[0], vert.co[1] + 0.8, vert.co[2]];
  updateSideUVs(result.sides);
  assert.deepEqual(validateMesh(mesh), []);
  assertDensity(result.sides, BOX_DENSITY, 1e-6, "extrude wall");
  assertDensity(result.faces, BOX_DENSITY, 1e-6, "extrude cap");
});

test("wall density stays constant as the extrusion grows", () => {
  const mesh = box();
  const top = [...mesh.faces].find((face) => faceCenter(face)[1] > 0.9);
  setSelection(mesh, "face", [top]);
  const result = extrudeFaceRegion(mesh);
  for (const height of [0.1, 0.5, 2, 6]) {
    for (const vert of result.verts) vert.co = [vert.co[0], 1 + height, vert.co[2]];
    updateSideUVs(result.sides);
    assertDensity(result.sides, BOX_DENSITY, 1e-6, `extrude wall at height ${height}`);
  }
});

test("inset border quads match the density of the face they inset", () => {
  const mesh = box();
  const top = [...mesh.faces].find((face) => faceCenter(face)[1] > 0.9);
  setSelection(mesh, "face", [top]);
  const result = insetFaces(mesh);
  const thickness = Math.min(0.4, result.maxThickness);
  for (const vert of result.verts) {
    const offset = result.perVertexOffsets.get(vert);
    vert.co = [vert.co[0] + offset[0] * thickness, vert.co[1] + offset[1] * thickness, vert.co[2] + offset[2] * thickness];
  }
  updateSideUVs(result.sides);
  assert.deepEqual(validateMesh(mesh), []);
  assertDensity(result.sides, BOX_DENSITY, 1e-6, "inset border");
});

test("a bevel strip matches the density of the faces it was cut from", () => {
  const mesh = box();
  const edge = [...mesh.edges].find((candidate) =>
    Math.abs(candidate.v1.co[0] - 1) < 1e-6 && Math.abs(candidate.v1.co[1] - 1) < 1e-6
    && Math.abs(candidate.v2.co[0] - 1) < 1e-6 && Math.abs(candidate.v2.co[1] - 1) < 1e-6);
  setSelection(mesh, "edge", [edge]);
  const result = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.4, segments: 1 });
  assert.deepEqual(validateMesh(mesh), []);
  assertDensity(result.faces, BOX_DENSITY, 1e-6, "bevel strip");
});

test("subdivide does not change the density anywhere", () => {
  const mesh = box();
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 2);
  assert.deepEqual(validateMesh(mesh), []);
  assertDensity([...mesh.faces], BOX_DENSITY, 1e-6, "subdivided face");
});

test("box unwrap gives every face the same density", () => {
  // Normalising each axis group separately, or all of them into one shared box,
  // leaves neighbouring faces at different scales — a cube projection is
  // expected to look uniform.
  const mesh = box();
  unwrapBox(mesh);
  const densities = [...mesh.faces].map(uvDensity);
  const first = densities[0];
  for (const density of densities) {
    assert.ok(Math.abs(density - first) < 1e-9, `unwrapBox density varies: ${first} vs ${density}`);
  }
  assert.ok(Math.abs(first - BOX_DENSITY) < 1e-9, `expected each 2-unit face to fill the tile, got ${first}`);
});

test("box unwrap stays uniform on a non-cubic box", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(4, 1, 2));
  unwrapBox(mesh);
  const densities = [...mesh.faces].map(uvDensity);
  for (const density of densities) {
    assert.ok(Math.abs(density - densities[0]) < 1e-9, "every face shares one scale regardless of proportions");
  }
});

test("side UVs continue from the source edge rather than restarting at zero", () => {
  // The strip must begin exactly where the source face's edge ends in UV space;
  // starting from (0,0) would put it in a different part of the atlas.
  const mesh = box();
  const top = [...mesh.faces].find((face) => faceCenter(face)[1] > 0.9);
  const boundaryUVs = top.loops.map((loop) => [...loop.uv]);
  setSelection(mesh, "face", [top]);
  const result = extrudeFaceRegion(mesh);
  for (const vert of result.verts) vert.co = [vert.co[0], vert.co[1] + 0.5, vert.co[2]];
  updateSideUVs(result.sides);

  const wall = result.sides[0];
  const base = [wall.loops[0].uv, wall.loops[1].uv];
  const matches = boundaryUVs.some((uv) => Math.hypot(uv[0] - base[0][0], uv[1] - base[0][1]) < 1e-9);
  assert.ok(matches, `wall base UV ${base[0]} should be one of the source face's corner UVs`);
});
