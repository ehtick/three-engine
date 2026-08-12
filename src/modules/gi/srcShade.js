// SPLIT RADIANCE CASCADES — [E'] hit shading. The GPU twin of `srcRef.js`'s
// `makeHitShader`, line for line.
//
//     L_hit = emissive(H) + ρ(H)/π · [ Σ_lights direct(H) + E_secondary(H) ]
//
// Plan §4.4, and the executable spec is §12.26 — a CPU mirror whose 124 checks
// ran the whole of this before a line of it existed on the GPU. Every constant,
// every ordering and every early-out below is that mirror's, and where this file
// says a thing is measured, the measurement is §12.26's and not a guess.
//
// ══ THE THINGS THAT ARE ABSENT, AND WHY EACH ABSENCE IS STRUCTURAL ══════════
//
// **MOVERS ARE NOT A BRANCH.** §4.4 asks for "header mean albedo/emissive
// Lambert shading" for an exact dynamic hit, which is the same expression with
// the surface read from somewhere else — so provenance lives entirely in
// `surfaceAt` and this file never asks whether a hit moved. A mover-shaped `if`
// here is the shape of the bug where a moving crate lights the room differently
// from the identical static one beside it, and that bug is invisible until
// somebody picks the crate up.
//
// **THE SKY IS NOT HERE.** A ray that escapes composites the sky in
// `mergeCascades`, at the top cascade, exactly once. Adding it at the hit would
// double it for every ray that both misses and merges.
//
// **NO LOOP OVER LIGHTS WITH A BREAK.** The emitter pick is a running-sum
// select over an unrolled `MAX_EMITTERS`, the same divergence-free form
// `splitCascade` uses in the deposit. The one expensive thing — the shadow ray —
// is issued ONCE, after the pick, which is the entire point of NEE.
//
// ══ THE FACE-FORWARD FLIP IS HERE, AND THAT CONTRADICTS §12.17 ON PURPOSE ═══
//
// §12.17 concluded that the face-forward flip belongs at the engine boundary
// (`readPixel`) and never in a kernel, because a flip on one side of the
// CPU/GPU boundary made each side fill the half of the bin sphere the other
// never read. **The hit normal is not that normal.** It is produced by the trace
// inside this same kernel, one line earlier, and a record normal is sign-aligned
// to the occupancy gradient — it knows nothing about which side a particular ray
// approached from. Unflipped, every hit on the FAR face of a wall returns
// cos < 0 for every light and shades black: half the geometry in a closed room,
// dark. §12.26.4 gates it two ways — the flip only ever changes the SIGN, and a
// scene whose record normals are all reported the other way round shades
// bit-identically.
//
// ══ WHAT IS STILL STUBBED, NAMED SO IT CANNOT BE MISREAD AS FINISHED ════════
//
// · `surfaceAt` for STATIC hits does not exist yet. §12.9 deleted the coarse
//   surface-attribution grid (`cellAttr`/`slotAtlas`), and `SURFACE_MATERIAL_ID_WORD`
//   was long since repurposed as the complex-cell triangle range, so there is no
//   path on the GPU from a static hit to its material. Until `srcSurface.js`
//   lands, statics shade at `defaultAlbedo` with zero emission — a grey-box
//   bounce, correct in shape and wrong in colour, and `STAT_UNATTRIBUTED` counts
//   every hit it happened to. Movers already have theirs
//   (`moverSurfaceAt` → header words 34..39).
// · THE SECONDARY TERM IS NOT EVALUATED HERE AND MUST NOT BE. The formula above
//   is still the model — `E` gains the cache's irradiance and ρ/π multiplies
//   the sum — but the `E_secondary` half is computed by `srcSecondary.js` in a
//   PASS OF ITS OWN and added into the same bin. Inlining it cost 48 seconds of
//   pipeline compile (§12.39): `gatherAt` is 16 hash-find loops and 16 filtered
//   taps, and this shader used to be instantiated inside the deposit's ray loop,
//   which was the fattest kernel in the module.
//
// ══ THE FILE IS TWO HALVES NOW, AND THEY COMPILE IN DIFFERENT KERNELS ═══════
//
// §12.53. `createSrcHitShader` is still the whole expression and still the
// thing `test:gi-src-shade` gates against `srcRef.js` — but it is now a
// COMPOSITION of two factories that the engine builds separately:
//
//   · `createSrcHitAttribution` — surfaceAt, the face-forward flip, R4's albedo
//     ceiling. Cheap, and it needs the trace's hit record, so it stays in [E].
//   · `createSrcHitLighting` — the visibility marcher, the four rolled light
//     slots, the NEE emitter set and the analytic shapes. Expensive to COMPILE
//     (the marcher is ~1.2 s of shader compile per call site and this half has
//     two of them), and it needs nothing from the trace but P, n̂, ρ, Le and the
//     ray index — five values that fit in a hit-list entry. So it moves to [J].
//
// That is the whole of §12.49's named follow-on: the deposit was 179 kB and one
// pipeline of it measured 49-56 s of a cold boot, and §13.17 says two ~75 kB
// kernels compiling in parallel beat one monster by MORE than the byte ratio.
// The estimator is untouched — the same nodes are emitted, in two kernels
// instead of one, and the ρ [J] multiplies by is still the one clamped here.
// · `importance` defaults to the exact contribution. `lightTree.js` is unwired;
//   when it lands it supplies a bounds-based ranking, and §12.26.5 prices what
//   that can cost at **3.00× the standard error** — 9× the samples for equal
//   noise. The parameter exists so that gets measured rather than asserted away.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.4, §7 Phase 5, §12.26.

import { If, Loop, float, int, mix, select, step, uint, vec3 } from "three/tsl";
import { MAX_LOOP_ALBEDO } from "./srcConfig.js";
import { hashKey } from "./srcMathTsl.js";
import { emitterSlotFactor, emitterSurfaceT } from "./giLight.js";

/**
 * How far below the mean importance a contributing emitter may be ranked before
 * NEE floors its pick probability. Twin of `srcRef.js`'s constant of the same
 * name; see `neeIrradiance` for why it is a FRACTION and not an epsilon.
 */
export const IMPORTANCE_FLOOR_FRACTION = 1 / 1024;

/** Rec. 709 luminance — the scalar an importance heuristic ranks on. */
const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * Deterministic [0, 1) from a ray index. `srcMathTsl.js`'s `hashKey` IS
 * `srcRef.js`'s `hashUnitFloat` before the divide — same PCG finalizer, same
 * constants, and `Math.imul` wraps mod 2^32 exactly as a WGSL u32 multiply does
 * — so this needs no second hash and cannot drift from the mirror.
 *
 * ⚠ THE DIVIDE IS THE ONE PLACE THE TWO SIDES CAN DISAGREE. A u32 above 2^24
 * rounds on its way into an f32, so `u` differs from the mirror's f64 by up to
 * ~2e-7 relative. That flips the emitter picked only when `u` lands within 2e-7
 * of a CDF boundary; the gate therefore compares the PICK STATISTICS rather than
 * asserting bit-equality, and asserts bit-equality of the hash itself only below
 * 2^24 where the conversion is exact.
 */
function hashUnit(n) {
  return float(hashKey(n)).div(4294967296);
}

/**
 * The ray arrives at the surface travelling along `dir`, so the outward normal
 * is the one OPPOSING it. Sign flip only — never a renormalize, never a
 * substitution (§12.26.4).
 */
export function faceForward(normal, dir) {
  const n = vec3(normal).toVar();
  return select(n.dot(vec3(dir)).greaterThan(0), n.negate(), n).toVar();
}

/**
 * R4's albedo ceiling, and it SCALES rather than clamping per channel.
 *
 * The secondary cache makes the bounce a temporal fixed-point iteration:
 * frame k's hit shading reads frame k−1's irradiance. `bakeProbeIrradiance`
 * returns exactly π·L̄ for uniform radiance, so one turn of the loop maps
 * `L → ρ/π · (π·L) = ρ·L` and the iteration's gain is the spectral radius of ρ,
 * i.e. its LARGEST channel. §12.26.2 measured the tail increment ratio at
 * **0.9000 to four figures** against a `MAX_LOOP_ALBEDO` of 0.9, and the
 * uncapped canary at 1.0000 with no convergence at all — the strongest form R4
 * can take, because it says the clamp is not merely present but is the thing
 * setting the rate.
 *
 * Scaling and not `min(ρ, ceiling)` per channel because both forms satisfy the
 * bound and only one keeps the COLOUR, and colour bleed is the entire product.
 * Measured: a per-channel clip shifts a warm white's chromaticity by 1.75e-2;
 * scaling by `ceiling/peak` shifts it by 5.6e-17 and touches nothing at or below
 * the ceiling.
 */
export function clampLoopAlbedo(albedo, ceiling = MAX_LOOP_ALBEDO) {
  const a = vec3(albedo).max(vec3(0)).toVar();
  const peak = a.x.max(a.y).max(a.z).toVar();
  // `peak > ceiling` implies `peak > 0`, so the guard on the divide only exists
  // to keep the untaken side of the select finite.
  const k = select(peak.greaterThan(float(ceiling)), float(ceiling).div(peak.max(1e-6)), float(1));
  return { albedo: a.mul(k).toVar(), clamped: peak.greaterThan(float(ceiling)) };
}

/**
 * One analytic emitter slot, evaluated at a shading point: its UNSHADOWED
 * closed-form irradiance, the direction to it, and the distance at which a
 * shadow ray should stop.
 *
 * This is `srcRef.js`'s `emitter.irradianceAt(P, n̂)` and `emitter.sampleTarget(P)`
 * in one call, expressed through `giLight.js`'s existing shape family rather
 * than a second derivation. That reuse is R5's precondition, not a convenience:
 * the screen chain's analytic emitter direct evaluates `emitterSlotFactor` too,
 * so the two representations of one light are the SAME closed form and can
 * agree. §12.26.7 measured the handoff at **1.45% worst case** over three
 * receivers against a brute-force MC arbiter — approximate by construction,
 * because an analytic form factor times a single binary visibility cannot
 * resolve a partially-occluded emitter, and approximate in exactly the way the
 * screen chain already is.
 *
 * `maxT` stops at the emitter's own SURFACE (slab entry for boxes — a bounding
 * sphere stopped the ray well short of an elongated lamp's face and exempted
 * anything hugging it from occluding), less a margin that R2 derives from the
 * occupancy voxel.
 *
 * **`emitterCutoff` is deliberately NOT applied.** In the screen chain it exists
 * so that light too dim to TRACE is also too dim to SHOW — the old gate skipped
 * the march but kept the contribution, and dim emitter light then crossed walls
 * unshadowed and read clearly in dark adjacent rooms. This path always traces,
 * so the gate has nothing to protect, and the uncut closed form is exactly the
 * quantity §12.26.7 calibrated the 1.45% handoff against.
 */
function emitterTermsAt(slot, P, n, margin) {
  const toE = vec3(slot.center).sub(P).toVar();
  const dist = toE.length().max(1e-3).toVar();
  const dirTo = toE.div(dist).toVar();
  const cosTheta = dirTo.dot(n).toVar();
  const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
  // A slot with no radius is an empty seat, not a point light.
  const active = step(0.001, float(slot.radius));
  const E = vec3(slot.color).mul(emitterSlotFactor(slot, P, n, cosTheta, sinR)).mul(active).toVar();
  const maxT = emitterSurfaceT(slot, P, dirTo, dist).sub(margin).max(0).toVar();
  return { E, dirTo, maxT, luma: E.dot(vec3(...LUMA)).max(0).toVar() };
}

/**
 * One `giLight.js` LIGHT SLOT's irradiance at a hit, plus what a shadow ray
 * toward it needs. The engine's punctual lights — `analyticDirectAt`'s subject,
 * up to `MAX_GI_LIGHTS` of them, point and directional in one array.
 *
 * `vector` holds the world POSITION for a point light and the normalized
 * direction TOWARD the light for a directional one; `kind` selects between them
 * (the same convention `cascadeGather` and `analyticDirectAt` use, and reusing
 * it rather than re-deriving is what keeps SRC's hits agreeing with the screen
 * chain's pixels).
 *
 * ⚠ **THE COSINE IS CLAMPED HERE, NOT ABSOLUTE.** `analyticDirectAt` takes
 * `dot(dirTo, N).abs()` because it shades a FIELD CELL, which has no definite
 * side — a cell straddling a wall must light from either. A hit has a side: the
 * normal was face-forwarded against the ray one line earlier (§12.26.4), so
 * `abs()` here would light the back of every wall from a lamp in front of it and
 * do it smoothly enough to read as a leak rather than a sign error.
 *
 * The shadow ray is what SRC can do and the screen chain structurally cannot:
 * three's shadow map is view-frustum bound, and half of SRC's hits are behind
 * the camera or off screen entirely.
 */
function lightTermsAt(slot, P, n, margin, maxRay) {
  const isDir = float(slot.kind).toVar();
  const rel = vec3(slot.vector).sub(P).toVar();
  const dist = rel.length().max(1e-4).toVar();
  const dirTo = mix(rel.div(dist), vec3(slot.vector), isDir).toVar();
  // Inverse-square for a point light, none for a directional. `max(1)` is
  // `analyticDirectAt`'s own guard against a receiver inside the source.
  const atten = mix(float(1).div(dist.mul(dist).max(1)), float(1), isDir).toVar();
  if (slot.range) {
    // three's PointLight `distance` cutoff (0 = infinite). GI must die exactly
    // where the renderer's own direct light does, or the mismatch reads as light
    // being "cut" at a circle.
    const range = float(slot.range);
    const ratio = dist.div(range.max(1e-4)).clamp(0, 1);
    const r2 = ratio.mul(ratio);
    const win = r2.mul(r2).oneMinus().clamp(0, 1);
    atten.mulAssign(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
  }
  const cos = dirTo.dot(n).max(0).toVar();
  const active = float(slot.active ?? 1);
  return {
    E: vec3(slot.color).mul(atten).mul(cos).mul(active).toVar(),
    dirTo,
    cos,
    // A directional source has no distance, so its shadow ray runs the whole
    // medium. `kind` is a UNIFORM, so this cannot be a build-time choice between
    // a number and `null` — it has to be a node either way, and the volume
    // diagonal is the finite stand-in for infinity that WGSL can actually hold.
    maxT: mix(dist.sub(margin).max(0), float(maxRay), isDir).toVar(),
  };
}

/**
 * NEE over the emitter set: rank by importance, pick one, ONE shadow ray,
 * divide by the pick probability.
 *
 * ══ THE IMPORTANCE IS THE CONTRIBUTION, WHICH MAKES ONE SAMPLE EXACT ════════
 *
 * With `p_i ∝ luminance(E_i)`, `E_i/p_i` is the SUM for whichever i is drawn:
 * one sample is not an unbiased estimate of the total, it **is** the total, to
 * 2.28e-16, for every ray index. All remaining variance is visibility.
 *
 * ⚠ **AND IT IS EXACT IN LUMINANCE, NOT PER CHANNEL.** The pdf is one scalar and
 * the signal has three components, so a draw that is exact in the ranked
 * quantity redistributes the other two: a red emitter drawn in place of a blue
 * one of equal luminance returns the right amount of light in the wrong hue.
 * §12.26.5 measured the spread over 4,000 draws at **740% per channel against
 * 2.28e-16 in luminance**, with a grey-emitter control collapsing to 1.14e-16.
 * This will arrive on screen as coloured noise nobody predicted. It is a
 * property of every importance-sampled NEE, not a bug in the tree, and the fix
 * if it ever matters is to rank per channel or spend samples. **Compare
 * estimators in the quantity they estimate** — a per-channel standard error
 * reported 1.17× for a change actually worth 3.00×.
 *
 * ══ THE FLOOR IS A DIAGNOSIS, NOT A REPAIR ═════════════════════════════════
 *
 * R1 in its sampling costume: an emitter with a nonzero contribution and a zero
 * pick probability is energy that vanishes with nothing to attribute it to. The
 * mirror's first version floored the weight at a fixed `1e-12` — which trades a
 * lost light for a **firefly**, because the estimator divides by the pdf, and
 * "fireflies are impossible by construction here" is a property this module
 * relies on.
 *
 * So the floor is a FRACTION of the mean importance among CONTRIBUTORS —
 * scale-invariant, because a light tree's importance is in units of its own and
 * is not comparable to an irradiance — which bounds the worst single-sample
 * weight at `contributors / floorFraction` times the mean. It binds only when an
 * importance function is wrong, so the exact-pdf case is untouched and the
 * zero-variance property survives. Measured on a zero-ranked VISIBLE emitter
 * over 200,000 draws: energy survives (2.08% off, inside its own 3σ), worst
 * single-sample weight 3577× the mean against the 4096 analytic bound, standard
 * error **37×** the correct ranking's. The floor keeps the energy, bounds the
 * firefly, and hands back the variance; the COUNTER is what says a ranking is
 * broken.
 *
 * ══ THE DRAWS ARE STRATIFIED ═══════════════════════════════════════════════
 *
 * `u = (s + hash)/S`, one draw per stratum. 1 → 4 samples cuts the standard
 * error **2.61×** where independent draws would give 2.00×. Asserting only "the
 * mean is still right" would have passed on a loop that draws the same light S
 * times and divides by S.
 */
function neeIrradiance(slots, P, n, rayIndex, {
  visibility,
  margin,
  samples = 1,
  importance = null,
  floorFraction = IMPORTANCE_FLOOR_FRACTION,
  count = null,
}) {
  const N = slots.length;
  const terms = slots.map((slot) => emitterTermsAt(slot, P, n, margin));

  // ── weights, and who can contribute at all ──────────────────────────────
  const contributes = terms.map((t) => t.luma.greaterThan(0).toVar());
  const weights = terms.map((t, i) => {
    const w = importance ? float(importance(slots[i], P, n)).max(0) : t.luma;
    return select(contributes[i], w, float(0)).toVar();
  });
  const contributors = float(0).toVar();
  for (const c of contributes) contributors.addAssign(select(c, float(1), float(0)));

  const out = vec3(0).toVar();
  If(contributors.greaterThan(0), () => {
    // The floor, relative to the importance's OWN scale.
    const sum = float(0).toVar();
    for (const w of weights) sum.addAssign(w);
    const floorW = select(sum.greaterThan(0), float(floorFraction).mul(sum).div(contributors), float(1)).toVar();
    const total = float(0).toVar();
    for (let i = 0; i < N; i++) {
      const bind = contributes[i].and(weights[i].lessThan(floorW)).toVar();
      weights[i].assign(select(bind, floorW, weights[i]));
      if (count) count.importanceFloored(select(bind, 1, 0));
      total.addAssign(weights[i]);
    }

    If(total.greaterThan(0), () => {
      for (let s = 0; s < samples; s++) {
        // One stratified draw per sample, offset by the ray index so two rays at
        // the same point do not pick the same light. A pure function of
        // (rayIndex, s) — no state to carry, which is the same property that
        // makes the deposit gate's synthetic trace bit-exact across the boundary.
        const u = float(s)
          .add(hashUnit(uint(rayIndex).mul(uint(0x9e37)).add(uint(s))))
          .div(samples)
          .toVar();

        // The pick, as a running sum with no break. Starts at the LAST index
        // rather than 0: the mirror falls back to the last emitter when floating
        // point leaves the CDF a hair under 1, and starting at 0 would silently
        // hand that case to a different light.
        const picked = int(N - 1).toVar();
        const acc = float(0).toVar();
        // 0 or 1 and never anything between, so the `< 0.5` test is exact. A
        // `== 0` on a float would be too, here — it is spelled this way because
        // a later edit that made `found` a running count would break silently.
        const found = float(0).toVar();
        for (let i = 0; i < N; i++) {
          acc.addAssign(weights[i].div(total));
          const take = found.lessThan(0.5).and(u.lessThan(acc)).toVar();
          picked.assign(select(take, int(i), picked));
          found.assign(select(take, float(1), found));
        }

        // Gather the picked emitter's terms. Four predicated copies, so the one
        // expensive thing below — the shadow ray — is issued once and not once
        // per emitter.
        const E = vec3(0).toVar();
        const w = float(0).toVar();
        const dirTo = vec3(0, 1, 0).toVar();
        const maxT = float(0).toVar();
        for (let i = 0; i < N; i++) {
          If(picked.equal(int(i)), () => {
            E.assign(terms[i].E);
            w.assign(weights[i]);
            dirTo.assign(terms[i].dirTo);
            maxT.assign(terms[i].maxT);
          });
        }

        If(w.greaterThan(0), () => {
          const v = visibility ? float(visibility(P, n, dirTo, maxT)).toVar() : float(1).toVar();
          // ONLY WHEN A RAY WAS ACTUALLY CAST. With `visibility` null the
          // `__giSrcNoShadow` arm reported a quarter of a million shadow rays it
          // never fired — the counter measured OPPORTUNITIES. Same defect class
          // as an eye check that prints `NO SCREENSHOT`: an instrument that
          // reports work it did not do is worse than no instrument, because the
          // number is used to rule causes OUT.
          if (count && visibility) count.shadowRays(1);
          // k = v / (pdf · S), with pdf = w/total.
          out.addAssign(E.mul(v.mul(total).div(w.mul(samples))));
        });
      }
    });
  });
  return out;
}

/**
 * THE ATTRIBUTION HALF — everything that needs the TRACE's hit record, and
 * nothing that needs a light. Runs in [E].
 *
 * Returns `attribute(hit, dir) → { P, n, rho, emissive, emitter }`:
 *
 *   · `P`        the shading point (the EXACT, unlifted hit)
 *   · `n`        the face-forwarded normal (see the header — the flip is here,
 *                on purpose, and §12.26.4 gates it two ways)
 *   · `rho`      the albedo AFTER R4's in-loop ceiling. **This is the value the
 *                whole fixed point rests on**: [J] multiplies its gathered
 *                irradiance by exactly this, so the loop's gain is the bounded
 *                one and the contraction is proven rather than hoped for.
 *   · `emissive` the raw emission. R5's zeroing is NOT applied here — it is a
 *                function of the NEE set, which is the lighting half's business
 *                (`createSrcHitLighting` takes the flag and does it there).
 *   · `emitter`  the R5 flag, `null` when the surface record has none.
 *
 * The three counters it owns are the three that describe a SURFACE rather than
 * a light: `shaded`, `unattributed` and `albedoClamped`. They stay on the same
 * dispatch that already counted them, so `unattributedRate` keeps its
 * historical denominator — every ray the deposit attributes, hit or miss —
 * across the §12.53 split. (Misses attribute garbage and always did; the
 * radiance is discarded by `own == N`, and only the DENOMINATOR sees them.)
 *
 * @param {object} options
 * @param {(hit, dir) => {albedo, emissive, emitter, valid}} options.surfaceAt
 *   THE ONE PLACE PROVENANCE LIVES. `emitter` is the index into `emitters` when
 *   the surface hit IS one of the NEE lights and < 0 otherwise. **That flag is
 *   R5's entire mechanism.** An emitter that is both sampled by NEE and emissive
 *   on contact delivers its energy twice, and the failure is invisible to every
 *   check that does not compare the two paths against each other: the image is
 *   simply brighter around lights, which reads as an artistic choice. §12.26.7
 *   measured it at **2.60×** on mean floor irradiance — and found that a single
 *   gather point could NOT see it (one floor point read 1.00×, because the ~57
 *   rays landing on the emitter spread thinly across the floor's probes and that
 *   point's eight held none). An energy claim wants an energy statistic.
 * @param {object} [options.count]  per-statistic incrementers; see
 *   `srcDeposit.js`'s STAT words.
 */
export function createSrcHitAttribution({
  surfaceAt,
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  count = null,
} = {}) {
  if (typeof surfaceAt !== "function") {
    throw new Error("createSrcHitAttribution: surfaceAt is required — it is where mover/static provenance lives");
  }
  return (hit, dir) => {
    const s = surfaceAt(hit, dir);
    const P = vec3(s.position ?? hit.exactPosition ?? hit.position).toVar();
    const n = faceForward(s.normal ?? hit.normal, dir);
    if (count) {
      count.shaded(1);
      if (s.valid != null) count.unattributed(select(float(s.valid).greaterThan(0.5), 0, 1));
    }
    const rho = clampLoopAlbedo(s.albedo, maxLoopAlbedo);
    if (count) count.albedoClamped(select(rho.clamped, 1, 0));
    return {
      P,
      n,
      rho: rho.albedo,
      emissive: vec3(s.emissive).toVar(),
      emitter: s.emitter != null ? float(s.emitter).toVar() : null,
    };
  };
}

/**
 * THE LIGHTING HALF — the sun, the punctual slots, the NEE emitter set, the
 * visibility marcher and R5's emission handoff. Runs in [J] since §12.53.
 *
 * Returns `light(P, n, rho, emissive, emitter, rayIndex) → vec3`, i.e.
 *
 *     Le' + ρ/π · Σ_lights direct(P, n̂)
 *
 * — the DIRECT half of §4.4's expression. The `E_secondary` half is added by
 * `srcSecondary.js` around this call, as `ρ/π · E_atlas`, so that the two terms
 * saturate against `Lmax` TOGETHER (one clamp, the inline form; §12.49's split
 * clamp is retired by the move, because both terms are now computed in one
 * kernel and there is nothing left to split).
 *
 * ⚠ **THIS IS THE EXPENSIVE HALF TO COMPILE, NOT TO RUN.** `visibility` is a
 * two-nested-loop BVH8 descent and it is instantiated at TWO call sites here
 * (the rolled light loop and NEE's single ray) — §13.14.5 measured ~1.2 s of
 * shader compile per call site. That is why it lives in a 64 kB kernel of its
 * own instead of inside the deposit's ray loop.
 *
 * @param {{direction: Node, irradiance: Node}} [options.sun]  a single
 *   directional source — `direction` points TOWARD it, `irradiance` is what a
 *   surface facing it square-on receives. This is `srcRef.js`'s `sunIrradiance`
 *   shape, kept so the CPU mirror stays the reference for this term.
 * @param {object[]} [options.lights]  `giLight.js` LIGHT slots (point and
 *   directional, `MAX_GI_LIGHTS` of them) — the engine path, one shadow ray per
 *   active slot. Independent of `sun`; the gate uses `sun`, the engine uses this.
 * @param {Node|number} [options.maxRay]  whole-medium ray bound, for a
 *   directional slot's shadow ray. Required when `lights` is non-empty.
 * @param {object[]} [options.emitters]  `giLight.js` emitter slots.
 * @param {(P, n, toLight, maxT) => Node} [options.visibility]  from
 *   `createSrcVisibility`. Its `maxT` is measured from the SURFACE point; the
 *   lift correction is that function's own (§12.26.3).
 * @param {Node} options.voxelSize  the DDA medium's quantization — every bias
 *   here tracks it (R2), and there is deliberately no default.
 * @param {object} [options.count]  per-statistic incrementers; see
 *   `srcDeposit.js`'s STAT words.
 */
export function createSrcHitLighting({
  sun = null,
  lights = [],
  emitters = [],
  visibility = null,
  voxelSize = null,
  maxRay = null,
  neeEmitters = true,
  neeSamples = 1,
  importance = null,
  floorFraction = IMPORTANCE_FLOOR_FRACTION,
  count = null,
} = {}) {
  if (voxelSize == null) {
    throw new Error(
      "createSrcHitLighting: voxelSize is required — every bias here tracks the DDA " +
      "medium's quantization (R2), and inventing a default is how the wrong one ships",
    );
  }
  // The shadow ray must stop short of the emitter's own surface. Half a voxel,
  // for the same reason the trace's self-bias is a quarter of one: the
  // intersection was quantized by that voxel and nothing smaller is meaningful.
  if (lights.length && maxRay == null) {
    throw new Error(
      "createSrcHitLighting: maxRay is required when `lights` are supplied — a " +
      "directional slot's shadow ray runs the whole medium, and `kind` is a " +
      "uniform, so the bound cannot be chosen at build time",
    );
  }
  const margin = float(voxelSize).mul(0.5);
  const useNee = neeEmitters && emitters.length > 0;

  return (Pin, nIn, rhoIn, emissiveIn, emitterIn, rayIndex) => {
    const P = vec3(Pin).toVar();
    const n = vec3(nIn).toVar();

    // ── E: irradiance arriving at the hit ───────────────────────────────────
    const E = vec3(0).toVar();

    // The sun. The cosine is clamped at zero BEFORE the shadow ray, because a
    // back-facing surface needs no trace to know the answer — and that early-out
    // is most of what the sun term costs on the GPU.
    if (sun) {
      const l = vec3(sun.direction).toVar();
      const cos = n.dot(l).toVar();
      If(cos.greaterThan(0), () => {
        // No `maxT`: a directional source has no distance, and
        // `createSrcVisibility` reads the omission as "as far as the medium
        // goes" rather than as an unbounded literal WGSL cannot express.
        const v = visibility ? float(visibility(P, n, l, null)).toVar() : float(1).toVar();
        // Only when a ray was cast — see the NEE site's note.
        if (count && visibility) count.shadowRays(1);
        E.addAssign(vec3(sun.irradiance).mul(cos).mul(v));
      });
    }

    // The engine's punctual lights, ONE SHADOW RAY EACH. Unrolled because
    // `MAX_GI_LIGHTS` is 4 and compile-time; gated on the cosine for the same
    // reason the sun is, which is what keeps the cost proportional to the lights
    // a hit can actually see rather than to the lights the scene has.
    //
    // Four rays per hit is the honest parity-first cost and it is NOT where this
    // ends up: folding the light slots into the NEE set below collapses it to
    // one ray for lights AND emitters together, which is what `lightTree.js`
    // does and what §7's Phase 5 asks for. Measure before assuming it matters —
    // the cosine gate means most hits pay for one or none.
    // ⚠ THE LOOP BELOW IS A GPU LOOP, AND THAT IS THE WHOLE POINT (§13.14.5).
    //
    // It used to be `for (const slot of lights)` — a JS loop, so it unrolled at
    // graph-build time and each iteration inlined `visibility(...)`, i.e. a
    // whole 2-nested-loop BVH8 descent. `makeLightSlots()` always builds
    // MAX_GI_LIGHTS = 4 slots (correctly — that is R11: adding a light updates a
    // uniform and never recompiles), so this kernel emitted FOUR descents no
    // matter how many lights the scene had. Measured by stubbing call sites one
    // at a time — 4/3/2/1/0 inlinings gave 11814/11704/9739/8526/6938 ms — it is
    // ~1.2 s of shader COMPILE per call site, and this kernel is 66% of all the
    // compile work in a GI boot (26.1 s of 39.3 s across 75 kernels).
    //
    // Rolling it keeps every property that mattered: still one shadow ray per
    // light, still gated so an unlit or back-facing light costs no ray, still 4
    // uniform slots so a light edit never recompiles. The only thing that
    // changes is that the descent is written into the shader ONCE.
    //
    // The predicated gather is the shape `neeIrradiance` already uses below for
    // exactly this reason: funnel N cheap alternatives into ONE expensive call.
    // Here the funnel sits inside a loop so all N still get their own ray —
    // this is an EMISSION change, not an estimator change. Folding the lights
    // into the NEE set (which §7 Phase 5 does want) trades four deterministic
    // rays for one stochastic sample, and that is a variance change that needs
    // its own energy A/B and its own flicker arm. Not here.
    if (lights.length) {
      const terms = lights.map((slot) => lightTermsAt(slot, P, n, margin, maxRay));
      if (!visibility || terms.length === 1) {
        // Nothing to win: with no ray there is no expensive call to share, and
        // with one light there is already exactly one call site. Kept as the
        // straight-line form so those two cases stay byte-identical to before.
        for (const t of terms) {
          If(t.E.x.max(t.E.y).max(t.E.z).greaterThan(0), () => {
            const v = visibility ? float(visibility(P, n, t.dirTo, t.maxT)).toVar() : float(1).toVar();
            if (count && visibility) count.shadowRays(1);
            E.addAssign(t.E.mul(v));
          });
        }
      } else {
        Loop({ start: int(0), end: int(terms.length), type: "int", condition: "<" }, ({ i }) => {
          // `E` already carries cos and `active` (see `lightTermsAt`), so a
          // slot that is off, out of range, or behind the surface arrives here
          // as zero and the gate below skips its ray. That is why the old
          // `cos > 0 &&` half of the gate is gone rather than moved: it was
          // redundant with the `E > 0` half, and keeping both would suggest
          // they test different things.
          const Ei = vec3(0).toVar();
          const dirTo = vec3(0, 1, 0).toVar();
          const maxT = float(0).toVar();
          for (let k = 0; k < terms.length; k++) {
            const take = i.equal(int(k));
            Ei.assign(select(take, terms[k].E, Ei));
            dirTo.assign(select(take, terms[k].dirTo, dirTo));
            maxT.assign(select(take, terms[k].maxT, maxT));
          }
          If(Ei.x.max(Ei.y).max(Ei.z).greaterThan(0), () => {
            const v = float(visibility(P, n, dirTo, maxT)).toVar();
            if (count) count.shadowRays(1);
            E.addAssign(Ei.mul(v));
          });
        });
      }
    }

    if (useNee) {
      E.addAssign(neeIrradiance(emitters, P, n, rayIndex, {
        visibility, margin, samples: neeSamples, importance, floorFraction, count,
      }));
    }

    // ── ρ/π · E, with R4's ceiling — applied AT THE HIT (in [E], by
    //    `createSrcHitAttribution`) and never at an `intensity` prop where an
    //    artistic gain belongs. The ρ arriving here is ALREADY bounded. ──────
    const rho = vec3(rhoIn).toVar();
    const out = rho.mul(E).mul(1 / Math.PI).toVar();

    // ── emission, and R5's zeroing ──────────────────────────────────────────
    const Le = vec3(emissiveIn).toVar();
    const emits = Le.x.max(Le.y).max(Le.z).greaterThan(0).toVar();
    if (useNee && emitterIn != null) {
      const isNeeLight = float(emitterIn).greaterThanEqual(0)
        .and(float(emitterIn).lessThan(emitters.length))
        .toVar();
      If(emits, () => {
        if (count) {
          count.emissiveZeroed(select(isNeeLight, 1, 0));
          count.emissiveHits(select(isNeeLight, 0, 1));
        }
        out.addAssign(select(isNeeLight, vec3(0), Le));
      });
    } else {
      If(emits, () => {
        if (count) count.emissiveHits(1);
        out.addAssign(Le);
      });
    }
    return out;
  };
}

/**
 * §4.4's hit shading, ASSEMBLED — attribution then lighting, one call, one
 * `vec3`. Returns `shadeHit(hit, dir, rayIndex) → vec3`, the exact shape
 * `createSrcDepositFrame` takes as its `shadeHit` option.
 *
 * This is the ONE-KERNEL form. The engine has not used it since §12.53 (it
 * builds the two halves separately and puts them in [E] and [J]), and what
 * keeps it is that it is the form `test:gi-src-shade` gates against
 * `srcRef.js`'s `makeHitShader` and the form `scripts/gi-src-deposit.html`
 * traces with — one expression, comparable to the mirror line for line, with no
 * hit list or second dispatch in the way. A divergence between this and the
 * split pair is therefore a divergence between two compositions of the SAME two
 * factories, which is a class of bug the composition cannot have.
 */
export function createSrcHitShader({
  surfaceAt,
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  count = null,
  ...lighting
} = {}) {
  const attribute = createSrcHitAttribution({ surfaceAt, maxLoopAlbedo, count });
  const light = createSrcHitLighting({ ...lighting, count });
  return (hit, dir, rayIndex) => {
    const a = attribute(hit, dir);
    return light(a.P, a.n, a.rho, a.emissive, a.emitter, rayIndex);
  };
}
