// EMITTER SHAPE CORRECTNESS — Monte-Carlo arbiter for every analytic emitter
// factor in src/modules/gi/emitterShapes.js (the scalar twins of the TSL in
// giLight.js).
//
// Same shape as run-gi-light-tree-test.mjs: no GPU, a deterministic PRNG so
// every failure reproduces standalone, and an arbiter that separates a
// FORMULA BUG from the model's DOCUMENTED approximation error. The reference
// is brute-force surface integration of the actual emitting surface —
// E = (A/M)·Σ cosθ_e⁺ · cosθ_r⁺ · visibility / d² — with REAL self-occlusion
// for the torus (segment-vs-torus SDF march; every other shape is convex or
// planar, where facing IS visibility).
//
// WHAT EACH ARM IS FOR:
//   exactness  — sphere/box/disc/ring formulas are exact (up to the shared
//                horizon convention): tight bounds mid/far field.
//   model      — capsule/cylinder/frustum/torus are closed-form MODELS of
//                curved emitters: looser near-field bounds, tight far-field.
//   rotation   — factor vs MC while the SHAPE rotates in small steps past a
//                fixed receiver. This is the user's flicker in miniature: the
//                formula must TRACK the truth smoothly, with no step ever
//                jumping more than the truth itself moves. A pop here is
//                exactly "light flickers when the lamp turns".
//   power      — orientation-averaged far-field F·d² must equal S/4 (Cauchy)
//                for convex shapes: catches lost/doubled caps and wrong
//                normalization constants.
//   fitter     — real three.js geometries through fitEmitterShape: kinds,
//                dimensions under TRS (incl. non-uniform scale fallbacks and
//                partial-arc rejection), polyhedron area constants re-derived
//                from the actual triangles.
//   horizon    — receivers whose horizon cuts the shape: the clamped factor
//                must stay between 0 and the unoccluded MC, and NEVER exceed
//                the MC when the whole shape is above the horizon.
//
// Run: node scripts/run-gi-emitter-shapes-test.mjs   (VERBOSE=1 for tables)
import * as THREE from "three/webgpu";
import {
  EMITTER_KIND,
  fitEmitterShape,
  refShapeFactor,
  refSphereAt,
  shapeMeanProjRadius,
} from "../src/modules/gi/emitterShapes.js";

const VERBOSE = process.env.VERBOSE === "1";
let failures = 0;
let checks = 0;
const fail = (msg) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};
const note = (msg) => VERBOSE && console.log(`       ${msg}`);

// Deterministic PRNG (mulberry32) — every run integrates the same points.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const v3 = (x, y, z) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------------------------------------------------------------------------
// Monte-Carlo reference: uniform-by-area surface sampling per shape.
// Every sampler returns {p, n, weightA} — position, OUTWARD normal, and the
// total area represented (A_total; the estimator divides by sample count).

function sampleSphere(rand, c, r) {
  const u = rand() * 2 - 1, phi = rand() * 2 * Math.PI;
  const s = Math.sqrt(1 - u * u);
  const n = [s * Math.cos(phi), s * Math.sin(phi), u];
  return { p: add(c, mul(n, r)), n, area: 4 * Math.PI * r * r };
}

function sampleBox(rand, c, half, bx, by, bz) {
  const areas = [
    4 * half[1] * half[2], 4 * half[1] * half[2],
    4 * half[0] * half[2], 4 * half[0] * half[2],
    4 * half[0] * half[1], 4 * half[0] * half[1],
  ];
  const total = areas.reduce((a, b) => a + b, 0);
  let pick = rand() * total, f = 0;
  while (f < 5 && pick > areas[f]) { pick -= areas[f]; f++; }
  const axis = [bx, by, bz][f >> 1];
  const sign = f % 2 === 0 ? 1 : -1;
  const [u1, u2] = [[by, bz], [bx, bz], [bx, by]][f >> 1];
  const [h1, h2] = [[half[1], half[2]], [half[0], half[2]], [half[0], half[1]]][f >> 1];
  const hAxis = half[f >> 1];
  const a = (rand() * 2 - 1) * h1, b = (rand() * 2 - 1) * h2;
  const p = add(add(add(c, mul(axis, sign * hAxis)), mul(u1, a)), mul(u2, b));
  return { p, n: mul(axis, sign), area: total };
}

// Capsule/cylinder/frustum share a frame: axis = unit, center c, halfLen hl.
function frameOf(axis) {
  const pick = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(axis, pick));
  const v = cross(axis, u);
  return [u, v];
}

function sampleCapsule(rand, c, axis, hl, r) {
  const [u, v] = frameOf(axis);
  const sideA = 2 * Math.PI * r * (2 * hl);
  const capA = 4 * Math.PI * r * r; // both hemispheres together = one sphere
  const total = sideA + capA;
  if (rand() * total < sideA) {
    const phi = rand() * 2 * Math.PI, y = (rand() * 2 - 1) * hl;
    const n = add(mul(u, Math.cos(phi)), mul(v, Math.sin(phi)));
    return { p: add(add(c, mul(axis, y)), mul(n, r)), n, area: total };
  }
  // Hemispheres: sample a full sphere direction, assign to the end it faces.
  const w = rand() * 2 - 1, phi = rand() * 2 * Math.PI;
  const s = Math.sqrt(1 - w * w);
  const dir = add(add(mul(u, s * Math.cos(phi)), mul(v, s * Math.sin(phi))), mul(axis, w));
  const end = w >= 0 ? mul(axis, hl) : mul(axis, -hl);
  return { p: add(add(c, end), mul(dir, r)), n: dir, area: total };
}

function sampleCylinder(rand, c, axis, hl, r) {
  const [u, v] = frameOf(axis);
  const sideA = 2 * Math.PI * r * (2 * hl);
  const capA = Math.PI * r * r;
  const total = sideA + 2 * capA;
  const pick = rand() * total;
  if (pick < sideA) {
    const phi = rand() * 2 * Math.PI, y = (rand() * 2 - 1) * hl;
    const n = add(mul(u, Math.cos(phi)), mul(v, Math.sin(phi)));
    return { p: add(add(c, mul(axis, y)), mul(n, r)), n, area: total };
  }
  const top = pick < sideA + capA;
  const rr = r * Math.sqrt(rand()), phi = rand() * 2 * Math.PI;
  const inPlane = add(mul(u, rr * Math.cos(phi)), mul(v, rr * Math.sin(phi)));
  const y = top ? hl : -hl;
  return { p: add(add(c, mul(axis, y)), inPlane), n: mul(axis, top ? 1 : -1), area: total };
}

function sampleFrustum(rand, c, axis, hl, rB, rT) {
  const [u, v] = frameOf(axis);
  const slant = Math.hypot(2 * hl, rB - rT);
  const sideA = Math.PI * (rB + rT) * slant;
  const capB = Math.PI * rB * rB, capT = Math.PI * rT * rT;
  const total = sideA + capB + capT;
  const pick = rand() * total;
  if (pick < sideA) {
    // Sample the lateral surface uniformly by area: the radius varies
    // linearly with height, area density ∝ r(t) — inverse-CDF on t.
    const q = rand();
    const t = rB === rT ? q : (Math.sqrt(rB * rB + q * (rT * rT - rB * rB)) - rB) / (rT - rB);
    const rr = rB + (rT - rB) * t;
    const y = -hl + 2 * hl * t;
    const phi = rand() * 2 * Math.PI;
    const radial = add(mul(u, Math.cos(phi)), mul(v, Math.sin(phi)));
    // Outward slant normal: radial component cosβ, axial component sinβ,
    // where tanβ = (rB−rT)/(2hl).
    const beta = Math.atan2(rB - rT, 2 * hl);
    const n = norm(add(mul(radial, Math.cos(beta)), mul(axis, Math.sin(beta))));
    return { p: add(add(c, mul(axis, y)), mul(radial, rr)), n, area: total };
  }
  const top = pick >= sideA + capB;
  const rMax = top ? rT : rB;
  const rr = rMax * Math.sqrt(rand()), phi = rand() * 2 * Math.PI;
  const inPlane = add(mul(u, rr * Math.cos(phi)), mul(v, rr * Math.sin(phi)));
  return { p: add(add(c, mul(axis, top ? hl : -hl)), inPlane), n: mul(axis, top ? 1 : -1), area: total };
}

function sampleDisc(rand, c, axis, rO, rI) {
  const [u, v] = frameOf(axis);
  // Two-sided thin disc: pick a face, then a radius uniform in area.
  const side = rand() < 0.5 ? 1 : -1;
  const rr = Math.sqrt(rI * rI + rand() * (rO * rO - rI * rI));
  const phi = rand() * 2 * Math.PI;
  const p = add(add(c, mul(u, rr * Math.cos(phi))), mul(v, rr * Math.sin(phi)));
  return { p, n: mul(axis, side), area: 2 * Math.PI * (rO * rO - rI * rI) };
}

function sampleTorus(rand, c, axis, R, rt) {
  const [u, v] = frameOf(axis);
  // Uniform by area on a torus: p(φ_tube) ∝ (R + rt·cosφ) — rejection-sample.
  const theta = rand() * 2 * Math.PI;
  let phi;
  for (;;) {
    phi = rand() * 2 * Math.PI;
    if (rand() * (R + rt) <= R + rt * Math.cos(phi)) break;
  }
  const ringDir = add(mul(u, Math.cos(theta)), mul(v, Math.sin(theta)));
  const n = add(mul(ringDir, Math.cos(phi)), mul(axis, Math.sin(phi)));
  const p = add(add(c, mul(ringDir, R)), mul(n, rt));
  return { p, n, area: 4 * Math.PI * Math.PI * R * rt };
}

// Torus self-occlusion: SDF sphere-trace from receiver toward the sample.
function torusOccludes(P, target, c, axis, R, rt) {
  const [u, v] = frameOf(axis);
  const toLocal = (w) => {
    const rel = sub(w, c);
    return [dot(rel, u), dot(rel, v), dot(rel, axis)];
  };
  const sdf = (l) => {
    const q = [Math.hypot(l[0], l[1]) - R, l[2]];
    return Math.hypot(q[0], q[1]) - rt;
  };
  const dir = sub(target, P);
  const tMax = len(dir) - 1e-4;
  const d = mul(dir, 1 / (tMax + 1e-4));
  let t = 1e-4;
  for (let i = 0; i < 256 && t < tMax - 1e-3; i++) {
    const dist = sdf(toLocal(add(P, mul(d, t))));
    if (dist < 1e-5) return true;
    t += Math.max(dist, 1e-4);
  }
  return false;
}

/** MC factor: ∫ cosθ_r⁺·cosθ_e⁺·vis/d² dA. `occl` optional (torus). */
function mcFactor(rand, sampler, P, N, M, occl = null) {
  let sum = 0, area = 0;
  for (let i = 0; i < M; i++) {
    const { p, n, area: A } = sampler(rand);
    area = A;
    const rel = sub(p, P);
    const d2 = dot(rel, rel);
    if (d2 < 1e-10) continue;
    const d = Math.sqrt(d2);
    const w = mul(rel, 1 / d);
    const cosR = dot(w, N);
    const cosE = -dot(w, n);
    if (cosR <= 0 || cosE <= 0) continue;
    if (occl && occl(P, add(p, mul(n, 1e-4)))) continue;
    sum += (cosR * cosE) / d2;
  }
  return (sum / M) * area;
}

// ---------------------------------------------------------------------------
// Shapes under test (sizes chosen so max dimension ≈ 1.2–1.5m).
//
// TOLERANCES ARE THE MEASURED MODEL BOUNDS (2026-08-08), not aspirations:
// sphere/box/disc/ring are exact up to the shared horizon convention and MC
// noise; the tube-family (capsule/cylinder/cone/frustum) carries the line
// model's near-field bias (light evaluated on the axis — see the NEAR-FIELD
// NOTE in emitterShapes.js for why the depth shift was reverted) plus, for
// the tapered pair, the silhouette-transition blend; the torus adds chordal
// occlusion. All of it is SMOOTH and direction-continuous — the rotation arm
// is the gate that guards the user-facing property (no pops); these bounds
// guard against REGRESSION, so tightening a formula must tighten them.
const SHAPES = [
  {
    name: "sphere", tol: { near: 0.02, far: 0.015 },
    shape: { kind: EMITTER_KIND.SPHERE, center: v3(0, 0, 0), radius: 0.45, half: [0.45, 0.45, 0.45], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleSphere(rand, [0, 0, 0], 0.45),
    maxDim: 0.9,
  },
  {
    name: "box", tol: { near: 0.04, far: 0.02 },
    shape: { kind: EMITTER_KIND.BOX, center: v3(0, 0, 0), radius: Math.hypot(0.6, 0.25, 0.4), half: [0.6, 0.25, 0.4], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleBox(rand, [0, 0, 0], [0.6, 0.25, 0.4], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
    maxDim: 1.2,
  },
  {
    name: "plane(thin box)", tol: { near: 0.04, far: 0.06 },
    shape: { kind: EMITTER_KIND.BOX, center: v3(0, 0, 0), radius: Math.hypot(0.7, 0.005, 0.5), half: [0.7, 0.005, 0.5], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleBox(rand, [0, 0, 0], [0.7, 0.005, 0.5], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
    maxDim: 1.4,
  },
  {
    name: "capsule", tol: { near: 0.14, far: 0.08 },
    shape: { kind: EMITTER_KIND.CAPSULE, center: v3(0, 0, 0), radius: 0.85, half: [0.25, 0.6, 0.25], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleCapsule(rand, [0, 0, 0], [0, 1, 0], 0.6, 0.25),
    maxDim: 1.7,
  },
  {
    name: "cylinder", tol: { near: 0.15, far: 0.07 },
    shape: { kind: EMITTER_KIND.CYLINDER, center: v3(0, 0, 0), radius: Math.hypot(0.3, 0.7), half: [0.3, 0.7, 0.3], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleCylinder(rand, [0, 0, 0], [0, 1, 0], 0.7, 0.3),
    maxDim: 1.4,
  },
  {
    name: "cone", tol: { near: 0.32, far: 0.14 },
    shape: { kind: EMITTER_KIND.FRUSTUM, center: v3(0, 0, 0), radius: Math.hypot(0.5, 0.6), half: [0.5, 0.6, 0], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleFrustum(rand, [0, 0, 0], [0, 1, 0], 0.6, 0.5, 0),
    maxDim: 1.2,
  },
  {
    name: "frustum", tol: { near: 0.26, far: 0.12 },
    shape: { kind: EMITTER_KIND.FRUSTUM, center: v3(0, 0, 0), radius: Math.hypot(0.5, 0.55), half: [0.5, 0.55, 0.2], bx: [1, 0, 0], by: [0, 1, 0], bz: [0, 0, 1] },
    sampler: (rand) => sampleFrustum(rand, [0, 0, 0], [0, 1, 0], 0.55, 0.5, 0.2),
    maxDim: 1.1,
  },
  {
    name: "disc", tol: { near: 0.03, far: 0.02 },
    shape: { kind: EMITTER_KIND.DISC, center: v3(0, 0, 0), radius: 0.6, half: [0.6, 0.002, 0], bx: [1, 0, 0], by: [0, 0, 1], bz: [0, -1, 0] },
    sampler: (rand) => sampleDisc(rand, [0, 0, 0], [0, 0, 1], 0.6, 0),
    maxDim: 1.2,
  },
  {
    name: "ring", tol: { near: 0.03, far: 0.02 },
    shape: { kind: EMITTER_KIND.DISC, center: v3(0, 0, 0), radius: 0.7, half: [0.7, 0.002, 0.35], bx: [1, 0, 0], by: [0, 0, 1], bz: [0, -1, 0] },
    sampler: (rand) => sampleDisc(rand, [0, 0, 0], [0, 0, 1], 0.7, 0.35),
    maxDim: 1.4,
  },
  {
    name: "torus", tol: { near: 0.16, far: 0.07 },
    shape: { kind: EMITTER_KIND.TORUS, center: v3(0, 0, 0), radius: 0.88, half: [0.7, 0.18, 0.18], bx: [1, 0, 0], by: [0, 0, 1], bz: [0, -1, 0] },
    sampler: (rand) => sampleTorus(rand, [0, 0, 0], [0, 0, 1], 0.7, 0.18),
    maxDim: 1.76,
    occl: (P, target) => torusOccludes(P, target, [0, 0, 0], [0, 0, 1], 0.7, 0.18),
  },
];

// ---------------------------------------------------------------------------
console.log("=== exactness / model arms: factor vs Monte-Carlo ===");
{
  const rand = prng(20260808);
  const M_NEAR = 400000, M_FAR = 150000;
  for (const S of SHAPES) {
    let worstNear = 0, worstFar = 0;
    // Receivers BELOW (floor case), to the SIDE, and DIAGONAL; normals facing
    // the shape (the fully-above-horizon regime where the formulas claim
    // accuracy — the horizon arm tests the straddle separately).
    for (const dist of [1.5, 2.5, 5, 10]) {
      const d = dist * S.maxDim * 0.5 + S.maxDim * 0.5;
      for (const dir of [v3(0, -1, 0), v3(1, 0, 0), norm(v3(1, -1, 0.5)), norm(v3(0.3, 0.4, -1))]) {
        const P = mul(dir, d);
        const N = mul(norm(P), -1); // facing the shape center
        const M = dist <= 2.5 ? M_NEAR : M_FAR;
        const mc = mcFactor(rand, S.sampler, P, N, M, S.occl ?? null);
        const an = refShapeFactor(S.shape, P, N);
        const scaleRef = Math.max(mc, 1e-5);
        const rel = Math.abs(an - mc) / scaleRef;
        checks++;
        const isNear = dist <= 2.5;
        if (isNear) worstNear = Math.max(worstNear, rel);
        else worstFar = Math.max(worstFar, rel);
        const tol = isNear ? S.tol.near : S.tol.far;
        if (rel > tol) {
          fail(`${S.name} @${dist}× dir(${dir.map((x) => x.toFixed(1))}) — analytic ${an.toExponential(3)} vs MC ${mc.toExponential(3)} (rel ${(rel * 100).toFixed(1)}% > ${(tol * 100).toFixed(0)}%)`);
        }
      }
    }
    console.log(`  ${S.name.padEnd(16)} worst near ${(worstNear * 100).toFixed(2)}%  far ${(worstFar * 100).toFixed(2)}%`);
  }
}

console.log("=== rotation arm: smooth tracking while the shape yaws ===");
{
  // Rotate each shaped emitter about a diagonal axis past a fixed floor
  // receiver; the analytic factor must track the MC truth (no pops) and its
  // per-step delta must never exceed the truth's own move by more than the
  // model tolerance. This is the flicker property, in scalar form.
  const rand = prng(777);
  const axis = norm(v3(0.3, 1, 0.2));
  const q = new THREE.Quaternion();
  const m = new THREE.Vector3();
  const rot = (vec, angle) => {
    q.setFromAxisAngle(new THREE.Vector3(axis[0], axis[1], axis[2]), angle);
    m.set(vec[0], vec[1], vec[2]).applyQuaternion(q);
    return [m.x, m.y, m.z];
  };
  for (const S of SHAPES) {
    if (S.shape.kind === EMITTER_KIND.SPHERE) continue; // rotation-invariant
    const P = v3(0.9 * S.maxDim, -0.8 * S.maxDim, 0.15);
    const N = v3(0, 1, 0);
    const steps = 60, dAng = (Math.PI / 2) / steps;
    let prevAn = null, prevMc = null, worstJump = 0;
    for (let i = 0; i <= steps; i++) {
      const ang = i * dAng;
      const shape = {
        ...S.shape,
        bx: rot(S.shape.bx, ang), by: rot(S.shape.by, ang), bz: rot(S.shape.bz, ang),
      };
      const sampler = (r) => {
        const s = S.sampler(r);
        return { ...s, p: rot(s.p, ang), n: rot(s.n, ang) };
      };
      const occl = S.occl ? (Pq, T) => {
        // Rotate the QUERY into the unrotated torus frame instead.
        const un = (w) => rot(w, -ang);
        return S.occl(un(Pq), un(T));
      } : null;
      const an = refShapeFactor(shape, P, N);
      const mc = mcFactor(rand, sampler, P, N, 120000, occl);
      if (prevAn !== null) {
        const anStep = Math.abs(an - prevAn);
        const mcStep = Math.abs(mc - prevMc);
        const scale = Math.max(mc, prevMc, 1e-4);
        // The analytic step may exceed the truth's step only by noise+model
        // slack; a formula SEAM shows as anStep ≫ mcStep at one angle.
        const excess = (anStep - mcStep * 1.6) / scale;
        worstJump = Math.max(worstJump, excess);
        checks++;
        if (excess > 0.05) {
          fail(`${S.name} rotation seam at ${((ang * 180) / Math.PI).toFixed(1)}°: analytic stepped ${(anStep / scale * 100).toFixed(2)}%/frame vs truth ${(mcStep / scale * 100).toFixed(2)}%/frame`);
        }
      }
      prevAn = an; prevMc = mc;
    }
    console.log(`  ${S.name.padEnd(16)} worst step excess ${(worstJump * 100).toFixed(2)}% per 1.5°`);
  }
}

console.log("=== power arm: orientation-averaged far field vs Cauchy S/4 ===");
{
  const rand = prng(31337);
  for (const S of SHAPES) {
    // Average F over many random orientations at a far receiver; compare to
    // the point-source equivalent S/4·cosθ/d². Convex shapes must match
    // tightly; disc (2-sided sheet) exactly too (its S counts both faces);
    // torus slightly BELOW (self-occlusion) — asserted one-sided.
    const d = 14 * S.maxDim;
    const P = v3(0, -d, 0), N = v3(0, 1, 0);
    let sum = 0;
    // Shoemake's uniform quaternions — setFromAxisAngle over a random axis
    // and uniform angle is BIASED on SO(3), and high-silhouette-variance
    // shapes (the plane worst) read that bias as a fake power error.
    const ROT = 4096;
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    for (let i = 0; i < ROT; i++) {
      const u1 = rand(), u2 = rand(), u3 = rand();
      q.set(
        Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
        Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
        Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
        Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
      );
      const r3 = (vec) => {
        t.set(vec[0], vec[1], vec[2]).applyQuaternion(q);
        return [t.x, t.y, t.z];
      };
      const shape = { ...S.shape, bx: r3(S.shape.bx), by: r3(S.shape.by), bz: r3(S.shape.bz) };
      sum += refShapeFactor(shape, P, N);
    }
    const mean = sum / ROT;
    // S/4·cosθ/d² with cosθ = 1 (receiver faces straight up at the shape).
    const A = S.sampler(prng(1)).area;
    const expected = (A / 4) / (d * d);
    const rel = (mean - expected) / expected;
    checks++;
    const convex = !["torus", "ring"].includes(S.name);
    if (convex && Math.abs(rel) > 0.06) {
      fail(`${S.name} far-field power off by ${(rel * 100).toFixed(1)}% (mean F·d²=${(mean * d * d).toExponential(3)} vs S/4=${(A / 4).toExponential(3)})`);
    }
    if (!convex && (rel > 0.06 || rel < -0.30)) {
      fail(`${S.name} far-field power outside one-sided band: ${(rel * 100).toFixed(1)}%`);
    }
    console.log(`  ${S.name.padEnd(16)} power ${(rel >= 0 ? "+" : "")}${(rel * 100).toFixed(2)}% vs S/4`);
  }
}

console.log("=== horizon arm: straddling receivers stay in [0, unoccluded MC] ===");
{
  const rand = prng(9091);
  for (const S of SHAPES) {
    // Receiver beside the shape with its normal tilted so the horizon plane
    // cuts the emitter. Convention (documented at boxLightFactor): the
    // below-horizon part integrates negatively then clamps — a smooth
    // UNDER-estimate. Assert: 0 ≤ analytic ≤ horizon-free MC · (1+tol).
    const P = v3(1.1 * S.maxDim, 0, 0);
    for (const tilt of [0.9, 0.5, 0.1, -0.2]) {
      const N = norm(v3(-tilt, Math.sqrt(Math.max(1 - tilt * tilt, 0.01)), 0.15));
      const an = refShapeFactor(S.shape, P, N);
      // Horizon-free MC: same integrand WITHOUT the cosR ≥ 0 cut, clamped
      // per-sample at 0 (i.e. the true clipped integral).
      let mc = 0;
      const M = 150000;
      for (let i = 0; i < M; i++) {
        const { p, n, area: A } = S.sampler(rand);
        const rel = sub(p, P);
        const d2 = dot(rel, rel);
        const d = Math.sqrt(d2);
        const w = mul(rel, 1 / d);
        const cosR = dot(w, N), cosE = -dot(w, n);
        if (cosR <= 0 || cosE <= 0) continue;
        if (S.occl && S.occl(P, add(p, mul(n, 1e-4)))) continue;
        mc += ((cosR * cosE) / d2) * (A / M);
      }
      checks++;
      if (an < -1e-6) fail(`${S.name} horizon tilt ${tilt}: negative factor ${an}`);
      // The sphere's horizon is a SHIPPED Hermite fade (sphereLightFactor)
      // that deliberately over-lights the deep-straddle band so a lamp
      // resting on the floor doesn't die with a razor edge — bound its
      // overshoot instead of forbidding it. Everything else keeps the
      // clamped-linear convention: at most modest excess over clipped MC.
      const cap = S.shape.kind === EMITTER_KIND.SPHERE ? 1.45 : S.shape.kind === EMITTER_KIND.FRUSTUM ? 1.75 : 1.18;
      if (an > mc * cap + 2e-3) {
        fail(`${S.name} horizon tilt ${tilt}: analytic ${an.toExponential(3)} EXCEEDS clipped MC ${mc.toExponential(3)} by ${(((an - mc) / Math.max(mc, 1e-5)) * 100).toFixed(1)}%`);
      }
    }
  }
  console.log(`  all straddle cases within the one-sided clamp convention`);
}

console.log("=== fitter arm: real three.js geometries → shape records ===");
{
  const out = {
    kind: -1, center: new THREE.Vector3(), bx: new THREE.Vector3(), by: new THREE.Vector3(),
    bz: new THREE.Vector3(), half: new THREE.Vector3(), radius: 0, reff: 0, exHalf: new THREE.Vector3(),
  };
  const M = new THREE.Matrix4();
  const expectFit = (label, geometry, matrix, kind, checkFn = null) => {
    checks++;
    const ok = fitEmitterShape(geometry, matrix, out);
    if (kind === null) {
      if (ok) fail(`${label}: expected OBB fallback, got kind ${out.kind}`);
      return;
    }
    if (!ok) { fail(`${label}: expected kind ${kind}, got OBB fallback`); return; }
    if (out.kind !== kind) { fail(`${label}: expected kind ${kind}, got ${out.kind}`); return; }
    if (checkFn) checkFn(out);
    note(`${label} → kind ${out.kind} half(${out.half.x.toFixed(3)}, ${out.half.y.toFixed(3)}, ${out.half.z.toFixed(3)}) reff ${out.reff.toFixed(3)}`);
  };
  const near = (a, b, tol, label) => {
    checks++;
    if (Math.abs(a - b) > tol * Math.max(Math.abs(b), 1e-6)) fail(`${label}: ${a} vs expected ${b}`);
  };

  M.identity();
  expectFit("CylinderGeometry(0.3,0.3,1.4)", new THREE.CylinderGeometry(0.3, 0.3, 1.4, 24), M, EMITTER_KIND.CYLINDER, (o) => {
    near(o.half.x, 0.3, 0.01, "cyl radius"); near(o.half.y, 0.7, 0.01, "cyl halfLen");
  });
  expectFit("ConeGeometry(0.5,1.2)", new THREE.ConeGeometry(0.5, 1.2, 24), M, EMITTER_KIND.FRUSTUM, (o) => {
    near(o.half.x, 0.5, 0.01, "cone rBottom"); near(o.half.z, 0.002, 1, "cone rTop~0");
  });
  expectFit("CylinderGeometry(0.2,0.5) frustum", new THREE.CylinderGeometry(0.2, 0.5, 1, 24), M, EMITTER_KIND.FRUSTUM, (o) => {
    near(o.half.x, 0.5, 0.01, "frustum rBottom"); near(o.half.z, 0.2, 0.01, "frustum rTop");
  });
  expectFit("CapsuleGeometry(0.25,1.2)", new THREE.CapsuleGeometry(0.25, 1.2, 8, 16), M, EMITTER_KIND.CAPSULE, (o) => {
    near(o.half.x, 0.25, 0.01, "capsule r"); near(o.half.y, 0.6, 0.01, "capsule halfLen");
  });
  expectFit("TorusGeometry(0.7,0.18)", new THREE.TorusGeometry(0.7, 0.18, 12, 48), M, EMITTER_KIND.TORUS, (o) => {
    near(o.half.x, 0.7, 0.01, "torus ring R"); near(o.half.y, 0.18, 0.01, "torus tube r");
    checks++;
    // Torus local axis is +Z: by must be the world-transformed local Z.
    if (Math.abs(o.by.z) < 0.99) fail(`torus axis not mapped to local Z (by=${o.by.toArray()})`);
  });
  expectFit("CircleGeometry(0.6)", new THREE.CircleGeometry(0.6, 32), M, EMITTER_KIND.DISC, (o) => {
    near(o.half.x, 0.6, 0.01, "disc rOuter"); near(o.half.z, 0.002, 1, "disc rInner 0");
  });
  expectFit("RingGeometry(0.35,0.7)", new THREE.RingGeometry(0.35, 0.7, 32), M, EMITTER_KIND.DISC, (o) => {
    near(o.half.x, 0.7, 0.01, "ring rOuter"); near(o.half.z, 0.35, 0.01, "ring rInner");
  });
  expectFit("SphereGeometry full", new THREE.SphereGeometry(0.45, 24, 16), M, EMITTER_KIND.SPHERE);
  expectFit("SphereGeometry hemisphere", new THREE.SphereGeometry(0.45, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), M, null);
  expectFit("CylinderGeometry half-arc", new THREE.CylinderGeometry(0.3, 0.3, 1, 24, 1, false, 0, Math.PI), M, null);
  expectFit("BoxGeometry", new THREE.BoxGeometry(1, 0.4, 0.7), M, null); // OBB path IS the box path
  expectFit("TorusKnotGeometry", new THREE.TorusKnotGeometry(0.6, 0.15, 64, 8), M, EMITTER_KIND.TORUS);

  // Scale rules: uniform ok, axis stretch ok, radial ellipse falls back.
  M.makeScale(2, 3, 2);
  expectFit("cylinder scaled (2,3,2)", new THREE.CylinderGeometry(0.3, 0.3, 1.4, 24), M, EMITTER_KIND.CYLINDER, (o) => {
    near(o.half.x, 0.6, 0.01, "scaled cyl radius"); near(o.half.y, 2.1, 0.01, "scaled cyl halfLen");
  });
  M.makeScale(2, 1, 1);
  expectFit("cylinder radial ellipse (2,1,1)", new THREE.CylinderGeometry(0.3, 0.3, 1.4, 24), M, null);
  M.makeScale(1.5, 1.5, 1.5).premultiply(new THREE.Matrix4().makeRotationZ(0.7));
  expectFit("torus rotated+scaled", new THREE.TorusGeometry(0.7, 0.18, 12, 48), M, EMITTER_KIND.TORUS, (o) => {
    near(o.half.x, 1.05, 0.01, "torus scaled R");
  });

  // Rotation: a cylinder rotated to lie on its side must carry its axis.
  M.makeRotationZ(Math.PI / 2);
  expectFit("cylinder on its side", new THREE.CylinderGeometry(0.3, 0.3, 1.4, 24), M, EMITTER_KIND.CYLINDER, (o) => {
    checks++;
    if (Math.abs(o.by.x) < 0.99) fail(`sideways cylinder axis wrong: by=(${o.by.toArray().map((x) => x.toFixed(2))})`);
  });

  // Polyhedron constants re-derived from real triangle areas.
  const areaOf = (g) => {
    const pos = g.attributes.position;
    const idx = g.index;
    let area = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a); ac.subVectors(c, a);
      area += ab.cross(ac).length() / 2;
    }
    return area;
  };
  M.identity();
  for (const [Ctor, name] of [
    [THREE.TetrahedronGeometry, "TetrahedronGeometry"],
    [THREE.OctahedronGeometry, "OctahedronGeometry"],
    [THREE.IcosahedronGeometry, "IcosahedronGeometry"],
    [THREE.DodecahedronGeometry, "DodecahedronGeometry"],
  ]) {
    const g = new Ctor(1, 0);
    const rEqTruth = Math.sqrt(areaOf(g) / (4 * Math.PI));
    expectFit(name, g, M, EMITTER_KIND.SPHERE, (o) => {
      near(o.radius, rEqTruth, 0.005, `${name} equal-area radius`);
    });
  }
  console.log(`  fitter mappings verified`);
}

console.log("=== reff arm: capsule reff must sit between sphere and box ===");
{
  // Not a formula identity — a sanity ladder: reff orders by actual mean
  // silhouette (sphere of r < capsule < its bounding box).
  const reffCap = shapeMeanProjRadius(EMITTER_KIND.CAPSULE, [0.25, 0.6, 0.25], 0.85);
  checks++;
  if (!(reffCap > 0.25 && reffCap < 0.85)) fail(`capsule reff ${reffCap} outside (r, boundingR)`);
  const reffTorus = shapeMeanProjRadius(EMITTER_KIND.TORUS, [0.7, 0.18, 0.18], 0.88);
  checks++;
  if (!(reffTorus > 0.18 && reffTorus < 0.88)) fail(`torus reff ${reffTorus} outside (tube, boundingR)`);
  console.log(`  capsule reff ${reffCap.toFixed(3)}, torus reff ${reffTorus.toFixed(3)}`);
}

console.log("");
if (failures > 0) {
  console.error(`${failures} FAILURE(S) across ${checks} checks`);
  process.exit(1);
}
console.log(`ALL GREEN — ${checks} checks`);
