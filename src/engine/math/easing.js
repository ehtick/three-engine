// @ts-check
/**
 * Easing curves — the shape a 0..1 progress value takes on its way to 1.
 *
 * This table is the engine's single easing set. `tween.js` re-exports it (so
 * `engine.tween(..., { ease: "backOut" })` and `math.ease.backOut` are the
 * same function), and it lives here rather than there because a curve is math:
 * it is just as useful driving a shader uniform, a camera blend, or a
 * hand-rolled timer as it is driving a tween.
 *
 * Every curve satisfies `f(0) === 0` and `f(1) === 1`. What happens in between
 * is the point, and three of them (`back*`, `elastic*`) deliberately leave
 * `[0, 1]` on the way — that overshoot is the effect, not a bug, and it will
 * break anything that feeds the result straight into an unclamped index.
 */

import { clamp01 } from "./scalar.js";

const BACK_C1 = 1.70158;
const BACK_C2 = BACK_C1 * 1.525;
const BACK_C3 = BACK_C1 + 1;
const ELASTIC_C4 = (2 * Math.PI) / 3;
const ELASTIC_C5 = (2 * Math.PI) / 4.5;

/**
 * The `out` half of the bounce, defined first because `bounceIn` and
 * `bounceInOut` are both written in terms of it.
 *
 * @param {number} t
 * @returns {number}
 */
function bounceOut(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/**
 * The standard easing set. `inOut` variants are the ones worth reaching for by
 * default: a UI element that starts and stops abruptly reads as a jump cut
 * however long the tween is.
 *
 * Deliberately un-annotated so TypeScript infers the exact key set: that is
 * what makes `ease: "backOut"` autocomplete in a script and `ease: "backout"`
 * an error rather than a silent fallback to linear.
 */
export const EASINGS = {
  linear: (t) => t,

  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),

  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 + (t - 1) ** 3,
  cubicInOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 + 4 * (t - 1) ** 3),

  quartIn: (t) => t ** 4,
  quartOut: (t) => 1 - (t - 1) ** 4,
  quartInOut: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - 8 * (t - 1) ** 4),

  quintIn: (t) => t ** 5,
  quintOut: (t) => 1 + (t - 1) ** 5,
  quintInOut: (t) => (t < 0.5 ? 16 * t ** 5 : 1 + 16 * (t - 1) ** 5),

  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,

  expoIn: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  expoOut: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  expoInOut: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,

  circIn: (t) => 1 - Math.sqrt(1 - t * t),
  circOut: (t) => Math.sqrt(1 - (t - 1) ** 2),
  circInOut: (t) =>
    t < 0.5
      ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
      : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,

  // Overshoots past the target and settles back — an object arriving with
  // weight. Leaves [0, 1].
  backIn: (t) => BACK_C3 * t ** 3 - BACK_C1 * t * t,
  backOut: (t) => 1 + BACK_C3 * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2,
  backInOut: (t) =>
    t < 0.5
      ? ((2 * t) ** 2 * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
      : ((2 * t - 2) ** 2 * ((BACK_C2 + 1) * (2 * t - 2) + BACK_C2) + 2) / 2,

  // Oscillates around the target with a decaying amplitude. Leaves [0, 1].
  elasticIn: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ELASTIC_C4),
  elasticOut: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1,
  elasticInOut: (t) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2
          : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1,

  bounceIn: (t) => 1 - bounceOut(1 - t),
  bounceOut,
  bounceInOut: (t) =>
    t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,
};

/**
 * Every easing name, for a dropdown or a validation check.
 * @type {string[]}
 */
export const EASE_NAMES = Object.keys(EASINGS);

/**
 * Looks an easing up by name, or null if there is no such curve.
 *
 * @param {string} name
 * @returns {((t: number) => number) | null}
 */
export function easingByName(name) {
  const table = /** @type {Record<string, (t: number) => number>} */ (
    /** @type {unknown} */ (EASINGS)
  );
  return table[name] ?? null;
}

/**
 * Applies an easing by name, clamping `t` to `[0, 1]` first. An unknown name
 * falls back to `linear` rather than throwing — an easing is presentation, and
 * a typo in one should not take down the frame that draws it.
 *
 * @param {string} name
 * @param {number} t
 * @returns {number}
 */
export function ease(name, t) {
  return (easingByName(name) ?? EASINGS.linear)(clamp01(t));
}

/**
 * Runs an easing forward then backward over a single 0..1 pass, so the value
 * returns to where it started — a flash, a pulse, a squash-and-stretch hit
 * reaction. `f(0)` and `f(1)` are both 0 and the peak is at `t = 0.5`.
 *
 * @param {(t: number) => number} easing
 * @returns {(t: number) => number}
 */
export function yoyo(easing) {
  return (t) => easing(1 - Math.abs(2 * clamp01(t) - 1));
}

/**
 * Mirrors an easing: the `in` curve becomes the `out` curve and vice versa.
 * Saves declaring a reversed variant when the curve is user-supplied.
 *
 * @param {(t: number) => number} easing
 * @returns {(t: number) => number}
 */
export function reverseEase(easing) {
  return (t) => 1 - easing(1 - t);
}

/**
 * A cubic Bézier easing, the CSS `cubic-bezier(x1, y1, x2, y2)` form, for
 * matching a curve authored in a design tool. The first and last control
 * points are pinned at (0,0) and (1,1).
 *
 * Solving y for a given x needs an iterative inverse, so this is meaningfully
 * more expensive than the named curves — build it once and reuse it, do not
 * call it per frame.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {(t: number) => number}
 */
export function cubicBezierEase(x1, y1, x2, y2) {
  const curve = (a, b, t) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (t) => {
    const x = clamp01(t);
    // Bisection: monotonic in x for control points in [0, 1], and 24 steps
    // resolve well past what a 60Hz frame can show.
    let low = 0;
    let high = 1;
    let mid = x;
    for (let i = 0; i < 24; i++) {
      mid = (low + high) / 2;
      if (curve(x1, x2, mid) < x) low = mid;
      else high = mid;
    }
    return curve(y1, y2, mid);
  };
}
