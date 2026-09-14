import * as THREE from "three/webgpu";
import { getArchitectureFormFootprint, normalizeArchitectureModel } from "./formModel.js";

const CONTACT_EPS = 1e-4, MAX_SAMPLES = 4096;
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((n, i) => n - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const aabb = points => ({ min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) });
const overlaps = (a, b) => a.min.every((n, i) => n <= b.max[i] + CONTACT_EPS && a.max[i] >= b.min[i] - CONTACT_EPS);

function matrix(value) {
  const result = value?.isMatrix4 ? value.clone() : value == null ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(value);
  if (result.elements.length !== 16 || !result.elements.every(Number.isFinite) || Math.abs(result.determinant()) < 1e-12) throw new Error("Architecture terrain following needs an invertible finite root transform.");
  return result;
}
function direction(list, value) {
  const magnitude = length(value);
  if (magnitude < 1e-9) return;
  const unit = value.map(n => n / magnitude);
  if (!list.some(axis => Math.abs(dot(axis, unit)) > 1 - 1e-9)) list.push(unit);
}

/** The body and its tapered roof together form one convex polyhedron. Derived
 * support posts deliberately do not attach an otherwise independent building. */
function solid(form) {
  const ring = getArchitectureFormFootprint(form), bottom = form.position[1], top = bottom + form.size[1];
  const low = ring.map(([x, z]) => [x, bottom, z]), high = ring.map(([x, z]) => [x, top, z]);
  const faces = [low];
  for (let i = 0; i < ring.length; i++) faces.push([low[i], low[(i + 1) % ring.length], high[(i + 1) % ring.length], high[i]]);
  if (form.roof === "gable" && form.shape !== "round") {
    const width = form.size[0], depth = form.size[2], c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
    const peak = (x, z) => [form.position[0] + x * c + z * s, top + form.roofHeight, form.position[2] - x * s + z * c];
    if ((form.roofAxis ?? (width >= depth ? "x" : "z")) === "x") {
      const left = peak(-width / 2, 0), right = peak(width / 2, 0);
      faces.push([high[0], high[1], right, left], [high[2], high[3], left, right], [high[1], high[2], right], [high[0], high[3], left]);
    } else {
      const front = peak(0, -depth / 2), back = peak(0, depth / 2);
      faces.push([high[1], high[2], back, front], [high[3], high[0], front, back], [high[0], high[1], front], [high[2], high[3], back]);
    }
  } else if (form.roof !== "hip" && form.roof !== "gable") faces.push(high);
  else if (form.shape === "round") {
    const peak = [form.position[0], top + form.roofHeight, form.position[2]];
    for (let i = 0; i < high.length; i++) faces.push([high[i], high[(i + 1) % high.length], peak]);
  } else {
    const width = form.size[0], depth = form.size[2], c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
    const peak = (x, z) => [form.position[0] + x * c + z * s, top + form.roofHeight, form.position[2] - x * s + z * c];
    if (width >= depth) {
      const left = peak(-(width - depth) / 2, 0), right = peak((width - depth) / 2, 0);
      faces.push([high[0], high[1], right, left], [high[1], high[2], right], [high[2], high[3], left, right], [high[3], high[0], left]);
    } else {
      const front = peak(0, -(depth - width) / 2), back = peak(0, (depth - width) / 2);
      faces.push([high[0], high[1], front], [high[1], high[2], back, front], [high[2], high[3], back], [high[3], high[0], front, back]);
    }
  }
  const vertices = [], axes = [], edges = [];
  for (const face of faces) {
    for (const p of face) if (!vertices.some(other => length(sub(p, other)) < 1e-8)) vertices.push(p);
    for (let i = 0; i < face.length; i++) direction(edges, sub(face[(i + 1) % face.length], face[i]));
    for (let i = 1; i < face.length - 1; i++) direction(axes, cross(sub(face[i], face[0]), sub(face[i + 1], face[0])));
  }
  return { vertices, axes, edges, bounds: aabb(vertices) };
}

function separates(a, b, axis) {
  const magnitude = length(axis);
  if (magnitude < 1e-9) return false;
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of a.vertices) { const d = dot(p, axis); minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
  for (const p of b.vertices) { const d = dot(p, axis); minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
  return minA > maxB + CONTACT_EPS * magnitude || minB > maxA + CONTACT_EPS * magnitude;
}
function touching(a, b) {
  if (!overlaps(a.bounds, b.bounds)) return false;
  for (const axis of [...a.axes, ...b.axes]) if (separates(a, b, axis)) return false;
  // Face normals alone miss separating axes between skew roof/side edges.
  for (const first of a.edges) for (const second of b.edges) if (separates(a, b, cross(first, second))) return false;
  return true;
}
function inside(point, ring) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]) < -CONTACT_EPS) return false;
  }
  return true;
}

function groundSamples(forms, cellSize, root) {
  const lowest = Math.min(...forms.map(form => form.position[1]));
  const foundations = forms.filter(form => form.position[1] <= lowest + CONTACT_EPS);
  const samples = [], seen = new Set(), candidates = [], allBoundary = [], foundationPolygonsWorldXYZ = [];
  const world = (point, y) => new THREE.Vector3(point[0], y, point[1]).applyMatrix4(root).toArray();
  const keep = sample => {
    if (samples.length >= MAX_SAMPLES) return;
    const key = sample.map(n => Math.round(n * 1e6)).join(":");
    if (!seen.has(key)) { samples.push(sample); seen.add(key); }
  };
  for (const form of foundations) {
    const ring = getArchitectureFormFootprint(form), y = form.position[1];
    const boundary = ring.map(p => world(p, y)); allBoundary.push(...boundary); foundationPolygonsWorldXYZ.push(boundary);
    keep(world([form.position[0], form.position[2]], y));
    // Every foundation contributes, even when a large connected group reaches
    // the sample budget. Its full ring and grid are distributed below.
    for (let i = 0; i < 4; i++) keep(boundary[Math.floor(i * boundary.length / 4)]);
    const minX = Math.min(...ring.map(p => p[0])), maxX = Math.max(...ring.map(p => p[0]));
    const minZ = Math.min(...ring.map(p => p[1])), maxZ = Math.max(...ring.map(p => p[1]));
    const spacing = Math.max(.5, Math.min(2, cellSize));
    const columns = Math.max(1, Math.min(16, Math.ceil((maxX - minX) / spacing))), rows = Math.max(1, Math.min(16, Math.ceil((maxZ - minZ) / spacing)));
    const extra = [...boundary];
    for (let x = 1; x < columns; x++) for (let z = 1; z < rows; z++) {
      const p = [minX + (maxX - minX) * x / columns, minZ + (maxZ - minZ) * z / rows];
      if (inside(p, ring)) extra.push(world(p, y));
    }
    candidates.push(extra);
  }
  // World-space extrema keep dirty-rectangle rejection conservative even for
  // tilted roots or faceted ellipses whose local quarter points are not extrema.
  for (const axis of [0, 1, 2]) {
    keep(allBoundary.reduce((best, p) => p[axis] < best[axis] ? p : best));
    keep(allBoundary.reduce((best, p) => p[axis] > best[axis] ? p : best));
  }
  const longest = Math.max(0, ...candidates.map(points => points.length));
  for (let i = 0; i < longest && samples.length < MAX_SAMPLES; i++) for (const list of candidates) if (list[i]) keep(list[i]);
  return { baseWorldY: Math.min(...allBoundary.map(p => p[1])), samplesWorldXYZ: samples, foundationPolygonsWorldXYZ };
}

/** Connected authored bodies move as rigid groups. Grouping is performed in
 * model space, where any invertible root transform preserves connectivity. */
export function getArchitectureTerrainGroups(input, rootWorldMatrix) {
  const model = normalizeArchitectureModel(input), root = matrix(rootWorldMatrix);
  if (!model.forms.length) return [];
  const forms = [...model.forms].sort((a, b) => compareId(a.id, b.id)), solids = forms.map(solid);
  const parents = forms.map((_, i) => i);
  const find = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  for (let i = 0; i < forms.length; i++) for (let j = i + 1; j < forms.length; j++) {
    const first = find(i), second = find(j);
    if (first !== second && touching(solids[i], solids[j])) parents[second] = first;
  }
  const sets = new Map();
  for (let i = 0; i < forms.length; i++) { const key = find(i); if (!sets.has(key)) sets.set(key, []); sets.get(key).push(forms[i]); }
  return [...sets.values()].map(group => ({ key: group[0].id, formIds: group.map(form => form.id), ...groundSamples(group, model.cellSize, root) })).sort((a, b) => compareId(a.key, b.key));
}

/** Apply a WORLD vertical displacement without changing root scale/rotation.
 * Paths remain separate terrain attachments: one flat path cannot rigidly follow
 * two independently moving buildings. Openings belong to their moved form. */
export function translateArchitectureTerrainGroup(input, formIds, worldDelta, rootWorldMatrix) {
  if (!Number.isFinite(worldDelta)) throw new Error("Terrain displacement must be finite.");
  const root = matrix(rootWorldMatrix), inverse = root.clone().invert();
  const delta = new THREE.Vector3(0, worldDelta, 0).applyMatrix4(inverse).sub(new THREE.Vector3().applyMatrix4(inverse)).toArray();
  const result = structuredClone(input), selected = new Set(formIds ?? []);
  for (const form of result.forms ?? []) if (selected.has(form.id)) form.position = form.position.map((n, i) => n + delta[i]);
  for (const opening of result.openings ?? []) if (selected.has(opening.formId)) opening.position = opening.position.map((n, i) => n + delta[i]);
  return result;
}
