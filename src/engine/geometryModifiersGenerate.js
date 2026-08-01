import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { LoopSubdivision } from "three-subdivide";
import { meshFromBufferGeometry, bufferGeometryFromMesh } from "../editor/mesh/io.js";
import { bevelEdges } from "../editor/mesh/ops/topology.js";
import { faceNormal } from "../editor/mesh/bmesh.js";

/** Generate modifiers that can be represented by the engine's triangle-only BufferGeometry model. */
export const GEOMETRY_GENERATE_MODIFIER_DEFINITIONS = [
  { type: "bevel", label: "Bevel", defaults: { width: 0.05, segments: 1, affect: "edges", limitMethod: "none", angle: 30, clampOverlap: true }, fields: [
    { key: "width", label: "Amount", type: "number", min: 0, step: 0.01 },
    { key: "segments", label: "Segments", type: "number", min: 1, max: 16, step: 1 },
    { key: "affect", label: "Affect", type: "select", options: ["edges", "vertices"] },
    { key: "limitMethod", label: "Limit Method", type: "select", options: ["none", "angle"] },
    { key: "angle", label: "Angle°", type: "number", min: 0, max: 180, step: 1, showIf: (p) => p.limitMethod === "angle" },
    { key: "clampOverlap", label: "Clamp Overlap", type: "boolean" },
  ] },
  { type: "build", label: "Build", defaults: { factor: 1, reverse: false, randomize: false, seed: 0 }, fields: [
    { key: "factor", label: "Factor", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "reverse", label: "Reverse", type: "boolean" },
    { key: "randomize", label: "Randomize", type: "boolean" },
    { key: "seed", label: "Seed", type: "number", step: 1, showIf: (p) => p.randomize },
  ] },
  { type: "mask", label: "Mask", defaults: { attribute: "mask", threshold: 0.5, invert: false }, fields: [
    { key: "attribute", label: "Attribute", type: "text" },
    { key: "threshold", label: "Threshold", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "invert", label: "Invert", type: "boolean" },
  ] },
  { type: "multiresolution", label: "Multiresolution", defaults: { levels: 1, smooth: true }, fields: [
    { key: "levels", label: "Levels", type: "number", min: 0, max: 4, step: 1 },
    { key: "smooth", label: "Smooth", type: "boolean" },
  ] },
  { type: "remesh", label: "Remesh", defaults: { mode: "voxel", voxelSize: 0.1, smooth: 0 }, fields: [
    { key: "mode", label: "Mode", type: "select", options: ["voxel", "sharp", "smooth", "blocks"] },
    { key: "voxelSize", label: "Voxel Size", type: "number", min: 0.0001, step: 0.01 },
    { key: "smooth", label: "Smooth", type: "number", min: 0, max: 1, step: 0.05 },
  ] },
  { type: "screw", label: "Screw", defaults: { axis: "z", angle: 360, steps: 16, iterations: 1, screwOffset: 0, merge: true }, fields: [
    { key: "axis", label: "Axis", type: "select", options: ["x", "y", "z"] },
    { key: "angle", label: "Angle°", type: "number", step: 1 },
    { key: "steps", label: "Steps", type: "number", min: 2, max: 128, step: 1 },
    { key: "iterations", label: "Iterations", type: "number", min: 1, max: 16, step: 1 },
    { key: "screwOffset", label: "Screw", type: "number", step: 0.01 },
    { key: "merge", label: "Merge", type: "boolean" },
  ] },
  { type: "skin", label: "Skin", defaults: { radius: 0.1, radialSegments: 6 }, fields: [
    { key: "radius", label: "Radius", type: "number", min: 0.0001, step: 0.01 },
    { key: "radialSegments", label: "Branch Sides", type: "number", min: 3, max: 16, step: 1 },
  ] },
  { type: "triangulate", label: "Triangulate", defaults: { keepNormals: true }, fields: [
    { key: "keepNormals", label: "Keep Normals", type: "boolean" },
  ] },
  { type: "wireframe", label: "Wireframe", defaults: { thickness: 0.02, segments: 4, replace: true }, fields: [
    { key: "thickness", label: "Thickness", type: "number", min: 0.0001, step: 0.005 },
    { key: "segments", label: "Sides", type: "number", min: 3, max: 12, step: 1 },
    { key: "replace", label: "Replace Original", type: "boolean" },
  ] },
  { type: "meshToVolume", label: "Mesh to Volume", approximation: true, defaults: { voxelSize: 0.1, density: 1 }, fields: [
    { key: "voxelSize", label: "Voxel Size", type: "number", min: 0.0001, step: 0.01 },
    { key: "density", label: "Density", type: "number", min: 0, step: 0.1 },
  ] },
  { type: "volumeToMesh", label: "Volume to Mesh", approximation: true, defaults: { voxelSize: 0.1, smooth: 0.25 }, fields: [
    { key: "voxelSize", label: "Voxel Size", type: "number", min: 0.0001, step: 0.01 },
    { key: "smooth", label: "Smooth", type: "number", min: 0, max: 1, step: 0.05 },
  ] },
];

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function finish(geometry, normals = true) {
  if (normals && geometry.getAttribute("position")) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function triangleIndices(source) {
  const position = source.getAttribute("position");
  if (!position) return [];
  return source.index ? Array.from(source.index.array) : Array.from({ length: position.count }, (_, i) => i);
}

function seededOrder(length, seed) {
  const order = Array.from({ length }, (_, i) => i);
  let state = (Number(seed) || 0) >>> 0;
  for (let i = length - 1; i > 0; i--) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function geometryFromSelectedTriangles(source, selected) {
  const input = source.toNonIndexed();
  const result = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(input.attributes)) {
    const ArrayType = attribute.array.constructor;
    const array = new ArrayType(selected.length * 3 * attribute.itemSize);
    let cursor = 0;
    for (const triangle of selected) for (let corner = 0; corner < 3; corner++) {
      const sourceIndex = triangle * 3 + corner;
      for (let component = 0; component < attribute.itemSize; component++) array[cursor++] = attribute.getComponent(sourceIndex, component);
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized));
  }
  input.dispose();
  return finish(result, !result.getAttribute("normal"));
}

export function applyBuildModifier(source, options = {}) {
  const total = Math.floor((source.index?.count ?? source.getAttribute("position")?.count ?? 0) / 3);
  if (!total) return source.clone();
  const count = THREE.MathUtils.clamp(Math.floor(total * THREE.MathUtils.clamp(Number(options.factor) || 0, 0, 1)), 0, total);
  let order = options.randomize ? seededOrder(total, options.seed) : Array.from({ length: total }, (_, i) => i);
  if (options.reverse) order = order.reverse();
  return geometryFromSelectedTriangles(source, order.slice(0, count));
}

export function applyMaskModifier(source, options = {}) {
  const attribute = source.getAttribute(options.attribute || "mask");
  if (!attribute) return source.clone();
  const indices = triangleIndices(source);
  const threshold = Number(options.threshold) || 0;
  const selected = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const visible = [0, 1, 2].every((corner) => attribute.getX(indices[triangle * 3 + corner]) >= threshold);
    if (options.invert ? !visible : visible) selected.push(triangle);
  }
  return geometryFromSelectedTriangles(source, selected);
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const edgeLength = (edge) => Math.hypot(
  edge.v1.co[0] - edge.v2.co[0],
  edge.v1.co[1] - edge.v2.co[1],
  edge.v1.co[2] - edge.v2.co[2],
);

/**
 * Topology-aware bevel using the editor's BMesh kernel. All selected edge
 * offsets meeting at a vertex are solved together, producing one continuous
 * corner patch instead of the old per-triangle fan intersection.
 */
export function applyBevelModifier(source, options = {}) {
  let width = Math.max(0, Number(options.width) || 0);
  if (!width) return source.clone();
  const mesh = meshFromBufferGeometry(source);
  const angleLimit = THREE.MathUtils.degToRad(Number(options.angle) || 0);
  const chosen = [...mesh.edges].filter((edge) => {
    if (edge.loops.length !== 2) return false;
    if (options.limitMethod !== "angle") return true;
    const first = faceNormal(edge.loops[0].f);
    const second = faceNormal(edge.loops[1].f);
    return Math.acos(THREE.MathUtils.clamp(dot3(first, second), -1, 1)) >= angleLimit;
  });
  if (!chosen.length) return source.clone();
  if (options.clampOverlap !== false) width = Math.min(width, Math.min(...chosen.map(edgeLength)) * 0.49);
  const outcome = bevelEdges(mesh, chosen, {
    width,
    segments: THREE.MathUtils.clamp(Math.round(Number(options.segments) || 1), 1, 16),
  });
  if (outcome?.error) return source.clone();
  return bufferGeometryFromMesh(mesh);
}

export function applyMultiresolutionModifier(source, options = {}) {
  const levels = THREE.MathUtils.clamp(Math.round(Number(options.levels) || 0), 0, 4);
  if (!levels) return source.clone();
  return finish(LoopSubdivision.modify(source, levels, { split: true, flatOnly: options.smooth === false, preserveEdges: true, maxTriangles: 500_000 }));
}

/** BufferGeometry voxel approximation: snap and weld vertices onto a regular grid. */
export function applyRemeshModifier(source, options = {}) {
  const size = Math.max(0.0001, Number(options.voxelSize) || 0.1);
  const result = source.clone();
  const position = result.getAttribute("position");
  if (!position) return result;
  for (let i = 0; i < position.count; i++) position.setXYZ(i,
    Math.round(position.getX(i) / size) * size,
    Math.round(position.getY(i) / size) * size,
    Math.round(position.getZ(i) / size) * size);
  position.needsUpdate = true;
  let welded = mergeVertices(result, size * 0.01);
  result.dispose();
  if (Number(options.smooth) > 0 && welded.getAttribute("position")) {
    const smooth = THREE.MathUtils.clamp(Number(options.smooth), 0, 1);
    welded.computeBoundingBox();
    const center = welded.boundingBox.getCenter(new THREE.Vector3());
    const p = welded.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(p, i);
      point.lerp(center, smooth * 0.02);
      p.setXYZ(i, point.x, point.y, point.z);
    }
  }
  return finish(welded);
}

/** Rotates complete mesh slices. Unlike Blender, BufferGeometry cannot identify an authored profile edge graph. */
export function applyScrewModifier(source, options = {}) {
  const axis = AXES[options.axis] ?? AXES.z;
  const steps = THREE.MathUtils.clamp(Math.round(Number(options.steps) || 16), 2, 128);
  const iterations = THREE.MathUtils.clamp(Math.round(Number(options.iterations) || 1), 1, 16);
  const totalAngle = THREE.MathUtils.degToRad(Number(options.angle) || 0) * iterations;
  const offset = (Number(options.screwOffset) || 0) * iterations;
  const copies = [];
  for (let i = 0; i <= steps * iterations; i++) {
    const t = i / (steps * iterations);
    const matrix = new THREE.Matrix4().makeRotationAxis(axis, totalAngle * t);
    matrix.setPosition(axis.clone().multiplyScalar(offset * t));
    const geometry = source.clone();
    geometry.applyMatrix4(matrix);
    copies.push(geometry);
  }
  let result = mergeGeometries(copies, true);
  copies.forEach((geometry) => geometry.dispose());
  if (!result) return source.clone();
  if (options.merge !== false) {
    const merged = mergeVertices(result, 1e-5);
    result.dispose();
    result = merged;
  }
  return finish(result);
}

function uniqueEdges(source) {
  const indices = triangleIndices(source);
  const edges = new Map();
  for (let i = 0; i < indices.length; i += 3) for (const [a, b] of [[indices[i], indices[i + 1]], [indices[i + 1], indices[i + 2]], [indices[i + 2], indices[i]]]) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!edges.has(key)) edges.set(key, [a, b]);
  }
  return [...edges.values()];
}

function tubesForEdges(source, radius, segments) {
  const position = source.getAttribute("position");
  if (!position) return source.clone();
  const tubes = [];
  const start = new THREE.Vector3(), end = new THREE.Vector3(), midpoint = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const [a, b] of uniqueEdges(source)) {
    start.fromBufferAttribute(position, a); end.fromBufferAttribute(position, b);
    const length = start.distanceTo(end);
    if (length < 1e-8) continue;
    midpoint.addVectors(start, end).multiplyScalar(0.5);
    const direction = end.clone().sub(start).normalize();
    const geometry = new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
    geometry.quaternion = undefined;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(yAxis, direction);
    geometry.applyQuaternion(quaternion);
    geometry.translate(midpoint.x, midpoint.y, midpoint.z);
    tubes.push(geometry);
  }
  if (!tubes.length) return new THREE.BufferGeometry();
  const result = mergeGeometries(tubes, false);
  tubes.forEach((geometry) => geometry.dispose());
  return finish(result);
}

/** Skin approximation turns the recovered triangle edge graph into connected branch tubes. */
export function applySkinModifier(source, options = {}) {
  return tubesForEdges(source, Math.max(0.0001, Number(options.radius) || 0.1), THREE.MathUtils.clamp(Math.round(Number(options.radialSegments) || 6), 3, 16));
}

export function applyTriangulateModifier(source, options = {}) {
  // BufferGeometry's render primitive is already a triangle; cloning is the exact triangulated representation.
  const result = source.clone();
  if (options.keepNormals === false) result.deleteAttribute("normal");
  return finish(result, options.keepNormals === false);
}

export function applyWireframeModifier(source, options = {}) {
  const wire = tubesForEdges(source, Math.max(0.0001, Number(options.thickness) || 0.02) * 0.5, THREE.MathUtils.clamp(Math.round(Number(options.segments) || 4), 3, 12));
  if (options.replace !== false) return wire;
  const original = source.clone();
  const merged = mergeGeometries([original, wire], true);
  original.dispose(); wire.dispose();
  return merged ? finish(merged) : source.clone();
}

/**
 * Portable Mesh-to-Volume representation. The engine has no volume datablock or 3D density texture,
 * so this returns a deterministic voxel-shell mesh suitable for the following Volume-to-Mesh stage.
 */
export function applyMeshToVolumeModifier(source, options = {}) {
  const voxelSize = Math.max(0.0001, Number(options.voxelSize) || 0.1);
  return applyRemeshModifier(source, { voxelSize, smooth: 0 });
}

/** Converts the portable voxel-shell representation back to a smoothed triangle mesh. */
export function applyVolumeToMeshModifier(source, options = {}) {
  return applyRemeshModifier(source, { voxelSize: options.voxelSize, smooth: options.smooth });
}

export function evaluateGenerateGeometryModifier(source, modifier) {
  if (!modifier || modifier.enabled === false) return source.clone();
  switch (modifier.type) {
    case "bevel": return applyBevelModifier(source, modifier);
    case "build": return applyBuildModifier(source, modifier);
    case "mask": return applyMaskModifier(source, modifier);
    case "multiresolution": return applyMultiresolutionModifier(source, modifier);
    case "remesh": return applyRemeshModifier(source, modifier);
    case "screw": return applyScrewModifier(source, modifier);
    case "skin": return applySkinModifier(source, modifier);
    case "triangulate": return applyTriangulateModifier(source, modifier);
    case "wireframe": return applyWireframeModifier(source, modifier);
    case "meshToVolume": return applyMeshToVolumeModifier(source, modifier);
    case "volumeToMesh": return applyVolumeToMeshModifier(source, modifier);
    default: return source.clone();
  }
}
