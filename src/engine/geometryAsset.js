import * as THREE from "three/webgpu";
import { loadAssetMeta, resolveAssetUrl } from "./assetResolver.js";

export const GEOMETRY_ASSET_VERSION = 1;
/**
 * Binary container version. v1 is a JSON document whose vertex data lives in
 * plain JS number arrays; it is still read (every project authored before this
 * change is v1, and the geometry editor still writes it for hand-edited meshes
 * because its `editMesh` block is JSON-shaped anyway).
 *
 * v2 exists because v1 does not scale. A 1M-triangle mesh is ~25M numbers;
 * `JSON.stringify` of that is a ~250MB string that then has to cross the Tauri
 * IPC boundary as text and be re-parsed on load, with every float rounded
 * one-by-one on the way out and range-checked one-by-one on the way in. That
 * is the single largest cost in a large GLB import — minutes of it.
 *
 * v2 keeps the same logical shape but stores every numeric array as raw bytes:
 *
 *   "GEOM" magic | uint32 version | uint32 headerLength | header JSON | payload
 *
 * The header is the v1 document with each numeric array replaced by a
 * `{ offset, length, type }` descriptor into the payload. Loading is then a
 * `fetch` + `arrayBuffer` + a few typed-array *views* — no per-element work at
 * all — which is what lets three's own GLTFLoader open the same mesh in
 * milliseconds.
 */
export const GEOMETRY_BINARY_VERSION = 2;

const MAGIC = 0x4d4f4547; // "GEOM" little-endian

const ARRAY_TYPES = {
  Float32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
};

/**
 * Validates and converts a numeric array to `ArrayType` in ONE pass.
 *
 * The previous shape (`value.some(n => !Number.isFinite(n))` followed by
 * `new ArrayType(value)`) walked multi-million-element arrays twice, once
 * through a callback per element. Fusing the check into the copy loop halves
 * that, and typed-array inputs (v2 assets) skip it entirely — they cannot hold
 * a non-numeric value by construction.
 */
function toTypedArray(value, ArrayType, stride, label) {
  if (ArrayBuffer.isView(value)) {
    if (value.length % stride !== 0) throw new Error(`Invalid geometry ${label}`);
    return value instanceof ArrayType ? value : new ArrayType(value);
  }
  if (!Array.isArray(value) || value.length % stride !== 0) {
    throw new Error(`Invalid geometry ${label}`);
  }
  const out = new ArrayType(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (!Number.isFinite(n)) throw new Error(`Invalid geometry ${label}`);
    out[i] = n;
  }
  return out;
}

/** Largest index in an index array, or -1 for an empty one. */
function maxIndex(indices) {
  let max = -1;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] > max) max = indices[i];
  }
  return max;
}

function attributeFromAsset(definition, label) {
  const itemSize = definition?.itemSize;
  if (!Number.isInteger(itemSize) || itemSize < 1 || itemSize > 4) {
    throw new Error(`Invalid geometry ${label} item size`);
  }
  const ArrayType = ARRAY_TYPES[definition.arrayType] ?? Float32Array;
  const values = toTypedArray(definition.array, ArrayType, itemSize, label);
  return new THREE.BufferAttribute(values, itemSize, !!definition.normalized);
}

export function geometryFromAsset(definition) {
  if (
    definition?.version !== GEOMETRY_ASSET_VERSION &&
    definition?.version !== GEOMETRY_BINARY_VERSION
  ) {
    throw new Error(`Unsupported geometry asset version ${definition?.version}`);
  }
  const positions = toTypedArray(definition.positions, Float32Array, 3, "positions");
  const vertexCount = positions.length / 3;
  const indices = toTypedArray(
    definition.indices,
    vertexCount > 65535 ? Uint32Array : Uint16Array,
    3,
    "indices",
  );
  if (maxIndex(indices) >= vertexCount) {
    throw new Error("Geometry indices are out of range");
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (definition.edges?.length) {
    const edges = toTypedArray(definition.edges, Uint32Array, 2, "edges");
    if (maxIndex(edges) >= vertexCount) {
      throw new Error("Geometry edge indices are out of range");
    }
    geometry.userData.editableEdges = Array.from({ length: edges.length / 2 }, (_, index) => [
      edges[index * 2],
      edges[index * 2 + 1],
    ]);
  }
  // Exact edit-mode topology (polygons, per-corner UVs, edge flags) written by
  // the geometry editor. The runtime never reads it — it renders the triangle
  // buffers above — but carrying it on userData is what lets Edit Mode reopen a
  // mesh as the quads and n-gons it was authored as, instead of re-deriving
  // them from the triangles.
  if (definition.editMesh) geometry.userData.editMesh = definition.editMesh;
  if (definition.hiddenEdges?.length) {
    const hiddenEdges = toTypedArray(definition.hiddenEdges, Uint32Array, 2, "hidden edges");
    if (maxIndex(hiddenEdges) >= vertexCount) {
      throw new Error("Geometry hidden-edge indices are out of range");
    }
    geometry.userData.editableHiddenEdges = Array.from(
      { length: hiddenEdges.length / 2 },
      (_, index) => [hiddenEdges[index * 2], hiddenEdges[index * 2 + 1]],
    );
  }
  if (definition.uvs?.length === vertexCount * 2) {
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(toTypedArray(definition.uvs, Float32Array, 2, "uvs"), 2),
    );
  }
  // Authored normals (GLB imports) beat recomputed ones — recomputing loses
  // smoothing groups / hard edges. Older assets without them still recompute.
  if (definition.normals?.length === positions.length) {
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(toTypedArray(definition.normals, Float32Array, 3, "normals"), 3),
    );
  } else geometry.computeVertexNormals();
  for (const [name, attribute] of Object.entries(definition.attributes ?? {})) {
    geometry.setAttribute(name, attributeFromAsset(attribute, `attribute ${name}`));
  }
  for (const [name, targets] of Object.entries(definition.morphAttributes ?? {})) {
    if (!Array.isArray(targets)) throw new Error(`Invalid geometry morph attribute ${name}`);
    geometry.morphAttributes[name] = targets.map((target, index) =>
      attributeFromAsset(target, `morph attribute ${name}[${index}]`),
    );
  }
  geometry.morphTargetsRelative = !!definition.morphTargetsRelative;
  if (Array.isArray(definition.groups)) {
    for (const group of definition.groups) {
      if ([group?.start, group?.count, group?.materialIndex].every(Number.isInteger)) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
      }
    }
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Binary container (v2)                                                       */
/* -------------------------------------------------------------------------- */

/** Every key in a geometry definition whose value is a flat numeric array. */
const FLAT_ARRAY_KEYS = ["positions", "indices", "uvs", "normals", "edges", "hiddenEdges"];

/** Default storage type per flat key — floats for vertex data, ints for topology. */
function defaultTypeFor(key, values, vertexCount) {
  if (key === "positions" || key === "uvs" || key === "normals") return Float32Array;
  // Index-like arrays: pick the narrowest type that addresses every vertex.
  return vertexCount > 65535 ? Uint32Array : Uint16Array;
}

/**
 * Serializes a geometry definition (the plain shape `geometryFromAsset` reads)
 * into the v2 binary container. Accepts plain arrays or typed arrays for the
 * numeric fields; typed arrays are written without any per-element work, which
 * is what makes the GLB import path fast.
 */
export function encodeGeometryAsset(definition) {
  const chunks = []; // { bytes: Uint8Array } in payload order
  let payloadLength = 0;

  const positions = definition.positions ?? [];
  const vertexCount = (ArrayBuffer.isView(positions) ? positions.length : positions.length) / 3;

  /** Appends a typed array to the payload, 4-byte aligned, returning its descriptor. */
  const put = (values, ArrayType) => {
    const typed = ArrayBuffer.isView(values) && values instanceof ArrayType
      ? values
      : new ArrayType(values);
    // Views must start on a multiple of their element size; 4 covers every
    // type we emit, so pad the payload up to the next multiple of 4.
    const pad = (4 - (payloadLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      payloadLength += pad;
    }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const descriptor = { offset: payloadLength, length: typed.length, type: ArrayType.name };
    chunks.push(bytes);
    payloadLength += bytes.byteLength;
    return descriptor;
  };

  const header = {
    version: GEOMETRY_BINARY_VERSION,
    morphTargetsRelative: !!definition.morphTargetsRelative,
    groups: definition.groups ?? [],
    buffers: {},
    attributes: {},
    morphAttributes: {},
  };
  if (definition.editMesh) header.editMesh = definition.editMesh;

  for (const key of FLAT_ARRAY_KEYS) {
    const values = definition[key];
    if (!values || values.length === 0) continue;
    header.buffers[key] = put(values, defaultTypeFor(key, values, vertexCount));
  }

  const putAttribute = (attribute) => ({
    itemSize: attribute.itemSize,
    normalized: !!attribute.normalized,
    arrayType: attribute.arrayType ?? "Float32Array",
    buffer: put(attribute.array, ARRAY_TYPES[attribute.arrayType] ?? Float32Array),
  });
  for (const [name, attribute] of Object.entries(definition.attributes ?? {})) {
    header.attributes[name] = putAttribute(attribute);
  }
  for (const [name, targets] of Object.entries(definition.morphAttributes ?? {})) {
    header.morphAttributes[name] = targets.map(putAttribute);
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerPad = (4 - (headerBytes.byteLength % 4)) % 4;
  const headerLength = headerBytes.byteLength + headerPad;

  const out = new Uint8Array(12 + headerLength + payloadLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, GEOMETRY_BINARY_VERSION, true);
  view.setUint32(8, headerLength, true);
  out.set(headerBytes, 12);
  // Header padding is left as zero bytes; the reader slices to headerLength and
  // JSON.parse tolerates trailing NULs only if we trim, so pad with spaces.
  for (let i = 0; i < headerPad; i++) out[12 + headerBytes.byteLength + i] = 0x20;
  let at = 12 + headerLength;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** True when `buffer` starts with the v2 container magic. */
function isBinaryGeometry(buffer) {
  if (buffer.byteLength < 12) return false;
  return new DataView(buffer).getUint32(0, true) === MAGIC;
}

/**
 * Turns a v2 container into the plain definition `geometryFromAsset` reads.
 * Every numeric field becomes a typed-array VIEW onto the fetched buffer — no
 * copying, no parsing, no validation loop.
 */
export function decodeGeometryAsset(buffer) {
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== GEOMETRY_BINARY_VERSION) {
    throw new Error(`Unsupported geometry container version ${version}`);
  }
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
  const payloadStart = 12 + headerLength;

  const read = (descriptor) => {
    const ArrayType = ARRAY_TYPES[descriptor.type] ?? Float32Array;
    return new ArrayType(buffer, payloadStart + descriptor.offset, descriptor.length);
  };

  const definition = {
    version: GEOMETRY_BINARY_VERSION,
    morphTargetsRelative: !!header.morphTargetsRelative,
    groups: header.groups ?? [],
    attributes: {},
    morphAttributes: {},
  };
  if (header.editMesh) definition.editMesh = header.editMesh;
  for (const [key, descriptor] of Object.entries(header.buffers ?? {})) {
    definition[key] = read(descriptor);
  }
  const readAttribute = (attribute) => ({
    itemSize: attribute.itemSize,
    normalized: attribute.normalized,
    arrayType: attribute.arrayType,
    array: read(attribute.buffer),
  });
  for (const [name, attribute] of Object.entries(header.attributes ?? {})) {
    definition.attributes[name] = readAttribute(attribute);
  }
  for (const [name, targets] of Object.entries(header.morphAttributes ?? {})) {
    definition.morphAttributes[name] = targets.map(readAttribute);
  }
  return definition;
}

/* -------------------------------------------------------------------------- */
/* Loading + the shared-instance cache                                         */
/* -------------------------------------------------------------------------- */

async function fetchGeometryAsset(path) {
  // Reject non-`.geom` paths up-front so a stale scene reference (e.g. a
  // component that still points at a `.glb` from before that asset was
  // unpacked into editable `.geom` files) doesn't hit the network and
  // surface as a confusing "Unexpected token 'g', ...is not valid JSON"
  // parse error. Callers translate this into a clean warning.
  const ext = String(path ?? "").split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (ext !== "geom") {
    throw new Error(`Geometry asset must be a .geom file (got .${ext || "<none>"}): "${path}"`);
  }
  const [url, meta] = await Promise.all([
    resolveAssetUrl(path),
    loadAssetMeta(`${path}.meta`),
  ]);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geometry request failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  const definition = isBinaryGeometry(buffer)
    ? decodeGeometryAsset(buffer)
    : JSON.parse(new TextDecoder().decode(buffer));
  const geometry = geometryFromAsset(definition);
  geometry.userData.assetPath = path;
  // GI validates the content hash before using this. Keeping the runtime
  // loader subsystem-agnostic lets exported games consume the same sidecar
  // without making the engine core depend on the optional GI module.
  if (meta?.giRayProxy) geometry.userData.giRayProxy = meta.giRayProxy;
  return geometry;
}

/**
 * Shared-instance cache, keyed by asset path.
 *
 * A scene built from an imported model is overwhelmingly repeats: a thousand
 * crates all point at the same `Crate.geom`. Without a cache each MeshComponent
 * fetched, parsed, validated and uploaded its own private copy — a thousand
 * decodes of the same bytes and a thousand redundant vertex buffers on the GPU.
 * Sharing one BufferGeometry makes scene load time and VRAM proportional to the
 * number of DISTINCT meshes rather than the number of instances, and it is also
 * what lets three batch/sort by geometry.
 *
 * Nothing in the engine mutates a loaded `.geom` in place — every consumer
 * (geometry modifiers, terrain, virtual geometry, Edit Mode) swaps
 * `mesh.geometry` for a new object and leaves the asset instance untouched — so
 * sharing is safe. Ownership is refcounted because the meshes that share an
 * instance are disposed independently.
 */
const cache = new Map(); // path -> entry, only while the entry is current
// geometry -> its entry. Keyed by the instance rather than the path so a
// RETIRED entry (one evicted by `invalidateGeometryAsset` after the file was
// rewritten) still refcounts correctly for the meshes that are mid-reload and
// have not let go of the old instance yet.
const owners = new WeakMap();

/**
 * Borrows the shared geometry for `path`, incrementing its refcount. Pair every
 * successful acquire with exactly one `releaseGeometryAsset`.
 */
export function acquireGeometryAsset(path) {
  let entry = cache.get(path);
  if (!entry) {
    entry = { path, refs: 0, geometry: null, promise: null };
    entry.promise = fetchGeometryAsset(path).then(
      (geometry) => {
        entry.geometry = geometry;
        owners.set(geometry, entry);
        // The load may have been invalidated while in flight; drop it now
        // rather than handing out an instance nobody will ever release.
        if (entry.refs <= 0) {
          owners.delete(geometry);
          geometry.dispose();
        }
        return geometry;
      },
      (error) => {
        // A failed load must not poison the cache — the file may appear later.
        if (cache.get(path) === entry) cache.delete(path);
        throw error;
      },
    );
    cache.set(path, entry);
  }
  entry.refs++;
  return entry.promise;
}

/**
 * Returns a borrowed geometry, disposing the shared instance once the last
 * holder lets go. Returns false when `geometry` is not cache-owned — the
 * caller's signal that it owns the geometry and may dispose it itself.
 */
export function releaseGeometryAsset(geometry) {
  const entry = geometry && owners.get(geometry);
  if (!entry) return false;
  if (--entry.refs > 0) return true;
  if (cache.get(entry.path) === entry) cache.delete(entry.path);
  owners.delete(geometry);
  geometry.dispose();
  return true;
}

/** Releases `geometry` if it is a shared asset instance, disposes it otherwise. */
export function disposeOrReleaseGeometry(geometry) {
  if (!geometry) return;
  if (!releaseGeometryAsset(geometry)) geometry.dispose();
}

/**
 * Drops the cached instance for `path` so the next acquire re-reads the file.
 * Called whenever a `.geom` is rewritten (see `invalidateBlobUrl`). Meshes
 * still holding the old instance keep rendering it until their own reload
 * releases it — no geometry is yanked out from under a live draw.
 */
export function invalidateGeometryAsset(path) {
  const entry = cache.get(path);
  if (!entry) return;
  cache.delete(path);
  if (entry.refs <= 0 && entry.geometry) {
    owners.delete(entry.geometry);
    entry.geometry.dispose();
  }
}

/**
 * Loads a `.geom` as a PRIVATE instance the caller owns and must dispose.
 * Prefer `acquireGeometryAsset` unless the geometry will be mutated.
 */
export async function loadGeometryAsset(path) {
  return fetchGeometryAsset(path);
}
