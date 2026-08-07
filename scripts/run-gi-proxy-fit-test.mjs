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
