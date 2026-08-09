// CPU REFERENCE FOR THE SHADOW-PATH DISTANCE — the arbiter for plan §12.5.
//
// §12.5 blocked the deletion sweep on a claim about quality: that the composited
// `distanceTexture` is a CONTINUOUS distance the penumbra estimator needs, and
// that `freeRadiusAtWorld` is a staircase of voxel boxes which cannot replace
// it. The claim is testable without a GPU, because in the shipping build the
// composite's own source IS that oracle (`giField.js:216`) — so the two arms are
// the same function, one of them low-passed onto a 0.33m lattice and quantized
// to fp16. This file implements both, plus the ground truth they are both
// approximating, so the comparison is a number instead of an argument.
//
// Pure JS on purpose: no `three`, no TSL, no adapter — `scripts/run-gi-src-volume-test.mjs`
// runs it in plain node in a couple of seconds, the Phase-0 pattern (§7).
//
// WHAT "TRUTH" MEANS HERE, because picking it wrong would make the suite
// meaningless (R14 / §12.4). It is NOT the distance to the original triangles —
// no consumer on this path has ever seen those, and a bound measured against
// them would convict the medium rather than the two things under test. It is the
// exact distance from the query point to the nearest OCCUPIED LEVEL-0 VOXEL AABB
// over the whole grid: precisely what a perfect implementation of this oracle
// would return, brute-forced. Both arms are approximations of it, both are
// supposed to stay below it (a bound above it admits geometry that is not
// there), and the interesting question is which one is closer and where.
//
// ── THE ONE STRUCTURAL DIFFERENCE THE ARMS HAVE, stated up front so the numbers
// are readable: the oracle is conservative BY CONSTRUCTION (every branch returns
// a lower bound on the true free radius). The composite cannot be, and not
// because of a bug — trilinear interpolation of a 1-Lipschitz function
// overshoots between its samples, so a texel-interpolated distance reports free
// space that is not there, by up to about half a coarse cell. That is a leak
// mechanism the oracle-direct arm structurally does not have, and it is measured
// below rather than asserted.

/**
 * MUST EQUAL `occupancyField.js`'s `OCC_LEVELS`. It cannot be imported — that
 * module pulls in `three` and this suite must stay GPU-free — so the test reads
 * the constant out of that file's source and fails loudly on drift rather than
 * silently mirroring a stale pyramid depth.
 */
export const REF_OCC_LEVELS = 5;

// ─────────────────────────────────────────────────────────────── the pyramid

/**
 * Level plan, mirroring `planLevels`: level L resolution is `res0 >> L`, floored
 * at 1, and level-0 resolution is assumed already quantized to `1 << (LEVELS-1)`
 * so every level halves exactly.
 */
export function refPlanLevels(res0, levels = REF_OCC_LEVELS) {
  const plan = [];
  for (let L = 0; L < levels; L++) {
    plan.push({
      level: L,
      scale: 1 << L,
      res: {
        x: Math.max(1, res0.x >> L),
        y: Math.max(1, res0.y >> L),
        z: Math.max(1, res0.z >> L),
      },
    });
  }
  return plan;
}

/**
 * Builds the OR-downsampled bit pyramid. `isOccupied(x, y, z)` is consulted for
 * level 0 only; every coarser level is the OR of its eight children, which is
 * the property the DDA's empty-space skip depends on (a clear parent must mean
 * eight clear children, or a ray can skip over geometry).
 */
export function buildRefPyramid(res0, isOccupied, levels = REF_OCC_LEVELS) {
  const plan = refPlanLevels(res0, levels);
  const data = plan.map((l) => new Uint8Array(l.res.x * l.res.y * l.res.z));
  const idx = (l, x, y, z) => (z * l.res.y + y) * l.res.x + x;
  for (let z = 0; z < plan[0].res.z; z++) {
    for (let y = 0; y < plan[0].res.y; y++) {
      for (let x = 0; x < plan[0].res.x; x++) {
        if (isOccupied(x, y, z)) data[0][idx(plan[0], x, y, z)] = 1;
      }
    }
  }
  for (let L = 1; L < levels; L++) {
    const l = plan[L];
    const c = plan[L - 1];
    for (let z = 0; z < l.res.z; z++) {
      for (let y = 0; y < l.res.y; y++) {
        for (let x = 0; x < l.res.x; x++) {
          let any = 0;
          for (let dz = 0; dz < 2 && !any; dz++) {
            for (let dy = 0; dy < 2 && !any; dy++) {
              for (let dx = 0; dx < 2 && !any; dx++) {
                const cx = x * 2 + dx;
                const cy = y * 2 + dy;
                const cz = z * 2 + dz;
                if (cx < c.res.x && cy < c.res.y && cz < c.res.z && data[L - 1][idx(c, cx, cy, cz)]) any = 1;
              }
            }
          }
          data[L][idx(l, x, y, z)] = any;
        }
      }
    }
  }
  // OUT OF RANGE IS EMPTY, matching `occupiedAtLevel0`'s `select(inside, raw, 0)`
  // and `readbackBits`' `get`. Getting this backwards would make the oracle
  // report a sealed world and hide every boundary case the arms differ on.
  const occupiedAt = (x, y, z, L = 0) => {
    const l = plan[L];
    if (x < 0 || y < 0 || z < 0 || x >= l.res.x || y >= l.res.y || z >= l.res.z) return 0;
    return data[L][idx(l, x, y, z)];
  };
  const occupiedVoxels = [];
  for (let z = 0; z < plan[0].res.z; z++) {
    for (let y = 0; y < plan[0].res.y; y++) {
      for (let x = 0; x < plan[0].res.x; x++) {
        if (data[0][idx(plan[0], x, y, z)]) occupiedVoxels.push(x, y, z);
      }
    }
  }
  return { plan, data, occupiedAt, occupiedVoxels, levels };
}

// ──────────────────────────────────────────────────── arm A: the oracle direct

/**
 * `freeRadiusAtWorld`, line for line, minus the record chain.
 *
 * The records are omitted deliberately rather than for convenience, and it
 * matters for reading the results: the composite feeds itself from the
 * record-BLIND oracle (four arguments at `giField.js:216`), so a record-aware
 * mirror would be comparing a sharper oracle against a blurred blunter one and
 * would flatter the arm under test. This is the like-for-like control. The
 * shipping `srcVolume.js` arm turns records ON, which can only sharpen further
 * (the max of two valid lower bounds is a valid lower bound), so every accuracy
 * result here is a FLOOR on what that arm delivers.
 *
 * @param {object} pyr        from `buildRefPyramid`
 * @param {number[]} p        world position
 * @param {object} grid       `{ origin: [x,y,z], voxel: [x,y,z] }`
 * @param {object} [opts]     `maxLevel`, `nearField`, `cap`
 */
export function refFreeRadius(pyr, p, grid, { maxLevel = REF_OCC_LEVELS - 1, nearField = true, cap = null } = {}) {
  const [ox, oy, oz] = grid.origin;
  const [vx, vy, vz] = grid.voxel;
  const q0 = [(p[0] - ox) / vx, (p[1] - oy) / vy, (p[2] - oz) / vz];
  const top = Math.max(0, Math.min(pyr.levels - 1, maxLevel));
  let best = 0;

  if (nearField) {
    // A real distance, not a block flag: for each occupied voxel in the 3×3×3
    // neighbourhood, the gap from `p` to that voxel's AABB is a conservative
    // bound on the distance to whatever triangle set the bit. Geometry outside
    // the neighbourhood is at least as far as the block's own boundary.
    const cell = [Math.floor(q0[0]), Math.floor(q0[1]), Math.floor(q0[2])];
    let nearest = 1e9;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = [cell[0] + dx, cell[1] + dy, cell[2] + dz];
          if (!pyr.occupiedAt(v[0], v[1], v[2], 0)) continue;
          const gx = Math.max(v[0] - q0[0], q0[0] - (v[0] + 1), 0) * vx;
          const gy = Math.max(v[1] - q0[1], q0[1] - (v[1] + 1), 0) * vy;
          const gz = Math.max(v[2] - q0[2], q0[2] - (v[2] + 1), 0) * vz;
          nearest = Math.min(nearest, Math.hypot(gx, gy, gz));
        }
      }
    }
    const local = [q0[0] - cell[0], q0[1] - cell[1], q0[2] - cell[2]];
    const inset = Math.min(
      Math.min(local[0] + 1, 2 - local[0]) * vx,
      Math.min(local[1] + 1, 2 - local[1]) * vy,
      Math.min(local[2] + 1, 2 - local[2]) * vz,
    );
    best = Math.min(nearest, inset);
  }

  // THE LEVEL LADDER. Starts at 1 when the near field ran (it already proved
  // everything level 0 can), and `max` because each empty block is an
  // independent lower bound — which is also why the ladder's only failure mode
  // is a JUMP: when a block flips from occupied to empty the bound it
  // contributes appears at once, at a value in [0.5, 1]·voxel·2^L.
  let topEmpty = false;
  const startLevel = nearField ? 1 : 0;
  for (let L = startLevel; L <= top; L++) {
    const scale = 1 << L;
    const q = [q0[0] / scale, q0[1] / scale, q0[2] / scale];
    const base = [Math.floor(q[0] - 0.5), Math.floor(q[1] - 0.5), Math.floor(q[2] - 0.5)];
    let occupied = 0;
    for (let c = 0; c < 8; c++) {
      occupied += pyr.occupiedAt(base[0] + (c & 1), base[1] + ((c >> 1) & 1), base[2] + ((c >> 2) & 1), L);
    }
    const local = [q[0] - base[0], q[1] - base[1], q[2] - base[2]];
    const bound = Math.min(
      Math.min(local[0], 2 - local[0]) * vx * scale,
      Math.min(local[1], 2 - local[1]) * vy * scale,
      Math.min(local[2], 2 - local[2]) * vz * scale,
    );
    if (occupied < 0.5) best = Math.max(best, bound);
    if (L === top) topEmpty = occupied < 0.5;
  }

  // Saturate like a distance field does. Consumers test `d < 0.85·capWorld` to
  // mean "open space, not an occluder"; a bound that tops out below that cut
  // inverts the test and drives every far sample dark (occupancyField.js's
  // saturation note records what that looked like).
  if (cap != null && topEmpty) return cap;
  return best;
}

// ─────────────────────────────────── arm B: the composited distance texture

/** f32 → f16 → f32, so the composite arm carries the storage step it really has. */
export function roundHalf(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const e = Math.floor(Math.log2(a));
  // Subnormals below 2^-14; the quantum is fixed at 2^-24 there.
  const q = e < -14 ? 2 ** -24 : 2 ** (e - 10);
  return sign * Math.round(a / q) * q;
}

/**
 * The composite pass + the hardware trilinear read, as the shipping build wires
 * them: one oracle evaluation per COARSE CELL CENTRE, stored as
 * `f16(clamp(d / capWorld, 0, 1))`, read back with clamp-to-edge trilinear and
 * rescaled by `capWorld`.
 *
 * `res` is the coarse cell count per axis — the radiance field's lattice, ~2-3
 * occupancy voxels per axis at every shipped preset, which is the whole reason
 * this arm loses sub-voxel detail.
 */
export function buildRefComposite(pyr, grid, { bounds, res, capWorld }) {
  const cell = [
    (bounds.max[0] - bounds.min[0]) / res.x,
    (bounds.max[1] - bounds.min[1]) / res.y,
    (bounds.max[2] - bounds.min[2]) / res.z,
  ];
  const texels = new Float32Array(res.x * res.y * res.z);
  for (let k = 0; k < res.z; k++) {
    for (let j = 0; j < res.y; j++) {
      for (let i = 0; i < res.x; i++) {
        const p = [
          bounds.min[0] + (i + 0.5) * cell[0],
          bounds.min[1] + (j + 0.5) * cell[1],
          bounds.min[2] + (k + 0.5) * cell[2],
        ];
        // Every level, near field on, record-blind, saturating at capWorld —
        // the composite's exact call.
        const d = refFreeRadius(pyr, p, grid, { cap: capWorld });
        texels[(k * res.y + j) * res.x + i] = roundHalf(Math.min(1, Math.max(0, d / capWorld)));
      }
    }
  }
  const at = (i, j, k) => {
    const ci = Math.min(res.x - 1, Math.max(0, i));
    const cj = Math.min(res.y - 1, Math.max(0, j));
    const ck = Math.min(res.z - 1, Math.max(0, k));
    return texels[(ck * res.y + cj) * res.x + ci];
  };
  /**
   * `texture3D(distanceTexture, uvw).level(0).r * capWorld`, clamp-to-edge.
   *
   * `anySaturated` reports whether any of the eight corners was a SATURATED
   * texel, and it is not bookkeeping — it separates two different overshoot
   * mechanisms that a single number conflates. Interpolating between two real
   * distances overshoots by the Lipschitz bound, under half a coarse cell.
   * Interpolating a real distance against a saturated neighbour blends in
   * `capWorld` itself, so a cell one voxel from a wall can report metres of free
   * space — and with `capWorld = 16·minCell` (2.67× the oracle's own ceiling on
   * a shipped preset) that is the DOMINANT term, not the corner case.
   */
  const sample = (p, wantFlags = false) => {
    const u = ((p[0] - bounds.min[0]) / (bounds.max[0] - bounds.min[0])) * res.x - 0.5;
    const v = ((p[1] - bounds.min[1]) / (bounds.max[1] - bounds.min[1])) * res.y - 0.5;
    const w = ((p[2] - bounds.min[2]) / (bounds.max[2] - bounds.min[2])) * res.z - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const k0 = Math.floor(w);
    const fu = u - i0;
    const fv = v - j0;
    const fw = w - k0;
    let acc = 0;
    let anySaturated = false;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1;
      const dy = (c >> 1) & 1;
      const dz = (c >> 2) & 1;
      const weight = (dx ? fu : 1 - fu) * (dy ? fv : 1 - fv) * (dz ? fw : 1 - fw);
      if (weight === 0) continue;
      const texel = at(i0 + dx, j0 + dy, k0 + dz);
      if (texel >= 1 - 1e-6) anySaturated = true;
      acc += weight * texel;
    }
    const value = acc * capWorld;
    return wantFlags ? { value, anySaturated } : value;
  };
  return { sample, texels, cell, res, capWorld };
}

// ──────────────────────────────────────────────────────────────── the truth

/**
 * Exact distance from `p` to the nearest occupied level-0 voxel AABB, saturated
 * at `cap`. Brute force over the occupied set — O(occupied) per query, which is
 * fine at suite scale and is the point: it has no approximation to argue with.
 */
export function refTrueDistance(pyr, p, grid, cap = null) {
  const [ox, oy, oz] = grid.origin;
  const [vx, vy, vz] = grid.voxel;
  const qx = (p[0] - ox) / vx;
  const qy = (p[1] - oy) / vy;
  const qz = (p[2] - oz) / vz;
  const list = pyr.occupiedVoxels;
  let best = Infinity;
  for (let n = 0; n < list.length; n += 3) {
    const gx = Math.max(list[n] - qx, qx - (list[n] + 1), 0) * vx;
    const gy = Math.max(list[n + 1] - qy, qy - (list[n + 1] + 1), 0) * vy;
    const gz = Math.max(list[n + 2] - qz, qz - (list[n + 2] + 1), 0) * vz;
    const d2 = gx * gx + gy * gy + gz * gz;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return cap != null ? Math.min(d, cap) : d;
}

// ────────────────────────────────────────────── the consumer under test

/**
 * `createWidthProbeFn`'s estimator, over an arbitrary distance source.
 *
 * This is the quantity that actually reaches a pixel, and therefore the one the
 * §12.5 decision should turn on — not the distance itself. A distance arm can be
 * measurably different and still produce an identical width (every gate below
 * can swallow the difference), and it can be nearly identical and produce a
 * different width (the `min` picks one tap out of twelve). So the suite reports
 * both, and weights this one.
 *
 * `distanceAt(p) → free radius`, already saturated at `capWorld`.
 */
export function refWidthProbe(distanceAt, {
  origin, dir, tStart, maxT, k, cosRayNormal, lift,
  capWorld, minCell, planeCut, taps = 12, planeFactor = 0.6,
  bounds = null,
}) {
  const capCut = capWorld * 0.85;
  const t0 = Math.max(tStart, minCell * 0.5);
  const ratio = Math.max(maxT / t0, 1.0001) ** (1 / (taps - 1));
  let width = 1;
  let argmin = -1;
  let t = t0;
  for (let i = 0; i < taps; i++) {
    const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    const inBounds = bounds
      ? p.every((c, a) => c >= bounds.min[a] && c <= bounds.max[a])
      : true;
    const d = distanceAt(p);
    const planeHeight = lift + t * cosRayNormal;
    const counts = inBounds &&
      d < capCut &&
      d < planeHeight - planeCut &&
      d < planeHeight * planeFactor &&
      t < maxT;
    const cand = counts ? Math.min(1, Math.max(0, (k * d) / Math.max(t, 1e-4))) : 1;
    if (cand < width) {
      width = cand;
      argmin = i;
    }
    t *= ratio;
  }
  return { width, argmin };
}

// ───────────────────────────────────────────────────────────── test scenes

/**
 * A synthetic room built to exercise exactly the cases the two arms are supposed
 * to disagree on, rather than a generic blob:
 *
 *   · a FLOOR slab — the hugging-ray case, the one the composite's ~3-voxel
 *     undershoot forced `planeCut` up to 3.5 voxels for;
 *   · a THIN wall, one voxel thick and thinner than a coarse cell — the feature
 *     the low-pass cannot represent at all, and the reason the trace needed a
 *     refinement gate on top of the texture;
 *   · a THICK wall, several coarse cells — where both arms should agree, so a
 *     difference there is a bug in one of them;
 *   · a PILLAR and a SPHERE in open floor, giving mid-field distances at every
 *     scale between contact and the cap, which is the band the ladder's jumps
 *     live in.
 *
 * Coordinates are metres; the defaults mirror the real ratio (0.125m voxels
 * under 0.333m coarse cells).
 */
export function refRoomScene({ res0 = { x: 64, y: 64, z: 64 }, voxel = 0.125 } = {}) {
  const origin = [0, 0, 0];
  const grid = { origin, voxel: [voxel, voxel, voxel] };
  const bounds = {
    min: [0, 0, 0],
    max: [res0.x * voxel, res0.y * voxel, res0.z * voxel],
  };
  const isOccupied = (x, y, z) => {
    // Floor: two voxels thick (a real slab, not a membrane).
    if (y < 2) return true;
    // Thick back wall.
    if (z >= res0.z - 6) return true;
    // Thin wall, ONE voxel thick, standing free at z = 24.
    if (z === 24 && x >= 8 && x < 40 && y < 32) return true;
    // Pillar.
    if (x >= 44 && x < 48 && z >= 12 && z < 16 && y < 40) return true;
    // Sphere, radius 5 voxels, centred in open floor.
    const dx = x - 20;
    const dy = y - 14;
    const dz = z - 12;
    if (dx * dx + dy * dy + dz * dz <= 25) return true;
    return false;
  };
  return { grid, bounds, res0, voxel, isOccupied };
}
