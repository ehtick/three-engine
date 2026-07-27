/**
 * Texture painting: brush strokes on the surface, written into an image through
 * the mesh's UVs. Blender's Texture Paint mode.
 *
 * The awkward part is that the brush is a sphere in *3D* while the target is a
 * grid of texels in *UV* space, and the map between them is per-triangle and
 * discontinuous across seams. Painting in UV space alone would bleed across
 * unrelated islands that happen to be neighbours in the atlas; painting in 3D
 * alone has nowhere to write.
 *
 * So each dab rasterises: for every triangle near the brush, walk the texels its
 * UV triangle covers, map each one back to a 3D position by barycentric
 * interpolation, and blend only where that position is actually inside the
 * brush sphere. Seams come out right for free — two islands far apart in UV
 * space but adjacent on the surface both get painted, and two islands adjacent
 * in UV space but far apart on the surface do not.
 *
 * Works on a plain `Uint8ClampedArray` in RGBA order, so it is testable without
 * a canvas, a renderer or a DOM.
 */

import { faceVerts } from "./bmesh.js";
import { faceTriangles } from "./tessellate.js";
import { falloffWeight } from "../brush.js";

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** A blank RGBA layer. */
export function createPaintLayer(size, fill = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = fill[0];
    data[at + 1] = fill[1];
    data[at + 2] = fill[2];
    data[at + 3] = fill[3];
  }
  return { data, size };
}

/**
 * Texel row for a V coordinate.
 *
 * Row 0 holds V=0. That is the orientation an un-flipped upload gives the GPU —
 * the layer is handed straight to a `DataTexture` with `flipY = false`, so the
 * first row of the array is the first row of the texture and V=0 samples it.
 *
 * The opposite convention (row 0 = V=1, which is what an *image file* uses)
 * looks plausible and paints a perfectly formed stroke in the wrong half of the
 * texture — mirrored across the horizontal midline. `layerToDataURL` is where
 * the flip to image order belongs, and it does it there.
 */
const texelRow = (v, size) => Math.floor(v * size);
const texelColumn = (u, size) => Math.floor(u * size);

export const PAINT_BLEND_MODES = [
  { id: "mix", label: "Mix" },
  { id: "add", label: "Add" },
  { id: "subtract", label: "Subtract" },
  { id: "multiply", label: "Multiply" },
  { id: "erase", label: "Erase to Base" },
];

/**
 * The UV-space box the brush can possibly reach on one triangle, or null when
 * the sphere does not touch the triangle's plane at all.
 *
 * Without this the scan is bounded only by the triangle's *own* UV box, which
 * is a disaster on the UV layouts primitives ship with: a box maps every one of
 * its six faces to the whole 0..1 square, so a single dab used to walk
 * `size * size` texels per triangle — 12.6 million at 1024 for a cube, per dab,
 * with a stroke laying down dabs continuously. That is the 3-5 second stall.
 *
 * The surface-to-UV map is affine across a triangle, so the sphere's footprint
 * (a circle where the sphere cuts the plane) maps to an ellipse in UV space and
 * its bounding box is exact — no texel that could have been painted is skipped.
 */
function brushFootprint(positions, uvTriangle, center, radius) {
  const [a, b, c] = positions;
  const e0 = sub3(b, a);
  const e1 = sub3(c, a);
  const normal = cross3(e0, e1);
  const normalLength = Math.sqrt(dot3(normal, normal));
  if (normalLength < 1e-12) return null; // degenerate in 3D
  const unit = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];

  const toCenter = sub3(center, a);
  const height = dot3(toCenter, unit);
  const inPlaneSquared = radius * radius - height * height;
  if (inPlaneSquared <= 0) return null; // the sphere never reaches this plane
  const inPlaneRadius = Math.sqrt(inPlaneSquared);

  // Express an in-plane vector in the (e0, e1) basis. Dotting against e0/e1
  // discards any out-of-plane part, so this projects as well as solves.
  const g00 = dot3(e0, e0);
  const g01 = dot3(e0, e1);
  const g11 = dot3(e1, e1);
  const determinant = g00 * g11 - g01 * g01;
  if (Math.abs(determinant) < 1e-20) return null;
  const coefficients = (vector) => {
    const p = dot3(vector, e0);
    const q = dot3(vector, e1);
    return [(p * g11 - q * g01) / determinant, (q * g00 - p * g01) / determinant];
  };

  const f0u = uvTriangle[1][0] - uvTriangle[0][0];
  const f0v = uvTriangle[1][1] - uvTriangle[0][1];
  const f1u = uvTriangle[2][0] - uvTriangle[0][0];
  const f1v = uvTriangle[2][1] - uvTriangle[0][1];

  const [centreA, centreB] = coefficients(toCenter);
  const u = uvTriangle[0][0] + centreA * f0u + centreB * f1u;
  const v = uvTriangle[0][1] + centreA * f0v + centreB * f1v;

  // Half-extents of the ellipse: push an orthonormal in-plane basis through the
  // same map and combine, which is the axis-aligned bound of the unit circle's
  // image scaled by the footprint radius.
  const firstLength = Math.sqrt(g00);
  if (firstLength < 1e-12) return null;
  const basisA = [e0[0] / firstLength, e0[1] / firstLength, e0[2] / firstLength];
  const projection = dot3(e1, basisA);
  const residual = [
    e1[0] - basisA[0] * projection,
    e1[1] - basisA[1] * projection,
    e1[2] - basisA[2] * projection,
  ];
  const residualLength = Math.sqrt(dot3(residual, residual));
  if (residualLength < 1e-12) return null;
  const basisB = [residual[0] / residualLength, residual[1] / residualLength, residual[2] / residualLength];

  const [pa, pb] = coefficients(basisA);
  const [qa, qb] = coefficients(basisB);
  const halfU = inPlaneRadius * Math.hypot(pa * f0u + pb * f1u, qa * f0u + qb * f1u);
  const halfV = inPlaneRadius * Math.hypot(pa * f0v + pb * f1v, qa * f0v + qb * f1v);
  return { u0: u - halfU, u1: u + halfU, v0: v - halfV, v1: v + halfV };
}

const FALLOFF_TABLE_SIZE = 1024;
const falloffTable = new Float32Array(FALLOFF_TABLE_SIZE + 1);
let falloffTableKey = "";

/**
 * Brush weight per squared normalised distance, as a table.
 *
 * Indexing by the *square* is what lets the caller skip the square root: the
 * only thing the loop has left to do is a multiply and a truncation.
 */
function buildFalloffTable(falloff, hardness, strength) {
  const exponent = Math.max(hardness, 0.01);
  const key = `${falloff}|${exponent}|${strength}`;
  if (key === falloffTableKey) return falloffTable;
  for (let index = 0; index <= FALLOFF_TABLE_SIZE; index++) {
    const weight = falloffWeight(Math.sqrt(index / FALLOFF_TABLE_SIZE), falloff);
    const shaped = exponent === 1 ? weight : weight ** exponent;
    const amount = shaped * strength;
    falloffTable[index] = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  }
  falloffTableKey = key;
  return falloffTable;
}

function blend(mode, current, target, amount) {
  switch (mode) {
    case "add": return current + target * amount;
    case "subtract": return current - target * amount;
    case "multiply": return current * (1 - amount) + ((current * target) / 255) * amount;
    default: return current + (target - current) * amount;
  }
}

/**
 * Paints one dab.
 *
 * `faces` should already be narrowed to those near the brush — the caller has a
 * spatial index and this function does not, so handing it the whole mesh would
 * rasterise every triangle in the model for every dab.
 *
 * Returns the number of texels written, and the texel-space bounding box that
 * changed so the caller can upload a partial update.
 */
export function paintDab(layer, faces, options) {
  const {
    center,
    radius = 0.25,
    color = [255, 255, 255],
    strength = 1,
    falloff = "smooth",
    hardness = 1,
    mode = "mix",
    baseColor = [255, 255, 255],
  } = options;
  const { data, size } = layer;
  const target = mode === "erase" ? baseColor : color;
  // "erase" is a mix towards the base colour, so it takes the same fast path.
  const mixing = mode === "mix" || mode === "erase";

  // Falloff, hardness and strength collapse into one table looked up by
  // *squared* normalised distance — so the inner loop pays neither the sqrt nor
  // the `Math.cos` the default smooth curve is made of. Blender's brushes are
  // table-driven for the same reason. Built once per dab; 1024 entries over a
  // curve this smooth is far finer than an 8-bit channel can show.
  const strengthTable = buildFalloffTable(falloff, hardness, strength);

  let painted = 0;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;

  for (const face of faces) {
    const ring = faceVerts(face);
    const uvs = face.loops.map((loop) => loop.uv);
    for (const [ia, ib, ic] of faceTriangles(face)) {
      const positions = [ring[ia].co, ring[ib].co, ring[ic].co];
      const uvTriangle = [uvs[ia], uvs[ib], uvs[ic]];

      // Texel-space bounding box of the UV triangle, padded by one so a
      // triangle thinner than a texel still touches the row it sits on.
      let left = size;
      let right = -1;
      let top = size;
      let bottom = -1;
      for (const uv of uvTriangle) {
        const column = texelColumn(uv[0], size);
        const row = texelRow(uv[1], size);
        left = Math.min(left, column);
        right = Math.max(right, column);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
      }
      left = Math.max(0, left - 1);
      top = Math.max(0, top - 1);
      right = Math.min(size - 1, right + 1);
      bottom = Math.min(size - 1, bottom + 1);
      if (right < left || bottom < top) continue;

      // ...then narrowed to where the brush can actually reach. On a triangle
      // that spans the whole atlas this is the difference between scanning the
      // entire texture and scanning the few hundred texels under the cursor.
      const footprint = brushFootprint(positions, uvTriangle, center, radius);
      if (!footprint) continue;
      left = Math.max(left, texelColumn(footprint.u0, size) - 1);
      right = Math.min(right, texelColumn(footprint.u1, size) + 1);
      top = Math.max(top, texelRow(footprint.v0, size) - 1);
      bottom = Math.min(bottom, texelRow(footprint.v1, size) + 1);
      if (right < left || bottom < top) continue;

      // Barycentric setup in UV space, once per triangle.
      const [uvA, uvB, uvC] = uvTriangle;
      const uvAu = uvA[0];
      const uvAv = uvA[1];
      const v0u = uvB[0] - uvA[0];
      const v0v = uvB[1] - uvA[1];
      const v1u = uvC[0] - uvA[0];
      const v1v = uvC[1] - uvA[1];
      const denominator = v0u * v1v - v1u * v0v;
      if (Math.abs(denominator) < 1e-12) continue; // zero-area in UV space
      const inverse = 1 / denominator;

      // Everything the inner loop touches is hoisted into a scalar. The obvious
      // spelling — building a `point` array and calling sub3/dot3 — allocates
      // two arrays per texel, and a single dab covers tens of thousands of
      // them; the garbage alone cost more than all the arithmetic.
      const ax = positions[0][0];
      const ay = positions[0][1];
      const az = positions[0][2];
      const bx = positions[1][0];
      const by = positions[1][1];
      const bz = positions[1][2];
      const cx = positions[2][0];
      const cy = positions[2][1];
      const cz = positions[2][2];
      const centerX = center[0];
      const centerY = center[1];
      const centerZ = center[2];
      const radiusSquared = radius * radius;
      const tableScale = FALLOFF_TABLE_SIZE / radiusSquared;
      const targetR = target[0];
      const targetG = target[1];
      const targetB = target[2];

      for (let row = top; row <= bottom; row++) {
        const v2v = (row + 0.5) / size - uvAv;
        const rowBase = row * size;
        const betaRow = v2v * -v1u * inverse;
        const gammaRow = v2v * v0u * inverse;
        for (let column = left; column <= right; column++) {
          const v2u = (column + 0.5) / size - uvAu;
          const beta = v2u * v1v * inverse + betaRow;
          const gamma = gammaRow - v2u * v0v * inverse;
          const alpha = 1 - beta - gamma;
          // A small tolerance keeps adjacent triangles from leaving a seam of
          // unpainted texels along their shared edge.
          if (alpha < -0.001 || beta < -0.001 || gamma < -0.001) continue;

          const offsetX = ax * alpha + bx * beta + cx * gamma - centerX;
          const offsetY = ay * alpha + by * beta + cy * gamma - centerY;
          const offsetZ = az * alpha + bz * beta + cz * gamma - centerZ;
          const distanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
          if (distanceSquared > radiusSquared) continue;

          const amount = strengthTable[(distanceSquared * tableScale) | 0];
          if (amount <= 0) continue;

          const at = (rowBase + column) * 4;
          if (mixing) {
            // Mix is the default and by far the most used; spelling it out here
            // keeps three function calls per texel out of the hot loop.
            const current0 = data[at];
            const current1 = data[at + 1];
            const current2 = data[at + 2];
            data[at] = current0 + (targetR - current0) * amount;
            data[at + 1] = current1 + (targetG - current1) * amount;
            data[at + 2] = current2 + (targetB - current2) * amount;
          } else {
            data[at] = blend(mode, data[at], targetR, amount);
            data[at + 1] = blend(mode, data[at + 1], targetG, amount);
            data[at + 2] = blend(mode, data[at + 2], targetB, amount);
          }
          data[at + 3] = 255;
          painted++;
          if (column < minX) minX = column;
          if (column > maxX) maxX = column;
          if (row < minY) minY = row;
          if (row > maxY) maxY = row;
        }
      }
    }
  }
  return { painted, bounds: painted ? { minX, minY, maxX, maxY } : null };
}

/**
 * Faces with any vertex inside the brush, plus those the brush sits in the
 * middle of. Linear in the face count, so the caller should keep a spatial
 * index for anything large; this is the correctness reference.
 */
export function facesNearBrush(mesh, center, radius) {
  const found = [];
  const radiusSquared = radius * radius;
  for (const face of mesh.faces) {
    let near = false;
    for (const loop of face.loops) {
      const offset = sub3(loop.v.co, center);
      if (dot3(offset, offset) <= radiusSquared) {
        near = true;
        break;
      }
    }
    if (!near) {
      // The brush may be smaller than the face it is sitting on.
      const ring = faceVerts(face);
      let sum = [0, 0, 0];
      for (const vert of ring) sum = [sum[0] + vert.co[0], sum[1] + vert.co[1], sum[2] + vert.co[2]];
      const centre = sum.map((value) => value / ring.length);
      const offset = sub3(centre, center);
      near = dot3(offset, offset) <= (radius + faceRadius(ring, centre)) ** 2;
    }
    if (near) found.push(face);
  }
  return found;
}

function faceRadius(ring, centre) {
  let largest = 0;
  for (const vert of ring) {
    const offset = sub3(vert.co, centre);
    largest = Math.max(largest, dot3(offset, offset));
  }
  return Math.sqrt(largest);
}

/**
 * Fills the transparent gutter around each UV island by one texel.
 *
 * Bilinear sampling at an island's edge reaches slightly past it; without a
 * margin that pull comes from unpainted background and shows as a dark seam.
 * Run once after a stroke, not per dab.
 */
export function dilateEdges(layer, passes = 1) {
  const { data, size } = layer;
  for (let pass = 0; pass < passes; pass++) {
    const source = data.slice();
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const at = (row * size + column) * 4;
        if (source[at + 3] > 0) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const y = row + dy;
            const x = column + dx;
            if (y < 0 || x < 0 || y >= size || x >= size) continue;
            const near = (y * size + x) * 4;
            if (source[near + 3] === 0) continue;
            r += source[near];
            g += source[near + 1];
            b += source[near + 2];
            count++;
          }
        }
        if (!count) continue;
        data[at] = r / count;
        data[at + 1] = g / count;
        data[at + 2] = b / count;
        data[at + 3] = 255;
      }
    }
  }
  return layer;
}

/**
 * Encodes the layer as a PNG data URL via a canvas. Browser only.
 *
 * The rows are flipped on the way out. The layer is stored in texture order
 * (row 0 is V=0) because that is what an un-flipped GPU upload wants, whereas a
 * PNG's first row is its top edge and every image loader re-flips it. Writing
 * the buffer out verbatim saves a file that renders upside down the moment it
 * is assigned back to a material.
 */
export function layerToDataURL(layer, document_) {
  const { data, size } = layer;
  const canvas = document_.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const image = context.createImageData(size, size);
  const stride = size * 4;
  for (let row = 0; row < size; row++) {
    image.data.set(data.subarray(row * stride, row * stride + stride), (size - 1 - row) * stride);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}
