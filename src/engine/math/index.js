// @ts-check
/**
 * `engine.math` — the gameplay math the engine and user scripts share.
 *
 * ## Where it lives
 *
 * Three ways in, all the same object:
 *
 *     import { math } from "engine";   // in a user script
 *     this.engine.math                 // on the engine instance
 *     this.math                        // injected on every script instance
 *
 * ## Why it exists next to three
 *
 * three already ships `Vector3`, `Quaternion` and `MathUtils`, and scripts get
 * all of them. Those are *types and primitives*. What is missing is the layer
 * above: the operations gameplay code writes over and over and gets subtly
 * wrong. Interpolating two angles the short way round. Smoothing that does not
 * change speed with frame rate. A random number you can reproduce from a bug
 * report. Where to aim at a moving target. None of that is three's job.
 *
 * ## Two rules everything here follows
 *
 * **It allocates nothing.** Anything returning a vector takes an optional
 * `out`. This code runs per-entity per-frame; a hidden `new Vector3()` inside
 * it would be a per-frame GC contribution nobody could see from the call site.
 *
 * **It imports nothing.** Not even three. Every function works on the *shape*
 * `{x, y, z}`, which a three `Vector3` satisfies, so vectors cross the
 * boundary with no conversion — and the package stays usable from a Node test,
 * a worker, or a build script where three's browser globals do not exist.
 *
 * ## What is deliberately absent
 *
 * A `Vector3` class (three's is the engine's, and a second one would fork
 * `instanceof`), matrix math (three's `Matrix4` is complete and battle-tested)
 * and anything three's `Vector3` already does well — `add`, `normalize`,
 * `projectOnPlane`, `reflect`, `clampLength`, `applyQuaternion`.
 */

import * as scalar from "./scalar.js";
import * as angle from "./angle.js";
import * as easing from "./easing.js";
import * as intersect from "./intersect.js";
import * as trajectory from "./trajectory.js";
import * as bits from "./bits.js";
import { random, Random, seedFromString } from "./random.js";
import { noise, Noise } from "./noise.js";
import { vec2, vec3, quat, orthonormalBasis } from "./vector.js";

export * from "./scalar.js";
export * from "./angle.js";
export * from "./easing.js";
export { random, Random, seedFromString } from "./random.js";
export { noise, Noise } from "./noise.js";
export { vec2, vec3, quat, orthonormalBasis } from "./vector.js";
export { intersect, trajectory, bits };

/**
 * The whole package as one namespace. Scalar helpers sit at the top level
 * (`math.clamp`, `math.lerp`, `math.smoothstep`) because that is how they read
 * at a call site; everything with a domain gets a sub-namespace
 * (`math.vec3.smoothDamp`, `math.random.pick`, `math.trajectory.interceptPoint`).
 */
export const math = {
  // ---- Scalars ------------------------------------------------------------
  DEG_TO_RAD: scalar.DEG_TO_RAD,
  RAD_TO_DEG: scalar.RAD_TO_DEG,
  TAU: scalar.TAU,
  HALF_PI: scalar.HALF_PI,
  EPSILON: scalar.EPSILON,
  GOLDEN_RATIO: scalar.GOLDEN_RATIO,
  GOLDEN_ANGLE: scalar.GOLDEN_ANGLE,

  clamp: scalar.clamp,
  clamp01: scalar.clamp01,
  saturate: scalar.saturate,
  between: scalar.between,
  lerp: scalar.lerp,
  lerpClamped: scalar.lerpClamped,
  inverseLerp: scalar.inverseLerp,
  remap: scalar.remap,
  remapClamped: scalar.remapClamped,
  step: scalar.step,
  smoothstep: scalar.smoothstep,
  smootherstep: scalar.smootherstep,
  bias: scalar.bias,
  gain: scalar.gain,
  fract: scalar.fract,
  mod: scalar.mod,
  repeat: scalar.repeat,
  wrap: scalar.wrap,
  pingPong: scalar.pingPong,
  sawtooth: scalar.sawtooth,
  triangleWave: scalar.triangleWave,
  squareWave: scalar.squareWave,
  moveTowards: scalar.moveTowards,
  damp: scalar.damp,
  dampLambdaFor: scalar.dampLambdaFor,
  smoothDamp: scalar.smoothDamp,
  approximately: scalar.approximately,
  snap: scalar.snap,
  roundUp: scalar.roundUp,
  roundDown: scalar.roundDown,
  roundTo: scalar.roundTo,
  isPowerOfTwo: scalar.isPowerOfTwo,
  nextPowerOfTwo: scalar.nextPowerOfTwo,
  previousPowerOfTwo: scalar.previousPowerOfTwo,
  nearestPowerOfTwo: scalar.nearestPowerOfTwo,
  sum: scalar.sum,
  average: scalar.average,
  median: scalar.median,
  goldenAngleSpiral: scalar.goldenAngleSpiral,

  // ---- Angles -------------------------------------------------------------
  degToRad: angle.degToRad,
  radToDeg: angle.radToDeg,
  wrapAngle: angle.wrapAngle,
  wrapAngle01: angle.wrapAngle01,
  wrapAngleDeg: angle.wrapAngleDeg,
  deltaAngle: angle.deltaAngle,
  deltaAngleDeg: angle.deltaAngleDeg,
  lerpAngle: angle.lerpAngle,
  lerpAngleDeg: angle.lerpAngleDeg,
  lerpAngleUnclamped: angle.lerpAngleUnclamped,
  moveTowardsAngle: angle.moveTowardsAngle,
  moveTowardsAngleDeg: angle.moveTowardsAngleDeg,
  dampAngle: angle.dampAngle,
  averageAngle: angle.averageAngle,
  yawFromDirection: angle.yawFromDirection,
  directionFromYaw: angle.directionFromYaw,
  pitchFromDirection: angle.pitchFromDirection,
  withinAngle: angle.withinAngle,

  // ---- Sub-namespaces -----------------------------------------------------
  /** Easing curves, shared with `engine.tween`'s `ease` option. */
  ease: easing.EASINGS,
  /** Easing helpers: names, lookup, yoyo, reverse, cubic-bezier. */
  easing: {
    EASINGS: easing.EASINGS,
    EASE_NAMES: easing.EASE_NAMES,
    easingByName: easing.easingByName,
    apply: easing.ease,
    yoyo: easing.yoyo,
    reverse: easing.reverseEase,
    cubicBezier: easing.cubicBezierEase,
  },
  /** Seeded randomness. Callable: `math.random()`, `math.random(2, 5)`. */
  random,
  /** Coherent noise. Callable: `math.noise(x, y)`. */
  noise,
  /** 3D vector operations three does not have. */
  vec3,
  /** 2D vector operations. */
  vec2,
  /** Quaternion smoothing and look-rotation. */
  quat,
  /** A tangent frame for a normal. */
  orthonormalBasis,
  /** Distances, closest points, ray casts, overlap tests. */
  intersect,
  /** Ballistic arcs and interception — "where do I aim?". */
  trajectory,
  /** Flags, packing and stable hashing. */
  bits,

  /** The `Random` class, for an independent seeded stream. */
  Random,
  /** The `Noise` class, for an independent noise field. */
  Noise,
  /** Hashes a string to a 32-bit seed. */
  seedFromString,
};
