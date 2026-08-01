import * as THREE from "three/webgpu";

/**
 * Analytic two-bone IK — the solver behind foot planting and hand placement.
 *
 * Two bones and a target is the one IK case with a closed-form answer: the
 * triangle (root, mid, tip) is fully determined by its three side lengths, so
 * the joint angles come straight out of the law of cosines. No iteration, no
 * convergence threshold, no jitter. (CCD/FABRIK earn their keep on longer
 * chains; a leg is not one.)
 *
 * The construction, in world space:
 *   1. Bend the MID joint to the angle that makes the chain span the distance
 *      to the target, within the current bend plane.
 *   2. Swing the ROOT so the tip points at the target.
 *   3. Roll about the root→tip axis so the mid joint faces the pole.
 *
 * Step 1 has to be the mid joint and only the mid joint: rotating the root moves
 * the whole chain rigidly, so it cannot change the root-to-tip distance at all.
 * (Solvers that "open the root angle by the law of cosines" are quietly no-ops
 * that then look almost right because step 2 aims the limb anyway — the tip
 * lands short and nothing says why.)
 *
 * Doing (3) last, and about the root→tip axis, is what keeps it stable: the roll
 * cannot disturb the reach solved in (1) and (2), so an unreachable target or a
 * pole placed straight behind the joint degrades into a straight limb rather
 * than a spin.
 */

const _rootPos = new THREE.Vector3();
const _midPos = new THREE.Vector3();
const _tipPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _neg = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();
// Sinks for the decompose() inside rotateInWorld/alignTipRotation. Deliberately
// NOT shared with the solve's scratch vectors: those helpers run between steps
// that still hold live values in _a/_b/_c.
const _sinkPos = new THREE.Vector3();
const _sinkScale = new THREE.Vector3();

/** Angle between two vectors, guarded against the acos domain edge. */
function angleBetween(u, v) {
  const denom = u.length() * v.length();
  if (denom < 1e-8) return 0;
  return Math.acos(THREE.MathUtils.clamp(u.dot(v) / denom, -1, 1));
}

/** Interior angle opposite side `c` in a triangle with sides a, b, c. */
function lawOfCosines(a, b, c) {
  const denom = 2 * a * b;
  if (denom < 1e-8) return 0;
  return Math.acos(THREE.MathUtils.clamp((a * a + b * b - c * c) / denom, -1, 1));
}

/**
 * Rotates `bone` by `worldQuat` expressed in world space, writing the result
 * back as a local quaternion. `bone.matrixWorld` must be current on entry, and
 * is refreshed on exit so the next step of the solve sees the new pose.
 */
function rotateInWorld(bone, worldQuat) {
  bone.parent?.matrixWorld.decompose(_sinkPos, _parentQ, _sinkScale);
  if (!bone.parent) _parentQ.identity();
  bone.getWorldQuaternion(_worldQ);
  _worldQ.premultiply(worldQuat);
  bone.quaternion.copy(_parentQ.invert().multiply(_worldQ));
  bone.updateMatrixWorld(true);
}

/**
 * Solves the chain root → mid → tip onto `targetWorld`.
 *
 * @param root        upper bone (thigh / upper arm)
 * @param mid         lower bone (shin / forearm)
 * @param tip         end effector (foot / hand)
 * @param targetWorld world-space position the tip should reach
 * @param poleWorld   world-space hint the mid joint should point toward (optional)
 * @param weight      0..1 blend between the animated pose and the solved one
 * @param options     `{ softness }` — fraction of the chain length over which the
 *                    solve eases into full extension instead of snapping straight
 * @returns true if the solve ran
 */
export function solveTwoBoneIK(root, mid, tip, targetWorld, poleWorld = null, weight = 1, options = {}) {
  if (!root || !mid || !tip || !targetWorld || weight <= 0) return false;

  // The pose we are blending away from, captured before anything moves.
  const startRoot = _startRoot.copy(root.quaternion);
  const startMid = _startMid.copy(mid.quaternion);

  root.updateMatrixWorld(true);
  root.getWorldPosition(_rootPos);
  mid.getWorldPosition(_midPos);
  tip.getWorldPosition(_tipPos);
  _target.copy(targetWorld);

  const upperLen = _rootPos.distanceTo(_midPos);
  const lowerLen = _midPos.distanceTo(_tipPos);
  const reach = upperLen + lowerLen;
  if (reach < 1e-6) return false;

  let targetDist = _rootPos.distanceTo(_target);
  // Softness keeps the last few percent of extension from popping: as the target
  // approaches full reach the effective distance is compressed, so the limb
  // straightens asymptotically instead of hitting a hard stop and locking.
  const softness = THREE.MathUtils.clamp(options.softness ?? 0.03, 0, 0.5);
  const softStart = reach * (1 - softness);
  if (softness > 0 && targetDist > softStart) {
    const over = targetDist - softStart;
    const softZone = reach - softStart;
    targetDist = softStart + softZone * (1 - Math.exp(-over / softZone));
  }
  // Never let the triangle degenerate completely — a perfectly straight limb has
  // no bend plane, and the next frame's solve would have to guess one.
  targetDist = THREE.MathUtils.clamp(targetDist, Math.abs(upperLen - lowerLen) + 1e-4, reach - 1e-4);

  // --- 1. bend the mid joint ----------------------------------------------
  _a.copy(_midPos).sub(_rootPos); // root -> mid
  _b.copy(_tipPos).sub(_midPos); // mid -> tip

  // Current bend plane. A limb that starts perfectly straight has none, so fall
  // back to the pole (or an arbitrary perpendicular) to establish one.
  _axis.copy(_a).cross(_b);
  if (_axis.lengthSq() < 1e-10) {
    if (poleWorld) _axis.copy(_a).cross(_pole.copy(poleWorld).sub(_rootPos));
    if (_axis.lengthSq() < 1e-10) _axis.set(0, 0, 1).cross(_a);
    if (_axis.lengthSq() < 1e-10) _axis.set(1, 0, 0);
  }
  _axis.normalize();

  // Interior angle at the mid joint, i.e. between (mid→root) and (mid→tip).
  const currentMidAngle = angleBetween(_neg.copy(_a).negate(), _b);
  const desiredMidAngle = lawOfCosines(upperLen, lowerLen, targetDist);
  // Rotating (mid→tip) by +φ about the plane normal opens the turn angle from
  // the upper bone by φ, which CLOSES the interior angle by φ — hence the sign.
  rotateInWorld(mid, _q.setFromAxisAngle(_axis, currentMidAngle - desiredMidAngle));

  // --- 2. swing the chain onto the target ----------------------------------
  root.getWorldPosition(_rootPos);
  tip.getWorldPosition(_tipPos);
  _a.copy(_tipPos).sub(_rootPos);
  _b.copy(_target).sub(_rootPos);
  if (_a.lengthSq() > 1e-10 && _b.lengthSq() > 1e-10) {
    rotateInWorld(root, _q.setFromUnitVectors(_a.normalize(), _b.normalize()));
  }

  // --- 3. roll to face the pole --------------------------------------------
  if (poleWorld) {
    root.getWorldPosition(_rootPos);
    mid.getWorldPosition(_midPos);
    tip.getWorldPosition(_tipPos);
    _axis.copy(_tipPos).sub(_rootPos);
    if (_axis.lengthSq() > 1e-10) {
      _axis.normalize();
      // Both the current mid joint and the pole, projected onto the plane
      // perpendicular to root→tip: the angle between those projections is the
      // roll, and only the roll.
      _a.copy(_midPos).sub(_rootPos);
      _a.addScaledVector(_axis, -_a.dot(_axis));
      _b.copy(_pole.copy(poleWorld)).sub(_rootPos);
      _b.addScaledVector(_axis, -_b.dot(_axis));
      if (_a.lengthSq() > 1e-10 && _b.lengthSq() > 1e-10) {
        _a.normalize();
        _b.normalize();
        const sign = Math.sign(_c.copy(_a).cross(_b).dot(_axis)) || 1;
        const roll = angleBetween(_a, _b) * sign;
        rotateInWorld(root, _q.setFromAxisAngle(_axis, roll));
      }
    }
  }

  // --- blend back toward the animated pose ---------------------------------
  if (weight < 1) {
    root.quaternion.copy(startRoot.slerp(root.quaternion, weight));
    mid.quaternion.copy(startMid.slerp(mid.quaternion, weight));
    root.updateMatrixWorld(true);
  }
  return true;
}

/**
 * Orients `tip` to a world-space rotation, blended by `weight`. Used to keep a
 * foot flat on a slope after the leg has been solved, or a hand square to the
 * thing it's holding.
 */
export function alignTipRotation(tip, targetWorldQuat, weight = 1) {
  if (!tip || !targetWorldQuat || weight <= 0) return;
  tip.parent?.matrixWorld.decompose(_sinkPos, _parentQ, _sinkScale);
  if (!tip.parent) _parentQ.identity();
  _worldQ.copy(_parentQ).invert().multiply(targetWorldQuat);
  tip.quaternion.slerp(_worldQ, THREE.MathUtils.clamp(weight, 0, 1));
  tip.updateMatrixWorld(true);
}

const _startRoot = new THREE.Quaternion();
const _startMid = new THREE.Quaternion();
