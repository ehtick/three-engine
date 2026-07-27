// Do the operators keep the UVs?
//
// Every face-creating path in the kernel takes UVs as an *option*, and
// `addFace` quietly defaults a corner to (0, 0) when they are missing. A face
// built without them therefore looks completely normal — right position, right
// winding, right material — and is only wrong once something samples a texture
// through it. The test project has a `Mesh 2.geom` whose every UV is zero,
// which is what that failure mode leaves behind.
//
// So this walks each operator over a textured cube and asks whether any face
// came out with a degenerate (single-point) UV triangle.
//
// Run: node scripts/run-mesh-uv-test.mjs

import * as THREE from "three/webgpu";
import { assetFromMesh, meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { selected, selectedVerts, clearSelection, flushSelection } from "../src/editor/mesh/select.js";
import { faceVerts } from "../src/editor/mesh/bmesh.js";
import * as cleanup from "../src/editor/mesh/ops/cleanup.js";
import * as edit from "../src/editor/mesh/ops/edit.js";
import * as extrude from "../src/editor/mesh/ops/extrude.js";
import * as topology from "../src/editor/mesh/ops/topology.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Faces whose UV triangle has collapsed to a point. */
function degenerateFaces(mesh) {
  const bad = [];
  for (const face of mesh.faces) {
    const uvs = face.loops.map((loop) => loop.uv);
    const spanU = Math.max(...uvs.map((uv) => uv[0])) - Math.min(...uvs.map((uv) => uv[0]));
    const spanV = Math.max(...uvs.map((uv) => uv[1])) - Math.min(...uvs.map((uv) => uv[1]));
    if (spanU < 1e-9 && spanV < 1e-9) bad.push(face);
  }
  return bad;
}

/** A cube whose six faces are unwrapped, so any (0,0) corner stands out. */
function texturedCube(segments = 2) {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2, segments, segments, segments));
  if (degenerateFaces(mesh).length) throw new Error("the fixture itself has degenerate UVs");
  return mesh;
}

const selectAllFaces = (mesh) => {
  for (const face of mesh.faces) face.select = true;
  flushSelection(mesh, "face");
};
const selectAllEdges = (mesh) => {
  for (const edge of mesh.edges) edge.select = true;
  flushSelection(mesh, "edge");
};
const selectAllVerts = (mesh) => {
  for (const vert of mesh.verts) vert.select = true;
  flushSelection(mesh, "vert");
};
const selectSomeFaces = (mesh, count = 4) => {
  clearSelection(mesh);
  for (const face of [...mesh.faces].slice(0, count)) face.select = true;
  flushSelection(mesh, "face");
};

/**
 * Each case runs an operator and is judged only on whether UVs survived.
 * Correctness of the topology is `run-mesh-ops-test.mjs`'s job.
 */
const cases = [
  ["extrudeFaceRegion", () => { const m = texturedCube(); selectSomeFaces(m); extrude.extrudeFaceRegion(m); return m; }],
  ["extrudeFacesIndividual", () => { const m = texturedCube(); selectSomeFaces(m); extrude.extrudeFacesIndividual(m); return m; }],
  ["extrudeAlongNormals", () => { const m = texturedCube(); selectSomeFaces(m); extrude.extrudeAlongNormals(m); return m; }],
  ["extrudeEdges", () => { const m = texturedCube(); const e = [...m.edges].slice(0, 4); for (const edge of e) edge.select = true; flushSelection(m, "edge"); extrude.extrudeEdges(m, e); return m; }],
  ["insetFaces", () => { const m = texturedCube(); selectSomeFaces(m); extrude.insetFaces(m); return m; }],
  ["insetFaces individual", () => { const m = texturedCube(); selectSomeFaces(m); extrude.insetFaces(m, selected(m, "face"), { individual: true }); return m; }],
  ["subdivideFaces", () => { const m = texturedCube(); selectAllFaces(m); topology.subdivideFaces(m, selected(m, "face"), 1); return m; }],
  ["subdivideFaces x3", () => { const m = texturedCube(); selectAllFaces(m); topology.subdivideFaces(m, selected(m, "face"), 3); return m; }],
  ["bevelEdges seg=1", () => { const m = texturedCube(); selectAllEdges(m); topology.bevelEdges(m, [...m.edges], { width: 0.1, segments: 1 }); return m; }],
  ["bevelEdges seg=3", () => { const m = texturedCube(); selectAllEdges(m); topology.bevelEdges(m, [...m.edges], { width: 0.1, segments: 3 }); return m; }],
  ["loopCut", () => { const m = texturedCube(); const seed = [...m.edges][0]; topology.loopCut(m, seed, { cuts: 2 }); return m; }],
  ["offsetEdgeLoop", () => { const m = texturedCube(); topology.offsetEdgeLoop(m, [...m.edges][0], { factor: 0.4 }); return m; }],
  ["triangulateFaces", () => { const m = texturedCube(); selectAllFaces(m); cleanup.triangulateFaces(m); return m; }],
  ["trisToQuads", () => { const m = texturedCube(); selectAllFaces(m); cleanup.triangulateFaces(m); selectAllFaces(m); cleanup.trisToQuads(m); return m; }],
  ["pokeFaces", () => { const m = texturedCube(); selectAllFaces(m); cleanup.pokeFaces(m); return m; }],
  ["symmetrize", () => { const m = texturedCube(); cleanup.symmetrize(m, "+x"); return m; }],
  ["spinEdges", () => { const m = texturedCube(); const e = [...m.edges].slice(0, 3); cleanup.spinEdges(m, e, { steps: 4, angle: Math.PI / 2 }); return m; }],
  ["dissolveFaces", () => { const m = texturedCube(); selectSomeFaces(m, 2); edit.dissolveFaces(m); return m; }],
  ["dissolveEdges", () => { const m = texturedCube(); const e = [...m.edges].slice(0, 3); for (const edge of e) edge.select = true; flushSelection(m, "edge"); edit.dissolveEdges(m); return m; }],
  ["limitedDissolve", () => { const m = texturedCube(); selectAllFaces(m); edit.limitedDissolve(m, { selectionOnly: false }); return m; }],
  ["duplicateSelection", () => { const m = texturedCube(); selectSomeFaces(m); edit.duplicateSelection(m, "face"); return m; }],
  ["splitSelection", () => { const m = texturedCube(); selectSomeFaces(m); edit.splitSelection(m, "face"); return m; }],
  ["ripVerts", () => { const m = texturedCube(); const v = [...m.verts].slice(0, 1); for (const vert of v) vert.select = true; flushSelection(m, "vert"); edit.ripVerts(m, v, [1, 0, 0], { fill: true }); return m; }],
  ["mergeByDistance", () => { const m = texturedCube(); selectAllVerts(m); edit.mergeByDistance(m, 0.01, { selectionOnly: false }); return m; }],
  ["bridgeEdgeLoops", () => {
    // Two open rings to bridge: delete opposite faces of the cube first.
    const m = texturedCube(1);
    const faces = [...m.faces];
    const first = faces[0];
    const opposite = faces.find((face) => {
      const centre = faceVerts(face).reduce((sum, vert) => [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]], [0, 0, 0]);
      const other = faceVerts(first).reduce((sum, vert) => [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]], [0, 0, 0]);
      return centre.every((value, index) => Math.abs(value + other[index]) < 1e-6);
    });
    if (!opposite) return m;
    clearSelection(m);
    first.select = true;
    opposite.select = true;
    flushSelection(m, "face");
    edit.deleteSelection(m, "face", "faces");
    const border = [...m.edges].filter((edge) => edge.loops.length === 1);
    for (const edge of border) edge.select = true;
    flushSelection(m, "edge");
    cleanup.bridgeEdgeLoops(m, border);
    return m;
  }],
  ["fillHoles", () => {
    const m = texturedCube(1);
    clearSelection(m);
    [...m.faces][0].select = true;
    flushSelection(m, "face");
    edit.deleteSelection(m, "face", "faces");
    cleanup.fillHoles(m);
    return m;
  }],
  ["gridFill", () => {
    const m = texturedCube(1);
    clearSelection(m);
    [...m.faces][0].select = true;
    flushSelection(m, "face");
    edit.deleteSelection(m, "face", "faces");
    const border = [...m.edges].filter((edge) => edge.loops.length === 1);
    for (const edge of border) edge.select = true;
    flushSelection(m, "edge");
    cleanup.gridFill(m, border);
    return m;
  }],
  ["makeEdgeFace", () => {
    const m = texturedCube(1);
    clearSelection(m);
    [...m.faces][0].select = true;
    flushSelection(m, "face");
    edit.deleteSelection(m, "face", "faces");
    for (const edge of [...m.edges].filter((edge) => edge.loops.length === 1)) {
      edge.select = true;
      edge.v1.select = true;
      edge.v2.select = true;
    }
    flushSelection(m, "vert");
    edit.makeEdgeFace(m, "vert");
    return m;
  }],
];

console.log("\n--- do the operators keep UVs? ---");
for (const [name, run] of cases) {
  let mesh;
  try {
    mesh = run();
  } catch (error) {
    check(name, false, `threw: ${error.message}`);
    continue;
  }
  const bad = degenerateFaces(mesh);
  check(name, bad.length === 0, bad.length ? `${bad.length} of ${mesh.faces.size} faces lost their UVs` : `${mesh.faces.size} faces`);
}

/* -------------------------------------------------------------------------- */
/* Density, not just presence                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Texels per square unit for a face.
 *
 * "Did the face keep a UV" is the weaker question. An operator can hand every
 * face a perfectly valid mapping and still be wrong, because a face that shrank
 * while keeping its old UV range now carries the same slice of texture over
 * less surface — the checker doubles in size right where the operator ran. Only
 * comparing densities against the untouched surface catches that, and it is the
 * measurement behind both the inset and the bevel UV reports.
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
    world += Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ) / 2;
  }
  return world > 1e-12 ? uv / world : 0;
}

/** A 2-unit box face fills the whole tile: 1 / 4 texels per unit². */
const BOX_DENSITY = 0.25;
const densityReport = (mesh, tolerance) => {
  const off = [...mesh.faces].filter((face) => Math.abs(uvDensity(face) - BOX_DENSITY) > tolerance);
  const values = [...mesh.faces].map(uvDensity);
  return {
    off,
    detail: `${off.length}/${mesh.faces.size} off-density, range ${Math.min(...values).toFixed(4)}..${Math.max(...values).toFixed(4)}`,
  };
};

console.log("\n--- and at the RIGHT density? ---");

{
  // Inset, dragged the way the panel drags it: the ring travels, and the cap's
  // UVs are re-read from the mapping the original face had. Without that the
  // cap keeps the full face's UV range over a fraction of the area.
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const top = [...mesh.faces].find((face) => faceVerts(face).every((vert) => vert.co[1] > 0.9));
  clearSelection(mesh);
  top.select = true;
  flushSelection(mesh, "face");
  const result = extrude.insetFaces(mesh, selected(mesh, "face"));
  for (const [vert, offset] of result.perVertexOffsets) {
    vert.co = [vert.co[0] + offset[0] * 0.4, vert.co[1] + offset[1] * 0.4, vert.co[2] + offset[2] * 0.4];
  }
  extrude.updateSideUVs(result.sides);
  extrude.updateCapUVs(result.reprojected);
  const report = densityReport(mesh, 1e-6);
  check("inset keeps every face at the source density", report.off.length === 0, report.detail);
}

{
  // One beveled edge. The two faces beside it shrink away from the chamfer;
  // their corners have to pick up the UV their own mapping gives the new
  // position, or the island shears by the bevel width.
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const edge = [...mesh.edges].find((candidate) =>
    Math.abs(candidate.v1.co[0] - 1) < 1e-6 && Math.abs(candidate.v1.co[1] - 1) < 1e-6
    && Math.abs(candidate.v2.co[0] - 1) < 1e-6 && Math.abs(candidate.v2.co[1] - 1) < 1e-6);
  clearSelection(mesh);
  edge.select = true;
  flushSelection(mesh, "edge");
  topology.bevelEdges(mesh, selected(mesh, "edge"), { width: 0.4, segments: 1 });
  const report = densityReport(mesh, 1e-6);
  check("bevel leaves the faces it cut into at their own density", report.off.length === 0, report.detail);
}

{
  // Every edge, rounded. The corner patches cannot be isometric — a dome does
  // not flatten — but they must continue the surrounding island rather than
  // taking a fresh 0..1 tile, which put the entire texture on a corner a few
  // millimetres across (~50x the surrounding density).
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  selectAllEdges(mesh);
  topology.bevelEdges(mesh, [...mesh.edges], { width: 0.2, segments: 2 });
  const values = [...mesh.faces].map(uvDensity);
  const worst = Math.max(...values.map((value) => Math.max(value / BOX_DENSITY, BOX_DENSITY / value)));
  check(
    "a rounded bevel's corners stay near the surrounding density",
    worst < 2,
    `worst density ratio ${worst.toFixed(2)}x (range ${Math.min(...values).toFixed(4)}..${Math.max(...values).toFixed(4)})`,
  );
}

{
  // The last line of defence. A non-finite coordinate used to be serialised as
  // JSON `null`; the triangle buffers then refused to load while `editMesh`
  // read every null UV back as (0, 0), so one bad frame silently flattened a
  // mesh's whole layout and the next save wrote that back as the truth.
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  [...mesh.verts][0].co = [Number.NaN, 0, 0];
  let threw = false;
  try {
    assetFromMesh(mesh);
  } catch {
    threw = true;
  }
  check("saving refuses a mesh with a non-finite position", threw, threw ? "throws instead of writing nulls" : "wrote it anyway");
}

console.log(failures ? `\n${failures} FAILED` : "\nevery operator kept its UVs");
process.exit(failures ? 1 : 0);
