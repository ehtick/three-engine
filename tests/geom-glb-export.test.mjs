import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * `.geom` → GLB, the conversion half (`src/editor/geomExport.js`).
 *
 * Run with `node --test tests/geom-glb-export.test.mjs`.
 *
 * The file half — the save dialog, the write, the Assets-panel refresh — needs
 * Tauri and is not covered here. What IS covered is everything that can be
 * silently wrong in a file nobody opens until they are already in Blender: the
 * vertex data surviving the round trip, the editor's private bookkeeping NOT
 * riding along, and material slots staying separate.
 */

// GLTFExporter's binary writer merges its buffers through a Blob and reads
// them back with FileReader. Node has Blob and not FileReader, so without this
// the export path cannot be reached headlessly at all. The editor runs in a
// WebView that has the real thing; note that `readAsArrayBuffer` is called
// BEFORE `onloadend` is assigned, so the callback must not fire synchronously.
globalThis.FileReader ??= class FileReaderShim {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
};

const { glbFromGeometry, geometryStats } = await import("../src/editor/geomExport.js");

/** The glTF JSON out of a GLB container, without a loader in the way. */
function glbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, "GLB magic");
  assert.equal(view.getUint32(4, true), 2, "GLB version");
  const chunkLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, "first chunk is JSON");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + 20, chunkLength)));
}

const parseGlb = (bytes) =>
  new Promise((resolve, reject) => {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });

/** A two-triangle quad with UVs and authored normals, as a `.geom` would hold it. */
function quad() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  return geometry;
}

test("vertex data survives the round trip", async () => {
  const source = quad();
  const loaded = await parseGlb(await glbFromGeometry(source, { name: "Quad" }));

  const meshes = [];
  loaded.scene.traverse((object) => object.isMesh && meshes.push(object));
  assert.equal(meshes.length, 1);

  const geometry = meshes[0].geometry;
  assert.deepEqual([...geometry.getAttribute("position").array], [...source.getAttribute("position").array]);
  assert.deepEqual([...geometry.getAttribute("normal").array], [...source.getAttribute("normal").array]);
  assert.deepEqual([...geometry.getAttribute("uv").array], [...source.getAttribute("uv").array]);
  assert.deepEqual([...geometry.index.array], [...source.index.array]);
});

/**
 * The trap this exists for: three's exporter calls
 * `serializeUserData(geometry, primitive)`, so anything on `geometry.userData`
 * is JSON-stringified into the GLB header. Every mesh the geometry editor hands
 * over carries `editMesh` — the full polygon topology, per-corner UVs and edge
 * flags — which is frequently larger than the vertex data and means nothing to
 * any consumer. It has to be stripped, not merely small.
 */
test("editor bookkeeping does not ride along in the file", async () => {
  const source = quad();
  source.userData.editMesh = { polygons: Array.from({ length: 500 }, (_, i) => [i, i + 1, i + 2]) };
  source.userData.assetPath = "C:/project/Assets/Quad.geom";
  source.userData.giRayProxy = { hash: "abc", radius: 2 };

  const bytes = await glbFromGeometry(source, { name: "Quad" });
  const text = new TextDecoder().decode(bytes);
  for (const leak of ["editMesh", "assetPath", "giRayProxy"]) {
    assert.equal(text.includes(leak), false, `${leak} reached the GLB`);
  }
  const json = glbJson(bytes);
  assert.equal("extras" in json.meshes[0].primitives[0], false);
});

/**
 * A single material makes the exporter emit one primitive over the whole index
 * buffer and drop `geometry.groups` without a word, welding a multi-slot mesh
 * into one. Slots have to become an ARRAY of materials to survive.
 */
test("material slots stay separate primitives", async () => {
  const source = quad();
  source.addGroup(0, 3, 0);
  source.addGroup(3, 3, 1);

  const json = glbJson(await glbFromGeometry(source, { name: "Quad" }));
  assert.equal(json.meshes[0].primitives.length, 2);
  assert.equal(json.materials.length, 2);
  assert.deepEqual(json.meshes[0].primitives.map((p) => p.material), [0, 1]);
});

test("a single-slot mesh stays one primitive", async () => {
  const source = quad();
  source.addGroup(0, 6, 0);
  const json = glbJson(await glbFromGeometry(source, { name: "Quad" }));
  assert.equal(json.meshes[0].primitives.length, 1);
});

test("morph targets survive", async () => {
  const source = quad();
  source.morphAttributes.position = [
    new THREE.BufferAttribute(new Float32Array([0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5]), 3),
  ];
  source.morphTargetsRelative = true;

  const loaded = await parseGlb(await glbFromGeometry(source, { name: "Quad" }));
  const meshes = [];
  loaded.scene.traverse((object) => object.isMesh && meshes.push(object));
  assert.equal(meshes[0].geometry.morphAttributes.position.length, 1);
});

test("reports what it wrote", () => {
  assert.deepEqual(geometryStats(quad()), { vertices: 4, triangles: 2 });
  const nonIndexed = new THREE.BufferGeometry();
  nonIndexed.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  assert.deepEqual(geometryStats(nonIndexed), { vertices: 3, triangles: 1 });
});
