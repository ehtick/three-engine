import * as THREE from "three/webgpu";
import { isPickVisible } from "./pickVisibility.js";

/**
 * Distance-aware wheel dolly, shared by the scene viewport and the geometry
 * editor.
 *
 * OrbitControls zooms by scaling the camera's distance to `controls.target`,
 * so one notch always moves the same FRACTION of *that* distance — and the
 * pivot is wherever you last framed something. Press F on a doorknob and the
 * pivot sits 30cm away; every notch after that moves 1.5cm, no matter that
 * the wall you are flying at is forty metres off. The steps shrink
 * geometrically as you approach the pivot, so the view crawls to a halt and
 * never gets past it. Blender has exactly this failure, which is why it ships
 * "Zoom to Mouse Position" and "Auto Depth" as the cure.
 *
 * The cure, implemented here:
 *   - the step is a fraction of the distance to whatever is actually UNDER
 *     THE CURSOR, so it is always scaled to the thing you are flying at;
 *   - the camera travels along the cursor ray, so that thing stays put on
 *     screen instead of sliding out of frame;
 *   - the orbit pivot is re-anchored onto the same surface, so the next orbit
 *     turns around what you just zoomed to rather than around the doorknob;
 *   - the step has a floor tied to the near plane, so you can always push
 *     through a surface you are pressed against and always pull back out.
 *
 * The pivot is always placed straight ahead of the camera, so `update()`'s
 * `lookAt(target)` is a no-op and a zoom never rotates the view.
 *
 * Orthographic views are left to OrbitControls: they zoom by scaling the
 * projection, which has no pivot and therefore none of this problem.
 */

/** One detent of a standard mouse wheel, in `deltaY` units. */
const NOTCH = 100;
/** Fraction of the distance to the surface under the cursor travelled per notch. */
const STEP = 0.15;
/** Ceiling per event, so an inertial fling or a coarse driver can't teleport. */
const MAX_NOTCHES = 4;
/** Shift = precision zoom. */
const PRECISE = 0.25;
/** A depth probe is reused for the rest of the gesture: how long, and how far
 *  the pointer may drift before it is re-cast. */
const PROBE_MS = 400;
const PROBE_PX = 12;
/**
 * Floors on the distance the step is derived from, in near-plane units. The
 * near plane is the one length already scaled to the scene's content, so this
 * works for a metre-scale level and for the geometry editor's millimetre-scale
 * near plane alike.
 *
 * Pulling back out is floored harder than pushing in: approaching wants fine
 * control, but once you have flown *inside* a wall the surface under the
 * cursor is millimetres away and a purely proportional step would strand you
 * there — the same dead end from the other side.
 */
const FLOOR_IN = 2;
const FLOOR_OUT = 10;
/** Keep the pivot off the camera: a near-zero orbit radius has no direction. */
const FLOOR_PIVOT = 4;

/** True when nothing in `object`'s ancestry is an editor helper — those are
 *  drawn over the scene, not part of it, so they must not set the zoom depth. */
function isSceneObject(object) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.editorOnly) return false;
  }
  return true;
}

/** Nearest real surface along the ray. Helpers are lines, points and sprites,
 *  none of which are things you fly at, so only meshes count — and a batched or
 *  merged member is on screen even though `visible` is false, which is what
 *  isPickVisible is for (most of an imported scene is drawn that way). */
function firstSurface(raycaster, root) {
  if (!root) return null;
  for (const hit of raycaster.intersectObjects(root.children ?? [root], true)) {
    if (!hit.object.isMesh) continue;
    if (!isPickVisible(hit.object) || !isSceneObject(hit.object)) continue;
    return hit;
  }
  return null;
}

/**
 * Replaces OrbitControls' wheel zoom on `canvas`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {() => THREE.Camera} options.getCamera       currently rendered camera
 * @param {() => object} options.getControls           the OrbitControls instance
 * @param {() => THREE.Object3D} [options.getRoot]     scene root to probe for depth
 * @param {() => boolean} [options.isEnabled]          extra gate (e.g. not while playing)
 * @returns {() => void} removes the handler
 */
export function installWheelZoom(canvas, { getCamera, getControls, getRoot, isEnabled }) {
  const raycaster = new THREE.Raycaster();
  // Probe every layer, like the picker does: editor-layer meshes are still
  // surfaces you can fly at, they just render under a different camera.
  raycaster.layers.enableAll();
  const ndc = new THREE.Vector2();
  const forward = new THREE.Vector3();
  const toPoint = new THREE.Vector3();
  /** @type {{x: number, y: number, time: number, point: THREE.Vector3 | null} | null} */
  let probe = null;

  /** Depth of the surface under the cursor, along the cursor ray.
   *  Cast once per gesture and then remembered in WORLD space — the remaining
   *  notches re-derive the distance from the moved camera, so flying across a
   *  600-mesh scene costs one raycast, not one per notch. */
  function probeDepth(camera, event, rect) {
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);

    const now = performance.now();
    const fresh =
      probe &&
      now - probe.time <= PROBE_MS &&
      Math.hypot(event.clientX - probe.x, event.clientY - probe.y) <= PROBE_PX;
    if (fresh) {
      probe.time = now;
      if (!probe.point) return 0; // known-empty: nothing under the cursor
      const depth = toPoint.copy(probe.point).sub(camera.position).dot(raycaster.ray.direction);
      // Still ahead of us — reuse it. Negative means we flew past the surface
      // mid-gesture, so it is no longer what the step should be measured
      // against and the probe has to be re-cast.
      if (depth > 0) return depth;
    }

    const hit = firstSurface(raycaster, getRoot?.());
    probe = { x: event.clientX, y: event.clientY, time: now, point: hit ? hit.point.clone() : null };
    if (!probe.point) return 0;
    return Math.max(toPoint.copy(probe.point).sub(camera.position).dot(raycaster.ray.direction), 0);
  }

  function onWheel(event) {
    // Installed on `window` in the capture phase: OrbitControls registers its
    // own wheel listener on the canvas from its constructor, so a listener
    // added on the canvas afterwards would run second and both would dolly.
    // Capturing above the canvas lets us stop the event before it gets there.
    if (event.target !== canvas) return;
    const controls = getControls?.();
    const camera = getCamera?.();
    if (!controls || !camera || controls.enabled === false || controls.enableZoom === false) return;
    if (isEnabled && isEnabled() === false) return;
    if (!camera.isPerspectiveCamera) return; // ortho: OrbitControls' zoom is fine

    event.preventDefault();
    event.stopPropagation();

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16; // lines
    else if (event.deltaMode === 2) delta *= 100; // pages
    // A trackpad pinch arrives as ctrl+wheel with much smaller deltas.
    if (event.ctrlKey) delta *= 10;

    // Positive = zoom in, matching the wheel's "away from you" direction.
    let notches = THREE.MathUtils.clamp(-delta / NOTCH, -MAX_NOTCHES, MAX_NOTCHES);
    notches *= controls.zoomSpeed ?? 1;
    if (event.shiftKey) notches *= PRECISE;
    if (!notches) return;

    // The cursor ray and the forward axis both come off `matrixWorld`, while
    // the travel is applied to `position` — read them a frame apart during a
    // damped orbit and the pivot lands off-axis, which shows up as the view
    // rotating slightly every time you scroll.
    camera.updateMatrixWorld();

    const rect = canvas.getBoundingClientRect();
    const surfaceDepth = probeDepth(camera, event, rect);
    camera.getWorldDirection(forward);

    // No surface under the cursor (empty sky): fall back to the current pivot
    // distance, which is what OrbitControls used all along.
    const pivotDepth = toPoint.copy(controls.target).sub(camera.position).dot(forward);
    let depth = surfaceDepth || Math.max(pivotDepth, 0);
    depth = Math.max(depth, camera.near * (notches > 0 ? FLOOR_IN : FLOOR_OUT));

    const travel = depth * (1 - Math.pow(1 - STEP, notches));
    camera.position.addScaledVector(raycaster.ray.direction, travel);
    camera.updateMatrixWorld();

    // Re-anchor the pivot: onto the probed surface when there was one, else
    // carry the old pivot along with the camera. Either way it goes straight
    // ahead, so the camera keeps its orientation exactly.
    const moved = probe?.point
      ? toPoint.copy(probe.point).sub(camera.position).dot(forward)
      : pivotDepth - travel * raycaster.ray.direction.dot(forward);
    controls.target
      .copy(camera.position)
      .addScaledVector(forward, Math.max(moved, camera.near * FLOOR_PIVOT));

    // OrbitControls' own wheel path brackets the move in start/end and lets
    // update() publish the change; listeners (camera-prefs save, the axis
    // gizmo, the geometry editor's marker rescale) expect the same shape.
    controls.dispatchEvent({ type: "start" });
    controls.dispatchEvent({ type: "change" });
    controls.dispatchEvent({ type: "end" });
  }

  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => window.removeEventListener("wheel", onWheel, { capture: true });
}
