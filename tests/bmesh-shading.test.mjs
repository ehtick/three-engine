import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { faceVerts, validateMesh } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import { extrudeEdges, extrudeFaceRegion, extrudeFacesIndividual, insetFaces, updateSideUVs } from "../src/editor/mesh/ops/extrude.js";
import { bevelEdges, subdivideFaces } from "../src/editor/mesh/ops/topology.js";
import { deleteSelection, makeEdgeFace, ripVerts } from "../src/editor/mesh/ops/edit.js";
import {
  bridgeEdgeLoops,
  bridgeFaces,
  fillHoles,
  gridFill,
  spinEdges,
} from "../src/editor/mesh/ops/cleanup.js";

const box = () => meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

/**
 * Every operator that builds faces must inherit shading from the surface the
 * new faces grow out of.
 *
 * `addFace` defaults to smooth, so an operator that forgets to say otherwise
 * hands a flat-shaded box back walls whose corner normals are averaged across
 * the corner — a dark gradient bending around every new face. The edit-mode
 * material is untextured, so users report it as "the UVs got messed up"; every
 * UV metric passes, because the UVs are fine. Only the smooth flag is wrong.
 */
const OPERATORS = {
  "extrude region": (mesh) => {
    setSelection(mesh, "face", [[...mesh.faces][0]]);
    const result = extrudeFaceRegion(mesh);
    const [nx, ny, nz] = result.normal;
    for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.5, vert.co[1] + ny * 0.5, vert.co[2] + nz * 0.5];
    updateSideUVs(result.sides);
  },
  "extrude individual": (mesh) => {
    selectAll(mesh, "face");
    const result = extrudeFacesIndividual(mesh);
    updateSideUVs(result.sides);
  },
  "extrude edges": (mesh) => {
    setSelection(mesh, "edge", [[...mesh.edges][0]]);
    extrudeEdges(mesh, selected(mesh, "edge"));
  },
  "inset": (mesh) => {
    setSelection(mesh, "face", [[...mesh.faces][0]]);
    const result = insetFaces(mesh);
    for (const vert of result.verts) {
      const offset = result.perVertexOffsets.get(vert);
      vert.co = [vert.co[0] + offset[0] * 0.3, vert.co[1] + offset[1] * 0.3, vert.co[2] + offset[2] * 0.3];
    }
    updateSideUVs(result.sides);
  },
  "bevel one edge": (mesh) => {
    setSelection(mesh, "edge", [[...mesh.edges][0]]);
    bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  },
  "bevel every edge rounded": (mesh) => {
    selectAll(mesh, "edge");
    bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 4 });
  },
  "subdivide": (mesh) => {
    selectAll(mesh, "face");
    subdivideFaces(mesh, selected(mesh, "face"), 2);
  },
  "bridge edge loops": (mesh) => {
    const faces = [...mesh.faces];
    setSelection(mesh, "face", [faces[0], faces[1]]);
    deleteSelection(mesh, "face", "onlyFaces");
    setSelection(mesh, "edge", [...mesh.edges].filter((edge) => edge.loops.length === 1));
    bridgeEdgeLoops(mesh, selected(mesh, "edge"));
  },
  "bridge faces": (mesh) => {
    const faces = [...mesh.faces];
    setSelection(mesh, "face", [faces[0], faces[1]]);
    bridgeFaces(mesh);
  },
  "grid fill": (mesh) => {
    setSelection(mesh, "face", [[...mesh.faces][0]]);
    deleteSelection(mesh, "face", "onlyFaces");
    setSelection(mesh, "edge", [...mesh.edges].filter((edge) => edge.loops.length === 1));
    gridFill(mesh, selected(mesh, "edge"));
  },
  "fill holes": (mesh) => {
    setSelection(mesh, "face", [[...mesh.faces][0]]);
    deleteSelection(mesh, "face", "onlyFaces");
    fillHoles(mesh);
  },
  "make edge/face": (mesh) => {
    const face = [...mesh.faces][0];
    const ring = faceVerts(face);
    setSelection(mesh, "face", [face]);
    deleteSelection(mesh, "face", "onlyFaces");
    setSelection(mesh, "vert", ring);
    makeEdgeFace(mesh, "vert");
  },
  "rip fill": (mesh) => {
    selectAll(mesh, "face");
    subdivideFaces(mesh, selected(mesh, "face"), 1);
    const at = (x, y, z) => [...mesh.verts].find((vert) => Math.hypot(vert.co[0] - x, vert.co[1] - y, vert.co[2] - z) < 1e-6);
    const center = at(0, 1, 0);
    const mid = at(0, 1, 1);
    assert.ok(center && mid, "found the top-face centre and edge midpoint");
    ripVerts(mesh, [center, mid], [1, 0, 0], { fill: true });
  },
  "spin": (mesh) => {
    setSelection(mesh, "edge", [...mesh.edges].slice(0, 2));
    spinEdges(mesh, selected(mesh, "edge"), { steps: 4, angle: Math.PI / 2 });
  },
};

for (const [name, operator] of Object.entries(OPERATORS)) {
  test(`${name} keeps a flat-shaded mesh flat`, () => {
    const mesh = box();
    for (const face of mesh.faces) {
      assert.equal(face.smooth, false, "a box must load flat-shaded, or this test proves nothing");
    }
    operator(mesh);
    const smoothed = [...mesh.faces].filter((face) => face.smooth);
    assert.equal(smoothed.length, 0, `${name} re-shaded ${smoothed.length} of ${mesh.faces.size} faces smooth`);
  });
}

test("extruding a smooth surface keeps the walls smooth", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 8, 6));
  const face = [...mesh.faces].find((candidate) => candidate.smooth);
  assert.ok(face, "a sphere must load smooth-shaded");
  setSelection(mesh, "face", [face]);
  const result = extrudeFaceRegion(mesh);
  assert.ok(!result.error, result.error);
  for (const wall of result.sides) {
    assert.equal(wall.smooth, true, "walls grown from a smooth surface must stay smooth");
  }
});

/* -------------------------------------------------------------------------- */
/* Bridge with faces selected                                                  */
/* -------------------------------------------------------------------------- */

test("inset top and bottom, bridge the caps: a tunnel through the box", () => {
  // The Blender workflow for a through-hole. Bridging the bare top and bottom
  // faces instead would run the tube coincident with the existing side walls —
  // non-manifold in Blender too — so the caps are inset first, giving the
  // bridge boundary rings of its own.
  const mesh = box();
  const caps = [];
  for (const y of [1, -1]) {
    const face = [...mesh.faces].find((candidate) => faceVerts(candidate).every((vert) => Math.abs(vert.co[1] - y) < 1e-6));
    assert.ok(face, `found the y=${y} face`);
    setSelection(mesh, "face", [face]);
    const inset = insetFaces(mesh);
    assert.ok(!inset.error, inset.error);
    for (const vert of inset.verts) {
      const offset = inset.perVertexOffsets.get(vert);
      vert.co = [vert.co[0] + offset[0] * 0.4, vert.co[1] + offset[1] * 0.4, vert.co[2] + offset[2] * 0.4];
    }
    updateSideUVs(inset.sides);
    caps.push(inset.faces[0]);
  }
  setSelection(mesh, "face", caps);
  const result = bridgeFaces(mesh);
  assert.ok(!result.error, result.error);
  assert.equal(result.faces, 4, "four quads line the tunnel");
  // 6 sides/rims + 8 inset walls + 4 tunnel walls, the two caps gone.
  assert.equal(mesh.faces.size, 16);
  assert.deepEqual(validateMesh(mesh), []);
  for (const edge of mesh.edges) assert.equal(edge.loops.length, 2, "still watertight");
  // The walls inherit the surrounding surface, not the defaults.
  const walls = [...mesh.faces].filter((face) => face.select);
  assert.equal(walls.length, 4);
  for (const wall of walls) assert.equal(wall.smooth, false);
});

test("bridge with faces refuses one region and leaves the mesh intact", () => {
  const mesh = box();
  const faces = [...mesh.faces];
  // Two faces sharing an edge flood into a single region.
  const first = faces[0];
  const neighbour = first.loops[0].e.loops.find((loop) => loop.f !== first)?.f;
  assert.ok(neighbour);
  setSelection(mesh, "face", [first, neighbour]);
  const result = bridgeFaces(mesh);
  assert.ok(result.error, "one connected region cannot be bridged");
  assert.equal(mesh.faces.size, 6, "the refusal must not delete anything");
  assert.deepEqual(validateMesh(mesh), []);
});

test("bridging a 2x1 face region bridges its whole boundary", () => {
  const mesh = box();
  selectAll(mesh, "face");
  subdivideFaces(mesh, selected(mesh, "face"), 1);
  // Two adjacent quarter-faces on top form one region; the matching pair on the
  // bottom forms the other.
  const topFaces = [...mesh.faces].filter((face) => faceVerts(face).every((vert) => Math.abs(vert.co[1] - 1) < 1e-6));
  const bottomFaces = [...mesh.faces].filter((face) => faceVerts(face).every((vert) => Math.abs(vert.co[1] + 1) < 1e-6));
  assert.equal(topFaces.length, 4);
  const topPair = [topFaces[0], topFaces.find((face, index) => index > 0 && faceVerts(face).some((vert) => faceVerts(topFaces[0]).includes(vert)))];
  const bottomPair = [bottomFaces[0], bottomFaces.find((face, index) => index > 0 && faceVerts(face).some((vert) => faceVerts(bottomFaces[0]).includes(vert)))];
  assert.ok(topPair[1] && bottomPair[1]);
  setSelection(mesh, "face", [...topPair, ...bottomPair]);
  const result = bridgeFaces(mesh);
  assert.ok(!result.error, result.error);
  assert.deepEqual(validateMesh(mesh), []);
  // The interior edge between each pair must have been swept, not left as wire.
  for (const edge of mesh.edges) assert.ok(edge.loops.length > 0, "no wire edges left behind");
});
