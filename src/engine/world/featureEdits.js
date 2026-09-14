/**
 * Renderer-independent prototype for persistent edits to semantic features.
 *
 * Features are JSON records with nonempty id/kind and a props object. Optional
 * position/rotation/scale are three finite numbers (rotation is radians).
 * Operations have unique ids and run in document order; the last edit wins.
 * Reset/undo removes an operation, then resolves against generated inputs again.
 *
 * override: { id, kind: "override", target, property: "material.tint", value }
 *   Paths are relative to props; dot strings or string arrays select own object
 *   properties. Array elements and missing paths are never guessed or created.
 * transform: { id, kind: "transform", target, position?, rotation?, scale?,
 *              space?: "world" | "attachment", attachment?: { target, ... } }
 *   Absolute overrides in the declared space; this pure resolver does not
 *   evaluate surface attachment matrices. Providers resolve those later.
 *   Setting attachment requires explicit space: "attachment". Other partial
 *   edits inherit the target's existing space/attachment unless overridden.
 * suppress: { id, kind: "suppress", target }
 * add: { id, kind: "add", feature }
 * pin: { id, kind: "pin", target, snapshot, aspects: ["placement", "props.tint"] }
 *   Pin snapshots are complete feature records captured when the edit is made.
 *   "placement" freezes all transform/anchor fields, "complete" freezes the
 *   whole record. Other aspects are explicit feature paths (e.g. "outline",
 *   "props.material"); style providers choose which paths mean appearance.
 *   A missing target restores the complete snapshot as a visible fallback and
 *   also reports the pin as orphaned. Existing targets keep unpinned changes.
 *
 * orphanEdits contains unchanged copies of operations whose targets/paths are
 * absent, including tombstones for missing targets. It is diagnostic output,
 * not a second edit list to append to operations. Keep the original operations
 * in the document, so later regeneration can resolve them. Features retain input
 * order; additions/fallback snapshots append. Identity never depends on order.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PLACEMENT = ["position", "rotation", "scale", "space", "attachment"];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

// Enforce the persisted JSON contract without invoking accessors or accepting
// objects that change meaning after a save/reload (Date, Map, undefined, NaN).
function cloneData(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(`${label} must contain finite, acyclic JSON data`);
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${label} must contain plain JSON objects`);
  }
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${label} contains an unsafe property`);
    }
    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new TypeError(`${label} must contain ordinary JSON arrays`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !own(descriptor, "value")) {
      throw new TypeError(`${label} must contain enumerable data properties`);
    }
    result[key] = cloneData(descriptor.value, `${label}.${key}`, ancestors);
  }
  if (Array.isArray(value) && (result.length !== value.length || keys.length - 1 !== value.length)) {
    throw new TypeError(`${label} must not contain sparse arrays`);
  }
  ancestors.delete(value);
  return result;
}

function validatePlacement(feature, label) {
  for (const key of ["position", "rotation", "scale"]) {
    if (!own(feature, key)) continue;
    if (!Array.isArray(feature[key]) || feature[key].length !== 3 ||
        !feature[key].every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new TypeError(`${label}.${key} must contain three finite numbers`);
    }
  }
  if (own(feature, "space") && feature.space !== "world" && feature.space !== "attachment") {
    throw new TypeError(`${label}.space must be world or attachment`);
  }
  if (feature.space === "attachment") {
    if (!record(feature.attachment)) throw new TypeError(`${label} requires an attachment`);
    requireText(feature.attachment.target, `${label}.attachment.target`);
  } else if (own(feature, "attachment")) {
    throw new TypeError(`${label}.attachment requires attachment space`);
  }
}

function validateFeature(feature, label) {
  if (!record(feature)) throw new TypeError(`${label} must be a feature object`);
  requireText(feature.id, `${label}.id`);
  requireText(feature.kind, `${label}.kind`);
  if (!record(feature.props)) throw new TypeError(`${label}.props must be an object`);
  validatePlacement(feature, label);
}

function propertyPath(value, label) {
  const path = typeof value === "string" ? value.split(".") : value;
  if (!Array.isArray(path) || path.length === 0 || path.some((key) =>
    typeof key !== "string" || key.trim().length === 0 || FORBIDDEN_KEYS.has(key))) {
    throw new TypeError(`${label} must be a safe nonempty property path`);
  }
  return path;
}

function pathParent(root, path) {
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!record(current) || !own(current, path[i])) return null;
    current = current[path[i]];
  }
  return record(current) && own(current, path.at(-1)) ? current : null;
}

function validateOperation(operation, index) {
  const label = `operations[${index}]`;
  if (!record(operation)) throw new TypeError(`${label} must be an operation object`);
  requireText(operation.id, `${label}.id`);
  if (operation.kind === "add") {
    validateFeature(operation.feature, `${label}.feature`);
    return;
  }
  requireText(operation.target, `${label}.target`);
  switch (operation.kind) {
    case "override":
      propertyPath(operation.property, `${label}.property`);
      if (!own(operation, "value")) throw new TypeError(`${label} requires a value`);
      break;
    case "transform": {
      if (!PLACEMENT.some((key) => own(operation, key))) throw new TypeError(`${label} requires a transform`);
      // Validate even orphaned operations; a space-only edit may retain the
      // target's existing attachment, but retargeting must declare its space.
      const candidate = { ...operation };
      if (own(candidate, "attachment") && !own(candidate, "space")) {
        throw new TypeError(`${label}.attachment requires explicit attachment space`);
      }
      if (candidate.space === "attachment" && !own(candidate, "attachment")) {
        candidate.attachment = { target: "inherited" };
      }
      validatePlacement(candidate, label);
      break;
    }
    case "suppress":
      break;
    case "pin":
      validateFeature(operation.snapshot, `${label}.snapshot`);
      if (operation.snapshot.id !== operation.target) throw new TypeError(`${label} snapshot ID differs from target`);
      if (!Array.isArray(operation.aspects) || operation.aspects.length === 0) {
        throw new TypeError(`${label}.aspects must be a nonempty array`);
      }
      if (new Set(operation.aspects).size !== operation.aspects.length) throw new TypeError(`${label} has duplicate aspects`);
      for (const aspect of operation.aspects) {
        requireText(aspect, `${label}.aspects`);
        if (aspect === "placement" || aspect === "complete") continue;
        const path = propertyPath(aspect, `${label}.aspects`);
        if (path[0] === "id" || path[0] === "kind" || PLACEMENT.includes(path[0])) {
          throw new TypeError(`${label} must pin identity via complete and transforms via placement`);
        }
        if (!pathParent(operation.snapshot, path)) throw new TypeError(`${label} snapshot lacks aspect ${aspect}`);
      }
      break;
    default:
      throw new TypeError(`${label} has unsupported kind ${operation.kind}`);
  }
}

/** Resolve an ordered edit list without mutating or retaining input objects. */
export function resolveFeatureEdits(features, operations) {
  if (!Array.isArray(features) || !Array.isArray(operations)) throw new TypeError("features and operations must be arrays");
  const generated = cloneData(features, "features");
  const edits = cloneData(operations, "operations");
  const resolved = new Map();
  for (const [index, feature] of generated.entries()) {
    validateFeature(feature, `features[${index}]`);
    if (resolved.has(feature.id)) throw new TypeError(`Duplicate feature ID: ${feature.id}`);
    resolved.set(feature.id, feature);
  }
  const editIds = new Set();
  const featureIds = new Set(resolved.keys());
  for (const [index, operation] of edits.entries()) {
    validateOperation(operation, index);
    if (editIds.has(operation.id)) throw new TypeError(`Duplicate operation ID: ${operation.id}`);
    editIds.add(operation.id);
    if (operation.kind === "add") {
      if (featureIds.has(operation.feature.id)) throw new TypeError(`Duplicate feature ID: ${operation.feature.id}`);
      featureIds.add(operation.feature.id);
    }
  }
  const orphanEdits = [];
  for (const operation of edits) {
    if (operation.kind === "add") {
      if (resolved.has(operation.feature.id)) throw new TypeError(`Duplicate feature ID: ${operation.feature.id}`);
      resolved.set(operation.feature.id, cloneData(operation.feature, "added feature"));
      continue;
    }
    const feature = resolved.get(operation.target);
    if (!feature) {
      orphanEdits.push(operation);
      if (operation.kind === "pin") resolved.set(operation.target, cloneData(operation.snapshot, "pin snapshot"));
      continue;
    }
    if (operation.kind === "suppress") {
      resolved.delete(operation.target);
    } else if (operation.kind === "override") {
      const path = propertyPath(operation.property, "property");
      const parent = pathParent(feature.props, path);
      if (parent) parent[path.at(-1)] = cloneData(operation.value, "override value");
      else orphanEdits.push(operation);
    } else if (operation.kind === "transform") {
      const next = { ...feature };
      for (const key of PLACEMENT) if (own(operation, key)) next[key] = cloneData(operation[key], key);
      if (operation.space === "world") delete next.attachment;
      validatePlacement(next, `transform ${operation.id}`);
      resolved.set(feature.id, next);
    } else if (operation.kind === "pin") {
      if (operation.snapshot.kind !== feature.kind) {
        orphanEdits.push(operation);
        continue;
      }
      if (operation.aspects.includes("complete")) {
        resolved.set(feature.id, cloneData(operation.snapshot, "pin snapshot"));
        continue;
      }
      const paths = operation.aspects.filter((aspect) => aspect !== "placement")
        .map((aspect) => propertyPath(aspect, "aspect"));
      if (paths.some((path) => !pathParent(feature, path))) {
        orphanEdits.push(operation);
        continue;
      }
      if (operation.aspects.includes("placement")) {
        for (const key of PLACEMENT) {
          if (own(operation.snapshot, key)) feature[key] = cloneData(operation.snapshot[key], key);
          else delete feature[key];
        }
      }
      for (const path of paths) {
        pathParent(feature, path)[path.at(-1)] = cloneData(pathParent(operation.snapshot, path)[path.at(-1)], "pinned aspect");
      }
    }
  }
  return { features: [...resolved.values()], orphanEdits };
}

/** Collision-free tuple encoding; callers supply persistent semantic keys. */
export function stableFeatureId(namespace, ...keys) {
  if (keys.length === 0) throw new TypeError("A feature requires a persistent key");
  return [namespace, ...keys].map((part) => {
    requireText(part, "Feature namespace/key");
    return `${part.length}:${part}`;
  }).join("/");
}

// -----------------------------------------------------------------------------
// World sculpt-diff <-> Terrain heightEdits (P1-T, 2026-09-13)
//
// World's document keeps a sculpt stroke as a sparse {resolution, indices,
// deltas} record (see `worldDocument.js` captureWorldTerrainEdits/
// applyWorldTerrainEdits — unchanged, still how the document itself validates
// and stores it). A procedural Terrain component instead keeps its own
// sculpt delta as a dense base64 Float32Array prop, `heightEdits` — the exact
// layout `TerrainComponent` already uses for `heights` (row-major,
// (resolution+1)^2). These two helpers reformat one into the other; they are
// pure reformatting; a World sculpt delta and a procedural Terrain's own
// `heightEdits` are the SAME numeric quantity (both a delta against the
// unedited base height at that vertex), never re-derived against a base
// array here.
// -----------------------------------------------------------------------------

function bytesToBinaryString(bytes) {
  const CHUNK = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}
function encodeFloat32(values) {
  return btoa(bytesToBinaryString(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)));
}
function decodeFloat32(text, length) {
  if (!text) return new Float32Array(length);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const values = new Float32Array(bytes.buffer);
  return values.length === length ? values : new Float32Array(length);
}

/**
 * World's sparse sculpt diff reformatted as the dense base64 blob a
 * procedural Terrain component's `heightEdits` prop expects. `null` (no
 * edits) becomes `""`, matching `heightEdits`'s own default.
 */
export function terrainEditsToHeightEdits(terrainEdits, resolution) {
  const length = (resolution + 1) ** 2;
  if (!terrainEdits) return "";
  if (terrainEdits.resolution !== resolution || terrainEdits.indices.length !== terrainEdits.deltas.length) {
    throw new TypeError("World terrain edit grid mismatch");
  }
  const deltas = new Float32Array(length);
  for (let i = 0; i < terrainEdits.indices.length; i++) deltas[terrainEdits.indices[i]] = terrainEdits.deltas[i];
  return encodeFloat32(deltas);
}

/** Inverse of the above: a Terrain component's dense `heightEdits` reduced
 *  back to World's sparse {resolution, indices, deltas} document record
 *  (or `null` when every delta is zero, mirroring `captureWorldTerrainEdits`). */
export function heightEditsToTerrainEdits(heightEdits, resolution) {
  const length = (resolution + 1) ** 2;
  const deltas = decodeFloat32(heightEdits, length);
  const indices = [], values = [];
  for (let i = 0; i < length; i++) if (deltas[i] !== 0) { indices.push(i); values.push(deltas[i]); }
  return indices.length ? { resolution, indices, deltas: values } : null;
}

/** Stateless named variation in [0, 1); unrelated samples never advance it. */
export function featureRandom(seed, featureId, channel) {
  if ((typeof seed !== "string" && !Number.isSafeInteger(seed)) || seed === "") {
    throw new TypeError("Seed must be a string or safe integer");
  }
  const key = stableFeatureId(`${typeof seed}:${seed}`, featureId, channel);
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}
