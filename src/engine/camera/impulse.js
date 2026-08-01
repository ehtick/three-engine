import * as THREE from "three/webgpu";

/**
 * Camera impulses — the shake a hit, an explosion or a landing sends to
 * whatever camera is watching.
 *
 * Two properties matter more than the waveform:
 *
 * 1. **Impulses are events, not state.** A script fires one and forgets it; the
 *    system owns its lifetime. The alternative (a `shake` amount the caller
 *    turns up and back down) breaks the moment two things shake at once, which
 *    on any action game is most of the time.
 *
 * 2. **They are located in the world.** An explosion across the map should not
 *    shake the camera as hard as one at the player's feet, and a system with no
 *    position can't tell the difference. Pass `position` and a `radius` and the
 *    falloff is handled; omit them for a global shake (a cutscene rumble).
 *
 * The signal is deterministic — no `Math.random()` — so a replay, a test, or
 * two clients running the same seed shake identically, and a failing shake test
 * fails the same way twice.
 */

/** Smooth pseudo-noise in roughly [-1, 1]. Three octaves is enough to stop it
 *  reading as a clean sine wave without costing a texture lookup. */
function noise(t, seed) {
  return (
    Math.sin(t * 1.0 + seed * 1.37) * 0.6 +
    Math.sin(t * 2.37 + seed * 2.71) * 0.3 +
    Math.sin(t * 4.11 + seed * 5.13) * 0.1
  );
}

/**
 * Amplitude envelope over an impulse's life: a fast attack so a hit lands on
 * the frame it happened, then a squared decay so it fades out rather than
 * stopping dead.
 */
function envelope(progress, attack) {
  if (progress <= 0 || progress >= 1) return 0;
  if (attack > 0 && progress < attack) return progress / attack;
  const remaining = (1 - progress) / (1 - Math.max(attack, 0));
  return remaining * remaining;
}

export class ImpulseSystem {
  constructor() {
    /** @type {Array<object>} live impulses, oldest first */
    this.active = [];
    this.time = 0;
    // Per system, NOT a module-level counter: with a shared counter the same
    // sequence of impulses shakes differently depending on what else happened
    // to be running first, which quietly costs the determinism this whole
    // signal was designed to have. Reset by `clear()`, so each Play produces
    // the same shakes as the last.
    this._nextSeed = 1;
    // Impulses whose combined displacement exceeds this are clamped. Without
    // it, three explosions in one frame can throw the camera through a wall.
    this.maxDisplacement = 2;
    this.maxRotation = 0.5; // radians
  }

  /**
   * Fires an impulse.
   *
   * @param position    world position, or null/omitted for a global shake
   * @param magnitude   peak displacement in metres
   * @param duration    seconds
   * @param frequency   oscillations per second
   * @param radius      full-strength inside this, silent beyond it (0 = global)
   * @param direction   bias the shake along an axis (a hit from the left);
   *                    omit for an omnidirectional rattle
   * @param rotation    peak rotational shake, in radians, as a fraction scale
   * @param attack      fraction of the duration spent ramping up (0 = instant)
   */
  emit({
    position = null,
    magnitude = 0.2,
    duration = 0.4,
    frequency = 18,
    radius = 0,
    direction = null,
    rotation = 0.35,
    attack = 0,
  } = {}) {
    if (!(magnitude > 0) || !(duration > 0)) return null;
    const impulse = {
      position: position ? toVector(position) : null,
      magnitude,
      duration,
      elapsed: 0,
      frequency,
      radius,
      direction: direction ? toVector(direction).normalize() : null,
      rotation,
      attack: THREE.MathUtils.clamp(attack, 0, 0.9),
      seed: this._nextSeed++,
    };
    this.active.push(impulse);
    return impulse;
  }

  /** Advances every live impulse and retires the finished ones. */
  update(dt) {
    if (!this.active.length) return;
    this.time += dt;
    let write = 0;
    for (let i = 0; i < this.active.length; i++) {
      const impulse = this.active[i];
      impulse.elapsed += dt;
      if (impulse.elapsed < impulse.duration) this.active[write++] = impulse;
    }
    this.active.length = write;
  }

  /** Drops every live impulse — used when leaving Play mode. */
  clear() {
    this.active.length = 0;
    this.time = 0;
    this._nextSeed = 1;
  }

  get count() {
    return this.active.length;
  }

  /**
   * Total displacement and rotation to apply at `worldPos` right now.
   *
   * @param outPosition  written with the positional offset (camera-relative is
   *                     the caller's job — this is an axis-aligned offset)
   * @param outEuler     written with pitch/yaw/roll in radians
   */
  sample(worldPos, outPosition, outEuler) {
    outPosition.set(0, 0, 0);
    outEuler.set(0, 0, 0);
    if (!this.active.length) return outPosition;

    for (const impulse of this.active) {
      const attenuation = this.#attenuation(impulse, worldPos);
      if (attenuation <= 0) continue;
      const env = envelope(impulse.elapsed / impulse.duration, impulse.attack);
      if (env <= 0) continue;
      const amplitude = impulse.magnitude * env * attenuation;
      const t = impulse.elapsed * impulse.frequency;
      const seed = impulse.seed;
      if (impulse.direction) {
        // A directional impulse is a kick along one axis that rings out, not a
        // rattle — the difference between "shot from the left" and "an
        // earthquake happened to start when you were shot".
        outPosition.addScaledVector(impulse.direction, amplitude * noise(t, seed));
      } else {
        outPosition.x += amplitude * noise(t, seed);
        outPosition.y += amplitude * noise(t, seed + 11.7);
        outPosition.z += amplitude * noise(t, seed + 23.3);
      }
      if (impulse.rotation > 0) {
        const spin = amplitude * impulse.rotation;
        outEuler.x += spin * noise(t * 0.83, seed + 31.1);
        outEuler.y += spin * noise(t * 0.91, seed + 43.9);
        outEuler.z += spin * noise(t * 1.13, seed + 57.7);
      }
    }

    if (outPosition.lengthSq() > this.maxDisplacement * this.maxDisplacement) {
      outPosition.setLength(this.maxDisplacement);
    }
    outEuler.x = THREE.MathUtils.clamp(outEuler.x, -this.maxRotation, this.maxRotation);
    outEuler.y = THREE.MathUtils.clamp(outEuler.y, -this.maxRotation, this.maxRotation);
    outEuler.z = THREE.MathUtils.clamp(outEuler.z, -this.maxRotation, this.maxRotation);
    return outPosition;
  }

  /**
   * Distance falloff, squared so it drops off the way loudness does rather
   * than linearly — a linear falloff keeps a distant explosion perceptible
   * far longer than it should be.
   */
  #attenuation(impulse, worldPos) {
    if (!impulse.position || !(impulse.radius > 0) || !worldPos) return 1;
    const distance = impulse.position.distanceTo(worldPos);
    if (distance >= impulse.radius) return 0;
    const falloff = 1 - distance / impulse.radius;
    return falloff * falloff;
  }
}

function toVector(value) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  return new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}
