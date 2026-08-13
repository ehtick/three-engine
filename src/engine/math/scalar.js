// @ts-check
/**
 * Scalar math — the half of gameplay code that is one number chasing another.
 *
 * Everything here takes and returns plain numbers, allocates nothing, and
 * imports nothing. That is deliberate: `math` is the lowest layer in the
 * engine, so it must be importable from anywhere (including a Node test with
 * no DOM) and must never be the reason a hot loop allocates.
 *
 * Three's `MathUtils` overlaps this file in a handful of places and is still
 * exported to scripts. Where both exist, prefer these: `clamp` here does not
 * silently return NaN for a reversed range, `lerp` here is documented as
 * unclamped, and the frame-rate-independent smoothing (`damp`) has no
 * equivalent that takes a delta.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiply degrees by this to get radians. */
export const DEG_TO_RAD = Math.PI / 180;
/** Multiply radians by this to get degrees. */
export const RAD_TO_DEG = 180 / Math.PI;
/** A full turn in radians. Reach for this instead of `2 * Math.PI`. */
export const TAU = Math.PI * 2;
/** A quarter turn in radians. */
export const HALF_PI = Math.PI / 2;
/**
 * The tolerance float comparisons use by default. 1e-6 rather than
 * `Number.EPSILON`: this is the scale at which *world-space* quantities stop
 * being meaningfully different, not the scale at which doubles stop resolving.
 */
export const EPSILON = 1e-6;
/** φ. Used for low-discrepancy sequences (see {@link goldenAngleSpiral}). */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
/** ~137.5° in radians — the spacing that packs points most evenly on a disc. */
export const GOLDEN_ANGLE = TAU * (1 - 1 / GOLDEN_RATIO);

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * Constrains `value` to `[min, max]`. A reversed range is corrected rather
 * than returning nonsense, because the range usually comes from data the
 * caller did not author (a curve's first and last key, two entity positions).
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }
  return value < min ? min : value > max ? max : value;
}

/**
 * Clamps to `[0, 1]` — the normalized range nearly every blend weight,
 * progress value and mask lives in.
 *
 * @param {number} value
 * @returns {number}
 */
export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Alias of {@link clamp01}, for anyone arriving from shader code. */
export const saturate = clamp01;

/**
 * True when `value` lies inside `[min, max]`.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {boolean} [inclusive=true] false excludes the endpoints.
 * @returns {boolean}
 */
export function between(value, min, max, inclusive = true) {
  return inclusive ? value >= min && value <= max : value > min && value < max;
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Linear blend. **Unclamped** — `t` outside `[0, 1]` extrapolates, which is
 * what you want when `t` is a velocity-derived lead or a spring overshoot and
 * a footgun when it is a progress value you forgot to clamp. Use
 * {@link lerpClamped} when the range must hold.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * {@link lerp} with `t` clamped to `[0, 1]`.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerpClamped(a, b, t) {
  return a + (b - a) * clamp01(t);
}

/**
 * Where `value` sits between `a` and `b`, as a 0..1 fraction — the inverse of
 * {@link lerp}. A degenerate range (`a === b`) yields 0 rather than NaN;
 * "how far along a zero-length range" has no answer, and 0 is the one that
 * does not poison everything downstream.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} value
 * @returns {number}
 */
export function inverseLerp(a, b, value) {
  const span = b - a;
  return Math.abs(span) < Number.EPSILON ? 0 : (value - a) / span;
}

/**
 * Maps `value` from one range onto another. The single most useful function in
 * this file: health to bar width, distance to volume, altitude to fog density.
 *
 * Unclamped, matching {@link lerp}. {@link remapClamped} holds the output
 * range.
 *
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @returns {number}
 */
export function remap(value, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/**
 * {@link remap} that never leaves `[outMin, outMax]`.
 *
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @returns {number}
 */
export function remapClamped(value, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));
}

/**
 * 0 below `edge`, 1 at or above it — GLSL's `step`.
 *
 * @param {number} edge
 * @param {number} value
 * @returns {number}
 */
export function step(edge, value) {
  return value < edge ? 0 : 1;
}

/**
 * GLSL's `smoothstep`: 0 below `edge0`, 1 above `edge1`, and a Hermite ease
 * between them. Zero first derivative at both ends, so a fade built on it has
 * no visible corner where it starts or stops.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} value
 * @returns {number}
 */
export function smoothstep(edge0, edge1, value) {
  const t = clamp01(inverseLerp(edge0, edge1, value));
  return t * t * (3 - 2 * t);
}

/**
 * Ken Perlin's smootherstep — like {@link smoothstep} but with a zero *second*
 * derivative at the ends too. Worth the extra multiply when the value drives
 * something whose acceleration is visible (a camera, a lens effect).
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} value
 * @returns {number}
 */
export function smootherstep(edge0, edge1, value) {
  const t = clamp01(inverseLerp(edge0, edge1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Schlick's bias: reshapes a 0..1 value while keeping 0 and 1 fixed.
 * `amount < 0.5` pushes the curve down (values linger near 0), `> 0.5` pushes
 * it up. The cheap alternative to authoring a curve asset.
 *
 * @param {number} t
 * @param {number} amount in (0, 1); 0.5 is the identity.
 * @returns {number}
 */
export function bias(t, amount) {
  const b = clamp(amount, EPSILON, 1 - EPSILON);
  return t / ((1 / b - 2) * (1 - t) + 1);
}

/**
 * Schlick's gain: an S-curve (or its inverse) through 0.5 with 0, 0.5 and 1
 * fixed. `amount > 0.5` sharpens the middle — contrast for a mask.
 *
 * @param {number} t
 * @param {number} amount in (0, 1); 0.5 is the identity.
 * @returns {number}
 */
export function gain(t, amount) {
  return t < 0.5 ? bias(t * 2, 1 - amount) / 2 : 1 - bias(2 - t * 2, 1 - amount) / 2;
}

// ---------------------------------------------------------------------------
// Wrapping and periodic values
// ---------------------------------------------------------------------------

/**
 * The fractional part, always in `[0, 1)` — including for negatives, where
 * `x % 1` gives you a negative and breaks every UV and phase computation that
 * touches it.
 *
 * @param {number} value
 * @returns {number}
 */
export function fract(value) {
  return value - Math.floor(value);
}

/**
 * Euclidean modulo: the result carries the sign of `divisor`, not of `value`.
 * `mod(-1, 4)` is 3, where JavaScript's `-1 % 4` is -1.
 *
 * @param {number} value
 * @param {number} divisor
 * @returns {number}
 */
export function mod(value, divisor) {
  return divisor === 0 ? 0 : value - Math.floor(value / divisor) * divisor;
}

/**
 * Wraps `value` into `[0, length)`. Unity's `Mathf.Repeat`.
 *
 * @param {number} value
 * @param {number} length
 * @returns {number}
 */
export function repeat(value, length) {
  return mod(value, length);
}

/**
 * Wraps `value` into `[min, max)` — a looping index, an angle, a tiling
 * coordinate.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function wrap(value, min, max) {
  const span = max - min;
  return span === 0 ? min : min + mod(value - min, span);
}

/**
 * Bounces `value` back and forth between 0 and `length` — a patrol, a
 * breathing glow, a hover. Continuous, so it can be differentiated for a
 * velocity, unlike toggling direction at the ends.
 *
 * @param {number} value
 * @param {number} length
 * @returns {number}
 */
export function pingPong(value, length) {
  const t = mod(value, length * 2);
  return length - Math.abs(t - length);
}

/**
 * A 0..1 sawtooth of the given period.
 *
 * @param {number} time
 * @param {number} [period=1]
 * @returns {number}
 */
export function sawtooth(time, period = 1) {
  return mod(time, period) / period;
}

/**
 * A 0..1 triangle wave of the given period — {@link pingPong} normalized.
 *
 * @param {number} time
 * @param {number} [period=1]
 * @returns {number}
 */
export function triangleWave(time, period = 1) {
  return pingPong(time, period / 2) / (period / 2);
}

/**
 * A 0/1 square wave. `duty` is the fraction of each period spent at 1, so
 * `squareWave(t, 1, 0.1)` is a short blink once a second.
 *
 * @param {number} time
 * @param {number} [period=1]
 * @param {number} [duty=0.5]
 * @returns {number}
 */
export function squareWave(time, period = 1, duty = 0.5) {
  return sawtooth(time, period) < duty ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Motion toward a target
// ---------------------------------------------------------------------------

/**
 * Steps `current` toward `target` by at most `maxDelta`, landing exactly on
 * the target rather than overshooting. Constant-speed motion: use it when the
 * *rate* is the design (a turret's traverse, a lift), and {@link damp} when
 * the *feel* is (a camera, a UI value).
 *
 * @param {number} current
 * @param {number} target
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveTowards(current, target, maxDelta) {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/**
 * Frame-rate-independent exponential smoothing — the correct replacement for
 * the `value = lerp(value, target, 0.1)` that appears in every prototype.
 *
 * That idiom is wrong: its speed depends on frame rate, so the same code eases
 * at one speed at 60fps and a visibly different one at 144. This takes the
 * delta and converges at the same rate in wall-clock seconds either way.
 *
 * `lambda` is a rate, not a fraction: the value closes ~63% of the remaining
 * gap per `1 / lambda` seconds. 1 is a lazy drift, 10 is snappy, 30 is nearly
 * instant.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} lambda convergence rate, per second.
 * @param {number} dt seconds since the last call.
 * @returns {number}
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Converts the more intuitive "reach 99% of the way in `seconds`" into the
 * `lambda` {@link damp} wants.
 *
 * @param {number} seconds
 * @returns {number}
 */
export function dampLambdaFor(seconds) {
  return seconds <= 0 ? Infinity : Math.log(100) / seconds;
}

/**
 * A critically damped spring — Unity's `Mathf.SmoothDamp`. Reaches the target
 * without oscillating, carrying velocity through target changes, which is why
 * every good third-person camera is built on one and none are built on a lerp.
 *
 * Unlike Unity's, this does not take a `ref` parameter: it returns both the
 * new value and the new velocity, and the caller stores the velocity.
 *
 *     this._v ??= 0;
 *     const r = math.smoothDamp(this.zoom, target, this._v, 0.2, dt);
 *     this.zoom = r.value;
 *     this._v = r.velocity;
 *
 * @param {number} current
 * @param {number} target
 * @param {number} velocity the velocity returned by the previous call.
 * @param {number} smoothTime roughly the seconds taken to reach the target.
 * @param {number} dt seconds since the last call.
 * @param {number} [maxSpeed=Infinity] speed cap, in units per second.
 * @returns {{ value: number, velocity: number }}
 */
export function smoothDamp(current, target, velocity, smoothTime, dt, maxSpeed = Infinity) {
  // The closed-form critically-damped solution. `omega` is the natural
  // frequency; `exp` is a rational approximation of e^-x that stays stable for
  // the large `x` a long dt produces.
  const t = Math.max(0.0001, smoothTime);
  const omega = 2 / t;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = current - target;
  const originalTarget = target;
  // Clamping the *distance* rather than the resulting speed is what makes
  // maxSpeed hold across a frame of any length.
  const maxChange = maxSpeed * t;
  change = clamp(change, -maxChange, maxChange);
  target = current - change;

  const temp = (velocity + omega * change) * dt;
  let newVelocity = (velocity - omega * temp) * exp;
  let value = target + (change + temp) * exp;

  // Overshoot guard: without it the spring can settle *past* a target it was
  // moving toward, which reads as a twitch at the end of every motion.
  if (originalTarget - current > 0 === value > originalTarget) {
    value = originalTarget;
    newVelocity = (value - originalTarget) / dt;
  }
  return { value, velocity: newVelocity };
}

/**
 * True when two numbers are equal to within `epsilon`. Float comparison with
 * `===` is a bug waiting for a rotation to pass through it.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} [epsilon=EPSILON]
 * @returns {boolean}
 */
export function approximately(a, b, epsilon = EPSILON) {
  return Math.abs(a - b) <= epsilon;
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

/**
 * Rounds to the nearest multiple of `increment` — grid snapping, quantized
 * damage, a slider with detents.
 *
 * @param {number} value
 * @param {number} increment
 * @returns {number}
 */
export function snap(value, increment) {
  return increment === 0 ? value : Math.round(value / increment) * increment;
}

/**
 * Rounds *up* to the next multiple of `increment`.
 *
 * @param {number} value
 * @param {number} increment
 * @returns {number}
 */
export function roundUp(value, increment) {
  return increment === 0 ? value : Math.ceil(value / increment) * increment;
}

/**
 * Rounds *down* to the previous multiple of `increment`.
 *
 * @param {number} value
 * @param {number} increment
 * @returns {number}
 */
export function roundDown(value, increment) {
  return increment === 0 ? value : Math.floor(value / increment) * increment;
}

/**
 * Rounds to `decimals` places without a string round-trip.
 *
 * @param {number} value
 * @param {number} [decimals=0]
 * @returns {number}
 */
export function roundTo(value, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * True for a positive power of two. Texture sizes, atlas tiles, ring buffers.
 *
 * @param {number} value
 * @returns {boolean}
 */
export function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * The smallest power of two greater than or equal to `value`.
 *
 * @param {number} value
 * @returns {number}
 */
export function nextPowerOfTwo(value) {
  if (value <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(value));
}

/**
 * The largest power of two less than or equal to `value`.
 *
 * @param {number} value
 * @returns {number}
 */
export function previousPowerOfTwo(value) {
  if (value < 1) return 1;
  return 2 ** Math.floor(Math.log2(value));
}

/**
 * Whichever power of two `value` is closer to, in log space — so 700 rounds to
 * 512, not 1024, exactly as a mip chain would.
 *
 * @param {number} value
 * @returns {number}
 */
export function nearestPowerOfTwo(value) {
  if (value <= 1) return 1;
  return 2 ** Math.round(Math.log2(value));
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * @param {readonly number[]} values
 * @returns {number}
 */
export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total;
}

/**
 * The arithmetic mean, or 0 for an empty list.
 *
 * @param {readonly number[]} values
 * @returns {number}
 */
export function average(values) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/**
 * The middle value — what you want for a frame-time readout, where one
 * 400ms hitch drags the mean somewhere no frame actually was.
 *
 * @param {readonly number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The `index`-th point of the golden-angle spiral on a unit disc, as
 * `[x, y]` written into `out`. Successive points never clump, which is what
 * you want for scattering props, sampling a disc light, or laying out N icons
 * — random points clump and a grid reads as a grid.
 *
 * @param {number} index
 * @param {number} count
 * @param {{ x: number, y: number }} [out]
 * @returns {{ x: number, y: number }}
 */
export function goldenAngleSpiral(index, count, out = { x: 0, y: 0 }) {
  const radius = count <= 1 ? 0 : Math.sqrt(index / (count - 1));
  const theta = index * GOLDEN_ANGLE;
  out.x = Math.cos(theta) * radius;
  out.y = Math.sin(theta) * radius;
  return out;
}
