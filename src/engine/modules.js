// @ts-check
import { registerComponent, unregisterComponent } from "./components/registry.js";

/**
 * Unity-style engine modules: optional feature packs (physics, audio, …)
 * that a project enables per project.json. A module definition is:
 *   {
 *     id          — unique string ("physics-rapier")
 *     name        — display name for the editor
 *     description — one-liner for the Modules panel
 *     version     — display version string
 *     category    — group label for the Modules panel list ("Physics",
 *                   "Rendering", "Optimization", "Editor", "World").
 *                   Editor-only metadata; the runtime doesn't read it.
 *                   Defaults to "Other" when omitted.
 *     tags        — short string array used by the Modules panel search
 *                   (e.g. ["wasm", "3d"]). Free-form; editor-only.
 *     components  — component classes registered while the module is enabled
 *     setup(engine) — async; per-engine runtime setup (create systems,
 *                     subscribe to engine events). Returns a handle whose
 *                     optional dispose() undoes everything.
 *   }
 *
 * Definitions are registered at import time (see src/modules/index.js);
 * enabling is per-engine and driven by the host (editor project settings or
 * the exported scene.json's `modules` list). Heavy dependencies (wasm…)
 * belong inside setup() as dynamic imports so disabled modules cost nothing.
 */
// NOT a bare module-level Map. Vite can serve this file under BOTH the
// `/src/…` and `/@fs/C:/…` URL forms (plus `?t=` HMR twins) — each importer
// then gets its OWN module instance, and a per-instance registry means
// modules registered through one URL are "Unknown module" through the other
// (bit a puppeteer harness whose absolute `/src/…` imports sat beside the
// editor graph's `/@fs/…` form). globalThis-keyed, same as the editor's
// vmSingleton pattern (which engine code must not import).
const definitions = (globalThis.__engineModuleDefinitions ??= new Map());

export function registerModuleDefinition(def) {
  if (!def?.id) throw new Error("Module definition needs an `id`");
  definitions.set(def.id, def);
}

export function getModuleDefinition(id) {
  return definitions.get(id);
}

export function getModuleDefinitions() {
  // Surface `category` / `tags` with safe defaults so the Modules panel
  // doesn't have to defensive-check every definition (third-party modules
  // registered before these fields were introduced still work).
  return [...definitions.values()].map((d) => ({
    ...d,
    category: d.category ?? "Other",
    tags: d.tags ?? [],
  }));
}

/** Registers the module's components and runs its setup on this engine. */
export async function enableEngineModule(engine, id) {
  if (engine.modules.has(id)) return engine.modules.get(id);
  const def = definitions.get(id);
  if (!def) throw new Error(`Unknown module "${id}"`);
  for (const cls of def.components ?? []) registerComponent(cls);
  const handle = (await def.setup?.(engine)) ?? {};
  engine.modules.set(id, handle);
  engine.emit("modules-changed");
  return handle;
}

/** Tears down the module's runtime and unregisters its components. */
export async function disableEngineModule(engine, id) {
  const handle = engine.modules.get(id);
  if (!handle) return;
  engine.modules.delete(id);
  await handle.dispose?.();
  const def = definitions.get(id);
  for (const cls of def?.components ?? []) unregisterComponent(cls.type);
  engine.emit("modules-changed");
}

/** Makes the engine's enabled set exactly `ids` (order-preserving enable). */
export async function applyEngineModules(engine, ids = []) {
  const want = new Set(ids.filter((id) => definitions.has(id)));
  for (const id of [...engine.modules.keys()]) {
    if (!want.has(id)) await disableEngineModule(engine, id);
  }
  for (const id of ids) {
    if (want.has(id)) await enableEngineModule(engine, id);
  }
}
