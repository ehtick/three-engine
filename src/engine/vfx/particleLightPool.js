import * as THREE from "three/webgpu";

/**
 * ⭐ ONE SCENE-WIDE BUDGET OF PARTICLE POINT LIGHTS, WITH A FIXED LIGHT COUNT.
 *
 * A particle system used to create up to 8 real `PointLight`s per subsystem.
 * Every light is in three's lights hash (`LightsNode.customCacheKey`: each
 * light's id + castShadow), so every system built or destroyed re-minted every
 * lit material in the scene, and every light added per-fragment cost to every
 * lit surface whether or not it was near the fire.
 *
 * Now each subsystem keeps up to 8 VIRTUAL clusters (its k-means state) and
 * this pool owns the only real lights:
 *
 *   - `budget` lights (default 4) are created ONCE, on the first system that
 *     asks — a scene with no light-emitting effect still has zero;
 *   - every frame the brightest clusters scene-wide (intensity, attenuated by
 *     camera distance) are mapped onto them, keeping each light on the cluster
 *     it already had where possible; an unused light fades to intensity 0;
 *   - ⛔ lights are NEVER added, removed or hidden while any system uses them:
 *     `visible = false` drops a light from the render list (Renderer.
 *     _projectObject returns before `pushLight`), which moves the hash exactly
 *     like removing it. Intensity, colour, distance and position are uniforms.
 *   - after the last system leaves the lights are released after a short delay,
 *     so a structural graph edit (dispose → rebuild) does not pay two waves.
 *
 * `castShadow` stays false. `globalThis.__particleLightBudget` overrides the
 * budget for an A/B (read when the pool is created).
 */
export const PARTICLE_LIGHT_BUDGET = 4;
const RELEASE_DELAY_MS = 3000;
/** Per-frame decay of a light that lost its cluster. */
const FADE = 0.8;
const OFF = 1e-3;

const _cameraWorld = new THREE.Vector3();

/**
 * Picks which cluster each light slot shows: the top `budget` by score
 * (score > 0 only), with every cluster that already held a slot and is still
 * chosen keeping THAT slot, so lights do not hop between fires as ranks shuffle.
 * @template T
 * @param {{ key: T, score: number }[]} candidates
 * @param {number} budget
 * @param {(T | null)[] | null} [previous]
 * @returns {(T | null)[]}
 */
export function selectLightSlots(candidates, budget, previous = null) {
  const ranked = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, budget);
  const chosen = new Set(ranked.map((c) => c.key));
  /** @type {(T | null)[]} */
  const slots = new Array(budget).fill(null);
  const placed = new Set();
  for (let i = 0; i < budget; i++) {
    const key = previous?.[i];
    if (key != null && chosen.has(key) && !placed.has(key)) {
      slots[i] = key;
      placed.add(key);
    }
  }
  let r = 0;
  for (let i = 0; i < budget; i++) {
    if (slots[i] !== null) continue;
    while (r < ranked.length && placed.has(ranked[r].key)) r++;
    if (r >= ranked.length) break;
    slots[i] = ranked[r].key;
    placed.add(ranked[r].key);
    r++;
  }
  return slots;
}

/**
 * @typedef {{
 *   position: THREE.Vector3, color: THREE.Color, intensity: number, distance: number,
 *   world: THREE.Vector3,
 * }} ParticleLightCluster  position is in `rig.object`'s local space
 * @typedef {{ clusters: ParticleLightCluster[], object: THREE.Object3D | null, active: boolean }} ParticleLightRig
 */

export class ParticleLightPool {
  /** @param {any} engine @param {{ budget?: number }} [options] */
  constructor(engine, { budget = PARTICLE_LIGHT_BUDGET } = {}) {
    this.engine = engine;
    this.budget = Math.max(0, Math.floor(Number(budget) || 0));
    /** @type {THREE.PointLight[]} */
    this.lights = [];
    /** @type {Set<ParticleLightRig>} */
    this.rigs = new Set();
    /** @type {(ParticleLightCluster | null)[]} */
    this.slots = [];
    /** @type {{ key: ParticleLightCluster, score: number }[]} */
    this._candidates = [];
    this._releaseTimer = null;
    this._unsubUpdate = null;
  }

  /** Registers a rig; returns its release function (idempotent). */
  acquire(/** @type {ParticleLightRig} */ rig) {
    if (!this.budget) return () => {};
    if (this._releaseTimer !== null) {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = null;
    }
    this.rigs.add(rig);
    this.#allocate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.rigs.delete(rig);
      if (!this.rigs.size) this.#scheduleRelease();
    };
  }

  #allocate() {
    if (this.lights.length) return;
    const scene = this.engine?.scene;
    if (!scene) return;
    for (let i = 0; i < this.budget; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 6, 2);
      light.name = "Particle Light";
      light.castShadow = false;
      light.userData.engineOwned = true;
      light.userData.particleLight = true;
      light.raycast = () => {};
      scene.add(light);
      this.lights.push(light);
    }
    this.slots = new Array(this.budget).fill(null);
    this._unsubUpdate = this.engine.onUpdate?.(() => this.commit()) ?? null;
  }

  /** Maps this frame's brightest clusters onto the fixed lights. */
  commit() {
    if (!this.lights.length) return;
    const camera = this.engine?.camera;
    if (camera) camera.getWorldPosition(_cameraWorld); else _cameraWorld.set(0, 0, 0);
    const candidates = this._candidates;
    candidates.length = 0;
    for (const rig of this.rigs) {
      if (!rig.active || !rig.object) continue;
      rig.object.updateWorldMatrix(true, false);
      for (const cluster of rig.clusters) {
        if (!(cluster.intensity > OFF)) continue;
        cluster.world.copy(cluster.position).applyMatrix4(rig.object.matrixWorld);
        // A light's reach is its `distance`; past it a fire contributes little.
        const range = Math.max(0.5, cluster.distance || 6);
        const d2 = cluster.world.distanceToSquared(_cameraWorld);
        candidates.push({ key: cluster, score: cluster.intensity * (range * range) / (range * range + d2) });
      }
    }
    this.slots = selectLightSlots(candidates, this.budget, this.slots);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const cluster = this.slots[i];
      if (cluster) {
        light.position.copy(cluster.world);
        light.color.copy(cluster.color);
        light.distance = cluster.distance;
        light.intensity = cluster.intensity;
      } else if (light.intensity !== 0) {
        light.intensity = light.intensity * FADE > OFF ? light.intensity * FADE : 0;
      }
    }
  }

  #scheduleRelease() {
    if (this._releaseTimer !== null) return;
    this._releaseTimer = setTimeout(() => {
      this._releaseTimer = null;
      this.release();
    }, RELEASE_DELAY_MS);
    this._releaseTimer?.unref?.();
  }

  /** Removes the lights once no rig uses them (one lights-hash change). */
  release() {
    if (this.rigs.size) return;
    this._unsubUpdate?.();
    this._unsubUpdate = null;
    for (const light of this.lights) {
      light.removeFromParent();
      light.dispose();
    }
    this.lights = [];
    this.slots = [];
  }
}

/** The engine's shared pool, created on first use. */
export function particleLightPool(engine) {
  if (!engine.particleLightPool) {
    const pinned = Number(globalThis.__particleLightBudget);
    engine.particleLightPool = new ParticleLightPool(engine, {
      budget: Number.isFinite(pinned) && globalThis.__particleLightBudget !== undefined ? pinned : PARTICLE_LIGHT_BUDGET,
    });
  }
  return engine.particleLightPool;
}
