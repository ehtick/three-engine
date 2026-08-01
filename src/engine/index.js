import { registerComponent } from "./components/registry.js";
import { MeshComponent } from "./components/MeshComponent.js";
import { LightComponent } from "./components/LightComponent.js";
import { CameraComponent } from "./components/CameraComponent.js";
import { VirtualCameraComponent } from "./components/VirtualCameraComponent.js";
import { ImpulseSourceComponent } from "./components/ImpulseSourceComponent.js";
import { ModelComponent } from "./components/ModelComponent.js";
import { BoneComponent } from "./components/BoneComponent.js";
import { SkinnedMeshComponent } from "./components/SkinnedMeshComponent.js";
import { ScriptComponent } from "./components/ScriptComponent.js";
import { ParticleComponent } from "./components/ParticleComponent.js";
import { AnimationComponent } from "./components/AnimationComponent.js";
import { TimelineComponent } from "./components/TimelineComponent.js";
import { IKComponent } from "./components/IKComponent.js";
import { InstancerComponent } from "./components/InstancerComponent.js";
import { LineRendererComponent } from "./components/LineRendererComponent.js";
import { TrailRendererComponent } from "./components/TrailRendererComponent.js";
import { DecalComponent } from "./components/DecalComponent.js";
import { SplineComponent } from "./components/SplineComponent.js";
import { SplineFollowerComponent } from "./components/SplineFollowerComponent.js";
import { SplineMeshComponent } from "./components/SplineMeshComponent.js";
import { LodGroupComponent } from "./components/LodGroupComponent.js";
import { PoolComponent } from "./components/PoolComponent.js";
import { ImpostorComponent } from "./components/ImpostorComponent.js";
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
  VirtualCameraComponent,
  ImpulseSourceComponent,
  ModelComponent,
  BoneComponent,
  SkinnedMeshComponent,
  ScriptComponent,
  ParticleComponent,
  AnimationComponent,
  TimelineComponent,
  IKComponent,
  InstancerComponent,
  LineRendererComponent,
  TrailRendererComponent,
  DecalComponent,
  SplineComponent,
  SplineFollowerComponent,
  SplineMeshComponent,
  LodGroupComponent,
  PoolComponent,
  ImpostorComponent,
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
  SCENE_VERSION,
  serializeScene,
  deserializeScene,
  reconcileScene,
  serializeEntity,
  instantiateEntity,
} from "./serialize.js";
export {
  SAVE_FORMAT_VERSION,
  SaveSystem,
  PreferenceStore,
  KeyValueStore,
  setSaveBackend,
  getSaveBackend,
} from "./saveSystem.js";
export {
  SceneManager,
  SceneLoadCancelled,
  findSceneCamera,
  collectSceneAssets,
  expandMaterialAssets,
  sceneRefToPath,
} from "./sceneManager.js";
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
  setSceneLoader,
  loadSceneJson,
  setAssetBinarySaver,
  saveAssetBinary,
  setDerivedDataRootProvider,
  getDerivedDataPath,
} from "./assetResolver.js";
export {
  SCENE_SETTINGS_DEFAULTS,
  TONE_MAPPINGS,
  QUALITY_PRESETS,
  applyQualityCeiling,
} from "./sceneSettings.js";
export { Tween, TweenSystem, EASINGS } from "./tween.js";
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
export {
  TIMELINE_VERSION,
  TIMELINE_EXT,
  TRACK_KINDS,
  INTERPOLATIONS,
  VALUE_TYPES,
  WRAP_MODES,
  createTimeline,
  createDefaultTimeline,
  createTrack,
  createKey,
  createClipItem,
  normalizeTimeline,
  normalizeTrack,
  isPointTrack,
  trackItems,
  trackItemsKey,
  trackLabel,
  itemStart,
  itemDuration,
  timelineExtent,
  collectTimelineAssets,
} from "./timeline/timelineAsset.js";
export {
  evaluateKeys,
  interpolateValue,
  keyIndexAt,
  defaultValueFor,
  isSteppedType,
  valuesEqual,
} from "./timeline/curve.js";
export { TimelineRuntime } from "./timeline/TimelineRuntime.js";
export {
  TRANSFORM_COMPONENT,
  TRANSFORM_PROPERTIES,
  animatableProperties,
  valueTypeFor,
  readProperty,
  writeProperty,
} from "./timeline/propertyBinding.js";
export { EDITOR_LAYER, DEBUG_LAYER, OCCLUDER_LAYER } from "./editorLayers.js";
export { DebugBuffer, DebugDraw } from "./debugDraw.js";
export { RibbonBuffer, buildRibbon, smoothPolyline } from "./vfx/ribbon.js";
export { RibbonMesh, entitySubtreeVisible } from "./vfx/ribbonMesh.js";
export { createRibbonMaterial, createDecalMaterial, applyRibbonWrap, RIBBON_ALIGNMENTS } from "./vfx/vfxMaterial.js";
export { projectDecal, collectDecalTargets, decalOrientation } from "./vfx/decalProjection.js";
export { DecalSystem, DecalBatch } from "./vfx/DecalSystem.js";
export {
  Spline,
  SplineFrame,
  SPLINE_TYPES,
  WRAP_MODES as SPLINE_WRAP_MODES,
  KNOT_DEFAULTS,
  normalizeKnot,
  advanceAlong,
} from "./spline/splineMath.js";
export { PROFILES as SPLINE_PROFILES, buildProfile, buildSplineGeometry, applySplineGeometry } from "./spline/splineGeometry.js";
export { PathSystem } from "./spline/PathSystem.js";
export {
  APPLY_MODES,
  APPLY_MODE_LABELS,
  applyPlan,
  isIdentityMatrix,
  flipWinding,
  bakeMatrixIntoGeometry,
  relativeMatrix,
} from "./geometryTransform.js";
export { resolveSpline } from "./components/SplineComponent.js";
export { screenCoverage, selectLod, fitLevels } from "./lod/lodSelect.js";
export { LodSystem } from "./lod/LodSystem.js";
export {
  octEncode,
  octDecode,
  frameUv,
  frameDirection,
  frameWeights,
  frameBasis,
  tileOrigin,
} from "./lod/octahedral.js";
export { bakeImpostorAtlas, impostorCacheKey, IMPOSTOR_BAKE_DEFAULTS } from "./lod/impostorBake.js";
export { createImpostorMaterial, createImpostorGeometry } from "./lod/impostorMaterial.js";
export { ImpostorSystem } from "./lod/ImpostorSystem.js";
export { DepthPyramid, projectSphere, isOccluded, createBounds } from "./culling/occlusionMath.js";
export { OcclusionSystem } from "./culling/OcclusionSystem.js";
export { ImpulseSystem } from "./camera/impulse.js";
export { PoolSystem } from "./pool.js";
export {
  BLEND_STYLES,
  CameraPose,
  blendCurve,
  damp,
  dampAngle,
  dampFactor,
  dampVector3,
  lookRotation,
  orbitOffset,
  resolveCollision,
} from "./camera/rigMath.js";
export { UI_LAYER, getUiSystem, screenMode } from "./ui/UiSystem.js";
export { ANCHOR_PRESETS, applyAnchorPreset } from "./ui/layout.js";
export { getSdfFont, disposeSdfFonts, layoutGlyphs, wrapText } from "./ui/sdfFont.js";
export { pickNeighbour, toDirection } from "./ui/uiFocus.js";
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
