// SPLIT RADIANCE CASCADES — the shape of the cascade hierarchy.
//
// docs/GI_SRC_REBUILD_PLAN.md §2 / §4. Pure JS, no three, no TSL: every
// consumer (CPU reference, GPU kernels, telemetry, tests) derives its numbers
// from HERE so there is exactly one definition of the hierarchy. A second
// place that computes an interval boundary is a leak waiting to be measured.
//
// ══ THE TWO SCALING FACTORS ══════════════════════════════════════════════════
//
// β = 4  angular branching: |D_{i+1}| = 4·|D_i|, and the 4→1 parent mapping is
//        integer halving on the 2w×w bin grid (srcMath.binParent).
// γ = 4  interval scaling:  L_{i+1} = 4·L_i.
//
// BOTH, simultaneously — that is the paper's core theoretical claim (§3.2,
// Appendix A): the estimator minimizes `max(spatial error α, angular error ε)`
// only when ε scales WITH α. γ=2 lets angular error dominate the far cascades.
//
// This module previously ran BRANCH=2, and BRANCH=4 was rejected twice (see
// the plan's §11 decision log). Those rejections were measured on the DENSE
// LATTICE with the parallax merge kernel at c0DirRes 2–4 — a regime where
// angular resolution could not be raised to compensate. The merge here is
// count-weighted sparse with pre-averaging and no parallax re-aim, which is a
// different estimator; the falloff/chroma probes that produced the original
// rejections re-gate this one. If γ=4 fails them HERE that is a real finding
// to take upstream, not a config to quietly fudge.
//
// ══ SPACING vs INTERVAL — the one spatial dial ═══════════════════════════════
//
// `spacing0` (s₀) is THE live spatial dial (session-36 lesson: one dial, not
// a family of interacting ones). r₀ is DERIVED from it at a fixed ratio, so a
// user dragging spacing never desynchronizes the two.

/** Angular branching factor — bins ×4 per cascade. */
export const BETA = 4;
/** Interval scaling factor — interval length ×4 per cascade. */
export const GAMMA = 4;

/**
 * Cascade count. With γ=4 the reach is r₀·(4^N − 1)/3, so N=4 covers
 * ~85·r₀ — a scene — and everything past it is sky. Raising N does not
 * improve a scene's transport, it just moves the sky boundary further out,
 * which is why `cascadeCount` is retired as a user prop (plan §6).
 */
export const CASCADE_COUNT = 4;

/**
 * c0 direction-bin grid width. Bins live on a 2w×w equal-area cylindrical
 * grid, so |D_i| = 2·w_i². w₀=4 → |D₀| = 32, the paper's reference config.
 */
export const W0 = 4;

/** r₀ / s₀. Paper §7 reference configuration: r₀ ≈ 1.6·s₀. */
export const R0_OVER_S0 = 1.6;

/**
 * Maximum LOD count. The 32-bit probe key spends 4 bits on LOD and stores
 * LOD+1 (so a packed key can never be zero — zero is the hashmap's EMPTY
 * sentinel), which leaves 15 usable LODs. The plan clamps selection to
 * MAX_LODS; 10 is already 1024·s₀ of reach.
 */
export const MAX_LODS = 10;
/** Hard ceiling imposed by the key layout — MAX_LODS may not exceed it. */
export const KEY_MAX_LODS = 15;

/**
 * LOD interval-start shortening (paper §4.1). Each LOD's interval starts at
 * 0.9× where it otherwise would, so adjacent LODs OVERLAP and shading can
 * blend linearly across the overlap instead of switching. R1 (no binary
 * anything) is why this is not optional.
 */
export const LOD_OVERLAP = 0.9;

/** Per-probe octahedral irradiance tile: 6×6 interior + 1-texel border. */
export const IRRADIANCE_TILE_INTERIOR = 6;
export const IRRADIANCE_TILE_BORDER = 1;
export const IRRADIANCE_TILE_SIZE =
  IRRADIANCE_TILE_INTERIOR + 2 * IRRADIANCE_TILE_BORDER; // 8

/**
 * Secondary (multibounce) probe cache sits this many LODs coarser than the
 * primary probes that spawned it (paper §6). No third-bounce cache exists —
 * the secondary cache samples ITSELF temporally, which is what makes the
 * bounce count effectively infinite at one cache's cost.
 */
export const SECONDARY_LOD_OFFSET = 2;

/**
 * Temporal blend rates (plan §4.6). `FRESH` is the fast-α warmup path for a
 * probe younger than FRESH_FRAMES — R6: an EMA smooths VALUES, not
 * MEMBERSHIP, so a newborn probe must not crawl up from zero.
 */
export const ALPHA_STEADY = 0.1;
export const ALPHA_FRESH = 0.3;
export const FRESH_FRAMES = 8;

/** Frames a probe survives unseen before the per-frame rebuild stops re-inserting it. */
export const PROBE_MAX_AGE = 60;

/**
 * Albedo ceiling inside the bounce loop. R4: the secondary cache is a temporal
 * fixed-point iteration, so its in-loop gain must be provably < 1. Artistic
 * gain belongs OUTSIDE the loop (the `intensity` prop), never here.
 */
export const MAX_LOOP_ALBEDO = 0.9;

/**
 * Quality tiers. Unlike the dense backend's tiers these scale s₀, rays/pixel
 * and w₀ — NOT a world volume, because SRC has no volume to scale. Memory is
 * screen-proportional by construction (plan §4.2).
 *
 * `spacing0` is metres at LOD 0. `raysPerPixel` counts full-length rays per
 * half-res gbuffer pixel. `w0` raises c0 angular resolution on the top tiers.
 */
export const SRC_QUALITY = {
  low: { spacing0: 0.8, raysPerPixel: 1, w0: 4, secondary: false },
  medium: { spacing0: 0.6, raysPerPixel: 1, w0: 4, secondary: true },
  high: { spacing0: 0.45, raysPerPixel: 2, w0: 4, secondary: true },
  ultra: { spacing0: 0.35, raysPerPixel: 2, w0: 8, secondary: true },
};
const QUALITY_TIERS = new Set(Object.keys(SRC_QUALITY));

/**
 * The tier a preset name selects for. "custom" means "the preset name no
 * longer implies values", not "no tier" — every table lookup still needs one,
 * and "high" is both the least surprising choice and the component's own
 * zero-setup default. Same contract as the dense backend's `qualityTierOf`,
 * deliberately, so the Inspector's flipsToCustom behaviour is unchanged.
 */
export function srcQualityTier(props) {
  const quality = props?.quality;
  return QUALITY_TIERS.has(quality) ? quality : "high";
}

/**
 * Direction-bin grid width at cascade `i`: w_i = w₀·2^i, so |D_i| = 2·w_i².
 * The grid is 2w wide (azimuth) by w tall (the equal-area z band).
 */
export function binGridWidth(cascade, w0 = W0) {
  return w0 * (1 << cascade);
}

/** Direction-bin count at cascade `i` — 2·w_i². */
export function binCount(cascade, w0 = W0) {
  const w = binGridWidth(cascade, w0);
  return 2 * w * w;
}

/**
 * Probe spacing at cascade `i`, LOD `lod`: s₀·2^i·2^lod.
 *
 * Spacing doubles per cascade (probes ÷4 on a 2D surface manifold, which is
 * what keeps per-cascade BIN totals near constant against bins ×4) and
 * doubles again per LOD, which is the whole open-world mechanism.
 */
export function probeSpacing(cascade, lod, spacing0) {
  return spacing0 * (1 << cascade) * (1 << lod);
}

/**
 * Interval LENGTH of cascade `i` at `lod`: r₀·γ^i, scaled by the LOD's own
 * doubling of r₀.
 */
export function intervalLength(cascade, lod, spacing0) {
  const r0 = spacing0 * R0_OVER_S0 * (1 << lod);
  return r0 * Math.pow(GAMMA, cascade);
}

/**
 * Cumulative interval boundaries at `lod`: the array `[r_0, r_1, ... r_{N-1}]`
 * where cascade i owns hit distances in (r_{i-1}, r_i], r_{-1} = 0.
 *
 * Contiguous by construction — r_i = r₀·(γ^{i+1} − 1)/(γ − 1) — because a GAP
 * between intervals is a distance band no cascade owns, i.e. light that is
 * silently dropped, and an OVERLAP double-counts it. The furnace test in the
 * Phase-0 suite exists to prove there is neither.
 */
export function intervalBoundaries(lod, spacing0, cascadeCount = CASCADE_COUNT) {
  const r0 = spacing0 * R0_OVER_S0 * (1 << lod);
  const out = new Array(cascadeCount);
  let acc = 0;
  for (let i = 0; i < cascadeCount; i++) {
    acc += r0 * Math.pow(GAMMA, i);
    out[i] = acc;
  }
  return out;
}

/** Total reach at `lod` — past this a ray composites sky. */
export function cascadeReach(lod, spacing0, cascadeCount = CASCADE_COUNT) {
  const bounds = intervalBoundaries(lod, spacing0, cascadeCount);
  return bounds[bounds.length - 1];
}

/**
 * LOD for a world point, from the CHEBYSHEV distance to the camera (paper
 * §4.1 — Chebyshev, not Euclidean: with grid-aligned probes the L∞ ball's
 * flat faces put LOD boundaries parallel to the probe planes, which produces
 * far fewer transition artifacts than a sphere cutting them diagonally).
 *
 * Returns a FRACTIONAL lod. The integer part selects the shell; the fraction
 * is what the ×0.9-overlap blend consumes at shading time, so no caller ever
 * sees a hard flip (R1).
 */
export function lodAtDistance(cheb, spacing0, maxLods = MAX_LODS) {
  const ratio = cheb / Math.max(spacing0, 1e-6);
  if (!(ratio > 1)) return 0;
  const lod = Math.log2(ratio);
  return Math.min(Math.max(lod, 0), maxLods - 1);
}

/** Chebyshev (L∞) distance — the LOD metric. */
export function chebyshev(ax, ay, az, bx, by, bz) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

/**
 * The blend weight between LOD `floor(lodF)` and `floor(lodF)+1` across the
 * ×0.9 overlap band. 0 = wholly the coarser-shell side is unused; 1 = wholly
 * the next LOD. Linear inside the band, saturated outside it, and CONTINUOUS
 * at both ends — the property that makes a fly-through not pop.
 */
export function lodBlend(lodF) {
  const frac = lodF - Math.floor(lodF);
  // The overlap occupies the top (1 − LOD_OVERLAP) of each LOD's span.
  const start = LOD_OVERLAP;
  if (frac <= start) return 0;
  return Math.min(1, (frac - start) / (1 - start));
}

/**
 * The SHELLS a world point samples, with weights summing to 1 — the form every
 * consumer should use, and the one whose continuity actually matters.
 *
 * `lodBlend` alone is deliberately DISCONTINUOUS at integer lodF (it ramps to 1
 * just below the boundary, then restarts at 0 just above), and reading that as
 * a popping risk is a mistake worth naming: just below lodF=1 the pair is
 * {LOD0: 0, LOD1: 1} and just above it is {LOD1: 1} — the same shell at the
 * same weight. The jump is in the *parameterization*, not in the result.
 *
 * So the invariant to hold — and the one the Phase-0 suite measures — is that
 * the weight this function assigns to any FIXED integer LOD is continuous in
 * lodF. That is what a fly-through actually samples, and testing `lodBlend`
 * instead measures an artifact of how the blend is written down.
 */
export function lodShells(lodF, maxLods = MAX_LODS) {
  const base = Math.min(Math.floor(lodF), maxLods - 1);
  const blend = lodBlend(lodF);
  if (!(blend > 0) || base + 1 >= maxLods) return [{ lod: base, weight: 1 }];
  return [
    { lod: base, weight: 1 - blend },
    { lod: base + 1, weight: blend },
  ];
}

/** Weight `lodShells` gives to one specific integer LOD. Continuity instrument. */
export function lodShellWeight(lodF, lod, maxLods = MAX_LODS) {
  for (const shell of lodShells(lodF, maxLods)) {
    if (shell.lod === lod) return shell.weight;
  }
  return 0;
}

/**
 * Resolved hierarchy description — what the GPU side uploads as uniforms and
 * what telemetry prints. `bounds` is per-LOD because r₀ doubles with LOD.
 */
export function describeSrcHierarchy(spacing0, w0 = W0, cascadeCount = CASCADE_COUNT) {
  const cascades = [];
  for (let i = 0; i < cascadeCount; i++) {
    cascades.push({
      cascade: i,
      binGrid: [2 * binGridWidth(i, w0), binGridWidth(i, w0)],
      bins: binCount(i, w0),
      spacingLod0: probeSpacing(i, 0, spacing0),
      intervalLod0: intervalLength(i, 0, spacing0),
    });
  }
  return {
    beta: BETA,
    gamma: GAMMA,
    cascadeCount,
    w0,
    spacing0,
    r0: spacing0 * R0_OVER_S0,
    reachLod0: cascadeReach(0, spacing0, cascadeCount),
    boundariesLod0: intervalBoundaries(0, spacing0, cascadeCount),
    cascades,
  };
}
