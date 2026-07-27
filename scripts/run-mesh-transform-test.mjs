// Edit mode must leave the object's transform alone.
//
// The editor draws the mesh at the entity's own world matrix and keeps every
// vertex, operator and UV in local coordinates, so world and local are two
// different spaces that have to be converted between at the boundaries. They
// used to be the same space — the scene was rebuilt in the entity's local frame
// so the edited object could sit at the origin — and the tell was that rotating
// an object made the whole world appear to swing around it.
//
// These checks pin the conversions with a deliberately awkward transform:
// rotated, off-origin and non-uniformly scaled.
//
// Run: node scripts/run-mesh-transform-test.mjs

import * as THREE from "three/webgpu";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { cameraBasis, elementsInRegion, frameSphere, meshBoundingSphere } from "../src/editor/mesh/viewport.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const stubMarkers = () => ({
  userData: { markerPoints: [] },
  instanceMatrix: { count: 0, needsUpdate: false },
  count: 0,
  setMatrixAt() {},
  computeBoundingSphere() {},
});

/** The awkward transform: moved, turned and squashed. */
function transformedSession() {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const meshObject = new THREE.Mesh(new THREE.BufferGeometry());
  meshObject.matrixAutoUpdate = false;
  meshObject.matrix.compose(
    new THREE.Vector3(5, 3, -2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.9, -0.3)),
    new THREE.Vector3(2, 0.5, 1.5),
  );
  meshObject.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1000);
  camera.position.set(12, 9, 8);
  camera.lookAt(5, 3, -2);
  camera.updateMatrixWorld(true);

  const localFromWorld = new THREE.Matrix4().copy(meshObject.matrixWorld).invert();
  const linearToLocal = new THREE.Matrix3().setFromMatrix4(meshObject.matrixWorld).invert();
  const scale = new THREE.Vector3().setFromMatrixScale(meshObject.matrixWorld);

  return {
    mesh,
    meshObject,
    camera,
    mode: "vert",
    xray: true,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }) },
    controls: { target: new THREE.Vector3(), update() {} },
    // Enough of an InstancedMesh for the marker rescale that framing triggers.
    basePoints: stubMarkers(),
    vertexOverlay: stubMarkers(),
    toLocalPoint: (point) => point.clone().applyMatrix4(localFromWorld),
    toWorldPoint: (point) => (Array.isArray(point) ? new THREE.Vector3(...point) : point.clone()).applyMatrix4(meshObject.matrixWorld),
    toLocalDirection: (direction) => direction.clone().applyMatrix3(linearToLocal),
    localPerWorld: 3 / (scale.x + scale.y + scale.z),
  };
}

console.log("\n--- framing follows the object, not the origin ---");
{
  const session = transformedSession();
  session.refreshVertexMarkerScales = () => {};
  // frameSphere calls refreshVertexMarkerScales; stub the overlays it touches.
  session.basePoints.userData.markerPoints = [];
  session.vertexOverlay.userData.markerPoints = [];
  const localSphere = meshBoundingSphere(session.mesh);
  check("the mesh's local bounds are centred on its own origin", localSphere.center.length() < 1e-6, `${localSphere.center.toArray()}`);

  frameSphere(session, localSphere);
  const worldCentre = new THREE.Vector3(5, 3, -2);
  check(
    "the camera targets the object where it actually is",
    session.controls.target.distanceTo(worldCentre) < 1e-4,
    `target ${session.controls.target.toArray().map((v) => v.toFixed(2))}, expected ${worldCentre.toArray()}`,
  );
  check(
    "the camera is placed outside the object",
    session.camera.position.distanceTo(worldCentre) > localSphere.radius,
    `${session.camera.position.distanceTo(worldCentre).toFixed(2)}`,
  );
}

console.log("\n--- world and local round-trip exactly ---");
{
  const session = transformedSession();
  let worst = 0;
  for (const vert of session.mesh.verts) {
    const roundTripped = session.toLocalPoint(session.toWorldPoint(vert.co));
    worst = Math.max(worst, roundTripped.distanceTo(new THREE.Vector3(...vert.co)));
  }
  check("every vertex survives a world round-trip", worst < 1e-6, `worst drift ${worst.toExponential(2)}`);

  // A drag along the camera's right axis must move a vertex along that axis in
  // *world* space, whatever the object's own rotation and scale are.
  const worldRight = new THREE.Vector3().setFromMatrixColumn(session.camera.matrixWorld, 0);
  const localRight = session.toLocalDirection(worldRight.clone());
  const start = new THREE.Vector3(0.3, -0.2, 0.5);
  const moved = start.clone().addScaledVector(localRight, 0.25);
  const worldDelta = session.toWorldPoint(moved).sub(session.toWorldPoint(start));
  const alignment = worldDelta.clone().normalize().dot(worldRight.clone().normalize());
  check("a camera-right drag moves the vertex along camera-right in the world", Math.abs(alignment - 1) < 1e-6, `alignment ${alignment.toFixed(6)}`);
}

console.log("\n--- the view basis is expressed where the maths happens ---");
{
  const session = transformedSession();
  const basis = cameraBasis(session.camera, session);
  check("three axes are returned", basis.length === 3);
  for (const [index, axis] of basis.entries()) {
    const length = Math.hypot(...axis);
    check(`view axis ${index} is unit length in local space`, Math.abs(length - 1) < 1e-6, `${length.toFixed(6)}`);
  }
  // Converting back must line up with the camera's world axes again.
  for (const [index, axis] of basis.entries()) {
    const worldAxis = new THREE.Vector3(...axis).applyMatrix4(
      new THREE.Matrix4().extractRotation(session.meshObject.matrixWorld),
    );
    const expected = new THREE.Vector3().setFromMatrixColumn(session.camera.matrixWorld, index).normalize();
    // Scale skews the direction, so only check it lands in the same hemisphere
    // as the axis it came from — the exactness test is the drag check above.
    check(`view axis ${index} still points the camera's way`, worldAxis.normalize().dot(expected) > 0.5, `${worldAxis.dot(expected).toFixed(3)}`);
  }
}

console.log("\n--- box select works against where the object is drawn ---");
{
  const session = transformedSession();
  const rect = session.canvas.getBoundingClientRect();
  // A box over the whole viewport must catch every vertex; a box over an empty
  // corner far from the object must catch none. With the projection done in the
  // wrong space, both come out wrong.
  const all = elementsInRegion(session, {
    kind: "box",
    start: { x: rect.left, y: rect.top },
    current: { x: rect.left + rect.width, y: rect.top + rect.height },
  });
  check("a full-viewport box selects every vertex", all.length === session.mesh.verts.size, `${all.length} of ${session.mesh.verts.size}`);

  const none = elementsInRegion(session, {
    kind: "box",
    start: { x: -5000, y: -5000 },
    current: { x: -4900, y: -4900 },
  });
  check("a box nowhere near the object selects nothing", none.length === 0, `${none.length}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nedit mode keeps the object's transform");
process.exit(failures ? 1 : 0);
