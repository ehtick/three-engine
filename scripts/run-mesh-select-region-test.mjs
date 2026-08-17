// Box/circle/lasso selection in the geometry editor — is it CORRECT, and does
// it finish?
//
// Reported as "I open Sibenik in the geometry editor, try to select some
// vertices, and the whole app freezes indefinitely". It was not a lock-up and
// not an infinite loop: `elementsInRegion` occlusion-tested EVERY element in
// the mesh — before asking whether the element was inside the gesture at all —
// and each of those tests was a `Raycaster.intersectObject` over the whole
// mesh, which walks every triangle, allocates an object per hit and sorts them.
//
// On the cathedral's wall mesh (38,285 verts / 33,411 tris) one box select is
// 38,285 × 33,411 ≈ **1.3 billion** ray-triangle tests, synchronously, on the
// main thread. That is tens of minutes with no way to cancel — indistinguishable
// from a hang, which is exactly how it was reported.
//
// This file guards BOTH halves, because either one alone is a trap:
//   - the PERF cases would pass on a fast-but-wrong implementation that simply
//     stopped occlusion-testing (X-ray behaviour for everyone),
//   - the CORRECTNESS cases would pass on the original O(n·m) code.
//
// Run: node scripts/run-mesh-select-region-test.mjs

import * as THREE from "three/webgpu";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { elementsInRegion, refreshRenderPositions } from "../src/editor/mesh/viewport.js";
import { tessellate } from "../src/editor/mesh/tessellate.js";
import { bufferGeometryFromMesh } from "../src/editor/mesh/io.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const WIDTH = 800;
const HEIGHT = 600;

/**
 * A geometry-editor session, reduced to exactly what the selection path reads.
 *
 * Deliberately NOT the real panel: this has to run in node, and the fields
 * below are the whole contract `elementsInRegion` has with its session.
 */
function makeSession(geometry, { mode = "vert", xray = false, cameraZ = 6 } = {}) {
  const mesh = meshFromBufferGeometry(geometry);
  const tessellation = tessellate(mesh);
  const meshObject = new THREE.Mesh(
    bufferGeometryFromMesh(mesh, tessellation),
    new THREE.MeshStandardMaterial({ side: THREE.FrontSide }),
  );
  meshObject.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 1000);
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return {
    mesh,
    tessellation,
    meshObject,
    camera,
    mode,
    xray,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }) },
    refreshModifierPreview: () => {},
  };
}

/** A gesture covering the whole viewport. */
const wholeScreen = () => ({ kind: "box", start: { x: 0, y: 0 }, current: { x: WIDTH, y: HEIGHT } });
/** A small box around the middle of the viewport. */
const smallBox = (halfSize = 12) => ({
  kind: "box",
  start: { x: WIDTH / 2 - halfSize, y: HEIGHT / 2 - halfSize },
  current: { x: WIDTH / 2 + halfSize, y: HEIGHT / 2 + halfSize },
});

/* -------------------------------------------------------------------------- */
/* Correctness — occlusion still decides what a box select grabs               */
/* -------------------------------------------------------------------------- */

/**
 * Two parallel planes facing the camera. The near one hides the far one
 * completely, so "how many vertices does a full-screen box select return" is a
 * direct read of whether occlusion is being honoured at all.
 */
function twoPlanes() {
  const near = new THREE.PlaneGeometry(4, 4, 1, 1).translate(0, 0, 1);
  const far = new THREE.PlaneGeometry(4, 4, 1, 1).translate(0, 0, -1);
  const merged = new THREE.BufferGeometry();
  const positions = new Float32Array([
    ...near.getAttribute("position").array,
    ...far.getAttribute("position").array,
  ]);
  const uvs = new Float32Array([...near.getAttribute("uv").array, ...far.getAttribute("uv").array]);
  const nearIndex = [...near.getIndex().array];
  const offset = near.getAttribute("position").count;
  const index = [...nearIndex, ...[...far.getIndex().array].map((i) => i + offset)];
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(index);
  merged.computeVertexNormals();
  return merged;
}

{
  const session = makeSession(twoPlanes());
  const hits = elementsInRegion(session, wholeScreen());
  // The two planes weld to 8 distinct kernel vertices (4 near, 4 far).
  check(
    "a full-screen box selects only the NEAR plane's vertices",
    hits.length === 4,
    `selected ${hits.length} of ${session.mesh.verts.size}`,
  );
  const allInFront = hits.every((vert) => vert.co[2] > 0);
  check("every selected vertex is on the near plane", allInFront);
}

{
  const session = makeSession(twoPlanes(), { xray: true });
  const hits = elementsInRegion(session, wholeScreen());
  check(
    "X-ray selects through — both planes",
    hits.length === 8,
    `selected ${hits.length} of ${session.mesh.verts.size}`,
  );
}

{
  // A box that covers nothing must select nothing, whatever is behind it.
  const session = makeSession(twoPlanes());
  const hits = elementsInRegion(session, { kind: "box", start: { x: 0, y: 0 }, current: { x: 2, y: 2 } });
  check("an empty box selects nothing", hits.length === 0, `selected ${hits.length}`);
}

{
  // Edge and face modes go through the same path with a different representative
  // point; a regression that broke only one of them would otherwise ship.
  const edges = elementsInRegion(makeSession(twoPlanes(), { mode: "edge" }), wholeScreen());
  const faces = elementsInRegion(makeSession(twoPlanes(), { mode: "face" }), wholeScreen());
  check("edge mode selects only the near plane's edges", edges.length === 4, `selected ${edges.length}`);
  check("face mode selects only the near plane's face", faces.length === 1, `selected ${faces.length}`);
}

/* -------------------------------------------------------------------------- */
/* The cache must not outlive the positions it indexes                        */
/* -------------------------------------------------------------------------- */

{
  // Drag the near plane BEHIND the far one via the positions-only fast path.
  // If the occlusion tree is still the pre-drag one, the vertices that are now
  // hidden will still read as visible.
  const session = makeSession(twoPlanes());
  elementsInRegion(session, wholeScreen()); // build the tree at the old pose
  for (const vert of session.mesh.verts) {
    if (vert.co[2] > 0) vert.co[2] = -2; // near plane -> furthest away
  }
  refreshRenderPositions(session);
  const hits = elementsInRegion(session, wholeScreen());
  const allBehind = hits.every((vert) => vert.co[2] > -2);
  check(
    "moving geometry invalidates the occlusion cache",
    hits.length === 4 && allBehind,
    `selected ${hits.length}, all on the now-nearest plane: ${allBehind}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Performance — the actual bug                                                */
/* -------------------------------------------------------------------------- */

/** A dense sphere, in the same order of magnitude as the reported wall mesh. */
function denseGeometry() {
  // 160 x 160 segments ≈ 51 k triangles / 25 k welded verts. Sibenik's wall mesh
  // is 33 k triangles / 38 k verts, so this is not a scaled-down stand-in.
  return new THREE.SphereGeometry(1.5, 160, 160);
}

const dense = denseGeometry();
const denseTris = dense.getIndex().count / 3;

{
  const session = makeSession(dense);
  const verts = session.mesh.verts.size;
  const started = performance.now();
  const hits = elementsInRegion(session, smallBox());
  const elapsed = performance.now() - started;
  // The old code was ~verts × triangles ray-triangle tests here. Even at an
  // optimistic 50 M tests/second that is over four minutes; the bound below is
  // deliberately loose (it includes the one-off tree build) and still fails the
  // old implementation by three orders of magnitude.
  check(
    "a SMALL box on a dense mesh finishes promptly",
    elapsed < 3000,
    `${Math.round(elapsed)} ms for ${verts} verts / ${denseTris} tris, ${hits.length} selected`,
  );
  check("a small box selects a small number of vertices", hits.length > 0 && hits.length < verts / 10, `${hits.length}`);
}

{
  // The worst case for the fix: every vertex survives the cheap screen test, so
  // every one of them takes a ray query. This is the case the reorder alone
  // would NOT have saved, and it is why the tree is here.
  const session = makeSession(dense);
  const started = performance.now();
  const hits = elementsInRegion(session, wholeScreen());
  const elapsed = performance.now() - started;
  check(
    "a FULL-SCREEN box on a dense mesh finishes promptly",
    elapsed < 5000,
    `${Math.round(elapsed)} ms, ${hits.length} of ${session.mesh.verts.size} selected`,
  );
  // A sphere from outside: about half of it faces the camera.
  const fraction = hits.length / session.mesh.verts.size;
  check(
    "a full-screen box on a sphere selects roughly the facing half",
    fraction > 0.2 && fraction < 0.75,
    `${(fraction * 100).toFixed(1)}%`,
  );
}

{
  const session = makeSession(dense, { xray: true });
  const started = performance.now();
  const hits = elementsInRegion(session, wholeScreen());
  const elapsed = performance.now() - started;
  check(
    "X-ray over a dense mesh selects everything, fast",
    elapsed < 2000 && hits.length === session.mesh.verts.size,
    `${Math.round(elapsed)} ms, ${hits.length} of ${session.mesh.verts.size}`,
  );
}

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
