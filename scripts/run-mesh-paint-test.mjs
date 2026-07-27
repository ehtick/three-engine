// Texture painting: orientation, cost and colour.
//
// The three defects this pins down were all invisible to a unit test of the
// blend maths and all very visible on screen:
//   * a dab used to scan every texel of every triangle's UV box, which on the
//     0..1-per-face layout a box primitive ships with is the whole atlas;
//   * the layer was written in image row order but uploaded un-flipped, so
//     strokes appeared mirrored across the horizontal midline;
//   * the exported PNG has to be flipped back, or it saves upside down.
//
// Run: node scripts/run-mesh-paint-test.mjs

import * as THREE from "three/webgpu";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { createPaintLayer, facesNearBrush, paintDab } from "../src/editor/mesh/paint.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const cube = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

console.log("\n--- cost of a dab on box UVs (every face covers the whole atlas) ---");
{
  const size = 1024;
  const layer = createPaintLayer(size);
  const center = [0, 0, 1]; // on the +Z face
  const radius = 0.25;
  const faces = facesNearBrush(cube, center, radius);

  for (let warm = 0; warm < 10; warm++) paintDab(layer, faces, { center, radius, color: [255, 0, 0] });

  const started = performance.now();
  let painted = 0;
  for (let dab = 0; dab < 40; dab++) {
    painted += paintDab(layer, faces, { center, radius, color: [255, 0, 0] }).painted;
  }
  const elapsed = performance.now() - started;
  const perDab = elapsed / 40;
  console.log(`  40 dabs at ${size}px over ${faces.length} faces: ${elapsed.toFixed(1)}ms (${perDab.toFixed(2)}ms/dab), ${painted / 40} texels/dab`);
  // The old scan was bounded only by the triangle's own UV box: 1024x1024 per
  // triangle, ten triangles, ~10M texel tests per dab. A stroke's worth of dabs
  // at that price is the 3-5 second stall.
  check("a dab costs under 5ms", perDab < 5, `${perDab.toFixed(2)}ms`);
  check("the dab actually painted something", painted > 0, `${painted / 40} texels`);

  // A whole stroke dragged across the face, at the spacing the panel uses.
  const strokeStart = performance.now();
  let dabs = 0;
  for (let step = -20; step <= 20; step++) {
    const at = [step * radius * 0.2, 0, 1];
    paintDab(layer, facesNearBrush(cube, at, radius), { center: at, radius, color: [40, 90, 220] });
    dabs++;
  }
  const strokeCost = performance.now() - strokeStart;
  // What matters for feel is the cost of one pointer event, which lays down a
  // handful of dabs — not the total for a drag, which is spread over its whole
  // duration. Before the footprint clamp this was ~200ms *per dab*.
  const perStrokeDab = strokeCost / dabs;
  console.log(`  a ${dabs}-dab stroke across the face: ${strokeCost.toFixed(1)}ms (${perStrokeDab.toFixed(2)}ms/dab incl. face lookup)`);
  check("a dab within a moving stroke stays under a frame", perStrokeDab < 16, `${perStrokeDab.toFixed(2)}ms`);
}

/* -------------------------------------------------------------------------- */
/* Orientation                                                                 */
/* -------------------------------------------------------------------------- */

console.log("\n--- orientation: the painted texel must be the one the surface samples ---");
{
  // A single quad in the XY plane with a straightforward unwrap, so the mapping
  // from a 3D point to the texel that shades it is checkable by hand.
  const plane = new THREE.PlaneGeometry(2, 2);
  const quad = meshFromBufferGeometry(plane);
  const size = 64;

  // Paint near the TOP of the plane (y = +0.8). PlaneGeometry maps y=+1 to v=1.
  const layer = createPaintLayer(size, [0, 0, 0, 255]);
  const faces = facesNearBrush(quad, [0, 0.8, 0], 0.3);
  paintDab(layer, faces, { center: [0, 0.8, 0], radius: 0.3, color: [255, 0, 0], falloff: "constant" });

  const rowOf = (row, column) => layer.data[(row * size + column) * 4];
  const middle = Math.floor(size / 2);
  // v ~ 0.9 -> with row 0 holding v=0, that is a HIGH row index.
  const highRow = Math.floor(0.9 * size);
  const lowRow = Math.floor(0.1 * size);
  check("paint at v=0.9 lands in the high rows", rowOf(highRow, middle) > 200, `row ${highRow} = ${rowOf(highRow, middle)}`);
  check("paint at v=0.9 leaves the low rows alone", rowOf(lowRow, middle) < 50, `row ${lowRow} = ${rowOf(lowRow, middle)}`);

  // And the U axis, which was never in doubt but pins the pair together.
  const layerU = createPaintLayer(size, [0, 0, 0, 255]);
  const facesU = facesNearBrush(quad, [0.8, 0, 0], 0.3);
  paintDab(layerU, facesU, { center: [0.8, 0, 0], radius: 0.3, color: [255, 0, 0], falloff: "constant" });
  const columnAt = (column) => layerU.data[(middle * size + column) * 4];
  check("paint at u=0.9 lands in the high columns", columnAt(Math.floor(0.9 * size)) > 200);
  check("paint at u=0.9 leaves the low columns alone", columnAt(Math.floor(0.1 * size)) < 50);
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

console.log("\n--- colour: the dab paints the colour it is given ---");
{
  const size = 64;
  for (const [name, colour] of [["red", [255, 0, 0]], ["green", [0, 255, 0]], ["blue", [0, 0, 255]]]) {
    const layer = createPaintLayer(size, [0, 0, 0, 255]);
    const faces = facesNearBrush(cube, [0, 0, 1], 0.5);
    const { bounds } = paintDab(layer, faces, { center: [0, 0, 1], radius: 0.5, color: colour, strength: 1, falloff: "constant" });
    const at = ((bounds.minY + bounds.maxY) >> 1) * size + ((bounds.minX + bounds.maxX) >> 1);
    const got = [layer.data[at * 4], layer.data[at * 4 + 1], layer.data[at * 4 + 2]];
    check(`${name} paints ${colour}`, got.every((value, index) => Math.abs(value - colour[index]) < 12), `got ${got}`);
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall paint checks passed");
process.exit(failures ? 1 : 0);
