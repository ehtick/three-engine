/**
 * The extrude family and inset.
 *
 * Every entry point here creates the new topology at *zero offset* and returns
 * the vertices that should follow the mouse, so the editor can drive them with
 * the same interactive macro it uses for a plain move. Committing is then just
 * "stop moving", and cancelling is "restore the snapshot" — no operator needs a
 * separate preview path.
 */

import {
  addEdge,
  addFace,
  addVert,
  edgeOther,
  faceCenter,
  faceNormal,
  faceVerts,
  findEdge,
  isBoundaryEdge,
  killFace,
  vertFaces,
  vertNormal,
} from "../bmesh.js";
import { clearSelection, flushSelection, selected, selectedVerts } from "../select.js";
import { faceRegions } from "./edit.js";
import { affineUVSampler, setFaceUVProjection, updateProjectedUVs } from "./uv.js";

const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);

function normalize3(v) {
  const size = length3(v);
  return size < 1e-12 ? [0, 0, 1] : [v[0] / size, v[1] / size, v[2] / size];
}

/** Average of a set of face normals, normalised. */
function averageNormal(faces) {
  const sum = faces.reduce((acc, face) => add3(acc, faceNormal(face)), [0, 0, 0]);
  return length3(sum) < 1e-12 ? faceNormal(faces[0]) : normalize3(sum);
}


/**
 * Lays out UVs on the side quads an extrude, inset or bevel creates.
 *
 * These strips are built at zero size, so copying the source edge's UV to both
 * ends leaves a zero-area UV quad and the side renders as one stretched texel.
 * The fix is to grow the strip *away* from the edge it sprouted from, in UV
 * space, at the same texels-per-unit the neighbouring surface already uses:
 *
 *   base UVs   a, b        (the source edge's own corner UVs)
 *   density    |b - a| / |world edge length|
 *   far side   a + n * h * density,  b + n * h * density
 *
 * where `n` is the UV-space perpendicular of (b - a) and `h` is how far the
 * strip currently reaches. Matching the density is the part that matters:
 * mapping world units 1:1 instead made a checker on the new faces come out at a
 * completely different scale from the face beside it, which reads as "the UVs
 * are broken" even though every face had a perfectly good non-zero UV area.
 *
 * The base UVs are recorded on the face when it is created; without them the
 * function falls back to a 1:1 world mapping, which is better than nothing for
 * geometry that has no neighbouring UVs to match (a bridge between two islands).
 *
 * Corner order is the one every caller builds: [base0, base1, far1, far0].
 */
export function updateSideUVs(faces) {
  for (const face of faces ?? []) {
    if (!face || face.loops.length !== 4) continue;
    const [a, b, c, d] = face.loops;
    const along = sub3(b.v.co, a.v.co);
    const width = length3(along);
    const base = face.baseUV;

    if (base && width > 1e-9) {
      const [uvA, uvB] = base;
      const uvAlong = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
      const uvLength = Math.hypot(uvAlong[0], uvAlong[1]);
      if (uvLength > 1e-9) {
        const density = uvLength / width;
        const unit = [along[0] / width, along[1] / width, along[2] / width];
        const uvUnit = [uvAlong[0] / uvLength, uvAlong[1] / uvLength];
        const uvNormal = [-uvUnit[1], uvUnit[0]];
        // Each far corner is decomposed into how far it travelled *along* the
        // base edge and how far *away* from it, and both components are carried
        // into UV space at the same density. Treating the strip as a plain
        // rectangle instead over-counts the reach whenever the corners move
        // diagonally — which is exactly what an inset does, and it came out
        // nearly twice as dense as the face beside it.
        const place = (corner, origin, uvOrigin) => {
          const offset = sub3(corner.v.co, origin.v.co);
          const forward = dot3(offset, unit);
          const sideways = length3(sub3(offset, scale3(unit, forward)));
          corner.uv = [
            uvOrigin[0] + (uvUnit[0] * forward + uvNormal[0] * sideways) * density,
            uvOrigin[1] + (uvUnit[1] * forward + uvNormal[1] * sideways) * density,
          ];
        };
        a.uv = [uvA[0], uvA[1]];
        b.uv = [uvB[0], uvB[1]];
        place(d, a, uvA);
        place(c, b, uvB);
        continue;
      }
    }

    // No neighbouring UVs to continue from: fall back to a 1:1 world mapping.
    const height = (length3(sub3(d.v.co, a.v.co)) + length3(sub3(c.v.co, b.v.co))) * 0.5;
    a.uv = [0, 0];
    b.uv = [width, 0];
    c.uv = [width, height];
    d.uv = [0, height];
  }
}

/**
 * Re-reads the UVs of faces that kept their topology while their corners moved
 * (an inset's caps), from the mapping recorded when they were built.
 */
export const updateCapUVs = updateProjectedUVs;

/** Records the source edge UVs a side strip should continue from. */
export function setSideBaseUV(face, uvA, uvB) {
  if (face) face.baseUV = [[uvA[0], uvA[1]], [uvB[0], uvB[1]]];
  return face;
}

/* -------------------------------------------------------------------------- */
/* Extrude faces (region)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Extrude Region: lifts the selected face region off the surface, walling in
 * the boundary. The original faces are removed — their footprint becomes the
 * side walls — and the region is rebuilt on fresh, duplicated vertices.
 *
 * Interior vertices of the region are duplicated once and shared, so extruding
 * a 3x3 patch produces one connected cap rather than nine loose quads.
 */
export function extrudeFaceRegion(mesh, faces = selected(mesh, "face")) {
  if (!faces.length) return { error: "Select faces to extrude" };
  const region = new Set(faces);
  const copies = new Map();
  const copyOf = (vert) => {
    if (!copies.has(vert)) copies.set(vert, addVert(mesh, vert.co));
    return copies.get(vert);
  };

  // Boundary edges of the region: exactly one adjacent face inside it. Those
  // get walls; interior edges just move with the cap.
  const boundary = [];
  for (const face of region) {
    for (const loop of face.loops) {
      const inside = loop.e.loops.filter((other) => region.has(other.f)).length;
      if (inside === 1) {
        const next = face.loops[(loop.index + 1) % face.loops.length];
        boundary.push({ from: loop.v, to: next.v, material: face.material, smooth: face.smooth, uv: [...loop.uv], nextUV: [...next.uv] });
      }
    }
  }

  const rebuilds = [...region].map((face) => ({
    ring: faceVerts(face).map(copyOf),
    uvs: face.loops.map((loop) => [...loop.uv]),
    material: face.material,
    smooth: face.smooth,
    face,
  }));
  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);

  const caps = [];
  for (const rebuild of rebuilds) {
    const cap = addFace(mesh, rebuild.ring, { material: rebuild.material, smooth: rebuild.smooth, uvs: rebuild.uvs });
    if (cap) {
      cap.select = true;
      caps.push(cap);
    }
  }
  // Walls are wound from the original boundary edge to its copy, which keeps
  // them facing outward for any consistently wound source region.
  const walls = [];
  for (const entry of boundary) {
    // Walls continue the surface they grew from, so they take its shading too.
    // `addFace` defaults to smooth, and a smooth wall on a flat-shaded box
    // renders as a dark gradient bending around the corner — which reads as
    // "the UVs broke" even though the UVs are untouched.
    const wall = addFace(mesh, [entry.from, entry.to, copyOf(entry.to), copyOf(entry.from)], { material: entry.material, smooth: entry.smooth });
    if (wall) walls.push(setSideBaseUV(wall, entry.uv, entry.nextUV));
  }
  updateSideUVs(walls);

  clearSelection(mesh);
  for (const cap of caps) cap.select = true;
  flushSelection(mesh, "face");
  return {
    verts: [...copies.values()],
    faces: caps,
    walls,
    sides: walls,
    normal: caps.length ? averageNormal(caps) : [0, 0, 1],
  };
}

/**
 * Extrude Individual Faces: every selected face gets its own cap and its own
 * four walls, so a cube's six faces spread apart instead of forming one block.
 */
export function extrudeFacesIndividual(mesh, faces = selected(mesh, "face")) {
  if (!faces.length) return { error: "Select faces to extrude" };
  const moving = [];
  const caps = [];
  const sides = [];
  for (const face of faces) {
    const ring = faceVerts(face);
    const uvs = face.loops.map((loop) => [...loop.uv]);
    const copies = ring.map((vert) => addVert(mesh, vert.co));
    const material = face.material;
    const smooth = face.smooth;
    killFace(mesh, face);
    const cap = addFace(mesh, copies, { material, smooth, uvs });
    if (cap) {
      caps.push(cap);
      moving.push(...copies);
    }
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const side = addFace(mesh, [ring[index], ring[next], copies[next], copies[index]], { material, smooth });
      if (side) sides.push(setSideBaseUV(side, uvs[index], uvs[next]));
    }
  }
  updateSideUVs(sides);
  clearSelection(mesh);
  for (const cap of caps) cap.select = true;
  flushSelection(mesh, "face");
  return {
    verts: moving,
    faces: caps,
    sides,
    individualNormals: new Map(caps.flatMap((cap) => faceVerts(cap).map((vert) => [vert, faceNormal(cap)]))),
    normal: caps.length ? averageNormal(caps) : [0, 0, 1],
  };
}

/**
 * Extrude Along Normals: like a region extrude, but each vertex travels along
 * its own averaged normal so a curved patch thickens evenly instead of
 * shearing. The returned per-vertex offsets are unit length.
 */
export function extrudeAlongNormals(mesh, faces = selected(mesh, "face")) {
  const result = extrudeFaceRegion(mesh, faces);
  if (result.error) return result;
  const offsets = new Map();
  for (const vert of result.verts) offsets.set(vert, vertNormal(vert));
  return { ...result, perVertexOffsets: offsets };
}

/* -------------------------------------------------------------------------- */
/* Extrude edges and verts                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extrude Edges: each selected edge grows a quad. Shared endpoints are
 * duplicated once, so extruding a chain produces a connected ribbon.
 */
export function extrudeEdges(mesh, edges = selected(mesh, "edge")) {
  if (!edges.length) return { error: "Select edges to extrude" };
  const copies = new Map();
  const copyOf = (vert) => {
    if (!copies.has(vert)) copies.set(vert, addVert(mesh, vert.co));
    return copies.get(vert);
  };
  const created = [];
  const normal = [0, 0, 0];
  for (const edge of edges) {
    const material = edge.loops[0]?.f.material ?? 0;
    // Wind against the existing face so the new quad continues the surface
    // rather than facing back into it.
    const loop = edge.loops[0];
    const forward = loop ? loop.v === edge.v2 : true;
    const [a, b] = forward ? [edge.v1, edge.v2] : [edge.v2, edge.v1];
    const face = addFace(mesh, [a, b, copyOf(b), copyOf(a)], { material, smooth: loop?.f.smooth ?? true });
    if (face) {
      created.push(face);
      if (loop) {
        const next = loop.f.loops[(loop.index + 1) % loop.f.loops.length];
        setSideBaseUV(face, forward ? loop.uv : next.uv, forward ? next.uv : loop.uv);
      }
      updateSideUVs([face]);
      const contribution = faceNormal(face);
      normal[0] += contribution[0];
      normal[1] += contribution[1];
      normal[2] += contribution[2];
    }
  }
  clearSelection(mesh);
  for (const vert of copies.values()) vert.select = true;
  flushSelection(mesh, "vert");
  // Selecting the far edges is what lets a second E continue the ribbon.
  for (const edge of mesh.edges) edge.select = copies.has(edge.v1) && copies.has(edge.v2) && edge.loops.length <= 1;
  return {
    verts: [...copies.values()],
    faces: created,
    sides: created,
    normal: length3(normal) < 1e-12 ? [0, 0, 1] : normalize3(normal),
  };
}

/** Extrude Vertices: each selected vert grows a wire edge to a fresh copy. */
export function extrudeVerts(mesh, verts = selectedVerts(mesh, "vert")) {
  if (!verts.length) return { error: "Select vertices to extrude" };
  const created = [];
  for (const vert of verts) {
    const copy = addVert(mesh, vert.co);
    addEdge(mesh, vert, copy);
    created.push(copy);
  }
  clearSelection(mesh);
  for (const vert of created) vert.select = true;
  flushSelection(mesh, "vert");
  return { verts: created, faces: [], normal: [0, 0, 1] };
}

/* -------------------------------------------------------------------------- */
/* Inset                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The largest inset thickness this ring can take before it collapses.
 *
 * Each border edge shrinks as the ring moves inward; past the point where one
 * of them reaches zero length the cap turns inside out and grows again, which
 * on screen reads as the face vanishing and then reappearing mirrored. Solving
 * for the first edge to reach zero gives the limit.
 *
 * For an edge from p to q whose corners travel along d_p and d_q, the length
 * along the original direction u is |q-p| + ((d_q - d_p) . u) t, so it hits zero
 * at t = |q-p| / -((d_q - d_p) . u) whenever that dot product is negative.
 */
function insetLimit(ring, directions) {
  let limit = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    const along = sub3(ring[next].co, ring[index].co);
    const span = length3(along);
    if (span < 1e-9) continue;
    const unit = [along[0] / span, along[1] / span, along[2] / span];
    const closing = dot3(sub3(directions[next], directions[index]), unit);
    if (closing >= -1e-9) continue; // this edge is not shrinking
    limit = Math.min(limit, span / -closing);
  }
  return Number.isFinite(limit) ? limit : 0;
}

/**
 * Shrinks a ring toward its own centre by `thickness` in world units, measured
 * perpendicular to each boundary edge. Working in world units rather than as a
 * fraction is what makes an inset on a large face and a small one look like the
 * same operation, which is how Blender behaves.
 */
function insetRing(ring, thickness, normal) {
  const center = ring.reduce((acc, vert) => add3(acc, vert.co), [0, 0, 0]).map((value) => value / ring.length);
  return ring.map((vert, index) => {
    const previous = ring[(index + ring.length - 1) % ring.length].co;
    const next = ring[(index + 1) % ring.length].co;
    // Inward normals of the two edges meeting at this corner, in the face plane.
    const inward = (from, to) => {
      const along = normalize3(sub3(to, from));
      const side = [
        normal[1] * along[2] - normal[2] * along[1],
        normal[2] * along[0] - normal[0] * along[2],
        normal[0] * along[1] - normal[1] * along[0],
      ];
      const toCenter = sub3(center, from);
      return dot3(side, toCenter) < 0 ? scale3(side, -1) : side;
    };
    const first = inward(previous, vert.co);
    const second = inward(vert.co, next);
    const bisector = add3(first, second);
    const size = length3(bisector);
    if (size < 1e-9) return [...vert.co];
    const unit = scale3(bisector, 1 / size);
    // Miter: scale so the corner still lands `thickness` from both edges.
    const miter = Math.max(dot3(unit, first), 0.1);
    return add3(vert.co, scale3(unit, thickness / miter));
  });
}

/**
 * Inset Faces (I). Returns the inner vertices and, for each, the direction it
 * travels per unit of thickness, so the interactive macro can re-solve the
 * inset as the mouse moves without rebuilding topology every frame.
 *
 * `individual` is Blender's I-I: every face insets inside its own border.
 */
export function insetFaces(mesh, faces = selected(mesh, "face"), { individual = false } = {}) {
  if (!faces.length) return { error: "Select faces to inset" };
  const groups = individual ? faces.map((face) => [face]) : faceRegions(faces);
  const inner = [];
  const directions = new Map();
  const caps = [];
  const sides = [];
  let limit = Infinity;

  for (const group of groups) {
    const region = new Set(group);
    const boundaryLoops = [];
    for (const face of region) {
      for (const loop of face.loops) {
        const inside = loop.e.loops.filter((other) => region.has(other.f)).length;
        if (inside === 1) boundaryLoops.push(loop);
      }
    }
    if (boundaryLoops.length < 3) continue;
    // Order the border into a ring by chaining each loop to the one starting
    // where it ends.
    const bySource = new Map();
    for (const loop of boundaryLoops) bySource.set(loop.v, loop);
    const ring = [];
    const ringUVs = [];
    const ringFaces = [];
    let current = boundaryLoops[0];
    for (let step = 0; step < boundaryLoops.length; step++) {
      ring.push(current.v);
      ringUVs.push([...current.uv]);
      ringFaces.push(current.f);
      const next = bySource.get(current.f.loops[(current.index + 1) % current.f.loops.length].v);
      if (!next || next === boundaryLoops[0]) break;
      current = next;
    }
    if (ring.length !== boundaryLoops.length || new Set(ring).size !== ring.length) continue;

    const normal = averageNormal(group);
    const target = insetRing(ring, 1, normal);
    const offsets = ring.map((vert, index) => sub3(target[index], vert.co));
    // The tightest limit across all regions is what the caller may drag to.
    limit = Math.min(limit, insetLimit(ring, offsets));
    const copies = ring.map((vert) => addVert(mesh, vert.co));
    ring.forEach((vert, index) => directions.set(copies[index], offsets[index]));
    inner.push(...copies);

    const rebuilds = group.map((face) => ({
      ring: faceVerts(face).map((vert) => {
        const at = ring.indexOf(vert);
        return at >= 0 ? copies[at] : vert;
      }),
      uvs: face.loops.map((loop) => [...loop.uv]),
      // The mapping the cap has to keep answering to as the ring travels
      // inward. Captured before `killFace` empties the face's loops.
      sampler: affineUVSampler(face),
      material: face.material,
      smooth: face.smooth,
      face,
    }));
    for (const rebuild of rebuilds) killFace(mesh, rebuild.face);
    for (const rebuild of rebuilds) {
      const cap = addFace(mesh, rebuild.ring, { material: rebuild.material, smooth: rebuild.smooth, uvs: rebuild.uvs });
      if (cap) {
        // A cap that kept the whole face's UV range while shrinking to a
        // fraction of its area is the "inset ruins the UVs" report: the texture
        // gets squeezed into the smaller face instead of staying put. Re-read
        // from the original mapping each frame instead — see `updateCapUVs`.
        setFaceUVProjection(cap, rebuild.sampler);
        caps.push(cap);
      }
    }
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const side = addFace(mesh, [ring[index], ring[next], copies[next], copies[index]], {
        material: ringFaces[index].material,
        smooth: ringFaces[index].smooth,
      });
      if (side) sides.push(setSideBaseUV(side, ringUVs[index], ringUVs[next]));
    }
  }
  updateSideUVs(sides);
  updateCapUVs(caps);

  if (!caps.length) return { error: "Could not inset that selection" };
  clearSelection(mesh);
  for (const cap of caps) cap.select = true;
  flushSelection(mesh, "face");
  return {
    verts: inner,
    faces: caps,
    sides,
    // The panel re-reads these every macro frame, the same way it re-measures
    // the side strips: an inset's thickness is still changing while it drags.
    reprojected: caps,
    perVertexOffsets: directions,
    // Just inside the collapse point, so the cap always keeps a little area.
    maxThickness: Number.isFinite(limit) ? limit * 0.97 : 0,
    normal: averageNormal(caps),
  };
}

/* -------------------------------------------------------------------------- */

/** Blender's Alt+S: move each selected vert along its own normal. */
export function shrinkFattenOffsets(mesh, mode) {
  const offsets = new Map();
  for (const vert of selectedVerts(mesh, mode)) offsets.set(vert, vertNormal(vert));
  return offsets;
}

/** True when the selection touches an open boundary, used to warn on extrude. */
export function selectionTouchesBoundary(mesh) {
  for (const edge of mesh.edges) if (edge.select && isBoundaryEdge(edge)) return true;
  return false;
}

export { faceCenter, findEdge, edgeOther, vertFaces };
