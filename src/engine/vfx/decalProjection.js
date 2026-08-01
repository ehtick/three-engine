import * as THREE from "three/webgpu";
import { DEBUG_LAYER, EDITOR_LAYER } from "../editorLayers.js";

/**
 * Decal projection — bullet holes, blood splatter, scorch marks, footprints,
 * graffiti (roadmap item 13).
 *
 * A decal here is a CLIPPED COPY of the surface it sits on: the triangles of
 * whatever geometry falls inside the projector box, cut against that box and
 * re-UVed so the texture spans it. That is the same approach three's
 * `DecalGeometry` takes, and it is the right one for this renderer:
 *
 *   - screen-space (deferred) decals need a depth prepass and a G-buffer the
 *     forward path does not have, and they bleed onto anything that happens to
 *     be behind the surface,
 *   - a decal mesh follows the surface exactly, so it curves over a barrel and
 *     wraps a corner without any per-material work.
 *
 * The cost is that it only works on geometry whose vertices are known on the
 * CPU. Skinned meshes are skipped deliberately — their buffer holds the BIND
 * pose, so a decal projected onto a walking character would land on a
 * T-posed copy of it standing somewhere else entirely.
 */

const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _sphere = new THREE.Sphere();
const _decalSphere = new THREE.Sphere();
const _vector = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _faceNormal = new THREE.Vector3();

/** One clipped vertex: position + normal, both in decal space. */
const VERTEX_SIZE = 6;

/**
 * Meshes a decal could land on.
 *
 * The filters are all "would projecting onto this produce a lie":
 *   - the editor's own gizmos and the debug-draw layer are not scenery,
 *   - a batch PROXY duplicates its members (which are still in the scene, just
 *     invisible) — projecting onto both would double every triangle,
 *   - skinned and instanced meshes hold a buffer that is not where the geometry
 *     appears on screen,
 *   - anything explicitly opted out, including the decal batches themselves —
 *     a decal on a decal accumulates every time one is spawned.
 */
export function collectDecalTargets(engine, decalMatrix, size, { tag = "", ignoreTag = "decal-ignore" } = {}) {
  const scene = engine?.scene ?? engine; // tests hand this a bare Scene
  const targets = [];
  _decalSphere.center.setFromMatrixPosition(decalMatrix);
  const scale = _vector.setFromMatrixScale(decalMatrix);
  _decalSphere.radius = (Math.hypot(size.x, size.y, size.z) / 2) * Math.max(scale.x, scale.y, scale.z);
  const hasTag = (object, name) => {
    const entity = engine?.getEntity?.(entityIdOf(object));
    return !!entity?.hasTag?.(name);
  };

  scene.traverse((object) => {
    if (!object.isMesh) return;
    if (object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh) return;
    if (object.userData.noDecal || object.userData.batchProxy) return;
    if (object.layers.isEnabled(EDITOR_LAYER) || object.layers.isEnabled(DEBUG_LAYER)) return;
    // Hidden geometry is not a surface — unless it is hidden *because* it was
    // batched, in which case it is exactly the surface being drawn.
    if (object.visible === false && !object.userData.batchedInto) return;
    if (!object.geometry?.getAttribute?.("position")) return;
    if (tag && !hasTag(object, tag)) return;
    if (ignoreTag && hasTag(object, ignoreTag)) return;
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    _sphere.copy(object.geometry.boundingSphere).applyMatrix4(object.matrixWorld);
    if (!_sphere.intersectsSphere(_decalSphere)) return;
    targets.push(object);
  });
  return targets;
}

/** The entity a mesh belongs to. Meshes inside an imported model are children
 *  of the entity's object, so the id is on an ancestor rather than on them. */
function entityIdOf(object) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.entityId != null) return node.userData.entityId;
  }
  return null;
}

/**
 * Builds the decal geometry for one projector.
 *
 * `matrix` is the projector's world matrix. The projector looks along its own
 * **-Z**, matching every camera in three, so `object.lookAt(hitPoint + normal)`
 * aims a decal at a surface exactly the way it aims a camera at a subject. Its
 * box is `size` (local units, scaled by the matrix) and the texture spans the
 * box's XY.
 *
 * Returns world-space arrays ready to append to a batch, or null if nothing was
 * hit — which is the common case for a projector floating in mid-air and must
 * not produce an empty mesh with a live draw call.
 */
export function projectDecal({
  engine,
  targets = null,
  matrix,
  size = new THREE.Vector3(1, 1, 1),
  maxAngle = 90,
  offset = 0.01,
  tag = "",
}) {
  const meshes = targets ?? collectDecalTargets(engine, matrix, size, { tag });
  if (!meshes.length) return null;

  _inverse.copy(matrix).invert();
  const cosLimit = Math.cos(Math.min(179.9, Math.max(0, maxAngle)) * (Math.PI / 180));
  const half = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };

  const positions = [];
  const normals = [];
  const uvs = [];

  const polygon = [];

  for (const mesh of meshes) {
    _matrix.multiplyMatrices(_inverse, mesh.matrixWorld);
    _normalMatrix.getNormalMatrix(_matrix);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const index = geometry.getIndex();
    const triangles = index ? index.count / 3 : position.count / 3;

    for (let t = 0; t < triangles; t++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      _a.fromBufferAttribute(position, ia).applyMatrix4(_matrix);
      _b.fromBufferAttribute(position, ib).applyMatrix4(_matrix);
      _c.fromBufferAttribute(position, ic).applyMatrix4(_matrix);

      // Cheap reject before any clipping work: a triangle entirely on one side
      // of a slab can't contribute, and on a real level most of them are.
      if (
        (_a.x < -half.x && _b.x < -half.x && _c.x < -half.x) || (_a.x > half.x && _b.x > half.x && _c.x > half.x) ||
        (_a.y < -half.y && _b.y < -half.y && _c.y < -half.y) || (_a.y > half.y && _b.y > half.y && _c.y > half.y) ||
        (_a.z < -half.z && _b.z < -half.z && _c.z < -half.z) || (_a.z > half.z && _b.z > half.z && _c.z > half.z)
      ) {
        continue;
      }

      // Facing test against the projector's +Z (the direction it looks FROM).
      // Without it a decal sprayed at a thin wall also lands on the far side,
      // mirrored — visible from the next room and impossible to explain.
      _faceNormal.copy(_c).sub(_b).cross(_vector.copy(_a).sub(_b)).normalize();
      if (!(_faceNormal.z >= cosLimit)) continue;

      polygon.length = 0;
      pushVertex(polygon, _a, normal, ia, _normalMatrix, _faceNormal);
      pushVertex(polygon, _b, normal, ib, _normalMatrix, _faceNormal);
      pushVertex(polygon, _c, normal, ic, _normalMatrix, _faceNormal);

      const kept = clipToBox(polygon, half);
      if (kept.length < 9) continue; // fewer than 3 vertices survived

      // Fan-triangulate the convex clipped polygon.
      const vertices = kept.length / VERTEX_SIZE;
      for (let v = 1; v < vertices - 1; v++) {
        emit(kept, 0, positions, normals, uvs, matrix, size, offset);
        emit(kept, v, positions, normals, uvs, matrix, size, offset);
        emit(kept, v + 1, positions, normals, uvs, matrix, size, offset);
      }
    }
  }

  if (!positions.length) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3,
  };
}

function pushVertex(polygon, point, normalAttribute, index, normalMatrix, faceNormal) {
  polygon.push(point.x, point.y, point.z);
  if (normalAttribute) {
    _vector.fromBufferAttribute(normalAttribute, index).applyMatrix3(normalMatrix).normalize();
    polygon.push(_vector.x, _vector.y, _vector.z);
  } else {
    // Flat-shaded source geometry (a CSG result, a raw buffer): the face normal
    // is the only one there is, and a decal with no normal is a black patch
    // under any light.
    polygon.push(faceNormal.x, faceNormal.y, faceNormal.z);
  }
}

/** Position of vertex `v` back in world space, plus its UV inside the box. */
function emit(vertices, v, positions, normals, uvs, matrix, size, offset) {
  const base = v * VERTEX_SIZE;
  const nx = vertices[base + 3];
  const ny = vertices[base + 4];
  const nz = vertices[base + 5];
  // Lift along the surface normal, not along the projection axis: on a wall
  // seen at a glancing angle those are nearly perpendicular, and offsetting
  // along the projector would leave half the decal buried.
  _vector.set(vertices[base] + nx * offset, vertices[base + 1] + ny * offset, vertices[base + 2] + nz * offset);
  const u = vertices[base] / size.x + 0.5;
  const w = vertices[base + 1] / size.y + 0.5;
  _vector.applyMatrix4(matrix);
  positions.push(_vector.x, _vector.y, _vector.z);
  _a.set(nx, ny, nz).transformDirection(matrix);
  normals.push(_a.x, _a.y, _a.z);
  uvs.push(u, w);
}

/**
 * Sutherland-Hodgman clip of a convex polygon against the six box planes.
 *
 * Attributes are interpolated along each cut, so a triangle that crosses the
 * edge of the projector keeps a correct normal at the new vertices rather than
 * inheriting one of its corners'.
 */
const _clipA = [];
const _clipB = [];

function clipToBox(polygon, half) {
  let source = _clipA;
  let target = _clipB;
  source.length = 0;
  for (let i = 0; i < polygon.length; i++) source.push(polygon[i]);
  const planes = [
    [0, 1, half.x], [0, -1, half.x],
    [1, 1, half.y], [1, -1, half.y],
    [2, 1, half.z], [2, -1, half.z],
  ];
  for (const [axis, sign, limit] of planes) {
    target.length = 0;
    const count = source.length / VERTEX_SIZE;
    if (!count) return target;
    for (let i = 0; i < count; i++) {
      const currentBase = i * VERTEX_SIZE;
      const nextBase = ((i + 1) % count) * VERTEX_SIZE;
      // Distance to the plane, positive inside.
      const dCurrent = limit - sign * source[currentBase + axis];
      const dNext = limit - sign * source[nextBase + axis];
      const currentIn = dCurrent >= 0;
      const nextIn = dNext >= 0;
      if (currentIn) for (let k = 0; k < VERTEX_SIZE; k++) target.push(source[currentBase + k]);
      if (currentIn !== nextIn) {
        const t = dCurrent / (dCurrent - dNext);
        for (let k = 0; k < VERTEX_SIZE; k++) {
          target.push(source[currentBase + k] + (source[nextBase + k] - source[currentBase + k]) * t);
        }
      }
    }
    // Ping-pong between two module scratches rather than allocating — this runs
    // per triangle, six times, and a decal on dense geometry visits thousands.
    const swap = source;
    source = target;
    target = swap;
  }
  return source;
}

/**
 * Orientation for a decal spawned against a surface hit.
 *
 * `lookAt` puts +Z toward the target, and the projector looks along -Z, so
 * aiming at `position + normal` makes it look back down the normal — at the
 * surface. `roll` spins the texture around that axis; randomising it is what
 * stops twenty bullet holes from being visibly the same sprite.
 */
const _orient = new THREE.Object3D();

export function decalOrientation(normal, roll = 0, out = new THREE.Quaternion()) {
  const object = _orient;
  object.position.set(0, 0, 0);
  object.up.set(0, 1, 0);
  // A normal that is (anti)parallel to `up` makes lookAt's basis degenerate —
  // which is the floor and the ceiling, i.e. half the decals in a shooter.
  if (Math.abs(normal.y ?? 0) > 0.999) object.up.set(0, 0, 1);
  object.lookAt(normal.x ?? 0, normal.y ?? 0, normal.z ?? 0);
  object.rotateZ(roll);
  return out.copy(object.quaternion);
}
