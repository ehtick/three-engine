// GI → material injection (Phase 6).
//
// The engine has no prior custom-light convention, so this creates one the
// same way three wires its own lights: a Light subclass paired with an
// AnalyticLightNode via `renderer.library.addLight(nodeClass, lightClass)`.
// The node's setup does `context.irradiance.addAssign(...)` — exactly what
// three's AmbientLightNode does — so every lit material in the scene
// receives the cascade irradiance with zero per-material changes, and
// three's lights-hash mechanism recompiles materials automatically when the
// light instance is added/replaced.
//
// The irradiance expression is createIrradianceGather()'s canonical sampler
// (shared with the debug gizmos) evaluated at the fragment: sample point is
// normal-offset off the surface (same leak control as the Phase 4 harness),
// direction is the shading normal (normal maps included).
import * as THREE from "three/webgpu";
import {
  If,
  abs,
  acos,
  cameraPosition,
  float,
  materialRoughness,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  screenUV,
  select,
  smoothstep,
  step,
  cross,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { sharedFn } from "./giFn.js";

// Fixed emitter slot count: slots are compiled into the material shader, so
// a constant count means emitter add/remove within the budget needs no
// material recompile (unused slots have radius 0 → zero contribution).
// 4, not 2 — real scenes routinely have 3+ lamps (one per room half); a
// demoted lamp keeps only its baked emissive shell, which reads as "this
// light basically stopped working".
export const MAX_EMITTERS = 4;

// COMPILE-TIME roughness gates (per material): the mirror trace + hit
// lighting block is ~70% of a material's GI shader compile cost
// (harness-measured: a 26-material rebuild wave dropped 24s → 7.6s without
// it), yet its runtime gate `smoothstep(0.45, 0.15, roughness)` is zero for
// every material whose STATIC roughness exceeds MIRROR_MAX — so those
// materials simply don't compile the block. Likewise, above SPECULAR_MAX
// the roughness collapse discards the whole directional path, so fully
// rough materials (walls, floors) compile only the diffuse limit.
// Materials with a roughness map/node stay on the full path, and GISystem
// recompiles a material whose static roughness crosses a gate.
export const GI_MIRROR_ROUGHNESS_MAX = 0.45;
export const GI_SPECULAR_ROUGHNESS_MAX = 0.6;

/**
 * The compile-time roughness bucket of a material: 0 = mirror path,
 * 1 = directional-only, 2 = diffuse-only, 3 = dynamic roughness (full path).
 * Derived from LIVE material state — used by BOTH the light node's setup
 * (what code gets generated) and the material cache-key override GISystem
 * installs (what key that code is stored under). They must never disagree:
 * three's material cache key reduces every numeric property to on/off, so
 * without the override, roughness 0.2 and 0.9 materials of the same
 * structure hash identically and steal each other's shaders (harness-proven
 * — mirror materials rendering with the diffuse-only build).
 */
export function giRoughnessBucketOf(material) {
  if (!material) return 3;
  if (material.roughnessMap) return 3;
  const r = staticRoughnessOf(material);
  if (r === null) return 3;
  return r <= GI_MIRROR_ROUGHNESS_MAX ? 0 : r < GI_SPECULAR_ROUGHNESS_MAX ? 1 : 2;
}

/**
 * The material's roughness as a compile-time CONSTANT, or null when it can
 * only be known per pixel.
 *
 * CRITICAL for real projects: the presence of `roughnessNode` used to mean
 * "dynamic" outright, but the engine's own material pipeline assigns one to
 * EVERY material it builds (shaderGraph's principled/glass/diffuse BSDF cases
 * set `roughnessNode: float(<slider value>)`, tslGraph sets `float(1)`), so
 * every editor-authored material landed in bucket 3 — the full mirror + hit
 * lighting path, the ~70% of GI compile cost the buckets exist to avoid, on
 * walls and floors. Only harness scenes (plain materials with a numeric
 * `.roughness`) ever took the fast path, which is why harness waves measured
 * a fraction of the real editor's startup. A constant node carries a constant
 * value, so read through it.
 */
function staticRoughnessOf(material) {
  const node = material.roughnessNode;
  if (node == null) return material.roughness ?? 1;
  // `float(0.7)` is NOT a bare ConstNode: TSL returns nodeObjectIntent(...) =
  // a VarNode wrapping the ConstNode (auto-var intent), so the value only
  // shows up after unwrapping single-child wrappers (VarNode/ConvertNode all
  // expose `.node`). Bounded walk — anything else (a texture sample, a math
  // expression) is genuinely per-pixel and stays dynamic.
  let n = node;
  for (let depth = 0; depth < 8 && n; depth++) {
    if (n.isConstNode || n.isUniformNode) {
      // Uniforms are readable but mutable — GISystem's #refreshMirrorBucket
      // re-derives the bucket on its scan cadence and recompiles a material
      // whose value crossed a gate, the same healing path a `.roughness`
      // edit takes.
      return typeof n.value === "number" ? n.value : null;
    }
    n = n.node ?? null;
  }
  return null;
}

/**
 * Horizon-aware sphere-light irradiance: E = color · π·sinR² · factor.
 * factor equals cosθ while the whole sphere sits above the receiver's
 * horizon (cosθ ≥ sinR), and Hermite-fades through the partial-visibility
 * band (|cosθ| < sinR) instead of dying with cosθ. The pure cosθ-to-center
 * model gave a lamp RESTING ON the floor E ≈ 0 for every floor receiver —
 * the top half of the sphere is fully visible, yet the floor rendered
 * black with a razor tonemap edge at the lamp ("sharp circle" report).
 * Continuous at the crossover: factor(sinR) = sinR both ways.
 */
export function sphereLightFactor(cosTheta, sinR) {
  const t = cosTheta.add(sinR).div(sinR.mul(2).max(1e-4)).clamp(0, 1);
  const horizon = sinR.mul(t).mul(t);
  return mix(horizon, cosTheta, step(sinR, cosTheta));
}

/**
 * Exact Lambert form factor of an ORIENTED-BOX area light: E = radiance · F,
 * F ∈ [0, π]. Each receiver-facing face is integrated with the classic
 * contour formula for a diffuse polygon (Baum et al.): Σ over edges of
 * acos(u_i·u_j) · (normalize(u_i×u_j) · N), halved. This is what makes an
 * emissive CUBE light its surroundings like a cube — the sphere model gave
 * every emitter circular iso-lux contours and a round "reflection", which
 * users read as "my box lamp reflects as a sphere". Exact for unoccluded
 * faces; the part of a face below the receiver's horizon integrates
 * negatively (an under-estimate, smooth), so each face clamps at zero
 * rather than paying for true horizon clipping.
 *
 * Also exact for PLANES (a box with one zero half-extent: the degenerate
 * face pair has zero area and the facing check culls the back face), which
 * turns emissive panels into real area lights.
 */
export const boxLightFactor = sharedFn({
  name: "giBoxLightFactor",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "N", type: "vec3" },
    { name: "center", type: "vec3" },
    { name: "halfExt", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, N, center, halfExt, bx, by, bz) => {
    const F = float(0).toVar();
    // (outward axis, half along it, in-plane u·halfU, in-plane v·halfV) with
    // u×v = outward for every face of the right-handed basis.
    const faces = [
      [bx, halfExt.x, by.mul(halfExt.y), bz.mul(halfExt.z)],
      [bx.negate(), halfExt.x, bz.mul(halfExt.z), by.mul(halfExt.y)],
      [by, halfExt.y, bz.mul(halfExt.z), bx.mul(halfExt.x)],
      [by.negate(), halfExt.y, bx.mul(halfExt.x), bz.mul(halfExt.z)],
      [bz, halfExt.z, bx.mul(halfExt.x), by.mul(halfExt.y)],
      [bz.negate(), halfExt.z, by.mul(halfExt.y), bx.mul(halfExt.x)],
    ];
    for (const [w, hw, eu, ev] of faces) {
      const faceCenter = center.add(w.mul(hw)).toVar();
      // Only faces whose outward normal points at the receiver emit toward it.
      If(P.sub(faceCenter).dot(w).greaterThan(1e-4), () => {
        // Winding chosen so the contour sum is POSITIVE for a receiver the
        // face shines on (verified against the closed-form square patch).
        const u0 = faceCenter.add(eu).add(ev).sub(P).normalize().toVar();
        const u1 = faceCenter.add(eu).sub(ev).sub(P).normalize().toVar();
        const u2 = faceCenter.sub(eu).sub(ev).sub(P).normalize().toVar();
        const u3 = faceCenter.sub(eu).add(ev).sub(P).normalize().toVar();
        const edge = (a, b) => {
          const c = cross(a, b);
          return acos(a.dot(b).clamp(-1, 1)).mul(c.div(c.length().max(1e-6)).dot(N));
        };
        const faceSum = edge(u0, u1).add(edge(u1, u2)).add(edge(u2, u3)).add(edge(u3, u0)).mul(0.5);
        F.addAssign(faceSum.max(0));
      });
    }
    return F;
  },
});

/**
 * Angular miss distance (≈ sine of the angle) between a reflection ray and
 * an oriented box's silhouette: 0 when the ray hits the box, growing with
 * how far it passes by. The specular glow shapes its highlight with this,
 * so a box emitter's reflection IS a box (a rotated cube reads as a rotated
 * cube), where the sphere cone test drew a disc for every emitter.
 * Evaluated at the ray's closest approach to the box center — exact inside
 * the silhouette, slightly loose at grazing corners, which only softens the
 * rim by a pixel or two.
 */
export const boxGlowMiss = sharedFn({
  name: "giBoxGlowMiss",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "R", type: "vec3" },
    { name: "center", type: "vec3" },
    { name: "halfExt", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, R, center, halfExt, bx, by, bz) => {
    const rel = P.sub(center);
    const ro = vec3(rel.dot(bx), rel.dot(by), rel.dot(bz)).toVar();
    const rd = vec3(R.dot(bx), R.dot(by), R.dot(bz)).toVar();
    const tStar = ro.negate().dot(rd).clamp(0.05, 1e5).toVar();
    const p = ro.add(rd.mul(tStar));
    const q = p.abs().sub(halfExt).max(0);
    return q.length().div(tStar);
  },
});

/**
 * Distance along `dir` (unit, from P) at which the ray ENTERS the oriented
 * box — the slab test's tNear. Replaces `dist − boundingRadius` as the
 * shadow-ray cap for box emitters: the bounding sphere of an elongated box
 * stopped the ray well short of the face, so geometry hugging a big lamp
 * never occluded it.
 */
export const boxRayEnter = sharedFn({
  name: "giBoxRayEnter",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "dir", type: "vec3" },
    { name: "center", type: "vec3" },
    { name: "halfExt", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, dir, center, halfExt, bx, by, bz) => {
    const rel = P.sub(center);
    const ro = vec3(rel.dot(bx), rel.dot(by), rel.dot(bz));
    const rd = vec3(dir.dot(bx), dir.dot(by), dir.dot(bz));
    // Slab-parallel components get a large finite stand-in — WGSL's 1/0 is
    // indeterminate, not a portable +inf.
    const safe = (c) => select(c.greaterThanEqual(0), c.max(1e-6), c.min(-1e-6));
    const inv = vec3(float(1).div(safe(rd.x)), float(1).div(safe(rd.y)), float(1).div(safe(rd.z))).toVar();
    const t1 = halfExt.negate().sub(ro).mul(inv);
    const t2 = halfExt.sub(ro).mul(inv);
    const tmin = t1.min(t2);
    return tmin.x.max(tmin.y).max(tmin.z);
  },
});

// ---------------------------------------------------------------------------
// SHAPED EMITTERS (2026-08-08). Kinds beyond sphere/box — capsule (2),
// cylinder (3), frustum/cone (4), disc/ring (5), torus (6) — so a lamp made
// from ANY default three.js geometry lights, shadows and reflects as ITSELF
// instead of as its bounding box. Every body below is the expression-for-
// expression twin of a scalar reference in emitterShapes.js, and THAT file is
// arbitrated against Monte-Carlo surface integration by
// scripts/run-gi-emitter-shapes-test.mjs — change them TOGETHER or the same
// lamp disagrees with itself across the receiver/feedback/reflection paths.
// Slot `half` semantics per kind are documented at emitterShapes.js's header.

/**
 * Tube-side factor: the lateral surface of a capsule/cylinder/frustum as a
 * diffuse LINE of width 2·r(u) (energy-exact; near-field bound MC-measured).
 * The receiver-horizon clip is EXACT — the horizon condition is linear in
 * the axis parameter, so it clips the integration interval, where the box
 * path can only clamp per face.
 */
const tubeSideFactor = sharedFn({
  name: "giTubeSideFactor",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "N", type: "vec3" },
    { name: "A", type: "vec3" },
    { name: "B", type: "vec3" },
    { name: "ra", type: "float" },
    { name: "rb", type: "float" },
  ],
  body: (P, N, A, B, ra, rb) => {
    const Lv = B.sub(A).toVar();
    const segLen = Lv.length().max(1e-6).toVar();
    const lHat = Lv.div(segLen).toVar();
    const rel = P.sub(A).toVar();
    const tFoot = rel.dot(lHat).toVar();
    const perp = rel.sub(lHat.mul(tFoot)).toVar();
    const hRaw = perp.length().toVar();
    // atan(u/h) cancellation guard (mirrors the scalar reference).
    const h = hRaw.max(segLen.mul(1e-3)).max(1e-5).toVar();
    const cHat = perp.div(hRaw.max(1e-9)).negate().toVar();
    const Cn = cHat.dot(N).toVar();
    const Ln = lHat.dot(N).toVar();
    const u0r = tFoot.negate().toVar();
    const u1r = segLen.sub(tFoot).toVar();
    // Exact horizon clip: keep u where h·Cn + u·Ln > 0.
    const uH = h.mul(Cn).negate().div(select(Ln.abs().greaterThan(1e-6), Ln, float(1))).toVar();
    const u0 = select(Ln.greaterThan(1e-6), u0r.max(uH), u0r).toVar();
    const u1 = select(Ln.lessThan(-1e-6), u1r.min(uH), u1r).toVar();
    // Axis ⊥ receiver normal AND receiver below the line's plane → nothing.
    const parallelGate = select(Ln.abs().greaterThan(1e-6), float(1), step(0, Cn));
    const s = rb.sub(ra).div(segLen).toVar();
    const raP = ra.add(s.mul(tFoot)).toVar(); // r(u) = raP + s·u
    const evalA = (u) => u.div(h.mul(h).add(u.mul(u)).mul(2)).add(u.div(h).atan().div(h.mul(2)));
    const evalB = (u) => float(-1).div(h.mul(h).add(u.mul(u)).mul(2));
    const evalC = (u) => u.negate().div(h.mul(h).add(u.mul(u)).mul(2)).add(u.div(h).atan().div(h.mul(2)));
    const dA = evalA(u1).sub(evalA(u0));
    const dB = evalB(u1).sub(evalB(u0));
    const dC = evalC(u1).sub(evalC(u0));
    const F = raP.mul(Cn).mul(dA)
      .add(raP.mul(Ln).add(s.mul(h).mul(Cn)).mul(h).mul(dB))
      .add(s.mul(Ln).mul(h).mul(dC))
      .mul(2);
    return F.max(0)
      .mul(step(u0, u1))
      .mul(parallelGate)
      .mul(step(1e-9, hRaw));
  },
});

/**
 * One disc's factor via its exact vector irradiance (V_ax toward the plane,
 * V_rad toward the axis — derivation in emitterShapes.js). `rI` > 0 makes it
 * a ring (exact by linearity), `twoSided` 1 flips the face to the receiver.
 */
const discFactor = sharedFn({
  name: "giDiscFactor",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "N", type: "vec3" },
    { name: "C", type: "vec3" },
    { name: "axisIn", type: "vec3" },
    { name: "rO", type: "float" },
    { name: "rI", type: "float" },
    { name: "twoSided", type: "float" },
  ],
  body: (P, N, C, axisIn, rO, rI, twoSided) => {
    const rel = P.sub(C).toVar();
    const Hs = rel.dot(axisIn).toVar();
    const flip = select(twoSided.greaterThan(0.5).and(Hs.lessThan(0)), float(-1), float(1)).toVar();
    const axis = axisIn.mul(flip).toVar();
    const H = Hs.mul(flip).toVar();
    const inPlane = rel.sub(axis.mul(H)).toVar();
    const rho = inPlane.length().toVar();
    const mHat = inPlane.div(rho.max(1e-9)).toVar();
    const rhoS = rho.max(1e-5).toVar();
    const one = (r) => {
      const X = r.mul(r).add(rhoS.mul(rhoS)).add(H.mul(H)).toVar();
      const Q = X.mul(X).sub(r.mul(r).mul(rhoS).mul(rhoS).mul(4)).max(1e-12).sqrt().toVar();
      const vAx = float(Math.PI / 2).mul(float(1).sub(H.mul(H).add(rhoS.mul(rhoS)).sub(r.mul(r)).div(Q)));
      const vRad = float(Math.PI / 2).mul(H).mul(float(1).sub(X.div(Q)).div(rhoS));
      const gate = step(1e-6, r);
      return { vAx: vAx.mul(gate), vRad: vRad.mul(gate) };
    };
    const outer = one(rO);
    const inner = one(rI);
    const vAx = outer.vAx.sub(inner.vAx);
    const vRad = outer.vRad.sub(inner.vRad);
    const F = vAx.mul(axis.dot(N).negate()).add(vRad.mul(mHat.dot(N)));
    return F.max(0).mul(step(1e-5, H));
  },
});

/**
 * Shortest distance between segments [p,q] and [a,b] — the torus model's
 * self-occlusion oracle. Twin of emitterShapes.js segSegDistance, with the
 * branch cascade expressed as selects.
 */
const segSegDist = sharedFn({
  name: "giSegSegDist",
  type: "float",
  inputs: [
    { name: "p", type: "vec3" },
    { name: "q", type: "vec3" },
    { name: "a", type: "vec3" },
    { name: "b", type: "vec3" },
  ],
  body: (p, q, a, b) => {
    const d1 = q.sub(p).toVar();
    const d2 = b.sub(a).toVar();
    const r = p.sub(a).toVar();
    const A = d1.dot(d1).toVar();
    const E = d2.dot(d2).toVar();
    const Fv = d2.dot(r).toVar();
    const Cv = d1.dot(r).toVar();
    const Bv = d1.dot(d2).toVar();
    const denom = A.mul(E).sub(Bv.mul(Bv)).toVar();
    const s0 = select(denom.greaterThan(1e-12), Bv.mul(Fv).sub(Cv.mul(E)).div(denom), float(0)).clamp(0, 1).toVar();
    const tRaw = Bv.mul(s0).add(Fv).div(E.max(1e-12)).toVar();
    const t = tRaw.clamp(0, 1).toVar();
    // Re-clamp s against the clamped t (one Gauss-Seidel pass — what the
    // scalar cascade does through its if/else chain).
    const s = Bv.mul(t).sub(Cv).div(A.max(1e-12)).clamp(0, 1).toVar();
    const c1 = p.add(d1.mul(s));
    const c2 = a.add(d2.mul(t));
    return c1.sub(c2).length();
  },
});

/** Capsule caps: ½(1+cosχ) of a full sphere each (exact far field). */
function capsuleFactorTSL(P, N, center, by, half) {
  const axis = vec3(by).toVar();
  const hl = half.y.toVar();
  const r = half.x.toVar();
  const A = vec3(center).sub(axis.mul(hl)).toVar();
  const B = vec3(center).add(axis.mul(hl)).toVar();
  const side = tubeSideFactor(P, N, A, B, r, r);
  const capF = (capC, outwardSign) => {
    const relC = P.sub(capC).toVar();
    const dC = relC.length().max(1e-3).toVar();
    const cosChi = relC.div(dC).dot(axis.mul(outwardSign));
    const w = cosChi.add(1).mul(0.5);
    const sinRC = r.div(dC).clamp(0, 1).toVar();
    const cosTC = capC.sub(P).div(dC).dot(N);
    return float(Math.PI).mul(sinRC).mul(sinRC).mul(sphereLightFactor(cosTC, sinRC)).mul(w);
  };
  return side.add(capF(A, -1)).add(capF(B, 1)).min(Math.PI);
}

/** Cylinder: tube side + two one-sided disc caps. */
function cylinderFactorTSL(P, N, center, by, half) {
  const axis = vec3(by).toVar();
  const hl = half.y.toVar();
  const r = half.x.toVar();
  const A = vec3(center).sub(axis.mul(hl)).toVar();
  const B = vec3(center).add(axis.mul(hl)).toVar();
  const side = tubeSideFactor(P, N, A, B, r, r);
  const capA = discFactor(P, N, A, axis.negate(), r, float(0), float(0));
  const capB = discFactor(P, N, B, axis, r, float(0), float(0));
  return side.add(capA).add(capB).min(Math.PI);
}

/**
 * Frustum/cone: linear-radius tube side + caps with the silhouette-overlap
 * correction on the WIDE end (subtract half its ring when facing, add the
 * mirrored half-ring when backfacing — branchless via the one-sided/two-sided
 * ring pair; full derivation at emitterShapes.js refFrustumFactor).
 */
function frustumFactorTSL(P, N, center, by, half) {
  const axis = vec3(by).toVar();
  const hl = half.y.toVar();
  const rB = half.x.toVar(); // radius at −by
  const rT = half.z.toVar(); // radius at +by
  const A = vec3(center).sub(axis.mul(hl)).toVar();
  const B = vec3(center).add(axis.mul(hl)).toVar();
  const side = tubeSideFactor(P, N, A, B, rB, rT);
  const capA = discFactor(P, N, A, axis.negate(), rB, float(0), float(0)).toVar();
  const capB = discFactor(P, N, B, axis, rT, float(0), float(0)).toVar();
  const rel = P.sub(vec3(center)).toVar();
  const dC = rel.length().max(1e-6).toVar();
  const cosG = rel.div(dC).dot(axis).abs();
  const sinG = float(1).sub(cosG.mul(cosG)).max(0).sqrt().toVar();
  const wideAtA = rB.greaterThanEqual(rT).toVar();
  const cW = select(wideAtA, A, B).toVar();
  const nW = select(wideAtA, axis.negate(), axis).toVar();
  const rW = rB.max(rT).toVar();
  const rN = rB.min(rT).toVar();
  const oneW = select(wideAtA, capA, capB).toVar();
  const oneN = discFactor(P, N, cW, nW, rN, float(0), float(0));
  const twoW = discFactor(P, N, cW, nW, rW, float(0), float(1));
  const twoN = discFactor(P, N, cW, nW, rN, float(0), float(1));
  const ringOne = oneW.sub(oneN).max(0);
  const ringTwo = twoW.sub(twoN).max(0);
  const corrected = oneW.sub(sinG.mul(ringOne)).add(sinG.mul(ringTwo).mul(0.5)).toVar();
  const capAF = select(wideAtA, corrected, capA);
  const capBF = select(wideAtA, capB, corrected);
  return side.add(capAF).add(capBF).min(Math.PI);
}

// Torus chord-segment count + arc/chord area compensation. MUST match
// emitterShapes.js TORUS_SEGMENTS/TORUS_CHORD_COMP (the shape test grades the
// scalar twin; a differing K here would be an unarbitrated shader).
const TORUS_K = 8;
const TORUS_COMP = (Math.PI / TORUS_K) / Math.sin(Math.PI / TORUS_K);

/**
 * Torus: TORUS_K chord tubes anchored to the receiver's in-plane azimuth
 * (rotation-invariant by construction — a spinning torus lamp CANNOT flicker
 * from this term) with near-chord self-occlusion per far segment.
 */
function torusFactorTSL(P, N, center, by, half) {
  const axis = vec3(by).toVar();
  const ringR = half.x.toVar();
  const rt = half.y.mul(TORUS_COMP).toVar();
  const rel = P.sub(vec3(center)).toVar();
  const Hax = rel.dot(axis).toVar();
  const inPlane = rel.sub(axis.mul(Hax)).toVar();
  const eLen = inPlane.length().toVar();
  // Receiver on the axis: any anchor gives the same answer by symmetry.
  const fallback = select(axis.x.abs().lessThan(0.9), vec3(1, 0, 0), vec3(0, 0, 1));
  const fb = fallback.sub(axis.mul(fallback.dot(axis)));
  const e1 = select(eLen.greaterThan(1e-6), inPlane.div(eLen.max(1e-6)), fb.normalize()).toVar();
  const e2 = axis.cross(e1).toVar();
  const F = float(0).toVar();
  const ringPoint = (phi) =>
    vec3(center).add(e1.mul(Math.cos(phi) * 1).mul(ringR)).add(e2.mul(Math.sin(phi) * 1).mul(ringR));
  const dPhi = (2 * Math.PI) / TORUS_K;
  const nA = ringPoint(-0.5 * dPhi).toVar();
  const nB = ringPoint(0.5 * dPhi).toVar();
  for (let i = 0; i < TORUS_K; i++) {
    const pA = i === 0 ? nA : ringPoint((i - 0.5) * dPhi).toVar();
    const pB = i === 0 ? nB : ringPoint((i + 0.5) * dPhi).toVar();
    const seg = tubeSideFactor(P, N, pA, pB, rt, rt);
    if (i > 1 && i < TORUS_K - 1) {
      // Sight line to this segment vs the near chord: penumbra centred on
      // tangency (clear = rt → half the far tube hidden).
      const mid = pA.add(pB).mul(0.5);
      const clear = segSegDist(P, mid, nA, nB);
      const vis = smoothstep(rt.mul(0.2), rt.mul(1.8), clear);
      F.addAssign(seg.mul(vis));
    } else {
      F.addAssign(seg);
    }
  }
  return F.min(Math.PI);
}

/**
 * The full kind dispatch as ONE per-shader WGSL function (sharedFn): the
 * chain below inlines seven shape evaluators, and stamping it out per slot
 * per pass measurably stretched post-rebuild pipeline compiles (the block
 * rig's black-frame detector caught rebuilt arms exceeding the reshoot
 * window). As a layout'd function each shader carries it exactly once and
 * every slot/call site is a plain call.
 */
const emitterFactorFn = sharedFn({
  name: "giEmitterFactor",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "N", type: "vec3" },
    { name: "cosTheta", type: "float" },
    { name: "sinR", type: "float" },
    { name: "kind", type: "float" },
    { name: "center", type: "vec3" },
    { name: "half", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, N, cosTheta, sinR, kind, center, half, bx, by, bz) => {
    const factor = float(Math.PI).mul(sinR).mul(sinR).mul(sphereLightFactor(cosTheta, sinR)).toVar();
    If(kind.greaterThan(0.5), () => {
      If(kind.lessThan(1.5), () => {
        factor.assign(boxLightFactor(P, N, center, half, bx, by, bz));
      }).ElseIf(kind.lessThan(2.5), () => {
        factor.assign(capsuleFactorTSL(P, N, center, by, half));
      }).ElseIf(kind.lessThan(3.5), () => {
        factor.assign(cylinderFactorTSL(P, N, center, by, half));
      }).ElseIf(kind.lessThan(4.5), () => {
        factor.assign(frustumFactorTSL(P, N, center, by, half));
      }).ElseIf(kind.lessThan(5.5), () => {
        factor.assign(discFactor(P, N, center, by, half.x, half.z, float(1)));
      }).Else(() => {
        factor.assign(torusFactorTSL(P, N, center, by, half));
      });
    });
    return factor;
  },
});

/**
 * Geometric irradiance factor of one emitter slot (E = slot.color · factor).
 * ONE function used by the receiver direct term, the voxel feedback inject,
 * mover hit-shading and reflection-hit lighting — divergence between those
 * shows up as light that changes when a lamp is viewed via a different path.
 * Kinds: 0 sphere (horizon-aware), 1 oriented box (exact Lambert contour),
 * 2 capsule, 3 cylinder, 4 frustum/cone, 5 disc/ring, 6 torus — see the
 * SHAPED EMITTERS block above; scalar twins + MC arbiter in emitterShapes.js.
 */
export function emitterSlotFactor(slot, P, N, cosTheta, sinR) {
  if (!slot.kind) return float(Math.PI).mul(sinR).mul(sinR).mul(sphereLightFactor(cosTheta, sinR));
  return emitterFactorFn(
    P, N, cosTheta, sinR,
    float(slot.kind), vec3(slot.center), vec3(slot.half),
    vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
  );
}

/**
 * Ray-enter distance for the shaped kinds' shadow-ray caps (the twin duty of
 * boxRayEnter): exact quadratics for capsule/cylinder/frustum, plane hit for
 * discs, a short SDF march for the torus (its exact intersection is quartic —
 * not worth it for a ray CAP that a margin is subtracted from anyway).
 */
const shapeRayEnter = sharedFn({
  name: "giShapeRayEnter",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "dir", type: "vec3" },
    { name: "dist", type: "float" },
    { name: "kind", type: "float" },
    { name: "center", type: "vec3" },
    { name: "radius", type: "float" },
    { name: "half", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, dir, dist, kind, center, radius, half, bx, by, bz) => {
    const t = dist.sub(radius).toVar(); // bounding-sphere fallback
    const rel = P.sub(center).toVar();
    // Local frame (by = symmetry axis).
    const lx = rel.dot(bx).toVar();
    const ly = rel.dot(by).toVar();
    const lz = rel.dot(bz).toVar();
    const dx = dir.dot(bx).toVar();
    const dy = dir.dot(by).toVar();
    const dz = dir.dot(bz).toVar();
    If(kind.greaterThan(1.5).and(kind.lessThan(4.5)), () => {
      // Capsule/cylinder/frustum: infinite-cone/cylinder quadratic on the
      // radial coordinates, entry clamped to the axial span, then cap tests.
      const hl = half.y.toVar();
      const rBot = half.x.toVar();
      const rTop = select(kind.lessThan(3.5), half.x, half.z).toVar();
      // r(y) = rBot + (rTop − rBot)·(y + hl)/(2hl) = m·y + c0
      const m = rTop.sub(rBot).div(hl.mul(2)).toVar();
      const c0 = rBot.add(rTop).mul(0.5).toVar();
      // (lx+t·dx)² + (lz+t·dz)² = (m·(ly+t·dy)+c0)²
      const rl = m.mul(ly).add(c0).toVar();
      const A = dx.mul(dx).add(dz.mul(dz)).sub(m.mul(m).mul(dy).mul(dy)).toVar();
      const Bq = lx.mul(dx).add(lz.mul(dz)).sub(rl.mul(m).mul(dy)).toVar();
      const Cq = lx.mul(lx).add(lz.mul(lz)).sub(rl.mul(rl)).toVar();
      const disc = Bq.mul(Bq).sub(A.mul(Cq)).toVar();
      If(disc.greaterThan(0).and(A.abs().greaterThan(1e-8)), () => {
        const tSide = Bq.negate().sub(disc.sqrt()).div(A).toVar();
        const ySide = ly.add(dy.mul(tSide));
        If(tSide.greaterThan(0).and(ySide.abs().lessThanEqual(hl.add(select(kind.lessThan(2.5), half.x, float(0))))), () => {
          t.assign(tSide);
        });
      });
      // Flat caps (cylinder/frustum) or sphere caps (capsule) can be nearer.
      If(kind.greaterThan(2.5), () => {
        const capT = (yPlane, rCap) => {
          const tc = yPlane.sub(ly).div(select(dy.abs().greaterThan(1e-8), dy, float(1e-8))).toVar();
          const cx = lx.add(dx.mul(tc));
          const cz = lz.add(dz.mul(tc));
          const inside = cx.mul(cx).add(cz.mul(cz)).lessThanEqual(rCap.mul(rCap));
          return { tc, valid: tc.greaterThan(0).and(dy.abs().greaterThan(1e-8)).and(inside) };
        };
        const capA = capT(hl.negate(), rBot);
        If(capA.valid.and(capA.tc.lessThan(t)), () => { t.assign(capA.tc); });
        const capB = capT(hl, rTop);
        If(capB.valid.and(capB.tc.lessThan(t)), () => { t.assign(capB.tc); });
      }).Else(() => {
        // Capsule end spheres.
        const sph = (cy) => {
          const ox = lx, oy = ly.sub(cy), oz = lz;
          const b = ox.mul(dx).add(oy.mul(dy)).add(oz.mul(dz)).toVar();
          const c = ox.mul(ox).add(oy.mul(oy)).add(oz.mul(oz)).sub(half.x.mul(half.x)).toVar();
          const d2 = b.mul(b).sub(c).toVar();
          return { tc: b.negate().sub(d2.max(0).sqrt()), valid: d2.greaterThan(0) };
        };
        const sA = sph(hl.negate());
        If(sA.valid.and(sA.tc.greaterThan(0)).and(sA.tc.lessThan(t)), () => { t.assign(sA.tc); });
        const sB = sph(hl);
        If(sB.valid.and(sB.tc.greaterThan(0)).and(sB.tc.lessThan(t)), () => { t.assign(sB.tc); });
      });
    }).ElseIf(kind.lessThan(5.5), () => {
      // Disc/ring: the shadow ray aims INTO the disc plane (at worst at the
      // ring's centre hole) — the plane crossing is the honest cap either way.
      const denom = select(dy.abs().greaterThan(1e-6), dy, float(1e-6));
      const tp = ly.negate().div(denom).toVar();
      If(tp.greaterThan(0), () => { t.assign(tp.min(dist)); });
    }).Else(() => {
      // Torus: sphere-trace its SDF a few steps from the bounding-sphere
      // entry. Converges to mm-scale for hit rays; misses stay ≥ the
      // bounding fallback which the caller's margin absorbs.
      const tm = t.max(0).toVar();
      for (let i = 0; i < 6; i++) {
        const px = lx.add(dx.mul(tm)), py = ly.add(dy.mul(tm)), pz = lz.add(dz.mul(tm));
        const qx = px.mul(px).add(pz.mul(pz)).sqrt().sub(half.x);
        const sd = qx.mul(qx).add(py.mul(py)).sqrt().sub(half.y);
        tm.addAssign(sd.max(0));
      }
      t.assign(tm.min(dist));
    });
    return t;
  },
});

/**
 * The shadow ray's reach toward a slot: to the sphere surface, the box's
 * slab entry, or the shaped kinds' surface (shapeRayEnter above).
 */
export function emitterSurfaceT(slot, P, dirToEmitter, dist) {
  const sphereT = dist.sub(slot.radius);
  if (!slot.kind) return sphereT;
  const t = sphereT.toVar();
  const kind = float(slot.kind);
  If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
    t.assign(
      boxRayEnter(P, dirToEmitter, vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz)),
    );
  }).ElseIf(kind.greaterThan(1.5), () => {
    t.assign(
      shapeRayEnter(
        P, dirToEmitter, dist, kind,
        vec3(slot.center), float(slot.radius), vec3(slot.half),
        vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
      ),
    );
  });
  return t;
}

/**
 * Angular miss distance of a reflection ray vs a SHAPED emitter's silhouette
 * (the duty boxGlowMiss performs for boxes): the reflection of a cylinder
 * lamp is a bar, of a torus a ring — not the box their OBB would draw.
 * Method: closest approach to the slot centre, two sphere-trace refinement
 * steps against the shape's SDF (rays that hit converge to sdf≈0), then
 * sdf/t as the angular miss. Exact inside the silhouette, glow-grade soft
 * at rims — the same contract boxGlowMiss documents.
 */
const shapeGlowMiss = sharedFn({
  name: "giShapeGlowMiss",
  type: "float",
  inputs: [
    { name: "P", type: "vec3" },
    { name: "R", type: "vec3" },
    { name: "kind", type: "float" },
    { name: "center", type: "vec3" },
    { name: "half", type: "vec3" },
    { name: "bx", type: "vec3" },
    { name: "by", type: "vec3" },
    { name: "bz", type: "vec3" },
  ],
  body: (P, R, kind, center, half, bx, by, bz) => {
    const rel = P.sub(center).toVar();
    const ro = vec3(rel.dot(bx), rel.dot(by), rel.dot(bz)).toVar();
    const rd = vec3(R.dot(bx), R.dot(by), R.dot(bz)).toVar();
    const sdf = (p) => {
      const d = float(0).toVar();
      const radial = p.xz.length().toVar();
      If(kind.lessThan(2.5), () => {
        // Capsule: segment distance minus radius.
        const yC = p.y.clamp(half.y.negate(), half.y);
        d.assign(vec3(p.x, p.y.sub(yC), p.z).length().sub(half.x));
      }).ElseIf(kind.lessThan(3.5), () => {
        // Cylinder.
        const q = vec2(radial.sub(half.x), p.y.abs().sub(half.y)).toVar();
        d.assign(q.max(vec2(0)).length().add(q.x.max(q.y).min(0)));
      }).ElseIf(kind.lessThan(4.5), () => {
        // Frustum: radial vs the linearly varying r(y), capped — glow-grade.
        const m = half.z.sub(half.x).div(half.y.mul(2));
        const rAt = m.mul(p.y).add(half.x.add(half.z).mul(0.5));
        d.assign(radial.sub(rAt).max(p.y.abs().sub(half.y)));
      }).ElseIf(kind.lessThan(5.5), () => {
        // Disc/ring plate: radial band [rI, rO] at thickness ~0.
        const band = radial.sub(half.x).max(half.z.sub(radial)).max(0);
        d.assign(vec2(band, p.y).length());
      }).Else(() => {
        // Torus.
        const q = vec2(radial.sub(half.x), p.y).toVar();
        d.assign(q.length().sub(half.y));
      });
      return d;
    };
    const t = ro.negate().dot(rd).clamp(0.05, 1e5).toVar();
    // Two refinement steps walk t toward the surface for hit rays; misses
    // stay near the closest approach, which is what the miss ratio wants.
    for (let i = 0; i < 2; i++) {
      const d = sdf(ro.add(rd.mul(t)));
      t.assign(t.add(d.mul(0.9)).clamp(0.05, 1e5));
    }
    return sdf(ro.add(rd.mul(t))).max(0).div(t);
  },
});

/**
 * Self-exclusion region for the sphere-arm shadow marchers, kind-aware.
 * Kind 0 excludes the bounding sphere ×1.5; every shaped kind excludes a
 * CONSERVATIVE OBB (slot.exHalf, computed CPU-side per shape — a torus's
 * spans ring+tube, a disc's is its thin plate). Replaces three copies of a
 * `mix(..., kindF)` pattern that was linear in `kind` and therefore silently
 * WRONG for any kind above 1 (mix extrapolates: kind 2 produced 2·half−1).
 */
export function emitterExclusion(slot, margin) {
  if (!slot.kind) {
    return { exRadius: slot.radius.mul(1.5).add(margin), exBox: null };
  }
  const shaped = step(0.5, float(slot.kind));
  const exHalf = slot.exHalf ?? slot.half;
  return {
    exRadius: mix(slot.radius.mul(1.5).add(margin), margin, shaped),
    exBox: {
      half: mix(vec3(-1), vec3(exHalf), shaped),
      bx: slot.bx, by: slot.by, bz: slot.bz,
    },
  };
}

/** Angular-size radius of a slot: exact for spheres, mean-projected-area
 *  equivalent for boxes (set CPU-side — see GISystem's slot refresh). */
export function emitterAngularRadius(slot) {
  return slot.reff ?? slot.radius;
}

/**
 * Promoted emissive emitters as analytic AREA lights (sphere or oriented
 * box, per slot), with SDF sphere-traced penumbrae:
 * E = color · geometricFactor · shadow (see emitterSlotFactor).
 *
 * Lives here (rather than inline in the light node) because BOTH callers need
 * exactly this math: the deferred resolve pass evaluates it once per screen
 * pixel (giScreen.js), and the legacy in-material path evaluates it per
 * fragment when no gbuffer is available. Divergence between the two would
 * show up as light that changes when the resolve is toggled.
 *
 * `params` supplies the uniforms/functions the light carries: emitterSlots,
 * shadowTraceFn, shadowMargin, shadowRange, normalOffset.
 * Returns the summed irradiance, the per-slot shadow factors (packed into a
 * texture by the resolve pass), and the per-slot geometry the specular glow
 * reuses.
 */
/**
 * Irradiance below which an emitter is neither TRACED nor SHOWN.
 *
 * This one number sets each emitter's effective reach, and reach is the whole
 * cost of the screen emitter shadow pass: every pixel inside it marches a
 * record ray (plus a static-BVH8 traversal, plus every adopted mover) to that
 * emitter, every frame. Falloff is 1/d², so the traced AREA grows as
 * cutoff⁻¹ — halving the cutoff doubles the pixels that pay.
 *
 * MEASURED (user's editor, 2026-08-07, 3 emitters at 636x249): the emitter
 * shadow pass was 10.53ms, 77% of all per-frame GI screen work. The rig
 * reproduced the SHAPE of it (0.23ms in a bare scene → 0.87ms at 90k tris,
 * same pixel count) and ruled out the obvious suspects: disabling the static
 * BVH arm saved 19%, dropping 12 adopted movers 12%, the analytic width probe
 * nothing. What is left is how FAR the rays go — with `shadowRange` at the
 * volume diagonal (up to 64m) and this cutoff at 0.0015, a strength-12 lamp
 * keeps earning full marches out to ~28m, which in a real scene is every
 * pixel on screen, three times over.
 *
 * The trace gate and the contribution fade MUST use the same number, or dim
 * emitter light crosses walls unshadowed (the bug the original 0.0015 gate was
 * introduced to fix). `__giEmitterCutoff` overrides.
 */
export function emitterCutoff(params = null) {
  const override = Number(globalThis.__giEmitterCutoff);
  if (Number.isFinite(override) && override > 0) return override;
  const preset = Number(params?.emitterCutoff);
  // The 0.0015 fallback is the in-material path's, which has no preset to
  // read — it keeps the historical reach rather than silently changing.
  return Number.isFinite(preset) && preset > 0 ? preset : 0.0015;
}

export function emitterDirectAt(params, P, N, samplePoint) {
  const total = vec3(0).toVar();
  const shadows = [];
  const perSlot = [];
  for (const [index, slot] of params.emitterSlots.entries()) {
    const center = vec3(slot.center);
    const toEmitter = center.sub(P).toVar();
    const dist = toEmitter.length().max(1e-3).toVar();
    const dirToEmitter = toEmitter.div(dist).toVar();
    const cosTheta = dirToEmitter.dot(N).toVar();
    const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
    // Sphere slots: horizon-aware πsin²R·factor (a floor-hugging lamp still
    // lights the floor around it smoothly). Box slots: the exact per-face
    // form factor — a cube lamp pools light like a cube, not a circle.
    const emitterDirect = vec3(slot.color)
      .mul(emitterSlotFactor(slot, P, N, cosTheta, sinR))
      .toVar();
    // CRITICAL: light too dim to TRACE must also be too dim to SHOW — the old
    // gate skipped the trace but KEPT the contribution, so dim emitter light
    // crossed walls unshadowed and read clearly in dark adjacent rooms.
    const emitterLum = emitterDirect.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const cutD = emitterCutoff(params);
    emitterDirect.mulAssign(smoothstep(cutD / 3, cutD, emitterLum));
    // PRE-TRACED CHANNEL (2026-08-06): when the emitter shadows run as their
    // own pass at their own pixel budget (giScreen's emitter shadow pass —
    // the same split that took the direct arm from 22ms to 5.4ms at 4×
    // pixels), the resolve just SAMPLES the filtered texture; the trace
    // lives in exactly one kernel. The hit-shading path (bvhShade) keeps
    // tracing inline — a reflection hit is a different world point than the
    // pixel, so a screen-space sample would be the wrong surface's shadow.
    const shadow = params.shadowSample
      ? float(params.shadowSample(index)).toVar()
      : emitterSlotShadow(params, slot, P, N, samplePoint);
    const active = step(0.001, slot.radius);
    total.addAssign(emitterDirect.mul(shadow).mul(active));
    shadows.push(shadow);
    perSlot.push({ slot, shadow, dist, dirToEmitter, active });
  }
  return { irradiance: total, shadows, perSlot };
}

/**
 * One emitter slot's traced shadow factor at receiver P — the block
 * emitterDirectAt always carried, extracted (2026-08-06) so the dedicated
 * emitter shadow pass (giScreen createGiEmitterShadowPass) and the resolve's
 * hit-shading path evaluate the IDENTICAL estimator. Trace gates: below
 * cosθ 0.05 the grazing fade discards the traced result entirely, and a
 * contribution too dim to see doesn't earn a march either.
 */
export function emitterSlotShadow(params, slot, P, N, samplePoint) {
  const center = vec3(slot.center);
  const toEmitter = center.sub(P).toVar();
  const dist = toEmitter.length().max(1e-3).toVar();
  const dirToEmitter = toEmitter.div(dist).toVar();
  const cosTheta = dirToEmitter.dot(N).toVar();
  const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
  const emitterLum = vec3(slot.color)
    .mul(emitterSlotFactor(slot, P, N, cosTheta, sinR))
    .dot(vec3(0.2126, 0.7152, 0.0722))
    .toVar();
  const shadow = float(1).toVar();
  If(
    slot.radius.greaterThan(0.001)
      .and(cosTheta.greaterThan(0.05))
      .and(dist.lessThan(params.shadowRange))
      .and(emitterLum.greaterThan(emitterCutoff(params))),
    () => {
      // k = distance / emitter angular radius encodes the light's angular
      // size: bigger/closer emitter → softer. Floor 1.2 so a large area
      // lamp close to the receiver keeps a wide, soft penumbra.
      const k = dist.div(float(emitterAngularRadius(slot)).max(0.05)).clamp(1.2, 48);
      // Ray cap at the emitter's actual SURFACE (slab entry for boxes —
      // the bounding sphere of an elongated lamp stopped the ray well
      // short of its face, exempting anything hugging it from occluding).
      const maxT = emitterSurfaceT(slot, samplePoint, dirToEmitter, dist).sub(params.shadowMargin).max(0);
      If(maxT.greaterThan(params.shadowMargin), () => {
        // Self-exclusion covers ONLY the lamp's own body + a couple of
        // field cells. Sphere slots: the bounding sphere ×1.5 (their body
        // IS the sphere). Shaped slots: a conservative OBB (exHalf) dilated
        // by the margin — the bounding sphere of a big panel swallowed
        // nearby ceilings/walls, which then stopped occluding (light poured
        // through into the next room as a circle) and its boundary ringed
        // the pool.
        const ex = emitterExclusion(slot, float(params.shadowMargin));
        const exRadius = ex.exRadius;
        const exBox = ex.exBox
          ? ex.exBox
          : null;
        // RECORD-MARCH EMITTER SHADOWS (2026-08-06, plan §6 unification —
        // the emitter arm joins the light arm's estimator family). The
        // sphere trace's threshold admissions over the voxel-quantized
        // distance field etched a lattice grid across receivers under big
        // panel emitters; the record march has no admission thresholds at
        // all, and the analytic width probe supplies the penumbra.
        // `recordShadowTrace` exists ONLY on compute-pass bundles — the
        // legacy in-material fallback (params = the light itself) must
        // never compile the occupancy bits buffer into fragment shaders,
        // so it keeps the sphere arm. The lamp's own body is excluded by
        // maxT (surface slab entry minus margin), not by a region test —
        // admission is exact, so a wall hugging the lamp still occludes.
        const traced = params.recordShadowTrace
          ? params.recordShadowTrace(P, N, dirToEmitter, maxT, k, cosTheta)
          : params.shadowTraceFn(
              samplePoint, dirToEmitter, maxT, k, cosTheta,
              center, exRadius, exBox,
            );
        // Grazing fade: with the ray nearly parallel to the receiver plane
        // the trace hugs the surface's own field and flickers in terraced
        // rings around the emitter. E already carries cosθ, so at grazing
        // angles the shadow contributes nothing but rings.
        shadow.assign(mix(float(1), traced, smoothstep(0.05, 0.2, cosTheta)));
      });
    },
  );
  return shadow;
}

/**
 * Analytic (point/directional) direct irradiance at an arbitrary world point,
 * from the shared GI light slots. UNSHADOWED by design.
 *
 * This exists for shading a REFLECTION HIT. A primary surface never needs it —
 * three's own lighting already evaluates the scene's real lights there, with
 * real shadow maps. But a point seen only in a mirror is not shaded by anyone:
 * without this, a reflected sunlit wall shows nothing but its indirect bounce
 * and reads several stops too dark, which is most of why exact reflections
 * looked wrong even when the geometry they resolved was exactly right.
 *
 * Unshadowed is the same trade the (now retired) per-material hit path made:
 * shadowing these costs up to MAX_GI_LIGHTS extra SDF marches per mirror pixel
 * to fix a subtle error INSIDE a reflection. Emitters — usually the dominant
 * light in a GI scene — stay shadowed via `emitterDirectAt`.
 *
 * `|N·L|`, not `max(0, N·L)`: the same both-sides convention the feedback
 * inject and the retired hit path use, because a BVH hit can land on a
 * single-sided wall whose winding faces away from the light.
 *
 * @param {Array} lightSlots uniform slots (see GISystem's `lightSlots`)
 * @param {*} P world position of the hit
 * @param {*} N unit normal at the hit
 * @returns irradiance (a TSL vec3 var)
 */
export function analyticDirectAt(lightSlots, P, N) {
  const total = vec3(0).toVar();
  for (const slot of lightSlots) {
    If(slot.active.greaterThan(0.5), () => {
      const isDir = float(slot.kind).toVar();
      const rel = vec3(slot.vector).sub(P).toVar();
      const pointDist = rel.length().max(1e-4).toVar();
      // `vector` holds: point → world position, directional → the normalized
      // direction TOWARD the light (cascadeGather.js uses the same convention).
      const dirTo = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
      let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
      // three's PointLight `distance` cutoff (0 = infinite) — GI must die
      // where the renderer's own direct light does.
      if (slot.range) {
        const range = float(slot.range);
        const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
        const r2 = ratio.mul(ratio);
        const win = r2.mul(r2).oneMinus().clamp(0, 1);
        atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
      }
      const cosH = dirTo.dot(N).abs().toVar();
      total.addAssign(vec3(slot.color).mul(atten).mul(cosH));
    });
  }
  return total;
}

export class GICascadeLight extends THREE.Light {
  constructor() {
    super(0xffffff, 1);
    this.isGICascadeLight = true;
    this.type = "GICascadeLight";
    // DEFERRED RESOLVE (see giScreen.js). When these are set, materials read
    // screen-space GI instead of evaluating it: `giIrradianceNode` carries
    // diffuse indirect + emitter direct (intensity already applied), and
    // `giEmitterShadowNode` packs the per-emitter shadow factors the specular
    // glow needs. They are PERSISTENT TextureNodes whose `.value` is swapped
    // on resize — never rebuilt — so material shaders are byte-identical
    // across GI rebuilds and never recompile.
    this.giIrradianceNode = null;
    this.giEmitterShadowNode = null;
    this.giRadianceNode = null;
    // Set by GISystem after construction: (P, N) => vec3 irradiance.
    // Still used by the legacy in-material path (no gbuffer) and by the
    // resolve pass itself.
    this.gatherFn = null;
    // Optional: (P, R) => vec3 radiance along R — feeds indirect specular.
    // `radianceFn` = mid-angular cascade (soft gloss), `radianceSharpFn` =
    // finest-angular cascade (low-roughness reflections), `radianceRoughFn`
    // = densest-probe cascade (rough gloss — lattice stripes, not direction
    // bins, are what a wide lobe resolves).
    this.radianceFn = null;
    this.radianceSharpFn = null;
    this.radianceRoughFn = null;
    // Fast non-exact reflections reuse the deferred irradiance texture as a
    // broad specular radiance term. This deliberately trades directionality
    // for a tiny, stable material graph; exact reflections opt into the
    // directional cascade/BVH machinery below.
    this.approximateReflections = false;
    // Optional emissive-area-shadow inputs (see GISystem #updateEmitters):
    // emitterSlots = MAX_EMITTERS × {center, radius, color, kind, half,
    // bx/by/bz, reff, exHalf} uniforms (kind 0 = sphere, 1 = oriented box,
    // 2 = capsule, 3 = cylinder, 4 = frustum/cone, 5 = disc/ring,
    // 6 = torus — see emitterSlotFactor and emitterShapes.js);
    // shadowTraceFn = voxel DDA (origin, dir, maxT) => { rad, t }.
    this.emitterSlots = null;
    this.shadowTraceFn = null;
    this.shadowMargin = 0.3;
    // World-units cap on receiver-side emitter shadow reach. Set by
    // GISystem to the VOLUME SCALE — a fixed small cap (the old 12m) made
    // every receiver beyond it take the emitter's light UNSHADOWED, i.e.
    // light pouring straight through walls onto distant floors.
    this.shadowRange = 48;
    // World-units reach of the per-pixel mirror ray (set by GISystem from
    // the volume size; the DDA's step cap bounds shader cost).
    this.mirrorRange = 24;
    // Optional exact-reflection hit-t source (GI Phase 3 v1 — see
    // docs/GI_PLAN.md and giScreen.js's createGiBvhReflect): a persistent
    // screen texture written by a half-res BVH compute prepass, sampled at
    // the SAME screen UV as giIrradianceNode. When set, the mirror block
    // below reads t from here INSTEAD OF calling `mirrorTraceFn` — a
    // compile-time switch (mirrorTraceFn is simply never invoked, so its
    // SDF trace is not compiled into the shader at all). Miss is still
    // t < 0, so everything downstream (hitPoint, hitSurfaceFn, per-hit
    // shadows) is unchanged. Set by GISystem only at quality high/ultra
    // (`exactReflections`) and cleared by the `globalThis.__giNoBvhReflections`
    // hatch, which keeps this SDF mirrorTraceFn path as the always-working
    // fallback/A-B baseline.
    this.bvhReflectTexture = null;
    // Optional sibling of bvhReflectTexture (GI Phase 3 v2 — texture-at-hit):
    // rgb = the BVH hit's ACTUAL texture-sampled albedo (bvhScene.js
    // `firstHit`'s atlas lookup), a = 1 on a hit else 0 (giScreen.js
    // `createGiBvhReflect`'s `colorTarget`). Same screen UV as
    // bvhReflectTexture/giIrradianceNode. When set, the mirror block below
    // substitutes this for `hitSurface.albedo` (the mean-color mesh-SDF
    // approximation) wherever the BVH t-source was actually used for this
    // pixel — same PURE DATAFLOW consumption discipline as bvhReflectTexture
    // (direct sub-node reads + select(), never hoisted/gated — see that
    // block's comment).
    this.bvhReflectColorTexture = null;
    // What bvhReflectColorTexture's rgb MEANS (2026-08-02). True = the
    // reflected point's outgoing RADIANCE, already shaded inside the prepass
    // with the cascade gather + emitters + analytic lights AT THE HIT. False
    // (the legacy contract) = the hit's raw ALBEDO, which left the consumer
    // with no lighting for it and drove the receiver-irradiance approximation
    // documented at that use site.
    this.bvhReflectShaded = false;
    // Optional: (p) => { rad, coverage } trilinear INDIRECT-field sample —
    // diffuse remainder for mirror hits (set by GISystem).
    this.mirrorSampleFn = null;
    // Optional per-pixel hit lighting (crisp reflections): hitSurfaceFn(p)
    // → { albedo, normal, valid } from the nearest mesh SDF slot;
    // mirrorShadowFn = a short shadow trace for direct light at hits;
    // lightSlots = the analytic-light uniform slots (shared with the
    // feedback pass) so reflections carry point/directional light.
    this.hitSurfaceFn = null;
    this.mirrorShadowFn = null;
    this.lightSlots = null;
    // Lumen-style per-hit direct lighting inside reflections. ULTRA-only:
    // the per-hit emitter/analytic loops with their shadow traces are the
    // single largest chunk of both the material shader graph (compile-wave
    // wall time) and the per-mirror-pixel GPU cost — at high and below,
    // hits shade from the indirect field alone.
    this.hitLighting = true;
    // Live-tunable without recompiles.
    this.intensityUniform = uniform(1);
    this.normalOffset = 0.35;
  }
}

/**
 * Inverse of giScreen.js's `octEncodeNormal` (see that function's comment):
 * decodes 2 floats in [-1,1] back to a unit vector. Written as a CLOSED-FORM
 * expression — no `.toVar()`, no `If()` — on purpose: this only ever gets
 * called from the mirror block's PURE DATAFLOW branch below, which is a
 * verified-by-incident correctness requirement (see that branch's own
 * comment: hoisting a texture sample through `.toVar()` and branching on it
 * with `If()` rendered the whole mirror black; direct reads + `select()`
 * chains are the only proven-safe idiom there), so this helper must never
 * introduce either.
 */
export function decodeOctNormal(e) {
  const vz = float(1).sub(abs(e.x)).sub(abs(e.y));
  const t = vz.negate().max(0);
  const vx = select(e.x.greaterThanEqual(0), e.x.sub(t), e.x.add(t));
  const vy = select(e.y.greaterThanEqual(0), e.y.sub(t), e.y.add(t));
  return vec3(vx, vy, vz).normalize();
}

export class GICascadeLightNode extends THREE.AnalyticLightNode {
  static get type() {
    return "GICascadeLightNode";
  }

  constructor(light = null) {
    super(light);
  }

  setup(builder) {
    const light = this.light;
    if (!light?.gatherFn && !light?.giIrradianceNode) return;
    // VOLUMETRIC MATERIALS HAVE NO IRRADIANCE SLOT. VolumeNodeMaterial shades
    // through a scattering model (scatteringLight/direct — see
    // volumetricLightingModel.js), so `context.irradiance` is undefined and
    // the addAssign below throws while the material builds, leaving the
    // volume rendering BLACK (user-reported). Bail out instead: volumes
    // simply don't receive GI yet — feeding a world-space gather per ray step
    // is the expensive path this module just moved away from.
    if (!builder.context.irradiance) {
      if (!GICascadeLightNode._warnedNoIrradiance) {
        GICascadeLightNode._warnedNoIrradiance = true;
        console.log(
          `[gi] skipping GI for "${builder.material?.type ?? "?"}" — this material's lighting model has no irradiance slot ` +
            `(volumetric materials scatter instead of shading a surface); it renders without GI rather than failing to build`,
        );
      }
      return;
    }
    // Face-forward toward the camera: a double-sided plane seen from its
    // back face would otherwise gather the wrong hemisphere and render
    // dark from inside a room whose wall normal points outward.
    const facing = step(0, normalWorld.dot(cameraPosition.sub(positionWorld))).mul(2).sub(1);
    const N = normalWorld.mul(facing);
    const samplePoint = positionWorld.add(N.mul(light.normalOffset));
    // DEFERRED PATH (the normal one — see giScreen.js): the gather and the
    // emitter shadow traces already ran once per screen pixel, so a material
    // reads the answer instead of recomputing it. This is what keeps material
    // shaders small enough for the driver to compile quickly, and what makes
    // a GI rebuild leave material code untouched (no recompile wave).
    const deferred = light.giIrradianceNode != null;
    // POSITION-VALIDATED BILATERAL over the half-res resolve textures. A
    // plain bilinear `sample(screenUV)` blends the 4 nearest half-res texels
    // regardless of WHOSE surface each was resolved for — at silhouettes a
    // bright texel (sunlit wall, emitter-lit floor) smears its full
    // irradiance onto the dark foliage/prop in front of it, which is the
    // white-dot artifact that survived every fix aimed at the SHADOW
    // channel (it was never the shadow channel). Each tap is validated
    // against the half-res gbuffer POSITION (Nearest-filtered, per-texel
    // exact): wrong-surface taps are rejected, valid ones blend distance-
    // weighted, and with no valid tap the DARKEST tap wins — for additive
    // light a dark error is a dim pixel, a bright error is the dot.
    const bilateral =
      light.giPositionNode && light.giScreenTexel
        ? (texNode) => {
            // FIXED-METRE HATCHES (2026-08-07, the ~0.196m block-size hunt).
            // Measured: block size on the floor is 0.196 + 0.14·probeSpacing
            // metres in x, and the voxelSize dial is inert (5× the dial moves
            // the block by 1.02×). The 0.196m intercept therefore scales with
            // NEITHER lattice, so it is a fixed-metre term DOWNSTREAM of both —
            // and this is the last stage between the probe lattice and the
            // shaded pixel. A 4-tap inverse-distance blend gated at a fixed
            // 0.15m world radius is a fixed-width world-space reconstruction
            // footprint by construction, which is exactly the shape of the
            // thing being hunted.
            //
            // All three are read at BUILD time, so setting one only lands on
            // the next rebuild — see the ABLATE note in
            // scripts/run-gi-block-size.mjs for why an ablation has to nudge a
            // structural prop as well. Each defaults to exactly the shipped
            // number, so an unset global reproduces today's node graph.
            //   __giBilateralWorldEps  0.15 — the near-field rejection floor,
            //                                 in metres. THE PRIME SUSPECT.
            //   __giBilateralViewFrac  0.02 — per metre of view distance, so
            //                                 the gate grows with the half-res
            //                                 texel's world footprint far away.
            //   __giBilateralTapScale  1    — multiplies the ±0.5-texel tap
            //                                 offsets; widens/narrows the
            //                                 footprint at a FIXED tap count.
            //                                 0 collapses to a single centre
            //                                 tap = the clean "no bilateral"
            //                                 arm (plain bilinear sample).
            //   __giBilateralWeightEps 0.02 — the softening epsilon in the
            //                                 inverse-distance weight below,
            //                                 in metres: below it, taps stop
            //                                 being distance-discriminated and
            //                                 blend equally, so it is a 2cm
            //                                 plateau inside the gate. A WEAK
            //                                 suspect (an order of magnitude
            //                                 under the 0.196m target) —
            //                                 hatched to rule out, not because
            //                                 it is likely. NOTE: 0 is settable
            //                                 but DEGENERATE — it is pure 1/d,
            //                                 and a tap landing exactly on the
            //                                 shading point divides by zero,
            //                                 giving an Inf weight and a NaN
            //                                 blend. For a "no plateau" arm use
            //                                 something tiny (1e-4), not 0.
            //
            // TRAP, and the reason __giBilateralWeightEps is named for the
            // WEIGHT and not the distance: it and __giBilateralViewFrac both
            // default to 0.02 and are UNRELATED. ViewFrac is dimensionless
            // (metres of rejection radius per metre of view distance, i.e. it
            // scales the gate with the camera); WeightEps is metres (it softens
            // a division). Ablating one does not test the other, and reading
            // `0.02` twice in this block is not a shared constant.
            //
            // Zero is a meaningful value for all four (it is the ablation), so
            // each is read through Number.isFinite rather than the module's
            // usual `Number(...) || DEFAULT`, which would swallow it.
            const rawWorldEps = Number(globalThis.__giBilateralWorldEps);
            const worldEps = Number.isFinite(rawWorldEps) ? rawWorldEps : 0.15;
            const rawViewFrac = Number(globalThis.__giBilateralViewFrac);
            const viewFrac = Number.isFinite(rawViewFrac) ? rawViewFrac : 0.02;
            const rawTapScale = Number(globalThis.__giBilateralTapScale);
            const tapScale = Number.isFinite(rawTapScale) ? rawTapScale : 1;
            const rawWeightEps = Number(globalThis.__giBilateralWeightEps);
            const weightEps = Number.isFinite(rawWeightEps) ? rawWeightEps : 0.02;
            const threshold = positionWorld.sub(cameraPosition).length().mul(viewFrac).max(worldEps);
            // At tapScale 0 the four offsets collapse onto the same texel, and
            // four identical taps are the centre tap's answer for 4× the
            // fetches (blend = v, darkest = v). Emit the one tap instead, so
            // the ablation arm is honestly "no bilateral" and not "a bilateral
            // that happens to agree with itself".
            const offsets =
              tapScale === 0
                ? [[0, 0]]
                : [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([dx, dy]) => [dx * tapScale, dy * tapScale]);
            const taps = offsets.map(([dx, dy]) => {
              const uv = screenUV.add(vec2(light.giScreenTexel).mul(vec2(dx, dy)));
              const v = vec4(texNode.sample(uv)).toVar();
              const g = light.giPositionNode.sample(uv);
              const d = g.xyz.sub(positionWorld).length();
              const w = select(g.w.greaterThan(0.5).and(d.lessThan(threshold)), float(1).div(d.add(weightEps)), float(0)).toVar();
              return { v, w };
            });
            const wSum = taps.reduce((a, t) => a.add(t.w), float(0));
            const blend = taps.reduce((a, t) => a.add(t.v.mul(t.w)), vec4(0)).div(wSum.max(1e-4));
            const darkest = taps.reduce((a, t) => a.min(t.v), vec4(1e9));
            return select(wSum.greaterThan(1e-4), blend, darkest);
          }
        : null;
    const irradiance = deferred
      ? vec3(bilateral ? bilateral(light.giIrradianceNode) : light.giIrradianceNode.sample(screenUV)).toVar()
      : vec3(light.gatherFn(samplePoint, N, cameraPosition.sub(positionWorld).normalize())).mul(light.intensityUniform);
    builder.context.irradiance.addAssign(irradiance);

    // Promoted emissive emitters = analytic sphere area lights, evaluated
    // per pixel per frame (the voxel field no longer carries their light —
    // GISystem strips it at bake): irradiance += E_direct · shadow, with
    // E_direct = color · min(π, πr²/d²) · cosθ and an SDF sphere-traced
    // penumbra. This replaces the old subtract-and-reshadow trick (which
    // existed only because the gather double-carried the emitter) — direct
    // light is now sharp, per-pixel, and follows a moving lamp every frame.
    // Runs BEFORE the reflections block: the specular path reuses each
    // slot's shadow/direction as sphere-light occlusion.
    const emitterData = [];
    if (deferred) {
      // Emitter direct + its shadow are already in the irradiance texture.
      // The specular glow below still needs each slot's geometry and its
      // shadow factor, so the resolve pass packs the four shadows into one
      // RGBA texture — a fetch instead of up to four sphere traces per pixel.
      if (light.emitterSlots?.length && light.giEmitterShadowNode) {
        // Same bilateral as the irradiance above — packed per-emitter shadow
        // factors smear across silhouettes identically, and min-per-channel
        // as the no-tap fallback is exactly "darkest shadow wins".
        const packed = (bilateral ? bilateral(light.giEmitterShadowNode) : light.giEmitterShadowNode.sample(screenUV)).toVar();
        const channels = [packed.x, packed.y, packed.z, packed.w];
        light.emitterSlots.forEach((slot, index) => {
          const toEmitter = vec3(slot.center).sub(positionWorld).toVar();
          const dist = toEmitter.length().max(1e-3).toVar();
          emitterData.push({
            slot,
            shadow: channels[index] ?? float(1),
            dist,
            dirToEmitter: toEmitter.div(dist).toVar(),
            active: step(0.001, slot.radius),
          });
        });
      }
    } else if (light.emitterSlots?.length && light.shadowTraceFn) {
      const direct = emitterDirectAt(light, positionWorld, N, samplePoint);
      builder.context.irradiance.addAssign(direct.irradiance.mul(light.intensityUniform));
      emitterData.push(...direct.perSlot);
    }

    // The default glossy-GI path must remain cheap on imported scenes. The
    // deferred texture was already computed once per screen pixel, so this
    // adds one texture-derived radiance term instead of embedding the volume
    // cascade lookup graph in every reflective material.
    if (deferred && light.approximateReflections && !light.giRadianceNode && builder.context.radiance) {
      builder.context.radiance.addAssign(irradiance.div(Math.PI));
    }

    // Glossy GI reflections: cascade radiance along the reflection vector →
    // context.radiance, which PhysicalLightingModel consumes as indirect
    // specular with full Fresnel/roughness weighting. Coexists with SSR
    // (SSR wins where it hits; this fills everything else).
    if ((light.radianceFn || light.giRadianceNode) && builder.context.radiance) {
      // ARBITRATION: a surface that owns a planar reflection (see
      // PlanarReflectionComponent) already shows the real scene mirrored
      // through its plane. Adding a traced reflection on top would be two
      // reflections of the same thing blended by nothing in particular, and
      // the traced one is strictly the worse of the two on a flat surface.
      // Compile only the diffuse limit there — the same end state a fully
      // rough material gets, and for the same reason: the directional path
      // would be discarded anyway, so do not pay to compile it.
      if (builder.material?.userData?.planarReflection === true) {
        builder.context.radiance.addAssign(irradiance.div(Math.PI));
        return;
      }
      const bucket = giRoughnessBucketOf(builder.material);
      const fullyRough = bucket === 2;
      const canMirror = bucket === 0 || bucket === 3;
      if (fullyRough) {
        // Static high roughness: the roughness collapse below would discard
        // the directional lookup entirely — compile ONLY its end state.
        // This is what keeps a wall/floor material's shader small (see the
        // gate constants' note on compile cost).
        builder.context.radiance.addAssign(irradiance.div(Math.PI));
        return;
      }
      const incident = positionWorld.sub(cameraPosition).normalize();
      const reflected = reflect(incident, N);
      // THE ROUGHNESS THE MATERIAL ACTUALLY SHADES WITH. `materialRoughness`
      // is a reference to the material's legacy SCALAR `.roughness`, which for
      // any shader-graph material is NOT what the BSDF uses — three's
      // NodeMaterial.setupVariants prefers `roughnessNode` when it is set, and
      // the editor's graph compiler sets it on every material it builds.
      // Reading the scalar here made the two disagree in the worst possible
      // way: giRoughnessBucketOf (which reads roughnessNode) put an authored
      // roughness-0 mirror in the MIRROR bucket, so the trace was compiled in,
      // while this gate saw the asset's stale scalar (0.7 in the user's
      // Mirror.mat) and multiplied it out at runtime — mirrorGate 0 on every
      // pixel, so the ball fell back to the blurry cascade lookup and then the
      // 0.22-0.6 collapse below flattened THAT to the diffuse limit too. Net
      // effect: a perfect mirror rendered as flat dark ambient ("reflections
      // still not showing"), with no way to tell from outside whether the code
      // was compiled out or gated out. Mirror setupVariants exactly.
      const materialRoughnessNode = builder.material?.roughnessNode;
      const roughness = (materialRoughnessNode ? float(materialRoughnessNode) : materialRoughness).clamp(0, 1);
      const softLookup = light.giRadianceNode
        ? vec3(light.giRadianceNode.sample(screenUV))
        : vec3(light.radianceFn(samplePoint, reflected));
      // Low roughness → the finest-angular cascade (sharpest reflection the
      // field can express); mid roughness → the mid cascade; high roughness
      // → the DENSEST-probe cascade (wide lobes don't resolve fine direction
      // bins, but they do resolve the sparse lattice as stripes), then the
      // cosine-average collapse below.
      let directional = softLookup;
      if (light.radianceSharpFn) {
        const sharpLookup = vec3(light.radianceSharpFn(samplePoint, reflected));
        directional = mix(sharpLookup, softLookup, smoothstep(0.02, 0.3, roughness));
      }
      if (light.radianceRoughFn) {
        const roughLookup = vec3(light.radianceRoughFn(samplePoint, reflected));
        directional = mix(directional, roughLookup, smoothstep(0.32, 0.55, roughness));
      }
      // FAST EXACT PATH. The shared BVH pass already traced the reflected
      // ray and texture-sampled the hit triangle. Blend that cached hit color
      // over the deferred directional cascade result for mirror-ish pixels.
      // This replaces the old per-material hit reconstruction/SDF/shadow
      // graph (tens of seconds to compile) with two texture reads and a mix.
      if (light.bvhReflectColorTexture && canMirror) {
        const exactHit = light.bvhReflectColorTexture.sample(screenUV);
        // THE HIT IS SHADED WHERE IT IS TRACED (see giScreen.js
        // createGiBvhReflect's SHADING note): the texture already holds the
        // reflected point's outgoing radiance, so there is nothing to apply
        // here — just blend it in.
        //
        // The legacy branch below is what that replaced, and it was wrong in
        // a way worth naming so it never comes back: `irradiance` is THIS
        // pixel's own irradiance — the RECEIVER's, not the hit's. Lighting a
        // reflected surface with the light falling on the mirror means a
        // mirror in shadow shows a darkened copy of a sunlit object, a mirror
        // in sunlight over-brightens everything it reflects, and the +0.06
        // floor existed only to stop reflections going fully black in a dark
        // corner. It survives solely for the (shade-less) fallback where the
        // resolve isn't up and the pass can only publish raw albedo.
        const exactRadiance = light.bvhReflectShaded
          ? exactHit.rgb
          : exactHit.rgb.mul(irradiance.div(Math.PI).add(vec3(0.06)));
        const exactWeight = exactHit.a.mul(smoothstep(0.45, 0.15, roughness));
        directional = mix(directional, exactRadiance, exactWeight);
      }
      // TRUE mirror reflections for low-roughness materials: one SDF
      // sphere-traced ray through the composited global field (cascade bins
      // bottom out ~5° — a real mirror needs a real ray, same as the
      // reference demo's analytic trace). Hit shading is Lumen-style
      // per-pixel: the nearest mesh SDF supplies a crisp normal + constant
      // albedo, analytic lights and promoted emitters are re-evaluated AT
      // THE HIT (short shadow trace each), and the trilinear INDIRECT field
      // adds the diffuse remainder — this is what keeps reflected surfaces
      // from smearing into cell-sized blobs (the reference does exactly
      // this with its analytic sun at reflection hits). Miss (t < 0) or a
      // degenerate neighborhood keeps the cascade lookup.
      if ((light.mirrorTraceFn || light.bvhReflectTexture) && light.mirrorSampleFn && canMirror) {
        // Wider roughness range than the old 0.08-0.3: mid-roughness metals
        // otherwise fall back to the cascade probe lookup, whose sparse
        // probe lattice banded visibly (vertical stripes on metallic
        // boxes). The traced result reads slightly too sharp for rough
        // metal, but sharp-and-stable beats banded.
        const mirrorGate = smoothstep(0.45, 0.15, roughness).toVar();
        const mirrorOut = vec3(0).toVar();
        const mirrorWeight = float(0).toVar();
        If(mirrorGate.greaterThan(0.001), () => {
          // t source: BVH (exact, static meshes) is AUTHORITATIVE except on
          // pixels whose ray can cross a BVH-excluded mesh — skinned
          // characters etc., flagged in the texture's g channel — where the
          // SDF trace joins via nearest-positive union (the SDF field still
          // carries those meshes, so they stay visible in mirrors).
          // An UNCONDITIONAL union was tried and REVERTED: the SDF's
          // melted-blob phantom hits sit IN FRONT of the true surface, so a
          // global min() re-sealed every silhouette the BVH fixed (the
          // harness contrast delta collapsed 20 → 0). Misses stay t < 0 →
          // cascade lookup, both paths; the BVH texture samples at the SAME
          // screen UV as irradiance.
          let mirrorT;
          // Texture-at-hit (GI Phase 3 v2) / exact-normal (GI Phase 3 v3):
          // set ONLY by the PURE DATAFLOW branch below, consumed at the
          // `hitPoint` offset and the `hitSurface.albedo`/`hitN` use sites
          // further down with the identical no-toVar/no-If discipline.
          // Every other branch (v1, BVH-only, SDF-only) leaves these null,
          // so hit shading there is byte-identical to before — unchanged.
          let bvhCol = null;
          let usedBvh = null;
          let nHit = null;
          if (light.bvhReflectTexture && (globalThis.__giBvhV1 || globalThis.__giBvhV1Light)) {
            // Exact v1 consumption (bisect hatch): direct .r, no toVar, no
            // coverage branch — the executor-verified build.
            mirrorT = light.bvhReflectTexture.sample(screenUV).r;
          } else if (light.bvhReflectTexture && light.mirrorTraceFn) {
            // PURE DATAFLOW, deliberately: the first version of this branch
            // hoisted the sample through `.toVar()` and gated the SDF trace
            // behind `If(flag)` — and rendered BLACK (bisected 2026-08-01:
            // v1-style direct-sample consumption + the SAME pass passes, so
            // the fault was in this branch's toVar/If structure, root cause
            // in three's codegen not chased). Direct sub-node reads + selects
            // are the v1 idiom that verifiably works. The unconditional SDF
            // trace costs what it cost before BVH existed.
            const tBvh = light.bvhReflectTexture.sample(screenUV).r;
            const dynFlag = light.bvhReflectTexture.sample(screenUV).g;
            const tSdf = light.mirrorTraceFn(samplePoint, reflected, light.mirrorRange ?? 24).t;
            const union = select(tBvh.lessThan(0), tSdf, select(tSdf.lessThan(0), tBvh, tBvh.min(tSdf)));
            mirrorT = select(dynFlag.greaterThan(0.5), union, tBvh);
            if (light.bvhReflectColorTexture) {
              // Same pure-dataflow rule as mirrorT above: direct sub-node
              // reads only, no `.toVar()`, no `If()`. `usedBvh` mirrors
              // mirrorT's own dynFlag/tBvh/tSdf selection (1 exactly when
              // mirrorT resolved to tBvh rather than the SDF/union), so the
              // real-texture substitution at the albedo use site below only
              // applies where the BVH actually supplied this pixel's hit.
              bvhCol = light.bvhReflectColorTexture.sample(screenUV);
              usedBvh = dynFlag.lessThanEqual(0.5).or(tBvh.greaterThanEqual(0).and(tSdf.lessThan(0).or(tBvh.lessThanEqual(tSdf))));
              // Exact hit normal (GI Phase 3 v3 — striping fix): octahedral-
              // decoded from bvhReflectTexture's OWN .zw (same texture as
              // t/dynFlag — see giScreen.js createGiBvhReflect's STRIPING
              // FIX comment). Direct texel read; decodeOctNormal is itself
              // a closed-form select() chain, no toVar/If anywhere in it.
              nHit = decodeOctNormal(light.bvhReflectTexture.sample(screenUV).zw);
            }
          } else if (light.bvhReflectTexture) {
            mirrorT = light.bvhReflectTexture.sample(screenUV).r;
          } else {
            mirrorT = light.mirrorTraceFn(samplePoint, reflected, light.mirrorRange ?? 24).t;
          }
          // STRIPING FIX (GI Phase 3 v3, see giScreen.js's comment on
          // createGiBvhReflect): a BVH-sourced hit (usedBvh) now stores the
          // RAW t (no ray-direction standoff), so this offsets along the
          // decoded EXACT FACE NORMAL instead — a distance perpendicular to
          // the surface regardless of the ray's grazing angle, unlike
          // offsetting along `reflected` (which barely moves the sample at
          // grazing angles — the root cause of the reported banded/striped
          // reflections). The SDF/union-sourced case is UNCHANGED: its own
          // march already undershoots the surface by ~0.45 cells
          // (giField.js createMirrorTrace) — that is its standoff,
          // offsetting it again would double up.
          //
          // Magnitude: 0.15x light.normalOffset — smaller than the OLD ray
          // standoff's own budget (`normalOffset·0.5`), tuned down in two
          // measured steps. (1) The FULL normalOffset regressed
          // run-gi-bvh-reflect (contrast 60.1 → 17.6): the torus-knot
          // regression scene's tube radius (0.28) is only ~2-3x
          // normalOffset, so that big a lift measurably blurred its fine
          // curved gaps. (2) Half-magnitude fixed that (contrast ~61, back
          // to baseline) but a SEPARATE supplementary check — a large flat
          // rough box, sampled with a 12-point luminance line across its
          // floor reflection — showed the offset ITSELF introducing a fine
          // speckle/moiré pattern on a TILTED flat face (6 direction
          // reversals) that a bisect (offset forced to zero) did not show
          // (2 reversals, ~monotonic): stepping a FIXED distance along a
          // normal that is not axis-aligned with the field's voxel grid
          // beats against the grid at fine (half-res-pixel) sampling
          // intervals. 0.15x keeps the fix's core property (offsetting
          // along the SURFACE normal, not the grazing-dependent ray) while
          // shrinking the step small enough to stay inside the same voxel
          // neighbourhood far more often — re-verified against both the
          // knot contrast test and the flat-box speckle test (see
          // docs/GI_PLAN.md verification notes for both rounds' numbers).
          const hitPointRay = samplePoint.add(reflected.mul(mirrorT.max(0)));
          const hitPoint = (
            nHit ? select(usedBvh, hitPointRay.add(nHit.mul(light.normalOffset.mul(0.15))), hitPointRay) : hitPointRay
          ).toVar();
          const sampled = light.mirrorSampleFn(hitPoint);
          const hitRad = vec3(sampled.rad).toVar();
          if (light.hitSurfaceFn && light.mirrorShadowFn && light.hitLighting) {
            const hitSurface = light.hitSurfaceFn(hitPoint);
            If(hitSurface.valid.greaterThan(0.5), () => {
              // Exact BVH face normal where it actually fed this hit (same
              // condition as the albedo substitution below) — sharper than
              // the SDF-gradient normal hitSurfaceFn falls back to, and the
              // one the STRIPING FIX above already offset hitPoint along.
              const hitN = bvhCol
                ? select(bvhCol.a.greaterThan(0.5).and(usedBvh), nHit, hitSurface.normal)
                : hitSurface.normal;
              const hitOrigin = hitPoint.add(hitN.mul(light.normalOffset)).toVar();
              const direct = vec3(0).toVar();
              if (light.emitterSlots?.length) {
                for (const slot of light.emitterSlots) {
                  If(slot.radius.greaterThan(0.001), () => {
                    const rel = vec3(slot.center).sub(hitPoint).toVar();
                    const dist = rel.length().max(1e-3).toVar();
                    const dirTo = rel.div(dist).toVar();
                    // Both sides — thin geometry has arbitrary facing (same
                    // convention as the feedback's voxel direct): flip the
                    // hit normal toward the emitter and use |cos|.
                    const cosH = dirTo.dot(hitN).abs().toVar();
                    const NhFlipped = select(dirTo.dot(hitN).greaterThanEqual(0), hitN, vec3(hitN).negate());
                    const sinRH = float(slot.radius).div(dist).clamp(0, 1).toVar();
                    const shadowH = float(1).toVar();
                    const k = dist.div(float(emitterAngularRadius(slot)).max(0.05)).clamp(1.2, 48);
                    const maxT = emitterSurfaceT(slot, hitOrigin, dirTo, dist).sub(light.shadowMargin).max(0);
                    If(maxT.greaterThan(light.shadowMargin), () => {
                      const ex = emitterExclusion(slot, float(light.shadowMargin));
                      const exRadius = ex.exRadius;
                      const exBox = ex.exBox;
                      shadowH.assign(
                        light.mirrorShadowFn(
                          hitOrigin, dirTo, maxT, k, cosH,
                          vec3(slot.center), exRadius, exBox,
                        ),
                      );
                    });
                    direct.addAssign(
                      vec3(slot.color).mul(emitterSlotFactor(slot, hitPoint, NhFlipped, cosH, sinRH)).mul(shadowH),
                    );
                  });
                }
              }
              if (light.lightSlots?.length) {
                for (const slot of light.lightSlots) {
                  If(slot.active.greaterThan(0.5), () => {
                    const isDir = float(slot.kind).toVar();
                    const rel = vec3(slot.vector).sub(hitPoint).toVar();
                    const pointDist = rel.length().max(1e-4).toVar();
                    const dirTo = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
                    let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
                    // Match three's PointLight `distance` cutoff (0 = infinite).
                    if (slot.range) {
                      const range = float(slot.range);
                      const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
                      const r2 = ratio.mul(ratio);
                      const win = r2.mul(r2).oneMinus().clamp(0, 1);
                      atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
                    }
                    const cosH = dirTo.dot(hitN).abs().toVar();
                    // Analytic lights are UNSHADOWED at reflection hits on
                    // purpose: shadowing them cost up to 4 extra traces per
                    // mirror pixel for a subtle error inside a reflection.
                    // Emitters (usually the dominant light) stay shadowed.
                    If(cosH.greaterThan(1e-4), () => {
                      direct.addAssign(vec3(slot.color).mul(atten).mul(cosH));
                    });
                  });
                }
              }
              // Real texture detail at the hit (GI Phase 3 v2) where the BVH
              // supplied it; the mean-color mesh-SDF albedo everywhere else
              // (a miss, the SDF-fallback union, or no color texture at
              // all) — inline select, nothing hoisted (see bvhCol's PURE
              // DATAFLOW note above).
              const hitAlbedo = bvhCol
                ? select(bvhCol.a.greaterThan(0.5).and(usedBvh), bvhCol.rgb, hitSurface.albedo)
                : hitSurface.albedo;
              hitRad.assign(sampled.rad.add(hitAlbedo.mul(direct).div(Math.PI)));
            });
          }
          mirrorOut.assign(hitRad);
          mirrorWeight.assign(mirrorGate.mul(step(0, mirrorT)).mul(sampled.coverage.clamp(0, 1)));
        });
        light._mirrorOut = mirrorOut;
        light._mirrorWeight = mirrorWeight;
      }

      // Emitter SPECULAR: the slot's area shape vs the roughness-widened
      // reflection lobe, energy-conserving (Karis representative-area
      // ratio), occluded by the slot's diffuse-direction penumbra. Added to
      // the FIELD path (inside the roughness collapse below — on rough
      // surfaces the widened-cone glow otherwise washes out diffuse
      // shadows entirely) AND to the mirror path (mirror pixels are
      // low-roughness, where the glow is sharp and correct).
      let glow = vec3(0);
      for (const { slot, shadow, dist, dirToEmitter, active } of emitterData) {
        const cosAng = dirToEmitter.dot(reflected);
        // Angular size from the slot's effective radius (exact for spheres,
        // mean-projected-area for boxes) — drives softness and energy.
        const sinR = float(emitterAngularRadius(slot)).div(dist).clamp(0, 1).toVar();
        // GGX-ish lobe widening: alpha = roughness², small floor for AA.
        const spread = roughness.mul(roughness).add(0.015).toVar();
        const effSin = sinR.add(spread).min(1).toVar();
        const cosEff = effSin.mul(effSin).oneMinus().max(0).sqrt().toVar();
        // Sphere slots: cone test around the direction to center (a disc
        // highlight is CORRECT for a sphere). Box slots: angular distance
        // from the reflected ray to the box's actual silhouette — the
        // reflection of a cube lamp is a cube, tilted the way the lamp is
        // tilted, not the disc the sphere model drew ("reflections from
        // emissives look like a sphere" report). Shaped slots (capsule/
        // cylinder/frustum/disc/torus): the same silhouette contract via
        // their SDF (shapeGlowMiss) — a torus lamp reflects as a ring.
        const inCone = float(smoothstep(cosEff, mix(cosEff, 1, 0.35), cosAng)).toVar();
        if (slot.kind) {
          const kindG = float(slot.kind);
          If(kindG.greaterThan(0.5).and(kindG.lessThan(1.5)), () => {
            const miss = boxGlowMiss(
              positionWorld, reflected,
              vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
            );
            inCone.assign(smoothstep(0.0, spread, miss).oneMinus());
          }).ElseIf(kindG.greaterThan(1.5), () => {
            const miss = shapeGlowMiss(
              positionWorld, reflected, kindG,
              vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
            );
            inCone.assign(smoothstep(0.0, spread, miss).oneMinus());
          });
        }
        const energy = sinR.mul(sinR).div(effSin.mul(effSin).max(1e-6));
        glow = glow.add(vec3(slot.color).mul(inCone).mul(energy).mul(shadow).mul(active));
      }

      const diffuseLimit = irradiance.div(Math.PI);
      // Banding collapse applies to the PROBE-LATTICE lookup (and the
      // glow): mid-rough surfaces read the cascade radiance lookup, whose
      // spatial banding showed as vertical stripes on rough white boxes —
      // fade THAT toward the diffuse limit with roughness. The traced
      // mirror result is composited AFTERWARD so it is never diluted by
      // this collapse (the old ordering mixed the mirror into the lookup
      // first, which is why a roughness-0.3 "mirror" read as washed-out
      // diffuse).
      let spec = mix(
        directional.add(glow).mul(light.intensityUniform),
        diffuseLimit,
        smoothstep(0.22, 0.6, roughness),
      );
      if (light._mirrorOut) {
        spec = mix(
          spec,
          light._mirrorOut.add(glow).mul(light.intensityUniform),
          light._mirrorWeight,
        );
        light._mirrorOut = null;
        light._mirrorWeight = null;
      }

      builder.context.radiance.addAssign(spec);
    }
  }
}

const registeredRenderers = new WeakSet();

/** Registers the light-node pairing once per renderer (survives renderer swaps). */
export function registerGILight(renderer) {
  if (!renderer?.library || registeredRenderers.has(renderer)) return;
  renderer.library.addLight(GICascadeLightNode, GICascadeLight);
  registeredRenderers.add(renderer);
}
