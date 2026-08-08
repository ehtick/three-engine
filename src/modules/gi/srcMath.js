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

import { KEY_MAX_LODS } from "./srcConfig.js";

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

/** (x, y) ∈ [0,1)² → unit direction. Equal-area by construction. */
export function decodeDir(x, y) {
  const phi = 2 * Math.PI * x;
  const z = 2 * y - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
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

/** The n-th R2 point in [0,1)², offset by a per-frame `jitter` in [0,1)². */
export function r2Point(n, jitterX = 0, jitterY = 0) {
  const x = 0.5 + R2_ALPHA1 * n + jitterX;
  const y = 0.5 + R2_ALPHA2 * n + jitterY;
  return { x: x - Math.floor(x), y: y - Math.floor(y) };
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

/**
 * Pack a probe key. `cx/cy/cz` are cell coords RELATIVE to the LOD's
 * camera-anchored origin (so they straddle zero); the +256 bias maps them into
 * [0,512). Returns 0 — never a valid key — when anything is out of range, so a
 * caller that forgets to check writes EMPTY rather than a wrong probe.
 */
export function packProbeKey(lod, secondary, cx, cy, cz) {
  if (!(lod >= 0) || lod >= KEY_MAX_LODS) return KEY_EMPTY;
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

/** Unpack a probe key, or null for EMPTY. */
export function unpackProbeKey(key) {
  const k = key >>> 0;
  if (k === KEY_EMPTY) return null;
  const lodBiased = (k >>> 28) & 0xf;
  if (lodBiased === 0) return null;
  return {
    lod: lodBiased - 1,
    secondary: ((k >>> 27) & 1) === 1,
    cx: ((k >>> 18) & (KEY_AXIS_RANGE - 1)) - KEY_AXIS_OFFSET,
    cy: ((k >>> 9) & (KEY_AXIS_RANGE - 1)) - KEY_AXIS_OFFSET,
    cz: (k & (KEY_AXIS_RANGE - 1)) - KEY_AXIS_OFFSET,
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
