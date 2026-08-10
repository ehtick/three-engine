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
// · `secondary` is [J] and is a hook here. Without it this is a single bounce,
//   and R4's ceiling has nothing to bound because there is no loop yet.
// · `importance` defaults to the exact contribution. `lightTree.js` is unwired;
//   when it lands it supplies a bounds-based ranking, and §12.26.5 prices what
//   that can cost at **3.00× the standard error** — 9× the samples for equal
//   noise. The parameter exists so that gets measured rather than asserted away.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.4, §7 Phase 5, §12.26.

import { If, float, int, select, step, uint, vec3 } from "three/tsl";
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
          if (count) count.shadowRays(1);
          // k = v / (pdf · S), with pdf = w/total.
          out.addAssign(E.mul(v.mul(total).div(w.mul(samples))));
        });
      }
    });
  });
  return out;
}

/**
 * §4.4's hit shading, assembled. Returns `shadeHit(hit, dir, rayIndex) → vec3`,
 * the exact shape `createSrcDepositFrame` takes as its `shadeHit` option.
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
 * @param {{direction: Node, irradiance: Node}} [options.sun]  `direction` points
 *   TOWARD the light; `irradiance` is the irradiance on a surface facing it
 *   square-on.
 * @param {object[]} [options.emitters]  `giLight.js` emitter slots.
 * @param {(P, n, toLight, maxT) => Node} [options.visibility]  from
 *   `createSrcVisibility`. Its `maxT` is measured from the SURFACE point; the
 *   lift correction is that function's own (§12.26.3).
 * @param {(P, n) => Node} [options.secondary]  the secondary cache [J], `vec3`.
 *   NOT the primary cache: reading the primary here would close the loop on
 *   itself within one frame and re-derive the divergence R4 exists to prevent.
 * @param {Node} options.voxelSize  the DDA medium's quantization — every bias
 *   here tracks it (R2), and there is deliberately no default.
 * @param {object} [options.count]  per-statistic incrementers; see
 *   `srcDeposit.js`'s STAT words.
 */
export function createSrcHitShader({
  surfaceAt,
  sun = null,
  emitters = [],
  visibility = null,
  secondary = null,
  voxelSize = null,
  neeEmitters = true,
  neeSamples = 1,
  importance = null,
  floorFraction = IMPORTANCE_FLOOR_FRACTION,
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  count = null,
} = {}) {
  if (typeof surfaceAt !== "function") {
    throw new Error("createSrcHitShader: surfaceAt is required — it is where mover/static provenance lives");
  }
  if (voxelSize == null) {
    throw new Error(
      "createSrcHitShader: voxelSize is required — every bias here tracks the DDA " +
      "medium's quantization (R2), and inventing a default is how the wrong one ships",
    );
  }
  // The shadow ray must stop short of the emitter's own surface. Half a voxel,
  // for the same reason the trace's self-bias is a quarter of one: the
  // intersection was quantized by that voxel and nothing smaller is meaningful.
  const margin = float(voxelSize).mul(0.5);
  const useNee = neeEmitters && emitters.length > 0;

  return (hit, dir, rayIndex) => {
    const s = surfaceAt(hit, dir);
    const P = vec3(s.position ?? hit.exactPosition ?? hit.position).toVar();
    const n = faceForward(s.normal ?? hit.normal, dir);
    if (count) {
      count.shaded(1);
      if (s.valid != null) count.unattributed(select(float(s.valid).greaterThan(0.5), 0, 1));
    }

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
        if (count) count.shadowRays(1);
        E.addAssign(vec3(sun.irradiance).mul(cos).mul(v));
      });
    }

    if (useNee) {
      E.addAssign(neeIrradiance(emitters, P, n, rayIndex, {
        visibility, margin, samples: neeSamples, importance, floorFraction, count,
      }));
    }

    if (secondary) E.addAssign(vec3(secondary(P, n)));

    // ── ρ/π · E, with R4's ceiling — applied AT THE HIT, inside the loop, and
    //    never at an `intensity` prop where an artistic gain belongs ─────────
    const rho = clampLoopAlbedo(s.albedo, maxLoopAlbedo);
    if (count) count.albedoClamped(select(rho.clamped, 1, 0));
    const out = rho.albedo.mul(E).mul(1 / Math.PI).toVar();

    // ── emission, and R5's zeroing ──────────────────────────────────────────
    const Le = vec3(s.emissive).toVar();
    const emits = Le.x.max(Le.y).max(Le.z).greaterThan(0).toVar();
    if (useNee && s.emitter != null) {
      const isNeeLight = float(s.emitter).greaterThanEqual(0)
        .and(float(s.emitter).lessThan(emitters.length))
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
