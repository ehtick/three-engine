// Operators that rebuild topology: inset, bevel, extrude.
//
// These are checked the way a modeller checks them — is the result a closed,
// outward-facing solid of a sensible size, did the UVs survive — rather than by
// counting elements, because every one of the reported failures (a vanishing
// inset, a bevel that curves inward, faces losing their UVs) produced perfectly
// reasonable element counts.
//
// Run: node scripts/run-mesh-ops-test.mjs

import * as THREE from "three/webgpu";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { faceVerts } from "../src/editor/mesh/bmesh.js";
import { faceTriangles } from "../src/editor/mesh/tessellate.js";
import { insetFaces } from "../src/editor/mesh/ops/extrude.js";
import { bevelEdges } from "../src/editor/mesh/ops/topology.js";

let failures = 0;
export const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/* -------------------------------------------------------------------------- */
/* Shared measurements                                                         */
/* -------------------------------------------------------------------------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Signed volume via the divergence theorem. Positive means outward winding. */
export function meshVolume(mesh) {
  let total = 0;
  for (const face of mesh.faces) {
    const ring = faceVerts(face);
    for (const [a, b, c] of faceTriangles(face)) {
      total += dot(ring[a].co, cross(ring[b].co, ring[c].co)) / 6;
    }
  }
  return total;
}

export function meshArea(mesh) {
  let total = 0;
  for (const face of mesh.faces) {
    const ring = faceVerts(face);
    for (const [a, b, c] of faceTriangles(face)) {
      const n = cross(sub(ring[b].co, ring[a].co), sub(ring[c].co, ring[a].co));
      total += Math.sqrt(dot(n, n)) / 2;
    }
  }
  return total;
}

/** A closed solid has exactly two faces on every edge. */
export function openEdges(mesh) {
  let open = 0;
  for (const edge of mesh.edges) if (edge.loops.length !== 2) open++;
  return open;
}

/** Faces whose UVs are a single point — the signature of a dropped unwrap. */
export function facesWithoutUVs(mesh) {
  let count = 0;
  for (const face of mesh.faces) {
    const uvs = face.loops.map((loop) => loop.uv);
    const spanU = Math.max(...uvs.map((uv) => uv[0])) - Math.min(...uvs.map((uv) => uv[0]));
    const spanV = Math.max(...uvs.map((uv) => uv[1])) - Math.min(...uvs.map((uv) => uv[1]));
    if (spanU < 1e-9 && spanV < 1e-9) count++;
  }
  return count;
}

const cube = () => meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

/** Applies a macro's per-vertex offsets, the way the panel's drag does. */
function applyOffsets(result, thickness) {
  for (const [vert, offset] of result.perVertexOffsets) {
    vert.co = [
      vert.co[0] + offset[0] * thickness,
      vert.co[1] + offset[1] * thickness,
      vert.co[2] + offset[2] * thickness,
    ];
  }
}

/* -------------------------------------------------------------------------- */
/* Inset                                                                       */
/* -------------------------------------------------------------------------- */

console.log("\n--- inset one face of a 2x2x2 cube ---");
{
  const mesh = cube();
  const face = [...mesh.faces][0];
  face.select = true;
  const before = { volume: meshVolume(mesh), faces: mesh.faces.size };

  const result = insetFaces(mesh, [face]);
  check("inset succeeded", !result.error, result.error ?? "");
  if (!result.error) {
    console.log(`  maxThickness reported as ${result.maxThickness.toFixed(3)} (the face half-width is 1.0)`);
    check("collapse limit is about the face half-width", Math.abs(result.maxThickness - 1) < 0.15, `${result.maxThickness.toFixed(3)}`);

    applyOffsets(result, 0.3);
    check("mesh stays closed", openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
    check("volume is unchanged by a flat inset", Math.abs(meshVolume(mesh) - before.volume) < 1e-6, `${meshVolume(mesh).toFixed(4)} vs ${before.volume.toFixed(4)}`);

    // The inner cap should be a 1.4 x 1.4 square: 2 - 2*0.3 on each side.
    const cap = result.faces[0];
    const ring = faceVerts(cap).map((vert) => vert.co);
    const side = Math.hypot(...sub(ring[1], ring[0]));
    check("cap shrank by twice the thickness", Math.abs(side - 1.4) < 0.02, `side ${side.toFixed(3)}, expected 1.400`);
    check("cap did not collapse", side > 0.1, `side ${side.toFixed(3)}`);
    check("every face still has UVs", facesWithoutUVs(mesh) === 0, `${facesWithoutUVs(mesh)} faces with degenerate UVs`);
  }
}

/* -------------------------------------------------------------------------- */
/* Bevel                                                                       */
/* -------------------------------------------------------------------------- */

console.log("\n--- bevel all 12 edges of a 2x2x2 cube ---");
for (const segments of [1, 3]) {
  const mesh = cube();
  for (const edge of mesh.edges) edge.select = true;
  const before = meshVolume(mesh);
  const width = 0.3;

  const result = bevelEdges(mesh, [...mesh.edges], { width, segments });
  console.log(`  segments=${segments}: ${result.error ?? `${mesh.faces.size} faces, ${mesh.verts.size} verts`}`);
  check(`bevel(segments=${segments}) succeeded`, !result.error, result.error ?? "");
  if (result.error) continue;

  check(`bevel(${segments}) leaves a closed solid`, openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  check(`bevel(${segments}) stays outward-wound`, meshVolume(mesh) > 0, `volume ${meshVolume(mesh).toFixed(4)}`);

  // A bevel CUTS material off a convex solid, so the volume must fall — but only
  // a little. Curving inward instead of chamfering the corner scoops out far
  // more than the corner is worth, which is what the "goes inwards" report is.
  const after = meshVolume(mesh);
  const removed = before - after;
  console.log(`    volume ${before.toFixed(3)} -> ${after.toFixed(3)} (removed ${removed.toFixed(3)})`);
  check(`bevel(${segments}) removes material, not adds`, removed > 0, `removed ${removed.toFixed(4)}`);
  // Chamfering all 12 edges of a cube at width w removes roughly
  // 12 * (w^2/2) * (side - 2w) + corners ~= 0.6 at w=0.3. Ten times that means
  // the profile is bowing into the solid.
  check(`bevel(${segments}) removes a plausible amount`, removed < 1.5, `removed ${removed.toFixed(3)}, expected ~0.6`);

  // Every new vertex must lie on or outside the cube inscribed by the bevel —
  // an inward-curving profile puts them measurably closer to the centre.
  let deepest = 0;
  for (const vert of mesh.verts) {
    const [x, y, z] = vert.co;
    // Distance from the cube surface, negative when inside.
    const outside = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 1;
    deepest = Math.min(deepest, outside);
  }
  // A true round bevel of width w on a cube corner is the sphere of radius w
  // centred at (1-w, 1-w, 1-w), whose surface reaches w*(1 - 1/sqrt(3)) inside
  // the original faces. Sweeping the profile around the ORIGINAL vertex instead
  // — the "bevel goes inwards" bug — reaches roughly twice that.
  const ideal = width * (1 - 1 / Math.sqrt(3));
  console.log(`    deepest vertex sits ${(-deepest).toFixed(3)} inside the original surface (a true round bevel reaches ${ideal.toFixed(3)})`);
  check(`bevel(${segments}) follows a round profile, not an inward scoop`, -deepest <= ideal * 1.5, `${(-deepest).toFixed(3)} vs ${(ideal * 1.5).toFixed(3)} ceiling`);

  check(`bevel(${segments}) keeps UVs on every face`, facesWithoutUVs(mesh) === 0, `${facesWithoutUVs(mesh)} faces with degenerate UVs`);
}

console.log("\n--- bevel a single edge (partial selection must not cap anything shut) ---");
{
  const mesh = cube();
  const edge = [...mesh.edges][0];
  const result = bevelEdges(mesh, [edge], { width: 0.2, segments: 2 });
  check("single-edge bevel succeeded", !result.error, result.error ?? "");
  if (!result.error) {
    check("single-edge bevel leaves a closed solid", openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
    check("single-edge bevel stays outward-wound", meshVolume(mesh) > 0, `volume ${meshVolume(mesh).toFixed(4)}`);
    check("single-edge bevel removes material", meshVolume(mesh) < 8, `volume ${meshVolume(mesh).toFixed(4)}`);
    check("single-edge bevel keeps UVs", facesWithoutUVs(mesh) === 0, `${facesWithoutUVs(mesh)} degenerate`);
  }
}

console.log("\n--- bevel robustness sweep ---");
{
  const cases = [
    ["cube, all edges", () => cube(), (mesh) => [...mesh.edges]],
    ["cube, one face's edges", () => cube(), (mesh) => faceVerts([...mesh.faces][0]) && [...mesh.faces][0].loops.map((loop) => loop.e)],
    ["cube, two opposite edges", () => cube(), (mesh) => [[...mesh.edges][0], [...mesh.edges][6]]],
    ["sphere", () => meshFromBufferGeometry(new THREE.SphereGeometry(1, 12, 8)), (mesh) => [...mesh.edges].slice(0, 8)],
  ];
  for (const [name, build, pick] of cases) {
    for (const segments of [1, 2, 4]) {
      const mesh = build();
      const edges = pick(mesh);
      const before = openEdges(mesh);
      const result = bevelEdges(mesh, edges, { width: 0.15, segments });
      if (result.error) {
        check(`${name} seg=${segments}`, false, result.error);
        continue;
      }
      const after = openEdges(mesh);
      // A closed input must stay closed; an open one must not get MORE open.
      check(`${name} seg=${segments} opens no new holes`, after <= before, `${before} -> ${after} open edges`);
      check(`${name} seg=${segments} keeps UVs`, facesWithoutUVs(mesh) === 0, `${facesWithoutUVs(mesh)} degenerate`);
    }
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall operator checks passed");
process.exit(failures ? 1 : 0);
