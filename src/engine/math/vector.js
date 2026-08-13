// @ts-check
/**
 * Vector operations three does not have.
 *
 * This is deliberately **not** a vector class. `Vector3` is three's, it is the
 * engine's, and a script's `Vector3` is the same constructor — introducing a
 * second one would fork the type and break `instanceof` across the script
 * boundary. So everything here is a free function over the *shape*
 * `{ x, y, z }`, which means it works on a three `Vector3`, on a plain object
 * literal, and on a component's prop without a conversion at either end.
 *
 * Anything three already does well — `add`, `normalize`, `applyQuaternion`,
 * `projectOnPlane`, `reflect`, `clampLength`, `angleTo` — is absent on
 * purpose. What is here is the gameplay layer above that: smoothing that takes
 * a delta, rotation limited by a rate, and the signed measurements steering
 * code actually asks for.
 *
 * Functions that produce a vector take an optional `out`; passing the vector
 * you already own is what keeps a per-frame call from allocating.
 */

import { clamp, clamp01, EPSILON, lerp } from "./scalar.js";

/**
 * @typedef {{ x: number, y: number }} Vec2Like
 * @typedef {{ x: number, y: number, z: number }} Vec3Like
 * @typedef {{ x: number, y: number, z: number, w: number }} QuatLike
 */

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

/** @type {Vec3Like} */
const TMP = { x: 0, y: 0, z: 0 };

export const vec3 = {
  /**
   * Steps `current` toward `target` by at most `maxDistance`, stopping exactly
   * on it. Constant speed — the vector equivalent of
   * {@link import("./scalar.js").moveTowards}.
   *
   * @template {Vec3Like} T
   * @param {T} current mutated in place.
   * @param {Vec3Like} target
   * @param {number} maxDistance
   * @returns {T} `current`.
   */
  moveTowards(current, target, maxDistance) {
    const dx = target.x - current.x;
    const dy = target.y - current.y;
    const dz = target.z - current.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= maxDistance || distance < EPSILON) {
      current.x = target.x;
      current.y = target.y;
      current.z = target.z;
      return current;
    }
    const scale = maxDistance / distance;
    current.x += dx * scale;
    current.y += dy * scale;
    current.z += dz * scale;
    return current;
  },

  /**
   * Frame-rate-independent smoothing toward `target`. The right way to make a
   * camera or a held object follow: `lerp(pos, target, 0.1)` in an update
   * moves at a speed that changes with frame rate; this does not.
   *
   * @template {Vec3Like} T
   * @param {T} current mutated in place.
   * @param {Vec3Like} target
   * @param {number} lambda convergence rate, per second.
   * @param {number} dt seconds since the last call.
   * @returns {T} `current`.
   */
  damp(current, target, lambda, dt) {
    const t = 1 - Math.exp(-lambda * dt);
    current.x = lerp(current.x, target.x, t);
    current.y = lerp(current.y, target.y, t);
    current.z = lerp(current.z, target.z, t);
    return current;
  },

  /**
   * A critically damped spring per axis — Unity's `Vector3.SmoothDamp`, and
   * the standard follow-camera solution. `velocity` is state the caller owns
   * and must pass back in unchanged each frame; it is mutated in place.
   *
   *     this._vel ??= new Vector3();
   *     math.vec3.smoothDamp(this.entity.position, target, this._vel, 0.15, dt);
   *
   * @template {Vec3Like} T
   * @param {T} current mutated in place.
   * @param {Vec3Like} target
   * @param {Vec3Like} velocity mutated in place — persist it between frames.
   * @param {number} smoothTime roughly the seconds taken to reach the target.
   * @param {number} dt seconds since the last call.
   * @param {number} [maxSpeed=Infinity] speed cap, in units per second.
   * @returns {T} `current`.
   */
  smoothDamp(current, target, velocity, smoothTime, dt, maxSpeed = Infinity) {
    const time = Math.max(0.0001, smoothTime);
    const omega = 2 / time;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    let cx = current.x - target.x;
    let cy = current.y - target.y;
    let cz = current.z - target.z;
    const originalX = target.x;
    const originalY = target.y;
    const originalZ = target.z;

    // Clamp the whole displacement, not each axis: capping per axis would let
    // a diagonal move √3 times faster than an axis-aligned one.
    const maxChange = maxSpeed * time;
    const magnitude = Math.hypot(cx, cy, cz);
    if (magnitude > maxChange && magnitude > EPSILON) {
      const scale = maxChange / magnitude;
      cx *= scale;
      cy *= scale;
      cz *= scale;
    }

    const tx = current.x - cx;
    const ty = current.y - cy;
    const tz = current.z - cz;

    const tempX = (velocity.x + omega * cx) * dt;
    const tempY = (velocity.y + omega * cy) * dt;
    const tempZ = (velocity.z + omega * cz) * dt;
    velocity.x = (velocity.x - omega * tempX) * exp;
    velocity.y = (velocity.y - omega * tempY) * exp;
    velocity.z = (velocity.z - omega * tempZ) * exp;

    let outX = tx + (cx + tempX) * exp;
    let outY = ty + (cy + tempY) * exp;
    let outZ = tz + (cz + tempZ) * exp;

    // Overshoot guard, on the vector as a whole: if the result has passed the
    // target along the original approach direction, snap to it.
    const origMinusCurrentX = originalX - current.x;
    const origMinusCurrentY = originalY - current.y;
    const origMinusCurrentZ = originalZ - current.z;
    const outMinusOrigX = outX - originalX;
    const outMinusOrigY = outY - originalY;
    const outMinusOrigZ = outZ - originalZ;
    if (
      origMinusCurrentX * outMinusOrigX +
        origMinusCurrentY * outMinusOrigY +
        origMinusCurrentZ * outMinusOrigZ >
      0
    ) {
      outX = originalX;
      outY = originalY;
      outZ = originalZ;
      velocity.x = 0;
      velocity.y = 0;
      velocity.z = 0;
    }

    current.x = outX;
    current.y = outY;
    current.z = outZ;
    return current;
  },

  /**
   * Rotates the direction `current` toward `target` by at most `maxRadians`,
   * along the shortest arc, keeping unit length. What an AI's "turn to face"
   * wants: a `lerp` between two directions cuts through the middle and
   * shortens the vector as it goes.
   *
   * @template {Vec3Like} T
   * @param {T} current mutated in place; assumed normalized.
   * @param {Vec3Like} target assumed normalized.
   * @param {number} maxRadians
   * @returns {T} `current`.
   */
  rotateTowards(current, target, maxRadians) {
    const dot = clamp(
      current.x * target.x + current.y * target.y + current.z * target.z,
      -1,
      1,
    );
    const angle = Math.acos(dot);
    if (angle < EPSILON) return current;
    return vec3.slerp(current, target, Math.min(1, maxRadians / angle), current);
  },

  /**
   * Spherical interpolation between two directions — constant angular speed,
   * constant length. Three's `Vector3.lerp` is linear, which is why a slerped
   * camera pan feels even and a lerped one speeds up in the middle.
   *
   * Falls back to a straight blend for nearly-parallel inputs, where the arc
   * is numerically ill-defined and indistinguishable from the chord anyway.
   *
   * @template {Vec3Like} T
   * @param {Vec3Like} a assumed normalized.
   * @param {Vec3Like} b assumed normalized.
   * @param {number} t
   * @param {T} out
   * @returns {T}
   */
  slerp(a, b, t, out) {
    const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    if (sinTheta < 1e-4) {
      out.x = lerp(a.x, b.x, t);
      out.y = lerp(a.y, b.y, t);
      out.z = lerp(a.z, b.z, t);
      return out;
    }
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out.x = a.x * wa + b.x * wb;
    out.y = a.y * wa + b.y * wb;
    out.z = a.z * wa + b.z * wb;
    return out;
  },

  /**
   * The angle from `a` to `b` **with a sign**, measured about `axis`.
   * Three only gives you the unsigned `angleTo`, which cannot tell "turn left"
   * from "turn right" — the one thing steering code needs to know.
   *
   * @param {Vec3Like} a
   * @param {Vec3Like} b
   * @param {Vec3Like} axis the rotation axis, normally the up vector.
   * @returns {number} radians in `[-π, π]`.
   */
  signedAngle(a, b, axis) {
    const cx = a.y * b.z - a.z * b.y;
    const cy = a.z * b.x - a.x * b.z;
    const cz = a.x * b.y - a.y * b.x;
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    const cross = Math.hypot(cx, cy, cz);
    const sign = cx * axis.x + cy * axis.y + cz * axis.z < 0 ? -1 : 1;
    return Math.atan2(cross, dot) * sign;
  },

  /**
   * Normalizes in place, leaving a zero-length vector at zero instead of
   * filling it with NaN. Worth using anywhere the input is a difference of two
   * positions that may coincide.
   *
   * @template {Vec3Like} T
   * @param {T} v mutated in place.
   * @returns {T} `v`.
   */
  safeNormalize(v) {
    const length = Math.hypot(v.x, v.y, v.z);
    if (length < EPSILON) {
      v.x = 0;
      v.y = 0;
      v.z = 0;
      return v;
    }
    v.x /= length;
    v.y /= length;
    v.z /= length;
    return v;
  },

  /**
   * The horizontal distance between two points, ignoring Y — what "is the
   * enemy in range" almost always means, since a target on a ledge is not
   * further away in any sense the player cares about.
   *
   * @param {Vec3Like} a
   * @param {Vec3Like} b
   * @returns {number}
   */
  horizontalDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  },

  /**
   * True when `b` is within `radius` of `a`, comparing squared lengths so no
   * square root is taken. Use it in any per-frame proximity check.
   *
   * @param {Vec3Like} a
   * @param {Vec3Like} b
   * @param {number} radius
   * @returns {boolean}
   */
  within(a, b, radius) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  },

  /**
   * Yaw and pitch of a direction, in radians — the pair a camera or a
   * turret is actually driven by. Inverse of {@link vec3.fromYawPitch}.
   *
   * @param {Vec3Like} direction
   * @param {{ yaw: number, pitch: number }} [out]
   * @returns {{ yaw: number, pitch: number }}
   */
  toYawPitch(direction, out = { yaw: 0, pitch: 0 }) {
    const horizontal = Math.hypot(direction.x, direction.z);
    out.yaw = Math.atan2(direction.x, direction.z);
    out.pitch =
      horizontal < EPSILON
        ? direction.y >= 0
          ? Math.PI / 2
          : -Math.PI / 2
        : Math.atan2(direction.y, horizontal);
    return out;
  },

  /**
   * The unit direction for a yaw/pitch pair.
   *
   * @template {Vec3Like} T
   * @param {number} yaw
   * @param {number} pitch
   * @param {T} out
   * @returns {T}
   */
  fromYawPitch(yaw, pitch, out) {
    const cosPitch = Math.cos(pitch);
    out.x = Math.sin(yaw) * cosPitch;
    out.y = Math.sin(pitch);
    out.z = Math.cos(yaw) * cosPitch;
    return out;
  },

  /**
   * A point on a quadratic Bézier — three control points, the cheapest curve
   * worth having. Arcing projectiles, a UI element flying to an inventory
   * slot, a simple camera path.
   *
   * @template {Vec3Like} T
   * @param {Vec3Like} p0
   * @param {Vec3Like} p1 the control point; the curve does not pass through it.
   * @param {Vec3Like} p2
   * @param {number} t
   * @param {T} out
   * @returns {T}
   */
  quadraticBezier(p0, p1, p2, t, out) {
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    out.x = p0.x * a + p1.x * b + p2.x * c;
    out.y = p0.y * a + p1.y * b + p2.y * c;
    out.z = p0.z * a + p1.z * b + p2.z * c;
    return out;
  },

  /**
   * Catmull–Rom through four points, evaluated on the segment `p1`→`p2`. The
   * curve passes through every control point, which is what makes it the
   * right pick for smoothing a recorded path or a set of waypoints.
   *
   * @template {Vec3Like} T
   * @param {Vec3Like} p0
   * @param {Vec3Like} p1
   * @param {Vec3Like} p2
   * @param {Vec3Like} p3
   * @param {number} t 0 at `p1`, 1 at `p2`.
   * @param {T} out
   * @returns {T}
   */
  catmullRom(p0, p1, p2, p3, t, out) {
    const t2 = t * t;
    const t3 = t2 * t;
    const a = -0.5 * t3 + t2 - 0.5 * t;
    const b = 1.5 * t3 - 2.5 * t2 + 1;
    const c = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const d = 0.5 * t3 - 0.5 * t2;
    out.x = p0.x * a + p1.x * b + p2.x * c + p3.x * d;
    out.y = p0.y * a + p1.y * b + p2.y * c + p3.y * d;
    out.z = p0.z * a + p1.z * b + p2.z * c + p3.z * d;
    return out;
  },
};

/**
 * Two unit vectors perpendicular to `normal` and to each other — a tangent
 * frame for scattering, decal orientation, or cone sampling.
 *
 * Uses Duff et al.'s branchless construction, which stays stable for every
 * input including one pointing along -Z, where the textbook "cross with an
 * arbitrary axis" version collapses.
 *
 * @template {Vec3Like} T
 * @param {Vec3Like} normal assumed normalized.
 * @param {T} outTangent
 * @param {T} outBitangent
 * @returns {T} `outTangent`.
 */
export function orthonormalBasis(normal, outTangent, outBitangent) {
  const sign = normal.z >= 0 ? 1 : -1;
  const a = -1 / (sign + normal.z);
  const b = normal.x * normal.y * a;
  outTangent.x = 1 + sign * normal.x * normal.x * a;
  outTangent.y = sign * b;
  outTangent.z = -sign * normal.x;
  outBitangent.x = b;
  outBitangent.y = sign + normal.y * normal.y * a;
  outBitangent.z = -normal.y;
  return outTangent;
}

// ---------------------------------------------------------------------------
// 2D
// ---------------------------------------------------------------------------

export const vec2 = {
  /**
   * @template {Vec2Like} T
   * @param {T} current mutated in place.
   * @param {Vec2Like} target
   * @param {number} maxDistance
   * @returns {T} `current`.
   */
  moveTowards(current, target, maxDistance) {
    const dx = target.x - current.x;
    const dy = target.y - current.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= maxDistance || distance < EPSILON) {
      current.x = target.x;
      current.y = target.y;
      return current;
    }
    current.x += (dx / distance) * maxDistance;
    current.y += (dy / distance) * maxDistance;
    return current;
  },

  /**
   * Frame-rate-independent smoothing. See {@link vec3.damp}.
   *
   * @template {Vec2Like} T
   * @param {T} current mutated in place.
   * @param {Vec2Like} target
   * @param {number} lambda
   * @param {number} dt
   * @returns {T} `current`.
   */
  damp(current, target, lambda, dt) {
    const t = 1 - Math.exp(-lambda * dt);
    current.x = lerp(current.x, target.x, t);
    current.y = lerp(current.y, target.y, t);
    return current;
  },

  /**
   * Rotates about the origin by `radians`, counter-clockwise.
   *
   * @template {Vec2Like} T
   * @param {T} v mutated in place.
   * @param {number} radians
   * @returns {T} `v`.
   */
  rotate(v, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const x = v.x;
    v.x = x * cos - v.y * sin;
    v.y = x * sin + v.y * cos;
    return v;
  },

  /**
   * The 2D cross product — a scalar. Its sign says which side of `a` the
   * vector `b` is on, which is the whole of 2D "am I turning left or right".
   *
   * @param {Vec2Like} a
   * @param {Vec2Like} b
   * @returns {number}
   */
  cross(a, b) {
    return a.x * b.y - a.y * b.x;
  },

  /**
   * The signed angle from `a` to `b`, in `[-π, π]`.
   *
   * @param {Vec2Like} a
   * @param {Vec2Like} b
   * @returns {number}
   */
  signedAngle(a, b) {
    return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  },

  /**
   * The unit vector at `radians`.
   *
   * @template {Vec2Like} T
   * @param {number} radians
   * @param {T} out
   * @returns {T}
   */
  fromAngle(radians, out) {
    out.x = Math.cos(radians);
    out.y = Math.sin(radians);
    return out;
  },

  /**
   * Normalizes in place, leaving zero at zero. See {@link vec3.safeNormalize}.
   *
   * @template {Vec2Like} T
   * @param {T} v mutated in place.
   * @returns {T} `v`.
   */
  safeNormalize(v) {
    const length = Math.hypot(v.x, v.y);
    if (length < EPSILON) {
      v.x = 0;
      v.y = 0;
      return v;
    }
    v.x /= length;
    v.y /= length;
    return v;
  },

  /**
   * Rescales a stick or WASD vector so that diagonals are not faster than the
   * cardinals, while leaving partial deflections alone — the fix for the
   * oldest movement bug there is.
   *
   * @template {Vec2Like} T
   * @param {T} v mutated in place.
   * @param {number} [deadzone=0] input below this magnitude reads as zero.
   * @returns {T} `v`.
   */
  clampStick(v, deadzone = 0) {
    const length = Math.hypot(v.x, v.y);
    if (length <= deadzone || length < EPSILON) {
      v.x = 0;
      v.y = 0;
      return v;
    }
    // Remap magnitude so the deadzone edge is 0 and full deflection is 1.
    // Scaling the raw magnitude instead makes the stick jump to `deadzone`
    // the instant it engages, which players feel as a dead, then twitchy, stick.
    const magnitude = clamp01((length - deadzone) / Math.max(EPSILON, 1 - deadzone));
    const scale = magnitude / length;
    v.x *= scale;
    v.y *= scale;
    return v;
  },
};

// ---------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------

export const quat = {
  /**
   * Frame-rate-independent rotational smoothing — the rotation counterpart of
   * {@link vec3.damp}, and what a follow camera's aim should use.
   *
   * @template {QuatLike} T
   * @param {T} current mutated in place.
   * @param {QuatLike} target
   * @param {number} lambda convergence rate, per second.
   * @param {number} dt seconds since the last call.
   * @returns {T} `current`.
   */
  damp(current, target, lambda, dt) {
    return quat.slerp(current, target, 1 - Math.exp(-lambda * dt));
  },

  /**
   * In-place slerp. Three's `Quaternion.slerp` already exists and this matches
   * it; it is here so the whole `math` package stays importable without three
   * (a Node test, a worker, a headless tool) and so `damp` above has something
   * to call.
   *
   * @template {QuatLike} T
   * @param {T} current mutated in place.
   * @param {QuatLike} target
   * @param {number} t
   * @returns {T} `current`.
   */
  slerp(current, target, t) {
    if (t <= 0) return current;
    if (t >= 1) {
      current.x = target.x;
      current.y = target.y;
      current.z = target.z;
      current.w = target.w;
      return current;
    }
    let { x, y, z, w } = target;
    let cosHalfTheta = current.w * w + current.x * x + current.y * y + current.z * z;
    // q and -q are the same rotation; flipping the sign is what makes the
    // blend take the short way round.
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      x = -x;
      y = -y;
      z = -z;
      w = -w;
    }
    if (cosHalfTheta >= 1) return current;

    const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
    if (Math.abs(sinHalfTheta) < 0.001) {
      current.x = current.x * 0.5 + x * 0.5;
      current.y = current.y * 0.5 + y * 0.5;
      current.z = current.z * 0.5 + z * 0.5;
      current.w = current.w * 0.5 + w * 0.5;
      return current;
    }
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    current.x = current.x * ratioA + x * ratioB;
    current.y = current.y * ratioA + y * ratioB;
    current.z = current.z * ratioA + z * ratioB;
    current.w = current.w * ratioA + w * ratioB;
    return current;
  },

  /**
   * The angle between two rotations, in radians — "how far is this bone from
   * its target pose", the number a rotation tolerance is compared against.
   *
   * @param {QuatLike} a
   * @param {QuatLike} b
   * @returns {number}
   */
  angleBetween(a, b) {
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    return 2 * Math.acos(clamp(dot, -1, 1));
  },

  /**
   * The rotation that looks along `forward` with the given up vector, written
   * as a quaternion. Equivalent to three's `Object3D.lookAt` without needing
   * an object, a matrix, or a scene-graph round trip.
   *
   * Handles the degenerate case where forward and up are parallel — looking
   * straight up, where the naive construction produces a zero-length right
   * vector and every subsequent frame is NaN.
   *
   * @template {QuatLike} T
   * @param {Vec3Like} forward need not be normalized.
   * @param {Vec3Like} up
   * @param {T} out
   * @returns {T}
   */
  lookRotation(forward, up, out) {
    let fx = forward.x;
    let fy = forward.y;
    let fz = forward.z;
    const fLen = Math.hypot(fx, fy, fz);
    if (fLen < EPSILON) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    fx /= fLen;
    fy /= fLen;
    fz /= fLen;

    // three's cameras look down -Z, so the basis is built from -forward.
    const zx = -fx;
    const zy = -fy;
    const zz = -fz;

    let rx = up.y * zz - up.z * zy;
    let ry = up.z * zx - up.x * zz;
    let rz = up.x * zy - up.y * zx;
    let rLen = Math.hypot(rx, ry, rz);
    if (rLen < EPSILON) {
      // up ∥ forward: pick any perpendicular rather than dividing by zero.
      TMP.x = Math.abs(zy) < 0.9 ? 0 : 1;
      TMP.y = Math.abs(zy) < 0.9 ? 1 : 0;
      TMP.z = 0;
      rx = TMP.y * zz - TMP.z * zy;
      ry = TMP.z * zx - TMP.x * zz;
      rz = TMP.x * zy - TMP.y * zx;
      rLen = Math.hypot(rx, ry, rz) || 1;
    }
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    const ux = zy * rz - zz * ry;
    const uy = zz * rx - zx * rz;
    const uz = zx * ry - zy * rx;

    // Matrix (columns r, u, z) → quaternion, via the numerically stable
    // largest-component branch.
    const trace = rx + uy + zz;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      out.w = 0.25 / s;
      out.x = (uz - zy) * s;
      out.y = (zx - rz) * s;
      out.z = (ry - ux) * s;
    } else if (rx > uy && rx > zz) {
      const s = 2 * Math.sqrt(1 + rx - uy - zz);
      out.w = (uz - zy) / s;
      out.x = 0.25 * s;
      out.y = (ux + ry) / s;
      out.z = (zx + rz) / s;
    } else if (uy > zz) {
      const s = 2 * Math.sqrt(1 + uy - rx - zz);
      out.w = (zx - rz) / s;
      out.x = (ux + ry) / s;
      out.y = 0.25 * s;
      out.z = (zy + uz) / s;
    } else {
      const s = 2 * Math.sqrt(1 + zz - rx - uy);
      out.w = (ry - ux) / s;
      out.x = (zx + rz) / s;
      out.y = (zy + uz) / s;
      out.z = 0.25 * s;
    }
    return out;
  },
};
