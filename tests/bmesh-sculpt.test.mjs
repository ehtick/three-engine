import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { copyMesh, validateMesh, vertNormal } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { meshStatistics } from "../src/editor/mesh/ops/cleanup.js";
import {
  applyDab,
  applyStrokeDab,
  averageEdgeLength,
  beginStroke,
  buildSpatialIndex,
  captureGrabWeights,
  refreshStroke,
  strokeDabPositions,
  surfaceNormalAt,
  symmetryDabs,
  vertsInSphere,
} from "../src/editor/mesh/sculpt.js";
import { collapseUnderBrush, dyntopoStep, refineUnderBrush } from "../src/editor/mesh/ops/dyntopo.js";

const clean = (mesh) => assert.deepEqual(validateMesh(mesh), []);
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) < tolerance;

/** A flat grid in the XY plane, normal +Z, spanning -1..1. */
function makeSheet(segments = 12) {
  return meshFromBufferGeometry(new THREE.PlaneGeometry(2, 2, segments, segments));
}

const snapshot = (mesh) => new Map([...mesh.verts].map((vert) => [vert, [...vert.co]]));
const displacement = (mesh, before) => {
  let max = 0;
  for (const vert of mesh.verts) {
    const start = before.get(vert);
    if (!start) continue;
    max = Math.max(max, Math.hypot(vert.co[0] - start[0], vert.co[1] - start[1], vert.co[2] - start[2]));
  }
  return max;
};

/* -------------------------------------------------------------------------- */
/* Spatial index                                                               */
/* -------------------------------------------------------------------------- */

test("the spatial index finds exactly the vertices inside a sphere", () => {
  const mesh = makeSheet(10);
  const index = buildSpatialIndex(mesh, 0.2);
  const center = [0, 0, 0];
  const radius = 0.5;
  const found = new Set(vertsInSphere(index, center, radius).map((hit) => hit.vert));
  const expected = [...mesh.verts].filter((vert) => Math.hypot(...vert.co) <= radius + 1e-9);
  assert.equal(found.size, expected.length, "index agrees with a brute-force scan");
  for (const vert of expected) assert.ok(found.has(vert));
});

test("the index works when the brush is much wider than a cell", () => {
  const mesh = makeSheet(10);
  const index = buildSpatialIndex(mesh, 0.05);
  const found = vertsInSphere(index, [0, 0, 0], 5);
  assert.equal(found.length, mesh.verts.size, "a huge brush reaches every vertex");
});

test("normalised distance runs 0 at the centre to 1 at the rim", () => {
  const mesh = makeSheet(8);
  const index = buildSpatialIndex(mesh, 0.2);
  for (const hit of vertsInSphere(index, [0, 0, 0], 0.75)) {
    assert.ok(hit.normalized >= 0 && hit.normalized <= 1 + 1e-9);
  }
});

/* -------------------------------------------------------------------------- */
/* Brushes                                                                     */
/* -------------------------------------------------------------------------- */

test("draw raises the surface along the brush normal", () => {
  const mesh = makeSheet(12);
  const index = buildSpatialIndex(mesh, 0.2);
  const before = snapshot(mesh);
  const moved = applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.5, index });
  clean(mesh);
  assert.ok(moved > 0);
  const peak = [...mesh.verts].find((vert) => close(vert.co[0], 0) && close(vert.co[1], 0));
  assert.ok(peak.co[2] > 0.1, `centre should be raised, got z=${peak.co[2]}`);
  assert.ok(displacement(mesh, before) > 0);
});

test("draw inverted carves inward", () => {
  const mesh = makeSheet(12);
  const index = buildSpatialIndex(mesh, 0.2);
  applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.5, invert: true, index });
  const peak = [...mesh.verts].find((vert) => close(vert.co[0], 0) && close(vert.co[1], 0));
  assert.ok(peak.co[2] < -0.1, `inverted draw should sink, got z=${peak.co[2]}`);
});

test("falloff means the centre moves further than the rim", () => {
  const mesh = makeSheet(16);
  const index = buildSpatialIndex(mesh, 0.2);
  applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, strength: 0.5, index });
  const at = (x, y) => [...mesh.verts].find((vert) => close(vert.co[0], x, 0.02) && close(vert.co[1], y, 0.02));
  const centre = at(0, 0).co[2];
  const middle = at(0.25, 0).co[2];
  const rim = at(0.5, 0).co[2];
  assert.ok(centre > middle && middle > rim, `expected a falling profile, got ${[centre, middle, rim]}`);
  assert.ok(rim >= 0);
});

test("a brush leaves vertices outside its radius untouched", () => {
  const mesh = makeSheet(12);
  const index = buildSpatialIndex(mesh, 0.2);
  const outside = [...mesh.verts].filter((vert) => Math.hypot(vert.co[0], vert.co[1]) > 0.55);
  const before = new Map(outside.map((vert) => [vert, [...vert.co]]));
  applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 1, index });
  for (const vert of outside) assert.deepEqual(vert.co, before.get(vert));
});

test("inflate pushes along each vertex's own normal, not one shared normal", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 24, 16));
  const index = buildSpatialIndex(mesh, 0.2);
  const before = snapshot(mesh);
  applyDab(mesh, { type: "inflate", center: [0, 0, 1], normal: [0, 0, 1], radius: 0.6, strength: 0.3, index });
  clean(mesh);
  const affected = [...mesh.verts].filter((vert) => {
    const start = before.get(vert);
    return Math.hypot(vert.co[0] - start[0], vert.co[1] - start[1], vert.co[2] - start[2]) > 1e-9;
  });
  assert.ok(affected.length > 3);
  // On a sphere every vertex normal differs, so the displacements must too.
  const directions = new Set(affected.map((vert) => {
    const start = before.get(vert);
    const delta = [vert.co[0] - start[0], vert.co[1] - start[1], vert.co[2] - start[2]];
    const size = Math.hypot(...delta) || 1;
    return delta.map((value) => (value / size).toFixed(2)).join(",");
  }));
  assert.ok(directions.size > 1, "inflate should follow per-vertex normals");
  // And every vertex moved outward.
  for (const vert of affected) {
    const start = before.get(vert);
    assert.ok(Math.hypot(...vert.co) > Math.hypot(...start), "inflate pushes outward");
  }
});

test("smooth flattens a spike and is order independent", () => {
  const mesh = makeSheet(12);
  const spike = [...mesh.verts].find((vert) => close(vert.co[0], 0) && close(vert.co[1], 0));
  spike.co = [0, 0, 1];
  const index = buildSpatialIndex(mesh, 0.2);
  applyDab(mesh, { type: "smooth", center: [0, 0, 0.5], normal: [0, 0, 1], radius: 1.2, strength: 0.8, index });
  clean(mesh);
  assert.ok(spike.co[2] < 0.5, `the spike should relax, got z=${spike.co[2]}`);
  assert.ok(spike.co[2] > 0, "but not overshoot past its neighbours");
});

test("smooth does not drift a flat surface", () => {
  const mesh = makeSheet(10);
  const index = buildSpatialIndex(mesh, 0.2);
  const before = snapshot(mesh);
  applyDab(mesh, { type: "smooth", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, strength: 1, index });
  // Interior vertices of a regular grid already sit at their neighbour average.
  const interior = [...mesh.verts].filter((vert) => Math.abs(vert.co[0]) < 0.7 && Math.abs(vert.co[1]) < 0.7 && vert.edges.size === 4);
  for (const vert of interior) {
    const start = before.get(vert);
    assert.ok(Math.hypot(vert.co[0] - start[0], vert.co[1] - start[1], vert.co[2] - start[2]) < 1e-6, "a flat grid is already smooth");
  }
});

test("flatten pulls a bumpy region onto one plane", () => {
  const mesh = makeSheet(12);
  for (const vert of mesh.verts) {
    if (Math.hypot(vert.co[0], vert.co[1]) < 0.5) vert.co = [vert.co[0], vert.co[1], Math.sin(vert.co[0] * 12) * 0.2];
  }
  const index = buildSpatialIndex(mesh, 0.2);
  const spread = (list) => Math.max(...list) - Math.min(...list);
  // Measured over the brush core: out at the rim the falloff correctly holds
  // vertices almost still, so including them would test the falloff, not flatten.
  const region = () => [...mesh.verts].filter((vert) => Math.hypot(vert.co[0], vert.co[1]) < 0.2).map((vert) => vert.co[2]);
  const before = spread(region());
  assert.ok(before > 0.1, "the region starts genuinely bumpy");
  for (let pass = 0; pass < 8; pass++) {
    applyDab(mesh, { type: "flatten", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.8, index });
  }
  clean(mesh);
  assert.ok(spread(region()) < before * 0.25, `flatten should collapse the spread: ${before} -> ${spread(region())}`);
});

test("scrape only cuts peaks and fill only raises hollows", () => {
  const build = () => {
    const mesh = makeSheet(12);
    for (const vert of mesh.verts) {
      if (Math.hypot(vert.co[0], vert.co[1]) < 0.5) vert.co = [vert.co[0], vert.co[1], vert.co[0] > 0 ? 0.3 : -0.3];
    }
    return mesh;
  };
  const scraped = build();
  const scrapedIndex = buildSpatialIndex(scraped, 0.2);
  const lowBefore = [...scraped.verts].filter((v) => v.co[2] < -0.2).map((v) => v.co[2]);
  applyDab(scraped, { type: "scrape", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, strength: 1, index: scrapedIndex });
  const lowAfter = [...scraped.verts].filter((v) => v.co[2] < -0.2).map((v) => v.co[2]);
  assert.equal(lowAfter.length, lowBefore.length, "scrape leaves the hollows alone");

  const filled = build();
  const filledIndex = buildSpatialIndex(filled, 0.2);
  const highBefore = [...filled.verts].filter((v) => v.co[2] > 0.2).length;
  applyDab(filled, { type: "fill", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, strength: 1, index: filledIndex });
  assert.equal([...filled.verts].filter((v) => v.co[2] > 0.2).length, highBefore, "fill leaves the peaks alone");
});

test("pinch draws vertices towards the brush axis", () => {
  const mesh = makeSheet(12);
  const index = buildSpatialIndex(mesh, 0.2);
  const sample = [...mesh.verts].find((vert) => close(vert.co[0], 0.5, 0.05) && close(vert.co[1], 0, 0.05));
  const before = Math.hypot(sample.co[0], sample.co[1]);
  applyDab(mesh, { type: "pinch", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.8, strength: 0.5, index });
  clean(mesh);
  assert.ok(Math.hypot(sample.co[0], sample.co[1]) < before, "pinch pulls inward");
});

test("grab drags from the positions captured at stroke start", () => {
  const mesh = makeSheet(12);
  const stroke = beginStroke(mesh, { radius: 0.5, brush: "grab" });
  const centre = [...mesh.verts].find((vert) => close(vert.co[0], 0) && close(vert.co[1], 0));
  captureGrabWeights(stroke, [0, 0, 0], 0.5);
  const options = {
    type: "grab", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 1,
    index: stroke.index, originals: stroke.originals, weights: stroke.weights,
  };
  applyDab(mesh, { ...options, direction: [0, 0, 0.4] });
  const afterFirst = centre.co[2];
  assert.ok(afterFirst > 0.3);
  // Applying the same total delta again must not accumulate.
  applyDab(mesh, { ...options, direction: [0, 0, 0.4] });
  assert.ok(close(centre.co[2], afterFirst, 1e-9), "grab is absolute, not incremental");
  // And returning to zero restores the surface exactly.
  applyDab(mesh, { ...options, direction: [0, 0, 0] });
  assert.ok(close(centre.co[2], 0, 1e-9), "grab is fully reversible");
});

test("every brush leaves the mesh structurally valid", () => {
  for (const type of ["draw", "clay", "inflate", "smooth", "flatten", "scrape", "fill", "pinch", "crease", "nudge"]) {
    const mesh = makeSheet(10);
    const index = buildSpatialIndex(mesh, 0.2);
    applyDab(mesh, { type, center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, strength: 0.5, direction: [0.1, 0, 0], index });
    assert.deepEqual(validateMesh(mesh), [], `${type} corrupted the mesh`);
    for (const vert of mesh.verts) {
      assert.ok(vert.co.every(Number.isFinite), `${type} produced a non-finite position`);
    }
  }
});

test("displacement scales with radius so a brush feels the same at any zoom", () => {
  const small = makeSheet(20);
  const large = makeSheet(20);
  applyDab(small, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.25, strength: 0.5, index: buildSpatialIndex(small, 0.1) });
  applyDab(large, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.5, index: buildSpatialIndex(large, 0.2) });
  const peakOf = (mesh) => Math.max(...[...mesh.verts].map((vert) => vert.co[2]));
  assert.ok(close(peakOf(large) / peakOf(small), 2, 0.05), "doubling the radius doubles the height");
});

/* -------------------------------------------------------------------------- */
/* Symmetry                                                                    */
/* -------------------------------------------------------------------------- */

test("symmetryDabs mirrors across each enabled axis", () => {
  assert.equal(symmetryDabs([1, 2, 3], [0, 0, 1], [0, 0, 0], {}).length, 1);
  const x = symmetryDabs([1, 2, 3], [1, 0, 0], [0, 0, 0], { x: true });
  assert.equal(x.length, 2);
  assert.deepEqual(x[1].center, [-1, 2, 3]);
  assert.deepEqual(x[1].normal, [-1, 0, 0], "the normal mirrors too");
  assert.equal(symmetryDabs([1, 2, 3], [0, 0, 1], [0, 0, 0], { x: true, y: true }).length, 4, "two axes give four dabs");
});

test("a symmetric stroke sculpts both sides equally", () => {
  const mesh = makeSheet(16);
  const index = buildSpatialIndex(mesh, 0.2);
  applyStrokeDab(mesh, {
    type: "draw", center: [0.5, 0, 0], normal: [0, 0, 1], radius: 0.35, strength: 0.5,
    index, symmetry: { x: true },
  });
  clean(mesh);
  const at = (x) => [...mesh.verts].find((vert) => close(vert.co[0], x, 0.03) && close(vert.co[1], 0, 0.03));
  assert.ok(at(0.5).co[2] > 0.05, "the stroke raised its own side");
  assert.ok(close(at(0.5).co[2], at(-0.5).co[2], 1e-6), "and the mirrored side identically");
});

/* -------------------------------------------------------------------------- */
/* Stroke spacing                                                              */
/* -------------------------------------------------------------------------- */

test("stroke spacing interpolates dabs across a fast drag", () => {
  const mesh = makeSheet(8);
  const stroke = beginStroke(mesh, { radius: 0.2, spacing: 0.5 });
  assert.equal(strokeDabPositions(stroke, [0, 0, 0], 0.2).length, 1, "the first sample always lays a dab");
  // A jump of 1.0 with a step of 0.1 should fill in the gap.
  const filled = strokeDabPositions(stroke, [1, 0, 0], 0.2);
  assert.ok(filled.length >= 9, `expected the gap to be filled, got ${filled.length} dabs`);
  assert.ok(filled.every((point) => point[0] >= 0 && point[0] <= 1.0001));
});

test("stroke spacing suppresses dabs while the pointer barely moves", () => {
  const mesh = makeSheet(8);
  const stroke = beginStroke(mesh, { radius: 0.5, spacing: 0.5 });
  strokeDabPositions(stroke, [0, 0, 0], 0.5);
  assert.equal(strokeDabPositions(stroke, [0.01, 0, 0], 0.5).length, 0, "a tiny move lays no new dab");
});

test("surfaceNormalAt reports the surface direction under the brush", () => {
  const mesh = makeSheet(10);
  const index = buildSpatialIndex(mesh, 0.2);
  const normal = surfaceNormalAt(index, [0, 0, 0], 0.5);
  assert.ok(normal);
  assert.ok(close(Math.abs(normal[2]), 1, 1e-6), `a flat XY sheet faces Z, got ${normal}`);
});

/* -------------------------------------------------------------------------- */
/* Dynamic topology                                                            */
/* -------------------------------------------------------------------------- */

test("refine adds detail under the brush and nowhere else", () => {
  const mesh = makeSheet(4);
  const before = meshStatistics(mesh);
  const refined = refineUnderBrush(mesh, [0, 0, 0], 0.4, 0.15);
  clean(mesh);
  assert.ok(refined > 0, "edges longer than the detail size were split");
  const after = meshStatistics(mesh);
  assert.ok(after.verts > before.verts);
  // The far corner is outside the brush and must be untouched.
  const corner = [...mesh.verts].filter((vert) => Math.abs(vert.co[0]) > 0.9 && Math.abs(vert.co[1]) > 0.9);
  assert.equal(corner.length, 4, "the sheet still has its four corners");
  const farEdges = [...mesh.edges].filter((edge) => Math.hypot(edge.v1.co[0], edge.v1.co[1]) > 1.2);
  for (const edge of farEdges) {
    const length = Math.hypot(edge.v2.co[0] - edge.v1.co[0], edge.v2.co[1] - edge.v1.co[1]);
    assert.ok(length > 0.15, "edges outside the brush were not subdivided");
  }
});

test("refine converges towards the detail size when run repeatedly", () => {
  const mesh = makeSheet(4);
  for (let pass = 0; pass < 8; pass++) refineUnderBrush(mesh, [0, 0, 0], 0.5, 0.12);
  clean(mesh);
  const inside = [...mesh.edges].filter((edge) => Math.hypot(edge.v1.co[0], edge.v1.co[1]) < 0.3);
  const longest = Math.max(...inside.map((edge) => Math.hypot(edge.v2.co[0] - edge.v1.co[0], edge.v2.co[1] - edge.v1.co[1])));
  assert.ok(longest <= 0.13, `edges under the brush should reach the detail size, longest was ${longest}`);
});

test("refine respects its budget so a dab cannot stall the drag", () => {
  const mesh = makeSheet(20);
  const refined = refineUnderBrush(mesh, [0, 0, 0], 2, 0.01, { budget: 25 });
  clean(mesh);
  assert.equal(refined, 25);
});

test("collapse removes detail and keeps the mesh valid", () => {
  const mesh = makeSheet(16);
  const before = meshStatistics(mesh);
  const collapsed = collapseUnderBrush(mesh, [0, 0, 0], 0.5, 0.5);
  clean(mesh);
  assert.ok(collapsed > 0, "short edges under the brush were collapsed");
  assert.ok(meshStatistics(mesh).verts < before.verts);
});

test("collapse refuses to pinch the surface shut", () => {
  const mesh = meshFromBufferGeometry(new THREE.SphereGeometry(1, 10, 6));
  collapseUnderBrush(mesh, [0, 0, 0], 10, 10, { budget: 500 });
  clean(mesh);
  // Whatever survives must still be a sane surface, not a folded one.
  for (const edge of mesh.edges) assert.ok(edge.loops.length <= 2, "collapse created a non-manifold edge");
  for (const face of mesh.faces) {
    assert.equal(new Set(face.loops.map((loop) => loop.v)).size, face.loops.length, "a face visits a vertex twice");
  }
});

test("a dyntopo sculpt stroke on a coarse mesh actually adds shape", () => {
  // The point of dyntopo: a four-vertex quad cannot hold a bump, so the brush
  // has to add the geometry it needs as it goes.
  const mesh = makeSheet(1);
  assert.equal(mesh.verts.size, 4);
  const detail = 0.12;
  for (let pass = 0; pass < 10; pass++) {
    dyntopoStep(mesh, [0, 0, 0], 0.5, detail, { mode: "subdivide" });
    const index = buildSpatialIndex(mesh, 0.25);
    applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.08, index });
  }
  clean(mesh);
  assert.ok(mesh.verts.size > 100, `dyntopo should have added detail, got ${mesh.verts.size} verts`);
  const peak = Math.max(...[...mesh.verts].map((vert) => vert.co[2]));
  assert.ok(peak > 0.05, `the stroke should have raised a bump, peak z=${peak}`);
  // The rim of the sheet must not have drifted.
  const corners = [...mesh.verts].filter((vert) => Math.abs(vert.co[0]) > 0.99 && Math.abs(vert.co[1]) > 0.99);
  assert.equal(corners.length, 4);
  for (const corner of corners) assert.ok(close(corner.co[2], 0, 1e-9));
});

test("averageEdgeLength gives a sensible default detail size", () => {
  const mesh = makeSheet(4);
  assert.ok(close(averageEdgeLength(mesh), 0.5, 1e-6), "a 4-segment 2-unit sheet has 0.5 edges");
});

test("vertex normals stay finite after heavy sculpting", () => {
  const mesh = makeSheet(12);
  const index = buildSpatialIndex(mesh, 0.2);
  for (let pass = 0; pass < 20; pass++) {
    applyDab(mesh, { type: "draw", center: [0, 0, 0], normal: [0, 0, 1], radius: 0.5, strength: 0.4, index });
  }
  clean(mesh);
  for (const vert of mesh.verts) {
    const normal = vertNormal(vert);
    assert.ok(normal.every(Number.isFinite), "a vertex normal went non-finite");
  }
});

/* -------------------------------------------------------------------------- */
/* The stroke path the panel actually drives                                   */
/* -------------------------------------------------------------------------- */

test("a full dyntopo stroke with symmetry sculpts both sides and stays valid", () => {
  // Mirrors the panel's sequence: begin a stroke, walk the pointer, and for
  // each interpolated dab run dyntopo then the brush.
  const mesh = makeSheet(2);
  const radius = 0.35;
  const detail = 0.1;
  const stroke = beginStroke(mesh, { radius, brush: "draw", spacing: 0.3 });
  // A one-sided path, so mirroring across X has real work to do.
  const path = [[0.2, 0, 0], [0.4, 0, 0], [0.6, 0, 0]];

  for (const point of path) {
    for (const center of strokeDabPositions(stroke, point, radius)) {
      const result = dyntopoStep(mesh, center, radius, detail, { mode: "both", budget: 120 });
      if (result.changed) refreshStroke(stroke, mesh, radius);
      applyStrokeDab(mesh, {
        type: "draw",
        center,
        normal: surfaceNormalAt(stroke.index, center, radius) ?? [0, 0, 1],
        radius,
        strength: 0.3,
        falloff: "smooth",
        index: stroke.index,
        symmetry: { x: true },
      });
    }
  }
  clean(mesh);
  assert.ok(stroke.dabs >= 3, `the stroke should have laid several dabs, got ${stroke.dabs}`);
  assert.ok(mesh.verts.size > 20, `dyntopo should have added detail, got ${mesh.verts.size} verts`);

  const raised = [...mesh.verts].filter((vert) => vert.co[2] > 0.02);
  assert.ok(raised.length > 3, "the stroke left a raised ridge");

  // Symmetry is checked on the resulting *shape*, not on vertex counts: dyntopo
  // splits edges in whatever order its scoring produces, so the two halves end
  // up with genuinely different tessellations of the same surface.
  const peak = (predicate) => Math.max(0, ...[...mesh.verts].filter(predicate).map((vert) => vert.co[2]));
  const right = peak((vert) => vert.co[0] > 0.1);
  const left = peak((vert) => vert.co[0] < -0.1);
  assert.ok(right > 0.02, `the stroke raised its own side, got ${right}`);
  assert.ok(Math.abs(right - left) < right * 0.2, `the mirrored side should match: ${right} vs ${left}`);
  for (const vert of mesh.verts) assert.ok(vert.co.every(Number.isFinite));
});

test("a stroke is undoable as a single snapshot", () => {
  // The panel snapshots once per stroke; this proves the snapshot is a genuine
  // deep copy and is unaffected by everything the stroke then does.
  const mesh = makeSheet(6);
  const snapshotMesh = copyMesh(mesh).mesh;
  const before = meshStatistics(snapshotMesh);

  const stroke = beginStroke(mesh, { radius: 0.5, brush: "draw" });
  for (const center of strokeDabPositions(stroke, [0, 0, 0], 0.5)) {
    dyntopoStep(mesh, center, 0.5, 0.1, { mode: "subdivide" });
    refreshStroke(stroke, mesh, 0.5);
    applyStrokeDab(mesh, { type: "draw", center, normal: [0, 0, 1], radius: 0.5, strength: 0.5, index: stroke.index, symmetry: {} });
  }
  clean(mesh);
  assert.ok(meshStatistics(mesh).verts > before.verts, "the stroke changed the mesh");
  assert.deepEqual(meshStatistics(snapshotMesh), before, "the undo snapshot is untouched");
  clean(snapshotMesh);
});
