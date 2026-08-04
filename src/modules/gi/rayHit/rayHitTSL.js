// Node-graph mirrors of RayHitPacking's octahedral normal codec. Pure
// expression helpers — no buffers, no uniforms, no Fn instances — so they can
// be stamped inside any build kernel or shared trace function without touching
// the caller's binding budget or the giFn per-builder cache.
//
// Quantization to/from the 16-bit storage halves is NOT here: the shaders use
// WGSL's own pack2x16snorm/unpack2x16snorm (TSL packSnorm2x16/unpackSnorm2x16),
// which implement exactly RayHitPacking's packSnorm16 contract
// (round(clamp(v,-1,1)*32767), sign-preserving).
import { float, select, vec2, vec3 } from "three/tsl";

const signNotZero = (v) => select(v.lessThan(0), float(-1), float(1));

/** Unit (or near-unit) vec3 → octahedral vec2 in [-1, 1]^2. */
export function octEncodeTSL(normal) {
  const n = vec3(normal).toVar();
  const inverseL1 = float(1).div(n.x.abs().add(n.y.abs()).add(n.z.abs()).max(1e-12)).toVar();
  const x = n.x.mul(inverseL1).toVar();
  const y = n.y.mul(inverseL1).toVar();
  const lowerX = float(1).sub(y.abs()).mul(signNotZero(x));
  const lowerY = float(1).sub(x.abs()).mul(signNotZero(y));
  const lower = n.z.lessThan(0);
  return vec2(select(lower, lowerX, x), select(lower, lowerY, y));
}

/** Octahedral vec2 → normalized vec3. Inverse of octEncodeTSL. */
export function octDecodeTSL(encoded) {
  const e = vec2(encoded).toVar();
  const z = float(1).sub(e.x.abs()).sub(e.y.abs()).toVar();
  const lower = z.lessThan(0);
  const lowerX = float(1).sub(e.y.abs()).mul(signNotZero(e.x));
  const lowerY = float(1).sub(e.x.abs()).mul(signNotZero(e.y));
  return vec3(select(lower, lowerX, e.x), select(lower, lowerY, e.y), z).normalize();
}
