/**
 * Viewport glue for the geometry editor: overlays, picking and camera framing.
 *
 * Kept apart from the React panel so the panel is about *interaction* — what a
 * key does, what a menu runs — rather than about buffer bookkeeping.
 */

import * as THREE from "three/webgpu";
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

const screenPosition = (point, camera, rect) => {
  const projected = point.clone().project(camera);
  return new THREE.Vector2(
    (projected.x + 1) * rect.width * 0.5 + rect.left,
    (-projected.y + 1) * rect.height * 0.5 + rect.top,
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
 * Whether a point is actually visible, so a box select does not grab the far
 * side of a solid. With X-ray on, Blender selects through, and so does this.
 */
function isVisible(session, point) {
  if (session.xray) return true;
  const world = session.meshObject.localToWorld(point.clone());
  const projected = world.clone().project(session.camera);
  if (projected.z < -1 || projected.z > 1) return false;
  const raycaster = (session.selectionRaycaster ??= new THREE.Raycaster());
  raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), session.camera);
  const hit = raycaster.intersectObject(session.meshObject, false)[0];
  if (!hit) return true;
  const target = raycaster.ray.origin.distanceTo(world);
  return hit.distance + Math.max(target * 1e-4, 1e-5) >= target;
}

/** Elements whose representative point falls inside a box/circle/lasso gesture. */
export function elementsInRegion(session, gesture) {
  const rect = session.canvas.getBoundingClientRect();
  const found = [];
  const test = (co, element) => {
    const point = new THREE.Vector3(co[0], co[1], co[2]);
    if (!isVisible(session, point)) return;
    // Projecting needs the world position, not the local one.
    const world = session.meshObject.localToWorld(point.clone());
    if (pointInRegion(screenPosition(world, session.camera, rect), gesture)) found.push(element);
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
