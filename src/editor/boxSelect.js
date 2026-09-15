// @ts-check
import * as THREE from "three/webgpu";
import { isPickVisible } from "./pickVisibility.js";
import { findEntityId } from "./pickTarget.js";
import { UI_LAYER } from "../engine/editorLayers.js";
import { ndcDepthRange } from "../engine/reversedDepth.js";

/**
 * Rubber-band ("marquee") selection in the 3D viewport.
 *
 * The obvious implementation — project each object's bounding box to screen and
 * intersect two 2D rects — is wrong the moment the camera is inside or behind
 * something: a corner behind the near plane projects to a MIRRORED point, so a
 * wall you are standing next to reports a screen rect on the wrong side of the
 * viewport, and the room you are in is either always or never selected. So the
 * test runs in 3D instead: the marquee is turned into a frustum and every
 * candidate's world AABB is tested against it. Behind-the-camera geometry falls
 * out for free, and the same code works for an orthographic axis view.
 *
 * "Touch" semantics, like Blender and Godot: a box that grazes the marquee is
 * selected. Requiring full containment makes large objects nearly unselectable.
 *
 * Cost is split deliberately. The candidate list (one AABB per drawn mesh) is
 * built ONCE at drag start — the camera is pinned while the marquee is up and
 * the scene isn't changing — so each pointermove is 6 plane tests per candidate
 * and nothing else. Rebuilding candidates per move would re-walk the scene
 * graph 60 times a second on a scene with thousands of meshes.
 */

const NDC_CORNERS = [
  [0, 0], // minX, minY
  [1, 0], // maxX, minY
  [1, 1], // maxX, maxY
  [0, 1], // minX, maxY
];

const _near = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _far = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _centre = new THREE.Vector3();

/**
 * The view frustum carved out by a screen rectangle.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect  NDC, y up, both in [-1, 1]
 * @param {any} camera
 * @param {THREE.Frustum} [target]
 */
export function frustumFromNdcRect(rect, camera, target = new THREE.Frustum()) {
  const x = [rect.minX, rect.maxX];
  const y = [rect.minY, rect.maxY];
  // NDC z of near/far depends on the camera: -1/1 WebGL, 0/1 WebGPU, 1/0
  // reversed. A hard-coded -1 under a reversed camera unprojects BEHIND it.
  const depth = ndcDepthRange(camera);
  _centre.set(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const [ix, iy] = NDC_CORNERS[i];
    _near[i].set(x[ix], y[iy], depth.near).unproject(camera);
    _far[i].set(x[ix], y[iy], depth.far).unproject(camera);
    _centre.add(_near[i]).add(_far[i]);
  }
  _centre.multiplyScalar(1 / 8);

  const faces = [
    [_near[0], _near[3], _far[0]], // left
    [_near[1], _near[2], _far[1]], // right
    [_near[0], _near[1], _far[0]], // bottom
    [_near[3], _near[2], _far[3]], // top
    [_near[0], _near[1], _near[2]], // near
    [_far[0], _far[1], _far[2]], // far
  ];
  for (let i = 0; i < 6; i++) {
    const [a, b, c] = faces[i];
    const plane = target.planes[i];
    plane.setFromCoplanarPoints(a, b, c);
    // The winding that makes a normal point inward flips between the six faces
    // AND between a perspective and an orthographic camera. Rather than get
    // twelve cross products right by hand and have an axis view quietly select
    // the complement of the marquee, aim every normal at the frustum's own
    // centroid — which is the convention `Frustum.intersectsBox` assumes.
    if (plane.distanceToPoint(_centre) < 0) plane.negate();
  }
  return target;
}

/** World-space AABB of one drawable, or null when it has no usable geometry. */
function worldBoxOf(object) {
  // An InstancedMesh's geometry box covers one instance at the origin; only
  // the mesh's own box accounts for where the instances actually are.
  if (object.isInstancedMesh) {
    if (!object.boundingBox) object.computeBoundingBox();
    return object.boundingBox ? object.boundingBox.clone().applyMatrix4(object.matrixWorld) : null;
  }
  const geometry = object.geometry;
  if (!geometry) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingBox) return null;
  return geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
}

/**
 * One AABB per thing the marquee may catch, tagged with the entity that owns it.
 *
 * Per DRAWABLE, not per entity: a group's union box spans everything under it,
 * so testing entities would let a marquee in an empty corner of the viewport
 * catch a prefab whose geometry is nowhere near it. Several boxes can carry the
 * same id; the caller de-duplicates.
 *
 * @param {any} root      scene root to walk
 * @param {Iterable<any>} [entities]  engine entities, for lights/cameras (below)
 */
export function collectSelectionCandidates(root, entities) {
  const out = [];
  if (!root) return out;
  root.updateMatrixWorld();

  root.traverse((object) => {
    // Batch/merge proxies draw other entities' geometry from the scene ROOT, so
    // their box is a whole city block and belongs to nobody. Their members are
    // still in the graph (hidden, which `isPickVisible` forgives) and those are
    // what we want — the same contract picking relies on. See engine/batching.js.
    if (object.userData?.batchProxy || object.userData?.mergeProxy) return;
    if (!(object.isMesh || object.isInstancedMesh || object.isPoints || object.isLine)) return;
    // UI meshes live in pixel coordinates under their own ortho camera. Their
    // world positions are meaningless next to scene geometry, so a marquee
    // would catch them at random distances from anything the user can see.
    if (object.layers?.isEnabled?.(UI_LAYER)) return;
    if (!isPickVisible(object)) return;
    const id = findEntityId(object);
    if (!id) return;
    const box = worldBoxOf(object);
    if (box && !box.isEmpty()) out.push({ id, box });
  });

  // Lights and cameras have no geometry of their own — their only presence is a
  // helper drawn for the SELECTED one, which is no use for selecting them in the
  // first place. Give each a degenerate box at its world origin so a marquee
  // dragged across a lamp picks it up the way it does in every other editor.
  for (const entity of entities ?? []) {
    const light = entity.getComponent?.("light");
    const camera = entity.getComponent?.("camera");
    if (!light?.light && !camera?.camera) continue;
    if (!isPickVisible(entity.object3D)) continue;
    const point = entity.object3D.getWorldPosition(new THREE.Vector3());
    out.push({ id: entity.id, box: new THREE.Box3(point, point.clone()) });
  }
  return out;
}

/**
 * Entity ids whose geometry touches the frustum.
 *
 * @param {Array<{id: string, box: THREE.Box3}>} candidates
 * @param {THREE.Frustum} frustum
 * @returns {Set<string>}
 */
export function idsInFrustum(candidates, frustum) {
  const ids = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) continue;
    if (frustum.intersectsBox(candidate.box)) ids.add(candidate.id);
  }
  return ids;
}

/**
 * Screen rectangle (canvas pixels, origin top-left) → NDC rectangle.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} rect
 * @param {{width:number, height:number}} size  canvas CSS size
 */
export function ndcRectFromPixels(rect, size) {
  const width = size.width || 1;
  const height = size.height || 1;
  return {
    minX: (rect.left / width) * 2 - 1,
    maxX: (rect.right / width) * 2 - 1,
    // Screen y grows downward, NDC y grows upward: the BOTTOM edge is minY.
    minY: -(rect.bottom / height) * 2 + 1,
    maxY: -(rect.top / height) * 2 + 1,
  };
}
