import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";
import { BatchCommand } from "./commands/entityCommands.js";
import { writeBinaryFile, invalidateBlobUrl } from "./assetLoader.js";
import { uniqueGeometryPath } from "./geometryEditing.js";
import { useProjectStore } from "./store/projectStore.js";
import { encodeGeometryAsset, geometryAssetFromBufferGeometry, invalidateGeometryAsset } from "../engine/geometryAsset.js";
import { invalidateVirtualGeometryAsset } from "../modules/virtual-geometry/index.js";
import { GEOMETRY_MODIFIER_DEFINITIONS } from "../engine/geometryModifiers.js";

const safeStem = (value) => (value || "Geometry").replace(/[^a-z0-9 _-]/gi, "").trim() || "Geometry";

/**
 * Bakes one modifier into a new single-user `.geom`, then removes only that
 * entry from the non-destructive stack. The new asset makes Apply persistent;
 * undo simply restores the previous asset path and modifier array.
 */
export async function applyGeometryModifier(entityId, modifierId, { sourceGeometry = null } = {}) {
  const entity = engine.getEntity(entityId);
  const component = entity?.getComponent("geometryModifiers");
  const mesh = entity?.getComponent("mesh");
  const modifiers = component?.props.modifiers ?? [];
  const modifierIndex = modifiers.findIndex((entry) => entry.id === modifierId);
  const modifier = modifiers[modifierIndex];
  if (!component || !mesh || !modifier) return { ok: false, message: "Modifier is unavailable" };
  const root = useProjectStore.getState().rootPath;
  if (!root) return { ok: false, message: "Open a project before applying a modifier" };

  let baked;
  try {
    baked = component.evaluateThroughModifier(modifier, sourceGeometry ?? undefined);
    if (!baked?.getAttribute("position")) throw new Error("Modifier produced no geometry");
    const definition = GEOMETRY_MODIFIER_DEFINITIONS.find((entry) => entry.type === modifier.type);
    const path = await uniqueGeometryPath(root, safeStem(`${entity.name} ${definition?.label ?? "Modified"}`));
    await writeBinaryFile(path, encodeGeometryAsset(geometryAssetFromBufferGeometry(baked)));
    invalidateBlobUrl(path);
    invalidateGeometryAsset(path);
    invalidateVirtualGeometryAsset(path);

    // Everything through the selected entry is now represented by the baked
    // asset. Keeping an earlier modifier would evaluate it twice after reload.
    const next = modifiers.slice(modifierIndex + 1);
    commandBus.execute(new BatchCommand([
      new SetComponentPropCommand(entityId, "mesh", "geometryAsset", path),
      new SetComponentPropCommand(entityId, "geometryModifiers", "modifiers", next),
    ], `Apply ${definition?.label ?? "modifier"}`));
    await useProjectStore.getState().refresh();
    return { ok: true, message: `Applied ${definition?.label ?? "modifier"}`, path };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  } finally {
    baked?.dispose?.();
  }
}
