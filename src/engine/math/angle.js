// @ts-check
/**
 * Angles — the special case scalar math gets wrong.
 *
 * Every function here exists because the naive scalar version has a bug at the
 * wrap point. `lerp(350°, 10°, 0.5)` is 180°, spinning a character the long way
 * round for a 20° turn; `target - current` says a turret 179° away and one
 * 181° away should turn opposite directions by nearly a full circle.
 *
 * Radians are the default (three's convention, and what `Math.atan2` hands
 * you). The `Deg` suffix marks the degree variants, which exist because
 * designer-facing values — a cone of vision, a turn rate — are always authored
 * in degrees.
 */

import { clamp01, EPSILON, lerp, TAU } from "./scalar.js";

/**
 * @param {number} degrees
 * @returns {number}
 */
export function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * @param {number} radians
 * @returns {number}
 */
export function radToDeg(radians) {
  return (radians * 180) / Math.PI;
}

/**
 * Wraps an angle into `(-π, π]` — the signed form, where the sign is the turn
 * direction. This is the range you want for a steering error.
 *
 * @param {number} radians
 * @returns {number}
 */
export function wrapAngle(radians) {
  const wrapped = radians - Math.floor(radians / TAU + 0.5) * TAU;
  // `floor` puts exact -π on the low end; the closed end is the high one so
  // that a half-turn error reads as +180° rather than -180°.
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/**
 * Wraps an angle into `[0, 2π)` — the unsigned form, for a compass heading or
 * anything used as a lookup index.
 *
 * @param {number} radians
 * @returns {number}
 */
export function wrapAngle01(radians) {
  const wrapped = radians % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/**
 * Wraps degrees into `(-180, 180]`.
 *
 * @param {number} degrees
 * @returns {number}
 */
export function wrapAngleDeg(degrees) {
  return radToDeg(wrapAngle(degToRad(degrees)));
}

/**
 * The shortest signed rotation from `from` to `to`, in `(-π, π]`. Positive is
 * counter-clockwise about the axis you are measuring around.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function deltaAngle(from, to) {
  return wrapAngle(to - from);
}

/**
 * {@link deltaAngle} in degrees.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function deltaAngleDeg(from, to) {
  return wrapAngleDeg(to - from);
}

/**
 * Interpolates between two angles the short way round. `t` is clamped —
 * extrapolating an angle blend has no useful meaning and every caller that
 * tried it wanted a clamp.
 *
 * The result is continuous with `a` rather than wrapped, so blending from 350°
 * to 10° passes through 355°, 360°, and lands on 360° — the same rotation as
 * 0°, and the one that does not make a mesh spin backwards on the last frame.
 * Wrap it yourself with {@link wrapAngle} if you are storing it.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerpAngle(a, b, t) {
  return a + deltaAngle(a, b) * clamp01(t);
}

/**
 * {@link lerpAngle} in degrees.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerpAngleDeg(a, b, t) {
  return a + deltaAngleDeg(a, b) * clamp01(t);
}

/**
 * Turns `current` toward `target` at a capped rate, the short way round —
 * a turret traverse, an AI's turn speed. `maxDelta` is in radians for this
 * call, so pass `turnRateRadPerSec * dt`.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveTowardsAngle(current, target, maxDelta) {
  const delta = deltaAngle(current, target);
  if (Math.abs(delta) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(delta) * maxDelta);
}

/**
 * {@link moveTowardsAngle} in degrees.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveTowardsAngleDeg(current, target, maxDelta) {
  const delta = deltaAngleDeg(current, target);
  if (Math.abs(delta) <= maxDelta) return wrapAngleDeg(target);
  return wrapAngleDeg(current + Math.sign(delta) * maxDelta);
}

/**
 * Frame-rate-independent angular smoothing — {@link import("./scalar.js").damp}
 * that takes the short way round.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} lambda convergence rate, per second.
 * @param {number} dt seconds since the last call.
 * @returns {number}
 */
export function dampAngle(current, target, lambda, dt) {
  return wrapAngle(current + deltaAngle(current, target) * (1 - Math.exp(-lambda * dt)));
}

/**
 * The mean of a set of angles, computed on the unit circle so that 350° and
 * 10° average to 0° instead of 180°. Returns 0 for an empty set or one whose
 * directions cancel exactly.
 *
 * @param {readonly number[]} angles
 * @returns {number}
 */
export function averageAngle(angles) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < angles.length; i++) {
    x += Math.cos(angles[i]);
    y += Math.sin(angles[i]);
  }
  return Math.abs(x) < EPSILON && Math.abs(y) < EPSILON ? 0 : Math.atan2(y, x);
}

/**
 * The yaw (rotation about +Y) that faces the horizontal direction `(x, z)`.
 * Matches three's convention: yaw 0 looks down -Z, and the result feeds
 * `entity.rotation.y` directly.
 *
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function yawFromDirection(x, z) {
  return Math.atan2(x, z);
}

/**
 * The unit direction a yaw faces — the inverse of {@link yawFromDirection}.
 *
 * @param {number} yaw
 * @param {{ x: number, y: number, z: number }} [out]
 * @returns {{ x: number, y: number, z: number }}
 */
export function directionFromYaw(yaw, out = { x: 0, y: 0, z: 0 }) {
  out.x = Math.sin(yaw);
  out.y = 0;
  out.z = Math.cos(yaw);
  return out;
}

/**
 * The pitch (rotation about the local X axis) of a direction — positive looks
 * up. Handles a zero-length horizontal component, where a straight-up vector
 * would otherwise produce a NaN.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
export function pitchFromDirection(x, y, z) {
  const horizontal = Math.sqrt(x * x + z * z);
  return horizontal < EPSILON ? (y >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(y, horizontal);
}

/**
 * True when `target` falls inside a cone of half-angle `halfAngle` around
 * `facing` — a field of view test, once you have both as angles.
 *
 * @param {number} facing
 * @param {number} target
 * @param {number} halfAngle in radians.
 * @returns {boolean}
 */
export function withinAngle(facing, target, halfAngle) {
  return Math.abs(deltaAngle(facing, target)) <= halfAngle;
}

/**
 * Blends two angles by shortest path with an explicit unclamped `t`, for the
 * rare caller that genuinely wants to extrapolate a turn (predicting where a
 * rotating platform will be next frame).
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerpAngleUnclamped(a, b, t) {
  return lerp(a, a + deltaAngle(a, b), t);
}
