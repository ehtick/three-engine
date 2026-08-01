import * as THREE from "three/webgpu";

/**
 * Deform modifiers that are kept separate from the core modifier module. The
 * editor can merge these definitions into its catalogue. Algorithms operate on
 * CPU BufferGeometry and never mutate their input.
 *
 * Blender normally obtains Curve/Lattice/Mesh/Surface/Armature data from
 * dedicated datablocks. This engine currently has generic entity geometry and
 * matrices instead, so those modifiers use the deterministic equivalents noted
 * on their apply functions.
 */
export const DEFORM_MODIFIER_DEFINITIONS = [
  { type: "curve", label: "Curve", defaults: { target: "", axis: "x", angle: Math.PI / 2, radius: 0 }, fields: [
    { key: "target", label: "Curve Object", type: "entity", emptyLabel: "— None —" },
    { key: "axis", label: "Deform Axis", type: "select", options: ["x", "y", "z"] },
    { key: "angle", label: "Bend Angle", type: "number", step: 0.1 },
    { key: "radius", label: "Radius", type: "number", min: 0, step: 0.1 },
  ] },
  { type: "hook", label: "Hook", defaults: { target: "", strength: 1, radius: 0, falloff: "smooth" }, fields: [
    { key: "target", label: "Object", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "radius", label: "Radius", type: "number", min: 0, step: 0.1 },
    { key: "falloff", label: "Falloff", type: "select", options: ["none", "linear", "smooth", "sharp", "sphere", "root"] },
  ] },
  { type: "laplacianDeform", label: "Laplacian Deform", defaults: { iterations: 1, strength: 1 }, fields: [
    { key: "iterations", label: "Repeat", type: "number", min: 1, max: 50, step: 1 },
    { key: "strength", label: "Influence", type: "number", min: 0, max: 1, step: 0.05 },
  ] },
  { type: "lattice", label: "Lattice", defaults: { target: "", strength: 1, bulge: 0, twist: 0 }, fields: [
    { key: "target", label: "Lattice Object", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "bulge", label: "Bulge", type: "number", step: 0.05 },
    { key: "twist", label: "Twist", type: "number", step: 0.1 },
  ] },
  { type: "meshDeform", label: "Mesh Deform", defaults: { target: "", strength: 1, precision: 5 }, fields: [
    { key: "target", label: "Cage", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "precision", label: "Precision", type: "number", min: 2, max: 10, step: 1 },
  ] },
  { type: "shrinkwrap", label: "Shrinkwrap", defaults: { target: "", mode: "nearestSurface", strength: 1, offset: 0 }, fields: [
    { key: "target", label: "Target", type: "entity", emptyLabel: "— None —" },
    { key: "mode", label: "Wrap Method", type: "select", options: ["nearestSurface", "projectNormal", "nearestVertex"] },
    { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "offset", label: "Offset", type: "number", step: 0.01 },
  ] },
  { type: "correctiveSmooth", label: "Corrective Smooth", defaults: { factor: 0.5, iterations: 5, scale: 1 }, fields: [
    { key: "factor", label: "Factor", type: "number", min: -2, max: 2, step: 0.05 },
    { key: "iterations", label: "Repeat", type: "number", min: 1, max: 50, step: 1 },
    { key: "scale", label: "Scale", type: "number", min: 0, max: 2, step: 0.05 },
  ] },
  { type: "laplacianSmooth", label: "Laplacian Smooth", defaults: { factor: 0.5, iterations: 1, preserveVolume: true, x: true, y: true, z: true }, fields: [
    { key: "factor", label: "Lambda Factor", type: "number", min: -2, max: 2, step: 0.05 },
    { key: "iterations", label: "Repeat", type: "number", min: 1, max: 50, step: 1 },
    { key: "preserveVolume", label: "Preserve Volume", type: "boolean" },
    { key: "x", label: "X Axis", type: "boolean" }, { key: "y", label: "Y Axis", type: "boolean" }, { key: "z", label: "Z Axis", type: "boolean" },
  ] },
  { type: "surfaceDeform", label: "Surface Deform", defaults: { target: "", strength: 1, offset: 0 }, fields: [
    { key: "target", label: "Target", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "offset", label: "Offset", type: "number", step: 0.01 },
  ] },
  { type: "volumeDisplace", label: "Volume Displace", defaults: { strength: 0.1, midlevel: 0.5, scale: 1, seed: 0, direction: "normal" }, fields: [
    { key: "strength", label: "Strength", type: "number", step: 0.05 },
    { key: "midlevel", label: "Midlevel", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "scale", label: "Texture Scale", type: "number", min: 0.0001, step: 0.1 },
    { key: "seed", label: "Noise Seed", type: "number", step: 1 },
    { key: "direction", label: "Direction", type: "select", options: ["normal", "x", "y", "z"] },
  ] },
  { type: "warp", label: "Warp", defaults: { from: "", to: "", strength: 1, radius: 0, falloff: "smooth" }, fields: [
    { key: "from", label: "From", type: "entity", emptyLabel: "— None —" },
    { key: "to", label: "To", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Strength", type: "number", min: -1, max: 1, step: 0.05 },
    { key: "radius", label: "Radius", type: "number", min: 0, step: 0.1 },
    { key: "falloff", label: "Falloff", type: "select", options: ["none", "linear", "smooth", "sharp", "sphere", "root"] },
  ] },
  { type: "armature", label: "Armature", defaults: { target: "", strength: 1, preserveVolume: false }, fields: [
    { key: "target", label: "Armature", type: "entity", emptyLabel: "— None —" },
    { key: "strength", label: "Influence", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "preserveVolume", label: "Preserve Volume", type: "boolean" },
  ] },
];

const AXIS = { x: 0, y: 1, z: 2 };
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function finish(geometry) {
  if (geometry.getAttribute("position")) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function editPositions(source, callback) {
  const result = source.clone();
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  const position = result.getAttribute("position");
  const normal = result.getAttribute("normal");
  if (!position) return result;
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    direction.fromBufferAttribute(normal, i);
    callback(point, direction, i);
    position.setXYZ(i, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  return finish(result);
}

function sourceSpaceMatrix(objectMatrix, _sourceMatrix) {
  if (!objectMatrix) return new THREE.Matrix4();
  // GeometryModifiersComponent resolves reference matrices into source-local
  // space before evaluation (the same convention used by Boolean).
  return new THREE.Matrix4().copy(objectMatrix);
}

function matrixOrigin(matrix, sourceMatrix) {
  return new THREE.Vector3().setFromMatrixPosition(sourceSpaceMatrix(matrix, sourceMatrix));
}

function falloffWeight(distance, radius, mode = "smooth") {
  if (!(radius > 0) || mode === "none") return 1;
  const t = clamp01(1 - distance / radius);
  if (mode === "linear") return t;
  if (mode === "sharp") return t * t;
  if (mode === "root") return Math.sqrt(t);
  if (mode === "sphere") return Math.sqrt(Math.max(0, 2 * t - t * t));
  return t * t * (3 - 2 * t);
}

function adjacency(geometry) {
  const count = geometry.getAttribute("position")?.count ?? 0;
  const neighbors = Array.from({ length: count }, () => new Set());
  const index = geometry.index;
  const connect = (a, b) => { if (a !== b) { neighbors[a]?.add(b); neighbors[b]?.add(a); } };
  const triangleCount = index ? index.count / 3 : count / 3;
  for (let face = 0; face < triangleCount; face++) {
    const a = index ? index.getX(face * 3) : face * 3;
    const b = index ? index.getX(face * 3 + 1) : face * 3 + 1;
    const c = index ? index.getX(face * 3 + 2) : face * 3 + 2;
    connect(a, b); connect(b, c); connect(c, a);
  }
  return neighbors;
}

function laplacianPass(geometry, factor, axes = [true, true, true]) {
  const result = geometry.clone();
  const source = geometry.getAttribute("position");
  const output = result.getAttribute("position");
  const neighbors = adjacency(geometry);
  const point = new THREE.Vector3();
  const average = new THREE.Vector3();
  const other = new THREE.Vector3();
  for (let i = 0; i < source.count; i++) {
    point.fromBufferAttribute(source, i); average.set(0, 0, 0);
    for (const n of neighbors[i]) average.add(other.fromBufferAttribute(source, n));
    if (!neighbors[i].size) continue;
    average.multiplyScalar(1 / neighbors[i].size);
    for (let axis = 0; axis < 3; axis++) if (axes[axis]) point.setComponent(axis, THREE.MathUtils.lerp(point.getComponent(axis), average.getComponent(axis), factor));
    output.setXYZ(i, point.x, point.y, point.z);
  }
  output.needsUpdate = true;
  return result;
}

function nearestTargetData(targetGeometry, targetToSource = new THREE.Matrix4()) {
  const attribute = targetGeometry?.getAttribute?.("position");
  if (!attribute) return null;
  const points = [];
  const point = new THREE.Vector3();
  for (let i = 0; i < attribute.count; i++) points.push(point.fromBufferAttribute(attribute, i).clone().applyMatrix4(targetToSource));
  return points;
}

function nearestPoint(point, points) {
  let nearest = null;
  let distanceSq = Infinity;
  for (const candidate of points) {
    const next = point.distanceToSquared(candidate);
    if (next < distanceSq) { distanceSq = next; nearest = candidate; }
  }
  return nearest;
}

export function applyCurveModifier(source, options = {}, context = {}) {
  const axis = AXIS[options.axis] ?? 0;
  source.computeBoundingBox();
  const box = source.boundingBox;
  const span = Math.max(1e-6, box.max.getComponent(axis) - box.min.getComponent(axis));
  const angle = Number(options.angle) || 0;
  const radius = Number(options.radius) > 0 ? Number(options.radius) : (Math.abs(angle) > 1e-6 ? span / angle : 0);
  if (!angle || !radius) return source.clone();
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  // Analytic circular curve fallback; a future Curve datablock can replace it.
  return editPositions(source, (point) => {
    const along = point.getComponent(axis) - box.min.getComponent(axis);
    const theta = along / span * angle;
    const transverse = point.getComponent(u);
    point.setComponent(axis, box.min.getComponent(axis) + Math.sin(theta) * (radius + transverse));
    point.setComponent(u, Math.cos(theta) * (radius + transverse) - radius);
    point.setComponent(v, point.getComponent(v));
  });
}

export function applyHookModifier(source, options = {}, context = {}) {
  if (!context.targetMatrix) return source.clone();
  const target = matrixOrigin(context.targetMatrix, context.sourceMatrix);
  const strength = clamp01(options.strength ?? 1);
  return editPositions(source, (point) => {
    const weight = strength * falloffWeight(point.distanceTo(target), Number(options.radius), options.falloff);
    point.lerp(target, weight);
  });
}

export function applyLaplacianDeformModifier(source, options = {}) {
  let result = source.clone();
  const count = Math.max(1, Math.min(50, Math.floor(options.iterations ?? 1)));
  const factor = clamp01(options.strength ?? 1);
  for (let i = 0; i < count; i++) result = laplacianPass(result, factor);
  return finish(result);
}

export function applyLatticeModifier(source, options = {}, context = {}) {
  source.computeBoundingBox();
  const box = source.boundingBox;
  const height = Math.max(1e-6, box.max.z - box.min.z);
  const strength = clamp01(options.strength ?? 1);
  const targetTransform = context.targetMatrix ? sourceSpaceMatrix(context.targetMatrix, context.sourceMatrix) : null;
  // Deterministic procedural cage fallback: Z-normalized bulge/twist, followed by
  // the supplied lattice object's transform when one is present.
  return editPositions(source, (point) => {
    const t = (point.z - box.min.z) / height;
    const envelope = 4 * t * (1 - t);
    const scale = 1 + (Number(options.bulge) || 0) * envelope * strength;
    const angle = (Number(options.twist) || 0) * t * strength;
    const x = point.x * scale, y = point.y * scale;
    point.set(x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), point.z);
    if (targetTransform) point.lerp(point.clone().applyMatrix4(targetTransform), strength);
  });
}

function applyNearestTargetDeform(source, options, context, normalOffset = true) {
  const matrix = sourceSpaceMatrix(context.targetMatrix, context.sourceMatrix);
  const points = nearestTargetData(context.targetGeometry, matrix);
  if (!points?.length) return source.clone();
  const strength = clamp01(options.strength ?? 1);
  const offset = Number(options.offset) || 0;
  return editPositions(source, (point, normal) => {
    const nearest = nearestPoint(point, points);
    if (!nearest) return;
    const destination = nearest.clone();
    if (normalOffset) destination.addScaledVector(normal, offset);
    point.lerp(destination, strength);
  });
}

/** Mesh cage fallback: closest cage samples replace unavailable harmonic binds. */
export function applyMeshDeformModifier(source, options = {}, context = {}) {
  return applyNearestTargetDeform(source, options, context, false);
}

/** Nearest sampled surface approximation; deterministic and topology agnostic. */
export function applyShrinkwrapModifier(source, options = {}, context = {}) {
  return applyNearestTargetDeform(source, options, context, true);
}

export function applyCorrectiveSmoothModifier(source, options = {}) {
  const factor = Number(options.factor) || 0;
  const iterations = Math.max(1, Math.min(50, Math.floor(options.iterations ?? 5)));
  const original = source.getAttribute("position");
  let result = source.clone();
  for (let i = 0; i < iterations; i++) result = laplacianPass(result, factor);
  // Blend some original detail back in (HC-style correction).
  const position = result.getAttribute("position");
  const scale = clamp01(options.scale ?? 1);
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(i,
      THREE.MathUtils.lerp(position.getX(i), original.getX(i), 1 - scale),
      THREE.MathUtils.lerp(position.getY(i), original.getY(i), 1 - scale),
      THREE.MathUtils.lerp(position.getZ(i), original.getZ(i), 1 - scale));
  }
  position.needsUpdate = true;
  return finish(result);
}

export function applyLaplacianSmoothModifier(source, options = {}) {
  source.computeBoundingBox();
  const before = source.boundingBox.getSize(new THREE.Vector3());
  let result = source.clone();
  const axes = [options.x !== false, options.y !== false, options.z !== false];
  const count = Math.max(1, Math.min(50, Math.floor(options.iterations ?? 1)));
  for (let i = 0; i < count; i++) result = laplacianPass(result, Number(options.factor) || 0, axes);
  if (options.preserveVolume) {
    result.computeBoundingBox();
    const after = result.boundingBox.getSize(new THREE.Vector3());
    const beforeVolume = before.x * before.y * before.z;
    const afterVolume = after.x * after.y * after.z;
    if (beforeVolume > 1e-12 && afterVolume > 1e-12) result.scale(...new Array(3).fill(Math.cbrt(beforeVolume / afterVolume)));
  }
  return finish(result);
}

/** Surface Deform uses nearest target samples until persistent bind data exists. */
export function applySurfaceDeformModifier(source, options = {}, context = {}) {
  return applyNearestTargetDeform(source, options, context, true);
}

function hashNoise(x, y, z, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453123;
  return n - Math.floor(n);
}

export function applyVolumeDisplaceModifier(source, options = {}) {
  const scale = Math.max(1e-6, Number(options.scale) || 1);
  const strength = Number(options.strength) || 0;
  const axis = AXIS[options.direction];
  return editPositions(source, (point, normal) => {
    const amount = (hashNoise(point.x * scale, point.y * scale, point.z * scale, Number(options.seed) || 0) - (Number(options.midlevel) || 0)) * strength;
    if (axis === undefined) point.addScaledVector(normal, amount);
    else point.setComponent(axis, point.getComponent(axis) + amount);
  });
}

export function applyWarpModifier(source, options = {}, context = {}) {
  if (!context.fromMatrix || !context.toMatrix) return source.clone();
  const from = sourceSpaceMatrix(context.fromMatrix, context.sourceMatrix);
  const to = sourceSpaceMatrix(context.toMatrix, context.sourceMatrix);
  const transform = new THREE.Matrix4().copy(to).multiply(from.clone().invert());
  const origin = new THREE.Vector3().setFromMatrixPosition(from);
  const strength = Number(options.strength) || 0;
  return editPositions(source, (point) => {
    const weight = strength * falloffWeight(point.distanceTo(origin), Number(options.radius), options.falloff);
    point.lerp(point.clone().applyMatrix4(transform), weight);
  });
}

export function applyArmatureModifier(source, options = {}, context = {}) {
  const skinIndex = source.getAttribute("skinIndex");
  const skinWeight = source.getAttribute("skinWeight");
  const matrices = context.boneMatrices;
  if (!skinIndex || !skinWeight || !matrices?.length) return source.clone();
  const strength = clamp01(options.strength ?? 1);
  return editPositions(source, (point, _normal, vertex) => {
    const skinned = new THREE.Vector3();
    let total = 0;
    for (let slot = 0; slot < Math.min(4, skinIndex.itemSize); slot++) {
      const bone = skinIndex.getComponent(vertex, slot);
      const weight = skinWeight.getComponent(vertex, slot);
      const matrix = matrices[bone];
      if (matrix && weight > 0) { skinned.addScaledVector(point.clone().applyMatrix4(matrix), weight); total += weight; }
    }
    if (total > 0) point.lerp(skinned.multiplyScalar(1 / total), strength);
  });
}

const DISPATCH = {
  curve: applyCurveModifier, hook: applyHookModifier, laplacianDeform: applyLaplacianDeformModifier,
  lattice: applyLatticeModifier, meshDeform: applyMeshDeformModifier, shrinkwrap: applyShrinkwrapModifier,
  correctiveSmooth: applyCorrectiveSmoothModifier, laplacianSmooth: applyLaplacianSmoothModifier,
  surfaceDeform: applySurfaceDeformModifier, volumeDisplace: applyVolumeDisplaceModifier,
  warp: applyWarpModifier, armature: applyArmatureModifier,
};

export function applyDeformModifier(source, modifier, context = {}) {
  const apply = DISPATCH[modifier?.type];
  return apply ? apply(source, modifier, context) : source.clone();
}

export function isDeformModifier(type) {
  return !!DISPATCH[type];
}
