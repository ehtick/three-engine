// @ts-check
/**
 * Ballistics and interception — "where do I aim?".
 *
 * Two problems, both of which every shooter, tower-defence and sports game has
 * to solve, and both of which are usually solved badly by iterating until it
 * looks close enough:
 *
 *   1. **Ballistic arc.** Given a launch speed and gravity, at what angle do I
 *      throw to land on that spot? ({@link launchAngles}, {@link solveBallistic})
 *   2. **Lead.** The target is moving; where will it be when my projectile
 *      arrives? ({@link interceptTime}, {@link interceptPoint})
 *
 * Both have closed-form answers, and both have a real "impossible" case — a
 * target out of range, a target faster than the projectile — which is returned
 * honestly as `null` rather than as a wild guess. A weapon that reports it
 * cannot make the shot is a weapon the AI can decide to reposition with.
 *
 * **Convention**: `gravity` is a positive magnitude acting along **-Y**
 * (9.81 for the real world). Pass the physics module's gravity magnitude.
 */

import { EPSILON } from "./scalar.js";

/**
 * @typedef {{ x: number, y: number, z: number }} Vec3Like
 */

/**
 * The two launch angles that hit a target, given a fixed speed.
 *
 * There are two because a mortar and a rifle can hit the same spot: the `low`
 * angle is the flat, fast shot, the `high` one lobs over cover. Returns null
 * when the target is out of range at that speed — the physics genuinely has no
 * solution, and clamping to 45° would just miss.
 *
 * @param {number} horizontalDistance ground distance to the target.
 * @param {number} heightDelta target height minus launch height.
 * @param {number} speed launch speed.
 * @param {number} [gravity=9.81] positive magnitude.
 * @returns {{ low: number, high: number } | null} angles above the horizon, in
 *   radians.
 */
export function launchAngles(horizontalDistance, heightDelta, speed, gravity = 9.81) {
  const x = horizontalDistance;
  const y = heightDelta;
  const v2 = speed * speed;
  if (x < EPSILON) {
    // Straight up: reachable only if the speed carries it high enough.
    const apex = v2 / (2 * gravity);
    return y <= apex ? { low: Math.PI / 2, high: Math.PI / 2 } : null;
  }
  const discriminant = v2 * v2 - gravity * (gravity * x * x + 2 * y * v2);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const gx = gravity * x;
  return {
    low: Math.atan((v2 - root) / gx),
    high: Math.atan((v2 + root) / gx),
  };
}

/**
 * The launch velocity that carries a projectile from `from` to `to` at the
 * given speed — {@link launchAngles} turned back into a vector you can hand
 * straight to a rigidbody.
 *
 *     const v = new Vector3();
 *     if (math.trajectory.solveBallistic(muzzle, target, 20, 9.81, false, v)) {
 *       grenade.getComponent(RigidbodyComponent).setLinearVelocity(v);
 *     }
 *
 * @param {Vec3Like} from
 * @param {Vec3Like} to
 * @param {number} speed
 * @param {number} [gravity=9.81]
 * @param {boolean} [preferHigh=false] true lobs over cover.
 * @param {Vec3Like} [out]
 * @returns {boolean} false when the target cannot be reached at that speed.
 */
export function solveBallistic(from, to, speed, gravity = 9.81, preferHigh = false, out) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  const angles = launchAngles(horizontal, to.y - from.y, speed, gravity);
  if (!angles) return false;
  const angle = preferHigh ? angles.high : angles.low;
  if (out) {
    const horizontalSpeed = Math.cos(angle) * speed;
    // A target directly overhead has no horizontal direction to scale; fire
    // straight up rather than dividing by zero.
    const nx = horizontal < EPSILON ? 0 : dx / horizontal;
    const nz = horizontal < EPSILON ? 0 : dz / horizontal;
    out.x = nx * horizontalSpeed;
    out.y = Math.sin(angle) * speed;
    out.z = nz * horizontalSpeed;
  }
  return true;
}

/**
 * Where a projectile is `time` seconds after launch, under gravity — the
 * sample behind the aiming arc a player throws along.
 *
 * @template {Vec3Like} T
 * @param {Vec3Like} from
 * @param {Vec3Like} velocity the launch velocity.
 * @param {number} time
 * @param {T} out
 * @param {number} [gravity=9.81]
 * @returns {T}
 */
export function projectileAt(from, velocity, time, out, gravity = 9.81) {
  out.x = from.x + velocity.x * time;
  out.y = from.y + velocity.y * time - 0.5 * gravity * time * time;
  out.z = from.z + velocity.z * time;
  return out;
}

/**
 * Seconds a shot launched with `velocity` takes to travel from `from` to
 * `to` — read off the **horizontal** distance, which is unambiguous.
 *
 * The vertical solution is not: a projectile passes any height below its apex
 * twice, so solving for the target's height gives two answers and the flat
 * (low-angle) shot at a raised target wants the FIRST one while a landing
 * wants the second. Using {@link timeToHeight} here silently overestimated
 * the flight of every low shot at an elevated target, and with it the lead.
 *
 * @param {Vec3Like} from
 * @param {Vec3Like} to
 * @param {Vec3Like} velocity
 * @returns {number | null} null when the shot has no horizontal travel.
 */
export function flightTime(from, to, velocity) {
  const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  if (horizontalSpeed < EPSILON) {
    // Straight up: fall back to the vertical solution, where the target being
    // directly overhead makes the two crossings meaningfully different anyway.
    return timeToHeight(velocity.y, to.y - from.y);
  }
  return horizontal / horizontalSpeed;
}

/**
 * Seconds until a projectile launched with `velocity` **lands** at
 * `heightDelta` above its launch height. `heightDelta` of 0 is flat ground;
 * negative is a target below.
 *
 * This is the descending crossing — the landing. A projectile also passes that
 * height on the way up; if you want the flight time to a target rather than to
 * the ground, use {@link flightTime}.
 *
 * @param {number} verticalSpeed the launch velocity's Y component.
 * @param {number} [heightDelta=0]
 * @param {number} [gravity=9.81]
 * @returns {number | null} null when that height is never reached.
 */
export function timeToHeight(verticalSpeed, heightDelta = 0, gravity = 9.81) {
  const discriminant = verticalSpeed * verticalSpeed - 2 * gravity * heightDelta;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  // The later of the two crossings — the one on the way down, which is the
  // landing rather than the moment it passed that height climbing.
  const t = (verticalSpeed + root) / gravity;
  return t >= 0 ? t : null;
}

/**
 * The peak height above launch, and when it happens.
 *
 * @param {number} verticalSpeed the launch velocity's Y component.
 * @param {number} [gravity=9.81]
 * @returns {{ height: number, time: number }}
 */
export function apex(verticalSpeed, gravity = 9.81) {
  const time = Math.max(0, verticalSpeed / gravity);
  return { height: (verticalSpeed * verticalSpeed) / (2 * gravity), time };
}

/**
 * The launch speed needed to jump `height` — the number a jump should be
 * authored with. Designers think in "how high can I get"; physics wants an
 * impulse, and this converts one to the other exactly.
 *
 * @param {number} height
 * @param {number} [gravity=9.81]
 * @returns {number}
 */
export function jumpSpeedForHeight(height, gravity = 9.81) {
  return Math.sqrt(Math.max(0, 2 * gravity * height));
}

/**
 * How long a projectile at `speed` takes to reach a target moving at constant
 * velocity — the lead time, and the root of every "aim ahead" implementation.
 *
 * Returns null when the shot is impossible: a target moving away faster than
 * the projectile can never be caught, and no amount of lead fixes it.
 *
 * @param {Vec3Like} relativePosition target position minus shooter position.
 * @param {Vec3Like} relativeVelocity target velocity minus shooter velocity.
 * @param {number} projectileSpeed
 * @returns {number | null} seconds until impact.
 */
export function interceptTime(relativePosition, relativeVelocity, projectileSpeed) {
  // |relPos + relVel·t| = speed·t, squared into a quadratic in t.
  const a =
    relativeVelocity.x * relativeVelocity.x +
    relativeVelocity.y * relativeVelocity.y +
    relativeVelocity.z * relativeVelocity.z -
    projectileSpeed * projectileSpeed;
  const b =
    2 *
    (relativePosition.x * relativeVelocity.x +
      relativePosition.y * relativeVelocity.y +
      relativePosition.z * relativeVelocity.z);
  const c =
    relativePosition.x * relativePosition.x +
    relativePosition.y * relativePosition.y +
    relativePosition.z * relativePosition.z;

  if (Math.abs(a) < EPSILON) {
    // Target closing at exactly the projectile's speed: linear, one solution.
    return Math.abs(b) < EPSILON ? null : -c / b;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  // The soonest impact that is actually in the future.
  const soonest = Math.min(t1, t2);
  if (soonest > 0) return soonest;
  const latest = Math.max(t1, t2);
  return latest > 0 ? latest : null;
}

/**
 * Where to aim to hit a moving target with a straight-flying projectile.
 *
 *     const aim = new Vector3();
 *     if (math.trajectory.interceptPoint(muzzle, enemy.position, enemyVel, 40, aim)) {
 *       turret.lookAt(aim);
 *     }
 *
 * @param {Vec3Like} shooterPosition
 * @param {Vec3Like} targetPosition
 * @param {Vec3Like} targetVelocity
 * @param {number} projectileSpeed
 * @param {Vec3Like} [out] the point to aim at.
 * @returns {boolean} false when the target cannot be caught.
 */
export function interceptPoint(
  shooterPosition,
  targetPosition,
  targetVelocity,
  projectileSpeed,
  out,
) {
  REL_POS.x = targetPosition.x - shooterPosition.x;
  REL_POS.y = targetPosition.y - shooterPosition.y;
  REL_POS.z = targetPosition.z - shooterPosition.z;
  const t = interceptTime(REL_POS, targetVelocity, projectileSpeed);
  if (t === null || t < 0) return false;
  if (out) {
    out.x = targetPosition.x + targetVelocity.x * t;
    out.y = targetPosition.y + targetVelocity.y * t;
    out.z = targetPosition.z + targetVelocity.z * t;
  }
  return true;
}

/**
 * The launch velocity that hits a moving target with a ballistic arc — the two
 * problems above, composed. Solves the lead assuming a straight shot at the
 * same speed, then arcs at the predicted point. That is an approximation (the
 * arc's ground speed is lower than the projectile speed, so the lead is
 * slightly short), and it converges in two passes, which is what this does.
 *
 * @param {Vec3Like} from
 * @param {Vec3Like} targetPosition
 * @param {Vec3Like} targetVelocity
 * @param {number} speed
 * @param {number} [gravity=9.81]
 * @param {boolean} [preferHigh=false]
 * @param {Vec3Like} [out]
 * @returns {boolean}
 */
export function solveBallisticLead(
  from,
  targetPosition,
  targetVelocity,
  speed,
  gravity = 9.81,
  preferHigh = false,
  out,
) {
  AIM.x = targetPosition.x;
  AIM.y = targetPosition.y;
  AIM.z = targetPosition.z;
  for (let pass = 0; pass < 2; pass++) {
    if (!solveBallistic(from, AIM, speed, gravity, preferHigh, VELOCITY)) return false;
    const flight = flightTime(from, AIM, VELOCITY);
    if (flight === null) return false;
    AIM.x = targetPosition.x + targetVelocity.x * flight;
    AIM.y = targetPosition.y + targetVelocity.y * flight;
    AIM.z = targetPosition.z + targetVelocity.z * flight;
  }
  if (!solveBallistic(from, AIM, speed, gravity, preferHigh, VELOCITY)) return false;
  if (out) {
    out.x = VELOCITY.x;
    out.y = VELOCITY.y;
    out.z = VELOCITY.z;
  }
  return true;
}

/**
 * Samples a ballistic arc into an array of points — the aiming guide a grenade
 * throw draws. Stops early at `maxTime`.
 *
 * @param {Vec3Like} from
 * @param {Vec3Like} velocity
 * @param {number} steps
 * @param {number} maxTime
 * @param {number} [gravity=9.81]
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function sampleArc(from, velocity, steps, maxTime, gravity = 9.81) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / Math.max(1, steps)) * maxTime;
    points.push(projectileAt(from, velocity, t, { x: 0, y: 0, z: 0 }, gravity));
  }
  return points;
}

// Scratch vectors. This module is called from gameplay code at whatever rate
// the weapons fire, and a per-shot allocation is a per-shot GC contribution.
const REL_POS = { x: 0, y: 0, z: 0 };
const AIM = { x: 0, y: 0, z: 0 };
const VELOCITY = { x: 0, y: 0, z: 0 };
