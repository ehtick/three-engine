import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";
import { invalidateBlobUrl } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { assetFromMesh, meshFromBufferGeometry } from "./mesh/io.js";
import { getVirtualGeometryRecord } from "../modules/virtual-geometry/index.js";

const safeStem = (value) => (value || "Geometry").replace(/[^a-z0-9 _-]/gi, "").trim() || "Geometry";

/**
 * The geometry an entity's mesh was AUTHORED with — which is not always the one
 * it is currently rendering.
 *
 * Two things swap a derived geometry onto a live mesh, and editing either one
 * edits the derivation instead of the model:
 *
 *   Virtual geometry replaces the index buffer with the current LOD cut
 *     through the cluster DAG — a per-frame subset of the clusters, sized to
 *     screen-space error. Opening THAT in Edit Mode hands you a few thousand
 *     of the mesh's tens of thousands of triangles, in whatever cut the camera
 *     happened to be asking for, with the rest of the index buffer still zero.
 *     It reads as the model arriving mangled the moment you press Tab.
 *
 *   Geometry modifiers replace it with the evaluated modifier stack, which is
 *     an output, not a source; editing it and saving would bake the modifiers
 *     in and then evaluate them a second time on top.
 *
 * Unwrapped outermost first: a modifier stack is evaluated before virtual
 * geometry clusters the result, so the modifier's own source is the furthest
 * upstream and wins. `getVirtualGeometryRecord` returns null when the module is
 * disabled or the mesh was never virtualized, which is the common case.
 */
export function authoredGeometry(entity) {
  const mesh = entity?.getComponent?.("mesh")?.mesh;
  if (!mesh) return null;
  const modifierSource = entity.getComponent?.("geometryModifiers")?.getSourceGeometry?.();
  // `getSourceGeometry` falls back to the live geometry when it has not
  // captured a source yet; that fallback is the derived one and must not win.
  if (modifierSource && modifierSource !== mesh.geometry) return modifierSource;
  return getVirtualGeometryRecord(mesh)?.original ?? mesh.geometry;
}

export async function uniqueGeometryPath(root, stem) {
  const { invoke } = await import("@tauri-apps/api/core");
  for (let suffix = 0; ; suffix++) {
    const path = `${root}/geometries/${stem}${suffix ? ` ${suffix}` : ""}.geom`;
    try { await invoke("stat_file", { path }); } catch { return path; }
  }
}

/**
 * Blender-style make-single-user step for primitive meshes. Asset-backed
 * meshes keep their existing path and are edited in place.
 */
export async function ensureGeometryAsset(entityId) {
  const entity = engine.getEntity(entityId);
  const component = entity?.getComponent("mesh");
  if (!component?.mesh) return null;
  if (component.props.geometryAsset) return component.props.geometryAsset;
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before editing geometry");
  const path = await uniqueGeometryPath(root, safeStem(entity.name));
  const asset = assetFromMesh(meshFromBufferGeometry(authoredGeometry(entity)));
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", { path, contents: JSON.stringify(asset, null, 2) });
  invalidateBlobUrl(path);
  commandBus.execute(new SetComponentPropCommand(entityId, "mesh", "geometryAsset", path));
  await useProjectStore.getState().refresh();
  return path;
}

/** Saves a new editable geometry asset without attaching it to an entity. */
export async function saveNewGeometryAsset(stem, mesh) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before creating geometry");
  const path = await uniqueGeometryPath(root, safeStem(stem));
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", {
    path,
    contents: JSON.stringify(assetFromMesh(mesh), null, 2),
  });
  invalidateBlobUrl(path);
  await useProjectStore.getState().refresh();
  return path;
}
