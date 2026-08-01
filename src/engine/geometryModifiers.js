import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { EdgeSplitModifier } from "three/addons/modifiers/EdgeSplitModifier.js";
import { SimplifyModifier } from "three/addons/modifiers/SimplifyModifier.js";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { LoopSubdivision } from "three-subdivide";
import {
  GEOMETRY_GENERATE_MODIFIER_DEFINITIONS,
  applyBevelModifier,
  evaluateGenerateGeometryModifier,
} from "./geometryModifiersGenerate.js";
import {
  DEFORM_MODIFIER_DEFINITIONS,
  applyDeformModifier,
  isDeformModifier,
} from "./geometryModifiersDeform.js";
import {
  NORMAL_MODIFIER_DEFINITIONS,
  evaluateNormalModifier,
} from "./geometryModifiersNormals.js";

export { applyBevelModifier };

const BOOLEAN_OPERATIONS = {
  union: ADDITION,
  subtract: SUBTRACTION,
  intersect: INTERSECTION,
};

const AXIS_INDEX = { x: 0, y: 1, z: 2 };
const OTHER_AXES = { x: [1, 2], y: [2, 0], z: [0, 1] };

const CORE_GEOMETRY_MODIFIER_DEFINITIONS = [
  { type: "mirror", label: "Mirror", defaults: { x: true, y: false, z: false, bisectX: false, bisectY: false, bisectZ: false, flipX: false, flipY: false, flipZ: false, mirrorObject: "", clipping: false, merge: true, mergeDistance: 0.0001, mirrorU: false, mirrorV: false, mirrorUOffset: 0, mirrorVOffset: 0 }, fields: [
    { key: "x", label: "X Axis", type: "boolean" },
    { key: "y", label: "Y Axis", type: "boolean" },
    { key: "z", label: "Z Axis", type: "boolean" },
    { key: "bisectX", label: "Bisect X", type: "boolean", showIf: (p) => p.x },
    { key: "flipX", label: "Flip X Bisect", type: "boolean", showIf: (p) => p.x && p.bisectX },
    { key: "bisectY", label: "Bisect Y", type: "boolean", showIf: (p) => p.y },
    { key: "flipY", label: "Flip Y Bisect", type: "boolean", showIf: (p) => p.y && p.bisectY },
    { key: "bisectZ", label: "Bisect Z", type: "boolean", showIf: (p) => p.z },
    { key: "flipZ", label: "Flip Z Bisect", type: "boolean", showIf: (p) => p.z && p.bisectZ },
    { key: "mirrorObject", label: "Mirror Object", type: "entity" },
    { key: "clipping", label: "Clipping", type: "boolean" },
    { key: "merge", label: "Merge", type: "boolean" },
    { key: "mergeDistance", label: "Merge Distance", type: "number", min: 0, step: 0.0001, showIf: (p) => p.merge },
    { key: "mirrorU", label: "Mirror U", type: "boolean" },
    { key: "mirrorV", label: "Mirror V", type: "boolean" },
    { key: "mirrorUOffset", label: "U Offset", type: "number", step: 0.05, showIf: (p) => p.mirrorU },
    { key: "mirrorVOffset", label: "V Offset", type: "number", step: 0.05, showIf: (p) => p.mirrorV },
  ] },
  { type: "boolean", label: "Boolean", defaults: { operation: "union", target: "" }, fields: [
    { key: "operation", label: "Operation", type: "select", options: ["union", "subtract", "intersect"] },
    { key: "target", label: "Target", type: "entity", meshOnly: true, emptyLabel: "— None —" },
  ] },
  { type: "array", label: "Array", defaults: { fitType: "count", count: 2, length: 2, fitCurve: "", useRelativeOffset: true, relativeOffset: [1, 0, 0], useConstantOffset: false, constantOffset: [0, 0, 0], objectOffset: "", startCap: "", endCap: "", merge: false, mergeFirstLast: false, mergeDistance: 0.001, uvOffset: [0, 0, 0] }, fields: [
    { key: "fitType", label: "Fit Type", type: "select", options: ["count", "length", "curve"] },
    { key: "count", label: "Count", type: "number", min: 1, max: 256, step: 1, showIf: (p) => p.fitType === "count" },
    { key: "length", label: "Length", type: "number", min: 0, step: 0.1, showIf: (p) => p.fitType === "length" },
    { key: "fitCurve", label: "Fit Curve", type: "entity", showIf: (p) => p.fitType === "curve" },
    { key: "useRelativeOffset", label: "Relative Offset", type: "boolean" },
    { key: "relativeOffset", label: "Relative", type: "vec3", showIf: (p) => p.useRelativeOffset },
    { key: "useConstantOffset", label: "Constant Offset", type: "boolean" },
    { key: "constantOffset", label: "Constant", type: "vec3", showIf: (p) => p.useConstantOffset },
    { key: "objectOffset", label: "Object Offset", type: "entity" },
    { key: "startCap", label: "Start Cap", type: "entity", meshOnly: true },
    { key: "endCap", label: "End Cap", type: "entity", meshOnly: true },
    { key: "merge", label: "Merge", type: "boolean" },
    { key: "mergeDistance", label: "Merge Distance", type: "number", min: 0, step: 0.0001, showIf: (p) => p.merge },
    { key: "mergeFirstLast", label: "First and Last Copies", type: "boolean", showIf: (p) => p.merge },
    { key: "uvOffset", label: "UV Offset", type: "vec3" },
  ] },
  { type: "solidify", label: "Solidify", defaults: { thickness: 0.1, offset: -1, evenThickness: false, clamp: 0, flipNormals: false, qualityNormals: true, fillRim: true, onlyRim: false, materialOffset: 0, rimMaterialOffset: 0 }, fields: [
    { key: "thickness", label: "Thickness", type: "number", step: 0.01 },
    { key: "offset", label: "Offset", type: "number", min: -1, max: 1, step: 0.1 },
    { key: "evenThickness", label: "Even Thickness", type: "boolean" },
    { key: "clamp", label: "Thickness Clamp", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "flipNormals", label: "Flip Normals", type: "boolean" },
    { key: "qualityNormals", label: "High Quality Normals", type: "boolean" },
    { key: "fillRim", label: "Fill Rim", type: "boolean" },
    { key: "onlyRim", label: "Only Rim", type: "boolean", showIf: (p) => p.fillRim },
    { key: "materialOffset", label: "Shell Material Offset", type: "number", min: 0, step: 1 },
    { key: "rimMaterialOffset", label: "Rim Material Offset", type: "number", min: 0, step: 1, showIf: (p) => p.fillRim },
  ] },
  { type: "subdivision", label: "Subdivision Surface", defaults: { method: "catmullClark", levels: 1, uvSmooth: true, preserveEdges: false }, fields: [
    { key: "method", label: "Method", type: "select", options: ["catmullClark", "simple"] },
    { key: "levels", label: "Levels", type: "number", min: 0, max: 4, step: 1 },
    { key: "uvSmooth", label: "Smooth UVs", type: "boolean" },
    { key: "preserveEdges", label: "Keep Boundaries", type: "boolean" },
  ] },
  { type: "smooth", label: "Smooth", defaults: { iterations: 1, factor: 0.5, x: true, y: true, z: true }, fields: [
    { key: "iterations", label: "Iterations", type: "number", min: 0, max: 50, step: 1 },
    { key: "factor", label: "Factor", type: "number", min: -2, max: 2, step: 0.05 },
    { key: "x", label: "X Axis", type: "boolean" },
    { key: "y", label: "Y Axis", type: "boolean" },
    { key: "z", label: "Z Axis", type: "boolean" },
  ] },
  { type: "simpleDeform", label: "Simple Deform", defaults: { method: "twist", axis: "z", factor: 0.7854, lowerLimit: 0, upperLimit: 1, lockX: false, lockY: false }, fields: [
    { key: "method", label: "Method", type: "select", options: ["twist", "bend", "taper", "stretch"] },
    { key: "axis", label: "Axis", type: "select", options: ["x", "y", "z"] },
    { key: "factor", label: "Factor / Angle", type: "number", step: 0.1 },
    { key: "lowerLimit", label: "Lower Limit", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "upperLimit", label: "Upper Limit", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "lockX", label: "Lock Perpendicular 1", type: "boolean" },
    { key: "lockY", label: "Lock Perpendicular 2", type: "boolean" },
  ] },
  { type: "cast", label: "Cast", defaults: { shape: "sphere", factor: 0.5, radius: 1, x: true, y: true, z: true }, fields: [
    { key: "shape", label: "Shape", type: "select", options: ["sphere", "cylinder", "cuboid"] },
    { key: "factor", label: "Factor", type: "number", min: -1, max: 1, step: 0.05 },
    { key: "radius", label: "Radius", type: "number", min: 0.0001, step: 0.1 },
    { key: "x", label: "X Axis", type: "boolean" },
    { key: "y", label: "Y Axis", type: "boolean" },
    { key: "z", label: "Z Axis", type: "boolean" },
  ] },
  { type: "displace", label: "Displace", defaults: { coordinates: "local", direction: "normal", strength: 0.1, midlevel: 0.5, noiseScale: 1, seed: 0 }, fields: [
    { key: "coordinates", label: "Coordinates", type: "select", options: ["local", "global"] },
    { key: "direction", label: "Direction", type: "select", options: ["normal", "x", "y", "z", "rgbToXyz"] },
    { key: "strength", label: "Strength", type: "number", step: 0.05 },
    { key: "midlevel", label: "Midlevel", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "noiseScale", label: "Texture Scale", type: "number", min: 0.0001, step: 0.1 },
    { key: "seed", label: "Noise Seed", type: "number", step: 1 },
  ] },
  { type: "wave", label: "Wave", defaults: { motion: "both", cyclic: false, displacementAxis: "z", startPosition: [0, 0, 0], startObject: "", height: 0.1, width: 1, narrowness: 1, phase: 0, speed: 1, time: 0, timeOffset: 0, lifetime: 0, damping: 0, falloff: 0 }, fields: [
    { key: "motion", label: "Motion", type: "select", options: ["both", "x", "y"] },
    { key: "cyclic", label: "Cyclic", type: "boolean" },
    { key: "displacementAxis", label: "Displace Axis", type: "select", options: ["x", "y", "z"] },
    { key: "startPosition", label: "Start Position", type: "vec3" },
    { key: "startObject", label: "Start Object", type: "entity" },
    { key: "height", label: "Height", type: "number", step: 0.05 },
    { key: "width", label: "Width", type: "number", min: 0.0001, step: 0.1 },
    { key: "narrowness", label: "Narrowness", type: "number", min: 0.01, step: 0.1 },
    { key: "phase", label: "Phase", type: "number", step: 0.1 },
    { key: "speed", label: "Speed", type: "number", step: 0.1 },
    { key: "time", label: "Time", type: "number", step: 0.1 },
    { key: "timeOffset", label: "Time Offset", type: "number", step: 0.1 },
    { key: "lifetime", label: "Lifetime", type: "number", min: 0, step: 0.1 },
    { key: "damping", label: "Damping", type: "number", min: 0, step: 0.1 },
    { key: "falloff", label: "Falloff", type: "number", min: 0, step: 0.1 },
  ] },
  { type: "decimate", label: "Decimate", defaults: { mode: "collapse", ratio: 0.5, iterations: 1, angle: 5, triangulate: true, symmetry: false, symmetryAxis: "x" }, fields: [
    { key: "mode", label: "Mode", type: "select", options: ["collapse", "unsubdivide", "planar"] },
    { key: "ratio", label: "Ratio", type: "number", min: 0.01, max: 1, step: 0.05, showIf: (p) => p.mode === "collapse" },
    { key: "iterations", label: "Iterations", type: "number", min: 1, max: 8, step: 1, showIf: (p) => p.mode === "unsubdivide" },
    { key: "angle", label: "Angle Limit°", type: "number", min: 0, max: 180, step: 1, showIf: (p) => p.mode === "planar" },
    { key: "triangulate", label: "Triangulate", type: "boolean" },
    { key: "symmetry", label: "Symmetry", type: "boolean", showIf: (p) => p.mode === "collapse" },
    { key: "symmetryAxis", label: "Symmetry Axis", type: "select", options: ["x", "y", "z"], showIf: (p) => p.mode === "collapse" && p.symmetry },
  ] },
  { type: "weld", label: "Weld", defaults: { threshold: 0.0001 }, fields: [
    { key: "threshold", label: "Distance", type: "number", min: 0, step: 0.0001 },
  ] },
  { type: "edgeSplit", label: "Edge Split", defaults: { useAngle: true, angle: 30 }, fields: [
    { key: "useAngle", label: "Edge Angle", type: "boolean" },
    { key: "angle", label: "Split Angle°", type: "number", min: 0, max: 180, step: 1 },
  ] },
  { type: "weightedNormal", label: "Weighted Normal", defaults: { mode: "faceArea", weight: 50, threshold: 0.01 }, fields: [
    { key: "mode", label: "Weighting Mode", type: "select", options: ["faceArea", "cornerAngle", "faceAreaAndAngle"] },
    { key: "weight", label: "Weight", type: "number", min: 1, max: 100, step: 1 },
    { key: "threshold", label: "Threshold", type: "number", min: 0, max: 1, step: 0.01 },
  ] },
];

const VERTEX_GROUP_MODIFIERS = new Set([
  "solidify", "smooth", "simpleDeform", "cast", "displace", "wave", "decimate", "weld", "weightedNormal",
  "bevel", "mask", "hook", "laplacianDeform", "lattice", "meshDeform", "shrinkwrap", "correctiveSmooth",
  "laplacianSmooth", "surfaceDeform", "warp", "armature", "normalEdit",
]);

const GEOMETRY_NODES_DEFINITION = {
  type: "geometryNodes",
  label: "Geometry Nodes",
  defaults: { nodeGroup: "[]", inputs: "{}" },
  fields: [
    { key: "nodeGroup", label: "Node Group (JSON)", type: "text" },
    { key: "inputs", label: "Exposed Inputs (JSON)", type: "text" },
  ],
};

const addSharedModifierFields = (definition) => {
  if (!VERTEX_GROUP_MODIFIERS.has(definition.type) || definition.fields.some((field) => field.key === "vertexGroup")) return definition;
  return {
    ...definition,
    defaults: { ...definition.defaults, vertexGroup: "", invertVertexGroup: false },
    fields: [
      ...definition.fields,
      { key: "vertexGroup", label: "Vertex Group / Attribute", type: "text" },
      { key: "invertVertexGroup", label: "Invert Vertex Group", type: "boolean", showIf: (p) => !!p.vertexGroup },
    ],
  };
};

export const GEOMETRY_MODIFIER_DEFINITIONS = [
  ...CORE_GEOMETRY_MODIFIER_DEFINITIONS,
  GEOMETRY_NODES_DEFINITION,
  ...GEOMETRY_GENERATE_MODIFIER_DEFINITIONS,
  ...DEFORM_MODIFIER_DEFINITIONS,
  ...NORMAL_MODIFIER_DEFINITIONS,
].map(addSharedModifierFields);

const MODIFIER_DEFINITION_BY_TYPE = new Map(GEOMETRY_MODIFIER_DEFINITIONS.map((definition) => [definition.type, definition]));
let modifierSerial = 0;

export function createGeometryModifier(type, values = {}) {
  const definition = MODIFIER_DEFINITION_BY_TYPE.get(type);
  if (!definition) return null;
  const id = values.id || globalThis.crypto?.randomUUID?.() || `modifier-${Date.now()}-${++modifierSerial}`;
  return { id, type, enabled: values.enabled !== false, expanded: values.expanded !== false, ...structuredClone(definition.defaults), ...values };
}

/** Converts the original fixed-stack props to the ordered stack format. */
export function normalizeGeometryModifierStack(props = {}) {
  if (Array.isArray(props.modifiers)) {
    return props.modifiers.map((modifier) => createGeometryModifier(modifier?.type, modifier)).filter(Boolean);
  }
  const result = [];
  const add = (type, active, values) => { if (active) result.push(createGeometryModifier(type, values)); };
  add("mirror", props.mirrorAxis && props.mirrorAxis !== "none", { x: props.mirrorAxis === "x", y: props.mirrorAxis === "y", z: props.mirrorAxis === "z", mergeDistance: props.mirrorMergeDistance });
  add("boolean", props.booleanOperation && props.booleanOperation !== "none", { operation: props.booleanOperation, target: props.booleanTarget });
  add("array", (props.arrayCount ?? 1) > 1, { count: props.arrayCount, useRelativeOffset: false, useConstantOffset: true, constantOffset: props.arrayOffset });
  add("solidify", Math.abs(props.solidifyThickness ?? 0) > 1e-8, { thickness: props.solidifyThickness, offset: props.solidifyOffset });
  add("subdivision", (props.subdivisionLevels ?? 0) > 0, { levels: props.subdivisionLevels });
  add("smooth", (props.smoothIterations ?? 0) > 0, { iterations: props.smoothIterations, factor: props.smoothFactor });
  add("simpleDeform", props.simpleDeformMethod && props.simpleDeformMethod !== "none", { method: props.simpleDeformMethod, axis: props.simpleDeformAxis, factor: props.simpleDeformFactor });
  add("cast", props.castType && props.castType !== "none", { shape: props.castType, factor: props.castFactor, radius: props.castRadius });
  add("displace", !!Number(props.displaceStrength), { strength: props.displaceStrength, midlevel: props.displaceMidlevel, seed: props.displaceSeed });
  add("wave", !!Number(props.waveHeight), { height: props.waveHeight, width: props.waveWidth, displacementAxis: props.waveAxis, phase: props.wavePhase });
  add("decimate", (props.decimateRatio ?? 1) < 0.999, { ratio: props.decimateRatio });
  add("weld", Number(props.weldThreshold) > 0, { threshold: props.weldThreshold });
  add("edgeSplit", (props.edgeSplitAngle ?? 180) < 179.999, { angle: props.edgeSplitAngle });
  add("weightedNormal", !!props.weightedNormals, {});
  return result;
}

function triangleCount(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position")?.count / 3 || 0;
}

function finishGeometry(geometry, normals = true) {
  if (normals && geometry.getAttribute("position")) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function ensureBrushAttributes(geometry) {
  const result = geometry.clone();
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  if (!result.getAttribute("uv")) {
    const count = result.getAttribute("position")?.count ?? 0;
    result.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return result;
}

function reverseWinding(geometry) {
  if (geometry.index) {
    const index = geometry.index;
    for (let i = 0; i < index.count; i += 3) {
      const value = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, value);
    }
    index.needsUpdate = true;
    return geometry;
  }
  for (const attribute of Object.values(geometry.attributes)) {
    for (let i = 0; i < attribute.count; i += 3) {
      for (let component = 0; component < attribute.itemSize; component++) {
        const value = attribute.getComponent(i + 1, component);
        attribute.setComponent(i + 1, component, attribute.getComponent(i + 2, component));
        attribute.setComponent(i + 2, component, value);
      }
    }
    attribute.needsUpdate = true;
  }
  return geometry;
}

function transformedClone(source, matrix, reverse = false) {
  const result = source.clone();
  result.applyMatrix4(matrix);
  if (reverse) reverseWinding(result);
  return result;
}

function filterTriangles(source, keep) {
  const input = source.toNonIndexed();
  const position = input.getAttribute("position");
  if (!position) return input;
  const selected = [];
  const center = new THREE.Vector3();
  const point = new THREE.Vector3();
  for (let triangle = 0; triangle < position.count / 3; triangle++) {
    center.set(0, 0, 0);
    for (let corner = 0; corner < 3; corner++) center.add(point.fromBufferAttribute(position, triangle * 3 + corner));
    center.multiplyScalar(1 / 3);
    if (keep(center)) selected.push(triangle);
  }
  const result = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(input.attributes)) {
    const ArrayType = attribute.array.constructor;
    const values = new ArrayType(selected.length * 3 * attribute.itemSize);
    let cursor = 0;
    for (const triangle of selected) for (let corner = 0; corner < 3; corner++) {
      const index = triangle * 3 + corner;
      for (let component = 0; component < attribute.itemSize; component++) values[cursor++] = attribute.getComponent(index, component);
    }
    result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
  }
  input.dispose();
  return result;
}

function modifyPositions(source, callback, recomputeNormals = true) {
  const result = source.clone();
  const position = result.getAttribute("position");
  if (!position) return result;
  if (recomputeNormals && !result.getAttribute("normal")) result.computeVertexNormals();
  const normal = result.getAttribute("normal");
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index);
    if (normal) direction.fromBufferAttribute(normal, index);
    callback(point, direction, index);
    position.setXYZ(index, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  return finishGeometry(result, recomputeNormals);
}

export function applyBooleanModifier(source, target, operation, targetToSource = new THREE.Matrix4()) {
  const operationCode = BOOLEAN_OPERATIONS[operation];
  if (!operationCode || !source?.getAttribute?.("position") || !target?.getAttribute?.("position")) return source.clone();
  const sourceGeometry = ensureBrushAttributes(source);
  const targetGeometry = ensureBrushAttributes(target);
  targetGeometry.applyMatrix4(targetToSource);
  sourceGeometry.clearGroups();
  targetGeometry.clearGroups();
  const sourceBrush = new Brush(sourceGeometry);
  const targetBrush = new Brush(targetGeometry);
  sourceBrush.updateMatrixWorld(true);
  targetBrush.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal", "uv"];
  evaluator.useGroups = false;
  const result = evaluator.evaluate(sourceBrush, targetBrush, operationCode).geometry;
  sourceGeometry.dispose();
  targetGeometry.dispose();
  finishGeometry(result);
  if (triangleCount(result)) result.addGroup(0, triangleCount(result) * 3, 0);
  return result;
}

/** Blender-style Mirror around the object's local origin. */
export function applyMirrorModifier(source, settings = "none", legacyMergeDistance = 0.0001, context = {}) {
  const options = typeof settings === "string"
    ? { x: settings === "x", y: settings === "y", z: settings === "z", merge: true, mergeDistance: legacyMergeDistance }
    : settings ?? {};
  const axes = [!!options.x, !!options.y, !!options.z];
  const active = axes.reduce((count, enabled) => count + Number(enabled), 0);
  if (!active) return source.clone();
  const geometries = [];
  const planeMatrix = context.references?.mirrorObject?.matrix?.clone?.() ?? new THREE.Matrix4();
  const inversePlane = planeMatrix.clone().invert();
  const bisect = [!!options.bisectX, !!options.bisectY, !!options.bisectZ];
  const flip = [!!options.flipX, !!options.flipY, !!options.flipZ];
  const local = new THREE.Vector3();
  let working = bisect.some(Boolean) ? filterTriangles(source, (point) => {
    local.copy(point).applyMatrix4(inversePlane);
    return bisect.every((enabled, axis) => !enabled || (flip[axis] ? local.getComponent(axis) <= 1e-6 : local.getComponent(axis) >= -1e-6));
  }) : source.clone();
  if (options.clipping) {
    const position = working.getAttribute("position");
    const tolerance = Math.max(0, Number(options.mergeDistance) || 0);
    for (let index = 0; position && index < position.count; index++) {
      local.fromBufferAttribute(position, index).applyMatrix4(inversePlane);
      let changed = false;
      axes.forEach((enabled, axis) => {
        if (enabled && Math.abs(local.getComponent(axis)) <= tolerance) { local.setComponent(axis, 0); changed = true; }
      });
      if (changed) {
        local.applyMatrix4(planeMatrix);
        position.setXYZ(index, local.x, local.y, local.z);
      }
    }
    if (position) position.needsUpdate = true;
  }
  const combinations = 1 << active;
  const activeIndices = axes.map((enabled, index) => enabled ? index : -1).filter((index) => index >= 0);
  for (let mask = 0; mask < combinations; mask++) {
    const scale = [1, 1, 1];
    let reflections = 0;
    activeIndices.forEach((axisIndex, bit) => {
      if (mask & (1 << bit)) { scale[axisIndex] = -1; reflections++; }
    });
    const reflection = planeMatrix.clone().multiply(new THREE.Matrix4().makeScale(...scale)).multiply(inversePlane);
    const geometry = transformedClone(working, reflection, reflections % 2 === 1);
    if (mask && geometry.getAttribute("uv") && (options.mirrorU || options.mirrorV)) {
      const uv = geometry.getAttribute("uv");
      for (let index = 0; index < uv.count; index++) {
        if (options.mirrorU) uv.setX(index, 1 - uv.getX(index) + (Number(options.mirrorUOffset) || 0));
        if (options.mirrorV) uv.setY(index, 1 - uv.getY(index) + (Number(options.mirrorVOffset) || 0));
      }
      uv.needsUpdate = true;
    }
    geometries.push(geometry);
  }
  let result = mergeGeometries(geometries, true);
  geometries.forEach((geometry) => geometry.dispose());
  working.dispose();
  if (!result) throw new Error("Mirror modifier could not merge incompatible geometry attributes");
  const tolerance = Math.max(0, Number(options.mergeDistance) || 0);
  if (options.merge !== false && tolerance > 0) {
    const welded = mergeVertices(result, tolerance);
    result.dispose();
    result = welded;
  }
  return finishGeometry(result);
}

export function applyArrayModifier(source, settings = 1, legacyOffset = [1, 0, 0], context = {}) {
  const options = typeof settings === "object"
    ? settings
    : { count: settings, useRelativeOffset: false, useConstantOffset: true, constantOffset: legacyOffset };
  source.computeBoundingBox();
  const size = source.boundingBox.getSize(new THREE.Vector3());
  const relative = new THREE.Vector3().fromArray(options.relativeOffset ?? options.offset ?? [1, 0, 0]);
  const constant = new THREE.Vector3().fromArray(options.constantOffset ?? [0, 0, 0]);
  const step = new THREE.Vector3();
  if (options.useRelativeOffset !== false) step.add(relative.multiply(size));
  if (options.useConstantOffset) step.add(constant);
  const translation = new THREE.Matrix4().makeTranslation(step.x, step.y, step.z);
  const objectMatrix = context.references?.objectOffset?.matrix;
  const increment = objectMatrix ? translation.clone().multiply(objectMatrix) : translation;
  let requested = Number(options.count) || 1;
  if (options.fitType === "length") requested = step.length() > 1e-8 ? Math.floor(Math.max(0, Number(options.length) || 0) / step.length()) + 1 : 1;
  if (options.fitType === "curve") {
    const curve = context.references?.fitCurve?.geometry;
    curve?.computeBoundingBox?.();
    const curveLength = curve?.boundingBox?.getSize(new THREE.Vector3()).length() ?? 0;
    requested = step.length() > 1e-8 ? Math.floor(curveLength / step.length()) + 1 : 1;
  }
  const copies = THREE.MathUtils.clamp(Math.round(requested), 1, 256);
  if (copies === 1 && !context.references?.startCap?.geometry && !context.references?.endCap?.geometry && !objectMatrix) return source.clone();
  const geometries = [];
  let copyMatrix = new THREE.Matrix4();
  for (let index = 0; index < copies; index++) {
    const geometry = transformedClone(source, copyMatrix);
    const uv = geometry.getAttribute("uv");
    const uvOffset = options.uvOffset ?? [0, 0, 0];
    if (uv && (uvOffset[0] || uvOffset[1])) {
      for (let vertex = 0; vertex < uv.count; vertex++) uv.setXY(vertex, uv.getX(vertex) + uvOffset[0] * index, uv.getY(vertex) + uvOffset[1] * index);
      uv.needsUpdate = true;
    }
    geometries.push(geometry);
    copyMatrix = copyMatrix.clone().multiply(increment);
  }
  const startCap = context.references?.startCap;
  if (startCap?.geometry) geometries.push(transformedClone(startCap.geometry, startCap.matrix));
  const endCap = context.references?.endCap;
  if (endCap?.geometry) geometries.push(transformedClone(endCap.geometry, copyMatrix.clone().multiply(endCap.matrix)));
  let result = mergeGeometries(geometries, true);
  geometries.forEach((geometry) => geometry.dispose());
  if (!result) throw new Error("Array modifier could not merge incompatible geometry attributes");
  if (options.merge && Number(options.mergeDistance) > 0) {
    const merged = mergeVertices(result, Number(options.mergeDistance));
    result.dispose();
    result = merged;
  }
  return finishGeometry(result, false);
}

/** Adds inner/outer shells and closes open boundary edges. */
export function applySolidifyModifier(source, thickness = 0, offset = -1, options = {}) {
  let width = Number(thickness) || 0;
  if (Math.abs(width) < 1e-8) return source.clone();
  if (Number(options.clamp) > 0) {
    source.computeBoundingBox();
    const size = source.boundingBox.getSize(new THREE.Vector3());
    const limit = Math.min(...[size.x, size.y, size.z].filter((value) => value > 1e-8)) * THREE.MathUtils.clamp(Number(options.clamp), 0, 1);
    width = Math.sign(width) * Math.min(Math.abs(width), limit);
  }
  const geometry = source.index ? source.clone() : mergeVertices(source.clone(), 1e-6);
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const indices = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: position.count }, (_, index) => index);
  const outside = width * (THREE.MathUtils.clamp(Number(offset) || 0, -1, 1) + 1) * 0.5;
  const inside = outside - width;
  const vertices = [];
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  for (const amount of [outside, inside]) {
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index);
      direction.fromBufferAttribute(normal, index);
      vertices.push(point.x + direction.x * amount, point.y + direction.y * amount, point.z + direction.z * amount);
    }
  }
  const faces = [];
  const edgeUses = new Map();
  const positionKey = (index) => `${Math.round(position.getX(index) * 1e6)},${Math.round(position.getY(index) * 1e6)},${Math.round(position.getZ(index) * 1e6)}`;
  const addEdge = (a, b) => {
    const keyA = positionKey(a);
    const keyB = positionKey(b);
    const key = keyA < keyB ? `${keyA}:${keyB}` : `${keyB}:${keyA}`;
    const entry = edgeUses.get(key);
    if (entry) entry.count++;
    else edgeUses.set(key, { a, b, count: 1 });
  };
  const vertexCount = position.count;
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = indices.slice(index, index + 3);
    if (!options.onlyRim) faces.push(a, b, c, c + vertexCount, b + vertexCount, a + vertexCount);
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  const shellIndexCount = faces.length;
  if (options.fillRim !== false) for (const edge of edgeUses.values()) {
    if (edge.count !== 1) continue;
    const { a, b } = edge;
    faces.push(a, a + vertexCount, b + vertexCount, a, b + vertexCount, b);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  result.setIndex(faces);
  if (shellIndexCount) result.addGroup(0, shellIndexCount, Math.max(0, Math.round(Number(options.materialOffset) || 0)));
  if (faces.length > shellIndexCount) result.addGroup(shellIndexCount, faces.length - shellIndexCount, Math.max(0, Math.round(Number(options.rimMaterialOffset) || 0)));
  if (options.flipNormals) reverseWinding(result);
  geometry.dispose();
  return finishGeometry(result);
}

export function applySubdivisionSurfaceModifier(source, levels = 0, options = {}) {
  const iterations = THREE.MathUtils.clamp(Math.round(Number(levels)) || 0, 0, 4);
  if (!iterations) return source.clone();
  const result = LoopSubdivision.modify(source, iterations, {
    split: true,
    uvSmooth: options.uvSmooth !== false,
    preserveEdges: !!options.preserveEdges,
    flatOnly: options.method === "simple",
    maxTriangles: 500_000,
  });
  return finishGeometry(result);
}

/** Laplacian vertex smoothing, with duplicate seam vertices treated as one topological point. */
export function applySmoothModifier(source, factor = 0.5, iterations = 0, axes = { x: true, y: true, z: true }) {
  const passes = THREE.MathUtils.clamp(Math.round(Number(iterations)) || 0, 0, 50);
  if (!passes || !Number(factor)) return source.clone();
  const result = source.clone();
  const position = result.getAttribute("position");
  if (!position) return result;
  const keyOf = (index) => `${Math.round(position.getX(index) * 1e6)},${Math.round(position.getY(index) * 1e6)},${Math.round(position.getZ(index) * 1e6)}`;
  const keyByIndex = Array.from({ length: position.count }, (_, index) => keyOf(index));
  const members = new Map();
  keyByIndex.forEach((key, index) => {
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(index);
  });
  const neighbours = new Map([...members.keys()].map((key) => [key, new Set()]));
  const indices = result.index ? result.index.array : Array.from({ length: position.count }, (_, index) => index);
  for (let index = 0; index < indices.length; index += 3) {
    const keys = [keyByIndex[indices[index]], keyByIndex[indices[index + 1]], keyByIndex[indices[index + 2]]];
    for (let corner = 0; corner < 3; corner++) {
      neighbours.get(keys[corner]).add(keys[(corner + 1) % 3]);
      neighbours.get(keys[corner]).add(keys[(corner + 2) % 3]);
    }
  }
  const amount = THREE.MathUtils.clamp(Number(factor) || 0, -2, 2);
  for (let pass = 0; pass < passes; pass++) {
    const targets = new Map();
    for (const [key, adjacent] of neighbours) {
      if (!adjacent.size) continue;
      const average = new THREE.Vector3();
      for (const neighbour of adjacent) {
        const sample = members.get(neighbour)[0];
        average.x += position.getX(sample);
        average.y += position.getY(sample);
        average.z += position.getZ(sample);
      }
      targets.set(key, average.multiplyScalar(1 / adjacent.size));
    }
    for (const [key, target] of targets) {
      for (const index of members.get(key)) {
        position.setXYZ(index,
          axes.x !== false ? THREE.MathUtils.lerp(position.getX(index), target.x, amount) : position.getX(index),
          axes.y !== false ? THREE.MathUtils.lerp(position.getY(index), target.y, amount) : position.getY(index),
          axes.z !== false ? THREE.MathUtils.lerp(position.getZ(index), target.z, amount) : position.getZ(index));
      }
    }
  }
  position.needsUpdate = true;
  return finishGeometry(result);
}

export function applySimpleDeformModifier(source, method = "none", axis = "z", factor = 0, options = {}) {
  if (method === "none" || !Number(factor) || !(axis in AXIS_INDEX)) return source.clone();
  source.computeBoundingBox();
  const axisIndex = AXIS_INDEX[axis];
  const [u, v] = OTHER_AXES[axis];
  const min = source.boundingBox.min.getComponent(axisIndex);
  const max = source.boundingBox.max.getComponent(axisIndex);
  const center = (min + max) * 0.5;
  const length = Math.max(max - min, 1e-8);
  const strength = Number(factor) || 0;
  const lower = THREE.MathUtils.clamp(Number(options.lowerLimit) || 0, 0, 1);
  const upper = THREE.MathUtils.clamp(options.upperLimit == null ? 1 : Number(options.upperLimit), lower, 1);
  return modifyPositions(source, (point) => {
    const values = point.toArray();
    const longitudinal = values[axisIndex] - center;
    const position01 = (values[axisIndex] - min) / length;
    if (position01 < lower || position01 > upper) return;
    const normalized = ((position01 - lower) / Math.max(upper - lower, 1e-8)) - 0.5;
    if (method === "twist") {
      const angle = strength * normalized;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      const nextU = values[u] * cosine - values[v] * sine;
      const nextV = values[u] * sine + values[v] * cosine;
      if (!options.lockX) values[u] = nextU;
      if (!options.lockY) values[v] = nextV;
    } else if (method === "bend") {
      const angle = strength * normalized;
      const radius = length / strength;
      const radial = radius + values[u];
      if (!options.lockX) values[u] = radial * Math.cos(angle) - radius;
      values[axisIndex] = center + radial * Math.sin(angle);
    } else if (method === "taper") {
      const scale = Math.max(0.001, 1 + strength * normalized);
      if (!options.lockX) values[u] *= scale;
      if (!options.lockY) values[v] *= scale;
    } else if (method === "stretch") {
      values[axisIndex] = center + longitudinal * Math.max(0.001, 1 + strength);
      const scale = 1 / Math.sqrt(Math.max(0.001, 1 + strength));
      if (!options.lockX) values[u] *= scale;
      if (!options.lockY) values[v] *= scale;
    }
    point.fromArray(values);
  });
}

export function applyCastModifier(source, type = "none", factor = 0, radius = 1, axes = { x: true, y: true, z: true }) {
  if (type === "none" || !Number(factor)) return source.clone();
  const amount = THREE.MathUtils.clamp(Number(factor) || 0, -1, 1);
  const targetRadius = Math.max(1e-6, Math.abs(Number(radius) || 1));
  return modifyPositions(source, (point) => {
    const target = point.clone();
    if (type === "sphere") target.setLength(targetRadius);
    else if (type === "cylinder") {
      const radial = Math.hypot(target.x, target.y) || 1;
      target.x *= targetRadius / radial; target.y *= targetRadius / radial;
    } else if (type === "cuboid") {
      const maximum = Math.max(Math.abs(target.x), Math.abs(target.y), Math.abs(target.z)) || 1;
      target.multiplyScalar(targetRadius / maximum);
    }
    if (axes.x !== false) point.x = THREE.MathUtils.lerp(point.x, target.x, amount);
    if (axes.y !== false) point.y = THREE.MathUtils.lerp(point.y, target.y, amount);
    if (axes.z !== false) point.z = THREE.MathUtils.lerp(point.z, target.z, amount);
  });
}

export function applyDisplaceModifier(source, strength = 0, midlevel = 0, seed = 0, options = {}) {
  const amount = Number(strength) || 0;
  if (!amount) return source.clone();
  const phase = Number(seed) || 0;
  return modifyPositions(source, (point, normal) => {
    const sample = point.clone();
    if (options.coordinates === "global" && options.sourceMatrix) sample.applyMatrix4(options.sourceMatrix);
    const scale = Math.max(0.0001, Number(options.noiseScale) || 1);
    sample.multiplyScalar(1 / scale);
    const hash = (offset) => {
      const noise = Math.sin(sample.x * 12.9898 + sample.y * 78.233 + sample.z * 37.719 + phase + offset) * 43758.5453;
      return noise - Math.floor(noise);
    };
    const noise = hash(0);
    const value = noise - Math.floor(noise) - THREE.MathUtils.clamp(Number(midlevel) || 0, 0, 1);
    const direction = options.direction ?? "normal";
    if (direction === "normal") point.addScaledVector(normal, amount * value);
    else if (direction === "rgbToXyz") {
      point.x += amount * (hash(0) - midlevel);
      point.y += amount * (hash(17.17) - midlevel);
      point.z += amount * (hash(43.43) - midlevel);
    } else point.setComponent(AXIS_INDEX[direction] ?? 2, point.getComponent(AXIS_INDEX[direction] ?? 2) + amount * value);
  });
}

export function applyWaveModifier(source, height = 0, width = 1, axis = "z", speed = 0, options = {}) {
  const amplitude = Number(height) || 0;
  if (!amplitude || !(axis in AXIS_INDEX)) return source.clone();
  const axisIndex = AXIS_INDEX[axis];
  const [u, v] = [0, 1];
  const wavelength = Math.max(1e-4, Math.abs(Number(width) || 1));
  const elapsed = (Number(options.time) || 0) - (Number(options.timeOffset) || 0);
  const phase = (Number(speed) || 0) + elapsed * (Number(options.speed) || 0);
  const lifetime = Math.max(0, Number(options.lifetime) || 0);
  const damping = Math.max(0, Number(options.damping) || 0);
  const timeEnvelope = lifetime > 0 && elapsed > lifetime ? Math.exp(-(elapsed - lifetime) * damping) : 1;
  const start = Array.isArray(options.startPosition) ? options.startPosition : [0, 0, 0];
  const narrowness = Math.max(0.01, Number(options.narrowness) || 1);
  const falloff = Math.max(0, Number(options.falloff) || 0);
  return modifyPositions(source, (point) => {
    const values = point.toArray();
    const du = values[u] - (start[u] ?? 0);
    const dv = values[v] - (start[v] ?? 0);
    const motion = options.motion ?? "both";
    const distance = motion === "x" ? Math.abs(du) : motion === "y" ? Math.abs(dv) : Math.hypot(du, dv);
    let wave = Math.sin((distance / wavelength) * Math.PI * 2 + phase);
    wave = Math.sign(wave) * Math.pow(Math.abs(wave), narrowness);
    if (!options.cyclic) wave *= Math.exp(-distance / Math.max(wavelength * 2, 1e-4));
    if (falloff > 0) wave *= Math.max(0, 1 - distance / falloff);
    values[axisIndex] += wave * amplitude * timeEnvelope;
    point.fromArray(values);
  });
}

export function applyDecimateModifier(source, settings = 1) {
  const options = typeof settings === "object" ? settings : { ratio: settings };
  let keep = THREE.MathUtils.clamp(Number(options.ratio) || 0, 0.01, 1);
  if (options.mode === "unsubdivide") keep = Math.max(0.01, 1 / Math.pow(4, THREE.MathUtils.clamp(Math.round(Number(options.iterations) || 1), 1, 8)));
  if (options.mode === "planar") keep = THREE.MathUtils.clamp(1 - Number(options.angle || 0) / 180, 0.01, 1);
  const count = source.getAttribute("position")?.count ?? 0;
  if (keep >= 0.999 || count < 12) return source.clone();
  const remove = Math.min(count - 3, Math.floor(count * (1 - keep)));
  return finishGeometry(new SimplifyModifier().modify(source, remove));
}

export function applyWeldModifier(source, threshold = 0) {
  const tolerance = Math.max(0, Number(threshold) || 0);
  if (!tolerance) return source.clone();
  return finishGeometry(mergeVertices(source.clone(), tolerance));
}

export function applyEdgeSplitModifier(source, angle = 180, useAngle = true) {
  if (!useAngle) return source.clone();
  const degrees = THREE.MathUtils.clamp(Number(angle) || 0, 0, 180);
  if (degrees >= 179.999) return source.clone();
  return finishGeometry(new EdgeSplitModifier().modify(source, THREE.MathUtils.degToRad(degrees), false));
}

export function applyWeightedNormalModifier(source, enabled = false, options = {}) {
  if (!enabled) return source.clone();
  const result = source.clone();
  const position = result.getAttribute("position");
  if (!position) return result;
  const indices = result.index ? result.index.array : Array.from({ length: position.count }, (_, index) => index);
  const accumulated = Array.from({ length: position.count }, () => new THREE.Vector3());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), faceNormal = new THREE.Vector3();
  const mode = options.mode ?? "faceArea";
  const exponent = Math.pow(2, ((Number(options.weight) || 50) - 50) / 25);
  const threshold = Math.max(0, Number(options.threshold) || 0);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]];
    a.fromBufferAttribute(position, triangle[0]); b.fromBufferAttribute(position, triangle[1]); c.fromBufferAttribute(position, triangle[2]);
    ab.subVectors(b, a); ac.subVectors(c, a); faceNormal.crossVectors(ab, ac);
    const area2 = faceNormal.length();
    if (area2 < 1e-12) continue;
    faceNormal.multiplyScalar(1 / area2);
    const points = [a, b, c];
    for (let corner = 0; corner < 3; corner++) {
      const origin = points[corner];
      const first = points[(corner + 1) % 3].clone().sub(origin).normalize();
      const second = points[(corner + 2) % 3].clone().sub(origin).normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(first.dot(second), -1, 1));
      let weight = mode === "cornerAngle" ? angle : mode === "faceAreaAndAngle" ? area2 * angle : area2;
      if (threshold > 0) weight = Math.round(weight / threshold) * threshold;
      accumulated[triangle[corner]].addScaledVector(faceNormal, Math.pow(Math.max(weight, 1e-8), exponent));
    }
  }
  const normal = new THREE.Float32BufferAttribute(new Float32Array(position.count * 3), 3);
  accumulated.forEach((value, index) => {
    if (value.lengthSq()) value.normalize();
    normal.setXYZ(index, value.x, value.y, value.z);
  });
  result.setAttribute("normal", normal);
  return finishGeometry(result, false);
}

function replaceGeometry(current, next) {
  current.dispose();
  return next;
}

/**
 * Portable geometry-node group evaluator. Until the visual geometry graph is
 * added, node groups are stored as a JSON array of modifier-compatible nodes;
 * values such as "$amount" are resolved from the exposed input object. This is
 * deliberately executable data rather than an inert Geometry Nodes placeholder.
 */
function applyGeometryNodesModifier(source, modifier, context) {
  let nodes;
  let inputs;
  try {
    nodes = typeof modifier.nodeGroup === "string" ? JSON.parse(modifier.nodeGroup || "[]") : modifier.nodeGroup;
    inputs = typeof modifier.inputs === "string" ? JSON.parse(modifier.inputs || "{}") : modifier.inputs;
  } catch (error) {
    throw new Error(`Invalid Geometry Nodes JSON: ${error.message}`);
  }
  if (!Array.isArray(nodes)) throw new Error("Geometry Nodes group must be a JSON array");
  if (nodes.length > 64) throw new Error("Geometry Nodes groups are limited to 64 nodes");
  const resolve = (value) => {
    if (typeof value === "string" && value.startsWith("$")) return inputs?.[value.slice(1)] ?? value;
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    return value;
  };
  let geometry = source.clone();
  for (const entry of nodes) {
    const node = resolve(entry);
    if (!node?.type || node.type === "geometryNodes") continue;
    const next = evaluateGeometryModifier(geometry, createGeometryModifier(node.type, node), context);
    geometry.dispose();
    geometry = next;
  }
  return geometry;
}

function evaluateGeometryModifierRaw(source, modifier, context = {}) {
  if (!modifier || modifier.enabled === false) return source.clone();
  switch (modifier.type) {
    case "mirror": return applyMirrorModifier(source, modifier, modifier.mergeDistance, context);
    case "boolean": return context.booleanGeometry
      ? applyBooleanModifier(source, context.booleanGeometry, modifier.operation, context.booleanMatrix)
      : source.clone();
    case "array": return applyArrayModifier(source, modifier, undefined, context);
    case "solidify": return applySolidifyModifier(source, modifier.thickness, modifier.offset, modifier);
    case "subdivision": return applySubdivisionSurfaceModifier(source, modifier.levels, modifier);
    case "smooth": return applySmoothModifier(source, modifier.factor, modifier.iterations, modifier);
    case "simpleDeform": return applySimpleDeformModifier(source, modifier.method, modifier.axis, modifier.factor, modifier);
    case "cast": return applyCastModifier(source, modifier.shape, modifier.factor, modifier.radius, modifier);
    case "displace": return applyDisplaceModifier(source, modifier.strength, modifier.midlevel, modifier.seed, { ...modifier, sourceMatrix: context.sourceMatrix });
    case "wave": return applyWaveModifier(source, modifier.height, modifier.width, modifier.displacementAxis, modifier.phase, {
      ...modifier,
      startPosition: context.references?.startObject?.point?.toArray?.() ?? modifier.startPosition,
    });
    case "decimate": return applyDecimateModifier(source, modifier);
    case "weld": return applyWeldModifier(source, modifier.threshold);
    case "edgeSplit": return applyEdgeSplitModifier(source, modifier.angle, modifier.useAngle);
    case "weightedNormal": return applyWeightedNormalModifier(source, true, modifier);
    case "geometryNodes": return applyGeometryNodesModifier(source, modifier, context);
    default: {
      if (GEOMETRY_GENERATE_MODIFIER_DEFINITIONS.some((entry) => entry.type === modifier.type)) {
        return evaluateGenerateGeometryModifier(source, modifier);
      }
      if (isDeformModifier(modifier.type)) return applyDeformModifier(source, modifier, context);
      const normals = evaluateNormalModifier(source, modifier, context);
      return normals ?? source.clone();
    }
  }
}

/** Applies Blender's common named vertex-group mask to vertex-preserving modifiers. */
function applyVertexGroupMask(source, evaluated, modifier) {
  const name = String(modifier?.vertexGroup ?? "").trim();
  if (!name) return evaluated;
  const sourcePosition = source.getAttribute("position");
  const outputPosition = evaluated.getAttribute("position");
  if (!sourcePosition || !outputPosition || sourcePosition.count !== outputPosition.count) return evaluated;
  const weights = source.getAttribute(name)
    ?? source.getAttribute(`group:${name}`)
    ?? source.getAttribute(`vertexGroup:${name}`);
  if (!weights || weights.count !== sourcePosition.count) return evaluated;
  const invert = !!modifier.invertVertexGroup;
  for (let index = 0; index < outputPosition.count; index++) {
    let weight = THREE.MathUtils.clamp(weights.getX(index), 0, 1);
    if (invert) weight = 1 - weight;
    outputPosition.setXYZ(index,
      THREE.MathUtils.lerp(sourcePosition.getX(index), outputPosition.getX(index), weight),
      THREE.MathUtils.lerp(sourcePosition.getY(index), outputPosition.getY(index), weight),
      THREE.MathUtils.lerp(sourcePosition.getZ(index), outputPosition.getZ(index), weight));
  }
  outputPosition.needsUpdate = true;
  return finishGeometry(evaluated);
}

export function evaluateGeometryModifier(source, modifier, context = {}) {
  return applyVertexGroupMask(source, evaluateGeometryModifierRaw(source, modifier, context), modifier);
}

/** Evaluates an ordered Blender-style modifier stack. */
export function evaluateGeometryModifiers(source, props, context = {}) {
  let geometry = source.clone();
  for (const modifier of normalizeGeometryModifierStack(props)) {
    if (modifier.enabled === false) continue;
    const modifierContext = context.modifierContexts?.get?.(modifier.id) ?? context;
    geometry = replaceGeometry(geometry, evaluateGeometryModifier(geometry, modifier, modifierContext));
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  }
  return geometry;
}
