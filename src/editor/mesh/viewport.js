/**
 * Viewport glue for the geometry editor: overlays, picking and camera framing.
 *
 * Kept apart from the React panel so the panel is about *interaction* — what a
 * key does, what a menu runs — rather than about buffer bookkeeping.
 */

import * as THREE from "three/webgpu";
import { MeshBVH } from "three-mesh-bvh";
import { faceVerts } from "./bmesh.js";
import { tessellate, wireSegments } from "./tessellate.js";
import { bufferGeometryFromMesh } from "./io.js";

export const WIRE_COLOR = 0x22272b;
export const SELECT_COLOR = 0xff9b42;
export const ACTIVE_COLOR = 0xffffff;
export const SEAM_COLOR = 0xd1453b;
export const SHARP_COLOR = 0x36c5f0;
// Blender draws unselected vertices as small dark dots, selected barely larger.
const VERTEX_PIXEL_RADIUS = 1.5;
const SELECTED_VERTEX_PIXEL_RADIUS = 2.2;

/* -------------------------------------------------------------------------- */
/* Buffers                                                                     */
/* -------------------------------------------------------------------------- */

/** Rebuilds the render geometry and the picking maps from the current mesh. */
export function rebuildRenderMesh(session) {
  const tessellation = tessellate(session.mesh);
  const previous = session.meshObject.geometry;
  session.meshObject.geometry = bufferGeometryFromMesh(session.mesh, tessellation);
  previous?.dispose?.();
  session.tessellation = tessellation;
  session.refreshModifierPreview?.();
}

/**
 * Fast path for a drag: positions move but topology does not, so the index
 * buffer and the picking maps stay valid and only the vertex arrays are
 * rewritten. Rebuilding the whole geometry each pointer move made large meshes
 * unusable to drag.
 */
export function refreshRenderPositions(session) {
  const { tessellation, meshObject } = session;
  const position = meshObject.geometry.getAttribute("position");
  let cursor = 0;
  for (const face of tessellation.faces) {
    for (const loop of face.loops) {
      position.setXYZ(cursor++, loop.v.co[0], loop.v.co[1], loop.v.co[2]);
    }
  }
  position.needsUpdate = true;
  meshObject.geometry.computeVertexNormals();
  meshObject.geometry.computeBoundingSphere();
  // The occlusion BVH indexes THESE positions. Topology changes get a brand new
  // geometry (see `rebuildRenderMesh`) so their cache dies with it, but this
  // path rewrites the same buffer in place and would otherwise leave a tree
  // describing where the vertices used to be — box select would then hide
  // whatever the mesh occluded before the drag.
  meshObject.geometry.userData.selectionBVH = null;
  session.refreshModifierPreview?.();
}

function setLinePositions(line, positions) {
  line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  line.geometry.computeBoundingSphere();
}

/**
 * Vertex dots are instanced spheres scaled to a constant pixel size, so they
 * stay legible whether the camera is a metre or a hundred metres away.
 */
function setVertexMarkers(markers, points, session, pixelRadius) {
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const viewportHeight = Math.max(session.canvas.clientHeight, 1);
  const orthographicScale = session.camera.isOrthographicCamera
    ? (session.camera.top - session.camera.bottom) / Math.max(session.camera.zoom, 1e-6) / viewportHeight
    : null;
  const perspectiveScale = session.camera.isPerspectiveCamera
    ? (2 * Math.tan(THREE.MathUtils.degToRad(session.camera.fov * 0.5))) / viewportHeight
    : 0;
  markers.userData.markerPoints = points;
  markers.userData.pixelRadius = pixelRadius;
  markers.count = Math.min(points.length, markers.instanceMatrix.count);
  const point = new THREE.Vector3();
  const world = new THREE.Vector3();
  // The dots are children of the mesh object, so their matrices are local — but
  // "how far is the camera" and "how big is a pixel" are world questions. The
  // world size is measured first and then converted back into local units, or a
  // scaled object would draw its vertices at the wrong size.
  const localPerWorld = session.localPerWorld ?? 1;
  for (let index = 0; index < markers.count; index++) {
    point.set(points[index][0], points[index][1], points[index][2]);
    world.copy(point).applyMatrix4(session.meshObject.matrixWorld);
    const size = Math.max((orthographicScale ?? session.camera.position.distanceTo(world) * perspectiveScale) * pixelRadius, 1e-5) * localPerWorld;
    scale.setScalar(size);
    matrix.compose(point, rotation, scale);
    markers.setMatrixAt(index, matrix);
  }
  markers.instanceMatrix.needsUpdate = true;
  markers.computeBoundingSphere();
}

export function refreshVertexMarkerScales(session) {
  for (const markers of [session.basePoints, session.vertexOverlay]) {
    setVertexMarkers(markers, markers.userData.markerPoints ?? [], session, markers.userData.pixelRadius ?? VERTEX_PIXEL_RADIUS);
  }
}

/**
 * Redraws every selection overlay.
 *
 * The wireframe carries one segment per *polygon* edge — triangulation
 * diagonals are not edges and simply never appear, which is what the old hidden
 * diagonal bookkeeping existed to fake.
 */
export function refreshOverlays(session) {
  const { mesh, mode } = session;

  // Sculpt mode hides the edit overlays, as Blender does. Beyond matching the
  // convention it is a necessity: dyntopo drives the vertex count into the tens
  // of thousands, and drawing a dot per vertex and a segment per edge on every
  // dab would dominate the frame.
  if (session.sculpting) {
    // Wireframe shading is the exception: with the surface invisible, hiding
    // the edges too would leave nothing on screen to sculpt against.
    session.wire.visible = !!session.wireframeShading;
    session.basePoints.visible = false;
    session.vertexOverlay.visible = false;
    session.activeOverlay.visible = false;
    session.faceOverlay.visible = false;
    session.edgeOverlay.visible = false;
    return;
  }
  session.wire.visible = true;

  const wire = wireSegments(mesh);
  setLinePositions(session.wire, wire.positions);

  const colors = new Float32Array(wire.edges.length * 6);
  const base = new THREE.Color(WIRE_COLOR);
  const selectedColor = new THREE.Color(SELECT_COLOR);
  const seam = new THREE.Color(SEAM_COLOR);
  const sharp = new THREE.Color(SHARP_COLOR);
  wire.edges.forEach((edge, index) => {
    // Edge selection is painted into the wireframe, which is depth tested, so
    // occluded edges stay hidden. The separate always-on-top overlay is kept
    // only for X-ray: drawing it in solid mode made the far side of the model
    // show through, which after an operation like bevel looks like a cage of
    // stray orange spikes rather than a selection.
    const paint = (vert) => {
      if (mode === "edge" && edge.select) return selectedColor;
      if (edge.seam) return seam;
      if (edge.sharp) return sharp;
      if (mode === "vert") return vert.select ? selectedColor : base;
      return base;
    };
    paint(edge.v1).toArray(colors, index * 6);
    paint(edge.v2).toArray(colors, index * 6 + 3);
  });
  session.wire.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const facePositions = [];
  for (const face of mesh.faces) {
    if (!face.select) continue;
    const ring = faceVerts(face);
    for (let index = 1; index + 1 < ring.length; index++) {
      facePositions.push(...ring[0].co, ...ring[index].co, ...ring[index + 1].co);
    }
  }
  setLinePositions(session.faceOverlay, facePositions);
  session.faceOverlay.visible = mode === "face" && facePositions.length > 0;

  const edgePositions = [];
  for (const edge of mesh.edges) {
    if (edge.select) edgePositions.push(...edge.v1.co, ...edge.v2.co);
  }
  setLinePositions(session.edgeOverlay, edgePositions);
  // See-through selection is an X-ray feature, not the default.
  session.edgeOverlay.visible = mode === "edge" && session.xray && edgePositions.length > 0;

  const allPoints = [];
  const selectedPoints = [];
  for (const vert of mesh.verts) {
    allPoints.push(vert.co);
    if (vert.select) selectedPoints.push(vert.co);
  }
  setVertexMarkers(session.basePoints, allPoints, session, VERTEX_PIXEL_RADIUS);
  setVertexMarkers(session.vertexOverlay, selectedPoints, session, SELECTED_VERTEX_PIXEL_RADIUS);
  session.basePoints.visible = mode === "vert";
  session.vertexOverlay.visible = mode === "vert" && selectedPoints.length > 0;

  const active = session.active;
  const activePoint = active && mesh.verts.has(active) ? [active.co] : [];
  setVertexMarkers(session.activeOverlay, activePoint, session, SELECTED_VERTEX_PIXEL_RADIUS * 1.35);
  session.activeOverlay.visible = mode === "vert" && activePoint.length > 0;
}

/** Applies the X-ray toggle to the surface and to depth testing on the dots. */
export function applyXray(session) {
  const materials = Array.isArray(session.meshObject.material) ? session.meshObject.material : [session.meshObject.material];
  const modifierCage = !!session.modifierPreviewObject?.visible;
  for (const material of materials) {
    // With a modifier preview the editable object is a pickable, invisible
    // cage; the separate evaluated object supplies the surface. Making this
    // material visible in X-ray would cover the evaluated result again.
    material.transparent = modifierCage || session.xray;
    material.opacity = modifierCage ? 0 : session.xray ? 0.38 : 1;
    material.depthWrite = !modifierCage && !session.xray;
    material.needsUpdate = true;
  }
  for (const markers of [session.basePoints, session.vertexOverlay, session.activeOverlay]) {
    if (!markers?.material) continue;
    markers.material.depthTest = !session.xray;
    markers.material.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------------- */
/* Picking                                                                     */
/* -------------------------------------------------------------------------- */

const vector = new THREE.Vector3();

/** The BMesh element under a raycast hit, honouring the active mode. */
export function pickElement(session, hit) {
  const face = session.tessellation.triFaces[hit.faceIndex];
  if (!face || !session.mesh.faces.has(face)) return null;
  if (session.mode === "face") return face;
  if (session.mode === "vert") {
    let best = null;
    for (const vert of faceVerts(face)) {
      const distance = vector.set(vert.co[0], vert.co[1], vert.co[2]).distanceToSquared(hit.point);
      if (!best || distance < best.distance) best = { vert, distance };
    }
    return best?.vert ?? null;
  }
  let best = null;
  const line = new THREE.Line3();
  const closest = new THREE.Vector3();
  for (const loop of face.loops) {
    const next = face.loops[(loop.index + 1) % face.loops.length];
    line.set(
      new THREE.Vector3(loop.v.co[0], loop.v.co[1], loop.v.co[2]),
      new THREE.Vector3(next.v.co[0], next.v.co[1], next.v.co[2]),
    );
    const distance = line.closestPointToPoint(hit.point, true, closest).distanceToSquared(hit.point);
    if (!best || distance < best.distance) best = { edge: loop.e, distance };
  }
  return best?.edge ?? null;
}

/** The face under a raycast hit, regardless of mode — the loop-cut seed needs it. */
export const pickFace = (session, hit) => session.tessellation.triFaces[hit.faceIndex] ?? null;

/** The polygon edge of `face` nearest to a point, for loop and ring selection. */
export function nearestEdgeOnFace(face, point) {
  const line = new THREE.Line3();
  const closest = new THREE.Vector3();
  let best = null;
  for (const loop of face.loops) {
    const next = face.loops[(loop.index + 1) % face.loops.length];
    line.set(
      new THREE.Vector3(loop.v.co[0], loop.v.co[1], loop.v.co[2]),
      new THREE.Vector3(next.v.co[0], next.v.co[1], next.v.co[2]),
    );
    const distance = line.closestPointToPoint(point, true, closest).distanceToSquared(point);
    if (!best || distance < best.distance) best = { edge: loop.e, distance };
  }
  return best?.edge ?? null;
}

/* -------------------------------------------------------------------------- */
/* Region selection                                                            */
/* -------------------------------------------------------------------------- */

const _ndc = new THREE.Vector3();
const _screen = new THREE.Vector2();

/**
 * World point → client pixels, into a scratch vector.
 *
 * Allocation-free on purpose: this runs once per element in the mesh on every
 * region gesture, and on a 38 k-vertex model the two `clone()`s this replaced
 * were ~150 k short-lived vectors per drag.
 */
const screenPosition = (point, camera, rect, target = _screen) => {
  _ndc.copy(point).project(camera);
  return target.set(
    (_ndc.x + 1) * rect.width * 0.5 + rect.left,
    (-_ndc.y + 1) * rect.height * 0.5 + rect.top,
  );
};

function pointInRegion(point, gesture) {
  if (gesture.kind === "circle") {
    return point.distanceToSquared(new THREE.Vector2(gesture.current.x, gesture.current.y)) <= gesture.radius ** 2;
  }
  if (gesture.kind === "lasso") {
    // Even-odd ray casting against the drawn polyline.
    const path = gesture.path;
    let inside = false;
    for (let index = 0, previous = path.length - 1; index < path.length; previous = index++) {
      const a = path[index];
      const b = path[previous];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }
  const left = Math.min(gesture.start.x, gesture.current.x);
  const right = Math.max(gesture.start.x, gesture.current.x);
  const top = Math.min(gesture.start.y, gesture.current.y);
  const bottom = Math.max(gesture.start.y, gesture.current.y);
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

/**
 * An occlusion test for the current camera pose, so a box select does not grab
 * the far side of a solid. With X-ray on, Blender selects through, and so does
 * this — the caller skips this entirely in that case.
 *
 * ⚠⚠ THIS USED TO BE A FULL-MESH RAYCAST PER POINT, AND IT HUNG THE EDITOR.
 * The old `isVisible` called `raycaster.intersectObject(session.meshObject)`,
 * which walks EVERY triangle, allocates an object per hit and sorts them — and
 * `elementsInRegion` called it for every element in the mesh (see the ordering
 * note there). On the Sibenik cathedral's wall mesh, 38,285 verts × 33,411
 * triangles is **1.3 billion** ray-triangle tests on the main thread for one
 * box select: not slow, indistinguishable from a hang, with no way to cancel it.
 *
 * Two changes make it cheap. The tree turns each query from O(triangles) into
 * O(log triangles), and `raycastFirst` with `far` clamped to just short of the
 * point stops at the FIRST occluder instead of collecting and sorting every
 * surface the ray crosses — a cathedral ray crosses a lot of them.
 *
 * Returns a closure because the per-gesture setup (building/fetching the tree,
 * resolving the camera) must not be repeated per point.
 */
function occlusionTest(session) {
  const meshObject = session.meshObject;
  const geometry = meshObject.geometry;
  // Cached on the geometry, so a topology rebuild (which mints a new geometry)
  // drops it for free; `refreshRenderPositions` clears it explicitly.
  const bvh = (geometry.userData.selectionBVH ??= new MeshBVH(geometry));
  // `material.side` decides what three's own raycast would have counted as an
  // occluder, and a multi-material mesh is raycast per group — approximated
  // here by the first slot, which is what the surface shading uses anyway.
  const material = Array.isArray(meshObject.material) ? meshObject.material[0] : meshObject.material;
  const side = material?.side ?? THREE.FrontSide;
  const raycaster = (session.selectionRaycaster ??= new THREE.Raycaster());
  const inverse = new THREE.Matrix4().copy(meshObject.matrixWorld).invert();
  const localRay = new THREE.Ray();
  const world = new THREE.Vector3();
  const ndc = new THREE.Vector2();

  return (point) => {
    world.copy(point).applyMatrix4(meshObject.matrixWorld);
    _ndc.copy(world).project(session.camera);
    if (_ndc.z < -1 || _ndc.z > 1) return false;
    // Via the camera rather than "origin → point": an ORTHOGRAPHIC camera's
    // rays do not share an origin, so a ray built from `camera.position` would
    // be wrong for every point off the view axis. `setFromCamera` handles both
    // projections; `applyMatrix4` re-normalises the direction, so distances
    // along the local ray are in local units and compare with the point's.
    raycaster.setFromCamera(ndc.set(_ndc.x, _ndc.y), session.camera);
    localRay.copy(raycaster.ray).applyMatrix4(inverse);
    const target = localRay.origin.distanceTo(point);
    if (target < 1e-9) return true;
    // Stop short of the point itself, or the surface the vertex sits ON counts
    // as its own occluder. Same tolerance the raycast version used.
    const far = target - Math.max(target * 1e-4, 1e-5);
    return far <= 0 || bvh.raycastFirst(localRay, side, 0, far) === null;
  };
}

/** Elements whose representative point falls inside a box/circle/lasso gesture. */
export function elementsInRegion(session, gesture) {
  const rect = session.canvas.getBoundingClientRect();
  const camera = session.camera;
  const matrixWorld = session.meshObject.matrixWorld;
  const local = new THREE.Vector3();
  const world = new THREE.Vector3();
  // ⚠ THE CHEAP TEST RUNS FIRST, AND THAT ORDERING IS THE FIX.
  // This used to occlusion-test every element and only then ask whether it was
  // inside the gesture at all — so a 10×10 pixel box paid the full-mesh
  // visibility cost for all 38 k vertices of the model instead of for the
  // handful it could possibly select. Projecting a point is a couple of matrix
  // multiplies; deciding whether it is hidden is a ray query. Do them in that
  // order.
  const candidates = [];
  const test = (co, element) => {
    local.set(co[0], co[1], co[2]);
    world.copy(local).applyMatrix4(matrixWorld);
    if (!pointInRegion(screenPosition(world, camera, rect), gesture)) return;
    candidates.push({ element, point: local.clone() });
  };
  if (session.mode === "vert") {
    for (const vert of session.mesh.verts) if (!vert.hide) test(vert.co, vert);
  } else if (session.mode === "edge") {
    for (const edge of session.mesh.edges) {
      if (edge.hide) continue;
      test([
        (edge.v1.co[0] + edge.v2.co[0]) * 0.5,
        (edge.v1.co[1] + edge.v2.co[1]) * 0.5,
        (edge.v1.co[2] + edge.v2.co[2]) * 0.5,
      ], edge);
    }
  } else {
    for (const face of session.mesh.faces) {
      if (face.hide) continue;
      const ring = faceVerts(face);
      const center = ring.reduce((sum, vert) => [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]], [0, 0, 0]);
      test(center.map((value) => value / ring.length), face);
    }
  }
  // X-ray selects through, so the tree is never built — which also means the
  // one expensive step is skipped entirely for the mode people reach for when
  // they want everything.
  if (session.xray) return candidates.map((candidate) => candidate.element);
  const visible = occlusionTest(session);
  const found = [];
  for (const { element, point } of candidates) if (visible(point)) found.push(element);
  return found;
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

/** Distance at which a sphere of `radius` fits comfortably in the viewport. */
export function framingDistance(camera, radius) {
  const fov = THREE.MathUtils.degToRad((camera.fov || 50) * 0.5);
  return Math.max(radius / Math.max(Math.sin(fov), 0.05), 0.5) * 1.6;
}

export function resizeGeometryCamera(camera, width, height, orthographicHeight = 10) {
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  if (camera.isOrthographicCamera) {
    const halfHeight = orthographicHeight * 0.5;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

/** Bounding sphere of the mesh as it is *now*, so focus tracks new geometry. */
export function meshBoundingSphere(mesh) {
  const points = [...mesh.verts].map((vert) => new THREE.Vector3(vert.co[0], vert.co[1], vert.co[2]));
  if (!points.length) return new THREE.Sphere(new THREE.Vector3(), 1);
  return new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
}

/** Bounding sphere of just the selection, for Blender's "frame selected". */
export function selectionBoundingSphere(session) {
  const points = [];
  for (const vert of session.mesh.verts) {
    if (vert.select) points.push(new THREE.Vector3(vert.co[0], vert.co[1], vert.co[2]));
  }
  if (!points.length) return null;
  return new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
}

/**
 * Re-frames the orbit camera on a sphere, preserving the current direction.
 *
 * `sphere` is in mesh-local space, because that is where the bounds are
 * measured; the camera is in world space. Now that the object keeps its own
 * transform in edit mode the two differ, so the conversion is a real one.
 */
export function frameSphere(session, sphere, { direction = null } = {}) {
  const { camera, controls } = session;
  const world = sphere.clone().applyMatrix4(session.meshObject.matrixWorld);
  const radius = Math.max(world.radius, 0.25);
  controls.target.copy(world.center);
  const current = direction ?? camera.position.clone().sub(controls.target).normalize();
  if (current.lengthSq() < 1e-6) current.set(0.6, 0.5, 0.7).normalize();
  const distance = framingDistance(camera, radius);
  camera.position.copy(world.center).addScaledVector(current, distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = Math.max(distance * 200, 100);
  camera.updateProjectionMatrix();
  controls.update();
  refreshVertexMarkerScales(session);
}

/**
 * The camera's own basis, for the View transform orientation.
 *
 * Returned in mesh-local space when a session is given, because that is the
 * space the transform maths and the vertex positions are in. Without the
 * conversion, "View" on a rotated object constrains along the wrong plane.
 */
export function cameraBasis(camera, session = null) {
  camera.updateMatrixWorld();
  const matrix = camera.matrixWorld;
  const axes = [
    new THREE.Vector3(matrix.elements[0], matrix.elements[1], matrix.elements[2]),
    new THREE.Vector3(matrix.elements[4], matrix.elements[5], matrix.elements[6]),
    new THREE.Vector3(matrix.elements[8], matrix.elements[9], matrix.elements[10]),
  ];
  return axes.map((axis) => {
    const local = session?.toLocalDirection ? session.toLocalDirection(axis).normalize() : axis;
    return [local.x, local.y, local.z];
  });
}
