// SPLIT RADIANCE CASCADES — the math kernel, in plain JS.
//
// EVERY function here has a TSL twin in `srcMathTsl.js`. They are two
// expressions of ONE definition and MUST change together — the same contract
// `emitterShapes.js` and its `giLight.js` twins live under, for the same
// earned reason: when the CPU mirror and the GPU kernel disagree, the mirror
// test goes green while the screen is wrong, and the disagreement is invisible
// until someone measures a third thing.
//
// Plain JS deliberately (no `three`, no `three/tsl`): the Phase-0 reference
// suite must run in bare Node with no GPU, no adapter and no headless WebGPU
// shim, because that is the only kind of test that stays trustworthy when the
// GPU path is the thing under suspicion.
//
// docs/GI_SRC_REBUILD_PLAN.md §2 items 2, 3, 5, 7, 8; §4.2.

import {
  COLD_FILL_FRAMES,
  INFLUX_ONE,
  KEY_MAX_LODS,
  SUM_SCALE,
  SURPRISE_FLOOR,
  SURPRISE_MIN_EVIDENCE,
  SURPRISE_ONE,
  SURPRISE_RATE,
  SURPRISE_SHOT_K,
  SURPRISE_T0,
  SURPRISE_T1,
} from "./srcConfig.js";

// ═══════════════════════════════════════════════ EQUAL-AREA CYLINDRICAL BINS
//
// Paper Alg. 2: φ = 2πx, z = 2y − 1. This is the Archimedes / Lambert
// cylindrical equal-area projection, and "equal-area" is the entire point:
// every bin subtends the SAME solid angle, so a bin average is already a
// solid-angle-weighted average and needs no Jacobian correction.
//
// THAT IS THE OPPOSITE OF THE OCTAHEDRAL MAP we use elsewhere, whose texels
// vary 2.73× in solid angle and therefore need `octahedralTexelWeight` on
// every gather (see srcOctahedral below — it survives for the irradiance
// tiles). The paper measured octahedral AND Clarberg bins as WORSE than this
// despite better angular uniformity, which is counterintuitive enough to be
// worth restating: the win here is not uniformity, it is that the 4→1 parent
// mapping is exact integer halving with no resampling.

/** Bin (i, j) on the 2w×w grid → its centre's (x, y) in [0,1)². */
export function binCenterXY(i, j, w) {
  return { x: (i + 0.5) / (2 * w), y: (j + 0.5) / w };
}

/**
 * (x, y) ∈ [0,1)² → unit direction. Equal-area by construction.
 *
 * `r = sqrt((1−z)(1+z))` rather than the textbook `sqrt(1 − z²)`: near the
 * poles `z·z` rounds to within an ulp of 1 and the subtraction cancels nearly
 * every significant bit. The factored form has no cancellation (`1 − z` is
 * exact for z ∈ [0.5, 2] and `1 + z` for the mirror), which matters little in
 * f64 and a great deal in the f32 twin, where the twin gate measured the naive
 * form at 1.3e-5 of absolute error against this one. Both files carry the same
 * expression because they are one definition.
 */
export function decodeDir(x, y) {
  const phi = 2 * Math.PI * x;
  const z = 2 * y - 1;
  const r = Math.sqrt(Math.max(0, (1 - z) * (1 + z)));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** Unit direction → (x, y) ∈ [0,1)². Exact inverse of decodeDir. */
export function encodeDir(dx, dy, dz) {
  let phi = Math.atan2(dy, dx);
  if (phi < 0) phi += 2 * Math.PI;
  let x = phi / (2 * Math.PI);
  // atan2 can return exactly 2π-ε that rounds to 1.0 — a bin index of 2w is
  // out of range, and clamping it silently folds the last azimuth sliver into
  // its neighbour. Wrap instead.
  if (x >= 1) x -= 1;
  return { x, y: Math.min(0.9999999999, Math.max(0, (dz + 1) * 0.5)) };
}

/** Bin (i, j) for a direction on the 2w×w grid at width `w`. */
export function dirToBin(dx, dy, dz, w) {
  const { x, y } = encodeDir(dx, dy, dz);
  const i = Math.min(2 * w - 1, Math.max(0, Math.floor(x * 2 * w)));
  const j = Math.min(w - 1, Math.max(0, Math.floor(y * w)));
  return { i, j };
}

/** Bin centre direction for (i, j) at width `w`. */
export function binDir(i, j, w) {
  const { x, y } = binCenterXY(i, j, w);
  return decodeDir(x, y);
}

/**
 * 4→1 parent mapping: integer halving. Child (i, j) at width w belongs to
 * parent (i>>1, j>>1) at width w/2 — and because the parent grid is
 * 2(w/2)×(w/2) = w×(w/2), the halved indices land in range with no clamp.
 *
 * The four children of one parent are (2i, 2j), (2i+1, 2j), (2i, 2j+1),
 * (2i+1, 2j+1), which `binMorton` below makes CONTIGUOUS — that adjacency is
 * why the merge can fetch a parent's children as one aligned read.
 */
export function binParent(i, j) {
  return { i: i >> 1, j: j >> 1 };
}

/** The four child bins of parent (i, j). Order matches binMorton's low 2 bits. */
export function binChildren(i, j) {
  return [
    { i: i * 2, j: j * 2 },
    { i: i * 2 + 1, j: j * 2 },
    { i: i * 2, j: j * 2 + 1 },
    { i: i * 2 + 1, j: j * 2 + 1 },
  ];
}

/**
 * Morton (Z-order) index of bin (i, j) — the STORAGE order of the directional
 * payload (paper §6 merge optimization).
 *
 * The property that earns it: morton(2i+dx, 2j+dy) = 4·morton(i, j) + dx +
 * 2·dy. So a parent's four children occupy four CONSECUTIVE slots starting at
 * 4·parentMorton, and the merge's 4→1 pre-average is one contiguous fetch
 * instead of four strided ones. Holds even though the grid is 2w×w rather
 * than square — i simply carries one more bit than j, which rides along at
 * the top of the interleave.
 */
export function binMorton(i, j) {
  let m = 0;
  for (let b = 0; b < 16; b++) {
    m |= ((i >>> b) & 1) << (2 * b);
    m |= ((j >>> b) & 1) << (2 * b + 1);
  }
  return m >>> 0;
}

/** Inverse of binMorton. */
export function mortonToBin(m) {
  let i = 0;
  let j = 0;
  for (let b = 0; b < 16; b++) {
    i |= ((m >>> (2 * b)) & 1) << b;
    j |= ((m >>> (2 * b + 1)) & 1) << b;
  }
  return { i, j };
}

/** Linear (row-major) bin index — telemetry and debug views only, never storage. */
export function binIndex(i, j, w) {
  return j * (2 * w) + i;
}

// ═════════════════════════════════════════════════════════ R2 LOW-DISCREPANCY
//
// Paper §5: ray directions come from the R2 sequence (Roberts' generalization
// of the golden ratio to 2D) mapped through the equal-area projection, then
// sign-flipped into the surface hemisphere, with a global per-frame jitter.
//
// R2 rather than a hash: consecutive segments of R2 are themselves
// well-distributed, which is exactly what Alg. 3's contiguous-segment
// assignment relies on — probes sharing a parent take adjacent slices of one
// sequence and each slice is individually near-uniform.

/** Plastic number ρ, the 2D analogue of φ. */
export const PLASTIC = 1.32471795724474602596;
export const R2_ALPHA1 = 1 / PLASTIC;
export const R2_ALPHA2 = 1 / (PLASTIC * PLASTIC);

// ══ THE RECURRENCE IS 32-BIT FIXED POINT, AND THAT IS NOT AN OPTIMIZATION ═══
//
// Written the textbook way — `fract(0.5 + α·n)` in floats — this sequence
// DISINTEGRATES on the GPU at the ray counts SRC actually runs. f32 carries 24
// mantissa bits total, so once `α·n` is large the fractional part is what gets
// truncated, and the sequence degenerates to a handful of repeating values:
//
//     n = 1,024        16384 distinct fractional values
//     n = 65,536         256
//     n = 500,000         32
//     n = 2,000,000        8      ← plan §9's ~2M rays/frame
//
// Measured, not estimated. At 2M rays the last cascade's 2048 bins would be
// fed by EIGHT azimuths; a 16×16-cell coverage histogram over that range goes
// from a uniform 13..19 occupancy to 0..66, i.e. empty cells. This is exactly
// the class of failure a CPU mirror in f64 cannot see — the mirror is fine at
// every index, the shader is not, and the symptom on screen (banded, rotating
// directional structure that gets worse the longer a frame's ray list is)
// looks like a merge bug.
//
// So the CANONICAL form is the additive recurrence in u32 fixed point:
// exact on both sides, wraps for free (WGSL u32 arithmetic is mod 2^32,
// `Math.imul` is the same multiply), period 2^32 because both multipliers are
// odd, and — measured against the f64 float form on the same coverage and
// contiguous-segment arms — identical discrepancy. The float pair below is
// DERIVED from it, so `r2Point` keeps its old meaning and every caller is
// unchanged; the fixed-point words are what the GPU twin must match BIT FOR
// BIT, which is why `r2PointFx` is exported separately and gated exactly.

/** round(2^32 / ρ) — the R2 x multiplier in u32 fixed point. */
export const R2_ALPHA1_FX = 3242174889 >>> 0;
/** round(2^32 / ρ²) — the R2 y multiplier in u32 fixed point. */
export const R2_ALPHA2_FX = 2447445414 >>> 0;
/** The sequence's 0.5 start offset, in the same fixed point. */
export const R2_HALF_FX = 0x80000000 >>> 0;
/** u32 → [0,1). Exact in f64; the GPU twin loses the low 8 bits to f32. */
export const R2_FX_TO_UNIT = 1 / 4294967296;

/**
 * The n-th R2 point as RAW u32 fixed point, offset by a per-frame jitter that
 * is itself a u32 phase (not a float — a float jitter would re-import the
 * precision problem at the one place it is cheapest to avoid).
 */
export function r2PointFx(n, jitterX = 0, jitterY = 0) {
  return {
    x: (R2_HALF_FX + Math.imul(R2_ALPHA1_FX, n) + jitterX) >>> 0,
    y: (R2_HALF_FX + Math.imul(R2_ALPHA2_FX, n) + jitterY) >>> 0,
  };
}

/** The n-th R2 point in [0,1)², offset by a per-frame u32 jitter phase. */
export function r2Point(n, jitterX = 0, jitterY = 0) {
  const fx = r2PointFx(n, jitterX, jitterY);
  return { x: fx.x * R2_FX_TO_UNIT, y: fx.y * R2_FX_TO_UNIT };
}

/**
 * Ray direction for R2 index `n` on a surface with normal `n̂`.
 *
 * `ω ← ω·sign(ω·n̂)` — the paper's hemisphere fold (§5). NOT a cosine-weighted
 * sample and not a rejection loop: every R2 point yields exactly one usable
 * direction, so the ray budget is spent, not sampled away. The cosine factor
 * enters at the irradiance bake instead.
 *
 * Rays originate at PIXELS, never at probe positions — do not "offset the
 * probe along its normal" here or anywhere. That heuristic is what produces
 * the recessed-probe self-occlusion bias class the paper's Fig. 7/8 exists to
 * show, and pixel origins remove it by construction.
 */
export function rayDirection(n, nx, ny, nz, jitterX = 0, jitterY = 0) {
  const { x, y } = r2Point(n, jitterX, jitterY);
  const d = decodeDir(x, y);
  const s = d[0] * nx + d[1] * ny + d[2] * nz;
  // Exactly-tangent directions (s === 0) would keep a zero sign and collapse
  // the direction to the origin. Push them into the hemisphere.
  const sign = s < 0 ? -1 : 1;
  return [d[0] * sign, d[1] * sign, d[2] * sign];
}

// ══════════════════════════════════════════════════════ 32-BIT PROBE KEY
//
// The paper packs 64 bits (18b/axis + 10b LOD). WGSL has NO 64-bit atomics,
// so the insert — a single atomicCompareExchangeWeak on the packed key — has
// to fit in 32. The LOD system is what makes that exact rather than lossy:
// within one LOD, spacing scales with camera distance, so the number of
// distinct cells an LOD shell can contain is bounded by a CONSTANT, not by
// world size.
//
//   [ 4b (LOD+1) | 1b secondary | 9b x | 9b y | 9b z ]
//
// LOD is stored BIASED BY ONE so that the packed word can never be zero, and
// zero is the hashmap's EMPTY sentinel. Without the bias, cell (−256,−256,
// −256) at LOD 0 in the primary cache packs to exactly 0 and is
// indistinguishable from an empty slot — a probe that silently never exists,
// at the one position most likely to be the camera's own cell. That costs one
// of 16 LOD codes; MAX_LODS is 10, so nothing is lost.

export const KEY_AXIS_BITS = 9;
export const KEY_AXIS_RANGE = 1 << KEY_AXIS_BITS; // 512
export const KEY_AXIS_OFFSET = KEY_AXIS_RANGE >> 1; // 256
export const KEY_EMPTY = 0;

// ══════════════════════ WORLD-ABSOLUTE KEYS (the toroidal window)
//
// docs/GI_SPATIAL_REBUILD_PLAN.md Part 2 S1, realized on the KEY rather than on
// the storage. Read this block before touching anything above it.
//
// ══ WHAT S1 ASKED FOR, AND WHY IT CANNOT BE THE STORAGE ════════════════════
//
// The plan proposes a fixed-footprint camera-centred RING: "probe index =
// worldCell mod ringSize", memory sized once, growth deleted as a concept. The
// properties it buys are the right ones — no insert failure, no re-anchor, no
// retirement of survivors, O(strip) on camera motion. The arithmetic of making
// STORAGE dense is what kills it:
//
//   A probe population is a 2-DIMENSIONAL MANIFOLD (visible surfaces) inside a
//   3-dimensional lattice. A dense ring pays for the third dimension and gets
//   nothing back. At s₀ = 0.35 the LOD-0 shell reaches 44.8 m, i.e. 256 cells
//   per axis: 16,777,216 slots to hold the ~16,000 probes this scene actually
//   has. **1,049x waste at cascade 0, LOD 0 alone.** Summed over the real
//   ladder (CASCADE_COUNT 4 x MAX_LODS 10, each level's own shell) it is
//   191,692,800 cells — 5.85 GB of probe records and 338 GB of direction bins.
//
// That is the SAME arithmetic that produced §12.16's finding ("0.24% of
// allocated bins were ever sampled", 604 MB against a 128 MiB binding limit)
// and made the block pool budget-sized in the first place. The plan's own
// rejected-alternatives section names the 604 MB bin wall as the reason to
// abandon growing the hash; a dense ring walks into it from the other side.
//
// ══ SO THE TORUS GOES ON THE KEY, WHERE IT IS FREE ═════════════════════════
//
// Every property S1 wants comes from probe IDENTITY being a pure function of
// the world cell. It does not require storage to be indexed that way — the hash
// can stay sparse, which is what keeps the memory honest.
//
// Today a key holds the cell RELATIVE to a camera-following anchor, biased by
// +256 into the 9-bit field. That relativity is the entire reason `srcSystem`
// re-anchors, and re-anchoring is the plan's "wholesale history loss on long
// moves": the anchor jumps, every cell coordinate changes, every key changes,
// and every probe in the scene is renumbered and retired at once.
//
// Under world-absolute keys the 9 bits hold `worldCell mod 512` — no anchor, no
// bias, no range check, no re-anchor, EVER. A probe's key is a permanent
// property of where it is in the world.
//
// ══ THE ALIAS IS UNREACHABLE BY CONSTRUCTION, AND HERE IS THE PROOF ════════
//
// Two world cells 512 apart on an axis share a key. They can never both be live:
//
//   · LOD L exists only within Chebyshev distance `lodRadius(L+1)` of the
//     camera = s₀·64·2^(L+1), so the widest live span on one axis is
//     2·s₀·64·2^(L+1) = 256·s₀·2^L world units.
//   · The alias period at cascade c, LOD L is 512 cells of size s₀·2^(c+L),
//     i.e. 512·s₀·2^(c+L) world units.
//   · period/extent = 512·2^c / 256 = **2·2^c ≥ 2**.
//
// A factor of two at the worst pair (every cascade 0 LOD), growing by 2^c for
// the coarser cascades. `run-gi-src-worldkeys-test.mjs` sweeps all 40
// (cascade, LOD) pairs and asserts it rather than trusting this comment.
//
// ══ THE ONE COST: RECONSTRUCTION NEEDS THE CAMERA ══════════════════════════
//
// `worldCell mod 512` is not invertible on its own. Recovering the world cell —
// which the cascade ladder, the merge and the gizmos all need, because a probe's
// position comes from its key and never from a stored copy — takes the unique
// representative within ±256 cells of the camera's own cell. That is
// `wrapCellNear` below, and the margin proved above is exactly what makes the
// representative unique.
//
// Hatched (`__giSrcWorldKeys`) and OFF by default: the plan requires the old
// keying kept for A/B through the whole phase.

/** Is world-absolute probe keying armed? `__giSrcWorldKeys = true` opts in. */
export function worldKeysEnabled() {
  return globalThis.__giSrcWorldKeys === true;
}

/**
 * The unique integer congruent to `packed` mod 512 that lies within ±256 of
 * `ref` — the inverse of `worldCell & 511`.
 *
 * `ref` is the camera's own cell on the same lattice. Correct for every live
 * probe because the live span is at most half the period (see the proof above),
 * so exactly one representative falls in the window.
 */
export function wrapCellNear(packed, ref) {
  const d = (packed - ref + KEY_AXIS_OFFSET) & (KEY_AXIS_RANGE - 1);
  return ref + d - KEY_AXIS_OFFSET;
}

/**
 * Pack a probe key. `cx/cy/cz` are cell coords RELATIVE to the LOD's
 * camera-anchored origin (so they straddle zero); the +256 bias maps them into
 * [0,512). Returns 0 — never a valid key — when anything is out of range, so a
 * caller that forgets to check writes EMPTY rather than a wrong probe.
 */
export function packProbeKey(lod, secondary, cx, cy, cz) {
  if (!(lod >= 0) || lod >= KEY_MAX_LODS) return KEY_EMPTY;
  if (worldKeysEnabled()) {
    // WORLD-ABSOLUTE: `cx/cy/cz` are WORLD cells, wrapped into the 9-bit field.
    // No bias and NO RANGE CHECK — the window is toroidal now, so there is no
    // such thing as an unrepresentable cell and therefore no silent absence.
    // (The LOD test above stays: `lod` really can be out of range, and the +1
    // bias on it is what keeps a packed word from colliding with KEY_EMPTY.)
    return (
      (((lod + 1) & 0xf) << 28) |
      ((secondary ? 1 : 0) << 27) |
      ((cx & (KEY_AXIS_RANGE - 1)) << 18) |
      ((cy & (KEY_AXIS_RANGE - 1)) << 9) |
      (cz & (KEY_AXIS_RANGE - 1))
    ) >>> 0;
  }
  const x = cx + KEY_AXIS_OFFSET;
  const y = cy + KEY_AXIS_OFFSET;
  const z = cz + KEY_AXIS_OFFSET;
  if (x < 0 || y < 0 || z < 0) return KEY_EMPTY;
  if (x >= KEY_AXIS_RANGE || y >= KEY_AXIS_RANGE || z >= KEY_AXIS_RANGE) return KEY_EMPTY;
  return (
    (((lod + 1) & 0xf) << 28) |
    ((secondary ? 1 : 0) << 27) |
    (x << 18) |
    (y << 9) |
    z
  ) >>> 0;
}

/**
 * Unpack a probe key, or null for EMPTY.
 *
 * Under world-absolute keying the cell fields are RAW `[0,512)` residues, not
 * signed offsets — recovering the world cell needs a reference, so it is
 * `keyWorldCell` below and never this. Returning the un-biased signed value
 * here would hand every existing caller a plausible cell that is wrong by a
 * multiple of 512, which is the failure mode this whole block exists to make
 * impossible; so it returns the residue and says so in the field names.
 */
export function unpackProbeKey(key) {
  const k = key >>> 0;
  if (k === KEY_EMPTY) return null;
  const lodBiased = (k >>> 28) & 0xf;
  if (lodBiased === 0) return null;
  const bias = worldKeysEnabled() ? 0 : KEY_AXIS_OFFSET;
  return {
    lod: lodBiased - 1,
    secondary: ((k >>> 27) & 1) === 1,
    cx: ((k >>> 18) & (KEY_AXIS_RANGE - 1)) - bias,
    cy: ((k >>> 9) & (KEY_AXIS_RANGE - 1)) - bias,
    cz: (k & (KEY_AXIS_RANGE - 1)) - bias,
    /** True when cx/cy/cz are residues awaiting `keyWorldCell`. */
    residue: bias === 0,
  };
}

/**
 * The WORLD cell a key names, given the camera's own cell on the same lattice.
 *
 * The one inverse under world-absolute keying, and the reason every consumer
 * derives a probe's position from its key plus the camera rather than from a
 * stored position: a stored position is a second source of truth, and the
 * §12.70 W5a gate already caught what happens when two sources disagree.
 */
export function keyWorldCell(key, refCx, refCy, refCz) {
  const u = unpackProbeKey(key);
  if (!u) return null;
  if (!u.residue) return { lod: u.lod, secondary: u.secondary, cx: u.cx, cy: u.cy, cz: u.cz };
  return {
    lod: u.lod,
    secondary: u.secondary,
    cx: wrapCellNear(u.cx, refCx),
    cy: wrapCellNear(u.cy, refCy),
    cz: wrapCellNear(u.cz, refCz),
  };
}

/**
 * True when a cell is representable at all. LOD selection clamps such that
 * out-of-window cells cannot occur, and the Phase-0 property test proves that
 * claim rather than trusting it — an unrepresentable cell is a probe that
 * silently does not exist, which reads as a dark patch that moves with the
 * camera.
 */
export function probeKeyInWindow(cx, cy, cz) {
  // Under world-absolute keying EVERY cell is representable — the window wrapped
  // instead of clipping — so this is vacuously true. Kept as a call rather than
  // deleted at the call sites: the checks it guards are the ones that would have
  // to come BACK if the keying were ever reverted, and a `true` here keeps that
  // reversion a one-line change instead of a re-derivation.
  if (worldKeysEnabled()) return true;
  return (
    cx + KEY_AXIS_OFFSET >= 0 &&
    cy + KEY_AXIS_OFFSET >= 0 &&
    cz + KEY_AXIS_OFFSET >= 0 &&
    cx + KEY_AXIS_OFFSET < KEY_AXIS_RANGE &&
    cy + KEY_AXIS_OFFSET < KEY_AXIS_RANGE &&
    cz + KEY_AXIS_OFFSET < KEY_AXIS_RANGE
  );
}

/**
 * PCG-family finalizer, used as the hashmap slot function. Avalanches well
 * enough that the LOW bits of adjacent probe keys — which differ by 1 in z and
 * are therefore maximally correlated — land in unrelated slots. A weaker mix
 * (or a modulo of the raw key) clusters every probe row into one cache line
 * and turns lockless linear probing into a linear scan.
 */
export function hashKey(key) {
  let x = (key >>> 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

// ═══════════════════════════════════════════════════════ SPLIT ASSIGNMENT
//
// Paper §5. A ray from pixel P hitting at distance d with r_{k−1} < d ≤ r_k
// deposits:
//    cascade k       ← (radiance = L_hit, T = 0)
//    cascades j < k  ← (0, T = 1)
//    cascades > k    ← NOTHING
//
// The last line is the one the companion guide gets WRONG. "Extend the ray and
// deposit occlusion upward" was tested by the authors and REJECTED for bias:
// a cascade above k has not traced that far, and telling it the ray was
// blocked at d asserts occlusion over an interval the ray never sampled.

/**
 * The cascade owning hit distance `d`, or `cascadeCount` for an escape (which
 * means every cascade takes (0, T=1) and the sky composites at the top).
 * `bounds` is `intervalBoundaries(lod, spacing0)`.
 */
export function splitCascade(d, bounds) {
  for (let k = 0; k < bounds.length; k++) {
    if (d <= bounds[k]) return k;
  }
  return bounds.length;
}

/**
 * The full deposit list for one ray — the CPU mirror of the GPU's atomic
 * scatter. Returns `[{ cascade, radiance:[r,g,b], transmittance }]`, always
 * with `count` implicitly 1 per entry.
 *
 * `d < 0` (or ≥ reach) is a miss: transparent everywhere, no radiance. The sky
 * is NOT deposited here — it composites once at the top of the merge, because
 * depositing it per-cascade would multiply it by the cascade count.
 */
export function splitDeposits(d, radiance, bounds) {
  const k = d >= 0 ? splitCascade(d, bounds) : bounds.length;
  const out = [];
  for (let j = 0; j < Math.min(k, bounds.length); j++) {
    out.push({ cascade: j, radiance: [0, 0, 0], transmittance: 1 });
  }
  if (k < bounds.length) {
    out.push({ cascade: k, radiance: [radiance[0], radiance[1], radiance[2]], transmittance: 0 });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════ MERGE
//
// Paper Eq. 6/7, cascade N−1 → 0. A bin's merged value takes its own interval
// first and lets whatever it did not block through from the parent:
//
//     L_merged = L_self + T_self · L_parent
//     T_merged = T_self · T_parent
//
// `L_parent` is the sparse-trilinear, 4→1 pre-averaged parent value.

/** One bin's merge step. Radiance arrays are [r,g,b]; returns a new pair. */
export function mergeBin(selfL, selfT, parentL, parentT) {
  return {
    radiance: [
      selfL[0] + selfT * parentL[0],
      selfL[1] + selfT * parentL[1],
      selfL[2] + selfT * parentL[2],
    ],
    transmittance: selfT * parentT,
  };
}

/**
 * One frame of temporal decay on one fixed-point accumulator word.
 *
 * The whole of the temporal blend is this line, applied to every word of every
 * bin before the frame's deposits land on top. Radiance, transmittance and
 * count all decay by the same factor, so `ΣL/Σcount` comes out an
 * exponentially-weighted mean over RAYS — every ray carrying the weight of the
 * frame it was cast in. `srcDeposit.js`'s decay pass is the TSL twin.
 *
 * ══ IT ROUNDS, AND THE FIRST VERSION TRUNCATED — WHICH ATE DIM LIGHT ════════
 *
 * A decaying integer accumulator does not settle on a point but inside an
 * INTERVAL: `x = decay(x) + r` holds for a range of `x`, and which value a bin
 * lands on depends on its own history. The intervals are what separate the two
 * operators, in width and in placement:
 *
 *     truncation   x ∈ ( r/α − 1/α ,  r/α ]          entirely BELOW the truth
 *     rounding     x ∈ [ r/α − 0.5/α, r/α + 0.5/α )  half as wide, STRADDLING it
 *
 * Either way the error is a fixed number of QUANTA, which makes it a RELATIVE
 * error inversely proportional to the signal. But a gather averages many bins,
 * so a two-sided error cancels there and a one-sided one accumulates into a
 * systematic darkening of the whole image. `test:gi-src-temporal` measures both
 * — converging from zero, as a fresh bin does, lands at the bottom of each
 * interval, and the shape is the point:
 *
 *      influx r/frame     6      65     650    6500   65536
 *      truncated     -15.0%   -1.39%  -0.14%  -0.014%  -0.001%
 *      rounded        -6.7%   -0.62%  -0.06%  -0.006%  -0.001%
 *
 * `r` is `(L/Lmax)·2^F` per deposit, so truncation is a systematic DARKENING
 * that grows as the light gets dimmer — the worst possible direction for a
 * global illumination term, where dim and indirect is the whole subject.
 * Rounding halves the magnitude and, more usefully, makes what is left cancel. The rest of the lever is `Lmax`: it is the exposure the
 * fixed point is measured against, and §12.13.4 left clamp-versus-auto-exposure
 * open pending a measurement. This is a second reason to close it, and it does
 * not bind yet — hit shading is Phase 5, so every radiance word is currently
 * zero and only `T` and `count` accumulate, both at full scale and both under
 * 0.002%.
 *
 * ══ ROUNDING HAS A FIXED POINT, AND `MIN_WEIGHT` ALREADY COVERS IT ══════════
 *
 * `round(x·keep) = x` for every `x ≤ 0.5/(1−keep)` — five, at keep = 0.9 — so a
 * rounded accumulator decays into single digits and STOPS. Truncation has no
 * such fixed point, and that was the whole argument for it. It stops mattering
 * once the resolve tests a WEIGHT FLOOR rather than zero, which `srcDeposit.js`
 * needs for an unrelated reason (its resolve header: the radiance word retires
 * before the count does, so an unfloored tail votes black). `MIN_WEIGHT` is 1024
 * against a residue of 5 — a 200× margin, asserted rather than assumed.
 *
 * ══ f32, EXPLICITLY, BECAUSE THE GPU'S `keep` IS AN f32 UNIFORM ═════════════
 *
 * `Math.fround` at every step, so the mirror computes what the kernel computes
 * rather than what the same expression means in f64. It happens to be
 * unnecessary at keep = 0.9 — the f32 product's half-ulp is wider than the gap
 * between the two constants, so both land on the same integer — but that is a
 * property of one α, and a twin that agrees for a reason nobody wrote down is a
 * twin that stops agreeing when somebody changes the number.
 */
export function decayFixed(x, keep) {
  const p = Math.fround(Math.fround(x) * Math.fround(keep));
  return Math.floor(Math.fround(p + 0.5));
}

/**
 * The per-block α compensation's `keep′` (§12.40.4) — mirror of the branch in
 * `srcDeposit.js`'s decay pass, `Math.fround` at every step that rounds on the
 * GPU. `influxWord` is the fixed-point capped/natural ratio the transport
 * published for the block (`INFLUX_ONE` = uncapped); `lift` suspends the
 * compensation (1 = fully — the exact pre-compensation `keep`, bit for bit,
 * because the kernel SKIPS the branch rather than computing through it).
 *
 * `keep′ = 1 − (1−keep)·(ratio·(1−lift) + lift)`: the effective sample count
 * `influx/(1−keep′)` is held at its uncapped value at lift 0, and interpolates
 * back to the plain decay as the motion lift rises.
 */
export function keepCompensated(keep, influxWord, lift, surpriseWord = 0, surpriseF = 1) {
  const l = Math.fround(lift);
  const compensated = influxWord < INFLUX_ONE && l < 1;
  // The ratio the compensation branch multiplied by — 1 when the branch is
  // skipped, which is what the kernel's `lifted` var holds there. The surprise
  // mix interpolates FROM this, so the two mechanisms compose instead of the
  // later one discarding the earlier one's answer.
  let lifted = 1;
  let k = keep;
  if (compensated) {
    const ratio = Math.fround(influxWord / INFLUX_ONE);
    lifted = Math.fround(Math.fround(ratio * Math.fround(1 - l)) + l);
    k = Math.fround(1 - Math.fround(Math.fround(1 - Math.fround(keep)) * lifted));
  }
  // `u == 0` returns the compensated keep UNTOUCHED rather than computing
  // `mix(lifted, F, 0)`: the kernel skips the branch, so this is the same
  // skip and not an arithmetic identity that happens to agree.
  if (!(surpriseWord > 0)) return k;
  const t = Math.fround(surpriseWord / SURPRISE_ONE);
  // WGSL's `mix(a, b, t)` is `a·(1−t) + b·t`. Written out rather than as
  // `a + (b−a)·t`, which is a different rounding and would drift from the
  // kernel by an ulp at exactly the values a gate would call equal.
  const f = Math.fround(
    Math.fround(lifted * Math.fround(1 - t)) + Math.fround(Math.fround(surpriseF) * t),
  );
  return Math.fround(1 - Math.fround(Math.fround(1 - Math.fround(keep)) * f));
}

/**
 * One block's surprise state advance — the mirror of the [D1''] publish's
 * per-block leg (`srcRays.js`), `Math.fround` at every step the GPU rounds at.
 *
 * ══ WHAT IS BEING MEASURED, AND WHY IT IS A DRIFT AND NOT A DIFFERENCE ══════
 *
 * `I` is THIS frame's mean luma per unit weight; `M` is the accumulator's mean
 * BEFORE this frame lands. Their difference is one noisy sample of "the block's
 * truth moved", and comparing it against a threshold directly would fire on
 * shot noise every time a sparse block happened to draw a bright ray. So the
 * difference feeds a SIGNED EMA (`drift`): noise cancels across frames because
 * its sign is symmetric, while a real change is one-signed and accumulates.
 * That is the entire reason surprise is not `|I − M| > k·σ`.
 *
 * `noise` is the shot-noise scale of `M` at `n` deposits, floored so a block
 * whose mean is zero does not have zero σ. `u` is where `|drift|/noise` sits on
 * the T0→T1 σ ramp, zeroed while the block has too little evidence to have a
 * mean at all, and finally scaled by the governor's gain — ONCE, here, because
 * both consumers read the word this writes (srcConfig's one-switch rule).
 *
 * @param {{accL: number, accW: number, drift: number}} state  the block's f32 words
 * @param {{sumL: number, sumW: number}} sums  LAST frame's [E] deposits, in
 *   `SUM_SCALE` fixed point
 * @param {number} keepPrev  the block's own `keepCompensated` from the influx
 *   word it published LAST frame — the accumulators decayed at that rate, so
 *   this must too, or the mean drifts against its own history
 * @param {object} [opts]
 * @param {number} [opts.gain]  the governor's `surpriseGain`
 * @param {number} [opts.age]  frames since the block was claimed
 * @param {number} [opts.rayWeight]  what one deposit adds to `sumW`
 *   (`DEPOSIT_SCALE / SUM_SCALE`) — passed in rather than imported, because
 *   `DEPOSIT_SCALE` lives in a module that imports `three` and this one may not
 * @param {boolean} [opts.reclaimed]  the block was claimed THIS frame, so the
 *   state belongs to a DEAD probe and is discarded rather than decayed
 */
export function blockSurpriseUpdate(state, sums, keepPrev, opts = {}) {
  const { gain = 1, age = Infinity, rayWeight = 64, reclaimed = false } = opts;
  const k = Math.fround(keepPrev);
  const sL = Math.fround(sums?.sumL ?? 0);
  const sW = Math.fround(sums?.sumW ?? 0);
  let accL = reclaimed ? 0 : Math.fround(state?.accL ?? 0);
  let accW = reclaimed ? 0 : Math.fround(state?.accW ?? 0);
  let drift = reclaimed ? 0 : Math.fround(state?.drift ?? 0);
  // PRE-update mean. Taken before the new sums land, because the question is
  // whether THIS frame surprised the history — folding it in first would make
  // every frame partly its own baseline and mute exactly the step being
  // looked for.
  const M = accW > 0 ? Math.fround(accL / accW) : 0;
  accL = Math.fround(Math.fround(accL * k) + Math.fround(sL / SUM_SCALE));
  accW = Math.fround(Math.fround(accW * k) + Math.fround(sW / SUM_SCALE));
  const n = Math.fround(sW / rayWeight);
  const I = sW > 0 ? Math.fround(sL / sW) : M;
  drift = Math.fround(drift + Math.fround(SURPRISE_RATE * Math.fround(Math.fround(I - M) - drift)));
  const noise = Math.fround(
    Math.fround(M * Math.fround(Math.sqrt(Math.fround(SURPRISE_SHOT_K / Math.max(n, 1)))))
    + SURPRISE_FLOOR,
  );
  const z = Math.fround(Math.abs(drift) / noise);
  let u = Math.fround(Math.fround(z - SURPRISE_T0) / (SURPRISE_T1 - SURPRISE_T0));
  u = Math.min(1, Math.max(0, u));
  if (accW < SURPRISE_MIN_EVIDENCE || !(n > 0) || age < COLD_FILL_FRAMES) u = 0;
  u = Math.fround(u * Math.fround(gain));
  return { accL, accW, drift, u, word: Math.floor(Math.fround(u * SURPRISE_ONE + 0.5)) };
}

/**
 * The transport's influx word for one probe (`srcRays.js` [D1'']):
 * `floor(fl32(capped/natural)·65536 + 0.5)`, `INFLUX_ONE` when nothing was
 * demanded. The `·65536 + 0.5` is exact in f64 given an f32 quotient, which is
 * why only the divide is frounded.
 */
export function influxWordFor(capped, natural) {
  if (!(natural > 0)) return INFLUX_ONE;
  return Math.floor(Math.fround(capped / natural) * INFLUX_ONE + 0.5);
}

/**
 * Resolve a fixed-point deposit accumulator into a filterable value.
 *
 * ZERO-COUNT BINS ARE NOT ZERO — they are UNKNOWN, and the difference is the
 * whole of R1. A bin no ray happened to land in must be excluded from the
 * merge's weighting, not fed in as black; feeding it in as black is a hard
 * cliff at the edge of every sparsely-sampled region. Returns null for
 * unknown so callers cannot accidentally treat it as data.
 */
export function resolveBin(sumR, sumG, sumB, sumT, count) {
  if (!(count > 0)) return null;
  const inv = 1 / count;
  return { radiance: [sumR * inv, sumG * inv, sumB * inv], transmittance: sumT * inv };
}

/**
 * Pre-average four child bins into the value their parent level will consume
 * (paper §6). Storing the ALREADY-AVERAGED cone rather than raw per-bin cones
 * is what lets the next level up read one value instead of four.
 *
 * Unknown children are SKIPPED and the average renormalizes over what was
 * found — the same "rejection weights are epsilons, never zeros" rule the
 * sparse-trilinear gather runs under. All four unknown → unknown.
 */
export function preAverage(children) {
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let t = 0;
  for (const c of children) {
    if (!c) continue;
    r += c.radiance[0];
    g += c.radiance[1];
    b += c.radiance[2];
    t += c.transmittance;
    n++;
  }
  if (n === 0) return null;
  const inv = 1 / n;
  return { radiance: [r * inv, g * inv, b * inv], transmittance: t * inv };
}

// ══════════════════════════════════════════════════ SPARSE TRILINEAR GATHER
//
// Paper §4. Probes are inserted for the NEAREST cell only — deliberately NOT
// the 8 trilinear corners, which the authors measured as 2× the probes for
// little quality gain. So an interpolation's corners are frequently MISSING,
// and the rule is: sum the probes that exist times their weights, then
// renormalize by the total weight FOUND.
//
// Renormalizing (rather than treating a missing corner as black) is the same
// earned rule as the octahedral gather's: a missing sample is an absence of
// information, and absence must not be spent as a dark vote.

/** The 8 corner cells and trilinear weights for `p` on a lattice of `spacing`. */
export function trilinearCorners(px, py, pz, originX, originY, originZ, spacing) {
  const fx = (px - originX) / spacing;
  const fy = (py - originY) / spacing;
  const fz = (pz - originZ) / spacing;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;
  const out = [];
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w =
          (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        out.push({ cx: x0 + dx, cy: y0 + dy, cz: z0 + dz, weight: w });
      }
    }
  }
  return out;
}

/** The nearest lattice cell to `p` — the ONE cell a pixel inserts. */
export function nearestCell(px, py, pz, originX, originY, originZ, spacing) {
  return {
    cx: Math.round((px - originX) / spacing),
    cy: Math.round((py - originY) / spacing),
    cz: Math.round((pz - originZ) / spacing),
  };
}

/**
 * The lattice origin for a spacing — the anchor snapped onto that lattice.
 *
 * Lives here rather than in `srcRef.js` (which wrapped it as `latticeOrigin(cfg,
 * cascade, lod)`) so that the reference, the GPU twin and the twin gate all
 * round the same way. `Math.round` is ties-toward-+∞ and WGSL's `round` is
 * ties-to-EVEN, so this is exactly the function where two implementations
 * quietly disagree about which cell a probe belongs to.
 */
export function latticeOriginFor(anchorX, anchorY, anchorZ, spacing) {
  return [
    Math.round(anchorX / spacing) * spacing,
    Math.round(anchorY / spacing) * spacing,
    Math.round(anchorZ / spacing) * spacing,
  ];
}

/**
 * The lattice origin as an INTEGER CELL INDEX. Mirror of
 * `srcMathTsl.latticeOriginCell`.
 */
export function latticeOriginCellFor(anchorX, anchorY, anchorZ, spacing) {
  return [
    Math.round(anchorX / spacing),
    Math.round(anchorY / spacing),
    Math.round(anchorZ / spacing),
  ];
}

/**
 * THE WORLD CELL of a point, without ever dividing an absolute world coordinate.
 * Mirror of `srcMathTsl.worldCellAt` — that function's header carries the whole
 * argument (f32 precision, and why this is what deletes the re-anchor).
 */
export function worldCellAt(px, py, pz, anchorX, anchorY, anchorZ, spacing) {
  const o = latticeOriginCellFor(anchorX, anchorY, anchorZ, spacing);
  const local = nearestCell(px, py, pz, o[0] * spacing, o[1] * spacing, o[2] * spacing, spacing);
  return { cx: o[0] + local.cx, cy: o[1] + local.cy, cz: o[2] + local.cz };
}

/** World position of lattice cell (cx, cy, cz). */
export function cellPosition(cx, cy, cz, originX, originY, originZ, spacing) {
  return [originX + cx * spacing, originY + cy * spacing, originZ + cz * spacing];
}

/**
 * Renormalized sparse gather. `lookup(cx, cy, cz)` returns a value or null.
 * `combine(acc, value, weight)` accumulates. Returns null when NO corner
 * existed — the caller then falls back to temporal fill, never to a
 * fixed-radius guess (R1).
 */
export function sparseGather(corners, lookup, combine, zero) {
  let total = 0;
  let acc = zero();
  for (const c of corners) {
    if (!(c.weight > 0)) continue;
    const v = lookup(c.cx, c.cy, c.cz);
    if (v == null) continue;
    acc = combine(acc, v, c.weight);
    total += c.weight;
  }
  return total > 0 ? { value: acc, weight: total } : null;
}

// ═══════════════════════════════════════ OCTAHEDRAL — IRRADIANCE TILES ONLY
//
// The ONE place octahedral survives (paper §6): the per-probe 6×6 irradiance
// texture pixels sample for final shading. Bins are equal-area cylindrical;
// these tiles are octahedral because they are SAMPLED BY A NORMAL with
// hardware bilinear filtering, which the octahedral layout supports with a
// 1-texel border and the cylindrical one does not (its azimuth seam and pole
// rows have no consistent border).
//
// Mirrors cascadeTrace.js's `octahedralUV` / `octahedralDirection` /
// `octahedralTexelWeight` exactly — that math was earned (the texel solid
// angle varies 2.73×, and ignoring it put a 1.95× position-dependent error in
// every gather) and is reused verbatim rather than re-derived.

/** Direction → continuous octahedral texel coords in [0, res). */
export function octahedralUV(dx, dy, dz, res) {
  const inv = 1 / (Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
  const px = dx * inv;
  const py = dy * inv;
  let fx = px;
  let fy = py;
  if (dz <= 0) {
    const sx = px >= 0 ? 1 : -1;
    const sy = py >= 0 ? 1 : -1;
    fx = (1 - Math.abs(py)) * sx;
    fy = (1 - Math.abs(px)) * sy;
  }
  return { u: (fx * 0.5 + 0.5) * res, v: (fy * 0.5 + 0.5) * res };
}

/** Octahedral texel centre (u, v) in a res×res tile → unit direction. */
export function octahedralDirection(u, v, res) {
  const fx = ((u + 0.5) / res) * 2 - 1;
  const fy = ((v + 0.5) / res) * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const sx = fx >= 0 ? 1 : -1;
  const sy = fy >= 0 ? 1 : -1;
  const nx = fx - sx * fold;
  const ny = fy - sy * fold;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * RELATIVE solid angle of the octahedral texel a normalized direction came
 * from: Δω ∝ (|dx| + |dy| + |dz|)³. Only ratios matter (every consumer divides
 * by its own Σ), so the (2/res)² constant is deliberately omitted — exactly as
 * in the TSL original.
 */
export function octahedralTexelWeight(dx, dy, dz) {
  const s = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
  return s * s * s;
}

/**
 * Octahedral texel index in a res×res tile — nearest texel, clamped.
 */
export function octahedralTexelIndex(dx, dy, dz, res) {
  const { u, v } = octahedralUV(dx, dy, dz, res);
  const ui = Math.min(res - 1, Math.max(0, Math.floor(u)));
  const vi = Math.min(res - 1, Math.max(0, Math.floor(v)));
  return vi * res + ui;
}

// ══════════════════════════════════════════ [H] IRRADIANCE-TILE LAYOUT
//
// The two scene-independent tables the tile bake needs. Both live here rather
// than beside the bake because they are pure LAYOUT — functions of (w,
// interior, sub) and nothing else — and because putting them here is what
// lets the GPU bake and the CPU mirror share ONE definition instead of
// growing a twin each.

/**
 * For every texel of a BORDERED tile, the INTERIOR texel index whose value it
 * carries. The one definition of the octahedral wrap rule.
 *
 * ══ THE WRAP RULE ══════════════════════════════════════════════════════════
 *
 * Crossing an edge of the octahedral square continues onto the sphere at the
 * mirrored position on the SAME edge with the other axis negated. In texel
 * terms: an edge's border row is that edge's own texels in REVERSE order, and
 * each corner border texel is the DIAGONALLY OPPOSITE interior corner.
 *
 * Interior texels map to themselves, which is what makes the returned array a
 * complete description of the tile: **every texel, border or not, is the
 * irradiance integral evaluated at exactly one interior direction.** The GPU
 * bake spends that: it dispatches one thread per tile texel and each thread
 * runs the integral for `map[texel]`, so the border needs no copy pass, no
 * read-after-write on the atlas, and no wrap logic in WGSL at all.
 *
 * @param {number} interior  payload resolution (6)
 * @param {number} [border]  border width (1)
 * @returns {Int32Array} length `(interior + 2·border)²`
 */
export function octahedralBorderMap(interior, border = 1) {
  const N = interior;
  const size = N + 2 * border;
  const map = new Int32Array(size * size);
  const inner = (x, y) => y * N + x;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px - border;
      const y = py - border;
      const insideX = x >= 0 && x < N;
      const insideY = y >= 0 && y < N;
      let src;
      if (insideX && insideY) src = inner(x, y);
      // Left/right borders mirror their own edge vertically; top/bottom mirror
      // theirs horizontally.
      else if (insideY) src = inner(px === 0 ? 0 : N - 1, N - 1 - y);
      else if (insideX) src = inner(N - 1 - x, py === 0 ? 0 : N - 1);
      // All four corners are the −Z pole, which is exactly why this line
      // matters more than it looks — see `fillOctahedralBorder`'s header for
      // the 32% it is worth on a −Z receiver.
      else src = inner(px === 0 ? N - 1 : 0, py === 0 ? N - 1 : 0);
      map[py * size + px] = src;
    }
  }
  return map;
}

/**
 * The per-(bin, tile-texel) cosine weight table:
 *
 *     W(bin, n̂) = ⟨max(0, ω·n̂)⟩ over the bin's solid angle
 *
 * NOT `max(0, ω_centre·n̂)`, and that distinction is worth an essay because it
 * is a bias the convergence sweep caught red-handed.
 *
 * A c0 bin is 4π/32 ≈ 0.39 sr — about 40° across. Evaluating the cosine at its
 * CENTRE and calling that the bin's contribution is a one-point quadrature over
 * a 40° cone, and the error it leaves is ANGULAR: refining probe spacing cannot
 * reduce it, because s0 buys spatial resolution and this is a directional
 * integral. The Phase-0 sweep showed exactly that fingerprint — 32.2% → 30.0%
 * → 28.6% across two halvings of s0, i.e. flat. A blur shrinks; a bias sits
 * there, and telling them apart is the entire reason that arm measures
 * convergence instead of comparing against a tolerance.
 *
 * (This is the same class as the "frozen texel-centre cosine" the plan's §1
 * table blames for the dense backend's settled-panel residual. It survived the
 * architecture change because it was never in the transport — it was in the
 * bake.)
 *
 * The fix is a proper quadrature: sub-sample each bin. Because the bins are
 * EQUAL-AREA in (x, y), uniform sub-sampling in (x, y) is uniform in solid
 * angle, so a plain mean over sub-samples IS the solid-angle average — no
 * Jacobian, no weights. The table depends only on (w, tileRes, sub), never on
 * the scene, so it is computed once and shared by every probe.
 *
 * Layout is `[bin·texels + texel]`. `tileCosineWeights` below transposes it
 * into the bordered layout the GPU wants.
 */
const cosWeightCache = new Map();
export function binCosineWeights(w, tileRes, sub = 4) {
  const key = `${w}|${tileRes}|${sub}`;
  const hit = cosWeightCache.get(key);
  if (hit) return hit;
  const nBins = 2 * w * w;
  const texels = tileRes * tileRes;
  const table = new Float64Array(nBins * texels);
  // Texel normals, hoisted.
  const normals = new Array(texels);
  for (let v = 0; v < tileRes; v++) {
    for (let u = 0; u < tileRes; u++) normals[v * tileRes + u] = octahedralDirection(u, v, tileRes);
  }
  const invSub = 1 / (sub * sub);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < 2 * w; i++) {
      const m = binMorton(i, j);
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = (i + (sx + 0.5) / sub) / (2 * w);
          const y = (j + (sy + 0.5) / sub) / w;
          const d = decodeDir(x, y);
          for (let t = 0; t < texels; t++) {
            const n = normals[t];
            const cos = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            if (cos > 0) table[m * texels + t] += cos * invSub;
          }
        }
      }
    }
  }
  cosWeightCache.set(key, table);
  return table;
}

/**
 * `binCosineWeights`, transposed into the BORDERED tile layout and indexed
 * `[texel·nBins + bin]` — the exact table the GPU bake reads.
 *
 * Two changes from the interior table, and both remove work from WGSL:
 *
 * - **Border rows are the mirrored interior rows.** A border texel's weights
 *   are its wrapped interior texel's weights, so a thread that owns a border
 *   texel computes the same integral and stores it in the border position.
 *   The wrap therefore lives in a CPU-built table rather than in shader
 *   control flow, which is why the bake kernel has no octahedral math in it at
 *   all.
 * - **Bin-major within a texel**, so the kernel's inner loop over bins walks
 *   contiguous memory.
 *
 * f32 rather than f64 because it is uploaded — and it is the same value the
 * mirror uses, rounded once, in one place.
 */
export function tileCosineWeights(w, interior, sub = 4, border = 1) {
  const nBins = 2 * w * w;
  const size = interior + 2 * border;
  const inner = binCosineWeights(w, interior, sub);
  const map = octahedralBorderMap(interior, border);
  const texels = interior * interior;
  const out = new Float32Array(size * size * nBins);
  for (let t = 0; t < size * size; t++) {
    const src = map[t];
    for (let m = 0; m < nBins; m++) out[t * nBins + m] = inner[m * texels + src];
  }
  return out;
}
