import * as THREE from "three/webgpu";

/**
 * Pure math behind the viewport's Blender-style G/R/S transform macros.
 *
 * Everything here turns "what the user did" (a cursor gesture, or a typed
 * value plus a set of locked axes) into a world-space delta:
 *
 *   { pos, quat, scale }   — any field null meaning "no change on that channel"
 *
 * where `quat` and `scale` are understood to act about a pivot. The caller
 * owns the pivot and the entities; this module never touches the scene, which
 * is what lets it be unit-tested against a bare camera.
 *
 * Returned vectors/quaternions are module-scoped scratch — read them (or copy
 * them) before calling back in.
 */

export const AXIS_UNIT = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Radial scale and angular rotate both divide by the cursor's starting
// distance from the on-screen pivot. Starting the macro with the cursor right
// on top of the pivot would make that divisor ~0 and send the factor to
// infinity on the first pixel of motion, so clamp it to a few pixels of slack.
export const MIN_PIVOT_RADIUS_PX = 6;

const _outPos = new THREE.Vector3();
const _outQuat = new THREE.Quaternion();
const _outScale = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _pivotPx = { x: 0, y: 0 };
const _tipPx = { x: 0, y: 0 };

/** Median of the selection's world origins — Blender's default rotate/scale
 *  pivot. For a single entity this is its own origin, so rotate and scale
 *  leave its position untouched. */
export function macroPivot(worldPositions, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  if (!worldPositions.length) return out;
  for (const p of worldPositions) out.add(p);
  return out.divideScalar(worldPositions.length);
}

/** Parse the numeric buffer. Returns null for partial tokens so the caller
 *  can hold the entity on its baseline instead of previewing a half-typed
 *  number as some placeholder value. */
export function parseMacroNumber(buf) {
  if (buf === "" || buf === "-" || buf === "." || buf === "-.") return null;
  const n = Number(buf);
  return Number.isFinite(n) ? n : null;
}

/** Flip the sign of a numeric buffer in place, Blender-style: pressing "-"
 *  at any point in the gesture negates what you already typed, so "90" then
 *  "-" reads as -90 without having to backspace and retype. */
export function toggleBufferSign(buffer) {
  return buffer.startsWith("-") ? buffer.slice(1) : `-${buffer}`;
}

/** Axis a rotate macro spins around: the locked world axis (or the diagonal
 *  of several), else the view axis pointing from the pivot back at the
 *  camera — so a positive right-hand-rule angle reads counter-clockwise on
 *  screen, which is what Blender's free rotate does. */
export function macroRotationAxis(axes, pivot, camera, out = _axis) {
  if (axes.size === 0) {
    out.copy(camera.position).sub(pivot);
    if (out.lengthSq() < 1e-12) camera.getWorldDirection(out).negate();
    return out.normalize();
  }
  out.set(axes.has("x") ? 1 : 0, axes.has("y") ? 1 : 0, axes.has("z") ? 1 : 0);
  return out.normalize();
}

/** World point → canvas-relative pixel coordinates (y down, matching
 *  clientY). Only differences are ever used, so any constant offset between
 *  this and client space cancels out — but the caller still has to subtract
 *  rect.left/top from client coords before comparing. */
export function projectToPixels(world, rect, camera, out = { x: 0, y: 0 }) {
  _proj.copy(world).project(camera);
  out.x = (_proj.x * 0.5 + 0.5) * rect.width;
  out.y = (-_proj.y * 0.5 + 0.5) * rect.height;
  return out;
}

/** World units spanned by one pixel at `point`'s depth, so a free move keeps
 *  the object under the cursor no matter the zoom. */
export function worldPerPixelAt(point, rect, camera) {
  if (rect.height < 1) return 0.01;
  if (camera.isOrthographicCamera) {
    return (camera.top - camera.bottom) / (camera.zoom || 1) / rect.height;
  }
  camera.getWorldDirection(_tmp);
  const depth = Math.max(_tmp2.copy(point).sub(camera.position).dot(_tmp), 1e-4);
  return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * depth) / rect.height;
}

/**
 * World units to move along `axis` so the pivot tracks a (dx, dy) pixel drag
 * as closely as a single-axis constraint allows: project the drag onto the
 * axis' screen-space direction, then divide by how many pixels one world unit
 * of that axis spans on screen.
 *
 * `dot(d, s) / |s|²` is exactly that — `dot(d, ŝ)` pixels of useful motion
 * divided by `|s|` pixels-per-world-unit. It falls out with the right sign
 * automatically because both vectors live in the same y-down pixel space, and
 * it naturally slows down as the axis turns to face the camera.
 */
export function axisDragAmount(axis, dx, dy, pivot, rect, camera) {
  projectToPixels(pivot, rect, camera, _pivotPx);
  _tmp.copy(pivot).add(AXIS_UNIT[axis]);
  projectToPixels(_tmp, rect, camera, _tipPx);
  const sx = _tipPx.x - _pivotPx.x;
  const sy = _tipPx.y - _pivotPx.y;
  const lenSq = sx * sx + sy * sy;
  // Axis points (nearly) straight at the camera: it has no screen direction
  // to drag along, and dividing by ~0 would fling the object to infinity.
  if (lenSq < 1e-9) return 0;
  return (dx * sx + dy * sy) / lenSq;
}

/**
 * Numeric mode. Blender's grammar:
 *   G 2 → +2 along world X (Blender fills the first of the x/y/z fields);
 *   G Z 2 → +2 along world Z; R 90 → 90° about the view axis;
 *   R X 90 → 90° about world X; S 0.5 → uniform 0.5×; S X 0.5 → 0.5× on X.
 */
export function numericDelta(kind, axes, value, pivot, camera) {
  if (kind === "translate") {
    _outPos.set(0, 0, 0);
    if (axes.size === 0) _outPos.x = value;
    else {
      if (axes.has("x")) _outPos.x = value;
      if (axes.has("y")) _outPos.y = value;
      if (axes.has("z")) _outPos.z = value;
    }
    return { pos: _outPos, quat: null, scale: null };
  }
  if (kind === "rotate") {
    macroRotationAxis(axes, pivot, camera, _axis);
    _outQuat.setFromAxisAngle(_axis, THREE.MathUtils.degToRad(value));
    return { pos: null, quat: _outQuat, scale: null };
  }
  const all = axes.size === 0;
  _outScale.set(
    all || axes.has("x") ? value : 1,
    all || axes.has("y") ? value : 1,
    all || axes.has("z") ? value : 1,
  );
  return { pos: null, quat: null, scale: _outScale };
}

/**
 * Turn the cursor gesture into a world-space delta, Blender-style.
 *
 *  - translate, unlocked: the object follows the cursor 1:1 in the view plane
 *    at the pivot's depth.
 *  - translate, locked:   the cursor's projection onto each locked axis'
 *    screen direction (see `axisDragAmount`).
 *  - rotate: the angle the cursor has swept around the on-screen pivot,
 *    accumulated across calls so you can wind past 180° in one gesture.
 *  - scale:  the ratio of the cursor's distance from the on-screen pivot to
 *    its distance when the macro started. Drag toward the pivot to shrink
 *    (factor < 1), away to grow.
 *
 * `pointer` is `{ startX, startY, x, y, dx, dy, angle, lastAngle }` in client
 * coordinates; rotate mutates `angle`/`lastAngle` to accumulate the sweep.
 * `rect` is the canvas' bounding rect.
 */
export function pointerDelta(kind, axes, pointer, pivot, rect, camera) {
  const { dx, dy } = pointer;

  if (kind === "translate") {
    if (axes.size === 0) {
      const wpp = worldPerPixelAt(pivot, rect, camera);
      // Camera right/up in world space. Screen y grows downward, so up gets
      // the negated delta.
      _tmp.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(dx * wpp);
      _outPos.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(-dy * wpp);
      _outPos.add(_tmp);
    } else {
      _outPos.set(
        axes.has("x") ? axisDragAmount("x", dx, dy, pivot, rect, camera) : 0,
        axes.has("y") ? axisDragAmount("y", dx, dy, pivot, rect, camera) : 0,
        axes.has("z") ? axisDragAmount("z", dx, dy, pivot, rect, camera) : 0,
      );
    }
    return { pos: _outPos, quat: null, scale: null };
  }

  projectToPixels(pivot, rect, camera, _pivotPx);
  const cx = _pivotPx.x + rect.left;
  const cy = _pivotPx.y + rect.top;

  if (kind === "rotate") {
    const current = Math.atan2(pointer.y - cy, pointer.x - cx);
    if (pointer.lastAngle === null || pointer.lastAngle === undefined) {
      pointer.lastAngle = Math.atan2(pointer.startY - cy, pointer.startX - cx);
    }
    // Unwrap into (-π, π] before accumulating so crossing the ±π seam reads
    // as a small step rather than a full turn in the wrong direction.
    let step = current - pointer.lastAngle;
    while (step > Math.PI) step -= Math.PI * 2;
    while (step < -Math.PI) step += Math.PI * 2;
    pointer.angle += step;
    pointer.lastAngle = current;

    macroRotationAxis(axes, pivot, camera, _axis);
    // Screen angles grow clockwise (y down) while a right-hand-rule rotation
    // about a viewer-facing axis reads counter-clockwise, hence the negation.
    // A locked axis pointing away from the camera flips the apparent
    // direction again, so fold in the sign of its dot with the view offset.
    _tmp.copy(camera.position).sub(pivot);
    const facing = _axis.dot(_tmp) >= 0 ? 1 : -1;
    _outQuat.setFromAxisAngle(_axis, -pointer.angle * facing);
    return { pos: null, quat: _outQuat, scale: null };
  }

  // Scale: ratio of current cursor radius to the radius at macro start. The
  // old code took the magnitude of a screen-projected delta, which is never
  // negative — so scale could only ever grow, never shrink.
  const r0 = Math.max(Math.hypot(pointer.startX - cx, pointer.startY - cy), MIN_PIVOT_RADIUS_PX);
  const f = Math.hypot(pointer.x - cx, pointer.y - cy) / r0;
  const all = axes.size === 0;
  _outScale.set(
    all || axes.has("x") ? f : 1,
    all || axes.has("y") ? f : 1,
    all || axes.has("z") ? f : 1,
  );
  return { pos: null, quat: null, scale: _outScale };
}
