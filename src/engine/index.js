import { registerComponent } from "./components/registry.js";
import { MeshComponent } from "./components/MeshComponent.js";
import { LightComponent } from "./components/LightComponent.js";
import { CameraComponent } from "./components/CameraComponent.js";
import { ModelComponent } from "./components/ModelComponent.js";
import { BoneComponent } from "./components/BoneComponent.js";
import { SkinnedMeshComponent } from "./components/SkinnedMeshComponent.js";
import { ScriptComponent } from "./components/ScriptComponent.js";
import { ParticleComponent } from "./components/ParticleComponent.js";
import { AnimationComponent } from "./components/AnimationComponent.js";
import { InstancerComponent } from "./components/InstancerComponent.js";
import { GeometryModifiersComponent } from "./components/GeometryModifiersComponent.js";
import { SoundComponent } from "./components/SoundComponent.js";
import { ListenerComponent } from "./components/ListenerComponent.js";
import { UiScreenComponent } from "./components/ui/UiScreenComponent.js";
import { UiElementComponent } from "./components/ui/UiElementComponent.js";
import { UiImageComponent } from "./components/ui/UiImageComponent.js";
import { UiTextComponent } from "./components/ui/UiTextComponent.js";
import { UiButtonComponent } from "./components/ui/UiButtonComponent.js";
import { UiLayoutComponent } from "./components/ui/UiLayoutComponent.js";
import { UiScrollComponent } from "./components/ui/UiScrollComponent.js";
import { UiMaskComponent } from "./components/ui/UiMaskComponent.js";

// Built-in component catalog. Callers (editor + player) invoke
// `registerBuiltInComponents()` explicitly before deserializing a scene so
// every type ships in the bundle regardless of bundler tree-shaking — the
// side-effect `registerComponent(...)` calls below look like unused imports
// to a tree-shaker and would otherwise be dropped from production builds
// (which is why the player used to log "Unknown component type 'sound'"
// etc. for any type that had no other reachable consumer).
const BUILT_IN_COMPONENTS = [
  MeshComponent,
  LightComponent,
  CameraComponent,
  ModelComponent,
  BoneComponent,
  SkinnedMeshComponent,
  ScriptComponent,
  ParticleComponent,
  AnimationComponent,
  InstancerComponent,
  GeometryModifiersComponent,
  SoundComponent,
  ListenerComponent,
  UiScreenComponent,
  UiElementComponent,
  UiImageComponent,
  UiTextComponent,
  UiButtonComponent,
  UiLayoutComponent,
  UiScrollComponent,
  UiMaskComponent,
];

export function registerBuiltInComponents() {
  for (const cls of BUILT_IN_COMPONENTS) registerComponent(cls);
}

// Re-export the three namespace so callers (editor engineInstance, player
// entry) can install it on `globalThis.__ENGINE_THREE__` without a second
// `import("three/webgpu")` round-trip. The three.js package is published
// as CommonJS-with-namespace, so we re-export the whole namespace rather
// than a default (which it does not provide).
import * as THREE_NS from "three/webgpu";
export const THREE = THREE_NS;

export { Engine } from "./Engine.js";
export { Entity } from "./Entity.js";
export { Component } from "./components/Component.js";
export { registerComponent, unregisterComponent, getComponentClass, getComponentTypes, createComponent } from "./components/registry.js";
export {
  registerModuleDefinition,
  getModuleDefinition,
  getModuleDefinitions,
  enableEngineModule,
  disableEngineModule,
  applyEngineModules,
} from "./modules.js";
export { AudioSystem } from "./audio/AudioSystem.js";
export {
  loadAudioAsset,
  refreshAudioAsset,
  subscribeAudioAsset,
  getAudioBuffer,
  isAudioAssetReady,
  getAudioAssetDef,
  disposeAudioAsset,
  AUDIO_ASSET_DEFAULTS,
} from "./audio/AudioAsset.js";
export {
  serializeScene,
  deserializeScene,
  reconcileScene,
  serializeEntity,
  instantiateEntity,
} from "./serialize.js";
export {
  PREFAB_EXT,
  LEGACY_PREFAB_EXT,
  prefabRegistry,
  registerPrefabDefs,
  parsePrefabFile,
  makeDef,
  makeVariantDef,
  newGuid,
  newFid,
  isVariant,
  isPrefabDef,
  resolvePrefab,
  resolveInstance,
  instantiatePrefabNode,
  unpackInstance,
  getPrefabRoot,
  isPrefabRoot,
  isInsidePrefab,
  diffInstance,
  hasOverrides,
  groupOverrides,
  instanceNodeOf,
  respawnInstance,
  reloadPrefab,
  instancesAffectedBy,
  createDefFromEntity,
  bindEntityToPrefab,
  createVariantDefFromInstance,
  defWithInstanceApplied,
  defFromStageRoot,
} from "./prefab/index.js";
export {
  setAssetResolver,
  resolveAssetUrl,
  setScriptLoader,
  loadScriptModule,
  setAssetMetaLoader,
  loadAssetMeta,
  setAssetBinarySaver,
  saveAssetBinary,
  setDerivedDataRootProvider,
  getDerivedDataPath,
} from "./assetResolver.js";
export { SCENE_SETTINGS_DEFAULTS, TONE_MAPPINGS } from "./sceneSettings.js";
export {
  CUBEMAP_EXT,
  CUBEMAP_FACES,
  CUBEMAP_DEFAULTS,
  normalizeCubemapDef,
  cubemapFacePaths,
  isCubemapComplete,
  guessCubemapFaces,
  loadCubemapAsset,
  getLoadedCubemap,
  invalidateCubemapAsset,
} from "./cubemapAsset.js";
export { EDITOR_LAYER } from "./editorLayers.js";
export { UI_LAYER, getUiSystem } from "./ui/UiSystem.js";
export { ANCHOR_PRESETS, applyAnchorPreset } from "./ui/layout.js";
export {
  InputManager,
  ActionMap,
  InputAction,
  Binding,
  Composite,
  KeyboardDevice,
  MouseDevice,
  GamepadDevice,
  TouchDevice,
  VirtualJoysticks,
  DEFAULT_PLAYER_MAP,
  DEFAULT_UI_MAP,
  createDefaultMaps,
} from "./input/index.js";
