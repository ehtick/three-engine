/**
 * Hybrid ray-hit layouts shared by CPU validation and TSL builders.
 *
 * The Phase-1 tail contains two dense regions and is appended to the existing
 * occupancy-pyramid storage buffer. Keeping all hierarchy data in one
 * allocation is deliberate: the composed GI graph must remain within the
 * portable eight-storage-buffer stage limit.
 *
 * MacroCell (2 u32): brickIndex, metadata
 * BrickHeader (4 u32): occupancyLow, occupancyHigh, surfaceOffset,
 *                      complexOffset
 * SurfaceRecord (4 u32): packedNormal, packedPlaneCoverage, materialId,
 *                        flags (Phase 3 stores coverage in this last word)
 */
export const BRICK_RESOLUTION = 4;
export const BRICK_VOXEL_COUNT = 64;
// 192, not 128: the macro grid's worst-case diagonal (e.g. 88+40+56 cells for
// a 352×160×224 field) is ~184 crossings, so 128 exhausted on long grazing
// rays even WITHOUT the coarse ride — and exhaustion used to fail open.
export const MAX_MACRO_STEPS = 192;
export const MAX_BRICK_STEPS = 16;
export const MAX_COMPLEX_TRIANGLES = 16;

export const MACRO_CELL_WORDS = 2;
export const BRICK_HEADER_WORDS = 4;

export const MACRO_CELL_BRICK_INDEX_WORD = 0;
export const MACRO_CELL_METADATA_WORD = 1;
export const BRICK_OCCUPANCY_LOW_WORD = 0;
export const BRICK_OCCUPANCY_HIGH_WORD = 1;
export const BRICK_SURFACE_OFFSET_WORD = 2;
export const BRICK_COMPLEX_OFFSET_WORD = 3;

export const INVALID_RAY_HIT_INDEX = 0xffffffff;

export const MacroCellType = Object.freeze({
  Empty: 0,
  UniformOccupied: 1,
  Brick: 2,
  DynamicBrick: 3,
});

export const MACRO_CELL_SKIP_BITS = 6;
export const MACRO_CELL_SKIP_MASK = (1 << MACRO_CELL_SKIP_BITS) - 1;
export const MACRO_CELL_TYPE_SHIFT = 6;
export const MACRO_CELL_TYPE_MASK = 0b11;
export const MACRO_CELL_COVERAGE_SHIFT = 8;
export const MACRO_CELL_COVERAGE_MASK = 0xff;
export const MACRO_CELL_GENERATION_SHIFT = 16;
export const MACRO_CELL_GENERATION_MASK = 0xff;
export const MACRO_CELL_FLAGS_SHIFT = 24;
export const MACRO_CELL_FLAGS_MASK = 0xff;

/** World-t advance used after crossing a DDA face. */
export const RAY_HIT_DDA_EPSILON = 1e-4;
export const RAY_HIT_DIRECTION_EPSILON = 1e-8;

export function voxelIndexInBrick(x, y, z) {
  return x + y * BRICK_RESOLUTION + z * BRICK_RESOLUTION * BRICK_RESOLUTION;
}

export function packMacroCellMetadata({
  skipDistance = 0,
  type = MacroCellType.Empty,
  coverage = 0,
  generation = 0,
  flags = 0,
} = {}) {
  return (
    (skipDistance & MACRO_CELL_SKIP_MASK) |
    ((type & MACRO_CELL_TYPE_MASK) << MACRO_CELL_TYPE_SHIFT) |
    ((coverage & MACRO_CELL_COVERAGE_MASK) << MACRO_CELL_COVERAGE_SHIFT) |
    ((generation & MACRO_CELL_GENERATION_MASK) << MACRO_CELL_GENERATION_SHIFT) |
    ((flags & MACRO_CELL_FLAGS_MASK) << MACRO_CELL_FLAGS_SHIFT)
  ) >>> 0;
}

export function unpackMacroCellMetadata(metadata) {
  const value = metadata >>> 0;
  return {
    skipDistance: value & MACRO_CELL_SKIP_MASK,
    type: (value >>> MACRO_CELL_TYPE_SHIFT) & MACRO_CELL_TYPE_MASK,
    coverage: (value >>> MACRO_CELL_COVERAGE_SHIFT) & MACRO_CELL_COVERAGE_MASK,
    generation: (value >>> MACRO_CELL_GENERATION_SHIFT) & MACRO_CELL_GENERATION_MASK,
    flags: (value >>> MACRO_CELL_FLAGS_SHIFT) & MACRO_CELL_FLAGS_MASK,
  };
}

export function planHybridBrickLayout(resolution) {
  const macroResolution = {
    x: Math.ceil(resolution.x / BRICK_RESOLUTION),
    y: Math.ceil(resolution.y / BRICK_RESOLUTION),
    z: Math.ceil(resolution.z / BRICK_RESOLUTION),
  };
  const macroCellCount = macroResolution.x * macroResolution.y * macroResolution.z;
  const macroCellOffset = 0;
  const brickHeaderOffset = macroCellCount * MACRO_CELL_WORDS;
  return Object.freeze({
    macroResolution: Object.freeze(macroResolution),
    macroCellCount,
    brickCount: macroCellCount,
    macroCellOffset,
    brickHeaderOffset,
    totalWords: brickHeaderOffset + macroCellCount * BRICK_HEADER_WORDS,
  });
}

export function macroCellLinearIndex(x, y, z, macroResolution) {
  return (z * macroResolution.y + y) * macroResolution.x + x;
}

export function macroCellWord(layout, macroIndex, fieldWord) {
  return layout.macroCellOffset + macroIndex * MACRO_CELL_WORDS + fieldWord;
}

export function brickHeaderWord(layout, brickIndex, fieldWord) {
  return layout.brickHeaderOffset + brickIndex * BRICK_HEADER_WORDS + fieldWord;
}

/**
 * Deterministic CPU mirror of the GPU Phase-1 packing pass.
 * `occupied(x,y,z)` must return truthy only for valid level-0 occupied cells.
 */
export function buildHybridBrickWords(resolution, occupied) {
  const layout = planHybridBrickLayout(resolution);
  const words = new Uint32Array(layout.totalWords);

  for (let mz = 0; mz < layout.macroResolution.z; mz++) {
    for (let my = 0; my < layout.macroResolution.y; my++) {
      for (let mx = 0; mx < layout.macroResolution.x; mx++) {
        const macroIndex = macroCellLinearIndex(mx, my, mz, layout.macroResolution);
        let low = 0;
        let high = 0;
        let occupiedCount = 0;
        for (let z = 0; z < BRICK_RESOLUTION; z++) {
          for (let y = 0; y < BRICK_RESOLUTION; y++) {
            for (let x = 0; x < BRICK_RESOLUTION; x++) {
              const gx = mx * BRICK_RESOLUTION + x;
              const gy = my * BRICK_RESOLUTION + y;
              const gz = mz * BRICK_RESOLUTION + z;
              if (gx >= resolution.x || gy >= resolution.y || gz >= resolution.z || !occupied(gx, gy, gz)) continue;
              const bit = voxelIndexInBrick(x, y, z);
              if (bit < 32) low = (low | (1 << bit)) >>> 0;
              else high = (high | (1 << (bit - 32))) >>> 0;
              occupiedCount++;
            }
          }
        }

        const hasBrick = occupiedCount > 0;
        words[macroCellWord(layout, macroIndex, MACRO_CELL_BRICK_INDEX_WORD)] = hasBrick
          ? macroIndex
          : INVALID_RAY_HIT_INDEX;
        words[macroCellWord(layout, macroIndex, MACRO_CELL_METADATA_WORD)] = packMacroCellMetadata({
          type: hasBrick ? MacroCellType.Brick : MacroCellType.Empty,
          coverage: Math.floor((occupiedCount / BRICK_VOXEL_COUNT) * 255),
          generation: 1,
        });
        words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_LOW_WORD)] = low;
        words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_HIGH_WORD)] = high;
        words[brickHeaderWord(layout, macroIndex, BRICK_SURFACE_OFFSET_WORD)] = INVALID_RAY_HIT_INDEX;
        words[brickHeaderWord(layout, macroIndex, BRICK_COMPLEX_OFFSET_WORD)] = INVALID_RAY_HIT_INDEX;
      }
    }
  }

  return { layout, words };
}

export function hybridBrickOccupied(words, layout, x, y, z, resolution) {
  if (x < 0 || y < 0 || z < 0 || x >= resolution.x || y >= resolution.y || z >= resolution.z) return false;
  const mx = Math.floor(x / BRICK_RESOLUTION);
  const my = Math.floor(y / BRICK_RESOLUTION);
  const mz = Math.floor(z / BRICK_RESOLUTION);
  const macroIndex = macroCellLinearIndex(mx, my, mz, layout.macroResolution);
  const brickIndex = words[macroCellWord(layout, macroIndex, MACRO_CELL_BRICK_INDEX_WORD)];
  if (brickIndex === INVALID_RAY_HIT_INDEX) return false;
  const bit = voxelIndexInBrick(x & 3, y & 3, z & 3);
  const word = words[brickHeaderWord(
    layout,
    brickIndex,
    bit < 32 ? BRICK_OCCUPANCY_LOW_WORD : BRICK_OCCUPANCY_HIGH_WORD,
  )];
  return ((word >>> (bit & 31)) & 1) !== 0;
}

function cpuDdaDelta(position, direction, cellSize) {
  const deltas = [Infinity, Infinity, Infinity];
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis];
    if (Math.abs(d) < RAY_HIT_DIRECTION_EPSILON) continue;
    const cell = Math.floor(position[axis] / cellSize);
    const boundary = (cell + (d >= 0 ? 1 : 0)) * cellSize;
    deltas[axis] = Math.max(0, (boundary - position[axis]) / d);
  }
  let axis = 0;
  if (deltas[1] < deltas[axis]) axis = 1;
  if (deltas[2] < deltas[axis]) axis = 2;
  return { delta: deltas[axis], axis };
}

function cpuPointAt(origin, direction, t) {
  return [
    origin[0] + direction[0] * t,
    origin[1] + direction[1] * t,
    origin[2] + direction[2] * t,
  ];
}

function cpuInside(position, resolution) {
  return position[0] >= 0 && position[1] >= 0 && position[2] >= 0 &&
    position[0] < resolution.x && position[1] < resolution.y && position[2] < resolution.z;
}

/** CPU reference for the legacy flat occupied-cell-box semantics. */
export function traceVoxelBoxesCpu(
  origin,
  direction,
  resolution,
  occupied,
  { tMin = 0, tMax = Infinity, maxSteps = 4096 } = {},
) {
  let t = tMin;
  let axis = -1;
  for (let steps = 1; steps <= maxSteps; steps++) {
    if (t >= tMax) return { hit: false, resolved: true, steps };
    const p = cpuPointAt(origin, direction, t);
    if (!cpuInside(p, resolution)) return { hit: false, resolved: true, steps };
    const voxel = p.map(Math.floor);
    if (occupied(voxel[0], voxel[1], voxel[2])) return { hit: true, resolved: true, t, axis, voxel, steps };
    const next = cpuDdaDelta(p, direction, 1);
    if (!Number.isFinite(next.delta)) return { hit: false, resolved: true, steps };
    axis = next.axis;
    t += next.delta + RAY_HIT_DDA_EPSILON;
  }
  return { hit: false, resolved: false, limit: "voxel" };
}

/**
 * Deterministic CPU mirror of the OR-downsampled occupancy pyramid the GPU
 * macro loop rides for its conservative empty-space skips.
 *
 * `levelCount` defaults to five to mirror OCC_LEVELS in occupancyField.js;
 * the tracers below ride levels 3-4 only, so a shorter pyramid is out of
 * contract. Level-L resolution is `max(1, res >> L)` per axis — the same clamp
 * `planLevels` applies — and a level-L cell is occupied iff ANY of its up to
 * eight level-(L-1) children is. Out-of-range children contribute nothing,
 * which equals the GPU downsample's index clamp: a clamped child index always
 * aliases a sibling the same parent already covers.
 *
 * Per-level Sets of packed keys, not bitsets: validation grids are small, and
 * a Set keeps the mirror obviously correct rather than obviously fast.
 */
export function buildOccupancyPyramidCpu(resolution, occupied, levelCount = 5) {
  const levels = [];
  for (let level = 0; level < levelCount; level++) {
    const res = {
      x: Math.max(1, resolution.x >> level),
      y: Math.max(1, resolution.y >> level),
      z: Math.max(1, resolution.z >> level),
    };
    const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < res.x && y < res.y && z < res.z;
    if (level === 0) {
      levels.push({ res, occupied: (x, y, z) => inside(x, y, z) && !!occupied(x, y, z) });
      continue;
    }
    const child = levels[level - 1];
    const set = new Set();
    for (let z = 0; z < res.z; z++) {
      for (let y = 0; y < res.y; y++) {
        for (let x = 0; x < res.x; x++) {
          let any = false;
          for (let dz = 0; dz < 2 && !any; dz++) {
            for (let dy = 0; dy < 2 && !any; dy++) {
              for (let dx = 0; dx < 2 && !any; dx++) {
                any = child.occupied(x * 2 + dx, y * 2 + dy, z * 2 + dz);
              }
            }
          }
          if (any) set.add((z * res.y + y) * res.x + x);
        }
      }
    }
    levels.push({
      res,
      occupied: (x, y, z) => inside(x, y, z) && set.has((z * res.y + y) * res.x + x),
    });
  }
  return { levelCount, levels };
}

/** CPU reference for the Phase-1 coarse + local DDA. Coordinates are level-0 voxels. */
export function traceHybridBrickBoxesCpu(
  origin,
  direction,
  resolution,
  words,
  layout,
  { tMin = 0, tMax = Infinity, maxMacroSteps = MAX_MACRO_STEPS, pyramid = null, failClosed = true } = {},
) {
  let t = tMin;
  let axis = -1;
  let brickSteps = 0;
  // Mirrors the GPU macro loop's `level` var. Without a pyramid it stays at 2,
  // which disables the ride entirely — the pre-Phase-5 behaviour, bit for bit.
  let level = pyramid ? pyramid.levelCount - 1 : 2;
  let coarseSteps = 0;
  let coarseSkipsL3 = 0;
  let coarseSkipsL4 = 0;
  let coarseDescends = 0;
  // Discriminates detail from open road at exhaustion: true while the last
  // processed macro cell carried a brick. Mirrors the GPU var exactly.
  let lastBrick = false;
  const coarseOut = () => ({ coarseSteps, coarseSkipsL3, coarseSkipsL4, coarseDescends });
  // Exhaustion used to FAIL OPEN (hit:false), which read as "nothing blocked
  // this ray" — a hole in geometry, and at grazing incidence a white dot.
  // Failing closed from detail is the same clamp the legacy traceBody applies.
  const exhausted = (limit, macroSteps) => (failClosed && lastBrick
    ? { hit: true, resolved: false, failClosed: true, limit, t, axis, macroSteps, brickSteps, ...coarseOut() }
    : { hit: false, resolved: false, limit, macroSteps, brickSteps, ...coarseOut() });
  for (let macroSteps = 1; macroSteps <= maxMacroSteps; macroSteps++) {
    if (t >= tMax) return { hit: false, resolved: true, macroSteps, brickSteps, ...coarseOut() };
    const p = cpuPointAt(origin, direction, t);
    if (!cpuInside(p, resolution)) return { hit: false, resolved: true, macroSteps, brickSteps, ...coarseOut() };
    // Conservative pyramid ride above level 2 (level 2 IS one 4^3 macro cell,
    // so descending further would just duplicate the Phase-1 leaf walk). An
    // occupied ancestor descends WITHOUT advancing t; a descend that lands AT
    // the macro level falls through and processes the macro cell in this SAME
    // iteration (the GPU does too, and step-count parity depends on it) —
    // otherwise rays hugging occupied geometry pay two iterations per macro
    // cell and exhaust the budget at half distance.
    if (pyramid && level > 2) {
      coarseSteps++;
      const scale = 1 << level;
      const levelData = pyramid.levels[level];
      const coarseCell = p.map((value) => Math.floor(value / scale));
      if (levelData.occupied(coarseCell[0], coarseCell[1], coarseCell[2])) {
        coarseDescends++;
        level--;
        if (level > 2) continue; // still coarse: re-test one level down
      } else {
        const next = cpuDdaDelta(p, direction, scale);
        if (!Number.isFinite(next.delta)) {
          return { hit: false, resolved: true, macroSteps, brickSteps, ...coarseOut() };
        }
        axis = next.axis;
        if (level === 3) coarseSkipsL3++;
        else coarseSkipsL4++;
        t += next.delta + RAY_HIT_DDA_EPSILON;
        level = Math.min(level + 1, pyramid.levelCount - 1);
        continue;
      }
    }
    const macro = p.map((value) => Math.floor(value / BRICK_RESOLUTION));
    const macroIndex = macroCellLinearIndex(macro[0], macro[1], macro[2], layout.macroResolution);
    const metadata = unpackMacroCellMetadata(
      words[macroCellWord(layout, macroIndex, MACRO_CELL_METADATA_WORD)],
    );
    const macroNext = cpuDdaDelta(p, direction, BRICK_RESOLUTION);
    const macroExit = t + macroNext.delta;

    if (metadata.type === MacroCellType.Brick) {
      lastBrick = true;
      let localT = t;
      let localResolved = false;
      for (let localStep = 0; localStep < MAX_BRICK_STEPS; localStep++) {
        if (localT >= Math.min(macroExit, tMax) + RAY_HIT_DDA_EPSILON) {
          localResolved = true;
          break;
        }
        brickSteps++;
        const localP = cpuPointAt(origin, direction, localT);
        const voxel = localP.map(Math.floor);
        if (hybridBrickOccupied(words, layout, voxel[0], voxel[1], voxel[2], resolution)) {
          return { hit: true, resolved: true, t: localT, axis, voxel, macroSteps, brickSteps, ...coarseOut() };
        }
        const cellNext = cpuDdaDelta(localP, direction, 1);
        if (!Number.isFinite(cellNext.delta)) return { hit: false, resolved: true, macroSteps, brickSteps, ...coarseOut() };
        axis = cellNext.axis;
        localT += cellNext.delta + RAY_HIT_DDA_EPSILON;
      }
      if (!localResolved) return exhausted("brick", macroSteps);
      axis = macroNext.axis;
    } else {
      lastBrick = false;
      axis = macroNext.axis;
    }

    if (!Number.isFinite(macroNext.delta)) return { hit: false, resolved: true, macroSteps, brickSteps, ...coarseOut() };
    t = macroExit + RAY_HIT_DDA_EPSILON;
    if (pyramid) level = 3; // re-ascend after a macro cell, as the GPU does
  }
  return exhausted("macro", maxMacroSteps);
}

// ---------------------------------------------------------------------------
// Phase 2: compact simple-plane records
// ---------------------------------------------------------------------------

/** Four u32 words, matching the SurfaceRecord layout in the design document. */
export const SURFACE_RECORD_WORDS = 4;
export const SURFACE_PACKED_NORMAL_WORD = 0;
export const SURFACE_PACKED_PLANE_COVERAGE_WORD = 1;
export const SURFACE_MATERIAL_ID_WORD = 2;
export const SURFACE_FLAGS_WORD = 3;

export const PLANE_OFFSET_MASK = 0xffff;
export const SURFACE_COVERAGE_SHIFT = 16;
export const SURFACE_CONFIDENCE_SHIFT = 24;
export const SURFACE_BYTE_MASK = 0xff;

/**
 * A cell-local point is expressed in [0, 1]^3. Consequently dot(n, p) is in
 * [-sqrt(3), sqrt(3)] for every unit normal. Keeping the range explicit makes
 * the CPU and shader quantizers easy to mirror and avoids world-space offsets.
 */
export const CELL_LOCAL_PLANE_OFFSET_RANGE = Math.sqrt(3);
export const PLANE_PARALLEL_EPSILON = 1e-7;
export const CELL_BOUNDS_EPSILON = 1e-6;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function signNotZero(value) {
  return value < 0 ? -1 : 1;
}

function normalize3(value) {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 0) || !Number.isFinite(length)) return [0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** Octahedrally encode a normal to two values in [-1, 1]. */
export function octEncodeNormal(normal) {
  const n = normalize3(normal);
  const inverseL1 = 1 / (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  let x = n[0] * inverseL1;
  let y = n[1] * inverseL1;
  if (n[2] < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * signNotZero(oldX);
    y = (1 - Math.abs(oldX)) * signNotZero(y);
  }
  return [x, y];
}

/** Decode the floating-point octahedral representation returned above. */
export function octDecodeNormal(encoded) {
  const x = clamp(encoded[0], -1, 1);
  const y = clamp(encoded[1], -1, 1);
  let nx = x;
  let ny = y;
  let nz = 1 - Math.abs(x) - Math.abs(y);
  if (nz < 0) {
    nx = (1 - Math.abs(y)) * signNotZero(x);
    ny = (1 - Math.abs(x)) * signNotZero(y);
  }
  return normalize3([nx, ny, nz]);
}

function packSnorm16(value) {
  return Math.round(clamp(value, -1, 1) * 32767) & 0xffff;
}

function unpackSnorm16(value) {
  const bits = value & 0xffff;
  return clamp((bits & 0x8000 ? bits - 0x10000 : bits) / 32767, -1, 1);
}

/** Pack an octahedral normal as x:snorm16 | y:snorm16. */
export function packOctNormal(normal) {
  const encoded = octEncodeNormal(normal);
  return (packSnorm16(encoded[0]) | (packSnorm16(encoded[1]) << 16)) >>> 0;
}

/** Decode x:snorm16 | y:snorm16 into a normalized three-component vector. */
export function unpackOctNormal(packed) {
  const word = packed >>> 0;
  return octDecodeNormal([
    unpackSnorm16(word),
    unpackSnorm16(word >>> 16),
  ]);
}

/** Pack a cell-local plane offset to signed normalized 16-bit storage. */
export function packPlaneOffset(offset, range = CELL_LOCAL_PLANE_OFFSET_RANGE) {
  if (!(range > 0) || !Number.isFinite(range)) throw new RangeError("plane offset range must be finite and positive");
  return packSnorm16(offset / range);
}

/** Decode a cell-local signed normalized 16-bit plane offset. */
export function unpackPlaneOffset(packed, range = CELL_LOCAL_PLANE_OFFSET_RANGE) {
  if (!(range > 0) || !Number.isFinite(range)) throw new RangeError("plane offset range must be finite and positive");
  return unpackSnorm16(packed) * range;
}

/** Pack plane offset, scalar coverage, and confidence into one u32. */
export function packPlaneCoverage({ planeOffset = 0, coverage = 0, confidence = 0 } = {}) {
  return (
    packPlaneOffset(planeOffset) |
    ((coverage & SURFACE_BYTE_MASK) << SURFACE_COVERAGE_SHIFT) |
    ((confidence & SURFACE_BYTE_MASK) << SURFACE_CONFIDENCE_SHIFT)
  ) >>> 0;
}

export function unpackPlaneCoverage(packed) {
  const word = packed >>> 0;
  return {
    planeOffset: unpackPlaneOffset(word & PLANE_OFFSET_MASK),
    coverage: (word >>> SURFACE_COVERAGE_SHIFT) & SURFACE_BYTE_MASK,
    confidence: (word >>> SURFACE_CONFIDENCE_SHIFT) & SURFACE_BYTE_MASK,
  };
}

/** Build one GPU-ready four-word simple-plane record. */
export function packSimplePlaneRecord({
  normal = [0, 0, 1],
  planeOffset = 0,
  coverage = 0,
  confidence = 0,
  materialId = 0,
  flags = 0,
} = {}) {
  return new Uint32Array([
    packOctNormal(normal),
    packPlaneCoverage({ planeOffset, coverage, confidence }),
    materialId >>> 0,
    flags >>> 0,
  ]);
}

export function unpackSimplePlaneRecord(words, offset = 0) {
  const plane = unpackPlaneCoverage(words[offset + SURFACE_PACKED_PLANE_COVERAGE_WORD]);
  return {
    normal: unpackOctNormal(words[offset + SURFACE_PACKED_NORMAL_WORD]),
    ...plane,
    materialId: words[offset + SURFACE_MATERIAL_ID_WORD] >>> 0,
    flags: words[offset + SURFACE_FLAGS_WORD] >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: conservative dominant-axis 4x4 coverage
// ---------------------------------------------------------------------------

export const COVERAGE_RESOLUTION = 4;
export const COVERAGE_TEXEL_COUNT = 16;
export const COVERAGE_MASK_MASK = 0xffff;
export const COVERAGE_AXIS_SHIFT = 16;
export const COVERAGE_AXIS_MASK = 0b11;
export const COVERAGE_VALID_SHIFT = 18;
export const COVERAGE_FLAGS_SHIFT = 19;
export const COVERAGE_FLAGS_MASK = 0x1fff;

export const DominantAxis = Object.freeze({ X: 0, Y: 1, Z: 2 });

/** Stable largest-absolute-component selection; ties prefer X, then Y. */
export function dominantAxis(normal) {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return DominantAxis.X;
  if (ay >= az) return DominantAxis.Y;
  return DominantAxis.Z;
}

/** Drop the dominant component, returning coverage-space [u, v]. */
export function projectToDominantAxis(point, axis) {
  if (axis === DominantAxis.X) return [point[1], point[2]];
  if (axis === DominantAxis.Y) return [point[0], point[2]];
  return [point[0], point[1]];
}

/** One packed word suitable for SurfaceRecord.flags (or a separate u32 array). */
export function packCoverageRecord({ mask = 0, axis = DominantAxis.Z, valid = true, flags = 0 } = {}) {
  return (
    (mask & COVERAGE_MASK_MASK) |
    ((axis & COVERAGE_AXIS_MASK) << COVERAGE_AXIS_SHIFT) |
    ((valid ? 1 : 0) << COVERAGE_VALID_SHIFT) |
    ((flags & COVERAGE_FLAGS_MASK) << COVERAGE_FLAGS_SHIFT)
  ) >>> 0;
}

export function unpackCoverageRecord(packed) {
  const word = packed >>> 0;
  return {
    mask: word & COVERAGE_MASK_MASK,
    axis: (word >>> COVERAGE_AXIS_SHIFT) & COVERAGE_AXIS_MASK,
    valid: ((word >>> COVERAGE_VALID_SHIFT) & 1) !== 0,
    flags: (word >>> COVERAGE_FLAGS_SHIFT) & COVERAGE_FLAGS_MASK,
  };
}

/** Dilate a 4x4 bit mask without wrapping across rows. */
export function dilateCoverageMask(mask, radius = 1) {
  let source = mask & COVERAGE_MASK_MASK;
  let result = source;
  const passes = Math.max(0, Math.floor(radius));
  for (let pass = 0; pass < passes; pass++) {
    let expanded = source;
    for (let y = 0; y < COVERAGE_RESOLUTION; y++) {
      for (let x = 0; x < COVERAGE_RESOLUTION; x++) {
        const bit = 1 << (x + y * COVERAGE_RESOLUTION);
        if ((source & bit) === 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < COVERAGE_RESOLUTION && ny >= 0 && ny < COVERAGE_RESOLUTION) {
              expanded |= 1 << (nx + ny * COVERAGE_RESOLUTION);
            }
          }
        }
      }
    }
    source = expanded & COVERAGE_MASK_MASK;
    result |= source;
  }
  return result & COVERAGE_MASK_MASK;
}

function orient2d(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function pointInTriangle2d(point, a, b, c, epsilon) {
  const e0 = orient2d(a, b, point);
  const e1 = orient2d(b, c, point);
  const e2 = orient2d(c, a, point);
  return (e0 >= -epsilon && e1 >= -epsilon && e2 >= -epsilon) ||
    (e0 <= epsilon && e1 <= epsilon && e2 <= epsilon);
}

function pointInRect2d(point, minX, minY, maxX, maxY, epsilon) {
  return point[0] >= minX - epsilon && point[0] <= maxX + epsilon &&
    point[1] >= minY - epsilon && point[1] <= maxY + epsilon;
}

// Liang-Barsky clipping includes collinear and boundary-touching segments.
function segmentIntersectsRect2d(a, b, minX, minY, maxX, maxY, epsilon) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - minX + epsilon, maxX - a[0] + epsilon, a[1] - minY + epsilon, maxY - a[1] + epsilon];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) <= epsilon) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function triangleIntersectsRect2d(a, b, c, minX, minY, maxX, maxY, epsilon) {
  const triangleMinX = Math.min(a[0], b[0], c[0]);
  const triangleMaxX = Math.max(a[0], b[0], c[0]);
  const triangleMinY = Math.min(a[1], b[1], c[1]);
  const triangleMaxY = Math.max(a[1], b[1], c[1]);
  if (triangleMaxX < minX - epsilon || triangleMinX > maxX + epsilon ||
      triangleMaxY < minY - epsilon || triangleMinY > maxY + epsilon) return false;

  if (pointInRect2d(a, minX, minY, maxX, maxY, epsilon) ||
      pointInRect2d(b, minX, minY, maxX, maxY, epsilon) ||
      pointInRect2d(c, minX, minY, maxX, maxY, epsilon)) return true;

  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  if (corners.some((corner) => pointInTriangle2d(corner, a, b, c, epsilon))) return true;

  return segmentIntersectsRect2d(a, b, minX, minY, maxX, maxY, epsilon) ||
    segmentIntersectsRect2d(b, c, minX, minY, maxX, maxY, epsilon) ||
    segmentIntersectsRect2d(c, a, minX, minY, maxX, maxY, epsilon);
}

function triangleNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
}

/**
 * Conservatively rasterize one cell-local triangle into a 4x4 projection.
 * Every triangle/texel overlap, including a boundary touch, sets the texel.
 * One-texel dilation is enabled by default as required for Phase 3.
 */
export function rasterizeTriangleCoverageMask(a, b, c, {
  axis = dominantAxis(triangleNormal(a, b, c)),
  dilate = true,
  epsilon = 1e-9,
} = {}) {
  const pa = projectToDominantAxis(a, axis);
  const pb = projectToDominantAxis(b, axis);
  const pc = projectToDominantAxis(c, axis);
  let mask = 0;
  for (let y = 0; y < COVERAGE_RESOLUTION; y++) {
    for (let x = 0; x < COVERAGE_RESOLUTION; x++) {
      const minX = x / COVERAGE_RESOLUTION;
      const minY = y / COVERAGE_RESOLUTION;
      const maxX = (x + 1) / COVERAGE_RESOLUTION;
      const maxY = (y + 1) / COVERAGE_RESOLUTION;
      if (triangleIntersectsRect2d(pa, pb, pc, minX, minY, maxX, maxY, epsilon)) {
        mask |= 1 << (x + y * COVERAGE_RESOLUTION);
      }
    }
  }
  mask &= COVERAGE_MASK_MASK;
  return dilate ? dilateCoverageMask(mask, 1) : mask;
}

/** Union any number of triangles in a shared dominant-axis projection. */
export function buildCoverageMask(triangles, normal, { dilate = true, epsilon = 1e-9 } = {}) {
  const axis = dominantAxis(normal);
  let mask = 0;
  for (const triangle of triangles) {
    mask |= rasterizeTriangleCoverageMask(triangle[0], triangle[1], triangle[2], {
      axis,
      dilate: false,
      epsilon,
    });
  }
  mask &= COVERAGE_MASK_MASK;
  return { axis, mask: dilate ? dilateCoverageMask(mask, 1) : mask };
}

/** Test a cell-local 3D point against one packed 4x4 projection mask. */
export function coverageMaskContainsPoint(mask, point, axis, epsilon = CELL_BOUNDS_EPSILON) {
  const projected = projectToDominantAxis(point, axis);
  if (projected[0] < -epsilon || projected[0] > 1 + epsilon ||
      projected[1] < -epsilon || projected[1] > 1 + epsilon) return false;
  const x = clamp(Math.floor(clamp(projected[0], 0, 1) * COVERAGE_RESOLUTION), 0, COVERAGE_RESOLUTION - 1);
  const y = clamp(Math.floor(clamp(projected[1], 0, 1) * COVERAGE_RESOLUTION), 0, COVERAGE_RESOLUTION - 1);
  return (((mask & COVERAGE_MASK_MASK) >>> (x + y * COVERAGE_RESOLUTION)) & 1) !== 0;
}

// ---------------------------------------------------------------------------
// Phase 2: surface-record build — CPU mirror of the GPU allocate / accumulate /
// finalize passes. All geometry below is in LEVEL-0 VOXEL SPACE (a cell is the
// unit cube), which is the same space the GPU voxelizer and DDA work in; the
// caller transforms world triangles first and transforms normals back with
// `voxelInv` afterwards.
// ---------------------------------------------------------------------------

/**
 * Build-pass scratch layout, one record's accumulators:
 * [nx, ny, nz, weight, d, d2, count, covX, covY, covZ]. The GPU pass stores
 * these as fixed-point atomic i32 (scale SURFACE_FIT_SCALE); the CPU mirror
 * keeps floats — integer adds are order-independent on the GPU so both are
 * deterministic, and the mirror validates the ALGORITHM against exact
 * triangles, not buffer bytes.
 */
export const SURFACE_SCRATCH_WORDS = 10;
export const SURFACE_FIT_SCALE = 32768;
/** packCoverageRecord `flags` bit 0 (word bit 19): the fitted plane is usable. */
export const SURFACE_FLAG_SIMPLE = 1;
/** Classification thresholds (design doc's suggested initial values). */
export const SIMPLE_MAX_TRIANGLES = 8;
export const SIMPLE_MIN_COHERENCE = 0.9;
export const SIMPLE_MAX_PLANE_SIGMA = 0.1;
/** Plane-through-cell tolerance, in cell units. */
export const SIMPLE_PLANE_IN_CELL_EPSILON = 0.05;
/** Triangle weight clamp (voxel-space area). The floor keeps sliver triangles
 * from vanishing under fixed-point quantization on the GPU. */
export const SURFACE_MIN_WEIGHT = 1e-4;
export const SURFACE_MAX_WEIGHT = 1;
/** Cell-interval tolerance for accepting a plane hit, in voxel units. */
export const PLANE_HIT_INTERVAL_EPSILON = 1e-3;

// ── Phase 4: exact complex-cell triangle lists ──────────────────────────────
// A complex cell reuses its ALREADY-ALLOCATED four-word SurfaceRecord slot:
// word 2 (materialId, reserved until now) becomes a packed triangle range into
// a pool appended to the same `bits` allocation, and the flags subfield gains
// a COMPLEX marker. No new record storage, no new bindings.
/** packCoverageRecord `flags` bit 1 (word bit 20): exact triangle list valid. */
export const SURFACE_FLAG_COMPLEX = 2;
/** One pool triangle: 3 vertices × xyz, f32-bitcast, CELL-LOCAL voxel space. */
export const COMPLEX_TRIANGLE_WORDS = 9;
/** SurfaceRecord word 2 = poolOffset (triangles) | count << 26. */
export const COMPLEX_RANGE_OFFSET_MASK = (1 << 26) - 1;
export const COMPLEX_RANGE_COUNT_SHIFT = 26;
export const COMPLEX_RANGE_COUNT_MASK = 0x3f;

export function packComplexRange(offset, count) {
  return ((offset & COMPLEX_RANGE_OFFSET_MASK) |
    ((count & COMPLEX_RANGE_COUNT_MASK) << COMPLEX_RANGE_COUNT_SHIFT)) >>> 0;
}

export function unpackComplexRange(word) {
  const value = word >>> 0;
  return {
    offset: value & COMPLEX_RANGE_OFFSET_MASK,
    count: (value >>> COMPLEX_RANGE_COUNT_SHIFT) & COMPLEX_RANGE_COUNT_MASK,
  };
}

export function popcount32(value) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Rank of `bit` inside a 64-bit brick mask = surface-record index offset. */
export function brickRank(low, high, bit) {
  if (bit < 32) return popcount32(low & (((1 << bit) >>> 0) - 1));
  return popcount32(low) + popcount32(high & (((1 << (bit - 32)) >>> 0) - 1));
}

const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Akenine-Möller triangle/AABB separating-axis test — the CPU mirror of the
 * voxelizer's conservative overlap. Box center `c`, half extent `h` (scalar),
 * triangle `a,b,c2`, all in voxel space.
 */
export function triBoxOverlapCpu(center, h, a, b, c2) {
  const v0 = v3sub(a, center);
  const v1 = v3sub(b, center);
  const v2 = v3sub(c2, center);
  const e0 = v3sub(v1, v0);
  const e1 = v3sub(v2, v1);
  const e2 = v3sub(v0, v2);

  const axisTest = (pa, pb, rad) => !(Math.min(pa, pb) > rad || Math.max(pa, pb) < -rad);
  const f = (e) => [Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])];
  const f0 = f(e0), f1 = f(e1), f2 = f(e2);

  // 9 cross-product axes with Akenine-Möller's exact vertex pairings.
  const tX = (e, fe, pa, pb) => axisTest(
    e[2] * pa[1] - e[1] * pa[2], e[2] * pb[1] - e[1] * pb[2], fe[2] * h + fe[1] * h);
  const tY = (e, fe, pa, pb) => axisTest(
    -e[2] * pa[0] + e[0] * pa[2], -e[2] * pb[0] + e[0] * pb[2], fe[2] * h + fe[0] * h);
  const tZ = (e, fe, pa, pb) => axisTest(
    e[1] * pa[0] - e[0] * pa[1], e[1] * pb[0] - e[0] * pb[1], fe[1] * h + fe[0] * h);
  if (!tX(e0, f0, v0, v2) || !tY(e0, f0, v0, v2) || !tZ(e0, f0, v1, v2)) return false;
  if (!tX(e1, f1, v0, v2) || !tY(e1, f1, v0, v2) || !tZ(e1, f1, v0, v1)) return false;
  if (!tX(e2, f2, v0, v1) || !tY(e2, f2, v0, v1) || !tZ(e2, f2, v1, v2)) return false;

  // 3 box face normals.
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.min(v0[axis], v1[axis], v2[axis]);
    const hi = Math.max(v0[axis], v1[axis], v2[axis]);
    if (lo > h || hi < -h) return false;
  }

  // Triangle plane vs box.
  const n = v3cross(e0, e1);
  const rad = h * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  return Math.abs(v3dot(n, v0)) <= rad;
}

/**
 * CPU mirror of the three GPU surface-record build passes.
 *
 * 1. ALLOCATE: one dense record per occupied voxel, per brick, indexed by the
 *    voxel's rank in the brick mask. Offsets are written into the brick
 *    headers inside `words` (mutated in place). Overflow leaves the brick's
 *    surfaceOffset INVALID — those cells keep occupied-box semantics.
 * 2. ACCUMULATE: every (triangle, voxel) conservative overlap adds an
 *    area-weighted normal, a cell-local plane offset (+ its square, for the
 *    layer-spread sigma), and three dominant-axis coverage projections.
 * 3. FINALIZE: classify simple vs complex and pack SurfaceRecords. A complex
 *    cell whose triangle list fits the Phase-4 limit and the pool takes an
 *    exact cell-local triangle range instead (word 2 + the COMPLEX flag);
 *    every other record stays all-zero (no SIMPLE and no COMPLEX flag), which
 *    the tracer reads as "use the occupied-box fallback" — a classification
 *    can therefore never become a miss.
 *
 * `triangles` are [[ax,ay,az],[bx,by,bz],[cx,cy,cz]] in level-0 voxel space.
 */
export function buildSurfaceRecordsCpu(resolution, words, layout, triangles, {
  capacity = 1 << 16,
  maxTriangles = SIMPLE_MAX_TRIANGLES,
  minCoherence = SIMPLE_MIN_COHERENCE,
  maxPlaneSigma = SIMPLE_MAX_PLANE_SIGMA,
  triangleCapacity = capacity * 2,
  maxComplexTriangles = MAX_COMPLEX_TRIANGLES,
} = {}) {
  // --- pass 1: allocation, deterministic linear scan.
  let next = 0;
  let overflowBricks = 0;
  for (let macroIndex = 0; macroIndex < layout.macroCellCount; macroIndex++) {
    const brickIndex = words[macroCellWord(layout, macroIndex, MACRO_CELL_BRICK_INDEX_WORD)];
    const offsetWord = brickHeaderWord(layout, macroIndex, BRICK_SURFACE_OFFSET_WORD);
    if (brickIndex === INVALID_RAY_HIT_INDEX) {
      words[offsetWord] = INVALID_RAY_HIT_INDEX;
      continue;
    }
    const low = words[brickHeaderWord(layout, brickIndex, BRICK_OCCUPANCY_LOW_WORD)];
    const high = words[brickHeaderWord(layout, brickIndex, BRICK_OCCUPANCY_HIGH_WORD)];
    const count = popcount32(low) + popcount32(high);
    if (count === 0 || next + count > capacity) {
      words[offsetWord] = INVALID_RAY_HIT_INDEX;
      if (count > 0) overflowBricks++;
      continue;
    }
    words[offsetWord] = next;
    next += count;
  }

  // --- pass 2: accumulation.
  const acc = new Float64Array(next * 6); // nx ny nz w d d2
  const counts = new Uint32Array(next);
  const cov = new Uint32Array(next * 3);
  // Phase 4 side channels: the cell each record belongs to (its pool-local
  // origin) and the triangles that touched it, in accumulation order. Lists
  // stop one past the limit — enough to detect over-limit, never unbounded.
  const origins = new Int32Array(next * 3);
  const triangleLists = new Map();
  const recordIndexOf = (x, y, z) => {
    const mx = Math.floor(x / BRICK_RESOLUTION);
    const my = Math.floor(y / BRICK_RESOLUTION);
    const mz = Math.floor(z / BRICK_RESOLUTION);
    const macroIndex = macroCellLinearIndex(mx, my, mz, layout.macroResolution);
    const offset = words[brickHeaderWord(layout, macroIndex, BRICK_SURFACE_OFFSET_WORD)];
    if (offset === INVALID_RAY_HIT_INDEX) return -1;
    const low = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_LOW_WORD)];
    const high = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_HIGH_WORD)];
    const bit = voxelIndexInBrick(x & 3, y & 3, z & 3);
    const set = bit < 32 ? (low >>> bit) & 1 : (high >>> (bit - 32)) & 1;
    if (!set) return -1;
    return offset + brickRank(low, high, bit);
  };

  const h = 0.5 + 1e-4; // the voxelizer's conservative half extent
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
    const [a, b, c] = triangles[triangleIndex];
    const n = v3cross(v3sub(b, a), v3sub(c, a));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 1e-12)) continue; // degenerate: no plane information
    const nhat = [n[0] / len, n[1] / len, n[2] / len];
    const w = clamp(len * 0.5, SURFACE_MIN_WEIGHT, SURFACE_MAX_WEIGHT);
    const lo = [0, 1, 2].map((axis) =>
      Math.max(0, Math.floor(Math.min(a[axis], b[axis], c[axis]) - 0.5)));
    const hi = [0, 1, 2].map((axis) => Math.min(
      [resolution.x, resolution.y, resolution.z][axis] - 1,
      Math.floor(Math.max(a[axis], b[axis], c[axis]) + 0.5)));
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let x = lo[0]; x <= hi[0]; x++) {
          if (!triBoxOverlapCpu([x + 0.5, y + 0.5, z + 0.5], h, a, b, c)) continue;
          const record = recordIndexOf(x, y, z);
          if (record < 0) continue;
          origins[record * 3] = x;
          origins[record * 3 + 1] = y;
          origins[record * 3 + 2] = z;
          let list = triangleLists.get(record);
          if (list === undefined) triangleLists.set(record, list = []);
          if (list.length <= maxComplexTriangles) list.push(triangleIndex);
          const localA = v3sub(a, [x, y, z]);
          const localB = v3sub(b, [x, y, z]);
          const localC = v3sub(c, [x, y, z]);
          const centroid = [
            (localA[0] + localB[0] + localC[0]) / 3,
            (localA[1] + localB[1] + localC[1]) / 3,
            (localA[2] + localB[2] + localC[2]) / 3,
          ];
          const d = v3dot(nhat, centroid);
          const base = record * 6;
          acc[base] += nhat[0] * w;
          acc[base + 1] += nhat[1] * w;
          acc[base + 2] += nhat[2] * w;
          acc[base + 3] += w;
          acc[base + 4] += d * w;
          acc[base + 5] += d * d * w;
          counts[record]++;
          for (let axis = 0; axis < 3; axis++) {
            cov[record * 3 + axis] |= rasterizeTriangleCoverageMask(localA, localB, localC, {
              axis,
              dilate: false,
            });
          }
        }
      }
    }
  }

  // --- pass 3: finalize + pack.
  const records = new Uint32Array(capacity * SURFACE_RECORD_WORDS);
  const pool = [];
  let simpleCells = 0;
  let complexCells = 0;
  let complexRecords = 0;
  let complexOverflowCells = 0;
  let poolTriangles = 0;
  // Phase 4: a complex cell keeps its own triangles, cell-local and UNCLIPPED.
  // An unclipped triangle can be hit outside this cell's ray interval; the
  // tracer's interval test rejects that, and the cell the hit really falls in
  // holds the same triangle (the voxelizer is conservative), so nothing is lost.
  // Both limits are the packed range's own field widths — exceeding either
  // would silently wrap word 2, so the cell degrades to a box instead.
  const countLimit = Math.min(maxComplexTriangles, COMPLEX_RANGE_COUNT_MASK);
  const poolLimit = Math.min(triangleCapacity, COMPLEX_RANGE_OFFSET_MASK + 1);
  const emitComplex = (record) => {
    const list = triangleLists.get(record);
    if (list === undefined || list.length === 0) return;
    if (list.length > countLimit || poolTriangles + list.length > poolLimit) {
      complexOverflowCells++;
      return;
    }
    const originX = origins[record * 3];
    const originY = origins[record * 3 + 1];
    const originZ = origins[record * 3 + 2];
    for (const triangleIndex of list) {
      const [a, b, c] = triangles[triangleIndex];
      pool.push(
        a[0] - originX, a[1] - originY, a[2] - originZ,
        b[0] - originX, b[1] - originY, b[2] - originZ,
        c[0] - originX, c[1] - originY, c[2] - originZ,
      );
    }
    const base = record * SURFACE_RECORD_WORDS;
    records[base + SURFACE_MATERIAL_ID_WORD] = packComplexRange(poolTriangles, list.length);
    records[base + SURFACE_FLAGS_WORD] = packCoverageRecord({
      mask: 0, axis: 0, valid: false, flags: SURFACE_FLAG_COMPLEX,
    });
    poolTriangles += list.length;
    complexRecords++;
  };

  for (let record = 0; record < next; record++) {
    const base = record * 6;
    const weight = acc[base + 3];
    if (!(weight > 0)) { complexCells++; continue; }
    const sumLen = Math.hypot(acc[base], acc[base + 1], acc[base + 2]);
    const coherence = sumLen / weight;
    // Cancelling normals (a thin wall's opposing faces) leave no plane to fit,
    // which is exactly the case Phase 4 exists to resolve — still eligible.
    if (!(sumLen > 1e-6)) { complexCells++; emitComplex(record); continue; }
    const nhat = [acc[base] / sumLen, acc[base + 1] / sumLen, acc[base + 2] / sumLen];
    const dhat = acc[base + 4] / weight;
    const variance = Math.max(0, acc[base + 5] / weight - dhat * dhat);
    const sigma = Math.sqrt(variance);
    const cornerRadius = 0.5 * (Math.abs(nhat[0]) + Math.abs(nhat[1]) + Math.abs(nhat[2]));
    const centerProjection = 0.5 * (nhat[0] + nhat[1] + nhat[2]);
    const planeInCell = Math.abs(dhat - centerProjection) <= cornerRadius + SIMPLE_PLANE_IN_CELL_EPSILON;
    const simple = counts[record] <= maxTriangles &&
      coherence >= minCoherence &&
      sigma <= maxPlaneSigma &&
      planeInCell;
    if (!simple) { complexCells++; emitComplex(record); continue; }
    simpleCells++;
    const axis = dominantAxis(nhat);
    // RAW mask packed; dilation happens at TEST time (gather only) — mirrors
    // the GPU finalize. See the finalize's note: fit-time dilation made most
    // boundary masks full and voxel-quantized every shadow silhouette.
    const mask = cov[record * 3 + axis] & 0xffff;
    const packed = packSimplePlaneRecord({
      normal: nhat,
      planeOffset: clamp(dhat, -CELL_LOCAL_PLANE_OFFSET_RANGE, CELL_LOCAL_PLANE_OFFSET_RANGE),
      coverage: Math.min(255, Math.floor((popcount32(mask) / COVERAGE_TEXEL_COUNT) * 255)),
      confidence: Math.min(255, Math.floor(coherence * 255)),
      materialId: 0,
      flags: packCoverageRecord({ mask, axis, valid: true, flags: SURFACE_FLAG_SIMPLE }),
    });
    records.set(packed, record * SURFACE_RECORD_WORDS);
  }

  return {
    records,
    allocated: next,
    overflowBricks,
    simpleCells,
    complexCells,
    trianglePool: new Float32Array(pool),
    complexTriangles: poolTriangles,
    complexRecords,
    complexOverflowCells,
  };
}

/** Barycentric slack, mirroring the exact validator: shared edges stay sealed
 * against the f32 rounding the triangle pool applies to its vertices. */
const COMPLEX_BARYCENTRIC_EPSILON = 1e-9;
/** Determinant floor below which the ray is treated as parallel. */
const COMPLEX_DETERMINANT_EPSILON = 1e-12;

/**
 * Double-sided Möller-Trumbore in double precision. Returns the ray parameter
 * or null; the caller owns every interval and nearest-hit decision.
 */
function intersectTriangleCpu(origin, direction, a, b, c) {
  const edge1 = v3sub(b, a);
  const edge2 = v3sub(c, a);
  const p = v3cross(direction, edge2);
  const det = v3dot(edge1, p);
  if (!(Math.abs(det) > COMPLEX_DETERMINANT_EPSILON)) return null;
  const inverseDet = 1 / det;
  const fromA = v3sub(origin, a);
  const u = v3dot(fromA, p) * inverseDet;
  if (u < -COMPLEX_BARYCENTRIC_EPSILON || u > 1 + COMPLEX_BARYCENTRIC_EPSILON) return null;
  const q = v3cross(fromA, edge1);
  const v = v3dot(direction, q) * inverseDet;
  if (v < -COMPLEX_BARYCENTRIC_EPSILON || u + v > 1 + COMPLEX_BARYCENTRIC_EPSILON) return null;
  const t = v3dot(edge2, q) * inverseDet;
  return Number.isFinite(t) ? t : null;
}

/**
 * CPU mirror of the Phase-2/3/4 GPU traversal: Phase-1 macro+brick DDA, but an
 * occupied voxel with a SIMPLE record resolves via bounded ray-plane
 * intersection (optionally clipped by the Phase-3 coverage mask) and a
 * REJECTED plane lets the ray continue — the accuracy improvement over the
 * occupied-box hit. With `exactComplex` a COMPLEX record instead intersects
 * its own bounded triangle list, and an exact miss also continues the march.
 * Cells without a usable record keep box semantics.
 */
export function traceHybridPlaneCpu(
  origin,
  direction,
  resolution,
  words,
  layout,
  records,
  {
    tMin = 0,
    tMax = Infinity,
    coverage = false,
    maxMacroSteps = MAX_MACRO_STEPS,
    trianglePool = null,
    exactComplex = false,
    pyramid = null,
    failClosed = true,
    // Shadow-variant mirror: k = 1/cone-angle enables the analytic cone
    // estimator (`pen` in the result, 1 = clear). `voxelWorld` is the world
    // size of one voxel — the CPU grid is voxel-unit, the GPU's t is world.
    penumbraK = null,
    voxelWorld = 1,
  } = {},
) {
  const counters = {
    planeTests: 0, planeAccepts: 0, planeRejects: 0, surfaceFallbacks: 0,
    complexTests: 0, triangleTests: 0, complexAccepts: 0, complexMisses: 0,
  };
  const faceNormal = (axis) => {
    if (axis < 0) {
      const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
      return [-direction[0] / len, -direction[1] / len, -direction[2] / len];
    }
    const normal = [0, 0, 0];
    normal[axis] = direction[axis] >= 0 ? -1 : 1;
    return normal;
  };
  let t = tMin;
  let axis = -1;
  let brickSteps = 0;
  // Same conservative pyramid ride as the Phase-1 tracer above; see its notes.
  let level = pyramid ? pyramid.levelCount - 1 : 2;
  let coarseSteps = 0;
  let coarseSkipsL3 = 0;
  let coarseSkipsL4 = 0;
  let coarseDescends = 0;
  // Same exhaustion clamp as the Phase-1 tracer above; see its notes.
  let lastBrick = false;
  // Cone estimator state + the same birth gate the GPU applies.
  let pen = 1;
  const penGate = tMin + 2 * voxelWorld;
  const coarseOut = () => ({ coarseSteps, coarseSkipsL3, coarseSkipsL4, coarseDescends });
  // Every exit path reports `pen` when the estimator is on — a shadow caller
  // multiplies (1 − hit) · pen, so a miss with a grazed surface must still
  // carry the cone value it accumulated.
  const withPen = (o) => (penumbraK == null ? o : { ...o, pen });
  const exhausted = (limit, macroSteps) => withPen(failClosed && lastBrick
    ? { hit: true, resolved: false, failClosed: true, limit, t, normal: faceNormal(axis), kind: "budget", macroSteps, brickSteps, counters, ...coarseOut() }
    : { hit: false, resolved: false, limit, macroSteps, brickSteps, counters, ...coarseOut() });
  for (let macroSteps = 1; macroSteps <= maxMacroSteps; macroSteps++) {
    if (t >= tMax) return withPen({ hit: false, resolved: true, macroSteps, brickSteps, counters, ...coarseOut() });
    const p = [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
    if (!(p[0] >= 0 && p[1] >= 0 && p[2] >= 0 &&
        p[0] < resolution.x && p[1] < resolution.y && p[2] < resolution.z)) {
      return withPen({ hit: false, resolved: true, macroSteps, brickSteps, counters, ...coarseOut() });
    }
    if (pyramid && level > 2) {
      coarseSteps++;
      const scale = 1 << level;
      const levelData = pyramid.levels[level];
      const coarseCell = p.map((value) => Math.floor(value / scale));
      if (levelData.occupied(coarseCell[0], coarseCell[1], coarseCell[2])) {
        coarseDescends++;
        level--;
        if (level > 2) continue; // still coarse: re-test one level down
        // landed at the macro level: fall through, same iteration
      } else {
        const next = cpuDdaDelta(p, direction, scale);
        if (!Number.isFinite(next.delta)) {
          return withPen({ hit: false, resolved: true, macroSteps, brickSteps, counters, ...coarseOut() });
        }
        axis = next.axis;
        if (level === 3) coarseSkipsL3++;
        else coarseSkipsL4++;
        t += next.delta + RAY_HIT_DDA_EPSILON;
        level = Math.min(level + 1, pyramid.levelCount - 1);
        continue;
      }
    }
    const macro = p.map((value) => Math.floor(value / BRICK_RESOLUTION));
    const macroIndex = macroCellLinearIndex(macro[0], macro[1], macro[2], layout.macroResolution);
    const metadata = unpackMacroCellMetadata(
      words[macroCellWord(layout, macroIndex, MACRO_CELL_METADATA_WORD)],
    );
    const macroNext = cpuDdaDelta(p, direction, BRICK_RESOLUTION);
    const macroExit = t + macroNext.delta;

    if (metadata.type === MacroCellType.Brick || metadata.type === MacroCellType.DynamicBrick) {
      lastBrick = true;
      const useRecords = metadata.type === MacroCellType.Brick;
      const surfaceOffset = words[brickHeaderWord(layout, macroIndex, BRICK_SURFACE_OFFSET_WORD)];
      const low = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_LOW_WORD)];
      const high = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_HIGH_WORD)];
      let localT = t;
      let localResolved = false;
      for (let localStep = 0; localStep < MAX_BRICK_STEPS; localStep++) {
        if (localT >= Math.min(macroExit, tMax) + RAY_HIT_DDA_EPSILON) {
          localResolved = true;
          break;
        }
        brickSteps++;
        const localP = [
          origin[0] + direction[0] * localT,
          origin[1] + direction[1] * localT,
          origin[2] + direction[2] * localT,
        ];
        const voxel = localP.map(Math.floor);
        // The epsilon advance can land a hair past the brick; rank and mask
        // belong to THIS brick, so hand the ray back to the macro loop there.
        if (voxel.some((v, i) => Math.floor(v / BRICK_RESOLUTION) !== macro[i])) {
          localResolved = true;
          break;
        }
        const cellNext = cpuDdaDelta(localP, direction, 1);
        if (!Number.isFinite(cellNext.delta)) return withPen({ hit: false, resolved: true, macroSteps, brickSteps, counters, ...coarseOut() });
        const cellExit = localT + cellNext.delta;
        if (hybridBrickOccupied(words, layout, voxel[0], voxel[1], voxel[2], resolution)) {
          const bit = voxelIndexInBrick(voxel[0] & 3, voxel[1] & 3, voxel[2] & 3);
          let recordResolved = false;
          if (useRecords && surfaceOffset !== INVALID_RAY_HIT_INDEX) {
            const record = (surfaceOffset + brickRank(low, high, bit)) * SURFACE_RECORD_WORDS;
            const flagsWord = records[record + SURFACE_FLAGS_WORD] >>> 0;
            const simple = ((flagsWord >>> COVERAGE_FLAGS_SHIFT) & SURFACE_FLAG_SIMPLE) !== 0;
            const complex = ((flagsWord >>> COVERAGE_FLAGS_SHIFT) & SURFACE_FLAG_COMPLEX) !== 0;
            if (simple) {
              counters.planeTests++;
              const normal = unpackOctNormal(records[record + SURFACE_PACKED_NORMAL_WORD]);
              const plane = unpackPlaneCoverage(records[record + SURFACE_PACKED_PLANE_COVERAGE_WORD]);
              const denominator = v3dot(normal, direction);
              let accepted = false;
              let tPlane = Infinity;
              if (Math.abs(denominator) > PLANE_PARALLEL_EPSILON) {
                tPlane = (plane.planeOffset + v3dot(normal, voxel) - v3dot(normal, origin)) / denominator;
                const segmentEnd = Math.min(cellExit, macroExit, tMax);
                const okInterval = Number.isFinite(tPlane) &&
                  tPlane >= localT - PLANE_HIT_INTERVAL_EPSILON &&
                  tPlane <= segmentEnd + PLANE_HIT_INTERVAL_EPSILON;
                accepted = okInterval && tPlane >= tMin - PLANE_HIT_INTERVAL_EPSILON;
                if (accepted && coverage) {
                  const record3 = unpackCoverageRecord(flagsWord);
                  if (record3.valid) {
                    const local = [
                      origin[0] + direction[0] * tPlane - voxel[0],
                      origin[1] + direction[1] * tPlane - voxel[1],
                      origin[2] + direction[2] * tPlane - voxel[2],
                    ];
                    // Packed masks are RAW; gather rays test them dilated
                    // (leak-conservative), shadow rays raw — GPU parity.
                    const testMask = penumbraK == null
                      ? dilateCoverageMask(record3.mask, 1)
                      : record3.mask;
                    accepted = coverageMaskContainsPoint(testMask, local, record3.axis, 1e-3);
                  }
                }
                // Cone contribution from missed-segment rejects only — see the
                // GPU body's note: in-interval coverage rejects are real
                // silhouette edges whose perpendicular distance of 0 must not
                // black the cone out.
                if (penumbraK != null && !okInterval && Number.isFinite(tPlane) &&
                    localT > penGate && localT < tMax) {
                  const dVox = Math.abs(denominator) *
                    Math.min(Math.abs(localT - tPlane), Math.abs(segmentEnd - tPlane));
                  pen = Math.min(pen, clamp((penumbraK * dVox * voxelWorld) / Math.max(localT, 1e-4), 0, 1));
                }
              } else if (penumbraK != null && localT > penGate && localT < tMax) {
                // Parallel ray: constant perpendicular distance to the fitted
                // plane along the whole segment — the analytic-cone case.
                const localP = [
                  origin[0] + direction[0] * localT,
                  origin[1] + direction[1] * localT,
                  origin[2] + direction[2] * localT,
                ];
                const dVox = Math.abs(plane.planeOffset + v3dot(normal, voxel) - v3dot(normal, localP));
                pen = Math.min(pen, clamp((penumbraK * dVox * voxelWorld) / Math.max(localT, 1e-4), 0, 1));
              }
              if (accepted) {
                counters.planeAccepts++;
                const flipped = denominator > 0
                  ? [-normal[0], -normal[1], -normal[2]]
                  : normal;
                return withPen({
                  hit: true, resolved: true, t: Math.max(tPlane, tMin), normal: flipped,
                  kind: "plane", voxel, macroSteps, brickSteps, counters, ...coarseOut(),
                });
              }
              counters.planeRejects++;
              recordResolved = true; // rejected: fall through and keep marching
            } else if (exactComplex && complex && trianglePool) {
              counters.complexTests++;
              const range = unpackComplexRange(records[record + SURFACE_MATERIAL_ID_WORD]);
              const segmentEnd = Math.min(cellExit, macroExit, tMax);
              let bestT = Infinity;
              let bestNormal = null;
              for (let index = 0; index < range.count; index++) {
                const word = (range.offset + index) * COMPLEX_TRIANGLE_WORDS;
                // Pool vertices are cell-local; the cell origin is the voxel.
                const a = [
                  trianglePool[word] + voxel[0],
                  trianglePool[word + 1] + voxel[1],
                  trianglePool[word + 2] + voxel[2],
                ];
                const b = [
                  trianglePool[word + 3] + voxel[0],
                  trianglePool[word + 4] + voxel[1],
                  trianglePool[word + 5] + voxel[2],
                ];
                const c = [
                  trianglePool[word + 6] + voxel[0],
                  trianglePool[word + 7] + voxel[1],
                  trianglePool[word + 8] + voxel[2],
                ];
                counters.triangleTests++;
                const tTriangle = intersectTriangleCpu(origin, direction, a, b, c);
                if (tTriangle === null || !(tTriangle < bestT)) continue;
                if (tTriangle < localT - PLANE_HIT_INTERVAL_EPSILON ||
                    tTriangle > segmentEnd + PLANE_HIT_INTERVAL_EPSILON ||
                    tTriangle < tMin - PLANE_HIT_INTERVAL_EPSILON) continue;
                const geometric = normalize3(triangleNormal(a, b, c));
                bestT = tTriangle;
                bestNormal = v3dot(geometric, direction) > 0
                  ? [-geometric[0], -geometric[1], -geometric[2]]
                  : geometric;
              }
              if (bestNormal) {
                counters.complexAccepts++;
                return withPen({
                  hit: true, resolved: true, t: Math.max(bestT, tMin), normal: bestNormal,
                  kind: "triangles", voxel, macroSteps, brickSteps, counters, ...coarseOut(),
                });
              }
              counters.complexMisses++;
              recordResolved = true; // exact miss: the box fallback would be wrong
            }
          }
          if (!recordResolved) {
            counters.surfaceFallbacks++;
            return withPen({
              hit: true, resolved: true, t: localT, normal: faceNormal(axis),
              kind: "box", voxel, macroSteps, brickSteps, counters, ...coarseOut(),
            });
          }
        }
        axis = cellNext.axis;
        localT = cellExit + RAY_HIT_DDA_EPSILON;
      }
      if (!localResolved) return exhausted("brick", macroSteps);
      axis = macroNext.axis;
    } else {
      lastBrick = false;
      axis = macroNext.axis;
    }

    if (!Number.isFinite(macroNext.delta)) return withPen({ hit: false, resolved: true, macroSteps, brickSteps, counters, ...coarseOut() });
    t = macroExit + RAY_HIT_DDA_EPSILON;
    if (pyramid) level = 3; // re-ascend after a macro cell, as the GPU does
  }
  return exhausted("macro", maxMacroSteps);
}

/** CPU mirror of the bounded simple-plane hit and Phase-3 coverage test. */
export function intersectPlaneCoverageCpu(
  origin,
  direction,
  normal,
  planeOffset,
  mask,
  axis,
  { tMin = 0, tMax = Infinity, requireCellBounds = true } = {},
) {
  const denominator = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < PLANE_PARALLEL_EPSILON) {
    return { hit: false, reason: "parallel" };
  }
  const numerator = planeOffset - (normal[0] * origin[0] + normal[1] * origin[1] + normal[2] * origin[2]);
  const t = numerator / denominator;
  if (!Number.isFinite(t) || t < tMin || t > tMax) return { hit: false, reason: "interval" };
  const point = cpuPointAt(origin, direction, t);
  if (requireCellBounds && point.some((value) => value < -CELL_BOUNDS_EPSILON || value > 1 + CELL_BOUNDS_EPSILON)) {
    return { hit: false, reason: "cell-bounds", t, point };
  }
  if (!coverageMaskContainsPoint(mask, point, axis)) return { hit: false, reason: "coverage", t, point };
  return { hit: true, t, point };
}

// ---------------------------------------------------------------------------
// Record-aware shadow distance: the near-field half of the occupancy oracle.
//
// WHY THIS EXISTS. GI soft shadows sphere-trace a penumbra estimator
// min(k·d/t) whose short-range `d` comes from occupancyField.js's near field:
// for every occupied voxel in the 3x3x3 neighbourhood of the sample, the gap
// from the sample to that voxel's AABB. That gap is a valid lower bound (the
// triangle that set the bit lives inside the box, so it can only be farther),
// but its isosurface is a UNION OF BOXES — which is why the shadow silhouettes
// read as squarish stair-steps rather than as the geometry's own outline.
//
// Phases 2-4 already fit a plane to each occupied voxel's triangles and store
// it as a rank-addressed SurfaceRecord. Where such a record exists and is
// SIMPLE, its plane is a far better isosurface than the box, so this function
// replaces the box gap with the plane distance — but only ever UPWARD:
//
//   contribution = max(gapWorld, planeWorld)
//
// The max is doing two jobs at once, and both matter:
//  1. SAFETY. The fitted plane is only authoritative about the geometry INSIDE
//     its own cell. Extended outside the cell it says nothing, and it can pass
//     arbitrarily close to a distant sample. Taking the max with the box gap
//     re-imposes the cell's own extent, and the max of two lower bounds on the
//     same true distance is itself a lower bound — so sphere tracing stays
//     conservative by construction, not by tuning.
//  2. CONTINUITY. When the sample crosses a cell border the 3x3x3 window
//     shifts, so one voxel row leaves and another enters. At the crossing both
//     rows sit exactly one voxel away, so their gap term alone already equals
//     the block-boundary `inset` the result is clamped by — the max keeps that
//     true for record-carrying voxels too, and the value never jumps.
//
// The slack subtracted from the plane distance is the fit's own residual
// budget: SIMPLE_MAX_PLANE_SIGMA is the classification ceiling on the weighted
// spread of the per-triangle plane offsets, and the extra margin covers the
// snorm16 offset/oct-normal quantization plus the voxelizer's conservative
// half-extent. Subtract it and clamp at zero, and a cell whose triangles sit a
// little off the fitted plane still cannot report a distance the geometry does
// not have.
// ---------------------------------------------------------------------------

/** Quantization + conservative-voxelization margin added to the sigma ceiling. */
export const RECORD_AWARE_PACKING_SLACK = 0.02;
/** The shared CPU/GPU default: fit-residual ceiling plus the packing margin. */
export const RECORD_AWARE_PLANE_SLACK = SIMPLE_MAX_PLANE_SIGMA + RECORD_AWARE_PACKING_SLACK;

/**
 * Fetch one voxel's SIMPLE surface record, or null when the voxel has none.
 *
 * "None" covers every fallback the tracer already recognises, and they must all
 * behave identically here: a DYNAMIC macro cell (its records belong to a
 * previous frame's geometry), a brick whose allocation overflowed the record
 * pool (surfaceOffset stays INVALID), and a cell classified COMPLEX or left
 * unclassified (no SIMPLE flag). All of those keep pure box semantics.
 */
function simplePlaneRecordAt(words, layout, records, x, y, z) {
  if (!records) return null;
  const macroIndex = macroCellLinearIndex(
    Math.floor(x / BRICK_RESOLUTION),
    Math.floor(y / BRICK_RESOLUTION),
    Math.floor(z / BRICK_RESOLUTION),
    layout.macroResolution,
  );
  const metadata = unpackMacroCellMetadata(
    words[macroCellWord(layout, macroIndex, MACRO_CELL_METADATA_WORD)],
  );
  // STATIC bricks only — the same `useRecords` gate traceHybridPlaneCpu applies.
  if (metadata.type !== MacroCellType.Brick) return null;
  const surfaceOffset = words[brickHeaderWord(layout, macroIndex, BRICK_SURFACE_OFFSET_WORD)];
  if (surfaceOffset === INVALID_RAY_HIT_INDEX) return null;
  const low = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_LOW_WORD)];
  const high = words[brickHeaderWord(layout, macroIndex, BRICK_OCCUPANCY_HIGH_WORD)];
  const bit = voxelIndexInBrick(x & 3, y & 3, z & 3);
  const record = (surfaceOffset + brickRank(low, high, bit)) * SURFACE_RECORD_WORDS;
  // A short/absent pool reads `undefined`, which coerces to 0 — no SIMPLE flag,
  // so an out-of-range record degrades to the box instead of throwing.
  const flagsWord = records[record + SURFACE_FLAGS_WORD] >>> 0;
  if (((flagsWord >>> COVERAGE_FLAGS_SHIFT) & SURFACE_FLAG_SIMPLE) === 0) return null;
  return {
    normal: unpackOctNormal(records[record + SURFACE_PACKED_NORMAL_WORD]),
    planeOffset: unpackPlaneCoverage(records[record + SURFACE_PACKED_PLANE_COVERAGE_WORD]).planeOffset,
  };
}

/**
 * CPU mirror of the record-aware near field. `q0` is in LEVEL-0 VOXEL SPACE
 * (the space the whole hybrid tail works in); `voxelWorld` is the per-axis
 * world size of one voxel, so the returned distance is in world units.
 *
 * With `recordAware: false` this is the pure AABB near field, arithmetic for
 * arithmetic — that is the A/B, and nothing below may change the box branch's
 * expression shape or the value stops being bit-comparable.
 *
 * `stats`, when supplied, receives counters. It is written after the value is
 * computed and never participates in it.
 */
export function recordAwareNearFieldCpu(q0, resolution, words, layout, records, {
  voxelWorld = [1, 1, 1],
  slack = RECORD_AWARE_PLANE_SLACK,
  recordAware = true,
  stats = null,
} = {}) {
  const cellX = Math.floor(q0[0]);
  const cellY = Math.floor(q0[1]);
  const cellZ = Math.floor(q0[2]);
  // MIN component, not the axis-matched one: distance to a plane shrinks by at
  // most the smallest axis scale under an anisotropic voxel (scaling a plane
  // distance by diag(s) divides it by |S^-1 n| <= 1/min(s)), so the min keeps
  // the bound valid whatever the normal's orientation.
  const minVoxelWorld = Math.min(voxelWorld[0], voxelWorld[1], voxelWorld[2]);
  let nearest = Infinity;
  let occupiedNeighbours = 0;
  let recordNeighbours = 0;
  let sharpenedNeighbours = 0;

  // Same 27-neighbour indexing as the shader's `nf` loop, so a divergence
  // between the two is a formula divergence and never an iteration-order one.
  for (let n = 0; n < 27; n++) {
    const vx = cellX + (n % 3) - 1;
    const vy = cellY + (Math.floor(n / 3) % 3) - 1;
    const vz = cellZ + Math.floor(n / 9) - 1;
    // Out of bounds reads empty — hybridBrickOccupied's own bounds test.
    if (!hybridBrickOccupied(words, layout, vx, vy, vz, resolution)) continue;
    occupiedNeighbours++;

    // Componentwise gap to the voxel box [v, v+1], zero on any axis where q0
    // already sits inside the slab. This IS the existing near-field bound.
    const gapX = Math.max(vx - q0[0], q0[0] - (vx + 1), 0) * voxelWorld[0];
    const gapY = Math.max(vy - q0[1], q0[1] - (vy + 1), 0) * voxelWorld[1];
    const gapZ = Math.max(vz - q0[2], q0[2] - (vz + 1), 0) * voxelWorld[2];
    let contribution = Math.hypot(gapX, gapY, gapZ);

    if (recordAware) {
      const record = simplePlaneRecordAt(words, layout, records, vx, vy, vz);
      if (record !== null) {
        recordNeighbours++;
        // The record's plane is cell-local: dot(n, x - v) = planeOffset.
        const planeVox = Math.abs(
          record.normal[0] * (q0[0] - vx) +
          record.normal[1] * (q0[1] - vy) +
          record.normal[2] * (q0[2] - vz) -
          record.planeOffset,
        );
        const planeWorld = Math.max(planeVox - slack, 0) * minVoxelWorld;
        if (planeWorld > contribution) {
          contribution = planeWorld;
          sharpenedNeighbours++;
        }
      }
    }

    if (contribution < nearest) nearest = contribution;
  }

  // Geometry outside the 3x3x3 block is at least as far as the block's own
  // boundary, per axis. `local` is in [0, 1), so every term is >= one voxel —
  // which is exactly what makes the window shift above invisible in the result.
  const localX = q0[0] - cellX;
  const localY = q0[1] - cellY;
  const localZ = q0[2] - cellZ;
  const insetX = Math.min(localX + 1, 2 - localX) * voxelWorld[0];
  const insetY = Math.min(localY + 1, 2 - localY) * voxelWorld[1];
  const insetZ = Math.min(localZ + 1, 2 - localZ) * voxelWorld[2];
  const inset = Math.min(insetX, Math.min(insetY, insetZ));

  if (stats) {
    stats.occupiedNeighbours = occupiedNeighbours;
    stats.recordNeighbours = recordNeighbours;
    stats.sharpenedNeighbours = sharpenedNeighbours;
    stats.nearest = nearest;
    stats.inset = inset;
  }
  return Math.min(nearest, inset);
}

/**
 * Exact closest point on one triangle, region-classified (Ericson). Pure
 * double precision and branch-complete: every Voronoi region of the triangle
 * (three vertices, three edges, the face) has its own closed form, so there is
 * no iteration and no tolerance to tune. Degenerate (zero-area) triangles fall
 * through to the edge cases, whose denominators stay finite.
 */
function closestPointOnTriangleCpu(p, a, b, c) {
  const ab = v3sub(b, a);
  const ac = v3sub(c, a);
  const ap = v3sub(p, a);
  const d1 = v3dot(ab, ap);
  const d2 = v3dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = v3sub(p, b);
  const d3 = v3dot(ab, bp);
  const d4 = v3dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const denominator = d1 - d3;
    const v = denominator !== 0 ? d1 / denominator : 0;
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }

  const cp = v3sub(p, c);
  const d5 = v3dot(ab, cp);
  const d6 = v3dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const denominator = d2 - d6;
    const w = denominator !== 0 ? d2 / denominator : 0;
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const denominator = (d4 - d3) + (d5 - d6);
    const w = denominator !== 0 ? (d4 - d3) / denominator : 0;
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }

  const sum = va + vb + vc;
  // A zero sum means a degenerate triangle that reached the face branch; the
  // vertex is the only defensible answer and keeps the result finite.
  if (!(sum > 0)) return a;
  const v = vb / sum;
  const w = vc / sum;
  return [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ];
}

/**
 * Exact unsigned distance from `p` to the nearest of `triangles`
 * ([[ax,ay,az],[bx,by,bz],[cx,cy,cz]], any consistent space). This is the
 * ground truth the record-aware bound is validated against — never an
 * approximation of it, which is why it is brute force over the whole set.
 */
export function pointToTrianglesDistanceCpu(p, triangles) {
  let best = Infinity;
  for (let index = 0; index < triangles.length; index++) {
    const triangle = triangles[index];
    const q = closestPointOnTriangleCpu(p, triangle[0], triangle[1], triangle[2]);
    const distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (distance < best) best = distance;
  }
  return best;
}
