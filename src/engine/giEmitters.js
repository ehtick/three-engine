/**
 * Engine-level registry of DYNAMIC GI emitters.
 *
 * The GI module promotes emissive *meshes* to analytic sphere area lights by
 * scanning the scene (`GISystem.#collectEmitters`), which works because a mesh
 * has a stable identity, a bounding sphere and a matrixWorld. Particles have
 * none of that: they are positions in a GPU storage buffer with no CPU-side
 * object per particle, and they move every frame.
 *
 * So instead of a mesh, a system registers a *provider*: a function the GI
 * system calls once per frame to read back the current emitter shape. That is
 * enough to occupy an emitter slot, and emitter slots are plain per-frame
 * uniforms — they feed the voxel bounce inject, the receiver's direct term with
 * its emissive shadows, and the mirror glow, with no bake involved. A dynamic
 * emitter therefore costs the same as a moving emissive mesh: nothing.
 *
 * Deliberately NOT a dependency of the GI module: this lives in the core engine
 * so `ParticleComponent` can register whether or not GI is installed, and the
 * GI system reads the registry only if it exists. With GI absent the registry
 * is an inert Set.
 *
 * A provider returns `null` when it has nothing to contribute this frame (no
 * live particles yet, readback still in flight), or:
 *   { center: THREE.Vector3, radius: number, r, g, b }   // linear colour × intensity
 */

/** Registers `provider` and returns an unregister function. */
export function registerGiEmitter(engine, provider) {
  const set = (engine.giEmitters ??= new Set());
  set.add(provider);
  // Emitter promotion is decided when the GI system collects the scene, so a
  // newly registered provider must trigger a re-collect to claim a slot.
  engine.giEmittersRevision = (engine.giEmittersRevision ?? 0) + 1;
  return () => {
    set.delete(provider);
    engine.giEmittersRevision = (engine.giEmittersRevision ?? 0) + 1;
  };
}

/** Snapshot of the live providers' current emitter shapes, strongest first.
 *  Emitter slots are scarce (MAX_EMITTERS), so the brightest win. */
export function collectGiEmitters(engine) {
  const set = engine.giEmitters;
  if (!set?.size) return [];
  const out = [];
  for (const provider of set) {
    let value = null;
    try {
      value = provider();
    } catch {
      value = null; // a broken provider must never take the frame down
    }
    if (value && value.radius > 0) out.push(value);
  }
  out.sort((a, b) => b.r + b.g + b.b - (a.r + a.g + a.b));
  return out;
}
