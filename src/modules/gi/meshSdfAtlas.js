// Per-mesh SDF atlas — the authored scene representation of the voxel-free
// GI pipeline. EVERY GI-relevant mesh gets one 64³ slot in a single tiled
// Data3DTexture (fp16 normalized local distances), plus uniform-array state
// that maps world-space sample points into its LOCAL grid and carries its
// surface color/emissive. The GPU composite pass (sdfScene.js) min()s all
// slots into the global scene field; the shadow/mirror traces additionally
// min() a few DETAIL slots per step for sub-scene-cell crispness.
//
// Everything is uniform arrays + one persistent texture: moving a mesh,
// editing its color, or streaming a freshly baked SDF never recompiles a
// shader. Only a change in slot CAPACITY (mesh count tier) rebuilds.
import * as THREE from "three/webgpu";
import { If, float, int, texture3D, uniform, uniformArray, vec3, vec4 } from "three/tsl";
import { MESH_SDF_CAP, MESH_SDF_MAX_AXIS } from "./bakeCore.js";
import { sharedFn } from "./giFn.js";

const HALF_ONE = 0x3c00; // 1.0 as IEEE 754 half bits — atlas "far" fill

const SLOT = MESH_SDF_MAX_AXIS; // 64 cells per tile axis
const TILES_XY = 4; // 4×4 tiles per Z-layer → 16 slots per 64-deep layer
export const SLOTS_PER_LAYER = TILES_XY * TILES_XY;
export const MAX_ATLAS_LAYERS = 8; // 256×256×512 fp16 = 64MB ceiling
export const MAX_MESH_SDF_SLOTS = SLOTS_PER_LAYER * MAX_ATLAS_LAYERS; // 128
// HI-RES slots: a 2×2×2 block of tiles = 128³ cells for meshes whose
// silhouettes drive shadow quality (characters, large organic props). At
// 64³ a 4m winged character bakes at ~6cm cells — thin wings fall below a
// cell and the SDF melts into detached blobs, which shadows and reflection
// hits then reproduce ("dirty shadows / bad SDFs"). 128³ halves the cell
// (the distance cap scales with the cell).
export const MESH_SDF_HIRES_AXIS = SLOT * 2; // 128
// Slots min()ed PER STEP inside shadow/mirror traces (beyond the composited
// global field). Small fixed count — every step pays for these. THIN
// ANALYTIC slots (plane walls, partitions, inverted-room shells) are
// prioritized into these so shadow rays see their EXACT distances — a
// 0.1m wall in a 0.5m-cell field is otherwise steppable-over (light through
// the partition), and analytic evaluation costs no texture fetch. 12, not
// 10: a Cornell-style room (floor + slabs + walls + a thin panel lamp)
// filled the whole budget with walls, leaving DENSE baked meshes (the
// character) zero refinement — their hi-res SDFs existed but nothing ever
// sampled them, so shadows stayed exactly as coarse as before.
export const DETAIL_SLOTS = 12;
// Floor for the half-thickness, in WORLD METRES, given to an analytic
// primitive that is flat on one axis (a plane). The live value is set per
// build from the field's cell size (`atlas.minAnalyticHalfWorld`) — a wall
// much thinner than a cell is invisible to the trilinear distance texture,
// so sphere-traced mirror rays step straight through it and the reflection
// goes black. This constant only applies before a volume exists.
const MIN_ANALYTIC_HALF_WORLD = 0.01;

/** Capacity tier for a mesh count: whole 16-slot layers, min 1, max 8. */
export const atlasCapacityFor = (meshCount) =>
  Math.min(MAX_ATLAS_LAYERS, Math.max(1, Math.ceil(meshCount / SLOTS_PER_LAYER))) * SLOTS_PER_LAYER;

// ------------------------------------------------- mesh SDF file format
// "GSDF" magic + u32 version + u32 jsonLength + JSON header + u16 half-bits
// grid. Persisted under `<project>/Library/gi-sdf/<contentHash>.sdf`
// (derived data — not next to authored assets). The header carries a cheap
// geometry fingerprint (vertex/index counts) so stale files rebake instead
// of shading with an outdated field.
const SDF_MAGIC = 0x46445347; // "GSDF" little-endian
const SDF_VERSION = 2; // bumped: fp16 payload (was u8) — see decodeMeshSdf

export function encodeMeshSdf(sdf, geometryFingerprint) {
  const header = JSON.stringify({
    dims: sdf.dims,
    boundsMin: sdf.boundsMin,
    boundsSize: sdf.boundsSize,
    minCell: sdf.minCell,
    fingerprint: geometryFingerprint,
  });
  const headerBytes = new TextEncoder().encode(header);
  // sdf.data is a Uint16Array (fp16 half-bits) — view its bytes to copy them
  // into the (byte-oriented) output buffer.
  const payloadBytes = new Uint8Array(sdf.data.buffer, sdf.data.byteOffset, sdf.data.byteLength);
  const out = new Uint8Array(12 + headerBytes.length + sdf.data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, SDF_MAGIC, true);
  view.setUint32(4, SDF_VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(payloadBytes, 12 + headerBytes.length);
  return out;
}

export function decodeMeshSdf(buffer, expectedFingerprint) {
  try {
    const view = new DataView(buffer);
    // Version mismatch — including a pre-existing v1 (u8) file on disk —
    // returns null here. The caller treats a null decode exactly like a
    // missing bake and rebakes from scratch, which is the designed
    // migration path off the old u8 format; no explicit upgrade step needed.
    if (view.getUint32(0, true) !== SDF_MAGIC || view.getUint32(4, true) !== SDF_VERSION) return null;
    const headerLength = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
    if (expectedFingerprint && header.fingerprint !== expectedFingerprint) return null; // stale
    // .slice() copies the payload onto a fresh, offset-0 ArrayBuffer so the
    // Uint16Array view below is always 2-byte aligned, regardless of where
    // (odd or even) the payload happened to land in the source buffer.
    const bytes = new Uint8Array(buffer, 12 + headerLength).slice();
    if (bytes.byteLength !== header.dims.x * header.dims.y * header.dims.z * 2) return null;
    const data = new Uint16Array(bytes.buffer, 0, bytes.byteLength / 2);
    return {
      data,
      dims: header.dims,
      boundsMin: header.boundsMin,
      boundsSize: header.boundsSize,
      minCell: header.minCell,
    };
  } catch {
    return null;
  }
}

export const geometryFingerprintOf = (record) =>
  `${record.positions.length}:${record.index ? record.index.length : 0}`;

/**
 * Content hash of a geometry (strided FNV-1a over positions + index) — the
 * Library persistence key: `Library/gi-sdf/${hash}.sdf`. Cached per geometry
 * object, invalidated by position.version (geometry edits rebake).
 */
const hashCache = new WeakMap(); // geometry → { version, hash }

export function geometryContentHash(geometry) {
  const position = geometry?.attributes?.position;
  if (!position) return null;
  const version = position.version ?? 0;
  const cached = hashCache.get(geometry);
  if (cached && cached.version === version) return cached.hash;
  let hash = 0x811c9dc5;
  const mix = (value) => {
    hash ^= value & 0xffffffff;
    hash = Math.imul(hash, 0x01000193);
  };
  const positions = position.array;
  mix(positions.length);
  const stridePos = Math.max(3, Math.floor(positions.length / 2048) * 3 || 3);
  for (let i = 0; i < positions.length; i += stridePos) mix(Math.round(positions[i] * 4096));
  const index = geometry.index?.array;
  if (index) {
    mix(index.length);
    const strideIdx = Math.max(1, Math.floor(index.length / 2048));
    for (let i = 0; i < index.length; i += strideIdx) mix(index[i]);
  }
  const result = (hash >>> 0).toString(16);
  hashCache.set(geometry, { version, hash: result });
  return result;
}

export class MeshSdfAtlas {
  constructor(capacity = SLOTS_PER_LAYER) {
    this.capacity = Math.min(MAX_MESH_SDF_SLOTS, Math.max(SLOTS_PER_LAYER, capacity));
    const layers = Math.ceil(this.capacity / SLOTS_PER_LAYER);
    this.width = SLOT * TILES_XY;
    this.height = SLOT * TILES_XY;
    this.depth = SLOT * layers;
    this.data = new Uint16Array(this.width * this.height * this.depth).fill(HALF_ONE);
    this.texture = new THREE.Data3DTexture(this.data, this.width, this.height, this.depth);
    this.texture.format = THREE.RedFormat;
    this.texture.type = THREE.HalfFloatType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    const n = this.capacity;
    const makeVec4Array = () => uniformArray(Array.from({ length: n }, () => new THREE.Vector4()));
    // Per-slot GPU state (uniform arrays update every render — mutate in place):
    //   worldToLocal — world → mesh-local transform
    //   aabbMin/aabbMax — world AABB expanded by the global cap distance
    //     (xyz box, aabbMin.w = active flag, aabbMax.w = distScale: decodes a
    //     normalized texture sample to WORLD units)
    //   localMin — local grid origin (w = localToWorldScale, min axis)
    //   cellsPerLocal — local units → slot cells (w unused)
    //   dims — occupied cells in the slot, aspect-fitted ≤ 64 (w unused)
    //   albedo — bake-resolved surface color (w = 1 reliability)
    //   emissive — pre-multiplied emissive (zeroed for promoted emitters)
    this.worldToLocal = uniformArray(Array.from({ length: n }, () => new THREE.Matrix4()));
    this.aabbMin = makeVec4Array();
    this.aabbMax = makeVec4Array();
    this.localMin = makeVec4Array();
    this.cellsPerLocal = makeVec4Array();
    this.dims = makeVec4Array();
    this.albedo = makeVec4Array();
    this.emissive = makeVec4Array();
    // Texel origin of the slot's tile block in the atlas texture (w = block
    // size in tiles: 1 = 64³, 2 = a 2×2×2 hi-res 128³ block). Initialized
    // to the legacy index-derived origins so a slot seated without
    // allocateSlot behaves exactly as before.
    this.tileOrigin = makeVec4Array();
    for (let i = 0; i < n; i++) this.tileOrigin.array[i].set(...this.#tileOriginOf(i), 1);
    // Detail-slot indices (float, -1 = off) for the in-trace refinement.
    this.detailSlots = uniformArray(Array.from({ length: DETAIL_SLOTS }, () => -1), "float");
    // Bumped whenever any slot uniform changes — sdfScene watches it to
    // re-run the composite pass.
    this.revision = 1;
    // Dirty-bounds accumulation for the composite pass (see #markSlotDirty /
    // consumeDirtyBounds below). _dirtyAll starts true — the first composite
    // must cover the whole volume.
    this._dirtyAll = true;
    this._dirtyMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._dirtyMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // CPU-side bookkeeping: which mesh occupies which slot.
    this.assignments = new Array(this.capacity).fill(null); // { mesh, sdf, capLocal, matrixCache }
    this._scratch = {
      v: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      s: new THREE.Vector3(),
      corner: new THREE.Vector3(),
    };
    // World-space reach the AABBs are expanded by (set by sdfScene to the
    // global field's cap distance so AABB-rejected cells legitimately read
    // "far" — anything nearer would leak through the composite).
    this.aabbExpand = 0.5;
    // Minimum world half-thickness for flat analytic primitives; GISystem
    // raises this to a fraction of the field's cell size per build.
    this.minAnalyticHalfWorld = MIN_ANALYTIC_HALF_WORLD;
  }

  /** Texel origin of tile index `i` under the legacy 1-tile-per-slot layout. */
  #tileOriginOf(i) {
    return [
      (i % TILES_XY) * SLOT,
      (Math.floor(i / TILES_XY) % TILES_XY) * SLOT,
      Math.floor(i / SLOTS_PER_LAYER) * SLOT,
    ];
  }

  /** Tile index at tile coordinates (x, y, z). */
  #tileIndexOf(x, y, z) {
    return z * SLOTS_PER_LAYER + y * TILES_XY + x;
  }

  /**
   * Claims a free slot and stamps its tile-block origin. hiRes = a 2×2×2
   * aligned block of free tiles (one 128³ grid): the 7 non-primary tiles
   * are marked `{ reservedBy: primary }` so nothing else seats in them, and
   * clearSlot(primary) frees the whole block. Returns the slot index or -1
   * (callers treat -1 as capacity overflow, same as before).
   */
  allocateSlot(hiRes = false) {
    if (hiRes) {
      const layers = Math.ceil(this.capacity / SLOTS_PER_LAYER);
      for (let z = 0; z + 1 < layers; z += 2) {
        for (let y = 0; y + 1 < TILES_XY; y += 2) {
          for (let x = 0; x + 1 < TILES_XY; x += 2) {
            const members = [];
            for (let dz = 0; dz < 2; dz++)
              for (let dy = 0; dy < 2; dy++)
                for (let dx = 0; dx < 2; dx++) members.push(this.#tileIndexOf(x + dx, y + dy, z + dz));
            if (members.some((m) => m >= this.capacity || this.assignments[m])) continue;
            const primary = this.#tileIndexOf(x, y, z);
            for (const m of members) {
              if (m !== primary) this.assignments[m] = { reservedBy: primary };
            }
            this.tileOrigin.array[primary].set(x * SLOT, y * SLOT, z * SLOT, 2);
            return primary;
          }
        }
      }
      return -1;
    }
    // Singles allocate from the TAIL. First-free-from-zero fragmented every
    // 2×2×2-aligned region as soon as a handful of walls seated, so a
    // hi-res block could NEVER allocate afterwards — seat, overflow,
    // rebuild, identical packing, overflow again: the editor's infinite
    // "[gi] built …" loop.
    let i = -1;
    for (let k = this.assignments.length - 1; k >= 0; k--) {
      if (!this.assignments[k]) {
        i = k;
        break;
      }
    }
    if (i >= 0) this.tileOrigin.array[i].set(...this.#tileOriginOf(i), 1);
    return i;
  }

  /**
   * Seats an ANALYTIC primitive (exact SDF, no texture, no bake): shape =
   * { type: "box"|"sphere", center: [x,y,z], half: [x,y,z] } in LOCAL
   * space. Instantly available (no bake latency at editor launch), exact at
   * ANY size — a 30m floor plane gets a perfect distance function instead
   * of a 0.5m/cell grid whose wobble paints contour swirls into shadows —
   * and solid-interior, so walls seal regardless of thinness. This is the
   * reference demo's analytic-geometry path, kept alongside baked grids.
   */
  setAnalyticSlot(i, mesh, shape, surface) {
    const { center, half } = shape;
    // localMin.xyz doubles as the shape CENTER for analytic slots.
    this.localMin.array[i].set(center[0], center[1], center[2], 1);
    // cellsPerLocal.xyz doubles as half-extents (sphere radius in x).
    // Filled by refreshSlotTransform below — a zero-thickness plane's
    // minimum thickness is a WORLD-space quantity, so it depends on the
    // mesh's live scale.
    this.cellsPerLocal.array[i].set(half[0], half[1], half[2], 0);
    // dims.w = shape selector: 0 grid, 1 box, 2 sphere; +2 = HOLLOW variant
    // (3 box shell, 4 sphere shell) — inverted-normal rooms are shells, not
    // solids, or their whole interior would read "occluded".
    // dims.xyz = the mesh's WORLD scale (refreshed per frame with the
    // transform): analytic distances are evaluated per-axis so a squashed
    // sphere lamp is an ELLIPSOID, not a min-scale shrunken sphere whose
    // 4.5×-underestimated distances over-darkened every shadow around it.
    this.dims.array[i].set(1, 1, 1, (shape.type === "sphere" ? 2 : 1) + (shape.hollow ? 2 : 0));
    this.assignments[i] = {
      analytic: true,
      analyticHalf: [half[0], half[1], half[2]], // TRUE local half-extents
      mesh,
      sdf: {
        boundsMin: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
        boundsSize: [half[0] * 2, half[1] * 2, half[2] * 2],
        minCell: 0,
      },
      capLocal: 0,
      matrixCache: new Float32Array(16).fill(Number.NaN),
    };
    this.setSlotSurface(i, surface);
    this.aabbMin.array[i].w = 1; // active
    this.refreshSlotTransform(i);
    this.revision++;
  }

  /** Uploads a baked grid into slot `i` and wires its static uniforms. */
  setSlot(i, mesh, sdf, surface) {
    const { data, dims, boundsMin, boundsSize, minCell } = sdf;
    // Tile-block origin inside the atlas texture (stamped by allocateSlot;
    // legacy index-derived for slots seated without it). Hi-res slots span
    // a 2×2×2 tile block = 128 cells per axis.
    const origin = this.tileOrigin.array[i];
    const block = SLOT * (origin.w > 1.5 ? 2 : 1);
    const tx = origin.x;
    const ty = origin.y;
    const tz = origin.z;
    for (let z = 0; z < block; z++) {
      for (let y = 0; y < block; y++) {
        const dst = ((tz + z) * this.height + ty + y) * this.width + tx;
        if (z < dims.z && y < dims.y) {
          const src = (z * dims.y + y) * dims.x;
          this.data.set(data.subarray(src, src + dims.x), dst);
          if (dims.x < block) this.data.fill(HALF_ONE, dst + dims.x, dst + block);
        } else {
          this.data.fill(HALF_ONE, dst, dst + block);
        }
      }
    }
    this.texture.needsUpdate = true;

    this.localMin.array[i].set(boundsMin[0], boundsMin[1], boundsMin[2], 1);
    this.cellsPerLocal.array[i].set(
      dims.x / boundsSize[0],
      dims.y / boundsSize[1],
      dims.z / boundsSize[2],
      0,
    );
    this.dims.array[i].set(dims.x, dims.y, dims.z, 0);
    this.assignments[i] = {
      mesh,
      sdf,
      capLocal: MESH_SDF_CAP * minCell,
      matrixCache: new Float32Array(16).fill(Number.NaN),
    };
    this.setSlotSurface(i, surface);
    this.aabbMin.array[i].w = 1; // active
    this.refreshSlotTransform(i);
    this.revision++;
  }

  /** Live surface update (material edits) — no texture churn. */
  setSlotSurface(i, surface) {
    if (!surface) return;
    const albedo = this.albedo.array[i];
    const emissive = this.emissive.array[i];
    const changed =
      Math.abs(albedo.x - surface.color.r) > 1e-4 ||
      Math.abs(albedo.y - surface.color.g) > 1e-4 ||
      Math.abs(albedo.z - surface.color.b) > 1e-4 ||
      Math.abs(emissive.x - surface.emissive.r) > 1e-4 ||
      Math.abs(emissive.y - surface.emissive.g) > 1e-4 ||
      Math.abs(emissive.z - surface.emissive.b) > 1e-4;
    albedo.set(surface.color.r, surface.color.g, surface.color.b, 1);
    emissive.set(surface.emissive.r, surface.emissive.g, surface.emissive.b, 0);
    if (changed) {
      this.revision++;
      this.#markSlotDirty(i);
    }
  }

  clearSlot(i) {
    const assignment = this.assignments[i];
    if (!assignment) return;
    // Reserved members of a hi-res block are freed by their PRIMARY's clear,
    // never directly (GISystem's stale-slot sweep sees their mesh as
    // undefined and would otherwise dissolve live blocks).
    if (assignment.reservedBy != null) return;
    const origin = this.tileOrigin.array[i];
    if (origin.w > 1.5) {
      const x = origin.x / SLOT, y = origin.y / SLOT, z = origin.z / SLOT;
      for (let dz = 0; dz < 2; dz++)
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const m = this.#tileIndexOf(x + dx, y + dy, z + dz);
            if (this.assignments[m]?.reservedBy === i) this.assignments[m] = null;
          }
      origin.w = 1;
    }
    // Mark the slot's box dirty BEFORE deactivating it — that box is about
    // to stop influencing the composite, so the cells it used to cover must
    // be recomputed too.
    this.#markSlotDirty(i);
    this.aabbMin.array[i].w = 0;
    this.assignments[i] = null;
    this.revision++;
  }

  setDetailSlots(indices) {
    for (let k = 0; k < DETAIL_SLOTS; k++) {
      this.detailSlots.array[k] = k < indices.length ? indices[k] : -1;
    }
  }

  /**
   * Expands the dirty-bounds accumulator by slot `i`'s CURRENT world AABB.
   * The box already includes the `aabbExpand` cap reach (refreshSlotTransform
   * expands it by `this.aabbExpand`), which is why this union covers every
   * cell a slot can possibly influence, not just the cells it geometrically
   * overlaps. No-op for an inactive slot — nothing to invalidate.
   */
  #markSlotDirty(i) {
    if (this.aabbMin.array[i].w > 0.5) {
      const bmin = this.aabbMin.array[i];
      const bmax = this.aabbMax.array[i];
      if (bmin.x < this._dirtyMin.x) this._dirtyMin.x = bmin.x;
      if (bmin.y < this._dirtyMin.y) this._dirtyMin.y = bmin.y;
      if (bmin.z < this._dirtyMin.z) this._dirtyMin.z = bmin.z;
      if (bmax.x > this._dirtyMax.x) this._dirtyMax.x = bmax.x;
      if (bmax.y > this._dirtyMax.y) this._dirtyMax.y = bmax.y;
      if (bmax.z > this._dirtyMax.z) this._dirtyMax.z = bmax.z;
    }
  }

  /** Forces the next consumeDirtyBounds() to report "composite everything". */
  markAllDirty() {
    this._dirtyAll = true;
  }

  /**
   * Drains the dirty-bounds accumulator. Returns null to mean "composite the
   * whole volume" — either _dirtyAll was set (e.g. refreshAllSlots after a
   * refit) or nothing was accumulated at all (_dirtyMin.x still +Infinity),
   * which is the fail-safe for any revision bump that forgot to mark a slot
   * dirty. Otherwise returns the accumulated `{ min, max }` AABB. Always
   * resets the accumulator before returning, so bounds never leak into the
   * next accumulation window.
   */
  consumeDirtyBounds() {
    const whole = this._dirtyAll || this._dirtyMin.x === Infinity;
    const result = whole ? null : { min: this._dirtyMin.clone(), max: this._dirtyMax.clone() };
    this._dirtyAll = false;
    this._dirtyMin.set(Infinity, Infinity, Infinity);
    this._dirtyMax.set(-Infinity, -Infinity, -Infinity);
    return result;
  }

  /** True when slot `i`'s cached world matrix differs from the live one. */
  #matrixChanged(assignment, mesh) {
    const cache = assignment.matrixCache;
    const e = mesh.matrixWorld.elements;
    for (let k = 0; k < 16; k++) {
      if (Math.abs(cache[k] - e[k]) > 1e-7 || Number.isNaN(cache[k])) return true;
    }
    return false;
  }

  /** Recomputes slot `i`'s transform-derived uniforms from the live matrix. */
  refreshSlotTransform(i) {
    const assignment = this.assignments[i];
    // Reserved hi-res block members carry no mesh — only their primary has
    // transform state.
    if (!assignment || assignment.reservedBy != null) return;
    // Dirty the OLD box before it's overwritten below; the second call at
    // the end of this method dirties the NEW box — together a moved slot
    // invalidates both where it was and where it is.
    this.#markSlotDirty(i);
    const { mesh, sdf, capLocal } = assignment;
    assignment.matrixCache.set(mesh.matrixWorld.elements);
    this.worldToLocal.array[i].copy(mesh.matrixWorld).invert();
    const { v, q, s, corner } = this._scratch;
    mesh.matrixWorld.decompose(v, q, s);
    const minScale = Math.max(1e-4, Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
    this.aabbMax.array[i].w = capLocal * minScale; // distScale
    this.localMin.array[i].w = minScale; // localToWorldScale
    // Analytic slots evaluate distances PER-AXIS — keep the live world
    // scale in dims.xyz (grid slots keep their cell dims there).
    if (assignment.analytic) {
      const sx = Math.max(1e-4, Math.abs(s.x));
      const sy = Math.max(1e-4, Math.abs(s.y));
      const sz = Math.max(1e-4, Math.abs(s.z));
      this.dims.array[i].set(sx, sy, sz, this.dims.array[i].w);
      // MINIMUM THICKNESS IN WORLD UNITS. A zero-thickness plane needs a
      // sliver of interior for the solid-box SDF to block against, but the
      // shader multiplies these local half-extents by the world scale — so a
      // local epsilon becomes an arbitrarily thick slab on a scaled mesh
      // (a 20× wall plane grew to 0.6m thick, standing 0.3m proud of the
      // surface being rendered). Divide the world minimum back out instead,
      // so every wall is the same thickness no matter its scale.
      const half = assignment.analyticHalf;
      if (half) {
        const w = this.minAnalyticHalfWorld ?? MIN_ANALYTIC_HALF_WORLD;
        this.cellsPerLocal.array[i].set(
          Math.max(half[0], w / sx),
          Math.max(half[1], w / sy),
          Math.max(half[2], w / sz),
          0,
        );
      }
    }
    // World AABB of the slot's LOCAL bounds, expanded by the global cap
    // reach: 8 transformed corners. Read from the assignment (NOT the
    // localMin uniform — analytic slots store their CENTER there).
    const bm = sdf.boundsMin;
    const bs = sdf.boundsSize;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      corner.set(
        bm[0] + (c & 1 ? bs[0] : 0),
        bm[1] + (c & 2 ? bs[1] : 0),
        bm[2] + (c & 4 ? bs[2] : 0),
      );
      corner.applyMatrix4(mesh.matrixWorld);
      if (corner.x < minX) minX = corner.x;
      if (corner.y < minY) minY = corner.y;
      if (corner.z < minZ) minZ = corner.z;
      if (corner.x > maxX) maxX = corner.x;
      if (corner.y > maxY) maxY = corner.y;
      if (corner.z > maxZ) maxZ = corner.z;
    }
    const r = this.aabbExpand;
    this.aabbMin.array[i].set(minX - r, minY - r, minZ - r, this.aabbMin.array[i].w);
    const dw = this.aabbMax.array[i].w;
    this.aabbMax.array[i].set(maxX + r, maxY + r, maxZ + r, dw);
    // Dirty the NEW box — see the comment at the top of this method.
    this.#markSlotDirty(i);
  }

  /**
   * Re-derives EVERY resident slot's transform uniforms and bumps the
   * revision unconditionally. Needed after `aabbExpand` changes (an
   * in-place volume refit changes capWorld): the per-frame epsilon diff
   * in refreshTransforms would skip unmoved meshes, leaving their world
   * AABBs expanded by the stale cap.
   */
  refreshAllSlots() {
    // A refit changes volume bounds/capWorld — every cell is invalid, slot
    // unions are NOT enough.
    this.markAllDirty();
    for (let i = 0; i < this.assignments.length; i++) {
      if (this.assignments[i]) this.refreshSlotTransform(i);
    }
    this.revision++;
  }

  /**
   * Per-frame: refresh transform uniforms for slots whose mesh moved.
   * Returns true when anything changed (caller re-runs the composite).
   */
  refreshTransforms() {
    let changed = false;
    for (let i = 0; i < this.assignments.length; i++) {
      const assignment = this.assignments[i];
      if (!assignment || assignment.reservedBy != null) continue;
      const { mesh } = assignment;
      if (!mesh.parent && !mesh.isMesh) {
        this.clearSlot(i);
        changed = true;
        continue;
      }
      if (this.#matrixChanged(assignment, mesh)) {
        this.refreshSlotTransform(i);
        changed = true;
      }
    }
    if (changed) this.revision++;
    return changed;
  }

  // ------------------------------------------------------------ TSL helpers

  /**
   * World-space lower-bound distance to slot `s` (an int/float node) at
   * world point `p`. Analytic slots (dims.w: 1 = box, 2 = sphere) return
   * EXACT solid distances; grid slots return clamped local sample +
   * distance-to-grid-box (valid everywhere; exact inside the cap band).
   * Non-uniform scale uses the min axis — an underestimate, the safe
   * direction for sphere tracing.
   */
  sampleSlot(s, p) {
    // ONE WGSL FUNCTION PER SHADER (see giFn.js). A bare `Fn()` is INLINED at
    // every call site — TSL only emits a real function when a layout is set —
    // and a layout on a SHARED Fn bakes one shader's buffer/texture bindings
    // into every other shader that includes it. `sharedFn` resolves both: a
    // fresh layout'd instance per NodeBuilder. Before this, the ~5-branch body
    // below was stamped out dozens of times per material (a mirror material
    // reached ~57 copies), which is what made GI fragment shaders 180-250kB of
    // WGSL and cost the driver seconds per shader.
    this._sampleSlotShared ??= sharedFn({
      name: "giSampleSlot",
      type: "float",
      inputs: [
        { name: "slot", type: "int" },
        { name: "p", type: "vec3" },
      ],
      body: (slotIdx, pw) => this.#sampleSlotBody(slotIdx, pw),
    });
    return this._sampleSlotShared(int(s), vec3(p));
  }

  #sampleSlotBody(s, p) {
    const local = this.worldToLocal.element(s).mul(vec4(p, 1)).xyz.toVar();
    const lm = this.localMin.element(s).toVar();
    const cpl = this.cellsPerLocal.element(s).xyz.toVar();
    const dims4 = this.dims.element(s).toVar();
    const out = float(0).toVar();
    If(dims4.w.lessThan(0.5), () => {
      // Baked grid slot.
      const cellF = local.sub(lm.xyz).mul(cpl).toVar();
      const clamped = cellF.clamp(vec3(0.5), dims4.xyz.sub(0.5)).toVar();
      const outsideWorld = cellF.sub(clamped).div(cpl).length().mul(lm.w).toVar();
      // Tile-block origin from the per-slot uniform — hi-res slots occupy a
      // 2×2×2 tile block, so origins are no longer derivable from the index.
      const tile = this.tileOrigin.element(s).toVar();
      const uvw = vec3(
        tile.x.add(clamped.x).div(this.width),
        tile.y.add(clamped.y).div(this.height),
        tile.z.add(clamped.z).div(this.depth),
      );
      const dLocal = texture3D(this.texture, uvw).level(0).r.mul(this.aabbMax.element(s).w);
      // Outside the grid box: √(d(q)² + |p−q|²), the TIGHT valid lower
      // bound (projection inequality — q is the box's closest point, so
      // |p−s|² ≥ |p−q|² + |q−s|² for any surface point s). The previous
      // d(q) + |p−q| OVERestimated (triangle inequality runs the other
      // way), letting sphere-traced rays step across geometry that sat
      // near a slot's AABB face — occasional missed shadows/hits.
      out.assign(dLocal.mul(dLocal).add(outsideWorld.mul(outsideWorld)).sqrt());
    })
      .ElseIf(dims4.w.lessThan(1.5), () => {
        // Analytic BOX (solid): lm.xyz = center, cpl = half extents.
        // Per-axis world scale (dims.xyz) keeps a scaled box EXACT — an
        // axis-aligned local scale maps a box to a box.
        const q = local.sub(lm.xyz).abs().mul(dims4.xyz).sub(cpl.mul(dims4.xyz)).toVar();
        const d = q.max(vec3(0)).length().add(q.x.max(q.y).max(q.z).min(0));
        out.assign(d.max(0));
      })
      .ElseIf(dims4.w.lessThan(2.5), () => {
        // Analytic SPHERE → ELLIPSOID under non-uniform scale (radii =
        // r·scale): iq's bound k0·(k0−1)/k1 — proportionate everywhere,
        // unlike the old min-scale sphere whose distances shrank by the
        // squash factor and over-darkened every nearby penumbra.
        //
        // BOTH the radii AND the sample offset must be in WORLD units. The
        // offset used to be left in LOCAL units while the radii were scaled,
        // so the zero-crossing sat at |p_local| = r·scale, i.e. the sphere
        // read `scale`× TOO BIG in the world — a scale-8 sphere filled the
        // ENTIRE field with distance 0 (measured: 262144/262144 cells
        // occupied). Everything downstream then broke at once: zero SDF
        // gradient → no reflection normal (black mirror balls), every
        // shadow ray instantly occluded, probes buried inside "solid".
        const r = dims4.xyz.mul(cpl.xyz).toVar();
        const p = local.sub(lm.xyz).mul(dims4.xyz).toVar();
        const k0 = p.div(r).length().toVar();
        const k1 = p.div(r.mul(r)).length().max(1e-6).toVar();
        out.assign(k0.mul(k0.sub(1)).div(k1).max(0));
      })
      .ElseIf(dims4.w.lessThan(3.5), () => {
        // Analytic BOX SHELL (inverted-normal room): |signed| — the walls
        // seal, the interior is open space.
        const q = local.sub(lm.xyz).abs().mul(dims4.xyz).sub(cpl.mul(dims4.xyz)).toVar();
        const d = q.max(vec3(0)).length().add(q.x.max(q.y).max(q.z).min(0));
        out.assign(d.abs());
      })
      .Else(() => {
        // Analytic SPHERE SHELL → ellipsoid shell: |bound|. Same world-unit
        // pairing as the solid case above.
        const r = dims4.xyz.mul(cpl.xyz).toVar();
        const p = local.sub(lm.xyz).mul(dims4.xyz).toVar();
        const k0 = p.div(r).length().toVar();
        const k1 = p.div(r.mul(r)).length().max(1e-6).toVar();
        out.assign(k0.mul(k0.sub(1)).div(k1).abs());
      });
    return out;
  }

  /**
   * Returns `d` min()ed with the DETAIL slots at world point `p` — used per
   * step by the shadow and mirror traces for sub-scene-cell crispness.
   * Cheap AABB + active rejection first. A shared Fn (see sampleSlot):
   * callers do `d.assign(atlas.refineDetail(d, p))`.
   */
  refineDetail(d, p) {
    this._refineDetailShared ??= sharedFn({
      name: "giRefineDetail",
      type: "float",
      inputs: [
        { name: "d", type: "float" },
        { name: "p", type: "vec3" },
      ],
      body: (dIn, pw) => {
        // Loop bound = the per-quality budget (set by GISystem before graphs
        // build) — unused iterations would still cost shader code size.
        const budget = Math.min(DETAIL_SLOTS, this.detailBudget ?? DETAIL_SLOTS);
        const out = float(dIn).toVar();
        for (let k = 0; k < budget; k++) {
          const s = this.detailSlots.element(k).toVar();
          If(s.greaterThanEqual(0), () => {
            const si = s.toInt();
            const bmin = this.aabbMin.element(si);
            const bmax = this.aabbMax.element(si);
            const inside = pw.x.greaterThan(bmin.x)
              .and(pw.y.greaterThan(bmin.y))
              .and(pw.z.greaterThan(bmin.z))
              .and(pw.x.lessThan(bmax.x))
              .and(pw.y.lessThan(bmax.y))
              .and(pw.z.lessThan(bmax.z))
              .and(bmin.w.greaterThan(0.5));
            If(inside, () => {
              out.assign(out.min(this.sampleSlot(si, pw)));
            });
          });
        }
        return out;
      },
    });
    return this._refineDetailShared(float(d), vec3(p));
  }
}
