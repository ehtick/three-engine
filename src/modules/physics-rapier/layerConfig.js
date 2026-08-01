import { DEFAULT_PHYSICS_LAYERS } from "./layers.js";

/**
 * The project's layer names, readable synchronously from a component schema.
 *
 * Component schemas are static class fields evaluated at import time, but the
 * layer names come from project settings that load later — so the Layer
 * dropdown has to read them lazily. `physicsLayerNames` is a function, which
 * the Inspector calls at render time (see PropField's `select` case).
 *
 * The editor and the player both call `setPhysicsLayerConfig` when their
 * config arrives; until then the defaults apply, which is also exactly what a
 * project that never opens the Physics settings gets.
 */
let current = { names: [...DEFAULT_PHYSICS_LAYERS], matrix: null };

export function setPhysicsLayerConfig(config) {
  const names = Array.isArray(config?.names) && config.names.length ? config.names : DEFAULT_PHYSICS_LAYERS;
  current = { names: [...names], matrix: config?.matrix ?? null };
}

export function getPhysicsLayerConfig() {
  return current;
}

/** Schema `options` provider — called on every Inspector render. */
export function physicsLayerNames() {
  return current.names;
}
