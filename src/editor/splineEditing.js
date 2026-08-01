import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { normalizeKnot } from "../engine/spline/splineMath.js";
import { engine } from "./engineInstance.js";
import { vmSingleton } from "./singleton.js";
import { commandBus } from "./commands/CommandBus.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Viewport editing for splines (roadmap item 16).
 *
 * The runtime half of a spline is a few hundred lines of arithmetic; the half
 * that decides whether anyone uses it is this one. A path authored by typing
 * numbers into a knot list is not a *scene tool* — it is a data structure with
 * an inspector. What makes it a tool is grabbing a knot in the viewport and
 * watching the road follow.
 *
 * ## Handles are one InstancedMesh, and the pick comes from `instanceId`
 *
 * A mesh per knot is a draw call per knot and an object per knot to keep in
 * sync with an array that changes shape on every insert. One instanced mesh
 * plus an index→(knot, handle) map is rebuilt in a loop whenever the spline
 * changes, and three's raycaster hands back `instanceId` directly, so picking
 * is a table lookup rather than a search.
 *
 * ## The handles are sized in SCREEN space
 *
 * A fixed world radius is either invisible on a 300m road or the size of a
 * house on a 2m one, and a path is exactly the kind of object that spans both.
 * Each instance is scaled per frame by its distance to the camera, so a knot is
 * always about the same number of pixels — the same reason the geometry
 * editor's magnet snapping had to become screen-space.
 *
 * ## One undo step per gesture
 *
 * A drag writes straight into `props.knots` for live feedback (a command per
 * pointermove would make Ctrl+Z a frame-by-frame rewind of the drag), and the
 * whole before/after array is pushed as a single `SetComponentPropCommand` on
 * release. Insert and delete are one command each, immediately.
 */

const HANDLE_PIXELS = 7;
const KNOT_COLOR = new THREE.Color("#ffffff");
const TANGENT_COLOR = new THREE.Color("#7aa2ff");

/**
 * ALL mutable state lives in the singleton, not in module-level `let`s.
 *
 * Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`, and an
 * HMR update re-evaluates it outright — so a plain `let handles = null` is one
 * variable per copy. That is not a theoretical concern here: the first
 * smoke run caught it, because the harness's copy of this module had its own
 * `handles` (a second, invisible set of meshes) and its own "which spline was I
 * last looking at" latch, which cleared the knot selection the first time it
 * ran and made every drag a silent no-op. The gizmo moved, the knot did not.
 */
const state = vmSingleton("splineEdit", () => ({
  armed: false,
  /** Selected control point: `{ knot, handle }` where handle is null|"in"|"out". */
  selection: null,
  listeners: new Set(),
  /** `{ knotMesh, tangentMesh, proxy, entries }`, built on first use. */
  handles: null,
  /** In-flight drag: `{ entityId, before }`. */
  drag: null,
  /** The spline the selection belongs to, so switching paths can drop it. */
  lastComponent: null,
  /** Alt: author a corner instead of a smooth knot. */
  breakTangent: false,
}));

export function getSplineEdit() {
  return { armed: state.armed, selection: state.selection };
}

export function subscribeSplineEdit(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function notify() {
  for (const fn of state.listeners) fn(getSplineEdit());
}

export function setSplineEditArmed(value) {
  const next = !!value;
  if (next === state.armed) return;
  state.armed = next;
  // Leaving edit mode must drop the knot selection too, or the transform gizmo
  // stays attached to a proxy nobody can see.
  if (!next) state.selection = null;
  notify();
}

export function selectKnot(knot, handle = null) {
  const next = knot >= 0 ? { knot, handle } : null;
  const same =
    next?.knot === state.selection?.knot && next?.handle === state.selection?.handle;
  if (same) return;
  state.selection = next;
  notify();
}

/** The spline component being edited, or null when edit mode doesn't apply. */
export function activeSpline() {
  if (!state.armed || engine.playing) return null;
  const ids = useSelectionStore.getState().ids;
  const component = ids.length === 1 ? engine.getEntity(ids[0])?.getComponent?.("spline") ?? null : null;
  // Selecting a different path must drop the knot selection: knot 5 of the old
  // spline is a different point (or no point at all) on the new one, and the
  // transform gizmo would be sitting on it.
  if (component !== state.lastComponent) {
    state.lastComponent = component;
    if (state.selection) {
      state.selection = null;
      notify();
    }
  }
  return component;
}

// ---- handle rendering ------------------------------------------------------

const MAX_HANDLES = 1024;

/**
 * Two instanced meshes, one per colour, rather than one with per-instance
 * colours. `InstancedMesh.instanceColor` is a WebGL-era path with no guaranteed
 * equivalent in three's node/WebGPU materials, and a debug overlay is a bad
 * place to find that out. Selection feedback comes from the transform gizmo,
 * which is parked exactly on the selected handle.
 */
function makeHandleMesh(name, color, order) {
  const material = new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), material, MAX_HANDLES);
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.userData.editorOnly = true;
  // Deliberately no `entityId`: a click on a handle must not fall through to
  // "select the path entity" — the handle IS what is being selected.
  mesh.layers.set(EDITOR_LAYER);
  engine.scene.add(mesh);
  return mesh;
}

function ensureHandles() {
  // The parent check, not just a null check: the singleton outlives the engine
  // (opening another project builds a new one), and meshes still parented to
  // the previous scene are handles that draw nowhere and pick nothing.
  if (state.handles && state.handles.knotMesh.parent === engine.scene) return state.handles;
  if (state.handles) disposeSplineHandles();
  const knotMesh = makeHandleMesh("__splineKnots", KNOT_COLOR, 1000);
  const tangentMesh = makeHandleMesh("__splineTangents", TANGENT_COLOR, 1001);

  // The transform gizmo cannot attach to an instance, so it drives a proxy that
  // is parked on the selected handle — the same trick the 3D cursor uses.
  const proxy = new THREE.Object3D();
  proxy.name = "__splineHandleProxy";
  proxy.userData.editorOnly = true;
  proxy.userData.splineHandle = true;
  engine.scene.add(proxy);

  state.handles = { knotMesh, tangentMesh, proxy, entries: [] };
  return state.handles;
}

export function isSplineHandleTarget(object) {
  return !!object?.userData?.splineHandle;
}

export function splineHandleProxy() {
  return ensureHandles().proxy;
}

/** World position of a control point, in the path entity's world space. */
function controlWorld(component, knot, handle, out = new THREE.Vector3()) {
  const k = normalizeKnot(component.props.knots?.[knot] ?? {});
  out.fromArray(k.position);
  if (handle === "in") out.add(_scratch.fromArray(k.handleIn));
  else if (handle === "out") out.add(_scratch.fromArray(k.handleOut));
  component.entity.object3D.updateWorldMatrix(true, false);
  return out.applyMatrix4(component.entity.object3D.matrixWorld);
}

/**
 * Rebuilds the handle instances for the current spline. Called every frame:
 * the positions are cheap, and the alternative (invalidating on the six events
 * that can change them) is the class of bug where a handle is left floating
 * beside the knot it belongs to.
 */
export function updateSplineHandles(camera, canvasHeight) {
  const component = activeSpline();
  if (!component || !camera) {
    if (state.handles) {
      state.handles.knotMesh.count = 0;
      state.handles.tangentMesh.count = 0;
    }
    return;
  }
  const { knotMesh, tangentMesh } = ensureHandles();
  const knots = component.props.knots ?? [];
  const bezier = component.props.type === "bezier";
  const entries = [];
  for (let i = 0; i < knots.length && entries.length < MAX_HANDLES; i++) {
    entries.push({ knot: i, handle: null, mesh: knotMesh });
    if (bezier) {
      entries.push({ knot: i, handle: "in", mesh: tangentMesh });
      entries.push({ knot: i, handle: "out", mesh: tangentMesh });
    }
  }
  state.handles.entries = entries;

  // Roughly constant pixel size: at a vertical field of view f, one world unit
  // at distance d spans `canvasHeight / (2 d tan(f/2))` pixels.
  const tan = Math.tan(THREE.MathUtils.degToRad((camera.fov ?? 50) * 0.5));
  let knotCount = 0;
  let tangentCount = 0;
  for (const entry of entries) {
    controlWorld(component, entry.knot, entry.handle, _position);
    const distance = camera.isOrthographicCamera
      ? 1
      : Math.max(0.01, camera.position.distanceTo(_position));
    const perPixel = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / (camera.zoom || 1) / Math.max(1, canvasHeight)
      : (2 * distance * tan) / Math.max(1, canvasHeight);
    const size = perPixel * HANDLE_PIXELS * (entry.handle ? 0.7 : 1);
    _matrix.makeScale(size, size, size).setPosition(_position);
    if (entry.handle) {
      entry.index = tangentCount;
      tangentMesh.setMatrixAt(tangentCount++, _matrix);
    } else {
      entry.index = knotCount;
      knotMesh.setMatrixAt(knotCount++, _matrix);
    }
  }
  knotMesh.count = knotCount;
  tangentMesh.count = tangentCount;
  knotMesh.instanceMatrix.needsUpdate = true;
  tangentMesh.instanceMatrix.needsUpdate = true;

  // Park the gizmo proxy on the selected control point. Skipped mid-drag, or
  // it would fight the gizmo for the same transform every frame.
  const selection = state.selection;
  if (selection && !state.drag && selection.knot < knots.length) {
    controlWorld(component, selection.knot, selection.handle, state.handles.proxy.position);
    state.handles.proxy.updateMatrixWorld(true);
  }
}

/** Raycasts the handle instances; returns `{ knot, handle }` or null. */
export function pickSplineHandle(raycaster) {
  const component = activeSpline();
  const handles = state.handles;
  if (!component || !handles) return null;
  let best = null;
  for (const mesh of [handles.tangentMesh, handles.knotMesh]) {
    if (!mesh.count) continue;
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) continue;
    // Tangent handles are tested first and win ties: they sit on top of their
    // knot's stem, and a handle you can never grab is worse than a knot that
    // occasionally needs a second click.
    const entry = handles.entries.find((e) => e.mesh === mesh && e.index === hits[0].instanceId);
    if (entry && (!best || hits[0].distance < best.distance)) {
      best = { knot: entry.knot, handle: entry.handle, distance: hits[0].distance };
    }
    if (mesh === handles.tangentMesh && best) break;
  }
  return best ? { knot: best.knot, handle: best.handle } : null;
}

// ---- dragging --------------------------------------------------------------

export function beginSplineDrag() {
  const component = activeSpline();
  if (!component || !state.selection) return false;
  state.drag = {
    entityId: component.entity.id,
    before: JSON.parse(JSON.stringify(component.props.knots ?? [])),
  };
  return true;
}

/** Writes the proxy's world position back into the knot. Live, per frame. */
export function applySplineDrag() {
  const component = activeSpline();
  if (!component || !state.selection || !state.drag) return;
  const proxy = ensureHandles().proxy;
  component.entity.object3D.updateWorldMatrix(true, false);
  _local.copy(proxy.position).applyMatrix4(_inverse.copy(component.entity.object3D.matrixWorld).invert());
  const knots = [...(component.props.knots ?? [])];
  const knot = normalizeKnot(knots[state.selection.knot] ?? {});
  const handle = state.selection.handle;
  if (!handle) {
    knot.position = _local.toArray();
  } else {
    // A handle is stored RELATIVE to its knot, so the drag is a subtraction —
    // storing it absolute would make moving the knot leave its handles behind.
    _local.sub(_scratch.fromArray(knot.position));
    if (handle === "in") {
      knot.handleIn = _local.toArray();
      // Mirror the opposite handle: a bezier knot whose two handles are not
      // collinear has a visible crease, and authoring one on purpose is rare
      // enough to be worth the Alt modifier it costs to get back.
      if (!state.breakTangent) knot.handleOut = _local.clone().negate().toArray();
    } else {
      knot.handleOut = _local.toArray();
      if (!state.breakTangent) knot.handleIn = _local.clone().negate().toArray();
    }
  }
  knots[state.selection.knot] = knot;
  component.props.knots = knots;
  component.invalidate();
}

export function commitSplineDrag() {
  const component = activeSpline();
  const drag = state.drag;
  state.drag = null;
  if (!component || !drag) return;
  const after = component.props.knots ?? [];
  if (JSON.stringify(after) === JSON.stringify(drag.before)) return;
  // Restore the pre-drag value first so the command's own redo/undo pair is the
  // only thing that ever writes it — otherwise the "before" the command
  // captures is already the dragged state and undo does nothing.
  component.props.knots = drag.before;
  component.invalidate();
  commandBus.execute(
    new SetComponentPropCommand(drag.entityId, "spline", "knots", JSON.parse(JSON.stringify(after))),
  );
}

export function isSplineDragging() {
  return !!state.drag;
}

/** Alt breaks the mirrored-tangent rule for as long as it is held. */
export function setBreakTangent(value) {
  state.breakTangent = !!value;
}

// ---- structural edits ------------------------------------------------------

/**
 * Inserts a knot on the curve at `distance` along it.
 *
 * The new knot goes between the two it lies between, which is the only
 * placement that doesn't reshape the path: appending it to the end instead
 * (the easy implementation) sends the road off to wherever you clicked.
 */
export function insertKnotAt(distance) {
  const component = activeSpline();
  if (!component?.spline?.valid) return false;
  const spline = component.spline;
  const clamped = THREE.MathUtils.clamp(distance, 0, spline.length);
  const point = spline.pointAtDistance(clamped, new THREE.Vector3());
  // Which segment the distance falls in — the sample table already knows.
  let segment = 0;
  for (let i = 0; i < spline.sampleCount - 1; i++) {
    if (spline.sampleDistance(i) <= clamped && clamped <= spline.sampleDistance(i + 1)) {
      segment = Math.floor(i / spline.samplesPerSegment);
      break;
    }
  }
  const knots = [...(component.props.knots ?? [])].map((k) => normalizeKnot(k));
  const tangent = spline.tangentAtDistance(clamped, new THREE.Vector3()).multiplyScalar(
    Math.max(0.25, spline.length * 0.08),
  );
  knots.splice(segment + 1, 0, {
    position: point.toArray(),
    handleIn: tangent.clone().negate().toArray(),
    handleOut: tangent.toArray(),
    roll: 0,
  });
  commandBus.execute(new SetComponentPropCommand(component.entity.id, "spline", "knots", knots));
  selectKnot(segment + 1, null);
  return true;
}

/** Appends a knot at a world position, extending the path from its last knot. */
export function appendKnot(worldPoint) {
  const component = activeSpline();
  if (!component) return false;
  component.entity.object3D.updateWorldMatrix(true, false);
  _local.copy(worldPoint).applyMatrix4(_inverse.copy(component.entity.object3D.matrixWorld).invert());
  const knots = [...(component.props.knots ?? [])].map((k) => normalizeKnot(k));
  const previous = knots[knots.length - 1];
  const tangent = previous
    ? _scratch.copy(_local).sub(_position.fromArray(previous.position)).multiplyScalar(0.33)
    : _scratch.set(0, 0, 1);
  knots.push({
    position: _local.toArray(),
    handleIn: tangent.clone().negate().toArray(),
    handleOut: tangent.toArray(),
    roll: 0,
  });
  commandBus.execute(new SetComponentPropCommand(component.entity.id, "spline", "knots", knots));
  selectKnot(knots.length - 1, null);
  return true;
}

export function deleteSelectedKnot() {
  const component = activeSpline();
  const selection = state.selection;
  if (!component || !selection) return false;
  const knots = component.props.knots ?? [];
  // Two knots is the minimum that is still a path. Deleting past that leaves a
  // component whose curve has vanished and no obvious way to get it back.
  if (knots.length <= 2) return false;
  const next = knots.filter((_, i) => i !== selection.knot).map((k) => normalizeKnot(k));
  commandBus.execute(new SetComponentPropCommand(component.entity.id, "spline", "knots", next));
  selectKnot(Math.min(selection.knot, next.length - 1), null);
  return true;
}

/**
 * Screen-space hit test against the drawn curve.
 *
 * A ray/curve intersection in world space would need a tolerance in world
 * units, which is the same "invisible on a big path, enormous on a small one"
 * problem the handles have. Projecting the samples and measuring in pixels is
 * both simpler and the thing the user is actually aiming with.
 */
export function pickCurve(clientX, clientY, rect, camera, pixelRadius = 10) {
  const component = activeSpline();
  if (!component?.spline?.valid) return null;
  const spline = component.spline;
  component.entity.object3D.updateWorldMatrix(true, false);
  const matrix = component.entity.object3D.matrixWorld;
  let best = null;
  for (let i = 0; i < spline.sampleCount; i++) {
    spline.samplePosition(i, _position).applyMatrix4(matrix).project(camera);
    if (_position.z < -1 || _position.z > 1) continue;
    const x = rect.left + (_position.x * 0.5 + 0.5) * rect.width;
    const y = rect.top + (-_position.y * 0.5 + 0.5) * rect.height;
    const d = Math.hypot(x - clientX, y - clientY);
    if (d < pixelRadius && (!best || d < best.pixels)) {
      best = { pixels: d, distance: spline.sampleDistance(i) };
    }
  }
  return best;
}

export function disposeSplineHandles() {
  const handles = state.handles;
  if (!handles) return;
  for (const mesh of [handles.knotMesh, handles.tangentMesh]) {
    engine.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  engine.scene.remove(handles.proxy);
  state.handles = null;
}

const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _local = new THREE.Vector3();
