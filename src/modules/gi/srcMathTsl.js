// SPLIT RADIANCE CASCADES — the math kernel, in TSL.
//
// The GPU twin of `srcMath.js` (plus the scalar half of `srcConfig.js`, which
// is the same kind of function and would otherwise need a second twin file for
// no reason). srcMath.js's header states the contract these two live under and
// it is worth restating from this side, because this is the file that gets it
// wrong: THE TWO ARE ONE DEFINITION AND MUST CHANGE TOGETHER. When the mirror
// and the kernel disagree, the CPU suite goes green while the screen is wrong,
// and nothing names the disagreement until somebody measures a third thing.
//
// `scripts/run-gi-src-math-test.mjs` is that third thing: it evaluates every
// function here in a real compute pass and diffs it against srcMath.js over the
// same inputs, INTEGER RESULTS BIT-EXACT. Adding a function here without adding
// it there is the whole failure mode.
//
// ══ WHY THESE ARE INLINE HELPERS AND NOT `sharedFn`s ═══════════════════════
//
// `giFn.js`'s per-builder machinery exists for BIG bodies — it was built when a
// mirror material inlined 57 copies of a five-branch SDF and made a 250kB
// shader. Every function here is three to twelve instructions. A WGSL function
// call per bin index would cost more than it saves and would drag in the layout
// type question for u32/i32 parameters for nothing. `occupancyField.js`'s bit
// math is inline for the same reason.
//
// ══ THE FOUR PLACES f32 IS NOT f64, ALL OF THEM LOAD-BEARING ═══════════════
//
// 1. ROUNDING. WGSL `round()` is ties-to-EVEN; JS `Math.round` is ties-toward
//    +∞. `nearestCell` rounds, so a probe sitting exactly halfway between two
//    lattice cells would insert a DIFFERENT probe on each side. Every rounding
//    below is `floor(x + 0.5)`, which is what Math.round means.
// 2. THE R2 SEQUENCE cannot be evaluated in floats at all — see srcMath.js's
//    fixed-point note, which is the finding this file's gate was written for.
// 3. LOD SELECTION takes a `log2` and then a `floor`. A world point within ~1e-6
//    of a LOD boundary can floor to different shells on the two sides. That is
//    inherent, not fixable here, and it is a TOLERANCE THE PHASE-1 PROBE GATE
//    HAS TO CARRY — a handful of boundary pixels inserting the neighbouring
//    LOD's probe is correct behaviour, not a bug to chase.
// 4. LARGE WORLD COORDINATES. `(p − origin)/spacing` is exact enough in f32
//    while p is camera-relative and loses a bit per octave once it is not. The
//    lattice origins are camera-anchored precisely so this stays true (§4.2);
//    a build that anchors at the world origin instead re-imports the problem.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.2, §7 Phase 1.

import {
  Fn,
  bitAnd,
  bitOr,
  bitXor,
  cos,
  float,
  floor,
  int,
  ivec3,
  log2,
  select,
  shiftLeft,
  shiftRight,
  sin,
  sqrt,
  uint,
  uvec2,
  vec2,
  vec3,
} from "three/tsl";
import {
  KEY_AXIS_OFFSET,
  KEY_AXIS_RANGE,
  KEY_EMPTY,
  R2_ALPHA1_FX,
  R2_ALPHA2_FX,
  R2_FX_TO_UNIT,
  R2_HALF_FX,
} from "./srcMath.js";
import { KEY_MAX_LODS, LOD0_REACH, LOD_OVERLAP, MAX_LODS, R0_OVER_S0, GAMMA } from "./srcConfig.js";

const TAU = Math.PI * 2;

/**
 * The largest f32 strictly below 1.
 *
 * `encodeDir`'s CPU clamp is the literal 0.9999999999, which is a perfectly
 * good f64 and rounds to EXACTLY 1.0 in f32 — so transcribing it would defeat
 * the clamp on the very side that needs it (a y of 1.0 indexes bin w, one past
 * the end). The two therefore differ by 6e-8 in the top 6e-8 of the domain,
 * which is invisible to `dirToBin` because both land in bin w−1, and the twin
 * gate measures `dirToBin` exactly for that reason rather than trusting it.
 */
const ONE_MINUS_ULP = 1 - Math.pow(2, -24);

/** JS `Math.round` semantics, which WGSL `round` does NOT have (see header). */
export function roundHalfUp(x) {
  return floor(float(x).add(0.5));
}

// ═══════════════════════════════════════════════ EQUAL-AREA CYLINDRICAL BINS

/**
 * (x, y) ∈ [0,1)² → unit direction. Twin of `decodeDir`.
 *
 * `r = sqrt((1−z)(1+z))`, NOT `sqrt(1 − z²)`, and the difference is 400× at the
 * poles. Near z = ±1, `z·z` rounds to something within an ulp of 1 and the
 * subtraction cancels almost every significant bit — the twin gate measured
 * 1.3e-5 of absolute error in x/y at y = 0.999999, which is three orders worse
 * than everything else in this file. The factored form has no cancellation at
 * all: `1 − z` is EXACT in binary floating point for z ∈ [0.5, 2] (Sterbenz)
 * and `1 + z` is exact for the mirrored range, so whichever pole is close, the
 * factor that goes small is computed exactly. srcMath.js carries the same form
 * for the same reason — it is better there too, it just was not observable.
 */
export function decodeDir(x, y) {
  const phi = float(x).mul(TAU).toVar();
  const z = float(y).mul(2).sub(1).toVar();
  const r = sqrt(float(1).sub(z).mul(float(1).add(z)).max(0)).toVar();
  return vec3(r.mul(cos(phi)), r.mul(sin(phi)), z);
}

/** Unit direction → (x, y) ∈ [0,1)². Twin of `encodeDir`. */
export function encodeDir(d) {
  const v = vec3(d).toVar();
  // ── atan2(0, 0) IS UNDEFINED IN WGSL, AND ±Z HITS IT EVERY TIME ──────────
  // The spec leaves atan2(0,0) indeterminate; this adapter's GPU returned π/2
  // where JS returns 0, so an exactly axial ±Z ray binned to a different
  // AZIMUTH WEDGE on the two sides. At the pole every wedge is equally
  // defensible, which is exactly why it must be PINNED rather than argued
  // about: "implementation-defined" also means two GPUs may disagree, and a
  // deposit that lands in a different bin per vendor is not something any
  // later gate can attribute. Substituting x = 1 when both are zero gives
  // atan2(0, 1) = 0, which is what `Math.atan2(0, 0)` returns.
  const ax = select(v.x.equal(0).and(v.y.equal(0)), float(1), v.x).toVar();
  // atan(y, x) is atan2 on the WebGPU coordinate system (MathNode.ATAN with a
  // second operand). Range (−π, π]; the fold below matches the CPU's `+= 2π`.
  const phi = v.y.atan(ax).toVar();
  const x = phi.div(TAU).toVar();
  x.assign(select(x.lessThan(0), x.add(1), x));
  // `atan2` returning a hair under 2π after the fold would give x == 1, which
  // is out of the half-open square. Wrap, exactly as the CPU does.
  x.assign(select(x.greaterThanEqual(1), x.sub(1), x));
  const y = v.z.add(1).mul(0.5).clamp(0, ONE_MINUS_ULP).toVar();
  return vec2(x, y);
}

/**
 * Bin (i, j) for a direction on the 2w×w grid. Twin of `dirToBin`.
 * `w` is a JS NUMBER, not a node — the grid width is a per-cascade compile-time
 * constant, and making it dynamic would cost a uniform read in the hottest
 * loop in the module for a value that never varies within a dispatch.
 */
export function dirToBin(d, w) {
  const xy = encodeDir(d).toVar();
  const i = int(floor(xy.x.mul(2 * w))).clamp(0, 2 * w - 1);
  const j = int(floor(xy.y.mul(w))).clamp(0, w - 1);
  return uvec2(uint(i), uint(j));
}

/** Bin centre direction for (i, j) at width `w`. Twin of `binDir`. */
export function binDir(i, j, w) {
  return decodeDir(
    float(i).add(0.5).div(2 * w),
    float(j).add(0.5).div(w),
  );
}

/**
 * Spread the low 16 bits of `v` into the even bit positions.
 *
 * The magic-mask form of srcMath's 16-iteration interleave loop — provably the
 * same function on 16-bit inputs and five operations instead of thirty-two. The
 * twin gate walks every bin index of every cascade through both, so "provably"
 * is checked rather than asserted.
 */
function part1By1(v) {
  const x = bitAnd(uint(v), uint(0x0000ffff)).toVar();
  x.assign(bitAnd(bitXor(x, shiftLeft(x, uint(8))), uint(0x00ff00ff)));
  x.assign(bitAnd(bitXor(x, shiftLeft(x, uint(4))), uint(0x0f0f0f0f)));
  x.assign(bitAnd(bitXor(x, shiftLeft(x, uint(2))), uint(0x33333333)));
  x.assign(bitAnd(bitXor(x, shiftLeft(x, uint(1))), uint(0x55555555)));
  return x;
}

/** Gather the even bit positions of `v` back into the low 16 bits. */
function compact1By1(v) {
  const x = bitAnd(uint(v), uint(0x55555555)).toVar();
  x.assign(bitAnd(bitXor(x, shiftRight(x, uint(1))), uint(0x33333333)));
  x.assign(bitAnd(bitXor(x, shiftRight(x, uint(2))), uint(0x0f0f0f0f)));
  x.assign(bitAnd(bitXor(x, shiftRight(x, uint(4))), uint(0x00ff00ff)));
  x.assign(bitAnd(bitXor(x, shiftRight(x, uint(8))), uint(0x0000ffff)));
  return x;
}

/** Morton (Z-order) index of bin (i, j) — the payload STORAGE order. */
export function binMorton(i, j) {
  return bitOr(part1By1(i), shiftLeft(part1By1(j), uint(1)));
}

/** Inverse of `binMorton`. */
export function mortonToBin(m) {
  return uvec2(compact1By1(m), compact1By1(shiftRight(uint(m), uint(1))));
}

/** 4→1 parent mapping: integer halving on the bin grid. */
export function binParent(i, j) {
  return uvec2(shiftRight(uint(i), uint(1)), shiftRight(uint(j), uint(1)));
}

// ═════════════════════════════════════════════════════════ R2 LOW-DISCREPANCY
//
// Fixed point, for the reason srcMath.js measures: the float form has EIGHT
// distinct values left by the time n reaches plan §9's ray count. `jitterX/Y`
// are u32 PHASES, not floats — a float jitter would put the precision problem
// back in at the one place it costs nothing to avoid.

/** The n-th R2 point as raw u32 fixed point. Twin of `r2PointFx`. BIT-EXACT. */
export function r2PointFx(n, jitterX = 0, jitterY = 0) {
  const i = uint(n).toVar();
  return uvec2(
    uint(R2_HALF_FX).add(uint(R2_ALPHA1_FX).mul(i)).add(uint(jitterX)),
    uint(R2_HALF_FX).add(uint(R2_ALPHA2_FX).mul(i)).add(uint(jitterY)),
  );
}

/**
 * The n-th R2 point in [0,1)². Twin of `r2Point`.
 *
 * The u32 → f32 conversion drops the low 8 bits, so this is where the twins
 * legitimately part company (by ≤ 2^-24). `r2PointFx` above is the bit-exact
 * pair, and it is the one the gate holds to zero tolerance.
 */
export function r2Point(n, jitterX = 0, jitterY = 0) {
  const fx = r2PointFx(n, jitterX, jitterY).toVar();
  return vec2(fx.x.toFloat().mul(R2_FX_TO_UNIT), fx.y.toFloat().mul(R2_FX_TO_UNIT));
}

/**
 * Ray direction for R2 index `n` on a surface with normal `n̂`. Twin of
 * `rayDirection`.
 *
 * Rays originate at PIXELS, never at probe positions — the same standing rule
 * srcMath.js states, repeated because this is the file somebody will be reading
 * when they are tempted to offset the origin along the normal to fix a
 * self-occlusion artifact. That heuristic is the artifact.
 */
export function rayDirection(n, normal, jitterX = 0, jitterY = 0) {
  const p = r2Point(n, jitterX, jitterY).toVar();
  const d = decodeDir(p.x, p.y).toVar();
  const s = d.dot(vec3(normal)).toVar();
  // Exactly-tangent directions keep sign 0 in WGSL and would collapse the
  // direction to the origin, so the test is `< 0` rather than `sign()`.
  return d.mul(select(s.lessThan(0), float(-1), float(1)));
}

// ══════════════════════════════════════════════════════ 32-BIT PROBE KEY

/**
 * Pack a probe key: `[ 4b (LOD+1) | 1b secondary | 9b x | 9b y | 9b z ]`.
 * Twin of `packProbeKey`. Returns KEY_EMPTY (0) for anything out of range, so
 * a caller that forgets to check writes EMPTY rather than a wrong probe.
 *
 * LOD is biased by one so a packed word can never be zero — zero is the
 * hashmap's EMPTY sentinel, and without the bias cell (−256,−256,−256) at LOD 0
 * packs to exactly 0 and is a probe that silently does not exist, at the one
 * position most likely to be the camera's own cell.
 */
export function packProbeKey(lod, secondary, cell) {
  const l = int(lod).toVar();
  const c = ivec3(cell).toVar();
  const x = c.x.add(KEY_AXIS_OFFSET).toVar();
  const y = c.y.add(KEY_AXIS_OFFSET).toVar();
  const z = c.z.add(KEY_AXIS_OFFSET).toVar();
  const inRange = l.greaterThanEqual(0)
    .and(l.lessThan(KEY_MAX_LODS))
    .and(x.greaterThanEqual(0)).and(x.lessThan(KEY_AXIS_RANGE))
    .and(y.greaterThanEqual(0)).and(y.lessThan(KEY_AXIS_RANGE))
    .and(z.greaterThanEqual(0)).and(z.lessThan(KEY_AXIS_RANGE));
  const key = bitOr(
    bitOr(
      shiftLeft(bitAnd(uint(l.add(1)), uint(0xf)), uint(28)),
      shiftLeft(uint(secondary), uint(27)),
    ),
    bitOr(
      shiftLeft(uint(x), uint(18)),
      bitOr(shiftLeft(uint(y), uint(9)), uint(z)),
    ),
  );
  return select(inRange, key, uint(KEY_EMPTY));
}

/** LOD stored in a packed key, or −1 for EMPTY. */
export function keyLod(key) {
  const biased = bitAnd(shiftRight(uint(key), uint(28)), uint(0xf)).toVar();
  return select(biased.equal(uint(0)), int(-1), int(biased).sub(1));
}

/** Secondary-cache flag of a packed key, as a uint 0/1. */
export function keySecondary(key) {
  return bitAnd(shiftRight(uint(key), uint(27)), uint(1));
}

/** Cell coordinates of a packed key, un-biased back to signed. */
export function keyCell(key) {
  const k = uint(key).toVar();
  return ivec3(
    int(bitAnd(shiftRight(k, uint(18)), uint(KEY_AXIS_RANGE - 1))).sub(KEY_AXIS_OFFSET),
    int(bitAnd(shiftRight(k, uint(9)), uint(KEY_AXIS_RANGE - 1))).sub(KEY_AXIS_OFFSET),
    int(bitAnd(k, uint(KEY_AXIS_RANGE - 1))).sub(KEY_AXIS_OFFSET),
  );
}

/** True when a cell is representable at all. Twin of `probeKeyInWindow`. */
export function probeKeyInWindow(cell) {
  const c = ivec3(cell).toVar();
  return c.x.add(KEY_AXIS_OFFSET).greaterThanEqual(0)
    .and(c.y.add(KEY_AXIS_OFFSET).greaterThanEqual(0))
    .and(c.z.add(KEY_AXIS_OFFSET).greaterThanEqual(0))
    .and(c.x.add(KEY_AXIS_OFFSET).lessThan(KEY_AXIS_RANGE))
    .and(c.y.add(KEY_AXIS_OFFSET).lessThan(KEY_AXIS_RANGE))
    .and(c.z.add(KEY_AXIS_OFFSET).lessThan(KEY_AXIS_RANGE));
}

/**
 * PCG-family finalizer — the hashmap slot function. Twin of `hashKey`.
 * BIT-EXACT: WGSL u32 multiply wraps mod 2^32 and so does `Math.imul`.
 */
export function hashKey(key) {
  const x = bitXor(uint(key), uint(0x9e3779b9)).toVar();
  x.assign(bitXor(x, shiftRight(x, uint(16))).mul(uint(0x21f0aaad)));
  x.assign(bitXor(x, shiftRight(x, uint(15))).mul(uint(0x735a2d97)));
  return bitXor(x, shiftRight(x, uint(15)));
}

// ═══════════════════════════════════════════════════════════ THE LATTICE

/**
 * Probe spacing at cascade `i`, LOD `lod`: s₀·2^i·2^lod. `cascade` is a JS
 * number (compile-time per kernel); `lod` may be a node.
 *
 * `exp2` rather than a shift so a node LOD works, and exact either way: every
 * value involved is a power of two, which f32 represents exactly.
 */
export function probeSpacing(cascade, lod, spacing0) {
  return float(spacing0).mul(1 << cascade).mul(float(lod).exp2());
}

/**
 * ══ THE TRANSPORT'S THREAD → PIXEL MAP ══════════════════════════════════════
 *
 * SRC's per-pixel passes used to dispatch one thread per gbuffer pixel, which
 * made the transport's cost the SCREEN's size (§12.31). The ray ceiling capped
 * the RAYS by making most of those threads return immediately — and the
 * returning threads turned out to cost real time: a 1.930 ms floor at 499,720
 * px, ~6 ms at the user's 1,599,840, purely to launch threads that compute one
 * modulo and exit (§12.32).
 *
 * So the dispatch shrinks instead. Thread `t` of `transportThreads` handles
 * pixel `t·stride + phase`, with `phase ∈ [0, stride)` rotating per frame, so
 * over `stride` frames every pixel is visited exactly once — into an
 * accumulator built for precisely that (§12.23).
 *
 * `t·stride + phase` and NOT `(t·stride + phase) % pixelCount`: with
 * `stride = floor(pixelCount / threads)` the largest index is
 * `(threads−1)·stride + phase`, which is below `pixelCount` whenever
 * `phase < stride` — so the wrap can only fire when there are MORE threads than
 * pixels, and there it would make two threads share a pixel. Two threads on one
 * pixel is not a wasted thread, it is a DOUBLE DEPOSIT: the pixel's rays get
 * counted twice by [D1] and claimed twice by [D5]. Hence the bound below is a
 * hard skip, never a wrap.
 *
 * @param {Node} thread   `instanceIndex`
 * @param {Node} stride   uniform, ≥ 1
 * @param {Node} phase    uniform, in `[0, stride)`
 * @returns {Node} the gbuffer pixel index this thread owns, as u32
 */
export function transportPixel(thread, stride, phase) {
  return uint(thread).mul(uint(stride)).add(uint(phase));
}

/** Lattice origin for a spacing — the anchor snapped onto that lattice. */
export function latticeOrigin(anchor, spacing) {
  const s = float(spacing).toVar();
  const a = vec3(anchor).toVar();
  return vec3(
    roundHalfUp(a.x.div(s)).mul(s),
    roundHalfUp(a.y.div(s)).mul(s),
    roundHalfUp(a.z.div(s)).mul(s),
  );
}

/** The nearest lattice cell to `p` — the ONE cell a pixel inserts. */
export function nearestCell(p, origin, spacing) {
  const s = float(spacing).toVar();
  const f = vec3(p).sub(vec3(origin)).div(s).toVar();
  return ivec3(
    int(roundHalfUp(f.x)),
    int(roundHalfUp(f.y)),
    int(roundHalfUp(f.z)),
  );
}

/** World position of lattice cell (cx, cy, cz). */
export function cellPosition(cell, origin, spacing) {
  return vec3(origin).add(vec3(ivec3(cell)).mul(float(spacing)));
}

/** Chebyshev (L∞) distance — the LOD metric, not Euclidean (paper §4.1). */
export function chebyshev(a, b) {
  const d = vec3(a).sub(vec3(b)).abs().toVar();
  return d.x.max(d.y).max(d.z);
}

/**
 * FRACTIONAL LOD for a Chebyshev camera distance. Twin of `lodAtDistance`.
 *
 * The `floor` of this picks the shell and the fraction drives the ×0.9-overlap
 * blend, so no consumer sees a hard flip (R1). Note trap 3 in the header: the
 * f32 `log2` puts boundary points within ~1e-6 of an integer, and those may
 * floor either way.
 */
export function lodAtDistance(cheb, spacing0, maxLods = MAX_LODS) {
  // `LOD0_REACH` is a power of two, so `s₀·64` is exact on both sides and the
  // multiply this line introduces cannot make the twins drift — see the
  // constant's own note in srcConfig. The order matters and is the mirror's:
  // scale FIRST, then floor at 1e-6, then divide.
  const ratio = float(cheb).div(float(spacing0).mul(LOD0_REACH).max(1e-6)).toVar();
  return select(
    ratio.greaterThan(1),
    log2(ratio).clamp(0, maxLods - 1),
    float(0),
  );
}

/** The ×0.9-overlap blend weight between shell ⌊lodF⌋ and the next. */
export function lodBlend(lodF) {
  const frac = float(lodF).sub(floor(float(lodF))).toVar();
  return select(
    frac.lessThanEqual(LOD_OVERLAP),
    float(0),
    frac.sub(LOD_OVERLAP).div(1 - LOD_OVERLAP).min(1),
  );
}

/**
 * Cumulative interval boundary of cascade `i` at `lod`:
 * r₀·2^lod·(γ^{i+1} − 1)/(γ − 1). `cascade` is a JS number.
 *
 * Closed form rather than the mirror's accumulate loop, and that is a real
 * difference to be careful about: the loop sums γ^0 + γ^1 + … in f64 while this
 * evaluates the sum in one f32 multiply. They agree to f32 precision, which is
 * all a boundary needs — but a GAP or an OVERLAP between adjacent cascades is
 * light silently dropped or double-counted, so the twin gate checks CONTIGUITY
 * (boundary i of cascade k equals boundary i of cascade k+1's start) rather
 * than just comparing numbers.
 */
export function intervalBoundary(cascade, lod, spacing0) {
  const r0 = float(spacing0).mul(R0_OVER_S0).mul(float(lod).exp2());
  return r0.mul((Math.pow(GAMMA, cascade + 1) - 1) / (GAMMA - 1));
}

/**
 * The cascade owning hit distance `d`, or `cascadeCount` for an escape.
 * Twin of `splitCascade`. `bounds` is an array of NODES, one per cascade.
 *
 * Written as a running sum of "am I past this boundary" rather than a loop with
 * a break: a break in a hot kernel costs more than four compares, and this form
 * has no divergence at all.
 */
export function splitCascade(d, bounds) {
  const dist = float(d).toVar();
  const k = int(0).toVar();
  for (const b of bounds) k.addAssign(int(select(dist.greaterThan(b), 1, 0)));
  return k;
}

// ═══════════════════════════════════════ OCTAHEDRAL — IRRADIANCE TILES ONLY

/** Direction → continuous octahedral texel coords in [0, res). */
export function octahedralUV(d, res) {
  const v = vec3(d).toVar();
  const inv = float(1).div(v.abs().x.add(v.abs().y).add(v.abs().z)).toVar();
  const p = v.xy.mul(inv).toVar();
  const sx = select(p.x.greaterThanEqual(0), float(1), float(-1));
  const sy = select(p.y.greaterThanEqual(0), float(1), float(-1));
  const folded = vec2(
    float(1).sub(p.y.abs()).mul(sx),
    float(1).sub(p.x.abs()).mul(sy),
  ).toVar();
  const f = select(v.z.lessThanEqual(0), folded, p).toVar();
  return f.mul(0.5).add(0.5).mul(res);
}

/** Octahedral texel centre (u, v) in a res×res tile → unit direction. */
export function octahedralDirection(u, v, res) {
  const fx = float(u).add(0.5).div(res).mul(2).sub(1).toVar();
  const fy = float(v).add(0.5).div(res).mul(2).sub(1).toVar();
  const nz = float(1).sub(fx.abs()).sub(fy.abs()).toVar();
  const fold = nz.negate().max(0).toVar();
  const sx = select(fx.greaterThanEqual(0), float(1), float(-1));
  const sy = select(fy.greaterThanEqual(0), float(1), float(-1));
  return vec3(fx.sub(sx.mul(fold)), fy.sub(sy.mul(fold)), nz).normalize();
}

/**
 * RELATIVE solid angle of an octahedral texel: Δω ∝ (|dx|+|dy|+|dz|)³.
 * Only ratios matter (every consumer divides by its own Σ), so the (2/res)²
 * constant is omitted — as in srcMath.js and in the cascadeTrace original this
 * was earned from, where ignoring it put 1.95× position-dependent error into
 * every gather.
 */
export function octahedralTexelWeight(d) {
  const s = vec3(d).abs().toVar();
  const t = s.x.add(s.y).add(s.z).toVar();
  return t.mul(t).mul(t);
}

/**
 * A no-op TSL wrapper, exported only so the twin gate can force each helper
 * into its own WGSL statement and attribute a mismatch to one function rather
 * than to a fused expression the compiler reassociated.
 */
export const isolate = Fn(([v]) => v.toVar());
