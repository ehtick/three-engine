// Octahedral map, TSL side — direction ⇄ texel for square direction tiles.
//
// Extracted verbatim from `cascadeTrace.js` when the dense transport was
// deleted (plan §5). SRC does NOT use octahedral for its ray bins — those are
// the paper's equal-area cylindrical bins (`srcMath.js`) — but it does use
// octahedral for the IRRADIANCE TILES that the screen gather samples, which is
// why §5's keep-list singles this math out while the cascade kernels around it
// go. The CPU mirrors of all four live in `srcMath.js`; the pair is what
// `scripts/run-gi-gather-invariance-test.mjs` arbitrates, so they must keep
// agreeing texel-for-texel.
import { float, floor, max, mod, step, vec2, vec3 } from "three/tsl";

/**
 * Octahedral texel-center direction for a dirIdx in a res×res tile.
 * Branchless lower-hemisphere fold (no If — whole-vector math only).
 */
export function octahedralDirection(dirIdxF, res) {
  const u = mod(dirIdxF, res);
  const v = floor(dirIdxF.div(res));
  const f = vec2(u, v).add(0.5).div(res).mul(2).sub(1);
  const ax = f.x.abs();
  const ay = f.y.abs();
  const nz = float(1).sub(ax).sub(ay);
  const fold = max(nz.negate(), 0);
  const sx = step(0, f.x).mul(2).sub(1);
  const sy = step(0, f.y).mul(2).sub(1);
  const nx = f.x.sub(sx.mul(fold));
  const ny = f.y.sub(sy.mul(fold));
  return vec3(nx, ny, nz).normalize();
}

/**
 * World direction → CONTINUOUS texel-space coords {u, v} in [0, res) of a
 * res×res octahedral tile. Branchless, mirrors the decode's fold exactly.
 */
export function octahedralUV(dir, res) {
  const inv = float(1).div(dir.x.abs().add(dir.y.abs()).add(dir.z.abs()));
  const px = dir.x.mul(inv);
  const py = dir.y.mul(inv);
  const sx = step(0, px).mul(2).sub(1);
  const sy = step(0, py).mul(2).sub(1);
  const foldedX = float(1).sub(py.abs()).mul(sx);
  const foldedY = float(1).sub(px.abs()).mul(sy);
  const inLower = step(dir.z, 0);
  const fx = px.mul(inLower.oneMinus()).add(foldedX.mul(inLower));
  const fy = py.mul(inLower.oneMinus()).add(foldedY.mul(inLower));
  return {
    u: fx.mul(0.5).add(0.5).mul(res),
    v: fy.mul(0.5).add(0.5).mul(res),
  };
}

/**
 * RELATIVE SOLID ANGLE of the octahedral texel a NORMALIZED direction came from.
 *
 * WHY THIS EXISTS. Every gather in this module integrates as
 * `Σ L·cos / Σ cos`, which is a solid-angle-weighted average ONLY if every
 * direction carries the same Δω. The octahedral map's texels do not: measured by
 * integrating the map's Jacobian, they vary **2.73x** in solid angle between the
 * map centre and the diagonal midpoints. So the shipped gather was silently
 * weighting by texel area — the same 30° source read 1.46x analytic at the pole
 * and 0.75x at the map corner, a 1.95x error that depends only on WHERE the
 * light sits, and it did not shrink with direction count (1.89x at 4096
 * directions). It also converged to 1.18x analytic instead of 1.
 *
 * THE WEIGHT. For a parameterization projected onto the sphere,
 * dω = (v · (∂v/∂fx × ∂v/∂fy)) / |v|³. On the upper sheet v = (fx, fy,
 * 1−|fx|−|fy|), the cross product is (sign fx, sign fy, 1), and their dot is
 * identically 1 — so dω ∝ 1/|v|³, with |v| taken BEFORE normalization.
 *
 * AND IT IS FREE. That needs the unnormalized vector, which the decode throws
 * away — but the map places it on the octahedron |x|+|y|+|z| = 1 (upper sheet:
 * |fx|+|fy|+(1−|fx|−|fy|) = 1; the folded lower sheet too, e.g. f = (0.8, 0.8)
 * → v = (0.2, 0.2, −0.6)). So |v| = 1/(|dx|+|dy|+|dz|) for a normalized d, and
 *
 *     Δω ∝ (|dx| + |dy| + |dz|)³
 *
 * three abs, two adds, two muls, on a value the gather loop already holds. The
 * identity is asserted exactly (< 1e-9) against the Jacobian form in
 * `scripts/run-gi-gather-invariance-test.mjs`.
 *
 * Only RATIOS matter — every consumer divides by its own Σ of these — so the
 * missing constant (2/res)² is deliberately omitted.
 */
export function octahedralTexelWeight(dir) {
  const s = dir.x.abs().add(dir.y.abs()).add(dir.z.abs());
  return s.mul(s).mul(s);
}

/**
 * Inverse of octahedralDirection: world direction → texel index (float) in a
 * res×res octahedral tile (nearest texel).
 */
export function octahedralTexelIndex(dir, res) {
  const { u, v } = octahedralUV(dir, res);
  const ui = u.floor().clamp(0, res - 1);
  const vi = v.floor().clamp(0, res - 1);
  return vi.mul(res).add(ui);
}
