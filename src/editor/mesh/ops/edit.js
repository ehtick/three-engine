/**
 * The everyday edit-mode operators: make edge/face, the delete and dissolve
 * families, the merge family, rip, split, separate and duplicate.
 *
 * Everything here works on polygons directly. Under the old triangle model most
 * of these were either impossible (dissolve, limited dissolve, rip) or had to
 * be approximated by deleting triangles and hoping the hidden-diagonal
 * bookkeeping agreed afterwards.
 */

import {
  addEdge,
  addFace,
  addVert,
  dissolveEdge,
  dissolveVertEdgeChain,
  edgeFaceAngle,
  edgeOther,
  faceCenter,
  faceNormal,
  faceVerts,
  findEdge,
  flipFace,
  isBoundaryEdge,
  killEdge,
  killFace,
  killVert,
  splitFace,
  vertFaces,
  weldVerts,
} from "../bmesh.js";
import { clearSelection, flushSelection, selected, selectedVerts } from "../select.js";
import { planarRingUVs } from "./uv.js";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The outer boundary of a connected face region, as an ordered vertex ring with
 * matching per-corner UVs. Returns null when the region's border is not a
 * single closed cycle — a region with a hole, or one that pinches at a vertex,
 * cannot become one n-gon and callers must leave it alone.
 */
export function faceRegionRing(faces) {
  const region = new Set(faces);
  const directed = [];
  for (const face of region) {
    for (const loop of face.loops) {
      const shared = loop.e.loops.some((other) => other.f !== face && region.has(other.f));
      if (shared) continue;
      const next = face.loops[(loop.index + 1) % face.loops.length];
      directed.push({ from: loop.v, to: next.v, uv: [...loop.uv] });
    }
  }
  if (directed.length < 3) return null;
  const bySource = new Map();
  for (const entry of directed) {
    if (!bySource.has(entry.from)) bySource.set(entry.from, []);
    bySource.get(entry.from).push(entry);
  }
  if ([...bySource.values()].some((entries) => entries.length > 1)) return null; // pinch point
  const start = directed[0];
  const verts = [];
  const uvs = [];
  let current = start;
  for (let step = 0; step < directed.length; step++) {
    verts.push(current.from);
    uvs.push(current.uv);
    const next = bySource.get(current.to)?.[0];
    if (!next) return null;
    if (next === start) break;
    current = next;
  }
  if (verts.length !== directed.length) return null;
  if (new Set(verts).size !== verts.length) return null;
  return { verts, uvs };
}

/** Connected components of a face set, linked through shared edges. */
export function faceRegions(faces) {
  const remaining = new Set(faces);
  const regions = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const region = [seed];
    const queue = [seed];
    while (queue.length) {
      const face = queue.pop();
      for (const loop of face.loops) {
        for (const other of loop.e.loops) {
          if (!remaining.delete(other.f)) continue;
          region.push(other.f);
          queue.push(other.f);
        }
      }
    }
    regions.push(region);
  }
  return regions;
}

const centroid = (verts) => {
  const sum = [0, 0, 0];
  for (const vert of verts) {
    sum[0] += vert.co[0];
    sum[1] += vert.co[1];
    sum[2] += vert.co[2];
  }
  return sum.map((value) => value / Math.max(verts.length, 1));
};

/* -------------------------------------------------------------------------- */
/* Make edge / face (F)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Orders a loose vertex set into a ring.
 *
 * When the verts already form a single chain or cycle of existing edges, that
 * order is used — it is what the user drew and it handles concave rings
 * correctly. Otherwise the ring is sorted by angle around the best-fit plane,
 * which is what Blender falls back to for a bare vertex selection.
 */
function orderRing(verts) {
  const set = new Set(verts);
  const adjacency = new Map(verts.map((vert) => [vert, [...vert.edges].map((edge) => edgeOther(edge, vert)).filter((other) => set.has(other))]));
  const degrees = [...adjacency.values()].map((list) => list.length);
  const chainable = degrees.every((degree) => degree === 2) || degrees.filter((degree) => degree === 1).length === 2;
  if (chainable && degrees.every((degree) => degree >= 1 && degree <= 2)) {
    const start = verts.find((vert) => adjacency.get(vert).length === 1) ?? verts[0];
    const ring = [start];
    const visited = new Set([start]);
    let current = start;
    while (ring.length < verts.length) {
      const next = adjacency.get(current).find((candidate) => !visited.has(candidate));
      if (!next) break;
      visited.add(next);
      ring.push(next);
      current = next;
    }
    if (ring.length === verts.length) return ring;
  }
  const center = centroid(verts);
  let normal = [0, 0, 0];
  for (let index = 0; index < verts.length; index++) {
    const current = verts[index].co;
    const next = verts[(index + 1) % verts.length].co;
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = Math.hypot(...normal) || 1;
  normal = normal.map((value) => value / length);
  const reference = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const axisX = [
    reference[1] * normal[2] - reference[2] * normal[1],
    reference[2] * normal[0] - reference[0] * normal[2],
    reference[0] * normal[1] - reference[1] * normal[0],
  ];
  const scale = Math.hypot(...axisX) || 1;
  const unitX = axisX.map((value) => value / scale);
  const unitY = [
    normal[1] * unitX[2] - normal[2] * unitX[1],
    normal[2] * unitX[0] - normal[0] * unitX[2],
    normal[0] * unitX[1] - normal[1] * unitX[0],
  ];
  return [...verts].sort((a, b) => {
    const angleOf = (vert) => {
      const delta = [vert.co[0] - center[0], vert.co[1] - center[1], vert.co[2] - center[2]];
      return Math.atan2(
        delta[0] * unitY[0] + delta[1] * unitY[1] + delta[2] * unitY[2],
        delta[0] * unitX[0] + delta[1] * unitX[1] + delta[2] * unitX[2],
      );
    };
    return angleOf(a) - angleOf(b);
  });
}

/**
 * Blender's F. Two verts become an edge; a closed or nearly closed ring of
 * verts or edges becomes a face. Returns a short report for the status line.
 */
export function makeEdgeFace(mesh, mode) {
  const verts = selectedVerts(mesh, mode);
  if (verts.length < 2) return { error: "Select at least two vertices" };
  if (verts.length === 2) {
    const [a, b] = verts;
    if (findEdge(a, b)) return { error: "Those vertices are already connected" };
    const edge = addEdge(mesh, a, b);
    clearSelection(mesh);
    edge.select = true;
    flushSelection(mesh, "edge");
    return { created: "edge", edge };
  }
  const ring = orderRing(verts);
  if (ring.length < 3) return { error: "Could not order the selection into a ring" };
  const existing = [...mesh.faces].find(
    (face) => face.loops.length === ring.length && new Set(faceVerts(face)).size === ring.length && faceVerts(face).every((vert) => ring.includes(vert)),
  );
  if (existing) return { error: "A face already spans that selection" };
  // A fresh planar mapping. See planarRingUVs for why inheriting a neighbour's
  // UV is worse than it sounds.
  let face = addFace(mesh, ring, { uvs: planarRingUVs(ring) });
  if (!face) return { error: "Could not build a face from that selection" };
  // Match the surrounding surface rather than the arbitrary winding of the
  // ring, so a face filled into a hole does not come out inside on.
  //
  // The test is the shared edge, not the neighbour's normal: two consistently
  // wound faces traverse their shared edge in *opposite* directions. Comparing
  // normals instead would misjudge any neighbour meeting at a sharp angle.
  const shared = face.loops.find((loop) => loop.e.loops.length === 2);
  if (shared) {
    const neighbour = shared.e.loops.find((loop) => loop.f !== face);
    if (neighbour && neighbour.v === shared.v) face = flipFace(mesh, face) ?? face;
  }
  clearSelection(mesh);
  face.select = true;
  flushSelection(mesh, "face");
  return { created: "face", face };
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

export const DELETE_MODES = [
  { id: "verts", label: "Vertices" },
  { id: "edges", label: "Edges" },
  { id: "faces", label: "Faces" },
  { id: "onlyFaces", label: "Only Faces" },
  { id: "edgesFaces", label: "Only Edges & Faces" },
];

/** Blender's X menu. Returns how many elements were removed. */
export function deleteSelection(mesh, mode, kind = "verts") {
  let removed = 0;
  if (kind === "verts") {
    for (const vert of selectedVerts(mesh, mode)) {
      killVert(mesh, vert);
      removed++;
    }
  } else if (kind === "edges") {
    for (const edge of selected(mesh, "edge")) {
      killEdge(mesh, edge);
      removed++;
    }
    // Blender leaves the verts, but drops any that nothing references anymore.
    for (const vert of [...mesh.verts]) if (!vert.edges.size) mesh.verts.delete(vert);
  } else if (kind === "faces") {
    const doomed = selected(mesh, "face");
    const touched = new Set();
    for (const face of doomed) {
      for (const loop of face.loops) {
        touched.add(loop.e);
        touched.add(loop.v);
      }
      killFace(mesh, face);
      removed++;
    }
    // Only sweep away the edges and verts those faces exclusively owned.
    for (const element of touched) {
      if (mesh.edges.has(element) && !element.loops.length) killEdge(mesh, element);
    }
    for (const element of touched) {
      if (mesh.verts.has(element) && !element.edges.size) mesh.verts.delete(element);
    }
  } else if (kind === "onlyFaces") {
    for (const face of selected(mesh, "face")) {
      killFace(mesh, face);
      removed++;
    }
  } else if (kind === "edgesFaces") {
    for (const face of selected(mesh, "face")) killFace(mesh, face);
    for (const edge of selected(mesh, "edge")) {
      killEdge(mesh, edge);
      removed++;
    }
  }
  clearSelection(mesh);
  return removed;
}

/* -------------------------------------------------------------------------- */
/* Dissolve                                                                    */
/* -------------------------------------------------------------------------- */

/** Merges a connected face region into a single n-gon where the border allows. */
export function dissolveFaceRegion(mesh, faces) {
  const ring = faceRegionRing(faces);
  if (!ring) return null;
  const template = faces[0];
  for (const face of faces) killFace(mesh, face);
  const merged = addFace(mesh, ring.verts, { material: template.material, smooth: template.smooth, uvs: ring.uvs });
  if (merged) merged.select = true;
  return merged;
}

export function dissolveFaces(mesh) {
  let merged = 0;
  for (const region of faceRegions(selected(mesh, "face"))) {
    if (region.length < 2) continue;
    if (dissolveFaceRegion(mesh, region)) merged++;
  }
  flushSelection(mesh, "face");
  return merged;
}

export function dissolveEdges(mesh) {
  let dissolved = 0;
  // Snapshot first: dissolving one edge rebuilds its faces, which invalidates
  // any other selected edge object that belonged to them. Re-find by endpoints.
  const pairs = selected(mesh, "edge").map((edge) => [edge.v1, edge.v2]);
  for (const [a, b] of pairs) {
    if (!mesh.verts.has(a) || !mesh.verts.has(b)) continue;
    const edge = findEdge(a, b);
    if (edge && dissolveEdge(mesh, edge)) dissolved++;
  }
  // Blender also removes the now-redundant verts left mid-edge by the dissolve.
  for (const vert of [...mesh.verts]) {
    if (vert.select && vert.edges.size === 2) dissolveVertEdgeChain(mesh, vert);
  }
  flushSelection(mesh, "edge");
  return dissolved;
}

/**
 * Dissolve Vertices: each selected vertex is removed and the fan of faces
 * around it becomes one face.
 */
export function dissolveVerts(mesh) {
  let dissolved = 0;
  for (const vert of selectedVerts(mesh, "vert")) {
    if (!mesh.verts.has(vert)) continue;
    const fan = vertFaces(vert);
    if (!fan.length) {
      killVert(mesh, vert);
      dissolved++;
      continue;
    }
    if (vert.edges.size === 2 && dissolveVertEdgeChain(mesh, vert)) {
      dissolved++;
      continue;
    }
    const ring = faceRegionRing(fan);
    if (!ring) continue;
    const kept = ring.verts.map((entry, index) => ({ vert: entry, uv: ring.uvs[index] })).filter((entry) => entry.vert !== vert);
    if (kept.length < 3) continue;
    const template = fan[0];
    for (const face of fan) killFace(mesh, face);
    killVert(mesh, vert);
    const merged = addFace(mesh, kept.map((entry) => entry.vert), {
      material: template.material,
      smooth: template.smooth,
      uvs: kept.map((entry) => entry.uv),
    });
    if (merged) merged.select = true;
    dissolved++;
  }
  flushSelection(mesh, "face");
  return dissolved;
}

/**
 * Limited Dissolve: removes edges whose two faces are nearly coplanar, then the
 * vertices left sitting in the middle of a straight edge. This is the operator
 * that turns a triangulated import back into readable topology.
 */
export function limitedDissolve(mesh, { angleLimit = (5 * Math.PI) / 180, selectionOnly = true } = {}) {
  const candidates = [...mesh.edges]
    .filter((edge) => edge.loops.length === 2)
    .filter((edge) => !selectionOnly || edge.select)
    .filter((edge) => edgeFaceAngle(edge) <= angleLimit)
    .map((edge) => [edge.v1, edge.v2]);
  let dissolved = 0;
  for (const [a, b] of candidates) {
    if (!mesh.verts.has(a) || !mesh.verts.has(b)) continue;
    const edge = findEdge(a, b);
    if (!edge || edge.loops.length !== 2) continue;
    if (edgeFaceAngle(edge) > angleLimit) continue;
    if (dissolveEdge(mesh, edge)) dissolved++;
  }
  for (const vert of [...mesh.verts]) {
    if (selectionOnly && !vert.select) continue;
    if (vert.edges.size !== 2) continue;
    const [first, second] = [...vert.edges];
    const a = edgeOther(first, vert);
    const b = edgeOther(second, vert);
    const toA = [a.co[0] - vert.co[0], a.co[1] - vert.co[1], a.co[2] - vert.co[2]];
    const toB = [b.co[0] - vert.co[0], b.co[1] - vert.co[1], b.co[2] - vert.co[2]];
    const lengthA = Math.hypot(...toA) || 1;
    const lengthB = Math.hypot(...toB) || 1;
    const cosine = (toA[0] * toB[0] + toA[1] * toB[1] + toA[2] * toB[2]) / (lengthA * lengthB);
    if (cosine > -Math.cos(angleLimit)) continue; // not straight enough
    if (dissolveVertEdgeChain(mesh, vert)) dissolved++;
  }
  return dissolved;
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

export const MERGE_MODES = [
  { id: "center", label: "At Center" },
  { id: "cursor", label: "At Cursor" },
  { id: "collapse", label: "Collapse" },
  { id: "first", label: "At First" },
  { id: "last", label: "At Last" },
];

/** Welds a vertex group into `target`, moving it to `position` first. */
function mergeGroup(mesh, verts, target, position) {
  if (!verts.length || !mesh.verts.has(target)) return 0;
  target.co = [...position];
  let merged = 0;
  for (const vert of verts) {
    if (vert === target || !mesh.verts.has(vert)) continue;
    weldVerts(mesh, vert, target);
    merged++;
  }
  return merged;
}

/**
 * Blender's M menu. `active` supplies At First / At Last, `cursor` supplies At
 * Cursor; both are ignored by the modes that do not need them.
 */
export function mergeSelection(mesh, mode, kind = "center", { cursor = [0, 0, 0], active = null } = {}) {
  const verts = selectedVerts(mesh, mode);
  if (verts.length < 2) return { error: "Select at least two vertices to merge" };
  if (kind === "collapse") {
    // Collapse works per connected island rather than pulling everything to one
    // point — collapsing two separate loops must give two verts, not one.
    const islands = vertIslands(verts);
    let merged = 0;
    for (const island of islands) {
      if (island.length < 2) continue;
      merged += mergeGroup(mesh, island, island[0], centroid(island));
    }
    clearSelection(mesh);
    for (const island of islands) if (mesh.verts.has(island[0])) island[0].select = true;
    flushSelection(mesh, "vert");
    return { merged, islands: islands.length };
  }
  let target = verts[0];
  let position;
  if (kind === "center") position = centroid(verts);
  else if (kind === "cursor") position = [...cursor];
  else if (kind === "first") {
    target = verts.find((vert) => vert !== active) ?? verts[0];
    position = [...target.co];
  } else if (kind === "last") {
    target = active && verts.includes(active) ? active : verts[verts.length - 1];
    position = [...target.co];
  } else return { error: `Unknown merge mode ${kind}` };

  const merged = mergeGroup(mesh, verts, target, position);
  clearSelection(mesh);
  if (mesh.verts.has(target)) target.select = true;
  flushSelection(mesh, "vert");
  return { merged };
}

/** Connected components of a vertex set, walking existing edges. */
function vertIslands(verts) {
  const remaining = new Set(verts);
  const islands = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const island = [seed];
    const queue = [seed];
    while (queue.length) {
      const vert = queue.pop();
      for (const edge of vert.edges) {
        const other = edgeOther(edge, vert);
        if (!remaining.delete(other)) continue;
        island.push(other);
        queue.push(other);
      }
    }
    islands.push(island);
  }
  return islands;
}

/**
 * Merge by Distance (the operator that used to be called Remove Doubles).
 * Grid-bucketed so a dense import does not turn into an O(n^2) stall.
 */
export function mergeByDistance(mesh, distance = 0.0001, { selectionOnly = true, mode = "vert" } = {}) {
  const candidates = selectionOnly ? selectedVerts(mesh, mode) : [...mesh.verts];
  if (candidates.length < 2) return 0;
  const cell = Math.max(distance, 1e-9);
  const buckets = new Map();
  const keyOf = (co) => `${Math.floor(co[0] / cell)},${Math.floor(co[1] / cell)},${Math.floor(co[2] / cell)}`;
  for (const vert of candidates) {
    const key = keyOf(vert.co);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(vert);
  }
  const squared = distance * distance;
  const merged = new Set();
  let count = 0;
  for (const vert of candidates) {
    if (merged.has(vert) || !mesh.verts.has(vert)) continue;
    const [cx, cy, cz] = [Math.floor(vert.co[0] / cell), Math.floor(vert.co[1] / cell), Math.floor(vert.co[2] / cell)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (other === vert || merged.has(other) || !mesh.verts.has(other)) continue;
            const delta = [other.co[0] - vert.co[0], other.co[1] - vert.co[1], other.co[2] - vert.co[2]];
            if (delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2 > squared) continue;
            merged.add(other);
            weldVerts(mesh, other, vert);
            count++;
          }
        }
      }
    }
  }
  flushSelection(mesh, mode);
  return count;
}

/* -------------------------------------------------------------------------- */
/* Rip, split, separate, duplicate                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rip (V): tears the mesh open at the selected verts.
 *
 * The faces around each vertex are partitioned by which side of `direction`
 * their centre falls on, and the far group is re-attached to a fresh copy of
 * the vertex. That mirrors Blender, where the rip follows the mouse.
 */
export function ripVerts(mesh, verts, direction = [1, 0, 0], { fill = false } = {}) {
  const created = [];
  const seams = [];
  for (const vert of verts) {
    if (!mesh.verts.has(vert)) continue;
    const fan = vertFaces(vert);
    if (fan.length < 2) continue;
    const origin = vert.co;
    const moving = fan.filter((face) => {
      const center = faceCenter(face);
      const delta = [center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]];
      return delta[0] * direction[0] + delta[1] * direction[1] + delta[2] * direction[2] > 0;
    });
    if (!moving.length || moving.length === fan.length) continue;
    const copy = addVert(mesh, vert.co);
    copy.select = true;
    created.push(copy);
    seams.push([vert, copy]);
    for (const face of moving) {
      const ring = faceVerts(face).map((entry) => (entry === vert ? copy : entry));
      const uvs = face.loops.map((loop) => [...loop.uv]);
      const options = { material: face.material, smooth: face.smooth, uvs };
      const wasSelected = face.select;
      killFace(mesh, face);
      const rebuilt = addFace(mesh, ring, options);
      if (rebuilt) rebuilt.select = wasSelected;
    }
  }
  if (fill) {
    // Rip Fill closes the tear with quads instead of leaving a hole.
    for (let index = 0; index + 1 < seams.length; index++) {
      const [a, aCopy] = seams[index];
      const [b, bCopy] = seams[index + 1];
      if (!findEdge(a, b)) continue;
      addFace(mesh, [a, b, bCopy, aCopy]);
    }
  }
  flushSelection(mesh, "vert");
  return created;
}

/**
 * Split (Y): disconnects the selected faces from the rest of the mesh without
 * moving them, by giving them their own copies of every shared vertex.
 */
export function splitSelection(mesh, mode) {
  const faces = selected(mesh, "face");
  if (!faces.length) return { error: "Select faces to split" };
  const region = new Set(faces);
  const copies = new Map();
  const copyOf = (vert) => {
    if (!copies.has(vert)) {
      const copy = addVert(mesh, vert.co);
      copies.set(vert, copy);
    }
    return copies.get(vert);
  };
  const shared = new Set();
  for (const face of region) {
    for (const loop of face.loops) {
      if (vertFaces(loop.v).some((other) => !region.has(other))) shared.add(loop.v);
    }
  }
  if (!shared.size) return { error: "That selection is already separate" };
  const rebuilds = [...region].map((face) => ({
    face,
    ring: faceVerts(face).map((vert) => (shared.has(vert) ? copyOf(vert) : vert)),
    uvs: face.loops.map((loop) => [...loop.uv]),
    material: face.material,
    smooth: face.smooth,
  }));
  for (const rebuild of rebuilds) killFace(mesh, rebuild.face);
  clearSelection(mesh);
  for (const rebuild of rebuilds) {
    const rebuilt = addFace(mesh, rebuild.ring, { material: rebuild.material, smooth: rebuild.smooth, uvs: rebuild.uvs });
    if (rebuilt) rebuilt.select = true;
  }
  flushSelection(mesh, mode);
  return { split: rebuilds.length };
}

/**
 * Separate by Selection (P): builds a standalone mesh from the selected faces
 * and removes them here. The caller decides where the new mesh is saved.
 */
export function separateSelection(mesh, MeshFactory) {
  const faces = selected(mesh, "face");
  if (!faces.length) return { error: "Select faces to separate" };
  if (faces.length === mesh.faces.size) return { error: "Select fewer than every face" };
  const target = MeshFactory();
  const mapping = new Map();
  for (const face of faces) {
    const ring = faceVerts(face).map((vert) => {
      if (!mapping.has(vert)) mapping.set(vert, addVert(target, vert.co));
      return mapping.get(vert);
    });
    addFace(target, ring, {
      material: face.material,
      smooth: face.smooth,
      uvs: face.loops.map((loop) => [...loop.uv]),
    });
  }
  deleteSelection(mesh, "face", "faces");
  return { mesh: target, faces: faces.length };
}

/**
 * Duplicate (Shift+D). Copies the selected geometry in place and leaves the
 * copy selected so the caller can start a move macro on it.
 */
export function duplicateSelection(mesh, mode) {
  const faces = selected(mesh, "face");
  const edges = selected(mesh, "edge");
  const verts = selectedVerts(mesh, mode);
  if (!verts.length) return { error: "Nothing selected" };
  const copies = new Map();
  const copyOf = (vert) => {
    if (!copies.has(vert)) copies.set(vert, addVert(mesh, vert.co));
    return copies.get(vert);
  };
  for (const vert of verts) copyOf(vert);
  const newFaces = [];
  for (const face of faces) {
    const rebuilt = addFace(mesh, faceVerts(face).map(copyOf), {
      material: face.material,
      smooth: face.smooth,
      uvs: face.loops.map((loop) => [...loop.uv]),
    });
    if (rebuilt) newFaces.push(rebuilt);
  }
  const covered = new Set();
  for (const face of newFaces) for (const loop of face.loops) covered.add(loop.e);
  for (const edge of edges) {
    const copy = addEdge(mesh, copyOf(edge.v1), copyOf(edge.v2));
    if (copy) copy.select = true;
  }
  clearSelection(mesh);
  for (const vert of copies.values()) vert.select = true;
  for (const face of newFaces) face.select = true;
  flushSelection(mesh, mode);
  return { verts: [...copies.values()], faces: newFaces };
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/** Connect Vertex Path (J): cuts a face between two of its selected corners. */
export function connectVertPath(mesh) {
  const verts = new Set(selected(mesh, "vert"));
  if (verts.size < 2) return { error: "Select at least two vertices" };
  let cuts = 0;
  for (const face of [...mesh.faces]) {
    const positions = face.loops.map((loop, index) => (verts.has(loop.v) ? index : -1)).filter((index) => index >= 0);
    if (positions.length < 2) continue;
    // Cutting one chord per pass keeps the loop indices valid; repeat callers
    // can run it again for a longer path.
    if (splitFace(mesh, face, positions[0], positions[1])) cuts++;
  }
  flushSelection(mesh, "vert");
  return { cuts };
}

/** Removes verts that no edge uses and edges that no face uses. */
export function deleteLoose(mesh, { verts = true, edges = true, faces = false } = {}) {
  let removed = 0;
  if (faces) {
    for (const face of [...mesh.faces]) {
      if (face.loops.every((loop) => isBoundaryEdge(loop.e))) {
        killFace(mesh, face);
        removed++;
      }
    }
  }
  if (edges) {
    for (const edge of [...mesh.edges]) {
      if (!edge.loops.length) {
        killEdge(mesh, edge);
        removed++;
      }
    }
  }
  if (verts) {
    for (const vert of [...mesh.verts]) {
      if (!vert.edges.size) {
        mesh.verts.delete(vert);
        removed++;
      }
    }
  }
  return removed;
}
