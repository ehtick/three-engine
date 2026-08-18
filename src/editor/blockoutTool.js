import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { useHistoryStore } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { buildBlockoutGeometry } from "../modules/level-design/blockoutGeometry.js";
import { pieceFromDrag, snapPoint, offsetAlongWall } from "./blockoutDraw.js";
import {
  DRAW_TOOLS,
  activeAngleSnap,
  activeGrid,
  getDrawElevation,
  getLevelTool,
  getLevelToolSettings,
  isSnapSuspended,
  setSnapSuspended,
  subscribeLevelTool,
  syncActiveFromEntity,
  validateActiveLevel,
} from "./levelTool.js";
import { addOpening, createPiece, erasePiece, shapeColor } from "./levelBuild.js";

/**
 * The blockout tools inside the viewport: the grid you draw on, the ghost of
 * the piece you are about to place, and the drag that places it.
 *
 * Structured like `setupTerrainBrush` — pointer handlers installed once on the
 * canvas, gated on an armed tool so an unarmed editor pays one boolean per
 * event — and given the viewport handle rather than importing it, because the
 * camera and orbit controls live in ViewportPanel's module scope.
 *
 * The one interaction rule worth stating: a drag draws, a click places. Both
 * end in the same `pieceFromDrag`, so a click is simply a drag whose two
 * points are equal, and the shapes that need a direction (wall, stair, ramp)
 * are the ones that decline to produce anything from a click.
 *
 * ## Giving the camera back
 *
 * The left button is OrbitControls' ROTATE. A tool that simply takes it leaves
 * no way to turn the view at all — you can pan (right) and zoom (wheel) and
 * that is it, which makes the tool unusable the moment you need to see the
 * other side of what you are building. So two escapes, both the ones muscle
 * memory already reaches for:
 *
 *   - **Alt + drag** — the tool steps out of the way and OrbitControls gets the
 *     press, exactly as in Unreal/Unity/Maya.
 *   - **Middle-drag** — remapped from dolly to rotate WHILE a tool is armed
 *     (the wheel already dollies, so nothing is lost) and restored on disarm.
 *
 * The cursor says which mode you are in — a crosshair while the tool owns the
 * button, a grab hand while Alt hands it over.
 */

const GRID_EXTENT = 24; // cells drawn either side of the cursor
const GHOST_OPACITY = 0.55;

let overlay = null;

/** Lazily builds the ghost + grid, parented to the scene on the editor layer
 *  so no game camera ever renders them. */
function ensureOverlay() {
  if (overlay) return overlay;
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 998;
  group.userData.editorOnly = true;

  const gridGeometry = new THREE.BufferGeometry();
  const grid = new THREE.LineSegments(
    gridGeometry,
    new THREE.LineBasicMaterial({ color: 0x8ea0b5, transparent: true, opacity: 0.28, depthWrite: false }),
  );

  const ghost = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  // A wireframe over the ghost is what makes a translucent box read as a solid
  // volume rather than as a coloured smear over the geometry behind it.
  const ghostEdges = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
  );
  ghostEdges.renderOrder = 999;

  // The snapped cursor: a small cross on the draw plane, so you can see where
  // a click will land before you commit to a drag.
  const cursorGeometry = new THREE.BufferGeometry();
  cursorGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
  const cursor = new THREE.LineSegments(
    cursorGeometry,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
  );
  cursor.renderOrder = 999;

  group.add(grid, ghost, ghostEdges, cursor);
  for (const object of [group, grid, ghost, ghostEdges, cursor]) {
    object.layers.set(EDITOR_LAYER);
    object.raycast = () => {};
    object.userData.editorOnly = true;
  }
  engine.scene.add(group);
  overlay = { group, grid, gridGeometry, ghost, ghostEdges, cursor, cursorGeometry, gridKey: "" };
  return overlay;
}

/** Rebuilds the grid lines when the cell size changes; otherwise just moves
 *  them, which is the common case (every pointermove). */
function updateGrid(centre, cell) {
  const view = ensureOverlay();
  const key = `${cell}`;
  if (view.gridKey !== key) {
    const positions = [];
    const span = GRID_EXTENT * cell;
    for (let i = -GRID_EXTENT; i <= GRID_EXTENT; i++) {
      const offset = i * cell;
      positions.push(-span, 0, offset, span, 0, offset);
      positions.push(offset, 0, -span, offset, 0, span);
    }
    view.gridGeometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    view.grid.geometry = geometry;
    view.gridGeometry = geometry;
    view.gridKey = key;
  }
  // Snapped to whole cells so the lines never shimmer as the pointer moves.
  view.grid.position.set(Math.round(centre.x / cell) * cell, centre.y, Math.round(centre.z / cell) * cell);
}

function updateCursor(point, size) {
  const view = ensureOverlay();
  const attribute = view.cursorGeometry.getAttribute("position");
  attribute.setXYZ(0, point.x - size, point.y, point.z);
  attribute.setXYZ(1, point.x + size, point.y, point.z);
  attribute.setXYZ(2, point.x, point.y, point.z - size);
  attribute.setXYZ(3, point.x, point.y, point.z + size);
  attribute.needsUpdate = true;
}

function showGhost(spec) {
  const view = ensureOverlay();
  if (!spec) {
    view.ghost.visible = false;
    view.ghostEdges.visible = false;
    return;
  }
  const { geometry } = buildBlockoutGeometry(spec.shape, { size: spec.size, ...(spec.props ?? {}) });
  view.ghost.geometry.dispose();
  view.ghost.geometry = geometry;
  const edges = new THREE.EdgesGeometry(geometry, 30);
  view.ghostEdges.geometry.dispose();
  view.ghostEdges.geometry = edges;
  const color = new THREE.Color(shapeColor(spec.shape));
  view.ghost.material.color.copy(color);
  view.ghostEdges.material.color.copy(color).offsetHSL(0, 0, 0.25);
  for (const object of [view.ghost, view.ghostEdges]) {
    object.position.set(spec.position[0], spec.position[1], spec.position[2]);
    object.rotation.set(0, spec.rotationY, 0);
    object.visible = true;
  }
}

function hideOverlay() {
  if (overlay) overlay.group.visible = false;
}

/** Editor-only cleanup, for the panel teardown. */
export function disposeBlockoutOverlay() {
  if (!overlay) return;
  engine.scene?.remove(overlay.group);
  overlay.ghost.geometry.dispose();
  overlay.ghostEdges.geometry.dispose();
  overlay.gridGeometry.dispose();
  overlay.cursorGeometry.dispose();
  overlay = null;
}

/**
 * Installs the tool's pointer/keyboard handling on the viewport canvas.
 * `viewport` is ViewportPanel's module-scope handle (camera, orbit).
 */
export function setupBlockoutTool(canvas, viewport) {
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const hitPoint = new THREE.Vector3();
  let drag = null; // { start, current } while the button is down
  let hoverPoint = null;
  let navigating = false; // Alt held: the camera owns the pointer, not the tool
  // Captured once so disarming restores whatever the viewport had, rather than
  // hardcoding the OrbitControls default here.
  const originalMiddleButton = viewport.orbit?.mouseButtons?.MIDDLE;

  const setNdc = (e) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  };

  /** The snapped point on the current draw plane under the pointer. */
  const planePoint = () => {
    const elevation = getDrawElevation();
    plane.set(new THREE.Vector3(0, 1, 0), -elevation);
    raycaster.setFromCamera(ndc, viewport.camera);
    if (!raycaster.ray.intersectPlane(plane, hitPoint)) return null;
    return snapPoint({ x: hitPoint.x, y: elevation, z: hitPoint.z }, activeGrid());
  };

  /** The blockout piece under the pointer, for the Opening and Erase tools. */
  const pickPiece = () => {
    raycaster.setFromCamera(ndc, viewport.camera);
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node) {
        if (node.userData.editorOnly) break;
        const id = node.userData.entityId;
        const piece = id ? engine.getEntity(id)?.getComponent?.("blockout") : null;
        if (piece) return { entityId: id, piece, point: hit.point };
        node = node.parent;
      }
    }
    return null;
  };

  /** Live settings the draw math wants, with the held-Ctrl overrides applied. */
  const drawSettings = () => ({ ...getLevelToolSettings(), grid: activeGrid(), angleSnap: activeAngleSnap() });

  const refresh = () => {
    const tool = getLevelTool();
    const view = ensureOverlay();
    // Middle-drag rotates while any tool is armed. The wheel already dollies
    // (installWheelZoom), so the button's default job is the redundant one.
    if (viewport.orbit?.mouseButtons) {
      viewport.orbit.mouseButtons.MIDDLE = tool ? THREE.MOUSE.ROTATE : originalMiddleButton;
    }
    canvas.style.cursor = !tool || tool === "select" || engine.playing
      ? ""
      : navigating ? "grab" : "crosshair";
    if (!tool || tool === "select" || engine.playing || navigating) {
      hideOverlay();
      return;
    }
    validateActiveLevel();
    view.group.visible = true;
    const drawing = DRAW_TOOLS.has(tool);
    const point = drag?.current ?? hoverPoint;
    const cell = activeGrid() || 1;
    if (point) {
      updateGrid(point, cell);
      updateCursor(point, cell * 0.35);
    }
    view.grid.visible = drawing && !!point;
    view.cursor.visible = drawing && !!point;
    if (!drawing || !point) {
      showGhost(null);
      return;
    }
    showGhost(pieceFromDrag(tool, drag?.start ?? point, point, drawSettings()));
  };

  const onPointerDown = (e) => {
    const tool = getLevelTool();
    if (!tool || tool === "select" || engine.playing || e.button !== 0) return;
    // Alt hands the left button to the camera. Not intercepting IS the fix —
    // OrbitControls is listening on the same canvas and rotates on its own.
    if (e.altKey) return;
    setSnapSuspended(e.ctrlKey);
    setNdc(e);

    if (tool === "opening" || tool === "erase") {
      const hit = pickPiece();
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (tool === "erase") {
        erasePiece(hit.entityId);
      } else if (hit.piece.props.shape === "wall") {
        const object3D = engine.getEntity(hit.entityId).object3D;
        const world = object3D.getWorldPosition(new THREE.Vector3());
        const yaw = new THREE.Euler().setFromQuaternion(
          object3D.getWorldQuaternion(new THREE.Quaternion()), "YXZ",
        ).y;
        addOpening(hit.entityId, {
          offset: offsetAlongWall(hit.point, world.toArray(), yaw),
          kind: getLevelToolSettings().opening,
        });
      }
      return;
    }

    const point = planePoint();
    if (!point) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = { start: point, current: point };
    viewport.orbit.enabled = false;
    refresh();
  };

  const onPointerMove = (e) => {
    const tool = getLevelTool();
    if (!tool || tool === "select" || engine.playing) return;
    if (e.altKey !== navigating) {
      navigating = e.altKey;
      refresh();
    }
    if (navigating) return;
    setSnapSuspended(e.ctrlKey);
    setNdc(e);
    const point = planePoint();
    if (!point) return;
    hoverPoint = point;
    if (drag) drag.current = point;
    refresh();
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { start, current } = drag;
    drag = null;
    viewport.orbit.enabled = true;
    const tool = getLevelTool();
    const spec = tool ? pieceFromDrag(tool, start, current, drawSettings()) : null;
    if (spec) {
      createPiece({
        shape: spec.shape,
        position: spec.position,
        rotationY: spec.rotationY,
        size: spec.size,
        props: spec.props ?? {},
      });
    }
    refresh();
  };

  const onPointerLeave = () => {
    hoverPoint = null;
    if (!drag) hideOverlay();
  };

  // Ctrl is "suspend snapping" and it must take effect while the pointer is
  // still — otherwise you have to jiggle the mouse to see the effect of the
  // key you are holding, which reads as the modifier not working.
  const onModifier = (e) => {
    if (!getLevelTool()) return;
    // Both modifiers must take effect while the pointer is STILL — otherwise
    // you have to jiggle the mouse to see the effect of the key you are
    // holding, which reads as the modifier not working.
    let changed = false;
    if (isSnapSuspended() !== e.ctrlKey) {
      setSnapSuspended(e.ctrlKey);
      changed = true;
    }
    if (navigating !== e.altKey) {
      navigating = e.altKey;
      changed = true;
    }
    if (changed) refresh();
  };

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onModifier);
  window.addEventListener("keyup", onModifier);
  const unsubscribe = subscribeLevelTool(refresh);
  // Undo/redo can delete the level under the ghost, and can land mid-drag: a
  // gesture that survived an undo would place a piece into a storey that no
  // longer exists the moment the button came up. Cancelling is the honest
  // answer — the user pressed undo, not "finish this wall".
  const unsubscribeHistory = useHistoryStore.subscribe(() => {
    if (drag) {
      drag = null;
      viewport.orbit.enabled = true;
    }
    refresh();
  });
  // Selecting any piece of a level re-targets the tool at that level and
  // storey. Without it, clicking into a second building and drawing puts the
  // wall in the first one — with nothing on screen to say why.
  let lastSelection = null;
  const unsubscribeSelection = useSelectionStore.subscribe((state) => {
    const id = state.ids[0] ?? null;
    if (id === lastSelection) return;
    lastSelection = id;
    if (id) syncActiveFromEntity(id);
  });

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onModifier);
    window.removeEventListener("keyup", onModifier);
    unsubscribe();
    unsubscribeHistory();
    unsubscribeSelection();
    if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = originalMiddleButton;
    canvas.style.cursor = "";
    disposeBlockoutOverlay();
  };
}
