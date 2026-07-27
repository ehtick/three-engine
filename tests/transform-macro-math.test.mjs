import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import {
  axisDragAmount,
  macroPivot,
  macroRotationAxis,
  numericDelta,
  parseMacroNumber,
  pointerDelta,
  toggleBufferSign,
  worldPerPixelAt,
} from "../src/editor/transformMacroMath.js";

const RECT = { left: 0, top: 0, width: 800, height: 600 };

/** Camera looking down -Z at the origin from 10 units back, matching the
 *  editor's default framing closely enough for the screen-space math. */
function makeCamera(position = [0, 0, 10], target = [0, 0, 0]) {
  const cam = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 1000);
  cam.position.set(...position);
  cam.lookAt(new THREE.Vector3(...target));
  cam.updateMatrixWorld(true);
  return cam;
}

function makePointer(startX, startY) {
  return { startX, startY, x: startX, y: startY, dx: 0, dy: 0, angle: 0, lastAngle: null };
}

function movePointer(pointer, x, y) {
  pointer.x = x;
  pointer.y = y;
  pointer.dx = x - pointer.startX;
  pointer.dy = y - pointer.startY;
  return pointer;
}

// --- Numeric buffer ---------------------------------------------------------

test("partial numeric tokens parse to null instead of a stray value", () => {
  for (const partial of ["", "-", ".", "-."]) {
    assert.equal(parseMacroNumber(partial), null, `"${partial}" should be incomplete`);
  }
});

test("a fractional buffer keeps its digits after the leading zero", () => {
  // The old code re-baselined on every keystroke, so the 0x preview from the
  // first "0" became the baseline and "0.5" could never climb back off zero.
  assert.equal(parseMacroNumber("0"), 0);
  assert.equal(parseMacroNumber("0."), 0);
  assert.equal(parseMacroNumber("0.5"), 0.5);
  assert.equal(parseMacroNumber(".5"), 0.5);
  assert.equal(parseMacroNumber("-0.25"), -0.25);
});

test("typing 90 reads as 90, not 9 then another 90", () => {
  // Each keystroke re-parses the whole buffer against a fixed baseline, so the
  // sequence is 9 → 90, never 9 → 99.
  let buffer = "";
  const seen = [];
  for (const key of ["9", "0"]) {
    buffer += key;
    seen.push(parseMacroNumber(buffer));
  }
  assert.deepEqual(seen, [9, 90]);
});

test("minus toggles the sign of an already-typed value", () => {
  assert.equal(toggleBufferSign("90"), "-90");
  assert.equal(toggleBufferSign("-90"), "90");
  assert.equal(toggleBufferSign(""), "-");
  assert.equal(parseMacroNumber(toggleBufferSign("90")), -90);
  // Round-trip: pressing "-" twice puts you back where you started.
  assert.equal(toggleBufferSign(toggleBufferSign("1.5")), "1.5");
});

// --- Numeric deltas ---------------------------------------------------------

test("numeric translate fills world X when no axis is locked", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const { pos } = numericDelta("translate", new Set(), 2, pivot, cam);
  assert.deepEqual([pos.x, pos.y, pos.z], [2, 0, 0]);
});

test("numeric translate follows the locked axis", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const { pos } = numericDelta("translate", new Set(["z"]), 2, pivot, cam);
  assert.deepEqual([pos.x, pos.y, pos.z], [0, 0, 2]);
});

test("numeric scale of 0.5 shrinks, and only on the locked axis", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const uniform = numericDelta("scale", new Set(), 0.5, pivot, cam).scale;
  assert.deepEqual([uniform.x, uniform.y, uniform.z], [0.5, 0.5, 0.5]);
  const locked = numericDelta("scale", new Set(["x"]), 0.5, pivot, cam).scale;
  assert.deepEqual([locked.x, locked.y, locked.z], [0.5, 1, 1]);
});

test("numeric rotate turns exactly the typed angle about the locked axis", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const { quat } = numericDelta("rotate", new Set(["y"]), 90, pivot, cam);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  // +90° about Y sends +Z to +X.
  assert.ok(forward.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6, `got ${forward.toArray()}`);
});

test("numeric rotate with no axis lock spins about the view axis", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  const axis = macroRotationAxis(new Set(), pivot, cam, new THREE.Vector3());
  // Camera sits on +Z looking back at the origin, so the view axis is +Z.
  assert.ok(axis.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-6, `got ${axis.toArray()}`);
});

test("-90 is the exact inverse of 90", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const plus = numericDelta("rotate", new Set(["y"]), 90, pivot, cam).quat.clone();
  const minus = numericDelta("rotate", new Set(["y"]), -90, pivot, cam).quat.clone();
  const composed = plus.multiply(minus);
  assert.ok(Math.abs(Math.abs(composed.w) - 1) < 1e-6, "90 then -90 should be identity");
});

// --- Pointer gestures -------------------------------------------------------

test("scale shrinks when the cursor moves toward the pivot", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  // Pivot projects to the centre of an 800x600 canvas.
  const pointer = makePointer(600, 300); // 200 px to the right of the pivot
  movePointer(pointer, 500, 300); //        now only 100 px away
  const { scale } = pointerDelta("scale", new Set(), pointer, pivot, RECT, cam);
  assert.ok(Math.abs(scale.x - 0.5) < 1e-6, `expected 0.5x, got ${scale.x}`);
});

test("scale grows when the cursor moves away from the pivot", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const pointer = makePointer(500, 300); // 100 px right of the pivot
  movePointer(pointer, 600, 300); //        now 200 px away
  const { scale } = pointerDelta("scale", new Set(), pointer, pivot, RECT, cam);
  assert.ok(Math.abs(scale.x - 2) < 1e-6, `expected 2x, got ${scale.x}`);
});

test("scale respects the axis lock", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const pointer = makePointer(600, 300);
  movePointer(pointer, 500, 300);
  const { scale } = pointerDelta("scale", new Set(["y"]), pointer, pivot, RECT, cam);
  assert.ok(Math.abs(scale.y - 0.5) < 1e-6);
  assert.equal(scale.x, 1);
  assert.equal(scale.z, 1);
});

test("a cursor that never leaves its anchor is a no-op in every mode", () => {
  const cam = makeCamera();
  const pivot = new THREE.Vector3();
  const scale = pointerDelta("scale", new Set(), makePointer(600, 300), pivot, RECT, cam).scale;
  assert.ok(Math.abs(scale.x - 1) < 1e-9, `expected 1x, got ${scale.x}`);

  const quat = pointerDelta("rotate", new Set(), makePointer(600, 300), pivot, RECT, cam).quat;
  assert.ok(Math.abs(Math.abs(quat.w) - 1) < 1e-9, "no sweep should mean no rotation");

  const pos = pointerDelta("translate", new Set(), makePointer(600, 300), pivot, RECT, cam).pos;
  assert.ok(pos.length() < 1e-9, `expected no move, got ${pos.toArray()}`);
});

test("rotate sweeps the angle the cursor traces around the on-screen pivot", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  const pointer = makePointer(600, 300); // due right of the pivot
  movePointer(pointer, 400, 100); //        due "up" on screen (y is down)
  const { quat } = pointerDelta("rotate", new Set(), pointer, pivot, RECT, cam);
  // A quarter turn counter-clockwise on screen, about the +Z view axis.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(quat.w)));
  assert.ok(Math.abs(angle - Math.PI / 2) < 1e-6, `expected 90°, got ${THREE.MathUtils.radToDeg(angle)}°`);
  const moved = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  assert.ok(moved.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, `+X should swing to +Y, got ${moved.toArray()}`);
});

test("rotate accumulates past 180° instead of wrapping backwards", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  const pointer = makePointer(600, 300);
  // Walk three quarter-turns counter-clockwise around the pivot in steps
  // small enough that no single step is ambiguous.
  const steps = [
    [400, 100],
    [200, 300],
    [400, 500],
  ];
  for (const [x, y] of steps) {
    movePointer(pointer, x, y);
    pointerDelta("rotate", new Set(), pointer, pivot, RECT, cam);
  }
  assert.ok(
    Math.abs(pointer.angle + (3 * Math.PI) / 2) < 1e-6,
    `expected -270° of screen sweep, got ${THREE.MathUtils.radToDeg(pointer.angle)}°`,
  );
});

test("rotate about a locked axis flips direction when the axis faces away", () => {
  const pivot = new THREE.Vector3();
  const front = makeCamera([0, 0, 10]);
  const back = makeCamera([0, 0, -10]);
  const sweep = () => {
    const p = makePointer(600, 300);
    movePointer(p, 400, 100);
    return p;
  };
  const a = pointerDelta("rotate", new Set(["z"]), sweep(), pivot, RECT, front).quat.clone();
  const b = pointerDelta("rotate", new Set(["z"]), sweep(), pivot, RECT, back).quat.clone();
  // Same on-screen gesture from either side spins the object the same way as
  // the user sees it, which means opposite signs about world Z.
  assert.ok(Math.abs(a.z + b.z) < 1e-6, `expected opposite signs, got ${a.z} and ${b.z}`);
});

test("free translate keeps the object under the cursor", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  const pointer = makePointer(400, 300);
  movePointer(pointer, 500, 300); // 100 px right

  const { pos } = pointerDelta("translate", new Set(), pointer, pivot, RECT, cam);
  const wpp = worldPerPixelAt(pivot, RECT, cam);
  assert.ok(Math.abs(pos.x - 100 * wpp) < 1e-6, `got ${pos.x}, expected ${100 * wpp}`);
  assert.ok(Math.abs(pos.y) < 1e-9);

  // Re-project: the moved pivot should land under the cursor's new position.
  const moved = pivot.clone().add(pos).project(cam);
  const px = (moved.x * 0.5 + 0.5) * RECT.width;
  assert.ok(Math.abs(px - 500) < 0.5, `pivot landed at ${px}px, cursor at 500px`);
});

test("free translate moves up when the cursor moves up", () => {
  const cam = makeCamera([0, 0, 10]);
  const pointer = makePointer(400, 300);
  movePointer(pointer, 400, 200); // screen y decreases = upward
  const { pos } = pointerDelta("translate", new Set(), pointer, new THREE.Vector3(), RECT, cam);
  assert.ok(pos.y > 0, `expected +Y, got ${pos.y}`);
});

test("axis-locked translate projects the drag onto the axis' screen direction", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  const pointer = makePointer(400, 300);
  movePointer(pointer, 500, 300);
  const { pos } = pointerDelta("translate", new Set(["x"]), pointer, pivot, RECT, cam);
  // World X is dead horizontal on screen here, so a purely horizontal drag
  // should behave exactly like the free move.
  const free = worldPerPixelAt(pivot, RECT, cam) * 100;
  assert.ok(Math.abs(pos.x - free) < 1e-4, `got ${pos.x}, expected ~${free}`);
  assert.equal(pos.y, 0);
  assert.equal(pos.z, 0);
});

test("dragging backwards along a locked axis moves backwards", () => {
  const cam = makeCamera([0, 0, 10]);
  const pointer = makePointer(400, 300);
  movePointer(pointer, 300, 300);
  const { pos } = pointerDelta("translate", new Set(["x"]), pointer, new THREE.Vector3(), RECT, cam);
  assert.ok(pos.x < 0, `expected -X, got ${pos.x}`);
});

test("an axis pointing straight at the camera contributes nothing", () => {
  const cam = makeCamera([0, 0, 10]);
  const pivot = new THREE.Vector3();
  // World Z runs straight into the lens, so it has no screen direction to
  // drag along — the guard has to return 0 rather than divide by ~0.
  const amount = axisDragAmount("z", 120, -40, pivot, RECT, cam);
  assert.equal(amount, 0);
});

// --- Pivot ------------------------------------------------------------------

test("the pivot is the median of the selection's origins", () => {
  const single = macroPivot([new THREE.Vector3(3, 4, 5)]);
  assert.deepEqual([single.x, single.y, single.z], [3, 4, 5]);

  const pair = macroPivot([new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 4, 6)]);
  assert.deepEqual([pair.x, pair.y, pair.z], [1, 2, 3]);

  assert.deepEqual(macroPivot([]).toArray(), [0, 0, 0]);
});
