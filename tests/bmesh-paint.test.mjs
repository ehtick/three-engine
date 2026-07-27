import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { addFace, addVert, createMesh } from "../src/editor/mesh/bmesh.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { createPaintLayer, dilateEdges, facesNearBrush, paintDab } from "../src/editor/mesh/paint.js";

/** A single unit quad in the XY plane, UV-mapped over the whole 0..1 tile. */
function quadMesh() {
  const mesh = createMesh();
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts, { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  return mesh;
}

const texel = (layer, column, row) => {
  const at = (row * layer.size + column) * 4;
  return [layer.data[at], layer.data[at + 1], layer.data[at + 2], layer.data[at + 3]];
};
const paintedCount = (layer, base = 255) => {
  let count = 0;
  for (let at = 0; at < layer.data.length; at += 4) {
    if (layer.data[at] !== base || layer.data[at + 1] !== base || layer.data[at + 2] !== base) count++;
  }
  return count;
};

const RED = [255, 0, 0];

/* -------------------------------------------------------------------------- */
/* Basics                                                                      */
/* -------------------------------------------------------------------------- */

test("a fresh layer is uniform", () => {
  const layer = createPaintLayer(8, [10, 20, 30, 255]);
  assert.equal(layer.data.length, 8 * 8 * 4);
  assert.deepEqual(texel(layer, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(texel(layer, 7, 7), [10, 20, 30, 255]);
});

test("a dab in the middle of a quad paints the middle of the texture", () => {
  const mesh = quadMesh();
  const layer = createPaintLayer(64);
  const result = paintDab(layer, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.2, color: RED, strength: 1 });
  assert.ok(result.painted > 0);

  const middle = texel(layer, 32, 32);
  assert.ok(middle[0] > 200 && middle[1] < 60, `centre should be red, got ${middle}`);
  // The corners are outside the brush.
  assert.deepEqual(texel(layer, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(texel(layer, 63, 63), [255, 255, 255, 255]);
});

test("V is flipped: painting near UV v=0 writes the BOTTOM row of the image", () => {
  // Getting this backwards mirrors every stroke across the middle of the
  // texture, which looks plausible on a symmetric model and wrong on any other.
  const mesh = quadMesh();
  const layer = createPaintLayer(32);
  // y = 0 in the quad is v = 0 in UV, which is the last row of the image.
  paintDab(layer, [...mesh.faces], { center: [0.5, 0.05, 0], radius: 0.12, color: RED, strength: 1 });
  const bottom = texel(layer, 16, 31);
  const top = texel(layer, 16, 0);
  assert.ok(bottom[0] > bottom[1], `bottom row should be painted, got ${bottom}`);
  assert.deepEqual(top, [255, 255, 255, 255], "the top row must be untouched");
});

test("the brush respects its radius in 3D, not in UV", () => {
  const mesh = quadMesh();
  const small = createPaintLayer(64);
  const large = createPaintLayer(64);
  paintDab(small, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.1, color: RED, strength: 1 });
  paintDab(large, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.3, color: RED, strength: 1 });
  assert.ok(paintedCount(large) > paintedCount(small) * 3, "area grows with the square of the radius");
});

test("a brush off the surface paints nothing", () => {
  const mesh = quadMesh();
  const layer = createPaintLayer(32);
  const result = paintDab(layer, [...mesh.faces], { center: [0.5, 0.5, 5], radius: 0.2, color: RED, strength: 1 });
  assert.equal(result.painted, 0);
  assert.equal(paintedCount(layer), 0);
});

test("falloff makes the centre stronger than the rim", () => {
  const mesh = quadMesh();
  const layer = createPaintLayer(64);
  paintDab(layer, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.4, color: [0, 0, 0], strength: 1, falloff: "smooth", hardness: 1 });
  const centre = texel(layer, 32, 32)[0];
  const middle = texel(layer, 32 + 8, 32)[0];
  const rim = texel(layer, 32 + 24, 32)[0];
  assert.ok(centre < middle, `centre ${centre} should be darker than ${middle}`);
  assert.ok(middle < rim, `middle ${middle} should be darker than rim ${rim}`);
});

test("repeated dabs converge on the brush colour", () => {
  const mesh = quadMesh();
  const layer = createPaintLayer(32);
  for (let pass = 0; pass < 12; pass++) {
    paintDab(layer, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.3, color: RED, strength: 0.5 });
  }
  const centre = texel(layer, 16, 16);
  assert.ok(centre[0] > 250 && centre[1] < 5, `expected near-pure red, got ${centre}`);
});

/* -------------------------------------------------------------------------- */
/* Blend modes                                                                 */
/* -------------------------------------------------------------------------- */

test("blend modes move the texel in the direction they claim", () => {
  const mesh = quadMesh();
  const options = { center: [0.5, 0.5, 0], radius: 0.3, strength: 1, falloff: "constant" };

  const subtracted = createPaintLayer(16);
  paintDab(subtracted, [...mesh.faces], { ...options, mode: "subtract", color: [100, 100, 100] });
  assert.ok(texel(subtracted, 8, 8)[0] < 200, "subtract darkens");

  const multiplied = createPaintLayer(16, [200, 200, 200, 255]);
  paintDab(multiplied, [...mesh.faces], { ...options, mode: "multiply", color: [128, 128, 128] });
  assert.ok(texel(multiplied, 8, 8)[0] < 200, "multiply darkens toward the product");

  const erased = createPaintLayer(16, [10, 10, 10, 255]);
  paintDab(erased, [...mesh.faces], { ...options, mode: "erase", baseColor: [255, 255, 255] });
  assert.ok(texel(erased, 8, 8)[0] > 200, "erase returns to the base colour");
});

/* -------------------------------------------------------------------------- */
/* Seams — the reason this rasterises instead of painting in UV space          */
/* -------------------------------------------------------------------------- */

test("two islands adjacent in UV but far apart in 3D do not bleed into each other", () => {
  // Two quads side by side in UV space (touching at u = 0.5) but a metre apart
  // in 3D. A painter working in UV space alone would paint both.
  const mesh = createMesh();
  const near = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, near, { uvs: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] });
  const far = [[0, 0, 10], [1, 0, 10], [1, 1, 10], [0, 1, 10]].map((co) => addVert(mesh, co));
  addFace(mesh, far, { uvs: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] });

  const layer = createPaintLayer(64);
  // Brush hard against the UV boundary, but only on the near quad.
  paintDab(layer, [...mesh.faces], { center: [0.98, 0.5, 0], radius: 0.15, color: RED, strength: 1 });

  const leftIsland = texel(layer, 30, 32);
  const rightIsland = texel(layer, 34, 32);
  assert.ok(leftIsland[0] > leftIsland[1], `the near quad should be painted, got ${leftIsland}`);
  assert.deepEqual(rightIsland, [255, 255, 255, 255], "the far quad must not be touched");
});

test("one 3D brush reaches both sides of a UV seam", () => {
  // Two quads adjacent in 3D but mapped to opposite corners of the atlas.
  const mesh = createMesh();
  const left = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, left, { uvs: [[0, 0], [0.25, 0], [0.25, 0.25], [0, 0.25]] });
  const right = [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, right, { uvs: [[0.75, 0.75], [1, 0.75], [1, 1], [0.75, 1]] });

  const layer = createPaintLayer(64);
  // Straddling the shared 3D edge at x = 1.
  paintDab(layer, [...mesh.faces], { center: [1, 0.5, 0], radius: 0.4, color: RED, strength: 1 });

  const firstIsland = texel(layer, 14, 56);
  const secondIsland = texel(layer, 50, 8);
  assert.ok(firstIsland[0] > firstIsland[1], `first island should be painted, got ${firstIsland}`);
  assert.ok(secondIsland[0] > secondIsland[1], `second island should be painted too, got ${secondIsland}`);
});

/* -------------------------------------------------------------------------- */
/* Face gathering                                                              */
/* -------------------------------------------------------------------------- */

test("facesNearBrush finds a face the brush is sitting in the middle of", () => {
  // The brush is far smaller than the face and touches none of its corners.
  const mesh = createMesh();
  const verts = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]].map((co) => addVert(mesh, co));
  addFace(mesh, verts, { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  assert.equal(facesNearBrush(mesh, [0, 0, 0], 0.5).length, 1);
});

test("facesNearBrush ignores faces out of reach", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  const all = facesNearBrush(mesh, [0, 0, 0], 100).length;
  const none = facesNearBrush(mesh, [50, 50, 50], 0.2).length;
  assert.equal(all, 6);
  assert.equal(none, 0);
});

test("painting a real box primitive works through its own UVs", () => {
  const mesh = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
  const layer = createPaintLayer(128);
  const centre = [0, 0, 1]; // on the +Z face
  const near = facesNearBrush(mesh, centre, 0.5);
  assert.ok(near.length >= 1);
  const result = paintDab(layer, near, { center: centre, radius: 0.5, color: RED, strength: 1 });
  assert.ok(result.painted > 0, "the box's own UVs were used");
  assert.ok(result.bounds, "a changed region was reported");
});

/* -------------------------------------------------------------------------- */
/* Dilation                                                                    */
/* -------------------------------------------------------------------------- */

test("dilateEdges grows painted regions into the transparent gutter", () => {
  const layer = createPaintLayer(8, [0, 0, 0, 0]);
  const at = (3 * 8 + 3) * 4;
  layer.data[at] = 255;
  layer.data[at + 3] = 255;
  assert.equal(texel(layer, 4, 3)[3], 0, "the neighbour starts empty");
  dilateEdges(layer, 1);
  assert.equal(texel(layer, 4, 3)[3], 255, "and is filled from its painted neighbour");
  assert.equal(texel(layer, 4, 3)[0], 255);
});

test("dilateEdges leaves an already-opaque layer alone", () => {
  const layer = createPaintLayer(8, [12, 34, 56, 255]);
  const before = layer.data.slice();
  dilateEdges(layer, 2);
  assert.deepEqual([...layer.data], [...before]);
});

test("a dab reports the texel bounds it changed", () => {
  const mesh = quadMesh();
  const layer = createPaintLayer(64);
  const { bounds } = paintDab(layer, [...mesh.faces], { center: [0.5, 0.5, 0], radius: 0.1, color: RED, strength: 1 });
  assert.ok(bounds.minX > 0 && bounds.maxX < 63, "a small brush touches only the middle");
  assert.ok(bounds.maxX - bounds.minX < 32);
});
