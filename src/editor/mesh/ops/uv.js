/**
 * UV projection.
 *
 * UVs live on loops, not vertices, so a projection writes per face corner and a
 * seam costs nothing: two faces meeting at an edge can hold entirely different
 * coordinates for the same vertex. The old vertex-keyed layout had to duplicate
 * geometry to express that, which is why box unwrapping used to shatter the
 * mesh into disconnected triangles.
 */

import { faceNormal, vertFaces } from "../bmesh.js";
import { selected } from "../select.js";

const AXIS_PAIRS = { x: [2, 1], y: [0, 2], z: [0, 1] };
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Rescales every written UV into 0..1 so the projection fills the tile. */
function normalizeLoops(entries) {
  if (!entries.length) return;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const [, uv] of entries) {
    minU = Math.min(minU, uv[0]);
    maxU = Math.max(maxU, uv[0]);
    minV = Math.min(minV, uv[1]);
    maxV = Math.max(maxV, uv[1]);
  }
  const spanU = maxU - minU || 1;
  const spanV = maxV - minV || 1;
  for (const [loop, uv] of entries) {
    loop.uv = [(uv[0] - minU) / spanU, (uv[1] - minV) / spanV];
  }
}

/** Flat projection down one axis, across the whole mesh or the selection. */
export function unwrapPlanar(mesh, axis = "z", faces = null) {
  const [u, v] = AXIS_PAIRS[axis] ?? AXIS_PAIRS.z;
  const scope = faces?.length ? faces : [...mesh.faces];
  const entries = [];
  for (const face of scope) {
    for (const loop of face.loops) entries.push([loop, [loop.v.co[u], loop.v.co[v]]]);
  }
  normalizeLoops(entries);
  return entries.length;
}

/**
 * Box projection: each face is flattened down whichever axis its normal points
 * along most strongly, and every face is scaled by the *same* factor.
 *
 * The shared scale is the point. Normalising each axis group into its own 0..1
 * range — or worse, normalising all of them together into one shared box —
 * gives neighbouring faces different texel densities, so a checker comes out a
 * different size on each side of an edge. That is what a "broken" cube
 * projection looks like even though every face has a perfectly valid mapping.
 *
 * With one scale derived from the mesh's longest axis, a cube's six faces each
 * fill the tile exactly, which is what a box projection is expected to produce.
 */
export function unwrapBox(mesh, faces = null) {
  const scope = faces?.length ? faces : [...mesh.faces];
  if (!scope.length) return 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const face of scope) {
    for (const loop of face.loops) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], loop.v.co[axis]);
        max[axis] = Math.max(max[axis], loop.v.co[axis]);
      }
    }
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const scale = 1 / extent;
  let count = 0;
  for (const face of scope) {
    const normal = faceNormal(face);
    const absolute = normal.map(Math.abs);
    const axis = absolute[0] >= absolute[1] && absolute[0] >= absolute[2] ? "x" : absolute[1] >= absolute[2] ? "y" : "z";
    const [u, v] = AXIS_PAIRS[axis];
    for (const loop of face.loops) {
      loop.uv = [(loop.v.co[u] - min[u]) * scale, (loop.v.co[v] - min[v]) * scale];
      count++;
    }
  }
  return count;
}

/** Projects from the current view direction, Blender's Project From View. */
export function unwrapFromView(mesh, right, up, faces = null) {
  const scope = faces?.length ? faces : [...mesh.faces];
  const entries = [];
  for (const face of scope) {
    for (const loop of face.loops) {
      const co = loop.v.co;
      entries.push([loop, [
        co[0] * right[0] + co[1] * right[1] + co[2] * right[2],
        co[0] * up[0] + co[1] * up[1] + co[2] * up[2],
      ]]);
    }
  }
  normalizeLoops(entries);
  return entries.length;
}

/**
 * A fresh 0..1 planar mapping for a ring of vertices, projected onto the ring's
 * own best-fit plane.
 *
 * Used for faces created from vertices that carry no usable UV of their own —
 * a filled hole, a grid fill, a face made with F, a bevel's corner cap.
 *
 * Inheriting a UV from a neighbouring face sounds better and is worse: on a box
 * each side is its own island, so the four corners of a hole inherit from four
 * *different* islands and land collinear, which is a zero-area mapping — the
 * same "flattened texture" symptom as no UVs at all. A self-contained planar
 * mapping is always well formed; it just may not line up with the neighbouring
 * island, so callers should say "re-unwrap if you need it to match".
 */
export function planarRingUVs(verts) {
  if (!verts?.length) return [];
  const points = verts.map((vert) => vert.co);
  // Newell normal of the ring.
  const normal = [0, 0, 0];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const size = Math.hypot(...normal) || 1;
  const unit = normal.map((value) => value / size);
  const reference = Math.abs(unit[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const axisU = [
    reference[1] * unit[2] - reference[2] * unit[1],
    reference[2] * unit[0] - reference[0] * unit[2],
    reference[0] * unit[1] - reference[1] * unit[0],
  ];
  const scale = Math.hypot(...axisU) || 1;
  const u = axisU.map((value) => value / scale);
  const v = [
    unit[1] * u[2] - unit[2] * u[1],
    unit[2] * u[0] - unit[0] * u[2],
    unit[0] * u[1] - unit[1] * u[0],
  ];
  const flat = points.map((point) => [
    point[0] * u[0] + point[1] * u[1] + point[2] * u[2],
    point[0] * v[0] + point[1] * v[1] + point[2] * v[2],
  ]);
  const minU = Math.min(...flat.map((entry) => entry[0]));
  const maxU = Math.max(...flat.map((entry) => entry[0]));
  const minV = Math.min(...flat.map((entry) => entry[1]));
  const maxV = Math.max(...flat.map((entry) => entry[1]));
  const spanU = maxU - minU || 1;
  const spanV = maxV - minV || 1;
  return flat.map((entry) => [(entry[0] - minU) / spanU, (entry[1] - minV) / spanV]);
}

/* -------------------------------------------------------------------------- */
/* Carrying an existing mapping onto new geometry                              */
/* -------------------------------------------------------------------------- */

/**
 * A face's own UV mapping, as a function of position.
 *
 * This is what makes a topological operator texture-transparent. Inset, bevel
 * and their kin move a face's corners; Blender answers "what UV does this new
 * position have" by evaluating the mapping the face already had, so the texture
 * stays welded to the surface. Copying the UV of the corner that moved instead
 * leaves the same UV range covering less surface, which shows up as the texture
 * shrinking into the smaller face — the "inset/bevel ruins the UVs" report.
 *
 * Everything is captured eagerly, so the sampler keeps describing the mapping
 * as it was when it was taken even after the face has been killed or its
 * vertices moved. A point off the face's plane gets the mapping's value at its
 * projection onto that plane, which is what a bevel's corner cap wants.
 *
 * Returns a function yielding null for a face whose corners are collinear or
 * whose UVs are degenerate, so callers can fall back.
 */
export function affineUVSampler(face) {
  const loops = face?.loops ?? [];
  if (loops.length < 3) return () => null;
  const originCo = [...loops[0].v.co];
  const originUV = [...loops[0].uv];
  let first = null;
  let second = null;
  for (let index = 1; index < loops.length; index++) {
    const candidate = sub3(loops[index].v.co, originCo);
    if (length3(candidate) < 1e-12) continue;
    if (!first) {
      first = { vector: candidate, uv: [...loops[index].uv] };
      continue;
    }
    if (length3(cross3(first.vector, candidate)) > 1e-12) {
      second = { vector: candidate, uv: [...loops[index].uv] };
      break;
    }
  }
  if (!first || !second) return () => null;

  const g00 = dot3(first.vector, first.vector);
  const g01 = dot3(first.vector, second.vector);
  const g11 = dot3(second.vector, second.vector);
  const determinant = g00 * g11 - g01 * g01;
  if (Math.abs(determinant) < 1e-18) return () => null;

  const du1 = [first.uv[0] - originUV[0], first.uv[1] - originUV[1]];
  const du2 = [second.uv[0] - originUV[0], second.uv[1] - originUV[1]];
  if (Math.hypot(...du1) < 1e-12 && Math.hypot(...du2) < 1e-12) return () => null;
  return (point) => {
    const offset = sub3(point, originCo);
    const p = dot3(offset, first.vector);
    const q = dot3(offset, second.vector);
    const a = (p * g11 - q * g01) / determinant;
    const b = (q * g00 - p * g01) / determinant;
    return [originUV[0] + a * du1[0] + b * du2[0], originUV[1] + a * du1[1] + b * du2[1]];
  };
}

/**
 * Remembers the mapping a face's corners should be re-read from while they
 * move, and re-reads it.
 *
 * Inset is interactive: the ring keeps travelling for as long as the drag
 * lasts, so a UV worked out once when the topology was created is stale one
 * frame later. This is the cap's counterpart to `updateSideUVs` — the panel
 * calls it every macro frame.
 */
export function setFaceUVProjection(face, source) {
  if (face) face.uvProject = typeof source === "function" ? source : affineUVSampler(source);
  return face;
}

export function updateProjectedUVs(faces) {
  for (const face of faces ?? []) {
    const sampler = face?.uvProject;
    if (!sampler || !face.loops.length) continue;
    for (const loop of face.loops) {
      const uv = sampler(loop.v.co);
      if (uv) loop.uv = uv;
    }
  }
}

/**
 * UVs for a ring of new vertices, continued from whichever surrounding face
 * already maps them.
 *
 * A bevel's corner patch is the case this exists for. `planarRingUVs` would
 * give it a fresh 0..1 tile, which is a *valid* mapping and a wrong one: a
 * 2 cm corner then carries the entire texture, tens of times denser than the
 * surface around it. Extending one neighbour's mapping across the patch keeps
 * both the density and the position continuous along that neighbour.
 *
 * One neighbour, not several: the ring's vertices generally belong to different
 * UV islands (three sides of a cube corner), and blending islands lands their
 * corners on top of each other. The neighbour sharing the most vertices wins,
 * which prefers a bevel strip over the flat face beyond it.
 */
export function ringUVsFromNeighbour(ring, { exclude = null } = {}) {
  const members = new Set(ring);
  const scores = new Map();
  for (const vert of ring) {
    for (const face of vertFaces(vert)) {
      if (exclude?.has(face)) continue;
      scores.set(face, (scores.get(face) ?? 0) + 1);
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  for (const [face] of ranked) {
    // A face made only of ring vertices describes the ring's own plane, not the
    // surface it should continue from.
    if (face.loops.every((loop) => members.has(loop.v))) continue;
    const sampler = affineUVSampler(face);
    const uvs = ring.map((vert) => sampler(vert.co));
    if (uvs.every(Boolean)) return uvs;
  }
  return null;
}

/** Convenience wrapper used by the panel's UV menu. */
export const unwrapSelection = (mesh, kind, mode) => {
  const faces = selected(mesh, "face");
  const scope = mode === "face" && faces.length ? faces : null;
  return kind === "box" ? unwrapBox(mesh, scope) : unwrapPlanar(mesh, "z", scope);
};
