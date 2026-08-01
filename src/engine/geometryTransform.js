import * as THREE from "three/webgpu";

/**
 * The decision-making half of Apply Transform (Blender's Ctrl+A).
 *
 * Engine-side, not editor-side, for two reasons. It is the same arithmetic the
 * Instancer needs to fold a glTF node's matrix into the buffer it instances, so
 * an engine component would otherwise be importing from the editor. And, like
 * `build/`, everything here either produces the right geometry or silently
 * produces plausible, wrong geometry — so it is worth being reachable from a
 * headless test with no project on disk, no command bus and no browser.
 */

export const APPLY_MODES = ["all", "rotationScale", "rotation", "scale", "position"];

export const APPLY_MODE_LABELS = {
  all: "All Transforms",
  rotationScale: "Rotation & Scale",
  rotation: "Rotation",
  scale: "Scale",
  position: "Location",
};

const _zero = new THREE.Vector3(0, 0, 0);
const _one = new THREE.Vector3(1, 1, 1);
const _identity = new THREE.Quaternion();

/**
 * What `mode` bakes, what transform is left behind, and whether the result is
 * visually identical to what the author is looking at.
 *
 * An object matrix is `T · R · S`. Baking a SUFFIX of that product is exact —
 * the remaining factors still multiply in the same order — and baking a prefix
 * is not:
 *
 *   all            bake T·R·S, clear everything     exact
 *   rotationScale  bake R·S,   keep T               exact
 *   scale          bake S,     keep T·R             exact
 *   rotation       bake R,     keep T and S         exact only if S is uniform
 *   position       bake T,     keep R and S         exact only if R·S is identity
 *
 * Blender has exactly these five and exactly these two caveats, and is famously
 * quiet about them. The lossy pair are still worth having — they are what you
 * want on an object with no scale, or no rotation, which is most objects — so
 * they are offered with the caveat attached rather than hidden.
 */
export function applyPlan(transform, mode = "all") {
  const position = new THREE.Vector3().fromArray(transform.position ?? [0, 0, 0]);
  const quaternion = transform.quaternion
    ? new THREE.Quaternion().fromArray(transform.quaternion)
    : new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(transform.rotation ?? [0, 0, 0]));
  const scale = new THREE.Vector3().fromArray(transform.scale ?? [1, 1, 1]);

  const bakePosition = mode === "all" || mode === "position";
  const bakeRotation = mode === "all" || mode === "rotation" || mode === "rotationScale";
  const bakeScale = mode === "all" || mode === "scale" || mode === "rotationScale";

  const matrix = new THREE.Matrix4().compose(
    bakePosition ? position : _zero,
    bakeRotation ? quaternion : _identity,
    bakeScale ? scale : _one,
  );

  const next = {
    position: (bakePosition ? _zero : position).toArray(),
    rotation: bakeRotation ? [0, 0, 0] : [...(transform.rotation ?? [0, 0, 0])].slice(0, 3),
    scale: (bakeScale ? _one : scale).toArray(),
  };

  let warning = null;
  const uniformScale = Math.abs(scale.x - scale.y) < 1e-6 && Math.abs(scale.y - scale.z) < 1e-6;
  if (mode === "rotation" && !uniformScale) {
    warning = "Non-uniform scale: applying rotation alone changes how the object looks";
  }
  if (mode === "position") {
    const rotated = Math.abs(quaternion.w) < 1 - 1e-6;
    const scaled =
      Math.abs(scale.x - 1) > 1e-6 || Math.abs(scale.y - 1) > 1e-6 || Math.abs(scale.z - 1) > 1e-6;
    if (rotated || scaled) {
      warning = "Rotation or scale present: applying location alone moves the object";
    }
  }
  return { matrix, next, warning };
}

/** True for a matrix that would bake nothing — the operation is a no-op. */
export function isIdentityMatrix(matrix) {
  const e = matrix.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  }
  return true;
}

/**
 * Reverses every triangle's winding, in place.
 *
 * Needed after baking a matrix with a negative determinant — a mirrored scale,
 * which glTF nodes carry more often than anyone expects. `applyMatrix4`
 * transforms normals through the inverse-transpose, which is correct, and
 * leaves the index order alone, which is not: every face ends up back-facing
 * with a perfectly good normal, so the mesh renders inside-out and the normals
 * look innocent when you go to check them.
 */
export function flipWinding(geometry) {
  const index = geometry.getIndex();
  if (!index) return geometry;
  const array = index.array;
  for (let i = 0; i + 2 < array.length; i += 3) {
    const swap = array[i];
    array[i] = array[i + 2];
    array[i + 2] = swap;
  }
  index.needsUpdate = true;
  return geometry;
}

/** Bakes `matrix` into a COPY of `geometry`, winding included. */
export function bakeMatrixIntoGeometry(geometry, matrix) {
  const baked = geometry.clone();
  baked.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flipWinding(baked);
  baked.computeBoundingSphere();
  baked.computeBoundingBox();
  return baked;
}

/**
 * `object`'s matrix expressed in `ancestor`'s space, or null when it is already
 * identity (the common case, where a geometry clone would be pure waste).
 */
export function relativeMatrix(object, ancestor) {
  object.updateWorldMatrix(true, false);
  ancestor.updateWorldMatrix(true, false);
  const matrix = new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(object.matrixWorld);
  return isIdentityMatrix(matrix) ? null : matrix;
}
