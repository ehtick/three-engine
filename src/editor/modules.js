import { create } from "zustand";
import { useProjectStore } from "./store/projectStore.js";
import { ensureEngine } from "./engineInstance.js";

/**
 * Editor-side module management. The enabled set lives in project.json
 * (`modules: [ids]`); this store mirrors it for React. Enabling/disabling
 * applies to the live engine immediately — new components appear in the
 * Add Component menu, disabled ones degrade to inert "missing" data that
 * still round-trips through save.
 */
export const useModulesStore = create(() => ({ enabled: [] }));

async function engineModulesApi() {
  // The catalog import registers all built-in definitions; kept dynamic so
  // the module system stays out of the editor boot path until needed.
  const [api] = await Promise.all([import("../engine/modules.js"), import("../modules/index.js")]);
  return api;
}

/** All registered module definitions, for the Modules panel. */
export async function listModuleDefinitions() {
  return (await engineModulesApi()).getModuleDefinitions();
}

/**
 * Loads the module catalog (registers every built-in module definition with
 * the engine) without applying any to the engine. Idempotent — returns the
 * already-loaded catalog if it was loaded once. Panels that need to know
 * whether the postprocessing module is registered call this from their
 * mount effect so they can resolve the component class on demand.
 */
export async function ensureModules() {
  const api = await engineModulesApi();
  return api;
}

/**
 * A module's project-level default settings: its declared `settings` schema
 * defaults, with project.json's `moduleSettings[id]` overrides merged on top.
 * Returns {} for modules that declare no settings.
 */
export async function getModuleSettings(id) {
  const api = await engineModulesApi();
  const def = api.getModuleDefinition(id);
  const defaults = {};
  for (const field of def?.settings ?? []) defaults[field.key] = field.default;
  const saved = useProjectStore.getState().projectMeta?.moduleSettings?.[id] ?? {};
  return { ...defaults, ...saved };
}

/**
 * Persists a settings patch for a module into project.json and pushes the
 * merged result onto the module's runtime via its optional applySettings().
 * Returns the full merged settings object.
 */
export async function saveModuleSettings(id, patch) {
  const api = await engineModulesApi();
  const def = api.getModuleDefinition(id);
  const next = { ...(await getModuleSettings(id)), ...patch };
  const all = { ...(useProjectStore.getState().projectMeta?.moduleSettings ?? {}), [id]: next };
  await useProjectStore
    .getState()
    .updateMeta({ moduleSettings: all })
    .catch((err) => console.warn(`Couldn't persist module settings to project.json: ${err}`));
  def?.applySettings?.(next);
  return next;
}

/** Pushes every enabled module's stored settings onto the runtime. */
async function applyEnabledModuleSettings(api, ids) {
  for (const id of ids) {
    const def = api.getModuleDefinition(id);
    if (def?.applySettings) def.applySettings(await getModuleSettings(id));
  }
}

/** Applies project.json's enabled modules to the engine (call at boot, before scene load). */
export async function syncProjectModules() {
  const enabled = useProjectStore.getState().projectMeta?.modules ?? [];
  const api = await engineModulesApi();
  const engine = await ensureEngine();
  await api.applyEngineModules(engine, enabled);
  const live = [...engine.modules.keys()];
  useModulesStore.setState({ enabled: live });
  await applyEnabledModuleSettings(api, live);
}

/** Toggles a module: persists to project.json and applies to the live engine. */
export async function setModuleEnabled(id, on) {
  const api = await engineModulesApi();
  const engine = await ensureEngine();
  if (on) await api.enableEngineModule(engine, id);
  else await api.disableEngineModule(engine, id);
  const enabled = [...engine.modules.keys()];
  useModulesStore.setState({ enabled });
  // Newly enabled module: push its stored/default settings onto the runtime.
  if (on) {
    const def = api.getModuleDefinition(id);
    if (def?.applySettings) def.applySettings(await getModuleSettings(id));
  }
  await useProjectStore
    .getState()
    .updateMeta({ modules: enabled })
    .catch((err) => console.warn(`Couldn't persist modules to project.json: ${err}`));
  if (id === "basis" && on) {
    const { compressAllProjectTextures } = await import("./basisCompress.js");
    const result = await compressAllProjectTextures();
    console.log(
      `Basis: compressed ${result.compressed} texture${result.compressed === 1 ? "" : "s"}` +
        (result.failed ? `, ${result.failed} failed` : ""),
    );
    await useProjectStore.getState().refresh();
  }
  if (id === "basis") {
    const { refreshAllMaterials } = await import("../engine/materialAsset.js");
    refreshAllMaterials();
  }
}
