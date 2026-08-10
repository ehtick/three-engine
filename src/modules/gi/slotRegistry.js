// SLOT REGISTRY — the CPU-side census of GI placements.
//
// WHAT THIS FILE USED TO BE, because the name still carries it: a per-mesh SDF
// atlas. Every GI-relevant mesh got a 64³ tile in one Data3DTexture of fp16
// local distances, plus nine per-slot uniform arrays that mapped world points
// into its local grid, and TSL to sample it (`sampleSlot`) and to min() a few
// DETAIL slots per trace step (`refineDetail`). All of that is gone:
//   · the SDF bake pipeline was deleted 2026-08-02 (SDF-free won on
//     measurement — see the killSdf note in GISystem);
//   · the GPU composite that bound the uniform arrays was deleted with the
//     dense transport (SRC rebuild §12.8/§12.9);
//   · the tile texture had ALREADY been reduced to a 4×4×4 token holding "far",
//     because no bake could ever arrive to fill it — the real 58 MB was
//     reclaimed then, so this deletion frees code, not VRAM.
//
// WHAT IS LEFT IS LOAD-BEARING and is why the file survives at all. Something
// has to know which placements exist, carry each one's surface, and NOTICE WHEN
// ONE MOVES — `revision` is the wake signal the occupancy pyramid's refresh
// branch triggers on (GISystem#tick), so without this census a dragged mesh
// would mark the field dirty and nothing would ever consume it.
//
// It is pure CPU state now: no texture, no uniforms, no TSL. Slot numbering is
// still stable for a slot's life because `assignments[i]` is how a live scene
// entry is matched to a seated placement across frames (#syncSlots).
import * as THREE from "three/webgpu";

// 512 placements. Was half of WebGPU's guaranteed 64KB uniform-buffer binding
// (512 mat4s = 32KB) back when every slot had GPU state; now it is only a CPU
// array bound, kept because it is also the pyramid's own slot ceiling
// (GISystem passes it as `slotCapacity`) and the two must not disagree.
export const MAX_INSTANCE_SLOTS = 512;
// Capacity granularity. The 16 is inherited: it was SLOTS_PER_LAYER, one Z-layer
// of the 4×4-tile atlas. It survives purely as a rounding quantum so that a
// scene gaining one prop does not re-tier and rebuild.
const SLOT_BLOCK = 16;
/** Instance capacity for a placement count: whole blocks of 16. */
export const instanceCapacityFor = (placements) =>
  Math.min(MAX_INSTANCE_SLOTS, Math.ceil(Math.max(1, placements) / SLOT_BLOCK) * SLOT_BLOCK);

/**
 * Content hash of a geometry (strided FNV-1a over positions + index). Was the
 * `Library/gi-sdf/<hash>.sdf` persistence key; now used only to give repeated
 * geometry one identity. Cached per geometry object, invalidated by
 * position.version so a geometry edit re-hashes.
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

/**
 * Identity of one PLACEMENT. A plain mesh is identified by itself; an
 * InstancedMesh contributes one placement per instance, so it needs the
 * instance index too. Used to match live scene entries against seated slots.
 */
export const slotKeyOf = (mesh, instanceId = null) =>
  instanceId == null ? mesh : `${mesh.uuid}#${instanceId}`;

export class SlotRegistry {
  /** @param {number} [capacity] world placements this registry can seat. */
  constructor(capacity = SLOT_BLOCK) {
    this.capacity = Math.min(MAX_INSTANCE_SLOTS, Math.max(SLOT_BLOCK, capacity));
    // Bumped whenever any placement is seated, cleared or moved — NOT when one
    // is merely recoloured. GISystem#tick's field-refresh branch triggers on a
    // change here, so this counter is the ONLY thing that turns a mesh drag
    // into a re-voxelize.
    this.revision = 1;
    // ── AND A RECOLOUR IS NOT A RE-VOXELIZE (SRC Phase 5) ──────────────────
    //
    // Colour used to bump `revision` too, which woke the pyramid: the deleted
    // coarse attribution grid held COLOURS per cell, so the only way to change
    // one was to re-run the voxelizer that wrote it. Its successor
    // (`srcSurface.js`) stamps a SLOT ID per surface record and keeps colour in
    // a 512-entry palette, so a material edit is a uniform write and a
    // 512-thread dispatch — nothing re-rasterizes, nothing re-fits, no bricks
    // move. Splitting the counter is what lets a consumer say that.
    //
    // Nothing else was reading `revision` for colour: the composite that used
    // to is gone (§12.9), `bvhScene.js` keeps its own per-mesh table, and
    // `dynamicObjects.writeSurface` is driven by its own material stamp.
    this.surfaceRevision = 1;
    // { mesh, instanceId, key, analytic, analyticHalf, matrixCache, surface }
    this.assignments = new Array(this.capacity).fill(null);
    this._freeSlots = [];
    for (let i = this.capacity - 1; i >= 0; i--) this._freeSlots.push(i);
    this._scratch = { m: new THREE.Matrix4(), world: new THREE.Matrix4() };
  }

  /** Claims a free slot. -1 = capacity full. */
  allocateSlot() {
    return this._freeSlots.length ? this._freeSlots.pop() : -1;
  }

  /** Returns a slot claimed by allocateSlot but never seated. */
  releaseSlot(i) {
    if (i >= 0 && !this.assignments[i] && !this._freeSlots.includes(i)) this._freeSlots.push(i);
  }

  /**
   * Seats a placement whose shape was resolved to an analytic primitive
   * (`{ type, center, half, hollow }` in LOCAL space — see primitiveFit).
   *
   * Under SDF-free EVERY placement arrives here: #buildEntries synthesizes a
   * bounding box for anything `fitPrimitive` could not name, so there is no
   * second seating path any more (`setSlot`, which uploaded a baked grid into a
   * texture tile, went with the bake pipeline). The shape is retained because
   * #syncSlots reads `analytic.half`/`analytic.hollow` to classify thin walls,
   * not because anything evaluates a distance from it.
   */
  setAnalyticSlot(i, mesh, shape, surface, instanceId = null) {
    const { half } = shape;
    this.assignments[i] = {
      analytic: true,
      analyticHalf: [half[0], half[1], half[2]],
      mesh,
      instanceId,
      key: slotKeyOf(mesh, instanceId),
      surface: null,
      matrixCache: new Float32Array(16).fill(Number.NaN),
    };
    this.setSlotSurface(i, surface);
    this.refreshSlotTransform(i);
    this.revision++;
  }

  /**
   * Live surface update (material edits). Bumps `surfaceRevision` — and ONLY
   * that — on a real change: the editor re-publishes surfaces every sync, so an
   * unconditional bump would re-upload the palette every frame, and a bump of
   * `revision` would re-voxelize the scene for a colour change.
   */
  setSlotSurface(i, surface) {
    const assignment = this.assignments[i];
    if (!assignment || !surface) return;
    const previous = assignment.surface;
    const changed =
      !previous ||
      Math.abs(previous.color.r - surface.color.r) > 1e-4 ||
      Math.abs(previous.color.g - surface.color.g) > 1e-4 ||
      Math.abs(previous.color.b - surface.color.b) > 1e-4 ||
      Math.abs(previous.emissive.r - surface.emissive.r) > 1e-4 ||
      Math.abs(previous.emissive.g - surface.emissive.g) > 1e-4 ||
      Math.abs(previous.emissive.b - surface.emissive.b) > 1e-4;
    assignment.surface = {
      color: { r: surface.color.r, g: surface.color.g, b: surface.color.b },
      emissive: { r: surface.emissive.r, g: surface.emissive.g, b: surface.emissive.b },
    };
    if (changed) this.surfaceRevision++;
  }

  clearSlot(i) {
    if (!this.assignments[i]) return;
    this.assignments[i] = null;
    this._freeSlots.push(i);
    this.revision++;
    // A cleared slot changes what the palette holds as well as what the pyramid
    // holds: its entry has to go back to "unattributed" or the next mesh to
    // take the slot inherits the old one's colour for a frame.
    this.surfaceRevision++;
  }

  /**
   * World matrix of a placement. A plain mesh IS its `matrixWorld`; an
   * InstancedMesh placement is that matrix composed with the instance's own
   * (three keeps instance matrices in the mesh's LOCAL space). Returns a
   * scratch matrix in the instanced case — copy it before the next call.
   */
  worldMatrixOf(assignment) {
    const { mesh, instanceId } = assignment;
    if (instanceId == null || !mesh.isInstancedMesh) return mesh.matrixWorld;
    const m = this._scratch.m;
    mesh.getMatrixAt(instanceId, m);
    return m.premultiply(mesh.matrixWorld);
  }

  /** True when slot `i`'s cached world matrix differs from the live one. */
  #matrixChanged(assignment) {
    const cache = assignment.matrixCache;
    const e = this.worldMatrixOf(assignment).elements;
    for (let k = 0; k < 16; k++) {
      if (Math.abs(cache[k] - e[k]) > 1e-7 || Number.isNaN(cache[k])) return true;
    }
    return false;
  }

  /**
   * Re-caches slot `i`'s world matrix. That cache IS the whole job now — it is
   * what `#matrixChanged` compares against, and therefore what decides whether
   * a frame bumps the revision. (It used to also derive nine uniform arrays:
   * worldToLocal, the cap-expanded world AABB, per-axis world scale for
   * analytic evaluation, and a world-minimum plane thickness. Every one of
   * those was read only by the composite and the SDF traces.)
   */
  refreshSlotTransform(i) {
    const assignment = this.assignments[i];
    if (!assignment) return;
    const world = this._scratch.world.copy(this.worldMatrixOf(assignment));
    assignment.matrixCache.set(world.elements);
  }

  /** Re-caches EVERY seated slot and bumps the revision unconditionally. */
  refreshAllSlots() {
    for (let i = 0; i < this.assignments.length; i++) {
      if (this.assignments[i]) this.refreshSlotTransform(i);
    }
    this.revision++;
  }

  /**
   * Per-frame: re-cache slots whose mesh moved. Returns true when anything
   * changed — the caller re-voxelizes the pyramid.
   */
  refreshTransforms() {
    let changed = false;
    for (let i = 0; i < this.assignments.length; i++) {
      const assignment = this.assignments[i];
      if (!assignment) continue;
      const { mesh } = assignment;
      if (!mesh.parent && !mesh.isMesh) {
        this.clearSlot(i);
        changed = true;
        continue;
      }
      if (this.#matrixChanged(assignment)) {
        this.refreshSlotTransform(i);
        changed = true;
      }
    }
    if (changed) this.revision++;
    return changed;
  }
}
