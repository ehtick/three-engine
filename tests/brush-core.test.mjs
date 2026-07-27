import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLOFF_CURVES,
  brushWeight,
  createStroke,
  falloffWeight,
  resetStroke,
  strokeDabs,
} from "../src/editor/brush.js";
import { FALLOFFS, falloffWeight as transformFalloff } from "../src/editor/mesh/transform.js";
import { strokeDabPositions, beginStroke } from "../src/editor/mesh/sculpt.js";
import { createMesh, addVert } from "../src/editor/mesh/bmesh.js";

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

/* -------------------------------------------------------------------------- */
/* Falloff                                                                     */
/* -------------------------------------------------------------------------- */

test("every curve is 1 at the centre and 0 from the rim outward", () => {
  for (const { id } of FALLOFF_CURVES) {
    assert.ok(close(falloffWeight(0, id), 1), `${id} should be 1 at the centre`);
    assert.equal(falloffWeight(1, id), 0, `${id} should be 0 at the rim`);
    assert.equal(falloffWeight(2, id), 0, `${id} should stay 0 outside`);
    assert.equal(falloffWeight(-1, id), 1, `${id} should clamp below zero`);
  }
});

test("curves are monotonically non-increasing", () => {
  for (const { id } of FALLOFF_CURVES) {
    if (id === "constant") continue;
    let previous = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const weight = falloffWeight(t, id);
      assert.ok(weight <= previous + 1e-9, `${id} rose at t=${t}`);
      previous = weight;
    }
  }
});

test("the mesh transform module and the brush core share one definition", () => {
  assert.deepEqual(FALLOFFS, FALLOFF_CURVES, "proportional editing uses the shared curve list");
  for (const { id } of FALLOFF_CURVES) {
    for (const t of [0, 0.25, 0.5, 0.75, 0.99]) {
      assert.equal(transformFalloff(t, id), falloffWeight(t, id));
    }
  }
});

/* -------------------------------------------------------------------------- */
/* brushWeight: the terrain compatibility path                                 */
/* -------------------------------------------------------------------------- */

test("with no curve, brushWeight reproduces the terrain hardness exponent exactly", () => {
  // This is the formula terrain shipped with; existing strokes must not change.
  const legacy = (normalized, hardness) => (1 - normalized) ** (0.4 + (4 - 0.4) * hardness);
  for (const hardness of [0, 0.25, 0.5, 0.75, 1]) {
    for (const t of [0, 0.1, 0.5, 0.9, 0.999]) {
      assert.ok(
        close(brushWeight(t, { hardness }), legacy(t, hardness), 1e-12),
        `hardness ${hardness} at t=${t}: ${brushWeight(t, { hardness })} vs ${legacy(t, hardness)}`,
      );
    }
  }
});

test("naming a curve overrides hardness entirely", () => {
  assert.equal(brushWeight(0.5, { curve: "constant", hardness: 1 }), 1);
  assert.equal(brushWeight(0.5, { curve: "linear", hardness: 0 }), 0.5);
});

test("brushWeight reaches zero at the rim on both paths", () => {
  assert.equal(brushWeight(1, { hardness: 0.5 }), 0);
  assert.equal(brushWeight(1.5, { hardness: 0 }), 0);
  assert.equal(brushWeight(1, { curve: "constant" }), 0);
});

/* -------------------------------------------------------------------------- */
/* Stroke dabs                                                                 */
/* -------------------------------------------------------------------------- */

test("the first sample of a stroke always lays exactly one dab", () => {
  const stroke = createStroke({ spacing: 0.3 });
  const dabs = strokeDabs(stroke, [5, 5], 1);
  assert.equal(dabs.length, 1);
  assert.deepEqual(dabs[0], [5, 5]);
});

test("a fast drag is filled in rather than left dotted", () => {
  const stroke = createStroke({ spacing: 0.25 });
  strokeDabs(stroke, [0, 0], 1);
  // A jump of 10 units with a 0.25-unit step.
  const dabs = strokeDabs(stroke, [10, 0], 1);
  assert.equal(dabs.length, 40, "the gap is filled at the spacing interval");
  for (let index = 1; index < dabs.length; index++) {
    const step = Math.hypot(dabs[index][0] - dabs[index - 1][0], dabs[index][1] - dabs[index - 1][1]);
    assert.ok(close(step, 0.25, 1e-9), `dabs should be evenly spaced, got ${step}`);
  }
});

test("a slow drag lays no dab until it has moved a full step", () => {
  const stroke = createStroke({ spacing: 0.5 });
  strokeDabs(stroke, [0, 0], 1);
  assert.equal(strokeDabs(stroke, [0.1, 0], 1).length, 0);
  assert.equal(strokeDabs(stroke, [0.2, 0], 1).length, 0);
  assert.equal(strokeDabs(stroke, [0.6, 0], 1).length, 1, "crossing the step lays one");
});

test("dab spacing scales with the brush radius", () => {
  const small = createStroke({ spacing: 0.25 });
  strokeDabs(small, [0, 0], 1);
  const narrow = strokeDabs(small, [4, 0], 1).length;

  const large = createStroke({ spacing: 0.25 });
  strokeDabs(large, [0, 0], 2);
  const wide = strokeDabs(large, [4, 0], 2).length;
  assert.equal(narrow, wide * 2, "a brush twice as wide lays half as many dabs");
});

test("a single event cannot queue an unbounded number of dabs", () => {
  const stroke = createStroke({ spacing: 0.25 });
  strokeDabs(stroke, [0, 0], 0.01);
  const dabs = strokeDabs(stroke, [10000, 0], 0.01);
  assert.equal(dabs.length, 64, "capped so one flick cannot stall the drag");
});

test("resetStroke starts a fresh trail", () => {
  const stroke = createStroke({ spacing: 0.5 });
  strokeDabs(stroke, [0, 0], 1);
  resetStroke(stroke);
  const dabs = strokeDabs(stroke, [50, 0], 1);
  assert.equal(dabs.length, 1, "a new stroke does not interpolate from the old one");
  assert.deepEqual(dabs[0], [50, 0]);
});

test("the stroke helper works in both 2D and 3D", () => {
  const flat = createStroke({ spacing: 0.5 });
  strokeDabs(flat, [0, 0], 1);
  assert.equal(strokeDabs(flat, [1, 0], 1)[0].length, 2, "terrain passes XZ");

  const volume = createStroke({ spacing: 0.5 });
  strokeDabs(volume, [0, 0, 0], 1);
  assert.equal(strokeDabs(volume, [1, 0, 0], 1)[0].length, 3, "the mesh sculptor passes XYZ");
});

test("the mesh sculptor's stroke wrapper delegates to the shared core", () => {
  const mesh = createMesh();
  addVert(mesh, [0, 0, 0]);
  const stroke = beginStroke(mesh, { radius: 1, spacing: 0.25 });
  assert.equal(strokeDabPositions(stroke, [0, 0, 0], 1).length, 1);
  assert.equal(strokeDabPositions(stroke, [4, 0, 0], 1).length, 16);
  assert.equal(stroke.dabs, 17, "the shared counter is kept up to date");
});
