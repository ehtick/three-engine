import { create } from "zustand";
import { vmSingleton } from "./singleton.js";
import { useProjectStore } from "./store/projectStore.js";
import { ensureEngine } from "./engineInstance.js";

/**
 * Editor-side module management. Explicit choices live in project.json
 * (`modules: [ids]`); the store's enabled set includes required providers.
 * Enabling/disabling applies to the live engine immediately — new components appear in the
 * Add Component menu, disabled ones degrade to inert "missing" data that
 * still round-trips through save.
 */
export const useModulesStore = vmSingleton("modulesStore", () => create(() => ({ enabled: [], explicit: [], requiredBy: {} })));
const moduleChanges = vmSingleton("moduleChanges", () => ({ tail: Promise.resolve() }));

// Include settings and persistence in the operation order: a slow settings
// import must not persist an old explicit set after a newer user toggle.
function queueModuleChange(operation) {
  const result = moduleChanges.tail.then(operation);
  moduleChanges.tail = result.catch(() => {});
  return result;
}

function mirrorModules(api, engine) {
  const enabled = [...engine.modules.keys()];
  const explicit = api.getExplicitEngineModules(engine);
  const requiredBy = Object.fromEntries(enabled.map(id => [id, api.getEngineModuleDependents(engine, id)]));
  useModulesStore.setState({ enabled, explicit, requiredBy });
  return { enabled, explicit };
}

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
export function syncProjectModules() {
  return queueModuleChange(async () => {
    const enabled = useProjectStore.getState().projectMeta?.modules ?? [];
    const api = await engineModulesApi();
    const engine = await ensureEngine();
    await api.applyEngineModules(engine, enabled);
    const { enabled: live } = mirrorModules(api, engine);
    await applyEnabledModuleSettings(api, live);
  });
}

/** Toggles a module: persists to project.json and applies to the live engine. */
export function setModuleEnabled(id, on) {
  return queueModuleChange(async () => {
    const api = await engineModulesApi();
    const engine = await ensureEngine();
    id = api.resolveModuleId(id);
    const previous = new Set(engine.modules.keys());
    if (on) await api.enableEngineModule(engine, id);
    else await api.disableEngineModule(engine, id);
    const { enabled, explicit } = mirrorModules(api, engine);
    // Required providers need their stored/default settings too.
    if (on) await applyEnabledModuleSettings(api, enabled.filter(moduleId => moduleId === id || !previous.has(moduleId)));
    await useProjectStore
      .getState()
      .updateMeta({ modules: explicit })
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
  });
}
