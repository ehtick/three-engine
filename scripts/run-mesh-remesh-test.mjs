// Voxel remesh: does halving the voxel size actually give a finer mesh?
//
// The old wrapper around `remesh-threejs` saturated — a cube remeshed at 0.1
// and at 0.05 both came back with 60 faces — which is why the button read as
// doing nothing. So the headline check here is *responsiveness* to the
// parameter, alongside the usual "is the result a closed solid of about the
// right size".
//
// Run: node scripts/run-mesh-remesh-test.mjs

import * as THREE from "three/webgpu";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { faceVerts } from "../src/editor/mesh/bmesh.js";
import { faceTriangles } from "../src/editor/mesh/tessellate.js";
import { suggestedVoxelSize, voxelRemesh } from "../src/editor/mesh/ops/voxelRemesh.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const volumeOf = (mesh) => {
  let total = 0;
  for (const face of mesh.faces) {
    const ring = faceVerts(face);
    for (const [a, b, c] of faceTriangles(face)) total += dot(ring[a].co, cross(ring[b].co, ring[c].co)) / 6;
  }
  return total;
};
const openEdges = (mesh) => [...mesh.edges].filter((edge) => edge.loops.length !== 2).length;
const quadShare = (mesh) => {
  let quads = 0;
  for (const face of mesh.faces) if (face.loops.length === 4) quads++;
  return quads / mesh.faces.size;
};

/* -------------------------------------------------------------------------- */

console.log("\n--- the voxel size has to actually do something ---");
{
  const source = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const counts = [];
  for (const voxelSize of [0.4, 0.2, 0.1, 0.05]) {
    const started = performance.now();
    const result = voxelRemesh(source, { voxelSize });
    const elapsed = performance.now() - started;
    if (result.error) {
      check(`voxel ${voxelSize}`, false, result.error);
      continue;
    }
    counts.push({ voxelSize, faces: result.faces });
    console.log(`  voxel ${voxelSize}: ${result.faces} faces, ${result.verts} verts, grid ${result.grid.join("x")}, ${elapsed.toFixed(0)}ms`);
    check(`voxel ${voxelSize} is closed and manifold`, openEdges(result.mesh) === 0, `${openEdges(result.mesh)} open edges`);
    check(`voxel ${voxelSize} is outward-wound`, volumeOf(result.mesh) > 0, `volume ${volumeOf(result.mesh).toFixed(3)}`);
    check(`voxel ${voxelSize} is quad-dominant`, quadShare(result.mesh) > 0.9, `${(quadShare(result.mesh) * 100).toFixed(1)}% quads`);
  }

  for (let index = 1; index < counts.length; index++) {
    const coarse = counts[index - 1];
    const fine = counts[index];
    // Halving the voxel size quarters the cell area, so the face count should
    // rise by roughly 4x. Anything below 2x means the parameter is being
    // ignored, which is the exact failure being guarded against.
    const ratio = fine.faces / coarse.faces;
    check(
      `halving ${coarse.voxelSize} -> ${fine.voxelSize} refines the mesh`,
      ratio > 2,
      `${coarse.faces} -> ${fine.faces} faces (${ratio.toFixed(2)}x)`,
    );
  }
}

console.log("\n--- the shape survives ---");
{
  const source = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const result = voxelRemesh(source, { voxelSize: 0.08 });
  check("remesh succeeded", !result.error, result.error ?? "");
  if (!result.error) {
    const volume = volumeOf(result.mesh);
    // A 2x2x2 cube is 8 cubic units. The rebuild rounds the corners very
    // slightly and the smoothing pass pulls in a touch more.
    console.log(`  volume ${volume.toFixed(3)} against the original 8.000`);
    check("volume is within 6% of the original", Math.abs(volume - 8) / 8 < 0.06, `${volume.toFixed(3)}`);

    // Every vertex should be on the original surface, not floating off it.
    let worst = 0;
    for (const vert of result.mesh.verts) {
      const outside = Math.max(Math.abs(vert.co[0]), Math.abs(vert.co[1]), Math.abs(vert.co[2])) - 1;
      worst = Math.max(worst, Math.abs(outside));
    }
    check("no vertex strays more than a voxel from the surface", worst < 0.08 * 1.5, `worst ${worst.toFixed(4)}`);
  }
}

console.log("\n--- a sphere, and a mesh with awkward topology ---");
{
  const sphere = meshFromBufferGeometry(new THREE.SphereGeometry(1, 24, 16));
  const result = voxelRemesh(sphere, { voxelSize: 0.1 });
  check("sphere remesh succeeded", !result.error, result.error ?? "");
  if (!result.error) {
    console.log(`  sphere -> ${result.faces} faces`);
    check("sphere remesh is closed", openEdges(result.mesh) === 0, `${openEdges(result.mesh)} open edges`);
    const volume = volumeOf(result.mesh);
    const ideal = (4 / 3) * Math.PI;
    check("sphere volume is about 4/3 pi", Math.abs(volume - ideal) / ideal < 0.08, `${volume.toFixed(3)} vs ${ideal.toFixed(3)}`);
  }

  // A torus is the standard test that the inside/outside decision is topological
  // rather than "which way does the nearest triangle face".
  const torus = meshFromBufferGeometry(new THREE.TorusGeometry(1, 0.4, 16, 32));
  const holed = voxelRemesh(torus, { voxelSize: 0.08 });
  check("torus remesh succeeded", !holed.error, holed.error ?? "");
  if (!holed.error) {
    console.log(`  torus -> ${holed.faces} faces`);
    check("torus remesh is closed", openEdges(holed.mesh) === 0, `${openEdges(holed.mesh)} open edges`);
    const volume = volumeOf(holed.mesh);
    const ideal = 2 * Math.PI ** 2 * 1 * 0.4 ** 2;
    check("torus keeps its hole (volume matches the analytic torus)", Math.abs(volume - ideal) / ideal < 0.12, `${volume.toFixed(3)} vs ${ideal.toFixed(3)}`);
  }
}

console.log("\n--- guard rails ---");
{
  const source = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  console.log(`  suggested voxel size for a default cube: ${suggestedVoxelSize(source).toFixed(4)}`);
  const silly = voxelRemesh(source, { voxelSize: 0.0005 });
  check("an unaffordable voxel size is refused with advice, not a hang", !!silly.error && /Try/.test(silly.error), silly.error ?? "no error");
  const empty = voxelRemesh({ faces: new Set(), edges: new Set(), verts: new Set() }, { voxelSize: 0.1 });
  check("an empty mesh is refused", !!empty.error, empty.error ?? "no error");
}

console.log(failures ? `\n${failures} FAILED` : "\nvoxel remesh behaves");
process.exit(failures ? 1 : 0);
