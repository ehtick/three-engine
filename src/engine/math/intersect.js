// @ts-check
/**
 * Geometric queries — distances, closest points, and ray tests.
 *
 * The overlap with three is real and deliberate: `Ray.intersectSphere`,
 * `Box3.intersectsBox` and friends exist and are fine. What they are not is
 * *free* — every one of them wants a `Ray`, a `Box3`, a `Sphere` and a
 * `Vector3` to write into, and gameplay code frequently has none of those, just
 * six numbers and a hot loop. Everything here takes plain `{x, y, z}` shapes
 * (a three vector satisfies that), returns a distance or `null`, and allocates
 * nothing.
 *
 * The other half of the reason is coverage: the closest-point-between-segments
 * a melee hit needs, the swept sphere a fast projectile needs to not tunnel,
 * and the 2D segment crossing a nav or minimap needs have no three equivalent
 * at all.
 *
 * **Convention**: a ray is an origin plus a **normalized** direction; every
 * `ray*` function returns the distance `t` along it, so the hit point is
 * `origin + direction * t`. `null` means no hit. Hits behind the origin are
 * not reported.
 */

import { clamp, clamp01, EPSILON } from "./scalar.js";

/**
 * @typedef {{ x: number, y: number }} Vec2Like
 * @typedef {{ x: number, y: number, z: number }} Vec3Like
 */

// ---------------------------------------------------------------------------
// Closest points and distances
// ---------------------------------------------------------------------------

/**
 * How far along the segment `a`→`b` the closest point to `p` lies, as a 0..1
 * fraction. The building block for every "am I near this wall / rope / laser"
 * question.
 *
 * @param {Vec3Like} p
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @returns {number}
 */
export function closestPointOnSegmentT(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  if (lengthSq < EPSILON) return 0;
  return clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lengthSq);
}

/**
 * The point on the segment `a`→`b` nearest to `p`.
 *
 * @template {Vec3Like} T
 * @param {Vec3Like} p
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @param {T} out
 * @returns {T}
 */
export function closestPointOnSegment(p, a, b, out) {
  const t = closestPointOnSegmentT(p, a, b);
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * Distance from a point to a segment.
 *
 * @param {Vec3Like} p
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @returns {number}
 */
export function distanceToSegment(p, a, b) {
  const t = closestPointOnSegmentT(p, a, b);
  return Math.hypot(
    p.x - (a.x + (b.x - a.x) * t),
    p.y - (a.y + (b.y - a.y) * t),
    p.z - (a.z + (b.z - a.z) * t),
  );
}

/**
 * The closest pair of points between two segments, and the distance between
 * them. This is capsule-vs-capsule in disguise: a sword swing against a limb,
 * two ropes, a laser against a beam. Handles the parallel case, which the
 * obvious derivation divides by zero on.
 *
 * @param {Vec3Like} a0
 * @param {Vec3Like} a1
 * @param {Vec3Like} b0
 * @param {Vec3Like} b1
 * @param {Vec3Like} [outA] the point on segment A.
 * @param {Vec3Like} [outB] the point on segment B.
 * @returns {number} the distance between the two closest points.
 */
export function closestPointsBetweenSegments(a0, a1, b0, b1, outA, outB) {
  const ux = a1.x - a0.x;
  const uy = a1.y - a0.y;
  const uz = a1.z - a0.z;
  const vx = b1.x - b0.x;
  const vy = b1.y - b0.y;
  const vz = b1.z - b0.z;
  const wx = a0.x - b0.x;
  const wy = a0.y - b0.y;
  const wz = a0.z - b0.z;

  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const denominator = a * c - b * b;

  let s;
  let t;
  if (denominator < EPSILON) {
    // Parallel (or one segment is a point): any s works, so pin s and solve t.
    s = 0;
    t = c < EPSILON ? 0 : clamp01(e / c);
  } else {
    s = clamp01((b * e - c * d) / denominator);
    t = clamp01((a * e - b * d) / denominator);
    // Clamping s can invalidate t and vice versa; one re-solve of each is
    // enough to land on the true minimum for segments (not for lines).
    t = c < EPSILON ? 0 : clamp01((b * s + e) / c);
    s = a < EPSILON ? 0 : clamp01((b * t - d) / a);
  }

  const px = a0.x + ux * s;
  const py = a0.y + uy * s;
  const pz = a0.z + uz * s;
  const qx = b0.x + vx * t;
  const qy = b0.y + vy * t;
  const qz = b0.z + vz * t;
  if (outA) {
    outA.x = px;
    outA.y = py;
    outA.z = pz;
  }
  if (outB) {
    outB.x = qx;
    outB.y = qy;
    outB.z = qz;
  }
  return Math.hypot(px - qx, py - qy, pz - qz);
}

/**
 * Signed distance from a point to a plane. Positive is the side the normal
 * points to — which side of a wall, a door or a trigger volume you are on.
 *
 * @param {Vec3Like} p
 * @param {Vec3Like} planeNormal assumed normalized.
 * @param {number} planeConstant such that `dot(normal, x) + constant = 0` on
 *   the plane (three's `Plane` convention).
 * @returns {number}
 */
export function distanceToPlane(p, planeNormal, planeConstant) {
  return planeNormal.x * p.x + planeNormal.y * p.y + planeNormal.z * p.z + planeConstant;
}

/**
 * Barycentric coordinates of `p` with respect to a triangle, written into
 * `out` as `{ u, v, w }` (the weights of `a`, `b`, `c`). Interpolating any
 * per-vertex attribute at a hit point is exactly this: `u*A + v*B + w*C`.
 *
 * @param {Vec3Like} p
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @param {Vec3Like} c
 * @param {{ u: number, v: number, w: number }} [out]
 * @returns {{ u: number, v: number, w: number }}
 */
export function barycentric(p, a, b, c, out = { u: 0, v: 0, w: 0 }) {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v0z = b.z - a.z;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v1z = c.z - a.z;
  const v2x = p.x - a.x;
  const v2y = p.y - a.y;
  const v2z = p.z - a.z;

  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) < EPSILON) {
    // Degenerate triangle: everything collapses onto the first vertex.
    out.u = 1;
    out.v = 0;
    out.w = 0;
    return out;
  }
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  out.u = 1 - v - w;
  out.v = v;
  out.w = w;
  return out;
}

/**
 * The area of a triangle.
 *
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @param {Vec3Like} c
 * @returns {number}
 */
export function triangleArea(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

// ---------------------------------------------------------------------------
// Ray casts
// ---------------------------------------------------------------------------

/**
 * Ray vs. infinite plane.
 *
 * @param {Vec3Like} origin
 * @param {Vec3Like} direction assumed normalized.
 * @param {Vec3Like} planeNormal assumed normalized.
 * @param {number} planeConstant
 * @returns {number | null} distance along the ray, or null.
 */
export function rayPlane(origin, direction, planeNormal, planeConstant) {
  const denominator =
    planeNormal.x * direction.x + planeNormal.y * direction.y + planeNormal.z * direction.z;
  if (Math.abs(denominator) < EPSILON) return null; // parallel
  const t = -(distanceToPlane(origin, planeNormal, planeConstant)) / denominator;
  return t < 0 ? null : t;
}

/**
 * Ray vs. sphere — the nearest hit in front of the origin. A ray starting
 * *inside* the sphere reports the exit point rather than nothing, which is
 * what a camera inside a trigger volume needs.
 *
 * @param {Vec3Like} origin
 * @param {Vec3Like} direction assumed normalized.
 * @param {Vec3Like} center
 * @param {number} radius
 * @returns {number | null}
 */
export function raySphere(origin, direction, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  if (near >= 0) return near;
  const far = -b + root;
  return far >= 0 ? far : null;
}

/**
 * Ray vs. axis-aligned box, by the slab method. Like {@link raySphere}, a ray
 * starting inside reports the exit.
 *
 * @param {Vec3Like} origin
 * @param {Vec3Like} direction assumed normalized.
 * @param {Vec3Like} min
 * @param {Vec3Like} max
 * @returns {number | null}
 */
export function rayBox(origin, direction, min, max) {
  // Dividing by a zero component yields ±Infinity, and the min/max comparisons
  // below handle those correctly — an explicit parallel-axis branch is not
  // needed and gets the "origin exactly on a face" case wrong.
  let tMin = -Infinity;
  let tMax = Infinity;

  const invX = 1 / direction.x;
  let t1 = (min.x - origin.x) * invX;
  let t2 = (max.x - origin.x) * invX;
  tMin = Math.max(tMin, Math.min(t1, t2));
  tMax = Math.min(tMax, Math.max(t1, t2));

  const invY = 1 / direction.y;
  t1 = (min.y - origin.y) * invY;
  t2 = (max.y - origin.y) * invY;
  tMin = Math.max(tMin, Math.min(t1, t2));
  tMax = Math.min(tMax, Math.max(t1, t2));

  const invZ = 1 / direction.z;
  t1 = (min.z - origin.z) * invZ;
  t2 = (max.z - origin.z) * invZ;
  tMin = Math.max(tMin, Math.min(t1, t2));
  tMax = Math.min(tMax, Math.max(t1, t2));

  if (tMax < Math.max(tMin, 0)) return null;
  return tMin >= 0 ? tMin : tMax;
}

/**
 * Ray vs. triangle (Möller–Trumbore). Returns the distance and, if `out` is
 * given, the barycentric weights of the hit — everything you need to read a
 * UV or a vertex colour at the impact point.
 *
 * @param {Vec3Like} origin
 * @param {Vec3Like} direction assumed normalized.
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @param {Vec3Like} c
 * @param {boolean} [cullBackface=false]
 * @param {{ u: number, v: number, w: number }} [out]
 * @returns {number | null}
 */
export function rayTriangle(origin, direction, a, b, c, cullBackface = false, out) {
  const e1x = b.x - a.x;
  const e1y = b.y - a.y;
  const e1z = b.z - a.z;
  const e2x = c.x - a.x;
  const e2y = c.y - a.y;
  const e2z = c.z - a.z;

  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;

  if (cullBackface ? determinant < EPSILON : Math.abs(determinant) < EPSILON) return null;

  const inverse = 1 / determinant;
  const tx = origin.x - a.x;
  const ty = origin.y - a.y;
  const tz = origin.z - a.z;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;
  if (v < 0 || u + v > 1) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  if (t < 0) return null;
  if (out) {
    out.u = 1 - u - v;
    out.v = u;
    out.w = v;
  }
  return t;
}

/**
 * Ray vs. capsule — a segment `a`→`b` swept by `radius`. The shape most
 * characters are actually approximated by, and the one three has no test for.
 *
 * @param {Vec3Like} origin
 * @param {Vec3Like} direction assumed normalized.
 * @param {Vec3Like} a
 * @param {Vec3Like} b
 * @param {number} radius
 * @returns {number | null}
 */
export function rayCapsule(origin, direction, a, b, radius) {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const box = origin.x - a.x;
  const boy = origin.y - a.y;
  const boz = origin.z - a.z;

  const baba = bax * bax + bay * bay + baz * baz;
  if (baba < EPSILON) return raySphere(origin, direction, a, radius);

  const bard = bax * direction.x + bay * direction.y + baz * direction.z;
  const baoa = bax * box + bay * boy + baz * boz;
  const rdoa = direction.x * box + direction.y * boy + direction.z * boz;
  const oaoa = box * box + boy * boy + boz * boz;

  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - radius * radius * baba;
  const h = B * B - A * C;

  if (h >= 0 && Math.abs(A) > EPSILON) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    // Inside the cylindrical body, between the two caps.
    if (y > 0 && y < baba && t >= 0) return t;
  }
  // Otherwise it is a cap hit (or a miss) — test both end spheres.
  const capA = raySphere(origin, direction, a, radius);
  const capB = raySphere(origin, direction, b, radius);
  if (capA === null) return capB;
  if (capB === null) return capA;
  return Math.min(capA, capB);
}

// ---------------------------------------------------------------------------
// Overlap tests
// ---------------------------------------------------------------------------

/**
 * @param {Vec3Like} a
 * @param {number} radiusA
 * @param {Vec3Like} b
 * @param {number} radiusB
 * @returns {boolean}
 */
export function sphereSphere(a, radiusA, b, radiusB) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const r = radiusA + radiusB;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * @param {Vec3Like} minA
 * @param {Vec3Like} maxA
 * @param {Vec3Like} minB
 * @param {Vec3Like} maxB
 * @returns {boolean}
 */
export function boxBox(minA, maxA, minB, maxB) {
  return (
    minA.x <= maxB.x &&
    maxA.x >= minB.x &&
    minA.y <= maxB.y &&
    maxA.y >= minB.y &&
    minA.z <= maxB.z &&
    maxA.z >= minB.z
  );
}

/**
 * @param {Vec3Like} min
 * @param {Vec3Like} max
 * @param {Vec3Like} center
 * @param {number} radius
 * @returns {boolean}
 */
export function boxSphere(min, max, center, radius) {
  const x = clamp(center.x, min.x, max.x);
  const y = clamp(center.y, min.y, max.y);
  const z = clamp(center.z, min.z, max.z);
  const dx = x - center.x;
  const dy = y - center.y;
  const dz = z - center.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * @param {Vec3Like} p
 * @param {Vec3Like} min
 * @param {Vec3Like} max
 * @returns {boolean}
 */
export function pointInBox(p, min, max) {
  return (
    p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z
  );
}

/**
 * True when `target` lies inside the cone at `apex` opening along `axis` —
 * a field of view, a spotlight's reach, a cone attack. Combines the angle and
 * the range in one test.
 *
 * @param {Vec3Like} target
 * @param {Vec3Like} apex
 * @param {Vec3Like} axis assumed normalized.
 * @param {number} halfAngle in radians.
 * @param {number} [range=Infinity]
 * @returns {boolean}
 */
export function pointInCone(target, apex, axis, halfAngle, range = Infinity) {
  const dx = target.x - apex.x;
  const dy = target.y - apex.y;
  const dz = target.z - apex.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > range) return false;
  if (distance < EPSILON) return true;
  const cosine = (dx * axis.x + dy * axis.y + dz * axis.z) / distance;
  return cosine >= Math.cos(halfAngle);
}

/**
 * A moving sphere against a stationary one — the fix for a fast projectile
 * passing through a target between two frames. `velocity` is the *whole*
 * movement for the step (velocity × dt), and the result is the fraction of
 * that step at which contact happens.
 *
 * @param {Vec3Like} from the moving sphere's start centre.
 * @param {Vec3Like} velocity displacement over the step.
 * @param {number} radius the moving sphere's radius (0 for a point).
 * @param {Vec3Like} center the static sphere.
 * @param {number} staticRadius
 * @returns {number | null} 0..1 along the step, or null for no contact.
 */
export function sweepSphereSphere(from, velocity, radius, center, staticRadius) {
  const ox = from.x - center.x;
  const oy = from.y - center.y;
  const oz = from.z - center.z;
  const r = radius + staticRadius;

  const a = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
  const b = 2 * (ox * velocity.x + oy * velocity.y + oz * velocity.z);
  const c = ox * ox + oy * oy + oz * oz - r * r;

  if (c <= 0) return 0; // already overlapping at the start of the step
  if (a < EPSILON) return null; // not moving, and not overlapping

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

// ---------------------------------------------------------------------------
// 2D
// ---------------------------------------------------------------------------

/**
 * Where two 2D segments cross, if they do. Minimaps, nav boundaries,
 * line-of-sight on a plan, and any 2D game.
 *
 * @param {Vec2Like} a0
 * @param {Vec2Like} a1
 * @param {Vec2Like} b0
 * @param {Vec2Like} b1
 * @param {Vec2Like} [out] the crossing point.
 * @returns {boolean}
 */
export function segmentSegment2D(a0, a1, b0, b1, out) {
  const rx = a1.x - a0.x;
  const ry = a1.y - a0.y;
  const sx = b1.x - b0.x;
  const sy = b1.y - b0.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < EPSILON) return false; // parallel or collinear
  const t = ((b0.x - a0.x) * sy - (b0.y - a0.y) * sx) / denominator;
  const u = ((b0.x - a0.x) * ry - (b0.y - a0.y) * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  if (out) {
    out.x = a0.x + rx * t;
    out.y = a0.y + ry * t;
  }
  return true;
}

/**
 * Point-in-polygon by ray casting. Works for concave polygons and does not
 * care about winding order. `points` is a closed loop; do not repeat the first
 * point at the end.
 *
 * @param {Vec2Like} p
 * @param {readonly Vec2Like[]} points
 * @returns {boolean}
 */
export function pointInPolygon2D(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    // The `!==` on the y-comparisons is what makes a vertex exactly at the
    // test height count once rather than twice.
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The signed area of a 2D polygon: positive counter-clockwise, negative
 * clockwise. The sign is the cheapest winding-order test there is, and the
 * magnitude is the area.
 *
 * @param {readonly Vec2Like[]} points
 * @returns {number}
 */
export function polygonArea2D(points) {
  let total = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    total += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return -total / 2;
}
