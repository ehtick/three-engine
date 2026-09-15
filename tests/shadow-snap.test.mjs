/**
 * Directional shadow recentring (src/engine/shadowSnap.js), shared by
 * LightComponent and the Atmosphere's fallback sun.
 *
 *   - the extracted helper reproduces LightComponent's inline snap exactly;
 *   - the owned sun's centre sits on a WHOLE-TEXEL grid in the shadow camera's
 *     own basis, follows the camera anywhere (not a fixed box at the origin),
 *     and holds still while the camera moves inside a cell.
 *
 * Negative control: the old owned sun re-centred on the RAW camera position —
 * that must fail the whole-texel assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { shadowSnapBasis, snapShadowCentre, wholeTexelStep } from "../src/engine/shadowSnap.js";
import { ownedSunShadowCentre } from "../src/modules/atmosphere/AtmosphereComponent.js";

const TEXEL = 90 / 2048;

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** LightComponent#syncDirectionalTransform's inline math before the extraction. */
function legacySnap(centre, direction, snapX, snapY, snapZ) {
  const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); else right.normalize();
  const up = new THREE.Vector3().crossVectors(right, direction).normalize();
  const px = centre.dot(right), py = centre.dot(up);
  centre.addScaledVector(right, Math.round(px / snapX) * snapX - px);
  centre.addScaledVector(up, Math.round(py / snapY) * snapY - py);
  const pz = centre.dot(direction);
  centre.addScaledVector(direction, Math.round(pz / snapZ) * snapZ - pz);
  return centre;
}

test("the extracted helper reproduces LightComponent's snap", () => {
  const rand = random(7);
  for (let i = 0; i < 500; i++) {
    const direction = new THREE.Vector3(rand() - 0.5, -rand(), rand() - 0.5).normalize();
    if (i === 0) direction.set(0, -1, 0); // degenerate basis
    const camera = new THREE.Vector3((rand() - 0.5) * 2000, rand() * 200, (rand() - 0.5) * 2000);
    const [sx, sy, sz] = [0.5 + rand() * 4, 0.5 + rand() * 4, 0.5 + rand() * 4];
    const expected = legacySnap(camera.clone(), direction, sx, sy, sz);
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    shadowSnapBasis(direction, right, up);
    const actual = camera.clone();
    snapShadowCentre(actual, direction, right, up, sx, sy, 0);
    snapShadowCentre(actual, direction, right, up, 0, 0, sz);
    assert.ok(actual.distanceTo(expected) < 1e-9, `case ${i}: ${actual.distanceTo(expected)}`);
  }
});

function gridResidual(centre, toward) {
  const travel = toward.clone().negate();
  const right = new THREE.Vector3(), up = new THREE.Vector3();
  shadowSnapBasis(travel, right, up);
  const worst = (v) => Math.abs(v / TEXEL - Math.round(v / TEXEL));
  return Math.max(worst(centre.dot(right)), worst(centre.dot(up)), worst(centre.dot(travel)));
}

function checkOwnedSun(centreFor) {
  const rand = random(11);
  const step = wholeTexelStep(4, TEXEL);
  for (let i = 0; i < 200; i++) {
    const toward = new THREE.Vector3(rand() - 0.5, 0.2 + rand(), rand() - 0.5).normalize();
    const camera = new THREE.Vector3((rand() - 0.5) * 3000, rand() * 100, (rand() - 0.5) * 3000);
    const centre = centreFor(camera.clone(), toward);
    assert.ok(gridResidual(centre, toward) < 1e-3, `case ${i}: centre is off the texel grid`);
    // Follows the camera: within half a cell on each of three orthogonal axes.
    assert.ok(centre.distanceTo(camera) <= (step / 2) * Math.sqrt(3) + 1e-6, "follows the camera");
  }
}

test("owned sun: whole-texel grid, follows the camera far from the origin, holds inside a cell", () => {
  const step = wholeTexelStep(4, TEXEL);
  assert.ok(step <= 4 && step > 4 - TEXEL && Math.abs(step / TEXEL - Math.round(step / TEXEL)) < 1e-9);
  checkOwnedSun((camera, toward) => ownedSunShadowCentre(camera, toward));
  const toward = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
  const base = ownedSunShadowCentre(new THREE.Vector3(500, 3, -700), toward.clone());
  let changes = 0;
  let previous = base.clone();
  for (let i = 1; i <= 400; i++) {
    const next = ownedSunShadowCentre(new THREE.Vector3(500 + i * 0.05, 3, -700), toward.clone());
    if (next.distanceToSquared(previous) > 1e-10) changes++;
    previous = next;
  }
  // 20 m of travel: a few cell steps, never a per-frame redraw.
  assert.ok(changes >= 3 && changes <= 12, `recentres: ${changes}`);
});

test("negative control: re-centring on the raw camera position is off the texel grid", () => {
  assert.throws(() => checkOwnedSun((camera) => camera), /off the texel grid/);
});
