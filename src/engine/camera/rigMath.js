import * as THREE from "three/webgpu";

/**
 * The maths behind camera rigs, kept free of components and three.js scene
 * graph so the parts that are easy to get subtly wrong are easy to test.
 *
 * The recurring one is damping. `lerp(current, target, dt * k)` is the version
 * everyone writes first, and it ties the camera's behaviour to the frame rate:
 * the same rig glides on a 144Hz monitor and snaps on a 30Hz one, and the
 * difference is invisible on the machine it was authored on. Exponential decay
 * has the same feel and is frame-rate independent, which is the whole reason
 * these are functions and not one-liners at the call site.
 */

/**
 * Fraction of the remaining distance to cover this frame.
 *
 * `damping` is a time constant in seconds: after `damping` seconds about 63% of
 * the gap is closed, after 3× about 95%. Zero (or negative) means no damping —
 * snap straight to the target.
 */
export function dampFactor(damping, dt) {
  if (!(damping > 0)) return 1;
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt / damping);
}

/** Scalar damping toward `target`. */
export function damp(current, target, damping, dt) {
  return current + (target - current) * dampFactor(damping, dt);
}

/**
 * Damps an angle, taking the short way round.
 *
 * Without the wrap a camera whose yaw crosses ±180° spins all the way back the
 * other way — a full rotation of the world, from a one-degree change.
 */
export function dampAngle(current, target, damping, dt) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  return current + delta * dampFactor(damping, dt);
}

/**
 * Per-axis damped move of `out` toward `target`.
 *
 * `damping` may be a single number or a `[x, y, z]` triple. The triple is what
 * makes a follow camera feel deliberate rather than floaty: vertical damping
 * wants to be much stronger than horizontal, so stairs and small hops don't
 * bob the camera while a turn still reads as responsive.
 */
export function dampVector3(out, target, damping, dt) {
  if (Array.isArray(damping)) {
    out.x = damp(out.x, target.x, damping[0], dt);
    out.y = damp(out.y, target.y, damping[1] ?? damping[0], dt);
    out.z = damp(out.z, target.z, damping[2] ?? damping[0], dt);
    return out;
  }
  const t = dampFactor(damping, dt);
  out.x += (target.x - out.x) * t;
  out.y += (target.y - out.y) * t;
  out.z += (target.z - out.z) * t;
  return out;
}

const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => t * t * (3 - 2 * t),
};

/** Maps raw blend progress 0..1 through the named easing curve. */
export function blendCurve(t, style = "easeInOut") {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return (EASINGS[style] ?? EASINGS.easeInOut)(clamped);
}

export const BLEND_STYLES = Object.keys(EASINGS);

/**
 * Boom-arm offset: where the camera sits relative to its pivot, given a yaw
 * (around world +Y), a pitch, and an arm length.
 *
 * Yaw first then pitch, both applied to a backwards vector — the order matters.
 * Pitching first and then yawing tilts the horizon as you orbit, which is the
 * "why is my camera rolling" bug.
 */
export function orbitOffset(out, yaw, pitch, distance) {
  const cosPitch = Math.cos(pitch);
  out.set(
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(yaw) * cosPitch,
  );
  return out.multiplyScalar(distance);
}

/**
 * Pulls a camera in until nothing solid is between it and the thing it is
 * filming.
 *
 * Sweeps a sphere (not a ray) from the pivot to the desired position: a ray
 * squeezes through the gap between a doorframe and a pillar that the camera's
 * near plane does not, so a ray-based version clips through geometry at exactly
 * the angles a player will find.
 *
 * Coming back out is damped, going in is not. A camera that eases INTO a wall
 * spends those frames inside it; a camera that eases back out just looks
 * smooth. Asymmetry here is the point, not an oversight.
 *
 * @returns the resolved distance from the pivot along `direction`
 */
export function resolveCollision(physics, pivot, direction, desiredDistance, options = {}) {
  const {
    radius = 0.25,
    padding = 0.05,
    minDistance = 0.1,
    layers = null,
    exclude = null,
    previousDistance = null,
    recovery = 0,
    dt = 0,
  } = options;
  let allowed = desiredDistance;
  if (physics?.shapecast && desiredDistance > minDistance) {
    const hit = physics.shapecast(
      { type: "sphere", radius },
      [pivot.x, pivot.y, pivot.z],
      [direction.x, direction.y, direction.z],
      desiredDistance,
      { ...(layers?.length ? { layers } : {}), ...(exclude ? { exclude } : {}) },
    );
    if (hit) allowed = Math.max(minDistance, hit.distance - padding);
  }
  if (previousDistance == null) return allowed;
  // Snap inward, ease outward.
  if (allowed <= previousDistance) return allowed;
  return damp(previousDistance, allowed, recovery, dt);
}

/**
 * Builds a rotation that looks from `eye` toward `target`.
 *
 * `Object3D.lookAt` can't be used here: the pose being computed doesn't belong
 * to an object in the scene graph yet, and going through a temporary object to
 * borrow its lookAt costs a matrix decompose per camera per frame.
 */
export function lookRotation(out, eye, target, up = UP) {
  _m.lookAt(eye, target, up);
  return out.setFromRotationMatrix(_m);
}

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();

/**
 * A camera pose: everything the brain blends. Lens values live here too —
 * cutting between a 30° telephoto and a 90° wide angle without blending the
 * field of view is a jump cut in the middle of a smooth move.
 */
export class CameraPose {
  constructor() {
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.fov = 60;
  }

  copy(other) {
    this.position.copy(other.position);
    this.quaternion.copy(other.quaternion);
    this.fov = other.fov;
    return this;
  }

  /** Interpolates from `a` to `b` by `t`, writing into this pose. */
  lerpPoses(a, b, t) {
    this.position.lerpVectors(a.position, b.position, t);
    this.quaternion.copy(a.quaternion).slerp(b.quaternion, t);
    this.fov = a.fov + (b.fov - a.fov) * t;
    return this;
  }
}
