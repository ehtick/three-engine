import * as THREE from "three/webgpu";

export const NORMAL_MODIFIER_DEFINITIONS = [
  { type: "normalEdit", label: "Normal Edit", defaults: {
    mode: "radial", target: "", parallel: false, offset: [0, 0, 0],
    mixMode: "replace", mixFactor: 1, mixLimit: 180,
  }, fields: [
    { key: "mode", label: "Mode", type: "select", options: ["radial", "directional"] },
    { key: "target", label: "Target", type: "entity" },
    { key: "parallel", label: "Parallel Normals", type: "boolean", showIf: (p) => p.mode === "directional" },
    { key: "offset", label: "Offset", type: "vec3" },
    { key: "mixMode", label: "Mix Mode", type: "select", options: ["replace", "add", "subtract", "multiply"] },
    { key: "mixFactor", label: "Mix Factor", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "mixLimit", label: "Max Angle°", type: "number", min: 0, max: 180, step: 1 },
  ] },
  { type: "smoothByAngle", label: "Smooth by Angle", defaults: {
    angle: 30, ignoreSharpness: false,
  }, fields: [
    { key: "angle", label: "Angle°", type: "number", min: 0, max: 180, step: 1 },
    { key: "ignoreSharpness", label: "Ignore Sharpness", type: "boolean" },
  ] },
];

function finish(geometry, recompute = false) {
  if (recompute) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function mixNormal(current, desired, mode, factor) {
  const mixed = new THREE.Vector3();
  if (mode === "add") mixed.copy(current).add(desired);
  else if (mode === "subtract") mixed.copy(current).sub(desired);
  else if (mode === "multiply") mixed.set(current.x * desired.x, current.y * desired.y, current.z * desired.z);
  else mixed.copy(desired);
  if (mixed.lengthSq() < 1e-12) mixed.copy(current);
  mixed.normalize();
  return current.clone().lerp(mixed, THREE.MathUtils.clamp(factor, 0, 1)).normalize();
}

export function applyNormalEditModifier(source, settings = {}, context = {}) {
  const result = source.clone();
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  const position = result.getAttribute("position");
  const normal = result.getAttribute("normal");
  if (!position || !normal) return finish(result);

  const target = (context.targetPoint?.clone?.() ?? new THREE.Vector3()).add(
    new THREE.Vector3().fromArray(settings.offset ?? [0, 0, 0]),
  );
  const mode = settings.mode ?? "radial";
  const parallel = !!settings.parallel;
  const factor = Number(settings.mixFactor ?? 1);
  const maxAngle = THREE.MathUtils.degToRad(Number(settings.mixLimit ?? 180));
  const point = new THREE.Vector3();
  const current = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const constantDirection = target.clone().normalize();

  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index);
    current.fromBufferAttribute(normal, index).normalize();
    if (mode === "directional") {
      desired.copy(parallel ? constantDirection : target.clone().sub(point));
    } else desired.copy(point).sub(target);
    if (desired.lengthSq() < 1e-12) continue;
    desired.normalize();
    if (current.angleTo(desired) > maxAngle) continue;
    const value = mixNormal(current, desired, settings.mixMode, factor);
    normal.setXYZ(index, value.x, value.y, value.z);
  }
  normal.needsUpdate = true;
  return finish(result);
}

const positionKey = (attribute, index) =>
  `${Math.round(attribute.getX(index) * 1e6)},${Math.round(attribute.getY(index) * 1e6)},${Math.round(attribute.getZ(index) * 1e6)}`;

/**
 * Produces split custom normals while retaining the original topology. Corners
 * sharing a position are averaged only across faces inside the angle limit.
 */
export function applySmoothByAngleModifier(source, settings = {}) {
  const result = source.toNonIndexed();
  const position = result.getAttribute("position");
  if (!position) return finish(result);
  const faceCount = Math.floor(position.count / 3);
  const faceNormals = Array.from({ length: faceCount }, () => new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let face = 0; face < faceCount; face++) {
    a.fromBufferAttribute(position, face * 3);
    b.fromBufferAttribute(position, face * 3 + 1);
    c.fromBufferAttribute(position, face * 3 + 2);
    faceNormals[face].crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
  }
  const corners = new Map();
  for (let index = 0; index < position.count; index++) {
    const key = positionKey(position, index);
    if (!corners.has(key)) corners.set(key, []);
    corners.get(key).push(index);
  }
  const threshold = Math.cos(THREE.MathUtils.degToRad(Number(settings.angle ?? 30)));
  const normals = new Float32Array(position.count * 3);
  for (const indices of corners.values()) {
    for (const index of indices) {
      const base = faceNormals[Math.floor(index / 3)];
      const value = new THREE.Vector3();
      for (const candidate of indices) {
        const other = faceNormals[Math.floor(candidate / 3)];
        if (base.dot(other) >= threshold) value.add(other);
      }
      value.normalize();
      normals[index * 3] = value.x;
      normals[index * 3 + 1] = value.y;
      normals[index * 3 + 2] = value.z;
    }
  }
  result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return finish(result);
}

export function evaluateNormalModifier(source, modifier, context = {}) {
  if (modifier.type === "normalEdit") return applyNormalEditModifier(source, modifier, context);
  if (modifier.type === "smoothByAngle") return applySmoothByAngleModifier(source, modifier);
  return null;
}
