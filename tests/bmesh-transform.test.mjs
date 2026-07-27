import test from "node:test";
import assert from "node:assert/strict";

import { addEdge, addFace, addVert, createMesh, findEdge, validateMesh } from "../src/editor/mesh/bmesh.js";
import { selectAll, selected, selectedVerts, setSelection } from "../src/editor/mesh/select.js";
import {
  applySlide,
  constrainTranslation,
  constraintAxes,
  edgeSlideRails,
  falloffWeight,
  individualPivots,
  orientationBasis,
  proportionalDistances,
  snapTarget,
  transformPivot,
  vertSlideRails,
} from "../src/editor/mesh/transform.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) < tolerance;
const closeVec = (a, b, tolerance = 1e-6) => a.every((value, index) => close(value, b[index], tolerance));

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
/* Orientations                                                                */
/* -------------------------------------------------------------------------- */

test("normal orientation aligns Z with a face normal", () => {
  const mesh = createMesh();
  // A face tilted 45 degrees about X, so its normal is a known non-axis vector.
  const face = addFace(mesh, [[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1]].map((co) => addVert(mesh, co)));
  setSelection(mesh, "face", [face]);
  const basis = orientationBasis(mesh, "face", "normal");
  const expected = [0, -Math.SQRT1_2, Math.SQRT1_2];
  assert.ok(closeVec(basis[2], expected) || closeVec(basis[2], expected.map((v) => -v)), `got ${basis[2]}`);
});

test("normal orientation basis stays orthonormal", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", [faces[0]]);
  const basis = orientationBasis(mesh, "face", "normal");
  for (const axis of basis) assert.ok(close(Math.hypot(...axis), 1), `axis ${axis} is not unit length`);
  assert.ok(close(basis[0][0] * basis[1][0] + basis[0][1] * basis[1][1] + basis[0][2] * basis[1][2], 0));
  assert.ok(close(basis[0][0] * basis[2][0] + basis[0][1] * basis[2][1] + basis[0][2] * basis[2][2], 0));
});

test("normal orientation aligns Y with a selected edge", () => {
  const { mesh, verts } = makeGrid(2, 2);
  setSelection(mesh, "edge", [findEdge(verts[0][0], verts[1][0])]);
  const basis = orientationBasis(mesh, "edge", "normal");
  assert.ok(closeVec(basis[1], [1, 0, 0]) || closeVec(basis[1], [-1, 0, 0]), `Y should follow the edge, got ${basis[1]}`);
  assert.ok(closeVec(basis[2], [0, 0, 1]) || closeVec(basis[2], [0, 0, -1]), `Z should follow the surface, got ${basis[2]}`);
});

test("global and local orientations are the identity in local space", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  assert.deepEqual(orientationBasis(mesh, "face", "local"), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual(orientationBasis(mesh, "face", "global"), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test("view orientation returns the supplied camera basis", () => {
  const { mesh } = makeGrid(1, 1);
  const viewBasis = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
  assert.deepEqual(orientationBasis(mesh, "face", "view", { viewBasis }), viewBasis);
});

/* -------------------------------------------------------------------------- */
/* Constraints                                                                 */
/* -------------------------------------------------------------------------- */

test("a single axis constraint keeps only that component", () => {
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const constrained = constrainTranslation([3, 5, 7], constraintAxes(basis, "x"));
  assert.deepEqual(constrained, [3, 0, 0]);
});

test("a plane constraint keeps two components (Blender's Shift+X)", () => {
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const constrained = constrainTranslation([3, 5, 7], constraintAxes(basis, "yz"));
  assert.deepEqual(constrained, [0, 5, 7]);
});

test("constraints work in a rotated basis, not just world axes", () => {
  const diagonal = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const basis = [diagonal, [-Math.SQRT1_2, Math.SQRT1_2, 0], [0, 0, 1]];
  const constrained = constrainTranslation([1, 1, 9], constraintAxes(basis, "x"));
  assert.ok(closeVec(constrained, [1, 1, 0]), `expected the drag projected onto the diagonal, got ${constrained}`);
});

test("no constraint passes the translation through", () => {
  assert.deepEqual(constrainTranslation([1, 2, 3], constraintAxes([[1, 0, 0], [0, 1, 0], [0, 0, 1]], "")), [1, 2, 3]);
});

/* -------------------------------------------------------------------------- */
/* Pivots                                                                      */
/* -------------------------------------------------------------------------- */

test("median pivot is the average of the selected verts", () => {
  const { mesh, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  assert.ok(closeVec(transformPivot(mesh, "face", "median"), [0.5, 0.5, 0]));
});

test("cursor and active pivots use what they are given", () => {
  const { mesh, verts, faces } = makeGrid(1, 1);
  setSelection(mesh, "face", [faces[0]]);
  assert.deepEqual(transformPivot(mesh, "face", "cursor", { cursor: [9, 9, 9] }), [9, 9, 9]);
  assert.deepEqual(transformPivot(mesh, "face", "active", { active: verts[1][1] }), [1, 1, 0]);
});

test("bounding box pivot differs from the median on a lopsided selection", () => {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1.1, 0, 0], [1.2, 0, 0]].map((co) => addVert(mesh, co));
  for (let index = 0; index + 1 < verts.length; index++) addEdge(mesh, verts[index], verts[index + 1]);
  selectAll(mesh, "vert");
  const median = transformPivot(mesh, "vert", "median");
  const bounds = transformPivot(mesh, "vert", "bounds");
  assert.ok(close(bounds[0], 0.6), `bounds centre should be 0.6, got ${bounds[0]}`);
  assert.ok(Math.abs(median[0] - bounds[0]) > 0.1, "median is pulled toward the cluster");
});

test("individual origins give each face its own pivot", () => {
  const { mesh, faces } = makeGrid(2, 1);
  setSelection(mesh, "face", faces);
  const pivots = individualPivots(mesh, "face");
  const shared = [...pivots.entries()].filter(([vert]) => vert.co[0] === 1);
  // The shared column belongs to both faces, so its pivot is their average.
  assert.ok(shared.every(([, pivot]) => close(pivot[0], 1)), "shared verts average their two face centres");
  const leftOnly = [...pivots.entries()].find(([vert]) => vert.co[0] === 0);
  assert.ok(close(leftOnly[1][0], 0.5), `the left face pivot is 0.5, got ${leftOnly[1][0]}`);
});

/* -------------------------------------------------------------------------- */
/* Snapping                                                                    */
/* -------------------------------------------------------------------------- */

test("increment snapping rounds to the grid", () => {
  const { mesh } = makeGrid(1, 1);
  const result = snapTarget(mesh, [1.13, -0.44, 0.26], { mode: "increment", increment: 0.25 });
  assert.deepEqual(result.point.map((v) => +v.toFixed(6)), [1.25, -0.5, 0.25]);
});

test("vertex snapping finds the nearest vertex within range", () => {
  const { mesh, verts } = makeGrid(2, 2);
  const result = snapTarget(mesh, [1.9, 2.05, 0], { mode: "vertex", radius: 0.5 });
  assert.ok(result);
  assert.equal(result.element, verts[2][2]);
  assert.deepEqual(result.point, [2, 2, 0]);
});

test("snapping returns null when nothing is close enough", () => {
  const { mesh } = makeGrid(2, 2);
  assert.equal(snapTarget(mesh, [50, 50, 50], { mode: "vertex", radius: 0.5 }), null);
});

test("snapping skips the vertices being dragged", () => {
  const { mesh, verts } = makeGrid(2, 2);
  const moving = new Set([verts[2][2]]);
  const result = snapTarget(mesh, [1.95, 2.0, 0], { mode: "vertex", radius: 0.5, moving });
  assert.notEqual(result?.element, verts[2][2], "a selection must not snap to itself");
});

test("edge snapping lands on the closest point along an edge", () => {
  const { mesh } = makeGrid(2, 2);
  const result = snapTarget(mesh, [0.5, 0.1, 0], { mode: "edge", radius: 0.5 });
  assert.ok(result);
  assert.ok(closeVec(result.point, [0.5, 0, 0]), `expected a point on the edge, got ${result.point}`);
});

test("edge centre snapping lands on midpoints only", () => {
  const { mesh } = makeGrid(2, 2);
  const result = snapTarget(mesh, [0.6, 0.05, 0], { mode: "edgeCenter", radius: 0.5 });
  assert.ok(closeVec(result.point, [0.5, 0, 0]));
});

test("face snapping projects onto the face plane", () => {
  const { mesh } = makeGrid(2, 2);
  const result = snapTarget(mesh, [0.5, 0.5, 0.3], { mode: "face", radius: 0.5 });
  assert.ok(result);
  assert.ok(close(result.point[2], 0), `should project onto z=0, got ${result.point[2]}`);
  assert.ok(closeVec(result.point, [0.5, 0.5, 0]));
});

test("face snapping clamps to the polygon rather than escaping it", () => {
  const { mesh, faces } = makeGrid(1, 1);
  const result = snapTarget(mesh, [5, 0.5, 0.1], { mode: "face", radius: 10 });
  assert.ok(result);
  assert.ok(result.point[0] <= 1 + 1e-9, `snap escaped the face at x=${result.point[0]}`);
  void faces;
});

/* -------------------------------------------------------------------------- */
/* Slide                                                                       */
/* -------------------------------------------------------------------------- */

test("edge slide moves a loop towards its rail neighbours", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const loop = [findEdge(verts[1][0], verts[1][1])];
  setSelection(mesh, "edge", loop);
  const { rails, error } = edgeSlideRails(mesh, loop);
  assert.ok(!error, error);
  assert.equal(rails.size, 2, "both ends of the loop have rails");

  applySlide(rails, 1);
  clean(mesh);
  const slid = [verts[1][0].co[0], verts[1][1].co[0]];
  assert.ok(slid.every((x) => close(x, 0) || close(x, 2)), `the loop should reach a neighbour column, got ${slid}`);
  assert.ok(close(slid[0], slid[1]), "both ends slid the same way");
});

test("edge slide at zero leaves the mesh untouched", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const loop = [findEdge(verts[1][0], verts[1][1])];
  const { rails } = edgeSlideRails(mesh, loop);
  applySlide(rails, 0);
  assert.deepEqual(verts[1][0].co, [1, 0, 0]);
  assert.deepEqual(verts[1][1].co, [1, 1, 0]);
});

test("edge slide is reversible through the origin", () => {
  const { mesh, verts } = makeGrid(2, 1);
  const loop = [findEdge(verts[1][0], verts[1][1])];
  const { rails } = edgeSlideRails(mesh, loop);
  applySlide(rails, 0.6);
  applySlide(rails, -0.6);
  applySlide(rails, 0);
  assert.ok(closeVec(verts[1][0].co, [1, 0, 0]), "slide is applied from the recorded origin each time");
});

test("edge slide reports when there is nowhere to go", () => {
  const mesh = createMesh();
  const a = addVert(mesh, [0, 0, 0]);
  const b = addVert(mesh, [1, 0, 0]);
  const edge = addEdge(mesh, a, b);
  assert.ok(edgeSlideRails(mesh, [edge]).error);
});

test("vertex slide offers one rail per connected edge", () => {
  const { mesh, verts } = makeGrid(2, 2);
  const result = vertSlideRails(verts[1][1]);
  assert.ok(!result.error);
  assert.equal(result.rails.length, 4, "an interior grid vertex has four rails");
  assert.deepEqual(result.origin, [1, 1, 0]);
});

/* -------------------------------------------------------------------------- */
/* Proportional editing                                                        */
/* -------------------------------------------------------------------------- */

test("falloff curves all start at 1 and reach 0 at the radius", () => {
  for (const falloff of ["smooth", "sphere", "root", "inverseSquare", "sharp", "linear", "constant"]) {
    assert.ok(close(falloffWeight(0, falloff), 1), `${falloff} should be 1 at the centre`);
    assert.equal(falloffWeight(1, falloff), 0, `${falloff} should be 0 at the edge`);
    assert.equal(falloffWeight(1.5, falloff), 0, `${falloff} should stay 0 past the edge`);
  }
});

test("smooth falloff decreases monotonically", () => {
  let previous = Infinity;
  for (let t = 0; t <= 1; t += 0.1) {
    const weight = falloffWeight(t, "smooth");
    assert.ok(weight <= previous + 1e-9, `weight rose at t=${t}`);
    previous = weight;
  }
});

test("connected proportional distance follows the surface, not the gap across it", () => {
  // Two rows of a grid, plus a stray vertex placed physically close to the seed
  // but connected only through a long detour.
  const { mesh, verts } = makeGrid(3, 1);
  const seed = verts[0][0];
  const connected = proportionalDistances(mesh, [seed], { connected: true });
  assert.ok(close(connected.get(verts[3][0]), 3), `walking three edges is distance 3, got ${connected.get(verts[3][0])}`);
  assert.ok(close(connected.get(verts[0][1]), 1));
});

test("unconnected proportional distance ignores topology", () => {
  const mesh = createMesh();
  const a = addVert(mesh, [0, 0, 0]);
  const island = addVert(mesh, [0.1, 0, 0]);
  const far = addVert(mesh, [5, 0, 0]);
  addEdge(mesh, a, far);
  const euclidean = proportionalDistances(mesh, [a], { connected: false });
  assert.ok(close(euclidean.get(island), 0.1), "a nearby but disconnected vertex is still close");
  const connected = proportionalDistances(mesh, [a], { connected: true });
  assert.equal(connected.get(island), undefined, "and unreachable when following topology");
});

test("proportional distances cover every reachable vertex", () => {
  const { mesh, verts } = makeGrid(3, 3);
  const distances = proportionalDistances(mesh, selectedVerts(mesh, "vert").length ? [] : [verts[0][0]], { connected: true });
  assert.equal(distances.size, mesh.verts.size);
  assert.equal(distances.get(verts[0][0]), 0);
});

test("selection helpers agree with the transform pivot", () => {
  const { mesh, faces } = makeGrid(2, 2);
  setSelection(mesh, "face", [faces[0]]);
  assert.equal(selectedVerts(mesh, "face").length, 4);
  assert.equal(selected(mesh, "face").length, 1);
  assert.ok(closeVec(transformPivot(mesh, "face", "median"), [0.5, 0.5, 0]));
});
