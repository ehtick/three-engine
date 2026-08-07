/**
 * Materials, scene look, prefabs, model import and engine modules.
 *
 * These are the ops that let an assistant author rather than just arrange.
 * Without them, "make the floor matte grey" means hand-writing `.mat` JSON
 * through `asset.write` and hoping the schema is right, and "give it a warm
 * evening look" is not expressible at all.
 *
 * Everything here reuses the editor's own code paths — `MATERIAL_DEFAULTS`,
 * `SetSceneSettingsCommand`, `prefab.js`, `glbImport.js`, `modules.js` — rather
 * than reimplementing their file formats. That is the same rule the rest of the
 * API follows and it matters most here: a material written by a tool must be
 * indistinguishable from one the inspector wrote, or the two will drift and the
 * assistant's output will subtly break in ways the user has to debug.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { commandBus } from "../../commands/CommandBus.js";
import { SetSceneSettingsCommand } from "../../commands/settingsCommands.js";
import { useProjectStore } from "../../store/projectStore.js";
import { invoke } from "../../assetOps.js";
import { refreshAssetFromDisk } from "../../projectWatcher.js";
import { MATERIAL_DEFAULTS } from "../../../engine/materialAsset.js";
import { SCENE_SETTINGS_DEFAULTS, TONE_MAPPINGS } from "../../../engine/sceneSettings.js";

const norm = (p) => String(p ?? "").replaceAll("\\", "/").replace(/\/+$/, "");

/** Same containment rule as the asset ops — see `ops/assets.js` for why. */
function insideProject(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  const target = norm(path);
  const prefix = `${norm(root)}/`;
  if (!target.toLowerCase().startsWith(prefix.toLowerCase()) && target !== norm(root)) {
    throw new Error(`"${path}" is outside the open project (${root}).`);
  }
  return path;
}

/** `<root>/materials/<Name>.mat`, which is where the Assets panel puts them. */
function materialPathFor(name) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  const stem = String(name).replace(/\.mat$/i, "").replace(/[<>:"/\\|?*]/g, "_");
  return `${norm(root)}/materials/${stem}.mat`;
}

// ---- materials --------------------------------------------------------------

defineOp({
  name: "material.create",
  description:
    "Create a .mat asset and return its path, ready to assign to a mesh component's `material` prop. Unspecified fields take the engine's defaults, so a colour alone is a valid material.",
  params: {
    name: { type: "string", required: true, description: "Asset name; '.mat' is added if missing." },
    color: { type: "string", description: "Base colour as hex, e.g. '#c0392b'." },
    roughness: { type: "number", description: "0 = mirror, 1 = fully matte." },
    metalness: { type: "number", description: "0 = dielectric, 1 = metal." },
    map: { type: "string", description: "Absolute path to a base-colour texture." },
    emissive: { type: "string", description: "Emissive colour as hex. Use with emissiveIntensity for light sources." },
    emissiveIntensity: { type: "number" },
    opacity: { type: "number", description: "Below 1 also turns on transparency." },
  },
  async run({ name, ...fields }) {
    const path = materialPathFor(name);
    const dir = path.slice(0, path.lastIndexOf("/"));
    await invoke("create_dir", { path: dir }).catch(() => {});
    const def = { ...MATERIAL_DEFAULTS };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) def[key] = value;
    }
    // Transparency is a derived flag in this engine, not something a caller
    // should have to remember: an opacity below 1 with `transparent` unset
    // renders fully opaque, which reads as "the tool ignored my opacity".
    if (typeof def.opacity === "number" && def.opacity < 1) def.transparent = true;
    await invoke("save_scene", { path, contents: JSON.stringify(def, null, 2) });
    // See material.set: writing the bytes is not the same as the editor — or a
    // live browser preview — seeing them.
    await refreshAssetFromDisk(path);
    await useProjectStore.getState().refresh();
    return { path, definition: def };
  },
});

defineOp({
  name: "material.get",
  readOnly: true,
  description:
    "Read a .mat asset's definition: colour, roughness, metalness, texture map paths and pipeline flags. Read before material.set so you patch rather than replace.",
  params: { path: { type: "string", required: true } },
  async run({ path }) {
    const contents = await invoke("read_text_file", { path: insideProject(path) });
    return { path, definition: { ...MATERIAL_DEFAULTS, ...JSON.parse(contents) } };
  },
});

defineOp({
  name: "material.set",
  description:
    "Patch fields on an existing .mat asset. Only the keys you pass change; everything else is preserved, including any shader graph.",
  params: {
    path: { type: "string", required: true },
    patch: { type: "object", required: true, description: "Fields to merge, e.g. { roughness: 0.2 }." },
  },
  async run({ path, patch }) {
    const target = insideProject(path);
    const current = JSON.parse(await invoke("read_text_file", { path: target }));
    const next = { ...current, ...patch };
    if (typeof next.opacity === "number" && next.opacity < 1) next.transparent = true;
    await invoke("save_scene", { path: target, contents: JSON.stringify(next, null, 2) });
    // Writing a `.mat` past the caches that own it leaves the viewport — and,
    // silently, every live browser preview — rendering the previous version.
    // `save_scene` marks itself a self-write so the filesystem watcher will not
    // notice either, and the browser preview's rebuild loop hangs off exactly
    // this invalidation: without it a material edit made through the API never
    // reaches the served build until some unrelated edit happens to trigger the
    // next export. Measured: the `.mat` shipped one rebuild late, or never.
    await refreshAssetFromDisk(target);
    return { path: target, definition: next };
  },
});

// ---- scene look -------------------------------------------------------------

defineOp({
  name: "scene.getSettings",
  readOnly: true,
  description:
    "The scene's look settings: background, ambient light, environment (cubemap/IBL), fog, tone mapping, shadows and renderer options.",
  params: {},
  run() {
    return {
      settings: structuredClone(engine.settings ?? SCENE_SETTINGS_DEFAULTS),
      toneMappings: Object.keys(TONE_MAPPINGS),
    };
  },
});

defineOp({
  name: "scene.setSettings",
  undoable: true,
  description:
    "Patch the scene's look. Top-level keys are merged, so pass only what you want to change — e.g. { fog: { type: 'exp2', color: '#101018', density: 0.03 }, toneMapping: 'agx' }. This is how you express 'make it feel like dusk'.",
  params: {
    patch: {
      type: "object",
      required: true,
      description:
        "Any of: background, ambientColor, ambientIntensity, environment{cubemap,background,lighting,intensity,rotation,blur}, fog{type,color,near,far,density}, toneMapping, exposure, shadow{...}, renderer{...}. Call scene.getSettings first to see the current shape.",
    },
    label: { type: "string", default: "Change scene settings", description: "Undo-menu label." },
  },
  run({ patch, label = "Change scene settings" }) {
    commandBus.execute(new SetSceneSettingsCommand(patch, label));
    return { settings: structuredClone(engine.settings) };
  },
});

// ---- prefabs ----------------------------------------------------------------

defineOp({
  name: "prefab.list",
  readOnly: true,
  description: "Every prefab asset in the project, with the path prefab.instantiate needs.",
  params: {},
  async run() {
    const { listProjectEntries, withoutSidecars } = await import("../../assetLoader.js");
    const root = useProjectStore.getState().rootPath;
    if (!root) throw new Error("No project is open.");
    const entries = withoutSidecars(await listProjectEntries(root, 8));
    return entries
      .filter((entry) => !entry.is_dir && /\.(prefab|entity)$/i.test(entry.name))
      // Forward slashes for the same reason as `asset.list` — see the note there.
      .map((entry) => ({
        path: entry.path.replaceAll("\\", "/"),
        name: entry.name.replace(/\.(prefab|entity)$/i, ""),
      }));
  },
});

defineOp({
  name: "prefab.instantiate",
  undoable: true,
  description:
    "Drop a prefab into the scene. Prefer this over rebuilding a known object from primitives — an instance stays linked to its prefab, so later edits to the prefab propagate.",
  params: {
    path: { type: "string", required: true, description: "Prefab asset path from prefab.list." },
    position: { type: "array", description: "[x, y, z]; defaults to the origin.", items: { type: "number" } },
    parentId: { type: "string", description: "Parent entity id." },
  },
  async run({ path, position = null, parentId = null }) {
    const { instantiatePrefab } = await import("../../prefab.js");
    const entity = await instantiatePrefab(insideProject(path), position, parentId);
    if (!entity) throw new Error(`Could not instantiate "${path}".`);
    const { describeEntity } = await import("./entities.js");
    return describeEntity(engine.getEntity(entity.id ?? entity));
  },
});

defineOp({
  name: "prefab.createFromEntity",
  description:
    "Save an entity (and its subtree) as a reusable prefab asset, and link the original to it. Use after building something worth repeating.",
  params: {
    id: { type: "string", required: true },
    folder: { type: "string", description: "Target folder; defaults to the project's prefab folder." },
  },
  async run({ id, folder = null }) {
    if (!engine.getEntity(id)) throw new Error(`No entity with id "${id}"`);
    const { createPrefabFromEntity } = await import("../../prefab.js");
    const path = await createPrefabFromEntity(id, folder ? insideProject(folder) : null);
    return { path };
  },
});

// ---- import -----------------------------------------------------------------

defineOp({
  name: "asset.import",
  undoable: true,
  description:
    "Add a model file (.glb/.gltf/.fbx) already in the project to the scene as an entity with a model component.",
  params: {
    path: { type: "string", required: true, description: "Model asset path inside the project." },
    name: { type: "string", description: "Entity name; defaults to the file's stem." },
    position: { type: "array", items: { type: "number" } },
    parentId: { type: "string" },
  },
  async run({ path, name, position, parentId }) {
    const target = insideProject(path);
    if (!/\.(glb|gltf|fbx)$/i.test(target)) {
      throw new Error(`"${path}" is not a model file (.glb, .gltf or .fbx).`);
    }
    const stem = target.split("/").pop().replace(/\.[^.]+$/, "");
    // Reuse entity.create rather than a bespoke path, so the result is exactly
    // what dragging the file into the viewport produces.
    const { callOp } = await import("../registry.js");
    return callOp("entity.create", {
      name: name ?? stem,
      parentId,
      transform: position ? { position } : undefined,
      components: [{ type: "model", props: { src: target } }],
    });
  },
});

// ---- modules ----------------------------------------------------------------

defineOp({
  name: "module.list",
  readOnly: true,
  description:
    "Engine modules available in this project and whether each is enabled. Modules add component types — physics, GI and so on — so check here if a component type you expect is missing.",
  params: {},
  async run() {
    const { listModuleDefinitions, useModulesStore } = await import("../../modules.js");
    const definitions = await listModuleDefinitions();
    const enabled = new Set(useModulesStore.getState().enabled ?? []);
    return definitions.map((def) => ({
      id: def.id,
      label: def.label ?? def.id,
      description: def.description ?? "",
      enabled: enabled.has(def.id),
    }));
  },
});

defineOp({
  name: "module.setEnabled",
  description:
    "Turn an engine module on or off for this project. Enabling registers its component types, so do this before adding e.g. a rigidbody.",
  params: {
    id: { type: "string", required: true },
    enabled: { type: "boolean", required: true },
  },
  async run({ id, enabled }) {
    const { setModuleEnabled, useModulesStore } = await import("../../modules.js");
    await setModuleEnabled(id, enabled);
    return { id, enabled, active: useModulesStore.getState().enabled ?? [] };
  },
});
