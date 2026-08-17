import { useEffect, useRef, useState } from "react";
import { Box, Circle, CircleDot, Crosshair, Eye, Layers, Magnet, Move, Rotate3d, Scale3d, Scissors, Shapes, Square, Triangle, Undo2, Redo2, X } from "lucide-react";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { invalidateBlobUrl, writeBinaryFile } from "../assetLoader.js";
import { disposeOrReleaseGeometry } from "../../engine/geometryAsset.js";
import { authoredGeometry, ensureGeometryAsset, saveNewGeometryAsset } from "../geometryEditing.js";
import { invalidateVirtualGeometryAsset } from "../../modules/virtual-geometry/index.js";
import { BatchCommand, CreateEntityCommand } from "../commands/entityCommands.js";
import { AddComponentCommand, RemoveComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import { AssetField } from "../fields/AssetField.jsx";
import { AxisViewGizmo } from "../helpers/AxisViewGizmo.jsx";
import { isTypingTarget } from "../keyScope.js";
import { installWheelZoom } from "../viewportZoom.js";
import { GEOMETRY_MODIFIER_DEFINITIONS, createGeometryModifier } from "../../engine/geometryModifiers.js";
import { applyGeometryModifier } from "../geometryModifierEditing.js";

import { copyMesh, createMesh } from "../mesh/bmesh.js";
import { assetFromMesh, bufferGeometryFromMesh, meshFromBufferGeometry } from "../mesh/io.js";
import {
  SIMILAR_TYPES,
  checkerDeselect,
  clearSelection,
  convertSelection,
  edgeLoop,
  edgeRing,
  faceLoop,
  flushSelection,
  growSelection,
  invertSelection,
  linkedElements,
  selectAll,
  selectByTrait,
  selectRandom,
  selectSimilar,
  selected,
  selectedVerts,
  selectionCount,
  shortestPath,
  shrinkSelection,
} from "../mesh/select.js";
import {
  DELETE_MODES,
  MERGE_MODES,
  connectVertPath,
  deleteLoose,
  deleteSelection,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  duplicateSelection,
  limitedDissolve,
  makeEdgeFace,
  mergeByDistance,
  mergeSelection,
  ripVerts,
  separateSelection,
  splitSelection,
} from "../mesh/ops/edit.js";
import {
  extrudeAlongNormals,
  extrudeEdges,
  extrudeFaceRegion,
  extrudeFacesIndividual,
  extrudeVerts,
  insetFaces,
  shrinkFattenOffsets,
  updateCapUVs,
  updateSideUVs,
} from "../mesh/ops/extrude.js";
import { bevelEdges, knifeCut, loopCut, offsetEdgeLoop, subdivideFaces } from "../mesh/ops/topology.js";
import {
  bridgeEdgeLoops,
  bridgeFaces,
  fillHoles,
  flipNormals,
  gridFill,
  markEdges,
  markSharpByAngle,
  meshStatistics,
  pokeFaces,
  recalculateNormals,
  setShading,
  smoothVerts,
  spinEdges,
  symmetrize,
  triangulateFaces,
  trisToQuads,
} from "../mesh/ops/cleanup.js";
import {
  FALLOFFS,
  ORIENTATIONS,
  PIVOTS,
  SNAP_MODES,
  applySlide,
  constrainTranslation,
  constraintAxes,
  edgeSlideRails,
  falloffWeight,
  individualPivots,
  orientationBasis,
  proportionalDistances,
  snapTarget,
  transformPivot,
  vertSlideRails,
} from "../mesh/transform.js";
import {
  SELECT_COLOR,
  applyXray,
  cameraBasis,
  elementsInRegion,
  framingDistance,
  frameSphere,
  meshBoundingSphere,
  nearestEdgeOnFace,
  pickElement,
  pickFace,
  rebuildRenderMesh,
  refreshOverlays,
  refreshRenderPositions,
  refreshVertexMarkerScales,
  resizeGeometryCamera,
  selectionBoundingSphere,
} from "../mesh/viewport.js";
import { unwrapBox, unwrapPlanar } from "../mesh/ops/uv.js";
import { PRIMITIVES, addPrimitive } from "../mesh/ops/primitives.js";
import { ToolbarMenu, ToolbarMenuProvider } from "./GeometryToolbarMenu.jsx";
import {
  BRUSHES,
  DIRECTIONAL_BRUSHES,
  applyStrokeDab,
  averageEdgeLength,
  beginStroke,
  captureGrabWeights,
  refreshStroke,
  strokeDabPositions,
  surfaceNormalAt,
} from "../mesh/sculpt.js";
import { dyntopoStep } from "../mesh/ops/dyntopo.js";
import { suggestedVoxelSize, voxelRemesh } from "../mesh/ops/voxelRemesh.js";
import {
  PAINT_BLEND_MODES,
  createPaintLayer,
  dilateEdges,
  facesNearBrush,
  layerToDataURL,
  paintDab,
} from "../mesh/paint.js";
import { vertsInSphere } from "../mesh/sculpt.js";
import { useProjectStore } from "../store/projectStore.js";
import { attachCursor, detachCursor, getCursor3D, refreshCursor3D, setCursor3DPosition } from "../threeDCursor.js";
import { SetCursor3DCommand } from "../commands/cursorCommands.js";

const MODES = ["vert", "edge", "face"];
const SHADING_MODES = [
  { id: "wireframe", label: "Wireframe", hint: "Edges only; select through the surface" },
  { id: "solid", label: "Solid", hint: "Neutral studio material" },
  { id: "material", label: "Material Preview", hint: "Real materials with the scene environment" },
  { id: "rendered", label: "Rendered", hint: "Real materials lit by the scene's own lights" },
];
const MODE_LABELS = { vert: "Vertex", edge: "Edge", face: "Face" };
const UNDO_DEPTH = 64;

// Slot index is the geometry group index — the same eight keys the Mesh
// component and the Inspector's material section use.
const MATERIAL_SLOT_KEYS = [
  "material",
  ...Array.from({ length: 7 }, (_, index) => `material${index + 2}`),
];

function reloadGeometryUsers(path) {
  for (const candidate of engine.entities.values()) {
    const mesh = candidate.getComponent?.("mesh");
    if (mesh?.props.geometryAsset === path) mesh.setProp("geometryAsset", path);
  }
}

function hasEditorOnlyAncestor(object) {
  for (let current = object; current; current = current.parent) {
    if (current.userData?.editorOnly) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Camera views                                                                */
/* -------------------------------------------------------------------------- */

function usePerspectiveGeometryView(session) {
  const source = session.camera;
  const camera = session.perspectiveCamera;
  if (!source?.isOrthographicCamera || !camera) return;
  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.up.set(0, 1, 0);
  camera.near = source.near;
  camera.far = source.far;
  resizeGeometryCamera(camera, session.canvas.clientWidth, session.canvas.clientHeight);
  session.useCamera(camera);
  session.controls.update();
}

/** Smoothly tweens the orbit camera to a cardinal-axis orthographic view. */
function animateToAxis(session, axis, sign) {
  if (session.snapAnimation) cancelAnimationFrame(session.snapAnimation);
  const { controls } = session;
  const source = session.camera;
  // Local bounds, world camera: the object keeps its transform in edit mode.
  const sphere = meshBoundingSphere(session.mesh).applyMatrix4(session.meshObject.matrixWorld);
  const radius = Math.max(sphere.radius, 0.25);
  const target = sphere.center.clone();
  const endDirection = new THREE.Vector3(axis === "x" ? sign : 0, axis === "y" ? sign : 0, axis === "z" ? sign : 0).normalize();
  const endDistance = framingDistance(session.perspectiveCamera, radius);
  const startTarget = controls.target.clone();
  const startDirection = source.position.clone().sub(startTarget);
  const startDistance = startDirection.length() || endDistance;
  startDirection.normalize();
  const visibleHeight = source.isPerspectiveCamera
    ? (2 * startDistance * Math.tan(THREE.MathUtils.degToRad(source.fov * 0.5))) / source.zoom
    : session.orthographicHeight;
  session.orthographicHeight = Math.max(visibleHeight, radius * 2.2, 0.01);
  const camera = session.orthographicCamera ?? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1000);
  session.orthographicCamera = camera;
  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.up.copy(source.up);
  camera.near = source.near;
  camera.far = source.far;
  resizeGeometryCamera(camera, session.canvas.clientWidth, session.canvas.clientHeight, session.orthographicHeight);
  session.useCamera(camera);
  const startQuaternion = camera.quaternion.clone();
  const endUp = axis === "y" ? new THREE.Vector3(0, 0, sign > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
  const endPosition = target.clone().addScaledVector(endDirection, endDistance);
  const endQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(endPosition, target, endUp));
  // Pick the shorter arc so flipping from -X to +X does not whip through the
  // back of the model.
  if (startDirection.dot(endDirection) < -0.999) startDirection.set(endDirection.z, endDirection.x, -endDirection.y);
  const duration = 220;
  const startTime = performance.now();
  const tick = (now) => {
    const t = THREE.MathUtils.clamp((now - startTime) / duration, 0, 1);
    const eased = 1 - (1 - t) ** 3;
    const direction = startDirection.clone().lerp(endDirection, eased).normalize();
    const distance = THREE.MathUtils.lerp(startDistance, endDistance, eased);
    controls.target.copy(startTarget).lerp(target, eased);
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    camera.quaternion.slerpQuaternions(startQuaternion, endQuaternion, eased);
    controls.dispatchEvent({ type: "change" });
    if (t < 1) {
      session.snapAnimation = requestAnimationFrame(tick);
      return;
    }
    camera.position.copy(endPosition);
    camera.quaternion.copy(endQuaternion);
    camera.up.copy(endUp);
    session.snapAnimation = 0;
    session.orbitStartQuaternion = camera.quaternion.clone();
    session.useCamera(camera);
  };
  session.snapAnimation = requestAnimationFrame(tick);
}

/* -------------------------------------------------------------------------- */
/* Interactive macros                                                          */
/* -------------------------------------------------------------------------- */

const vec = (array) => new THREE.Vector3(array[0], array[1], array[2]);

/** Where a mesh-local point lands on screen, in client coordinates. */
function screenPointOf(session, point, camera, rect) {
  if (!point) return null;
  const projected = vec(point).applyMatrix4(session.meshObject.matrixWorld).project(camera);
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
  return {
    x: (projected.x + 1) * rect.width * 0.5 + rect.left,
    y: (-projected.y + 1) * rect.height * 0.5 + rect.top,
  };
}

/**
 * How much of the transform a vertex receives.
 *
 * Recomputed per frame rather than cached so the scroll wheel can resize the
 * influence circle mid-drag, as it does in Blender, and so `O` mid-drag turns
 * the falloff on and off — gated on `macro.proportional`, not merely on whether
 * distances were recorded, because the recorded distances outlive the toggle.
 *
 * Named `reach`, not `distance`: it used to shadow the drag distance in
 * `applyMacro`, and the per-vertex-offset branch multiplied by *this* instead.
 * With proportional editing off there are no recorded distances, so it was
 * `undefined * 1` — every vertex an inset, a shrink/fatten or an
 * extrude-along-normals moved went NaN, the faces vanished, and the NaN was
 * then written into the `.geom` (where it lands as `null` and reloads as UV
 * 0,0 — the zeroed UVs on disk).
 */
function macroWeight(macro, vert) {
  // Once proportional editing has run, `origins` also holds every vertex the
  // falloff reached. Those must go back to weight 0 — and so, via `applyMacro`,
  // back to their recorded origin — the instant it is switched off mid-drag,
  // or turning it off would leave the neighbourhood stuck where it was.
  const picked = !macro.movingVerts || macro.movingVerts.has(vert);
  if (!macro.proportional) return picked ? 1 : 0;
  const reach = macro.distances?.get(vert);
  if (reach === undefined) return picked ? 1 : 0;
  return falloffWeight(reach / Math.max(macro.radius, 1e-6), macro.falloff);
}

/**
 * Recomputes a macro's effect from its snapshot.
 *
 * Macros come in two families. Most only *move* vertices, so the topology is
 * created once and each frame just repositions from the recorded origins.
 * Bevel and loop cut change topology as their parameter changes, so they
 * re-run the operator against an untouched snapshot every frame — which is why
 * `macro.source` is never mutated.
 */
function applyMacro(session) {
  const macro = session.macro;
  if (!macro) return;
  const dx = macro.current.x - macro.start.x;
  const dy = macro.current.y - macro.start.y;
  const numeric = macro.buffer && !"-.".includes(macro.buffer) ? Number(macro.buffer) : null;
  const typed = numeric !== null && Number.isFinite(numeric) ? numeric : null;
  const fine = macro.fine ? 0.1 : 1;

  if (macro.kind === "bevel" || macro.kind === "loopcut") {
    rerunTopologyMacro(session, macro, dx, dy, typed, fine);
    return;
  }
  if (macro.kind === "edgeslide" || macro.kind === "vertslide") {
    const factor = typed ?? THREE.MathUtils.clamp((dx - dy) * 0.004 * fine, -1, 1);
    macro.factor = factor;
    applySlide(macro.rails, factor);
    session.preview();
    return;
  }

  const camera = session.camera;
  // Vertex positions are mesh-local, so the camera's world axes are converted
  // into the local displacement that produces a movement along them. Skipping
  // this drags a rotated object's vertices off along the world axes instead of
  // the ones under the cursor.
  const toLocalDirection = session.toLocalDirection ?? ((vector) => vector);
  // Kept unit-length so the pixels-to-units factor below is the only thing that
  // sets the distance travelled.
  const right = toLocalDirection(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)).normalize();
  const up = toLocalDirection(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)).normalize();
  const viewAxis = toLocalDirection(camera.getWorldDirection(new THREE.Vector3())).normalize();
  const rect = session.canvas.getBoundingClientRect();
  // How much world a pixel covers at the depth being edited. Derived from the
  // real viewport height and lens rather than a fixed 800px, so a drag means
  // the same thing whichever way the panel has been resized — then expressed in
  // local units, so a scaled object moves with the mouse rather than by its
  // scale factor times the mouse.
  const viewportHeight = Math.max(rect.height, 1);
  const depth = Math.max(camera.position.distanceTo(session.controls.target), 0.1);
  const worldPerPixel = (camera.isOrthographicCamera
    ? (camera.top - camera.bottom) / Math.max(camera.zoom, 1e-6) / viewportHeight
    : (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) / viewportHeight) * fine
    * (session.localPerWorld ?? 1);
  const directions = constraintAxes(macro.basis, macro.axis);

  let translation = new THREE.Vector3();
  let angle = 0;
  let factor = 1;
  let distance = 0;

  if (macro.kind === "translate" || macro.kind === "extrude" || macro.kind === "inset" || macro.kind === "shrinkfatten") {
    if (macro.offsets) {
      // Each vertex travels along its own direction (inset, shrink/fatten,
      // extrude along normals), so the drag resolves to a single scalar.
      if (macro.kind === "inset") {
        // Blender measures an inset from how far the pointer sits from the
        // centre of the selection, not from how far it has travelled. That
        // difference matters: with travelled distance every direction thickens
        // and nothing thins, so the only way back is to overshoot and the
        // collapse point sits barely a hundred pixels from the start — one
        // ordinary flick of the mouse and the face was gone. Measured from the
        // centre, moving out thickens and moving back in thins, and the
        // thickness is wherever you are pointing rather than an accumulated
        // total.
        const centre = screenPointOf(session, macro.pivot, camera, rect);
        const reach = centre
          ? Math.hypot(macro.current.x - centre.x, macro.current.y - centre.y)
            - Math.hypot(macro.start.x - centre.x, macro.start.y - centre.y)
          : Math.hypot(dx, dy);
        distance = typed ?? reach * worldPerPixel;
        const ceiling = macro.maxThickness ?? Infinity;
        // Clamped to just inside where the inset ring collapses; past that the
        // cap inverts and grows back mirrored, which reads as the face vanishing.
        distance = Math.min(Math.max(distance, 0), ceiling);
      } else {
        distance = typed ?? (dx - dy) * worldPerPixel;
      }
      macro.amount = distance;
    } else if (typed !== null) {
      const axis = directions?.[0] ?? macro.normal ?? [right.x, right.y, right.z];
      translation.copy(vec(axis)).multiplyScalar(typed);
    } else if (macro.kind === "extrude" && !macro.free && !macro.axis) {
      // A face extrude defaults to travelling along the region normal.
      const axis = vec(macro.normal);
      const projected = dx * axis.dot(right) - dy * axis.dot(up);
      const screenAligned = Math.abs(axis.dot(right)) + Math.abs(axis.dot(up)) > 0.08 ? projected : dx - dy;
      translation.copy(axis).multiplyScalar(screenAligned * worldPerPixel);
    } else {
      translation.copy(right).multiplyScalar(dx * worldPerPixel).addScaledVector(up, -dy * worldPerPixel);
      const constrained = constrainTranslation([translation.x, translation.y, translation.z], directions);
      translation.set(constrained[0], constrained[1], constrained[2]);
    }
  } else if (macro.kind === "rotate") {
    angle = typed !== null ? THREE.MathUtils.degToRad(typed) : (dx - dy) * 0.01 * fine;
  } else if (macro.kind === "scale") {
    factor = typed !== null ? typed : Math.max(0.001, 1 + (dx - dy) * 0.01 * fine);
  }

  const rotationAxis = directions?.length === 1 ? vec(directions[0]) : viewAxis;
  const quaternion = new THREE.Quaternion().setFromAxisAngle(rotationAxis, angle);
  const scaleAxes = directions;

  for (const [vert, origin] of macro.origins) {
    const point = vec(origin);
    const weight = macroWeight(macro, vert);
    if (weight <= 0) {
      vert.co = [...origin];
      continue;
    }
    const pivot = vec(macro.pivots?.get(vert) ?? macro.pivot);
    if (macro.offsets) {
      const offset = macro.offsets.get(vert);
      if (offset) point.addScaledVector(vec(offset), distance * weight);
    } else if (macro.kind === "rotate") {
      const weighted = new THREE.Quaternion().setFromAxisAngle(rotationAxis, angle * weight);
      point.sub(pivot).applyQuaternion(weight === 1 ? quaternion : weighted).add(pivot);
    } else if (macro.kind === "scale") {
      point.sub(pivot);
      const amount = THREE.MathUtils.lerp(1, factor, weight);
      if (scaleAxes) {
        for (const axis of scaleAxes) {
          const along = vec(axis);
          const projected = point.dot(along);
          point.addScaledVector(along, projected * (amount - 1));
        }
      } else point.multiplyScalar(amount);
      point.add(pivot);
    } else {
      point.addScaledVector(translation, weight);
    }
    vert.co = [point.x, point.y, point.z];
  }

  // The side strips of an extrude or inset grow as the drag proceeds, so their
  // UVs are re-measured each frame rather than baked at zero size — and an
  // inset's cap keeps shrinking under a fixed mapping, so it is re-read from
  // that mapping for the same reason.
  if (macro.sides?.length) updateSideUVs(macro.sides);
  if (macro.reprojected?.length) updateCapUVs(macro.reprojected);

  // Snapping runs after the drag so it corrects the final position.
  macro.snapPoint = null;
  if (session.snapEnabled && macro.kind !== "rotate" && macro.kind !== "scale" && macro.origins.size) {
    const anchor = macro.snapAnchor ?? [...macro.origins.keys()][0];
    const target = snapTarget(session.mesh, anchor.co, {
      mode: session.snapMode,
      increment: session.snapIncrement,
      absolute: session.snapAbsolute,
      pixelRadius: session.snapPixelRadius ?? 28,
      origin: macro.origins.get(anchor),
      // Only the elements the user is actually dragging are excluded. With
      // proportional editing on, `origins` also holds every vertex inside the
      // influence circle, and excluding all of those would leave a wide
      // transform with nothing left to snap to.
      moving: macro.movingVerts ?? new Set(macro.origins.keys()),
      // Ranked against the mouse in screen space, as Blender's magnet is.
      pointer: macro.current,
      project: (co) => screenPointOf(session, co, camera, rect),
    });
    if (target) {
      const delta = [target.point[0] - anchor.co[0], target.point[1] - anchor.co[1], target.point[2] - anchor.co[2]];
      // Weighted, so a snap under proportional editing drags the falloff with
      // it instead of shunting the whole influenced region rigidly.
      for (const vert of macro.origins.keys()) {
        const weight = macroWeight(macro, vert);
        if (weight <= 0) continue;
        vert.co = [vert.co[0] + delta[0] * weight, vert.co[1] + delta[1] * weight, vert.co[2] + delta[2] * weight];
      }
      macro.snapPoint = target.point;
      macro.snapKind = target.kind;
    }
  }
  session.preview();
}

/** Bevel and loop cut: rebuild the whole result from the untouched snapshot. */
function rerunTopologyMacro(session, macro, dx, dy, typed, fine) {
  const { mesh } = copyMesh(macro.source);
  session.mesh = mesh;
  session.active = null;
  if (macro.kind === "bevel") {
    // Radial, for the same reason as inset: a bevel width cannot be negative,
    // so a signed diagonal drag left half the directions doing nothing.
    const width = typed ?? Math.max(0.0001, macro.initialWidth + Math.hypot(dx, dy) * 0.002 * fine);
    macro.amount = width;
    bevelEdges(mesh, selected(mesh, "edge"), { width, segments: macro.segments });
  } else {
    const seed = [...mesh.edges].find((edge) => edge.id === macro.seedId);
    if (seed) {
      const slide = macro.locked ? THREE.MathUtils.clamp((dx - dy) * 0.003 * fine, -0.95, 0.95) : 0;
      macro.slide = slide;
      loopCut(mesh, seed, { cuts: macro.segments, slide });
    }
  }
  session.rebuild();
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `initialViewRef` is a *ref* holding `{ position, target }`, not a plain prop.
 * The scene below is built in a passive effect, which runs after the commit
 * that mounted this panel; a pose passed as state from the parent's layout
 * effect only arrives on the next render, one render too late to be read. A ref
 * is already filled in by then, so the viewport's pose transfers verbatim and
 * entering edit mode does not move the camera.
 */
export function GeometryEditorPanel({ embedded = false, entityIdOverride = null, initialViewRef = null, onClose = null } = {}) {
  const selectedEntityId = useSelectionStore((state) => state.ids[0] ?? null);
  const entityId = entityIdOverride ?? selectedEntityId;
  const rootRef = useRef(null);
  const hostRef = useRef(null);
  const toolbarRef = useRef(null);
  const toolbarScrollRef = useRef(null);
  const sessionRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());

  const [mode, setMode] = useState("face");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [macroState, setMacroState] = useState(null);
  const [showSceneContext, setShowSceneContext] = useState(embedded);
  const [proportional, setProportional] = useState(false);
  const [proportionalConnected, setProportionalConnected] = useState(true);
  const [falloff, setFalloff] = useState("smooth");
  const [pivot, setPivot] = useState("median");
  const [orientation, setOrientation] = useState("global");
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [snapMode, setSnapMode] = useState("increment");
  const [snapIncrement, setSnapIncrement] = useState(0.25);
  // Blender's "Absolute Grid Snap": off by default, where increment snapping
  // rounds how far you have travelled rather than where you have ended up.
  const [snapAbsolute, setSnapAbsolute] = useState(false);
  const [xray, setXray] = useState(false);
  const [selectionTool, setSelectionTool] = useState(null);
  const [selectionGesture, setSelectionGesture] = useState(null);
  const [faceMaterial, setFaceMaterial] = useState(0);
  // How many material slot rows the list shows beyond the assigned ones — the
  // "+" button's state. The assigned slots always show regardless.
  const [slotRows, setSlotRows] = useState(1);
  const [cuts, setCuts] = useState(1);
  const [snapView, setSnapView] = useState(null);
  const [pendingChord, setPendingChord] = useState(null);
  const [stats, setStats] = useState(null);
  const [knifePoints, setKnifePoints] = useState(null);
  // Blender's Shift+A: a primitive menu that opens where the mouse is.
  const [addMenu, setAddMenu] = useState(null);
  // Which single header menu is open. One `<details>` per menu could not do
  // this: the element has no notion of a menu bar, so opening one never closed
  // the others and the header ended up with six overlapping popovers.
  const [openMenu, setOpenMenu] = useState(null);

  // Sculpt mode
  const [editorMode, setEditorMode] = useState("edit");
  const [brush, setBrush] = useState("draw");
  const [brushRadius, setBrushRadius] = useState(0.25);
  const [brushStrength, setBrushStrength] = useState(0.4);
  const [brushFalloff, setBrushFalloff] = useState("smooth");
  const [symmetry, setSymmetry] = useState({ x: false, y: false, z: false });
  const [dyntopo, setDyntopo] = useState(true);
  const [detailSize, setDetailSize] = useState(0.08);
  const [dyntopoMode, setDyntopoMode] = useState("both");
  const [brushCursor, setBrushCursor] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [remeshDetail, setRemeshDetail] = useState(0);
  const [paintColor, setPaintColor] = useState("#d84a3f");
  const [paintBlend, setPaintBlend] = useState("mix");
  const [paintResolution, setPaintResolution] = useState(1024);
  const [busy, setBusy] = useState(false);
  const [shading, setShading] = useState("solid");

  const entity = entityId ? engine.getEntity(entityId) : null;
  const component = entity?.getComponent("mesh");

  useEffect(() => {
    if (sessionRef.current?.context) sessionRef.current.context.visible = showSceneContext;
  }, [showSceneContext]);

  // The Add menu dismisses on any click that is not one of its own entries.
  useEffect(() => {
    if (!addMenu) return undefined;
    const dismiss = () => setAddMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [addMenu]);

  /* ---------------------------------------------------------------------- */
  /* Session plumbing                                                        */
  /* ---------------------------------------------------------------------- */

  const touch = () => setRevision((value) => value + 1);

  const refreshStats = (session) => setStats(meshStatistics(session.mesh));

  const autosave = (session = sessionRef.current) => {
    if (!session || !entityId) return;
    let contents;
    try {
      // `assetFromMesh` refuses a mesh carrying non-finite coordinates. Better
      // to leave the last good file on disk and say so than to overwrite it
      // with one that will not reopen.
      contents = JSON.stringify(assetFromMesh(session.mesh), null, 2);
    } catch (error) {
      setStatus(`Not saved: ${error.message}`);
      console.error(error);
      return;
    }
    // Update Object Mode immediately; the disk write can land afterwards
    // without making a Tab-out look like it discarded the edit.
    const liveMesh = engine.getEntity(entityId)?.getComponent("mesh")?.mesh;
    if (liveMesh) {
      const previous = liveMesh.geometry;
      liveMesh.geometry = bufferGeometryFromMesh(session.mesh);
      // `previous` may be the shared `.geom` instance (geometryAsset.js) that
      // other meshes are still rendering — release rather than dispose.
      disposeOrReleaseGeometry(previous);
    }
    setStatus("Autosaving geometry...");
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      const path = await ensureGeometryAsset(entityId);
      if (!path) throw new Error("Geometry asset is unavailable");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_scene", { path, contents });
      invalidateBlobUrl(path);
      // The cluster DAG cached for this asset indexes the triangles that were
      // just replaced; drop it before the reload re-virtualizes from the new
      // ones, or the mesh renders a LOD cut of the mesh it used to be.
      invalidateVirtualGeometryAsset(path);
      reloadGeometryUsers(path);
      if (rootRef.current) setStatus(`Autosaved ${path.split(/[\\/]/).pop()}`);
    }).catch((error) => {
      if (rootRef.current) setStatus(`Autosave failed: ${error}`);
    });
  };

  const pushUndo = (session, label) => {
    session.history.push({ mesh: copyMesh(session.mesh).mesh, mode: session.mode, label });
    if (session.history.length > UNDO_DEPTH) session.history.shift();
    session.future.length = 0;
  };

  /** Runs a mesh operator as one undoable step. */
  const runOperator = (label, operation) => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    pushUndo(session, label);
    const result = operation(session) ?? {};
    if (result.error) {
      // Nothing changed, so the undo entry would be a no-op step.
      session.history.pop();
      setStatus(result.error);
      return;
    }
    session.active = session.mesh.verts.has(session.active) || session.mesh.edges.has(session.active) || session.mesh.faces.has(session.active)
      ? session.active
      : null;
    session.rebuild();
    autosave(session);
    if (result.message) setStatus(result.message);
    else setStatus(label);
  };

  const undo = () => {
    const session = sessionRef.current;
    const previous = session?.history.pop();
    if (!previous) return;
    session.future.push({ mesh: copyMesh(session.mesh).mesh, mode: session.mode, label: previous.label });
    session.mesh = previous.mesh;
    session.mode = previous.mode;
    session.active = null;
    setMode(previous.mode);
    session.rebuild();
    autosave(session);
    setStatus(`Undo: ${previous.label}`);
  };

  const redo = () => {
    const session = sessionRef.current;
    const next = session?.future.pop();
    if (!next) return;
    session.history.push({ mesh: copyMesh(session.mesh).mesh, mode: session.mode, label: next.label });
    session.mesh = next.mesh;
    session.mode = next.mode;
    session.active = null;
    setMode(next.mode);
    session.rebuild();
    autosave(session);
    setStatus(`Redo: ${next.label}`);
  };

  /* ---------------------------------------------------------------------- */
  /* Modes and selection                                                     */
  /* ---------------------------------------------------------------------- */

  const changeMode = (next) => {
    const session = sessionRef.current;
    if (session && session.mode !== next) {
      convertSelection(session.mesh, session.mode, next);
      session.mode = next;
      session.active = null;
      refreshOverlays(session);
    }
    setMode(next);
    touch();
  };

  const withSelection = (label, operation) => runOperator(label, (session) => {
    const result = operation(session);
    refreshOverlays(session);
    return result;
  });

  /** Selection edits are undoable but never dirty the asset. */
  const runSelection = (label, operation) => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    operation(session);
    refreshOverlays(session);
    setStatus(label);
    touch();
  };

  const doSelectAll = () => runSelection("Select All", (session) => selectAll(session.mesh, session.mode));
  const doSelectNone = () => runSelection("Deselect All", (session) => {
    clearSelection(session.mesh);
    session.active = null;
  });
  const doInvert = () => runSelection("Invert Selection", (session) => invertSelection(session.mesh, session.mode));
  const doGrow = () => runSelection("Select More", (session) => growSelection(session.mesh, session.mode));
  const doShrink = () => runSelection("Select Less", (session) => shrinkSelection(session.mesh, session.mode));
  const doSelectLinkedAll = () => runSelection("Select Linked", (session) => {
    const seeds = session.mode === "face" ? selected(session.mesh, "face")
      : session.mode === "edge" ? selected(session.mesh, "edge")
        : selectedVerts(session.mesh, "vert");
    for (const seed of seeds) {
      for (const element of linkedElements(session.mesh, seed, session.mode)) element.select = true;
    }
    flushSelection(session.mesh, session.mode);
  });
  const doSelectSimilar = (type) => runSelection(`Select Similar`, (session) => selectSimilar(session.mesh, session.mode, type));
  const doSelectTrait = (trait, options) => runSelection(`Select ${trait}`, (session) => selectByTrait(session.mesh, session.mode, trait, options));
  const doCheckerDeselect = () => runSelection("Checker Deselect", (session) => checkerDeselect(session.mesh, session.mode));
  const doSelectRandom = () => runSelection("Select Random", (session) => selectRandom(session.mesh, session.mode, 0.5));

  /* ---------------------------------------------------------------------- */
  /* Macros                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Blender's proportional influence circle, in client coordinates: a ring
   * around the transform centre whose radius is the proportional size. Without
   * it the only clue that proportional editing is on at all is a number in the
   * corner, and the wheel appears to do nothing.
   */
  const proportionalCircle = (session, macro) => {
    if (!macro?.proportional || !session.canvas) return null;
    const rect = session.canvas.getBoundingClientRect();
    const centre = screenPointOf(session, macro.pivot, session.camera, rect);
    if (!centre) return null;
    const right = session.toLocalDirection
      ? session.toLocalDirection(new THREE.Vector3().setFromMatrixColumn(session.camera.matrixWorld, 0)).normalize()
      : new THREE.Vector3(1, 0, 0);
    const rim = screenPointOf(session, [
      macro.pivot[0] + right.x * macro.radius,
      macro.pivot[1] + right.y * macro.radius,
      macro.pivot[2] + right.z * macro.radius,
    ], session.camera, rect);
    if (!rim) return null;
    return { x: centre.x, y: centre.y, r: Math.hypot(rim.x - centre.x, rim.y - centre.y) };
  };

  const publishMacro = (session) => {
    const macro = session.macro;
    setMacroState(macro && {
      kind: macro.kind,
      label: macro.label,
      axis: macro.axis,
      buffer: macro.buffer,
      amount: macro.amount,
      segments: macro.segments,
      factor: macro.factor,
      locked: macro.locked,
      free: macro.free,
      orientation: session.orientation,
      proportional: macro.proportional,
      radius: macro.radius,
      circle: proportionalCircle(session, macro),
      snapKind: macro.snapPoint ? macro.snapKind : null,
      snapAt: macro.snapPoint && session.canvas
        ? screenPointOf(session, macro.snapPoint, session.camera, session.canvas.getBoundingClientRect())
        : null,
    });
  };

  /**
   * `O` during a transform, as in Blender. Turning it on part-way needs the
   * distance field built right then — the vertices it will reach were never
   * recorded, and a vertex that is not in `origins` can never move.
   */
  const toggleMacroProportional = (session) => {
    const macro = session.macro;
    // Inset, shrink/fatten and extrude-along-normals give every vertex its own
    // direction; there is no single displacement for a falloff to scale.
    if (!macro || macro.offsets) return;
    macro.proportional = !macro.proportional;
    session.proportional = macro.proportional;
    setProportional(macro.proportional);
    if (macro.proportional && !macro.distances) {
      const seeds = [...(macro.movingVerts ?? macro.origins.keys())];
      macro.distances = proportionalDistances(session.mesh, seeds, { connected: session.proportionalConnected });
      for (const vert of macro.distances.keys()) {
        if (!macro.origins.has(vert)) macro.origins.set(vert, [...vert.co]);
      }
      for (const vert of seeds) macro.distances.set(vert, 0);
    }
    applyMacro(session);
    publishMacro(session);
  };

  /**
   * Starts an interactive transform. `topology` optionally runs an operator
   * first (extrude, inset) and reports which vertices should follow the mouse.
   */
  const startMacro = (kind, label, options = {}) => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    const snapshot = copyMesh(session.mesh).mesh;
    let moving = options.verts ?? null;
    let offsets = options.offsets ?? null;
    let normal = options.normal ?? [0, 0, 1];
    let sides = null;
    let reprojected = null;
    let maxThickness = null;

    if (options.topology) {
      const result = options.topology(session);
      if (!result || result.error) {
        setStatus(result?.error ?? "Nothing to do");
        return;
      }
      moving = result.verts;
      offsets = result.perVertexOffsets ?? result.individualNormals ?? null;
      normal = result.normal ?? normal;
      sides = result.sides ?? null;
      reprojected = result.reprojected ?? null;
      maxThickness = result.maxThickness ?? null;
      session.rebuild();
    }
    if (!moving) moving = selectedVerts(session.mesh, session.mode);
    if (!moving.length) {
      setStatus("Nothing selected");
      return;
    }

    const origins = new Map(moving.map((vert) => [vert, [...vert.co]]));
    let distances = null;
    // Blender carries the proportional size from one transform to the next
    // rather than re-deriving it, so a size you dialled in with the wheel is
    // still there on the following move. Only the very first one is seeded
    // from the mesh, so it is sane on a trinket and on a terrain alike.
    if (!session.proportionalSize) session.proportionalSize = Math.max(meshBoundingSphere(session.mesh).radius * 0.6, 0.25);
    const radius = session.proportionalSize;
    if (session.proportional && !offsets) {
      // Every vertex that could *ever* come under the influence circle is
      // recorded now, because the radius is live: scrolling during the drag
      // changes it, and a vertex that was not in `origins` could never start
      // moving. Weights themselves are recomputed each frame from the radius.
      distances = proportionalDistances(session.mesh, moving, { connected: session.proportionalConnected });
      for (const vert of distances.keys()) {
        if (!origins.has(vert)) origins.set(vert, [...vert.co]);
      }
      for (const vert of moving) distances.set(vert, 0);
    }

    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    session.macro = {
      kind,
      label,
      source: snapshot,
      origins,
      distances,
      radius,
      falloff: session.falloff,
      proportional: session.proportional && !offsets,
      offsets,
      normal,
      free: options.free ?? false,
      axis: "",
      buffer: "",
      fine: false,
      basis: orientationBasis(session.mesh, session.mode, session.orientation, { viewBasis: cameraBasis(session.camera, session) }),
      pivot: transformPivot(session.mesh, session.mode, session.pivot, { cursor: localCursor(), active: session.active }),
      pivots: session.pivot === "individual" ? individualPivots(session.mesh, session.mode) : null,
      sides,
      reprojected,
      maxThickness,
      // The vertices the user actually picked, as distinct from `origins`,
      // which proportional editing widens to the whole influence region.
      movingVerts: new Set(moving),
      snapAnchor: session.active && origins.has(session.active) ? session.active : moving[0],
      beforeMode: session.mode,
      segments: options.segments ?? 1,
      initialWidth: options.width ?? 0.05,
      amount: 0,
      rails: options.rails ?? null,
      seedId: options.seedId ?? null,
      locked: options.locked ?? false,
      start: { ...pointer },
      current: { ...pointer },
    };
    session.controls.enabled = false;
    if (kind === "bevel" || kind === "loopcut") applyMacro(session);
    publishMacro(session);
    touch();
  };

  const commitMacro = () => {
    const session = sessionRef.current;
    if (!session?.macro) return;
    session.history.push({ mesh: session.macro.source, mode: session.macro.beforeMode, label: session.macro.label });
    if (session.history.length > UNDO_DEPTH) session.history.shift();
    session.future.length = 0;
    session.macro = null;
    session.controls.enabled = true;
    session.rebuild();
    setMacroState(null);
    autosave(session);
  };

  const cancelMacro = () => {
    const session = sessionRef.current;
    if (!session?.macro) return;
    session.mesh = session.macro.source;
    session.mode = session.macro.beforeMode;
    session.active = null;
    setMode(session.mode);
    session.macro = null;
    session.controls.enabled = true;
    session.rebuild();
    setMacroState(null);
  };

  /* ---------------------------------------------------------------------- */
  /* Operator bindings                                                       */
  /* ---------------------------------------------------------------------- */

  const localCursor = () => {
    const owner = engine.getEntity(entityId);
    if (!owner?.object3D) return [0, 0, 0];
    owner.object3D.updateWorldMatrix(true, false);
    const point = new THREE.Vector3().fromArray(getCursor3D().position).applyMatrix4(owner.object3D.matrixWorld.clone().invert());
    return [point.x, point.y, point.z];
  };

  /**
   * Blender's Add Mesh: the primitive lands at the 3D cursor, arrives as the
   * only selection, and switches the header to whichever select mode it has
   * elements in (a circle has no faces).
   */
  const doAddPrimitive = (kind) => {
    setAddMenu(null);
    sessionRef.current?.canvas?.focus();
    const entry = PRIMITIVES.find((item) => item.id === kind);
    runOperator(`Add ${entry?.label ?? kind}`, (session) => {
      const result = addPrimitive(session.mesh, kind, { at: localCursor(), material: faceMaterial });
      if (result.error) return result;
      if (result.mode !== session.mode) {
        session.mode = result.mode;
        setMode(result.mode);
      }
      session.active = null;
      return { message: `Added ${entry?.label ?? kind} · ${result.added.verts}v ${result.added.edges}e ${result.added.faces}f` };
    });
  };

  /* ---------------------------------------------------------------------- */
  /* Modifier stack                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The non-destructive stack — Blender's wrench tab — surfaced in the header.
   *
   * It is a component (`geometryModifiers`) and has always been reachable from
   * the Inspector, but nothing in the modelling workspace said so, which is
   * exactly where you go looking for it. Editing the stack from here matters
   * for a second reason too: the modifiers evaluate *on top of* what this panel
   * edits, so being able to see a subdivision or an array while cutting the
   * cage is the whole point of them being non-destructive.
   */
  const modifiers = entity?.getComponent?.("geometryModifiers") ?? null;

  const addModifiers = async () => {
    const { commandBus } = await import("../commands/CommandBus.js");
    commandBus.execute(new AddComponentCommand(entityId, "geometryModifiers"));
    sessionRef.current?.refreshModifierPreview?.();
    touch();
    setStatus("Added a modifier stack");
  };

  const removeModifiers = async () => {
    const { commandBus } = await import("../commands/CommandBus.js");
    commandBus.execute(new RemoveComponentCommand(entityId, "geometryModifiers"));
    sessionRef.current?.refreshModifierPreview?.();
    touch();
    setStatus("Removed the modifier stack");
  };

  const setModifierStack = async (value, label = "Edit modifiers") => {
    const { commandBus } = await import("../commands/CommandBus.js");
    commandBus.execute(new SetComponentPropCommand(entityId, "geometryModifiers", "modifiers", value, label));
    sessionRef.current?.refreshModifierPreview?.();
    touch();
  };

  const updateModifier = (index, patch, label = "Edit modifier") => setModifierStack(
    (modifiers?.props.modifiers ?? []).map((modifier, current) => current === index ? { ...modifier, ...patch } : modifier),
    label,
  );

  const moveModifier = (index, delta) => {
    const stack = [...(modifiers?.props.modifiers ?? [])];
    const target = index + delta;
    if (target < 0 || target >= stack.length) return;
    [stack[index], stack[target]] = [stack[target], stack[index]];
    setModifierStack(stack, "Reorder modifiers");
  };

  const applyModifier = async (modifier) => {
    // Capture the exact baked cage before the command removes the selected
    // stack prefix. Edit Mode owns an in-memory BMesh, so leaving it on the old
    // authored cage would make the remaining modifier preview jump backwards
    // until the newly written asset finished reloading.
    const session = sessionRef.current;
    let bakedMesh = null;
    let bakedGeometry = null;
    let currentCage = null;
    try {
      currentCage = session ? bufferGeometryFromMesh(session.mesh) : null;
      bakedGeometry = modifiers?.evaluateThroughModifier?.(modifier, currentCage ?? undefined) ?? null;
      if (bakedGeometry) bakedMesh = meshFromBufferGeometry(bakedGeometry);
    } catch {
      // `applyGeometryModifier` owns the user-facing error path. This snapshot
      // only keeps the editor cage synchronized after a successful bake.
      bakedMesh = null;
    } finally {
      bakedGeometry?.dispose?.();
    }
    const result = await applyGeometryModifier(entityId, modifier.id, { sourceGeometry: currentCage });
    currentCage?.dispose?.();
    if (result.ok && session && bakedMesh) {
      session.history.push({ mesh: copyMesh(session.mesh).mesh, mode: session.mode, label: `Apply ${modifier.type}` });
      session.future.length = 0;
      session.mesh = bakedMesh;
      session.active = null;
      session.rebuild();
    }
    setStatus(result.message);
    touch();
  };

  /** Entity references serve both mesh operands and transform-only controls. */
  const modifierEntityCandidates = (meshOnly = false) => [...engine.entities.values()]
    .filter((candidate) => candidate.id !== entityId && (!meshOnly || candidate.getComponent?.("mesh")))
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));

  const startExtrude = (variant = "region") => {
    const session = sessionRef.current;
    if (!session) return;
    const mode = session.mode;
    startMacro("extrude", `Extrude ${MODE_LABELS[mode]}`, {
      free: mode !== "face" || variant === "free",
      topology: (value) => {
        if (mode === "face") {
          if (variant === "individual") return extrudeFacesIndividual(value.mesh);
          if (variant === "normals") return extrudeAlongNormals(value.mesh);
          return extrudeFaceRegion(value.mesh);
        }
        if (mode === "edge") return extrudeEdges(value.mesh);
        return extrudeVerts(value.mesh);
      },
    });
  };

  const startInset = (individual = false) => startMacro("inset", individual ? "Inset Individual" : "Inset Faces", {
    topology: (session) => (session.mode === "face" ? insetFaces(session.mesh, selected(session.mesh, "face"), { individual }) : { error: "Inset needs a face selection" }),
  });

  const startShrinkFatten = () => {
    const session = sessionRef.current;
    if (!session) return;
    startMacro("shrinkfatten", "Shrink/Fatten", { offsets: shrinkFattenOffsets(session.mesh, session.mode) });
  };

  const startBevel = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.mode !== "edge" || !selectionCount(session.mesh, "edge")) {
      setStatus("Bevel needs an edge selection");
      return;
    }
    // A one-segment bevel is a plain chamfer and necessarily uses the old
    // single-polygon corner cap. Starting every Ctrl+B there made the rounded
    // corner-grid topology in topology.js look as though it was never used.
    // Keep Blender's "last operator setting" behaviour, with four segments as
    // the first-use default so a rounded bevel exposes the distributed quad
    // corner immediately.
    startMacro("bevel", "Bevel Edges", {
      width: 0.05,
      segments: session.bevelSegments ?? 4,
      verts: selectedVerts(session.mesh, "edge"),
    });
  };

  const startLoopCut = () => {
    const session = sessionRef.current;
    const hit = session?.raycastAtLast?.();
    if (!session || !hit) {
      setStatus("Hover an edge ring to loop cut");
      return;
    }
    const face = pickFace(session, hit);
    const seed = face && nearestEdgeOnFace(face, hit.point);
    if (!seed) return;
    session.mode = "edge";
    setMode("edge");
    startMacro("loopcut", "Loop Cut", { seedId: seed.id, segments: 1, verts: [seed.v1, seed.v2], locked: false });
  };

  const startEdgeSlide = () => {
    const session = sessionRef.current;
    if (!session) return;
    const rails = edgeSlideRails(session.mesh, selected(session.mesh, "edge"));
    if (rails.error) {
      setStatus(rails.error);
      return;
    }
    startMacro("edgeslide", "Edge Slide", { verts: [...rails.rails.keys()], rails: rails.rails });
  };

  /**
   * Vertex Slide: each selected vertex travels along the edges it sits on.
   *
   * The two rails are the first two connected edges; the drag direction then
   * chooses between them via the slide factor's sign, which is the same
   * -1..1 convention edge slide uses.
   */
  const startVertSlide = () => {
    const session = sessionRef.current;
    if (!session) return;
    const rails = new Map();
    for (const vert of selectedVerts(session.mesh, session.mode)) {
      const result = vertSlideRails(vert);
      if (result.error || result.rails.length < 1) continue;
      rails.set(vert, {
        origin: [...vert.co],
        a: result.rails[0].target,
        b: (result.rails[1] ?? result.rails[0]).target,
      });
    }
    if (!rails.size) {
      setStatus("Those vertices have no edges to slide along");
      return;
    }
    startMacro("vertslide", "Vertex Slide", { verts: [...rails.keys()], rails });
  };

  /** Blender's G G: a second G within the double-tap window starts a slide. */
  const startMoveOrSlide = () => {
    const session = sessionRef.current;
    if (!session) return;
    const now = performance.now();
    const isDoubleTap = session.lastMoveKey && now - session.lastMoveKey < 400;
    session.lastMoveKey = now;
    if (!isDoubleTap) {
      startMacro("translate", "Move");
      return;
    }
    session.lastMoveKey = 0;
    if (session.mode === "edge") startEdgeSlide();
    else startVertSlide();
  };

  const doDelete = (kind) => runOperator(`Delete ${kind}`, (session) => {
    const removed = deleteSelection(session.mesh, session.mode, kind);
    session.active = null;
    return { message: `Deleted ${removed} ${kind}` };
  });

  const doDissolve = (kind) => runOperator(`Dissolve ${kind}`, (session) => {
    if (kind === "verts") return { message: `Dissolved ${dissolveVerts(session.mesh)} vertices` };
    if (kind === "edges") return { message: `Dissolved ${dissolveEdges(session.mesh)} edges` };
    if (kind === "faces") return { message: `Dissolved ${dissolveFaces(session.mesh)} regions` };
    return { message: `Limited dissolve removed ${limitedDissolve(session.mesh, { selectionOnly: selectionCount(session.mesh, session.mode) > 0 })} edges` };
  });

  const doMerge = (kind) => runOperator(`Merge ${kind}`, (session) => {
    const result = mergeSelection(session.mesh, session.mode, kind, { cursor: localCursor(), active: session.active });
    if (result.error) return result;
    session.active = null;
    session.mode = "vert";
    setMode("vert");
    return { message: `Merged ${result.merged ?? 0} vertices` };
  });

  const doMergeByDistance = () => runOperator("Merge by Distance", (session) => ({
    message: `Removed ${mergeByDistance(session.mesh, 0.0001, { mode: session.mode, selectionOnly: selectionCount(session.mesh, session.mode) > 0 })} doubles`,
  }));

  const doMakeEdgeFace = () => runOperator("Make Edge/Face", (session) => {
    const result = makeEdgeFace(session.mesh, session.mode);
    if (result.error) return result;
    if (result.created === "face") {
      session.mode = "face";
      setMode("face");
    } else {
      session.mode = "edge";
      setMode("edge");
    }
    return { message: `Created ${result.created}` };
  });

  const doSubdivide = () => runOperator("Subdivide", (session) => {
    const faces = selected(session.mesh, "face");
    const result = subdivideFaces(session.mesh, faces, cuts);
    return result.error ? result : { message: `Subdivided ${result.faces} faces` };
  });

  const doRip = (fill) => runOperator(fill ? "Rip Fill" : "Rip", (session) => {
    const camera = session.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const created = ripVerts(session.mesh, selectedVerts(session.mesh, session.mode), [right.x, right.y, right.z], { fill });
    if (!created.length) return { error: "Nothing to rip there" };
    session.mode = "vert";
    setMode("vert");
    return { message: `Ripped ${created.length} vertices` };
  });

  /**
   * Separate by Selection (P). The extracted faces leave this mesh and become a
   * sibling entity carrying its own `.geom` asset, matching Blender's P >
   * Selection. The asset write is asynchronous, so the entity is created once
   * the file exists and the source edit is saved independently.
   */
  const doSeparate = () => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    const owner = engine.getEntity(entityId);
    if (!owner) return;
    const probe = separateSelection(copyMesh(session.mesh).mesh, createMesh);
    if (probe.error) {
      setStatus(probe.error);
      return;
    }
    runOperator("Separate", (value) => {
      const result = separateSelection(value.mesh, createMesh);
      if (result.error) return result;
      value.separated = result.mesh;
      return { message: `Separated ${result.faces} faces` };
    });
    const extracted = session.separated;
    session.separated = null;
    if (!extracted) return;
    (async () => {
      try {
        const path = await saveNewGeometryAsset(`${owner.name} Part`, extracted);
        const { commandBus } = await import("../commands/CommandBus.js");
        commandBus.execute(new CreateEntityCommand({
          name: `${owner.name} Part`,
          parentId: owner.parent?.id ?? null,
          transform: owner.getTransform(),
          components: [{ type: "mesh", props: { geometryAsset: path, material: component.props.material ?? "" } }],
        }));
        setStatus(`Separated into ${path.split(/[\\/]/).pop()}`);
      } catch (error) {
        setStatus(`Separate failed: ${error}`);
      }
    })();
  };

  const doDuplicate = () => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    const snapshot = copyMesh(session.mesh).mesh;
    const result = duplicateSelection(session.mesh, session.mode);
    if (result.error) {
      setStatus(result.error);
      return;
    }
    session.rebuild();
    // Blender hands a duplicate straight to a move, so it can be placed at once.
    startMacro("translate", "Duplicate", { verts: result.verts });
    if (session.macro) session.macro.source = snapshot;
  };

  const doUnwrap = (kind) => runOperator(`Unwrap ${kind}`, (session) => {
    if (kind === "planar") unwrapPlanar(session.mesh, "z");
    else unwrapBox(session.mesh);
    return { message: `Unwrapped (${kind})` };
  });

  const doAssignMaterial = () => runOperator("Assign Material", (session) => {
    let count = 0;
    for (const face of selected(session.mesh, "face")) {
      face.material = faceMaterial;
      count++;
    }
    return count ? { message: `Assigned slot ${faceMaterial + 1} to ${count} faces` } : { error: "Select faces first" };
  });

  /* ------------------------- Material slot list -------------------------- */

  // A different entity means a different slot list; carrying the previous
  // mesh's active slot over would assign faces to a slot that may not exist.
  useEffect(() => {
    setFaceMaterial(0);
    setSlotRows(1);
  }, [entityId]);

  /**
   * The entity's real materials are borrowed once when the editor scene is
   * built, so a slot change would leave Material Preview showing the old
   * surface until the panel reopened. The mesh component reloads its material
   * asynchronously after the prop commit; polling briefly and re-borrowing
   * when the array's identity changes is the simplest hook that cannot miss
   * the load, whatever path it takes.
   */
  const watchRealMaterials = () => {
    const until = performance.now() + 3000;
    const tick = () => {
      const session = sessionRef.current;
      if (!session) return;
      const source = component?.mesh?.material;
      if (source) {
        const next = Array.isArray(source) ? [...source] : source;
        const changed = Array.isArray(next)
          ? !Array.isArray(session.realMaterials) || next.some((entry, index) => entry !== session.realMaterials[index])
          : next !== session.realMaterials;
        if (changed) {
          session.realMaterials = next;
          // The dispose path must know these are the entity's own materials —
          // disposing a borrowed material blanks the mesh in Object Mode.
          for (const material of Array.isArray(next) ? next : [next]) session.borrowedMaterials?.add(material);
          if (session.shading === "material" || session.shading === "rendered") applyShading(session, session.shading);
        }
      }
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    tick();
  };

  const slotValues = MATERIAL_SLOT_KEYS.map((key) => component?.props?.[key] ?? "");
  const filledSlots = MATERIAL_SLOT_KEYS.reduce((last, key, index) => (component?.props?.[key] ? index + 1 : last), 0);
  const slotCount = Math.min(MATERIAL_SLOT_KEYS.length, Math.max(1, filledSlots, slotRows));

  const commitSlots = async (next, label) => {
    const { commandBus } = await import("../commands/CommandBus.js");
    // Only the slots that actually changed become commands, so a removal's
    // renumbered tail does not bury the undo entry in no-op writes.
    const commands = [];
    MATERIAL_SLOT_KEYS.forEach((key, index) => {
      const value = next[index] ?? "";
      if (value !== slotValues[index]) commands.push(new SetComponentPropCommand(entityId, "mesh", key, value));
    });
    if (commands.length) commandBus.execute(commands.length === 1 ? commands[0] : new BatchCommand(commands, label));
    // Committing from a portalled picker leaves focus on <body>, where every
    // editor shortcut is dead until the canvas is clicked — refocus instead.
    sessionRef.current?.canvas?.focus();
    watchRealMaterials();
  };

  const setSlot = (index, value) => {
    const next = [...slotValues];
    next[index] = value;
    commitSlots(next, index === 0 ? "Set material" : `Set material slot ${index + 1}`);
  };

  const addSlot = () => {
    if (slotCount >= MATERIAL_SLOT_KEYS.length) return;
    setSlotRows(slotCount + 1);
    // Blender activates the slot it just added.
    setFaceMaterial(slotCount);
  };

  /**
   * Removes the ACTIVE slot, Blender style: later slots shift up, faces using
   * them follow, and faces that used the removed slot fall back to the first.
   * The face renumber goes through the geometry undo stack and the prop shift
   * through the app history — two stacks, so a Ctrl+Z in the editor restores
   * the faces first and the slot paths on the next undo in the Inspector.
   */
  const removeActiveSlot = () => {
    if (slotCount <= 1) return;
    const index = Math.min(faceMaterial, slotCount - 1);
    runOperator(`Remove material slot ${index + 1}`, (session) => {
      let moved = 0;
      for (const face of session.mesh.faces) {
        if (face.material === index) {
          face.material = 0;
          moved++;
        } else if (face.material > index) {
          face.material -= 1;
          moved++;
        }
      }
      return { message: `Removed slot ${index + 1}${moved ? `, ${moved} faces renumbered` : ""}` };
    });
    const next = [...slotValues];
    next.splice(index, 1);
    next.push("");
    commitSlots(next, `Remove material slot ${index + 1}`);
    setSlotRows(Math.max(1, slotCount - 1));
    setFaceMaterial(Math.max(0, Math.min(index, slotCount - 2)));
  };

  /** Blender's Select / Deselect under the slot list. */
  const doSelectBySlot = (select) => runSelection(select ? "Select by Slot" : "Deselect by Slot", (session) => {
    for (const face of session.mesh.faces) {
      if (face.material === faceMaterial) face.select = select;
    }
    flushSelection(session.mesh, "face");
  });

  const doMark = (property, value, label) => runOperator(label, (session) => ({
    message: `${label}: ${markEdges(session.mesh, property, value, selected(session.mesh, "edge"))} edges`,
  }));

  const doShading = (smooth) => runOperator(smooth ? "Shade Smooth" : "Shade Flat", (session) => ({
    message: `${smooth ? "Smooth" : "Flat"} on ${setShading(session.mesh, smooth, selected(session.mesh, "face"))} faces`,
  }));

  const doRecalculate = (inside) => runOperator(inside ? "Recalculate Inside" : "Recalculate Outside", (session) => {
    const faces = selected(session.mesh, "face");
    return { message: `Recalculated ${recalculateNormals(session.mesh, { inside, faces: faces.length ? faces : null })} faces` };
  });

  const doSmooth = () => runOperator("Smooth Vertices", (session) => ({
    message: `Smoothed ${smoothVerts(session.mesh, selectedVerts(session.mesh, session.mode), { factor: 0.5, repeat: 1 })} vertices`,
  }));

  const doSymmetrize = (direction) => runOperator("Symmetrize", (session) => ({
    message: `Mirrored ${symmetrize(session.mesh, direction)} vertices`,
  }));

  /* ---------------------------------------------------------------------- */
  /* Keymap                                                                  */
  /* ---------------------------------------------------------------------- */

  const handleKeyDown = (event) => {
    const session = sessionRef.current;
    if (!session) return;
    if (event.target.closest("input, textarea, select")) return;
    if (addMenu) {
      event.preventDefault();
      event.stopPropagation();
      setAddMenu(null);
      return;
    }
    // Edit mode owns its grammar; stop scene-level Delete/duplicate/undo too.
    event.stopPropagation();
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    const consume = () => event.preventDefault();

    // --- Chord follow-ups (Ctrl+E, Ctrl+V, Ctrl+F, M, Shift+S ...) ---------
    if (pendingChord) {
      consume();
      const chord = pendingChord;
      setPendingChord(null);
      runChord(chord, key, event);
      return;
    }

    // --- Active macro -----------------------------------------------------
    if (session.macro) {
      const macro = session.macro;
      if (key === "escape") { consume(); cancelMacro(); return; }
      if (key === "enter" || key === " ") { consume(); commitMacro(); return; }
      if (event.shiftKey && !"xyz".includes(key)) macro.fine = true;
      if ("xyz".includes(key)) {
        consume();
        // Shift+X is "every axis but X" — Blender's plane constraint.
        const plane = { x: "yz", y: "xz", z: "xy" }[key];
        const wanted = event.shiftKey ? plane : key;
        macro.axis = macro.axis === wanted ? "" : wanted;
        applyMacro(session);
        publishMacro(session);
        return;
      }
      if (key === "o") {
        consume();
        if (event.altKey) {
          // Written straight onto the session as well: the React state only
          // reaches it through an effect, and the distance field is rebuilt
          // on this line, before that effect has run.
          session.proportionalConnected = !session.proportionalConnected;
          setProportionalConnected(session.proportionalConnected);
          macro.distances = null;
          if (macro.proportional) {
            macro.proportional = false;
            toggleMacroProportional(session);
          }
        } else toggleMacroProportional(session);
        return;
      }
      if (key === "tab" && event.shiftKey) { consume(); setSnapEnabled((value) => !value); return; }
      if (key === "backspace") {
        consume();
        macro.buffer = macro.buffer.slice(0, -1);
        applyMacro(session);
        publishMacro(session);
        return;
      }
      if (/^[0-9.-]$/.test(key)) {
        if (key === "-" && macro.buffer) return;
        if (key === "." && macro.buffer.includes(".")) return;
        consume();
        macro.buffer += key;
        applyMacro(session);
        publishMacro(session);
      }
      return;
    }

    // --- Paint ------------------------------------------------------------
    if (session.painting) {
      if (key === "tab" && embedded && onClose) { consume(); onClose(); return; }
      if (key === "[") { consume(); setBrushRadius((value) => Math.max(value * 0.85, 0.001)); return; }
      if (key === "]") { consume(); setBrushRadius((value) => Math.min(value * 1.18, 100)); return; }
      if (ctrl && key === "z") { consume(); undoPaintStroke(); return; }
      if (key === "z" && !ctrl) { consume(); cycleShading(event.shiftKey); return; }
      if (key === ".") { consume(); focusGeometry(); return; }
      return;
    }

    // --- Sculpt -----------------------------------------------------------
    if (session.sculpting) {
      if (key === "tab" && embedded && onClose) { consume(); onClose(); return; }
      if (key === "[") { consume(); setBrushRadius((value) => Math.max(value * 0.85, 0.001)); return; }
      if (key === "]") { consume(); setBrushRadius((value) => Math.min(value * 1.18, 100)); return; }
      if (key === "{") { consume(); setBrushStrength((value) => Math.max(value - 0.05, 0.01)); return; }
      if (key === "}") { consume(); setBrushStrength((value) => Math.min(value + 0.05, 2)); return; }
      if (ctrl && key === "z" && event.shiftKey) { consume(); redo(); return; }
      if (ctrl && key === "z") { consume(); undo(); return; }
      if (key === "." ) { consume(); focusGeometry(); return; }
      if (key === "d") { consume(); setDyntopo((value) => !value); return; }
      if (key === "z" && !ctrl) { consume(); cycleShading(event.shiftKey); return; }
      // Blender's brush hotkeys, as far as they do not collide.
      const byKey = { x: "draw", c: "clay", i: "inflate", s: "smooth", f: "flatten", r: "scrape", p: "pinch", g: "grab", n: "nudge" };
      if (!ctrl && !event.altKey && byKey[key]) { consume(); setBrush(byKey[key]); return; }
      return;
    }

    // --- Knife ------------------------------------------------------------
    if (session.knife) {
      if (key === "escape") { consume(); cancelKnife(); return; }
      if (key === "enter") { consume(); confirmKnife(); return; }
      return;
    }
    if (key === "k" && !ctrl) { consume(); startKnife(); return; }

    // --- Selection tools --------------------------------------------------
    if (key === "escape" && (session.selectionTool || session.selectionGesture)) { consume(); cancelSelectionTool(); return; }

    // --- Chord starters ---------------------------------------------------
    if (ctrl && key === "e") { consume(); setPendingChord("edge"); setStatus("Edge menu: B bevel · R loop cut · S mark seam · Shift+S clear seam · H mark sharp · Shift+H clear sharp · G slide · J bridge · F grid fill"); return; }
    if (ctrl && key === "v") { consume(); setPendingChord("vertex"); setStatus("Vertex menu: M merge · S smooth · R rip · F rip fill · Y split · C connect"); return; }
    if (ctrl && key === "f") { consume(); setPendingChord("face"); setStatus("Face menu: I inset · E extrude · P poke · T triangulate · J tris to quads · S shade smooth · Shift+S shade flat"); return; }
    if (!ctrl && event.altKey && key === "e") { consume(); setPendingChord("extrude"); setStatus("Extrude: E region · I individual · N along normals · V vertices"); return; }
    if (!ctrl && event.shiftKey && key === "s") { consume(); setPendingChord("snap"); setStatus("Snap: C cursor to selection · S selection to cursor · O cursor to origin"); return; }
    if (!ctrl && event.shiftKey && key === "g") { consume(); setPendingChord("similar"); setStatus("Select Similar: pick a trait from the Select menu"); return; }
    // Blender opens Add as a menu at the mouse, not as a chord.
    if (!ctrl && event.shiftKey && key === "a") {
      consume();
      const at = session.lastPointer ?? { x: 0, y: 0 };
      setAddMenu({ x: at.x, y: at.y });
      return;
    }
    if (!ctrl && key === "m" && !event.shiftKey) { consume(); setPendingChord("merge"); setStatus("Merge: C center · U cursor · L collapse · F first · A last · D by distance"); return; }
    if (!ctrl && (key === "x" || key === "delete" || key === "backspace")) { consume(); setPendingChord("delete"); setStatus("Delete: V vertices · E edges · F faces · O only faces · D dissolve verts · G dissolve edges · S dissolve faces · L limited dissolve"); return; }

    // --- Modes ------------------------------------------------------------
    if (["1", "2", "3"].includes(event.key) && !ctrl) { consume(); changeMode(MODES[Number(event.key) - 1]); return; }

    // --- Undo / redo ------------------------------------------------------
    if (ctrl && key === "z" && event.shiftKey) { consume(); redo(); return; }
    if (ctrl && key === "y") { consume(); redo(); return; }
    if (ctrl && key === "z") { consume(); undo(); return; }

    // --- Selection --------------------------------------------------------
    if (ctrl && key === "i") { consume(); doInvert(); return; }
    if (ctrl && key === "l") { consume(); doSelectLinkedAll(); return; }
    if (ctrl && (event.code === "NumpadAdd" || event.code === "Equal" || event.key === "+")) { consume(); doGrow(); return; }
    if (ctrl && (event.code === "NumpadSubtract" || event.code === "Minus" || event.key === "-")) { consume(); doShrink(); return; }
    if (ctrl && key === "r") { consume(); startLoopCut(); return; }
    if (key === "a" && !ctrl) { consume(); event.altKey ? doSelectNone() : doSelectAll(); return; }
    if (key === "l" && !ctrl) { consume(); selectLinkedUnderCursor(); return; }
    if (key === "b" && !ctrl) { consume(); armSelectionTool("box"); return; }
    if (key === "c" && !ctrl) { consume(); armSelectionTool("circle"); return; }

    // --- Transforms -------------------------------------------------------
    if (key === "g" && !ctrl) { consume(); startMoveOrSlide(); return; }
    if (key === "r" && !ctrl) { consume(); startMacro("rotate", "Rotate"); return; }
    if (key === "s" && event.altKey) { consume(); startShrinkFatten(); return; }
    if (key === "s" && !ctrl) { consume(); startMacro("scale", "Scale"); return; }
    if (key === "e" && !ctrl && !event.altKey) { consume(); startExtrude("region"); return; }
    if (key === "i" && !ctrl) { consume(); startInset(event.shiftKey); return; }
    if (key === "v" && !ctrl) { consume(); doRip(false); return; }
    if (key === "y" && !ctrl) { consume(); withSelection("Split", (value) => splitSelection(value.mesh, value.mode)); return; }
    if (key === "p" && !ctrl) { consume(); doSeparate(); return; }
    if (key === "f" && !ctrl && !event.altKey) { consume(); doMakeEdgeFace(); return; }
    if (key === "j" && !ctrl) { consume(); withSelection("Connect Vertex Path", (value) => connectVertPath(value.mesh)); return; }
    if (event.shiftKey && key === "d") { consume(); doDuplicate(); return; }
    if (event.shiftKey && key === "n") { consume(); doRecalculate(event.ctrlKey); return; }
    if (event.altKey && key === "n") { consume(); runOperator("Flip Normals", (value) => ({ message: `Flipped ${flipNormals(value.mesh, selected(value.mesh, "face"))} faces` })); return; }
    if (ctrl && key === "t") { consume(); runOperator("Triangulate", (value) => ({ message: `Triangulated ${triangulateFaces(value.mesh, selected(value.mesh, "face"))} faces` })); return; }
    if (event.altKey && key === "j") { consume(); runOperator("Tris to Quads", (value) => ({ message: `Merged ${trisToQuads(value.mesh, { faces: selected(value.mesh, "face") })} quads` })); return; }
    if (ctrl && event.shiftKey && key === "r") { consume(); startOffsetLoop(); return; }
    if (ctrl && key === "b") { consume(); startBevel(); return; }

    // --- Transform options (Blender's header toggles) ----------------------
    if (key === "o" && !ctrl) {
      consume();
      if (event.altKey) setProportionalConnected((value) => !value);
      else setProportional((value) => !value);
      return;
    }
    if (event.key === "Tab" && event.shiftKey) { consume(); setSnapEnabled((value) => !value); return; }

    // --- View -------------------------------------------------------------
    if (event.altKey && key === "z") { consume(); toggleXray(); return; }
    if (key === "z" && !ctrl && !event.altKey) { consume(); cycleShading(event.shiftKey); return; }
    if (key === "f" && event.altKey) { consume(); runOperator("Fill Holes", (value) => ({ message: `Filled ${fillHoles(value.mesh).filled} holes` })); return; }
    if (key === "." && !ctrl) { consume(); focusSelection(); return; }
    if (key === "home") { consume(); focusGeometry(); return; }
    if (!ctrl && !event.altKey && ["Numpad1", "Numpad3", "Numpad7", "Numpad4", "Numpad6", "Numpad9"].includes(event.code)) {
      consume();
      const map = { Numpad1: ["z", 1], Numpad9: ["z", -1], Numpad3: ["x", 1], Numpad7: ["x", -1], Numpad6: ["y", 1], Numpad4: ["y", -1] };
      const [axis, sign] = map[event.code];
      handleAxisSnap(axis, sign);
      return;
    }
    if (event.key === "Tab" && embedded && onClose) { consume(); onClose(); }
  };

  /** Second key of a two-key chord. */
  const runChord = (chord, key, event) => {
    const shift = event.shiftKey;
    if (chord === "delete") {
      if (key === "v") return doDelete("verts");
      if (key === "e") return doDelete("edges");
      if (key === "f") return doDelete("faces");
      if (key === "o") return doDelete("onlyFaces");
      if (key === "d") return doDissolve("verts");
      if (key === "g") return doDissolve("edges");
      if (key === "s") return doDissolve("faces");
      if (key === "l") return doDissolve("limited");
      return setStatus("");
    }
    if (chord === "merge") {
      if (key === "c") return doMerge("center");
      if (key === "u") return doMerge("cursor");
      if (key === "l") return doMerge("collapse");
      if (key === "f") return doMerge("first");
      if (key === "a") return doMerge("last");
      if (key === "d") return doMergeByDistance();
      return setStatus("");
    }
    if (chord === "extrude") {
      if (key === "e") return startExtrude("region");
      if (key === "i") return startExtrude("individual");
      if (key === "n") return startExtrude("normals");
      if (key === "v") return startExtrude("free");
      return setStatus("");
    }
    if (chord === "edge") {
      if (key === "b" && !shift) return startBevel();
      if (key === "r") return startLoopCut();
      if (key === "s") return doMark("seam", !shift, shift ? "Clear Seam" : "Mark Seam");
      if (key === "h") return doMark("sharp", !shift, shift ? "Clear Sharp" : "Mark Sharp");
      if (key === "g") return startEdgeSlide();
      if (key === "f") return withSelection("Grid Fill", (value) => gridFill(value.mesh, selected(value.mesh, "edge")));
      // With faces selected Blender bridges the two face regions, deleting
      // them; with edges it bridges the loops directly. Same menu entry, same
      // shortcut.
      if (key === "j") return withSelection("Bridge Edge Loops", (value) => (
        value.mode === "face" && selected(value.mesh, "face").length
          ? bridgeFaces(value.mesh)
          : bridgeEdgeLoops(value.mesh, selected(value.mesh, "edge"))
      ));
      return setStatus("");
    }
    if (chord === "vertex") {
      if (key === "m") return doMerge("center");
      if (key === "s") return doSmooth();
      if (key === "r") return doRip(false);
      if (key === "f") return doRip(true);
      if (key === "y") return withSelection("Split", (value) => splitSelection(value.mesh, value.mode));
      if (key === "c") return withSelection("Connect Vertex Path", (value) => connectVertPath(value.mesh));
      return setStatus("");
    }
    if (chord === "face") {
      if (key === "i") return startInset(false);
      if (key === "e") return startExtrude("region");
      if (key === "p") return runOperator("Poke Faces", (value) => ({ message: `Poked ${pokeFaces(value.mesh, selected(value.mesh, "face"))} faces` }));
      if (key === "t") return runOperator("Triangulate", (value) => ({ message: `Triangulated ${triangulateFaces(value.mesh, selected(value.mesh, "face"))} faces` }));
      if (key === "j") return runOperator("Tris to Quads", (value) => ({ message: `Merged ${trisToQuads(value.mesh, { faces: selected(value.mesh, "face") })} quads` }));
      if (key === "s") return doShading(!shift);
      return setStatus("");
    }
    if (chord === "snap") {
      if (key === "c") return snapCursorToSelection();
      if (key === "s") return snapSelectionToCursor();
      if (key === "o") return resetCursorToOrigin();
      return setStatus("");
    }
    if (chord === "similar") {
      const types = SIMILAR_TYPES[sessionRef.current?.mode ?? "face"];
      const match = types.find((entry) => entry.id[0] === key);
      if (match) return doSelectSimilar(match.id);
      return setStatus("");
    }
    return setStatus("");
  };

  const startOffsetLoop = () => {
    const session = sessionRef.current;
    const hit = session?.raycastAtLast?.();
    if (!session || !hit) return;
    const face = pickFace(session, hit);
    const seed = face && nearestEdgeOnFace(face, hit.point);
    if (!seed) return;
    runOperator("Offset Edge Loop", (value) => {
      const target = [...value.mesh.edges].find((edge) => edge.id === seed.id);
      return target ? offsetEdgeLoop(value.mesh, target, { factor: 0.5 }) : { error: "Lost the seed edge" };
    });
  };

  const selectLinkedUnderCursor = () => {
    const session = sessionRef.current;
    const hit = session?.raycastAtLast?.();
    if (!session || !hit) return;
    const element = pickElement(session, hit);
    if (!element) return;
    runSelection("Select Linked", (value) => {
      for (const linked of linkedElements(value.mesh, element, value.mode)) linked.select = true;
      flushSelection(value.mesh, value.mode);
    });
  };

  /* ---------------------------------------------------------------------- */
  /* 3D cursor                                                               */
  /* ---------------------------------------------------------------------- */

  const snapSelectionToCursor = () => runOperator("Selection to Cursor", (session) => {
    const verts = selectedVerts(session.mesh, session.mode);
    if (!verts.length) return { error: "Nothing selected" };
    const target = localCursor();
    const center = verts.reduce((sum, vert) => [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]], [0, 0, 0]).map((value) => value / verts.length);
    const delta = [target[0] - center[0], target[1] - center[1], target[2] - center[2]];
    for (const vert of verts) vert.co = [vert.co[0] + delta[0], vert.co[1] + delta[1], vert.co[2] + delta[2]];
    return { message: "Selection moved to the 3D cursor" };
  });

  const snapCursorToSelection = async () => {
    const session = sessionRef.current;
    if (!session) return;
    const verts = selectedVerts(session.mesh, session.mode);
    if (!verts.length) {
      setStatus("Nothing selected");
      return;
    }
    const center = verts.reduce((sum, vert) => [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]], [0, 0, 0]).map((value) => value / verts.length);
    const owner = engine.getEntity(entityId);
    if (!owner?.object3D) return;
    owner.object3D.updateWorldMatrix(true, false);
    const world = new THREE.Vector3(center[0], center[1], center[2]).applyMatrix4(owner.object3D.matrixWorld);
    setCursor3DPosition(world);
    setStatus("3D cursor moved to the selection");
  };

  const resetCursorToOrigin = async () => {
    const before = getCursor3D().position;
    if (!before[0] && !before[1] && !before[2]) return;
    const { commandBus } = await import("../commands/CommandBus.js");
    commandBus.execute(new SetCursor3DCommand([0, 0, 0], before));
    setStatus("3D cursor reset");
  };

  /* ---------------------------------------------------------------------- */
  /* Texture painting                                                        */
  /* ---------------------------------------------------------------------- */

  const hexToRGB = (hex) => {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };

  /**
   * Creates the paint target on demand and shows it on the mesh.
   *
   * The layer is a plain RGBA buffer wrapped in a DataTexture, so painting
   * writes straight into the texture's own memory and an upload is one
   * `needsUpdate` rather than a re-encode.
   */
  const ensurePaintLayer = (session) => {
    const size = session.paintResolution ?? paintResolution;
    if (session.paintLayer && session.paintLayer.size === size) return session.paintLayer;
    const layer = createPaintLayer(size, [230, 230, 230, 255]);
    const texture = new THREE.DataTexture(layer.data, layer.size, layer.size, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Left un-flipped: `flipY` on a data texture costs a full-texture blit pass
    // on every upload, and a stroke uploads per pointer move. `paint.js` writes
    // in texture order to match.
    texture.flipY = false;
    texture.needsUpdate = true;
    session.paintTexture?.dispose?.();
    session.paintMaterial?.dispose?.();
    session.paintLayer = layer;
    session.paintTexture = texture;
    session.paintMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
    // Changing the resolution mid-session builds a fresh layer, texture and
    // material; without this the surface would keep showing the disposed one.
    if (session.painting) session.meshObject.material = session.paintMaterial;
    return layer;
  };

  /** Faces the brush can reach, narrowed through the sculpt spatial index. */
  const paintFaces = (session, center) => {
    const stroke = session.stroke;
    const radius = session.brushRadius;
    if (stroke?.index) {
      const faces = new Set();
      for (const { vert } of vertsInSphere(stroke.index, center, radius)) {
        for (const edge of vert.edges) for (const loop of edge.loops) faces.add(loop.f);
      }
      // A brush smaller than the face it sits on reaches no vertex at all.
      if (faces.size) return [...faces];
    }
    return facesNearBrush(session.mesh, center, radius);
  };

  const beginPaintStroke = (session, hit, modifiers) => {
    ensurePaintLayer(session);
    session.paintUndo = session.paintLayer.data.slice();
    session.stroke = beginStroke(session.mesh, { radius: session.brushRadius, brush: "paint", spacing: 0.2 });
    session.stroke.brush = "paint";
    session.stroke.erase = modifiers.ctrl;
    session.controls.enabled = false;
    applyPaintAt(session, [hit.point.x, hit.point.y, hit.point.z]);
  };

  const applyPaintAt = (session, point) => {
    const stroke = session.stroke;
    if (!stroke) return;
    let touched = false;
    for (const center of strokeDabPositions(stroke, point, session.brushRadius)) {
      const result = paintDab(session.paintLayer, paintFaces(session, center), {
        center,
        radius: session.brushRadius,
        color: hexToRGB(session.paintColor ?? paintColor),
        strength: session.brushStrength,
        falloff: session.brushFalloff,
        mode: stroke.erase ? "erase" : session.paintBlend ?? paintBlend,
        baseColor: [230, 230, 230],
      });
      if (result.painted) touched = true;
    }
    if (touched) {
      session.paintTexture.needsUpdate = true;
      touch();
    }
  };

  const endPaintStroke = (session) => {
    if (!session.stroke) return;
    session.stroke = null;
    session.controls.enabled = true;
    // One texel of bleed past each island, so bilinear sampling at a seam does
    // not pull in the unpainted gutter and draw a dark line.
    dilateEdges(session.paintLayer, 1);
    session.paintTexture.needsUpdate = true;
    if (session.paintUndo) {
      session.paintHistory.push(session.paintUndo);
      if (session.paintHistory.length > UNDO_DEPTH) session.paintHistory.shift();
      session.paintUndo = null;
    }
    touch();
  };

  const undoPaintStroke = () => {
    const session = sessionRef.current;
    const previous = session?.paintHistory?.pop();
    if (!previous) {
      setStatus("Nothing to undo");
      return;
    }
    session.paintLayer.data.set(previous);
    session.paintTexture.needsUpdate = true;
    setStatus("Undo: paint stroke");
    touch();
  };

  /**
   * Writes the painted layer out as a PNG beside the project's textures.
   *
   * It is not assigned to the material automatically: which slot it belongs in
   * (base colour, roughness, a mask) is the user's call, and silently rewiring
   * a shared material asset from the geometry editor would be a surprise.
   */
  const savePaintTexture = async () => {
    const session = sessionRef.current;
    if (!session?.paintLayer) {
      setStatus("Nothing painted yet");
      return;
    }
    const root = useProjectStore.getState().rootPath;
    if (!root) {
      setStatus("Open a project before saving a texture");
      return;
    }
    try {
      const dataURL = layerToDataURL(session.paintLayer, document);
      const binary = atob(dataURL.split(",")[1]);
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
      const stem = (engine.getEntity(entityId)?.name ?? "Paint").replace(/[^a-z0-9 _-]/gi, "").trim() || "Paint";
      const path = `${root}/textures/${stem} Paint.png`;
      const { invoke } = await import("@tauri-apps/api/core");
      await writeBinaryFile(path, bytes);
      invalidateBlobUrl(path);
      await useProjectStore.getState().refresh();
      setStatus(`Saved ${path.split(/[\\/]/).pop()} — assign it in the material to use it`);
    } catch (error) {
      setStatus(`Could not save the texture: ${error}`);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Remesh                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuilds the surface at an even triangle density.
   *
   * Asynchronous, unlike every other operator here, because the remesher is
   * loaded on demand and can run for a while on a dense mesh — so it takes the
   * undo snapshot itself rather than going through `runOperator`.
   *
   * The remesher discards UVs and per-face materials, which is normal for a
   * remesher but is destructive enough that the status line says so outright.
   */
  const doRemesh = async () => {
    const session = sessionRef.current;
    if (!session || session.macro || session.stroke || busy) return;
    setBusy(true);
    setStatus("Remeshing…");
    try {
      // Yield a frame first so the "Remeshing…" status actually paints before
      // the grid work takes the thread.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = voxelRemesh(session.mesh, {
        voxelSize: remeshDetail > 0 ? remeshDetail : suggestedVoxelSize(session.mesh),
      });
      if (result.error) {
        setStatus(result.error);
        return;
      }
      // Taken only once the remesh has actually succeeded, so a failure leaves
      // no empty step in the history.
      session.history.push({ mesh: session.mesh, mode: session.mode, label: "Remesh" });
      if (session.history.length > UNDO_DEPTH) session.history.shift();
      session.future.length = 0;
      session.mesh = result.mesh;
      session.active = null;
      session.rebuild();
      autosave(session);
      setStatus(`Remeshed to ${result.faces} faces at a voxel size of ${result.voxelSize.toPrecision(3)} — UVs and material slots were reset, re-unwrap if you need them`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Export the mesh AS EDITED, not the file on disk.
   *
   * Edit Mode autosaves, but not on every keystroke, and a modifier stack is
   * never in the `.geom` at all — exporting the asset from a panel showing
   * something else is the kind of surprise that is only noticed in Blender.
   * `bufferGeometryFromMesh` is what Object Mode is already shown, so this
   * exports exactly the triangles on screen.
   */
  const doExportGlb = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setStatus("Exporting GLB…");
    const geometry = bufferGeometryFromMesh(session.mesh);
    try {
      const { exportGeometryWithDialog } = await import("../geomExport.js");
      const name = engine.getEntity(entityId)?.name || "Mesh";
      const result = await exportGeometryWithDialog(geometry, { name });
      setStatus(
        result
          ? `Exported ${result.targetPath.split(/[\\/]/).pop()} — ${result.triangles.toLocaleString()} triangles`
          : "Export cancelled",
      );
    } catch (error) {
      setStatus(`Export failed: ${error.message ?? error}`);
    } finally {
      geometry.dispose();
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Viewport shading                                                        */
  /* ---------------------------------------------------------------------- */

  /** Blender's Z: cycle the viewport shading. */
  const cycleShading = (backwards = false) => {
    const order = SHADING_MODES.map((entry) => entry.id);
    const at = order.indexOf(shading);
    const next = order[(at + (backwards ? -1 : 1) + order.length) % order.length];
    setShading(next);
    setStatus(`Shading: ${SHADING_MODES.find((entry) => entry.id === next).label}`);
  };


  /**
   * Blender's four viewport shading modes.
   *
   *   Wireframe  edges only, and you can select straight through the surface.
   *   Solid      one neutral studio material, so topology reads clearly. This
   *              is the edit-mode default for the same reason it is in Blender:
   *              a dark or busy texture hides the selection overlays.
   *   Material   the entity's real materials, lit by the editor's studio rig
   *              plus the scene environment if one is set.
   *   Rendered   the same materials lit by the scene's own lights.
   *
   * Wireframe hides the surface with a transparent material rather than
   * `visible = false`, so raycast picking keeps working exactly as it does in
   * the other modes.
   */
  const applyShading = (session, mode) => {
    if (!session?.meshObject) return;
    const wireframeMode = mode === "wireframe";
    // Paint mode owns the surface: it shows the paint target, not the shading
    // material. This effect runs after the mode effect, so without the guard it
    // would immediately overwrite the paint material and the strokes would
    // vanish from the viewport.
    if (session.painting) {
      session.shading = mode;
      return;
    }
    const surfaceMaterial = wireframeMode
      ? session.wireframeMaterial
      : mode === "solid"
        ? session.editMaterials
        : session.realMaterials ?? session.editMaterials;
    const previewVisible = !!session.modifierPreviewObject?.visible;
    session.meshObject.material = previewVisible ? session.modifierCageMaterial : surfaceMaterial;
    if (session.modifierPreviewObject) {
      session.modifierPreviewObject.material = wireframeMode
        ? session.modifierWireframeMaterial
        : surfaceMaterial;
    }

    // In wireframe the surface is invisible, so the edges have to carry the
    // whole read of the shape and need to be brighter than the usual dark wire.
    session.wire.material.vertexColors = !wireframeMode;
    session.wire.material.color.setHex(wireframeMode ? 0x9aa4ad : 0xffffff);
    session.wire.material.needsUpdate = true;
    session.wireframeShading = wireframeMode;
    if (wireframeMode) session.wire.visible = !session.sculpting;

    session.editorLights.visible = mode !== "rendered";
    session.sceneLights.visible = mode === "rendered";
    // A studio environment only helps where real materials are shown; on the
    // neutral solid material it would just wash out the shading.
    session.scene.environment = mode === "material" || mode === "rendered" ? engine.scene.environment ?? null : null;
    session.shading = mode;
    refreshOverlays(session);
  };

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    applyShading(session, shading);
    touch();
  }, [shading, component, editorMode]);

  /* ---------------------------------------------------------------------- */
  /* Sculpting                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Begins a sculpt stroke. The whole drag is one undo step — Blender treats a
   * stroke as a single action, and with dyntopo running per dab an entry per dab
   * would both bury the history and hold a copy of the mesh for each one.
   */
  const beginSculptStroke = (session, hit, modifiers) => {
    const active = modifiers.shift ? "smooth" : session.brush;
    session.history.push({ mesh: copyMesh(session.mesh).mesh, mode: session.mode, label: `Sculpt: ${active}` });
    if (session.history.length > UNDO_DEPTH) session.history.shift();
    session.future.length = 0;
    session.stroke = beginStroke(session.mesh, {
      radius: session.brushRadius,
      brush: active,
      spacing: 0.3,
    });
    session.stroke.brush = active;
    session.stroke.invert = modifiers.ctrl;
    session.stroke.anchor = [hit.point.x, hit.point.y, hit.point.z];
    session.stroke.lastPoint = [...session.stroke.anchor];
    if (active === "grab") {
      captureGrabWeights(session.stroke, session.stroke.anchor, session.brushRadius, session.brushFalloff);
    }
    session.controls.enabled = false;
    applySculptAt(session, session.stroke.anchor);
  };

  /**
   * Applies the dabs between the last sample and `point`.
   *
   * Grab is the exception to the dab model: it is one continuous pull from the
   * stroke's anchor rather than a series of stamps, so it is applied directly
   * with the accumulated delta instead of being interpolated along the path.
   */
  const applySculptAt = (session, point) => {
    const stroke = session.stroke;
    if (!stroke) return;
    const kind = stroke.brush;
    const sign = stroke.invert;

    if (kind === "grab") {
      const direction = [
        point[0] - stroke.anchor[0],
        point[1] - stroke.anchor[1],
        point[2] - stroke.anchor[2],
      ];
      applyStrokeDab(session.mesh, {
        type: "grab",
        center: stroke.anchor,
        normal: surfaceNormalAt(stroke.index, stroke.anchor, session.brushRadius) ?? [0, 0, 1],
        radius: session.brushRadius,
        strength: session.brushStrength,
        falloff: session.brushFalloff,
        invert: sign,
        direction,
        index: stroke.index,
        originals: stroke.originals,
        weights: stroke.weights,
        symmetry: session.symmetry,
      });
      session.preview();
      return;
    }

    const positions = strokeDabPositions(stroke, point, session.brushRadius);
    if (!positions.length) return;
    let topologyChanged = false;
    for (const center of positions) {
      if (session.dyntopo && kind !== "smooth") {
        const result = dyntopoStep(session.mesh, center, session.brushRadius, session.detailSize, {
          mode: session.dyntopoMode,
          budget: 120,
        });
        if (result.changed) {
          topologyChanged = true;
          // Splitting and collapsing invalidates the vertex buckets.
          refreshStroke(stroke, session.mesh, session.brushRadius);
        }
      }
      const direction = [
        center[0] - (stroke.lastPoint?.[0] ?? center[0]),
        center[1] - (stroke.lastPoint?.[1] ?? center[1]),
        center[2] - (stroke.lastPoint?.[2] ?? center[2]),
      ];
      applyStrokeDab(session.mesh, {
        type: kind,
        center,
        normal: surfaceNormalAt(stroke.index, center, session.brushRadius) ?? [0, 0, 1],
        radius: session.brushRadius,
        strength: session.brushStrength,
        falloff: session.brushFalloff,
        invert: sign,
        direction,
        index: stroke.index,
        symmetry: session.symmetry,
      });
      stroke.lastPoint = [...center];
    }
    // A dab that only moved vertices can take the cheap position-only refresh;
    // dyntopo changed the index buffer, so that needs a full rebuild.
    if (topologyChanged) session.rebuild();
    else session.preview();
  };

  const endSculptStroke = (session) => {
    if (!session.stroke) return;
    session.stroke = null;
    session.controls.enabled = true;
    session.rebuild();
    autosave(session);
  };

  /**
   * Where the pointer lands on the plane through the stroke anchor facing the
   * camera. A Grab drag routinely pulls the surface out from under the cursor,
   * and without this the stroke would stall the moment the ray missed.
   */
  const pointerOnAnchorPlane = (session, event) => {
    const stroke = session.stroke;
    if (!stroke) return null;
    const rect = session.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, session.camera);
    // The ray and the plane are world-space; the anchor and the answer are not.
    const anchor = session.toWorldPoint(stroke.anchor);
    const normal = session.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) return null;
    const local = session.toLocalPoint(point);
    return [local.x, local.y, local.z];
  };

  /** Projected pixel radius of the brush, for the on-screen cursor ring. */
  const projectedBrushRadius = (session, localPoint) => {
    const camera = session.camera;
    const rect = session.canvas.getBoundingClientRect();
    // The brush radius is a local-space length, so it is measured out in local
    // space and only then projected — on a scaled object the ring would
    // otherwise be the wrong size on screen.
    const center = session.toWorldPoint(localPoint);
    const right = session.toLocalDirection(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)).normalize();
    const edge = session.toWorldPoint(
      new THREE.Vector3(localPoint[0], localPoint[1], localPoint[2]).addScaledVector(right, session.brushRadius),
    );
    const toScreen = (point) => {
      const projected = point.clone().project(camera);
      return [(projected.x + 1) * rect.width * 0.5, (-projected.y + 1) * rect.height * 0.5];
    };
    const [cx, cy] = toScreen(center);
    const [ex, ey] = toScreen(edge);
    return Math.max(Math.hypot(ex - cx, ey - cy), 3);
  };

  /* ---------------------------------------------------------------------- */
  /* Knife                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The knife is modal rather than a drag macro: clicks drop points onto the
   * surface, Enter cuts along them, Esc abandons. Points are raycast onto the
   * mesh so each one already lies on the geometry it is going to cut.
   */
  const startKnife = () => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    session.knife = { points: [] };
    session.controls.enabled = false;
    setKnifePoints([]);
    setStatus("Knife: click to place cuts · Enter to confirm · Esc to cancel");
  };

  const cancelKnife = () => {
    const session = sessionRef.current;
    if (!session?.knife) return;
    session.knife = null;
    session.controls.enabled = true;
    setKnifePoints(null);
    setStatus("Knife cancelled");
  };

  const confirmKnife = () => {
    const session = sessionRef.current;
    const points = session?.knife?.points ?? [];
    session.knife = null;
    session.controls.enabled = true;
    setKnifePoints(null);
    if (points.length < 2) {
      setStatus("The knife needs at least two points");
      return;
    }
    runOperator("Knife", (value) => {
      const result = knifeCut(value.mesh, points);
      if (result.error) return result;
      value.mode = "edge";
      setMode("edge");
      return { message: `Knife created ${result.edges.length} edges` };
    });
  };

  /* ---------------------------------------------------------------------- */
  /* View controls                                                           */
  /* ---------------------------------------------------------------------- */

  const toggleXray = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.xray = !session.xray;
    applyXray(session);
    setXray(session.xray);
  };

  const handleAxisSnap = (axis, sign) => {
    const session = sessionRef.current;
    if (!session) return;
    const view = `${sign > 0 ? "+" : "-"}${axis.toUpperCase()}`;
    if (snapView === view) {
      usePerspectiveGeometryView(session);
      setSnapView(null);
      return;
    }
    animateToAxis(session, axis, sign);
    setSnapView(view);
  };

  const focusGeometry = () => {
    const session = sessionRef.current;
    if (!session) return;
    frameSphere(session, meshBoundingSphere(session.mesh));
    setSnapView(null);
  };

  const focusSelection = () => {
    const session = sessionRef.current;
    if (!session) return;
    frameSphere(session, selectionBoundingSphere(session) ?? meshBoundingSphere(session.mesh));
    setSnapView(null);
  };

  const armSelectionTool = (kind) => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    session.selectionTool = session.selectionTool === kind ? null : kind;
    setSelectionTool(session.selectionTool);
    session.canvas.focus();
  };

  const cancelSelectionTool = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.selectionTool = null;
    session.selectionGesture = null;
    session.controls.enabled = true;
    setSelectionTool(null);
    setSelectionGesture(null);
  };

  /* ---------------------------------------------------------------------- */
  /* Keep session mirrors of React state                                     */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    Object.assign(session, {
      proportional,
      proportionalConnected,
      falloff,
      pivot,
      orientation,
      snapEnabled,
      snapMode,
      snapIncrement,
      snapAbsolute,
      brush,
      brushRadius,
      brushStrength,
      brushFalloff,
      symmetry,
      dyntopo,
      detailSize,
      dyntopoMode,
      // The pointer handlers are bound once, on mount, so they hold the very
      // first render's closures. Anything a stroke reads has to come through
      // the session or it is frozen at its initial value — which is why the
      // brush painted the default red whatever the colour swatch said.
      paintColor,
      paintBlend,
      paintResolution,
    });
  }, [proportional, proportionalConnected, falloff, pivot, orientation, snapEnabled, snapMode, snapIncrement, snapAbsolute,
    brush, brushRadius, brushStrength, brushFalloff, symmetry, dyntopo, detailSize, dyntopoMode,
    paintColor, paintBlend, paintResolution]);

  /** Sculpting hides the edit overlays, so the session needs to know the mode. */
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.painting = editorMode === "paint";
    // Paint mode hides the edit overlays for the same reason sculpt does, and
    // shows the paint target instead of whatever shading mode is selected.
    session.sculpting = editorMode === "sculpt" || editorMode === "paint";
    if (session.painting) {
      ensurePaintLayer(session);
      session.meshObject.material = session.paintMaterial;
    } else if (session.paintMaterial) {
      applyShading(session, shading);
    }
    if (session.sculpting) {
      session.macro = null;
      session.knife = null;
      setMacroState(null);
      setKnifePoints(null);
      // A sensible detail size depends on the model, not on a fixed number.
      const average = averageEdgeLength(session.mesh);
      if (average > 0) {
        setDetailSize((current) => (current > average * 2 || current < average * 0.05 ? +(average * 0.5).toFixed(4) : current));
      }
    } else {
      setBrushCursor(null);
    }
    refreshOverlays(session);
    touch();
  }, [editorMode, component, paintResolution]);

  /**
   * Publishes the toolbar's measured height so the axis gizmo can sit below it.
   * The toolbar is a floating overlay that wraps to more rows on a narrow
   * panel, so its height is not something CSS can assume.
   */
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const root = rootRef.current;
    if (!toolbar || !root) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      root.style.setProperty("--geometry-toolbar-height", `${Math.round(entry.contentRect.height)}px`);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [component, mode]);

  /**
   * A wheel over the header scrolls it sideways, as it does over Blender's.
   * (Placing the menus is `ToolbarMenu`'s job — they are portalled onto
   * `<body>` so neither this scroller's clipping nor the toolbar's
   * `backdrop-filter` can reach them.)
   *
   * Bound in an effect that re-runs on `component`, not once on mount: the
   * panel renders an empty placeholder until an entity with a mesh is
   * selected, so on the first pass there is no header to bind to.
   */
  useEffect(() => {
    const scroller = toolbarScrollRef.current;
    if (!scroller) return undefined;
    const onWheel = (event) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      // Most trackpads report pixels, but traditional mouse wheels can report
      // lines (or, rarely, pages). Treating those values as pixels made a
      // three-line wheel notch move the header by only three pixels.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
      const delta = rawDelta * unit;
      if (!delta) return;
      scroller.scrollLeft += delta;
      event.preventDefault();
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [component]);

  // Ctrl+R must be claimed in the capture phase, ahead of the webview's reload.
  useEffect(() => {
    const capture = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "r") return;
      if (!sessionRef.current) return;
      // A live edit session claims Ctrl+R globally, which would otherwise reach
      // across the editor and start a loop cut while the user is typing in a
      // code editor or a field.
      if (isTypingTarget(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) startOffsetLoop();
      else startLoopCut();
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [entityId]);

  /* ---------------------------------------------------------------------- */
  /* Scene setup                                                             */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !component?.mesh) return undefined;
    let disposed = false;
    let renderer;
    let frame = 0;
    let resizeObserver;

    const canvas = document.createElement("canvas");
    canvas.className = "geometry-editor-canvas";
    canvas.tabIndex = 0;
    host.replaceChildren(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x282828);
    let camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    const perspectiveCamera = camera;
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // Two lighting rigs: the neutral studio pair used by Solid and Material
    // Preview, and clones of the scene's own lights used by Rendered.
    const editorLights = new THREE.Group();
    editorLights.add(new THREE.HemisphereLight(0xdcecff, 0x26301f, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
    keyLight.position.set(3, 5, 4);
    editorLights.add(keyLight);
    scene.add(editorLights);

    const sceneLights = new THREE.Group();
    sceneLights.visible = false;
    scene.add(sceneLights);
    // The grid is the world's ground plane, not something under the object.
    const grid = new THREE.GridHelper(10, 20, 0x4a5965, 0x283039);
    grid.position.y = -0.001;
    scene.add(grid);

    // Edit mode leaves the object where it is, as Blender does.
    //
    // This scene used to be built in the entity's *local* space: every light
    // and every surrounding mesh was multiplied by the inverse of the entity's
    // world matrix so the edited object could sit at the origin, axis-aligned.
    // Geometrically that is the same picture, but it is the wrong one to show —
    // rotate an object and the entire world appeared to swing around it, the
    // ground tilting under your feet, because the object was being forced back
    // into the standard position instead of the camera staying put.
    //
    // Now the object is drawn at its own world transform and everything around
    // it is left alone. The kernel still works in local coordinates, so world
    // and local are converted between at the boundaries — see `toLocalPoint`
    // and friends below.
    const context = new THREE.Group();
    context.visible = showSceneContext;
    context.userData.sceneContext = true;
    scene.add(context);
    engine.scene.updateMatrixWorld(true);
    entity.object3D.updateWorldMatrix(true, false);
    engine.scene.traverse((source) => {
      if (source.isLight && !hasEditorOnlyAncestor(source)) {
        const clone = source.clone();
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(source.matrixWorld);
        sceneLights.add(clone);
        return;
      }
      if (!source.isMesh || source === component.mesh || !source.visible || hasEditorOnlyAncestor(source)) return;
      const material = new THREE.MeshStandardMaterial({ color: 0x687078, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.38, depthWrite: true });
      const clone = new THREE.Mesh(source.geometry, material);
      clone.userData.sharedGeometry = true;
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(source.matrixWorld);
      context.add(clone);
    });

    // The editor's scene is world-space now, so the cursor proxy mirrors the
    // world position straight through instead of being pulled into the
    // entity's local frame.
    const cursorWorld = new THREE.Vector3();
    attachCursor(scene, { localTransform: () => cursorWorld.fromArray(getCursor3D().position) });

    // NOT `component.mesh.geometry` — see `authoredGeometry`. A virtual-geometry
    // mesh is rendering this frame's LOD cut, and a modified one is rendering
    // the modifier stack's output; both are derivations, not the model.
    const mesh = meshFromBufferGeometry(authoredGeometry(entity));
    // Edit mode uses one neutral surface, as Blender does: selection overlays,
    // not material colours, are what communicate the current selection.
    const editMaterials = Array.from({ length: 8 }, () => new THREE.MeshStandardMaterial({ color: 0x92979d, roughness: 0.78, metalness: 0 }));
    // Fully transparent rather than hidden: Wireframe must still be pickable.
    const wireframeMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    // The entity's real materials, shared with Object Mode — never disposed here.
    const sourceMaterial = component.mesh.material;
    const realMaterials = Array.isArray(sourceMaterial) ? [...sourceMaterial] : sourceMaterial;
    const meshObject = new THREE.Mesh(bufferGeometryFromMesh(mesh), editMaterials);
    meshObject.userData.sharedMaterial = false;
    // Drawn at the entity's own transform. Overlays are children of it, so the
    // wireframe, vertex dots and selection highlights follow for free.
    meshObject.matrixAutoUpdate = false;
    meshObject.matrix.copy(entity.object3D.matrixWorld);
    meshObject.updateMatrixWorld(true);
    scene.add(meshObject);

    // The editable cage and the evaluated modifier result are deliberately two
    // objects. Picking and overlays stay attached to `meshObject`, while this
    // sibling shows Array/Mirror/Subdivision/etc. without turning generated
    // vertices into editable source topology or baking them on save.
    const modifierCageMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const modifierWireframeMaterial = new THREE.MeshBasicMaterial({ color: 0x9aa4ad, wireframe: true });
    const modifierPreviewObject = new THREE.Mesh(new THREE.BufferGeometry(), editMaterials);
    modifierPreviewObject.visible = false;
    modifierPreviewObject.matrixAutoUpdate = false;
    modifierPreviewObject.matrix.copy(entity.object3D.matrixWorld);
    modifierPreviewObject.updateMatrixWorld(true);
    scene.add(modifierPreviewObject);

    const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    const markerCapacity = Math.max(8192, Math.ceil(mesh.verts.size * 2));
    const markerGeometry = new THREE.SphereGeometry(1, 8, 6);
    const basePoints = new THREE.InstancedMesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0x111820, depthWrite: false }), markerCapacity);
    basePoints.count = 0;
    const faceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xf28b30, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    // Selected edges sit exactly on the surface; WebGPU depth precision would
    // otherwise reject the overlay as coplanar and make a successful cut look
    // like it did nothing.
    const edgeOverlay = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SELECT_COLOR, depthTest: false, depthWrite: false }));
    const vertexOverlay = new THREE.InstancedMesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffa23f, depthWrite: false }), markerCapacity);
    vertexOverlay.count = 0;
    const activeOverlay = new THREE.InstancedMesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, depthTest: false }), 8);
    activeOverlay.count = 0;
    for (const [index, object] of [wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay, activeOverlay].entries()) {
      object.renderOrder = 5 + index;
      meshObject.add(object);
    }
    for (const object of [basePoints, edgeOverlay, vertexOverlay, activeOverlay]) object.frustumCulled = false;

    const session = {
      mesh, meshObject, wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay, activeOverlay, context,
      modifierPreviewObject, modifierCageMaterial, modifierWireframeMaterial,
      scene, editMaterials, realMaterials, wireframeMaterial, editorLights, sceneLights, shading,
      // Every material ever borrowed from the entity — the dispose sweep must
      // skip them all, including ones re-borrowed after a slot change.
      borrowedMaterials: new Set(Array.isArray(realMaterials) ? realMaterials : [realMaterials]),
      camera, perspectiveCamera, orthographicCamera: null, orthographicHeight: 10,
      controls, canvas,
      mode: "face",
      active: null,
      history: [], future: [], macro: null,
      proportional, proportionalConnected, falloff, pivot, orientation,
      snapEnabled, snapMode, snapIncrement, snapAbsolute,
      // How close to the mouse an element has to project to be snapped to, in
      // pixels. Blender's magnet works the same way, which is why it does not
      // need a world-space reach and behaves identically on a trinket and on a
      // terrain.
      snapPixelRadius: 28,
      // Seeded here as well as in the mirroring effect below: effects run in
      // declaration order, and that one is declared first, so on mount it sees
      // a null session and bails. Without these the first sculpt stroke after
      // opening the panel would silently fall back to the operator defaults
      // instead of the values the toolbar is showing.
      brush, brushRadius, brushStrength, brushFalloff, symmetry, dyntopo, detailSize, dyntopoMode,
      sculpting: false, painting: false, stroke: null,
      paintLayer: null, paintTexture: null, paintMaterial: null, paintHistory: [], paintUndo: null,
      paintColor, paintBlend, paintResolution,
      xray: false,
      selectionTool: null, selectionGesture: null, circleRadius: 32,
    };
    // Boundary conversions between the world the camera lives in and the local
    // coordinates every vertex, operator and UV is expressed in.
    //
    // Directions go through the matrix's linear part rather than being rotated,
    // so a scaled object converts a screen-space drag into the right *length*
    // of local movement as well as the right heading.
    const worldFromLocal = meshObject.matrixWorld;
    const localFromWorld = new THREE.Matrix4().copy(worldFromLocal).invert();
    const linearToLocal = new THREE.Matrix3().setFromMatrix4(worldFromLocal).invert();
    const meshScale = new THREE.Vector3().setFromMatrixScale(worldFromLocal);
    session.worldFromLocal = worldFromLocal;
    session.localFromWorld = localFromWorld;
    /** A world-space point, in mesh-local coordinates. Mutates nothing. */
    session.toLocalPoint = (point) => point.clone().applyMatrix4(localFromWorld);
    /** A mesh-local point (array or Vector3) in world space. */
    session.toWorldPoint = (point) => (Array.isArray(point)
      ? new THREE.Vector3(point[0], point[1], point[2])
      : point.clone()).applyMatrix4(worldFromLocal);
    /** A world-space direction as the local displacement that produces it. */
    session.toLocalDirection = (direction) => direction.clone().applyMatrix3(linearToLocal);
    /** How many local units one world unit spans, averaged over the axes. */
    session.localPerWorld = 3 / Math.max(meshScale.x + meshScale.y + meshScale.z, 1e-6);

    session.refreshModifierPreview = () => {
      const stack = engine.getEntity(entityId)?.getComponent?.("geometryModifiers");
      const active = !!stack?.enabled && (stack.props.modifiers ?? []).some((modifier) => modifier.enabled !== false);
      if (!active) {
        modifierPreviewObject.visible = false;
        applyShading(session, session.shading);
        applyXray(session);
        return;
      }

      const cage = bufferGeometryFromMesh(session.mesh);
      let evaluated = null;
      try {
        evaluated = stack.evaluateGeometry(cage);
        if (!evaluated?.getAttribute("position")) throw new Error("Modifier stack produced no geometry");
        const previous = modifierPreviewObject.geometry;
        modifierPreviewObject.geometry = evaluated;
        modifierPreviewObject.visible = true;
        previous?.dispose?.();
      } catch (error) {
        evaluated?.dispose?.();
        modifierPreviewObject.visible = false;
        stack.lastError = String(error?.message ?? error);
      } finally {
        cage.dispose();
      }
      applyShading(session, session.shading);
      applyXray(session);
    };

    session.useCamera = (nextCamera) => {
      camera = nextCamera;
      session.camera = nextCamera;
      controls.object = nextCamera;
      controls._quat.identity();
      controls._quatInverse.copy(controls._quat).invert();
      controls._sphericalDelta.set(0, 0, 0);
      controls._panOffset.set(0, 0, 0);
      controls._scale = 1;
      controls.position0.copy(nextCamera.position);
      controls.zoom0 = nextCamera.zoom;
      controls.target0.copy(controls.target);
      refreshVertexMarkerScales(session);
      touch();
    };
    session.rebuild = () => {
      rebuildRenderMesh(session);
      refreshOverlays(session);
      refreshStats(session);
      touch();
    };
    session.preview = () => {
      // Topology is unchanged mid-drag, so only the positions are rewritten.
      refreshRenderPositions(session);
      refreshOverlays(session);
      touch();
    };
    sessionRef.current = session;
    const modifierPreviewUnsub = engine.on?.("component-changed", (event) => {
      if (event?.entityId === entityId && event.componentType === "geometryModifiers") {
        session.refreshModifierPreview();
      }
    });
    // Same hatch as `globalThis.__viewport`: headless harnesses need to read
    // the camera and the mesh the panel is actually driving.
    if (import.meta.env?.DEV) globalThis.__geometrySession = session;
    applyXray(session);
    applyShading(session, shading);
    session.rebuild();

    const initialView = initialViewRef?.current ?? null;
    if (initialView) {
      // Edit-in-scene: adopt the viewport's camera verbatim. Both scenes are in
      // world space now, so the handover is exact and entering edit mode does
      // not move the camera at all — which is what Blender does and what makes
      // it feel like the same scene rather than a different one.
      camera.position.fromArray(initialView.position);
      // The PIVOT, though, moves onto the geometry. The viewport's own orbit
      // target is wherever the user last left it — commonly the world origin,
      // or a point far behind the object — and orbiting about that throws the
      // thing being edited across the screen instead of turning it in place,
      // which is what makes the camera feel unusable in Edit Mode. Only the
      // pivot changes; the camera does not move, so the view is handed over
      // intact and orbiting now turns the model.
      controls.target.copy(meshBoundingSphere(mesh).applyMatrix4(meshObject.matrixWorld).center);
      const span = camera.position.distanceTo(controls.target) || 1;
      camera.near = Math.max(span / 1000, 0.001);
      camera.far = Math.max(span * 200, 100);
      camera.updateProjectionMatrix();
      controls.update();
    } else {
      // Opened standalone, with no view to inherit: frame the geometry.
      frameSphere(session, meshBoundingSphere(mesh));
    }
    refreshVertexMarkerScales(session);

    const onControlsStart = () => { session.orbitStartQuaternion = session.camera.quaternion.clone(); };
    const onControlsChange = () => {
      if (
        session.camera.isOrthographicCamera && !session.snapAnimation && session.orbitStartQuaternion &&
        Math.abs(session.camera.quaternion.dot(session.orbitStartQuaternion)) < 0.999999
      ) {
        session.orbitStartQuaternion = null;
        usePerspectiveGeometryView(session);
        setSnapView(null);
      }
      refreshVertexMarkerScales(session);
    };
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("change", onControlsChange);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const castAt = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, session.camera);
      const hit = raycaster.intersectObject(session.meshObject, false)[0] ?? null;
      // Handed back in mesh-local coordinates. Picking, sculpt and paint dabs,
      // knife points and edge-nearest tests all compare against vertex
      // positions, which are local; converting once here keeps every one of
      // them written the way it was when local and world happened to agree.
      if (hit) hit.point = session.toLocalPoint(hit.point);
      return hit;
    };
    session.raycastAtLast = () => (session.lastPointer ? castAt(session.lastPointer.x, session.lastPointer.y) : null);

    let down = null;
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      if (event.altKey) event.preventDefault();
      down = [event.clientX, event.clientY];
      session.lastPointer = { x: event.clientX, y: event.clientY };
      canvas.focus();
      if (session.sculpting && !event.altKey) {
        const hit = castAt(event.clientX, event.clientY);
        if (hit) {
          const modifiers = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey };
          if (session.painting) beginPaintStroke(session, hit, modifiers);
          else beginSculptStroke(session, hit, modifiers);
          event.preventDefault();
        }
      }
    };
    const onPointerUp = (event) => {
      if (event.button !== 0 || !down) return;
      const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4;
      down = null;
      if (session.stroke) {
        if (session.painting) endPaintStroke(session);
        else endSculptStroke(session);
        return;
      }
      if (session.sculpting) return;
      if (moved) return;
      const hit = castAt(event.clientX, event.clientY);
      if (session.knife) {
        if (hit) {
          session.knife.points.push([hit.point.x, hit.point.y, hit.point.z]);
          setKnifePoints([...session.knife.points]);
        }
        return;
      }
      const additive = event.shiftKey;
      if (!additive && !event.ctrlKey && !event.metaKey) {
        clearSelection(session.mesh);
        session.active = null;
      }
      if (hit) {
        const element = pickElement(session, hit);
        if (element) {
          // Alt is tested before Ctrl: Blender's ring select is Ctrl+Alt+Click,
          // so checking Ctrl first would swallow it into the path branch and
          // make ring select unreachable.
          if (event.altKey) {
            const face = pickFace(session, hit);
            const seed = face && nearestEdgeOnFace(face, hit.point);
            if (seed) {
              const ring = event.ctrlKey || event.metaKey;
              const group = ring
                ? edgeRing(seed)
                : session.mode === "face"
                  ? faceLoop(face, seed)
                  : edgeLoop(seed, face);
              const members = session.mode === "vert"
                ? [...group].flatMap((edge) => [edge.v1, edge.v2])
                : session.mode === "face" && !ring
                  ? [...group]
                  : [...group];
              const allSelected = additive && members.length > 0 && members.every((member) => member.select);
              for (const member of members) member.select = !allSelected;
              session.active = element;
            }
          } else if (event.ctrlKey || event.metaKey) {
            for (const step of shortestPath(session.mesh, session.mode, element)) step.select = true;
            session.active = element;
          } else {
            const remove = additive && element.select;
            element.select = !remove;
            session.active = remove ? null : element;
          }
          flushSelection(session.mesh, session.mode);
        }
      }
      refreshOverlays(session);
      touch();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    const scheduleMacroFrame = () => {
      if (session.macroFrame) return;
      session.macroFrame = requestAnimationFrame(() => {
        session.macroFrame = 0;
        if (!session.macro) return;
        applyMacro(session);
        publishMacro(session);
      });
    };
    const onWindowPointerMove = (event) => {
      session.lastPointer = { x: event.clientX, y: event.clientY };
      if (session.sculpting) {
        const rect = canvas.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (session.stroke) {
          const hit = castAt(event.clientX, event.clientY);
          // Grab keeps pulling from the anchor even once the pointer leaves the
          // surface, so it projects onto the anchor's view plane instead.
          const point = hit
            ? [hit.point.x, hit.point.y, hit.point.z]
            : session.stroke.brush === "grab" ? pointerOnAnchorPlane(session, event) : null;
          if (point) {
            if (session.painting) applyPaintAt(session, point);
            else applySculptAt(session, point);
          }
          setBrushCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top, radius: projectedBrushRadius(session, point ?? session.stroke.anchor) });
          return;
        }
        if (!inside) {
          setBrushCursor(null);
          return;
        }
        const hover = castAt(event.clientX, event.clientY);
        setBrushCursor({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          radius: hover ? projectedBrushRadius(session, [hover.point.x, hover.point.y, hover.point.z]) : null,
          off: !hover,
        });
        return;
      }
      if (session.selectionGesture) {
        const gesture = session.selectionGesture;
        gesture.current = { x: event.clientX, y: event.clientY };
        if (gesture.kind === "lasso") gesture.path.push({ x: event.clientX, y: event.clientY });
        if (gesture.kind === "circle") applyRegionSelection(session, gesture);
        setSelectionGesture({ ...gesture, path: gesture.path ? [...gesture.path] : undefined });
        touch();
        return;
      }
      if (!session.macro) return;
      session.macro.current = { x: event.clientX, y: event.clientY };
      session.macro.fine = event.shiftKey;
      if (session.macro.buffer) return;
      // Bevel and loop cut rebuild topology, so they are coalesced to a frame.
      if (session.macro.kind === "bevel" || session.macro.kind === "loopcut") scheduleMacroFrame();
      else {
        applyMacro(session);
        publishMacro(session);
      }
    };
    const applyRegionSelection = (value, gesture) => {
      const found = elementsInRegion(value, gesture);
      for (const element of found) element.select = !gesture.subtractive;
      flushSelection(value.mesh, value.mode);
      refreshOverlays(value);
    };
    const onWindowPointerDown = (event) => {
      if (session.sculpting) return;
      if (!session.macro && session.selectionTool && event.target === canvas && event.button === 0) {
        const subtractive = event.ctrlKey || event.metaKey;
        if (!event.shiftKey && !subtractive) clearSelection(session.mesh);
        session.selectionGesture = {
          kind: session.selectionTool,
          start: { x: event.clientX, y: event.clientY },
          current: { x: event.clientX, y: event.clientY },
          path: session.selectionTool === "lasso" ? [{ x: event.clientX, y: event.clientY }] : undefined,
          radius: session.circleRadius ?? 32,
          subtractive,
        };
        session.selectionTool = null;
        session.controls.enabled = false;
        setSelectionTool(null);
        setSelectionGesture({ ...session.selectionGesture });
        if (session.selectionGesture.kind === "circle") applyRegionSelection(session, session.selectionGesture);
        touch();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!session.macro) return;
      if (event.button === 0 && session.macro.kind === "loopcut" && !session.macro.locked) {
        // First click locks the cut count and hands over to edge slide.
        session.macro.locked = true;
        session.macro.start = { x: event.clientX, y: event.clientY };
        publishMacro(session);
      } else if (event.button === 0) commitMacro();
      else if (event.button === 2) {
        session.preventContextOnce = true;
        cancelMacro();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowPointerUp = (event) => {
      if (session.stroke && event.button === 0) {
        if (session.painting) endPaintStroke(session);
        else endSculptStroke(session);
        return;
      }
      if (!session.selectionGesture || event.button !== 0) return;
      applyRegionSelection(session, session.selectionGesture);
      session.selectionGesture = null;
      session.controls.enabled = true;
      setSelectionGesture(null);
      touch();
      event.preventDefault();
      event.stopPropagation();
    };
    // Which live gesture currently owns the wheel — mirrors the branches of
    // `onWindowWheel` below. Shared with the viewport dolly so a loopcut's
    // segment count and one notch of zoom never both happen at once.
    const macroOwnsWheel = () =>
      session.selectionGesture?.kind === "circle" ||
      session.macro?.kind === "loopcut" ||
      session.macro?.kind === "bevel" ||
      !!session.macro?.proportional;
    const onWindowWheel = (event) => {
      if (session.selectionGesture?.kind === "circle") {
        session.circleRadius = THREE.MathUtils.clamp((session.circleRadius ?? 32) * 1.08 ** (-event.deltaY / 100), 8, 240);
        session.selectionGesture.radius = session.circleRadius;
        setSelectionGesture({ ...session.selectionGesture });
      } else if (session.macro?.kind === "loopcut" || session.macro?.kind === "bevel") {
        const limit = session.macro.kind === "loopcut" ? 64 : 16;
        session.macro.segments = THREE.MathUtils.clamp(session.macro.segments + (event.deltaY < 0 ? 1 : -1), 1, limit);
        if (session.macro.kind === "bevel") session.bevelSegments = session.macro.segments;
        scheduleMacroFrame();
      } else if (session.macro?.proportional) {
        // Blender's direction: scroll up tightens the influence circle. The
        // size is kept on the session so the next transform starts where this
        // one left off, as Blender's does.
        session.macro.radius = THREE.MathUtils.clamp(session.macro.radius * 1.08 ** (event.deltaY / 100), 0.001, 1e5);
        session.proportionalSize = session.macro.radius;
        applyMacro(session);
        publishMacro(session);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onContextMenu = (event) => {
      if (event.target === canvas || canvas.contains(event.target) || session.macro || session.preventContextOnce) {
        event.preventDefault();
        session.preventContextOnce = false;
      }
    };
    const onBlur = () => {
      cancelMacro();
      cancelSelectionTool();
      if (session.stroke) {
        if (session.painting) endPaintStroke(session);
        else endSculptStroke(session);
      }
    };
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerdown", onWindowPointerDown, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("wheel", onWindowWheel, { capture: true, passive: false });
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("blur", onBlur);
    // Edit Mode gets the same distance-aware dolly as the scene viewport:
    // OrbitControls' pivot-relative zoom stalls out exactly when you are
    // trying to get in close on a face. See viewportZoom.js.
    const disposeWheelZoom = installWheelZoom(canvas, {
      getCamera: () => session.camera,
      getControls: () => session.controls,
      getRoot: () => session.scene,
      isEnabled: () => !macroOwnsWheel(),
    });

    (async () => {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      await renderer.init();
      if (disposed) return;
      const resize = () => {
        const { width, height } = host.getBoundingClientRect();
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        resizeGeometryCamera(session.camera, width, height, session.orthographicHeight);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      const render = () => {
        if (disposed) return;
        const rect = host.getBoundingClientRect();
        if (canvas.isConnected && rect.width >= 1 && rect.height >= 1) {
          controls.update();
          refreshCursor3D();
          renderer.render(scene, session.camera);
        }
        frame = requestAnimationFrame(render);
      };
      render();
    })().catch((error) => setStatus(`Renderer failed: ${error}`));

    return () => {
      disposed = true;
      if (globalThis.__geometrySession === session) delete globalThis.__geometrySession;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(session.macroFrame);
      if (session.snapAnimation) cancelAnimationFrame(session.snapAnimation);
      resizeObserver?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("wheel", onWindowWheel, true);
      disposeWheelZoom();
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      controls.removeEventListener("start", onControlsStart);
      controls.removeEventListener("change", onControlsChange);
      modifierPreviewUnsub?.();
      controls.dispose();
      const borrowed = session.borrowedMaterials ?? new Set(Array.isArray(realMaterials) ? realMaterials : [realMaterials]);
      scene.traverse((object) => {
        if (!object.userData?.sharedGeometry) object.geometry?.dispose?.();
        if (object.userData?.sharedMaterial) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        // The entity's own materials are shared with Object Mode; disposing them
        // here would blank the mesh in the main viewport.
        for (const material of materials) if (!borrowed.has(material)) material?.dispose?.();
      });
      for (const material of [...editMaterials, wireframeMaterial]) material.dispose();
      session.paintTexture?.dispose?.();
      session.paintMaterial?.dispose?.();
      renderer?.dispose();
      detachCursor();
      sessionRef.current = null;
    };
  }, [entityId, component]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (!component) return <div className="geometry-editor-empty">Select an entity with a Mesh component.</div>;
  const session = sessionRef.current;
  const count = session ? selectionCount(session.mesh, mode) : 0;
  const run = (event, action) => {
    setOpenMenu(null);
    // Back to the viewport, so the keymap keeps working after a menu action —
    // key events reach the panel only while focus is inside it.
    sessionRef.current?.canvas?.focus();
    action();
  };
  const similarTypes = SIMILAR_TYPES[mode] ?? [];

  return (
    <div className={`geometry-editor ${embedded ? "embedded" : ""}`} ref={rootRef} onKeyDown={handleKeyDown}>
      <ToolbarMenuProvider openId={openMenu} onOpenChange={setOpenMenu}>
      <div className="geometry-editor-toolbar" ref={toolbarRef}>
        {/* Blender's header: ONE row that scrolls sideways. Wrapping stranded
            the trailing controls on a second row and grew the bar downwards
            over the viewport as the panel narrowed. */}
        <div className="geometry-editor-toolbar-scroll" ref={toolbarScrollRef}>
        <div className="geometry-mode-group">
          <button className={`toolbar-btn ${editorMode === "edit" ? "active" : ""}`} title="Edit Mode" onClick={() => setEditorMode("edit")}>Edit</button>
          <button className={`toolbar-btn ${editorMode === "sculpt" ? "active" : ""}`} title="Sculpt Mode" onClick={() => setEditorMode("sculpt")}>Sculpt</button>
          <button className={`toolbar-btn ${editorMode === "paint" ? "active" : ""}`} title="Texture Paint Mode" onClick={() => setEditorMode("paint")}>Paint</button>
        </div>
        {editorMode === "edit" && (
          <div className="geometry-mode-group">
            {MODES.map((item, index) => {
              const Icon = item === "vert" ? Circle : item === "edge" ? Square : Triangle;
              return (
                <button key={item} className={`toolbar-btn icon-only ${mode === item ? "active" : ""}`} title={`${MODE_LABELS[item]} select (${index + 1})`} onClick={() => changeMode(item)}>
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        )}
        {editorMode === "edit" && <span className="geometry-editor-stat geometry-selection-count" title={`${count} selected`}>{count}</span>}

        {/* Snap and proportional editing live in Blender's header, not inside a
            menu — they are modes you flip constantly while modelling, and their
            state has to be visible without opening anything. */}
        {editorMode === "edit" && (
          <div className="geometry-mode-group geometry-transform-options">
            <button
              className={`toolbar-btn icon-only ${snapEnabled ? "active" : ""}`}
              title={`Snap ${snapEnabled ? "on" : "off"} (Shift+Tab) — snaps to the element under the mouse`}
              onClick={() => setSnapEnabled((value) => !value)}
            >
              <Magnet size={14} />
            </button>
            <select className="geometry-header-select" title="Snap to" value={snapMode} onChange={(event) => setSnapMode(event.target.value)}>
              {SNAP_MODES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            <button
              className={`toolbar-btn icon-only ${proportional ? "active" : ""}`}
              title={`Proportional editing ${proportional ? "on" : "off"} (O) — Alt+O for connected only, scroll during a transform to resize`}
              onClick={() => setProportional((value) => !value)}
            >
              <CircleDot size={14} />
            </button>
            {proportional && (
              <select className="geometry-header-select" title="Proportional falloff" value={falloff} onChange={(event) => setFalloff(event.target.value)}>
                {FALLOFFS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            )}
          </div>
        )}

        {editorMode === "edit" && (<>
        <ToolbarMenu label="Select">
            <button onClick={(e) => run(e, doSelectAll)}>All <kbd>A</kbd></button>
            <button onClick={(e) => run(e, doSelectNone)}>None <kbd>Alt+A</kbd></button>
            <button onClick={(e) => run(e, doInvert)}>Invert <kbd>Ctrl+I</kbd></button>
            <hr />
            <button className={selectionTool === "box" ? "active" : ""} onClick={(e) => run(e, () => armSelectionTool("box"))}>Box Select <kbd>B</kbd></button>
            <button className={selectionTool === "circle" ? "active" : ""} onClick={(e) => run(e, () => armSelectionTool("circle"))}>Circle Select <kbd>C</kbd></button>
            <button className={selectionTool === "lasso" ? "active" : ""} onClick={(e) => run(e, () => armSelectionTool("lasso"))}>Lasso Select</button>
            <hr />
            <button onClick={(e) => run(e, doGrow)}>Select More <kbd>Ctrl++</kbd></button>
            <button onClick={(e) => run(e, doShrink)}>Select Less <kbd>Ctrl+−</kbd></button>
            <button onClick={(e) => run(e, doSelectLinkedAll)}>Select Linked <kbd>Ctrl+L</kbd></button>
            <button onClick={(e) => run(e, doCheckerDeselect)}>Checker Deselect</button>
            <button onClick={(e) => run(e, doSelectRandom)}>Select Random</button>
            <hr />
            <span className="geometry-menu-heading">Select Similar</span>
            {similarTypes.map((entry) => (
              <button key={entry.id} onClick={(e) => run(e, () => doSelectSimilar(entry.id))}>{entry.label}</button>
            ))}
            <hr />
            <span className="geometry-menu-heading">All by Trait</span>
            <button onClick={(e) => run(e, () => doSelectTrait("nonManifold"))}>Non Manifold</button>
            <button onClick={(e) => run(e, () => doSelectTrait("loose"))}>Loose Geometry</button>
            <button onClick={(e) => run(e, () => doSelectTrait("interior"))}>Interior Faces</button>
            <button onClick={(e) => run(e, () => doSelectTrait("boundary"))}>Boundary Loop</button>
            <button onClick={(e) => run(e, () => doSelectTrait("sharp", { angle: Math.PI / 6 }))}>Sharp Edges</button>
            <button onClick={(e) => run(e, () => doSelectTrait("sides", { sides: 3 }))}>Faces by Sides (Tris)</button>
            <button onClick={(e) => run(e, () => doSelectTrait("sides", { sides: 4, comparison: "greater" }))}>Faces by Sides (N-gons)</button>
          </ToolbarMenu>

        <ToolbarMenu label="Add" title="Add a primitive at the 3D cursor (Shift+A)">
            <span className="geometry-menu-heading">Mesh <kbd>Shift+A</kbd></span>
            {PRIMITIVES.map((entry) => (
              <button key={entry.id} onClick={(e) => run(e, () => doAddPrimitive(entry.id))}>{entry.label}</button>
            ))}
            <span className="geometry-menu-note">Arrives at the 3D cursor. Move it with Shift+S.</span>
          </ToolbarMenu>

        <ToolbarMenu label="Transform">
            <button disabled={!count} onClick={(e) => run(e, () => startMacro("translate", "Move"))}><Move size={13} /> Move <kbd>G</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => startMacro("rotate", "Rotate"))}><Rotate3d size={13} /> Rotate <kbd>R</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => startMacro("scale", "Scale"))}><Scale3d size={13} /> Scale <kbd>S</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, startShrinkFatten)}>Shrink/Fatten <kbd>Alt+S</kbd></button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, startEdgeSlide)}>Edge Slide <kbd>G G</kbd></button>
            <button disabled={mode === "face" || !count} onClick={(e) => run(e, startVertSlide)}>Vertex Slide <kbd>G G</kbd></button>
            <hr />
            <label className="geometry-menu-field">Orientation
              <select value={orientation} onChange={(event) => setOrientation(event.target.value)}>
                {ORIENTATIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <label className="geometry-menu-field">Pivot
              <select value={pivot} onChange={(event) => setPivot(event.target.value)}>
                {PIVOTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <hr />
            <button className={snapEnabled ? "active" : ""} onClick={(e) => run(e, () => setSnapEnabled((value) => !value))}><Magnet size={13} /> Snap <kbd>Shift+Tab</kbd></button>
            <label className="geometry-menu-field">Snap To
              <select value={snapMode} onChange={(event) => setSnapMode(event.target.value)}>
                {SNAP_MODES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <label className="geometry-menu-field">Increment
              <input type="number" min={0.001} step={0.05} value={snapIncrement} onChange={(event) => setSnapIncrement(Math.max(0.001, Number(event.target.value) || 0.25))} />
            </label>
            <button className={snapAbsolute ? "active" : ""} title="Round the position to the grid instead of the distance travelled" onClick={(e) => run(e, () => setSnapAbsolute((value) => !value))}>Absolute Grid Snap</button>
            <span className="geometry-menu-note">Vertex, edge and face snapping catch the element under the mouse.</span>
            <hr />
            <button className={proportional ? "active" : ""} onClick={(e) => run(e, () => setProportional((value) => !value))}>Proportional Editing <kbd>O</kbd></button>
            <button className={proportionalConnected ? "active" : ""} onClick={(e) => run(e, () => setProportionalConnected((value) => !value))}>Connected Only <kbd>Alt+O</kbd></button>
            <label className="geometry-menu-field">Falloff
              <select value={falloff} onChange={(event) => setFalloff(event.target.value)}>
                {FALLOFFS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <hr />
            <span className="geometry-menu-heading">3D Cursor <kbd>Shift+S</kbd></span>
            <button disabled={!count} onClick={(e) => run(e, snapSelectionToCursor)}><Crosshair size={13} /> Selection → Cursor</button>
            <button disabled={!count} onClick={(e) => run(e, snapCursorToSelection)}>Cursor → Selection</button>
            <button onClick={(e) => run(e, resetCursorToOrigin)}>Cursor → World Origin</button>
            <button disabled={!count} onClick={(e) => run(e, () => doMerge("cursor"))}>Merge at Cursor <kbd>M U</kbd></button>
          </ToolbarMenu>

        <ToolbarMenu label="Mesh">
            <button disabled={!count} onClick={(e) => run(e, doDuplicate)}>Duplicate <kbd>Shift+D</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => withSelection("Split", (s) => splitSelection(s.mesh, s.mode)))}>Split <kbd>Y</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, doSeparate)}>Separate <kbd>P</kbd></button>
            <hr />
            <label className="geometry-menu-field">Cuts
              <input type="number" min={1} max={10} value={cuts} onChange={(event) => setCuts(THREE.MathUtils.clamp(Math.round(Number(event.target.value)) || 1, 1, 10))} />
            </label>
            <button onClick={(e) => run(e, doSubdivide)}>Subdivide {cuts > 1 ? `${cuts}×` : ""}</button>
            <button onClick={(e) => run(e, startLoopCut)}><Scissors size={13} /> Loop Cut <kbd>Ctrl+R</kbd></button>
            <button onClick={(e) => run(e, startOffsetLoop)}>Offset Edge Loop <kbd>Ctrl+Shift+R</kbd></button>
            <button onClick={(e) => run(e, startKnife)}><Scissors size={13} /> Knife <kbd>K</kbd></button>
            <hr />
            <button onClick={(e) => run(e, () => doMergeByDistance())}>Merge by Distance <kbd>M D</kbd></button>
            <button onClick={(e) => run(e, () => doDissolve("limited"))}>Limited Dissolve <kbd>X L</kbd></button>
            <button onClick={(e) => run(e, () => runOperator("Delete Loose", (s) => ({ message: `Removed ${deleteLoose(s.mesh)} loose elements` })))}>Delete Loose</button>
            <button onClick={(e) => run(e, () => runOperator("Fill Holes", (s) => ({ message: `Filled ${fillHoles(s.mesh).filled} holes` })))}>Fill Holes</button>
            <hr />
            <span className="geometry-menu-heading">Remesh</span>
            <label className="geometry-menu-field">Voxel Size
              <input
                type="number"
                min={0}
                step={0.01}
                value={remeshDetail}
                title="Voxel size in local units, as in Blender: halve it for four times the faces. 0 picks one to match the current density."
                onChange={(event) => setRemeshDetail(Math.max(0, Number(event.target.value) || 0))}
              />
            </label>
            <button disabled={busy} onClick={(e) => run(e, doRemesh)}>{busy ? "Remeshing…" : "Voxel Remesh (resets UVs)"}</button>
            <hr />
            <button onClick={(e) => run(e, () => doSymmetrize("+x"))}>Symmetrize +X → −X</button>
            <button onClick={(e) => run(e, () => doSymmetrize("-x"))}>Symmetrize −X → +X</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => runOperator("Spin", (s) => spinEdges(s.mesh, selected(s.mesh, "edge"), { steps: 12 })))}>Spin</button>
            <hr />
            <span className="geometry-menu-heading">Delete <kbd>X</kbd></span>
            {DELETE_MODES.map((entry) => (
              <button key={entry.id} disabled={!count} onClick={(e) => run(e, () => doDelete(entry.id))}>{entry.label}</button>
            ))}
            <hr />
            <span className="geometry-menu-heading">Dissolve</span>
            <button disabled={!count} onClick={(e) => run(e, () => doDissolve("verts"))}>Vertices <kbd>X D</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => doDissolve("edges"))}>Edges <kbd>X G</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => doDissolve("faces"))}>Faces <kbd>X S</kbd></button>
            <hr />
            <button onClick={(e) => run(e, doExportGlb)}>Export as GLB…</button>
            <span className="geometry-menu-note">Writes the mesh as it is right now, for Blender or anything else that reads glTF.</span>
          </ToolbarMenu>

        <ToolbarMenu label="Vertex">
            <button disabled={!count} onClick={(e) => run(e, () => startExtrude("free"))}>Extrude Vertices <kbd>E</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => doMakeEdgeFace())}>New Edge/Face from Vertices <kbd>F</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => withSelection("Connect Vertex Path", (s) => connectVertPath(s.mesh)))}>Connect Vertex Path <kbd>J</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => doRip(false))}>Rip Vertices <kbd>V</kbd></button>
            <button disabled={!count} onClick={(e) => run(e, () => doRip(true))}>Rip Vertices and Fill</button>
            <button disabled={!count} onClick={(e) => run(e, doSmooth)}>Smooth Vertices</button>
            <hr />
            <span className="geometry-menu-heading">Merge <kbd>M</kbd></span>
            {MERGE_MODES.map((entry) => (
              <button key={entry.id} disabled={!count} onClick={(e) => run(e, () => doMerge(entry.id))}>{entry.label}</button>
            ))}
            <button onClick={(e) => run(e, doMergeByDistance)}>By Distance</button>
          </ToolbarMenu>

        <ToolbarMenu label="Edge">
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => startExtrude("region"))}>Extrude Edges <kbd>E</kbd></button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, startBevel)}>Bevel Edges <kbd>Ctrl+B</kbd></button>
            <button disabled={(mode !== "edge" && mode !== "face") || !count} onClick={(e) => run(e, () => withSelection("Bridge Edge Loops", (s) => (
              s.mode === "face" && selected(s.mesh, "face").length ? bridgeFaces(s.mesh) : bridgeEdgeLoops(s.mesh, selected(s.mesh, "edge"))
            )))}>Bridge Edge Loops</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => withSelection("Grid Fill", (s) => gridFill(s.mesh, selected(s.mesh, "edge"))))}>Grid Fill</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, startEdgeSlide)}>Edge Slide</button>
            <hr />
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => doMark("seam", true, "Mark Seam"))}>Mark Seam</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => doMark("seam", false, "Clear Seam"))}>Clear Seam</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => doMark("sharp", true, "Mark Sharp"))}>Mark Sharp</button>
            <button disabled={mode !== "edge" || !count} onClick={(e) => run(e, () => doMark("sharp", false, "Clear Sharp"))}>Clear Sharp</button>
            <button onClick={(e) => run(e, () => runOperator("Mark Sharp by Angle", (s) => ({ message: `Updated ${markSharpByAngle(s.mesh)} edges` })))}>Mark Sharp by Angle</button>
          </ToolbarMenu>

        <ToolbarMenu label="Face">
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => startExtrude("region"))}>Extrude Region <kbd>E</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => startExtrude("individual"))}>Extrude Individual <kbd>Alt+E I</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => startExtrude("normals"))}>Extrude Along Normals <kbd>Alt+E N</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => startInset(false))}>Inset Faces <kbd>I</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => startInset(true))}>Inset Individual <kbd>Shift+I</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => runOperator("Poke Faces", (s) => ({ message: `Poked ${pokeFaces(s.mesh, selected(s.mesh, "face"))} faces` })))}>Poke Faces</button>
            <hr />
            <button onClick={(e) => run(e, () => runOperator("Triangulate", (s) => ({ message: `Triangulated ${triangulateFaces(s.mesh, selected(s.mesh, "face"))} faces` })))}>Triangulate <kbd>Ctrl+T</kbd></button>
            <button onClick={(e) => run(e, () => runOperator("Tris to Quads", (s) => ({ message: `Merged ${trisToQuads(s.mesh, { faces: selected(s.mesh, "face") })} quads` })))}>Tris to Quads <kbd>Alt+J</kbd></button>
            <hr />
            <button onClick={(e) => run(e, () => doShading(true))}>Shade Smooth</button>
            <button onClick={(e) => run(e, () => doShading(false))}>Shade Flat</button>
            <hr />
            <span className="geometry-menu-heading">Normals</span>
            <button onClick={(e) => run(e, () => doRecalculate(false))}>Recalculate Outside <kbd>Shift+N</kbd></button>
            <button onClick={(e) => run(e, () => doRecalculate(true))}>Recalculate Inside <kbd>Ctrl+Shift+N</kbd></button>
            <button disabled={mode !== "face" || !count} onClick={(e) => run(e, () => runOperator("Flip Normals", (s) => ({ message: `Flipped ${flipNormals(s.mesh, selected(s.mesh, "face"))} faces` })))}>Flip <kbd>Alt+N</kbd></button>
          </ToolbarMenu>

        <ToolbarMenu label="UV">
            <button onClick={(e) => run(e, () => doUnwrap("planar"))}><Triangle size={13} /> Planar</button>
            <button onClick={(e) => run(e, () => doUnwrap("box"))}><Box size={13} /> Box</button>
          </ToolbarMenu>

        {mode === "face" && (
          <ToolbarMenu label="Material" popoverClassName="geometry-material-popover">
              {/* Blender's material slot list: one row per slot, the active one
                  highlighted; each row is a full asset picker with previews.
                  Clicking a row activates the slot, clicking its field browses. */}
              <span className="geometry-menu-heading">Material Slots</span>
              <div className="geometry-material-slots">
                {Array.from({ length: slotCount }, (_, index) => (
                  <div
                    key={MATERIAL_SLOT_KEYS[index]}
                    className={`geometry-material-slot ${index === faceMaterial ? "active" : ""}`}
                    onClick={() => setFaceMaterial(index)}
                  >
                    <span className="geometry-material-slot-index">{index + 1}</span>
                    <AssetField
                      descriptor={{
                        key: MATERIAL_SLOT_KEYS[index],
                        label: "Material",
                        exts: ["mat"],
                        emptyLabel: index === 0 ? "Default" : "None",
                        // The toolbar popover sits at z-index 950; the picker
                        // must clear it or it paints behind its own menu.
                        layer: "toolbar",
                      }}
                      value={slotValues[index]}
                      onCommit={(value) => setSlot(index, value)}
                    />
                  </div>
                ))}
              </div>
              <div className="geometry-material-slot-actions">
                <button disabled={slotCount >= MATERIAL_SLOT_KEYS.length} title="Add a material slot" onClick={() => addSlot()}>+ Add</button>
                <button disabled={slotCount <= 1} title="Remove the active slot — later slots shift up, faces follow" onClick={() => removeActiveSlot()}>− Remove</button>
              </div>
              <hr />
              <button disabled={!count} onClick={(e) => run(e, doAssignMaterial)}>Assign to Selection</button>
              <div className="geometry-material-slot-actions">
                <button title="Select every face using the active slot" onClick={() => doSelectBySlot(true)}>Select</button>
                <button title="Deselect every face using the active slot" onClick={() => doSelectBySlot(false)}>Deselect</button>
              </div>
            </ToolbarMenu>
        )}

        <ToolbarMenu label="Modifier" title="Non-destructive modifier stack — evaluated on top of the cage you are editing">
            {!modifiers ? (<>
              <span className="geometry-menu-note">
                A modifier stack evaluates on top of this mesh without changing it, so Edit Mode always keeps the cage.
              </span>
              <button onClick={(e) => run(e, addModifiers)}><Shapes size={13} /> Add Modifier Stack</button>
            </>) : (<>
              <label className="geometry-menu-field">Add Modifier
                <select value="" onChange={(event) => {
                  const modifier = createGeometryModifier(event.target.value);
                  if (modifier) setModifierStack([...(modifiers.props.modifiers ?? []), modifier], `Add ${GEOMETRY_MODIFIER_DEFINITIONS.find((entry) => entry.type === modifier.type)?.label ?? "modifier"}`);
                }}>
                  <option value="">Choose…</option>
                  {GEOMETRY_MODIFIER_DEFINITIONS.map((definition) => <option key={definition.type} value={definition.type}>{definition.label}</option>)}
                </select>
              </label>
              {!(modifiers.props.modifiers ?? []).length && <span className="geometry-menu-note">No modifiers</span>}
              {(modifiers.props.modifiers ?? []).map((modifier, index) => {
                const definition = GEOMETRY_MODIFIER_DEFINITIONS.find((entry) => entry.type === modifier.type);
                if (!definition) return null;
                const expanded = modifier.expanded !== false;
                return (
                  <div className={`geometry-modifier-panel ${modifier.enabled === false ? "disabled" : ""}`} key={modifier.id}>
                    <div className="geometry-modifier-header">
                      <button onClick={() => updateModifier(index, { expanded: !expanded }, "Toggle modifier panel")}>{expanded ? "▾" : "▸"} {definition.label}</button>
                      <div className="geometry-modifier-actions">
                        <button title="Apply" disabled={modifier.enabled === false} onClick={() => applyModifier(modifier)}>Apply</button>
                        <button title={modifier.enabled === false ? "Enable" : "Disable"} onClick={() => updateModifier(index, { enabled: modifier.enabled === false }, "Toggle modifier")}>{modifier.enabled === false ? "○" : "●"}</button>
                        <button title="Move up" disabled={index === 0} onClick={() => moveModifier(index, -1)}>↑</button>
                        <button title="Move down" disabled={index === modifiers.props.modifiers.length - 1} onClick={() => moveModifier(index, 1)}>↓</button>
                        <button title="Remove" onClick={() => setModifierStack(modifiers.props.modifiers.filter((_, current) => current !== index), `Remove ${definition.label}`)}>×</button>
                      </div>
                    </div>
                    {expanded && definition.fields.filter((field) => !field.showIf || field.showIf(modifier)).map((field) => {
                      if (field.type === "vec3") return ["X", "Y", "Z"].map((axis, axisIndex) => (
                        <label className="geometry-menu-field" key={`${field.key}-${axis}`}>{field.label} {axis}
                          <input type="number" step={field.step ?? 0.1} value={modifier[field.key]?.[axisIndex] ?? 0} onChange={(event) => {
                            const value = [...(modifier[field.key] ?? [0, 0, 0])];
                            value[axisIndex] = Number(event.target.value) || 0;
                            updateModifier(index, { [field.key]: value }, `Set ${definition.label} ${field.label}`);
                          }} />
                        </label>
                      ));
                      if (field.type === "select") return (
                        <label className="geometry-menu-field" key={field.key}>{field.label}
                          <select value={modifier[field.key]} onChange={(event) => updateModifier(index, { [field.key]: event.target.value }, `Set ${definition.label} ${field.label}`)}>
                            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                      );
                      if (field.type === "entity") return (
                        <label className="geometry-menu-field" key={field.key}>{field.label}
                          <select value={modifier[field.key] ?? ""} onChange={(event) => updateModifier(index, { [field.key]: event.target.value }, `Set ${definition.label} ${field.label}`)}>
                            <option value="">(none)</option>
                            {modifierEntityCandidates(!!field.meshOnly).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                          </select>
                        </label>
                      );
                      if (field.type === "boolean") return (
                        <label className="geometry-menu-field" key={field.key}>{field.label}
                          <input type="checkbox" checked={modifier[field.key] !== false} onChange={(event) => updateModifier(index, { [field.key]: event.target.checked }, `Set ${definition.label} ${field.label}`)} />
                        </label>
                      );
                      if (field.type === "text" || field.type === "asset") return (
                        <label className="geometry-menu-field" key={field.key}>{field.label}
                          <input type="text" value={modifier[field.key] ?? ""} onChange={(event) => updateModifier(index, { [field.key]: event.target.value }, `Set ${definition.label} ${field.label}`)} />
                        </label>
                      );
                      return (
                        <label className="geometry-menu-field" key={field.key}>{field.label}
                          <input type="number" min={field.min} max={field.max} step={field.step ?? 0.1} value={modifier[field.key] ?? 0} onChange={(event) => {
                            let value = Number(event.target.value) || 0;
                            if (field.min != null) value = Math.max(field.min, value);
                            if (field.max != null) value = Math.min(field.max, value);
                            updateModifier(index, { [field.key]: value }, `Set ${definition.label} ${field.label}`);
                          }} />
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              {modifiers.lastError && <span className="geometry-menu-note">Failed: {modifiers.lastError}</span>}
              <hr />
              <button onClick={(e) => run(e, removeModifiers)}>Remove Modifier Stack</button>
              <span className="geometry-menu-note">Also editable in the Inspector, under Geometry Modifiers.</span>
            </>)}
          </ToolbarMenu>

        <ToolbarMenu label="View">
            <span className="geometry-menu-heading">Shading <kbd>Z</kbd></span>
            {SHADING_MODES.map((entry) => (
              <button key={entry.id} className={shading === entry.id ? "active" : ""} title={entry.hint} onClick={(e) => run(e, () => setShading(entry.id))}>
                {entry.label}
              </button>
            ))}
            <hr />
            <button className={xray ? "active" : ""} onClick={(e) => run(e, toggleXray)}><Eye size={13} /> X-Ray <kbd>Alt+Z</kbd></button>
            <button className={showSceneContext ? "active" : ""} onClick={(e) => run(e, () => setShowSceneContext((value) => !value))}><Layers size={13} /> Scene Context</button>
            <button onClick={(e) => run(e, focusSelection)}>Frame Selected <kbd>.</kbd></button>
            <button onClick={(e) => run(e, focusGeometry)}>Frame All <kbd>Home</kbd></button>
          </ToolbarMenu>

        </>)}

        {editorMode === "sculpt" && (<>
          <ToolbarMenu label="Brush">
              {BRUSHES.map((entry) => (
                <button key={entry.id} className={brush === entry.id ? "active" : ""} title={entry.hint} onClick={(e) => run(e, () => setBrush(entry.id))}>
                  {entry.label}
                </button>
              ))}
            </ToolbarMenu>
          <label className="geometry-brush-field" title="Brush radius ( [ and ] )">R
            <input type="range" min={0.005} max={2} step={0.005} value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} />
            <span>{brushRadius.toFixed(3)}</span>
          </label>
          <label className="geometry-brush-field" title="Brush strength">S
            <input type="range" min={0.01} max={1} step={0.01} value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} />
            <span>{brushStrength.toFixed(2)}</span>
          </label>
          <ToolbarMenu label="Dyntopo">
              <button className={dyntopo ? "active" : ""} onClick={(e) => run(e, () => setDyntopo((value) => !value))}>
                {dyntopo ? "Enabled" : "Disabled"} <kbd>D</kbd>
              </button>
              <label className="geometry-menu-field">Detail
                <input type="number" min={0.002} step={0.01} value={detailSize} onChange={(event) => setDetailSize(Math.max(0.002, Number(event.target.value) || 0.05))} />
              </label>
              <label className="geometry-menu-field">Mode
                <select value={dyntopoMode} onChange={(event) => setDyntopoMode(event.target.value)}>
                  <option value="both">Subdivide &amp; Collapse</option>
                  <option value="subdivide">Subdivide Only</option>
                  <option value="collapse">Collapse Only</option>
                </select>
              </label>
              <hr />
              <span className="geometry-menu-note">Dyntopo triangulates the area under the brush, as it does in Blender.</span>
              <hr />
              <span className="geometry-menu-heading">Remesh</span>
              <label className="geometry-menu-field">Voxel Size
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={remeshDetail}
                  title="Voxel size in local units, as in Blender. 0 picks one to match the current density."
                  onChange={(event) => setRemeshDetail(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <button disabled={busy} onClick={(e) => run(e, doRemesh)}>{busy ? "Remeshing…" : "Voxel Remesh"}</button>
              <span className="geometry-menu-note">Rebuilds the surface as uniform quads at the voxel size, as Blender's Remesh does. Resets UVs.</span>
            </ToolbarMenu>
          <ToolbarMenu label="Symmetry">
              {["x", "y", "z"].map((axis) => (
                <button key={axis} className={symmetry[axis] ? "active" : ""} onClick={(e) => run(e, () => setSymmetry((value) => ({ ...value, [axis]: !value[axis] })))}>
                  Mirror {axis.toUpperCase()}
                </button>
              ))}
              <hr />
              <label className="geometry-menu-field">Falloff
                <select value={brushFalloff} onChange={(event) => setBrushFalloff(event.target.value)}>
                  {FALLOFFS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
            </ToolbarMenu>
          <ToolbarMenu label="View">
              <span className="geometry-menu-heading">Shading <kbd>Z</kbd></span>
              {SHADING_MODES.map((entry) => (
                <button key={entry.id} className={shading === entry.id ? "active" : ""} title={entry.hint} onClick={(e) => run(e, () => setShading(entry.id))}>
                  {entry.label}
                </button>
              ))}
              <hr />
              <button className={showSceneContext ? "active" : ""} onClick={(e) => run(e, () => setShowSceneContext((value) => !value))}><Layers size={13} /> Scene Context</button>
              <button onClick={(e) => run(e, focusGeometry)}>Frame All <kbd>Home</kbd></button>
            </ToolbarMenu>
        </>)}

        {editorMode === "paint" && (<>
          <label className="geometry-brush-field" title="Brush colour">C
            <input type="color" value={paintColor} onChange={(event) => setPaintColor(event.target.value)} />
          </label>
          <label className="geometry-brush-field" title="Brush radius ( [ and ] )">R
            <input type="range" min={0.005} max={2} step={0.005} value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} />
            <span>{brushRadius.toFixed(3)}</span>
          </label>
          <label className="geometry-brush-field" title="Brush strength">S
            <input type="range" min={0.01} max={1} step={0.01} value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} />
            <span>{brushStrength.toFixed(2)}</span>
          </label>
          <ToolbarMenu label="Paint">
              <span className="geometry-menu-heading">Blend</span>
              {PAINT_BLEND_MODES.map((entry) => (
                <button key={entry.id} className={paintBlend === entry.id ? "active" : ""} onClick={(e) => run(e, () => setPaintBlend(entry.id))}>
                  {entry.label}
                </button>
              ))}
              <hr />
              <label className="geometry-menu-field">Falloff
                <select value={brushFalloff} onChange={(event) => setBrushFalloff(event.target.value)}>
                  {FALLOFFS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
              <label className="geometry-menu-field">Resolution
                <select value={paintResolution} onChange={(event) => setPaintResolution(Number(event.target.value))}>
                  {[256, 512, 1024, 2048].map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <span className="geometry-menu-note">Changing the resolution starts a new blank layer.</span>
              <hr />
              <button onClick={(e) => run(e, undoPaintStroke)}>Undo Stroke <kbd>Ctrl+Z</kbd></button>
              <button onClick={(e) => run(e, savePaintTexture)}>Save as PNG</button>
              <span className="geometry-menu-note">Saved to the project's textures folder. Assign it in the material to use it.</span>
            </ToolbarMenu>
          <ToolbarMenu label="View">
              <button className={showSceneContext ? "active" : ""} onClick={(e) => run(e, () => setShowSceneContext((value) => !value))}><Layers size={13} /> Scene Context</button>
              <button onClick={(e) => run(e, focusGeometry)}>Frame All <kbd>Home</kbd></button>
            </ToolbarMenu>
        </>)}

        </div>

        {/* Pinned: undo/redo, the topology readout and the way out of Edit Mode
            must stay reachable at any width, so they sit outside the scroller. */}
        <div className="geometry-editor-toolbar-pinned">
          <button className="toolbar-btn icon-only" title="Undo (Ctrl+Z)" disabled={!session?.history.length} onClick={undo}><Undo2 size={14} /></button>
          <button className="toolbar-btn icon-only" title="Redo (Ctrl+Shift+Z)" disabled={!session?.future.length} onClick={redo}><Redo2 size={14} /></button>
          <span className="geometry-editor-stat geometry-topology-count" key={revision} title={stats ? `${stats.verts} verts · ${stats.edges} edges · ${stats.faces} faces (${stats.triangles} tris, ${stats.quads} quads, ${stats.ngons} n-gons)${stats.nonManifold ? ` · ${stats.nonManifold} non-manifold edges` : ""}` : ""}>
            {stats ? `${stats.verts}v · ${stats.edges}e · ${stats.faces}f` : ""}
          </span>
          {embedded && <button className="toolbar-btn icon-only" title="Cancel scene edit" onClick={onClose}><X size={14} /></button>}
        </div>
      </div>
      </ToolbarMenuProvider>

      <div className="geometry-editor-viewport" ref={hostRef}>
        {session && <AxisViewGizmo camera={session.camera} controls={session.controls} activeView={snapView} onSnap={handleAxisSnap} />}
      </div>

      {selectionGesture?.kind === "box" && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const left = Math.min(selectionGesture.start.x, selectionGesture.current.x) - rect.left;
        const top = Math.min(selectionGesture.start.y, selectionGesture.current.y) - rect.top;
        return <div className="geometry-selection-rect" style={{ left, top, width: Math.abs(selectionGesture.current.x - selectionGesture.start.x), height: Math.abs(selectionGesture.current.y - selectionGesture.start.y) }} />;
      })()}
      {selectionGesture?.kind === "circle" && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const radius = selectionGesture.radius;
        return <div className="geometry-selection-circle" style={{ left: selectionGesture.current.x - rect.left - radius, top: selectionGesture.current.y - rect.top - radius, width: radius * 2, height: radius * 2 }} />;
      })()}
      {selectionGesture?.kind === "lasso" && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect || !selectionGesture.path?.length) return null;
        const points = selectionGesture.path.map((point) => `${point.x - rect.left},${point.y - rect.top}`).join(" ");
        return (
          <svg className="geometry-selection-lasso" width={rect.width} height={rect.height}>
            <polygon points={points} />
          </svg>
        );
      })()}

      {(editorMode === "sculpt" || editorMode === "paint") && brushCursor && (
        <div
          className={`geometry-brush-cursor ${brushCursor.off ? "off-surface" : ""}`}
          style={{
            left: brushCursor.x - (brushCursor.radius ?? 24),
            top: brushCursor.y - (brushCursor.radius ?? 24),
            width: (brushCursor.radius ?? 24) * 2,
            height: (brushCursor.radius ?? 24) * 2,
          }}
        />
      )}
      {/* Blender draws the proportional influence as a circle around the
          transform centre. Without it the wheel appears to do nothing and the
          only sign the mode is on at all is a number in the corner. */}
      {macroState?.circle && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return (
          <div
            className="geometry-proportional-circle"
            style={{
              left: macroState.circle.x - rect.left - macroState.circle.r,
              top: macroState.circle.y - rect.top - macroState.circle.r,
              width: macroState.circle.r * 2,
              height: macroState.circle.r * 2,
            }}
          />
        );
      })()}

      {/* Where the magnet actually caught, so a snap is something you can see
          rather than something you infer from the numbers afterwards. */}
      {macroState?.snapAt && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return <div className="geometry-snap-marker" style={{ left: macroState.snapAt.x - rect.left, top: macroState.snapAt.y - rect.top }} />;
      })()}

      {addMenu && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return (
          <div
            className="geometry-add-menu"
            style={{
              left: Math.min(addMenu.x - rect.left, Math.max(rect.width - 190, 0)),
              top: Math.min(addMenu.y - rect.top, Math.max(rect.height - 300, 0)),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.preventDefault()}
          >
            <span className="geometry-menu-heading">Add Mesh</span>
            {PRIMITIVES.map((entry) => (
              <button key={entry.id} onClick={() => doAddPrimitive(entry.id)}>{entry.label}</button>
            ))}
          </div>
        );
      })()}

      {knifePoints && (
        <div className="geometry-transform-hud">
          <strong>Knife</strong>
          <span className="geometry-transform-value">{knifePoints.length} point{knifePoints.length === 1 ? "" : "s"}</span>
          <small>Click to place · Enter to cut · Esc cancel</small>
        </div>
      )}
      {macroState && (
        <div className="geometry-transform-hud">
          <strong>{macroState.label}</strong>
          {(macroState.kind === "loopcut" || macroState.kind === "bevel") && <span className="geometry-transform-value">{macroState.segments ?? 1}×</span>}
          <span>
            {macroState.kind === "loopcut"
              ? (macroState.locked ? "Edge Slide" : "Scroll for cuts")
              : macroState.kind === "bevel"
                ? `${Math.round((macroState.amount ?? 0) * 1000) / 1000} width`
                : macroState.kind === "inset"
                  ? `${Math.round((macroState.amount ?? 0) * 1000) / 1000} thickness`
                  : macroState.axis
                    ? `${macroState.axis.toUpperCase()} · ${macroState.orientation}`
                    : macroState.kind === "extrude" && !macroState.free ? "Normal" : "Free"}
          </span>
          {macroState.buffer && <span className="geometry-transform-value">{macroState.buffer}{macroState.kind === "rotate" ? "°" : ""}</span>}
          {macroState.proportional && <span className="geometry-transform-value">O {Math.round((macroState.radius ?? 0) * 100) / 100}</span>}
          {macroState.snapKind && <span className="geometry-transform-value">⌖ {macroState.snapKind}</span>}
          <small>
            {macroState.kind === "loopcut" && !macroState.locked
              ? "Scroll cuts · LMB to slide · Esc cancel"
              : "LMB / Enter confirm · Esc / RMB cancel · X/Y/Z axis · Shift+axis plane · Shift precision"}
          </small>
        </div>
      )}

      <button
        className={`geometry-help-toggle ${showHelp ? "active" : ""}`}
        title={showHelp ? "Hide shortcuts" : "Show shortcuts"}
        onClick={() => setShowHelp((value) => !value)}
      >
        ?
      </button>
      {showHelp && (editorMode === "paint" ? (
        <div className="geometry-editor-shortcuts">
          <kbd>LMB</kbd> paint <kbd>Ctrl</kbd> erase <kbd>[ ]</kbd> radius <kbd>Ctrl+Z</kbd> undo stroke <kbd>Z</kbd> shading
        </div>
      ) : editorMode === "sculpt" ? (
        <div className="geometry-editor-shortcuts">
          <kbd>LMB</kbd> sculpt <kbd>Ctrl</kbd> invert <kbd>Shift</kbd> smooth <kbd>[ ]</kbd> radius <kbd>D</kbd> dyntopo <kbd>X C I S F G</kbd> brushes
        </div>
      ) : (
        <div className="geometry-editor-shortcuts">
          <kbd>1/2/3</kbd> modes <kbd>E</kbd> extrude <kbd>I</kbd> inset <kbd>Ctrl+R</kbd> loop cut <kbd>Ctrl+B</kbd> bevel <kbd>K</kbd> knife <kbd>F</kbd> make face <kbd>X</kbd> delete <kbd>M</kbd> merge <kbd>Alt+Click</kbd> loop <kbd>Ctrl+Click</kbd> path
        </div>
      ))}
      {status && <div className="geometry-editor-status">{status}</div>}
    </div>
  );
}
