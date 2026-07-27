import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { faceArea, faceNormal, faceVerts, validateMesh } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { selectAll, selected, setSelection } from "../src/editor/mesh/select.js";
import { extrudeFaceRegion, insetFaces, updateSideUVs } from "../src/editor/mesh/ops/extrude.js";
import { bevelEdges, knifeCut, loopCut, subdivideFaces } from "../src/editor/mesh/ops/topology.js";
import { deleteSelection, makeEdgeFace } from "../src/editor/mesh/ops/edit.js";
import {
  bridgeEdgeLoops,
  fillHoles,
  gridFill,
  pokeFaces,
  spinEdges,
  triangulateFaces,
  trisToQuads,
} from "../src/editor/mesh/ops/cleanup.js";

const box = () => meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

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

const flattened = (mesh) => [...mesh.faces].filter((face) => uvArea(face) < 1e-9);

/**
 * Every operator that builds faces must leave usable UVs behind.
 *
 * A face whose UV corners collapse to zero area samples a single texel and
 * renders as one flat smear — which is what "the UVs are broken" looks like,
 * and it went unnoticed through several operators because the edit-mode
 * material is untextured. Each entry runs an operator on a fresh box and
 * asserts nothing came back flattened.
 */
const OPERATORS = {
  "bevel one edge": (mesh) => {
    setSelection(mesh, "edge", [[...mesh.edges][0]]);
    bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  },
  "bevel every edge": (mesh) => {
    selectAll(mesh, "edge");
    bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 1 });
  },
  "bevel with segments": (mesh) => {
    setSelection(mesh, "edge", [[...mesh.edges][0]]);
    bevelEdges(mesh, selected(mesh, "edge"), { width: 0.2, segments: 4 });
  },
  "subdivide": (mesh) => {
    selectAll(mesh, "face");
    subdivideFaces(mesh, selected(mesh, "face"), 2);
  },
  "loop cut": (mesh) => loopCut(mesh, [...mesh.edges][0], { cuts: 2 }),
  "knife": (mesh) => knifeCut(mesh, [[-2, 1.01, 0], [2, 1.01, 0]]),
  "poke": (mesh) => {
    selectAll(mesh, "face");
    pokeFaces(mesh, selected(mesh, "face"));
  },
  "triangulate": (mesh) => {
    selectAll(mesh, "face");
    triangulateFaces(mesh, selected(mesh, "face"));
  },
  "tris to quads": (mesh) => {
    selectAll(mesh, "face");
    triangulateFaces(mesh, selected(mesh, "face"));
    selectAll(mesh, "face");
    trisToQuads(mesh, { faces: selected(mesh, "face") });
  },
  "bridge": (mesh) => {
    const faces = [...mesh.faces];
    setSelection(mesh, "face", [faces[0], faces[1]]);
    deleteSelection(mesh, "face", "onlyFaces");
    setSelection(mesh, "edge", [...mesh.edges].filter((edge) => edge.loops.length === 1));
    bridgeEdgeLoops(mesh, selected(mesh, "edge"));
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
  "spin": (mesh) => {
    setSelection(mesh, "edge", [...mesh.edges].slice(0, 2));
    spinEdges(mesh, selected(mesh, "edge"), { steps: 4, angle: Math.PI / 2 });
  },
  "extrude": (mesh) => {
    setSelection(mesh, "face", [[...mesh.faces][0]]);
    const result = extrudeFaceRegion(mesh);
    // Along the region normal: any other direction shears some walls to zero
    // area, which is a degenerate face in 3D, not a UV bug.
    const [nx, ny, nz] = result.normal;
    for (const vert of result.verts) vert.co = [vert.co[0] + nx * 0.5, vert.co[1] + ny * 0.5, vert.co[2] + nz * 0.5];
    updateSideUVs(result.sides);
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
};

for (const [name, operator] of Object.entries(OPERATORS)) {
  test(`${name} leaves every face with usable UVs`, () => {
    const mesh = box();
    operator(mesh);
    assert.deepEqual(validateMesh(mesh), [], `${name} corrupted the mesh`);
    const bad = flattened(mesh);
    assert.equal(bad.length, 0, `${name} left ${bad.length} of ${mesh.faces.size} faces with zero UV area`);
  });
}

/* -------------------------------------------------------------------------- */
/* Bevel actually bevels                                                       */
/* -------------------------------------------------------------------------- */

test("bevel cuts a chamfer across the corner, it does not slide along the edge", () => {
  // The regression this guards: the corner offset used the direction of the
  // edge being beveled instead of the edge staying put, so the corners walked
  // *along* the selected edge. Topology and area stayed plausible, so only a
  // direction check catches it — on screen it looked like the edge scaling.
  const mesh = box();
  const edge = [...mesh.edges].find((candidate) =>
    Math.abs(candidate.v1.co[0] - 1) < 1e-6 && Math.abs(candidate.v1.co[1] - 1) < 1e-6
    && Math.abs(candidate.v2.co[0] - 1) < 1e-6 && Math.abs(candidate.v2.co[1] - 1) < 1e-6);
  assert.ok(edge, "found the +X+Y edge running along Z");

  setSelection(mesh, "edge", [edge]);
  const result = bevelEdges(mesh, selected(mesh, "edge"), { width: 0.3, segments: 1 });
  assert.ok(!result.error, result.error);
  assert.deepEqual(validateMesh(mesh), []);

  const strip = result.faces[0];
  assert.equal(strip.loops.length, 4);
  // The new face must look along the corner bisector, not along the edge.
  const normal = faceNormal(strip);
  assert.ok(Math.abs(Math.abs(normal[0]) - Math.SQRT1_2) < 0.02, `strip normal x ${normal[0]} should be ~0.707`);
  assert.ok(Math.abs(Math.abs(normal[1]) - Math.SQRT1_2) < 0.02, `strip normal y ${normal[1]} should be ~0.707`);
  assert.ok(Math.abs(normal[2]) < 0.02, `strip must not face along the edge, got z ${normal[2]}`);

  // Width 0.3 back along each face, over the edge's full 2-unit length.
  assert.ok(Math.abs(faceArea(strip) - 0.3 * Math.SQRT2 * 2) < 0.01, `strip area ${faceArea(strip)}`);

  // The strip spans both faces: some corners pulled back in X, some in Y.
  const corners = faceVerts(strip).map((vert) => vert.co);
  assert.ok(corners.some((co) => Math.abs(co[0] - 0.7) < 1e-6), "pulled back along X");
  assert.ok(corners.some((co) => Math.abs(co[1] - 0.7) < 1e-6), "pulled back along Y");
});

test("bevelling every edge of a cube stays watertight", () => {
  const mesh = box();
  selectAll(mesh, "edge");
  bevelEdges(mesh, selected(mesh, "edge"), { width: 0.25, segments: 1 });
  assert.deepEqual(validateMesh(mesh), []);
  assert.equal(mesh.faces.size, 26, "6 shrunk faces + 12 strips + 8 corner caps");
  for (const edge of mesh.edges) assert.equal(edge.loops.length, 2, "still closed");
});

/* -------------------------------------------------------------------------- */
/* Inset cannot collapse the face                                              */
/* -------------------------------------------------------------------------- */

test("inset reports the thickness at which the cap would collapse", () => {
  const mesh = box();
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = insetFaces(mesh);
  // A 2x2 face collapses at its inradius of 1; the limit sits just inside.
  assert.ok(result.maxThickness > 0.9 && result.maxThickness < 1,
    `expected a limit just under 1, got ${result.maxThickness}`);
});

test("clamping to maxThickness keeps the cap from inverting", () => {
  // Without the clamp the cap hit zero area at thickness 1 and then grew back
  // inside out, which on screen is the face vanishing and reappearing mirrored.
  const mesh = box();
  setSelection(mesh, "face", [[...mesh.faces][0]]);
  const result = insetFaces(mesh);
  const cap = result.faces[0];
  const origins = new Map(result.verts.map((vert) => [vert, [...vert.co]]));

  let previousArea = faceArea(cap);
  for (const requested of [0.1, 0.3, 0.6, 0.9, 2, 50]) {
    const thickness = Math.min(Math.max(requested, 0), result.maxThickness);
    for (const vert of result.verts) {
      const offset = result.perVertexOffsets.get(vert);
      const origin = origins.get(vert);
      vert.co = [origin[0] + offset[0] * thickness, origin[1] + offset[1] * thickness, origin[2] + offset[2] * thickness];
    }
    const area = faceArea(cap);
    assert.ok(area > 0, `cap collapsed at requested ${requested}`);
    assert.ok(area <= previousArea + 1e-9, `cap grew back at requested ${requested} — it inverted`);
    previousArea = area;
  }
  assert.deepEqual(validateMesh(mesh), []);
});

test("inset on a rectangular face limits on the short side", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(4, 2, 1));
  const face = [...mesh.faces].reduce((widest, candidate) => (faceArea(candidate) > faceArea(widest) ? candidate : widest));
  setSelection(mesh, "face", [face]);
  const result = insetFaces(mesh);
  // The limit is set by the narrowest dimension, not the widest.
  assert.ok(result.maxThickness < 1.1, `expected the short side to bound it, got ${result.maxThickness}`);
  assert.ok(result.maxThickness > 0.2);
});
