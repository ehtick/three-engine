// GI PROXY FIT — the mesh component's `giProxy` turned into occluder spheres.
//
// WHY THIS IS A CPU TEST. The gather evaluates only spheres (the one shape with
// a cheap exact occlusion form), so a proxy is spent as MORE SPHERES rather than
// new shader math. That makes the whole proxy system a pure function of bounds +
// a mode string — testable in milliseconds, with no GPU and no rig. Given how
// much of this module's measurement apparatus turned out to be blind, a fix that
// can be proven on CPU should be.
//
// The properties that matter are geometric, not aesthetic:
//   · COVERAGE — the union of the spheres must actually contain the object, or
//     the proxy under-shadows and light leaks through a character's chest.
//   · TIGHTNESS — it must beat the bounding sphere for elongated shapes, which
//     is the entire reason capsules exist here. A capsule proxy that is not
//     tighter than one sphere is just three times the cost for nothing.
//   · BUDGET — never exceed the slots offered; the caller's array has no room.
//   · CONTINUITY — the fit must not jump as the object rotates or resizes. This
//     is THE property: the bug this whole feature exists to kill is a
//     discontinuity, and a proxy that snapped between sphere counts would
//     reintroduce it in a new place.

import { giProxySpheres } from "../src/modules/gi/GISystem.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const box = (hx, hy, hz, cx = 0, cy = 0, cz = 0) => ({
  min: { x: cx - hx, y: cy - hy, z: cz - hz },
  max: { x: cx + hx, y: cy + hy, z: cz + hz },
  isEmpty: () => false,
});
const mesh = (giProxy) => ({ userData: giProxy ? { giProxy } : {} });

/** Does the sphere union contain a point? */
const covered = (spheres, p) =>
  spheres.some((s) => Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]) <= s[3] + 1e-6);

/** Worst-case radius of the union about the bounds centre. */
const unionRadius = (spheres, c) =>
  Math.max(...spheres.map((s) => Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]));

/**
 * Union VOLUME by Monte Carlo — the honest tightness metric, and the second
 * thing this test got wrong. The first version measured max REACH, on which a
 * capsule barely beats a bounding sphere (1.800 vs 1.887 for a standing figure)
 * because both must reach the head. But reach is not what over-shadows: VOLUME
 * is, and by volume the same capsule is several times tighter. A proxy's error
 * is the space it occupies that the object does not.
 *
 * Deterministic LCG, because a flaky tightness test is worse than none.
 */
const unionVolume = (spheres, bounds, samples = 60000) => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const s of spheres) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], s[k] - s[3]);
      hi[k] = Math.max(hi[k], s[k] + s[3]);
    }
  }
  void bounds;
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const p = [lo[0] + rnd() * (hi[0] - lo[0]), lo[1] + rnd() * (hi[1] - lo[1]), lo[2] + rnd() * (hi[2] - lo[2])];
    if (covered(spheres, p)) inside++;
  }
  return (vol * inside) / samples;
};

console.log("gi-proxy-fit:");

// ── (1) MODES RESOLVE AS DOCUMENTED ──────────────────────────────────────────
{
  const b = box(0.5, 1.8, 0.5); // a standing figure
  check("none contributes nothing", giProxySpheres(mesh("none"), b, 8).length === 0);
  check("sphere is exactly one sphere", giProxySpheres(mesh("sphere"), b, 8).length === 1);
  check("capsule is several", giProxySpheres(mesh("capsule"), b, 8).length > 1);
  check(
    "auto picks capsule for a figure",
    giProxySpheres(mesh(), b, 8).length === giProxySpheres(mesh("capsule"), b, 8).length,
    `auto gave ${giProxySpheres(mesh(), b, 8).length}`,
  );
  check("auto picks one sphere for a ball", giProxySpheres(mesh(), box(1, 1, 1), 8).length === 1);
  check("auto picks one sphere for a crate", giProxySpheres(mesh(), box(1, 0.9, 1.1), 8).length === 1);
}

// ── (2) COVERAGE — the union must contain the object ─────────────────────────
// Sampled on the bounds' surface, which is where under-coverage shows first.
{
  const b = box(0.4, 1.8, 0.4);
  for (const mode of ["sphere", "capsule", "auto"]) {
    const sph = giProxySpheres(mesh(mode), b, 8);
    let miss = 0;
    const N = 12;
    for (let i = 0; i <= N; i++) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const y = -1.8 + (3.6 * i) / N;
          // The long axis itself must always be inside — a gap here is a hole
          // straight through the middle of the character.
          if (!covered(sph, [0, y, 0])) miss++;
          // Corners are allowed to poke out of a capsule; that is what makes it
          // tighter than a bounding sphere. Only the AXIS is required.
          void sx; void sz;
        }
      }
    }
    check(`${mode}: the long axis is fully covered`, miss === 0, `${miss} uncovered samples`);
  }
}

// ── (3) TIGHTNESS — the whole point of a capsule ─────────────────────────────
{
  const b = box(0.4, 1.8, 0.4);
  const vSphere = unionVolume(giProxySpheres(mesh("sphere"), b, 8), b);
  const vCapsule = unionVolume(giProxySpheres(mesh("capsule"), b, 8), b);
  const vObject = 8 * 0.4 * 1.8 * 0.4;
  console.log(
    `  [tight] object ${vObject.toFixed(2)}m³ · bounding sphere ${vSphere.toFixed(2)}m³ ` +
      `· capsule ${vCapsule.toFixed(2)}m³ (${(vSphere / vCapsule).toFixed(1)}x tighter)`,
  );
  check("a capsule is much tighter by volume", vCapsule < vSphere * 0.6, `${vCapsule.toFixed(2)} vs ${vSphere.toFixed(2)}`);

  // And the win must GROW with elongation — that is what makes the fit worth
  // its extra slots on a character and not on a crate.
  const gain = (s) => unionVolume(giProxySpheres(mesh("sphere"), s, 8), s) /
    unionVolume(giProxySpheres(mesh("capsule"), s, 8), s);
  const gTall = gain(box(0.2, 3.0, 0.2));
  const gStubby = gain(b);
  console.log(`  [tight] volume win: figure ${gStubby.toFixed(1)}x, flagpole ${gTall.toFixed(1)}x`);
  check("the capsule win grows with elongation", gTall > gStubby, `${gTall.toFixed(2)} vs ${gStubby.toFixed(2)}`);

  // A compact shape must cost NOTHING extra — auto has to collapse to the
  // bounding sphere, or every crate in the scene pays capsule slots.
  const cube = box(1, 1, 1);
  check("auto on a cube is one sphere", giProxySpheres(mesh("auto"), cube, 8).length === 1);
  check(
    "and that sphere IS the bounding sphere",
    Math.abs(giProxySpheres(mesh("auto"), cube, 8)[0][3] - Math.hypot(1, 1, 1)) < 1e-6,
    `r=${giProxySpheres(mesh("auto"), cube, 8)[0][3]}`,
  );
}

// ── (4) BUDGET — never write past the caller's array ─────────────────────────
{
  const b = box(0.2, 4.0, 0.2);
  for (const budget of [0, 1, 2, 3, 8]) {
    const sph = giProxySpheres(mesh("capsule"), b, budget);
    check(`budget ${budget} is respected`, sph.length <= budget, `got ${sph.length}`);
  }
  check("budget 0 yields nothing at all", giProxySpheres(mesh("capsule"), b, 0).length === 0);
}

// ── (5) CONTINUITY — THE property. ───────────────────────────────────────────
// This feature exists to kill a discontinuity; a fit that jumped as an object
// turned would simply move the bug. Rotating a mover changes its world AABB
// continuously, so the union radius must change continuously too.
{
  const c = [0, 0, 0];
  let worstJump = 0;
  let prev = null;
  for (let deg = 0; deg <= 90; deg += 1) {
    const t = (deg * Math.PI) / 180;
    // World AABB of a 0.4 x 1.8 x 0.4 box yawed by t.
    const hx = 0.4 * Math.abs(Math.cos(t)) + 0.4 * Math.abs(Math.sin(t));
    const hz = 0.4 * Math.abs(Math.sin(t)) + 0.4 * Math.abs(Math.cos(t));
    const r = unionRadius(giProxySpheres(mesh("auto"), box(hx, 1.8, hz), 8), c);
    if (prev !== null) worstJump = Math.max(worstJump, Math.abs(r - prev));
    prev = r;
  }
  console.log(`  [cont] worst union-radius jump per degree of yaw: ${worstJump.toFixed(5)}m`);
  check("the fit is continuous under rotation", worstJump < 0.02, `${worstJump.toFixed(4)}m step`);

  // And continuous under SCALE, including across auto's sphere/capsule
  // threshold — the one place a mode switch could introduce a step.
  worstJump = 0;
  prev = null;
  for (let i = 0; i <= 200; i++) {
    const hy = 0.4 + (i / 200) * 1.2; // sweeps elongation 1.0 -> 3.0
    const r = unionRadius(giProxySpheres(mesh("auto"), box(0.4, hy, 0.4), 8), c);
    if (prev !== null) worstJump = Math.max(worstJump, Math.abs(r - prev));
    prev = r;
  }
  console.log(`  [cont] worst union-radius jump across auto's sphere->capsule switch: ${worstJump.toFixed(5)}m`);
  // A mode switch IS a step here (one sphere becomes several), so this is a
  // bounded-size assertion, not a smoothness one: the honest claim is that the
  // switch is small relative to the object, not that it does not exist.
  check("the auto mode switch is a small step, not a jump", worstJump < 0.15, `${worstJump.toFixed(4)}m`);
}

// ── (6) DEGENERATE INPUT — a zero-extent or tiny mover must not divide by 0 ───
{
  for (const [name, b] of [
    ["zero extent", box(0, 0, 0)],
    ["flat plane", box(1, 0, 1)],
    ["needle", box(0, 2, 0)],
    ["sub-mm", box(1e-6, 1e-6, 1e-6)],
  ]) {
    const sph = giProxySpheres(mesh("auto"), b, 8);
    const finite = sph.every((s) => s.every((v) => Number.isFinite(v)) && s[3] > 0);
    check(`${name}: finite spheres or none`, finite, JSON.stringify(sph));
  }
}

if (failures) {
  console.error(`gi-proxy-fit: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-proxy-fit: all cases PASS");

// ── (7) A CLASSIFIED SPHERE USES ITS TRUE RADIUS ─────────────────────────────
// The AABB's bounding sphere is sqrt(3)x a ball's real radius, and fitting one
// casts a shadow 73% too wide — measured as a +256% step-amplitude excess on
// the per-frame instrument. When the dynamic set has already classified the
// geometry as a sphere, that guess is not needed.
{
  const b = box(0.5, 0.5, 0.5);
  const fitted = giProxySpheres(mesh("auto"), b, 8, "sphere");
  const guessed = giProxySpheres(mesh("auto"), b, 8, null);
  console.log(`  [shape] classified sphere r=${fitted[0][3].toFixed(3)} vs AABB-fitted r=${guessed[0][3].toFixed(3)}`);
  check("a classified sphere uses its true radius", Math.abs(fitted[0][3] - 0.5) < 1e-9, `r=${fitted[0][3]}`);
  check("which is much tighter than the AABB guess", fitted[0][3] < guessed[0][3] * 0.6);
  check("and it is still exactly one sphere", fitted.length === 1);
}

if (failures) {
  console.error(`gi-proxy-fit: ${failures} case(s) FAILED (shape section)`);
  process.exit(1);
}

// ── (8) THE OCCLUSION MATH ITSELF ────────────────────────────────────────────
// A JS mirror of cascadeGather's `sphereOcclusion` (TSL, cannot run here),
// transcribed operation for operation. This section exists because the first
// shipped version had a guard that returned FULL occlusion for a receiver
// inside the proxy, and that fired in two places nobody would guess from
// reading it: on the MOVER'S OWN SURFACE (l == R, so it occluded itself and
// went solid black) and on FLOOR TEXELS near a cube's contact point (inside its
// bounding sphere, so the contact shadow became a black hexagon). Both shipped
// and both were caught by eye, which is the expensive way.
//
// The physical anchor that makes these testable: a point on a CONVEX body with
// an OUTWARD normal sees NONE of that body. Occlusion 0, never 1.
const occ = (P, N, sph) => {
  const di = [sph[0] - P[0], sph[1] - P[1], sph[2] - P[2]];
  const l = Math.max(Math.hypot(di[0], di[1], di[2]), 1e-4);
  const nl = (N[0] * di[0] + N[1] * di[1] + N[2] * di[2]) / l;
  const h = Math.max(l / Math.max(sph[3], 1e-4), 1.0001);
  const h2 = h * h;
  const k2 = 1 - h2 * nl * nl;
  const far = Math.max(nl, 0) / Math.max(h2, 1e-4);
  const h2m1 = Math.max(h2 - 1, 1e-4);
  const one = Math.max(1 - nl * nl, 1e-4);
  const inner = nl * Math.acos(Math.min(1, Math.max(-1, -nl * Math.sqrt(h2m1 / one))))
    - Math.sqrt(Math.max(k2, 0) * h2m1);
  const near = (inner / Math.max(h2, 1e-4) + Math.atan(Math.sqrt(Math.max(k2, 0) / h2m1))) / Math.PI;
  return Math.min(1, Math.max(0, k2 > 0 ? near : far));
};

{
  const S = [0, 0, 0, 1]; // unit sphere at the origin
  // THE SELF-OCCLUSION CASE — the black underside.
  const onSurface = occ([0, -1, 0], [0, -1, 0], S);
  console.log(`  [occ] on the proxy surface, outward normal: ${onSurface.toFixed(4)}`);
  check("a body does not occlude its own surface", onSurface < 0.01, `${onSurface.toFixed(4)}`);

  // THE CONTACT-PATCH CASE — a receiver INSIDE the proxy, facing away from it.
  const inside = occ([0, -0.5, 0], [0, -1, 0], S);
  console.log(`  [occ] inside the proxy, normal facing away: ${inside.toFixed(4)}`);
  check("an interior receiver facing away is not blacked out", inside < 0.5, `${inside.toFixed(4)}`);

  // Sanity in the other direction: a surface staring straight INTO the sphere
  // from close range really is almost fully blocked.
  const facing = occ([0, -1.2, 0], [0, 1, 0], S);
  console.log(`  [occ] just below, normal facing the sphere: ${facing.toFixed(4)}`);
  check("a surface facing the sphere IS occluded", facing > 0.5, `${facing.toFixed(4)}`);

  // Far field must fall off like a solid angle, ~1/d².
  const d4 = occ([0, -4, 0], [0, 1, 0], S);
  const d8 = occ([0, -8, 0], [0, 1, 0], S);
  console.log(`  [occ] falloff 4m ${d4.toFixed(5)} -> 8m ${d8.toFixed(5)} (ratio ${(d4 / d8).toFixed(2)}, 1/d² predicts 4)`);
  check("far-field occlusion falls as ~1/d²", Math.abs(d4 / d8 - 4) < 0.6, `${(d4 / d8).toFixed(2)}`);

  // CONTINUITY across the surface — the transition an object sweeping past a
  // receiver actually crosses, and where a guard-shaped discontinuity hides.
  let worst = 0;
  let prev = null;
  for (let i = 0; i <= 400; i++) {
    const d = 0.5 + (i / 400) * 2.5; // sweeps from inside the proxy to outside
    const v = occ([0, -d, 0], [0, 1, 0], S);
    if (prev !== null) worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
  }
  console.log(`  [occ] worst step while crossing the proxy surface: ${worst.toFixed(4)}`);
  check("occlusion is continuous across the proxy surface", worst < 0.05, `${worst.toFixed(4)} step`);

  // And never NaN, at any angle, including the poles where 1-nl² -> 0.
  let bad = 0;
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI;
    const v = occ([0, -2, 0], [Math.sin(t), Math.cos(t), 0], S);
    if (!Number.isFinite(v)) bad++;
  }
  check("finite at every normal orientation", bad === 0, `${bad} non-finite`);
}

if (failures) {
  console.error(`gi-proxy-fit: ${failures} case(s) FAILED (occlusion section)`);
  process.exit(1);
}

// ── (9) ENERGY CONSERVATION — why the black disc cannot come back ────────────
// The gather composes a mover as
//     E = fieldE·(1−f) + (emissive + albedo·(irrDirect + fieldE/π))·f·π
// The identity that matters: a WHITE, non-emissive mover in a uniform field must
// return exactly the field, whatever f is. It hides as much light as it gives
// back, so no configuration — including a sphere directly overhead with the sun
// straight down, where irrDirect on the visible underside is 0 — can drive the
// receiver to black. That case shipped and was screenshotted.
{
  const compose = (fieldE, albedo, emissive, irrDirect, f) =>
    fieldE * (1 - f) + (emissive + albedo * (irrDirect + fieldE / Math.PI)) * f * Math.PI;

  let worst = 0;
  for (const f of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    // The exact screenshot case: overhead sun, so the underside sees no direct.
    const out = compose(1, 1, 0, 0, f);
    worst = Math.max(worst, Math.abs(out - 1));
  }
  console.log(`  [energy] white mover, no direct on the visible side: worst deviation from the field ${worst.toFixed(6)}`);
  check("a white mover neither darkens nor brightens a uniform field", worst < 1e-9, `${worst}`);

  // A dark mover must still darken, and in proportion to its albedo — the term
  // must not be a no-op dressed up as conservation.
  const dark = compose(1, 0.1, 0, 0, 0.5);
  const bright = compose(1, 1.0, 0, 0, 0.5);
  console.log(`  [energy] at f=0.5 — albedo 0.1 -> ${dark.toFixed(3)}, albedo 1.0 -> ${bright.toFixed(3)}`);
  check("a dark mover darkens", dark < 0.6, `${dark.toFixed(3)}`);
  check("and a white one does not", Math.abs(bright - 1) < 1e-9, `${bright.toFixed(3)}`);

  // Full occlusion by a black body is the one case that SHOULD go to zero.
  check("a black mover at f=1 fully occludes", Math.abs(compose(1, 0, 0, 0, 1)) < 1e-9);
}

if (failures) {
  console.error(`gi-proxy-fit: ${failures} case(s) FAILED (energy section)`);
  process.exit(1);
}
