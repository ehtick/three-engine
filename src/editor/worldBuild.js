import { Vector3 } from "three/webgpu";
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { CreateEntityCommand } from "./commands/entityCommands.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { getViewportHandle } from "./viewportHandle.js";
import {
  createWorldDocument, normalizeWorldDocument, patchWorldSettings,
  setWorldFeatureOverride, resetWorldFeatureOverride,
} from "../engine/world/worldDocument.js";

function requireWorld(entityId) {
  const entity = engine.getEntity(entityId);
  const component = entity?.getComponent("world");
  if (!component) throw new Error("Choose a World entity.");
  // Native transform edits can be awaiting their scheduled capture. Flush them
  // before deriving the next document and the command's previous-value snapshot.
  component.captureAuthoredChanges?.();
  return { entity, component, document: normalizeWorldDocument(component.props.document) };
}

function commitWorldDocument(entityId, document, label) {
  const next = normalizeWorldDocument(document);
  const current = requireWorld(entityId).document;
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    commandBus.execute(new SetComponentPropCommand(entityId, "world", "document", next, label));
  }
  return { entityId, document: next };
}

/** All generated products are owned by the World component. The command keeps
 * the authoring document and the root identity through the ordinary scene path. */
export async function createWorld(settings = {}, options = {}) {
  const document = settings.version === 1 ? normalizeWorldDocument(settings) : createWorldDocument(settings);
  const position = options.position ?? [0, 0, 0];
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) throw new Error("World position must contain three finite numbers.");
  const transform = { position: [...position], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const { setModuleEnabled } = await import("./modules.js");
  await setModuleEnabled("world", true);
  if (options.parentId && !engine.getEntity(options.parentId)) throw new Error("The World parent was removed.");
  const command = new CreateEntityCommand({
    name: options.name ?? "Temperate valley",
    ...(options.parentId ? { parentId: options.parentId } : {}),
    transform,
    components: [{ type: "world", props: { document } }],
  });
  commandBus.execute(command);
  useSelectionStore.getState().select(command.entityId);
  if (options.focus !== false) focusWorld(command.entityId);
  return { entityId: command.entityId, document };
}

export function updateWorldSettings(entityId, patch, label = "Edit World settings") {
  return commitWorldDocument(entityId, patchWorldSettings(requireWorld(entityId).document, patch), label);
}

export function patchWorldDocument(entityId, patch, label = "Edit World") {
  return commitWorldDocument(entityId, { ...requireWorld(entityId).document, ...structuredClone(patch) }, label);
}

/** Advance the seed: an authored, undoable change that reshapes the world while
 * keeping every explicit feature edit in the same document. */
export function newWorldSeed(entityId) {
  const current = requireWorld(entityId).document;
  return commitWorldDocument(entityId, patchWorldSettings(current, { seed: ((current.settings.seed ?? 894) + 1) >>> 0 }), "New World seed");
}

/** Retained for automation and older callers: apply settings, or advance the
 * seed when the given settings change nothing. */
export function regenerateWorld(entityId, settings) {
  const current = requireWorld(entityId).document;
  const document = settings ? patchWorldSettings(current, settings) : current;
  if (JSON.stringify(document) === JSON.stringify(current)) return newWorldSeed(entityId);
  return commitWorldDocument(entityId, document, "Edit World settings");
}

export function setWorldStyle(entityId, style) {
  return updateWorldSettings(entityId, { style }, "Change World look");
}

export function setWorldRoofColor(entityId, featureId = "cottage", color) {
  return commitWorldDocument(entityId, setWorldFeatureOverride(requireWorld(entityId).document, featureId, "roofColor", color), "Set World roof color");
}

export function resetWorldRoofColor(entityId, featureId = "cottage") {
  return commitWorldDocument(entityId, resetWorldFeatureOverride(requireWorld(entityId).document, featureId, "roofColor"), "Reset World roof color");
}

/** Set only the current editor camera, on an explicit navigation action.
 * Ordinary regeneration, style edits, resize and undo never call this. */
export function focusWorld(entityId, view = "valley", featureId = 'cottage') {
  const { entity, component } = requireWorld(entityId);
  const viewport = getViewportHandle();
  if (!viewport?.camera) return false;
  const poses = {
    valley: { position: [78, 52, 92], target: [0, 3, 0] },
    cottage: { position: [40, 12, 30], target: [22, 5.5, 6] },
    forest: { position: [-30, 12, -16], target: [-35, 5, -38] },
  };
  const pose = poses[view] ?? poses.valley;
  if (view === 'cottage') {
    const feature = component.getFeatureEntity?.(featureId);
    const position = feature?.getTransform().position;
    if (position) {
      const yaw = feature.getTransform().rotation[1], c = Math.cos(yaw), s = Math.sin(yaw);
      pose.position = [position[0]+18*c+24*s, position[1]+10, position[2]-18*s+24*c];
      pose.target = [position[0], position[1]+3.3, position[2]];
    }
  }
  if (view === 'forest' && component._plan) {
    const trees = component._plan.ecology.groups.filter(group => ['oak-wide','oak-elder','birch-tall','pine-tall'].includes(group.id))
      .flatMap(group => group.placements);
    const stand = trees[Math.floor(trees.length / 2)];
    if (stand) {
      const [x,y,z] = stand.position;
      pose.target = [x,y+4,z]; pose.position = [x+15,y+10,z+18];
    }
  }
  if (component._plan && view !== 'valley') pose.position[1] = Math.max(pose.position[1], component._plan.heightAt(pose.position[0],pose.position[2])+4);
  entity.object3D.updateWorldMatrix(true, false);
  const position = entity.object3D.localToWorld(new Vector3(...pose.position));
  const target = entity.object3D.localToWorld(new Vector3(...pose.target));
  viewport.camera.position.copy(position);
  if (viewport.orbit) {
    viewport.orbit.target.copy(target);
    viewport.orbit.update();
    viewport.orbit.dispatchEvent({ type: "change" });
  } else viewport.camera.lookAt(target);
  viewport.camera.updateMatrixWorld();
  return { position: position.toArray(), target: target.toArray() };
}

export function selectWorldTerrain(entityId) {
  const { component } = requireWorld(entityId);
  const terrain = component.terrainEntity ?? component.getFeatureEntity?.("terrain");
  if (!terrain?.id || !engine.getEntity(terrain.id)) throw new Error("Terrain is still being prepared.");
  useSelectionStore.getState().select(terrain.id);
  return { entityId: terrain.id };
}
