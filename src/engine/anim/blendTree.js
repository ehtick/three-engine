/**
 * Blend-tree weight solvers.
 *
 * Pure functions over child *positions* — no three.js, no mixer, no state — so
 * the interesting part (do the weights actually sum to 1 and move the way a
 * locomotion blend needs?) is testable without a skeleton.
 *
 * Two families:
 *   - 1D: children on a number line, linear between the bracketing pair. The
 *     classic idle/walk/run-by-speed tree.
 *   - 2D: children on a plane, solved with Rune Skovbo Johansen's gradient-band
 *     interpolation (the same construction Unity's Freeform trees use), in
 *     either a *cartesian* or a *directional* metric.
 *
 * Why gradient bands rather than something simpler: inverse-distance weighting
 * never reaches a pure sample (standing exactly on the "run forward" point still
 * bleeds in strafe), and Delaunay/barycentric needs a triangulation that breaks
 * down the moment samples are collinear — which they are, constantly, because
 * people lay strafe sets out on a cross. Gradient bands are exact at every
 * sample, continuous everywhere, and defined for any point set including a
 * single sample or a degenerate line.
 */

const EPS = 1e-6;

/**
 * 1D blend: weights for `children` (each `{ threshold }`) at `value`.
 * Outside the outermost thresholds the nearest child takes the whole weight —
 * clamping rather than extrapolating, because extrapolating an animation past
 * its authored range is never what you want.
 *
 * @returns {number[]} weights, index-aligned with `children`, summing to 1
 *   (all zeros only when `children` is empty).
 */
export function blend1D(children, value) {
  const weights = new Array(children.length).fill(0);
  if (!children.length) return weights;
  // Sort by threshold without disturbing the caller's order — the returned
  // weights must stay index-aligned with the authored children.
  const order = children.map((_, i) => i).sort((a, b) => thresholdOf(children[a]) - thresholdOf(children[b]));
  if (order.length === 1) {
    weights[order[0]] = 1;
    return weights;
  }
  const v = Number.isFinite(value) ? value : 0;
  const first = order[0];
  const last = order[order.length - 1];
  if (v <= thresholdOf(children[first])) {
    weights[first] = 1;
    return weights;
  }
  if (v >= thresholdOf(children[last])) {
    weights[last] = 1;
    return weights;
  }
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const ta = thresholdOf(children[a]);
    const tb = thresholdOf(children[b]);
    if (v < ta || v > tb) continue;
    const span = tb - ta;
    // Duplicate thresholds: the pair is degenerate, hand it all to the first.
    if (span <= EPS) {
      weights[a] = 1;
      return weights;
    }
    const t = (v - ta) / span;
    weights[a] = 1 - t;
    weights[b] = t;
    return weights;
  }
  weights[last] = 1;
  return weights;
}

/**
 * 2D blend: weights for `children` (each `{ px, py }`) at `(x, y)`.
 *
 * `mode`:
 *   - `"cartesian"` — treats the plane as plain 2D. Right for trees whose axes
 *     are independent quantities (e.g. speed × turn angle).
 *   - `"directional"` — treats each sample as a direction + magnitude and
 *     interpolates in that polar space. Right for strafe sets, where "forward
 *     at 3 m/s" and "backward at 3 m/s" are 180° apart and must not blend
 *     through the origin as cartesian distance would suggest.
 *
 * A sample at the origin (an idle in the middle of a strafe set) is handled
 * explicitly in directional mode: it has no direction, so it is compared on
 * magnitude alone.
 *
 * @returns {number[]} weights, index-aligned with `children`, summing to 1.
 */
export function blend2D(children, x, y, mode = "cartesian") {
  const n = children.length;
  const weights = new Array(n).fill(0);
  if (!n) return weights;
  if (n === 1) {
    weights[0] = 1;
    return weights;
  }
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  const directional = mode === "directional";

  let total = 0;
  for (let i = 0; i < n; i++) {
    let w = 1;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const h = directional
        ? directionalInfluence(children[i], children[j], px, py)
        : cartesianInfluence(children[i], children[j], px, py);
      if (h < w) w = h;
      if (w <= 0) break;
    }
    if (w < 0) w = 0;
    weights[i] = w;
    total += w;
  }

  if (total > EPS) {
    for (let i = 0; i < n; i++) weights[i] /= total;
    return weights;
  }
  // Every band evaluated to zero — only reachable with coincident samples or a
  // non-finite input. Fall back to the nearest sample so the tree still plays
  // something rather than freezing on an all-zero pose.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = pxOf(children[i]) - px;
    const dy = pyOf(children[i]) - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  weights[best] = 1;
  return weights;
}

/**
 * The gradient-band influence of sample `i` given competing sample `j`:
 * 1 at `i`, 0 at `j` and beyond, linear along the i→j direction. The caller
 * takes the minimum across all `j`, which is what makes the result exact at
 * every sample.
 */
function cartesianInfluence(ci, cj, px, py) {
  const ix = pxOf(ci);
  const iy = pyOf(ci);
  const jx = pxOf(cj) - ix;
  const jy = pyOf(cj) - iy;
  const denom = jx * jx + jy * jy;
  if (denom <= EPS) return 1; // coincident samples don't constrain each other
  return 1 - ((px - ix) * jx + (py - iy) * jy) / denom;
}

// How much a difference in *direction* counts relative to a difference in
// *magnitude*. Johansen's paper uses 2.0: a 180° turn should read as a bigger
// change than doubling speed, because it is.
const DIRECTIONAL_BIAS = 2.0;

/** The same construction as `cartesianInfluence`, in (magnitude, angle) space. */
function directionalInfluence(ci, cj, px, py) {
  const ix = pxOf(ci);
  const iy = pyOf(ci);
  const jx = pxOf(cj);
  const jy = pyOf(cj);
  const li = Math.hypot(ix, iy);
  const lj = Math.hypot(jx, jy);
  const lp = Math.hypot(px, py);
  // Average magnitude normalises the radial axis so the metric is scale-free —
  // a walk/run set authored in m/s behaves the same as one authored in cm/s.
  const scale = (li + lj) * 0.5;
  const radial = scale > EPS ? 1 / scale : 0;

  // A sample at the origin has no direction. Comparing angles against it is
  // meaningless (and atan2(0,0) is 0, which would silently make it "forward"),
  // so the pair is compared on magnitude alone.
  const iAtOrigin = li <= EPS;
  const jAtOrigin = lj <= EPS;
  const pAtOrigin = lp <= EPS;

  let hx; // input, relative to i
  let hy;
  let ex; // j, relative to i — the band's direction
  let ey;
  if (iAtOrigin || jAtOrigin || pAtOrigin) {
    hx = (lp - li) * radial;
    hy = 0;
    ex = (lj - li) * radial;
    ey = 0;
  } else {
    hx = (lp - li) * radial;
    hy = signedAngle(ix, iy, px, py) * DIRECTIONAL_BIAS;
    ex = (lj - li) * radial;
    ey = signedAngle(ix, iy, jx, jy) * DIRECTIONAL_BIAS;
  }
  const denom = ex * ex + ey * ey;
  if (denom <= EPS) return 1;
  return 1 - (hx * ex + hy * ey) / denom;
}

/** Signed angle from (ax,ay) to (bx,by), in radians, in (-π, π]. */
function signedAngle(ax, ay, bx, by) {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function thresholdOf(child) {
  const t = child?.threshold;
  return Number.isFinite(t) ? t : 0;
}

function pxOf(child) {
  const v = child?.px;
  return Number.isFinite(v) ? v : 0;
}

function pyOf(child) {
  const v = child?.py;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Cycle-length synchronisation across a blend tree's children.
 *
 * A walk clip is 1.1s and a run clip 0.7s. Play both at their authored rate and
 * blend them and the feet drift apart within a stride — the "skating" that
 * makes blended locomotion look wrong. Instead every child is retimed so they
 * all complete one cycle in the same weighted-average duration, which keeps
 * contact frames on top of each other for as long as the blend lasts.
 *
 * Children with zero weight are still given a rate (they may be fading in next
 * frame) but contribute nothing to the average.
 *
 * @param durations per-child clip length in seconds
 * @param weights   per-child normalised blend weight
 * @param speeds    per-child authored speed multiplier
 * @returns {number[]} timeScale to apply to each child's action
 */
export function syncTimeScales(durations, weights, speeds) {
  const n = durations.length;
  const scales = new Array(n).fill(1);
  let target = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] ?? 0;
    const d = durations[i];
    if (w <= 0 || !(d > 0)) continue;
    const speed = speeds?.[i] || 1;
    // The *effective* cycle length: a child authored at speed 2 already
    // completes in half the time, and the average must reflect that or a
    // sped-up child would drag everyone else along with it.
    target += w * (d / Math.abs(speed));
    totalWeight += w;
  }
  if (totalWeight > EPS) target /= totalWeight;
  for (let i = 0; i < n; i++) {
    const d = durations[i];
    const speed = speeds?.[i] || 1;
    if (!(d > 0) || target <= EPS) {
      scales[i] = speed;
      continue;
    }
    // Rate that makes this child's cycle last exactly `target` seconds,
    // carrying the sign of the authored speed so a reversed child stays
    // reversed.
    scales[i] = Math.sign(speed || 1) * (d / target);
  }
  return scales;
}
