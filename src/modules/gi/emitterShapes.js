// ANALYTIC EMITTER SHAPES — the scalar reference for every emitter-slot kind,
// and the ONE place that decides which analytic shape a three.js geometry is.
//
// WHY THIS FILE EXISTS. Promoted emissive meshes light the scene analytically
// (giLight.js emitterSlotFactor); everything the analytic path cannot
// represent falls back to the voxel field, whose lattice is exactly the
// "blocky and flickery" light the user reports from moving/rotating lamps.
// Before 2026-08-08 the analytic path knew two shapes: sphere and oriented
// box, so a cylinder/torus/cone/capsule/disc lamp was lit (and reflected, and
// shadowed) as its bounding box. This file adds the missing shapes as CLOSED
// FORMS, each verified against Monte-Carlo surface integration in
// scripts/run-gi-emitter-shapes-test.mjs.
//
// THE CONTRACT. Everything here is scalar JS with no TSL: the GPU versions in
// giLight.js mirror these bodies EXPRESSION FOR EXPRESSION, and the test
// arbitrates THIS file against brute-force integration. If you change a
// formula here, change its TSL twin (the function names match) — a divergence
// between the two shows up as light that changes when the same lamp is viewed
// via a different path (receiver direct vs feedback inject vs reflection hit).
//
// CONVENTIONS (identical to giLight.js):
//   · factor F = ∫ over the shape's visible solid angle of cosθ_receiver dω,
//     so irradiance E = slot radiance · F, and F ∈ [0, π].
//   · P = receiver world position, N = unit receiver normal.
//   · A slot's shape lives in `kind` + `center` + `half` + axes bx/by/bz
//     (unit, world) + `radius` (world bounding sphere, the active gate and
//     trace self-exclusion — every kind keeps it).
//   · `by` IS THE SYMMETRY AXIS for every shaped kind. The fitter maps each
//     geometry's local axis onto by (cylinder family: local Y; torus/disc
//     family: local Z), so the shader never needs to know which local axis a
//     geometry used.
//
// SLOT `half` SEMANTICS PER KIND (world units, scale already applied):
//   0 sphere   — unused (radius carries the shape)
//   1 box      — half extents along bx/by/bz (pre-existing)
//   2 capsule  — x: tube radius, y: HALF the cylinder-section length, z: = x
//   3 cylinder — x: radius, y: half height, z: = x (flat caps)
//   4 frustum  — x: radius at the −by end, y: half height, z: radius at +by
//                (cone = frustum with z = 0)
//   5 disc     — x: outer radius, y: ~0 (thickness epsilon), z: inner radius
//                (0 for a full disc; RingGeometry sets it)
//   6 torus    — x: ring radius (centreline), y: tube radius, z: tube radius
//
// THE MATH, shape by shape (derivations kept because the next reader will
// otherwise re-derive them wrong — I did, twice, before the MC arbiter):
//
// TUBE SIDE (capsule/cylinder/frustum lateral surface). A diffuse cylinder of
// radius r and radiance L radiates, per unit length, like a diffuse LINE with
// intensity I(direction) = L·2r·sinα (α = angle to the axis): the projected
// silhouette width is 2r from every side direction. This line model is
// energy-EXACT (∫ 2rL·sinα dΩ = 2π²rL = the side's true emitted flux) and
// error only appears in the near field (d ≲ 2r), where the MC test bounds it.
// With the receiver at the origin, ĉ = unit vector to the axis FOOT
// (perpendicular), h = distance to the axis, ℓ̂ = axis direction, a point on
// the axis is x(u) = h·ĉ + u·ℓ̂ and
//   E/L = 2·∫ r(u) · (h/d) · (h·Cn + u·Ln)/d / d² du,   d² = h²+u²,
//         Cn = ĉ·N, Ln = ℓ̂·N, r(u) = ra + s·u (s = slope, 0 for a cylinder).
// Expanding gives three primitive integrals with closed forms:
//   A(u) = u/(2(h²+u²)) + atan(u/h)/(2h)     [= h²·∫du/d⁴]
//   B(u) = −1/(2(h²+u²))                     [=    ∫u·du/d⁴]
//   C(u) = −u/(2(h²+u²)) + atan(u/h)/(2h)    [=    ∫u²·du/d⁴]
//   E/L = 2·( ra·Cn·ΔA + (ra·Ln + s·h·Cn)·h·ΔB + s·Ln·h·ΔC )
// The receiver-horizon factor (h·Cn + u·Ln) is LINEAR in u, so the horizon
// clip is EXACT: intersect [u0,u1] with the half-line where it is positive.
// (This is what the box path approximates with per-face max(0) — the tube
// gets it exactly for free.)
//
// SPHERE-CAP ENDS (capsule): each hemisphere cap ≈ half a sphere light at its
// end centre (exact in the far field: the two hemispheres project to one full
// disc πr², and two half-weight spheres project the same). Orientation of the
// caps is ignored; the MC test bounds what that costs (a few % of the total,
// worst side-on close up).
//
// DISC (and cylinder/frustum caps, and rings). The vector irradiance of a
// one-sided diffuse disc has an exact closed form. With H = height of the
// receiver above the disc plane (emitting side), ρ = in-plane distance from
// the disc axis, r = disc radius:
//   X  = r² + ρ² + H²
//   Q  = √(X² − 4·r²·ρ²)        [= √((H²+ρ²−r²)² + 4H²r²), same number]
//   V_ax  = (π/2)·(1 − (H²+ρ²−r²)/Q)      — component along −d̂ (toward the
//            plane; on-axis check: π·r²/(r²+H²), the classic result)
//   V_rad = (π·H/(2ρ))·(1 − X/Q)          — component along m̂ (axis→receiver
//            in-plane; ≤ 0 always — the disc pulls toward its axis)
//   F = max(0, N·(V_ax·(−d̂) + V_rad·m̂))
// Both come from φ-integrals of 1/d⁴ (∫dφ/(a−b·cosφ)² = 2πa/(a²−b²)^{3/2} et
// al.) followed by one radial integral; the far field limits reproduce the
// point-source vector irradiance exactly, and the MC test holds the general
// position to ~1%. A RING is the difference of two discs — the vector form is
// linear in the emitting region, so F_ring = F_disc(rOuter) − F_disc(rInner),
// still exact. Horizon handling is the same clamped-linear convention as box
// faces (exact when the whole disc is above the receiver's horizon, a smooth
// under-estimate when it straddles it).
//
// TORUS. No usable closed form exists; the model is K chord segments of tube
// around the centreline circle, ANCHORED TO THE RECEIVER'S AZIMUTH: segment
// midpoints start at the in-plane direction toward the receiver, so the
// approximation is rotation-invariant about the torus axis (a spinning torus
// lamp cannot flicker by construction) and seam-free as the receiver moves
// (the anchor direction turns smoothly with P — no trig needed, just the
// normalized in-plane component of P−center). The chord polygon is shorter
// than the arc; the tube radius is scaled by arc/chord so the model's surface
// area (and far-field power) stays exact. Self-shadowing of the far side is
// ignored (the hole sees through) — the MC arbiter, WITH real torus
// self-occlusion, bounds the total error.
//
// POLYHEDRA (tetra/octa/icosa/dodeca). Round-ish solids: a sphere of equal
// SURFACE AREA (Cauchy: mean projected area = S/4 for convex bodies, so equal
// area ⇒ equal far-field power). The constants below are S(circumradius r)
// exactly; the test re-derives them from real geometry triangles. detail ≥ 1
// re-projects vertices to the circumsphere, so those use the sphere directly.
//
// WHAT DELIBERATELY STAYS A BOX: partial spheres/cylinders/rings (thetaLength
// < 2π — an arc section's OBB is honest), Extrude/Shape/Tube/Text, and any
// imported BufferGeometry that primitiveFit.js does not recognise. Lathe maps
// to a cylinder (its OBB is square in cross-section — a vase lamp would glow
// as a box), TorusKnot to its torus (shape-true pool and reflection; its
// extra curve length under-reports energy slightly, documented there).

import * as THREE from "three/webgpu";
import { fitPrimitive } from "./primitiveFit.js";

/** Chord-segment count for the torus model. 8 keeps the worst mid-field MC
 *  error in single digits while costing 16 atans per factor — measured fine
 *  for a ≤4-slot budget. The rotation-invariance does NOT depend on K. */
export const TORUS_SEGMENTS = 8;

/** arc/chord compensation for TORUS_SEGMENTS (area- and power-exactness). */
export const TORUS_CHORD_COMP = (Math.PI / TORUS_SEGMENTS) / Math.sin(Math.PI / TORUS_SEGMENTS);

/** Emitter shape kinds (slot.kind values). Order is load-bearing: the GPU
 *  branches compare against these constants, and 0/1 predate this file. */
export const EMITTER_KIND = Object.freeze({
  SPHERE: 0,
  BOX: 1,
  CAPSULE: 2,
  CYLINDER: 3,
  FRUSTUM: 4,
  DISC: 5,
  TORUS: 6,
});

// ---------------------------------------------------------------------------
// Scalar reference implementations. These are the arbiter's subjects and the
// TSL bodies' twins — keep them dependency-free and allocation-free.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Mirror of giLight.js sphereLightFactor (horizon-aware Hermite fade). */
export function refSphereFactor(cosTheta, sinR) {
  if (cosTheta >= sinR) return Math.PI * sinR * sinR * cosTheta;
  const t = clamp((cosTheta + sinR) / Math.max(2 * sinR, 1e-4), 0, 1);
  return Math.PI * sinR * sinR * (sinR * t * t);
}

/** Sphere-slot factor at receiver P/N for a sphere at `c` radius `r`. */
export function refSphereAt(P, N, c, r) {
  const dx = c[0] - P[0], dy = c[1] - P[1], dz = c[2] - P[2];
  const d = Math.max(Math.hypot(dx, dy, dz), 1e-3);
  const cosTheta = (dx * N[0] + dy * N[1] + dz * N[2]) / d;
  const sinR = clamp(r / d, 0, 1);
  return refSphereFactor(cosTheta, sinR);
}

/** Mirror of giLight.js boxLightFactor (exact Lambert contour per face). */
export function refBoxFactor(P, N, center, half, bx, by, bz) {
  const faces = [
    [bx, half[0], by, half[1], bz, half[2]],
    [[-bx[0], -bx[1], -bx[2]], half[0], bz, half[2], by, half[1]],
    [by, half[1], bz, half[2], bx, half[0]],
    [[-by[0], -by[1], -by[2]], half[1], bx, half[0], bz, half[2]],
    [bz, half[2], bx, half[0], by, half[1]],
    [[-bz[0], -bz[1], -bz[2]], half[2], by, half[1], bx, half[0]],
  ];
  let F = 0;
  const u = [0, 0, 0], v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0], v3 = [0, 0, 0];
  for (const [w, hw, euAxis, hu, evAxis, hv] of faces) {
    const fc = [center[0] + w[0] * hw, center[1] + w[1] * hw, center[2] + w[2] * hw];
    const facing = (P[0] - fc[0]) * w[0] + (P[1] - fc[1]) * w[1] + (P[2] - fc[2]) * w[2];
    if (facing <= 1e-4) continue;
    const eu = [euAxis[0] * hu, euAxis[1] * hu, euAxis[2] * hu];
    const ev = [evAxis[0] * hv, evAxis[1] * hv, evAxis[2] * hv];
    const corner = (out, su, sv) => {
      out[0] = fc[0] + su * eu[0] + sv * ev[0] - P[0];
      out[1] = fc[1] + su * eu[1] + sv * ev[1] - P[1];
      out[2] = fc[2] + su * eu[2] + sv * ev[2] - P[2];
      const len = Math.hypot(out[0], out[1], out[2]) || 1;
      out[0] /= len; out[1] /= len; out[2] /= len;
    };
    corner(v0, 1, 1); corner(v1, 1, -1); corner(v2, -1, -1); corner(v3, -1, 1);
    const edge = (a, b) => {
      u[0] = a[1] * b[2] - a[2] * b[1];
      u[1] = a[2] * b[0] - a[0] * b[2];
      u[2] = a[0] * b[1] - a[1] * b[0];
      const cl = Math.max(Math.hypot(u[0], u[1], u[2]), 1e-6);
      const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
      return Math.acos(dot) * ((u[0] * N[0] + u[1] * N[1] + u[2] * N[2]) / cl);
    };
    const faceSum = 0.5 * (edge(v0, v1) + edge(v1, v2) + edge(v2, v3) + edge(v3, v0));
    F += Math.max(faceSum, 0);
  }
  return F;
}

/**
 * Tube-side factor: lateral surface of a capsule/cylinder/frustum.
 * a3/b3 = world endpoints of the AXIS segment; ra/rb = radii at those ends.
 * Exact receiver-horizon clip (see the derivation in the header).
 */
export function refTubeSideFactor(P, N, a3, b3, ra, rb) {
  const lx = b3[0] - a3[0], ly = b3[1] - a3[1], lz = b3[2] - a3[2];
  const len = Math.hypot(lx, ly, lz);
  if (len < 1e-6) return 0;
  const il = 1 / len;
  const ax = lx * il, ay = ly * il, az = lz * il; // ℓ̂
  const rx = P[0] - a3[0], ry = P[1] - a3[1], rz = P[2] - a3[2];
  const tFoot = rx * ax + ry * ay + rz * az;
  // Perpendicular from the axis to the receiver; ĉ points receiver→axis.
  let px = rx - ax * tFoot, py = ry - ay * tFoot, pz = rz - az * tFoot;
  const h = Math.hypot(px, py, pz);
  if (h <= 1e-9) return 0;
  px /= h; py /= h; pz /= h;
  // NEAR-FIELD DEPTH CORRECTION. The line model lumps the tube's emission on
  // its AXIS, but the brightness-weighted surface sits closer: over the
  // visible half-cylinder, emission weights cosψ and depth is r·cosψ, so the
  // weighted mean depth toward the receiver is r·(∫cos²/∫cos) = (π/4)·r.
  // Shifting the line by that much makes the model first-order exact in r/h
  // (the MC arbiter measured the unshifted model −20% on a fat cone at 1.5×
  // and the shifted one single-digit); the shift vanishes in the far field
  // by construction. Floored so a receiver closer than the surface stays
  // finite — the π clamp and the slot gates own that regime.
  // NEAR-FIELD NOTE, measured so nobody "fixes" it twice: the line model
  // evaluates the tube's emission ON its axis, but the brightness-weighted
  // surface sits ~π/4·r closer (⟨cosψ⟩ over the visible half). A first-order
  // h-shift was implemented and REVERTED 2026-08-08: the O(r²/h²) lateral
  // moments fight the shift with the opposite sign, no single damping
  // constant fits cylinder and cone at once, and the un-shifted model's
  // whole error budget (single digits at 2.5×maxDim, see the MC arbiter's
  // per-shape bounds) is smooth, direction-continuous and invisible without
  // a reference — while a mis-fitted shift OVERSHOOTS, which the horizon arm
  // catches as light behind the receiver plane. Exact far field matters
  // more than the last 10% at touching distance; the slot gates and
  // self-exclusion own the contact regime anyway.
  //
  // The closed form's atan(u/h) terms catastrophically cancel below
  // h ≈ 1e-3·len in f32, so the clamp serves both physics and precision.
  const hSafe = Math.max(h, 1e-3 * len, 1e-5);
  const cx = -px, cy = -py, cz = -pz; // ĉ = receiver → axis foot
  const Cn = cx * N[0] + cy * N[1] + cz * N[2];
  const Ln = ax * N[0] + ay * N[1] + az * N[2];
  let u0 = -tFoot, u1 = len - tFoot;
  // Exact horizon clip: keep u where h·Cn + u·Ln > 0.
  const hb = hSafe;
  if (Math.abs(Ln) > 1e-6) {
    const uH = (-hb * Cn) / Ln;
    if (Ln > 0) u0 = Math.max(u0, uH);
    else u1 = Math.min(u1, uH);
  } else if (Cn <= 0) {
    return 0;
  }
  if (u1 <= u0) return 0;
  const s = (rb - ra) / len; // radius slope per unit u
  const raAtU0 = ra + s * (u0 - -tFoot); // r(u) = ra + s·(u − u0_original)
  const A = (u) => u / (2 * (hb * hb + u * u)) + Math.atan(u / hb) / (2 * hb);
  const B = (u) => -1 / (2 * (hb * hb + u * u));
  const C = (u) => -u / (2 * (hb * hb + u * u)) + Math.atan(u / hb) / (2 * hb);
  // r(u) referenced from the CLIPPED u0: r(u) = raAtU0 + s·(u − u0)
  // ⇒ ra' = raAtU0 − s·u0 in the r(u) = ra' + s·u form the integrals use.
  const raP = raAtU0 - s * u0;
  const dA = A(u1) - A(u0), dB = B(u1) - B(u0), dC = C(u1) - C(u0);
  const F = 2 * (raP * Cn * dA + (raP * Ln + s * hb * Cn) * hb * dB + s * Ln * hb * dC);
  return Math.max(F, 0);
}

/**
 * One-sided disc factor (exact vector irradiance — header derivation).
 * `c` = disc centre, `axis` = UNIT emitting-side normal candidate; twoSided
 * flips it toward the receiver. rInner > 0 makes it a ring (exact by
 * linearity: outer minus inner).
 */
export function refDiscFactor(P, N, c, axis, rOuter, rInner = 0, twoSided = true) {
  let dxn = axis[0], dyn = axis[1], dzn = axis[2];
  const rx = P[0] - c[0], ry = P[1] - c[1], rz = P[2] - c[2];
  let H = rx * dxn + ry * dyn + rz * dzn;
  if (twoSided && H < 0) { dxn = -dxn; dyn = -dyn; dzn = -dzn; H = -H; }
  if (H <= 1e-5) return 0;
  let mx = rx - dxn * H, my = ry - dyn * H, mz = rz - dzn * H;
  const rho = Math.hypot(mx, my, mz);
  if (rho > 1e-9) { mx /= rho; my /= rho; mz /= rho; } else { mx = 0; my = 0; mz = 0; }
  const rhoSafe = Math.max(rho, 1e-5);
  const one = (r) => {
    if (!(r > 1e-6)) return [0, 0];
    const X = r * r + rhoSafe * rhoSafe + H * H;
    const Q = Math.sqrt(Math.max(X * X - 4 * r * r * rhoSafe * rhoSafe, 1e-12));
    const vAx = (Math.PI / 2) * (1 - (H * H + rhoSafe * rhoSafe - r * r) / Q);
    const vRad = ((Math.PI * H) / 2) * ((1 - X / Q) / rhoSafe);
    return [vAx, vRad];
  };
  const [axO, radO] = one(rOuter);
  const [axI, radI] = one(rInner);
  const vAx = axO - axI, vRad = radO - radI;
  // F = N · ( V_ax·(−d̂) + V_rad·m̂ ), clamped at the horizon.
  const F = vAx * -(dxn * N[0] + dyn * N[1] + dzn * N[2]) + vRad * (mx * N[0] + my * N[1] + mz * N[2]);
  return Math.max(F, 0);
}

/**
 * Capsule = tube side + hemisphere caps as VIEW-WEIGHTED sphere lights.
 * A hemisphere's projected area from angle χ off its pole is the classic
 * ½πr²·(1+cosχ), so each cap contributes ½(1+cosχ) of the full sphere
 * factor (χ against its outward axis). Far field this is EXACT in every
 * direction: side-on ½+½ = one disc, end-on 1+~0 = one disc — where the
 * old fixed ½/½ was 35% dark end-on (MC-measured) and right only side-on.
 */
export function refCapsuleFactor(P, N, c, axis, halfLen, r) {
  const a3 = [c[0] - axis[0] * halfLen, c[1] - axis[1] * halfLen, c[2] - axis[2] * halfLen];
  const b3 = [c[0] + axis[0] * halfLen, c[1] + axis[1] * halfLen, c[2] + axis[2] * halfLen];
  const side = refTubeSideFactor(P, N, a3, b3, r, r);
  const wA = capWeight(P, a3, [-axis[0], -axis[1], -axis[2]]);
  const wB = capWeight(P, b3, axis);
  const caps = wA * refSphereAt(P, N, a3, r) + wB * refSphereAt(P, N, b3, r);
  return Math.min(side + caps, Math.PI);
}

/** ½(1+cosχ): the fraction of a full sphere a pole-out hemisphere shows
 *  from direction χ off its outward axis. */
function capWeight(P, capCenter, outward) {
  const dx = P[0] - capCenter[0], dy = P[1] - capCenter[1], dz = P[2] - capCenter[2];
  const d = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const cosChi = (dx * outward[0] + dy * outward[1] + dz * outward[2]) / d;
  return 0.5 * (1 + cosChi);
}

/** Cylinder = tube side + two one-sided disc caps. */
export function refCylinderFactor(P, N, c, axis, halfLen, r) {
  const a3 = [c[0] - axis[0] * halfLen, c[1] - axis[1] * halfLen, c[2] - axis[2] * halfLen];
  const b3 = [c[0] + axis[0] * halfLen, c[1] + axis[1] * halfLen, c[2] + axis[2] * halfLen];
  const side = refTubeSideFactor(P, N, a3, b3, r, r);
  const capA = refDiscFactor(P, N, a3, [-axis[0], -axis[1], -axis[2]], r, 0, false);
  const capB = refDiscFactor(P, N, b3, axis, r, 0, false);
  return Math.min(side + capA + capB, Math.PI);
}

/**
 * Frustum: linear-radius tube side + one-sided discs, MINUS the silhouette
 * overlap. For a straight cylinder, [side band + one visible cap] tiles the
 * projected silhouette exactly (the classic 2rL·sinγ + πr²·cosγ identity).
 * For a TAPERED frustum they overlap: seen obliquely from the wide end, the
 * silhouette gains only the base rim's HALF-ellipse, but the one-sided base
 * disc contributes the whole ellipse — the excess is half the (rB²−rT²) RING,
 * and it grows with how side-on the view is. Subtracting that ring's half,
 * scaled by sinγ of the view direction, restores the far field to a few
 * percent in every direction (MC-graded) while keeping the on-axis case
 * (where the full base is genuinely visible and the side vanishes) exact.
 */
export function refFrustumFactor(P, N, c, axis, halfLen, rBottom, rTop) {
  const a3 = [c[0] - axis[0] * halfLen, c[1] - axis[1] * halfLen, c[2] - axis[2] * halfLen];
  const b3 = [c[0] + axis[0] * halfLen, c[1] + axis[1] * halfLen, c[2] + axis[2] * halfLen];
  const side = refTubeSideFactor(P, N, a3, b3, rBottom, rTop);
  const negAxis = [-axis[0], -axis[1], -axis[2]];
  let capA = refDiscFactor(P, N, a3, negAxis, rBottom, 0, false);
  let capB = rTop > 1e-6 ? refDiscFactor(P, N, b3, axis, rTop, 0, false) : 0;
  if (Math.abs(rBottom - rTop) > 1e-6) {
    // sinγ of the view direction vs the axis, measured at the shape centre —
    // 0 on-axis (the full wide cap is genuinely the silhouette), 1 side-on
    // (each rim contributes its half-ellipse). The wider end's RING (its
    // radius down to the other end's) is what transitions:
    //   facing the wide cap: the one-sided disc over-counts by half the
    //     ring (the side band already covers that silhouette) → subtract;
    //   wide cap BACKFACING: the rim's half-ellipse is real silhouette no
    //     term provides → add half the TWO-SIDED ring.
    // Branchless: the two-sided ring equals the one-sided ring when facing
    // and replaces it when not, so one expression serves both sides and is
    // continuous through edge-on (both rings → 0 there).
    const rel = sub3(P, c);
    const d = Math.max(len3(rel), 1e-6);
    const cosG = Math.abs(dot3(rel, axis)) / d;
    const sinG = Math.sqrt(Math.max(1 - cosG * cosG, 0));
    const wideAtA = rBottom > rTop;
    const cWide = wideAtA ? a3 : b3;
    const nWide = wideAtA ? negAxis : axis;
    const rWide = wideAtA ? rBottom : rTop;
    const rNarrow = wideAtA ? rTop : rBottom;
    const oneW = wideAtA ? capA : capB;
    const oneN = rNarrow > 1e-6 ? refDiscFactor(P, N, cWide, nWide, rNarrow, 0, false) : 0;
    const twoW = refDiscFactor(P, N, cWide, nWide, rWide, 0, true);
    const twoN = rNarrow > 1e-6 ? refDiscFactor(P, N, cWide, nWide, rNarrow, 0, true) : 0;
    const ringOne = Math.max(oneW - oneN, 0);
    const ringTwo = Math.max(twoW - twoN, 0);
    const corrected = oneW - sinG * ringOne + 0.5 * sinG * ringTwo;
    if (wideAtA) capA = corrected; else capB = corrected;
  }
  return Math.min(side + capA + capB, Math.PI);
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Shortest distance between the segment [p, q] and the segment [a, b] —
 * the torus model's self-occlusion oracle (below). Standard closed form,
 * clamped parameters, smooth in all inputs away from degeneracies.
 */
export function segSegDistance(p, q, a, b) {
  const d1 = sub3(q, p), d2 = sub3(b, a), r = sub3(p, a);
  const A = dot3(d1, d1), E = dot3(d2, d2), F = dot3(d2, r);
  let s, t;
  if (A <= 1e-12 && E <= 1e-12) { s = 0; t = 0; }
  else if (A <= 1e-12) { s = 0; t = Math.min(Math.max(F / E, 0), 1); }
  else {
    const C = dot3(d1, r);
    if (E <= 1e-12) { t = 0; s = Math.min(Math.max(-C / A, 0), 1); }
    else {
      const B = dot3(d1, d2);
      const denom = A * E - B * B;
      s = denom > 1e-12 ? Math.min(Math.max((B * F - C * E) / denom, 0), 1) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = Math.min(Math.max(-C / A, 0), 1); }
      else if (t > 1) { t = 1; s = Math.min(Math.max((B - C) / A, 0), 1); }
    }
  }
  const c1 = add3(p, mul3(d1, s)), c2 = add3(a, mul3(d2, t));
  return len3(sub3(c1, c2));
}
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/**
 * Torus: TORUS_SEGMENTS chord tubes around the centreline, anchored to the
 * receiver's in-plane azimuth (rotation-invariant, seam-free — header note).
 */
export function refTorusFactor(P, N, c, axis, ringR, tubeR) {
  const rx = P[0] - c[0], ry = P[1] - c[1], rz = P[2] - c[2];
  const H = rx * axis[0] + ry * axis[1] + rz * axis[2];
  let ex = rx - axis[0] * H, ey = ry - axis[1] * H, ez = rz - axis[2] * H;
  const eLen = Math.hypot(ex, ey, ez);
  if (eLen > 1e-6) {
    ex /= eLen; ey /= eLen; ez /= eLen;
  } else {
    // Receiver on the axis: any in-plane anchor gives the same answer.
    const pick = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    ex = pick[0] - axis[0] * axis[0] * pick[0]; // orthogonalize
    ey = pick[1] - axis[1] * (axis[0] * pick[0] + axis[1] * pick[1] + axis[2] * pick[2]);
    // Cheap Gram-Schmidt, then normalize:
    const d = axis[0] * pick[0] + axis[1] * pick[1] + axis[2] * pick[2];
    ex = pick[0] - axis[0] * d; ey = pick[1] - axis[1] * d; ez = pick[2] - axis[2] * d;
    const l = Math.hypot(ex, ey, ez) || 1;
    ex /= l; ey /= l; ez /= l;
  }
  // ê₂ = axis × ê₁ completes the in-plane basis.
  const fx = axis[1] * ez - axis[2] * ey;
  const fy = axis[2] * ex - axis[0] * ez;
  const fz = axis[0] * ey - axis[1] * ex;
  const rt = tubeR * TORUS_CHORD_COMP;
  const K = TORUS_SEGMENTS;
  let F = 0;
  const pA = [0, 0, 0], pB = [0, 0, 0], mid = [0, 0, 0];
  // The near chord (segment 0 spans the receiver azimuth) is the occluder
  // every other segment's light must clear: seen edge-on, the near half of
  // the ring hides the far half (MC measured the un-occluded model +50%).
  // Visibility per segment = how far the sight line to its midpoint passes
  // from the near chord, smoothed over the tube's own thickness — pure
  // geometry, no tuned constants beyond the rt tangency scale, smooth in P
  // and rotation-invariant like the rest of the model.
  const nA = [0, 0, 0], nB = [0, 0, 0];
  {
    const phiA = -0.5 * (2 * Math.PI / K), phiB = 0.5 * (2 * Math.PI / K);
    const cA = Math.cos(phiA) * ringR, sA = Math.sin(phiA) * ringR;
    const cB = Math.cos(phiB) * ringR, sB = Math.sin(phiB) * ringR;
    nA[0] = c[0] + ex * cA + fx * sA; nA[1] = c[1] + ey * cA + fy * sA; nA[2] = c[2] + ez * cA + fz * sA;
    nB[0] = c[0] + ex * cB + fx * sB; nB[1] = c[1] + ey * cB + fy * sB; nB[2] = c[2] + ez * cB + fz * sB;
  }
  for (let i = 0; i < K; i++) {
    // Segment i spans [φi, φi+Δ] with the FIRST segment centred on the
    // receiver azimuth (φ from −Δ/2), so the nearest tube element is always
    // mid-segment — the best-approximated place is the one that dominates.
    const phiA = (i - 0.5) * (2 * Math.PI / K);
    const phiB = (i + 0.5) * (2 * Math.PI / K);
    const cA = Math.cos(phiA) * ringR, sA = Math.sin(phiA) * ringR;
    const cB = Math.cos(phiB) * ringR, sB = Math.sin(phiB) * ringR;
    pA[0] = c[0] + ex * cA + fx * sA; pA[1] = c[1] + ey * cA + fy * sA; pA[2] = c[2] + ez * cA + fz * sA;
    pB[0] = c[0] + ex * cB + fx * sB; pB[1] = c[1] + ey * cB + fy * sB; pB[2] = c[2] + ez * cB + fz * sB;
    let vis = 1;
    // Neighbours of the near chord are never truly occluded (the arc is
    // locally convex — nothing of the ring lies between the receiver and
    // the adjacent 45°), but their sight lines DO pass near the shared
    // chord endpoints, so testing them would falsely dim the near region.
    if (i > 1 && i < K - 1) {
      mid[0] = (pA[0] + pB[0]) / 2; mid[1] = (pA[1] + pB[1]) / 2; mid[2] = (pA[2] + pB[2]) / 2;
      const clear = segSegDistance(P, mid, nA, nB);
      // Penumbra band CENTRED on tangency (clear = rt: the sight line to the
      // far tube's centreline grazes the near tube's surface — half the far
      // tube is hidden, so vis = 0.5 there), spanning ±0.8·rt for the far
      // tube's own width.
      const t = Math.min(Math.max((clear - 0.2 * rt) / (1.6 * rt), 0), 1);
      vis = t * t * (3 - 2 * t);
    }
    if (vis > 1e-4) F += vis * refTubeSideFactor(P, N, pA, pB, rt, rt);
  }
  return Math.min(F, Math.PI);
}

/** Dispatch a scalar shape record {kind, center, half, bx, by, bz, radius}
 *  (arrays for vectors) to its factor — the test drives everything through
 *  this so the dispatch itself is under test. */
export function refShapeFactor(shape, P, N) {
  const { kind, center: c, half, by } = shape;
  switch (kind) {
    case EMITTER_KIND.SPHERE:
      return refSphereAt(P, N, c, shape.radius);
    case EMITTER_KIND.BOX:
      return refBoxFactor(P, N, c, half, shape.bx, by, shape.bz);
    case EMITTER_KIND.CAPSULE:
      return refCapsuleFactor(P, N, c, by, half[1], half[0]);
    case EMITTER_KIND.CYLINDER:
      return refCylinderFactor(P, N, c, by, half[1], half[0]);
    case EMITTER_KIND.FRUSTUM:
      return refFrustumFactor(P, N, c, by, half[1], half[0], half[2]);
    case EMITTER_KIND.DISC:
      return refDiscFactor(P, N, c, by, half[0], half[2], true);
    case EMITTER_KIND.TORUS:
      return refTorusFactor(P, N, c, by, half[0], half[1]);
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Mean-projected-area-equivalent radius (drives penumbra k and glow energy;
// Cauchy: mean projected area of a convex body = surface/4). The torus and
// disc are not convex/solid, but S/4 remains the right scale for a penumbra.

export function shapeMeanProjRadius(kind, half, radius) {
  switch (kind) {
    case EMITTER_KIND.BOX: {
      const [hx, hy, hz] = half;
      return Math.sqrt(((hx * hy + hy * hz + hz * hx) * 2) / Math.PI);
    }
    case EMITTER_KIND.CAPSULE: {
      const r = half[0], L = half[1] * 2;
      return Math.sqrt((2 * Math.PI * r * L + 4 * Math.PI * r * r) / (4 * Math.PI));
    }
    case EMITTER_KIND.CYLINDER: {
      const r = half[0], L = half[1] * 2;
      return Math.sqrt((2 * Math.PI * r * L + 2 * Math.PI * r * r) / (4 * Math.PI));
    }
    case EMITTER_KIND.FRUSTUM: {
      const rB = half[0], rT = half[2], L = half[1] * 2;
      const slant = Math.hypot(L, rB - rT);
      const S = Math.PI * (rB + rT) * slant + Math.PI * (rB * rB + rT * rT);
      return Math.sqrt(S / (4 * Math.PI));
    }
    case EMITTER_KIND.DISC: {
      const S = 2 * Math.PI * (half[0] * half[0] - half[2] * half[2]); // both faces
      return Math.sqrt(Math.max(S, 1e-8) / (4 * Math.PI));
    }
    case EMITTER_KIND.TORUS: {
      const S = 4 * Math.PI * Math.PI * half[0] * half[1];
      return Math.sqrt(S / (4 * Math.PI));
    }
    default:
      return radius;
  }
}

/** Conservative self-exclusion OBB half-extents (slot axes) per kind — what
 *  the sphere-arm shadow marchers dilate to skip the lamp's own body. */
export function shapeExclusionHalf(kind, half, radius, out) {
  switch (kind) {
    case EMITTER_KIND.BOX: out.set(half[0], half[1], half[2]); break;
    case EMITTER_KIND.CAPSULE: out.set(half[0], half[1] + half[0], half[0]); break;
    case EMITTER_KIND.CYLINDER: out.set(half[0], half[1], half[0]); break;
    case EMITTER_KIND.FRUSTUM: {
      const r = Math.max(half[0], half[2]);
      out.set(r, half[1], r);
      break;
    }
    case EMITTER_KIND.DISC: out.set(half[0], 0.02, half[0]); break;
    case EMITTER_KIND.TORUS: out.set(half[0] + half[1], half[1], half[0] + half[1]); break;
    default: out.set(radius, radius, radius); break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE FITTER — three.js geometry (+ world matrix) → emitter shape record.
// Runs EVERY FRAME per promoted slot (#refreshEmitterSlots), so it never
// allocates: callers pass an `out` record it fills. Returns false when the
// geometry has no analytic shape beyond its OBB (caller keeps the OBB path).
//
// Scale rules: radial shapes need their cross-section to stay CIRCULAR under
// the world scale (|sx−sz| within 3% for the cylinder family, in-plane for
// disc/torus) — an elliptical cross-section has no closed form, and a wrong
// circle is worse than the honest OBB. The AXIS scale is free (it stretches
// the segment). Capsule cap spheres tolerate axis stretch (they become
// ellipsoids the model ignores; the MC bound covers the honest range).

// Exact surface area / (circumradius²) for detail-0 polyhedra, and the
// equal-area sphere radius factor √(S/4π)/r each implies. Derived from the
// standard edge-length↔circumradius relations; the shape test re-derives
// them from real geometry triangles to guard typos.
const POLY_AREA_EQ_RADIUS = {
  TetrahedronGeometry: 0.60624,
  OctahedronGeometry: 0.74251,
  IcosahedronGeometry: 0.87288,
  DodecahedronGeometry: 0.91476,
};

const _colX = new THREE.Vector3();
const _colY = new THREE.Vector3();
const _colZ = new THREE.Vector3();

const nearEqual = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-6);

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Matrix4} matrixWorld
 * @param {{kind:number, center:THREE.Vector3, bx:THREE.Vector3, by:THREE.Vector3,
 *          bz:THREE.Vector3, half:THREE.Vector3, radius:number, reff:number,
 *          exHalf:THREE.Vector3}} out — filled on success
 * @returns {boolean} true when a shaped kind (0 or 2..6) was fitted; false =
 *   caller should use its OBB (kind 1) path. Full spheres return true with
 *   kind 0 (the pre-existing behavior, now including imported spheres that
 *   primitiveFit recognises and area-equivalent polyhedra).
 */
export function fitEmitterShape(geometry, matrixWorld, out) {
  if (!geometry) return false;
  const params = geometry.parameters;
  const type = geometry.type;
  const e = matrixWorld.elements;
  _colX.set(e[0], e[1], e[2]);
  _colY.set(e[4], e[5], e[6]);
  _colZ.set(e[8], e[9], e[10]);
  const sx = _colX.length(), sy = _colY.length(), sz = _colZ.length();
  if (!(sx > 1e-8 && sy > 1e-8 && sz > 1e-8)) return false;

  // Dev/harness hatch: legacy sphere/box-only shapes, for A/B and bisects.
  const legacy = globalThis.__giLegacyEmitterShapes === true;

  const centerLocal = (x, y, z) => out.center.set(x, y, z).applyMatrix4(matrixWorld);
  const axes = (axisCol, u1Col, u2Col) => {
    out.by.copy(axisCol).divideScalar(axisCol.length());
    out.bx.copy(u1Col).divideScalar(u1Col.length());
    // Re-orthogonalize bz so the exclusion OBB stays a real frame under the
    // slight non-orthogonality a TRS matrix can carry through float error.
    out.bz.crossVectors(out.bx, out.by).normalize();
    out.bx.crossVectors(out.by, out.bz).normalize();
  };
  const finish = (kind, hx, hy, hz) => {
    out.kind = kind;
    out.half.set(Math.max(hx, 0.002), Math.max(hy, 0.002), Math.max(hz, 0.002));
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    out.radius = (geometry.boundingSphere?.radius ?? 0.1) * Math.max(sx, sy, sz);
    out.reff = shapeMeanProjRadius(kind, [out.half.x, out.half.y, out.half.z], out.radius);
    shapeExclusionHalf(kind, [out.half.x, out.half.y, out.half.z], out.radius, out.exHalf);
    return true;
  };

  // --- Full spheres (pre-existing kind-0 path, kept bit-identical) ---------
  const fullSphere =
    type === "SphereGeometry" &&
    (params?.phiLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3 &&
    (params?.thetaLength ?? Math.PI) > Math.PI - 1e-3;
  if (fullSphere || globalThis.__giSphereEmitters) {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    out.kind = EMITTER_KIND.SPHERE;
    out.center.copy(geometry.boundingSphere.center).applyMatrix4(matrixWorld);
    out.radius = (geometry.boundingSphere?.radius ?? 0.1) * Math.max(sx, sy, sz);
    out.reff = out.radius;
    out.half.set(out.radius, out.radius, out.radius);
    out.bx.set(1, 0, 0); out.by.set(0, 1, 0); out.bz.set(0, 0, 1);
    out.exHalf.set(out.radius, out.radius, out.radius);
    return true;
  }
  if (legacy) return false;

  // --- Polyhedra → equal-area sphere --------------------------------------
  const polyEq = POLY_AREA_EQ_RADIUS[type];
  if (polyEq !== undefined && params && nearEqual(sx, sy, 0.03) && nearEqual(sy, sz, 0.03)) {
    const detail = params.detail ?? 0;
    const rEq = (params.radius ?? 0.5) * sx * (detail >= 1 ? 1 : polyEq);
    out.kind = EMITTER_KIND.SPHERE;
    centerLocal(0, 0, 0);
    out.radius = rEq;
    out.reff = rEq;
    out.half.set(rEq, rEq, rEq);
    out.bx.set(1, 0, 0); out.by.set(0, 1, 0); out.bz.set(0, 0, 1);
    out.exHalf.set(rEq, rEq, rEq);
    return true;
  }

  // --- Cylinder family: local Y axis, needs circular cross-section --------
  const radialOk = nearEqual(sx, sz, 0.03);
  if (type === "CapsuleGeometry" && params && radialOk) {
    const r = (params.radius ?? 0.5) * sx;
    const hl = ((params.length ?? params.height ?? 1) / 2) * sy;
    centerLocal(0, 0, 0);
    axes(_colY, _colX, _colZ);
    return finish(EMITTER_KIND.CAPSULE, r, hl, r);
  }
  if ((type === "CylinderGeometry" || type === "ConeGeometry") && params && radialOk) {
    const full = (params.thetaLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3;
    if (full) {
      const rTop = (type === "ConeGeometry" ? 0 : params.radiusTop ?? 1) * sx;
      const rBottom = (type === "ConeGeometry" ? params.radius ?? 1 : params.radiusBottom ?? 1) * sx;
      const hl = ((params.height ?? 1) / 2) * sy;
      centerLocal(0, 0, 0);
      axes(_colY, _colX, _colZ);
      if (Math.abs(rTop - rBottom) <= 0.02 * Math.max(rTop, rBottom, 1e-6)) {
        return finish(EMITTER_KIND.CYLINDER, rBottom, hl, rBottom);
      }
      // half.x = radius at the −by end. three puts radiusBottom at −Y.
      return finish(EMITTER_KIND.FRUSTUM, rBottom, hl, rTop);
    }
  }
  if (type === "LatheGeometry" && Array.isArray(params?.points) && params.points.length >= 2 && radialOk) {
    // A lathe is a solid of revolution about local Y — a cylinder proxy of
    // its maximum profile radius beats the square-cross-section OBB.
    let rMax = 0, yMin = Infinity, yMax = -Infinity;
    for (const p of params.points) {
      rMax = Math.max(rMax, Math.abs(p.x));
      yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
    }
    if (rMax > 1e-6 && yMax > yMin) {
      centerLocal(0, (yMin + yMax) / 2, 0);
      axes(_colY, _colX, _colZ);
      return finish(EMITTER_KIND.CYLINDER, rMax * sx, ((yMax - yMin) / 2) * sy, rMax * sx);
    }
  }

  // --- Disc family: local Z normal, needs in-plane circularity ------------
  const planarOk = nearEqual(sx, sy, 0.03);
  if (type === "CircleGeometry" && params && planarOk) {
    const full = (params.thetaLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3;
    if (full) {
      centerLocal(0, 0, 0);
      axes(_colZ, _colX, _colY);
      return finish(EMITTER_KIND.DISC, (params.radius ?? 1) * sx, 0.002, 0);
    }
  }
  if (type === "RingGeometry" && params && planarOk) {
    const full = (params.thetaLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3;
    if (full) {
      centerLocal(0, 0, 0);
      axes(_colZ, _colX, _colY);
      return finish(EMITTER_KIND.DISC, (params.outerRadius ?? 1) * sx, 0.002, (params.innerRadius ?? 0.5) * sx);
    }
  }

  // --- Torus family: local Z axis (ring in XY) ----------------------------
  if ((type === "TorusGeometry" || type === "TorusKnotGeometry") && params && planarOk && nearEqual(sz, sx, 0.03)) {
    const arc = params.arc ?? Math.PI * 2;
    if (type === "TorusKnotGeometry" || arc > Math.PI * 2 - 1e-3) {
      // TorusKnot: shape-true proxy (the pool and reflection read as the
      // ring); its longer wound curve carries more surface than the plain
      // ring, so energy under-reports — documented, accepted.
      centerLocal(0, 0, 0);
      axes(_colZ, _colX, _colY);
      const rt = (params.tube ?? 0.4) * sx;
      return finish(EMITTER_KIND.TORUS, (params.radius ?? 1) * sx, rt, rt);
    }
  }

  // --- Imported meshes: recognise spheres via primitiveFit (cached) -------
  if (!params) {
    let fit = geometry.userData.__giEmitterFit;
    if (fit === undefined) {
      fit = fitPrimitive(geometry);
      geometry.userData.__giEmitterFit = fit ?? null;
    }
    if (fit?.type === "sphere" && nearEqual(sx, sy, 0.03) && nearEqual(sy, sz, 0.03)) {
      out.kind = EMITTER_KIND.SPHERE;
      out.center.set(fit.center[0], fit.center[1], fit.center[2]).applyMatrix4(matrixWorld);
      out.radius = fit.half[0] * sx;
      out.reff = out.radius;
      out.half.set(out.radius, out.radius, out.radius);
      out.bx.set(1, 0, 0); out.by.set(0, 1, 0); out.bz.set(0, 0, 1);
      out.exHalf.set(out.radius, out.radius, out.radius);
      return true;
    }
  }
  return false;
}

// Referenced by the fitter's callers for the OBB fallback's exclusion field.
export { POLY_AREA_EQ_RADIUS };
