import * as THREE from "three/webgpu";
import {
  applyArrayModifier,
  applyBevelModifier,
  applyCastModifier,
  applyDecimateModifier,
  applyDisplaceModifier,
  applyEdgeSplitModifier,
  applyMirrorModifier,
  applySimpleDeformModifier,
  applySmoothModifier,
  applySolidifyModifier,
  applySubdivisionSurfaceModifier,
  applyWaveModifier,
  applyWeightedNormalModifier,
  applyWeldModifier,
  createGeometryModifier,
  GEOMETRY_MODIFIER_DEFINITIONS,
  evaluateGeometryModifiers,
  normalizeGeometryModifierStack,
} from "../src/engine/geometryModifiers.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { validateMesh } from "../src/editor/mesh/bmesh.js";
import { bevelEdges } from "../src/editor/mesh/ops/topology.js";

let failures = 0;
const check = (condition, message) => {
  if (condition) console.log(`PASS ${message}`);
  else {
    failures++;
    console.error(`FAIL ${message}`);
  }
};

const validate = (name, geometry) => {
  const position = geometry.getAttribute("position");
  let finite = !!position?.count;
  for (let index = 0; finite && index < position.count; index++) {
    finite = [position.getX(index), position.getY(index), position.getZ(index)].every(Number.isFinite);
  }
  check(finite, `${name} produces finite vertices`);
  check(!!geometry.boundingBox && !!geometry.boundingSphere, `${name} updates bounds`);
  return geometry;
};

const source = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3);
const sourceSnapshot = Array.from(source.getAttribute("position").array);
const originalTriangles = source.index.count / 3;
check(normalizeGeometryModifierStack({ modifiers: [] }).length === 0, "a new modifier stack is empty");
const migrated = normalizeGeometryModifierStack({ arrayCount: 3, arrayOffset: [2, 0, 0], subdivisionLevels: 1 });
check(migrated.map((modifier) => modifier.type).join(",") === "array,subdivision", "legacy fixed-stack settings migrate in evaluation order");
const arrayEntry = createGeometryModifier("array");
check(arrayEntry.type === "array" && arrayEntry.count === 2 && !!arrayEntry.id, "new modifiers receive useful defaults and a stable id");
check("fitType" in arrayEntry && "relativeOffset" in arrayEntry && "merge" in arrayEntry && "uvOffset" in arrayEntry,
  "Array exposes Blender-style fit, offset, merge, and UV controls");
const definitionTypes = GEOMETRY_MODIFIER_DEFINITIONS.map((definition) => definition.type);
check(new Set(definitionTypes).size === definitionTypes.length, "modifier registry types are unique");
check(definitionTypes.length === 40, "registry covers Blender's complete Generate, Deform, and Normals modifier catalog");
for (const definition of GEOMETRY_MODIFIER_DEFINITIONS) {
  const modifier = createGeometryModifier(definition.type);
  check(!!modifier && definition.fields.every((field) => field.key in modifier), `${definition.label} defaults cover every field`);
  const output = evaluateGeometryModifiers(source, { modifiers: [modifier] });
  validate(`${definition.label} default`, output).dispose();
}
check(sourceSnapshot.every((value, index) => value === source.getAttribute("position").array[index]), "default modifier evaluation never mutates its source geometry");
const nodeResult = evaluateGeometryModifiers(source, { modifiers: [createGeometryModifier("geometryNodes", {
  nodeGroup: JSON.stringify([{ type: "array", count: "$copies", useRelativeOffset: false, useConstantOffset: true, constantOffset: [3, 0, 0] }]),
  inputs: JSON.stringify({ copies: 2 }),
})] });
check(nodeResult.index.count / 3 === originalTriangles * 2, "Geometry Nodes executes node groups with exposed inputs");
nodeResult.dispose();
const cases = [
  ["Mirror", () => applyMirrorModifier(source, "x", 0.0001)],
  ["Solidify", () => applySolidifyModifier(source, 0.2, 0)],
  ["Smooth", () => applySmoothModifier(source, 0.4, 2)],
  ["Twist", () => applySimpleDeformModifier(source, "twist", "z", Math.PI)],
  ["Bend", () => applySimpleDeformModifier(source, "bend", "z", 1)],
  ["Taper", () => applySimpleDeformModifier(source, "taper", "z", 0.5)],
  ["Stretch", () => applySimpleDeformModifier(source, "stretch", "z", 0.5)],
  ["Cast", () => applyCastModifier(source, "sphere", 0.7, 2)],
  ["Displace", () => applyDisplaceModifier(source, 0.2, 0.5, 3)],
  ["Wave", () => applyWaveModifier(source, 0.2, 1, "z", 0.3)],
  ["Decimate", () => applyDecimateModifier(source, 0.7)],
  ["Weld", () => applyWeldModifier(source, 0.001)],
  ["Edge Split", () => applyEdgeSplitModifier(source, 30)],
  ["Weighted Normal", () => applyWeightedNormalModifier(source, true)],
];

for (const [name, create] of cases) validate(name, create()).dispose();

const mirroredXYZ = applyMirrorModifier(source, { x: true, y: true, z: true, merge: false });
check(mirroredXYZ.index.count / 3 === originalTriangles * 8, "Mirror supports simultaneous X/Y/Z axes");
mirroredXYZ.dispose();

const beveledCube = applyBevelModifier(new THREE.BoxGeometry(2, 2, 2), { width: 0.2, segments: 4, clampOverlap: true });
const beveledTopology = meshFromBufferGeometry(beveledCube);
check(validateMesh(beveledTopology).length === 0, "Bevel resolves intersecting edge offsets into valid shared corner topology");
check([...beveledTopology.edges].every((edge) => edge.loops.length === 2), "Bevel keeps a closed manifold closed at multi-edge intersections");
check(Math.max(...[...beveledTopology.verts].map((vertex) => vertex.edges.size)) <= 6,
  "segmented Bevel corners use a distributed grid instead of a high-valence center fan");
check([...beveledTopology.faces].every((face) => face.loops.length === 4),
  "even-segment three-edge Bevel intersections use Blender-style quad grid fill");
beveledCube.dispose();

// Ctrl+B calls the edit-mesh kernel directly, so keep a regression on that
// path independently of the non-destructive modifier wrapper.
const editBevelTopology = meshFromBufferGeometry(new THREE.BoxGeometry(2, 2, 2));
bevelEdges(editBevelTopology, [...editBevelTopology.edges], { width: 0.2, segments: 6 });
const positiveCorner = [...editBevelTopology.verts]
  .filter((vertex) => vertex.co.every((coordinate) => coordinate > 0.79));
const apex = positiveCorner.reduce((best, vertex) => (
  vertex.co[0] + vertex.co[1] + vertex.co[2] > best.co[0] + best.co[1] + best.co[2] ? vertex : best
));
const expectedApex = 0.8 + 0.2 / Math.sqrt(3);
check(apex.co.every((coordinate) => Math.abs(coordinate - expectedApex) < 1e-5),
  "Ctrl+B profiles share the correct corner sphere instead of pinching or ballooning");
check(validateMesh(editBevelTopology).length === 0,
  "Ctrl+B keeps the corrected rounded intersection manifold");

const lengthArray = applyArrayModifier(source, {
  fitType: "length", length: 5, useRelativeOffset: false, useConstantOffset: true,
  constantOffset: [2, 0, 0], merge: false, uvOffset: [0.25, 0, 0],
});
check(lengthArray.index.count / 3 === originalTriangles * 3, "Array Fit Length derives its copy count from the combined offset");
check(lengthArray.getAttribute("uv").getX(source.getAttribute("uv").count) > source.getAttribute("uv").getX(0), "Array applies per-copy UV offsets");
lengthArray.dispose();

const simpleSubdivision = applySubdivisionSurfaceModifier(source, 1, { method: "simple", uvSmooth: false, preserveEdges: true });
check(simpleSubdivision.getAttribute("position").count > source.getAttribute("position").count, "Subdivision Simple adds detail without requiring Catmull-Clark mode");
simpleSubdivision.dispose();

const xDisplace = applyDisplaceModifier(source, 0.2, 0.5, 3, { direction: "x", noiseScale: 0.5 });
const originalPosition = source.getAttribute("position");
const displacedPosition = xDisplace.getAttribute("position");
let yOrZChanged = false;
for (let index = 0; index < originalPosition.count; index++) {
  if (Math.abs(originalPosition.getY(index) - displacedPosition.getY(index)) > 1e-6 || Math.abs(originalPosition.getZ(index) - displacedPosition.getZ(index)) > 1e-6) yOrZChanged = true;
}
check(!yOrZChanged, "Displace axis direction only moves the selected coordinate");
xDisplace.dispose();

const solid = applySolidifyModifier(source, 0.2, 0);
check(solid.index.count / 3 === originalTriangles * 2, "Solidify does not create boundary walls on a closed seam-split mesh");
solid.dispose();

const fullStack = validate("Combined modifier stack", evaluateGeometryModifiers(source, { modifiers: [
  createGeometryModifier("mirror", { x: true, y: false, z: false, mergeDistance: 0.0001 }),
  createGeometryModifier("array", { count: 2, useRelativeOffset: false, useConstantOffset: true, constantOffset: [3, 0, 0] }),
  createGeometryModifier("solidify", { thickness: 0.05, offset: -1, fillRim: true }),
  createGeometryModifier("subdivision", { method: "catmullClark", levels: 1 }),
  createGeometryModifier("smooth", { iterations: 1, factor: 0.2 }),
  createGeometryModifier("simpleDeform", { method: "twist", axis: "z", factor: 0.2 }),
  createGeometryModifier("cast", { shape: "sphere", factor: 0.1, radius: 2 }),
  createGeometryModifier("displace", { strength: 0.01, midlevel: 0.5, seed: 1 }),
  createGeometryModifier("wave", { height: 0.01, width: 1, displacementAxis: "z", phase: 0 }),
  createGeometryModifier("decimate", { ratio: 0.95 }),
  createGeometryModifier("weld", { threshold: 0.000001 }),
  createGeometryModifier("edgeSplit", { angle: 170 }),
  createGeometryModifier("weightedNormal"),
] }));
fullStack.dispose();
source.dispose();

if (failures) {
  console.error(`\n${failures} geometry modifier check(s) failed`);
  process.exit(1);
}
console.log("\nGeometry modifier tests passed");
