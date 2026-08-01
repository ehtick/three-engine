// Recognising primitives in IMPORTED geometry, so they can use an exact
// analytic SDF instead of a baked grid.
//
// WHY THIS EXISTS. The analytic path (GISystem's `analyticShapeOf`) keys off
// `geometry.parameters` — the construction arguments three stores on a
// BoxGeometry/PlaneGeometry/SphereGeometry. A GLB has none of that: every
// imported mesh is an anonymous BufferGeometry, so an imported wall, floor
// slab or banner falls back to a baked grid at the field's cell size.
//
// That is not a quality nicety, it is the leak. The composited field gives thin
// geometry one occupancy shell per side so a wall's lit face and its shadowed
// face cannot mix, and that needs ~2 cells across the wall. A 42x20x28m
// auto-fit gets 0.34m cells, so a 5cm curtain or a 20cm wall has no way to be
// represented — the two faces collapse into one cell and indirect light walks
// straight through the building. An analytic primitive has NO resolution: a
// 5cm plane is exactly 5cm thick at any volume size.
//
// The SDFs themselves are the standard ones (iquilezles.org/articles/
// distfunctions); the hard part, and all this file does, is deciding WHICH
// primitive a pile of triangles actually is.
//
// CLASSIFY ON NORMALS, NOT POSITIONS. The first version of this tested whether
// vertices sit on the bounding box surface, and it accepted cylinders, cones
// and icosahedra: a cylinder's rim vertices sit at y = +/-h so they touch the
// box, and its four axis-aligned side vertices touch the remaining faces, so
// "every vertex is on the box, and all six faces are occupied" is true of a
// cylinder. Normals do not have that failure — a box's are all +/-axis, a
// cylinder's side normals are radial — and they also catch an OPEN shell (a
// crate missing its lid has no +X normal) where corner positions cannot,
// because every corner of a box touches three faces at once.
//
// The bar is deliberately asymmetric. A miss costs quality: the mesh bakes to
// a grid, exactly as before. A false positive replaces real geometry with a
// solid block and seals whatever was behind it.
//
// Fits box (sheets are boxes with a near-zero extent) and sphere, the two
// analytic kinds the atlas already evaluates on the GPU — so this needs no
// shader work. Cylinder/capsule/torus want new GPU kinds and are the obvious
// next step; the classifier is structured to grow.

/** Vertices actually examined. An even stride characterises a shape fine. */
const MAX_SAMPLES = 4096;
/** Fraction of samples that must satisfy a shape's test. Not 1.0: exporters
 *  weld, round, and leave the occasional stray vertex. */
const MIN_INLIER_RATIO = 0.99;
/** Slack on the surface equations, as a fraction of the half-extent. */
const SURFACE_TOLERANCE = 0.02;
/** cos of the angle a normal may stray from its axis (~8 degrees). */
const NORMAL_TOLERANCE = 0.99;
/** An axis this much smaller than the largest is "flat" — the mesh is a sheet. */
const FLAT_RATIO = 0.02;
/** Grid resolution for the sheet fill test. */
const FILL_BINS = 8;
/** Fraction of the sheet's bounding rectangle its triangles must actually
 *  cover. A quad covers 1.0; an L-shaped panel 0.75; a disc 0.79. */
const MIN_FILL = 0.95;

/**
 * @param {import("three").BufferGeometry} geometry
 * @returns {{type: "box"|"sphere", center: number[], half: number[]}|null}
 *   Local-space fit, or null when the geometry is not confidently a primitive.
 *   Caller supplies `hollow` and the world transform (see GISystem).
 */
export function fitPrimitive(geometry) {
  const position = geometry?.attributes?.position;
  const normal = geometry?.attributes?.normal;
  // No normals, no evidence — bake it. Computing them here would cost more
  // than the analytic path saves, and a wrong guess is expensive.
  if (!position || !normal || position.count < 4 || normal.count !== position.count) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) return null;

  const center = [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2];
  const half = [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2];
  const maxHalf = Math.max(half[0], half[1], half[2]);
  if (!(maxHalf > 0)) return null;

  const flat = half.map((h) => h <= maxHalf * FLAT_RATIO);
  const flatAxes = flat.filter(Boolean).length;
  // Two or three flat axes is a line or a point, not a surface.
  if (flatAxes > 1) return null;

  const stride = Math.max(1, Math.floor(position.count / MAX_SAMPLES));
  let sampled = 0;
  let axisNormals = 0; // normals aligned to a local axis (box evidence)
  let radialNormals = 0; // normals pointing away from centre (sphere evidence)
  let onBox = 0; // vertices on the bounding-box surface
  let onSphere = 0; // vertices on the inscribed sphere
  const axisSeen = [false, false, false, false, false, false]; // +x,-x,+y,-y,+z,-z

  for (let i = 0; i < position.count; i += stride) {
    const px = position.getX(i) - center[0];
    const py = position.getY(i) - center[1];
    const pz = position.getZ(i) - center[2];
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const nLen = Math.hypot(nx, ny, nz) || 1;

    // --- normal evidence ---
    const comps = [nx / nLen, ny / nLen, nz / nLen];
    let bestAxis = -1;
    let bestDot = 0;
    for (let a = 0; a < 3; a++) {
      const d = Math.abs(comps[a]);
      if (d > bestDot) {
        bestDot = d;
        bestAxis = a;
      }
    }
    if (bestDot >= NORMAL_TOLERANCE) {
      axisNormals++;
      axisSeen[bestAxis * 2 + (comps[bestAxis] > 0 ? 0 : 1)] = true;
    }
    const pLen = Math.hypot(px, py, pz);
    if (pLen > 1e-9) {
      const radial = (px * comps[0] + py * comps[1] + pz * comps[2]) / pLen;
      if (radial >= NORMAL_TOLERANCE) radialNormals++;
    }

    // --- position evidence ---
    let cheb = 0;
    let euclidSq = 0;
    for (let a = 0; a < 3; a++) {
      if (flat[a]) continue;
      const u = [px, py, pz][a] / half[a];
      const au = Math.abs(u);
      if (au > cheb) cheb = au;
      euclidSq += u * u;
    }
    if (cheb > 1 - SURFACE_TOLERANCE) onBox++;
    if (Math.abs(Math.sqrt(euclidSq) - 1) < SURFACE_TOLERANCE) onSphere++;
    sampled++;
  }
  if (sampled === 0) return null;

  // --- SPHERE ---
  // Radial normals AND vertices on the inscribed sphere. Checked before the
  // box because a sphere's poles/equator do touch the box; the converse never
  // happens (a box's corners sit at Euclidean sqrt(3), far off the sphere).
  if (
    flatAxes === 0 &&
    radialNormals / sampled >= MIN_INLIER_RATIO &&
    onSphere / sampled >= MIN_INLIER_RATIO
  ) {
    const minHalf = Math.min(half[0], half[1], half[2]);
    // Only ROUND spheres: the atlas stores one radius, so an ellipsoid would
    // read its largest axis in every direction (the scaled-sphere bug class).
    if (maxHalf / Math.max(minHalf, 1e-9) <= 1.02) {
      return { type: "sphere", center, half: [maxHalf, maxHalf, maxHalf] };
    }
    return null;
  }

  // Everything below is a box or a sheet: axis-aligned normals throughout.
  if (axisNormals / sampled < MIN_INLIER_RATIO) return null;
  if (onBox / sampled < MIN_INLIER_RATIO && flatAxes === 0) return null;

  if (flatAxes === 1) {
    const thin = flat.findIndex(Boolean);
    const wide = [0, 1, 2].filter((a) => a !== thin);
    // A sheet's normals must face its thin axis — otherwise it is a flat piece
    // of something else that merely happens to be thin.
    if (!axisSeen[thin * 2] && !axisSeen[thin * 2 + 1]) return null;
    // And its triangles must actually FILL the bounding rectangle, or an
    // L-shaped panel / a disc / a ring would be fitted as a full slab and
    // occlude space that is really open.
    if (fillRatio(geometry, center, half, wide) < MIN_FILL) return null;
    return { type: "box", center, half };
  }

  // A SOLID box shows all six axis directions among its normals. Without this
  // an open or hollow shell fits as a solid and seals whatever is inside it.
  if (axisSeen.every(Boolean)) return { type: "box", center, half };
  return null;
}

/**
 * Fraction of a sheet's bounding rectangle covered by its triangles, measured
 * by rasterising them into a coarse grid and counting occupied bins.
 *
 * Bin occupancy rather than summed triangle area on purpose: area double-counts
 * a sheet with both faces modelled (a 5cm box reads 2.0) and would let an
 * L-shaped double-sided panel through at 1.5. Occupancy is bounded at 1.0 and
 * says the thing we actually mean — "is the rectangle solid?".
 */
function fillRatio(geometry, center, half, wide) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const triCount = index ? index.count / 3 : position.count / 3;
  if (triCount < 1) return 0;
  const [a0, a1] = wide;
  const get = (i, axis) => (axis === 0 ? position.getX(i) : axis === 1 ? position.getY(i) : position.getZ(i));
  // Bin centres in normalised [0,1] rectangle coordinates.
  const bins = new Uint8Array(FILL_BINS * FILL_BINS);
  const toU = (v, axis) => (v - (center[axis] - half[axis])) / (2 * half[axis]);

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const x0 = toU(get(i0, a0), a0), y0 = toU(get(i0, a1), a1);
    const x1 = toU(get(i1, a0), a0), y1 = toU(get(i1, a1), a1);
    const x2 = toU(get(i2, a0), a0), y2 = toU(get(i2, a1), a1);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) * FILL_BINS));
    const maxX = Math.min(FILL_BINS - 1, Math.ceil(Math.max(x0, x1, x2) * FILL_BINS));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) * FILL_BINS));
    const maxY = Math.min(FILL_BINS - 1, Math.ceil(Math.max(y0, y1, y2) * FILL_BINS));
    for (let by = minY; by <= maxY; by++) {
      for (let bx = minX; bx <= maxX; bx++) {
        if (bins[by * FILL_BINS + bx]) continue;
        const cx = (bx + 0.5) / FILL_BINS;
        const cy = (by + 0.5) / FILL_BINS;
        // Barycentric inside test (sign-agnostic so winding does not matter).
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) bins[by * FILL_BINS + bx] = 1;
      }
    }
  }
  let filled = 0;
  for (let i = 0; i < bins.length; i++) filled += bins[i];
  return filled / bins.length;
}
