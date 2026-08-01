import * as THREE from "three/webgpu";

/**
 * Spline evaluation (roadmap item 16).
 *
 * ## One curve representation, three authoring modes
 *
 * Catmull-Rom, Bezier and polyline are three ways of *authoring* the same
 * thing: a chain of cubic segments. Converting all three to piecewise cubic
 * Bezier at build time — which is exact, not an approximation, for both of the
 * others — means the evaluator, the arc-length table, the frames and the
 * closest-point search are written once. A dispatch on curve type inside
 * `pointAt` would be three implementations of every one of those, and the
 * bugs would only appear in whichever mode the author happened to pick.
 *
 * ## Arc length is the parameter that matters
 *
 * The natural parameter `u` of a cubic is not distance: on a segment twice as
 * long as its neighbour, a constant `du/dt` travels twice as fast. Every
 * consumer here — a patrol route with a speed in m/s, a camera rail traversed
 * over five seconds, a road whose texture must not stretch — is asking a
 * question about distance. So the curve is sampled once into an arc-length
 * table and every public query takes metres (or a normalised 0..1 that means
 * "fraction of the length", not "fraction of the parameter").
 *
 * ## Frames are rotation-minimizing, not Frenet
 *
 * The textbook frame comes from the curvature vector, and it is unusable for
 * this: it is undefined on a straight segment (zero curvature — a road with a
 * straight bit has no normal there) and it FLIPS through 180° at an inflection
 * point, which on a road is a length of tarmac that turns itself inside out
 * between two frames. The rotation-minimizing frame is transported along the
 * curve instead — it has no relationship to curvature, so a straight section
 * simply keeps the previous orientation and an inflection is a non-event.
 * The double-reflection method (Wang et al. 2008) is used because the naive
 * projection accumulates error over a long path.
 *
 * A closed spline gets one extra step: the frame transported all the way round
 * does not generally come back to where it started, and the residual twist
 * lands entirely on the seam. It is measured and spread evenly over the loop,
 * so a closed road has no seam anywhere rather than a bad one in one place.
 */

export const SPLINE_TYPES = ["catmullrom", "bezier", "linear"];

/** Wrap behaviours shared by everything that walks a path. */
export const WRAP_MODES = ["clamp", "loop", "pingPong", "once"];

export const KNOT_DEFAULTS = {
  position: [0, 0, 0],
  /** Control handles, RELATIVE to the knot. Only read in `bezier` mode. */
  handleIn: [0, 0, -1],
  handleOut: [0, 0, 1],
  /** Bank angle in degrees about the tangent, interpolated along each segment. */
  roll: 0,
};

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

function vec(source, fallback) {
  if (Array.isArray(source)) return new THREE.Vector3(source[0] ?? 0, source[1] ?? 0, source[2] ?? 0);
  if (source && typeof source === "object") return new THREE.Vector3(source.x ?? 0, source.y ?? 0, source.z ?? 0);
  return fallback.clone();
}

/** Fills in every field of an authored knot, accepting arrays, Vector3s or a bare position. */
export function normalizeKnot(knot) {
  if (Array.isArray(knot)) return { position: vec(knot, _v0.set(0, 0, 0)).toArray(), handleIn: [...KNOT_DEFAULTS.handleIn], handleOut: [...KNOT_DEFAULTS.handleOut], roll: 0 };
  const position = vec(knot?.position, new THREE.Vector3());
  return {
    position: position.toArray(),
    handleIn: vec(knot?.handleIn, new THREE.Vector3(...KNOT_DEFAULTS.handleIn)).toArray(),
    handleOut: vec(knot?.handleOut, new THREE.Vector3(...KNOT_DEFAULTS.handleOut)).toArray(),
    roll: Number.isFinite(knot?.roll) ? knot.roll : 0,
  };
}

/**
 * Cubic Bezier control points for one segment, whatever the authoring mode.
 *
 * The Catmull-Rom case is the standard conversion (the inner controls sit a
 * sixth of the way along the neighbour chord); `tension` scales them, so 0 is a
 * polyline through the same knots and 1 is the usual smooth spline.
 *
 * The open-ended case reflects a phantom point through the endpoint rather than
 * duplicating the endpoint. Duplication is the common shortcut and it flattens
 * the tangent at both ends, so the first and last segments of every authored
 * path bulge differently from the middle ones for no reason the author can see.
 */
function segmentControls(knots, index, { type, closed, tension }) {
  const count = knots.length;
  const wrap = (i) => (closed ? ((i % count) + count) % count : THREE.MathUtils.clamp(i, 0, count - 1));
  const k0 = knots[wrap(index)];
  const k1 = knots[wrap(index + 1)];
  const p0 = vec(k0.position, _v0);
  const p3 = vec(k1.position, _v0);

  if (type === "bezier") {
    return {
      p0,
      p1: p0.clone().add(vec(k0.handleOut, _v0)),
      p2: p3.clone().add(vec(k1.handleIn, _v0)),
      p3,
    };
  }
  if (type === "linear") {
    const delta = p3.clone().sub(p0);
    return { p0, p1: p0.clone().addScaledVector(delta, 1 / 3), p2: p0.clone().addScaledVector(delta, 2 / 3), p3 };
  }

  // Catmull-Rom. `prev`/`next` are the neighbouring knots; at an open end the
  // phantom neighbour is the endpoint reflected through its inner neighbour.
  const prev = index - 1 >= 0 || closed ? vec(knots[wrap(index - 1)].position, _v0) : p0.clone().multiplyScalar(2).sub(p3);
  const next = index + 2 < count || closed ? vec(knots[wrap(index + 2)].position, _v0) : p3.clone().multiplyScalar(2).sub(p0);
  const k = (tension ?? 1) / 6;
  return {
    p0,
    p1: p0.clone().addScaledVector(p3.clone().sub(prev), k),
    p2: p3.clone().addScaledVector(next.clone().sub(p0), -k),
    p3,
  };
}

function bezierPoint(out, s, u) {
  const iu = 1 - u;
  const a = iu * iu * iu;
  const b = 3 * iu * iu * u;
  const c = 3 * iu * u * u;
  const d = u * u * u;
  return out.set(
    a * s.p0.x + b * s.p1.x + c * s.p2.x + d * s.p3.x,
    a * s.p0.y + b * s.p1.y + c * s.p2.y + d * s.p3.y,
    a * s.p0.z + b * s.p1.z + c * s.p2.z + d * s.p3.z,
  );
}

function bezierDerivative(out, s, u) {
  const iu = 1 - u;
  const a = 3 * iu * iu;
  const b = 6 * iu * u;
  const c = 3 * u * u;
  return out.set(
    a * (s.p1.x - s.p0.x) + b * (s.p2.x - s.p1.x) + c * (s.p3.x - s.p2.x),
    a * (s.p1.y - s.p0.y) + b * (s.p2.y - s.p1.y) + c * (s.p3.y - s.p2.y),
    a * (s.p1.z - s.p0.z) + b * (s.p2.z - s.p1.z) + c * (s.p3.z - s.p2.z),
  );
}

/** A frame the callers fill in; allocating one per query would be per-frame garbage. */
export class SplineFrame {
  constructor() {
    this.position = new THREE.Vector3();
    this.tangent = new THREE.Vector3(0, 0, 1);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.binormal = new THREE.Vector3(1, 0, 0);
    this.distance = 0;
  }
}

export class Spline {
  /**
   * @param {Array} knots  authored knots (see `normalizeKnot`)
   * @param {object} options
   *   type              "catmullrom" | "bezier" | "linear"
   *   closed            joins the last knot back to the first
   *   tension           Catmull-Rom only; 0 = polyline, 1 = standard
   *   samplesPerSegment arc-length table density
   *   up                preferred starting normal
   */
  constructor(knots = [], options = {}) {
    this.type = SPLINE_TYPES.includes(options.type) ? options.type : "catmullrom";
    this.closed = !!options.closed;
    this.tension = Number.isFinite(options.tension) ? options.tension : 1;
    this.samplesPerSegment = THREE.MathUtils.clamp(Math.round(options.samplesPerSegment ?? 16), 2, 128);
    this.up = options.up ? vec(options.up, WORLD_UP) : WORLD_UP.clone();
    this.knots = (knots ?? []).map(normalizeKnot);
    this.#build();
  }

  get knotCount() {
    return this.knots.length;
  }

  get segmentCount() {
    if (this.knots.length < 2) return 0;
    return this.closed ? this.knots.length : this.knots.length - 1;
  }

  /** Total arc length in local units. Zero for a degenerate (0 or 1 knot) spline. */
  get length() {
    return this._length;
  }

  get valid() {
    return this.segmentCount > 0 && this._length > 1e-6;
  }

  // ---- build ---------------------------------------------------------------

  #build() {
    const segCount = this.segmentCount;
    this.segments = [];
    for (let i = 0; i < segCount; i++) {
      this.segments.push(
        segmentControls(this.knots, i, { type: this.type, closed: this.closed, tension: this.tension }),
      );
    }
    const per = this.samplesPerSegment;
    const count = segCount > 0 ? segCount * per + 1 : 0;
    this._count = count;
    this._positions = new Float32Array(count * 3);
    this._tangents = new Float32Array(count * 3);
    this._normals = new Float32Array(count * 3);
    this._lengths = new Float32Array(count);
    this._params = new Float32Array(count);
    this._length = 0;
    if (!count) return;

    // Pass 1 — positions, tangents and cumulative length.
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const prev = new THREE.Vector3();
    let total = 0;
    for (let i = 0; i < count; i++) {
      const param = Math.min(i / per, segCount);
      const si = Math.min(Math.floor(param), segCount - 1);
      const u = param - si;
      const segment = this.segments[si];
      bezierPoint(pos, segment, u);
      bezierDerivative(tan, segment, u);
      if (tan.lengthSq() < 1e-12) {
        // A cusp (coincident control points) has no derivative. Falling back to
        // the chord keeps the frame defined instead of producing NaN normals
        // that propagate into every consumer downstream.
        tan.copy(segment.p3).sub(segment.p0);
        if (tan.lengthSq() < 1e-12) tan.set(0, 0, 1);
      }
      tan.normalize();
      if (i > 0) total += pos.distanceTo(prev);
      prev.copy(pos);
      pos.toArray(this._positions, i * 3);
      tan.toArray(this._tangents, i * 3);
      this._lengths[i] = total;
      this._params[i] = param;
    }
    this._length = total;

    this.#buildFrames();
  }

  /** Rotation-minimizing normals by double reflection, then roll. */
  #buildFrames() {
    const count = this._count;
    if (!count) return;
    const t0 = _t.fromArray(this._tangents, 0);
    // Start from the preferred up, projected onto the plane perpendicular to
    // the tangent. A path that leaves straight up has no such component, and
    // that is the one case where the choice is arbitrary rather than wrong.
    const r = this.up.clone().addScaledVector(t0, -this.up.dot(t0));
    if (r.lengthSq() < 1e-8) r.copy(FALLBACK_UP).addScaledVector(t0, -FALLBACK_UP.dot(t0));
    if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
    r.normalize();
    r.toArray(this._normals, 0);

    const x0 = new THREE.Vector3();
    const x1 = new THREE.Vector3();
    const t1 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const rL = new THREE.Vector3();
    const tL = new THREE.Vector3();
    for (let i = 0; i < count - 1; i++) {
      x0.fromArray(this._positions, i * 3);
      x1.fromArray(this._positions, (i + 1) * 3);
      _t.fromArray(this._tangents, i * 3);
      t1.fromArray(this._tangents, (i + 1) * 3);
      v1.copy(x1).sub(x0);
      const c1 = v1.lengthSq();
      if (c1 < 1e-12) {
        r.toArray(this._normals, (i + 1) * 3);
        continue;
      }
      rL.copy(r).addScaledVector(v1, (-2 / c1) * v1.dot(r));
      tL.copy(_t).addScaledVector(v1, (-2 / c1) * v1.dot(_t));
      v2.copy(t1).sub(tL);
      const c2 = v2.lengthSq();
      if (c2 > 1e-12) rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
      // Re-orthogonalise: the reflections are exact in theory and drift in
      // float over a few hundred samples.
      r.copy(rL).addScaledVector(t1, -rL.dot(t1)).normalize();
      r.toArray(this._normals, (i + 1) * 3);
    }

    if (this.closed) this.#closeTwist();
    this.#applyRoll();
  }

  /**
   * Spreads the loop's residual twist over its whole length.
   *
   * Transporting a frame around a closed curve lands it rotated by some angle
   * about the tangent — a real geometric quantity, not an error. Left alone it
   * all appears at the seam, where a road's two ends meet at a visible kink.
   */
  #closeTwist() {
    const count = this._count;
    const first = _v1.fromArray(this._normals, 0);
    const last = _v2.fromArray(this._normals, (count - 1) * 3);
    const tangent = _t.fromArray(this._tangents, (count - 1) * 3);
    const cross = _v3.copy(last).cross(first);
    const angle = Math.atan2(cross.dot(tangent), last.dot(first));
    if (Math.abs(angle) < 1e-9) return;
    const total = this._length || 1;
    const n = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      n.fromArray(this._normals, i * 3);
      _t.fromArray(this._tangents, i * 3);
      n.applyAxisAngle(_t, angle * (this._lengths[i] / total));
      n.toArray(this._normals, i * 3);
    }
  }

  /** Per-knot bank, interpolated across each segment and applied about the tangent. */
  #applyRoll() {
    if (!this.knots.some((k) => Math.abs(k.roll ?? 0) > 1e-6)) return;
    const per = this.samplesPerSegment;
    const segCount = this.segmentCount;
    const n = new THREE.Vector3();
    for (let i = 0; i < this._count; i++) {
      const param = Math.min(i / per, segCount);
      const si = Math.min(Math.floor(param), segCount - 1);
      const u = param - si;
      const a = this.knots[si]?.roll ?? 0;
      const bIndex = this.closed ? (si + 1) % this.knots.length : Math.min(si + 1, this.knots.length - 1);
      const b = this.knots[bIndex]?.roll ?? 0;
      const roll = THREE.MathUtils.degToRad(a + (b - a) * u);
      if (Math.abs(roll) < 1e-9) continue;
      n.fromArray(this._normals, i * 3);
      _t.fromArray(this._tangents, i * 3);
      n.applyAxisAngle(_t, roll);
      n.toArray(this._normals, i * 3);
    }
  }

  // ---- queries -------------------------------------------------------------

  /** Distance → the curve's own parameter, through the arc-length table. */
  #paramAtDistance(distance) {
    if (this._count < 2) return 0;
    const d = THREE.MathUtils.clamp(distance, 0, this._length);
    const lengths = this._lengths;
    let lo = 0;
    let hi = this._count - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = lengths[hi] - lengths[lo];
    const f = span > 1e-9 ? (d - lengths[lo]) / span : 0;
    return this._params[lo] + (this._params[hi] - this._params[lo]) * f;
  }

  /** Index of the sample at or before `distance`, plus the fraction past it. */
  #sampleAtDistance(distance) {
    const d = THREE.MathUtils.clamp(distance, 0, this._length);
    const lengths = this._lengths;
    let lo = 0;
    let hi = Math.max(1, this._count - 1);
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = lengths[hi] - lengths[lo];
    return { lo, hi, f: span > 1e-9 ? (d - lengths[lo]) / span : 0 };
  }

  #evalPoint(out, param) {
    const segCount = this.segmentCount;
    if (!segCount) return out.set(0, 0, 0);
    const si = Math.min(Math.floor(param), segCount - 1);
    return bezierPoint(out, this.segments[si], param - si);
  }

  #evalTangent(out, param) {
    const segCount = this.segmentCount;
    if (!segCount) return out.set(0, 0, 1);
    const si = Math.min(Math.floor(param), segCount - 1);
    bezierDerivative(out, this.segments[si], param - si);
    if (out.lengthSq() < 1e-12) out.fromArray(this._tangents, 0);
    return out.normalize();
  }

  /**
   * Point at `distance` metres along the curve.
   *
   * The parameter is found from the table but the point is evaluated from the
   * cubic, not lerped between two samples — a lerp cuts the corner by the
   * chord error, which on a low sample count reads as a path that visibly does
   * not pass through its own drawn curve.
   */
  pointAtDistance(distance, out = new THREE.Vector3()) {
    return this.#evalPoint(out, this.#paramAtDistance(distance));
  }

  tangentAtDistance(distance, out = new THREE.Vector3()) {
    return this.#evalTangent(out, this.#paramAtDistance(distance));
  }

  normalAtDistance(distance, out = new THREE.Vector3()) {
    if (this._count < 2) return out.set(0, 1, 0);
    const { lo, hi, f } = this.#sampleAtDistance(distance);
    _v1.fromArray(this._normals, lo * 3);
    _v2.fromArray(this._normals, hi * 3);
    // Lerp then re-orthogonalise against the exact tangent: over one sample
    // interval the two normals are a few degrees apart, so the shortest-arc
    // subtlety a slerp would buy is below the sampling error anyway.
    out.copy(_v1).lerp(_v2, f);
    this.tangentAtDistance(distance, _t);
    out.addScaledVector(_t, -out.dot(_t));
    if (out.lengthSq() < 1e-10) out.copy(_v1);
    return out.normalize();
  }

  /** Position + orthonormal frame at `distance`. */
  frameAtDistance(distance, out = new SplineFrame()) {
    out.distance = THREE.MathUtils.clamp(distance, 0, this._length);
    this.pointAtDistance(out.distance, out.position);
    this.tangentAtDistance(out.distance, out.tangent);
    this.normalAtDistance(out.distance, out.normal);
    out.binormal.copy(out.tangent).cross(out.normal).normalize();
    return out;
  }

  /** `t` is a fraction of LENGTH, not of the curve parameter. */
  pointAt(t, out = new THREE.Vector3()) {
    return this.pointAtDistance(t * this._length, out);
  }

  tangentAt(t, out = new THREE.Vector3()) {
    return this.tangentAtDistance(t * this._length, out);
  }

  frameAt(t, out = new SplineFrame()) {
    return this.frameAtDistance(t * this._length, out);
  }

  /**
   * Orientation at `distance`.
   *
   * `forward` picks which local axis rides the tangent: "-Z" matches three's
   * own `lookAt`/camera convention, "+Z" matches how glTF characters are
   * usually authored. Getting this wrong makes an otherwise perfect patrol
   * route walk backwards, which reads as a pathing bug rather than an axis one.
   */
  quaternionAtDistance(distance, out = new THREE.Quaternion(), forward = "-Z") {
    this.frameAtDistance(distance, _frame);
    _n.copy(_frame.normal);
    if (forward === "+Z") {
      _b.copy(_n).cross(_frame.tangent).normalize();
      _m.makeBasis(_b, _n, _frame.tangent);
    } else {
      _b.copy(_frame.tangent).cross(_n).normalize();
      _m.makeBasis(_b, _n, _t.copy(_frame.tangent).negate());
    }
    return out.setFromRotationMatrix(_m);
  }

  /**
   * Nearest point on the curve to `point`.
   *
   * A coarse scan of the sample table, then an exact projection onto the
   * winning chord. Returns the arc-length distance, which is what every caller
   * actually wants — "how far along is the player" is the question behind auto
   * dolly, path progress and snapping a knot to the curve.
   */
  closestPoint(point, out = {}) {
    out.distance = 0;
    out.point = out.point ?? new THREE.Vector3();
    if (this._count < 2) {
      out.point.set(0, 0, 0);
      out.t = 0;
      out.sqDistance = point.distanceToSquared(out.point);
      return out;
    }
    let bestSq = Infinity;
    let bestIndex = 0;
    let bestF = 0;
    for (let i = 0; i < this._count - 1; i++) {
      _v1.fromArray(this._positions, i * 3);
      _v2.fromArray(this._positions, (i + 1) * 3);
      _v3.copy(_v2).sub(_v1);
      const lenSq = _v3.lengthSq();
      let f = 0;
      if (lenSq > 1e-12) f = THREE.MathUtils.clamp(_v0.copy(point).sub(_v1).dot(_v3) / lenSq, 0, 1);
      _v0.copy(_v1).addScaledVector(_v3, f);
      const sq = _v0.distanceToSquared(point);
      if (sq < bestSq) {
        bestSq = sq;
        bestIndex = i;
        bestF = f;
      }
    }
    const a = this._lengths[bestIndex];
    const b = this._lengths[bestIndex + 1];
    out.distance = a + (b - a) * bestF;
    out.t = this._length > 1e-9 ? out.distance / this._length : 0;
    out.sqDistance = bestSq;
    this.pointAtDistance(out.distance, out.point);
    return out;
  }

  /** Evenly spaced positions along the curve, `count` of them (endpoints included). */
  samplePositions(count) {
    const n = Math.max(2, Math.floor(count));
    const out = new Float32Array(n * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.pointAtDistance((i / (n - 1)) * this._length, p);
      p.toArray(out, i * 3);
    }
    return out;
  }

  /** The raw table: what the gizmo and the mesh extruder draw. */
  get sampleCount() {
    return this._count;
  }

  samplePosition(index, out = new THREE.Vector3()) {
    return out.fromArray(this._positions, index * 3);
  }

  sampleDistance(index) {
    return this._lengths[index] ?? 0;
  }
}

const _frame = new SplineFrame();

/**
 * Advances a distance along a path of `length`, applying the wrap rule.
 *
 * Shared by the follower and the camera dolly rather than written twice: the
 * ping-pong case in particular has an easy-to-get-wrong reflection, and having
 * one copy means a cart and a camera on the same rail turn round at the same
 * point.
 *
 * @returns {{distance:number, direction:number, finished:boolean}}
 *   `direction` is +1/-1 and only ever flips in ping-pong; `finished` is true
 *   the moment a "once"/"clamp" path reaches its end, so a caller can fire a
 *   completion event exactly once.
 */
export function advanceAlong(distance, delta, length, mode = "clamp", direction = 1) {
  if (!(length > 1e-9)) return { distance: 0, direction, finished: true };
  let d = distance + delta * direction;
  let dir = direction;
  let finished = false;
  if (mode === "loop") {
    d = ((d % length) + length) % length;
  } else if (mode === "pingPong") {
    // Reflect repeatedly rather than once: a single reflection is wrong for a
    // delta longer than the path, which is what a big timeScale or a long
    // frame hitch produces.
    let guard = 0;
    while ((d < 0 || d > length) && guard++ < 64) {
      if (d > length) {
        d = 2 * length - d;
        dir = -dir;
      } else if (d < 0) {
        d = -d;
        dir = -dir;
      }
    }
    d = THREE.MathUtils.clamp(d, 0, length);
  } else {
    if (d >= length) {
      d = length;
      finished = true;
    } else if (d <= 0) {
      d = 0;
      finished = delta * direction < 0;
    }
  }
  return { distance: d, direction: dir, finished };
}
