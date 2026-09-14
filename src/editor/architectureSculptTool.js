import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { getComponentClass } from "../engine/components/registry.js";
import { commandBus, useHistoryStore } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { disarmArchitectureTool, subscribeArchitectureTool, getArchitectureToolState } from "./architectureTool.js";
import { disarmArchitecturePlacement, subscribeArchitecturePlacement, isArchitecturePlacementActive } from "./architecturePlacementTool.js";
import { disarmTerrainBrush, subscribeTerrainBrush, getTerrainBrushMode } from "./terrainBrush.js";
import { createArchitectureModel, setArchitectureModel, getArchitectureModelRoot } from "./architectureModelBuild.js";
import { buildArchitectureFormGeometry } from "../modules/architecture/formGeometry.js";
import { resolveArchitectureForm } from "../modules/architecture/formModel.js";
import { resolveStyle, DEFAULT_STYLE_ID, STYLE_IDS } from "../modules/architecture/styles/catalog.js";

const TOOLS = ["build", "round", "wall", "grow", "reshape", "path", "window", "door", "paint", "erase"];
// roof "auto" + roofHeight 0 + thickness 0 follow the composition style (pitch, wall and boundary sizes).
const defaults = { tool: "build", height: 4, width: 6, thickness: 0, roofHeight: 0, roof: "auto", color: "#ddc7a5", windows: true, cellSize: 3, snap: 0, parentId: null, style: DEFAULT_STYLE_ID };
let state = { ...defaults, active: false, rootId: null, formId: null, hover: null, dragging: false, error: "" };
const listeners = new Set();
let teardownPrevious = null, cancelGesture = null;
const clone = value => structuredClone(value);
const notify = () => { for (const listener of listeners) listener(); };
const uid = () => THREE.MathUtils.generateUUID();
const emptyModel = () => ({ forms: [], paths: [], openings: [] });
const componentOf = root => root?.getComponent("architecture");
const modelOf = root => clone(componentOf(root)?.model ?? componentOf(root)?.props.model ?? emptyModel());
const resolveRoot = id => id ? getArchitectureModelRoot(id) : null;
const selectedRoot = () => resolveRoot(state.rootId);
const styleOf = root => { const style = root && modelOf(root).style; return style ? resolveStyle(style.id, style.params) : null; };
const validStyle = value => { if (value && !STYLE_IDS.includes(value)) throw new Error(`Unknown architecture style "${value}".`); return value; };
const finite = (value, min, max, name) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`); return value; };

export function isArchitectureSculptActive() { return state.active; }
export function getArchitectureSculptState() { return clone({ ...state, entityId: state.rootId, selectedEntityId: state.rootId, selectedFormId: state.formId, settings: Object.fromEntries(Object.keys(defaults).map(key => [key, state[key]])) }); }
export function subscribeArchitectureSculpt(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function armArchitectureSculpt(options = {}) {
  if (!getComponentClass("architecture")) throw new Error("Enable Architecture before shaping buildings.");
  // ⚠ A RE-ARM DURING A GESTURE IS DISCARDED, NOT APPLIED. A build/round/wall/
  // reshape drag holds an open preview transaction; arm() below cancels it,
  // and cancelPreview UNDOES the form under construction. The workspace's
  // React effects re-arm on open/request flips and commit after paint — they
  // used to land exactly here, erasing the tower mid-drag and churning
  // cancel/undo/re-create every drag. Whatever the re-arm wanted can be
  // armed again once the pointer is up.
  if (state.dragging) return getArchitectureSculptState();
  const next = { ...defaults, ...options };
  if (!TOOLS.includes(next.tool)) throw new Error(`Unknown architecture gesture "${next.tool}".`);
  for (const key of ["height", "width", "cellSize"]) finite(next[key], .1, 10000, key);
  finite(next.thickness, 0, 10000, "thickness"); finite(next.roofHeight, 0, 10000, "Roof height"); finite(next.snap, 0, 100, "Snap"); validStyle(next.style);
  if (!/^#[0-9a-f]{6}$/i.test(next.color)) throw new Error("Color must be a six-digit hex color.");
  if (next.parentId && !engine.getEntity(next.parentId)) throw new Error("The target assembly no longer exists.");
  // An arm that changes NOTHING the tool owns is a no-op rather than a
  // restart: restarting disarms mid-session, drops the ghost/highlight, and
  // clears the selection for no reason. The workspace open-effect re-arms on
  // every [ui.open, ui.request] flip.
  const unchanged = state.active && next.tool === state.tool
    && Object.keys(defaults).every((key) => Object.is(next[key], state[key]))
    && (Object.hasOwn(options, "entityId") ? options.entityId : state.rootId) === state.rootId;
  if (unchanged) return getArchitectureSculptState();
  cancelGesture?.();
  disarmArchitectureTool(); disarmArchitecturePlacement(); disarmTerrainBrush();
  const targetId = Object.hasOwn(options, "entityId") ? options.entityId : state.rootId ?? resolveRoot(useSelectionStore.getState().ids[0])?.id;
  if (targetId && !resolveRoot(targetId)) throw new Error("The selected architecture model no longer exists.");
  state = { ...state, ...next, active: true, rootId: targetId ?? null, dragging: false, hover: null, error: "" };
  if (!resolveRoot(state.rootId)) state.rootId = null;
  notify(); return getArchitectureSculptState();
}
export function disarmArchitectureSculpt() {
  const active = state.active;
  cancelGesture?.();
  state = { ...state, active: false, dragging: false, hover: null, error: "" };
  notify(); return active;
}
export function setArchitectureSculptSetting(key, value) {
  if (key === "entityId") {
    if (value && !resolveRoot(value)) throw new Error("The selected architecture model no longer exists.");
    cancelGesture?.(); state.rootId = value ?? null; state.formId = null; notify(); return getArchitectureSculptState();
  }
  if (!(key in defaults)) throw new Error(`Unknown architecture setting "${key}".`);
  if (key === "tool" && !TOOLS.includes(value)) throw new Error("Unknown architecture tool.");
  if (["height", "width", "cellSize"].includes(key)) finite(value, .1, 10000, key);
  if (["roofHeight", "snap", "thickness"].includes(key)) finite(value, 0, key === "snap" ? 100 : 10000, key);
  if (key === "style") validStyle(value);
  if (key === "color" && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Color must be a six-digit hex color.");
  if (key === "parentId" && value && !engine.getEntity(value)) throw new Error("The target assembly no longer exists.");
  if (key === "tool" || key === "parentId") cancelGesture?.();
  state = { ...state, [key]: value, error: "" };
  notify(); return getArchitectureSculptState();
}
export function dispatchArchitectureSculptKey(event) {
  if (!state.active || event.altKey) return false;
  const key = event.key?.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (state.dragging && key === "z") { cancelGesture?.(); return true; }
    return false;
  }
  if (key === "escape") { if (state.dragging) cancelGesture?.(); else disarmArchitectureSculpt(); return true; }
  // These ordinary transform shortcuts must not also transform the model root
  // while a form handle owns the same keys. Undo remains the editor's command.
  return ["g", "r", "s", "delete", "backspace", "tab"].includes(key);
}

function dispose(object) {
  if (!object) return;
  const materials = new Set();
  object.traverse(part => { part.geometry?.dispose(); for (const material of Array.isArray(part.material) ? part.material : part.material ? [part.material] : []) materials.add(material); });
  for (const material of materials) material.dispose();
  object.removeFromParent();
}
function editorObject(object, kind) {
  object.userData.editorOnly = true;
  object.userData[kind] = true;
  object.traverse(part => { part.layers.set(EDITOR_LAYER); part.userData.editorOnly = true; });
  object.renderOrder = 100;
  return object;
}
function localPoint(root, point) { root?.object3D.updateWorldMatrix(true, false); return root ? root.object3D.worldToLocal(point.clone()) : point.clone(); }
function worldPoint(root, point) { root?.object3D.updateWorldMatrix(true, false); return root ? root.object3D.localToWorld(point.clone()) : point.clone(); }
function worldNormal(root, normal) {
  root?.object3D.updateWorldMatrix(true, false);
  return root ? normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(root.object3D.matrixWorld)) : normal.clone();
}
function localNormal(root, normal) {
  root?.object3D.updateWorldMatrix(true, false);
  // Normals are covectors: world = inverse-transpose(M) * local, so
  // returning to local needs transpose(M), even when inherited TRS shears M.
  return root ? normal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(root.object3D.matrixWorld).transpose()).normalize() : normal.clone();
}
function formPoint(form, point) { return point.clone().sub(new THREE.Vector3(...form.position)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -(form.rotationY ?? 0)); }
function fromForm(form, point) { return point.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), form.rotationY ?? 0).add(new THREE.Vector3(...form.position)); }
function makeForm(position, size, shape = "box") { return { id: uid(), shape, position: [...position], size: [...size], rotationY: 0, color: state.color, roof: state.roof, roofHeight: state.roofHeight > 0 ? state.roofHeight : null, windows: state.windows !== false }; }
function formKey(form) { return [...form.position, ...form.size, form.rotationY ?? 0].map(value => Math.round(value * 1000)).join(":"); }
function followOpenings(model, before, after) {
  const yaw = (after.rotationY ?? 0) - (before.rotationY ?? 0);
  for (const opening of model.openings ?? []) {
    if (opening.formId !== before.id) continue;
    const position = formPoint(before, new THREE.Vector3(...opening.position));
    position.x *= after.size[0] / before.size[0]; position.z *= after.size[2] / before.size[2];
    position.y = Math.max(opening.height / 2, Math.min(after.size[1] - opening.height / 2, position.y));
    opening.position = fromForm(after, position).toArray();
    opening.normal = new THREE.Vector3(...opening.normal).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).toArray();
  }
}

/** Direct volume sculpting owns canvas gestures, with no dependency on the
 * legacy wall/storey gesture implementation. Live edits use CommandBus preview
 * transactions: cancellation restores the exact model and release adds one undo. */
export function setupArchitectureSculptTool(canvas, viewport) {
  teardownPrevious?.();
  const raycaster = new THREE.Raycaster(); raycaster.layers.enableAll();
  const pointerNdc = new THREE.Vector2();
  const normalMatrix = new THREE.Matrix3();
  let pointer = null, drag = null, hover = null, ghost = null, highlight = null, handles = null;
  let ghostKey = "", highlightKey = "", handlesKey = "", alt = false, updating = false;
  // Pointer input arrives faster than frames — a gaming mouse fires 125-1000
  // pointermove events a second, and each sample used to run the WHOLE pipeline
  // synchronously: model rebuild, handle rebuild, a full-scene raycast, three
  // structuredClones. That was the sculpt drag freeze. Coalesce to the newest
  // sample per animation frame; the gesture edges (down/up) stay synchronous,
  // and event cancellation does too (preventDefault only counts during
  // dispatch, so it cannot wait for the frame).
  let pendingMove = null, moveFrame = 0;
  const originalMiddle = viewport.orbit?.mouseButtons?.MIDDLE;
  const originalTitle = canvas.title ?? "";
  const error = cause => { state.error = cause?.message ?? String(cause); notify(); };
  const ray = event => {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    viewport.camera.updateWorldMatrix(true, false); raycaster.setFromCamera(pointerNdc, viewport.camera);
    engine.scene.updateMatrixWorld(true); return raycaster.ray;
  };
  const rootForMesh = object => {
    for (let part = object; part; part = part.parent) {
      const root = resolveRoot(part.userData?.entityId);
      if (root) return root;
    }
    return null;
  };
  const surfaceHit = event => {
    ray(event);
    const meshes = [];
    const visit = object => { if (!object.visible || object.userData.editorOnly) return; if (object.isMesh && object.geometry) meshes.push(object); for (const child of object.children) visit(child); };
    for (const object of engine.scene.children) visit(object);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const root = rootForMesh(hit.object);
    const surfaces = hit.object.geometry.userData.architectureSurfaceRanges ?? hit.object.userData.architectureSurfaces ?? [];
    const surface = componentOf(root)?.surfaceAt?.(hit.faceIndex) ?? surfaces.find(range => hit.faceIndex * 3 >= range.start && hit.faceIndex * 3 < range.start + range.count);
    const form = root && modelOf(root).forms.find(form => form.id === surface?.formId);
    const hitNormal = hit.face?.normal.clone().applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld)) ?? new THREE.Vector3(0, 1, 0);
    return { ...hit, root, surface, form, local: localPoint(root, hit.point), normal: localNormal(root, hitNormal), worldNormal: hitNormal };
  };
  const planePoint = (event, root, elevation = 0) => {
    ray(event);
    const origin = worldPoint(root, new THREE.Vector3(0, elevation, 0));
    const normal = worldNormal(root, new THREE.Vector3(0, 1, 0));
    return raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), new THREE.Vector3());
  };
  const snapped = (point, event) => {
    if (!point) return point;
    const grid = event.ctrlKey ? 0 : state.snap;
    if (grid) { point.x = Math.round(point.x / grid) * grid; point.z = Math.round(point.z / grid) * grid; }
    return point;
  };
  const choose = (root, formId) => {
    state.rootId = root?.id ?? null; state.formId = formId ?? null;
    if (root && useSelectionStore.getState().ids[0] !== root.id) useSelectionStore.getState().select(root.id);
  };
  const begin = label => { commandBus.beginPreview(label); state.dragging = true; state.error = ""; };
  const write = (root, model) => {
    updating = true;
    try { setArchitectureModel(root.id, model); }
    finally { updating = false; }
  };
  const createRoot = point => {
    updating = true;
    try { return engine.getEntity(createArchitectureModel({ model: { ...emptyModel(), ...(state.style ? { style: { id: state.style, seed: 1 + Math.floor(Math.random() * 100000) } } : {}) }, position: point.toArray(), parentId: state.parentId, name: "Architecture" }).entityId); }
    finally { updating = false; }
  };
  const releaseCapture = () => {
    if (!drag) return;
    if (drag.pointerId !== undefined && canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    if (viewport.orbit) viewport.orbit.enabled = drag.orbitEnabled;
  };
  const finish = cancel => {
    if (!drag && !state.dragging) return;
    const draftRoot = drag?.root;
    releaseCapture(); drag = null; state.dragging = false;
    updating = true;
    try { componentOf(draftRoot)?.setDraft?.(false); if (cancel) commandBus.cancelPreview(); else commandBus.endPreview(); }
    finally { updating = false; }
    if (!resolveRoot(state.rootId)) { state.rootId = null; state.formId = null; }
    ghostKey = highlightKey = handlesKey = "";
    notify(); refresh();
  };
  cancelGesture = () => finish(true);
  const startPress = (event, data) => {
    drag = { ...data, pointerId: event.pointerId, x: event.clientX, y: event.clientY, orbitEnabled: viewport.orbit?.enabled ?? true };
    if (viewport.orbit) viewport.orbit.enabled = false;
    if (event.pointerId !== undefined) canvas.setPointerCapture?.(event.pointerId);
  };
  const setGhost = (root, form) => {
    const key = form ? `${root?.id ?? "world"}:${JSON.stringify(form)}` : "";
    if (ghostKey === key) return;
    ghostKey = key; dispose(ghost); ghost = null;
    if (!form) return;
    const built = buildArchitectureFormGeometry({ forms: [form], paths: [], openings: [] });
    const material = new THREE.MeshBasicMaterial({ color: state.color, transparent: true, opacity: .35, depthWrite: false, side: THREE.DoubleSide });
    ghost = editorObject(new THREE.Mesh(built.geometry, material), "architectureSculptPreview");
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(built.geometry, 30), new THREE.LineBasicMaterial({ color: 0x9ee9c3, transparent: true, opacity: .9, depthWrite: false }));
    ghost.add(editorObject(edges, "architectureSculptPreview"));
    ghost.raycast = () => {}; edges.raycast = () => {};
    if (root) { ghost.matrixAutoUpdate = false; ghost.matrix.copy(root.object3D.matrixWorld); }
    engine.scene.add(ghost);
  };
  const setHighlight = hit => {
    const targetId = hit?.form?.id ?? hit?.surface?.pathId;
    const key = targetId ? `${hit.root.id}:${targetId}:${hit.surface?.start}:${state.tool}` : "";
    if (key === highlightKey) return;
    highlightKey = key; dispose(highlight); highlight = null;
    if (!hit?.surface || !targetId) return;
    const source = hit.object.geometry, positions = source.attributes.position, index = source.index, out = [];
    const surfaces = source.userData.architectureSurfaceRanges ?? hit.object.userData.architectureSurfaces ?? [hit.surface];
    for (const range of surfaces) {
      if ((hit.form ? range.formId !== hit.form.id : range.pathId !== hit.surface.pathId) || range.kind !== hit.surface.kind) continue;
      if (range.normal && hit.surface.normal && new THREE.Vector3(...range.normal).dot(new THREE.Vector3(...hit.surface.normal)) < .995) continue;
      for (let offset = range.start; offset < range.start + range.count; offset++) { const vertex = index ? index.getX(offset) : offset; out.push(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)); }
    }
    if (!out.length) return;
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    highlight = editorObject(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: state.tool === "erase" ? 0xf18b7c : 0x93e6bc, transparent: true, opacity: .3, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })), "architectureSculptHighlight");
    highlight.matrixAutoUpdate = false; highlight.matrix.copy(hit.object.matrixWorld); highlight.raycast = () => {};
    highlight.userData.formId = hit.form?.id ?? null; highlight.userData.pathId = hit.surface.pathId ?? null; highlight.userData.surface = hit.surface.kind;
    engine.scene.add(highlight);
  };
  const pitchedHeight = (root, form) => { const resolved = resolveArchitectureForm(form, styleOf(root)); return ["hip", "gable", "shed", "dome"].includes(resolved.roof) ? resolved.roofHeight : 0; };
  const updateHandles = () => {
    const root = selectedRoot(), form = root && modelOf(root).forms.find(form => form.id === state.formId);
    const key = state.active && state.tool === "reshape" && form ? `${root.id}:${JSON.stringify(form)}:${viewport.camera.position.toArray()}` : "";
    if (key === handlesKey) return;
    handlesKey = key; dispose(handles); handles = null;
    if (!key) return;
    handles = editorObject(new THREE.Group(), "architectureSculptHandles");
    handles.matrixAutoUpdate = false; handles.matrix.copy(root.object3D.matrixWorld);
    const [w, h, d] = form.size;
    const center = worldPoint(root, new THREE.Vector3(...form.position));
    const radius = Math.max(.09, viewport.camera.isOrthographicCamera ? (viewport.camera.top - viewport.camera.bottom) / 85 : viewport.camera.position.distanceTo(center) / 95);
    const descriptors = [
      ["width+", [w / 2, h / 2, 0], 0x95c9eb], ["width-", [-w / 2, h / 2, 0], 0x95c9eb],
      ["depth+", [0, h / 2, d / 2], 0x95c9eb], ["depth-", [0, h / 2, -d / 2], 0x95c9eb],
      ["height", [0, h, 0], 0xa2e3b9], ["roofHeight", [0, h + Math.max(.45, pitchedHeight(root, form)), 0], 0xe9c68b],
      ["move", [0, .1, d / 2 + .8], 0xffffff], ["yaw", [w / 2 + .8, .15, -d / 2 - .8], 0xc5a1ee],
      ["elevation", [-w / 2 - .8, .15, d / 2 + .8], 0xeeb58d],
    ];
    for (const [name, position, color] of descriptors) {
      const handle = editorObject(new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false })), "architectureSculptHandle");
      handle.position.copy(fromForm(form, new THREE.Vector3(...position)));
      handle.userData.handle = name; handle.userData.formId = form.id; handle.userData.rootId = root.id;
      handle.userData.label = ({ elevation: "Lift base", height: "Building height", roofHeight: "Roof height", move: "Move footprint", yaw: "Rotate form" })[name] ?? "Resize footprint";
      handles.add(handle);
    }
    engine.scene.add(handles);
  };
  const growForm = (hit, event) => {
    const root = hit?.root ?? selectedRoot(), cell = state.cellSize;
    const point = hit?.point ?? planePoint(event, root, 0);
    if (!point) return null;
    const position = localPoint(root, point), form = makeForm(position.toArray(), [cell, state.height, cell]);
    if (hit?.form) {
      const parent = hit.form, p = formPoint(parent, position);
      const n = hit.normal.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -(parent.rotationY ?? 0));
      form.rotationY = parent.rotationY ?? 0;
      if (n.y > .35 || hit.surface?.kind === "roof") {
        p.x = Math.round(p.x / cell) * cell; p.z = Math.round(p.z / cell) * cell; p.y = parent.size[1];
      } else {
        const axis = Math.abs(n.x) > Math.abs(n.z) ? 0 : 2, sign = Math.sign(axis === 0 ? n.x : n.z) || 1;
        p.setComponent(axis, sign * (parent.size[axis] / 2 + cell / 2));
        const tangent = axis === 0 ? 2 : 0; p.setComponent(tangent, Math.round(p.getComponent(tangent) / cell) * cell); p.y = 0;
      }
      form.position = fromForm(parent, p).toArray();
    } else {
      position.x = Math.round(position.x / cell) * cell; position.z = Math.round(position.z / cell) * cell;
      form.position = position.toArray();
    }
    return { root, form, point };
  };
  const refresh = () => {
    if (updating) return;
    if (!state.active || engine.playing) {
      if (drag) finish(true);
      dispose(ghost); ghost = null; ghostKey = ""; dispose(highlight); highlight = null; highlightKey = "";
      dispose(handles); handles = null; handlesKey = ""; canvas.style.cursor = ""; canvas.title = originalTitle;
      if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = originalMiddle;
      return;
    }
    if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    canvas.style.cursor = alt ? "grab" : state.tool === "reshape" ? "pointer" : "crosshair";
    updateHandles();
    if (!pointer || alt || drag) { setGhost(null, null); if (!drag) canvas.title = originalTitle; if (alt) setHighlight(null); return; }
    hover = surfaceHit(pointer);
    const handleHover = state.tool === "reshape" && handles ? raycaster.intersectObject(handles, true)[0] : null;
    canvas.title = handleHover?.object.userData.label ?? originalTitle;
    state.hover = hover?.form || hover?.surface?.pathId ? { rootId: hover.root.id, formId: hover.form?.id ?? null, pathId: hover.surface?.pathId ?? null, surface: hover.surface?.kind, position: hover.point.toArray(), normal: hover.worldNormal.toArray() } : null;
    if (["grow", "build", "round"].includes(state.tool)) {
      if (state.tool === "grow") { const next = growForm(hover, pointer); setGhost(next?.root, next?.form); }
      else {
        const root = selectedRoot(), point = hover?.point ?? planePoint(pointer, root, 0);
        setGhost(root, point ? makeForm(snapped(localPoint(root, point), pointer).toArray(), [state.width, state.height, state.width], state.tool === "round" ? "round" : "box") : null);
      }
    } else setGhost(null, null);
    setHighlight(hover);
  };
  const axisDrag = (event, handle, root, form) => {
    const axisLocal = handle.startsWith("width") ? new THREE.Vector3(handle.endsWith("-") ? -1 : 1, 0, 0) : handle.startsWith("depth") ? new THREE.Vector3(0, 0, handle.endsWith("-") ? -1 : 1) : new THREE.Vector3(0, 1, 0);
    axisLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), form.rotationY ?? 0);
    const axisWorld = axisLocal.clone().transformDirection(root.object3D.matrixWorld);
    const view = viewport.camera.getWorldDirection(new THREE.Vector3());
    const normal = view.clone().addScaledVector(axisWorld, -view.dot(axisWorld));
    if (normal.lengthSq() < .0001) normal.copy(viewport.camera.up).addScaledVector(axisWorld, -viewport.camera.up.dot(axisWorld));
    normal.normalize();
    const startWorld = worldPoint(root, new THREE.Vector3(...form.position));
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, startWorld);
    ray(event); const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return { plane, axisLocal, startAxis: point ? localPoint(root, point).dot(axisLocal) : null };
  };
  const beginHandle = (event, hit) => {
    const root = resolveRoot(hit.object.userData.rootId), form = root && modelOf(root).forms.find(form => form.id === hit.object.userData.formId);
    if (!form) return;
    const handle = hit.object.userData.handle;
    canvas.title = hit.object.userData.label ?? originalTitle;
    begin(`Reshape ${handle}`); choose(root, form.id);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal(root, new THREE.Vector3(0, 1, 0)), worldPoint(root, new THREE.Vector3(...form.position)));
    ray(event); const startPoint = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    startPress(event, { type: "reshape", root, model: modelOf(root), form: clone(form), handle, ...axisDrag(event, handle, root, form), movePlane: plane, startPoint: startPoint && localPoint(root, startPoint) });
  };
  const applyClick = (event, hit, erase = false) => {
    const removing = erase || state.tool === "erase", pathId = removing ? hit?.surface?.pathId : null;
    if (!hit?.root || (!hit.form && !pathId)) return;
    begin(removing ? pathId ? "Remove architectural path" : "Remove building form" : state.tool === "paint" ? "Paint building" : `Add ${state.tool}`);
    startPress(event, { type: "click", root: hit.root }); choose(hit.root, hit.form?.id ?? null);
    const model = modelOf(hit.root);
    if (removing) {
      if (pathId) model.paths = model.paths.filter(path => path.id !== pathId);
      else { model.forms = model.forms.filter(form => form.id !== hit.form.id); model.openings = model.openings.filter(opening => opening.formId !== hit.form.id); }
      state.formId = null;
    } else if (state.tool === "paint") {
      // Paint what was clicked: a roof keeps its own colour, a wall its own.
      const target = model.forms.find(form => form.id === hit.form.id);
      if (String(hit.surface?.kind).startsWith("roof") && Math.abs(hit.normal.y) > .3) target.roofColor = state.color; else target.color = state.color;
    }
    else if (["window", "door"].includes(state.tool)) {
      if (Math.abs(hit.normal.y) > .5 || !String(hit.surface?.kind).startsWith("wall")) { finish(true); return; }
      const O = styleOf(hit.root)?.openings;
      const height = state.tool === "door" ? Math.min(O?.door.h ?? 2.5, hit.form.size[1] - .1) : Math.min(O?.window.h ?? 1.4, hit.form.size[1] - .2);
      const point = hit.local.clone();
      point.y = state.tool === "door" ? hit.form.position[1] + height / 2 : THREE.MathUtils.clamp(point.y, hit.form.position[1] + height / 2 + .05, hit.form.position[1] + hit.form.size[1] - height / 2 - .05);
      const normal = hit.normal.clone(); normal.y = 0; normal.normalize();
      model.openings.push({ id: uid(), formId: hit.form.id, position: point.toArray(), normal: normal.toArray(), width: state.tool === "door" ? O?.door.w ?? 1.2 : O?.window.w ?? 1.1, height, kind: state.tool });
    }
    write(hit.root, model);
  };
  const addCell = (event, hit) => {
    // A stroke that starts on a facade adds one attached cell. Re-raycasting
    // that freshly added roof on every move would accidentally grow a tower
    // under a stationary pointer. Ground painting stays on its original plane.
    if (drag?.surfaceAttached) return;
    const ground = drag ? planePoint(event, drag.root, drag.elevation) : null;
    const next = growForm(drag ? ground && { root: drag.root, point: ground } : hit, event); if (!next) return;
    let root = drag?.root ?? next.root;
    if (!drag) {
      begin("Grow building");
      if (!root) { root = createRoot(new THREE.Vector3()); next.form.position = localPoint(root, new THREE.Vector3(...next.form.position)).toArray(); }
      startPress(event, { type: "grow", root, cells: new Set(), surfaceAttached: !!hit?.form, elevation: next.form.position[1] });
    }
    if (next.root && next.root.id !== root.id) return;
    const key = formKey(next.form), model = modelOf(root);
    if (drag.cells.has(key) || model.forms.some(form => formKey(form) === key)) return;
    drag.cells.add(key); model.forms.push(next.form); write(root, model); choose(root, next.form.id);
  };
  const onDown = event => {
    if (!state.active || engine.playing || event.target !== canvas || event.altKey || ![0, 2].includes(event.button)) return;
    pointer = event; alt = false;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      const hit = surfaceHit(event);
      if (event.button === 2) { applyClick(event, hit, true); return; }
      if (state.tool === "reshape") {
        ray(event); const handle = handles && raycaster.intersectObject(handles, true)[0];
        if (handle) beginHandle(event, handle);
        else { choose(hit?.root, hit?.form?.id); notify(); refresh(); }
        return;
      }
      if (["erase", "paint", "window", "door"].includes(state.tool)) { applyClick(event, hit); return; }
      if (state.tool === "grow") { addCell(event, hit); notify(); refresh(); return; }
      let root = hit?.root ?? selectedRoot();
      const point = hit?.point ?? planePoint(event, root, 0); if (!point) return;
      begin(state.tool === "path" ? "Draw architectural path" : state.tool === "wall" ? "Draw freehand wall" : "Build architectural volume");
      if (!root) root = createRoot(point);
      const local = snapped(localPoint(root, point), event), model = modelOf(root);
      if (state.tool === "path" || state.tool === "wall") {
        const path = { id: uid(), points: [[local.x, local.z]], width: state.width, elevation: local.y };
        startPress(event, { type: state.tool, root, model, path, segmentIds: [] }); choose(root, null);
      } else {
        const form = makeForm(local.toArray(), [state.width, state.height, state.width], state.tool === "round" ? "round" : "box");
        model.forms.push(form); write(root, model);
        startPress(event, { type: "build", root, model, form, start: local, round: state.tool === "round" }); choose(root, form.id);
      }
      notify(); refresh();
    } catch (cause) { finish(true); error(cause); }
  };
  const updateDrag = event => {
    if (!drag) return;
    const root = drag.root;
    if (!engine.getEntity(root.id)) { finish(true); return; }
    if (drag.type === "grow") { addCell(event, surfaceHit(event)); return; }
    if (drag.type === "click") return;
    componentOf(root)?.setDraft?.(true);
    const model = clone(drag.model);
    if (drag.type === "build" || drag.type === "path" || drag.type === "wall") {
      const point = planePoint(event, root, drag.type === "build" ? drag.start.y : drag.path.elevation); if (!point) return;
      const local = snapped(localPoint(root, point), event);
      if (drag.type === "path" || drag.type === "wall") {
        const last = drag.path.points.at(-1);
        if (Math.hypot(local.x - last[0], local.z - last[1]) < Math.max(.1, drag.type === "wall" ? (state.thickness || .5) * 1.5 : state.width * .15)) return;
        if (drag.path.points.length >= 65) return;
        drag.path.points.push([local.x, local.z]);
        if (drag.type === "path") model.paths.push(clone(drag.path));
        else {
          const boundary = styleOf(root)?.boundary, T = state.thickness > 0 ? state.thickness : boundary?.thickness ?? .3, WH = boundary ? boundary.height : state.height;
          for (let index = 1; index < drag.path.points.length; index++) {
            const a = drag.path.points[index - 1], b = drag.path.points[index], dx = b[0] - a[0], dz = b[1] - a[1];
            // Segments overlap by a full thickness so bends close; the style caps and pillars them.
            const form = makeForm([(a[0] + b[0]) / 2, drag.path.elevation, (a[1] + b[1]) / 2], [Math.hypot(dx, dz) + T, WH, T]);
            form.id = drag.segmentIds[index - 1] ??= uid(); form.kind = "wall"; form.roof = "none"; form.roofHeight = 0; form.windows = false; form.rotationY = -Math.atan2(dz, dx);
            model.forms.push(form);
          }
        }
      } else {
        const form = model.forms.find(form => form.id === drag.form.id);
        // A press-release that never became a drag is a CLICK-PLACE: the ghost
        // the user saw under the pointer was state.width wide, and what lands
        // must be exactly that — not the degenerate max(.2, ~0) footprint the
        // zero-length drag rect computes (the "I placed a tower and got a thin
        // one" report). A real drag stays WYSIWYG: the model rebuilds live.
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) {
          form.size = [state.width, state.height, state.width];
          if (!drag.round) form.position = [drag.start.x, drag.start.y, drag.start.z];
        } else if (drag.round) { const diameter = Math.max(.2, 2 * Math.hypot(local.x - drag.start.x, local.z - drag.start.z)); form.size = [diameter, state.height, diameter]; }
        else { form.position = [(drag.start.x + local.x) / 2, drag.start.y, (drag.start.z + local.z) / 2]; form.size = [Math.max(.2, Math.abs(local.x - drag.start.x)), state.height, Math.max(.2, Math.abs(local.z - drag.start.z))]; }
      }
    } else if (drag.type === "reshape") {
      const form = model.forms.find(form => form.id === drag.form.id); ray(event);
      if (["move", "yaw"].includes(drag.handle)) {
        const point = raycaster.ray.intersectPlane(drag.movePlane, new THREE.Vector3()); if (!point || !drag.startPoint) return;
        const local = localPoint(root, point);
        if (drag.handle === "move") { const delta = local.sub(drag.startPoint); form.position = new THREE.Vector3(...drag.form.position).add(delta).toArray(); }
        else { const origin = new THREE.Vector3(...drag.form.position), start = drag.startPoint.clone().sub(origin), end = local.sub(origin); form.rotationY = (drag.form.rotationY ?? 0) + Math.atan2(end.x, end.z) - Math.atan2(start.x, start.z); }
      } else {
        const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3()); if (!point || drag.startAxis === null) return;
        let delta = localPoint(root, point).dot(drag.axisLocal) - drag.startAxis;
        if (!event.ctrlKey && state.snap) delta = Math.round(delta / state.snap) * state.snap;
        if (drag.handle === "height") form.size[1] = Math.max(.2, drag.form.size[1] + delta);
        else if (drag.handle === "roofHeight") form.roofHeight = Math.max(.1, pitchedHeight(root, drag.form) + delta);
        else if (drag.handle === "elevation") form.position[1] = drag.form.position[1] + delta;
        else {
          const axis = drag.handle.startsWith("width") ? 0 : 2;
          form.size[axis] = Math.max(.2, drag.form.size[axis] + delta);
          delta = form.size[axis] - drag.form.size[axis];
          form.position = new THREE.Vector3(...drag.form.position).addScaledVector(drag.axisLocal, delta / 2).toArray();
        }
      }
      followOpenings(model, drag.form, form);
    }
    write(root, model); handlesKey = ""; updateHandles();
  };
  const flushPendingMove = () => {
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    const event = pendingMove;
    pendingMove = null;
    if (!event) return;
    try { if (drag) updateDrag(event); else refresh(); }
    catch (cause) { finish(true); error(cause); }
  };
  const onMove = event => {
    if (!state.active || engine.playing || (event.target !== canvas && !drag)) return;
    pointer = event; alt = !!event.altKey;
    pendingMove = event;
    if (drag) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (!moveFrame) moveFrame = requestAnimationFrame(flushPendingMove);
  };
  const onUp = event => {
    if (!drag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // The last coalesced sample must land before the release finalizes, or the
    // committed form would trail the pointer by one frame of movement.
    flushPendingMove();
    try { if (drag.type !== "grow" && drag.type !== "click") updateDrag(event); finish(false); }
    catch (cause) { finish(true); error(cause); }
  };
  const onLeave = () => { if (drag) return; pointer = null; canvas.title = originalTitle; setGhost(null, null); setHighlight(null); };
  const onCancel = () => finish(true);
  const onModifier = event => { if (!state.active) return; alt = !!event.altKey; if (!drag) refresh(); };
  const onKey = event => {
    if (event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, .monaco-editor")) return;
    if (event.key?.toLowerCase() !== "escape" && !state.dragging && event.target?.closest?.(".hierarchy-panel, .inspector-panel")) return;
    if (dispatchArchitectureSculptKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const onContextMenu = event => { if (state.active && event.target === canvas) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const invalidate = () => {
    highlightKey = handlesKey = "";
    if (updating) return;
    const root = resolveRoot(state.rootId);
    if ((state.rootId && !root) || (state.formId && !modelOf(root).forms.some(form => form.id === state.formId))) {
      if (!root) state.rootId = null;
      state.formId = null; notify();
    }
    refresh();
  };
  canvas.addEventListener("pointerdown", onDown, true); canvas.addEventListener("pointermove", onMove, true);
  canvas.addEventListener("pointerup", onUp, true); canvas.addEventListener("pointercancel", onCancel); canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("contextmenu", onContextMenu, true); window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true); window.addEventListener("keydown", onModifier); window.addEventListener("keyup", onModifier);
  const unsub = subscribeArchitectureSculpt(refresh);
  const unsubscribers = [
    useHistoryStore.subscribe(invalidate),
    subscribeArchitectureTool(() => { if (state.active && getArchitectureToolState().active) disarmArchitectureSculpt(); }),
    subscribeArchitecturePlacement(() => { if (state.active && isArchitecturePlacementActive()) disarmArchitectureSculpt(); }),
    subscribeTerrainBrush(() => { if (state.active && getTerrainBrushMode()) disarmArchitectureSculpt(); }),
    engine.on?.("hierarchy-changed", invalidate), engine.on?.("component-changed", invalidate),
    engine.on?.("scene-load-start", disarmArchitectureSculpt), engine.on?.("play-changed", refresh),
  ];
  viewport.orbit?.addEventListener?.("change", invalidate);
  refresh();
  const teardown = () => {
    finish(true); dispose(ghost); dispose(highlight); dispose(handles);
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    pendingMove = null;
    canvas.removeEventListener("pointerdown", onDown, true); canvas.removeEventListener("pointermove", onMove, true);
    canvas.removeEventListener("pointerup", onUp, true); canvas.removeEventListener("pointercancel", onCancel); canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("contextmenu", onContextMenu, true); window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey, true); window.removeEventListener("keydown", onModifier); window.removeEventListener("keyup", onModifier); viewport.orbit?.removeEventListener?.("change", invalidate);
    unsub(); for (const unsubscribe of unsubscribers) unsubscribe?.();
    if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = originalMiddle;
    canvas.style.cursor = ""; canvas.title = originalTitle;
    if (teardownPrevious === teardown) { teardownPrevious = null; cancelGesture = null; }
  };
  teardownPrevious = teardown; return teardown;
}
