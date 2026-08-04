// NOTE: strict type-checking intentionally not enabled here — ~70 pre-existing
// errors unrelated to events (Camera/Engine.scene typing too narrow, import.meta.env),
// a follow-up outside the events-system pass.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Play, Square, Pause, StepForward, Move, Rotate3d, Scale3d, Layers as LayersIcon, Crosshair, Monitor, Wifi, Smartphone, QrCode, Share2, Link2, Loader2, Sparkles } from "lucide-react";
import qrcode from "qrcode-generator";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ensureEngine, engine, isEngineReady } from "../engineInstance.js";
import { installEditorFramePacing } from "../editorFramePacing.js";
import {
  openBrowserPreview,
  openBrowserPreviewUrl,
  stopBrowserPreview,
  getActiveBrowserPreview,
  startShareTunnel,
  stopShareTunnel,
  getActiveShareTunnel,
} from "../browserPreview.js";
import { pushToast } from "../toasts.js";
import { DEBUG_LAYER, EDITOR_LAYER, UI_LAYER } from "../../engine/editorLayers.js";
import { StatsOverlay } from "../overlays/StatsOverlay.jsx";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import {
  attachCursor,
  refreshCursor3D,
  setCursor3DPosition,
  setCursor3DVisible,
  setCursor3DSelected,
  getCursor3DObject,
  getCursor3D,
  isCursorSelectionId,
  CURSOR_SELECTION_ID,
} from "../threeDCursor.js";
import {
  snapCursorToSelection,
  snapCursorToWorldOrigin,
  snapCursorToGridFloor,
  snapSelectionToCursor,
  snapSelectionToOrigin,
} from "../threeDCursorOps.js";
import { CursorHUD } from "../helpers/CursorHUD.jsx";
import { ContextMenu } from "../ContextMenu.jsx";
import {
  clipboardHasEntities,
  copyEntities,
  deleteSelection,
  duplicateSelection,
  pasteEntities,
} from "../clipboard.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetTransformCommand } from "../commands/transformCommands.js";
import { SetCursor3DCommand } from "../commands/cursorCommands.js";
import {
  macroPivot,
  numericDelta,
  parseMacroNumber,
  pointerDelta,
  toggleBufferSign,
  worldPerPixelAt,
} from "../transformMacroMath.js";
import { BatchCommand, topMostIds } from "../commands/entityCommands.js";
import { getUiSystem } from "../../engine/ui/UiSystem.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import { extOf, MODEL_EXTENSIONS, TEXTURE_EXTENSIONS, SCRIPT_EXTENSIONS, MATERIAL_EXTENSIONS, PREFAB_EXTENSIONS } from "../assetLoader.js";
import { basename, useProjectStore } from "../store/projectStore.js";
import { getEditorCameraStorageKey, loadEditorCamera, saveEditorCamera } from "../cameraPrefs.js";
import { usePlayStore } from "../store/playStore.js";
import { toggle as togglePlay, stop as stopPlay, togglePaused, stepFrame } from "../playMode.js";
import { useAssetDrop } from "../assetDrag.js";
import { instantiatePrefab } from "../prefab.js";
import { getProjectSettings, onProjectSettingsApplied, applyProjectSettings } from "../projectSettings.js";
import { setViewportHandle } from "../viewportHandle.js";
import { openPanel } from "../EditorShell.jsx";
import { runWorkflow } from "../store/aiStore.js";
import { getWorkflow } from "../ai/workflows.js";
import { getActiveProvider } from "../ai/providers/index.js";
import {
  setSharedCanvas,
  claimCanvas,
  releaseCanvas,
  onCanvasOwnerChanged,
  setCanvasResizer,
  resizeSharedCanvas,
} from "../viewportCanvas.js";
import {
  finishTerrainBrushAdjustment,
  dispatchTerrainKeyAction,
  getTerrainBrushAdjustment,
  getTerrainBrushMode,
  getTerrainBrushSettings,
  setTerrainBrushSetting,
  subscribeTerrainBrush,
} from "../terrainBrush.js";
import { createStroke, resetStroke, strokeDabs } from "../brush.js";
import { SetTerrainHeightsCommand, SetTerrainScatterCommand, SetTerrainSplatmapCommand } from "../commands/terrainCommands.js";
import { GeometryEditorPanel } from "./GeometryEditorPanel.jsx";
import { useGeometryEditStore } from "../store/geometryEditStore.js";
import { ensureGeometryAsset } from "../geometryEditing.js";
import { setVirtualGeometryDebugVisible } from "../../modules/virtual-geometry/index.js";
import { DirectionalLightGizmo } from "../helpers/DirectionalLightGizmo.js";
import {
  activeSpline,
  appendKnot,
  beginSplineDrag,
  applySplineDrag,
  commitSplineDrag,
  deleteSelectedKnot,
  getSplineEdit,
  insertKnotAt,
  isSplineHandleTarget,
  pickCurve,
  pickSplineHandle,
  selectKnot,
  setBreakTangent,
  splineHandleProxy,
  subscribeSplineEdit,
  updateSplineHandles,
} from "../splineEditing.js";

/** Sets `layers.set(EDITOR_LAYER)` on every Object3D in the subtree —
 *  layers in three.js are not inherited, so this has to walk explicitly. */
function putOnEditorLayer(obj) {
  obj.layers.set(EDITOR_LAYER);
  obj.traverse((child) => {
    if (child !== obj) child.layers.set(EDITOR_LAYER);
  });
}

// Layers-dropdown toggles. Kept in declaration order so the dropdown
// reads top-to-bottom in the order users expect (gizmos = selection aids,
// colliders = physics aids, grid = spatial reference). Add new toggles
// here and to `viewport.layers` defaults above together.
const LAYER_TOGGLES = [
  { key: "gizmos", label: "Gizmos" },
  { key: "cursor3D", label: "3D Cursor" },
  { key: "colliders", label: "Colliders" },
  { key: "grid", label: "Grid" },
  { key: "stats", label: "Stats" },
  { key: "debugDraw", label: "Debug Draw" },
  // Off by default: a screen-space UI screen renders as a plane in the world
  // while editing (so it doesn't cover the scene), and this puts it back over
  // the viewport the way the player will see it — without entering Play.
  { key: "uiOverlay", label: "UI Overlay" },
  { key: "virtualGeometry", label: "Virtual Geometry" },
];

// The renderer canvas and editor controls outlive the React panel so the
// viewport can be closed/reopened without re-initializing WebGPU.
const viewport = {
  canvas: null,
  camera: null,
  perspectiveCamera: null,
  orthographicCamera: null,
  orthographicHeight: 10,
  axisView: null,
  axisAnimation: null,
  orbitStartQuaternion: null,
  orbit: null,
  gizmo: null,
  selectionBox: null,
  cameraHelper: null,
  lightHelper: null,
  cameraPreview: null,
  cameraPrefsKey: null,
  cameraPrefsSaveTimer: null,
  helpers: null,
  grid: null,
  backend: null,
  initPromise: null,
  hovered: false,
  gameCameraId: null,
  terrainBrushing: false,
  terrainBrushIndicator: null,
  // Multi-select pivot. A world-aligned Group the transform gizmo attaches
  // to when more than one entity is selected. While dragging we fan out
  // the pivot's world delta to every selected entity; once the drag ends
  // the per-entity transform commands are emitted as a batched undoable.
  pivot: null,
  pivotDrag: null, // { origins: [{id, worldPos, worldQuat, worldScale, object3D}], start: {pos,quat,scale} } | null
  // Toggles from the Layers dropdown. Mirrored in React state; mutations
  // here apply live so a hot-reload of the panel keeps the current layer
  // set. Default to "all on" so the viewport starts in its full visual state.
  layers: { gizmos: true, cursor3D: true, colliders: true, grid: true, stats: true, debugDraw: true, uiOverlay: false, virtualGeometry: false },
  layersListeners: new Set(),
};

// Depth-first walk over engine.rootEntities returning a flat list of
// entity ids. Mirrors HierarchyPanel's `flattenTree` but iterates the
// live engine tree instead of the React mirror — that's the source of
// truth for what's actually present in the 3D scene and matches what
// the picker raycaster can hit.
function flattenEngineTree() {
  const out = [];
  for (const root of engine.rootEntities) {
    root.traverse((entity) => out.push(entity.id));
  }
  return out;
}

// Notify any viewport subscriber (the toolbar dropdown) about layer changes.
// Hot-reload safe — added on demand, cleared on dispose.
function notifyLayersChanged() {
  for (const fn of viewport.layersListeners) fn({ ...viewport.layers });
}

async function ensureViewport() {
  if (viewport.initPromise) return viewport.initPromise;
  viewport.initPromise = (async () => {
    // Wait for the lazy engine to actually exist before touching its state.
    // ViewportPanel mounts immediately after the user picks a project, often
    // before EditorChrome's ensureEngine() callback has resolved.
    const engine = await ensureEngine();

    const canvas = document.createElement("canvas");
    canvas.className = "viewport-canvas";
    viewport.canvas = canvas;
    // Published to the arbiter rather than appended here: the Game panel shows
    // this same canvas while playing. See viewportCanvas.js.
    setSharedCanvas(canvas);

    try {
      viewport.perspectiveCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
      viewport.camera = viewport.perspectiveCamera;
      viewport.camera.position.set(7, 5, 9);
      // Editor camera must see the editor-only layer (camera model, gizmo,
      // grid, selection box, frustum helper). Without this, those objects
      // wouldn't render even though they live in the scene tree.
      viewport.camera.layers.enable(EDITOR_LAYER);
      // ...and runtime debug drawing, which lives on its own layer so it can
      // also reach the Play/Game views that switch the editor layer off.
      viewport.camera.layers.enable(DEBUG_LAYER);
      // ...and UI, which draws in this pass rather than a second one of its
      // own (see engine/ui/UiSystem.js). Screen-space screens are shown as
      // world planes while authoring, so the editor camera needs them too.
      viewport.camera.layers.enable(UI_LAYER);

      viewport.backend = await engine.init(canvas);
      engine.camera = viewport.camera;
      console.log(`Renderer backend: ${viewport.backend}`);
      logToHost(`Renderer backend: ${viewport.backend}`);

      const helpers = new THREE.Group();
      helpers.userData.editorOnly = true;
      engine.scene.add(helpers);
      viewport.helpers = helpers;
      rebuildGrid(getProjectSettings().editor);
      // After grid is attached, push the whole subtree onto the editor
      // layer. Doing this here (rather than before adding the grid) means
      // the grid also gets put on layer 31, since layers aren't inherited
      // from the parent in three.js.
      putOnEditorLayer(helpers);
      // Grid size/visibility follow project settings live.
      onProjectSettingsApplied((settings) => rebuildGrid(settings.editor));

      // 3D cursor — the Blender-style spawn/transform anchor. Lives on the
      // helpers group so it shares the EDITOR_LAYER placement and follows
      // every editor-only visibility rule for free.
      attachCursor(helpers);

      // World-aligned pivot used by the transform gizmo for multi-selection.
      // Lives in engine.scene so its world matrix is the identity parent;
      // attachSelection positions it at the selection centroid. The Group
      // itself is editor-only (camera helpers, grid, etc. all use the same
      // flag) so click-through picking and play-mode visibility stay correct.
      const pivot = new THREE.Group();
      pivot.name = "MultiSelectPivot";
      pivot.userData.editorOnly = true;
      pivot.visible = false; // hidden — only the gizmo arrows are visible
      engine.scene.add(pivot);
      viewport.pivot = pivot;

      viewport.orbit = new OrbitControls(viewport.camera, canvas);
      // DEV-ONLY handle for automated harnesses. `engine.camera` IS this
      // camera, but OrbitControls re-aims it at `orbit.target` on every
      // update — so a script that sets position+lookAt gets its orientation
      // silently overwritten and ends up photographing empty space. Aiming
      // the viewport from a script means moving the ORBIT TARGET, which
      // needs the controls object.
      if (import.meta.env?.DEV) globalThis.__viewport = viewport;
      // Publish it properly too: the editor API's viewport ops (screenshot,
      // aim, frame) need this in a PACKAGED build, where the DEV global above
      // does not exist. See viewportHandle.js for why they don't import this
      // module directly.
      setViewportHandle(viewport);
      viewport.orbit.enableDamping = true;
      viewport.orbit.dampingFactor = 0.12;
      viewport.orbit.addEventListener("start", () => {
        viewport.orbitStartQuaternion = viewport.camera?.quaternion.clone() ?? null;
      });
      viewport.orbit.addEventListener("change", () => {
        if (!viewport.camera?.isOrthographicCamera || viewport.axisAnimation || !viewport.orbitStartQuaternion) {
          if (!engine.playing) scheduleEditorCameraPrefsSave();
          return;
        }
        // Pan and zoom keep an orthographic axis view. The first real rotation
        // delta returns to perspective, matching Blender's viewport behavior.
        if (Math.abs(viewport.camera.quaternion.dot(viewport.orbitStartQuaternion)) < 0.999999) {
          viewport.orbitStartQuaternion = null;
          usePerspectiveView();
        }
        if (!engine.playing) scheduleEditorCameraPrefsSave();
      });
      const sceneState = useSceneStore.getState();
      updateEditorCameraPrefsKey(
        useProjectStore.getState().rootPath,
        sceneState.scenePath,
        sceneState.sceneName,
      );

      setupGizmo(canvas);
      setupSplineEditing(canvas);
      setupPicking(canvas);
      setupTerrainBrush(canvas);
      setupKeyboard(canvas);
      // While a sculpt/paint brush is armed, hide the transform gizmo so its
      // arrow handles can't intercept brush strokes on the terrain mesh.
      subscribeTerrainBrush(() => {
        const armed = !!getTerrainBrushMode();
        viewport.gizmo.enabled = !armed;
        viewport.gizmo.getHelper().visible = !armed;
      });
      setupPlayCamera();
      setupCameraPreview();

      // Layer-toggle sub-systems. Gizmo + grid live in `viewport.*` and
      // are picked up by `applyLayerVisibility`; colliders come from
      // individual components attached at any time, so we sync them
      // whenever the scene tree changes.
      applyLayerVisibility();
      const unsubHierarchy = engine.on("hierarchy-changed", () => {
        // Cheap-ish — walks every entity looking for a collider.
        // Sets visibility to the user's current preference; new colliders
        // added since the last tick get their `visible` corrected here.
        setCollidersVisible(viewport.layers.colliders);

        // Some operations rebuild an entity's Object3D while keeping its id —
        // prefab respawns (apply / revert / a prefab asset changing) destroy
        // the subtree and re-expand it. `attachSelection` only re-runs on a
        // *selection* change, so the gizmo would still be holding the destroyed
        // object ("TransformControls: The attached 3D object must be a part of
        // the scene graph"). Re-attach when the object under the selection
        // has been swapped out — for multi-select this also covers any
        // selected entity's object3D being rebuilt under the pivot.
        const ids = useSelectionStore.getState().ids;
        if (!ids.length || !viewport.gizmo?.object) return;
        if (viewport.gizmo.object === viewport.pivot) {
          // Multi-select: any selected entity whose object3D no longer
          // matches the captured origin forces a full re-attach so the
          // pivot repositions at the new centroid and the box3 helper
          // recomputes over the live tree.
          const drag = viewport.pivotDrag;
          if (drag) {
            for (const origin of drag.origins) {
              const entity = engine.getEntity(origin.id);
              if (!entity || entity.object3D !== origin.object3D) {
                attachSelection(ids);
                return;
              }
            }
          } else {
            // No active drag — re-run attachSelection so the pivot
            // centroid and Box3 helper stay in sync with the live tree.
            attachSelection(ids);
          }
        } else {
          // Single-select: same check as before, against ids[0].
          const selectedId = ids[0];
          const selected = selectedId ? engine.getEntity(selectedId) : null;
          if (selected && viewport.gizmo.object !== selected.object3D) {
            attachSelection(ids);
          }
        }
      });

      engine.onUpdate(() => {
        viewport.orbit.update();
        updateAxisViewAnimation();
        // 3D cursor: keep the proxy parented (in case helpers were
        // rebuilt) and at its current world position. Cheap — just
        // touches the cursor Group's matrix.
        refreshCursor3D();
        // `viewport.selectionBox` is a BoxHelper in single-select mode
        // (which has an `update()` that recomputes its geometry from the
        // attached object3D) or a Box3Helper in multi-select mode (which
        // has no `update()` and instead reads from its `box` property on
        // every `updateMatrixWorld`). The type-discriminated call keeps
        // the per-frame refresh working for both.
        if (viewport.selectionBox) {
          if (viewport.selectionBox.type === "BoxHelper") viewport.selectionBox.update();
          else if (viewport.selectionBox.type === "Box3Helper") viewport.selectionBox.updateMatrixWorld(true);
        }
        viewport.cameraHelper?.update();
        // The light helper samples the live THREE.Light on every update(), so
        // calling it each frame keeps the cone / arrow aligned with the
        // entity's current transform and the spot angle in sync with the
        // component props. Per-frame is overkill for static lights, but
        // cost is negligible (a handful of vector writes).
        viewport.lightHelper?.update();
        // Re-resolve "follow target" before the main render so the
        // PIP preview and the orbit view both see the post-follow
        // camera pose. In play mode the engine.camera is the scene
        // camera itself; in editor mode it's the orbit camera (which
        // isn't affected). Cheap enough to run unconditionally.
        applyCameraFollow();
        // Refresh the camera matrix and the gizmo helper's matrix world here
        // so pointer events received between this tick and the render still see
        // fresh transform data. Without this, a pointermove fired right after
        // a `dragging-changed` toggle could raycast against a camera matrix
        // from two frames ago, missing the picker meshes entirely.
        viewport.camera.updateMatrixWorld();
        viewport.gizmo?.getHelper()?.updateMatrixWorld();
      });

      engine.start();
      installEditorFramePacing();
      // Renderer-side project settings (pixel ratio cap) can only apply now.
      applyProjectSettings().catch(() => {});
      return viewport.backend;
    } catch (err) {
      console.error("Viewport init failed:", err);
      logToHost(`Viewport init failed: ${err?.message ?? err}`);
      throw err;
    }
  })();
  return viewport.initPromise;
}

async function logToHost(message) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("frontend_log", { message });
  } catch {
    // Not running inside Tauri (plain browser dev) — terminal log unavailable.
  }
}

function setupGizmo(canvas) {
  const gizmo = new TransformControls(viewport.camera, canvas);
  viewport.gizmo = gizmo;
  // TransformControls owns its own internal raycaster (getRaycaster())
  // which defaults to testing only layer 0. The helper, including the
  // picker meshes that drive axis detection, is moved onto EDITOR_LAYER
  // below so play-mode cameras (and the PIP camera) don't render it.
  // Without enabling every layer here, that picker is invisible to the
  // gizmo's own raycaster — pointerHover finds nothing, `axis` stays
  // null, pointerDown bails out, and the visible arrows never react.
  gizmo.getRaycaster().layers.enableAll();
  const helper = gizmo.getHelper();
  // The helper's `updateMatrixWorld` cancels out the parent's transform so
  // the gizmo stays world-aligned, which depends on its parent (engine.scene)
  // having a current matrixWorld. Scene defaults to identity so this is fine,
  // but we still call it once so the first `pointermove` doesn't have to wait
  // a frame before the picker positions are at the entity location.
  helper.matrixAutoUpdate = true;
  helper.updateMatrixWorld(true);
  engine.scene.add(helper);
  helper.userData.editorOnly = true;
  putOnEditorLayer(helper);
  // Force the camera matrix to be fresh so the gizmo's internal raycaster
  // uses the latest view the very first time pointerHover runs. Cheap, but
  // prevents any "stale matrixWorld between init and the first pointer event"
  // class of bug from blocking axis detection.
  viewport.camera.updateMatrixWorld(true);

  let beforeTransform = null;
  let beforeCursorPos = null;
  let cursorDragCommand = null;
  gizmo.addEventListener("dragging-changed", (e) => {
    viewport.orbit.enabled = !e.value;
    if (gizmo.object === viewport.pivot) {
      // Multi-select drag: capture or commit per the world pivot state.
      if (e.value) beginPivotDrag();
      else commitPivotDrag();
      return;
    }
    // Spline knot drag: the gizmo is attached to the knot proxy. The knot is
    // written live for feedback and committed as ONE command on release —
    // a command per pointermove would turn Ctrl+Z into a frame-by-frame
    // rewind of the drag.
    if (isSplineHandleTarget(gizmo.object)) {
      if (e.value) beginSplineDrag();
      else commitSplineDrag();
      return;
    }
    // Cursor drag: the gizmo is attached to the cursor's proxy (a
    // sentinel selection), so the user can grab and move the cursor
    // like any other object. Drag commits a single SetCursor3DCommand
    // so Ctrl+Z pops it back to where it was.
    if (isCursorSelectionTarget(gizmo.object)) {
      if (e.value) {
        beforeCursorPos = [...getCursor3D().position];
      } else if (beforeCursorPos) {
        const after = getCursor3D().position;
        // Skip no-op drags (e.g. clicks on the gizmo's centre handle
        // without movement) so the undo stack stays clean.
        const moved = beforeCursorPos.some((v, i) => Math.abs(v - after[i]) > 1e-6);
        if (moved) {
          cursorDragCommand = new SetCursor3DCommand(after, beforeCursorPos);
          commandBus.execute(cursorDragCommand);
        }
        beforeCursorPos = null;
        cursorDragCommand = null;
      }
      return;
    }
    // Single-entity drag: the existing one-shot SetTransformCommand.
    const entityId = gizmo.object?.userData.entityId;
    if (!entityId) return;
    if (e.value) {
      beforeTransform = engine.getEntity(entityId).getTransform();
    } else if (beforeTransform) {
      const after = engine.getEntity(entityId).getTransform();
      commandBus.execute(new SetTransformCommand(entityId, after, beforeTransform));
      beforeTransform = null;
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (gizmo.object === viewport.pivot) {
      // Multi-select: fan out the pivot's world delta to every selected
      // entity and refresh the inspector numbers.
      if (viewport.pivotDrag) applyPivotDrag();
      engine.emit("transform-changed");
      return;
    }
    if (isSplineHandleTarget(gizmo.object)) {
      applySplineDrag();
      return;
    }
    // Cursor drag: read the proxy's world position back into cursor
    // state on every frame so the visible crosshairs and the readout
    // HUD both follow the user's pointer.
    if (isCursorSelectionTarget(gizmo.object)) {
      const pos = gizmo.object.position;
      setCursor3DPosition(pos.x, pos.y, pos.z);
      return;
    }
    const entityId = gizmo.object?.userData.entityId;
    if (entityId) {
      useSceneStore.getState().updateTransform(entityId);
      engine.emit("transform-changed", { entityId });
    }
  });

  // Hold Ctrl to snap: 0.5 units / 15° / 0.1 scale.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Control") setSnap(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control") setSnap(false);
  });

  useSelectionStore.subscribe((state) => {
    // Mirror the cursor's selection bit onto its module state so the
    // HUD can highlight when the cursor is the active target. Done
    // before attachSelection so the proxy's tint is up-to-date when
    // the gizmo arrows get attached to it on the same tick.
    const cursorSelected = state.ids?.some(isCursorSelectionId);
    setCursor3DSelected(cursorSelected);
    attachSelection(state.ids);
  });
  engine.on("play-changed", () => attachSelection(useSelectionStore.getState().ids));
  // Rebuild the light helper when the selected light's `kind` changes —
  // the component replaces its underlying THREE.Light instance on kind
  // change (onPropChanged detaches+reattaches), so any helper bound to
  // the previous light would render against stale geometry. Other prop
  // changes (color, angle, distance, intensity) mutate the existing
  // light in place and are picked up by the per-frame helper.update().
  engine.on("component-changed", ({ entityId, componentType, key }) => {
    if (componentType !== "light" || key !== "kind") return;
    const selectedId = useSelectionStore.getState().ids[0];
    if (entityId !== selectedId) return;
    const entity = engine.getEntity(entityId);
    const lightComponent = entity?.getComponent?.("light");
    if (lightComponent) attachLightHelper(lightComponent);
    else detachLightHelper();
  });
}

/** First entity (depth-first) carrying a camera component, or null. */
function findSceneCamera() {
  for (const root of engine.rootEntities) {
    let found = null;
    root.traverse((e) => {
      if (!found && e.getComponent("camera")) found = e;
    });
    if (found) return found;
  }
  return null;
}

/** Switches rendering between the editor's orbit camera and the scene's own
 * camera entity for Play mode, and hides editor-only helpers/gizmos so the
 * viewport shows what the game actually looks like. */
function setupPlayCamera() {
  engine.on("play-changed", (playing) => {
    if (viewport.helpers) viewport.helpers.visible = !playing;
    if (viewport.cameraPreview) viewport.cameraPreview.setVisible(!playing);
    // Gizmo + selectionBox visibility is owned by `applyLayerVisibility`
    // — it AND-combines the user's Gizmo toggle with the editor-vs-play
    // rule so flipping the dropdown takes effect both in and out of play.
    applyLayerVisibility();
    // The 3D cursor's primary proxy lives under viewport.helpers so it's
    // already hidden when helpers go invisible — but its local proxy in
    // the geometry editor's detached scene does *not*. Force a refresh
    // so that one hides (or unhides) on the same frame as the play flip
    // instead of waiting for the next engine.onUpdate tick.
    refreshCursor3D();

    if (playing) {
      const camEntity = findSceneCamera();
      if (camEntity) {
        viewport.gameCameraId = camEntity.id;
        engine.camera = camEntity.getComponent("camera").camera;
        // Game camera must not render editor-only objects (camera models,
        // gizmos, grid, frustum helpers). Disable just the editor layer
        // so any game-side layers the user enabled still work.
        engine.camera.layers.disable(EDITOR_LAYER);
      } else {
        viewport.gameCameraId = null;
        console.warn("No Camera entity in the scene — showing the editor camera during Play.");
        // No scene camera — keep using the editor camera so play is
        // still observable; do NOT disable its EDITOR_LAYER or the
        // camera model would vanish for this branch.
      }
      viewport.orbit.enabled = false;
    } else {
      viewport.gameCameraId = null;
      engine.camera = viewport.camera;
      // Editor camera sees every layer — make sure EDITOR_LAYER is on so
      // helpers / the camera model reappear when returning from Play.
      viewport.camera.layers.enable(EDITOR_LAYER);
      viewport.orbit.enabled = true;
    }
    resizeActiveCamera();
  });
}

// The Game panel drives the same resize path (through the canvas arbiter) so
// there is exactly one place that knows how to re-fit the active camera.
setCanvasResizer((width, height) => {
  engine.setSize(width, height);
  resizeActiveCamera();
});

function resizeActiveCamera() {
  if (!viewport.canvas || !engine.camera) return;
  const { width, height } = viewport.canvas;
  if (!width || !height) return;
  const aspect = width / height;
  if (engine.camera.isPerspectiveCamera) {
    engine.camera.aspect = aspect;
  } else if (engine.camera.isOrthographicCamera) {
    const halfHeight = viewport.orthographicHeight * 0.5;
    engine.camera.left = -halfHeight * aspect;
    engine.camera.right = halfHeight * aspect;
    engine.camera.top = halfHeight;
    engine.camera.bottom = -halfHeight;
  }
  engine.camera.updateProjectionMatrix();
}

function getEditorCameraPose() {
  if (!viewport.camera || !viewport.orbit) return null;
  return {
    position: viewport.camera.position.toArray(),
    direction: new THREE.Vector3(0, 0, -1).applyQuaternion(viewport.camera.quaternion).toArray(),
    quaternion: viewport.camera.quaternion.toArray(),
    target: viewport.orbit.target.toArray(),
    up: viewport.camera.up.toArray(),
    zoom: viewport.camera.zoom,
  };
}

function saveEditorCameraPrefs(key = viewport.cameraPrefsKey) {
  const pose = getEditorCameraPose();
  if (!key || !pose) return;
  saveEditorCamera(key, pose);
}

function scheduleEditorCameraPrefsSave() {
  if (!viewport.cameraPrefsKey) return;
  clearTimeout(viewport.cameraPrefsSaveTimer);
  viewport.cameraPrefsSaveTimer = setTimeout(() => {
    viewport.cameraPrefsSaveTimer = null;
    saveEditorCameraPrefs();
  }, 250);
}

function restoreEditorCameraPrefs(key) {
  const saved = loadEditorCamera(key);
  if (!saved || !viewport.camera || !viewport.orbit) return;
  viewport.camera.position.fromArray(saved.position);
  viewport.camera.quaternion.fromArray(saved.quaternion);
  viewport.camera.up.fromArray(saved.up);
  viewport.camera.zoom = saved.zoom;
  viewport.camera.updateProjectionMatrix();
  viewport.orbit.target.fromArray(saved.target);
  syncOrbitCamera(viewport.camera);
  viewport.orbit.update();
  viewport.camera.updateMatrixWorld(true);
}

function updateEditorCameraPrefsKey(rootPath, scenePath, sceneName) {
  const nextKey = getEditorCameraStorageKey(rootPath, scenePath || sceneName);
  if (nextKey === viewport.cameraPrefsKey) return;
  clearTimeout(viewport.cameraPrefsSaveTimer);
  viewport.cameraPrefsSaveTimer = null;
  if (viewport.cameraPrefsKey) saveEditorCameraPrefs(viewport.cameraPrefsKey);
  viewport.cameraPrefsKey = nextKey;
  restoreEditorCameraPrefs(nextKey);
}


const axisViewListeners = new Set();

function notifyAxisViewChanged() {
  for (const fn of axisViewListeners) fn(viewport.axisView);
}

function subscribeAxisView(fn) {
  axisViewListeners.add(fn);
  return () => axisViewListeners.delete(fn);
}

/** Swap the editor camera while keeping OrbitControls and TransformControls
 * attached to the currently rendered camera. */
function syncOrbitCamera(camera) {
  if (viewport.orbit) {
    const orbit = viewport.orbit;
    orbit.object = camera;
    // The editor is permanently Y-up. A +/-Y orthographic view temporarily
    // uses Z only as its screen-up direction, but OrbitControls must keep its
    // world-Y orbit basis when cameras are swapped.
    orbit._quat.identity();
    orbit._quatInverse.copy(orbit._quat).invert();
    // A snap is an absolute camera change. Do not let damping accumulated on
    // the previous camera continue moving the replacement camera.
    orbit._sphericalDelta.set(0, 0, 0);
    orbit._panOffset.set(0, 0, 0);
    orbit._scale = 1;
    orbit.position0.copy(camera.position);
    orbit.zoom0 = camera.zoom;
    orbit.target0.copy(orbit.target);
  }
}

function useEditorCamera(camera) {
  viewport.camera = camera;
  camera.layers.enable(EDITOR_LAYER);
  syncOrbitCamera(camera);
  if (viewport.gizmo) viewport.gizmo.camera = camera;
  if (!engine.playing) engine.camera = camera;
  resizeActiveCamera();
  camera.updateMatrixWorld(true);
  viewport.gizmo?.getHelper()?.updateMatrixWorld(true);
}

const AXIS_VIEW_DURATION = 180;

function updateAxisViewAnimation() {
  const animation = viewport.axisAnimation;
  if (!animation) return;
  const elapsed = performance.now() - animation.startedAt;
  const t = THREE.MathUtils.clamp(elapsed / AXIS_VIEW_DURATION, 0, 1);
  const eased = 1 - Math.pow(1 - t, 3);

  const turn = new THREE.Quaternion().identity().slerp(animation.directionTurn, eased);
  const direction = animation.startDirection.clone().applyQuaternion(turn);
  animation.camera.position.copy(animation.target).addScaledVector(direction, animation.distance);
  animation.camera.quaternion.slerpQuaternions(animation.startQuaternion, animation.endQuaternion, eased);
  // The camera pose is animated outside OrbitControls, so publish its normal
  // change event explicitly to make the corner axes animate with the view.
  viewport.orbit.dispatchEvent({ type: "change" });

  if (t < 1) return;
  animation.camera.position.copy(animation.endPosition);
  animation.camera.quaternion.copy(animation.endQuaternion);
  animation.camera.up.copy(animation.endUp);
  viewport.axisAnimation = null;
  syncOrbitCamera(animation.camera);
  viewport.orbit.enabled = !engine.playing && !getTerrainBrushMode();
  viewport.orbit.update();
}

function setAxisView(axis, sign = 1) {
  if (!viewport.camera || !viewport.orbit || engine.playing) return;

  const requestedView = `${sign > 0 ? "+" : "-"}${axis.toUpperCase()}`;
  // Re-clicking the face-on endpoint flips to the opposite side, which keeps
  // both directions reachable when their projected buttons overlap.
  if (viewport.axisView === requestedView) sign *= -1;

  const source = viewport.camera;
  const target = viewport.orbit.target.clone();
  const distance = Math.max(source.position.distanceTo(target), 0.1);
  const aspect = Math.max(viewport.canvas?.clientWidth || 1, 1) / Math.max(viewport.canvas?.clientHeight || 1, 1);

  // Match the perspective camera's visible height at the orbit target so the
  // snap changes projection without an unexpected jump in framing.
  if (source.isPerspectiveCamera) {
    viewport.orthographicHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(source.fov * 0.5)) / source.zoom;
  } else {
    viewport.orthographicHeight = (source.top - source.bottom) / source.zoom;
  }
  const halfHeight = viewport.orthographicHeight * 0.5;
  let camera = viewport.orthographicCamera;
  if (!camera) {
    camera = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.1, 2000);
    viewport.orthographicCamera = camera;
  }
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.zoom = 1;

  const direction = new THREE.Vector3(
    axis === "x" ? sign : 0,
    axis === "y" ? sign : 0,
    axis === "z" ? sign : 0,
  );
  const endPosition = target.clone().addScaledVector(direction, distance);
  const endUp = new THREE.Vector3(0, 1, 0);
  if (axis === "y") endUp.set(0, 0, sign > 0 ? -1 : 1);
  const endQuaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(endPosition, target, endUp),
  );
  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.up.copy(source.up);
  camera.updateProjectionMatrix();

  useEditorCamera(camera);
  viewport.orbit.target.copy(target);
  viewport.orbit.enabled = false;
  const startDirection = source.position.clone().sub(target).normalize();
  viewport.axisAnimation = {
    camera,
    target,
    distance,
    startDirection,
    directionTurn: new THREE.Quaternion().setFromUnitVectors(startDirection, direction),
    startQuaternion: source.quaternion.clone(),
    endQuaternion,
    endPosition,
    endUp,
    startedAt: performance.now(),
  };
  viewport.axisView = `${sign > 0 ? "+" : "-"}${axis.toUpperCase()}`;
  viewport.orbitStartQuaternion = null;
  notifyAxisViewChanged();
}

function usePerspectiveView() {
  if (!viewport.camera || !viewport.orbit || engine.playing || viewport.camera.isPerspectiveCamera) return;
  viewport.axisAnimation = null;
  const source = viewport.camera;
  const camera = viewport.perspectiveCamera;
  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.up.set(0, 1, 0);
  useEditorCamera(camera);
  viewport.orbit.enabled = !getTerrainBrushMode();
  viewport.orbit.update();
  viewport.axisView = null;
  notifyAxisViewChanged();
}

/**
 * Per-frame editor-time camera-follow tick.
 *
 * Drives `followInViewport` for every camera component: when the engine
 * is not playing, cameras with this flag look at their target. The
 * sibling flag `followInGame` is handled by CameraComponent itself, so
 * the shipped player honors it without dragging the editor into the
 * runtime. (Camera components only subscribe to onUpdate when attached,
 * so the editor can pass through without redoing work.)
 *
 * Iterates every entity with a camera component so multiple cameras
 * with follow enabled all update in one pass. The cost is tiny (one
 * vector read + one matrix write per active camera).
 */
function applyCameraFollow() {
  // Skip the editor's pass when the game is running — the component-level
  // onUpdate is in charge of followInGame then.
  if (engine.playing) return;
  for (const entity of engine.entities.values()) {
    const cam = entity.getComponent?.("camera");
    if (!cam) continue;
    cam.applyLookAt(!!cam.props.followInViewport, engine);
  }
}

/**
 * Picture-in-picture render of whatever the selected camera entity is
 * currently seeing. We don't use a separate render target — instead we
 * draw the camera's view into a small region of the editor's own WebGPU
 * canvas (via setViewport + setScissor), then overlay a DOM border/label
 * over that exact spot. Drawing into the same canvas keeps everything on
 * the same renderer instance, sidesteps async pixel-readback quirks, and
 * means the preview always renders in lock-step with the main view.
 *
 * The CSS class `.camera-preview-frame` (see theme.css) is a DOM element
 * positioned exactly over the canvas sub-region to provide the rounded
 * border + box-shadow; the actual pixels live on the canvas.
 *
 * Editor-only objects (camera model, gizmo, grid, frustum helper) live on
 * `EDITOR_LAYER` and are temporarily hidden from the preview camera via
 * `hideEditorOnly` AND by disabling that layer on the camera, so they
 * never leak into the PIP view.
 */
const PREVIEW_FRACTION = 0.28; // ~28% of viewport height
const PREVIEW_ASPECT = 16 / 9;
const PREVIEW_MARGIN = 18; // px from the corner

class CameraPreview {
  constructor() {
    this.camera = null;
    this.component = null; // CameraComponent reference — drives showPreview flag
    this.visible = false;
    this.disposed = false;
  }

  setCamera(threeCamera, component = null) {
    this.camera = threeCamera ?? null;
    this.component = component;
    this.updateVisible();
  }

  setVisible(visible) {
    this.visible = !!visible;
    this.updateVisible();
  }

  updateVisible() {
    const componentWantsPreview = this.component ? this.component.props.showPreview !== false : true;
    const show = !!this.camera && this.visible && !engine.playing && componentWantsPreview;
    if (this.frame) this.frame.style.display = show ? "block" : "none";
  }

  dispose() {
    this.disposed = true;
    if (this.frame) this.frame.remove();
  }

  /**
   * ALWAYS the engine's CURRENT renderer, never a captured one.
   *
   * `Engine.#rebuildRenderer` disposes the WebGPURenderer and constructs a new
   * one whenever a construction-time option changes (MSAA/antialias/alpha are
   * frozen at init). A captured reference survives that as a DISPOSED renderer,
   * and the first symptom is neither a blank preview nor a clear error — it is
   * an exception from deep inside the backend on every single frame:
   *
   *   Failed to read the 'querySet' property from 'GPURenderPassTimestampWrites'
   *
   * because disposing the renderer nulls its timestamp query pool's `querySet`
   * while this pass keeps asking it to bracket a render pass. Reading the
   * renderer per frame costs a property lookup and cannot go stale.
   */
  get renderer() {
    return isEngineReady() ? engine.renderer : null;
  }

  renderFrame() {
    if (this.disposed || !this.camera || !this.renderer) return;
    if (engine.playing) return;
    const componentWantsPreview = this.component ? this.component.props.showPreview !== false : true;
    if (!componentWantsPreview) {
      this.updateVisible();
      return;
    }
    const canvas = viewport.canvas;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;

    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (!cssW || !cssH) return;

    const previewH = Math.round(cssH * PREVIEW_FRACTION);
    const previewW = Math.round(previewH * PREVIEW_ASPECT);
    const x = Math.max(0, Math.round(cssW - previewW - PREVIEW_MARGIN));
    const y = Math.max(0, Math.round(cssH - previewH - PREVIEW_MARGIN));
    const w = previewW;
    const h = previewH;

    const cam = this.camera;
    const aspect = w / h;
    if (Math.abs(cam.aspect - aspect) > 0.001) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }

    // Sync the DOM frame so its border aligns with the canvas sub-region.
    // CSS uses a top-left origin while three.js uses a bottom-left origin,
    // so flip y when positioning the frame.
    if (this.frame) {
      this.frame.style.width = `${w}px`;
      this.frame.style.height = `${h}px`;
      this.frame.style.left = `${x}px`;
      this.frame.style.top = `${Math.max(0, cssH - y - h)}px`;
    }

    // Save renderer state we touch; restore in finally so the next frame's
    // main render starts from the default state again.
    const prevViewport = new THREE.Vector4();
    this.renderer.getViewport(prevViewport);
    const prevScissor = new THREE.Vector4();
    this.renderer.getScissor(prevScissor);
    const prevScissorTest = this.renderer.getScissorTest();
    // The WebGPU backend's render pass starts with `loadOp: Clear` when
    // autoClearColor is on, which would wipe the main scene we just
    // rendered. Flip autoClearColor off (but leave autoClearDepth on so
    // the PIP still has a fresh depth buffer for its own draws).
    const prevAutoClear = this.renderer.autoClear;
    const prevAutoClearColor = this.renderer.autoClearColor;
    const prevAutoClearDepth = this.renderer.autoClearDepth;

    const hidden = hideEditorOnly(engine.scene);
    const prevEnabled = cam.layers.isEnabled(EDITOR_LAYER);
    cam.layers.disable(EDITOR_LAYER);
    try {
      this.renderer.setViewport(x, y, w, h);
      this.renderer.setScissor(x, y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.autoClear = false;
      this.renderer.autoClearColor = false;
      this.renderer.autoClearDepth = true;
      this.renderer.render(engine.scene, cam);
    } finally {
      this.renderer.autoClear = prevAutoClear;
      this.renderer.autoClearColor = prevAutoClearColor;
      this.renderer.autoClearDepth = prevAutoClearDepth;
      if (prevEnabled) cam.layers.enable(EDITOR_LAYER);
      restoreHidden(hidden);
      this.renderer.setScissorTest(prevScissorTest);
      this.renderer.setScissor(prevScissor);
      this.renderer.setViewport(prevViewport);
    }
  }
}

/** Lazily creates the DOM frame (border + label) that sits over the
 *  canvas sub-region. Returned element is appended to the viewport-panel
 *  container so it follows canvas resize. */
function ensurePreviewFrame() {
  const existing = document.querySelector(".camera-preview-frame");
  if (existing) return existing;
  const host = document.querySelector(".viewport-panel");
  if (!host) return null;
  const frame = document.createElement("div");
  frame.className = "camera-preview-frame";
  frame.style.display = "none";
  frame.style.pointerEvents = "none";
  host.appendChild(frame);
  return frame;
}

/**
 * Collects every top-most editor-only subtree under `root` and hides them,
 * returning a flat list of `{ obj, prev }` so callers can restore visibility
 * via `restoreHidden`. A node is "top-most editor-only" if its own
 * userData.editorOnly is set AND no ancestor in the path has it set, so we
 * hide the root of each helper region (e.g. viewport.helpers) rather than
 * walking every leaf inside it.
 */
function hideEditorOnly(root) {
  const hidden = [];
  root.traverse((obj) => {
    if (!obj.userData?.editorOnly) return;
    // Skip if an ancestor already hid everything above us.
    for (let p = obj.parent; p && p !== root; p = p.parent) {
      if (p.userData?.editorOnly) return;
    }
    hidden.push({ obj, prev: obj.visible });
    obj.visible = false;
  });
  return hidden;
}

function restoreHidden(hidden) {
  for (const { obj, prev } of hidden) obj.visible = prev;
}

function setupCameraPreview() {
  if (!engine.renderer || !viewport.canvas) return;
  if (viewport.cameraPreview) return;
  viewport.cameraPreview = new CameraPreview();

  engine.onPostRender(() => {
    viewport.cameraPreview?.renderFrame();
  });
}

/** (Re)creates the ground grid from editor settings. */
function rebuildGrid(editorSettings) {
  const helpers = viewport.helpers;
  if (!helpers) return;
  if (viewport.grid) {
    helpers.remove(viewport.grid);
    viewport.grid.geometry.dispose();
    viewport.grid.material.dispose();
    viewport.grid = null;
  }
  if (editorSettings.showGrid === false) return;
  viewport.grid = new THREE.GridHelper(
    editorSettings.gridSize ?? 40,
    editorSettings.gridDivisions ?? 40,
    0x4a5060,
    0x2c3038,
  );
  // Layers are not inherited. A grid rebuilt after initial viewport setup
  // must be moved explicitly or it remains on layer 0 and leaks into GI/depth
  // prepasses even though its parent helper group is editor-only.
  putOnEditorLayer(viewport.grid);
  helpers.add(viewport.grid);
  // New meshes inherit the layer-toggle visibility — the dropdown can hide
  // a freshly-rebuilt grid without another rebuild pass.
  viewport.grid.visible = viewport.layers.grid;
}

/**
 * Walks every entity in the scene and applies `visible` to the gizmo of its
 * physics-shape components (Collider + CharacterController). Both gizmos live
 * on EDITOR_LAYER and follow the same "Colliders" layer toggle so a
 * CharacterController entity — which owns its own capsule rather than a
 * separate Collider — respects the user's "show physics aids" preference
 * without needing its own menu entry. Components own the gizmo Object3D;
 * we only flip `visible` so toggling is instant and reversible.
 */
function setCollidersVisible(visible) {
  for (const entity of engine.entities.values()) {
    const collider = entity.getComponent?.("collider");
    if (collider?.gizmo) collider.gizmo.visible = visible;
    const character = entity.getComponent?.("charactercontroller");
    if (character?.gizmo) character.gizmo.visible = visible;
  }
}

/**
 * Apply all three Layers-toggle states at once. Used both at init
 * (to honor any default toggles) and after the dropdown flips one.
 * Gizmo + selectionBox live as singletons on `viewport.*`, so they're
 * controlled directly; colliders are per-component so we walk.
 */
function applyLayerVisibility() {
  const { gizmos, cursor3D, colliders, grid, virtualGeometry, debugDraw, uiOverlay } = viewport.layers;
  engine.uiSystem?.setOverlayPreview?.(uiOverlay === true);
  // Turned off at the SOURCE, not by hiding the mesh: a script drawing a
  // thousand shapes a frame should stop paying for them when you switch the
  // layer off, and this also stops them reaching the Game view's camera.
  engine.debug?.setEnabled(debugDraw !== false);
  const gizmoHelper = viewport.gizmo?.getHelper();
  // `viewport.gizmo.object` is null when nothing is attached (no selection,
  // UI-only entity, or a directional light which uses the dedicated sun-dial
  // helper instead). Hide the standard transform helper in those cases so a
  // detached gizmo doesn't keep showing stale arrows on screen.
  const gizmoAttached = !!viewport.gizmo?.object;
  if (gizmoHelper) gizmoHelper.visible = gizmos && !engine.playing && gizmoAttached;
  if (viewport.selectionBox) viewport.selectionBox.visible = gizmos && !engine.playing;
  if (viewport.grid) viewport.grid.visible = grid;
  setCollidersVisible(colliders);
  setVirtualGeometryDebugVisible(virtualGeometry && !engine.playing);
  // 3D cursor visibility also depends on the user's layer toggle. The
  // module's own `visible` flag stays the source of truth for the snap
  // menu helpers (which want to read "is the cursor visible right
  // now?"); this just toggles the proxy.
  setCursor3DVisible(cursor3D);
}

// Hydrate `viewport.layers` from project settings (settings.editor.layers)
// on every apply. Used at boot and when the user changes settings in the
// project settings panel. We only call `applyLayerVisibility` +
// `notifyLayersChanged` if the value actually differs, so a no-op apply
// (which happens after every `setLayerVisible` write) doesn't trigger
// React re-renders.
onProjectSettingsApplied((settings) => {
  const incoming = settings?.editor?.layers;
  if (!incoming) return;
  let next = viewport.layers;
  for (const { key } of LAYER_TOGGLES) {
    if (key in incoming && incoming[key] !== next[key]) {
      next = { ...next, [key]: !!incoming[key] };
    }
  }
  if (next === viewport.layers) return;
  viewport.layers = next;
  if (viewport.initPromise) {
    applyLayerVisibility();
    notifyLayersChanged();
  }
});

// Persist `viewport.layers` into project.json so the user's preferred
// view survives reloads / sessions. The project settings panel already
// uses `updateMeta` for similar "fire and forget" saves; we do the same
// here, fanning the write into the existing `settings.editor.layers`
// slot without going through `applyProjectSettings` (which would re-run
// every settings listener for what's really just a viewport state change).
function persistLayersNow() {
  // Lazy import — projectStore touches the Tauri bridge which only exists
  // in the built editor, and avoiding it during module init keeps tests
  // and pure-JS tooling happy.
  import("../store/projectStore.js")
    .then(({ useProjectStore }) => {
      const current = getProjectSettings();
      return useProjectStore.getState().updateMeta({
        settings: { ...current, editor: { ...current.editor, layers: { ...viewport.layers } } },
      });
    })
    .catch((err) => console.warn(`Couldn't persist layers to project.json: ${err}`));
}

/**
 * Single entry point the React toolbar uses to flip a layer toggle.
 * Mutates `viewport.layers`, makes the visible change take effect,
 * notifies subscribers, and persists the new state to project.json.
 */
export function setLayerVisible(key, visible) {
  if (!(key in viewport.layers)) return;
  if (viewport.layers[key] === visible) return;
  viewport.layers = { ...viewport.layers, [key]: visible };
  applyLayerVisibility();
  notifyLayersChanged();
  persistLayersNow();
}

/** Subscribe to layer-toggle changes. Returns an unsubscribe. */
export function subscribeLayers(fn) {
  viewport.layersListeners.add(fn);
  return () => viewport.layersListeners.delete(fn);
}

function setSnap(enabled) {
  const g = viewport.gizmo;
  const s = getProjectSettings().editor;
  g.setTranslationSnap(enabled ? s.snapTranslate : null);
  g.setRotationSnap(enabled ? THREE.MathUtils.degToRad(s.snapRotateDeg) : null);
  g.setScaleSnap(enabled ? s.snapScale : null);
}

/** True for entities whose transform is UI-layout-driven — the 3D gizmo,
 *  selection box and focus fly-to make no sense for them. */
function isUiEntity(entity) {
  return !!(entity?.getComponent?.("uielement") || entity?.getComponent?.("uiscreen"));
}

// Shared helpers reused by both the single- and multi-entity attach paths.
// resolveEntities filters the selection down to live, non-UI entities so the
// gizmo, selection box and helpers all see the same "what counts" predicate.
function resolveEntities(ids) {
  return ids.map((id) => engine.getEntity(id)).filter(Boolean);
}

// Average world position of the given entities. Used to position the multi-
// select pivot at the visual centroid of the selection so the gizmo arrows
// land at a sensible point.
function computeSelectionCentroid(entities) {
  if (!entities.length) return new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (const entity of entities) entity.object3D.getWorldPosition(centroid.add(new THREE.Vector3()));
  return centroid.divideScalar(entities.length);
}

// World-aligned union Box3 over the given entities. Returns an empty box
// when no entity has any geometry (the caller's fallback handles that).
function computeSelectionBounds(entities) {
  const bounds = new THREE.Box3();
  for (const entity of entities) bounds.expandByObject(entity.object3D);
  return bounds;
}

// Camera/light entities are skipped when building the multi-selection box
// — same reason the single-entity path skips them: their subtrees are the
// editor model mesh and a frustum helper, which bracket a useless silhouette.
function isBoxableEntity(entity) {
  const lightComponent = entity.getComponent?.("light");
  const cameraComponent = entity.getComponent?.("camera");
  return !cameraComponent?.camera && !lightComponent?.light;
}

function attachSelection(ids) {
  // Normalize: drop anything that's no longer in the engine and de-duplicate
  // so a stale double-click in the picker doesn't create twin entries.
  const unique = [...new Set(ids ?? [])];

  // Cursor-only selection: the cursor's hit-sphere produces the sentinel
  // CURSOR_SELECTION_ID on click. Route through the single-selection path
  // so the gizmo attaches to the cursor proxy and the user can grab+drag
  // it like any other scene-graph object. Entities are skipped — a
  // selection like ["__3dCursor__"] means "the cursor only".
  const hasCursor = unique.some(isCursorSelectionId);
  const entityIds = unique.filter((id) => !isCursorSelectionId(id));
  const entities = resolveEntities(entityIds);
  const entity = entities[0] ?? null;

  if (viewport.selectionBox) {
    engine.scene.remove(viewport.selectionBox);
    viewport.selectionBox.dispose();
    viewport.selectionBox = null;
  }
  detachCameraHelper();
  detachLightHelper();

  // UI entities get a 2D rect outline (drawn by the UiSystem overlay pass)
  // instead of the 3D gizmo + bounding box. setHighlight accepts a single
  // entity id, so for multi-UI selections we only highlight the first —
  // users can cycle through by Shift-clicking the hierarchy.
  const uiSystem = getUiSystem(engine, { create: false });
  if (uiSystem && !engine.playing && entities.length && entities.some(isUiEntity)) {
    uiSystem.setHighlight(entities.find(isUiEntity).id);
  } else {
    uiSystem?.setHighlight(null);
  }

  // Reset any leftover pivot drag state so a stale capture doesn't try to
  // write to entities that are no longer selected.
  viewport.pivotDrag = null;

  // The 3D transform gizmo doesn't make sense for entities whose layout is
  // UI-driven (uielement / uiscreen). Detach whenever ANY selected entity
  // is a UI entity — matching the single-entity rule (where a UI entity
  // alone hides the gizmo) and extending it to mixed selections.
  const skipGizmo = engine.playing || (!hasCursor && (!entities.length || entities.some(isUiEntity)));
  if (skipGizmo) {
    viewport.gizmo.detach();
    viewport.cameraPreview?.setCamera(null);
    applyLayerVisibility();
    return;
  }

  // A selected spline knot outranks the entity: while you are editing a path,
  // the thing the arrows should move is the control point under them, not the
  // whole road. Leaving edit mode (or deselecting the knot) hands it straight
  // back, because this is re-evaluated on every selection change.
  const splineEdit = getSplineEdit();
  if (splineEdit.armed && splineEdit.selection && activeSpline()) {
    const proxy = splineHandleProxy();
    proxy.updateMatrixWorld(true);
    viewport.gizmo.attach(proxy);
    viewport.gizmo.getHelper().updateMatrixWorld(true);
    viewport.cameraPreview?.setCamera(null);
    applyLayerVisibility();
    return;
  }

  if (hasCursor && entities.length === 0) {
    attachCursorSelection();
  } else if (entities.length === 1) {
    attachSingleSelection(entity);
  } else if (entities.length > 1) {
    attachMultiSelection(entities);
  } else {
    // Cursor was selected together with at least one entity — show the
    // entity gizmo (the multi-select path handles pivot positioning); the
    // cursor is otherwise just a hover target. This keeps the gizmo's
    // "attach a single Object3D" contract simple.
    attachSingleSelection(entity);
  }
  applyLayerVisibility();
}

// Single-entity gizmo + helpers path. Unchanged from the original behavior
// — extracted verbatim so attachSelection stays readable.
function attachSingleSelection(entity) {
  const lightComponent = entity.getComponent?.("light");
  const cameraComponent = entity.getComponent?.("camera");
  // Directional lights are infinite sources — they have no meaningful
  // position/scale, only a rotation. The dedicated DirectionalLightGizmo
  // (compact sun-dial helper) already visualises the emitted direction, so
  // the standard transform gizmo would just duplicate that visual without
  // adding any useful handle. Skip attaching it entirely and detach any
  // previous gizmo so the helper isn't left dangling on a stale object.
  const isDirectionalLight = lightComponent?.props?.kind === "directional";
  if (isDirectionalLight) {
    viewport.gizmo.detach();
  } else {
    // Make sure the entity's matrixWorld is current before we attach.
    // Without this, the very first frame after selection would show the
    // gizmo arrows at the entity's OLD world position (wherever it was on
    // the previous render), and any pointermove fired before the next
    // render would raycast against that stale position — making the gizmo
    // look broken for one frame after every selection change.
    entity.object3D.updateMatrixWorld(true);
    viewport.gizmo.attach(entity.object3D);
    viewport.gizmo.getHelper().updateMatrixWorld(true);
  }
  // Cameras skip the bounding-box outline: the entity itself is a single
  // Object3D whose only children are the PerspectiveCamera and the
  // editor-only model mesh, so a Box3 over the subtree just brackets the
  // lens/body silhouette and clutters the view. The frustum helper
  // (attached below) already shows the camera's position + facing, which
  // is the visual cue users actually want for a camera entity.
  if (!cameraComponent?.camera && !lightComponent?.light) {
    const bounds = new THREE.Box3().setFromObject(entity.object3D);
    if (!bounds.isEmpty()) {
      viewport.selectionBox = new THREE.BoxHelper(entity.object3D, 0x4da3ff);
      viewport.selectionBox.userData.editorOnly = true;
      // Tag with the entity id so clicking the selection box (which is
      // editor-only and short-circuits findEntityId by default) still
      // resolves to the selected entity.
      viewport.selectionBox.userData.entityId = entity.id;
      putOnEditorLayer(viewport.selectionBox);
      engine.scene.add(viewport.selectionBox);
    }
  }
  if (cameraComponent?.camera) {
    attachCameraHelper(cameraComponent.camera);
    // Honor the camera component's own preview toggle: even with the
    // camera selected, the user can suppress the PIP via the inspector
    // checkbox. setCamera below still hands the camera to the preview
    // (so re-enabling is a single click), but updateVisible() reads
    // the component's showPreview flag.
    viewport.cameraPreview?.setCamera(cameraComponent.camera, cameraComponent);
  } else {
    viewport.cameraPreview?.setCamera(null);
  }
  if (lightComponent?.light) {
    attachLightHelper(lightComponent);
  }
}

/** Single-target selection where the target is the 3D cursor proxy. The
 *  gizmo is attached to the proxy group so dragging the handles translates
 *  the cursor in world space; the dragging-changed/objectChange handlers
 *  in setupGizmo route the new position into cursor state and emit a
 *  SetCursor3DCommand for undo. There is no bounding box, light/camera
 *  helper, or camera preview to manage — the cursor is its own visible
 *  representation and lives entirely on the editor layer. */
function attachCursorSelection() {
  const cursor = getCursor3DObject();
  if (!cursor) return;
  cursor.updateMatrixWorld(true);
  viewport.gizmo.attach(cursor);
  viewport.gizmo.getHelper().updateMatrixWorld(true);
  viewport.cameraPreview?.setCamera(null);
}

// Multi-entity attach: drive TransformControls from a temporary pivot Group
// positioned at the selection centroid. The actual transform application
// happens lazily during the drag (see applyPivotDelta / commitPivotDrag).
function attachMultiSelection(entities) {
  // Filter out non-boxable entities (cameras/lights) for the union bounds
  // visualization — they would only bracket the editor preview mesh. They
  // still receive the gizmo transform; only the outline is suppressed.
  const boxable = entities.filter(isBoxableEntity);

  // Camera helpers / PIP are single-entity affordances — hide them when
  // the selection spans more than one entity so the screen doesn't pile up
  // overlapping frustums.
  viewport.cameraPreview?.setCamera(null);

  // Position the pivot at the visual centroid and reset its transform to
  // identity rotation / unit scale. The drag-time world delta is computed
  // against this start pose, so a fresh attach mid-drag would otherwise
  // inherit stale pivot state.
  const pivot = viewport.pivot;
  pivot.position.copy(computeSelectionCentroid(entities));
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  pivot.updateMatrixWorld(true);

  viewport.gizmo.attach(pivot);
  viewport.gizmo.getHelper().updateMatrixWorld(true);

  if (boxable.length) {
    const bounds = computeSelectionBounds(boxable);
    if (!bounds.isEmpty()) {
      viewport.selectionBox = new THREE.Box3Helper(bounds, 0x4da3ff);
      viewport.selectionBox.userData.editorOnly = true;
      // Tag with the first entity id so a click on the outline (which is
      // editor-only and short-circuits findEntityId by default) still
      // resolves to a real selection.
      viewport.selectionBox.userData.entityId = boxable[0].id;
      putOnEditorLayer(viewport.selectionBox);
      engine.scene.add(viewport.selectionBox);
    }
  }
}

// ---- Multi-select pivot drag ----------------------------------------------
//
// Capture the per-entity world transform at drag start. We snapshot world
// space (not local) because the gizmo itself operates in world space and
// three.js doesn't preserve object-local deltas for non-identity parent
// transforms. The `parentWorldInverse` matrix is cached so we can convert
// each new world pose back into local space when writing to object3D.
function snapshotPivotOrigins(ids) {
  const origins = [];
  for (const id of ids) {
    const entity = engine.getEntity(id);
    if (!entity) continue;
    entity.object3D.updateMatrixWorld(true);
    // The three.js parent of entity.object3D is what we use for the
    // world→local conversion in applyPivotDrag. Root entities live under
    // engine.scene directly (set by Entity.setParent), so this is always
    // a valid Object3D — never null. Storing entity.parent (the Entity
    // parent, which IS null for roots) would break the world→local math.
    const parentObj = entity.object3D.parent;
    origins.push({
      id,
      object3D: entity.object3D,
      // World-space baseline for the per-frame fan-out math.
      worldPos: entity.object3D.getWorldPosition(new THREE.Vector3()),
      worldQuat: entity.object3D.getWorldQuaternion(new THREE.Quaternion()),
      worldScale: entity.object3D.getWorldScale(new THREE.Vector3()),
      parent: parentObj,
      // Local-space baseline for the undo command — the fan-out math
      // mutates object3D in place, so we have to remember what the local
      // transform was at drag start to emit a correct SetTransformCommand.
      local: {
        position: [entity.object3D.position.x, entity.object3D.position.y, entity.object3D.position.z],
        rotation: [entity.object3D.rotation.x, entity.object3D.rotation.y, entity.object3D.rotation.z],
        scale: [entity.object3D.scale.x, entity.object3D.scale.y, entity.object3D.scale.z],
      },
    });
  }
  return origins;
}

function beginPivotDrag() {
  const ids = useSelectionStore.getState().ids;
  const pivot = viewport.pivot;
  // Reset pivot pose to identity (rotation 0, scale 1) at the centroid so
  // the deltas captured during the drag are clean. attachMultiSelection
  // already positioned pivot.position at the centroid on attach.
  pivot.updateMatrixWorld(true);
  viewport.pivotDrag = {
    origins: snapshotPivotOrigins(ids),
    // Pivot pose at drag start — kept constant for the whole drag so the
    // cumulative delta (current - start) can be applied to each origin's
    // snapshot pose every frame. Mutating this mid-drag would yield
    // incremental deltas, which would not be cumulative across frames.
    start: {
      position: pivot.position.clone(),
      quaternion: pivot.quaternion.clone(),
      scale: pivot.scale.clone(),
    },
  };
}

// Reused per-frame scratch values for the fan-out math. Allocating them
// here keeps the drag loop allocation-free.
const _pivotPosDelta = new THREE.Vector3();
const _pivotQuatDelta = new THREE.Quaternion();
const _pivotScaleDelta = new THREE.Vector3();
const _pivotInvStartQuat = new THREE.Quaternion();
const _pivotStartOffset = new THREE.Vector3();
const _pivotLocalOffset = new THREE.Vector3();
const _pivotNewWorldPos = new THREE.Vector3();
const _pivotNewWorldQuat = new THREE.Quaternion();
const _pivotNewWorldScale = new THREE.Vector3();
const _pivotParentWorldInverse = new THREE.Matrix4();
const _pivotLocalMatrix = new THREE.Matrix4();
const _pivotDecomposed = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };

function applyPivotDrag() {
  const drag = viewport.pivotDrag;
  if (!drag) return;
  const pivot = viewport.pivot;

  // Cumulative world-space delta of the pivot since the drag started. The
  // gizmo gives us absolute pivot state on every objectChange; we derive
  // the cumulative delta against `drag.start` (which is held constant
  // throughout the drag) and apply it to each origin's snapshot pose.
  // Mutating drag.start mid-drag would shrink the per-frame delta to
  // just-the-last-frame's motion, snapping entities back to where they
  // were after the first frame.
  _pivotPosDelta.subVectors(pivot.position, drag.start.position);
  _pivotInvStartQuat.copy(drag.start.quaternion).invert();
  _pivotQuatDelta.copy(pivot.quaternion).multiply(_pivotInvStartQuat);
  _pivotScaleDelta.set(
    drag.start.scale.x !== 0 ? pivot.scale.x / drag.start.scale.x : 1,
    drag.start.scale.y !== 0 ? pivot.scale.y / drag.start.scale.y : 1,
    drag.start.scale.z !== 0 ? pivot.scale.z / drag.start.scale.z : 1,
  );

  for (const origin of drag.origins) {
    // Decide the world→local branch on origin.parent (the three.js parent
    // captured at drag start), not origin.object3D.parent. For root
    // entities origin.parent is engine.scene (identity world matrix), so
    // world pose == local pose and we can skip the matrix decompose.
    const parent = origin.parent;
    const isRoot = parent === engine.scene || !parent;
    if (isRoot) {
      // Root entity (or stale parent ref) — world space == local space,
      // write straight to the Object3D.
      origin.object3D.position.copy(origin.worldPos).add(_pivotPosDelta);
      _pivotNewWorldQuat.copy(_pivotQuatDelta).multiply(origin.worldQuat);
      origin.object3D.quaternion.copy(_pivotNewWorldQuat);
      origin.object3D.scale.set(
        origin.worldScale.x * _pivotScaleDelta.x,
        origin.worldScale.y * _pivotScaleDelta.y,
        origin.worldScale.z * _pivotScaleDelta.z,
      );
    } else {
      // Child of a transformed parent: convert the new world pose back
      // into local space using the parent's inverse world matrix.
      _pivotParentWorldInverse.copy(parent.matrixWorld).invert();
      // Rotate the snapshot's offset around the new pivot rotation, then
      // translate by the pivot's translation. The pivot is parented to
      // engine.scene (identity world matrix), so its world and local
      // transforms coincide — we can read its position/quaternion directly
      // for the math here.
      _pivotStartOffset.copy(origin.worldPos).sub(drag.start.position);
      _pivotLocalOffset.copy(_pivotStartOffset).applyQuaternion(_pivotQuatDelta);
      _pivotNewWorldPos.copy(drag.start.position).add(_pivotLocalOffset).add(_pivotPosDelta);
      _pivotNewWorldQuat.copy(_pivotQuatDelta).multiply(origin.worldQuat);
      _pivotNewWorldScale.set(
        origin.worldScale.x * _pivotScaleDelta.x,
        origin.worldScale.y * _pivotScaleDelta.y,
        origin.worldScale.z * _pivotScaleDelta.z,
      );
      _pivotLocalMatrix.compose(_pivotNewWorldPos, _pivotNewWorldQuat, _pivotNewWorldScale);
      _pivotLocalMatrix.premultiply(_pivotParentWorldInverse);
      _pivotLocalMatrix.decompose(_pivotDecomposed.position, _pivotDecomposed.quaternion, _pivotDecomposed.scale);
      origin.object3D.position.copy(_pivotDecomposed.position);
      origin.object3D.quaternion.copy(_pivotDecomposed.quaternion);
      origin.object3D.scale.copy(_pivotDecomposed.scale);
    }
    useSceneStore.getState().updateTransform(origin.id);
  }
  // Refresh the Box3 helper so it tracks the moving selection.
  if (viewport.selectionBox && viewport.selectionBox.type === "Box3Helper") {
    const entities = drag.origins
      .map((o) => engine.getEntity(o.id))
      .filter((e) => e && isBoxableEntity(e));
    if (entities.length) {
      const bounds = computeSelectionBounds(entities);
      if (!bounds.isEmpty()) {
        viewport.selectionBox.box.copy(bounds);
        viewport.selectionBox.updateMatrixWorld(true);
      }
    }
  }
  // NOTE: drag.start is *not* advanced each frame. It holds the pivot's
  // pose at drag start so the delta we apply is cumulative across frames.
  // Mutating it would shrink each frame's delta to the per-frame motion,
  // snapping entities back to where they were after the first frame.
}

// Build one SetTransformCommand per non-ancestor entity and emit as a
// single BatchCommand so the whole multi-drag is one undoable.
function commitPivotDrag() {
  const drag = viewport.pivotDrag;
  if (!drag) return;
  const ids = drag.origins.map((o) => o.id);
  // Collapse parent/child selections so a descendant isn't transformed
  // twice (once as a child of a moved parent, once on its own).
  const targets = topMostIds(ids);
  const cmds = [];
  let primaryLabel = "Move entities";
  for (const id of targets) {
    const entity = engine.getEntity(id);
    if (!entity) continue;
    const origin = drag.origins.find((o) => o.id === id);
    if (!origin) continue;
    const before = origin.local;
    const after = entity.getTransform();
    if (
      before.position[0] === after.position[0] && before.position[1] === after.position[1] && before.position[2] === after.position[2] &&
      before.rotation[0] === after.rotation[0] && before.rotation[1] === after.rotation[1] && before.rotation[2] === after.rotation[2] &&
      before.scale[0] === after.scale[0] && before.scale[1] === after.scale[1] && before.scale[2] === after.scale[2]
    ) {
      continue; // No-op: the user dragged but didn't actually move anything.
    }
    cmds.push(new SetTransformCommand(id, after, before));
    if (cmds.length === 1) primaryLabel = `Move ${entity.name}`;
  }
  viewport.pivotDrag = null;
  // Reset the pivot to identity so a fresh attach starts from a clean pose.
  const pivot = viewport.pivot;
  pivot.position.set(0, 0, 0);
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  if (cmds.length === 1) commandBus.execute(cmds[0]);
  else if (cmds.length > 1) commandBus.execute(new BatchCommand(cmds, primaryLabel));
  // Re-attach so the gizmo helper's matrixWorld and any pending helpers
  // pick up the new entity transforms (the world delta has been applied
  // to every object3D, but the gizmo's own matrix is stale otherwise).
  attachSelection(useSelectionStore.getState().ids);
}

/** Adds a CameraHelper (frustum lines) for the given three.js camera. */
function attachCameraHelper(camera) {
  detachCameraHelper();
  const helper = new THREE.CameraHelper(camera);
  helper.userData.editorOnly = true;
  putOnEditorLayer(helper);
  // Recolor the frustum to match the selection blue so it doesn't fight
  // with the editor's neutral helpers (grid, BoxHelper).
  helper.setColors(0x4da3ff, 0x4da3ff, 0x4da3ff, 0x4da3ff, 0x4da3ff);
  helper.update();
  engine.scene.add(helper);
  viewport.cameraHelper = helper;
}

function detachCameraHelper() {
  if (!viewport.cameraHelper) return;
  engine.scene.remove(viewport.cameraHelper);
  viewport.cameraHelper.dispose();
  viewport.cameraHelper = null;
}

/**
 * Builds the editor-only visualization for the currently selected light
 * entity. The shape depends on the light's kind, matching what three.js's
 * built-in helpers were designed for:
 *
 *   - directional -> compact hemisphere + direction arrow
 *   - spot        -> SpotLightHelper        (cone)
 *   - point       -> PointLightHelper       (small wireframe sphere)
 *   - ambient     -> no helper (no spatial meaning)
 *
 * The helper is parented to `engine.scene` (not the entity) because the
 * underlying three.js helpers reach up to the *light's* matrixWorld when
 * `update()` runs; an extra indirection through the entity would just
 * duplicate the same transform without buying anything. Tagging
 * `userData.entityId` lets `findEntityId` resolve a click on the helper
 * back to the owning entity so users can re-select it.
 */
function attachLightHelper(lightComponent) {
  detachLightHelper();
  const light = lightComponent.light;
  if (!light) return;
  const kind = lightComponent.props.kind;
  let helper = null;
  if (kind === "directional" && light.isDirectionalLight) {
    helper = new DirectionalLightGizmo(lightComponent.entity, 1);
  } else if (kind === "spot" && light.isSpotLight) {
    helper = new THREE.SpotLightHelper(light, 5);
  } else if (kind === "point" && light.isPointLight) {
    helper = new THREE.PointLightHelper(light, 0.3);
  }
  if (!helper) return;
  helper.userData.editorOnly = true;
  helper.userData.entityId = lightComponent.entity.id;
  helper.update();
  putOnEditorLayer(helper);
  engine.scene.add(helper);
  viewport.lightHelper = helper;
}

function detachLightHelper() {
  if (!viewport.lightHelper) return;
  engine.scene.remove(viewport.lightHelper);
  viewport.lightHelper.dispose?.();
  viewport.lightHelper = null;
}

// How close (in pixels) a click has to land to a line/point helper to count
// as a hit on it. three's default Line threshold is 1 *world* unit, which
// wraps the selection outline in an invisible slab a metre thick around the
// object's bounding box — at normal scene scale that slab swallows clicks
// meant for whatever sits behind or inside the box, which is why picking felt
// like it was aiming at bounding boxes instead of geometry.
const LINE_PICK_PX = 5;

/** True when `object` and every ancestor is visible. three's raycaster
 *  dropped its `visible` check years ago, so hidden entities stay clickable
 *  unless we filter them here. */
function isPickVisible(object) {
  for (let node = object; node; node = node.parent) {
    if (node.visible === false) return false;
  }
  return true;
}

/** Solid geometry beats wireframe helpers regardless of depth. The selection
 *  outline is a LineSegments cage sitting on the *outside* of the object it
 *  brackets, so by distance it always beats the mesh it belongs to — letting
 *  it win on distance alone makes an already-selected object impossible to
 *  click through to anything inside or behind it. */
function isSolidPick(object) {
  return !object.isLine && !object.isPoints;
}

function setupPicking(canvas) {
  const raycaster = new THREE.Raycaster();
  // Pick against every layer so the camera model (EDITOR_LAYER), gizmo
  // helpers, etc. are still selectable — they only differ from the rest
  // of the scene by which camera renders them, not by whether clicks land
  // on them.
  raycaster.layers.enableAll();
  const pointer = new THREE.Vector2();
  let downPos = null;

  // Keep the last cursor position on hand for the G/R/S macros, which anchor
  // their drag where the cursor was when the key was pressed. Re-adding the
  // same function reference on remount is a no-op, so this never stacks up.
  window.addEventListener("pointermove", trackCursor, true);

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && !getTerrainBrushMode()) downPos = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !downPos || viewport.terrainBrushing) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 4 || viewport.gizmo.dragging || engine.playing) return;

    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, viewport.camera);
    // Re-derive the line/point pick radius in world units each click so it
    // stays a constant handful of pixels no matter how far the camera is.
    const wpp = worldPerPixelAt(
      viewport.orbit?.target ?? viewport.camera.position,
      rect,
      viewport.camera,
    );
    raycaster.params.Line.threshold = wpp * LINE_PICK_PX;
    raycaster.params.Points.threshold = wpp * LINE_PICK_PX;

    const hits = raycaster.intersectObjects(engine.scene.children, true);
    // Nearest solid hit wins; a helper-line hit is only a fallback for when
    // nothing solid was under the cursor (clicking the bare selection cage of
    // an object whose geometry you missed still re-selects it).
    let entityId = null;
    let lineFallbackId = null;
    for (const hit of hits) {
      if (!isPickVisible(hit.object)) continue;
      const id = findEntityId(hit.object);
      if (!id) continue;
      if (isSolidPick(hit.object)) {
        entityId = id;
        break;
      }
      lineFallbackId ??= id;
    }
    entityId ??= lineFallbackId;

    // UI elements are not raycast targets (their meshes live at pixel-scale
    // coordinates and would swamp normal picking), so they are picked through
    // the UI system's own rect test — but only after the 3D pick has come up
    // empty. A UI screen shown as a plane in the world would otherwise swallow
    // every click on whatever sits behind it, which is the opposite of the
    // reason it is a plane at all.
    if (!entityId) {
      const uiSystem = getUiSystem(engine, { create: false });
      const uiHit = uiSystem?.hitTest?.(e.clientX, e.clientY, { interactiveOnly: false });
      if (uiHit?.entity) entityId = uiHit.entity.id;
    }

    if (!entityId) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) useSelectionStore.getState().clear();
      return;
    }

    const selection = useSelectionStore.getState();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd: toggle this entity in/out of the current selection.
      selection.toggle(entityId);
    } else if (e.shiftKey && selection.anchorId) {
      // Shift: extend the selection from the anchor to this entity
      // along the depth-first engine tree (same ordering the
      // HierarchyPanel uses). Falls back to a plain select if either
      // end isn't in the live tree (entity got deleted mid-drag).
      const order = flattenEngineTree();
      const a = order.indexOf(selection.anchorId);
      const b = order.indexOf(entityId);
      if (a !== -1 && b !== -1) {
        selection.select(order.slice(Math.min(a, b), Math.max(a, b) + 1), selection.anchorId);
      } else {
        selection.select(entityId);
      }
    } else {
      selection.select(entityId);
    }
  });
}

const BRUSH_INDICATOR_SEGMENTS = 64;
const BRUSH_PREVIEW_RINGS = 6;
const SCULPT_TOOL_COLORS = {
  raise: 0x4caf50,
  lower: 0xff5252,
  smooth: 0x29b6f6,
  flatten: 0xab47bc,
  sharpen: 0xffa726,
  erode: 0x8d6e63,
  noise: 0x26c6da,
};
const PAINT_COLOR = 0xffca28;
const ERASE_COLOR = 0xff5252;
const SCATTER_COLOR = 0x80ff72;

/**
 * Lazily builds the terrain brush cursor: a translucent filled disc plus a
 * bright rim ring, both projected onto the live terrain surface so they read
 * on slopes. Editor-only layer, never raycast-picked, drawn on top
 * (depthTest off + high renderOrder) so it's always visible.
 */
function ensureBrushIndicator() {
  if (viewport.terrainBrushIndicator) return viewport.terrainBrushIndicator;
  const N = BRUSH_INDICATOR_SEGMENTS;

  // Concentric rings let the fill show the predicted post-stroke surface.
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((1 + BRUSH_PREVIEW_RINGS * N) * 3), 3));
  const fillIndex = [];
  for (let i = 0; i < N; i++) fillIndex.push(0, 1 + i, 1 + ((i + 1) % N));
  for (let ring = 1; ring < BRUSH_PREVIEW_RINGS; ring++) {
    const inner = 1 + (ring - 1) * N;
    const outer = 1 + ring * N;
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      fillIndex.push(inner + i, outer + i, outer + next, inner + i, outer + next, inner + next);
    }
  }
  fillGeo.setIndex(fillIndex);
  const fill = new THREE.Mesh(
    fillGeo,
    new THREE.MeshBasicMaterial({
      color: PAINT_COLOR, transparent: true, opacity: 0.15,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }),
  );

  // Rim: an explicitly closed line. WebGPURenderer does not support
  // THREE.LineLoop, so vertex N duplicates vertex 0.
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  const rim = new THREE.Line(
    rimGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  // Core: a second line loop at the falloff's half-strength radius, so the
  // gap between the two rings reads the brush hardness (soft = wide gap,
  // hard = tight inner ring hugging the rim) — the Unity/Unreal brush cursor.
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  const core = new THREE.Line(
    coreGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.6, depthTest: false }),
  );

  // Predicted contour rings and current→predicted displacement ticks make
  // small sculpt deltas legible even when the translucent surface nearly
  // overlaps the terrain.
  const outcomeGeo = new THREE.BufferGeometry();
  outcomeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BRUSH_PREVIEW_RINGS * N * 2 * 3), 3));
  const outcome = new THREE.LineSegments(
    outcomeGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.65, depthTest: false }),
  );
  const deltaSampleCount = 1 + BRUSH_PREVIEW_RINGS * 8;
  const deltaGeo = new THREE.BufferGeometry();
  deltaGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(deltaSampleCount * 2 * 3), 3));
  const delta = new THREE.LineSegments(
    deltaGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  const group = new THREE.Group();
  const scatter = new THREE.Group();
  group.add(fill, outcome, delta, rim, core, scatter);
  group.visible = false;
  group.renderOrder = 999;
  group.userData.editorOnly = true;
  for (const o of [group, fill, outcome, delta, rim, core, scatter]) {
    o.layers.set(EDITOR_LAYER);
    o.raycast = () => {};
  }
  engine.scene.add(group);
  viewport.terrainBrushIndicator = {
    group, fill, outcome, delta, rim, core, scatter,
    fillGeo, outcomeGeo, deltaGeo, rimGeo, coreGeo, scatterKey: "",
  };
  return viewport.terrainBrushIndicator;
}

/**
 * Re-projects the cursor onto the current terrain surface at `local`
 * (entity-local XZ), sampling live heights so it hugs mid-stroke deformation.
 *
 * Two cues read the brush parameters the way Unity/Unreal's do:
 *   - fill opacity scales with `strength` (0.06 → 0.4) so a stronger brush
 *     visibly "fills in" more solidly;
 *   - the inner core ring sits at the falloff's half-strength radius, derived
 *     from `hardness` (exp = lerp(0.4, 4, hardness), matching applyHeightBrush):
 *     r½ = radius · (1 − 0.5^(1/exp)). A soft brush pushes the ring inward
 *     (wide gradient band); a hard brush pulls it out toward the rim.
 */
function updateBrushIndicator(component, local, radius, color, strength = 0.5, hardness = 0.5, preview = null) {
  const ind = ensureBrushIndicator();
  const N = BRUSH_INDICATOR_SEGMENTS;
  ind.fill.material.color.setHex(color);
  ind.outcome.material.color.setHex(color);
  ind.delta.material.color.setHex(color);
  ind.rim.material.color.setHex(color);
  ind.core.material.color.setHex(color);
  ind.fill.material.opacity = THREE.MathUtils.lerp(0.06, 0.4, THREE.MathUtils.clamp(strength, 0, 1));
  ind.fill.visible = false;

  const exp = THREE.MathUtils.lerp(0.4, 4, THREE.MathUtils.clamp(hardness, 0, 1));
  const coreRadius = radius * (1 - Math.pow(0.5, 1 / exp));

  const fillPos = ind.fillGeo.attributes.position;
  const rimPos = ind.rimGeo.attributes.position;
  const corePos = ind.coreGeo.attributes.position;
  const outcomePos = ind.outcomeGeo.attributes.position;
  const deltaPos = ind.deltaGeo.attributes.position;
  const v = new THREE.Vector3();
  const previewHeight = (x, z) => preview?.mode === "sculpt"
    ? component.previewHeightAtLocal(x, z, local, preview)
    : component.heightAtLocal(x, z);

  // Fill center.
  v.set(local.x, previewHeight(local.x, local.z) + 0.04, local.z);
  component.mesh.localToWorld(v);
  fillPos.setXYZ(0, v.x, v.y, v.z);

  for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
    const ringRadius = radius * ((ring + 1) / BRUSH_PREVIEW_RINGS);
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const lx = local.x + Math.cos(angle) * ringRadius;
      const lz = local.z + Math.sin(angle) * ringRadius;
      v.set(lx, previewHeight(lx, lz) + 0.04, lz);
      component.mesh.localToWorld(v);
      fillPos.setXYZ(1 + ring * N + i, v.x, v.y, v.z);
      if (ring === BRUSH_PREVIEW_RINGS - 1) rimPos.setXYZ(i, v.x, v.y, v.z);
    }
  }

  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);

    // Core ring — same angle, half-strength radius, hugging the surface.
    const cx = local.x + ca * coreRadius;
    const cz = local.z + sa * coreRadius;
    v.set(cx, previewHeight(cx, cz) + 0.045, cz);
    component.mesh.localToWorld(v);
    corePos.setXYZ(i, v.x, v.y, v.z);
  }
  // Close both polylines explicitly for WebGPU.
  rimPos.setXYZ(N, rimPos.getX(0), rimPos.getY(0), rimPos.getZ(0));
  corePos.setXYZ(N, corePos.getX(0), corePos.getY(0), corePos.getZ(0));

  const sculpting = preview?.mode === "sculpt";
  ind.outcome.visible = sculpting;
  ind.delta.visible = sculpting;
  if (sculpting) {
    let outcomeVertex = 0;
    for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
      for (let i = 0; i < N; i++) {
        const a = 1 + ring * N + i;
        const b = 1 + ring * N + ((i + 1) % N);
        outcomePos.setXYZ(outcomeVertex++, fillPos.getX(a), fillPos.getY(a) + 0.012, fillPos.getZ(a));
        outcomePos.setXYZ(outcomeVertex++, fillPos.getX(b), fillPos.getY(b) + 0.012, fillPos.getZ(b));
      }
    }
    let deltaVertex = 0;
    const writeDelta = (lx, lz, predictedIndex) => {
      v.set(lx, component.heightAtLocal(lx, lz) + 0.025, lz);
      component.mesh.localToWorld(v);
      deltaPos.setXYZ(deltaVertex++, v.x, v.y, v.z);
      deltaPos.setXYZ(
        deltaVertex++,
        fillPos.getX(predictedIndex),
        fillPos.getY(predictedIndex) + 0.025,
        fillPos.getZ(predictedIndex),
      );
    };
    writeDelta(local.x, local.z, 0);
    for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
      const ringRadius = radius * ((ring + 1) / BRUSH_PREVIEW_RINGS);
      for (let sample = 0; sample < 8; sample++) {
        const i = sample * (N / 8);
        const angle = (i / N) * Math.PI * 2;
        writeDelta(
          local.x + Math.cos(angle) * ringRadius,
          local.z + Math.sin(angle) * ringRadius,
          1 + ring * N + i,
        );
      }
    }
    outcomePos.needsUpdate = true;
    deltaPos.needsUpdate = true;
    ind.outcomeGeo.computeBoundingSphere();
    ind.deltaGeo.computeBoundingSphere();
  }
  fillPos.needsUpdate = true;
  rimPos.needsUpdate = true;
  corePos.needsUpdate = true;
  ind.fillGeo.computeBoundingSphere();
  ind.rimGeo.computeBoundingSphere();
  ind.coreGeo.computeBoundingSphere();
  ind.group.visible = true;
}

function updateScatterSilhouette(component, local, settings, erase, seed) {
  const ind = ensureBrushIndicator();
  const layerIndex = Math.min(settings.activeScatterLayer, Math.max(0, (component.props.scatterLayers?.length ?? 1) - 1));
  const sources = component.getScatterPreviewSources(layerIndex);
  const sourceKey = `${layerIndex}:${sources.map((source) => source.geometry.uuid).join(",")}`;
  if (ind.scatterKey !== sourceKey) {
    for (const child of ind.scatter.children) {
      child.material?.dispose?.();
      if (child.userData.ownedPreviewGeometry) child.geometry?.dispose?.();
    }
    ind.scatter.clear();
    const previewSources = sources.length ? sources : [{
      geometry: new THREE.ConeGeometry(0.32, 1, 7).translate(0, 0.5, 0),
      sourceMatrix: new THREE.Matrix4(),
      fallback: true,
    }];
    for (const source of previewSources) {
      const material = new THREE.MeshBasicMaterial({
        color: erase ? ERASE_COLOR : 0x80ff72,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.InstancedMesh(source.geometry, material, 64);
      mesh.count = 0;
      mesh.raycast = () => {};
      mesh.layers.set(EDITOR_LAYER);
      mesh.renderOrder = 1000;
      mesh.userData.previewSource = source;
      mesh.userData.ownedPreviewGeometry = !!source.fallback;
      ind.scatter.add(mesh);
    }
    ind.scatterKey = sourceKey;
  }
  const all = erase
    ? component.getScatterInstances(layerIndex).filter((item) => {
        const p = item.position;
        const effectiveRadius = settings.radius * THREE.MathUtils.lerp(0.25, 1, settings.strength);
        return p && Math.hypot(p[0] - local.x, p[2] - local.z) <= effectiveRadius;
      }).slice(0, 64)
    : component.getScatterPreviewPlacements(local, {
        layerIndex,
        radius: settings.radius,
        strength: settings.strength,
        spacing: settings.scatterSpacing,
        jitter: settings.scatterJitter,
        seed,
      });
  // Placement (rotation/scale/offset) is resolved by the component from the
  // layer's settings — the preview must not compose its own, or it would stop
  // matching what the brush actually paints the moment those settings change.
  const placement = new THREE.Matrix4();
  const localMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  component.entity.object3D.updateMatrixWorld(true);
  for (const mesh of ind.scatter.children) {
    mesh.material.color.setHex(erase ? ERASE_COLOR : 0x80ff72);
    mesh.count = Math.min(64, all.length);
    const source = mesh.userData.previewSource;
    for (let i = 0; i < mesh.count; i++) {
      component.scatterPlacementMatrix(layerIndex, all[i], placement, 0.03);
      localMatrix.multiplyMatrices(placement, source.sourceMatrix);
      worldMatrix.multiplyMatrices(component.entity.object3D.matrixWorld, localMatrix);
      mesh.setMatrixAt(i, worldMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  ind.scatter.visible = true;
}

function hideScatterSilhouette() {
  if (viewport.terrainBrushIndicator?.scatter) viewport.terrainBrushIndicator.scatter.visible = false;
}

function hideBrushIndicator() {
  if (viewport.terrainBrushIndicator) viewport.terrainBrushIndicator.group.visible = false;
}

function ensureBrushAdjustOverlay(canvas) {
  let overlay = viewport.terrainBrushAdjustOverlay;
  const host = canvas.parentElement;
  if (!host) return null;
  if (overlay?.isConnected && overlay.parentElement === host) return overlay;
  overlay = document.createElement("div");
  overlay.className = "terrain-brush-adjust-overlay";
  overlay.innerHTML = '<div class="terrain-brush-adjust-ring"></div><div class="terrain-brush-adjust-dot"></div><div class="terrain-brush-adjust-label"></div>';
  host.appendChild(overlay);
  viewport.terrainBrushAdjustOverlay = overlay;
  return overlay;
}

function showBrushAdjustOverlay(canvas, gesture, radiusPx, value) {
  const overlay = ensureBrushAdjustOverlay(canvas);
  if (!overlay) return;
  const hostRect = overlay.parentElement.getBoundingClientRect();
  const x = gesture.centerX - hostRect.left;
  const y = gesture.centerY - hostRect.top;
  const ring = overlay.querySelector(".terrain-brush-adjust-ring");
  const dot = overlay.querySelector(".terrain-brush-adjust-dot");
  const label = overlay.querySelector(".terrain-brush-adjust-label");
  const diameter = Math.max(2, radiusPx * 2);
  ring.style.cssText = `left:${x - radiusPx}px;top:${y - radiusPx}px;width:${diameter}px;height:${diameter}px`;
  dot.style.cssText = `left:${x + gesture.virtualX - gesture.centerX}px;top:${y + gesture.virtualY - gesture.centerY}px`;
  label.style.cssText = `left:${x}px;top:${y - radiusPx - 30}px`;
  label.textContent = `${gesture.key === "scatterSpacing" ? "Spacing" : "Size"}: ${value.toFixed(2)}`;
  overlay.classList.add("visible");
  document.body.classList.add("terrain-brush-radial");
}

function hideBrushAdjustOverlay() {
  viewport.terrainBrushAdjustOverlay?.classList.remove("visible");
  document.body.classList.remove("terrain-brush-radial");
}

/** The terrain component on the currently-selected entity, or null. */
function selectedTerrain() {
  const entityId = useSelectionStore.getState().ids[0];
  const component = entityId && engine.getEntity(entityId)?.getComponent?.("terrain");
  return component?.mesh ? { entityId, component } : null;
}

/**
 * Sculpt/paint brush strokes for the Terrain component. Armed via the
 * Inspector's Terrain section (terrainBrush.js); while armed and a terrain
 * entity is selected, drags raycast against just that entity's mesh and
 * mutate its live geometry/splatmap buffers directly (immediate feedback, no
 * command-bus traffic per pointermove). One undo command is dispatched per
 * stroke, on pointerup — see SetTerrainHeightsCommand/SetTerrainSplatmapCommand.
 *
 * The cursor disc+ring is refreshed every frame from the update loop (not just
 * on pointermove) so it keeps hugging the surface while the camera moves, and
 * tracks the pointer whenever a brush is armed — before any stroke begins.
 */
function setupTerrainBrush(canvas) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovering = false;
  let haveNdc = false;
  let stroke = null; // { component, entityId, before, mode, flattenHeight, seed }
  let strokeSeed = 0;
  let lastClient = null;
  let lastBrushTarget = null;
  let adjustGesture = null;

  const setNdc = (e) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    haveNdc = true;
    hovering = true; // a move/press over the canvas means we're on it
  };

  /** Raycast the current NDC against `component.mesh`; returns local-space hit or null. */
  const localHit = (component) => {
    raycaster.setFromCamera(ndc, viewport.camera);
    const hits = raycaster.intersectObject(component.mesh, false);
    if (!hits.length) return null;
    return component.mesh.worldToLocal(hits[0].point.clone());
  };

  const makeAdjustGesture = (adjustment) => {
    const target = lastBrushTarget;
    const rect = canvas.getBoundingClientRect();
    let centerX = lastClient?.x ?? rect.left + rect.width / 2;
    let centerY = lastClient?.y ?? rect.top + rect.height / 2;
    let radiusPx = 60;
    if (target) {
      viewport.camera.updateMatrixWorld();
      const worldValue = adjustment.key === "scatterSpacing"
        ? getTerrainBrushSettings().scatterSpacing
        : getTerrainBrushSettings().radius;
      const center = new THREE.Vector3(
        target.local.x,
        target.component.heightAtLocal(target.local.x, target.local.z),
        target.local.z,
      );
      const edge = new THREE.Vector3(
        target.local.x + worldValue,
        target.component.heightAtLocal(target.local.x + worldValue, target.local.z),
        target.local.z,
      );
      target.component.mesh.localToWorld(center);
      target.component.mesh.localToWorld(edge);
      center.project(viewport.camera);
      edge.project(viewport.camera);
      centerX = rect.left + (center.x * 0.5 + 0.5) * rect.width;
      centerY = rect.top + (-center.y * 0.5 + 0.5) * rect.height;
      const edgeX = rect.left + (edge.x * 0.5 + 0.5) * rect.width;
      const edgeY = rect.top + (-edge.y * 0.5 + 0.5) * rect.height;
      radiusPx = Math.max(8, Math.hypot(edgeX - centerX, edgeY - centerY));
    }
    return {
      key: adjustment.key,
      value: adjustment.startValue,
      startValue: adjustment.startValue,
      centerX,
      centerY,
      startRadiusPx: radiusPx,
      virtualX: centerX + radiusPx,
      virtualY: centerY,
      lastActualX: lastClient?.x ?? centerX,
      lastActualY: lastClient?.y ?? centerY,
    };
  };

  /**
   * Lays every dab between the previous pointer sample and this one.
   *
   * The heightfield is sampled on the XZ plane, so the stroke path is tracked
   * in 2D; the brush itself only ever uses X and Z.
   */
  const applyStrokeAt = (component, local) => {
    if (!stroke?.path) {
      applyBrush(component, local);
      return;
    }
    const settings = getTerrainBrushSettings();
    for (const [x, z] of strokeDabs(stroke.path, [local.x, local.z], settings.radius)) {
      applyBrush(component, new THREE.Vector3(x, local.y, z));
    }
  };

  const applyBrush = (component, local) => {
    const settings = getTerrainBrushSettings();
    if (stroke.mode === "sculpt") {
      component.applyHeightBrush(local, {
        tool: settings.tool,
        radius: settings.radius,
        strength: settings.strength * 0.15,
        hardness: settings.hardness,
        falloff: settings.falloff,
        flattenHeight: stroke.flattenHeight,
        seed: stroke.seed,
      });
    } else if (stroke.mode === "paint" || stroke.mode === "erase") {
      const layerIndex = Math.min(settings.activeLayer, (component.props.layers?.length ?? 1) - 1);
      if (!component.props.layers?.[layerIndex]?.material) return;
      component.applySplatBrush(local, {
        layerIndex,
        radius: settings.radius,
        strength: settings.strength,
        hardness: settings.hardness,
        falloff: settings.falloff,
        erase: stroke.mode === "erase",
      });
    } else if (stroke.mode === "scatter") {
      component.applyScatterBrush(local, {
        layerIndex: Math.min(settings.activeScatterLayer, Math.max(0, (component.props.scatterLayers?.length ?? 1) - 1)),
        radius: settings.radius,
        strength: settings.strength,
        spacing: settings.scatterSpacing,
        jitter: settings.scatterJitter,
        erase: stroke.erase,
        seed: stroke.seed + stroke.dab++,
      });
    }
  };

  canvas.addEventListener("pointerenter", () => (hovering = true));
  canvas.addEventListener("pointerleave", () => {
    hovering = false;
    if (!stroke) hideBrushIndicator();
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (getTerrainBrushAdjustment()) {
      if (e.button === 0 || e.button === 2) {
        finishTerrainBrushAdjustment(e.button === 2);
        adjustGesture = null;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.button !== 0 || !getTerrainBrushMode() || engine.playing) return;
    const sel = selectedTerrain();
    if (!sel) return;
    setNdc(e);
    const local = localHit(sel.component);
    if (!local) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const mode = getTerrainBrushMode();
    viewport.terrainBrushing = true;
    viewport.orbit.enabled = false;
    stroke = {
      mode,
      component: sel.component,
      entityId: sel.entityId,
      before: mode === "sculpt"
        ? sel.component.props.heights
        : mode === "scatter"
          ? JSON.stringify(sel.component.scatterLayersData ?? sel.component.props.scatterLayers ?? [])
          : sel.component.props.splatmap,
      // Flatten levels toward the surface height where the stroke began.
      flattenHeight: sel.component.heightAtLocal(local.x, local.z),
      seed: strokeSeed++,
      dab: 0,
      erase: mode === "scatter" && e.ctrlKey,
      // Shared with the mesh sculptor: pointer events arrive far apart during a
      // quick drag, and applying one dab per event left a dotted trail rather
      // than a stroke. Scatter keeps its own spacing rule, which is about how
      // far apart the instances sit, not about sampling the pointer.
      path: mode === "scatter" ? null : createStroke({ spacing: 0.25 }),
    };
    applyStrokeAt(sel.component, local);
  }, true);

  canvas.addEventListener("pointermove", (e) => {
    lastClient = { x: e.clientX, y: e.clientY };
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment) {
      if (!adjustGesture || adjustGesture.key !== adjustment.key) {
        adjustGesture = makeAdjustGesture(adjustment);
      }
      const radial = adjustment.key === "radius" || adjustment.key === "scatterSpacing";
      const dx = e.clientX - adjustGesture.lastActualX;
      const dy = e.clientY - adjustGesture.lastActualY;
      adjustGesture.lastActualX = e.clientX;
      adjustGesture.lastActualY = e.clientY;
      let value;
      if (radial) {
        adjustGesture.virtualX += dx;
        adjustGesture.virtualY += dy;
        const screenRadius = Math.max(2, Math.hypot(
          adjustGesture.virtualX - adjustGesture.centerX,
          adjustGesture.virtualY - adjustGesture.centerY,
        ));
        value = Math.max(0.1, adjustGesture.startValue * (screenRadius / adjustGesture.startRadiusPx));
        showBrushAdjustOverlay(canvas, adjustGesture, screenRadius, value);
      } else {
        value = THREE.MathUtils.clamp(adjustGesture.value + dx / 300, adjustment.key === "strength" ? 0.01 : 0, 1);
        adjustGesture.value = value;
      }
      setTerrainBrushSetting(adjustment.key, +value.toFixed(3));
      setNdc(e);
      return;
    }
    adjustGesture = null;
    if (!getTerrainBrushMode()) return;
    setNdc(e);
    if (!stroke) return;
    const local = localHit(stroke.component);
    if (local) applyStrokeAt(stroke.component, local);
  });

  window.addEventListener("pointerup", () => {
    if (!stroke) return;
    const { component, entityId, mode, before } = stroke;
    if (stroke.path) resetStroke(stroke.path);
    stroke = null;
    viewport.terrainBrushing = false;
    viewport.orbit.enabled = true;
    if (mode === "sculpt") {
      component.commitHeights();
      commandBus.execute(new SetTerrainHeightsCommand(entityId, before, component.props.heights));
    } else if (mode === "paint" || mode === "erase") {
      component.commitSplatmap();
      commandBus.execute(new SetTerrainSplatmapCommand(entityId, before, component.props.splatmap));
    } else if (mode === "scatter") {
      const after = component.commitScatterLayers();
      commandBus.execute(new SetTerrainScatterCommand(entityId, before, after));
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    if (getTerrainBrushAdjustment()) e.preventDefault();
  });
  window.addEventListener("blur", () => {
    if (getTerrainBrushAdjustment()) finishTerrainBrushAdjustment(true);
  });

  // Disarming clears the cursor immediately.
  subscribeTerrainBrush(() => {
    if (!getTerrainBrushMode()) hideBrushIndicator();
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment) {
      if (!adjustGesture || adjustGesture.key !== adjustment.key) {
        adjustGesture = makeAdjustGesture(adjustment);
        if (adjustment.key === "radius" || adjustment.key === "scatterSpacing") {
          showBrushAdjustOverlay(canvas, adjustGesture, adjustGesture.startRadiusPx, adjustment.startValue);
        }
      }
    } else {
      adjustGesture = null;
      hideBrushAdjustOverlay();
    }
  });

  // Per-frame cursor: keep the disc+ring glued to the surface under the
  // pointer whenever a brush is armed, independent of pointermove cadence.
  engine.onUpdate(() => {
    const mode = getTerrainBrushMode();
    if (!mode || engine.playing || (!hovering && !stroke) || !haveNdc) {
      hideBrushIndicator();
      return;
    }
    const target = stroke
      ? { component: stroke.component }
      : selectedTerrain();
    if (!target) {
      hideBrushIndicator();
      return;
    }
    viewport.camera.updateMatrixWorld();
    const local = localHit(target.component);
    if (!local) {
      if (!stroke) hideBrushIndicator();
      return;
    }
    lastBrushTarget = { component: target.component, local: local.clone() };
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment?.key === "radius" || adjustment?.key === "scatterSpacing") {
      hideBrushIndicator();
      return;
    }
    const settings = getTerrainBrushSettings();
    const paintLayer = target.component.props.layers?.[Math.min(settings.activeLayer, Math.max(0, (target.component.props.layers?.length ?? 1) - 1))];
    const paintPreviewColor = paintLayer?.tint ? new THREE.Color(paintLayer.tint).getHex() : PAINT_COLOR;
    const color = mode === "sculpt"
      ? (SCULPT_TOOL_COLORS[settings.tool] ?? PAINT_COLOR)
      : mode === "erase" ? ERASE_COLOR : mode === "scatter" ? SCATTER_COLOR : paintPreviewColor;
    const sculptPreview = mode === "sculpt" ? {
      mode,
      tool: settings.tool,
      radius: settings.radius,
      strength: settings.strength * 0.15,
      hardness: settings.hardness,
      flattenHeight: stroke?.flattenHeight ?? target.component.heightAtLocal(local.x, local.z),
      seed: stroke?.seed ?? strokeSeed,
    } : null;
    updateBrushIndicator(target.component, local, settings.radius, color, settings.strength, settings.hardness, sculptPreview);
    if (mode === "scatter") {
      updateScatterSilhouette(target.component, local, settings, stroke?.erase ?? false, stroke?.seed ?? strokeSeed);
    } else {
      hideScatterSilhouette();
    }
  });
}

/**
 * Spline knot editing in the viewport (roadmap item 16).
 *
 * The pointer handler runs in the CAPTURE phase so it sits ahead of
 * `setupPicking`: clicking a knot must not also re-run entity selection, and
 * Ctrl+click on the curve must not be read as "toggle this entity out of the
 * selection". Everything it does is gated on edit mode being armed, so with the
 * mode off this is one boolean per click.
 */
function setupSplineEditing(canvas) {
  // Handles are refreshed every frame rather than on a change event: they have
  // to track the camera (they are sized in pixels) as well as the knots, and
  // "sized correctly only until you orbit" is not a usable handle.
  engine.onPreRender(() => {
    updateSplineHandles(viewport.camera, canvas?.clientHeight || canvas?.height || 1);
  });

  // Arming, disarming or picking a different knot all change what the transform
  // gizmo should be attached to.
  subscribeSplineEdit(() => attachSelection(useSelectionStore.getState().ids));

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || engine.playing) return;
      const component = activeSpline();
      if (!component) return;

      const raycaster = raycastFromEvent(e, canvas);
      // The handles live on EDITOR_LAYER and a fresh Raycaster tests layer 0
      // only, so without this the pick silently finds nothing — the handles are
      // drawn, clickable-looking, and completely inert.
      raycaster.layers.enableAll();
      const hit = pickSplineHandle(raycaster);
      if (hit) {
        selectKnot(hit.knot, hit.handle);
        // Stop here: the click has been consumed by the handle, and letting it
        // through would re-select the path entity and detach the gizmo from
        // the very knot that was just grabbed.
        e.stopImmediatePropagation();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const curve = pickCurve(e.clientX, e.clientY, rect, viewport.camera);
        if (curve && insertKnotAt(curve.distance)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (e.shiftKey) {
        // Extend the path to whatever is under the cursor — a surface if there
        // is one, the ground plane otherwise. Snapping to geometry is what
        // makes laying a road over terrain a click per corner.
        const point = new THREE.Vector3();
        const hits = raycaster.intersectObjects(engine.scene.children, true);
        const solid = hits.find((h) => isPickVisible(h.object) && isSolidPick(h.object));
        if (solid) point.copy(solid.point);
        else if (!raycaster.ray.intersectPlane(GROUND_PLANE, point)) return;
        if (appendKnot(point)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      // Nothing spline-shaped under an unmodified click. If a gizmo arrow is
      // there, the drag belongs to the gizmo — checked HERE rather than at the
      // top, because the gizmo is parked on the selected knot and its arrows
      // lie right along the curve, so an early bail makes the neighbouring
      // knots unselectable and Ctrl+click-to-insert dead along three lines
      // through the path.
      if (viewport.gizmo?.axis) return;

      // Otherwise drop the knot selection and leave the click alone: swallowing
      // it would make every other object in the scene unclickable for as long
      // as edit mode is armed, which is a trap with no visible cause. Ordinary
      // picking runs and does the ordinary thing.
      selectKnot(-1);
    },
    true,
  );

  window.addEventListener("keydown", (e) => {
    if (e.altKey) setBreakTangent(true);
    if (!getSplineEdit().armed || engine.playing) return;
    const target = e.target;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    if (e.key === "Delete" || e.key === "x" || e.key === "X") {
      if (deleteSelectedKnot()) e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (!e.altKey) setBreakTangent(false);
  });
}

/** Raycasts from a viewport-relative pointer event into the scene. */
function raycastFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, viewport.camera);
  return raycaster;
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

async function applyTextureToMaterial(matPath, texPath) {
  const { getMaterialDef, updateMaterialAsset, MATERIAL_DEFAULTS } = await import("../../engine/materialAsset.js");
  // Pull the existing def (cache, falling back to disk) so dropping a texture
  // doesn't wipe color/roughness/metalness/shaderGraph with MATERIAL_DEFAULTS
  // when the cache is cold.
  let existing = getMaterialDef(matPath);
  if (!existing) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      existing = JSON.parse(await invoke("read_text_file", { path: matPath })) ?? {};
    } catch {
      existing = {};
    }
  }
  const def = { ...MATERIAL_DEFAULTS, ...existing, map: texPath };
  updateMaterialAsset(matPath, def);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
  console.log(`Set texture on ${matPath.split(/[\\/]/).pop()}`);
}

/** Applies a pointer-drag asset drop at a viewport point ({clientX, clientY}). */
function handleAssetDrop(path, point) {
  if (!path || !viewport.canvas) return;
  const ext = extOf(path);
  const raycaster = raycastFromEvent(point, viewport.canvas);

  if (TEXTURE_EXTENSIONS.includes(ext) || MATERIAL_EXTENSIONS.includes(ext)) {
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      const entityId = findEntityId(hit.object);
      const entity = entityId && engine.getEntity(entityId);
      const mesh = entity?.getComponent("mesh");
      if (!mesh) continue;
      if (MATERIAL_EXTENSIONS.includes(ext)) {
        commandBus.execute(new SetComponentPropCommand(entityId, "mesh", "material", path));
      } else if (mesh.props.material) {
        applyTextureToMaterial(mesh.props.material, path); // edits the .mat asset
      } else {
        console.warn("Assign a material asset to this mesh before dropping textures on it.");
      }
      return;
    }
    return;
  }

  if (SCRIPT_EXTENSIONS.includes(ext)) {
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      const entityId = findEntityId(hit.object);
      const entity = entityId && engine.getEntity(entityId);
      if (!entity) continue;
      // Dropping a second script onto an entity APPENDS it rather than
      // replacing what's there — an entity is expected to carry several.
      const existing = entity.getComponent("script");
      if (existing) {
        const scripts = [...(existing.props.scripts ?? []), { path, enabled: true, attributes: {} }];
        commandBus.execute(new SetComponentPropCommand(entityId, "script", "scripts", scripts));
      } else {
        commandBus.execute(
          new AddComponentCommand(entityId, "script", {
            scripts: [{ path, enabled: true, attributes: {} }],
          }),
        );
      }
      useSelectionStore.getState().select(entityId);
      return;
    }
    return;
  }

  if (MODEL_EXTENSIONS.includes(ext) || PREFAB_EXTENSIONS.includes(ext)) {
    // Drop precedence: a hit on a mesh drops onto that surface (existing
    // behavior); a free-air drop lands on the 3D cursor (so users can
    // pre-place a target and drop straight onto it without aiming in 3D).
    // The ground plane remains the fallback when neither applies — e.g. an
    // empty scene with the cursor still at the origin.
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    let at = null;
    const surfaceHit = hits.find((hit) => !hit.object.userData?.editorOnly);
    if (surfaceHit) {
      at = [surfaceHit.point.x, surfaceHit.point.y, surfaceHit.point.z];
    } else {
      const ground = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(GROUND_PLANE, ground)) {
        at = ground.toArray();
      } else {
        at = getCursor3D().position.slice();
      }
    }
    if (PREFAB_EXTENSIONS.includes(ext)) {
      instantiatePrefab(path, at).catch((err) => console.error(String(err)));
      return;
    }
    // Raw .glb: run the import pipeline (mesh entities + geometry/material
    // assets), then place the resulting prefab at the drop point.
    (async () => {
      const { unpackGlb } = await import("../glbImport.js");
      const folder = await unpackGlb(path);
      const stem = basename(path).replace(/\.[^.]+$/, "");
      await instantiatePrefab(`${folder}/${stem}.prefab`, at);
    })().catch((err) => console.error(String(err)));
  }
}

/**
 * Walks up the parent chain to find the entity a picked object belongs to.
 * Entity-aware helpers (e.g. the selection BoxHelper) carry an `entityId`
 * directly and resolve even though they're flagged editor-only. Pure
 * editor-only helpers (grid, gizmo, generic decoration) don't carry one
 * and short-circuit to null so they don't block selection.
 */
function findEntityId(object) {
  let node = object;
  while (node) {
    if (node.userData.entityId) return node.userData.entityId;
    if (node.userData.editorOnly) return null;
    node = node.parent;
  }
  return null;
}

/** True when `object` is the cursor proxy (or its hit-sphere). Used by
 *  the gizmo event handlers to distinguish cursor drags from entity
 *  drags without having to thread a separate selection-id through the
 *  gizmo machinery. */
function isCursorSelectionTarget(object) {
  if (!object) return false;
  // The gizmo is attached to either the cursor group or its hit-sphere;
  // both carry userData.is3DCursor (group) or userData.is3DCursorHit (mesh).
  return !!(object.userData?.is3DCursor || object.userData?.is3DCursorHit);
}

/**
 * Resolves the world-space point under the pointer at `(clientX, clientY)`,
 * preferring a mesh hit so the cursor lands on the visible surface and
 * falling back to the camera-facing plane a fixed distance from the
 * cursor's existing z when there's nothing to hit. Used by Shift+RMB and
 * the "Snap Cursor to Hit" menu entry. Returns `[x, y, z]` or null.
 */
function placeCursorFromPointer(clientX, clientY, canvas, snapToExistingDepth) {
  if (!viewport.camera) return null;
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, viewport.camera);
  const hits = raycaster.intersectObjects(engine.scene.children, true);
  for (const hit of hits) {
    if (hit.object.userData?.editorOnly) continue;
    return [hit.point.x, hit.point.y, hit.point.z];
  }
  // Miss: project the cursor onto a plane through the existing 3D
  // cursor position so it stays at the user's depth, or onto the ground
  // plane when there's nothing to anchor it to. Either way the cursor is
  // never lost on an empty scene.
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const out = new THREE.Vector3();
  const plane = snapToExistingDepth && getCursor3D().position
    ? new THREE.Plane().setFromNormalAndCoplanarPoint(
        viewport.camera.getWorldDirection(new THREE.Vector3()).negate(),
        new THREE.Vector3().fromArray(getCursor3D().position),
      )
    : ground;
  if (!raycaster.ray.intersectPlane(plane, out)) {
    out.set(0, 0, 0);
  }
  return [out.x, out.y, out.z];
}

/**
 * Open the Shift+S snap menu. The menu mirrors Blender's fly-out
 * ("Selection to Cursor", "Cursor to Selected", "Cursor to World Origin"
 * etc.) but lives inside the editor chrome to keep the dependency chain
 * outside the heavy `threeDCursor` module.
 */
function openCursorSnapMenu() {
  if (cursorSnapMenu) {
    cursorSnapMenu.remove();
    cursorSnapMenu = null;
  }
  const rows = [
    {
      label: "Selection → 3D Cursor",
      hint: "Selection → Cursor",
      enabled: useSelectionStore.getState().ids.length > 0,
      run: () => snapSelectionToCursor(),
    },
    {
      label: "Selection → World Origin",
      hint: "Selection → Origin",
      enabled: useSelectionStore.getState().ids.length > 0,
      run: () => snapSelectionToOrigin(),
    },
    { separator: true },
    {
      label: "3D Cursor → Selection",
      hint: "Cursor → Selection",
      enabled: useSelectionStore.getState().ids.length > 0,
      run: () => snapCursorToSelection(),
    },
    {
      label: "3D Cursor → World Origin",
      hint: "Cursor → Origin",
      run: () => snapCursorToWorldOrigin(),
    },
    {
      label: "3D Cursor → Grid Floor",
      hint: "Cursor → Grid",
      run: () => snapCursorToGridFloor(),
    },
  ];
  const host = document.querySelector(".viewport-panel") ?? document.body;
  const menu = document.createElement("div");
  menu.className = "cursor-snap-menu";
  for (const row of rows) {
    if (row.separator) {
      const sep = document.createElement("div");
      sep.className = "cursor-snap-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "cursor-snap-item";
    btn.disabled = !row.enabled;
    btn.innerHTML = `<span class="cursor-snap-label">${row.label}</span><kbd class="cursor-snap-hint">${row.hint}</kbd>`;
    btn.addEventListener("click", () => {
      row.run();
      menu.remove();
      cursorSnapMenu = null;
    });
    menu.appendChild(btn);
  }
  const close = () => {
    menu.remove();
    cursorSnapMenu = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const onPointer = (e) => {
    if (!menu.contains(e.target)) close();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  host.appendChild(menu);
  cursorSnapMenu = menu;
}

let cursorSnapMenu = null;

/**
 * Convert a world-space raycast hit + plane (xz, or camera-facing) into a
 * point for the cursor. Exposed so callers in other modules (e.g. the
 * asset drop handler) can reuse the same fallback strategy.
 */

function setupKeyboard(canvas) {
  canvas.addEventListener("pointerenter", () => (viewport.hovered = true));
  canvas.addEventListener("pointerleave", () => (viewport.hovered = false));

  // Shift + Right-click anywhere on the canvas drops a 3D cursor there.
  // Blender uses Shift+RMB for "Place 3D Cursor" — the right button keeps
  // orbit's RMB-orbit shortcut intact while making the modifier explicit.
  // `capture: true` so we run before OrbitControls' pan handler (also on
  // the canvas), letting us suppress the orbit RMB-pan gesture when the
  // user is using the cursor modifier. The placement is wrapped in a
  // SetCursor3DCommand so Ctrl+Z brings the cursor back to where it was
  // if the click was accidental.
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 2 || !e.shiftKey || engine.playing) return;
    e.preventDefault();
    e.stopPropagation();
    const point = placeCursorFromPointer(e.clientX, e.clientY, canvas, true);
    if (point) {
      const before = getCursor3D().position;
      const moved = before[0] !== point[0] || before[1] !== point[1] || before[2] !== point[2];
      if (moved) commandBus.execute(new SetCursor3DCommand(point, before));
    }
  }, { capture: true });

  window.addEventListener("keydown", (e) => {
    if (!viewport.hovered || engine.playing) return;
    if (e.target.closest?.(".geometry-editor")) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (!e.repeat && dispatchTerrainKeyAction(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (getTerrainBrushAdjustment() && e.key.toLowerCase() === "f") {
      e.preventDefault();
      return;
    }
    if (handleMacroKey(e)) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "tab": {
        const entityId = useSelectionStore.getState().ids[0] ?? null;
        if (!entityId || !engine.getEntity(entityId)?.getComponent("mesh")) break;
        e.preventDefault();
        e.stopImmediatePropagation();
        ensureGeometryAsset(entityId)
          .then(() => useGeometryEditStore.getState().enter(entityId))
          .catch((error) => console.error(`Couldn't enter geometry edit mode: ${error}`));
        break;
      }
      case "f":
        focusSelection();
        break;
    }
  });

  // Shift+S → 3D cursor snap menu. We listen on window so the menu opens
  // even when the canvas hasn't been hovered yet (the user might be
  // reaching for the keyboard after a hierarchy click). Match Blender's
  // "Cursor to Selected" / "Cursor to World Origin" / "Selection to
  // Cursor" / "Selection to World Origin" rows.
  window.addEventListener("keydown", (e) => {
    // Let editable controls receive capital S instead of opening the cursor
    // snap menu while the user is typing.
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "s") {
      // Don't fight the geometry editor's "S" macro OR the global
      // "Save (Ctrl+S)" — those pre-conditions already filter the input
      // (we checked e.repeat/no modifiers), so this only fires for plain
      // Shift+S, which is otherwise unbound.
      if (engine.playing) return;
      openCursorSnapMenu();
      e.preventDefault();
    }
  });

  // Shift+C → snap the 3D cursor back to (0,0,0). Mirrors Blender's
  // "Cursor to World Origin" being available both through the Shift+S
  // menu and as a one-keystroke shortcut. Routed through the command
  // bus so Ctrl+Z reverses it.
  window.addEventListener("keydown", (e) => {
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
      if (engine.playing) return;
      const before = getCursor3D().position;
      if (before[0] === 0 && before[1] === 0 && before[2] === 0) return;
      commandBus.execute(new SetCursor3DCommand([0, 0, 0], before));
      e.preventDefault();
    }
  });

  window.addEventListener("editor-start-transform", (event) => {
    if (!engine.playing && event.detail === "translate") startMacro("translate");
  });

  // Cancel an in-progress macro if the window loses focus (e.g. user
  // Alt-Tabs or clicks into an input). We deliberately do *not* cancel on
  // pointerleave so the user can lean out of the viewport to glance at the
  // hierarchy without losing what they typed.
  window.addEventListener("blur", () => cancelMacro());
}

const modeListeners = new Set();

function setGizmoMode(mode) {
  viewport.gizmo?.setMode(mode);
  for (const fn of modeListeners) fn(mode);
}

// ---------------------------------------------------------------------------
// Blender-style transform macros (G/R/S).
//
// Grammar:
//   G | R | S                       → start macro (translate / rotate / scale).
//                                     The macro opens in *interactive* mode,
//                                     anchored at the cursor position at the
//                                     moment the key was pressed. Mouse motion
//                                     then drives the transform exactly the way
//                                     Blender does it:
//                                       move   — the object tracks the cursor
//                                                in the view plane (1:1 at the
//                                                pivot's depth), or slides
//                                                along the locked axis by the
//                                                cursor's projection onto that
//                                                axis' screen direction
//                                       rotate — the *angle* the cursor sweeps
//                                                around the on-screen pivot,
//                                                about the view axis (or the
//                                                locked world axis)
//                                       scale  — the *ratio* of the cursor's
//                                                distance from the on-screen
//                                                pivot to its distance at
//                                                macro start. Moving toward
//                                                the pivot shrinks, away grows.
//   X | Y | Z                        → toggle that axis in `macro.axes`. Each
//                                     press re-baselines the macro, so the
//                                     previous drag is cancelled and the new
//                                     constraint starts from the current pose.
//                                     Presses are cumulative (R Y Z = YZ);
//                                     toggling the last one back resets to
//                                     all-three.
//   <digits> [.<digits>]             → enter numeric mode. Mouse is ignored
//                                     while a value is buffered:
//                                       G 2      → +2 along world X
//                                       G Z 2    → +2 along world Z
//                                       R 90     → 90° about the view axis
//                                       R X 90   → 90° about world X
//                                       S 0.5    → uniform 0.5×
//                                       S X 0.5  → 0.5× on world X only
//                                     Only the *first* keystroke re-baselines;
//                                     the rest edit the same buffer against a
//                                     fixed origin, so "0.5" reads as 0.5 and
//                                     "90" as 90 (not 0 and 99).
//   -                                → toggle the sign of the buffered value at
//                                     any point, Blender-style. "90" then "-"
//                                     becomes "-90"; pressing it again undoes.
//   Backspace                        → trim the buffer first, then pop the most
//                                     recent axis lock.
//   Enter | Space | left-click       → commit. Left-click mimics Blender's
//                                     "click anywhere to confirm" gesture.
//   right-click                      → cancel. (Blender's RMB convention.)
//   Escape                           → cancel (restores origin).
//
// A macro acts on every selected entity — the gizmo also drives the whole
// selection, so the macro grammar matches what the rest of the editor does.
// Rotate and scale pivot around the selection's median world origin (Blender's
// default "Median Point" pivot), which for a single entity is its own origin —
// so a lone object spins/scales in place.
// ---------------------------------------------------------------------------

const AXIS_KEYS = { x: "x", y: "y", z: "z" };

/** Last cursor position seen anywhere in the window. The macro anchors its
 *  drag here at G/R/S time rather than waiting for the first pointermove:
 *  radial scale and angular rotate measure *relative to the anchor*, so an
 *  anchor that lands wherever the cursor happened to jump next would make
 *  the first frame of the gesture jump with it. */
let cursorClientX = null;
let cursorClientY = null;
function trackCursor(e) {
  cursorClientX = e.clientX;
  cursorClientY = e.clientY;
}

/** Per-entity snapshot of the transform the macro is currently offset from.
 *
 *  `transform` (local) is what cancel restores and what the undo command
 *  records. The world pose is what the macro math runs on: rotate and scale
 *  happen about a shared world pivot, and "rotate 90° about world Y" has no
 *  meaningful local-axis answer for a child of a rotated parent.
 *
 *  Re-captured whenever the user changes the axis set so the "cancelled prev
 *  rotation" effect matches Blender's lock-on-press behavior. */
function captureMacroOrigin() {
  const ids = useSelectionStore.getState().ids;
  const out = [];
  for (const id of ids) {
    const entity = engine.getEntity(id);
    if (!entity) continue;
    entity.object3D.updateMatrixWorld(true);
    out.push({
      entity,
      transform: entity.getTransform(),
      object3D: entity.object3D,
      // The three.js parent, used for the world→local conversion. Root
      // entities sit under engine.scene, so this is never null.
      parent: entity.object3D.parent,
      worldPos: entity.object3D.getWorldPosition(new THREE.Vector3()),
      worldQuat: entity.object3D.getWorldQuaternion(new THREE.Quaternion()),
      worldScale: entity.object3D.getWorldScale(new THREE.Vector3()),
    });
  }
  return out;
}

/** Anchor a fresh drag at the current cursor position. Falls back to the
 *  viewport centre if the pointer has never been over the window. */
function freshMacroPointer() {
  const rect = viewport.canvas?.getBoundingClientRect();
  const x = cursorClientX ?? (rect ? rect.left + rect.width / 2 : 0);
  const y = cursorClientY ?? (rect ? rect.top + rect.height / 2 : 0);
  return { startX: x, startY: y, x, y, dx: 0, dy: 0, angle: 0, lastAngle: null };
}

/** Re-zero the macro against the entities' current pose: new baseline, new
 *  pivot, drag restarted from where the cursor is now. Used whenever the
 *  meaning of the gesture changes mid-macro (axis toggled, numeric mode
 *  entered) so nothing the user already did gets re-applied on top of itself. */
function rebaselineMacro() {
  macro.origin = captureMacroOrigin();
  macro.pivot = macroPivot(macro.origin.map((o) => o.worldPos));
  macro.pointer = freshMacroPointer();
}

/**
 * Active macro state.
 *   kind       "translate" | "rotate" | "scale"
 *   axes       Set of locked-in axes. Empty = all three (Blender-style
 *              "no axis lock = free on every axis"); otherwise the listed
 *              axes are the only ones affected.
 *   buffer     Numeric input buffer (raw text). Non-empty = "numeric mode"
 *              where mouse is disabled.
 *   value      Parsed `buffer` (`null` while interactive, or while the buffer
 *              holds only a partial token like "-" or ".").
 *   origin     Per-entity baseline (local + world pose).
 *   pivot      World-space rotate/scale pivot for `origin`.
 *   pointer    { startX, startY, x, y, dx, dy, angle, lastAngle } — the drag
 *              anchor plus the accumulated sweep angle for rotate.
 */
let macro = null;
let installedMacroPointer = false;

const macroListeners = new Set();
function notifyMacro() {
  // Toggle the window-level pointer hooks along with the macro's lifecycle.
  // capture: true ensures we see pointer events even when a deeper element
  // (OrbitControls, draggable panels) would otherwise swallow them.
  if (macro && !installedMacroPointer) {
    installMacroPointer();
    installedMacroPointer = true;
  } else if (!macro && installedMacroPointer) {
    uninstallMacroPointer();
    installedMacroPointer = false;
  }
  for (const fn of macroListeners) fn(macro ? describeMacro() : null);
}

function describeMacro() {
  if (!macro) return null;
  const { kind, axes, buffer, value } = macro;
  const allAxes = ["x", "y", "z"];
  // Numeric translate with no lock goes down world X (Blender fills the
  // first of the x/y/z fields), so show that in the HUD rather than
  // implying the value lands on all three.
  const activeAxes =
    axes.size > 0
      ? [...axes]
      : kind === "translate" && buffer !== ""
        ? ["x"]
        : allAxes;
  // Blank when fully open so the HUD doesn't echo "XYZ" on every keystroke;
  // show explicit lock only when the user has narrowed it down.
  const axisStr =
    activeAxes.length === 3 ? "" : activeAxes.length === 0 ? "—" : activeAxes.join("");
  const label = kind === "translate" ? "Move" : kind === "rotate" ? "Rotate" : "Scale";
  const unit = kind === "rotate" ? "°" : kind === "scale" ? "×" : "";
  const numStr = buffer === "" ? "" : `${buffer}${unit}`;
  return {
    label,
    axisStr,
    numStr,
    value,
    interactive: buffer === "",
    activeAxes,
    allAxes,
  };
}

function startMacro(kind) {
  if (engine.playing) return;
  const origin = captureMacroOrigin();
  if (!origin.length) return;
  macro = {
    kind,
    axes: new Set(), // empty = all three (Blender's "no axis lock")
    buffer: "",
    value: null,
    origin,
    pivot: macroPivot(origin.map((o) => o.worldPos)),
    pointer: freshMacroPointer(),
  };
  notifyMacro();
}

/** Cancel and restore every entity to its pre-macro transform. */
function cancelMacro() {
  if (!macro) return;
  for (const { entity, transform } of macro.origin) entity.setTransform(transform);
  macro = null;
  notifyMacro();
}

/** Commit: build one SetTransformCommand per selected entity.
 *
 *  Both modes preview by writing straight to the live three.js object, so
 *  `after` is simply whatever the entity holds right now — no recomputing
 *  from the baseline, which is what used to let the committed transform
 *  differ from the one the user was looking at. */
function commitMacro() {
  if (!macro) return;
  const cmds = [];
  for (const { entity, transform } of macro.origin) {
    const after = entity.getTransform();
    cmds.push(new SetTransformCommand(entity.id, after, transform));
  }
  if (cmds.length === 1) commandBus.execute(cmds[0]);
  else if (cmds.length > 1) {
    commandBus.execute(new BatchCommand(cmds, cmds[0].label));
  }
  macro = null;
  notifyMacro();
}

/**
 * Apply the current macro state. Two modes:
 *  - Interactive (buffer empty): turn the cursor gesture into a world-space
 *    delta on top of each entity's `origin` baseline.
 *  - Numeric (buffer filled): build the same kind of world-space delta from
 *    the typed value + active axes. Mouse is ignored here.
 * Both write through `applyWorldDelta`, so the two modes stay consistent: the
 * same pivot, the same axis handling, the same world→local conversion.
 */
function previewMacro() {
  if (!macro) return;
  const { kind, axes, buffer, value, origin, pivot, pointer } = macro;
  const cam = viewport.camera;
  if (!cam) return;
  if (buffer !== "" && value === null) {
    // Buffer holds only a partial token ("-" or "."). Sit on the baseline
    // rather than inventing a placeholder value that would visibly jump the
    // entity for one keystroke and then jump back.
    restoreMacroOrigin();
    return;
  }
  let delta;
  if (buffer === "") {
    const rect = viewport.canvas?.getBoundingClientRect();
    if (!rect || !pointer || rect.width < 1 || rect.height < 1) return;
    cam.updateMatrixWorld();
    delta = pointerDelta(kind, axes, pointer, pivot, rect, cam);
  } else {
    cam.updateMatrixWorld();
    delta = numericDelta(kind, axes, value, pivot, cam);
  }
  applyWorldDelta(origin, pivot, delta.pos, delta.quat, delta.scale);
}

/** Put every entity back on its baseline without ending the macro. */
function restoreMacroOrigin() {
  for (const { entity, transform } of macro.origin) entity.setTransform(transform);
  useSceneStore.getState().updateTransform(macro.origin.map((o) => o.entity.id));
}

// --- World-space delta application ------------------------------------------

// Reused per-event to keep the drag loop allocation-free.
const _macroOffset = new THREE.Vector3();
const _macroWorldPos = new THREE.Vector3();
const _macroWorldQuat = new THREE.Quaternion();
const _macroParentInv = new THREE.Matrix4();
const _macroMatrix = new THREE.Matrix4();
const _macroDecPos = new THREE.Vector3();
const _macroDecQuat = new THREE.Quaternion();
const _macroDecScale = new THREE.Vector3();

/**
 * Write one world-space delta onto every entity in `origin`. Any argument
 * may be null to mean "no change on that channel".
 *   posDelta    world-space translation
 *   quatDelta   rotation about `pivot`
 *   scaleDelta  per-axis multiplier; fans the entity's offset from `pivot`
 *               out/in and multiplies its own scale
 *
 * Scale is applied to the entity's *local* scale rather than being folded
 * through the world matrix: a world-axis scale on a rotated object is a shear,
 * which a position/quaternion/scale triple cannot represent, and the decompose
 * would silently mangle the rotation. Local application matches what the
 * Inspector shows and what the gizmo's scale handles do.
 *
 * Mutates object3D directly — the macro is a live preview, and `commitMacro`
 * reads the result back out via `getTransform()`.
 */
function applyWorldDelta(origin, pivot, posDelta, quatDelta, scaleDelta) {
  for (const o of origin) {
    // Offset from the pivot, fanned by scale then swung by rotation. For a
    // single entity the offset is zero, so rotate/scale leave position alone.
    _macroOffset.copy(o.worldPos).sub(pivot);
    if (scaleDelta) _macroOffset.multiply(scaleDelta);
    if (quatDelta) _macroOffset.applyQuaternion(quatDelta);
    _macroWorldPos.copy(pivot).add(_macroOffset);
    if (posDelta) _macroWorldPos.add(posDelta);

    if (quatDelta) _macroWorldQuat.copy(quatDelta).multiply(o.worldQuat);
    else _macroWorldQuat.copy(o.worldQuat);

    const parent = o.parent;
    if (!parent || parent === engine.scene) {
      // Root entity — world space is local space.
      o.object3D.position.copy(_macroWorldPos);
      o.object3D.quaternion.copy(_macroWorldQuat);
    } else {
      // Child of a transformed parent: convert the new world pose back into
      // local space through the parent's inverse world matrix. The original
      // world scale goes in so the decomposed local scale comes back out
      // unchanged — `scaleDelta` is applied locally, below.
      _macroParentInv.copy(parent.matrixWorld).invert();
      _macroMatrix
        .compose(_macroWorldPos, _macroWorldQuat, o.worldScale)
        .premultiply(_macroParentInv);
      _macroMatrix.decompose(_macroDecPos, _macroDecQuat, _macroDecScale);
      o.object3D.position.copy(_macroDecPos);
      o.object3D.quaternion.copy(_macroDecQuat);
    }

    const [lsx, lsy, lsz] = o.transform.scale;
    if (scaleDelta) {
      o.object3D.scale.set(lsx * scaleDelta.x, lsy * scaleDelta.y, lsz * scaleDelta.z);
    } else {
      o.object3D.scale.set(lsx, lsy, lsz);
    }
  }
  // One batched store write for the whole selection — see updateTransform.
  useSceneStore.getState().updateTransform(origin.map((o) => o.entity.id));
}

/** Pointermove handler — only active while the macro is in interactive mode. */
function onMacroPointerMove(e) {
  if (!macro || macro.buffer !== "" || !macro.pointer) return;
  const p = macro.pointer;
  p.x = e.clientX;
  p.y = e.clientY;
  p.dx = e.clientX - p.startX;
  p.dy = e.clientY - p.startY;
  previewMacro();
}

/** Blender-style "click anywhere to confirm" while the macro is interactive.
 *  Two exceptions: clicks on text inputs/editors fall through (so the user
 *  can reach them without first escaping the macro), and right-click cancels
 *  (Blender's RMB = cancel convention). */
function onMacroPointerDown(e) {
  if (!macro) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    cancelMacro();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  commitMacro();
}

// --- Keyboard entry ---------------------------------------------------------

function handleMacroKey(e) {
  if (macro) return handleMacroInput(e);

  // Don't start a macro if the user is holding a modifier. Shift is also
  // reserved — the Shift+S chord opens the 3D cursor snap menu (Blender's
  // behaviour) so plain keypresses never carry Shift.
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (e.repeat) return false;
  const k = e.key.toLowerCase();
  let kind = null;
  if (k === "g") kind = "translate";
  else if (k === "r") kind = "rotate";
  else if (k === "s") kind = "scale";
  if (!kind) return false;
  // startMacro is a no-op if nothing is selected / game is playing — in that
  // case fall through so the keystroke doesn't get preventDefault'd.
  const selectedIds = useSelectionStore.getState().ids;
  if (selectedIds.length === 0) return false;
  // Directional lights have no positional/scale state — skip translate and
  // scale macros so the user gets no false "move worked" feedback.
  if (
    (kind === "translate" || kind === "scale") &&
    selectionHasDirectionalLight(selectedIds)
  ) {
    return false;
  }
  e.preventDefault();
  startMacro(kind);
  return true;
}

/**
 * True when at least one selected entity carries a directional light. Used
 * to suppress the G/S transform macros (those properties don't exist for a
 * sun) and to skip attaching the standard transform gizmo on selection.
 */
function selectionHasDirectionalLight(ids = useSelectionStore.getState().ids) {
  for (const id of ids) {
    const light = engine.getEntity(id)?.getComponent?.("light");
    if (light?.props?.kind === "directional") return true;
  }
  return false;
}

function handleMacroInput(e) {
  const k = e.key;

  // Commit / cancel take priority over everything else.
  if (k === "Escape") {
    e.preventDefault();
    cancelMacro();
    return true;
  }
  if (k === "Enter" || k === " " || k === "Spacebar") {
    e.preventDefault();
    commitMacro();
    return true;
  }

  // Axis toggle. Adding axes is cumulative: R Y Z = YZ. Toggling the last
  // remaining axis empties the set — which the rest of the macro treats as
  // "every axis" (Blender's no-lock default), so the user can always back
  // out to fully open by pressing the active axis letter one more time.
  // Each toggle also re-captures `origin` so the cursor delta starts at 0
  // from the now-current transform — that's the "cancel prev rotation"
  // behavior the user described.
  if (k === "x" || k === "y" || k === "z") {
    e.preventDefault();
    const axis = AXIS_KEYS[k];
    if (macro.axes.has(axis)) macro.axes.delete(axis);
    else macro.axes.add(axis);
    // Re-baseline to the entity's *current* transform so the visible pose
    // becomes the new zero-point for subsequent moves/drags.
    rebaselineMacro();
    previewMacro();
    notifyMacro();
    return true;
  }

  // Backspace: clear the numeric buffer first; once empty, remove the most
  // recent axis lock so the user can claw back the macro step by step.
  if (k === "Backspace") {
    e.preventDefault();
    if (macro.buffer.length > 0) {
      macro.buffer = macro.buffer.slice(0, -1);
      macro.value = parseMacroNumber(macro.buffer);
      previewMacro();
      notifyMacro();
      return true;
    }
    if (macro.axes.size > 0) {
      // Pop the most recently added axis. `Set` preserves insertion order.
      const last = [...macro.axes].at(-1);
      macro.axes.delete(last);
      rebaselineMacro();
      previewMacro();
      notifyMacro();
      return true;
    }
    return true;
  }

  // Sign toggle. Blender lets you hit "-" at any point in the gesture to flip
  // the value you already typed, so "90" then "-" reads as -90 — no need to
  // backspace the digits and retype them behind a leading minus.
  if (k === "-") {
    e.preventDefault();
    if (macro.buffer === "") rebaselineMacro();
    macro.buffer = toggleBufferSign(macro.buffer);
    macro.value = parseMacroNumber(macro.buffer);
    previewMacro();
    notifyMacro();
    return true;
  }

  // Numeric input. The value drives each active axis against a *fixed*
  // baseline, so every keystroke re-reads the whole buffer from the same
  // origin.
  if (/^[0-9.]$/.test(k)) {
    e.preventDefault();
    if (k === "." && macro.buffer.includes(".")) return true;
    // Only the first keystroke transitions interactive→numeric. Re-baselining
    // on every keystroke (the old behavior) made each digit stack on top of
    // the partially-typed value that was already previewed: "9" then "0" read
    // as 9° followed by another 90° (99° total), and "0" then "." then "5"
    // pinned scale to 0 because the 0× preview became the new baseline.
    if (macro.buffer === "") rebaselineMacro();
    macro.buffer += k;
    macro.value = parseMacroNumber(macro.buffer);
    previewMacro();
    notifyMacro();
    return true;
  }

  // Unhandled keys fall through (Tab, function keys, arrows, etc.).
  return false;
}

/** Install / remove the window-level pointer listeners that the macro needs
 *  for interactive drag. Only attached while a macro is active. Capture
 *  phase on both because some controls (OrbitControls, draggable panels)
 *  may stop propagation lower in the tree, and we still want the macro to
 *  see every cursor move + click. */
function installMacroPointer() {
  window.addEventListener("pointermove", onMacroPointerMove, true);
  window.addEventListener("pointerdown", onMacroPointerDown, true);
}
function uninstallMacroPointer() {
  window.removeEventListener("pointermove", onMacroPointerMove, true);
  window.removeEventListener("pointerdown", onMacroPointerDown, true);
}

function focusSelection() {
  const ids = useSelectionStore.getState().ids;
  if (!ids.length) return;
  const entities = resolveEntities(ids);
  if (!entities.length) return;
  // Frame the union bounds of the entire selection. Boxable-only filter so
  // a single camera entity with its preview mesh doesn't blow up the
  // framing distance.
  const boxable = entities.filter(isBoxableEntity);
  const bounds = boxable.length ? computeSelectionBounds(boxable) : new THREE.Box3();
  const center = new THREE.Vector3();
  let size = 2;
  if (!bounds.isEmpty()) {
    bounds.getCenter(center);
    size = bounds.getSize(new THREE.Vector3()).length() || 2;
  } else {
    // No boxable geometry (e.g. only lights/UI). Center on the average
    // world position and pick a default framing distance.
    center.copy(computeSelectionCentroid(entities));
  }
  const offset = viewport.camera.position.clone().sub(viewport.orbit.target).normalize().multiplyScalar(size * 2);
  viewport.orbit.target.copy(center);
  viewport.camera.position.copy(center).add(offset);
  viewport.orbit.dispatchEvent({ type: "change" });
}

/**
 * Snapshot of the editor orbit camera's pose — used by the inspector's
 * "Adjust to View" button to copy the current view onto a selected camera
 * entity. Returns null if the viewport hasn't been initialized yet.
 */
export function getEditorCameraView() {
  if (!viewport.camera) return null;
  return {
    position: viewport.camera.position.toArray(),
    rotation: [viewport.camera.rotation.x, viewport.camera.rotation.y, viewport.camera.rotation.z],
  };
}

const AXIS_COLORS = { x: "#f06a73", y: "#67c77a", z: "#5d9df5" };

function AxisViewGizmo({ playing }) {
  const [activeView, setActiveView] = useState(viewport.axisView);
  const [directions, setDirections] = useState({
    x: { x: 1, y: 0, depth: 0 },
    y: { x: 0, y: -1, depth: 0 },
    z: { x: -0.7, y: 0.7, depth: 0 },
  });

  useEffect(() => subscribeAxisView(setActiveView), []);
  useEffect(() => {
    let disposed = false;
    let orbit = null;
    const update = () => {
      const camera = viewport.camera;
      if (!camera || disposed) return;
      const inverse = camera.quaternion.clone().invert();
      const next = {};
      for (const axis of ["x", "y", "z"]) {
        const world = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
        world.applyQuaternion(inverse);
        const length = Math.hypot(world.x, world.y);
        next[axis] = length < 0.001
          ? { x: 0, y: 0, depth: world.z }
          : { x: world.x / length, y: -world.y / length, depth: world.z };
      }
      setDirections(next);
    };
    ensureViewport().then(() => {
      if (disposed) return;
      orbit = viewport.orbit;
      orbit?.addEventListener("change", update);
      update();
    });
    return () => {
      disposed = true;
      orbit?.removeEventListener("change", update);
    };
  }, []);

  const radius = 27;
  const endpoints = [];
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [-1, 1]) {
      const direction = directions[axis];
      endpoints.push({
        axis,
        sign,
        left: 38 + direction.x * radius * sign,
        top: 38 + direction.y * radius * sign,
        depth: direction.depth * sign,
      });
    }
  }

  return (
    <div className={`axis-view-gizmo ${playing ? "disabled" : ""}`} aria-label="Viewport orientation">
      <svg className="axis-view-lines" viewBox="0 0 76 76" aria-hidden="true">
        {Object.entries(directions).map(([axis, direction]) => (
          <line
            key={axis}
            x1={38 - direction.x * radius}
            y1={38 - direction.y * radius}
            x2={38 + direction.x * radius}
            y2={38 + direction.y * radius}
            stroke={AXIS_COLORS[axis]}
          />
        ))}
      </svg>
      {endpoints
        .sort((a, b) => a.depth - b.depth)
        .map(({ axis, sign, left, top, depth }) => {
          const view = `${sign > 0 ? "+" : "-"}${axis.toUpperCase()}`;
          return (
            <button
              key={view}
              className={`axis-view-end ${sign > 0 ? "positive" : "negative"} ${activeView === view ? "active" : ""}`}
              style={{ left, top, zIndex: 3 + Math.round((depth + 1) * 2), "--axis-color": AXIS_COLORS[axis] }}
              title={`${view} orthographic view`}
              aria-label={`${view} orthographic view`}
              disabled={playing}
              onClick={() => setAxisView(axis, sign)}
            >
              {sign > 0 ? axis.toUpperCase() : ""}
            </button>
          );
        })}
    </div>
  );
}

/**
 * Right-click-in-the-viewport menu. Deliberately short: the things you reach
 * for with an object under the cursor, plus the 3D-cursor snaps that otherwise
 * only exist behind the Shift+S chord.
 */
function viewportMenuItems() {
  const ids = useSelectionStore.getState().ids;
  const has = ids.length > 0;
  // Mirrors the same check in aiStore.runWorkflow — see HierarchyPanel.jsx's
  // context menu for the longer version of this comment.
  const diagnoseWorkflow = getWorkflow("diagnose-selected");
  const aiProvider = getActiveProvider();
  const aiBlockedHint =
    diagnoseWorkflow?.mutates && !aiProvider?.capabilities?.scopedTools
      ? `${aiProvider?.label ?? "This provider"} cannot limit itself to this workflow's tools. Switch to a scoped provider (e.g. Ollama).`
      : undefined;
  return [
    { label: "Focus Selected", shortcut: "F", disabled: !has, action: () => focusSelection() },
    { separator: true },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: !has, action: () => duplicateSelection() },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !has, action: () => copyEntities(ids) },
    { label: "Paste", shortcut: "Ctrl+V", disabled: !clipboardHasEntities(), action: () => pasteEntities(null) },
    { separator: true },
    { label: "Selection → 3D Cursor", disabled: !has, action: () => snapSelectionToCursor() },
    { label: "3D Cursor → Selection", disabled: !has, action: () => snapCursorToSelection() },
    { label: "3D Cursor → World Origin", action: () => snapCursorToWorldOrigin() },
    { separator: true },
    {
      label: "AI: Diagnose this",
      icon: Sparkles,
      disabled: ids.length !== 1 || !!aiBlockedHint,
      hint: aiBlockedHint,
      action: () => {
        openPanel("ai");
        runWorkflow("diagnose-selected", ids[0]);
      },
    },
    { separator: true },
    { label: "Delete", shortcut: "Del", danger: true, disabled: !has, action: () => deleteSelection() },
  ];
}

export function ViewportPanel() {
  const containerRef = useRef(null);
  // Where the right button went down, so a right-DRAG (orbit/pan) can be told
  // apart from a right-CLICK (open the menu).
  const rmbDownRef = useRef(null);
  const [viewportMenu, setViewportMenu] = useState(null);
  const [backend, setBackend] = useState(viewport.backend);
  const [mode, setMode] = useState("translate");
  const [macroState, setMacroState] = useState(null);
  const [terrainBrushState, setTerrainBrushState] = useState(() => ({
    mode: getTerrainBrushMode(),
    settings: { ...getTerrainBrushSettings() },
    adjustment: getTerrainBrushAdjustment(),
  }));
  const [previewEntityName, setPreviewEntityName] = useState(null);
  // True while the Game panel is holding the shared renderer canvas.
  const [canvasElsewhere, setCanvasElsewhere] = useState(false);
  const playing = usePlayStore((s) => s.playing);
  const paused = usePlayStore((s) => s.paused);
  const rootPath = useProjectStore((s) => s.rootPath);
  const sceneName = useSceneStore((s) => s.sceneName);
  const scenePath = useSceneStore((s) => s.scenePath);
  const geometryEntityId = useGeometryEditStore((s) => s.entityId);
  // Captured pose for the embedded geometry editor, handed over so entering
  // edit mode does not move the camera.
  //
  // A ref, not state, and that is the whole point. The panel reads this once,
  // while building its scene, from a passive effect — and a passive effect runs
  // AFTER the commit that mounted it. State set from this layout effect only
  // reaches the panel as a prop on the following render, by which time the
  // panel has already set its scene up, seen no view to inherit and framed the
  // geometry itself. That is the camera jump: the handover was always computed,
  // just one render too late to be used.
  const geometryInitialView = useRef(null);
  // Mirrors viewport.layers — kept here because React owns the toggle UI.
  // The Panel re-reads this any time something else (e.g. another viewport
  // instance in a future split-pane setup) mutates layer state via the
  // subscribeLayers pub-sub.
  const [layers, setLayers] = useState(viewport.layers);
  const [layersOpen, setLayersOpen] = useState(false);
  // Seeded from the singleton: dockview remounts this panel on tab moves, and
  // a remounted toolbar must show (and be able to stop) the server that is
  // already running, not offer to start a second one.
  const [browserPreview, setBrowserPreview] = useState(() => ({
    busy: false,
    message: "",
    urls: getActiveBrowserPreview(),
    share: getActiveShareTunnel(),
  }));
  // Separate from `busy`: only the share endpoint should spin while a tunnel
  // starts, not while the preview itself builds.
  const [shareBusy, setShareBusy] = useState(false);
  // The public link wins the QR slot when it exists: it works from any phone
  // with no certificate warning, which is what a scanned code is for.
  const browserPreviewQrUrl = browserPreview.share?.url || browserPreview.urls?.lanUrl || "";
  const browserPreviewQr = useMemo(() => {
    if (!browserPreviewQrUrl) return "";
    const qr = qrcode(0, "M");
    qr.addData(browserPreviewQrUrl);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [browserPreviewQrUrl]);

  const launchBrowserPreview = async () => {
    if (browserPreview.busy) return;
    if (browserPreview.urls) {
      setBrowserPreview((state) => ({ ...state, busy: true, message: "Stopping browser preview…" }));
      try {
        // stopBrowserPreview also takes the share tunnel down with it.
        await stopBrowserPreview(browserPreview.urls.report?.contentDir);
        setBrowserPreview({ busy: false, message: "", urls: null, share: null });
      } catch (error) {
        console.error(`Could not stop browser preview: ${error?.message ?? error}`);
        setBrowserPreview((state) => ({
          ...state,
          busy: false,
          message: `Could not stop preview: ${error?.message ?? error}`,
        }));
      }
      return;
    }
    setBrowserPreview({ busy: true, message: "Building browser preview…", urls: null, share: null });
    try {
      // Export the authored snapshot, never a scene after gameplay scripts or
      // physics have mutated it. This also makes the button useful while the
      // user is already testing in the viewport.
      if (playing) {
        setBrowserPreview({ busy: true, message: "Stopping Play mode…", urls: null, share: null });
        await stopPlay();
      }
      // openBrowser: false — the endpoints appear in the toolbar instead of a
      // tab stealing focus the moment the build lands.
      const result = await openBrowserPreview({
        openBrowser: false,
        onProgress: ({ message }) => setBrowserPreview((state) => ({ ...state, message })),
      });
      if (result) {
        setBrowserPreview({
          busy: false,
          message: result.lanUrl
            ? `Live: ${result.localUrl} · Wi-Fi: ${result.lanUrl}`
            : `Live: ${result.localUrl}`,
          urls: result,
          share: null,
        });
      } else {
        setBrowserPreview({ busy: false, message: "", urls: null, share: null });
      }
    } catch (error) {
      console.error(`Browser preview failed: ${error?.message ?? error}`);
      pushToast({ level: "error", title: "Browser preview failed", detail: `${error?.message ?? error}` });
      setBrowserPreview({ busy: false, message: `Preview failed: ${error?.message ?? error}`, urls: null, share: null });
    }
  };

  const toggleShareTunnel = async () => {
    if (browserPreview.busy || shareBusy || !browserPreview.urls) return;
    setShareBusy(true);
    try {
      if (browserPreview.share) {
        setBrowserPreview((state) => ({ ...state, message: "Stopping public link…" }));
        try {
          await stopShareTunnel();
          setBrowserPreview((state) => ({ ...state, message: "", share: null }));
        } catch (error) {
          console.error(`Could not stop share link: ${error?.message ?? error}`);
          setBrowserPreview((state) => ({
            ...state,
            share: null,
            message: `Could not stop share link: ${error?.message ?? error}`,
          }));
        }
        return;
      }
      setBrowserPreview((state) => ({ ...state, message: "Creating public link…" }));
      try {
        const share = await startShareTunnel({
          onProgress: ({ message }) => setBrowserPreview((state) => ({ ...state, message })),
        });
        if (!share) return;
        // The first thing anyone does with a share link is paste it somewhere.
        navigator.clipboard?.writeText(share.url).catch(() => {});
        setBrowserPreview((state) => ({
          ...state,
          share,
          message: `Public link (copied to clipboard): ${share.url}`,
        }));
      } catch (error) {
        console.error(`Share link failed: ${error?.message ?? error}`);
        pushToast({ level: "error", title: "Share link failed", detail: `${error?.message ?? error}` });
        setBrowserPreview((state) => ({
          ...state,
          message: `Share link failed: ${error?.message ?? error}`,
        }));
      }
    } finally {
      setShareBusy(false);
    }
  };

  const openPreviewEndpoint = async (url) => {
    try {
      await openBrowserPreviewUrl(url);
    } catch (error) {
      console.error(`Could not open preview URL ${url}: ${error?.message ?? error}`);
      navigator.clipboard?.writeText(url).catch(() => {});
      setBrowserPreview((state) => ({
        ...state,
        message: `Could not open URL; copied to clipboard: ${url}`,
      }));
    }
  };

  const dropRef = useAssetDrop({
    accepts: [...MODEL_EXTENSIONS, ...TEXTURE_EXTENSIONS, ...SCRIPT_EXTENSIONS, ...MATERIAL_EXTENSIONS, ...PREFAB_EXTENSIONS],
    onDrop: (path, point) => {
      if (!usePlayStore.getState().playing) handleAssetDrop(path, point);
    },
  });

  useEffect(() => {
    let cancelled = false;
    ensureViewport().then(() => {
      if (cancelled) return;
      updateEditorCameraPrefsKey(rootPath, scenePath, sceneName);
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, scenePath, sceneName]);

  useEffect(() => {
    // Toggle a body class while the macro is interactive so theme.css can
    // give the viewport a grab cursor without leaking the cursor onto other
    // panels (the macro is modal anyway).
    document.body.classList.toggle("macro-active", !!macroState?.interactive);
    return () => {
      document.body.classList.remove("macro-active");
    };
  }, [macroState]);

  // When the user enters geometry edit mode, pull the editor camera back to
  // a comfortable framing of the geometry's world-space bounding box. The
  // geometry editor itself does its own local-space focus from the snapshot
  // it captures next render; without this pass the local pose it inherits
  // would carry whatever the user happened to be looking at elsewhere in
  // the scene, not the mesh being edited.
  useLayoutEffect(() => {
    geometryInitialView.current = null;
    if (!geometryEntityId) return;
    // The viewport camera may not be initialized yet on the first paint after
    // project load. Wait for `ensureViewport()` so we focus the real camera
    // instead of bailing out and leaving the editor pointing at stale state.
    let cancelled = false;
    const focusAndCapture = () => {
      if (cancelled) return;
      if (!viewport.camera || !viewport.orbit) return;
      const entity = engine.getEntity(geometryEntityId);
      if (!entity?.object3D) return;
      entity.object3D.updateWorldMatrix(true, false);
      // The view is handed over exactly as it is. Entering edit mode in Blender
      // does not move the viewport, and it should not here either: re-framing
      // on the way in threw away whatever the user had lined up, and combined
      // with the editor drawing the object at the origin it made entering edit
      // mode look like the whole scene had swung around.
      //
      // Nothing is transformed into the entity's local space any more — the
      // editor's scene is world-space, so the pose transfers straight across.
      geometryInitialView.current = {
        position: viewport.camera.position.toArray(),
        target: viewport.orbit.target.toArray(),
      };
    };
    // Synchronously when the viewport is up, which is every real case: the
    // panel mounts in the same commit and must find the pose already there.
    if (viewport.camera && viewport.orbit) focusAndCapture();
    else ensureViewport().then(focusAndCapture);
    return () => { cancelled = true; };
  }, [geometryEntityId]);

  // Sync local state when something else flips a layer toggle (today:
  // nothing else does, but the pub-sub path lets future tooling drive
  // it without coupling to React).
  useEffect(() => subscribeLayers(setLayers), []);
  useEffect(() => subscribeTerrainBrush(() => setTerrainBrushState({
    mode: getTerrainBrushMode(),
    settings: { ...getTerrainBrushSettings() },
    adjustment: getTerrainBrushAdjustment(),
  })), []);

  useEffect(() => {
    const container = containerRef.current;
    let disposed = false;

    ensureViewport().then((name) => {
      if (disposed) return;
      setBackend(name);
      const { width, height } = container.getBoundingClientRect();
      engine.setSize(width, height);
      resizeActiveCamera();
    });

    // Routed through the arbiter so it no-ops while the Game panel owns the
    // canvas — dockview keeps resizing a hidden tab's element, and two
    // observers feeding engine.setSize different numbers thrash the renderer.
    const observer = new ResizeObserver(([entry]) => {
      resizeSharedCanvas("viewport", entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);

    const onMode = (m) => setMode(m);
    modeListeners.add(onMode);

    const onMacro = (s) => setMacroState(s);
    macroListeners.add(onMacro);

    // React-side mirror of which camera entity is being previewed, so we can
    // show a small label over the WebGL preview quad. The label tracks the
    // camera component's own "show preview" flag — the label is the visible
    // counterpart of the PIP, so they appear/disappear together.
    const refreshPreviewLabel = () => {
      // The engine resolves asynchronously and this panel's mount effect can
      // beat it (reliably so after a page reload with a persisted dockview
      // layout). The `engine` proxy THROWS during that window, and a throw
      // inside a mount effect unmounts the whole React tree — so the symptom
      // is not an error banner but a viewport whose canvas never appears.
      // Bail quietly; the deferred subscribe below re-runs this the moment
      // the engine is up, so the label is never left stale.
      if (!isEngineReady()) return;
      if (engine.playing) {
        setPreviewEntityName(null);
        return;
      }
      // The PIP is a single-entity affordance — when more than one entity
      // is selected there's no canonical camera to preview, so clear the
      // label and let attachMultiSelection clear the WebGL side.
      const ids = useSelectionStore.getState().ids;
      if (ids.length !== 1) {
        setPreviewEntityName(null);
        return;
      }
      const id = ids[0];
      const ent = id ? engine.getEntity(id) : null;
      const cam = ent?.getComponent?.("camera");
      if (!cam) {
        setPreviewEntityName(null);
        return;
      }
      setPreviewEntityName(cam.props.showPreview === false ? null : ent.name);
      // Keep the WebGL preview's visibility in sync with the prop toggle
      // — setCamera already passed the component in, but a prop change
      // after attach needs a nudge so the frame goes hidden immediately.
      viewport.cameraPreview?.updateVisible();
    };
    refreshPreviewLabel();
    const unsubSel = useSelectionStore.subscribe(refreshPreviewLabel);
    // Engine-bound subscriptions are DEFERRED for the same reason the guard
    // above exists: `engine.on(...)` would throw if the engine hasn't resolved,
    // and here that throw is unrecoverable (it happens during the effect body,
    // so React tears the tree down instead of retrying).
    //
    // Re-evaluate preview visibility/label when any camera component prop
    // changes (the user toggled "Show preview" / follow checkboxes in the
    // inspector). The mirror in sceneStore doesn't refresh on prop
    // changes, so the only way to update the React-side label and the
    // hidden DOM frame is to listen for the engine's component-changed
    // signal emitted from Component.setProp.
    let unsubPlay = null;
    let unsubProp = null;
    let previewSubsCancelled = false;
    ensureEngine().then((eng) => {
      if (previewSubsCancelled) return;
      unsubPlay = eng.on("play-changed", refreshPreviewLabel);
      unsubProp = eng.on("component-changed", (info) => {
        if (info.componentType !== "camera") return;
        refreshPreviewLabel();
      });
      refreshPreviewLabel();
    });

    // The canvas is shared with the Game panel, so claim it rather than
    // appending it — the arbiter hands it back automatically when the Game
    // panel drops its higher-priority claim on Stop. Claiming is safe before
    // the canvas exists (it is created async on first mount).
    claimCanvas("viewport", container, 0);
    if (!viewport.canvas) ensureViewport();
    // Show a placeholder while the Game panel has the picture, so the viewport
    // tab reads as "deliberately empty" rather than broken.
    const unsubOwner = onCanvasOwnerChanged((owner) => {
      if (disposed) return;
      setCanvasElsewhere(owner !== null && owner !== "viewport");
      if (owner !== "viewport" || !viewport.canvas) return;
      // The Game panel letterboxes by writing inline width/height. Clear those
      // on the way back or the viewport keeps the game's aspect box forever —
      // the CSS class alone can't win against an inline style.
      viewport.canvas.style.width = "";
      viewport.canvas.style.height = "";
      const rect = container.getBoundingClientRect();
      resizeSharedCanvas("viewport", rect.width, rect.height);
    });

    const flushCameraPrefs = () => {
      clearTimeout(viewport.cameraPrefsSaveTimer);
      viewport.cameraPrefsSaveTimer = null;
      saveEditorCameraPrefs();
    };
    window.addEventListener("beforeunload", flushCameraPrefs);

    return () => {
      disposed = true;
      observer.disconnect();
      modeListeners.delete(onMode);
      macroListeners.delete(onMacro);
      unsubSel();
      // Null when the effect is torn down before the engine resolved — the
      // flag stops the pending `.then` from subscribing after unmount.
      previewSubsCancelled = true;
      unsubPlay?.();
      unsubProp?.();
      unsubOwner();
      window.removeEventListener("beforeunload", flushCameraPrefs);
      flushCameraPrefs();
      // Drop the claim instead of removing the node: if the Game panel is
      // holding it, yanking the canvas out of ITS container would blank the
      // running game just because the viewport tab was closed. Scoped to THIS
      // container so a late cleanup can't delete the next instance's claim.
      releaseCanvas("viewport", container);
    };
  }, []);

  return (
    <div
      className="viewport-panel"
      ref={(el) => {
        containerRef.current = el;
        dropRef(el);
      }}
      onPointerDown={(e) => {
        if (e.button === 2) rmbDownRef.current = { x: e.clientX, y: e.clientY };
      }}
      onContextMenu={(e) => {
        // The right button is also OrbitControls' pan/orbit gesture, so only a
        // right-click that didn't turn into a drag counts as "open the menu".
        // Either way the browser's own menu is suppressed.
        e.preventDefault();
        e.stopPropagation();
        const down = rmbDownRef.current;
        const dragged =
          down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
        // Shift+RMB is "place the 3D cursor" — already handled on pointerdown.
        // Edit/sculpt mode and the terrain brush own the viewport while active
        // and have their own gestures on the right button.
        if (dragged || e.shiftKey || playing) return;
        if (getTerrainBrushMode() || useGeometryEditStore.getState().entityId) return;
        setViewportMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {viewportMenu && (
        <ContextMenu
          x={viewportMenu.x}
          y={viewportMenu.y}
          items={viewportMenuItems()}
          onClose={() => setViewportMenu(null)}
        />
      )}
      <div className="viewport-toolbar">
        <button
          className={`toolbar-btn play-btn ${playing ? "active" : ""}`}
          title={playing ? "Stop (Ctrl+P)" : "Play (Ctrl+P)"}
          onClick={() => togglePlay()}
        >
          {playing ? <Square size={13} /> : <Play size={13} />}
        </button>
        {/* Pause freezes game time, not the render loop — the paused frame
            stays inspectable and Step advances it one slice at a time. */}
        {playing && (
          <>
            <button
              className={`toolbar-btn icon-only ${paused ? "active" : ""}`}
              title={paused ? "Resume (Ctrl+Shift+P)" : "Pause (Ctrl+Shift+P)"}
              onClick={() => togglePaused()}
            >
              <Pause size={13} />
            </button>
            <button
              className="toolbar-btn icon-only"
              title="Step one frame (Ctrl+.)"
              onClick={() => stepFrame()}
            >
              <StepForward size={13} />
            </button>
          </>
        )}
        <div className={`browser-preview-launcher ${browserPreview.urls ? "is-active" : ""} ${shareBusy ? "is-sharing" : ""}`}>
          <button
            className={`toolbar-btn icon-only ${browserPreview.urls ? "active" : ""}`}
            disabled={!rootPath || browserPreview.busy}
            title={browserPreview.urls
              ? "Stop browser preview server"
              : browserPreview.message || (playing
                ? "Stop Play mode, then build and serve it"
                : "Build and serve on localhost and local Wi-Fi over HTTPS")}
            onClick={launchBrowserPreview}
          >
            <Wifi size={13} />
          </button>
          {browserPreview.urls && (
            <div className="browser-preview-endpoints" aria-label="Browser preview links">
              {browserPreview.urls.lanUrl && (
                <span
                  className="browser-preview-endpoint"
                  role="button"
                  tabIndex={0}
                  title={`Open Wi-Fi HTTPS preview (phones/tablets)\n${browserPreview.urls.lanUrl}\nAccept the local certificate once on this device.`}
                  onClick={() => openPreviewEndpoint(browserPreview.urls.lanUrl)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") openPreviewEndpoint(browserPreview.urls.lanUrl);
                  }}
                >
                  <Smartphone size={13} />
                </span>
              )}
              {browserPreview.urls.localUrl && (
                <span
                  className="browser-preview-endpoint"
                  role="button"
                  tabIndex={0}
                  title={`Open localhost\n${browserPreview.urls.localUrl}`}
                  onClick={() => openPreviewEndpoint(browserPreview.urls.localUrl)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") openPreviewEndpoint(browserPreview.urls.localUrl);
                  }}
                >
                  <Monitor size={13} />
                </span>
              )}
              <span
                className={`browser-preview-endpoint ${browserPreview.share ? "active" : ""}`}
                role="button"
                tabIndex={0}
                title={shareBusy
                  ? browserPreview.message || "Creating public link…"
                  : browserPreview.share
                    ? `Stop public share link\n${browserPreview.share.url}`
                    : "Create a public share link anyone can open (Cloudflare quick tunnel)"}
                aria-label={browserPreview.share ? "Stop public share link" : "Create public share link"}
                onClick={toggleShareTunnel}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") toggleShareTunnel();
                }}
              >
                {shareBusy ? <Loader2 size={13} className="endpoint-spin" /> : <Share2 size={13} />}
              </span>
              {browserPreview.share && (
                <span
                  className="browser-preview-endpoint"
                  role="button"
                  tabIndex={0}
                  title={`Open public link (click also copies it)\n${browserPreview.share.url}`}
                  onClick={() => {
                    navigator.clipboard?.writeText(browserPreview.share.url).catch(() => {});
                    openPreviewEndpoint(browserPreview.share.url);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") openPreviewEndpoint(browserPreview.share.url);
                  }}
                >
                  <Link2 size={13} />
                </span>
              )}
              {browserPreviewQr && (
                <span
                  className="browser-preview-endpoint browser-preview-qr"
                  tabIndex={0}
                  title={browserPreview.share ? "Show public link QR code" : "Show Wi-Fi QR code"}
                  aria-label="Show preview QR code"
                >
                  <QrCode size={13} />
                  <span className="browser-preview-qr-popover">
                    <img src={browserPreviewQr} alt={`QR code for ${browserPreviewQrUrl}`} />
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
        {[
          ["translate", "Move (G)", Move],
          ["rotate", "Rotate (R)", Rotate3d],
          ["scale", "Scale (S)", Scale3d],
        ].map(([m, label, Icon]) => (
          <button
            key={m}
            className={`toolbar-btn icon-only ${mode === m ? "active" : ""}`}
            title={label}
            disabled={playing}
            onClick={() => setGizmoMode(m)}
          >
            <Icon size={14} />
          </button>
        ))}
        <div className="layers-dropdown dropdown-wrap">
          <button
            className={`toolbar-btn icon-only ${layersOpen ? "active" : ""}`}
            title="Layers"
            onClick={() => setLayersOpen((v) => !v)}
          >
            <LayersIcon size={14} />
          </button>
          {layersOpen && (
            <>
              <div
                className="dropdown-overlay"
                onClick={() => setLayersOpen(false)}
              />
              <div className="dropdown-menu layers-menu">
                {LAYER_TOGGLES.map(({ key, label }) => (
                  <button
                    key={key}
                    className="dropdown-item layers-item"
                    onClick={() => setLayerVisible(key, !layers[key])}
                  >
                    <span className="layers-item-label">
                      <span className={`layers-dot ${layers[key] ? "on" : "off"}`} />
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {playing && <span className="backend-badge playing">Playing</span>}
        {backend && <span className={`backend-badge ${backend === "WebGPU" ? "webgpu" : "webgl"}`}>{backend}</span>}
      </div>
      {canvasElsewhere && (
        <div className="viewport-canvas-moved">
          The Game panel is showing the running game — there is one renderer, shared.
          Stop, or close the Game tab, to get the viewport back.
        </div>
      )}
      {!playing && <AxisViewGizmo playing={playing} />}
      {macroState && (
        <div className="macro-hud">
          <span className="macro-hud-kind">{macroState.label}</span>
          {/* Active-axes chip. "—" when the macro is open on all three axes
              (Blender's no-lock state); otherwise the locked letter(s). */}
          <span className="macro-hud-axis">
            {macroState.axisStr || "—"}
          </span>
          {macroState.numStr && <span className="macro-hud-num">{macroState.numStr}</span>}
          <span className="macro-hud-hint">
            {macroState.interactive
              ? "drag to apply · click or ↵ commit · Esc cancel · ⌫ edit axes"
              : "↵ commit · Esc cancel · ⌫ edit value"}
          </span>
        </div>
      )}
      {terrainBrushState.mode && !playing && (
        <div className={`terrain-brush-hud ${terrainBrushState.adjustment ? "adjusting" : ""}`}>
          <span className="terrain-brush-hud-mode">{terrainBrushState.mode}</span>
          {terrainBrushState.mode === "sculpt" && <span>{terrainBrushState.settings.tool}</span>}
          <span>R {terrainBrushState.settings.radius.toFixed(2)}</span>
          <span>S {terrainBrushState.settings.strength.toFixed(2)}</span>
          {terrainBrushState.mode === "scatter" && <span>Spacing {terrainBrushState.settings.scatterSpacing.toFixed(2)}</span>}
          <span>H {terrainBrushState.settings.hardness.toFixed(2)}</span>
          <span className="terrain-brush-hud-hint">
            {terrainBrushState.adjustment
              ? `${terrainBrushState.adjustment.key}: move cursor · click/↵ confirm · RMB/Esc cancel`
              : terrainBrushState.mode === "scatter"
                ? "F size · Shift+F spacing · Ctrl+drag erase · B exit"
                : "F size · Shift+F strength · Ctrl+F hardness · B exit"}
          </span>
        </div>
      )}
      {!playing && <CursorHUD />}
      {previewEntityName && !playing && (
        <div className="camera-preview-label" title="Live render from the selected camera">
          <span className="dot" />
          {previewEntityName}
        </div>
      )}
      {geometryEntityId && !playing && (
        <div className="scene-geometry-editor-overlay">
          <GeometryEditorPanel
            embedded
            entityIdOverride={geometryEntityId}
            initialViewRef={geometryInitialView}
            onClose={() => useGeometryEditStore.getState().exit()}
          />
        </div>
      )}
      <StatsOverlay />
    </div>
  );
}
